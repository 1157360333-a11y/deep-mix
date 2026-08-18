import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";

import { afterEach, describe, expect, it, vi } from "vitest";

import { normalizeDeepSeekAssistantToolCalls } from "../packages/core-governor/src/deepseek-client.js";
import { GovernorRuntime } from "../packages/core-governor/src/index.js";
import { SessionStore } from "../packages/persistence/src/index.js";
import { resolveRoutingDecision } from "../packages/route-resolver/src/index.js";
import type {
  AssistantResponse,
  ModelClient,
  ModelCompletionRequest,
  StreamCallbacks,
} from "../packages/shared-schema/src/index.js";
import { ToolRuntime } from "../packages/tool-runtime/src/index.js";
import { applyArtifactPatch } from "../packages/tool-runtime/src/artifact-patch.js";
import type { ToolNetworkService } from "../packages/tool-runtime/src/network/index.js";

const temporaryRoots: string[] = [];

class ScriptedModelClient implements ModelClient {
  private index = 0;

  public readonly requests: ModelCompletionRequest[] = [];

  public constructor(
    private readonly responses: Array<AssistantResponse | ((request: ModelCompletionRequest) => AssistantResponse)>,
  ) {}

  public async streamCompletion(
    request: ModelCompletionRequest,
    callbacks?: StreamCallbacks,
  ): Promise<AssistantResponse> {
    this.requests.push(request);
    const entry = this.responses[this.index++];
    if (!entry) throw new Error(`Unexpected model call ${this.index}.`);
    const response = typeof entry === "function" ? entry(request) : entry;
    for (const character of response.content) callbacks?.onTextDelta?.(character);
    return response;
  }
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
  const session = await sessionStore.createSession("runtime reliability regression");
  return { workspaceRoot, sessionStore, sessionId: session.sessionId };
}

afterEach(async () => {
  await Promise.all(temporaryRoots.splice(0).map((root) => fs.rm(root, { recursive: true, force: true })));
});

