import { app, BrowserWindow, clipboard, dialog, ipcMain, shell } from "electron";
import { randomUUID } from "node:crypto";
import { existsSync, promises as fs, readFileSync } from "node:fs";
import path from "node:path";
import {
  createFallbackSessionTitle,
  GovernorRuntime,
  PermissionRequiredError,
  selectFirstTurnTitleMessages,
} from "@deep-mix/core-governor";
import { selectPendingApprovals, SessionStore } from "@deep-mix/persistence";
import {
  CLASSIC_MODEL_SETTINGS,
  createDeepMixSettingsMigrationPlan,
  isPermissionMode,
  loadDeepMixSettingsSync,
  resolveDeepMixSettingsPaths,
  resolveEffectiveModelSettings,
  saveDeepMixSettings,
} from "../../../../packages/settings/src/index.js";
import {
  createDefaultModelAdapterRegistry,
} from "../../../../packages/model-adapters/src/index.js";
import { ProfileService } from "../../../../packages/model-adapters/src/profile-service.js";
import {
  resolveLegacyDesktopAttachmentReference,
  resolveWorkspaceStateDirectory,
} from "../../../../packages/state-location/src/index.js";
import type {
  ApprovalRecord,
  DeepMixSettings,
  DiagnosticReportRecord,
  MessageRecord,
  ModelCapabilityManifest,
  ModelSlotBinding,
  ModelSlotId,
  PermissionMode,
  PlanUpdateRecord,
  ReasoningEffort,
  ReplyStyle,
  RunCallbacks,
  RuntimeEvent,
  SessionRecord,
  ThinkingModeType,
  ToolCall,
  ToolResult,
  TurnRecord,
  UserInputRequestRecord,
  WorkerArtifactRecord,
  WorkerSessionLinkRecord,
  WorkerSessionRecord,
} from "@deep-mix/shared-schema";
import type {
  AttachmentDescriptor,
  DesktopExtension,
  DesktopModelCenterSettings,
  DesktopModelProfileSaveInput,
  DesktopModelProbeResult,
  DesktopSettings,
  DesktopSettingsPatch,
  DesktopUserInputResponseInput,
  SessionMutationInput,
  WorkerStatusView,
} from "@shared/ipc";
import { resolveDesktopShortcuts } from "@shared/shortcut-config";
import {
  createDesktopMessageMetadata,
  readDesktopMessagePresentation,
} from "@shared/desktop-message-attachments";
import {
  importDocumentAttachment,
  isSupportedDocumentAttachmentPath,
  mimeForDocumentAttachmentPath,
} from "./document-attachment-import.js";
import { createElectronToolNetworkService } from "./network-service.js";
import {
  PHASE20_PRODUCTION_PROBE_MARKER,
  runPhase20ProductionProbe,
} from "./phase20-production-probe.js";
import type { ToolNetworkService } from "../../../../packages/tool-runtime/src/network/index.js";

const isDev = process.env.NODE_ENV === "development" || !app.isPackaged;

let mainWindow: BrowserWindow | null = null;
type WindowTheme = "light" | "dark";

const windowThemes: Record<WindowTheme, { background: string; symbols: string }> = {
  light: { background: "#f4f8ff", symbols: "#52637d" },
  dark: { background: "#181c24", symbols: "#aab9cf" },
};

function applyWindowTheme(theme: WindowTheme): void {
  if (!mainWindow || mainWindow.isDestroyed()) return;
  const palette = windowThemes[theme];
  mainWindow.setBackgroundColor(palette.background);
  mainWindow.setTitleBarOverlay({ color: "#00000000", symbolColor: palette.symbols, height: 44 });
}

const launchWorkspaceRoot = findWorkspaceRoot(process.cwd());
process.env.DEEP_MIX_API_KEY_LIBRARY_ROOT ||= launchWorkspaceRoot;
const defaultWorkspaceRoot = launchWorkspaceRoot;
let activeDesktopWorkspaceRoot = defaultWorkspaceRoot;

interface WorkspaceRuntimeContext {
  workspaceRoot: string;
  runtime: GovernorRuntime;
  sessionStore: SessionStore;
  permissionMode: PermissionMode;
  reasoningEffort: Exclude<ReasoningEffort, "not_applicable">;
  thinkingMode: ThinkingModeType;
  replyStyle: ReplyStyle;
  shortcuts: DesktopSettings["shortcuts"];
}

const knownWorkspaceRoots = new Set<string>([defaultWorkspaceRoot]);
const workspaceStores = new Map<string, SessionStore>();
const workspaceRuntimePromises = new Map<string, Promise<WorkspaceRuntimeContext>>();
const sessionWorkspaceRoots = new Map<string, string>();
const desktopSessionTitleJobs = new Map<string, Promise<void>>();
const DESKTOP_SESSION_TITLE_VERSION = 2;
const pendingManagedProcessStops = new Map<string, { sessionId: string; processSessionId: string }>();
let desktopNetworkService: ToolNetworkService | undefined;

async function getDesktopNetworkService(): Promise<ToolNetworkService> {
  desktopNetworkService ??= await createElectronToolNetworkService();
  return desktopNetworkService;
}

function findWorkspaceRoot(start: string): string {
  let current = path.resolve(start);
  while (true) {
    const packagePath = path.join(current, "package.json");
    if (existsSync(packagePath)) {
      try {
        const packageJson = JSON.parse(readFileSync(packagePath, "utf8")) as { name?: string; workspaces?: unknown };
        if (packageJson.name === "deep-mix" || Array.isArray(packageJson.workspaces)) {
          return current;
        }
      } catch {
        // Keep walking upward when this package file is not the workspace root.
      }
    }
    const parent = path.dirname(current);
    if (parent === current) return path.resolve(start);
    current = parent;
  }
}

function now(): string {
  return new Date().toISOString();
}

function send<T>(channel: string, payload: T): void {
  if (mainWindow && !mainWindow.isDestroyed()) {
    mainWindow.webContents.send(channel, payload);
  }
}

function normalizeWorkspaceRoot(input: string): string {
  return path.resolve(input);
}

function selectDesktopWorkspaceRoot(input: string): string {
  activeDesktopWorkspaceRoot = normalizeWorkspaceRoot(input);
  return activeDesktopWorkspaceRoot;
}

function getWorkspaceStore(input: string): SessionStore {
  const root = normalizeWorkspaceRoot(input);
  knownWorkspaceRoots.add(root);
  let store = workspaceStores.get(root);
  if (!store) {
    store = new SessionStore(root);
    workspaceStores.set(root, store);
  }
  return store;
}

function asReasoningEffort(value: unknown): Exclude<ReasoningEffort, "not_applicable"> {
  return value === "low" || value === "high" ? value : "medium";
}

function asThinkingMode(value: unknown): ThinkingModeType {
  return value === "disabled" || value === "enabled" ? value : "adaptive";
}

function asReplyStyle(value: unknown): ReplyStyle {
  return value === "friendly" ? "friendly" : "pragmatic";
}

function resolveConfiguredValues(targetWorkspaceRoot: string): {
  permissionMode: PermissionMode;
  reasoningEffort: Exclude<ReasoningEffort, "not_applicable">;
  thinkingMode: ThinkingModeType;
  replyStyle: ReplyStyle;
  shortcuts: DesktopSettings["shortcuts"];
} {
  const loaded = loadDeepMixSettingsSync(targetWorkspaceRoot, { collectErrors: false }).settings;
  return {
    permissionMode: isPermissionMode(loaded.defaults?.permissionMode)
    ? loaded.defaults.permissionMode
    : "auto",
    reasoningEffort: asReasoningEffort(loaded.governor?.reasoningEffort),
    thinkingMode: asThinkingMode(loaded.governor?.thinkingMode),
    replyStyle: asReplyStyle(loaded.governor?.replyStyle),
    shortcuts: resolveDesktopShortcuts(loaded.desktop?.shortcuts),
  };
}

