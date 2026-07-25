import { createHash, randomUUID } from "node:crypto";
import { promises as fs } from "node:fs";
import path from "node:path";
import { TextDecoder } from "node:util";

import type {
  NotebookCellSpec,
  NotebookOutputSpec,
  NotebookReadResult,
  NotebookSpec,
  StructuredDocumentWarning,
  StructuredJsonValue,
  StructuredSourceReference,
  ToolAvailability,
  ToolOutputArtifact,
  ToolResult,
  ToolStructuredError,
} from "../../../../shared-schema/src/index.js";
import { ToolArgumentError } from "../../index.js";
import type {
  RuntimeToolExecutionContext,
  RuntimeToolSpec,
  ToolModule,
  ToolModuleContext,
} from "../../tool-module.js";

import {
  cursorPropertySchema,
  notebookCellSchema,
  parseNonNegativeCursor,
  pathPropertySchema,
  structuredWarning,
} from "./contracts.js";
import { PHASE20_LIMITS } from "./format-policy.js";

const NOTEBOOK_MIME_TYPE = "application/x-ipynb+json";
const HTML_ARTIFACT_THRESHOLD_BYTES = 64 * 1024;
const MAX_METADATA_DEPTH = 32;
const MAX_METADATA_NODES = 100_000;
const MAX_WARNINGS = 200;

export interface ReadNotebookArgs {
  path: string;
  cursor?: string;
  maxCells?: number;
}

export type NotebookCellPatch = Partial<NotebookCellSpec>;

export type NotebookEditOperation =
  | { type: "insert"; index: number; cell: NotebookCellSpec }
  | { type: "update"; cellId?: string; index?: number; patch: NotebookCellPatch }
  | { type: "move"; cellId?: string; index?: number; destinationIndex: number }
  | { type: "delete"; cellId?: string; index?: number };

export interface EditNotebookArgs {
  path: string;
  outputPath?: string;
  overwrite?: boolean;
  operations: NotebookEditOperation[];
}

type NotebookFailureCode =
  | "unsupported_format"
  | "format_mismatch"
  | "notebook_too_large"
  | "notebook_invalid_or_damaged"
  | "notebook_structure_invalid"
  | "notebook_content_too_large"
  | "output_too_large"
  | "notebook_write_failed";

class NotebookError extends Error {
  constructor(readonly code: NotebookFailureCode, message: string) {
    super(message);
    this.name = "NotebookError";
  }
}

type JsonObject = Record<string, StructuredJsonValue>;

interface RawNotebook extends JsonObject {
  nbformat: StructuredJsonValue;
  nbformat_minor: StructuredJsonValue;
  metadata: StructuredJsonValue;
  cells: StructuredJsonValue;
}

interface ResolvedNotebookSource {
  absolutePath: string;
  workspaceRelativePath?: string;
  artifactRef?: string;
  readBytes(): Promise<Buffer>;
}

interface ArtifactReferenceValue {
  artifactUri: string;
  jsonPointer: string;
  mimeType: string;
  encoding?: "base64" | "utf-8";
}

