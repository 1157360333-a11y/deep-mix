import { createHash, createHmac } from "node:crypto";
import { promises as fs } from "node:fs";
import path from "node:path";

import type {
  ArtifactExportResult,
  ArtifactListRequest,
  ArtifactReadResult,
  ArtifactSummary,
  CheckpointListRequest,
  CheckpointSummary,
  LifecyclePage,
  LifecycleWarning,
  ToolAccessRequest,
  ToolPermissionProfile,
} from "../../../../shared-schema/src/index.js";
import { publishBinaryFileAtomic } from "../../atomic-file.js";
import {
  encodeLifecycleCursor,
  LIFECYCLE_MAX_LIMIT,
  paginateLifecycleItems,
} from "../../lifecycle-pagination.js";
import { redactProcessText } from "../../process-manager.js";
import type { RuntimeToolSpec, ToolModule } from "../../tool-module.js";

const CHECKPOINT_LIST_OUTPUT_MAX_CHARS = 262_144;
const ARTIFACT_LIST_OUTPUT_MAX_CHARS = 262_144;
const ARTIFACT_READ_DEFAULT_CHARS = 262_144;
const ARTIFACT_READ_MAX_CHARS = 2_000_000;
const ARTIFACT_READ_OUTPUT_MAX_CHARS = 2_100_000;
const ARTIFACT_TEXT_MAX_BYTES = 64 * 1024 * 1024;
const ARTIFACT_EXPORT_MAX_BYTES = 256 * 1024 * 1024;
const SECRET_JSON_KEY = /(?:api[-_]?key|authorization|cookie|credential|password|secret|session[-_]?token|token)/iu;

function lifecycleError(code: string, message: string): Error {
  return Object.assign(new Error(message), { code });
}

function normalizedTime(value: string | undefined, fieldName: string): string | undefined {
  if (value === undefined) return undefined;
  const timestamp = Date.parse(value);
  if (!Number.isFinite(timestamp)) {
    throw lifecycleError("ERR_TOOL_INVALID_ARGUMENTS", `${fieldName} must be a valid ISO-8601 timestamp.`);
  }
  return new Date(timestamp).toISOString();
}

function checkpointKey(item: CheckpointSummary): string {
  return `${item.createdAt}|${item.checkpointId}`;
}

function artifactKey(item: ArtifactSummary, integrityKey: Uint8Array): string {
  const opaqueUri = createHmac("sha256", integrityKey)
    .update("deep-mix:artifact-cursor-key:v1\0", "utf8")
    .update(item.uri, "utf8")
    .digest("base64url");
  return `${item.createdAt}|${opaqueUri}`;
}

function boundedArtifactSummary(item: ArtifactSummary): ArtifactSummary {
  return {
    ...item,
    name: item.name.slice(0, 255),
    mimeType: item.mimeType.slice(0, 255),
    summary: item.summary.slice(0, 4_000),
    sourceToolName: item.sourceToolName?.slice(0, 128),
    warnings: item.warnings.slice(0, 32).map((warning) => ({
      ...warning,
      message: warning.message.slice(0, 1_000),
      recordId: warning.recordId?.slice(0, 512),
    })),
  };
}

function fitArtifactPage(input: {
  page: LifecyclePage<ArtifactSummary>;
  cursorContext: Parameters<typeof encodeLifecycleCursor>[0];
}): LifecyclePage<ArtifactSummary> {
  const result: LifecyclePage<ArtifactSummary> = {
    ...input.page,
    items: input.page.items.map(boundedArtifactSummary),
    warnings: input.page.warnings.slice(0, 100),
  };
  if (JSON.stringify(result).length <= ARTIFACT_LIST_OUTPUT_MAX_CHARS) return result;

  const warning: LifecycleWarning = {
    code: "content_truncated",
    message: "Artifact catalog page was shortened to the lifecycle output budget; continue with nextCursor.",
  };
  result.partial = true;
  result.warnings.push(warning);
  while (result.items.length > 1 && JSON.stringify(result).length > ARTIFACT_LIST_OUTPUT_MAX_CHARS) {
    result.items.pop();
  }
  result.returned = result.items.length;
  result.hasMore = true;
  result.nextCursor = result.items.length > 0
    ? encodeLifecycleCursor(
        input.cursorContext,
        artifactKey(result.items.at(-1)!, input.cursorContext.integrityKey),
      )
    : input.page.nextCursor;
  if (JSON.stringify(result).length > ARTIFACT_LIST_OUTPUT_MAX_CHARS && result.items[0]) {
    result.items[0] = {
      ...result.items[0],
      summary: result.items[0].summary.slice(0, 512),
      partial: true,
      warnings: [warning],
    };
  }
  return result;
}

