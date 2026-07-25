import { createHash } from "node:crypto";
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";

import type {
  DownloadArtifactResult,
  NetworkAuditSummary,
  ToolAccessRequest,
  ToolOutputArtifact,
  ToolResult,
} from "../../../../shared-schema/src/index.js";
import { ToolArgumentError } from "../../index.js";
import type { ToolNetworkResponseConsumer, ToolNetworkResponseHead } from "../../network/index.js";
import {
  createSafeNetworkDeadline,
  executeSafeHttpRequest,
  extractSensitiveNetworkHeaderValues,
  isSensitiveNetworkQueryName,
  parseSafeHttpUrl,
  redactNetworkToolArguments,
  redactSensitiveText,
  redactUrl,
  SafeNetworkError,
} from "../../network/safe-http.js";
import type {
  RuntimeToolExecutionContext,
  RuntimeToolSpec,
  ToolAccessResolutionContext,
  ToolModuleContext,
} from "../../tool-module.js";

const DEFAULT_MAX_BYTES = 25 * 1024 * 1024;
const MAX_MAX_BYTES = 64 * 1024 * 1024;
const DEFAULT_TIMEOUT_MS = 60_000;
const MAX_FILENAME_CHARS = 180;
const SIGNATURE_PREFIX_BYTES = 512;

export type DownloadTarget = "artifact" | "workspace";
export type DownloadOverwriteStrategy = "error" | "replace" | "unique";

export interface DownloadFileArgs {
  url: string;
  target?: DownloadTarget;
  /** Preferred artifact filename. Workspace downloads use the basename of workspacePath. */
  outputName?: string;
  /** Exact workspace-relative file path; required when target is workspace. */
  workspacePath?: string;
  maxBytes?: number;
  overwriteStrategy?: DownloadOverwriteStrategy;
  headers?: Record<string, string>;
  timeoutMs?: number;
}

interface WorkspaceDownloadPlan {
  workspaceRoot: string;
  destinationRelativePath: string;
  stagedRelativePath: string;
  backupRelativePath: string;
  destinationPath: string;
  stagedPath: string;
  backupDirectory: string;
}

interface SignatureInfo {
  mimeType: string;
  family: "archive" | "document" | "executable" | "html" | "image";
}

interface WorkspaceFileFingerprint {
  exists: boolean;
  device?: number | bigint;
  inode?: number | bigint;
  sizeBytes?: number;
  mode?: number;
  modifiedAtMs?: number;
  changedAtMs?: number;
  sha256?: string;
}

function throwIfAborted(signal?: AbortSignal): void {
  if (!signal?.aborted) return;
  if (signal.reason instanceof SafeNetworkError) throw signal.reason;
  throw new SafeNetworkError("Download was cancelled.", "cancelled", false, { cause: signal.reason });
}

function normalizedRelativePath(value: string): string {
  return value.replace(/\\/gu, "/");
}

function fileStatOrUndefined(filePath: string): Promise<Awaited<ReturnType<typeof fs.lstat>> | undefined> {
  return fs.lstat(filePath).catch((error: NodeJS.ErrnoException) => {
    if (error.code === "ENOENT") return undefined;
    throw error;
  });
}

async function fingerprintWorkspaceFile(
  filePath: string,
  signal?: AbortSignal,
): Promise<WorkspaceFileFingerprint> {
  throwIfAborted(signal);
  const pathStat = await fileStatOrUndefined(filePath);
  if (!pathStat) return { exists: false };
  if (pathStat.isSymbolicLink() || !pathStat.isFile()) {
    throw new Error("Workspace download destination changed to a non-regular file.");
  }
  const handle = await fs.open(filePath, "r");
  try {
    const before = await handle.stat();
    if (!before.isFile()) throw new Error("Workspace download destination changed to a non-regular file.");
    const hash = createHash("sha256");
    const buffer = Buffer.allocUnsafe(64 * 1024);
    let position = 0;
    for (;;) {
      throwIfAborted(signal);
      const { bytesRead } = await handle.read(buffer, 0, buffer.byteLength, position);
      if (bytesRead === 0) break;
      hash.update(buffer.subarray(0, bytesRead));
      position += bytesRead;
    }
    const after = await handle.stat();
    const pathIdentity = `${pathStat.dev}:${pathStat.ino}:${pathStat.size}:${pathStat.mtimeMs}:${pathStat.ctimeMs}:${pathStat.mode}`;
    const beforeIdentity = `${before.dev}:${before.ino}:${before.size}:${before.mtimeMs}:${before.ctimeMs}:${before.mode}`;
    const afterIdentity = `${after.dev}:${after.ino}:${after.size}:${after.mtimeMs}:${after.ctimeMs}:${after.mode}`;
    if (pathIdentity !== beforeIdentity || beforeIdentity !== afterIdentity || position !== after.size) {
      throw new Error("Workspace download destination changed while it was being inspected.");
    }
    return {
      exists: true,
      device: after.dev,
      inode: after.ino,
      sizeBytes: after.size,
      mode: after.mode,
      modifiedAtMs: after.mtimeMs,
      changedAtMs: after.ctimeMs,
      sha256: hash.digest("hex"),
    };
  } finally {
    await handle.close();
  }
}

function sameWorkspaceFingerprint(
  left: WorkspaceFileFingerprint,
  right: WorkspaceFileFingerprint,
): boolean {
  return left.exists === right.exists &&
    left.device === right.device &&
    left.inode === right.inode &&
    left.sizeBytes === right.sizeBytes &&
    left.mode === right.mode &&
    left.modifiedAtMs === right.modifiedAtMs &&
    left.changedAtMs === right.changedAtMs &&
    left.sha256 === right.sha256;
}