function isObject(value: unknown): value is JsonObject {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function isJsonValue(value: unknown): value is StructuredJsonValue {
  if (value === null || typeof value === "string" || typeof value === "boolean") return true;
  if (typeof value === "number") return Number.isFinite(value);
  if (Array.isArray(value)) return value.every(isJsonValue);
  if (isObject(value)) return Object.values(value).every(isJsonValue);
  return false;
}

function cloneJson<T extends StructuredJsonValue>(value: T): T {
  return structuredClone(value);
}

function normalizeRelativePath(value: string): string {
  return value.replace(/\\/gu, "/");
}

function jsonPointerToken(value: string): string {
  return value.replace(/~/gu, "~0").replace(/\//gu, "~1");
}

function textField(value: StructuredJsonValue | undefined, field: string, maximum = PHASE20_LIMITS.notebook.maxSourceChars): string {
  if (typeof value === "string") {
    if (value.length > maximum) throw new NotebookError("notebook_content_too_large", `${field} exceeds the ${maximum}-character limit.`);
    return value;
  }
  if (Array.isArray(value) && value.every((part) => typeof part === "string")) {
    const combined = (value as string[]).join("");
    if (combined.length > maximum) throw new NotebookError("notebook_content_too_large", `${field} exceeds the ${maximum}-character limit.`);
    return combined;
  }
  throw new NotebookError("notebook_structure_invalid", `${field} must be a string or an array of strings.`);
}

function validateJsonTree(value: StructuredJsonValue, field: string): void {
  let nodes = 0;
  const visit = (current: StructuredJsonValue, depth: number): void => {
    nodes += 1;
    if (nodes > MAX_METADATA_NODES) throw new NotebookError("notebook_content_too_large", `${field} contains too many JSON values.`);
    if (depth > MAX_METADATA_DEPTH) throw new NotebookError("notebook_structure_invalid", `${field} exceeds the maximum JSON nesting depth.`);
    if (Array.isArray(current)) {
      current.forEach((entry) => visit(entry, depth + 1));
    } else if (isObject(current)) {
      if (Object.keys(current).length > 2_000) throw new NotebookError("notebook_structure_invalid", `${field} contains too many object properties.`);
      Object.values(current).forEach((entry) => visit(entry, depth + 1));
    }
  };
  visit(value, 0);
}

function metadataObject(value: StructuredJsonValue | undefined, field: string): JsonObject {
  if (!isObject(value)) throw new NotebookError("notebook_structure_invalid", `${field} must be a JSON object.`);
  validateJsonTree(value, field);
  return value;
}

function validateId(id: StructuredJsonValue | undefined, field: string, required: boolean): string | undefined {
  if (id === undefined && !required) return undefined;
  if (typeof id !== "string" || id.length < 1 || id.length > 255 || /[\u0000-\u001f\u007f]/u.test(id)) {
    throw new NotebookError("notebook_structure_invalid", `${field} must be a non-empty bounded string.`);
  }
  return id;
}

function validateExecutionCount(value: StructuredJsonValue | undefined, field: string): number | null {
  if (value === null) return null;
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value < 0) {
    throw new NotebookError("notebook_structure_invalid", `${field} must be a non-negative integer or null.`);
  }
  return value;
}

function normalizeOutput(raw: StructuredJsonValue, field: string): NotebookOutputSpec {
  if (!isObject(raw)) throw new NotebookError("notebook_structure_invalid", `${field} must be an object.`);
  const outputType = raw.output_type;
  if (outputType === "stream") {
    if (raw.name !== "stdout" && raw.name !== "stderr") throw new NotebookError("notebook_structure_invalid", `${field}.name must be stdout or stderr.`);
    return { outputType, name: raw.name, text: textField(raw.text, `${field}.text`) };
  }
  if (outputType === "display_data" || outputType === "execute_result") {
    const data = metadataObject(raw.data, `${field}.data`);
    const metadata = metadataObject(raw.metadata, `${field}.metadata`);
    if (outputType === "display_data") return { outputType, data: cloneJson(data), metadata: cloneJson(metadata) };
    return {
      outputType,
      executionCount: validateExecutionCount(raw.execution_count, `${field}.execution_count`),
      data: cloneJson(data),
      metadata: cloneJson(metadata),
    };
  }
  if (outputType === "error") {
    if (typeof raw.ename !== "string" || typeof raw.evalue !== "string") {
      throw new NotebookError("notebook_structure_invalid", `${field} error fields must be strings.`);
    }
    if (!Array.isArray(raw.traceback) || !raw.traceback.every((entry) => typeof entry === "string")) {
      throw new NotebookError("notebook_structure_invalid", `${field}.traceback must be an array of strings.`);
    }
    return { outputType, errorName: raw.ename, errorValue: raw.evalue, traceback: [...raw.traceback] as string[] };
  }
  throw new NotebookError("notebook_structure_invalid", `${field}.output_type is unsupported or missing.`);
}

function normalizeCell(raw: StructuredJsonValue, index: number, nbformatMinor: number): NotebookCellSpec {
  const field = `cells[${index}]`;
  if (!isObject(raw)) throw new NotebookError("notebook_structure_invalid", `${field} must be an object.`);
  const cellType = raw.cell_type;
  if (cellType !== "markdown" && cellType !== "code" && cellType !== "raw") {
    throw new NotebookError("notebook_structure_invalid", `${field}.cell_type must be markdown, code, or raw.`);
  }
  const normalized: NotebookCellSpec = {
    id: validateId(raw.id, `${field}.id`, nbformatMinor >= 5),
    cellType,
    source: textField(raw.source, `${field}.source`),
    metadata: cloneJson(metadataObject(raw.metadata, `${field}.metadata`)),
  };
  if (!normalized.id) delete normalized.id;
  if (cellType === "code") {
    normalized.executionCount = validateExecutionCount(raw.execution_count, `${field}.execution_count`);
    if (!Array.isArray(raw.outputs) || raw.outputs.length > 10_000) {
      throw new NotebookError("notebook_structure_invalid", `${field}.outputs must be a bounded array.`);
    }
    normalized.outputs = raw.outputs.map((output, outputIndex) => normalizeOutput(output, `${field}.outputs[${outputIndex}]`));
  } else if (raw.outputs !== undefined || raw.execution_count !== undefined) {
    throw new NotebookError("notebook_structure_invalid", `${field} non-code cells cannot contain outputs or execution_count.`);
  }
  return normalized;
}

function validateRawNotebook(value: unknown): { raw: RawNotebook; notebook: NotebookSpec } {
  if (!isJsonValue(value) || !isObject(value)) throw new NotebookError("notebook_structure_invalid", "Notebook root must be a JSON object.");
  const raw = value as RawNotebook;
  if (raw.nbformat !== 4) throw new NotebookError("unsupported_format", "Only nbformat 4 notebooks are supported.");
  if (typeof raw.nbformat_minor !== "number" || !Number.isSafeInteger(raw.nbformat_minor) || raw.nbformat_minor < 0 || raw.nbformat_minor > 99) {
    throw new NotebookError("notebook_structure_invalid", "nbformat_minor must be an integer between 0 and 99.");
  }
  if (!Array.isArray(raw.cells)) throw new NotebookError("notebook_structure_invalid", "Notebook cells must be an array.");
  if (raw.cells.length > PHASE20_LIMITS.notebook.maxCells) {
    throw new NotebookError("notebook_content_too_large", `Notebook exceeds the ${PHASE20_LIMITS.notebook.maxCells}-cell safety limit.`);
  }
  const metadata = cloneJson(metadataObject(raw.metadata, "metadata"));
  const cells = raw.cells.map((cell, index) => normalizeCell(cell, index, raw.nbformat_minor as number));
  const ids = new Set<string>();
  for (const cell of cells) {
    if (!cell.id) continue;
    if (ids.has(cell.id)) throw new NotebookError("notebook_structure_invalid", `Notebook cell id '${cell.id}' is duplicated.`);
    ids.add(cell.id);
  }
  return {
    raw,
    notebook: { nbformat: 4, nbformatMinor: raw.nbformat_minor as number, metadata, cells },
  };
}

function parseNotebook(bytes: Buffer): { raw: RawNotebook; notebook: NotebookSpec } {
  let text: string;
  try {
    text = new TextDecoder("utf-8", { fatal: true }).decode(bytes);
  } catch {
    throw new NotebookError("notebook_invalid_or_damaged", "Notebook is not valid UTF-8 JSON.");
  }
  if (text.charCodeAt(0) === 0xfeff) text = text.slice(1);
  let value: unknown;
  try {
    value = JSON.parse(text) as unknown;
  } catch (error) {
    throw new NotebookError("notebook_invalid_or_damaged", `Notebook JSON is invalid or damaged: ${(error as Error).message}`);
  }
  return validateRawNotebook(value);
}

function sensitiveMetadataKey(key: string): boolean {
  return /(?:api[_-]?key|access[_-]?key|token|password|passwd|secret|credential|authorization|cookie|gps|latitude|longitude)/iu.test(key);
}

function redactMetadata(value: StructuredJsonValue): { value: StructuredJsonValue; redacted: boolean } {
  let redacted = false;
  const visit = (current: StructuredJsonValue): StructuredJsonValue => {
    if (Array.isArray(current)) return current.map(visit);
    if (!isObject(current)) return current;
    const output: JsonObject = {};
    for (const [key, child] of Object.entries(current)) {
      if (sensitiveMetadataKey(key)) {
        output[key] = "[REDACTED]";
        redacted = true;
      } else {
        output[key] = visit(child);
      }
    }
    return output;
  };
  return { value: visit(value), redacted };
}

function sourceReference(argsPath: string, resolved: ResolvedNotebookSource, sizeBytes: number): StructuredSourceReference {
  if (resolved.artifactRef) {
    return {
      kind: "artifact",
      reference: resolved.artifactRef,
      artifactUri: resolved.artifactRef,
      mimeType: NOTEBOOK_MIME_TYPE,
      sizeBytes,
    };
  }
  const reference = resolved.workspaceRelativePath ?? argsPath;
  return {
    kind: argsPath.startsWith("attachment://") ? "attachment" : "workspace_path",
    reference,
    workspaceRelativePath: resolved.workspaceRelativePath,
    mimeType: NOTEBOOK_MIME_TYPE,
    sizeBytes,
  };
}

function sourceArtifactUri(argsPath: string, resolved: ResolvedNotebookSource): string {
  if (resolved.artifactRef) return resolved.artifactRef;
  if (resolved.workspaceRelativePath) return `file://${normalizeRelativePath(resolved.workspaceRelativePath)}`;
  return argsPath;
}

function sourceArtifact(
  argsPath: string,
  resolved: ResolvedNotebookSource,
  bytes: Buffer,
  context: RuntimeToolExecutionContext,
): ToolOutputArtifact {
  return {
    uri: sourceArtifactUri(argsPath, resolved),
    fileName: path.basename(resolved.absolutePath),
    mimeType: NOTEBOOK_MIME_TYPE,
    sizeBytes: bytes.byteLength,
    sha256: createHash("sha256").update(bytes).digest("hex"),
    kind: "document",
    sourceToolName: "read_notebook",
    summary: "Original nbformat 4 notebook retained as the bounded artifact source for paginated or non-inline outputs; no cell was executed.",
    createdAt: context.moduleContext.clock.now(),
    workspaceRelativePath: resolved.workspaceRelativePath,
  };
}

function joinedString(value: StructuredJsonValue): string | undefined {
  if (typeof value === "string") return value;
  if (Array.isArray(value) && value.every((part) => typeof part === "string")) return (value as string[]).join("");
  return undefined;
}

function validateImageMimePayload(mimeType: string, value: string): void {
  if (mimeType.toLowerCase() === "image/svg+xml") {
    if (Buffer.byteLength(value, "utf8") > PHASE20_LIMITS.notebook.maxSingleOutputArtifactBytes) {
      throw new NotebookError("notebook_content_too_large", "Notebook SVG output exceeds the single-output artifact limit.");
    }
    return;
  }
  const compact = value.replace(/[\t\n\r ]/gu, "");
  if (!/^[A-Za-z0-9+/]*={0,2}$/u.test(compact) || compact.length % 4 === 1) {
    throw new NotebookError("notebook_structure_invalid", `Notebook MIME output '${mimeType}' is not strict base64.`);
  }
  const firstPadding = compact.indexOf("=");
  if (firstPadding >= 0 && firstPadding < compact.length - 2) {
    throw new NotebookError("notebook_structure_invalid", `Notebook MIME output '${mimeType}' has invalid base64 padding.`);
  }
  const padded = compact.padEnd(compact.length + ((4 - (compact.length % 4)) % 4), "=");
  const decoded = Buffer.from(padded, "base64");
  if (decoded.toString("base64").replace(/=+$/u, "") !== compact.replace(/=+$/u, "")) {
    throw new NotebookError("notebook_structure_invalid", `Notebook MIME output '${mimeType}' is not canonical base64.`);
  }
  if (decoded.byteLength > PHASE20_LIMITS.notebook.maxSingleOutputArtifactBytes) {
    throw new NotebookError("notebook_content_too_large", `Notebook MIME output '${mimeType}' exceeds the single-output artifact limit.`);
  }
}

function artifactizeMimeBundle(
  output: NotebookOutputSpec,
  cellIndex: number,
  outputIndex: number,
  artifactUri: string,
): { output: NotebookOutputSpec; artifactized: boolean } {
  if (output.outputType !== "display_data" && output.outputType !== "execute_result") return { output, artifactized: false };
  let artifactized = false;
  const data: Record<string, StructuredJsonValue> = {};
  for (const [mimeType, value] of Object.entries(output.data)) {
    const joined = joinedString(value);
    const isImage = /^image\//iu.test(mimeType);
    const isLargeHtml = mimeType.toLowerCase() === "text/html"
      && joined !== undefined
      && Buffer.byteLength(joined, "utf8") > HTML_ARTIFACT_THRESHOLD_BYTES;
    if (isImage || isLargeHtml) {
      if (joined === undefined) throw new NotebookError("notebook_structure_invalid", `Notebook MIME value '${mimeType}' must be a string or string array.`);
      if (isImage) validateImageMimePayload(mimeType, joined);
      if (!isImage && Buffer.byteLength(joined, "utf8") > PHASE20_LIMITS.notebook.maxSingleOutputArtifactBytes) {
        throw new NotebookError("notebook_content_too_large", `Notebook MIME output '${mimeType}' exceeds the single-output artifact limit.`);
      }
      const reference: ArtifactReferenceValue = {
        artifactUri,
        jsonPointer: `/cells/${cellIndex}/outputs/${outputIndex}/data/${jsonPointerToken(mimeType)}`,
        mimeType,
        encoding: isImage && mimeType.toLowerCase() !== "image/svg+xml" ? "base64" : "utf-8",
      };
      data[mimeType] = reference as unknown as StructuredJsonValue;
      artifactized = true;
    } else {
      data[mimeType] = cloneJson(value);
    }
  }
  return { output: { ...output, data }, artifactized };
}

function visibleCell(
  cell: NotebookCellSpec,
  absoluteCellIndex: number,
  artifactUri: string,
): { cell: NotebookCellSpec; redacted: boolean; artifactized: boolean } {
  const metadata = redactMetadata(cell.metadata);
  let redacted = metadata.redacted;
  let artifactized = false;
  const outputs = cell.outputs?.map((output, outputIndex) => {
    let visible = cloneJson(output as unknown as StructuredJsonValue) as unknown as NotebookOutputSpec;
    if (visible.outputType === "display_data" || visible.outputType === "execute_result") {
      const outputMetadata = redactMetadata(visible.metadata);
      visible = { ...visible, metadata: outputMetadata.value as Record<string, StructuredJsonValue> };
      redacted ||= outputMetadata.redacted;
    }
    const artifactResult = artifactizeMimeBundle(visible, absoluteCellIndex, outputIndex, artifactUri);
    artifactized ||= artifactResult.artifactized;
    return artifactResult.output;
  });
  return {
    cell: { ...cell, metadata: metadata.value as Record<string, StructuredJsonValue>, ...(outputs ? { outputs } : {}) },
    redacted,
    artifactized,
  };
}

function pushWarning(warnings: StructuredDocumentWarning[], warning: StructuredDocumentWarning): void {
  if (warnings.length >= MAX_WARNINGS) return;
  if (!warnings.some((current) => current.code === warning.code && current.scope === warning.scope && current.message === warning.message)) {
    warnings.push(warning);
  }
}

function failureResult(
  toolName: "read_notebook" | "edit_notebook",
  code: NotebookFailureCode,
  message: string,
  context: RuntimeToolExecutionContext,
): ToolResult {
  const timestamp = context.moduleContext.clock.now();
  const error: ToolStructuredError = {
    type: "command_failed",
    message,
    retryable: false,
    toolName,
  };
  const body = { kind: "notebook_error", format: "ipynb", code, error };
  return {
    toolName,
    callId: context.callId,
    startedAt: timestamp,
    endedAt: timestamp,
    success: false,
    output: JSON.stringify(body),
    structuredContent: body,
    error: message,
  };
}

function notebookFailure(error: unknown): NotebookError {
  if (error instanceof NotebookError) return error;
  return new NotebookError("notebook_invalid_or_damaged", `Notebook could not be read: ${(error as Error).message}`);
}

export async function readNotebookAvailability(_context: ToolModuleContext): Promise<ToolAvailability> {
  return { status: "available", available: true };
}

export async function editNotebookAvailability(_context: ToolModuleContext): Promise<ToolAvailability> {
  return { status: "available", available: true };
}

export async function executeReadNotebook(
  args: ReadNotebookArgs,
  context: RuntimeToolExecutionContext,
): Promise<ToolResult> {
  let cursor: number;
  try {
    cursor = parseNonNegativeCursor(args.cursor);
  } catch (error) {
    throw new ToolArgumentError((error as Error).message, { fieldPath: "/cursor" });
  }
  const maxCells = args.maxCells ?? PHASE20_LIMITS.notebook.defaultPageCells;
  const resolved = await context.moduleContext.paths.resolveReadable(args.path) as ResolvedNotebookSource;
  let stat: Awaited<ReturnType<typeof fs.stat>>;
  try {
    stat = await fs.stat(resolved.absolutePath);
  } catch (error) {
    return failureResult("read_notebook", "notebook_invalid_or_damaged", `Notebook input could not be inspected: ${(error as Error).message}`, context);
  }
  if (!stat.isFile()) return failureResult("read_notebook", "format_mismatch", "Notebook input must resolve to a regular file.", context);
  if (path.extname(resolved.absolutePath).toLowerCase() !== ".ipynb") {
    return failureResult("read_notebook", "unsupported_format", "read_notebook accepts .ipynb files only.", context);
  }
  if (stat.size > PHASE20_LIMITS.notebook.maxInputBytes) {
    return failureResult("read_notebook", "notebook_too_large", `Notebook exceeds the ${PHASE20_LIMITS.notebook.maxInputBytes / 1024 / 1024} MiB input limit.`, context);
  }
  try {
    const bytes = await resolved.readBytes();
    if (bytes.byteLength > PHASE20_LIMITS.notebook.maxInputBytes) {
      throw new NotebookError("notebook_too_large", `Notebook exceeds the ${PHASE20_LIMITS.notebook.maxInputBytes / 1024 / 1024} MiB input limit.`);
    }
    const parsed = parseNotebook(bytes);
    if (cursor > parsed.notebook.cells.length) {
      throw new ToolArgumentError("Cursor is beyond the notebook cell count.", { fieldPath: "/cursor" });
    }
    const end = Math.min(parsed.notebook.cells.length, cursor + maxCells);
    const artifact = sourceArtifact(args.path, resolved, bytes, context);
    const warnings: StructuredDocumentWarning[] = [];
    const notebookMetadata = redactMetadata(parsed.notebook.metadata);
    if (notebookMetadata.redacted) {
      pushWarning(warnings, structuredWarning("metadata_redacted", {
        category: "security",
        message: "Potentially sensitive notebook metadata keys were redacted from model-visible output; the source remains unchanged.",
      }));
    }
    let artifactized = false;
    const pageCells = parsed.notebook.cells.slice(cursor, end).map((cell, offset) => {
      const visible = visibleCell(cell, cursor + offset, artifact.uri);
      if (visible.redacted) {
        pushWarning(warnings, structuredWarning("metadata_redacted", {
          category: "security",
          scope: cell.id ?? `cell:${cursor + offset}`,
          message: "Potentially sensitive cell or output metadata was redacted from model-visible output; the source remains unchanged.",
        }));
      }
      artifactized ||= visible.artifactized;
      return visible.cell;
    });
    const truncated = end < parsed.notebook.cells.length;
    if (artifactized) {
      pushWarning(warnings, structuredWarning("notebook_output_artifact", {
        category: "content",
        message: "Binary image outputs and large HTML outputs are referenced by JSON pointer in the source notebook artifact, not placed inline in model history.",
      }));
    }
    if (truncated) {
      pushWarning(warnings, structuredWarning("output_truncated", {
        category: "truncation",
        message: "Notebook cells were paginated; use nextCursor to continue reading complete cells and outputs.",
      }));
    }
    const result: NotebookReadResult = {
      format: "ipynb",
      source: sourceReference(args.path, resolved, bytes.byteLength),
      metadata: {
        formatVersion: `4.${parsed.notebook.nbformatMinor}`,
        sizeBytes: bytes.byteLength,
        properties: notebookMetadata.value as Record<string, StructuredJsonValue>,
      },
      warnings,
      truncation: {
        truncated,
        reason: truncated ? "pagination" : undefined,
        returnedItems: pageCells.length,
        totalItems: parsed.notebook.cells.length,
        nextCursor: truncated ? String(end) : undefined,
      },
      summary: `nbformat 4.${parsed.notebook.nbformatMinor} notebook with ${parsed.notebook.cells.length} cells; no cell, kernel, or code was executed.`,
      notebook: {
        nbformat: 4,
        nbformatMinor: parsed.notebook.nbformatMinor,
        metadata: notebookMetadata.value as Record<string, StructuredJsonValue>,
        cells: pageCells,
      },
      totalCells: parsed.notebook.cells.length,
      returnedCells: pageCells.length,
    };
    const serialized = JSON.stringify(result);
    if (serialized.length > PHASE20_LIMITS.notebook.maxVisibleOutputChars) {
      throw new NotebookError("notebook_content_too_large", "Requested notebook page exceeds the model-visible output character limit; request fewer cells.");
    }
    const timestamp = context.moduleContext.clock.now();
    return {
      toolName: "read_notebook",
      callId: context.callId,
      startedAt: timestamp,
      endedAt: timestamp,
      success: true,
      output: serialized,
      structuredContent: result,
      artifacts: artifactized || truncated ? [artifact] : [],
    };
  } catch (error) {
    if (error instanceof ToolArgumentError) throw error;
    const failure = notebookFailure(error);
    return failureResult("read_notebook", failure.code, failure.message, context);
  }
}

function rawOutput(output: NotebookOutputSpec): JsonObject {
  if (output.outputType === "stream") {
    return { output_type: "stream", name: output.name, text: output.text };
  }
  if (output.outputType === "display_data") {
    return { output_type: "display_data", data: cloneJson(output.data), metadata: cloneJson(output.metadata) };
  }
  if (output.outputType === "execute_result") {
    return {
      output_type: "execute_result",
      execution_count: output.executionCount,
      data: cloneJson(output.data),
      metadata: cloneJson(output.metadata),
    };
  }
  return {
    output_type: "error",
    ename: output.errorName,
    evalue: output.errorValue,
    traceback: [...output.traceback],
  };
}

function rawCell(cell: NotebookCellSpec, nbformatMinor: number): JsonObject {
  const id = cell.id ?? (nbformatMinor >= 5 ? randomUUID().replace(/-/gu, "").slice(0, 8) : undefined);
  const raw: JsonObject = {
    cell_type: cell.cellType,
    metadata: cloneJson(cell.metadata),
    source: cell.source,
  };
  if (id) raw.id = id;
  if (cell.cellType === "code") {
    raw.execution_count = cell.executionCount ?? null;
    raw.outputs = (cell.outputs ?? []).map(rawOutput);
  } else if (cell.executionCount !== undefined || cell.outputs !== undefined) {
    throw new ToolArgumentError("Non-code cells cannot define executionCount or outputs.", { fieldPath: "/operations" });
  }
  normalizeCell(raw, 0, nbformatMinor);
  return raw;
}

function selectorIndex(cells: StructuredJsonValue[], operation: { cellId?: string; index?: number }, operationIndex: number): number {
  const hasId = operation.cellId !== undefined;
  const hasIndex = operation.index !== undefined;
  if (hasId === hasIndex) {
    throw new ToolArgumentError("Edit operations must select a cell by exactly one of cellId or index.", { fieldPath: `/operations/${operationIndex}` });
  }
  if (hasIndex) {
    const index = operation.index as number;
    if (!Number.isSafeInteger(index) || index < 0 || index >= cells.length) {
      throw new ToolArgumentError("Cell index is outside the current notebook range.", { fieldPath: `/operations/${operationIndex}/index` });
    }
    return index;
  }
  const index = cells.findIndex((candidate) => isObject(candidate) && candidate.id === operation.cellId);
  if (index < 0) throw new ToolArgumentError(`Cell id '${operation.cellId}' was not found.`, { fieldPath: `/operations/${operationIndex}/cellId` });
  return index;
}

function applyPatch(raw: JsonObject, patch: NotebookCellPatch, nbformatMinor: number): JsonObject {
  const next = cloneJson(raw);
  if (patch.id !== undefined) next.id = patch.id;
  if (patch.cellType !== undefined) next.cell_type = patch.cellType;
  if (patch.source !== undefined) next.source = patch.source;
  if (patch.metadata !== undefined) next.metadata = cloneJson(patch.metadata);
  const cellType = next.cell_type;
  if (cellType === "code") {
    if (patch.executionCount !== undefined) next.execution_count = patch.executionCount;
    else if (!("execution_count" in next)) next.execution_count = null;
    if (patch.outputs !== undefined) next.outputs = patch.outputs.map(rawOutput);
    else if (!("outputs" in next)) next.outputs = [];
  } else {
    delete next.execution_count;
    delete next.outputs;
    if (patch.executionCount !== undefined || patch.outputs !== undefined) {
      throw new ToolArgumentError("Non-code cells cannot define executionCount or outputs.", { fieldPath: "/operations" });
    }
  }
  normalizeCell(next, 0, nbformatMinor);
  return next;
}

function applyOperations(raw: RawNotebook, operations: NotebookEditOperation[]): RawNotebook {
  const next = cloneJson(raw) as RawNotebook;
  if (!Array.isArray(next.cells)) throw new NotebookError("notebook_structure_invalid", "Notebook cells must be an array.");
  const cells = next.cells;
  const minor = next.nbformat_minor as number;
  operations.forEach((operation, operationIndex) => {
    if (operation.type === "insert") {
      if (!Number.isSafeInteger(operation.index) || operation.index < 0 || operation.index > cells.length) {
        throw new ToolArgumentError("Insert index must be within the current notebook boundary.", { fieldPath: `/operations/${operationIndex}/index` });
      }
      if (cells.length >= PHASE20_LIMITS.notebook.maxCells) {
        throw new ToolArgumentError(`Notebook cannot exceed ${PHASE20_LIMITS.notebook.maxCells} cells.`, { fieldPath: `/operations/${operationIndex}` });
      }
      cells.splice(operation.index, 0, rawCell(operation.cell, minor));
      return;
    }
    const currentIndex = selectorIndex(cells, operation, operationIndex);
    if (operation.type === "delete") {
      cells.splice(currentIndex, 1);
      return;
    }
    if (operation.type === "move") {
      const [cell] = cells.splice(currentIndex, 1);
      if (!Number.isSafeInteger(operation.destinationIndex) || operation.destinationIndex < 0 || operation.destinationIndex > cells.length) {
        throw new ToolArgumentError("destinationIndex must be within the resulting notebook boundary.", { fieldPath: `/operations/${operationIndex}/destinationIndex` });
      }
      cells.splice(operation.destinationIndex, 0, cell as StructuredJsonValue);
      return;
    }
    const current = cells[currentIndex];
    if (!isObject(current)) throw new NotebookError("notebook_structure_invalid", "Selected cell is not an object.");
    cells[currentIndex] = applyPatch(current, operation.patch, minor);
  });
  validateRawNotebook(next);
  return next;
}

function throwIfAborted(signal: AbortSignal | undefined): void {
  if (!signal?.aborted) return;
  if (signal.reason instanceof Error) throw signal.reason;
  throw new Error(typeof signal.reason === "string" ? signal.reason : "Notebook edit was aborted.");
}

async function publishBufferAtomic(
  absolutePath: string,
  content: Buffer,
  overwrite: boolean,
  signal?: AbortSignal,
): Promise<void> {
  throwIfAborted(signal);
  await fs.mkdir(path.dirname(absolutePath), { recursive: true });
  const temporaryPath = path.join(path.dirname(absolutePath), `.${path.basename(absolutePath)}.${process.pid}.${randomUUID()}.deep-mix.tmp`);
  const backupPath = `${absolutePath}.${process.pid}.${randomUUID()}.deep-mix.bak`;
  let backupCreated = false;
  try {
    const handle = await fs.open(temporaryPath, "wx", 0o666);
    try {
      await handle.writeFile(content);
      await handle.sync();
    } finally {
      await handle.close();
    }
    throwIfAborted(signal);
    if (!overwrite) {
      try {
        await fs.link(temporaryPath, absolutePath);
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code === "EEXIST") {
          throw new ToolArgumentError("Output already exists; set overwrite=true to replace it.", { fieldPath: "/overwrite" });
        }
        throw error;
      }
      return;
    }
    if (process.platform !== "win32") {
      await fs.rename(temporaryPath, absolutePath);
      return;
    }
    try {
      await fs.rename(temporaryPath, absolutePath);
      return;
    } catch (error) {
      if (!["EACCES", "EBUSY", "EEXIST", "EPERM"].includes((error as NodeJS.ErrnoException).code ?? "")) throw error;
    }
    try {
      await fs.rename(absolutePath, backupPath);
      backupCreated = true;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    }
    try {
      await fs.rename(temporaryPath, absolutePath);
      if (backupCreated) await fs.rm(backupPath, { force: true });
      backupCreated = false;
    } catch (error) {
      if (backupCreated) await fs.rename(backupPath, absolutePath).catch(() => undefined);
      backupCreated = false;
      throw error;
    }
  } finally {
    await fs.rm(temporaryPath, { force: true }).catch(() => undefined);
    if (backupCreated) await fs.rename(backupPath, absolutePath).catch(() => undefined);
  }
}