function sanitizeArtifactText(value: string, workspaceRoot: string): string {
  let redacted = redactProcessText(value);
  const escapeRegExp = (entry: string) => entry.replace(/[.*+?^${}()|[\]\\]/gu, "\\$&");
  if (process.platform === "win32") {
    const normalized = workspaceRoot.replace(/^\\\\\?\\/u, "").replace(/[\\/]+/gu, "/");
    const mixedSeparatorPattern = normalized.split("/").map(escapeRegExp).join("[\\\\/]+");
    redacted = redacted.replace(
      new RegExp(`${String.raw`(?:\\\\\?\\)?`}${mixedSeparatorPattern}`, "giu"),
      "<workspace>",
    );
  } else {
    redacted = redacted.replace(new RegExp(escapeRegExp(workspaceRoot), "gu"), "<workspace>");
  }
  return redacted;
}

function fitArtifactReadOutput(
  initial: ArtifactReadResult,
  fallbackContent?: string,
): { result: ArtifactReadResult; output: string } {
  let result = initial;
  let output = JSON.stringify(result);
  if (output.length <= ARTIFACT_READ_OUTPUT_MAX_CHARS) return { result, output };

  const warning: LifecycleWarning = {
    code: "content_truncated",
    message: "Artifact output was shortened to the bounded serialized lifecycle response budget.",
    recordId: result.artifact.uri,
  };
  const warnings = [...result.warnings, warning].slice(0, 32);
  result = {
    ...result,
    structuredData: undefined,
    ...(fallbackContent === undefined ? {} : { content: fallbackContent }),
    partial: true,
    warnings,
  };
  output = JSON.stringify(result);
  if (output.length <= ARTIFACT_READ_OUTPUT_MAX_CHARS) return { result, output };

  const content = result.content ?? "";
  let low = 0;
  let high = content.length;
  let fitted = "";
  while (low <= high) {
    const middle = Math.floor((low + high) / 2);
    const candidateContent = content.slice(0, middle);
    const candidate: ArtifactReadResult = {
      ...result,
      content: candidateContent,
      returnedChars: candidateContent.length,
      truncated: true,
      nextOffset: result.offset + candidateContent.length,
    };
    if (JSON.stringify(candidate).length <= ARTIFACT_READ_OUTPUT_MAX_CHARS) {
      fitted = candidateContent;
      low = middle + 1;
    } else {
      high = middle - 1;
    }
  }
  result = {
    ...result,
    content: fitted,
    returnedChars: fitted.length,
    truncated: true,
    nextOffset: result.offset + fitted.length,
  };
  output = JSON.stringify(result);
  if (output.length > ARTIFACT_READ_OUTPUT_MAX_CHARS) {
    throw lifecycleError("ERR_TOOL_UNAVAILABLE", "Artifact metadata exceeded the bounded lifecycle response budget.");
  }
  return { result, output };
}

function redactStructuredArtifact(value: unknown, workspaceRoot: string, depth = 0): unknown {
  if (depth > 48) return "[TRUNCATED_DEPTH]";
  if (typeof value === "string") return sanitizeArtifactText(value, workspaceRoot);
  if (Array.isArray(value)) {
    return value.slice(0, 100_000).map((entry) => redactStructuredArtifact(entry, workspaceRoot, depth + 1));
  }
  if (value === null || typeof value !== "object") return value;
  return Object.fromEntries(
    Object.entries(value as Record<string, unknown>)
      .slice(0, 100_000)
      .map(([key, entry]) => [
        key.slice(0, 512),
        SECRET_JSON_KEY.test(key) ? "[REDACTED]" : redactStructuredArtifact(entry, workspaceRoot, depth + 1),
      ]),
  );
}

function readArtifactArguments(rawArgs: unknown): { uri: string; offset: number; limit: number } {
  const args = (rawArgs ?? {}) as { uri?: unknown; offset?: unknown; limit?: unknown };
  if (typeof args.uri !== "string" || !args.uri || args.uri.length > 4_096) {
    throw lifecycleError("ERR_TOOL_INVALID_ARGUMENTS", "read_artifact requires a bounded artifact URI.");
  }
  const offset = args.offset ?? 0;
  const limit = args.limit ?? ARTIFACT_READ_DEFAULT_CHARS;
  if (!Number.isInteger(offset) || (offset as number) < 0) {
    throw lifecycleError("ERR_TOOL_INVALID_ARGUMENTS", "read_artifact offset must be a non-negative integer.");
  }
  if (!Number.isInteger(limit) || (limit as number) < 1 || (limit as number) > ARTIFACT_READ_MAX_CHARS) {
    throw lifecycleError(
      "ERR_TOOL_INVALID_ARGUMENTS",
      `read_artifact limit must be between 1 and ${ARTIFACT_READ_MAX_CHARS}.`,
    );
  }
  return { uri: args.uri, offset: offset as number, limit: limit as number };
}

