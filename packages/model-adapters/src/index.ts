import { randomUUID } from "node:crypto";

import type {
  AssistantResponse,
  ConversationMessage,
  ModelCapabilityManifest,
  ModelClient,
  ModelCompletionRequest,
  ModelFallbackTrigger,
  ModelSlotId,
  StreamCallbacks,
  TokenUsageSnapshot,
  ToolCall,
} from "../../shared-schema/src/index.js";
import { DsmlTextStreamFilter, normalizeAssistantToolCalls } from "./tool-call-normalization.js";

export interface ResolvedModelProfile {
  profileId: string;
  provider: string;
  protocol: string;
  adapterId: string;
  baseUrl: string;
  endpointPath: string;
  model: string;
  capabilities: ModelCapabilityManifest;
  allowedSlots: ModelSlotId[];
  apiKey?: string;
  headers: Record<string, string>;
  requestDefaults: Record<string, unknown>;
}

export interface ModelTextRequest {
  messages: Array<Record<string, unknown>>;
  tools?: Array<Record<string, unknown>>;
  temperature?: number;
  maxOutputTokens?: number;
  responseFormat?: "json_object";
  extraBody?: Record<string, unknown>;
  signal?: AbortSignal;
}

export interface ModelVisionRequest extends ModelTextRequest {
  image: {
    mode: "base64_data_url" | "file_id";
    value: string;
    mimeType?: string;
  };
  text: string;
}

export interface NormalizedModelResponse {
  content: string;
  reasoningContent?: string;
  toolCalls: ToolCall[];
  finishReason?: string;
  usage?: TokenUsageSnapshot;
}

export interface ModelProbeResult {
  ok: boolean;
  probedAt: string;
  adapterId: string;
  protocol: string;
  capabilities: ModelCapabilityManifest;
  latencyMs: number;
  redactedError?: string;
}

export interface ModelAdapter {
  readonly id: string;
  readonly protocol: string;
  createTextClient(profile: ResolvedModelProfile, options: { maxRetries: number; timeoutMs: number; stream: boolean; temperature: number }): ModelClient;
  completeText(profile: ResolvedModelProfile, request: ModelTextRequest): Promise<NormalizedModelResponse>;
  completeVision(profile: ResolvedModelProfile, request: ModelVisionRequest): Promise<NormalizedModelResponse>;
  probe(profile: ResolvedModelProfile, signal?: AbortSignal): Promise<ModelProbeResult>;
}

export class ModelAdapterError extends Error {
  public readonly adapterId: string;
  public readonly profileId?: string;
  public readonly failureType: ModelFallbackTrigger | "adapter_not_found";
  public readonly retryable: boolean;

  public constructor(input: {
    adapterId: string;
    profileId?: string;
    failureType: ModelFallbackTrigger | "adapter_not_found";
    retryable: boolean;
    message: string;
  }) {
    super(input.message);
    this.name = "ModelAdapterError";
    this.adapterId = input.adapterId;
    this.profileId = input.profileId;
    this.failureType = input.failureType;
    this.retryable = input.retryable;
  }
}

export class ModelAdapterRegistry {
  readonly #adapters = new Map<string, ModelAdapter>();

  public register(adapter: ModelAdapter): void {
    if (!adapter.id.trim() || !adapter.protocol.trim()) {
      throw new Error("Model adapter id and protocol must be non-empty.");
    }
    if (this.#adapters.has(adapter.id)) {
      throw new Error(`Model adapter already registered: ${adapter.id}`);
    }
    this.#adapters.set(adapter.id, adapter);
  }

  public resolve(adapterId: string): ModelAdapter {
    const adapter = this.#adapters.get(adapterId);
    if (!adapter) {
      throw new ModelAdapterError({
        adapterId,
        failureType: "adapter_not_found",
        retryable: false,
        message: `adapter_not_found: ${adapterId}`,
      });
    }
    return adapter;
  }

