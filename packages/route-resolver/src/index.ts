import { randomUUID } from "node:crypto";
import type {
  GovernorModelConfig,
  ModelAssignmentSnapshot,
  ReasoningEffort,
  ReplyStyle,
  RouteProfile,
  ThinkingModeType,
} from "../../shared-schema/src/index.js";
import { ProfileService } from "../../model-adapters/src/index.js";
import { loadDeepMixSettingsSync, resolveEffectiveModelSettings } from "../../settings/src/index.js";
export {
  DEFAULT_ROUTING_POLICY,
  createFallbackRoutingDecision,
  extractContextRefs,
  extractImageRef,
  extractRoutingFeatures,
  inferVisionSourceType,
  inferVisionTaskType,
  normalizeRouteOverride,
  resolveRoutingDecision,
  type RoutingPolicyConfig,
  type RoutingRule,
} from "./routing-policy.js";

export interface ApiKeyLibraryProfileStatus {
  exists: boolean;
  hasKey: boolean;
}

export interface CodingWorkerModelConfig {
  apiKey?: string;
  profileId?: string;
  provider?: string;
  adapterId?: string;
  protocol?: string;
  capabilities?: import("../../shared-schema/src/index.js").ModelCapabilityManifest;
  baseUrl: string;
  endpointPath: string;
  model: string;
  role: "coding_worker";
  contextWindow: number;
  maxRetries: number;
  timeoutMs: number;
  temperature: number;
  maxContextChars: number;
  maxContextFiles: number;
  headers: Record<string, string>;
  requestDefaults: Record<string, unknown>;
  workspaceWriteAccess: false;
}

export interface VisionWorkerModelConfig {
  apiKey?: string;
  profileId?: string;
  provider?: string;
  adapterId?: string;
  protocol?: string;
  capabilities?: import("../../shared-schema/src/index.js").ModelCapabilityManifest;
  baseUrl: string;
  endpointPath: string;
  model: string;
  role: "vision_worker";
  contextWindow: number;
  maxRetries: number;
  timeoutMs: number;
  maxContextChars: number;
  maxImageBytes: number;
  maxImageDimension: number;
  targetImageDimension: number;
  targetImageBytes: number;
  imageInputMode: "base64_data_url";
  responseFormat: "json_object";
  headers: Record<string, string>;
  requestDefaults: Record<string, unknown>;
  supportsMultimodalInput: boolean;
}

export function createModelAssignmentSnapshot(input: {
  slot: "governor" | "coding" | "vision";
  config: GovernorModelConfig | CodingWorkerModelConfig | VisionWorkerModelConfig;
  configRevision: number;
  fallbackIndex?: number;
  selectionReason: ModelAssignmentSnapshot["selectionReason"];
  source: ModelAssignmentSnapshot["source"];
}): ModelAssignmentSnapshot {
  const capabilities = input.config.capabilities ?? {
    textInput: true,
    imageInput: input.slot === "vision",
    streaming: input.slot === "governor" && "stream" in input.config ? input.config.stream : false,
    nativeToolCalling: input.slot === "governor",
    structuredOutput: input.slot !== "governor",
    reasoning: input.slot === "governor",
    contextWindow: input.config.contextWindow,
  };
  const snapshot: ModelAssignmentSnapshot = {
    schemaVersion: 1,
    assignmentId: randomUUID(),
    configRevision: input.configRevision,
    slot: input.slot,
    routeTarget: input.slot === "governor" ? "governor_direct" : input.slot === "coding" ? "coding_worker" : "vision_worker",
    profileId: input.config.profileId ?? `legacy_${input.slot}`,
    provider: input.config.provider ?? `legacy-${input.slot}`,
    model: input.config.model,
    adapterId: input.config.adapterId ?? "openai_compatible",
    protocol: input.config.protocol ?? "openai_chat_completions",
    capabilities: Object.freeze({ ...capabilities }),
    selectedAt: new Date().toISOString(),
    selectionReason: input.selectionReason,
    fallbackIndex: input.fallbackIndex ?? 0,
    source: input.source,
  };
  return Object.freeze(snapshot);
}

