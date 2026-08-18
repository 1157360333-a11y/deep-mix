import type {
  ToolAvailability,
  ToolErrorType,
  ToolResult,
  ToolStructuredError,
} from "../../../../shared-schema/src/index.js";
import type { ToolNetworkResponse, ToolNetworkRoute } from "../../network/index.js";
import type {
  RuntimeToolExecutionContext,
  RuntimeToolSpec,
  ToolModule,
  ToolModuleContext,
} from "../../tool-module.js";
import { createHttpRequest, createWebFetch } from "./content-tools.js";
import { createDownloadFile } from "./download-file.js";

const BRAVE_SEARCH_HOST = "api.search.brave.com";
const BING_SEARCH_HOST = "www.bing.com";
const BING_REGIONAL_SEARCH_HOST = "cn.bing.com";
const SEARCH_REDIRECT_STATUSES = new Set([301, 302, 303, 307, 308]);
const MAX_SEARCH_REDIRECTS = 1;
const SEARCH_ATTEMPT_TIMEOUT_MS = 6_000;
const SEARCH_TOTAL_TIMEOUT_MS = 20_000;
const MIN_REMAINING_ATTEMPT_MS = 2_000;
const PROXY_PLAN_TIMEOUT_MS = 3_000;
const MAX_RESPONSE_BYTES = 2 * 1024 * 1024;
const MAX_TITLE_CHARS = 240;
const MAX_SNIPPET_CHARS = 800;
const MAX_URL_CHARS = 2_048;

type SearchFreshness = "day" | "week" | "month" | "year";
type SearchProvider = "brave" | "bing";

interface WebSearchArgs {
  query: string;
  maxResults?: number;
  freshness?: SearchFreshness;
}

interface WebSearchResultItem {
  title: string;
  url: string;
  snippet: string;
}

interface WebSearchAttempt {
  provider: SearchProvider;
  route: ToolNetworkRoute;
  outcome: "success" | "error";
  errorType?: ToolErrorType;
  httpStatus?: number;
}

interface WebSearchOutput {
  kind: "web_search";
  query: string;
  provider: SearchProvider;
  networkRoute: ToolNetworkRoute;
  fallbackUsed: boolean;
  attempts: WebSearchAttempt[];
  resultCount: number;
  results: WebSearchResultItem[];
  warnings: string[];
}

interface BraveSearchResponse {
  web?: {
    results?: Array<{
      title?: unknown;
      url?: unknown;
      description?: unknown;
    }>;
  };
}

class SearchAttemptError extends Error {
  public constructor(
    message: string,
    public readonly errorType: ToolErrorType,
    public readonly options: {
      httpStatus?: number;
      allowRouteFallback: boolean;
      allowProviderFallback: boolean;
    },
    cause?: unknown,
  ) {
    super(message, cause === undefined ? undefined : { cause });
    this.name = "SearchAttemptError";
  }
}

function resolveBraveSearchApiKey(context: ToolModuleContext): string | undefined {
  const fromEnvironment = context.environment.BRAVE_SEARCH_API_KEY?.trim();
  if (fromEnvironment) return fromEnvironment;
  const fromSettings = context.settings.webSearch?.braveApiKey;
  return typeof fromSettings === "string" && fromSettings.trim() ? fromSettings.trim() : undefined;
}

function decodeHtmlEntities(value: string): string {
  const named: Record<string, string> = {
    amp: "&",
    apos: "'",
    gt: ">",
    lt: "<",
    nbsp: " ",
    quot: "\"",
  };
  return value.replace(/&(#x[\da-f]+|#\d+|amp|apos|gt|lt|nbsp|quot);/giu, (_match, entity: string) => {
    const normalized = entity.toLocaleLowerCase();
    if (normalized.startsWith("#")) {
      const radix = normalized.startsWith("#x") ? 16 : 10;
      const digits = normalized.slice(radix === 16 ? 2 : 1);
      const codePoint = Number.parseInt(digits, radix);
      if (Number.isInteger(codePoint) && codePoint >= 0 && codePoint <= 0x10ffff) {
        try {
          return String.fromCodePoint(codePoint);
        } catch {
          return "�";
        }
      }
      return "�";
    }
    return named[normalized] ?? "";
  });
}

