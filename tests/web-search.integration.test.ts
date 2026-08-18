import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { afterEach, describe, expect, it, vi } from "vitest";

import { SessionStore } from "../packages/persistence/src/index.js";
import { ToolRuntime } from "../packages/tool-runtime/src/index.js";
import type {
  ToolNetworkResponse,
  ToolNetworkRoute,
  ToolNetworkService,
} from "../packages/tool-runtime/src/network/index.js";

const temporaryRoots: string[] = [];

async function createRuntime(input?: {
  environment?: NodeJS.ProcessEnv;
  networkDisabled?: boolean;
  networkService?: ToolNetworkService;
  settings?: Record<string, unknown>;
}): Promise<{ runtime: ToolRuntime; sessionId: string; workspaceRoot: string }> {
  const workspaceRoot = await fs.mkdtemp(path.join(os.tmpdir(), "deep-mix-web-search-"));
  temporaryRoots.push(workspaceRoot);
  const sessionStore = new SessionStore(workspaceRoot);
  await sessionStore.ensureInitialized();
  if (input?.settings) {
    const projectSettingsPath = path.join(workspaceRoot, ".deep-mix", "settings.json");
    await fs.mkdir(path.dirname(projectSettingsPath), { recursive: true });
    await fs.writeFile(
      projectSettingsPath,
      JSON.stringify(input.settings),
      "utf8",
    );
  }
  if (input?.networkDisabled) {
    await fs.writeFile(
      path.join(sessionStore.paths.stateDir, "permission-policy.json"),
      JSON.stringify({
        version: 1,
        workspaceWriteRoots: ["."],
        shellAllowedCwds: ["."],
        networkAccess: { mode: "disabled", allowedHosts: [] },
        deniedPathPrefixes: [],
      }),
      "utf8",
    );
  }
  const session = await sessionStore.createSession("web search test");
  const environment = { ...process.env };
  delete environment.BRAVE_SEARCH_API_KEY;
  Object.assign(environment, input?.environment);
  return {
    runtime: new ToolRuntime({
      workspaceRoot,
      sessionStore,
      permissionMode: "danger-full-access",
      environment,
      networkService: input?.networkService,
      ...(input?.settings ? {} : { settings: { version: 1 } }),
    }),
    sessionId: session.sessionId,
    workspaceRoot,
  };
}

function networkResponse(
  body: string,
  status = 200,
  headers: Record<string, string> = {},
): ToolNetworkResponse {
  return {
    status,
    ok: status >= 200 && status < 300,
    headers,
    body: Buffer.from(body),
  };
}

function scriptedNetwork(input: {
  routes?: ToolNetworkRoute[];
  request: (url: URL, route: ToolNetworkRoute, init: RequestInit) => Promise<ToolNetworkResponse>;
}): ToolNetworkService {
  const routes = input.routes ?? ["system", "direct"];
  return {
    plan: async () => ({
      routes: routes.map((route) => ({
        route,
        source: route === "system" ? "windows_system" : "direct",
      })),
      systemRouteDistinct: routes.includes("system"),
    }),
    request: (url, init, options) => input.request(url, options.route, init),
    dispose: async () => undefined,
  };
}

afterEach(async () => {
  vi.unstubAllGlobals();
  await Promise.all(temporaryRoots.splice(0).map((root) => fs.rm(root, { recursive: true, force: true })));
});

