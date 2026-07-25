import { emitKeypressEvents } from "node:readline";
import type { Readable, Writable } from "node:stream";
import type { ToolOutputArtifact, ToolResult } from "../../../packages/shared-schema/src/index.js";
import type {
  CliInteractivePromptReader,
  CliShellApprovalView,
  CliShellHeaderSnapshot,
  CliShellInputContext,
  CliShellSessionSnapshot,
  CliUiOutputWriter,
} from "./session-shell.js";
import { formatToolOutputArtifactLines } from "./session-shell.js";
import {
  createInitialTerminalTuiState,
  renderTerminalTui,
  type TerminalTuiApprovalState,
  type TerminalTuiHeaderState,
  type TerminalTuiInputState,
  type TerminalTuiMessage,
  type TerminalTuiState,
  type TerminalTuiToolEntry,
  type TerminalTuiToolGroup,
} from "./terminal-tui-renderer.js";

type TerminalReadable = Readable & {
  isTTY?: boolean;
  setRawMode?: (enabled: boolean) => void;
};

type TerminalWritable = Writable & {
  isTTY?: boolean;
  columns?: number;
  rows?: number;
};

export interface TerminalTuiSupport {
  supported: boolean;
  reason?: string;
}

export interface CreatedTerminalTui {
  input: CliInteractivePromptReader;
  output: CliUiOutputWriter;
  close(): void;
  setInterruptHandler(handler: () => void): void;
}

const HELP_LINES = [
  "F1 显示/隐藏帮助",
  "Ctrl+B 显示/隐藏调试视图",
  "Ctrl+T 展开/收起最近一轮工具调用",
  "PgUp/PgDn 浏览消息历史",
  "/resume 恢复会话",
  "/continue 继续当前会话",
  "/export 导出当前会话",
  "/undo 撤销最近 checkpoint",
  "/status 查看状态",
  "/tools [编号] 查看工具调用详情",
  "/processes managed processes",
  "/stop-process <id> stop a managed process",
];

const TOOL_LABELS: Record<string, string> = {
  read_file: "读取文件",
  list_files: "查看目录",
  search_files: "搜索文本",
  run_shell: "执行命令",
  run_tests: "运行测试",
  start_process: "启动托管进程",
  process_input: "写入进程输入",
  process_output: "读取进程输出",
  stop_process: "停止托管进程",
  build: "执行构建",
  format: "执行格式化",
  test_coverage: "检查覆盖率",
  inspect_logs: "分析日志",
  git_status: "检查 Git 状态",
  git_diff: "查看 Git diff",
  invoke_coding_worker: "调用编码 worker",
  invoke_vision_worker: "调用视觉 worker",
  apply_artifact_patch: "应用补丁",
  list_checkpoints: "列出检查点",
  list_artifacts: "列出产物",
  read_artifact: "读取产物",
  export_artifact: "导出产物",
  worker_status: "查看 Worker 状态",
  worker_output: "读取 Worker 输出",
  worker_cancel: "取消 Worker",
  list_mcp_servers: "列出 MCP Server",
  list_mcp_resources: "列出 MCP Resource",
  read_mcp_resource: "读取 MCP Resource",
};

function parseTerminalDimension(value: number | string | undefined): number | undefined {
  if (typeof value === "number" && Number.isFinite(value) && value > 0) {
    return Math.floor(value);
  }
  if (typeof value === "string") {
    const parsed = Number.parseInt(value, 10);
    if (Number.isFinite(parsed) && parsed > 0) {
      return parsed;
    }
  }
  return undefined;
}

function nextMessageId(prefix: string): string {
  return `${prefix}-${Date.now()}-${Math.random().toString(16).slice(2, 8)}`;
}

function toHeaderState(snapshot: CliShellHeaderSnapshot): TerminalTuiHeaderState {
  return {
    version: snapshot.version,
    workspaceRoot: snapshot.workspaceRoot,
    permissionMode: snapshot.permissionMode,
    routeOverride: snapshot.routeOverride,
    profiles: snapshot.profiles,
    capabilities: snapshot.capabilities,
  };
}

