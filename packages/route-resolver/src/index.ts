import { readFile } from "node:fs/promises";
import { existsSync, readFileSync } from "node:fs";
import path from "node:path";
import type {
  DeepSeekProviderConfig,
  ReasoningEffort,
  ReplyStyle,
  RouteProfile,
  ThinkingModeType,
} from "../../shared-schema/src/index.js";
import { loadDeepMixSettingsSync } from "../../settings/src/index.js";
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

interface ApiKeyLibraryProfile {
  provider: string;
  role: string;
  apiKey?: string;
  apiKeyEnvName?: string;
  baseUrl: string;
  chatPath: string;
  model: string;
  supportsMultimodalInput?: boolean;
  headers?: Record<string, string>;
  requestDefaults?: Record<string, unknown>;
}

interface ApiKeyLibrary {
  version: number;
  profiles: Record<string, ApiKeyLibraryProfile>;
}

export interface ApiKeyLibraryProfileStatus {
  exists: boolean;
  hasKey: boolean;
}

export interface DeepSeekProviderConfigLoadOptions {
  allowMissingProfileForInjectedClient?: boolean;
}

export interface GlmCodingWorkerConfig {
  apiKey?: string;
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

export interface KimiVisionWorkerConfig {
  apiKey?: string;
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

function resolveApiKey(profile: ApiKeyLibraryProfile, env: NodeJS.ProcessEnv): string | undefined {
  const inline = profile.apiKey?.trim();
  if (inline) {
    return inline;
  }

  if (!profile.apiKeyEnvName) {
    return undefined;
  }

  const fromEnv = env[profile.apiKeyEnvName]?.trim();
  return fromEnv || undefined;
}

async function loadApiKeyLibrary(
  workspaceRoot: string,
  env: NodeJS.ProcessEnv = process.env,
): Promise<ApiKeyLibrary> {
  const libraryPath = resolveApiKeyLibraryPath(workspaceRoot, env);
  if (!libraryPath) {
    throw new Error(buildMissingApiKeyLibraryMessage(workspaceRoot, env));
  }
  const raw = await readFile(libraryPath, "utf8");
  return JSON.parse(raw) as ApiKeyLibrary;
}

function loadApiKeyLibrarySync(
  workspaceRoot: string,
  env: NodeJS.ProcessEnv = process.env,
): ApiKeyLibrary {
  const libraryPath = resolveApiKeyLibraryPath(workspaceRoot, env);
  if (!libraryPath) {
    throw new Error(buildMissingApiKeyLibraryMessage(workspaceRoot, env));
  }
  const raw = readFileSync(libraryPath, "utf8");
  return JSON.parse(raw) as ApiKeyLibrary;
}

function ancestorApiKeyLibraryPaths(start: string): string[] {
  const candidates: string[] = [];
  let current = path.resolve(start);
  while (true) {
    candidates.push(path.join(current, ".deep-mix", "api-key-library", "profiles.local.json"));
    const parent = path.dirname(current);
    if (parent === current) break;
    current = parent;
  }
  return candidates;
}

function candidateApiKeyLibraryPaths(
  workspaceRoot: string,
  env: NodeJS.ProcessEnv = process.env,
): string[] {
  const configuredFallbackRoot = env.DEEP_MIX_API_KEY_LIBRARY_ROOT?.trim();
  const candidates = [
    path.resolve(workspaceRoot, ".deep-mix", "api-key-library", "profiles.local.json"),
    ...(configuredFallbackRoot
      ? [path.resolve(configuredFallbackRoot, ".deep-mix", "api-key-library", "profiles.local.json")]
      : []),
    ...ancestorApiKeyLibraryPaths(process.cwd()),
  ];
  return [...new Set(candidates)];
}

function buildMissingApiKeyLibraryMessage(
  workspaceRoot: string,
  env: NodeJS.ProcessEnv = process.env,
): string {
  const searched = candidateApiKeyLibraryPaths(workspaceRoot, env);
  return [
    "Could not find .deep-mix/api-key-library/profiles.local.json.",
    `Searched: ${searched.join(" | ")}`,
    "Create the local API key library in the target workspace, or launch Deep-Mix from a directory that already contains it.",
  ].join(" ");
}

export function resolveApiKeyLibraryPath(
  workspaceRoot: string,
  env: NodeJS.ProcessEnv = process.env,
): string | undefined {
  return candidateApiKeyLibraryPaths(workspaceRoot, env).find((candidate) => existsSync(candidate));
}

export function inspectApiKeyLibraryProfiles<const TName extends string>(
  workspaceRoot: string,
  profileNames: readonly TName[],
  env: NodeJS.ProcessEnv = process.env,
): Record<TName, ApiKeyLibraryProfileStatus> {
  const libraries = candidateApiKeyLibraryPaths(workspaceRoot, env).flatMap((libraryPath) => {
    if (!existsSync(libraryPath)) return [];
    try {
      return [JSON.parse(readFileSync(libraryPath, "utf8")) as ApiKeyLibrary];
    } catch {
      return [];
    }
  });
  const expectedRoles: Record<string, string> = {
    deepseek_governor: "governor",
    glm_coding_worker: "coding_worker",
    kimi_vision: "vision_worker",
  };
  return Object.fromEntries(profileNames.map((profileName) => {
    const expectedRole = expectedRoles[profileName];
    const profile = libraries
      .map((library) => library.profiles?.[profileName])
      .find((candidate) => !!candidate && (!expectedRole || candidate.role === expectedRole));
    return [profileName, {
      exists: !!profile,
      hasKey: !!profile && !!resolveApiKey(profile, env),
    }];
  })) as Record<TName, ApiKeyLibraryProfileStatus>;
}

async function loadRequiredProfile(
  workspaceRoot: string,
  profileName: string,
  expectedRole: string,
  env: NodeJS.ProcessEnv = process.env,
): Promise<ApiKeyLibraryProfile> {
  let foundRoleMismatch: string | undefined;
  for (const libraryPath of candidateApiKeyLibraryPaths(workspaceRoot, env)) {
    if (!existsSync(libraryPath)) {
      continue;
    }
    const raw = await readFile(libraryPath, "utf8");
    const library = JSON.parse(raw) as ApiKeyLibrary;
    const profile = library.profiles[profileName];
    if (!profile) {
      continue;
    }
    if (profile.role !== expectedRole) {
      foundRoleMismatch = profile.role;
      continue;
    }
    return profile;
  }
  if (foundRoleMismatch) {
    throw new Error(`Profile ${profileName} has role ${foundRoleMismatch}, expected ${expectedRole}.`);
  }
  throw new Error(`Missing profile in local API key library: ${profileName}`);
}

function loadRequiredProfileSync(
  workspaceRoot: string,
  profileName: string,
  expectedRole: string,
  env: NodeJS.ProcessEnv = process.env,
): ApiKeyLibraryProfile {
  let foundRoleMismatch: string | undefined;
  for (const libraryPath of candidateApiKeyLibraryPaths(workspaceRoot, env)) {
    if (!existsSync(libraryPath)) {
      continue;
    }
    const raw = readFileSync(libraryPath, "utf8");
    const library = JSON.parse(raw) as ApiKeyLibrary;
    const profile = library.profiles[profileName];
    if (!profile) {
      continue;
    }
    if (profile.role !== expectedRole) {
      foundRoleMismatch = profile.role;
      continue;
    }
    return profile;
  }
  if (foundRoleMismatch) {
    throw new Error(`Profile ${profileName} has role ${foundRoleMismatch}, expected ${expectedRole}.`);
  }
  throw new Error(`Missing profile in local API key library: ${profileName}`);
}

async function loadOptionalProfileWithFallback(
  workspaceRoot: string,
  input: {
    explicitProfileName?: string;
    configuredProfileName?: string;
    defaultProfileName: string;
    expectedRole: string;
  },
  env: NodeJS.ProcessEnv = process.env,
): Promise<ApiKeyLibraryProfile> {
  if (input.explicitProfileName) {
    return loadRequiredProfile(workspaceRoot, input.explicitProfileName, input.expectedRole, env);
  }
  if (input.configuredProfileName) {
    try {
      return await loadRequiredProfile(workspaceRoot, input.configuredProfileName, input.expectedRole, env);
    } catch (error) {
      if (input.configuredProfileName !== input.defaultProfileName) {
        return loadRequiredProfile(workspaceRoot, input.defaultProfileName, input.expectedRole, env);
      }
      throw error;
    }
  }
  return loadRequiredProfile(workspaceRoot, input.defaultProfileName, input.expectedRole, env);
}

function loadOptionalProfileSyncWithFallback(
  workspaceRoot: string,
  input: {
    explicitProfileName?: string;
    configuredProfileName?: string;
    defaultProfileName: string;
    expectedRole: string;
  },
  env: NodeJS.ProcessEnv = process.env,
): ApiKeyLibraryProfile {
  if (input.explicitProfileName) {
    return loadRequiredProfileSync(workspaceRoot, input.explicitProfileName, input.expectedRole, env);
  }
  if (input.configuredProfileName) {
    try {
      return loadRequiredProfileSync(workspaceRoot, input.configuredProfileName, input.expectedRole, env);
    } catch (error) {
      if (input.configuredProfileName !== input.defaultProfileName) {
        return loadRequiredProfileSync(workspaceRoot, input.defaultProfileName, input.expectedRole, env);
      }
      throw error;
    }
  }
  return loadRequiredProfileSync(workspaceRoot, input.defaultProfileName, input.expectedRole, env);
}

export function loadDeepSeekProviderConfig(
  workspaceRoot: string,
  env: NodeJS.ProcessEnv = process.env,
  options: DeepSeekProviderConfigLoadOptions = {},
): DeepSeekProviderConfig {
  const loadedSettings = loadDeepMixSettingsSync(workspaceRoot, { collectErrors: false });
  const governorSettings = loadedSettings.settings.governor ?? {};
  let profile: ApiKeyLibraryProfile;
  try {
    profile = loadOptionalProfileSyncWithFallback(workspaceRoot, {
      explicitProfileName: env.DEEPSEEK_GOVERNOR_PROFILE,
      configuredProfileName: stringFromSetting(governorSettings.profile),
      defaultProfileName: "deepseek_governor",
      expectedRole: "governor",
    }, env);
  } catch (error) {
    const isMissingProfile = error instanceof Error &&
      error.message.startsWith("Missing profile in local API key library:");
    if (!options.allowMissingProfileForInjectedClient || !isMissingProfile) {
      throw error;
    }
    profile = {
      provider: "deepseek",
      role: "governor",
      baseUrl: "https://example.invalid",
      chatPath: "/chat/completions",
      model: "deepseek-chat",
    };
  }
  const contextWindow = parseInteger(env.DEEPSEEK_CONTEXT_WINDOW, numberFromSetting(governorSettings.contextWindow) ?? 128000);
  const reserveOutputTokens = clampInteger(
    parseInteger(
      env.DEEPSEEK_CONTEXT_RESERVE_OUTPUT_TOKENS,
      numberFromSetting(governorSettings.contextReserveOutputTokens) ??
      Math.min(8192, Math.max(2048, Math.floor(contextWindow * 0.08))),
    ),
    512,
    Math.max(512, contextWindow - 1024),
  );
  const inputBudgetCeiling = Math.max(2048, contextWindow - reserveOutputTokens);
  const contextSoftLimitTokens = clampInteger(
    parseInteger(env.DEEPSEEK_CONTEXT_SOFT_LIMIT_TOKENS, numberFromSetting(governorSettings.contextSoftLimitTokens) ?? inputBudgetCeiling),
    2048,
    inputBudgetCeiling,
  );
  const contextCompactThresholdTokens = clampInteger(
    parseInteger(
      env.DEEPSEEK_CONTEXT_COMPACT_THRESHOLD_TOKENS,
      numberFromSetting(governorSettings.contextCompactThresholdTokens) ??
      Math.max(2048, contextSoftLimitTokens - Math.max(2048, Math.floor(contextWindow * 0.12))),
    ),
    1024,
    contextSoftLimitTokens,
  );
  const contextSummaryMaxTokens = clampInteger(
    parseInteger(env.DEEPSEEK_CONTEXT_SUMMARY_MAX_TOKENS, numberFromSetting(governorSettings.contextSummaryMaxTokens) ?? 2048),
    256,
    contextSoftLimitTokens,
  );
  const contextRecentTailMaxTokens = clampInteger(
    parseInteger(
      env.DEEPSEEK_CONTEXT_RECENT_TAIL_MAX_TOKENS,
      numberFromSetting(governorSettings.contextRecentTailMaxTokens) ??
      Math.max(4096, Math.floor(contextSoftLimitTokens * 0.35)),
    ),
    512,
    contextSoftLimitTokens,
  );
  return {
    apiKey: resolveApiKey(profile, env),
    baseUrl: env.DEEPSEEK_BASE_URL?.replace(/\/$/, "") ?? profile.baseUrl.replace(/\/$/, ""),
    endpointPath: env.DEEPSEEK_ENDPOINT_PATH ?? profile.chatPath,
    model: env.DEEPSEEK_MODEL ?? stringFromSetting(governorSettings.model) ?? profile.model,
    role: "governor",
    stream: parseBoolean(env.DEEPSEEK_STREAM, booleanFromSetting(governorSettings.stream) ?? true),
    contextWindow,
    maxRetries: parseInteger(env.DEEPSEEK_MAX_RETRIES, numberFromSetting(governorSettings.maxRetries) ?? 2),
    timeoutMs: parseInteger(env.DEEPSEEK_TIMEOUT_MS, numberFromSetting(governorSettings.timeoutMs) ?? 600_000),
    contextSoftLimitTokens,
    contextCompactThresholdTokens,
    contextReserveOutputTokens: reserveOutputTokens,
    contextSummaryMaxTokens,
    contextRecentTailMaxTokens,
    maxHistoryMessages: parseInteger(env.DEEPSEEK_MAX_HISTORY_MESSAGES, numberFromSetting(governorSettings.maxHistoryMessages) ?? 0),
    historyCharBudget: parseInteger(env.DEEPSEEK_HISTORY_CHAR_BUDGET, numberFromSetting(governorSettings.historyCharBudget) ?? 16000),
    temperature: parseNumber(env.DEEPSEEK_TEMPERATURE, numberFromSetting(governorSettings.temperature) ?? 0.2),
    thinking: {
      type: parseThinkingMode(env.DEEPSEEK_THINKING_MODE ?? stringFromSetting(governorSettings.thinkingMode)),
      reasoningEffort: parseReasoningEffort(env.DEEPSEEK_REASONING_EFFORT ?? stringFromSetting(governorSettings.reasoningEffort)),
    },
    replyStyle: parseReplyStyle(env.DEEPSEEK_REPLY_STYLE ?? stringFromSetting(governorSettings.replyStyle)),
  };
}

export async function loadGlmCodingWorkerConfig(
  workspaceRoot: string,
  env: NodeJS.ProcessEnv = process.env,
): Promise<GlmCodingWorkerConfig> {
  const loadedSettings = loadDeepMixSettingsSync(workspaceRoot, { collectErrors: false });
  const workerSettings = loadedSettings.settings.codingWorker ?? {};
  const profile = await loadOptionalProfileWithFallback(workspaceRoot, {
    explicitProfileName: env.GLM_CODING_WORKER_PROFILE,
    configuredProfileName: stringFromSetting(workerSettings.profile),
    defaultProfileName: "glm_coding_worker",
    expectedRole: "coding_worker",
  }, env);
  return {
    apiKey: resolveApiKey(profile, env),
    baseUrl: profile.baseUrl.replace(/\/$/, ""),
    endpointPath: profile.chatPath,
    model: stringFromSetting(workerSettings.model) ?? profile.model,
    role: "coding_worker",
    contextWindow: parseInteger(env.GLM_CODING_WORKER_CONTEXT_WINDOW, numberFromSetting(workerSettings.contextWindow) ?? 128000),
    maxRetries: parseInteger(env.GLM_CODING_WORKER_MAX_RETRIES, numberFromSetting(workerSettings.maxRetries) ?? 1),
    timeoutMs: parseInteger(env.GLM_CODING_WORKER_TIMEOUT_MS, numberFromSetting(workerSettings.timeoutMs) ?? 180000),
    temperature: parseNumber(env.GLM_CODING_WORKER_TEMPERATURE, numberFromSetting(workerSettings.temperature) ?? 0.1),
    maxContextChars: parseInteger(env.GLM_CODING_WORKER_MAX_CONTEXT_CHARS, numberFromSetting(workerSettings.maxContextChars) ?? 24000),
    maxContextFiles: parseInteger(env.GLM_CODING_WORKER_MAX_CONTEXT_FILES, numberFromSetting(workerSettings.maxContextFiles) ?? 6),
    headers: profile.headers ?? { "Content-Type": "application/json" },
    requestDefaults: profile.requestDefaults ?? {},
    workspaceWriteAccess: false,
  };
}

export async function loadKimiVisionWorkerConfig(
  workspaceRoot: string,
  env: NodeJS.ProcessEnv = process.env,
): Promise<KimiVisionWorkerConfig> {
  const loadedSettings = loadDeepMixSettingsSync(workspaceRoot, { collectErrors: false });
  const workerSettings = loadedSettings.settings.visionWorker ?? {};
  const profile = await loadOptionalProfileWithFallback(workspaceRoot, {
    explicitProfileName: env.KIMI_VISION_WORKER_PROFILE,
    configuredProfileName: stringFromSetting(workerSettings.profile),
    defaultProfileName: "kimi_vision",
    expectedRole: "vision_worker",
  }, env);
  return {
    apiKey: resolveApiKey(profile, env),
    baseUrl: profile.baseUrl.replace(/\/$/, ""),
    endpointPath: profile.chatPath,
    model: stringFromSetting(workerSettings.model) ?? profile.model,
    role: "vision_worker",
    contextWindow: parseInteger(env.KIMI_VISION_WORKER_CONTEXT_WINDOW, numberFromSetting(workerSettings.contextWindow) ?? 256000),
    maxRetries: parseInteger(env.KIMI_VISION_WORKER_MAX_RETRIES, numberFromSetting(workerSettings.maxRetries) ?? 1),
    timeoutMs: parseInteger(env.KIMI_VISION_WORKER_TIMEOUT_MS, numberFromSetting(workerSettings.timeoutMs) ?? 120000),
    maxContextChars: parseInteger(env.KIMI_VISION_WORKER_MAX_CONTEXT_CHARS, numberFromSetting(workerSettings.maxContextChars) ?? 12000),
    maxImageBytes: parseInteger(env.KIMI_VISION_WORKER_MAX_IMAGE_BYTES, numberFromSetting(workerSettings.maxImageBytes) ?? 20 * 1024 * 1024),
    maxImageDimension: parseInteger(env.KIMI_VISION_WORKER_MAX_IMAGE_DIMENSION, numberFromSetting(workerSettings.maxImageDimension) ?? 4096),
    targetImageDimension: parseInteger(env.KIMI_VISION_WORKER_TARGET_IMAGE_DIMENSION, numberFromSetting(workerSettings.targetImageDimension) ?? 2048),
    targetImageBytes: parseInteger(env.KIMI_VISION_WORKER_TARGET_IMAGE_BYTES, numberFromSetting(workerSettings.targetImageBytes) ?? 4 * 1024 * 1024),
    imageInputMode: "base64_data_url",
    responseFormat: "json_object",
    headers: profile.headers ?? { "Content-Type": "application/json" },
    requestDefaults: profile.requestDefaults ?? {},
    supportsMultimodalInput: profile.supportsMultimodalInput ?? true,
  };
}

export function createGovernorRouteProfile(config: DeepSeekProviderConfig): RouteProfile {
  return {
    provider: "deepseek",
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

export function createCodingWorkerRouteProfile(config: GlmCodingWorkerConfig): RouteProfile {
  return {
    provider: "glm",
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

export function createVisionWorkerRouteProfile(config: KimiVisionWorkerConfig): RouteProfile {
  return {
    provider: "kimi",
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

export function resolveDeepSeekRequestConfig(route: RouteProfile, config: DeepSeekProviderConfig): {
  model: string;
  stream: boolean;
  temperature: number;
  reasoningEffort?: Exclude<ReasoningEffort, "not_applicable">;
  extraBody?: Record<string, unknown>;
} {
  if (route.role !== "governor") {
    throw new Error(`DeepSeek request config only supports governor role, received ${route.role}.`);
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
