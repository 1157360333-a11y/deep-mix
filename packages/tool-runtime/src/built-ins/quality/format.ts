import { createHash } from "node:crypto";
import { promises as fs } from "node:fs";
import path from "node:path";

import type {
  ToolOutputArtifact,
  ToolPermissionProfile,
  ToolResult,
  ToolStructuredError,
} from "../../../../shared-schema/src/index.js";
import { redactProcessText, summarizeProcessCommand } from "../../process-manager.js";
import type {
  RuntimeToolExecutionContext,
  RuntimeToolSpec,
  ToolAccessResolutionContext,
  ToolProcessResult,
} from "../../tool-module.js";

type FormatMode = "check" | "write";

interface FormatArguments {
  mode: FormatMode;
  command?: string;
  args?: string[];
  cwd?: string;
  paths?: string[];
  timeoutMs?: number;
}

interface FormatInvocation {
  file: string;
  args: string[];
  source: "explicit" | "package_script";
  scriptName?: string;
  commandSummary: string;
}

interface FileSnapshot {
  relativePath: string;
  sizeBytes: number;
  sha256: string;
  text?: string;
}

interface FormatDiff {
  changedFiles: string[];
  unchangedFiles: number;
  preview: string;
  full: string;
  truncated: boolean;
}

interface WorkspaceInventory {
  files: Map<string, { sizeBytes: number; sha256: string }>;
  directories: Set<string>;
  symlinks: Set<string>;
}

interface WorkspaceInventoryChanges {
  addedFiles: string[];
  addedDirectories: string[];
  addedSymlinks: string[];
  removedFiles: string[];
  modifiedFiles: string[];
}

const FORMAT_SCHEMA = {
  type: "object",
  additionalProperties: false,
  required: ["mode"],
  properties: {
    mode: { type: "string", enum: ["check", "write"] },
    command: { type: "string", minLength: 1, maxLength: 4096 },
    args: {
      type: "array",
      maxItems: 128,
      items: { type: "string", minLength: 1, maxLength: 8192 },
    },
    cwd: { type: "string" },
    paths: {
      type: "array",
      minItems: 1,
      maxItems: 64,
      uniqueItems: true,
      items: { type: "string", minLength: 1, maxLength: 2048 },
    },
    timeoutMs: { type: "integer", minimum: 1000, maximum: 300000 },
  },
} as const;

const TEXT_EXTENSIONS = new Set([
  "",
  ".c",
  ".cc",
  ".conf",
  ".cpp",
  ".css",
  ".go",
  ".graphql",
  ".h",
  ".hpp",
  ".html",
  ".java",
  ".js",
  ".json",
  ".jsx",
  ".less",
  ".md",
  ".mdx",
  ".mjs",
  ".py",
  ".rb",
  ".rs",
  ".scss",
  ".sh",
  ".sql",
  ".svelte",
  ".toml",
  ".ts",
  ".tsx",
  ".txt",
  ".vue",
  ".xml",
  ".yaml",
  ".yml",
]);
const EXCLUDED_DIRECTORIES = new Set([
  ".deep-mix",
  ".git",
  ".next",
  "build",
  "coverage",
  "dist",
  "node_modules",
  "out",
  "target",
]);
const MAX_TARGET_FILES = 512;
const MAX_TARGET_BYTES = 16 * 1024 * 1024;
const MAX_CAPTURE_TEXT_BYTES = 256 * 1024;
const MAX_CAPTURE_TEXT_TOTAL = 2 * 1024 * 1024;
const MAX_INLINE_DIFF_CHARS = 12_000;
const MAX_FULL_DIFF_CHARS = 2_000_000;
const FULL_COMMAND_OUTPUT_CHARS = 2_000_000;
const ARTIFACT_COMMAND_OUTPUT_THRESHOLD_CHARS = 16_384;
const MAX_INLINE_FILE_PATHS = 50;
const MAX_FILE_LIST_ARTIFACT_CHARS = 2_000_000;
const MAX_AUDIT_FILES = 4_096;
const MAX_AUDIT_DIRECTORIES = 8_192;
const MAX_AUDIT_BYTES = 64 * 1024 * 1024;

class FormatCapabilityError extends Error {
  public readonly code = "ERR_TOOL_MISSING_DEPENDENCY";

  public constructor(message: string) {
    super(message);
    this.name = "FormatCapabilityError";
  }
}

