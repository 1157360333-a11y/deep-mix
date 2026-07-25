import { promises as fs } from "node:fs";
import path from "node:path";

import type {
  ToolOutputArtifact,
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

interface BuildArguments {
  command?: string;
  args?: string[];
  cwd?: string;
  timeoutMs?: number;
  outputDirectories?: string[];
}

interface BuildInvocation {
  file: string;
  args: string[];
  source: "explicit" | "package_script";
  scriptName?: string;
  commandSummary: string;
}

interface DirectorySnapshot {
  relativePath: string;
  exists: boolean;
  files: number;
  bytes: number;
  truncated: boolean;
}

const BUILD_SCHEMA = {
  type: "object",
  additionalProperties: false,
  properties: {
    command: { type: "string", minLength: 1, maxLength: 4096 },
    args: {
      type: "array",
      maxItems: 128,
      items: { type: "string", minLength: 1, maxLength: 8192 },
    },
    cwd: { type: "string" },
    timeoutMs: { type: "integer", minimum: 1000, maximum: 300000 },
    outputDirectories: {
      type: "array",
      maxItems: 32,
      uniqueItems: true,
      items: { type: "string", minLength: 1, maxLength: 2048 },
    },
  },
} as const;

const COMMON_OUTPUT_DIRECTORIES = ["dist", "build", "out", "target", ".next"] as const;
const MAX_DIRECTORY_FILES = 20_000;
const FULL_COMMAND_OUTPUT_CHARS = 2_000_000;
const ARTIFACT_OUTPUT_THRESHOLD_CHARS = 16_384;

class BuildCapabilityError extends Error {
  public readonly code = "ERR_TOOL_MISSING_DEPENDENCY";

  public constructor(message: string) {
    super(message);
    this.name = "BuildCapabilityError";
  }
}

function normalizeRelative(value: string): string {
  return value.replace(/\\/gu, "/") || ".";
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
    throw new BuildCapabilityError(`Cannot inspect package.json build scripts: ${(error as Error).message}`);
  }
}

async function resolveBuildInvocation(
  args: BuildArguments,
  context: ToolAccessResolutionContext | RuntimeToolExecutionContext,
): Promise<BuildInvocation> {
  if (args.command) {
    const commandArgs = args.args ?? [];
    return {
      file: args.command,
      args: commandArgs,
      source: "explicit",
      commandSummary: summarizeProcessCommand(args.command, commandArgs),
    };
  }
  const services = "moduleContext" in context ? context.moduleContext : context;
  const cwd = services.paths.resolveWorkspace(args.cwd ?? ".");
  const scripts = await readPackageScripts(cwd, context.workspaceRoot, services.paths);
  const scriptName = ["build", "compile"].find((candidate) => typeof scripts[candidate] === "string");
  if (!scriptName) {
    throw new BuildCapabilityError(
      "No trusted build or compile package script was found; provide an explicit executable and argument list.",
    );
  }
  const npm = await services.capabilities.get("npm");
  if (!npm?.available) {
    throw new BuildCapabilityError("The trusted package build script requires npm, but npm is unavailable.");
  }
  const commandArgs = ["run", scriptName];
  return {
    file: npm.command,
    args: commandArgs,
    source: "package_script",
    scriptName,
    commandSummary: summarizeProcessCommand(npm.command, commandArgs),
  };
}

function resolveOutputDirectories(args: BuildArguments, context: ToolAccessResolutionContext | RuntimeToolExecutionContext): string[] {
  const services = "moduleContext" in context ? context.moduleContext : context;
  const cwd = services.paths.resolveWorkspace(args.cwd ?? ".");
  return [...new Set(args.outputDirectories ?? COMMON_OUTPUT_DIRECTORIES)]
    .map((entry) => {
      const absolute = services.paths.resolveWorkspace(normalizeRelative(path.relative(context.workspaceRoot, path.resolve(cwd, entry))));
      const relative = path.relative(context.workspaceRoot, absolute);
      if (relative.startsWith("..") || path.isAbsolute(relative)) {
        throw new Error(`Build output directory escapes the workspace: ${entry}.`);
      }
      return normalizeRelative(relative);
    })
    .sort();
}