function sameFileGeneration(
  left: WorkspaceFileFingerprint,
  right: WorkspaceFileFingerprint,
): boolean {
  return left.exists && right.exists &&
    left.device === right.device && left.inode === right.inode &&
    left.sizeBytes === right.sizeBytes && left.sha256 === right.sha256;
}

function sameMovedGeneration(
  left: WorkspaceFileFingerprint,
  right: WorkspaceFileFingerprint,
): boolean {
  return left.exists && right.exists &&
    left.device === right.device && left.inode === right.inode &&
    left.sizeBytes === right.sizeBytes && left.mode === right.mode &&
    left.modifiedAtMs === right.modifiedAtMs && left.sha256 === right.sha256;
}

function sameCheckpointContent(
  current: WorkspaceFileFingerprint,
  checkpoint: { exists: boolean; sizeBytes?: number; mode?: number; sha256?: string },
): boolean {
  return current.exists === checkpoint.exists &&
    (!current.exists || (
      current.sizeBytes === checkpoint.sizeBytes &&
      current.mode === checkpoint.mode &&
      current.sha256 === checkpoint.sha256
    ));
}

interface PublishedPathIdentity {
  device: number | bigint;
  inode: number | bigint;
}

async function removePublishedPathIfOwned(
  destinationPath: string,
  identity: PublishedPathIdentity | undefined,
): Promise<boolean> {
  if (!identity) {
    // Without an identity, preserving a concurrently-created path is safer
    // than blindly deleting it during rollback.
    return false;
  }
  const current = await fileStatOrUndefined(destinationPath).catch(() => undefined);
  if (!current) return true;
  if (current.dev !== identity.device || current.ino !== identity.inode) return false;
  await fs.rm(destinationPath, { force: true });
  return true;
}

async function assertRealWorkspaceParent(workspaceRoot: string, destinationPath: string): Promise<void> {
  const parent = path.dirname(destinationPath);
  const relative = path.relative(workspaceRoot, parent);
  if (relative.startsWith("..") || path.isAbsolute(relative)) {
    throw new ToolArgumentError("Workspace download path escapes the workspace.", { fieldPath: "/workspacePath" });
  }
  let current = workspaceRoot;
  for (const segment of relative.split(path.sep).filter(Boolean)) {
    current = path.join(current, segment);
    const stat = await fileStatOrUndefined(current);
    if (!stat) {
      throw new ToolArgumentError("Workspace download parent directory must already exist.", {
        fieldPath: "/workspacePath",
      });
    }
    if (stat.isSymbolicLink() || !stat.isDirectory()) {
      throw new ToolArgumentError("Workspace download parent must be a real directory without symbolic links.", {
        fieldPath: "/workspacePath",
      });
    }
  }
}

async function assertDestinationType(destinationPath: string): Promise<Awaited<ReturnType<typeof fs.lstat>> | undefined> {
  const stat = await fileStatOrUndefined(destinationPath);
  if (stat && (stat.isSymbolicLink() || !stat.isFile())) {
    throw new ToolArgumentError("Workspace download destination must be absent or a regular file.", {
      fieldPath: "/workspacePath",
    });
  }
  return stat;
}

function splitFilename(fileName: string): { stem: string; extension: string } {
  const extension = path.extname(fileName);
  return { stem: fileName.slice(0, fileName.length - extension.length), extension };
}

async function chooseUniqueDestination(destinationPath: string): Promise<string> {
  if (!(await fileStatOrUndefined(destinationPath))) return destinationPath;
  const parent = path.dirname(destinationPath);
  const { stem, extension } = splitFilename(path.basename(destinationPath));
  for (let index = 1; index <= 10_000; index += 1) {
    const candidate = path.join(parent, `${stem} (${index})${extension}`);
    if (!(await fileStatOrUndefined(candidate))) return candidate;
  }
  throw new ToolArgumentError("Could not allocate a unique workspace download filename.", {
    fieldPath: "/workspacePath",
  });
}

function validateConditionalArguments(args: DownloadFileArgs): void {
  const target = args.target ?? "artifact";
  if (target === "workspace" && !args.workspacePath) {
    throw new ToolArgumentError("workspacePath is required when target is workspace.", {
      fieldPath: "/workspacePath",
    });
  }
  if (target === "artifact" && args.workspacePath) {
    throw new ToolArgumentError("workspacePath is only valid when target is workspace.", {
      fieldPath: "/workspacePath",
    });
  }
  if (target === "workspace" && args.outputName) {
    throw new ToolArgumentError("Use the basename of workspacePath instead of outputName for workspace downloads.", {
      fieldPath: "/outputName",
    });
  }
}

