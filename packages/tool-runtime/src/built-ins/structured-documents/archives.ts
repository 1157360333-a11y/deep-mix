import { createHash } from "node:crypto";
import { promises as fs } from "node:fs";
import path from "node:path";

import type { Entry as YauzlEntry, ZipFile as YauzlZipFile } from "yauzl";

import type {
  ArchiveEntryResult,
  ArchiveListResult,
  StructuredDocumentWarning,
  StructuredSourceReference,
  ToolAvailability,
  ToolOutputArtifact,
  ToolResult,
  ToolStructuredError,
} from "../../../../shared-schema/src/index.js";
import { ToolArgumentError } from "../../index.js";
import { isProtectedReadPath } from "../../repository-explorer.js";
import type {
  RuntimeToolExecutionContext,
  RuntimeToolSpec,
  ToolModule,
  ToolModuleContext,
} from "../../tool-module.js";

import { parseNonNegativeCursor, pathPropertySchema, structuredWarning } from "./contracts.js";
import { PHASE20_LIMITS } from "./format-policy.js";

const ZIP_MIME_TYPE = "application/zip";
const ZIP_MAGIC_PREFIXES = ["504b0304", "504b0506", "504b0708"];
const WINDOWS_RESERVED = /^(?:CON|PRN|AUX|NUL|COM[1-9]|LPT[1-9])(?:\.|$)/iu;
const DEFAULT_LIST_ENTRIES = 200;

export type ArchiveManageArgs = ArchiveListArgs | ArchiveCreateArgs | ArchiveExtractArgs;

export interface ArchiveListArgs {
  action: "list";
  archivePath: string;
  cursor?: string;
  maxEntries?: number;
}

export interface ArchiveCreateArgs {
  action: "create";
  outputPath: string;
  paths: string[];
  overwrite?: boolean;
}

export interface ArchiveExtractArgs {
  action: "extract";
  archivePath: string;
  outputDirectory: string;
}

type ArchiveFailureCode =
  | "unsupported_format"
  | "format_mismatch"
  | "archive_too_large"
  | "archive_invalid_or_damaged"
  | "archive_entry_limit_exceeded"
  | "archive_entry_too_large"
  | "archive_expanded_size_exceeded"
  | "archive_ratio_exceeded"
  | "archive_unsafe_path"
  | "archive_path_collision"
  | "archive_encrypted"
  | "archive_unsupported_method"
  | "archive_symlink_or_special"
  | "archive_dependency_unavailable"
  | "archive_output_too_large"
  | "archive_write_failed";

interface ArchiveFailure {
  code: ArchiveFailureCode;
  message: string;
  dependency?: string;
}

interface AnalyzedEntry {
  raw: YauzlEntry;
  normalizedPath: string;
  directory: boolean;
  unsafeReasons: string[];
  result: ArchiveEntryResult;
}

interface ArchiveAnalysis {
  zip: YauzlZipFile;
  entries: AnalyzedEntry[];
  warnings: StructuredDocumentWarning[];
  totalCompressedBytes: number;
  totalUncompressedBytes: number;
}

type YauzlApi = typeof import("yauzl") & {
  getFileNameLowLevel: (
    generalPurposeBitFlag: number,
    fileNameBuffer: Buffer,
    extraFields: YauzlEntry["extraFields"],
    strictFileNames: boolean,
  ) => string;
};
type JsZipApi = typeof import("jszip");

function moduleDefault<T>(module: unknown): T {
  return ((module as { default?: T }).default ?? module) as T;
}

async function loadYauzl(): Promise<YauzlApi> {
  const yauzl = moduleDefault<YauzlApi>(await import("yauzl"));
  if (typeof yauzl.fromBuffer !== "function" || typeof yauzl.getFileNameLowLevel !== "function") {
    throw new Error("yauzl 3.4 raw-filename APIs are unavailable");
  }
  return yauzl;
}

async function loadJsZip(): Promise<JsZipApi> {
  const JSZip = moduleDefault<JsZipApi>(await import("jszip"));
  if (typeof JSZip !== "function") throw new Error("JSZip constructor API is unavailable");
  return JSZip;
}

const CAPABILITIES = {
  supportedFormats: ["zip"],
  unsupportedFormats: {
    tar: "TAR list/create/extract is not allowlisted in Phase 20.",
    gzip: "GZIP is not exposed as an archive container in Phase 20.",
  },
  externalProgramsInvoked: false,
} as const;

export async function archiveAvailability(_context: ToolModuleContext): Promise<ToolAvailability> {
  const missing: string[] = [];
  await Promise.all([
    loadYauzl().catch(() => { missing.push("yauzl"); }),
    loadJsZip().catch(() => { missing.push("jszip"); }),
  ]);
  if (missing.length === 0) {
    return {
      status: "available",
      available: true,
      warnings: ["ZIP only; TAR and GZIP are explicitly unsupported and no external archive program is invoked."],
    };
  }
  return {
    status: missing.length === 2 ? "unavailable" : "degraded",
    available: missing.length !== 2,
    missingCapabilities: missing.sort().map((name) => name === "yauzl" ? "zip_list_extract" : "zip_create"),
    reason: `Archive capability is degraded because ${missing.sort().join(" and ")} could not load; no external-program fallback is permitted.`,
    warnings: ["TAR and GZIP remain explicitly unsupported."],
  };
}

function normalizeRelativePath(value: string): string {
  return value.replace(/\\/gu, "/");
}

function zipMagic(buffer: Buffer): boolean {
  return buffer.length >= 4 && ZIP_MAGIC_PREFIXES.includes(buffer.subarray(0, 4).toString("hex"));
}

function updateCrc32(state: number, buffer: Buffer): number {
  let crc = state;
  for (const byte of buffer) {
    crc ^= byte;
    for (let bit = 0; bit < 8; bit += 1) {
      crc = (crc >>> 1) ^ ((crc & 1) === 1 ? 0xedb8_8320 : 0);
    }
  }
  return crc >>> 0;
}

