import type {
  AssistantResponse,
  ContextSummaryRecord,
  ConversationMessage,
  MessageRecord,
  ProviderToolDefinition,
  TokenUsageSnapshot,
  ToolDefinition,
  UsageValueSource,
} from "../../shared-schema/src/index.js";

function clampNonNegative(value: number | undefined): number | undefined {
  if (value === undefined || !Number.isFinite(value)) {
    return undefined;
  }
  return Math.max(0, Math.round(value));
}

function isCjkCodePoint(codePoint: number): boolean {
  return (
    (codePoint >= 0x3400 && codePoint <= 0x4dbf) ||
    (codePoint >= 0x4e00 && codePoint <= 0x9fff) ||
    (codePoint >= 0xf900 && codePoint <= 0xfaff) ||
    (codePoint >= 0x20000 && codePoint <= 0x2a6df) ||
    (codePoint >= 0x2a700 && codePoint <= 0x2ebef) ||
    (codePoint >= 0x3000 && codePoint <= 0x303f)
  );
}

function flushAsciiRun(length: number): number {
  if (length <= 0) {
    return 0;
  }
  return Math.ceil(length / 3);
}

export function estimateTextTokens(text: string): number {
  let total = 0;
  let asciiRun = 0;
  let whitespaceRun = 0;

  for (const character of text) {
    const codePoint = character.codePointAt(0) ?? 0;
    if (/[A-Za-z0-9_]/u.test(character)) {
      asciiRun += 1;
      continue;
    }

    total += flushAsciiRun(asciiRun);
    asciiRun = 0;

    if (/\s/u.test(character)) {
      whitespaceRun += 1;
      if (whitespaceRun >= 4) {
        total += 1;
        whitespaceRun = 0;
      }
      continue;
    }

    whitespaceRun = 0;
    total += isCjkCodePoint(codePoint) ? 1 : 1;
  }

  total += flushAsciiRun(asciiRun);
  total += Math.ceil(whitespaceRun / 4);
  return Math.max(1, total);
}

function estimateJsonTokens(value: unknown): number {
  return estimateTextTokens(JSON.stringify(value));
}

export function estimateProviderToolTokens(tools: ProviderToolDefinition[]): number {
  if (tools.length === 0) {
    return 0;
  }
  return estimateJsonTokens(tools) + tools.length * 6;
}

export function estimateToolDefinitionTokens(tools: ToolDefinition[]): number {
  if (tools.length === 0) {
    return 0;
  }
  return estimateJsonTokens(tools) + tools.length * 6;
}

export function estimateConversationMessageTokens(message: ConversationMessage): number {
  return (
    8 +
    estimateTextTokens(message.content ?? "") +
    estimateTextTokens(message.name ?? "") +
    estimateTextTokens(message.tool_call_id ?? "") +
    estimateTextTokens(message.reasoning_content ?? "") +
    estimateJsonTokens(message.tool_calls ?? [])
  );
}

export function estimateMessageRecordTokens(message: MessageRecord): number {
  const toolCallTokens =
    message.role === "assistant" && Array.isArray(message.toolCalls)
      ? estimateJsonTokens(message.toolCalls)
      : 0;
  return (
    8 +
    estimateTextTokens(message.content) +
    estimateTextTokens(message.name ?? "") +
    estimateTextTokens(message.toolCallId ?? "") +
    estimateTextTokens(message.reasoningContent ?? "") +
    toolCallTokens
  );
}

export function estimateMessageRecordBatchTokens(messages: MessageRecord[]): number {
  return messages.reduce((total, message) => total + estimateMessageRecordTokens(message), 0);
}

export function estimateConversationBatchTokens(messages: ConversationMessage[]): number {
  return messages.reduce((total, message) => total + estimateConversationMessageTokens(message), 0);
}

export function estimateContextSummaryTokens(summaries: ContextSummaryRecord[]): number {
  return summaries.reduce((total, summary) => total + estimateTextTokens(summary.summary) + 8, 0);
}

export function estimateAssistantOutputTokens(response: Pick<AssistantResponse, "content" | "reasoningContent" | "toolCalls">): number {
  return (
    estimateTextTokens(response.content) +
    estimateTextTokens(response.reasoningContent ?? "") +
    estimateJsonTokens(response.toolCalls ?? [])
  );
}

function numericField(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}