function toApprovalState(approval: CliShellApprovalView): TerminalTuiApprovalState {
  const presentation = approval.presentation;
  const detailLines = [
    presentation?.summary,
    presentation?.paths?.length ? `路径: ${presentation.paths.join(", ")}` : undefined,
    presentation?.revisions?.length ? `Revision: ${presentation.revisions.join(", ")}` : undefined,
    presentation?.argumentSummary && Object.keys(presentation.argumentSummary).length > 0
      ? `参数: ${JSON.stringify(presentation.argumentSummary)}`
      : undefined,
  ].filter((line): line is string => Boolean(line));
  return {
    toolName: approval.toolName,
    actionLabel: approval.actionLabel,
    requestKey: approval.requestKey,
    riskLabel: approval.riskLabel,
    reason: approval.reason,
    detailLines,
  };
}

function trimMessages(messages: TerminalTuiMessage[], limit = 200): TerminalTuiMessage[] {
  return messages.slice(Math.max(messages.length - limit, 0));
}

function simplifyRouteSummary(summary: string | undefined): string | undefined {
  if (!summary) {
    return undefined;
  }
  return summary
    .replace(/^Route to /i, "")
    .replace(/^Automatic routing decision:\s*/i, "")
    .replace(/^Automatic routing\s*/i, "")
    .replace(/\s+because\s+/i, " · ")
    .trim();
}

function friendlyToolName(toolName: string): string {
  return TOOL_LABELS[toolName] ?? toolName;
}

function shouldPersistSystemMessage(text: string, tone: "info" | "success" | "warning" | "error"): boolean {
  if (tone === "error") {
    return true;
  }
  if (tone === "warning" && /history|integrity|approval/i.test(text)) {
    return true;
  }
  return false;
}

class TerminalTuiController implements CliUiOutputWriter {
  private readonly state: TerminalTuiState = createInitialTerminalTuiState();

  private readonly resizeHandler = () => {
    this.requestRender();
  };

  private renderTimer?: NodeJS.Timeout;

  private animationTimer?: NodeJS.Timeout;

  private closed = false;

  private activeAssistantId?: string;

  private activeToolGroupId?: string;

  private nextToolGroupSequence = 1;

  public constructor(private readonly stdout: TerminalWritable) {
    this.stdout.write("\x1b[?1049h\x1b[?25l");
    this.stdout.on?.("resize", this.resizeHandler);
    this.requestRender(true);
  }

  public close(): void {
    if (this.closed) {
      return;
    }
    this.closed = true;
    if (this.renderTimer) {
      clearTimeout(this.renderTimer);
      this.renderTimer = undefined;
    }
    if (this.animationTimer) {
      clearInterval(this.animationTimer);
      this.animationTimer = undefined;
    }
    this.stdout.off?.("resize", this.resizeHandler);
    this.stdout.write("\x1b[?25h\x1b[?1049l");
  }

  public write(_text: string): void {}

  public setHeader(header: CliShellHeaderSnapshot): void {
    this.state.header = toHeaderState(header);
    this.requestRender();
  }

  public updateSnapshot(snapshot: CliShellSessionSnapshot): void {
    const wasRunning = this.state.cliState === "running_turn";
    this.state.cliState = snapshot.cliState;
    this.state.sessionId = snapshot.sessionId;
    this.state.sessionStatus = snapshot.sessionStatus;
    this.state.routeSummary = simplifyRouteSummary(snapshot.routeSummary);
    this.state.fallbackSummary = snapshot.fallbackSummary;
    this.state.workerSummary = snapshot.workerSummary;
    this.state.latestContextBudget = snapshot.latestContextBudget;
    this.state.latestTaskDuration = snapshot.latestTaskDuration;
    this.state.latestTokenUsage = snapshot.latestTokenUsage;
    this.state.cumulativeTokenUsage = snapshot.cumulativeTokenUsage;
    this.state.latestCompaction = snapshot.latestCompaction;
    if (!snapshot.currentToolName && this.state.currentTool?.status === "running") {
      this.state.currentTool = undefined;
    }
    if (wasRunning && snapshot.cliState !== "running_turn") {
      this.finalizeActiveToolGroup(true);
      this.collapseAllToolGroups();
    }
    this.syncActivity();
    this.requestRender();
  }

