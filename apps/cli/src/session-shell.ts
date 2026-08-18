import { createInterface, type Interface } from "node:readline/promises";
import { createInterface as createCallbackInterface } from "node:readline";
import type { Readable, Writable } from "node:stream";
import { promises as fs } from "node:fs";
import { createRequire } from "node:module";
import path from "node:path";
import { PermissionRequiredError } from "../../../packages/core-governor/src/index.js";
import type { SupervisorReviewService } from "../../../packages/core-governor/src/index.js";
import { createDefaultModelAdapterRegistry, ProfileService } from "../../../packages/model-adapters/src/index.js";
import {
  CLASSIC_MODEL_SETTINGS,
  createDeepMixSettingsMigrationPlan,
  loadDeepMixSettingsSync,
  resolveDeepMixSettingsPaths,
  resolveEffectiveModelSettings,
  saveDeepMixSettings,
} from "../../../packages/settings/src/index.js";
import { USER_INPUT_LIMITS } from "../../../packages/shared-schema/src/index.js";
import type {
  ApprovalPersistence,
  ApprovalRecord,
  ContextBudgetSnapshot,
  ContextCompactionRecord,
  HistoryIntegrityRecord,
  DeepMixSettings,
  ModelCapabilityManifest,
  ModelSlotId,
  PermissionMode,
  RuntimeCapabilitySnapshot,
  RouteTarget,
  RunCallbacks,
  SessionEvent,
  SessionRecord,
  SessionStatus,
  TaskDurationSnapshot,
  TokenUsageSnapshot,
  ToolOutputArtifact,
  ToolProcessSession,
  ToolResult,
  UserInputAnswer,
  UserInputQuestion,
  UserInputRequestRecord,
  WorkerSessionEvent,
  WorkerSessionRecord,
} from "../../../packages/shared-schema/src/index.js";

export type CliShellState =
  | "idle"
  | "running_turn"
  | "awaiting_approval"
  | "awaiting_user_input"
  | "interrupted"
  | "exiting";

export interface PromptReader {
  read(promptText: string): Promise<string | undefined>;
  close(): void;
}

export interface OutputWriter {
  write(text: string): void;
}

export interface CliShellInputContext {
  mode: "prompt" | "approval" | "question";
  sessionId?: string;
  promptText: string;
  placeholder: string;
  submitHint: string;
}

export interface CliShellHeaderSnapshot {
  version: string;
  workspaceRoot: string;
  permissionMode: PermissionMode;
  routeOverride?: RouteTarget;
  profiles: ProfileStatusReport;
  capabilities: RuntimeCapabilitySnapshot;
}

export interface CliShellSessionSnapshot {
  cliState: CliShellState;
  sessionId?: string;
  sessionStatus?: SessionStatus;
  routeOverride?: RouteTarget;
  routeSummary?: string;
  fallbackSummary?: string;
  workerSummary?: string;
  currentToolName?: string;
  latestContextBudget?: ContextBudgetSnapshot;
  latestTaskDuration?: TaskDurationSnapshot;
  latestTokenUsage?: TokenUsageSnapshot;
  cumulativeTokenUsage?: TokenUsageSnapshot;
  latestCompaction?: ContextCompactionRecord;
}

export interface CliShellApprovalView {
  sessionId: string;
  approvalId: string;
  toolName: string;
  requestKey: string;
  reason: string;
  actionLabel: string;
  riskLabel: string;
  presentation?: ApprovalRecord["presentation"];
}

export interface CliInteractivePromptReader extends PromptReader {
  setContext?(context: CliShellInputContext): void;
}

export interface CliUiOutputWriter extends OutputWriter {
  setHeader?(header: CliShellHeaderSnapshot): void;
  updateSnapshot?(snapshot: CliShellSessionSnapshot): void;
  recordUserEntry?(text: string, kind: "prompt" | "command"): void;
  startAssistantMessage?(): void;
  appendAssistantText?(chunk: string): void;
  completeAssistantMessage?(): void;
  recordSystemMessage?(text: string, tone?: "info" | "success" | "warning" | "error"): void;
  recordCommandResult?(
    command: string,
    text: string,
    tone?: "info" | "success" | "warning" | "error",
  ): void;
  recordToolBatchStart?(batchId: string, tools: ReadonlyArray<{ id: string; name: string }>): void;
  recordToolStart?(toolName: string, callId?: string): void;
  recordToolEnd?(
    toolName: string,
    success: boolean,
    fallback?: string,
    artifacts?: readonly ToolOutputArtifact[],
    result?: ToolResult,
  ): void;
  showApproval?(approval: CliShellApprovalView): void;
  clearApproval?(): void;
  setHelpVisible?(visible: boolean, lines: string[]): void;
  toggleToolDetails?(sequence?: number): { sequence: number; expanded: boolean } | undefined;
  completeTaskPresentation?(durationMs?: number): void;
}

export interface ProfileStatusEntry {
  exists: boolean;
  hasKey: boolean;
  provider?: string;
  model?: string;
  adapterId?: string;
  capabilities?: ModelCapabilityManifest;
}

export interface ModelSlotStatusEntry {
  slot: ModelSlotId;
  primary: { profileId: string; model?: string; status: ProfileStatusEntry };
  fallbacks: Array<{ profileId: string; model?: string; status: ProfileStatusEntry }>;
  fallbackEnabled: boolean;
}

export interface ProfileStatusReport {
  deepseek_governor: ProfileStatusEntry;
  glm_coding_worker: ProfileStatusEntry;
  kimi_vision: ProfileStatusEntry;
  slots?: Record<ModelSlotId, ModelSlotStatusEntry>;
  preset?: "classic" | "custom";
  revision?: number;
}

export interface RuntimeTurnResult {
  sessionId: string;
  session: SessionRecord;
  finalResponse: string;
  pendingUserInput?: UserInputRequestRecord;
}

export interface CliRuntimeSurface {
  initialize(): Promise<void>;
  getRuntimeCapabilities(): Promise<RuntimeCapabilitySnapshot>;
  resolveResumeTarget(sessionId?: string): Promise<SessionRecord>;
  runTurn(input: {
    sessionId?: string;
    prompt: string;
    callbacks?: RunCallbacks;
    routeOverride?: RouteTarget;
  }): Promise<RuntimeTurnResult>;
  continuePendingTurn(input: {
    sessionId: string;
    callbacks?: RunCallbacks;
    routeOverride?: RouteTarget;
  }): Promise<RuntimeTurnResult>;
  respondToUserInput?(input: {
    sessionId: string;
    requestId: string;
    answers?: UserInputAnswer[];
    cancel?: boolean;
    cancelReason?: string;
    callbacks?: RunCallbacks;
    routeOverride?: RouteTarget;
  }): Promise<RuntimeTurnResult>;
  resolveApprovalRequest(input: {
    sessionId: string;
    approvalId: string;
    toolName: string;
    requestKey: string;
    persistence: "allow_once" | "allow_session" | "deny";
    reason: string;
  }): Promise<void>;
  interruptSession(sessionId: string, reason: string): Promise<void>;
  listManagedProcesses?(sessionId: string): Promise<ToolProcessSession[]>;
  stopManagedProcess?(sessionId: string, processSessionId: string): Promise<ToolResult>;
  getSupervisorReviewService(): Pick<SupervisorReviewService, "undo">;
}

export interface CliSessionStoreSurface {
  ensureInitialized(): Promise<void>;
  loadSession(sessionId: string): Promise<SessionRecord | undefined>;
  loadEvents(sessionId: string): Promise<SessionEvent[]>;
  loadWorkerSession?(workerSessionId: string): Promise<WorkerSessionRecord | undefined>;
  loadWorkerEvents?(workerSessionId: string): Promise<WorkerSessionEvent[]>;
  setSessionStatus(sessionId: string, status: SessionStatus): Promise<SessionRecord>;
  exportSessionMarkdown?(input: { sessionId: string; outputPath?: string }): Promise<{ outputPath: string; content: string }>;
}

interface PendingApprovalContext {
  sessionId: string;
  prompt: string;
  approvalId: string;
  toolName: string;
  requestKey: string;
  reason: string;
  permissionCategory: ApprovalRecord["permissionCategory"];
  sideEffectLevel?: ApprovalRecord["sideEffectLevel"];
  presentation?: ApprovalRecord["presentation"];
}

interface SessionContextSnapshot {
  session: SessionRecord;
  lastTurn?: Extract<SessionEvent, { recordType: "turn" }>;
  pendingApproval?: PendingApprovalContext;
  pendingUserInput?: UserInputRequestRecord;
  lastHistoryIntegrity?: HistoryIntegrityRecord;
  lastRoutingSummary?: string;
  lastWorkerSummary?: string;
}

export interface CliShellOptions {
  runtime: CliRuntimeSurface;
  sessionStore: CliSessionStoreSurface;
  input: PromptReader;
  output: OutputWriter;
  workspaceRoot: string;
  permissionMode: PermissionMode;
  routeOverride?: RouteTarget;
  getProfileStatus: () => Promise<ProfileStatusReport>;
  reloadRuntime?: () => Promise<CliRuntimeSurface>;
}

export interface CliShellRunOptions {
  initialPrompt?: string;
  resumeRequested?: boolean;
  resumeSessionId?: string;
}

interface CliToolGroupEntry {
  callId?: string;
  toolName: string;
  startedAtMs: number;
  result?: ToolResult;
}

interface CliToolGroupRecord {
  sequence: number;
  batchId?: string;
  startedAtMs: number;
  endedAtMs?: number;
  entries: CliToolGroupEntry[];
  summarized: boolean;
}

interface TurnPresentationState {
  assistantSegmentOpen: boolean;
}

const HELP_LINES = [
  "Commands:",
  "  /help       Show available commands",
  "  /resume     Resume a specific or latest resumable session",
  "  /continue   Continue the current session, or resume the latest one",
  "  /export     Export the current session to markdown",
  "  /context    Show context budget, usage, compaction, and duration",
  "  /undo       Restore the latest or selected checkpoint",
  "  /session    Show the current session id",
  "  /status     Show the current session status",
  "  /models     Show or configure governor/coding/vision model slots",
  "  /models test <profile>  Run the fixed synthetic connection probe",
  "  /models classic  Restore classic slot bindings without deleting profiles",
  "  /tools [n]  Expand or print one grouped tool round",
  "  /processes  Show managed processes owned by the current session",
  "  /stop-process <id>  Stop a managed process through the normal approval path",
  "  /exit       Exit the CLI safely",
];

const require = createRequire(import.meta.url);
const packageJson = require("../../../package.json") as { version?: string };

function versionString(): string {
  return (packageJson as { version?: string }).version ?? "1.1.0";
}

function shortSessionId(sessionId: string | undefined): string {
  if (!sessionId) {
    return "none";
  }
  return sessionId.slice(0, 8);
}

function actionTypeLabel(permissionCategory: ApprovalRecord["permissionCategory"]): string {
  switch (permissionCategory) {
    case "execute_command":
      return "execute command";
    case "write_file":
      return "write files";
    case "run_tests":
      return "run tests";
    case "external_mcp":
      return "external MCP action";
    case "mcp_read_only":
      return "read-only MCP action";
    case "mcp_side_effectful":
      return "side-effectful MCP action";
    default:
      return "tool action";
  }
}

