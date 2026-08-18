export type RouteRole = "governor" | "coding_worker" | "vision_worker";
export type ModelSlotId = "governor" | "coding" | "vision";
export type SemanticRouteTarget = "governor_direct" | "coding_worker" | "vision_worker";
export type LegacyRouteTarget = "ds_direct" | "glm_coding" | "kimi_vision";
/** Read boundary accepting legacy aliases. Routing decisions and new writes use SemanticRouteTarget. */
export type RouteTarget = SemanticRouteTarget | LegacyRouteTarget;
export type RouteTargetInput = RouteTarget;
export type ModelFallbackTrigger =
  | "configuration"
  | "capability"
  | "connection"
  | "rate_limit"
  | "timeout"
  | "provider_error"
  | "invalid_response";
export type ModelNonReplayableReason =
  | "user_cancelled"
  | "permission_denied"
  | "visible_stream_started"
  | "tool_side_effect"
  | "artifact_published"
  | "invalid_input";
export type ModelSelectionReason = "primary" | "ordered_fallback" | "classic_preset" | "legacy_migration" | "environment_override";
export type ToolCallingMode = "disabled" | "runtime_mediated" | "provider_native";
export type ThinkingModeType = "disabled" | "enabled" | "adaptive";
export type ReasoningEffort = "not_applicable" | "low" | "medium" | "high";
export type ReplyStyle = "friendly" | "pragmatic";
export type WorkerType = "coding" | "vision" | "review" | "research";
export type WorkerArtifactKind = "code_artifact" | "vision_artifact" | "review_artifact" | "research_artifact";
export type WorkerSessionStatus = "queued" | "running" | "completed" | "failed" | "cancelled";
export type WorkerDispatchKind = "initial" | "retry" | "revise";
export type WorkerFailureType =
  | "configuration_error"
  | "input_validation_failed"
  | "model_call_failed"
  | "call_timeout"
  | "response_parse_failed"
  | "artifact_validation_failed"
  | "worker_interrupted";
export type VisionTaskType = "ocr_extract" | "ui_parse" | "error_screenshot" | "diagram_parse";
export type VisionImageSourceType = "local_path" | "uploaded_file" | "browser_capture";
export type VisionImageInputMode = "base64_data_url" | "file_id";
export type SessionStatus =
  | "pending"
  | "running"
  | "waiting_for_user"
  | "ask_permission"
  | "completed"
  | "failed"
  | "interrupted";
export type PlanStatus = "pending" | "in_progress" | "completed" | "blocked";
export type PermissionMode = "plan" | "edit" | "auto" | "danger-full-access";
export type ToolExecutionOrigin = "direct" | "runtime_post_edit_verification";
export type PermissionDecision = "allow" | "ask" | "deny";
export type ToolPermissionCategory =
  | "read_only"
  | "write_file"
  | "execute_command"
  | "run_tests"
  | "external_system"
  | "external_mcp"
  | "mcp_read_only"
  | "mcp_side_effectful";
export type ApprovalPersistence = "mode_default" | "allow_once" | "allow_session" | "deny";
export type ApprovalStatus = "pending" | "resolved";
export type SideEffectLevel = "none" | "low" | "medium" | "high";
export type TimeoutCategory = "fast" | "default" | "slow";
export type MessageRole = "system" | "user" | "assistant" | "tool";
export type CheckpointScope =
  | "pre_patch"
  | "post_patch"
  | "pre_tool_batch"
  | "pre_tool_write"
  | "manual_undo_anchor";
export type SupervisorAction =
  | "accept"
  | "revise"
  | "retryWithMoreContext"
  | "fallbackToGovernor"
  | "continueVerification"
  | "abort";
export type SupervisorState =
  | "artifact_ready"
  | "verifying"
  | "revising"
  | "retrying"
  | "accepted"
  | "applying_patch"
  | "governor_fallback"
  | "aborted";
export type RollbackMode = "conversation" | "code" | "both";
export type RoutingDecisionMode = "automatic" | "manual_override" | "fallback";
export type RoutingReasonCode =
  | "manual_override"
  | "screenshot_task"
  | "complex_coding_task"
  | "cross_file_task"
  | "backend_implementation_task"
  | "small_patch_task"
  | "no_rule_matched"
  | "vision_input_missing"
  | "coding_worker_failed"
  | "vision_worker_failed"
  | "fallback_to_governor";
export type DiagnosticKind = "lsp" | "lint" | "typecheck" | "run_tests";
export type DiagnosticStatus = "ok" | "failed" | "unavailable";
export type DiagnosticTrigger = "apply_patch" | "apply_artifact_patch" | "future_write_tool";
export type TelemetryMetricName =
  | "worker_acceptance_rate"
  | "revision_count"
  | "fallback_rate"
  | "diagnostic_failure_count"
  | "model_invocation"
  | "governor_direct_success_count"
  /** Legacy metric name retained for old event decoding only. */
  | "direct_ds_success_count";
export type SkillScope = "project" | "project_compat" | "user" | "user_compat" | "built_in";
export type WorkflowScope = "project" | "user" | "built_in";
export type WorkflowFailureStrategy = "abort" | "continue";
export type WorkflowStepType = "governor" | "worker" | "tool";
export type RuntimeEventName = "session_start" | "tool_before" | "tool_after" | "worker_completed" | "task_failed";
export type McpServerType = "github" | "playwright";
export type McpServerState = "ready" | "disabled" | "error";
export type HistoryIntegrityScope = "resume_check" | "pre_model_request";
export type HistoryIntegrityOutcome = "clean" | "auto_repaired" | "fallback_to_safe_boundary" | "blocked";
export type ContextBudgetScope = "before_model" | "after_model";
export type ContextSummarySourceType = "tool_output" | "history_compaction" | "tool_cycle_checkpoint";
export type UsageValueSource = "provider_exact" | "provider_partial" | "local_estimated" | "unavailable";
export type HistoryIntegrityIssueType =
  | "orphan_tool"
  | "missing_assistant_tool_calls"
  | "tool_call_id_not_found"
  | "tool_call_order_mismatch"
  | "incomplete_tool_group";
export type HistoryIntegrityActionType =
  | "drop_orphan_tool"
  | "drop_incomplete_tool_group"
  | "trim_tool_message"
  | "drop_tool_group_for_budget"
  | "truncate_plain_message"
  | "fallback_to_turn_boundary";

export interface RuntimeEvent {
  name: RuntimeEventName;
  createdAt: string;
  sessionId?: string;
  turnId?: string;
  workflowRunId?: string;
  stepId?: string;
  toolName?: string;
  workerSessionId?: string;
  payload?: Record<string, unknown>;
}

export interface DeepMixDefaultSettings {
  permissionMode?: PermissionMode;
  routeOverride?: RouteTargetInput;
}

export interface ModelCapabilityManifest {
  textInput: boolean;
  imageInput: boolean;
  streaming: boolean;
  nativeToolCalling: boolean;
  structuredOutput: boolean;
  reasoning: boolean;
  contextWindow: number;
}

export interface ModelProfileRef {
  profile: string;
  model?: string;
  /** Resolution evidence only; persisted bindings normally omit this field. */
  adapter?: string;
  /** Resolution evidence only; persisted bindings normally omit this field. */
  protocol?: string;
}

export interface ModelFallbackPolicy {
  enabled: boolean;
  on: ModelFallbackTrigger[];
  allowGovernorDirectFallback?: boolean;
}

export interface ModelSlotBinding {
  primary: ModelProfileRef;
  fallbacks: ModelProfileRef[];
  parameters?: Record<string, string | number | boolean>;
  fallbackPolicy?: ModelFallbackPolicy;
  requirements?: Partial<Omit<ModelCapabilityManifest, "contextWindow">> & {
    minimumContextWindow?: number;
  };
}

export interface DeepMixModelSlots {
  governor: ModelSlotBinding;
  coding: ModelSlotBinding;
  vision: ModelSlotBinding;
}

export interface DeepMixModelSettings {
  preset: "classic" | "custom";
  slots: DeepMixModelSlots;
}

export interface ModelAssignmentSnapshot {
  readonly schemaVersion: 1;
  readonly assignmentId: string;
  readonly configRevision: number;
  readonly slot: ModelSlotId;
  readonly routeTarget: SemanticRouteTarget;
  readonly profileId: string;
  readonly provider: string;
  readonly model: string;
  readonly adapterId: string;
  readonly protocol: string;
  readonly capabilities: Readonly<ModelCapabilityManifest>;
  readonly selectedAt: string;
  readonly selectionReason: ModelSelectionReason;
  readonly fallbackIndex: number;
  readonly source: "settings" | "classic" | "legacy" | "environment";
}

export interface ModelAssignmentAttempt {
  snapshot: ModelAssignmentSnapshot;
  outcome: "selected" | "failed" | "blocked";
  failureType?: ModelFallbackTrigger | ModelNonReplayableReason | "adapter_not_found";
  redactedReason?: string;
}

export interface ModelRoutingErrorShape {
  code: "adapter_not_found" | "capability_unavailable" | "profile_unavailable" | "fallback_forbidden" | "provider_failure";
  slot: ModelSlotId;
  profileId?: string;
  adapterId?: string;
  retryable: boolean;
  redactedReason: string;
}

export interface DeepMixGovernorSettings {
  profile?: string;
  model?: string;
  stream?: boolean;
  contextWindow?: number;
  contextSoftLimitTokens?: number;
  contextCompactThresholdTokens?: number;
  contextReserveOutputTokens?: number;
  contextSummaryMaxTokens?: number;
  contextRecentTailMaxTokens?: number;
  maxHistoryMessages?: number;
  historyCharBudget?: number;
  timeoutMs?: number;
  maxRetries?: number;
  temperature?: number;
  thinkingMode?: ThinkingModeType;
  reasoningEffort?: ReasoningEffort;
  replyStyle?: ReplyStyle;
}

export interface DeepMixCodingWorkerSettings {
  profile?: string;
  model?: string;
  contextWindow?: number;
  timeoutMs?: number;
  maxRetries?: number;
  temperature?: number;
  maxContextChars?: number;
  maxContextFiles?: number;
}

export interface DeepMixVisionWorkerSettings {
  profile?: string;
  model?: string;
  contextWindow?: number;
  timeoutMs?: number;
  maxRetries?: number;
  maxContextChars?: number;
  maxImageBytes?: number;
  maxImageDimension?: number;
  targetImageDimension?: number;
  targetImageBytes?: number;
}