function parseBoolean(value: string | undefined, defaultValue: boolean): boolean {
  if (value === undefined) {
    return defaultValue;
  }

  return value === "1" || value.toLowerCase() === "true";
}

function parseInteger(value: string | undefined, fallback: number): number {
  const parsed = Number.parseInt(value ?? "", 10);
  return Number.isFinite(parsed) ? parsed : fallback;
}

function parseNumber(value: string | undefined, fallback: number): number {
  const parsed = Number.parseFloat(value ?? "");
  return Number.isFinite(parsed) ? parsed : fallback;
}

function clampInteger(value: number, min: number, max: number): number {
  return Math.min(Math.max(value, min), max);
}

function parseThinkingMode(value: string | undefined): ThinkingModeType {
  if (value === "disabled" || value === "enabled" || value === "adaptive") {
    return value;
  }
  return "disabled";
}

function parseReasoningEffort(value: string | undefined): ReasoningEffort {
  if (value === "low" || value === "medium" || value === "high" || value === "not_applicable") {
    return value;
  }
  return "not_applicable";
}

function parseReplyStyle(value: string | undefined): ReplyStyle {
  return value === "friendly" ? "friendly" : "pragmatic";
}

function numberFromSetting(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}

function stringFromSetting(value: unknown): string | undefined {
  return typeof value === "string" && value.trim().length > 0 ? value.trim() : undefined;
}

function booleanFromSetting(value: unknown): boolean | undefined {
  return typeof value === "boolean" ? value : undefined;
}

export function resolveApiKeyLibraryPath(
  workspaceRoot: string,
  env: NodeJS.ProcessEnv = process.env,
): string | undefined {
  return new ProfileService(workspaceRoot, env).resolveLibraryPath();
}

export function inspectApiKeyLibraryProfiles<const TName extends string>(
  workspaceRoot: string,
  profileNames: readonly TName[],
  env: NodeJS.ProcessEnv = process.env,
): Record<TName, ApiKeyLibraryProfileStatus> {
  const statuses = new ProfileService(workspaceRoot, env).inspect(profileNames);
  return Object.fromEntries(profileNames.map((profileName) => [profileName, {
    exists: statuses[profileName].exists,
    hasKey: statuses[profileName].hasKey,
  }])) as Record<TName, ApiKeyLibraryProfileStatus>;
}

function environmentValue(
  env: NodeJS.ProcessEnv,
  genericName: string,
  legacyName: string,
  settingsVersion: number | undefined,
): string | undefined {
  return env[genericName]?.trim() || (settingsVersion === 2 ? undefined : env[legacyName]?.trim());
}

function modelSourceFromEnvironment(
  env: NodeJS.ProcessEnv,
  slot: "governor" | "coding" | "vision",
  settingsVersion: number | undefined,
  preset: "classic" | "custom",
): ModelAssignmentSnapshot["source"] {
  const genericPrefix = `DEEP_MIX_${slot.toUpperCase()}_`;
  const legacyPrefixes = slot === "governor"
    ? ["DEEPSEEK_"]
    : slot === "coding"
      ? ["GLM_CODING_WORKER_"]
      : ["KIMI_VISION_WORKER_"];
  const hasOverride = Object.entries(env).some(([name, value]) => Boolean(value?.trim()) && (
    name.startsWith(genericPrefix) || (settingsVersion !== 2 && legacyPrefixes.some((prefix) => name.startsWith(prefix)))
  ));
  return hasOverride ? "environment" : preset === "classic" ? "classic" : "settings";
}

function assertSlotProfile(
  service: ProfileService,
  slot: "governor" | "coding" | "vision",
  profileId: string,
  requirements: import("../../shared-schema/src/index.js").ModelSlotBinding["requirements"],
): void {
  const mandatory = slot === "governor"
    ? { textInput: true }
    : slot === "coding"
      ? { textInput: true, structuredOutput: true }
      : { textInput: true, imageInput: true, structuredOutput: true };
  const gate = service.gate(slot, profileId, { ...mandatory, ...(requirements ?? {}) });
  if (!gate.ok) {
    throw new Error(`capability_unavailable: slot=${slot}; profile=${profileId}; missing=${gate.missing.join(",")}`);
  }
  if (!gate.profile.adapterId) {
    throw new Error(`adapter_not_found: profile=${profileId}; protocol=${gate.profile.protocol}`);
  }
}