function toWorkerStatusView(record: WorkerSessionRecord): WorkerStatusView {
  return {
    workerSessionId: record.workerSessionId,
    parentSessionId: record.parentSessionId,
    workerType: record.workerType,
    status: record.status,
    objective: record.objective,
    updatedAt: record.updatedAt,
    modelAssignment: record.modelAssignment,
  };
}

function registerRuntimeHooks(activeRuntime: GovernorRuntime, activeStore: SessionStore): void {
  activeRuntime.registerHook("session_start", (event: RuntimeEvent) => {
    if (!event.sessionId) return;
    send("deep-mix:sessionUpdated", {
      sessionId: event.sessionId,
      status: "running",
      updatedAt: now(),
    });
  });

  activeRuntime.registerHook("worker_completed", async (event: RuntimeEvent) => {
    if (!event.workerSessionId) return;
    const record = await activeStore.loadWorkerSession(event.workerSessionId);
    if (!record) return;
    send("deep-mix:workerStatus", toWorkerStatusView(record));
    const artifact = await activeStore.loadLatestWorkerArtifact(event.workerSessionId);
    if (artifact) send("deep-mix:workerArtifact", artifact);
  });

  activeRuntime.registerHook("task_failed", (event: RuntimeEvent) => {
    if (!event.sessionId) return;
    send("deep-mix:sessionUpdated", {
      sessionId: event.sessionId,
      status: "failed",
      updatedAt: now(),
      error: event.payload?.error,
    });
  });
}

async function createWorkspaceRuntime(nextWorkspaceRoot: string): Promise<WorkspaceRuntimeContext> {
  const resolvedWorkspaceRoot = path.resolve(nextWorkspaceRoot);
  const nextConfiguredValues = resolveConfiguredValues(resolvedWorkspaceRoot);
  const nextSessionStore = getWorkspaceStore(resolvedWorkspaceRoot);
  await nextSessionStore.ensureInitialized();
  const nextRuntime = new GovernorRuntime({
    workspaceRoot: resolvedWorkspaceRoot,
    permissionMode: nextConfiguredValues.permissionMode,
    networkService: await getDesktopNetworkService(),
  });
  await nextRuntime.initialize();
  registerRuntimeHooks(nextRuntime, nextSessionStore);
  return {
    workspaceRoot: resolvedWorkspaceRoot,
    runtime: nextRuntime,
    sessionStore: nextSessionStore,
    ...nextConfiguredValues,
  };
}

async function getWorkspaceRuntime(input = defaultWorkspaceRoot): Promise<WorkspaceRuntimeContext> {
  const root = normalizeWorkspaceRoot(input);
  knownWorkspaceRoots.add(root);
  let pending = workspaceRuntimePromises.get(root);
  if (!pending) {
    pending = createWorkspaceRuntime(root).catch((error) => {
      workspaceRuntimePromises.delete(root);
      throw error;
    });
    workspaceRuntimePromises.set(root, pending);
  }
  return pending;
}

async function disposeWorkspaceRuntime(input: string): Promise<void> {
  const root = normalizeWorkspaceRoot(input);
  const pending = workspaceRuntimePromises.get(root);
  if (!pending) return;
  workspaceRuntimePromises.delete(root);
  let context: WorkspaceRuntimeContext;
  try {
    context = await pending;
  } catch {
    return;
  }
  await context.runtime.dispose();
}

async function disposeAllWorkspaceRuntimes(): Promise<void> {
  const roots = [...workspaceRuntimePromises.keys()];
  const results = await Promise.allSettled(roots.map((root) => disposeWorkspaceRuntime(root)));
  pendingManagedProcessStops.clear();
  await desktopNetworkService?.dispose();
  desktopNetworkService = undefined;
  const rejected = results.find((result): result is PromiseRejectedResult => result.status === "rejected");
  if (rejected) throw rejected.reason;
}

async function findSessionWorkspaceRoot(sessionId: string): Promise<string | undefined> {
  const cached = sessionWorkspaceRoots.get(sessionId);
  if (cached) return cached;
  for (const root of knownWorkspaceRoots) {
    const session = await getWorkspaceStore(root).loadSession(sessionId);
    if (session) {
      sessionWorkspaceRoots.set(sessionId, root);
      return root;
    }
  }
  return undefined;
}

async function getSessionStoreFor(sessionId: string): Promise<SessionStore> {
  const root = await findSessionWorkspaceRoot(sessionId);
  if (!root) throw new Error(`Unknown session: ${sessionId}`);
  return getWorkspaceStore(root);
}

async function getSessionRuntimeFor(sessionId: string): Promise<WorkspaceRuntimeContext> {
  const root = await findSessionWorkspaceRoot(sessionId);
  if (!root) throw new Error(`Unknown session: ${sessionId}`);
  return getWorkspaceRuntime(root);
}

async function createWindow(): Promise<void> {
  mainWindow = new BrowserWindow({
    show: false,
    width: 1500,
    height: 940,
    minWidth: 980,
    minHeight: 680,
    backgroundColor: windowThemes.light.background,
    icon: path.join(__dirname, `../../resources/deep-mix-app-icon.${process.platform === "win32" ? "ico" : "png"}`),
    titleBarStyle: "hidden",
    titleBarOverlay: {
      color: "#00000000",
      symbolColor: windowThemes.light.symbols,
      height: 44,
    },
    webPreferences: {
      preload: path.join(__dirname, "../preload/index.js"),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
    },
  });

  mainWindow.once("ready-to-show", () => {
    void mainWindow?.webContents.executeJavaScript('localStorage.getItem("deep-mix-theme") || "light"')
      .then((theme: unknown) => applyWindowTheme(theme === "dark" ? "dark" : "light"))
      .catch(() => applyWindowTheme("light"))
      .finally(() => mainWindow?.show());
  });

  const rendererUrl = process.env.ELECTRON_RENDERER_URL;
  if (isDev && rendererUrl) {
    await mainWindow.loadURL(rendererUrl);
  } else if (isDev) {
    await mainWindow.loadURL("http://localhost:5173");
  } else {
    await mainWindow.loadFile(path.join(__dirname, "../renderer/index.html"));
  }
}

async function readProfileStatus(workspaceRoot: string): Promise<DesktopSettings["profiles"]> {
  return new ProfileService(workspaceRoot).inspect([
    "deepseek_governor",
    "glm_coding_worker",
    "kimi_vision",
  ] as const);
}

const CLASSIC_PROFILE_DISPLAY_NAMES: Readonly<Record<string, string>> = {
  deepseek_governor: "经典总线接入",
  glm_coding_worker: "经典编程接入",
  kimi_vision: "经典视觉接入",
};

