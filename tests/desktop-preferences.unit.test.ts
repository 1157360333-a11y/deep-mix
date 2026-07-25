import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { afterEach, describe, expect, it } from "vitest";
import { GovernorRuntime, PromptCompiler } from "../packages/core-governor/src/index.js";
import {
  buildSessionTitleMessages,
  normalizeGeneratedSessionTitle,
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

    const title = await runtime.generateSessionTitle({
      userRequest: "会话不能再直接使用第一句话命名",
      assistantResponse: "已改为首轮完成后生成标题",
    });

    expect(title).toBe("修复桌面端会话命名");
    expect(requests).toHaveLength(1);
    expect(requests[0]).toMatchObject({
      systemPrompt: SESSION_TITLE_SYSTEM_PROMPT,
      stream: false,
      tools: [],
      route: { thinkingMode: { mode: "disabled", reasoningEffort: "not_applicable" } },
    });
    expect(requests[0]?.messages).toEqual(buildSessionTitleMessages({
      userRequest: "会话不能再直接使用第一句话命名",
      assistantResponse: "已改为首轮完成后生成标题",
    }));
  });
});
