import { createHash } from "node:crypto";
import { spawn } from "node:child_process";
import { promises as fs } from "node:fs";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";

import { afterEach, describe, expect, it } from "vitest";

import { GovernorRuntime, PermissionRequiredError } from "../packages/core-governor/src/index.js";
import { SessionStore } from "../packages/persistence/src/index.js";
import { PermissionLayer } from "../packages/safety/src/index.js";
import type {
  AssistantResponse,
  ModelClient,
  ModelCompletionRequest,
  NetworkAuditSummary,
  PermissionMode,
  StreamCallbacks,
  ToolCall,
  ToolExecutionAuditRecord,
  ToolResult,
} from "../packages/shared-schema/src/index.js";
import { ToolRuntime } from "../packages/tool-runtime/src/index.js";
import {
  PinnedHttpProxyAgent,
  requestWithNodeTransport,
  runBoundedNetworkOperation,
  type ToolNetworkRequestOptions,
  type ToolNetworkResponse,
  type ToolNetworkRoute,
  type ToolNetworkService,
} from "../packages/tool-runtime/src/network/index.js";
import { createNodeSystemToolNetworkService } from "../packages/tool-runtime/src/network/node-system.js";
import {
  SafeNetworkError,
  SafeNetworkBudgetManager,
  assertSafeIpAddress,
  classifyIpAddress,
  executeSafeHttpRequest,
  filterHighSignalHeaders,
  parseSafeHttpUrl,
  redactSensitiveText,
} from "../packages/tool-runtime/src/network/safe-http.js";

const PUBLIC_ADDRESS = { address: "93.184.216.34", family: 4 as const };
const PUBLIC_BASE_URL = `https://${PUBLIC_ADDRESS.address}`;
const temporaryRoots: string[] = [];

interface FakeReply {
  status?: number;
  headers?: Record<string, string>;
  body?: string | Uint8Array;
  chunks?: Array<string | Uint8Array>;
  errorBeforeResponse?: Error;
  errorAfterChunks?: Error;
  waitForAbort?: boolean;
  afterChunk?: (index: number) => void | Promise<void>;
}

interface FakeAttempt {
  url: string;
  method: string;
  headers: Record<string, string>;
  body: Buffer;
  route: ToolNetworkRoute;
  pinnedAddress?: string;
}

/**
 * Deterministic transport double that follows the real transport contract:
 * response metadata is delivered before chunks, wire bytes are reported before
 * consumer writes, collectBody is honored, and size/hash describe all bytes.
 */
class FaithfulFakeNetwork implements ToolNetworkService {
  public readonly attempts: FakeAttempt[] = [];

  private replyIndex = 0;

  public constructor(
    private readonly replies: Array<FakeReply | ((attempt: FakeAttempt) => FakeReply | Promise<FakeReply>)>,
    private readonly routes: ToolNetworkRoute[] = ["direct"],
  ) {}

  public async resolveDns(): Promise<Array<typeof PUBLIC_ADDRESS>> {
    return [PUBLIC_ADDRESS];
  }

  public async plan(): Promise<Awaited<ReturnType<ToolNetworkService["plan"]>>> {
    return {
      routes: this.routes.map((route) => ({
        route,
        source: route === "system" ? "windows_system" as const : "direct" as const,
      })),
      systemRouteDistinct: this.routes.includes("system"),
    };
  }

  public async request(
    url: URL,
    init: RequestInit,
    options: ToolNetworkRequestOptions,
  ): Promise<ToolNetworkResponse> {
    const body = init.body === undefined || init.body === null
      ? Buffer.alloc(0)
      : init.body instanceof ArrayBuffer
        ? Buffer.from(init.body)
        : ArrayBuffer.isView(init.body)
          ? Buffer.from(init.body.buffer, init.body.byteOffset, init.body.byteLength)
          : Buffer.from(String(init.body));
    const attempt: FakeAttempt = {
      url: url.toString(),
      method: String(init.method ?? "GET"),
      headers: Object.fromEntries(new Headers(init.headers).entries()),
      body,
      route: options.route,
      pinnedAddress: options.pinnedAddress?.address,
    };
    this.attempts.push(attempt);
    const source = this.replies[Math.min(this.replyIndex, this.replies.length - 1)];
    this.replyIndex += 1;
    if (!source) throw new Error("FaithfulFakeNetwork has no scripted reply.");
    const reply = typeof source === "function" ? await source(attempt) : source;
    if (reply.errorBeforeResponse) throw reply.errorBeforeResponse;
    if (reply.waitForAbort) {
      await new Promise<never>((_resolve, reject) => {
        const signal = init.signal;
        const fail = () => reject(Object.assign(new Error("fake request aborted"), { code: "ABORT_ERR" }));
        if (signal?.aborted) fail();
        else signal?.addEventListener("abort", fail, { once: true });
      });
    }

    const status = reply.status ?? 200;
    const head = {
      status,
      ok: status >= 200 && status < 300,
      headers: reply.headers ?? { "content-type": "text/plain" },
    };
    await options.bodyConsumer?.onResponse?.(head);
    const collectBody = typeof options.collectBody === "function"
      ? options.collectBody(head)
      : options.collectBody !== false;
    const chunks = (reply.chunks ?? [reply.body ?? ""]).map((chunk) => Buffer.from(chunk));
    const collected: Buffer[] = [];
    const hash = createHash("sha256");
    let sizeBytes = 0;
    for (const [index, chunk] of chunks.entries()) {
      sizeBytes += chunk.byteLength;
      await options.bodyConsumer?.onChunkReceived?.(chunk.byteLength);
      if (sizeBytes > options.maxResponseBytes) {
        throw Object.assign(new Error(`Network response exceeded ${options.maxResponseBytes} bytes.`), {
          code: "ERR_RESPONSE_TOO_LARGE",
        });
      }
      hash.update(chunk);
      await options.bodyConsumer?.onChunk?.(chunk);
      await reply.afterChunk?.(index);
      if (collectBody) collected.push(chunk);
    }
    if (reply.errorAfterChunks) throw reply.errorAfterChunks;
    return {
      ...head,
      body: collectBody ? Buffer.concat(collected, sizeBytes) : new Uint8Array(),
      sizeBytes,
      sha256: hash.digest("hex"),
    };
  }

  public async dispose(): Promise<void> {}
}

async function createToolFixture(input: {
  network: ToolNetworkService;
  permissionMode?: PermissionMode;
  networkDisabled?: boolean;
  prompt?: string;
}): Promise<{
  workspaceRoot: string;
  sessionStore: SessionStore;
  sessionId: string;
  runtime: ToolRuntime;
}> {
  const workspaceRoot = await fs.mkdtemp(path.join(os.tmpdir(), "deep-mix-phase16-tools-"));
  temporaryRoots.push(workspaceRoot);
  const sessionStore = new SessionStore(workspaceRoot);
  await sessionStore.ensureInitialized();
  if (input.networkDisabled) {
    await fs.writeFile(path.join(workspaceRoot, ".deep-mix", "permission-policy.json"), JSON.stringify({
      version: 1,
      workspaceWriteRoots: ["."],
      shellAllowedCwds: ["."],
      networkAccess: { mode: "disabled", allowedHosts: [] },
      deniedPathPrefixes: [
        ".git",
        ".deep-mix/api-key-library",
        ".deep-mix/checkpoints",
        ".deep-mix/file-history",
      ],
    }), "utf8");
  }
  const session = await sessionStore.createSession(input.prompt ?? "phase 16 guarded network tool test");
  const runtime = new ToolRuntime({
    workspaceRoot,
    sessionStore,
    permissionMode: input.permissionMode ?? "danger-full-access",
    environment: { ...process.env, BRAVE_SEARCH_API_KEY: undefined },
    settings: { version: 1 },
    networkService: input.network,
  });
  return { workspaceRoot, sessionStore, sessionId: session.sessionId, runtime };
}

function structured<T extends Record<string, unknown>>(result: ToolResult): T {
  return result.structuredContent as T;
}

function executionAudits(events: Awaited<ReturnType<SessionStore["loadEvents"]>>): ToolExecutionAuditRecord[] {
  return events.filter((event): event is ToolExecutionAuditRecord => event.recordType === "tool_execution_audit");
}

async function listRegularFiles(root: string): Promise<string[]> {
  const output: string[] = [];
  async function visit(directory: string): Promise<void> {
    const entries = await fs.readdir(directory, { withFileTypes: true }).catch((error: NodeJS.ErrnoException) => {
      if (error.code === "ENOENT") return [];
      throw error;
    });
    for (const entry of entries) {
      const absolutePath = path.join(directory, entry.name);
      if (entry.isDirectory()) await visit(absolutePath);
      else if (entry.isFile()) output.push(path.relative(root, absolutePath).replace(/\\/gu, "/"));
    }
  }
  await visit(root);
  return output.sort();
}

class ScriptedModelClient implements ModelClient {
  private index = 0;

  public constructor(private readonly responses: AssistantResponse[]) {}

  public async streamCompletion(
    _request: ModelCompletionRequest,
    callbacks?: StreamCallbacks,
  ): Promise<AssistantResponse> {
    const response = this.responses[this.index++];
    if (!response) throw new Error(`Unexpected model call ${this.index - 1}.`);
    if (response.content) callbacks?.onTextDelta?.(response.content);
    return response;
  }
}

afterEach(async () => {
  await Promise.all(temporaryRoots.splice(0).map((root) => fs.rm(root, { recursive: true, force: true })));
});

function directNetwork(
  request: ToolNetworkService["request"],
): ToolNetworkService {
  return {
    plan: async () => ({
      routes: [{ route: "direct", source: "direct" }],
      systemRouteDistinct: false,
    }),
    request,
    dispose: async () => undefined,
  };
}

describe("phase 16 guarded network foundation", () => {
  it("rejects ambiguous URLs and private, loopback, link-local, metadata, and mapped addresses", () => {
    for (const value of [
      "file:///etc/passwd",
      "http://user:secret@example.com/",
      "http://0x7f000001/",
      "http://example.com:0/",
      "http://example.com\\@127.0.0.1/",
    ]) {
      expect(() => parseSafeHttpUrl(value)).toThrow(SafeNetworkError);
    }
    for (const address of [
      "10.0.0.1",
      "127.0.0.1",
      "169.254.1.1",
      "169.254.169.254",
      "::1",
      "::ffff:127.0.0.1",
      "fc00::1",
      "fe80::1",
      "fd00:ec2::254",
      "168.63.129.16",
      "2001:2::1",
      "2001:20::1",
      "3fff::1",
    ]) {
      expect(() => assertSafeIpAddress(address)).toThrow(SafeNetworkError);
    }
    expect(classifyIpAddress(PUBLIC_ADDRESS.address)).toBe("public");
  });

  it("pins the validated DNS result and rejects mixed public/private DNS before connecting", async () => {
    let connected = 0;
    const network = directNetwork(async (_url, _init, options) => {
      connected += 1;
      expect(options.pinnedAddress).toEqual({ hostname: "example.com", ...PUBLIC_ADDRESS });
      return {
        status: 200,
        ok: true,
        headers: { "content-type": "text/plain" },
        body: Buffer.from("ok"),
      };
    });
    const success = await executeSafeHttpRequest({
      network,
      budgetKey: "pin-success",
      spec: {
        method: "GET",
        url: "https://example.com/",
        timeoutMs: 1_000,
        maxResponseBytes: 1_024,
        maxRedirects: 0,
      },
      resolveHostname: async () => [PUBLIC_ADDRESS],
    });
    expect(success.response.body).toEqual(Buffer.from("ok"));
    expect(connected).toBe(1);

    connected = 0;
    await expect(executeSafeHttpRequest({
      network,
      budgetKey: "mixed-dns",
      spec: {
        method: "GET",
        url: "https://example.com/",
        timeoutMs: 1_000,
        maxResponseBytes: 1_024,
        maxRedirects: 0,
      },
      resolveHostname: async () => [PUBLIC_ADDRESS, { address: "127.0.0.1", family: 4 }],
    })).rejects.toMatchObject({ networkErrorType: "policy_denied" });
    expect(connected).toBe(0);
  });

  it("does not leak concurrency leases when request validation fails", async () => {
    const budgetManager = new SafeNetworkBudgetManager({ maxGlobalConcurrency: 1, maxTurnConcurrency: 1 });
    for (let index = 0; index < 6; index += 1) {
      await expect(executeSafeHttpRequest({
        network: directNetwork(async () => {
          throw new Error("must not connect");
        }),
        budgetKey: `invalid-${index}`,
        budgetManager,
        spec: {
          method: "GET",
          url: "file:///etc/passwd",
          timeoutMs: 1_000,
          maxResponseBytes: 1_024,
          maxRedirects: 0,
        },
      })).rejects.toMatchObject({ networkErrorType: "policy_denied" });
    }
    await expect(executeSafeHttpRequest({
      network: directNetwork(async () => ({
        status: 200,
        ok: true,
        headers: { "content-type": "text/plain" },
        body: Buffer.from("ok"),
      })),
      budgetKey: "valid-after-rejections",
      budgetManager,
      spec: {
        method: "GET",
        url: "https://example.com/",
        timeoutMs: 1_000,
        maxResponseBytes: 1_024,
        maxRedirects: 0,
      },
      resolveHostname: async () => [PUBLIC_ADDRESS],
    })).resolves.toMatchObject({ response: { status: 200 } });
  });

  it("rejects caller proxy credentials and bounds DNS by the tool deadline", async () => {
    let requests = 0;
    const network = directNetwork(async () => {
      requests += 1;
      return { status: 200, ok: true, headers: {}, body: Buffer.from("ok") };
    });
    await expect(executeSafeHttpRequest({
      network,
      budgetKey: "proxy-authorization-rejected",
      spec: {
        method: "GET",
        url: "https://example.com/",
        headers: { "proxy-authorization": "Basic secret" },
        timeoutMs: 1_000,
        maxResponseBytes: 1_024,
        maxRedirects: 0,
      },
      resolveHostname: async () => [PUBLIC_ADDRESS],
    })).rejects.toMatchObject({ networkErrorType: "policy_denied" });
    expect(requests).toBe(0);

    const startedAt = Date.now();
    await expect(executeSafeHttpRequest({
      network,
      budgetKey: "dns-deadline",
      spec: {
        method: "GET",
        url: "https://example.com/",
        timeoutMs: 100,
        maxResponseBytes: 1_024,
        maxRedirects: 0,
      },
      resolveHostname: async () => new Promise(() => undefined),
    })).rejects.toMatchObject({ networkErrorType: "timeout" });
    expect(Date.now() - startedAt).toBeLessThan(1_000);
    expect(requests).toBe(0);
  });

  it("revalidates every redirect before issuing the next request", async () => {
    let requests = 0;
    const network = directNetwork(async (_url, _init, options) => {
      requests += 1;
      expect(options.pinnedAddress?.address).toBe(PUBLIC_ADDRESS.address);
      return {
        status: 302,
        ok: false,
        headers: { location: "http://127.0.0.1/admin" },
        body: new Uint8Array(),
        sizeBytes: 0,
      };
    });
    await expect(executeSafeHttpRequest({
      network,
      budgetKey: "redirect-private",
      spec: {
        method: "GET",
        url: "https://example.com/",
        timeoutMs: 1_000,
        maxResponseBytes: 1_024,
        maxRedirects: 3,
      },
      resolveHostname: async () => [PUBLIC_ADDRESS],
    })).rejects.toMatchObject({ networkErrorType: "policy_denied" });
    expect(requests).toBe(1);
  });

  it("pins the absolute target of a plain-HTTP forward proxy while preserving Host", async () => {
    let requestTarget: string | undefined;
    let hostHeader: string | undefined;
    const proxy = http.createServer((request, response) => {
      requestTarget = request.url;
      hostHeader = request.headers.host;
      response.writeHead(200, { "content-type": "text/plain" });
      response.end("proxied");
    });
    await new Promise<void>((resolve, reject) => {
      proxy.once("error", reject);
      proxy.listen(0, "127.0.0.1", resolve);
    });
    const address = proxy.address();
    if (!address || typeof address === "string") throw new Error("Expected a TCP proxy address.");
    const agent = new PinnedHttpProxyAgent(`http://127.0.0.1:${address.port}`);
    try {
      const response = await requestWithNodeTransport(new URL("http://example.com/resource?q=1"), {
        method: "GET",
      }, {
        route: "system",
        timeoutMs: 1_000,
        maxResponseBytes: 1_024,
        pinnedAddress: { hostname: "example.com", ...PUBLIC_ADDRESS },
      }, agent);
      expect(Buffer.from(response.body).toString("utf8")).toBe("proxied");
      expect(requestTarget).toBe("http://93.184.216.34/resource?q=1");
      expect(hostHeader).toBe("example.com");
    } finally {
      agent.destroy();
      await new Promise<void>((resolve) => proxy.close(() => resolve()));
    }
  });

  it("does not turn response-policy errors on a system proxy into direct fallback", async () => {
    let proxyRequests = 0;
    const proxy = http.createServer((_request, response) => {
      proxyRequests += 1;
      response.writeHead(200, { "content-type": "application/octet-stream" });
      response.end("binary");
    });
    await new Promise<void>((resolve, reject) => {
      proxy.once("error", reject);
      proxy.listen(0, "127.0.0.1", resolve);
    });
    const address = proxy.address();
    if (!address || typeof address === "string") throw new Error("Expected a TCP proxy address.");
    const network = createNodeSystemToolNetworkService({
      HTTP_PROXY: `http://127.0.0.1:${address.port}`,
    });
    try {
      await expect(executeSafeHttpRequest({
        network,
        budgetKey: "proxy-policy-no-fallback",
        spec: {
          method: "GET",
          url: "http://example.com/resource",
          expectedContentTypes: ["text/plain"],
          timeoutMs: 1_000,
          maxResponseBytes: 1_024,
          maxRedirects: 0,
        },
        resolveHostname: async () => [PUBLIC_ADDRESS],
      })).rejects.toMatchObject({ networkErrorType: "content_type" });
      expect(proxyRequests).toBe(1);
    } finally {
      await network.dispose();
      await new Promise<void>((resolve) => proxy.close(() => resolve()));
    }
  });

  it("keeps only replay-safe headers across origins and rejects HTTPS downgrade", async () => {
    const secondHopHeaders: Record<string, string> = {};
    let requestCount = 0;
    const network = directNetwork(async (_url, init) => {
      requestCount += 1;
      if (requestCount === 1) {
        return {
          status: 302,
          ok: false,
          headers: { location: "https://other.example/next" } as Record<string, string>,
          body: new Uint8Array(),
        };
      }
      Object.assign(secondHopHeaders, Object.fromEntries(new Headers(init.headers).entries()));
      return {
        status: 200,
        ok: true,
        headers: { "content-type": "text/plain" } as Record<string, string>,
        body: Buffer.from("ok"),
      };
    });
    await executeSafeHttpRequest({
      network,
      budgetKey: "cross-origin-headers",
      spec: {
        method: "GET",
        url: "https://example.com/start",
        headers: {
          accept: "text/plain",
          authorization: "Bearer secret",
          "api-key": "secret",
          apikey: "secret",
          "x-goog-api-key": "secret",
          "x-access-token": "secret",
          "x-custom-credential": "secret",
        },
        timeoutMs: 1_000,
        maxResponseBytes: 1_024,
        maxRedirects: 2,
      },
      resolveHostname: async () => [PUBLIC_ADDRESS],
    });
    expect(secondHopHeaders).toEqual({ accept: "text/plain" });

    await expect(executeSafeHttpRequest({
      network: directNetwork(async () => ({
        status: 302,
        ok: false,
        headers: { location: "http://other.example/insecure" },
        body: new Uint8Array(),
      })),
      budgetKey: "https-downgrade",
      spec: {
        method: "GET",
        url: "https://example.com/start",
        timeoutMs: 1_000,
        maxResponseBytes: 1_024,
        maxRedirects: 1,
      },
      resolveHostname: async () => [PUBLIC_ADDRESS],
    })).rejects.toMatchObject({ networkErrorType: "policy_denied" });
  });

  it("uses direct fallback only for read-only recoverable requests", async () => {
    const attempts: string[] = [];
    const network: ToolNetworkService = {
      plan: async () => ({
        routes: [
          { route: "system", source: "environment" },
          { route: "direct", source: "direct" },
        ],
        systemRouteDistinct: true,
      }),
      request: async (_url, _init, options) => {
        attempts.push(options.route);
        if (options.route === "system") {
          throw Object.assign(new Error("proxy connection failed"), { code: "ERR_PROXY_CONNECTION_FAILED" });
        }
        return { status: 200, ok: true, headers: {}, body: Buffer.from("ok") };
      },
      dispose: async () => undefined,
    };
    await expect(executeSafeHttpRequest({
      network,
      budgetKey: "get-fallback",
      spec: {
        method: "GET",
        url: "https://example.com/",
        timeoutMs: 1_000,
        maxResponseBytes: 1_024,
        maxRedirects: 0,
      },
      resolveHostname: async () => [PUBLIC_ADDRESS],
    })).resolves.toMatchObject({ response: { status: 200 } });
    expect(attempts).toEqual(["system", "direct"]);

    attempts.length = 0;
    await expect(executeSafeHttpRequest({
      network,
      budgetKey: "post-no-retry",
      spec: {
        method: "POST",
        url: "https://example.com/",
        body: { kind: "json", content: "{}" },
        timeoutMs: 1_000,
        maxResponseBytes: 1_024,
        maxRedirects: 0,
      },
      resolveHostname: async () => [PUBLIC_ADDRESS],
    })).rejects.toMatchObject({ networkErrorType: "proxy" });
    expect(attempts).toEqual(["system"]);

    await expect(executeSafeHttpRequest({
      network: {
        ...network,
        plan: async () => {
          throw new Error("proxy discovery unavailable");
        },
      },
      budgetKey: "post-plan-fail-closed",
      spec: {
        method: "POST",
        url: "https://example.com/",
        body: { kind: "json", content: "{}" },
        timeoutMs: 1_000,
        maxResponseBytes: 1_024,
        maxRedirects: 0,
      },
      resolveHostname: async () => [PUBLIC_ADDRESS],
    })).rejects.toMatchObject({ networkErrorType: "proxy", retryable: false });
  });

  it("does not downgrade proxy authentication or unsupported plan failures to direct", async () => {
    const cases = [
      Object.assign(new Error("Proxy authentication required."), { code: "ERR_PROXY_AUTH_REQUIRED" }),
      Object.assign(new Error("Unsupported proxy policy."), { code: "ERR_PROXY_UNSUPPORTED" }),
      Object.assign(new Error("Proxy plan returned HTTP 407 Authentication Required."), {
        code: "ERR_PROXY_PLAN_FAILED",
      }),
    ];

    for (const [index, planError] of cases.entries()) {
      let requests = 0;
      const network: ToolNetworkService = {
        plan: async () => { throw planError; },
        request: async () => {
          requests += 1;
          return { status: 200, ok: true, headers: {}, body: Buffer.from("must not use direct") };
        },
        dispose: async () => undefined,
      };
      await expect(executeSafeHttpRequest({
        network,
        budgetKey: `proxy-policy-plan-no-direct-${index}`,
        spec: {
          method: "GET",
          url: "https://example.com/proxy-plan-policy",
          timeoutMs: 1_000,
          maxResponseBytes: 1_024,
          maxRedirects: 0,
        },
        resolveHostname: async () => [PUBLIC_ADDRESS],
      })).rejects.toMatchObject({
        networkErrorType: "policy_denied",
        retryable: false,
      });
      expect(requests).toBe(0);
    }

    for (const [index, planError] of [
      Object.assign(new Error("Proxy discovery timed out."), { code: "ETIMEDOUT" }),
      Object.assign(new Error("Proxy connection failed."), { code: "ERR_PROXY_CONNECTION_FAILED" }),
    ].entries()) {
      const routes: ToolNetworkRoute[] = [];
      const network: ToolNetworkService = {
        plan: async () => { throw planError; },
        request: async (_url, _init, options) => {
          routes.push(options.route);
          return { status: 200, ok: true, headers: {}, body: Buffer.from("safe direct fallback") };
        },
        dispose: async () => undefined,
      };
      await expect(executeSafeHttpRequest({
        network,
        budgetKey: `transient-proxy-plan-direct-${index}`,
        spec: {
          method: "GET",
          url: "https://example.com/transient-proxy-plan",
          timeoutMs: 1_000,
          maxResponseBytes: 1_024,
          maxRedirects: 0,
        },
        resolveHostname: async () => [PUBLIC_ADDRESS],
      })).resolves.toMatchObject({ response: { status: 200 } });
      expect(routes).toEqual(["direct"]);
    }
  });

  it("charges failed-route bytes before fallback and gates consumers on content type", async () => {
    const routes: string[] = [];
    const network: ToolNetworkService = {
      plan: async () => ({
        routes: [
          { route: "system", source: "environment" },
          { route: "direct", source: "direct" },
        ],
        systemRouteDistinct: true,
      }),
      request: async (_url, _init, options) => {
        routes.push(options.route);
        await options.bodyConsumer?.onResponse?.({ status: 200, ok: true, headers: { "content-type": "text/plain" } });
        await options.bodyConsumer?.onChunkReceived?.(4);
        if (options.route === "system") {
          throw Object.assign(new Error("socket reset"), { code: "ECONNRESET" });
        }
        await options.bodyConsumer?.onChunk?.(Buffer.from("more"));
        return { status: 200, ok: true, headers: { "content-type": "text/plain" }, body: Buffer.from("more") };
      },
      dispose: async () => undefined,
    };
    await expect(executeSafeHttpRequest({
      network,
      budgetKey: "failed-route-byte-budget",
      maxTurnBytes: 6,
      spec: {
        method: "GET",
        url: "https://example.com/",
        timeoutMs: 1_000,
        maxResponseBytes: 1_024,
        maxRedirects: 0,
      },
      resolveHostname: async () => [PUBLIC_ADDRESS],
    })).rejects.toMatchObject({ networkErrorType: "response_too_large" });
    expect(routes).toEqual(["system", "direct"]);

    let consumerWrites = 0;
    await expect(executeSafeHttpRequest({
      network: directNetwork(async (_url, _init, options) => {
        await options.bodyConsumer?.onResponse?.({
          status: 200,
          ok: true,
          headers: { "content-type": "application/octet-stream" },
        });
        await options.bodyConsumer?.onChunkReceived?.(4);
        await options.bodyConsumer?.onChunk?.(Buffer.from("data"));
        return { status: 200, ok: true, headers: {}, body: new Uint8Array() };
      }),
      budgetKey: "content-type-gate",
      spec: {
        method: "GET",
        url: "https://example.com/file",
        expectedContentTypes: ["text/plain"],
        timeoutMs: 1_000,
        maxResponseBytes: 1_024,
        maxRedirects: 0,
      },
      finalBodyConsumer: {
        onChunk: () => {
          consumerWrites += 1;
        },
      },
      resolveHostname: async () => [PUBLIC_ADDRESS],
    })).rejects.toMatchObject({ networkErrorType: "content_type" });
    expect(consumerWrites).toBe(0);
  });

  it("counts each redirect or route attempt against the per-turn request budget", async () => {
    const routes: string[] = [];
    const budgetManager = new SafeNetworkBudgetManager({ maxTurnRequests: 1 });
    await expect(executeSafeHttpRequest({
      network: {
        plan: async () => ({
          routes: [
            { route: "system", source: "environment" },
            { route: "direct", source: "direct" },
          ],
          systemRouteDistinct: true,
        }),
        request: async (_url, _init, options) => {
          routes.push(options.route);
          throw Object.assign(new Error("proxy connection failed"), { code: "ERR_PROXY_CONNECTION_FAILED" });
        },
        dispose: async () => undefined,
      },
      budgetKey: "real-request-count",
      budgetManager,
      spec: {
        method: "GET",
        url: "https://example.com/",
        timeoutMs: 1_000,
        maxResponseBytes: 1_024,
        maxRedirects: 2,
      },
      resolveHostname: async () => [PUBLIC_ADDRESS],
    })).rejects.toMatchObject({ networkErrorType: "policy_denied" });
    expect(routes).toEqual(["system"]);
  });

  it("redacts sensitive text and returns only bounded high-signal response headers", () => {
    const secret = "phase16-secret-token";
    const text = redactSensitiveText(`Authorization: Bearer ${secret}; token=${secret}`, [secret]);
    expect(text).not.toContain(secret);
    expect(filterHighSignalHeaders({
      "content-type": "application/json",
      "set-cookie": `session=${secret}`,
      authorization: `Bearer ${secret}`,
      "x-request-id": "request-1",
    }, [secret])).toEqual({
      "content-type": "application/json",
      "x-request-id": "request-1",
    });
  });
});

