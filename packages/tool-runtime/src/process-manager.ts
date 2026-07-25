import { spawn, type ChildProcess } from "node:child_process";
import { randomUUID } from "node:crypto";
import { promises as fs } from "node:fs";
import path from "node:path";
import process from "node:process";

import {
  TOOL_PROCESS_LIMITS,
  type ToolProcessExitInfo,
  type ToolProcessInputResult,
  type ToolProcessInteractionMode,
  type ToolProcessOutputChunk,
  type ToolProcessSession,
  type ToolProcessStopResult,
  type ToolProcessStopStrategy,
  type ToolOutputArtifact,
} from "../../shared-schema/src/index.js";
import { assertForegroundShellCommand, assertManagedExecutable } from "./process-command-policy.js";
import { runProcess } from "./runtime-capabilities.js";
import type { ToolProcessRequest, ToolProcessResult } from "./tool-module.js";

const ACTIVE_STATUSES = new Set(["starting", "running", "stopping"] as const);
const TERMINAL_STATUSES = new Set(["exited", "failed", "stopped", "orphaned"] as const);
const SENSITIVE_KEY = /(?:api[_-]?key|authorization|cookie|credential|password|secret|token|connection(?:string)?)/iu;
const SAFE_OVERRIDE_KEYS = new Set([
  "CI",
  "DEBUG",
  "FORCE_COLOR",
  "HOST",
  "LANG",
  "LC_ALL",
  "NODE_ENV",
  "NO_COLOR",
  "PORT",
  "TERM",
  "TZ",
]);
const SAFE_INHERITED_KEYS = new Set([
  "APPDATA",
  "COLORTERM",
  "COMSPEC",
  "HOME",
  "LANG",
  "LC_ALL",
  "LOCALAPPDATA",
  "NUMBER_OF_PROCESSORS",
  "PATH",
  "PATHEXT",
  "PROGRAMFILES",
  "PROGRAMFILES(X86)",
  "PROGRAMW6432",
  "SYSTEMROOT",
  "TEMP",
  "TERM",
  "TMP",
  "TZ",
  "USERPROFILE",
  "WINDIR",
]);
const MAX_ARGUMENTS = 128;
const MAX_ARGUMENT_CHARS = 8_192;
const STREAM_REDACTION_HOLDBACK_CHARS = 1_024;

type TerminalStatus = "exited" | "failed" | "stopped" | "orphaned";
type ManagedExitReason = ToolProcessExitInfo["reason"];

interface BufferedOutput {
  stream: "stdout" | "stderr";
  startCursor: number;
  endCursor: number;
  text: string;
  createdAt: number;
}

interface ArtifactSnapshot {
  artifact: ToolOutputArtifact;
  capturedThroughCursor: number;
  truncated: boolean;
}

interface ManagedProcessRecord {
  session: ToolProcessSession;
  child?: ChildProcess;
  buffer: BufferedOutput[];
  retainedChars: number;
  artifactText: string;
  artifactTextTruncated: boolean;
  artifactSnapshots: ArtifactSnapshot[];
  artifactReservations: Set<string>;
  artifactUpdatedAt: number;
  readyPattern?: string;
  readyWindow: string;
  /** Raw output tail is bounded, transient, and never persisted or exposed. */
  redactionPending: Record<"stdout" | "stderr", string>;
  redactionContinuation: Record<"stdout" | "stderr", RedactionContinuation | undefined>;
  stopReason?: ManagedExitReason;
  forceStopRequested: boolean;
  treeTerminationConfirmed: boolean;
  stdinError?: string;
  closePromise: Promise<void>;
  resolveClose: () => void;
  waiters: Set<() => void>;
  cleanupTimer?: NodeJS.Timeout;
  persistTimer?: NodeJS.Timeout;
  persistInFlight?: Promise<void>;
  persistDirty: boolean;
  lastPersistError?: string;
  persistChain: Promise<void>;
}

interface ForegroundRunRecord {
  controller: AbortController;
  done: Promise<void>;
  resolveDone: () => void;
}

type RedactionContinuation = "line" | "token";

export interface ToolProcessManagerOptions {
  workspaceRoot: string;
  environment?: NodeJS.ProcessEnv;
  platform?: NodeJS.Platform;
  now?: () => string;
  createId?: () => string;
  assertSession?: (sessionId: string) => Promise<boolean>;
}

export interface ToolProcessStartRequest {
  sessionId: string;
  toolCallId: string;
  command: string;
  args?: string[];
  cwd: string;
  environment?: Record<string, string>;
  interactionMode: ToolProcessInteractionMode;
  readyPattern?: string;
  startupTimeoutMs: number;
  signal?: AbortSignal;
}

export interface ToolProcessStartResult {
  session: ToolProcessSession;
  ready: boolean;
  startupTimedOut: boolean;
}

export interface ToolProcessWriteRequest {
  ownerSessionId: string;
  processSessionId: string;
  text?: string;
  appendNewline?: boolean;
  control?: "ctrl_c" | "ctrl_d";
}

export interface ToolProcessReadRequest {
  ownerSessionId: string;
  processSessionId: string;
  cursor?: number;
  maxChars?: number;
  waitMs?: number;
}

export interface ToolProcessStopRequest {
  ownerSessionId: string;
  processSessionId: string;
  strategy: ToolProcessStopStrategy;
  gracefulTimeoutMs: number;
  reason?: ManagedExitReason;
}

export interface ToolProcessArtifactSnapshot {
  content: string;
  capturedThroughCursor: number;
  truncated: boolean;
  capacityAvailable: boolean;
  reservationId?: string;
}

export class ToolProcessUnavailableError extends Error {
  public readonly capability: string;

  public constructor(capability: string, message: string) {
    super(message);
    this.name = "ToolProcessUnavailableError";
    this.capability = capability;
  }
}

function cloneSession(session: ToolProcessSession): ToolProcessSession {
  return {
    ...session,
    environmentSummary: {
      inheritedKeys: [...session.environmentSummary.inheritedKeys],
      overrideKeys: [...session.environmentSummary.overrideKeys],
      redactedKeys: [...session.environmentSummary.redactedKeys],
    },
    exit: session.exit
      ? {
          ...session.exit,
          spawnError: session.exit.spawnError ? { ...session.exit.spawnError } : undefined,
        }
      : undefined,
  };
}

function isActive(status: ToolProcessSession["status"]): boolean {
  return ACTIVE_STATUSES.has(status as "starting" | "running" | "stopping");
}

function isTerminal(status: ToolProcessSession["status"]): status is TerminalStatus {
  return TERMINAL_STATUSES.has(status as TerminalStatus);
}

function boundedInteger(value: number, minimum: number, maximum: number, label: string): number {
  if (!Number.isInteger(value) || value < minimum || value > maximum) {
    throw new Error(`${label} must be an integer between ${minimum} and ${maximum}.`);
  }
  return value;
}

function assertSafeText(value: string, label: string, maxChars: number): void {
  if (!value.trim()) throw new Error(`${label} cannot be empty.`);
  if (value.length > maxChars) throw new Error(`${label} exceeds ${maxChars} characters.`);
  if (value.includes("\0")) throw new Error(`${label} cannot contain NUL characters.`);
}

function normalizeEnvironmentKey(key: string): string {
  return key.toLocaleUpperCase("en-US");
}

function environmentValue(source: NodeJS.ProcessEnv, requestedKey: string): string | undefined {
  const normalized = normalizeEnvironmentKey(requestedKey);
  const entry = Object.entries(source).find(([key]) => normalizeEnvironmentKey(key) === normalized);
  return entry?.[1];
}

function redactUrlCredentials(value: string): string {
  // Besides tightening the URL boundary, this prevents a long ordinary
  // alphanumeric stream from restarting the greedy scheme match at every
  // character and turning redaction into quadratic work.
  return value.replace(/\b([a-z][a-z0-9+.-]*:\/\/)([^\s/@:]+):([^\s/@]+)@/giu, "$1[REDACTED]@");
}

