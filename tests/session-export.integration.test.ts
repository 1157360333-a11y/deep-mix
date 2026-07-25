import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { CliSessionShell, type OutputWriter, type PromptReader, readProfileStatus } from "../apps/cli/src/session-shell.js";
import { GovernorRuntime } from "../packages/core-governor/src/index.js";
import { SessionStore } from "../packages/persistence/src/index.js";
import {
  createCodingWorkerRouteProfile,
  createGovernorRouteProfile,
} from "../packages/route-resolver/src/index.js";
import type {
  AssistantResponse,
  ModelCompletionRequest,
  StreamCallbacks,
} from "../packages/shared-schema/src/index.js";

class ScriptedModelClient {
  private index = 0;

  public constructor(private readonly responses: AssistantResponse[]) {}

  public async streamCompletion(
    _request: ModelCompletionRequest,
    callbacks?: StreamCallbacks,
  ): Promise<AssistantResponse> {
    const response = this.responses[this.index];
    if (!response) {
      throw new Error(`Unexpected model call index ${this.index}`);
    }
    this.index += 1;
    for (const chunk of response.content) {
      callbacks?.onTextDelta?.(chunk);
    }
    return response;
  }
}

class ScriptedInput implements PromptReader {
  private index = 0;

  public constructor(private readonly values: Array<string | undefined>) {}

  public async read(): Promise<string | undefined> {
    if (this.index >= this.values.length) {
      return undefined;
    }
    const value = this.values[this.index];
    this.index += 1;
    return value;
  }

  public close(): void {}
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
  await fs.mkdir(path.join(workspaceRoot, "src"), { recursive: true });
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
        },
      },
      null,
      2,
    ),
    "utf8",
  );
  await fs.writeFile(path.join(workspaceRoot, "src", "sample.ts"), "export const sample = 1;\n", "utf8");
  return workspaceRoot;
}

afterEach(async () => {
  await Promise.all(
    temporaryRoots.splice(0).map(async (root) => {
      await fs.rm(root, { recursive: true, force: true });
    }),
  );
});