export interface DeepMixSkillSettings {
  enabledSkills?: Record<string, boolean>;
}

/** Desktop-only preferences persisted alongside each workspace's settings. */
export interface DeepMixDesktopSettings {
  shortcuts?: Record<string, string | null>;
}

export interface DeepMixWebSearchSettings {
  braveApiKey?: string;
}

export interface DeepMixGitSettings {
  /** Local branches which may not be deleted by built-in Git tools. */
  protectedBranches?: string[];
  /** Workspace-relative roots allowed to contain managed linked worktrees. */
  worktreeRoots?: string[];
}

export interface DeepMixExternalEmbeddingSettings {
  enabled: boolean;
  provider: string;
  endpoint: string;
  allowedHosts: string[];
  /** Human-readable declaration of exactly which snippets may leave the workspace. */
  dataBoundary: string;
}

export interface DeepMixCodeIntelligenceSettings {
  /** Local indexing remains the only permitted default. */
  defaultSemanticProvider?: "local";
  /** External providers are inert unless a tool call explicitly requests one and is approved. */
  externalEmbedding?: DeepMixExternalEmbeddingSettings;
}

export interface DeepMixSettings {
  version?: 1 | 2;
  /** Monotonic compare-and-swap revision for version 2 settings. */
  revision?: number;
  models?: DeepMixModelSettings;
  defaults?: DeepMixDefaultSettings;
  governor?: DeepMixGovernorSettings;
  codingWorker?: DeepMixCodingWorkerSettings;
  visionWorker?: DeepMixVisionWorkerSettings;
  skills?: DeepMixSkillSettings;
  desktop?: DeepMixDesktopSettings;
  webSearch?: DeepMixWebSearchSettings;
  git?: DeepMixGitSettings;
  codeIntelligence?: DeepMixCodeIntelligenceSettings;
  enabledSkills?: Record<string, boolean>;
}

export interface SkillRecord {
  name: string;
  description: string;
  sourcePath: string;
  directoryPath: string;
  sourceScope: SkillScope;
  allowImplicitInvocation: boolean;
  enabled: boolean;
  body: string;
  rawContent: string;
  frontmatter: Record<string, unknown>;
}

export interface SkillDiscoveryResult {
  skills: SkillRecord[];
  errors: string[];
}

export interface SkillMatch {
  skill: SkillRecord;
  score: number;
  reasons: string[];
}

export interface WorkflowGovernorStep {
  id: string;
  type: "governor";
  action: "record_message" | "update_plan";
  message?: string;
  planItems?: PlanItem[];
  onError?: WorkflowFailureStrategy;
}

export interface WorkflowWorkerStep {
  id: string;
  type: "worker";
  workerType: "coding" | "vision";
  input: Record<string, unknown>;
  onError?: WorkflowFailureStrategy;
}

export interface WorkflowToolStep {
  id: string;
  type: "tool";
  toolName: string;
  arguments?: unknown;
  onError?: WorkflowFailureStrategy;
}

export type WorkflowStep = WorkflowGovernorStep | WorkflowWorkerStep | WorkflowToolStep;

export interface WorkflowDefinition {
  name: string;
  description: string;
  sourcePath: string;
  sourceScope: WorkflowScope;
  steps: WorkflowStep[];
}

export interface WorkflowDiscoveryResult {
  workflows: WorkflowDefinition[];
  errors: string[];
}

export interface WorkflowStepResult {
  stepId: string;
  type: WorkflowStepType;
  success: boolean;
  output: string;
  structuredContent?: unknown;
  error?: string;
  continuedAfterError: boolean;
}

export interface WorkflowRunResult {
  runId: string;
  workflowName: string;
  sessionId: string;
  success: boolean;
  stepResults: WorkflowStepResult[];
  errors: string[];
}

export interface McpServerConfigEntry {
  name: string;
  type: McpServerType;
  enabled: boolean;
  toolSelection?: {
    keywords?: string[];
  };
  options?: Record<string, unknown>;
}

export interface McpServerConfigFile {
  version: 1;
  servers: McpServerConfigEntry[];
}

export interface McpToolDescriptor {
  serverName: string;
  serverType: McpServerType;
  name: string;
  description: string;
  inputSchema: Record<string, unknown>;
  readOnly: boolean;
  permissionCategory: Extract<ToolPermissionCategory, "mcp_read_only" | "mcp_side_effectful">;
  sideEffectLevel: SideEffectLevel;
  timeoutCategory: TimeoutCategory;
  selectionKeywords: string[];
}

export interface McpServerStatus {
  name: string;
  type: McpServerType;
  enabled: boolean;
  state: McpServerState;
  toolCount: number;
  resourceSupport?: McpResourceSupport;
  resourceCount?: number;
  lastCheckedAt?: string;
  error?: string;
}

export type LifecycleVisibility = "current_session" | "workspace" | "legacy_inferred";

export interface LifecycleOwnership {
  /** Stable, non-path workspace identity. Absolute workspace paths are never exposed. */
  workspaceId: string;
  sessionId?: string;
  parentSessionId?: string;
  visibility: LifecycleVisibility;
}

export type LifecycleWarningCode =
  | "legacy_record"
  | "missing_field"
  | "corrupt_record"
  | "missing_payload"
  | "unsupported_namespace"
  | "scan_limit_reached"
  | "content_redacted"
  | "content_truncated"
  | "capability_unavailable";

export interface LifecycleWarning {
  code: LifecycleWarningCode;
  message: string;
  recordId?: string;
}

export interface LifecycleRecordState {
  ownership: LifecycleOwnership;
  partial: boolean;
  warnings: LifecycleWarning[];
}

export interface LifecyclePage<T> {
  items: T[];
  limit: number;
  returned: number;
  scanned: number;
  hasMore: boolean;
  nextCursor?: string;
  partial: boolean;
  warnings: LifecycleWarning[];
}

export interface LifecycleTimeFilter {
  createdAfter?: string;
  createdBefore?: string;
}

export interface LifecyclePageRequest {
  cursor?: string;
  limit?: number;
}

export interface CheckpointListRequest extends LifecyclePageRequest, LifecycleTimeFilter {
  sessionId?: string;
  turnId?: string;
  toolCallId?: string;
}

export interface ArtifactListRequest extends LifecyclePageRequest, LifecycleTimeFilter {
  sessionId?: string;
  artifactType?: ArtifactSummary["artifactType"];
  sourceToolName?: string;
  mimeType?: string;
}

export interface WorkerOutputRequest extends LifecyclePageRequest {
  workerSessionId: string;
  kinds?: WorkerPublicOutputKind[];
  maxChars?: number;
}

export interface McpServerListRequest extends LifecyclePageRequest {
  state?: McpServerState;
  resourceSupport?: McpResourceSupport;
}

export interface McpResourceListRequest extends LifecyclePageRequest {
  serverName?: string;
  uriScheme?: string;
  mimeType?: string;
}

export interface McpResourceReadRequest {
  serverName: string;
  uri: string;
}

export type CheckpointLifecycleStatus = "available" | "restored" | "missing" | "corrupt";

export interface CheckpointSummary extends LifecycleRecordState {
  checkpointId: string;
  sessionId: string;
  turnId?: string;
  toolCallId?: string;
  sourceToolName?: string;
  createdAt: string;
  reason: string;
  scope: CheckpointScope;
  affectedPaths: string[];
  status: CheckpointLifecycleStatus;
  recoverable: boolean;
}

export type ArtifactReadMode = "text" | "structured" | "binary_metadata";
export type ArtifactSource = "worker" | "tool_output";

export interface ArtifactSummary extends LifecycleRecordState {
  uri: string;
  name: string;
  source: ArtifactSource;
  artifactType: WorkerArtifactKind | ToolOutputArtifactKind | "worker_patch" | "worker_binary";
  mimeType: string;
  sizeBytes: number;
  sha256?: string;
  createdAt: string;
  summary: string;
  readMode: ArtifactReadMode;
  sourceToolName?: string;
  workerSessionId?: string;
  artifactId?: string;
}

export interface ArtifactReadResult extends LifecycleRecordState {
  artifact: ArtifactSummary;
  mode: ArtifactReadMode;
  offset: number;
  limit: number;
  returnedChars: number;
  totalChars?: number;
  content?: string;
  structuredData?: unknown;
  binaryInline: false;
  truncated: boolean;
  nextOffset?: number;
}

export interface ArtifactExportResult extends LifecycleRecordState {
  sourceUri: string;
  targetPath: string;
  sizeBytes: number;
  sha256: string;
  checkpointId: string;
  overwritten: boolean;
}

export type WorkerLifecycleStage =
  | "queued"
  | "running"
  | "retrying"
  | "revising"
  | "artifact_ready"
  | "failed"
  | "cancelled";

export interface WorkerStatusSummary extends LifecycleRecordState {
  workerSessionId: string;
  workerType: WorkerType;
  status: WorkerSessionStatus;
  stage: WorkerLifecycleStage;
  dispatchKind: WorkerDispatchKind;
  createdAt: string;
  startedAt?: string;
  endedAt?: string;
  retryCount: number;
  revisionCount: number;
  artifactCount: number;
  recentSummary?: string;
  progress?: {
    label: string;
    current?: number;
    total?: number;
  };
  terminal: boolean;
}

export type WorkerPublicOutputKind = "status" | "artifact" | "promotion" | "verification" | "error";

export interface WorkerPublicOutputEvent {
  eventId: string;
  workerSessionId: string;
  createdAt: string;
  kind: WorkerPublicOutputKind;
  workerType: WorkerType;
  summary: string;
  status?: WorkerSessionStatus;
  artifactRef?: string;
  artifact?: WorkerArtifactSummary;
  details?: Record<string, unknown>;
}

export interface WorkerOutputPage extends LifecycleRecordState {
  workerSessionId: string;
  workerType: WorkerType;
  status: WorkerSessionStatus;
  events: WorkerPublicOutputEvent[];
  limit: number;
  returned: number;
  scanned: number;
  hasMore: boolean;
  nextCursor?: string;
  availableResult?: InvokeCodingWorkerResult | InvokeVisionWorkerResult;
}

export interface WorkerCancelResult extends LifecycleRecordState {
  workerSessionId: string;
  requestedBySessionId: string;
  requestedAt: string;
  reason: string;
  previousStatus: WorkerSessionStatus;
  finalStatus: WorkerSessionStatus;
  cancelled: boolean;
  idempotent: boolean;
  artifactCountPreserved: number;
}

