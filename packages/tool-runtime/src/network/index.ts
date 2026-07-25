import { createHash } from "node:crypto";
import http from "node:http";
import https from "node:https";
import net from "node:net";

import { HttpProxyAgent } from "http-proxy-agent";

export type ToolNetworkRoute = "system" | "direct";

export type ToolNetworkRouteSource =
  | "electron_system"
  | "windows_system"
  | "macos_system"
  | "environment"
  | "direct";

export interface ToolNetworkRoutePlanEntry {
  route: ToolNetworkRoute;
  source: ToolNetworkRouteSource;
}

export interface ToolNetworkRoutePlan {
  routes: ToolNetworkRoutePlanEntry[];
  systemRouteDistinct: boolean;
}

/**
 * A DNS result that has already passed the higher-level network policy. When
 * supplied, transports must connect to this address without resolving the
 * original hostname again. The original hostname is retained for Host/SNI.
 */
export interface ToolNetworkPinnedAddress {
  hostname: string;
  address: string;
  family: 4 | 6;
}

export interface ToolNetworkResolvedAddress {
  address: string;
  family: 4 | 6;
}

export interface ToolNetworkResponseHead {
  status: number;
  ok: boolean;
  headers: Record<string, string>;
}

export interface ToolNetworkResponseConsumer {
  onResponse?(response: ToolNetworkResponseHead): void | Promise<void>;
  /** Counts wire bytes before any response/body limit can reject the chunk. */
  onChunkReceived?(byteLength: number): void | Promise<void>;
  onChunk?(chunk: Uint8Array): void | Promise<void>;
}

export interface ToolNetworkRequestOptions {
  route: ToolNetworkRoute;
  timeoutMs: number;
  maxResponseBytes: number;
  /** A policy-validated target address. Safe HTTP callers always set this. */
  pinnedAddress?: ToolNetworkPinnedAddress;
  /** Receive headers first and then response chunks in wire order. */
  bodyConsumer?: ToolNetworkResponseConsumer;
  /** Defaults to true. A callback can decide after response headers arrive. */
  collectBody?: boolean | ((response: ToolNetworkResponseHead) => boolean);
}

export interface ToolNetworkResponse extends ToolNetworkResponseHead {
  body: Uint8Array;
  /** Actual decoded transfer bytes consumed from the response stream. */
  sizeBytes?: number;
  /** SHA-256 of the bytes represented by sizeBytes. */
  sha256?: string;
}

export interface ToolNetworkService {
  /** Optional deterministic resolver seam used by safe-http and fake networks. */
  resolveDns?(
    hostname: string,
    options?: { signal?: AbortSignal },
  ): Promise<ToolNetworkResolvedAddress[]>;
  plan(url: URL): Promise<ToolNetworkRoutePlan>;
  request(
    url: URL,
    init: RequestInit,
    options: ToolNetworkRequestOptions,
  ): Promise<ToolNetworkResponse>;
  dispose(): Promise<void>;
}

export function createNetworkTimeoutError(timeoutMs: number): Error {
  return Object.assign(new Error(`Network request timed out after ${timeoutMs} ms.`), {
    code: "ETIMEDOUT",
  });
}

export function createNetworkAbortError(reason?: unknown): Error {
  return Object.assign(new Error("Network request aborted.", reason === undefined ? undefined : { cause: reason }), {
    code: "ABORT_ERR",
  });
}

export function runBoundedNetworkOperation<T>(
  operation: Promise<T>,
  options: { signal?: AbortSignal | null; timeoutMs: number },
): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    let settled = false;
    let timeout: ReturnType<typeof setTimeout> | undefined;
    const cleanup = () => {
      if (timeout) clearTimeout(timeout);
      options.signal?.removeEventListener("abort", onAbort);
    };
    const resolveOnce = (value: T) => {
      if (settled) return;
      settled = true;
      cleanup();
      resolve(value);
    };
    const rejectOnce = (error: unknown) => {
      if (settled) return;
      settled = true;
      cleanup();
      reject(error);
    };
    const onAbort = () => rejectOnce(createNetworkAbortError(options.signal?.reason));
    options.signal?.addEventListener("abort", onAbort, { once: true });
    timeout = setTimeout(
      () => rejectOnce(createNetworkTimeoutError(options.timeoutMs)),
      Math.max(1, options.timeoutMs),
    );
    operation.then(resolveOnce, rejectOnce);
    if (options.signal?.aborted) onAbort();
  });
}