function riskLabel(
  permissionCategory: ApprovalRecord["permissionCategory"],
  sideEffectLevel?: ApprovalRecord["sideEffectLevel"],
): string {
  if (sideEffectLevel) return sideEffectLevel;
  switch (permissionCategory) {
    case "write_file":
    case "mcp_side_effectful":
      return "high";
    case "execute_command":
    case "external_mcp":
      return "medium";
    case "run_tests":
      return "low";
    default:
      return "low";
  }
}

function describeProfile(entry: ProfileStatusEntry): string {
  if (!entry.exists) {
    return "missing";
  }
  return entry.hasKey ? "ready" : "missing-key";
}

function describeCapability(snapshot: RuntimeCapabilitySnapshot, name: keyof RuntimeCapabilitySnapshot["capabilities"]): string {
  const capability = snapshot.capabilities[name];
  if (!capability) {
    return `${name}=unknown`;
  }
  if (name === "rg" && !capability.available) {
    return `${name}=missing(fallback:${snapshot.fallbacks.listFiles}/${snapshot.fallbacks.searchFiles})`;
  }
  return `${name}=${capability.available ? "ready" : capability.message}`;
}

function formatTokenCount(value: number | undefined): string {
  if (value === undefined || !Number.isFinite(value)) {
    return "unavailable";
  }
  if (value >= 1000) {
    return `${(value / 1000).toFixed(value >= 10000 ? 0 : 1)}k`;
  }
  return String(Math.round(value));
}

function formatDurationMs(durationMs: number | undefined): string {
  if (durationMs === undefined || !Number.isFinite(durationMs)) {
    return "unavailable";
  }
  const totalSeconds = Math.max(0, Math.round(durationMs / 1000));
  const hours = Math.floor(totalSeconds / 3600);
  const minutes = Math.floor((totalSeconds % 3600) / 60);
  const seconds = totalSeconds % 60;
  if (hours > 0) {
    return `${hours}h ${minutes}m ${seconds}s`;
  }
  if (minutes > 0) {
    return `${minutes}m ${seconds}s`;
  }
  return `${seconds}s`;
}

function resolveDurationSnapshot(snapshot: TaskDurationSnapshot | undefined): TaskDurationSnapshot | undefined {
  if (!snapshot) {
    return undefined;
  }
  if (snapshot.endedAt) {
    return snapshot;
  }
  const durationMs = Math.max(0, Date.now() - new Date(snapshot.startedAt).getTime());
  return {
    ...snapshot,
    durationMs,
  };
}

function formatUsageSource(source: TokenUsageSnapshot["source"] | ContextBudgetSnapshot["source"] | undefined): string {
  if (!source) {
    return "unavailable";
  }
  switch (source) {
    case "provider_exact":
      return "exact";
    case "provider_partial":
      return "partial";
    case "local_estimated":
      return "estimated";
    default:
      return "unavailable";
  }
}

function extractFallbackSummary(structuredContent: unknown): string | undefined {
  if (!structuredContent || typeof structuredContent !== "object") {
    return undefined;
  }
  const value = structuredContent as {
    strategy?: string;
    fallbackUsed?: boolean;
  };
  if (!value.fallbackUsed || !value.strategy) {
    return undefined;
  }
  return value.strategy;
}

function sanitizeArtifactDisplayValue(value: string): string {
  return value.replace(/[\u0000-\u001f\u007f]+/gu, " ").trim();
}

export function formatToolOutputArtifactLines(
  artifacts: readonly ToolOutputArtifact[] | undefined,
): string[] {
  return (artifacts ?? []).map((artifact) => {
    const fileName = sanitizeArtifactDisplayValue(artifact.fileName);
    const type = `${sanitizeArtifactDisplayValue(artifact.kind)} (${sanitizeArtifactDisplayValue(artifact.mimeType)})`;
    const location = sanitizeArtifactDisplayValue(artifact.workspaceRelativePath ?? artifact.uri);
    return `[tool:artifact] ${fileName} | ${type} | ${location}`;
  });
}

function pendingApprovalFromError(
  sessionId: string,
  prompt: string,
  error: PermissionRequiredError,
): PendingApprovalContext {
  const record = error.approvalRecord;
  return {
    sessionId: record?.sessionId ?? sessionId,
    prompt,
    approvalId: record?.approvalId ?? error.approvalId,
    toolName: record?.toolName ?? error.toolName,
    requestKey: record?.requestKey ?? error.requestKey,
    reason: record?.reason ?? error.message,
    permissionCategory: record?.permissionCategory ?? error.permissionCategory,
    sideEffectLevel: record?.sideEffectLevel,
    presentation: record?.presentation,
  };
}

function formatApprovalPresentationLines(
  presentation: ApprovalRecord["presentation"],
): string[] {
  if (!presentation) return [];
  const sanitize = (value: string): string => value.replace(/[\u0000-\u001f\u007f]+/gu, " ").trim();
  const lines = [presentation.summary ? `summary: ${sanitize(presentation.summary)}` : undefined];
  if (presentation.paths?.length) {
    lines.push(`paths: ${presentation.paths.map(sanitize).join(", ")}`);
  }
  if (presentation.revisions?.length) {
    lines.push(`revisions: ${presentation.revisions.map(sanitize).join(", ")}`);
  }
  if (presentation.argumentSummary && Object.keys(presentation.argumentSummary).length > 0) {
    const summary = JSON.stringify(presentation.argumentSummary);
    lines.push(`arguments: ${sanitize(summary.length > 1_000 ? `${summary.slice(0, 1_000)}...[truncated]` : summary)}`);
  }
  return lines.filter((line): line is string => Boolean(line));
}

function promptLabel(sessionId: string | undefined): string {
  return sessionId ? `deep-mix:${shortSessionId(sessionId)}> ` : "deep-mix> ";
}

function parseCommand(input: string): { name: string; args: string[] } | undefined {
  if (!input.startsWith("/")) {
    return undefined;
  }
  const parts = input.trim().split(/\s+/).filter(Boolean);
  if (parts.length === 0) {
    return undefined;
  }
  return {
    name: parts[0]!.toLowerCase(),
    args: parts.slice(1),
  };
}

function parseApprovalChoice(input: string): Extract<ApprovalPersistence, "allow_once" | "allow_session" | "deny"> | undefined {
  const normalized = input.trim().toLowerCase();
  switch (normalized) {
    case "1":
    case "allow once":
    case "allow_once":
    case "once":
      return "allow_once";
    case "2":
    case "allow session":
    case "allow_session":
    case "session":
      return "allow_session";
    case "3":
    case "deny":
      return "deny";
    default:
      return undefined;
  }
}

function isTurnEvent(event: SessionEvent): event is Extract<SessionEvent, { recordType: "turn" }> {
  return event.recordType === "turn";
}

function isApprovalEvent(event: SessionEvent): event is ApprovalRecord {
  return event.recordType === "approval";
}

function isRoutingDecisionEvent(event: SessionEvent): event is Extract<SessionEvent, { recordType: "routing_decision" }> {
  return event.recordType === "routing_decision";
}

function isWorkerSessionLinkEvent(event: SessionEvent): event is Extract<SessionEvent, { recordType: "worker_session_link" }> {
  return event.recordType === "worker_session_link";
}

function isWorkerStatusEvent(event: WorkerSessionEvent): event is Extract<WorkerSessionEvent, { recordType: "worker_status" }> {
  return event.recordType === "worker_status";
}

function findLastTurn(events: SessionEvent[]): Extract<SessionEvent, { recordType: "turn" }> | undefined {
  return [...events].reverse().find(isTurnEvent);
}

function findPendingApproval(events: SessionEvent[]): ApprovalRecord | undefined {
  const seenApprovalIds = new Set<string>();
  for (let index = events.length - 1; index >= 0; index -= 1) {
    const event = events[index];
    if (!event || !isApprovalEvent(event)) {
      continue;
    }
    if (seenApprovalIds.has(event.approvalId)) {
      continue;
    }
    seenApprovalIds.add(event.approvalId);
    if (event.status === "pending") {
      return event;
    }
  }
  return undefined;
}

function isUserInputRequestEvent(event: SessionEvent): event is UserInputRequestRecord {
  return event.recordType === "user_input_request";
}

function findPendingUserInput(events: SessionEvent[]): UserInputRequestRecord | undefined {
  const closedRequestIds = new Set<string>();
  for (const event of events) {
    if (
      (event.recordType === "user_input_response" && event.status === "cancelled") ||
      (event.recordType === "user_input_resume" &&
        (event.status === "resumed" || event.status === "interrupted"))
    ) {
      closedRequestIds.add(event.requestId);
    }
  }
  return [...events]
    .reverse()
    .find((event): event is UserInputRequestRecord =>
      isUserInputRequestEvent(event) && !closedRequestIds.has(event.requestId));
}

function describeQuestionDefault(question: UserInputQuestion): string | undefined {
  if (question.defaultValue === undefined) {
    return undefined;
  }
  if (Array.isArray(question.defaultValue)) {
    return question.defaultValue.join(", ");
  }
  return String(question.defaultValue);
}

export function formatUserInputRequestLines(request: UserInputRequestRecord): string[] {
  const lines = [
    request.title ? `Question: ${request.title}` : "Question from Deep-Mix:",
  ];
  request.questions.forEach((question, questionIndex) => {
    lines.push(`${questionIndex + 1}. ${question.prompt}${question.required ? " (required)" : " (optional)"}`);
    question.options?.forEach((option, optionIndex) => {
      lines.push(`   ${optionIndex + 1}) ${option.label}${option.description ? ` - ${option.description}` : ""}`);
    });
    const defaultValue = describeQuestionDefault(question);
    const hints = [
      question.kind === "multi_select" ? "choose one or more, separated by commas" : undefined,
      question.kind === "confirm" ? "yes/no" : undefined,
      question.allowFreeform ? "free text is allowed" : undefined,
      question.placeholder?.trim() || undefined,
      defaultValue !== undefined ? `Enter accepts default: ${defaultValue}` : undefined,
    ].filter((hint): hint is string => Boolean(hint));
    if (hints.length > 0) {
      lines.push(`   ${hints.join("; ")}`);
    }
  });
  lines.push("Type /cancel while answering to cancel this pending request.");
  return lines;
}

function resolveQuestionOption(question: UserInputQuestion, token: string): string | undefined {
  const options = question.options ?? [];
  const numericIndex = Number.parseInt(token, 10);
  if (/^\d+$/u.test(token) && numericIndex >= 1 && numericIndex <= options.length) {
    return options[numericIndex - 1]?.id;
  }
  return options.find((option) => option.id.toLocaleLowerCase() === token.toLocaleLowerCase())?.id;
}

