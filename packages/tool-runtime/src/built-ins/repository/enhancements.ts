import { createHash } from "node:crypto";
import { promises as fs } from "node:fs";
import path from "node:path";

import type { ToolAccessRequest, ToolResult } from "../../../../shared-schema/src/index.js";
import {
  DEFAULT_IGNORED_PREFIXES,
  DEFAULT_MAX_REPOSITORY_PATH_CHARS,
  DEFAULT_MAX_REPOSITORY_TOTAL_PATH_CHARS,
  RepositoryIgnoreResolver,
  globFilesWithNodeFs,
  isProbablyTextFile,
  matchesRepositoryExclude,
  matchesRepositoryFileGlob,
  normalizeRepositoryPath,
} from "../../repository-explorer.js";
import type {
  RuntimeToolExecutionContext,
  RuntimeToolSpec,
  ToolModule,
} from "../../tool-module.js";

const MAX_GLOBS = 20;
const MAX_EXCLUDES = 40;
const DEFAULT_MAX_DEPTH = 64;
const DEFAULT_MAX_RESULTS = 5_000;
const DEFAULT_READ_MAX_FILES = 100;
const MAX_READ_MANY_CHARS = 2_000_000;
const DEFAULT_READ_MAX_CHARS_PER_FILE = MAX_READ_MANY_CHARS;
const DEFAULT_READ_MAX_TOTAL_CHARS = MAX_READ_MANY_CHARS;
// Above this bounded size, also keep the full batch output as a re-readable
// artifact. The authoritative inline output still remains raw in later
// Provider calls; this artifact is recovery evidence, not a summary substitute.
const READ_MANY_ARTIFACT_OUTPUT_THRESHOLD_CHARS = 12_000;
const MAX_RG_OUTPUT_CHARS = DEFAULT_MAX_REPOSITORY_TOTAL_PATH_CHARS + 16_384;
const FILE_METADATA_SAMPLE_BYTES = 4_096;
const DEFAULT_FILE_METADATA_HASH_MAX_BYTES = 4 * 1024 * 1024;
const MAX_FILE_METADATA_HASH_BYTES = 16 * 1024 * 1024;

const REPOSITORY_TEXT_ATTACHMENT_EXTENSIONS = [
  ".txt", ".md", ".json", ".jsonl", ".yaml", ".yml", ".toml", ".xml", ".csv",
  ".ts", ".tsx", ".js", ".jsx", ".mjs", ".cjs", ".py", ".go", ".rs", ".java",
  ".c", ".h", ".cc", ".cpp", ".hpp", ".cs", ".sh", ".ps1", ".sql", ".html", ".css",
] as const;

const REPOSITORY_TEXT_ATTACHMENT_MIME_TYPES = [
  "text/plain",
  "text/markdown",
  "application/json",
  "application/x-ndjson",
  "application/yaml",
  "text/yaml",
  "application/toml",
  "application/xml",
  "text/xml",
  "text/csv",
  "text/javascript",
  "application/javascript",
  "text/typescript",
  "application/typescript",
  "text/x-python",
  "text/x-go",
  "text/x-rust",
  "text/x-java-source",
  "text/x-c",
  "text/x-c++",
  "text/x-shellscript",
  "application/sql",
  "text/html",
  "text/css",
] as const;

interface GlobFilesArgs {
  cwd?: string;
  globs: string[];
  exclude?: string[];
  maxDepth?: number;
  maxResults?: number;
}

interface ReadManyFilesArgs {
  cwd?: string;
  paths?: string[];
  globs?: string[];
  exclude?: string[];
  maxDepth?: number;
  maxFiles?: number;
  maxCharsPerFile?: number;
  maxTotalChars?: number;
}

interface FileMetadataArgs {
  path: string;
  includeHash?: boolean;
  hashMaxBytes?: number;
}

interface FileDiscoveryResult {
  files: string[];
  strategy: "rg" | "node_fs";
  fallbackUsed: boolean;
  truncated: boolean;
  candidateCount: number;
  totalPathChars: number;
  truncationReason?: "max_results" | "max_path_chars" | "max_total_path_chars" | "rg_output";
  warnings: string[];
  attempts: Array<Record<string, unknown>>;
}

type ReadManyStatus = "ok" | "budget_exhausted" | "ignored" | "binary" | "error";

interface ReadManyFileResult {
  path: string;
  ref?: string;
  status: ReadManyStatus;
  success: boolean;
  content?: string;
  charsRead: number;
  sizeBytes?: number;
  truncated: boolean;
  summary: string;
  error?: string;
}

function comparePaths(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0;
}

function workspaceRelativePath(workspaceRoot: string, targetPath: string): string {
  return normalizeRepositoryPath(path.relative(workspaceRoot, targetPath)) || ".";
}

function normalizePatterns(values: string[] | undefined, label: string, limit: number): string[] {
  const patterns = (values ?? []).map((value) => normalizeRepositoryPath(value.trim()));
  if (patterns.length > limit) throw new Error(`${label} accepts at most ${limit} patterns.`);
  for (const pattern of patterns) {
    if (!pattern || pattern.startsWith("!") || path.posix.isAbsolute(pattern) || pattern.split("/").includes("..")) {
      throw new Error(`${label} contains an invalid repository-relative pattern.`);
    }
  }
  return [...new Set(patterns)];
}