describe("runtime reliability regressions from desktop session c6b32326", () => {
  it("routes multi-attachment document transformation to the governor instead of the coding worker", () => {
    const prompt = [
      "复刻 PDF 中的全部表格，换成参考 Word 的样式和红色底色，并输出可编辑 Word 文档。",
      "file://.deep-mix/desktop-attachments/imports/source.pdf",
      "file://.deep-mix/desktop-attachments/imports/reference.docx",
    ].join("\n");

    expect(resolveRoutingDecision({ prompt })).toMatchObject({
      finalTarget: "governor_direct",
      features: { isCrossFile: false, isComplexCodingTask: false },
    });
  });

  it("selects document readers, the DOCX writer, and a command fallback for the reproduction task", async () => {
    const { workspaceRoot, sessionStore } = await createWorkspace("deep-mix-document-tool-selection-");
    const prompt = [
      "复刻 PDF 中的全部表格，换成参考 Word 的样式和红色底色，并输出可编辑 Word 文档。",
      "[Desktop attachments]",
      "- source.pdf (document, application/pdf)",
      "- reference.docx (document, application/vnd.openxmlformats-officedocument.wordprocessingml.document)",
    ].join("\n");
    const runtime = new ToolRuntime({ workspaceRoot, sessionStore, permissionMode: "danger-full-access" });
    const selected = runtime.selectToolsForTurn({ prompt }).definitions.map((tool) => tool.name);

    expect(selected).toEqual(expect.arrayContaining(["read_pdf", "read_docx", "write_docx", "run_shell"]));
    expect(runtime.selectToolsForTurn({ prompt: "请读取 PDF 并总结。" }).definitions.map((tool) => tool.name))
      .not.toContain("run_shell");
  }, 15_000);

  it("normalizes leaked DSML into a native typed tool call", () => {
    const response = normalizeDeepSeekAssistantToolCalls([
      '<｜｜DSML｜｜tool_calls>',
      '<｜｜DSML｜｜invoke name="read_file">',
      '<｜｜DSML｜｜parameter name="maxChars" string="false">100</｜｜DSML｜｜parameter>',
      '<｜｜DSML｜｜parameter name="path" string="true">scripts/replicate.py</｜｜DSML｜｜parameter>',
      '</｜｜DSML｜｜invoke>',
      '</｜｜DSML｜｜tool_calls>',
    ].join("\n"), []);

    expect(response.content).toBe("");
    expect(response.toolCalls).toEqual([
      expect.objectContaining({
        name: "read_file",
        arguments: { maxChars: 100, path: "scripts/replicate.py" },
        rawArguments: JSON.stringify({ maxChars: 100, path: "scripts/replicate.py" }),
      }),
    ]);
  });

  it("removes DSML even when a provider also returns native tool calls", () => {
    const native = {
      id: "native-call",
      name: "list_files",
      arguments: { cwd: "." },
      rawArguments: JSON.stringify({ cwd: "." }),
    };
    const response = normalizeDeepSeekAssistantToolCalls([
      "准备检查。",
      '<｜｜DSML｜｜tool_calls><｜｜DSML｜｜invoke name="search_files">',
      '<｜｜DSML｜｜parameter name="pattern" string="true">onStreamText</｜｜DSML｜｜parameter>',
      "</｜｜DSML｜｜invoke></｜｜DSML｜｜tool_calls>",
    ].join("\n"), [native]);

    expect(response.content).toBe("准备检查。");
    expect(response.content).not.toContain("DSML");
    expect(response.toolCalls).toEqual([
      native,
      expect.objectContaining({ name: "search_files", arguments: { pattern: "onStreamText" } }),
    ]);
  });

  it("replays reasoning_content for tool-call history and publishes the authoritative workspace", async () => {
    const { workspaceRoot } = await createWorkspace("deep-mix-reasoning-replay-");
    await fs.writeFile(path.join(workspaceRoot, "source.ts"), "export const ok = true;\n", "utf8");
    const client = new ScriptedModelClient([
      {
        content: "",
        toolCalls: [{
          id: "missing-reasoning-tool-call",
          name: "list_files",
          arguments: { cwd: ".", maxDepth: 1 },
          rawArguments: JSON.stringify({ cwd: ".", maxDepth: 1 }),
        }],
      },
      (request) => {
        const assistant = request.messages.find((message) => message.role === "assistant" && message.tool_calls?.length);
        expect(assistant?.reasoning_content).toBe("");
        expect(request.systemPrompt).toContain(`root=${workspaceRoot}`);
        expect(request.systemPrompt).toContain("Use '.' or paths relative to this root");
        return { content: "Repository inspection completed.", toolCalls: [] };
      },
    ]);
    const runtime = new GovernorRuntime({ workspaceRoot, permissionMode: "danger-full-access", modelClient: client });

    await expect(runtime.runTurn({ prompt: "Inspect the local TypeScript source." })).resolves.toMatchObject({
      finalResponse: "Repository inspection completed.",
    });
  }, 15_000);

  it("accepts small read_file maxChars values and explains stale absolute workspace paths", async () => {
    const { workspaceRoot, sessionStore, sessionId } = await createWorkspace("deep-mix-tool-args-");
    await fs.writeFile(path.join(workspaceRoot, "note.txt"), "0123456789".repeat(20), "utf8");
    const runtime = new ToolRuntime({ workspaceRoot, sessionStore, permissionMode: "danger-full-access" });

    const smallRead = await runtime.executeManualTool("read_file", { path: "note.txt", maxChars: 50 }, sessionId);
    expect(smallRead.success).toBe(true);
    const stalePath = path.join(os.tmpdir(), "different-workspace");
    const rejected = await runtime.executeManualTool("list_files", { cwd: stalePath }, sessionId);
    expect(rejected).toMatchObject({ success: false });
    const rejectedPayload = JSON.parse(rejected.output) as {
      error?: { type?: string; message?: string; retryable?: boolean; toolName?: string };
    };
    expect(rejectedPayload.error).toMatchObject({
      type: "invalid_path",
      retryable: false,
      toolName: "list_files",
    });
    expect(rejectedPayload.error?.message).toContain(`Path escapes workspace root (${workspaceRoot})`);
    expect(rejectedPayload.error?.message).toContain("Retry with '.' or a path relative to the current workspace");
  }, 15_000);

  it("prevents duplicate and destructive whole-file writes while supporting surgical atomic edits", async () => {
    const { workspaceRoot, sessionStore, sessionId } = await createWorkspace("deep-mix-safe-apply-patch-");
    const original = [
      "# README",
      "upload_limit=50MB",
      "directory_tree=old",
      ...Array.from({ length: 200 }, (_, index) => `documentation line ${index + 1}`),
      "",
    ].join("\n");
    const target = path.join(workspaceRoot, "README.md");
    await fs.writeFile(target, original, "utf8");
    const runtime = new ToolRuntime({ workspaceRoot, sessionStore, permissionMode: "danger-full-access" });

    const duplicate = await runtime.executeManualTool("apply_patch", {
      changes: [
        { path: "README.md", action: "upsert", content: "first partial body\n" },
        { path: "README.md", action: "upsert", content: "last line wins\n" },
      ],
    }, sessionId);
    expect(duplicate.success).toBe(false);
    expect(duplicate.output).toContain("rejects duplicate target paths");
    await expect(fs.readFile(target, "utf8")).resolves.toBe(original);

    const destructive = await runtime.executeManualTool("apply_patch", {
      changes: [{ path: "README.md", action: "upsert", content: "one line\n" }],
    }, sessionId);
    expect(destructive.success).toBe(false);
    expect(destructive.output).toContain("blocked a destructive replacement");
    expect(destructive.output).toContain("replace_text");
    await expect(fs.readFile(target, "utf8")).resolves.toBe(original);

    const surgical = await runtime.executeManualTool("apply_patch", {
      changes: [{
        path: "README.md",
        action: "replace_text",
        replacements: [
          { oldText: "upload_limit=50MB", newText: "upload_limit=1GB" },
          { oldText: "directory_tree=old", newText: "directory_tree=new" },
        ],
      }],
    }, sessionId);
    expect(surgical.success).toBe(true);
    const updated = await fs.readFile(target, "utf8");
    expect(updated).toContain("upload_limit=1GB");
    expect(updated).toContain("directory_tree=new");
    expect(updated).toContain("documentation line 200");
    const surgicalBody = JSON.parse(surgical.output) as {
      changes?: Array<{ path?: string; action?: string; atomic?: boolean; beforeChars?: number; afterChars?: number }>;
    };
    expect(surgicalBody.changes).toEqual([expect.objectContaining({
      path: "README.md",
      action: "replace_text",
      atomic: true,
      beforeChars: original.length,
      afterChars: updated.length,
    })]);

    const metadata = await runtime.executeManualTool(
      "file_metadata",
      { path: "README.md", includeHash: true, hashMaxBytes: 1_000_000 },
      sessionId,
    );
    const currentSha256 = (metadata.structuredContent as {
      hash?: { computed?: boolean; value?: string };
    }).hash?.value;
    expect(currentSha256).toMatch(/^[a-f0-9]{64}$/u);
    const intentionalReplacement = await runtime.executeManualTool("apply_patch", {
      changes: [{
        path: "README.md",
        action: "upsert",
        content: "intentional replacement\n",
        allowDestructiveReplace: true,
        expectedSha256: currentSha256,
      }],
    }, sessionId);
    expect(intentionalReplacement.success).toBe(true);
    await expect(fs.readFile(target, "utf8")).resolves.toBe("intentional replacement\n");
    expect((await fs.readdir(workspaceRoot)).filter((entry) => /\.deep-mix\.(?:tmp|bak)$/u.test(entry))).toEqual([]);
  }, 30_000);

  it("matches multiline replace_text anchors across CRLF, LF, and CR while preserving each target style", async () => {
    const { workspaceRoot, sessionStore, sessionId } = await createWorkspace("deep-mix-patch-line-endings-");
    const crlfPath = path.join(workspaceRoot, "crlf.txt");
    const lfPath = path.join(workspaceRoot, "lf.txt");
    const crPath = path.join(workspaceRoot, "cr.txt");
    await fs.writeFile(crlfPath, "alpha\r\nbeta\r\ngamma\r\n", "utf8");
    await fs.writeFile(lfPath, "one\ntwo\nthree\n", "utf8");
    await fs.writeFile(crPath, "red\rgreen\rblue\r", "utf8");
    const runtime = new ToolRuntime({ workspaceRoot, sessionStore, permissionMode: "danger-full-access" });

    const observed = await runtime.executeManualTool("read_file", { path: "crlf.txt" }, sessionId);
    expect(observed.success).toBe(true);
    expect(observed.output).toContain("1 | alpha\n   2 | beta");
    expect(observed.output).not.toContain("\r");

    const result = await runtime.executeManualTool("apply_patch", {
      changes: [
        {
          path: "crlf.txt",
          action: "replace_text",
          replacements: [{ oldText: "alpha\nbeta", newText: "alpha\nBETA\ninserted" }],
        },
        {
          path: "lf.txt",
          action: "replace_text",
          replacements: [{ oldText: "one\r\ntwo", newText: "ONE\r\nTWO\r\ninserted" }],
        },
        {
          path: "cr.txt",
          action: "replace_text",
          replacements: [{ oldText: "red\ngreen", newText: "RED\nGREEN" }],
        },
      ],
    }, sessionId);

    expect(result.success).toBe(true);
    await expect(fs.readFile(crlfPath, "utf8")).resolves.toBe("alpha\r\nBETA\r\ninserted\r\ngamma\r\n");
    await expect(fs.readFile(lfPath, "utf8")).resolves.toBe("ONE\nTWO\ninserted\nthree\n");
    await expect(fs.readFile(crPath, "utf8")).resolves.toBe("RED\rGREEN\rblue\r");
    const body = JSON.parse(result.output) as {
      changes?: Array<{
        lineEndingNormalizedMatches?: number;
        lineEndingAdjustedReplacements?: number;
      }>;
    };
    expect(body.changes).toEqual([
      expect.objectContaining({ lineEndingNormalizedMatches: 1, lineEndingAdjustedReplacements: 1 }),
      expect.objectContaining({ lineEndingNormalizedMatches: 1, lineEndingAdjustedReplacements: 1 }),
      expect.objectContaining({ lineEndingNormalizedMatches: 1, lineEndingAdjustedReplacements: 1 }),
    ]);
  }, 30_000);

  it("keeps mixed-line-ending anchors unambiguous and preserves each matched region on replaceAll", async () => {
    const { workspaceRoot, sessionStore, sessionId } = await createWorkspace("deep-mix-patch-mixed-line-endings-");
    const mixedPath = path.join(workspaceRoot, "mixed.txt");
    const dominantPath = path.join(workspaceRoot, "dominant-crlf.txt");
    const manyPath = path.join(workspaceRoot, "many-crlf.txt");
    const mixed = "head\r\nsame\r\nmiddle\nsame\nend\r\n";
    const many = Array.from({ length: 1_000 }, () => "item\r\n").join("");
    await fs.writeFile(mixedPath, mixed, "utf8");
    await fs.writeFile(dominantPath, "head\r\nanchor\r\ntail\r\n", "utf8");
    await fs.writeFile(manyPath, many, "utf8");
    const runtime = new ToolRuntime({ workspaceRoot, sessionStore, permissionMode: "danger-full-access" });

    const ambiguous = await runtime.executeManualTool("apply_patch", {
      changes: [{
        path: "mixed.txt",
        action: "replace_text",
        replacements: [{ oldText: "same\n", newText: "changed\n", expectedOccurrences: 1 }],
      }],
    }, sessionId);
    expect(ambiguous.success).toBe(false);
    expect(ambiguous.output).toContain("found 2");
    expect(ambiguous.output).toContain("CRLF, LF, and CR line endings as equivalent");
    await expect(fs.readFile(mixedPath, "utf8")).resolves.toBe(mixed);

    const result = await runtime.executeManualTool("apply_patch", {
      changes: [
        {
          path: "mixed.txt",
          action: "replace_text",
          replacements: [{
            oldText: "same\n",
            newText: "renamed\nextra\n",
            expectedOccurrences: 2,
            replaceAll: true,
          }],
        },
        {
          path: "dominant-crlf.txt",
          action: "replace_text",
          replacements: [{ oldText: "anchor", newText: "first\nsecond" }],
        },
        {
          path: "many-crlf.txt",
          action: "replace_text",
          replacements: [{
            oldText: "item\n",
            newText: "updated\n",
            expectedOccurrences: 1_000,
            replaceAll: true,
          }],
        },
      ],
    }, sessionId);

    expect(result.success).toBe(true);
    await expect(fs.readFile(mixedPath, "utf8")).resolves.toBe(
      "head\r\nrenamed\r\nextra\r\nmiddle\nrenamed\nextra\nend\r\n",
    );
    await expect(fs.readFile(dominantPath, "utf8")).resolves.toBe(
      "head\r\nfirst\r\nsecond\r\ntail\r\n",
    );
    await expect(fs.readFile(manyPath, "utf8")).resolves.toBe(
      Array.from({ length: 1_000 }, () => "updated\r\n").join(""),
    );
    const body = JSON.parse(result.output) as {
      changes?: Array<{
        lineEndingNormalizedMatches?: number;
        lineEndingAdjustedReplacements?: number;
      }>;
    };
    expect(body.changes).toEqual([
      expect.objectContaining({ lineEndingNormalizedMatches: 1, lineEndingAdjustedReplacements: 1 }),
      expect.objectContaining({ lineEndingNormalizedMatches: 0, lineEndingAdjustedReplacements: 1 }),
      expect.objectContaining({ lineEndingNormalizedMatches: 1_000, lineEndingAdjustedReplacements: 1_000 }),
    ]);
  }, 30_000);

  it("preflights every accepted artifact hunk before publishing any source file", async () => {
    const { workspaceRoot } = await createWorkspace("deep-mix-artifact-patch-preflight-");
    const firstPath = path.join(workspaceRoot, "first.txt");
    const secondPath = path.join(workspaceRoot, "second.txt");
    await fs.writeFile(firstPath, "first old\n", "utf8");
    await fs.writeFile(secondPath, "second old\n", "utf8");
    const patch = [
      "*** Begin Patch",
      "*** Update File: first.txt",
      "@@",
      "-first old",
      "+first new",
      "*** Update File: second.txt",
      "@@",
      "-anchor that does not exist",
      "+second new",
      "*** End Patch",
    ].join("\n");

    await expect(applyArtifactPatch(workspaceRoot, patch)).rejects.toThrow("Failed to match patch hunk in second.txt");
    await expect(fs.readFile(firstPath, "utf8")).resolves.toBe("first old\n");
    await expect(fs.readFile(secondPath, "utf8")).resolves.toBe("second old\n");
  });

  it("recovers a Provider timeout at a tool-cycle boundary instead of failing the turn", async () => {
    const { workspaceRoot, sessionStore } = await createWorkspace("deep-mix-boundary-timeout-");
    await fs.writeFile(path.join(workspaceRoot, "note.txt"), "0123456789".repeat(100), "utf8");
    const responses: Array<AssistantResponse | ((request: ModelCompletionRequest) => AssistantResponse)> =
      Array.from({ length: 12 }, (_, index) => ({
        content: "",
        toolCalls: [{
          id: `boundary-read-${index + 1}`,
          name: "read_file",
          arguments: { path: "note.txt", maxChars: 100 + index },
          rawArguments: JSON.stringify({ path: "note.txt", maxChars: 100 + index }),
        }],
      }));
    responses.push((request) => {
      expect(request.tools).toHaveLength(0);
      expect(request.maxOutputTokens).toBe(2_048);
      expect(request.inactivityTimeoutMs).toBe(60_000);
      throw new DOMException("The operation was aborted due to timeout", "TimeoutError");
    });
    responses.push((request) => {
      expect(request.tools.length).toBeGreaterThan(0);
      return { content: "超时后已从持久化工具结果继续并完成任务。", toolCalls: [] };
    });
    const client = new ScriptedModelClient(responses);
    const runtime = new GovernorRuntime({ workspaceRoot, permissionMode: "danger-full-access", modelClient: client });

    const result = await runtime.runTurn({ prompt: "持续读取 note.txt 完成一次长工具任务。" });

    expect(result.finalResponse).toBe("超时后已从持久化工具结果继续并完成任务。");
    expect(client.requests).toHaveLength(14);
    const events = await sessionStore.loadEvents(result.sessionId);
    expect(events).toEqual(expect.arrayContaining([expect.objectContaining({
      recordType: "context_summary",
      sourceType: "tool_cycle_checkpoint",
      summary: expect.stringContaining("边界响应发生空闲超时"),
    })]));
    expect(events.some((event) => event.recordType === "turn" && event.status === "failed")).toBe(false);
  }, 30_000);

  it("continues a normal turn after an incomplete Provider stream becomes idle", async () => {
    const { workspaceRoot, sessionStore } = await createWorkspace("deep-mix-provider-stream-recovery-");
    let calls = 0;
    const client: ModelClient = {
      async streamCompletion(request, callbacks) {
        calls += 1;
        if (calls === 1) {
          callbacks?.onTextDelta?.("已输出但尚未完成的片段。\n");
          throw new DOMException("DeepSeek request received no data for 600000 ms.", "TimeoutError");
        }
        const recoveryContext = request.messages
          .filter((message) => message.role === "system")
          .map((message) => message.content ?? "")
          .join("\n");
        expect(recoveryContext).toContain("Provider Stream Recovery Required");
        expect(recoveryContext).toContain("no incomplete tool call");
        expect(callbacks).toBeUndefined();
        return { content: "已从持久化进度继续并完成。", toolCalls: [] };
      },
    };
    const streamed: string[] = [];
    const runtime = new GovernorRuntime({ workspaceRoot, permissionMode: "danger-full-access", modelClient: client });

    const result = await runtime.runTurn({
      prompt: "完成一个可能产生较长响应的任务。",
      callbacks: { onTextDelta: (chunk) => streamed.push(chunk) },
    });

    expect(calls).toBe(2);
    expect(result.finalResponse).toBe("已从持久化进度继续并完成。");
    expect(streamed.join("")).toBe("已输出但尚未完成的片段。\n已从持久化进度继续并完成。");
    const events = await sessionStore.loadEvents(result.sessionId);
    expect(events.some((event) => event.recordType === "turn" && event.status === "failed")).toBe(false);
    expect(events).toEqual(expect.arrayContaining([expect.objectContaining({
      recordType: "message",
      role: "assistant",
      metadata: expect.objectContaining({ providerTimeoutRecoveryAttempts: 1 }),
    })]));
  }, 30_000);

  it("does not accept a recoverable tool failure as a reason to abandon the task", async () => {
    const { workspaceRoot } = await createWorkspace("deep-mix-autonomous-recovery-");
    const client = new ScriptedModelClient([
      {
        content: "",
        toolCalls: [{
          id: "failing-command-call",
          name: "run_shell",
          arguments: { command: "deep-mix-command-that-does-not-exist" },
          rawArguments: JSON.stringify({ command: "deep-mix-command-that-does-not-exist" }),
        }],
      },
      { content: "这个能力被禁用了，请你手动运行。", toolCalls: [] },
      (request) => {
        expect(request.messages.some((message) =>
          message.role === "system" && message.content?.includes("Runtime Recovery Required"))).toBe(true);
        return { content: "已改用当前可用工具继续处理。", toolCalls: [] };
      },
    ]);
    const streamed: string[] = [];
    const runtime = new GovernorRuntime({ workspaceRoot, permissionMode: "danger-full-access", modelClient: client });

    const result = await runtime.runTurn({
      prompt: "运行本地命令检查并在失败后改用其他可用工具继续处理。",
      callbacks: { onTextDelta: (chunk) => streamed.push(chunk) },
    });

    expect(client.requests).toHaveLength(3);
    expect(result.finalResponse).toBe("已改用当前可用工具继续处理。");
    expect(streamed.join("")).not.toContain("被禁用了");
  }, 15_000);

  it("rejects an identical web search immediately after its internal strategies are exhausted", async () => {
    const { workspaceRoot } = await createWorkspace("deep-mix-web-search-convergence-");
    const networkRequest = vi.fn().mockRejectedValue(Object.assign(new Error("connection refused"), {
      code: "ECONNREFUSED",
    }));
    const networkService: ToolNetworkService = {
      plan: async () => ({
        routes: [
          { route: "system", source: "windows_system" },
          { route: "direct", source: "direct" },
        ],
        systemRouteDistinct: true,
      }),
      request: networkRequest,
      dispose: async () => undefined,
    };
    const searchCall = (id: string) => ({
      id,
      name: "web_search",
      arguments: { query: "Deep-Mix latest release" },
      rawArguments: JSON.stringify({ query: "Deep-Mix latest release" }),
    });
    const client = new ScriptedModelClient([
      { content: "", toolCalls: [searchCall("search-first")] },
      (request) => {
        expect(request.messages.some((message) => message.role === "tool" && (message.content ?? "").includes("retryable=false"))).toBe(false);
        expect(request.messages.some((message) => message.role === "tool" && (message.content ?? "").includes("do not repeat the identical call"))).toBe(true);
        return { content: "", toolCalls: [searchCall("search-repeat")] };
      },
      (request) => {
        expect(request.messages.some((message) => message.role === "tool" && (message.content ?? "").includes("repeated_tool_call"))).toBe(true);
        return { content: "搜索网络路径已全部尝试，未机械重复请求。", toolCalls: [] };
      },
    ]);
    const runtime = new GovernorRuntime({
      workspaceRoot,
      permissionMode: "danger-full-access",
      environment: { ...process.env, BRAVE_SEARCH_API_KEY: "test-key" },
      networkService,
      modelClient: client,
    });

    const result = await runtime.runTurn({ prompt: "请联网搜索 Deep-Mix 最新发布信息。" });

    expect(result.finalResponse).toBe("搜索网络路径已全部尝试，未机械重复请求。");
    expect(client.requests).toHaveLength(3);
    expect(networkRequest).toHaveBeenCalledTimes(4);
    const sessionStore = new SessionStore(workspaceRoot);
    const events = await sessionStore.loadEvents(result.sessionId);
    const rejectedToolMessage = events.find((event) => (
      event.recordType === "message"
      && event.role === "tool"
      && event.toolCallId === "search-repeat"
    ));
    const rejectedToolMetadata = rejectedToolMessage && "metadata" in rejectedToolMessage
      ? rejectedToolMessage.metadata
      : undefined;
    expect(rejectedToolMetadata).toMatchObject({
      errorType: "repeated_tool_call",
      startedAt: expect.any(String),
      endedAt: expect.any(String),
    });
  }, 20_000);
});