async function readModelCenterSettings(workspaceRoot: string): Promise<DesktopModelCenterSettings> {
  const service = new ProfileService(workspaceRoot);
  const publicProfiles = service.listPublicProfiles();
  const profiles = new Map(publicProfiles.map((profile) => [profile.profileId, profile]));
  const toReference = (profileId: string, model?: string) => {
    const profile = profiles.get(profileId);
    return {
      profileId,
      displayName: profile?.displayName ?? CLASSIC_PROFILE_DISPLAY_NAMES[profileId] ?? profile?.model ?? profileId,
      ...(model ? { model } : {}),
      status: profile ? {
        exists: true,
        hasKey: profile.hasCredential,
        provider: profile.provider,
        model: profile.model,
        protocol: profile.protocol,
        adapterId: profile.adapterId,
        baseUrl: profile.baseUrl,
        endpointPath: profile.endpointPath,
        capabilities: profile.capabilities,
        allowedSlots: profile.allowedSlots,
      } : { exists: false, hasKey: false },
    };
  };
  const loaded = loadDeepMixSettingsSync(workspaceRoot, { collectErrors: true });
  const effective = resolveEffectiveModelSettings(loaded.settings);
  const slotStatus = (slot: ModelSlotId): DesktopModelCenterSettings["slots"][ModelSlotId] => {
    const binding = effective.slots[slot];
    const requiredCapabilities = Object.entries(binding.requirements ?? {})
      .filter(([, required]) => required === true || typeof required === "number")
      .map(([name]) => name);
    let activationError: string | undefined;
    try {
      const gate = service.gate(slot, binding.primary.profile, binding.requirements);
      if (!gate.ok) activationError = `Missing capability: ${gate.missing.join(", ")}`;
      else if (!gate.profile.hasCredential) activationError = "Credential unavailable";
      else if (!gate.profile.adapterId) activationError = "Adapter unavailable";
    } catch (error) {
      activationError = (error as Error).message;
    }
    return {
      slot,
      primary: toReference(binding.primary.profile, binding.primary.model),
      fallbacks: binding.fallbacks.map((entry) => toReference(entry.profile, entry.model)),
      fallbackEnabled: binding.fallbackPolicy?.enabled ?? false,
      requiredCapabilities,
      ...(activationError ? { activationError } : {}),
    };
  };
  return {
    preset: effective.preset,
    revision: loaded.settings.version === 2 ? loaded.settings.revision ?? 0 : 0,
    profileRevision: service.getLocalLibraryRevision(),
    candidates: publicProfiles.map((profile) => toReference(profile.profileId)),
    slots: {
      governor: slotStatus("governor"),
      coding: slotStatus("coding"),
      vision: slotStatus("vision"),
    },
  };
}

async function readGitBranch(workspaceRoot: string): Promise<string | undefined> {
  try {
    const head = (await fs.readFile(path.join(workspaceRoot, ".git", "HEAD"), "utf8")).trim();
    return head.startsWith("ref: ") ? head.slice(head.lastIndexOf("/") + 1) : head.slice(0, 8);
  } catch {
    return undefined;
  }
}

async function listExtensions(rt: GovernorRuntime): Promise<DesktopExtension[]> {
  const [skills, workflows, mcpServers] = await Promise.all([
    rt.listSkills(),
    rt.listWorkflows(),
    rt.listMcpServerStatuses(),
  ]);
  return [
    ...skills.map((skill) => ({
      id: `skill:${skill.name}`,
      name: skill.name,
      description: skill.description,
      kind: "skill" as const,
      enabled: skill.enabled,
      state: skill.enabled ? ("ready" as const) : ("disabled" as const),
      source: skill.sourceScope,
    })),
    ...workflows.map((workflow) => ({
      id: `workflow:${workflow.name}`,
      name: workflow.name,
      description: workflow.description,
      kind: "workflow" as const,
      enabled: true,
      state: "ready" as const,
      source: workflow.sourceScope,
    })),
    ...mcpServers.map((server) => ({
      id: `mcp:${server.name}`,
      name: server.name,
      description: server.error ?? `${server.type} MCP · ${server.toolCount} tools`,
      kind: "mcp" as const,
      enabled: server.enabled,
      state: server.state,
      source: server.type,
      toolCount: server.toolCount,
    })),
  ];
}

async function buildDesktopSettings(context: WorkspaceRuntimeContext): Promise<DesktopSettings> {
  const { workspaceRoot, runtime: activeRuntime } = context;
  const [profiles, models, extensions, capabilities, gitBranch] = await Promise.all([
    readProfileStatus(workspaceRoot),
    readModelCenterSettings(workspaceRoot),
    listExtensions(activeRuntime),
    activeRuntime.getRuntimeCapabilities(),
    readGitBranch(workspaceRoot),
  ]);
  return {
    workspaceRoot,
    workspaceName: path.basename(workspaceRoot),
    gitBranch,
    permissionMode: context.permissionMode,
    reasoningEffort: context.reasoningEffort,
    thinkingMode: context.thinkingMode,
    replyStyle: context.replyStyle,
    shortcuts: context.shortcuts,
    profiles,
    models,
    extensions,
    capabilities: Object.entries(capabilities.capabilities).map(([name, capability]) => ({
      name,
      available: capability.available,
      detail: capability.available ? capability.version ?? "ready" : capability.message,
    })),
  };
}

function mimeForPath(filePath: string): string {
  const importedAttachmentMime = mimeForDocumentAttachmentPath(filePath);
  if (importedAttachmentMime) return importedAttachmentMime;
  const extension = path.extname(filePath).toLowerCase();
  const mimeMap: Record<string, string> = {
    ".png": "image/png",
    ".jpg": "image/jpeg",
    ".jpeg": "image/jpeg",
    ".gif": "image/gif",
    ".webp": "image/webp",
    ".bmp": "image/bmp",
    ".svg": "image/svg+xml",
    ".txt": "text/plain",
    ".md": "text/markdown",
    ".json": "application/json",
    ".ts": "text/typescript",
    ".tsx": "text/typescript",
    ".js": "text/javascript",
    ".jsx": "text/javascript",
    ".py": "text/x-python",
  };
  return mimeMap[extension] ?? "application/octet-stream";
}

function attachmentKind(filePath: string, mimeType: string): AttachmentDescriptor["kind"] {
  if (mimeType.startsWith("image/")) return "image";
  if ([".pdf", ".docx", ".xlsx", ".csv", ".tsv", ".pptx", ".ipynb", ".txt", ".md"]
    .includes(path.extname(filePath).toLowerCase())) return "document";
  if ([".ts", ".tsx", ".js", ".jsx", ".py", ".rs", ".go", ".java", ".c", ".cpp", ".json"].includes(path.extname(filePath).toLowerCase())) return "code";
  return "other";
}

async function describeFiles(
  paths: string[],
  workspaceRoot = activeDesktopWorkspaceRoot,
): Promise<AttachmentDescriptor[]> {
  const normalizedWorkspaceRoot = normalizeWorkspaceRoot(workspaceRoot);
  const entries: Array<AttachmentDescriptor | null> = await Promise.all(
    paths.map(async (filePath) => {
      const absolutePath = path.resolve(filePath);
      if (isSupportedDocumentAttachmentPath(absolutePath)) {
        const imported = await importDocumentAttachment({
          sourcePath: absolutePath,
          workspaceRoot: normalizedWorkspaceRoot,
        });
        const kind = attachmentKind(imported.name, imported.mimeType);
        const attachment: AttachmentDescriptor = {
          id: randomUUID(),
          name: imported.name,
          path: imported.relativePath,
          ref: imported.ref,
          workspaceRoot: normalizedWorkspaceRoot,
          size: imported.size,
          mimeType: imported.mimeType,
          kind,
        };
        if (kind === "image" && imported.size <= 8 * 1024 * 1024) {
          const importedPath = resolveLegacyDesktopAttachmentReference(normalizedWorkspaceRoot, imported.relativePath);
          if (!importedPath) throw new Error("Desktop attachment state reference is invalid.");
          const contents = await fs.readFile(importedPath);
          attachment.previewUrl = `data:${imported.mimeType};base64,${contents.toString("base64")}`;
        }
        return attachment;
      }
      const stat = await fs.stat(absolutePath);
      if (!stat.isFile()) return null;
      const mimeType = mimeForPath(absolutePath);
      const attachment: AttachmentDescriptor = {
        id: randomUUID(),
        name: path.basename(absolutePath),
        path: absolutePath,
        size: stat.size,
        mimeType,
        kind: attachmentKind(absolutePath, mimeType),
      };
      if (attachment.kind === "image" && stat.size <= 8 * 1024 * 1024) {
        const contents = await fs.readFile(absolutePath);
        attachment.previewUrl = `data:${mimeType};base64,${contents.toString("base64")}`;
      }
      return attachment;
    }),
  );
  return entries.filter((entry): entry is AttachmentDescriptor => entry !== null);
}

