import path from "node:path";

import type {
  ToolErrorType,
  ToolResult,
  ToolStructuredError,
} from "../../../../shared-schema/src/index.js";
import type {
  RuntimeToolExecutionContext,
  RuntimeToolSpec,
  ToolModule,
  ToolProcessResult,
} from "../../tool-module.js";
import { redactProcessText } from "../../process-manager.js";

type CommandToolName = "run_shell" | "run_tests" | "lint" | "typecheck";

interface CommandArguments {
  command: string;
  cwd?: string;
  timeoutMs?: number;
}

function maskQuotedText(command: string, platform: NodeJS.Platform): string {
  let quote: "'" | '"' | undefined;
  let escaped = false;
  let masked = "";
  for (const character of command) {
    if (escaped) {
      masked += character === "\n" || character === "\r" ? character : " ";
      escaped = false;
      continue;
    }
    const escapeCharacter = platform === "win32" ? "`" : "\\";
    if (character === escapeCharacter && quote !== "'") {
      masked += " ";
      escaped = true;
      continue;
    }
    if (quote) {
      if (character === quote) {
        quote = undefined;
        masked += character;
      } else {
        masked += character === "\n" || character === "\r" ? character : " ";
      }
      continue;
    }
    if (character === "'" || character === '"') {
      quote = character;
      masked += character;
      continue;
    }
    masked += character;
  }
  return masked;
}

function readNestedShellPayload(command: string, startIndex: number): string | undefined {
  let index = startIndex;
  while (/\s/u.test(command[index] ?? "")) index += 1;
  if (command[index] === "$" && (command[index + 1] === "'" || command[index + 1] === '"')) {
    index += 1;
  }
  const quote = command[index];
  if (quote !== "'" && quote !== '"') {
    const payload = command.slice(index).trim();
    return payload || undefined;
  }

  index += 1;
  let payload = "";
  let escaped = false;
  for (; index < command.length; index += 1) {
    const character = command[index]!;
    if (escaped) {
      payload += character;
      escaped = false;
      continue;
    }
    if (character === "\\" && quote !== "'") {
      escaped = true;
      payload += character;
      continue;
    }
    if (character === quote) return payload;
    payload += character;
  }
  return payload || undefined;
}

function nestedShellPayloads(
  command: string,
  platform: NodeJS.Platform,
): Array<{ payload: string; platform: NodeJS.Platform }> {
  const payloads: Array<{ payload: string; platform: NodeJS.Platform }> = [];
  const visible = maskQuotedText(command, platform);
  const launchers: Array<{ pattern: RegExp; platform: NodeJS.Platform }> = [
    { pattern: /\b(?:bash|sh|zsh|dash|ksh)(?:\.exe)?\b[^\r\n;&|]*?\s+-(?:c|lc)\s+/giu, platform: "linux" },
    { pattern: /\b(?:powershell|pwsh)(?:\.exe)?\b[^\r\n]*?\s-(?:command|c)\s+/giu, platform: "win32" },
  ];
  for (const launcher of launchers) {
    for (const match of visible.matchAll(launcher.pattern)) {
      const payload = readNestedShellPayload(command, (match.index ?? 0) + match[0].length);
      if (payload) payloads.push({ payload, platform: launcher.platform });
    }
  }
  return payloads;
}

function nestedProgramPayloads(
  command: string,
  platform: NodeJS.Platform,
): Array<{ payload: string; runtime: "node" | "python" | "ruby" }> {
  const payloads: Array<{ payload: string; runtime: "node" | "python" | "ruby" }> = [];
  const visible = maskQuotedText(command, platform);
  const launchers: Array<{ pattern: RegExp; runtime: "node" | "python" | "ruby" }> = [
    { pattern: /\b(?:node|nodejs)(?:\.exe)?\b[^\r\n;&|]*?\s+(?:-e|--eval)\s+/giu, runtime: "node" },
    { pattern: /\b(?:python|python3|py)(?:\.exe)?\b[^\r\n;&|]*?\s+-c\s+/giu, runtime: "python" },
    { pattern: /\bruby(?:\.exe)?\b[^\r\n;&|]*?\s+-e\s+/giu, runtime: "ruby" },
  ];
  for (const launcher of launchers) {
    for (const match of visible.matchAll(launcher.pattern)) {
      const payload = readNestedShellPayload(command, (match.index ?? 0) + match[0].length);
      if (payload) payloads.push({ payload, runtime: launcher.runtime });
    }
  }
  return payloads;
}