function plainText(value: string): string {
  let text = value;
  for (let pass = 0; pass < 2; pass += 1) {
    text = decodeHtmlEntities(text)
      .replace(/<!--[\s\S]*?-->/gu, " ")
      .replace(/<(script|style)\b[^>]*>[\s\S]*?<\/\1>/giu, " ")
      .replace(/<[^>]*>/gu, " ");
  }
  return text
    .replace(/\s+/gu, " ")
    .replace(/\s+([.,!?;:，。！？；：])/gu, "$1")
    .trim();
}

function boundedText(value: unknown, maxChars: number): string {
  if (typeof value !== "string") return "";
  const text = plainText(value);
  if (text.length <= maxChars) return text;
  return `${text.slice(0, Math.max(0, maxChars - 1)).trimEnd()}…`;
}

function redactNetworkSecrets(value: string): string {
  return value
    .replace(/(?:https?|socks(?:4|5)?|pac\+(?:https?|file)):\/\/[^\s;]+/giu, "[network-endpoint]")
    .replace(/\b(?:127\.0\.0\.1|localhost):\d{1,5}\b/giu, "[local-network-endpoint]")
    .replace(/\[::1\]:\d{1,5}/giu, "[local-network-endpoint]");
}

function safeResultUrl(value: unknown): string | undefined {
  if (typeof value !== "string") return undefined;
  const decoded = decodeHtmlEntities(decodeHtmlEntities(value)).trim();
  if (decoded.length > MAX_URL_CHARS) return undefined;
  try {
    const url = new URL(decoded);
    if (url.protocol !== "http:" && url.protocol !== "https:") return undefined;
    return url.toString();
  } catch {
    return undefined;
  }
}

function extractXmlTag(block: string, tagName: string): string | undefined {
  const match = new RegExp(`<${tagName}\\b[^>]*>([\\s\\S]*?)<\\/${tagName}>`, "iu").exec(block);
  const value = match?.[1]?.trim();
  if (!value) return undefined;
  const cdata = /^<!\[CDATA\[([\s\S]*)\]\]>$/u.exec(value);
  return cdata?.[1] ?? value;
}

function normalizeResult(input: {
  title?: unknown;
  url?: unknown;
  snippet?: unknown;
}): WebSearchResultItem | undefined {
  const url = safeResultUrl(input.url);
  if (!url) return undefined;
  return {
    title: boundedText(input.title, MAX_TITLE_CHARS) || url,
    url,
    snippet: boundedText(input.snippet, MAX_SNIPPET_CHARS),
  };
}

function responseBody(response: ToolNetworkResponse): string {
  return Buffer.from(response.body).toString("utf8");
}

function responseHeader(response: ToolNetworkResponse, name: string): string | undefined {
  const target = name.toLocaleLowerCase();
  return Object.entries(response.headers).find(([key]) => key.toLocaleLowerCase() === target)?.[1];
}

function providerHttpError(response: ToolNetworkResponse): SearchAttemptError {
  const detail = boundedText(responseBody(response), 300);
  const message = `Search provider returned HTTP ${response.status}${detail ? `: ${detail}` : "."}`;
  if (response.status === 401 || response.status === 403) {
    return new SearchAttemptError(message, "authentication_failed", {
      httpStatus: response.status,
      allowRouteFallback: false,
      allowProviderFallback: false,
    });
  }
  if (response.status === 429) {
    return new SearchAttemptError(message, "rate_limited", {
      httpStatus: response.status,
      allowRouteFallback: false,
      allowProviderFallback: false,
    });
  }
  const clientError = response.status >= 400 && response.status < 500;
  return new SearchAttemptError(message, "provider_error", {
    httpStatus: response.status,
    allowRouteFallback: false,
    allowProviderFallback: !clientError,
  });
}

function collectErrorDetails(error: unknown): { messages: string[]; codes: string[] } {
  const messages: string[] = [];
  const codes: string[] = [];
  const seen = new Set<unknown>();
  let current: unknown = error;
  for (let depth = 0; depth < 6 && current && !seen.has(current); depth += 1) {
    seen.add(current);
    if (current instanceof Error && current.message) messages.push(current.message);
    if (typeof current === "object" && "code" in current) {
      const code = String((current as { code?: unknown }).code ?? "");
      if (/^[A-Z0-9_-]{2,80}$/u.test(code)) codes.push(code);
    }
    current = current instanceof Error ? (current as Error & { cause?: unknown }).cause : undefined;
  }
  return { messages: [...new Set(messages)], codes: [...new Set(codes)] };
}

