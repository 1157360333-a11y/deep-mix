import { afterEach, describe, expect, it, vi } from "vitest";
import { createGovernorRouteProfile } from "../packages/route-resolver/src/index.js";
import { DeepSeekClient } from "../packages/core-governor/src/deepseek-client.js";
import type { DeepSeekProviderConfig, ModelCompletionRequest } from "../packages/shared-schema/src/index.js";

function createConfig(overrides: Partial<DeepSeekProviderConfig> = {}): DeepSeekProviderConfig {
  return {
    apiKey: "fake-local-key",
    baseUrl: "https://example.invalid",
    endpointPath: "/chat/completions",
    model: "deepseek-chat",
    role: "governor",
    stream: true,
    contextWindow: 128000,
    maxRetries: 1,
    timeoutMs: 5000,
    contextSoftLimitTokens: 96000,
    contextCompactThresholdTokens: 84000,
    contextReserveOutputTokens: 8000,
    contextSummaryMaxTokens: 2048,
    contextRecentTailMaxTokens: 24000,
    maxHistoryMessages: 12,
    historyCharBudget: 16000,
    temperature: 0.2,
    thinking: {
      type: "disabled",
      reasoningEffort: "not_applicable",
    },
    ...overrides,
  };
}

function createRequest(config: DeepSeekProviderConfig): ModelCompletionRequest {
  return {
    route: createGovernorRouteProfile(config),
    systemPrompt: "You are Deep-Mix.",
    messages: [
      {
        role: "user",
        content: "Say hello.",
      },
    ],
    tools: [],
    stream: true,
    temperature: config.temperature,
  };
}

function createStreamingResponse(events: string[], error?: Error, delaysMs: number[] = []): Response {
  const encoder = new TextEncoder();
  const chunks = [
    ...events.map((event) => encoder.encode(`data: ${event}\n\n`)),
    ...(error ? [] : [encoder.encode("data: [DONE]\n\n")]),
  ];
  let index = 0;
  let threw = false;

  return {
    ok: true,
    status: 200,
    async text() {
      return "";
    },
    body: {
      getReader() {
        return {
          async read() {
            const delayMs = delaysMs[index] ?? 0;
            if (delayMs > 0) await new Promise((resolve) => setTimeout(resolve, delayMs));
            if (index < chunks.length) {
              const value = chunks[index];
              index += 1;
              return { value, done: false };
            }
            if (error && !threw) {
              threw = true;
              throw error;
            }
            return { value: undefined, done: true };
          },
        };
      },
    },
  } as unknown as Response;
}

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe("DeepSeekClient retry behavior", () => {
  it("treats timeoutMs as stream inactivity instead of an absolute response deadline", async () => {
    const config = createConfig({ maxRetries: 0, timeoutMs: 40 });
    let requestSignal: AbortSignal | undefined;
    const fetchMock = vi.fn().mockImplementation((_url: string, init?: RequestInit) => {
      requestSignal = init?.signal as AbortSignal | undefined;
      return Promise.resolve(createStreamingResponse([
        JSON.stringify({ choices: [{ delta: { content: "A" } }] }),
        JSON.stringify({ choices: [{ delta: { content: "B" } }] }),
        JSON.stringify({ choices: [{ delta: { content: "C" } }] }),
      ], undefined, [25, 25, 25, 0]));
    });
    vi.stubGlobal("fetch", fetchMock);
    const client = new DeepSeekClient(config);

    const response = await client.streamCompletion(createRequest(config));

    expect(response.content).toBe("ABC");
    expect(requestSignal?.aborted).toBe(false);
  }, 2_000);

  it("still aborts when the Provider sends no data for the configured interval", async () => {
    const config = createConfig({ maxRetries: 0, timeoutMs: 25 });
    const fetchMock = vi.fn().mockImplementation((_url: string, init?: RequestInit) => new Promise<Response>(
      (_resolve, reject) => {
        const signal = init?.signal as AbortSignal;
        const rejectFromAbort = () => reject(signal.reason);
        if (signal.aborted) rejectFromAbort();
        else signal.addEventListener("abort", rejectFromAbort, { once: true });
      },
    ));
    vi.stubGlobal("fetch", fetchMock);
    const client = new DeepSeekClient(config);

    await expect(client.streamCompletion(createRequest(config))).rejects.toMatchObject({
      name: "TimeoutError",
      message: "DeepSeek request received no data for 25 ms.",
    });
  }, 2_000);

  it("does not retry after streaming content has already reached the UI", async () => {
    const config = createConfig({
      maxRetries: 2,
    });
    const fetchMock = vi.fn().mockResolvedValue(
      createStreamingResponse(
        [
          JSON.stringify({
            choices: [
              {
                delta: {
                  content: "我现在开始创建。",
                },
              },
            ],
          }),
        ],
        new Error("stream failed"),
      ),
    );
    vi.stubGlobal("fetch", fetchMock);
    const client = new DeepSeekClient(config);
    const streamedChunks: string[] = [];

    await expect(
      client.streamCompletion(createRequest(config), {
        onTextDelta: (chunk) => {
          streamedChunks.push(chunk);
        },
      }),
    ).rejects.toThrow("stream failed");

    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(streamedChunks.join("")).toBe("我现在开始创建。");
  });

  it("still retries when the request fails before any streamed output arrives", async () => {
    const config = createConfig({
      maxRetries: 1,
    });
    const fetchMock = vi.fn()
      .mockRejectedValueOnce(new Error("temporary upstream reset"))
      .mockResolvedValueOnce(
        createStreamingResponse([
          JSON.stringify({
            choices: [
              {
                delta: {
                  content: "Recovered response.",
                },
              },
            ],
          }),
        ]),
      );
    vi.stubGlobal("fetch", fetchMock);
    const client = new DeepSeekClient(config);
    const streamedChunks: string[] = [];

    const response = await client.streamCompletion(createRequest(config), {
      onTextDelta: (chunk) => {
        streamedChunks.push(chunk);
      },
    });

    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(streamedChunks.join("")).toBe("Recovered response.");
    expect(response.content).toBe("Recovered response.");
  });
});