describe("session markdown export", () => {
  it("exports a session with transcript, context telemetry, worker details, and patch payloads", async () => {
    const workspaceRoot = await createFixtureWorkspace("deep-mix-export-store-");
    const sessionStore = new SessionStore(workspaceRoot);
    await sessionStore.ensureInitialized();
    const session = await sessionStore.createSession("导出当前调试会话");
    const turn = await sessionStore.startTurn({
      sessionId: session.sessionId,
      requestSummary: "请读取 sample.ts 然后总结。",
      userMessageId: "pending",
    });
    const userMessage = await sessionStore.appendMessage({
      sessionId: session.sessionId,
      turnId: turn.turnId,
      role: "user",
      content: "请读取 sample.ts 然后总结。",
    });
    const assistantMessage = await sessionStore.appendMessage({
      sessionId: session.sessionId,
      turnId: turn.turnId,
      role: "assistant",
      content: "",
      toolCalls: [
        {
          id: "tool-read",
          name: "read_file",
          rawArguments: JSON.stringify({ path: "src/sample.ts" }),
          arguments: { path: "src/sample.ts" },
        },
      ],
      reasoningContent: "先读取目标文件，再形成总结。",
    });
    await sessionStore.appendMessage({
      sessionId: session.sessionId,
      turnId: turn.turnId,
      role: "tool",
      name: "read_file",
      toolCallId: "tool-read",
      content: "1 | export const sample = 1;",
      metadata: {
        success: true,
      },
    });
    await sessionStore.appendEvent(session.sessionId, {
      recordType: "context_summary",
      summaryId: "summary-1",
      sessionId: session.sessionId,
      turnId: turn.turnId,
      createdAt: new Date().toISOString(),
      sourceType: "tool_output",
      sourceToolName: "read_file",
      sourceMessageId: assistantMessage.messageId,
      sourceToolCallId: "tool-read",
      summary: "read src/sample.ts and kept the key export line",
      estimatedTokens: 24,
      keyPaths: ["src/sample.ts"],
      keyFiles: ["src/sample.ts"],
      rawOutputRef: "message://tool-read",
    });
    await sessionStore.appendEvent(session.sessionId, {
      recordType: "context_budget",
      sessionId: session.sessionId,
      turnId: turn.turnId,
      createdAt: new Date().toISOString(),
      scope: "after_model",
      snapshot: {
        source: "local_estimated",
        model: "deepseek-chat",
        recordedAt: new Date().toISOString(),
        contextWindowTokens: 128000,
        inputBudgetTokens: 120000,
        softLimitTokens: 120000,
        compactThresholdTokens: 100000,
        reserveOutputTokens: 8000,
        usedInputTokens: 4200,
        remainingInputTokens: 115800,
        usagePercent: 3.5,
        selectedMessageCount: 3,
        selectedSummaryCount: 1,
        categories: [
          { key: "system_prompt", label: "system prompt", estimatedTokens: 1000 },
          { key: "tools", label: "tools", estimatedTokens: 500 },
          { key: "skills_workflows_mcp", label: "skills+workflows+MCP", estimatedTokens: 300 },
          { key: "recent_messages", label: "recent messages", estimatedTokens: 2100 },
          { key: "summaries", label: "summaries", estimatedTokens: 300 },
          { key: "free", label: "free", estimatedTokens: 115800 },
        ],
      },
      usage: {
        source: "provider_exact",
        model: "deepseek-chat",
        recordedAt: new Date().toISOString(),
        inputTokens: 4200,
        outputTokens: 180,
        reasoningTokens: 40,
        totalTokens: 4380,
      },
      compaction: {
        createdAt: new Date().toISOString(),
        source: "local_estimated",
        triggered: true,
        triggerReason: "summary substitution applied",
        beforeTokens: 4600,
        afterTokens: 4200,
        tokensSaved: 400,
        droppedMessageCount: 0,
        summaryCount: 1,
        retained: ["recent messages=3", "summary refs=summary-1"],
        summaryRefs: ["summary-1"],
      },
    });
    await sessionStore.finishTurn({
      sessionId: session.sessionId,
      turnId: turn.turnId,
      startedAt: turn.startedAt,
      requestSummary: "请读取 sample.ts 然后总结。",
      userMessageId: userMessage.messageId,
      assistantMessageId: assistantMessage.messageId,
      toolCallIds: ["tool-read"],
      status: "waiting_for_user",
    });

    const workerSession = await sessionStore.createWorkerSession({
      parentSessionId: session.sessionId,
      task: {
        workerType: "coding",
        objective: "实现一个最小补丁示例",
        constraints: ["只返回 patch artifact"],
        contextRefs: [{ refType: "summary", label: "User request", summary: "need a tiny sample patch" }],
        expectedOutput: "code_artifact",
        acceptanceChecks: ["artifact returned"],
      },
      route: createCodingWorkerRouteProfile({
        apiKey: "fake-key",
        baseUrl: "https://example.invalid",
        endpointPath: "/chat/completions",
        model: "glm-5.2",
        role: "coding_worker",
        contextWindow: 128000,
        maxRetries: 1,
        timeoutMs: 180000,
        temperature: 0.1,
        maxContextChars: 24000,
        maxContextFiles: 6,
        headers: { "Content-Type": "application/json" },
        requestDefaults: {},
        workspaceWriteAccess: false,
      }),
      timeoutMs: 180000,
      maxRetries: 1,
    });
    await sessionStore.appendWorkerMessage({
      workerSessionId: workerSession.workerSessionId,
      role: "assistant",
      content: "已生成最小 patch artifact。",
    });
    await sessionStore.storeCodeArtifact({
      workerSessionId: workerSession.workerSessionId,
      artifact: {
        kind: "code_artifact",
        summary: "Change sample constant to 2.",
        changedFiles: ["src/sample.ts"],
        testCommands: ["npm run check"],
        risks: ["sample output changes"],
        confidence: 0.88,
        notes: ["for export test"],
        metadata: { source: "test" },
      },
      patchContent: [
        "*** Begin Patch",
        "*** Update File: src/sample.ts",
        "@@",
        "-export const sample = 1;",
        "+export const sample = 2;",
        "*** End Patch",
      ].join("\n"),
    });

    const explicitPath = path.join(workspaceRoot, "exports", "session-export.md");
    const exported = await sessionStore.exportSessionMarkdown({
      sessionId: session.sessionId,
      outputPath: explicitPath,
    });

    expect(exported.outputPath).toBe(explicitPath);
    const content = await fs.readFile(explicitPath, "utf8");
    expect(content).toContain("# Deep-Mix Session Export");
    expect(content).toContain("## Transcript");
    expect(content).toContain("## Event Timeline");
    expect(content).toContain("## Worker Sessions");
    expect(content).toContain("## Context Budget Records");
    expect(content).toContain("请读取 sample.ts 然后总结。");
    expect(content).not.toContain("先读取目标文件，再形成总结。");
    expect(content).not.toContain("#### Reasoning");
    expect(content).toContain("read_file");
    expect(content).toContain("provider_exact");
    expect(content).toContain("summary substitution applied");
    expect(content).toContain("已生成最小 patch artifact。");
    expect(content).toContain("*** Begin Patch");
  });

  it("exports the current session from the CLI /export command", async () => {
    const workspaceRoot = await createFixtureWorkspace("deep-mix-export-cli-");
    const sessionStore = new SessionStore(workspaceRoot);
    const runtime = new GovernorRuntime({
      workspaceRoot,
      permissionMode: "danger-full-access",
      modelClient: new ScriptedModelClient([
        {
          content: "这是一个用于测试导出的会话。",
          toolCalls: [],
        },
      ]),
    });
    const outputPath = "exports/current-session.md";
    const input = new ScriptedInput([`/export ${outputPath}`, "/exit"]);
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

    await shell.run({
      initialPrompt: "请回答一句话，然后我导出当前会话。",
    });

    const absoluteOutputPath = path.join(workspaceRoot, outputPath);
    const markdown = await fs.readFile(absoluteOutputPath, "utf8");
    expect(output.buffer).toContain("Exported current session to:");
    expect(markdown).toContain("请回答一句话，然后我导出当前会话。");
    expect(markdown).toContain("这是一个用于测试导出的会话。");
    expect(markdown).toContain("## Raw Session Events JSON");
  }, 15000);
});