function classifyNetworkFailure(error: unknown): SearchAttemptError {
  if (error instanceof SearchAttemptError) return error;
  const details = collectErrorDetails(error);
  const combined = `${details.messages.join("; ")} ${details.codes.join(" ")}`;
  const code = details.codes[0];
  if (/UND_ERR_CONNECT_TIMEOUT|UND_ERR_HEADERS_TIMEOUT|UND_ERR_BODY_TIMEOUT|ETIMEDOUT|ESOCKETTIMEDOUT|ERR_TIMED_OUT|ABORT_ERR|\babort(?:ed)?\b|timed out/iu.test(combined)) {
    return new SearchAttemptError(
      `Search network request timed out${code ? ` (${code})` : "."}`,
      "timeout",
      { allowRouteFallback: true, allowProviderFallback: true },
      error,
    );
  }
  if (/CERT_|ERR_TLS|SELF_SIGNED|UNABLE_TO_VERIFY|CERTIFICATE|SSL_/iu.test(combined)) {
    return new SearchAttemptError(
      `Search TLS certificate validation failed${code ? ` (${code})` : "."}`,
      "provider_error",
      { allowRouteFallback: false, allowProviderFallback: false },
      error,
    );
  }
  if (/UND_ERR_REDIRECT/iu.test(combined)) {
    return new SearchAttemptError(
      `Search provider redirect failed${code ? ` (${code})` : "."}`,
      "provider_error",
      { allowRouteFallback: false, allowProviderFallback: false },
      error,
    );
  }
  if (/ENOTFOUND|EAI_AGAIN|ECONNREFUSED|ECONNRESET|ENETUNREACH|EHOSTUNREACH|EPIPE|UND_ERR_SOCKET|UND_ERR_CONNECT|ERR_NAME_NOT_RESOLVED|ERR_PROXY_CONNECTION_FAILED|ERR_TUNNEL_CONNECTION_FAILED|ERR_INTERNET_DISCONNECTED|fetch failed|socket/iu.test(combined)) {
    return new SearchAttemptError(
      `Search network connection failed${code ? ` (${code})` : "."}`,
      "network_error",
      { allowRouteFallback: true, allowProviderFallback: true },
      error,
    );
  }
  return new SearchAttemptError(
    boundedText(redactNetworkSecrets(details.messages[0] || "Search provider request failed."), 400),
    "provider_error",
    { allowRouteFallback: false, allowProviderFallback: true },
    error,
  );
}

async function fetchSearchResponse(input: {
  url: URL;
  headers: Record<string, string>;
  allowedHosts: readonly string[];
  route: ToolNetworkRoute;
  timeoutMs: number;
  context: ToolModuleContext;
}): Promise<ToolNetworkResponse> {
  const deadline = Date.now() + input.timeoutMs;
  const allowed = new Set(input.allowedHosts.map((host) => host.toLocaleLowerCase()));
  let currentUrl = input.url;
  for (let redirectCount = 0; redirectCount <= MAX_SEARCH_REDIRECTS; redirectCount += 1) {
    const remaining = deadline - Date.now();
    if (remaining <= 0) throw classifyNetworkFailure(Object.assign(new Error("Search attempt timed out."), { code: "ETIMEDOUT" }));
    let response: ToolNetworkResponse;
    try {
      response = await input.context.network.request(currentUrl, {
        method: "GET",
        headers: input.headers,
        redirect: "manual",
      }, {
        route: input.route,
        timeoutMs: remaining,
        maxResponseBytes: MAX_RESPONSE_BYTES,
      });
    } catch (error) {
      throw classifyNetworkFailure(error);
    }
    if (!SEARCH_REDIRECT_STATUSES.has(response.status)) return response;

    const location = responseHeader(response, "location");
    if (!location) {
      throw new SearchAttemptError(
        `Search provider returned HTTP ${response.status} without a redirect location.`,
        "provider_error",
        { httpStatus: response.status, allowRouteFallback: false, allowProviderFallback: false },
      );
    }
    if (redirectCount >= MAX_SEARCH_REDIRECTS) {
      throw new SearchAttemptError(
        `Search provider exceeded the ${MAX_SEARCH_REDIRECTS}-redirect limit.`,
        "provider_error",
        { httpStatus: response.status, allowRouteFallback: false, allowProviderFallback: false },
      );
    }
    const target = new URL(location, currentUrl);
    const targetHost = target.hostname.toLocaleLowerCase();
    if (target.protocol !== "https:") {
      throw new SearchAttemptError(
        `Search redirect target must use HTTPS: ${target.protocol}`,
        "provider_error",
        { httpStatus: response.status, allowRouteFallback: false, allowProviderFallback: false },
      );
    }
    if (!allowed.has(targetHost)) {
      throw new SearchAttemptError(
        `Search redirect target host is not allowed: ${targetHost}.`,
        "provider_error",
        { httpStatus: response.status, allowRouteFallback: false, allowProviderFallback: false },
      );
    }
    currentUrl = target;
  }
  throw new SearchAttemptError(
    "Search provider redirect handling did not terminate.",
    "provider_error",
    { allowRouteFallback: false, allowProviderFallback: false },
  );
}