function pathUnsafeReasons(name: string, directory: boolean): { normalizedPath: string; reasons: string[] } {
  const reasons: string[] = [];
  if (name.length === 0) reasons.push("empty path");
  if (name.length > PHASE20_LIMITS.archive.maxEntryNameChars) reasons.push("entry name exceeds the declared character limit");
  if (name.includes("\0")) reasons.push("NUL byte");
  if (name.includes("\ufffd")) reasons.push("invalid or lossy filename encoding");
  if (/[\u0000-\u001f\u007f]/u.test(name)) reasons.push("C0 or DEL control character");
  if (/[<>"|?*]/u.test(name)) reasons.push("Windows-invalid path character");
  if (name.includes("\\")) reasons.push("backslash separator");
  if (/^(?:\/|\\|[A-Za-z]:|\/\/)/u.test(name)) reasons.push("absolute, drive, or UNC path");
  if (name.includes(":")) reasons.push("colon or NTFS alternate-data-stream path");
  const withoutDirectorySlash = directory && name.endsWith("/") ? name.slice(0, -1) : name;
  const normalizedPath = withoutDirectorySlash.normalize("NFC");
  const segments = normalizedPath.split("/");
  if (segments.some((segment) => segment.length === 0)) reasons.push("empty path segment");
  for (const segment of segments) {
    if (segment === "." || segment === "..") reasons.push("dot or dot-dot segment");
    if (/[. ]$/u.test(segment)) reasons.push("segment with trailing dot or space");
    if (WINDOWS_RESERVED.test(segment)) reasons.push("Windows reserved device name");
  }
  return { normalizedPath, reasons: [...new Set(reasons)] };
}

function decodeEntryName(entry: YauzlEntry, yauzl: YauzlApi): string {
  const rawName = (entry as unknown as { fileName: unknown }).fileName;
  if (!Buffer.isBuffer(rawName)) throw new ArchiveOperationError({ code: "archive_invalid_or_damaged", message: "yauzl did not return a raw ZIP entry name buffer." });
  return yauzl.getFileNameLowLevel(
    entry.generalPurposeBitFlag,
    rawName,
    entry.extraFields,
    true,
  );
}
function entryKind(entry: YauzlEntry, fileName: string): { directory: boolean; kind: ArchiveEntryResult["kind"]; unsafeReason?: string } {
  const directory = fileName.endsWith("/") || (entry.externalFileAttributes & 0x10) !== 0;
  const host = entry.versionMadeBy >>> 8;
  const unixMode = host === 3 || host === 19 ? (entry.externalFileAttributes >>> 16) & 0xffff : 0;
  const unixType = unixMode & 0o170000;
  if (unixType === 0o120000) return { directory: false, kind: "symlink", unsafeReason: "symbolic link entry" };
  if (unixType !== 0 && unixType !== 0o100000 && unixType !== 0o040000) {
    return { directory, kind: "other", unsafeReason: "special Unix file entry" };
  }
  if (directory && unixType === 0o100000) return { directory, kind: "other", unsafeReason: "conflicting file/directory attributes" };
  return { directory, kind: directory ? "directory" : "file" };
}

function warningForReasons(pathName: string, reasons: string[]): StructuredDocumentWarning[] {
  const warnings: StructuredDocumentWarning[] = [];
  if (reasons.some((reason) => reason.includes("encrypted"))) {
    warnings.push(structuredWarning("archive_encrypted", { severity: "high", category: "security", scope: pathName }));
  }
  if (reasons.some((reason) => /size|ratio|count|budget/iu.test(reason))) {
    warnings.push(structuredWarning("archive_budget_exceeded", { severity: "high", category: "security", scope: pathName }));
  }
  if (reasons.length > 0) {
    warnings.push(structuredWarning("archive_unsafe_entry", {
      severity: "high",
      category: "security",
      scope: pathName,
      message: `Unsafe archive entry: ${reasons.join("; ").slice(0, 2_000)}`,
      details: { reasons },
    }));
  }
  return warnings;
}


class ArchiveOperationError extends Error {
  public constructor(public readonly failure: ArchiveFailure) {
    super(failure.message);
    this.name = "ArchiveOperationError";
  }
}

function pushWarningOnce(warnings: StructuredDocumentWarning[], warning: StructuredDocumentWarning): void {
  if (!warnings.some((entry) => entry.code === warning.code)) warnings.push(warning);
}

function openZip(buffer: Buffer, yauzl: YauzlApi): Promise<YauzlZipFile> {
  return new Promise((resolve, reject) => {
    yauzl.fromBuffer(buffer, {
      autoClose: false,
      lazyEntries: true,
      decodeStrings: false,
      validateEntrySizes: true,
      strictFileNames: true,
    }, (error, zip) => {
      if (error || !zip) {
        reject(new ArchiveOperationError({
          code: "archive_invalid_or_damaged",
          message: `ZIP central directory is damaged or invalid: ${error?.message ?? "archive did not open"}`,
        }));
        return;
      }
      resolve(zip);
    });
  });
}

async function analyzeArchive(buffer: Buffer): Promise<ArchiveAnalysis> {
  let yauzl: YauzlApi;
  try {
    yauzl = await loadYauzl();
  } catch (error) {
    throw new ArchiveOperationError({
      code: "archive_dependency_unavailable",
      message: `yauzl is unavailable: ${(error as Error).message}`,
      dependency: "yauzl",
    });
  }
  const zip = await openZip(buffer, yauzl);
  if (zip.entryCount > PHASE20_LIMITS.archive.maxEntries) {
    zip.close();
    throw new ArchiveOperationError({
      code: "archive_entry_limit_exceeded",
      message: `ZIP declares ${zip.entryCount} entries, exceeding the ${PHASE20_LIMITS.archive.maxEntries}-entry limit.`,
    });
  }
  const pending: Array<{ raw: YauzlEntry; normalizedPath: string; directory: boolean; kind: ArchiveEntryResult["kind"]; reasons: string[] }> = [];
  let totalCompressedBytes = 0;
  let totalUncompressedBytes = 0;
  await new Promise<void>((resolve, reject) => {
    let settled = false;
    const fail = (error: unknown): void => {
      if (settled) return;
      settled = true;
      zip.close();
      const message = (error as Error).message || String(error);
      const unsafePath = /^(?:invalid characters in fileName|absolute path|invalid relative path):/iu.test(message);
      reject(error instanceof ArchiveOperationError ? error : new ArchiveOperationError({
        code: unsafePath ? "archive_unsafe_path" : "archive_invalid_or_damaged",
        message: `ZIP central-directory validation failed: ${message}`,
      }));
    };
    zip.once("error", fail);
    zip.on("entry", (entry: YauzlEntry) => {
      try {
        if (!Number.isSafeInteger(entry.compressedSize) || !Number.isSafeInteger(entry.uncompressedSize)
          || entry.compressedSize < 0 || entry.uncompressedSize < 0) {
          throw new ArchiveOperationError({ code: "archive_invalid_or_damaged", message: "ZIP entry sizes are invalid or exceed safe integer precision." });
        }
        const decodedName = decodeEntryName(entry, yauzl);
        const kind = entryKind(entry, decodedName);
        const validatedPath = pathUnsafeReasons(decodedName, kind.directory);
        const reasons = [...validatedPath.reasons];
        if (entry.isEncrypted() || (entry.generalPurposeBitFlag & 1) !== 0 || entry.extraFields.some((field) => field.id === 0x9901)) reasons.push("encrypted or password-required entry");
        if (entry.compressionMethod !== 0 && entry.compressionMethod !== 8) reasons.push(`unsupported compression method ${entry.compressionMethod}`);
        if (kind.unsafeReason) reasons.push(kind.unsafeReason);
        if (entry.uncompressedSize > PHASE20_LIMITS.archive.maxSingleEntryBytes) reasons.push("single-entry size budget exceeded");
        const ratio = entry.uncompressedSize === 0 ? 0 : entry.compressedSize === 0 ? Number.POSITIVE_INFINITY : entry.uncompressedSize / entry.compressedSize;
        if (ratio > PHASE20_LIMITS.archive.maxCompressionRatio) reasons.push("compression ratio budget exceeded");
        totalCompressedBytes += entry.compressedSize;
        totalUncompressedBytes += entry.uncompressedSize;
        if (!Number.isSafeInteger(totalCompressedBytes) || !Number.isSafeInteger(totalUncompressedBytes)) {
          throw new ArchiveOperationError({ code: "archive_invalid_or_damaged", message: "ZIP aggregate sizes exceed safe integer precision." });
        }
        if (totalUncompressedBytes > PHASE20_LIMITS.archive.maxExpandedBytes) reasons.push("archive total expanded size budget exceeded");
        pending.push({ raw: entry, normalizedPath: validatedPath.normalizedPath, directory: kind.directory, kind: kind.kind, reasons });
        zip.readEntry();
      } catch (error) {
        fail(error);
      }
    });
    zip.once("end", () => {
      if (settled) return;
      settled = true;
      resolve();
    });
    zip.readEntry();
  });

  const byPath = new Map<string, typeof pending>();
  for (const entry of pending) {
    const key = entry.normalizedPath.toLocaleLowerCase("en-US");
    const colliding = byPath.get(key) ?? [];
    colliding.push(entry);
    byPath.set(key, colliding);
  }
  for (const colliding of byPath.values()) {
    if (colliding.length > 1) for (const entry of colliding) entry.reasons.push("case-insensitive or duplicate path collision");
  }
  for (const entry of pending) {
    const segments = entry.normalizedPath.split("/");
    for (let index = 1; index < segments.length; index += 1) {
      const prefix = segments.slice(0, index).join("/").toLocaleLowerCase("en-US");
      const parents = byPath.get(prefix);
      if (parents?.some((candidate) => !candidate.directory)) {
        entry.reasons.push("file/directory prefix collision");
        for (const parent of parents) parent.reasons.push("file/directory prefix collision");
      }
    }
  }

  const warnings: StructuredDocumentWarning[] = [];
  const entries = pending.map((entry): AnalyzedEntry => {
    entry.reasons = [...new Set(entry.reasons)];
    const ratio = entry.raw.uncompressedSize === 0 ? 0 : entry.raw.compressedSize === 0 ? Number.POSITIVE_INFINITY : entry.raw.uncompressedSize / entry.raw.compressedSize;
    const entryWarnings = warningForReasons(entry.normalizedPath || "unnamed entry", entry.reasons);
    for (const warning of entryWarnings) pushWarningOnce(warnings, warning);
    return {
      raw: entry.raw,
      normalizedPath: entry.normalizedPath,
      directory: entry.directory,
      unsafeReasons: entry.reasons,
      result: {
        path: entry.directory ? `${entry.normalizedPath}/` : entry.normalizedPath,
        kind: entry.kind,
        compressedSize: entry.raw.compressedSize,
        uncompressedSize: entry.raw.uncompressedSize,
        compressionRatio: Number.isFinite(ratio) ? Number(ratio.toFixed(3)) : undefined,
        encrypted: entry.raw.isEncrypted() || (entry.raw.generalPurposeBitFlag & 1) !== 0 || entry.raw.extraFields.some((field) => field.id === 0x9901),
        unsafe: entry.reasons.length > 0,
        unsafeReason: entry.reasons.length > 0 ? entry.reasons.join("; ") : undefined,
        modifiedAt: entry.raw.getLastModDate().toISOString(),
        warnings: entryWarnings,
      },
    };
  });
  return { zip, entries, warnings, totalCompressedBytes, totalUncompressedBytes };
}

function sourceReference(requestedPath: string, resolved: { workspaceRelativePath?: string; artifactRef?: string }, sizeBytes: number): StructuredSourceReference {
  if (resolved.artifactRef) return { kind: "artifact", reference: resolved.artifactRef, artifactUri: resolved.artifactRef, mimeType: ZIP_MIME_TYPE, sizeBytes };
  return { kind: "workspace_path", reference: resolved.workspaceRelativePath ?? requestedPath, workspaceRelativePath: resolved.workspaceRelativePath, mimeType: ZIP_MIME_TYPE, sizeBytes };
}

function failureResult(action: ArchiveManageArgs["action"], failure: ArchiveFailure, context: RuntimeToolExecutionContext, format: "zip" | "unknown" = "zip"): ToolResult {
  const timestamp = context.moduleContext.clock.now();
  const error: ToolStructuredError = {
    type: failure.dependency ? "missing_dependency" : "command_failed",
    message: failure.message,
    retryable: false,
    toolName: "archive_manage",
    dependency: failure.dependency,
  };
  const body = { kind: "archive_error", action, format, code: failure.code, error, capabilities: CAPABILITIES };
  return { toolName: "archive_manage", callId: context.callId, startedAt: timestamp, endedAt: timestamp, success: false, output: JSON.stringify(body), structuredContent: body, error: failure.message };
}

function operationFailure(error: unknown): ArchiveFailure {
  if (error instanceof ArchiveOperationError) return error.failure;
  return { code: "archive_invalid_or_damaged", message: (error as Error).message || String(error) };
}

async function readArchiveBytes(archivePath: string, action: "list" | "extract", context: RuntimeToolExecutionContext): Promise<{ resolved: Awaited<ReturnType<ToolModuleContext["paths"]["resolveReadable"]>>; buffer: Buffer } | ToolResult> {
  const resolved = await context.moduleContext.paths.resolveReadable(archivePath);
  const extension = path.extname(resolved.absolutePath).toLowerCase();
  if (extension !== ".zip") {
    return failureResult(action, { code: "unsupported_format", message: "archive_manage supports ZIP only; TAR and GZIP are explicitly unsupported." }, context, "unknown");
  }
  const stat = await fs.stat(resolved.absolutePath);
  if (!stat.isFile()) throw new ToolArgumentError("archivePath must identify a regular ZIP file.", { fieldPath: "/archivePath" });
  if (stat.size > PHASE20_LIMITS.archive.maxInputBytes) {
    return failureResult(action, { code: "archive_too_large", message: `ZIP input exceeds the ${PHASE20_LIMITS.archive.maxInputBytes / 1024 / 1024} MiB limit.` }, context);
  }
  const buffer = await resolved.readBytes();
  if (buffer.byteLength > PHASE20_LIMITS.archive.maxInputBytes) {
    return failureResult(action, { code: "archive_too_large", message: `ZIP bytes exceed the ${PHASE20_LIMITS.archive.maxInputBytes / 1024 / 1024} MiB limit after the guarded read.` }, context);
  }
  if (!zipMagic(buffer)) return failureResult(action, { code: "format_mismatch", message: "The .zip input does not have a ZIP signature." }, context);
  return { resolved, buffer };
}

async function executeList(args: ArchiveListArgs, context: RuntimeToolExecutionContext): Promise<ToolResult> {
  let cursor: number;
  try {
    cursor = parseNonNegativeCursor(args.cursor);
  } catch (error) {
    throw new ToolArgumentError((error as Error).message, { fieldPath: "/cursor" });
  }
  const loaded = await readArchiveBytes(args.archivePath, "list", context);
  if ("success" in loaded) return loaded;
  let analysis: ArchiveAnalysis | undefined;
  try {
    analysis = await analyzeArchive(loaded.buffer);
    if (cursor > analysis.entries.length) throw new ToolArgumentError("Cursor exceeds the archive entry count.", { fieldPath: "/cursor" });
    const maxEntries = args.maxEntries ?? DEFAULT_LIST_ENTRIES;
    const page: ArchiveEntryResult[] = [];
    let visibleChars = 0;
    for (let index = cursor; index < analysis.entries.length && page.length < maxEntries; index += 1) {
      const entry = analysis.entries[index]!.result;
      const entryChars = JSON.stringify(entry).length;
      if (page.length > 0 && visibleChars + entryChars > PHASE20_LIMITS.maxModelVisibleChars - 16_384) break;
      page.push(entry);
      visibleChars += entryChars;
    }
    const nextOffset = cursor + page.length;
    const truncated = nextOffset < analysis.entries.length;
    const warnings = [...analysis.warnings];
    if (truncated) pushWarningOnce(warnings, structuredWarning("output_truncated", { category: "truncation", details: { nextCursor: String(nextOffset) } }));
    const base: ArchiveListResult = {
      format: "zip",
      source: sourceReference(args.archivePath, loaded.resolved, loaded.buffer.byteLength),
      metadata: { sizeBytes: loaded.buffer.byteLength, creatorApplication: "yauzl lazy central-directory reader", properties: { validation: "full_central_directory", extractionPerformed: false } },
      warnings,
      truncation: { truncated, reason: truncated ? "pagination" : undefined, returnedItems: page.length, totalItems: analysis.entries.length, nextCursor: truncated ? String(nextOffset) : undefined },
      entries: page,
      totalEntries: analysis.entries.length,
      returnedEntries: page.length,
      totalCompressedBytes: analysis.totalCompressedBytes,
      totalUncompressedBytes: analysis.totalUncompressedBytes,
    };
    const result = { action: "list" as const, ...base, capabilities: CAPABILITIES };
    const output = JSON.stringify(result);
    if (output.length > PHASE20_LIMITS.maxModelVisibleChars) return failureResult("list", { code: "archive_output_too_large", message: "Archive list page exceeds the model-visible output limit; request fewer entries." }, context);
    const timestamp = context.moduleContext.clock.now();
    return { toolName: "archive_manage", callId: context.callId, startedAt: timestamp, endedAt: timestamp, success: true, output, structuredContent: result, artifacts: [] };
  } catch (error) {
    if (error instanceof ToolArgumentError) throw error;
    return failureResult("list", operationFailure(error), context);
  } finally {
    analysis?.zip.close();
  }
}
interface CreateEntry {
  archivePath: string;
  workspaceRelativePath: string;
  absolutePath: string;
  directory: boolean;
  sizeBytes: number;
  identity: {
    dev: number;
    ino: number;
    mtimeMs: number;
  };
}

function assertCreateArchivePath(archivePath: string, directory: boolean, fieldPath: string): string {
  const validation = pathUnsafeReasons(archivePath, directory);
  if (validation.reasons.length > 0) {
    throw new ToolArgumentError(`Unsafe ZIP entry path '${archivePath}': ${validation.reasons.join("; ")}.`, { fieldPath });
  }
  return validation.normalizedPath;
}

async function collectCreateEntries(args: ArchiveCreateArgs, context: RuntimeToolExecutionContext, absoluteOutput: string): Promise<CreateEntry[]> {
  const entries: CreateEntry[] = [];
  const seen = new Set<string>();
  const realWorkspaceRoot = await fs.realpath(context.workspaceRoot);
  let totalBytes = 0;
  const add = (entry: CreateEntry, fieldPath: string): void => {
    const key = entry.archivePath.normalize("NFC").toLocaleLowerCase("en-US");
    if (seen.has(key)) throw new ToolArgumentError(`Create paths produce a case-insensitive ZIP collision at '${entry.archivePath}'.`, { fieldPath });
    seen.add(key);
    entries.push(entry);
    if (entries.length > PHASE20_LIMITS.archive.maxEntries) {
      throw new ToolArgumentError(`ZIP creation exceeds the ${PHASE20_LIMITS.archive.maxEntries}-entry limit.`, { fieldPath: "/paths" });
    }
    if (!entry.directory) {
      if (entry.sizeBytes > PHASE20_LIMITS.archive.maxSingleEntryBytes) {
        throw new ToolArgumentError(`Source file '${entry.archivePath}' exceeds the ${PHASE20_LIMITS.archive.maxSingleEntryBytes / 1024 / 1024} MiB entry limit.`, { fieldPath });
      }
      totalBytes += entry.sizeBytes;
      if (totalBytes > PHASE20_LIMITS.archive.maxCreateSourceBytes) {
        throw new ToolArgumentError(`ZIP creation sources exceed the ${PHASE20_LIMITS.archive.maxCreateSourceBytes / 1024 / 1024} MiB in-memory source limit.`, { fieldPath: "/paths" });
      }
    }
  };

  const walk = async (absolutePath: string, workspaceRelativePath: string, fieldPath: string): Promise<void> => {
    const relativePath = normalizeRelativePath(workspaceRelativePath);
    if (isProtectedReadPath(relativePath)) {
      throw new ToolArgumentError(`Protected path '${relativePath}' cannot be archived.`, { fieldPath });
    }
    const stat = await fs.lstat(absolutePath);
    if (stat.isSymbolicLink()) throw new ToolArgumentError(`Symbolic link '${relativePath}' cannot be archived.`, { fieldPath });
    const realSourcePath = await fs.realpath(absolutePath);
    const realSourceRelative = path.relative(realWorkspaceRoot, realSourcePath);
    if (realSourceRelative === ".." || realSourceRelative.startsWith(`..${path.sep}`) || path.isAbsolute(realSourceRelative)) {
      throw new ToolArgumentError(`Source '${relativePath}' resolves outside the workspace through a link or junction.`, { fieldPath });
    }
    const archivePath = assertCreateArchivePath(relativePath, stat.isDirectory(), fieldPath);
    if (stat.isFile()) {
      add({
        archivePath,
        workspaceRelativePath: relativePath,
        absolutePath,
        directory: false,
        sizeBytes: stat.size,
        identity: { dev: stat.dev, ino: stat.ino, mtimeMs: stat.mtimeMs },
      }, fieldPath);
      return;
    }
    if (!stat.isDirectory()) throw new ToolArgumentError(`Special filesystem entry '${relativePath}' cannot be archived.`, { fieldPath });
    add({
      archivePath,
      workspaceRelativePath: relativePath,
      absolutePath,
      directory: true,
      sizeBytes: 0,
      identity: { dev: stat.dev, ino: stat.ino, mtimeMs: stat.mtimeMs },
    }, fieldPath);
    const children = await fs.readdir(absolutePath, { withFileTypes: true });
    children.sort((left, right) => left.name.localeCompare(right.name, "en-US"));
    for (const child of children) {
      const childAbsolute = path.join(absolutePath, child.name);
      const childRelative = normalizeRelativePath(path.relative(context.workspaceRoot, childAbsolute));
      await walk(childAbsolute, childRelative, fieldPath);
    }
  };

  for (const [index, inputPath] of args.paths.entries()) {
    const normalized = context.moduleContext.paths.normalize(inputPath);
    const absolutePath = context.moduleContext.paths.resolveWorkspace(normalized);
    const stat = await fs.lstat(absolutePath);
    if (stat.isDirectory()) {
      const relativeOutput = path.relative(absolutePath, absoluteOutput);
      if (relativeOutput === "" || (!relativeOutput.startsWith(`..${path.sep}`) && relativeOutput !== ".." && !path.isAbsolute(relativeOutput))) {
        throw new ToolArgumentError("A source directory cannot contain the ZIP output path.", { fieldPath: `/paths/${index}` });
      }
    } else if (path.resolve(absolutePath) === path.resolve(absoluteOutput)) {
      throw new ToolArgumentError("The ZIP output cannot also be a source path.", { fieldPath: `/paths/${index}` });
    }
    const relativePath = normalizeRelativePath(path.relative(context.workspaceRoot, absolutePath));
    await walk(absolutePath, relativePath, `/paths/${index}`);
  }
  return entries;
}

function throwIfAborted(signal: AbortSignal | undefined): void {
  if (!signal?.aborted) return;
  if (signal.reason instanceof Error) throw signal.reason;
  throw new Error(typeof signal.reason === "string" ? signal.reason : "Archive operation was aborted.");
}

function backupPathFor(outputPath: string, callId: string): string {
  const safeCallId = callId.replace(/[^A-Za-z0-9_-]/gu, "_");
  return `${normalizeRelativePath(outputPath)}.deep-mix-backup-${safeCallId}`;
}

async function publishGeneratedZip(
  zip: { generateNodeStream(options: Record<string, unknown>): NodeJS.ReadableStream },
  args: ArchiveCreateArgs,
  context: RuntimeToolExecutionContext,
  absoluteOutput: string,
): Promise<{ sizeBytes: number; sha256: string }> {
  const stagingRelative = stagePathFor(args.outputPath, context.callId);
  const backupRelative = backupPathFor(args.outputPath, context.callId);
  const stagingPath = context.moduleContext.paths.resolveWorkspace(stagingRelative);
  const backupPath = context.moduleContext.paths.resolveWorkspace(backupRelative);
  await fs.mkdir(path.dirname(stagingPath), { recursive: true });
  for (const ownedPath of [stagingPath, backupPath]) {
    try {
      await fs.lstat(ownedPath);
      throw new ToolArgumentError("A deterministic archive staging or backup path already exists; remove the stale owned path before retrying.", { fieldPath: "/outputPath" });
    } catch (error) {
      if (error instanceof ToolArgumentError) throw error;
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    }
  }
  const hash = createHash("sha256");
  let sizeBytes = 0;
  let backupCreated = false;
  try {
    const handle = await fs.open(stagingPath, "wx", 0o600);
    try {
      const stream = zip.generateNodeStream({
      type: "nodebuffer",
      compression: "DEFLATE",
      compressionOptions: { level: 6 },
      platform: "UNIX",
      streamFiles: true,
      mimeType: ZIP_MIME_TYPE,
    });
      await new Promise<void>((resolve, reject) => {
      let settled = false;
      let pendingWrite = Promise.resolve();
      const readable = stream as NodeJS.ReadableStream & {
        pause: () => void;
        resume: () => void;
        destroy: (error?: Error) => void;
      };
      const fail = (error: unknown): void => {
        if (settled) return;
        settled = true;
        readable.destroy(error instanceof Error ? error : new Error(String(error)));
        reject(error);
      };
      readable.once("error", fail);
      readable.on("data", (rawChunk: Buffer | Uint8Array | string) => {
        readable.pause();
        pendingWrite = pendingWrite.then(async () => {
          throwIfAborted(context.signal);
          const chunk = Buffer.isBuffer(rawChunk) ? rawChunk : Buffer.from(rawChunk);
          sizeBytes += chunk.byteLength;
          if (sizeBytes > PHASE20_LIMITS.archive.maxOutputBytes) {
            throw new ArchiveOperationError({ code: "archive_output_too_large", message: `Generated ZIP exceeds the ${PHASE20_LIMITS.archive.maxOutputBytes / 1024 / 1024} MiB output limit.` });
          }
          hash.update(chunk);
          await handle.writeFile(chunk);
        }).then(() => {
          if (!settled) readable.resume();
        }).catch(fail);
      });
      readable.once("end", () => {
        pendingWrite.then(() => {
          if (settled) return;
          settled = true;
          resolve();
        }).catch(fail);
      });
      });
      await handle.sync();
    } finally {
      await handle.close();
    }
    throwIfAborted(context.signal);
  } catch (error) {
    await fs.rm(stagingPath, { force: true }).catch(() => undefined);
    throw error;
  }
  try {
    if (!args.overwrite) {
      try {
        await fs.link(stagingPath, absoluteOutput);
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code === "EEXIST") throw new ToolArgumentError("Output already exists; set overwrite=true to replace it.", { fieldPath: "/overwrite" });
        throw error;
      }
      await fs.rm(stagingPath, { force: true });
      return { sizeBytes, sha256: hash.digest("hex") };
    }
    try {
      await fs.rename(absoluteOutput, backupPath);
      backupCreated = true;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    }
    try {
      await fs.rename(stagingPath, absoluteOutput);
      if (backupCreated) await fs.rm(backupPath, { force: true });
      backupCreated = false;
      return { sizeBytes, sha256: hash.digest("hex") };
    } catch (error) {
      if (backupCreated) await fs.rename(backupPath, absoluteOutput).catch(() => undefined);
      backupCreated = false;
      throw error;
    }
  } finally {
    await fs.rm(stagingPath, { force: true }).catch(() => undefined);
    if (backupCreated) await fs.rename(backupPath, absoluteOutput).catch(() => undefined);
  }
}

async function readCreateEntryContent(
  entry: CreateEntry,
  remainingBudget: number,
  context: RuntimeToolExecutionContext,
): Promise<Buffer> {
  const guarded = await context.moduleContext.paths.resolveReadable(entry.workspaceRelativePath);
  const handle = await fs.open(guarded.absolutePath, "r");
  try {
    const before = await handle.stat();
    if (!before.isFile()
      || before.dev !== entry.identity.dev
      || before.ino !== entry.identity.ino
      || before.size !== entry.sizeBytes
      || before.mtimeMs !== entry.identity.mtimeMs) {
      throw new ToolArgumentError(`Source '${entry.workspaceRelativePath}' changed identity or became unsafe before ZIP generation.`, { fieldPath: "/paths" });
    }
    if (before.size > remainingBudget) {
      throw new ToolArgumentError(`ZIP creation sources exceed the ${PHASE20_LIMITS.archive.maxCreateSourceBytes / 1024 / 1024} MiB in-memory source limit.`, { fieldPath: "/paths" });
    }

    const chunks: Buffer[] = [];
    let actualBytes = 0;
    while (true) {
      throwIfAborted(context.signal);
      const chunk = Buffer.allocUnsafe(Math.min(64 * 1024, Math.max(1, remainingBudget - actualBytes + 1)));
      const { bytesRead } = await handle.read(chunk, 0, chunk.byteLength, null);
      if (bytesRead === 0) break;
      actualBytes += bytesRead;
      if (actualBytes > remainingBudget || actualBytes > PHASE20_LIMITS.archive.maxSingleEntryBytes) {
        throw new ToolArgumentError(`Source '${entry.workspaceRelativePath}' exceeded the actual ZIP creation byte limit.`, { fieldPath: "/paths" });
      }
      chunks.push(chunk.subarray(0, bytesRead));
    }

    const after = await handle.stat();
    if (!after.isFile()
      || after.dev !== before.dev
      || after.ino !== before.ino
      || after.size !== before.size
      || after.mtimeMs !== before.mtimeMs
      || actualBytes !== after.size) {
      throw new ToolArgumentError(`Source '${entry.workspaceRelativePath}' changed during ZIP generation.`, { fieldPath: "/paths" });
    }
    return Buffer.concat(chunks, actualBytes);
  } finally {
    await handle.close();
  }
}

async function executeCreate(args: ArchiveCreateArgs, context: RuntimeToolExecutionContext): Promise<ToolResult> {
  if (!context.checkpoint) return failureResult("create", { code: "archive_write_failed", message: "Runtime did not create the required pre-write checkpoint." }, context);
  if (path.extname(args.outputPath).toLowerCase() !== ".zip") {
    return failureResult("create", { code: "unsupported_format", message: "archive_manage create supports a .zip output only; TAR and GZIP are unsupported." }, context, "unknown");
  }
  const absoluteOutput = context.moduleContext.paths.resolveWorkspace(args.outputPath);
  try {
    const existing = await fs.lstat(absoluteOutput);
    if (!existing.isFile() || existing.isSymbolicLink()) throw new ToolArgumentError("outputPath must identify a regular ZIP file.", { fieldPath: "/outputPath" });
    if (!args.overwrite) throw new ToolArgumentError("Output already exists; set overwrite=true to replace it.", { fieldPath: "/overwrite" });
  } catch (error) {
    if (error instanceof ToolArgumentError) throw error;
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
  }
  try {
    const entries = await collectCreateEntries(args, context, absoluteOutput);
    let JSZip: JsZipApi;
    try {
      JSZip = await loadJsZip();
    } catch (error) {
      throw new ArchiveOperationError({ code: "archive_dependency_unavailable", message: `JSZip is unavailable: ${(error as Error).message}`, dependency: "jszip" });
    }
    const zip = new JSZip();
    let actualSourceBytes = 0;
    for (const entry of entries) {
      throwIfAborted(context.signal);
      if (entry.directory) {
        zip.folder(entry.archivePath);
        continue;
      }
      const content = await readCreateEntryContent(
        entry,
        PHASE20_LIMITS.archive.maxCreateSourceBytes - actualSourceBytes,
        context,
      );
      actualSourceBytes += content.byteLength;
      zip.file(entry.archivePath, content, { binary: true, createFolders: true });
    }
    const publishedZip = await publishGeneratedZip(zip, args, context, absoluteOutput);
    const relativePath = normalizeRelativePath(path.relative(context.workspaceRoot, absoluteOutput));
    const artifact: ToolOutputArtifact = {
      uri: `file://${relativePath}`,
      fileName: path.basename(absoluteOutput),
      mimeType: ZIP_MIME_TYPE,
      sizeBytes: publishedZip.sizeBytes,
      sha256: publishedZip.sha256,
      kind: "binary",
      sourceToolName: "archive_manage",
      summary: `Created bounded ZIP with ${entries.length} entries; no external archive program was invoked.`,
      createdAt: context.moduleContext.clock.now(),
      workspaceRelativePath: relativePath,
    };
    const result = {
      action: "create" as const,
      format: "zip" as const,
      outputPath: relativePath,
      sizeBytes: publishedZip.sizeBytes,
      entryCount: entries.length,
      artifact,
      warnings: [] as StructuredDocumentWarning[],
      checkpointId: context.checkpoint.checkpointId,
      undoAvailable: true,
      capabilities: CAPABILITIES,
    };
    const timestamp = context.moduleContext.clock.now();
    return { toolName: "archive_manage", callId: context.callId, startedAt: timestamp, endedAt: timestamp, success: true, output: JSON.stringify(result), structuredContent: result, artifacts: [artifact] };
  } catch (error) {
    if (error instanceof ToolArgumentError) throw error;
    const failure = error instanceof ArchiveOperationError ? error.failure : { code: "archive_write_failed" as const, message: `ZIP creation failed: ${(error as Error).message}` };
    return failureResult("create", failure, context);
  }
}
function unsafeExtractionFailure(entries: AnalyzedEntry[]): ArchiveFailure | undefined {
  const unsafe = entries.find((entry) => entry.unsafeReasons.length > 0);
  if (!unsafe) return undefined;
  const reasons = unsafe.unsafeReasons;
  const message = `ZIP entry '${unsafe.normalizedPath || unsafe.raw.fileName}' is unsafe to extract: ${reasons.join("; ")}.`;
  if (reasons.some((reason) => reason.includes("encrypted"))) return { code: "archive_encrypted", message };
  if (reasons.some((reason) => reason.includes("unsupported compression"))) return { code: "archive_unsupported_method", message };
  if (reasons.some((reason) => /symbolic link|special|conflicting file/iu.test(reason))) return { code: "archive_symlink_or_special", message };
  if (reasons.some((reason) => reason.includes("collision"))) return { code: "archive_path_collision", message };
  if (reasons.some((reason) => reason.includes("single-entry size"))) return { code: "archive_entry_too_large", message };
  if (reasons.some((reason) => reason.includes("expanded size"))) return { code: "archive_expanded_size_exceeded", message };
  if (reasons.some((reason) => reason.includes("compression ratio"))) return { code: "archive_ratio_exceeded", message };
  return { code: "archive_unsafe_path", message };
}

function stagePathFor(outputPath: string, callId: string): string {
  const normalized = normalizeRelativePath(outputPath).replace(/\/+$/u, "");
  const safeCallId = callId.replace(/[^A-Za-z0-9_-]/gu, "_");
  return `${normalized}.deep-mix-stage-${safeCallId}`;
}

function openEntryStream(zip: YauzlZipFile, entry: YauzlEntry): Promise<NodeJS.ReadableStream> {
  return new Promise((resolve, reject) => {
    zip.openReadStream(entry, (error, stream) => {
      if (error || !stream) reject(error ?? new Error("ZIP entry stream did not open."));
      else resolve(stream);
    });
  });
}

async function ensureSafeStageDirectory(stagingPath: string, directoryPath: string): Promise<void> {
  const relative = path.relative(stagingPath, directoryPath);
  if (relative === ".." || relative.startsWith(`..${path.sep}`) || path.isAbsolute(relative)) {
    throw new ArchiveOperationError({ code: "archive_unsafe_path", message: "An extraction directory escaped the guarded stage." });
  }
  let current = stagingPath;
  for (const segment of relative.split(path.sep).filter(Boolean)) {
    current = path.join(current, segment);
    try {
      await fs.mkdir(current, { recursive: false });
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
    }
    const stat = await fs.lstat(current);
    if (!stat.isDirectory() || stat.isSymbolicLink()) {
      throw new ArchiveOperationError({ code: "archive_symlink_or_special", message: `Extraction path component '${path.relative(stagingPath, current)}' is not a real directory.` });
    }
  }
}

async function executeExtract(args: ArchiveExtractArgs, context: RuntimeToolExecutionContext): Promise<ToolResult> {
  if (!context.checkpoint) return failureResult("extract", { code: "archive_write_failed", message: "Runtime did not create the required pre-write checkpoint." }, context);
  const loaded = await readArchiveBytes(args.archivePath, "extract", context);
  if ("success" in loaded) return loaded;
  const absoluteOutput = context.moduleContext.paths.resolveWorkspace(args.outputDirectory);
  const relativeOutput = normalizeRelativePath(path.relative(context.workspaceRoot, absoluteOutput));
  if (!relativeOutput || relativeOutput === ".") throw new ToolArgumentError("outputDirectory cannot be the workspace root.", { fieldPath: "/outputDirectory" });
  try {
    await fs.lstat(absoluteOutput);
    throw new ToolArgumentError("outputDirectory must not already exist; extraction never merges or overwrites directories.", { fieldPath: "/outputDirectory" });
  } catch (error) {
    if (error instanceof ToolArgumentError) throw error;
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
  }
  const stagingRelative = stagePathFor(args.outputDirectory, context.callId);
  const stagingPath = context.moduleContext.paths.resolveWorkspace(stagingRelative);
  let analysis: ArchiveAnalysis | undefined;
  let published = false;
  try {
    try {
      await fs.lstat(stagingPath);
      throw new ToolArgumentError("The deterministic extraction staging path already exists; remove the stale stage before retrying.", { fieldPath: "/outputDirectory" });
    } catch (error) {
      if (error instanceof ToolArgumentError) throw error;
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    }
    analysis = await analyzeArchive(loaded.buffer);
    const unsafe = unsafeExtractionFailure(analysis.entries);
    if (unsafe) return failureResult("extract", unsafe, context);
    await fs.mkdir(path.dirname(stagingPath), { recursive: true });
    await fs.mkdir(stagingPath, { recursive: false });
    let totalActualBytes = 0;
    const manifestEntries: Array<{ path: string; sizeBytes: number; sha256?: string }> = [];
    for (const entry of analysis.entries) {
      throwIfAborted(context.signal);
      const destination = path.resolve(stagingPath, ...entry.normalizedPath.split("/"));
      const relativeToStage = path.relative(stagingPath, destination);
      if (!relativeToStage || relativeToStage.startsWith(`..${path.sep}`) || path.isAbsolute(relativeToStage)) {
        throw new ArchiveOperationError({ code: "archive_unsafe_path", message: `ZIP entry '${entry.normalizedPath}' escaped or resolved to the extraction root.` });
      }
      if (entry.directory) {
        await ensureSafeStageDirectory(stagingPath, destination);
        manifestEntries.push({ path: entry.normalizedPath, sizeBytes: 0 });
        continue;
      }
      await ensureSafeStageDirectory(stagingPath, path.dirname(destination));
      const handle = await fs.open(destination, "wx", 0o600);
      const hash = createHash("sha256");
      let crc = 0xffff_ffff;
      let actualBytes = 0;
      try {
        const stream = await openEntryStream(analysis.zip, entry.raw);
        for await (const rawChunk of stream as NodeJS.ReadableStream & AsyncIterable<Buffer | Uint8Array | string>) {
          throwIfAborted(context.signal);
          const chunk = Buffer.isBuffer(rawChunk) ? rawChunk : Buffer.from(rawChunk);
          actualBytes += chunk.byteLength;
          totalActualBytes += chunk.byteLength;
          if (actualBytes > PHASE20_LIMITS.archive.maxSingleEntryBytes) {
            throw new ArchiveOperationError({ code: "archive_entry_too_large", message: `Entry '${entry.normalizedPath}' exceeded the actual-byte limit while streaming.` });
          }
          if (totalActualBytes > PHASE20_LIMITS.archive.maxExpandedBytes) {
            throw new ArchiveOperationError({ code: "archive_expanded_size_exceeded", message: "ZIP exceeded the actual expanded-byte limit while streaming." });
          }
          hash.update(chunk);
          crc = updateCrc32(crc, chunk);
          await handle.writeFile(chunk);
        }
        await handle.sync();
      } finally {
        await handle.close();
      }
      if (actualBytes !== entry.raw.uncompressedSize) {
        throw new ArchiveOperationError({ code: "archive_invalid_or_damaged", message: `Entry '${entry.normalizedPath}' actual size did not match the central directory.` });
      }
      const actualCrc32 = (crc ^ 0xffff_ffff) >>> 0;
      if (actualCrc32 !== (entry.raw.crc32 >>> 0)) {
        throw new ArchiveOperationError({ code: "archive_invalid_or_damaged", message: `Entry '${entry.normalizedPath}' failed the ZIP CRC32 integrity check.` });
      }
      manifestEntries.push({ path: entry.normalizedPath, sizeBytes: actualBytes, sha256: hash.digest("hex") });
    }
    analysis.zip.close();
    analysis = undefined;
    try {
      await fs.lstat(absoluteOutput);
      throw new ToolArgumentError("outputDirectory appeared during extraction; refusing to merge or replace it.", { fieldPath: "/outputDirectory" });
    } catch (error) {
      if (error instanceof ToolArgumentError) throw error;
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    }
    await fs.rename(stagingPath, absoluteOutput);
    published = true;
    const manifest = {
      version: 1 as const,
      format: "zip" as const,
      source: sourceReference(args.archivePath, loaded.resolved, loaded.buffer.byteLength),
      outputDirectory: relativeOutput,
      createdAt: context.moduleContext.clock.now(),
      entries: manifestEntries,
      entryCount: manifestEntries.length,
      totalBytes: totalActualBytes,
    };
    const manifestBytes = Buffer.from(JSON.stringify(manifest), "utf8");
    if (manifestBytes.byteLength > PHASE20_LIMITS.archive.maxOutputBytes) {
      return failureResult("extract", { code: "archive_output_too_large", message: "Extraction manifest exceeds the artifact byte limit." }, context);
    }
    const manifestArtifact = await context.moduleContext.persistence.storeToolOutputArtifact({
      sessionId: context.sessionId,
      turnId: context.turnId,
      toolCallId: context.callId,
      sourceToolName: "archive_manage",
      fileName: `${path.basename(absoluteOutput)}.extraction-manifest.json`,
      mimeType: "application/json",
      kind: "text",
      summary: `Bounded manifest for ${manifestEntries.length} safely extracted ZIP entries; binary contents were not placed in message history.`,
      content: manifestBytes,
      signal: context.signal,
    });
    const result = {
      action: "extract" as const,
      format: "zip" as const,
      outputDirectory: relativeOutput,
      entriesExtracted: manifestEntries.length,
      totalBytes: totalActualBytes,
      manifestArtifact,
      warnings: [] as StructuredDocumentWarning[],
      checkpointId: context.checkpoint.checkpointId,
      undoAvailable: true,
      capabilities: CAPABILITIES,
    };
    const timestamp = context.moduleContext.clock.now();
    return { toolName: "archive_manage", callId: context.callId, startedAt: timestamp, endedAt: timestamp, success: true, output: JSON.stringify(result), structuredContent: result, artifacts: [manifestArtifact] };
  } catch (error) {
    if (error instanceof ToolArgumentError) throw error;
    return failureResult("extract", error instanceof ArchiveOperationError ? error.failure : { code: "archive_write_failed", message: `ZIP extraction failed: ${(error as Error).message}` }, context);
  } finally {
    analysis?.zip.close();
    if (!published) await fs.rm(stagingPath, { recursive: true, force: true }).catch(() => undefined);
  }
}

const listSchema = {
  type: "object",
  additionalProperties: false,
  required: ["action", "archivePath"],
  properties: {
    action: { const: "list" },
    archivePath: pathPropertySchema,
    cursor: { type: "string", minLength: 1, maxLength: 64, pattern: "^(0|[1-9]\\d*)$" },
    maxEntries: { type: "integer", minimum: 1, maximum: PHASE20_LIMITS.archive.maxEntries, default: DEFAULT_LIST_ENTRIES },
  },
} as const;

const createSchema = {
  type: "object",
  additionalProperties: false,
  required: ["action", "outputPath", "paths"],
  properties: {
    action: { const: "create" },
    outputPath: pathPropertySchema,
    paths: { type: "array", minItems: 1, maxItems: PHASE20_LIMITS.archive.maxEntries, uniqueItems: true, items: pathPropertySchema },
    overwrite: { type: "boolean", default: false },
  },
} as const;

const extractSchema = {
  type: "object",
  additionalProperties: false,
  required: ["action", "archivePath", "outputDirectory"],
  properties: {
    action: { const: "extract" },
    archivePath: pathPropertySchema,
    outputDirectory: pathPropertySchema,
  },
} as const;

export const archiveManageTool: RuntimeToolSpec = {
  name: "archive_manage",
  displayName: "Manage ZIP Archive",
  description: "List, create, or safely extract bounded ZIP archives with full central-directory preflight, zip-slip/link/bomb defenses, staging, artifacts, checkpoint, and undo. TAR/GZIP and external archive programs are explicitly unsupported.",
  inputSchema: {
    type: "object",
    additionalProperties: false,
    required: ["action"],
    properties: {
      action: { type: "string", enum: ["list", "create", "extract"] },
      archivePath: pathPropertySchema,
      cursor: { type: "string", minLength: 1, maxLength: 64, pattern: "^(0|[1-9]\\d*)$" },
      maxEntries: { type: "integer", minimum: 1, maximum: PHASE20_LIMITS.archive.maxEntries },
      outputPath: pathPropertySchema,
      paths: { type: "array", minItems: 1, maxItems: PHASE20_LIMITS.archive.maxEntries, uniqueItems: true, items: pathPropertySchema },
      overwrite: { type: "boolean" },
      outputDirectory: pathPropertySchema,
    },
    oneOf: [listSchema, createSchema, extractSchema],
  },
  readOnly: false,
  permissionCategory: "write_file",
  sideEffectLevel: "high",
  timeoutCategory: "slow",
  groups: ["documents", "archive", "archive-manage"],
  selection: {
    groups: ["documents", "archive", "archive-manage"],
    keywords: [
      "list zip", "create zip", "extract zip", "inspect archive", "manage archive",
      "列出ZIP", "创建ZIP", "解压ZIP", "检查归档", "管理压缩包",
    ],
    keywordGroups: [
      ["list", "zip"], ["create", "zip"], ["extract", "zip"], ["inspect", "archive"],
      ["列出", "zip"], ["创建", "zip"], ["解压", "zip"], ["检查", "归档"],
    ],
    attachmentExtensions: [".zip", ".tar", ".gz", ".gzip"],
    mimeTypes: [ZIP_MIME_TYPE, "application/x-tar", "application/gzip"],
  },
  checkpoint: { mode: "before_write", scope: "pre_tool_write", reason: "Before creating or extracting a bounded ZIP archive." },
  getAvailability: archiveAvailability,
  resolvePermission: (rawArgs) => (rawArgs as ArchiveManageArgs).action === "list"
    ? { permissionCategory: "read_only", sideEffectLevel: "none", readOnly: true }
    : { permissionCategory: "write_file", sideEffectLevel: "high", readOnly: false },
  resolveAccess: async (rawArgs, context) => {
    const args = rawArgs as ArchiveManageArgs;
    if (args.action === "list") return [{ kind: "filesystem_read", paths: [args.archivePath], reason: "Read and validate the ZIP central directory without extraction." }];
    if (args.action === "create") return [
      { kind: "filesystem_read", paths: args.paths, reason: "Read only the explicitly declared workspace paths for bounded ZIP creation." },
      {
        kind: "filesystem_write",
        paths: [args.outputPath, stagePathFor(args.outputPath, context.callId), backupPathFor(args.outputPath, context.callId)],
        reason: "Stream the bounded ZIP through guarded deterministic staging/backup paths and publish the final archive.",
      },
    ];
    const absoluteOutput = context.paths.resolveWorkspace(args.outputDirectory);
    const relativeOutput = normalizeRelativePath(path.relative(context.workspaceRoot, absoluteOutput));
    if (!relativeOutput || relativeOutput === ".") throw new ToolArgumentError("outputDirectory cannot be the workspace root.", { fieldPath: "/outputDirectory" });
    try {
      await fs.lstat(absoluteOutput);
      throw new ToolArgumentError("outputDirectory must not already exist; extraction never merges or overwrites directories.", { fieldPath: "/outputDirectory" });
    } catch (error) {
      if (error instanceof ToolArgumentError) throw error;
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    }
    const stage = stagePathFor(args.outputDirectory, context.callId);
    return [
      { kind: "filesystem_read", paths: [args.archivePath], reason: "Read and fully preflight the ZIP before any extraction write." },
      { kind: "filesystem_write", paths: [args.outputDirectory, stage], reason: "Extract into a new guarded sibling stage and atomically publish the destination directory." },
    ];
  },
  execute: (rawArgs, context) => {
    const args = rawArgs as ArchiveManageArgs;
    return args.action === "list"
      ? executeList(args, context)
      : args.action === "create"
        ? executeCreate(args, context)
        : executeExtract(args, context);
  },
};

export const archivesToolModule: ToolModule = {
  manifest: {
    id: "builtin.archives",
    version: "1.0.0",
    description: "ZIP-only bounded archive list/create/extract with no external-program fallback.",
    source: "built_in",
  },
  create: () => [archiveManageTool],
};