/** Redacts before text enters either the ring buffer or an artifact snapshot. */
export function redactProcessText(value: string): string {
  return redactUrlCredentials(value)
    .replace(
      /(\b(?:authorization|proxy-authorization)\b\s*[:=]\s*)[^\r\n]*/giu,
      "$1[REDACTED]",
    )
    .replace(/(\b(?:cookie|set-cookie)\b\s*[:=]\s*)[^\r\n]*/giu, "$1[REDACTED]")
    .replace(/(\bconnection(?:[_-]?string)?\b\s*[:=]\s*)[^\r\n]*/giu, "$1[REDACTED]")
    .replace(/\b(Bearer|Basic)\s+[A-Za-z0-9._~+\/=-]{4,}/giu, "$1 [REDACTED]")
    .replace(/\b(?:sk-[A-Za-z0-9_-]{12,}|gh[pousr]_[A-Za-z0-9]{20,}|github_pat_[A-Za-z0-9_]{20,}|AKIA[0-9A-Z]{16})\b/gu, "[REDACTED]")
    .replace(
      /(["']?\b(?=[A-Za-z_][A-Za-z0-9_-]*\b)(?=[A-Za-z0-9_-]*(?:api[_-]?key|credential|password|secret|token))[A-Za-z_][A-Za-z0-9_-]*\b["']?\s*[:=]\s*)(?:"(?:\\.|[^"\r\n])*"|'(?:\\.|[^'\r\n])*'|[^\s,;}\]\r\n]+)/giu,
      "$1[REDACTED]",
    );
}

const STREAM_REDACTION_PATTERNS: ReadonlyArray<{
  regex: RegExp;
  continuation?: RedactionContinuation;
  preservePrefix?: boolean;
}> = [
  { regex: /\b([a-z][a-z0-9+.-]*:\/\/)[^\s/@:]+:[^\s/@]+@/giu, continuation: "token", preservePrefix: true },
  { regex: /(\b(?:authorization|proxy-authorization|cookie|set-cookie|connection(?:[_-]?string)?)\b\s*[:=]\s*)[^\r\n]*/giu, continuation: "line", preservePrefix: true },
  { regex: /(\b(?:Bearer|Basic)\s+)[A-Za-z0-9._~+\/=-]{4,}/giu, continuation: "token", preservePrefix: true },
  { regex: /(["']?\b(?=[A-Za-z_][A-Za-z0-9_-]*\b)(?=[A-Za-z0-9_-]*(?:api[_-]?key|credential|password|secret|token))[A-Za-z_][A-Za-z0-9_-]*\b["']?\s*[:=]\s*)(?:"(?:\\.|[^"\r\n])*"|'(?:\\.|[^'\r\n])*'|[^\s,;}\]\r\n]+)/giu, continuation: "token", preservePrefix: true },
  { regex: /\b(?:sk-[A-Za-z0-9_-]{2,}|gh[pousr]_[A-Za-z0-9]{2,}|github_pat_[A-Za-z0-9_]{2,}|AKIA[0-9A-Z]{2,})\b/gu, continuation: "token" },
];

function redactProcessStreamChunk(
  raw: string,
  continuation: RedactionContinuation | undefined,
  emitChars: number,
): { text: string; continuation: RedactionContinuation | undefined } {
  const masked = new Uint8Array(raw.length);
  let hasMaskedCharacters = false;
  let nextContinuation = continuation;

  if (continuation) {
    const delimiter = continuation === "line" ? /[\r\n]/u : /[\s,;}\]"']/u;
    let cursor = 0;
    while (cursor < raw.length && !delimiter.test(raw[cursor]!)) {
      masked[cursor] = 1;
      hasMaskedCharacters = true;
      cursor += 1;
    }
    nextContinuation = cursor >= raw.length || cursor > emitChars ? continuation : undefined;
  }

  for (const { regex, continuation: matchContinuation, preservePrefix } of STREAM_REDACTION_PATTERNS) {
    regex.lastIndex = 0;
    for (let match = regex.exec(raw); match; match = regex.exec(raw)) {
      const sensitiveStart = match.index + (preservePrefix ? (match[1]?.length ?? 0) : 0);
      const start = sensitiveStart;
      const end = match.index + match[0].length;
      for (let index = start; index < end; index += 1) {
        if (raw[index] !== "\r" && raw[index] !== "\n") {
          masked[index] = 1;
          hasMaskedCharacters = true;
        }
      }
      if (matchContinuation && end > emitChars) nextContinuation = matchContinuation;
      if (match[0].length === 0) regex.lastIndex += 1;
    }
  }

  // Normal process output contains no secrets. Avoid rebuilding that common
  // case one character at a time, especially for multi-megabyte streams.
  if (!hasMaskedCharacters) {
    return { text: raw.slice(0, emitChars), continuation: nextContinuation };
  }

  let text = "";
  for (let index = 0; index < emitChars; index += 1) {
    if (!masked[index]) {
      text += raw[index];
      continue;
    }
    text += "[REDACTED]";
    while (index + 1 < emitChars && masked[index + 1]) index += 1;
  }
  return { text, continuation: nextContinuation };
}

function redactArgument(value: string, previous?: string): string {
  if (previous && /^(?:--?)?(?:api[_-]?key|authorization|cookie|credential|password|secret|token)$/iu.test(previous)) {
    return "[REDACTED]";
  }
  if (SENSITIVE_KEY.test(value.split("=", 1)[0] ?? "") && value.includes("=")) {
    return `${value.slice(0, value.indexOf("=") + 1)}[REDACTED]`;
  }
  return redactProcessText(value);
}

export function summarizeProcessCommand(command: string, args: readonly string[]): string {
  const safeArgs = args.map((argument, index) => redactArgument(argument, args[index - 1]));
  return [redactProcessText(command), ...safeArgs]
    .map((entry) => (/\s/u.test(entry) ? JSON.stringify(entry) : entry))
    .join(" ")
    .slice(0, 2_000);
}

function quoteWindowsCmdArgument(value: string): string {
  if (/[\0\r\n"%!]/u.test(value)) {
    throw Object.assign(
      new Error("Windows cmd/bat arguments cannot contain NUL, CR, LF, double quote, percent, or exclamation expansion."),
      { code: "EINVAL" },
    );
  }
  // Every token is quoted. With delayed expansion disabled this keeps cmd
  // metacharacters such as &, |, <, >, ^ and parentheses inside one argv.
  return `"${value}"`;
}

export function resolveManagedSpawnCommand(
  command: string,
  args: readonly string[],
  platform: NodeJS.Platform = process.platform,
  environment: NodeJS.ProcessEnv = process.env,
): { file: string; args: string[]; windowsVerbatimArguments?: boolean } {
  if (platform === "win32" && /\.(?:cmd|bat)$/iu.test(command)) {
    const commandLine = [command, ...args].map(quoteWindowsCmdArgument).join(" ");
    return {
      file: environmentValue(environment, "ComSpec") ?? "cmd.exe",
      args: ["/d", "/s", "/c", `"${commandLine}"`],
      windowsVerbatimArguments: true,
    };
  }
  return { file: command, args: [...args] };
}

export function resolveForegroundShellCommand(
  command: string,
  platform: NodeJS.Platform = process.platform,
): { file: string; args: string[] } {
  return platform === "win32"
    ? { file: "powershell.exe", args: ["-NoProfile", "-Command", command] }
    : { file: "sh", args: ["-lc", command] };
}

function buildEnvironment(
  base: NodeJS.ProcessEnv,
  overrides: Record<string, string> | undefined,
): {
  environment: NodeJS.ProcessEnv;
  summary: ToolProcessSession["environmentSummary"];
} {
  const environment: NodeJS.ProcessEnv = {};
  const inheritedKeys: string[] = [];
  for (const key of SAFE_INHERITED_KEYS) {
    const value = environmentValue(base, key);
    if (value === undefined) continue;
    const outputKey = key === "PATH" && process.platform === "win32" ? "Path" : key;
    environment[outputKey] = value;
    inheritedKeys.push(outputKey);
  }

  const entries = Object.entries(overrides ?? {});
  if (entries.length > TOOL_PROCESS_LIMITS.maxEnvironmentEntries) {
    throw new Error(`Process environment exceeds ${TOOL_PROCESS_LIMITS.maxEnvironmentEntries} overrides.`);
  }
  const overrideKeys: string[] = [];
  const redactedKeys: string[] = [];
  for (const [key, value] of entries) {
    const normalized = normalizeEnvironmentKey(key);
    if (!/^[A-Za-z_][A-Za-z0-9_]*$/u.test(key)) throw new Error(`Invalid environment key: ${key}.`);
    if (SENSITIVE_KEY.test(key) || !SAFE_OVERRIDE_KEYS.has(normalized)) {
      redactedKeys.push(key);
      throw new Error(`Environment key is not on the managed-process whitelist: ${key}.`);
    }
    if (value.length > TOOL_PROCESS_LIMITS.maxEnvironmentValueChars || value.includes("\0")) {
      throw new Error(`Environment value for ${key} is invalid or too large.`);
    }
    environment[key] = value;
    overrideKeys.push(key);
  }
  return {
    environment,
    summary: {
      inheritedKeys: inheritedKeys.sort(),
      overrideKeys: overrideKeys.sort(),
      redactedKeys: redactedKeys.sort(),
    },
  };
}

function resolveInsideWorkspace(workspaceRoot: string, candidate: string): string {
  const absolute = path.resolve(workspaceRoot, candidate);
  const relative = path.relative(workspaceRoot, absolute);
  if (relative.startsWith("..") || path.isAbsolute(relative)) {
    throw new Error(`Process cwd escapes workspace root: ${candidate}.`);
  }
  return absolute;
}

async function runTaskkill(
  pid: number,
  force: boolean,
  environment: NodeJS.ProcessEnv,
  timeoutMs = 5_000,
): Promise<boolean> {
  return new Promise((resolve) => {
    let settled = false;
    let timer: NodeJS.Timeout | undefined;
    const finish = (result: boolean): void => {
      if (settled) return;
      settled = true;
      if (timer) clearTimeout(timer);
      resolve(result);
    };
    let child: ChildProcess;
    try {
      child = spawn("taskkill.exe", [
        "/pid",
        String(pid),
        "/t",
        ...(force ? ["/f"] : []),
      ], {
        windowsHide: true,
        stdio: "ignore",
        env: environment,
      });
    } catch {
      finish(false);
      return;
    }
    timer = setTimeout(() => {
      child.kill();
      finish(false);
    }, timeoutMs);
    timer.unref?.();
    child.once("error", () => finish(false));
    child.once("close", (code) => finish(code === 0));
  });
}

async function listWindowsDescendantPids(
  rootPid: number,
  cwd: string,
  environment: NodeJS.ProcessEnv,
): Promise<number[] | undefined> {
  const script = [
    `$root=${rootPid}`,
    "$items=@()",
    "try{$items=@(Get-CimInstance Win32_Process | Select-Object ProcessId,ParentProcessId)}catch{$items=@(Get-WmiObject Win32_Process | Select-Object ProcessId,ParentProcessId)}",
    "$seen=New-Object 'System.Collections.Generic.HashSet[int]'",
    "$frontier=@([int]$root)",
    "while($frontier.Count -gt 0){$next=@();foreach($item in $items){if($frontier -contains [int]$item.ParentProcessId){if($seen.Add([int]$item.ProcessId)){$next+=([int]$item.ProcessId)}}};$frontier=$next}",
    "[Console]::Out.Write((@($seen) -join ','))",
  ].join(";");
  const result = await runProcess({
    file: "powershell.exe",
    args: ["-NoProfile", "-NonInteractive", "-Command", script],
    cwd,
    timeoutMs: 5_000,
    maxOutputChars: 32_768,
    env: environment,
  });
  if (result.timedOut || result.spawnError || result.exitCode !== 0 || result.outputTruncated) return undefined;
  if (!result.stdout.trim()) return [];
  const pids = result.stdout
    .trim()
    .split(",")
    .map((value) => Number(value.trim()));
  return pids.every((pid) => Number.isInteger(pid) && pid > 0) ? [...new Set(pids)] : undefined;
}

function isPosixProcessGroupAlive(pid: number): boolean {
  try {
    process.kill(-pid, 0);
    return true;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === "EPERM";
  }
}

function wait(delayMs: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, delayMs));
}