function buildBraveUrl(args: WebSearchArgs): URL {
  const url = new URL(`https://${BRAVE_SEARCH_HOST}/res/v1/web/search`);
  url.searchParams.set("q", args.query);
  url.searchParams.set("count", String(args.maxResults ?? 5));
  url.searchParams.set("safesearch", "moderate");
  if (args.freshness) {
    url.searchParams.set("freshness", ({ day: "pd", week: "pw", month: "pm", year: "py" })[args.freshness]);
  }
  return url;
}

function buildBingUrl(args: WebSearchArgs): URL {
  const url = new URL(`https://${BING_SEARCH_HOST}/search`);
  url.searchParams.set("format", "rss");
  url.searchParams.set("q", args.query);
  return url;
}

async function searchProvider(input: {
  provider: SearchProvider;
  args: WebSearchArgs;
  route: ToolNetworkRoute;
  timeoutMs: number;
  apiKey?: string;
  context: ToolModuleContext;
}): Promise<WebSearchResultItem[]> {
  if (input.provider === "brave") {
    const response = await fetchSearchResponse({
      url: buildBraveUrl(input.args),
      headers: { Accept: "application/json", "X-Subscription-Token": input.apiKey! },
      allowedHosts: [BRAVE_SEARCH_HOST],
      route: input.route,
      timeoutMs: input.timeoutMs,
      context: input.context,
    });
    if (!response.ok) throw providerHttpError(response);
    let parsed: BraveSearchResponse;
    try {
      parsed = JSON.parse(responseBody(response)) as BraveSearchResponse;
    } catch (error) {
      throw new SearchAttemptError(
        "Brave Search returned invalid JSON.",
        "provider_error",
        { allowRouteFallback: false, allowProviderFallback: true },
        error,
      );
    }
    return (parsed.web?.results ?? [])
      .map((entry) => normalizeResult({
        title: entry.title,
        url: entry.url,
        snippet: entry.description,
      }))
      .filter((entry): entry is WebSearchResultItem => Boolean(entry))
      .slice(0, input.args.maxResults ?? 5);
  }

  const response = await fetchSearchResponse({
    url: buildBingUrl(input.args),
    headers: {
      Accept: "application/rss+xml, application/xml;q=0.9, text/xml;q=0.8",
      "User-Agent": "Deep-Mix/0.1 web_search",
    },
    allowedHosts: [BING_SEARCH_HOST, BING_REGIONAL_SEARCH_HOST],
    route: input.route,
    timeoutMs: input.timeoutMs,
    context: input.context,
  });
  if (!response.ok) throw providerHttpError(response);
  const items = responseBody(response).match(/<item\b[^>]*>[\s\S]*?<\/item>/giu) ?? [];
  return items
    .map((item) => normalizeResult({
      title: extractXmlTag(item, "title"),
      url: extractXmlTag(item, "link"),
      snippet: extractXmlTag(item, "description"),
    }))
    .filter((entry): entry is WebSearchResultItem => Boolean(entry))
    .slice(0, input.args.maxResults ?? 5);
}