function writeArtifact(relativePath: string, absolutePath: string, content: Buffer, context: RuntimeToolExecutionContext): ToolOutputArtifact {
  return {
    uri: `file://${relativePath}`,
    fileName: path.basename(absolutePath),
    mimeType: NOTEBOOK_MIME_TYPE,
    sizeBytes: content.byteLength,
    sha256: createHash("sha256").update(content).digest("hex"),
    kind: "document",
    sourceToolName: "edit_notebook",
    summary: "Edited nbformat 4 notebook structure; no cell, kernel, installer, remote Jupyter connection, or arbitrary code was invoked.",
    createdAt: context.moduleContext.clock.now(),
    workspaceRelativePath: relativePath,
  };
}

export async function executeEditNotebook(
  args: EditNotebookArgs,
  context: RuntimeToolExecutionContext,
): Promise<ToolResult> {
  if (!context.checkpoint) {
    return failureResult("edit_notebook", "notebook_write_failed", "The runtime did not create the required pre-write checkpoint.", context);
  }
  const resolved = await context.moduleContext.paths.resolveReadable(args.path) as ResolvedNotebookSource;
  if (path.extname(resolved.absolutePath).toLowerCase() !== ".ipynb") {
    throw new ToolArgumentError("edit_notebook path must identify an .ipynb file.", { fieldPath: "/path" });
  }
  const outputPath = args.outputPath ?? args.path;
  if (!args.outputPath && (args.path.includes("://") || !resolved.workspaceRelativePath)) {
    throw new ToolArgumentError("Editing an artifact or attachment requires an explicit workspace outputPath.", { fieldPath: "/outputPath" });
  }
  if (path.extname(outputPath).toLowerCase() !== ".ipynb") {
    throw new ToolArgumentError("edit_notebook outputPath must end with .ipynb.", { fieldPath: "/outputPath" });
  }
  const absoluteOutput = context.moduleContext.paths.resolveWorkspace(outputPath);
  const samePath = path.resolve(absoluteOutput) === path.resolve(resolved.absolutePath);
  try {
    const inputStat = await fs.stat(resolved.absolutePath);
    if (!inputStat.isFile()) throw new ToolArgumentError("edit_notebook path must identify a regular file.", { fieldPath: "/path" });
    if (inputStat.size > PHASE20_LIMITS.notebook.maxInputBytes) {
      return failureResult("edit_notebook", "notebook_too_large", `Notebook exceeds the ${PHASE20_LIMITS.notebook.maxInputBytes / 1024 / 1024} MiB input limit.`, context);
    }
    if (!samePath) {
      try {
        const outputStat = await fs.stat(absoluteOutput);
        if (!outputStat.isFile()) throw new ToolArgumentError("edit_notebook outputPath must identify a regular file.", { fieldPath: "/outputPath" });
        if (!args.overwrite) throw new ToolArgumentError("Output already exists; set overwrite=true to replace it.", { fieldPath: "/overwrite" });
      } catch (error) {
        if (error instanceof ToolArgumentError) throw error;
        if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
      }
    }
    const bytes = await resolved.readBytes();
    if (bytes.byteLength > PHASE20_LIMITS.notebook.maxInputBytes) {
      return failureResult(
        "edit_notebook",
        "notebook_too_large",
        `Notebook exceeds the ${PHASE20_LIMITS.notebook.maxInputBytes / 1024 / 1024} MiB input limit.`,
        context,
      );
    }
    const parsed = parseNotebook(bytes);
    const edited = applyOperations(parsed.raw, args.operations);
    const output = Buffer.from(`${JSON.stringify(edited, null, 2)}\n`, "utf8");
    if (output.byteLength > PHASE20_LIMITS.notebook.maxOutputBytes) {
      return failureResult("edit_notebook", "output_too_large", `Edited notebook exceeds the ${PHASE20_LIMITS.notebook.maxOutputBytes / 1024 / 1024} MiB output limit.`, context);
    }
    await publishBufferAtomic(absoluteOutput, output, samePath || Boolean(args.overwrite), context.signal);
    const relativePath = normalizeRelativePath(path.relative(context.workspaceRoot, absoluteOutput));
    const artifact = writeArtifact(relativePath, absoluteOutput, output, context);
    const structured = {
      format: "ipynb" as const,
      outputPath: relativePath,
      sizeBytes: output.byteLength,
      artifact,
      warnings: [structuredWarning("unsupported_capability", {
        severity: "info",
        category: "unsupported_capability",
        message: "Notebook editing changed JSON cell structure only; cells were not executed and no kernel, package, network, or remote Jupyter action occurred.",
      })],
      checkpointId: context.checkpoint.checkpointId,
      undoAvailable: true,
    };
    const timestamp = context.moduleContext.clock.now();
    return {
      toolName: "edit_notebook",
      callId: context.callId,
      startedAt: timestamp,
      endedAt: timestamp,
      success: true,
      output: JSON.stringify(structured),
      structuredContent: structured,
      artifacts: [artifact],
    };
  } catch (error) {
    if (error instanceof ToolArgumentError) throw error;
    const failure = error instanceof NotebookError
      ? error
      : new NotebookError("notebook_write_failed", `Notebook edit failed: ${(error as Error).message}`);
    return failureResult("edit_notebook", failure.code, failure.message, context);
  }
}

