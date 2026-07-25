import path from "node:path";

import type {
  RuntimeCapabilityProbe,
  ToolAvailability,
  ToolErrorType,
  ToolResult,
  ToolStructuredError,
} from "../../../../shared-schema/src/index.js";
import type {
  RuntimeToolExecutionContext,
  RuntimeToolSpec,
  ToolModule,
  ToolModuleContext,
  ToolProcessResult,
} from "../../tool-module.js";
import { buildGitCommand, executeGitCommand } from "./command-builder.js";

type GitToolName = "git_status" | "git_diff";

function createStructuredError(input: {
  type: ToolErrorType;
  message: string;
  retryable: boolean;
  toolName: string;
  dependency?: string;
  command?: string;
  cwd?: string;
  exitCode?: number;
  stdout?: string;
  stderr?: string;
}): ToolStructuredError {
  return { ...input };
}

function classifyProcessFailure(
  toolName: GitToolName,
  command: string,
  cwd: string,
  result: ToolProcessResult,
): ToolStructuredError {
  if (result.timedOut) {
    return createStructuredError({
      type: "timeout",
      message: `${toolName} timed out after waiting for ${command}.`,
      retryable: true,
      toolName,
      command,
      cwd,
      exitCode: result.exitCode ?? undefined,
      stdout: result.stdout,
      stderr: result.stderr,
    });
  }
  if (result.spawnError?.code === "ENOENT") {
    return createStructuredError({
      type: "missing_dependency",
      message: `Missing executable required by ${toolName}: git.`,
      retryable: false,
      toolName,
      dependency: "git",
      command,
      cwd,
      stderr: result.spawnError.message,
    });
  }
  return createStructuredError({
    type: "command_failed",
    message: `${toolName} command failed with exit code ${result.exitCode ?? -1}.`,
    retryable: true,
    toolName,
    command,
    cwd,
    exitCode: result.exitCode ?? undefined,
    stdout: result.stdout,
    stderr: result.stderr,
  });
}

async function getGitAvailability(
  context: ToolModuleContext,
  toolName: GitToolName,
): Promise<ToolAvailability> {
  const capability = await context.capabilities.get("git");
  if (capability?.available) {
    return { status: "available", available: true };
  }
  return {
    status: "unavailable",
    available: false,
    missingCapabilities: ["git"],
    reason: `Missing executable required by ${toolName}: git.`,
  };
}

function missingGitResult(
  toolName: GitToolName,
  cwd: string,
  context: RuntimeToolExecutionContext,
): ToolResult {
  const error = createStructuredError({
    type: "missing_dependency",
    message: `Missing executable required by ${toolName}: git.`,
    retryable: false,
    toolName,
    dependency: "git",
    cwd,
  });
  const body = {
    kind: toolName,
    cwd,
    error,
  };
  return {
    toolName,
    callId: context.callId,
    startedAt: context.moduleContext.clock.now(),
    endedAt: context.moduleContext.clock.now(),
    success: false,
    output: JSON.stringify(body),
    structuredContent: body,
    error: error.message,
  };
}

async function resolveGitCapability(
  context: RuntimeToolExecutionContext,
): Promise<RuntimeCapabilityProbe | undefined> {
  return context.moduleContext.capabilities.get("git");
}

async function executeGitStatus(
  args: { cwd?: string },
  context: RuntimeToolExecutionContext,
): Promise<ToolResult> {
  const startedAt = context.moduleContext.clock.now();
  const cwd = context.moduleContext.paths.resolveWorkspace(args.cwd ?? ".");
  const normalizedCwd = context.moduleContext.paths.normalize(
    path.relative(context.workspaceRoot, cwd) || ".",
  );
  const capability = await resolveGitCapability(context);
  if (!capability?.available) {
    return missingGitResult("git_status", normalizedCwd, context);
  }
  const commandSpec = buildGitCommand({
    executable: capability.command,
    args: ["status", "--short"],
    cwd,
    purpose: "Read the repository status without changing local state.",
    timeoutMs: 15000,
  });
  const result = await executeGitCommand(context.moduleContext.processes, commandSpec);
  const error =
    !result.spawnError && !result.timedOut && result.exitCode === 0
      ? undefined
      : classifyProcessFailure("git_status", "git status --short", normalizedCwd, result);
  const body = {
    kind: "git_status",
    cwd: normalizedCwd,
    raw: {
      ...result,
      file: commandSpec.executable,
      args: commandSpec.args,
    },
    ...(error ? { error } : {}),
  };
  return {
    toolName: "git_status",
    callId: context.callId,
    startedAt,
    endedAt: context.moduleContext.clock.now(),
    success: error === undefined,
    output: JSON.stringify(body),
    structuredContent: body,
    error: error?.message,
  };
}

