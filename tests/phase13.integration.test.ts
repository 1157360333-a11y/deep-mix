import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { CliSessionShell, type OutputWriter, type PromptReader, readProfileStatus } from "../apps/cli/src/session-shell.js";
import { createInitialTerminalTuiState, renderTerminalTui, stripAnsiForTest } from "../apps/cli/src/terminal-tui-renderer.js";
import { GovernorRuntime, PromptCompiler, validateMessageHistory } from "../packages/core-governor/src/index.js";
import { SessionStore } from "../packages/persistence/src/index.js";
import type {
  AssistantResponse,
  ContextBudgetRecord,
  ContextSummaryRecord,
  ConversationMessage,
  MessageRecord,
  ModelCompletionRequest,
  ModelClient,
  RuntimeCapabilitySnapshot,
  StreamCallbacks,
} from "../packages/shared-schema/src/index.js";

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

    const resolved = typeof response === "function" ? await response(request, callbacks) : response;
    for (const chunk of resolved.content) {
      callbacks?.onTextDelta?.(chunk);
    }
    return resolved;
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
  await fs.writeFile(
    path.join(workspaceRoot, "src", "huge-file.ts"),
    `export const hugeText = "${"A".repeat(24000)}";\nexport const secondLine = "still here";\n`,
    "utf8",
  );
  await fs.writeFile(
    path.join(workspaceRoot, "src", "small-file.ts"),
    'export const projectPurpose = "Deep-Mix runtime";\n',
    "utf8",
  );
  return workspaceRoot;
}

async function configureLargeContext(workspaceRoot: string): Promise<void> {
  await fs.writeFile(
    path.join(workspaceRoot, ".deep-mix", "settings.json"),
    JSON.stringify({
      governor: {
        contextWindow: 1_000_000,
        contextSoftLimitTokens: 900_000,
        contextCompactThresholdTokens: 800_000,
        contextReserveOutputTokens: 8_192,
        contextSummaryMaxTokens: 2_048,
        contextRecentTailMaxTokens: 400_000,
      },
    }, null, 2),
    "utf8",
  );
}

function createCapabilitySnapshot(): RuntimeCapabilitySnapshot {
  return {
    checkedAt: "2026-07-09T00:00:00.000Z",
    capabilities: {
      rg: {
        name: "rg",
        available: true,
        command: "rg.exe",
        version: "14.1.0",
        message: "available",
      },
      git: {
        name: "git",
        available: true,
        command: "git.exe",
        version: "git version 2.49.0.windows.1",
        message: "available",
      },
      powershell: {
        name: "powershell",
        available: true,
        command: "powershell.exe",
        version: "5.1.26100.1",
        message: "available",
      },
      node: {
        name: "node",
        available: true,
        command: "node.exe",
        version: "v22.18.0",
        message: "available",
      },
      npm: {
        name: "npm",
        available: true,
        command: "npm.cmd",
        version: "10.9.3",
        message: "available",
      },
    },
    fallbacks: {
      listFiles: "rg",
      searchFiles: "rg",
    },
  };
}

function createShortHistory(count: number): MessageRecord[] {
  return Array.from({ length: count }, (_, index) => ({
    recordType: "message",
    messageId: `m-${index}`,
    sessionId: "session-1",
    turnId: `turn-${Math.floor(index / 2)}`,
    role: index % 2 === 0 ? "user" : "assistant",
    createdAt: new Date(Date.UTC(2026, 6, 9, 0, 0, index)).toISOString(),
    content: `short message ${index}`,
  }));
}

function assertToolHistoryIsLegal(messages: ConversationMessage[]): void {
  const pendingToolCalls: string[] = [];
  for (const message of messages) {
    if (message.role === "assistant" && Array.isArray(message.tool_calls) && message.tool_calls.length > 0) {
      pendingToolCalls.push(...message.tool_calls.map((toolCall) => toolCall.id));
      continue;
    }
    if (message.role === "tool") {
      const expected = pendingToolCalls.shift();
      expect(message.tool_call_id).toBe(expected);
    }
  }
  expect(pendingToolCalls).toHaveLength(0);
}

