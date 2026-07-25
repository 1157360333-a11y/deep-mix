import { randomUUID } from "node:crypto";
import type {
  AssistantResponse,
  ContextBudgetScope,
  ContextBudgetSnapshot,
  ContextCompactionRecord,
  ContextSummaryRecord,
  ConversationMessage,
  DeepSeekProviderConfig,
  HistoryIntegrityScope,
  McpServerStatus,
  MessageRecord,
  ModelClient,
  PermissionMode,
  RuntimeCapabilitySnapshot,
  RoutingDecision,
  RouteTarget,
  RunCallbacks,
  SessionEvent,
  SessionRecord,
  SkillRecord,
  TokenUsageSnapshot,
  ToolCall,
  ToolProcessSession,
  ToolResult,
  UserInputAnswer,
  UserInputRequestRecord,
  VisionImageRef,
  WorkflowDefinition,
  WorkerTask,
} from "../../shared-schema/src/index.js";
import { USER_INPUT_LIMITS } from "../../shared-schema/src/index.js";
import {
  SessionStore,
  type UserInputClaimSubmission,
} from "../../persistence/src/index.js";
import { SpecialistBroker } from "../../specialist-broker/src/index.js";
import { PromptCompiler } from "./prompt-compiler.js";
import {
  buildSessionTitleMessages,
  normalizeGeneratedSessionTitle,
  SESSION_TITLE_SYSTEM_PROMPT,
} from "./session-title.js";
import { ToolRuntime, PermissionRequiredError } from "../../tool-runtime/src/index.js";
import type { ToolNetworkService } from "../../tool-runtime/src/network/index.js";
import { DeepSeekClient } from "./deepseek-client.js";
import {
  formatPostExposureToolSummary,
  HistoryIntegrityError,
  type HistoryIntegrityReport,
  inspectHistoryForResume,
  isPostExposureToolSummaryEligible,
  PROVIDER_TURN_CONTEXT_METADATA_KEY,
  ProviderRequestError,
  TOOL_CONTEXT_SUMMARY_CANDIDATE_METADATA_KEY,
} from "./history-integrity.js";
import {
  accumulateUsageSnapshots,
  createEstimatedUsageSnapshot,
  estimateAssistantOutputTokens,
  estimateTextTokens,
} from "./context-usage.js";
import { SkillEngine } from "../../skill-engine/src/index.js";
import { McpRegistry } from "../../mcp-hub/src/index.js";
import {
  createFallbackRoutingDecision,
  createGovernorRouteProfile,
  extractContextRefs,
  extractImageRef,
  inferVisionSourceType,
  inferVisionTaskType,
  loadDeepSeekProviderConfig,
  resolveRoutingDecision,
} from "../../route-resolver/src/index.js";
import { SupervisorReviewService } from "./supervisor-review-service.js";
import { HookBus, type HookHandler, WorkflowRuntime } from "../../workflow-runtime/src/index.js";

function now(): string {
  return new Date().toISOString();
}

function throwIfAborted(signal: AbortSignal | undefined): void {
  if (!signal?.aborted) return;
  throw signal.reason instanceof Error ? signal.reason : new Error("Turn interrupted.");
}

function isHistoryProviderError(error: unknown): boolean {
  return /Messages with role 'tool' must be a response to a preceding message with 'tool_calls'|reasoning_content.*must be passed back/i.test(
    (error as Error).message,
  );
}

function buildConversationMessages(messages: MessageRecord[]): ConversationMessage[] {
  return messages.map((message) => {
    if (message.role === "tool") {
      return {
        role: "tool",
        content: message.content,
        tool_call_id: message.toolCallId,
      };
    }

    if (message.role === "assistant") {
      const toolCalls =
        message.toolCalls && message.toolCalls.length > 0
          ? message.toolCalls.map((toolCall) => ({
              id: toolCall.id,
              type: "function" as const,
              function: {
                name: toolCall.name,
                arguments: toolCall.rawArguments,
              },
            }))
          : undefined;
      return {
        role: "assistant",
        content: message.content,
        ...(toolCalls ? { reasoning_content: message.reasoningContent ?? "" } : {}),
        ...(toolCalls ? { tool_calls: toolCalls } : {}),
      };
    }

    return {
      role: message.role,
      content: message.content,
      name: message.name,
    };
  });
}

function isProviderTurnContextMessage(message: MessageRecord, turnId: string): boolean {
  const marker = message.metadata?.[PROVIDER_TURN_CONTEXT_METADATA_KEY];
  return message.turnId === turnId && (
    marker === true || (
      typeof marker === "object" &&
      marker !== null &&
      (marker as { version?: unknown }).version === 1
    )
  );
}

function isWorkerToolCall(toolName: string): boolean {
  return toolName === "invoke_coding_worker" || toolName === "invoke_vision_worker";
}

function hasExplicitWorkerInstruction(prompt: string): boolean {
  return /\b(coding worker|vision worker|invoke_coding_worker|invoke_vision_worker|glm|kimi)\b|编码 worker|视觉 worker/i.test(
    prompt,
  );
}

function buildAutoCodingWorkerTask(prompt: string, routeDecision: RoutingDecision): WorkerTask {
  const contextRefs = extractContextRefs(prompt);
  return {
    workerType: "coding",
    objective: prompt.trim(),
    constraints: [
      "Keep deployment, secret, and environment configuration unchanged unless the user explicitly requested otherwise.",
      "Return only a structured code artifact and apply_patch-compatible patch draft.",
    ],
    contextRefs:
      contextRefs.length > 0
        ? [
            ...contextRefs,
            {
              refType: "summary",
              label: "Routing decision",
              summary: routeDecision.reasonSummary.slice(0, 4000),
            },
          ]
        : [
            {
              refType: "summary",
              label: "User request",
              summary: prompt.trim().slice(0, 4000),
            },
            {
              refType: "summary",
              label: "Routing decision",
              summary: routeDecision.reasonSummary.slice(0, 4000),
            },
          ],
    expectedOutput: "code_artifact",
    acceptanceChecks: [
      "Return a valid CodeArtifact summary.",
      "Return a valid apply_patch envelope.",
      "List changed files and suggested test commands.",
    ],
  };
}

function buildAutoVisionWorkerInput(
  prompt: string,
  routeDecision: RoutingDecision,
):
  | {
      workerType: "vision";
      taskType: ReturnType<typeof inferVisionTaskType>;
      image: VisionImageRef;
      instructions: string;
      constraints: string[];
    }
  | undefined {
  const imageRef = extractImageRef(prompt);
  if (!imageRef) {
    return undefined;
  }

  return {
    workerType: "vision",
    taskType: inferVisionTaskType(prompt),
    image: {
      sourceType: inferVisionSourceType(prompt, imageRef),
      ref: imageRef,
    },
    instructions: `Follow the routing policy decision and extract only the high-signal visual evidence. ${routeDecision.reasonSummary}`.trim(),
    constraints: ["Return only structured vision artifact data."],
  };
}

function createSyntheticToolCall(name: string, args: unknown): ToolCall {
  return {
    id: `route-${randomUUID()}`,
    name,
    arguments: args,
    rawArguments: JSON.stringify(args),
  };
}

const TOOL_LOOPS_PER_CYCLE = 12;
const DEFAULT_MAX_TOOL_CYCLES = 8;
const MAX_TOOL_CYCLES_LIMIT = 32;
const MAX_IDENTICAL_TOOL_BATCHES = 3;
const TOOL_CYCLE_BOUNDARY_MAX_OUTPUT_TOKENS = 2_048;
const TOOL_CYCLE_BOUNDARY_INACTIVITY_TIMEOUT_MS = 60_000;
const TOOL_CYCLE_CONTINUE_MARKER = "[[DEEP_MIX_CONTINUE]]";
const TOOL_CYCLE_COMPLETE_MARKER = "[[DEEP_MIX_COMPLETE]]";
const MAX_AUTONOMOUS_RECOVERY_ATTEMPTS = 2;
const MAX_PROVIDER_TIMEOUT_RECOVERY_ATTEMPTS = 2;

function isProviderTimeoutError(error: unknown): boolean {
  let current: unknown = error;
  for (let depth = 0; depth < 4 && current && typeof current === "object"; depth += 1) {
    const candidate = current as { name?: unknown; message?: unknown; cause?: unknown };
    if (candidate.name === "TimeoutError") return true;
    if (typeof candidate.message === "string" && /(?:timed?\s*out|timeout|received no data)/iu.test(candidate.message)) {
      return true;
    }
    current = candidate.cause;
  }
  return false;
}

function toolResultStructuredError(result: ToolResult): { type?: string; retryable?: boolean } | undefined {
  const structured = result.structuredContent as {
    error?: { type?: string; retryable?: boolean };
  } | undefined;
  return structured?.error;
}

function toolResultErrorType(result: ToolResult): string | undefined {
  return toolResultStructuredError(result)?.type;
}

function isRecoverableToolFailure(result: ToolResult): boolean {
  const error = toolResultStructuredError(result);
  return !result.success && error?.retryable !== false && [
    "invalid_arguments",
    "invalid_path",
    "tool_not_selected",
    "repeated_tool_call",
    "command_failed",
    "network_error",
    "provider_error",
    "timeout",
  ].includes(error?.type ?? "");
}

function looksLikePrematureAbandonment(content: string): boolean {
  return /(?:cannot|can't|unable|disabled|not available|you need to|do it manually|run it yourself)|(?:无法|不能|被禁用|不可用|你需要|请你手动|自行运行|双击|只差一步|附件.*在哪)/iu.test(
    content,
  );
}

function shouldAutonomouslyRetry(response: AssistantResponse, lastToolResults: ToolResult[]): boolean {
  if (response.toolCalls.length > 0) return false;
  if (["length", "insufficient_system_resource", "tool_calls"].includes(response.finishReason ?? "")) return true;
  if (!response.content.trim()) return lastToolResults.length > 0;
  return lastToolResults.some(isRecoverableToolFailure) && looksLikePrematureAbandonment(response.content);
}

function buildRecoveryInstruction(lastToolResults: ToolResult[]): string {
  const failures = lastToolResults
    .filter((result) => !result.success)
    .map((result) => `${result.toolName}:${toolResultErrorType(result) ?? "unknown_error"}`)
    .join(", ");
  return [
    "## Runtime Recovery Required",
    `The previous tool batch did not complete the task${failures ? ` (${failures})` : ""}.`,
    "Do not claim that a capability is globally disabled based on one failed or unselected call.",
    "Correct the arguments or use another tool from the current Provider tool set, then continue until the requested deliverable is created and verified.",
    "If a tool result says retryable=false, do not repeat the identical tool name and arguments in this turn; use a genuinely different capability or report the bounded failure transparently.",
    "Use only the current workspace and workspace-relative paths. Do not ask the user to run a command that the available runtime tools can perform.",
  ].join("\n");
}

interface ToolLoopState {
  toolCycle: number;
  toolLoopsInCycle: number;
  previousToolBatchSignature?: string;
  identicalToolBatchCount: number;
}

const TOOL_CONTEXT_SUMMARY_MAX_CHARS = 1_200;

interface PersistedToolContextSummaryCandidate {
  version: 1;
  summary: string;
  rawOutputChars: number;
  keyPaths?: string[];
  keyFiles?: string[];
  command?: string;
  rawOutputRef?: string;
}

function readBoundedInteger(
  value: string | undefined,
  fallback: number,
  minimum: number,
  maximum: number,
): number {
  if (!value) return fallback;
  const parsed = Number.parseInt(value, 10);
  return Number.isFinite(parsed) ? Math.min(maximum, Math.max(minimum, parsed)) : fallback;
}

function isLikelyContinuationRequest(prompt: string): boolean {
  const normalized = prompt.trim().toLocaleLowerCase();
  if (!normalized || normalized.length > 80) return false;
  if (/^[?？!！…。.\s]+$/u.test(normalized)) return true;
  return /继续|接着|然后呢|再试|试一下|重试|刚才|发生什么|什么意思|为什么|怎么办|继续做|继续处理|go on|continue|try again|retry/u.test(
    normalized,
  );
}

function buildToolSelectionPrompt(
  requestSummary: string,
  turnId: string,
  recentMessages: MessageRecord[],
): string {
  const priorUserMessages = isLikelyContinuationRequest(requestSummary)
    ? recentMessages
      .filter((message) => message.role === "user" && message.turnId !== turnId)
      .slice(-8)
    : [];
  const hints = priorUserMessages
    .map((message) => message.content)
    .filter(Boolean)
    .join("\n\n")
    .slice(-12_000);
  return hints
    ? `${requestSummary}\n\n[Recent task tool-selection context]\n${hints}`
    : requestSummary;
}

function toolCycleBoundaryInstruction(cycle: number, maximumCycles: number): string {
  if (cycle >= maximumCycles) {
    return [
      "## Tool Cycle Safety Boundary",
      `You have completed ${cycle} tool cycles (${TOOL_LOOPS_PER_CYCLE} tool-bearing model iterations per cycle).`,
      "Do not call tools. Return one concise best complete or partial user-facing answer now.",
      "Do not reproduce file bodies, patches, logs, or earlier reasoning in this boundary response.",
      "State any unfinished work and how it can be continued without describing this internal protocol.",
      `End with ${TOOL_CYCLE_COMPLETE_MARKER}.`,
    ].join("\n");
  }
  return [
    "## Tool Cycle Boundary",
    `You have completed ${TOOL_LOOPS_PER_CYCLE} tool-bearing model iterations in cycle ${cycle}.`,
    "Do not call tools in this response. Decide whether the user's task is complete in a concise checkpoint only.",
    "Do not reproduce file bodies, patches, logs, or earlier reasoning in this boundary response.",
    `If complete, give the final user-facing answer and end with ${TOOL_CYCLE_COMPLETE_MARKER}.`,
    `If more work remains, give a concise progress checkpoint with completed work, pending work, and the next action, then end with ${TOOL_CYCLE_CONTINUE_MARKER}.`,
  ].join("\n");
}

function parseToolCycleBoundaryResponse(
  response: AssistantResponse,
  forceComplete: boolean,
): { continueRequested: boolean; content: string } {
  const continueMarked = response.content.includes(TOOL_CYCLE_CONTINUE_MARKER);
  const content = response.content
    .replaceAll(TOOL_CYCLE_CONTINUE_MARKER, "")
    .replaceAll(TOOL_CYCLE_COMPLETE_MARKER, "")
    .trim();
  return {
    continueRequested: !forceComplete && (
      continueMarked ||
      response.toolCalls.length > 0 ||
      content.length === 0 ||
      response.finishReason === "length"
    ),
    content,
  };
}

function canonicalJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
  if (value && typeof value === "object") {
    return `{${Object.entries(value as Record<string, unknown>)
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([key, entry]) => `${JSON.stringify(key)}:${canonicalJson(entry)}`)
      .join(",")}}`;
  }
  return JSON.stringify(value) ?? "undefined";
}

function toolCallSignature(call: ToolCall): string {
  if (call.arguments !== undefined) return `${call.name}:${canonicalJson(call.arguments)}`;
  try {
    return `${call.name}:${canonicalJson(JSON.parse(call.rawArguments))}`;
  } catch {
    return `${call.name}:${call.rawArguments.replace(/\s+/g, " ").trim()}`;
  }
}

function toolBatchSignature(toolCalls: ToolCall[]): string {
  return toolCalls.map(toolCallSignature).join("\n");
}

function sameAnswerValue(left: UserInputAnswer["value"], right: UserInputAnswer["value"]): boolean {
  return JSON.stringify(left) === JSON.stringify(right);
}

function validateUserInputAnswers(
  request: UserInputRequestRecord,
  answers: UserInputAnswer[],
): UserInputAnswer[] {
  if (answers.length > request.questions.length) {
    throw new Error(`Too many answers for user-input request ${request.requestId}.`);
  }
  const answersByQuestion = new Map<string, UserInputAnswer>();
  for (const answer of answers) {
    if (answersByQuestion.has(answer.questionId)) {
      throw new Error(`Duplicate answer for question ${answer.questionId}.`);
    }
    answersByQuestion.set(answer.questionId, answer);
  }
  for (const question of request.questions) {
    const answer = answersByQuestion.get(question.id);
    if (!answer) {
      if (question.required) throw new Error(`Missing required answer for question ${question.id}.`);
      continue;
    }
    const optionIds = new Set(question.options?.map((option) => option.id) ?? []);
    if (answer.source === "default_accepted") {
      if (question.defaultValue === undefined || !sameAnswerValue(answer.value, question.defaultValue)) {
        throw new Error(`Answer for ${question.id} does not accept its declared default.`);
      }
    }
    if (question.kind === "confirm") {
      if (typeof answer.value !== "boolean" || answer.source === "selected_option") {
        throw new Error(`Question ${question.id} requires an explicit boolean confirmation.`);
      }
      continue;
    }
    if (question.kind === "text") {
      if (typeof answer.value !== "string" || answer.value.length > USER_INPUT_LIMITS.maxFreeformChars) {
        throw new Error(`Question ${question.id} requires bounded text.`);
      }
      if (question.required && !answer.value.trim()) {
        throw new Error(`Question ${question.id} requires non-empty text.`);
      }
      continue;
    }
    if (question.kind === "single_select") {
      if (typeof answer.value !== "string") {
        throw new Error(`Question ${question.id} requires one option id or freeform string.`);
      }
      if (answer.value.length > USER_INPUT_LIMITS.maxFreeformChars) {
        throw new Error(`Question ${question.id} exceeds the bounded answer length.`);
      }
      const selectedKnownOption = optionIds.has(answer.value);
      if (!selectedKnownOption && (!question.allowFreeform || answer.source !== "freeform")) {
        throw new Error(`Question ${question.id} answer is not a declared option.`);
      }
      if (selectedKnownOption && answer.source === "freeform") {
        throw new Error(`Question ${question.id} selected a declared option but marked it as freeform.`);
      }
      if (!selectedKnownOption && question.required && !answer.value.trim()) {
        throw new Error(`Question ${question.id} requires non-empty freeform input.`);
      }
      continue;
    }
    if (!Array.isArray(answer.value) || answer.value.some((value) => typeof value !== "string")) {
      throw new Error(`Question ${question.id} requires an array of option ids.`);
    }
    if (
      new Set(answer.value).size !== answer.value.length ||
      answer.value.length > USER_INPUT_LIMITS.maxOptionsPerQuestion
    ) {
      throw new Error(`Question ${question.id} contains duplicate or excessive selections.`);
    }
    if (question.required && answer.value.length === 0) {
      throw new Error(`Question ${question.id} requires at least one selection.`);
    }
    if (answer.value.some((value) => value.length > USER_INPUT_LIMITS.maxFreeformChars)) {
      throw new Error(`Question ${question.id} contains an overlong selection.`);
    }
    const unknown = answer.value.filter((value) => !optionIds.has(value));
    if (unknown.length > 0 && (!question.allowFreeform || answer.source !== "freeform")) {
      throw new Error(`Question ${question.id} contains an unknown option.`);
    }
  }
  for (const questionId of answersByQuestion.keys()) {
    if (!request.questions.some((question) => question.id === questionId)) {
      throw new Error(`Unknown question id in answer: ${questionId}.`);
    }
  }
  return request.questions
    .map((question) => answersByQuestion.get(question.id))
    .filter((answer): answer is UserInputAnswer => Boolean(answer));
}

function renderUserInputAnswer(request: UserInputRequestRecord, answers: UserInputAnswer[]): string {
  const questions = new Map(request.questions.map((question) => [question.id, question]));
  return [
    `[Structured user input response: ${request.requestId}]`,
    ...answers.map((answer) =>
      `${questions.get(answer.questionId)?.prompt ?? answer.questionId}: ${JSON.stringify(answer.value)}`),
  ].join("\n");
}

export interface GovernorRuntimeOptions {
  workspaceRoot: string;
  permissionMode?: PermissionMode;
  environment?: NodeJS.ProcessEnv;
  networkService?: ToolNetworkService;
  modelClient?: ModelClient;
  specialistBroker?: SpecialistBroker;
}

export interface RunTurnResult {
  sessionId: string;
  session: SessionRecord;
  finalResponse: string;
  pendingUserInput?: UserInputRequestRecord;
}

interface PromptContextSnapshot {
  skillDiscovery: Awaited<ReturnType<SkillEngine["discoverSkills"]>>;
  matchedSkills: Awaited<ReturnType<SkillEngine["selectSkills"]>>;
  workflowDiscovery: Awaited<ReturnType<WorkflowRuntime["discoverWorkflows"]>>;
  mcpStatuses: McpServerStatus[];
  extensionErrors: {
    skills: string[];
    workflows: string[];
    mcp: string[];
  };
}

export class GovernorRuntime {
  private readonly activeTurnControllers = new Map<string, AbortController>();

  private readonly pendingTurnContinuations = new Set<string>();

  private initializationPromise?: Promise<void>;

  private readonly sessionStore: SessionStore;

  private readonly promptCompiler: PromptCompiler;

  private readonly toolRuntime: ToolRuntime;

  private readonly specialistBroker: SpecialistBroker;

  private readonly skillEngine: SkillEngine;

  private readonly mcpRegistry: McpRegistry;

  private readonly workflowRuntime: WorkflowRuntime;

  private readonly hookBus: HookBus;

  private readonly supervisorReviewService: SupervisorReviewService;

  private readonly deepSeekConfig: DeepSeekProviderConfig;

  private readonly routeProfile: ReturnType<typeof createGovernorRouteProfile>;

  private readonly modelClient: ModelClient;

  private readonly maxToolCycles: number;

  public constructor(options: GovernorRuntimeOptions) {
    const environment = options.environment ?? process.env;
    this.deepSeekConfig = loadDeepSeekProviderConfig(options.workspaceRoot, environment, {
      allowMissingProfileForInjectedClient: Boolean(options.modelClient),
    });
    this.routeProfile = createGovernorRouteProfile(this.deepSeekConfig);
    this.sessionStore = new SessionStore(options.workspaceRoot);
    this.hookBus = new HookBus();
    this.skillEngine = new SkillEngine(options.workspaceRoot);
    this.mcpRegistry = new McpRegistry(options.workspaceRoot);
    this.specialistBroker =
      options.specialistBroker ??
      new SpecialistBroker({
        workspaceRoot: options.workspaceRoot,
        sessionStore: this.sessionStore,
      });
    this.promptCompiler = new PromptCompiler({
      model: this.deepSeekConfig.model,
      contextWindow: this.deepSeekConfig.contextWindow,
      softLimitTokens: this.deepSeekConfig.contextSoftLimitTokens,
      compactThresholdTokens: this.deepSeekConfig.contextCompactThresholdTokens,
      reserveOutputTokens: this.deepSeekConfig.contextReserveOutputTokens,
      summaryMaxTokens: this.deepSeekConfig.contextSummaryMaxTokens,
      recentTailMaxTokens: this.deepSeekConfig.contextRecentTailMaxTokens,
      legacyMaxMessages: this.deepSeekConfig.maxHistoryMessages > 0 ? this.deepSeekConfig.maxHistoryMessages : undefined,
      legacyMaxChars: this.deepSeekConfig.maxHistoryMessages > 0 ? this.deepSeekConfig.historyCharBudget : undefined,
      replyStyle: this.deepSeekConfig.replyStyle,
    });
    this.toolRuntime = new ToolRuntime({
      workspaceRoot: options.workspaceRoot,
      sessionStore: this.sessionStore,
      permissionMode: options.permissionMode ?? "auto",
      environment,
      networkService: options.networkService,
      specialistBroker: this.specialistBroker,
      mcpRegistry: this.mcpRegistry,
    });
    this.workflowRuntime = new WorkflowRuntime(options.workspaceRoot, this.sessionStore, this.toolRuntime, this.hookBus);
    this.supervisorReviewService = new SupervisorReviewService(
      this.sessionStore,
      this.toolRuntime,
      this.specialistBroker,
    );
    this.modelClient = options.modelClient ?? new DeepSeekClient(this.deepSeekConfig);
    this.maxToolCycles = readBoundedInteger(
      environment.DEEP_MIX_MAX_TOOL_CYCLES,
      DEFAULT_MAX_TOOL_CYCLES,
      1,
      MAX_TOOL_CYCLES_LIMIT,
    );
  }

  public async initialize(): Promise<void> {
    if (this.initializationPromise) return this.initializationPromise;
    this.initializationPromise = (async () => {
      await this.sessionStore.ensureInitialized();
      await this.sessionStore.recoverActiveSession();
      await this.mcpRegistry.initialize();
      await this.toolRuntime.initialize();
      this.toolRuntime.refreshMcpTools();
    })().catch((error) => {
      this.initializationPromise = undefined;
      throw error;
    });
    return this.initializationPromise;
  }

  public async dispose(): Promise<void> {
    await this.toolRuntime.dispose();
  }

  public async getRuntimeCapabilities(): Promise<RuntimeCapabilitySnapshot> {
    await this.initialize();
    return this.toolRuntime.getCapabilitySnapshot();
  }

  public async listManagedProcesses(sessionId: string): Promise<ToolProcessSession[]> {
    await this.initialize();
    return this.toolRuntime.listManagedProcesses(sessionId);
  }

  public async stopManagedProcess(sessionId: string, processSessionId: string): Promise<ToolResult> {
    await this.initialize();
    return this.toolRuntime.executeManualTool(
      "stop_process",
      {
        processSessionId,
        strategy: "graceful_then_force",
      },
      sessionId,
    );
  }

  public async resolveResumeTarget(sessionId?: string): Promise<SessionRecord> {
    const session = await this.sessionStore.resolveMostRecentResumableSession(sessionId);
    if (!session) {
      throw new Error("No resumable session found.");
    }
    const messages = await this.sessionStore.loadMessages(session.sessionId);
    try {
      const inspection = inspectHistoryForResume(messages, session.status);
      await this.recordHistoryIntegrity(session.sessionId, session.lastTurnId, "resume_check", inspection.report);
    } catch (error) {
      if (error instanceof HistoryIntegrityError) {
        await this.recordHistoryIntegrity(session.sessionId, session.lastTurnId, "resume_check", error.report);
      }
      throw error;
    }
    return session;
  }

  public async interruptSession(sessionId: string, reason: string): Promise<void> {
    const session = await this.sessionStore.loadSession(sessionId);
    if (!session) {
      await this.toolRuntime.stopSessionProcesses(sessionId, "session_interrupted");
      return;
    }
    const activeTurnController = this.activeTurnControllers.get(sessionId);
    const pendingUserInputs = await this.sessionStore.listUnsettledUserInputRequests(sessionId);
    for (const state of pendingUserInputs) {
      await this.sessionStore.recordUserInputResume({
        recordType: "user_input_resume",
        requestId: state.request.requestId,
        sessionId,
        turnId: state.request.turnId,
        toolCallId: state.request.toolCallId,
        createdAt: now(),
        status: "interrupted",
        error: reason,
      });
    }
    await this.sessionStore.updateSession(sessionId, (current) => {
      const endedAt = now();
      const latestTaskDuration = current.latestTaskDuration
        ? {
            ...current.latestTaskDuration,
            endedAt,
            durationMs: Math.max(0, endedAt ? new Date(endedAt).getTime() - new Date(current.latestTaskDuration.startedAt).getTime() : 0),
            status: "interrupted" as const,
          }
        : current.latestTaskDuration;
      return {
        ...current,
        status: "interrupted",
        activeTurnId: undefined,
        latestTaskDuration,
      };
    });
    if (activeTurnController && !activeTurnController.signal.aborted) {
      activeTurnController.abort(new Error(reason));
    }
    await this.toolRuntime.stopSessionProcesses(sessionId, "session_interrupted");
    if (!activeTurnController && session.activeTurnId) {
      await this.sessionStore.appendEvent(sessionId, {
        recordType: "turn",
        turnId: session.activeTurnId,
        sessionId,
        createdAt: now(),
        startedAt: now(),
        endedAt: now(),
        status: "interrupted",
        requestSummary: "Interrupted by runtime",
        userMessageId: "interrupted",
        toolCallIds: [],
        error: reason,
      });
    }
  }

  public async cancelWorkerSession(workerSessionId: string, reason: string): Promise<void> {
    await this.specialistBroker.cancelWorkerSession(workerSessionId, reason);
  }

  public getSupervisorReviewService(): SupervisorReviewService {
    return this.supervisorReviewService;
  }

  public registerHook(name: string, handler: HookHandler): () => void {
    return this.hookBus.register(name, handler);
  }

  public async listSkills(query?: string): Promise<SkillRecord[]> {
    return this.skillEngine.listSkills(query);
  }

  public async listMcpServerStatuses(): Promise<McpServerStatus[]> {
    await this.initialize();
    return this.mcpRegistry.listServerStatuses();
  }

  public async listWorkflows(): Promise<WorkflowDefinition[]> {
    await this.initialize();
    return (await this.workflowRuntime.discoverWorkflows()).workflows;
  }