export type McpResourceSupport = "supported" | "unsupported" | "unavailable";

/** Adapter-facing MCP Resource descriptor. It deliberately has no tool fields. */
export interface McpResourceProtocolDescriptor {
  uri: string;
  name: string;
  description?: string;
  mimeType?: string;
  sizeBytes?: number;
  updatedAt?: string;
}

/** A bounded page returned by an MCP server's Resource protocol. */
export interface McpResourceProtocolPage {
  resources: McpResourceProtocolDescriptor[];
  nextCursor?: string;
}

/** Raw Resource protocol payload before Tool Runtime redaction and artifact promotion. */
export interface McpResourceProtocolReadResult {
  descriptor: McpResourceProtocolDescriptor;
  representation: "text" | "structured" | "binary";
  text?: string;
  structuredData?: unknown;
  binaryData?: Uint8Array;
  sizeBytes?: number;
}

export interface McpResourceDiscoveryResult {
  resources: Array<McpResourceProtocolDescriptor & { serverName: string }>;
  scanned: number;
  partial: boolean;
  warnings: LifecycleWarning[];
}

export interface McpServerSummary extends LifecycleRecordState {
  name: string;
  type: McpServerType;
  enabled: boolean;
  state: McpServerState;
  errorSummary?: string;
  toolCount: number;
  resourceSupport: McpResourceSupport;
  resourceCount?: number;
  lastCheckedAt?: string;
}

export interface McpResourceDescriptor extends LifecycleRecordState {
  serverName: string;
  uri: string;
  name: string;
  description?: string;
  mimeType?: string;
  sizeBytes?: number;
  updatedAt?: string;
}

export interface McpResourceReadResult extends LifecycleRecordState {
  descriptor: McpResourceDescriptor;
  representation: "text" | "structured" | "binary";
  content?: string;
  structuredData?: unknown;
  artifact?: ToolOutputArtifact;
  sizeBytes: number;
  returnedChars?: number;
  totalChars?: number;
  truncated: boolean;
  binaryInline: false;
}

export interface PricingEntry {
  available: boolean;
  price?: number;
  currency?: string;
  unit?: string;
}

export interface RouteProfile {
  provider: string;
  model: string;
  role: RouteRole;
  contextWindow: number;
  toolCallingMode: ToolCallingMode;
  thinkingMode: {
    mode: ThinkingModeType;
    reasoningEffort: ReasoningEffort;
  };
  pricing: {
    input: PricingEntry;
    output: PricingEntry;
    cacheRead: PricingEntry;
    cacheWrite: PricingEntry;
  };
  maxInputSize: {
    value: number;
    unit: "tokens" | "characters" | "bytes";
  };
}

export interface RoutingFeatures {
  isScreenshotTask: boolean;
  isComplexCodingTask: boolean;
  isCrossFile: boolean;
  requiresBackend: boolean;
  isSmallPatch: boolean;
}

export interface RoutingDecision {
  mode: RoutingDecisionMode;
  automaticTarget: SemanticRouteTarget;
  finalTarget: SemanticRouteTarget;
  overrideTarget?: SemanticRouteTarget;
  ruleId: string;
  reasonCodes: RoutingReasonCode[];
  reasonSummary: string;
  features: RoutingFeatures;
}

export interface GovernorModelConfig {
  apiKey?: string;
  /** Compatibility interface; v2 runtime resolves these brand-neutral fields. */
  profileId?: string;
  provider?: string;
  adapterId?: string;
  protocol?: string;
  capabilities?: ModelCapabilityManifest;
  baseUrl: string;
  model: string;
  role: "governor";
  endpointPath: string;
  stream: boolean;
  contextWindow: number;
  maxRetries: number;
  timeoutMs: number;
  contextSoftLimitTokens: number;
  contextCompactThresholdTokens: number;
  contextReserveOutputTokens: number;
  contextSummaryMaxTokens: number;
  contextRecentTailMaxTokens: number;
  maxHistoryMessages: number;
  historyCharBudget: number;
  temperature: number;
  thinking: {
    type: ThinkingModeType;
    reasoningEffort: ReasoningEffort;
  };
  headers?: Record<string, string>;
  requestDefaults?: Record<string, unknown>;
  replyStyle?: ReplyStyle;
}

/** @deprecated Classic compatibility alias. New runtime code uses GovernorModelConfig. */
export type DeepSeekProviderConfig = GovernorModelConfig;

export interface WorkerSummaryRef {
  refType: "summary";
  label: string;
  summary: string;
}

export type WorkerContextRef = `file://${string}` | `artifact://${string}` | WorkerSummaryRef;

export interface WorkerTask {
  workerType: WorkerType;
  objective: string;
  constraints: string[];
  contextRefs: WorkerContextRef[];
  expectedOutput: WorkerArtifactKind;
  acceptanceChecks: string[];
}

export interface PlanItem {
  id: string;
  title: string;
  status: PlanStatus;
  notes?: string;
  blockedReason?: string;
}

export interface SessionRecord {
  sessionId: string;
  title: string;
  titleSource?: "prompt" | "placeholder" | "generated" | "user";
  /** Auto-title algorithm version; absent records were generated by the legacy truncated-input path. */
  titleGenerationVersion?: number;
  status: SessionStatus;
  createdAt: string;
  updatedAt: string;
  workspaceRoot: string;
  jsonlPath: string;
  activeTurnId?: string;
  lastTurnId?: string;
  messageCount: number;
  planItems: PlanItem[];
  lastAssistantMessage?: string;
  latestTokenUsage?: TokenUsageSnapshot;
  cumulativeTokenUsage?: TokenUsageSnapshot;
  latestContextBudget?: ContextBudgetSnapshot;
  latestCompaction?: ContextCompactionRecord;
  latestTaskDuration?: TaskDurationSnapshot;
  pinnedAt?: string;
  archivedAt?: string;
  unread?: boolean;
}

export type ToolErrorType =
  | "missing_dependency"
  | "not_found"
  | "corrupt_record"
  | "permission_denied"
  | "unavailable"
  | "unsupported_protocol"
  | "conflicted"
  | "protected_branch"
  | "invalid_arguments"
  | "invalid_state"
  | "invalid_path"
  | "sandbox_denied"
  | "tool_not_selected"
  | "repeated_tool_call"
  | "waiting_for_user"
  | "command_failed"
  | "network_error"
  | "provider_error"
  | "authentication_failed"
  | "rate_limited"
  | "timeout"
  | "unsupported_environment";

export type BuiltInRuntimeCapabilityName = "rg" | "git" | "powershell" | "node" | "npm";
export type RuntimeCapabilityName = string;

export interface CapabilityProbeDefinition {
  name: RuntimeCapabilityName;
  candidates: string[];
  args: string[];
  timeoutMs: number;
  platforms?: string[];
}

export interface ToolStructuredError {
  type: ToolErrorType;
  message: string;
  retryable: boolean;
  toolName?: string;
  path?: string;
  cwd?: string;
  dependency?: string;
  command?: string;
  exitCode?: number;
  stdout?: string;
  stderr?: string;
  fieldPath?: string;
  details?: Array<{
    path: string;
    message: string;
  }>;
}

export interface RuntimeCapabilityProbe {
  name: RuntimeCapabilityName;
  available: boolean;
  command: string;
  version?: string;
  errorType?: ToolErrorType;
  message: string;
}

export interface RuntimeCapabilitySnapshot {
  checkedAt: string;
  capabilities: Record<RuntimeCapabilityName, RuntimeCapabilityProbe> &
    Record<BuiltInRuntimeCapabilityName, RuntimeCapabilityProbe>;
  fallbacks: {
    listFiles: "rg" | "node_fs";
    searchFiles: "rg" | "node_text";
  };
}

export type GitPathChangeKind =
  | "added"
  | "modified"
  | "deleted"
  | "renamed"
  | "copied"
  | "type_changed"
  | "unmerged"
  | "unknown";

export interface GitPathChange {
  path: string;
  previousPath?: string;
  status: string;
  kind: GitPathChangeKind;
}

export interface GitHeadState {
  oid?: string;
  shortOid?: string;
  branch?: string;
  detached: boolean;
  unborn: boolean;
}

export interface GitWorktreeState {
  /** Workspace-relative path, or a redacted outside-workspace label. */
  path: string;
  head?: string;
  branch?: string;
  detached: boolean;
  bare: boolean;
  locked: boolean;
  lockReason?: string;
  prunable: boolean;
  pruneReason?: string;
  trusted: boolean;
}

export type GitConflictOperation = "merge" | "rebase" | "cherry_pick" | "revert" | "unknown";

export interface GitConflictState {
  status: "none" | "conflicted";
  operation?: GitConflictOperation;
  files: string[];
  nextSteps: string[];
}

export interface GitRepositorySnapshot {
  repositoryState: "worktree" | "bare" | "not_repository";
  cwd: string;
  repositoryRoot?: string;
  gitDir?: string;
  commonDir?: string;
  /** Whether Git's per-worktree metadata resolves inside the trusted workspace. */
  gitDirTrusted: boolean;
  /** Whether Git's shared refs/object metadata resolves inside the trusted workspace. */
  commonDirTrusted: boolean;
  isRepository: boolean;
  isBare: boolean;
  isSubmodule: boolean;
  superprojectRoot?: string;
  head: GitHeadState;
  protectedBranch: boolean;
  dirty: boolean;
  staged: GitPathChange[];
  unstaged: GitPathChange[];
  untracked: string[];
  conflicted: string[];
  worktrees: GitWorktreeState[];
  conflict: GitConflictState;
  /** False when a bounded probe failed or truncated, so mutations can fail closed. */
  stateComplete: boolean;
  stateFailures: string[];
  /** Bounded digest of index and dirty worktree content used by approval freshness checks. */
  contentDigest?: string;
  /** SHA-256 over the security-relevant local state used to bind approvals. */
  stateDigest: string;
  capturedAt: string;
}

export type GitOperationStatus =
  | "preview"
  | "completed"
  | "unchanged"
  | "not_found"
  | "invalid_state"
  | "protected"
  | "conflicted"
  | "failed";

export interface GitOperationPreview {
  summary: string;
  confirmationToken: string;
  paths?: string[];
  revisions?: string[];
  stagedDiffSummary?: string;
  commitMessage?: string;
  riskSummary?: string[];
}

export interface GitUndoEvidence {
  available: boolean;
  checkpointId?: string;
  scope: "worktree_files" | "index" | "repository_state" | "none";
  limitations?: string[];
}