function loadContextBudgetEvents(events: unknown[]): ContextBudgetRecord[] {
  return events.filter((event): event is ContextBudgetRecord => {
    return typeof event === "object" && event !== null && (event as { recordType?: string }).recordType === "context_budget";
  });
}

afterEach(async () => {
  await Promise.all(
    temporaryRoots.splice(0).map(async (root) => {
      await fs.rm(root, { recursive: true, force: true });
    }),
  );
});

describe("phase 13 token budget management and runtime observability", () => {
  it("keeps more than 12 short messages when the token budget allows it", async () => {
    const compiler = new PromptCompiler({
      model: "deepseek-chat",
      contextWindow: 128000,
      softLimitTokens: 96000,
      compactThresholdTokens: 84000,
      reserveOutputTokens: 8000,
      summaryMaxTokens: 2048,
      recentTailMaxTokens: 24000,
    });

    const compiled = await compiler.compile({
      workspaceRoot: process.cwd(),
      currentUserRequest: "Explain the last several steps.",
      planItems: [],
      toolDefinitions: [],
      recentMessages: createShortHistory(20),
      runtimeCapabilities: createCapabilitySnapshot(),
    });

    expect(compiled.truncatedMessages.length).toBeGreaterThan(12);
    expect(compiled.contextBudget.usedInputTokens).toBeLessThanOrEqual(compiled.contextBudget.inputBudgetTokens);
  });

  it("does not reserve or inject a legacy ordinary-tool summary when its raw result is present", async () => {
    const compiler = new PromptCompiler({
      model: "deepseek-chat",
      contextWindow: 128000,
      softLimitTokens: 96000,
      compactThresholdTokens: 84000,
      reserveOutputTokens: 8000,
      summaryMaxTokens: 2048,
      recentTailMaxTokens: 24000,
    });
    const messages: MessageRecord[] = [
      {
        recordType: "message",
        messageId: "ordinary-assistant",
        sessionId: "ordinary-session",
        turnId: "ordinary-turn",
        role: "assistant",
        createdAt: "2026-07-15T00:00:00.000Z",
        content: "",
        toolCalls: [{ id: "ordinary-list", name: "list_files", rawArguments: "{}", arguments: {} }],
      },
      {
        recordType: "message",
        messageId: "ordinary-tool",
        sessionId: "ordinary-session",
        turnId: "ordinary-turn",
        role: "tool",
        createdAt: "2026-07-15T00:00:01.000Z",
        content: "[list_files complete: returned 2 path(s)]\nsrc/a.ts\nsrc/b.ts",
        name: "list_files",
        toolCallId: "ordinary-list",
      },
      {
        recordType: "message",
        messageId: "ordinary-response",
        sessionId: "ordinary-session",
        turnId: "ordinary-turn",
        role: "assistant",
        createdAt: "2026-07-15T00:00:02.000Z",
        content: "Both paths were inspected.",
      },
    ];
    const summary: ContextSummaryRecord = {
      recordType: "context_summary",
      summaryId: "legacy-ordinary-summary",
      sessionId: "ordinary-session",
      turnId: "ordinary-turn",
      createdAt: "2026-07-15T00:00:01.500Z",
      sourceType: "tool_output",
      sourceToolName: "list_files",
      sourceMessageId: "ordinary-tool",
      sourceToolCallId: "ordinary-list",
      sourceRawChars: messages[1]!.content.length,
      summary: "LEGACY_LOSSY_SUMMARY_SHOULD_NOT_APPEAR",
      estimatedTokens: 12,
    };

    const compiled = await compiler.compile({
      workspaceRoot: process.cwd(),
      currentUserRequest: "Continue the audit.",
      planItems: [],
      toolDefinitions: [],
      recentMessages: messages,
      contextSummaries: [summary],
      runtimeCapabilities: createCapabilitySnapshot(),
    });

    expect(compiled.systemPrompt).not.toContain("LEGACY_LOSSY_SUMMARY_SHOULD_NOT_APPEAR");
    expect(compiled.truncatedMessages.find((message) => message.role === "tool")?.content).toContain("src/b.ts");
    expect(compiled.contextBudget.selectedSummaryCount).toBe(0);
    expect(compiled.contextBudget.categories.find((entry) => entry.key === "summaries")?.estimatedTokens).toBe(0);
    expect(compiled.contextBudget.toolOutputExposure).toMatchObject({
      rawMessageCount: 1,
      summarizedMessageCount: 0,
      budgetTruncatedMessageCount: 0,
    });
    expect(compiled.compaction.triggered).toBe(false);

    const compiledWithoutSource = await compiler.compile({
      workspaceRoot: process.cwd(),
      currentUserRequest: "Continue after older history was dropped.",
      planItems: [],
      toolDefinitions: [],
      recentMessages: [messages[2]!],
      contextSummaries: [summary],
      runtimeCapabilities: createCapabilitySnapshot(),
    });
    expect(compiledWithoutSource.systemPrompt).not.toContain("LEGACY_LOSSY_SUMMARY_SHOULD_NOT_APPEAR");
    expect(compiledWithoutSource.contextBudget.selectedSummaryCount).toBe(0);
  });

  it("persists before/after context budget snapshots and provider usage on a normal turn", async () => {
    const workspaceRoot = await createFixtureWorkspace("deep-mix-phase13-usage-");
    const sessionStore = new SessionStore(workspaceRoot);
    const runtime = new GovernorRuntime({
      workspaceRoot,
      permissionMode: "danger-full-access",
      modelClient: new ScriptedModelClient([
        {
          content: "This repository hosts the Deep-Mix runtime.",
          toolCalls: [],
          usage: {
            source: "provider_exact",
            recordedAt: "2026-07-09T00:00:01.000Z",
            inputTokens: 321,
            outputTokens: 45,
            reasoningTokens: 18,
            totalTokens: 366,
          },
        },
      ]),
    });

    const result = await runtime.runTurn({
      prompt: "What is this repository for?",
    });

    const session = await sessionStore.loadSession(result.sessionId);
    expect(session?.latestTokenUsage?.source).toBe("provider_exact");
    expect(session?.latestTokenUsage?.totalTokens).toBe(366);
    expect(session?.cumulativeTokenUsage?.totalTokens).toBe(366);
    expect(session?.latestContextBudget?.usedInputTokens).toBeGreaterThan(0);
    expect(session?.latestTaskDuration?.durationMs).toBeGreaterThanOrEqual(0);

    const events = await sessionStore.loadEvents(result.sessionId);
    const budgetEvents = loadContextBudgetEvents(events);
    expect(budgetEvents.map((event) => event.scope)).toEqual(["before_model", "after_model"]);
  });

  it("exposes high-volume tool output as raw text once, then promotes its summary after a durable response", async () => {
    const workspaceRoot = await createFixtureWorkspace("deep-mix-phase13-summary-");
    await configureLargeContext(workspaceRoot);
    const longLines = Array.from({ length: 12_000 }, (_, index) =>
      index === 10_999
        ? `export const REMOTE_SENTINEL_AFTER_333 = "line-${index + 1}";`
        : `export const value_${index + 1} = "${"P".repeat(48)}";`);
    await fs.writeFile(path.join(workspaceRoot, "src", "huge-file.ts"), longLines.join("\n"), "utf8");
    const sessionStore = new SessionStore(workspaceRoot);
    await sessionStore.ensureInitialized();
    const observedSystemPrompts: string[] = [];
    const runtime = new GovernorRuntime({
      workspaceRoot,
      permissionMode: "danger-full-access",
      modelClient: new ScriptedModelClient([
        async (request) => {
          observedSystemPrompts.push(request.systemPrompt);
          return {
            content: "",
            toolCalls: [
            {
              id: "tool-read",
              name: "read_file",
              rawArguments: JSON.stringify({ path: "src/huge-file.ts" }),
              arguments: { path: "src/huge-file.ts" },
            },
            ],
          };
        },
        async (request) => {
          observedSystemPrompts.push(request.systemPrompt);
          assertToolHistoryIsLegal(request.messages);
          const toolMessages = request.messages.filter((message) => message.role === "tool");
          expect(toolMessages).toHaveLength(1);
          expect(toolMessages[0]?.content ?? "").toContain("REMOTE_SENTINEL_AFTER_333");
          expect(toolMessages[0]?.content ?? "").not.toContain("[summary source=");
          return {
            content: "",
            toolCalls: [
              {
                id: "tool-read-small",
                name: "read_file",
                rawArguments: JSON.stringify({ path: "src/small-file.ts" }),
                arguments: { path: "src/small-file.ts" },
              },
            ],
          };
        },
        async (request) => {
          observedSystemPrompts.push(request.systemPrompt);
          assertToolHistoryIsLegal(request.messages);
          const toolMessages = request.messages.filter((message) => message.role === "tool");
          expect(toolMessages).toHaveLength(2);
          expect(toolMessages[0]?.content ?? "").toContain("[summary source=read_file");
          expect(toolMessages[0]?.content ?? "").not.toContain("REMOTE_SENTINEL_AFTER_333");
          expect(toolMessages[1]?.content ?? "").toContain("Deep-Mix runtime");
          expect(toolMessages[1]?.content ?? "").not.toContain("[summary source=");
          return {
            content: "The first long read was consumed in full before later summary substitution.",
            toolCalls: [],
          };
        },
      ]),
    });

    const result = await runtime.runTurn({
      prompt: "Inspect src/huge-file.ts and explain how the runtime manages context.",
    });

    expect(result.session.status).toBe("waiting_for_user");
    expect(new Set(observedSystemPrompts).size).toBe(1);
    const persistedMessages = await sessionStore.loadMessages(result.sessionId);
    expect(persistedMessages.filter((message) => message.metadata?.providerTurnContext)).toHaveLength(1);
    expect(persistedMessages.find((message) => message.toolCallId === "tool-read")?.content)
      .toContain("REMOTE_SENTINEL_AFTER_333");
    const events = await sessionStore.loadEvents(result.sessionId);
    const longToolMessageIndex = events.findIndex(
      (event) => event.recordType === "message" && event.role === "tool" && event.toolCallId === "tool-read",
    );
    const acknowledgingAssistantIndex = events.findIndex(
      (event) => event.recordType === "message" && event.role === "assistant" &&
        event.toolCalls?.some((toolCall) => toolCall.id === "tool-read-small"),
    );
    const promotedSummaryIndex = events.findIndex(
      (event): event is ContextSummaryRecord =>
        event.recordType === "context_summary" && event.sourceToolCallId === "tool-read",
    );
    expect(longToolMessageIndex).toBeGreaterThanOrEqual(0);
    expect(acknowledgingAssistantIndex).toBeGreaterThan(longToolMessageIndex);
    expect(promotedSummaryIndex).toBeGreaterThan(acknowledgingAssistantIndex);
    const promotedSummary = events[promotedSummaryIndex] as ContextSummaryRecord;
    expect(promotedSummary.sourceRawChars).toBeGreaterThan(500_000);

    const budgetEvents = loadContextBudgetEvents(events);
    expect(budgetEvents.some((event) =>
      event.scope === "before_model" &&
      event.snapshot.toolOutputExposure?.rawMessageCount === 1 &&
      event.snapshot.toolOutputExposure.summarizedMessageCount === 0)).toBe(true);
    expect(budgetEvents.some((event) =>
      event.scope === "before_model" &&
      event.snapshot.toolOutputExposure?.rawMessageCount === 1 &&
      event.snapshot.toolOutputExposure.summarizedMessageCount === 1)).toBe(true);
    expect(budgetEvents.every((event) => !event.compaction?.triggered || event.compaction.tokensSaved > 0)).toBe(true);
  });

  it("retains bounded file-discovery evidence verbatim across later Provider cycles", async () => {
    const workspaceRoot = await createFixtureWorkspace("deep-mix-phase13-discovery-evidence-");
    const staticJs = path.join(workspaceRoot, "static", "js");
    await fs.mkdir(staticJs, { recursive: true });
    const files = [
      "analysis_ai.js",
      "bootstrap.bundle.min.js",
      "composite_index.js",
      "data_processing.js",
      "docs_deeplink.js",
      "docs_links.js",
      "docs_manifest.js",
      "export.js",
      "FileSaver.min.js",
      "history.js",
      "html-docx.js",
      "import_merge.js",
      "sample_ops.js",
      "product_feedback.js",
      "theme-switcher.js",
      "variable_gen.js",
      "variable_ops.js",
      "xlsx.full.min.js",
    ];
    await Promise.all(files.map((fileName) => fs.writeFile(
      path.join(staticJs, fileName),
      fileName === "theme-switcher.js" ? "theme code\n" : `${fileName} code\n`,
      "utf8",
    )));
    const sessionStore = new SessionStore(workspaceRoot);
    const runtime = new GovernorRuntime({
      workspaceRoot,
      permissionMode: "danger-full-access",
      modelClient: new ScriptedModelClient([
        {
          content: "",
          toolCalls: [{
            id: "discovery-list",
            name: "list_files",
            rawArguments: JSON.stringify({ cwd: "static/js", maxDepth: 1, maxResults: 30 }),
            arguments: { cwd: "static/js", maxDepth: 1, maxResults: 30 },
          }],
        },
        async (request) => {
          const listing = request.messages.find((message) => message.role === "tool" && message.tool_call_id === "discovery-list");
          expect(listing?.content).toContain("[list_files complete:");
          expect(listing?.content).toContain("html-docx.js");
          expect(listing?.content).toContain("theme-switcher.js");
          expect(listing?.content).not.toContain("[summary source=");
          return {
            content: "",
            toolCalls: [{
              id: "discovery-content-search",
              name: "search_files",
              rawArguments: JSON.stringify({
                cwd: ".",
                glob: "theme-switcher*",
                pattern: "CONTENT_THAT_IS_NOT_PRESENT",
                maxResults: 10,
              }),
              arguments: {
                cwd: ".",
                glob: "theme-switcher*",
                pattern: "CONTENT_THAT_IS_NOT_PRESENT",
                maxResults: 10,
              },
            }],
          };
        },
        async (request) => {
          const listing = request.messages.find((message) => message.role === "tool" && message.tool_call_id === "discovery-list");
          const contentSearch = request.messages.find((message) =>
            message.role === "tool" && message.tool_call_id === "discovery-content-search");
          expect(listing?.content).toContain("html-docx.js");
          expect(listing?.content).toContain("theme-switcher.js");
          expect(listing?.content).not.toContain("[summary source=");
          expect(contentSearch?.content).toContain("Zero content matches do not prove that a file path is absent");
          expect(contentSearch?.content).not.toContain("[summary source=");
          return { content: "Both files exist in the complete static/js listing.", toolCalls: [] };
        },
      ]),
    });

    const result = await runtime.runTurn({
      prompt: "Verify whether static/js/html-docx.js and static/js/theme-switcher.js exist. Do not infer path absence from content search.",
    });
    expect(result.finalResponse).toContain("Both files exist");
    const events = await sessionStore.loadEvents(result.sessionId);
    expect(events.some((event) =>
      event.recordType === "context_summary" &&
      ["discovery-list", "discovery-content-search"].includes(event.sourceToolCallId ?? ""))).toBe(false);
  });

  it("keeps an unacknowledged raw tool result visible after a Provider failure and session resume", async () => {
    const workspaceRoot = await createFixtureWorkspace("deep-mix-phase13-provider-retry-");
    const sessionStore = new SessionStore(workspaceRoot);
    const runtime = new GovernorRuntime({
      workspaceRoot,
      permissionMode: "danger-full-access",
      modelClient: new ScriptedModelClient([
        {
          content: "",
          toolCalls: [{
            id: "retry-read",
            name: "read_file",
            rawArguments: JSON.stringify({ path: "src/huge-file.ts" }),
            arguments: { path: "src/huge-file.ts" },
          }],
        },
        async (request) => {
          const toolMessage = request.messages.find((message) => message.role === "tool");
          expect(toolMessage?.content).toContain("still here");
          expect(toolMessage?.content).not.toContain("[summary source=");
          throw new Error("simulated Provider transport failure");
        },
        async (request) => {
          const toolMessage = request.messages.find((message) => message.role === "tool");
          expect(toolMessage?.content).toContain("still here");
          expect(toolMessage?.content).not.toContain("[summary source=");
          return { content: "The resumed model call received the original tool output.", toolCalls: [] };
        },
      ]),
    });
    let sessionId = "";

    await expect(runtime.runTurn({
      prompt: "Read the large file before answering.",
      callbacks: { onSessionSelected: (selected) => { sessionId = selected; } },
    })).rejects.toThrow("simulated Provider transport failure");
    expect(sessionId).not.toBe("");
    expect((await sessionStore.loadEvents(sessionId)).some(
      (event) => event.recordType === "context_summary" && event.sourceToolCallId === "retry-read",
    )).toBe(false);

    const resumed = await runtime.runTurn({
      sessionId,
      prompt: "Resume and answer from the tool result.",
    });
    expect(resumed.finalResponse).toContain("original tool output");
    expect((await sessionStore.loadEvents(sessionId)).some(
      (event) => event.recordType === "context_summary" && event.sourceToolCallId === "retry-read",
    )).toBe(true);
  });

  it("summarizes the actual returned read_file range instead of the requested end line", async () => {
    const workspaceRoot = await createFixtureWorkspace("deep-mix-phase13-read-range-");
    await configureLargeContext(workspaceRoot);
    const source = Array.from({ length: 12_000 }, (_, index) =>
      `line-${String(index + 1).padStart(5, "0")} ${"payload".repeat(8)}`).join("\n");
    await fs.writeFile(path.join(workspaceRoot, "src", "range.ts"), source, "utf8");
    const sessionStore = new SessionStore(workspaceRoot);
    const runtime = new GovernorRuntime({
      workspaceRoot,
      permissionMode: "danger-full-access",
      modelClient: new ScriptedModelClient([
        {
          content: "",
          toolCalls: [{
            id: "range-read",
            name: "read_file",
            rawArguments: JSON.stringify({ path: "src/range.ts", startLine: 1, endLine: 12_000, maxChars: 500_001 }),
            arguments: { path: "src/range.ts", startLine: 1, endLine: 12_000, maxChars: 500_001 },
          }],
        },
        async (request) => {
          const toolMessage = request.messages.find((message) => message.role === "tool");
          expect(toolMessage?.content).toContain("[read_file truncated:");
          expect(toolMessage?.content).toContain("nextStartLine=");
          expect(toolMessage?.content).not.toContain("[summary source=");
          return { content: "The bounded range was consumed.", toolCalls: [] };
        },
      ]),
    });

    const result = await runtime.runTurn({ prompt: "Read the requested range and report what was actually returned." });
    const summary = (await sessionStore.loadEvents(result.sessionId)).find(
      (event): event is ContextSummaryRecord =>
        event.recordType === "context_summary" && event.sourceToolCallId === "range-read",
    );
    expect(summary?.summary).toMatch(/returned lines 1-\d+/u);
    expect(summary?.summary).not.toContain("returned lines 1-12000");
    expect(summary?.summary).toContain("totalLines=12000");
    expect(summary?.summary).toContain("nextStartLine=");
    expect(summary?.sourceRawChars).toBeGreaterThan(500_000);
  });

  it("renders a concise /context view and prints the final task duration hint", async () => {
    const workspaceRoot = await createFixtureWorkspace("deep-mix-phase13-context-command-");
    const sessionStore = new SessionStore(workspaceRoot);
    const runtime = new GovernorRuntime({
      workspaceRoot,
      permissionMode: "danger-full-access",
      modelClient: new ScriptedModelClient([
        {
          content: "The repository implements a multi-model agent runtime.",
          toolCalls: [],
          usage: {
            source: "provider_exact",
            recordedAt: "2026-07-09T00:00:02.000Z",
            inputTokens: 280,
            outputTokens: 36,
            reasoningTokens: 12,
            totalTokens: 316,
          },
        },
      ]),
    });
    const input = new ScriptedInput(["/context", "/exit"]);
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
      initialPrompt: "Summarize this repository.",
    });

    expect(output.buffer).toContain("已处理");
    expect(output.buffer).toContain("Current request:");
    expect(output.buffer).toContain("Last model call:");
    expect(output.buffer).toContain("Session total:");
    expect(output.buffer).toContain("Compaction:");
    expect(output.buffer).toContain("Tool outputs:");
    expect(output.buffer).toContain("Duration:");
    expect(output.buffer.split(/\r?\n/).filter(Boolean).length).toBeLessThan(60);
  });

  it("shows context occupancy and duration in the TUI header without overwhelming the first screen", () => {
    const state = createInitialTerminalTuiState();
    state.header = {
      version: "1.0.0",
      workspaceRoot: "C:\\workspace\\deep-mix",
      permissionMode: "auto",
      profiles: {
        deepseek_governor: { exists: true, hasKey: true },
        glm_coding_worker: { exists: true, hasKey: true },
        kimi_vision: { exists: true, hasKey: true },
      },
      capabilities: createCapabilitySnapshot(),
    };
    state.cliState = "running_turn";
    state.sessionId = "session-12345678";
    state.sessionStatus = "running";
    state.routeSummary = "Automatic routing";
    state.latestContextBudget = {
      source: "local_estimated",
      model: "deepseek-chat",
      recordedAt: "2026-07-09T00:00:03.000Z",
      contextWindowTokens: 128000,
      inputBudgetTokens: 96000,
      softLimitTokens: 96000,
      compactThresholdTokens: 84000,
      reserveOutputTokens: 8000,
      usedInputTokens: 18420,
      remainingInputTokens: 77580,
      usagePercent: 19.2,
      selectedMessageCount: 14,
      selectedSummaryCount: 2,
      categories: [
        { key: "system_prompt", label: "system prompt", estimatedTokens: 4800 },
        { key: "tools", label: "tools", estimatedTokens: 2400 },
        { key: "skills_workflows_mcp", label: "skills+workflows+MCP", estimatedTokens: 3000 },
        { key: "recent_messages", label: "recent messages", estimatedTokens: 6200 },
        { key: "summaries", label: "summaries", estimatedTokens: 2020 },
        { key: "free", label: "free", estimatedTokens: 77580 },
      ],
    };
    state.latestTaskDuration = {
      startedAt: new Date(Date.now() - 65_000).toISOString(),
      status: "running",
    };
    state.latestCompaction = {
      createdAt: "2026-07-09T00:00:03.000Z",
      source: "local_estimated",
      triggered: true,
      triggerReason: "estimated history exceeded compaction threshold",
      beforeTokens: 24100,
      afterTokens: 18420,
      tokensSaved: 5680,
      droppedMessageCount: 6,
      summaryCount: 2,
      retained: ["recent messages=14", "summary refs=abc12345, def67890"],
      summaryRefs: ["abc12345", "def67890"],
    };

    const frame = renderTerminalTui(state, { columns: 140, rows: 30 });
    const rendered = stripAnsiForTest(frame.output);

    expect(rendered).toContain("context 19.2%");
    expect(rendered).toContain("left 78k");
    expect(rendered).toContain("compact 5.7k");
    expect(rendered).toContain("elapsed 1m 5s");
  });
});