export function parseUserInputAnswer(
  question: UserInputQuestion,
  rawInput: string,
): UserInputAnswer | undefined {
  const input = rawInput.trim();
  if (!input) {
    if (question.defaultValue !== undefined) {
      return {
        questionId: question.id,
        value: question.defaultValue,
        source: "default_accepted",
      };
    }
    if (!question.required) {
      return undefined;
    }
    throw new Error("This question requires an answer.");
  }

  if (question.kind === "confirm") {
    const normalized = input.toLocaleLowerCase();
    if (["y", "yes", "true", "1", "confirm"].includes(normalized)) {
      return { questionId: question.id, value: true, source: "explicit_confirmation" };
    }
    if (["n", "no", "false", "0", "deny"].includes(normalized)) {
      return { questionId: question.id, value: false, source: "explicit_confirmation" };
    }
    throw new Error("Enter yes or no.");
  }

  if (question.kind === "text") {
    if (input.length > USER_INPUT_LIMITS.maxFreeformChars) {
      throw new Error(`Text must not exceed ${USER_INPUT_LIMITS.maxFreeformChars} characters.`);
    }
    return { questionId: question.id, value: input, source: "freeform" };
  }

  if (question.kind === "single_select") {
    const optionId = resolveQuestionOption(question, input);
    if (optionId) {
      return { questionId: question.id, value: optionId, source: "selected_option" };
    }
    if (question.allowFreeform) {
      if (input.length > USER_INPUT_LIMITS.maxFreeformChars) {
        throw new Error(`Free text must not exceed ${USER_INPUT_LIMITS.maxFreeformChars} characters.`);
      }
      return { questionId: question.id, value: input, source: "freeform" };
    }
    throw new Error("Choose one of the listed option numbers or ids.");
  }

  const tokens = input.split(",").map((token) => token.trim()).filter(Boolean);
  if (tokens.length > USER_INPUT_LIMITS.maxOptionsPerQuestion) {
    throw new Error(`Choose at most ${USER_INPUT_LIMITS.maxOptionsPerQuestion} values.`);
  }
  const resolved = tokens.map((token) => resolveQuestionOption(question, token));
  if (resolved.every((optionId): optionId is string => Boolean(optionId))) {
    return { questionId: question.id, value: [...new Set(resolved)], source: "selected_option" };
  }
  if (question.allowFreeform) {
    const values = tokens.map((token, index) => resolved[index] ?? token);
    if (values.some((value) => value.length > USER_INPUT_LIMITS.maxFreeformChars)) {
      throw new Error(`Free text must not exceed ${USER_INPUT_LIMITS.maxFreeformChars} characters.`);
    }
    return { questionId: question.id, value: [...new Set(values)], source: "freeform" };
  }
  throw new Error("Choose listed option numbers or ids, separated by commas.");
}

function isHistoryIntegrityEvent(event: SessionEvent): event is HistoryIntegrityRecord {
  return event.recordType === "history_integrity";
}

function findLatestHistoryIntegrity(events: SessionEvent[], scope?: HistoryIntegrityRecord["scope"]): HistoryIntegrityRecord | undefined {
  return [...events]
    .reverse()
    .find((event): event is HistoryIntegrityRecord => isHistoryIntegrityEvent(event) && (!scope || event.scope === scope));
}

function findLatestRoutingDecision(events: SessionEvent[]): Extract<SessionEvent, { recordType: "routing_decision" }> | undefined {
  return [...events].reverse().find(isRoutingDecisionEvent);
}

function findLatestWorkerSessionLink(events: SessionEvent[]): Extract<SessionEvent, { recordType: "worker_session_link" }> | undefined {
  return [...events].reverse().find(isWorkerSessionLinkEvent);
}

export async function readProfileStatus(workspaceRoot: string): Promise<ProfileStatusReport> {
  const service = new ProfileService(workspaceRoot);
  const publicProfiles = new Map(service.listPublicProfiles().map((profile) => [profile.profileId, profile]));
  const toStatus = (profileId: string): ProfileStatusEntry => {
    const profile = publicProfiles.get(profileId);
    return profile ? {
      exists: true,
      hasKey: profile.hasCredential,
      provider: profile.provider,
      model: profile.model,
      adapterId: profile.adapterId,
      capabilities: profile.capabilities,
    } : { exists: false, hasKey: false };
  };
  const loaded = loadDeepMixSettingsSync(workspaceRoot, { collectErrors: true });
  const models = resolveEffectiveModelSettings(loaded.settings);
  const slotStatus = (slot: ModelSlotId): ModelSlotStatusEntry => {
    const binding = models.slots[slot];
    return {
      slot,
      primary: { profileId: binding.primary.profile, model: binding.primary.model, status: toStatus(binding.primary.profile) },
      fallbacks: binding.fallbacks.map((reference) => ({ profileId: reference.profile, model: reference.model, status: toStatus(reference.profile) })),
      fallbackEnabled: binding.fallbackPolicy?.enabled ?? false,
    };
  };
  return {
    deepseek_governor: toStatus("deepseek_governor"),
    glm_coding_worker: toStatus("glm_coding_worker"),
    kimi_vision: toStatus("kimi_vision"),
    slots: {
      governor: slotStatus("governor"),
      coding: slotStatus("coding"),
      vision: slotStatus("vision"),
    },
    preset: models.preset,
    revision: loaded.settings.version === 2 ? loaded.settings.revision ?? 0 : 0,
  };
}

async function readProjectSettingsForWrite(workspaceRoot: string): Promise<{ settings: DeepMixSettings; revision: number; path: string }> {
  const { projectSettingsPath, userSettingsPath } = resolveDeepMixSettingsPaths(workspaceRoot);
  const settingsPath = await fs.access(projectSettingsPath)
    .then(() => projectSettingsPath)
    .catch(() => userSettingsPath);
  let current: DeepMixSettings = {};
  try {
    current = JSON.parse(await fs.readFile(settingsPath, "utf8")) as DeepMixSettings;
  } catch {
    current = {};
  }
  const migrated = createDeepMixSettingsMigrationPlan(current)?.preview ?? current;
  return {
    settings: migrated,
    revision: current.version === 2 ? current.revision ?? 0 : 0,
    path: settingsPath,
  };
}

async function saveCliModelBinding(
  workspaceRoot: string,
  input: { slot?: ModelSlotId; profileId?: string; fallbacks?: string[]; model?: string; classic?: boolean },
): Promise<string> {
  const current = await readProjectSettingsForWrite(workspaceRoot);
  const next: DeepMixSettings = {
    ...current.settings,
    version: 2,
    revision: current.revision,
    models: input.classic
      ? JSON.parse(JSON.stringify(CLASSIC_MODEL_SETTINGS)) as typeof CLASSIC_MODEL_SETTINGS
      : resolveEffectiveModelSettings(current.settings),
  };
  if (!input.classic) {
    if (!input.slot || !input.profileId) throw new Error("Usage: /models set <governor|coding|vision> <profile> [fallback1,fallback2] [model=name]");
    const requirements = next.models!.slots[input.slot].requirements;
    const service = new ProfileService(workspaceRoot);
    const refs = [input.profileId, ...(input.fallbacks ?? [])];
    for (const profileId of refs) {
      const mandatory = input.slot === "governor"
        ? { textInput: true }
        : input.slot === "coding"
          ? { textInput: true, structuredOutput: true }
          : { textInput: true, imageInput: true, structuredOutput: true };
      const gate = service.gate(input.slot, profileId, { ...mandatory, ...(requirements ?? {}) });
      if (!gate.ok || !gate.profile.hasCredential || !gate.profile.adapterId) {
        throw new Error(`Cannot activate ${profileId} for ${input.slot}: missing=${gate.missing.join(",") || (!gate.profile.hasCredential ? "credential" : "adapter")}.`);
      }
    }
    next.models!.preset = "custom";
    next.models!.slots[input.slot] = {
      ...next.models!.slots[input.slot],
      primary: { profile: input.profileId, ...(input.model ? { model: input.model } : {}) },
      fallbacks: (input.fallbacks ?? []).map((profile) => ({ profile })),
      fallbackPolicy: {
        ...(next.models!.slots[input.slot].fallbackPolicy ?? { on: [] }),
        enabled: (input.fallbacks?.length ?? 0) > 0,
      },
    };
  }
  const saved = await saveDeepMixSettings(current.path, next, current.revision);
  return input.classic
    ? `Classic bindings restored at settings revision ${saved.revision}; custom profiles and credentials were not deleted.`
    : `${input.slot} now uses ${input.profileId} at settings revision ${saved.revision}; running requests were not changed.`;
}

export function createNodePromptReader(stdin: Readable, stdout: Writable): PromptReader {
  const isTerminal = Boolean((stdin as Readable & { isTTY?: boolean }).isTTY && (stdout as Writable & { isTTY?: boolean }).isTTY);
  if (!isTerminal) {
    const rl = createCallbackInterface({
      input: stdin,
      terminal: false,
      crlfDelay: Number.POSITIVE_INFINITY,
    });
    const queuedLines: string[] = [];
    const waiters: Array<(value: string | undefined) => void> = [];
    let closed = false;

    rl.on("line", (line) => {
      const value = line.trim();
      const waiter = waiters.shift();
      if (waiter) {
        waiter(value);
        return;
      }
      queuedLines.push(value);
    });
    rl.on("close", () => {
      closed = true;
      while (waiters.length > 0) {
        waiters.shift()?.(undefined);
      }
    });

    return {
      async read(promptText: string): Promise<string | undefined> {
        stdout.write(promptText);
        if (queuedLines.length > 0) {
          return queuedLines.shift();
        }
        if (closed) {
          return undefined;
        }
        return new Promise((resolve) => {
          waiters.push(resolve);
        });
      },
      close(): void {
        if (!closed) {
          rl.close();
        }
      },
    };
  }

  const rl: Interface = createInterface({
    input: stdin,
    output: stdout,
    terminal: true,
  });
  let closed = false;
  rl.on("close", () => {
    closed = true;
  });

  return {
    read(promptText: string): Promise<string | undefined> {
      if (closed) {
        return Promise.resolve(undefined);
      }
      return new Promise((resolve, reject) => {
        const handleClose = () => {
          cleanup();
          resolve(undefined);
        };
        const cleanup = () => {
          rl.off("close", handleClose);
        };
        rl.once("close", handleClose);
        rl.question(promptText)
          .then((value) => {
            cleanup();
            resolve(value.trim());
          })
          .catch((error) => {
            cleanup();
            reject(error);
          });
      });
    },
    close(): void {
      if (!closed) {
        rl.close();
      }
    },
  };
}

export class CliSessionShell {
  private state: CliShellState = "idle";

  private currentSessionId?: string;

  private pendingApproval?: PendingApprovalContext;

  private pendingUserInput?: UserInputRequestRecord;

  private pendingInterrupt = false;

  private exitRequested = false;

  private currentToolName?: string;

  private capabilitySnapshot?: RuntimeCapabilitySnapshot;

  private announcedUserInputRequestId?: string;

  private readonly toolGroups: CliToolGroupRecord[] = [];

  private activeToolGroup?: CliToolGroupRecord;

  private nextToolGroupSequence = 1;

  public constructor(private readonly options: CliShellOptions) {}

  private get uiOutput(): CliUiOutputWriter {
    return this.options.output as CliUiOutputWriter;
  }

  private get interactiveInput(): CliInteractivePromptReader {
    return this.options.input as CliInteractivePromptReader;
  }

  private get hasCollapsibleTaskPresentation(): boolean {
    return typeof this.uiOutput.completeTaskPresentation === "function";
  }

