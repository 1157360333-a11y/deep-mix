import { spawn } from "node:child_process";
import process from "node:process";
import type {
  BuiltInRuntimeCapabilityName,
  CapabilityProbeDefinition,
  RuntimeCapabilityName,
  RuntimeCapabilityProbe,
  RuntimeCapabilitySnapshot,
  ToolErrorType,
} from "../../shared-schema/src/index.js";

export interface ProcessRunResult {
  file: string;
  args: string[];
  cwd: string;
  stdout: string;
  stderr: string;
  exitCode: number;
  timedOut: boolean;
  outputTruncated?: boolean;
  spawnError?: {
    code?: string;
    message: string;
  };
}

export interface ProcessRunOptions {
  file: string;
  args: string[];
  cwd: string;
  timeoutMs: number;
  maxOutputChars?: number;
  input?: string;
  env?: NodeJS.ProcessEnv;
  signal?: AbortSignal;
  /** Kill and confirm residual descendants before returning to the tool runtime. */
  enforceTreeCleanup?: boolean;
}

const WINDOWS = process.platform === "win32";

const CORE_CAPABILITY_PROBES: CapabilityProbeDefinition[] = [
  {
    name: "rg",
    candidates: WINDOWS ? ["rg.exe", "rg"] : ["rg"],
    args: ["--version"],
    timeoutMs: 10000,
  },
  {
    name: "git",
    candidates: WINDOWS ? ["git.exe", "git"] : ["git"],
    args: ["--version"],
    timeoutMs: 10000,
  },
  {
    name: "powershell",
    candidates: WINDOWS ? ["powershell.exe", "powershell"] : ["pwsh", "powershell"],
    args: ["-NoProfile", "-Command", "$PSVersionTable.PSVersion.ToString()"],
    timeoutMs: 10000,
  },
  {
    name: "node",
    candidates: WINDOWS ? [process.execPath, "node.exe", "node"] : [process.execPath, "node"],
    args: ["--version"],
    timeoutMs: 10000,
  },
  {
    name: "npm",
    candidates: WINDOWS ? ["npm.cmd", "npm.exe", "npm"] : ["npm"],
    args: ["--version"],
    timeoutMs: 10000,
  },
];

export class RuntimeCapabilityRegistry {
  private readonly definitions = new Map<RuntimeCapabilityName, CapabilityProbeDefinition>();

  public constructor(includeCore = true) {
    if (includeCore) {
      for (const definition of CORE_CAPABILITY_PROBES) this.registerProbe(definition);
    }
  }

  public registerProbe(definition: CapabilityProbeDefinition): void {
    if (!/^[a-z][a-z0-9._-]*$/.test(definition.name) || definition.candidates.length === 0) {
      throw new Error(`Invalid runtime capability probe: ${definition.name || "<empty>"}.`);
    }
    if (!Number.isFinite(definition.timeoutMs) || definition.timeoutMs < 100 || definition.timeoutMs > 300000) {
      throw new Error(`Invalid timeout for runtime capability probe ${definition.name}.`);
    }
    if (this.definitions.has(definition.name)) {
      throw new Error(`Duplicate runtime capability probe: ${definition.name}.`);
    }
    this.definitions.set(definition.name, {
      ...definition,
      candidates: [...definition.candidates],
      args: [...definition.args],
      platforms: definition.platforms ? [...definition.platforms] : undefined,
    });
  }

  public listDefinitions(): CapabilityProbeDefinition[] {
    return [...this.definitions.values()].map((definition) => ({
      ...definition,
      candidates: [...definition.candidates],
      args: [...definition.args],
      platforms: definition.platforms ? [...definition.platforms] : undefined,
    }));
  }
}

function now(): string {
  return new Date().toISOString();
}

function summarizeProbeVersion(result: ProcessRunResult): string | undefined {
  const firstLine = `${result.stdout}\n${result.stderr}`
    .split(/\r?\n/)
    .map((line) => line.trim())
    .find(Boolean);
  return firstLine;
}

function normalizeEnvironment(env: NodeJS.ProcessEnv | undefined): NodeJS.ProcessEnv {
  const source = env ?? process.env;
  if (process.platform !== "win32") {
    return source;
  }

  const normalized: NodeJS.ProcessEnv = {};
  let pathValue: string | undefined;
  for (const [key, value] of Object.entries(source)) {
    if (key.toLowerCase() === "path") {
      pathValue = value;
      continue;
    }
    normalized[key] = value;
  }
  if (pathValue !== undefined) {
    normalized.Path = pathValue;
  }
  return normalized;
}