describe("phase 16 guarded retrieval tools", () => {
  it("normalizes HTML, Markdown, text, and JSON; preserves citation and robots metadata; and guides binary retrieval", async () => {
    const network = new FaithfulFakeNetwork([
      {
        headers: {
          "content-type": "text/html; charset=utf-8",
          "x-robots-tag": "noarchive",
          "x-request-id": "html-request",
        },
        body: [
          "<!doctype html><html><head><title>Phase 16 Page</title>",
          '<meta name="robots" content="noindex, nofollow"></head>',
          '<body><nav>Discard me</nav><main><h1>Primary heading</h1>',
          '<p>Read the <a href="/guide">guarded guide</a>.</p></main></body></html>',
        ].join(""),
      },
      { headers: { "content-type": "text/markdown" }, body: "# Markdown\n\nBounded body." },
      { headers: { "content-type": "text/plain" }, body: " plain   text \n\n\n body " },
      { headers: { "content-type": "application/json" }, body: '{"visible":"ok","token":"response-secret"}' },
      { headers: { "content-type": "application/octet-stream" }, body: Buffer.from([0, 1, 2, 3]) },
    ]);
    const { runtime, sessionId } = await createToolFixture({ network });

    const htmlResult = await runtime.executeManualTool("web_fetch", { url: `${PUBLIC_BASE_URL}/page` }, sessionId);
    const html = structured<{
      format: string;
      title: string;
      content: string;
      finalUrl: string;
      citation: { title: string; url: string };
      citations: Array<{ url: string }>;
      robotsDirectives: string[];
      response: { headers: Record<string, string> };
    }>(htmlResult);
    expect(htmlResult.success).toBe(true);
    expect(html).toMatchObject({
      format: "html_markdown",
      title: "Phase 16 Page",
      finalUrl: `${PUBLIC_BASE_URL}/page`,
      citation: { title: "Phase 16 Page", url: `${PUBLIC_BASE_URL}/page` },
      citations: [{ url: `${PUBLIC_BASE_URL}/page` }],
    });
    expect(html.content).toContain("# Primary heading");
    expect(html.content).toContain(`[guarded guide](${PUBLIC_BASE_URL}/guide)`);
    expect(html.content).not.toContain("Discard me");
    expect(html.robotsDirectives).toEqual(["noindex, nofollow", "noarchive"]);
    expect(html.response.headers).toEqual({
      "content-type": "text/html; charset=utf-8",
      "x-request-id": "html-request",
    });

    const markdown = structured<{ format: string; content: string }>(
      await runtime.executeManualTool("web_fetch", { url: `${PUBLIC_BASE_URL}/markdown` }, sessionId),
    );
    expect(markdown).toMatchObject({ format: "markdown", content: "# Markdown\n\nBounded body." });

    const textBody = structured<{ format: string; content: string }>(
      await runtime.executeManualTool("web_fetch", { url: `${PUBLIC_BASE_URL}/text` }, sessionId),
    );
    expect(textBody).toMatchObject({
      format: "text",
      content: " plain   text \n\n\n body ",
    });

    const json = structured<{ format: string; content: string }>(
      await runtime.executeManualTool("web_fetch", { url: `${PUBLIC_BASE_URL}/json` }, sessionId),
    );
    expect(json.format).toBe("json");
    expect(JSON.parse(json.content)).toEqual({ visible: "ok", token: "[REDACTED]" });

    const binary = structured<{ format: string; downloadSuggested: boolean; warnings: string[] }>(
      await runtime.executeManualTool("web_fetch", { url: `${PUBLIC_BASE_URL}/binary` }, sessionId),
    );
    expect(binary).toMatchObject({ format: "binary", downloadSuggested: true });
    expect(binary.warnings.join(" ")).toContain("download_file");
    expect(network.attempts.every((attempt) => attempt.pinnedAddress === PUBLIC_ADDRESS.address)).toBe(true);
  });

  it("stores the full long web body as an artifact and links the raw result and audit evidence", async () => {
    const longBody = `# Long response\n\n${"evidence ".repeat(2_000)}`;
    const network = new FaithfulFakeNetwork([{
      headers: { "content-type": "text/markdown", "x-request-id": "long-body" },
      body: longBody,
    }]);
    const { runtime, sessionStore, sessionId } = await createToolFixture({ network });
    const result = await runtime.executeManualTool(
      "web_fetch",
      { url: `${PUBLIC_BASE_URL}/long`, maxChars: 80 },
      sessionId,
    );
    const content = structured<{
      finalUrl: string;
      truncated: boolean;
      content: string;
      rawArtifactUri: string;
      response: { sizeBytes: number; sha256: string };
    }>(result);

    expect(result.success).toBe(true);
    expect(content).toMatchObject({ finalUrl: `${PUBLIC_BASE_URL}/long`, truncated: true });
    expect(content.content.length).toBeLessThanOrEqual(80);
    expect(content.rawArtifactUri).toMatch(/^artifact:\/\/tool-outputs\//u);
    expect(await sessionStore.readTextToolOutputArtifact(content.rawArtifactUri)).toBe(longBody);
    expect("contextSummary" in result).toBe(false);
    expect(result.networkAudit).toMatchObject({ requestCount: 1, bytesReceived: Buffer.byteLength(longBody) });

    const audit = executionAudits(await sessionStore.loadEvents(sessionId)).at(-1);
    expect(audit).toMatchObject({
      toolName: "web_fetch",
      success: true,
      accessKinds: ["network_access"],
      artifactUris: [content.rawArtifactUri],
      network: result.networkAudit as NetworkAuditSummary,
    });
  });

  it("returns web and HTTP text beyond the old excerpt defaults without tool-level summarization", async () => {
    const webBody = `${"W".repeat(120_000)}WEB_FETCH_DEFAULT_TAIL_SENTINEL`;
    const httpBody = `${"H".repeat(120_000)}HTTP_REQUEST_DEFAULT_TAIL_SENTINEL`;
    const network = new FaithfulFakeNetwork([
      { headers: { "content-type": "text/plain" }, body: webBody },
      { headers: { "content-type": "text/plain" }, body: httpBody },
    ]);
    const { runtime, sessionId } = await createToolFixture({ network });

    const webResult = await runtime.executeManualTool(
      "web_fetch",
      { url: `${PUBLIC_BASE_URL}/full-default-web` },
      sessionId,
    );
    const httpResult = await runtime.executeManualTool(
      "http_request",
      { url: `${PUBLIC_BASE_URL}/full-default-http`, method: "GET" },
      sessionId,
    );
    expect(webResult.output).toContain("WEB_FETCH_DEFAULT_TAIL_SENTINEL");
    expect(httpResult.output).toContain("HTTP_REQUEST_DEFAULT_TAIL_SENTINEL");
    expect(webResult.structuredContent).toMatchObject({ truncated: false, rawArtifactUri: undefined });
    expect(httpResult.structuredContent).toMatchObject({ truncated: false, rawArtifactUri: undefined });
    expect("contextSummary" in webResult).toBe(false);
    expect("contextSummary" in httpResult).toBe(false);

    for (const toolName of ["web_fetch", "http_request"]) {
      const definition = runtime.listRegisteredToolDefinitions().find((entry) => entry.name === toolName);
      const properties = (definition?.inputSchema.properties ?? {}) as Record<string, Record<string, unknown>>;
      expect(properties.maxChars, toolName).toMatchObject({ maximum: 2_000_000, default: 2_000_000 });
    }
  });

  it("supports the complete HTTP method schema, transmits structured bodies, and preserves non-2xx bodies", async () => {
    const methods = ["GET", "HEAD", "POST", "PUT", "PATCH", "DELETE"] as const;
    const network = new FaithfulFakeNetwork([
      ...methods.map((method) => ({
        status: 200,
        headers: { "content-type": "application/json", "x-request-id": method },
        body: method === "HEAD" ? "" : JSON.stringify({ method }),
      })),
      {
        status: 422,
        headers: { "content-type": "application/json", "retry-after": "3" },
        body: '{"error":"validation failed","field":"name"}',
      },
    ]);
    const { runtime, sessionId } = await createToolFixture({ network });
    const definition = runtime.listRegisteredToolDefinitions().find((entry) => entry.name === "http_request");
    expect(definition?.inputSchema).toMatchObject({
      required: ["url", "method"],
      properties: { method: { enum: methods } },
    });

    for (const method of methods) {
      const args = {
        url: `${PUBLIC_BASE_URL}/methods`,
        method,
        query: { visible: method.toLocaleLowerCase() },
        ...(method === "POST" || method === "PUT" || method === "PATCH" || method === "DELETE"
          ? { body: { kind: "json", content: JSON.stringify({ method, value: 1 }) } }
          : {}),
      };
      const result = await runtime.executeManualTool("http_request", args, sessionId);
      expect(result.success).toBe(true);
      expect(structured<{ method: string; status: number; bodyFormat: string }>(result)).toMatchObject({
        method,
        status: 200,
        bodyFormat: method === "HEAD" ? "empty" : "json",
      });
    }
    expect(network.attempts.map((attempt) => attempt.method)).toEqual(methods);
    expect(network.attempts[2]?.body.toString("utf8")).toBe('{"method":"POST","value":1}');
    expect(new URL(network.attempts[0]!.url).searchParams.get("visible")).toBe("get");

    const non2xx = await runtime.executeManualTool(
      "http_request",
      { url: `${PUBLIC_BASE_URL}/invalid`, method: "GET" },
      sessionId,
    );
    expect(non2xx.success).toBe(true);
    expect(structured<{ status: number; ok: boolean; body: string; headers: Record<string, string> }>(non2xx))
      .toMatchObject({
        status: 422,
        ok: false,
        headers: { "content-type": "application/json", "retry-after": "3" },
      });
    expect(JSON.parse(structured<{ body: string }>(non2xx).body)).toEqual({
      error: "validation failed",
      field: "name",
    });
  });

  it("persists binary and large JSON HTTP responses as bounded artifacts", async () => {
    const binaryBody = Buffer.from([0x00, 0xff, 0x10, 0x20, 0x30]);
    const largeJson = JSON.stringify({ items: Array.from({ length: 300 }, (_, index) => ({ index, value: "x".repeat(20) })) });
    const network = new FaithfulFakeNetwork([
      { headers: { "content-type": "application/octet-stream" }, body: binaryBody },
      { headers: { "content-type": "application/json" }, body: largeJson },
    ]);
    const { runtime, sessionStore, sessionId } = await createToolFixture({ network });

    const binary = await runtime.executeManualTool(
      "http_request",
      { url: `${PUBLIC_BASE_URL}/blob`, method: "GET" },
      sessionId,
    );
    const binaryContent = structured<{ bodyFormat: string; rawArtifactUri: string; downloadSuggested: boolean }>(binary);
    expect(binaryContent).toMatchObject({ bodyFormat: "binary", downloadSuggested: true });
    expect(await sessionStore.readBinaryToolOutputArtifact(binaryContent.rawArtifactUri)).toEqual(binaryBody);

    const json = await runtime.executeManualTool(
      "http_request",
      { url: `${PUBLIC_BASE_URL}/large-json`, method: "GET", maxChars: 100 },
      sessionId,
    );
    const jsonContent = structured<{ bodyFormat: string; truncated: boolean; body: string; rawArtifactUri: string }>(json);
    expect(jsonContent).toMatchObject({ bodyFormat: "json", truncated: true });
    expect(jsonContent.body.length).toBeLessThanOrEqual(100);
    const fullJson = await sessionStore.readTextToolOutputArtifact(jsonContent.rawArtifactUri);
    expect(JSON.parse(fullJson).items).toHaveLength(300);
    expect("contextSummary" in json).toBe(false);
  });

  it("requires approval for mutating HTTP in auto mode before any request and never retries or follows redirects in danger mode", async () => {
    const autoNetwork = new FaithfulFakeNetwork([{ body: "must not execute" }]);
    const auto = await createToolFixture({ network: autoNetwork, permissionMode: "auto" });
    await expect(auto.runtime.executeManualTool(
      "http_request",
      { url: `${PUBLIC_BASE_URL}/state`, method: "POST", body: { kind: "json", content: "{}" } },
      auto.sessionId,
    )).rejects.toBeInstanceOf(PermissionRequiredError);
    expect(autoNetwork.attempts).toHaveLength(0);
    expect((await auto.sessionStore.loadEvents(auto.sessionId)).at(-1)).toMatchObject({
      recordType: "approval",
      toolName: "http_request",
      permissionCategory: "external_system",
      status: "pending",
    });

    const noRetryNetwork = new FaithfulFakeNetwork([
      { errorBeforeResponse: Object.assign(new Error("proxy socket reset"), { code: "ECONNRESET" }) },
      { body: "direct route must not run" },
    ], ["system", "direct"]);
    const danger = await createToolFixture({ network: noRetryNetwork });
    const failed = await danger.runtime.executeManualTool(
      "http_request",
      { url: `${PUBLIC_BASE_URL}/state`, method: "PATCH", body: { kind: "json", content: "{}" } },
      danger.sessionId,
    );
    expect(failed.success).toBe(false);
    expect(noRetryNetwork.attempts.map((attempt) => attempt.route)).toEqual(["system"]);

    const redirectNetwork = new FaithfulFakeNetwork([
      { status: 307, headers: { location: `${PUBLIC_BASE_URL}/other` }, body: "" },
      { body: "redirect target must not run" },
    ]);
    const redirectFixture = await createToolFixture({ network: redirectNetwork });
    const redirected = await redirectFixture.runtime.executeManualTool(
      "http_request",
      { url: `${PUBLIC_BASE_URL}/state`, method: "DELETE" },
      redirectFixture.sessionId,
    );
    expect(redirected.success).toBe(true);
    expect(structured<{ status: number; finalUrl: string }>(redirected)).toMatchObject({
      status: 307,
      finalUrl: `${PUBLIC_BASE_URL}/state`,
    });
    expect(redirectNetwork.attempts).toHaveLength(1);
  });

  it("redacts sensitive request and response data from governor history, hooks, output, and audit surfaces", async () => {
    const secrets = [
      "url-secret-123",
      "header-secret-456",
      "body-secret-789",
      "response-secret-321",
      "session-url-secret-654",
      "jwt-url-secret-987",
      "sid-query-secret-741",
      "jwt-header-secret-852",
      "session-header-secret-963",
      "session-body-secret-159",
      "camel-key-secret-357",
    ];
    const args = {
      url: `${PUBLIC_BASE_URL}/secrets?token=${secrets[0]}&sessionid=${secrets[4]}&jwt=${secrets[5]}&author=Alice`,
      method: "POST" as const,
      headers: {
        Authorization: `Bearer ${secrets[1]}`,
        "X-JWT": secrets[7],
        "X-Session-ID": secrets[8],
        [`X-TokenCamel${secrets[10]}`]: "opaque-header-value",
        "x-visible": "safe",
      },
      query: {
        api_key: secrets[0],
        session_id: secrets[4],
        sid: secrets[6],
        [`tokenCamel${secrets[10]}`]: "opaque-query-value",
        author: "Alice",
        visible: "safe",
      },
      body: {
        kind: "json" as const,
        content: JSON.stringify({ token: secrets[2], session_id: secrets[9], visible: "request-ok" }),
      },
    };
    const toolCall: ToolCall = {
      id: "phase16-secret-call",
      name: "http_request",
      rawArguments: JSON.stringify(args),
      arguments: args,
    };
    const network = new FaithfulFakeNetwork([{
      headers: {
        "content-type": "application/json",
        "set-cookie": `session=${secrets[3]}`,
        "x-request-id": "visible-request-id",
      },
      body: JSON.stringify({
        token: secrets[3],
        sessionUrlEcho: secrets[4],
        jwtUrlEcho: secrets[5],
        sidQueryEcho: secrets[6],
        jwtHeaderEcho: secrets[7],
        sessionHeaderEcho: secrets[8],
        sessionBodyEcho: secrets[9],
        visible: "response-ok",
      }),
    }]);
    const modelClient = new ScriptedModelClient([
      { content: "", toolCalls: [toolCall] },
      { content: "Sensitive values were handled safely.", toolCalls: [] },
    ]);
    const workspaceRoot = await fs.mkdtemp(path.join(os.tmpdir(), "deep-mix-phase16-redaction-"));
    temporaryRoots.push(workspaceRoot);
    const hookCalls: ToolCall[] = [];
    const toolResults: ToolResult[] = [];
    const governor = new GovernorRuntime({
      workspaceRoot,
      permissionMode: "danger-full-access",
      modelClient,
      networkService: network,
      environment: { ...process.env, BRAVE_SEARCH_API_KEY: undefined },
    });
    const turn = await governor.runTurn({
      prompt: "Send an API request with the HTTP request tool now and report the response; do not write code.",
      routeOverride: "ds_direct",
      callbacks: {
        onToolStart: (call) => hookCalls.push(call),
        onToolEnd: (result) => toolResults.push(result),
      },
    });
    const sessionStore = new SessionStore(workspaceRoot);
    const persisted = JSON.stringify({
      messages: await sessionStore.loadMessages(turn.sessionId),
      events: await sessionStore.loadEvents(turn.sessionId),
      hooks: hookCalls,
      results: toolResults,
    });
    for (const secret of secrets) expect(persisted).not.toContain(secret);
    expect(persisted).toContain("[REDACTED]");
    expect(persisted).toContain("visible-request-id");
    expect(persisted).toContain("response-ok");
    expect(persisted).toContain("author=Alice");
    expect(network.attempts[0]?.url).toContain(`sessionid=${secrets[4]}`);
    expect(network.attempts[0]?.headers["x-jwt"]).toBe(secrets[7]);
    expect(network.attempts[0]?.headers["x-session-id"]).toBe(secrets[8]);
    const httpResult = toolResults.find((result) => result.toolName === "http_request");
    expect(httpResult).toBeDefined();
    expect(structured<{ body: string; headers: Record<string, string> }>(httpResult!)).toMatchObject({
      headers: { "content-type": "application/json", "x-request-id": "visible-request-id" },
    });
    expect(JSON.parse(structured<{ body: string }>(httpResult!).body)).toEqual({
      token: "[REDACTED]",
      sessionUrlEcho: "[REDACTED]",
      jwtUrlEcho: "[REDACTED]",
      sidQueryEcho: "[REDACTED]",
      jwtHeaderEcho: "[REDACTED]",
      sessionHeaderEcho: "[REDACTED]",
      sessionBodyEcho: "[REDACTED]",
      visible: "response-ok",
    });
    expect(await sessionStore.loadProtectedToolCall(turn.sessionId, toolCall.id)).toBeUndefined();
  }, 30_000);
});

describe("phase 16 guarded downloads", () => {
  it("downloads an integrity-checked artifact with a safe name and linked audit metadata", async () => {
    const pdf = Buffer.from("%PDF-1.7\nphase-16-payload\n%%EOF\n", "utf8");
    const network = new FaithfulFakeNetwork([{
      headers: {
        "content-type": "application/pdf",
        "content-disposition": "attachment; filename*=UTF-8''..%2FCON%3F-report.pdf",
        "x-request-id": "download-request",
      },
      chunks: [pdf.subarray(0, 8), pdf.subarray(8)],
    }]);
    const { runtime, sessionStore, sessionId } = await createToolFixture({ network });
    const result = await runtime.executeManualTool(
      "download_file",
      { url: `${PUBLIC_BASE_URL}/files/report.pdf` },
      sessionId,
    );
    const output = structured<{
      fileName: string;
      mimeType: string;
      sizeBytes: number;
      sha256: string;
      sourceUrl: string;
      finalUrl: string;
      artifactUri: string;
    }>(result);
    const expectedHash = createHash("sha256").update(pdf).digest("hex");

    expect(result.success).toBe(true);
    expect(output).toMatchObject({
      mimeType: "application/pdf",
      sizeBytes: pdf.byteLength,
      sha256: expectedHash,
      sourceUrl: `${PUBLIC_BASE_URL}/files/report.pdf`,
      finalUrl: `${PUBLIC_BASE_URL}/files/report.pdf`,
    });
    expect(output.fileName).not.toMatch(/[\\/:*?"<>|]/u);
    expect(path.basename(output.fileName)).toBe(output.fileName);
    expect(await sessionStore.readBinaryToolOutputArtifact(output.artifactUri)).toEqual(pdf);
    expect("contextSummary" in result).toBe(false);
    expect(result.networkAudit).toMatchObject({
      requestCount: 1,
      bytesReceived: pdf.byteLength,
      status: 200,
    });
    expect(executionAudits(await sessionStore.loadEvents(sessionId)).at(-1)).toMatchObject({
      toolName: "download_file",
      success: true,
      accessKinds: ["network_access"],
      artifactUris: [output.artifactUri],
      network: result.networkAudit as NetworkAuditSummary,
    });
  });

  it("rejects credential-reflecting PDF downloads before artifact or workspace publication", async () => {
    const secret = "download-bearer-reflection-749318";
    const reflectedPdf = Buffer.from(
      `%PDF-1.7\nAuthorization: Bearer ${secret}\n%%EOF\n`,
      "utf8",
    );
    const network = new FaithfulFakeNetwork([
      { headers: { "content-type": "application/pdf" }, body: reflectedPdf },
      { headers: { "content-type": "application/pdf" }, body: reflectedPdf },
    ]);
    const fixture = await createToolFixture({ network });
    const downloads = path.join(fixture.workspaceRoot, "downloads");
    const workspaceDestination = path.join(downloads, "reflected-workspace.pdf");
    await fs.mkdir(downloads);
    const requestHeaders = { Authorization: `Bearer ${secret}` };

    const artifact = await fixture.runtime.executeManualTool(
      "download_file",
      {
        url: `${PUBLIC_BASE_URL}/reflected-artifact.pdf`,
        target: "artifact",
        outputName: "reflected-artifact.pdf",
        headers: requestHeaders,
      },
      fixture.sessionId,
    );
    const workspace = await fixture.runtime.executeManualTool(
      "download_file",
      {
        url: `${PUBLIC_BASE_URL}/reflected-workspace.pdf`,
        target: "workspace",
        workspacePath: "downloads/reflected-workspace.pdf",
        overwriteStrategy: "error",
        headers: requestHeaders,
      },
      fixture.sessionId,
    );

    expect(network.attempts).toHaveLength(2);
    expect(network.attempts.map((attempt) => attempt.headers.authorization)).toEqual([
      `Bearer ${secret}`,
      `Bearer ${secret}`,
    ]);
    for (const result of [artifact, workspace]) {
      expect(result.success, JSON.stringify(result)).toBe(false);
      expect(structured<{ errorType: string }>(result)).toMatchObject({
        errorType: "policy_denied",
      });
      expect(JSON.stringify(result)).not.toContain(secret);
      expect(JSON.stringify(result)).not.toContain("artifact://");
    }
    expect(await fixture.sessionStore.listToolOutputArtifacts(fixture.sessionId)).toEqual([]);
    expect(await listRegularFiles(path.join(fixture.workspaceRoot, ".deep-mix", "tool-outputs"))).toEqual([]);
    await expect(fs.stat(workspaceDestination)).rejects.toMatchObject({ code: "ENOENT" });
    expect(await fs.readdir(downloads)).not.toContainEqual(expect.stringMatching(/^\.deep-mix-download-/u));
  });

  it("resets the staged stream before read-only route fallback so partial proxy bytes cannot contaminate the artifact", async () => {
    const validPdf = Buffer.from("%PDF-1.7\nclean-direct-route\n%%EOF\n", "utf8");
    const network = new FaithfulFakeNetwork([
      {
        headers: { "content-type": "application/pdf" },
        chunks: ["%PDF-partial-proxy"],
        errorAfterChunks: Object.assign(new Error("proxy socket reset"), { code: "ECONNRESET" }),
      },
      {
        headers: { "content-type": "application/pdf" },
        chunks: [validPdf.subarray(0, 5), validPdf.subarray(5)],
      },
    ], ["system", "direct"]);
    const { runtime, sessionStore, sessionId } = await createToolFixture({ network });
    const result = await runtime.executeManualTool(
      "download_file",
      { url: `${PUBLIC_BASE_URL}/fallback.pdf`, outputName: "fallback.pdf" },
      sessionId,
    );
    const output = structured<{ artifactUri: string; sha256: string; sizeBytes: number }>(result);

    expect(result.success).toBe(true);
    expect(network.attempts.map((attempt) => attempt.route)).toEqual(["system", "direct"]);
    expect(await sessionStore.readBinaryToolOutputArtifact(output.artifactUri)).toEqual(validPdf);
    expect(output).toMatchObject({
      sha256: createHash("sha256").update(validPdf).digest("hex"),
      sizeBytes: validPdf.byteLength,
    });
    expect(result.networkAudit).toMatchObject({
      requestCount: 2,
      routes: ["system", "direct"],
      bytesReceived: Buffer.byteLength("%PDF-partial-proxy") + validPdf.byteLength,
    });
  });

  it("leaves no trusted artifact after oversize, cancellation, or declared-signature conflict failures", async () => {
    const controller = new AbortController();
    const network = new FaithfulFakeNetwork([
      { headers: { "content-type": "application/octet-stream" }, body: "too-large" },
      { headers: { "content-type": "application/pdf" }, body: "this is not a PDF" },
      {
        headers: { "content-type": "application/octet-stream" },
        chunks: ["partial", "must-not-commit"],
        afterChunk: (index) => {
          if (index === 0) controller.abort(new Error("phase16 cancellation"));
        },
      },
    ]);
    const { runtime, sessionStore, sessionId } = await createToolFixture({ network });

    const oversize = await runtime.executeManualTool(
      "download_file",
      { url: `${PUBLIC_BASE_URL}/oversize.bin`, maxBytes: 4 },
      sessionId,
    );
    expect(oversize.success).toBe(false);
    expect(structured<{ errorType: string }>(oversize)).toMatchObject({ errorType: "response_too_large" });
    expect(await sessionStore.listToolOutputArtifacts(sessionId)).toEqual([]);

    const signature = await runtime.executeManualTool(
      "download_file",
      { url: `${PUBLIC_BASE_URL}/fake.pdf` },
      sessionId,
    );
    expect(signature.success).toBe(false);
    expect(structured<{ errorType: string }>(signature)).toMatchObject({ errorType: "content_type" });
    expect(await sessionStore.listToolOutputArtifacts(sessionId)).toEqual([]);

    const cancelled = await runtime.executeManualTool(
      "download_file",
      { url: `${PUBLIC_BASE_URL}/cancelled.bin` },
      sessionId,
      { signal: controller.signal },
    );
    expect(cancelled.success).toBe(false);
    expect(structured<{ errorType: string }>(cancelled)).toMatchObject({ errorType: "cancelled" });
    expect(network.attempts).toHaveLength(3);
    expect(await sessionStore.listToolOutputArtifacts(sessionId)).toEqual([]);
  });

  it("guards workspace paths and supports checkpointed replace, unique publish, and undo", async () => {
    const network = new FaithfulFakeNetwork([
      { headers: { "content-type": "text/plain" }, body: "replacement" },
      { headers: { "content-type": "text/plain" }, body: "unique copy" },
    ]);
    const fixture = await createToolFixture({ network });
    const downloads = path.join(fixture.workspaceRoot, "downloads");
    const destination = path.join(downloads, "report.txt");
    await fs.mkdir(downloads);
    await fs.writeFile(destination, "original", "utf8");

    const replaced = await fixture.runtime.executeManualTool(
      "download_file",
      {
        url: `${PUBLIC_BASE_URL}/report.txt`,
        target: "workspace",
        workspacePath: "downloads/report.txt",
        overwriteStrategy: "replace",
      },
      fixture.sessionId,
    );
    expect(replaced.success, JSON.stringify(replaced)).toBe(true);
    expect(structured<{ workspaceRelativePath: string }>(replaced)).toMatchObject({
      workspaceRelativePath: "downloads/report.txt",
    });
    expect(await fs.readFile(destination, "utf8")).toBe("replacement");
    expect("contextSummary" in replaced).toBe(false);
    const replaceCheckpoint = (await fixture.sessionStore.listUndoCandidates(fixture.sessionId))[0];
    expect(replaceCheckpoint).toMatchObject({ scope: "pre_tool_write" });
    await fixture.sessionStore.restoreCheckpoint({
      sessionId: fixture.sessionId,
      checkpointId: replaceCheckpoint!.checkpointId,
      mode: "code",
      reason: "phase16 workspace download undo",
    });
    expect(await fs.readFile(destination, "utf8")).toBe("original");

    const unique = await fixture.runtime.executeManualTool(
      "download_file",
      {
        url: `${PUBLIC_BASE_URL}/report-copy.txt`,
        target: "workspace",
        workspacePath: "downloads/report.txt",
        overwriteStrategy: "unique",
      },
      fixture.sessionId,
    );
    expect(unique.success).toBe(true);
    expect(structured<{ workspaceRelativePath: string }>(unique)).toMatchObject({
      workspaceRelativePath: "downloads/report (1).txt",
    });
    expect(await fs.readFile(path.join(downloads, "report (1).txt"), "utf8")).toBe("unique copy");

    const escaped = await fixture.runtime.executeManualTool(
      "download_file",
      {
        url: `${PUBLIC_BASE_URL}/escape.txt`,
        target: "workspace",
        workspacePath: "../escape.txt",
      },
      fixture.sessionId,
    );
    expect(escaped.success).toBe(false);
    expect(network.attempts).toHaveLength(2);
    expect(await fs.readdir(downloads)).not.toContainEqual(expect.stringMatching(/^\.deep-mix-download-/u));
    await expect(fs.stat(path.join(fixture.workspaceRoot, "..", "escape.txt"))).rejects.toMatchObject({ code: "ENOENT" });
  });
});

describe("phase 16 retrieval selection and policy", () => {
  it("selects search, fetch, API, and download tools narrowly without injecting them into ordinary repository work", async () => {
    const fixture = await createToolFixture({ network: new FaithfulFakeNetwork([]) });
    const selected = (prompt: string) => fixture.runtime.selectToolsForTurn({ prompt }).definitions.map((tool) => tool.name);

    expect(selected("search the web for the latest release")).toContain("web_search");
    expect(selected("fetch URL content from this HTTP page")).toContain("web_fetch");
    expect(selected("send an API request using HTTP request GET")).toContain("http_request");
    expect(selected("download file from this HTTP link")).toContain("download_file");
    const ordinary = selected("Refactor the TypeScript repository, inspect files, and run tests.");
    expect(ordinary).not.toEqual(expect.arrayContaining([
      "web_search",
      "web_fetch",
      "http_request",
      "download_file",
    ]));
  });

  it("lets tool_search discover retrieval tools while a disabled network policy still blocks execution", async () => {
    const network = new FaithfulFakeNetwork([{ body: "must never execute" }]);
    const fixture = await createToolFixture({ network, networkDisabled: true });
    const discovery = await fixture.runtime.executeManualTool(
      "tool_search",
      { query: "web_fetch", mode: "discover", maxResults: 5 },
      fixture.sessionId,
    );
    expect(discovery.success).toBe(true);
    expect(structured<{ matches: Array<{ name: string }> }>(discovery).matches).toContainEqual(
      expect.objectContaining({ name: "web_fetch" }),
    );

    const blocked = await fixture.runtime.executeManualTool(
      "web_fetch",
      { url: `${PUBLIC_BASE_URL}/blocked` },
      fixture.sessionId,
    );
    expect(blocked.success).toBe(false);
    expect(structured<{ error: { type: string } }>(blocked)).toMatchObject({ error: { type: "sandbox_denied" } });
    expect(blocked.output).toContain("Network access is disabled");
    expect(network.attempts).toHaveLength(0);
  });

  it("merges mandatory denies into legacy policies and case-folds protected paths on Windows", async () => {
    const workspaceRoot = await fs.mkdtemp(path.join(os.tmpdir(), "deep-mix-phase16-legacy-policy-"));
    temporaryRoots.push(workspaceRoot);
    const sessionStore = new SessionStore(workspaceRoot);
    await sessionStore.ensureInitialized();
    const customDeniedPrefix = "custom-private-output";
    await fs.writeFile(
      path.join(workspaceRoot, ".deep-mix", "permission-policy.json"),
      JSON.stringify({
        version: 1,
        workspaceWriteRoots: ["."],
        shellAllowedCwds: ["."],
        networkAccess: { mode: "inherit", allowedHosts: [] },
        // Simulate a saved pre-hardening policy that lacks newer protected state roots.
        deniedPathPrefixes: [
          ".git",
          ".deep-mix/api-key-library",
          ".deep-mix/checkpoints",
          ".deep-mix/file-history",
          ".deep-mix/worker-artifacts",
          ".deep-mix/worker-sessions",
          customDeniedPrefix,
        ],
      }),
      "utf8",
    );
    const permissions = new PermissionLayer(workspaceRoot, "danger-full-access", sessionStore);
    const mandatoryProtectedPaths = [
      ".deep-mix/completed-tool-results/session/call.json",
      ".deep-mix/protected-tool-calls/session/call.json",
      ".deep-mix/approval-state.json",
      ".deep-mix/approval-request-key.bin",
      ".deep-mix/permission-policy.json",
      ".deep-mix/tool-outputs/session/result.txt",
      ".DEEP-MIX/API-KEY-LIBRARY/profiles.local.json",
      ".DEEP-MIX/TOOL-OUTPUTS/session/result.txt",
    ];

    for (const protectedPath of mandatoryProtectedPaths) {
      await expect(permissions.assertWritablePaths([protectedPath]))
        .rejects.toThrow(/outside the writable sandbox/iu);
    }
    await expect(permissions.assertWritablePaths([`${customDeniedPrefix}/report.txt`]))
      .rejects.toThrow(/outside the writable sandbox/iu);
    await expect(permissions.assertWritablePaths(["src/ordinary-output.ts"])).resolves.toBeUndefined();
  });

  it("requires approval before any auto-mode run_tests, lint, or typecheck process can start", async () => {
    const fixture = await createToolFixture({
      network: new FaithfulFakeNetwork([]),
      permissionMode: "auto",
    });
    const protectedSecret = "PHASE16-PROTECTED-RUN-TESTS-SECRET";
    const protectedDirectory = path.join(fixture.workspaceRoot, ".deep-mix", "api-key-library");
    await fs.mkdir(protectedDirectory, { recursive: true });
    await fs.writeFile(path.join(protectedDirectory, "dummy.txt"), protectedSecret, "utf8");
    const processMarkers = [
      path.join(fixture.workspaceRoot, "lint-process-started.txt"),
      path.join(fixture.workspaceRoot, "typecheck-process-started.txt"),
    ];
    const cases = [
      {
        toolName: "run_tests",
        command: "Get-Content .deep-mix/api-key-library/dummy.txt",
      },
      {
        toolName: "lint",
        command: "Set-Content -LiteralPath 'lint-process-started.txt' -Value 'ran'",
      },
      {
        toolName: "typecheck",
        command: "Set-Content -LiteralPath 'typecheck-process-started.txt' -Value 'ran'",
      },
    ];

    for (const testCase of cases) {
      let failure: unknown;
      try {
        await fixture.runtime.executeManualTool(
          testCase.toolName,
          { command: testCase.command },
          fixture.sessionId,
          testCase.toolName === "run_tests"
            ? ({ executionOrigin: "runtime_post_edit_verification" } as unknown as { turnId?: string })
            : undefined,
        );
      } catch (error) {
        failure = error;
      }
      expect(failure, `${testCase.toolName} executed without approval`).toBeInstanceOf(PermissionRequiredError);
      expect(JSON.stringify(failure)).not.toContain(protectedSecret);
    }
    let executeToolFailure: unknown;
    const executeToolCommand = "Set-Content -LiteralPath 'lint-process-started.txt' -Value 'ran'";
    try {
      await fixture.runtime.executeTool(
        {
          id: "forged-execute-tool-origin",
          name: "lint",
          arguments: { command: executeToolCommand },
          rawArguments: JSON.stringify({ command: executeToolCommand }),
        },
        fixture.sessionId,
        { executionOrigin: "runtime_post_edit_verification" } as unknown as { turnId?: string },
      );
    } catch (error) {
      executeToolFailure = error;
    }
    expect(executeToolFailure).toBeInstanceOf(PermissionRequiredError);
    for (const markerPath of processMarkers) {
      await expect(fs.stat(markerPath)).rejects.toMatchObject({ code: "ENOENT" });
    }
    const persistedBeforeApproval = JSON.stringify({
      messages: await fixture.sessionStore.loadMessages(fixture.sessionId),
      events: await fixture.sessionStore.loadEvents(fixture.sessionId),
    });
    expect(persistedBeforeApproval).not.toContain(protectedSecret);

    const dangerRuntime = new ToolRuntime({
      workspaceRoot: fixture.workspaceRoot,
      sessionStore: fixture.sessionStore,
      permissionMode: "danger-full-access",
      environment: { ...process.env, BRAVE_SEARCH_API_KEY: undefined },
      settings: { version: 1 },
      networkService: new FaithfulFakeNetwork([]),
    });
    const dangerMarker = path.join(fixture.workspaceRoot, "danger-run-tests-marker.txt");
    const dangerCommand = process.platform === "win32"
      ? "Set-Content -LiteralPath 'danger-run-tests-marker.txt' -Value 'ran'"
      : "printf ran > danger-run-tests-marker.txt";
    const dangerResult = await dangerRuntime.executeManualTool(
      "run_tests",
      { command: dangerCommand },
      fixture.sessionId,
    );
    expect(dangerResult.success, JSON.stringify(dangerResult)).toBe(true);
    expect(await fs.readFile(dangerMarker, "utf8")).toContain("ran");
  }, 30_000);

  it("stops an approved verification subprocess when its parent signal is aborted", async () => {
    const fixture = await createToolFixture({
      network: new FaithfulFakeNetwork([]),
      permissionMode: "danger-full-access",
    });
    const markerPath = path.join(fixture.workspaceRoot, "cancelled-verification-marker.txt");
    const command = process.platform === "win32"
      ? "Start-Sleep -Seconds 10; Set-Content -LiteralPath 'cancelled-verification-marker.txt' -Value 'ran'"
      : "sleep 10; printf ran > cancelled-verification-marker.txt";
    const controller = new AbortController();
    const execution = fixture.runtime.executeManualTool(
      "run_tests",
      { command },
      fixture.sessionId,
      { signal: controller.signal },
    );
    setTimeout(() => controller.abort(new Error("Parent verification was cancelled.")), 100);

    const result = await execution;
    expect(result.success).toBe(false);
    await expect(fs.stat(markerPath)).rejects.toMatchObject({ code: "ENOENT" });
  }, 15_000);
});

describe("phase 16 high-risk network and artifact regressions", () => {
  it("normalizes root-only HTML fragments whose parser root has no tag name", async () => {
    const network = new FaithfulFakeNetwork([{
      headers: { "content-type": "text/html" },
      body: "<!doctype html><p>root-only official documentation</p>",
    }]);
    const fixture = await createToolFixture({ network });

    const result = await fixture.runtime.executeManualTool(
      "web_fetch",
      { url: `${PUBLIC_BASE_URL}/root-only-html` },
      fixture.sessionId,
    );

    expect(result.success, result.output).toBe(true);
    expect(structured<{ format: string; content: string }>(result)).toMatchObject({
      format: "html_markdown",
      content: "root-only official documentation",
    });
  });

  it("rejects CRLF in body.contentType before opening a network route", async () => {
    const network = new FaithfulFakeNetwork([{ body: "must never execute" }]);
    const fixture = await createToolFixture({ network });
    const result = await fixture.runtime.executeManualTool(
      "http_request",
      {
        url: `${PUBLIC_BASE_URL}/header-injection`,
        method: "POST",
        body: {
          kind: "json",
          content: "{}",
          contentType: "application/json\r\nX-Injected: yes",
        },
      },
      fixture.sessionId,
    );

    expect(result.success).toBe(false);
    expect(structured<{ networkErrorType: string }>(result)).toMatchObject({ networkErrorType: "policy_denied" });
    expect(result.output).toContain("content type is invalid");
    expect(network.attempts).toHaveLength(0);
  });

  it("returns POST 302 and GET maxRedirects=0 as terminal responses without replay and redacts Location", async () => {
    const postSecret = "post-location-secret";
    const getSecret = "get-location-secret";
    const postLocation = `${PUBLIC_BASE_URL}/post-target?token=${postSecret}`;
    const getLocation = `${PUBLIC_BASE_URL}/get-target?api_key=${getSecret}`;
    const network = new FaithfulFakeNetwork([
      { status: 302, headers: { location: postLocation }, body: "" },
      { status: 302, headers: { location: getLocation }, body: "" },
    ]);
    const fixture = await createToolFixture({ network });

    const post = await fixture.runtime.executeManualTool(
      "http_request",
      {
        url: `${PUBLIC_BASE_URL}/post-start`,
        method: "POST",
        body: { kind: "json", content: "{}" },
      },
      fixture.sessionId,
    );
    const get = await fixture.runtime.executeManualTool(
      "http_request",
      { url: `${PUBLIC_BASE_URL}/get-start`, method: "GET", maxRedirects: 0 },
      fixture.sessionId,
    );

    for (const [result, initialUrl, secret] of [
      [post, `${PUBLIC_BASE_URL}/post-start`, postSecret],
      [get, `${PUBLIC_BASE_URL}/get-start`, getSecret],
    ] as const) {
      expect(result.success).toBe(true);
      const body = structured<{ status: number; finalUrl: string; headers: Record<string, string> }>(result);
      expect(body).toMatchObject({ status: 302, finalUrl: initialUrl });
      expect(body.headers.location).toContain("%5BREDACTED%5D");
      expect(JSON.stringify(result)).not.toContain(secret);
      expect(result.networkAudit).toMatchObject({ requestCount: 1, redirectCount: 0 });
    }
    expect(network.attempts.map((attempt) => attempt.url)).toEqual([
      `${PUBLIC_BASE_URL}/post-start`,
      `${PUBLIC_BASE_URL}/get-start`,
    ]);
  });

  it("fails closed when a terminal redirect Location exceeds the redaction corpus budget", async () => {
    const terminalSecrets = Array.from(
      { length: 257 },
      (_, index) => `terminal-location-secret-${index.toString().padStart(3, "0")}`,
    );
    const terminalLocation = new URL(`${PUBLIC_BASE_URL}/terminal-target`);
    for (const secret of terminalSecrets) {
      terminalLocation.searchParams.append("token", secret);
    }
    const echoedSecret = terminalSecrets.at(-1)!;
    const network = new FaithfulFakeNetwork([{
      status: 302,
      headers: {
        "content-type": "application/json",
        location: terminalLocation.toString(),
      },
      body: JSON.stringify({ ordinaryField: echoedSecret }),
    }]);
    const fixture = await createToolFixture({ network });

    const result = await fixture.runtime.executeManualTool(
      "http_request",
      { url: `${PUBLIC_BASE_URL}/terminal-over-budget`, method: "GET", maxRedirects: 0 },
      fixture.sessionId,
    );
    const persisted = JSON.stringify({
      result,
      messages: await fixture.sessionStore.loadMessages(fixture.sessionId),
      events: await fixture.sessionStore.loadEvents(fixture.sessionId),
    });

    expect(result.success).toBe(false);
    expect(structured<{ networkErrorType: string }>(result)).toMatchObject({
      networkErrorType: "policy_denied",
    });
    expect(network.attempts).toHaveLength(1);
    expect(persisted).not.toContain(echoedSecret);
    expect(await fixture.sessionStore.listToolOutputArtifacts(fixture.sessionId)).toEqual([]);
  });

  it("redacts session and JWT aliases in malformed failures, results, and long-body artifacts", async () => {
    const secrets = [
      "malformed-session-id-secret-111",
      "malformed-jwt-secret-222",
      "malformed-sid-secret-333",
      "malformed-session-secret-444",
    ];
    const malformedRequest = [
      "{",
      `\"session_id\":\"${secrets[0]}\",`,
      `\"jwt\":\"${secrets[1]}\",`,
      `\"sid\":\"${secrets[2]}\",`,
      `\"session\":\"${secrets[3]}\",`,
      "\"visible\":",
    ].join("");
    const validRequest = JSON.stringify({
      session_id: secrets[0],
      jwt: secrets[1],
      sid: secrets[2],
      session: secrets[3],
      visible: "request-visible",
    });
    const responseBody = JSON.stringify({
      ordinarySessionIdEcho: secrets[0],
      ordinaryJwtEcho: secrets[1],
      ordinarySidEcho: secrets[2],
      ordinarySessionEcho: secrets[3],
      visible: "response-visible",
      padding: "x".repeat(4_000),
    });
    const network = new FaithfulFakeNetwork([{
      headers: { "content-type": "application/json" },
      body: responseBody,
    }]);
    const fixture = await createToolFixture({ network });

    const malformedResult = await fixture.runtime.executeManualTool(
      "http_request",
      {
        url: `${PUBLIC_BASE_URL}/malformed-auth-aliases`,
        method: "POST",
        body: { kind: "json", content: malformedRequest },
      },
      fixture.sessionId,
    );
    expect(malformedResult.success).toBe(false);
    expect(network.attempts).toHaveLength(0);

    const result = await fixture.runtime.executeManualTool(
      "http_request",
      {
        url: `${PUBLIC_BASE_URL}/valid-auth-aliases`,
        method: "POST",
        body: { kind: "json", content: validRequest },
        maxChars: 120,
      },
      fixture.sessionId,
    );
    const output = structured<{ body: string; rawArtifactUri: string; truncated: boolean }>(result);
    expect(result.success, result.output).toBe(true);
    expect(output.truncated).toBe(true);
    expect(output.rawArtifactUri).toMatch(/^artifact:\/\/tool-outputs\//u);
    const artifactBody = await fixture.sessionStore.readTextToolOutputArtifact(output.rawArtifactUri);
    const persisted = JSON.stringify({
      malformedResult,
      result,
      messages: await fixture.sessionStore.loadMessages(fixture.sessionId),
      events: await fixture.sessionStore.loadEvents(fixture.sessionId),
    });

    expect(network.attempts[0]?.body.toString("utf8")).toBe(validRequest);
    expect(artifactBody).toContain("[REDACTED]");
    expect(artifactBody).toContain("response-visible");
    for (const secret of secrets) {
      expect(persisted).not.toContain(secret);
      expect(artifactBody).not.toContain(secret);
    }
  });

  it("keeps JSON request bytes and 64-bit response numbers exact while producing parseable redaction", async () => {
    const responseSecret = "json-response-secret";
    const requestJson = [
      "{",
      '  "id": 9223372036854775807,',
      '  "label": "byte exact",',
      '  "nested": { "spacing": true }',
      "}",
    ].join("\n");
    const responseJson = [
      "{",
      '  "id": 9223372036854775807,',
      `  "token": "${responseSecret}",`,
      '  "visible": "ok"',
      "}",
    ].join("\n");
    const network = new FaithfulFakeNetwork([{
      headers: { "content-type": "application/json" },
      body: responseJson,
    }]);
    const fixture = await createToolFixture({ network });
    const result = await fixture.runtime.executeManualTool(
      "http_request",
      {
        url: `${PUBLIC_BASE_URL}/exact-json?token=${responseSecret}`,
        method: "POST",
        body: { kind: "json", content: requestJson },
      },
      fixture.sessionId,
    );
    const output = structured<{ body: string; bodyFormat: string }>(result);

    expect(result.success).toBe(true);
    expect(network.attempts[0]?.body).toEqual(Buffer.from(requestJson, "utf8"));
    expect(output.bodyFormat).toBe("json");
    expect(output.body).toContain("9223372036854775807");
    expect(output.body).toContain('  "id": 9223372036854775807,');
    expect(output.body).not.toContain(responseSecret);
    expect(JSON.parse(output.body)).toMatchObject({ token: "[REDACTED]", visible: "ok" });
  });

  it("keeps ordinary JSON keys while redacting credential keys without changing 64-bit number tokens", async () => {
    const responseJson = [
      "{",
      '  "author": "Alice",',
      '  "authority": "maintainer",',
      '  "secretary": "office",',
      '  "access_token": "credential-one",',
      '  "accessToken": "credential-two",',
      '  "api_key": "credential-three",',
      '  "id": 18446744073709551615',
      "}",
    ].join("\n");
    const network = new FaithfulFakeNetwork([{
      headers: { "content-type": "application/json" },
      body: responseJson,
    }]);
    const fixture = await createToolFixture({ network });
    const result = await fixture.runtime.executeManualTool(
      "http_request",
      { url: `${PUBLIC_BASE_URL}/json-key-boundaries`, method: "GET" },
      fixture.sessionId,
    );
    const body = structured<{ body: string }>(result).body;

    expect(result.success).toBe(true);
    expect(body).toContain('"author": "Alice"');
    expect(body).toContain('"authority": "maintainer"');
    expect(body).toContain('"secretary": "office"');
    expect(body).toContain("18446744073709551615");
    expect(JSON.parse(body)).toMatchObject({
      author: "Alice",
      authority: "maintainer",
      secretary: "office",
      access_token: "[REDACTED]",
      accessToken: "[REDACTED]",
      api_key: "[REDACTED]",
    });
    expect(body).not.toContain("credential-one");
    expect(body).not.toContain("credential-two");
    expect(body).not.toContain("credential-three");
  });

  it("preserves Markdown fenced code, indented code, nested-list indentation, and literal blank lines", async () => {
    const markdownWithCrLf = [
      "\ufeff# Literal Markdown",
      "",
      "```ts",
      "  const preserved = true;",
      "```",
      "",
      "    indented code",
      "",
      "- outer",
      "  - nested",
      "    continuation",
      "",
      "Trailing spaces stay.  ",
      "",
    ].join("\r\n");
    const expected = markdownWithCrLf.replace(/^\ufeff/u, "").replace(/\r\n/gu, "\n");
    const network = new FaithfulFakeNetwork([{
      headers: { "content-type": "text/markdown" },
      body: markdownWithCrLf,
    }]);
    const fixture = await createToolFixture({ network });
    const result = await fixture.runtime.executeManualTool(
      "web_fetch",
      { url: `${PUBLIC_BASE_URL}/literal.md` },
      fixture.sessionId,
    );

    expect(result.success).toBe(true);
    expect(structured<{ format: string; content: string }>(result)).toMatchObject({
      format: "markdown",
      content: expected,
    });
  });

  it("redacts redirect-introduced query secrets from final URL, title, body, headers, citations, and audit", async () => {
    const secret = "redirect secret+/%";
    const target = new URL(`${PUBLIC_BASE_URL}/redirect-final`);
    target.searchParams.set("token", secret);
    const percentEncoded = encodeURIComponent(secret);
    const lowerPercentEncoded = percentEncoded.replace(/%[\dA-F]{2}/gu, (match) => match.toLocaleLowerCase());
    const formEncoded = new URLSearchParams({ value: secret }).toString().slice("value=".length);
    const variants = [...new Set([secret, percentEncoded, lowerPercentEncoded, formEncoded])];
    const echoed = variants.join(" | ");
    const network = new FaithfulFakeNetwork([
      { status: 302, headers: { location: target.toString() }, body: "" },
      {
        headers: { "content-type": "text/html", "x-request-id": echoed },
        body: `<html><head><title>${echoed}</title></head><body><main><pre>${echoed}</pre></main></body></html>`,
      },
    ]);
    const fixture = await createToolFixture({ network });
    const result = await fixture.runtime.executeManualTool(
      "web_fetch",
      { url: `${PUBLIC_BASE_URL}/redirect-start` },
      fixture.sessionId,
    );
    const output = structured<{
      title: string;
      content: string;
      finalUrl: string;
      citation: { title: string; url: string };
      response: { headers: Record<string, string>; redirects: Array<{ toUrl: string }> };
    }>(result);

    expect(result.success).toBe(true);
    const persisted = JSON.stringify({ output, audit: result.networkAudit });
    for (const variant of variants) expect(persisted).not.toContain(variant);
    expect(output.finalUrl).toContain("%5BREDACTED%5D");
    expect(output.title).toContain("[REDACTED]");
    expect(output.content).toContain("[REDACTED]");
    expect(output.citation.title).toContain("[REDACTED]");
    expect(output.citation.url).toBe(output.finalUrl);
    expect(output.response.headers["x-request-id"]).toContain("[REDACTED]");
    expect(output.response.redirects[0]?.toUrl).toContain("%5BREDACTED%5D");
    expect(result.networkAudit).toMatchObject({ requestCount: 2, redirectCount: 1 });
  });

  it("redacts redirect-introduced path credentials from long content, artifacts, audit, and Governor history", async () => {
    const tokenSecret = "REDIRECT-PATH-TOKEN-749318";
    const signatureSecret = "REDIRECT-PATH-SIGNATURE-927451";
    const targetUrl = `${PUBLIC_BASE_URL}/token/${tokenSecret}/file/sig=${signatureSecret}/download`;
    const longBody = [
      `token echo: ${tokenSecret}`,
      `signature echo: ${signatureSecret}`,
      "visible response content",
      "x".repeat(6_000),
      `late token echo: ${tokenSecret}`,
      `late signature echo: ${signatureSecret}`,
    ].join("\n");
    const call: ToolCall = {
      id: "phase16-redirect-path-credentials",
      name: "web_fetch",
      arguments: { url: `${PUBLIC_BASE_URL}/redirect-path-start`, maxChars: 180 },
      rawArguments: JSON.stringify({ url: `${PUBLIC_BASE_URL}/redirect-path-start`, maxChars: 180 }),
    };
    const network = new FaithfulFakeNetwork([
      { status: 302, headers: { location: targetUrl }, body: "" },
      { headers: { "content-type": "text/plain" }, body: longBody },
    ]);
    const workspaceRoot = await fs.mkdtemp(path.join(os.tmpdir(), "deep-mix-phase16-redirect-path-"));
    temporaryRoots.push(workspaceRoot);
    const toolResults: ToolResult[] = [];
    const governor = new GovernorRuntime({
      workspaceRoot,
      permissionMode: "danger-full-access",
      modelClient: new ScriptedModelClient([
        { content: "", toolCalls: [call] },
        { content: "The redirected content was handled safely.", toolCalls: [] },
      ]),
      networkService: network,
      environment: { ...process.env, BRAVE_SEARCH_API_KEY: undefined },
    });
    const turn = await governor.runTurn({
      prompt: "Use web_fetch to fetch URL content from the declared endpoint and summarize it.",
      routeOverride: "ds_direct",
      callbacks: { onToolEnd: (result) => toolResults.push(result) },
    });
    const sessionStore = new SessionStore(workspaceRoot);
    const result = toolResults.find((candidate) => candidate.toolName === "web_fetch");
    expect(result).toBeDefined();
    const output = structured<{
      content: string;
      finalUrl: string;
      truncated: boolean;
      rawArtifactUri: string;
      response: { redirects: Array<{ fromUrl: string; toUrl: string }> };
    }>(result!);
    expect(result!.success, JSON.stringify(result)).toBe(true);
    expect(output.rawArtifactUri, JSON.stringify(result)).toMatch(/^artifact:\/\/tool-outputs\//u);
    const artifactText = await sessionStore.readTextToolOutputArtifact(output.rawArtifactUri);
    const persisted = JSON.stringify({
      messages: await sessionStore.loadMessages(turn.sessionId),
      events: await sessionStore.loadEvents(turn.sessionId),
    });

    expect(network.attempts).toHaveLength(2);
    expect(network.attempts[1]?.url).toContain(tokenSecret);
    expect(network.attempts[1]?.url).toContain(signatureSecret);
    expect(output.truncated).toBe(true);
    expect(output.response.redirects).toHaveLength(1);
    expect(output.finalUrl).toContain("[REDACTED]");
    expect(output.response.redirects[0]?.toUrl).toContain("[REDACTED]");
    expect(output.content).toContain("[REDACTED]");
    expect(artifactText).toContain("[REDACTED]");
    expect(result!.networkAudit).toMatchObject({ requestCount: 2, redirectCount: 1 });
    for (const secret of [tokenSecret, signatureSecret]) {
      expect(output.finalUrl).not.toContain(secret);
      expect(JSON.stringify(output.response.redirects)).not.toContain(secret);
      expect(output.content).not.toContain(secret);
      expect(artifactText).not.toContain(secret);
      expect(JSON.stringify(result!.networkAudit)).not.toContain(secret);
      expect(JSON.stringify(result)).not.toContain(secret);
      expect(persisted).not.toContain(secret);
    }
  }, 30_000);

  it("redacts initial path credentials from failed output and persisted Governor history", async () => {
    const tokenSecret = "INITIAL-PATH-TOKEN-749318";
    const signatureSecret = "INITIAL-PATH-SIGNATURE-927451";
    const initialUrl = `${PUBLIC_BASE_URL}/token/${tokenSecret}/file/sig=${signatureSecret}/failure`;
    const call: ToolCall = {
      id: "phase16-initial-path-failure",
      name: "web_fetch",
      arguments: { url: initialUrl },
      rawArguments: JSON.stringify({ url: initialUrl }),
    };
    const network = new FaithfulFakeNetwork([{
      errorBeforeResponse: Object.assign(new Error(`Connection failed for ${initialUrl}`), { code: "ECONNRESET" }),
    }]);
    const workspaceRoot = await fs.mkdtemp(path.join(os.tmpdir(), "deep-mix-phase16-initial-path-failure-"));
    temporaryRoots.push(workspaceRoot);
    const hookCalls: ToolCall[] = [];
    const toolResults: ToolResult[] = [];
    const governor = new GovernorRuntime({
      workspaceRoot,
      permissionMode: "danger-full-access",
      modelClient: new ScriptedModelClient([
        { content: "", toolCalls: [call] },
        { content: "The fetch failed safely.", toolCalls: [] },
      ]),
      networkService: network,
      environment: { ...process.env, BRAVE_SEARCH_API_KEY: undefined },
    });
    const turn = await governor.runTurn({
      prompt: "Use web_fetch to fetch URL content from the declared endpoint and report the result.",
      routeOverride: "ds_direct",
      callbacks: {
        onToolStart: (toolCall) => hookCalls.push(toolCall),
        onToolEnd: (result) => toolResults.push(result),
      },
    });
    const sessionStore = new SessionStore(workspaceRoot);
    const result = toolResults.find((candidate) => candidate.toolName === "web_fetch");
    expect(result).toBeDefined();
    const persisted = JSON.stringify({
      hooks: hookCalls,
      results: toolResults,
      messages: await sessionStore.loadMessages(turn.sessionId),
      events: await sessionStore.loadEvents(turn.sessionId),
    });

    expect(network.attempts, JSON.stringify({ result, hookCalls, toolResults })).toHaveLength(1);
    expect(network.attempts[0]?.url).toContain(tokenSecret);
    expect(network.attempts[0]?.url).toContain(signatureSecret);
    expect(result!.success).toBe(false);
    expect(structured<{ networkErrorType: string }>(result!)).toMatchObject({ networkErrorType: "connection" });
    const safeHookUrl = (hookCalls[0]?.arguments as { url?: string } | undefined)?.url;
    expect(safeHookUrl).toContain("REDACTED");
    for (const secret of [tokenSecret, signatureSecret]) {
      expect(JSON.stringify(result)).not.toContain(secret);
      expect(persisted).not.toContain(secret);
    }
    expect(await sessionStore.loadProtectedToolCall(turn.sessionId, call.id)).toBeUndefined();
  }, 30_000);

  it("redacts Cookie/Auth fragments, short values, and percent/form-encoded variants", async () => {
    const cookieSecret = "m n";
    const shortSecret = "Q7";
    const authSecret = "A/B+";
    const variants = [...new Set([
      cookieSecret,
      encodeURIComponent(cookieSecret),
      new URLSearchParams({ value: cookieSecret }).toString().slice("value=".length),
      shortSecret,
      authSecret,
      encodeURIComponent(authSecret),
      new URLSearchParams({ value: authSecret }).toString().slice("value=".length),
    ])];
    const echoed = variants.join(" | ");
    const network = new FaithfulFakeNetwork([{
      headers: { "content-type": "text/plain", "x-request-id": echoed },
      body: echoed,
    }]);
    const fixture = await createToolFixture({ network });
    const result = await fixture.runtime.executeManualTool(
      "http_request",
      {
        url: `${PUBLIC_BASE_URL}/credential-echo`,
        method: "GET",
        headers: {
          Cookie: `sid="${cookieSecret}"; short=${shortSecret}`,
          Authorization: `Bearer ${authSecret}`,
        },
      },
      fixture.sessionId,
    );
    const output = structured<{ body: string; headers: Record<string, string> }>(result);

    expect(result.success).toBe(true);
    const persisted = JSON.stringify(result);
    for (const variant of variants) expect(persisted).not.toContain(variant);
    expect(output.body).toContain("[REDACTED]");
    expect(output.headers["x-request-id"]).toContain("[REDACTED]");
  });

  it("keeps sensitive approval arguments protected while waiting and restores the original call after approval", async () => {
    const secrets = ["approval-url-secret", "approval-header-secret", "approval-body-secret"];
    const args = {
      url: `${PUBLIC_BASE_URL}/approval?token=${secrets[0]}`,
      method: "POST" as const,
      headers: { Authorization: `Bearer ${secrets[1]}` },
      body: {
        kind: "json" as const,
        content: `{\n  "token": "${secrets[2]}",\n  "id": 9223372036854775807\n}`,
      },
    };
    const call: ToolCall = {
      id: "phase16-sensitive-approval",
      name: "http_request",
      rawArguments: JSON.stringify(args),
      arguments: args,
    };
    const network = new FaithfulFakeNetwork([{
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ ok: true, token: secrets[2] }),
    }]);
    const modelClient = new ScriptedModelClient([
      { content: "", toolCalls: [call] },
      { content: "Approved request completed.", toolCalls: [] },
    ]);
    const workspaceRoot = await fs.mkdtemp(path.join(os.tmpdir(), "deep-mix-phase16-sensitive-approval-"));
    temporaryRoots.push(workspaceRoot);
    const governor = new GovernorRuntime({
      workspaceRoot,
      permissionMode: "auto",
      modelClient,
      networkService: network,
      environment: { ...process.env, BRAVE_SEARCH_API_KEY: undefined },
    });
    let sessionId = "";
    const hookCalls: ToolCall[] = [];
    await expect(governor.runTurn({
      prompt: "Send an API request with the HTTP request tool now; do not write code.",
      routeOverride: "ds_direct",
      callbacks: {
        onSessionSelected: (selected) => { sessionId = selected; },
        onToolStart: (toolCall) => hookCalls.push(toolCall),
      },
    })).rejects.toBeInstanceOf(PermissionRequiredError);
    expect(network.attempts).toHaveLength(0);

    const sessionStore = new SessionStore(workspaceRoot);
    const protectedCall = await sessionStore.loadProtectedToolCall(sessionId, call.id);
    expect(protectedCall).toEqual(call);
    const persistedBeforeApproval = JSON.stringify({
      messages: await sessionStore.loadMessages(sessionId),
      events: await sessionStore.loadEvents(sessionId),
      hooks: hookCalls,
    });
    for (const secret of secrets) expect(persistedBeforeApproval).not.toContain(secret);
    const pending = [...await sessionStore.loadEvents(sessionId)].reverse().find(
      (event) => event.recordType === "approval" && event.status === "pending",
    );
    if (!pending || pending.recordType !== "approval") throw new Error("Missing sensitive approval fixture.");
    await governor.resolveApprovalRequest({
      sessionId,
      approvalId: pending.approvalId,
      toolName: pending.toolName,
      requestKey: pending.requestKey,
      persistence: "allow_once",
      reason: "Phase 16 sensitive approval regression.",
    });
    const continuationHooks: ToolCall[] = [];
    const completed = await governor.continuePendingTurn({
      sessionId,
      routeOverride: "ds_direct",
      callbacks: { onToolStart: (toolCall) => continuationHooks.push(toolCall) },
    });

    expect(completed.finalResponse).toBe("Approved request completed.");
    expect(network.attempts).toHaveLength(1);
    expect(network.attempts[0]?.headers.authorization).toBe(`Bearer ${secrets[1]}`);
    expect(network.attempts[0]?.body).toEqual(Buffer.from(args.body.content, "utf8"));
    expect(await sessionStore.loadProtectedToolCall(sessionId, call.id)).toBeUndefined();
    const persistedAfterApproval = JSON.stringify({
      messages: await sessionStore.loadMessages(sessionId),
      events: await sessionStore.loadEvents(sessionId),
      hooks: continuationHooks,
    });
    for (const secret of secrets) expect(persistedAfterApproval).not.toContain(secret);
    expect(persistedAfterApproval).toContain("[REDACTED]");
  }, 30_000);

  it("retains completed network audit and removes committed files when artifact recording fails", async () => {
    const body = `# Persistence failure\n\n${"full response ".repeat(500)}`;
    const network = new FaithfulFakeNetwork([{
      headers: { "content-type": "text/markdown" },
      body,
    }]);
    const fixture = await createToolFixture({ network });
    fixture.sessionStore.recordToolOutputArtifact = async () => {
      throw new Error("simulated artifact record failure");
    };
    const result = await fixture.runtime.executeManualTool(
      "web_fetch",
      { url: `${PUBLIC_BASE_URL}/record-failure`, maxChars: 20 },
      fixture.sessionId,
    );

    expect(result.success).toBe(false);
    expect(result.networkAudit).toMatchObject({ requestCount: 1, status: 200, bytesReceived: Buffer.byteLength(body) });
    expect(executionAudits(await fixture.sessionStore.loadEvents(fixture.sessionId)).at(-1)?.network)
      .toEqual(result.networkAudit);
    expect(await fixture.sessionStore.listToolOutputArtifacts(fixture.sessionId)).toEqual([]);
    expect(await listRegularFiles(path.join(fixture.workspaceRoot, ".deep-mix", "tool-outputs"))).toEqual([]);
  });

  it("enforces the same deadline after networking while waiting to persist a long-body artifact", async () => {
    const body = `# Deadline\n\n${"deadline body ".repeat(500)}`;
    const network = new FaithfulFakeNetwork([{
      headers: { "content-type": "text/markdown" },
      body,
    }]);
    const fixture = await createToolFixture({ network });
    const originalStore = fixture.sessionStore.storeToolOutputArtifact.bind(fixture.sessionStore);
    fixture.sessionStore.storeToolOutputArtifact = async (input) => {
      await new Promise<void>((resolve) => setTimeout(resolve, 160));
      input.signal?.throwIfAborted();
      return originalStore(input);
    };
    const result = await fixture.runtime.executeManualTool(
      "web_fetch",
      { url: `${PUBLIC_BASE_URL}/artifact-deadline`, maxChars: 20, timeoutMs: 100 },
      fixture.sessionId,
    );

    expect(result.success).toBe(false);
    expect(structured<{ networkErrorType: string }>(result)).toMatchObject({ networkErrorType: "timeout" });
    expect(result.networkAudit).toMatchObject({ requestCount: 1, status: 200, bytesReceived: Buffer.byteLength(body) });
    expect(await fixture.sessionStore.listToolOutputArtifacts(fixture.sessionId)).toEqual([]);
    expect(await listRegularFiles(path.join(fixture.workspaceRoot, ".deep-mix", "tool-outputs"))).toEqual([]);
  });

  it("publishes concurrent same-name downloads to distinct URIs whose bytes and hashes remain paired", async () => {
    const payloads = new Map([
      ["/concurrent-a.pdf", Buffer.from("%PDF-1.7\nconcurrent-A\n%%EOF\n")],
      ["/concurrent-b.pdf", Buffer.from("%PDF-1.7\nconcurrent-B-different\n%%EOF\n")],
    ]);
    const responder = (attempt: FakeAttempt): FakeReply => ({
      headers: { "content-type": "application/pdf" },
      body: payloads.get(new URL(attempt.url).pathname)!,
    });
    const network = new FaithfulFakeNetwork([responder, responder]);
    const fixture = await createToolFixture({ network });
    const [first, second] = await Promise.all([
      fixture.runtime.executeManualTool(
        "download_file",
        { url: `${PUBLIC_BASE_URL}/concurrent-a.pdf`, outputName: "same.pdf" },
        fixture.sessionId,
      ),
      fixture.runtime.executeManualTool(
        "download_file",
        { url: `${PUBLIC_BASE_URL}/concurrent-b.pdf`, outputName: "same.pdf" },
        fixture.sessionId,
      ),
    ]);
    const outputs = [first, second].map((result) => structured<{
      sourceUrl: string;
      artifactUri: string;
      fileName: string;
      sha256: string;
      sizeBytes: number;
    }>(result));

    expect(first.success).toBe(true);
    expect(second.success).toBe(true);
    expect(new Set(outputs.map((output) => output.artifactUri)).size).toBe(2);
    expect(new Set(outputs.map((output) => output.fileName)).size).toBe(2);
    for (const output of outputs) {
      const expected = payloads.get(new URL(output.sourceUrl).pathname)!;
      const persisted = await fixture.sessionStore.readBinaryToolOutputArtifact(output.artifactUri);
      expect(persisted).toEqual(expected);
      expect(output.sizeBytes).toBe(expected.byteLength);
      expect(output.sha256).toBe(createHash("sha256").update(expected).digest("hex"));
      expect(createHash("sha256").update(persisted).digest("hex")).toBe(output.sha256);
    }
  });

  it("redacts a redirect-introduced secret when the second-hop transport error echoes it", async () => {
    const secret = "redirect-secret";
    const toolCall: ToolCall = {
      id: "phase16-redirect-error-call",
      name: "http_request",
      arguments: { url: `${PUBLIC_BASE_URL}/redirect-error-start`, method: "GET" },
      rawArguments: JSON.stringify({ url: `${PUBLIC_BASE_URL}/redirect-error-start`, method: "GET" }),
    };
    const network = new FaithfulFakeNetwork([
      {
        status: 302,
        headers: { location: `${PUBLIC_BASE_URL}/redirect-error-next?token=${secret}` },
        body: "",
      },
      { errorBeforeResponse: new Error(`unexpected ${secret}`) },
    ]);
    const workspaceRoot = await fs.mkdtemp(path.join(os.tmpdir(), "deep-mix-phase16-redirect-error-"));
    temporaryRoots.push(workspaceRoot);
    const toolResults: ToolResult[] = [];
    const governor = new GovernorRuntime({
      workspaceRoot,
      permissionMode: "danger-full-access",
      modelClient: new ScriptedModelClient([
        { content: "", toolCalls: [toolCall] },
        { content: "The guarded request failed safely.", toolCalls: [] },
      ]),
      networkService: network,
      environment: { ...process.env, BRAVE_SEARCH_API_KEY: undefined },
    });
    const turn = await governor.runTurn({
      prompt: "Send an API request with the HTTP request tool now and report the response; do not write code.",
      routeOverride: "ds_direct",
      callbacks: { onToolEnd: (result) => toolResults.push(result) },
    });
    const result = toolResults.find((candidate) => candidate.callId === toolCall.id);
    if (!result) throw new Error("Missing redirect-error tool result.");

    expect(result.success).toBe(false);
    expect(network.attempts).toHaveLength(2);
    expect(result.networkAudit).toMatchObject({
      requestCount: 2,
      redirectCount: 1,
      errorType: "connection",
    });
    expect(JSON.stringify({
      output: result.output,
      error: result.error,
      structuredContent: result.structuredContent,
      audit: result.networkAudit,
    })).not.toContain(secret);
    const sessionStore = new SessionStore(workspaceRoot);
    const persisted = JSON.stringify({
      messages: await sessionStore.loadMessages(turn.sessionId),
      events: await sessionStore.loadEvents(turn.sessionId),
    });
    expect(persisted).not.toContain(secret);
    expect(persisted).toContain("[REDACTED]");
  }, 30_000);

  it("redacts malformed network arguments before schema validation", async () => {
    const secrets = Array.from(
      { length: 40 },
      (_, index) => `malformed-secret-${index.toString().padStart(2, "0")}-tail`,
    );
    const calls: ToolCall[] = [
      {
        id: "phase16-malformed-scalars",
        name: "http_request",
        arguments: {
          url: `${PUBLIC_BASE_URL}/malformed-scalars`,
          method: "POST",
          headers: secrets[0],
          query: secrets[1],
          body: secrets[2],
          unknownTopLevel: secrets[3],
        },
        rawArguments: "",
      },
      {
        id: "phase16-malformed-nested",
        name: "http_request",
        arguments: {
          url: `${PUBLIC_BASE_URL}/malformed-nested`,
          method: "POST",
          headers: {
            Authorization: { nested: secrets[4] },
            "x-array": [secrets[5]],
            "x-visible": "safe",
          },
          query: {
            token: { nested: secrets[6] },
            visible: [secrets[7]],
          },
          body: {
            kind: { nested: secrets[8] },
            content: { nested: secrets[9] },
            contentType: { nested: secrets[10] },
          },
          anotherUnknown: { nested: secrets[11] },
        },
        rawArguments: "",
      },
      {
        id: "phase16-malformed-all-allowlisted",
        name: "http_request",
        arguments: Object.fromEntries([
          "body",
          "expectedContentTypes",
          "headers",
          "maxBytes",
          "maxChars",
          "maxRedirects",
          "maxResponseBytes",
          "method",
          "outputName",
          "overwriteStrategy",
          "query",
          "target",
          "timeoutMs",
          "url",
          "workspacePath",
        ].map((field, index) => [field, { nested: secrets[12 + index] }])),
        rawArguments: "",
      },
    ].map((call) => ({ ...call, rawArguments: JSON.stringify(call.arguments) }));
    const network = new FaithfulFakeNetwork([]);
    const fixture = await createToolFixture({ network });

    for (const call of calls) {
      const safeCall = fixture.runtime.redactToolCallForPersistence(call);
      const safeSerialized = JSON.stringify(safeCall);
      for (const secret of secrets) expect(safeSerialized).not.toContain(secret);
      expect(JSON.parse(safeCall.rawArguments)).toEqual(safeCall.arguments);

      const result = await fixture.runtime.executeTool(call, fixture.sessionId);
      expect(result.success).toBe(false);
      expect(structured<{ error: { type: string } }>(result)).toMatchObject({
        error: { type: "invalid_arguments" },
      });
    }

    expect(network.attempts).toHaveLength(0);
  });

  it("redacts secrets embedded in top-level, header, and query key names before history persistence", async () => {
    const secret = "KEY_NAME_SECRET";
    const args = {
      url: `${PUBLIC_BASE_URL}/secret-key-names`,
      method: "GET",
      headers: { [`x-${secret}`]: "visible-header-value" },
      query: { [`filter-${secret}`]: "visible-query-value" },
      [`unknown-${secret}`]: "visible-top-level-value",
    };
    const call: ToolCall = {
      id: "phase16-secret-key-names",
      name: "http_request",
      arguments: args,
      rawArguments: JSON.stringify(args),
    };
    const network = new FaithfulFakeNetwork([]);
    const workspaceRoot = await fs.mkdtemp(path.join(os.tmpdir(), "deep-mix-phase16-secret-key-names-"));
    temporaryRoots.push(workspaceRoot);
    const hookCalls: ToolCall[] = [];
    const governor = new GovernorRuntime({
      workspaceRoot,
      permissionMode: "danger-full-access",
      modelClient: new ScriptedModelClient([
        { content: "", toolCalls: [call] },
        { content: "The malformed call was rejected safely.", toolCalls: [] },
      ]),
      networkService: network,
      environment: { ...process.env, BRAVE_SEARCH_API_KEY: undefined },
    });
    const turn = await governor.runTurn({
      prompt: "Send an HTTP API request now; do not write code.",
      routeOverride: "ds_direct",
      callbacks: { onToolStart: (toolCall) => hookCalls.push(toolCall) },
    });
    const sessionStore = new SessionStore(workspaceRoot);
    const persisted = JSON.stringify({
      hooks: hookCalls,
      messages: await sessionStore.loadMessages(turn.sessionId),
      events: await sessionStore.loadEvents(turn.sessionId),
    });

    expect(persisted).not.toContain(secret);
    expect(network.attempts).toHaveLength(0);
  }, 30_000);

  it("rejects missing, mismatched, duplicate, and concurrent approval resolutions", async () => {
    const network = new FaithfulFakeNetwork([{ body: "must not execute while approval is pending" }]);
    const fixture = await createToolFixture({ network, permissionMode: "auto" });
    let pending: PermissionRequiredError | undefined;
    try {
      await fixture.runtime.executeManualTool(
        "http_request",
        {
          url: `${PUBLIC_BASE_URL}/approval-resolution`,
          method: "POST",
          body: { kind: "json", content: "{}" },
        },
        fixture.sessionId,
      );
    } catch (error) {
      if (!(error instanceof PermissionRequiredError)) throw error;
      pending = error;
    }
    if (!pending) throw new Error("Expected a pending approval fixture.");
    const resolution = {
      sessionId: fixture.sessionId,
      approvalId: pending.approvalId,
      toolName: pending.toolName,
      requestKey: pending.requestKey,
      persistence: "allow_once" as const,
      reason: "Phase 16 approval state-machine regression.",
    };

    await expect(fixture.runtime.resolveApproval({
      ...resolution,
      approvalId: `missing-${pending.approvalId}`,
    })).rejects.toThrow(/not pending/iu);
    await expect(fixture.runtime.resolveApproval({
      ...resolution,
      toolName: "web_fetch",
    })).rejects.toThrow(/does not match/iu);
    await expect(fixture.runtime.resolveApproval({
      ...resolution,
      requestKey: `${pending.requestKey}-mismatch`,
    })).rejects.toThrow(/does not match/iu);

    const concurrent = await Promise.allSettled([
      fixture.runtime.resolveApproval(resolution),
      fixture.runtime.resolveApproval(resolution),
    ]);
    expect(concurrent.filter((result) => result.status === "fulfilled")).toHaveLength(1);
    expect(concurrent.filter((result) => result.status === "rejected")).toHaveLength(1);
    const concurrentFailure = concurrent.find((result) => result.status === "rejected");
    if (!concurrentFailure || concurrentFailure.status !== "rejected") {
      throw new Error("Missing concurrent approval rejection.");
    }
    expect(String(concurrentFailure.reason)).toMatch(/already being resolved|not pending/iu);
    await expect(fixture.runtime.resolveApproval(resolution)).rejects.toThrow(/not pending/iu);

    const matchingRecords = (await fixture.sessionStore.loadEvents(fixture.sessionId)).filter(
      (event) => event.recordType === "approval" &&
        event.approvalId === pending?.approvalId &&
        event.status === "resolved",
    );
    expect(matchingRecords).toHaveLength(1);
    expect(network.attempts).toHaveLength(0);
  });

  it("consumes allow_once atomically so concurrent identical POST calls execute only once", async () => {
    const network = new FaithfulFakeNetwork([
      { headers: { "content-type": "application/json" }, body: '{"ok":true}' },
      { headers: { "content-type": "application/json" }, body: '{"unexpected":true}' },
    ]);
    const fixture = await createToolFixture({ network, permissionMode: "auto" });
    const args = {
      url: `${PUBLIC_BASE_URL}/allow-once-atomic`,
      method: "POST" as const,
      body: { kind: "json" as const, content: '{"operation":"once"}' },
    };
    let pending: PermissionRequiredError | undefined;
    try {
      await fixture.runtime.executeManualTool("http_request", args, fixture.sessionId);
    } catch (error) {
      if (!(error instanceof PermissionRequiredError)) throw error;
      pending = error;
    }
    if (!pending) throw new Error("Expected an allow-once approval fixture.");
    await fixture.runtime.resolveApproval({
      sessionId: fixture.sessionId,
      approvalId: pending.approvalId,
      toolName: pending.toolName,
      requestKey: pending.requestKey,
      persistence: "allow_once",
      reason: "Phase 16 atomic allow-once regression.",
    });

    const concurrent = await Promise.allSettled([
      fixture.runtime.executeManualTool("http_request", args, fixture.sessionId),
      fixture.runtime.executeManualTool("http_request", args, fixture.sessionId),
    ]);
    const fulfilled = concurrent.filter(
      (result): result is PromiseFulfilledResult<ToolResult> => result.status === "fulfilled",
    );
    const rejected = concurrent.filter(
      (result): result is PromiseRejectedResult => result.status === "rejected",
    );

    expect(fulfilled).toHaveLength(1);
    expect(fulfilled[0]?.value.success).toBe(true);
    expect(rejected).toHaveLength(1);
    expect(rejected[0]?.reason).toBeInstanceOf(PermissionRequiredError);
    expect(network.attempts).toHaveLength(1);
  });

  it("claims one allow_once grant exactly once across independent Node processes", async () => {
    const workspaceRoot = await fs.mkdtemp(path.join(os.tmpdir(), "deep-mix-phase16-approval-processes-"));
    temporaryRoots.push(workspaceRoot);
    const store = new SessionStore(workspaceRoot);
    await store.ensureInitialized();
    const session = await store.createSession("phase16 cross-process allow_once claim");
    const requestKey = "http_request:hmac-sha256:phase16-cross-process-claim";
    const approvalId = "phase16-cross-process-approval";
    await store.saveApprovalGrant({
      approvalId,
      sessionId: session.sessionId,
      toolName: "http_request",
      permissionCategory: "external_system",
      requestKey,
      decision: "allow",
      persistence: "allow_once",
      createdAt: new Date().toISOString(),
      reason: "Phase 16 cross-process approval claim regression.",
      remainingUses: 1,
    });

    const barrierRoot = path.join(workspaceRoot, "approval-claim-barrier");
    const releasePath = `${barrierRoot}.release`;
    const persistenceModuleUrl = pathToFileURL(
      path.resolve(process.cwd(), "packages/persistence/src/index.ts"),
    ).href;
    const workerSource = `
      import { promises as fs } from "node:fs";
      import { SessionStore } from ${JSON.stringify(persistenceModuleUrl)};
      const required = (name) => {
        const value = process.env[name];
        if (!value) throw new Error("Missing " + name);
        return value;
      };
      const readyPath = required("PHASE16_READY_PATH");
      const releasePath = required("PHASE16_RELEASE_PATH");
      await fs.writeFile(readyPath, "ready", "utf8");
      const deadline = Date.now() + 10_000;
      for (;;) {
        try {
          await fs.access(releasePath);
          break;
        } catch (error) {
          if (Date.now() >= deadline) throw new Error("Timed out waiting for claim barrier.");
          await new Promise((resolve) => setTimeout(resolve, 10));
        }
      }
      const store = new SessionStore(required("PHASE16_WORKSPACE_ROOT"));
      const grant = await store.claimApprovalGrant(
        required("PHASE16_SESSION_ID"),
        required("PHASE16_REQUEST_KEY"),
      );
      process.stdout.write(JSON.stringify({
        workerId: required("PHASE16_WORKER_ID"),
        claimed: Boolean(grant),
        approvalId: grant?.approvalId,
      }));
    `;
    const readyPaths = ["one", "two"].map((workerId) => `${barrierRoot}.${workerId}.ready`);
    const workerOutcomes = ["one", "two"].map((workerId, index) => {
      const child = spawn(
        process.execPath,
        ["--import", "tsx", "--input-type=module", "--eval", workerSource],
        {
          cwd: process.cwd(),
          env: {
            ...process.env,
            PHASE16_WORKSPACE_ROOT: workspaceRoot,
            PHASE16_SESSION_ID: session.sessionId,
            PHASE16_REQUEST_KEY: requestKey,
            PHASE16_WORKER_ID: workerId,
            PHASE16_READY_PATH: readyPaths[index],
            PHASE16_RELEASE_PATH: releasePath,
          },
          stdio: ["ignore", "pipe", "pipe"],
        },
      );
      return new Promise<{ workerId: string; claimed: boolean; approvalId?: string }>((resolve, reject) => {
        let stdout = "";
        let stderr = "";
        child.stdout.setEncoding("utf8");
        child.stderr.setEncoding("utf8");
        child.stdout.on("data", (chunk: string) => { stdout += chunk; });
        child.stderr.on("data", (chunk: string) => { stderr += chunk; });
        child.once("error", reject);
        child.once("close", (code) => {
          if (code !== 0) {
            reject(new Error(`Approval worker ${workerId} exited ${code}: ${stderr}`));
            return;
          }
          try {
            resolve(JSON.parse(stdout) as { workerId: string; claimed: boolean; approvalId?: string });
          } catch (error) {
            reject(new Error(`Approval worker ${workerId} returned invalid JSON: ${stdout}`, { cause: error }));
          }
        });
      });
    });

    const readyDeadline = Date.now() + 10_000;
    for (;;) {
      const ready = await Promise.all(readyPaths.map((readyPath) => fs.access(readyPath).then(
        () => true,
        () => false,
      )));
      if (ready.every(Boolean)) break;
      if (Date.now() >= readyDeadline) throw new Error("Timed out waiting for approval claim workers.");
      await new Promise((resolve) => setTimeout(resolve, 10));
    }
    await fs.writeFile(releasePath, "release", "utf8");
    const outcomes = await Promise.all(workerOutcomes);

    expect(outcomes.map((outcome) => outcome.workerId).sort()).toEqual(["one", "two"]);
    expect(outcomes.filter((outcome) => outcome.claimed)).toHaveLength(1);
    expect(outcomes.filter((outcome) => !outcome.claimed)).toHaveLength(1);
    expect(outcomes.find((outcome) => outcome.claimed)?.approvalId).toBe(approvalId);
    expect(await store.loadApprovalGrant(session.sessionId, requestKey)).toBeUndefined();
    await expect(fs.stat(path.join(workspaceRoot, ".deep-mix", "approval-state.json.lock")))
      .rejects.toMatchObject({ code: "ENOENT" });
  }, 30_000);

  it("reuses a completed POST journal after tool-message append and protected cleanup faults", async () => {
    const network = new FaithfulFakeNetwork([
      { headers: { "content-type": "application/json" }, body: '{"committed":true}' },
      { headers: { "content-type": "application/json" }, body: '{"replayed":true}' },
    ]);
    const workspaceRoot = await fs.mkdtemp(path.join(os.tmpdir(), "deep-mix-phase16-post-journal-"));
    temporaryRoots.push(workspaceRoot);
    const sessionStore = new SessionStore(workspaceRoot);
    await sessionStore.ensureInitialized();
    const session = await sessionStore.createSession("phase16 post journal recovery");
    const args = {
      url: `${PUBLIC_BASE_URL}/post-journal-recovery`,
      method: "POST" as const,
      body: { kind: "json" as const, content: '{"operation":"commit-once"}' },
    };
    const call: ToolCall = {
      id: "phase16-post-journal-recovery-call",
      name: "http_request",
      arguments: args,
      rawArguments: JSON.stringify(args),
    };
    const originalAppendMessage = SessionStore.prototype.appendMessage;
    const originalDeleteProtectedToolCall = SessionStore.prototype.deleteProtectedToolCall;
    let toolAppendFailed = false;
    let cleanupFailed = false;
    SessionStore.prototype.appendMessage = async function(input) {
      if (!toolAppendFailed && input.role === "tool" && input.toolCallId === call.id) {
        toolAppendFailed = true;
        throw new Error("simulated post-execution tool-message append failure");
      }
      return originalAppendMessage.call(this, input);
    };
    SessionStore.prototype.deleteProtectedToolCall = async function(sessionId, toolCallId) {
      if (!cleanupFailed && toolCallId === call.id) {
        cleanupFailed = true;
        throw new Error("simulated post-execution protected cleanup failure");
      }
      return originalDeleteProtectedToolCall.call(this, sessionId, toolCallId);
    };

    try {
      const governor = new GovernorRuntime({
        workspaceRoot,
        permissionMode: "danger-full-access",
        modelClient: new ScriptedModelClient([{ content: "", toolCalls: [call] }]),
        networkService: network,
        environment: { ...process.env, BRAVE_SEARCH_API_KEY: undefined },
      });
      await expect(governor.runTurn({
        sessionId: session.sessionId,
        prompt: "Send this state-changing HTTP request exactly once.",
        routeOverride: "ds_direct",
      })).rejects.toThrow(/tool-message append failure/iu);
    } finally {
      SessionStore.prototype.appendMessage = originalAppendMessage;
      SessionStore.prototype.deleteProtectedToolCall = originalDeleteProtectedToolCall;
    }

    const recoveryStore = new SessionStore(workspaceRoot);
    const recoveryRuntime = new ToolRuntime({
      workspaceRoot,
      sessionStore: recoveryStore,
      permissionMode: "danger-full-access",
      environment: { ...process.env, BRAVE_SEARCH_API_KEY: undefined },
      settings: { version: 1 },
      networkService: network,
    });
    const recovered = await recoveryRuntime.executeTool(call, session.sessionId);
    await recoveryStore.deleteProtectedToolCall(session.sessionId, call.id);

    expect(toolAppendFailed).toBe(true);
    expect(cleanupFailed).toBe(true);
    expect(recovered.success).toBe(true);
    expect(network.attempts).toHaveLength(1);
    expect(await recoveryStore.loadToolExecutionJournal(session.sessionId, call.id)).toMatchObject({
      status: "completed",
      toolName: "http_request",
      result: { success: true, callId: call.id },
    });
  }, 30_000);

  it("does not replay a completed POST after audit or one-time-grant consumption faults", async () => {
    const auditNetwork = new FaithfulFakeNetwork([
      { headers: { "content-type": "application/json" }, body: '{"audit":true}' },
      { headers: { "content-type": "application/json" }, body: '{"replayed":true}' },
    ]);
    const auditFixture = await createToolFixture({ network: auditNetwork });
    const auditArgs = {
      url: `${PUBLIC_BASE_URL}/audit-fault-no-replay`,
      method: "POST" as const,
      body: { kind: "json" as const, content: '{"operation":"audit"}' },
    };
    const auditCall: ToolCall = {
      id: "phase16-audit-fault-no-replay",
      name: "http_request",
      arguments: auditArgs,
      rawArguments: JSON.stringify(auditArgs),
    };
    const originalRecordAudit = auditFixture.sessionStore.recordToolExecutionAudit.bind(auditFixture.sessionStore);
    auditFixture.sessionStore.recordToolExecutionAudit = async () => {
      throw new Error("simulated tool execution audit failure");
    };
    await expect(auditFixture.runtime.executeTool(auditCall, auditFixture.sessionId))
      .rejects.toThrow(/audit failure/iu);
    auditFixture.sessionStore.recordToolExecutionAudit = originalRecordAudit;
    await expect(auditFixture.runtime.executeTool(auditCall, auditFixture.sessionId)).resolves.toMatchObject({
      success: true,
      callId: auditCall.id,
    });
    expect(auditNetwork.attempts).toHaveLength(1);

    const consumeNetwork = new FaithfulFakeNetwork([
      { headers: { "content-type": "application/json" }, body: '{"consume":true}' },
      { headers: { "content-type": "application/json" }, body: '{"replayed":true}' },
    ]);
    const consumeFixture = await createToolFixture({ network: consumeNetwork, permissionMode: "auto" });
    const consumeArgs = {
      url: `${PUBLIC_BASE_URL}/consume-fault-no-replay`,
      method: "POST" as const,
      body: { kind: "json" as const, content: '{"operation":"consume"}' },
    };
    const consumeCall: ToolCall = {
      id: "phase16-consume-fault-no-replay",
      name: "http_request",
      arguments: consumeArgs,
      rawArguments: JSON.stringify(consumeArgs),
    };
    let pending: PermissionRequiredError | undefined;
    try {
      await consumeFixture.runtime.executeTool(consumeCall, consumeFixture.sessionId);
    } catch (error) {
      if (!(error instanceof PermissionRequiredError)) throw error;
      pending = error;
    }
    if (!pending) throw new Error("Expected an allow-once approval fixture.");
    await consumeFixture.runtime.resolveApproval({
      sessionId: consumeFixture.sessionId,
      approvalId: pending.approvalId,
      toolName: pending.toolName,
      requestKey: pending.requestKey,
      persistence: "allow_once",
      reason: "Phase 16 consume-fault no-replay regression.",
    });
    const originalConsumeGrant = consumeFixture.sessionStore.consumeApprovalGrant.bind(consumeFixture.sessionStore);
    let consumeCalls = 0;
    consumeFixture.sessionStore.consumeApprovalGrant = async () => {
      consumeCalls += 1;
      throw new Error("simulated one-time grant consumption failure");
    };
    await expect(consumeFixture.runtime.executeTool(consumeCall, consumeFixture.sessionId))
      .rejects.toThrow(/grant consumption failure/iu);
    consumeFixture.sessionStore.consumeApprovalGrant = originalConsumeGrant;
    await expect(consumeFixture.runtime.executeTool(consumeCall, consumeFixture.sessionId)).resolves.toMatchObject({
      success: true,
      callId: consumeCall.id,
    });
    expect(consumeCalls).toBe(1);
    expect(consumeNetwork.attempts).toHaveLength(1);
  });

  it("uses a workspace-secret HMAC so low-entropy approval arguments have no public SHA verifier", async () => {
    const lowEntropySecret = "pin";
    const args = {
      url: `${PUBLIC_BASE_URL}/low-entropy-approval`,
      method: "POST" as const,
      headers: { Authorization: `Bearer ${lowEntropySecret}` },
    };
    const requestKeys: string[] = [];
    for (const index of [0, 1]) {
      const fixture = await createToolFixture({ network: new FaithfulFakeNetwork([]), permissionMode: "auto" });
      const call: ToolCall = {
        id: `phase16-low-entropy-${index}`,
        name: "http_request",
        arguments: args,
        rawArguments: JSON.stringify(args),
      };
      for (let attempt = 0; attempt < (index === 0 ? 2 : 1); attempt += 1) {
        try {
          await fixture.runtime.executeTool(call, fixture.sessionId);
          throw new Error("Expected low-entropy approval to pause.");
        } catch (error) {
          if (!(error instanceof PermissionRequiredError)) throw error;
          if (attempt === 0) requestKeys.push(error.requestKey);
          else expect(error.requestKey).toBe(requestKeys[0]);
        }
      }
    }

    const publicDigest = createHash("sha256").update(JSON.stringify(args)).digest("hex");
    expect(requestKeys).toHaveLength(2);
    expect(requestKeys[0]).toMatch(/^http_request:hmac-sha256:[0-9a-f]{64}$/u);
    expect(requestKeys[1]).toMatch(/^http_request:hmac-sha256:[0-9a-f]{64}$/u);
    expect(requestKeys[0]).not.toBe(requestKeys[1]);
    expect(requestKeys.join(" ")).not.toContain(publicDigest);
    expect(requestKeys.join(" ")).not.toContain(lowEntropySecret);
  });

  it("preserves a destination changed after checkpoint creation but before tool execution", async () => {
    const network = new FaithfulFakeNetwork([{
      headers: { "content-type": "text/plain" },
      body: "downloaded replacement",
    }]);
    const fixture = await createToolFixture({ network });
    const downloads = path.join(fixture.workspaceRoot, "downloads");
    const destination = path.join(downloads, "checkpoint-race.txt");
    await fs.mkdir(downloads);
    await fs.writeFile(destination, "checkpoint baseline", "utf8");
    const originalCreateCheckpoint = fixture.sessionStore.createCheckpoint.bind(fixture.sessionStore);
    let changedAfterCheckpoint = false;
    fixture.sessionStore.createCheckpoint = async (input) => {
      const checkpoint = await originalCreateCheckpoint(input);
      if (input.trackedFiles.map((file) => file.replace(/\\/gu, "/")).includes("downloads/checkpoint-race.txt")) {
        await fs.writeFile(destination, "concurrent destination", "utf8");
        changedAfterCheckpoint = true;
      }
      return checkpoint;
    };

    const result = await fixture.runtime.executeManualTool(
      "download_file",
      {
        url: `${PUBLIC_BASE_URL}/checkpoint-race.txt`,
        target: "workspace",
        workspacePath: "downloads/checkpoint-race.txt",
        overwriteStrategy: "replace",
      },
      fixture.sessionId,
    );

    expect(changedAfterCheckpoint).toBe(true);
    expect(result.success).toBe(false);
    expect(await fs.readFile(destination, "utf8")).toBe("concurrent destination");
    expect(await fs.readdir(downloads)).not.toContainEqual(expect.stringMatching(/^\.deep-mix-download-/u));
  });

  it("removes an ungoverned checkpoint root when post-manifest event append is aborted", async () => {
    const network = new FaithfulFakeNetwork([]);
    const fixture = await createToolFixture({ network });
    const trackedPath = path.join(fixture.workspaceRoot, "checkpoint-source.txt");
    await fs.writeFile(trackedPath, "checkpoint source", "utf8");
    const checkpointsRoot = path.join(fixture.workspaceRoot, ".deep-mix", "checkpoints");
    const rootsBefore = (await fs.readdir(checkpointsRoot)).sort();
    const controller = new AbortController();
    const originalAppendEvent = fixture.sessionStore.appendEvent.bind(fixture.sessionStore);
    fixture.sessionStore.appendEvent = async (...args: Parameters<SessionStore["appendEvent"]>) => {
      if (args[1].recordType === "checkpoint") {
        controller.abort(Object.assign(new Error("phase16 post-manifest checkpoint abort"), {
          code: "ABORT_ERR",
          name: "AbortError",
        }));
        throw controller.signal.reason;
      }
      await originalAppendEvent(...args);
    };

    try {
      await expect(fixture.sessionStore.createCheckpoint({
        sessionId: fixture.sessionId,
        scope: "pre_tool_write",
        trackedFiles: ["checkpoint-source.txt"],
        reason: "Phase 16 checkpoint transaction cleanup regression.",
        signal: controller.signal,
      })).rejects.toMatchObject({ code: "ABORT_ERR" });
    } finally {
      fixture.sessionStore.appendEvent = originalAppendEvent;
    }

    expect((await fs.readdir(checkpointsRoot)).sort()).toEqual(rootsBefore);
    expect((await fixture.sessionStore.loadEvents(fixture.sessionId)).filter(
      (event) => event.recordType === "checkpoint",
    )).toEqual([]);
    expect(network.attempts).toHaveLength(0);
  });

  it("fails closed when a guarded workspace stage is swapped to a regular file or junction", async () => {
    for (const stageKind of ["regular", "junction"] as const) {
      const network = new FaithfulFakeNetwork([{
        headers: { "content-type": "text/plain" },
        body: `download for ${stageKind}`,
      }]);
      const fixture = await createToolFixture({ network });
      const downloads = path.join(fixture.workspaceRoot, "downloads");
      const destination = path.join(downloads, `${stageKind}-stage.txt`);
      await fs.mkdir(downloads);
      await fs.writeFile(destination, "original destination", "utf8");
      const outsideRoot = await fs.mkdtemp(path.join(os.tmpdir(), `deep-mix-phase16-stage-${stageKind}-`));
      temporaryRoots.push(outsideRoot);
      const outsideMarker = path.join(outsideRoot, "outside-marker.txt");
      await fs.writeFile(outsideMarker, "outside untouched", "utf8");
      const callId = `phase16-stage-swap-${stageKind}`;
      let stagedPath = "";
      const originalCreateCheckpoint = fixture.sessionStore.createCheckpoint.bind(fixture.sessionStore);
      fixture.sessionStore.createCheckpoint = async (input) => {
        const checkpoint = await originalCreateCheckpoint(input);
        const stagedRelativePath = input.trackedFiles.find((file) => path.basename(file).startsWith(".deep-mix-download-"));
        if (!stagedRelativePath) throw new Error("Missing guarded workspace stage path.");
        stagedPath = path.join(fixture.workspaceRoot, stagedRelativePath);
        if (stageKind === "regular") await fs.writeFile(stagedPath, "attacker stage", "utf8");
        else await fs.symlink(outsideRoot, stagedPath, "junction");
        return checkpoint;
      };
      const call: ToolCall = {
        id: callId,
        name: "download_file",
        arguments: {
          url: `${PUBLIC_BASE_URL}/${stageKind}-stage.txt`,
          target: "workspace",
          workspacePath: `downloads/${stageKind}-stage.txt`,
          overwriteStrategy: "replace",
        },
        rawArguments: "",
      };
      call.rawArguments = JSON.stringify(call.arguments);

      const result = await fixture.runtime.executeTool(call, fixture.sessionId);

      expect(stagedPath).not.toBe("");
      expect(result.success).toBe(false);
      expect(await fs.readFile(destination, "utf8")).toBe("original destination");
      expect(await fs.readFile(outsideMarker, "utf8")).toBe("outside untouched");
      await fs.rm(stagedPath, { recursive: true, force: true }).catch(() => undefined);
    }
  });

  it("does not follow a regular-file or junction stage swapped in between fallback routes", async () => {
    for (const stageKind of ["regular", "junction"] as const) {
      const callId = `phase16-fallback-stage-${stageKind}`;
      let stagedPath = "";
      let swapCreated = false;
      const outsideRoot = await fs.mkdtemp(path.join(os.tmpdir(), `deep-mix-phase16-fallback-${stageKind}-`));
      temporaryRoots.push(outsideRoot);
      const outsideFile = path.join(outsideRoot, "outside.txt");
      await fs.writeFile(outsideFile, "outside must stay unchanged", "utf8");
      const network = new FaithfulFakeNetwork([
        {
          headers: { "content-type": "text/plain" },
          chunks: ["partial proxy bytes"],
          errorAfterChunks: Object.assign(new Error("proxy reset after partial stage"), { code: "ECONNRESET" }),
        },
        async () => {
          await fs.rm(stagedPath, { force: true });
          if (stageKind === "regular") await fs.link(outsideFile, stagedPath);
          else await fs.symlink(outsideRoot, stagedPath, "junction");
          swapCreated = true;
          return {
            headers: { "content-type": "text/plain" },
            body: "clean direct bytes",
          };
        },
      ], ["system", "direct"]);
      const fixture = await createToolFixture({ network });
      const downloads = path.join(fixture.workspaceRoot, "downloads");
      const destination = path.join(downloads, `${stageKind}-fallback.txt`);
      await fs.mkdir(downloads);
      await fs.writeFile(destination, "original destination", "utf8");
      stagedPath = path.join(downloads, `.deep-mix-download-${callId}.tmp`);
      const args = {
        url: `${PUBLIC_BASE_URL}/${stageKind}-fallback.txt`,
        target: "workspace",
        workspacePath: `downloads/${stageKind}-fallback.txt`,
        overwriteStrategy: "replace",
      };
      const result = await fixture.runtime.executeTool({
        id: callId,
        name: "download_file",
        arguments: args,
        rawArguments: JSON.stringify(args),
      }, fixture.sessionId);

      expect(swapCreated, JSON.stringify({ result, attempts: network.attempts })).toBe(true);
      expect(result.success).toBe(false);
      expect(network.attempts.map((attempt) => attempt.route)).toEqual(["system", "direct"]);
      expect(await fs.readFile(destination, "utf8")).toBe("original destination");
      expect(await fs.readFile(outsideFile, "utf8")).toBe("outside must stay unchanged");
      await fs.rm(stagedPath, { recursive: true, force: true }).catch(() => undefined);
    }
  });

  it("does not publish a regular-file or junction stage replacement after streaming completes", async () => {
    for (const stageKind of ["regular", "junction"] as const) {
      const callId = `phase16-finished-stage-${stageKind}`;
      let stagedPath = "";
      let swapCreated = false;
      const outsideRoot = await fs.mkdtemp(path.join(os.tmpdir(), `deep-mix-phase16-finished-${stageKind}-`));
      temporaryRoots.push(outsideRoot);
      const outsideFile = path.join(outsideRoot, "outside.txt");
      await fs.writeFile(outsideFile, "attacker replacement content", "utf8");
      const network = new FaithfulFakeNetwork([{
        headers: { "content-type": "text/plain" },
        chunks: ["trusted streamed content"],
        afterChunk: async () => {
          await fs.rm(stagedPath, { force: true });
          if (stageKind === "regular") await fs.link(outsideFile, stagedPath);
          else await fs.symlink(outsideRoot, stagedPath, "junction");
          swapCreated = true;
        },
      }]);
      const fixture = await createToolFixture({ network });
      const downloads = path.join(fixture.workspaceRoot, "downloads");
      const destination = path.join(downloads, `${stageKind}-finished.txt`);
      await fs.mkdir(downloads);
      await fs.writeFile(destination, "original destination", "utf8");
      stagedPath = path.join(downloads, `.deep-mix-download-${callId}.tmp`);
      const args = {
        url: `${PUBLIC_BASE_URL}/${stageKind}-finished.txt`,
        target: "workspace",
        workspacePath: `downloads/${stageKind}-finished.txt`,
        overwriteStrategy: "replace",
      };
      const result = await fixture.runtime.executeTool({
        id: callId,
        name: "download_file",
        arguments: args,
        rawArguments: JSON.stringify(args),
      }, fixture.sessionId);

      expect(swapCreated, JSON.stringify({ result, attempts: network.attempts })).toBe(true);
      expect(result.success).toBe(false);
      expect(await fs.readFile(destination, "utf8")).toBe("original destination");
      expect(await fs.readFile(outsideFile, "utf8")).toBe("attacker replacement content");
      await fs.rm(stagedPath, { recursive: true, force: true }).catch(() => undefined);
    }
  });

  it("treats the workspace link as the cancellation linearization point", async () => {
    for (const overwriteStrategy of ["unique", "replace"] as const) {
      const payload = `linearized ${overwriteStrategy} payload`;
      const network = new FaithfulFakeNetwork([{
        headers: { "content-type": "text/plain" },
        body: payload,
      }]);
      const fixture = await createToolFixture({ network });
      const downloads = path.join(fixture.workspaceRoot, "downloads");
      const destination = path.join(downloads, `linearized-${overwriteStrategy}.txt`);
      await fs.mkdir(downloads);
      if (overwriteStrategy === "replace") await fs.writeFile(destination, "replace baseline", "utf8");
      const controller = new AbortController();
      const originalLink = fs.link.bind(fs);
      let abortedAfterPublish = false;
      fs.link = (async (existingPath, newPath) => {
        await originalLink(existingPath, newPath);
        if (path.resolve(String(newPath)) === destination) {
          abortedAfterPublish = true;
          controller.abort(Object.assign(new Error("phase16 abort immediately after publish link"), {
            code: "ABORT_ERR",
            name: "AbortError",
          }));
        }
      }) as typeof fs.link;

      let result: ToolResult;
      try {
        result = await fixture.runtime.executeManualTool(
          "download_file",
          {
            url: `${PUBLIC_BASE_URL}/linearized-${overwriteStrategy}.txt`,
            target: "workspace",
            workspacePath: `downloads/linearized-${overwriteStrategy}.txt`,
            overwriteStrategy,
          },
          fixture.sessionId,
          { signal: controller.signal },
        );
      } finally {
        fs.link = originalLink;
      }

      expect(abortedAfterPublish).toBe(true);
      expect(result!.success, JSON.stringify(result!)).toBe(true);
      expect(await fs.readFile(destination, "utf8")).toBe(payload);
      expect(await fs.readdir(downloads)).not.toContainEqual(expect.stringMatching(/^\.deep-mix-download-/u));
    }
  });

  it("rolls back workspace publication when the first post-link fingerprint read fails", async () => {
    for (const overwriteStrategy of ["unique", "replace"] as const) {
      const payload = `post-link ${overwriteStrategy} payload`;
      const baseline = `post-link ${overwriteStrategy} baseline`;
      const network = new FaithfulFakeNetwork([{
        headers: { "content-type": "text/plain" },
        body: payload,
      }]);
      const fixture = await createToolFixture({ network });
      const downloads = path.join(fixture.workspaceRoot, "downloads");
      const destination = path.join(downloads, `post-link-${overwriteStrategy}.txt`);
      await fs.mkdir(downloads);
      if (overwriteStrategy === "replace") await fs.writeFile(destination, baseline, "utf8");
      const originalLink = fs.link.bind(fs);
      const originalOpen = fs.open.bind(fs);
      let destinationLinked = false;
      let fingerprintFailureInjected = false;
      fs.link = (async (existingPath, newPath) => {
        await originalLink(existingPath, newPath);
        if (path.resolve(String(newPath)) === destination) destinationLinked = true;
      }) as typeof fs.link;
      fs.open = (async (file, flags, mode) => {
        if (
          destinationLinked &&
          !fingerprintFailureInjected &&
          path.resolve(String(file)) === destination
        ) {
          fingerprintFailureInjected = true;
          throw Object.assign(new Error("phase16 injected post-link fingerprint failure"), { code: "EIO" });
        }
        return originalOpen(file, flags, mode);
      }) as typeof fs.open;

      let result: ToolResult;
      try {
        result = await fixture.runtime.executeManualTool(
          "download_file",
          {
            url: `${PUBLIC_BASE_URL}/post-link-${overwriteStrategy}.txt`,
            target: "workspace",
            workspacePath: `downloads/post-link-${overwriteStrategy}.txt`,
            overwriteStrategy,
          },
          fixture.sessionId,
        );
      } finally {
        fs.link = originalLink;
        fs.open = originalOpen;
      }

      expect(fingerprintFailureInjected).toBe(true);
      expect(result!.success).toBe(false);
      if (overwriteStrategy === "unique") {
        await expect(fs.readFile(destination)).rejects.toMatchObject({ code: "ENOENT" });
      } else {
        expect(await fs.readFile(destination, "utf8")).toBe(baseline);
      }
      expect(await fs.readdir(downloads)).not.toContainEqual(expect.stringMatching(/^\.deep-mix-download-/u));
    }
  });

  it("preserves a concurrent destination swapped in after the publish link but before identity verification", async () => {
    for (const overwriteStrategy of ["unique", "replace"] as const) {
      const concurrentContent = `concurrent ${overwriteStrategy} owner`;
      const network = new FaithfulFakeNetwork([{
        headers: { "content-type": "text/plain" },
        body: `trusted ${overwriteStrategy} payload`,
      }]);
      const fixture = await createToolFixture({ network });
      const downloads = path.join(fixture.workspaceRoot, "downloads");
      const destination = path.join(downloads, `post-link-swap-${overwriteStrategy}.txt`);
      await fs.mkdir(downloads);
      if (overwriteStrategy === "replace") await fs.writeFile(destination, "replace baseline", "utf8");
      const originalLink = fs.link.bind(fs);
      let swapped = false;
      fs.link = (async (existingPath, newPath) => {
        await originalLink(existingPath, newPath);
        if (path.resolve(String(newPath)) === destination) {
          await fs.rm(newPath, { force: true });
          await fs.writeFile(newPath, concurrentContent, "utf8");
          swapped = true;
        }
      }) as typeof fs.link;

      let result: ToolResult;
      try {
        result = await fixture.runtime.executeManualTool(
          "download_file",
          {
            url: `${PUBLIC_BASE_URL}/post-link-swap-${overwriteStrategy}.txt`,
            target: "workspace",
            workspacePath: `downloads/post-link-swap-${overwriteStrategy}.txt`,
            overwriteStrategy,
          },
          fixture.sessionId,
        );
      } finally {
        fs.link = originalLink;
      }

      expect(swapped).toBe(true);
      expect(result!.success).toBe(false);
      expect(await fs.readFile(destination, "utf8")).toBe(concurrentContent);
      expect(await fs.readdir(downloads)).not.toContainEqual(expect.stringMatching(/^\.deep-mix-download-/u));
    }
  });

  it("prevents transport continuation after a 100ms bounded timeout or abort", async () => {
    let releaseTimedOut!: (value: string) => void;
    const slowResolution = new Promise<string>((resolve) => { releaseTimedOut = resolve; });
    let transportStarts = 0;
    const timedOut = runBoundedNetworkOperation(slowResolution, { timeoutMs: 100 }).then(() => {
      transportStarts += 1;
    });
    await expect(timedOut).rejects.toMatchObject({ code: "ETIMEDOUT" });
    releaseTimedOut("http://proxy.invalid");
    await new Promise<void>((resolve) => setTimeout(resolve, 0));

    let releaseAborted!: (value: string) => void;
    const abortedResolution = new Promise<string>((resolve) => { releaseAborted = resolve; });
    const controller = new AbortController();
    const aborted = runBoundedNetworkOperation(abortedResolution, {
      signal: controller.signal,
      timeoutMs: 100,
    }).then(() => {
      transportStarts += 1;
    });
    controller.abort(new Error("phase16 bounded abort"));
    await expect(aborted).rejects.toMatchObject({ code: "ABORT_ERR" });
    releaseAborted("http://proxy.invalid");
    await new Promise<void>((resolve) => setTimeout(resolve, 0));

    expect(transportStarts).toBe(0);
  });

  it("fails closed when a planned system proxy re-resolves to DIRECT", async () => {
    let transportRequests = 0;
    const transport = http.createServer((_request, response) => {
      transportRequests += 1;
      response.writeHead(200, { "content-type": "text/plain" });
      response.end("transport must not run");
    });
    await new Promise<void>((resolve, reject) => {
      transport.once("error", reject);
      transport.listen(0, "127.0.0.1", resolve);
    });
    const address = transport.address();
    if (!address || typeof address === "string") throw new Error("Expected a system-route test address.");
    let proxyReads = 0;
    const environment = {} as NodeJS.ProcessEnv;
    Object.defineProperty(environment, "HTTP_PROXY", {
      enumerable: true,
      configurable: true,
      get: () => {
        proxyReads += 1;
        return proxyReads === 1 ? `http://127.0.0.1:${address.port}` : "DIRECT";
      },
    });
    const network = createNodeSystemToolNetworkService(environment);
    const url = new URL(`http://127.0.0.1:${address.port}/must-not-run`);
    try {
      await expect(network.plan(url)).resolves.toMatchObject({
        routes: [{ route: "system" }, { route: "direct" }],
        systemRouteDistinct: true,
      });
      await expect(network.request(url, {
        method: "GET",
        signal: AbortSignal.timeout(500),
      }, {
        route: "system",
        timeoutMs: 100,
        maxResponseBytes: 1_024,
        pinnedAddress: { hostname: "127.0.0.1", address: "127.0.0.1", family: 4 },
      })).rejects.toMatchObject({
        code: "ERR_PROXY_REQUEST_FAILED",
      });
      expect(proxyReads).toBeGreaterThanOrEqual(2);
      expect(transportRequests).toBe(0);
    } finally {
      await network.dispose();
      await new Promise<void>((resolve) => transport.close(() => resolve()));
    }
  });

  it("fails closed for pinned PAC routes for both HTTP and HTTPS targets", async () => {
    const cases: Array<{ url: string; environment: NodeJS.ProcessEnv }> = [
      {
        url: "http://example.com/resource",
        environment: { HTTP_PROXY: "pac+http://pac.invalid/config.pac" },
      },
      {
        url: "https://example.com/resource",
        environment: { HTTPS_PROXY: "pac+https://pac.invalid/config.pac" },
      },
    ];

    for (const [index, testCase] of cases.entries()) {
      const nodeNetwork = createNodeSystemToolNetworkService(testCase.environment);
      const routes: ToolNetworkRoute[] = [];
      const network: ToolNetworkService = {
        plan: (url) => nodeNetwork.plan(url),
        request: (url, init, options) => {
          routes.push(options.route);
          return nodeNetwork.request(url, init, options);
        },
        dispose: () => nodeNetwork.dispose(),
      };
      const url = new URL(testCase.url);
      try {
        await expect(network.plan(url)).resolves.toMatchObject({
          routes: [{ route: "system" }, { route: "direct" }],
          systemRouteDistinct: true,
        });
        await expect(network.request(url, {
          method: "GET",
          signal: AbortSignal.timeout(500),
        }, {
          route: "system",
          timeoutMs: 100,
          maxResponseBytes: 1_024,
          pinnedAddress: { hostname: "example.com", ...PUBLIC_ADDRESS },
        })).rejects.toMatchObject({
          code: "ERR_PROXY_UNSUPPORTED_PINNED_HTTP",
        });
        routes.length = 0;
        await expect(executeSafeHttpRequest({
          network,
          budgetKey: `pinned-pac-no-fallback-${index}`,
          spec: {
            method: "GET",
            url: testCase.url,
            timeoutMs: 500,
            maxResponseBytes: 1_024,
            maxRedirects: 0,
          },
          resolveHostname: async () => [PUBLIC_ADDRESS],
        })).rejects.toMatchObject({
          networkErrorType: "policy_denied",
          retryable: false,
        });
        expect(routes).toEqual(["system"]);
      } finally {
        await network.dispose();
      }
    }
  });

  it("never falls back from wrapped proxy authentication, 407, or unknown policy failures", async () => {
    const cases = [
      Object.assign(new Error("Proxy authentication required."), { code: "ERR_PROXY_AUTH_REQUIRED" }),
      Object.assign(new Error("Proxy tunnel returned HTTP 407 Authentication Required."), {
        code: "ERR_HTTP_PROXY_CONNECT",
      }),
      Object.assign(new Error("Unknown proxy policy failure."), { code: "ERR_PROXY_POLICY_UNKNOWN" }),
    ];

    for (const [index, cause] of cases.entries()) {
      const routes: ToolNetworkRoute[] = [];
      const wrapped = Object.assign(new Error("System proxy request failed.", { cause }), {
        code: "ERR_PROXY_REQUEST_FAILED",
      });
      const network: ToolNetworkService = {
        plan: async () => ({
          routes: [
            { route: "system", source: "environment" },
            { route: "direct", source: "direct" },
          ],
          systemRouteDistinct: true,
        }),
        request: async (_url, _init, options) => {
          routes.push(options.route);
          if (options.route === "system") throw wrapped;
          return { status: 200, ok: true, headers: {}, body: Buffer.from("must not use direct") };
        },
        dispose: async () => undefined,
      };

      const rejection = executeSafeHttpRequest({
        network,
        budgetKey: `wrapped-proxy-policy-no-fallback-${index}`,
        spec: {
          method: "GET",
          url: "https://example.com/proxy-policy",
          timeoutMs: 1_000,
          maxResponseBytes: 1_024,
          maxRedirects: 0,
        },
        resolveHostname: async () => [PUBLIC_ADDRESS],
      });
      if (index < 2) {
        await expect(rejection).rejects.toMatchObject({
          networkErrorType: "policy_denied",
          retryable: false,
        });
      } else {
        await expect(rejection).rejects.toMatchObject({
          networkErrorType: "proxy",
          retryable: false,
        });
      }
      expect(routes).toEqual(["system"]);
    }
  });

  it("fails closed when the protected-call state root is replaced by a junction", async () => {
    const fixture = await createToolFixture({ network: new FaithfulFakeNetwork([]) });
    const outsideRoot = await fs.mkdtemp(path.join(os.tmpdir(), "deep-mix-phase16-protected-junction-"));
    temporaryRoots.push(outsideRoot);
    const protectedRoot = path.join(
      fixture.workspaceRoot,
      ".deep-mix",
      "protected-tool-calls",
    );
    await fs.rm(protectedRoot, { recursive: true, force: true });
    await fs.symlink(outsideRoot, protectedRoot, "junction");
    const protectedCall: ToolCall = {
      id: "phase16-protected-junction-call",
      name: "http_request",
      arguments: { secret: "must-not-escape" },
      rawArguments: '{"secret":"must-not-escape"}',
    };

    await expect(fixture.sessionStore.storeProtectedToolCall(fixture.sessionId, protectedCall)).rejects.toThrow();
    expect(await fs.readdir(outsideRoot)).toEqual([]);
    await fs.rm(protectedRoot, { recursive: true, force: true }).catch(() => undefined);
  });

  it("fails closed when a tool-output session directory is replaced by a junction", async () => {
    const fixture = await createToolFixture({ network: new FaithfulFakeNetwork([]) });
    const outsideRoot = await fs.mkdtemp(path.join(os.tmpdir(), "deep-mix-phase16-output-junction-"));
    temporaryRoots.push(outsideRoot);
    const outputSessionDirectory = path.join(
      fixture.workspaceRoot,
      ".deep-mix",
      "tool-outputs",
      "network-responses",
      fixture.sessionId,
    );
    await fs.mkdir(path.dirname(outputSessionDirectory), { recursive: true });
    await fs.symlink(outsideRoot, outputSessionDirectory, "junction");

    await expect(fixture.sessionStore.storeToolOutputArtifact({
      sessionId: fixture.sessionId,
      namespace: "network-responses",
      toolCallId: "phase16-output-junction-call",
      sourceToolName: "http_request",
      fileName: "must-not-escape.txt",
      mimeType: "text/plain",
      kind: "text",
      summary: "Junction escape regression.",
      content: "must not escape",
    })).rejects.toThrow();
    expect(await fs.readdir(outsideRoot)).toEqual([]);
    await fs.rm(outputSessionDirectory, { recursive: true, force: true }).catch(() => undefined);
  });

  it("rejects tampered tool-output bytes through read_file and the protected workspace path", async () => {
    const fixture = await createToolFixture({ network: new FaithfulFakeNetwork([]) });
    const trustedContent = "trusted-artifact-payload-749318";
    const attackerContent = "x".repeat(Buffer.byteLength(trustedContent));
    const artifact = await fixture.sessionStore.storeToolOutputArtifact({
      sessionId: fixture.sessionId,
      namespace: "network-responses",
      toolCallId: "phase16-tampered-artifact-call",
      sourceToolName: "http_request",
      fileName: "tampered-output.txt",
      mimeType: "text/plain",
      kind: "text",
      summary: "Phase 16 tampered artifact read regression.",
      content: trustedContent,
    });
    const artifactPath = fixture.sessionStore.resolveToolOutputArtifactPath(artifact.uri);
    const workspaceRelativePath = path.relative(fixture.workspaceRoot, artifactPath).replace(/\\/gu, "/");
    await fs.writeFile(artifactPath, attackerContent, "utf8");

    await expect(fixture.sessionStore.readTextToolOutputArtifact(artifact.uri)).rejects.toThrow(/hash|integrity/iu);
    const artifactRead = await fixture.runtime.executeManualTool(
      "read_file",
      { path: artifact.uri },
      fixture.sessionId,
    );
    const workspacePathRead = await fixture.runtime.executeManualTool(
      "read_file",
      { path: workspaceRelativePath },
      fixture.sessionId,
    );

    for (const result of [artifactRead, workspacePathRead]) {
      expect(result.success, JSON.stringify(result)).toBe(false);
      expect(JSON.stringify(result)).not.toContain(attackerContent);
    }
    expect(JSON.stringify(artifactRead)).toMatch(/hash|integrity/iu);
    expect(JSON.stringify(workspacePathRead)).toMatch(/protected|readable sandbox/iu);
  });

  it("does not register or delete a concurrent tool-output path swapped in after publication", async () => {
    const fixture = await createToolFixture({ network: new FaithfulFakeNetwork([]) });
    const requestedName = "tool-output-publish-race.txt";
    const attackerContent = "concurrent tool-output owner";
    const originalLink = fs.link.bind(fs);
    let candidatePath = "";
    fs.link = (async (existingPath, newPath) => {
      await originalLink(existingPath, newPath);
      if (path.basename(String(newPath)) === requestedName) {
        candidatePath = String(newPath);
        await fs.rm(newPath, { force: true });
        await fs.writeFile(newPath, attackerContent, "utf8");
      }
    }) as typeof fs.link;

    try {
      await expect(fixture.sessionStore.storeToolOutputArtifact({
        sessionId: fixture.sessionId,
        namespace: "network-responses",
        toolCallId: "phase16-tool-output-publish-race",
        sourceToolName: "http_request",
        fileName: requestedName,
        mimeType: "text/plain",
        kind: "text",
        summary: "Tool-output publish ownership race regression.",
        content: "trusted tool output",
      })).rejects.toThrow();
    } finally {
      fs.link = originalLink;
    }

    expect(candidatePath).not.toBe("");
    expect(await fs.readFile(candidatePath, "utf8")).toBe(attackerContent);
    expect(await fixture.sessionStore.listToolOutputArtifacts(fixture.sessionId)).toEqual([]);
  });

  it("cleans already-written protected calls when a protected batch append fails", async () => {
    const workspaceRoot = await fs.mkdtemp(path.join(os.tmpdir(), "deep-mix-phase16-protected-batch-"));
    temporaryRoots.push(workspaceRoot);
    const network = new FaithfulFakeNetwork([]);
    const calls: ToolCall[] = ["first", "second"].map((label) => {
      const args = {
        url: `${PUBLIC_BASE_URL}/protected-batch-${label}`,
        method: "POST",
        body: { kind: "json", content: JSON.stringify({ token: `${label}-batch-secret` }) },
      };
      return {
        id: `phase16-protected-batch-${label}`,
        name: "http_request",
        arguments: args,
        rawArguments: JSON.stringify(args),
      };
    });
    const originalStoreProtectedToolCall = SessionStore.prototype.storeProtectedToolCall;
    let storeCalls = 0;
    SessionStore.prototype.storeProtectedToolCall = async function(sessionId, toolCall) {
      storeCalls += 1;
      if (storeCalls === 2) throw new Error("simulated protected batch append failure");
      return originalStoreProtectedToolCall.call(this, sessionId, toolCall);
    };
    let sessionId = "";
    try {
      const governor = new GovernorRuntime({
        workspaceRoot,
        permissionMode: "danger-full-access",
        modelClient: new ScriptedModelClient([{ content: "", toolCalls: calls }]),
        networkService: network,
        environment: { ...process.env, BRAVE_SEARCH_API_KEY: undefined },
      });
      await expect(governor.runTurn({
        prompt: "Send two HTTP API requests now; do not write code.",
        routeOverride: "ds_direct",
        callbacks: { onSessionSelected: (selected) => { sessionId = selected; } },
      })).rejects.toThrow(/protected batch append failure/iu);
    } finally {
      SessionStore.prototype.storeProtectedToolCall = originalStoreProtectedToolCall;
    }

    expect(sessionId).not.toBe("");
    await new Promise<void>((resolve) => setTimeout(resolve, 50));
    expect(await listRegularFiles(path.join(
      workspaceRoot,
      ".deep-mix",
      "protected-tool-calls",
      sessionId,
    ))).toEqual([]);
    expect(network.attempts).toHaveLength(0);
  }, 30_000);

  it("removes a session protected-call directory when the session is deleted", async () => {
    const fixture = await createToolFixture({ network: new FaithfulFakeNetwork([]) });
    const call: ToolCall = {
      id: "phase16-delete-session-protected",
      name: "http_request",
      arguments: { rawSecret: "delete-session-secret" },
      rawArguments: '{"rawSecret":"delete-session-secret"}',
    };
    const protectedSessionDirectory = path.join(
      fixture.workspaceRoot,
      ".deep-mix",
      "protected-tool-calls",
      fixture.sessionId,
    );
    await fixture.sessionStore.storeProtectedToolCall(fixture.sessionId, call);
    expect(await listRegularFiles(protectedSessionDirectory)).toHaveLength(1);

    await expect(fixture.sessionStore.deleteSession(fixture.sessionId)).resolves.toBe(true);
    expect(await listRegularFiles(protectedSessionDirectory)).toEqual([]);
  });

  it("cleans protected calls if appending the persistence-safe assistant message fails", async () => {
    const workspaceRoot = await fs.mkdtemp(path.join(os.tmpdir(), "deep-mix-phase16-protected-append-"));
    temporaryRoots.push(workspaceRoot);
    const network = new FaithfulFakeNetwork([]);
    const args = {
      url: `${PUBLIC_BASE_URL}/protected-append-failure`,
      method: "POST",
      body: { kind: "json", content: '{"token":"append-failure-secret"}' },
    };
    const call: ToolCall = {
      id: "phase16-protected-append-failure",
      name: "http_request",
      arguments: args,
      rawArguments: JSON.stringify(args),
    };
    const originalAppendMessage = SessionStore.prototype.appendMessage;
    SessionStore.prototype.appendMessage = async function(input) {
      if (input.role === "assistant" && (input.toolCalls?.length ?? 0) > 0) {
        throw new Error("simulated safe assistant append failure");
      }
      return originalAppendMessage.call(this, input);
    };
    let sessionId = "";
    try {
      const governor = new GovernorRuntime({
        workspaceRoot,
        permissionMode: "danger-full-access",
        modelClient: new ScriptedModelClient([{ content: "", toolCalls: [call] }]),
        networkService: network,
        environment: { ...process.env, BRAVE_SEARCH_API_KEY: undefined },
      });
      await expect(governor.runTurn({
        prompt: "Send an HTTP API request now; do not write code.",
        routeOverride: "ds_direct",
        callbacks: { onSessionSelected: (selected) => { sessionId = selected; } },
      })).rejects.toThrow(/safe assistant append failure/iu);
    } finally {
      SessionStore.prototype.appendMessage = originalAppendMessage;
    }

    expect(sessionId).not.toBe("");
    expect(await listRegularFiles(path.join(
      workspaceRoot,
      ".deep-mix",
      "protected-tool-calls",
      sessionId,
    ))).toEqual([]);
    expect(network.attempts).toHaveLength(0);
  }, 30_000);

  it("returns valid redacted JSON when a POST response reflects the complete request body", async () => {
    const bodySecret = "complete-body-reflection-secret";
    const requestJson = [
      "{",
      `  \"payload\": \"${bodySecret}\",`,
      '  "id": 9223372036854775807',
      "}",
    ].join("\n");
    const network = new FaithfulFakeNetwork([{
      headers: { "content-type": "application/json" },
      body: requestJson,
    }]);
    const fixture = await createToolFixture({ network });
    const result = await fixture.runtime.executeManualTool(
      "http_request",
      {
        url: `${PUBLIC_BASE_URL}/reflect-complete-body`,
        method: "POST",
        body: { kind: "json", content: requestJson },
      },
      fixture.sessionId,
    );
    const output = structured<{ body: string; bodyFormat: string }>(result);

    expect(result.success).toBe(true);
    expect(network.attempts[0]?.body).toEqual(Buffer.from(requestJson, "utf8"));
    expect(output.bodyFormat).toBe("json");
    expect(() => JSON.parse(output.body) as unknown).not.toThrow();
    expect(JSON.parse(output.body)).toBe("[REDACTED]");
    expect(JSON.stringify(result)).not.toContain(bodySecret);
    expect(JSON.stringify(result)).not.toContain(requestJson);
  });

  it("retroactively redacts an earlier redirect URL after a later hop reveals the secret", async () => {
    const secret = "late-redirect-secret";
    const network = new FaithfulFakeNetwork([
      {
        status: 302,
        headers: { location: `${PUBLIC_BASE_URL}/redirect-middle?reference=${secret}` },
        body: "",
      },
      {
        status: 302,
        headers: { location: `${PUBLIC_BASE_URL}/redirect-final?token=${secret}` },
        body: "",
      },
      {
        headers: { "content-type": "text/plain" },
        body: "safe final response",
      },
    ]);
    const fixture = await createToolFixture({ network });
    const result = await fixture.runtime.executeManualTool(
      "web_fetch",
      { url: `${PUBLIC_BASE_URL}/redirect-retroactive-start` },
      fixture.sessionId,
    );
    const output = structured<{
      finalUrl: string;
      response: { redirects: Array<{ fromUrl: string; toUrl: string }> };
    }>(result);

    expect(result.success).toBe(true);
    expect(result.networkAudit).toMatchObject({ requestCount: 3, redirectCount: 2 });
    expect(output.response.redirects).toHaveLength(2);
    expect(output.response.redirects[0]?.toUrl).toContain("%5BREDACTED%5D");
    expect(output.response.redirects[1]?.fromUrl).toContain("%5BREDACTED%5D");
    expect(output.finalUrl).toContain("%5BREDACTED%5D");
    expect(JSON.stringify(result)).not.toContain(secret);
  });

  it("redacts JSON secrets used as keys and numeric OTP echoes while preserving large integer tokens", async () => {
    const secretKey = "response-secret-key";
    const otp = "654321";
    const largeInteger = "18446744073709551615";
    const requestJson = `{"token":"${secretKey}","otp_code":${otp}}`;
    const responseJson = [
      "{",
      `  \"${secretKey}\": \"key echo\",`,
      `  \"otpEcho\": ${otp},`,
      `  \"id\": ${largeInteger},`,
      '  "visible": "ok"',
      "}",
    ].join("\n");
    const network = new FaithfulFakeNetwork([{
      headers: { "content-type": "application/json" },
      body: responseJson,
    }]);
    const fixture = await createToolFixture({ network });
    const result = await fixture.runtime.executeManualTool(
      "http_request",
      {
        url: `${PUBLIC_BASE_URL}/json-secret-key-otp`,
        method: "POST",
        body: { kind: "json", content: requestJson },
      },
      fixture.sessionId,
    );
    const body = structured<{ body: string }>(result).body;
    const parsed = JSON.parse(body) as Record<string, unknown>;

    expect(result.success).toBe(true);
    expect(parsed["[REDACTED]"]).toBe("[REDACTED]");
    expect(parsed.otpEcho).toBe("[REDACTED]");
    expect(parsed.visible).toBe("ok");
    expect(body).toContain(`\"id\": ${largeInteger}`);
    expect(body).not.toContain(secretKey);
    expect(body).not.toContain(otp);
  });

  it("redacts decoded plaintext and JSON credential echoes from base64 request bodies", async () => {
    const plainSecret = "base64-plaintext-credential";
    const jsonSecret = "base64-json-credential";
    const plainPayload = `credential=${plainSecret}&visible=request`;
    const jsonPayload = JSON.stringify({ token: jsonSecret, visible: "request" });
    const network = new FaithfulFakeNetwork([
      {
        headers: { "content-type": "text/plain" },
        body: `ordinary echo=${plainSecret}; visible=response`,
      },
      {
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ echoedValue: jsonSecret, visible: "response" }),
      },
    ]);
    const fixture = await createToolFixture({ network });
    const plain = await fixture.runtime.executeManualTool(
      "http_request",
      {
        url: `${PUBLIC_BASE_URL}/base64-plain-echo`,
        method: "POST",
        body: {
          kind: "base64",
          content: Buffer.from(plainPayload, "utf8").toString("base64"),
          contentType: "text/plain",
        },
      },
      fixture.sessionId,
    );
    const json = await fixture.runtime.executeManualTool(
      "http_request",
      {
        url: `${PUBLIC_BASE_URL}/base64-json-echo`,
        method: "POST",
        body: {
          kind: "base64",
          content: Buffer.from(jsonPayload, "utf8").toString("base64"),
          contentType: "application/json",
        },
      },
      fixture.sessionId,
    );

    expect(plain.success).toBe(true);
    expect(json.success).toBe(true);
    expect(network.attempts[0]?.body).toEqual(Buffer.from(plainPayload, "utf8"));
    expect(network.attempts[1]?.body).toEqual(Buffer.from(jsonPayload, "utf8"));
    expect(JSON.stringify(plain)).not.toContain(plainSecret);
    expect(structured<{ body: string }>(plain).body).toContain("[REDACTED]");
    const jsonBody = structured<{ body: string }>(json).body;
    expect(JSON.stringify(json)).not.toContain(jsonSecret);
    expect(JSON.parse(jsonBody)).toMatchObject({ echoedValue: "[REDACTED]", visible: "response" });
  });

  it("rejects an over-budget composite credential corpus before transport or artifact persistence", async () => {
    const protectedValues = Array.from(
      { length: 257 },
      (_, index) => `bounded-corpus-secret-${index.toString().padStart(3, "0")}`,
    );
    const network = new FaithfulFakeNetwork([{
      headers: { "content-type": "application/octet-stream" },
      body: Buffer.alloc(8 * 1024 * 1024, 0x41),
    }]);
    const fixture = await createToolFixture({ network });
    const result = await fixture.runtime.executeManualTool(
      "http_request",
      {
        url: `${PUBLIC_BASE_URL}/over-budget-secret-corpus`,
        method: "POST",
        body: {
          kind: "json",
          content: JSON.stringify({ credential: protectedValues }),
        },
      },
      fixture.sessionId,
    );

    expect(result.success).toBe(false);
    expect(structured<{ networkErrorType: string }>(result)).toMatchObject({
      networkErrorType: "policy_denied",
    });
    expect(network.attempts).toHaveLength(0);
    expect(await fixture.sessionStore.listToolOutputArtifacts(fixture.sessionId)).toEqual([]);
  }, 5_000);

  it("never persists a binary response artifact that reflects a request credential", async () => {
    const secret = "binary-secret-reflection-749318";
    const responseBytes = Buffer.concat([
      Buffer.from([0x00, 0xff, 0x10]),
      Buffer.from(`Bearer ${secret}`, "utf8"),
      Buffer.from([0x20, 0x00, 0xfe]),
    ]);
    const network = new FaithfulFakeNetwork([{
      headers: { "content-type": "application/octet-stream" },
      body: responseBytes,
    }]);
    const fixture = await createToolFixture({ network });
    const result = await fixture.runtime.executeManualTool(
      "http_request",
      {
        url: `${PUBLIC_BASE_URL}/binary-credential-echo`,
        method: "POST",
        headers: { Authorization: `Bearer ${secret}` },
      },
      fixture.sessionId,
    );
    const persisted = JSON.stringify({
      messages: await fixture.sessionStore.loadMessages(fixture.sessionId),
      events: await fixture.sessionStore.loadEvents(fixture.sessionId),
    });
    const artifacts = await fixture.sessionStore.listToolOutputArtifacts(fixture.sessionId);

    expect(network.attempts).toHaveLength(1);
    expect(result.success).toBe(false);
    expect(structured<{ networkErrorType: string }>(result)).toMatchObject({
      networkErrorType: "policy_denied",
    });
    expect(JSON.stringify(result)).not.toContain(secret);
    expect(persisted).not.toContain(secret);
    expect(artifacts).toEqual([]);
    for (const artifact of artifacts) {
      const bytes = await fixture.sessionStore.readBinaryToolOutputArtifact(artifact.uri);
      expect(bytes.includes(Buffer.from(secret, "utf8"))).toBe(false);
    }
  });

  it("redacts restructured echoes of scalar descendants from composite JSON credentials", async () => {
    const nestedSecret = "composite-inner-credential";
    const arraySecret = "composite-array-credential";
    const numericSecret = 749_318_271;
    const requestBody = JSON.stringify({
      credential: {
        nested: nestedSecret,
        list: [numericSecret, { leaf: arraySecret }],
      },
      visible: "request-visible",
    });
    const responseBody = JSON.stringify({
      ordinaryEchoes: {
        renamedFirst: nestedSecret,
        renamedSecond: arraySecret,
        renamedNumber: numericSecret,
      },
      visible: "response-visible",
      filler: "x".repeat(6_000),
    });
    const args = {
      url: `${PUBLIC_BASE_URL}/composite-credential-echo`,
      method: "POST" as const,
      body: { kind: "json" as const, content: requestBody },
      maxChars: 120,
    };
    const call: ToolCall = {
      id: "phase16-composite-credential-call",
      name: "http_request",
      arguments: args,
      rawArguments: JSON.stringify(args),
    };
    const network = new FaithfulFakeNetwork([{
      headers: { "content-type": "application/json" },
      body: responseBody,
    }]);
    const workspaceRoot = await fs.mkdtemp(path.join(os.tmpdir(), "deep-mix-phase16-composite-redaction-"));
    temporaryRoots.push(workspaceRoot);
    const hookCalls: ToolCall[] = [];
    const toolResults: ToolResult[] = [];
    const governor = new GovernorRuntime({
      workspaceRoot,
      permissionMode: "danger-full-access",
      modelClient: new ScriptedModelClient([
        { content: "", toolCalls: [call] },
        { content: "Composite credential echoes were handled safely.", toolCalls: [] },
      ]),
      networkService: network,
      environment: { ...process.env, BRAVE_SEARCH_API_KEY: undefined },
    });
    const turn = await governor.runTurn({
      prompt: "Send the declared HTTP API request now; do not write code.",
      routeOverride: "ds_direct",
      callbacks: {
        onToolStart: (toolCall) => hookCalls.push(toolCall),
        onToolEnd: (result) => toolResults.push(result),
      },
    });
    const sessionStore = new SessionStore(workspaceRoot);
    const httpResult = toolResults.find((result) => result.toolName === "http_request");
    expect(httpResult).toBeDefined();
    const output = structured<{ body: string; rawArtifactUri: string; truncated: boolean }>(httpResult!);
    const artifactText = await sessionStore.readTextToolOutputArtifact(output.rawArtifactUri);
    const persisted = JSON.stringify({
      hooks: hookCalls,
      results: toolResults,
      messages: await sessionStore.loadMessages(turn.sessionId),
      events: await sessionStore.loadEvents(turn.sessionId),
    });

    expect(network.attempts[0]?.body.toString("utf8")).toBe(requestBody);
    expect(output.truncated).toBe(true);
    for (const secret of [nestedSecret, arraySecret, String(numericSecret)]) {
      expect(JSON.stringify(httpResult)).not.toContain(secret);
      expect(artifactText).not.toContain(secret);
      expect(persisted).not.toContain(secret);
    }
    expect(JSON.parse(artifactText)).toMatchObject({
      ordinaryEchoes: {
        renamedFirst: "[REDACTED]",
        renamedSecond: "[REDACTED]",
        renamedNumber: "[REDACTED]",
      },
      visible: "response-visible",
    });
  }, 30_000);

  it("redacts a sensitive descendant map key when the response restructures it as an ordinary value", async () => {
    const secretMapKey = "SECRET-AS-MAP-KEY-749318";
    const requestBody = JSON.stringify({
      credential: { [secretMapKey]: "ordinary-value" },
      visible: "request-visible",
    });
    const responseBody = JSON.stringify({
      ordinaryField: secretMapKey,
      visible: "response-visible",
      filler: "x".repeat(6_000),
      lateOrdinaryField: secretMapKey,
    });
    const args = {
      url: `${PUBLIC_BASE_URL}/credential-map-key-echo`,
      method: "POST" as const,
      body: { kind: "json" as const, content: requestBody },
      maxChars: 160,
    };
    const call: ToolCall = {
      id: "phase16-credential-map-key-call",
      name: "http_request",
      arguments: args,
      rawArguments: JSON.stringify(args),
    };
    const network = new FaithfulFakeNetwork([{
      headers: { "content-type": "application/json" },
      body: responseBody,
    }]);
    const workspaceRoot = await fs.mkdtemp(path.join(os.tmpdir(), "deep-mix-phase16-map-key-redaction-"));
    temporaryRoots.push(workspaceRoot);
    const hookCalls: ToolCall[] = [];
    const toolResults: ToolResult[] = [];
    const governor = new GovernorRuntime({
      workspaceRoot,
      permissionMode: "danger-full-access",
      modelClient: new ScriptedModelClient([
        { content: "", toolCalls: [call] },
        { content: "The credential-key echo was handled safely.", toolCalls: [] },
      ]),
      networkService: network,
      environment: { ...process.env, BRAVE_SEARCH_API_KEY: undefined },
    });
    const turn = await governor.runTurn({
      prompt: "Send the declared HTTP API request now; do not write code.",
      routeOverride: "ds_direct",
      callbacks: {
        onToolStart: (toolCall) => hookCalls.push(toolCall),
        onToolEnd: (result) => toolResults.push(result),
      },
    });
    const sessionStore = new SessionStore(workspaceRoot);
    const httpResult = toolResults.find((result) => result.toolName === "http_request");
    expect(httpResult).toBeDefined();
    const output = structured<{ body: string; rawArtifactUri: string; truncated: boolean }>(httpResult!);
    const artifactText = await sessionStore.readTextToolOutputArtifact(output.rawArtifactUri);
    const persisted = JSON.stringify({
      hooks: hookCalls,
      results: toolResults,
      messages: await sessionStore.loadMessages(turn.sessionId),
      events: await sessionStore.loadEvents(turn.sessionId),
    });

    expect(network.attempts[0]?.body.toString("utf8")).toBe(requestBody);
    expect(output.truncated).toBe(true);
    expect(output.body).toContain("[REDACTED]");
    expect(JSON.stringify(httpResult)).not.toContain(secretMapKey);
    expect(httpResult!.output).not.toContain(secretMapKey);
    expect(artifactText).not.toContain(secretMapKey);
    expect(persisted).not.toContain(secretMapKey);
    expect(JSON.parse(artifactText)).toMatchObject({
      ordinaryField: "[REDACTED]",
      lateOrdinaryField: "[REDACTED]",
      visible: "response-visible",
    });
    expect(await sessionStore.loadProtectedToolCall(turn.sessionId, call.id)).toBeUndefined();
  }, 30_000);

  it("redacts percent-encoded and form-encoded variants of JSON request credentials", async () => {
    const secret = "json credential+/%";
    const percentEncoded = encodeURIComponent(secret);
    const formEncoded = new URLSearchParams({ value: secret }).toString().slice("value=".length);
    const network = new FaithfulFakeNetwork([{
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ percentEcho: percentEncoded, formEcho: formEncoded, visible: "ok" }),
    }]);
    const fixture = await createToolFixture({ network });
    const result = await fixture.runtime.executeManualTool(
      "http_request",
      {
        url: `${PUBLIC_BASE_URL}/json-encoded-credential-echo`,
        method: "POST",
        body: { kind: "json", content: JSON.stringify({ access_token: secret }) },
      },
      fixture.sessionId,
    );
    const body = structured<{ body: string }>(result).body;

    expect(result.success).toBe(true);
    expect(JSON.stringify(result)).not.toContain(secret);
    expect(JSON.stringify(result)).not.toContain(percentEncoded);
    expect(JSON.stringify(result)).not.toContain(formEncoded);
    expect(JSON.parse(body)).toMatchObject({
      percentEcho: "[REDACTED]",
      formEcho: "[REDACTED]",
      visible: "ok",
    });
  });

  it("redacts plaintext credential, auth, signature, and pwd assignments", async () => {
    const secrets = {
      credential: "plain-credential-value",
      auth: "plain-auth-value",
      signature: "plain-signature-value",
      pwd: "plain-pwd-value",
    };
    const responseBody = [
      `credential=${secrets.credential}`,
      `auth: ${secrets.auth}`,
      `signature=${secrets.signature}`,
      `pwd: ${secrets.pwd}`,
      "visible=ok",
    ].join("\n");
    const network = new FaithfulFakeNetwork([{
      headers: { "content-type": "text/plain" },
      body: responseBody,
    }]);
    const fixture = await createToolFixture({ network });
    const result = await fixture.runtime.executeManualTool(
      "web_fetch",
      { url: `${PUBLIC_BASE_URL}/plaintext-credential-patterns` },
      fixture.sessionId,
    );
    const content = structured<{ content: string }>(result).content;

    expect(result.success).toBe(true);
    for (const secret of Object.values(secrets)) expect(JSON.stringify(result)).not.toContain(secret);
    expect(content.match(/\[REDACTED\]/gu)).toHaveLength(4);
    expect(content).toContain("visible=ok");
  });

  it("removes URL fragments, redacts path/query secrets, and preserves ordinary author parameters", async () => {
    const sharedSecret = "PATH_QUERY_SECRET";
    const fragmentSecret = "FRAGMENT_SECRET";
    const camelPathSecret = "PathSecret749318";
    const camelMatrixSecret = "MatrixSecret864209";
    const camelQueryKeySecret = "QueryKeySecret975310";
    const args = {
      url: `${PUBLIC_BASE_URL}/${sharedSecret}/tokenCamel${camelPathSecret}/ordinary/jwtCamel${camelMatrixSecret}=opaque?token=${sharedSecret}&sessionCamel${camelQueryKeySecret}=opaque&author=Alice#access_token=${fragmentSecret}`,
      method: "GET" as const,
    };
    const toolCall: ToolCall = {
      id: "phase16-url-redaction-boundary",
      name: "http_request",
      arguments: args,
      rawArguments: JSON.stringify(args),
    };
    const network = new FaithfulFakeNetwork([{
      headers: { "content-type": "application/json" },
      body: '{"ok":true}',
    }]);
    const workspaceRoot = await fs.mkdtemp(path.join(os.tmpdir(), "deep-mix-phase16-url-redaction-"));
    temporaryRoots.push(workspaceRoot);
    const hookCalls: ToolCall[] = [];
    const governor = new GovernorRuntime({
      workspaceRoot,
      permissionMode: "danger-full-access",
      modelClient: new ScriptedModelClient([
        { content: "", toolCalls: [toolCall] },
        { content: "The URL was fetched safely.", toolCalls: [] },
      ]),
      networkService: network,
      environment: { ...process.env, BRAVE_SEARCH_API_KEY: undefined },
    });
    const turn = await governor.runTurn({
      prompt: "Use http_request to fetch the provided endpoint.",
      routeOverride: "ds_direct",
      callbacks: { onToolStart: (call) => hookCalls.push(call) },
    });
    const safeArgs = hookCalls[0]?.arguments as { url?: string } | undefined;
    if (!safeArgs?.url) throw new Error("Missing persistence-safe URL hook call.");
    const safeUrl = new URL(safeArgs.url);

    expect(safeArgs.url).not.toContain(sharedSecret);
    expect(safeArgs.url).not.toContain(fragmentSecret);
    expect(safeArgs.url).not.toContain(camelPathSecret);
    expect(safeArgs.url).not.toContain(camelMatrixSecret);
    expect(safeArgs.url).not.toContain(camelQueryKeySecret);
    expect(safeUrl.hash).toBe("");
    expect(safeUrl.pathname).toContain("REDACTED");
    expect(safeUrl.searchParams.get("[REDACTED_QUERY]")).toBe("[REDACTED]");
    expect(safeUrl.searchParams.get("author")).toBe("Alice");
    const sessionStore = new SessionStore(workspaceRoot);
    const persisted = JSON.stringify({
      messages: await sessionStore.loadMessages(turn.sessionId),
      events: await sessionStore.loadEvents(turn.sessionId),
      hooks: hookCalls,
    });
    expect(persisted).not.toContain(sharedSecret);
    expect(persisted).not.toContain(fragmentSecret);
    expect(persisted).not.toContain(camelPathSecret);
    expect(persisted).not.toContain(camelMatrixSecret);
    expect(persisted).not.toContain(camelQueryKeySecret);
    expect(persisted).toContain("author=Alice");
  }, 30_000);

  it("bounds extremely deep HTML without recursion failure and records truncation evidence", async () => {
    const depth = 180;
    const html = `<html><body><main>${"<div>".repeat(depth)}deep text${"</div>".repeat(depth)}</main></body></html>`;
    const network = new FaithfulFakeNetwork([{
      headers: { "content-type": "text/html" },
      body: html,
    }]);
    const fixture = await createToolFixture({ network });
    const result = await fixture.runtime.executeManualTool(
      "web_fetch",
      { url: `${PUBLIC_BASE_URL}/deep-html` },
      fixture.sessionId,
    );
    const output = structured<{
      format: string;
      truncated: boolean;
      rawArtifactUri: string;
      warnings: string[];
    }>(result);

    expect(result.success).toBe(true);
    expect(output).toMatchObject({ format: "html_markdown", truncated: true });
    expect(output.warnings.join(" ")).toContain("depth, node, or character budget");
    expect(output.rawArtifactUri).toMatch(/^artifact:\/\/tool-outputs\//u);
    expect(result.networkAudit).toMatchObject({ requestCount: 1, bytesReceived: Buffer.byteLength(html) });
  });
});