  public async run(runOptions: CliShellRunOptions = {}): Promise<void> {
    await this.options.runtime.initialize();
    await this.options.sessionStore.ensureInitialized();
    await this.renderHeader();
    await this.syncUiSnapshot();

    if (runOptions.resumeRequested) {
      try {
        await this.resumeSession(runOptions.resumeSessionId);
      } catch (error) {
        this.output(`[state] failed | session ${runOptions.resumeSessionId ?? "unknown"}\n`);
        this.recordSystemMessage((error as Error).message, "error");
        this.output(`${(error as Error).message}\n`);
      }
    }

    if (this.pendingApproval) {
      await this.handleApproval();
    }

    if (this.pendingUserInput) {
      await this.handleUserInputRequest();
    }

    if (runOptions.initialPrompt && !this.exitRequested && !this.pendingApproval && !this.pendingUserInput) {
      this.recordUserEntry(runOptions.initialPrompt, "prompt");
      await this.executePrompt(runOptions.initialPrompt);
    }

    while (!this.exitRequested) {
      if (this.pendingApproval) {
        await this.handleApproval();
        continue;
      }

      if (this.pendingUserInput) {
        await this.handleUserInputRequest();
        continue;
      }

      this.state = "awaiting_user_input";
      await this.syncUiSnapshot();
      this.setInputContext({
        mode: "prompt",
        sessionId: this.currentSessionId,
        promptText: promptLabel(this.currentSessionId),
        placeholder: "Describe a task, continue a session, or use a slash command.",
        submitHint: "Enter send  Ctrl+G help  Ctrl+R resume  Ctrl+O continue",
      });
      const line = await this.options.input.read(promptLabel(this.currentSessionId));
      if (line === undefined) {
        if (!this.exitRequested) {
          this.output("\nSafe exit. Use /resume to continue later.\n");
          this.recordSystemMessage("Safe exit. Use /resume to continue later.", "info");
        }
        break;
      }
      if (!line) {
        continue;
      }
      await this.handleInput(line);
    }

    this.state = "exiting";
    await this.syncUiSnapshot();
    this.options.input.close();
  }

  public async requestInterrupt(): Promise<void> {
    if (this.state === "running_turn" && this.currentSessionId) {
      if (this.pendingInterrupt) {
        this.exitRequested = true;
        this.recordSystemMessage("Second interrupt received. Deep-Mix will exit after the current turn stops.", "warning");
        this.output("Second interrupt received. Deep-Mix will exit after the current turn stops.\n");
        return;
      }
      this.pendingInterrupt = true;
      await this.options.runtime.interruptSession(this.currentSessionId, "CLI interrupted by SIGINT.");
      this.output(`\n[state] interrupted | session ${this.currentSessionId}\n`);
      this.recordSystemMessage("Interrupt requested. Stopping the current turn.", "warning");
      this.output("Interrupt requested. Stopping the current turn.\n");
      await this.syncUiSnapshot();
      return;
    }

    if (this.state === "awaiting_approval" || this.state === "awaiting_user_input" || this.state === "idle") {
      this.output("\nSafe exit requested. Use /resume to continue later.\n");
      this.recordSystemMessage("Safe exit requested. Use /resume to continue later.", "info");
      this.exitRequested = true;
      this.options.input.close();
      return;
    }
  }

  private setInputContext(context: CliShellInputContext): void {
    this.interactiveInput.setContext?.(context);
  }

  private recordUserEntry(text: string, kind: "prompt" | "command"): void {
    this.uiOutput.recordUserEntry?.(text, kind);
  }

  private recordSystemMessage(text: string, tone: "info" | "success" | "warning" | "error"): void {
    this.uiOutput.recordSystemMessage?.(text, tone);
  }

  private recordCommandResult(
    command: string,
    text: string,
    tone: "info" | "success" | "warning" | "error" = "info",
  ): void {
    this.uiOutput.recordCommandResult?.(command, text, tone);
  }

  private announceUserInputRequest(request: UserInputRequestRecord): void {
    if (this.announcedUserInputRequestId === request.requestId) {
      return;
    }
    const lines = formatUserInputRequestLines(request);
    this.announcedUserInputRequestId = request.requestId;
    this.recordSystemMessage(lines.join("\n"), "warning");
    this.output(`${lines.join("\n")}\n`);
  }

  private async getCapabilitySnapshot(): Promise<RuntimeCapabilitySnapshot> {
    if (!this.capabilitySnapshot) {
      this.capabilitySnapshot = await this.options.runtime.getRuntimeCapabilities();
    }
    return this.capabilitySnapshot;
  }

  private async syncUiSnapshot(snapshot?: SessionContextSnapshot): Promise<void> {
    if (!this.uiOutput.updateSnapshot) {
      return;
    }
    const capabilities = await this.getCapabilitySnapshot();
    const activeSnapshot =
      snapshot ?? (this.currentSessionId ? await this.inspectSession(this.currentSessionId) : undefined);
    const fallbackSummary = `list:${capabilities.fallbacks.listFiles} | search:${capabilities.fallbacks.searchFiles}`;
    this.uiOutput.updateSnapshot?.({
      cliState: this.state,
      sessionId: activeSnapshot?.session.sessionId ?? this.currentSessionId,
      sessionStatus: activeSnapshot?.session.status,
      routeOverride: this.options.routeOverride,
      routeSummary: activeSnapshot?.lastRoutingSummary ?? (this.options.routeOverride ? `Manual override ${this.options.routeOverride}` : "Automatic routing"),
      fallbackSummary,
      workerSummary: activeSnapshot?.lastWorkerSummary ?? "No worker activity yet.",
      currentToolName: this.currentToolName,
      latestContextBudget: activeSnapshot?.session.latestContextBudget,
      latestTaskDuration: resolveDurationSnapshot(activeSnapshot?.session.latestTaskDuration),
      latestTokenUsage: activeSnapshot?.session.latestTokenUsage,
      cumulativeTokenUsage: activeSnapshot?.session.cumulativeTokenUsage,
      latestCompaction: activeSnapshot?.session.latestCompaction,
    });
  }

  private beginTurnPresentation(): TurnPresentationState {
    if (!this.uiOutput.updateSnapshot) {
      this.output("正在思考…\n");
    }
    return {
      assistantSegmentOpen: false,
    };
  }

  private completeAssistantSegment(presentation: TurnPresentationState): void {
    if (!presentation.assistantSegmentOpen) {
      return;
    }
    presentation.assistantSegmentOpen = false;
    this.uiOutput.completeAssistantMessage?.();
    this.output("\n");
  }

  private recordAssistantDelta(presentation: TurnPresentationState, chunk: string): void {
    this.finishActiveToolGroup();
    if (!presentation.assistantSegmentOpen) {
      presentation.assistantSegmentOpen = true;
      this.uiOutput.startAssistantMessage?.();
    }
    this.uiOutput.appendAssistantText?.(chunk);
    this.output(chunk);
  }

  private beginToolBatch(
    presentation: TurnPresentationState,
    batch: { assistantMessageId: string; toolCalls: ReadonlyArray<{ id: string; name: string }> },
  ): void {
    this.completeAssistantSegment(presentation);
    if (this.activeToolGroup?.batchId !== batch.assistantMessageId) {
      this.finishActiveToolGroup();
      this.activeToolGroup = this.createToolGroup(batch.assistantMessageId);
    }
    for (const toolCall of batch.toolCalls) {
      if (!this.activeToolGroup.entries.some((entry) => entry.callId === toolCall.id)) {
        this.activeToolGroup.entries.push({
          callId: toolCall.id,
          toolName: toolCall.name,
          startedAtMs: Date.now(),
        });
      }
    }
    this.uiOutput.recordToolBatchStart?.(batch.assistantMessageId, batch.toolCalls);
  }

  private recordToolStart(
    presentation: TurnPresentationState,
    toolCall: { id: string; name: string },
  ): void {
    this.completeAssistantSegment(presentation);
    const group = this.activeToolGroup ?? this.createToolGroup();
    this.activeToolGroup = group;
    if (!group.entries.some((entry) => entry.callId === toolCall.id)) {
      group.entries.push({
        callId: toolCall.id,
        toolName: toolCall.name,
        startedAtMs: Date.now(),
      });
    }
    this.currentToolName = toolCall.name;
    this.uiOutput.recordToolStart?.(toolCall.name, toolCall.id);
    void this.syncUiSnapshot();
  }

  private createToolGroup(batchId?: string): CliToolGroupRecord {
    const group: CliToolGroupRecord = {
      sequence: this.nextToolGroupSequence,
      batchId,
      startedAtMs: Date.now(),
      entries: [],
      summarized: false,
    };
    this.nextToolGroupSequence += 1;
    this.toolGroups.push(group);
    if (this.toolGroups.length > 50) {
      this.toolGroups.splice(0, this.toolGroups.length - 50);
    }
    return group;
  }

  private recordToolCompletion(toolResult: ToolResult): void {
    const group = this.activeToolGroup ?? this.createToolGroup();
    this.activeToolGroup = group;
    let entry = group.entries.find((candidate) => candidate.callId === toolResult.callId);
    entry ??= [...group.entries].reverse().find((candidate) => candidate.toolName === toolResult.toolName && !candidate.result);
    if (!entry) {
      entry = {
        callId: toolResult.callId,
        toolName: toolResult.toolName,
        startedAtMs: Number.isFinite(Date.parse(toolResult.startedAt)) ? Date.parse(toolResult.startedAt) : Date.now(),
      };
      group.entries.push(entry);
    }
    entry.result = toolResult;
    const fallback = extractFallbackSummary(toolResult.structuredContent);
    this.uiOutput.recordToolEnd?.(
      toolResult.toolName,
      toolResult.success,
      fallback,
      toolResult.artifacts,
      toolResult,
    );
    this.currentToolName = undefined;
    void this.syncUiSnapshot();
  }

  private finishActiveToolGroup(): void {
    const group = this.activeToolGroup;
    if (!group) {
      return;
    }
    group.endedAtMs ??= Date.now();
    if (!group.summarized) {
      const successCount = group.entries.filter((entry) => entry.result?.success).length;
      const errorCount = group.entries.filter((entry) => entry.result && !entry.result.success).length;
      const pendingCount = group.entries.length - successCount - errorCount;
      const status = [
        `${successCount} 成功`,
        errorCount > 0 ? `${errorCount} 失败` : undefined,
        pendingCount > 0 ? `${pendingCount} 未完成` : undefined,
      ].filter(Boolean).join("，");
      this.output(
        `[工具调用 ${group.sequence}] ${group.entries.length} 项（${status || "无结果"}，${formatDurationMs(group.endedAtMs - group.startedAtMs)}）；输入 /tools ${group.sequence} 查看详情。\n`,
      );
      group.summarized = true;
    }
    this.activeToolGroup = undefined;
  }

  private finishTurnPresentation(presentation: TurnPresentationState, finishTools: boolean): void {
    this.completeAssistantSegment(presentation);
    if (finishTools) {
      this.finishActiveToolGroup();
    }
  }