  public recordUserEntry(text: string, kind: "prompt" | "command"): void {
    this.pushMessage({
      id: nextMessageId(kind),
      kind: "user",
      title: kind === "command" ? "Command" : "You",
      content: text,
    });
    this.state.helpVisible = false;
    this.requestRender();
  }

  public startAssistantMessage(): void {
    if (this.activeAssistantId) {
      return;
    }
    this.finalizeActiveToolGroup(true);
    const message: TerminalTuiMessage = {
      id: nextMessageId("assistant"),
      kind: "assistant",
      title: "Deep-Mix",
      content: "",
      streaming: true,
    };
    this.activeAssistantId = message.id;
    this.pushMessage(message);
    this.syncActivity();
    this.requestRender();
  }

  public appendAssistantText(chunk: string): void {
    if (!this.activeAssistantId) {
      this.startAssistantMessage();
    }
    const active = this.state.messages.find((message) => message.id === this.activeAssistantId);
    if (!active) {
      return;
    }
    active.content += chunk;
    this.requestRender();
  }

  public completeAssistantMessage(): void {
    if (!this.activeAssistantId) {
      return;
    }
    const active = this.state.messages.find((message) => message.id === this.activeAssistantId);
    if (active) {
      active.streaming = false;
      active.content = active.content.trimEnd();
    }
    this.activeAssistantId = undefined;
    this.syncActivity();
    this.requestRender();
  }

  public recordSystemMessage(text: string, tone: "info" | "success" | "warning" | "error" = "info"): void {
    this.pushDebug(text);
    if (!shouldPersistSystemMessage(text, tone)) {
      this.syncActivity();
      this.requestRender();
      return;
    }
    this.pushMessage({
      id: nextMessageId("system"),
      kind: tone === "error" ? "error" : "system",
      title: tone === "error" ? "Error" : "System",
      content: text,
    });
    this.syncActivity();
    this.requestRender();
  }

  public recordCommandResult(
    command: string,
    text: string,
    tone: "info" | "success" | "warning" | "error" = "info",
  ): void {
    this.pushDebug(`${command}: ${text}`);
    this.pushMessage({
      id: nextMessageId("command-result"),
      kind: tone === "error" ? "error" : "system",
      title: command,
      content: text,
    });
    this.state.messageScrollOffset = 0;
    this.syncActivity();
    this.requestRender();
  }

  public recordToolBatchStart(batchId: string, tools: ReadonlyArray<{ id: string; name: string }>): void {
    const existing = this.findToolGroupByBatchId(batchId);
    if (existing) {
      this.activeToolGroupId = existing.id;
      existing.toolGroup!.running = true;
      existing.toolGroup!.endedAtMs = undefined;
      for (const tool of tools) {
        if (!existing.toolGroup!.tools.some((entry) => entry.callId === tool.id)) {
          existing.toolGroup!.tools.push({
            callId: tool.id,
            name: tool.name,
            status: "running",
            startedAtMs: Date.now(),
          });
        }
      }
      this.requestRender();
      return;
    }
    this.completeAssistantMessage();
    this.finalizeActiveToolGroup(true);
    const group = this.createToolGroup(batchId);
    for (const tool of tools) {
      group.tools.push({
        callId: tool.id,
        name: tool.name,
        status: "running",
        startedAtMs: Date.now(),
      });
    }
    this.requestRender();
  }

  public recordToolStart(toolName: string, callId?: string): void {
    this.completeAssistantMessage();
    const group = this.getOrCreateActiveToolGroup();
    let entry = callId ? group.tools.find((tool) => tool.callId === callId) : undefined;
    if (!entry) {
      entry = {
        callId,
        name: toolName,
        status: "running",
        startedAtMs: Date.now(),
      };
      group.tools.push(entry);
    } else {
      entry.status = "running";
      entry.startedAtMs ??= Date.now();
    }
    group.running = true;
    group.endedAtMs = undefined;
    this.state.currentTool = entry;
    this.pushDebug(`tool:start ${toolName}`);
    this.syncActivity();
    this.requestRender();
  }

