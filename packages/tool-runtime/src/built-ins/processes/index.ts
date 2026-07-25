import type {
  ToolErrorType,
  ToolOutputArtifact,
  ToolResult,
  ToolStructuredError,
} from "../../../../shared-schema/src/index.js";
import { TOOL_PROCESS_LIMITS } from "../../../../shared-schema/src/index.js";
import {
  ToolProcessUnavailableError,
  redactProcessText,
  summarizeProcessCommand,
} from "../../process-manager.js";
import { assertManagedExecutable } from "../../process-command-policy.js";
import type {
  RuntimeToolExecutionContext,
  RuntimeToolSpec,
  ToolModule,
} from "../../tool-module.js";

interface StartProcessArguments {
  command: string;
  args?: string[];
  cwd?: string;
  environment?: Record<string, string>;
  interactionMode?: "none" | "pipe" | "pty";
  readyPattern?: string;
  startupTimeoutMs?: number;
}

interface ProcessInputArguments {
  processSessionId: string;
  text?: string;
  appendNewline?: boolean;
  control?: "ctrl_c" | "ctrl_d";
}

interface ProcessOutputArguments {
  processSessionId: string;
  cursor?: number;
  maxChars?: number;
  waitMs?: number;
  includeArtifact?: boolean;
}

interface StopProcessArguments {
  processSessionId: string;
  strategy: "graceful_only" | "graceful_then_force" | "force";
  gracefulTimeoutMs?: number;
}

const START_PROCESS_SCHEMA = {
  type: "object",
  additionalProperties: false,
  required: ["command"],
  properties: {
    command: { type: "string", minLength: 1, maxLength: 4096 },
    args: {
      type: "array",
      maxItems: 128,
      items: { type: "string", minLength: 1, maxLength: 8192 },
    },
    cwd: { type: "string" },
    environment: {
      type: "object",
      maxProperties: 32,
      additionalProperties: { type: "string", maxLength: 4096 },
    },
    interactionMode: { type: "string", enum: ["none", "pipe", "pty"] },
    readyPattern: { type: "string", minLength: 1, maxLength: 512 },
    startupTimeoutMs: { type: "integer", minimum: 100, maximum: 120000 },
  },
} as const;

const PROCESS_INPUT_SCHEMA = {
  type: "object",
  additionalProperties: false,
  required: ["processSessionId"],
  anyOf: [
    { required: ["text"] },
    { required: ["appendNewline"] },
    { required: ["control"] },
  ],
  properties: {
    processSessionId: { type: "string", minLength: 1, maxLength: 160 },
    text: { type: "string", maxLength: 8192 },
    appendNewline: { type: "boolean" },
    control: { type: "string", enum: ["ctrl_c", "ctrl_d"] },
  },
} as const;

const PROCESS_OUTPUT_SCHEMA = {
  type: "object",
  additionalProperties: false,
  required: ["processSessionId"],
  properties: {
    processSessionId: { type: "string", minLength: 1, maxLength: 160 },
    cursor: { type: "integer", minimum: 0 },
    maxChars: {
      type: "integer",
      minimum: 1,
      maximum: TOOL_PROCESS_LIMITS.maxOutputChunkChars,
      default: TOOL_PROCESS_LIMITS.defaultOutputChunkChars,
    },
    waitMs: { type: "integer", minimum: 0, maximum: 30000 },
    includeArtifact: { type: "boolean" },
  },
} as const;

const STOP_PROCESS_SCHEMA = {
  type: "object",
  additionalProperties: false,
  required: ["processSessionId", "strategy"],
  properties: {
    processSessionId: { type: "string", minLength: 1, maxLength: 160 },
    strategy: { type: "string", enum: ["graceful_only", "graceful_then_force", "force"] },
    gracefulTimeoutMs: { type: "integer", minimum: 0, maximum: 30000 },
  },
} as const;