export interface GitOperationResult<TDetails = Record<string, unknown>> {
  kind: "git_operation";
  toolName: string;
  action: string;
  status: GitOperationStatus;
  repository: GitRepositorySnapshot;
  headBefore?: GitHeadState;
  headAfter?: GitHeadState;
  changedPaths: string[];
  conflict: GitConflictState;
  durationMs: number;
  preview?: GitOperationPreview;
  checkpointId?: string;
  undo?: GitUndoEvidence;
  details?: TDetails;
  error?: ToolStructuredError;
}

export interface SessionsIndex {
  version: 1;
  activeSessionId?: string;
  sessions: SessionRecord[];
}

export interface ToolCall {
  id: string;
  name: string;
  arguments: unknown;
  rawArguments: string;
}

/** One persisted provider assistant response and its redacted tool-call batch. */
export interface ToolBatchStart {
  assistantMessageId: string;
  turnId: string;
  createdAt: string;
  toolCalls: ToolCall[];
}

export interface MessageRecord {
  recordType: "message";
  messageId: string;
  sessionId: string;
  turnId: string;
  role: MessageRole;
  createdAt: string;
  content: string;
  name?: string;
  toolCalls?: ToolCall[];
  toolCallId?: string;
  reasoningContent?: string;
  metadata?: Record<string, unknown>;
}

export interface TurnRecord {
  recordType: "turn";
  turnId: string;
  sessionId: string;
  createdAt: string;
  startedAt: string;
  endedAt?: string;
  durationMs?: number;
  status: SessionStatus;
  requestSummary: string;
  userMessageId: string;
  assistantMessageId?: string;
  toolCallIds: string[];
  /** Immutable, redacted model selection fixed when this turn starts. */
  modelAssignment?: ModelAssignmentSnapshot;
  error?: string;
}

export interface PlanUpdateRecord {
  recordType: "plan_update";
  sessionId: string;
  createdAt: string;
  planItems: PlanItem[];
}

export interface ApprovalRecord {
  recordType: "approval";
  approvalId: string;
  sessionId: string;
  createdAt: string;
  toolName: string;
  permissionCategory: ToolPermissionCategory;
  requestKey: string;
  decision: PermissionDecision;
  reason: string;
  status: ApprovalStatus;
  persistence: ApprovalPersistence;
  callId?: string;
  sideEffectLevel?: SideEffectLevel;
  presentation?: ApprovalPresentation;
  executionOrigin?: ToolExecutionOrigin;
  parentCallId?: string;
  parentToolName?: string;
}

export interface ApprovalPresentation {
  action?: string;
  summary: string;
  paths?: string[];
  revisions?: string[];
  argumentSummary?: Record<string, unknown>;
}

export interface CheckpointRecord {
  recordType: "checkpoint";
  checkpointId: string;
  sessionId: string;
  /** Added in phase 21; legacy records are inferred from the owning session event stream. */
  workspaceId?: string;
  turnId?: string;
  toolCallId?: string;
  sourceToolName?: string;
  createdAt: string;
  scope: CheckpointScope;
  trackedFiles: string[];
  gitRef: string;
  reason: string;
}

export interface WorkerSessionLinkRecord {
  recordType: "worker_session_link";
  sessionId: string;
  workerSessionId: string;
  createdAt: string;
  workerType: WorkerType;
  dispatchKind: WorkerDispatchKind;
  status: WorkerSessionStatus;
}

export interface SupervisorDecision {
  action: SupervisorAction;
  reason: string;
  evidenceRefs: Array<`file://${string}` | `artifact://${string}`>;
  extraContextRefs?: WorkerContextRef[];
  verificationCommands?: string[];
}

export interface SupervisorDecisionRecord extends SupervisorDecision {
  recordType: "supervisor_decision";
  decisionId: string;
  sessionId: string;
  workerSessionId: string;
  createdAt: string;
  resultingState: SupervisorState;
  artifactRef?: string;
}

export interface ArtifactPromotionRecord {
  recordType: "artifact_promotion";
  promotionId: string;
  sessionId: string;
  workerSessionId: string;
  createdAt: string;
  artifactRef: string;
  promotedFields: string[];
  changedFiles: string[];
  riskSummary: string[];
  verificationSummary: string[];
}

export interface RoutingDecisionRecord extends RoutingDecision {
  recordType: "routing_decision";
  sessionId: string;
  turnId: string;
  createdAt: string;
  /** Preserved only when a legacy stored target was normalized during read. */
  legacyTarget?: LegacyRouteTarget;
}

export interface DiagnosticIssue {
  severity: "error" | "warning";
  message: string;
  file?: string;
  line?: number;
  column?: number;
  code?: string | number;
}

export interface DiagnosticEntry {
  kind: DiagnosticKind;
  status: DiagnosticStatus;
  ok: boolean;
  summary: string;
  command?: string;
  exitCode?: number;
  errorCount?: number;
  warningCount?: number;
  fileCount?: number;
  unavailableReason?: string;
  rawOutput?: string;
  issues?: DiagnosticIssue[];
}

export interface DiagnosticReportRecord {
  recordType: "diagnostic_report";
  sessionId: string;
  createdAt: string;
  trigger: DiagnosticTrigger;
  trackedFiles: string[];
  diagnostics: DiagnosticEntry[];
}

export type CodeIntelligenceSource = "lsp" | "ast" | "semantic" | "lexical";
export type CodeIntelligenceFallbackType =
  | "none"
  | "ast"
  | "local_index"
  | "lexical"
  | "capability_unavailable";
export type CodeResultPrecision = "exact" | "approximate";
export type CodeRelationKind =
  | "declaration"
  | "definition"
  | "reference_read"
  | "reference_write"
  | "reference_unknown";
export type CodeSymbolKind =
  | "module"
  | "namespace"
  | "class"
  | "interface"
  | "type"
  | "enum"
  | "enum_member"
  | "function"
  | "method"
  | "constructor"
  | "property"
  | "field"
  | "variable"
  | "constant"
  | "parameter"
  | "import"
  | "export"
  | "unknown";

export interface CodePosition {
  /** Public results use a one-based line number; LSP adapters convert from zero-based coordinates. */
  line: number;
  /** Public results use a one-based UTF-16 column; LSP adapters convert from zero-based coordinates. */
  column: number;
}

export interface CodeRange {
  start: CodePosition;
  /** End-exclusive position. */
  end: CodePosition;
}

export interface CodeLocation {
  /** Normalized workspace-relative path with forward slashes. */
  path: string;
  range: CodeRange;
  language: string;
  /** Hash of the indexed source version used to reject stale precision claims. */
  contentHash?: string;
}

interface CodeResultProvenanceBase {
  /** Normalized inclusive semantic-confidence score in the range 0..1. */
  confidence: number;
  indexVersion: string;
  warnings: string[];
}

export type CodeResultProvenance =
  | (CodeResultProvenanceBase & {
      source: "lsp";
      fallbackType: "none";
      precision: "exact";
      stale: false;
    })
  | (CodeResultProvenanceBase & {
      source: "lsp";
      fallbackType: "none";
      precision: "approximate";
      stale: true;
    })
  | (CodeResultProvenanceBase & {
      source: "ast";
      fallbackType: "ast";
      precision: "approximate";
      stale: boolean;
    })
  | (CodeResultProvenanceBase & {
      source: "semantic";
      fallbackType: "none" | "local_index";
      precision: "approximate";
      stale: boolean;
    })
  | (CodeResultProvenanceBase & {
      source: "lexical";
      fallbackType: "lexical" | "capability_unavailable";
      precision: "approximate";
      stale: boolean;
    });

export type CodeSymbol = CodeResultProvenance & {
  name: string;
  kind: CodeSymbolKind;
  language: string;
  location: CodeLocation;
  selectionRange?: CodeRange;
  containerName?: string;
  signature?: string;
  exported?: boolean;
};

export type CodeRelation = CodeResultProvenance & {
  kind: CodeRelationKind;
  symbolName: string;
  from?: CodeLocation;
  to: CodeLocation;
};

export type CodeSearchMatch = CodeResultProvenance & {
  location: CodeLocation;
  symbol?: CodeSymbol;
  snippet: string;
  snippetTruncated: boolean;
  snippetOriginalChars: number;
  /** Relevance score used only for stable ranking; confidence describes provenance precision. */
  score: number;
  explanation: string;
};

export interface CodeResultPage<T> {
  items: T[];
  total: number;
  totalExact: boolean;
  returned: number;
  /** Opaque cursor bound to workspace, tool, normalized query and index version. */
  cursor?: string;
  nextCursor?: string;
  hasMore: boolean;
  truncated: boolean;
  maxResultChars: number;
  indexVersion: string;
  stale: boolean;
  warnings: string[];
  /** Recovery copy only; never substitutes for the complete current page. */
  artifactUri?: string;
}

export type CodeSearchResult = CodeResultPage<CodeSearchMatch> & CodeResultProvenance & {
  query: string;
  localOnly: boolean;
  externalDataShared: boolean;
  externalProvider?: string;
  dataBoundary: "local_only" | "approved_external_snippets";
};

export type NormalizedFindingSeverity =
  | "critical"
  | "high"
  | "medium"
  | "low"
  | "info"
  | "unknown";

export interface FindingSource {
  name: string;
  kind: "dependency_auditor" | "static_scanner" | "local_metadata";
  version?: string;
  reportArtifactUri?: string;
}

export type SecurityFindingSource = FindingSource & {
  kind: "static_scanner";
};

export type DependencyFindingSource = FindingSource & {
  kind: "dependency_auditor" | "local_metadata";
};

export interface FindingEvidence {
  summary: string;
  snippet?: string;
  redacted: boolean;
}

export interface SecurityFinding {
  id: string;
  ruleId: string;
  title: string;
  severity: NormalizedFindingSeverity;
  rawSeverity?: string;
  severityNormalization?: string;
  location: CodeLocation;
  evidence: FindingEvidence;
  recommendation: string;
  source: SecurityFindingSource;
  confidence: number;
  cwe?: string[];
  fingerprint: string;
}

export interface DependencyFinding {
  id: string;
  advisoryId?: string;
  advisoryIdStatus: "reported" | "unavailable";
  packageName: string;
  installedVersion?: string;
  affectedVersions?: string;
  fixedVersions: string[];
  severity: NormalizedFindingSeverity;
  rawSeverity?: string;
  severityNormalization?: string;
  dependencyChain: string[];
  direct: boolean;
  manifestPath?: string;
  lockfilePath: string;
  evidence: FindingEvidence;
  recommendation: string;
  source: DependencyFindingSource;
}