  public recordToolEnd(
    toolName: string,
    success: boolean,
    fallback?: string,
    artifacts?: readonly ToolOutputArtifact[],
    result?: ToolResult,
  ): void {
    const storedArtifacts = artifacts && artifacts.length > 0 ? [...artifacts] : undefined;
    const group = this.getOrCreateActiveToolGroup();
    const callId = result?.callId;
    let entry = callId ? group.tools.find((tool) => tool.callId === callId) : undefined;
    entry ??= [...group.tools].reverse().find((tool) => tool.name === toolName && tool.status === "running");
    if (!entry) {
      entry = {
        callId,
        name: toolName,
        status: "running",
        startedAtMs: result?.startedAt ? Date.parse(result.startedAt) : Date.now(),
      };
      group.tools.push(entry);
    }
    entry.status = success ? "ok" : "error";
    entry.fallback = fallback;
    entry.artifacts = storedArtifacts;
    entry.output = result?.output;
    entry.error = result?.error;
    entry.structuredContent = result?.structuredContent;
    entry.endedAtMs = result?.endedAt ? Date.parse(result.endedAt) : Date.now();
    if (!Number.isFinite(entry.startedAtMs)) entry.startedAtMs = undefined;
    if (!Number.isFinite(entry.endedAtMs)) entry.endedAtMs = Date.now();
    group.running = group.tools.some((tool) => tool.status === "running");
    if (!group.running) {
      group.endedAtMs = Date.now();
    }
    this.state.currentTool = undefined;
    this.state.recentTools = [entry, ...this.state.recentTools].slice(0, 8);
    const summary = `tool:end ${toolName} ${success ? "ok" : "error"}${fallback ? ` fallback:${fallback}` : ""}`;
    this.pushDebug(summary);
    const artifactLines = formatToolOutputArtifactLines(storedArtifacts);
    if (artifactLines.length > 0) {
      this.state.messageScrollOffset = 0;
      for (const artifactLine of artifactLines) {
        this.pushDebug(artifactLine);
      }
    }
    this.syncActivity();
    this.requestRender();
  }

  public showApproval(approval: CliShellApprovalView): void {
    this.state.approval = toApprovalState(approval);
    this.pushDebug(`approval ${approval.toolName}`);
    this.syncActivity();
    this.requestRender();
  }

  public clearApproval(): void {
    this.state.approval = undefined;
    this.syncActivity();
    this.requestRender();
  }

  public setHelpVisible(visible: boolean, lines: string[]): void {
    this.state.helpVisible = visible;
    this.state.helpLines = lines;
    this.requestRender();
  }

  public setInputContext(context: CliShellInputContext): void {
    const input: TerminalTuiInputState = {
      ...this.state.input,
      mode: context.mode,
      placeholder: context.placeholder,
      submitHint: context.submitHint,
      promptText: context.promptText,
    };
    this.state.input = input;
    this.requestRender();
  }

  public updateInput(value: string, cursor: number): void {
    this.state.input.value = value;
    this.state.input.cursor = cursor;
    this.requestRender();
  }

  public toggleHelp(lines: string[]): void {
    this.state.helpVisible = !this.state.helpVisible;
    this.state.helpLines = lines;
    this.requestRender();
  }

  public toggleDebug(): void {
    this.state.debugVisible = !this.state.debugVisible;
    this.requestRender();
  }

  public scrollMessages(delta: number): void {
    this.state.messageScrollOffset = Math.max(0, this.state.messageScrollOffset + delta);
    this.requestRender(true);
  }

  public scrollMessagesToLatest(): void {
    this.state.messageScrollOffset = 0;
    this.requestRender(true);
  }

