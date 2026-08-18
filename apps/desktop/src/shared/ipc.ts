import type {
  ApprovalRecord,
  DiagnosticReportRecord,
  MessageRecord,
  ModelAssignmentSnapshot,
  ModelCapabilityManifest,
  ModelSlotId,
  PermissionMode,
  PlanUpdateRecord,
  ReasoningEffort,
  ReplyStyle,
  SessionRecord,
  ThinkingModeType,
  ToolBatchStart,
  ToolCall,
  ToolProcessSession,
  ToolResult,
  TurnRecord,
  UserInputAnswer,
  UserInputRequestRecord,
  WorkerArtifactRecord,
  WorkerSessionStatus,
} from "@deep-mix/shared-schema";
import type { DesktopShortcutBindings, DesktopShortcutId } from "./shortcut-config";

export interface DesktopProfileStatus {
  exists: boolean;
  hasKey: boolean;
  provider?: string;
  model?: string;
  protocol?: string;
  adapterId?: string;
  baseUrl?: string;
  endpointPath?: string;
  capabilities?: ModelCapabilityManifest;
  allowedSlots?: ModelSlotId[];
}

export interface DesktopModelReferenceStatus {
  profileId: string;
  displayName: string;
  model?: string;
  status: DesktopProfileStatus;
}

export interface DesktopModelSlotStatus {
  slot: ModelSlotId;
  primary: DesktopModelReferenceStatus;
  fallbacks: DesktopModelReferenceStatus[];
  fallbackEnabled: boolean;
  requiredCapabilities: string[];
  activationError?: string;
}

export interface DesktopModelCenterSettings {
  preset: "classic" | "custom";
  revision: number;
  profileRevision: number;
  candidates: DesktopModelReferenceStatus[];
  slots: Record<ModelSlotId, DesktopModelSlotStatus>;
}

export interface DesktopModelProfileSaveInput {
  slot: ModelSlotId;
  expectedSettingsRevision: number;
  expectedProfileRevision: number;
  profileId: string;
  displayName: string;
  provider: string;
  protocol: string;
  adapterId: string;
  apiKey?: string;
  baseUrl: string;
  endpointPath: string;
  model: string;
  capabilities: ModelCapabilityManifest;
}

export interface DesktopModelProbeResult {
  profileId: string;
  ok: boolean;
  skipped?: boolean;
  adapterId?: string;
  latencyMs?: number;
  redactedError?: string;
}

export interface DesktopExtension {
  id: string;
  name: string;
  description: string;
  kind: "skill" | "workflow" | "mcp";
  enabled: boolean;
  state: "ready" | "disabled" | "error";
  source?: string;
  toolCount?: number;
}

export interface DesktopCapability {
  name: string;
  available: boolean;
  detail: string;
}

export interface AttachmentDescriptor {
  id: string;
  name: string;
  path: string;
  ref?: `file://${string}`;
  workspaceRoot?: string;
  size: number;
  mimeType: string;
  kind: "image" | "document" | "code" | "other";
  previewUrl?: string;
}

export interface DesktopSettings {
  workspaceRoot: string;
  workspaceName: string;
  gitBranch?: string;
  permissionMode: PermissionMode;
  reasoningEffort: Exclude<ReasoningEffort, "not_applicable">;
  thinkingMode: ThinkingModeType;
  replyStyle: ReplyStyle;
  shortcuts: DesktopShortcutBindings;
  profiles: {
    deepseek_governor: DesktopProfileStatus;
    glm_coding_worker: DesktopProfileStatus;
    kimi_vision: DesktopProfileStatus;
  };
  models: DesktopModelCenterSettings;
  extensions: DesktopExtension[];
  capabilities: DesktopCapability[];
}

export interface DesktopSettingsPatch {
  permissionMode?: PermissionMode;
  reasoningEffort?: Exclude<ReasoningEffort, "not_applicable">;
  thinkingMode?: ThinkingModeType;
  replyStyle?: ReplyStyle;
  shortcuts?: Partial<Record<DesktopShortcutId, string | null>>;
  enabledSkills?: Record<string, boolean>;
  models?: {
    expectedRevision: number;
    restoreClassic?: boolean;
    slot?: ModelSlotId;
    primaryProfileId?: string;
    primaryModel?: string;
    fallbackProfileIds?: string[];
  };
}

export interface SessionSummary extends SessionRecord {}