function structuredError(
  type: ToolErrorType,
  message: string,
  retryable: boolean,
  command?: string,
): ToolStructuredError {
  return {
    type,
    message: redactProcessText(message).slice(0, TOOL_PROCESS_LIMITS.maxOutputChunkChars),
    retryable,
    toolName: "start_process",
    command,
  };
}

function failureResult(
  context: RuntimeToolExecutionContext,
  startedAt: string,
  error: ToolStructuredError,
  structuredContent: Record<string, unknown> = {},
): ToolResult {
  return {
    toolName: "start_process",
    callId: context.callId,
    startedAt,
    endedAt: context.moduleContext.clock.now(),
    success: false,
    output: JSON.stringify({ kind: "start_process", ...structuredContent, error }),
    structuredContent: { kind: "start_process", ...structuredContent, error },
    error: error.message,
  };
}

function lifecycleFailureResult(
  toolName: "process_input" | "process_output" | "stop_process",
  context: RuntimeToolExecutionContext,
  startedAt: string,
  error: unknown,
): ToolResult {
  const message = redactProcessText((error as Error).message).slice(0, TOOL_PROCESS_LIMITS.maxOutputChunkChars);
  const unavailable = error instanceof ToolProcessUnavailableError;
  const structured: ToolStructuredError = {
    type: unavailable ? "unsupported_environment" : "invalid_state",
    message,
    retryable: false,
    toolName,
  };
  const body = {
    kind: toolName,
    ...(unavailable ? { capability: error.capability, available: false } : {}),
    error: structured,
  };
  return {
    toolName,
    callId: context.callId,
    startedAt,
    endedAt: context.moduleContext.clock.now(),
    success: false,
    output: JSON.stringify(body),
    structuredContent: body,
    error: message,
  };
}

async function executeStartProcess(
  args: StartProcessArguments,
  context: RuntimeToolExecutionContext,
): Promise<ToolResult> {
  const startedAt = context.moduleContext.clock.now();
  const commandSummary = summarizeProcessCommand(args.command, args.args ?? []);
  try {
    const result = await context.moduleContext.processes.start({
      sessionId: context.sessionId,
      toolCallId: context.callId,
      command: args.command,
      args: args.args,
      cwd: context.moduleContext.paths.resolveWorkspace(args.cwd ?? "."),
      environment: args.environment,
      interactionMode: args.interactionMode ?? "none",
      readyPattern: args.readyPattern,
      startupTimeoutMs: args.startupTimeoutMs ?? 15_000,
      signal: context.signal,
    });
    const session = result.session;
    const readinessSatisfied = args.readyPattern === undefined || result.ready;
    const success = !result.startupTimedOut && readinessSatisfied &&
      !["failed", "orphaned", "stopping", "stopped"].includes(session.status);
    const spawnError = session.exit?.spawnError;
    const error = success
      ? undefined
      : result.startupTimedOut
        ? structuredError("timeout", "Process did not reach its ready state before startup timeout; it was stopped.", true, commandSummary)
        : !readinessSatisfied
          ? structuredError(
              "command_failed",
              `Process exited or stopped before ready pattern ${JSON.stringify(args.readyPattern)} was observed.`,
              true,
              commandSummary,
            )
        : structuredError(
            spawnError?.code === "ENOENT" ? "missing_dependency" : "command_failed",
            spawnError?.message ?? `Process entered ${session.status} during startup.`,
            spawnError?.code !== "ENOENT",
            commandSummary,
          );
    const structuredContent = {
      kind: "start_process",
      processSessionId: session.processSessionId,
      status: session.status,
      pid: session.pid,
      processGroupId: session.processGroupId,
      cwd: session.cwd,
      commandSummary: session.commandSummary,
      environmentSummary: session.environmentSummary,
      interactionMode: session.interactionMode,
      ptyAvailable: session.ptyAvailable,
      ready: result.ready,
      startupTimedOut: result.startupTimedOut,
      startedAt: session.startedAt,
      readyAt: session.readyAt,
      nextCursor: session.nextCursor,
      exit: session.exit,
      ...(error ? { error } : {}),
    };
    return {
      toolName: "start_process",
      callId: context.callId,
      startedAt,
      endedAt: context.moduleContext.clock.now(),
      success,
      output: JSON.stringify(structuredContent),
      structuredContent,
      error: error?.message,
    };
  } catch (error) {
    if (error instanceof ToolProcessUnavailableError) {
      return failureResult(
        context,
        startedAt,
        structuredError("unsupported_environment", error.message, false, commandSummary),
        { capability: error.capability, available: false },
      );
    }
    return failureResult(
      context,
      startedAt,
      structuredError("invalid_arguments", (error as Error).message, false, commandSummary),
    );
  }
}