export function createNetworkResponseTooLargeError(maxResponseBytes: number): Error {
  return Object.assign(new Error(`Network response exceeded ${maxResponseBytes} bytes.`), {
    code: "ERR_RESPONSE_TOO_LARGE",
  });
}

function normalizeNetworkResponseConsumerError(error: unknown): unknown {
  if (typeof error === "object" && error && "networkErrorType" in error) return error;
  if (typeof error === "object" && error && "code" in error && error.code === "ERR_NETWORK_RESPONSE_CONSUMER") {
    return error;
  }
  return Object.assign(new Error("Network response consumer failed.", { cause: error }), {
    code: "ERR_NETWORK_RESPONSE_CONSUMER",
  });
}

/** Policy/content/write errors raised while consuming a response must never be reclassified as proxy failures. */
export function isNetworkResponseHandlingError(error: unknown): boolean {
  if (typeof error !== "object" || !error) return false;
  return "networkErrorType" in error || ("code" in error && error.code === "ERR_NETWORK_RESPONSE_CONSUMER");
}

function assertRequestOptions(options: ToolNetworkRequestOptions): void {
  if (!Number.isFinite(options.timeoutMs) || options.timeoutMs <= 0) {
    throw new Error("Network timeout must be a positive finite number.");
  }
  if (!Number.isSafeInteger(options.maxResponseBytes) || options.maxResponseBytes < 0) {
    throw new Error("Network response limit must be a non-negative safe integer.");
  }
}

function declaredContentLength(headers: Record<string, string>): number | undefined {
  const entry = Object.entries(headers).find(([name]) => name.toLocaleLowerCase() === "content-length")?.[1];
  if (entry === undefined || !/^\d+$/u.test(entry.trim())) return undefined;
  const parsed = Number(entry);
  return Number.isSafeInteger(parsed) ? parsed : undefined;
}

async function readStreamBody(input: ReadableStream<Uint8Array>): Promise<Buffer> {
  const reader = input.getReader();
  const chunks: Buffer[] = [];
  let size = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    const chunk = Buffer.from(value);
    size += chunk.byteLength;
    chunks.push(chunk);
  }
  return Buffer.concat(chunks, size);
}

async function requestBodyBuffer(body: RequestInit["body"]): Promise<Buffer | undefined> {
  if (body === undefined || body === null) return undefined;
  if (typeof body === "string") return Buffer.from(body);
  if (body instanceof URLSearchParams) return Buffer.from(body.toString());
  if (body instanceof ArrayBuffer) return Buffer.from(body);
  if (ArrayBuffer.isView(body)) {
    return Buffer.from(body.buffer, body.byteOffset, body.byteLength);
  }
  if (body instanceof Blob) return Buffer.from(await body.arrayBuffer());
  if (body instanceof ReadableStream) return readStreamBody(body as ReadableStream<Uint8Array>);
  throw Object.assign(new Error("Unsupported network request body type."), {
    code: "ERR_UNSUPPORTED_REQUEST_BODY",
  });
}

function canonicalHostname(value: string): string {
  return value.replace(/^\[|\]$/gu, "").toLocaleLowerCase();
}

function headersWithPinnedHost(
  url: URL,
  headers: RequestInit["headers"],
  pinnedAddress?: ToolNetworkPinnedAddress,
): Record<string, string> {
  const normalized = new Headers(headers);
  if (pinnedAddress && !normalized.has("host")) normalized.set("host", url.host);
  return Object.fromEntries(normalized.entries());
}

function validatePinnedAddress(url: URL, pinnedAddress: ToolNetworkPinnedAddress): void {
  if (canonicalHostname(url.hostname) !== canonicalHostname(pinnedAddress.hostname)) {
    throw Object.assign(new Error("Pinned address hostname does not match the request URL."), {
      code: "ERR_NETWORK_PIN_MISMATCH",
    });
  }
  if (net.isIP(pinnedAddress.address) !== pinnedAddress.family) {
    throw Object.assign(new Error("Pinned address family does not match its literal address."), {
      code: "ERR_NETWORK_PIN_MISMATCH",
    });
  }
}