export class ToolProcessManager {
  private readonly workspaceRoot: string;
  private readonly environment: NodeJS.ProcessEnv;
  private readonly platform: NodeJS.Platform;
  private readonly now: () => string;
  private readonly createId: () => string;
  private readonly assertSession?: (sessionId: string) => Promise<boolean>;
  private readonly stateDirectory: string;
  private readonly records = new Map<string, ManagedProcessRecord>();
  private readonly closingSessions = new Set<string>();
  private readonly sessionStopEpochs = new Map<string, number>();
  private initialization?: Promise<void>;
  private initialized = false;
  private disposed = false;
  private globalRetainedChars = 0;
  private globalArtifactChars = 0;
  private globalArtifactSnapshotCount = 0;
  private globalArtifactReservationCount = 0;
  private pendingStartCount = 0;
  private readonly pendingStartsBySession = new Map<string, number>();
  private readonly foregroundRuns = new Map<symbol, ForegroundRunRecord>();

  public constructor(options: ToolProcessManagerOptions) {
    this.workspaceRoot = path.resolve(options.workspaceRoot);
    this.environment = options.environment ?? process.env;
    this.platform = options.platform ?? process.platform;
    this.now = options.now ?? (() => new Date().toISOString());
    this.createId = options.createId ?? randomUUID;
    this.assertSession = options.assertSession;
    this.stateDirectory = path.join(this.workspaceRoot, ".deep-mix", "process-sessions");
  }

  public async initialize(): Promise<void> {
    if (this.initialized) return;
    this.initialization ??= this.initializeOnce();
    try {
      await this.initialization;
    } catch (error) {
      this.initialization = undefined;
      throw error;
    }
  }

  private async initializeOnce(): Promise<void> {
    await fs.mkdir(this.stateDirectory, { recursive: true });
    await this.recoverStatePublications();
    const entries = await fs.readdir(this.stateDirectory, { withFileTypes: true });
    const loaded: ToolProcessSession[] = [];
    for (const entry of entries) {
      if (!entry.isFile() || !entry.name.endsWith(".json")) continue;
      try {
        const session = JSON.parse(
          await fs.readFile(path.join(this.stateDirectory, entry.name), "utf8"),
        ) as ToolProcessSession;
        if (!session.processSessionId || !session.sessionId || !session.toolCallId) continue;
        loaded.push(session);
      } catch {
        // Invalid state is ignored rather than trusted as a controllable process.
      }
    }
    loaded.sort((left, right) => right.startedAt.localeCompare(left.startedAt));
    for (const original of loaded.slice(0, TOOL_PROCESS_LIMITS.maxRetainedSessions)) {
      const session = cloneSession(original);
      const lostBufferedChars = Math.max(0, session.nextCursor - session.retainedStartCursor);
      if (lostBufferedChars > 0) {
        session.retainedStartCursor = session.nextCursor;
        session.droppedOutputChars += lostBufferedChars;
        session.outputTruncated = true;
      }
      if (isActive(session.status)) {
        session.status = "orphaned";
        session.endedAt = this.now();
        session.orphanedReason = "Runtime restarted without a live child-process handle.";
        session.exit = {
          exitCode: null,
          reason: "control_lost",
        };
      }
      const record = this.createRecord(session);
      this.records.set(session.processSessionId, record);
      if (session.status === "orphaned") await this.persist(record);
      this.scheduleRetention(record);
    }
    for (const stale of loaded.slice(TOOL_PROCESS_LIMITS.maxRetainedSessions)) {
      await fs.rm(this.statePath(stale.processSessionId), { force: true });
    }
    this.initialized = true;
  }

