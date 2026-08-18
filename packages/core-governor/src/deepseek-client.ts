import { resolveDeepSeekRequestConfig } from "../../route-resolver/src/index.js";
import { DsmlTextStreamFilter, normalizeAssistantToolCalls } from "../../model-adapters/src/tool-call-normalization.js";
import type {
  AssistantResponse,
  ConversationMessage,
  DeepSeekProviderConfig,
  ModelClient,
  ModelCompletionRequest,
  StreamCallbacks,
  ToolCall,
} from "../../shared-schema/src/index.js";
import { normalizeProviderUsage } from "./context-usage.js";

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function now(): string {
  return new Date().toISOString();
}

function safeJsonParse(raw: string): unknown {
  try {
    return JSON.parse(raw);
  } catch {
    return { raw };
  }
}

interface RequestDeadline {
  signal: AbortSignal;
  touch(): void;
  dispose(): void;
}

function createRequestDeadline(timeoutMs: number, externalSignal?: AbortSignal): RequestDeadline {
  const controller = new AbortController();
  let timer: ReturnType<typeof setTimeout> | undefined;
  const touch = () => {
    if (timer) clearTimeout(timer);
    timer = setTimeout(() => {
      controller.abort(new DOMException(
        `DeepSeek request received no data for ${timeoutMs} ms.`,
        "TimeoutError",
      ));
    }, timeoutMs);
  };
  touch();
  return {
    signal: externalSignal ? AbortSignal.any([controller.signal, externalSignal]) : controller.signal,
    touch,
    dispose: () => {
      if (timer) clearTimeout(timer);
      timer = undefined;
    },
  };
}

interface ToolCallAccumulator {
  id: string;
  name: string;
  rawArguments: string;
}

export function normalizeDeepSeekAssistantToolCalls(content: string, existingToolCalls: ToolCall[]): {
  content: string;
  toolCalls: ToolCall[];
} {
  return normalizeAssistantToolCalls(content, existingToolCalls);
}

function toAssistantResponse(message: {
  content?: string | null;
  reasoning_content?: string | null;
  tool_calls?: Array<{
    id: string;
    function: {
      name: string;
      arguments: string;
    };
  }>;
}, input: {
  model?: string;
  usage?: unknown;
}): AssistantResponse {
  const toolCalls: ToolCall[] = (message.tool_calls ?? []).map((toolCall) => ({
    id: toolCall.id,
    name: toolCall.function.name,
    rawArguments: toolCall.function.arguments,
    arguments: safeJsonParse(toolCall.function.arguments),
  }));
  const usage = normalizeProviderUsage(input.usage, {
    model: input.model,
    recordedAt: now(),
  });

  const normalized = normalizeDeepSeekAssistantToolCalls(message.content ?? "", toolCalls);
  return {
    content: normalized.content,
    reasoningContent: message.reasoning_content ?? undefined,
    toolCalls: normalized.toolCalls,
    usage,
    providerUsage: input.usage && typeof input.usage === "object" ? (input.usage as Record<string, unknown>) : undefined,
  };
}

export class DeepSeekClient implements ModelClient {
  private readonly config: DeepSeekProviderConfig;

  public constructor(config: DeepSeekProviderConfig) {
    this.config = config;
  }