async function prepareAttachmentsForPrompt(
  workspaceRoot: string,
  attachments: AttachmentDescriptor[] = [],
): Promise<AttachmentDescriptor[]> {
  const normalizedWorkspaceRoot = normalizeWorkspaceRoot(workspaceRoot);
  return Promise.all(attachments.map(async (attachment) => {
    const documentInput = isSupportedDocumentAttachmentPath(attachment.path)
      || isSupportedDocumentAttachmentPath(attachment.name);
    if (!documentInput) return attachment;

    const sourceWorkspaceRoot = attachment.workspaceRoot
      ? normalizeWorkspaceRoot(attachment.workspaceRoot)
      : normalizedWorkspaceRoot;
    const sourcePath = resolveLegacyDesktopAttachmentReference(sourceWorkspaceRoot, attachment.path)
      ?? (path.isAbsolute(attachment.path)
        ? attachment.path
        : path.resolve(sourceWorkspaceRoot, attachment.path));
    const imported = await importDocumentAttachment({
      sourcePath,
      workspaceRoot: normalizedWorkspaceRoot,
    });
    return {
      ...attachment,
      name: imported.name,
      path: imported.relativePath,
      ref: imported.ref,
      workspaceRoot: normalizedWorkspaceRoot,
      size: imported.size,
      mimeType: imported.mimeType,
      kind: attachmentKind(imported.name, imported.mimeType),
      previewUrl: undefined,
    } satisfies AttachmentDescriptor;
  }));
}

function promptWithAttachments(prompt: string, attachments: AttachmentDescriptor[] = []): string {
  if (attachments.length === 0) return prompt;
  const attachmentLines = attachments.map((attachment) =>
    `- ${attachment.name} (${attachment.kind}, ${attachment.mimeType}): ${attachment.ref ?? attachment.path}`,
  );
  return `${prompt}\n\n[Desktop attachments]\n${attachmentLines.join("\n")}\nUse these local files as task inputs.`;
}

function resolveAttachmentPreviewPath(
  attachment: AttachmentDescriptor,
  workspaceRoot: string,
  allowExternalPath: boolean,
): string | undefined {
  let storedPath = attachment.path;
  if (storedPath.startsWith("file://")) storedPath = storedPath.slice("file://".length);
  if (/^\/[a-zA-Z]:[\\/]/.test(storedPath)) storedPath = storedPath.slice(1);

  const stateAttachmentPath = resolveLegacyDesktopAttachmentReference(workspaceRoot, storedPath);
  if (stateAttachmentPath) return stateAttachmentPath;

  const inputWasAbsolute = path.isAbsolute(storedPath);
  if (inputWasAbsolute && !allowExternalPath) return undefined;
  const absolutePath = inputWasAbsolute
    ? path.resolve(storedPath)
    : path.resolve(workspaceRoot, storedPath);
  if (!inputWasAbsolute) {
    const relative = path.relative(workspaceRoot, absolutePath);
    if (relative === ".." || relative.startsWith(`..${path.sep}`) || path.isAbsolute(relative)) return undefined;
  }
  return absolutePath;
}

async function hydrateAttachmentPreview(
  attachment: AttachmentDescriptor,
  workspaceRoot: string,
  allowExternalPath: boolean,
): Promise<AttachmentDescriptor> {
  if (attachment.kind !== "image" || attachment.previewUrl) return attachment;
  const previewPath = resolveAttachmentPreviewPath(attachment, workspaceRoot, allowExternalPath);
  if (!previewPath) return attachment;
  try {
    const stat = await fs.stat(previewPath);
    if (!stat.isFile() || stat.size > 8 * 1024 * 1024) return attachment;
    const mimeType = attachment.mimeType.startsWith("image/")
      ? attachment.mimeType
      : mimeForPath(previewPath);
    if (!mimeType.startsWith("image/")) return attachment;
    const contents = await fs.readFile(previewPath);
    return {
      ...attachment,
      size: stat.size,
      mimeType,
      previewUrl: `data:${mimeType};base64,${contents.toString("base64")}`,
    };
  } catch {
    return attachment;
  }
}

async function prepareMessagesForDisplay(
  messages: MessageRecord[],
  workspaceRoot: string,
): Promise<MessageRecord[]> {
  return Promise.all(messages.map(async (message) => {
    if (message.role !== "user") return message;
    const presentation = readDesktopMessagePresentation(message.content, message.metadata);
    if (!presentation) return message;
    const attachments = await Promise.all(
      presentation.attachments.map((attachment) => hydrateAttachmentPreview(
        attachment,
        workspaceRoot,
        presentation.source === "metadata",
      )),
    );
    return {
      ...message,
      content: presentation.prompt,
      metadata: {
        ...message.metadata,
        ...createDesktopMessageMetadata(presentation.prompt, attachments),
        desktopAttachments: attachments,
      },
    };
  }));
}

function makeRunCallbacks(activeStore: SessionStore, initialSessionId?: string): RunCallbacks {
  let selectedSessionId = initialSessionId ?? "unknown";
  return {
    onSessionSelected: (sessionId) => {
      selectedSessionId = sessionId;
      sessionWorkspaceRoots.set(sessionId, activeStore.workspaceRoot);
      void activeStore.loadSession(sessionId).then((session) => session && send("deep-mix:sessionUpdated", session));
    },
    onTextDelta: (chunk) => send("deep-mix:streamText", { sessionId: selectedSessionId, turnId: "current", chunk }),
    onToolBatchStart: (batch) =>
      send("deep-mix:toolBatchStart", { sessionId: selectedSessionId, ...batch }),
    onToolStart: (toolCall: ToolCall) =>
      send("deep-mix:toolStart", { sessionId: selectedSessionId, turnId: "current", toolCall }),
    onToolEnd: (result: ToolResult) =>
      send("deep-mix:toolEnd", { sessionId: selectedSessionId, turnId: "current", result }),
    onUserInputRequested: (request: UserInputRequestRecord) => {
      send("deep-mix:userInputRequested", request);
      if (request.mode === "blocking") {
        send("deep-mix:sessionUpdated", {
          sessionId: request.sessionId,
          status: "waiting_for_user",
          updatedAt: now(),
        });
      }
    },
  };
}

async function maybeGenerateDesktopSessionTitle(
  context: WorkspaceRuntimeContext,
  sessionId: string,
): Promise<SessionRecord | undefined> {
  const session = await context.sessionStore.loadSession(sessionId);
  const autoTitleEligible = session?.titleSource === "placeholder"
    || (session?.titleSource === "generated" && session.titleGenerationVersion !== DESKTOP_SESSION_TITLE_VERSION);
  if (!session || !autoTitleEligible) return session;

  const firstTurnMessages = selectFirstTurnTitleMessages(await context.sessionStore.loadMessages(sessionId));
  if (!firstTurnMessages.some((message) => message.role === "user" && message.content.trim())) return session;

  try {
    const generatedTitle = await context.runtime.generateSessionTitle({
      messages: firstTurnMessages,
    });
    if (!generatedTitle) return session;
    return context.sessionStore.updateSession(sessionId, (current) => (
      current.titleSource === "placeholder"
      || (current.titleSource === "generated" && current.titleGenerationVersion !== DESKTOP_SESSION_TITLE_VERSION)
    )
      ? {
          ...current,
          title: generatedTitle,
          titleSource: "generated",
          titleGenerationVersion: DESKTOP_SESSION_TITLE_VERSION,
        }
      : current);
  } catch (error) {
    console.warn(`Failed to generate a title for desktop session ${sessionId}.`, error);
    return session;
  }
}

function scheduleDesktopSessionTitle(
  context: WorkspaceRuntimeContext,
  sessionId: string,
): void {
  if (desktopSessionTitleJobs.has(sessionId)) return;
  const job = maybeGenerateDesktopSessionTitle(context, sessionId)
    .then((titledSession) => {
      if (titledSession?.titleSource === "generated") send("deep-mix:sessionUpdated", titledSession);
    })
    .catch((error) => console.warn(`Failed to update the title for desktop session ${sessionId}.`, error))
    .finally(() => desktopSessionTitleJobs.delete(sessionId));
  desktopSessionTitleJobs.set(sessionId, job);
}