function programmaticChildPattern(
  payload: string,
  runtime: "node" | "python" | "ruby",
): string | undefined {
  if (/\b(?:DETACHED_PROCESS|CREATE_NEW_PROCESS_GROUP|start_new_session\s*=\s*true|setsid|daemonize)\b|\.unref\s*\(/iu.test(payload)) {
    return "programmatic detached child";
  }
  if (
    runtime === "node" &&
    /(?:child_process|node:child_process)/iu.test(payload) &&
    /\b(?:spawn|fork|exec|execFile)\b/u.test(payload)
  ) {
    return "opaque inline Node child-process launch";
  }
  if (runtime === "python" && /\b(?:subprocess\s*\.\s*Popen|os\s*\.\s*fork)\b/u.test(payload)) {
    return "opaque inline Python child-process launch";
  }
  if (runtime === "ruby" && /\b(?:Process\s*\.\s*(?:spawn|fork)|daemon)\b/u.test(payload)) {
    return "opaque inline Ruby child-process launch";
  }
  return undefined;
}

/** Reject shell detachment forms that would escape phase-17 process ownership. */
export function detachedShellPattern(
  command: string,
  platform: NodeJS.Platform = process.platform,
  recursionDepth = 0,
): string | undefined {
  const visible = maskQuotedText(command, platform);
  const commandPosition = String.raw`(?:^|[;|\r\n({]\s*|\$[A-Za-z_][\w:]*\s*=\s*)(?:&\s*)?`;
  const patterns: Array<[RegExp, string]> = [
    [/\b(?:powershell|pwsh)(?:\.exe)?\b[^\r\n]*\s-(?:encodedcommand|enc|e)(?:\s|$)/iu, "opaque encoded PowerShell command"],
    [new RegExp(`${commandPosition}eval\\b`, "iu"), "opaque dynamic shell evaluation"],
  ];
  if (platform === "win32") {
    patterns.push(
      [new RegExp(`${commandPosition}(?:(?:start-process|saps)\\b|start(?![-\\w]))`, "iu"), "PowerShell process launcher"],
      [/\s-asjob(?:\s|$)/iu, "PowerShell background job"],
      [new RegExp(`${commandPosition}start-job\\b`, "iu"), "PowerShell background job"],
      [/\bcmd(?:\.exe)?\b[^\r\n]*\/(?:c|k)\s+start(?:\s|$)/iu, "cmd start"],
    );
  } else {
    patterns.push([
      new RegExp(`${commandPosition}(?:(?:sudo|env|command|exec|time)\\s+)*(?:nohup|disown|setsid|daemonize|systemd-run)\\b`, "iu"),
      "detached POSIX launcher",
    ]);
  }
  patterns.push(
    [new RegExp(`${commandPosition}(?:screen|tmux)\\b[^\\r\\n]*(?:\\s-dm?\\b|new-session\\s+-d\\b)`, "iu"), "detached terminal multiplexer"],
    [new RegExp(`${commandPosition}(?:docker|podman)\\b[^\\r\\n]*\\s-d(?:\\s|$)`, "iu"), "detached container command"],
  );
  for (const [pattern, description] of patterns) {
    if (pattern.test(visible)) return description;
  }

  if (recursionDepth < 3) {
    for (const nested of nestedShellPayloads(command, platform)) {
      if (/(?:\$\(|\$\{|\$[A-Za-z_]|`)/u.test(nested.payload)) {
        return "opaque dynamic nested shell payload";
      }
      const nestedPattern = detachedShellPattern(nested.payload, nested.platform, recursionDepth + 1);
      if (nestedPattern) return `nested shell: ${nestedPattern}`;
    }
    for (const nested of nestedProgramPayloads(command, platform)) {
      const nestedPattern = programmaticChildPattern(nested.payload, nested.runtime);
      if (nestedPattern) return nestedPattern;
    }
  }

  let quote: "'" | '"' | undefined;
  let escaped = false;
  for (let index = 0; index < command.length; index += 1) {
    const character = command[index]!;
    if (escaped) {
      escaped = false;
      continue;
    }
    if (character === (platform === "win32" ? "`" : "\\") && quote !== "'") {
      escaped = true;
      continue;
    }
    if (quote) {
      if (character === quote) quote = undefined;
      continue;
    }
    if (character === "'" || character === '"') {
      quote = character;
      continue;
    }
    if (character !== "&" || command[index - 1] === "&" || command[index + 1] === "&") continue;
    if (command[index - 1] === ">" || command[index + 1] === ">") continue;

    const before = command.slice(0, index).trimEnd();
    const after = command.slice(index + 1).trimStart();
    if (!before && platform !== "win32") continue;
    if (platform === "win32") {
      const previous = before.at(-1);
      const isPowerShellCallOperator = !before || previous === ";" || previous === "|" || previous === "(" || previous === "{";
      if (isPowerShellCallOperator && after) continue;
    }
    if (before && (!after || platform !== "win32")) return "unowned shell background operator";
  }
  return undefined;
}

function assertForegroundCommand(toolName: CommandToolName, command: string): void {
  const pattern = detachedShellPattern(command);
  if (!pattern) return;
  throw Object.assign(
    new Error(`${toolName} cannot launch a background or detached process (${pattern}); use start_process and the managed process lifecycle.`),
    { code: "ERR_TOOL_INVALID_ARGUMENTS" },
  );
}

const COMMAND_INPUT_SCHEMA = {
  type: "object",
  additionalProperties: false,
  required: ["command"],
  properties: {
    command: { type: "string" },
    cwd: { type: "string" },
    timeoutMs: { type: "integer", minimum: 1000, maximum: 300000 },
  },
} as const;

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

function shellDependency(): string {
  return process.platform === "win32" ? "powershell.exe" : "sh";
}

function classifyProcessFailure(
  toolName: CommandToolName,
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
    const dependency = shellDependency();
    return createStructuredError({
      type: "missing_dependency",
      message: `Missing executable required by ${toolName}: ${dependency}.`,
      retryable: false,
      toolName,
      dependency,
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

function parseCount(text: string, pattern: RegExp): number | undefined {
  const match = text.match(pattern);
  return match?.[1] ? Number.parseInt(match[1], 10) : undefined;
}

function parseRunTestsResult(result: ToolProcessResult): Record<string, unknown> {
  const exitCode = result.exitCode ?? -1;
  const combined = `${result.stdout}\n${result.stderr}`;
  const passed =
    parseCount(combined, /# pass (\d+)/) ??
    parseCount(combined, /(\d+) passing/) ??
    (exitCode === 0 ? 1 : 0);
  const failed =
    parseCount(combined, /# fail (\d+)/) ??
    parseCount(combined, /(\d+) failing/) ??
    (exitCode === 0 ? 0 : 1);
  return {
    kind: "run_tests",
    exitCode,
    passed,
    failed,
    ok: exitCode === 0,
  };
}

function parseLintResult(result: ToolProcessResult): Record<string, unknown> {
  const exitCode = result.exitCode ?? -1;
  const combined = `${result.stdout}\n${result.stderr}`;
  const errorCount =
    parseCount(combined, /(\d+) error/) ??
    (combined.match(/\berror\b/gi)?.length ?? (exitCode === 0 ? 0 : 1));
  const warningCount =
    parseCount(combined, /(\d+) warning/) ??
    (combined.match(/\bwarning\b/gi)?.length ?? 0);
  return {
    kind: "lint",
    exitCode,
    errorCount,
    warningCount,
    ok: exitCode === 0,
  };
}

function parseTypecheckResult(result: ToolProcessResult): Record<string, unknown> {
  const exitCode = result.exitCode ?? -1;
  const combined = `${result.stdout}\n${result.stderr}`;
  const errorCount = combined.match(/\berror TS\d+/g)?.length ?? (exitCode === 0 ? 0 : 1);
  return {
    kind: "typecheck",
    exitCode,
    errorCount,
    ok: exitCode === 0,
  };
}

async function executeCommand(
  toolName: CommandToolName,
  args: CommandArguments,
  context: RuntimeToolExecutionContext,
): Promise<ToolResult> {
  const startedAt = context.moduleContext.clock.now();
  const cwd = context.moduleContext.paths.resolveWorkspace(args.cwd ?? ".");
  const normalizedCwd = context.moduleContext.paths.normalize(
    path.relative(context.workspaceRoot, cwd) || ".",
  );
  const result = await context.moduleContext.processes.run({
    command: args.command,
    mode: "shell",
    cwd,
    timeoutMs:
      args.timeoutMs ??
      (toolName === "run_tests" || toolName === "lint" || toolName === "typecheck"
        ? 120000
        : 60000),
    signal: context.signal,
  });
  if (context.signal?.aborted) {
    throw context.signal.reason instanceof Error
      ? context.signal.reason
      : new Error(`${toolName} was cancelled.`);
  }
  const structuredContent =
    toolName === "run_tests"
      ? parseRunTestsResult(result)
      : toolName === "lint"
        ? parseLintResult(result)
        : toolName === "typecheck"
          ? parseTypecheckResult(result)
          : {
              kind: "run_shell",
              exitCode: result.exitCode ?? -1,
            };
  const error =
    !result.spawnError && !result.timedOut && result.exitCode === 0
      ? undefined
      : classifyProcessFailure(toolName, args.command, normalizedCwd, result);
  const body = {
    command: redactProcessText(args.command),
    cwd: normalizedCwd,
    raw: result,
    ...(error ? { error } : {}),
    ...structuredContent,
  };

  return {
    toolName,
    callId: context.callId,
    startedAt,
    endedAt: context.moduleContext.clock.now(),
    success: error === undefined,
    output: JSON.stringify(body),
    structuredContent: body,
    error: error?.message,
  };
}

function createCommandTool(input: {
  name: CommandToolName;
  description: string;
  permissionCategory: "execute_command" | "run_tests";
  timeoutCategory: "default" | "slow";
  groups: string[];
  keywords: string[];
  keywordGroups?: string[][];
  workerRoutes?: Array<"coding" | "vision">;
}): RuntimeToolSpec {
  return {
    name: input.name,
    description: input.description,
    inputSchema: COMMAND_INPUT_SCHEMA,
    readOnly: false,
    permissionCategory: input.permissionCategory,
    sideEffectLevel: "medium",
    timeoutCategory: input.timeoutCategory,
    groups: input.groups,
    selection: {
      groups: input.groups,
      keywords: input.keywords,
      keywordGroups: input.keywordGroups,
      workerRoutes: input.workerRoutes,
    },
    resolveAccess: (rawArgs, context) => {
      const args = rawArgs as CommandArguments;
      assertForegroundCommand(input.name, args.command);
      return [
        {
          kind: "command_execute",
          cwd: context.paths.normalize(args.cwd ?? "."),
          command: args.command,
          reason: `Execute ${input.name} in the workspace sandbox.`,
        },
      ];
    },
    formatPreExecutionFailure: (failure) => {
      if (!failure.error.message.startsWith(`${input.name} cannot launch`)) return {};
      const body = {
        kind: input.name,
        blocked: true,
        lifecycleTool: "start_process",
        error: { ...failure.error, type: "invalid_arguments" as const, retryable: false },
      };
      return { output: JSON.stringify(body), structuredContent: body };
    },
    execute: (rawArgs, context) =>
      executeCommand(input.name, rawArgs as CommandArguments, context),
  };
}

export const commandsToolModule: ToolModule = {
  manifest: {
    id: "builtin.commands",
    version: "1.0.0",
    description: "Built-in workspace shell, test, lint, and typecheck commands.",
    source: "built_in",
  },
  create: () => [
    createCommandTool({
      name: "run_shell",
      description: "Run a shell command inside the workspace.",
      permissionCategory: "execute_command",
      timeoutCategory: "default",
      groups: ["commands", "core"],
      keywords: ["shell", "command", "terminal", "powershell", "python", "pip", "命令", "终端", "脚本", "运行", "执行"],
      keywordGroups: [["pdf", "word"], ["pdf", "docx"], ["pdf", "复刻"], ["docx", "复刻"]],
      workerRoutes: ["coding"],
    }),
    createCommandTool({
      name: "run_tests",
      description: "Run a test command inside the workspace.",
      permissionCategory: "run_tests",
      timeoutCategory: "slow",
      groups: ["commands", "diagnostics"],
      keywords: ["test", "tests", "testing", "测试"],
    }),
    createCommandTool({
      name: "lint",
      description: "Run a lint command inside the workspace and parse the result.",
      permissionCategory: "run_tests",
      timeoutCategory: "slow",
      groups: ["commands", "diagnostics"],
      keywords: ["lint", "eslint", "代码检查"],
    }),
    createCommandTool({
      name: "typecheck",
      description: "Run a typecheck command inside the workspace and parse the result.",
      permissionCategory: "run_tests",
      timeoutCategory: "slow",
      groups: ["commands", "diagnostics"],
      keywords: ["typecheck", "typescript", "type check", "类型检查"],
    }),
  ],
};