async function executeGitDiff(
  args: { cwd?: string; pathspec?: string },
  context: RuntimeToolExecutionContext,
): Promise<ToolResult> {
  const startedAt = context.moduleContext.clock.now();
  const cwd = context.moduleContext.paths.resolveWorkspace(args.cwd ?? ".");
  const normalizedCwd = context.moduleContext.paths.normalize(
    path.relative(context.workspaceRoot, cwd) || ".",
  );
  const capability = await resolveGitCapability(context);
  if (!capability?.available) {
    return missingGitResult("git_diff", normalizedCwd, context);
  }
  const commandSpec = buildGitCommand({
    executable: capability.command,
    args: args.pathspec ? ["diff", "--", args.pathspec] : ["diff"],
    cwd,
    purpose: "Read repository differences without changing local state.",
    timeoutMs: 15000,
  });
  const result = await executeGitCommand(context.moduleContext.processes, commandSpec);
  const command = commandSpec.display;
  const error =
    !result.spawnError && !result.timedOut && result.exitCode === 0
      ? undefined
      : classifyProcessFailure("git_diff", command, normalizedCwd, result);
  const body = {
    kind: "git_diff",
    cwd: normalizedCwd,
    pathspec: args.pathspec,
    raw: {
      ...result,
      file: commandSpec.executable,
      args: commandSpec.args,
    },
    ...(error ? { error } : {}),
  };
  return {
    toolName: "git_diff",
    callId: context.callId,
    startedAt,
    endedAt: context.moduleContext.clock.now(),
    success: error === undefined,
    output: JSON.stringify(body),
    structuredContent: body,
    error: error?.message,
  };
}

const gitStatusTool: RuntimeToolSpec = {
  name: "git_status",
  description: "Read git status for the current repository if one exists.",
  inputSchema: {
    type: "object",
    additionalProperties: false,
    properties: {
      cwd: { type: "string" },
    },
  },
  readOnly: true,
  permissionCategory: "read_only",
  sideEffectLevel: "none",
  timeoutCategory: "fast",
  groups: ["git", "repository"],
  selection: {
    groups: ["git", "repository"],
    keywords: ["git status", "repository status", "仓库状态", "工作区状态"],
  },
  capabilityRequirements: [
    {
      name: "git",
      required: true,
      reason: "git_status invokes the Git executable.",
    },
  ],
  getAvailability: (context) => getGitAvailability(context, "git_status"),
  resolveAccess: (rawArgs, context) => {
    const args = (rawArgs ?? {}) as { cwd?: string };
    return [
      {
        kind: "command_execute",
        cwd: context.paths.normalize(args.cwd ?? "."),
        command: "git status --short",
        reason: "Read repository status with Git inside the workspace sandbox.",
      },
    ];
  },
  execute: (rawArgs, context) =>
    executeGitStatus((rawArgs ?? {}) as { cwd?: string }, context),
};

const gitDiffTool: RuntimeToolSpec = {
  name: "git_diff",
  description: "Read git diff for the current repository if one exists.",
  inputSchema: {
    type: "object",
    additionalProperties: false,
    properties: {
      cwd: { type: "string" },
      pathspec: { type: "string" },
    },
  },
  readOnly: true,
  permissionCategory: "read_only",
  sideEffectLevel: "none",
  timeoutCategory: "fast",
  groups: ["git", "repository"],
  selection: {
    groups: ["git", "repository"],
    keywords: ["git diff", "diff", "changes", "差异", "变更"],
  },
  capabilityRequirements: [
    {
      name: "git",
      required: true,
      reason: "git_diff invokes the Git executable.",
    },
  ],
  getAvailability: (context) => getGitAvailability(context, "git_diff"),
  resolveAccess: (rawArgs, context) => {
    const args = (rawArgs ?? {}) as { cwd?: string; pathspec?: string };
    return [
      {
        kind: "command_execute",
        cwd: context.paths.normalize(args.cwd ?? "."),
        command: args.pathspec ? `git diff -- ${args.pathspec}` : "git diff",
        reason: "Read repository differences with Git inside the workspace sandbox.",
      },
    ];
  },
  execute: (rawArgs, context) =>
    executeGitDiff((rawArgs ?? {}) as { cwd?: string; pathspec?: string }, context),
};

export const gitToolModule: ToolModule = {
  manifest: {
    id: "builtin.git",
    version: "1.0.0",
    description: "Built-in read-only Git inspection tools.",
    source: "built_in",
  },
  create: () => [gitStatusTool, gitDiffTool],
};