  public list(): Array<{ id: string; protocol: string }> {
    return [...this.#adapters.values()].map((adapter) => ({ id: adapter.id, protocol: adapter.protocol }));
  }
}

export interface FallbackModelClientCandidate {
  profile: ResolvedModelProfile;
  client: ModelClient;
}

export interface FallbackSelectionEvent {
  profile: ResolvedModelProfile;
  fallbackIndex: number;
  attempts: Array<{ profileId: string; adapterId: string; outcome: "failed" | "selected"; reason?: string }>;
}

export class FallbackModelClient implements ModelClient {
  public lastSelection?: FallbackSelectionEvent;

  public constructor(
    private readonly candidates: FallbackModelClientCandidate[],
    private readonly allowedTriggers: ReadonlySet<ModelFallbackTrigger>,
    private readonly onSelected?: (event: FallbackSelectionEvent) => void,
  ) {
    if (candidates.length === 0) throw new Error("FallbackModelClient requires at least one candidate.");
  }

  public async streamCompletion(request: ModelCompletionRequest, callbacks?: StreamCallbacks): Promise<AssistantResponse> {
    this.lastSelection = undefined;
    let visibleStreamStarted = false;
    const attempts: FallbackSelectionEvent["attempts"] = [];
    const guardedCallbacks: StreamCallbacks = {
      onTextDelta: (chunk) => { visibleStreamStarted = true; callbacks?.onTextDelta?.(chunk); },
      onReasoningDelta: (chunk) => { visibleStreamStarted = true; callbacks?.onReasoningDelta?.(chunk); },
    };
    for (let index = 0; index < this.candidates.length; index += 1) {
      const candidate = this.candidates[index]!;
      try {
        const response = await candidate.client.streamCompletion(request, guardedCallbacks);
        const event: FallbackSelectionEvent = {
          profile: candidate.profile,
          fallbackIndex: index,
          attempts: [...attempts, { profileId: candidate.profile.profileId, adapterId: candidate.profile.adapterId, outcome: "selected" }],
        };
        this.lastSelection = event;
        this.onSelected?.(event);
        return response;
      } catch (error) {
        const adapterError = error instanceof ModelAdapterError ? error : undefined;
        attempts.push({
          profileId: candidate.profile.profileId,
          adapterId: candidate.profile.adapterId,
          outcome: "failed",
          reason: adapterError?.failureType ?? "non_replayable_error",
        });
        const mayFallback = Boolean(
          adapterError &&
          index + 1 < this.candidates.length &&
          !visibleStreamStarted &&
          !request.signal?.aborted &&
          this.allowedTriggers.has(adapterError.failureType as ModelFallbackTrigger),
        );
        if (!mayFallback) throw error;
      }
    }
    throw new Error("No model candidate completed the request.");
  }
}

function safeJsonParse(value: string): unknown {
  try {
    return JSON.parse(value);
  } catch {
    return { raw: value };
  }
}

function normalizeUsage(raw: unknown, model: string): TokenUsageSnapshot | undefined {
  if (!raw || typeof raw !== "object") return undefined;
  const value = raw as Record<string, unknown>;
  const number = (field: string): number | undefined => typeof value[field] === "number" && Number.isFinite(value[field])
    ? Math.max(0, Math.round(value[field] as number))
    : undefined;
  const inputTokens = number("prompt_tokens");
  const outputTokens = number("completion_tokens");
  const totalTokens = number("total_tokens");
  return {
    source: inputTokens !== undefined && outputTokens !== undefined && totalTokens !== undefined ? "provider_exact" : "provider_partial",
    model,
    recordedAt: new Date().toISOString(),
    inputTokens,
    outputTokens,
    totalTokens,
  };
}

export function redactProviderText(value: string, profile: ResolvedModelProfile): string {
  let result = value;
  const secrets = [profile.apiKey, ...Object.entries(profile.headers)
    .filter(([name]) => /authorization|api[-_]?key|token|secret/i.test(name))
    .map(([, headerValue]) => headerValue)]
    .filter((entry): entry is string => Boolean(entry));
  for (const secret of secrets) result = result.split(secret).join("[REDACTED]");
  return result
    .replace(/https?:\/\/[^\s"'<>`]+/giu, (candidate) => candidate.replace(/\?[^#\s"'<>`]*/u, "?[REDACTED_QUERY]").replace(/#[^\s"'<>`]*/u, "#[REDACTED_FRAGMENT]"))
    .replace(/([?&](?:api[_-]?key|token|secret|signature)=)[^&#\s]+/gi, "$1[REDACTED]")
    .replace(/(authorization|api[-_]?key|token|secret)\s*[:=]\s*[^,}\s]+/gi, "$1=[REDACTED]")
    .slice(0, 800);
}

const redact = redactProviderText;

function classifyStatus(status: number): { failureType: ModelFallbackTrigger; retryable: boolean } {
  if (status === 408 || status === 504) return { failureType: "timeout", retryable: true };
  if (status === 429) return { failureType: "rate_limit", retryable: true };
  if (status >= 500) return { failureType: "provider_error", retryable: true };
  return { failureType: "provider_error", retryable: false };
}

function endpoint(profile: ResolvedModelProfile): string {
  const base = profile.baseUrl.replace(/\/+$/, "");
  const endpointPath = profile.endpointPath.startsWith("/") ? profile.endpointPath : `/${profile.endpointPath}`;
  return `${base}${endpointPath}`;
}

function requestHeaders(profile: ResolvedModelProfile): Record<string, string> {
  return {
    "Content-Type": "application/json",
    ...(profile.apiKey ? { Authorization: `Bearer ${profile.apiKey}` } : {}),
    ...profile.headers,
  };
}

function normalizeContent(value: unknown): string {
  if (typeof value === "string") return value;
  if (!Array.isArray(value)) return "";
  return value.map((entry) => {
    if (!entry || typeof entry !== "object") return "";
    const record = entry as Record<string, unknown>;
    return typeof record.text === "string" ? record.text : "";
  }).join("");
}

function normalizeMessage(message: Record<string, unknown>, profile: ResolvedModelProfile, usage?: unknown): NormalizedModelResponse {
  const rawToolCalls = Array.isArray(message.tool_calls) ? message.tool_calls : [];
  const toolCalls: ToolCall[] = rawToolCalls.flatMap((entry, index) => {
    if (!entry || typeof entry !== "object") return [];
    const record = entry as Record<string, unknown>;
    const fn = record.function && typeof record.function === "object" ? record.function as Record<string, unknown> : {};
    if (typeof fn.name !== "string") return [];
    const rawArguments = typeof fn.arguments === "string" ? fn.arguments : JSON.stringify(fn.arguments ?? {});
    return [{
      id: typeof record.id === "string" && record.id ? record.id : `tool-${index}-${randomUUID()}`,
      name: fn.name,
      rawArguments,
      arguments: safeJsonParse(rawArguments),
    }];
  });
  const normalized = normalizeAssistantToolCalls(normalizeContent(message.content), toolCalls);
  return {
    content: normalized.content,
    reasoningContent: typeof message.reasoning_content === "string" ? message.reasoning_content : undefined,
    toolCalls: normalized.toolCalls,
    usage: normalizeUsage(usage, profile.model),
  };
}

function mergeRequestDefaults(profile: ResolvedModelProfile, body: Record<string, unknown>): Record<string, unknown> {
  const merged = { ...profile.requestDefaults, ...body };
  if (merged.stream !== true) {
    delete merged.stream_options;
  }
  return merged;
}

async function fetchJson(profile: ResolvedModelProfile, body: Record<string, unknown>, signal?: AbortSignal): Promise<NormalizedModelResponse> {
  if (!profile.apiKey) {
    throw new ModelAdapterError({
      adapterId: profile.adapterId,
      profileId: profile.profileId,
      failureType: "configuration",
      retryable: false,
      message: `Missing credential for profile ${profile.profileId}.`,
    });
  }
  let response: Response;
  try {
    response = await fetch(endpoint(profile), {
      method: "POST",
      headers: requestHeaders(profile),
      body: JSON.stringify(mergeRequestDefaults(profile, body)),
      signal,
    });
  } catch (error) {
    throw new ModelAdapterError({
      adapterId: profile.adapterId,
      profileId: profile.profileId,
      failureType: (error as Error).name === "AbortError" || (error as Error).name === "TimeoutError" ? "timeout" : "connection",
      retryable: true,
      message: redact((error as Error).message, profile),
    });
  }
  if (!response.ok) {
    const classification = classifyStatus(response.status);
    throw new ModelAdapterError({
      adapterId: profile.adapterId,
      profileId: profile.profileId,
      ...classification,
      message: `Provider request failed (${response.status}): ${redact(await response.text(), profile)}`,
    });
  }
  let payload: Record<string, unknown>;
  try {
    payload = await response.json() as Record<string, unknown>;
  } catch (error) {
    throw new ModelAdapterError({
      adapterId: profile.adapterId,
      profileId: profile.profileId,
      failureType: "invalid_response",
      retryable: true,
      message: `Invalid JSON response: ${redact((error as Error).message, profile)}`,
    });
  }
  const choices = Array.isArray(payload.choices) ? payload.choices : [];
  const first = choices[0] && typeof choices[0] === "object" ? choices[0] as Record<string, unknown> : undefined;
  const message = first?.message && typeof first.message === "object" ? first.message as Record<string, unknown> : undefined;
  if (!message) {
    throw new ModelAdapterError({
      adapterId: profile.adapterId,
      profileId: profile.profileId,
      failureType: "invalid_response",
      retryable: true,
      message: "Provider response did not contain an assistant message.",
    });
  }
  return {
    ...normalizeMessage(message, profile, payload.usage),
    finishReason: typeof first?.finish_reason === "string" ? first.finish_reason : undefined,
  };
}

interface Deadline {
  signal: AbortSignal;
  touch(): void;
  dispose(): void;
}

function createDeadline(timeoutMs: number, external?: AbortSignal): Deadline {
  const controller = new AbortController();
  let timer: ReturnType<typeof setTimeout> | undefined;
  const touch = () => {
    if (timer) clearTimeout(timer);
    timer = setTimeout(() => controller.abort(new DOMException(`Model request received no data for ${timeoutMs} ms.`, "TimeoutError")), timeoutMs);
  };
  touch();
  return {
    signal: external ? AbortSignal.any([controller.signal, external]) : controller.signal,
    touch,
    dispose: () => { if (timer) clearTimeout(timer); },
  };
}

class OpenAICompatibleTextClient implements ModelClient {
  public constructor(
    private readonly adapter: OpenAICompatibleAdapter,
    private readonly profile: ResolvedModelProfile,
    private readonly options: { maxRetries: number; timeoutMs: number; stream: boolean; temperature: number },
  ) {}

  public async streamCompletion(request: ModelCompletionRequest, callbacks?: StreamCallbacks): Promise<AssistantResponse> {
    const body: Record<string, unknown> = {
      model: this.profile.model,
      messages: [{ role: "system", content: request.systemPrompt }, ...request.messages],
      tools: request.tools,
      stream: request.stream && this.options.stream,
      temperature: request.temperature ?? this.options.temperature,
      ...(request.maxOutputTokens ? { max_tokens: request.maxOutputTokens } : {}),
      ...(request.stream && this.options.stream ? { stream_options: { include_usage: true } } : {}),
      ...(request.route.thinkingMode.mode !== "disabled" ? { thinking: { type: "enabled" } } : {}),
      ...(request.route.thinkingMode.reasoningEffort !== "not_applicable" ? { reasoning_effort: request.route.thinkingMode.reasoningEffort } : {}),
    };
    if (!body.stream) {
      const response = await this.adapter.completeText(this.profile, {
        messages: body.messages as Array<Record<string, unknown>>,
        tools: request.tools as unknown as Array<Record<string, unknown>>,
        temperature: body.temperature as number,
        maxOutputTokens: request.maxOutputTokens,
        extraBody: {
          ...(request.route.thinkingMode.mode !== "disabled" ? { thinking: { type: "enabled" } } : {}),
          ...(request.route.thinkingMode.reasoningEffort !== "not_applicable" ? { reasoning_effort: request.route.thinkingMode.reasoningEffort } : {}),
        },
        signal: request.signal,
      });
      return response;
    }
    let lastError: unknown;
    for (let attempt = 0; attempt <= this.options.maxRetries; attempt += 1) {
      let emitted = false;
      const deadline = createDeadline(request.inactivityTimeoutMs ?? this.options.timeoutMs, request.signal);
      try {
        if (!this.profile.apiKey) throw new ModelAdapterError({ adapterId: this.profile.adapterId, profileId: this.profile.profileId, failureType: "configuration", retryable: false, message: `Missing credential for profile ${this.profile.profileId}.` });
        const response = await fetch(endpoint(this.profile), {
          method: "POST",
          headers: requestHeaders(this.profile),
          body: JSON.stringify(mergeRequestDefaults(this.profile, body)),
          signal: deadline.signal,
        });
        deadline.touch();
        if (!response.ok) {
          const classification = classifyStatus(response.status);
          throw new ModelAdapterError({ adapterId: this.profile.adapterId, profileId: this.profile.profileId, ...classification, message: `Provider request failed (${response.status}): ${redact(await response.text(), this.profile)}` });
        }
        if (!response.body) throw new ModelAdapterError({ adapterId: this.profile.adapterId, profileId: this.profile.profileId, failureType: "invalid_response", retryable: true, message: "Provider response body was empty." });
        const reader = response.body.getReader();
        const decoder = new TextDecoder();
        let buffer = "";
        let content = "";
        let reasoning = "";
        let finishReason: string | undefined;
        let rawUsage: unknown;
        const calls = new Map<number, { id: string; name: string; rawArguments: string }>();
        const visibleText = new DsmlTextStreamFilter();
        while (true) {
          const { value, done } = await reader.read();
          if (done) break;
          deadline.touch();
          buffer += decoder.decode(value, { stream: true });
          const events = buffer.split("\n\n");
          buffer = events.pop() ?? "";
          for (const event of events) {
            for (const line of event.split("\n").map((entry) => entry.trim()).filter((entry) => entry.startsWith("data:"))) {
              const data = line.slice(5).trim();
              if (!data || data === "[DONE]") continue;
              const payload = JSON.parse(data) as Record<string, unknown>;
              if (payload.usage) rawUsage = payload.usage;
              const choices = Array.isArray(payload.choices) ? payload.choices : [];
              const choice = choices[0] && typeof choices[0] === "object" ? choices[0] as Record<string, unknown> : undefined;
              if (!choice) continue;
              if (typeof choice.finish_reason === "string") finishReason = choice.finish_reason;
              const delta = choice.delta && typeof choice.delta === "object" ? choice.delta as Record<string, unknown> : {};
              if (typeof delta.content === "string" && delta.content) {
                emitted = true;
                content += delta.content;
                const visibleChunk = visibleText.push(delta.content);
                if (visibleChunk) callbacks?.onTextDelta?.(visibleChunk);
              }
              if (typeof delta.reasoning_content === "string" && delta.reasoning_content) { emitted = true; reasoning += delta.reasoning_content; callbacks?.onReasoningDelta?.(delta.reasoning_content); }
              const rawCalls = Array.isArray(delta.tool_calls) ? delta.tool_calls : [];
              for (const rawCall of rawCalls) {
                if (!rawCall || typeof rawCall !== "object") continue;
                emitted = true;
                const record = rawCall as Record<string, unknown>;
                const index = typeof record.index === "number" ? record.index : 0;
                const fn = record.function && typeof record.function === "object" ? record.function as Record<string, unknown> : {};
                const current = calls.get(index) ?? { id: `tool-${index}-${randomUUID()}`, name: "", rawArguments: "" };
                if (typeof record.id === "string") current.id = record.id;
                if (typeof fn.name === "string") current.name = fn.name;
                if (typeof fn.arguments === "string") current.rawArguments += fn.arguments;
                calls.set(index, current);
              }
            }
          }
        }
        const trailingVisibleText = visibleText.finish();
        if (trailingVisibleText) callbacks?.onTextDelta?.(trailingVisibleText);
        const normalized = normalizeAssistantToolCalls(
          content,
          [...calls.values()].map((call) => ({ ...call, arguments: safeJsonParse(call.rawArguments) })),
        );
        return {
          content: normalized.content,
          reasoningContent: reasoning || undefined,
          finishReason,
          toolCalls: normalized.toolCalls,
          usage: normalizeUsage(rawUsage, this.profile.model),
        };
      } catch (error) {
        lastError = error;
        if (attempt >= this.options.maxRetries || emitted || request.signal?.aborted) throw error;
      } finally {
        deadline.dispose();
      }
    }
    throw lastError;
  }
}

export class OpenAICompatibleAdapter implements ModelAdapter {
  public constructor(public readonly id = "openai_compatible", public readonly protocol = "openai_chat_completions") {}

  public createTextClient(profile: ResolvedModelProfile, options: { maxRetries: number; timeoutMs: number; stream: boolean; temperature: number }): ModelClient {
    return new OpenAICompatibleTextClient(this, profile, options);
  }

  public completeText(profile: ResolvedModelProfile, request: ModelTextRequest): Promise<NormalizedModelResponse> {
    return fetchJson(profile, {
      model: profile.model,
      messages: request.messages,
      ...(request.tools ? { tools: request.tools } : {}),
      stream: false,
      ...(request.temperature !== undefined ? { temperature: request.temperature } : {}),
      ...(request.maxOutputTokens ? { max_tokens: request.maxOutputTokens } : {}),
      ...(request.responseFormat ? { response_format: { type: request.responseFormat } } : {}),
      ...(request.extraBody ?? {}),
    }, request.signal);
  }

  public completeVision(profile: ResolvedModelProfile, request: ModelVisionRequest): Promise<NormalizedModelResponse> {
    if (!profile.capabilities.imageInput) {
      throw new ModelAdapterError({ adapterId: profile.adapterId, profileId: profile.profileId, failureType: "capability", retryable: false, message: `Profile ${profile.profileId} does not declare image input.` });
    }
    const imageContent = request.image.mode === "base64_data_url"
      ? { type: "image_url", image_url: { url: request.image.value } }
      : { type: "input_image", file_id: request.image.value };
    return fetchJson(profile, {
      model: profile.model,
      messages: [...request.messages, { role: "user", content: [imageContent, { type: "text", text: request.text }] }],
      stream: false,
      ...(request.responseFormat ? { response_format: { type: request.responseFormat } } : {}),
      ...(request.extraBody ?? {}),
    }, request.signal);
  }

  public async probe(profile: ResolvedModelProfile, signal?: AbortSignal): Promise<ModelProbeResult> {
    const started = Date.now();
    try {
      await this.completeText(profile, {
        messages: [
          { role: "system", content: "Deep-Mix synthetic connectivity probe. Do not request tools." },
          { role: "user", content: "Return exactly: OK" },
        ],
        maxOutputTokens: 8,
        signal,
      });
      return { ok: true, probedAt: new Date().toISOString(), adapterId: this.id, protocol: this.protocol, capabilities: profile.capabilities, latencyMs: Date.now() - started };
    } catch (error) {
      return { ok: false, probedAt: new Date().toISOString(), adapterId: this.id, protocol: this.protocol, capabilities: profile.capabilities, latencyMs: Date.now() - started, redactedError: error instanceof ModelAdapterError ? error.message : redact((error as Error).message, profile) };
    }
  }
}

export function createDefaultModelAdapterRegistry(): ModelAdapterRegistry {
  const registry = new ModelAdapterRegistry();
  registry.register(new OpenAICompatibleAdapter());
  registry.register(new OpenAICompatibleAdapter("deepseek_compat"));
  registry.register(new OpenAICompatibleAdapter("glm_compat"));
  registry.register(new OpenAICompatibleAdapter("kimi_compat"));
  return registry;
}

export * from "./tool-call-normalization.js";
export * from "./profile-service.js";
