import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { CliSessionShell, type OutputWriter, type PromptReader, readProfileStatus } from "../apps/cli/src/session-shell.js";
import {
  GovernorRuntime,
  isPostExposureToolSummaryEligible,
  POST_EXPOSURE_SUMMARY_TOOL_NAMES,
  prepareMessagesForModel,
  PROVIDER_TURN_CONTEXT_METADATA_KEY,
  ProviderRequestError,
  TOOL_OUTPUT_SUMMARY_MIN_CHARS,
  validateMessageHistory,
} from "../packages/core-governor/src/index.js";
import { SessionStore } from "../packages/persistence/src/index.js";
import type {
  AssistantResponse,
  ContextSummaryRecord,
  ConversationMessage,
  HistoryIntegrityRecord,
  MessageRecord,
  ModelCompletionRequest,
  ModelClient,
  StreamCallbacks,
} from "../packages/shared-schema/src/index.js";
import { ToolRuntime } from "../packages/tool-runtime/src/index.js";

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

class ThrowingModelClient implements ModelClient {
  public constructor(private readonly error: Error) {}

  public async streamCompletion(): Promise<AssistantResponse> {
    throw this.error;
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
    `export const hugeText = "${"A".repeat(16000)}";\n`,
    "utf8",
  );
  await fs.writeFile(path.join(workspaceRoot, "src", "small-file.ts"), "export const small = 1;\n", "utf8");
  return workspaceRoot;
}

function assertToolHistoryIsLegal(messages: ConversationMessage[]): void {
  let expectedToolCallIds: string[] | undefined;
  let nextToolIndex = 0;

  for (const message of messages) {
    if (!expectedToolCallIds) {
      expect(message.role).not.toBe("tool");
      if (message.role === "assistant" && Array.isArray(message.tool_calls) && message.tool_calls.length > 0) {
        expectedToolCallIds = message.tool_calls.map((toolCall) => toolCall.id);
        nextToolIndex = 0;
      }
      continue;
    }

    expect(message.role).toBe("tool");
    expect(message.tool_call_id).toBe(expectedToolCallIds[nextToolIndex]);
    nextToolIndex += 1;
    if (nextToolIndex === expectedToolCallIds.length) {
      expectedToolCallIds = undefined;
    }
  }

  expect(expectedToolCallIds).toBeUndefined();
}

function loadHistoryIntegrityEvents(events: Awaited<ReturnType<SessionStore["loadEvents"]>>): HistoryIntegrityRecord[] {
  return events.filter((event): event is HistoryIntegrityRecord => event.recordType === "history_integrity");
}

async function loadBaselineMessages(): Promise<{
  providerError: string;
  failureChain: string[];
  messages: MessageRecord[];
}> {
  const fixturePath = path.join(process.cwd(), "tests", "fixtures", "phase11", "invalid-history-baseline.json");
  const raw = await fs.readFile(fixturePath, "utf8");
  return JSON.parse(raw) as {
    providerError: string;
    failureChain: string[];
    messages: MessageRecord[];
  };
}

async function appendCompletedTurn(
  sessionStore: SessionStore,
  sessionId: string,
  prompt: string,
  assistantContent: string,
): Promise<void> {
  const turn = await sessionStore.startTurn({
    sessionId,
    requestSummary: prompt,
    userMessageId: "pending",
  });
  const userMessage = await sessionStore.appendMessage({
    sessionId,
    turnId: turn.turnId,
    role: "user",
    content: prompt,
  });
  const assistantMessage = await sessionStore.appendMessage({
    sessionId,
    turnId: turn.turnId,
    role: "assistant",
    content: assistantContent,
  });
  await sessionStore.finishTurn({
    sessionId,
    turnId: turn.turnId,
    startedAt: turn.startedAt,
    requestSummary: prompt,
    userMessageId: userMessage.messageId,
    assistantMessageId: assistantMessage.messageId,
    toolCallIds: [],
    status: "waiting_for_user",
  });
  await sessionStore.setSessionStatus(sessionId, "waiting_for_user");
}

afterEach(async () => {
  await Promise.all(
    temporaryRoots.splice(0).map(async (root) => {
      await fs.rm(root, { recursive: true, force: true });
    }),
  );
});

