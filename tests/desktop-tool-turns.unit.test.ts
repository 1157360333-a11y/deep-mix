import { readFileSync } from "node:fs";

import { describe, expect, it } from "vitest";
import { projectConversationTurns } from "../apps/desktop/src/renderer/conversation-turns.js";
import {
  createLiveMessageFlowState,
  reduceLiveMessageFlow,
  type LiveMessageFlowEvent,
} from "../apps/desktop/src/renderer/live-message-flow.js";
import type { DisplayMessage } from "../apps/desktop/src/renderer/types.js";

function toolCall(id: string, name: string) {
  return { id, name, arguments: {}, rawArguments: "{}" };
}

function project(events: LiveMessageFlowEvent[], initialMessages: DisplayMessage[] = []) {
  let messages = initialMessages;
  let state = createLiveMessageFlowState("test-run");
  for (const event of events) {
    const result = reduceLiveMessageFlow(messages, state, event, "2026-07-18T12:00:00.000Z");
    messages = result.messages;
    state = result.state;
  }
  return { messages, state };
}

describe("desktop live tool-round projection", () => {
  it("keeps each explicit batch together and places the following summary after it", () => {
    const first = toolCall("call-1", "read_file");
    const second = toolCall("call-2", "run_tests");
    const { messages, state } = project([
      { type: "tool_batch_start", batchId: "assistant-tools-1", toolCalls: [first] },
      { type: "tool_start", toolCall: first },
      { type: "tool_end", result: { toolName: first.name, callId: first.id, startedAt: "2026-07-18T12:00:00.000Z", endedAt: "2026-07-18T12:00:01.000Z", success: true, output: "README" } },
      { type: "text", chunk: "第一轮检查完成。" },
      { type: "tool_batch_start", batchId: "assistant-tools-2", toolCalls: [second] },
      { type: "tool_start", toolCall: second },
      { type: "tool_end", result: { toolName: second.name, callId: second.id, startedAt: "2026-07-18T12:00:02.000Z", endedAt: "2026-07-18T12:00:03.000Z", success: true, output: "passed" } },
      { type: "text", chunk: "全部处理完成。" },
      { type: "complete" },
    ]);

    expect(messages).toHaveLength(3);
    expect(messages[0]?.toolCalls?.map((tool) => tool.id)).toEqual(["call-1"]);
    expect(messages[1]).toMatchObject({ content: "第一轮检查完成。" });
    expect(messages[1]?.toolCalls?.map((tool) => tool.id)).toEqual(["call-2"]);
    expect(messages[2]).toMatchObject({ content: "全部处理完成。", streaming: false });

    const turns = projectConversationTurns([
      { id: "user", turnId: state.turnId, role: "user", content: "检查项目" },
      ...messages,
    ], false);
    expect(turns).toHaveLength(1);
    expect(turns[0]?.final?.content).toBe("全部处理完成。");
    expect(turns[0]?.process.map((message) => message.id)).toEqual([messages[0]!.id, messages[1]!.id]);
    expect(turns[0]).toMatchObject({ toolRoundCount: 2, toolCallCount: 2, running: false });
  });

  it("treats repeated batch events as idempotent", () => {
    const call = toolCall("call-1", "read_file");
    const { messages } = project([
      { type: "tool_batch_start", batchId: "assistant-tools-1", toolCalls: [call] },
      { type: "tool_batch_start", batchId: "assistant-tools-1", toolCalls: [call] },
      { type: "tool_start", toolCall: call },
      { type: "tool_batch_start", batchId: "assistant-tools-1", toolCalls: [call] },
      { type: "tool_start", toolCall: call },
    ]);

    expect(messages).toHaveLength(1);
    expect(messages[0]?.toolCalls).toHaveLength(1);
  });

  it("reuses a persisted assistant owner when an approval resumes", () => {
    const persistedUser: DisplayMessage = {
      id: "user-persisted",
      turnId: "turn-persisted",
      role: "user",
      content: "Apply the approved patch.",
    };
    const persisted: DisplayMessage = {
      id: "assistant-resume",
      turnId: "turn-persisted",
      role: "assistant",
      content: "",
      toolCalls: [{ id: "call-resume", name: "apply_patch", status: "running" }],
      streaming: false,
    };
    const call = toolCall("call-resume", "apply_patch");
    const { messages, state } = project([
      { type: "tool_batch_start", batchId: persisted.id, toolCalls: [call] },
      { type: "tool_start", toolCall: call },
      { type: "tool_end", result: { toolName: call.name, callId: call.id, startedAt: "2026-07-18T12:00:00.000Z", endedAt: "2026-07-18T12:00:01.000Z", success: true, output: "patched" } },
      { type: "text", chunk: "Patch completed." },
      { type: "complete" },
    ], [persistedUser, persisted]);

    expect(state.turnId).toBe("turn-persisted");
    expect(messages).toHaveLength(3);
    expect(messages[1]?.id).toBe("assistant-resume");
    expect(messages[1]?.toolCalls).toHaveLength(1);
    expect(messages[1]?.toolCalls?.[0]).toMatchObject({ id: "call-resume", status: "success" });
    expect(messages[2]).toMatchObject({ turnId: "turn-persisted", content: "Patch completed." });

    const turns = projectConversationTurns(messages, false);
    expect(turns).toHaveLength(1);
    expect(turns[0]?.final?.content).toBe("Patch completed.");
    expect(turns[0]?.process.map((message) => message.id)).toEqual(["assistant-resume"]);
  });

  it("keeps a structured user response inside its existing runtime turn", () => {
    const turns = projectConversationTurns([
      { id: "user-1", turnId: "turn-1", role: "user", content: "Run the analysis." },
      {
        id: "assistant-question",
        turnId: "turn-1",
        role: "assistant",
        content: "Choose a confidence level.",
      },
      { id: "user-answer", turnId: "turn-1", role: "user", content: "Use 95%." },
      { id: "assistant-final", turnId: "turn-1", role: "assistant", content: "Analysis completed." },
    ], false);

    expect(turns).toHaveLength(1);
    expect(turns[0]?.id).toBe("turn-1");
    expect(turns[0]?.process.map((message) => message.id)).toEqual(["assistant-question", "user-answer"]);
    expect(turns[0]?.final?.content).toBe("Analysis completed.");
  });

  it("streams a direct structured-answer continuation into the original runtime turn", () => {
    const state = createLiveMessageFlowState("resume-run", "turn-1");
    const projected = reduceLiveMessageFlow([], state, { type: "text", chunk: "Analysis resumed." });

    expect(projected.state.turnId).toBe("turn-1");
    expect(projected.messages).toEqual([
      expect.objectContaining({ turnId: "turn-1", content: "Analysis resumed." }),
    ]);
  });

  it("keeps local slash-command results out of the preceding completed turn", () => {
    const turns = projectConversationTurns([
      { id: "user-1", turnId: "turn-1", role: "user", content: "Inspect the project." },
      { id: "assistant-final", turnId: "turn-1", role: "assistant", content: "Inspection completed." },
      { id: "local-help", turnId: "local-turn-local-help", role: "assistant", content: "Available commands" },
    ], false);

    expect(turns).toHaveLength(2);
    expect(turns[0]?.final?.content).toBe("Inspection completed.");
    expect(turns[1]?.final?.content).toBe("Available commands");
  });

  it("preserves a completed direct-answer duration without process events", () => {
    const turns = projectConversationTurns([
      { id: "user-direct", turnId: "turn-direct", role: "user", content: "What changed?" },
      {
        id: "assistant-direct",
        turnId: "turn-direct",
        role: "assistant",
        content: "Only the renderer changed.",
        turnDurationMs: 5_000,
      },
    ], false);

    expect(turns[0]).toMatchObject({ durationMs: 5_000, process: [] });
    expect(turns[0]?.final?.content).toBe("Only the renderer changed.");
  });
});