  public async runWorkflow(input: { name: string; sessionId?: string }) {
    await this.initialize();
    return this.workflowRuntime.runWorkflow(input);
  }

  public async compactSession(sessionId: string): Promise<{
    compacted: boolean;
    summaryId?: string;
    messageCountCompacted: number;
    beforeTokens: number;
    afterTokens: number;
    tokensSaved: number;
  }> {
    await this.initialize();
    const session = await this.sessionStore.loadSession(sessionId);
    if (!session) {
      throw new Error(`Unknown session: ${sessionId}`);
    }
    if (session.status === "running" || session.status === "ask_permission") {
      throw new Error("Cannot compact a session while a turn or approval is active.");
    }

    const messages = await this.sessionStore.loadMessages(sessionId);
    const summaries = await this.loadContextSummaries(sessionId);
    const previousBoundaryId = [...summaries]
      .reverse()
      .find((summary) => summary.sourceType === "history_compaction")?.sourceMessageId;
    const previousBoundaryIndex = previousBoundaryId
      ? messages.findIndex((message) => message.messageId === previousBoundaryId)
      : -1;
    const uncompactedMessages = messages.slice(previousBoundaryIndex + 1);
    const turnIds = [...new Set(uncompactedMessages.map((message) => message.turnId))];
    if (turnIds.length <= 2) {
      return {
        compacted: false,
        messageCountCompacted: 0,
        beforeTokens: estimateTextTokens(uncompactedMessages.map((message) => message.content).join("\n")),
        afterTokens: estimateTextTokens(uncompactedMessages.map((message) => message.content).join("\n")),
        tokensSaved: 0,
      };
    }

    const retainedTurnIds = new Set(turnIds.slice(-2));
    const promotedToolMessageIds = new Set(
      summaries
        .filter((summary) => summary.sourceType === "tool_output")
        .map((summary) => summary.sourceMessageId)
        .filter((value): value is string => typeof value === "string"),
    );
    const promotedToolCallIds = new Set(
      summaries
        .filter((summary) => summary.sourceType === "tool_output")
        .map((summary) => summary.sourceToolCallId)
        .filter((value): value is string => typeof value === "string"),
    );
    const firstUnexposedToolMessage = uncompactedMessages.find((message, index) => {
      if (message.role !== "tool") return false;
      const hasCandidate = this.readContextSummaryCandidate(message) !== undefined;
      const hasPromotedSummary =
        promotedToolMessageIds.has(message.messageId) ||
        (message.toolCallId ? promotedToolCallIds.has(message.toolCallId) : false);
      const hasLaterAssistantResponse = uncompactedMessages
        .slice(index + 1)
        .some((candidate) => candidate.role === "assistant");
      return hasCandidate
        ? !hasPromotedSummary && !hasLaterAssistantResponse
        : !hasLaterAssistantResponse;
    });
    if (firstUnexposedToolMessage) {
      const protectedTurnIndex = turnIds.indexOf(firstUnexposedToolMessage.turnId);
      for (const turnId of turnIds.slice(Math.max(0, protectedTurnIndex))) {
        retainedTurnIds.add(turnId);
      }
    }
    const compactableMessages = uncompactedMessages.filter((message) => !retainedTurnIds.has(message.turnId));
    const boundary = compactableMessages.at(-1);
    if (!boundary) {
      return {
        compacted: false,
        messageCountCompacted: 0,
        beforeTokens: 0,
        afterTokens: 0,
        tokensSaved: 0,
      };
    }

    const summaryLines = compactableMessages
      .filter((message) => message.role !== "system")
      .slice(-32)
      .map((message) => {
        const role = message.role === "user" ? "User" : message.role === "assistant" ? "Assistant" : `Tool ${message.name ?? "result"}`;
        const content = message.content.replace(/\s+/g, " ").trim();
        return `${role}: ${this.truncateSummaryText(content, 220)}`;
      });
    const summaryText = this.truncateSummaryText(
      ["Manual conversation compaction. Preserve these earlier decisions and results:", ...summaryLines].join("\n"),
      4200,
    );
    const record: ContextSummaryRecord = {
      recordType: "context_summary",
      summaryId: randomUUID(),
      sessionId,
      turnId: boundary.turnId,
      createdAt: now(),
      sourceType: "history_compaction",
      sourceMessageId: boundary.messageId,
      summary: summaryText,
      estimatedTokens: estimateTextTokens(summaryText),
    };
    await this.sessionStore.appendEvent(sessionId, record);

    const beforeTokens = estimateTextTokens(compactableMessages.map((message) => message.content).join("\n"));
    const afterTokens = record.estimatedTokens;
    const compaction: ContextCompactionRecord = {
      createdAt: record.createdAt,
      source: "local_estimated",
      triggered: true,
      triggerReason: "manual /compact command",
      beforeTokens,
      afterTokens,
      tokensSaved: Math.max(0, beforeTokens - afterTokens),
      droppedMessageCount: compactableMessages.length,
      summaryCount: 1,
      retained: ["last 2 turns", `summary ${record.summaryId.slice(0, 8)}`],
      summaryRefs: [record.summaryId],
    };
    await this.sessionStore.updateSession(sessionId, (current) => ({
      ...current,
      latestCompaction: compaction,
    }));
    return {
      compacted: true,
      summaryId: record.summaryId,
      messageCountCompacted: compactableMessages.length,
      beforeTokens,
      afterTokens,
      tokensSaved: compaction.tokensSaved,
    };
  }

  public async resolveApprovalRequest(input: {
    sessionId: string;
    approvalId: string;
    toolName: string;
    requestKey: string;
    persistence: "allow_once" | "allow_session" | "deny";
    reason: string;
  }): Promise<void> {
    await this.toolRuntime.resolveApproval(input);
  }