  private formatToolGroupDetails(group: CliToolGroupRecord): string {
    const lines = [
      `工具调用 ${group.sequence} · ${group.entries.length} 项 · ${formatDurationMs((group.endedAtMs ?? Date.now()) - group.startedAtMs)}`,
    ];
    for (const entry of group.entries) {
      const result = entry.result;
      if (!result) {
        lines.push(`• ${entry.toolName} · 未完成`);
        continue;
      }
      lines.push(`${result.success ? "✓" : "×"} ${entry.toolName} · ${result.success ? "成功" : "失败"}`);
      if (result.error) {
        lines.push(`  error: ${result.error}`);
      }
      if (result.output) {
        lines.push(result.output);
      }
      if (result.structuredContent !== undefined) {
        try {
          const structured = JSON.stringify(result.structuredContent, null, 2);
          if (structured.trim() !== result.output.trim()) {
            lines.push(structured);
          }
        } catch {
          lines.push(String(result.structuredContent));
        }
      }
      lines.push(...formatToolOutputArtifactLines(result.artifacts));
    }
    return lines.join("\n");
  }

  private approvalView(approval: PendingApprovalContext): CliShellApprovalView {
    return {
      sessionId: approval.sessionId,
      approvalId: approval.approvalId,
      toolName: approval.toolName,
      requestKey: approval.requestKey,
      reason: approval.reason,
      actionLabel: approval.presentation?.action ?? actionTypeLabel(approval.permissionCategory),
      riskLabel: riskLabel(approval.permissionCategory, approval.sideEffectLevel),
      presentation: approval.presentation,
    };
  }

  private async handleInput(line: string): Promise<void> {
    const command = parseCommand(line);
    if (!command) {
      this.recordUserEntry(line, "prompt");
      this.uiOutput.setHelpVisible?.(false, HELP_LINES);
      await this.executePrompt(line);
      return;
    }

    this.recordUserEntry(line, "command");
    if (command.name !== "/help") {
      this.uiOutput.setHelpVisible?.(false, HELP_LINES);
    }

    try {
      switch (command.name) {
        case "/help":
          this.renderHelp();
          return;
        case "/exit":
          this.exitRequested = true;
          this.recordCommandResult("/exit", "Exiting Deep-Mix CLI.", "info");
          this.output("Exiting Deep-Mix CLI.\n");
          return;
        case "/resume":
          await this.resumeSession(command.args[0]);
          if (this.pendingApproval) {
            await this.handleApproval();
          }
          return;
        case "/continue":
          await this.continueSession();
          if (this.pendingApproval) {
            await this.handleApproval();
          }
          return;
        case "/undo":
          await this.handleUndo(command.args);
          return;
        case "/session": {
          const result = `Current session: ${this.currentSessionId ?? "none"}`;
          this.recordCommandResult("/session", result, "info");
          this.output(`${result}\n`);
          return;
        }
        case "/status":
          await this.renderStatus();
          return;
        case "/models":
          await this.handleModels(command.args);
          return;
        case "/tools":
          this.renderToolGroup(command.args);
          return;
        case "/processes":
          await this.renderManagedProcesses();
          return;
        case "/stop-process":
          await this.stopManagedProcess(command.args);
          return;
        case "/context":
          await this.renderContext();
          return;
        case "/export":
          await this.exportCurrentSession(command.args.join(" "));
          return;
        default: {
          const result = `Unknown command: ${command.name}`;
          this.recordCommandResult(command.name, result, "warning");
          this.output(`${result}\n`);
          this.renderHelp();
        }
      }
    } catch (error) {
      const message = (error as Error).message;
      this.recordCommandResult(command.name, message, "error");
      this.output(`[state] failed | session ${command.args[0] ?? this.currentSessionId ?? "unknown"}\n`);
      this.output(`${message}\n`);
    }
  }

  private async executePrompt(prompt: string): Promise<void> {
    this.pendingApproval = undefined;
    this.pendingInterrupt = false;
    this.state = "running_turn";
    this.finishActiveToolGroup();
    const presentation = this.beginTurnPresentation();
    await this.syncUiSnapshot();

    try {
      const result = await this.options.runtime.runTurn({
        sessionId: this.currentSessionId,
        prompt,
        routeOverride: this.options.routeOverride,
        callbacks: {
          onSessionSelected: (sessionId) => {
            this.currentSessionId = sessionId;
            this.output(`[state] running_turn | session ${sessionId}\n`);
            void this.syncUiSnapshot();
          },
          onTextDelta: (chunk) => this.recordAssistantDelta(presentation, chunk),
          onToolBatchStart: (batch) => this.beginToolBatch(presentation, batch),
          onToolStart: (toolCall) => this.recordToolStart(presentation, toolCall),
          onToolEnd: (toolResult) => this.recordToolCompletion(toolResult),
          onUserInputRequested: (request) => {
            this.pendingUserInput = request;
          },
        },
      });

      this.currentSessionId = result.sessionId;
      this.pendingUserInput = result.pendingUserInput ?? this.pendingUserInput;
      this.finishTurnPresentation(presentation, true);

      if (this.pendingInterrupt) {
        await this.options.sessionStore.setSessionStatus(result.sessionId, "interrupted");
        this.state = "interrupted";
        this.output(`[state] interrupted | session ${result.sessionId}\n`);
        this.recordSystemMessage("Interrupted. You can type a new prompt, or /resume later if you exit now.", "warning");
        this.output("Interrupted. You can type a new prompt, or /resume later if you exit now.\n");
        await this.syncUiSnapshot();
        return;
      }

      this.state = "idle";
      const snapshot = await this.inspectSession(result.sessionId);
      this.pendingUserInput = this.pendingUserInput ?? snapshot.pendingUserInput;
      this.uiOutput.clearApproval?.();
      this.output(`[state] ${result.session.status} | session ${result.sessionId}\n`);
      await this.syncUiSnapshot(snapshot);
      const completedDuration = resolveDurationSnapshot(snapshot.session.latestTaskDuration);
      if (!this.pendingUserInput && ["waiting_for_user", "completed"].includes(result.session.status)) {
        this.uiOutput.completeTaskPresentation?.(completedDuration?.durationMs);
      }
      if (completedDuration?.durationMs !== undefined) {
        if (!this.hasCollapsibleTaskPresentation) {
          this.recordSystemMessage(`已处理 ${formatDurationMs(completedDuration.durationMs)}`, "info");
          this.output(`已处理 ${formatDurationMs(completedDuration.durationMs)}\n`);
        }
      }
      if (this.pendingUserInput) {
        this.announceUserInputRequest(this.pendingUserInput);
      } else if (result.session.status === "waiting_for_user") {
        if (!this.hasCollapsibleTaskPresentation) {
          this.recordSystemMessage("Ready for the next prompt.", "success");
          this.output("可继续输入。\n");
        }
      }
    } catch (error) {
      this.finishTurnPresentation(presentation, false);
      if (error instanceof PermissionRequiredError) {
        if (!this.currentSessionId) {
          throw error;
        }
        const snapshot = await this.inspectSession(this.currentSessionId);
        this.pendingApproval = snapshot.pendingApproval ?? pendingApprovalFromError(
          this.currentSessionId,
          prompt,
          error,
        );
        this.state = "awaiting_approval";
        this.output(`[state] awaiting_approval | session ${this.currentSessionId}\n`);
        this.uiOutput.showApproval?.(this.approvalView(this.pendingApproval));
        this.recordSystemMessage(`Approval required for ${this.pendingApproval.toolName}.`, "warning");
        await this.syncUiSnapshot(snapshot);
        return;
      }

      if (this.pendingInterrupt && this.currentSessionId) {
        this.finishActiveToolGroup();
        await this.options.sessionStore.setSessionStatus(this.currentSessionId, "interrupted");
        this.state = "interrupted";
        this.output(`[state] interrupted | session ${this.currentSessionId}\n`);
        this.recordSystemMessage("Interrupted. You can type a new prompt, or /resume later if you exit now.", "warning");
        this.output("Interrupted. You can type a new prompt, or /resume later if you exit now.\n");
        await this.syncUiSnapshot();
        return;
      }

      this.finishActiveToolGroup();
      this.state = "idle";
      this.output(`[state] failed | session ${this.currentSessionId ?? "unknown"}\n`);
      this.recordSystemMessage(`Run failed: ${(error as Error).message}`, "error");
      this.output(`Run failed: ${(error as Error).message}\n`);
      await this.syncUiSnapshot();
    }
  }

  private async handleUserInputRequest(): Promise<void> {
    const request = this.pendingUserInput;
    if (!request || this.exitRequested) {
      return;
    }
    if (!this.options.runtime.respondToUserInput) {
      this.pendingUserInput = undefined;
      this.state = "idle";
      const message = "This CLI runtime cannot answer a pending structured user-input request.";
      this.recordSystemMessage(message, "error");
      this.output(`${message}\n`);
      return;
    }

    this.state = "awaiting_user_input";
    await this.syncUiSnapshot();
    this.announceUserInputRequest(request);
    const answers: UserInputAnswer[] = [];

    for (let questionIndex = 0; questionIndex < request.questions.length; questionIndex += 1) {
      const question = request.questions[questionIndex]!;
      while (!this.exitRequested) {
        const promptText = `question ${questionIndex + 1}/${request.questions.length}> `;
        this.setInputContext({
          mode: "question",
          sessionId: request.sessionId,
          promptText,
          placeholder: question.placeholder?.trim() || question.prompt,
          submitHint: "Enter answer  ·  /cancel cancel pending request",
        });
        const response = await this.options.input.read(promptText);
        if (response === undefined) {
          if (!this.exitRequested) {
            this.recordSystemMessage("Safe exit. The pending question remains resumable.", "info");
            this.output("\nSafe exit. The pending question remains resumable.\n");
          }
          this.exitRequested = true;
          return;
        }
        if (response.trim().toLocaleLowerCase() === "/cancel") {
          await this.submitUserInputResponse(request, [], true);
          return;
        }
        try {
          const answer = parseUserInputAnswer(question, response);
          if (answer) {
            answers.push(answer);
          }
          break;
        } catch (error) {
          const message = (error as Error).message;
          this.recordSystemMessage(`Invalid answer: ${message}`, "warning");
          this.output(`Invalid answer: ${message}\n`);
        }
      }
    }

    if (!this.exitRequested) {
      await this.submitUserInputResponse(request, answers, false);
    }
  }

