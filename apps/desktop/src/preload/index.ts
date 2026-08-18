import { contextBridge, ipcRenderer, webUtils } from "electron";
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
  DesktopUserInputResponseInput,
  DesktopModelProfileSaveInput,
  DesktopSettingsPatch,
  SessionMutationInput,
  WorkerStatusView,
} from "@shared/ipc";

function subscribe<T>(channel: string, callback: (value: T) => void) {
  const handler = (_event: unknown, value: T) => callback(value);
  ipcRenderer.on(channel, handler);
  return () => ipcRenderer.off(channel, handler);
}

const runtimeApi = {
  createSession: (prompt: string, workspaceRoot?: string) => ipcRenderer.invoke("deep-mix:createSession", prompt, workspaceRoot),
  resumeSession: (sessionId?: string, workspaceRoots?: string[]) => ipcRenderer.invoke("deep-mix:resumeSession", sessionId, workspaceRoots),
  listSessions: (workspaceRoots?: string[]) => ipcRenderer.invoke("deep-mix:listSessions", workspaceRoots),
  loadSession: (sessionId: string) => ipcRenderer.invoke("deep-mix:loadSession", sessionId),
  sendPrompt: (input: {
    sessionId?: string;
    workspaceRoot?: string;
    prompt: string;
    attachments?: AttachmentDescriptor[];
  }) => ipcRenderer.invoke("deep-mix:sendPrompt", {
    ...input,
    attachments: input.attachments?.map(({ previewUrl: _previewUrl, ...attachment }) => attachment),
  }),
  interruptSession: (sessionId: string) => ipcRenderer.invoke("deep-mix:interruptSession", sessionId),
  listManagedProcesses: (sessionId: string) => ipcRenderer.invoke("deep-mix:listManagedProcesses", sessionId),
  stopManagedProcess: (sessionId: string, processSessionId: string) =>
    ipcRenderer.invoke("deep-mix:stopManagedProcess", sessionId, processSessionId),
  undoSession: (sessionId: string) => ipcRenderer.invoke("deep-mix:undoSession", sessionId),
  exportSession: (sessionId: string) => ipcRenderer.invoke("deep-mix:exportSession", sessionId),
  compactSession: (sessionId: string) => ipcRenderer.invoke("deep-mix:compactSession", sessionId),
  mutateSession: (input: SessionMutationInput) => ipcRenderer.invoke("deep-mix:mutateSession", input),
  deleteSession: (sessionId: string) => ipcRenderer.invoke("deep-mix:deleteSession", sessionId),
  resolveApproval: (input: {
    sessionId: string;
    approvalId: string;
    toolName: string;
    requestKey: string;
    persistence: "allow_once" | "allow_session" | "deny";
    reason: string;
  }) => ipcRenderer.invoke("deep-mix:resolveApproval", input),
  respondToUserInput: (input: DesktopUserInputResponseInput) =>
    ipcRenderer.invoke("deep-mix:respondToUserInput", input),
  getSettings: (workspaceRoot?: string) => ipcRenderer.invoke("deep-mix:getSettings", workspaceRoot),
  updateSettings: (patch: DesktopSettingsPatch, workspaceRoot?: string) => ipcRenderer.invoke("deep-mix:updateSettings", patch, workspaceRoot),
  saveModelProfile: (input: DesktopModelProfileSaveInput, workspaceRoot?: string) => ipcRenderer.invoke("deep-mix:saveModelProfile", input, workspaceRoot),
  probeModel: (profileId: string, workspaceRoot?: string) => ipcRenderer.invoke("deep-mix:probeModel", profileId, workspaceRoot),
  chooseAttachments: (workspaceRoot?: string) => ipcRenderer.invoke("deep-mix:chooseAttachments", workspaceRoot),
  describeDroppedFiles: (paths: string[], workspaceRoot?: string) =>
    ipcRenderer.invoke("deep-mix:describeDroppedFiles", paths, workspaceRoot),
  readClipboardImage: (workspaceRoot?: string) => ipcRenderer.invoke("deep-mix:readClipboardImage", workspaceRoot),
  chooseWorkspace: () => ipcRenderer.invoke("deep-mix:chooseWorkspace"),
  pickWorkspace: () => ipcRenderer.invoke("deep-mix:pickWorkspace"),
  activateWorkspace: (workspaceRoot: string) => ipcRenderer.invoke("deep-mix:activateWorkspace", workspaceRoot),
  revealPath: (targetPath: string) => ipcRenderer.invoke("deep-mix:revealPath", targetPath),
  copyText: (text: string) => ipcRenderer.invoke("deep-mix:copyText", text),
  setZoom: (action: "in" | "out" | "reset") => ipcRenderer.invoke("deep-mix:setZoom", action),
  setTheme: (theme: "light" | "dark") => ipcRenderer.invoke("deep-mix:setTheme", theme),
  getPathForFile: (file: File) => webUtils.getPathForFile(file),
  refreshPlan: (sessionId: string) => ipcRenderer.invoke("deep-mix:refreshPlan", sessionId),
  refreshDiagnostics: (sessionId: string) => ipcRenderer.invoke("deep-mix:refreshDiagnostics", sessionId),
  refreshWorkers: (sessionId: string) => ipcRenderer.invoke("deep-mix:refreshWorkers", sessionId),

  onStreamText: (callback: (event: { sessionId: string; turnId: string; chunk: string }) => void) =>
    subscribe("deep-mix:streamText", callback),
  onToolBatchStart: (callback: (event: ToolBatchStart & { sessionId: string }) => void) =>
    subscribe("deep-mix:toolBatchStart", callback),
  onToolStart: (callback: (event: { sessionId: string; turnId: string; toolCall: ToolCall }) => void) =>
    subscribe("deep-mix:toolStart", callback),
  onToolEnd: (callback: (event: { sessionId: string; turnId: string; result: ToolResult }) => void) =>
    subscribe("deep-mix:toolEnd", callback),
  onPlanUpdate: (callback: (event: PlanUpdateRecord) => void) => subscribe("deep-mix:planUpdate", callback),
  onApprovalRequested: (callback: (event: ApprovalRecord) => void) =>
    subscribe("deep-mix:approvalRequested", callback),
  onUserInputRequested: (callback: (event: UserInputRequestRecord) => void) =>
    subscribe("deep-mix:userInputRequested", callback),
  onWorkerStatus: (callback: (event: WorkerStatusView) => void) => subscribe("deep-mix:workerStatus", callback),
  onWorkerArtifact: (callback: (event: WorkerArtifactRecord) => void) =>
    subscribe("deep-mix:workerArtifact", callback),
  onDiagnostics: (callback: (event: DiagnosticReportRecord) => void) =>
    subscribe("deep-mix:diagnostics", callback),
  onSessionUpdated: (callback: (event: SessionRecord) => void) =>
    subscribe("deep-mix:sessionUpdated", callback),
};

contextBridge.exposeInMainWorld("deepMixRuntime", runtimeApi);