export function loadGovernorModelConfig(
  workspaceRoot: string,
  env: NodeJS.ProcessEnv = process.env,
): GovernorModelConfig {
  const loadedSettings = loadDeepMixSettingsSync(workspaceRoot, { collectErrors: false });
  const governorSettings = loadedSettings.settings.governor ?? {};
  const binding = resolveEffectiveModelSettings(loadedSettings.settings).slots.governor;
  const service = new ProfileService(workspaceRoot, env);
  const profileId = environmentValue(env, "DEEP_MIX_GOVERNOR_PROFILE", "DEEPSEEK_GOVERNOR_PROFILE", loadedSettings.settings.version)
    ?? binding.primary.profile;
  assertSlotProfile(service, "governor", profileId, binding.requirements);
  const modelOverride = environmentValue(env, "DEEP_MIX_GOVERNOR_MODEL", "DEEPSEEK_MODEL", loadedSettings.settings.version)
    ?? binding.primary.model
    ?? stringFromSetting(governorSettings.model);
  const profile = service.resolveProfile(profileId, modelOverride);
  const contextWindow = parseInteger(environmentValue(env, "DEEP_MIX_GOVERNOR_CONTEXT_WINDOW", "DEEPSEEK_CONTEXT_WINDOW", loadedSettings.settings.version), numberFromSetting(governorSettings.contextWindow) ?? profile.capabilities.contextWindow);
  const reserveOutputTokens = clampInteger(
    parseInteger(
      environmentValue(env, "DEEP_MIX_GOVERNOR_CONTEXT_RESERVE_OUTPUT_TOKENS", "DEEPSEEK_CONTEXT_RESERVE_OUTPUT_TOKENS", loadedSettings.settings.version),
      numberFromSetting(governorSettings.contextReserveOutputTokens) ??
      Math.min(8192, Math.max(2048, Math.floor(contextWindow * 0.08))),
    ),
    512,
    Math.max(512, contextWindow - 1024),
  );
  const inputBudgetCeiling = Math.max(2048, contextWindow - reserveOutputTokens);
  const contextSoftLimitTokens = clampInteger(
    parseInteger(environmentValue(env, "DEEP_MIX_GOVERNOR_CONTEXT_SOFT_LIMIT_TOKENS", "DEEPSEEK_CONTEXT_SOFT_LIMIT_TOKENS", loadedSettings.settings.version), numberFromSetting(governorSettings.contextSoftLimitTokens) ?? inputBudgetCeiling),
    2048,
    inputBudgetCeiling,
  );
  const contextCompactThresholdTokens = clampInteger(
    parseInteger(
      environmentValue(env, "DEEP_MIX_GOVERNOR_CONTEXT_COMPACT_THRESHOLD_TOKENS", "DEEPSEEK_CONTEXT_COMPACT_THRESHOLD_TOKENS", loadedSettings.settings.version),
      numberFromSetting(governorSettings.contextCompactThresholdTokens) ??
      Math.max(2048, contextSoftLimitTokens - Math.max(2048, Math.floor(contextWindow * 0.12))),
    ),
    1024,
    contextSoftLimitTokens,
  );
  const contextSummaryMaxTokens = clampInteger(
    parseInteger(environmentValue(env, "DEEP_MIX_GOVERNOR_CONTEXT_SUMMARY_MAX_TOKENS", "DEEPSEEK_CONTEXT_SUMMARY_MAX_TOKENS", loadedSettings.settings.version), numberFromSetting(governorSettings.contextSummaryMaxTokens) ?? 2048),
    256,
    contextSoftLimitTokens,
  );
  const contextRecentTailMaxTokens = clampInteger(
    parseInteger(
      environmentValue(env, "DEEP_MIX_GOVERNOR_CONTEXT_RECENT_TAIL_MAX_TOKENS", "DEEPSEEK_CONTEXT_RECENT_TAIL_MAX_TOKENS", loadedSettings.settings.version),
      numberFromSetting(governorSettings.contextRecentTailMaxTokens) ??
      Math.max(4096, Math.floor(contextSoftLimitTokens * 0.35)),
    ),
    512,
    contextSoftLimitTokens,
  );
  return {
    apiKey: profile.apiKey,
    profileId: profile.profileId,
    provider: profile.provider,
    adapterId: profile.adapterId,
    protocol: profile.protocol,
    capabilities: profile.capabilities,
    baseUrl: environmentValue(env, "DEEP_MIX_GOVERNOR_BASE_URL", "DEEPSEEK_BASE_URL", loadedSettings.settings.version)?.replace(/\/$/, "") ?? profile.baseUrl.replace(/\/$/, ""),
    endpointPath: environmentValue(env, "DEEP_MIX_GOVERNOR_ENDPOINT_PATH", "DEEPSEEK_ENDPOINT_PATH", loadedSettings.settings.version) ?? profile.endpointPath,
    model: profile.model,
    role: "governor",
    stream: parseBoolean(environmentValue(env, "DEEP_MIX_GOVERNOR_STREAM", "DEEPSEEK_STREAM", loadedSettings.settings.version), booleanFromSetting(governorSettings.stream) ?? true),
    contextWindow,
    maxRetries: parseInteger(environmentValue(env, "DEEP_MIX_GOVERNOR_MAX_RETRIES", "DEEPSEEK_MAX_RETRIES", loadedSettings.settings.version), numberFromSetting(governorSettings.maxRetries) ?? 2),
    timeoutMs: parseInteger(environmentValue(env, "DEEP_MIX_GOVERNOR_TIMEOUT_MS", "DEEPSEEK_TIMEOUT_MS", loadedSettings.settings.version), numberFromSetting(governorSettings.timeoutMs) ?? 600_000),
    contextSoftLimitTokens,
    contextCompactThresholdTokens,
    contextReserveOutputTokens: reserveOutputTokens,
    contextSummaryMaxTokens,
    contextRecentTailMaxTokens,
    maxHistoryMessages: parseInteger(environmentValue(env, "DEEP_MIX_GOVERNOR_MAX_HISTORY_MESSAGES", "DEEPSEEK_MAX_HISTORY_MESSAGES", loadedSettings.settings.version), numberFromSetting(governorSettings.maxHistoryMessages) ?? 0),
    historyCharBudget: parseInteger(environmentValue(env, "DEEP_MIX_GOVERNOR_HISTORY_CHAR_BUDGET", "DEEPSEEK_HISTORY_CHAR_BUDGET", loadedSettings.settings.version), numberFromSetting(governorSettings.historyCharBudget) ?? 16000),
    temperature: parseNumber(environmentValue(env, "DEEP_MIX_GOVERNOR_TEMPERATURE", "DEEPSEEK_TEMPERATURE", loadedSettings.settings.version), numberFromSetting(governorSettings.temperature) ?? 0.2),
    thinking: {
      type: parseThinkingMode(environmentValue(env, "DEEP_MIX_GOVERNOR_THINKING_MODE", "DEEPSEEK_THINKING_MODE", loadedSettings.settings.version) ?? stringFromSetting(governorSettings.thinkingMode)),
      reasoningEffort: parseReasoningEffort(environmentValue(env, "DEEP_MIX_GOVERNOR_REASONING_EFFORT", "DEEPSEEK_REASONING_EFFORT", loadedSettings.settings.version) ?? stringFromSetting(governorSettings.reasoningEffort)),
    },
    headers: profile.headers,
    requestDefaults: profile.requestDefaults,
    replyStyle: parseReplyStyle(environmentValue(env, "DEEP_MIX_GOVERNOR_REPLY_STYLE", "DEEPSEEK_REPLY_STYLE", loadedSettings.settings.version) ?? stringFromSetting(governorSettings.replyStyle)),
  };
}