async function buildWorkspacePlan(
  args: DownloadFileArgs,
  context: ToolAccessResolutionContext,
): Promise<WorkspaceDownloadPlan> {
  validateConditionalArguments(args);
  if (/[\\/]$/u.test(args.workspacePath!)) {
    throw new ToolArgumentError("workspacePath must identify a file, not a directory.", {
      fieldPath: "/workspacePath",
    });
  }
  const requested = context.paths.normalize(args.workspacePath!);
  const requestedPath = context.paths.resolveWorkspace(requested);
  if (path.basename(requestedPath) === "." || path.basename(requestedPath) === path.parse(requestedPath).root) {
    throw new ToolArgumentError("workspacePath must identify a file.", { fieldPath: "/workspacePath" });
  }
  await assertRealWorkspaceParent(context.workspaceRoot, requestedPath);
  const existing = await assertDestinationType(requestedPath);
  const overwrite = args.overwriteStrategy ?? "error";
  if (existing && overwrite === "error") {
    throw new ToolArgumentError("Workspace download destination exists; choose replace or unique.", {
      fieldPath: "/overwriteStrategy",
    });
  }
  const destinationPath = overwrite === "unique" ? await chooseUniqueDestination(requestedPath) : requestedPath;
  const destinationRelativePath = normalizedRelativePath(path.relative(context.workspaceRoot, destinationPath));
  const safeCallId = context.callId.replace(/[^A-Za-z\d_-]/gu, "_").slice(0, 80) || "call";
  const stagedPath = path.join(
    path.dirname(destinationPath),
    `.deep-mix-download-${safeCallId}.tmp`,
  );
  const stagedRelativePath = normalizedRelativePath(path.relative(context.workspaceRoot, stagedPath));
  const backupDirectory = `${stagedPath}.backup`;
  const backupRelativePath = normalizedRelativePath(path.relative(context.workspaceRoot, backupDirectory));
  if (await fileStatOrUndefined(stagedPath)) {
    throw new ToolArgumentError("A staged workspace download already exists for this call.", {
      fieldPath: "/workspacePath",
    });
  }
  if (await fileStatOrUndefined(backupDirectory)) {
    throw new ToolArgumentError("A workspace download recovery directory already exists for this call.", {
      fieldPath: "/workspacePath",
    });
  }
  return {
    workspaceRoot: context.workspaceRoot,
    destinationRelativePath,
    stagedRelativePath,
    backupRelativePath,
    destinationPath,
    stagedPath,
    backupDirectory,
  };
}

function headerValue(headers: Record<string, string>, name: string): string | undefined {
  const target = name.toLocaleLowerCase("en-US");
  return Object.entries(headers).find(([key]) => key.toLocaleLowerCase("en-US") === target)?.[1];
}