async function withPlanTimeout<T>(promise: Promise<T>): Promise<T> {
  let timeout: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      promise,
      new Promise<never>((_resolve, reject) => {
        timeout = setTimeout(() => reject(Object.assign(new Error("System proxy discovery timed out."), { code: "ETIMEDOUT" })), PROXY_PLAN_TIMEOUT_MS);
      }),
    ]);
  } finally {
    if (timeout) clearTimeout(timeout);
  }
}

function structuredFailure(input: {
  args: WebSearchArgs;
  provider: SearchProvider;
  attempts: WebSearchAttempt[];
  context: RuntimeToolExecutionContext;
  startedAt: string;
  error: SearchAttemptError;
}): ToolResult {
  const message = boundedText(input.error.message, 500);
  const structuredError: ToolStructuredError = {
    type: input.error.errorType,
    message,
    retryable: false,
    toolName: "web_search",
  };
  const structuredContent = {
    kind: "web_search_error",
    query: input.args.query,
    provider: input.provider,
    attempts: input.attempts,
    strategiesExhausted: true,
    guidance: "All built-in search routes were exhausted or further fallback was not allowed; do not repeat the identical call in this turn.",
    error: structuredError,
  };
  return {
    toolName: "web_search",
    callId: input.context.callId,
    startedAt: input.startedAt,
    endedAt: input.context.moduleContext.clock.now(),
    success: false,
    output: JSON.stringify(structuredContent),
    structuredContent,
    error: message,
  };
}

async function executeWebSearch(
  args: WebSearchArgs,
  context: RuntimeToolExecutionContext,
): Promise<ToolResult> {
  const startedAt = context.moduleContext.clock.now();
  const deadline = Date.now() + SEARCH_TOTAL_TIMEOUT_MS;
  const braveApiKey = resolveBraveSearchApiKey(context.moduleContext);
  const providers: SearchProvider[] = braveApiKey ? ["brave", "bing"] : ["bing"];
  const attempts: WebSearchAttempt[] = [];
  const warnings: string[] = [];
  let lastProvider = providers[0]!;
  let lastError = new SearchAttemptError(
    "Web search did not start.",
    "provider_error",
    { allowRouteFallback: false, allowProviderFallback: false },
  );

  for (let providerIndex = 0; providerIndex < providers.length; providerIndex += 1) {
    const provider = providers[providerIndex]!;
    lastProvider = provider;
    const providerUrl = provider === "brave" ? buildBraveUrl(args) : buildBingUrl(args);
    let routes: ToolNetworkRoute[];
    try {
      const plan = await withPlanTimeout(context.moduleContext.network.plan(providerUrl));
      routes = plan.routes.map((entry) => entry.route);
    } catch {
      routes = ["direct"];
      warnings.push("System proxy discovery failed; used the direct network route.");
    }

    for (let routeIndex = 0; routeIndex < routes.length; routeIndex += 1) {
      const route = routes[routeIndex]!;
      const remaining = deadline - Date.now();
      if (remaining < MIN_REMAINING_ATTEMPT_MS) {
        lastError = new SearchAttemptError(
          `Web search exhausted its ${SEARCH_TOTAL_TIMEOUT_MS} ms total time budget.`,
          "timeout",
          { allowRouteFallback: false, allowProviderFallback: false },
        );
        return structuredFailure({ args, provider, attempts, context, startedAt, error: lastError });
      }
      try {
        const results = await searchProvider({
          provider,
          args,
          route,
          timeoutMs: Math.min(SEARCH_ATTEMPT_TIMEOUT_MS, remaining),
          apiKey: braveApiKey,
          context: context.moduleContext,
        });
        attempts.push({ provider, route, outcome: "success" });
        if (routeIndex > 0) warnings.push("The system network path failed; the search succeeded through a direct connection.");
        if (provider === "bing") {
          warnings.push(braveApiKey
            ? "Brave Search was unavailable after built-in recovery; used the Bing RSS fallback."
            : "No Brave Search key is configured; used the keyless Bing RSS fallback.");
          if (args.freshness) {
            warnings.push("The Bing RSS fallback does not guarantee freshness filtering; freshness was ignored.");
          }
        }
        const output: WebSearchOutput = {
          kind: "web_search",
          query: args.query,
          provider,
          networkRoute: route,
          fallbackUsed: providerIndex > 0 || routeIndex > 0,
          attempts,
          resultCount: results.length,
          results,
          warnings: [...new Set(warnings)],
        };
        return {
          toolName: "web_search",
          callId: context.callId,
          startedAt,
          endedAt: context.moduleContext.clock.now(),
          success: true,
          output: JSON.stringify(output),
          structuredContent: output,
        };
      } catch (error) {
        const classified = classifyNetworkFailure(error);
        lastError = classified;
        attempts.push({
          provider,
          route,
          outcome: "error",
          errorType: classified.errorType,
          httpStatus: classified.options.httpStatus,
        });
        const hasNextRoute = routeIndex + 1 < routes.length;
        if (classified.options.allowRouteFallback && hasNextRoute) continue;
        if (!classified.options.allowProviderFallback) {
          return structuredFailure({ args, provider, attempts, context, startedAt, error: classified });
        }
        break;
      }
    }
  }

  return structuredFailure({
    args,
    provider: lastProvider,
    attempts,
    context,
    startedAt,
    error: lastError,
  });
}