function exportArtifactArguments(rawArgs: unknown, normalize: (value: string) => string): {
  uri: string;
  targetPath: string;
  overwrite: boolean;
} {
  const args = (rawArgs ?? {}) as { uri?: unknown; targetPath?: unknown; overwrite?: unknown };
  if (typeof args.uri !== "string" || !args.uri || args.uri.length > 4_096) {
    throw lifecycleError("ERR_TOOL_INVALID_ARGUMENTS", "export_artifact requires a bounded artifact URI.");
  }
  if (typeof args.targetPath !== "string" || !args.targetPath.trim() || args.targetPath.length > 2_000) {
    throw lifecycleError("ERR_TOOL_INVALID_ARGUMENTS", "export_artifact requires a workspace targetPath.");
  }
  const targetPath = normalize(args.targetPath);
  if (!targetPath || targetPath === ".") {
    throw lifecycleError("ERR_TOOL_INVALID_ARGUMENTS", "export_artifact cannot replace the workspace root.");
  }
  return { uri: args.uri, targetPath, overwrite: args.overwrite === true };
}

async function inspectExportTarget(workspaceRoot: string, absolutePath: string): Promise<{
  exists: boolean;
  identity?: string;
}> {
  const relative = path.relative(workspaceRoot, absolutePath);
  if (!relative || relative === "." || relative.startsWith("..") || path.isAbsolute(relative)) {
    throw lifecycleError("ERR_TOOL_PERMISSION_DENIED", "Export target must stay inside the current workspace.");
  }
  let current = workspaceRoot;
  for (const segment of relative.split(path.sep)) {
    current = path.join(current, segment);
    try {
      const stat = await fs.lstat(current);
      if (stat.isSymbolicLink()) {
        throw lifecycleError("ERR_TOOL_PERMISSION_DENIED", "Export target must not traverse a symbolic link.");
      }
      if (current !== absolutePath && !stat.isDirectory()) {
        throw lifecycleError("ERR_TOOL_CONFLICTED", "An export target parent is not a directory.");
      }
      if (current === absolutePath) {
        if (!stat.isFile()) {
          throw lifecycleError("ERR_TOOL_CONFLICTED", "Export target exists but is not a regular file.");
        }
        return {
          exists: true,
          identity: `${stat.dev}:${stat.ino}:${stat.size}:${stat.mtimeMs}:${stat.ctimeMs}`,
        };
      }
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return { exists: false };
      throw error;
    }
  }
  return { exists: false };
}

async function readPublishedExport(
  workspaceRoot: string,
  absolutePath: string,
  maxBytes: number,
): Promise<Buffer> {
  const initial = await inspectExportTarget(workspaceRoot, absolutePath);
  if (!initial.exists || !initial.identity) {
    throw lifecycleError("ERR_TOOL_CONFLICTED", "Export target was not published as a regular file.");
  }
  const handle = await fs.open(absolutePath, "r");
  try {
    const before = await handle.stat();
    const beforeIdentity = `${before.dev}:${before.ino}:${before.size}:${before.mtimeMs}:${before.ctimeMs}`;
    if (!before.isFile() || before.size > maxBytes || beforeIdentity !== initial.identity) {
      throw lifecycleError("ERR_TOOL_CONFLICTED", "Export target identity changed before verification.");
    }
    const content = await handle.readFile();
    const after = await handle.stat();
    const final = await inspectExportTarget(workspaceRoot, absolutePath);
    const afterIdentity = `${after.dev}:${after.ino}:${after.size}:${after.mtimeMs}:${after.ctimeMs}`;
    if (
      afterIdentity !== beforeIdentity ||
      final.identity !== beforeIdentity ||
      content.byteLength !== before.size
    ) {
      throw lifecycleError("ERR_TOOL_CONFLICTED", "Export target changed during integrity verification.");
    }
    return content;
  } finally {
    await handle.close();
  }
}

function boundCheckpointSummary(item: CheckpointSummary): CheckpointSummary {
  const warnings = [...item.warnings];
  const affectedPaths = item.affectedPaths.slice(0, 100).map((entry) => entry.slice(0, 512));
  if (affectedPaths.length !== item.affectedPaths.length) {
    warnings.push({
      code: "content_truncated",
      message: "Checkpoint affected paths were bounded in the catalog response.",
      recordId: item.checkpointId,
    });
  }
  return {
    ...item,
    affectedPaths,
    partial: item.partial || warnings.length !== item.warnings.length,
    warnings,
  };
}

