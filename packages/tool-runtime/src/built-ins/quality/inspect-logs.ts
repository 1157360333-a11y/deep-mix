import { promises as fs } from "node:fs";

import type {
  ToolOutputArtifact,
  ToolResult,
  ToolStructuredError,
} from "../../../../shared-schema/src/index.js";
import { redactProcessText } from "../../process-manager.js";
import type {
  RuntimeToolExecutionContext,
  RuntimeToolSpec,
} from "../../tool-module.js";

interface InspectLogsArguments {
  text?: string;
  source?: string;
}

type NormalizedLevel = "trace" | "debug" | "info" | "warn" | "error" | "fatal";

interface ParsedLine {
  line: number;
  text: string;
  message: string;
  timestamp?: string;
  level?: NormalizedLevel;
  component?: string;
}

interface CountedMessage {
  message: string;
  count: number;
  firstLine: number;
  lastLine: number;
}

const MAX_SOURCE_BYTES = 2_000_000;
const MAX_INLINE_SOURCE_CHARS = 16_384;
const MAX_FINDINGS = 50;
const MAX_MESSAGE_CHARS = 500;

const INSPECT_LOGS_SCHEMA = {
  type: "object",
  additionalProperties: false,
  properties: {
    text: { type: "string", minLength: 1, maxLength: MAX_SOURCE_BYTES },
    source: { type: "string", minLength: 1, maxLength: 4096 },
  },
  oneOf: [
    { required: ["text"], not: { required: ["source"] } },
    { required: ["source"], not: { required: ["text"] } },
  ],
} as const;

const TIMESTAMP_PATTERN = /\b(\d{4}-\d{2}-\d{2}[T ][0-2]\d:[0-5]\d:[0-5]\d(?:[.,]\d+)?(?:Z|[+-]\d{2}:?\d{2})?|\d{4}\/\d{2}\/\d{2}\s+[0-2]\d:[0-5]\d:[0-5]\d(?:[.,]\d+)?)\b/u;
const LEVEL_PATTERN = /\b(TRACE|DEBUG|INFO|WARN(?:ING)?|ERROR|FATAL|CRITICAL|PANIC)\b/iu;
const ERROR_PATTERN = /\b(error|exception|traceback|failed|failure|fatal|critical|panic|unhandled|rejected)\b/iu;

function truncateUtf8(value: string, maxBytes: number): { text: string; truncated: boolean } {
  const bytes = Buffer.from(value, "utf8");
  if (bytes.byteLength <= maxBytes) return { text: value, truncated: false };
  return { text: bytes.subarray(0, maxBytes).toString("utf8"), truncated: true };
}