export type AuditCapabilityStatus = "available" | "degraded" | "unavailable";

export interface FindingResultPage<T> {
  items: T[];
  total: number;
  totalExact: boolean;
  returned: number;
  cursor?: string;
  nextCursor?: string;
  hasMore: boolean;
  truncated: boolean;
  maxResultChars: number;
  warnings: string[];
  status: AuditCapabilityStatus;
  source: FindingSource;
  /** Required redacted raw-report recovery copy; the current page remains authoritative inline. */
  artifactUri: string;
  automaticChangesApplied: false;
}

export interface DependencyAuditResult extends FindingResultPage<DependencyFinding> {
  kind: "dependency_audit";
  source: DependencyFindingSource;
  packageManager: string;
  networkAccess: boolean;
  networkAttempted: boolean;
  advisoryCoverage: "local_metadata_only" | "online_audit";
  dependencyInstallAttempted: false;
  lockfileModified: false;
}

export interface SecurityScanResult extends FindingResultPage<SecurityFinding> {
  kind: "security_scan";
  source: SecurityFindingSource;
  scanner: string;
  scannerInstallAttempted: false;
  patchesApplied: false;
}

export interface TelemetryMetricRecord {
  recordType: "telemetry_metric";
  sessionId: string;
  createdAt: string;
  metricName: TelemetryMetricName;
  value: number;
  numerator?: number;
  denominator?: number;
  metadata?: Record<string, unknown>;
}

export interface RollbackRecord {
  recordType: "rollback";
  rollbackId: string;
  sessionId: string;
  createdAt: string;
  checkpointId: string;
  mode: RollbackMode;
  restoredFiles: string[];
  restoredEventCount?: number;
  reason: string;
}

export interface HistoryIntegrityIssue {
  type: HistoryIntegrityIssueType;
  detail: string;
  turnId?: string;
  messageId?: string;
  toolCallId?: string;
}

export interface HistoryIntegrityAction {
  type: HistoryIntegrityActionType;
  detail: string;
  turnId?: string;
  messageIds?: string[];
  toolCallIds?: string[];
}

export interface HistoryIntegrityRecord {
  recordType: "history_integrity";
  sessionId: string;
  turnId?: string;
  createdAt: string;
  scope: HistoryIntegrityScope;
  outcome: HistoryIntegrityOutcome;
  summary: string;
  messageCountBefore: number;
  messageCountAfter: number;
  safeBoundaryTurnId?: string;
  issues: HistoryIntegrityIssue[];
  actions: HistoryIntegrityAction[];
}

export interface TokenUsageSnapshot {
  source: UsageValueSource;
  model?: string;
  recordedAt: string;
  inputTokens?: number;
  outputTokens?: number;
  reasoningTokens?: number;
  cachedInputTokens?: number;
  uncachedInputTokens?: number;
  totalTokens?: number;
}

export interface ContextBudgetCategorySnapshot {
  key: "system_prompt" | "tools" | "skills_workflows_mcp" | "recent_messages" | "summaries" | "free";
  label: string;
  estimatedTokens: number;
}

export interface ToolOutputContextExposureSnapshot {
  rawMessageCount: number;
  summarizedMessageCount: number;
  budgetTruncatedMessageCount: number;
}

export interface ContextBudgetSnapshot {
  source: UsageValueSource;
  model: string;
  recordedAt: string;
  contextWindowTokens: number;
  inputBudgetTokens: number;
  softLimitTokens: number;
  compactThresholdTokens: number;
  reserveOutputTokens: number;
  usedInputTokens: number;
  remainingInputTokens: number;
  usagePercent: number;
  selectedMessageCount: number;
  selectedSummaryCount: number;
  toolOutputExposure?: ToolOutputContextExposureSnapshot;
  categories: ContextBudgetCategorySnapshot[];
}

export interface ContextCompactionRecord {
  createdAt: string;
  source: UsageValueSource;
  triggered: boolean;
  triggerReason?: string;
  beforeTokens: number;
  afterTokens: number;
  tokensSaved: number;
  droppedMessageCount: number;
  summaryCount: number;
  retained: string[];
  summaryRefs: string[];
}

export interface ContextSummaryRecord {
  recordType: "context_summary";
  summaryId: string;
  sessionId: string;
  turnId: string;
  createdAt: string;
  sourceType: ContextSummarySourceType;
  sourceToolName?: string;
  sourceMessageId?: string;
  sourceToolCallId?: string;
  sourceRawChars?: number;
  toolOutputLifecycle?: "raw_once_then_summary_v1";
  summary: string;
  estimatedTokens: number;
  keyPaths?: string[];
  keyFiles?: string[];
  command?: string;
  rawOutputRef?: string;
}

export interface ContextBudgetRecord {
  recordType: "context_budget";
  sessionId: string;
  turnId: string;
  createdAt: string;
  scope: ContextBudgetScope;
  snapshot: ContextBudgetSnapshot;
  usage?: TokenUsageSnapshot;
  compaction?: ContextCompactionRecord;
}

export interface TaskDurationSnapshot {
  startedAt: string;
  endedAt?: string;
  durationMs?: number;
  status: SessionStatus;
}

export interface ToolSelectionSummary {
  selectedCount: number;
  unselectedCount: number;
  selectedToolNames: string[];
  reasonCounts: Record<string, number>;
}

export interface ToolSelectionRecord extends ToolSelectionSummary {
  recordType: "tool_selection";
  selectionId?: string;
  sessionId: string;
  turnId: string;
  createdAt: string;
  providerCycle?: number;
  activationLeaseIds?: string[];
  activatedToolNames?: string[];
  estimatedToolSchemaTokens?: number;
}

export const TOOL_SEARCH_LIMITS = {
  defaultResults: 256,
  maxResultsPerSearch: 256,
  defaultActivations: 3,
  maxActivationsPerSearch: 3,
  maxActivationsPerTurn: 8,
  leaseProviderCycles: 4,
} as const;

export type ToolSearchMode = "discover" | "activate";

export interface ToolSearchQuery {
  query: string;
  mode: ToolSearchMode;
  groups?: string[];
  moduleIds?: string[];
  sources?: ToolModuleSource[];
  maxResults?: number;
  maxActivations?: number;
}

export interface ToolSearchMatch {
  name: string;
  displayName?: string;
  moduleId: string;
  moduleVersion: string;
  source: ToolModuleSource;
  description: string;
  groups: string[];
  permissionCategory: ToolPermissionCategory;
  sideEffectLevel: SideEffectLevel;
  availability: ToolAvailability;
  score: number;
  matchReasons: string[];
  activatable: boolean;
  activationBlockedReason?: string;
}

export type ToolActivationRejectionReason =
  | "unavailable"
  | "workflow_only"
  | "permission_denied"
  | "mode_denied"
  | "already_selected"
  | "search_limit"
  | "turn_limit"
  | "not_matched";

export interface ToolSelectionLease {
  leaseId: string;
  sessionId: string;
  turnId: string;
  sourceToolCallId: string;
  sourceQuery: ToolSearchQuery;
  toolNames: string[];
  createdAt: string;
  activationCycle: number;
  firstProviderCycle: number;
  expiresAfterProviderCycle: number;
  expiresOn: Array<"turn_completed" | "turn_failed" | "turn_cancelled" | "session_interrupted">;
}

export interface ToolActivationRecord {
  recordType: "tool_activation";
  activationId: string;
  sessionId: string;
  turnId: string;
  toolCallId: string;
  createdAt: string;
  query: ToolSearchQuery;
  matches: ToolSearchMatch[];
  requestedToolNames: string[];
  activatedToolNames: string[];
  rejectedTools: Array<{
    name: string;
    reason: ToolActivationRejectionReason;
    message: string;
  }>;
  lease?: ToolSelectionLease;
  estimatedSchemaTokens: number;
}

export const USER_INPUT_LIMITS = {
  maxQuestionsPerRequest: 3,
  maxOptionsPerQuestion: 5,
  maxPromptChars: 500,
  maxOptionLabelChars: 120,
  maxFreeformChars: 4_000,
  maxCancelReasonChars: 1_000,
} as const;

export type UserInputQuestionKind = "single_select" | "multi_select" | "text" | "confirm";
export type UserInputRequestMode = "blocking" | "non_blocking";
export type UserInputAnswerValue = string | string[] | boolean;

export interface UserInputOption {
  id: string;
  label: string;
  description?: string;
}

export interface UserInputQuestion {
  id: string;
  prompt: string;
  kind: UserInputQuestionKind;
  required: boolean;
  options?: UserInputOption[];
  allowFreeform?: boolean;
  defaultValue?: UserInputAnswerValue;
  placeholder?: string;
}

export interface UserInputAnswer {
  questionId: string;
  value: UserInputAnswerValue;
  source: "selected_option" | "freeform" | "explicit_confirmation" | "default_accepted";
}

export interface UserInputAnswerResult {
  requestId: string;
  status: "answered" | "cancelled";
  answers: UserInputAnswer[];
  submittedAt: string;
  cancelReason?: string;
}

export interface UserInputRequestRecord {
  recordType: "user_input_request";
  requestId: string;
  sessionId: string;
  turnId: string;
  toolCallId: string;
  createdAt: string;
  mode: UserInputRequestMode;
  title?: string;
  questions: UserInputQuestion[];
  status: "pending";
}

interface UserInputResponseRecordBase {
  recordType: "user_input_response";
  requestId: string;
  sessionId: string;
  turnId: string;
  toolCallId: string;
  responseId: string;
  createdAt: string;
  submittedAt: string;
}

export type UserInputResponseRecord = UserInputResponseRecordBase & (
  | {
      status: "answered";
      answers: UserInputAnswer[];
      userMessageId: string;
    }
  | {
      status: "cancelled";
      answers: [];
      cancelReason?: string;
      userMessageId?: never;
    }
);

export interface UserInputResumeRecord {
  recordType: "user_input_resume";
  requestId: string;
  responseId?: string;
  sessionId: string;
  turnId: string;
  toolCallId: string;
  createdAt: string;
  status: "resuming" | "resumed" | "resume_failed" | "interrupted";
  resumedAt?: string;
  error?: string;
}

export interface UserInputRequestState {
  request: UserInputRequestRecord;
  response?: UserInputResponseRecord;
  latestResume?: UserInputResumeRecord;
  status:
    | "pending"
    | "answered"
    | "cancelled"
    | "resuming"
    | "resumed"
    | "resume_failed"
    | "interrupted";
}