async function executeProcessInput(
  args: ProcessInputArguments,
  context: RuntimeToolExecutionContext,
): Promise<ToolResult> {
  const startedAt = context.moduleContext.clock.now();
  try {
    context.signal?.throwIfAborted();
    const input = await context.moduleContext.processes.writeInput({
      ownerSessionId: context.sessionId,
      processSessionId: args.processSessionId,
      text: args.text,
      appendNewline: args.appendNewline,
      control: args.control,
    });
    const structuredContent = { kind: "process_input", ...input };
    return {
      toolName: "process_input",
      callId: context.callId,
      startedAt,
      endedAt: context.moduleContext.clock.now(),
      success: true,
      output: JSON.stringify(structuredContent),
      structuredContent,
    };
  } catch (error) {
    return lifecycleFailureResult("process_input", context, startedAt, error);
  }
}

async function executeProcessOutput(
  args: ProcessOutputArguments,
  context: RuntimeToolExecutionContext,
): Promise<ToolResult> {
  const startedAt = context.moduleContext.clock.now();
  try {
    let chunk = await context.moduleContext.processes.readOutput({
      ownerSessionId: context.sessionId,
      processSessionId: args.processSessionId,
      cursor: args.cursor,
      maxChars: args.maxChars,
      waitMs: args.waitMs,
    });
    const terminal = ["exited", "failed", "stopped", "orphaned"].includes(chunk.status);
    const artifactNeeded = Boolean(
      args.includeArtifact ||
      chunk.cursorExpired ||
      chunk.outputTruncated ||
      chunk.totalOutputChars > TOOL_PROCESS_LIMITS.maxOutputChunkChars ||
      (terminal && chunk.totalOutputChars > TOOL_PROCESS_LIMITS.defaultOutputChunkChars),
    );
    const latestArtifactIsCurrent =
      chunk.artifactUri && chunk.artifactCapturedThroughCursor === chunk.totalOutputChars;
    let artifact = chunk.artifactUri;
    let artifactPersistedByThisCall: ToolOutputArtifact | undefined;
    if (artifactNeeded && !latestArtifactIsCurrent) {
      const snapshot = context.moduleContext.processes.getArtifactSnapshot(
        context.sessionId,
        args.processSessionId,
      );
      if (snapshot.content && snapshot.capacityAvailable && snapshot.reservationId) {
        let committed = false;
        try {
          const persisted = await context.moduleContext.persistence.storeToolOutputArtifact({
            sessionId: context.sessionId,
            namespace: "process-logs",
            turnId: context.turnId,
            toolCallId: context.callId,
            sourceToolName: "process_output",
            fileName: `process-${args.processSessionId}-${snapshot.capturedThroughCursor}.log`,
            mimeType: "text/plain",
            kind: "text",
            summary: `Redacted managed-process log through cursor ${snapshot.capturedThroughCursor}`,
            content: snapshot.content,
            signal: context.signal,
          });
          committed = context.moduleContext.processes.attachArtifact(
            context.sessionId,
            args.processSessionId,
            persisted,
            snapshot.capturedThroughCursor,
            snapshot.truncated,
            snapshot.reservationId,
          );
          if (committed) {
            artifact = persisted.uri;
            artifactPersistedByThisCall = persisted;
            chunk = {
              ...chunk,
              artifactUri: persisted.uri,
              artifactCapturedThroughCursor: snapshot.capturedThroughCursor,
              artifactTruncated: snapshot.truncated,
            };
          }
        } finally {
          if (!committed) {
            context.moduleContext.processes.releaseArtifactReservation(
              context.sessionId,
              args.processSessionId,
              snapshot.reservationId,
            );
          }
        }
      }
    }
    const structuredContent = { kind: "process_output", ...chunk };
    return {
      toolName: "process_output",
      callId: context.callId,
      startedAt,
      endedAt: context.moduleContext.clock.now(),
      success: true,
      output: JSON.stringify(structuredContent),
      structuredContent,
      // storeToolOutputArtifact already records the artifact. Only return an
      // artifact from the call that created it; concurrent/repeated readers
      // reuse artifactUri without re-recording the same snapshot under a new
      // tool-call identity.
      artifacts: artifactPersistedByThisCall ? [artifactPersistedByThisCall] : undefined,
    };
  } catch (error) {
    return lifecycleFailureResult("process_output", context, startedAt, error);
  }
}