export function loadGovernorModelCandidates(
  workspaceRoot: string,
  env: NodeJS.ProcessEnv = process.env,
): {
  configs: GovernorModelConfig[];
  fallbackPolicy: import("../../shared-schema/src/index.js").ModelFallbackPolicy;
  settingsRevision: number;
  preset: "classic" | "custom";
  source: ModelAssignmentSnapshot["source"];
} {
  const loaded = loadDeepMixSettingsSync(workspaceRoot, { collectErrors: false });
  const models = resolveEffectiveModelSettings(loaded.settings);
  const binding = models.slots.governor;
  const primary = loadGovernorModelConfig(workspaceRoot, env);
  const policy = binding.fallbackPolicy ?? { enabled: false, on: [] };
  const service = new ProfileService(workspaceRoot, env);
  const fallbacks = policy.enabled ? binding.fallbacks.map((reference): GovernorModelConfig => {
    assertSlotProfile(service, "governor", reference.profile, binding.requirements);
    const profile = service.resolveProfile(reference.profile, reference.model);
    return {
      ...primary,
      apiKey: profile.apiKey,
      profileId: profile.profileId,
      provider: profile.provider,
      adapterId: profile.adapterId,
      protocol: profile.protocol,
      capabilities: profile.capabilities,
      baseUrl: profile.baseUrl,
      endpointPath: profile.endpointPath,
      model: profile.model,
      headers: profile.headers,
      requestDefaults: profile.requestDefaults,
    };
  }) : [];
  return {
    configs: [primary, ...fallbacks],
    fallbackPolicy: policy,
    settingsRevision: loaded.settings.version === 2 ? loaded.settings.revision ?? 0 : 0,
    preset: models.preset,
    source: modelSourceFromEnvironment(env, "governor", loaded.settings.version, models.preset),
  };
}