function quoteWindowsCmdArgument(value: string): string {
  if (/[\0\r\n"%!]/u.test(value)) {
    throw Object.assign(
      new Error("Windows .cmd/.bat arguments cannot contain NUL, newlines, quotes, percent, or exclamation marks."),
      { code: "EINVAL" },
    );
  }
  return `"${value}"`;
}

function runWindowsTaskkill(pid: number, force: boolean): Promise<boolean> {
  return new Promise((resolve) => {
    let settled = false;
    const finish = (value: boolean): void => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve(value);
    };
    const killer = spawn("taskkill.exe", ["/pid", String(pid), "/t", ...(force ? ["/f"] : [])], {
      stdio: "ignore",
      windowsHide: true,
    });
    const timer = setTimeout(() => {
      killer.kill();
      finish(false);
    }, 5_000);
    killer.on("error", () => finish(false));
    killer.on("close", (code) => finish(code === 0));
  });
}

function delay(delayMs: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, delayMs));
}

function isPosixProcessGroupAlive(pid: number): boolean {
  try {
    process.kill(-pid, 0);
    return true;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === "EPERM";
  }
}

async function waitForPosixProcessGroupExit(pid: number): Promise<boolean> {
  for (let attempt = 0; attempt < 20; attempt += 1) {
    if (!isPosixProcessGroupAlive(pid)) return true;
    await delay(50);
  }
  return !isPosixProcessGroupAlive(pid);
}

function listWindowsDescendantPids(
  rootPid: number,
  cwd: string,
  env: NodeJS.ProcessEnv,
): Promise<number[] | undefined> {
  return new Promise((resolve) => {
    const script = [
      `$root=${rootPid}`,
      "$items=@()",
      "try{$items=@(Get-CimInstance Win32_Process | Select-Object ProcessId,ParentProcessId)}catch{$items=@(Get-WmiObject Win32_Process | Select-Object ProcessId,ParentProcessId)}",
      "$seen=New-Object 'System.Collections.Generic.HashSet[int]'",
      "$frontier=@([int]$root)",
      "while($frontier.Count -gt 0){$next=@();foreach($item in $items){if($frontier -contains [int]$item.ParentProcessId){if($seen.Add([int]$item.ProcessId)){$next+=([int]$item.ProcessId)}}};$frontier=$next}",
      "[Console]::Out.Write((@($seen) -join ','))",
    ].join(";");
    let stdout = "";
    let settled = false;
    let timer: NodeJS.Timeout | undefined;
    const finish = (value: number[] | undefined): void => {
      if (settled) return;
      settled = true;
      if (timer) clearTimeout(timer);
      resolve(value);
    };
    let probe: ReturnType<typeof spawn>;
    try {
      probe = spawn("powershell.exe", ["-NoProfile", "-NonInteractive", "-Command", script], {
        cwd,
        env,
        stdio: ["ignore", "pipe", "ignore"],
        windowsHide: true,
      });
    } catch {
      finish(undefined);
      return;
    }
    timer = setTimeout(() => {
      probe.kill();
      finish(undefined);
    }, 5_000);
    probe.stdout?.setEncoding("utf8");
    probe.stdout?.on("data", (chunk) => {
      if (stdout.length <= 32_768) stdout += String(chunk);
    });
    probe.on("error", () => finish(undefined));
    probe.on("close", (code) => {
      if (code !== 0 || stdout.length > 32_768) return finish(undefined);
      if (!stdout.trim()) return finish([]);
      const pids = stdout.trim().split(",").map((value) => Number(value.trim()));
      finish(pids.every((pid) => Number.isInteger(pid) && pid > 0) ? [...new Set(pids)] : undefined);
    });
  });
}

async function cleanupResidualProcessTree(
  pid: number | undefined,
  cwd: string,
  env: NodeJS.ProcessEnv,
): Promise<boolean> {
  if (!pid) return true;
  if (WINDOWS) {
    const descendants = await listWindowsDescendantPids(pid, cwd, env);
    if (descendants === undefined) return false;
    for (const descendantPid of descendants.reverse()) {
      await runWindowsTaskkill(descendantPid, true);
    }
    if (descendants.length === 0) return true;
    await delay(100);
    const remaining = await listWindowsDescendantPids(pid, cwd, env);
    return remaining !== undefined && remaining.length === 0;
  }
  if (!isPosixProcessGroupAlive(pid)) return true;
  try {
    process.kill(-pid, "SIGKILL");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ESRCH") return true;
  }
  return waitForPosixProcessGroupExit(pid);
}