function scheduleLegacyDesktopSessionTitleBackfill(store: SessionStore, session: SessionRecord): void {
  if (session.titleSource !== "placeholder" || session.messageCount < 1 || desktopSessionTitleJobs.has(session.sessionId)) {
    return;
  }
  const job = store.loadMessages(session.sessionId)
    .then(async (messages) => {
      const userRequest = messages.find((message) => message.role === "user")?.content;
      if (!userRequest?.trim()) return;
      const fallbackTitle = createFallbackSessionTitle(userRequest);
      const updated = await store.updateSession(session.sessionId, (current) => current.titleSource === "placeholder"
        ? { ...current, title: fallbackTitle, titleSource: "generated", titleGenerationVersion: 1 }
        : current);
      if (updated.titleSource === "generated") send("deep-mix:sessionUpdated", updated);
    })
    .catch((error) => console.warn(`Failed to backfill the title for desktop session ${session.sessionId}.`, error))
    .finally(() => desktopSessionTitleJobs.delete(session.sessionId));
  desktopSessionTitleJobs.set(session.sessionId, job);
}

function emitApproval(error: PermissionRequiredError, sessionId: string): void {
  const fallbackRecord: ApprovalRecord = {
    recordType: "approval",
    approvalId: error.approvalId,
    sessionId,
    createdAt: now(),
    toolName: error.toolName,
    permissionCategory: error.permissionCategory,
    requestKey: error.requestKey,
    decision: "ask",
    reason: error.message,
    status: "pending",
    persistence: "mode_default",
  };
  const record = error.approvalRecord ?? fallbackRecord;
  send("deep-mix:approvalRequested", record);
  send("deep-mix:sessionUpdated", {
    sessionId: record.sessionId,
    status: "ask_permission",
    updatedAt: now(),
  });
}

async function writeSettingsPatch(workspaceRoot: string, patch: DesktopSettingsPatch): Promise<void> {
  const { projectSettingsPath, userSettingsPath } = resolveDeepMixSettingsPaths(workspaceRoot);
  const settingsPath = existsSync(projectSettingsPath) ? projectSettingsPath : userSettingsPath;
  let storedSettings: DeepMixSettings = {};
  try {
    storedSettings = JSON.parse(await fs.readFile(settingsPath, "utf8")) as DeepMixSettings;
  } catch {
    storedSettings = {};
  }
  const currentRevision = storedSettings.version === 2 ? storedSettings.revision ?? 0 : 0;
  const targetSettings: DeepMixSettings = createDeepMixSettingsMigrationPlan(storedSettings)?.preview ?? storedSettings;
  targetSettings.version = 2;
  targetSettings.revision = currentRevision;
  targetSettings.models = patch.models?.restoreClassic
    ? JSON.parse(JSON.stringify(CLASSIC_MODEL_SETTINGS)) as typeof CLASSIC_MODEL_SETTINGS
    : resolveEffectiveModelSettings(targetSettings);
  targetSettings.defaults = { ...(targetSettings.defaults ?? {}) };
  targetSettings.governor = { ...(targetSettings.governor ?? {}) };
  targetSettings.skills = { ...(targetSettings.skills ?? {}) };
  targetSettings.desktop = { ...(targetSettings.desktop ?? {}) };

  if (patch.permissionMode) targetSettings.defaults.permissionMode = patch.permissionMode;
  if (patch.reasoningEffort) targetSettings.governor.reasoningEffort = patch.reasoningEffort;
  if (patch.thinkingMode) targetSettings.governor.thinkingMode = patch.thinkingMode;
  if (patch.replyStyle) targetSettings.governor.replyStyle = patch.replyStyle;
  if (patch.shortcuts) {
    targetSettings.desktop.shortcuts = {
      ...(targetSettings.desktop.shortcuts ?? {}),
      ...patch.shortcuts,
    };
  }
  if (patch.enabledSkills) {
    targetSettings.skills.enabledSkills = {
      ...(targetSettings.skills.enabledSkills ?? {}),
      ...patch.enabledSkills,
    };
  }
  if (patch.models && !patch.models.restoreClassic) {
    const slot = patch.models.slot;
    const primaryProfileId = patch.models.primaryProfileId?.trim();
    if (!slot || !primaryProfileId) throw new Error("A semantic slot and primary profile are required.");
    const binding = targetSettings.models.slots[slot];
    const profileIds = [primaryProfileId, ...(patch.models.fallbackProfileIds ?? [])];
    if (new Set(profileIds).size !== profileIds.length) throw new Error("Duplicate primary/fallback profile references are not allowed.");
    const service = new ProfileService(workspaceRoot);
    for (const profileId of profileIds) {
      const gate = service.gate(slot, profileId, binding.requirements);
      if (!gate.ok || !gate.profile.hasCredential || !gate.profile.adapterId) {
        const missing = gate.missing.length > 0
          ? gate.missing.join(", ")
          : !gate.profile.hasCredential
            ? "credential"
            : "adapter";
        throw new Error(`Cannot activate ${profileId} for ${slot}: missing ${missing}.`);
      }
    }
    targetSettings.models.preset = "custom";
    targetSettings.models.slots[slot] = {
      ...binding,
      primary: {
        profile: primaryProfileId,
        ...(patch.models.primaryModel?.trim() ? { model: patch.models.primaryModel.trim() } : {}),
      },
      fallbacks: (patch.models.fallbackProfileIds ?? []).map((profile) => ({ profile })),
      fallbackPolicy: {
        ...(binding.fallbackPolicy ?? { on: [] }),
        enabled: (patch.models.fallbackProfileIds?.length ?? 0) > 0,
      },
    };
  }
  await saveDeepMixSettings(
    settingsPath,
    targetSettings,
    patch.models?.expectedRevision ?? currentRevision,
  );
}

app.whenReady().then(async () => {
  if (process.env.DEEP_MIX_PHASE20_PRODUCTION_PROBE === "1") {
    try {
      const report = await runPhase20ProductionProbe();
      process.stdout.write(`${PHASE20_PRODUCTION_PROBE_MARKER}${JSON.stringify(report)}\n`);
    } catch (error) {
      process.exitCode = 1;
      console.error("Deep-Mix Phase 20 production probe failed.", error);
    } finally {
      app.quit();
    }
    return;
  }
  await getWorkspaceRuntime(defaultWorkspaceRoot);
  await createWindow();
  app.on("activate", () => {
    if (BrowserWindow.getAllWindows().length === 0) void createWindow();
  });
});

app.on("window-all-closed", () => {
  if (process.platform !== "darwin") app.quit();
});

let runtimeShutdownStarted = false;
let runtimeShutdownComplete = false;
app.on("will-quit", (event) => {
  if (runtimeShutdownComplete) return;
  event.preventDefault();
  if (runtimeShutdownStarted) return;
  runtimeShutdownStarted = true;
  void disposeAllWorkspaceRuntimes()
    .catch((error) => console.error("Failed to dispose Desktop runtimes during shutdown.", error))
    .finally(() => {
      runtimeShutdownComplete = true;
      app.quit();
    });
});

ipcMain.handle("deep-mix:createSession", async (_event, prompt: string, workspaceRoot?: string) => {
  const context = await getWorkspaceRuntime(workspaceRoot ?? defaultWorkspaceRoot);
  selectDesktopWorkspaceRoot(context.workspaceRoot);
  const session = await context.sessionStore.createSession(prompt, {
    title: "新任务",
    titleSource: "placeholder",
  });
  sessionWorkspaceRoots.set(session.sessionId, context.workspaceRoot);
  return session;
});