async function finalizeChunks(input: {
  head: ToolNetworkResponseHead;
  chunks: AsyncIterable<Uint8Array>;
  options: ToolNetworkRequestOptions;
  cancel?: () => void | Promise<void>;
}): Promise<ToolNetworkResponse> {
  assertRequestOptions(input.options);
  try {
    await input.options.bodyConsumer?.onResponse?.(input.head);
  } catch (error) {
    await input.cancel?.();
    throw normalizeNetworkResponseConsumerError(error);
  }
  const contentLength = declaredContentLength(input.head.headers);
  if (contentLength !== undefined && contentLength > input.options.maxResponseBytes) {
    await input.cancel?.();
    throw createNetworkResponseTooLargeError(input.options.maxResponseBytes);
  }

  const collectBody = typeof input.options.collectBody === "function"
    ? input.options.collectBody(input.head)
    : input.options.collectBody !== false;
  const chunks: Buffer[] = [];
  const hash = createHash("sha256");
  let sizeBytes = 0;
  for await (const value of input.chunks) {
    const chunk = Buffer.from(value);
    sizeBytes += chunk.byteLength;
    try {
      await input.options.bodyConsumer?.onChunkReceived?.(chunk.byteLength);
    } catch (error) {
      await input.cancel?.();
      throw normalizeNetworkResponseConsumerError(error);
    }
    if (sizeBytes > input.options.maxResponseBytes) {
      await input.cancel?.();
      throw createNetworkResponseTooLargeError(input.options.maxResponseBytes);
    }
    hash.update(chunk);
    try {
      await input.options.bodyConsumer?.onChunk?.(chunk);
    } catch (error) {
      await input.cancel?.();
      throw normalizeNetworkResponseConsumerError(error);
    }
    if (collectBody) chunks.push(chunk);
  }
  return {
    ...input.head,
    body: collectBody ? Buffer.concat(chunks, sizeBytes) : new Uint8Array(),
    sizeBytes,
    sha256: hash.digest("hex"),
  };
}

export function headersToRecord(headers: Headers): Record<string, string> {
  return Object.fromEntries(headers.entries());
}

export function nodeResponseHeaders(headers: http.IncomingHttpHeaders): Record<string, string> {
  return Object.fromEntries(Object.entries(headers).flatMap(([name, value]) => {
    if (value === undefined) return [];
    return [[name, Array.isArray(value) ? value.join(", ") : String(value)]];
  }));
}

export async function consumeFetchResponse(
  response: Response,
  options: ToolNetworkRequestOptions,
): Promise<ToolNetworkResponse> {
  const head: ToolNetworkResponseHead = {
    status: response.status,
    ok: response.ok,
    headers: headersToRecord(response.headers),
  };
  const reader = response.body?.getReader();
  async function* chunks(): AsyncGenerator<Uint8Array> {
    if (!reader) return;
    for (;;) {
      const { done, value } = await reader.read();
      if (done) return;
      yield value;
    }
  }
  return finalizeChunks({
    head,
    chunks: chunks(),
    options,
    cancel: reader ? () => reader.cancel().catch(() => undefined) : undefined,
  });
}

/**
 * Node HTTP(S) transport shared by CLI and pin-aware Desktop requests. A
 * pinned request connects by literal IP while retaining the original Host and
 * TLS SNI, so neither the OS nor an HTTP CONNECT proxy resolves the target.
 */