const outputSchema = {
  type: "object",
  maxProperties: 12,
  additionalProperties: true,
  required: ["outputType"],
  properties: { outputType: { type: "string", enum: ["stream", "display_data", "execute_result", "error"] } },
} as const;

const cellPatchSchema = {
  type: "object",
  additionalProperties: false,
  minProperties: 1,
  properties: {
    id: { type: "string", minLength: 1, maxLength: 255 },
    cellType: { type: "string", enum: ["markdown", "code", "raw"] },
    source: { type: "string", maxLength: PHASE20_LIMITS.notebook.maxSourceChars },
    metadata: { type: "object", maxProperties: 2_000, additionalProperties: true },
    executionCount: { type: ["integer", "null"], minimum: 0 },
    outputs: { type: "array", maxItems: 10_000, items: outputSchema },
  },
} as const;

const selectorProperties = {
  cellId: { type: "string", minLength: 1, maxLength: 255 },
  index: { type: "integer", minimum: 0, maximum: PHASE20_LIMITS.notebook.maxCells - 1 },
} as const;

export const readNotebookTool: RuntimeToolSpec = {
  name: "read_notebook",
  displayName: "Read Notebook",
  description: "Read bounded nbformat 4 notebook cells and outputs without executing code; sensitive metadata is redacted and binary/large HTML output is artifact-referenced.",
  inputSchema: {
    type: "object",
    additionalProperties: false,
    required: ["path"],
    properties: {
      path: pathPropertySchema,
      cursor: { ...cursorPropertySchema, pattern: "^(0|[1-9]\\d*)$" },
      maxCells: { type: "integer", minimum: 1, maximum: PHASE20_LIMITS.notebook.maxPageCells, default: PHASE20_LIMITS.notebook.defaultPageCells },
    },
  },
  readOnly: true,
  permissionCategory: "read_only",
  sideEffectLevel: "none",
  timeoutCategory: "slow",
  groups: ["documents", "notebook", "notebook-read"],
  selection: {
    groups: ["documents", "notebook", "notebook-read"],
    keywords: ["read notebook", "read ipynb", "inspect jupyter notebook", "读取notebook", "读取ipynb", "查看Jupyter笔记本"],
    keywordGroups: [["read", "notebook"], ["read", "ipynb"], ["读取", "notebook"], ["读取", "ipynb"]],
    attachmentExtensions: [".ipynb"],
    mimeTypes: [NOTEBOOK_MIME_TYPE, "application/json"],
  },
  getAvailability: readNotebookAvailability,
  resolveAccess: (rawArgs) => [{
    kind: "filesystem_read",
    paths: [(rawArgs as ReadNotebookArgs).path],
    reason: "Read the requested notebook through the workspace or trusted-artifact path guard without executing cells.",
  }],
  execute: (rawArgs, context) => executeReadNotebook(rawArgs as ReadNotebookArgs, context),
};