ipcMain.handle("deep-mix:resumeSession", async (_event, sessionId?: string, workspaceRoots?: string[]) => {
  try {
    if (sessionId) return await (await getSessionRuntimeFor(sessionId)).runtime.resolveResumeTarget(sessionId);
    for (const root of workspaceRoots ?? [...knownWorkspaceRoots]) {
      try {
        const session = await (await getWorkspaceRuntime(root)).runtime.resolveResumeTarget();
        sessionWorkspaceRoots.set(session.sessionId, session.workspaceRoot);
        return session;
      } catch {
        // Try the next registered workspace.
      }
    }
    return null;
  } catch {
    return null;
  }
});

ipcMain.handle("deep-mix:listSessions", async (_event, workspaceRoots?: string[]) => {
  const roots = [...new Set((workspaceRoots ?? [...knownWorkspaceRoots]).map(normalizeWorkspaceRoot))];
  const groups = await Promise.all(roots.map(async (root) => {
    try {
      const stat = await fs.stat(root);
      if (!stat.isDirectory()) return [];
      const sessions = (await getWorkspaceStore(root).loadSessionsIndex()).sessions;
      sessions.forEach((session) => sessionWorkspaceRoots.set(session.sessionId, root));
      return sessions;
    } catch {
      return [];
    }
  }));
  const sessions = groups.flat().sort((left, right) => right.updatedAt.localeCompare(left.updatedAt));
  sessions.forEach((session) => {
    sessionWorkspaceRoots.set(session.sessionId, session.workspaceRoot);
    scheduleLegacyDesktopSessionTitleBackfill(getWorkspaceStore(session.workspaceRoot), session);
  });
  return sessions;
});

ipcMain.handle("deep-mix:loadSession", async (_event, sessionId: string) => {
  const context = await getSessionRuntimeFor(sessionId);
  const store = context.sessionStore;
  const session = await store.loadSession(sessionId);
  if (!session) return null;
  selectDesktopWorkspaceRoot(session.workspaceRoot);
  const [events, pendingUserInputStates] = await Promise.all([
    store.loadEvents(sessionId),
    store.listPendingUserInputRequests(sessionId),
  ]);
  const messages = events.filter((event): event is MessageRecord => event.recordType === "message");
  const turns = events.filter((event): event is TurnRecord => event.recordType === "turn");
  const detail = {
    session,
    messages: await prepareMessagesForDisplay(messages, session.workspaceRoot),
    turns,
    approvals: selectPendingApprovals(events, session.status),
    pendingUserInput: (
      pendingUserInputStates.find((state) => state.request.mode === "blocking")
      ?? pendingUserInputStates[0]
    )?.request,
  };
  if (
    session.messageCount > 0
    && session.titleSource === "generated"
    && session.titleGenerationVersion !== DESKTOP_SESSION_TITLE_VERSION
  ) {
    scheduleDesktopSessionTitle(context, sessionId);
  }
  return detail;
});

ipcMain.handle(
  "deep-mix:sendPrompt",
  async (
    _event,
    input: { sessionId?: string; workspaceRoot?: string; prompt: string; attachments?: AttachmentDescriptor[] },
  ) => {
    const context = input.sessionId
      ? await getSessionRuntimeFor(input.sessionId)
      : await getWorkspaceRuntime(input.workspaceRoot ?? defaultWorkspaceRoot);
    selectDesktopWorkspaceRoot(context.workspaceRoot);
    try {
      const attachments = await prepareAttachmentsForPrompt(context.workspaceRoot, input.attachments);
      const providerPrompt = promptWithAttachments(input.prompt, attachments);
      const selectedSessionId = input.sessionId ?? (await context.sessionStore.createSession(providerPrompt, {
        title: "新任务",
        titleSource: "placeholder",
      })).sessionId;
      sessionWorkspaceRoots.set(selectedSessionId, context.workspaceRoot);
      const result = await context.runtime.runTurn({
        sessionId: selectedSessionId,
        prompt: providerPrompt,
        callbacks: makeRunCallbacks(context.sessionStore, selectedSessionId),
        ...(attachments.length > 0
          ? { userMessageMetadata: createDesktopMessageMetadata(input.prompt, attachments) }
          : {}),
      });
      sessionWorkspaceRoots.set(result.sessionId, context.workspaceRoot);
      const session = await context.sessionStore.loadSession(result.sessionId);
      if (session) send("deep-mix:sessionUpdated", session);
      scheduleDesktopSessionTitle(context, result.sessionId);
      return { sessionId: result.sessionId };
    } catch (error) {
      if (error instanceof PermissionRequiredError) {
        const sessionId = error.approvalRecord?.sessionId ?? input.sessionId;
        emitApproval(error, sessionId ?? "unknown");
        return { sessionId };
      }
      throw error;
    }
  },
);

ipcMain.handle("deep-mix:interruptSession", async (_event, sessionId: string) => {
  const context = await getSessionRuntimeFor(sessionId);
  await context.runtime.interruptSession(sessionId, "Stopped from the desktop interface.");
  const session = await context.sessionStore.loadSession(sessionId);
  if (session) send("deep-mix:sessionUpdated", session);
});

ipcMain.handle("deep-mix:listManagedProcesses", async (_event, sessionId: string) =>
  (await getSessionRuntimeFor(sessionId)).runtime.listManagedProcesses(sessionId),
);

ipcMain.handle("deep-mix:stopManagedProcess", async (_event, sessionId: string, processSessionId: string) => {
  const context = await getSessionRuntimeFor(sessionId);
  try {
    const result = await context.runtime.stopManagedProcess(sessionId, processSessionId);
    for (const [approvalId, pending] of pendingManagedProcessStops) {
      if (pending.sessionId === sessionId && pending.processSessionId === processSessionId) {
        pendingManagedProcessStops.delete(approvalId);
      }
    }
    return { status: "completed" as const, result };
  } catch (error) {
    if (error instanceof PermissionRequiredError) {
      pendingManagedProcessStops.set(error.approvalId, { sessionId, processSessionId });
      emitApproval(error, sessionId);
      return { status: "approval_required" as const, approvalId: error.approvalId };
    }
    throw error;
  }
});

ipcMain.handle("deep-mix:undoSession", async (_event, sessionId: string) => {
  const context = await getSessionRuntimeFor(sessionId);
  return context.runtime.getSupervisorReviewService().undo({ sessionId, mode: "both" });
});

ipcMain.handle("deep-mix:compactSession", async (_event, sessionId: string) =>
  (await getSessionRuntimeFor(sessionId)).runtime.compactSession(sessionId),
);

ipcMain.handle("deep-mix:mutateSession", async (_event, input: SessionMutationInput) => {
  const store = await getSessionStoreFor(input.sessionId);
  const updated = await store.updateSession(input.sessionId, (session) => ({
    ...session,
    ...(typeof input.title === "string" && input.title.trim()
      ? { title: input.title.trim().slice(0, 120), titleSource: "user" as const }
      : {}),
    ...(typeof input.pinned === "boolean" ? { pinnedAt: input.pinned ? now() : undefined } : {}),
    ...(typeof input.archived === "boolean" ? { archivedAt: input.archived ? now() : undefined } : {}),
    ...(typeof input.unread === "boolean" ? { unread: input.unread } : {}),
  }));
  send("deep-mix:sessionUpdated", updated);
  return updated;
});

ipcMain.handle("deep-mix:deleteSession", async (_event, sessionId: string) => {
  const context = await getSessionRuntimeFor(sessionId);
  await context.runtime.interruptSession(sessionId, "Session deleted from the desktop interface.");
  const deleted = await context.sessionStore.deleteSession(sessionId);
  if (deleted) {
    sessionWorkspaceRoots.delete(sessionId);
    for (const [approvalId, pending] of pendingManagedProcessStops) {
      if (pending.sessionId === sessionId) pendingManagedProcessStops.delete(approvalId);
    }
  }
  return deleted;
});

