import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { GovernorRuntime, PermissionRequiredError } from "../packages/core-governor/src/index.js";
import { SessionStore } from "../packages/persistence/src/index.js";
import type {
  AssistantResponse,
  ModelClient,
  ModelCompletionRequest,
  StreamCallbacks,
} from "../packages/shared-schema/src/index.js";
import { CliSessionShell, type OutputWriter, type PromptReader, readProfileStatus } from "../apps/cli/src/session-shell.js";

class ScriptedModelClient implements ModelClient {
  private index = 0;

  public constructor(
    private readonly responses: Array<
      AssistantResponse | ((request: ModelCompletionRequest, callbacks?: StreamCallbacks) => Promise<AssistantResponse>)
    >,
  ) {}

  public async streamCompletion(
    request: ModelCompletionRequest,
    callbacks?: StreamCallbacks,
  ): Promise<AssistantResponse> {
    const response = this.responses[this.index];
    if (!response) {
      throw new Error(`Unexpected model call index ${this.index}`);
    }
    this.index += 1;

    const resolved =
      typeof response === "function"
        ? await response(request, callbacks)
        : response;

    for (const char of resolved.content) {
      callbacks?.onTextDelta?.(char);
    }

    return resolved;
  }
}

class ScriptedInput implements PromptReader {
  private index = 0;

  public readonly prompts: string[] = [];

  public constructor(private readonly values: Array<string | undefined>) {}

  public async read(promptText: string): Promise<string | undefined> {
    this.prompts.push(promptText);
    if (this.index >= this.values.length) {
      return undefined;
    }
    const value = this.values[this.index];
    this.index += 1;
    return value;
  }

  public close(): void {}
}

class BlockingInput implements PromptReader {
  public readonly prompts: string[] = [];

  private pendingResolve?: (value: string | undefined) => void;

  private readStarted?: () => void;

  private readonly started = new Promise<void>((resolve) => {
    this.readStarted = resolve;
  });

  public async read(promptText: string): Promise<string | undefined> {
    this.prompts.push(promptText);
    this.readStarted?.();
    return new Promise((resolve) => {
      this.pendingResolve = resolve;
    });
  }

  public async waitForRead(): Promise<void> {
    await this.started;
  }

  public close(): void {
    this.pendingResolve?.(undefined);
    this.pendingResolve = undefined;
  }
}

class BufferOutput implements OutputWriter {
  public buffer = "";

  public write(text: string): void {
    this.buffer += text;
  }
}

const temporaryRoots: string[] = [];

async function createFixtureWorkspace(prefix: string): Promise<string> {
  const workspaceRoot = await fs.mkdtemp(path.join(os.tmpdir(), prefix));
  temporaryRoots.push(workspaceRoot);
  await fs.mkdir(path.join(workspaceRoot, ".deep-mix", "api-key-library"), { recursive: true });
  await fs.writeFile(
    path.join(workspaceRoot, ".deep-mix", "api-key-library", "profiles.local.json"),
    JSON.stringify(
      {
        version: 1,
        profiles: {
          deepseek_governor: {
            provider: "deepseek",
            role: "governor",
            apiKey: "fake-local-key",
            baseUrl: "https://example.invalid",
            chatPath: "/chat/completions",
            model: "deepseek-chat",
          },
          glm_coding_worker: {
            provider: "glm",
            role: "coding_worker",
            apiKey: "fake-local-key",
            baseUrl: "https://example.invalid",
            chatPath: "/chat/completions",
            model: "glm-5.2",
          },
          kimi_vision: {
            provider: "kimi",
            role: "vision_worker",
            apiKey: "fake-local-key",
            baseUrl: "https://example.invalid",
            chatPath: "/v1/chat/completions",
            model: "kimi-k2.6",
            supportsMultimodalInput: true,
          },
        },
      },
      null,
      2,
    ),
    "utf8",
  );
  return workspaceRoot;
}

async function createShell(options: {
  workspaceRoot: string;
  permissionMode: "plan" | "edit" | "auto" | "danger-full-access";
  modelClient: ModelClient;
  inputValues: Array<string | undefined>;
}) {
  const sessionStore = new SessionStore(options.workspaceRoot);
  const runtime = new GovernorRuntime({
    workspaceRoot: options.workspaceRoot,
    permissionMode: options.permissionMode,
    modelClient: options.modelClient,
  });
  const input = new ScriptedInput(options.inputValues);
  const output = new BufferOutput();
  const shell = new CliSessionShell({
    runtime,
    sessionStore,
    input,
    output,
    workspaceRoot: options.workspaceRoot,
    permissionMode: options.permissionMode,
    getProfileStatus: () => readProfileStatus(options.workspaceRoot),
  });
  return {
    runtime,
    sessionStore,
    input,
    output,
    shell,
  };
}