function normalizeRelative(value: string): string {
  return value.replace(/\\/gu, "/") || ".";
}

function insideWorkspace(workspaceRoot: string, candidate: string): string {
  const absolute = path.resolve(workspaceRoot, candidate);
  const relative = path.relative(workspaceRoot, absolute);
  if (relative.startsWith("..") || path.isAbsolute(relative)) {
    throw new Error(`Format path escapes workspace root: ${candidate}.`);
  }
  return absolute;
}

async function enumerateFormatTargets(
  workspaceRoot: string,
  requestedPaths: readonly string[],
): Promise<string[]> {
  const collected: string[] = [];
  let totalBytes = 0;
  const visit = async (absolutePath: string): Promise<void> => {
    if (collected.length >= MAX_TARGET_FILES) {
      throw new Error(`Format target analysis exceeds ${MAX_TARGET_FILES} files.`);
    }
    const stat = await fs.lstat(absolutePath);
    if (stat.isSymbolicLink()) throw new Error("Format targets cannot contain symbolic links or junctions.");
    if (stat.isDirectory()) {
      const entries = await fs.readdir(absolutePath, { withFileTypes: true });
      for (const entry of entries.sort((left, right) => left.name.localeCompare(right.name))) {
        if (EXCLUDED_DIRECTORIES.has(entry.name)) continue;
        await visit(path.join(absolutePath, entry.name));
      }
      return;
    }
    if (!stat.isFile()) throw new Error("Format targets must be regular files or directories.");
    if (!TEXT_EXTENSIONS.has(path.extname(absolutePath).toLocaleLowerCase("en-US"))) return;
    totalBytes += stat.size;
    if (totalBytes > MAX_TARGET_BYTES) {
      throw new Error(`Format target analysis exceeds ${MAX_TARGET_BYTES} bytes.`);
    }
    collected.push(normalizeRelative(path.relative(workspaceRoot, absolutePath)));
  };

  for (const requested of requestedPaths) {
    await visit(insideWorkspace(workspaceRoot, requested));
  }
  const unique = [...new Set(collected)].sort();
  if (unique.length === 0) throw new Error("No bounded text files matched the requested format paths.");
  return unique;
}

async function captureWorkspaceInventory(
  workspaceRoot: string,
  requestedPaths: readonly string[],
  allowMissingRoots = false,
  captureSymlinks = false,
): Promise<WorkspaceInventory> {
  const files = new Map<string, { sizeBytes: number; sha256: string }>();
  const directories = new Set<string>();
  const symlinks = new Set<string>();
  let totalBytes = 0;

  const visit = async (absolutePath: string): Promise<void> => {
    const stat = await fs.lstat(absolutePath);
    const relativePath = normalizeRelative(path.relative(workspaceRoot, absolutePath));
    if (stat.isSymbolicLink()) {
      if (captureSymlinks) {
        symlinks.add(relativePath);
        return;
      }
      throw new Error("Format write audit cannot cross symbolic links or junctions.");
    }
    if (stat.isDirectory()) {
      if (relativePath !== ".") directories.add(relativePath);
      if (directories.size > MAX_AUDIT_DIRECTORIES) {
        throw new Error(`Format write audit exceeds ${MAX_AUDIT_DIRECTORIES} directories.`);
      }
      const entries = await fs.readdir(absolutePath, { withFileTypes: true });
      for (const entry of entries.sort((left, right) => left.name.localeCompare(right.name))) {
        if (EXCLUDED_DIRECTORIES.has(entry.name)) continue;
        await visit(path.join(absolutePath, entry.name));
      }
      return;
    }
    if (!stat.isFile()) throw new Error("Format write audit supports only regular files and directories.");
    if (files.has(relativePath)) return;
    if (files.size >= MAX_AUDIT_FILES) {
      throw new Error(`Format write audit exceeds ${MAX_AUDIT_FILES} files.`);
    }
    totalBytes += stat.size;
    if (totalBytes > MAX_AUDIT_BYTES) {
      throw new Error(`Format write audit exceeds ${MAX_AUDIT_BYTES} bytes.`);
    }
    const content = await fs.readFile(absolutePath);
    files.set(relativePath, {
      sizeBytes: content.byteLength,
      sha256: createHash("sha256").update(content).digest("hex"),
    });
  };

  for (const requestedPath of requestedPaths) {
    try {
      await visit(insideWorkspace(workspaceRoot, requestedPath));
    } catch (error) {
      if (allowMissingRoots && (error as NodeJS.ErrnoException).code === "ENOENT") continue;
      throw error;
    }
  }
  return { files, directories, symlinks };
}