async function terminateProcessTree(pid: number | undefined): Promise<boolean> {
  if (!pid) return true;
  if (WINDOWS) {
    const killed = await runWindowsTaskkill(pid, true);
    if (killed) return true;
  } else {
    try {
      process.kill(-pid, "SIGKILL");
      return await waitForPosixProcessGroupExit(pid);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ESRCH") return true;
    }
  }
  try {
    process.kill(pid, "SIGKILL");
    return false;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === "ESRCH";
  }
}

export async function runProcess(options: ProcessRunOptions): Promise<ProcessRunResult> {
  if (options.signal?.aborted) {
    return {
      file: options.file,
      args: options.args,
      cwd: options.cwd,
      stdout: "",
      stderr: "",
      exitCode: -1,
      timedOut: false,
      spawnError: {
        code: "ABORT_ERR",
        message: options.signal.reason instanceof Error
          ? options.signal.reason.message
          : "Process launch was cancelled.",
      },
    };
  }
  return new Promise((resolve) => {
    const env = normalizeEnvironment(options.env);
    const needsCmdShim = process.platform === "win32" && /\.(cmd|bat)$/i.test(options.file);
    let launchFile = options.file;
    let launchArgs = options.args;
    let windowsVerbatimArguments = false;
    try {
      if (needsCmdShim) {
        launchFile = env.ComSpec ?? process.env.ComSpec ?? "cmd.exe";
        const commandLine = `"${[options.file, ...options.args].map(quoteWindowsCmdArgument).join(" ")}"`;
        launchArgs = ["/d", "/s", "/c", commandLine];
        windowsVerbatimArguments = true;
      }
    } catch (error) {
      resolve({
        file: options.file,
        args: options.args,
        cwd: options.cwd,
        stdout: "",
        stderr: "",
        exitCode: -1,
        timedOut: false,
        spawnError: {
          code: (error as NodeJS.ErrnoException).code ?? "EINVAL",
          message: (error as Error).message,
        },
      });
      return;
    }
    let child: ReturnType<typeof spawn>;
    try {
      child = spawn(launchFile, launchArgs, {
        cwd: options.cwd,
        env,
        stdio: [options.input === undefined ? "ignore" : "pipe", "pipe", "pipe"],
        detached: !WINDOWS,
        windowsHide: true,
        windowsVerbatimArguments,
      });
    } catch (error) {
      resolve({
        file: options.file,
        args: options.args,
        cwd: options.cwd,
        stdout: "",
        stderr: "",
        exitCode: -1,
        timedOut: false,
        spawnError: {
          code: (error as NodeJS.ErrnoException).code,
          message: (error as Error).message,
        },
      });
      return;
    }

    let stdout = "";
    let stderr = "";
    let timedOut = false;
    let outputTruncated = false;
    let capturedOutputChars = 0;
    let settled = false;
    let aborted = false;
    let stopPromise: Promise<boolean> | undefined;

    const finalize = (result: ProcessRunResult): void => {
      if (settled) {
        return;
      }
      settled = true;
      clearTimeout(timer);
      options.signal?.removeEventListener("abort", handleAbort);
      resolve(result);
    };

    const requestTreeStop = (): void => {
      stopPromise ??= terminateProcessTree(child.pid);
    };

    const handleAbort = (): void => {
      aborted = true;
      requestTreeStop();
    };

    const timer = setTimeout(() => {
      timedOut = true;
      requestTreeStop();
    }, options.timeoutMs);
    options.signal?.addEventListener("abort", handleAbort, { once: true });
    if (options.signal?.aborted) handleAbort();

    child.stdout?.setEncoding("utf8");
    child.stderr?.setEncoding("utf8");
    if (options.input !== undefined) {
      child.stdin?.on("error", () => {
        // The command may reject input and exit before the bounded payload is
        // fully written; its exit code/stderr remain the authoritative result.
      });
      child.stdin?.end(options.input, "utf8");
    }
    child.stdout?.on("data", (chunk) => {
      const text = String(chunk);
      const remaining = Math.max(0, (options.maxOutputChars ?? Number.POSITIVE_INFINITY) - capturedOutputChars);
      stdout += text.slice(0, remaining);
      capturedOutputChars += Math.min(text.length, remaining);
      if (text.length > remaining) outputTruncated = true;
    });
    child.stderr?.on("data", (chunk) => {
      const text = String(chunk);
      const remaining = Math.max(0, (options.maxOutputChars ?? Number.POSITIVE_INFINITY) - capturedOutputChars);
      stderr += text.slice(0, remaining);
      capturedOutputChars += Math.min(text.length, remaining);
      if (text.length > remaining) outputTruncated = true;
    });
    child.on("error", (error) => {
      finalize({
        file: options.file,
        args: options.args,
        cwd: options.cwd,
        stdout,
        stderr,
        exitCode: -1,
        timedOut,
        outputTruncated,
        spawnError: {
          code: (error as NodeJS.ErrnoException).code,
          message: error.message,
        },
      });
    });
    child.on("close", (code) => {
      void (async () => {
        const requestedCleanupConfirmed = stopPromise ? await stopPromise : true;
        const ranResidualCleanup = Boolean(options.enforceTreeCleanup) || !requestedCleanupConfirmed;
        const residualCleanupConfirmed = ranResidualCleanup
          ? await cleanupResidualProcessTree(child.pid, options.cwd, env)
          : true;
        const cleanupConfirmed = ranResidualCleanup ? residualCleanupConfirmed : requestedCleanupConfirmed;
        finalize({
          file: options.file,
          args: options.args,
          cwd: options.cwd,
          stdout,
          stderr,
          exitCode: code ?? -1,
          timedOut,
          outputTruncated,
          spawnError: aborted
            ? {
                code: "ABORT_ERR",
                message: options.signal?.reason instanceof Error
                  ? options.signal.reason.message
                  : "Process execution was cancelled.",
              }
            : cleanupConfirmed
              ? undefined
              : {
                  code: "ERR_PROCESS_CLEANUP_UNCONFIRMED",
                  message: "The process root exited, but descendant cleanup could not be confirmed.",
                },
        });
      })();
    });
  });
}