afterEach(async () => {
  await Promise.all(
    temporaryRoots.splice(0).map(async (root) => {
      await fs.rm(root, { recursive: true, force: true });
    }),
  );
});

describe("phase 9 CLI session loop and approval repair", () => {
  it("keeps the CLI alive across multiple prompts and renders the shell header before model output", async () => {
    const workspaceRoot = await createFixtureWorkspace("deep-mix-phase9-loop-");
    const harness = await createShell({
      workspaceRoot,
      permissionMode: "danger-full-access",
      modelClient: new ScriptedModelClient([
        { content: "First answer.", toolCalls: [] },
        { content: "Second answer.", toolCalls: [] },
      ]),
      inputValues: ["Second prompt", "/exit"],
    });

    await harness.shell.run({
      initialPrompt: "First prompt",
    });

    const sessionsIndex = await harness.sessionStore.loadSessionsIndex();
    expect(sessionsIndex.sessions).toHaveLength(1);
    expect(sessionsIndex.sessions[0]?.status).toBe("waiting_for_user");
    const sessionId = sessionsIndex.sessions[0]!.sessionId;
    const messages = await harness.sessionStore.loadMessages(sessionId);
    expect(messages.filter((message) => message.role === "user").map((message) => message.content)).toEqual([
      "First prompt",
      "Second prompt",
    ]);
    expect(harness.output.buffer.startsWith("Deep-Mix v1.0.0")).toBe(true);
    expect(harness.output.buffer.indexOf("Deep-Mix v1.0.0")).toBeLessThan(
      harness.output.buffer.indexOf("First answer."),
    );
    expect(harness.output.buffer).toContain("可继续输入。");
  }, 15000);

  it("completes approval inside the CLI and automatically replays the blocked prompt", async () => {
    const workspaceRoot = await createFixtureWorkspace("deep-mix-phase9-approval-");
    const harness = await createShell({
      workspaceRoot,
      permissionMode: "auto",
      modelClient: new ScriptedModelClient([
        {
          content: "",
          toolCalls: [
            {
              id: "tool-1",
              name: "run_shell",
              rawArguments: JSON.stringify({ command: "Write-Output 'approval-ok'" }),
              arguments: { command: "Write-Output 'approval-ok'" },
            },
          ],
        },
        {
          content: "Approval completed and the command was executed.",
          toolCalls: [],
        },
      ]),
      inputValues: ["1", "/exit"],
    });

    await harness.shell.run({
      initialPrompt: "Run a shell command and then summarize the result.",
    });

    const sessionsIndex = await harness.sessionStore.loadSessionsIndex();
    const sessionId = sessionsIndex.sessions[0]!.sessionId;
    const session = await harness.sessionStore.loadSession(sessionId);
    expect(session?.status).toBe("waiting_for_user");
    const events = await harness.sessionStore.loadEvents(sessionId);
    const approvals = events.filter((event) => event.recordType === "approval");
    expect(approvals.some((event) => event.status === "pending")).toBe(true);
    expect(approvals.some((event) => event.status === "resolved")).toBe(true);
    const userPrompts = (await harness.sessionStore.loadMessages(sessionId))
      .filter((message) => message.role === "user")
      .map((message) => message.content);
    expect(userPrompts).toEqual([
      "Run a shell command and then summarize the result.",
    ]);
    expect(harness.output.buffer).toContain("Approval required:");
    expect(harness.output.buffer).toContain("[approval] allow once recorded. Continuing the pending task.");
    expect(harness.output.buffer).toContain("Approval completed and the command was executed.");
  }, 15000);

  it("restores approval state through /resume and keeps /continue usable for waiting sessions", async () => {
    const workspaceRoot = await createFixtureWorkspace("deep-mix-phase9-resume-");
    const firstRuntime = new GovernorRuntime({
      workspaceRoot,
      permissionMode: "auto",
      modelClient: new ScriptedModelClient([
        {
          content: "",
          toolCalls: [
            {
              id: "tool-1",
              name: "run_shell",
              rawArguments: JSON.stringify({ command: "Write-Output 'resume-ok'" }),
              arguments: { command: "Write-Output 'resume-ok'" },
            },
          ],
        },
      ]),
    });

    let sessionId = "";
    try {
      await firstRuntime.runTurn({
        prompt: "Run the shell command and keep the session open.",
        callbacks: {
          onSessionSelected: (value) => {
            sessionId = value;
          },
        },
      });
    } catch (error) {
      expect(error).toBeInstanceOf(PermissionRequiredError);
    }

    const resumedHarness = await createShell({
      workspaceRoot,
      permissionMode: "auto",
      modelClient: new ScriptedModelClient([
        {
          content: "Resumed approval flow completed.",
          toolCalls: [],
        },
        {
          content: "Continued waiting session.",
          toolCalls: [],
        },
      ]),
      inputValues: ["1", "/continue", "Summarize the continued session.", "/exit"],
    });

    await resumedHarness.shell.run({
      resumeRequested: true,
      resumeSessionId: sessionId,
    });

    const session = await resumedHarness.sessionStore.loadSession(sessionId);
    expect(session?.status).toBe("waiting_for_user");
    const messages = await resumedHarness.sessionStore.loadMessages(sessionId);
    expect(messages.some((message) => message.content === "Summarize the continued session.")).toBe(true);
    expect(resumedHarness.output.buffer).toContain("The session is waiting for approval.");
    expect(resumedHarness.output.buffer).toContain("The session is ready for the next prompt.");
    expect(resumedHarness.output.buffer).toContain("Continued waiting session.");
  }, 15000);

  it("replays only unresolved calls from a partially completed tool batch after a process restart", async () => {
    const workspaceRoot = await createFixtureWorkspace("deep-mix-phase9-partial-resume-");
    await fs.writeFile(path.join(workspaceRoot, "sample.txt"), "already completed", "utf8");
    const originalBatches: Array<{ assistantMessageId: string; callIds: string[] }> = [];
    const firstRuntime = new GovernorRuntime({
      workspaceRoot,
      permissionMode: "auto",
      modelClient: new ScriptedModelClient([{
        content: "",
        toolCalls: [
          {
            id: "completed-read",
            name: "read_file",
            rawArguments: JSON.stringify({ path: "sample.txt" }),
            arguments: { path: "sample.txt" },
          },
          {
            id: "pending-shell",
            name: "run_shell",
            rawArguments: JSON.stringify({ command: "Write-Output 'partial-resume-ok'" }),
            arguments: { command: "Write-Output 'partial-resume-ok'" },
          },
        ],
      }]),
    });

    let sessionId = "";
    await expect(firstRuntime.runTurn({
      prompt: "Read the sample, then run the shell command.",
      callbacks: {
        onSessionSelected: (selected) => {
          sessionId = selected;
        },
        onToolBatchStart: (batch) => {
          originalBatches.push({
            assistantMessageId: batch.assistantMessageId,
            callIds: batch.toolCalls.map((toolCall) => toolCall.id),
          });
        },
      },
    })).rejects.toBeInstanceOf(PermissionRequiredError);
    await firstRuntime.dispose();

    const store = new SessionStore(workspaceRoot);
    const messagesBeforeResume = await store.loadMessages(sessionId);
    expect(messagesBeforeResume.some((message) =>
      message.role === "tool" && message.toolCallId === "completed-read"
    )).toBe(true);
    expect(messagesBeforeResume.some((message) =>
      message.role === "tool" && message.toolCallId === "pending-shell"
    )).toBe(false);
    const pendingApproval = [...await store.loadEvents(sessionId)].reverse().find(
      (event) => event.recordType === "approval" && event.status === "pending",
    );
    if (!pendingApproval || pendingApproval.recordType !== "approval") {
      throw new Error("Missing pending approval fixture.");
    }

    const resumedBatches: Array<{ assistantMessageId: string; callIds: string[] }> = [];
    const resumedStarts: string[] = [];
    const resumedEnds: string[] = [];
    const resumedRuntime = new GovernorRuntime({
      workspaceRoot,
      permissionMode: "auto",
      modelClient: new ScriptedModelClient([{
        content: "Only the pending command was resumed.",
        toolCalls: [],
      }]),
    });
    try {
      await resumedRuntime.initialize();
      await resumedRuntime.resolveApprovalRequest({
        sessionId,
        approvalId: pendingApproval.approvalId,
        toolName: pendingApproval.toolName,
        requestKey: pendingApproval.requestKey,
        persistence: "allow_once",
        reason: "Phase 9 partial batch resume regression.",
      });
      const result = await resumedRuntime.continuePendingTurn({
        sessionId,
        callbacks: {
          onToolBatchStart: (batch) => {
            resumedBatches.push({
              assistantMessageId: batch.assistantMessageId,
              callIds: batch.toolCalls.map((toolCall) => toolCall.id),
            });
          },
          onToolStart: (toolCall) => resumedStarts.push(toolCall.id),
          onToolEnd: (toolResult) => resumedEnds.push(toolResult.callId),
        },
      });

      expect(result.finalResponse).toBe("Only the pending command was resumed.");
      expect(originalBatches).toEqual([{
        assistantMessageId: expect.any(String),
        callIds: ["completed-read", "pending-shell"],
      }]);
      expect(resumedBatches).toEqual([{
        assistantMessageId: originalBatches[0]?.assistantMessageId,
        callIds: ["pending-shell"],
      }]);
      expect(resumedStarts).toEqual(["pending-shell"]);
      expect(resumedEnds).toEqual(["pending-shell"]);
    } finally {
      await resumedRuntime.dispose();
    }
  }, 15000);

  it("keeps the process alive through interrupt handling and allows the interrupted session to continue", async () => {
    const workspaceRoot = await createFixtureWorkspace("deep-mix-phase9-interrupt-");
    let releaseFirstTurn!: () => void;
    let markFirstTurnStarted!: () => void;
    const firstTurnGate = new Promise<void>((resolve) => {
      releaseFirstTurn = resolve;
    });
    const firstTurnStarted = new Promise<void>((resolve) => {
      markFirstTurnStarted = resolve;
    });
    const modelClient = new ScriptedModelClient([
      async (_request, callbacks) => {
        markFirstTurnStarted();
        await firstTurnGate;
        callbacks?.onTextDelta?.("Interrupted turn settled.");
        return {
          content: "Interrupted turn settled.",
          toolCalls: [],
        };
      },
      {
        content: "Recovered after interrupt.",
        toolCalls: [],
      },
    ]);
    const harness = await createShell({
      workspaceRoot,
      permissionMode: "danger-full-access",
      modelClient,
      inputValues: ["/continue", "Recover with a new prompt.", "/exit"],
    });

    const runPromise = harness.shell.run({
      initialPrompt: "Long running prompt.",
    });
    await firstTurnStarted;
    await harness.shell.requestInterrupt();
    releaseFirstTurn();
    await runPromise;

    const sessionsIndex = await harness.sessionStore.loadSessionsIndex();
    const sessionId = sessionsIndex.sessions[0]!.sessionId;
    const messages = await harness.sessionStore.loadMessages(sessionId);
    expect(messages.some((message) => message.content === "Recover with a new prompt.")).toBe(true);
    expect(harness.output.buffer).toContain("[state] interrupted | session");
    expect(harness.output.buffer).toContain("Recovered after interrupt.");
  });

  it("exits cleanly when interrupted while waiting for the next prompt", async () => {
    const workspaceRoot = await createFixtureWorkspace("deep-mix-phase9-safe-exit-");
    const sessionStore = new SessionStore(workspaceRoot);
    const runtime = new GovernorRuntime({
      workspaceRoot,
      permissionMode: "danger-full-access",
      modelClient: new ScriptedModelClient([]),
    });
    const input = new BlockingInput();
    const output = new BufferOutput();
    const shell = new CliSessionShell({
      runtime,
      sessionStore,
      input,
      output,
      workspaceRoot,
      permissionMode: "danger-full-access",
      getProfileStatus: () => readProfileStatus(workspaceRoot),
    });

    const runPromise = shell.run();
    await input.waitForRead();
    await shell.requestInterrupt();
    await runPromise;

    const safeExitMatches = output.buffer.match(/Safe exit requested\. Use \/resume to continue later\./g) ?? [];
    expect(safeExitMatches).toHaveLength(1);
  });

  it("aborts the active model request when interrupted", async () => {
    const workspaceRoot = await createFixtureWorkspace("deep-mix-phase9-abort-");
    let markStarted!: () => void;
    const started = new Promise<void>((resolve) => {
      markStarted = resolve;
    });
    let activeSignal: AbortSignal | undefined;
    const modelClient: ModelClient = {
      async streamCompletion(request) {
        activeSignal = request.signal;
        markStarted();
        return await new Promise<AssistantResponse>((_resolve, reject) => {
          const abort = () => {
            reject(request.signal?.reason instanceof Error ? request.signal.reason : new Error("aborted"));
          };
          if (request.signal?.aborted) {
            abort();
            return;
          }
          request.signal?.addEventListener("abort", abort, { once: true });
        });
      },
    };
    const harness = await createShell({
      workspaceRoot,
      permissionMode: "danger-full-access",
      modelClient,
      inputValues: ["/exit"],
    });

    const runPromise = harness.shell.run({
      initialPrompt: "Abort this long running turn.",
    });
    await started;
    await harness.shell.requestInterrupt();
    await runPromise;

    expect(activeSignal?.aborted).toBe(true);
    expect(harness.output.buffer).toContain("Interrupt requested. Stopping the current turn.");
    expect(harness.output.buffer).toContain("Interrupted. You can type a new prompt");
  });
});