function decodeExtendedFilename(value: string): string | undefined {
  const unquoted = value.trim().replace(/^"|"$/gu, "");
  const match = /^([^']*)'[^']*'(.*)$/u.exec(unquoted);
  const charset = (match?.[1] || "utf-8").toLocaleLowerCase("en-US");
  if (charset !== "utf-8" && charset !== "us-ascii") return undefined;
  try {
    return decodeURIComponent(match?.[2] ?? unquoted);
  } catch {
    return undefined;
  }
}

function contentDispositionFilename(value: string | undefined): string | undefined {
  if (!value) return undefined;
  const extended = /(?:^|;)\s*filename\*\s*=\s*("[^"]*"|[^;]*)/iu.exec(value)?.[1];
  if (extended) {
    const decoded = decodeExtendedFilename(extended);
    if (decoded) return decoded;
  }
  const basic = /(?:^|;)\s*filename\s*=\s*(?:"((?:\\.|[^"])*)"|([^;]*))/iu.exec(value);
  return (basic?.[1]?.replace(/\\([\\"])/gu, "$1") ?? basic?.[2])?.trim();
}

export function sanitizeDownloadFilename(value: string | undefined): string {
  let candidate = (value ?? "download").normalize("NFKC");
  candidate = candidate.replace(/[\u0000-\u001f\u007f-\u009f\u202a-\u202e\u2066-\u2069]/gu, "");
  candidate = candidate.replace(/[\\/:*?"<>|]/gu, "_").trim().replace(/[. ]+$/gu, "");
  if (!candidate || candidate === "." || candidate === "..") candidate = "download";
  if (/^(?:CON|PRN|AUX|NUL|COM[1-9]|LPT[1-9])(?:\.|$)/iu.test(candidate)) candidate = `_${candidate}`;
  if (candidate.length > MAX_FILENAME_CHARS) {
    const { stem, extension } = splitFilename(candidate);
    const boundedExtension = extension.slice(0, 24);
    candidate = `${stem.slice(0, MAX_FILENAME_CHARS - boundedExtension.length)}${boundedExtension}`;
  }
  return candidate;
}

function filenameFromUrl(value: string): string | undefined {
  try {
    const segment = new URL(value).pathname.split("/").filter(Boolean).at(-1);
    if (!segment) return undefined;
    try {
      return decodeURIComponent(segment);
    } catch {
      return segment;
    }
  } catch {
    return undefined;
  }
}

function urlSecrets(value: string): string[] {
  try {
    const url = new URL(value);
    return [...url.searchParams.entries()]
      .filter(([name]) => isSensitiveNetworkQueryName(name))
      .map(([, secret]) => secret);
  } catch {
    return [];
  }
}

function downloadRequestSecrets(args: DownloadFileArgs): string[] {
  return [
    ...urlSecrets(args.url),
    ...Object.entries(args.headers ?? {})
      .flatMap(([name, value]) => extractSensitiveNetworkHeaderValues(name, value)),
  ];
}

function resolveDownloadFilename(
  args: DownloadFileArgs,
  headers: Record<string, string>,
  finalUrl: string,
  secrets: readonly string[],
): string {
  const dispositionName = contentDispositionFilename(headerValue(headers, "content-disposition"));
  const redactedDispositionName = dispositionName
    ? redactSensitiveText(dispositionName, secrets)
    : undefined;
  return sanitizeDownloadFilename(
    (args.outputName ? redactSensitiveText(args.outputName, secrets) : undefined) ??
    redactedDispositionName ??
    filenameFromUrl(finalUrl),
  );
}

function startsWith(bytes: Buffer, signature: readonly number[]): boolean {
  return bytes.length >= signature.length && signature.every((value, index) => bytes[index] === value);
}

function detectSignature(prefix: Buffer): SignatureInfo | undefined {
  if (startsWith(prefix, [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])) return { mimeType: "image/png", family: "image" };
  if (startsWith(prefix, [0xff, 0xd8, 0xff])) return { mimeType: "image/jpeg", family: "image" };
  if (prefix.subarray(0, 6).toString("ascii") === "GIF87a" || prefix.subarray(0, 6).toString("ascii") === "GIF89a") {
    return { mimeType: "image/gif", family: "image" };
  }
  if (prefix.subarray(0, 4).toString("ascii") === "RIFF" && prefix.subarray(8, 12).toString("ascii") === "WEBP") {
    return { mimeType: "image/webp", family: "image" };
  }
  if (prefix.subarray(0, 5).toString("ascii") === "%PDF-") return { mimeType: "application/pdf", family: "document" };
  if (startsWith(prefix, [0x50, 0x4b, 0x03, 0x04]) || startsWith(prefix, [0x50, 0x4b, 0x05, 0x06])) {
    return { mimeType: "application/zip", family: "archive" };
  }
  if (startsWith(prefix, [0x1f, 0x8b])) return { mimeType: "application/gzip", family: "archive" };
  if (startsWith(prefix, [0x37, 0x7a, 0xbc, 0xaf, 0x27, 0x1c])) return { mimeType: "application/x-7z-compressed", family: "archive" };
  if (prefix.subarray(0, 4).toString("ascii") === "\u007fELF" || startsWith(prefix, [0x4d, 0x5a])) {
    return { mimeType: "application/x-executable", family: "executable" };
  }
  const text = prefix.toString("utf8").replace(/^\ufeff/u, "").trimStart().slice(0, 160).toLocaleLowerCase("en-US");
  if (/^(?:<!doctype\s+html\b|<html\b)/u.test(text)) return { mimeType: "text/html", family: "html" };
  return undefined;
}

function mimeEssence(value: string | undefined): string {
  return (value?.split(";", 1)[0]?.trim().toLocaleLowerCase("en-US") || "application/octet-stream");
}

const ZIP_COMPATIBLE_MIME_TYPES = new Set([
  "application/epub+zip",
  "application/java-archive",
  "application/vnd.ms-excel.sheet.macroenabled.12",
  "application/vnd.ms-powerpoint.presentation.macroenabled.12",
  "application/vnd.ms-word.document.macroenabled.12",
  "application/vnd.openxmlformats-officedocument.presentationml.presentation",
  "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
  "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
  "application/x-zip-compressed",
  "application/zip",
]);

const SIGNATURE_MIME_ALIASES = new Map<string, ReadonlySet<string>>([
  ["application/gzip", new Set(["application/x-gzip"])],
  ["application/pdf", new Set(["application/x-pdf"])],
  ["application/x-executable", new Set([
    "application/vnd.microsoft.portable-executable",
    "application/x-dosexec",
    "application/x-msdownload",
  ])],
  ["image/jpeg", new Set(["image/jpg", "image/pjpeg"])],
  ["image/png", new Set(["image/x-png"])],
  ["text/html", new Set(["application/xhtml+xml"])],
]);

function assertSignatureMatchesMime(prefix: Buffer, declaredValue: string | undefined): string {
  const declared = mimeEssence(declaredValue);
  const signature = detectSignature(prefix);
  if (!signature) {
    if (["application/pdf", "image/gif", "image/jpeg", "image/png", "image/webp"].includes(declared)) {
      throw new SafeNetworkError("Downloaded file signature conflicts with its declared content type.", "content_type", false);
    }
    return declared;
  }
  const generic = declared === "application/octet-stream" || declared === "binary/octet-stream";
  const compatible = declared === signature.mimeType ||
    (signature.mimeType === "application/zip" && ZIP_COMPATIBLE_MIME_TYPES.has(declared)) ||
    SIGNATURE_MIME_ALIASES.get(signature.mimeType)?.has(declared) === true;
  if (!generic && !compatible) {
    throw new SafeNetworkError("Downloaded file signature conflicts with its declared content type.", "content_type", false);
  }
  return generic ? signature.mimeType : declared;
}

class DownloadStreamSink {
  private handle: Awaited<ReturnType<typeof fs.open>> | undefined;
  private initialized = false;
  private hash = createHash("sha256");
  private chunks: Buffer[] = [];
  private prefixBytes = 0;
  private sizeBytes = 0;
  private writePosition = 0;

  public readonly consumer: ToolNetworkResponseConsumer = {
    onResponse: (head) => this.reset(head),
    onChunk: (chunk) => this.write(chunk),
  };

  public constructor(
    private readonly stagedPath: string,
    private readonly maxBytes: number,
    private readonly signal?: AbortSignal,
  ) {}

  private async reset(_head: ToolNetworkResponseHead): Promise<void> {
    throwIfAborted(this.signal);
    if (!this.handle) {
      this.handle = await fs.open(this.stagedPath, "wx+", 0o600);
    } else {
      // Keep the original exclusive file handle across route fallbacks. Reopening
      // by pathname would let a local swap redirect the second attempt.
      await this.handle.truncate(0);
    }
    this.initialized = true;
    this.hash = createHash("sha256");
    this.chunks = [];
    this.prefixBytes = 0;
    this.sizeBytes = 0;
    this.writePosition = 0;
  }

  private async write(chunk: Uint8Array): Promise<void> {
    throwIfAborted(this.signal);
    if (!this.handle) throw new Error("Download stream started before response metadata.");
    if (this.sizeBytes + chunk.byteLength > this.maxBytes) {
      throw new SafeNetworkError(`Download exceeded the ${this.maxBytes}-byte limit.`, "response_too_large", false);
    }
    const buffer = Buffer.from(chunk);
    this.hash.update(buffer);
    if (this.prefixBytes < SIGNATURE_PREFIX_BYTES) {
      const prefixChunk = buffer.subarray(0, SIGNATURE_PREFIX_BYTES - this.prefixBytes);
      this.chunks.push(Buffer.from(prefixChunk));
      this.prefixBytes += prefixChunk.byteLength;
    }
    let offset = 0;
    while (offset < buffer.byteLength) {
      const written = await this.handle.write(
        buffer,
        offset,
        buffer.byteLength - offset,
        this.writePosition,
      );
      if (written.bytesWritten <= 0) throw new Error("Download file write made no progress.");
      offset += written.bytesWritten;
      this.writePosition += written.bytesWritten;
      throwIfAborted(this.signal);
    }
    this.sizeBytes += buffer.byteLength;
  }

  public async finish(): Promise<{
    sizeBytes: number;
    sha256: string;
    prefix: Buffer;
    generation: WorkspaceFileFingerprint;
  }> {
    throwIfAborted(this.signal);
    if (!this.handle || !this.initialized) throw new Error("Download response did not produce a file stream.");
    await this.handle.sync();
    const stat = await this.handle.stat();
    if (!stat.isFile() || stat.size !== this.sizeBytes) {
      throw new Error("Downloaded staging generation changed before publication.");
    }
    const sha256 = this.hash.digest("hex");
    return {
      sizeBytes: this.sizeBytes,
      sha256,
      prefix: Buffer.concat(this.chunks),
      generation: {
        exists: true,
        device: stat.dev,
        inode: stat.ino,
        sizeBytes: stat.size,
        mode: stat.mode,
        modifiedAtMs: stat.mtimeMs,
        changedAtMs: stat.ctimeMs,
        sha256,
      },
    };
  }

  public async assertNoProtectedValues(
    secrets: readonly string[],
    expectedGeneration: WorkspaceFileFingerprint,
  ): Promise<void> {
    throwIfAborted(this.signal);
    if (!this.handle) throw new Error("Download response did not produce a file stream.");
    const patterns = [...new Set(secrets.filter(Boolean))]
      .map((secret) => Buffer.from(secret, "utf8"))
      .filter((pattern) => pattern.byteLength > 0);
    if (patterns.length === 0) return;

    const before = await this.handle.stat();
    if (
      !before.isFile() || before.dev !== expectedGeneration.device || before.ino !== expectedGeneration.inode ||
      before.size !== expectedGeneration.sizeBytes
    ) {
      throw new Error("Downloaded staging generation changed before protected-value inspection.");
    }
    const longestPattern = patterns.reduce((longest, pattern) => Math.max(longest, pattern.byteLength), 0);
    const chunkSize = Math.max(64 * 1024, longestPattern);
    const buffer = Buffer.allocUnsafe(chunkSize);
    let overlap = Buffer.alloc(0);
    let position = 0;
    for (;;) {
      throwIfAborted(this.signal);
      const { bytesRead } = await this.handle.read(buffer, 0, buffer.byteLength, position);
      if (bytesRead === 0) break;
      const window = overlap.byteLength === 0
        ? buffer.subarray(0, bytesRead)
        : Buffer.concat([overlap, buffer.subarray(0, bytesRead)]);
      for (let index = 0; index < patterns.length; index += 1) {
        if (index % 16 === 0) throwIfAborted(this.signal);
        if (window.indexOf(patterns[index]!) >= 0) {
          throw new SafeNetworkError(
            "Downloaded content reflected a protected request value.",
            "policy_denied",
            false,
          );
        }
      }
      const overlapBytes = Math.min(Math.max(0, longestPattern - 1), window.byteLength);
      overlap = overlapBytes === 0 ? Buffer.alloc(0) : Buffer.from(window.subarray(window.byteLength - overlapBytes));
      position += bytesRead;
    }
    const after = await this.handle.stat();
    if (
      before.dev !== after.dev || before.ino !== after.ino || before.size !== after.size ||
      before.mtimeMs !== after.mtimeMs || before.ctimeMs !== after.ctimeMs || position !== after.size
    ) {
      throw new Error("Downloaded staging generation changed during protected-value inspection.");
    }
  }

  public async cleanup(): Promise<void> {
    await this.handle?.close().catch(() => undefined);
    this.handle = undefined;
    await fs.rm(this.stagedPath, { force: true }).catch(() => undefined);
  }
}

async function commitWorkspaceDownload(
  plan: WorkspaceDownloadPlan,
  overwrite: DownloadOverwriteStrategy,
  baseline: WorkspaceFileFingerprint,
  expectedStage: WorkspaceFileFingerprint,
  signal?: AbortSignal,
): Promise<void> {
  throwIfAborted(signal);
  await assertRealWorkspaceParent(plan.workspaceRoot, plan.destinationPath);
  await assertDestinationType(plan.destinationPath);
  const current = await fingerprintWorkspaceFile(plan.destinationPath, signal);
  if (!sameWorkspaceFingerprint(current, baseline)) {
    throw new Error("Workspace download destination changed during the download; the concurrent file was preserved.");
  }
  if (overwrite !== "replace" || !baseline.exists) {
    if (current.exists) throw new Error("Workspace download destination exists; the concurrent file was preserved.");
    let linked = false;
    const stagedBeforeLink = await fingerprintWorkspaceFile(plan.stagedPath, signal);
    if (!sameFileGeneration(stagedBeforeLink, expectedStage)) {
      throw new Error("Workspace download staging file changed before publication.");
    }
    let linkedIdentity: PublishedPathIdentity | undefined = expectedStage.device !== undefined && expectedStage.inode !== undefined
      ? { device: expectedStage.device, inode: expectedStage.inode }
      : undefined;
    try {
      await fs.link(plan.stagedPath, plan.destinationPath);
      linked = true;
      const linkedStat = await fs.lstat(plan.destinationPath);
      if (linkedStat.dev !== linkedIdentity?.device || linkedStat.ino !== linkedIdentity?.inode) {
        const stagedNow = await fs.lstat(plan.stagedPath);
        if (stagedNow.dev === linkedStat.dev && stagedNow.ino === linkedStat.ino) {
          linkedIdentity = { device: linkedStat.dev, inode: linkedStat.ino };
        }
        throw new Error("Workspace download staging generation changed at publication.");
      }
      // The exclusive link is the commit point. Cancellation wins before it;
      // after it, validate and report the complete committed generation.
      const published = await fingerprintWorkspaceFile(plan.destinationPath);
      if (!sameFileGeneration(published, expectedStage)) {
        throw new Error("Workspace download staging file changed before publication.");
      }
    } catch (error) {
      if (linked) await removePublishedPathIfOwned(plan.destinationPath, linkedIdentity);
      throw error;
    }
    await fs.rm(plan.stagedPath, { force: true }).catch(() => undefined);
    return;
  }
  await fs.mkdir(plan.backupDirectory, { mode: 0o700 });
  const backupPath = path.join(plan.backupDirectory, "previous");
  let destinationMoved = false;
  let published: WorkspaceFileFingerprint | undefined;
  let publishedLinked = false;
  let publishedIdentity: PublishedPathIdentity | undefined = expectedStage.device !== undefined && expectedStage.inode !== undefined
    ? { device: expectedStage.device, inode: expectedStage.inode }
    : undefined;
  try {
    await fs.rename(plan.destinationPath, backupPath);
    destinationMoved = true;
    const movedBaseline = await fingerprintWorkspaceFile(backupPath, signal);
    if (!sameMovedGeneration(movedBaseline, baseline)) {
      if (!(await fileStatOrUndefined(plan.destinationPath))) {
        await fs.rename(backupPath, plan.destinationPath);
        destinationMoved = false;
      }
      throw new Error("Workspace download destination changed during replacement; the concurrent file was preserved.");
    }
    try {
      throwIfAborted(signal);
      const stagedBeforeLink = await fingerprintWorkspaceFile(plan.stagedPath, signal);
      if (!sameFileGeneration(stagedBeforeLink, expectedStage)) {
        throw new Error("Workspace download staging file changed before replacement publication.");
      }
      // The exclusive link is the commit linearization point: cancellation
      // wins before it; after it, the complete file is reported as success.
      await fs.link(plan.stagedPath, plan.destinationPath);
      publishedLinked = true;
      const linkedStat = await fs.lstat(plan.destinationPath);
      if (linkedStat.dev !== publishedIdentity?.device || linkedStat.ino !== publishedIdentity?.inode) {
        const stagedNow = await fs.lstat(plan.stagedPath);
        if (stagedNow.dev === linkedStat.dev && stagedNow.ino === linkedStat.ino) {
          publishedIdentity = { device: linkedStat.dev, inode: linkedStat.ino };
        }
        throw new Error("Workspace download staging generation changed at replacement publication.");
      }
      published = await fingerprintWorkspaceFile(plan.destinationPath);
      if (!sameFileGeneration(published, expectedStage)) {
        throw new Error("Workspace download staging file changed before replacement publication.");
      }
      const backupAfterPublish = await fingerprintWorkspaceFile(backupPath);
      if (!sameMovedGeneration(backupAfterPublish, baseline)) {
        throw new Error("Workspace download destination was modified concurrently during replacement.");
      }
    } catch (error) {
      if (publishedLinked) await removePublishedPathIfOwned(plan.destinationPath, publishedIdentity);
      if (!(await fileStatOrUndefined(plan.destinationPath)) && await fileStatOrUndefined(backupPath)) {
        await fs.rename(backupPath, plan.destinationPath);
        destinationMoved = false;
      }
      throw error;
    }
    await fs.rm(plan.stagedPath, { force: true }).catch(() => undefined);
    destinationMoved = false;
  } finally {
    if (destinationMoved && !(await fileStatOrUndefined(plan.destinationPath)) && await fileStatOrUndefined(backupPath)) {
      await fs.rename(backupPath, plan.destinationPath).catch(() => undefined);
    }
    await fs.rm(plan.backupDirectory, { recursive: true, force: true }).catch(() => undefined);
  }
}

function downloadAccessHost(url: string): string {
  return parseSafeHttpUrl(url).hostname.replace(/^\[|\]$/gu, "").toLocaleLowerCase("en-US");
}

async function resolveDownloadAccess(
  args: DownloadFileArgs,
  context: ToolAccessResolutionContext,
): Promise<ToolAccessRequest[]> {
  validateConditionalArguments(args);
  const requests: ToolAccessRequest[] = [{
    kind: "network_access",
    hosts: [downloadAccessHost(args.url)],
    reason: "Download a bounded file from the declared public network host.",
  }];
  if ((args.target ?? "artifact") === "workspace") {
    const plan = await buildWorkspacePlan(args, context);
    requests.push({
      kind: "filesystem_write",
      paths: [plan.destinationRelativePath, plan.stagedRelativePath, plan.backupRelativePath],
      reason: "Stage and exclusively publish the downloaded file inside the writable workspace sandbox.",
    });
  }
  return requests;
}

function workspacePlanFromExecutionContext(context: RuntimeToolExecutionContext): WorkspaceDownloadPlan {
  const paths = context.accessRequests.find((request) => request.kind === "filesystem_write")?.paths ?? [];
  if (paths.length !== 3) throw new Error("Workspace download is missing its guarded destination plan.");
  return {
    workspaceRoot: context.workspaceRoot,
    destinationRelativePath: paths[0]!,
    stagedRelativePath: paths[1]!,
    backupRelativePath: paths[2]!,
    destinationPath: context.moduleContext.paths.resolveWorkspace(paths[0]!),
    stagedPath: context.moduleContext.paths.resolveWorkspace(paths[1]!),
    backupDirectory: context.moduleContext.paths.resolveWorkspace(paths[2]!),
  };
}

function safeDownloadFailure(
  error: unknown,
  args: DownloadFileArgs,
  context: RuntimeToolExecutionContext,
  startedAt: string,
  completedNetworkAudit?: NetworkAuditSummary,
  completedRedactionSecrets: readonly string[] = [],
): ToolResult {
  const safeError = error instanceof SafeNetworkError ? error : undefined;
  const secrets = [...downloadRequestSecrets(args), ...completedRedactionSecrets];
  const message = redactSensitiveText((error as Error)?.message || "Download failed.", secrets);
  const structuredContent = {
    kind: "download_file_error",
    errorType: safeError?.networkErrorType ?? "download_error",
    message,
  };
  return {
    toolName: "download_file",
    callId: context.callId,
    startedAt,
    endedAt: context.moduleContext.clock.now(),
    success: false,
    output: JSON.stringify(structuredContent),
    structuredContent,
    networkAudit: safeError?.audit ?? completedNetworkAudit,
    error: message,
  };
}

async function executeDownloadFile(
  args: DownloadFileArgs,
  context: RuntimeToolExecutionContext,
): Promise<ToolResult<DownloadArtifactResult>> {
  const startedAt = context.moduleContext.clock.now();
  validateConditionalArguments(args);
  const target = args.target ?? "artifact";
  const maxBytes = args.maxBytes ?? DEFAULT_MAX_BYTES;
  const timeoutMs = args.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  const overwrite = args.overwriteStrategy ?? "error";
  const deadlineGuard = createSafeNetworkDeadline(context.signal, timeoutMs);
  const operationContext: RuntimeToolExecutionContext = { ...context, signal: deadlineGuard.signal };
  let completedNetworkAudit: NetworkAuditSummary | undefined;
  let completedRedactionSecrets: string[] = [];
  let temporaryDirectory: string | undefined;
  try {
    const workspacePlan = target === "workspace" ? workspacePlanFromExecutionContext(context) : undefined;
    let workspaceBaseline: WorkspaceFileFingerprint | undefined;
    let stagedPath: string;
    if (workspacePlan) {
      if (!context.checkpoint) {
        throw new Error("Workspace downloads require a runtime checkpoint before writing.");
      }
      const checkpointFiles = new Set(context.checkpoint.trackedFiles.map(normalizedRelativePath));
      if (
        !checkpointFiles.has(workspacePlan.destinationRelativePath) ||
        !checkpointFiles.has(workspacePlan.stagedRelativePath) ||
        !checkpointFiles.has(workspacePlan.backupRelativePath)
      ) {
        throw new Error("Workspace download checkpoint does not cover its destination and staged file.");
      }
      await assertRealWorkspaceParent(context.workspaceRoot, workspacePlan.destinationPath);
      const checkpointBaseline = await context.moduleContext.persistence.fingerprintCheckpointFile({
        checkpointId: context.checkpoint.checkpointId,
        relativePath: workspacePlan.destinationRelativePath,
        signal: operationContext.signal,
      });
      workspaceBaseline = await fingerprintWorkspaceFile(workspacePlan.destinationPath, operationContext.signal);
      if (!sameCheckpointContent(workspaceBaseline, checkpointBaseline)) {
        throw new Error("Workspace download destination changed after its checkpoint; the concurrent file was preserved.");
      }
      stagedPath = workspacePlan.stagedPath;
    } else {
      temporaryDirectory = await fs.mkdtemp(path.join(os.tmpdir(), "deep-mix-download-"));
      stagedPath = path.join(temporaryDirectory, "payload.tmp");
    }
    const sink = new DownloadStreamSink(stagedPath, maxBytes, operationContext.signal);
    try {
      throwIfAborted(operationContext.signal);
      const request = await executeSafeHttpRequest({
        network: context.moduleContext.network,
        spec: {
          method: "GET",
          url: args.url,
          headers: args.headers,
          timeoutMs,
          maxResponseBytes: maxBytes,
          maxRedirects: 5,
        },
        signal: operationContext.signal,
        budgetKey: `${context.sessionId}:${context.turnId ?? context.callId}`,
        maxToolBytes: maxBytes,
        environment: context.moduleContext.environment,
        authorizeHost: (hostname) => context.moduleContext.permissions.assertNetworkHosts([hostname]),
        finalBodyConsumer: sink.consumer,
      });
    completedNetworkAudit = request.audit;
    completedRedactionSecrets = request.redactionSecrets;
    if (!request.response.ok) {
      throw new SafeNetworkError(`Download server returned HTTP ${request.response.status}.`, "http", false, {
        httpStatus: request.response.status,
      });
    }
    const streamed = await sink.finish();
    if (streamed.sizeBytes !== request.summary.sizeBytes || streamed.sha256 !== request.summary.sha256) {
      throw new Error("Downloaded file integrity did not match the network transport summary.");
    }
    await sink.assertNoProtectedValues(completedRedactionSecrets, streamed.generation);
    const mimeType = assertSignatureMatchesMime(streamed.prefix, request.summary.contentType);
    const suggestedName = resolveDownloadFilename(
      args,
      request.response.headers,
      request.summary.finalUrl,
      completedRedactionSecrets,
    );
    const sourceUrl = redactUrl(args.url, completedRedactionSecrets);
    let result: DownloadArtifactResult;
    let artifacts: ToolOutputArtifact[] | undefined;
    if (workspacePlan) {
      throwIfAborted(operationContext.signal);
      await commitWorkspaceDownload(
        workspacePlan,
        overwrite,
        workspaceBaseline!,
        streamed.generation,
        operationContext.signal,
      );
      result = {
        fileName: path.basename(workspacePlan.destinationPath),
        mimeType,
        sizeBytes: streamed.sizeBytes,
        sha256: streamed.sha256,
        sourceUrl,
        finalUrl: request.summary.finalUrl,
        workspaceRelativePath: workspacePlan.destinationRelativePath,
      };
    } else {
      throwIfAborted(operationContext.signal);
      const artifact = await context.moduleContext.persistence.storeToolOutputArtifactFromFile({
        sessionId: context.sessionId,
        namespace: "downloads",
        turnId: context.turnId,
        toolCallId: context.callId,
        sourceToolName: "download_file",
        fileName: suggestedName,
        mimeType,
        kind: "file",
        summary: `Bounded download from ${request.summary.finalUrl}.`,
        sourcePath: stagedPath,
        maxBytes,
        expectedSizeBytes: streamed.sizeBytes,
        expectedSha256: streamed.sha256,
        signal: operationContext.signal,
      });
      artifacts = [artifact];
      result = {
        fileName: artifact.fileName,
        mimeType,
        sizeBytes: streamed.sizeBytes,
        sha256: streamed.sha256,
        sourceUrl,
        finalUrl: request.summary.finalUrl,
        artifactUri: artifact.uri,
      };
    }
    return {
      toolName: "download_file",
      callId: context.callId,
      startedAt,
      endedAt: context.moduleContext.clock.now(),
      success: true,
      output: JSON.stringify(result),
      structuredContent: result,
      artifacts,
      networkAudit: request.audit,
    };
    } catch (error) {
      let failure = error;
      if (operationContext.signal?.aborted && operationContext.signal.reason instanceof SafeNetworkError) {
        failure = operationContext.signal.reason;
      }
      return safeDownloadFailure(
        failure,
        args,
        context,
        startedAt,
        completedNetworkAudit,
        completedRedactionSecrets,
      ) as ToolResult<DownloadArtifactResult>;
    } finally {
      await sink.cleanup();
      if (temporaryDirectory) await fs.rmdir(temporaryDirectory).catch(() => undefined);
    }
  } finally {
    deadlineGuard.dispose();
  }
}

export function createDownloadFile(_context: ToolModuleContext): RuntimeToolSpec<DownloadFileArgs, DownloadArtifactResult> {
  return {
    name: "download_file",
    displayName: "Download File",
    description: "Download one bounded public HTTP(S) resource to a trusted artifact or a guarded workspace file.",
    inputSchema: {
      type: "object",
      additionalProperties: false,
      required: ["url"],
      properties: {
        url: { type: "string", minLength: 1, maxLength: 4_096 },
        target: { type: "string", enum: ["artifact", "workspace"], default: "artifact" },
        outputName: { type: "string", minLength: 1, maxLength: 500 },
        workspacePath: { type: "string", minLength: 1, maxLength: 2_000 },
        maxBytes: { type: "integer", minimum: 1, maximum: MAX_MAX_BYTES, default: DEFAULT_MAX_BYTES },
        overwriteStrategy: { type: "string", enum: ["error", "replace", "unique"], default: "error" },
        headers: {
          type: "object",
          maxProperties: 64,
          propertyNames: { minLength: 1, maxLength: 200 },
          additionalProperties: { type: "string", maxLength: 8_192 },
        },
        timeoutMs: { type: "integer", minimum: 100, maximum: 120_000, default: DEFAULT_TIMEOUT_MS },
      },
    },
    readOnly: true,
    permissionCategory: "read_only",
    sideEffectLevel: "none",
    timeoutCategory: "slow",
    groups: ["web", "research", "internet", "download"],
    selection: {
      groups: ["web", "research", "internet", "download"],
      keywords: [
        "download file",
        "download http",
        "save url",
        "save http",
        "下载文件",
        "下载链接",
        "下载 http",
        "保存网络文件",
      ],
    },
    checkpoint: {
      mode: "before_write",
      scope: "pre_tool_write",
      reason: "Before publishing a downloaded workspace file.",
      // The tool performs generation-aware failure cleanup. Generic rollback
      // could otherwise delete or overwrite a file changed concurrently.
      restoreOnFailure: false,
    },
    redactArguments: (args) => redactNetworkToolArguments(
      args as unknown as Record<string, unknown>,
      ["url", "target", "outputName", "workspacePath", "maxBytes", "overwriteStrategy", "headers", "timeoutMs"],
    ),
    resolveExecutionTimeoutMs: (args) => args.timeoutMs ?? DEFAULT_TIMEOUT_MS,
    resolvePermission: (args) => (args.target ?? "artifact") === "workspace"
      ? { permissionCategory: "write_file", sideEffectLevel: "high", readOnly: false }
      : { permissionCategory: "read_only", sideEffectLevel: "none", readOnly: true },
    resolveAccess: (args, context) => resolveDownloadAccess(args, context),
    execute: executeDownloadFile,
  };
}