export async function loadCodingWorkerModelConfig(
  workspaceRoot: string,
  env: NodeJS.ProcessEnv = process.env,
): Promise<CodingWorkerModelConfig> {
  const loadedSettings = loadDeepMixSettingsSync(workspaceRoot, { collectErrors: false });
  const workerSettings = loadedSettings.settings.codingWorker ?? {};
  const binding = resolveEffectiveModelSettings(loadedSettings.settings).slots.coding;
  const service = new ProfileService(workspaceRoot, env);
  const profileId = environmentValue(env, "DEEP_MIX_CODING_PROFILE", "GLM_CODING_WORKER_PROFILE", loadedSettings.settings.version)
    ?? binding.primary.profile;
  assertSlotProfile(service, "coding", profileId, binding.requirements);
  const modelOverride = environmentValue(env, "DEEP_MIX_CODING_MODEL", "GLM_CODING_WORKER_MODEL", loadedSettings.settings.version)
    ?? binding.primary.model
    ?? stringFromSetting(workerSettings.model);
  const profile = service.resolveProfile(profileId, modelOverride);
  return {
    apiKey: profile.apiKey,
    profileId: profile.profileId,
    provider: profile.provider,
    adapterId: profile.adapterId,
    protocol: profile.protocol,
    capabilities: profile.capabilities,
    baseUrl: profile.baseUrl.replace(/\/$/, ""),
    endpointPath: profile.endpointPath,
    model: profile.model,
    role: "coding_worker",
    contextWindow: parseInteger(environmentValue(env, "DEEP_MIX_CODING_CONTEXT_WINDOW", "GLM_CODING_WORKER_CONTEXT_WINDOW", loadedSettings.settings.version), numberFromSetting(workerSettings.contextWindow) ?? profile.capabilities.contextWindow),
    maxRetries: parseInteger(environmentValue(env, "DEEP_MIX_CODING_MAX_RETRIES", "GLM_CODING_WORKER_MAX_RETRIES", loadedSettings.settings.version), numberFromSetting(workerSettings.maxRetries) ?? 1),
    timeoutMs: parseInteger(environmentValue(env, "DEEP_MIX_CODING_TIMEOUT_MS", "GLM_CODING_WORKER_TIMEOUT_MS", loadedSettings.settings.version), numberFromSetting(workerSettings.timeoutMs) ?? 180000),
    temperature: parseNumber(environmentValue(env, "DEEP_MIX_CODING_TEMPERATURE", "GLM_CODING_WORKER_TEMPERATURE", loadedSettings.settings.version), numberFromSetting(workerSettings.temperature) ?? 0.1),
    maxContextChars: parseInteger(environmentValue(env, "DEEP_MIX_CODING_MAX_CONTEXT_CHARS", "GLM_CODING_WORKER_MAX_CONTEXT_CHARS", loadedSettings.settings.version), numberFromSetting(workerSettings.maxContextChars) ?? 24000),
    maxContextFiles: parseInteger(environmentValue(env, "DEEP_MIX_CODING_MAX_CONTEXT_FILES", "GLM_CODING_WORKER_MAX_CONTEXT_FILES", loadedSettings.settings.version), numberFromSetting(workerSettings.maxContextFiles) ?? 6),
    headers: profile.headers,
    requestDefaults: profile.requestDefaults,
    workspaceWriteAccess: false,
  };
}