function compareWorkspaceInventories(
  before: WorkspaceInventory,
  after: WorkspaceInventory,
): WorkspaceInventoryChanges {
  const addedFiles = [...after.files.keys()].filter((entry) => !before.files.has(entry)).sort();
  const addedDirectories = [...after.directories].filter((entry) => !before.directories.has(entry)).sort();
  const addedSymlinks = [...after.symlinks].filter((entry) => !before.symlinks.has(entry)).sort();
  const removedFiles = [...before.files.keys()].filter((entry) => !after.files.has(entry)).sort();
  const modifiedFiles = [...before.files]
    .filter(([relativePath, previous]) => {
      const current = after.files.get(relativePath);
      return current && (current.sha256 !== previous.sha256 || current.sizeBytes !== previous.sizeBytes);
    })
    .map(([relativePath]) => relativePath)
    .sort();
  return { addedFiles, addedDirectories, addedSymlinks, removedFiles, modifiedFiles };
}

async function removeAddedInventoryEntries(
  workspaceRoot: string,
  changes: WorkspaceInventoryChanges,
): Promise<void> {
  for (const relativePath of changes.addedFiles) {
    await fs.rm(insideWorkspace(workspaceRoot, relativePath), { force: true });
  }
  for (const relativePath of changes.addedSymlinks) {
    await fs.rm(insideWorkspace(workspaceRoot, relativePath), { force: true });
  }
  for (const relativePath of [...changes.addedDirectories].sort((left, right) => right.length - left.length)) {
    await fs.rm(insideWorkspace(workspaceRoot, relativePath), { recursive: true, force: true });
  }
}

async function readPackageScripts(
  cwd: string,
  workspaceRoot: string,
  paths: ToolAccessResolutionContext["paths"],
): Promise<Record<string, string>> {
  try {
    const relativePath = normalizeRelative(path.relative(workspaceRoot, path.join(cwd, "package.json")));
    const source = await paths.resolveReadable(relativePath);
    const parsed = JSON.parse((await source.readBytes()).toString("utf8")) as {
      scripts?: Record<string, unknown>;
    };
    return Object.fromEntries(
      Object.entries(parsed.scripts ?? {}).filter((entry): entry is [string, string] => typeof entry[1] === "string"),
    );
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return {};
    throw new FormatCapabilityError(`Cannot inspect package.json format scripts: ${(error as Error).message}`);
  }
}

async function resolveInvocation(
  args: FormatArguments,
  context: ToolAccessResolutionContext | RuntimeToolExecutionContext,
  targetFiles: readonly string[],
): Promise<FormatInvocation> {
  const services = "moduleContext" in context ? context.moduleContext : context;
  const cwd = services.paths.resolveWorkspace(args.cwd ?? ".");
  const pathArgs = targetFiles.map((relativePath) => normalizeRelative(path.relative(cwd, path.resolve(context.workspaceRoot, relativePath))));
  if (args.command) {
    const commandArgs = [...(args.args ?? []), ...pathArgs];
    return {
      file: args.command,
      args: commandArgs,
      source: "explicit",
      commandSummary: summarizeProcessCommand(args.command, commandArgs),
    };
  }

  const scripts = await readPackageScripts(cwd, context.workspaceRoot, services.paths);
  const priorities = args.mode === "check" ? ["format:check", "format-check"] : ["format:write", "format"];
  const scriptName = priorities.find((candidate) => typeof scripts[candidate] === "string");
  if (!scriptName) {
    throw new FormatCapabilityError(
      args.mode === "check"
        ? "No trusted format:check or format-check package script was found; provide an explicit formatter command."
        : "No trusted format:write or format package script was found; provide an explicit formatter command.",
    );
  }
  const npm = await services.capabilities.get("npm");
  if (!npm?.available) {
    throw new FormatCapabilityError("The trusted package format script requires npm, but npm is unavailable.");
  }
  const commandArgs = ["run", scriptName, ...(pathArgs.length > 0 ? ["--", ...pathArgs] : [])];
  return {
    file: npm.command,
    args: commandArgs,
    source: "package_script",
    scriptName,
    commandSummary: summarizeProcessCommand(npm.command, commandArgs),
  };
}