export type ToolRuntimeControl =
  | {
      type: "wait_for_user";
      requestId: string;
      blocking: true;
    }
  | {
      type: "continue";
      requestId: string;
      blocking: false;
    };

export interface ToolExecutionAuditRecord {
  recordType: "tool_execution_audit";
  sessionId: string;
  callId: string;
  toolName: string;
  moduleId?: string;
  createdAt: string;
  startedAt: string;
  endedAt: string;
  success: boolean;
  approvalId?: string;
  approvalDecision?: PermissionDecision;
  action?: string;
  argumentSummary?: Record<string, unknown>;
  durationMs?: number;
  headBefore?: string;
  headAfter?: string;
  changedPaths?: string[];
  resultStatus?: string;
  accessKinds: ToolAccessKind[];
  artifactUris: string[];
  errorType?: ToolErrorType;
  network?: NetworkAuditSummary;
  executionOrigin?: ToolExecutionOrigin;
  parentCallId?: string;
  parentToolName?: string;
}

export type SessionEvent =
  | MessageRecord
  | TurnRecord
  | PlanUpdateRecord
  | ApprovalRecord
  | CheckpointRecord
  | WorkerSessionLinkRecord
  | SupervisorDecisionRecord
  | ArtifactPromotionRecord
  | RoutingDecisionRecord
  | DiagnosticReportRecord
  | TelemetryMetricRecord
  | RollbackRecord
  | HistoryIntegrityRecord
  | ContextSummaryRecord
  | ContextBudgetRecord
  | ToolExecutionAuditRecord
  | ToolSelectionRecord
  | ToolActivationRecord
  | UserInputRequestRecord
  | UserInputResponseRecord
  | UserInputResumeRecord;

export interface WorkerSessionRecord {
  workerSessionId: string;
  /** Added in phase 21; legacy records inherit it from the workspace-scoped store. */
  workspaceId?: string;
  parentSessionId: string;
  workerType: WorkerType;
  route: RouteProfile;
  /** Immutable, redacted model selection fixed for this dispatch. */
  modelAssignment?: ModelAssignmentSnapshot;
  status: WorkerSessionStatus;
  /** Monotonic state-transition version used for cancellation and completion race checks. */
  statusVersion?: number;
  dispatchKind: WorkerDispatchKind;
  createdAt: string;
  updatedAt: string;
  startedAt?: string;
  endedAt?: string;
  objective: string;
  constraints: string[];
  contextRefs: WorkerContextRef[];
  expectedOutput: WorkerArtifactKind;
  acceptanceChecks: string[];
  timeoutMs: number;
  maxRetries: number;
  retryCount: number;
  revisionCount: number;
  messageCount: number;
  artifactCount: number;
  jsonlPath: string;
  retryOfWorkerSessionId?: string;
  reviseOfWorkerSessionId?: string;
  lastErrorType?: WorkerFailureType;
  lastErrorMessage?: string;
}

export interface VisionCropRect {
  x: number;
  y: number;
  width: number;
  height: number;
}

export interface VisionImageRef {
  sourceType: VisionImageSourceType;
  ref: `file://${string}` | `artifact://${string}`;
  crop?: VisionCropRect;
}

export interface VisionRegion {
  id: string;
  label: string;
  confidence: number;
  bbox: VisionCropRect;
}

export interface VisionOcrBlock {
  text: string;
  confidence: number;
  regionId?: string;
}

export interface VisionComponent {
  id: string;
  type: string;
  label: string;
  confidence: number;
  regionId?: string;
  attributes?: Record<string, string | number | boolean>;
}

export interface VisionArtifactMetadata extends Record<string, unknown> {
  sourceType: VisionImageSourceType;
  inputMode: VisionImageInputMode;
  inputImageRef: string;
  originalImageRef: string;
  processedImageRef: string;
  mimeType: string;
  originalBytes: number;
  processedBytes: number;
  originalWidth: number;
  originalHeight: number;
  processedWidth: number;
  processedHeight: number;
  preprocessing: {
    resized: boolean;
    cropped: boolean;
    recompressed: boolean;
  };
}

export interface WorkerStatusRecord {
  recordType: "worker_status";
  workerSessionId: string;
  workspaceId?: string;
  parentSessionId?: string;
  createdAt: string;
  status: WorkerSessionStatus;
  dispatchKind: WorkerDispatchKind;
  attemptNumber: number;
  reason?: string;
}

export interface WorkerMessageRecord {
  recordType: "worker_message";
  workerSessionId: string;
  createdAt: string;
  role: "system" | "user" | "assistant";
  content: string;
  metadata?: Record<string, unknown>;
}

export interface BaseWorkerArtifact {
  kind: WorkerArtifactKind;
  summary: string;
  confidence: number;
  risks: string[];
  metadata: Record<string, unknown>;
}

export interface CodeArtifact extends BaseWorkerArtifact {
  kind: "code_artifact";
  patchRef: string;
  changedFiles: string[];
  testCommands: string[];
  notes?: string[];
}

export interface VisionArtifact extends BaseWorkerArtifact {
  kind: "vision_artifact";
  taskType: VisionTaskType;
  issues: string[];
  metadata: VisionArtifactMetadata;
  ocrBlocks: VisionOcrBlock[];
  regions: VisionRegion[];
  components: VisionComponent[];
  errorText?: string[];
  suspectedCauses?: string[];
  evidenceRegions?: string[];
}

export interface ReviewArtifact extends BaseWorkerArtifact {
  kind: "review_artifact";
  findings: string[];
  severity: "low" | "medium" | "high" | "critical";
  evidenceRefs: Array<`file://${string}` | `artifact://${string}`>;
}

export interface ResearchArtifact extends BaseWorkerArtifact {
  kind: "research_artifact";
  claims: string[];
  sources: string[];
  openQuestions: string[];
}

export type WorkerArtifact = CodeArtifact | VisionArtifact | ReviewArtifact | ResearchArtifact;

export interface CodeArtifactSummary {
  kind: "code_artifact";
  summary: string;
  patchRef: string;
  changedFiles: string[];
  testCommands: string[];
  risks: string[];
  confidence: number;
  notes?: string[];
}

export interface VisionArtifactSummary {
  kind: "vision_artifact";
  taskType: VisionTaskType;
  summary: string;
  confidence: number;
  issues: string[];
  metadata: VisionArtifactMetadata;
}

export interface VisionArtifactToolSummary extends VisionArtifactSummary {
  artifactRef: string;
}

export type WorkerArtifactSummary = CodeArtifactSummary | VisionArtifactSummary;

export interface WorkerArtifactRecord {
  recordType: "worker_artifact";
  workerSessionId: string;
  workspaceId?: string;
  parentSessionId?: string;
  artifactId: string;
  createdAt: string;
  artifactRef: string;
  summary: WorkerArtifactSummary;
}

export interface WorkerCancellationRecord {
  recordType: "worker_cancellation";
  cancellationId: string;
  workerSessionId: string;
  workspaceId: string;
  parentSessionId: string;
  createdAt: string;
  requestedBySessionId: string;
  reason: string;
  previousStatus: WorkerSessionStatus;
  finalStatus: WorkerSessionStatus;
  cancelled: boolean;
  idempotent: boolean;
  artifactCountPreserved: number;
}

export type WorkerSessionEvent =
  | WorkerStatusRecord
  | WorkerMessageRecord
  | WorkerArtifactRecord
  | WorkerCancellationRecord;

export interface WorkerToolError {
  errorType: WorkerFailureType;
  message: string;
  retryable: boolean;
  workerSessionId?: string;
}

export interface InvokeCodingWorkerResult {
  workerSessionId: string;
  artifact?: CodeArtifactSummary;
  error?: WorkerToolError;
}

export interface InvokeVisionWorkerResult {
  workerSessionId: string;
  artifact?: VisionArtifactToolSummary;
  error?: WorkerToolError;
}

export type ToolModuleSource = "built_in" | "mcp";
export type ToolAccessKind =
  | "filesystem_read"
  | "filesystem_write"
  | "command_execute"
  | "network_access"
  | "trusted_state_read"
  | "external_system";
export type ToolCheckpointMode = "none" | "before_write";
export type ToolAvailabilityStatus = "available" | "degraded" | "unavailable";
export type ToolOutputArtifactKind = "file" | "document" | "image" | "text" | "binary";

export type ToolProcessStatus =
  | "starting"
  | "running"
  | "exited"
  | "failed"
  | "stopping"
  | "stopped"
  | "orphaned";
export type ToolProcessStream = "stdout" | "stderr";
export type ToolProcessInteractionMode = "none" | "pipe" | "pty";
export type ToolProcessStopStrategy = "graceful_only" | "graceful_then_force" | "force";
export type ToolProcessStopOutcome =
  | "terminated"
  | "force_terminated"
  | "already_exited"
  | "unable_to_confirm";

/**
 * Hard storage and transport budgets for managed process sessions. These
 * limits apply to retained, model-visible state; total process output is only
 * counted after the retained buffers have reached their caps.
 */
export const TOOL_PROCESS_LIMITS = {
  maxActiveProcesses: 8,
  maxActiveProcessesPerSession: 4,
  maxRetainedSessions: 64,
  maxBufferedChunkChars: 65_536,
  maxBufferCharsPerProcess: 2_000_000,
  maxGlobalBufferChars: 16_000_000,
  maxGlobalArtifactChars: 16_000_000,
  maxGlobalArtifactSnapshots: 64,
  defaultOutputChunkChars: 262_144,
  maxOutputChunkChars: 2_000_000,
  maxCumulativeArtifactCharsPerProcess: 2_000_000,
  maxArtifactSnapshotsPerProcess: 2,
  maxInputChars: 8_192,
  maxEnvironmentEntries: 32,
  maxEnvironmentValueChars: 4_096,
  maxReadyPatternChars: 512,
  minStartupTimeoutMs: 100,
  maxStartupTimeoutMs: 120_000,
  maxOutputWaitMs: 30_000,
  maxStopGraceMs: 30_000,
  completedSessionRetentionMs: 15 * 60 * 1_000,
} as const;

export interface ToolProcessEnvironmentSummary {
  inheritedKeys: string[];
  overrideKeys: string[];
  redactedKeys: string[];
}