  public async run(request: ToolProcessRequest): Promise<ToolProcessResult> {
    if (this.disposed) throw new Error("ToolProcessManager is disposed.");
    if (request.mode === "shell") assertForegroundShellCommand("foreground command", request.command, this.platform);
    else assertManagedExecutable("foreground command", request.command, request.args ?? [], this.platform);
    const cwd = resolveInsideWorkspace(this.workspaceRoot, request.cwd ?? ".");
    const resolved = request.mode === "shell"
      ? resolveForegroundShellCommand(request.command, this.platform)
      : { file: request.command, args: request.args ?? [] };
    const controller = new AbortController();
    const token = Symbol("foreground-run");
    let resolveDone = (): void => undefined;
    const done = new Promise<void>((resolve) => {
      resolveDone = resolve;
    });
    this.foregroundRuns.set(token, { controller, done, resolveDone });
    const relayAbort = (): void => controller.abort(request.signal?.reason);
    if (request.signal?.aborted) relayAbort();
    else request.signal?.addEventListener("abort", relayAbort, { once: true });
    try {
      const result = await runProcess({
        file: resolved.file,
        args: resolved.args,
        cwd,
        timeoutMs: request.timeoutMs ?? 60_000,
        ...(request.mode === "shell" ? {} : { maxOutputChars: request.maxOutputChars }),
        ...(request.mode === "shell" || request.input === undefined ? {} : { input: request.input }),
        env: request.environment ?? this.environment,
        signal: controller.signal,
        enforceTreeCleanup: true,
      });
      return {
        command: request.command,
        cwd: result.cwd,
        stdout: result.stdout,
        stderr: result.stderr,
        exitCode: result.exitCode,
        timedOut: result.timedOut,
        outputTruncated: result.outputTruncated,
        spawnError: result.spawnError,
      };
    } finally {
      request.signal?.removeEventListener("abort", relayAbort);
      this.foregroundRuns.delete(token);
      resolveDone();
    }
  }

  public async start(request: ToolProcessStartRequest): Promise<ToolProcessStartResult> {
    await this.initialize();
    request.signal?.throwIfAborted();
    const startEpoch = this.sessionStopEpochs.get(request.sessionId) ?? 0;
    this.assertStartFence(request.sessionId, startEpoch);
    assertSafeText(request.command, "Process command", 4_096);
    const args = request.args ?? [];
    if (args.length > MAX_ARGUMENTS) throw new Error(`Process arguments exceed ${MAX_ARGUMENTS} entries.`);
    for (const argument of args) assertSafeText(argument, "Process argument", MAX_ARGUMENT_CHARS);
    assertManagedExecutable("start_process", request.command, args, this.platform);
    if (request.readyPattern !== undefined) {
      assertSafeText(request.readyPattern, "Ready pattern", TOOL_PROCESS_LIMITS.maxReadyPatternChars);
    }
    const startupTimeoutMs = boundedInteger(
      request.startupTimeoutMs,
      TOOL_PROCESS_LIMITS.minStartupTimeoutMs,
      TOOL_PROCESS_LIMITS.maxStartupTimeoutMs,
      "startupTimeoutMs",
    );
    if (request.interactionMode === "pty") {
      throw new ToolProcessUnavailableError(
        "pty",
        "PTY support is unavailable in this production runtime; use interactionMode='pipe' for the restricted stdin fallback.",
      );
    }
    if (this.assertSession && !(await this.assertSession(request.sessionId))) {
      throw new Error(`Unknown owner session for process: ${request.sessionId}.`);
    }
    request.signal?.throwIfAborted();
    this.assertStartFence(request.sessionId, startEpoch);
    const active = [...this.records.values()].filter((record) => isActive(record.session.status));
    if (active.length + this.pendingStartCount >= TOOL_PROCESS_LIMITS.maxActiveProcesses) {
      throw new Error(`Active process limit reached (${TOOL_PROCESS_LIMITS.maxActiveProcesses}).`);
    }
    if (active.filter((record) => record.session.sessionId === request.sessionId).length +
        (this.pendingStartsBySession.get(request.sessionId) ?? 0) >=
      TOOL_PROCESS_LIMITS.maxActiveProcessesPerSession) {
      throw new Error(
        `Session active process limit reached (${TOOL_PROCESS_LIMITS.maxActiveProcessesPerSession}).`,
      );
    }

    const cwd = resolveInsideWorkspace(this.workspaceRoot, request.cwd);
    const environment = buildEnvironment(this.environment, request.environment);
    const resolved = resolveManagedSpawnCommand(request.command, args, this.platform, environment.environment);
    const processSessionId = this.createId();
    if (this.records.has(processSessionId)) throw new Error("Managed process identity collision.");
    this.pendingStartCount += 1;
    this.pendingStartsBySession.set(
      request.sessionId,
      (this.pendingStartsBySession.get(request.sessionId) ?? 0) + 1,
    );
    let pendingReleased = false;
    const releasePendingStart = (): void => {
      if (pendingReleased) return;
      pendingReleased = true;
      this.pendingStartCount = Math.max(0, this.pendingStartCount - 1);
      const remaining = Math.max(0, (this.pendingStartsBySession.get(request.sessionId) ?? 1) - 1);
      if (remaining === 0) this.pendingStartsBySession.delete(request.sessionId);
      else this.pendingStartsBySession.set(request.sessionId, remaining);
    };
    const startedAt = this.now();
    const session: ToolProcessSession = {
      processSessionId,
      sessionId: request.sessionId,
      toolCallId: request.toolCallId,
      status: "starting",
      cwd: path.relative(this.workspaceRoot, cwd).replace(/\\/gu, "/") || ".",
      commandSummary: summarizeProcessCommand(request.command, args),
      environmentSummary: environment.summary,
      interactionMode: request.interactionMode,
      ptyAvailable: false,
      startedAt,
      retainedStartCursor: 0,
      nextCursor: 0,
      totalOutputChars: 0,
      droppedOutputChars: 0,
      outputTruncated: false,
    };
    const record = this.createRecord(session);
    record.readyPattern = request.readyPattern;
    try {
      await this.persist(record);
      request.signal?.throwIfAborted();
      this.assertStartFence(request.sessionId, startEpoch);
    } catch (error) {
      releasePendingStart();
      await this.removeStatePublication(processSessionId);
      throw error;
    }
    this.records.set(processSessionId, record);
    this.pruneRetainedRecords();
    let child: ChildProcess;
    try {
      child = spawn(resolved.file, resolved.args, {
        cwd,
        env: environment.environment,
        detached: this.platform !== "win32",
        windowsHide: true,
        windowsVerbatimArguments: resolved.windowsVerbatimArguments,
        stdio: [request.interactionMode === "pipe" ? "pipe" : "ignore", "pipe", "pipe"],
      });
    } catch (error) {
      releasePendingStart();
      await this.finalize(record, "failed", {
        exitCode: null,
        reason: "spawn_error",
        spawnError: {
          code: (error as NodeJS.ErrnoException).code,
          message: redactProcessText((error as Error).message),
        },
      });
      return { session: cloneSession(record.session), ready: false, startupTimedOut: false };
    }
    releasePendingStart();
    record.child = child;
    if (child.pid !== undefined) {
      record.session.pid = child.pid;
      record.session.processGroupId = child.pid;
    }
    child.stdout?.setEncoding("utf8");
    child.stderr?.setEncoding("utf8");
    child.stdout?.on("data", (chunk) => this.appendOutput(record, "stdout", String(chunk)));
    child.stderr?.on("data", (chunk) => this.appendOutput(record, "stderr", String(chunk)));
    child.stdin?.on("error", (error) => {
      record.stdinError = redactProcessText(error.message);
    });
    child.once("spawn", () => {
      if (record.session.status !== "starting") return;
      record.session.status = "running";
      record.session.pid = child.pid;
      record.session.processGroupId = child.pid;
      if (!record.readyPattern) record.session.readyAt = this.now();
      this.schedulePersist(record);
      this.notify(record);
    });
    child.once("error", (error) => {
      if (isTerminal(record.session.status)) return;
      this.runInBackground(this.finalize(record, "failed", {
        exitCode: null,
        reason: "spawn_error",
        spawnError: {
          code: (error as NodeJS.ErrnoException).code,
          message: redactProcessText(error.message),
        },
      }), record);
    });
    child.once("close", (code, signal) => {
      if (isTerminal(record.session.status)) {
        record.resolveClose();
        this.releaseChildHandle(record);
        return;
      }
      this.runInBackground(
        this.handleChildClose(record, code, signal).finally(() => this.releaseChildHandle(record)),
        record,
      );
    });

    const abortHandler = (): void => {
      this.runInBackground(
        this.stopInternal(record, "graceful_then_force", 1_000, "session_interrupted"),
        record,
      );
    };
    request.signal?.addEventListener("abort", abortHandler, { once: true });
    if (request.signal?.aborted) abortHandler();
    const releaseAbortHandler = (): void => request.signal?.removeEventListener("abort", abortHandler);

    const reachedStartupState = await this.waitUntil(
      record,
      () => Boolean(record.session.readyAt) || isTerminal(record.session.status),
      startupTimeoutMs,
    );
    if (!reachedStartupState && isActive(record.session.status)) {
      await this.stopInternal(record, "force", Math.min(2_000, startupTimeoutMs), "startup_timeout");
      releaseAbortHandler();
      return { session: cloneSession(record.session), ready: false, startupTimedOut: true };
    }
    const durable = await this.persistSafely(record);
    if (!durable && isActive(record.session.status)) {
      await this.stopInternal(record, "force", 1_000, "control_lost");
    }
    releaseAbortHandler();
    return {
      session: cloneSession(record.session),
      ready: Boolean(record.session.readyAt),
      startupTimedOut: false,
    };
  }