function detectUsageSource(input: {
  inputTokens?: number;
  outputTokens?: number;
  totalTokens?: number;
  hasAnyField: boolean;
}): UsageValueSource {
  if (!input.hasAnyField) {
    return "unavailable";
  }
  if (
    input.inputTokens !== undefined &&
    input.outputTokens !== undefined &&
    input.totalTokens !== undefined
  ) {
    return "provider_exact";
  }
  return "provider_partial";
}

export function normalizeProviderUsage(
  rawUsage: unknown,
  input: {
    model?: string;
    recordedAt: string;
  },
): TokenUsageSnapshot | undefined {
  if (!rawUsage || typeof rawUsage !== "object") {
    return undefined;
  }

  const usage = rawUsage as {
    prompt_tokens?: number;
    completion_tokens?: number;
    total_tokens?: number;
    prompt_cache_hit_tokens?: number;
    prompt_cache_miss_tokens?: number;
    completion_tokens_details?: {
      reasoning_tokens?: number;
    };
  };

  const inputTokens = numericField(usage.prompt_tokens);
  const outputTokens = numericField(usage.completion_tokens);
  const totalTokens = numericField(usage.total_tokens);
  const cachedInputTokens = numericField(usage.prompt_cache_hit_tokens);
  const uncachedInputTokens = numericField(usage.prompt_cache_miss_tokens);
  const reasoningTokens = numericField(usage.completion_tokens_details?.reasoning_tokens);
  const hasAnyField =
    inputTokens !== undefined ||
    outputTokens !== undefined ||
    totalTokens !== undefined ||
    cachedInputTokens !== undefined ||
    uncachedInputTokens !== undefined ||
    reasoningTokens !== undefined;

  if (!hasAnyField) {
    return undefined;
  }

  return {
    source: detectUsageSource({
      inputTokens,
      outputTokens,
      totalTokens,
      hasAnyField,
    }),
    model: input.model,
    recordedAt: input.recordedAt,
    inputTokens,
    outputTokens,
    reasoningTokens,
    cachedInputTokens,
    uncachedInputTokens,
    totalTokens,
  };
}

export function createEstimatedUsageSnapshot(input: {
  model?: string;
  recordedAt: string;
  inputTokens?: number;
  outputTokens?: number;
  reasoningTokens?: number;
}): TokenUsageSnapshot {
  const inputTokens = clampNonNegative(input.inputTokens);
  const outputTokens = clampNonNegative(input.outputTokens);
  const reasoningTokens = clampNonNegative(input.reasoningTokens);
  const totalTokens =
    inputTokens !== undefined || outputTokens !== undefined
      ? (inputTokens ?? 0) + (outputTokens ?? 0)
      : undefined;

  return {
    source: "local_estimated",
    model: input.model,
    recordedAt: input.recordedAt,
    inputTokens,
    outputTokens,
    reasoningTokens,
    totalTokens,
  };
}

function mergeSources(left: UsageValueSource | undefined, right: UsageValueSource): UsageValueSource {
  if (!left) {
    return right;
  }
  if (left === right) {
    return left;
  }
  if (left === "unavailable") {
    return right;
  }
  if (right === "unavailable") {
    return left;
  }
  if (left === "local_estimated" && right === "local_estimated") {
    return "local_estimated";
  }
  return "provider_partial";
}

export function accumulateUsageSnapshots(
  current: TokenUsageSnapshot | undefined,
  next: TokenUsageSnapshot,
): TokenUsageSnapshot {
  const source = mergeSources(current?.source, next.source);
  return {
    source,
    model: next.model ?? current?.model,
    recordedAt: next.recordedAt,
    inputTokens: clampNonNegative((current?.inputTokens ?? 0) + (next.inputTokens ?? 0)),
    outputTokens: clampNonNegative((current?.outputTokens ?? 0) + (next.outputTokens ?? 0)),
    reasoningTokens: clampNonNegative((current?.reasoningTokens ?? 0) + (next.reasoningTokens ?? 0)),
    cachedInputTokens: clampNonNegative((current?.cachedInputTokens ?? 0) + (next.cachedInputTokens ?? 0)),
    uncachedInputTokens: clampNonNegative((current?.uncachedInputTokens ?? 0) + (next.uncachedInputTokens ?? 0)),
    totalTokens: clampNonNegative((current?.totalTokens ?? 0) + (next.totalTokens ?? 0)),
  };
}