export const editNotebookTool: RuntimeToolSpec = {
  name: "edit_notebook",
  displayName: "Edit Notebook",
  description: "Edit nbformat 4 cell JSON by id or index with validation, checkpoint, atomic publish, artifact, and undo; never execute cells or contact Jupyter.",
  inputSchema: {
    type: "object",
    additionalProperties: false,
    required: ["path", "operations"],
    properties: {
      path: pathPropertySchema,
      outputPath: pathPropertySchema,
      overwrite: { type: "boolean" },
      operations: {
        type: "array",
        minItems: 1,
        maxItems: 1_000,
        items: {
          oneOf: [
            {
              type: "object", additionalProperties: false, required: ["type", "index", "cell"],
              properties: { type: { const: "insert" }, index: { type: "integer", minimum: 0, maximum: PHASE20_LIMITS.notebook.maxCells }, cell: notebookCellSchema },
            },
            {
              type: "object", additionalProperties: false, required: ["type", "patch"], anyOf: [{ required: ["cellId"] }, { required: ["index"] }],
              properties: { type: { const: "update" }, ...selectorProperties, patch: cellPatchSchema },
            },
            {
              type: "object", additionalProperties: false, required: ["type", "destinationIndex"], anyOf: [{ required: ["cellId"] }, { required: ["index"] }],
              properties: { type: { const: "move" }, ...selectorProperties, destinationIndex: { type: "integer", minimum: 0, maximum: PHASE20_LIMITS.notebook.maxCells - 1 } },
            },
            {
              type: "object", additionalProperties: false, required: ["type"], anyOf: [{ required: ["cellId"] }, { required: ["index"] }],
              properties: { type: { const: "delete" }, ...selectorProperties },
            },
          ],
        },
      },
    },
  },
  readOnly: false,
  permissionCategory: "write_file",
  sideEffectLevel: "high",
  timeoutCategory: "slow",
  groups: ["documents", "notebook", "notebook-edit"],
  selection: {
    groups: ["documents", "notebook", "notebook-edit"],
    keywords: ["edit notebook", "edit ipynb", "modify jupyter cells", "编辑notebook", "编辑ipynb", "修改Jupyter单元格"],
    keywordGroups: [["edit", "notebook"], ["edit", "ipynb"], ["编辑", "notebook"], ["编辑", "ipynb"]],
    attachmentExtensions: [".ipynb"],
    mimeTypes: [NOTEBOOK_MIME_TYPE, "application/json"],
  },
  checkpoint: {
    mode: "before_write",
    scope: "pre_tool_write",
    reason: "Before editing or publishing an nbformat 4 notebook.",
  },
  getAvailability: editNotebookAvailability,
  resolveAccess: (rawArgs) => {
    const args = rawArgs as EditNotebookArgs;
    return [
      { kind: "filesystem_read" as const, paths: [args.path], reason: "Read and validate the source notebook without executing cells." },
      { kind: "filesystem_write" as const, paths: [args.outputPath ?? args.path], reason: "Publish the edited notebook through the writable workspace guard." },
    ];
  },
  execute: (rawArgs, context) => executeEditNotebook(rawArgs as EditNotebookArgs, context),
};

export const notebooksToolModule: ToolModule = {
  manifest: {
    id: "builtin.notebooks",
    version: "1.0.0",
    description: "Bounded nbformat 4 notebook structure read/edit tools with no execution boundary.",
    source: "built_in",
  },
  create: () => [readNotebookTool, editNotebookTool],
};