async function captureSnapshots(
  workspaceRoot: string,
  relativePaths: readonly string[],
  allowMissing = false,
): Promise<Map<string, FileSnapshot>> {
  const snapshots = new Map<string, FileSnapshot>();
  let capturedTextBytes = 0;
  for (const relativePath of relativePaths) {
    const absolutePath = insideWorkspace(workspaceRoot, relativePath);
    let content: Buffer;
    try {
      content = await fs.readFile(absolutePath);
    } catch (error) {
      if (allowMissing && (error as NodeJS.ErrnoException).code === "ENOENT") continue;
      throw error;
    }
    const text =
      content.byteLength <= MAX_CAPTURE_TEXT_BYTES &&
      capturedTextBytes + content.byteLength <= MAX_CAPTURE_TEXT_TOTAL &&
      !content.includes(0)
        ? content.toString("utf8")
        : undefined;
    if (text !== undefined) capturedTextBytes += content.byteLength;
    snapshots.set(relativePath, {
      relativePath,
      sizeBytes: content.byteLength,
      sha256: createHash("sha256").update(content).digest("hex"),
      text,
    });
  }
  return snapshots;
}

function createUnifiedDiff(relativePath: string, before: string, after: string): string {
  const beforeLines = before.split(/\r?\n/u);
  const afterLines = after.split(/\r?\n/u);
  let prefix = 0;
  while (prefix < beforeLines.length && prefix < afterLines.length && beforeLines[prefix] === afterLines[prefix]) {
    prefix += 1;
  }
  let suffix = 0;
  while (
    suffix < beforeLines.length - prefix &&
    suffix < afterLines.length - prefix &&
    beforeLines[beforeLines.length - 1 - suffix] === afterLines[afterLines.length - 1 - suffix]
  ) {
    suffix += 1;
  }
  const beforeChanged = beforeLines.slice(prefix, beforeLines.length - suffix);
  const afterChanged = afterLines.slice(prefix, afterLines.length - suffix);
  const body = [
    `--- a/${relativePath}`,
    `+++ b/${relativePath}`,
    `@@ -${prefix + 1},${beforeChanged.length} +${prefix + 1},${afterChanged.length} @@`,
    ...beforeChanged.map((line) => `-${line}`),
    ...afterChanged.map((line) => `+${line}`),
  ];
  return body.join("\n");
}

function compareSnapshots(
  before: Map<string, FileSnapshot>,
  after: Map<string, FileSnapshot>,
): FormatDiff {
  const changedFiles: string[] = [];
  const blocks: string[] = [];
  for (const [relativePath, previous] of before) {
    const current = after.get(relativePath);
    if (current?.sha256 === previous.sha256) continue;
    changedFiles.push(relativePath);
    if (previous.text !== undefined && current?.text !== undefined) {
      blocks.push(createUnifiedDiff(relativePath, previous.text, current.text));
    } else {
      blocks.push([
        `--- a/${relativePath}`,
        `+++ b/${relativePath}`,
        `@@ binary-or-large-file @@`,
        `-sha256 ${previous.sha256} size ${previous.sizeBytes}`,
        `+sha256 ${current?.sha256 ?? "missing"} size ${current?.sizeBytes ?? 0}`,
      ].join("\n"));
    }
  }
  const fullUnbounded = blocks.join("\n\n");
  const full = fullUnbounded.slice(0, MAX_FULL_DIFF_CHARS);
  return {
    changedFiles,
    unchangedFiles: Math.max(0, before.size - changedFiles.length),
    preview: full.slice(0, MAX_INLINE_DIFF_CHARS),
    full,
    truncated: fullUnbounded.length > full.length,
  };
}

function keyErrors(result: ToolProcessResult): string[] {
  return redactProcessText(`${result.stderr}\n${result.stdout}`)
    .split(/\r?\n/u)
    .map((line) => line.trim())
    .filter((line) => /\b(?:error|failed|failure|fatal)\b/iu.test(line))
    .slice(0, 20)
    .map((line) => line.slice(0, 500));
}

function formatError(
  type: ToolStructuredError["type"],
  message: string,
  command?: string,
  exitCode?: number,
): ToolStructuredError {
  return {
    type,
    message: redactProcessText(message).slice(0, FULL_COMMAND_OUTPUT_CHARS),
    retryable: type !== "missing_dependency" && type !== "invalid_arguments",
    toolName: "format",
    command,
    exitCode,
  };
}