function fitCheckpointPage(input: {
  page: LifecyclePage<CheckpointSummary>;
  cursorContext: Parameters<typeof encodeLifecycleCursor>[0];
}): LifecyclePage<CheckpointSummary> {
  const result: LifecyclePage<CheckpointSummary> = {
    ...input.page,
    items: input.page.items.map(boundCheckpointSummary),
    warnings: [...input.page.warnings],
  };
  let serialized = JSON.stringify(result);
  if (serialized.length <= CHECKPOINT_LIST_OUTPUT_MAX_CHARS) return result;

  const outputWarning: LifecycleWarning = {
    code: "content_truncated",
    message: "Checkpoint catalog page was shortened to the lifecycle output budget; continue with nextCursor.",
  };
  result.partial = true;
  result.warnings.push(outputWarning);
  while (result.items.length > 1 && JSON.stringify(result).length > CHECKPOINT_LIST_OUTPUT_MAX_CHARS) {
    result.items.pop();
  }
  result.returned = result.items.length;
  result.hasMore = true;
  result.nextCursor = result.items.length > 0
    ? encodeLifecycleCursor(input.cursorContext, checkpointKey(result.items.at(-1)!))
    : input.page.nextCursor;
  serialized = JSON.stringify(result);
  if (serialized.length > CHECKPOINT_LIST_OUTPUT_MAX_CHARS && result.items[0]) {
    result.items[0] = {
      ...result.items[0],
      affectedPaths: result.items[0].affectedPaths.slice(0, 8),
      partial: true,
      warnings: [...result.items[0].warnings, outputWarning],
    };
  }
  return result;
}

export const listCheckpointsTool: RuntimeToolSpec = {
  name: "list_checkpoints",
  description:
    "List checkpoint metadata owned by the current workspace and session with stable cursor pagination; checkpoint file contents are never returned.",
  inputSchema: {
    type: "object",
    additionalProperties: false,
    properties: {
      sessionId: { type: "string", minLength: 1, maxLength: 128 },
      turnId: { type: "string", minLength: 1, maxLength: 128 },
      toolCallId: { type: "string", minLength: 1, maxLength: 256 },
      createdAfter: { type: "string", minLength: 1, maxLength: 64 },
      createdBefore: { type: "string", minLength: 1, maxLength: 64 },
      cursor: { type: "string", minLength: 1, maxLength: 4_096 },
      limit: { type: "integer", minimum: 1, maximum: LIFECYCLE_MAX_LIMIT, default: 50 },
    },
  },
  readOnly: true,
  permissionCategory: "read_only",
  sideEffectLevel: "none",
  timeoutCategory: "fast",
  groups: ["recovery", "checkpoints", "lifecycle"],
  selection: {
    groups: ["recovery", "checkpoints", "lifecycle"],
    keywords: ["list checkpoints", "checkpoint history", "检查点列表", "恢复点"],
  },
  resolveAccess: (rawArgs, context) => {
    const args = (rawArgs ?? {}) as CheckpointListRequest;
    if (args.sessionId && args.sessionId !== context.sessionId) {
      throw lifecycleError(
        "ERR_TOOL_PERMISSION_DENIED",
        "list_checkpoints can only query the current session.",
      );
    }
    return [{
      kind: "trusted_state_read",
      reason: "Read current-session checkpoint metadata from the workspace-scoped trusted state store.",
    }];
  },
  redactArguments: (rawArgs) => {
    const args = (rawArgs ?? {}) as CheckpointListRequest;
    return {
      sessionId: args.sessionId,
      turnId: args.turnId,
      toolCallId: args.toolCallId,
      createdAfter: args.createdAfter,
      createdBefore: args.createdBefore,
      limit: args.limit,
      cursorProvided: Boolean(args.cursor),
    };
  },
  execute: async (rawArgs, context) => {
    const args = (rawArgs ?? {}) as CheckpointListRequest;
    const startedAt = context.moduleContext.clock.now();
    if (args.sessionId && args.sessionId !== context.sessionId) {
      throw lifecycleError(
        "ERR_TOOL_PERMISSION_DENIED",
        "list_checkpoints can only query the current session.",
      );
    }
    const createdAfter = normalizedTime(args.createdAfter, "createdAfter");
    const createdBefore = normalizedTime(args.createdBefore, "createdBefore");
    if (createdAfter && createdBefore && createdAfter > createdBefore) {
      throw lifecycleError(
        "ERR_TOOL_INVALID_ARGUMENTS",
        "createdAfter must not be later than createdBefore.",
      );
    }

    const scan = await context.moduleContext.persistence.scanCheckpointCatalog(context.sessionId);
    const filters = {
      sessionId: context.sessionId,
      turnId: args.turnId,
      toolCallId: args.toolCallId,
      createdAfter,
      createdBefore,
    };
    const filtered = scan.items.filter((item) =>
      (!args.turnId || item.turnId === args.turnId) &&
      (!args.toolCallId || item.toolCallId === args.toolCallId) &&
      (!createdAfter || item.createdAt >= createdAfter) &&
      (!createdBefore || item.createdAt <= createdBefore),
    );
    const cursorContext = {
      scope: "list_checkpoints",
      workspaceId: context.moduleContext.persistence.workspaceId,
      sessionId: context.sessionId,
      filters,
      integrityKey: await context.moduleContext.persistence.getLifecycleCursorIntegrityKey(),
    };
    const pagination = paginateLifecycleItems({
      items: filtered,
      cursor: args.cursor,
      limit: args.limit,
      context: cursorContext,
      stableKey: checkpointKey,
    });
    const page = fitCheckpointPage({
      cursorContext,
      page: {
        ...pagination,
        scanned: scan.scanned,
        partial: scan.partial,
        warnings: scan.warnings,
      },
    });
    return {
      toolName: "list_checkpoints",
      callId: context.callId,
      startedAt,
      endedAt: context.moduleContext.clock.now(),
      success: true,
      output: JSON.stringify(page),
      structuredContent: page,
    };
  },
};