  public async respondToUserInput(input: {
    sessionId: string;
    requestId: string;
    answers?: UserInputAnswer[];
    cancel?: boolean;
    cancelReason?: string;
    callbacks?: RunCallbacks;
    routeOverride?: RouteTarget;
  }): Promise<RunTurnResult> {
    await this.initialize();
    const state = await this.sessionStore.loadUserInputRequestState(input.sessionId, input.requestId);
    if (!state) throw new Error(`Unknown user-input request: ${input.requestId}.`);
    if (!["pending", "resuming", "resume_failed", "answered"].includes(state.status)) {
      throw new Error(`User-input request ${input.requestId} is already ${state.status}.`);
    }
    if (input.cancel && (input.answers?.length ?? 0) > 0) {
      throw new Error("A cancelled user-input request cannot also submit answers.");
    }
    const cancelReason = input.cancelReason?.trim() || undefined;
    if ((cancelReason?.length ?? 0) > USER_INPUT_LIMITS.maxCancelReasonChars) {
      throw new Error("The user-input cancellation reason exceeds the persisted length limit.");
    }
    const hasPersistedClaim = await this.sessionStore.hasPersistedUserInputClaim(
      input.sessionId,
      input.requestId,
    );
    if (state.status === "answered" && !hasPersistedClaim) {
      throw new Error(`User-input request ${input.requestId} was already answered.`);
    }
    const recoverPersistedSubmission =
      hasPersistedClaim && !input.cancel && input.answers === undefined;
    const proposedAnswers = input.cancel || recoverPersistedSubmission
      ? []
      : validateUserInputAnswers(state.request, input.answers ?? []);
    const proposedSubmission: UserInputClaimSubmission | undefined = recoverPersistedSubmission
      ? undefined
      : input.cancel
        ? { status: "cancelled", answers: [], cancelReason }
        : { status: "answered", answers: proposedAnswers };
    const sessionBeforeClaim = await this.sessionStore.loadSession(input.sessionId);
    if (!sessionBeforeClaim) throw new Error(`Unknown session: ${input.sessionId}.`);
    if (state.request.mode === "blocking") {
      const isFreshAnswer = state.status === "pending";
      if (
        sessionBeforeClaim.lastTurnId !== state.request.turnId ||
        (isFreshAnswer &&
          (sessionBeforeClaim.status !== "waiting_for_user" || sessionBeforeClaim.activeTurnId !== undefined)) ||
        (!isFreshAnswer &&
          sessionBeforeClaim.status === "running" &&
          sessionBeforeClaim.activeTurnId === state.request.turnId)
      ) {
        throw new Error(
          `User-input request ${input.requestId} is not the current recoverable pending turn.`,
        );
      }
    }

    const claim = await this.sessionStore.claimUserInputRequest({
      sessionId: input.sessionId,
      requestId: input.requestId,
      responseId: randomUUID(),
      submission: proposedSubmission,
    });
    const { request, responseId, submission, leaseId } = claim;
    let answers: UserInputAnswer[];
    try {
      answers = submission.status === "answered"
        ? validateUserInputAnswers(request, submission.answers)
        : [];
    } catch (error) {
      await this.sessionStore.releaseUserInputClaim(request.sessionId, request.requestId, leaseId, {
        preservePayload: false,
      });
      throw error;
    }
    if (
      submission.status === "cancelled" &&
      (submission.cancelReason?.length ?? 0) > USER_INPUT_LIMITS.maxCancelReasonChars
    ) {
      await this.sessionStore.releaseUserInputClaim(request.sessionId, request.requestId, leaseId, {
        preservePayload: false,
      });
      throw new Error("The persisted user-input cancellation reason exceeds the length limit.");
    }
    const submittedAt = now();
    let heartbeatFailure: Error | undefined;
    let heartbeatWork = Promise.resolve();
    let leaseReleased = false;
    const renewLease = () => {
      heartbeatWork = heartbeatWork.then(async () => {
        if (leaseReleased || heartbeatFailure) return;
        try {
          await this.sessionStore.renewUserInputClaim(request.sessionId, request.requestId, leaseId);
        } catch (error) {
          heartbeatFailure = error as Error;
        }
      });
    };
    const heartbeat = setInterval(renewLease, 1_000);
    heartbeat.unref?.();
    const assertLease = async (): Promise<void> => {
      renewLease();
      await heartbeatWork;
      if (heartbeatFailure) {
        throw new Error(`User-input response lease was lost: ${heartbeatFailure.message}`);
      }
    };
    const releaseClaim = async (preservePayload: boolean): Promise<void> => {
      if (leaseReleased) return;
      clearInterval(heartbeat);
      await heartbeatWork;
      leaseReleased = true;
      await this.sessionStore.releaseUserInputClaim(request.sessionId, request.requestId, leaseId, {
        preservePayload,
      });
    };

    const reconcileCompletedAttempt = async (): Promise<RunTurnResult | undefined> => {
      const events = await this.sessionStore.loadEvents(request.sessionId);
      let currentResumeIndex = -1;
      for (let index = events.length - 1; index >= 0; index -= 1) {
        const event = events[index]!;
        if (
          event.recordType === "user_input_resume" &&
          event.requestId === request.requestId &&
          event.responseId === responseId &&
          event.status === "resuming"
        ) {
          currentResumeIndex = index;
          break;
        }
      }
      if (currentResumeIndex < 0) return undefined;
      let terminalTurnIndex = -1;
      let terminalTurn: Extract<SessionEvent, { recordType: "turn" }> | undefined;
      for (let index = currentResumeIndex - 1; index >= 0; index -= 1) {
        const event = events[index]!;
        if (
          event.recordType === "turn" &&
          event.turnId === request.turnId &&
          Boolean(event.endedAt) &&
          (event.status === "ask_permission" ||
            (event.status === "waiting_for_user" && event.error === undefined))
        ) {
          terminalTurnIndex = index;
          terminalTurn = event;
          break;
        }
      }
      if (!terminalTurn || terminalTurnIndex < 0) return undefined;
      let originatingResumeIndex = -1;
      for (let index = terminalTurnIndex - 1; index >= 0; index -= 1) {
        const event = events[index]!;
        if (
          event.recordType === "user_input_resume" &&
          event.requestId === request.requestId &&
          event.responseId === responseId &&
          event.status === "resuming"
        ) {
          originatingResumeIndex = index;
          break;
        }
      }
      if (originatingResumeIndex < 0) return undefined;
      const attemptEvents = events.slice(originatingResumeIndex + 1, terminalTurnIndex + 1);
      if (!terminalTurn?.assistantMessageId) return undefined;
      const terminalAssistant = attemptEvents.find(
        (event): event is MessageRecord =>
          event.recordType === "message" &&
          event.role === "assistant" &&
          event.turnId === request.turnId &&
          event.messageId === terminalTurn.assistantMessageId,
      );
      const persistedResponse = events.slice(0, currentResumeIndex).find(
        (event) => event.recordType === "user_input_response" &&
          event.requestId === request.requestId &&
          event.responseId === responseId &&
          event.status === "answered",
      );
      if (!terminalAssistant || !persistedResponse) return undefined;

      await assertLease();
      const session = await this.sessionStore.updateSession(request.sessionId, (current) => ({
        ...current,
        status: terminalTurn.status,
        activeTurnId: undefined,
        lastTurnId: request.turnId,
        latestTaskDuration: {
          startedAt: terminalTurn.startedAt,
          endedAt: terminalTurn.endedAt,
          durationMs: terminalTurn.durationMs,
          status: terminalTurn.status,
        },
      }));
      await this.sessionStore.recordUserInputResume({
        recordType: "user_input_resume",
        requestId: request.requestId,
        responseId,
        sessionId: request.sessionId,
        turnId: request.turnId,
        toolCallId: request.toolCallId,
        createdAt: now(),
        status: "resumed",
        resumedAt: now(),
      });
      const pendingUserInput = (await this.sessionStore.listPendingUserInputRequests(request.sessionId))
        .find((candidate) =>
          candidate.request.requestId !== request.requestId &&
          candidate.request.turnId === request.turnId &&
          candidate.request.mode === "blocking" &&
          candidate.status === "pending")?.request;
      await releaseClaim(false);
      return {
        sessionId: request.sessionId,
        session,
        finalResponse: terminalAssistant.content,
        pendingUserInput,
      };
    };

    try {
      const reconciled = await reconcileCompletedAttempt();
      if (reconciled) return reconciled;
    } catch (error) {
      await releaseClaim(true);
      throw error;
    }

    if (submission.status === "cancelled") {
      let cancellationCommitted = false;
      try {
        await assertLease();
        if (request.mode === "blocking") {
          const events = await this.sessionStore.loadEvents(request.sessionId);
          const pendingTurn = [...events].reverse().find(
            (event): event is Extract<SessionEvent, { recordType: "turn" }> =>
              event.recordType === "turn" && event.turnId === request.turnId,
          );
          if (!pendingTurn) {
            throw new Error(`No pending turn found for user-input request ${request.requestId}.`);
          }
          await this.sessionStore.finishTurn({
            sessionId: request.sessionId,
            turnId: request.turnId,
            startedAt: pendingTurn.startedAt,
            requestSummary: pendingTurn.requestSummary,
            userMessageId: pendingTurn.userMessageId,
            assistantMessageId: pendingTurn.assistantMessageId,
            toolCallIds: [...pendingTurn.toolCallIds],
            status: "interrupted",
            error: submission.cancelReason || "Cancelled by the user.",
          });
        }
        await this.sessionStore.recordUserInputResponse({
          recordType: "user_input_response",
          requestId: request.requestId,
          sessionId: request.sessionId,
          turnId: request.turnId,
          toolCallId: request.toolCallId,
          responseId,
          createdAt: submittedAt,
          submittedAt,
          status: "cancelled",
          answers: [],
          cancelReason: submission.cancelReason,
        });
        await this.sessionStore.recordUserInputResume({
          recordType: "user_input_resume",
          requestId: request.requestId,
          responseId,
          sessionId: request.sessionId,
          turnId: request.turnId,
          toolCallId: request.toolCallId,
          createdAt: now(),
          status: "interrupted",
          error: submission.cancelReason || "Cancelled by the user.",
        });
        const session = await this.sessionStore.loadSession(input.sessionId);
        if (!session) throw new Error(`Session disappeared: ${input.sessionId}.`);
        cancellationCommitted = true;
        return {
          sessionId: input.sessionId,
          session,
          finalResponse: "The pending user-input request was cancelled.",
        };
      } finally {
        await releaseClaim(!cancellationCommitted);
      }
    }

    const answerContent = renderUserInputAnswer(request, answers);
    try {
      await assertLease();
      const existingEvents = await this.sessionStore.loadEvents(request.sessionId);
      let answerMessage = existingEvents.find(
        (event): event is MessageRecord =>
          event.recordType === "message" &&
          event.metadata?.userInputRequestId === request.requestId &&
          event.metadata?.userInputResponseId === responseId,
      );
      if (!answerMessage) {
        answerMessage = await this.sessionStore.appendMessage({
          sessionId: request.sessionId,
          turnId: request.turnId,
          role: "user",
          content: answerContent,
          metadata: {
            userInputRequestId: request.requestId,
            userInputResponseId: responseId,
            structuredUserInput: true,
          },
        });
      }
      const existingResponse = existingEvents.find(
        (event) => event.recordType === "user_input_response" && event.responseId === responseId,
      );
      if (!existingResponse) {
        await this.sessionStore.recordUserInputResponse({
          recordType: "user_input_response",
          requestId: request.requestId,
          sessionId: request.sessionId,
          turnId: request.turnId,
          toolCallId: request.toolCallId,
          responseId,
          createdAt: submittedAt,
          submittedAt,
          status: "answered",
          answers,
          userMessageId: answerMessage.messageId,
        });
      }

      if (request.mode === "non_blocking") {
        const stateBeforeComplete = await this.sessionStore.loadUserInputRequestState(
          request.sessionId,
          request.requestId,
        );
        if (stateBeforeComplete?.status === "interrupted") {
          throw new Error(`User-input request ${request.requestId} was interrupted before completion.`);
        }
        await this.sessionStore.recordUserInputResume({
          recordType: "user_input_resume",
          requestId: request.requestId,
          responseId,
          sessionId: request.sessionId,
          turnId: request.turnId,
          toolCallId: request.toolCallId,
          createdAt: now(),
          status: "resumed",
          resumedAt: now(),
        });
        const sessionAfterComplete = await this.sessionStore.loadSession(request.sessionId);
        if (sessionAfterComplete?.status === "interrupted") {
          await this.sessionStore.recordUserInputResume({
            recordType: "user_input_resume",
            requestId: request.requestId,
            responseId,
            sessionId: request.sessionId,
            turnId: request.turnId,
            toolCallId: request.toolCallId,
            createdAt: now(),
            status: "interrupted",
            error: "The session was interrupted while completing non-blocking user input.",
          });
          throw new Error(`User-input request ${request.requestId} was interrupted during completion.`);
        }
        const session = await this.sessionStore.loadSession(input.sessionId);
        if (!session) throw new Error(`Session disappeared: ${input.sessionId}.`);
        await releaseClaim(false);
        return {
          sessionId: input.sessionId,
          session,
          finalResponse: "The non-blocking user answer was recorded as user input.",
        };
      }

      const events = await this.sessionStore.loadEvents(request.sessionId);
      const turnEvent = [...events].reverse().find(
        (event): event is Extract<SessionEvent, { recordType: "turn" }> =>
          event.recordType === "turn" && event.turnId === request.turnId,
      );
      if (!turnEvent) throw new Error(`No pending turn found for user-input request ${request.requestId}.`);
      const latestRoutingDecision = [...events].reverse().find(
        (event): event is Extract<SessionEvent, { recordType: "routing_decision" }> =>
          event.recordType === "routing_decision" && event.turnId === request.turnId,
      );
      const routingDecision = latestRoutingDecision ?? resolveRoutingDecision({
        prompt: turnEvent.requestSummary,
        overrideTarget: input.routeOverride,
      });
      const turnMessages = (await this.sessionStore.loadMessages(request.sessionId))
        .filter((message) => message.turnId === request.turnId);
      const assistantMessageId = [...turnMessages].reverse()
        .find((message) => message.role === "assistant")?.messageId;
      const resumedRequestSummary = `${turnEvent.requestSummary}\n\n${answerContent}`;
      const promptContext = await this.loadPromptContext(resumedRequestSummary);
      const initialToolLoopState = await this.restoreToolLoopState(request.sessionId, request.turnId);
      const sessionBeforeResume = await this.sessionStore.loadSession(request.sessionId);
      const requestBeforeResume = await this.sessionStore.loadUserInputRequestState(
        request.sessionId,
        request.requestId,
      );
      if (
        sessionBeforeResume?.status !== "running" ||
        sessionBeforeResume.activeTurnId !== request.turnId ||
        requestBeforeResume?.status === "interrupted"
      ) {
        throw new Error(`User-input request ${request.requestId} was interrupted before resume.`);
      }
      await this.sessionStore.updateSession(request.sessionId, (current) => ({
        ...current,
        status: "running",
        activeTurnId: request.turnId,
        lastTurnId: request.turnId,
        latestTaskDuration: {
          startedAt: turnEvent.startedAt,
          status: "running",
        },
      }));
      input.callbacks?.onSessionSelected?.(request.sessionId);
      const turnAbortController = this.registerTurnAbortController(request.sessionId);
      try {
        await assertLease();
        const result = await this.runModelLoop({
          sessionId: request.sessionId,
          turnId: request.turnId,
          requestSummary: resumedRequestSummary,
          startedAt: turnEvent.startedAt,
          userMessageId: turnEvent.userMessageId,
          assistantMessageId,
          toolCallIds: [...turnEvent.toolCallIds],
          callbacks: input.callbacks,
          initialRoutingDecision: routingDecision,
          activeRoutingDecision: routingDecision,
          promptContext,
          signal: turnAbortController.signal,
          initialToolLoopState,
        });
        await assertLease();
        const stateBeforeComplete = await this.sessionStore.loadUserInputRequestState(
          request.sessionId,
          request.requestId,
        );
        if (stateBeforeComplete?.status === "interrupted") {
          throw new Error(`User-input request ${request.requestId} was interrupted before completion.`);
        }
        await this.sessionStore.recordUserInputResume({
          recordType: "user_input_resume",
          requestId: request.requestId,
          responseId,
          sessionId: request.sessionId,
          turnId: request.turnId,
          toolCallId: request.toolCallId,
          createdAt: now(),
          status: "resumed",
          resumedAt: now(),
        });
        const sessionAfterComplete = await this.sessionStore.loadSession(request.sessionId);
        if (sessionAfterComplete?.status === "interrupted") {
          await this.sessionStore.recordUserInputResume({
            recordType: "user_input_resume",
            requestId: request.requestId,
            responseId,
            sessionId: request.sessionId,
            turnId: request.turnId,
            toolCallId: request.toolCallId,
            createdAt: now(),
            status: "interrupted",
            error: "The session was interrupted while completing resumed user input.",
          });
          throw new Error(`User-input request ${request.requestId} was interrupted during completion.`);
        }
        await releaseClaim(false);
        return result;
      } catch (error) {
        if (error instanceof PermissionRequiredError) {
          return await this.finishFailedTurn({
            sessionId: request.sessionId,
            turnId: request.turnId,
            startedAt: turnEvent.startedAt,
            requestSummary: resumedRequestSummary,
            userMessageId: turnEvent.userMessageId,
            assistantMessageId,
            toolCallIds: [...turnEvent.toolCallIds],
            error,
          });
        }
        const interruptedState = await this.sessionStore.loadUserInputRequestState(
          request.sessionId,
          request.requestId,
        );
        if (interruptedState?.status !== "interrupted") {
          await this.sessionStore.finishTurn({
            sessionId: request.sessionId,
            turnId: request.turnId,
            startedAt: turnEvent.startedAt,
            requestSummary: resumedRequestSummary,
            userMessageId: turnEvent.userMessageId,
            assistantMessageId,
            toolCallIds: [...turnEvent.toolCallIds],
            status: "waiting_for_user",
            error: `User-input resume failed: ${(error as Error).message}`,
          });
        }
        throw error;
      } finally {
        this.releaseTurnAbortController(request.sessionId, turnAbortController);
      }
    } catch (error) {
      const latestState = await this.sessionStore.loadUserInputRequestState(
        request.sessionId,
        request.requestId,
      );
      if (latestState?.status === "interrupted") {
        await releaseClaim(false);
        throw error;
      }
      if (error instanceof PermissionRequiredError) {
        await this.sessionStore.recordUserInputResume({
          recordType: "user_input_resume",
          requestId: request.requestId,
          responseId,
          sessionId: request.sessionId,
          turnId: request.turnId,
          toolCallId: request.toolCallId,
          createdAt: now(),
          status: "resumed",
          resumedAt: now(),
        });
        await releaseClaim(false);
        throw error;
      }
      try {
        await this.sessionStore.recordUserInputResume({
          recordType: "user_input_resume",
          requestId: request.requestId,
          responseId,
          sessionId: request.sessionId,
          turnId: request.turnId,
          toolCallId: request.toolCallId,
          createdAt: now(),
          status: "resume_failed",
          error: (error as Error).message,
        });
        const failedSession = await this.sessionStore.loadSession(request.sessionId);
        if (failedSession?.status === "running" && failedSession.activeTurnId === request.turnId) {
          const events = await this.sessionStore.loadEvents(request.sessionId);
          const pendingTurn = [...events].reverse().find(
            (event): event is Extract<SessionEvent, { recordType: "turn" }> =>
              event.recordType === "turn" && event.turnId === request.turnId,
          );
          if (pendingTurn) {
            await this.sessionStore.finishTurn({
              sessionId: request.sessionId,
              turnId: request.turnId,
              startedAt: pendingTurn.startedAt,
              requestSummary: pendingTurn.requestSummary,
              userMessageId: pendingTurn.userMessageId,
              assistantMessageId: pendingTurn.assistantMessageId,
              toolCallIds: [...pendingTurn.toolCallIds],
              status: "waiting_for_user",
              error: `User-input resume failed: ${(error as Error).message}`,
            });
          }
        }
      } finally {
        await releaseClaim(true);
      }
      throw error;
    }
  }

  public async continuePendingTurn(input: {
    sessionId: string;
    callbacks?: RunCallbacks;
    routeOverride?: RouteTarget;
  }): Promise<RunTurnResult> {
    if (this.pendingTurnContinuations.has(input.sessionId)) {
      throw new Error(`Session ${input.sessionId} approval continuation is already running.`);
    }
    this.pendingTurnContinuations.add(input.sessionId);
    try {
      return await this.continuePendingTurnWithLease(input);
    } finally {
      this.pendingTurnContinuations.delete(input.sessionId);
    }
  }