export interface ToolProcessExitInfo {
  exitCode: number | null;
  signal?: string;
  reason:
    | "completed"
    | "nonzero_exit"
    | "spawn_error"
    | "graceful_stop"
    | "force_stop"
    | "runtime_dispose"
    | "session_interrupted"
    | "startup_timeout"
    | "control_lost";
  spawnError?: {
    code?: string;
    message: string;
  };
}

/** Serializable public state; it never contains raw environment values. */
export interface ToolProcessSession {
  processSessionId: string;
  sessionId: string;
  toolCallId: string;
  status: ToolProcessStatus;
  pid?: number;
  processGroupId?: number;
  cwd: string;
  commandSummary: string;
  environmentSummary: ToolProcessEnvironmentSummary;
  interactionMode: ToolProcessInteractionMode;
  ptyAvailable: boolean;
  startedAt: string;
  readyAt?: string;
  endedAt?: string;
  lastOutputAt?: string;
  retainedStartCursor: number;
  nextCursor: number;
  totalOutputChars: number;
  droppedOutputChars: number;
  outputTruncated: boolean;
  exit?: ToolProcessExitInfo;
  orphanedReason?: string;
}

export interface ToolProcessOutputChunk {
  processSessionId: string;
  status: ToolProcessStatus;
  requestedCursor: number;
  startCursor: number;
  nextCursor: number;
  stdout: string;
  stderr: string;
  hasMore: boolean;
  waitTimedOut: boolean;
  cursorExpired: boolean;
  droppedBeforeCursor: number;
  totalOutputChars: number;
  outputTruncated: boolean;
  artifactUri?: string;
  artifactCapturedThroughCursor?: number;
  artifactTruncated?: boolean;
}

export interface ToolProcessInputResult {
  processSessionId: string;
  status: ToolProcessStatus;
  acceptedChars: number;
  appendedNewline: boolean;
  control?: "ctrl_c" | "ctrl_d";
}

export interface ToolProcessStopResult {
  processSessionId: string;
  status: ToolProcessStatus;
  outcome: ToolProcessStopOutcome;
  strategy: ToolProcessStopStrategy;
  gracefulWaitMs: number;
  exit?: ToolProcessExitInfo;
}

export type NetworkHttpMethod = "GET" | "HEAD" | "POST" | "PUT" | "PATCH" | "DELETE";

export type NetworkErrorType =
  | "dns"
  | "connection"
  | "tls"
  | "timeout"
  | "proxy"
  | "http"
  | "response_too_large"
  | "content_type"
  | "policy_denied"
  | "cancelled";

export interface NetworkRequestBody {
  kind: "json" | "text" | "base64";
  content: string;
  contentType?: string;
}

/** Serializable request contract consumed by the guarded network client. */
export interface NetworkRequestSpec {
  method: NetworkHttpMethod;
  url: string;
  headers?: Record<string, string>;
  query?: Record<string, string>;
  body?: NetworkRequestBody;
  timeoutMs: number;
  maxResponseBytes: number;
  maxRedirects: number;
  expectedContentTypes?: string[];
}

export interface NetworkRedirectSummary {
  status: number;
  fromUrl: string;
  toUrl: string;
}

export interface NetworkAttemptSummary {
  route: "system" | "direct";
  source?: string;
  outcome: "success" | "error";
  errorType?: NetworkErrorType;
}

export interface NetworkResponseSummary {
  status: number;
  ok: boolean;
  finalUrl: string;
  contentType?: string;
  sizeBytes: number;
  sha256: string;
  truncated: boolean;
  fetchedAt: string;
  redirects: NetworkRedirectSummary[];
  attempts: NetworkAttemptSummary[];
  headers?: Record<string, string>;
}

export interface DownloadArtifactResult {
  fileName: string;
  mimeType: string;
  sizeBytes: number;
  sha256: string;
  sourceUrl: string;
  finalUrl: string;
  artifactUri?: string;
  workspaceRelativePath?: string;
}

/** Redacted, bounded network metadata persisted with a tool execution audit. */
export interface NetworkAuditSummary {
  requestCount: number;
  methods: NetworkHttpMethod[];
  hosts: string[];
  routes: Array<"system" | "direct">;
  redirectCount: number;
  bytesReceived: number;
  status?: number;
  errorType?: NetworkErrorType;
}

export interface ToolModuleManifest {
  id: string;
  version: string;
  description: string;
  source: ToolModuleSource;
}

export interface ToolSelectionPolicy {
  alwaysAvailable?: boolean;
  groups?: string[];
  keywords?: string[];
  keywordGroups?: string[][];
  attachmentExtensions?: string[];
  mimeTypes?: string[];
  workflowOnly?: boolean;
  workerRoutes?: Array<"coding" | "vision">;
  /** For mixed-action tools, actions which may be projected into Provider schemas in plan mode. */
  planModeActions?: string[];
}

export interface ToolSelectionContext {
  prompt?: string;
  requestedGroups?: string[];
  requestedToolNames?: string[];
  activatedToolNames?: string[];
  attachmentExtensions?: string[];
  attachmentMimeTypes?: string[];
  workflowToolNames?: string[];
  workerRoutes?: Array<"coding" | "vision">;
  permissionMode?: PermissionMode;
  includeAll?: boolean;
}

export interface ToolCapabilityRequirement {
  name: string;
  required: boolean;
  fallback?: string;
  reason?: string;
}

export interface ToolAccessRequest {
  kind: ToolAccessKind;
  paths?: string[];
  cwd?: string;
  command?: string;
  hosts?: string[];
  systems?: string[];
  reason: string;
}

/** Optional call-specific permission profile resolved before approval. */
export interface ToolPermissionProfile {
  permissionCategory: ToolPermissionCategory;
  sideEffectLevel: SideEffectLevel;
  readOnly: boolean;
  /** Security-relevant state included in the approval HMAC but never shown verbatim. */
  approvalContext?: Record<string, unknown>;
  approvalPresentation?: ApprovalPresentation;
}

export interface ToolCheckpointPolicy {
  mode: ToolCheckpointMode;
  scope?: CheckpointScope;
  reason?: string;
  restoreOnFailure?: boolean;
}

export interface ToolAvailability {
  status: ToolAvailabilityStatus;
  available: boolean;
  missingCapabilities?: string[];
  fallbackCapabilities?: string[];
  reason?: string;
  warnings?: string[];
}

export interface ToolOutputArtifact {
  uri: string;
  fileName: string;
  mimeType: string;
  sizeBytes: number;
  sha256?: string;
  kind: ToolOutputArtifactKind;
  sourceToolName: string;
  summary: string;
  createdAt: string;
  workspaceId?: string;
  sessionId?: string;
  turnId?: string;
  toolCallId?: string;
  workspaceRelativePath?: string;
}

export interface DocumentMetadata {
  title?: string;
  author?: string;
  subject?: string;
  keywords?: string[];
  createdAt?: string;
  modifiedAt?: string;
  language?: string;
}

export interface DocumentPageSpec {
  size?: "A4" | "Letter";
  orientation?: "portrait" | "landscape";
  margins?: {
    top?: number;
    right?: number;
    bottom?: number;
    left?: number;
  };
}

export type DocumentBlock =
  | {
      type: "paragraph";
      text: string;
    }
  | {
      type: "heading";
      level: 1 | 2 | 3;
      text: string;
    }
  | {
      type: "bullet_list" | "numbered_list";
      items: string[];
    }
  | {
      type: "table";
      headers?: string[];
      rows: string[][];
    }
  | {
      type: "page_break";
    }
  | {
      type: "image";
      source: string;
      alt?: string;
      width?: number;
      height?: number;
    };

export interface DocumentSpec {
  title?: string;
  metadata?: DocumentMetadata;
  page?: DocumentPageSpec;
  blocks: DocumentBlock[];
}

export interface DocumentReadWarning {
  code: string;
  message: string;
}

export interface DocumentReadCitation {
  label: string;
  source: string;
  page?: number;
  section?: string;
}

export interface DocumentReadSection {
  kind?: "page" | "paragraph" | "heading" | "bullet_list" | "numbered_list";
  heading?: string;
  level?: 1 | 2 | 3;
  page?: number;
  text: string;
  items?: string[];
}

export interface DocumentReadTable {
  headers?: string[];
  rows: string[][];
  page?: number;
  section?: string;
}

export interface DocumentReadResult {
  format: "pdf" | "docx";
  source: string;
  metadata: DocumentMetadata & {
    pageCount?: number;
  };
  summary: string;
  sections: DocumentReadSection[];
  tables: DocumentReadTable[];
  citations: DocumentReadCitation[];
  extractedChars: number;
  truncated: boolean;
  warnings: DocumentReadWarning[];
}

export type StructuredJsonValue =
  | null
  | boolean
  | number
  | string
  | StructuredJsonValue[]
  | { [key: string]: StructuredJsonValue };

export type StructuredDocumentFormat =
  | "pdf"
  | "docx"
  | "xlsx"
  | "csv"
  | "tsv"
  | "pptx"
  | "ipynb"
  | "png"
  | "jpeg"
  | "webp"
  | "gif"
  | "tiff"
  | "zip";

export interface StructuredDocumentWarning {
  code: string;
  message: string;
  severity: "info" | "warning" | "high";
  category:
    | "content"
    | "compatibility"
    | "security"
    | "truncation"
    | "unsupported_capability";
  scope?: string;
  details?: Record<string, StructuredJsonValue>;
}

export interface StructuredSourceReference {
  kind: "workspace_path" | "artifact" | "attachment";
  reference: string;
  workspaceRelativePath?: string;
  artifactUri?: string;
  mimeType?: string;
  sizeBytes?: number;
}

export interface StructuredDocumentMetadata extends DocumentMetadata {
  formatVersion?: string;
  creatorApplication?: string;
  sizeBytes?: number;
  properties?: Record<string, StructuredJsonValue>;
}

export interface StructuredReadTruncation {
  truncated: boolean;
  reason?: "pagination" | "item_limit" | "character_limit" | "byte_limit" | "unsafe_content";
  returnedItems: number;
  totalItems?: number;
  nextCursor?: string;
}

export interface StructuredDocumentWriteResult {
  format: StructuredDocumentFormat;
  outputPath: string;
  sizeBytes: number;
  artifact: ToolOutputArtifact;
  warnings: StructuredDocumentWarning[];
  checkpointId?: string;
  undoAvailable: boolean;
}

export type TableFormat = "xlsx" | "csv" | "tsv";
export type TableCellScalar = string | number | boolean | null;
export type TableCellType = "blank" | "string" | "number" | "boolean" | "date" | "error" | "formula";