  public toggleToolDetails(sequence?: number): { sequence: number; expanded: boolean } | undefined {
    if (sequence === undefined) {
      const latest = [...this.state.messages].reverse().find((message) => message.processGroup || message.toolGroup);
      if (latest?.processGroup) {
        latest.processGroup.expanded = !latest.processGroup.expanded;
        this.state.messageScrollOffset = 0;
        this.requestRender(true);
        return {
          sequence: 0,
          expanded: latest.processGroup.expanded,
        };
      }
      if (latest?.toolGroup) {
        latest.toolGroup.expanded = !latest.toolGroup.expanded;
        this.state.messageScrollOffset = 0;
        this.requestRender(true);
        return {
          sequence: latest.toolGroup.sequence,
          expanded: latest.toolGroup.expanded,
        };
      }
      return undefined;
    }

    const located = this.findToolGroup(sequence);
    if (!located) {
      return undefined;
    }
    located.group.expanded = !located.group.expanded;
    if (located.processGroup) {
      located.processGroup.expanded = true;
    }
    this.state.messageScrollOffset = 0;
    this.requestRender(true);
    return {
      sequence: located.group.sequence,
      expanded: located.group.expanded,
    };
  }

  public completeTaskPresentation(durationMs?: number): void {
    this.completeAssistantMessage();
    this.finalizeActiveToolGroup(true);
    this.collapseAllToolGroups();
    let userIndex = -1;
    for (let index = this.state.messages.length - 1; index >= 0; index -= 1) {
      const message = this.state.messages[index];
      if (message?.kind === "user" && message.title === "You") {
        userIndex = index;
        break;
      }
    }
    if (userIndex < 0) {
      this.requestRender();
      return;
    }
    let finalAssistantIndex = -1;
    for (let index = this.state.messages.length - 1; index > userIndex; index -= 1) {
      const message = this.state.messages[index];
      if (message?.kind === "assistant" && Boolean(message.content.trim())) {
        finalAssistantIndex = index;
        break;
      }
    }
    if (finalAssistantIndex <= userIndex + 1) {
      this.requestRender();
      return;
    }
    const processMessages = this.state.messages.slice(userIndex + 1, finalAssistantIndex);
    if (processMessages.length === 0 || processMessages.some((message) => message.processGroup)) {
      this.requestRender();
      return;
    }
    const processMessage: TerminalTuiMessage = {
      id: nextMessageId("process-group"),
      kind: "system",
      title: "处理过程",
      content: "",
      processGroup: {
        expanded: false,
        durationMs,
        messages: processMessages,
      },
    };
    this.state.messages.splice(userIndex + 1, processMessages.length, processMessage);
    this.state.messageScrollOffset = 0;
    this.requestRender();
  }

  private createToolGroup(batchId?: string): TerminalTuiToolGroup {
    const group: TerminalTuiToolGroup = {
      batchId,
      sequence: this.nextToolGroupSequence,
      expanded: false,
      running: true,
      startedAtMs: Date.now(),
      tools: [],
    };
    this.nextToolGroupSequence += 1;
    const message: TerminalTuiMessage = {
      id: nextMessageId("tool-group"),
      kind: "tool",
      title: `工具调用 ${group.sequence}`,
      content: "",
      toolGroup: group,
    };
    this.activeToolGroupId = message.id;
    this.pushMessage(message);
    this.state.messageScrollOffset = 0;
    return group;
  }

  private getOrCreateActiveToolGroup(): TerminalTuiToolGroup {
    const active = this.state.messages.find((message) => message.id === this.activeToolGroupId)?.toolGroup;
    return active ?? this.createToolGroup();
  }

  private findToolGroupByBatchId(batchId: string): TerminalTuiMessage | undefined {
    for (const message of [...this.state.messages].reverse()) {
      if (message.toolGroup?.batchId === batchId) {
        return message;
      }
      const nested = [...(message.processGroup?.messages ?? [])].reverse().find((candidate) => candidate.toolGroup?.batchId === batchId);
      if (nested) {
        return nested;
      }
    }
    return undefined;
  }