  private async continuePendingTurnWithLease(input: {
    sessionId: string;
    callbacks?: RunCallbacks;
    routeOverride?: RouteTarget;
  }): Promise<RunTurnResult> {
    await this.initialize();
    const session = await this.resolveResumeTarget(input.sessionId);
    if (session.status !== "ask_permission") {
      throw new Error(`Session ${session.sessionId} is not waiting on approval.`);
    }

    const events = await this.sessionStore.loadEvents(session.sessionId);
    const turnEvent = [...events]
      .reverse()
      .find(
        (event): event is Extract<SessionEvent, { recordType: "turn" }> =>
          event.recordType === "turn" && event.turnId === session.lastTurnId,
      );
    if (!turnEvent) {
      throw new Error(`No turn record found for session ${session.sessionId}.`);
    }

    const messages = await this.sessionStore.loadMessages(session.sessionId);
    const turnMessages = messages.filter((message) => message.turnId === turnEvent.turnId);
    const respondedToolCallIds = new Set(
      turnMessages
        .filter((message) => message.role === "tool" && typeof message.toolCallId === "string")
        .map((message) => message.toolCallId!),
    );
    const assistantMessage = [...turnMessages]
      .reverse()
      .find(
        (message) =>
          message.role === "assistant" &&
          Array.isArray(message.toolCalls) &&
          message.toolCalls.some((toolCall) => !respondedToolCallIds.has(toolCall.id)),
      );
    if (!assistantMessage?.toolCalls || assistantMessage.toolCalls.length === 0) {
      throw new Error(`No pending tool calls found for session ${session.sessionId}.`);
    }

    const persistedPendingToolCalls = assistantMessage.toolCalls.filter(
      (toolCall) => !respondedToolCallIds.has(toolCall.id),
    );
    const pendingToolCalls = await Promise.all(persistedPendingToolCalls.map(async (toolCall) =>
      await this.sessionStore.loadProtectedToolCall(session.sessionId, toolCall.id) ?? toolCall));
    if (pendingToolCalls.length === 0) {
      throw new Error(`No unresolved tool calls remain for session ${session.sessionId}.`);
    }

    const promptContext = await this.loadPromptContext(turnEvent.requestSummary);
    const latestRoutingDecision = [...events]
      .reverse()
      .find(
        (event): event is Extract<SessionEvent, { recordType: "routing_decision" }> =>
          event.recordType === "routing_decision" && event.turnId === turnEvent.turnId,
      );
    const routingDecision =
      latestRoutingDecision ??
      resolveRoutingDecision({
        prompt: turnEvent.requestSummary,
        overrideTarget: input.routeOverride,
      });
    const toolCallIds = [...turnEvent.toolCallIds];
    const initialToolLoopState = await this.restoreToolLoopState(session.sessionId, turnEvent.turnId);
    const recordedProviderSelections = events.filter(
      (event): event is Extract<SessionEvent, { recordType: "tool_selection" }> =>
        event.recordType === "tool_selection" && event.turnId === turnEvent.turnId,
    );
    const originatingSelectionId = typeof assistantMessage.metadata?.toolSelectionId === "string"
      ? assistantMessage.metadata.toolSelectionId
      : undefined;
    const originatingSelection = originatingSelectionId
      ? recordedProviderSelections.find((selection) => selection.selectionId === originatingSelectionId)
      : undefined;
    if (originatingSelectionId && !originatingSelection) {
      throw new Error(
        `Cannot resume pending tool calls because selection ${originatingSelectionId} is missing from the original turn history.`,
      );
    }
    const selectedProviderToolNames = new Set(
      originatingSelection
        ? originatingSelection.selectedToolNames
        : recordedProviderSelections.flatMap((selection) => selection.selectedToolNames),
    );

    await this.sessionStore.updateSession(session.sessionId, (current) => ({
      ...current,
      status: "running",
      activeTurnId: turnEvent.turnId,
      lastTurnId: turnEvent.turnId,
      latestTaskDuration: {
        startedAt: turnEvent.startedAt,
        status: "running",
      },
    }));
    input.callbacks?.onSessionSelected?.(session.sessionId);
    input.callbacks?.onToolBatchStart?.({
      assistantMessageId: assistantMessage.messageId,
      turnId: assistantMessage.turnId,
      createdAt: assistantMessage.createdAt,
      toolCalls: persistedPendingToolCalls,
    });
    const turnAbortController = this.registerTurnAbortController(session.sessionId);

    try {
      for (const toolCall of pendingToolCalls) {
        throwIfAborted(turnAbortController.signal);
        if (recordedProviderSelections.length > 0 && !selectedProviderToolNames.has(toolCall.name)) {
          await this.recordProviderToolRejection(
            session.sessionId,
            turnEvent.turnId,
            toolCall,
            input.callbacks,
            toolCallIds,
            "tool_not_selected",
            `Tool ${toolCall.name} was not selected for the original model turn.`,
          );
        } else {
          await this.executeRecordedToolCall(
            session.sessionId,
            turnEvent.turnId,
            toolCall,
            input.callbacks,
            toolCallIds,
            turnAbortController.signal,
          );
        }
        throwIfAborted(turnAbortController.signal);
      }

      return await this.runModelLoop({
        sessionId: session.sessionId,
        turnId: turnEvent.turnId,
        requestSummary: turnEvent.requestSummary,
        startedAt: turnEvent.startedAt,
        userMessageId: turnEvent.userMessageId,
        assistantMessageId: assistantMessage.messageId,
        toolCallIds,
        callbacks: input.callbacks,
        initialRoutingDecision: routingDecision,
        activeRoutingDecision: routingDecision,
        promptContext,
        signal: turnAbortController.signal,
        initialToolLoopState,
      });
    } catch (error) {
      return this.finishFailedTurn({
        sessionId: session.sessionId,
        turnId: turnEvent.turnId,
        startedAt: turnEvent.startedAt,
        requestSummary: turnEvent.requestSummary,
        userMessageId: turnEvent.userMessageId,
        assistantMessageId: assistantMessage.messageId,
        toolCallIds,
        error,
      });
    } finally {
      this.releaseTurnAbortController(session.sessionId, turnAbortController);
    }
  }

  private async loadPromptContext(prompt: string): Promise<PromptContextSnapshot> {
    const skillDiscovery = await this.skillEngine.discoverSkills();
    const matchedSkills = await this.skillEngine.selectSkills(prompt);
    const workflowDiscovery = await this.workflowRuntime.discoverWorkflows();
    const mcpStatuses = this.mcpRegistry.listServerStatuses();
    return {
      skillDiscovery,
      matchedSkills,
      workflowDiscovery,
      mcpStatuses,
      extensionErrors: {
        skills: skillDiscovery.errors,
        workflows: workflowDiscovery.errors,
        mcp: this.mcpRegistry.listErrors(),
      },
    };
  }

  public async generateSessionTitle(input: {
    userRequest: string;
    assistantResponse: string;
  }): Promise<string | undefined> {
    const response = await this.modelClient.streamCompletion({
      route: {
        ...this.routeProfile,
        thinkingMode: { mode: "disabled", reasoningEffort: "not_applicable" },
      },
      systemPrompt: SESSION_TITLE_SYSTEM_PROMPT,
      messages: buildSessionTitleMessages(input),
      tools: [],
      stream: false,
      temperature: 0.1,
      maxOutputTokens: 48,
      inactivityTimeoutMs: Math.min(this.deepSeekConfig.timeoutMs, 30_000),
    });
    return normalizeGeneratedSessionTitle(response.content);
  }

  public async runTurn(input: {
    sessionId?: string;
    prompt: string;
    callbacks?: RunCallbacks;
    routeOverride?: RouteTarget;
    userMessageMetadata?: Record<string, unknown>;
  }): Promise<RunTurnResult> {
    await this.initialize();
    const promptContext = await this.loadPromptContext(input.prompt);
    const session =
      input.sessionId !== undefined
        ? await this.resolveResumeTarget(input.sessionId)
        : await this.sessionStore.createSession(input.prompt);
    if (input.sessionId !== undefined) {
      const pendingQuestions = await this.sessionStore.listPendingUserInputRequests(session.sessionId);
      if (pendingQuestions.some((state) => state.request.mode === "blocking")) {
        throw new Error(
          `Session ${session.sessionId} is waiting for a structured user answer; answer or cancel it before starting a new turn.`,
        );
      }
      if (session.status === "running" || this.activeTurnControllers.has(session.sessionId)) {
        throw new Error(`Session ${session.sessionId} already has an active turn.`);
      }
    }
    input.callbacks?.onSessionSelected?.(session.sessionId);

    const turn = await this.sessionStore.startTurn({
      sessionId: session.sessionId,
      requestSummary: input.prompt,
      userMessageId: "pending",
    });
    const userMessage = await this.sessionStore.appendMessage({
      sessionId: session.sessionId,
      turnId: turn.turnId,
      role: "user",
      content: input.prompt,
      metadata: input.userMessageMetadata,
    });
    await this.hookBus.emit({
      name: "session_start",
      createdAt: now(),
      sessionId: session.sessionId,
      turnId: turn.turnId,
      payload: {
        requestSummary: input.prompt,
      },
    });

    const toolCallIds: string[] = [];
    let assistantMessageId: string | undefined;
    const initialRoutingDecision = resolveRoutingDecision({
      prompt: input.prompt,
      overrideTarget: input.routeOverride,
    });
    let activeRoutingDecision = initialRoutingDecision;
    let usedWorkerTool = false;
    const turnAbortController = this.registerTurnAbortController(session.sessionId);

    try {
      const routedDispatch = await this.applyRoutingDecision({
        sessionId: session.sessionId,
        turnId: turn.turnId,
        prompt: input.prompt,
        routeDecision: initialRoutingDecision,
        callbacks: input.callbacks,
        toolCallIds,
      });
      activeRoutingDecision = routedDispatch.decision;
      usedWorkerTool = routedDispatch.usedWorkerTool;
      assistantMessageId = routedDispatch.assistantMessageId ?? assistantMessageId;
      return await this.runModelLoop({
        sessionId: session.sessionId,
        turnId: turn.turnId,
        requestSummary: input.prompt,
        startedAt: turn.startedAt,
        userMessageId: userMessage.messageId,
        assistantMessageId,
        toolCallIds,
        callbacks: input.callbacks,
        initialRoutingDecision,
        activeRoutingDecision,
        promptContext,
        usedWorkerTool,
        recordDirectDsSuccess: true,
        signal: turnAbortController.signal,
      });
    } catch (error) {
      return this.finishFailedTurn({
        sessionId: session.sessionId,
        turnId: turn.turnId,
        startedAt: turn.startedAt,
        requestSummary: input.prompt,
        userMessageId: userMessage.messageId,
        assistantMessageId,
        toolCallIds,
        error,
      });
    } finally {
      this.releaseTurnAbortController(session.sessionId, turnAbortController);
    }
  }

