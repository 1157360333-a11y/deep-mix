import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import { GovernorRuntime } from "../packages/core-governor/src/index.js";
import { SessionStore } from "../packages/persistence/src/index.js";
import {
  buildApprovalRequestKey,
  PermissionLayer,
} from "../packages/safety/src/index.js";
import {
  TOOL_PROCESS_LIMITS,
  type ToolProcessOutputChunk,
  type ToolProcessSession,
  type ToolProcessStopResult,
  type ToolResult,
} from "../packages/shared-schema/src/index.js";
import {
  PermissionRequiredError,
  redactProcessText,
  resolveManagedSpawnCommand,
  ToolProcessManager,
  ToolRuntime,
} from "../packages/tool-runtime/src/index.js";
import { detachedShellPattern } from "../packages/tool-runtime/src/built-ins/commands/index.js";
import { runProcess } from "../packages/tool-runtime/src/runtime-capabilities.js";

const temporaryRoots: string[] = [];
const disposables: Array<{ dispose(): Promise<void> }> = [];
const fallbackProcessPids = new Set<number>();

interface StartProcessBody {
  kind: "start_process";
  processSessionId: string;
  status: ToolProcessSession["status"];
  ready: boolean;
  startupTimedOut: boolean;
  nextCursor: number;
  exit?: ToolProcessSession["exit"];
  error?: { type: string; message: string };
}

interface ProcessOutputBody extends ToolProcessOutputChunk {
  kind: "process_output";
}

interface ProcessInputBody {
  kind: "process_input";
  processSessionId: string;
  status: ToolProcessSession["status"];
  acceptedChars: number;
  appendedNewline: boolean;
  error?: { type: string; message: string };
}

interface StopProcessBody extends ToolProcessStopResult {
  kind: "stop_process";
}

function structured<T>(result: ToolResult): T {
  return result.structuredContent as T;
}

async function createWorkspace(prefix: string): Promise<{
  workspaceRoot: string;
  sessionStore: SessionStore;
  sessionId: string;
}> {
  const workspaceRoot = await fs.mkdtemp(path.join(os.tmpdir(), prefix));
  temporaryRoots.push(workspaceRoot);
  const sessionStore = new SessionStore(workspaceRoot);
  await sessionStore.ensureInitialized();
  const session = await sessionStore.createSession("phase 17 integration");
  return { workspaceRoot, sessionStore, sessionId: session.sessionId };
}

async function writeGovernorFixtureConfig(workspaceRoot: string): Promise<void> {
  const profileDirectory = path.join(workspaceRoot, ".deep-mix", "api-key-library");
  await fs.mkdir(profileDirectory, { recursive: true });
  await fs.writeFile(
    path.join(profileDirectory, "profiles.local.json"),
    JSON.stringify({
      version: 1,
      profiles: {
        deepseek_governor: {
          provider: "deepseek",
          role: "governor",
          baseUrl: "https://example.invalid",
          chatPath: "/chat/completions",
          model: "phase17-fixture",
          headers: { "Content-Type": "application/json" },
          requestDefaults: {},
        },
      },
    }),
    "utf8",
  );
  await fs.writeFile(
    path.join(workspaceRoot, ".deep-mix", "settings.json"),
    JSON.stringify({ version: 1, experimental: { managedProcesses: true } }),
    "utf8",
  );
}

function createRuntime(input: {
  workspaceRoot: string;
  sessionStore: SessionStore;
  permissionMode?: "plan" | "auto" | "danger-full-access";
}): ToolRuntime {
  const runtime = new ToolRuntime({
    workspaceRoot: input.workspaceRoot,
    sessionStore: input.sessionStore,
    permissionMode: input.permissionMode ?? "danger-full-access",
    environment: { ...process.env, BRAVE_SEARCH_API_KEY: undefined },
    settings: { version: 1, experimental: { managedProcesses: true } },
  });
  disposables.push(runtime);
  return runtime;
}

function track<T extends { dispose(): Promise<void> }>(value: T): T {
  disposables.push(value);
  return value;
}

async function waitFor<T>(
  read: () => T | Promise<T>,
  predicate: (value: T) => boolean,
  timeoutMs = 10_000,
): Promise<T> {
  const deadline = Date.now() + timeoutMs;
  let latest = await read();
  while (!predicate(latest)) {
    if (Date.now() >= deadline) {
      throw new Error(`Timed out waiting for phase 17 fixture state. Latest: ${JSON.stringify(latest)}`);
    }
    await new Promise((resolve) => setTimeout(resolve, 25));
    latest = await read();
  }
  return latest;
}

function isPidAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code !== "ESRCH";
  }
}

async function killFallbackProcess(pid: number): Promise<void> {
  if (!isPidAlive(pid)) return;
  try {
    process.kill(pid, "SIGKILL");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ESRCH") throw error;
  }
}

async function readUntil(
  runtime: ToolRuntime,
  sessionId: string,
  processSessionId: string,
  cursor: number,
  pattern: RegExp,
): Promise<{ body: ProcessOutputBody; text: string }> {
  let nextCursor = cursor;
  let text = "";
  const deadline = Date.now() + 10_000;
  for (;;) {
    const result = await runtime.executeManualTool(
      "process_output",
      { processSessionId, cursor: nextCursor, maxChars: 16_384, waitMs: 500 },
      sessionId,
    );
    expect(result.success).toBe(true);
    const body = structured<ProcessOutputBody>(result);
    text += `${body.stdout}${body.stderr}`;
    nextCursor = body.nextCursor;
    if (pattern.test(text)) return { body, text };
    if (["exited", "failed", "stopped", "orphaned"].includes(body.status) && !body.hasMore) {
      throw new Error(`Managed process ended before matching ${String(pattern)}: ${text}`);
    }
    if (Date.now() >= deadline) throw new Error(`Timed out reading managed process output: ${text}`);
  }
}

async function startPendingTurn(sessionStore: SessionStore, sessionId: string): Promise<string> {
  const turn = await sessionStore.startTurn({
    sessionId,
    requestSummary: "phase 17 tool discovery",
    userMessageId: "phase17-tool-search-user",
  });
  await sessionStore.recordToolSelection({
    recordType: "tool_selection",
    selectionId: `phase17-selection-${turn.turnId}`,
    sessionId,
    turnId: turn.turnId,
    createdAt: new Date().toISOString(),
    providerCycle: 1,
    activationLeaseIds: [],
    activatedToolNames: [],
    estimatedToolSchemaTokens: 0,
    selectedCount: 1,
    unselectedCount: 0,
    selectedToolNames: ["tool_search"],
    reasonCounts: { always_available: 1 },
  });
  return turn.turnId;
}

afterEach(async () => {
  await Promise.allSettled(disposables.splice(0).reverse().map((value) => value.dispose()));
  await Promise.allSettled([...fallbackProcessPids].map((pid) => killFallbackProcess(pid)));
  fallbackProcessPids.clear();
  await Promise.all(temporaryRoots.splice(0).map((root) => fs.rm(root, {
    recursive: true,
    force: true,
    maxRetries: process.platform === "win32" ? 10 : 0,
    retryDelay: 100,
  })));
});

