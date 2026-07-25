import type {
  ApprovalRecord,
  DiagnosticReportRecord,
  PlanUpdateRecord,
  SessionRecord,
  ToolBatchStart,
  ToolCall,
  ToolResult,
  UserInputRequestRecord,
  WorkerArtifactRecord,
} from "@deep-mix/shared-schema";
import type {
  AttachmentDescriptor,
  DesktopRuntime,
  DesktopSettings,
  DesktopSettingsPatch,
  WorkerStatusView,
} from "@shared/ipc";

const now = new Date();
const iso = (offsetMinutes = 0) => new Date(now.getTime() - offsetMinutes * 60_000).toISOString();

function createMockRuntime(): DesktopRuntime {
  const sessions: SessionRecord[] = [
    {
      sessionId: "session-aurora",
      title: "重构 Deep-Mix 桌面工作台",
      status: "waiting_for_user",
      createdAt: iso(96),
      updatedAt: iso(2),
      workspaceRoot: "C:\\workspace\\deep-mix",
      jsonlPath: "sessions/session-aurora.jsonl",
      messageCount: 4,
      planItems: [
        { id: "p1", title: "核对 CLI 与桌面端能力边界", status: "completed" },
        { id: "p2", title: "重建三栏工作区与主题系统", status: "in_progress" },
        { id: "p3", title: "接入附件、插件与桌面审批", status: "pending" },
        { id: "p4", title: "构建并执行界面验收", status: "pending" },
      ],
      latestContextBudget: {
        source: "local_estimated",
        model: "deepseek-reasoner",
        recordedAt: iso(2),
        contextWindowTokens: 128000,
        inputBudgetTokens: 112000,
        softLimitTokens: 96000,
        compactThresholdTokens: 104000,
        reserveOutputTokens: 16000,
        usedInputTokens: 42760,
        remainingInputTokens: 69240,
        usagePercent: 38.2,
        selectedMessageCount: 18,
        selectedSummaryCount: 2,
        categories: [
          { key: "system_prompt", label: "系统", estimatedTokens: 7800 },
          { key: "tools", label: "工具", estimatedTokens: 9300 },
          { key: "skills_workflows_mcp", label: "扩展", estimatedTokens: 5100 },
          { key: "recent_messages", label: "消息", estimatedTokens: 16800 },
          { key: "summaries", label: "摘要", estimatedTokens: 3760 },
          { key: "free", label: "可用", estimatedTokens: 69240 },
        ],
      },
      latestTokenUsage: {
        source: "provider_exact",
        model: "deepseek-reasoner",
        recordedAt: iso(2),
        inputTokens: 42760,
        outputTokens: 2840,
        reasoningTokens: 6320,
        totalTokens: 51920,
      },
      cumulativeTokenUsage: {
        source: "provider_partial",
        model: "deepseek-reasoner",
        recordedAt: iso(2),
        inputTokens: 68420,
        outputTokens: 8920,
        reasoningTokens: 16740,
        totalTokens: 94080,
      },
      latestTaskDuration: {
        startedAt: iso(13),
        endedAt: iso(2),
        durationMs: 11 * 60_000 + 18_000,
        status: "waiting_for_user",
      },
    },
    {
      sessionId: "session-runtime",
      title: "修复工具链回退策略",
      status: "completed",
      createdAt: iso(480),
      updatedAt: iso(240),
      workspaceRoot: "C:\\workspace\\sample-project",
      jsonlPath: "sessions/session-runtime.jsonl",
      messageCount: 12,
      planItems: [],
    },
    {
      sessionId: "session-context",
      title: "实现上下文预算可视化",
      status: "completed",
      createdAt: iso(1440),
      updatedAt: iso(900),
      workspaceRoot: "C:\\workspace\\Shibor数据",
      jsonlPath: "sessions/session-context.jsonl",
      messageCount: 8,
      planItems: [],
    },
  ];

  let settings: DesktopSettings = {
    workspaceRoot: "C:\\workspace\\deep-mix",
    workspaceName: "deep-mix",
    gitBranch: "main",
    permissionMode: "auto",
    reasoningEffort: "high",
    thinkingMode: "adaptive",
    replyStyle: "pragmatic",
    profiles: {
      deepseek_governor: { exists: true, hasKey: true },
      glm_coding_worker: { exists: true, hasKey: true },
      kimi_vision: { exists: true, hasKey: true },
    },
    extensions: [
      { id: "skill:frontend-polish", name: "frontend-polish", description: "界面实现与视觉回归工作流", kind: "skill", enabled: true, state: "ready", source: "project" },
      { id: "workflow:quality-loop", name: "quality-loop", description: "检查、测试与审阅编排", kind: "workflow", enabled: true, state: "ready", source: "project" },
      { id: "mcp:github", name: "github", description: "GitHub MCP · 6 tools", kind: "mcp", enabled: true, state: "ready", toolCount: 6 },
    ],
    capabilities: ["rg", "git", "powershell", "node", "npm"].map((name) => ({ name, available: true, detail: "ready" })),
  };

  const callbacks = {
    streamText: null as ((event: { sessionId: string; turnId: string; chunk: string }) => void) | null,
    toolBatch: null as ((event: ToolBatchStart & { sessionId: string }) => void) | null,
    toolStart: null as ((event: { sessionId: string; turnId: string; toolCall: ToolCall }) => void) | null,
    toolEnd: null as ((event: { sessionId: string; turnId: string; result: ToolResult }) => void) | null,
    plan: null as ((event: PlanUpdateRecord) => void) | null,
    approval: null as ((event: ApprovalRecord) => void) | null,
    userInput: null as ((event: UserInputRequestRecord) => void) | null,
    worker: null as ((event: WorkerStatusView) => void) | null,
    artifact: null as ((event: WorkerArtifactRecord) => void) | null,
    diagnostics: null as ((event: DiagnosticReportRecord) => void) | null,
    session: null as ((event: SessionRecord) => void) | null,
  };

  const subscribe = <T extends keyof typeof callbacks>(key: T, callback: NonNullable<(typeof callbacks)[T]>) => {
    callbacks[key] = callback as never;
    return () => {
      callbacks[key] = null;
    };
  };

  return {
    createSession: async (prompt, workspaceRoot) => {
      const session: SessionRecord = {
        sessionId: `session-${Date.now()}`,
        title: "新任务",
        titleSource: "placeholder",
        status: "pending",
        createdAt: new Date().toISOString(),
        updatedAt: new Date().toISOString(),
        workspaceRoot: workspaceRoot ?? settings.workspaceRoot,
        jsonlPath: `sessions/session-${Date.now()}.jsonl`,
        messageCount: 0,
        planItems: [],
      };
      sessions.unshift(session);
      return session;
    },
    resumeSession: async (sessionId, workspaceRoots) => sessions.find((entry) => entry.sessionId === sessionId)
      ?? sessions.find((entry) => !workspaceRoots || workspaceRoots.includes(entry.workspaceRoot))
      ?? null,
    listSessions: async (workspaceRoots) => workspaceRoots
      ? sessions.filter((entry) => workspaceRoots.includes(entry.workspaceRoot))
      : sessions,
    loadSession: async (sessionId) => ({
      session: sessions.find((entry) => entry.sessionId === sessionId) ?? sessions[0]!,
      messages: sessionId === "session-aurora" ? [
        { recordType: "message", messageId: "m1", sessionId, turnId: "t1", role: "user", createdAt: iso(20), content: "把桌面端完全重构成更安静、顺滑的工作台，同时补齐 CLI 能力。" },
        { recordType: "message", messageId: "m2", sessionId, turnId: "t1", role: "assistant", createdAt: iso(18), content: "我已经完成能力盘点，并确定保留现有运行时桥接、重写整个渲染层。三栏宽度、主题、Plan、审批、附件和插件都会在同一工作区直接操作。" },
        { recordType: "message", messageId: "m3", sessionId, turnId: "t1", role: "tool", createdAt: iso(15), content: "读取桌面端与 CLI 功能边界", name: "repository_explorer", toolCallId: "tool-1", metadata: { success: true, startedAt: iso(16), endedAt: iso(15) } },
        { recordType: "message", messageId: "m4", sessionId, turnId: "t1", role: "assistant", createdAt: iso(2), content: "基础工作台已经接通。代码块现在也可以独立复制：\n\n```ts\nconst workspace = await openProject(root);\n```" },
      ] : [],
      turns: sessionId === "session-aurora" ? [{
        recordType: "turn",
        turnId: "t1",
        sessionId,
        createdAt: iso(20),
        startedAt: iso(20),
        endedAt: iso(2),
        durationMs: 18 * 60_000,
        status: "waiting_for_user",
        requestSummary: "重构桌面工作台",
        userMessageId: "m1",
        assistantMessageId: "m4",
        toolCallIds: ["tool-1"],
      }] : [],
      approvals: [],
    }),
    sendPrompt: async ({ sessionId, prompt }) => {
      const id = sessionId ?? sessions[0]!.sessionId;
      callbacks.toolBatch?.({ sessionId: id, assistantMessageId: "mock-assistant-tool-round", turnId: "current", createdAt: iso(0), toolCalls: [{ id: "mock-tool", name: "repository_explorer", arguments: {}, rawArguments: "{}" }] });
      callbacks.toolStart?.({ sessionId: id, turnId: "current", toolCall: { id: "mock-tool", name: "repository_explorer", arguments: {}, rawArguments: "{}" } });
      window.setTimeout(() => callbacks.toolEnd?.({ sessionId: id, turnId: "current", result: { toolName: "repository_explorer", callId: "mock-tool", startedAt: iso(0), endedAt: iso(0), success: true, output: "Workspace inspected" } }), 650);
      window.setTimeout(() => callbacks.streamText?.({ sessionId: id, turnId: "current", chunk: `收到：${prompt}` }), 850);
    },
    interruptSession: async () => undefined,
    listManagedProcesses: async () => [],
    stopManagedProcess: async (_sessionId, processSessionId) => ({
      status: "completed",
      result: {
        toolName: "stop_process",
        callId: `mock-stop-${processSessionId}`,
        startedAt: new Date().toISOString(),
        endedAt: new Date().toISOString(),
        success: true,
        output: "Mock managed process stopped.",
      },
    }),
    undoSession: async () => ({ success: true, output: "已恢复最近的代码与会话检查点。" }),
    exportSession: async () => ({ cancelled: false, outputPath: "C:\\workspace\\deep-mix\\session-export.md" }),
    compactSession: async (sessionId) => {
      const session = sessions.find((entry) => entry.sessionId === sessionId);
      if (session) {
        session.latestCompaction = {
          createdAt: new Date().toISOString(),
          source: "local_estimated",
          triggered: true,
          triggerReason: "manual /compact command",
          beforeTokens: 12000,
          afterTokens: 2400,
          tokensSaved: 9600,
          droppedMessageCount: 8,
          summaryCount: 1,
          retained: ["last 2 turns"],
          summaryRefs: ["mock-summary"],
        };
      }
      return { compacted: true, summaryId: "mock-summary", messageCountCompacted: 8, beforeTokens: 12000, afterTokens: 2400, tokensSaved: 9600 };
    },
    mutateSession: async (input) => {
      const session = sessions.find((entry) => entry.sessionId === input.sessionId);
      if (!session) throw new Error(`Unknown session: ${input.sessionId}`);
      if (input.title?.trim()) {
        session.title = input.title.trim();
        session.titleSource = "user";
      }
      if (typeof input.pinned === "boolean") session.pinnedAt = input.pinned ? new Date().toISOString() : undefined;
      if (typeof input.archived === "boolean") session.archivedAt = input.archived ? new Date().toISOString() : undefined;
      if (typeof input.unread === "boolean") session.unread = input.unread;
      session.updatedAt = new Date().toISOString();
      callbacks.session?.(session);
      return session;
    },
    deleteSession: async (sessionId) => {
      const index = sessions.findIndex((entry) => entry.sessionId === sessionId);
      if (index < 0) return false;
      sessions.splice(index, 1);
      return true;
    },
    resolveApproval: async () => undefined,
    respondToUserInput: async ({ sessionId }) => {
      const session = sessions.find((entry) => entry.sessionId === sessionId);
      if (session) {
        session.status = "running";
        session.updatedAt = new Date().toISOString();
        callbacks.session?.(session);
      }
    },
    getSettings: async (workspaceRoot) => workspaceRoot && workspaceRoot !== settings.workspaceRoot
      ? { ...settings, workspaceRoot, workspaceName: workspaceRoot.split(/[\\/]/).pop() ?? workspaceRoot, gitBranch: undefined }
      : settings,
    updateSettings: async (patch: DesktopSettingsPatch, workspaceRoot) => {
      settings = {
        ...settings,
        ...(workspaceRoot ? { workspaceRoot, workspaceName: workspaceRoot.split(/[\\/]/).pop() ?? workspaceRoot } : {}),
        ...patch,
        routeOverride: patch.routeOverride === null ? undefined : patch.routeOverride ?? settings.routeOverride,
        extensions: settings.extensions.map((extension) => {
          if (extension.kind !== "skill" || !patch.enabledSkills) return extension;
          return { ...extension, enabled: patch.enabledSkills[extension.name] ?? extension.enabled };
        }),
      };
      return settings;
    },
    chooseAttachments: async () => [],
    describeDroppedFiles: async (paths) => paths.map((filePath) => ({ id: crypto.randomUUID(), name: filePath.split(/[\\/]/).pop() ?? filePath, path: filePath, size: 0, mimeType: "application/octet-stream", kind: "other" as const })),
    readClipboardImage: async () => null,
    chooseWorkspace: async () => settings,
    pickWorkspace: async () => "C:\\workspace\\another-project",
    activateWorkspace: async (workspaceRoot) => {
      settings = { ...settings, workspaceRoot, workspaceName: workspaceRoot.split(/[\\/]/).pop() ?? workspaceRoot, gitBranch: undefined };
      return settings;
    },
    revealPath: async () => undefined,
    copyText: async (value) => {
      const textarea = document.createElement("textarea");
      textarea.value = value;
      textarea.style.position = "fixed";
      textarea.style.opacity = "0";
      document.body.appendChild(textarea);
      textarea.select();
      const copied = document.execCommand("copy");
      textarea.remove();
      return copied;
    },
    setZoom: (() => {
      let zoom = 1;
      return async (action) => {
        zoom = action === "reset" ? 1 : Math.min(1.6, Math.max(0.7, zoom + (action === "in" ? 0.1 : -0.1)));
        return Number(zoom.toFixed(2));
      };
    })(),
    setTheme: async () => undefined,
    getPathForFile: (file: File & { path?: string }) => file.path ?? file.name,
    refreshPlan: async (sessionId) => callbacks.plan?.({ recordType: "plan_update", sessionId, createdAt: iso(0), planItems: sessions[0]!.planItems }),
    refreshDiagnostics: async () => undefined,
    refreshWorkers: async () => undefined,
    onStreamText: (callback) => subscribe("streamText", callback),
    onToolBatchStart: (callback) => subscribe("toolBatch", callback),
    onToolStart: (callback) => subscribe("toolStart", callback),
    onToolEnd: (callback) => subscribe("toolEnd", callback),
    onPlanUpdate: (callback) => subscribe("plan", callback),
    onApprovalRequested: (callback) => subscribe("approval", callback),
    onUserInputRequested: (callback) => subscribe("userInput", callback),
    onWorkerStatus: (callback) => subscribe("worker", callback),
    onWorkerArtifact: (callback) => subscribe("artifact", callback),
    onDiagnostics: (callback) => subscribe("diagnostics", callback),
    onSessionUpdated: (callback) => subscribe("session", callback),
  };
}

let fallbackRuntime: DesktopRuntime | null = null;

export function getRuntime(): DesktopRuntime {
  if (window.deepMixRuntime) return window.deepMixRuntime;
  fallbackRuntime ??= createMockRuntime();
  return fallbackRuntime;
}
