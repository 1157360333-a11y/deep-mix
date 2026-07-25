import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type {
  ApprovalRecord,
  DiagnosticReportRecord,
  PermissionMode,
  PlanItem,
  RouteTarget,
  SessionRecord,
  ToolOutputArtifact,
  ToolProcessSession,
  UserInputAnswer,
  UserInputRequestRecord,
  WorkerArtifactRecord,
} from "@deep-mix/shared-schema";
import type {
  AttachmentDescriptor,
  DesktopSettings,
  DesktopSettingsPatch,
  WorkerStatusView,
} from "@shared/ipc";
import { ChatPanel } from "./components/ChatPanel";
import { Icon } from "./components/Icons";
import { InputBar } from "./components/InputBar";
import { RightPanel } from "./components/RightPanel";
import { SessionSidebar, type ProjectAction, type SessionAction } from "./components/SessionSidebar";
import { StructuredQuestionPanel } from "./components/StructuredQuestionPanel";
import { TopBar } from "./components/TopBar";
import { buildDisplayHistory } from "./display-history";
import {
  createLiveMessageFlowState,
  reduceLiveMessageFlow,
  type LiveMessageFlowEvent,
} from "./live-message-flow";
import {
  parseProjectPreferences,
  rememberProject,
  removeProject,
  type ProjectPreferences,
} from "./project-state";
import { getRuntime } from "./runtime";
import type { DisplayMessage, InspectorPanel, ThemeMode } from "./types";

const runtime = getRuntime();
const PROJECTS_STORAGE_KEY = "deep-mix-recent-workspaces";
const PROJECT_PREFERENCES_STORAGE_KEY = "deep-mix-project-preferences";
const WORKER_LIFECYCLE_TOOLS = new Set(["worker_status", "worker_output", "worker_cancel"]);

function sessionStatusLabel(status: SessionRecord["status"]): string {
  switch (status) {
    case "running": return "运行中";
    case "waiting_for_user": return "等待输入";
    case "ask_permission": return "等待审批";
    case "failed": return "失败";
    case "completed": return "已完成";
    case "interrupted": return "已停止";
    default: return "待处理";
  }
}

function readStoredNumber(key: string, fallback: number): number {
  const stored = localStorage.getItem(key);
  if (stored === null || stored.trim() === "") return fallback;
  const value = Number(stored);
  return Number.isFinite(value) && value >= 180 ? value : fallback;
}

function readStoredList(key: string): string[] {
  try {
    const value = JSON.parse(localStorage.getItem(key) ?? "[]") as unknown;
    return Array.isArray(value) ? value.filter((entry): entry is string => typeof entry === "string") : [];
  } catch {
    return [];
  }
}

function clamp(value: number, minimum: number, maximum: number): number {
  return Math.min(maximum, Math.max(minimum, value));
}

function formatTokens(value?: number): string {
  if (value === undefined) return "不可用";
  return value >= 1000 ? `${(value / 1000).toFixed(value >= 10_000 ? 0 : 1)}k` : String(value);
}

function formatDuration(value?: number): string {
  if (value === undefined) return "不可用";
  const seconds = Math.max(0, Math.round(value / 1000));
  const minutes = Math.floor(seconds / 60);
  return minutes ? `${minutes} 分 ${seconds % 60} 秒` : `${seconds} 秒`;
}

function readToolDisplayName(value: unknown): string | undefined {
  if (!value || typeof value !== "object" || Array.isArray(value)) return undefined;
  const record = value as Record<string, unknown>;
  const metadata = record.metadata && typeof record.metadata === "object" && !Array.isArray(record.metadata)
    ? record.metadata as Record<string, unknown>
    : undefined;
  const candidate = record.displayName ?? record.toolDisplayName ?? metadata?.displayName ?? metadata?.toolDisplayName;
  return typeof candidate === "string" && candidate.trim() ? candidate.trim() : undefined;
}

