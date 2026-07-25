import { NodeType, parse } from "node-html-parser";
import type { HTMLElement, Node } from "node-html-parser";

import type {
  NetworkAuditSummary,
  NetworkHttpMethod,
  NetworkResponseSummary,
  ToolErrorType,
  ToolOutputArtifact,
  ToolResult,
  ToolStructuredError,
} from "../../../../shared-schema/src/index.js";
import {
  SafeNetworkError,
  classifySafeNetworkFailure,
  createSafeNetworkDeadline,
  executeSafeHttpRequest,
  expandSensitiveNetworkValues,
  extractSensitiveNetworkHeaderValues,
  extractSensitiveNetworkUrlValues,
  isSensitiveNetworkQueryName,
  redactNetworkToolArguments,
  redactUrl,
} from "../../network/safe-http.js";
import type {
  RuntimeToolExecutionContext,
  RuntimeToolSpec,
  ToolModuleContext,
} from "../../tool-module.js";

const DEFAULT_TIMEOUT_MS = 20_000;
const MAX_TIMEOUT_MS = 60_000;
const DEFAULT_WEB_FETCH_CHARS = 2_000_000;
const MAX_WEB_FETCH_CHARS = 2_000_000;
const DEFAULT_HTTP_BODY_CHARS = 2_000_000;
const MAX_HTTP_BODY_CHARS = 2_000_000;
const MAX_FETCH_BYTES = 8 * 1024 * 1024;
const MAX_NORMALIZED_CHARS = 8 * 1024 * 1024;
const MAX_HTML_DEPTH = 96;
const MAX_HTML_NODES = 250_000;
const MAX_REDIRECTS = 5;
const MAX_REDACTION_SECRET_VALUES = 256;
const MAX_REDACTION_SECRET_CHARS = 4 * 1024 * 1024;
const MUTATING_METHODS = new Set<NetworkHttpMethod>(["POST", "PUT", "PATCH", "DELETE"]);

function boundedRedactionSecrets(values: readonly string[]): string[] {
  const unique = [...new Set(values.filter(Boolean))];
  const totalChars = unique.reduce((total, value) => total + value.length, 0);
  if (unique.length > MAX_REDACTION_SECRET_VALUES || totalChars > MAX_REDACTION_SECRET_CHARS) {
    throw new SafeNetworkError(
      "Request contains too many distinct protected values for bounded response redaction.",
      "policy_denied",
      false,
    );
  }
  return unique;
}

function mergeRedactionSecrets(target: string[], incoming: readonly string[]): void {
  const bounded = boundedRedactionSecrets([...target, ...incoming]);
  target.splice(0, target.length, ...bounded);
}

export interface WebFetchArgs {
  url: string;
  maxChars?: number;
  timeoutMs?: number;
  expectedContentTypes?: string[];
}

export interface HttpRequestArgs {
  url: string;
  method: NetworkHttpMethod;
  headers?: Record<string, string>;
  query?: Record<string, string>;
  body?: {
    kind: "json" | "text" | "base64";
    content: string;
    contentType?: string;
  };
  timeoutMs?: number;
  maxResponseBytes?: number;
  maxChars?: number;
  maxRedirects?: number;
  expectedContentTypes?: string[];
}

interface NormalizedBody {
  format: "html_markdown" | "markdown" | "json" | "text" | "binary" | "empty";
  content: string;
  title?: string;
  robotsDirectives?: string[];
  warnings: string[];
  sourceTruncated?: boolean;
}

interface HtmlNormalizationBudget {
  deadline: number;
  nodes: number;
  exhausted: boolean;
  truncated: boolean;
}

function bounded(value: string, maximum: number): string {
  if (maximum <= 0) return "";
  if (value.length <= maximum) return value;
  return `${value.slice(0, Math.max(0, maximum - 1)).trimEnd()}…`;
}

function cleanText(value: string): string {
  return value
    .replace(/\r\n?/gu, "\n")
    .replace(/[\t\f\v ]+/gu, " ")
    .replace(/ *\n */gu, "\n")
    .replace(/\n{3,}/gu, "\n\n")
    .trim();
}

function normalizeLiteralText(value: string): string {
  return value
    .replace(/^\ufeff/u, "")
    .replace(/\r\n?/gu, "\n");
}

function throwIfDeadlineExpired(deadline: number): void {
  if (Date.now() <= deadline) return;
  throw new SafeNetworkError("Network tool time budget was exhausted during response processing.", "timeout", false);
}

function capNormalizedBody(body: NormalizedBody): NormalizedBody {
  if (body.content.length <= MAX_NORMALIZED_CHARS) return body;
  return {
    ...body,
    content: bounded(body.content, MAX_NORMALIZED_CHARS),
    sourceTruncated: true,
    warnings: [...body.warnings, `Normalized content exceeded ${MAX_NORMALIZED_CHARS} characters and was bounded.`],
  };
}

function capJsonBody(content: string): NormalizedBody {
  if (content.length <= MAX_NORMALIZED_CHARS) {
    return { format: "json", content, warnings: [] };
  }
  return {
    format: "json",
    content: JSON.stringify({
      truncated: true,
      redactedJsonPrefix: content.slice(0, Math.min(1_000_000, Math.floor(MAX_NORMALIZED_CHARS / 4))),
    }),
    warnings: [`Normalized JSON exceeded ${MAX_NORMALIZED_CHARS} characters and was bounded.`],
    sourceTruncated: true,
  };
}