async function snapshotDirectory(workspaceRoot: string, relativePath: string): Promise<DirectorySnapshot> {
  const absolute = path.resolve(workspaceRoot, relativePath);
  let files = 0;
  let bytes = 0;
  let truncated = false;
  const visit = async (candidate: string): Promise<void> => {
    if (files >= MAX_DIRECTORY_FILES) {
      truncated = true;
      return;
    }
    let stat;
    try {
      stat = await fs.lstat(candidate);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return;
      throw error;
    }
    if (stat.isSymbolicLink()) return;
    if (stat.isFile()) {
      files += 1;
      bytes += stat.size;
      return;
    }
    if (!stat.isDirectory()) return;
    for (const entry of await fs.readdir(candidate, { withFileTypes: true })) {
      await visit(path.join(candidate, entry.name));
      if (truncated) break;
    }
  };
  try {
    const rootStat = await fs.lstat(absolute);
    if (!rootStat.isDirectory() || rootStat.isSymbolicLink()) {
      return { relativePath, exists: false, files: 0, bytes: 0, truncated: false };
    }
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") {
      return { relativePath, exists: false, files: 0, bytes: 0, truncated: false };
    }
    throw error;
  }
  await visit(absolute);
  return { relativePath, exists: true, files, bytes, truncated };
}

async function snapshotDirectories(workspaceRoot: string, relativePaths: readonly string[]): Promise<DirectorySnapshot[]> {
  return Promise.all(relativePaths.map((relativePath) => snapshotDirectory(workspaceRoot, relativePath)));
}

function keyErrors(result: ToolProcessResult): string[] {
  return redactProcessText(`${result.stderr}\n${result.stdout}`)
    .split(/\r?\n/u)
    .map((line) => line.trim())
    .filter((line) => /\b(?:error|failed|failure|fatal)\b/iu.test(line))
    .slice(0, 20)
    .map((line) => line.slice(0, 500));
}

function buildError(result: ToolProcessResult, commandSummary: string): ToolStructuredError | undefined {
  if (result.timedOut) {
    return {
      type: "timeout",
      message: "Build timed out.",
      retryable: true,
      toolName: "build",
      command: commandSummary,
      exitCode: result.exitCode ?? undefined,
    };
  }
  if (result.spawnError?.code === "ENOENT") {
    return {
      type: "missing_dependency",
      message: "The requested build executable is unavailable; configure it explicitly outside this tool.",
      retryable: false,
      toolName: "build",
      command: commandSummary,
      dependency: commandSummary.split(" ")[0],
    };
  }
  if (result.spawnError || result.exitCode !== 0) {
    return {
      type: "command_failed",
      message: result.spawnError?.message ?? `Build exited with code ${result.exitCode ?? -1}.`,
      retryable: true,
      toolName: "build",
      command: commandSummary,
      exitCode: result.exitCode ?? undefined,
    };
  }
  return undefined;
}

async function persistBuildOutput(
  context: RuntimeToolExecutionContext,
  content: string,
): Promise<ToolOutputArtifact> {
  return context.moduleContext.persistence.storeToolOutputArtifact({
    sessionId: context.sessionId,
    namespace: "quality",
    turnId: context.turnId,
    toolCallId: context.callId,
    sourceToolName: "build",
    fileName: `build-output-${context.callId}.log`,
    mimeType: "text/plain",
    kind: "text",
    summary: "Full redacted build output captured by the tool",
    content,
    signal: context.signal,
  });
}