  public async writeInput(request: ToolProcessWriteRequest): Promise<ToolProcessInputResult> {
    const record = this.requireOwned(request.ownerSessionId, request.processSessionId);
    if (record.session.status !== "running") {
      throw new Error(`Process ${request.processSessionId} is not active for stdin writes.`);
    }
    const stdin = record.child?.stdin;
    if (record.session.interactionMode !== "pipe" || !stdin?.writable || stdin.destroyed || stdin.writableEnded) {
      throw new ToolProcessUnavailableError("stdin", "The process was not started with the pipe interaction fallback.");
    }
    if (record.stdinError) throw new Error(`Process stdin is unavailable: ${record.stdinError}`);
    const text = request.text ?? "";
    if (text.length > TOOL_PROCESS_LIMITS.maxInputChars) {
      throw new Error(`Process input exceeds ${TOOL_PROCESS_LIMITS.maxInputChars} characters.`);
    }
    if (/[\u0000-\u0002\u0005-\u0008\u000b\u000c\u000e-\u001f\u007f]/u.test(text)) {
      throw new Error("Process input contains a disallowed control character.");
    }
    let payload = text;
    if (request.control) payload += request.control === "ctrl_c" ? "\u0003" : "\u0004";
    if (request.appendNewline) payload += "\n";
    if (!payload) throw new Error("Process input must include text, a newline, or a supported control character.");
    await new Promise<void>((resolve, reject) => {
      stdin.write(payload, "utf8", (error) => {
        if (error) reject(error);
        else resolve();
      });
    }).catch((error: Error) => {
      record.stdinError = redactProcessText(error.message);
      throw new Error(`Process stdin write failed: ${record.stdinError}`);
    });
    if (record.session.status !== "running") {
      throw new Error(`Process ${request.processSessionId} exited before stdin input was accepted.`);
    }
    return {
      processSessionId: request.processSessionId,
      status: record.session.status,
      acceptedChars: payload.length,
      appendedNewline: Boolean(request.appendNewline),
      control: request.control,
    };
  }

  public async readOutput(request: ToolProcessReadRequest): Promise<ToolProcessOutputChunk> {
    const record = this.requireOwned(request.ownerSessionId, request.processSessionId);
    const requestedCursor = request.cursor ?? record.session.retainedStartCursor;
    if (!Number.isInteger(requestedCursor) || requestedCursor < 0 || requestedCursor > record.session.nextCursor) {
      throw new Error(`Process cursor must be between 0 and ${record.session.nextCursor}.`);
    }
    const maxChars = boundedInteger(
      request.maxChars ?? TOOL_PROCESS_LIMITS.defaultOutputChunkChars,
      1,
      TOOL_PROCESS_LIMITS.maxOutputChunkChars,
      "maxChars",
    );
    const waitMs = boundedInteger(request.waitMs ?? 0, 0, TOOL_PROCESS_LIMITS.maxOutputWaitMs, "waitMs");
    let waitTimedOut = false;
    if (requestedCursor >= record.session.nextCursor && isActive(record.session.status) && waitMs > 0) {
      const changed = await this.waitUntil(
        record,
        () => record.session.nextCursor > requestedCursor || isTerminal(record.session.status),
        waitMs,
      );
      waitTimedOut = !changed;
    }

    const startCursor = Math.max(requestedCursor, record.session.retainedStartCursor);
    const cursorExpired = requestedCursor < record.session.retainedStartCursor;
    const droppedBeforeCursor = Math.max(0, record.session.retainedStartCursor - requestedCursor);
    let remaining = maxChars;
    let nextCursor = startCursor;
    let stdout = "";
    let stderr = "";
    for (const chunk of record.buffer) {
      if (remaining <= 0 || chunk.endCursor <= startCursor) continue;
      const offset = Math.max(0, startCursor - chunk.startCursor);
      const text = chunk.text.slice(offset, offset + remaining);
      if (!text) continue;
      if (chunk.stream === "stdout") stdout += text;
      else stderr += text;
      remaining -= text.length;
      nextCursor = chunk.startCursor + offset + text.length;
      if (text.length + offset < chunk.text.length) break;
    }
    const latestArtifact = record.artifactSnapshots.at(-1);
    return {
      processSessionId: request.processSessionId,
      status: record.session.status,
      requestedCursor,
      startCursor,
      nextCursor,
      stdout,
      stderr,
      hasMore: nextCursor < record.session.nextCursor,
      waitTimedOut,
      cursorExpired,
      droppedBeforeCursor,
      totalOutputChars: record.session.totalOutputChars,
      outputTruncated: record.session.outputTruncated,
      artifactUri: latestArtifact?.artifact.uri,
      artifactCapturedThroughCursor: latestArtifact?.capturedThroughCursor,
      artifactTruncated: latestArtifact?.truncated,
    };
  }

  public async stop(request: ToolProcessStopRequest): Promise<ToolProcessStopResult> {
    const record = this.requireOwned(request.ownerSessionId, request.processSessionId);
    return this.stopInternal(
      record,
      request.strategy,
      boundedInteger(
        request.gracefulTimeoutMs,
        0,
        TOOL_PROCESS_LIMITS.maxStopGraceMs,
        "gracefulTimeoutMs",
      ),
      request.reason ?? "graceful_stop",
    );
  }

  public async stopSession(sessionId: string, reason: ManagedExitReason = "session_interrupted"): Promise<void> {
    const stopEpoch = (this.sessionStopEpochs.get(sessionId) ?? 0) + 1;
    this.sessionStopEpochs.set(sessionId, stopEpoch);
    this.closingSessions.add(sessionId);
    try {
      await this.initialize();
      const owned = [...this.records.values()].filter(
        (record) => record.session.sessionId === sessionId && isActive(record.session.status),
      );
      await Promise.allSettled(
        owned.map((record) => this.stopInternal(record, "graceful_then_force", 2_000, reason)),
      );
    } finally {
      if (this.sessionStopEpochs.get(sessionId) === stopEpoch) this.closingSessions.delete(sessionId);
    }
  }

  public list(sessionId?: string): ToolProcessSession[] {
    return [...this.records.values()]
      .filter((record) => !sessionId || record.session.sessionId === sessionId)
      .sort((left, right) => right.session.startedAt.localeCompare(left.session.startedAt))
      .slice(0, TOOL_PROCESS_LIMITS.maxRetainedSessions)
      .map((record) => cloneSession(record.session));
  }

  public getArtifactSnapshot(ownerSessionId: string, processSessionId: string): ToolProcessArtifactSnapshot {
    const record = this.requireOwned(ownerSessionId, processSessionId);
    const capacityAvailable = Boolean(record.artifactText) &&
      record.artifactSnapshots.length + record.artifactReservations.size <
        TOOL_PROCESS_LIMITS.maxArtifactSnapshotsPerProcess &&
      this.globalArtifactSnapshotCount + this.globalArtifactReservationCount <
        TOOL_PROCESS_LIMITS.maxGlobalArtifactSnapshots;
    const reservationId = capacityAvailable ? randomUUID() : undefined;
    if (reservationId) {
      record.artifactReservations.add(reservationId);
      this.globalArtifactReservationCount += 1;
    }
    return {
      content: record.artifactText,
      capturedThroughCursor: record.session.nextCursor,
      truncated: record.artifactTextTruncated,
      capacityAvailable,
      reservationId,
    };
  }