function redactBodyText(value: string, secrets: readonly string[]): string {
  let redacted = value;
  for (const secret of [...new Set(secrets)].filter(Boolean)) {
    redacted = redacted.split(secret).join("[REDACTED]");
  }
  return redacted
    .replace(/\b(Bearer|Basic)\s+[A-Za-z\d._~+\/-]+=*/giu, "$1 [REDACTED]")
    .replace(/((?:api[-_]?key|auth(?:entication|orization)?|cookie|credential|jwt|passwd|password|pwd|secret|session(?:[-_]?id)?|sid|sig(?:nature)?|token)["']?\s*[:=]\s*)[^\s,;]+/giu, "$1[REDACTED]")
    .replace(/([a-z][a-z\d+.-]*:\/\/)[^\s/@]+@/giu, "$1[REDACTED]@");
}

function requestSecrets(args: HttpRequestArgs): string[] {
  const secrets = [
    ...urlSecrets(args.url),
    ...Object.entries(args.headers ?? {})
      .flatMap(([name, value]) => extractSensitiveNetworkHeaderValues(name, value)),
    ...Object.entries(args.query ?? {})
      .filter(([name]) => isSensitiveNetworkQueryName(name))
      .map(([, value]) => value),
  ];
  let semanticJsonBody: string | undefined;
  if (args.body?.kind === "json") {
    semanticJsonBody = args.body.content;
  } else if (args.body?.kind === "base64") {
    try {
      const decoded = Buffer.from(args.body.content, "base64");
      const decodedText = decoded.toString("utf8");
      if (Buffer.from(decodedText, "utf8").equals(decoded)) {
        secrets.push(decodedText);
        if (/\bjson\b/iu.test(args.body.contentType ?? "")) semanticJsonBody = decodedText;
      }
    } catch {
      // Schema/transport validation reports malformed base64. Persistence
      // redaction still fails closed on the original body field.
    }
  }
  if (semanticJsonBody !== undefined) {
    try {
      secrets.push(...collectSensitiveJsonTextValues(semanticJsonBody));
    } catch {
      for (const match of semanticJsonBody.matchAll(
        /(?:api[-_]?key|apikey|auth|code|cookie|credential|jwt|key|oauth|password|secret|session(?:[-_]?id)?|sid|sig|signature|token)["']?\s*[:=]\s*["']([^"']{4,512})["']/giu,
      )) {
        if (match[1]) secrets.push(match[1]);
      }
    }
  }
  const bodyText = args.body?.kind === "base64"
    ? (() => {
        try {
          const decoded = Buffer.from(args.body!.content, "base64");
          const text = decoded.toString("utf8");
          return Buffer.from(text, "utf8").equals(decoded) ? text : undefined;
        } catch {
          return undefined;
        }
      })()
    : args.body?.content;
  for (const match of bodyText?.matchAll(
    /(?:api[-_]?key|auth(?:entication|orization)?|cookie|credential|jwt|oauth|passwd|password|pwd|secret|session(?:[-_]?id)?|sid|sig(?:nature)?|token)["']?\s*[:=]\s*["']?([^\s"'&,;}{\]]{3,2048})/giu,
  ) ?? []) {
    if (match[1]) secrets.push(match[1]);
  }
  return boundedRedactionSecrets(secrets.flatMap((secret) => (
    secret.length <= 2_048 ? expandSensitiveNetworkValues([secret]) : [secret]
  )));
}

function isSensitiveJsonFieldName(name: string): boolean {
  const parts = name
    .replace(/([a-z\d])([A-Z])/gu, "$1-$2")
    .normalize("NFKC")
    .toLocaleLowerCase("en-US")
    .split(/[^a-z\d]+/u)
    .filter(Boolean);
  const fields = new Set(parts);
  if (parts.some((part) => [
    "accesskey", "accesstoken", "apikey", "clientsecret", "functionskey", "idtoken", "refreshtoken",
    "subscriptionkey",
  ].includes(part))) return true;
  if (parts.some((part) => [
    "credential", "cookie", "jwt", "password", "passwd", "pwd", "secret", "session", "sessionid", "sid",
    "signature", "sig", "token",
  ].includes(part))) return true;
  if (parts.some((part) => ["auth", "authentication", "authorization", "oauth"].includes(part))) return true;
  if (fields.has("key") && [...fields].some((part) => (
    ["access", "api", "client", "functions", "private", "secret", "subscription"].includes(part)
  ))) return true;
  if (fields.has("code") && [...fields].some((part) => (
    ["auth", "authorization", "oauth", "otp", "verification"].includes(part)
  ))) return true;
  return false;
}

function urlSecrets(rawUrl: string): string[] {
  return extractSensitiveNetworkUrlValues(rawUrl);
}

function jsonStringEnd(text: string, start: number): number {
  let escaped = false;
  for (let index = start + 1; index < text.length; index += 1) {
    const character = text[index]!;
    if (escaped) {
      escaped = false;
      continue;
    }
    if (character === "\\") {
      escaped = true;
      continue;
    }
    if (character === "\"") return index + 1;
  }
  throw new SyntaxError("Unterminated JSON string.");
}

function jsonValueEnd(text: string, start: number, deadline: number): number {
  const first = text[start];
  if (first === "\"") return jsonStringEnd(text, start);
  if (first !== "{" && first !== "[") {
    let index = start;
    while (index < text.length && !/[\s,\]}]/u.test(text[index]!)) index += 1;
    return index;
  }
  const closers = [first === "{" ? "}" : "]"];
  let inString = false;
  let escaped = false;
  for (let index = start + 1; index < text.length; index += 1) {
    if ((index & 0xfff) === 0) throwIfDeadlineExpired(deadline);
    const character = text[index]!;
    if (inString) {
      if (escaped) escaped = false;
      else if (character === "\\") escaped = true;
      else if (character === "\"") inString = false;
      continue;
    }
    if (character === "\"") {
      inString = true;
      continue;
    }
    if (character === "{" || character === "[") {
      closers.push(character === "{" ? "}" : "]");
      continue;
    }
    if (character === closers.at(-1)) {
      closers.pop();
      if (closers.length === 0) return index + 1;
    }
  }
  throw new SyntaxError("Unterminated JSON value.");
}

