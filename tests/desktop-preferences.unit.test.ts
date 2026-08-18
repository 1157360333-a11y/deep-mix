import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { afterEach, describe, expect, it } from "vitest";
import { GovernorRuntime, PromptCompiler } from "../packages/core-governor/src/index.js";
import {
  buildSessionTitleMessages,
  createFallbackSessionTitle,
  normalizeGeneratedSessionTitle,
  selectFirstTurnTitleMessages,
  SESSION_TITLE_SYSTEM_PROMPT,
} from "../packages/core-governor/src/session-title.js";
import type { ModelClient, ModelCompletionRequest } from "../packages/shared-schema/src/index.js";

const temporaryRoots: string[] = [];

async function createWorkspace(): Promise<string> {
  const workspace = await mkdtemp(path.join(os.tmpdir(), "deep-mix-desktop-preferences-"));
  temporaryRoots.push(workspace);
  return workspace;
}

afterEach(async () => {
  await Promise.all(temporaryRoots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

describe("desktop reply style", () => {
  it("injects a strict no-emoji rule for pragmatic replies", async () => {
    const compiler = new PromptCompiler({
      model: "deepseek-test",
      contextWindow: 32_000,
      softLimitTokens: 24_000,
      compactThresholdTokens: 20_000,
      reserveOutputTokens: 4_000,
      summaryMaxTokens: 1_000,
      recentTailMaxTokens: 6_000,
      replyStyle: "pragmatic",
    });
    const compiled = await compiler.compile({
      workspaceRoot: await createWorkspace(),
      currentUserRequest: "Summarize the repair.",
      planItems: [],
      toolDefinitions: [],
      recentMessages: [],
    });

    expect(compiled.systemPrompt).toContain("## Reply Style");
    expect(compiled.systemPrompt).toContain("Do not use emoji, emoticons, or decorative symbols");
    expect(compiled.systemPrompt).toContain("pragmatic, restrained, and rigorous");
  });

  it("keeps the friendly style warm without making emoji mandatory", async () => {
    const compiler = new PromptCompiler({
      model: "deepseek-test",
      contextWindow: 32_000,
      softLimitTokens: 24_000,
      compactThresholdTokens: 20_000,
      reserveOutputTokens: 4_000,
      summaryMaxTokens: 1_000,
      recentTailMaxTokens: 6_000,
      replyStyle: "friendly",
    });
    const compiled = await compiler.compile({
      workspaceRoot: await createWorkspace(),
      currentUserRequest: "Explain the result.",
      planItems: [],
      toolDefinitions: [],
      recentMessages: [],
    });

    expect(compiled.systemPrompt).toContain("warm, collaborative, and considerate");
    expect(compiled.systemPrompt).toContain("Emoji are optional and must be used sparingly");
  });
});

describe("AI session titles", () => {
  it("normalizes model output into a clean task title", () => {
    expect(normalizeGeneratedSessionTitle("## 标题：🛠️ 修复会话自动命名。\n说明文字"))
      .toBe("修复会话自动命名");
    expect(normalizeGeneratedSessionTitle("新任务")).toBeUndefined();
  });

  it("creates a short distinguishable fallback without attachment protocol text", () => {
    expect(createFallbackSessionTitle("你好，这个项目是做什么的")).toBe("这个项目是做什么的");
    expect(createFallbackSessionTitle("你好")).toBe("日常会话");
    expect(createFallbackSessionTitle([
      "修复桌面端会话一直显示新任务的问题",
      "[Desktop attachments]",
      "- screenshot.png (image, image/png): file://attachment",
    ].join("\n"))).toBe("修复桌面端会话一直显示新任务的问题");
    expect(createFallbackSessionTitle("我想要进一步优化此脚本，你看看有什么方向可以进行的"))
      .toBe("进一步优化脚本");
  });

  it("keeps the complete first-turn transcript instead of truncating the request or result", () => {
    const requestTail = `REQUEST_TAIL_${"甲".repeat(5_000)}`;
    const resultTail = `RESULT_TAIL_${"乙".repeat(5_000)}`;
    const transcript = buildSessionTitleMessages({ messages: [
      { role: "user", content: `进一步优化脚本\n${requestTail}` },
      { role: "tool", name: "read_file", content: resultTail },
      { role: "assistant", content: "建议优化搜索缓存与热路径" },
    ] });
    expect(transcript[0]?.content).toContain(requestTail);
    expect(transcript[0]?.content).toContain(resultTail);
  });

  it("selects every persisted message from the first turn only", () => {
    const base = { recordType: "message" as const, sessionId: "session", createdAt: "2026-08-16T00:00:00.000Z" };
    const messages = [
      { ...base, messageId: "u1", turnId: "turn-1", role: "user" as const, content: "进一步优化脚本" },
      { ...base, messageId: "t1", turnId: "turn-1", role: "tool" as const, name: "read_file", content: "完整工具结果" },
      { ...base, messageId: "a1", turnId: "turn-1", role: "assistant" as const, content: "优化建议" },
      { ...base, messageId: "u2", turnId: "turn-2", role: "user" as const, content: "第二轮" },
    ];
    expect(selectFirstTurnTitleMessages(messages).map((message) => message.messageId)).toEqual(["u1", "t1", "a1"]);
  });

  it("uses a separate tool-free, non-thinking model request", async () => {
    const workspaceRoot = await createWorkspace();
    const requests: ModelCompletionRequest[] = [];
    const modelClient: ModelClient = {
      streamCompletion: async (request) => {
        requests.push(request);
        return { content: "修复桌面端会话命名", toolCalls: [] };
      },
    };
    const runtime = new GovernorRuntime({ workspaceRoot, modelClient });

    const titleMessages = [{
      recordType: "message" as const,
      messageId: "message-1",
      sessionId: "session-1",
      turnId: "turn-1",
      role: "user" as const,
      createdAt: "2026-08-16T00:00:00.000Z",
      content: "会话不能再直接使用第一句话命名",
    }];
    const title = await runtime.generateSessionTitle({ messages: titleMessages });

    expect(title).toBe("修复桌面端会话命名");
    expect(requests).toHaveLength(1);
    expect(requests[0]).toMatchObject({
      systemPrompt: SESSION_TITLE_SYSTEM_PROMPT,
      stream: false,
      tools: [],
      maxOutputTokens: 1_024,
      route: { thinkingMode: { mode: "disabled", reasoningEffort: "not_applicable" } },
    });
    expect(requests[0]?.messages).toEqual(buildSessionTitleMessages({ messages: titleMessages }));
  });

  it("falls back to a concise request title when the provider exhausts output on reasoning", async () => {
    const workspaceRoot = await createWorkspace();
    const modelClient: ModelClient = {
      streamCompletion: async () => ({
        content: "",
        reasoningContent: "The model used the whole budget before producing a title.",
        finishReason: "length",
        toolCalls: [],
      }),
    };
    const runtime = new GovernorRuntime({ workspaceRoot, modelClient });

    await expect(runtime.generateSessionTitle({ messages: [{
      recordType: "message", messageId: "message-1", sessionId: "session-1", turnId: "turn-1",
      role: "user", createdAt: "2026-08-16T00:00:00.000Z", content: "修复会话自动命名失败",
    }] })).resolves.toBe("修复会话自动命名失败");
  });

  it("does not leave the placeholder title behind when the title request fails", async () => {
    const workspaceRoot = await createWorkspace();
    const modelClient: ModelClient = {
      streamCompletion: async () => { throw new Error("provider unavailable"); },
    };
    const runtime = new GovernorRuntime({ workspaceRoot, modelClient });

    await expect(runtime.generateSessionTitle({ messages: [{
      recordType: "message", messageId: "message-1", sessionId: "session-1", turnId: "turn-1",
      role: "user", createdAt: "2026-08-16T00:00:00.000Z", content: "排查桌面端标题更新",
    }] })).resolves.toBe("排查桌面端标题更新");
  });
});