export async function loadCodingWorkerModelCandidates(
  workspaceRoot: string,
  env: NodeJS.ProcessEnv = process.env,
): Promise<{
  configs: CodingWorkerModelConfig[];
  fallbackPolicy: import("../../shared-schema/src/index.js").ModelFallbackPolicy;
  settingsRevision: number;
  preset: "classic" | "custom";
  source: ModelAssignmentSnapshot["source"];
}> {
  const loaded = loadDeepMixSettingsSync(workspaceRoot, { collectErrors: false });
  const models = resolveEffectiveModelSettings(loaded.settings);
  const binding = models.slots.coding;
  const primary = await loadCodingWorkerModelConfig(workspaceRoot, env);
  const policy = binding.fallbackPolicy ?? { enabled: false, on: [] };
  const service = new ProfileService(workspaceRoot, env);
  const fallbacks = policy.enabled ? binding.fallbacks.map((reference): CodingWorkerModelConfig => {
    assertSlotProfile(service, "coding", reference.profile, binding.requirements);
    const profile = service.resolveProfile(reference.profile, reference.model);
    return {
      ...primary,
      apiKey: profile.apiKey,
      profileId: profile.profileId,
      provider: profile.provider,
      adapterId: profile.adapterId,
      protocol: profile.protocol,
      capabilities: profile.capabilities,
      baseUrl: profile.baseUrl,
      endpointPath: profile.endpointPath,
      model: profile.model,
      contextWindow: profile.capabilities.contextWindow,
      headers: profile.headers,
      requestDefaults: profile.requestDefaults,
    };
  }) : [];
  return {
    configs: [primary, ...fallbacks],
    fallbackPolicy: policy,
    settingsRevision: loaded.settings.version === 2 ? loaded.settings.revision ?? 0 : 0,
    preset: models.preset,
    source: modelSourceFromEnvironment(env, "coding", loaded.settings.version, models.preset),
  };
}