  private async runModelLoop(input: {
    sessionId: string;
    turnId: string;
    requestSummary: string;
    startedAt: string;
    userMessageId: string;
    assistantMessageId?: string;
    toolCallIds: string[];
    callbacks?: RunCallbacks;
    initialRoutingDecision: RoutingDecision;
    activeRoutingDecision: RoutingDecision;
    promptContext: PromptContextSnapshot;
    usedWorkerTool?: boolean;
    recordDirectDsSuccess?: boolean;
    signal?: AbortSignal;
    initialToolLoopState?: ToolLoopState;
  }): Promise<RunTurnResult> {
    let assistantMessageId = input.assistantMessageId;
    let activeRoutingDecision = input.activeRoutingDecision;
    let usedWorkerTool = input.usedWorkerTool ?? false;
    let toolCycle = input.initialToolLoopState?.toolCycle ?? 1;
    let toolLoopsInCycle = input.initialToolLoopState?.toolLoopsInCycle ?? 0;
    let previousToolBatchSignature = input.initialToolLoopState?.previousToolBatchSignature;
    let identicalToolBatchCount = input.initialToolLoopState?.identicalToolBatchCount ?? 0;
    let autonomousRecoveryAttempts = 0;
    let providerTimeoutRecoveryAttempts = 0;
    let recoveryInstruction: string | undefined;
    let lastToolResults: ToolResult[] = [];
    const exhaustedToolCallSignatures = new Set<string>();
    const selectionMessages = await this.sessionStore.loadMessages(input.sessionId);
    const toolSelectionPrompt = buildToolSelectionPrompt(input.requestSummary, input.turnId, selectionMessages);
    const carriedToolNames = await this.loadToolSelectionCarryover(
      input.sessionId,
      input.turnId,
      input.requestSummary,
    );

    while (true) {
      throwIfAborted(input.signal);
      const atToolCycleBoundary = toolLoopsInCycle >= TOOL_LOOPS_PER_CYCLE;
      const sessionRecord = await this.sessionStore.loadSession(input.sessionId);
      if (!sessionRecord) {
        throw new Error(`Session disappeared: ${input.sessionId}`);
      }

      const contextSummaries = await this.loadContextSummaries(input.sessionId);
      let allRecentMessages = await this.sessionStore.loadMessages(input.sessionId);
      const manualBoundaryId = [...contextSummaries]
        .reverse()
        .find((summary) => summary.sourceType === "history_compaction")?.sourceMessageId;
      const manualBoundaryIndex = manualBoundaryId
        ? allRecentMessages.findIndex((message) => message.messageId === manualBoundaryId)
        : -1;
      let recentMessages = manualBoundaryIndex >= 0
        ? allRecentMessages.slice(manualBoundaryIndex + 1)
        : allRecentMessages;
      const workerRoutes =
        activeRoutingDecision.finalTarget === "glm_coding"
          ? (["coding"] as const)
          : activeRoutingDecision.finalTarget === "kimi_vision"
            ? (["vision"] as const)
            : [];
      const activeLeases = await this.toolRuntime.loadActiveToolSelectionLeases(
        input.sessionId,
        input.turnId,
      );
      const selectedTools = this.toolRuntime.selectToolsForTurn({
        prompt: toolSelectionPrompt,
        requestedToolNames: carriedToolNames,
        activatedToolNames: activeLeases.toolNames,
        workerRoutes: [...workerRoutes],
      });
      const toolDefinitions = atToolCycleBoundary ? [] : selectedTools.definitions;
      const providerTools = atToolCycleBoundary ? [] : selectedTools.providerTools;
      const selectionId = randomUUID();
      await this.sessionStore.recordToolSelection({
        recordType: "tool_selection",
        selectionId,
        sessionId: input.sessionId,
        turnId: input.turnId,
        createdAt: new Date().toISOString(),
        providerCycle: activeLeases.providerCycle,
        activationLeaseIds: activeLeases.leaseIds,
        activatedToolNames: activeLeases.toolNames,
        estimatedToolSchemaTokens: atToolCycleBoundary ? 0 : activeLeases.estimatedSchemaTokens,
        ...(atToolCycleBoundary
          ? {
              selectedCount: 0,
              unselectedCount: selectedTools.summary.selectedCount + selectedTools.summary.unselectedCount,
              selectedToolNames: [],
              reasonCounts: { tool_cycle_boundary: 1 },
            }
          : selectedTools.summary),
      });
      let prompt: Awaited<ReturnType<PromptCompiler["compile"]>>;
      const runtimeCapabilities = await this.toolRuntime.getCapabilitySnapshot();
      const compilePrompt = async (messages: MessageRecord[]) => await this.promptCompiler.compile({
        workspaceRoot: this.sessionStore.workspaceRoot,
        currentUserRequest: input.requestSummary,
        planItems: sessionRecord.planItems,
        toolDefinitions,
        recentMessages: messages,
        contextSummaries,
        routingDecision: activeRoutingDecision,
        runtimeCapabilities,
        availableSkills: input.promptContext.skillDiscovery.skills,
        matchedSkills: input.promptContext.matchedSkills,
        availableWorkflows: input.promptContext.workflowDiscovery.workflows,
        mcpStatuses: input.promptContext.mcpStatuses,
        extensionErrors: input.promptContext.extensionErrors,
      });
      try {
        prompt = await compilePrompt(recentMessages);
        if (!allRecentMessages.some((message) => isProviderTurnContextMessage(message, input.turnId))) {
          const turnContextMessage = await this.sessionStore.appendMessage({
            sessionId: input.sessionId,
            turnId: input.turnId,
            role: "system",
            content: prompt.turnContext,
            metadata: {
              [PROVIDER_TURN_CONTEXT_METADATA_KEY]: { version: 1 },
            },
          });
          allRecentMessages = [...allRecentMessages, turnContextMessage];
          recentMessages = [...recentMessages, turnContextMessage];
          prompt = await compilePrompt(recentMessages);
        }
      } catch (error) {
        if (error instanceof HistoryIntegrityError) {
          await this.recordHistoryIntegrity(input.sessionId, input.turnId, "pre_model_request", error.report);
        }
        throw error;
      }
      await this.recordHistoryIntegrity(input.sessionId, input.turnId, "pre_model_request", prompt.historyReport);
      await this.recordContextBudget(input.sessionId, input.turnId, "before_model", prompt.contextBudget, prompt.compaction);

      let response: AssistantResponse;
      const bufferPossibleRecovery = !atToolCycleBoundary && recoveryInstruction !== undefined;
      const providerMessages: ConversationMessage[] = [
        ...buildConversationMessages(prompt.truncatedMessages),
        ...prompt.providerContextMessages,
      ];
      const requestInstruction = atToolCycleBoundary
        ? toolCycleBoundaryInstruction(toolCycle, this.maxToolCycles)
        : recoveryInstruction;
      if (requestInstruction) {
        providerMessages.push({
          role: "system",
          content: requestInstruction,
        });
      }
      try {
        response = await this.modelClient.streamCompletion(
          {
            route: this.routeProfile,
            systemPrompt: prompt.systemPrompt,
            messages: providerMessages,
            tools: providerTools,
            stream: true,
            temperature: this.deepSeekConfig.temperature,
            maxOutputTokens: atToolCycleBoundary
              ? Math.min(this.deepSeekConfig.contextReserveOutputTokens, TOOL_CYCLE_BOUNDARY_MAX_OUTPUT_TOKENS)
              : this.deepSeekConfig.contextReserveOutputTokens,
            inactivityTimeoutMs: atToolCycleBoundary
              ? Math.min(this.deepSeekConfig.timeoutMs, TOOL_CYCLE_BOUNDARY_INACTIVITY_TIMEOUT_MS)
              : undefined,
            signal: input.signal,
          },
          atToolCycleBoundary || bufferPossibleRecovery
            ? undefined
            : {
                onTextDelta: input.callbacks?.onTextDelta,
                onReasoningDelta: input.callbacks?.onReasoningDelta,
              },
        );
      } catch (error) {
        if (atToolCycleBoundary && isProviderTimeoutError(error)) {
          const forceComplete = toolCycle >= this.maxToolCycles;
          response = {
            content: forceComplete
              ? `模型在最终安全边界发生空闲超时；已完成的工具结果和检查点均已保留，可输入“继续”恢复未完成工作。 ${TOOL_CYCLE_COMPLETE_MARKER}`
              : `工具周期 ${toolCycle} 的边界响应发生空闲超时；已完成的工具结果均已持久化，继续执行剩余任务。 ${TOOL_CYCLE_CONTINUE_MARKER}`,
            finishReason: "provider_timeout_recovered",
            toolCalls: [],
          };
        } else if (isHistoryProviderError(error)) {
          throw new ProviderRequestError((error as Error).message, prompt.historyReport);
        } else if (
          isProviderTimeoutError(error) &&
          !input.signal?.aborted &&
          providerTimeoutRecoveryAttempts < MAX_PROVIDER_TIMEOUT_RECOVERY_ATTEMPTS
        ) {
          providerTimeoutRecoveryAttempts += 1;
          recoveryInstruction = [
            "## Provider Stream Recovery Required",
            `The previous Provider stream became inactive and was abandoned before a complete assistant message was persisted (recovery ${providerTimeoutRecoveryAttempts}/${MAX_PROVIDER_TIMEOUT_RECOVERY_ATTEMPTS}).`,
            "All completed tool results and checkpoints remain authoritative in the transcript; no incomplete tool call from the abandoned stream was executed.",
            "Continue the same task from that persisted state. Do not repeat completed writes or re-emit whole file bodies; use apply_patch replace_text for existing-file edits.",
          ].join("\n");
          continue;
        } else {
          throw error;
        }
      }
      const usage = this.finalizeUsageSnapshot(prompt.contextBudget, response);
      await this.recordContextBudget(input.sessionId, input.turnId, "after_model", prompt.contextBudget, prompt.compaction, usage);

      if (atToolCycleBoundary) {
        const forceComplete = toolCycle >= this.maxToolCycles;
        const boundary = parseToolCycleBoundaryResponse(response, forceComplete);
        if (boundary.continueRequested) {
          const summary = boundary.content || `Tool cycle ${toolCycle} completed; additional tool work is required.`;
          await this.sessionStore.appendEvent(input.sessionId, {
            recordType: "context_summary",
            summaryId: randomUUID(),
            sessionId: input.sessionId,
            turnId: input.turnId,
            createdAt: now(),
            sourceType: "tool_cycle_checkpoint",
            sourceMessageId: assistantMessageId,
            summary,
            estimatedTokens: estimateTextTokens(summary),
          });
          await this.promoteExposedToolSummaryCandidates(input.sessionId, prompt.truncatedMessages);
          toolCycle += 1;
          toolLoopsInCycle = 0;
          continue;
        }

        const finalResponse = boundary.content || (forceComplete
          ? "已达到长任务全局安全预算；当前进度已保留，可继续输入“继续”恢复处理。"
          : "任务已完成，但模型未返回可显示的正文。");
        input.callbacks?.onTextDelta?.(finalResponse);
        const assistantMessage = await this.sessionStore.appendMessage({
          sessionId: input.sessionId,
          turnId: input.turnId,
          role: "assistant",
          content: finalResponse,
          reasoningContent: response.reasoningContent,
          metadata: {
            toolCycleBoundary: true,
            toolCycle,
            forcedByGlobalSafetyBudget: forceComplete,
            providerTimeoutRecovered: response.finishReason === "provider_timeout_recovered",
          },
        });
        assistantMessageId = assistantMessage.messageId;
        await this.promoteExposedToolSummaryCandidates(input.sessionId, prompt.truncatedMessages);
        await this.sessionStore.finishTurn({
          sessionId: input.sessionId,
          turnId: input.turnId,
          startedAt: input.startedAt,
          requestSummary: input.requestSummary,
          userMessageId: input.userMessageId,
          assistantMessageId,
          toolCallIds: input.toolCallIds,
          status: "waiting_for_user",
        });
        const updatedSession = await this.sessionStore.setSessionStatus(input.sessionId, "waiting_for_user");
        if (!forceComplete && input.recordDirectDsSuccess && input.initialRoutingDecision.finalTarget === "ds_direct" && !usedWorkerTool) {
          await this.sessionStore.recordDirectDsSuccess(input.sessionId, input.turnId);
        }
        return {
          sessionId: input.sessionId,
          session: updatedSession,
          finalResponse,
        };
      }

      if (
        !atToolCycleBoundary &&
        autonomousRecoveryAttempts < MAX_AUTONOMOUS_RECOVERY_ATTEMPTS &&
        shouldAutonomouslyRetry(response, lastToolResults)
      ) {
        autonomousRecoveryAttempts += 1;
        recoveryInstruction = buildRecoveryInstruction(lastToolResults);
        continue;
      }

      if (bufferPossibleRecovery && response.content) {
        input.callbacks?.onTextDelta?.(response.content);
      }

      const persistenceSafeToolCalls = response.toolCalls.map(
        (toolCall) => this.toolRuntime.redactToolCallForPersistence(toolCall),
      );
      const protectedToolCalls = response.toolCalls.filter((toolCall, index) => (
        persistenceSafeToolCalls[index]?.rawArguments !== toolCall.rawArguments
      ));
      const protectedWrites = await Promise.allSettled(
        protectedToolCalls.map((toolCall) => this.sessionStore.storeProtectedToolCall(input.sessionId, toolCall)),
      );
      const protectedWriteFailure = protectedWrites.find((write) => write.status === "rejected");
      if (protectedWriteFailure) {
        await Promise.allSettled(protectedToolCalls.map((toolCall) => (
          this.sessionStore.deleteProtectedToolCall(input.sessionId, toolCall.id)
        )));
        throw protectedWriteFailure.reason;
      }
      let assistantMessage: Awaited<ReturnType<SessionStore["appendMessage"]>>;
      try {
        assistantMessage = await this.sessionStore.appendMessage({
          sessionId: input.sessionId,
          turnId: input.turnId,
          role: "assistant",
          content: response.content,
          toolCalls: persistenceSafeToolCalls,
          reasoningContent: response.reasoningContent,
          metadata: response.toolCalls.length > 0
            ? {
                modelToolIteration: true,
                toolSelectionId: selectionId,
                providerCycle: activeLeases.providerCycle,
                activationLeaseIds: activeLeases.leaseIds,
                ...(providerTimeoutRecoveryAttempts > 0 ? { providerTimeoutRecoveryAttempts } : {}),
              }
            : providerTimeoutRecoveryAttempts > 0
              ? { providerTimeoutRecoveryAttempts }
              : undefined,
        });
      } catch (error) {
        await Promise.allSettled(protectedToolCalls.map((toolCall) => (
          this.sessionStore.deleteProtectedToolCall(input.sessionId, toolCall.id)
        )));
        throw error;
      }
      assistantMessageId = assistantMessage.messageId;
      if (assistantMessage.toolCalls && assistantMessage.toolCalls.length > 0) {
        input.callbacks?.onToolBatchStart?.({
          assistantMessageId: assistantMessage.messageId,
          turnId: assistantMessage.turnId,
          createdAt: assistantMessage.createdAt,
          toolCalls: assistantMessage.toolCalls,
        });
      }
      await this.promoteExposedToolSummaryCandidates(input.sessionId, prompt.truncatedMessages);

      if (response.toolCalls.length === 0) {
        await this.sessionStore.finishTurn({
          sessionId: input.sessionId,
          turnId: input.turnId,
          startedAt: input.startedAt,
          requestSummary: input.requestSummary,
          userMessageId: input.userMessageId,
          assistantMessageId,
          toolCallIds: input.toolCallIds,
          status: "waiting_for_user",
        });
        const updatedSession = await this.sessionStore.setSessionStatus(input.sessionId, "waiting_for_user");
        if (input.recordDirectDsSuccess && input.initialRoutingDecision.finalTarget === "ds_direct" && !usedWorkerTool) {
          await this.sessionStore.recordDirectDsSuccess(input.sessionId, input.turnId);
        }
        return {
          sessionId: input.sessionId,
          session: updatedSession,
          finalResponse: response.content,
        };
      }

      const currentToolBatchSignature = toolBatchSignature(response.toolCalls);
      identicalToolBatchCount = currentToolBatchSignature === previousToolBatchSignature
        ? identicalToolBatchCount + 1
        : 1;
      previousToolBatchSignature = currentToolBatchSignature;
      const repeatedToolBatch = identicalToolBatchCount >= MAX_IDENTICAL_TOOL_BATCHES;
      const toolResults = await this.executeToolCalls(
        input.sessionId,
        input.turnId,
        response,
        input.callbacks,
        input.toolCallIds,
        new Set(providerTools.map((tool) => tool.function.name)),
        exhaustedToolCallSignatures,
        repeatedToolBatch,
        input.signal,
      );
      lastToolResults = toolResults;
      recoveryInstruction = toolResults.some(isRecoverableToolFailure)
        ? buildRecoveryInstruction(toolResults)
        : undefined;
      toolLoopsInCycle = repeatedToolBatch ? TOOL_LOOPS_PER_CYCLE : toolLoopsInCycle + 1;
      if (response.toolCalls.some((toolCall) => isWorkerToolCall(toolCall.name))) {
        usedWorkerTool = true;
      }
      const failedWorkerTool = response.toolCalls.find(
        (toolCall, index) => isWorkerToolCall(toolCall.name) && !toolResults[index]?.success,
      );
      if (failedWorkerTool) {
        activeRoutingDecision = createFallbackRoutingDecision({
          previousDecision: activeRoutingDecision,
          reasonCode: failedWorkerTool.name === "invoke_coding_worker" ? "coding_worker_failed" : "vision_worker_failed",
        });
        await this.sessionStore.recordRoutingDecision({
          recordType: "routing_decision",
          sessionId: input.sessionId,
          turnId: input.turnId,
          createdAt: now(),
          ...activeRoutingDecision,
        });
      }
      const waitingControl = toolResults.find(
        (result) => result.control?.type === "wait_for_user",
      )?.control;
      for (const control of toolResults
        .map((result) => result.control)
        .filter((control) => control?.type === "continue")) {
        const state = await this.sessionStore.loadUserInputRequestState(
          input.sessionId,
          control.requestId,
        );
        if (state?.status === "pending") {
          input.callbacks?.onUserInputRequested?.(state.request);
        }
      }
      if (waitingControl?.type === "wait_for_user") {
        const state = await this.sessionStore.loadUserInputRequestState(
          input.sessionId,
          waitingControl.requestId,
        );
        if (!state || state.status !== "pending") {
          throw new Error(
            `The tool requested a user-input pause, but pending request ${waitingControl.requestId} was not persisted.`,
          );
        }
        const finalResponse = [
          state.request.title ?? "Input required",
          ...state.request.questions.map((question, index) =>
            `${index + 1}. ${question.prompt}`),
        ].join("\n");
        await this.sessionStore.finishTurn({
          sessionId: input.sessionId,
          turnId: input.turnId,
          startedAt: input.startedAt,
          requestSummary: input.requestSummary,
          userMessageId: input.userMessageId,
          assistantMessageId,
          toolCallIds: input.toolCallIds,
          status: "waiting_for_user",
        });
        const updatedSession = await this.sessionStore.setSessionStatus(
          input.sessionId,
          "waiting_for_user",
        );
        input.callbacks?.onUserInputRequested?.(state.request);
        return {
          sessionId: input.sessionId,
          session: updatedSession,
          finalResponse,
          pendingUserInput: state.request,
        };
      }
    }
  }

  private async finishFailedTurn(input: {
    sessionId: string;
    turnId: string;
    startedAt: string;
    requestSummary: string;
    userMessageId: string;
    assistantMessageId?: string;
    toolCallIds: string[];
    error: unknown;
  }): Promise<never> {
    const errorValue = input.error as Error;
    const currentSession = await this.sessionStore.loadSession(input.sessionId);
    const interrupted = currentSession?.status === "interrupted";
    const status = interrupted
      ? "interrupted"
      : input.error instanceof PermissionRequiredError
        ? "ask_permission"
        : "failed";
    let assistantMessageId = input.assistantMessageId;
    if (input.error instanceof PermissionRequiredError) {
      const latestAssistant = [...await this.sessionStore.loadMessages(input.sessionId)]
        .reverse()
        .find((message) =>
          message.turnId === input.turnId &&
          message.role === "assistant" &&
          (message.toolCalls?.length ?? 0) > 0);
      assistantMessageId = latestAssistant?.messageId ?? assistantMessageId;
    }
    if (!interrupted) {
      await this.hookBus.emit({
        name: "task_failed",
        createdAt: now(),
        sessionId: input.sessionId,
        turnId: input.turnId,
        payload: {
          error: errorValue.message,
        },
      });
    }
    await this.sessionStore.finishTurn({
      sessionId: input.sessionId,
      turnId: input.turnId,
      startedAt: input.startedAt,
      requestSummary: input.requestSummary,
      userMessageId: input.userMessageId,
      assistantMessageId,
      toolCallIds: input.toolCallIds,
      status,
      error: errorValue.message,
    });
    await this.sessionStore.setSessionStatus(input.sessionId, status);
    throw input.error;
  }