function collectSensitiveJsonTextValues(text: string): string[] {
  JSON.parse(text) as unknown;
  const values: string[] = [];
  let index = 0;
  while (index < text.length) {
    if (text[index] !== "\"") {
      index += 1;
      continue;
    }
    const end = jsonStringEnd(text, index);
    let next = end;
    while (next < text.length && /\s/u.test(text[next]!)) next += 1;
    if (text[next] === ":") {
      const key = JSON.parse(text.slice(index, end)) as string;
      if (isSensitiveJsonFieldName(key)) {
        let valueStart = next + 1;
        while (valueStart < text.length && /\s/u.test(text[valueStart]!)) valueStart += 1;
        const valueEnd = jsonValueEnd(text, valueStart, Number.POSITIVE_INFINITY);
        const rawValue = text.slice(valueStart, valueEnd);
        values.push(rawValue.startsWith("\"") ? JSON.parse(rawValue) as string : rawValue);
        if (rawValue.startsWith("{") || rawValue.startsWith("[")) {
          let descendant = valueStart + 1;
          while (descendant < valueEnd - 1) {
            if (/\s|[,:{}\[\]]/u.test(text[descendant]!)) {
              descendant += 1;
              continue;
            }
            if (text[descendant] === "\"") {
              const scalarEnd = jsonStringEnd(text, descendant);
              // A sensitive composite value can encode credentials in map
              // keys as well as values. Protect every descendant string so a
              // reflective endpoint cannot relabel a secret key into output.
              values.push(JSON.parse(text.slice(descendant, scalarEnd)) as string);
              descendant = scalarEnd;
              continue;
            }
            const scalarEnd = jsonValueEnd(text, descendant, Number.POSITIVE_INFINITY);
            const scalar = text.slice(descendant, scalarEnd);
            if (scalar && !scalar.startsWith("{") && !scalar.startsWith("[")) values.push(scalar);
            descendant = Math.max(descendant + 1, scalarEnd);
          }
        }
        index = valueEnd;
        continue;
      }
    }
    index = end;
  }
  return [...new Set(values.filter(Boolean))];
}

function redactJsonTextLosslessly(
  text: string,
  secrets: readonly string[],
  deadline: number,
): string {
  throwIfDeadlineExpired(deadline);
  // Syntax validation is separate from output generation. The original number
  // tokens are never parsed and reserialized, so 64-bit IDs remain byte-exact.
  JSON.parse(text) as unknown;
  throwIfDeadlineExpired(deadline);
  if (secrets.includes(text)) return JSON.stringify("[REDACTED]");
  const output: string[] = [];
  const primitiveSecrets = new Set(secrets.filter((secret) => (
    /^(?:-?(?:0|[1-9]\d*)(?:\.\d+)?(?:[eE][+-]?\d+)?|true|false|null)$/u.test(secret)
  )));
  let cursor = 0;
  let index = 0;
  while (index < text.length) {
    if ((index & 0xfff) === 0) throwIfDeadlineExpired(deadline);
    if (text[index] !== "\"") {
      if (/[-\dtfn]/u.test(text[index]!)) {
        let primitiveEnd = index + 1;
        while (primitiveEnd < text.length && !/[\s,\]}]/u.test(text[primitiveEnd]!)) primitiveEnd += 1;
        const primitive = text.slice(index, primitiveEnd);
        if (primitiveSecrets.has(primitive)) {
          output.push(text.slice(cursor, index), JSON.stringify("[REDACTED]"));
          cursor = primitiveEnd;
        }
        index = primitiveEnd;
        continue;
      }
      index += 1;
      continue;
    }
    const end = jsonStringEnd(text, index);
    let next = end;
    while (next < text.length && /\s/u.test(text[next]!)) next += 1;
    const rawToken = text.slice(index, end);
    if (text[next] === ":") {
      const key = JSON.parse(rawToken) as string;
      const redactedKey = redactBodyText(key, secrets);
      if (redactedKey !== key) {
        output.push(text.slice(cursor, index), JSON.stringify(redactedKey));
        cursor = end;
      }
      if (isSensitiveJsonFieldName(key)) {
        let valueStart = next + 1;
        while (valueStart < text.length && /\s/u.test(text[valueStart]!)) valueStart += 1;
        const valueEnd = jsonValueEnd(text, valueStart, deadline);
        output.push(text.slice(cursor, valueStart), JSON.stringify("[REDACTED]"));
        cursor = valueEnd;
        index = valueEnd;
        continue;
      }
    } else {
      const decoded = JSON.parse(rawToken) as string;
      const redacted = redactBodyText(decoded, secrets);
      if (redacted !== decoded) {
        output.push(text.slice(cursor, index), JSON.stringify(redacted));
        cursor = end;
      }
    }
    index = end;
  }
  output.push(text.slice(cursor));
  return output.join("");
}

function safeLink(raw: string | undefined, baseUrl: string): string | undefined {
  if (!raw) return undefined;
  try {
    const url = new URL(raw, baseUrl);
    return url.protocol === "http:" || url.protocol === "https:" ? redactUrl(url.toString()) : undefined;
  } catch {
    return undefined;
  }
}