export async function loadVisionWorkerModelConfig(
  workspaceRoot: string,
  env: NodeJS.ProcessEnv = process.env,
): Promise<VisionWorkerModelConfig> {
  const loadedSettings = loadDeepMixSettingsSync(workspaceRoot, { collectErrors: false });
  const workerSettings = loadedSettings.settings.visionWorker ?? {};
  const binding = resolveEffectiveModelSettings(loadedSettings.settings).slots.vision;
  const service = new ProfileService(workspaceRoot, env);
  const profileId = environmentValue(env, "DEEP_MIX_VISION_PROFILE", "KIMI_VISION_WORKER_PROFILE", loadedSettings.settings.version)
    ?? binding.primary.profile;
  assertSlotProfile(service, "vision", profileId, binding.requirements);
  const modelOverride = environmentValue(env, "DEEP_MIX_VISION_MODEL", "KIMI_VISION_WORKER_MODEL", loadedSettings.settings.version)
    ?? binding.primary.model
    ?? stringFromSetting(workerSettings.model);
  const profile = service.resolveProfile(profileId, modelOverride);
  return {
    apiKey: profile.apiKey,
    profileId: profile.profileId,
    provider: profile.provider,
    adapterId: profile.adapterId,
    protocol: profile.protocol,
    capabilities: profile.capabilities,
    baseUrl: profile.baseUrl.replace(/\/$/, ""),
    endpointPath: profile.endpointPath,
    model: profile.model,
    role: "vision_worker",
    contextWindow: parseInteger(environmentValue(env, "DEEP_MIX_VISION_CONTEXT_WINDOW", "KIMI_VISION_WORKER_CONTEXT_WINDOW", loadedSettings.settings.version), numberFromSetting(workerSettings.contextWindow) ?? profile.capabilities.contextWindow),
    maxRetries: parseInteger(environmentValue(env, "DEEP_MIX_VISION_MAX_RETRIES", "KIMI_VISION_WORKER_MAX_RETRIES", loadedSettings.settings.version), numberFromSetting(workerSettings.maxRetries) ?? 1),
    timeoutMs: parseInteger(environmentValue(env, "DEEP_MIX_VISION_TIMEOUT_MS", "KIMI_VISION_WORKER_TIMEOUT_MS", loadedSettings.settings.version), numberFromSetting(workerSettings.timeoutMs) ?? 120000),
    maxContextChars: parseInteger(environmentValue(env, "DEEP_MIX_VISION_MAX_CONTEXT_CHARS", "KIMI_VISION_WORKER_MAX_CONTEXT_CHARS", loadedSettings.settings.version), numberFromSetting(workerSettings.maxContextChars) ?? 12000),
    maxImageBytes: parseInteger(environmentValue(env, "DEEP_MIX_VISION_MAX_IMAGE_BYTES", "KIMI_VISION_WORKER_MAX_IMAGE_BYTES", loadedSettings.settings.version), numberFromSetting(workerSettings.maxImageBytes) ?? 20 * 1024 * 1024),
    maxImageDimension: parseInteger(environmentValue(env, "DEEP_MIX_VISION_MAX_IMAGE_DIMENSION", "KIMI_VISION_WORKER_MAX_IMAGE_DIMENSION", loadedSettings.settings.version), numberFromSetting(workerSettings.maxImageDimension) ?? 4096),
    targetImageDimension: parseInteger(environmentValue(env, "DEEP_MIX_VISION_TARGET_IMAGE_DIMENSION", "KIMI_VISION_WORKER_TARGET_IMAGE_DIMENSION", loadedSettings.settings.version), numberFromSetting(workerSettings.targetImageDimension) ?? 2048),
    targetImageBytes: parseInteger(environmentValue(env, "DEEP_MIX_VISION_TARGET_IMAGE_BYTES", "KIMI_VISION_WORKER_TARGET_IMAGE_BYTES", loadedSettings.settings.version), numberFromSetting(workerSettings.targetImageBytes) ?? 4 * 1024 * 1024),
    imageInputMode: "base64_data_url",
    responseFormat: "json_object",
    headers: profile.headers,
    requestDefaults: profile.requestDefaults,
    supportsMultimodalInput: profile.capabilities.imageInput,
  };
}

export async function loadVisionWorkerModelCandidates(
  workspaceRoot: string,
  env: NodeJS.ProcessEnv = process.env,
): Promise<{
  configs: VisionWorkerModelConfig[];
  fallbackPolicy: import("../../shared-schema/src/index.js").ModelFallbackPolicy;
  settingsRevision: number;
  preset: "classic" | "custom";
  source: ModelAssignmentSnapshot["source"];
}> {
  const loaded = loadDeepMixSettingsSync(workspaceRoot, { collectErrors: false });
  const models = resolveEffectiveModelSettings(loaded.settings);
  const binding = models.slots.vision;
  const primary = await loadVisionWorkerModelConfig(workspaceRoot, env);
  const policy = binding.fallbackPolicy ?? { enabled: false, on: [] };
  const service = new ProfileService(workspaceRoot, env);
  const fallbacks = policy.enabled ? binding.fallbacks.map((reference): VisionWorkerModelConfig => {
    assertSlotProfile(service, "vision", reference.profile, binding.requirements);
    const profile = service.resolveProfile(reference.profile, reference.model);
    return {
      ...primary,
      apiKey: profile.apiKey,
      profileId: profile.profileId,
      provider: profile.provider,
      adapterId: profile.adapterId,
      protocol: profile.protocol,
      capabilities: profile.capabilities,
      baseUrl: profile.baseUrl,
      endpointPath: profile.endpointPath,
      model: profile.model,
      contextWindow: profile.capabilities.contextWindow,
      headers: profile.headers,
      requestDefaults: profile.requestDefaults,
      supportsMultimodalInput: profile.capabilities.imageInput,
    };
  }) : [];
  return {
    configs: [primary, ...fallbacks],
    fallbackPolicy: policy,
    settingsRevision: loaded.settings.version === 2 ? loaded.settings.revision ?? 0 : 0,
    preset: models.preset,
    source: modelSourceFromEnvironment(env, "vision", loaded.settings.version, models.preset),
  };
}