  private async submitUserInputResponse(
    request: UserInputRequestRecord,
    answers: UserInputAnswer[],
    cancel: boolean,
  ): Promise<void> {
    const respondToUserInput = this.options.runtime.respondToUserInput;
    if (!respondToUserInput) {
      throw new Error("Structured user-input responses are not supported by this runtime.");
    }

    this.pendingUserInput = undefined;
    this.announcedUserInputRequestId = undefined;
    this.pendingInterrupt = false;
    this.state = "running_turn";
    const presentation = this.beginTurnPresentation();
    await this.syncUiSnapshot();

    try {
      const result = await respondToUserInput.call(this.options.runtime, {
        sessionId: request.sessionId,
        requestId: request.requestId,
        answers,
        cancel,
        cancelReason: cancel ? "Cancelled explicitly from the CLI." : undefined,
        routeOverride: this.options.routeOverride,
        callbacks: {
          onSessionSelected: (sessionId) => {
            this.currentSessionId = sessionId;
            this.output(`[state] running_turn | session ${sessionId}\n`);
            void this.syncUiSnapshot();
          },
          onTextDelta: (chunk) => this.recordAssistantDelta(presentation, chunk),
          onToolBatchStart: (batch) => this.beginToolBatch(presentation, batch),
          onToolStart: (toolCall) => this.recordToolStart(presentation, toolCall),
          onToolEnd: (toolResult) => this.recordToolCompletion(toolResult),
          onUserInputRequested: (nextRequest) => {
            this.pendingUserInput = nextRequest;
          },
        },
      });

      this.currentSessionId = result.sessionId;
      this.finishTurnPresentation(presentation, true);
      const snapshot = await this.inspectSession(result.sessionId);
      this.pendingUserInput = result.pendingUserInput ?? snapshot.pendingUserInput ?? this.pendingUserInput;
      this.state = "idle";
      this.output(`[state] ${result.session.status} | session ${result.sessionId}\n`);
      await this.syncUiSnapshot(snapshot);
      const completedDuration = resolveDurationSnapshot(snapshot.session.latestTaskDuration);
      if (!this.pendingUserInput && ["waiting_for_user", "completed"].includes(result.session.status)) {
        this.uiOutput.completeTaskPresentation?.(completedDuration?.durationMs);
      }
      if (cancel) {
        if (!this.hasCollapsibleTaskPresentation) {
          this.recordSystemMessage("Pending question cancelled.", "info");
          this.output("Pending question cancelled.\n");
        }
      } else if (this.pendingUserInput) {
        this.announceUserInputRequest(this.pendingUserInput);
      } else {
        if (!this.hasCollapsibleTaskPresentation) {
          this.recordSystemMessage("Answer recorded; the original turn resumed.", "success");
          this.output("Answer recorded; the original turn resumed.\n");
        }
      }
    } catch (error) {
      this.finishTurnPresentation(presentation, false);
      if (error instanceof PermissionRequiredError) {
        const snapshot = await this.inspectSession(request.sessionId);
        this.pendingApproval = snapshot.pendingApproval;
        this.pendingUserInput = snapshot.pendingUserInput;
        this.state = "awaiting_approval";
        if (this.pendingApproval) {
          this.uiOutput.showApproval?.(this.approvalView(this.pendingApproval));
          this.recordSystemMessage(`Approval required for ${this.pendingApproval.toolName}.`, "warning");
        }
        await this.syncUiSnapshot(snapshot);
        return;
      }

      const snapshot = await this.inspectSession(request.sessionId).catch(() => undefined);
      this.finishActiveToolGroup();
      this.pendingUserInput = snapshot?.pendingUserInput;
      this.state = "idle";
      const message = `Failed to submit answer: ${(error as Error).message}`;
      this.recordSystemMessage(message, "error");
      this.output(`${message}\n`);
      await this.syncUiSnapshot(snapshot);
    }
  }

  private async handleApproval(): Promise<void> {
    if (!this.pendingApproval) {
      return;
    }

    const approval = this.pendingApproval;
    this.uiOutput.showApproval?.(this.approvalView(approval));
    this.setInputContext({
      mode: "approval",
      sessionId: approval.sessionId,
      promptText: "approval [1=allow once, 2=allow session, 3=deny]> ",
      placeholder: "Press 1, 2, or 3.",
      submitHint: "1 once  2 session  3 deny",
    });
    await this.syncUiSnapshot();
    this.output("Approval required:\n");
    this.output(`  tool: ${approval.toolName}\n`);
    this.output(`  action: ${approval.presentation?.action ?? actionTypeLabel(approval.permissionCategory)}\n`);
    this.output(`  requestKey: ${approval.requestKey}\n`);
    this.output(`  risk: ${riskLabel(approval.permissionCategory, approval.sideEffectLevel)}\n`);
    for (const detail of formatApprovalPresentationLines(approval.presentation)) {
      this.output(`  ${detail}\n`);
    }
    this.output("  suggested: allow once\n");

    while (!this.exitRequested) {
      const response = await this.options.input.read("approval [1=allow once, 2=allow session, 3=deny]> ");
      if (response === undefined) {
        if (!this.exitRequested) {
          this.output("\nSafe exit. Use /resume to continue later.\n");
          this.recordSystemMessage("Safe exit. Use /resume to continue later.", "info");
        }
        this.exitRequested = true;
        return;
      }

      const persistence = parseApprovalChoice(response);
      if (!persistence) {
        this.recordSystemMessage("Invalid approval choice. Use 1, 2, or 3.", "warning");
        this.output("Invalid approval choice. Use 1, 2, or 3.\n");
        continue;
      }

      await this.options.runtime.resolveApprovalRequest({
        sessionId: approval.sessionId,
        approvalId: approval.approvalId,
        toolName: approval.toolName,
        requestKey: approval.requestKey,
        persistence,
        reason: approval.reason,
      });
      this.recordSystemMessage(`[approval] ${persistence.replace("_", " ")} recorded.`, "success");
      this.output(`[approval] ${persistence.replace("_", " ")} recorded. Continuing the pending task.\n`);
      this.pendingApproval = undefined;
      this.uiOutput.clearApproval?.();
      const presentation = this.beginTurnPresentation();
      try {
        this.pendingInterrupt = false;
        this.state = "running_turn";
        await this.syncUiSnapshot();
        const result = await this.options.runtime.continuePendingTurn({
          sessionId: approval.sessionId,
          callbacks: {
            onSessionSelected: (sessionId) => {
              this.currentSessionId = sessionId;
              this.output(`[state] running_turn | session ${sessionId}\n`);
              void this.syncUiSnapshot();
            },
            onTextDelta: (chunk) => this.recordAssistantDelta(presentation, chunk),
            onToolBatchStart: (batch) => this.beginToolBatch(presentation, batch),
            onToolStart: (toolCall) => this.recordToolStart(presentation, toolCall),
            onToolEnd: (toolResult) => this.recordToolCompletion(toolResult),
            onUserInputRequested: (request) => {
              this.pendingUserInput = request;
            },
          },
          routeOverride: this.options.routeOverride,
        });
        this.state = "idle";
        this.finishTurnPresentation(presentation, true);
        const snapshot = await this.inspectSession(result.sessionId);
        this.pendingUserInput = result.pendingUserInput ?? snapshot.pendingUserInput ?? this.pendingUserInput;
        this.uiOutput.clearApproval?.();
        this.output(`\n[state] ${result.session.status} | session ${result.sessionId}\n`);
        await this.syncUiSnapshot(snapshot);
        const completedDuration = resolveDurationSnapshot(snapshot.session.latestTaskDuration);
        if (!this.pendingUserInput && ["waiting_for_user", "completed"].includes(result.session.status)) {
          this.uiOutput.completeTaskPresentation?.(completedDuration?.durationMs);
        }
        if (completedDuration?.durationMs !== undefined) {
          if (!this.hasCollapsibleTaskPresentation) {
            this.recordSystemMessage(`已处理 ${formatDurationMs(completedDuration.durationMs)}`, "info");
            this.output(`已处理 ${formatDurationMs(completedDuration.durationMs)}\n`);
          }
        }
        if (this.pendingUserInput) {
          this.announceUserInputRequest(this.pendingUserInput);
        } else if (result.session.status === "waiting_for_user") {
          if (!this.hasCollapsibleTaskPresentation) {
            this.recordSystemMessage("Ready for the next prompt.", "success");
            this.output("可继续输入。\n");
          }
        }
        return;
      } catch (error) {
        this.finishTurnPresentation(presentation, false);
        if (error instanceof PermissionRequiredError) {
          const snapshot = await this.inspectSession(approval.sessionId);
          this.pendingApproval = snapshot.pendingApproval;
          this.state = "awaiting_approval";
          this.output(`\n[state] awaiting_approval | session ${approval.sessionId}\n`);
          if (this.pendingApproval) {
            this.uiOutput.showApproval?.(this.approvalView(this.pendingApproval));
          }
          this.recordSystemMessage(`Approval required for ${approval.toolName}.`, "warning");
          await this.syncUiSnapshot(snapshot);
          return;
        }
        this.finishActiveToolGroup();
        this.state = "idle";
        this.output(`\n[state] failed | session ${approval.sessionId}\n`);
        this.recordSystemMessage(`Run failed: ${(error as Error).message}`, "error");
        this.output(`Run failed: ${(error as Error).message}\n`);
        await this.syncUiSnapshot();
        return;
      }
    }
  }

  private async resumeSession(sessionId?: string): Promise<void> {
    const session = await this.options.runtime.resolveResumeTarget(sessionId);
    this.currentSessionId = session.sessionId;
    const snapshot = await this.inspectSession(session.sessionId);
    await this.renderResumedSession(snapshot, "resume");
  }

  private async continueSession(): Promise<void> {
    if (!this.currentSessionId) {
      const session = await this.options.runtime.resolveResumeTarget();
      this.currentSessionId = session.sessionId;
    }
    const snapshot = await this.inspectSession(this.currentSessionId);
    await this.renderResumedSession(snapshot, "continue");
  }

  private async renderResumedSession(snapshot: SessionContextSnapshot, source: "resume" | "continue"): Promise<void> {
    const action = source === "resume" ? "Resumed" : "Continued";
    const commandResult = `${action} session: ${snapshot.session.sessionId}\nStatus: ${snapshot.session.status}`;
    this.recordCommandResult(`/${source}`, commandResult, "success");
    this.output(`${action} session: ${snapshot.session.sessionId}\n`);
    this.output(`[state] ${snapshot.session.status} | session ${snapshot.session.sessionId}\n`);
    this.recordSystemMessage(
      `${source === "resume" ? "Resumed" : "Continued"} session ${shortSessionId(snapshot.session.sessionId)}.`,
      "info",
    );
    if (snapshot.lastHistoryIntegrity?.scope === "resume_check" && snapshot.lastHistoryIntegrity.outcome !== "clean") {
      this.recordSystemMessage(`History check: ${snapshot.lastHistoryIntegrity.summary}`, "warning");
      this.output(`History check: ${snapshot.lastHistoryIntegrity.summary}\n`);
    }
    if (snapshot.pendingApproval) {
      this.pendingApproval = snapshot.pendingApproval;
      this.state = "awaiting_approval";
      this.uiOutput.showApproval?.(this.approvalView(snapshot.pendingApproval));
      await this.syncUiSnapshot(snapshot);
      this.setInputContext({
        mode: "approval",
        sessionId: snapshot.pendingApproval.sessionId,
        promptText: "approval [1=allow once, 2=allow session, 3=deny]> ",
        placeholder: "Press 1, 2, or 3.",
        submitHint: "1 once  2 session  3 deny",
      });
      this.recordSystemMessage("The session is waiting for approval.", "warning");
      this.output("The session is waiting for approval.\n");
      return;
    }

    if (snapshot.pendingUserInput) {
      this.pendingUserInput = snapshot.pendingUserInput;
      this.state = "awaiting_user_input";
      await this.syncUiSnapshot(snapshot);
      this.announceUserInputRequest(snapshot.pendingUserInput);
      return;
    }

    this.pendingUserInput = undefined;

    if (snapshot.session.status === "failed") {
      this.recordSystemMessage(`Last failure: ${snapshot.lastTurn?.error ?? "unknown"}`, "error");
      this.output(`Last failure: ${snapshot.lastTurn?.error ?? "unknown"}\n`);
    } else if (snapshot.session.status === "interrupted") {
      this.recordSystemMessage("The last turn was interrupted. You can continue with a new prompt.", "warning");
      this.output("The last turn was interrupted. You can continue with a new prompt.\n");
    } else if (snapshot.session.status === "waiting_for_user") {
      this.recordSystemMessage("The session is ready for the next prompt.", "success");
      this.output("The session is ready for the next prompt.\n");
    }
    this.state = "idle";
    await this.syncUiSnapshot(snapshot);
  }