  private findToolGroup(sequence: number): { group: TerminalTuiToolGroup; processGroup?: NonNullable<TerminalTuiMessage["processGroup"]> } | undefined {
    for (const message of [...this.state.messages].reverse()) {
      if (message.toolGroup?.sequence === sequence) {
        return { group: message.toolGroup };
      }
      const nested = [...(message.processGroup?.messages ?? [])].reverse().find((candidate) => candidate.toolGroup?.sequence === sequence);
      if (nested?.toolGroup) {
        return { group: nested.toolGroup, processGroup: message.processGroup };
      }
    }
    return undefined;
  }

  private finalizeActiveToolGroup(collapse: boolean): void {
    const group = this.state.messages.find((message) => message.id === this.activeToolGroupId)?.toolGroup;
    if (!group) {
      this.activeToolGroupId = undefined;
      return;
    }
    group.running = group.tools.some((tool) => tool.status === "running");
    if (!group.running) {
      group.endedAtMs ??= Date.now();
    }
    if (collapse) {
      group.expanded = false;
    }
    this.activeToolGroupId = undefined;
  }

  private collapseAllToolGroups(): void {
    for (const message of this.state.messages) {
      if (message.toolGroup) {
        message.toolGroup.expanded = false;
      }
      for (const nested of message.processGroup?.messages ?? []) {
        if (nested.toolGroup) {
          nested.toolGroup.expanded = false;
        }
      }
    }
  }

  private pushMessage(message: TerminalTuiMessage): void {
    this.state.messages = trimMessages([...this.state.messages, message]);
  }

  private pushDebug(line: string): void {
    const trimmed = line.trim();
    if (!trimmed) {
      return;
    }
    this.state.debugLines = [...this.state.debugLines, trimmed].slice(-80);
  }

  private syncActivity(): void {
    if (this.state.approval) {
      this.state.activity = {
        mode: "approval",
        label: "等待审批",
        detail: friendlyToolName(this.state.approval.toolName),
        frame: 0,
      };
      this.syncAnimationTimer();
      return;
    }

    if (this.state.cliState === "running_turn") {
      this.state.activity = {
        mode: "thinking",
        label: "正在思考",
        detail: this.state.currentTool ? friendlyToolName(this.state.currentTool.name) : undefined,
        frame: this.state.activity?.mode === "thinking" ? this.state.activity.frame : 0,
      };
      this.syncAnimationTimer();
      return;
    }

    if (this.state.cliState === "interrupted") {
      this.state.activity = {
        mode: "notice",
        label: "已中断",
        frame: 0,
      };
      this.syncAnimationTimer();
      return;
    }

    this.state.activity = undefined;
    this.syncAnimationTimer();
  }

  private syncAnimationTimer(): void {
    const animate = this.state.activity?.mode === "thinking";
    if (animate && !this.animationTimer) {
      this.animationTimer = setInterval(() => {
        if (!this.state.activity || this.state.activity.mode !== "thinking") {
          return;
        }
        this.state.activity.frame = (this.state.activity.frame + 1) % 3;
        this.requestRender(true);
      }, 200);
      return;
    }
    if (!animate && this.animationTimer) {
      clearInterval(this.animationTimer);
      this.animationTimer = undefined;
    }
  }

  private requestRender(immediate = false): void {
    if (this.closed) {
      return;
    }
    if (immediate) {
      this.renderNow();
      return;
    }
    if (this.renderTimer) {
      return;
    }
    this.renderTimer = setTimeout(() => {
      this.renderTimer = undefined;
      this.renderNow();
    }, 16);
  }

  private renderNow(): void {
    if (this.closed) {
      return;
    }
    const frame = renderTerminalTui(this.state, {
      columns: this.stdout.columns ?? 120,
      rows: this.stdout.rows ?? 40,
    });
    this.stdout.write(`\x1b[?25l\x1b[H\x1b[2J${frame.output}\x1b[${frame.cursor.row};${frame.cursor.column}H\x1b[?25h`);
  }
}

class TerminalTuiPromptReader implements CliInteractivePromptReader {
  private pendingResolve?: (value: string | undefined) => void;