export function createGovernorRouteProfile(config: GovernorModelConfig): RouteProfile {
  return {
    provider: config.provider ?? "legacy-governor",
    model: config.model,
    role: "governor",
    contextWindow: config.contextWindow,
    toolCallingMode: "provider_native",
    thinkingMode: {
      mode: config.thinking.type,
      reasoningEffort: config.thinking.reasoningEffort,
    },
    pricing: {
      input: { available: false },
      output: { available: false },
      cacheRead: { available: false },
      cacheWrite: { available: false },
    },
    maxInputSize: {
      value: config.contextWindow,
      unit: "tokens",
    },
  };
}

export function createCodingWorkerRouteProfile(config: CodingWorkerModelConfig): RouteProfile {
  return {
    provider: config.provider ?? "legacy-coding",
    model: config.model,
    role: "coding_worker",
    contextWindow: config.contextWindow,
    toolCallingMode: "disabled",
    thinkingMode: {
      mode: "disabled",
      reasoningEffort: "not_applicable",
    },
    pricing: {
      input: { available: false },
      output: { available: false },
      cacheRead: { available: false },
      cacheWrite: { available: false },
    },
    maxInputSize: {
      value: config.maxContextChars,
      unit: "characters",
    },
  };
}

export function createVisionWorkerRouteProfile(config: VisionWorkerModelConfig): RouteProfile {
  return {
    provider: config.provider ?? "legacy-vision",
    model: config.model,
    role: "vision_worker",
    contextWindow: config.contextWindow,
    toolCallingMode: "disabled",
    thinkingMode: {
      mode: "disabled",
      reasoningEffort: "not_applicable",
    },
    pricing: {
      input: { available: false },
      output: { available: false },
      cacheRead: { available: false },
      cacheWrite: { available: false },
    },
    maxInputSize: {
      value: config.maxImageBytes,
      unit: "bytes",
    },
  };
}

export function resolveDeepSeekRequestConfig(route: RouteProfile, config: GovernorModelConfig): {
  model: string;
  stream: boolean;
  temperature: number;
  reasoningEffort?: Exclude<ReasoningEffort, "not_applicable">;
  extraBody?: Record<string, unknown>;
} {
  if (route.role !== "governor") {
    throw new Error(`Governor request config only supports governor role, received ${route.role}.`);
  }

  const requestConfig: {
    model: string;
    stream: boolean;
    temperature: number;
    reasoningEffort?: Exclude<ReasoningEffort, "not_applicable">;
    extraBody?: Record<string, unknown>;
  } = {
    model: route.model,
    stream: config.stream,
    temperature: config.temperature,
  };

  if (route.thinkingMode.mode !== "disabled") {
    requestConfig.extraBody = {
      thinking: {
        type: "enabled",
      },
    };

    if (route.thinkingMode.reasoningEffort !== "not_applicable") {
      requestConfig.reasoningEffort = route.thinkingMode.reasoningEffort;
    }
  }

  return requestConfig;
}

/** @deprecated Use loadGovernorModelConfig. */
export const loadDeepSeekProviderConfig = loadGovernorModelConfig;
/** @deprecated Use loadCodingWorkerModelConfig. */
export const loadGlmCodingWorkerConfig = loadCodingWorkerModelConfig;
/** @deprecated Use loadVisionWorkerModelConfig. */
export const loadKimiVisionWorkerConfig = loadVisionWorkerModelConfig;

/** @deprecated Classic compatibility aliases. */
export type GlmCodingWorkerConfig = CodingWorkerModelConfig;
/** @deprecated Classic compatibility aliases. */
export type KimiVisionWorkerConfig = VisionWorkerModelConfig;
