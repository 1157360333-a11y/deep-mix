import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import { PassThrough } from "node:stream";
import { afterEach, describe, expect, it } from "vitest";
import {
  CliSessionShell,
  formatToolOutputArtifactLines,
  type CliInteractivePromptReader,
  type CliRuntimeSurface,
  type CliShellApprovalView,
  type CliShellHeaderSnapshot,
  type CliShellInputContext,
  type CliShellSessionSnapshot,
  type CliUiOutputWriter,
  readProfileStatus,
} from "../apps/cli/src/session-shell.js";
import {
  createInitialTerminalTuiState,
  renderTerminalTui,
  stripAnsiForTest,
} from "../apps/cli/src/terminal-tui-renderer.js";
import { createTerminalTui, detectTerminalTuiSupport } from "../apps/cli/src/terminal-tui.js";
import { GovernorRuntime } from "../packages/core-governor/src/index.js";
import { SessionStore } from "../packages/persistence/src/index.js";
import type {
  AssistantResponse,
  ModelClient,
  ModelCompletionRequest,
  RuntimeCapabilitySnapshot,
  StreamCallbacks,
  ToolOutputArtifact,
  ToolResult,
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

class ScriptedInput implements CliInteractivePromptReader {
  private index = 0;

  public readonly contexts: CliShellInputContext[] = [];

  public constructor(private readonly values: Array<string | undefined>) {}

  public setContext(context: CliShellInputContext): void {
    this.contexts.push(context);
  }

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

class UiRecorder implements CliUiOutputWriter {
  public buffer = "";

  public header?: CliShellHeaderSnapshot;

  public snapshots: CliShellSessionSnapshot[] = [];

  public userEntries: Array<{ text: string; kind: "prompt" | "command" }> = [];

  public systemMessages: Array<{ text: string; tone?: "info" | "success" | "warning" | "error" }> = [];

  public commandResults: Array<{
    command: string;
    text: string;
    tone?: "info" | "success" | "warning" | "error";
  }> = [];

  public toolStarts: string[] = [];

  public toolEnds: Array<{
    toolName: string;
    success: boolean;
    fallback?: string;
    artifacts?: readonly ToolOutputArtifact[];
  }> = [];

  public approvals: CliShellApprovalView[] = [];

  public clearedApprovals = 0;

  public helpVisible: boolean[] = [];

  public assistantChunkCount = 0;

  public write(text: string): void {
    this.buffer += text;
  }

  public setHeader(header: CliShellHeaderSnapshot): void {
    this.header = header;
  }

  public updateSnapshot(snapshot: CliShellSessionSnapshot): void {
    this.snapshots.push(snapshot);
  }

  public recordUserEntry(text: string, kind: "prompt" | "command"): void {
    this.userEntries.push({ text, kind });
  }

  public startAssistantMessage(): void {}

  public appendAssistantText(): void {
    this.assistantChunkCount += 1;
  }

  public completeAssistantMessage(): void {}

  public recordSystemMessage(text: string, tone?: "info" | "success" | "warning" | "error"): void {
    this.systemMessages.push({ text, tone });
  }

  public recordCommandResult(
    command: string,
    text: string,
    tone?: "info" | "success" | "warning" | "error",
  ): void {
    this.commandResults.push({ command, text, tone });
  }

  public recordToolStart(toolName: string): void {
    this.toolStarts.push(toolName);
  }

  public recordToolEnd(
    toolName: string,
    success: boolean,
    fallback?: string,
    artifacts?: readonly ToolOutputArtifact[],
  ): void {
    this.toolEnds.push({ toolName, success, fallback, artifacts });
  }

  public showApproval(approval: CliShellApprovalView): void {
    this.approvals.push(approval);
  }

  public clearApproval(): void {
    this.clearedApprovals += 1;
  }

  public setHelpVisible(visible: boolean): void {
    this.helpVisible.push(visible);
  }
}

class FakeTerminalInput extends PassThrough {
  public isTTY = true;

  public readonly rawModeChanges: boolean[] = [];

  public pauseCount = 0;

  public setRawMode(enabled: boolean): void {
    this.rawModeChanges.push(enabled);
  }

  public override pause(): this {
    this.pauseCount += 1;
    return super.pause();
  }
}

class FakeTerminalOutput extends PassThrough {
  public isTTY = true;

  public columns = 60;

  public rows = 16;

  public buffer = "";

  public override write(
    chunk: string | Uint8Array,
    encoding?: BufferEncoding | ((error?: Error | null) => void),
    callback?: (error?: Error | null) => void,
  ): boolean {
    const text = typeof chunk === "string" ? chunk : Buffer.from(chunk).toString("utf8");
    this.buffer += text;
    if (typeof encoding === "function") {
      encoding();
    } else if (typeof callback === "function") {
      callback();
    }
    return true;
  }
}

async function waitForRender(): Promise<void> {
  await new Promise((resolve) => setTimeout(resolve, 40));
}

function lastRenderedFrame(output: FakeTerminalOutput): string {
  return stripAnsiForTest(output.buffer.split("\x1b[H\x1b[2J").at(-1) ?? output.buffer);
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

function createCapabilitySnapshot(): RuntimeCapabilitySnapshot {
  return {
    checkedAt: "2026-07-09T00:00:00.000Z",
    capabilities: {
      rg: {
        name: "rg",
        available: false,
        command: "rg.exe",
        errorType: "missing_dependency",
        message: "missing",
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
      listFiles: "node_fs",
      searchFiles: "node_text",
    },
  };
}

function createToolOutputArtifact(
  overrides: Partial<ToolOutputArtifact> = {},
): ToolOutputArtifact {
  return {
    uri: "artifact://tool-outputs/session-1/turn-1/report.pdf",
    fileName: "report.pdf",
    mimeType: "application/pdf",
    sizeBytes: 1024,
    kind: "document",
    sourceToolName: "custom_document_exporter",
    summary: "Generated report",
    createdAt: "2026-07-11T00:00:00.000Z",
    ...overrides,
  };
}

afterEach(async () => {
  await Promise.all(
    temporaryRoots.splice(0).map(async (root) => {
      await fs.rm(root, { recursive: true, force: true });
    }),
  );
});

describe("phase 12 CLI TUI productization", () => {
  it("renders a compact brand shell with a fixed input box and a message-first welcome state", () => {
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
    state.cliState = "awaiting_user_input";
    state.sessionId = "session-12345678";
    state.sessionStatus = "waiting_for_user";
    state.routeSummary = "Automatic routing";
    state.fallbackSummary = "list:node_fs | search:node_text";
    state.workerSummary = "No worker activity yet.";

    const frame = renderTerminalTui(state, { columns: 140, rows: 16 });
    const rendered = stripAnsiForTest(frame.output);

    expect(rendered).toContain("Deep-Mix");
    expect(rendered).toContain("workspace");
    expect(rendered).toContain("开始输入你的任务");
    expect(rendered).toContain("F1");
    expect(rendered).toContain("Ctrl+B");
    expect(rendered).toContain("直接输入你的任务");

    const welcomeLines = rendered.split("\n").slice(4, 9);
    expect(welcomeLines).toHaveLength(5);
    expect(welcomeLines.map((line) => line.slice(0, 10))).toEqual([
      "    ████  ",
      "  ████████",
      "██████████",
      "  ████████",
      "    ████  ",
    ]);
    const terminalWidth = (line: string): number =>
      Array.from(line).reduce((width, char) => width + (/^[\u3400-\u9fff]$/u.test(char) ? 2 : 1), 0);
    expect(welcomeLines.map(terminalWidth)).toEqual([139, 139, 139, 139, 139]);
  });

  it("collapses tool activity into a compact thinking state and keeps approval visible near the input", () => {
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
    state.cliState = "awaiting_approval";
    state.sessionId = "session-12345678";
    state.sessionStatus = "ask_permission";
    state.routeSummary = "Complex coding task routed to glm_coding.";
    state.fallbackSummary = "list:node_fs | search:node_text";
    state.workerSummary = "coding | running";
    state.messages = [
      {
        id: "u1",
        kind: "user",
        title: "You",
        content: "帮我看一下仓库结构",
      },
      {
        id: "a1",
        kind: "assistant",
        title: "Deep-Mix",
        content: "我先检查几个关键文件。",
        streaming: true,
      },
    ];
    state.currentTool = {
      name: "run_shell",
      status: "running",
      fallback: "node_text",
    };
    state.recentTools = [
      {
        name: "list_files",
        status: "ok",
      },
    ];
    state.approval = {
      toolName: "run_shell",
      actionLabel: "execute command",
      requestKey: "shell:Write-Output",
      riskLabel: "medium",
      reason: "run_shell requires explicit approval in auto mode.",
    };
    state.input = {
      mode: "approval",
      value: "",
      cursor: 0,
      placeholder: "Press 1, 2, or 3.",
      submitHint: "1 once  2 session  3 deny",
      promptText: "approval> ",
    };
    state.activity = {
      mode: "thinking",
      label: "正在思考",
      detail: "执行命令",
      frame: 1,
    };

    const frame = renderTerminalTui(state, { columns: 140, rows: 36 });
    const rendered = stripAnsiForTest(frame.output);

    expect(rendered).toContain("正在思考");
    expect(rendered).toContain("run_shell");
    expect(rendered).toContain("1 仅本次");
    expect(rendered).toContain("ask_permission");
    expect(rendered).toContain("帮我看一下仓库结构");
    expect(rendered).toContain("我先检查几个关键文件");
  });

  it("keeps live stages in order, then collapses the whole process while preserving duration and the final summary", async () => {
    const stdin = new FakeTerminalInput();
    const stdout = new FakeTerminalOutput();
    stdout.columns = 120;
    stdout.rows = 80;
    const tui = createTerminalTui(stdin, stdout);

    tui.output.recordUserEntry?.("完成两轮检查并总结。", "prompt");
    tui.output.startAssistantMessage?.();
    tui.output.appendAssistantText?.("先检查文件。 ");
    tui.output.recordToolBatchStart?.("assistant-batch-1", [{ id: "call-1", name: "read_file" }]);
    tui.output.recordToolStart?.("read_file", "call-1");
    tui.output.recordToolEnd?.("read_file", true, undefined, undefined, {
      toolName: "read_file",
      callId: "call-1",
      startedAt: "2026-07-18T00:00:00.000Z",
      endedAt: "2026-07-18T00:00:01.000Z",
      success: true,
      output: "alpha-output",
    });
    tui.output.appendAssistantText?.("第一轮完成，继续验证。 ");
    tui.output.recordToolBatchStart?.("assistant-batch-2", [{ id: "call-2", name: "run_tests" }]);
    tui.output.recordToolStart?.("run_tests", "call-2");
    tui.output.recordToolEnd?.("run_tests", true, undefined, undefined, {
      toolName: "run_tests",
      callId: "call-2",
      startedAt: "2026-07-18T00:00:02.000Z",
      endedAt: "2026-07-18T00:00:04.000Z",
      success: true,
      output: "2 tests passed",
    });
    tui.output.appendAssistantText?.("最终总结：两轮检查均通过。");
    tui.output.completeAssistantMessage?.();
    tui.output.completeTaskPresentation?.(321_000);
    await waitForRender();

    const collapsed = lastRenderedFrame(stdout);
    expect(collapsed).toContain("已处理 5m 21s");
    expect(collapsed).toContain("2 轮工具");
    expect(collapsed).toContain("最终总结：两轮检查均通过。");
    expect(collapsed.indexOf("已处理 5m 21s")).toBeLessThan(collapsed.indexOf("最终总结：两轮检查均通过。"));
    expect(collapsed).not.toContain("先检查文件");
    expect(collapsed).not.toContain("第一轮完成，继续验证");
    expect(collapsed).not.toContain("alpha-output");

    tui.output.toggleToolDetails?.();
    await waitForRender();
    const expandedProcess = lastRenderedFrame(stdout);
    const firstStage = expandedProcess.indexOf("先检查文件");
    const firstBatch = expandedProcess.indexOf("工具调用 1");
    const secondStage = expandedProcess.indexOf("第一轮完成，继续验证");
    const secondBatch = expandedProcess.indexOf("工具调用 2");
    const finalSummary = expandedProcess.indexOf("最终总结：两轮检查均通过。");
    expect(firstStage).toBeGreaterThanOrEqual(0);
    expect(firstStage).toBeLessThan(firstBatch);
    expect(firstBatch).toBeLessThan(secondStage);
    expect(secondStage).toBeLessThan(secondBatch);
    expect(secondBatch).toBeLessThan(finalSummary);
    expect(expandedProcess).not.toContain("alpha-output");

    tui.output.toggleToolDetails?.(1);
    await waitForRender();
    expect(lastRenderedFrame(stdout)).toContain("alpha-output");
    tui.close();
  });

  it("keeps consecutive provider tool batches separate even when no assistant text appears between them", async () => {
    const stdin = new FakeTerminalInput();
    const stdout = new FakeTerminalOutput();
    stdout.columns = 100;
    stdout.rows = 48;
    const tui = createTerminalTui(stdin, stdout);
    tui.output.recordUserEntry?.("连续执行两批工具。", "prompt");

    tui.output.recordToolBatchStart?.("batch-without-text-1", [{ id: "silent-call-1", name: "list_files" }]);
    tui.output.recordToolStart?.("list_files", "silent-call-1");
    tui.output.recordToolEnd?.("list_files", true, undefined, undefined, {
      toolName: "list_files",
      callId: "silent-call-1",
      startedAt: "2026-07-18T00:00:00.000Z",
      endedAt: "2026-07-18T00:00:01.000Z",
      success: true,
      output: "first batch",
    });
    tui.output.recordToolBatchStart?.("batch-without-text-2", [{ id: "silent-call-2", name: "search_files" }]);
    tui.output.recordToolStart?.("search_files", "silent-call-2");
    tui.output.recordToolEnd?.("search_files", true, undefined, undefined, {
      toolName: "search_files",
      callId: "silent-call-2",
      startedAt: "2026-07-18T00:00:01.000Z",
      endedAt: "2026-07-18T00:00:02.000Z",
      success: true,
      output: "second batch",
    });
    tui.output.appendAssistantText?.("最终总结：两批工具均完成。");
    tui.output.completeAssistantMessage?.();
    tui.output.completeTaskPresentation?.(2_000);
    tui.output.toggleToolDetails?.();
    await waitForRender();

    const rendered = lastRenderedFrame(stdout);
    expect(rendered).toContain("2 轮工具");
    expect(rendered.indexOf("工具调用 1")).toBeLessThan(rendered.indexOf("工具调用 2"));
    expect(rendered.indexOf("工具调用 2")).toBeLessThan(rendered.indexOf("最终总结：两批工具均完成。"));
    tui.close();
  });

  it("keeps a recovered batch idempotent and marks only its unresolved member as running", async () => {
    const stdin = new FakeTerminalInput();
    const stdout = new FakeTerminalOutput();
    stdout.columns = 100;
    stdout.rows = 36;
    const tui = createTerminalTui(stdin, stdout);

    const pendingCalls = [{ id: "pending-shell", name: "run_shell" }];
    tui.output.recordToolBatchStart?.("persisted-assistant-batch", pendingCalls);
    tui.output.recordToolBatchStart?.("persisted-assistant-batch", pendingCalls);
    tui.output.recordToolStart?.("run_shell", "pending-shell");
    tui.output.toggleToolDetails?.(1);
    await waitForRender();

    const rendered = lastRenderedFrame(stdout);
    expect(rendered).toContain("工具调用 1 · 运行中 · 1 项");
    expect(rendered).toContain("run_shell");
    expect(rendered).not.toContain("运行中 · 2 项");
    expect(rendered).not.toContain("read_file");
    tui.close();
  });

  it("supports internal message scrollback so long conversations stay reviewable", () => {
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
    state.messages = Array.from({ length: 18 }, (_, index) => ({
      id: `m${index}`,
      kind: index % 2 === 0 ? "user" : "assistant",
      title: "msg",
      content: `message-${index}`,
    }));
    state.messageScrollOffset = 12;

    const frame = renderTerminalTui(state, { columns: 120, rows: 24 });
    const rendered = stripAnsiForTest(frame.output);

    expect(rendered).toContain("message-4");
    expect(rendered).not.toContain("message-16");
    expect(rendered).toContain("已回看 12 行");
  });

  it("renders assistant markdown into cleaner terminal text instead of raw markdown syntax", () => {
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
    state.messages = [
      {
        id: "a1",
        kind: "assistant",
        title: "Deep-Mix",
        content: [
          "## 当前运行环境",
          "",
          "| 项目 | 详情 |",
          "| --- | --- |",
          "| **Node.js** | v24.13.0 |",
          "| **npm** | 11.6.2 |",
          "",
          "- **读取上下文**：通过搜索和读取文件理解项目状态",
          "1. **执行操作**：运行工具完成任务",
          "",
          "---",
        ].join("\n"),
      },
    ];

    const frame = renderTerminalTui(state, { columns: 120, rows: 28 });
    const rendered = stripAnsiForTest(frame.output);

    expect(rendered).toContain("当前运行环境");
    expect(rendered).toContain("Node.js");
    expect(rendered).toContain("读取上下文");
    expect(rendered).toContain("执行操作");
    expect(rendered).not.toContain("## 当前运行环境");
    expect(rendered).not.toContain("**Node.js**");
    expect(rendered).not.toContain("| --- |");
  });

  it("formats generic tool artifacts with their name, type, and safe location", () => {
    const lines = formatToolOutputArtifactLines([
      createToolOutputArtifact({ workspaceRelativePath: "reports/report.pdf" }),
      createToolOutputArtifact({
        uri: "artifact://tool-outputs/session-1/turn-1/notes.docx",
        fileName: "notes.docx",
        mimeType: "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
      }),
    ]);

    expect(lines).toEqual([
      "[tool:artifact] report.pdf | document (application/pdf) | reports/report.pdf",
      "[tool:artifact] notes.docx | document (application/vnd.openxmlformats-officedocument.wordprocessingml.document) | artifact://tool-outputs/session-1/turn-1/notes.docx",
    ]);
  });

  it("collapses fallback tool output to one batch summary and exposes full details through /tools", async () => {
    const workspaceRoot = await createFixtureWorkspace("deep-mix-phase12-artifact-shell-");
    const sessionStore = new SessionStore(workspaceRoot);
    const artifact = createToolOutputArtifact({ workspaceRelativePath: "reports/report.pdf" });
    const runtime: CliRuntimeSurface = {
      async initialize(): Promise<void> {
        await sessionStore.ensureInitialized();
      },
      async getRuntimeCapabilities(): Promise<RuntimeCapabilitySnapshot> {
        return createCapabilitySnapshot();
      },
      async resolveResumeTarget(): Promise<never> {
        throw new Error("No resumable session.");
      },
      async runTurn({ prompt, callbacks }) {
        const created = await sessionStore.createSession(prompt);
        callbacks?.onSessionSelected?.(created.sessionId);
        callbacks?.onToolBatchStart?.({
          assistantMessageId: "assistant-tool-batch-1",
          turnId: "turn-tool-batch-1",
          createdAt: "2026-07-11T00:00:00.000Z",
          toolCalls: [{
            id: "tool-artifact-1",
            name: "custom_document_exporter",
            rawArguments: "{}",
            arguments: {},
          }],
        });
        callbacks?.onToolStart?.({
          id: "tool-artifact-1",
          name: "custom_document_exporter",
          rawArguments: "{}",
          arguments: {},
        });
        callbacks?.onToolEnd?.({
          toolName: "custom_document_exporter",
          callId: "tool-artifact-1",
          startedAt: "2026-07-11T00:00:00.000Z",
          endedAt: "2026-07-11T00:00:01.000Z",
          success: true,
          output: "Generated report.",
          artifacts: [artifact],
        });
        callbacks?.onReasoningDelta?.("PRIVATE_REASONING_MUST_NOT_RENDER");
        callbacks?.onTextDelta?.("工具完成后的阶段总结。");
        const session = await sessionStore.setSessionStatus(created.sessionId, "waiting_for_user");
        return {
          sessionId: session.sessionId,
          session,
          finalResponse: "",
        };
      },
      async continuePendingTurn(): Promise<never> {
        throw new Error("No pending turn.");
      },
      async resolveApprovalRequest(): Promise<void> {},
      async interruptSession(): Promise<void> {},
      getSupervisorReviewService() {
        return {
          async undo() {
            throw new Error("No checkpoint.");
          },
        };
      },
    };
    const input = new ScriptedInput(["/tools 1", "/exit"]);
    const output = new UiRecorder();
    const shell = new CliSessionShell({
      runtime,
      sessionStore,
      input,
      output,
      workspaceRoot,
      permissionMode: "danger-full-access",
      getProfileStatus: () => readProfileStatus(workspaceRoot),
    });

    await shell.run({ initialPrompt: "Generate a generic output artifact." });

    expect(output.buffer).toContain("[工具调用 1] 1 项（1 成功");
    expect(output.buffer).not.toContain("[tool:start]");
    expect(output.buffer).not.toContain("PRIVATE_REASONING_MUST_NOT_RENDER");
    expect(output.buffer.indexOf("[工具调用 1]")).toBeLessThan(output.buffer.indexOf("Generated report."));
    expect(output.buffer.indexOf("[工具调用 1]")).toBeLessThan(output.buffer.indexOf("工具完成后的阶段总结。"));
    expect(output.buffer).toContain("Generated report.");
    expect(output.buffer).toContain(
      "[tool:artifact] report.pdf | document (application/pdf) | reports/report.pdf",
    );
    expect(output.toolEnds[0]?.artifacts).toEqual([artifact]);
  });

  it("keeps generic tool artifacts visible in the terminal TUI without per-tool labels", async () => {
    const stdin = new FakeTerminalInput();
    const stdout = new FakeTerminalOutput();
    const tui = createTerminalTui(stdin, stdout);
    tui.output.recordToolEnd?.(
      "custom_document_exporter",
      true,
      undefined,
      [createToolOutputArtifact()],
    );
    await waitForRender();
    stdin.emit("data", Buffer.from([0x14]));
    await waitForRender();
    tui.close();

    const rendered = stripAnsiForTest(stdout.buffer);
    expect(rendered).toContain("工具调用 1");
    expect(rendered).toContain("custom_document_exporter");
    expect(rendered).toContain("report.pdf");
    expect(rendered).toContain("application/pdf");
    expect(rendered).toContain("artifact://tool-outputs/session-1/turn-1/report.pdf");
  });

  it("renders generic Git approval context and preserves error plus authoritative structured output", async () => {
    const stdin = new FakeTerminalInput();
    const stdout = new FakeTerminalOutput();
    stdout.columns = 100;
    stdout.rows = 48;
    const tui = createTerminalTui(stdin, stdout);
    tui.output.showApproval?.({
      sessionId: "session-git",
      approvalId: "approval-git",
      toolName: "git_restore",
      requestKey: "git_restore:hmac-sha256:redacted",
      reason: "git_restore requires explicit approval in auto mode.",
      actionLabel: "restore",
      riskLabel: "high",
      presentation: {
        action: "restore",
        summary: "Restore one explicit path from HEAD.",
        paths: ["tracked.txt"],
        revisions: ["HEAD"],
        argumentSummary: { area: "worktree", source: "head" },
      },
    });
    await waitForRender();

    const gitOutput = JSON.stringify({
      kind: "git_operation",
      toolName: "git_integrate",
      action: "merge",
      status: "conflicted",
      repository: {
        head: { branch: "main", oid: "0123456789abcdef" },
      },
      conflict: {
        status: "conflicted",
        operation: "merge",
        files: ["tracked.txt"],
        nextSteps: ["Resolve the listed file."],
      },
    }, null, 2);
    const result: ToolResult = {
      toolName: "git_integrate",
      callId: "call-git-integrate",
      startedAt: "2026-07-16T00:00:00.000Z",
      endedAt: "2026-07-16T00:00:01.000Z",
      success: false,
      output: gitOutput,
      structuredContent: JSON.parse(gitOutput),
      error: "merge stopped with conflicts",
    };
    tui.output.clearApproval?.();
    tui.output.recordToolEnd?.("git_integrate", false, undefined, undefined, result);
    await waitForRender();
    stdin.emit("data", Buffer.from([0x14]));
    await waitForRender();
    tui.close();

    const rendered = stripAnsiForTest(stdout.buffer);
    expect(rendered).toContain("git_restore · high");
    expect(rendered).toContain("Restore one explicit path from HEAD.");
    expect(rendered).toContain("路径: tracked.txt");
    expect(rendered).toContain("Revision: HEAD");
    expect(rendered).toContain("error: merge stopped with conflicts");
    expect(rendered).toContain('"branch": "main"');
    expect(rendered).toContain('"status": "conflicted"');
    expect(rendered).toContain('"tracked.txt"');
  });

  it("drives the structured TUI hooks through a full approval cycle without breaking the CLI loop", async () => {
    const workspaceRoot = await createFixtureWorkspace("deep-mix-phase12-approval-");
    const sessionStore = new SessionStore(workspaceRoot);
    const runtime = new GovernorRuntime({
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
    });
    const input = new ScriptedInput(["1", "/exit"]);
    const output = new UiRecorder();
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
      initialPrompt: "Run a shell command and then summarize the result.",
    });

    expect(output.header?.workspaceRoot).toBe(workspaceRoot);
    expect(output.userEntries.some((entry) => entry.text === "Run a shell command and then summarize the result.")).toBe(true);
    expect(input.contexts.some((context) => context.mode === "prompt")).toBe(true);
    expect(input.contexts.some((context) => context.mode === "approval")).toBe(true);
    expect(output.approvals.some((approval) => approval.toolName === "run_shell")).toBe(true);
    expect(output.clearedApprovals).toBeGreaterThan(0);
    expect(output.toolStarts).toContain("run_shell");
    expect(output.toolEnds.some((entry) => entry.toolName === "run_shell")).toBe(true);
    expect(output.systemMessages.some((message) => message.text.includes("Ready for the next prompt."))).toBe(true);
    expect(output.snapshots.some((snapshot) => snapshot.cliState === "awaiting_approval")).toBe(true);
    expect(output.snapshots.some((snapshot) => snapshot.sessionStatus === "waiting_for_user")).toBe(true);
    expect(output.assistantChunkCount).toBeGreaterThan(0);
  }, 15000);

  it("keeps every slash command observable in the TUI and continues after command failures", async () => {
    const workspaceRoot = await createFixtureWorkspace("deep-mix-phase12-commands-");
    const sessionStore = new SessionStore(workspaceRoot);
    const runtime = new GovernorRuntime({
      workspaceRoot,
      permissionMode: "danger-full-access",
      modelClient: new ScriptedModelClient([
        {
          content: "Command audit session is ready.",
          toolCalls: [],
        },
      ]),
    });
    const input = new ScriptedInput([
      "/session",
      "/status",
      "/context",
      "/resume",
      "/continue",
      "/export",
      "/undo",
      "/help",
      "/does-not-exist",
      "/exit",
    ]);
    const output = new UiRecorder();
    const shell = new CliSessionShell({
      runtime,
      sessionStore,
      input,
      output,
      workspaceRoot,
      permissionMode: "danger-full-access",
      getProfileStatus: () => readProfileStatus(workspaceRoot),
    });

    await shell.run({ initialPrompt: "Create a session for slash-command auditing." });

    const resultFor = (command: string) => output.commandResults.find((result) => result.command === command);
    expect(resultFor("/session")?.text).toContain("Current session:");
    expect(resultFor("/status")?.text).toContain("Session status:");
    expect(resultFor("/context")?.text).toContain("Model:");
    expect(resultFor("/resume")?.text).toContain("Resumed session:");
    expect(resultFor("/continue")?.text).toContain("Continued session:");
    expect(resultFor("/export")?.text).toContain("Session exported to:");
    expect(resultFor("/undo")?.tone).toBe("error");
    expect(resultFor("/help")?.text).toContain("/context");
    expect(resultFor("/does-not-exist")?.tone).toBe("warning");
    expect(resultFor("/exit")?.text).toContain("Exiting Deep-Mix CLI.");
    expect(output.userEntries.at(-1)).toEqual({ text: "/exit", kind: "command" });
  }, 15000);

  it("renders command results inside the real terminal message area", async () => {
    const stdin = new FakeTerminalInput();
    const stdout = new FakeTerminalOutput();
    const tui = createTerminalTui(stdin, stdout);

    tui.output.recordCommandResult?.("/context", "Session: test-session\nModel: deepseek-chat", "info");
    await waitForRender();
    tui.close();

    const rendered = stripAnsiForTest(stdout.buffer);
    expect(rendered).toContain("Session: test-session");
    expect(rendered).toContain("Model: deepseek-chat");
  });

  it("falls back to the simplified shell when the terminal cannot support the full TUI", () => {
    const support = detectTerminalTuiSupport(
      { isTTY: false } as NodeJS.ReadStream,
      { isTTY: false } as NodeJS.WriteStream,
      { TERM: "dumb" },
    );

    expect(support.supported).toBe(false);
    expect(support.reason).toBe("non-tty terminal");
  });

  it("keeps the TUI enabled when tty dimensions are temporarily unavailable", () => {
    const support = detectTerminalTuiSupport(
      { isTTY: true } as unknown as NodeJS.ReadStream,
      { isTTY: true, columns: undefined, rows: undefined } as unknown as NodeJS.WriteStream,
      {},
    );

    expect(support.supported).toBe(true);
    expect(support.reason).toBeUndefined();
  });

  it("keeps the TUI enabled even in a small terminal viewport", () => {
    const support = detectTerminalTuiSupport(
      { isTTY: true } as unknown as NodeJS.ReadStream,
      { isTTY: true, columns: 48, rows: 12 } as unknown as NodeJS.WriteStream,
      {},
    );

    expect(support.supported).toBe(true);
    expect(support.reason).toBeUndefined();
  });

  it("treats raw Ctrl+C as an interrupt/exit signal inside the TUI", async () => {
    const stdin = new FakeTerminalInput();
    const stdout = new FakeTerminalOutput();
    const tui = createTerminalTui(stdin, stdout);
    let interruptCount = 0;
    tui.setInterruptHandler(() => {
      interruptCount += 1;
    });

    stdin.emit("data", Buffer.from([0x03]));
    await waitForRender();
    tui.close();

    expect(interruptCount).toBe(1);
  });

  it("restores and releases terminal input exactly once when the TUI closes", () => {
    const stdin = new FakeTerminalInput();
    const stdout = new FakeTerminalOutput();
    const tui = createTerminalTui(stdin, stdout);

    tui.close();
    tui.close();

    expect(stdin.rawModeChanges).toEqual([true, false]);
    expect(stdin.pauseCount).toBe(1);
  });

  it("toggles the debug panel with raw Ctrl+B and shows captured tool activity", async () => {
    const stdin = new FakeTerminalInput();
    const stdout = new FakeTerminalOutput();
    const tui = createTerminalTui(stdin, stdout);
    tui.output.recordUserEntry?.("test", "prompt");
    tui.output.recordToolStart?.("read_file");
    await waitForRender();

    stdin.emit("data", Buffer.from([0x02]));
    await waitForRender();
    tui.close();

    const rendered = stripAnsiForTest(stdout.buffer);
    expect(rendered).toContain("调试视图");
    expect(rendered).toContain("tool:start read_file");
  });
});