  public attachArtifact(
    ownerSessionId: string,
    processSessionId: string,
    artifact: ToolOutputArtifact,
    capturedThroughCursor: number,
    truncated: boolean,
    reservationId: string,
  ): boolean {
    const record = this.requireOwned(ownerSessionId, processSessionId);
    if (!record.artifactReservations.delete(reservationId)) return false;
    this.globalArtifactReservationCount = Math.max(0, this.globalArtifactReservationCount - 1);
    if (record.artifactSnapshots.length >= TOOL_PROCESS_LIMITS.maxArtifactSnapshotsPerProcess ||
        this.globalArtifactSnapshotCount >= TOOL_PROCESS_LIMITS.maxGlobalArtifactSnapshots) return false;
    record.artifactSnapshots.push({ artifact, capturedThroughCursor, truncated });
    this.globalArtifactSnapshotCount += 1;
    this.notify(record);
    return true;
  }

  public releaseArtifactReservation(
    ownerSessionId: string,
    processSessionId: string,
    reservationId: string,
  ): void {
    const record = this.requireOwned(ownerSessionId, processSessionId);
    if (!record.artifactReservations.delete(reservationId)) return;
    this.globalArtifactReservationCount = Math.max(0, this.globalArtifactReservationCount - 1);
  }

  public async dispose(): Promise<void> {
    if (this.disposed) return;
    this.disposed = true;
    const foregroundRuns = [...this.foregroundRuns.values()];
    for (const run of foregroundRuns) {
      if (!run.controller.signal.aborted) run.controller.abort(new Error("ToolProcessManager runtime disposed."));
    }
    await this.initialize();
    const active = [...this.records.values()].filter((record) => isActive(record.session.status));
    await Promise.allSettled(
      active.map((record) => this.stopInternal(record, "graceful_then_force", 2_000, "runtime_dispose")),
    );
    await Promise.allSettled(
      [...this.records.values()]
        .filter((record) => Boolean(record.child))
        .map((record) => Promise.race([record.closePromise, wait(1_000)])),
    );
    await Promise.allSettled(foregroundRuns.map((run) => run.done));
    // Windows may release a just-closed process cwd one scheduler turn after
    // the close event; keep dispose deterministic for workspace deletion.
    if (this.platform === "win32") await wait(100);
    for (const record of this.records.values()) {
      if (record.cleanupTimer) clearTimeout(record.cleanupTimer);
      if (record.persistTimer) clearTimeout(record.persistTimer);
      this.notify(record);
    }
  }

  private createRecord(session: ToolProcessSession): ManagedProcessRecord {
    let resolveClose = (): void => undefined;
    const closePromise = new Promise<void>((resolve) => {
      resolveClose = resolve;
    });
    return {
      session,
      buffer: [],
      retainedChars: 0,
      artifactText: "",
      artifactTextTruncated: false,
      artifactSnapshots: [],
      artifactReservations: new Set(),
      artifactUpdatedAt: Date.now(),
      readyWindow: "",
      redactionPending: { stdout: "", stderr: "" },
      redactionContinuation: { stdout: undefined, stderr: undefined },
      forceStopRequested: false,
      treeTerminationConfirmed: false,
      closePromise,
      resolveClose,
      waiters: new Set(),
      persistDirty: false,
      persistChain: Promise.resolve(),
    };
  }

  private requireOwned(ownerSessionId: string, processSessionId: string): ManagedProcessRecord {
    const record = this.records.get(processSessionId);
    if (!record || record.session.sessionId !== ownerSessionId) {
      throw new Error(`Process ${processSessionId} is not owned by session ${ownerSessionId}.`);
    }
    return record;
  }

  private releaseChildHandle(record: ManagedProcessRecord): void {
    const child = record.child;
    if (!child) return;
    child.stdin?.destroy();
    child.stdout?.destroy();
    child.stderr?.destroy();
    child.removeAllListeners();
    record.child = undefined;
  }

  private appendOutput(record: ManagedProcessRecord, stream: "stdout" | "stderr", raw: string): void {
    if (!raw) return;
    record.readyWindow = `${record.readyWindow}${raw}`.slice(-4_096);
    if (record.readyPattern && !record.session.readyAt && record.readyWindow.includes(record.readyPattern)) {
      record.session.readyAt = this.now();
    }
    record.redactionPending[stream] += raw;
    this.flushPendingOutput(record, stream, false);
  }

  private flushPendingOutput(
    record: ManagedProcessRecord,
    stream: "stdout" | "stderr",
    flushAll: boolean,
  ): void {
    const pending = record.redactionPending[stream];
    if (!pending) return;
    const lastLineFeed = Math.max(pending.lastIndexOf("\n"), pending.lastIndexOf("\r"));
    const emitChars = flushAll
      ? pending.length
      : lastLineFeed >= 0
        ? lastLineFeed + 1
        : Math.max(0, pending.length - STREAM_REDACTION_HOLDBACK_CHARS);
    if (emitChars <= 0) return;
    const streamed = redactProcessStreamChunk(
      pending,
      record.redactionContinuation[stream],
      emitChars,
    );
    record.redactionPending[stream] = pending.slice(emitChars);
    record.redactionContinuation[stream] = streamed.continuation;
    this.appendRedactedOutput(record, stream, streamed.text);
  }

  private appendRedactedOutput(
    record: ManagedProcessRecord,
    stream: "stdout" | "stderr",
    redacted: string,
  ): void {
    if (!redacted) return;
    for (let offset = 0; offset < redacted.length; offset += TOOL_PROCESS_LIMITS.maxBufferedChunkChars) {
      const text = redacted.slice(offset, offset + TOOL_PROCESS_LIMITS.maxBufferedChunkChars);
      const startCursor = record.session.nextCursor;
      const endCursor = startCursor + text.length;
      record.buffer.push({ stream, startCursor, endCursor, text, createdAt: Date.now() });
      record.retainedChars += text.length;
      this.globalRetainedChars += text.length;
      record.session.nextCursor = endCursor;
      record.session.totalOutputChars += text.length;
      record.session.lastOutputAt = this.now();
      const artifactAddition = `[${stream}] ${text}`;
      record.artifactText += artifactAddition;
      record.artifactUpdatedAt = Date.now();
      this.globalArtifactChars += artifactAddition.length;
      if (record.artifactText.length > TOOL_PROCESS_LIMITS.maxCumulativeArtifactCharsPerProcess) {
        const excess = record.artifactText.length - TOOL_PROCESS_LIMITS.maxCumulativeArtifactCharsPerProcess;
        record.artifactText = record.artifactText.slice(excess);
        this.globalArtifactChars -= excess;
        record.artifactTextTruncated = true;
      }
    }
    this.trimRecord(record);
    const globallyTrimmed = this.trimGlobal();
    const artifactTrimmed = this.trimGlobalArtifacts();
    this.schedulePersist(record);
    this.notify(record);
    for (const trimmed of new Set([...globallyTrimmed, ...artifactTrimmed])) {
      if (trimmed === record) continue;
      this.schedulePersist(trimmed);
      this.notify(trimmed);
    }
  }

  private trimRecord(record: ManagedProcessRecord): void {
    while (record.retainedChars > TOOL_PROCESS_LIMITS.maxBufferCharsPerProcess && record.buffer.length > 0) {
      const first = record.buffer[0]!;
      const excess = record.retainedChars - TOOL_PROCESS_LIMITS.maxBufferCharsPerProcess;
      if (first.text.length <= excess) {
        record.buffer.shift();
        record.retainedChars -= first.text.length;
        this.globalRetainedChars -= first.text.length;
        record.session.retainedStartCursor = first.endCursor;
        record.session.droppedOutputChars += first.text.length;
      } else {
        first.text = first.text.slice(excess);
        first.startCursor += excess;
        record.retainedChars -= excess;
        this.globalRetainedChars -= excess;
        record.session.retainedStartCursor = first.startCursor;
        record.session.droppedOutputChars += excess;
      }
      record.session.outputTruncated = true;
    }
  }