async function persistTextArtifact(input: {
  context: RuntimeToolExecutionContext;
  fileName: string;
  summary: string;
  content: string;
}): Promise<ToolOutputArtifact> {
  return input.context.moduleContext.persistence.storeToolOutputArtifact({
    sessionId: input.context.sessionId,
    namespace: "quality",
    turnId: input.context.turnId,
    toolCallId: input.context.callId,
    sourceToolName: "format",
    fileName: input.fileName,
    mimeType: "text/plain",
    kind: "text",
    summary: input.summary,
    content: input.content,
    signal: input.context.signal,
  });
}

async function executeFormat(
  args: FormatArguments,
  context: RuntimeToolExecutionContext,
): Promise<ToolResult> {
  const startedAt = context.moduleContext.clock.now();
  const startedMs = Date.now();
  let commandSummary: string | undefined;
  try {
    if (args.mode === "write" && (!args.paths || args.paths.length === 0)) {
      throw new Error("format write requires explicit bounded paths before approval and checkpoint creation.");
    }
    const targets = args.paths
      ? await enumerateFormatTargets(context.workspaceRoot, args.paths)
      : [];
    const invocation = await resolveInvocation(args, context, targets);
    commandSummary = invocation.commandSummary;
    const before = args.mode === "write" ? await captureSnapshots(context.workspaceRoot, targets) : new Map();
    // Both check and write execute an external command. Audit the bounded
    // workspace for either mode so a misconfigured "check" cannot mutate files
    // under the lower run-tests permission category.
    const auditRoots = ["."];
    const inventoryBefore = await captureWorkspaceInventory(context.workspaceRoot, auditRoots);
    if (inventoryBefore.files.size > 0 && !context.checkpoint) {
      throw new Error(`format ${args.mode} requires a Runtime checkpoint before the formatter starts.`);
    }
    const result = await context.moduleContext.processes.run({
      command: invocation.file,
      args: invocation.args,
      mode: "direct",
      cwd: context.moduleContext.paths.resolveWorkspace(args.cwd ?? "."),
      timeoutMs: args.timeoutMs ?? 120_000,
      maxOutputChars: FULL_COMMAND_OUTPUT_CHARS,
      signal: context.signal,
    });
    const inventoryAfter = await captureWorkspaceInventory(context.workspaceRoot, auditRoots, true, true);
    const inventoryChanges = compareWorkspaceInventories(inventoryBefore, inventoryAfter);
    if (inventoryChanges && (
      inventoryChanges.addedFiles.length > 0 ||
      inventoryChanges.addedDirectories.length > 0 ||
      inventoryChanges.addedSymlinks.length > 0
    )) {
      // Existing files are restored by the Runtime checkpoint when this tool
      // returns failure. Newly-created entries did not exist in that snapshot,
      // so remove them here before reporting an audit violation.
      await removeAddedInventoryEntries(context.workspaceRoot, inventoryChanges);
    }
    context.signal?.throwIfAborted();
    const after = args.mode === "write" ? await captureSnapshots(context.workspaceRoot, targets, true) : new Map();
    const diff = args.mode === "write" ? compareSnapshots(before, after) : undefined;
    const redactedOutput = redactProcessText(
      [result.stdout.trimEnd(), result.stderr.trimEnd()].filter(Boolean).join("\n"),
    );
    const artifacts: ToolOutputArtifact[] = [];
    if (redactedOutput.length > ARTIFACT_COMMAND_OUTPUT_THRESHOLD_CHARS || result.outputTruncated) {
      artifacts.push(await persistTextArtifact({
        context,
        fileName: `format-output-${context.callId}.log`,
        summary: "Full redacted formatter output captured by the tool",
        content: redactedOutput,
      }));
    }
    if (diff && (diff.full.length > MAX_INLINE_DIFF_CHARS || diff.truncated)) {
      artifacts.push(await persistTextArtifact({
        context,
        fileName: `format-diff-${context.callId}.diff`,
        summary: `Bounded formatter diff for ${diff.changedFiles.length} file(s)`,
        content: diff.full,
      }));
    }
    const targetSet = new Set(targets);
    const existingChanges = [...inventoryChanges.modifiedFiles, ...inventoryChanges.removedFiles].sort();
    const outOfScopeChanges = args.mode === "check"
      ? existingChanges
      : existingChanges.filter((relativePath) => !targetSet.has(relativePath));
    const createdEntries = [
      ...inventoryChanges.addedFiles,
      ...inventoryChanges.addedDirectories,
      ...inventoryChanges.addedSymlinks,
    ].sort();
    if (
      targets.length > MAX_INLINE_FILE_PATHS ||
      (diff?.changedFiles.length ?? 0) > MAX_INLINE_FILE_PATHS ||
      outOfScopeChanges.length > MAX_INLINE_FILE_PATHS ||
      createdEntries.length > MAX_INLINE_FILE_PATHS
    ) {
      const fileListContent = JSON.stringify({
        targetFiles: targets,
        changedFiles: diff?.changedFiles ?? [],
        outOfScopeChanges,
        createdEntries,
      }, null, 2);
      const boundedFileListContent = fileListContent.length > MAX_FILE_LIST_ARTIFACT_CHARS
        ? `${fileListContent.slice(0, MAX_FILE_LIST_ARTIFACT_CHARS - 16)}\n[TRUNCATED]\n`
        : fileListContent;
      artifacts.push(await persistTextArtifact({
        context,
        fileName: `format-files-${context.callId}.txt`,
        summary: "Bounded full formatter target and audit file lists",
        content: boundedFileListContent,
      }));
    }
    const exitCode = result.exitCode ?? -1;
    let error =
      !result.spawnError && !result.timedOut && exitCode === 0
        ? undefined
        : result.timedOut
          ? formatError("timeout", "Formatter timed out.", commandSummary, exitCode)
          : result.spawnError?.code === "ENOENT"
            ? formatError(
                "missing_dependency",
                "The requested formatter executable is unavailable; install or configure it explicitly outside this tool.",
                commandSummary,
              )
            : formatError(
                "command_failed",
                result.spawnError?.message ?? `Formatter exited with code ${exitCode}.`,
                commandSummary,
                exitCode,
              );
    if (!error && (outOfScopeChanges.length > 0 || createdEntries.length > 0)) {
      error = formatError(
        "invalid_state",
        args.mode === "check"
          ? `Formatter check mutated ${outOfScopeChanges.length} existing file(s) and created ${createdEntries.length} workspace entr${createdEntries.length === 1 ? "y" : "ies"}; the operation was rolled back.`
          : `Formatter changed ${outOfScopeChanges.length} file(s) outside the approved targets and created ${createdEntries.length} unsupported workspace entr${createdEntries.length === 1 ? "y" : "ies"}; the operation was rolled back.`,
        commandSummary,
        exitCode,
      );
    }
    const capabilityUnavailable = error?.type === "missing_dependency";
    const structuredContent = {
      kind: "format",
      mode: args.mode,
      source: invocation.source,
      scriptName: invocation.scriptName,
      commandSummary,
      cwd: normalizeRelative(args.cwd ?? "."),
      targetFiles: targets,
      targetFileCount: targets.length,
      targetFilesTruncated: false,
      exitCode,
      durationMs: Date.now() - startedMs,
      ok: !error,
      capabilityAvailable: !capabilityUnavailable,
      suggestion: capabilityUnavailable
        ? "Provide an available formatter executable or define a trusted package format script; dependencies are never installed automatically."
        : undefined,
      dependencyInstallAttempted: false,
      packageConfigurationModified: false,
      wouldChange: args.mode === "check" && (
        exitCode !== 0 || outOfScopeChanges.length > 0 || createdEntries.length > 0
      ),
      output: redactedOutput,
      outputTruncated: Boolean(result.outputTruncated),
      keyErrors: keyErrors(result),
      checkpointId: context.checkpoint?.checkpointId,
      undoAvailable: args.mode === "write" && Boolean(context.checkpoint) && !error,
      restoreOnFailure: Boolean(context.checkpoint) && Boolean(error),
      writeAudit: {
        mode: args.mode,
        scope: "bounded_workspace",
        auditedFileCount: inventoryBefore.files.size,
        outOfScopeChanges,
        outOfScopeChangeCount: outOfScopeChanges.length,
        createdEntries,
        createdEntryCount: createdEntries.length,
        rolledBackCreatedEntries: createdEntries.length > 0,
      },
      diff: diff
        ? {
            changedFiles: diff.changedFiles,
            changedFileCount: diff.changedFiles.length,
            changedFilesTruncated: false,
            unchangedFiles: diff.unchangedFiles,
            preview: diff.preview,
            full: diff.full,
            truncated: diff.truncated,
          }
        : undefined,
      artifactUris: artifacts.map((artifact) => artifact.uri),
      ...(error ? { error } : {}),
    };
    return {
      toolName: "format",
      callId: context.callId,
      startedAt,
      endedAt: context.moduleContext.clock.now(),
      success: !error,
      output: JSON.stringify(structuredContent),
      structuredContent,
      artifacts,
      error: error?.message,
    };
  } catch (error) {
    const capability = error instanceof FormatCapabilityError;
    const structured = formatError(
      capability ? "missing_dependency" : "invalid_arguments",
      (error as Error).message,
      commandSummary,
    );
    const body = {
      kind: "format",
      mode: args.mode,
      capabilityAvailable: !capability,
      suggestion: capability
        ? "Provide an explicit formatter executable or define a trusted package format script; dependencies are never installed automatically."
        : undefined,
      dependencyInstallAttempted: false,
      packageConfigurationModified: false,
      error: structured,
    };
    return {
      toolName: "format",
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

async function resolveFormatTargetsForAccess(
  args: FormatArguments,
  context: ToolAccessResolutionContext,
): Promise<string[]> {
  if (!args.paths) return [];
  return enumerateFormatTargets(context.workspaceRoot, args.paths);
}

export const formatTool: RuntimeToolSpec = {
  name: "format",
  description: "Run a bounded formatter check or checkpointed workspace write over explicitly analyzed paths.",
  inputSchema: FORMAT_SCHEMA,
  readOnly: false,
  permissionCategory: "write_file",
  sideEffectLevel: "high",
  timeoutCategory: "slow",
  groups: ["quality", "commands"],
  selection: {
    groups: ["quality", "commands"],
    keywords: ["format", "formatter", "prettier", "format check", "format write", "格式化", "格式检查"],
    workerRoutes: ["coding"],
  },
  resolveAccess: async (rawArgs, context) => {
    const args = rawArgs as FormatArguments;
    if (args.mode === "write" && (!args.paths || args.paths.length === 0)) {
      throw new Error("format write requires explicit bounded paths.");
    }
    const targets = await resolveFormatTargetsForAccess(args, context);
    const invocation = await resolveInvocation(args, context, targets);
    const auditInventory = await captureWorkspaceInventory(context.workspaceRoot, ["."]);
    const checkpointPaths = [...new Set([
      ...targets,
      ...auditInventory.files.keys(),
    ])].sort();
    return [
      {
        kind: "command_execute",
        cwd: context.paths.normalize(args.cwd ?? "."),
        command: invocation.commandSummary,
        reason: `Run formatter in ${args.mode} mode inside the workspace sandbox.`,
      },
      {
        kind: "filesystem_write" as const,
        paths: checkpointPaths,
        reason: args.mode === "check"
          ? "Checkpoint the bounded auditable workspace so formatter check mutations can be rejected and restored."
          : "Checkpoint the bounded auditable workspace before formatter writes.",
      },
    ];
  },
  resolvePermission: (): ToolPermissionProfile => ({
    permissionCategory: "write_file",
    sideEffectLevel: "high",
    readOnly: false,
  }),
  redactArguments: (rawArgs) => {
    const args = rawArgs as FormatArguments;
    return {
      ...args,
      command: args.command ? redactProcessText(args.command) : undefined,
      args: args.args?.map((value) => redactProcessText(value)),
    };
  },
  formatPreExecutionFailure: (failure, rawArgs) => {
    const args = rawArgs as FormatArguments;
    const unavailable = /No trusted format|requires npm|unavailable/iu.test(failure.error.message);
    const error = unavailable
      ? { ...failure.error, type: "missing_dependency" as const, retryable: false }
      : failure.error;
    const body = {
      kind: "format",
      mode: args.mode,
      capabilityAvailable: !unavailable,
      suggestion: unavailable
        ? "Provide an explicit formatter executable or define a trusted package format script; dependencies are never installed automatically."
        : undefined,
      dependencyInstallAttempted: false,
      packageConfigurationModified: false,
      error,
    };
    return { output: JSON.stringify(body), structuredContent: body };
  },
  resolveExecutionTimeoutMs: (rawArgs) => Math.min(305_000, ((rawArgs as FormatArguments).timeoutMs ?? 120_000) + 5_000),
  checkpoint: {
    mode: "before_write",
    scope: "pre_tool_write",
    reason: "Before checkpointed formatter write",
    restoreOnFailure: true,
  },
  execute: (rawArgs, context) => executeFormat(rawArgs as FormatArguments, context),
};