function normalizeExplicitPaths(
  values: string[],
  cwd: string,
  workspaceRoot: string,
): string[] {
  const normalized: string[] = [];
  const seen = new Set<string>();
  for (const rawValue of values) {
    const value = rawValue.trim();
    let candidate: string;
    if (value.startsWith("artifact://")) candidate = value;
    else if (value.startsWith("file://")) {
      candidate = `file://${normalizeRepositoryPath(value.slice("file://".length))}`;
    } else {
      candidate = workspaceRelativePath(workspaceRoot, path.resolve(cwd, value));
    }
    const key = candidateKey(candidate);
    if (!seen.has(key)) {
      seen.add(key);
      normalized.push(candidate);
    }
  }
  return normalized;
}

function candidateKey(candidate: string): string {
  const comparable = candidate.startsWith("file://") ? candidate.slice("file://".length) : candidate;
  return process.platform === "win32" ? comparable.toLocaleLowerCase("en-US") : comparable;
}

async function assertNoWorkspaceSymlinkComponents(
  workspaceRoot: string,
  absolutePath: string,
): Promise<void> {
  const relativePath = path.relative(path.resolve(workspaceRoot), path.resolve(absolutePath));
  if (relativePath.startsWith("..") || path.isAbsolute(relativePath)) {
    throw new Error("The path escapes the workspace boundary.");
  }
  if (process.platform === "win32") {
    for (const segment of normalizeRepositoryPath(relativePath).split("/")) {
      if (segment.includes(":") || /[. ]$/u.test(segment)) {
        throw new Error("The path contains an ambiguous Windows component.");
      }
    }
  }
  let currentPath = path.resolve(workspaceRoot);
  for (const segment of relativePath.split(path.sep).filter(Boolean)) {
    currentPath = path.join(currentPath, segment);
    const stat = await fs.lstat(currentPath);
    if (stat.isSymbolicLink()) {
      throw new Error("The path contains a symbolic link or junction.");
    }
  }
}

function inferMimeType(filePath: string, isDirectory: boolean): string {
  if (isDirectory) return "inode/directory";
  const extension = path.extname(filePath).toLocaleLowerCase("en-US");
  const known: Record<string, string> = {
    ".c": "text/x-c",
    ".cc": "text/x-c++",
    ".cpp": "text/x-c++",
    ".css": "text/css",
    ".csv": "text/csv",
    ".gif": "image/gif",
    ".go": "text/x-go",
    ".htm": "text/html",
    ".html": "text/html",
    ".jpeg": "image/jpeg",
    ".jpg": "image/jpeg",
    ".js": "text/javascript",
    ".json": "application/json",
    ".jsx": "text/jsx",
    ".md": "text/markdown",
    ".mjs": "text/javascript",
    ".pdf": "application/pdf",
    ".png": "image/png",
    ".py": "text/x-python",
    ".rs": "text/x-rust",
    ".svg": "image/svg+xml",
    ".toml": "application/toml",
    ".ts": "text/typescript",
    ".tsx": "text/tsx",
    ".txt": "text/plain",
    ".webp": "image/webp",
    ".xml": "application/xml",
    ".yaml": "application/yaml",
    ".yml": "application/yaml",
  };
  return known[extension] ?? "application/octet-stream";
}

function inferEncodingHint(
  sample: Buffer,
  hasMoreBytes: boolean,
): "utf-8" | "utf-16le" | "utf-16be" | "binary" | "unknown" {
  if (sample.length === 0) return "utf-8";
  if (sample.length >= 3 && sample[0] === 0xef && sample[1] === 0xbb && sample[2] === 0xbf) return "utf-8";
  if (sample.length >= 2 && sample[0] === 0xff && sample[1] === 0xfe) return "utf-16le";
  if (sample.length >= 2 && sample[0] === 0xfe && sample[1] === 0xff) return "utf-16be";
  if (sample.includes(0)) return "binary";
  try {
    new TextDecoder("utf-8", { fatal: true }).decode(sample, { stream: hasMoreBytes });
    return "utf-8";
  } catch {
    return "unknown";
  }
}

async function hashOpenFile(
  handle: Awaited<ReturnType<typeof fs.open>>,
  sizeBytes: number,
): Promise<string> {
  const hash = createHash("sha256");
  const buffer = Buffer.allocUnsafe(64 * 1024);
  let position = 0;
  while (position < sizeBytes) {
    const { bytesRead } = await handle.read(buffer, 0, Math.min(buffer.length, sizeBytes - position), position);
    if (bytesRead === 0) break;
    hash.update(buffer.subarray(0, bytesRead));
    position += bytesRead;
  }
  return hash.digest("hex");
}

async function resolveReadableDirectory(
  context: RuntimeToolExecutionContext,
  requestedCwd: string,
): Promise<{ absolutePath: string; workspaceRelativePath: string }> {
  const resolved = await context.moduleContext.paths.resolveReadable(requestedCwd);
  const stat = await fs.stat(resolved.absolutePath);
  if (!stat.isDirectory()) throw new Error("The requested cwd is not a directory.");
  if (!resolved.workspaceRelativePath) throw new Error("Repository discovery requires a workspace directory.");
  return {
    absolutePath: resolved.absolutePath,
    workspaceRelativePath: resolved.workspaceRelativePath,
  };
}