export async function requestWithNodeTransport(
  url: URL,
  init: RequestInit,
  options: ToolNetworkRequestOptions,
  agent?: http.Agent,
): Promise<ToolNetworkResponse> {
  assertRequestOptions(options);
  if (options.pinnedAddress) validatePinnedAddress(url, options.pinnedAddress);
  const body = await requestBodyBuffer(init.body);
  const pinned = options.pinnedAddress;
  const hostname = pinned?.address ?? canonicalHostname(url.hostname);
  const port = url.port ? Number(url.port) : url.protocol === "https:" ? 443 : 80;
  const client = url.protocol === "https:" ? https : http;

  return new Promise<ToolNetworkResponse>((resolve, reject) => {
    let settled = false;
    let timedOut = false;
    const finishResolve = (value: ToolNetworkResponse) => {
      if (settled) return;
      settled = true;
      resolve(value);
    };
    const finishReject = (error: unknown) => {
      if (settled) return;
      settled = true;
      reject(error);
    };
    const request = client.request({
      protocol: url.protocol,
      hostname,
      port,
      path: `${url.pathname}${url.search}`,
      method: init.method ?? "GET",
      headers: headersWithPinnedHost(url, init.headers, pinned),
      agent,
      ...(url.protocol === "https:" && pinned && net.isIP(pinned.hostname) === 0
        ? { servername: canonicalHostname(pinned.hostname) }
        : {}),
    }, (response) => {
      const status = response.statusCode ?? 0;
      void finalizeChunks({
        head: {
          status,
          ok: status >= 200 && status < 300,
          headers: nodeResponseHeaders(response.headers),
        },
        chunks: response as AsyncIterable<Uint8Array>,
        options,
        cancel: () => {
          response.destroy();
        },
      }).then(finishResolve, (error) => {
        response.destroy(error as Error);
        finishReject(error);
      });
    });

    const onAbort = () => request.destroy(createNetworkAbortError(init.signal?.reason));
    if (init.signal?.aborted) onAbort();
    else init.signal?.addEventListener("abort", onAbort, { once: true });
    const timeout = setTimeout(() => {
      timedOut = true;
      request.destroy(createNetworkTimeoutError(options.timeoutMs));
    }, options.timeoutMs);
    request.on("error", (error) => finishReject(timedOut ? createNetworkTimeoutError(options.timeoutMs) : error));
    request.on("close", () => {
      clearTimeout(timeout);
      init.signal?.removeEventListener("abort", onAbort);
    });
    request.end(body);
  });
}

type HttpProxyRequest = Parameters<HttpProxyAgent<string>["setRequestProps"]>[0];
type HttpProxyConnectOptions = Parameters<HttpProxyAgent<string>["setRequestProps"]>[1];

/**
 * Forward-proxy agent for a policy-pinned plain-HTTP target. The absolute-form
 * request target contains the validated IP, while the end-server Host header
 * remains the original authority. This prevents the proxy from resolving the
 * untrusted hostname a second time after SSRF validation.
 */
export class PinnedHttpProxyAgent extends HttpProxyAgent<string> {
  public override setRequestProps(req: HttpProxyRequest, opts: HttpProxyConnectOptions): void {
    const originalHost = req.getHeader("host");
    const targetHost = opts.host;
    if (!targetHost) throw new Error("Pinned forward-proxy request omitted its target host.");
    const pinnedHost = net.isIPv6(targetHost) ? `[${targetHost}]` : targetHost;
    req.setHeader("host", pinnedHost);
    try {
      super.setRequestProps(req, opts);
    } finally {
      if (originalHost === undefined) req.removeHeader("host");
      else req.setHeader("host", originalHost);
    }
  }
}

export function createDirectToolNetworkService(): ToolNetworkService {
  return {
    plan: async () => ({
      routes: [{ route: "direct", source: "direct" }],
      systemRouteDistinct: false,
    }),
    request: async (url, init, options) => {
      if (options.pinnedAddress) return requestWithNodeTransport(url, init, options);
      assertRequestOptions(options);
      const controller = new AbortController();
      let timedOut = false;
      const onAbort = () => controller.abort(createNetworkAbortError(init.signal?.reason));
      if (init.signal?.aborted) onAbort();
      else init.signal?.addEventListener("abort", onAbort, { once: true });
      const timeout = setTimeout(() => {
        timedOut = true;
        controller.abort(createNetworkTimeoutError(options.timeoutMs));
      }, options.timeoutMs);
      try {
        const response = await fetch(url, { ...init, signal: controller.signal });
        return await consumeFetchResponse(response, options);
      } catch (error) {
        if (timedOut) throw createNetworkTimeoutError(options.timeoutMs);
        if (controller.signal.aborted && !init.signal?.aborted) throw createNetworkAbortError(controller.signal.reason);
        throw error;
      } finally {
        clearTimeout(timeout);
        init.signal?.removeEventListener("abort", onAbort);
      }
    },
    dispose: async () => undefined,
  };
}

export * from "./safe-http.js";