async function executeStopProcess(
  args: StopProcessArguments,
  context: RuntimeToolExecutionContext,
): Promise<ToolResult> {
  const startedAt = context.moduleContext.clock.now();
  try {
    const stopped = await context.moduleContext.processes.stop({
      ownerSessionId: context.sessionId,
      processSessionId: args.processSessionId,
      strategy: args.strategy,
      gracefulTimeoutMs: args.gracefulTimeoutMs ?? 2_000,
      reason: args.strategy === "force" ? "force_stop" : "graceful_stop",
    });
    const structuredContent = { kind: "stop_process", ...stopped };
    return {
      toolName: "stop_process",
      callId: context.callId,
      startedAt,
      endedAt: context.moduleContext.clock.now(),
      success: stopped.outcome !== "unable_to_confirm",
      output: JSON.stringify(structuredContent),
      structuredContent,
      error: stopped.outcome === "unable_to_confirm"
        ? "Process termination could not be confirmed."
        : undefined,
    };
  } catch (error) {
    return lifecycleFailureResult("stop_process", context, startedAt, error);
  }
}

const startProcessTool: RuntimeToolSpec = {
  name: "start_process",
  description: "Start a workspace-owned long-running or interactive process with bounded output and explicit lifecycle control.",
  inputSchema: START_PROCESS_SCHEMA,
  readOnly: false,
  permissionCategory: "execute_command",
  sideEffectLevel: "high",
  timeoutCategory: "slow",
  groups: ["processes", "commands"],
  selection: {
    groups: ["processes", "commands"],
    keywords: [
      "start_process",
      "background process",
      "dev server",
      "development server",
      "watch mode",
      "watcher",
      "interactive command",
      "后台进程",
      "开发服务器",
      "监听器",
      "交互命令",
    ],
    keywordGroups: [["start", "server"], ["启动", "服务"]],
    workerRoutes: ["coding"],
  },
  resolveAccess: (rawArgs, context) => {
    const args = rawArgs as StartProcessArguments;
    assertManagedExecutable("start_process", args.command, args.args ?? []);
    return [{
      kind: "command_execute",
      cwd: context.paths.normalize(args.cwd ?? "."),
      command: summarizeProcessCommand(args.command, args.args ?? []),
      reason: "Start a session-owned managed process inside the workspace sandbox.",
    }];
  },
  redactArguments: (rawArgs) => {
    const args = rawArgs as StartProcessArguments;
    return {
      ...args,
      command: redactProcessText(args.command),
      args: args.args?.map((value) => redactProcessText(value)),
      environment: args.environment
        ? Object.fromEntries(Object.keys(args.environment).map((key) => [key, "[REDACTED]"]))
        : undefined,
    };
  },
  resolveExecutionTimeoutMs: (rawArgs) =>
    Math.min(125_000, ((rawArgs as StartProcessArguments).startupTimeoutMs ?? 15_000) + 5_000),
  execute: (rawArgs, context) => executeStartProcess(rawArgs as StartProcessArguments, context),
};