  private async applyRoutingDecision(input: {
    sessionId: string;
    turnId: string;
    prompt: string;
    routeDecision: RoutingDecision;
    callbacks: RunCallbacks | undefined;
    toolCallIds: string[];
  }): Promise<{
    decision: RoutingDecision;
    usedWorkerTool: boolean;
    assistantMessageId?: string;
  }> {
    await this.sessionStore.recordRoutingDecision({
      recordType: "routing_decision",
      sessionId: input.sessionId,
      turnId: input.turnId,
      createdAt: now(),
      ...input.routeDecision,
    });

    if (input.routeDecision.finalTarget === "ds_direct" || hasExplicitWorkerInstruction(input.prompt)) {
      return {
        decision: input.routeDecision,
        usedWorkerTool: false,
      };
    }

    if (input.routeDecision.finalTarget === "kimi_vision") {
      const autoVisionInput = buildAutoVisionWorkerInput(input.prompt, input.routeDecision);
      if (!autoVisionInput) {
        const fallbackDecision: RoutingDecision = {
          ...input.routeDecision,
          mode: "fallback",
          finalTarget: "ds_direct",
          ruleId: `${input.routeDecision.ruleId}:missing-vision-input`,
          reasonCodes: ["vision_input_missing", "fallback_to_governor"],
          reasonSummary: "Route fell back to DeepSeek because the prompt did not include a concrete image reference.",
        };
        await this.sessionStore.recordRoutingDecision({
          recordType: "routing_decision",
          sessionId: input.sessionId,
          turnId: input.turnId,
          createdAt: now(),
          ...fallbackDecision,
        });
        return {
          decision: fallbackDecision,
          usedWorkerTool: false,
        };
      }

      const toolCall = createSyntheticToolCall("invoke_vision_worker", autoVisionInput);
      const persistenceSafeToolCall = this.toolRuntime.redactToolCallForPersistence(toolCall);
      const assistantMessage = await this.sessionStore.appendMessage({
        sessionId: input.sessionId,
        turnId: input.turnId,
        role: "assistant",
        content: `Automatic routing decision: ${input.routeDecision.reasonSummary}`,
        toolCalls: [persistenceSafeToolCall],
        reasoningContent: "",
        metadata: {
          routeTarget: input.routeDecision.finalTarget,
          routeMode: input.routeDecision.mode,
        },
      });
      input.callbacks?.onToolBatchStart?.({
        assistantMessageId: assistantMessage.messageId,
        turnId: assistantMessage.turnId,
        createdAt: assistantMessage.createdAt,
        toolCalls: assistantMessage.toolCalls ?? [persistenceSafeToolCall],
      });
      const result = await this.executeRecordedToolCall(input.sessionId, input.turnId, toolCall, input.callbacks, input.toolCallIds);
      if (!result.success) {
        const fallbackDecision = createFallbackRoutingDecision({
          previousDecision: input.routeDecision,
          reasonCode: "vision_worker_failed",
        });
        await this.sessionStore.recordRoutingDecision({
          recordType: "routing_decision",
          sessionId: input.sessionId,
          turnId: input.turnId,
          createdAt: now(),
          ...fallbackDecision,
        });
        return {
          decision: fallbackDecision,
          usedWorkerTool: true,
          assistantMessageId: assistantMessage.messageId,
        };
      }

      return {
        decision: input.routeDecision,
        usedWorkerTool: true,
        assistantMessageId: assistantMessage.messageId,
      };
    }

    const codingTask = buildAutoCodingWorkerTask(input.prompt, input.routeDecision);
    const toolCall = createSyntheticToolCall("invoke_coding_worker", codingTask);
    const persistenceSafeToolCall = this.toolRuntime.redactToolCallForPersistence(toolCall);
    const assistantMessage = await this.sessionStore.appendMessage({
      sessionId: input.sessionId,
      turnId: input.turnId,
      role: "assistant",
      content: `Automatic routing decision: ${input.routeDecision.reasonSummary}`,
      toolCalls: [persistenceSafeToolCall],
      reasoningContent: "",
      metadata: {
        routeTarget: input.routeDecision.finalTarget,
        routeMode: input.routeDecision.mode,
      },
    });
    input.callbacks?.onToolBatchStart?.({
      assistantMessageId: assistantMessage.messageId,
      turnId: assistantMessage.turnId,
      createdAt: assistantMessage.createdAt,
      toolCalls: assistantMessage.toolCalls ?? [persistenceSafeToolCall],
    });
    const result = await this.executeRecordedToolCall(input.sessionId, input.turnId, toolCall, input.callbacks, input.toolCallIds);
    if (!result.success) {
      const fallbackDecision = createFallbackRoutingDecision({
        previousDecision: input.routeDecision,
        reasonCode: "coding_worker_failed",
      });
      await this.sessionStore.recordRoutingDecision({
        recordType: "routing_decision",
        sessionId: input.sessionId,
        turnId: input.turnId,
        createdAt: now(),
        ...fallbackDecision,
      });
      return {
        decision: fallbackDecision,
        usedWorkerTool: true,
        assistantMessageId: assistantMessage.messageId,
      };
    }

    return {
      decision: input.routeDecision,
      usedWorkerTool: true,
      assistantMessageId: assistantMessage.messageId,
    };
  }

  private async executeRecordedToolCall(
    sessionId: string,
    turnId: string,
    toolCall: ToolCall,
    callbacks: RunCallbacks | undefined,
    toolCallIds: string[],
    signal?: AbortSignal,
  ): Promise<ToolResult> {
    if (!toolCallIds.includes(toolCall.id)) {
      toolCallIds.push(toolCall.id);
    }
    let result: ToolResult;
    try {
      const persistenceSafeToolCall = this.toolRuntime.redactToolCallForPersistence(toolCall);
      callbacks?.onToolStart?.(persistenceSafeToolCall);
      await this.hookBus.emit({
        name: "tool_before",
        createdAt: now(),
        sessionId,
        turnId,
        toolName: toolCall.name,
        payload: persistenceSafeToolCall.arguments && typeof persistenceSafeToolCall.arguments === "object"
          ? (persistenceSafeToolCall.arguments as Record<string, unknown>)
          : { rawArguments: persistenceSafeToolCall.rawArguments },
      });
      result = await this.toolRuntime.executeTool(toolCall, sessionId, { turnId, signal });
    } catch (error) {
      // Approval pauses must retain the protected original for continuation.
      // All other terminal failures must remove the sensitive execution copy.
      if (!(error instanceof PermissionRequiredError)) {
        await this.sessionStore.deleteProtectedToolCall(sessionId, toolCall.id).catch(() => undefined);
      }
      throw error;
    }
    await this.sessionStore.deleteProtectedToolCall(sessionId, toolCall.id).catch(() => undefined);
    callbacks?.onToolEnd?.(result);
    await this.hookBus.emit({
      name: "tool_after",
      createdAt: now(),
      sessionId,
      turnId,
      toolName: toolCall.name,
      payload: {
        success: result.success,
        output: result.output,
        error: result.error,
        artifacts: result.artifacts,
        control: result.control,
      },
    });
    const contextSummaryCandidate = this.buildContextSummaryCandidate({ toolCall, result });
    await this.sessionStore.appendMessage({
      sessionId,
      turnId,
      role: "tool",
      content: result.output,
      name: toolCall.name,
      toolCallId: toolCall.id,
      metadata: {
        success: result.success,
        startedAt: result.startedAt,
        endedAt: result.endedAt,
        error: result.error,
        artifacts: result.artifacts,
        control: result.control,
        ...(contextSummaryCandidate
          ? { [TOOL_CONTEXT_SUMMARY_CANDIDATE_METADATA_KEY]: contextSummaryCandidate }
          : {}),
      },
    });
    if (isWorkerToolCall(toolCall.name) && result.success) {
      const structured = (result.structuredContent ?? {}) as {
        workerSessionId?: string;
      };
      await this.hookBus.emit({
        name: "worker_completed",
        createdAt: now(),
        sessionId,
        turnId,
        toolName: toolCall.name,
        workerSessionId: structured.workerSessionId,
        payload: {
          output: result.output,
        },
      });
    }
    return result;
  }

  private async recordProviderToolRejection(
    sessionId: string,
    turnId: string,
    toolCall: ToolCall,
    callbacks: RunCallbacks | undefined,
    toolCallIds: string[],
    errorType: "tool_not_selected" | "repeated_tool_call" | "waiting_for_user",
    message: string,
  ): Promise<ToolResult> {
    if (!toolCallIds.includes(toolCall.id)) toolCallIds.push(toolCall.id);
    const persistenceSafeToolCall = this.toolRuntime.redactToolCallForPersistence(toolCall);
    await this.sessionStore.deleteProtectedToolCall(sessionId, toolCall.id).catch(() => undefined);
    callbacks?.onToolStart?.(persistenceSafeToolCall);
    await this.hookBus.emit({
      name: "tool_before",
      createdAt: now(),
      sessionId,
      turnId,
      toolName: toolCall.name,
      payload: persistenceSafeToolCall.arguments && typeof persistenceSafeToolCall.arguments === "object"
        ? (persistenceSafeToolCall.arguments as Record<string, unknown>)
        : { rawArguments: persistenceSafeToolCall.rawArguments },
    });
    const timestamp = now();
    const rejectionBody = {
      kind: "tool_error",
      error: {
        type: errorType,
        message,
        retryable: errorType !== "repeated_tool_call",
        toolName: toolCall.name,
      },
    };
    const result: ToolResult = {
      toolName: toolCall.name,
      callId: toolCall.id,
      startedAt: timestamp,
      endedAt: timestamp,
      success: false,
      output: JSON.stringify(rejectionBody),
      structuredContent: rejectionBody,
      artifacts: [],
      error: message,
    };
    callbacks?.onToolEnd?.(result);
    await this.hookBus.emit({
      name: "tool_after",
      createdAt: now(),
      sessionId,
      turnId,
      toolName: toolCall.name,
      payload: {
        success: false,
        output: result.output,
        error: result.error,
        artifacts: [],
      },
    });
    await this.sessionStore.recordToolExecutionAudit({
      recordType: "tool_execution_audit",
      sessionId,
      callId: toolCall.id,
      toolName: toolCall.name,
      createdAt: timestamp,
      startedAt: timestamp,
      endedAt: timestamp,
      success: false,
      accessKinds: [],
      artifactUris: [],
      errorType,
    });
    const contextSummaryCandidate = this.buildContextSummaryCandidate({ toolCall, result });
    await this.sessionStore.appendMessage({
      sessionId,
      turnId,
      role: "tool",
      content: result.output,
      name: toolCall.name,
      toolCallId: toolCall.id,
      metadata: {
        success: false,
        startedAt: result.startedAt,
        endedAt: result.endedAt,
        error: result.error,
        artifacts: [],
        errorType,
        ...(contextSummaryCandidate
          ? { [TOOL_CONTEXT_SUMMARY_CANDIDATE_METADATA_KEY]: contextSummaryCandidate }
          : {}),
      },
    });
    return result;
  }

  private async executeToolCalls(
    sessionId: string,
    turnId: string,
    response: AssistantResponse,
    callbacks: RunCallbacks | undefined,
    toolCallIds: string[],
    allowedToolNames: ReadonlySet<string>,
    exhaustedToolCallSignatures: Set<string>,
    rejectRepeatedToolBatch = false,
    signal?: AbortSignal,
  ): Promise<ToolResult[]> {
    const results: ToolResult[] = [];
    let waitingRequestId: string | undefined;
    for (const toolCall of response.toolCalls) {
      throwIfAborted(signal);
      const callSignature = toolCallSignature(toolCall);
      if (waitingRequestId) {
        results.push(await this.recordProviderToolRejection(
          sessionId,
          turnId,
          toolCall,
          callbacks,
          toolCallIds,
          "waiting_for_user",
          `Tool call ${toolCall.name} was not executed because the earlier tool result paused for user input (${waitingRequestId}). Re-issue it after the answer if it is still needed.`,
        ));
      } else if (!allowedToolNames.has(toolCall.name)) {
        results.push(await this.recordProviderToolRejection(
          sessionId,
          turnId,
          toolCall,
          callbacks,
          toolCallIds,
          "tool_not_selected",
          `Tool ${toolCall.name} was not selected for this model turn. This does not mean the tool is globally disabled; continue with a selected tool or correct the task-specific tool choice.`,
        ));
      } else if (exhaustedToolCallSignatures.has(callSignature)) {
        results.push(await this.recordProviderToolRejection(
          sessionId,
          turnId,
          toolCall,
          callbacks,
          toolCallIds,
          "repeated_tool_call",
          "The identical tool call already returned retryable=false in this turn. Change strategy instead of repeating it.",
        ));
      } else if (rejectRepeatedToolBatch) {
        results.push(await this.recordProviderToolRejection(
          sessionId,
          turnId,
          toolCall,
          callbacks,
          toolCallIds,
          "repeated_tool_call",
          `The same tool-call batch was requested ${MAX_IDENTICAL_TOOL_BATCHES} consecutive times without convergence.`,
        ));
      } else {
        const result = await this.executeRecordedToolCall(
          sessionId,
          turnId,
          toolCall,
          callbacks,
          toolCallIds,
          signal,
        );
        results.push(result);
        if (result.control?.type === "wait_for_user") {
          waitingRequestId = result.control.requestId;
        }
        if (!result.success && toolResultStructuredError(result)?.retryable === false) {
          exhaustedToolCallSignatures.add(callSignature);
        }
      }
      throwIfAborted(signal);
    }
    return results;
  }

  private async loadContextSummaries(sessionId: string): Promise<ContextSummaryRecord[]> {
    const events = await this.sessionStore.loadEvents(sessionId);
    return events.filter((event): event is ContextSummaryRecord => event.recordType === "context_summary");
  }

  private async loadToolSelectionCarryover(
    sessionId: string,
    currentTurnId: string,
    requestSummary: string,
  ): Promise<string[]> {
    if (!isLikelyContinuationRequest(requestSummary)) return [];
    const selections = (await this.sessionStore.loadEvents(sessionId)).filter(
      (event): event is Extract<SessionEvent, { recordType: "tool_selection" }> =>
        event.recordType === "tool_selection" && event.turnId !== currentTurnId,
    );
    const previousTurnId = [...selections]
      .reverse()
      .find((selection) => selection.selectedToolNames.length > 0)?.turnId;
    if (!previousTurnId) return [];
    return [...new Set(
      selections
        .filter((selection) => selection.turnId === previousTurnId)
        .flatMap((selection) => selection.selectedToolNames.filter(
          (name) => !(selection.activatedToolNames ?? []).includes(name),
        )),
    )];
  }