ipcMain.handle("deep-mix:exportSession", async (_event, sessionId: string) => {
  const store = await getSessionStoreFor(sessionId);
  const session = await store.loadSession(sessionId);
  if (!session) throw new Error(`Unknown session: ${sessionId}`);
  const defaultName = `${session.title.replace(/[\\/:*?"<>|]+/g, "-").slice(0, 48) || "session"}.md`;
  const result = mainWindow
    ? await dialog.showSaveDialog(mainWindow, { defaultPath: path.join(session.workspaceRoot, defaultName), filters: [{ name: "Markdown", extensions: ["md"] }] })
    : await dialog.showSaveDialog({ defaultPath: path.join(session.workspaceRoot, defaultName), filters: [{ name: "Markdown", extensions: ["md"] }] });
  if (result.canceled || !result.filePath) return { cancelled: true };
  const exported = await store.exportSessionMarkdown({ sessionId, outputPath: result.filePath });
  return { cancelled: false, outputPath: exported.outputPath };
});

ipcMain.handle(
  "deep-mix:resolveApproval",
  async (
    _event,
    input: {
      sessionId: string;
      approvalId: string;
      toolName: string;
      requestKey: string;
      persistence: "allow_once" | "allow_session" | "deny";
      reason: string;
    },
  ) => {
    const context = await getSessionRuntimeFor(input.sessionId);
    await context.runtime.resolveApprovalRequest(input);
    const pendingManagedStop = pendingManagedProcessStops.get(input.approvalId);
    if (pendingManagedStop) {
      pendingManagedProcessStops.delete(input.approvalId);
      if (input.persistence !== "deny") {
        try {
          await context.runtime.stopManagedProcess(
            pendingManagedStop.sessionId,
            pendingManagedStop.processSessionId,
          );
        } catch (error) {
          if (error instanceof PermissionRequiredError) {
            pendingManagedProcessStops.set(error.approvalId, pendingManagedStop);
            emitApproval(error, input.sessionId);
          } else {
            throw error;
          }
        }
      }
      const session = await context.sessionStore.loadSession(input.sessionId);
      if (session) send("deep-mix:sessionUpdated", session);
      return;
    }
    try {
      const result = await context.runtime.continuePendingTurn({
        sessionId: input.sessionId,
        callbacks: makeRunCallbacks(context.sessionStore, input.sessionId),
      });
      scheduleDesktopSessionTitle(context, result.sessionId);
    } catch (error) {
      if (error instanceof PermissionRequiredError) {
        emitApproval(error, input.sessionId);
      } else {
        throw error;
      }
    }
    const session = await context.sessionStore.loadSession(input.sessionId);
    if (session) send("deep-mix:sessionUpdated", session);
  },
);

ipcMain.handle(
  "deep-mix:respondToUserInput",
  async (_event, input: DesktopUserInputResponseInput) => {
    const context = await getSessionRuntimeFor(input.sessionId);
    try {
      const result = await context.runtime.respondToUserInput({
        ...input,
        callbacks: makeRunCallbacks(context.sessionStore, input.sessionId),
      });
      scheduleDesktopSessionTitle(context, result.sessionId);
    } catch (error) {
      if (error instanceof PermissionRequiredError) {
        emitApproval(error, input.sessionId);
      } else {
        throw error;
      }
    }
    const session = await context.sessionStore.loadSession(input.sessionId);
    if (session) send("deep-mix:sessionUpdated", session);
  },
);

ipcMain.handle("deep-mix:getSettings", async (_event, workspaceRoot?: string) => {
  const context = await getWorkspaceRuntime(workspaceRoot ?? defaultWorkspaceRoot);
  selectDesktopWorkspaceRoot(context.workspaceRoot);
  return buildDesktopSettings(context);
});

ipcMain.handle("deep-mix:updateSettings", async (_event, patch: DesktopSettingsPatch, workspaceRoot?: string) => {
  const root = normalizeWorkspaceRoot(workspaceRoot ?? defaultWorkspaceRoot);
  selectDesktopWorkspaceRoot(root);
  await writeSettingsPatch(root, patch);
  await disposeWorkspaceRuntime(root);
  return buildDesktopSettings(await getWorkspaceRuntime(root));
});

ipcMain.handle("deep-mix:saveModelProfile", async (
  _event,
  input: DesktopModelProfileSaveInput,
  workspaceRoot?: string,
): Promise<DesktopSettings> => {
  const root = normalizeWorkspaceRoot(workspaceRoot ?? activeDesktopWorkspaceRoot);
  selectDesktopWorkspaceRoot(root);
  const profileId = input.profileId.trim();
  if (!/^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/.test(profileId)) {
    throw new Error("Profile ID must contain only letters, numbers, dots, underscores, or hyphens (maximum 64 characters).");
  }
  const displayName = input.displayName.trim();
  if (!displayName || displayName.length > 80) {
    throw new Error("Connection name must contain 1-80 characters.");
  }
  const provider = input.provider.trim();
  const protocol = input.protocol.trim();
  const model = input.model.trim();
  if (!provider || !protocol || !model) throw new Error("Provider, protocol, and model are required.");
  let baseUrl: URL;
  try {
    baseUrl = new URL(input.baseUrl.trim());
  } catch {
    throw new Error("Base URL must be a valid absolute URL.");
  }
  if ((baseUrl.protocol !== "https:" && baseUrl.protocol !== "http:") || baseUrl.username || baseUrl.password) {
    throw new Error("Base URL must use HTTP(S) and must not contain embedded credentials.");
  }
  if (baseUrl.search || baseUrl.hash) {
    throw new Error("Base URL must not contain a query string or fragment; put endpoint query parameters in the interface path.");
  }
  const endpointPath = input.endpointPath.trim();
  if (!endpointPath.startsWith("/") || endpointPath.startsWith("//")) {
    throw new Error("Endpoint path must start with one slash.");
  }
  const capabilityKeys: Array<Exclude<keyof ModelCapabilityManifest, "contextWindow">> = [
    "textInput", "imageInput", "streaming", "nativeToolCalling", "structuredOutput", "reasoning",
  ];
  if (!Number.isInteger(input.capabilities.contextWindow) || input.capabilities.contextWindow < 1
    || capabilityKeys.some((key) => typeof input.capabilities[key] !== "boolean")) {
    throw new Error("Capability manifest is invalid.");
  }
  const loadedSettings = loadDeepMixSettingsSync(root, { collectErrors: false }).settings;
  const currentSettingsRevision = loadedSettings.version === 2 ? loadedSettings.revision ?? 0 : 0;
  if (currentSettingsRevision !== input.expectedSettingsRevision) {
    throw new Error(`settings_revision_conflict: expected ${input.expectedSettingsRevision}, current ${currentSettingsRevision}.`);
  }
  const effectiveSettings = resolveEffectiveModelSettings(loadedSettings);
  const service = new ProfileService(root);
  const existing = service.listPublicProfiles().find((profile) => profile.profileId === profileId);
  const apiKey = input.apiKey?.trim();
  if (!apiKey && !existing?.hasCredential) {
    throw new Error("API Key is required when creating a model profile.");
  }
  const registeredAdapter = createDefaultModelAdapterRegistry().resolve(input.adapterId);
  if (registeredAdapter.protocol !== protocol) {
    throw new Error(`Protocol ${protocol} does not match adapter ${input.adapterId} (${registeredAdapter.protocol}).`);
  }
  const allowedSlots = [...new Set([...(existing?.allowedSlots ?? []), input.slot])];
  const missingCapabilities = (
    capabilities: ModelCapabilityManifest,
    requirements: ModelSlotBinding["requirements"],
  ): string[] => {
    const missing: string[] = [];
    for (const key of capabilityKeys) {
      if (requirements?.[key] === true && !capabilities[key]) missing.push(key);
    }
    if (requirements?.minimumContextWindow !== undefined
      && capabilities.contextWindow < requirements.minimumContextWindow) {
      missing.push(`minimumContextWindow:${requirements.minimumContextWindow}`);
    }
    return missing;
  };
  for (const allowedSlot of allowedSlots) {
    const missing = missingCapabilities(input.capabilities, effectiveSettings.slots[allowedSlot].requirements);
    if (missing.length > 0) {
      throw new Error(`Cannot save ${profileId} for ${allowedSlot}: missing ${missing.join(", ")}.`);
    }
  }
  const saved = await service.saveProfile({
    profileId,
    displayName,
    provider,
    protocol,
    adapter: input.adapterId.trim(),
    allowedSlots,
    capabilities: { ...input.capabilities },
    ...(apiKey ? { apiKey } : {}),
    baseUrl: baseUrl.toString().replace(/\/$/, ""),
    chatPath: endpointPath,
    model,
  }, input.expectedProfileRevision, {
    preserveCredential: true,
    preserveAdvancedDefaults: true,
  });
  const gate = service.gate(input.slot, saved.profile.profileId, effectiveSettings.slots[input.slot].requirements);
  if (!gate.ok || !gate.profile.hasCredential) {
    throw new Error(`Cannot activate ${profileId} for ${input.slot}: missing ${gate.missing.join(", ") || "credential"}.`);
  }
  await writeSettingsPatch(root, { models: {
    expectedRevision: input.expectedSettingsRevision,
    slot: input.slot,
    primaryProfileId: saved.profile.profileId,
    fallbackProfileIds: [],
  } });
  await disposeWorkspaceRuntime(root);
  return buildDesktopSettings(await getWorkspaceRuntime(root));
});