function webSearchAvailability(context: ToolModuleContext): ToolAvailability {
  if (resolveBraveSearchApiKey(context)) return { status: "available", available: true };
  return {
    status: "degraded",
    available: true,
    fallbackCapabilities: ["bing-rss"],
    reason: "No Brave Search key is configured; web_search will use the keyless Bing RSS fallback.",
    warnings: ["Configure BRAVE_SEARCH_API_KEY or webSearch.braveApiKey in settings.json for Brave Search."],
  };
}

function createWebSearch(context: ToolModuleContext): RuntimeToolSpec {
  return {
    name: "web_search",
    displayName: "Web Search",
    description:
      "Search the public internet with automatic system-proxy, direct-route, and provider recovery. Uses Brave Search when configured and a bounded Bing RSS fallback for eligible network failures.",
    inputSchema: {
      type: "object",
      additionalProperties: false,
      required: ["query"],
      properties: {
        query: {
          type: "string",
          minLength: 1,
          maxLength: 400,
          description: "Internet search query. Search operators such as site: and filetype: may be included.",
        },
        maxResults: {
          type: "integer",
          minimum: 1,
          maximum: 10,
          description: "Maximum number of results to return. Defaults to 5.",
        },
        freshness: {
          type: "string",
          enum: ["day", "week", "month", "year"],
          description: "Optional freshness filter. Guaranteed only by the Brave Search provider.",
        },
      },
    },
    readOnly: true,
    permissionCategory: "read_only",
    sideEffectLevel: "none",
    timeoutCategory: "default",
    groups: ["web", "research", "internet"],
    selection: {
      groups: ["web", "research", "internet"],
      keywords: [
        "web search",
        "internet search",
        "search online",
        "search the web",
        "latest information",
        "look up online",
        "互联网搜索",
        "联网搜索",
        "网络搜索",
        "搜索互联网",
        "上网查",
        "在线查找",
        "最新信息",
        "最新资料",
      ],
      keywordGroups: [
        ["查找", "今年"],
        ["查询", "今年"],
        ["查一下", "今年"],
        ["搜一下", "今年"],
        ["搜索", "今年"],
      ],
    },
    getAvailability: () => webSearchAvailability(context),
    resolveAccess: () => [{
      kind: "network_access",
      hosts: resolveBraveSearchApiKey(context)
        ? [BRAVE_SEARCH_HOST, BING_SEARCH_HOST, BING_REGIONAL_SEARCH_HOST]
        : [BING_SEARCH_HOST, BING_REGIONAL_SEARCH_HOST],
      reason: "Query the configured public web search provider and its eligible fallback.",
    }],
    execute: (rawArgs, executionContext) => executeWebSearch(rawArgs as WebSearchArgs, executionContext),
  };
}

export const webToolModule: ToolModule = {
  manifest: {
    id: "builtin.web",
    version: "1.2.0",
    description: "Permission-mediated, bounded public internet search, retrieval, API requests, and downloads.",
    source: "built_in",
  },
  create: (context) => [
    createWebSearch(context),
    createWebFetch(context) as RuntimeToolSpec,
    createHttpRequest(context) as RuntimeToolSpec,
    createDownloadFile(context) as RuntimeToolSpec,
  ],
};