  private async restoreToolLoopState(sessionId: string, turnId: string): Promise<ToolLoopState> {
    const [messages, events] = await Promise.all([
      this.sessionStore.loadMessages(sessionId),
      this.sessionStore.loadEvents(sessionId),
    ]);
    const turnMessages = messages.filter((message) => message.turnId === turnId);
    const checkpoints = events.filter(
      (event): event is ContextSummaryRecord =>
        event.recordType === "context_summary" &&
        event.turnId === turnId &&
        event.sourceType === "tool_cycle_checkpoint",
    );
    const lastCheckpoint = checkpoints.at(-1);
    const checkpointMessageIndex = lastCheckpoint?.sourceMessageId
      ? turnMessages.findIndex((message) => message.messageId === lastCheckpoint.sourceMessageId)
      : -1;
    const currentCycleMessages = checkpointMessageIndex >= 0
      ? turnMessages.slice(checkpointMessageIndex + 1)
      : lastCheckpoint
        ? turnMessages.filter((message) => message.createdAt > lastCheckpoint.createdAt)
        : turnMessages;
    const isModelToolIteration = (message: MessageRecord): boolean =>
      message.role === "assistant" &&
      (message.toolCalls?.length ?? 0) > 0 &&
      message.metadata?.routeTarget === undefined;
    const allToolIterations = turnMessages.filter(isModelToolIteration);
    const currentToolIterations = currentCycleMessages.filter(isModelToolIteration);
    const signatures = allToolIterations.map((message) => toolBatchSignature(message.toolCalls ?? []));
    const previousToolBatchSignature = signatures.at(-1);
    let identicalToolBatchCount = 0;
    if (previousToolBatchSignature) {
      for (let index = signatures.length - 1; index >= 0; index -= 1) {
        if (signatures[index] !== previousToolBatchSignature) break;
        identicalToolBatchCount += 1;
      }
    }
    return {
      toolCycle: checkpoints.length + 1,
      toolLoopsInCycle: currentToolIterations.length,
      previousToolBatchSignature,
      identicalToolBatchCount,
    };
  }

  private truncateSummaryText(text: string, maxChars = 240): string {
    const normalized = text.replace(/\s+/g, " ").trim();
    if (normalized.length <= maxChars) {
      return normalized;
    }
    return `${normalized.slice(0, maxChars - 16)}...[truncated]`;
  }

  private summarizeStableOutput(text: string | undefined, maxChars: number): string | undefined {
    if (!text) return undefined;
    const normalized = text
      .split(/\r?\n/u)
      .map((line) => line.trim())
      .filter(Boolean)
      .join(" | ");
    if (!normalized) return undefined;
    if (normalized.length <= maxChars) return normalized;
    const marker = " ...[middle omitted; use safe read-only verification for exact details]... ";
    const available = Math.max(2, maxChars - marker.length);
    const headChars = Math.ceil(available * 0.65);
    const tailChars = Math.max(1, available - headChars);
    return `${normalized.slice(0, headChars)}${marker}${normalized.slice(-tailChars)}`;
  }

  private summarizeCommandOutput(text: string | undefined): string | undefined {
    return this.summarizeStableOutput(text, 480);
  }

  private buildContextSummaryCandidate(input: {
    toolCall: ToolCall;
    result: ToolResult;
  }): PersistedToolContextSummaryCandidate | undefined {
    const rawOutputChars = input.result.output.length;

    const structured = (input.result.structuredContent ?? {}) as Record<string, unknown>;
    let summary: string | undefined;
    let keyPaths: string[] | undefined;
    let keyFiles: string[] | undefined;
    let command: string | undefined;

    if (input.toolCall.name === "read_file") {
      const filePath = typeof structured.path === "string" ? structured.path : "unknown";
      const startLine = typeof structured.returnedStartLine === "number"
        ? structured.returnedStartLine
        : typeof structured.startLine === "number"
          ? structured.startLine
          : undefined;
      const endLine = typeof structured.returnedEndLine === "number"
        ? structured.returnedEndLine
        : typeof structured.endLine === "number"
          ? structured.endLine
          : undefined;
      const returnedChars = typeof structured.returnedChars === "number" ? structured.returnedChars : undefined;
      const totalChars = typeof structured.totalChars === "number" ? structured.totalChars : undefined;
      const totalLines = typeof structured.totalLines === "number" ? structured.totalLines : undefined;
      const nextStartLine = typeof structured.nextStartLine === "number" ? structured.nextStartLine : undefined;
      const truncationReason = typeof structured.truncationReason === "string" ? structured.truncationReason : undefined;
      const excerpt = this.summarizeStableOutput(
        typeof structured.content === "string" ? structured.content : undefined,
        720,
      );
      keyPaths = [filePath];
      keyFiles = [filePath];
      summary = [
        `read ${filePath}${startLine !== undefined && endLine !== undefined ? ` returned lines ${startLine}-${endLine}` : ""}`,
        returnedChars !== undefined ? `returnedChars=${returnedChars}` : undefined,
        totalLines !== undefined ? `totalLines=${totalLines}` : undefined,
        totalChars !== undefined ? `totalChars=${totalChars}` : undefined,
        structured.truncated
          ? `truncated reason=${truncationReason ?? "unknown"}${nextStartLine !== undefined ? ` nextStartLine=${nextStartLine}` : ""}`
          : "range complete",
        excerpt ? `excerpt: ${excerpt}` : undefined,
      ].filter((value): value is string => typeof value === "string").join("; ");
    } else if (input.toolCall.name === "run_shell") {
      const raw = (structured.raw ?? {}) as {
        stdout?: string;
        stderr?: string;
        exitCode?: number;
      };
      command = typeof structured.command === "string" ? structured.command : undefined;
      keyPaths = typeof structured.cwd === "string" ? [structured.cwd] : undefined;
      const stdoutHead = this.summarizeCommandOutput(raw.stdout);
      const stderrHead = this.summarizeCommandOutput(raw.stderr);
      summary = `ran ${command ?? "shell command"}${typeof structured.cwd === "string" ? ` in ${structured.cwd}` : ""} -> exit ${
        typeof raw.exitCode === "number" ? raw.exitCode : "unknown"
      }${stderrHead ? `; stderr: ${stderrHead}` : stdoutHead ? `; stdout: ${stdoutHead}` : ""}`;
    }

    if (!summary) {
      const excerpt = this.summarizeStableOutput(input.result.output, 960);
      summary = `${input.toolCall.name} ${input.result.success ? "succeeded" : "failed"}${excerpt ? `; output: ${excerpt}` : ""}`;
    }

    return {
      version: 1,
      summary: this.truncateSummaryText(summary, TOOL_CONTEXT_SUMMARY_MAX_CHARS),
      rawOutputChars,
      keyPaths: this.boundContextSummaryStrings(keyPaths),
      keyFiles: this.boundContextSummaryStrings(keyFiles),
      command: command?.trim().slice(0, 1_000) || undefined,
    };
  }

  private boundContextSummaryStrings(values: unknown): string[] | undefined {
    const bounded = [...new Set((Array.isArray(values) ? values : [])
      .filter((value): value is string => typeof value === "string")
      .map((value) => value.trim())
      .filter(Boolean))]
      .slice(0, 8)
      .map((value) => value.slice(0, 1_000));
    return bounded.length > 0 ? bounded : undefined;
  }

  private readContextSummaryCandidate(message: MessageRecord): PersistedToolContextSummaryCandidate | undefined {
    const value = message.metadata?.[TOOL_CONTEXT_SUMMARY_CANDIDATE_METADATA_KEY];
    if (!value || typeof value !== "object") {
      return undefined;
    }
    const candidate = value as Partial<PersistedToolContextSummaryCandidate>;
    if (candidate.version !== 1 || typeof candidate.summary !== "string") {
      return undefined;
    }
    const summary = this.truncateSummaryText(candidate.summary, TOOL_CONTEXT_SUMMARY_MAX_CHARS);
    if (!summary) {
      return undefined;
    }
    return {
      version: 1,
      summary,
      rawOutputChars: typeof candidate.rawOutputChars === "number" && candidate.rawOutputChars >= 0
        ? candidate.rawOutputChars
        : message.content.length,
      keyPaths: this.boundContextSummaryStrings(candidate.keyPaths),
      keyFiles: this.boundContextSummaryStrings(candidate.keyFiles),
      command: typeof candidate.command === "string"
        ? candidate.command.trim().slice(0, 1_000) || undefined
        : undefined,
      rawOutputRef: typeof candidate.rawOutputRef === "string"
        ? candidate.rawOutputRef.trim().slice(0, 2_000) || undefined
        : undefined,
    };
  }

  private async promoteExposedToolSummaryCandidates(
    sessionId: string,
    exposedMessages: MessageRecord[],
  ): Promise<void> {
    const summaries = await this.loadContextSummaries(sessionId);
    const promotedMessageIds = new Set(
      summaries.map((summary) => summary.sourceMessageId).filter((value): value is string => typeof value === "string"),
    );
    const promotedToolCallIds = new Set(
      summaries.map((summary) => summary.sourceToolCallId).filter((value): value is string => typeof value === "string"),
    );

    for (const message of exposedMessages) {
      if (
        message.role !== "tool" ||
        promotedMessageIds.has(message.messageId) ||
        (message.toolCallId ? promotedToolCallIds.has(message.toolCallId) : false)
      ) {
        continue;
      }
      const candidate = this.readContextSummaryCandidate(message);
      if (!candidate) {
        continue;
      }
      if (!isPostExposureToolSummaryEligible(message.name, candidate.rawOutputChars)) {
        continue;
      }
      const rawOutputRef = candidate.rawOutputRef || `message://${message.messageId}`;
      const providerSummaryText = formatPostExposureToolSummary({
        toolName: message.name,
        rawOutputRef,
        summary: candidate.summary,
      });
      if (estimateTextTokens(providerSummaryText) >= estimateTextTokens(message.content)) {
        continue;
      }
      const record: ContextSummaryRecord = {
        recordType: "context_summary",
        summaryId: randomUUID(),
        sessionId,
        turnId: message.turnId,
        createdAt: now(),
        sourceType: "tool_output",
        sourceToolName: message.name,
        sourceMessageId: message.messageId,
        sourceToolCallId: message.toolCallId,
        sourceRawChars: candidate.rawOutputChars,
        toolOutputLifecycle: "raw_once_then_summary_v1",
        summary: candidate.summary,
        estimatedTokens: estimateTextTokens(candidate.summary),
        keyPaths: candidate.keyPaths,
        keyFiles: candidate.keyFiles,
        command: candidate.command,
        rawOutputRef,
      };
      await this.sessionStore.appendEvent(sessionId, record);
      promotedMessageIds.add(message.messageId);
      if (message.toolCallId) {
        promotedToolCallIds.add(message.toolCallId);
      }
    }
  }

  private finalizeUsageSnapshot(
    contextBudget: ContextBudgetSnapshot,
    response: AssistantResponse,
  ): TokenUsageSnapshot {
    const estimated = createEstimatedUsageSnapshot({
      model: this.routeProfile.model,
      recordedAt: now(),
      inputTokens: contextBudget.usedInputTokens,
      outputTokens: estimateAssistantOutputTokens(response),
      reasoningTokens: estimateTextTokens(response.reasoningContent ?? ""),
    });
    if (!response.usage) {
      return estimated;
    }

    const usage: TokenUsageSnapshot = {
      ...estimated,
      ...response.usage,
      source: response.usage.source,
      model: response.usage.model ?? estimated.model,
      recordedAt: response.usage.recordedAt ?? estimated.recordedAt,
      inputTokens: response.usage.inputTokens ?? estimated.inputTokens,
      outputTokens: response.usage.outputTokens ?? estimated.outputTokens,
      reasoningTokens: response.usage.reasoningTokens ?? estimated.reasoningTokens,
      cachedInputTokens: response.usage.cachedInputTokens,
      uncachedInputTokens: response.usage.uncachedInputTokens,
      totalTokens:
        response.usage.totalTokens ??
        ((response.usage.inputTokens ?? estimated.inputTokens ?? 0) + (response.usage.outputTokens ?? estimated.outputTokens ?? 0)),
    };
    return usage;
  }

  private async recordContextBudget(
    sessionId: string,
    turnId: string,
    scope: ContextBudgetScope,
    snapshot: ContextBudgetSnapshot,
    compaction: ContextCompactionRecord,
    usage?: TokenUsageSnapshot,
  ): Promise<void> {
    await this.sessionStore.appendEvent(sessionId, {
      recordType: "context_budget",
      sessionId,
      turnId,
      createdAt: now(),
      scope,
      snapshot,
      usage,
      compaction,
    });
    await this.sessionStore.updateSession(sessionId, (session) => ({
      ...session,
      latestContextBudget: snapshot,
      latestCompaction: compaction,
      latestTokenUsage: usage ?? session.latestTokenUsage,
      cumulativeTokenUsage: usage ? accumulateUsageSnapshots(session.cumulativeTokenUsage, usage) : session.cumulativeTokenUsage,
    }));
  }

  private async recordHistoryIntegrity(
    sessionId: string,
    turnId: string | undefined,
    scope: HistoryIntegrityScope,
    report: HistoryIntegrityReport,
  ): Promise<void> {
    await this.sessionStore.appendEvent(sessionId, {
      recordType: "history_integrity",
      sessionId,
      turnId,
      createdAt: now(),
      scope,
      outcome: report.outcome,
      summary: report.summary,
      messageCountBefore: report.messageCountBefore,
      messageCountAfter: report.messageCountAfter,
      safeBoundaryTurnId: report.safeBoundaryTurnId,
      issues: report.issues,
      actions: report.actions,
    });
  }

  private registerTurnAbortController(sessionId: string): AbortController {
    const previous = this.activeTurnControllers.get(sessionId);
    if (previous && !previous.signal.aborted) {
      previous.abort(new Error("Superseded by a newer turn."));
    }
    const controller = new AbortController();
    this.activeTurnControllers.set(sessionId, controller);
    return controller;
  }

  private releaseTurnAbortController(sessionId: string, controller: AbortController): void {
    if (this.activeTurnControllers.get(sessionId) === controller) {
      this.activeTurnControllers.delete(sessionId);
    }
  }
}

export { PermissionRequiredError };