export interface TableFormulaSpec {
  /** Formula text without a leading '='. Formula execution is outside the Phase 20 contract. */
  expression: string;
  cachedValue?: TableCellScalar;
  cachedType?: Exclude<TableCellType, "formula">;
  calculationState: "cached" | "missing" | "stale" | "unknown";
}

export interface TableCellSpec {
  /** One-based row index. */
  row: number;
  /** One-based column index. */
  column: number;
  address?: string;
  type: TableCellType;
  value?: TableCellScalar;
  displayValue?: string;
  formula?: TableFormulaSpec;
}

export interface TableHeaderSpec {
  /** One-based column index. */
  column: number;
  label: string;
  sourceRow?: number;
}

export interface TableColumnSpec {
  /** One-based column index. */
  column: number;
  width?: number;
  hidden?: boolean;
}

export interface TableSheetSpec {
  name: string;
  state?: "visible" | "hidden" | "very_hidden";
  headers?: TableHeaderSpec[];
  cells: TableCellSpec[];
  rowCount?: number;
  columnCount?: number;
  mergedRanges?: string[];
  columns?: TableColumnSpec[];
  freezeHeaderRow?: boolean;
}

export interface TableDocumentSpec {
  title?: string;
  metadata?: StructuredDocumentMetadata;
  activeSheet?: string;
  sheets: TableSheetSpec[];
}

export interface TableReadResult {
  format: TableFormat;
  source: StructuredSourceReference;
  metadata: StructuredDocumentMetadata;
  warnings: StructuredDocumentWarning[];
  truncation: StructuredReadTruncation;
  summary: string;
  totalSheets: number;
  totalCells: number;
  returnedCells: number;
  sheets: TableSheetSpec[];
}

export interface PresentationBoundsSpec {
  /** Position and size in presentation inches. */
  x: number;
  y: number;
  width: number;
  height: number;
}

export interface PresentationTextStyleSpec {
  fontFace?: string;
  fontSize?: number;
  bold?: boolean;
  italic?: boolean;
  color?: string;
  align?: "left" | "center" | "right";
}

export type PresentationElementSpec =
  | {
      type: "title";
      text: string;
      bounds?: PresentationBoundsSpec;
      style?: PresentationTextStyleSpec;
    }
  | {
      type: "text";
      text: string;
      bounds?: PresentationBoundsSpec;
      style?: PresentationTextStyleSpec;
    }
  | {
      type: "list";
      items: string[];
      ordered?: boolean;
      bounds?: PresentationBoundsSpec;
      style?: PresentationTextStyleSpec;
    }
  | {
      type: "image";
      source: string;
      alt?: string;
      bounds?: PresentationBoundsSpec;
    }
  | {
      type: "table";
      headers?: string[];
      rows: TableCellScalar[][];
      bounds?: PresentationBoundsSpec;
    };

export interface SlideSpec {
  id?: string;
  title?: string;
  layoutName?: string;
  backgroundColor?: string;
  elements: PresentationElementSpec[];
  speakerNotes?: string[];
}

export interface PresentationSpec {
  title?: string;
  metadata?: StructuredDocumentMetadata;
  layout?: {
    width: number;
    height: number;
  };
  slides: SlideSpec[];
}

export interface PresentationReadResult {
  format: "pptx";
  source: StructuredSourceReference;
  metadata: StructuredDocumentMetadata;
  warnings: StructuredDocumentWarning[];
  truncation: StructuredReadTruncation;
  summary: string;
  totalSlides: number;
  returnedSlides: number;
  slides: SlideSpec[];
}

export type NotebookMimeBundle = Record<string, StructuredJsonValue>;

export type NotebookOutputSpec =
  | {
      outputType: "stream";
      name: "stdout" | "stderr";
      text: string;
    }
  | {
      outputType: "display_data";
      data: NotebookMimeBundle;
      metadata: Record<string, StructuredJsonValue>;
    }
  | {
      outputType: "execute_result";
      executionCount: number | null;
      data: NotebookMimeBundle;
      metadata: Record<string, StructuredJsonValue>;
    }
  | {
      outputType: "error";
      errorName: string;
      errorValue: string;
      traceback: string[];
    };

export interface NotebookCellSpec {
  id?: string;
  cellType: "markdown" | "code" | "raw";
  source: string;
  metadata: Record<string, StructuredJsonValue>;
  executionCount?: number | null;
  outputs?: NotebookOutputSpec[];
}

export interface NotebookSpec {
  nbformat: 4;
  nbformatMinor: number;
  metadata: Record<string, StructuredJsonValue>;
  cells: NotebookCellSpec[];
}

export interface NotebookReadResult {
  format: "ipynb";
  source: StructuredSourceReference;
  metadata: StructuredDocumentMetadata;
  warnings: StructuredDocumentWarning[];
  truncation: StructuredReadTruncation;
  summary: string;
  notebook: NotebookSpec;
  totalCells: number;
  returnedCells: number;
}

export type ImageFormat = "png" | "jpeg" | "webp" | "gif" | "tiff";

export interface ImageTechnicalMetadata {
  width: number;
  height: number;
  pixelCount: number;
  colorSpace?: string;
  channels?: number;
  bitDepth?: string;
  densityDpi?: number;
  orientation?: number;
  frameCount?: number;
  hasAlpha?: boolean;
  isProgressive?: boolean;
  exif?: Record<string, StructuredJsonValue>;
}

export interface ImageMetadataResult {
  format: ImageFormat;
  source: StructuredSourceReference;
  metadata: StructuredDocumentMetadata & ImageTechnicalMetadata;
  warnings: StructuredDocumentWarning[];
  truncation: StructuredReadTruncation;
  preview?: ToolOutputArtifact;
  visionWorkerHint: {
    toolName: "invoke_vision_worker";
    automaticInvocation: false;
    reason: string;
  };
}

export interface ArchiveEntryResult {
  path: string;
  kind: "file" | "directory" | "symlink" | "other";
  compressedSize: number;
  uncompressedSize: number;
  compressionRatio?: number;
  encrypted: boolean;
  unsafe: boolean;
  unsafeReason?: string;
  linkTarget?: string;
  modifiedAt?: string;
  warnings: StructuredDocumentWarning[];
}

export interface ArchiveListResult {
  format: "zip";
  source: StructuredSourceReference;
  metadata: StructuredDocumentMetadata;
  warnings: StructuredDocumentWarning[];
  truncation: StructuredReadTruncation;
  entries: ArchiveEntryResult[];
  totalEntries: number;
  returnedEntries: number;
  totalCompressedBytes: number;
  totalUncompressedBytes: number;
}

export interface ToolResult<TStructured = unknown> {
  toolName: string;
  callId: string;
  startedAt: string;
  endedAt: string;
  success: boolean;
  output: string;
  structuredContent?: TStructured;
  artifacts?: ToolOutputArtifact[];
  networkAudit?: NetworkAuditSummary;
  control?: ToolRuntimeControl;
  operationAudit?: ToolOperationAuditSummary;
  error?: string;
}

export interface ToolOperationAuditSummary {
  action: string;
  argumentSummary: Record<string, unknown>;
  resultStatus: string;
  durationMs: number;
  headBefore?: string;
  headAfter?: string;
  changedPaths?: string[];
}

export interface ToolDefinition {
  name: string;
  description: string;
  inputSchema: Record<string, unknown>;
  readOnly: boolean;
  permissionCategory: ToolPermissionCategory;
  sideEffectLevel: SideEffectLevel;
  timeoutCategory: TimeoutCategory;
  moduleId?: string;
  moduleVersion?: string;
  version?: string;
  displayName?: string;
  groups?: string[];
  selection?: ToolSelectionPolicy;
  capabilityRequirements?: ToolCapabilityRequirement[];
  checkpoint?: ToolCheckpointPolicy;
}

export interface ToolExecutionContext {
  workspaceRoot: string;
  sessionId: string;
  permissionMode: PermissionMode;
  sessionPersistence: ToolSessionPersistence;
  signal?: AbortSignal;
}

export interface ToolSpec<TArgs = unknown, TResult = unknown> extends ToolDefinition {
  execute: (args: TArgs, context: ToolExecutionContext) => Promise<ToolResult<TResult>>;
}

export interface ToolSessionPersistence {
  updatePlanItems: (sessionId: string, items: PlanItem[]) => Promise<PlanItem[]>;
  recordApproval: (record: ApprovalRecord) => Promise<void>;
  createCheckpoint: (input: {
    sessionId: string;
    scope: CheckpointScope;
    trackedFiles: string[];
    reason: string;
    turnId?: string;
    toolCallId?: string;
    sourceToolName?: string;
  }) => Promise<CheckpointRecord>;
}

export interface ProviderToolDefinition {
  type: "function";
  function: {
    name: string;
    description: string;
    parameters: Record<string, unknown>;
  };
}

export interface ConversationMessage {
  role: "system" | "user" | "assistant" | "tool";
  content: string | null;
  name?: string;
  tool_call_id?: string;
  reasoning_content?: string;
  tool_calls?: Array<{
    id: string;
    type: "function";
    function: {
      name: string;
      arguments: string;
    };
  }>;
}

export interface AssistantResponse {
  content: string;
  reasoningContent?: string;
  toolCalls: ToolCall[];
  finishReason?: string;
  usage?: TokenUsageSnapshot;
  providerUsage?: Record<string, unknown>;
}

export interface StreamCallbacks {
  onTextDelta?: (chunk: string) => void;
  onReasoningDelta?: (chunk: string) => void;
}

export interface ModelCompletionRequest {
  route: RouteProfile;
  systemPrompt: string;
  messages: ConversationMessage[];
  tools: ProviderToolDefinition[];
  stream: boolean;
  temperature: number;
  maxOutputTokens?: number;
  /** Optional per-request no-data timeout; active streamed chunks renew this deadline. */
  inactivityTimeoutMs?: number;
  signal?: AbortSignal;
}

export interface ModelClient {
  streamCompletion: (
    request: ModelCompletionRequest,
    callbacks?: StreamCallbacks,
  ) => Promise<AssistantResponse>;
}

export interface RunCallbacks {
  onSessionSelected?: (sessionId: string) => void;
  onTextDelta?: (chunk: string) => void;
  onReasoningDelta?: (chunk: string) => void;
  onToolBatchStart?: (batch: ToolBatchStart) => void;
  onToolStart?: (toolCall: ToolCall) => void;
  onToolEnd?: (result: ToolResult) => void;
  onUserInputRequested?: (request: UserInputRequestRecord) => void;
}