export default function App() {
  const [sessions, setSessions] = useState<SessionRecord[]>([]);
  const [activeSessionId, setActiveSessionId] = useState<string | null>(null);
  const [messages, setMessages] = useState<DisplayMessage[]>([]);
  const [planItems, setPlanItems] = useState<PlanItem[]>([]);
  const [approvals, setApprovals] = useState<ApprovalRecord[]>([]);
  const [pendingUserInput, setPendingUserInput] = useState<UserInputRequestRecord | null>(null);
  const [workers, setWorkers] = useState<WorkerStatusView[]>([]);
  const [artifacts, setArtifacts] = useState<WorkerArtifactRecord[]>([]);
  const [diagnostics, setDiagnostics] = useState<DiagnosticReportRecord | null>(null);
  const [processes, setProcesses] = useState<ToolProcessSession[]>([]);
  const [stoppingProcessIds, setStoppingProcessIds] = useState<Set<string>>(() => new Set());
  const [settings, setSettings] = useState<DesktopSettings | null>(null);
  const [activePanel, setActivePanel] = useState<InspectorPanel>("context");
  const [busy, setBusy] = useState(false);
  const [busyStartedAt, setBusyStartedAt] = useState<number | null>(null);
  const [liveDurationMs, setLiveDurationMs] = useState(0);
  const [draft, setDraft] = useState("");
  const [attachments, setAttachments] = useState<AttachmentDescriptor[]>([]);
  const [theme, setTheme] = useState<ThemeMode>(() => (localStorage.getItem("deep-mix-theme") as ThemeMode) || "light");
  const [leftVisible, setLeftVisible] = useState(() => localStorage.getItem("deep-mix-left-visible") !== "false");
  const [rightVisible, setRightVisible] = useState(() => localStorage.getItem("deep-mix-right-visible") !== "false");
  const [leftWidth, setLeftWidth] = useState(() => readStoredNumber("deep-mix-left-width", 278));
  const [rightWidth, setRightWidth] = useState(() => readStoredNumber("deep-mix-right-width", 360));
  const [commandOpen, setCommandOpen] = useState(false);
  const [commandQuery, setCommandQuery] = useState("");
  const [toast, setToast] = useState<string | null>(null);
  const [zoomFactor, setZoomFactor] = useState(1);
  const [zoomVisible, setZoomVisible] = useState(false);
  const [newTaskOpen, setNewTaskOpen] = useState(false);
  const [newWorkspacePath, setNewWorkspacePath] = useState("");
  const [recentWorkspaces, setRecentWorkspaces] = useState<string[]>(() => readStoredList(PROJECTS_STORAGE_KEY));
  const [projectPreferences, setProjectPreferences] = useState<ProjectPreferences>(() =>
    parseProjectPreferences(localStorage.getItem(PROJECT_PREFERENCES_STORAGE_KEY)),
  );
  const [composerWorkspaceRoot, setComposerWorkspaceRoot] = useState<string | null>(null);
  const [sessionDialog, setSessionDialog] = useState<{ type: "rename" | "delete"; session: SessionRecord; value: string } | null>(null);
  const [projectDialog, setProjectDialog] = useState<{ type: "rename" | "remove"; root: string; name: string; value: string } | null>(null);
  const activeSessionIdRef = useRef<string | null>(null);
  const liveMessageFlowRef = useRef(createLiveMessageFlowState());
  const workspaceRootsRef = useRef(recentWorkspaces);
  const projectsWereStoredRef = useRef(localStorage.getItem(PROJECTS_STORAGE_KEY) !== null);
  const zoomTimerRef = useRef<number | null>(null);

  const activeSession = useMemo(
    () => sessions.find((session) => session.sessionId === activeSessionId) ?? null,
    [activeSessionId, sessions],
  );
  const toolOutputArtifacts = useMemo(() => {
    const byUri = new Map<string, ToolOutputArtifact>();
    for (const message of messages) {
      for (const tool of message.toolCalls ?? []) {
        for (const artifact of tool.result?.artifacts ?? []) byUri.set(artifact.uri, artifact);
      }
    }
    return [...byUri.values()].sort((left, right) => right.createdAt.localeCompare(left.createdAt));
  }, [messages]);

  useEffect(() => { activeSessionIdRef.current = activeSessionId; }, [activeSessionId]);
  useEffect(() => {
    document.documentElement.dataset.theme = theme;
    localStorage.setItem("deep-mix-theme", theme);
    void runtime.setTheme(theme);
  }, [theme]);
  useEffect(() => {
    localStorage.setItem("deep-mix-left-visible", String(leftVisible));
    localStorage.setItem("deep-mix-right-visible", String(rightVisible));
    localStorage.setItem("deep-mix-left-width", String(leftWidth));
    localStorage.setItem("deep-mix-right-width", String(rightWidth));
  }, [leftVisible, rightVisible, leftWidth, rightWidth]);
  useEffect(() => {
    workspaceRootsRef.current = recentWorkspaces;
    localStorage.setItem(PROJECTS_STORAGE_KEY, JSON.stringify(recentWorkspaces));
  }, [recentWorkspaces]);
  useEffect(() => {
    localStorage.setItem(PROJECT_PREFERENCES_STORAGE_KEY, JSON.stringify(projectPreferences));
  }, [projectPreferences]);
  useEffect(() => {
    if (!busyStartedAt) {
      setLiveDurationMs(0);
      return;
    }
    const update = () => setLiveDurationMs(Date.now() - busyStartedAt);
    update();
    const timer = window.setInterval(update, 250);
    return () => window.clearInterval(timer);
  }, [busyStartedAt]);
  useEffect(() => {
    if (!toast) return;
    const timer = window.setTimeout(() => setToast(null), 3600);
    return () => window.clearTimeout(timer);
  }, [toast]);
  useEffect(() => () => {
    if (zoomTimerRef.current !== null) window.clearTimeout(zoomTimerRef.current);
  }, []);

  const applyZoom = useCallback(async (action: "in" | "out" | "reset") => {
    const next = await runtime.setZoom(action);
    setZoomFactor(next);
    setZoomVisible(true);
    if (zoomTimerRef.current !== null) window.clearTimeout(zoomTimerRef.current);
    zoomTimerRef.current = window.setTimeout(() => {
      setZoomVisible(false);
      zoomTimerRef.current = null;
    }, 2600);
    return next;
  }, []);
  useEffect(() => {
    const sessionId = activeSessionId;
    setProcesses([]);
    if (!sessionId) return;
    let cancelled = false;
    const refresh = async () => {
      try {
        const next = await runtime.listManagedProcesses(sessionId);
        if (!cancelled && activeSessionIdRef.current === sessionId) setProcesses(next);
      } catch {
        if (!cancelled && activeSessionIdRef.current === sessionId) setProcesses([]);
      }
    };
    void refresh();
    const timer = window.setInterval(() => void refresh(), 1500);
    return () => {
      cancelled = true;
      window.clearInterval(timer);
    };
  }, [activeSessionId]);

  const rememberWorkspace = useCallback((workspaceRoot: string) => {
    const roots = rememberProject(workspaceRootsRef.current, workspaceRoot);
    workspaceRootsRef.current = roots;
    projectsWereStoredRef.current = true;
    setRecentWorkspaces(roots);
    return roots;
  }, []);

  const refreshSessions = useCallback(async () => {
    const nextSessions = await runtime.listSessions(workspaceRootsRef.current);
    setSessions(nextSessions);
    return nextSessions;
  }, []);

  const loadSession = useCallback(async (sessionId: string) => {
    const detail = await runtime.loadSession(sessionId);
    if (!detail) return;
    setActiveSessionId(sessionId);
    activeSessionIdRef.current = sessionId;
    setMessages(buildDisplayHistory(detail.messages, detail.turns));
    setPlanItems(detail.session.planItems ?? []);
    setApprovals(detail.approvals ?? []);
    setPendingUserInput(detail.pendingUserInput ?? null);
    setWorkers([]);
    setArtifacts([]);
    setDiagnostics(null);
    setProcesses([]);
    setStoppingProcessIds(new Set());
    setComposerWorkspaceRoot(detail.session.workspaceRoot);
    liveMessageFlowRef.current = createLiveMessageFlowState();
    void runtime.getSettings(detail.session.workspaceRoot).then(setSettings).catch((error) => setToast((error as Error).message));
    if (detail.session.unread) {
      const updated = await runtime.mutateSession({ sessionId, unread: false });
      setSessions((current) => current.map((entry) => entry.sessionId === sessionId ? updated : entry));
    }
    await Promise.all([
      runtime.refreshPlan(sessionId),
      runtime.refreshDiagnostics(sessionId),
      runtime.refreshWorkers(sessionId),
    ]);
  }, []);

  useEffect(() => {
    let cancelled = false;
    void runtime.getSettings().then(async (nextSettings) => {
      if (cancelled) return;
      const roots = projectsWereStoredRef.current
        ? workspaceRootsRef.current
        : rememberProject(workspaceRootsRef.current, nextSettings.workspaceRoot);
      workspaceRootsRef.current = roots;
      if (!projectsWereStoredRef.current) {
        projectsWereStoredRef.current = true;
        setRecentWorkspaces(roots);
      }
      const nextSessions = await runtime.listSessions(roots);
      let activeSettings: DesktopSettings | null = null;
      for (const root of roots) {
        try {
          activeSettings = root === nextSettings.workspaceRoot ? nextSettings : await runtime.activateWorkspace(root);
          break;
        } catch {
          // Keep unavailable projects visible so the user can rename or remove them.
        }
      }
      setSettings(activeSettings);
      setComposerWorkspaceRoot(activeSettings?.workspaceRoot ?? null);
      setSessions(nextSessions);
      const firstVisible = nextSessions.find((session) => !session.archivedAt);
      if (firstVisible) await loadSession(firstVisible.sessionId);
    }).catch((error) => setToast((error as Error).message));
    return () => { cancelled = true; };
  }, [loadSession]);

  const clearCurrent = useCallback(() => {
    setActiveSessionId(null);
    activeSessionIdRef.current = null;
    liveMessageFlowRef.current = createLiveMessageFlowState();
    setMessages([]);
    setPlanItems([]);
    setApprovals([]);
    setPendingUserInput(null);
    setWorkers([]);
    setArtifacts([]);
    setDiagnostics(null);
    setProcesses([]);
    setStoppingProcessIds(new Set());
    setAttachments([]);
    setDraft("");
    window.setTimeout(() => document.getElementById("deep-mix-composer")?.focus(), 0);
  }, []);

  const beginTaskInWorkspace = useCallback(async (workspaceRoot: string) => {
    try {
      const nextSettings = await runtime.activateWorkspace(workspaceRoot);
      setSettings(nextSettings);
      setComposerWorkspaceRoot(nextSettings.workspaceRoot);
      const roots = rememberWorkspace(nextSettings.workspaceRoot);
      setSessions(await runtime.listSessions(roots));
      clearCurrent();
      setNewTaskOpen(false);
      return true;
    } catch (error) {
      setToast(`无法打开工作目录：${(error as Error).message}`);
      return false;
    }
  }, [clearCurrent, rememberWorkspace]);

  const openNewTask = useCallback((workspaceRoot?: string) => {
    if (workspaceRoot) {
      void beginTaskInWorkspace(workspaceRoot);
      return;
    }
    setNewWorkspacePath(activeSession?.workspaceRoot ?? composerWorkspaceRoot ?? settings?.workspaceRoot ?? recentWorkspaces[0] ?? "");
    setNewTaskOpen(true);
  }, [activeSession?.workspaceRoot, beginTaskInWorkspace, composerWorkspaceRoot, recentWorkspaces, settings?.workspaceRoot]);

  const confirmNewTask = useCallback(async () => {
    const target = newWorkspacePath.trim();
    if (!target) {
      setToast("请选择或输入一个工作目录");
      return;
    }
    await beginTaskInWorkspace(target);
  }, [beginTaskInWorkspace, newWorkspacePath]);

  const selectStreamSession = useCallback((sessionId: string) => {
    if (sessionId !== "unknown" && sessionId !== activeSessionIdRef.current) {
      activeSessionIdRef.current = sessionId;
      setActiveSessionId(sessionId);
    }
  }, []);

  const projectLiveMessageEvent = useCallback((event: LiveMessageFlowEvent) => {
    setMessages((current) => {
      const projected = reduceLiveMessageFlow(current, liveMessageFlowRef.current, event);
      liveMessageFlowRef.current = projected.state;
      return projected.messages;
    });
  }, []);

  useEffect(() => {
    const unsubscribers = [
      runtime.onStreamText((event) => {
        selectStreamSession(event.sessionId);
        projectLiveMessageEvent({ type: "text", chunk: event.chunk });
      }),
      runtime.onToolBatchStart((event) => {
        selectStreamSession(event.sessionId);
        projectLiveMessageEvent({
          type: "tool_batch_start",
          batchId: event.assistantMessageId,
          toolCalls: event.toolCalls,
        });
      }),
      runtime.onToolStart((event) => {
        selectStreamSession(event.sessionId);
        projectLiveMessageEvent({
          type: "tool_start",
          toolCall: event.toolCall,
          displayName: readToolDisplayName(event.toolCall),
        });
      }),
      runtime.onToolEnd((event) => {
        selectStreamSession(event.sessionId);
        projectLiveMessageEvent({
          type: "tool_end",
          result: event.result,
          displayName: readToolDisplayName(event.result),
        });
        if (event.sessionId === activeSessionIdRef.current && WORKER_LIFECYCLE_TOOLS.has(event.result.toolName)) {
          void runtime.refreshWorkers(event.sessionId).catch((error) => setToast((error as Error).message));
        }
      }),
      runtime.onPlanUpdate((event) => setPlanItems(event.planItems)),
      runtime.onApprovalRequested((event) => {
        setApprovals((current) => [...current.filter((entry) => entry.requestKey !== event.requestKey), event]);
        setBusy(false);
        setBusyStartedAt(null);
      }),
      runtime.onUserInputRequested((event) => {
        if (!activeSessionIdRef.current || event.sessionId === activeSessionIdRef.current) {
          setPendingUserInput(event);
          if (event.mode === "blocking") {
            setBusy(false);
            setBusyStartedAt(null);
          }
        }
      }),
      runtime.onWorkerStatus((event) => setWorkers((current) => {
        const index = current.findIndex((entry) => entry.workerSessionId === event.workerSessionId);
        if (index < 0) return [event, ...current];
        const next = [...current];
        next[index] = event;
        return next;
      })),
      runtime.onWorkerArtifact((event) => setArtifacts((current) => current.some((entry) => entry.artifactId === event.artifactId) ? current : [event, ...current])),
      runtime.onDiagnostics(setDiagnostics),
      runtime.onSessionUpdated((event) => {
        if (event.sessionId && event.sessionId !== "unknown" && !activeSessionIdRef.current) {
          activeSessionIdRef.current = event.sessionId;
          setActiveSessionId(event.sessionId);
        }
        if (event.sessionId === activeSessionIdRef.current && event.status && event.status !== "ask_permission") {
          setApprovals([]);
        }
        if (
          event.sessionId === activeSessionIdRef.current
          && (event.status === "completed" || event.status === "failed" || event.status === "interrupted")
        ) {
          setPendingUserInput(null);
        }
        setSessions((current) => {
          if (event.workspaceRoot && !workspaceRootsRef.current.includes(event.workspaceRoot)) return current;
          const index = current.findIndex((session) => session.sessionId === event.sessionId);
          if (index < 0 && event.title) return [event, ...current];
          if (index < 0) return current;
          const next = [...current];
          next[index] = { ...next[index], ...event };
          return next;
        });
      }),
    ];
    return () => unsubscribers.forEach((unsubscribe) => unsubscribe());
  }, [projectLiveMessageEvent, selectStreamSession]);

  const appendLocalMessage = useCallback((content: string, role: "assistant" | "status" = "assistant") => {
    const id = `local-${Date.now()}-${Math.random().toString(16).slice(2)}`;
    setMessages((current) => [...current, {
      id,
      turnId: `local-turn-${id}`,
      role,
      content,
      timestamp: new Date().toISOString(),
    }]);
  }, []);

  const handleCopyText = useCallback(async (value: string, label = "内容") => {
    try {
      const copied = await runtime.copyText(value);
      setToast(copied ? `${label}已复制` : "复制失败，请重试");
      return copied;
    } catch (error) {
      setToast(`复制失败：${(error as Error).message}`);
      return false;
    }
  }, []);

  const handleExport = useCallback(async () => {
    if (!activeSessionIdRef.current) {
      appendLocalMessage("当前没有可导出的会话。", "status");
      return;
    }
    const result = await runtime.exportSession(activeSessionIdRef.current);
    if (!result.cancelled && result.outputPath) {
      setToast(`已导出到 ${result.outputPath}`);
      appendLocalMessage(`会话已导出到：\n\n\`${result.outputPath}\``);
    }
  }, [appendLocalMessage]);

  const handleUndo = useCallback(async () => {
    if (!activeSessionIdRef.current || busy) return;
    const result = await runtime.undoSession(activeSessionIdRef.current);
    setToast(result.output);
    appendLocalMessage(result.output, result.success ? "assistant" : "status");
    if (result.success) await loadSession(activeSessionIdRef.current);
  }, [appendLocalMessage, busy, loadSession]);

  const executeSlashCommand = useCallback(async (raw: string) => {
    const [command, ...args] = raw.trim().split(/\s+/);
    const name = command.toLowerCase();
    const session = sessions.find((entry) => entry.sessionId === activeSessionIdRef.current);
    if (name === "/help") {
      appendLocalMessage([
        "### 桌面命令",
        "",
        "| 命令 | 作用 |",
        "| --- | --- |",
        "| `/help` | 查看全部命令 |",
        "| `/context` | 查看上下文、token 与处理时长 |",
        "| `/compact` | 将早期回合压缩为摘要，保留完整聊天记录 |",
        "| `/status` | 查看当前会话与运行设置 |",
        "| `/session` | 显示并复制会话 ID |",
        "| `/resume [id]` | 恢复指定或最近会话 |",
        "| `/continue` | 继续当前或最近会话 |",
        "| `/undo` | 恢复最近检查点 |",
        "| `/export` | 导出当前会话为 Markdown |",
        "| `/zoom-in` `/zoom-out` `/zoom-reset` | 调整界面缩放 |",
        "| `/new` | 打开新建任务窗口 |",
      ].join("\n"));
      return;
    }
    if (name === "/context") {
      if (!session) return appendLocalMessage("当前没有活动会话。", "status");
      const budget = session.latestContextBudget;
      const usage = session.latestTokenUsage;
      appendLocalMessage([
        "### 上下文状态",
        "",
        `- **模型：** ${budget?.model ?? usage?.model ?? "不可用"}`,
        `- **当前输入：** ${formatTokens(budget?.usedInputTokens)} / ${formatTokens(budget?.inputBudgetTokens)}（${budget?.usagePercent?.toFixed(1) ?? "—"}%）`,
        `- **剩余预算：** ${formatTokens(budget?.remainingInputTokens)}`,
        `- **最近调用：** 输入 ${formatTokens(usage?.inputTokens)} · 输出 ${formatTokens(usage?.outputTokens)} · 推理 ${formatTokens(usage?.reasoningTokens)}`,
        `- **处理时长：** ${formatDuration(session.latestTaskDuration?.durationMs)}`,
        session.latestCompaction?.triggered ? `- **最近压缩：** 节省 ${formatTokens(session.latestCompaction.tokensSaved)} tokens` : "- **最近压缩：** 未触发",
      ].join("\n"));
      setActivePanel("context");
      return;
    }
    if (name === "/compact") {
      if (!session) return appendLocalMessage("当前没有可压缩的会话。", "status");
      setBusy(true);
      try {
        const result = await runtime.compactSession(session.sessionId);
        if (result.compacted) {
          appendLocalMessage(`### 上下文压缩完成\n\n已将 **${result.messageCountCompacted} 条早期消息**压缩为摘要，预计节省 **${formatTokens(result.tokensSaved)} tokens**。完整聊天记录仍然保留。`);
          await refreshSessions();
        } else {
          appendLocalMessage("当前只有最近两个回合，不需要压缩。", "status");
        }
      } catch (error) {
        appendLocalMessage(`压缩失败：${(error as Error).message}`, "status");
      } finally {
        setBusy(false);
      }
      return;
    }
    if (name === "/status") {
      appendLocalMessage(session ? [
        "### 当前状态",
        "",
        `- **会话：** ${session.title}`,
        `- **状态：** ${sessionStatusLabel(session.status)}`,
        `- **工作区：** \`${settings?.workspaceRoot ?? session.workspaceRoot}\``,
        `- **权限：** ${settings?.permissionMode ?? "—"}`,
        `- **路由：** ${settings?.routeOverride ?? "自动"}`,
        `- **思考深度：** ${settings?.reasoningEffort ?? "—"}`,
      ].join("\n") : "当前没有活动会话。", session ? "assistant" : "status");
      return;
    }
    if (name === "/session") {
      if (!session) return appendLocalMessage("当前没有活动会话。", "status");
      await handleCopyText(session.sessionId, "会话 ID");
      appendLocalMessage(`当前会话 ID 已复制：\n\n\`${session.sessionId}\``);
      return;
    }
    if (name === "/resume" || name === "/continue") {
      const resumed = await runtime.resumeSession(
        args[0] || (name === "/continue" ? activeSessionIdRef.current ?? undefined : undefined),
        workspaceRootsRef.current,
      );
      if (!resumed) return appendLocalMessage("没有可恢复的会话。", "status");
      await loadSession(resumed.sessionId);
      setToast(`已恢复 ${resumed.title}`);
      return;
    }
    if (name === "/undo") return handleUndo();
    if (name === "/export") return handleExport();
    if (name === "/new") return openNewTask();
    if (name === "/zoom-in" || name === "/zoom-out" || name === "/zoom-reset") {
      const action = name === "/zoom-in" ? "in" : name === "/zoom-out" ? "out" : "reset";
      await applyZoom(action);
      return;
    }
    appendLocalMessage(`未知命令：\`${command}\`\n\n输入 \`/help\` 查看可用命令。`, "status");
  }, [appendLocalMessage, applyZoom, handleCopyText, handleExport, handleUndo, loadSession, openNewTask, refreshSessions, sessions, settings]);

  const handleSend = useCallback(async () => {
    if (busy || approvals.length > 0 || pendingUserInput?.mode === "blocking") return;
    const prompt = draft.trim() || "请分析我添加的附件，并给出下一步可执行结果。";
    if (!prompt && attachments.length === 0) return;
    setDraft("");
    if (prompt.startsWith("/")) {
      await executeSlashCommand(prompt);
      return;
    }

    const outgoingAttachments = attachments;
    const nextLiveFlow = createLiveMessageFlowState();
    liveMessageFlowRef.current = nextLiveFlow;
    setAttachments([]);
    setMessages((current) => [...current, {
      id: `user-${Date.now()}`,
      turnId: nextLiveFlow.turnId,
      role: "user",
      content: prompt,
      timestamp: new Date().toISOString(),
      ...(outgoingAttachments.length > 0 ? { attachments: outgoingAttachments } : {}),
    }]);
    setBusy(true);
    setBusyStartedAt(Date.now());
    const targetWorkspaceRoot = activeSession?.workspaceRoot ?? composerWorkspaceRoot ?? settings?.workspaceRoot;
    try {
      await runtime.sendPrompt({
        sessionId: activeSessionIdRef.current ?? undefined,
        workspaceRoot: targetWorkspaceRoot,
        prompt,
        routeOverride: settings?.routeOverride,
        attachments: outgoingAttachments,
      });
      const nextSessions = await refreshSessions();
      const selectedId = activeSessionIdRef.current
        ?? nextSessions.find((session) => session.workspaceRoot === targetWorkspaceRoot)?.sessionId;
      if (selectedId) {
        const detail = await runtime.loadSession(selectedId);
        if (detail?.session) {
          setPlanItems(detail.session.planItems);
          setApprovals(detail.approvals);
          setPendingUserInput(detail.pendingUserInput ?? null);
          setSessions((current) => current.map((entry) => entry.sessionId === selectedId ? detail.session : entry));
        }
      }
    } catch (error) {
      setAttachments((current) => [
        ...outgoingAttachments.filter((entry) => !current.some((existing) => existing.path === entry.path)),
        ...current,
      ]);
      setMessages((current) => [...current, { id: `error-${Date.now()}`, role: "status", content: (error as Error).message, timestamp: new Date().toISOString() }]);
      setToast("任务执行失败，请查看运行状态");
    } finally {
      projectLiveMessageEvent({ type: "complete" });
      setBusy(false);
      setBusyStartedAt(null);
    }
  }, [activeSession?.workspaceRoot, approvals.length, attachments, busy, composerWorkspaceRoot, draft, executeSlashCommand, pendingUserInput, projectLiveMessageEvent, refreshSessions, settings?.routeOverride, settings?.workspaceRoot]);

  const handleUserInputResponse = useCallback(async (answers?: UserInputAnswer[], cancel = false) => {
    const request = pendingUserInput;
    if (!request || busy) return;
    setPendingUserInput(null);
    setBusy(true);
    setBusyStartedAt(Date.now());
    liveMessageFlowRef.current = createLiveMessageFlowState(undefined, request.turnId);
    try {
      await runtime.respondToUserInput({
        sessionId: request.sessionId,
        requestId: request.requestId,
        answers,
        cancel,
        cancelReason: cancel ? "Cancelled from the desktop interface." : undefined,
      });
      await refreshSessions();
      await loadSession(request.sessionId);
    } catch (error) {
      setPendingUserInput((current) => current ?? request);
      setMessages((current) => [...current, {
        id: `question-error-${Date.now()}`,
        role: "status",
        content: `无法提交回答：${(error as Error).message}`,
        timestamp: new Date().toISOString(),
      }]);
      setToast("回答未提交，请检查后重试");
    } finally {
      projectLiveMessageEvent({ type: "complete" });
      setBusy(false);
      setBusyStartedAt(null);
    }
  }, [busy, loadSession, pendingUserInput, projectLiveMessageEvent, refreshSessions]);

  const handleStop = useCallback(async () => {
    const sessionId = activeSessionIdRef.current;
    if (!sessionId) return;
    await runtime.interruptSession(sessionId);
    projectLiveMessageEvent({ type: "complete" });
    setBusy(false);
    setBusyStartedAt(null);
    setToast("当前任务已停止");
  }, [projectLiveMessageEvent]);

  const handleStopManagedProcess = useCallback(async (processSessionId: string) => {
    const sessionId = activeSessionIdRef.current;
    if (!sessionId) return;
    setStoppingProcessIds((current) => new Set(current).add(processSessionId));
    try {
      const response = await runtime.stopManagedProcess(sessionId, processSessionId);
      if (response.status === "approval_required") {
        setToast("停止进程需要审批，已发送到当前任务。");
      } else if (response.result?.success) {
        setToast("进程已停止");
      } else {
        setToast(response.result?.output || "进程停止结果无法确认");
      }
      const next = await runtime.listManagedProcesses(sessionId);
      if (activeSessionIdRef.current === sessionId) setProcesses(next);
    } catch (error) {
      setToast(`无法停止进程：${(error as Error).message}`);
    } finally {
      setStoppingProcessIds((current) => {
        const next = new Set(current);
        next.delete(processSessionId);
        return next;
      });
    }
  }, []);

  const handleResolveApproval = useCallback(async (approval: ApprovalRecord, persistence: "allow_once" | "allow_session" | "deny") => {
    setApprovals((current) => current.filter((entry) => entry.requestKey !== approval.requestKey));
    setBusy(true);
    setBusyStartedAt(Date.now());
    try {
      await runtime.resolveApproval({
        sessionId: approval.sessionId,
        approvalId: approval.approvalId,
        toolName: approval.toolName,
        requestKey: approval.requestKey,
        persistence,
        reason: "Desktop user decision",
      });
      const detail = await runtime.loadSession(approval.sessionId);
      setApprovals(detail?.approvals ?? []);
      setToast(persistence === "deny" ? "已拒绝该操作" : "已批准，任务继续执行");
      await refreshSessions();
    } catch (error) {
      setToast((error as Error).message);
      const detail = await runtime.loadSession(approval.sessionId);
      setApprovals(detail?.approvals ?? []);
    } finally {
      projectLiveMessageEvent({ type: "complete" });
      setBusy(false);
      setBusyStartedAt(null);
    }
  }, [projectLiveMessageEvent, refreshSessions]);

  const updateSettings = useCallback(async (patch: DesktopSettingsPatch) => {
    try {
      const targetRoot = activeSession?.workspaceRoot ?? composerWorkspaceRoot ?? settings?.workspaceRoot;
      setSettings(await runtime.updateSettings(patch, targetRoot));
      setToast("设置已保存并应用");
    } catch (error) {
      setToast(`设置未保存：${(error as Error).message}`);
    }
  }, [activeSession?.workspaceRoot, composerWorkspaceRoot, settings?.workspaceRoot]);

  const handlePickAttachments = useCallback(async () => {
    const targetRoot = activeSession?.workspaceRoot ?? composerWorkspaceRoot ?? settings?.workspaceRoot;
    if (!targetRoot) {
      setToast("请先添加或打开一个项目，再选择附件");
      return;
    }
    try {
      const selected = await runtime.chooseAttachments(targetRoot);
      setAttachments((current) => [...current, ...selected.filter((entry) => !current.some((existing) => existing.path === entry.path))]);
    } catch (error) {
      setToast(`无法添加附件：${(error as Error).message}`);
    }
  }, [activeSession?.workspaceRoot, composerWorkspaceRoot, settings?.workspaceRoot]);

  const handleDropFiles = useCallback(async (files: File[]) => {
    const targetRoot = activeSession?.workspaceRoot ?? composerWorkspaceRoot ?? settings?.workspaceRoot;
    if (!targetRoot) {
      setToast("请先添加或打开一个项目，再拖入附件");
      return;
    }
    const paths = files.map((file) => runtime.getPathForFile(file)).filter(Boolean);
    try {
      const selected = await runtime.describeDroppedFiles(paths, targetRoot);
      setAttachments((current) => [...current, ...selected.filter((entry) => !current.some((existing) => existing.path === entry.path))]);
    } catch (error) {
      setToast(`无法添加附件：${(error as Error).message}`);
    }
  }, [activeSession?.workspaceRoot, composerWorkspaceRoot, settings?.workspaceRoot]);

  const handlePasteImage = useCallback(async () => {
    const targetRoot = activeSession?.workspaceRoot ?? composerWorkspaceRoot ?? settings?.workspaceRoot;
    if (!targetRoot) {
      setToast("请先添加或打开一个项目，再粘贴图片");
      return;
    }
    try {
      const attachment = await runtime.readClipboardImage(targetRoot);
      if (!attachment) {
        setToast("剪贴板中没有可读取的图片");
        return;
      }
      setAttachments((current) => current.some((entry) => entry.path === attachment.path) ? current : [...current, attachment]);
      setToast("剪贴板图片已添加");
    } catch (error) {
      setToast(`无法粘贴图片：${(error as Error).message}`);
    }
  }, [activeSession?.workspaceRoot, composerWorkspaceRoot, settings?.workspaceRoot]);

  const handleChooseWorkspace = useCallback(async () => {
    if (busy) return;
    const selected = await runtime.pickWorkspace();
    if (!selected) return;
    try {
      const nextSettings = await runtime.activateWorkspace(selected);
      const roots = rememberWorkspace(nextSettings.workspaceRoot);
      setSessions(await runtime.listSessions(roots));
      if (!composerWorkspaceRoot) {
        setSettings(nextSettings);
        setComposerWorkspaceRoot(nextSettings.workspaceRoot);
      }
      setToast(`已添加项目 ${nextSettings.workspaceName}`);
    } catch (error) {
      setToast(`无法添加项目：${(error as Error).message}`);
    }
  }, [busy, composerWorkspaceRoot, rememberWorkspace]);

  const handleProjectAction = useCallback((action: ProjectAction, root: string, name: string) => {
    if (action === "rename") {
      setProjectDialog({ type: "rename", root, name, value: name });
      return;
    }
    if (action === "remove") {
      setProjectDialog({ type: "remove", root, name, value: "" });
      return;
    }
    setProjectPreferences((current) => {
      const next = { ...current };
      const preference = { ...(next[root] ?? {}) };
      if (preference.pinnedAt) delete preference.pinnedAt;
      else preference.pinnedAt = new Date().toISOString();
      if (preference.name || preference.pinnedAt) next[root] = preference;
      else delete next[root];
      return next;
    });
    setToast(projectPreferences[root]?.pinnedAt ? "已取消项目置顶" : "项目已置顶");
  }, [projectPreferences]);

  const confirmProjectDialog = useCallback(async () => {
    if (!projectDialog) return;
    if (projectDialog.type === "rename") {
      const name = projectDialog.value.trim();
      if (!name) {
        setToast("项目名称不能为空");
        return;
      }
      setProjectPreferences((current) => ({
        ...current,
        [projectDialog.root]: { ...(current[projectDialog.root] ?? {}), name: name.slice(0, 80) },
      }));
      setProjectDialog(null);
      setToast("项目已重命名");
      return;
    }

    const nextRoots = removeProject(workspaceRootsRef.current, projectDialog.root);
    workspaceRootsRef.current = nextRoots;
    setRecentWorkspaces(nextRoots);
    setProjectPreferences((current) => {
      const next = { ...current };
      delete next[projectDialog.root];
      return next;
    });

    const removedActiveProject = activeSession?.workspaceRoot === projectDialog.root || composerWorkspaceRoot === projectDialog.root;
    if (removedActiveProject) clearCurrent();
    const nextSessions = await runtime.listSessions(nextRoots);
    setSessions(nextSessions);
    if (removedActiveProject) {
      if (nextRoots[0]) {
        try {
          const nextSettings = await runtime.activateWorkspace(nextRoots[0]);
          setSettings(nextSettings);
          setComposerWorkspaceRoot(nextSettings.workspaceRoot);
        } catch {
          setSettings(null);
          setComposerWorkspaceRoot(null);
        }
      } else {
        setSettings(null);
        setComposerWorkspaceRoot(null);
      }
    }
    setProjectDialog(null);
    setToast("项目已从列表移除，目录和会话文件均未删除");
  }, [activeSession?.workspaceRoot, clearCurrent, composerWorkspaceRoot, projectDialog]);

  const handleSessionAction = useCallback(async (action: SessionAction, session: SessionRecord) => {
    if (action === "rename") {
      setSessionDialog({ type: "rename", session, value: session.title });
      return;
    }
    if (action === "delete") {
      setSessionDialog({ type: "delete", session, value: "" });
      return;
    }
    if (action === "copy-id") {
      await handleCopyText(session.sessionId, "会话 ID");
      return;
    }
    const updated = await runtime.mutateSession({
      sessionId: session.sessionId,
      ...(action === "pin" ? { pinned: !session.pinnedAt } : {}),
      ...(action === "archive" ? { archived: !session.archivedAt } : {}),
      ...(action === "mark-unread" ? { unread: true } : {}),
    });
    setSessions((current) => current.map((entry) => entry.sessionId === updated.sessionId ? updated : entry));
    if (action === "archive" && !session.archivedAt && session.sessionId === activeSessionIdRef.current) clearCurrent();
    setToast(action === "pin" ? (updated.pinnedAt ? "会话已置顶" : "已取消置顶") : action === "archive" ? (updated.archivedAt ? "会话已归档" : "会话已移出归档") : "已标记为未读");
  }, [clearCurrent, handleCopyText]);

  const confirmSessionDialog = useCallback(async () => {
    if (!sessionDialog) return;
    if (sessionDialog.type === "rename") {
      const updated = await runtime.mutateSession({ sessionId: sessionDialog.session.sessionId, title: sessionDialog.value });
      setSessions((current) => current.map((entry) => entry.sessionId === updated.sessionId ? updated : entry));
      setSessionDialog(null);
      setToast("会话已重命名");
      return;
    }
    const deleted = await runtime.deleteSession(sessionDialog.session.sessionId);
    if (deleted) {
      const wasActive = sessionDialog.session.sessionId === activeSessionIdRef.current;
      const nextSessions = await refreshSessions();
      if (wasActive) {
        clearCurrent();
        const next = nextSessions.find((entry) => !entry.archivedAt);
        if (next) await loadSession(next.sessionId);
      }
      setToast("会话已永久删除");
    }
    setSessionDialog(null);
  }, [clearCurrent, loadSession, refreshSessions, sessionDialog]);

  const beginResize = useCallback((side: "left" | "right", event: React.PointerEvent) => {
    event.preventDefault();
    const origin = event.clientX;
    const startWidth = side === "left" ? leftWidth : rightWidth;
    document.body.classList.add("is-resizing");
    const move = (moveEvent: PointerEvent) => {
      const delta = moveEvent.clientX - origin;
      if (side === "left") setLeftWidth(clamp(startWidth + delta, 220, 420));
      else setRightWidth(clamp(startWidth - delta, 300, 520));
    };
    const end = () => {
      document.body.classList.remove("is-resizing");
      window.removeEventListener("pointermove", move);
      window.removeEventListener("pointerup", end);
    };
    window.addEventListener("pointermove", move);
    window.addEventListener("pointerup", end);
  }, [leftWidth, rightWidth]);

  useEffect(() => {
    const handleKey = (event: KeyboardEvent) => {
      if (!(event.ctrlKey || event.metaKey)) {
        if (event.key === "Escape") {
          setCommandOpen(false);
          setNewTaskOpen(false);
          setSessionDialog(null);
          setProjectDialog(null);
        }
        return;
      }
      const key = event.key.toLowerCase();
      if (key === "n") { event.preventDefault(); openNewTask(); }
      if (key === "k") { event.preventDefault(); setCommandOpen(true); setCommandQuery(""); }
      if (key === "b" && event.shiftKey) { event.preventDefault(); setRightVisible((value) => !value); }
      else if (key === "b") { event.preventDefault(); setLeftVisible((value) => !value); }
      if (key === "l") { event.preventDefault(); document.getElementById("deep-mix-composer")?.focus(); }
      if (key === "+" || key === "=") { event.preventDefault(); void applyZoom("in"); }
      if (key === "-") { event.preventDefault(); void applyZoom("out"); }
      if (key === "0") { event.preventDefault(); void applyZoom("reset"); }
    };
    window.addEventListener("keydown", handleKey);
    return () => window.removeEventListener("keydown", handleKey);
  }, [applyZoom, openNewTask]);

  const commandItems = useMemo(() => [
    { id: "new", label: "新建任务并选择工作目录", hint: "Ctrl N", icon: "plus" as const, action: openNewTask },
    { id: "focus", label: "聚焦输入框", hint: "Ctrl L", icon: "command" as const, action: () => document.getElementById("deep-mix-composer")?.focus() },
    { id: "context", label: "查看上下文使用", hint: "/context", icon: "context" as const, action: () => void executeSlashCommand("/context") },
    { id: "compact", label: "压缩会话上下文", hint: "/compact", icon: "archive" as const, action: () => void executeSlashCommand("/compact") },
    { id: "plugins", label: "管理插件", hint: "", icon: "plugin" as const, action: () => { setActivePanel("plugins"); setRightVisible(true); } },
    { id: "export", label: "导出当前任务", hint: "/export", icon: "download" as const, action: handleExport },
    { id: "undo", label: "撤销到最近检查点", hint: "/undo", icon: "undo" as const, action: handleUndo },
    { id: "zoom-in", label: "放大界面", hint: "Ctrl +", icon: "zoom-in" as const, action: () => void applyZoom("in") },
    { id: "zoom-out", label: "缩小界面", hint: "Ctrl -", icon: "zoom-out" as const, action: () => void applyZoom("out") },
    { id: "settings", label: "打开设置", hint: "", icon: "settings" as const, action: () => { setActivePanel("settings"); setRightVisible(true); } },
  ].filter((item) => item.label.toLowerCase().includes(commandQuery.toLowerCase())), [applyZoom, commandQuery, executeSlashCommand, handleExport, handleUndo, openNewTask]);

  const completedDuration = activeSession?.latestTaskDuration?.durationMs;
  const shownDuration = busy ? liveDurationMs : completedDuration ?? 0;

  return (
    <div className="app-frame">
      <div className="workspace-layout">
        {leftVisible && (
          <div className="sidebar-slot" style={{ width: leftWidth }}>
            <SessionSidebar
              sessions={sessions}
              workspaceRoots={recentWorkspaces}
              projectPreferences={projectPreferences}
              activeSessionId={activeSessionId}
              composerWorkspaceRoot={composerWorkspaceRoot}
              settings={settings}
              onSelect={loadSession}
              onNew={openNewTask}
              onChooseWorkspace={handleChooseWorkspace}
              onOpenSettings={() => { setActivePanel("settings"); setRightVisible(true); }}
              onProjectAction={handleProjectAction}
              onSessionAction={handleSessionAction}
              statusLabel={sessionStatusLabel}
            />
          </div>
        )}
        {leftVisible && <div className="resize-handle resize-handle--left" onPointerDown={(event) => beginResize("left", event)} />}

        <div className="workspace-main">
          <TopBar
            session={activeSession}
            settings={settings}
            theme={theme}
            leftVisible={leftVisible}
            rightVisible={rightVisible}
            onToggleLeft={() => setLeftVisible((value) => !value)}
            onToggleRight={() => setRightVisible((value) => !value)}
            onToggleTheme={() => setTheme((value) => value === "dark" ? "light" : "dark")}
            onOpenCommand={() => setCommandOpen(true)}
            onExport={handleExport}
            onUndo={handleUndo}
            statusLabel={sessionStatusLabel}
          />
          <div className="workspace-columns">
            <section className="task-column">
              <ChatPanel sessionId={activeSessionId ?? undefined} messages={messages} busy={busy} taskTitle={activeSession?.title} liveDurationMs={liveDurationMs} taskDurationMs={completedDuration} onCopy={handleCopyText} onSuggestion={(value) => { setDraft(value); document.getElementById("deep-mix-composer")?.focus(); }} />
              {pendingUserInput && (
                <StructuredQuestionPanel
                  request={pendingUserInput}
                  busy={busy}
                  onSubmit={(answers) => void handleUserInputResponse(answers)}
                  onCancel={() => void handleUserInputResponse(undefined, true)}
                />
              )}
              <InputBar
                draft={draft}
                settings={settings}
                attachments={attachments}
                approvals={approvals}
                questionPending={pendingUserInput?.mode === "blocking"}
                busy={busy}
                onDraftChange={setDraft}
                onSend={handleSend}
                onStop={handleStop}
                onPickAttachments={handlePickAttachments}
                onDropFiles={handleDropFiles}
                onPasteImage={handlePasteImage}
                onRemoveAttachment={(id) => setAttachments((current) => current.filter((entry) => entry.id !== id))}
                onSetPermissionMode={(mode: PermissionMode) => updateSettings({ permissionMode: mode })}
                onSetReasoningEffort={(reasoningEffort) => updateSettings({ reasoningEffort })}
                onSetRoute={(route: RouteTarget | null) => updateSettings({ routeOverride: route })}
                onResolveApproval={handleResolveApproval}
              />
              <div className="task-statusbar">
                <span><i className={busy ? "is-live" : ""} />{busy ? "任务执行中" : activeSession ? sessionStatusLabel(activeSession.status) : "准备就绪"}</span>
                <span><Icon name="clock" size={12} />{shownDuration ? `${Math.floor(shownDuration / 60_000)}:${String(Math.floor(shownDuration / 1000) % 60).padStart(2, "0")}` : "0:00"}</span>
                <span><Icon name="context" size={12} />{activeSession?.latestContextBudget ? `${activeSession.latestContextBudget.usagePercent.toFixed(0)}% 上下文` : "等待上下文"}</span>
                <span className="task-statusbar__spacer" />
                <span>{settings?.gitBranch ? <><Icon name="branch" size={12} />{settings.gitBranch}</> : null}</span>
              </div>
            </section>

            {rightVisible && <div className="resize-handle resize-handle--right" onPointerDown={(event) => beginResize("right", event)} />}
            {rightVisible && (
              <div className="inspector-slot" style={{ width: rightWidth }}>
                <RightPanel
                  activePanel={activePanel}
                  session={activeSession}
                  planItems={planItems}
                  workers={workers}
                  artifacts={artifacts}
                  toolOutputArtifacts={toolOutputArtifacts}
                  processes={processes}
                  stoppingProcessIds={stoppingProcessIds}
                  diagnostics={diagnostics}
                  settings={settings}
                  busy={busy}
                  onSelectPanel={setActivePanel}
                  onUpdateSettings={updateSettings}
                  onRevealPath={(path) => void runtime.revealPath(path)}
                  onStopProcess={(processSessionId) => void handleStopManagedProcess(processSessionId)}
                />
              </div>
            )}
          </div>
        </div>
      </div>

      {newTaskOpen && (
        <div className="dialog-overlay" onMouseDown={() => setNewTaskOpen(false)}>
          <section className="product-dialog new-task-dialog" onMouseDown={(event) => event.stopPropagation()}>
            <div className="product-dialog__header">
              <div className="dialog-icon"><Icon name="plus" size={18} /></div>
              <div><small>NEW TASK</small><h2>创建新任务</h2></div>
              <button onClick={() => setNewTaskOpen(false)} aria-label="关闭"><Icon name="x" size={16} /></button>
            </div>
            <div className="product-dialog__body">
              <label className="workspace-path-field">
                <span>工作目录</span>
                <div><Icon name="folder" size={16} /><input autoFocus value={newWorkspacePath} onChange={(event) => setNewWorkspacePath(event.target.value)} placeholder="选择或输入工作目录" /><button onClick={async () => { const selected = await runtime.pickWorkspace(); if (selected) setNewWorkspacePath(selected); }}>浏览…</button></div>
              </label>
              {recentWorkspaces.length > 0 && <div className="recent-workspaces"><span>最近使用</span>{recentWorkspaces.map((entry) => <button key={entry} onClick={() => setNewWorkspacePath(entry)} className={entry === newWorkspacePath ? "is-selected" : ""}><Icon name="folder" size={14} /><span>{entry}</span>{entry === newWorkspacePath && <Icon name="check" size={13} />}</button>)}</div>}
            </div>
            <div className="product-dialog__footer"><button onClick={() => setNewTaskOpen(false)}>取消</button><button className="is-primary" onClick={() => void confirmNewTask()}>在此目录创建</button></div>
          </section>
        </div>
      )}

      {projectDialog && (
        <div className="dialog-overlay" onMouseDown={() => setProjectDialog(null)}>
          <section className={`product-dialog session-dialog${projectDialog.type === "rename" ? " project-rename-dialog" : ""}`} onMouseDown={(event) => event.stopPropagation()}>
            <div className="product-dialog__header">
              <div className={`dialog-icon${projectDialog.type === "remove" ? " is-danger" : ""}`}><Icon name={projectDialog.type === "rename" ? "edit" : "trash"} size={18} /></div>
              <div><small>PROJECT</small><h2>{projectDialog.type === "rename" ? "重命名项目" : "移除项目"}</h2></div>
              <button onClick={() => setProjectDialog(null)} aria-label="关闭"><Icon name="x" size={16} /></button>
            </div>
            <div className="product-dialog__body">
              {projectDialog.type === "rename" ? (
                <label className="dialog-text-field">
                  <span>项目显示名称</span>
                  <input autoFocus value={projectDialog.value} onChange={(event) => setProjectDialog({ ...projectDialog, value: event.target.value })} onKeyDown={(event) => { if (event.key === "Enter") void confirmProjectDialog(); }} />
                  <small className="dialog-path-hint">仅修改左侧显示名称，不重命名目录：{projectDialog.root}</small>
                </label>
              ) : (
                <div className="delete-warning">
                  <strong>“{projectDialog.name}”</strong>
                  <p>只会从左侧项目列表移除。项目目录、文件和已有会话记录都会保留，之后仍可通过“添加项目”重新打开。</p>
                </div>
              )}
            </div>
            <div className="product-dialog__footer"><button onClick={() => setProjectDialog(null)}>取消</button><button className={projectDialog.type === "remove" ? "is-danger" : "is-primary"} onClick={() => void confirmProjectDialog()}>{projectDialog.type === "rename" ? "保存名称" : "从列表移除"}</button></div>
          </section>
        </div>
      )}

      {sessionDialog && (
        <div className="dialog-overlay" onMouseDown={() => setSessionDialog(null)}>
          <section className="product-dialog session-dialog" onMouseDown={(event) => event.stopPropagation()}>
            <div className="product-dialog__header">
              <div className={`dialog-icon${sessionDialog.type === "delete" ? " is-danger" : ""}`}><Icon name={sessionDialog.type === "rename" ? "edit" : "trash"} size={18} /></div>
              <div><small>SESSION</small><h2>{sessionDialog.type === "rename" ? "重命名会话" : "删除会话"}</h2></div>
              <button onClick={() => setSessionDialog(null)} aria-label="关闭"><Icon name="x" size={16} /></button>
            </div>
            <div className="product-dialog__body">
              {sessionDialog.type === "rename" ? <label className="dialog-text-field"><span>会话名称</span><input autoFocus value={sessionDialog.value} onChange={(event) => setSessionDialog({ ...sessionDialog, value: event.target.value })} onKeyDown={(event) => { if (event.key === "Enter") void confirmSessionDialog(); }} /></label> : <div className="delete-warning"><strong>“{sessionDialog.session.title}”</strong><p>此操作会永久删除会话记录和审批状态，无法撤销。</p></div>}
            </div>
            <div className="product-dialog__footer"><button onClick={() => setSessionDialog(null)}>取消</button><button className={sessionDialog.type === "delete" ? "is-danger" : "is-primary"} onClick={() => void confirmSessionDialog()}>{sessionDialog.type === "rename" ? "保存名称" : "永久删除"}</button></div>
          </section>
        </div>
      )}

      {commandOpen && (
        <div className="command-overlay" onMouseDown={() => setCommandOpen(false)}>
          <div className="command-palette" onMouseDown={(event) => event.stopPropagation()}>
            <div className="command-palette__input"><Icon name="search" size={17} /><input autoFocus value={commandQuery} onChange={(event) => setCommandQuery(event.target.value)} placeholder="搜索操作…" /><kbd>Esc</kbd></div>
            <div className="command-palette__list">{commandItems.map((item) => <button key={item.id} onClick={() => { item.action(); setCommandOpen(false); }}><span><Icon name={item.icon} size={16} /></span><strong>{item.label}</strong><kbd>{item.hint}</kbd></button>)}</div>
          </div>
        </div>
      )}
      {zoomVisible && (
        <div className="zoom-indicator" role="status" aria-live="polite" aria-label={`当前页面缩放 ${Math.round(zoomFactor * 100)}%`}>
          <strong>{Math.round(zoomFactor * 100)}%</strong>
          <button onClick={() => void applyZoom("out")} disabled={zoomFactor <= 0.7} aria-label="缩小页面">−</button>
          <button onClick={() => void applyZoom("in")} disabled={zoomFactor >= 1.6} aria-label="放大页面">＋</button>
          <span aria-hidden="true" />
          <button className="zoom-indicator__reset" onClick={() => void applyZoom("reset")} disabled={zoomFactor === 1}>重置</button>
        </div>
      )}
      {toast && <div className="toast"><Icon name="check" size={15} /><span>{toast}</span><button onClick={() => setToast(null)}><Icon name="x" size={13} /></button></div>}
    </div>
  );
}