export const listArtifactsTool: RuntimeToolSpec = {
  name: "list_artifacts",
  description:
    "List worker and tool-output artifacts owned by the current workspace and session with stable cursor pagination and bounded metadata.",
  inputSchema: {
    type: "object",
    additionalProperties: false,
    properties: {
      sessionId: { type: "string", minLength: 1, maxLength: 128 },
      artifactType: {
        type: "string",
        enum: ["code_artifact", "vision_artifact", "file", "document", "image", "text", "binary", "worker_patch", "worker_binary"],
      },
      sourceToolName: { type: "string", minLength: 1, maxLength: 128 },
      mimeType: { type: "string", minLength: 1, maxLength: 255 },
      createdAfter: { type: "string", minLength: 1, maxLength: 64 },
      createdBefore: { type: "string", minLength: 1, maxLength: 64 },
      cursor: { type: "string", minLength: 1, maxLength: 4_096 },
      limit: { type: "integer", minimum: 1, maximum: LIFECYCLE_MAX_LIMIT, default: 50 },
    },
  },
  readOnly: true,
  permissionCategory: "read_only",
  sideEffectLevel: "none",
  timeoutCategory: "fast",
  groups: ["artifacts", "lifecycle"],
  selection: {
    groups: ["artifacts", "lifecycle"],
    keywords: ["list artifacts", "artifact catalog", "产物列表", "工件列表"],
  },
  resolveAccess: (rawArgs, context) => {
    const args = (rawArgs ?? {}) as ArtifactListRequest;
    if (args.sessionId && args.sessionId !== context.sessionId) {
      throw lifecycleError("ERR_TOOL_PERMISSION_DENIED", "list_artifacts can only query the current session.");
    }
    return [{
      kind: "trusted_state_read",
      reason: "Read current-session artifact metadata from workspace-scoped trusted state.",
    }];
  },
  redactArguments: (rawArgs) => {
    const args = (rawArgs ?? {}) as ArtifactListRequest;
    return {
      sessionId: args.sessionId,
      artifactType: args.artifactType,
      sourceToolName: args.sourceToolName,
      mimeType: args.mimeType,
      createdAfter: args.createdAfter,
      createdBefore: args.createdBefore,
      limit: args.limit,
      cursorProvided: Boolean(args.cursor),
    };
  },
  execute: async (rawArgs, context) => {
    const args = (rawArgs ?? {}) as ArtifactListRequest;
    const startedAt = context.moduleContext.clock.now();
    if (args.sessionId && args.sessionId !== context.sessionId) {
      throw lifecycleError("ERR_TOOL_PERMISSION_DENIED", "list_artifacts can only query the current session.");
    }
    const createdAfter = normalizedTime(args.createdAfter, "createdAfter");
    const createdBefore = normalizedTime(args.createdBefore, "createdBefore");
    if (createdAfter && createdBefore && createdAfter > createdBefore) {
      throw lifecycleError("ERR_TOOL_INVALID_ARGUMENTS", "createdAfter must not be later than createdBefore.");
    }
    const mimeType = args.mimeType?.trim().toLocaleLowerCase("en-US");
    const scan = await context.moduleContext.persistence.scanArtifactCatalog(context.sessionId);
    const filters = {
      sessionId: context.sessionId,
      artifactType: args.artifactType,
      sourceToolName: args.sourceToolName,
      mimeType,
      createdAfter,
      createdBefore,
    };
    const filtered = scan.items.filter((item) =>
      (!args.artifactType || item.artifactType === args.artifactType) &&
      (!args.sourceToolName || item.sourceToolName === args.sourceToolName) &&
      (!mimeType || item.mimeType.toLocaleLowerCase("en-US") === mimeType) &&
      (!createdAfter || item.createdAt >= createdAfter) &&
      (!createdBefore || item.createdAt <= createdBefore),
    );
    const cursorContext = {
      scope: "list_artifacts",
      workspaceId: context.moduleContext.persistence.workspaceId,
      sessionId: context.sessionId,
      filters,
      integrityKey: await context.moduleContext.persistence.getLifecycleCursorIntegrityKey(),
    };
    const pagination = paginateLifecycleItems({
      items: filtered,
      cursor: args.cursor,
      limit: args.limit,
      context: cursorContext,
      stableKey: (item) => artifactKey(item, cursorContext.integrityKey),
    });
    const page = fitArtifactPage({
      cursorContext,
      page: {
        ...pagination,
        scanned: scan.scanned,
        partial: scan.partial,
        warnings: scan.warnings,
      },
    });
    return {
      toolName: "list_artifacts",
      callId: context.callId,
      startedAt,
      endedAt: context.moduleContext.clock.now(),
      success: true,
      output: JSON.stringify(page),
      structuredContent: page,
    };
  },
};