export interface SessionDetail {
  session: SessionRecord;
  messages: MessageRecord[];
  turns: TurnRecord[];
  approvals: ApprovalRecord[];
  pendingUserInput?: UserInputRequestRecord;
}

export interface DesktopUserInputResponseInput {
  sessionId: string;
  requestId: string;
  answers?: UserInputAnswer[];
  cancel?: boolean;
  cancelReason?: string;
}

export interface SessionMutationInput {
  sessionId: string;
  title?: string;
  pinned?: boolean;
  archived?: boolean;
  unread?: boolean;
}

export interface CompactSessionResult {
  compacted: boolean;
  summaryId?: string;
  messageCountCompacted: number;
  beforeTokens: number;
  afterTokens: number;
  tokensSaved: number;
}

export interface DesktopStopManagedProcessResult {
  status: "completed" | "approval_required";
  result?: ToolResult;
  approvalId?: string;
}

export interface WorkerStatusView {
  workerSessionId: string;
  parentSessionId?: string;
  workerType: "coding" | "vision" | "review" | "research";
  status: WorkerSessionStatus;
  objective: string;
  updatedAt: string;
  modelAssignment?: ModelAssignmentSnapshot;
}

export interface DesktopRuntime {
  createSession(prompt: string, workspaceRoot?: string): Promise<SessionSummary>;
  resumeSession(sessionId?: string, workspaceRoots?: string[]): Promise<SessionSummary | null>;
  listSessions(workspaceRoots?: string[]): Promise<SessionSummary[]>;
  loadSession(sessionId: string): Promise<SessionDetail>;
  sendPrompt(input: {
    sessionId?: string;
    workspaceRoot?: string;
    prompt: string;
    attachments?: AttachmentDescriptor[];
  }): Promise<{ sessionId?: string }>;
  interruptSession(sessionId: string): Promise<void>;
  listManagedProcesses(sessionId: string): Promise<ToolProcessSession[]>;
  stopManagedProcess(sessionId: string, processSessionId: string): Promise<DesktopStopManagedProcessResult>;
  undoSession(sessionId: string): Promise<{ success: boolean; output: string }>;
  exportSession(sessionId: string): Promise<{ cancelled: boolean; outputPath?: string }>;
  compactSession(sessionId: string): Promise<CompactSessionResult>;
  mutateSession(input: SessionMutationInput): Promise<SessionSummary>;
  deleteSession(sessionId: string): Promise<boolean>;

  resolveApproval(input: {
    sessionId: string;
    approvalId: string;
    toolName: string;
    requestKey: string;
    persistence: "allow_once" | "allow_session" | "deny";
    reason: string;
  }): Promise<void>;
  respondToUserInput(input: DesktopUserInputResponseInput): Promise<void>;

  getSettings(workspaceRoot?: string): Promise<DesktopSettings>;
  updateSettings(patch: DesktopSettingsPatch, workspaceRoot?: string): Promise<DesktopSettings>;
  saveModelProfile(input: DesktopModelProfileSaveInput, workspaceRoot?: string): Promise<DesktopSettings>;
  probeModel(profileId: string, workspaceRoot?: string): Promise<DesktopModelProbeResult>;
  chooseAttachments(workspaceRoot?: string): Promise<AttachmentDescriptor[]>;
  describeDroppedFiles(paths: string[], workspaceRoot?: string): Promise<AttachmentDescriptor[]>;
  readClipboardImage(workspaceRoot?: string): Promise<AttachmentDescriptor | null>;
  chooseWorkspace(): Promise<DesktopSettings | null>;
  pickWorkspace(): Promise<string | null>;
  activateWorkspace(workspaceRoot: string): Promise<DesktopSettings>;
  revealPath(targetPath: string): Promise<void>;
  copyText(text: string): Promise<boolean>;
  setZoom(action: "in" | "out" | "reset"): Promise<number>;
  setTheme(theme: "light" | "dark"): Promise<void>;
  getPathForFile(file: File): string;

  refreshPlan(sessionId: string): Promise<void>;
  refreshDiagnostics(sessionId: string): Promise<void>;
  refreshWorkers(sessionId: string): Promise<void>;

