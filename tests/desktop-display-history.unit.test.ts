import { readFileSync } from "node:fs";

import { describe, expect, it } from "vitest";
import type { ApprovalRecord, MessageRecord } from "../packages/shared-schema/src/index.js";
import { buildApprovalDisplayDetails } from "../apps/desktop/src/renderer/approval-display.js";
import { buildDisplayHistory } from "../apps/desktop/src/renderer/display-history.js";

function message(input: Partial<MessageRecord> & Pick<MessageRecord, "messageId" | "role" | "content">): MessageRecord {
  return {
    recordType: "message",
    sessionId: "session-1",
    turnId: "turn-1",
    createdAt: "2026-07-11T12:00:00.000Z",
    ...input,
  };
}

describe("desktop restored message history", () => {
  it("keeps each persisted tool round before the assistant summary that follows it", () => {
    const result = buildDisplayHistory([
      message({ messageId: "u1", role: "user", content: "检查项目" }),
      message({
        messageId: "a1",
        role: "assistant",
        content: "",
        reasoningContent: "先读取文件。",
        toolCalls: [{ id: "call-1", name: "read_file", arguments: { path: "README.md" }, rawArguments: "{}" }],
      }),
      message({ messageId: "t1", role: "tool", content: "file contents", name: "read_file", toolCallId: "call-1" }),
      message({ messageId: "a2", role: "assistant", content: "检查完成。" }),
    ]);

    expect(result).toHaveLength(3);
    expect(result[1]).toMatchObject({
      id: "a1",
      role: "assistant",
      content: "",
    });
    expect(result[1]).not.toHaveProperty("reasoningContent");
    expect(result[1]?.toolCalls).toHaveLength(1);
    expect(result[1]?.toolCalls?.[0]).toMatchObject({
      id: "call-1",
      name: "read_file",
      status: "success",
      result: { output: "file contents" },
    });
    expect(result[2]).toMatchObject({ id: "a2", role: "assistant", content: "检查完成。" });
    expect(result.some((entry) => entry.role === "tool")).toBe(false);
  });

  it("hides synthetic routing prose while retaining its tool group", () => {
    const result = buildDisplayHistory([
      message({
        messageId: "route-a1",
        role: "assistant",
        content: "Automatic routing decision: Route to coding worker.",
        toolCalls: [{ id: "route-call", name: "invoke_coding_worker", arguments: {}, rawArguments: "{}" }],
        metadata: { routeTarget: "glm_coding", routeMode: "auto" },
      }),
      message({
        messageId: "route-t1",
        role: "tool",
        content: "worker result",
        name: "invoke_coding_worker",
        toolCallId: "route-call",
      }),
    ]);

    expect(result).toHaveLength(1);
    expect(result[0]?.content).toBe("");
    expect(result[0]?.toolCalls?.[0]).toMatchObject({ id: "route-call", status: "success" });
    expect(JSON.stringify(result)).not.toContain("Automatic routing decision");
  });

  it("restores persisted tool timing instead of manufacturing a zero-duration round", () => {
    const result = buildDisplayHistory([
      message({
        messageId: "timed-a1",
        role: "assistant",
        content: "",
        toolCalls: [{ id: "timed-call", name: "run_tests", arguments: {}, rawArguments: "{}" }],
      }),
      message({
        messageId: "timed-t1",
        role: "tool",
        content: "passed",
        name: "run_tests",
        toolCallId: "timed-call",
        metadata: {
          startedAt: "2026-07-11T12:00:01.000Z",
          endedAt: "2026-07-11T12:00:04.000Z",
        },
      }),
    ]);

    expect(result[0]?.toolCalls?.[0]?.result).toMatchObject({
      startedAt: "2026-07-11T12:00:01.000Z",
      endedAt: "2026-07-11T12:00:04.000Z",
    });
  });

  it("keeps orphaned historical tool records visible without duplicating them", () => {
    const result = buildDisplayHistory([
      message({ messageId: "t1", role: "tool", content: "legacy output", name: "run_shell", toolCallId: "legacy-call" }),
    ]);

    expect(result).toHaveLength(1);
    expect(result[0]).toMatchObject({ role: "tool", content: "legacy output", name: "run_shell" });
  });

  it("preserves generic Git HEAD and conflict output and renders errors without masking that output", () => {
    const gitOutput = JSON.stringify({
      kind: "git_operation",
      toolName: "git_integrate",
      action: "merge",
      status: "conflicted",
      repository: { head: { branch: "main", oid: "0123456789abcdef" } },
      conflict: {
        status: "conflicted",
        operation: "merge",
        files: ["tracked.txt"],
        nextSteps: ["Resolve the listed file."],
      },
    });
    const result = buildDisplayHistory([
      message({
        messageId: "a-git",
        role: "assistant",
        content: "",
        toolCalls: [{
          id: "call-git",
          name: "git_integrate",
          arguments: { action: "merge", target: "topic" },
          rawArguments: "{}",
        }],
      }),
      message({
        messageId: "t-git",
        role: "tool",
        content: gitOutput,
        name: "git_integrate",
        toolCallId: "call-git",
      }),
    ]);

    expect(result[0]?.toolCalls?.[0]?.result?.output).toBe(gitOutput);
    expect(result[0]?.toolCalls?.[0]?.result?.output).toContain('"branch":"main"');
    expect(result[0]?.toolCalls?.[0]?.result?.output).toContain('"status":"conflicted"');
    expect(result[0]?.toolCalls?.[0]?.result?.output).toContain("tracked.txt");

    const chatPanelSource = readFileSync(
      new URL("../apps/desktop/src/renderer/components/ChatPanel.tsx", import.meta.url),
      "utf8",
    );
    expect(chatPanelSource).toContain("tool.result?.error &&");
    expect(chatPanelSource).toContain("tool.result?.output ?? JSON.stringify");
    expect(chatPanelSource).not.toContain("tool.result?.error ?? tool.result?.output");
  });

  it("builds a bounded Desktop approval scope without exposing generic argument parameters", () => {
    const approval: ApprovalRecord = {
      recordType: "approval",
      approvalId: "approval-git-restore",
      sessionId: "session-1",
      createdAt: "2026-07-16T00:00:00.000Z",
      toolName: "git_restore",
      requestKey: "git_restore:hmac-sha256:redacted",
      permissionCategory: "write_file",
      decision: "ask",
      reason: "git_restore requires explicit approval in auto mode.",
      status: "pending",
      persistence: "mode_default",
      sideEffectLevel: "high",
      presentation: {
        action: "restore",
        summary: "Restore one explicit path from HEAD.",
        paths: ["tracked.txt"],
        revisions: ["HEAD"],
        argumentSummary: {
          token: "must-not-render",
          command: "sensitive parameter detail",
        },
      },
    };

    const display = buildApprovalDisplayDetails(approval);
    expect(display).toEqual({
      action: "restore",
      risk: "high",
      summary: "Restore one explicit path from HEAD.",
      paths: ["tracked.txt"],
      revisions: ["HEAD"],
    });
    expect(JSON.stringify(display)).not.toContain("must-not-render");
    expect(JSON.stringify(display)).not.toContain("sensitive parameter detail");

    const inputBarSource = readFileSync(
      new URL("../apps/desktop/src/renderer/components/InputBar.tsx", import.meta.url),
      "utf8",
    );
    expect(inputBarSource).toContain("approvalDisplay.action");
    expect(inputBarSource).toContain("approvalDisplay.risk");
    expect(inputBarSource).toContain("approvalDisplay.summary");
    expect(inputBarSource).toContain("approvalDisplay.paths");
    expect(inputBarSource).toContain("approvalDisplay.revisions");
    expect(inputBarSource).not.toContain("argumentSummary");

    const legacy = buildApprovalDisplayDetails({
      ...approval,
      sideEffectLevel: undefined,
      presentation: undefined,
    });
    expect(legacy).toEqual({
      summary: "git_restore requires explicit approval in auto mode.",
      paths: [],
      revisions: [],
    });
  });
});