export const readArtifactTool: RuntimeToolSpec = {
  name: "read_artifact",
  description:
    "Read a bounded, redacted text or structured artifact page owned by the current session; binary artifacts return metadata only and are never decoded as UTF-8.",
  inputSchema: {
    type: "object",
    additionalProperties: false,
    required: ["uri"],
    properties: {
      uri: { type: "string", minLength: 1, maxLength: 4_096, pattern: "^artifact://" },
      offset: { type: "integer", minimum: 0, default: 0 },
      limit: { type: "integer", minimum: 1, maximum: ARTIFACT_READ_MAX_CHARS, default: ARTIFACT_READ_DEFAULT_CHARS },
    },
  },
  readOnly: true,
  permissionCategory: "read_only",
  sideEffectLevel: "none",
  timeoutCategory: "fast",
  groups: ["artifacts", "lifecycle"],
  selection: {
    groups: ["artifacts", "lifecycle"],
    keywords: ["read artifact", "artifact content", "读取产物", "查看工件"],
  },
  resolveAccess: async (rawArgs, context): Promise<ToolAccessRequest[]> => {
    const args = readArtifactArguments(rawArgs);
    await context.persistence.resolveLifecycleArtifact(context.sessionId, args.uri);
    return [{
      kind: "trusted_state_read",
      reason: "Resolve and read only a current-session artifact through the workspace-scoped trusted state boundary.",
    }];
  },
  redactArguments: (rawArgs) => {
    const args = (rawArgs ?? {}) as { uri?: string; offset?: number; limit?: number };
    return { uri: args.uri, offset: args.offset, limit: args.limit };
  },
  execute: async (rawArgs, context) => {
    const args = readArtifactArguments(rawArgs);
    const startedAt = context.moduleContext.clock.now();
    const resolved = await context.moduleContext.persistence.resolveLifecycleArtifact(context.sessionId, args.uri);
    const artifact = boundedArtifactSummary(resolved.summary);
    const warnings = [...artifact.warnings];
    let fallbackContent: string | undefined;

    let result: ArtifactReadResult;
    if (artifact.readMode === "binary_metadata") {
      result = {
        artifact,
        mode: "binary_metadata",
        offset: args.offset,
        limit: args.limit,
        returnedChars: 0,
        binaryInline: false,
        truncated: false,
        ownership: artifact.ownership,
        partial: artifact.partial,
        warnings,
      };
    } else {
      if (artifact.sizeBytes > ARTIFACT_TEXT_MAX_BYTES) {
        throw lifecycleError(
          "ERR_TOOL_UNAVAILABLE",
          `Artifact text exceeds the bounded ${ARTIFACT_TEXT_MAX_BYTES}-byte read window; export it instead.`,
        );
      }
      const bytes = await resolved.readBytes(context.signal);
      let decoded: string;
      try {
        decoded = new TextDecoder("utf-8", { fatal: true }).decode(bytes);
      } catch {
        warnings.push({
          code: "corrupt_record",
          message: "Artifact metadata declared text, but its payload was not valid UTF-8; bytes were not inlined.",
          recordId: artifact.uri,
        });
        result = {
          artifact: { ...artifact, readMode: "binary_metadata", partial: true, warnings },
          mode: "binary_metadata",
          offset: args.offset,
          limit: args.limit,
          returnedChars: 0,
          binaryInline: false,
          truncated: false,
          ownership: artifact.ownership,
          partial: true,
          warnings,
        };
        return {
          toolName: "read_artifact",
          callId: context.callId,
          startedAt,
          endedAt: context.moduleContext.clock.now(),
          success: true,
          output: JSON.stringify(result),
          structuredContent: result,
        };
      }
      const redacted = sanitizeArtifactText(decoded, context.workspaceRoot);
      if (redacted !== decoded) {
        warnings.push({
          code: "content_redacted",
          message: "Sensitive-looking values or workspace absolute paths were redacted before returning artifact content.",
          recordId: artifact.uri,
        });
      }
      const totalChars = redacted.length;
      const content = redacted.slice(args.offset, args.offset + args.limit);
      fallbackContent = content;
      const truncated = args.offset + content.length < totalChars;
      let structuredData: unknown;
      if (artifact.readMode === "structured" && args.offset === 0 && !truncated) {
        try {
          structuredData = redactStructuredArtifact(JSON.parse(decoded), context.workspaceRoot);
        } catch {
          warnings.push({
            code: "corrupt_record",
            message: "Structured artifact payload was not valid JSON; redacted text was returned instead.",
            recordId: artifact.uri,
          });
        }
      }
      if (truncated) {
        warnings.push({
          code: "content_truncated",
          message: "Artifact text was paged to the requested offset and limit.",
          recordId: artifact.uri,
        });
      }
      result = {
        artifact,
        mode: artifact.readMode,
        offset: args.offset,
        limit: args.limit,
        returnedChars: content.length,
        totalChars,
        ...(structuredData === undefined ? { content } : { structuredData }),
        binaryInline: false,
        truncated,
        ...(truncated ? { nextOffset: args.offset + content.length } : {}),
        ownership: artifact.ownership,
        partial: artifact.partial || warnings.length > artifact.warnings.length,
        warnings,
      };
    }
    const fitted = fitArtifactReadOutput(result, fallbackContent);
    return {
      toolName: "read_artifact",
      callId: context.callId,
      startedAt,
      endedAt: context.moduleContext.clock.now(),
      success: true,
      output: fitted.output,
      structuredContent: fitted.result,
    };
  },
};