  onStreamText(callback: (event: { sessionId: string; turnId: string; chunk: string }) => void): () => void;
  onToolBatchStart(callback: (event: ToolBatchStart & { sessionId: string }) => void): () => void;
  onToolStart(callback: (event: { sessionId: string; turnId: string; toolCall: ToolCall }) => void): () => void;
  onToolEnd(callback: (event: { sessionId: string; turnId: string; result: ToolResult }) => void): () => void;
  onPlanUpdate(callback: (event: PlanUpdateRecord) => void): () => void;
  onApprovalRequested(callback: (event: ApprovalRecord) => void): () => void;
  onUserInputRequested(callback: (event: UserInputRequestRecord) => void): () => void;
  onWorkerStatus(callback: (event: WorkerStatusView) => void): () => void;
  onWorkerArtifact(callback: (event: WorkerArtifactRecord) => void): () => void;
  onDiagnostics(callback: (event: DiagnosticReportRecord) => void): () => void;
  onSessionUpdated(callback: (event: SessionRecord) => void): () => void;
}

declare global {
  interface Window {
    deepMixRuntime?: DesktopRuntime;
  }
}

export type IpcChannel =
  | "deep-mix:createSession"
  | "deep-mix:resumeSession"
  | "deep-mix:listSessions"
  | "deep-mix:loadSession"
  | "deep-mix:sendPrompt"
  | "deep-mix:interruptSession"
  | "deep-mix:listManagedProcesses"
  | "deep-mix:stopManagedProcess"
  | "deep-mix:undoSession"
  | "deep-mix:exportSession"
  | "deep-mix:compactSession"
  | "deep-mix:mutateSession"
  | "deep-mix:deleteSession"
  | "deep-mix:resolveApproval"
  | "deep-mix:respondToUserInput"
  | "deep-mix:getSettings"
  | "deep-mix:updateSettings"
  | "deep-mix:saveModelProfile"
  | "deep-mix:probeModel"
  | "deep-mix:chooseAttachments"
  | "deep-mix:describeDroppedFiles"
  | "deep-mix:readClipboardImage"
  | "deep-mix:chooseWorkspace"
  | "deep-mix:pickWorkspace"
  | "deep-mix:activateWorkspace"
  | "deep-mix:revealPath"
  | "deep-mix:copyText"
  | "deep-mix:setZoom"
  | "deep-mix:setTheme"
  | "deep-mix:refreshPlan"
  | "deep-mix:refreshDiagnostics"
  | "deep-mix:refreshWorkers"
  | "deep-mix:streamText"
  | "deep-mix:toolBatchStart"
  | "deep-mix:toolStart"
  | "deep-mix:toolEnd"
  | "deep-mix:planUpdate"
  | "deep-mix:approvalRequested"
  | "deep-mix:userInputRequested"
  | "deep-mix:workerStatus"
  | "deep-mix:workerArtifact"
  | "deep-mix:diagnostics"
  | "deep-mix:sessionUpdated";

export const IPC_CHANNELS: IpcChannel[] = [
  "deep-mix:createSession",
  "deep-mix:resumeSession",
  "deep-mix:listSessions",
  "deep-mix:loadSession",
  "deep-mix:sendPrompt",
  "deep-mix:interruptSession",
  "deep-mix:listManagedProcesses",
  "deep-mix:stopManagedProcess",
  "deep-mix:undoSession",
  "deep-mix:exportSession",
  "deep-mix:compactSession",
  "deep-mix:mutateSession",
  "deep-mix:deleteSession",
  "deep-mix:resolveApproval",
  "deep-mix:respondToUserInput",
  "deep-mix:getSettings",
  "deep-mix:updateSettings",
  "deep-mix:saveModelProfile",
  "deep-mix:probeModel",
  "deep-mix:chooseAttachments",
  "deep-mix:describeDroppedFiles",
  "deep-mix:readClipboardImage",
  "deep-mix:chooseWorkspace",
  "deep-mix:pickWorkspace",
  "deep-mix:activateWorkspace",
  "deep-mix:revealPath",
  "deep-mix:copyText",
  "deep-mix:setZoom",
  "deep-mix:setTheme",
  "deep-mix:refreshPlan",
  "deep-mix:refreshDiagnostics",
  "deep-mix:refreshWorkers",
  "deep-mix:streamText",
  "deep-mix:toolBatchStart",
  "deep-mix:toolStart",
  "deep-mix:toolEnd",
  "deep-mix:planUpdate",
  "deep-mix:approvalRequested",
  "deep-mix:userInputRequested",
  "deep-mix:workerStatus",
  "deep-mix:workerArtifact",
  "deep-mix:diagnostics",
  "deep-mix:sessionUpdated",
];