  private buffer = "";

  private cursor = 0;

  private context: CliShellInputContext = {
    mode: "prompt",
    promptText: "deep-mix> ",
    placeholder: "直接输入你的任务",
    submitHint: "Enter 发送  ·  Ctrl+T 工具详情  ·  F1 帮助",
  };

  private interruptHandler?: () => void;

  private lastControlByte?: string;

  private closed = false;

  private readonly onData = (chunk: Buffer | string) => {
    const value = typeof chunk === "string" ? chunk : chunk.toString("utf8");
    if (value === "\u0003") {
      this.lastControlByte = value;
      setTimeout(() => {
        if (this.lastControlByte === value) {
          this.lastControlByte = undefined;
        }
      }, 0);
      this.interruptHandler?.();
      return;
    }
    if (value === "\u0002") {
      this.lastControlByte = value;
      setTimeout(() => {
        if (this.lastControlByte === value) {
          this.lastControlByte = undefined;
        }
      }, 0);
      this.controller.toggleDebug();
      return;
    }
    if (value === "\u0014") {
      this.lastControlByte = value;
      setTimeout(() => {
        if (this.lastControlByte === value) {
          this.lastControlByte = undefined;
        }
      }, 0);
      this.controller.toggleToolDetails();
      return;
    }
  };

  private readonly onKeypress = (
    value: string,
    key: { name?: string; ctrl?: boolean; meta?: boolean; shift?: boolean },
  ) => {
    if (
      (key.ctrl && key.name === "c" && this.lastControlByte === "\u0003") ||
      (key.ctrl && key.name === "b" && this.lastControlByte === "\u0002") ||
      (key.ctrl && key.name === "t" && this.lastControlByte === "\u0014")
    ) {
      return;
    }

    if (key.ctrl && key.name === "c") {
      this.interruptHandler?.();
      return;
    }

    if (key.name === "f1") {
      this.controller.toggleHelp(this.helpLines);
      return;
    }

    if (key.ctrl && key.name === "b") {
      this.controller.toggleDebug();
      return;
    }

    if (key.ctrl && key.name === "t") {
      this.controller.toggleToolDetails();
      return;
    }

    if (!this.pendingResolve) {
      return;
    }

    if (key.name === "pageup") {
      this.controller.scrollMessages(12);
      return;
    }

    if (key.name === "pagedown") {
      this.controller.scrollMessages(-12);
      return;
    }

    if (key.name === "escape") {
      this.controller.setHelpVisible(false, this.helpLines);
      return;
    }

    if (this.context.mode === "approval" && !key.ctrl && !key.meta && /^[123]$/.test(value)) {
      this.finish(value);
      return;
    }

    if (this.context.mode === "prompt" && !this.buffer && key.ctrl && !key.meta) {
      if (key.name === "r") {
        this.finish("/resume");
        return;
      }
      if (key.name === "o") {
        this.finish("/continue");
        return;
      }
      if (key.name === "s") {
        this.finish("/status");
        return;
      }
      if (key.name === "u") {
        this.finish("/undo");
        return;
      }
    }

    switch (key.name) {
      case "return":
        this.finish(this.buffer.trim());
        return;
      case "backspace":
        if (this.cursor > 0) {
          this.buffer = `${this.buffer.slice(0, this.cursor - 1)}${this.buffer.slice(this.cursor)}`;
          this.cursor -= 1;
          this.controller.updateInput(this.buffer, this.cursor);
        }
        return;
      case "delete":
        if (this.cursor < this.buffer.length) {
          this.buffer = `${this.buffer.slice(0, this.cursor)}${this.buffer.slice(this.cursor + 1)}`;
          this.controller.updateInput(this.buffer, this.cursor);
        }
        return;
      case "left":
        this.cursor = Math.max(this.cursor - 1, 0);
        this.controller.updateInput(this.buffer, this.cursor);
        return;
      case "right":
        this.cursor = Math.min(this.cursor + 1, this.buffer.length);
        this.controller.updateInput(this.buffer, this.cursor);
        return;
      case "home":
        this.cursor = 0;
        this.controller.updateInput(this.buffer, this.cursor);
        return;
      case "end":
        this.cursor = this.buffer.length;
        this.controller.updateInput(this.buffer, this.cursor);
        return;
      default:
        break;
    }

    if (!key.ctrl && !key.meta && value) {
      const sanitized = value.replace(/\r?\n/g, " ");
      if (!sanitized) {
        return;
      }
      this.buffer = `${this.buffer.slice(0, this.cursor)}${sanitized}${this.buffer.slice(this.cursor)}`;
      this.cursor += sanitized.length;
      this.controller.updateInput(this.buffer, this.cursor);
    }
  };