export const exportArtifactTool: RuntimeToolSpec = {
  name: "export_artifact",
  description:
    "Checkpoint and atomically export a current-session artifact to an explicitly approved writable workspace path without sending it externally.",
  inputSchema: {
    type: "object",
    additionalProperties: false,
    required: ["uri", "targetPath"],
    properties: {
      uri: { type: "string", minLength: 1, maxLength: 4_096, pattern: "^artifact://" },
      targetPath: { type: "string", minLength: 1, maxLength: 2_000, pattern: "\\S" },
      overwrite: { type: "boolean", default: false },
    },
  },
  readOnly: false,
  permissionCategory: "write_file",
  sideEffectLevel: "high",
  timeoutCategory: "slow",
  groups: ["artifacts", "lifecycle", "export"],
  selection: {
    groups: ["artifacts", "lifecycle", "export"],
    keywords: ["export artifact", "save artifact", "导出产物", "保存工件"],
  },
  checkpoint: {
    mode: "before_write",
    scope: "pre_tool_write",
    reason: "Before exporting a trusted artifact into the workspace.",
    restoreOnFailure: true,
  },
  resolveAccess: async (rawArgs, context): Promise<ToolAccessRequest[]> => {
    const args = exportArtifactArguments(rawArgs, context.paths.normalize);
    await context.persistence.resolveLifecycleArtifact(context.sessionId, args.uri);
    return [
      {
        kind: "trusted_state_read",
        reason: "Resolve and read a current-session artifact through trusted state.",
      },
      {
        kind: "filesystem_write",
        paths: [args.targetPath],
        reason: "Checkpoint and atomically export the artifact only to the declared workspace path.",
      },
    ];
  },
  resolvePermission: async (rawArgs, context): Promise<ToolPermissionProfile> => {
    const args = exportArtifactArguments(rawArgs, context.paths.normalize);
    const source = await context.persistence.resolveLifecycleArtifact(context.sessionId, args.uri);
    if (source.summary.sizeBytes > ARTIFACT_EXPORT_MAX_BYTES) {
      throw lifecycleError(
        "ERR_TOOL_UNAVAILABLE",
        `Artifact exceeds the bounded ${ARTIFACT_EXPORT_MAX_BYTES}-byte export limit.`,
      );
    }
    // Every approval is bound to the bytes that were inspected, including
    // legacy and worker artifacts whose catalog record predates persisted
    // hash metadata. Size alone is not an integrity boundary.
    const approvedSourceBytes = await source.readBytes();
    const approvedSourceSha256 = createHash("sha256").update(approvedSourceBytes).digest("hex");
    const absoluteTarget = context.paths.resolveWorkspace(args.targetPath);
    const target = await inspectExportTarget(context.workspaceRoot, absoluteTarget);
    if (target.exists && !args.overwrite) {
      throw lifecycleError(
        "ERR_TOOL_CONFLICTED",
        "Export target already exists; set overwrite=true to request an explicit overwrite approval.",
      );
    }
    return {
      permissionCategory: "write_file",
      sideEffectLevel: "high",
      readOnly: false,
      approvalContext: {
        sourceUri: source.summary.uri,
        sourceSha256: approvedSourceSha256,
        sourceSizeBytes: source.summary.sizeBytes,
        targetPath: args.targetPath,
        targetExists: target.exists,
        targetIdentity: target.identity,
        overwrite: args.overwrite,
      },
      approvalPresentation: {
        action: target.exists ? "overwrite artifact export" : "export artifact",
        summary: target.exists
          ? "Export will overwrite one explicitly declared workspace file after checkpointing it."
          : "Export will create one explicitly declared workspace file after checkpointing the target path.",
        paths: [args.targetPath],
        argumentSummary: {
          sourceUri: source.summary.uri,
          sizeBytes: source.summary.sizeBytes,
          overwrite: args.overwrite,
        },
      },
    };
  },
  redactArguments: (rawArgs) => {
    const args = (rawArgs ?? {}) as { uri?: string; targetPath?: string; overwrite?: boolean };
    return { uri: args.uri, targetPath: args.targetPath, overwrite: args.overwrite === true };
  },
  execute: async (rawArgs, context) => {
    const args = exportArtifactArguments(rawArgs, context.moduleContext.paths.normalize);
    const startedAt = context.moduleContext.clock.now();
    if (!context.checkpoint) {
      throw lifecycleError("ERR_TOOL_CONFLICTED", "export_artifact requires a runtime checkpoint before writing.");
    }
    const source = await context.moduleContext.persistence.resolveLifecycleArtifact(context.sessionId, args.uri);
    if (source.summary.sizeBytes > ARTIFACT_EXPORT_MAX_BYTES) {
      throw lifecycleError(
        "ERR_TOOL_UNAVAILABLE",
        `Artifact exceeds the bounded ${ARTIFACT_EXPORT_MAX_BYTES}-byte export limit.`,
      );
    }
    const absoluteTarget = context.moduleContext.paths.resolveWorkspace(args.targetPath);
    const currentTarget = await inspectExportTarget(context.workspaceRoot, absoluteTarget);
    const approved = (context.approvalContext ?? {}) as {
      sourceUri?: unknown;
      sourceSha256?: unknown;
      sourceSizeBytes?: unknown;
      targetPath?: unknown;
      targetExists?: unknown;
      targetIdentity?: unknown;
      overwrite?: unknown;
    };
    if (
      approved.sourceUri !== source.summary.uri ||
      typeof approved.sourceSha256 !== "string" ||
      !/^[a-f0-9]{64}$/u.test(approved.sourceSha256) ||
      approved.sourceSizeBytes !== source.summary.sizeBytes ||
      approved.targetPath !== args.targetPath ||
      approved.targetExists !== currentTarget.exists ||
      approved.targetIdentity !== currentTarget.identity ||
      approved.overwrite !== args.overwrite
    ) {
      throw lifecycleError("ERR_TOOL_CONFLICTED", "Artifact source or export target changed after approval.");
    }
    if (currentTarget.exists && !args.overwrite) {
      throw lifecycleError("ERR_TOOL_CONFLICTED", "Export target already exists and overwrite was not approved.");
    }
    const bytes = await source.readBytes(context.signal);
    if (bytes.byteLength !== source.summary.sizeBytes) {
      throw lifecycleError("ERR_TOOL_CONFLICTED", "Artifact size changed before export publication.");
    }
    const sha256 = createHash("sha256").update(bytes).digest("hex");
    if (approved.sourceSha256 !== sha256) {
      throw lifecycleError("ERR_TOOL_CONFLICTED", "Artifact source bytes changed after approval.");
    }
    if (source.summary.sha256 && source.summary.sha256 !== sha256) {
      throw lifecycleError("ERR_TOOL_CORRUPT_RECORD", "Artifact hash did not match trusted metadata.");
    }
    const recheckedTarget = await inspectExportTarget(context.workspaceRoot, absoluteTarget);
    if (
      recheckedTarget.exists !== currentTarget.exists ||
      recheckedTarget.identity !== currentTarget.identity
    ) {
      throw lifecycleError("ERR_TOOL_CONFLICTED", "Export target changed while source bytes were being read.");
    }
    await publishBinaryFileAtomic(absoluteTarget, bytes, context.signal, {
      overwrite: args.overwrite,
      expectedTargetIdentity: currentTarget.identity,
      trustedRoot: context.workspaceRoot,
    });
    const published = await readPublishedExport(context.workspaceRoot, absoluteTarget, ARTIFACT_EXPORT_MAX_BYTES);
    const publishedSha256 = createHash("sha256").update(published).digest("hex");
    if (published.byteLength !== bytes.byteLength || publishedSha256 !== sha256) {
      throw lifecycleError("ERR_TOOL_CONFLICTED", "Exported artifact failed its post-publication integrity check.");
    }
    const result: ArtifactExportResult = {
      sourceUri: source.summary.uri,
      targetPath: args.targetPath,
      sizeBytes: published.byteLength,
      sha256: publishedSha256,
      checkpointId: context.checkpoint.checkpointId,
      overwritten: currentTarget.exists,
      ownership: source.summary.ownership,
      partial: false,
      warnings: [],
    };
    return {
      toolName: "export_artifact",
      callId: context.callId,
      startedAt,
      endedAt: context.moduleContext.clock.now(),
      success: true,
      output: JSON.stringify(result),
      structuredContent: result,
    };
  },
};

export const recoveryLifecycleToolModule: ToolModule = {
  manifest: {
    id: "builtin.recovery-lifecycle",
    version: "1.0.0",
    description: "Workspace- and session-owned checkpoint and artifact lifecycle tools.",
    source: "built_in",
  },
  create: () => [listCheckpointsTool, listArtifactsTool, readArtifactTool, exportArtifactTool],
};