  private async handleUndo(args: string[]): Promise<void> {
    let sessionId = this.currentSessionId;
    if (!sessionId) {
      sessionId = (await this.options.runtime.resolveResumeTarget()).sessionId;
      this.currentSessionId = sessionId;
    }
    const checkpointId = args[0];
    const mode = args[1] as "conversation" | "code" | "both" | undefined;
    const result = await this.options.runtime.getSupervisorReviewService().undo({
      sessionId,
      checkpointId,
      mode,
    });
    const tone = result.success ? "success" : "error";
    this.recordCommandResult("/undo", result.output, tone);
    this.output(`${result.output}\n`);
    await this.syncUiSnapshot();
  }

  private renderToolGroup(args: string[]): void {
    const requested = args[0]?.trim().toLowerCase();
    const sequence = requested && requested !== "latest" ? Number.parseInt(requested, 10) : undefined;
    if (requested && requested !== "latest" && (!Number.isInteger(sequence) || (sequence ?? 0) <= 0)) {
      throw new Error("Usage: /tools [positive group number | latest]");
    }

    const toggle = this.uiOutput.toggleToolDetails?.(sequence);
    if (toggle) {
      const label = toggle.sequence === 0 ? "处理过程" : `工具调用 ${toggle.sequence}`;
      const text = `${label}已${toggle.expanded ? "展开" : "收起"}。`;
      this.recordCommandResult("/tools", text, "info");
      this.output(`${text}\n`);
      return;
    }

    const group = sequence === undefined
      ? this.toolGroups.at(-1)
      : this.toolGroups.find((candidate) => candidate.sequence === sequence);
    if (!group) {
      throw new Error(sequence === undefined ? "No tool groups are available." : `Tool group ${sequence} was not found.`);
    }
    const details = this.formatToolGroupDetails(group);
    this.recordCommandResult("/tools", details, "info");
    this.output(`${details}\n`);
  }

  private async renderManagedProcesses(): Promise<void> {
    if (!this.currentSessionId) {
      const result = "No active session. Start or resume a session before listing managed processes.";
      this.recordCommandResult("/processes", result, "warning");
      this.output(`${result}\n`);
      return;
    }
    if (!this.options.runtime.listManagedProcesses) {
      throw new Error("Managed process inspection is unavailable in this runtime.");
    }

    const processes = await this.options.runtime.listManagedProcesses(this.currentSessionId);
    if (processes.length === 0) {
      const result = `No managed processes belong to session ${this.currentSessionId}.`;
      this.recordCommandResult("/processes", result, "info");
      this.output(`${result}\n`);
      return;
    }

    const lines = [`Managed processes for session ${this.currentSessionId}:`];
    for (const process of processes) {
      const endedAtMs = process.endedAt ? new Date(process.endedAt).getTime() : Date.now();
      const startedAtMs = new Date(process.startedAt).getTime();
      const elapsedMs = Number.isFinite(startedAtMs) && Number.isFinite(endedAtMs)
        ? Math.max(0, endedAtMs - startedAtMs)
        : undefined;
      lines.push(
        `${sanitizeArtifactDisplayValue(process.processSessionId)} | ${process.status} | ${formatDurationMs(elapsedMs)} | ${sanitizeArtifactDisplayValue(process.commandSummary)}`,
      );
    }
    const result = lines.join("\n");
    this.recordCommandResult("/processes", result, "info");
    this.output(`${result}\n`);
  }

  private async stopManagedProcess(args: string[]): Promise<void> {
    if (args.length !== 1 || !args[0]?.trim()) {
      const result = "Usage: /stop-process <process-session-id>";
      this.recordCommandResult("/stop-process", result, "warning");
      this.output(`${result}\n`);
      return;
    }
    if (!this.currentSessionId) {
      const result = "No active session. Start or resume a session before stopping a managed process.";
      this.recordCommandResult("/stop-process", result, "warning");
      this.output(`${result}\n`);
      return;
    }
    if (!this.options.runtime.stopManagedProcess) {
      throw new Error("Managed process control is unavailable in this runtime.");
    }

    const sessionId = this.currentSessionId;
    const processSessionId = args[0].trim();
    let result: ToolResult;
    try {
      result = await this.options.runtime.stopManagedProcess(sessionId, processSessionId);
    } catch (error) {
      if (!(error instanceof PermissionRequiredError)) {
        throw error;
      }
      const approval = pendingApprovalFromError(
        sessionId,
        `/stop-process ${processSessionId}`,
        error,
      );
      const persistence = await this.resolveDirectToolApproval(approval);
      if (!persistence || persistence === "deny") {
        const denied = persistence === "deny"
          ? `Stop denied; managed process ${processSessionId} was not stopped.`
          : `Stop cancelled; managed process ${processSessionId} was not stopped.`;
        this.recordCommandResult("/stop-process", denied, "warning");
        this.output(`${denied}\n`);
        return;
      }
      result = await this.options.runtime.stopManagedProcess(sessionId, processSessionId);
    }

    const structured = result.structuredContent && typeof result.structuredContent === "object"
      ? result.structuredContent as { outcome?: string; status?: string }
      : undefined;
    const message = result.success
      ? `Managed process ${processSessionId}: ${structured?.outcome ?? "stop requested"} (${structured?.status ?? "status unavailable"}).`
      : `Failed to stop managed process ${processSessionId}: ${result.error ?? result.output}`;
    this.recordCommandResult("/stop-process", message, result.success ? "success" : "error");
    this.output(`${message}\n`);
    await this.syncUiSnapshot();
  }

  private async resolveDirectToolApproval(
    approval: PendingApprovalContext,
  ): Promise<Extract<ApprovalPersistence, "allow_once" | "allow_session" | "deny"> | undefined> {
    this.pendingApproval = approval;
    this.state = "awaiting_approval";
    this.uiOutput.showApproval?.(this.approvalView(approval));
    this.setInputContext({
      mode: "approval",
      sessionId: approval.sessionId,
      promptText: "approval [1=allow once, 2=allow session, 3=deny]> ",
      placeholder: "Press 1, 2, or 3.",
      submitHint: "1 once  2 session  3 deny",
    });
    await this.syncUiSnapshot();
    this.output("Approval required:\n");
    this.output(`  tool: ${approval.toolName}\n`);
    this.output(`  action: ${approval.presentation?.action ?? actionTypeLabel(approval.permissionCategory)}\n`);
    this.output(`  requestKey: ${approval.requestKey}\n`);
    this.output(`  risk: ${riskLabel(approval.permissionCategory, approval.sideEffectLevel)}\n`);
    for (const detail of formatApprovalPresentationLines(approval.presentation)) {
      this.output(`  ${detail}\n`);
    }
    this.output("  suggested: allow once\n");

    while (!this.exitRequested) {
      const response = await this.options.input.read("approval [1=allow once, 2=allow session, 3=deny]> ");
      if (response === undefined) {
        this.exitRequested = true;
        this.pendingApproval = undefined;
        this.uiOutput.clearApproval?.();
        return undefined;
      }
      const persistence = parseApprovalChoice(response);
      if (!persistence) {
        this.output("Invalid approval choice. Use 1, 2, or 3.\n");
        continue;
      }
      await this.options.runtime.resolveApprovalRequest({
        sessionId: approval.sessionId,
        approvalId: approval.approvalId,
        toolName: approval.toolName,
        requestKey: approval.requestKey,
        persistence,
        reason: approval.reason,
      });
      this.pendingApproval = undefined;
      this.state = "idle";
      this.uiOutput.clearApproval?.();
      this.output(`[approval] ${persistence.replace("_", " ")} recorded.\n`);
      return persistence;
    }
    return undefined;
  }

  private async renderStatus(): Promise<void> {
    const capabilities = await this.getCapabilitySnapshot();
    const capabilityLine = `Runtime tools: ${["rg", "git", "powershell", "node", "npm"]
      .map((name) => describeCapability(capabilities, name as keyof RuntimeCapabilitySnapshot["capabilities"]))
      .join(" | ")}`;
    if (!this.currentSessionId) {
      const result = ["Current session: none", `CLI state: ${this.state}`, capabilityLine].join("\n");
      this.recordCommandResult("/status", result, "info");
      this.output(`${result}\n`);
      return;
    }

    const snapshot = await this.inspectSession(this.currentSessionId);
    const lines = [
      `Current session: ${snapshot.session.sessionId}`,
      `Session status: ${snapshot.session.status}`,
      `CLI state: ${this.state}`,
    ];
    if (snapshot.lastTurn?.requestSummary) {
      lines.push(`Last request: ${snapshot.lastTurn.requestSummary}`);
    }
    if (snapshot.lastTurn?.error) {
      lines.push(`Last error: ${snapshot.lastTurn.error}`);
    }
    if (snapshot.pendingApproval) {
      lines.push(`Pending approval: ${snapshot.pendingApproval.toolName}`);
    }
    if (snapshot.pendingUserInput) {
      lines.push(`Pending question: ${snapshot.pendingUserInput.title ?? snapshot.pendingUserInput.requestId}`);
    }
    if (snapshot.lastRoutingSummary) {
      lines.push(`Last route: ${snapshot.lastRoutingSummary}`);
    }
    if (snapshot.lastWorkerSummary) {
      lines.push(`Worker summary: ${snapshot.lastWorkerSummary}`);
    }
    if (snapshot.session.latestTaskDuration) {
      const duration = resolveDurationSnapshot(snapshot.session.latestTaskDuration);
      lines.push(`Task duration: ${formatDurationMs(duration?.durationMs)}`);
    }
    lines.push(`Fallback chain: list=${capabilities.fallbacks.listFiles} | search=${capabilities.fallbacks.searchFiles}`);
    lines.push(capabilityLine);
    const result = lines.join("\n");
    this.recordCommandResult("/status", result, "info");
    this.output(`${result}\n`);
    await this.syncUiSnapshot(snapshot);
  }