describe("phase 11 message history legality and tool-call integrity", () => {
  it("freezes the provider 400 baseline fixture and drops oversized tool groups atomically", async () => {
    const baseline = await loadBaselineMessages();

    expect(baseline.providerError).toBe("Messages with role 'tool' must be a response to a preceding message with 'tool_calls'");
    expect(baseline.failureChain).toEqual([
      "assistant message with tool_calls",
      "multiple tool messages",
      "long tool output forces history truncation",
      "continuing the same failed session reuses broken history",
    ]);

    const prepared = prepareMessagesForModel(baseline.messages, {
      maxMessages: 4,
      maxChars: 240,
    });

    expect(validateMessageHistory(prepared.messages).valid).toBe(true);
    expect(prepared.messages.some((message) => message.role === "tool")).toBe(false);
    expect(prepared.report.actions.some((action) => action.type === "drop_tool_group_for_budget")).toBe(true);
  });

  it("pins only the newest turn-start context so older snapshots cannot crowd out the current request", () => {
    const message = (
      messageId: string,
      turnId: string,
      role: MessageRecord["role"],
      content: string,
      turnContext = false,
    ): MessageRecord => ({
      recordType: "message",
      messageId,
      sessionId: "turn-context-session",
      turnId,
      role,
      createdAt: `2026-07-16T00:00:0${messageId.length % 9}.000Z`,
      content,
      metadata: turnContext
        ? { [PROVIDER_TURN_CONTEXT_METADATA_KEY]: { version: 1 } }
        : undefined,
    });
    const prepared = prepareMessagesForModel([
      message("old-context", "turn-1", "system", "OLD_TURN_CONTEXT", true),
      message("old-response", "turn-1", "assistant", "old response"),
      message("current-request", "turn-2", "user", "CURRENT_USER_REQUEST"),
      message("current-context", "turn-2", "system", "CURRENT_TURN_CONTEXT", true),
    ], {
      tokenBudget: 10_000,
      maxMessages: 2,
    });

    expect(prepared.messages.map((entry) => entry.content)).toEqual([
      "CURRENT_USER_REQUEST",
      "CURRENT_TURN_CONTEXT",
    ]);
  });

  it("keeps a legacy small tool result raw even after a later assistant response", () => {
    const assistant: MessageRecord = {
      recordType: "message",
      messageId: "legacy-assistant",
      sessionId: "legacy-session",
      turnId: "legacy-turn",
      role: "assistant",
      createdAt: "2026-07-14T00:00:00.000Z",
      content: "",
      toolCalls: [{
        id: "legacy-read",
        name: "read_file",
        rawArguments: JSON.stringify({ path: "legacy.ts" }),
        arguments: { path: "legacy.ts" },
      }],
    };
    const tool: MessageRecord = {
      recordType: "message",
      messageId: "legacy-tool",
      sessionId: "legacy-session",
      turnId: "legacy-turn",
      role: "tool",
      createdAt: "2026-07-14T00:00:01.000Z",
      content: `legacy raw sentinel ${"R".repeat(2_000)}`,
      name: "read_file",
      toolCallId: "legacy-read",
    };
    const summary: ContextSummaryRecord = {
      recordType: "context_summary",
      summaryId: "legacy-summary",
      sessionId: "legacy-session",
      turnId: "legacy-turn",
      createdAt: "2026-07-14T00:00:01.100Z",
      sourceType: "tool_output",
      sourceToolName: "read_file",
      sourceMessageId: tool.messageId,
      sourceToolCallId: tool.toolCallId,
      summary: "legacy summary",
      estimatedTokens: 4,
    };

    const trailing = prepareMessagesForModel([assistant, tool], {
      tokenBudget: 10_000,
      contextSummaries: [summary],
    });
    expect(trailing.messages.find((message) => message.role === "tool")?.content).toContain("legacy raw sentinel");
    expect(trailing.usedSummaryIds).toEqual([]);

    const acknowledged = prepareMessagesForModel([
      assistant,
      tool,
      {
        recordType: "message",
        messageId: "legacy-response",
        sessionId: "legacy-session",
        turnId: "legacy-turn",
        role: "assistant",
        createdAt: "2026-07-14T00:00:02.000Z",
        content: "The raw output was consumed.",
      },
    ], {
      tokenBudget: 10_000,
      contextSummaries: [summary],
    });
    expect(acknowledged.messages.find((message) => message.role === "tool")?.content).toContain("legacy raw sentinel");
    expect(acknowledged.messages.find((message) => message.role === "tool")?.content).not.toContain("[summary source=");
    expect(acknowledged.usedSummaryIds).toEqual([]);
  });

  it("allows versioned post-exposure summaries for every non-empty tool output", () => {
    expect(POST_EXPOSURE_SUMMARY_TOOL_NAMES).toEqual(["*"]);
    expect(isPostExposureToolSummaryEligible("read_file", TOOL_OUTPUT_SUMMARY_MIN_CHARS)).toBe(false);
    expect(isPostExposureToolSummaryEligible("read_file", TOOL_OUTPUT_SUMMARY_MIN_CHARS + 1)).toBe(true);
    expect(isPostExposureToolSummaryEligible("run_shell", TOOL_OUTPUT_SUMMARY_MIN_CHARS + 1)).toBe(true);
    expect(isPostExposureToolSummaryEligible("list_files", TOOL_OUTPUT_SUMMARY_MIN_CHARS + 1)).toBe(true);
    expect(isPostExposureToolSummaryEligible("mcp_custom_tool", TOOL_OUTPUT_SUMMARY_MIN_CHARS + 1)).toBe(true);

    const assistant = (toolCallId: string, name: string): MessageRecord => ({
      recordType: "message",
      messageId: `${toolCallId}-assistant`,
      sessionId: "summary-policy-session",
      turnId: "summary-policy-turn",
      role: "assistant",
      createdAt: "2026-07-15T00:00:00.000Z",
      content: "",
      toolCalls: [{ id: toolCallId, name, rawArguments: "{}", arguments: {} }],
    });
    const tool = (toolCallId: string, name: string, content: string): MessageRecord => ({
      recordType: "message",
      messageId: `${toolCallId}-tool`,
      sessionId: "summary-policy-session",
      turnId: "summary-policy-turn",
      role: "tool",
      createdAt: "2026-07-15T00:00:01.000Z",
      content,
      name,
      toolCallId,
      metadata: {
        contextSummaryCandidate: {
          version: 1,
          summary: `${name} giant output`,
          rawOutputChars: content.length,
        },
      },
    });
    const laterAssistant: MessageRecord = {
      recordType: "message",
      messageId: "summary-policy-response",
      sessionId: "summary-policy-session",
      turnId: "summary-policy-turn",
      role: "assistant",
      createdAt: "2026-07-15T00:00:02.000Z",
      content: "The outputs were consumed.",
    };
    const giantRead = tool("giant-read", "read_file", `READ_SENTINEL${"R".repeat(20_000)}`);
    const giantShell = tool("giant-shell", "run_shell", `SHELL_SENTINEL${"S".repeat(20_000)}`);
    const giantMcp = tool("giant-mcp", "mcp_custom_tool", `MCP_SENTINEL${"M".repeat(20_000)}`);
    const summaries: ContextSummaryRecord[] = [giantRead, giantShell, giantMcp].map((message) => ({
      recordType: "context_summary",
      summaryId: `${message.toolCallId}-summary`,
      sessionId: message.sessionId,
      turnId: message.turnId,
      createdAt: "2026-07-15T00:00:01.500Z",
      sourceType: "tool_output",
      sourceToolName: message.name,
      sourceMessageId: message.messageId,
      sourceToolCallId: message.toolCallId,
      sourceRawChars: message.content.length,
      toolOutputLifecycle: "raw_once_then_summary_v1",
      summary: `${message.name} giant output`,
      estimatedTokens: 10,
    }));
    const prepared = prepareMessagesForModel([
      assistant("giant-read", "read_file"),
      giantRead,
      assistant("giant-shell", "run_shell"),
      giantShell,
      assistant("giant-mcp", "mcp_custom_tool"),
      giantMcp,
      laterAssistant,
    ], {
      tokenBudget: 400_000,
      contextSummaries: summaries,
    });

    expect(prepared.messages.find((message) => message.toolCallId === "giant-read")?.content)
      .toContain("[summary source=read_file");
    expect(prepared.messages.find((message) => message.toolCallId === "giant-shell")?.content)
      .toContain("[summary source=run_shell");
    expect(prepared.messages.find((message) => message.toolCallId === "giant-mcp")?.content)
      .toContain("[summary source=mcp_custom_tool");
    expect(prepared.usedSummaryIds).toEqual([
      "giant-read-summary",
      "giant-shell-summary",
      "giant-mcp-summary",
    ]);
  });

  it("never lets a legacy lossy discovery summary hide bounded file paths", () => {
    const assistant: MessageRecord = {
      recordType: "message",
      messageId: "legacy-list-assistant",
      sessionId: "legacy-list-session",
      turnId: "legacy-list-turn",
      role: "assistant",
      createdAt: "2026-07-15T00:00:00.000Z",
      content: "",
      toolCalls: [{
        id: "legacy-list-call",
        name: "list_files",
        rawArguments: JSON.stringify({ cwd: "static/js", maxResults: 30 }),
        arguments: { cwd: "static/js", maxResults: 30 },
      }],
    };
    const returnedPaths = [
      "analysis_ai.js",
      "bootstrap.bundle.min.js",
      "data_processing.js",
      "docs_links.js",
      "export.js",
      "FileSaver.min.js",
      "html-docx.js",
      "product_feedback.js",
      "theme-switcher.js",
      "xlsx.full.min.js",
    ];
    const tool: MessageRecord = {
      recordType: "message",
      messageId: "legacy-list-tool",
      sessionId: "legacy-list-session",
      turnId: "legacy-list-turn",
      role: "tool",
      createdAt: "2026-07-15T00:00:01.000Z",
      content: `[list_files complete: returned ${returnedPaths.length} path(s)]\n${returnedPaths.join("\n")}`,
      name: "list_files",
      toolCallId: "legacy-list-call",
    };
    const laterAssistant: MessageRecord = {
      recordType: "message",
      messageId: "legacy-list-response",
      sessionId: "legacy-list-session",
      turnId: "legacy-list-turn",
      role: "assistant",
      createdAt: "2026-07-15T00:00:02.000Z",
      content: "Continue checking the repository.",
    };
    const summary: ContextSummaryRecord = {
      recordType: "context_summary",
      summaryId: "legacy-lossy-list-summary",
      sessionId: "legacy-list-session",
      turnId: "legacy-list-turn",
      createdAt: "2026-07-15T00:00:01.100Z",
      sourceType: "tool_output",
      sourceToolName: "list_files",
      sourceMessageId: tool.messageId,
      sourceToolCallId: tool.toolCallId,
      summary: `listed ${returnedPaths.length} files; key files: ${returnedPaths.slice(0, 6).join(", ")}`,
      estimatedTokens: 40,
    };

    const prepared = prepareMessagesForModel([assistant, tool, laterAssistant], {
      tokenBudget: 10_000,
      contextSummaries: [summary],
    });
    const toolContent = prepared.messages.find((message) => message.messageId === tool.messageId)?.content ?? "";
    expect(toolContent).toContain("html-docx.js");
    expect(toolContent).toContain("theme-switcher.js");
    expect(toolContent).not.toContain("[summary source=");
    expect(prepared.usedSummaryIds).not.toContain(summary.summaryId);
  });

  it("uses the largest raw tool prefix with an explicit budget marker when the group cannot fit", () => {
    const messages: MessageRecord[] = [
      {
        recordType: "message",
        messageId: "budget-assistant",
        sessionId: "budget-session",
        turnId: "budget-turn",
        role: "assistant",
        createdAt: "2026-07-14T01:00:00.000Z",
        content: "",
        toolCalls: [{
          id: "budget-tool-call",
          name: "read_file",
          rawArguments: "{}",
          arguments: {},
        }],
      },
      {
        recordType: "message",
        messageId: "budget-tool",
        sessionId: "budget-session",
        turnId: "budget-turn",
        role: "tool",
        createdAt: "2026-07-14T01:00:01.000Z",
        content: `RAW_PREFIX_SENTINEL_${"B".repeat(20_000)}_RAW_END_SENTINEL`,
        name: "read_file",
        toolCallId: "budget-tool-call",
      },
    ];

    const prepared = prepareMessagesForModel(messages, { tokenBudget: 600 });
    const toolMessage = prepared.messages.find((message) => message.role === "tool");
    expect(validateMessageHistory(prepared.messages).valid).toBe(true);
    expect(toolMessage?.content).toContain("RAW_PREFIX_SENTINEL");
    expect(toolMessage?.content).toContain("raw tool output truncated by model context token budget");
    expect(toolMessage?.content).not.toContain("RAW_END_SENTINEL");
    expect(toolMessage?.content).not.toContain("[summary source=");
    expect(prepared.report.actions.some((action) => action.type === "trim_tool_message")).toBe(true);
    expect(prepared.toolOutputExposure).toMatchObject({
      rawMessageCount: 0,
      summarizedMessageCount: 0,
      budgetTruncatedMessageCount: 1,
    });
  });

  it("returns every diagnostic issue instead of only the diagnostic summary", async () => {
    const workspaceRoot = await createFixtureWorkspace("deep-mix-phase11-full-diagnostics-");
    await fs.writeFile(
      path.join(workspaceRoot, "src", "diagnostic.ts"),
      "\tconst first = 1;  \nconst second = 2;  ",
      "utf8",
    );
    const sessionStore = new SessionStore(workspaceRoot);
    await sessionStore.ensureInitialized();
    const session = await sessionStore.createSession("full diagnostic output");
    const runtime = new ToolRuntime({
      workspaceRoot,
      sessionStore,
      permissionMode: "danger-full-access",
    });

    const result = await runtime.executeManualTool(
      "lint_diagnostics",
      { paths: ["src/diagnostic.ts"] },
      session.sessionId,
    );
    const output = JSON.parse(result.output) as {
      summary: string;
      issues: Array<{ code?: string; line?: number; message: string }>;
    };

    expect(output.summary).toContain("warning");
    expect(output.issues.length).toBeGreaterThanOrEqual(4);
    expect(output.issues.map((issue) => issue.code)).toEqual(expect.arrayContaining([
      "tab_character",
      "trailing_whitespace",
      "missing_final_newline",
    ]));
    expect(result.output).not.toBe(output.summary);
  });

  it("limits read_file output before it reaches the message history budget", async () => {
    const workspaceRoot = await createFixtureWorkspace("deep-mix-phase11-read-file-limit-");
    const sessionStore = new SessionStore(workspaceRoot);
    await sessionStore.ensureInitialized();
    const session = await sessionStore.createSession("read file limit");
    const runtime = new ToolRuntime({
      workspaceRoot,
      sessionStore,
      permissionMode: "danger-full-access",
    });

    const result = await runtime.executeManualTool(
      "read_file",
      { path: "src/huge-file.ts", maxChars: 1_000 },
      session.sessionId,
    );

    expect(result.success).toBe(true);
    expect(result.output).toContain("[read_file truncated:");
    expect(result.structuredContent).toMatchObject({
      truncated: true,
      returnedChars: 1_000,
      truncationReason: "oversized_line",
      rangeComplete: false,
    });
  });

  it("keeps long tool output raw for first consumption, then records a stable summary without mutating history", async () => {
    const workspaceRoot = await createFixtureWorkspace("deep-mix-phase11-tool-trim-");
    await fs.writeFile(
      path.join(workspaceRoot, "src", "huge-file.ts"),
      `export const hugeText = "${"A".repeat(200_000)}";\n`,
      "utf8",
    );
    const sessionStore = new SessionStore(workspaceRoot);
    await sessionStore.ensureInitialized();
    const runtime = new GovernorRuntime({
      workspaceRoot,
      permissionMode: "danger-full-access",
      environment: {
        ...process.env,
        DEEPSEEK_CONTEXT_SOFT_LIMIT_TOKENS: "20000",
        DEEPSEEK_CONTEXT_COMPACT_THRESHOLD_TOKENS: "16000",
        DEEPSEEK_MAX_HISTORY_MESSAGES: "8",
      },
      modelClient: new ScriptedModelClient([
        {
          content: "",
          toolCalls: [
            {
              id: "tool-read",
              name: "read_file",
              rawArguments: JSON.stringify({ path: "src/huge-file.ts" }),
              arguments: { path: "src/huge-file.ts" },
            },
          ],
        },
        async (request) => {
          assertToolHistoryIsLegal(request.messages);
          const toolMessages = request.messages.filter((message) => message.role === "tool");
          expect(toolMessages).toHaveLength(1);
          expect(toolMessages[0]?.content ?? "").toContain("export const hugeText");
          expect(toolMessages[0]?.content ?? "").not.toContain("[summary source=");
          return {
            content: "The repository contains a large source file and a smaller helper file.",
            toolCalls: [],
          };
        },
      ]),
    });

    const result = await runtime.runTurn({
      prompt: "Explain the repository purpose with evidence from src/huge-file.ts.",
    });

    expect(result.session.status).toBe("waiting_for_user");
    expect(result.finalResponse).toContain("large source file");
    const events = await sessionStore.loadEvents(result.sessionId);
    expect(events.some(
      (event) => event.recordType === "context_summary" && event.sourceToolName === "read_file",
    )).toBe(true);
    expect((await sessionStore.loadMessages(result.sessionId)).find(
      (message) => message.toolCallId === "tool-read",
    )?.content).toContain("export const hugeText");
  });

  it("falls back to the last safe turn before reusing a failed corrupted session", async () => {
    const workspaceRoot = await createFixtureWorkspace("deep-mix-phase11-failed-session-");
    const sessionStore = new SessionStore(workspaceRoot);
    await sessionStore.ensureInitialized();
    const session = await sessionStore.createSession("failed history");

    await appendCompletedTurn(sessionStore, session.sessionId, "What does this repo do?", "It is a coding-agent runtime.");

    const brokenTurn = await sessionStore.startTurn({
      sessionId: session.sessionId,
      requestSummary: "Inspect the repository with tools.",
      userMessageId: "pending",
    });
    const brokenUser = await sessionStore.appendMessage({
      sessionId: session.sessionId,
      turnId: brokenTurn.turnId,
      role: "user",
      content: "Inspect the repository with tools.",
    });
    const brokenAssistant = await sessionStore.appendMessage({
      sessionId: session.sessionId,
      turnId: brokenTurn.turnId,
      role: "assistant",
      content: "",
      toolCalls: [
        {
          id: "call-list",
          name: "list_files",
          rawArguments: JSON.stringify({ cwd: ".", maxResults: 100 }),
          arguments: { cwd: ".", maxResults: 100 },
        },
        {
          id: "call-read",
          name: "read_file",
          rawArguments: JSON.stringify({ path: "src/huge-file.ts" }),
          arguments: { path: "src/huge-file.ts" },
        },
      ],
    });
    await sessionStore.appendMessage({
      sessionId: session.sessionId,
      turnId: brokenTurn.turnId,
      role: "tool",
      content: "src/huge-file.ts\nsrc/small-file.ts",
      name: "list_files",
      toolCallId: "call-list",
    });
    await sessionStore.finishTurn({
      sessionId: session.sessionId,
      turnId: brokenTurn.turnId,
      startedAt: brokenTurn.startedAt,
      requestSummary: "Inspect the repository with tools.",
      userMessageId: brokenUser.messageId,
      assistantMessageId: brokenAssistant.messageId,
      toolCallIds: ["call-list", "call-read"],
      status: "failed",
      error: "DeepSeek request failed with 400: Messages with role 'tool' must be a response to a preceding message with 'tool_calls'",
    });
    await sessionStore.setSessionStatus(session.sessionId, "failed");

    const runtime = new GovernorRuntime({
      workspaceRoot,
      permissionMode: "danger-full-access",
      modelClient: new ScriptedModelClient([
        async (request) => {
          assertToolHistoryIsLegal(request.messages);
          expect(request.messages.some((message) => message.content === "Inspect the repository with tools.")).toBe(false);
          return {
            content: "Resumed safely after dropping the corrupted turn.",
            toolCalls: [],
          };
        },
      ]),
    });

    const resumedSession = await runtime.resolveResumeTarget(session.sessionId);
    expect(resumedSession.sessionId).toBe(session.sessionId);

    const result = await runtime.runTurn({
      sessionId: session.sessionId,
      prompt: "Continue safely from the last good point.",
    });

    expect(result.finalResponse).toContain("Resumed safely");
    const historyEvents = loadHistoryIntegrityEvents(await sessionStore.loadEvents(session.sessionId));
    expect(historyEvents.some((event) => event.scope === "resume_check" && event.outcome === "fallback_to_safe_boundary")).toBe(true);
    expect(historyEvents.some((event) => event.scope === "pre_model_request" && event.outcome === "fallback_to_safe_boundary")).toBe(true);
  });

  it("reports a local history integrity error on resume instead of replaying the provider 400 for a corrupted approval session", async () => {
    const workspaceRoot = await createFixtureWorkspace("deep-mix-phase11-resume-error-");
    const sessionStore = new SessionStore(workspaceRoot);
    await sessionStore.ensureInitialized();
    const session = await sessionStore.createSession("corrupted approval");

    const turn = await sessionStore.startTurn({
      sessionId: session.sessionId,
      requestSummary: "Run a command and wait for approval.",
      userMessageId: "pending",
    });
    const userMessage = await sessionStore.appendMessage({
      sessionId: session.sessionId,
      turnId: turn.turnId,
      role: "user",
      content: "Run a command and wait for approval.",
    });
    const assistantMessage = await sessionStore.appendMessage({
      sessionId: session.sessionId,
      turnId: turn.turnId,
      role: "assistant",
      content: "",
      toolCalls: [
        {
          id: "approval-call",
          name: "run_shell",
          rawArguments: JSON.stringify({ command: "Write-Output 'ok'" }),
          arguments: { command: "Write-Output 'ok'" },
        },
      ],
    });
    await sessionStore.appendMessage({
      sessionId: session.sessionId,
      turnId: turn.turnId,
      role: "tool",
      content: "orphan output",
      name: "run_shell",
      toolCallId: "different-call",
    });
    await sessionStore.finishTurn({
      sessionId: session.sessionId,
      turnId: turn.turnId,
      startedAt: turn.startedAt,
      requestSummary: "Run a command and wait for approval.",
      userMessageId: userMessage.messageId,
      assistantMessageId: assistantMessage.messageId,
      toolCallIds: ["approval-call"],
      status: "ask_permission",
    });
    await sessionStore.setSessionStatus(session.sessionId, "ask_permission");

    const runtime = new GovernorRuntime({
      workspaceRoot,
      permissionMode: "auto",
      modelClient: new ScriptedModelClient([]),
    });
    const input = new ScriptedInput(["/exit"]);
    const output = new BufferOutput();
    const shell = new CliSessionShell({
      runtime,
      sessionStore,
      input,
      output,
      workspaceRoot,
      permissionMode: "auto",
      getProfileStatus: () => readProfileStatus(workspaceRoot),
    });

    await shell.run({
      resumeRequested: true,
      resumeSessionId: session.sessionId,
    });

    expect(output.buffer).toContain("Local history integrity error before resume");
    expect(output.buffer).not.toContain("Provider request error after local history validation passed");
    expect(output.buffer).not.toContain("Messages with role 'tool' must be a response to a preceding message with 'tool_calls'");
  });

  it("classifies repeated DeepSeek 400 responses as provider-side after local validation passes", async () => {
    const workspaceRoot = await createFixtureWorkspace("deep-mix-phase11-provider-classification-");
    const runtime = new GovernorRuntime({
      workspaceRoot,
      permissionMode: "danger-full-access",
      modelClient: new ThrowingModelClient(
        new Error("DeepSeek request failed with 400: Messages with role 'tool' must be a response to a preceding message with 'tool_calls'"),
      ),
    });

    await expect(
      runtime.runTurn({
        prompt: "Say hello without using tools.",
      }),
    ).rejects.toBeInstanceOf(ProviderRequestError);
    await expect(
      runtime.runTurn({
        prompt: "Say hello without using tools.",
      }),
    ).rejects.toThrow("Provider request error after local history validation passed");
  });
});
