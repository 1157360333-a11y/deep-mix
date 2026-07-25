import { session, type Session } from "electron";
import { ProxyAgent } from "proxy-agent";

import {
  PinnedHttpProxyAgent,
  consumeFetchResponse,
  createNetworkAbortError,
  createNetworkTimeoutError,
  isNetworkResponseHandlingError,
  requestWithNodeTransport,
  runBoundedNetworkOperation,
  type ToolNetworkRequestOptions,
  type ToolNetworkResponse,
  type ToolNetworkService,
} from "../../../../packages/tool-runtime/src/network/index.js";

async function fetchWithSession(
  activeSession: Session,
  url: URL,
  init: RequestInit,
  options: ToolNetworkRequestOptions,
): Promise<ToolNetworkResponse> {
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
    const response = await activeSession.fetch(url.toString(), {
      ...init,
      credentials: "omit",
      signal: controller.signal,
      bypassCustomProtocolHandlers: true,
    });
    return await consumeFetchResponse(response, options);
  } catch (error) {
    if (timedOut) throw createNetworkTimeoutError(options.timeoutMs);
    if (controller.signal.aborted && !init.signal?.aborted) throw createNetworkAbortError(controller.signal.reason);
    throw error;
  } finally {
    clearTimeout(timeout);
    init.signal?.removeEventListener("abort", onAbort);
  }
}

function electronProxyDecision(proxyPlan: string):
  | { kind: "direct" }
  | { kind: "empty" }
  | { kind: "unsupported" }
  | { kind: "proxy"; proxyUrl: string } {
  const entry = proxyPlan.split(";").map((value) => value.trim()).find(Boolean);
  if (!entry) return { kind: "empty" };
  if (/^DIRECT$/iu.test(entry)) return { kind: "direct" };
  const match = /^(PROXY|HTTP|HTTPS|SOCKS|SOCKS4|SOCKS5)\s+(.+)$/iu.exec(entry);
  if (!match) return { kind: "unsupported" };
  const [, type, endpoint] = match;
  const scheme = ({
    proxy: "http",
    http: "http",
    https: "https",
    socks: "socks",
    socks4: "socks4",
    socks5: "socks5",
  } as const)[type!.toLocaleLowerCase() as "proxy" | "http" | "https" | "socks" | "socks4" | "socks5"];
  return { kind: "proxy", proxyUrl: `${scheme}://${endpoint}` };
}

export function electronProxyUrl(proxyPlan: string): string | undefined {
  const decision = electronProxyDecision(proxyPlan);
  return decision.kind === "proxy" ? decision.proxyUrl : undefined;
}

async function pinnedRequestWithElectronProxy(
  systemSession: Session,
  url: URL,
  init: RequestInit,
  options: ToolNetworkRequestOptions,
): Promise<ToolNetworkResponse> {
  let agent: ProxyAgent | PinnedHttpProxyAgent | undefined;
  try {
    if (options.route === "system") {
      const proxyPlan = await runBoundedNetworkOperation(
        systemSession.resolveProxy(url.toString()),
        { signal: init.signal, timeoutMs: options.timeoutMs },
      );
      const decision = electronProxyDecision(proxyPlan);
      if (decision.kind === "direct" || decision.kind === "empty") {
        throw Object.assign(new Error("The planned system proxy route is no longer available."), {
          code: "ERR_PROXY_ROUTE_CHANGED",
        });
      }
      if (decision.kind === "unsupported") {
        throw Object.assign(new Error("The resolved system proxy type is unsupported for a pinned request."), {
          code: "ERR_PROXY_UNSUPPORTED",
        });
      }
      const proxyUrl = decision.proxyUrl;
      agent = url.protocol === "http:" && options.pinnedAddress && /^https?:/iu.test(proxyUrl)
        ? new PinnedHttpProxyAgent(proxyUrl)
        : new ProxyAgent({ getProxyForUrl: () => proxyUrl });
    }
    return await requestWithNodeTransport(url, init, options, agent);
  } catch (error) {
    if (options.route !== "system" || isNetworkResponseHandlingError(error)) throw error;
    if ((error as NodeJS.ErrnoException).code === "ERR_PROXY_UNSUPPORTED") throw error;
    throw Object.assign(new Error("System proxy request failed.", { cause: error }), {
      code: "ERR_PROXY_REQUEST_FAILED",
    });
  } finally {
    agent?.destroy();
  }
}

export async function createElectronToolNetworkService(
  sessionProvider: Pick<typeof session, "fromPartition"> = session,
): Promise<ToolNetworkService> {
  const systemSession = sessionProvider.fromPartition("deep-mix:web-search-system", { cache: false });
  const directSession = sessionProvider.fromPartition("deep-mix:web-search-direct", { cache: false });
  await Promise.all([
    systemSession.setProxy({ mode: "system" }),
    directSession.setProxy({ mode: "direct" }),
  ]);

  return {
    plan: async (url) => {
      const resolved = await systemSession.resolveProxy(url.toString());
      const decision = electronProxyDecision(resolved);
      const distinct = decision.kind === "proxy" || decision.kind === "unsupported";
      return distinct
        ? {
            routes: [
              { route: "system", source: "electron_system" },
              { route: "direct", source: "direct" },
            ],
            systemRouteDistinct: true,
          }
        : {
            routes: [{ route: "direct", source: "direct" }],
            systemRouteDistinct: false,
          };
    },
    request: (url, init, options) => options.pinnedAddress
      ? pinnedRequestWithElectronProxy(systemSession, url, init, options)
      : fetchWithSession(options.route === "system" ? systemSession : directSession, url, init, options),
    dispose: async () => {
      await Promise.all([
        systemSession.closeAllConnections(),
        directSession.closeAllConnections(),
      ]);
    },
  };
}