describe("desktop process disclosure and reasoning privacy", () => {
  it("keeps the final answer outside one collapsed process disclosure", () => {
    const chatSource = readFileSync(
      new URL("../apps/desktop/src/renderer/components/ChatPanel.tsx", import.meta.url),
      "utf8",
    );
    expect(chatSource).toContain('<details className="process-history">');
    expect(chatSource).toContain("turn.final && turn.process.length === 0 && duration !== undefined");
    expect(chatSource).toContain("<ProcessReceipt duration={duration} />");
    expect(chatSource).toContain('className="phase-user-response"');
    expect(chatSource).toContain("{turn.final?.content && <MessageBody");
    expect(chatSource).toContain("<WorkingIndicator duration={liveDurationMs} />");
    expect(chatSource.indexOf("<ProcessHistory")).toBeLessThan(
      chatSource.indexOf("{turn.final?.content && <MessageBody"),
    );
    expect(chatSource).not.toContain("reasoningContent");
    expect(chatSource).not.toContain("查看思考过程");
  });

  it("does not subscribe or forward native reasoning deltas", () => {
    const appSource = readFileSync(
      new URL("../apps/desktop/src/renderer/App.tsx", import.meta.url),
      "utf8",
    );
    const mainSource = readFileSync(
      new URL("../apps/desktop/src/main/index.ts", import.meta.url),
      "utf8",
    );
    const preloadSource = readFileSync(
      new URL("../apps/desktop/src/preload/index.ts", import.meta.url),
      "utf8",
    );
    const ipcSource = readFileSync(
      new URL("../apps/desktop/src/shared/ipc.ts", import.meta.url),
      "utf8",
    );
    const mockRuntimeSource = readFileSync(
      new URL("../apps/desktop/src/renderer/runtime.ts", import.meta.url),
      "utf8",
    );
    expect(appSource).not.toContain("runtime.onStreamReasoning");
    expect(appSource).toContain("turnId: `local-turn-${id}`");
    expect(mainSource).not.toContain("onReasoningDelta:");
    expect(`${preloadSource}\n${ipcSource}\n${mockRuntimeSource}`).not.toContain("streamReasoning");
  });
});