describe("phase 17 managed processes and structured quality tools", () => {
  it("keeps managed background processes unavailable unless explicitly enabled", async () => {
    const fixture = await createWorkspace("deep-mix-phase17-default-off-");
    const runtime = new ToolRuntime({
      workspaceRoot: fixture.workspaceRoot,
      sessionStore: fixture.sessionStore,
      permissionMode: "danger-full-access",
      environment: { ...process.env, BRAVE_SEARCH_API_KEY: undefined },
      settings: { version: 1 },
    });
    disposables.push(runtime);

    await runtime.initialize();
    expect(runtime.listRegisteredToolDefinitions().map((tool) => tool.name)).toContain("start_process");
    expect(runtime.listAvailableToolDefinitions().map((tool) => tool.name)).not.toContain("start_process");

    const result = await runtime.executeManualTool(
      "start_process",
      { command: process.execPath, args: ["-e", "process.exit(0)"] },
      fixture.sessionId,
    );
    expect(result.success).toBe(false);
    expect(structured<StartProcessBody>(result).error?.type).toBe("missing_dependency");
    expect(structured<StartProcessBody>(result).error?.message).toContain(
      "experimental.managedProcesses=true",
    );
  });

  it("completes ready, stdin, cursor output, natural exit, active stop, and ownership checks", async () => {
    const fixture = await createWorkspace("deep-mix-phase17-lifecycle-");
    const otherSession = await fixture.sessionStore.createSession("phase 17 other owner");
    const runtime = createRuntime(fixture);
    const interactiveSource = [
      "process.stdin.setEncoding('utf8')",
      "let pending = ''",
      "process.stdout.write('READY\\n')",
      "process.stdin.on('data', chunk => {",
      "  pending += chunk",
      "  for (;;) {",
      "    const newline = pending.indexOf('\\n')",
      "    if (newline < 0) break",
      "    const line = pending.slice(0, newline).replace(/\\r$/u, '')",
      "    pending = pending.slice(newline + 1)",
      "    process.stdout.write('ECHO:' + line + '\\n')",
      "    if (line === 'exit') process.exit(0)",
      "  }",
      "})",
      "setInterval(() => undefined, 1000)",
    ].join(";");
    const started = await runtime.executeManualTool(
      "start_process",
      {
        command: process.execPath,
        args: ["-e", interactiveSource],
        interactionMode: "pipe",
        readyPattern: "READY",
        startupTimeoutMs: 5_000,
      },
      fixture.sessionId,
    );
    const startBody = structured<StartProcessBody>(started);
    expect(started.success).toBe(true);
    expect(startBody).toMatchObject({ status: "running", ready: true, startupTimedOut: false });

    const ready = await readUntil(runtime, fixture.sessionId, startBody.processSessionId, 0, /READY/u);
    const wrongOwner = await runtime.executeManualTool(
      "process_input",
      { processSessionId: startBody.processSessionId, text: "forbidden", appendNewline: true },
      otherSession.sessionId,
    );
    expect(wrongOwner.success).toBe(false);
    expect(structured<ProcessInputBody>(wrongOwner).error?.message).toMatch(/not owned/iu);

    const input = await runtime.executeManualTool(
      "process_input",
      { processSessionId: startBody.processSessionId, text: "hello", appendNewline: true },
      fixture.sessionId,
    );
    expect(input.success).toBe(true);
    expect(structured<ProcessInputBody>(input)).toMatchObject({ acceptedChars: 6, appendedNewline: true });
    const echoed = await readUntil(
      runtime,
      fixture.sessionId,
      startBody.processSessionId,
      ready.body.nextCursor,
      /ECHO:hello/u,
    );
    expect(echoed.body.startCursor).toBe(ready.body.nextCursor);

    await runtime.executeManualTool(
      "process_input",
      { processSessionId: startBody.processSessionId, text: "exit", appendNewline: true },
      fixture.sessionId,
    );
    const exited = await readUntil(
      runtime,
      fixture.sessionId,
      startBody.processSessionId,
      echoed.body.nextCursor,
      /ECHO:exit/u,
    );
    await waitFor(
      () => runtime.listManagedProcesses(fixture.sessionId).find(
        (entry) => entry.processSessionId === startBody.processSessionId,
      ),
      (entry) => entry?.status === "exited",
    );
    expect(exited.body.nextCursor).toBeGreaterThan(echoed.body.nextCursor);
    const afterExit = await runtime.executeManualTool(
      "stop_process",
      { processSessionId: startBody.processSessionId, strategy: "graceful_then_force", gracefulTimeoutMs: 100 },
      fixture.sessionId,
    );
    expect(structured<StopProcessBody>(afterExit).outcome).toBe("already_exited");

    const longRunning = await runtime.executeManualTool(
      "start_process",
      {
        command: process.execPath,
        args: ["-e", "setInterval(() => undefined, 1000)"],
        interactionMode: "none",
        startupTimeoutMs: 5_000,
      },
      fixture.sessionId,
    );
    const longBody = structured<StartProcessBody>(longRunning);
    const stopped = await runtime.executeManualTool(
      "stop_process",
      { processSessionId: longBody.processSessionId, strategy: "graceful_then_force", gracefulTimeoutMs: 2_000 },
      fixture.sessionId,
    );
    expect(stopped.success).toBe(true);
    expect(["terminated", "force_terminated"]).toContain(structured<StopProcessBody>(stopped).outcome);
    const stoppedAgain = await runtime.executeManualTool(
      "stop_process",
      { processSessionId: longBody.processSessionId, strategy: "force", gracefulTimeoutMs: 0 },
      fixture.sessionId,
    );
    expect(structured<StopProcessBody>(stoppedAgain).outcome).toBe("already_exited");
  }, 30_000);

  it("returns structured startup timeout and spawn-failure states without leaving live processes", async () => {
    const fixture = await createWorkspace("deep-mix-phase17-start-failures-");
    const runtime = createRuntime(fixture);
    const timedOut = await runtime.executeManualTool(
      "start_process",
      {
        command: process.execPath,
        args: ["-e", "setInterval(() => undefined, 1000)"],
        readyPattern: "NEVER_READY",
        startupTimeoutMs: 100,
      },
      fixture.sessionId,
    );
    const timeoutBody = structured<StartProcessBody>(timedOut);
    expect(timedOut.success).toBe(false);
    expect(timeoutBody).toMatchObject({ startupTimedOut: true, ready: false });
    expect(timeoutBody.error?.type).toBe("timeout");
    expect(["stopped", "orphaned"]).toContain(timeoutBody.status);

    const exitedBeforeReady = await runtime.executeManualTool(
      "start_process",
      {
        command: process.execPath,
        args: ["-e", "process.stdout.write('NOT_THE_MARKER\\n'); process.exit(0)"],
        readyPattern: "EXPECTED_READY_MARKER",
        startupTimeoutMs: 5_000,
      },
      fixture.sessionId,
    );
    const exitedBeforeReadyBody = structured<StartProcessBody>(exitedBeforeReady);
    expect(exitedBeforeReady.success).toBe(false);
    expect(exitedBeforeReadyBody.ready).toBe(false);
    expect(exitedBeforeReadyBody.startupTimedOut).toBe(false);
    expect(["exited", "failed", "orphaned"]).toContain(exitedBeforeReadyBody.status);
    expect(exitedBeforeReadyBody.error).toMatchObject({ type: "command_failed" });
    expect(exitedBeforeReadyBody.error?.message).toMatch(/before ready pattern/iu);

    const missing = await runtime.executeManualTool(
      "start_process",
      {
        command: `deep-mix-phase17-missing-${Date.now()}${process.platform === "win32" ? ".exe" : ""}`,
        startupTimeoutMs: 1_000,
      },
      fixture.sessionId,
    );
    const missingBody = structured<StartProcessBody>(missing);
    expect(missing.success).toBe(false);
    expect(missingBody.status).toBe("failed");
    expect(["missing_dependency", "command_failed"]).toContain(missingBody.error?.type);
    expect(runtime.listManagedProcesses(fixture.sessionId).every(
      (entry) => !["starting", "running", "stopping"].includes(entry.status),
    )).toBe(true);
  }, 20_000);

  it("returns managed-process output beyond the old 8K/64K limits by default", async () => {
    const fixture = await createWorkspace("deep-mix-phase17-full-process-output-");
    const runtime = createRuntime(fixture);
    const source = "process.stdout.write('P'.repeat(100000) + 'PROCESS_OUTPUT_TAIL_SENTINEL')";
    const started = await runtime.executeManualTool(
      "start_process",
      { command: process.execPath, args: ["-e", source], startupTimeoutMs: 5_000 },
      fixture.sessionId,
    );
    const processSessionId = structured<StartProcessBody>(started).processSessionId;
    await waitFor(
      () => runtime.listManagedProcesses(fixture.sessionId).find((entry) => entry.processSessionId === processSessionId),
      (entry) => entry?.status === "exited",
    );

    const output = await runtime.executeManualTool(
      "process_output",
      { processSessionId, cursor: 0 },
      fixture.sessionId,
    );
    const body = structured<ProcessOutputBody>(output);
    expect(body.stdout).toContain("PROCESS_OUTPUT_TAIL_SENTINEL");
    expect(body.cursorExpired).toBe(false);
    expect(body.hasMore).toBe(false);
    expect(body.outputTruncated).toBe(false);
    expect(output.output).toContain("PROCESS_OUTPUT_TAIL_SENTINEL");
    expect("contextSummary" in output).toBe(false);

    const definition = runtime.listToolDefinitions().find((entry) => entry.name === "process_output");
    const properties = (definition?.inputSchema.properties ?? {}) as Record<string, Record<string, unknown>>;
    expect(properties.maxChars).toMatchObject({
      default: TOOL_PROCESS_LIMITS.defaultOutputChunkChars,
      maximum: TOOL_PROCESS_LIMITS.maxOutputChunkChars,
    });
  }, 20_000);

  it("bounds long output, reports cursor gaps, persists a redacted artifact, and never repeats the full log", async () => {
    const fixture = await createWorkspace("deep-mix-phase17-output-budget-");
    const runtime = createRuntime(fixture);
    const secret = "phase17-process-secret";
    const source = [
      "const secret = ['phase17', 'process', 'secret'].join('-')",
      `process.stdout.write('X'.repeat(${TOOL_PROCESS_LIMITS.maxBufferCharsPerProcess + 32_768}))`,
      "process.stdout.write('token=' + secret + '\\n')",
    ].join(";");
    const started = await runtime.executeManualTool(
      "start_process",
      { command: process.execPath, args: ["-e", source], startupTimeoutMs: 5_000 },
      fixture.sessionId,
    );
    const processSessionId = structured<StartProcessBody>(started).processSessionId;
    const terminal = await waitFor(
      () => runtime.listManagedProcesses(fixture.sessionId).find(
        (entry) => entry.processSessionId === processSessionId,
      ),
      (entry) => Boolean(entry && entry.totalOutputChars > TOOL_PROCESS_LIMITS.maxBufferCharsPerProcess && entry.status === "exited"),
      process.platform === "win32" ? 20_000 : 10_000,
    );
    expect(terminal?.outputTruncated).toBe(true);
    expect(terminal?.droppedOutputChars).toBeGreaterThan(0);

    const output = await runtime.executeManualTool(
      "process_output",
      { processSessionId, cursor: 0, maxChars: 128, includeArtifact: true },
      fixture.sessionId,
    );
    const body = structured<ProcessOutputBody>(output);
    expect(body).toMatchObject({ cursorExpired: true, outputTruncated: true, hasMore: true });
    expect(body.startCursor).toBeGreaterThan(0);
    expect(body.nextCursor - body.startCursor).toBeLessThanOrEqual(128);
    expect(body.artifactUri).toMatch(/^artifact:\/\/tool-outputs\//u);
    expect(JSON.stringify(output)).not.toContain(secret);
    const artifactText = await fixture.sessionStore.readTextToolOutputArtifact(body.artifactUri!);
    expect(artifactText).toContain("token=[REDACTED]");
    expect(artifactText).not.toContain(secret);
    expect(artifactText.length).toBeLessThanOrEqual(TOOL_PROCESS_LIMITS.maxCumulativeArtifactCharsPerProcess);

    const incremental = await runtime.executeManualTool(
      "process_output",
      { processSessionId, cursor: body.nextCursor, maxChars: 128 },
      fixture.sessionId,
    );
    const incrementalBody = structured<ProcessOutputBody>(incremental);
    expect(incrementalBody.requestedCursor).toBe(body.nextCursor);
    expect(incrementalBody.startCursor).toBe(body.nextCursor);
  }, 30_000);

  it("redacts Basic, JSON, environment-key, and cross-chunk credentials before buffering", async () => {
    const secrets = {
      basic: "dXNlcjpwaGFzZTE3LXN1cGVyLXNlY3JldA==",
      json: "phase17-json-secret",
      openai: "phase17-openai-secret",
      github: "phase17-github-secret",
      aws: "phase17-aws-secret",
      streamed: "phase17-cross-chunk-secret",
    };
    const direct = redactProcessText([
      `Authorization: Basic ${secrets.basic}`,
      `{"token":"${secrets.json}"}`,
      `OPENAI_API_KEY=${secrets.openai}`,
      `GH_TOKEN=${secrets.github}`,
      `AWS_SECRET_ACCESS_KEY=${secrets.aws}`,
    ].join("\n"));
    for (const secret of Object.values(secrets).filter((value) => value !== secrets.streamed)) {
      expect(direct).not.toContain(secret);
    }
    expect(direct.match(/\[REDACTED\]/gu)?.length).toBeGreaterThanOrEqual(5);

    const fixture = await createWorkspace("deep-mix-phase17-stream-redaction-");
    const runtime = createRuntime(fixture);
    const source = [
      "process.stdout.write('OPENAI_API_KEY=phase17-cross-')",
      "setTimeout(() => process.stdout.write('chunk-secret\\n'), 75)",
      `setTimeout(() => process.stdout.write('Authorization: Basic ${secrets.basic}\\n'), 150)`,
      `setTimeout(() => process.stdout.write('{"token":"${secrets.json}"}\\n'), 225)`,
      "setTimeout(() => process.exit(0), 300)",
    ].join(";");
    const started = await runtime.executeManualTool(
      "start_process",
      { command: process.execPath, args: ["-e", source], startupTimeoutMs: 5_000 },
      fixture.sessionId,
    );
    expect(started.success).toBe(true);
    const processSessionId = structured<StartProcessBody>(started).processSessionId;
    await waitFor(
      () => runtime.listManagedProcesses(fixture.sessionId).find(
        (entry) => entry.processSessionId === processSessionId,
      ),
      (entry) => entry?.status === "exited",
    );
    const output = await runtime.executeManualTool(
      "process_output",
      { processSessionId, cursor: 0, maxChars: 16_384, includeArtifact: true },
      fixture.sessionId,
    );
    const serialized = JSON.stringify(output);
    expect(serialized).not.toContain(secrets.streamed);
    expect(serialized).not.toContain(secrets.basic);
    expect(serialized).not.toContain(secrets.json);
    expect(`${structured<ProcessOutputBody>(output).stdout}${structured<ProcessOutputBody>(output).stderr}`)
      .toContain("[REDACTED]");
    const artifactUri = structured<ProcessOutputBody>(output).artifactUri;
    expect(artifactUri).toMatch(/^artifact:\/\/tool-outputs\//u);
    const artifact = await fixture.sessionStore.readTextToolOutputArtifact(artifactUri!);
    expect(artifact).not.toContain(secrets.streamed);
    expect(artifact).not.toContain(secrets.basic);
    expect(artifact).not.toContain(secrets.json);
  }, 20_000);

  it("caps concurrent process-log artifact reservations and reuses current snapshots on repeated reads", async () => {
    const fixture = await createWorkspace("deep-mix-phase17-artifact-reservations-");
    const runtime = createRuntime(fixture);
    const started = await runtime.executeManualTool(
      "start_process",
      {
        command: process.execPath,
        args: ["-e", "process.stdout.write('R'.repeat(20000))"],
        startupTimeoutMs: 5_000,
      },
      fixture.sessionId,
    );
    const processSessionId = structured<StartProcessBody>(started).processSessionId;
    await waitFor(
      () => runtime.listManagedProcesses(fixture.sessionId).find(
        (entry) => entry.processSessionId === processSessionId,
      ),
      (entry) => entry?.status === "exited" && entry.totalOutputChars === 20_000,
    );

    const concurrent = await Promise.all(Array.from({ length: 12 }, () => runtime.executeManualTool(
      "process_output",
      { processSessionId, cursor: 0, maxChars: 128, includeArtifact: true },
      fixture.sessionId,
    )));
    expect(concurrent.every((entry) => entry.success)).toBe(true);
    const initialArtifacts = (await fixture.sessionStore.listToolOutputArtifacts(fixture.sessionId))
      .filter((entry) => entry.sourceToolName === "process_output");
    expect(initialArtifacts.length).toBeGreaterThan(0);
    expect(
      initialArtifacts.length,
      JSON.stringify(initialArtifacts.map((entry) => ({
        uri: entry.uri,
        toolCallId: entry.toolCallId,
        fileName: entry.fileName,
      }))),
    ).toBeLessThanOrEqual(TOOL_PROCESS_LIMITS.maxArtifactSnapshotsPerProcess);
    const visibleUris = new Set(concurrent
      .map((entry) => structured<ProcessOutputBody>(entry).artifactUri)
      .filter((entry): entry is string => Boolean(entry)));
    expect(visibleUris.size).toBeLessThanOrEqual(TOOL_PROCESS_LIMITS.maxArtifactSnapshotsPerProcess);

    const repeated = await Promise.all(Array.from({ length: 8 }, () => runtime.executeManualTool(
      "process_output",
      { processSessionId, cursor: 128, maxChars: 128, includeArtifact: true },
      fixture.sessionId,
    )));
    expect(repeated.every((entry) => entry.success)).toBe(true);
    const afterRepeated = (await fixture.sessionStore.listToolOutputArtifacts(fixture.sessionId))
      .filter((entry) => entry.sourceToolName === "process_output");
    expect(afterRepeated).toHaveLength(initialArtifacts.length);
    expect(new Set(afterRepeated.map((entry) => entry.uri))).toEqual(
      new Set(initialArtifacts.map((entry) => entry.uri)),
    );
  }, 25_000);

  it("cleans session-owned work on governor interruption", async () => {
    const fixture = await createWorkspace("deep-mix-phase17-session-interrupt-");
    await writeGovernorFixtureConfig(fixture.workspaceRoot);
    const governor = track(new GovernorRuntime({
      workspaceRoot: fixture.workspaceRoot,
      permissionMode: "danger-full-access",
      environment: { ...process.env, BRAVE_SEARCH_API_KEY: undefined },
      modelClient: {
        streamCompletion: async () => { throw new Error("Model should not run in this fixture."); },
      },
    }));
    await governor.initialize();
    const runtime = Reflect.get(governor, "toolRuntime") as ToolRuntime;
    const started = await runtime.executeManualTool(
      "start_process",
      { command: process.execPath, args: ["-e", "setInterval(() => undefined, 1000)"] },
      fixture.sessionId,
    );
    const processSessionId = structured<StartProcessBody>(started).processSessionId;
    await governor.interruptSession(fixture.sessionId, "phase 17 interruption fixture");
    const state = (await governor.listManagedProcesses(fixture.sessionId)).find(
      (entry) => entry.processSessionId === processSessionId,
    );
    expect(state).toMatchObject({ status: "stopped", exit: { reason: "session_interrupted" } });
  }, 20_000);

  it("rejects terminal owners, fences in-flight starts, and restores process capability after resume", async () => {
    const fixture = await createWorkspace("deep-mix-phase17-owner-fence-");
    const runtime = createRuntime(fixture);
    for (const terminalStatus of ["completed", "interrupted"] as const) {
      const owner = await fixture.sessionStore.createSession(`phase 17 ${terminalStatus} owner`);
      await fixture.sessionStore.setSessionStatus(owner.sessionId, terminalStatus);
      const rejected = await runtime.executeManualTool(
        "start_process",
        { command: process.execPath, args: ["-e", "setInterval(() => undefined, 1000)"] },
        owner.sessionId,
      );
      expect(rejected.success, terminalStatus).toBe(false);
      expect(structured<StartProcessBody>(rejected).error).toMatchObject({ type: "invalid_arguments" });
      expect(structured<StartProcessBody>(rejected).error?.message).toMatch(/owner session|closed|terminal/iu);
      expect(runtime.listManagedProcesses(owner.sessionId)).toEqual([]);
    }

    const resumedOwner = await fixture.sessionStore.createSession("phase 17 resumed owner");
    await fixture.sessionStore.setSessionStatus(resumedOwner.sessionId, "interrupted");
    await runtime.stopSessionProcesses(resumedOwner.sessionId, "session_interrupted");
    const interrupted = await runtime.executeManualTool(
      "start_process",
      { command: process.execPath, args: ["-e", "setInterval(() => undefined, 1000)"] },
      resumedOwner.sessionId,
    );
    expect(interrupted.success).toBe(false);
    await startPendingTurn(fixture.sessionStore, resumedOwner.sessionId);
    const resumed = await runtime.executeManualTool(
      "start_process",
      { command: process.execPath, args: ["-e", "process.stdout.write('RESUMED\\n'); setInterval(() => undefined, 1000)"], readyPattern: "RESUMED" },
      resumedOwner.sessionId,
    );
    expect(resumed.success).toBe(true);
    await runtime.executeManualTool(
      "stop_process",
      { processSessionId: structured<StartProcessBody>(resumed).processSessionId, strategy: "force", gracefulTimeoutMs: 0 },
      resumedOwner.sessionId,
    );

    let releaseOwnerCheck = (): void => undefined;
    let ownerCheckEntered = (): void => undefined;
    const ownerCheckGate = new Promise<void>((resolve) => {
      releaseOwnerCheck = resolve;
    });
    const entered = new Promise<void>((resolve) => {
      ownerCheckEntered = resolve;
    });
    const manager = track(new ToolProcessManager({
      workspaceRoot: fixture.workspaceRoot,
      assertSession: async () => {
        ownerCheckEntered();
        await ownerCheckGate;
        return true;
      },
    }));
    const pendingStart = manager.start({
      sessionId: resumedOwner.sessionId,
      toolCallId: "phase17-racing-start",
      command: process.execPath,
      args: ["-e", "setInterval(() => undefined, 1000)"],
      cwd: fixture.workspaceRoot,
      interactionMode: "none",
      startupTimeoutMs: 5_000,
    });
    await entered;
    await manager.stopSession(resumedOwner.sessionId, "session_interrupted");
    releaseOwnerCheck();
    await expect(pendingStart).rejects.toThrow(/stopped|cancelled/iu);
    expect(manager.list(resumedOwner.sessionId).some((entry) => entry.toolCallId === "phase17-racing-start")).toBe(false);
  }, 30_000);

  it("runtime dispose terminates the full child tree", async () => {
    const fixture = await createWorkspace("deep-mix-phase17-child-tree-");
    const manager = track(new ToolProcessManager({ workspaceRoot: fixture.workspaceRoot }));
    const childPidPath = path.join(fixture.workspaceRoot, "child.pid");
    const parentScriptPath = path.join(fixture.workspaceRoot, "managed-tree.cjs");
    const parentSource = [
      "const { spawn } = require('node:child_process')",
      "const fs = require('node:fs')",
      "const child = spawn(process.execPath, ['-e', 'setInterval(() => undefined, 1000)'], { stdio: 'ignore' })",
      "fs.writeFileSync(process.argv[2], String(child.pid))",
      "process.stdout.write('CHILD_READY\\n')",
      "setInterval(() => undefined, 1000)",
    ].join(";");
    await fs.writeFile(parentScriptPath, parentSource, "utf8");
    const started = await manager.start({
      sessionId: fixture.sessionId,
      toolCallId: "phase17-child-tree-start",
      command: process.execPath,
      args: [parentScriptPath, childPidPath],
      cwd: fixture.workspaceRoot,
      interactionMode: "none",
      readyPattern: "CHILD_READY",
      startupTimeoutMs: 5_000,
    });
    expect(started.ready).toBe(true);
    const childPid = Number(await waitFor(
      () => fs.readFile(childPidPath, "utf8").catch(() => ""),
      (value) => /^\d+$/u.test(value.trim()),
    ));
    expect(isPidAlive(childPid)).toBe(true);
    await manager.dispose();
    await waitFor(() => isPidAlive(childPid), (alive) => !alive, 10_000);
    expect(manager.list(fixture.sessionId)[0]).toMatchObject({
      status: "stopped",
      exit: { reason: "runtime_dispose" },
    });
  }, 30_000);

  it("runtime dispose aborts and awaits in-flight foreground command trees", async () => {
    const fixture = await createWorkspace("deep-mix-phase17-foreground-dispose-");
    const runtime = createRuntime(fixture);
    const scriptPath = path.join(fixture.workspaceRoot, "foreground-tree.cjs");
    const pidPath = path.join(fixture.workspaceRoot, "foreground-tree.json");
    await fs.writeFile(scriptPath, [
      "const { spawn } = require('node:child_process')",
      "const fs = require('node:fs')",
      "const child = spawn(process.execPath, ['-e', 'setInterval(() => undefined, 1000)'], { stdio: 'ignore' })",
      "fs.writeFileSync(process.argv[2], JSON.stringify({ root: process.pid, child: child.pid }))",
      "setInterval(() => undefined, 1000)",
    ].join(";"), "utf8");
    const executableCommand = process.platform === "win32"
      ? `& ${JSON.stringify(process.execPath)}`
      : JSON.stringify(process.execPath);
    const execution = runtime.executeManualTool(
      "run_shell",
      { command: `${executableCommand} ${JSON.stringify(scriptPath)} ${JSON.stringify(pidPath)}`, timeoutMs: 60_000 },
      fixture.sessionId,
    );
    const pids = JSON.parse(await waitFor(
      () => fs.readFile(pidPath, "utf8").catch(() => ""),
      (value) => value.startsWith("{"),
    )) as { root: number; child: number };
    expect(isPidAlive(pids.root)).toBe(true);
    expect(isPidAlive(pids.child)).toBe(true);
    await runtime.dispose();
    await execution;
    await waitFor(
      () => ({ root: isPidAlive(pids.root), child: isPidAlive(pids.child) }),
      (state) => !state.root && !state.child,
      10_000,
    );
    expect(isPidAlive(pids.root)).toBe(false);
    expect(isPidAlive(pids.child)).toBe(false);
  }, 30_000);

  it("runProcess cleans descendants after timeout and after a natural root close", async () => {
    const fixture = await createWorkspace("deep-mix-phase17-run-process-tree-");
    for (const mode of ["timeout", "natural"] as const) {
      const childPidPath = path.join(fixture.workspaceRoot, `${mode}-child.pid`);
      const source = [
        "const { spawn } = require('node:child_process')",
        "const fs = require('node:fs')",
        "const child = spawn(process.execPath, ['-e', 'setInterval(() => undefined, 1000)'], { stdio: 'ignore' })",
        "fs.writeFileSync(process.argv[1], String(child.pid))",
        mode === "timeout"
          ? "setInterval(() => undefined, 1000)"
          : "setTimeout(() => process.exit(0), 50)",
      ].join(";");
      const result = await runProcess({
        file: process.execPath,
        args: ["-e", source, childPidPath],
        cwd: fixture.workspaceRoot,
        timeoutMs: mode === "timeout" ? 300 : 10_000,
        maxOutputChars: 8_192,
        enforceTreeCleanup: true,
      });
      expect(result.timedOut, mode).toBe(mode === "timeout");
      expect(result.spawnError, mode).toBeUndefined();
      const childPid = Number(await fs.readFile(childPidPath, "utf8"));
      expect(Number.isInteger(childPid) && childPid > 0, mode).toBe(true);
      fallbackProcessPids.add(childPid);
      await waitFor(() => isPidAlive(childPid), (alive) => !alive, 10_000);
      fallbackProcessPids.delete(childPid);
    }
  }, 40_000);

  it("executes the Windows cmd safe subset without injection and rejects expansion characters fail closed", async () => {
    const windows = resolveManagedSpawnCommand(
      "C:\\repo\\node_modules\\.bin\\tool.cmd",
      ["--flag", "value with spaces", "safe&whoami"],
      "win32",
      { ComSpec: "C:\\Windows\\System32\\cmd.exe" },
    );
    expect(windows.file).toBe("C:\\Windows\\System32\\cmd.exe");
    expect(windows.args.slice(0, 3)).toEqual(["/d", "/s", "/c"]);
    expect(windows.args[3]).toContain("\"value with spaces\"");
    expect(windows.args[3]).toContain("\"safe&whoami\"");
    expect(windows.windowsVerbatimArguments).toBe(true);

    for (const unsafe of ["100%", "bang!", "double\"quote", "line\nbreak", "nul\0byte"]) {
      let thrown: NodeJS.ErrnoException | undefined;
      try {
        resolveManagedSpawnCommand("C:\\repo\\tool.cmd", [unsafe], "win32", { ComSpec: "cmd.exe" });
      } catch (error) {
        thrown = error as NodeJS.ErrnoException;
      }
      expect(thrown, unsafe).toBeDefined();
      expect(thrown?.code, unsafe).toBe("EINVAL");
    }

    if (process.platform === "win32") {
      const fixture = await createWorkspace("deep-mix-phase17-cmd-safe-");
      const commandPath = path.join(fixture.workspaceRoot, "echo-arg.cmd");
      await fs.writeFile(
        commandPath,
        [
          "@echo off",
          "setlocal DisableDelayedExpansion",
          "set \"ARG=%~1\"",
          "set ARG",
        ].join("\r\n"),
        "utf8",
      );
      const manager = track(new ToolProcessManager({ workspaceRoot: fixture.workspaceRoot }));
      const started = await manager.start({
        sessionId: fixture.sessionId,
        toolCallId: "phase17-cmd-safe-start",
        command: commandPath,
        args: ["safe&whoami"],
        cwd: fixture.workspaceRoot,
        interactionMode: "none",
        readyPattern: "ARG=safe&whoami",
        startupTimeoutMs: 5_000,
      });
      expect(started.ready).toBe(true);
      const output = await waitFor(
        () => manager.readOutput({
          ownerSessionId: fixture.sessionId,
          processSessionId: started.session.processSessionId,
          cursor: 0,
          maxChars: 16_384,
          waitMs: 100,
        }),
        (entry) => entry.stdout.includes("ARG=safe&whoami") &&
          ["exited", "failed", "stopped", "orphaned"].includes(entry.status),
      );
      expect(output.stdout.split(/\r?\n/u).filter(Boolean)).toEqual(["ARG=safe&whoami"]);
      expect(output.stderr).toBe("");
    }

    expect(resolveManagedSpawnCommand("/usr/bin/node", ["-e", "ok"], "linux", {})).toEqual({
      file: "/usr/bin/node",
      args: ["-e", "ok"],
    });
    expect(resolveManagedSpawnCommand("/usr/bin/node", ["-e", "ok"], "darwin", {})).toEqual({
      file: "/usr/bin/node",
      args: ["-e", "ok"],
    });
  }, 20_000);

  it("marks persisted active state orphaned after restart and refuses to claim control", async () => {
    const fixture = await createWorkspace("deep-mix-phase17-restart-");
    const first = track(new ToolProcessManager({
      workspaceRoot: fixture.workspaceRoot,
      createId: () => "phase17-restart-active",
    }));
    const started = await first.start({
      sessionId: fixture.sessionId,
      toolCallId: "phase17-restart-call",
      command: process.execPath,
      args: ["-e", "process.stdout.write('BEFORE_RESTART\\n'); setInterval(() => undefined, 1000)"],
      cwd: fixture.workspaceRoot,
      interactionMode: "none",
      readyPattern: "BEFORE_RESTART",
      startupTimeoutMs: 5_000,
    });
    expect(started.session.status).toBe("running");
    expect(started.session.nextCursor).toBeGreaterThan(0);

    const restarted = track(new ToolProcessManager({ workspaceRoot: fixture.workspaceRoot }));
    await restarted.initialize();
    expect(restarted.list(fixture.sessionId)).toContainEqual(expect.objectContaining({
      processSessionId: "phase17-restart-active",
      status: "orphaned",
      orphanedReason: expect.stringMatching(/without a live child-process handle/iu),
      exit: expect.objectContaining({ reason: "control_lost" }),
    }));
    const emptyAfterRestart = await restarted.readOutput({
      ownerSessionId: fixture.sessionId,
      processSessionId: "phase17-restart-active",
      cursor: 0,
      maxChars: 128,
      waitMs: 0,
    });
    expect(emptyAfterRestart).toMatchObject({
      status: "orphaned",
      requestedCursor: 0,
      startCursor: started.session.nextCursor,
      nextCursor: started.session.nextCursor,
      stdout: "",
      stderr: "",
      hasMore: false,
      cursorExpired: true,
    });
    expect(emptyAfterRestart.droppedBeforeCursor).toBe(started.session.nextCursor);
    await expect(restarted.stop({
      ownerSessionId: fixture.sessionId,
      processSessionId: "phase17-restart-active",
      strategy: "force",
      gracefulTimeoutMs: 0,
    })).resolves.toMatchObject({ outcome: "unable_to_confirm", status: "orphaned" });
  }, 15_000);

  it("returns build and coverage structures, artifacts, thresholds, and missing-capability results", async () => {
    const fixture = await createWorkspace("deep-mix-phase17-quality-");
    const runtime = createRuntime(fixture);
    const buildSource = [
      "const fs = require('node:fs')",
      "fs.mkdirSync('dist', { recursive: true })",
      "fs.writeFileSync('dist/result.txt', 'built')",
      "process.stdout.write('B'.repeat(80000) + 'BUILD_OUTPUT_TAIL_SENTINEL')",
    ].join(";");
    const build = await runtime.executeManualTool(
      "build",
      {
        command: process.execPath,
        args: ["-e", buildSource],
        outputDirectories: ["dist"],
        timeoutMs: 10_000,
      },
      fixture.sessionId,
    );
    const buildBody = structured<{
      kind: string;
      ok: boolean;
      exitCode: number;
      durationMs: number;
      changedDirectories: string[];
      outputDirectories: Array<{ relativePath: string; files: number }>;
      output: string;
      outputTruncated: boolean;
      dependencyInstallAttempted: boolean;
    }>(build);
    expect(build.success).toBe(true);
    expect(buildBody).toMatchObject({
      kind: "build",
      ok: true,
      exitCode: 0,
      dependencyInstallAttempted: false,
    });
    expect(buildBody.durationMs).toBeGreaterThanOrEqual(0);
    expect(buildBody.changedDirectories).toContain("dist");
    expect(buildBody.outputDirectories).toContainEqual(expect.objectContaining({ relativePath: "dist", files: 1 }));
    expect(buildBody.output).toContain("BUILD_OUTPUT_TAIL_SENTINEL");
    expect(buildBody.outputTruncated).toBe(false);
    expect(build.output).toContain("BUILD_OUTPUT_TAIL_SENTINEL");

    const coverageSource = [
      "const fs = require('node:fs')",
      "fs.mkdirSync('coverage', { recursive: true })",
      "const metric = (total, covered, pct) => ({ total, covered, skipped: 0, pct })",
      "const report = { total: { lines: metric(10, 9, 90), branches: metric(8, 6, 75), functions: metric(4, 4, 100), statements: metric(12, 11, 91.67) } }",
      "fs.writeFileSync('coverage/coverage-summary.json', JSON.stringify(report))",
      "process.stdout.write('C'.repeat(80000) + 'COVERAGE_OUTPUT_TAIL_SENTINEL')",
    ].join(";");
    const coverage = await runtime.executeManualTool(
      "test_coverage",
      {
        command: process.execPath,
        args: ["-e", coverageSource],
        thresholds: { lines: 90, branches: 75, functions: 100, statements: 90 },
        timeoutMs: 10_000,
      },
      fixture.sessionId,
    );
    const coverageBody = structured<{
      kind: string;
      ok: boolean;
      metrics: Record<string, { pct: number | null }>;
      thresholds: { configured: boolean; passed: boolean };
      report: { source: string; path?: string; content?: string; artifactUris: string[] };
      commandOutput: string;
      commandOutputTruncated: boolean;
      dependencyInstallAttempted: boolean;
    }>(coverage);
    expect(coverage.success).toBe(true);
    expect(coverageBody).toMatchObject({
      kind: "test_coverage",
      ok: true,
      metrics: { lines: { pct: 90 }, branches: { pct: 75 }, functions: { pct: 100 } },
      thresholds: { configured: true, passed: true },
      report: { source: "coverage_summary_json", path: "coverage/coverage-summary.json" },
      dependencyInstallAttempted: false,
    });
    expect(coverageBody.report.artifactUris[0]).toMatch(/^artifact:\/\/tool-outputs\//u);
    expect(await fixture.sessionStore.readTextToolOutputArtifact(coverageBody.report.artifactUris[0]!))
      .toContain('"lines"');
    expect(coverageBody.report.content).toContain('"statements"');
    expect(coverageBody.commandOutput).toContain("COVERAGE_OUTPUT_TAIL_SENTINEL");
    expect(coverageBody.commandOutputTruncated).toBe(false);
    expect(coverage.output).toContain("COVERAGE_OUTPUT_TAIL_SENTINEL");

    const buildUnavailable = await runtime.executeManualTool("build", {}, fixture.sessionId);
    const coverageUnavailable = await runtime.executeManualTool("test_coverage", {}, fixture.sessionId);
    expect(structured<{ capabilityAvailable: boolean; dependencyInstallAttempted: boolean }>(buildUnavailable))
      .toMatchObject({ capabilityAvailable: false, dependencyInstallAttempted: false });
    expect(structured<{ capabilityAvailable: boolean; dependencyInstallAttempted: boolean }>(coverageUnavailable))
      .toMatchObject({ capabilityAvailable: false, dependencyInstallAttempted: false });
  }, 30_000);

  it("rejects an unchanged stale coverage report when the command produces no fresh metrics", async () => {
    const fixture = await createWorkspace("deep-mix-phase17-stale-coverage-");
    const runtime = createRuntime(fixture);
    const coverageDirectory = path.join(fixture.workspaceRoot, "coverage");
    const reportPath = path.join(coverageDirectory, "coverage-summary.json");
    await fs.mkdir(coverageDirectory, { recursive: true });
    const metric = (total: number, covered: number, pct: number) => ({ total, covered, skipped: 0, pct });
    const staleReport = JSON.stringify({
      total: {
        lines: metric(10, 10, 100),
        branches: metric(8, 8, 100),
        functions: metric(4, 4, 100),
        statements: metric(12, 12, 100),
      },
    });
    await fs.writeFile(reportPath, staleReport, "utf8");
    const before = await fs.stat(reportPath);
    const result = await runtime.executeManualTool(
      "test_coverage",
      {
        command: process.execPath,
        args: ["-e", "process.exit(0)"],
        reportPath: "coverage/coverage-summary.json",
        timeoutMs: 10_000,
      },
      fixture.sessionId,
    );
    const body = structured<{
      ok: boolean;
      metrics: Record<string, { pct: number | null }>;
      report: { source: string; staleExistingReportIgnored: boolean; artifactUris: string[] };
      error: { type: string; message: string };
    }>(result);
    expect(result.success).toBe(false);
    expect(body.ok).toBe(false);
    expect(body.error).toMatchObject({ type: "invalid_state" });
    expect(body.error.message).toMatch(/without updating|stale|fresh/iu);
    expect(body.report).toMatchObject({
      source: "unavailable",
      staleExistingReportIgnored: true,
      artifactUris: [],
    });
    expect(Object.values(body.metrics).every((entry) => entry.pct === null)).toBe(true);
    expect(await fs.readFile(reportPath, "utf8")).toBe(staleReport);
    expect((await fs.stat(reportPath)).mtimeMs).toBe(before.mtimeMs);
  }, 20_000);

  it("format write creates checkpoint and diff, undo restores content, and protected paths fail closed", async () => {
    const fixture = await createWorkspace("deep-mix-phase17-format-");
    const runtime = createRuntime(fixture);
    const targetPath = path.join(fixture.workspaceRoot, "sample.txt");
    const original = "alpha    beta";
    await fs.writeFile(targetPath, original, "utf8");
    const formatterSource = [
      "const fs = require('node:fs')",
      "const target = process.argv[1]",
      "const input = fs.readFileSync(target, 'utf8')",
      "fs.writeFileSync(target, input.replace(/ +/gu, ' ').trim() + '\\n')",
      "process.stdout.write('F'.repeat(80000) + 'FORMAT_OUTPUT_TAIL_SENTINEL')",
    ].join(";");
    const formatted = await runtime.executeManualTool(
      "format",
      {
        mode: "write",
        command: process.execPath,
        args: ["-e", formatterSource],
        paths: ["sample.txt"],
        timeoutMs: 10_000,
      },
      fixture.sessionId,
    );
    const formatBody = structured<{
      kind: string;
      ok: boolean;
      checkpointId: string;
      undoAvailable: boolean;
      output: string;
      outputTruncated: boolean;
      diff: { changedFiles: string[]; preview: string; full: string };
    }>(formatted);
    expect(formatted.success).toBe(true);
    expect(formatBody).toMatchObject({
      kind: "format",
      ok: true,
      undoAvailable: true,
      diff: { changedFiles: ["sample.txt"] },
    });
    expect(formatBody.checkpointId).toBeTruthy();
    expect(formatBody.diff.preview).toContain("+++ b/sample.txt");
    expect(formatBody.diff.full).toContain("+++ b/sample.txt");
    expect(formatBody.output).toContain("FORMAT_OUTPUT_TAIL_SENTINEL");
    expect(formatBody.outputTruncated).toBe(false);
    expect(formatted.output).toContain("FORMAT_OUTPUT_TAIL_SENTINEL");
    expect(await fs.readFile(targetPath, "utf8")).toBe("alpha beta\n");

    const undone = await runtime.executeManualTool(
      "undo",
      { checkpointId: formatBody.checkpointId, mode: "code" },
      fixture.sessionId,
    );
    expect(undone.success).toBe(true);
    expect(await fs.readFile(targetPath, "utf8")).toBe(original);

    const protectedDirectory = path.join(fixture.workspaceRoot, ".deep-mix", "api-key-library");
    const protectedPath = path.join(protectedDirectory, "profiles.local.json");
    await fs.mkdir(protectedDirectory, { recursive: true });
    await fs.writeFile(protectedPath, '{"apiKey":"fixture-secret"}', "utf8");
    const protectedAttempt = await runtime.executeManualTool(
      "format",
      {
        mode: "write",
        command: process.execPath,
        args: ["-e", formatterSource],
        paths: [".deep-mix/api-key-library/profiles.local.json"],
      },
      fixture.sessionId,
    );
    expect(protectedAttempt.success).toBe(false);
    expect(await fs.readFile(protectedPath, "utf8")).toBe('{"apiKey":"fixture-secret"}');
    expect(JSON.stringify(protectedAttempt)).not.toContain("fixture-secret");
  }, 30_000);

  it("rolls back out-of-scope format writes and any mutation performed in check mode", async () => {
    const fixture = await createWorkspace("deep-mix-phase17-format-audit-");
    const runtime = createRuntime(fixture);
    const targetPath = path.join(fixture.workspaceRoot, "target.txt");
    const outsidePath = path.join(fixture.workspaceRoot, "outside.txt");
    const createdPath = path.join(fixture.workspaceRoot, "formatter-created.txt");
    await fs.writeFile(targetPath, "target-original\n", "utf8");
    await fs.writeFile(outsidePath, "outside-original\n", "utf8");

    const outOfScopeSource = [
      "const fs = require('node:fs')",
      "fs.writeFileSync('outside.txt', 'outside-mutated\\n')",
      "fs.writeFileSync('formatter-created.txt', 'unsupported\\n')",
    ].join(";");
    const outOfScope = await runtime.executeManualTool(
      "format",
      {
        mode: "write",
        command: process.execPath,
        args: ["-e", outOfScopeSource],
        paths: ["target.txt"],
        timeoutMs: 10_000,
      },
      fixture.sessionId,
    );
    const outOfScopeBody = structured<{
      ok: boolean;
      restoreOnFailure: boolean;
      writeAudit: {
        outOfScopeChanges: string[];
        createdEntries: string[];
        rolledBackCreatedEntries: boolean;
      };
      error: { type: string; message: string };
    }>(outOfScope);
    expect(outOfScope.success).toBe(false);
    expect(outOfScopeBody).toMatchObject({
      ok: false,
      restoreOnFailure: true,
      writeAudit: {
        outOfScopeChanges: ["outside.txt"],
        createdEntries: ["formatter-created.txt"],
        rolledBackCreatedEntries: true,
      },
      error: { type: "invalid_state" },
    });
    expect(await fs.readFile(targetPath, "utf8")).toBe("target-original\n");
    expect(await fs.readFile(outsidePath, "utf8")).toBe("outside-original\n");
    await expect(fs.stat(createdPath)).rejects.toMatchObject({ code: "ENOENT" });

    const checkMutationSource = [
      "const fs = require('node:fs')",
      "fs.writeFileSync('target.txt', 'check-mode-mutated\\n')",
    ].join(";");
    const checkMutation = await runtime.executeManualTool(
      "format",
      {
        mode: "check",
        command: process.execPath,
        args: ["-e", checkMutationSource],
        paths: ["target.txt"],
        timeoutMs: 10_000,
      },
      fixture.sessionId,
    );
    const checkBody = structured<{
      ok: boolean;
      mode: string;
      restoreOnFailure: boolean;
      writeAudit: { outOfScopeChanges: string[] };
      error: { type: string; message: string };
    }>(checkMutation);
    expect(checkMutation.success).toBe(false);
    expect(checkBody).toMatchObject({
      ok: false,
      mode: "check",
      restoreOnFailure: true,
      writeAudit: { outOfScopeChanges: ["target.txt"] },
      error: { type: "invalid_state" },
    });
    expect(checkBody.error.message).toMatch(/check mutated|rolled back/iu);
    expect(await fs.readFile(targetPath, "utf8")).toBe("target-original\n");
    expect(await fs.readFile(outsidePath, "utf8")).toBe("outside-original\n");
  }, 30_000);

  it("rejects protected coverage reports before reading them", async () => {
    const fixture = await createWorkspace("deep-mix-phase17-protected-report-");
    const runtime = createRuntime(fixture);
    const protectedDirectory = path.join(fixture.workspaceRoot, ".deep-mix", "api-key-library");
    await fs.mkdir(protectedDirectory, { recursive: true });
    await fs.writeFile(
      path.join(protectedDirectory, "profiles.local.json"),
      '{"token":"phase17-protected-report-secret"}',
      "utf8",
    );
    const result = await runtime.executeManualTool(
      "test_coverage",
      {
        command: process.execPath,
        args: ["-e", "process.stdout.write('Lines: 100% (1/1)')"],
        reportPath: ".deep-mix/api-key-library/profiles.local.json",
      },
      fixture.sessionId,
    );
    expect(result.success).toBe(false);
    expect(JSON.stringify(result)).not.toContain("phase17-protected-report-secret");
    expect(JSON.stringify(result.structuredContent)).toMatch(/protected|readable sandbox/iu);
  }, 15_000);

  it("parses bounded log artifacts and redacts credentials before results or derived artifacts", async () => {
    const fixture = await createWorkspace("deep-mix-phase17-inspect-logs-");
    const runtime = createRuntime(fixture);
    const secret = "phase17-log-secret-749318";
    const log = [
      `2026-07-14T10:00:00Z INFO [api] starting token=${secret}`,
      `2026-07-14T10:00:01Z ERROR [api] request failed Authorization: Bearer ${secret}`,
      "    at handler (src/server.ts:42:7)",
      `2026-07-14T10:00:02Z ERROR [api] request failed Authorization: Bearer ${secret}`,
      `${"x".repeat(80_000)}INSPECT_LOGS_TAIL_SENTINEL`,
    ].join("\n");
    const sourceArtifact = await fixture.sessionStore.storeToolOutputArtifact({
      sessionId: fixture.sessionId,
      toolCallId: "phase17-log-source",
      sourceToolName: "phase17_fixture",
      fileName: "application.log",
      mimeType: "text/plain",
      kind: "text",
      summary: "phase 17 log fixture",
      content: log,
    });
    const result = await runtime.executeManualTool(
      "inspect_logs",
      { source: sourceArtifact.uri },
      fixture.sessionId,
    );
    const body = structured<{
      kind: string;
      ok: boolean;
      source: { kind: string; reference: string };
      levelCounts: { info: number; error: number };
      keyErrors: Array<{ message: string; count: number }>;
      stackLocations: Array<{ path: string; line: number }>;
      repeatedMessages: Array<{ count: number }>;
      redactedSource: string;
      sourceComplete: boolean;
      executionAttempted: boolean;
      artifactUris: string[];
    }>(result);
    expect(result.success).toBe(true);
    expect(body).toMatchObject({
      kind: "inspect_logs",
      ok: true,
      source: { kind: "artifact", reference: sourceArtifact.uri },
      levelCounts: { info: 1, error: 2 },
      executionAttempted: false,
    });
    expect(body.keyErrors.length).toBeGreaterThan(0);
    expect(body.stackLocations).toContainEqual(expect.objectContaining({ path: "src/server.ts", line: 42 }));
    expect(body.repeatedMessages.some((entry) => entry.count >= 2)).toBe(true);
    expect(body.redactedSource).toContain("INSPECT_LOGS_TAIL_SENTINEL");
    expect(body.sourceComplete).toBe(true);
    expect(result.output).toContain("INSPECT_LOGS_TAIL_SENTINEL");
    expect("contextSummary" in result).toBe(false);
    expect(body.artifactUris[0]).toMatch(/^artifact:\/\/tool-outputs\//u);
    expect(JSON.stringify(result)).not.toContain(secret);
    const redactedArtifact = await fixture.sessionStore.readTextToolOutputArtifact(body.artifactUris[0]!);
    expect(redactedArtifact).toContain("[REDACTED]");
    expect(redactedArtifact).not.toContain(secret);
  }, 15_000);

  it("keeps run_shell, run_tests, lint, and typecheck compatible while blocking detached escape syntax", async () => {
    const fixture = await createWorkspace("deep-mix-phase17-command-regression-");
    const runtime = createRuntime(fixture);
    const command = `node -e "process.stdout.write('phase17-ok')"`;
    for (const toolName of ["run_shell", "run_tests", "lint", "typecheck"] as const) {
      const result = await runtime.executeManualTool(toolName, { command, timeoutMs: 10_000 }, fixture.sessionId);
      expect(result.success, `${toolName}: ${result.output}`).toBe(true);
      expect(result.output).toContain("phase17-ok");
      expect(structured<{ command: string; exitCode?: number }>(result)).toMatchObject({ command });
    }

    const detachedCommand = process.platform === "win32" ? "Start-Process node" : "nohup node server.js &";
    for (const toolName of ["run_shell", "run_tests", "lint", "typecheck"] as const) {
      const detached = await runtime.executeManualTool(toolName, { command: detachedCommand }, fixture.sessionId);
      expect(detached.success, toolName).toBe(false);
      expect(structured<{ blocked: boolean; lifecycleTool: string }>(detached)).toMatchObject({
        blocked: true,
        lifecycleTool: "start_process",
      });
    }

    const guardedPath = path.join(fixture.workspaceRoot, "post-edit-detacher.txt");
    const postEdit = await runtime.executeManualTool(
      "apply_patch",
      {
        changes: [{ path: "post-edit-detacher.txt", action: "upsert", content: "must-not-write" }],
        lintCommand: detachedCommand,
      },
      fixture.sessionId,
    );
    expect(postEdit.success).toBe(false);
    await expect(fs.stat(guardedPath)).rejects.toMatchObject({ code: "ENOENT" });

    const inlineDetach = await runtime.executeManualTool(
      "start_process",
      {
        command: process.execPath,
        args: ["-e", "require('node:child_process').spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], { detached: true }).unref()"],
      },
      fixture.sessionId,
    );
    expect(inlineDetach.success).toBe(false);
    expect(runtime.listManagedProcesses(fixture.sessionId).filter((entry) => ["starting", "running"].includes(entry.status))).toEqual([]);
  }, 30_000);

  it("detects quoted, nested, aliased, and inline-program detachment without PowerShell false positives", () => {
    const blocked: Array<[string, NodeJS.Platform]> = [
      ["saps node -ArgumentList server.js", "win32"],
      ["Write-Output ok; start node server.js", "win32"],
      ["bash -c 'nohup node server.js >/tmp/server.log 2>&1 &'", "win32"],
      ["sh -lc \"setsid node server.js\"", "linux"],
      ["node -e \"require('node:child_process').spawn('node', ['server.js'])\"", "win32"],
      ["node -e \"require('child_process').fork('server.js')\"", "linux"],
    ];
    for (const [command, platform] of blocked) {
      expect(detachedShellPattern(command, platform), command).toBeTruthy();
    }

    const allowed: Array<[string, NodeJS.Platform]> = [
      ["Write-Output \"Start-Process node &\"", "win32"],
      ["Write-Output ok; & npm test", "win32"],
      ["& npm test", "win32"],
      ["printf '%s\\n' 'nohup node server.js &'", "linux"],
    ];
    for (const [command, platform] of allowed) {
      expect(detachedShellPattern(command, platform), command).toBeUndefined();
    }
  });

  it("denies a persisted side-effect grant in plan mode before the grant can be claimed", async () => {
    const fixture = await createWorkspace("deep-mix-phase17-plan-grant-");
    const args = { command: "node -e \"process.exit(0)\"" };
    const requestKey = buildApprovalRequestKey(
      "run_shell",
      args,
      await fixture.sessionStore.getApprovalRequestKeySecret(),
    );
    await fixture.sessionStore.saveApprovalGrant({
      approvalId: "phase17-plan-grant",
      sessionId: fixture.sessionId,
      toolName: "run_shell",
      permissionCategory: "execute_command",
      requestKey,
      decision: "allow",
      persistence: "allow_session",
      createdAt: new Date().toISOString(),
      reason: "Fixture grant created before entering plan mode.",
    });
    const layer = new PermissionLayer(fixture.workspaceRoot, "plan", fixture.sessionStore);
    await expect(layer.evaluate({
      sessionId: fixture.sessionId,
      toolName: "run_shell",
      permissionCategory: "execute_command",
      sideEffectLevel: "medium",
      readOnly: false,
      arguments: args,
    })).resolves.toMatchObject({ decision: "deny", requestKey });
    expect(await fixture.sessionStore.loadApprovalGrant(fixture.sessionId, requestKey)).toMatchObject({
      approvalId: "phase17-plan-grant",
    });
  });

  it("tool_search discovery never bypasses normal approval for a process tool", async () => {
    const fixture = await createWorkspace("deep-mix-phase17-search-approval-");
    const runtime = createRuntime({ ...fixture, permissionMode: "auto" });
    await startPendingTurn(fixture.sessionStore, fixture.sessionId);
    const searched = await runtime.executeManualTool(
      "tool_search",
      { query: "start_process", mode: "activate", maxResults: 1, maxActivations: 1 },
      fixture.sessionId,
    );
    expect(searched.success).toBe(true);
    expect(structured<{ activation: { activatedToolNames: string[] } }>(searched).activation.activatedToolNames)
      .toContain("start_process");
    await expect(runtime.executeManualTool(
      "start_process",
      { command: process.execPath, args: ["-e", "setInterval(() => undefined, 1000)"] },
      fixture.sessionId,
    )).rejects.toBeInstanceOf(PermissionRequiredError);
    expect(runtime.listManagedProcesses(fixture.sessionId)).toEqual([]);
  }, 15_000);
});