  public async streamCompletion(
    request: ModelCompletionRequest,
    callbacks?: StreamCallbacks,
  ): Promise<AssistantResponse> {
    if (!this.config.apiKey) {
      throw new Error("Missing API key for deepseek_governor profile in the local API key library.");
    }

    const requestConfig = resolveDeepSeekRequestConfig(request.route, this.config);
    const body = {
      model: requestConfig.model,
      messages: [
        {
          role: "system",
          content: request.systemPrompt,
        },
        ...request.messages,
      ],
      tools: request.tools,
      stream: request.stream && requestConfig.stream,
      ...(request.stream && requestConfig.stream ? { stream_options: { include_usage: true } } : {}),
      temperature: requestConfig.temperature,
      ...(request.maxOutputTokens ? { max_tokens: request.maxOutputTokens } : {}),
      ...(requestConfig.reasoningEffort ? { reasoning_effort: requestConfig.reasoningEffort } : {}),
      ...(requestConfig.extraBody ? { extra_body: requestConfig.extraBody } : {}),
    };

    for (let attempt = 0; attempt <= this.config.maxRetries; attempt += 1) {
      let emittedStreamData = false;
      const deadline = createRequestDeadline(
        request.inactivityTimeoutMs ?? this.config.timeoutMs,
        request.signal,
      );
      try {
        const response = await fetch(`${this.config.baseUrl}${this.config.endpointPath}`, {
          method: "POST",
          headers: {
            Authorization: `Bearer ${this.config.apiKey}`,
            "Content-Type": "application/json",
          },
          body: JSON.stringify(body),
          signal: deadline.signal,
        });
        deadline.touch();

        if (!response.ok) {
          throw new Error(`DeepSeek request failed with ${response.status}: ${await response.text()}`);
        }

        if (!body.stream) {
          const payload = (await response.json()) as {
            choices: Array<{ message: ConversationMessage }>;
            usage?: unknown;
          };
          return toAssistantResponse(payload.choices[0]!.message as ConversationMessage & {
            reasoning_content?: string | null;
            tool_calls?: Array<{
              id: string;
              function: {
                name: string;
                arguments: string;
              };
            }>;
          }, {
            model: requestConfig.model,
            usage: payload.usage,
          });
        }

        if (!response.body) {
          throw new Error("DeepSeek response body was empty.");
        }

        const reader = response.body.getReader();
        const decoder = new TextDecoder();
        let buffer = "";
        let content = "";
        let reasoningContent = "";
        let finishReason: string | undefined;
        let rawUsage: unknown;
        const toolCalls = new Map<number, ToolCallAccumulator>();
        const visibleText = new DsmlTextStreamFilter();

        while (true) {
          const { value, done } = await reader.read();
          if (done) {
            break;
          }
          deadline.touch();

          buffer += decoder.decode(value, { stream: true });
          const events = buffer.split("\n\n");
          buffer = events.pop() ?? "";

          for (const event of events) {
            const lines = event
              .split("\n")
              .map((line) => line.trim())
              .filter((line) => line.startsWith("data:"))
              .map((line) => line.slice(5).trim());

            for (const line of lines) {
              if (line === "[DONE]") {
                continue;
              }

              const payload = JSON.parse(line) as {
                choices?: Array<{
                  delta?: {
                    content?: string;
                    reasoning_content?: string;
                    tool_calls?: Array<{
                      index?: number;
                      id?: string;
                      function?: {
                        name?: string;
                        arguments?: string;
                      };
                    }>;
                  };
                  finish_reason?: string | null;
                }>;
                usage?: unknown;
              };
              if (payload.usage && typeof payload.usage === "object") {
                rawUsage = payload.usage;
              }

              const choice = payload.choices?.[0];
              if (!choice) {
                continue;
              }

              finishReason = choice.finish_reason ?? finishReason;
              const delta = choice.delta;
              if (!delta) {
                continue;
              }

              if (delta.content) {
                content += delta.content;
                emittedStreamData = true;
                const visibleChunk = visibleText.push(delta.content);
                if (visibleChunk) callbacks?.onTextDelta?.(visibleChunk);
              }

              if (delta.reasoning_content) {
                reasoningContent += delta.reasoning_content;
                emittedStreamData = true;
                callbacks?.onReasoningDelta?.(delta.reasoning_content);
              }

              for (const toolCall of delta.tool_calls ?? []) {
                emittedStreamData = true;
                const index = toolCall.index ?? 0;
                const accumulator = toolCalls.get(index) ?? {
                  id: toolCall.id ?? `tool-${index}`,
                  name: "",
                  rawArguments: "",
                };

                accumulator.id = toolCall.id ?? accumulator.id;
                if (toolCall.function?.name) {
                  accumulator.name = toolCall.function.name;
                }
                if (toolCall.function?.arguments) {
                  accumulator.rawArguments += toolCall.function.arguments;
                }
                toolCalls.set(index, accumulator);
              }
            }
          }
        }

        const trailingVisibleText = visibleText.finish();
        if (trailingVisibleText) callbacks?.onTextDelta?.(trailingVisibleText);
        const usage = normalizeProviderUsage(rawUsage, {
          model: requestConfig.model,
          recordedAt: now(),
        });
        const normalized = normalizeDeepSeekAssistantToolCalls(content, [...toolCalls.values()].map((toolCall) => ({
          id: toolCall.id,
          name: toolCall.name,
          rawArguments: toolCall.rawArguments,
          arguments: safeJsonParse(toolCall.rawArguments),
        })));
        return {
          content: normalized.content,
          reasoningContent: reasoningContent || undefined,
          finishReason,
          toolCalls: normalized.toolCalls,
          usage,
          providerUsage: rawUsage && typeof rawUsage === "object" ? (rawUsage as Record<string, unknown>) : undefined,
        };
      } catch (error) {
        const shouldRetry = attempt < this.config.maxRetries && !request.signal?.aborted && !emittedStreamData;
        if (!shouldRetry) {
          throw error;
        }
        await sleep(500 * (attempt + 1));
      } finally {
        deadline.dispose();
      }
    }

    throw new Error("DeepSeek request retries exhausted.");
  }
}