const processInputTool: RuntimeToolSpec = {
  name: "process_input",
  description: "Write bounded text, a newline, or a supported control character to a session-owned managed process.",
  inputSchema: PROCESS_INPUT_SCHEMA,
  readOnly: false,
  permissionCategory: "execute_command",
  sideEffectLevel: "medium",
  timeoutCategory: "fast",
  groups: ["processes", "commands"],
  selection: {
    groups: ["processes", "commands"],
    keywords: ["process_input", "stdin", "interactive input", "send input", "进程输入", "标准输入", "交互输入"],
    keywordGroups: [["process", "input"], ["进程", "输入"]],
  },
  resolveAccess: (rawArgs) => [{
    kind: "external_system",
    systems: [`managed-process:${(rawArgs as ProcessInputArguments).processSessionId}`],
    reason: "Write to a session-owned managed process after normal approval.",
  }],
  redactArguments: (rawArgs) => {
    const args = rawArgs as ProcessInputArguments;
    return {
      ...args,
      text: args.text === undefined ? undefined : `[REDACTED ${args.text.length} chars]`,
    };
  },
  execute: (rawArgs, context) => executeProcessInput(rawArgs as ProcessInputArguments, context),
};

const processOutputTool: RuntimeToolSpec = {
  name: "process_output",
  description: "Read only new bounded stdout and stderr from a session-owned managed process using a monotonic cursor.",
  inputSchema: PROCESS_OUTPUT_SCHEMA,
  readOnly: true,
  permissionCategory: "read_only",
  sideEffectLevel: "none",
  timeoutCategory: "default",
  groups: ["processes", "commands"],
  selection: {
    groups: ["processes", "commands"],
    keywords: ["process_output", "process logs", "incremental output", "stdout", "stderr", "进程输出", "增量日志"],
    keywordGroups: [["process", "output"], ["进程", "日志"]],
  },
  resolveExecutionTimeoutMs: (rawArgs) =>
    Math.min(35_000, ((rawArgs as ProcessOutputArguments).waitMs ?? 0) + 5_000),
  execute: (rawArgs, context) => executeProcessOutput(rawArgs as ProcessOutputArguments, context),
};

const stopProcessTool: RuntimeToolSpec = {
  name: "stop_process",
  description: "Stop a session-owned managed process with an explicit graceful or force strategy.",
  inputSchema: STOP_PROCESS_SCHEMA,
  readOnly: false,
  permissionCategory: "execute_command",
  sideEffectLevel: "high",
  timeoutCategory: "default",
  groups: ["processes", "commands"],
  selection: {
    groups: ["processes", "commands"],
    keywords: ["stop_process", "stop server", "terminate process", "kill process", "停止进程", "终止服务"],
    keywordGroups: [["stop", "process"], ["停止", "进程"]],
  },
  resolveAccess: (rawArgs) => [{
    kind: "external_system",
    systems: [`managed-process:${(rawArgs as StopProcessArguments).processSessionId}`],
    reason: "Stop a session-owned managed process after normal approval.",
  }],
  resolveExecutionTimeoutMs: (rawArgs) =>
    Math.min(65_000, ((rawArgs as StopProcessArguments).gracefulTimeoutMs ?? 2_000) * 2 + 5_000),
  execute: (rawArgs, context) => executeStopProcess(rawArgs as StopProcessArguments, context),
};

export const processesToolModule: ToolModule = {
  manifest: {
    id: "builtin.processes",
    version: "1.0.0",
    description: "Managed long-running process lifecycle tools.",
    source: "built_in",
  },
  create: () => [startProcessTool, processInputTool, processOutputTool, stopProcessTool],
};