  private trimGlobal(): Set<ManagedProcessRecord> {
    const trimmed = new Set<ManagedProcessRecord>();
    while (this.globalRetainedChars > TOOL_PROCESS_LIMITS.maxGlobalBufferChars) {
      const candidate = [...this.records.values()]
        .filter((record) => record.buffer.length > 0)
        .sort((left, right) => left.buffer[0]!.createdAt - right.buffer[0]!.createdAt)[0];
      if (!candidate) break;
      const chunk = candidate.buffer.shift()!;
      candidate.retainedChars -= chunk.text.length;
      this.globalRetainedChars -= chunk.text.length;
      candidate.session.retainedStartCursor = chunk.endCursor;
      candidate.session.droppedOutputChars += chunk.text.length;
      candidate.session.outputTruncated = true;
      trimmed.add(candidate);
    }
    return trimmed;
  }

  private trimGlobalArtifacts(): Set<ManagedProcessRecord> {
    const trimmed = new Set<ManagedProcessRecord>();
    while (this.globalArtifactChars > TOOL_PROCESS_LIMITS.maxGlobalArtifactChars) {
      const candidate = [...this.records.values()]
        .filter((record) => record.artifactText.length > 0)
        .sort((left, right) => left.artifactUpdatedAt - right.artifactUpdatedAt)[0];
      if (!candidate) break;
      const excess = this.globalArtifactChars - TOOL_PROCESS_LIMITS.maxGlobalArtifactChars;
      const removed = Math.min(candidate.artifactText.length, Math.max(1, excess));
      candidate.artifactText = candidate.artifactText.slice(removed);
      candidate.artifactTextTruncated = true;
      this.globalArtifactChars -= removed;
      trimmed.add(candidate);
    }
    return trimmed;
  }

  private async stopInternal(
    record: ManagedProcessRecord,
    strategy: ToolProcessStopStrategy,
    gracefulTimeoutMs: number,
    reason: ManagedExitReason,
  ): Promise<ToolProcessStopResult> {
    if (record.session.status === "orphaned") {
      return {
        processSessionId: record.session.processSessionId,
        status: record.session.status,
        outcome: "unable_to_confirm",
        strategy,
        gracefulWaitMs: gracefulTimeoutMs,
        exit: record.session.exit,
      };
    }
    if (isTerminal(record.session.status)) {
      return {
        processSessionId: record.session.processSessionId,
        status: record.session.status,
        outcome: "already_exited",
        strategy,
        gracefulWaitMs: gracefulTimeoutMs,
        exit: record.session.exit,
      };
    }
    record.session.status = "stopping";
    record.stopReason = reason;
    this.schedulePersist(record);
    this.notify(record);
    let forced = strategy === "force";
    if (strategy === "force") {
      record.forceStopRequested = true;
      record.treeTerminationConfirmed = await this.signalTree(record, true);
    } else {
      record.treeTerminationConfirmed = await this.signalTree(record, false);
      const stoppedGracefully = await this.waitUntil(record, () => isTerminal(record.session.status), gracefulTimeoutMs);
      if (!stoppedGracefully && strategy === "graceful_then_force") {
        forced = true;
        record.forceStopRequested = true;
        record.stopReason = reason === "graceful_stop" ? "force_stop" : reason;
        record.treeTerminationConfirmed = await this.signalTree(record, true);
      } else if (!stoppedGracefully) {
        record.session.status = "running";
        record.stopReason = undefined;
        record.treeTerminationConfirmed = false;
        this.schedulePersist(record);
        return {
          processSessionId: record.session.processSessionId,
          status: record.session.status,
          outcome: "unable_to_confirm",
          strategy,
          gracefulWaitMs: gracefulTimeoutMs,
        };
      }
    }
    const confirmed = isTerminal(record.session.status) ||
      await this.waitUntil(record, () => isTerminal(record.session.status), Math.max(1_000, gracefulTimeoutMs));
    if (!confirmed) {
      record.session.orphanedReason = "Termination was requested but process-tree exit could not be confirmed.";
      await this.finalize(record, "orphaned", {
        exitCode: null,
        reason: "control_lost",
      });
      return {
        processSessionId: record.session.processSessionId,
        status: record.session.status,
        outcome: "unable_to_confirm",
        strategy,
        gracefulWaitMs: gracefulTimeoutMs,
        exit: record.session.exit,
      };
    }
    return {
      processSessionId: record.session.processSessionId,
      status: record.session.status,
      outcome: forced ? "force_terminated" : "terminated",
      strategy,
      gracefulWaitMs: gracefulTimeoutMs,
      exit: record.session.exit,
    };
  }

  private async signalTree(record: ManagedProcessRecord, force: boolean): Promise<boolean> {
    const pid = record.session.pid;
    if (!pid) return false;
    if (this.platform === "win32") {
      const killed = await runTaskkill(pid, force, buildEnvironment(this.environment, undefined).environment);
      if (!killed) record.child?.kill(force ? "SIGKILL" : undefined);
      return killed;
    }
    try {
      process.kill(-pid, force ? "SIGKILL" : "SIGTERM");
      return false;
    } catch {
      record.child?.kill(force ? "SIGKILL" : "SIGTERM");
      return false;
    }
  }

  private async handleChildClose(
    record: ManagedProcessRecord,
    code: number | null,
    signal: NodeJS.Signals | null,
  ): Promise<void> {
    this.flushPendingOutput(record, "stdout", true);
    this.flushPendingOutput(record, "stderr", true);
    if (isTerminal(record.session.status)) {
      await this.persistSafely(record);
      record.resolveClose();
      return;
    }
    const stopped = record.session.status === "stopping" || record.stopReason !== undefined;
    const treeClean = record.treeTerminationConfirmed || await this.cleanupResidualTree(record);
    if (!treeClean) {
      record.session.orphanedReason = stopped
        ? "The root process exited, but process-tree termination could not be confirmed."
        : "The root process exited, but residual descendants could not be cleaned or ruled out.";
      await this.finalize(record, "orphaned", {
        exitCode: code,
        signal: signal ?? undefined,
        reason: "control_lost",
      });
      return;
    }
    const reason = record.stopReason ?? (code === 0 ? "completed" : "nonzero_exit");
    const status: TerminalStatus = stopped ? "stopped" : code === 0 ? "exited" : "failed";
    await this.finalize(record, status, {
      exitCode: code,
      signal: signal ?? undefined,
      reason,
    });
  }

  private async cleanupResidualTree(record: ManagedProcessRecord): Promise<boolean> {
    const pid = record.session.processGroupId ?? record.session.pid;
    if (!pid) return false;
    if (this.platform === "win32") {
      const environment = buildEnvironment(this.environment, undefined).environment;
      const descendants = await listWindowsDescendantPids(pid, this.workspaceRoot, environment);
      if (descendants === undefined) return false;
      for (const descendantPid of descendants.reverse()) {
        await runTaskkill(descendantPid, true, environment);
      }
      if (descendants.length > 0) await wait(100);
      const remaining = await listWindowsDescendantPids(pid, this.workspaceRoot, environment);
      return remaining !== undefined && remaining.length === 0;
    }
    if (!isPosixProcessGroupAlive(pid)) return true;
    try {
      process.kill(-pid, "SIGTERM");
    } catch {
      // The confirmation below distinguishes a completed cleanup from loss of control.
    }
    await wait(250);
    if (!isPosixProcessGroupAlive(pid)) return true;
    try {
      process.kill(-pid, "SIGKILL");
    } catch {
      // The final group probe is authoritative.
    }
    await wait(250);
    return !isPosixProcessGroupAlive(pid);
  }

  private async finalize(
    record: ManagedProcessRecord,
    status: TerminalStatus,
    exit: ToolProcessExitInfo,
  ): Promise<void> {
    if (isTerminal(record.session.status) && record.session.exit) return;
    record.session.status = status;
    record.session.endedAt = this.now();
    record.session.exit = {
      ...exit,
      reason: record.forceStopRequested && exit.reason === "graceful_stop" ? "force_stop" : exit.reason,
    };
    record.redactionPending = { stdout: "", stderr: "" };
    record.redactionContinuation = { stdout: undefined, stderr: undefined };
    await this.persistSafely(record);
    record.resolveClose();
    this.notify(record);
    this.scheduleRetention(record);
    this.pruneRetainedRecords();
  }