async function executeBuild(args: BuildArguments, context: RuntimeToolExecutionContext): Promise<ToolResult> {
  const startedAt = context.moduleContext.clock.now();
  const startedMs = Date.now();
  let commandSummary: string | undefined;
  try {
    const invocation = await resolveBuildInvocation(args, context);
    commandSummary = invocation.commandSummary;
    const outputPaths = resolveOutputDirectories(args, context);
    const before = await snapshotDirectories(context.workspaceRoot, outputPaths);
    const result = await context.moduleContext.processes.run({
      command: invocation.file,
      args: invocation.args,
      mode: "direct",
      cwd: context.moduleContext.paths.resolveWorkspace(args.cwd ?? "."),
      timeoutMs: args.timeoutMs ?? 180_000,
      maxOutputChars: FULL_COMMAND_OUTPUT_CHARS,
      signal: context.signal,
    });
    const after = await snapshotDirectories(context.workspaceRoot, outputPaths);
    const redactedOutput = redactProcessText(
      [result.stdout.trimEnd(), result.stderr.trimEnd()].filter(Boolean).join("\n"),
    );
    const artifacts =
      redactedOutput.length > ARTIFACT_OUTPUT_THRESHOLD_CHARS || result.outputTruncated
        ? [await persistBuildOutput(context, redactedOutput)]
        : [];
    const error = buildError(result, commandSummary);
    const capabilityUnavailable = error?.type === "missing_dependency";
    const existingDirectories = after.filter((entry) => entry.exists);
    const generatedDirectories = existingDirectories
      .filter((entry) => !before.find((previous) => previous.relativePath === entry.relativePath)?.exists)
      .map((entry) => entry.relativePath);
    const changedDirectories = existingDirectories
      .filter((entry) => {
        const previous = before.find((candidate) => candidate.relativePath === entry.relativePath);
        return !previous?.exists || previous.files !== entry.files || previous.bytes !== entry.bytes;
      })
      .map((entry) => entry.relativePath);
    const structuredContent = {
      kind: "build",
      source: invocation.source,
      scriptName: invocation.scriptName,
      commandSummary,
      cwd: normalizeRelative(args.cwd ?? "."),
      exitCode: result.exitCode ?? -1,
      durationMs: Date.now() - startedMs,
      ok: !error,
      output: redactedOutput,
      outputTruncated: Boolean(result.outputTruncated),
      keyErrors: keyErrors(result),
      outputDirectories: existingDirectories,
      generatedDirectories,
      changedDirectories,
      artifactUris: artifacts.map((artifact) => artifact.uri),
      capabilityAvailable: !capabilityUnavailable,
      suggestion: capabilityUnavailable
        ? "Provide an available build executable or define a trusted package build script; dependencies are never installed automatically."
        : undefined,
      dependencyInstallAttempted: false,
      packageConfigurationModified: false,
      ...(error ? { error } : {}),
    };
    return {
      toolName: "build",
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
    const capability = error instanceof BuildCapabilityError;
    const structured: ToolStructuredError = {
      type: capability ? "missing_dependency" : "invalid_arguments",
      message: redactProcessText((error as Error).message).slice(0, FULL_COMMAND_OUTPUT_CHARS),
      retryable: false,
      toolName: "build",
      command: commandSummary,
    };
    const body = {
      kind: "build",
      capabilityAvailable: !capability,
      suggestion: capability
        ? "Provide an explicit build executable or define a trusted package build script; dependencies are never installed automatically."
        : undefined,
      dependencyInstallAttempted: false,
      packageConfigurationModified: false,
      error: structured,
    };
    return {
      toolName: "build",
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

export const buildTool: RuntimeToolSpec = {
  name: "build",
  description: "Run an explicit build executable or a trusted project build script and return normalized output metadata.",
  inputSchema: BUILD_SCHEMA,
  readOnly: false,
  permissionCategory: "execute_command",
  sideEffectLevel: "medium",
  timeoutCategory: "slow",
  groups: ["quality", "commands"],
  selection: {
    groups: ["quality", "commands"],
    keywords: ["build", "compile", "bundle", "构建", "编译"],
    workerRoutes: ["coding"],
  },
  resolveAccess: async (rawArgs, context) => {
    const args = rawArgs as BuildArguments;
    const invocation = await resolveBuildInvocation(args, context);
    const outputDirectories = resolveOutputDirectories(args, context);
    return [
      {
        kind: "command_execute",
        cwd: context.paths.normalize(args.cwd ?? "."),
        command: invocation.commandSummary,
        reason: "Run a bounded build command without installing dependencies.",
      },
      {
        kind: "filesystem_write" as const,
        paths: outputDirectories,
        reason: args.outputDirectories && args.outputDirectories.length > 0
          ? "Build outputs are limited to the explicitly declared workspace directories."
          : "Audit the conventional workspace build output directories selected by the structured build tool.",
      },
    ];
  },
  redactArguments: (rawArgs) => {
    const args = rawArgs as BuildArguments;
    return {
      ...args,
      command: args.command ? redactProcessText(args.command) : undefined,
      args: args.args?.map((value) => redactProcessText(value)),
    };
  },
  formatPreExecutionFailure: (failure) => {
    const unavailable = /No trusted build|requires npm|unavailable/iu.test(failure.error.message);
    const error = unavailable
      ? { ...failure.error, type: "missing_dependency" as const, retryable: false }
      : failure.error;
    const body = {
      kind: "build",
      capabilityAvailable: !unavailable,
      suggestion: unavailable
        ? "Provide an explicit build executable or define a trusted package build script; dependencies are never installed automatically."
        : undefined,
      dependencyInstallAttempted: false,
      packageConfigurationModified: false,
      error,
    };
    return { output: JSON.stringify(body), structuredContent: body };
  },
  resolveExecutionTimeoutMs: (rawArgs) => Math.min(305_000, ((rawArgs as BuildArguments).timeoutMs ?? 180_000) + 5_000),
  execute: (rawArgs, context) => executeBuild(rawArgs as BuildArguments, context),
};