async function parseRgFileList(input: {
  stdout: string;
  workspaceRoot: string;
  cwd: string;
  globs: string[];
  exclude: string[];
  maxResults: number;
  outputTruncated: boolean;
  context: RuntimeToolExecutionContext;
}): Promise<{
  files: string[];
  truncated: boolean;
  candidateCount: number;
  totalPathChars: number;
  truncationReason?: FileDiscoveryResult["truncationReason"];
  warnings: string[];
}> {
  const resolver = new RepositoryIgnoreResolver(input.workspaceRoot);
  const files = new Set<string>();
  const candidates = input.stdout
    .split(/\r?\n/)
    .map((entry) => normalizeRepositoryPath(entry.trim()).replace(/^\.\//, ""))
    .filter(Boolean)
    .sort(comparePaths);

  let truncated = input.outputTruncated;
  let truncationReason: FileDiscoveryResult["truncationReason"] = input.outputTruncated
    ? "rg_output"
    : undefined;
  let candidateCount = 0;
  let totalPathChars = 0;
  for (const relativeCwdPath of candidates) {
    if (!matchesRepositoryFileGlob(relativeCwdPath, input.globs)) continue;
    if (input.exclude.length > 0 && matchesRepositoryExclude(relativeCwdPath, input.exclude)) continue;
    const absolutePath = path.resolve(input.cwd, relativeCwdPath);
    const relativeWorkspacePath = workspaceRelativePath(input.workspaceRoot, absolutePath);
    if (relativeWorkspacePath.length > DEFAULT_MAX_REPOSITORY_PATH_CHARS) {
      truncated = true;
      truncationReason ??= "max_path_chars";
      continue;
    }
    let readable: Awaited<ReturnType<RuntimeToolExecutionContext["moduleContext"]["paths"]["resolveReadable"]>>;
    try {
      readable = await input.context.moduleContext.paths.resolveReadable(relativeWorkspacePath);
      const stat = await fs.stat(readable.absolutePath);
      if (!stat.isFile()) continue;
    } catch {
      continue;
    }
    if (await resolver.isIgnored(relativeWorkspacePath, false)) continue;
    if (files.has(relativeWorkspacePath)) continue;
    candidateCount += 1;
    if (totalPathChars + relativeWorkspacePath.length > DEFAULT_MAX_REPOSITORY_TOTAL_PATH_CHARS) {
      truncated = true;
      truncationReason ??= "max_total_path_chars";
      break;
    }
    files.add(relativeWorkspacePath);
    totalPathChars += relativeWorkspacePath.length;
    if (files.size > input.maxResults) {
      truncated = true;
      truncationReason ??= "max_results";
      break;
    }
  }
  const sorted = [...files].sort(comparePaths);
  if (sorted.length > input.maxResults) sorted.length = input.maxResults;
  return {
    files: sorted,
    truncated,
    candidateCount,
    totalPathChars,
    truncationReason,
    warnings: resolver.listWarnings(),
  };
}

async function discoverFiles(
  args: GlobFilesArgs,
  context: RuntimeToolExecutionContext,
): Promise<FileDiscoveryResult> {
  const globs = normalizePatterns(args.globs, "globs", MAX_GLOBS);
  if (globs.length === 0) throw new Error("At least one glob is required.");
  const exclude = normalizePatterns(args.exclude, "exclude", MAX_EXCLUDES);
  const cwd = await resolveReadableDirectory(context, args.cwd ?? ".");
  const maxDepth = args.maxDepth ?? DEFAULT_MAX_DEPTH;
  const maxResults = args.maxResults ?? DEFAULT_MAX_RESULTS;
  const rgCapability = await context.moduleContext.capabilities.get("rg");
  const attempts: Array<Record<string, unknown>> = [];

  if (rgCapability?.available) {
    // Do not let rg follow or read repository ignore metadata on its own. The
    // bounded post-filter below parses .gitignore safely and consistently with
    // the Node fallback.
    // rg counts the cwd itself as depth 0, while the public contract counts
    // files in cwd as depth 0. Offset by one to keep the Node and rg sets equal.
    const rgArgs = ["--files", "--hidden", "--no-ignore", "--sort", "path", "--max-depth", String(maxDepth + 1)];
    // User include/exclude patterns are intentionally not passed to rg: both
    // strategies use the shared matcher below, preventing engine drift.
    for (const prefix of DEFAULT_IGNORED_PREFIXES) {
      rgArgs.push(
        "--glob", `!${prefix}`,
        "--glob", `!${prefix}/**`,
        "--glob", `!**/${prefix}`,
        "--glob", `!**/${prefix}/**`,
      );
    }
    rgArgs.push(".");
    const result = await context.moduleContext.processes.run({
      command: rgCapability.command,
      args: rgArgs,
      mode: "direct",
      cwd: cwd.absolutePath,
      timeoutMs: 20_000,
      maxOutputChars: MAX_RG_OUTPUT_CHARS,
      environment: context.moduleContext.environment,
    });
    if (!result.spawnError && !result.timedOut && (result.exitCode === 0 || result.exitCode === 1)) {
      const parsed = await parseRgFileList({
        stdout: result.stdout,
        workspaceRoot: context.workspaceRoot,
        cwd: cwd.absolutePath,
        globs,
        exclude,
        maxResults,
        outputTruncated: result.outputTruncated === true,
        context,
      });
      return {
        ...parsed,
        strategy: "rg",
        fallbackUsed: false,
        attempts,
      };
    }
    attempts.push({
      strategy: "rg",
      success: false,
      reason: result.timedOut ? "timeout" : result.spawnError ? "spawn_failed" : "command_failed",
      exitCode: result.exitCode,
    });
  } else {
    attempts.push({
      strategy: "rg",
      success: false,
      skipped: true,
      reason: "unavailable",
    });
  }

  const fallback = await globFilesWithNodeFs({
    workspaceRoot: context.workspaceRoot,
    cwd: cwd.absolutePath,
    globs,
    exclude,
    maxDepth,
    maxResults,
    maxPathChars: DEFAULT_MAX_REPOSITORY_PATH_CHARS,
    maxTotalPathChars: DEFAULT_MAX_REPOSITORY_TOTAL_PATH_CHARS,
  });
  return {
    files: fallback.files,
    truncated: fallback.truncated,
    candidateCount: fallback.candidateCount ?? fallback.files.length,
    totalPathChars: fallback.totalPathChars ?? fallback.files.reduce((total, filePath) => total + filePath.length, 0),
    truncationReason: fallback.truncationReason,
    warnings: fallback.warnings ?? [],
    strategy: "node_fs",
    fallbackUsed: true,
    attempts,
  };
}

function createResult(
  toolName: string,
  context: RuntimeToolExecutionContext,
  success: boolean,
  output: string,
  structuredContent: Record<string, unknown>,
): ToolResult {
  const timestamp = context.moduleContext.clock.now();
  return {
    toolName,
    callId: context.callId,
    startedAt: timestamp,
    endedAt: timestamp,
    success,
    output,
    structuredContent,
    error: success ? undefined : output,
  };
}

async function readUtf8Prefix(
  filePath: string,
  maxChars: number,
): Promise<{ content: string; sizeBytes: number; truncated: boolean }> {
  const handle = await fs.open(filePath, "r");
  try {
    const stat = await handle.stat();
    if (!stat.isFile()) throw Object.assign(new Error("not_file"), { code: "EISDIR" });
    if (!(await isProbablyTextFile(filePath))) throw Object.assign(new Error("binary_file"), { code: "EBINARY" });
    const byteBudget = Math.min(stat.size, Math.max(4_096, maxChars * 4 + 4));
    const buffer = Buffer.alloc(byteBudget);
    const { bytesRead } = await handle.read(buffer, 0, buffer.length, 0);
    let decoded: string;
    try {
      decoded = new TextDecoder("utf-8", { fatal: true }).decode(
        buffer.subarray(0, bytesRead),
        { stream: stat.size > bytesRead },
      );
    } catch {
      throw Object.assign(new Error("invalid_utf8"), { code: "EENCODING" });
    }
    const content = decoded.slice(0, maxChars);
    return {
      content,
      sizeBytes: stat.size,
      truncated: stat.size > bytesRead || decoded.length > maxChars,
    };
  } finally {
    await handle.close();
  }
}

function readUtf8PrefixFromBuffer(
  buffer: Buffer,
  maxChars: number,
): { content: string; sizeBytes: number; truncated: boolean } {
  const byteBudget = Math.min(buffer.byteLength, Math.max(4_096, maxChars * 4 + 4));
  let decoded: string;
  try {
    decoded = new TextDecoder("utf-8", { fatal: true }).decode(
      buffer.subarray(0, byteBudget),
      { stream: buffer.byteLength > byteBudget },
    );
  } catch {
    throw Object.assign(new Error("invalid_utf8"), { code: "EENCODING" });
  }
  const content = decoded.slice(0, maxChars);
  return {
    content,
    sizeBytes: buffer.byteLength,
    truncated: buffer.byteLength > byteBudget || decoded.length > maxChars,
  };
}

function safeReadFailure(error: unknown): { status: Exclude<ReadManyStatus, "ok" | "budget_exhausted">; message: string } {
  const value = error as NodeJS.ErrnoException;
  if (value.code === "EBINARY") return { status: "binary", message: "Binary content was not read." };
  if (value.code === "EENCODING") return { status: "error", message: "The file is not valid UTF-8 text." };
  if (value.code === "EIGNORED") return { status: "ignored", message: "The path is excluded by repository ignore rules." };
  if (value.code === "ENOENT") return { status: "error", message: "File not found." };
  if (value.code === "EISDIR" || value.code === "ENOTDIR") {
    return { status: "error", message: "The path is not a readable regular file." };
  }
  if (value.message.includes("protected") || value.message.includes("escapes")) {
    return { status: "error", message: "The path is outside the readable repository boundary or is protected." };
  }
  return { status: "error", message: "The file could not be read safely." };
}

function summarizeContent(content: string, truncated: boolean): string {
  const firstLine = content.split(/\r?\n/).map((line) => line.trim()).find(Boolean) ?? "Empty text file.";
  const preview = firstLine.length > 160 ? `${firstLine.slice(0, 157)}...` : firstLine;
  return truncated ? `${preview} (truncated)` : preview;
}

async function readOneFile(input: {
  requestedPath: string;
  charBudget: number;
  context: RuntimeToolExecutionContext;
  ignoreResolver: RepositoryIgnoreResolver;
}): Promise<ReadManyFileResult> {
  try {
    const resolved = await input.context.moduleContext.paths.resolveReadable(input.requestedPath);
    const displayPath = resolved.workspaceRelativePath ?? resolved.artifactRef ?? input.requestedPath;
    if (
      resolved.workspaceRelativePath &&
      await input.ignoreResolver.isIgnored(resolved.workspaceRelativePath, false)
    ) {
      throw Object.assign(new Error("ignored_path"), { code: "EIGNORED" });
    }
    const guardedStat = await fs.stat(resolved.absolutePath);
    if (!guardedStat.isFile()) throw Object.assign(new Error("not_file"), { code: "EISDIR" });
    const readableRef = resolved.workspaceRelativePath ? `file://${resolved.workspaceRelativePath}` : resolved.artifactRef;
    if (input.charBudget <= 0) {
      return {
        path: displayPath,
        ref: readableRef,
        status: "budget_exhausted",
        success: false,
        charsRead: 0,
        sizeBytes: guardedStat.size,
        truncated: true,
        summary: "The total character budget was exhausted after the path guard was applied.",
      };
    }
    const read = resolved.artifactRef
      ? readUtf8PrefixFromBuffer(await resolved.readBytes(), input.charBudget)
      : await readUtf8Prefix(resolved.absolutePath, input.charBudget);
    return {
      path: displayPath,
      ref: readableRef,
      status: "ok",
      success: true,
      content: read.content,
      charsRead: read.content.length,
      sizeBytes: read.sizeBytes,
      truncated: read.truncated,
      summary: summarizeContent(read.content, read.truncated),
    };
  } catch (error) {
    const failure = safeReadFailure(error);
    return {
      path: input.requestedPath,
      status: failure.status,
      success: false,
      charsRead: 0,
      truncated: false,
      summary: failure.message,
      error: failure.message,
    };
  }
}

const globFilesTool: RuntimeToolSpec = {
  name: "glob_files",
  displayName: "Glob Files / 文件匹配",
  description: "Find repository files with multiple glob patterns, exclusions, ignore rules, and bounded stable results.",
  inputSchema: {
    type: "object",
    additionalProperties: false,
    required: ["globs"],
    properties: {
      cwd: { type: "string", minLength: 1, maxLength: 1_000 },
      globs: {
        type: "array",
        minItems: 1,
        maxItems: MAX_GLOBS,
        items: { type: "string", minLength: 1, maxLength: 500, pattern: "\\S" },
      },
      exclude: {
        type: "array",
        maxItems: MAX_EXCLUDES,
        items: { type: "string", minLength: 1, maxLength: 500, pattern: "\\S" },
      },
      maxDepth: { type: "integer", minimum: 0, maximum: 64, default: DEFAULT_MAX_DEPTH },
      maxResults: { type: "integer", minimum: 1, maximum: 5_000, default: DEFAULT_MAX_RESULTS },
    },
  },
  readOnly: true,
  permissionCategory: "read_only",
  sideEffectLevel: "none",
  timeoutCategory: "fast",
  groups: ["repository", "repository_enhancements"],
  selection: {
    groups: ["repository", "repository_enhancements"],
    keywords: [
      "glob files", "file glob", "matching files", "find file", "find filename", "filename",
      "file exists", "path exists", "文件匹配", "批量找文件", "查找文件名", "文件是否存在",
    ],
    attachmentExtensions: [],
    mimeTypes: [],
  },
  capabilityRequirements: [{
    name: "rg",
    required: false,
    fallback: "node_fs",
    reason: "Node traversal provides bounded repository globbing when ripgrep is unavailable.",
  }],
  resolveAccess: (rawArgs, context): ToolAccessRequest[] => [{
    kind: "filesystem_read",
    paths: [context.paths.normalize(((rawArgs ?? {}) as GlobFilesArgs).cwd ?? ".")],
    reason: "Traverse the requested workspace directory under repository ignore and path guards.",
  }],
  execute: async (rawArgs, context) => {
    const result = await discoverFiles(rawArgs as GlobFilesArgs, context);
    return createResult(
      "glob_files",
      context,
      true,
      [
        result.truncated
          ? `[glob_files truncated: returned ${result.files.length} path(s); omitted paths may exist. Do not infer absence from an unlisted path; narrow cwd/globs or verify with file_metadata.]`
          : `[glob_files complete: returned ${result.files.length} path(s) within the requested cwd/globs/depth and repository ignore rules.]`,
        result.files.length > 0 ? result.files.join("\n") : "No file paths matched within the requested scope.",
      ].join("\n"),
      {
        kind: "glob_files",
        cwd: normalizeRepositoryPath((rawArgs as GlobFilesArgs).cwd ?? "."),
        strategy: result.strategy,
        fallbackUsed: result.fallbackUsed,
        truncated: result.truncated,
        resultComplete: !result.truncated,
        pathExistenceWithinScopeEstablished: !result.truncated,
        candidateCount: result.candidateCount,
        selectedCount: result.files.length,
        totalPathChars: result.totalPathChars,
        omittedCount: Math.max(0, result.candidateCount - result.files.length),
        keyFiles: result.files.slice(0, 10),
        truncation: {
          truncated: result.truncated,
          reason: result.truncationReason,
          maxResults: (rawArgs as GlobFilesArgs).maxResults ?? DEFAULT_MAX_RESULTS,
          maxPathChars: DEFAULT_MAX_REPOSITORY_PATH_CHARS,
          maxTotalPathChars: DEFAULT_MAX_REPOSITORY_TOTAL_PATH_CHARS,
          omittedCountAtLeast: Math.max(0, result.candidateCount - result.files.length),
          omittedCountIsLowerBound: result.truncated,
        },
        files: result.files,
        matches: result.files.map((filePath) => ({ path: filePath, ref: `file://${filePath}` })),
        references: result.files.map((filePath) => `file://${filePath}`),
        artifactFriendly: {
          kind: "workspace_file_references",
          refs: result.files.map((filePath) => `file://${filePath}`),
        },
        attempts: result.attempts,
        warnings: result.warnings,
      },
    );
  },
};

const readManyFilesTool: RuntimeToolSpec = {
  name: "read_many_files",
  displayName: "Read Many Files / 批量读取文件",
  description: "Read multiple repository text files from paths and globs with per-file and total character budgets.",
  inputSchema: {
    type: "object",
    additionalProperties: false,
    anyOf: [{ required: ["paths"] }, { required: ["globs"] }],
    properties: {
      cwd: { type: "string", minLength: 1, maxLength: 1_000 },
      paths: {
        type: "array",
        minItems: 1,
        maxItems: 100,
        items: { type: "string", minLength: 1, maxLength: 2_000, pattern: "\\S" },
      },
      globs: {
        type: "array",
        minItems: 1,
        maxItems: MAX_GLOBS,
        items: { type: "string", minLength: 1, maxLength: 500, pattern: "\\S" },
      },
      exclude: {
        type: "array",
        maxItems: MAX_EXCLUDES,
        items: { type: "string", minLength: 1, maxLength: 500, pattern: "\\S" },
      },
      maxDepth: { type: "integer", minimum: 0, maximum: 64, default: DEFAULT_MAX_DEPTH },
      maxFiles: { type: "integer", minimum: 1, maximum: 100, default: DEFAULT_READ_MAX_FILES },
      maxCharsPerFile: { type: "integer", minimum: 1, maximum: MAX_READ_MANY_CHARS, default: DEFAULT_READ_MAX_CHARS_PER_FILE },
      maxTotalChars: { type: "integer", minimum: 1, maximum: MAX_READ_MANY_CHARS, default: DEFAULT_READ_MAX_TOTAL_CHARS },
    },
  },
  readOnly: true,
  permissionCategory: "read_only",
  sideEffectLevel: "none",
  timeoutCategory: "fast",
  groups: ["repository", "repository_enhancements"],
  selection: {
    groups: ["repository", "repository_enhancements"],
    keywords: ["read many files", "batch read", "multiple files", "批量读取", "读取多个文件"],
    attachmentExtensions: [...REPOSITORY_TEXT_ATTACHMENT_EXTENSIONS],
    mimeTypes: [...REPOSITORY_TEXT_ATTACHMENT_MIME_TYPES],
  },
  capabilityRequirements: [{
    name: "rg",
    required: false,
    fallback: "node_fs",
    reason: "Node traversal resolves glob inputs when ripgrep is unavailable.",
  }],
  resolveAccess: (rawArgs, context): ToolAccessRequest[] => [{
    kind: "filesystem_read",
    paths: [context.paths.normalize(((rawArgs ?? {}) as ReadManyFilesArgs).cwd ?? ".")],
    reason: "Read a bounded set of guarded repository files while preserving per-file failures.",
  }],
  execute: async (rawArgs, context) => {
    const args = rawArgs as ReadManyFilesArgs;
    const maxFiles = args.maxFiles ?? DEFAULT_READ_MAX_FILES;
    const maxCharsPerFile = args.maxCharsPerFile ?? DEFAULT_READ_MAX_CHARS_PER_FILE;
    const maxTotalChars = args.maxTotalChars ?? DEFAULT_READ_MAX_TOTAL_CHARS;
    const cwd = await resolveReadableDirectory(context, args.cwd ?? ".");
    const explicitPaths = normalizeExplicitPaths(
      args.paths ?? [],
      cwd.absolutePath,
      context.workspaceRoot,
    );
    let discovery: FileDiscoveryResult | undefined;
    if ((args.globs?.length ?? 0) > 0) {
      discovery = await discoverFiles({
        cwd: args.cwd,
        globs: args.globs!,
        exclude: args.exclude,
        maxDepth: args.maxDepth,
        maxResults: maxFiles,
      }, context);
    }
    const candidates = [...explicitPaths];
    for (const filePath of discovery?.files ?? []) {
      const key = candidateKey(filePath);
      if (!candidates.some((candidate) => candidateKey(candidate) === key)) {
        candidates.push(filePath);
      }
    }
    const discoveredOmittedCount = Math.max(
      0,
      (discovery?.candidateCount ?? 0) - (discovery?.files.length ?? 0),
    );
    const candidateCount = candidates.length + discoveredOmittedCount;
    const omittedPaths = candidates.slice(maxFiles, maxFiles + 10);
    const selectedCount = Math.min(candidates.length, maxFiles);
    const omittedCount = Math.max(0, candidateCount - selectedCount);
    const selectionTruncated = omittedCount > 0 || discovery?.truncated === true;
    candidates.length = Math.min(candidates.length, maxFiles);

    const ignoreResolver = new RepositoryIgnoreResolver(context.workspaceRoot);
    const results: ReadManyFileResult[] = [];
    let totalCharsRead = 0;
    for (const requestedPath of candidates) {
      const charBudget = Math.min(maxCharsPerFile, Math.max(0, maxTotalChars - totalCharsRead));
      const result = await readOneFile({ requestedPath, charBudget, context, ignoreResolver });
      results.push(result);
      totalCharsRead += result.charsRead;
    }

    const succeeded = results.filter((result) => result.success).length;
    const failed = results.length - succeeded;
    const keyFiles = results.filter((result) => result.success).slice(0, 10).map((result) => result.path);
    const contentTruncatedFiles = results.filter((result) => result.truncated).map((result) => result.path);
    const budgetExhaustedFiles = results
      .filter((result) => result.status === "budget_exhausted")
      .map((result) => result.path);
    const output = results.length === 0
      ? "No files were selected."
      : results.map((result) => {
          const header = `[${result.status}] ${result.path} | chars=${result.charsRead} | truncated=${String(result.truncated)}${result.ref ? ` | ref=${result.ref}` : ""}`;
          return result.content === undefined ? `${header}\n${result.summary}` : `${header}\n${result.content}`;
        }).join("\n\n");
    const artifactDescription = [
      `read_many_files selected ${selectedCount} of ${candidateCount} candidates`,
      `${succeeded} succeeded and ${failed} failed`,
      `${totalCharsRead} characters returned`,
      ...(selectionTruncated ? [`at least ${omittedCount} candidates omitted`] : []),
      ...(contentTruncatedFiles.length > 0 ? [`${contentTruncatedFiles.length} file contents truncated`] : []),
      ...(budgetExhaustedFiles.length > 0 ? [`${budgetExhaustedFiles.length} files skipped after budget exhaustion`] : []),
      ...(keyFiles.length > 0 ? [`key files: ${keyFiles.slice(0, 6).join(", ")}`] : []),
    ].join("; ");
    const outputWasTruncated = selectionTruncated ||
      contentTruncatedFiles.length > 0 ||
      budgetExhaustedFiles.length > 0;
    const outputArtifact = output.length >= READ_MANY_ARTIFACT_OUTPUT_THRESHOLD_CHARS || outputWasTruncated
      ? await context.moduleContext.persistence.storeToolOutputArtifact({
          sessionId: context.sessionId,
          turnId: context.turnId,
          toolCallId: context.callId,
          sourceToolName: "read_many_files",
          fileName: `read-many-files-${context.callId}.txt`,
          mimeType: "text/plain",
          kind: "text",
          summary: artifactDescription.slice(0, 320),
          content: output,
        })
      : undefined;
    const toolResult = createResult(
      "read_many_files",
      context,
      succeeded > 0 || results.length === 0,
      output,
      {
        kind: "read_many_files",
        summary: {
          candidateCount,
          selectedCount,
          omittedCount,
          succeeded,
          failed,
          totalCharsRead,
          maxCharsPerFile,
          maxTotalChars,
          selectionTruncated,
        },
        keyFiles,
        truncation: {
          selectionTruncated,
          discoveryTruncated: discovery?.truncated ?? false,
          contentTruncatedFiles,
          budgetExhaustedFiles,
          omittedCountAtLeast: omittedCount,
          omittedPaths,
          omittedCountIsLowerBound: discovery?.truncated ?? false,
        },
        references: results.flatMap((result) => result.ref ? [result.ref] : []),
        artifactFriendly: {
          kind: "workspace_file_read_results",
          refs: results.flatMap((result) => result.ref ? [result.ref] : []),
          canPersistOutputAsArtifact: true,
          outputArtifactUri: outputArtifact?.uri,
        },
        discovery: discovery ? {
          strategy: discovery.strategy,
          fallbackUsed: discovery.fallbackUsed,
          truncated: discovery.truncated,
          candidateCount: discovery.candidateCount,
          selectedCount: discovery.files.length,
          totalPathChars: discovery.totalPathChars,
          truncationReason: discovery.truncationReason,
          omittedCountAtLeast: Math.max(0, discovery.candidateCount - discovery.files.length),
          attempts: discovery.attempts,
          warnings: discovery.warnings,
        } : undefined,
        warnings: [...new Set([
          ...(discovery?.warnings ?? []),
          ...ignoreResolver.listWarnings(),
        ])].sort(comparePaths),
        files: results,
      },
    );
    return {
      ...toolResult,
      artifacts: outputArtifact ? [outputArtifact] : undefined,
    };
  },
};

const fileMetadataTool: RuntimeToolSpec = {
  name: "file_metadata",
  displayName: "File Metadata / 文件元数据",
  description: "Inspect guarded repository file or directory metadata with a bounded encoding sample and optional bounded SHA-256 hash.",
  inputSchema: {
    type: "object",
    additionalProperties: false,
    required: ["path"],
    properties: {
      path: { type: "string", minLength: 1, maxLength: 2_000, pattern: "\\S" },
      includeHash: { type: "boolean", default: false },
      hashMaxBytes: {
        type: "integer",
        minimum: 0,
        maximum: MAX_FILE_METADATA_HASH_BYTES,
        default: DEFAULT_FILE_METADATA_HASH_MAX_BYTES,
      },
    },
  },
  readOnly: true,
  permissionCategory: "read_only",
  sideEffectLevel: "none",
  timeoutCategory: "fast",
  groups: ["repository", "repository_enhancements", "metadata"],
  selection: {
    groups: ["repository", "repository_enhancements", "metadata"],
    keywords: [
      "file metadata", "file size", "modified time", "mime", "file exists", "path exists",
      "文件元数据", "文件大小", "修改时间", "文件是否存在", "路径是否存在",
    ],
    attachmentExtensions: [...REPOSITORY_TEXT_ATTACHMENT_EXTENSIONS],
    mimeTypes: [...REPOSITORY_TEXT_ATTACHMENT_MIME_TYPES],
  },
  capabilityRequirements: [],
  resolveAccess: (rawArgs, context): ToolAccessRequest[] => {
    const requestedPath = (rawArgs as FileMetadataArgs).path;
    if (requestedPath.startsWith("artifact://") || (requestedPath.includes("://") && !requestedPath.startsWith("file://"))) {
      throw new Error("file_metadata accepts workspace paths and file:// references only.");
    }
    return [{
      kind: "filesystem_read",
      paths: [context.paths.normalize(requestedPath)],
      reason: "Inspect bounded metadata for one guarded repository path.",
    }];
  },
  execute: async (rawArgs, context) => {
    const args = rawArgs as FileMetadataArgs;
    if (args.path.startsWith("artifact://")) {
      throw new Error("file_metadata accepts workspace paths and file:// references only.");
    }
    const requestedPath = args.path.startsWith("file://") ? args.path.slice("file://".length) : args.path;
    const lexicalAbsolutePath = context.moduleContext.paths.resolveWorkspace(requestedPath);
    await assertNoWorkspaceSymlinkComponents(context.workspaceRoot, lexicalAbsolutePath);
    const resolved = await context.moduleContext.paths.resolveReadable(requestedPath);
    if (!resolved.workspaceRelativePath) {
      throw new Error("file_metadata requires a repository path.");
    }
    const stat = await fs.lstat(resolved.absolutePath);
    if (stat.isSymbolicLink()) throw new Error("file_metadata does not follow symbolic links or junctions.");
    if (!stat.isFile() && !stat.isDirectory()) {
      throw new Error("file_metadata supports regular files and directories only.");
    }
    const ignoreResolver = new RepositoryIgnoreResolver(context.workspaceRoot);
    if (await ignoreResolver.isIgnored(resolved.workspaceRelativePath, stat.isDirectory())) {
      throw new Error("The requested path is excluded by repository ignore rules.");
    }

    const type = stat.isDirectory() ? "directory" : "file";
    let encodingHint: "utf-8" | "utf-16le" | "utf-16be" | "binary" | "unknown" | "not_applicable" = "not_applicable";
    let sampledBytes = 0;
    let hash: Record<string, unknown> = {
      requested: args.includeHash === true,
      computed: false,
      reason: args.includeHash === true ? "not_regular_file" : "not_requested",
    };
    if (stat.isFile()) {
      const handle = await fs.open(resolved.absolutePath, "r");
      try {
        const openStat = await handle.stat();
        if (!openStat.isFile()) throw new Error("file_metadata target changed during inspection.");
        if (openStat.size !== stat.size || openStat.mtimeMs !== stat.mtimeMs) {
          throw new Error("file_metadata target changed during inspection.");
        }
        const sample = Buffer.alloc(Math.min(FILE_METADATA_SAMPLE_BYTES, openStat.size));
        if (sample.length > 0) {
          const read = await handle.read(sample, 0, sample.length, 0);
          sampledBytes = read.bytesRead;
          encodingHint = inferEncodingHint(
            sample.subarray(0, read.bytesRead),
            openStat.size > read.bytesRead,
          );
        } else {
          encodingHint = "utf-8";
        }
        if (args.includeHash === true) {
          const hashMaxBytes = args.hashMaxBytes ?? DEFAULT_FILE_METADATA_HASH_MAX_BYTES;
          if (openStat.size <= hashMaxBytes) {
            hash = {
              requested: true,
              computed: true,
              algorithm: "sha256",
              value: await hashOpenFile(handle, openStat.size),
              maxBytes: hashMaxBytes,
            };
          } else {
            hash = {
              requested: true,
              computed: false,
              reason: "size_limit",
              maxBytes: hashMaxBytes,
            };
          }
        }
      } finally {
        await handle.close();
      }
    }

    const metadata = {
      kind: "file_metadata",
      path: resolved.workspaceRelativePath,
      ref: `file://${resolved.workspaceRelativePath}`,
      type,
      sizeBytes: stat.size,
      modifiedAt: stat.mtime.toISOString(),
      mimeType: inferMimeType(resolved.workspaceRelativePath, stat.isDirectory()),
      encodingHint,
      sample: {
        bytesRead: sampledBytes,
        maxBytes: FILE_METADATA_SAMPLE_BYTES,
        contentReturned: false,
      },
      hash,
      warnings: ignoreResolver.listWarnings(),
    };
    return createResult(
      "file_metadata",
      context,
      true,
      JSON.stringify(metadata),
      metadata,
    );
  },
};

export const repositoryEnhancementsToolModule: ToolModule = {
  manifest: {
    id: "builtin.repository.enhancements",
    version: "1.0.0",
    description: "Bounded repository glob discovery, multi-file reading, and metadata tools.",
    source: "built_in",
  },
  create: () => [globFilesTool, readManyFilesTool, fileMetadataTool],
};