  private waitUntil(record: ManagedProcessRecord, predicate: () => boolean, waitMs: number): Promise<boolean> {
    if (predicate()) return Promise.resolve(true);
    return new Promise((resolve) => {
      let settled = false;
      const finish = (value: boolean): void => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        record.waiters.delete(onChange);
        resolve(value);
      };
      const onChange = (): void => {
        if (predicate()) finish(true);
      };
      const timer = setTimeout(() => finish(predicate()), waitMs);
      timer.unref?.();
      record.waiters.add(onChange);
    });
  }

  private notify(record: ManagedProcessRecord): void {
    for (const waiter of [...record.waiters]) waiter();
  }

  private scheduleRetention(record: ManagedProcessRecord): void {
    if (!isTerminal(record.session.status) || record.cleanupTimer || this.disposed) return;
    const elapsed = Date.now() - new Date(record.session.endedAt ?? record.session.startedAt).getTime();
    const delay = Math.max(0, TOOL_PROCESS_LIMITS.completedSessionRetentionMs - elapsed);
    record.cleanupTimer = setTimeout(() => {
      this.releaseRecord(record);
    }, delay);
    record.cleanupTimer.unref?.();
  }

  private assertStartFence(sessionId: string, expectedEpoch: number): void {
    if (this.disposed) throw new Error("ToolProcessManager is disposed.");
    if (this.closingSessions.has(sessionId) || (this.sessionStopEpochs.get(sessionId) ?? 0) !== expectedEpoch) {
      throw new Error(`Owner session ${sessionId} is stopped or being stopped; managed process start was cancelled.`);
    }
  }

  private pruneRetainedRecords(): void {
    while (this.records.size > TOOL_PROCESS_LIMITS.maxRetainedSessions) {
      const candidate = [...this.records.values()]
        .filter((record) => isTerminal(record.session.status))
        .sort((left, right) => left.session.startedAt.localeCompare(right.session.startedAt))[0];
      if (!candidate) return;
      this.releaseRecord(candidate);
    }
  }

  private releaseRecord(record: ManagedProcessRecord): void {
    if (this.records.get(record.session.processSessionId) !== record) return;
    if (record.cleanupTimer) clearTimeout(record.cleanupTimer);
    if (record.persistTimer) clearTimeout(record.persistTimer);
    this.globalRetainedChars = Math.max(0, this.globalRetainedChars - record.retainedChars);
    this.globalArtifactChars = Math.max(0, this.globalArtifactChars - record.artifactText.length);
    this.globalArtifactSnapshotCount = Math.max(
      0,
      this.globalArtifactSnapshotCount - record.artifactSnapshots.length,
    );
    this.globalArtifactReservationCount = Math.max(
      0,
      this.globalArtifactReservationCount - record.artifactReservations.size,
    );
    record.artifactReservations.clear();
    this.records.delete(record.session.processSessionId);
    this.runInBackground(this.removeStatePublication(record.session.processSessionId));
  }

  private schedulePersist(record: ManagedProcessRecord): void {
    record.persistDirty = true;
    if (record.persistTimer || record.persistInFlight) return;
    record.persistTimer = setTimeout(() => {
      record.persistTimer = undefined;
      void this.flushPersist(record).catch((error: Error) => {
        record.lastPersistError = redactProcessText(error.message);
      });
    }, 100);
    record.persistTimer.unref?.();
  }

  private async flushPersist(record: ManagedProcessRecord): Promise<void> {
    if (record.persistTimer) {
      clearTimeout(record.persistTimer);
      record.persistTimer = undefined;
    }
    if (record.persistInFlight) {
      await record.persistInFlight;
      if (record.persistDirty) this.schedulePersist(record);
      return;
    }
    if (!record.persistDirty) return;
    record.persistDirty = false;
    const operation = this.persist(record);
    record.persistInFlight = operation;
    try {
      await operation;
    } finally {
      if (record.persistInFlight === operation) record.persistInFlight = undefined;
      if (record.persistDirty) this.schedulePersist(record);
    }
  }

  private async persistSafely(record: ManagedProcessRecord): Promise<boolean> {
    try {
      record.persistDirty = true;
      for (let attempt = 0; attempt < 3; attempt += 1) {
        await this.flushPersist(record);
        if (!isTerminal(record.session.status) || (!record.persistDirty && !record.persistInFlight)) break;
      }
      record.lastPersistError = undefined;
      return !isTerminal(record.session.status) || (!record.persistDirty && !record.persistInFlight);
    } catch (error) {
      record.lastPersistError = redactProcessText((error as Error).message);
      return false;
    }
  }

  private runInBackground(promise: Promise<unknown>, record?: ManagedProcessRecord): void {
    void promise.catch((error: Error) => {
      if (!record) return;
      record.lastPersistError = redactProcessText(error.message);
      if (!isTerminal(record.session.status)) {
        void this.signalTree(record, true)
          .catch(() => false)
          .then(async () => {
            if (isTerminal(record.session.status)) return;
            record.session.status = "orphaned";
            record.session.endedAt = this.now();
            record.session.orphanedReason = "An internal lifecycle operation failed; process control cannot be confirmed.";
            record.session.exit = { exitCode: null, reason: "control_lost" };
            await this.persistSafely(record);
            this.notify(record);
            this.scheduleRetention(record);
          })
          .catch(() => undefined);
      }
    });
  }

  private async persist(record: ManagedProcessRecord): Promise<void> {
    const operation = record.persistChain.then(async () => {
      const snapshot = cloneSession(record.session);
      await fs.mkdir(this.stateDirectory, { recursive: true });
      const target = this.statePath(record.session.processSessionId);
      const temporary = `${target}.${process.pid}.${randomUUID()}.tmp`;
      try {
        await fs.writeFile(temporary, `${JSON.stringify(snapshot, null, 2)}\n`, {
          encoding: "utf8",
          mode: 0o600,
        });
        if (this.platform !== "win32") {
          await fs.rename(temporary, target);
        } else {
          const backup = `${target}.bak`;
          await fs.rm(backup, { force: true });
          let backedUp = false;
          try {
            await fs.rename(target, backup);
            backedUp = true;
          } catch (error) {
            if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
          }
          try {
            await fs.rename(temporary, target);
            await fs.rm(backup, { force: true });
          } catch (error) {
            if (backedUp) {
              await fs.rm(target, { force: true }).catch(() => undefined);
              await fs.rename(backup, target).catch(() => undefined);
            }
            throw error;
          }
        }
      } finally {
        await fs.rm(temporary, { force: true }).catch(() => undefined);
      }
    });
    record.persistChain = operation.catch(() => undefined);
    await operation;
  }

  private async recoverStatePublications(): Promise<void> {
    const entries = await fs.readdir(this.stateDirectory, { withFileTypes: true });
    for (const entry of entries) {
      if (!entry.isFile()) continue;
      const candidate = path.join(this.stateDirectory, entry.name);
      if (entry.name.endsWith(".json.bak")) {
        const target = candidate.slice(0, -4);
        try {
          await fs.access(target);
          await fs.rm(candidate, { force: true });
        } catch {
          await fs.rename(candidate, target).catch(() => undefined);
        }
      } else if (/\.json\.\d+\.[A-Za-z0-9-]+\.tmp$/u.test(entry.name)) {
        await fs.rm(candidate, { force: true });
      }
    }
  }

  private async removeStatePublication(processSessionId: string): Promise<void> {
    const target = this.statePath(processSessionId);
    await Promise.allSettled([
      fs.rm(target, { force: true }),
      fs.rm(`${target}.bak`, { force: true }),
    ]);
    const prefix = `${path.basename(target)}.`;
    const entries = await fs.readdir(this.stateDirectory, { withFileTypes: true }).catch(() => []);
    await Promise.allSettled(entries
      .filter((entry) => entry.isFile() && entry.name.startsWith(prefix) && entry.name.endsWith(".tmp"))
      .map((entry) => fs.rm(path.join(this.stateDirectory, entry.name), { force: true })));
  }

  private statePath(processSessionId: string): string {
    if (!/^[A-Za-z0-9._-]+$/u.test(processSessionId)) throw new Error("Invalid process session identity.");
    return path.join(this.stateDirectory, `${processSessionId}.json`);
  }
}