describe("built-in web_search", () => {
  it("registers in the complete catalog and is selected only for web intent", async () => {
    const { runtime, sessionId } = await createRuntime();

    expect(runtime.listRegisteredToolDefinitions().map((tool) => tool.name)).toContain("web_search");
    expect(runtime.selectToolsForTurn({ prompt: "Inspect the TypeScript repository." }).definitions
      .map((tool) => tool.name)).not.toContain("web_search");
    expect(runtime.selectToolsForTurn({ prompt: "请联网搜索最新的 TypeScript 发布信息。" }).definitions
      .map((tool) => tool.name)).toContain("web_search");
    expect(runtime.selectToolsForTurn({
      prompt: "帮我查找一下今年（2026年）的世界杯四强国家分别是哪几个",
    }).definitions.map((tool) => tool.name)).toContain("web_search");

    const catalog = await runtime.executeManualTool("list_tools", { group: "web" }, sessionId);
    expect(catalog.structuredContent).toMatchObject({
      returnedCount: 4,
      tools: expect.arrayContaining([
        expect.objectContaining({ name: "web_search", moduleId: "builtin.web" }),
        expect.objectContaining({ name: "web_fetch", moduleId: "builtin.web" }),
        expect.objectContaining({ name: "http_request", moduleId: "builtin.web" }),
        expect.objectContaining({ name: "download_file", moduleId: "builtin.web" }),
      ]),
    });
  });

  it("uses Brave Search when the API key exists without exposing the key", async () => {
    const fetchMock = vi.fn().mockResolvedValue(new Response(JSON.stringify({
      web: {
        results: [
          {
            title: "<b>Deep Mix</b> release",
            url: "https://example.com/release",
            description: "A <em>bounded</em> search result.",
          },
        ],
      },
    }), {
      status: 200,
      headers: { "content-type": "application/json" },
    }));
    vi.stubGlobal("fetch", fetchMock);
    const { runtime, sessionId } = await createRuntime({
      environment: { BRAVE_SEARCH_API_KEY: "test-secret-key" },
    });

    const result = await runtime.executeManualTool(
      "web_search",
      { query: "Deep Mix", maxResults: 3, freshness: "week" },
      sessionId,
    );

    expect(result).toMatchObject({
      success: true,
      structuredContent: {
        kind: "web_search",
        query: "Deep Mix",
        provider: "brave",
        resultCount: 1,
        results: [{
          title: "Deep Mix release",
          url: "https://example.com/release",
          snippet: "A bounded search result.",
        }],
        warnings: [],
      },
    });
    const [requestedUrl, request] = fetchMock.mock.calls[0] as [URL, RequestInit];
    expect(requestedUrl.hostname).toBe("api.search.brave.com");
    expect(requestedUrl.searchParams.get("freshness")).toBe("pw");
    expect(new Headers(request.headers).get("X-Subscription-Token")).toBe("test-secret-key");
    expect(result.output).not.toContain("test-secret-key");
  });

  it("loads the Brave key from project settings without exposing it", async () => {
    const fetchMock = vi.fn().mockResolvedValue(new Response(JSON.stringify({
      web: {
        results: [{
          title: "Configured search",
          url: "https://example.com/settings",
          description: "Loaded from persistent settings.",
        }],
      },
    }), { status: 200 }));
    vi.stubGlobal("fetch", fetchMock);
    const { runtime, sessionId } = await createRuntime({
      environment: { BRAVE_SEARCH_API_KEY: "" },
      settings: {
        version: 1,
        webSearch: { braveApiKey: "settings-secret-key" },
      },
    });

    await runtime.initialize();
    const catalogResult = await runtime.executeManualTool("list_tools", { query: "web_search" }, sessionId);
    const result = await runtime.executeManualTool("web_search", { query: "settings" }, sessionId);

    expect(result).toMatchObject({
      success: true,
      structuredContent: { provider: "brave", resultCount: 1, warnings: [] },
    });
    const [, request] = fetchMock.mock.calls[0] as [URL, RequestInit];
    expect(new Headers(request.headers).get("X-Subscription-Token")).toBe("settings-secret-key");
    expect(JSON.stringify(catalogResult.structuredContent)).not.toContain("settings-secret-key");
    expect(result.output).not.toContain("settings-secret-key");
  });

  it("lets the environment override the persistent settings key", async () => {
    const fetchMock = vi.fn().mockResolvedValue(new Response(JSON.stringify({ web: { results: [] } }), {
      status: 200,
    }));
    vi.stubGlobal("fetch", fetchMock);
    const { runtime, sessionId } = await createRuntime({
      environment: { BRAVE_SEARCH_API_KEY: "environment-secret-key" },
      settings: {
        version: 1,
        webSearch: { braveApiKey: "settings-secret-key" },
      },
    });

    const result = await runtime.executeManualTool("web_search", { query: "priority" }, sessionId);

    expect(result.success).toBe(true);
    const [, request] = fetchMock.mock.calls[0] as [URL, RequestInit];
    expect(new Headers(request.headers).get("X-Subscription-Token")).toBe("environment-secret-key");
    expect(result.output).not.toContain("environment-secret-key");
    expect(result.output).not.toContain("settings-secret-key");
  });

  it("uses the keyless Bing RSS fallback and reports freshness limitations", async () => {
    const rss = `<?xml version="1.0" encoding="utf-8" ?>
      <rss version="2.0"><channel><item>
        <title>Search result &amp; details</title>
        <link>https://example.org/result</link>
        <description>Result &lt;b&gt;snippet&lt;/b&gt;.</description>
      </item></channel></rss>`;
    const fetchMock = vi.fn().mockResolvedValue(new Response(rss, {
      status: 200,
      headers: { "content-type": "text/xml" },
    }));
    vi.stubGlobal("fetch", fetchMock);
    const { runtime, sessionId } = await createRuntime({
      environment: { BRAVE_SEARCH_API_KEY: "" },
    });

    await runtime.initialize();
    const catalogResult = await runtime.executeManualTool("list_tools", { query: "web_search" }, sessionId);
    const catalog = catalogResult.structuredContent as {
      tools: Array<{ name: string; availability: { status: string; available: boolean } }>;
    };
    expect(catalog.tools).toHaveLength(1);
    expect(catalog.tools[0]).toMatchObject({
      name: "web_search",
      availability: { status: "degraded", available: true },
    });

    const result = await runtime.executeManualTool(
      "web_search",
      { query: "fallback", freshness: "day" },
      sessionId,
    );

    expect(result).toMatchObject({
      success: true,
      structuredContent: {
        provider: "bing",
        resultCount: 1,
        results: [{
          title: "Search result & details",
          url: "https://example.org/result",
          snippet: "Result snippet.",
        }],
        warnings: [
          expect.stringContaining("Bing RSS fallback"),
          expect.stringContaining("freshness was ignored"),
        ],
      },
    });
    const [requestedUrl] = fetchMock.mock.calls[0] as [URL];
    expect(requestedUrl.hostname).toBe("www.bing.com");
    expect(requestedUrl.searchParams.get("format")).toBe("rss");
  });

  it("follows one declared Bing regional redirect and returns RSS results", async () => {
    const rss = `<?xml version="1.0" encoding="utf-8" ?>
      <rss version="2.0"><channel><item>
        <title>Regional result</title>
        <link>https://example.cn/result</link>
        <description>Redirect completed.</description>
      </item></channel></rss>`;
    const fetchMock = vi.fn()
      .mockResolvedValueOnce(new Response(null, {
        status: 302,
        headers: { location: "https://cn.bing.com/search?format=rss&q=world+cup" },
      }))
      .mockResolvedValueOnce(new Response(rss, { status: 200 }));
    vi.stubGlobal("fetch", fetchMock);
    const { runtime, sessionId } = await createRuntime({
      environment: { BRAVE_SEARCH_API_KEY: "" },
    });

    const result = await runtime.executeManualTool(
      "web_search",
      { query: "2026年世界杯四强国家", maxResults: 5 },
      sessionId,
    );

    expect(result).toMatchObject({
      success: true,
      structuredContent: {
        provider: "bing",
        resultCount: 1,
        results: [{
          title: "Regional result",
          url: "https://example.cn/result",
          snippet: "Redirect completed.",
        }],
      },
    });
    expect(fetchMock).toHaveBeenCalledTimes(2);
    const [initialUrl, initialRequest] = fetchMock.mock.calls[0] as [URL, RequestInit];
    const [regionalUrl] = fetchMock.mock.calls[1] as [URL];
    expect(initialUrl.hostname).toBe("www.bing.com");
    expect(initialRequest.redirect).toBe("manual");
    expect(regionalUrl.hostname).toBe("cn.bing.com");
  });

  it("rejects redirects to undeclared hosts without issuing the second request", async () => {
    const fetchMock = vi.fn().mockResolvedValue(new Response(null, {
      status: 302,
      headers: { location: "https://untrusted.example/search?q=world+cup" },
    }));
    vi.stubGlobal("fetch", fetchMock);
    const { runtime, sessionId } = await createRuntime({
      environment: { BRAVE_SEARCH_API_KEY: "" },
    });

    const result = await runtime.executeManualTool("web_search", { query: "redirect" }, sessionId);

    expect(result).toMatchObject({
      success: false,
      structuredContent: {
        provider: "bing",
        error: {
          type: "provider_error",
          message: expect.stringContaining("redirect target host is not allowed: untrusted.example"),
        },
      },
    });
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it("classifies an unexpected redirect without exposing unbounded causes", async () => {
    const cause = Object.assign(new Error("unexpected redirect"), { code: "UND_ERR_REDIRECT" });
    vi.stubGlobal("fetch", vi.fn().mockRejectedValue(new TypeError("fetch failed", { cause })));
    const { runtime, sessionId } = await createRuntime({
      environment: { BRAVE_SEARCH_API_KEY: "" },
    });

    const result = await runtime.executeManualTool("web_search", { query: "diagnose" }, sessionId);

    expect(result).toMatchObject({
      success: false,
      structuredContent: {
        error: {
          type: "provider_error",
          message: "Search provider redirect failed (UND_ERR_REDIRECT)",
          retryable: false,
        },
      },
    });
    expect(result.output).not.toContain("unexpected redirect");
  });

  it("validates arguments before network access", async () => {
    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);
    const { runtime, sessionId } = await createRuntime();

    const result = await runtime.executeManualTool(
      "web_search",
      { query: "", maxResults: 50, unexpected: true },
      sessionId,
    );

    expect(result).toMatchObject({
      success: false,
      structuredContent: { error: { type: "invalid_arguments", retryable: false } },
    });
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("blocks the provider before fetch when network access is disabled", async () => {
    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);
    const { runtime, sessionId } = await createRuntime({
      environment: { BRAVE_SEARCH_API_KEY: "test-secret-key" },
      networkDisabled: true,
    });

    const result = await runtime.executeManualTool("web_search", { query: "blocked" }, sessionId);

    expect(result).toMatchObject({
      success: false,
      structuredContent: { error: { type: "sandbox_denied", retryable: false } },
    });
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("bounds result count and model-visible snippets", async () => {
    const results = Array.from({ length: 12 }, (_, index) => ({
      title: `Result ${index}`,
      url: `https://example.com/${index}`,
      description: "x".repeat(2_000),
    }));
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(new Response(JSON.stringify({ web: { results } }), {
      status: 200,
    })));
    const { runtime, sessionId } = await createRuntime({
      environment: { BRAVE_SEARCH_API_KEY: "test-secret-key" },
    });

    const result = await runtime.executeManualTool(
      "web_search",
      { query: "bounded", maxResults: 10 },
      sessionId,
    );
    const content = result.structuredContent as { results: Array<{ snippet: string }> };

    expect(content.results).toHaveLength(10);
    expect(content.results.every((entry) => entry.snippet.length <= 800)).toBe(true);
    expect(result.output.length).toBeLessThan(12_000);
  });

  it("classifies UND_ERR_CONNECT_TIMEOUT and succeeds through the direct route", async () => {
    const calls: Array<{ host: string; route: ToolNetworkRoute }> = [];
    const networkService = scriptedNetwork({
      request: async (url, route) => {
        calls.push({ host: url.hostname, route });
        if (route === "system") {
          const cause = Object.assign(new Error("connect timeout"), { code: "UND_ERR_CONNECT_TIMEOUT" });
          throw new TypeError("fetch failed", { cause });
        }
        return networkResponse(JSON.stringify({
          web: { results: [{ title: "Recovered", url: "https://example.com/recovered", description: "Direct route." }] },
        }));
      },
    });
    const { runtime, sessionId } = await createRuntime({
      environment: { BRAVE_SEARCH_API_KEY: "test-key" },
      networkService,
    });

    const result = await runtime.executeManualTool("web_search", { query: "recover" }, sessionId);

    expect(result).toMatchObject({
      success: true,
      structuredContent: {
        provider: "brave",
        networkRoute: "direct",
        fallbackUsed: true,
        attempts: [
          { provider: "brave", route: "system", outcome: "error", errorType: "timeout" },
          { provider: "brave", route: "direct", outcome: "success" },
        ],
      },
    });
    expect(calls).toEqual([
      { host: "api.search.brave.com", route: "system" },
      { host: "api.search.brave.com", route: "direct" },
    ]);
  });

  it("falls back to Bing inside one call after both Brave network routes fail", async () => {
    const calls: Array<{ host: string; route: ToolNetworkRoute }> = [];
    const rss = "<rss><channel><item><title>Bing recovery</title><link>https://example.org/bing</link><description>Recovered.</description></item></channel></rss>";
    const networkService = scriptedNetwork({
      request: async (url, route) => {
        calls.push({ host: url.hostname, route });
        if (url.hostname === "api.search.brave.com") {
          throw Object.assign(new Error("network unreachable"), { code: "ENETUNREACH" });
        }
        return networkResponse(rss);
      },
    });
    const { runtime, sessionId } = await createRuntime({
      environment: { BRAVE_SEARCH_API_KEY: "test-key" },
      networkService,
    });

    const result = await runtime.executeManualTool("web_search", { query: "fallback" }, sessionId);

    expect(result).toMatchObject({
      success: true,
      structuredContent: {
        provider: "bing",
        networkRoute: "system",
        fallbackUsed: true,
        resultCount: 1,
      },
    });
    expect(calls).toEqual([
      { host: "api.search.brave.com", route: "system" },
      { host: "api.search.brave.com", route: "direct" },
      { host: "www.bing.com", route: "system" },
    ]);
  });

  it.each([
    ["HTTP 500", networkResponse("provider unavailable", 500)],
    ["invalid JSON", networkResponse("not-json")],
  ])("falls back to Bing after Brave %s without wasting a direct attempt", async (_label, braveResponse) => {
    const calls: Array<{ host: string; route: ToolNetworkRoute }> = [];
    const networkService = scriptedNetwork({
      request: async (url, route) => {
        calls.push({ host: url.hostname, route });
        if (url.hostname === "api.search.brave.com") return braveResponse;
        return networkResponse("<rss><channel><item><title>Fallback</title><link>https://example.org/ok</link><description>OK</description></item></channel></rss>");
      },
    });
    const { runtime, sessionId } = await createRuntime({
      environment: { BRAVE_SEARCH_API_KEY: "test-key" },
      networkService,
    });

    const result = await runtime.executeManualTool("web_search", { query: "provider fallback" }, sessionId);

    expect(result).toMatchObject({ success: true, structuredContent: { provider: "bing" } });
    expect(calls).toEqual([
      { host: "api.search.brave.com", route: "system" },
      { host: "www.bing.com", route: "system" },
    ]);
  });

  it.each([
    [401, "authentication_failed"],
    [403, "authentication_failed"],
    [429, "rate_limited"],
  ])("does not hide Brave HTTP %i with a Bing fallback", async (status, errorType) => {
    const request = vi.fn().mockResolvedValue(networkResponse("rejected", status));
    const { runtime, sessionId } = await createRuntime({
      environment: { BRAVE_SEARCH_API_KEY: "test-key" },
      networkService: scriptedNetwork({ request }),
    });

    const result = await runtime.executeManualTool("web_search", { query: "auth" }, sessionId);

    expect(result).toMatchObject({
      success: false,
      structuredContent: {
        provider: "brave",
        attempts: [{ provider: "brave", route: "system", httpStatus: status }],
        error: { type: errorType, retryable: false },
      },
    });
    expect(request).toHaveBeenCalledTimes(1);
  });

  it("does not bypass a TLS certificate failure through the direct route", async () => {
    const request = vi.fn().mockRejectedValue(Object.assign(new Error("certificate rejected"), {
      code: "DEPTH_ZERO_SELF_SIGNED_CERT",
    }));
    const { runtime, sessionId } = await createRuntime({
      environment: { BRAVE_SEARCH_API_KEY: "test-key" },
      networkService: scriptedNetwork({ request }),
    });

    const result = await runtime.executeManualTool("web_search", { query: "tls" }, sessionId);

    expect(result).toMatchObject({
      success: false,
      structuredContent: { error: { type: "provider_error", retryable: false } },
    });
    expect(request).toHaveBeenCalledTimes(1);
  });

  it("exhausts four network strategies once and returns a non-retryable bounded failure", async () => {
    const request = vi.fn().mockRejectedValue(Object.assign(new Error("connection refused"), {
      code: "ECONNREFUSED",
    }));
    const { runtime, sessionId } = await createRuntime({
      environment: { BRAVE_SEARCH_API_KEY: "test-key" },
      networkService: scriptedNetwork({ request }),
    });

    const result = await runtime.executeManualTool("web_search", { query: "all fail" }, sessionId);
    const structured = result.structuredContent as {
      attempts: WebSearchAttemptForTest[];
      error: { type: string; retryable: boolean };
    };

    expect(result.success).toBe(false);
    expect(structured.attempts).toHaveLength(4);
    expect(structured.attempts.map((entry) => `${entry.provider}:${entry.route}`)).toEqual([
      "brave:system",
      "brave:direct",
      "bing:system",
      "bing:direct",
    ]);
    expect(structured.error).toMatchObject({ type: "network_error", retryable: false });
    expect(request).toHaveBeenCalledTimes(4);
    expect(result.output).not.toContain("127.0.0.1");
  });
});

interface WebSearchAttemptForTest {
  provider: string;
  route: string;
}