ipcMain.handle("deep-mix:probeModel", async (_event, profileId: string, workspaceRoot?: string): Promise<DesktopModelProbeResult> => {
  const root = normalizeWorkspaceRoot(workspaceRoot ?? activeDesktopWorkspaceRoot);
  const service = new ProfileService(root);
  const profile = service.listPublicProfiles().find((entry) => entry.profileId === profileId);
  if (!profile) return { profileId, ok: false, redactedError: "profile_unavailable" };
  if (!profile.hasCredential) return { profileId, ok: false, skipped: true, adapterId: profile.adapterId, redactedError: "credential_unavailable" };
  const result = await service.probe(profileId, createDefaultModelAdapterRegistry());
  return {
    profileId,
    ok: result.ok,
    adapterId: result.adapterId,
    latencyMs: result.latencyMs,
    ...(result.redactedError ? { redactedError: result.redactedError } : {}),
  };
});

ipcMain.handle("deep-mix:chooseAttachments", async (_event, workspaceRoot?: string) => {
  const root = selectDesktopWorkspaceRoot(workspaceRoot ?? activeDesktopWorkspaceRoot);
  const result = mainWindow
    ? await dialog.showOpenDialog(mainWindow, { properties: ["openFile", "multiSelections"] })
    : await dialog.showOpenDialog({ properties: ["openFile", "multiSelections"] });
  return result.canceled ? [] : describeFiles(result.filePaths, root);
});

ipcMain.handle(
  "deep-mix:describeDroppedFiles",
  async (_event, paths: string[], workspaceRoot?: string) => {
    const root = selectDesktopWorkspaceRoot(workspaceRoot ?? activeDesktopWorkspaceRoot);
    return describeFiles(paths, root);
  },
);

ipcMain.handle("deep-mix:readClipboardImage", async (_event, workspaceRoot?: string) => {
  const image = clipboard.readImage();
  if (image.isEmpty()) return null;

  const root = selectDesktopWorkspaceRoot(workspaceRoot ?? activeDesktopWorkspaceRoot);
  const stat = await fs.stat(root);
  if (!stat.isDirectory()) throw new Error("当前项目目录不可用。");

  const attachmentDirectory = path.join(resolveWorkspaceStateDirectory(root), "desktop-attachments");
  await fs.mkdir(attachmentDirectory, { recursive: true });
  const targetPath = path.join(attachmentDirectory, `clipboard-${Date.now()}-${randomUUID().slice(0, 8)}.png`);
  await fs.writeFile(targetPath, image.toPNG());
  const [attachment] = await describeFiles([targetPath], root);
  return attachment ?? null;
});

ipcMain.handle("deep-mix:chooseWorkspace", async () => {
  const result = mainWindow
    ? await dialog.showOpenDialog(mainWindow, { properties: ["openDirectory"] })
    : await dialog.showOpenDialog({ properties: ["openDirectory"] });
  if (result.canceled || !result.filePaths[0]) return null;
  const context = await getWorkspaceRuntime(result.filePaths[0]);
  selectDesktopWorkspaceRoot(context.workspaceRoot);
  return buildDesktopSettings(context);
});

ipcMain.handle("deep-mix:pickWorkspace", async () => {
  const result = mainWindow
    ? await dialog.showOpenDialog(mainWindow, { properties: ["openDirectory", "createDirectory"] })
    : await dialog.showOpenDialog({ properties: ["openDirectory", "createDirectory"] });
  return result.canceled ? null : result.filePaths[0] ?? null;
});

ipcMain.handle("deep-mix:activateWorkspace", async (_event, nextWorkspaceRoot: string) => {
  const stat = await fs.stat(nextWorkspaceRoot);
  if (!stat.isDirectory()) throw new Error("Selected workspace is not a directory.");
  const context = await getWorkspaceRuntime(nextWorkspaceRoot);
  selectDesktopWorkspaceRoot(context.workspaceRoot);
  return buildDesktopSettings(context);
});

ipcMain.handle("deep-mix:revealPath", async (_event, targetPath: string) => {
  const stat = await fs.stat(targetPath);
  if (stat.isDirectory()) await shell.openPath(targetPath);
  else shell.showItemInFolder(targetPath);
});

ipcMain.handle("deep-mix:copyText", async (_event, value: string) => {
  clipboard.writeText(value);
  return clipboard.readText() === value;
});

ipcMain.handle("deep-mix:setZoom", async (_event, action: "in" | "out" | "reset") => {
  const webContents = mainWindow?.webContents;
  if (!webContents) return 1;
  const current = webContents.getZoomFactor();
  const next = action === "reset" ? 1 : Math.min(1.6, Math.max(0.7, current + (action === "in" ? 0.1 : -0.1)));
  const normalized = Number(next.toFixed(2));
  webContents.setZoomFactor(normalized);
  return normalized;
});

ipcMain.handle("deep-mix:setTheme", async (_event, theme: WindowTheme) => {
  applyWindowTheme(theme === "dark" ? "dark" : "light");
});

ipcMain.handle("deep-mix:refreshPlan", async (_event, sessionId: string) => {
  const session = await (await getSessionStoreFor(sessionId)).loadSession(sessionId);
  if (!session) return;
  const record: PlanUpdateRecord = {
    recordType: "plan_update",
    sessionId,
    createdAt: now(),
    planItems: session.planItems,
  };
  send("deep-mix:planUpdate", record);
});

ipcMain.handle("deep-mix:refreshDiagnostics", async (_event, sessionId: string) => {
  const events = await (await getSessionStoreFor(sessionId)).loadEvents(sessionId);
  const latest = [...events]
    .reverse()
    .find((event): event is DiagnosticReportRecord => event.recordType === "diagnostic_report");
  if (latest) send("deep-mix:diagnostics", latest);
});

ipcMain.handle("deep-mix:refreshWorkers", async (_event, sessionId: string) => {
  const store = await getSessionStoreFor(sessionId);
  const events = await store.loadEvents(sessionId);
  const links = events
    .filter((event): event is WorkerSessionLinkRecord => event.recordType === "worker_session_link")
    .reverse();
  for (const link of links.slice(0, 20)) {
    const record = await store.loadWorkerSession(link.workerSessionId);
    if (record) send("deep-mix:workerStatus", toWorkerStatusView(record));
  }
});