/** Redaction is applied before parsing, inline output, summaries, or artifacts. */
export function redactLogText(value: string): string {
  return redactProcessText(value)
    .replace(
      /\b((?:proxy-authorization|authorization|cookie|set-cookie)\s*:\s*)[^\r\n]*/giu,
      "$1[REDACTED]",
    )
    .replace(
      /(["'](?:api[_-]?key|authorization|cookie|credential|password|secret|token|connection(?:[_-]?string)?|database[_-]?url|redis[_-]?url|mongo(?:db)?[_-]?url)["']\s*:\s*["'])[^"'\r\n]*(["'])/giu,
      "$1[REDACTED]$2",
    )
    .replace(
      /\b(connection(?:[_-]?string)?|database[_-]?url|redis[_-]?url|mongo(?:db)?[_-]?url)\b\s*([:=])[^\r\n]*/giu,
      "$1$2[REDACTED]",
    )
    .replace(/([?&](?:access[_-]?token|api[_-]?key|token|signature|sig)=)[^&\s]+/giu, "$1[REDACTED]")
    .replace(/\b(?:sk-[A-Za-z0-9_-]{12,}|gh[pousr]_[A-Za-z0-9]{20,}|AKIA[A-Z0-9]{16})\b/gu, "[REDACTED]")
    .replace(/\beyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\b/gu, "[REDACTED]");
}

function normalizeLevel(raw: string | undefined): NormalizedLevel | undefined {
  switch (raw?.toLocaleUpperCase("en-US")) {
    case "TRACE": return "trace";
    case "DEBUG": return "debug";
    case "INFO": return "info";
    case "WARN":
    case "WARNING": return "warn";
    case "ERROR": return "error";
    case "FATAL":
    case "CRITICAL":
    case "PANIC": return "fatal";
    default: return undefined;
  }
}

function extractComponent(line: string): string | undefined {
  const keyed = /\b(?:component|service|logger|module|scope)\s*[=:]\s*["'[]?([A-Za-z0-9_.:@/-]{1,80})/iu.exec(line)?.[1];
  if (keyed) return keyed;
  for (const match of line.matchAll(/\[([^\]\r\n]{1,80})\]/gu)) {
    const candidate = match[1]?.trim();
    if (!candidate || LEVEL_PATTERN.test(candidate) || TIMESTAMP_PATTERN.test(candidate)) continue;
    if (/^[A-Za-z][A-Za-z0-9_.:@/-]*$/u.test(candidate)) return candidate;
  }
  const afterLevel = /\b(?:TRACE|DEBUG|INFO|WARN(?:ING)?|ERROR|FATAL|CRITICAL|PANIC)\b\s+([A-Za-z][A-Za-z0-9_.:@/-]{1,80})\s*[-:]/iu.exec(line)?.[1];
  return afterLevel;
}

function cleanMessage(line: string): string {
  return line
    .replace(TIMESTAMP_PATTERN, "")
    .replace(LEVEL_PATTERN, "")
    .replace(/^\s*\[[^\]]{1,80}\]\s*/u, "")
    .replace(/\b(?:component|service|logger|module|scope)\s*[=:]\s*["'[]?[A-Za-z0-9_.:@/-]{1,80}["'\]]?/giu, "")
    .replace(/^[\s|:;,\]-]+|[\s|]+$/gu, "")
    .replace(/\s+/gu, " ")
    .slice(0, MAX_MESSAGE_CHARS);
}

function parseLines(text: string): ParsedLine[] {
  return text.split(/\r?\n/u).map((line, index) => {
    const timestamp = TIMESTAMP_PATTERN.exec(line)?.[1];
    const level = normalizeLevel(LEVEL_PATTERN.exec(line)?.[1]);
    return {
      line: index + 1,
      text: line,
      message: cleanMessage(line) || line.trim().slice(0, MAX_MESSAGE_CHARS),
      timestamp,
      level,
      component: extractComponent(line),
    };
  });
}

function countedMessages(lines: readonly ParsedLine[], errorsOnly: boolean): CountedMessage[] {
  const counted = new Map<string, CountedMessage>();
  for (const line of lines) {
    if (!line.message) continue;
    if (errorsOnly) {
      const isErrorLevel = line.level === "error" || line.level === "fatal";
      const hasErrorKeyword = ERROR_PATTERN.test(line.text) && !/\b(?:0|no)\s+errors?\b/iu.test(line.text);
      if (!isErrorLevel && !hasErrorKeyword) continue;
    }
    const key = line.message
      .replace(/\b(pid|request[_-]?id|trace[_-]?id|span[_-]?id)\s*[=:]\s*[A-Za-z0-9_-]+/giu, "$1=<id>")
      .toLocaleLowerCase("en-US");
    const existing = counted.get(key);
    if (existing) {
      existing.count += 1;
      existing.lastLine = line.line;
    } else {
      counted.set(key, { message: line.message, count: 1, firstLine: line.line, lastLine: line.line });
    }
  }
  return [...counted.values()]
    .sort((left, right) => right.count - left.count || left.firstLine - right.firstLine)
    .slice(0, MAX_FINDINGS);
}

function stackLocations(lines: readonly ParsedLine[]): Array<{
  path: string;
  line: number;
  column?: number;
  count: number;
}> {
  const locations = new Map<string, { path: string; line: number; column?: number; count: number }>();
  const add = (rawPath: string, rawLine: string, rawColumn?: string): void => {
    const filePath = rawPath.replace(/^file:\/\//u, "").replace(/^["'(\s]+|["')\s]+$/gu, "").slice(0, 500);
    const line = Number(rawLine);
    const column = rawColumn ? Number(rawColumn) : undefined;
    if (!filePath || !Number.isInteger(line)) return;
    const key = `${filePath}:${line}:${column ?? ""}`;
    const existing = locations.get(key);
    if (existing) existing.count += 1;
    else locations.set(key, { path: filePath, line, ...(column ? { column } : {}), count: 1 });
  };
  for (const entry of lines) {
    for (const match of entry.text.matchAll(/((?:[A-Za-z]:[\\/]|\/|\.{1,2}[\\/]|[A-Za-z0-9_.@-]+[\\/])[^()\r\n]*?\.[A-Za-z0-9]{1,12}):(\d+)(?::(\d+))?/gu)) {
      if (match[1] && match[2]) add(match[1], match[2], match[3]);
    }
    const python = /\bFile\s+["']([^"']+)["'],\s+line\s+(\d+)/u.exec(entry.text);
    if (python?.[1] && python[2]) add(python[1], python[2]);
  }
  return [...locations.values()].sort((left, right) => right.count - left.count).slice(0, MAX_FINDINGS);
}

async function readBoundedSource(
  args: InspectLogsArguments,
  context: RuntimeToolExecutionContext,
): Promise<{
  text: string;
  bytesRead: number;
  inputBytes: number;
  truncated: boolean;
  sourceKind: "text" | "path" | "artifact";
  source: string;
}> {
  const hasText = typeof args.text === "string";
  const hasSource = typeof args.source === "string";
  if (hasText === hasSource) throw new Error("inspect_logs requires exactly one of text or source.");
  if (hasText) {
    const input = Buffer.from(args.text!, "utf8");
    const bounded = input.subarray(0, MAX_SOURCE_BYTES);
    return {
      text: bounded.toString("utf8"),
      bytesRead: bounded.byteLength,
      inputBytes: input.byteLength,
      truncated: input.byteLength > MAX_SOURCE_BYTES,
      sourceKind: "text",
      source: "inline_text",
    };
  }

  context.signal?.throwIfAborted();
  const resolved = await context.moduleContext.paths.resolveReadable(args.source!);
  const stat = await fs.stat(resolved.absolutePath);
  if (!stat.isFile()) throw new Error("inspect_logs source must resolve to a regular file.");
  let bytes: Buffer;
  if (stat.size <= MAX_SOURCE_BYTES) {
    bytes = await resolved.readBytes();
  } else {
    const handle = await fs.open(resolved.absolutePath, "r");
    try {
      bytes = Buffer.allocUnsafe(MAX_SOURCE_BYTES);
      const read = await handle.read(bytes, 0, MAX_SOURCE_BYTES, 0);
      bytes = bytes.subarray(0, read.bytesRead);
    } finally {
      await handle.close();
    }
  }
  context.signal?.throwIfAborted();
  return {
    text: bytes.toString("utf8"),
    bytesRead: bytes.byteLength,
    inputBytes: stat.size,
    truncated: stat.size > bytes.byteLength,
    sourceKind: resolved.artifactRef ? "artifact" : "path",
    source: resolved.artifactRef ?? resolved.workspaceRelativePath ?? args.source!,
  };
}

async function persistRedactedLog(
  context: RuntimeToolExecutionContext,
  content: string,
): Promise<ToolOutputArtifact> {
  const bounded = truncateUtf8(content, MAX_SOURCE_BYTES);
  return context.moduleContext.persistence.storeToolOutputArtifact({
    sessionId: context.sessionId,
    namespace: "quality",
    turnId: context.turnId,
    toolCallId: context.callId,
    sourceToolName: "inspect_logs",
    fileName: `inspect-logs-${context.callId}.log`,
    mimeType: "text/plain",
    kind: "text",
    summary: "Full redacted log source inspected without execution",
    content: bounded.text,
    signal: context.signal,
  });
}

async function executeInspectLogs(
  args: InspectLogsArguments,
  context: RuntimeToolExecutionContext,
): Promise<ToolResult> {
  const startedAt = context.moduleContext.clock.now();
  try {
    const source = await readBoundedSource(args, context);
    const redacted = redactLogText(source.text);
    const lines = parseLines(redacted);
    const levelCounts: Record<NormalizedLevel, number> = {
      trace: 0, debug: 0, info: 0, warn: 0, error: 0, fatal: 0,
    };
    const components = new Map<string, number>();
    const timestamps: string[] = [];
    for (const line of lines) {
      if (line.level) levelCounts[line.level] += 1;
      if (line.component) components.set(line.component, (components.get(line.component) ?? 0) + 1);
      if (line.timestamp) timestamps.push(line.timestamp);
    }
    const keyErrors = countedMessages(lines, true);
    const repeatedMessages = countedMessages(lines, false).filter((entry) => entry.count > 1);
    const locations = stackLocations(lines);
    const artifacts = redacted.length > MAX_INLINE_SOURCE_CHARS || source.truncated
      ? [await persistRedactedLog(context, redacted)]
      : [];
    const structuredContent = {
      kind: "inspect_logs",
      ok: true,
      source: { kind: source.sourceKind, reference: source.source },
      bytesRead: source.bytesRead,
      inputBytes: source.inputBytes,
      sourceTruncated: source.truncated,
      sourceComplete: !source.truncated,
      returnedChars: redacted.length,
      redactedSource: redacted,
      lineCount: lines.length,
      levelCounts,
      timeRange: timestamps.length > 0 ? { first: timestamps[0], last: timestamps.at(-1) } : undefined,
      components: [...components.entries()]
        .map(([name, count]) => ({ name, count }))
        .sort((left, right) => right.count - left.count || left.name.localeCompare(right.name))
        .slice(0, MAX_FINDINGS),
      keyErrors,
      stackLocations: locations,
      repeatedMessages,
      redacted: true,
      executionAttempted: false,
      artifactUris: artifacts.map((artifact) => artifact.uri),
    };
    return {
      toolName: "inspect_logs",
      callId: context.callId,
      startedAt,
      endedAt: context.moduleContext.clock.now(),
      success: true,
      output: JSON.stringify(structuredContent),
      structuredContent,
      artifacts,
    };
  } catch (error) {
    const structured: ToolStructuredError = {
      type: /path|file|source|artifact/iu.test((error as Error).message) ? "invalid_path" : "invalid_arguments",
      message: redactLogText((error as Error).message).slice(0, MAX_SOURCE_BYTES),
      retryable: false,
      toolName: "inspect_logs",
    };
    const body = {
      kind: "inspect_logs",
      ok: false,
      redacted: true,
      executionAttempted: false,
      error: structured,
    };
    return {
      toolName: "inspect_logs",
      callId: context.callId,
      startedAt,
      endedAt: context.moduleContext.clock.now(),
      success: false,
      output: JSON.stringify(body),
      structuredContent: body,
      error: structured.message,
    };
  }
}

export const inspectLogsTool: RuntimeToolSpec = {
  name: "inspect_logs",
  description: "Parse a bounded text log or trusted log artifact into redacted errors, levels, components, repetitions, and stack locations without executing its contents.",
  inputSchema: INSPECT_LOGS_SCHEMA,
  readOnly: true,
  permissionCategory: "read_only",
  sideEffectLevel: "none",
  timeoutCategory: "fast",
  groups: ["quality", "repository"],
  selection: {
    groups: ["quality", "repository"],
    keywords: ["inspect logs", "logs", "error log", "stack trace", "日志检查", "错误日志"],
    workerRoutes: ["coding"],
  },
  resolveAccess: (rawArgs) => {
    const args = rawArgs as InspectLogsArguments;
    if (typeof args.source !== "string") return [];
    return [{
      kind: "filesystem_read",
      paths: [args.source],
      reason: "Read a bounded log through the workspace or trusted-artifact path guard.",
    }];
  },
  redactArguments: (rawArgs) => {
    const args = rawArgs as InspectLogsArguments;
    return args.text === undefined
      ? { source: args.source }
      : { text: "[INLINE_LOG_REDACTED]", textChars: args.text.length };
  },
  execute: (rawArgs, context) => executeInspectLogs(rawArgs as InspectLogsArguments, context),
};