  private async handleModels(args: string[]): Promise<void> {
    const action = args[0]?.toLowerCase();
    if (!action) {
      const report = await readProfileStatus(this.options.workspaceRoot);
      const lines = [`Preset: ${report.preset ?? "classic"} | revision=${report.revision ?? 0}`];
      for (const slot of ["governor", "coding", "vision"] as const) {
        const state = report.slots?.[slot];
        if (!state) continue;
        const capability = state.primary.status.capabilities;
        lines.push([
          `${slot}: ${state.primary.profileId}`,
          state.primary.model ?? state.primary.status.model ?? "model-unavailable",
          state.primary.status.hasKey ? "credential=ready" : "credential=missing",
          `adapter=${state.primary.status.adapterId ?? "missing"}`,
          `caps=${capability ? `text:${capability.textInput},image:${capability.imageInput},stream:${capability.streaming},tools:${capability.nativeToolCalling},structured:${capability.structuredOutput}` : "unknown"}`,
          `fallbacks=${state.fallbackEnabled ? state.fallbacks.map((entry) => entry.profileId).join(",") || "none" : "disabled"}`,
        ].join(" | "));
      }
      const result = lines.join("\n");
      this.recordCommandResult("/models", result, "info");
      this.output(`${result}\n`);
      return;
    }
    if (action === "classic") {
      const result = await saveCliModelBinding(this.options.workspaceRoot, { classic: true });
      const reloadMessage = await this.reloadRuntimeAfterModelChange();
      const message = reloadMessage ? `${result} ${reloadMessage}` : result;
      this.recordCommandResult("/models classic", message, "success");
      this.output(`${message}\n`);
      return;
    }
    if (action === "test") {
      const profileId = args[1];
      if (!profileId) throw new Error("Usage: /models test <profile>");
      const service = new ProfileService(this.options.workspaceRoot);
      const profile = service.listPublicProfiles().find((entry) => entry.profileId === profileId);
      if (!profile) throw new Error(`Unknown profile: ${profileId}`);
      if (!profile.hasCredential) {
        const skipped = `Probe skipped: ${profileId} has no configured credential.`;
        this.recordCommandResult("/models test", skipped, "warning");
        this.output(`${skipped}\n`);
        return;
      }
      const probe = await service.probe(profileId, createDefaultModelAdapterRegistry());
      const result = `${profileId}: ok=${probe.ok} adapter=${probe.adapterId} latency=${probe.latencyMs}ms${probe.redactedError ? ` error=${probe.redactedError}` : ""}`;
      this.recordCommandResult("/models test", result, probe.ok ? "success" : "error");
      this.output(`${result}\n`);
      return;
    }
    if (action === "set") {
      const slot = args[1] as ModelSlotId | undefined;
      if (slot !== "governor" && slot !== "coding" && slot !== "vision") throw new Error("Model slot must be governor, coding, or vision.");
      const profileId = args[2];
      const fallbacks = args[3] && !args[3].startsWith("model=") ? args[3].split(",").map((entry) => entry.trim()).filter(Boolean) : [];
      const modelToken = args.find((entry) => entry.startsWith("model="));
      const result = await saveCliModelBinding(this.options.workspaceRoot, {
        slot,
        profileId,
        fallbacks,
        model: modelToken?.slice("model=".length),
      });
      const reloadMessage = await this.reloadRuntimeAfterModelChange();
      const message = reloadMessage ? `${result} ${reloadMessage}` : result;
      this.recordCommandResult("/models set", message, "success");
      this.output(`${message}\n`);
      return;
    }
    throw new Error("Usage: /models | /models set <slot> <profile> [fallbacks] [model=name] | /models test <profile> | /models classic");
  }

  private async reloadRuntimeAfterModelChange(): Promise<string | undefined> {
    if (!this.options.reloadRuntime) {
      return undefined;
    }
    this.options.runtime = await this.options.reloadRuntime();
    this.capabilitySnapshot = undefined;
    await this.renderHeader();
    await this.syncUiSnapshot();
    return "The new bindings apply to subsequent Provider cycles and worker dispatches.";
  }

  private async renderContext(): Promise<void> {
    if (!this.currentSessionId) {
      const result = "No active session. Start or resume a session before checking context.";
      this.recordCommandResult("/context", result, "warning");
      this.output(`${result}\n`);
      return;
    }

    const snapshot = await this.inspectSession(this.currentSessionId);
    const budget = snapshot.session.latestContextBudget;
    const latestUsage = snapshot.session.latestTokenUsage;
    const cumulativeUsage = snapshot.session.cumulativeTokenUsage;
    const compaction = snapshot.session.latestCompaction;
    const duration = resolveDurationSnapshot(snapshot.session.latestTaskDuration);

    const lines = [
      `Session: ${snapshot.session.sessionId}`,
      `Model: ${budget?.model ?? "unavailable"} | context window: ${formatTokenCount(budget?.contextWindowTokens)}`,
      `Current request: ${formatTokenCount(budget?.usedInputTokens)} / ${formatTokenCount(budget?.inputBudgetTokens)} used (${
        budget?.usagePercent?.toFixed(1) ?? "unavailable"
      }%) | remaining ${formatTokenCount(budget?.remainingInputTokens)} | ${formatUsageSource(budget?.source)}`,
      `Last model call: input ${formatTokenCount(latestUsage?.inputTokens)} | output ${formatTokenCount(latestUsage?.outputTokens)} | reasoning ${formatTokenCount(latestUsage?.reasoningTokens)} | ${formatUsageSource(latestUsage?.source)}\n`,
      `Session total: input ${formatTokenCount(cumulativeUsage?.inputTokens)} | output ${formatTokenCount(cumulativeUsage?.outputTokens)} | reasoning ${formatTokenCount(cumulativeUsage?.reasoningTokens)} | ${formatUsageSource(cumulativeUsage?.source)}\n`,
    ];
    if (budget) {
      const categoryLine = budget.categories
        .filter((category) => category.key !== "free")
        .map((category) => `${category.label} ${formatTokenCount(category.estimatedTokens)}`)
        .join(" | ");
      lines.push(`Categories: ${categoryLine}`);
      if (budget.toolOutputExposure) {
        lines.push(
          `Tool outputs: raw ${budget.toolOutputExposure.rawMessageCount} | giant summarized ${budget.toolOutputExposure.summarizedMessageCount} | budget-truncated ${budget.toolOutputExposure.budgetTruncatedMessageCount}`,
        );
      }
    }
    if (compaction) {
      lines.push(
        `Compaction: ${compaction.triggered ? "yes" : "no"} | saved ${formatTokenCount(compaction.tokensSaved)} | retained ${compaction.retained.join("; ") || "none"}`,
      );
    }
    if (duration) {
      lines.push(`Duration: ${formatDurationMs(duration.durationMs)} | status ${duration.status}`);
    }
    const result = lines.map((line) => line.trimEnd()).join("\n");
    this.recordCommandResult("/context", result, "info");
    this.output(`${result}\n`);
    await this.syncUiSnapshot(snapshot);
  }

  private async exportCurrentSession(outputPathArg?: string): Promise<void> {
    if (!this.options.sessionStore.exportSessionMarkdown) {
      this.recordCommandResult("/export", "Session export is not available in the current runtime.", "error");
      this.output("Session export is not available in the current runtime.\n");
      return;
    }

    if (!this.currentSessionId) {
      try {
        const session = await this.options.runtime.resolveResumeTarget();
        this.currentSessionId = session.sessionId;
      } catch {
        this.recordCommandResult("/export", "No current session to export.", "warning");
        this.recordSystemMessage("No current session to export.", "warning");
        this.output("No current session to export.\n");
        return;
      }
    }

    const exported = await this.options.sessionStore.exportSessionMarkdown({
      sessionId: this.currentSessionId,
      outputPath: outputPathArg?.trim() || undefined,
    });
    this.recordCommandResult("/export", `Session exported to: ${exported.outputPath}`, "success");
    this.recordSystemMessage(`Session exported to ${exported.outputPath}`, "success");
    this.output(`Exported current session to: ${exported.outputPath}\n`);
  }

  private renderHelp(): void {
    this.recordCommandResult("/help", HELP_LINES.join("\n"), "info");
    this.recordSystemMessage("Help opened. Use Ctrl+G or keep typing to dismiss it.", "info");
    this.output(`${HELP_LINES.join("\n")}\n`);
  }

  private async renderHeader(): Promise<void> {
    const profiles = await this.options.getProfileStatus();
    const capabilities = await this.getCapabilitySnapshot();
    this.uiOutput.setHeader?.({
      version: versionString(),
      workspaceRoot: this.options.workspaceRoot,
      permissionMode: this.options.permissionMode,
      routeOverride: this.options.routeOverride,
      profiles,
      capabilities,
    });
    this.output(`Deep-Mix v${versionString()}\n`);
    this.output(`workspace: ${this.options.workspaceRoot}\n`);
    this.output(`mode: ${this.options.permissionMode}\n`);
    const describeSlot = (slot: ModelSlotId): string => {
      const state = profiles.slots?.[slot];
      if (!state) {
        const legacy = slot === "governor"
          ? profiles.deepseek_governor
          : slot === "coding"
            ? profiles.glm_coding_worker
            : profiles.kimi_vision;
        return describeProfile(legacy);
      }
      return `${state.primary.profileId}/${state.primary.model ?? state.primary.status.model ?? "model-unavailable"}:${describeProfile(state.primary.status)}`;
    };
    this.output(`models: governor=${describeSlot("governor")} | coding=${describeSlot("coding")} | vision=${describeSlot("vision")}\n`);
    this.output(
      `runtime: ${["rg", "git", "powershell", "node", "npm"].map((name) => describeCapability(capabilities, name as keyof RuntimeCapabilitySnapshot["capabilities"])).join(" | ")}\n`,
    );
    if (!capabilities.capabilities.rg.available) {
      this.output("startup note: rg missing, list_files/search_files will use the built-in fallback chain.\n");
    }
    this.output("commands: /help /resume /continue /export /context /undo /status /models /tools /processes /stop-process /session /exit\n");
  }

  private async inspectSession(sessionId: string): Promise<SessionContextSnapshot> {
    const session = await this.options.sessionStore.loadSession(sessionId);
    if (!session) {
      throw new Error(`Unknown session: ${sessionId}`);
    }
    const events = await this.options.sessionStore.loadEvents(sessionId);
    const lastTurn = findLastTurn(events);
    const pendingApprovalRecord = findPendingApproval(events);
    const pendingUserInput = findPendingUserInput(events);
    const lastRoutingDecision = findLatestRoutingDecision(events);
    const latestWorkerLink = findLatestWorkerSessionLink(events);
    const pendingApproval =
      pendingApprovalRecord && lastTurn
        ? {
            sessionId,
            prompt: lastTurn.requestSummary,
            approvalId: pendingApprovalRecord.approvalId,
            toolName: pendingApprovalRecord.toolName,
            requestKey: pendingApprovalRecord.requestKey,
            reason: pendingApprovalRecord.reason,
            permissionCategory: pendingApprovalRecord.permissionCategory,
            sideEffectLevel: pendingApprovalRecord.sideEffectLevel,
            presentation: pendingApprovalRecord.presentation,
          }
        : undefined;
    let lastWorkerSummary: string | undefined;
    if (latestWorkerLink) {
      const workerSession = await this.options.sessionStore.loadWorkerSession?.(latestWorkerLink.workerSessionId);
      const workerEvents = await this.options.sessionStore.loadWorkerEvents?.(latestWorkerLink.workerSessionId);
      const latestWorkerStatus = workerEvents ? [...workerEvents].reverse().find(isWorkerStatusEvent) : undefined;
      const summaryParts: string[] = [
        latestWorkerLink.workerType,
        latestWorkerStatus?.status ?? workerSession?.status ?? latestWorkerLink.status,
      ];
      if (workerSession?.lastErrorMessage) {
        summaryParts.push(workerSession.lastErrorMessage);
      }
      lastWorkerSummary = summaryParts.join(" | ");
    }
    return {
      session,
      lastTurn,
      pendingApproval,
      pendingUserInput,
      lastHistoryIntegrity: findLatestHistoryIntegrity(events, "resume_check"),
      lastRoutingSummary: lastRoutingDecision?.reasonSummary,
      lastWorkerSummary,
    };
  }

  private output(text: string): void {
    this.options.output.write(text);
  }
}