  public constructor(
    private readonly stdin: TerminalReadable,
    private readonly controller: TerminalTuiController,
    private readonly helpLines: string[],
  ) {
    emitKeypressEvents(this.stdin);
    this.stdin.setRawMode?.(true);
    this.stdin.on("data", this.onData);
    this.stdin.on("keypress", this.onKeypress);
    this.controller.updateInput(this.buffer, this.cursor);
  }

  public setInterruptHandler(handler: () => void): void {
    this.interruptHandler = handler;
  }

  public setContext(context: CliShellInputContext): void {
    this.context = context;
    this.buffer = "";
    this.cursor = 0;
    this.controller.setInputContext(context);
    this.controller.updateInput(this.buffer, this.cursor);
  }

  public read(_promptText: string): Promise<string | undefined> {
    if (this.pendingResolve) {
      throw new Error("Prompt read already in progress.");
    }
    this.controller.setInputContext(this.context);
    this.controller.updateInput(this.buffer, this.cursor);
    return new Promise((resolve) => {
      this.pendingResolve = resolve;
    });
  }

  public close(): void {
    if (this.closed) {
      return;
    }
    this.closed = true;
    this.stdin.off("data", this.onData);
    this.stdin.off("keypress", this.onKeypress);
    this.stdin.setRawMode?.(false);
    // Adding a `data` listener (and readline's keypress decoder) puts stdin in
    // flowing mode. Raw mode and flowing mode are independent: restoring only
    // raw mode leaves the TTY stream active and keeps Node's event loop alive.
    // Pause it after detaching our listeners so one Ctrl+C fully returns
    // control of the console to the parent shell.
    this.stdin.pause();
    if (this.pendingResolve) {
      this.pendingResolve(undefined);
      this.pendingResolve = undefined;
    }
  }

  private finish(value: string | undefined): void {
    if (!this.pendingResolve) {
      return;
    }
    const resolve = this.pendingResolve;
    this.pendingResolve = undefined;
    this.buffer = "";
    this.cursor = 0;
    this.controller.setHelpVisible(false, this.helpLines);
    this.controller.scrollMessagesToLatest();
    this.controller.updateInput(this.buffer, this.cursor);
    resolve(value);
  }
}

export function detectTerminalTuiSupport(
  stdin: Readable,
  stdout: Writable,
  environment: NodeJS.ProcessEnv = process.env,
): TerminalTuiSupport {
  const terminalInput = stdin as TerminalReadable;
  const terminalOutput = stdout as TerminalWritable;
  if (!terminalInput.isTTY || !terminalOutput.isTTY) {
    return {
      supported: false,
      reason: "non-tty terminal",
    };
  }
  const term = (environment.TERM ?? "").toLowerCase();
  if (term === "dumb") {
    return {
      supported: false,
      reason: "TERM=dumb",
    };
  }
  return {
    supported: true,
  };
}

export function createTerminalTui(stdin: Readable, stdout: Writable): CreatedTerminalTui {
  const controller = new TerminalTuiController(stdout as TerminalWritable);
  const promptReader = new TerminalTuiPromptReader(stdin as TerminalReadable, controller, HELP_LINES);
  return {
    input: promptReader,
    output: controller,
    close(): void {
      promptReader.close();
      controller.close();
    },
    setInterruptHandler(handler: () => void): void {
      promptReader.setInterruptHandler(handler);
    },
  };
}