function classifyProbeFailure(result: ProcessRunResult): ToolErrorType {
  if (result.timedOut) {
    return "timeout";
  }
  if (result.spawnError?.code === "ENOENT") {
    return "missing_dependency";
  }
  return "command_failed";
}

async function probeCapability(
  definition: CapabilityProbeDefinition,
  env?: NodeJS.ProcessEnv,
): Promise<RuntimeCapabilityProbe> {
  const name = definition.name;
  if (definition.platforms && !definition.platforms.includes(process.platform)) {
    return {
      name,
      available: false,
      command: definition.candidates[0] ?? name,
      errorType: "unsupported_environment",
      message: `unsupported_platform:${process.platform}`,
    };
  }
  let lastFailure: ProcessRunResult | undefined;

  for (const command of definition.candidates) {
    const result = await runProcess({
      file: command,
      args: definition.args,
      cwd: process.cwd(),
      timeoutMs: definition.timeoutMs,
      env,
    });
    if (!result.spawnError && result.exitCode === 0) {
      return {
        name,
        available: true,
        command,
        version: summarizeProbeVersion(result),
        message: "available",
      };
    }
    lastFailure = result;
    if (result.spawnError?.code !== "ENOENT") {
      break;
    }
  }

  const errorType = lastFailure ? classifyProbeFailure(lastFailure) : "missing_dependency";
  const message =
    errorType === "missing_dependency"
      ? "missing"
      : errorType === "timeout"
        ? "probe_timeout"
        : lastFailure?.spawnError?.message || lastFailure?.stderr.trim() || "probe_failed";

  return {
    name,
    available: false,
    command: definition.candidates[0] ?? name,
    errorType,
    message,
  };
}

export async function detectRuntimeCapabilities(
  env?: NodeJS.ProcessEnv,
  registry = new RuntimeCapabilityRegistry(),
): Promise<RuntimeCapabilitySnapshot> {
  const probes = await Promise.all(
    registry
      .listDefinitions()
      .map(async (definition) => [definition.name, await probeCapability(definition, env)] as const),
  );

  const capabilities = Object.fromEntries(probes) as Record<RuntimeCapabilityName, RuntimeCapabilityProbe> &
    Record<BuiltInRuntimeCapabilityName, RuntimeCapabilityProbe>;
  return {
    checkedAt: now(),
    capabilities,
    fallbacks: {
      listFiles: capabilities.rg.available ? "rg" : "node_fs",
      searchFiles: capabilities.rg.available ? "rg" : "node_text",
    },
  };
}