function markdownInline(value: string): string {
  return cleanText(value).replace(/([\\`*_{}\[\]])/gu, "\\$1");
}

function renderHtmlNode(
  node: Node,
  baseUrl: string,
  budget: HtmlNormalizationBudget,
  listDepth = 0,
  nodeDepth = 0,
): string {
  if (budget.exhausted) return "";
  if (nodeDepth > MAX_HTML_DEPTH) {
    budget.truncated = true;
    return "";
  }
  budget.nodes += 1;
  if (budget.nodes > MAX_HTML_NODES) {
    budget.exhausted = true;
    budget.truncated = true;
    return "";
  }
  if ((budget.nodes & 0x3ff) === 0) throwIfDeadlineExpired(budget.deadline);
  if (node.nodeType === NodeType.TEXT_NODE) {
    if (/^\s*<!doctype\b[^>]*>\s*$/iu.test(node.text)) return "";
    return node.text.replace(/\s+/gu, " ");
  }
  if (node.nodeType !== NodeType.ELEMENT_NODE) return "";
  const element = node as HTMLElement;
  // node-html-parser models its document root as an element whose tagName is
  // null at runtime. Root-only or fragment HTML therefore needs to recurse
  // through children without assuming a concrete tag.
  const tag = typeof element.tagName === "string" ? element.tagName.toLocaleLowerCase() : "";
  if (["script", "style", "noscript", "template", "svg", "canvas", "iframe"].includes(tag)) return "";
  const children = () => {
    let content = "";
    for (const child of element.childNodes) {
      content += renderHtmlNode(child, baseUrl, budget, listDepth, nodeDepth + 1);
      if (budget.exhausted) break;
      if (content.length > MAX_NORMALIZED_CHARS) {
        budget.exhausted = true;
        budget.truncated = true;
        content = content.slice(0, MAX_NORMALIZED_CHARS);
        break;
      }
    }
    return content;
  };
  if (tag === "br") return "\n";
  if (tag === "hr") return "\n\n---\n\n";
  if (/^h[1-6]$/u.test(tag)) {
    return `\n\n${"#".repeat(Number(tag[1]))} ${markdownInline(children())}\n\n`;
  }
  if (tag === "p") return `\n\n${children()}\n\n`;
  if (tag === "blockquote") {
    return `\n\n${cleanText(children()).split("\n").map((line) => `> ${line}`).join("\n")}\n\n`;
  }
  if (tag === "pre") return `\n\n\`\`\`\n${element.text.trim()}\n\`\`\`\n\n`;
  if (tag === "code") return `\`${element.text.replace(/`/gu, "\\`").trim()}\``;
  if (tag === "strong" || tag === "b") return `**${children().trim()}**`;
  if (tag === "em" || tag === "i") return `*${children().trim()}*`;
  if (tag === "a") {
    const text = cleanText(children());
    const href = safeLink(element.getAttribute("href"), baseUrl);
    return href && text ? `[${markdownInline(text)}](${href})` : text;
  }
  if (tag === "img") {
    const alt = markdownInline(element.getAttribute("alt") ?? "");
    const source = safeLink(element.getAttribute("src"), baseUrl);
    return source && alt ? `![${alt}](${source})` : alt;
  }
  if (tag === "ul" || tag === "ol") {
    const ordered = tag === "ol";
    const items = element.childNodes.filter((child): child is HTMLElement => {
      if (child.nodeType !== NodeType.ELEMENT_NODE) return false;
      const childTag = (child as HTMLElement).tagName;
      return typeof childTag === "string" && childTag.toLocaleLowerCase() === "li";
    });
    const renderedItems: string[] = [];
    for (let index = 0; index < items.length && !budget.exhausted; index += 1) {
      const item = items[index]!;
      const marker = ordered ? `${index + 1}.` : "-";
      const content = cleanText(item.childNodes.map((child) => (
        renderHtmlNode(child, baseUrl, budget, listDepth + 1, nodeDepth + 1)
      )).join(""));
      const indented = content.replace(/\n/gu, `\n${"  ".repeat(listDepth + 1)}`);
      renderedItems.push(`${"  ".repeat(listDepth)}${marker} ${indented}`);
    }
    return `\n${renderedItems.join("\n")}\n`;
  }
  if (["article", "aside", "div", "footer", "header", "main", "nav", "section", "table", "tr"].includes(tag)) {
    return `\n${children()}\n`;
  }
  if (tag === "li") return children();
  if (tag === "td" || tag === "th") return `${children().trim()} | `;
  return children();
}

function normalizeHtml(html: string, baseUrl: string, deadline: number): NormalizedBody {
  throwIfDeadlineExpired(deadline);
  const root = parse(html, { comment: false });
  throwIfDeadlineExpired(deadline);
  const title = bounded(cleanText(
    root.querySelector("title")?.text ??
    root.querySelector('meta[property="og:title"]')?.getAttribute("content") ??
    root.querySelector("h1")?.text ??
    "",
  ), 500);
  const robotsDirectives = [
    root.querySelector('meta[name="robots"]')?.getAttribute("content"),
    root.querySelector('meta[name="googlebot"]')?.getAttribute("content"),
  ].filter((value): value is string => Boolean(value)).map((value) => bounded(cleanText(value), 300));
  for (const selector of [
    "script", "style", "noscript", "template", "svg", "canvas", "iframe", "form",
    "nav", "footer", "aside", "[hidden]", '[aria-hidden="true"]',
  ]) {
    for (const element of root.querySelectorAll(selector)) element.remove();
  }
  const candidates = [
    ...root.querySelectorAll("main"),
    ...root.querySelectorAll("article"),
    ...root.querySelectorAll('[role="main"]'),
  ];
  const body = candidates.sort((left, right) => right.text.length - left.text.length)[0]
    ?? root.querySelector("body")
    ?? root;
  const budget: HtmlNormalizationBudget = {
    deadline,
    nodes: 0,
    exhausted: false,
    truncated: false,
  };
  const normalized = capNormalizedBody({
    format: "html_markdown",
    content: cleanText(renderHtmlNode(body, baseUrl, budget)),
    title: title || undefined,
    robotsDirectives,
    warnings: budget.truncated
      ? ["HTML extraction reached its deterministic depth, node, or character budget."]
      : [],
    sourceTruncated: budget.truncated || undefined,
  });
  throwIfDeadlineExpired(deadline);
  return normalized;
}

function normalizeResponseBody(input: {
  body: Uint8Array;
  contentType?: string;
  finalUrl: string;
  secrets?: readonly string[];
  deadline: number;
}): NormalizedBody {
  throwIfDeadlineExpired(input.deadline);
  if (input.body.byteLength === 0) return { format: "empty", content: "", warnings: [] };
  const contentType = input.contentType?.toLocaleLowerCase();
  const text = Buffer.from(input.body).toString("utf8");
  throwIfDeadlineExpired(input.deadline);
  let normalized: NormalizedBody;
  if (contentType === "text/html" || contentType === "application/xhtml+xml") {
    normalized = normalizeHtml(text, input.finalUrl, input.deadline);
  } else if (contentType === "text/markdown" || contentType === "text/x-markdown") {
    normalized = capNormalizedBody({
      format: "markdown",
      content: normalizeLiteralText(text),
      warnings: [],
    });
  } else if (contentType === "application/json" || contentType?.endsWith("+json")) {
    try {
      const redactedJson = redactJsonTextLosslessly(text, input.secrets ?? [], input.deadline);
      normalized = capJsonBody(redactedJson);
    } catch (error) {
      if (error instanceof SafeNetworkError) throw error;
      normalized = capNormalizedBody({
        format: "text",
        content: normalizeLiteralText(text),
        warnings: ["The response declared JSON but could not be parsed; returned bounded text."],
      });
    }
  } else if (
    contentType?.startsWith("text/") ||
    contentType === "application/xml" ||
    contentType?.endsWith("+xml") ||
    contentType === "application/javascript"
  ) {
    normalized = capNormalizedBody({ format: "text", content: normalizeLiteralText(text), warnings: [] });
  } else {
    return {
      format: "binary",
      content: "",
      warnings: ["Binary response body was not decoded as text. Use download_file to retain it as an artifact."],
    };
  }
  return {
    ...normalized,
    content: normalized.format === "json"
      ? normalized.content
      : redactBodyText(normalized.content, input.secrets ?? []),
    title: normalized.title ? redactBodyText(normalized.title, input.secrets ?? []) : undefined,
    robotsDirectives: normalized.robotsDirectives?.map((value) => redactBodyText(value, input.secrets ?? [])),
  };
}

function initialHost(rawUrl: string): string[] {
  try {
    const url = new URL(rawUrl);
    return url.protocol === "http:" || url.protocol === "https:"
      ? [url.hostname.replace(/^\[|\]$/gu, "").toLocaleLowerCase()]
      : [];
  } catch {
    return [];
  }
}

function mapNetworkToolError(error: SafeNetworkError): ToolErrorType {
  if (error.networkErrorType === "timeout") return "timeout";
  if (error.networkErrorType === "policy_denied") return "sandbox_denied";
  if (error.networkErrorType === "content_type" || error.networkErrorType === "http") return "provider_error";
  return "network_error";
}

function networkFailureResult(
  toolName: "web_fetch" | "http_request",
  error: unknown,
  context: RuntimeToolExecutionContext,
  startedAt: string,
  secrets: readonly string[] = [],
  completedNetworkAudit?: NetworkAuditSummary,
): ToolResult {
  const failure = classifySafeNetworkFailure(error);
  const message = bounded(redactBodyText(failure.message, secrets), MAX_HTTP_BODY_CHARS);
  const structuredError: ToolStructuredError = {
    type: mapNetworkToolError(failure),
    message,
    retryable: failure.retryable,
    toolName,
  };
  const structuredContent = {
    kind: `${toolName}_error`,
    networkErrorType: failure.networkErrorType,
    error: structuredError,
  };
  return {
    toolName,
    callId: context.callId,
    startedAt,
    endedAt: context.moduleContext.clock.now(),
    success: false,
    output: JSON.stringify(structuredContent),
    structuredContent,
    networkAudit: failure.audit ?? completedNetworkAudit,
    error: message,
  };
}

function artifactExtension(body: NormalizedBody): { extension: string; mimeType: string } {
  if (body.format === "html_markdown" || body.format === "markdown") {
    return { extension: "md", mimeType: "text/markdown" };
  }
  if (body.format === "json") return { extension: "json", mimeType: "application/json" };
  return { extension: "txt", mimeType: "text/plain" };
}

async function persistLongText(input: {
  toolName: "web_fetch" | "http_request";
  body: NormalizedBody;
  summary: NetworkResponseSummary;
  context: RuntimeToolExecutionContext;
}): Promise<ToolOutputArtifact> {
  throwIfContextAborted(input.context);
  const format = artifactExtension(input.body);
  try {
    return await input.context.moduleContext.persistence.storeToolOutputArtifact({
      sessionId: input.context.sessionId,
      turnId: input.context.turnId,
      toolCallId: input.context.callId,
      sourceToolName: input.toolName,
      fileName: `${input.toolName.replace(/_/gu, "-")}-${input.context.callId}.${format.extension}`,
      mimeType: format.mimeType,
      kind: "text",
      summary: bounded(`${input.toolName} full normalized response from ${input.summary.finalUrl}`, 320),
      content: input.body.content,
      signal: input.context.signal,
    });
  } catch (error) {
    throwIfContextAborted(input.context);
    throw error;
  }
}

async function persistBinaryResponse(input: {
  body: Uint8Array;
  summary: NetworkResponseSummary;
  context: RuntimeToolExecutionContext;
  secrets: readonly string[];
}): Promise<ToolOutputArtifact> {
  throwIfContextAborted(input.context);
  const body = Buffer.from(input.body);
  if (input.secrets.some((secret) => {
    if (!secret) return false;
    const encoded = Buffer.from(secret, "utf8");
    return encoded.byteLength > 0 && encoded.byteLength <= body.byteLength && body.indexOf(encoded) >= 0;
  })) {
    throw new SafeNetworkError(
      "Binary response matched protected request material and was not persisted.",
      "policy_denied",
      false,
    );
  }
  try {
    return await input.context.moduleContext.persistence.storeToolOutputArtifact({
      sessionId: input.context.sessionId,
      namespace: "network-responses",
      turnId: input.context.turnId,
      toolCallId: input.context.callId,
      sourceToolName: "http_request",
      fileName: `http-response-${input.context.callId}.bin`,
      mimeType: input.summary.contentType ?? "application/octet-stream",
      kind: "binary",
      summary: bounded(`Bounded binary HTTP response from ${input.summary.finalUrl}`, 320),
      content: body,
      signal: input.context.signal,
    });
  } catch (error) {
    throwIfContextAborted(input.context);
    throw error;
  }
}

function throwIfContextAborted(context: RuntimeToolExecutionContext): void {
  if (!context.signal?.aborted) return;
  if (context.signal.reason instanceof SafeNetworkError) throw context.signal.reason;
  throw new SafeNetworkError("Network request was cancelled.", "cancelled", false, {
    cause: context.signal.reason,
  });
}

async function runSafeRequest(input: {
  context: RuntimeToolExecutionContext;
  method: NetworkHttpMethod;
  url: string;
  headers?: Record<string, string>;
  query?: Record<string, string>;
  body?: HttpRequestArgs["body"];
  timeoutMs: number;
  maxResponseBytes: number;
  maxRedirects: number;
  expectedContentTypes?: string[];
}) {
  return executeSafeHttpRequest({
    network: input.context.moduleContext.network,
    spec: {
      method: input.method,
      url: input.url,
      headers: input.headers,
      query: input.query,
      body: input.body,
      timeoutMs: input.timeoutMs,
      maxResponseBytes: input.maxResponseBytes,
      maxRedirects: input.maxRedirects,
      expectedContentTypes: input.expectedContentTypes,
    },
    signal: input.context.signal,
    budgetKey: `${input.context.sessionId}:${input.context.turnId ?? input.context.callId}`,
    environment: input.context.moduleContext.environment,
    maxToolBytes: MAX_FETCH_BYTES,
    authorizeHost: (hostname) => input.context.moduleContext.permissions.assertNetworkHosts([hostname]),
  });
}

async function executeWebFetch(args: WebFetchArgs, context: RuntimeToolExecutionContext): Promise<ToolResult> {
  const startedAt = context.moduleContext.clock.now();
  const timeoutMs = args.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  const deadlineGuard = createSafeNetworkDeadline(context.signal, timeoutMs);
  const operationContext: RuntimeToolExecutionContext = { ...context, signal: deadlineGuard.signal };
  const secrets = urlSecrets(args.url);
  let completedNetworkAudit: NetworkAuditSummary | undefined;
  try {
    const safe = await runSafeRequest({
      context: operationContext,
      method: "GET",
      url: args.url,
      headers: {
        Accept: "text/html, text/markdown, text/plain, application/json;q=0.9, */*;q=0.2",
        "User-Agent": "Deep-Mix/1.0 web_fetch",
      },
      timeoutMs,
      maxResponseBytes: MAX_FETCH_BYTES,
      maxRedirects: MAX_REDIRECTS,
      expectedContentTypes: args.expectedContentTypes,
    });
    mergeRedactionSecrets(secrets, safe.redactionSecrets);
    completedNetworkAudit = safe.audit;
    throwIfContextAborted(operationContext);
    const body = normalizeResponseBody({
      body: safe.response.body,
      contentType: safe.summary.contentType,
      finalUrl: safe.summary.finalUrl,
      secrets,
      deadline: deadlineGuard.deadline,
    });
    throwIfContextAborted(operationContext);
    const xRobots = Object.entries(safe.response.headers)
      .find(([name]) => name.toLocaleLowerCase() === "x-robots-tag")?.[1];
    const robotsDirectives = [...new Set([
      ...(body.robotsDirectives ?? []),
      ...(xRobots ? [bounded(cleanText(redactBodyText(xRobots, secrets)), 300)] : []),
    ])];
    const maxChars = args.maxChars ?? DEFAULT_WEB_FETCH_CHARS;
    const excerptTruncated = body.content.length > maxChars;
    const truncated = Boolean(body.sourceTruncated) || excerptTruncated;
    const artifact = truncated
      ? await persistLongText({ toolName: "web_fetch", body, summary: safe.summary, context: operationContext })
      : undefined;
    const content = excerptTruncated ? bounded(body.content, maxChars) : body.content;
    const citation = {
      title: body.title ?? safe.summary.finalUrl,
      url: safe.summary.finalUrl,
      fetchedAt: safe.summary.fetchedAt,
    };
    const structuredContent = {
      kind: "web_fetch",
      status: safe.summary.status,
      ok: safe.summary.ok,
      title: body.title,
      finalUrl: safe.summary.finalUrl,
      fetchedAt: safe.summary.fetchedAt,
      contentType: safe.summary.contentType,
      format: body.format,
      content,
      extractedChars: body.content.length,
      truncated,
      rawArtifactUri: artifact?.uri,
      citation,
      citations: [citation],
      robotsDirectives,
      downloadSuggested: body.format === "binary",
      response: safe.summary,
      warnings: body.warnings,
    };
    const output = JSON.stringify(structuredContent);
    if (!safe.summary.ok) {
      const message = `Remote site returned HTTP ${safe.summary.status}; the bounded response was preserved.`;
      const structuredError: ToolStructuredError = {
        type: safe.summary.status === 401 || safe.summary.status === 403
          ? "authentication_failed"
          : safe.summary.status === 429
            ? "rate_limited"
            : "provider_error",
        message,
        retryable: safe.summary.status >= 500 || safe.summary.status === 429,
        toolName: "web_fetch",
      };
      return {
        toolName: "web_fetch",
        callId: context.callId,
        startedAt,
        endedAt: context.moduleContext.clock.now(),
        success: false,
        output,
        structuredContent: { ...structuredContent, error: structuredError },
        artifacts: artifact ? [artifact] : undefined,
        networkAudit: safe.audit,
        error: message,
      };
    }
    return {
      toolName: "web_fetch",
      callId: context.callId,
      startedAt,
      endedAt: context.moduleContext.clock.now(),
      success: true,
      output,
      structuredContent,
      artifacts: artifact ? [artifact] : undefined,
      networkAudit: safe.audit,
    };
  } catch (error) {
    return networkFailureResult("web_fetch", error, context, startedAt, secrets, completedNetworkAudit);
  } finally {
    deadlineGuard.dispose();
  }
}

async function executeHttpRequest(args: HttpRequestArgs, context: RuntimeToolExecutionContext): Promise<ToolResult> {
  const startedAt = context.moduleContext.clock.now();
  const timeoutMs = args.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  const deadlineGuard = createSafeNetworkDeadline(context.signal, timeoutMs);
  const operationContext: RuntimeToolExecutionContext = { ...context, signal: deadlineGuard.signal };
  const secrets: string[] = [];
  let completedNetworkAudit: NetworkAuditSummary | undefined;
  try {
    mergeRedactionSecrets(secrets, requestSecrets(args));
    const body = args.body;
    if (body?.kind === "json") {
      try {
        // Validate syntax without reserializing: large integer IDs, signatures,
        // whitespace, and byte-exact API payloads must not be changed.
        JSON.parse(body.content) as unknown;
      } catch {
        throw new SafeNetworkError("JSON request body is invalid.", "policy_denied", false);
      }
    }
    const safe = await runSafeRequest({
      context: operationContext,
      method: args.method,
      url: args.url,
      headers: args.headers,
      query: args.query,
      body,
      timeoutMs,
      maxResponseBytes: args.maxResponseBytes ?? MAX_FETCH_BYTES,
      maxRedirects: args.maxRedirects ?? MAX_REDIRECTS,
      expectedContentTypes: args.expectedContentTypes,
    });
    mergeRedactionSecrets(secrets, safe.redactionSecrets);
    completedNetworkAudit = safe.audit;
    throwIfContextAborted(operationContext);
    const normalized = normalizeResponseBody({
      body: safe.response.body,
      contentType: safe.summary.contentType,
      finalUrl: safe.summary.finalUrl,
      secrets,
      deadline: deadlineGuard.deadline,
    });
    throwIfContextAborted(operationContext);
    const maxChars = args.maxChars ?? DEFAULT_HTTP_BODY_CHARS;
    const excerptTruncated = normalized.content.length > maxChars;
    const truncated = Boolean(normalized.sourceTruncated) || excerptTruncated;
    const artifact = normalized.format === "binary"
      ? await persistBinaryResponse({
          body: safe.response.body,
          summary: safe.summary,
          context: operationContext,
          secrets,
        })
      : truncated
        ? await persistLongText({ toolName: "http_request", body: normalized, summary: safe.summary, context: operationContext })
        : undefined;
    const structuredContent = {
      kind: "http_request",
      method: args.method,
      status: safe.summary.status,
      ok: safe.summary.ok,
      finalUrl: safe.summary.finalUrl,
      fetchedAt: safe.summary.fetchedAt,
      contentType: safe.summary.contentType,
      headers: safe.summary.headers ?? {},
      bodyFormat: normalized.format,
      body: excerptTruncated ? bounded(normalized.content, maxChars) : normalized.content,
      bodyChars: normalized.content.length,
      truncated,
      rawArtifactUri: artifact?.uri,
      downloadSuggested: normalized.format === "binary",
      response: safe.summary,
      warnings: normalized.warnings,
    };
    return {
      toolName: "http_request",
      callId: context.callId,
      startedAt,
      endedAt: context.moduleContext.clock.now(),
      // Receiving an HTTP response is a successful request even when its status is non-2xx.
      success: true,
      output: JSON.stringify(structuredContent),
      structuredContent,
      artifacts: artifact ? [artifact] : undefined,
      networkAudit: safe.audit,
    };
  } catch (error) {
    return networkFailureResult("http_request", error, context, startedAt, secrets, completedNetworkAudit);
  } finally {
    deadlineGuard.dispose();
  }
}

export function createWebFetch(_context: ToolModuleContext): RuntimeToolSpec<WebFetchArgs> {
  return {
    name: "web_fetch",
    displayName: "Web Fetch",
    description: "Fetch one public HTTP(S) page through the guarded network runtime and return bounded, citation-ready normalized text. It does not execute JavaScript; use browser or Playwright MCP for interactive and dynamic pages. Binary responses are never decoded as text.",
    inputSchema: {
      type: "object",
      additionalProperties: false,
      required: ["url"],
      properties: {
        url: { type: "string", minLength: 1, maxLength: 4_096 },
        maxChars: { type: "integer", minimum: 0, maximum: MAX_WEB_FETCH_CHARS, default: DEFAULT_WEB_FETCH_CHARS },
        timeoutMs: { type: "integer", minimum: 100, maximum: MAX_TIMEOUT_MS, default: DEFAULT_TIMEOUT_MS },
        expectedContentTypes: {
          type: "array",
          maxItems: 8,
          uniqueItems: true,
          items: { type: "string", minLength: 1, maxLength: 128 },
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
        "fetch url",
        "fetch http",
        "fetch page",
        "read webpage",
        "read http",
        "open website",
        "open http",
        "抓取网页",
        "读取网页",
        "读取 http",
        "阅读 http",
        "获取网页正文",
      ],
      keywordGroups: [
        ["http", "summarize"],
        ["http", "analyze"],
        ["http", "总结"],
        ["http", "分析"],
        ["链接", "总结"],
        ["链接", "分析"],
        ["链接", "阅读"],
      ],
    },
    resolveAccess: (args) => [{
      kind: "network_access",
      hosts: initialHost(args.url),
      reason: "Fetch public web content through the guarded network runtime.",
    }],
    redactArguments: (args) => redactNetworkToolArguments(
      args as unknown as Record<string, unknown>,
      ["url", "maxChars", "timeoutMs", "expectedContentTypes"],
    ),
    execute: executeWebFetch,
  };
}

export function createHttpRequest(_context: ToolModuleContext): RuntimeToolSpec<HttpRequestArgs> {
  return {
    name: "http_request",
    displayName: "HTTP Request",
    description: "Send a structured, bounded HTTP(S) request through the guarded network runtime. Mutating methods require explicit external-system approval; non-2xx responses remain inspectable.",
    inputSchema: {
      type: "object",
      additionalProperties: false,
      required: ["url", "method"],
      properties: {
        url: { type: "string", minLength: 1, maxLength: 4_096 },
        method: { type: "string", enum: ["GET", "HEAD", "POST", "PUT", "PATCH", "DELETE"] },
        headers: {
          type: "object",
          maxProperties: 64,
          additionalProperties: { type: "string", maxLength: 8_192 },
          propertyNames: { minLength: 1, maxLength: 200 },
        },
        query: {
          type: "object",
          maxProperties: 64,
          additionalProperties: { type: "string", maxLength: 4_096 },
          propertyNames: { minLength: 1, maxLength: 200 },
        },
        body: {
          type: "object",
          additionalProperties: false,
          required: ["kind", "content"],
          properties: {
            kind: { type: "string", enum: ["json", "text", "base64"] },
            content: { type: "string", maxLength: 2_796_204 },
            contentType: { type: "string", minLength: 1, maxLength: 200 },
          },
        },
        timeoutMs: { type: "integer", minimum: 100, maximum: MAX_TIMEOUT_MS, default: DEFAULT_TIMEOUT_MS },
        maxResponseBytes: { type: "integer", minimum: 0, maximum: MAX_FETCH_BYTES, default: MAX_FETCH_BYTES },
        maxChars: { type: "integer", minimum: 0, maximum: MAX_HTTP_BODY_CHARS, default: DEFAULT_HTTP_BODY_CHARS },
        maxRedirects: { type: "integer", minimum: 0, maximum: MAX_REDIRECTS, default: MAX_REDIRECTS },
        expectedContentTypes: {
          type: "array",
          maxItems: 8,
          uniqueItems: true,
          items: { type: "string", minLength: 1, maxLength: 128 },
        },
      },
    },
    readOnly: true,
    permissionCategory: "read_only",
    sideEffectLevel: "none",
    timeoutCategory: "default",
    groups: ["web", "api", "internet"],
    selection: {
      groups: ["web", "api", "internet"],
      keywords: [
        "call api",
        "curl ",
        "get http",
        "head http",
        "post http",
        "put http",
        "patch http",
        "delete http",
        "发送请求",
        "调用接口",
        "HTTP 请求",
        "接口调试",
        "接口测试",
        "debug api",
        "test api",
      ],
      keywordGroups: [
        ["http", "send request"],
        ["http", "api", "request"],
        ["api", "debug"],
        ["api", "test"],
        ["api", "调用"],
        ["api", "调试"],
        ["接口", "请求"],
      ],
    },
    resolveAccess: (args) => [
      {
        kind: "network_access",
        hosts: initialHost(args.url),
        reason: `Send a guarded ${args.method} request.`,
      },
      ...(MUTATING_METHODS.has(args.method) ? [{
        kind: "external_system" as const,
        systems: initialHost(args.url),
        reason: `${args.method} can change state in an external system.`,
      }] : []),
    ],
    resolvePermission: (args) => MUTATING_METHODS.has(args.method)
      ? { permissionCategory: "external_system", sideEffectLevel: "medium", readOnly: false }
      : { permissionCategory: "read_only", sideEffectLevel: "none", readOnly: true },
    redactArguments: (args) => redactNetworkToolArguments(
      args as unknown as Record<string, unknown>,
      [
        "url", "method", "headers", "query", "body", "timeoutMs", "maxResponseBytes", "maxChars",
        "maxRedirects", "expectedContentTypes",
      ],
    ),
    execute: executeHttpRequest,
  };
}
