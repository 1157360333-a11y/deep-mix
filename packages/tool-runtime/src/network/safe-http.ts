import { createHash } from "node:crypto";
import { promises as dns } from "node:dns";
import net from "node:net";

import type {
  NetworkAttemptSummary,
  NetworkAuditSummary,
  NetworkErrorType,
  NetworkHttpMethod,
  NetworkRequestSpec,
  NetworkResponseSummary,
  NetworkRedirectSummary,
} from "../../../shared-schema/src/index.js";
import type {
  ToolNetworkPinnedAddress,
  ToolNetworkResponse,
  ToolNetworkResponseConsumer,
  ToolNetworkResponseHead,
  ToolNetworkRoutePlan,
  ToolNetworkService,
} from "./index.js";

const REDIRECT_STATUSES = new Set([301, 302, 303, 307, 308]);
const READ_ONLY_METHODS = new Set<NetworkHttpMethod>(["GET", "HEAD"]);
const CROSS_ORIGIN_REDIRECT_HEADERS = new Set([
  "accept",
  "accept-encoding",
  "accept-language",
  "cache-control",
  "if-match",
  "if-modified-since",
  "if-none-match",
  "if-range",
  "if-unmodified-since",
  "pragma",
  "range",
  "user-agent",
]);
const FORBIDDEN_REQUEST_HEADER = /^(?:connection|content-length|host|proxy-authorization|proxy-connection|te|trailer|transfer-encoding|upgrade)$/iu;
const CLOUD_METADATA_HOSTS = new Set([
  "metadata",
  "metadata.google.internal",
  "instance-data",
  "instance-data.ec2.internal",
]);
const CLOUD_METADATA_IPV4 = new Set([
  "100.100.100.200",
  "168.63.129.16",
  "169.254.169.254",
  "169.254.170.2",
  "192.0.0.192",
]);
const CLOUD_METADATA_IPV6 = new Set(["fd00:ec2::254"]);
const DEFAULT_PLAN_TIMEOUT_MS = 3_000;
const DEFAULT_MAX_TOOL_BYTES = 32 * 1024 * 1024;
const DEFAULT_MAX_TURN_BYTES = 64 * 1024 * 1024;
const DEFAULT_GLOBAL_CONCURRENCY = 6;
const DEFAULT_TURN_CONCURRENCY = 2;
const DEFAULT_MAX_TURN_REQUESTS = 32;
const MAX_REQUEST_BODY_BYTES = 2 * 1024 * 1024;
const MAX_REDACTION_SECRET_VALUES = 256;
const MAX_REDACTION_SECRET_CHARS = 4 * 1024 * 1024;

export interface SafeNetworkResolvedAddress {
  address: string;
  family: 4 | 6;
}

export type SafeNetworkDnsResolver = (
  hostname: string,
  signal?: AbortSignal,
) => Promise<SafeNetworkResolvedAddress[]>;

export interface SafeNetworkBudgetOptions {
  maxGlobalConcurrency?: number;
  maxTurnConcurrency?: number;
  maxTurnBytes?: number;
  maxTurnRequests?: number;
}

interface TurnBudgetState {
  active: number;
  bytes: number;
  requests: number;
  touchedAt: number;
}

export interface SafeNetworkBudgetLease {
  remainingBytes(): number;
  consumeRequest(): void;
  consume(bytes: number): void;
  release(): void;
}

/** Shared per-module budget tracker. It stores only counters, never request data. */
export class SafeNetworkBudgetManager {
  private readonly states = new Map<string, TurnBudgetState>();

  private globalActive = 0;

  public constructor(private readonly defaults: SafeNetworkBudgetOptions = {}) {}

  public acquire(key: string, maxTurnBytes = this.defaults.maxTurnBytes ?? DEFAULT_MAX_TURN_BYTES): SafeNetworkBudgetLease {
    this.prune();
    const maxGlobal = this.defaults.maxGlobalConcurrency ?? DEFAULT_GLOBAL_CONCURRENCY;
    const maxForTurn = this.defaults.maxTurnConcurrency ?? DEFAULT_TURN_CONCURRENCY;
    const maxRequests = this.defaults.maxTurnRequests ?? DEFAULT_MAX_TURN_REQUESTS;
    const state = this.states.get(key) ?? { active: 0, bytes: 0, requests: 0, touchedAt: Date.now() };
    if (this.globalActive >= maxGlobal || state.active >= maxForTurn) {
      throw new SafeNetworkError("Network concurrency budget was exceeded.", "policy_denied", false);
    }
    if (state.bytes >= maxTurnBytes) {
      throw new SafeNetworkError("Network byte budget for this turn was exhausted.", "response_too_large", false);
    }
    if (state.requests >= maxRequests) {
      throw new SafeNetworkError("Network request budget for this turn was exhausted.", "policy_denied", false);
    }
    state.active += 1;
    state.touchedAt = Date.now();
    this.globalActive += 1;
    this.states.set(key, state);
    let released = false;
    return {
      remainingBytes: () => Math.max(0, maxTurnBytes - state.bytes),
      consumeRequest: () => {
        if (state.requests >= maxRequests) {
          throw new SafeNetworkError("Network request budget for this turn was exhausted.", "policy_denied", false);
        }
        state.requests += 1;
        state.touchedAt = Date.now();
      },
      consume: (bytes) => {
        if (!Number.isSafeInteger(bytes) || bytes < 0) {
          throw new SafeNetworkError("Network transport reported an invalid byte count.", "connection", false);
        }
        state.bytes += bytes;
        state.touchedAt = Date.now();
        if (state.bytes > maxTurnBytes) {
          throw new SafeNetworkError("Network byte budget for this turn was exceeded.", "response_too_large", false);
        }
      },
      release: () => {
        if (released) return;
        released = true;
        state.active = Math.max(0, state.active - 1);
        state.touchedAt = Date.now();
        this.globalActive = Math.max(0, this.globalActive - 1);
      },
    };
  }

  private prune(): void {
    if (this.states.size < 256) return;
    const expiry = Date.now() - 60 * 60 * 1_000;
    for (const [key, state] of this.states) {
      if (state.active === 0 && state.touchedAt < expiry) this.states.delete(key);
    }
  }
}

export class SafeNetworkError extends Error {
  public constructor(
    message: string,
    public readonly networkErrorType: NetworkErrorType,
    public readonly retryable: boolean,
    options?: { cause?: unknown; httpStatus?: number },
  ) {
    super(message, options?.cause === undefined ? undefined : { cause: options.cause });
    this.name = "SafeNetworkError";
    this.httpStatus = options?.httpStatus;
  }

  public readonly httpStatus?: number;

  public audit?: NetworkAuditSummary;
}

export interface SafeHttpRequestInput {
  network: ToolNetworkService;
  spec: NetworkRequestSpec;
  signal?: AbortSignal;
  budgetKey: string;
  budgetManager?: SafeNetworkBudgetManager;
  maxToolBytes?: number;
  maxTurnBytes?: number;
  environment?: NodeJS.ProcessEnv;
  resolveHostname?: SafeNetworkDnsResolver;
  authorizeHost?: (hostname: string) => Promise<void>;
  finalBodyConsumer?: ToolNetworkResponseConsumer;
}

export interface SafeHttpRequestResult {
  response: ToolNetworkResponse;
  summary: NetworkResponseSummary;
  audit: NetworkAuditSummary;
  /** In-memory only; callers use these values to redact endpoint echoes. */
  redactionSecrets: string[];
}

const defaultBudgetManager = new SafeNetworkBudgetManager();

function throwIfAborted(signal?: AbortSignal): void {
  if (!signal?.aborted) return;
  if (signal.reason instanceof SafeNetworkError) throw signal.reason;
  throw new SafeNetworkError("Network request was cancelled.", "cancelled", false, { cause: signal.reason });
}

export interface SafeNetworkDeadline {
  signal: AbortSignal;
  deadline: number;
  dispose(): void;
}

export function createSafeNetworkDeadline(parent: AbortSignal | undefined, timeoutMs: number): SafeNetworkDeadline {
  const controller = new AbortController();
  const deadline = Date.now() + timeoutMs;
  const onParentAbort = () => controller.abort(parent?.reason);
  if (parent?.aborted) onParentAbort();
  else parent?.addEventListener("abort", onParentAbort, { once: true });
  const timer = setTimeout(() => controller.abort(
    new SafeNetworkError("Network tool time budget was exhausted.", "timeout", false),
  ), Math.max(1, timeoutMs));
  return {
    signal: controller.signal,
    deadline,
    dispose: () => {
      clearTimeout(timer);
      parent?.removeEventListener("abort", onParentAbort);
    },
  };
}

export function isSensitiveNetworkHeaderName(name: string): boolean {
  const { compact, fields } = splitSensitiveName(name);
  if ([
    "apikey", "authorization", "authentication", "clientsecret", "cookie", "credential", "functionskey",
    "jwt", "password", "proxyauthorization", "secret", "session", "sessionid", "setcookie", "sid",
    "signature", "subscriptionkey", "token",
  ].includes(compact)) return true;
  if ([...fields].some((field) => [
    "accesskey", "accesstoken", "apikey", "clientsecret", "functionskey", "refreshtoken", "subscriptionkey",
  ].includes(field))) return true;
  if ([...fields].some((field) => [
    "auth", "authentication", "authorization", "cookie", "credential", "jwt", "password", "secret", "session",
    "sessionid", "sid", "signature", "token",
  ].includes(field))) return true;
  return fields.has("key") && [...fields].some((field) => (
    ["access", "api", "client", "functions", "private", "secret", "subscription"].includes(field)
  ));
}

export function isSensitiveNetworkQueryName(name: string): boolean {
  const { compact, fields } = splitSensitiveName(name);
  if ([
    "accesskey", "accesstoken", "apikey", "auth", "authorization", "code", "credential", "key", "oauth",
    "jwt", "password", "refreshtoken", "secret", "session", "sessionid", "sid", "sig", "signature", "token",
  ].includes(compact)) return true;
  if ([...fields].some((field) => ["accesskey", "accesstoken", "apikey", "refreshtoken"].includes(field))) return true;
  return [...fields].some((field) => [
    "auth", "authorization", "code", "credential", "jwt", "key", "oauth", "password", "secret", "session",
    "sessionid", "sid", "sig", "signature", "token",
  ].includes(field));
}

function splitSensitiveName(name: string): { compact: string; fields: Set<string> } {
  const fields = name
    .replace(/([a-z\d])([A-Z])/gu, "$1-$2")
    .normalize("NFKC")
    .toLocaleLowerCase("en-US")
    .split(/[^a-z\d]+/u)
    .filter(Boolean);
  return { compact: fields.join(""), fields: new Set(fields) };
}

export function extractSensitiveNetworkHeaderValues(name: string, value: string): string[] {
  if (!isSensitiveNetworkHeaderName(name)) return [];
  const fragments = [value];
  if (/cookie/iu.test(name)) {
    for (const part of value.split(";")) {
      const separator = part.indexOf("=");
      if (separator >= 0) fragments.push(part.slice(separator + 1).trim().replace(/^"|"$/gu, ""));
    }
  }
  if (/auth/iu.test(name)) {
    const schemeToken = /^\S+\s+(.+)$/u.exec(value)?.[1];
    if (schemeToken) fragments.push(schemeToken.trim());
    for (const match of value.matchAll(/(?:^|[,\s])[^=,\s]+=["]?([^",\s]+)["]?/gu)) {
      if (match[1]) fragments.push(match[1]);
    }
  }
  return [...new Set(fragments.filter(Boolean))];
}

export function expandSensitiveNetworkValues(values: readonly string[]): string[] {
  const expanded = new Set<string>();
  for (const value of values.filter(Boolean)) {
    expanded.add(value);
    const encoded = encodeURIComponent(value);
    expanded.add(encoded);
    expanded.add(encoded.replace(/%[\dA-F]{2}/gu, (match) => match.toLocaleLowerCase("en-US")));
    const formEncoded = new URLSearchParams({ value }).toString().slice("value=".length);
    expanded.add(formEncoded);
  }
  return [...expanded].filter(Boolean);
}

function decodeUrlComponentSafely(value: string): string {
  try {
    return decodeURIComponent(value);
  } catch {
    return value;
  }
}

function isSensitiveNetworkPathLabel(name: string): boolean {
  const { compact, fields } = splitSensitiveName(name);
  return isSensitiveNetworkHeaderName(name) ||
    ["auth", "credential", "secret", "sig", "signature", "token"].includes(compact) ||
    fields.has("sig");
}

/** Extract credentials carried in query parameters or credential-shaped path segments. */
export function extractSensitiveNetworkUrlValues(input: URL | string): string[] {
  let url: URL;
  try {
    url = input instanceof URL ? input : new URL(input);
  } catch {
    return [];
  }
  const values = [...url.searchParams.entries()]
    .filter(([name]) => isSensitiveNetworkQueryName(name))
    .map(([, value]) => value);
  const rawSegments = url.pathname.split("/").filter(Boolean);
  const baseSegments = rawSegments.map((segment) => decodeUrlComponentSafely(segment.split(";", 1)[0]!));
  for (let index = 0; index < rawSegments.length; index += 1) {
    const rawSegment = rawSegments[index]!;
    const parts = rawSegment.split(";");
    for (const part of parts) {
      const assignment = /^([^=:]{1,200})[=:](.+)$/u.exec(part);
      if (!assignment) continue;
      const name = decodeUrlComponentSafely(assignment[1]!);
      if (isSensitiveNetworkQueryName(name)) {
        values.push(decodeUrlComponentSafely(assignment[2]!));
      }
    }
    const label = baseSegments[index]!;
    const followingValue = baseSegments[index + 1];
    if (followingValue && isSensitiveNetworkPathLabel(label)) values.push(followingValue);
  }
  return [...new Set(values.filter(Boolean))];
}

async function abortable<T>(promise: Promise<T>, signal?: AbortSignal): Promise<T> {
  throwIfAborted(signal);
  if (!signal) return promise;
  return new Promise<T>((resolve, reject) => {
    const onAbort = () => reject(signal.reason instanceof SafeNetworkError
      ? signal.reason
      : new SafeNetworkError("Network request was cancelled.", "cancelled", false, { cause: signal.reason }));
    signal.addEventListener("abort", onAbort, { once: true });
    promise.then(resolve, reject).finally(() => signal.removeEventListener("abort", onAbort));
  });
}

function authorityHostname(rawUrl: string): string | undefined {
  const authority = /^[a-z][a-z\d+.-]*:\/\/([^/?#]*)/iu.exec(rawUrl)?.[1];
  if (!authority || authority.includes("@")) return undefined;
  if (authority.startsWith("[")) return /^\[([^\]]+)\](?::\d+)?$/u.exec(authority)?.[1];
  return authority.replace(/:\d+$/u, "");
}

function isObscuredIpv4Host(rawHostname: string | undefined, parsedHostname: string): boolean {
  if (!rawHostname || net.isIP(parsedHostname) !== 4) return false;
  if (!/^\d+\.\d+\.\d+\.\d+$/u.test(rawHostname)) return true;
  return rawHostname.split(".").some((part) => part.length > 1 && part.startsWith("0"));
}

export function parseSafeHttpUrl(value: string): URL {
  if (typeof value !== "string" || value.length === 0 || value.length > 4_096) {
    throw new SafeNetworkError("Network URL must contain 1 to 4096 characters.", "policy_denied", false);
  }
  if (/[\u0000-\u0020\\]/u.test(value)) {
    throw new SafeNetworkError("Network URL contains ambiguous or control characters.", "policy_denied", false);
  }
  let url: URL;
  try {
    url = new URL(value);
  } catch (error) {
    throw new SafeNetworkError("Network URL is invalid.", "policy_denied", false, { cause: error });
  }
  if (url.protocol !== "http:" && url.protocol !== "https:") {
    throw new SafeNetworkError("Only HTTP and HTTPS network URLs are allowed.", "policy_denied", false);
  }
  if (url.username || url.password) {
    throw new SafeNetworkError("Network URLs must not contain user information.", "policy_denied", false);
  }
  if (!url.hostname || url.hostname.endsWith(".") || url.hostname.includes("..")) {
    throw new SafeNetworkError("Network URL contains an ambiguous hostname.", "policy_denied", false);
  }
  if (url.port === "0") {
    throw new SafeNetworkError("Network URL port 0 is not allowed.", "policy_denied", false);
  }
  if (isObscuredIpv4Host(authorityHostname(value), url.hostname)) {
    throw new SafeNetworkError("Obscured numeric hostnames are not allowed.", "policy_denied", false);
  }
  url.hash = "";
  return url;
}

function validateRequestSpec(spec: NetworkRequestSpec): void {
  if (!(["GET", "HEAD", "POST", "PUT", "PATCH", "DELETE"] as string[]).includes(spec.method)) {
    throw new SafeNetworkError("HTTP method is not allowed.", "policy_denied", false);
  }
  if (!Number.isSafeInteger(spec.timeoutMs) || spec.timeoutMs < 100 || spec.timeoutMs > 120_000) {
    throw new SafeNetworkError("Network timeout is outside the allowed range.", "policy_denied", false);
  }
  if (
    !Number.isSafeInteger(spec.maxResponseBytes) ||
    spec.maxResponseBytes < 0 ||
    spec.maxResponseBytes > 64 * 1024 * 1024
  ) {
    throw new SafeNetworkError("Network response byte limit is outside the allowed range.", "policy_denied", false);
  }
  if (!Number.isSafeInteger(spec.maxRedirects) || spec.maxRedirects < 0 || spec.maxRedirects > 10) {
    throw new SafeNetworkError("Network redirect limit is outside the allowed range.", "policy_denied", false);
  }
}

function parseIpv4(address: string): number[] | undefined {
  if (net.isIP(address) !== 4) return undefined;
  const bytes = address.split(".").map(Number);
  return bytes.length === 4 && bytes.every((byte) => Number.isInteger(byte) && byte >= 0 && byte <= 255)
    ? bytes
    : undefined;
}

function parseIpv6(address: string): Uint8Array | undefined {
  if (net.isIP(address) !== 6) return undefined;
  const normalized = address.toLocaleLowerCase().split("%", 1)[0]!;
  const halves = normalized.split("::");
  if (halves.length > 2) return undefined;
  const parseHalf = (half: string): number[] | undefined => {
    if (!half) return [];
    const groups: number[] = [];
    for (const part of half.split(":")) {
      if (part.includes(".")) {
        const ipv4 = parseIpv4(part);
        if (!ipv4) return undefined;
        groups.push((ipv4[0]! << 8) | ipv4[1]!, (ipv4[2]! << 8) | ipv4[3]!);
      } else {
        if (!/^[\da-f]{1,4}$/u.test(part)) return undefined;
        groups.push(Number.parseInt(part, 16));
      }
    }
    return groups;
  };
  const left = parseHalf(halves[0]!);
  const right = parseHalf(halves[1] ?? "");
  if (!left || !right) return undefined;
  const missing = 8 - left.length - right.length;
  if ((halves.length === 1 && missing !== 0) || (halves.length === 2 && missing < 1)) return undefined;
  const groups = [...left, ...Array.from({ length: Math.max(0, missing) }, () => 0), ...right];
  if (groups.length !== 8) return undefined;
  const bytes = new Uint8Array(16);
  groups.forEach((group, index) => {
    bytes[index * 2] = group >> 8;
    bytes[index * 2 + 1] = group & 0xff;
  });
  return bytes;
}

function matchesIpv6Prefix(address: Uint8Array, prefix: readonly number[], bits: number): boolean {
  const fullBytes = Math.floor(bits / 8);
  for (let index = 0; index < fullBytes; index += 1) {
    if (address[index] !== prefix[index]) return false;
  }
  const remainingBits = bits % 8;
  if (remainingBits === 0) return true;
  const mask = (0xff << (8 - remainingBits)) & 0xff;
  return (address[fullBytes]! & mask) === ((prefix[fullBytes] ?? 0) & mask);
}

const SPECIAL_IPV6_PREFIXES: ReadonlyArray<readonly [readonly number[], number]> = [
  [[0x00, 0x64, 0xff, 0x9b, 0, 0, 0, 0, 0, 0, 0, 0], 96], // IPv4/IPv6 translation
  [[0x00, 0x64, 0xff, 0x9b, 0, 1], 48], // local-use translation
  [[0x01, 0x00, 0, 0, 0, 0, 0, 0], 64], // discard-only
  [[0x20, 0x01, 0], 23], // IETF protocol assignments, including benchmarking and ORCHID
  [[0x20, 0x01, 0x0d, 0xb8], 32], // documentation
  [[0x20, 0x02], 16], // deprecated 6to4
  [[0x26, 0x20, 0x00, 0x4f, 0x80, 0x00], 48], // AS112 direct delegation
  [[0x3f, 0xff, 0], 20], // documentation
  [[0x5f, 0x00], 16], // segment-routing SIDs
];

type AddressClass = "public" | "private" | "loopback" | "link_local" | "metadata" | "special";

export function classifyIpAddress(address: string): AddressClass {
  const ipv4 = parseIpv4(address);
  if (ipv4) {
    const [a, b] = ipv4;
    if (CLOUD_METADATA_IPV4.has(address)) return "metadata";
    if (a === 127) return "loopback";
    if (a === 169 && b === 254) return "link_local";
    if (a === 10 || (a === 172 && b! >= 16 && b! <= 31) || (a === 192 && b === 168)) return "private";
    if (
      a === 0 ||
      (a === 100 && b! >= 64 && b! <= 127) ||
      (a === 192 && b === 0) ||
      (a === 192 && b === 88 && ipv4[2] === 99) ||
      (a === 198 && (b === 18 || b === 19 || b === 51)) ||
      (a === 203 && b === 0 && ipv4[2] === 113) ||
      a! >= 224
    ) return "special";
    return "public";
  }
  const ipv6 = parseIpv6(address);
  if (!ipv6) return "special";
  if (CLOUD_METADATA_IPV6.has(address.toLocaleLowerCase())) return "metadata";
  if (ipv6.every((byte) => byte === 0)) return "special";
  if (ipv6.slice(0, 15).every((byte) => byte === 0) && ipv6[15] === 1) return "loopback";
  const mapped = ipv6.slice(0, 10).every((byte) => byte === 0) && ipv6[10] === 0xff && ipv6[11] === 0xff;
  if (mapped) return classifyIpAddress(`${ipv6[12]}.${ipv6[13]}.${ipv6[14]}.${ipv6[15]}`);
  if ((ipv6[0]! & 0xfe) === 0xfc) return "private";
  if (ipv6[0] === 0xfe && (ipv6[1]! & 0xc0) === 0x80) return "link_local";
  if (ipv6[0] === 0xff) return "special";
  if (SPECIAL_IPV6_PREFIXES.some(([prefix, bits]) => matchesIpv6Prefix(ipv6, prefix, bits))) return "special";
  return (ipv6[0]! & 0xe0) === 0x20 ? "public" : "special";
}

function assertHostnamePolicy(hostname: string, allowPrivateNetworkForTests: boolean): void {
  const normalized = hostname.replace(/^\[|\]$/gu, "").toLocaleLowerCase();
  if (CLOUD_METADATA_HOSTS.has(normalized)) {
    throw new SafeNetworkError("Cloud metadata hosts are blocked.", "policy_denied", false);
  }
  if (net.isIP(normalized) === 0) {
    if (normalized === "localhost" || normalized.endsWith(".localhost")) {
      if (allowPrivateNetworkForTests) return;
      throw new SafeNetworkError("Loopback hosts are blocked.", "policy_denied", false);
    }
    if (!normalized.includes(".")) {
      throw new SafeNetworkError("Single-label network hosts are blocked.", "policy_denied", false);
    }
  }
}

export function assertSafeIpAddress(address: string, allowPrivateNetworkForTests = false): void {
  const classification = classifyIpAddress(address);
  if (classification === "public") return;
  if (
    allowPrivateNetworkForTests &&
    (classification === "private" || classification === "loopback" || classification === "link_local")
  ) return;
  const message = classification === "metadata"
    ? "Cloud metadata addresses are blocked."
    : `${classification.replace("_", "-")} network addresses are blocked.`;
  throw new SafeNetworkError(message, "policy_denied", false);
}

export function privateNetworkTestOverride(environment: NodeJS.ProcessEnv): boolean {
  return environment.NODE_ENV === "test" && environment.DEEP_MIX_TEST_ALLOW_PRIVATE_NETWORK === "1";
}

const defaultDnsResolver: SafeNetworkDnsResolver = async (hostname) => {
  const entries = await dns.lookup(hostname, { all: true, verbatim: true });
  return entries.map((entry) => ({ address: entry.address, family: entry.family as 4 | 6 }));
};

async function resolvePinnedAddress(input: {
  url: URL;
  signal?: AbortSignal;
  timeoutMs: number;
  allowPrivateNetworkForTests: boolean;
  resolver: SafeNetworkDnsResolver;
}): Promise<ToolNetworkPinnedAddress> {
  const hostname = input.url.hostname.replace(/^\[|\]$/gu, "").toLocaleLowerCase();
  assertHostnamePolicy(hostname, input.allowPrivateNetworkForTests);
  const literalFamily = net.isIP(hostname);
  let addresses: SafeNetworkResolvedAddress[];
  if (literalFamily) {
    addresses = [{ address: hostname, family: literalFamily as 4 | 6 }];
  } else {
    const controller = new AbortController();
    const onAbort = () => controller.abort(input.signal?.reason);
    if (input.signal?.aborted) onAbort();
    else input.signal?.addEventListener("abort", onAbort, { once: true });
    const timeout = setTimeout(() => controller.abort(
      new SafeNetworkError("DNS resolution timed out.", "timeout", true),
    ), Math.max(1, input.timeoutMs));
    try {
      addresses = await abortable(input.resolver(hostname, controller.signal), controller.signal).catch((error) => {
        if (error instanceof SafeNetworkError) throw error;
        throw new SafeNetworkError("DNS resolution failed.", "dns", true, { cause: error });
      });
    } finally {
      clearTimeout(timeout);
      input.signal?.removeEventListener("abort", onAbort);
    }
  }
  if (addresses.length === 0) throw new SafeNetworkError("DNS returned no addresses.", "dns", true);
  const normalized = [...new Map(addresses.map((entry) => [`${entry.family}:${entry.address}`, entry])).values()];
  for (const entry of normalized) {
    if (net.isIP(entry.address) !== entry.family) {
      throw new SafeNetworkError("DNS returned an invalid address.", "dns", false);
    }
    assertSafeIpAddress(entry.address, input.allowPrivateNetworkForTests);
  }
  const selected = normalized[0]!;
  return { hostname, address: selected.address, family: selected.family };
}

function validateRequestHeaders(headers: Record<string, string> | undefined): Record<string, string> {
  const result: Record<string, string> = {};
  for (const [rawName, rawValue] of Object.entries(headers ?? {})) {
    const name = rawName.trim().toLocaleLowerCase();
    if (!/^[!#$%&'*+.^_`|~\dA-Za-z-]+$/u.test(name)) {
      throw new SafeNetworkError("Request contains an invalid header name.", "policy_denied", false);
    }
    if (FORBIDDEN_REQUEST_HEADER.test(name)) {
      throw new SafeNetworkError(`Request header ${name} is controlled by the network service.`, "policy_denied", false);
    }
    if (/[\r\n\u0000]/u.test(rawValue) || rawValue.length > 8_192) {
      throw new SafeNetworkError(`Request header ${name} contains an invalid value.`, "policy_denied", false);
    }
    result[name] = rawValue;
  }
  return result;
}

function requestBody(spec: NetworkRequestSpec, headers: Record<string, string>): Buffer | undefined {
  if (!spec.body) return undefined;
  if (READ_ONLY_METHODS.has(spec.method)) {
    throw new SafeNetworkError(`${spec.method} requests must not include a body.`, "policy_denied", false);
  }
  if (
    spec.body.contentType !== undefined &&
    (!spec.body.contentType.trim() || spec.body.contentType.length > 200 || /[\r\n\u0000]/u.test(spec.body.contentType))
  ) {
    throw new SafeNetworkError("Request body content type is invalid.", "policy_denied", false);
  }
  let body: Buffer;
  if (spec.body.kind === "base64") {
    if (!/^(?:[A-Za-z\d+/]{4})*(?:[A-Za-z\d+/]{2}==|[A-Za-z\d+/]{3}=)?$/u.test(spec.body.content)) {
      throw new SafeNetworkError("Request base64 body is invalid.", "policy_denied", false);
    }
    body = Buffer.from(spec.body.content, "base64");
    headers["content-type"] ??= spec.body.contentType?.trim() ?? "application/octet-stream";
  } else {
    body = Buffer.from(spec.body.content, "utf8");
    headers["content-type"] ??= spec.body.contentType?.trim() ??
      (spec.body.kind === "json" ? "application/json; charset=utf-8" : "text/plain; charset=utf-8");
  }
  if (body.byteLength > MAX_REQUEST_BODY_BYTES) {
    throw new SafeNetworkError(`Request body exceeded ${MAX_REQUEST_BODY_BYTES} bytes.`, "response_too_large", false);
  }
  return body;
}

function contentTypeEssence(headers: Record<string, string>): string | undefined {
  const value = Object.entries(headers).find(([name]) => name.toLocaleLowerCase() === "content-type")?.[1];
  return value?.split(";", 1)[0]?.trim().toLocaleLowerCase() || undefined;
}

function contentTypeMatches(actual: string, expected: string): boolean {
  const normalized = expected.split(";", 1)[0]!.trim().toLocaleLowerCase();
  if (normalized === "*/*" || actual === normalized) return true;
  if (normalized.endsWith("/*")) return actual.startsWith(normalized.slice(0, -1));
  if (normalized === "application/json") return actual === "application/json" || actual.endsWith("+json");
  return false;
}

function validateExpectedContentType(
  response: Pick<ToolNetworkResponse, "status" | "headers">,
  expected: string[] | undefined,
): void {
  // Expected media types constrain successful payloads. Error/terminal
  // redirect responses remain inspectable with their status and bounded body.
  if (!expected?.length || response.status < 200 || response.status >= 300 || response.status === 204) return;
  const actual = contentTypeEssence(response.headers);
  if (actual && expected.some((entry) => contentTypeMatches(actual, entry))) return;
  throw new SafeNetworkError(
    `Response content type ${actual ?? "unknown"} did not match the expected type.`,
    "content_type",
    false,
  );
}

function responseHeader(response: ToolNetworkResponse, name: string): string | undefined {
  const normalized = name.toLocaleLowerCase();
  return Object.entries(response.headers).find(([key]) => key.toLocaleLowerCase() === normalized)?.[1];
}

function sameOrigin(left: URL, right: URL): boolean {
  return left.protocol === right.protocol && left.hostname === right.hostname && left.port === right.port;
}

function redirectHeaders(headers: Record<string, string>, from: URL, to: URL): Record<string, string> {
  if (sameOrigin(from, to)) return headers;
  return Object.fromEntries(Object.entries(headers).filter(([name]) => (
    CROSS_ORIGIN_REDIRECT_HEADERS.has(name.toLocaleLowerCase())
  )));
}

function collectErrorDetails(error: unknown): { codes: string[]; messages: string[] } {
  const codes: string[] = [];
  const messages: string[] = [];
  const seen = new Set<unknown>();
  let current = error;
  for (let depth = 0; current && depth < 8 && !seen.has(current); depth += 1) {
    seen.add(current);
    if (current instanceof Error && current.message) messages.push(current.message);
    if (typeof current === "object" && current && "code" in current) {
      const code = String((current as { code?: unknown }).code ?? "");
      if (/^[A-Z\d_-]{2,80}$/u.test(code)) codes.push(code);
    }
    current = current instanceof Error ? (current as Error & { cause?: unknown }).cause : undefined;
  }
  return { codes: [...new Set(codes)], messages: [...new Set(messages)] };
}

export function redactUrl(value: string, secrets: readonly string[] = []): string {
  try {
    const url = new URL(value);
    url.username = "";
    url.password = "";
    // Fragments are never sent in HTTP requests and can carry OAuth tokens.
    // Persistence/audit views omit them entirely rather than guessing syntax.
    url.hash = "";
    const urlSecrets = extractSensitiveNetworkUrlValues(url);
    const queryEntries = [...url.searchParams.entries()];
    const querySecrets = queryEntries
      .filter(([key]) => isSensitiveNetworkQueryName(key))
      .map(([, queryValue]) => queryValue);
    const expandedUrlSecrets = [...new Set([
      ...secrets,
      ...expandSensitiveNetworkValues([...querySecrets, ...urlSecrets]),
    ])].filter(Boolean);
    const pathSegments = url.pathname.split("/").map((rawSegment) => {
      if (!rawSegment) return rawSegment;
      return rawSegment.split(";").map((rawPart, partIndex) => {
        const decodedPart = decodeUrlComponentSafely(rawPart);
        const assignment = /^([^=:]{1,200})([:=])(.+)$/u.exec(decodedPart);
        if (assignment && isSensitiveNetworkQueryName(assignment[1]!)) {
          return `${encodeURIComponent("[REDACTED_PATH]")}${assignment[2]}${encodeURIComponent("[REDACTED]")}`;
        }
        if (partIndex === 0 && isSensitiveNetworkPathLabel(decodedPart)) {
          return encodeURIComponent("[REDACTED_PATH]");
        }
        return rawPart;
      }).join(";");
    });
    url.pathname = pathSegments.join("/");
    url.search = "";
    for (const [key, queryValue] of queryEntries) {
      const safeKey = safePersistenceMapKey(key, "query", expandedUrlSecrets);
      url.searchParams.append(
        safeKey,
        isSensitiveNetworkQueryName(key)
          ? "[REDACTED]"
          : redactSensitiveText(queryValue, expandedUrlSecrets),
      );
    }
    let redacted = url.toString();
    for (const secret of expandedUrlSecrets) {
      redacted = redacted.split(secret).join("[REDACTED]");
    }
    return redacted;
  } catch {
    return "[invalid-url]";
  }
}

function safePersistenceMapKey(
  name: string,
  kind: "header" | "query",
  secrets: readonly string[],
): string {
  const valid = kind === "header"
    ? /^[!#$%&'*+.^_`|~A-Za-z\d-]{1,200}$/u.test(name)
    : /^[A-Za-z\d._~-]{1,200}$/u.test(name);
  const sensitiveName = kind === "header"
    ? isSensitiveNetworkHeaderName(name)
    : isSensitiveNetworkQueryName(name);
  if (!valid || sensitiveName || redactSensitiveText(name, secrets) !== name) {
    return kind === "header" ? "[REDACTED_HEADER]" : "[REDACTED_QUERY]";
  }
  return name;
}

/** Bounded persistence/hook view of network arguments; execution keeps the protected original. */
export function redactNetworkToolArguments(
  argumentsValue: Record<string, unknown>,
  toolAllowedKeys?: readonly string[],
): Record<string, unknown> {
  const allAllowedKeys = [
    "body", "expectedContentTypes", "headers", "maxBytes", "maxChars", "maxRedirects", "maxResponseBytes",
    "method", "outputName", "overwriteStrategy", "query", "target", "timeoutMs", "url", "workspacePath",
  ];
  const allowedKeys = new Set(toolAllowedKeys ?? allAllowedKeys);
  // Build from the fixed schema allowlist. Retaining unknown property names
  // would itself leak secrets embedded in malformed model-generated keys.
  const result = Object.fromEntries(
    [...allowedKeys]
      .filter((key) => Object.prototype.hasOwnProperty.call(argumentsValue, key))
      .map((key) => [key, argumentsValue[key]]),
  );
  const argumentSecrets: string[] = [];
  if (typeof result.headers === "object" && result.headers && !Array.isArray(result.headers)) {
    for (const [name, value] of Object.entries(result.headers as Record<string, unknown>)) {
      if (typeof value === "string") argumentSecrets.push(...extractSensitiveNetworkHeaderValues(name, value));
    }
  }
  if (typeof result.query === "object" && result.query && !Array.isArray(result.query)) {
    for (const [name, value] of Object.entries(result.query as Record<string, unknown>)) {
      if (typeof value === "string" && isSensitiveNetworkQueryName(name)) argumentSecrets.push(value);
    }
  }
  if (typeof result.url === "string") {
    try {
      const argumentUrl = new URL(result.url);
      for (const [name, value] of argumentUrl.searchParams) {
        if (isSensitiveNetworkQueryName(name)) argumentSecrets.push(value);
      }
    } catch {
      // Invalid URLs are replaced below; do not inspect them heuristically.
    }
  }
  const expandedArgumentSecrets = expandSensitiveNetworkValues(argumentSecrets);
  if ("url" in result) {
    result.url = typeof result.url === "string"
      ? redactUrl(result.url, expandedArgumentSecrets)
      : "[REDACTED]";
  }
  if (typeof result.headers === "object" && result.headers && !Array.isArray(result.headers)) {
    result.headers = Object.fromEntries(Object.entries(result.headers as Record<string, unknown>).map(([name, value]) => [
      safePersistenceMapKey(name, "header", expandedArgumentSecrets),
      isSensitiveNetworkHeaderName(name) || typeof value !== "string"
        ? "[REDACTED]"
        : redactSensitiveText(value, expandedArgumentSecrets),
    ]));
  } else if ("headers" in result) {
    result.headers = "[REDACTED]";
  }
  if (typeof result.query === "object" && result.query && !Array.isArray(result.query)) {
    result.query = Object.fromEntries(Object.entries(result.query as Record<string, unknown>).map(([name, value]) => [
      safePersistenceMapKey(name, "query", expandedArgumentSecrets),
      isSensitiveNetworkQueryName(name) || typeof value !== "string"
        ? "[REDACTED]"
        : redactSensitiveText(value, expandedArgumentSecrets),
    ]));
  } else if ("query" in result) {
    result.query = "[REDACTED]";
  }
  if (typeof result.body === "object" && result.body && !Array.isArray(result.body)) {
    const body = result.body as Record<string, unknown>;
    result.body = "content" in body
      ? {
          kind: typeof body.kind === "string" && ["base64", "json", "text"].includes(body.kind)
            ? body.kind
            : "[REDACTED]",
          content: "[REDACTED]",
          ...(typeof body.contentType === "string" && body.contentType.length <= 200 && !/[\r\n\u0000]/u.test(body.contentType)
            ? { contentType: redactSensitiveText(body.contentType, expandedArgumentSecrets) }
            : ("contentType" in body ? { contentType: "[REDACTED]" } : {})),
        }
      : { redacted: true };
  } else if ("body" in result) {
    result.body = { redacted: true };
  }
  for (const key of ["maxBytes", "maxChars", "maxRedirects", "maxResponseBytes", "timeoutMs"] as const) {
    if (key in result && (typeof result[key] !== "number" || !Number.isSafeInteger(result[key]) || result[key] < 0)) {
      result[key] = "[REDACTED]";
    }
  }
  const enumValues: Record<string, ReadonlySet<string>> = {
    method: new Set(["DELETE", "GET", "HEAD", "PATCH", "POST", "PUT"]),
    overwriteStrategy: new Set(["error", "replace", "unique"]),
    target: new Set(["artifact", "workspace"]),
  };
  for (const [key, values] of Object.entries(enumValues)) {
    if (key in result && (typeof result[key] !== "string" || !values.has(result[key]))) {
      result[key] = "[REDACTED]";
    }
  }
  for (const key of ["outputName", "workspacePath"] as const) {
    if (!(key in result)) continue;
    result[key] = typeof result[key] === "string" && result[key].length <= 4_096
      ? redactSensitiveText(result[key], expandedArgumentSecrets)
      : "[REDACTED]";
  }
  if ("expectedContentTypes" in result) {
    result.expectedContentTypes = Array.isArray(result.expectedContentTypes) &&
      result.expectedContentTypes.length <= 32 &&
      result.expectedContentTypes.every((value) => (
        typeof value === "string" && value.length > 0 && value.length <= 200 &&
        /^[A-Za-z\d!#$&^_.+-]+\/(?:\*|[A-Za-z\d!#$&^_.+-]+)(?:\s*;[^\r\n\u0000]{0,160})?$/u.test(value)
      ))
      ? result.expectedContentTypes.map((value) => redactSensitiveText(value, expandedArgumentSecrets))
      : "[REDACTED]";
  }
  return result;
}

export function redactSensitiveText(value: string, secrets: readonly string[] = []): string {
  let redacted = value;
  for (const secret of [...new Set(secrets)].filter(Boolean)) {
    redacted = redacted.split(secret).join("[REDACTED]");
  }
  return redacted
    .replace(/\b(Bearer|Basic)\s+[A-Za-z\d._~+\/-]+=*/giu, "$1 [REDACTED]")
    .replace(/((?:api[-_]?key|auth(?:entication|orization)?|cookie|credential|jwt|passwd|password|pwd|secret|session(?:[-_]?id)?|sid|sig(?:nature)?|token)\s*[:=]\s*)[^\s,;]+/giu, "$1[REDACTED]")
    .replace(/([a-z][a-z\d+.-]*:\/\/)[^\s/@]+@/giu, "$1[REDACTED]@")
    .slice(0, 2_000);
}

export function filterHighSignalHeaders(
  headers: Record<string, string>,
  secrets: readonly string[] = [],
): Record<string, string> {
  const exact = new Set([
    "cache-control",
    "content-disposition",
    "content-language",
    "content-length",
    "content-type",
    "etag",
    "last-modified",
    "retry-after",
    "x-request-id",
  ]);
  const result: Record<string, string> = {};
  for (const [rawName, value] of Object.entries(headers)) {
    const name = rawName.toLocaleLowerCase();
    if (isSensitiveNetworkHeaderName(name)) continue;
    if (!exact.has(name) && !/^x-ratelimit-(?:limit|remaining|reset)$/u.test(name)) continue;
    result[name] = redactSensitiveText(value, secrets).slice(0, 1_000);
  }
  return result;
}

export function classifySafeNetworkFailure(error: unknown): SafeNetworkError {
  if (error instanceof SafeNetworkError) return error;
  const details = collectErrorDetails(error);
  const combined = `${details.codes.join(" ")} ${details.messages.join(" ")}`;
  const message = redactSensitiveText(details.messages[0] ?? "Network request failed.");
  if (/ABORT_ERR|ERR_ABORTED|cancelled|canceled|aborted/iu.test(combined)) {
    return new SafeNetworkError("Network request was cancelled.", "cancelled", false, { cause: error });
  }
  if (/ETIMEDOUT|ESOCKETTIMEDOUT|ERR_TIMED_OUT|HEADERS_TIMEOUT|BODY_TIMEOUT|CONNECT_TIMEOUT|timed out/iu.test(combined)) {
    return new SafeNetworkError("Network request timed out.", "timeout", true, { cause: error });
  }
  if (/ERR_RESPONSE_TOO_LARGE|exceeded .* bytes/iu.test(combined)) {
    return new SafeNetworkError("Network response exceeded its byte limit.", "response_too_large", false, {
      cause: error,
    });
  }
  if (/ENOTFOUND|EAI_AGAIN|ERR_NAME_NOT_RESOLVED|DNS/iu.test(combined)) {
    return new SafeNetworkError("DNS resolution failed.", "dns", true, { cause: error });
  }
  if (/CERT_|ERR_TLS|SELF_SIGNED|UNABLE_TO_VERIFY|CERTIFICATE|SSL_/iu.test(combined)) {
    return new SafeNetworkError("TLS certificate validation failed.", "tls", false, { cause: error });
  }
  if (
    /ERR_PROXY_(?:AUTH|UNSUPPORTED)|PROXY[^\n]{0,80}(?:407|AUTHENTICATION REQUIRED|AUTH REQUIRED|UNSUPPORTED)|PAC[^\n]{0,80}UNSUPPORTED/iu
      .test(combined)
  ) {
    return new SafeNetworkError("Configured system proxy policy cannot be used safely.", "policy_denied", false, {
      cause: error,
    });
  }
  if (/PROXY|TUNNEL|PAC/iu.test(combined)) {
    const explicitlyTransient = /ERR_PROXY_CONNECTION_FAILED|ECONNREFUSED|ECONNRESET|ENETUNREACH|EHOSTUNREACH|EPIPE/iu
      .test(combined);
    return new SafeNetworkError("System proxy connection failed.", "proxy", explicitlyTransient, { cause: error });
  }
  if (/ECONNREFUSED|ECONNRESET|ENETUNREACH|EHOSTUNREACH|EPIPE|SOCKET|fetch failed/iu.test(combined)) {
    return new SafeNetworkError("Network connection failed.", "connection", true, { cause: error });
  }
  return new SafeNetworkError(message, "connection", false, { cause: error });
}

async function planWithFallback(
  network: ToolNetworkService,
  url: URL,
  signal: AbortSignal | undefined,
  remainingMs: number,
  allowDirectFallback: boolean,
): Promise<ToolNetworkRoutePlan> {
  const planTimeout = Math.max(1, Math.min(DEFAULT_PLAN_TIMEOUT_MS, remainingMs));
  let timeout: ReturnType<typeof setTimeout> | undefined;
  try {
    return await abortable(Promise.race([
      network.plan(url),
      new Promise<never>((_resolve, reject) => {
        timeout = setTimeout(
          () => reject(Object.assign(new Error("System proxy discovery timed out."), { code: "ETIMEDOUT" })),
          planTimeout,
        );
      }),
    ]), signal);
  } catch (error) {
    if (signal?.aborted) throwIfAborted(signal);
    const failure = classifySafeNetworkFailure(error);
    if (!allowDirectFallback) {
      throw new SafeNetworkError("System proxy discovery failed for a state-changing request.", failure.networkErrorType, false, {
        cause: failure,
      });
    }
    if (!failure.retryable) throw failure;
    return { routes: [{ route: "direct", source: "direct" }], systemRouteDistinct: false };
  } finally {
    if (timeout) clearTimeout(timeout);
  }
}

function safeFinalBodyConsumer(input: {
  consumer?: ToolNetworkResponseConsumer;
  expectedContentTypes?: string[];
  accountBytes: (bytes: number) => void;
}): { consumer: ToolNetworkResponseConsumer; collectBody: boolean | ((head: ToolNetworkResponseHead) => boolean) } {
  let forward = false;
  return {
    consumer: {
      onResponse: async (head) => {
        forward = head.ok && !REDIRECT_STATUSES.has(head.status);
        if (forward) {
          validateExpectedContentType(head, input.expectedContentTypes);
          await input.consumer?.onResponse?.(head);
        }
      },
      onChunkReceived: input.accountBytes,
      onChunk: async (chunk) => {
        if (forward) await input.consumer?.onChunk?.(chunk);
      },
    },
    collectBody: input.consumer
      ? (head) => !(head.ok && !REDIRECT_STATUSES.has(head.status))
      : true,
  };
}

function applyQuery(url: URL, query: Record<string, string> | undefined): void {
  for (const [key, value] of Object.entries(query ?? {})) {
    if (!key || key.length > 200 || value.length > 4_096) {
      throw new SafeNetworkError("Request query parameter exceeded its limit.", "policy_denied", false);
    }
    url.searchParams.set(key, value);
  }
}

function boundedRedactionSecretValues(values: readonly string[]): string[] {
  const bounded = [...new Set(values.filter(Boolean))];
  const totalChars = bounded.reduce((total, value) => total + value.length, 0);
  if (bounded.length > MAX_REDACTION_SECRET_VALUES || totalChars > MAX_REDACTION_SECRET_CHARS) {
    throw new SafeNetworkError(
      "Request contains too many distinct protected values for bounded response redaction.",
      "policy_denied",
      false,
    );
  }
  return bounded;
}

function mergeBoundedRedactionSecrets(target: Set<string>, incoming: readonly string[]): void {
  const bounded = boundedRedactionSecretValues([...target, ...incoming]);
  target.clear();
  for (const value of bounded) target.add(value);
}

function requestRedactionSecrets(
  url: URL,
  headers: Record<string, string>,
  body: NetworkRequestSpec["body"],
): string[] {
  const secrets = [
    ...extractSensitiveNetworkUrlValues(url),
    ...Object.entries(headers).flatMap(([name, value]) => extractSensitiveNetworkHeaderValues(name, value)),
  ];
  const expanded = expandSensitiveNetworkValues(secrets);
  if (body?.content) {
    // The raw request body is protected input. Keep even large bodies as one
    // in-memory exact-match secret so a reflective endpoint cannot copy it
    // into ordinary tool output; only small bodies receive encoded variants.
    expanded.push(body.content);
    if (body.content.length <= 2_048) {
      expanded.push(...expandSensitiveNetworkValues([body.content]));
    }
    if (body.kind === "base64") {
      const decoded = Buffer.from(body.content, "base64");
      const decodedText = decoded.toString("utf8");
      // Only treat a lossless UTF-8 decoding as text. Binary payloads remain
      // protected by their original base64 representation without inventing
      // lossy string secrets that could over-redact unrelated output.
      if (Buffer.from(decodedText, "utf8").equals(decoded) && decodedText) {
        expanded.push(decodedText);
        if (decodedText.length <= 2_048) {
          expanded.push(...expandSensitiveNetworkValues([decodedText]));
        }
        for (const match of decodedText.matchAll(
          /(?:api[-_]?key|auth(?:entication|orization)?|cookie|credential|jwt|oauth|passwd|password|pwd|secret|session(?:[-_]?id)?|sid|sig(?:nature)?|token)["']?\s*[:=]\s*["']?([^\s"'&,;}{\]]{3,2048})/giu,
        )) {
          if (match[1]) expanded.push(...expandSensitiveNetworkValues([match[1]]));
        }
      }
    } else {
      for (const match of body.content.matchAll(
        /(?:api[-_]?key|auth(?:entication|orization)?|cookie|credential|jwt|oauth|passwd|password|pwd|secret|session(?:[-_]?id)?|sid|sig(?:nature)?|token)["']?\s*[:=]\s*["']?([^\s"'&,;}{\]]{3,2048})/giu,
      )) {
        if (match[1]) expanded.push(...expandSensitiveNetworkValues([match[1]]));
      }
    }
  }
  return boundedRedactionSecretValues(expanded);
}

export async function executeSafeHttpRequest(input: SafeHttpRequestInput): Promise<SafeHttpRequestResult> {
  validateRequestSpec(input.spec);
  const budgetManager = input.budgetManager ?? defaultBudgetManager;
  const maxToolBytes = input.maxToolBytes ?? DEFAULT_MAX_TOOL_BYTES;
  let toolBytes = 0;
  const startedAt = Date.now();
  const deadline = startedAt + input.spec.timeoutMs;
  const redirects: NetworkRedirectSummary[] = [];
  const attempts: NetworkAttemptSummary[] = [];
  const hosts = new Set<string>();
  const routes = new Set<"system" | "direct">();
  let currentUrl = parseSafeHttpUrl(input.spec.url);
  applyQuery(currentUrl, input.spec.query);
  let currentHeaders = validateRequestHeaders(input.spec.headers);
  const body = requestBody(input.spec, currentHeaders);
  const redactionSecrets = new Set(requestRedactionSecrets(currentUrl, currentHeaders, input.spec.body));
  const transportBody: ArrayBuffer | undefined = body ? Uint8Array.from(body).buffer : undefined;
  const resolver = input.resolveHostname ?? (input.network.resolveDns
    ? (hostname: string, signal?: AbortSignal) => input.network.resolveDns!(hostname, { signal })
    : defaultDnsResolver);
  const allowPrivate = privateNetworkTestOverride(input.environment ?? process.env);
  const lease = budgetManager.acquire(input.budgetKey, input.maxTurnBytes ?? DEFAULT_MAX_TURN_BYTES);
  const accountBytes = (received: number) => {
    toolBytes += received;
    lease.consume(received);
    if (toolBytes > maxToolBytes) {
      throw new SafeNetworkError("Network byte budget for this tool was exceeded.", "response_too_large", false);
    }
  };
  try {
    for (;;) {
      throwIfAborted(input.signal);
      const remainingMs = deadline - Date.now();
      if (remainingMs <= 0) throw new SafeNetworkError("Network tool time budget was exhausted.", "timeout", false);
      const hostname = currentUrl.hostname.replace(/^\[|\]$/gu, "").toLocaleLowerCase();
      hosts.add(hostname);
      try {
        await input.authorizeHost?.(hostname);
      } catch (error) {
        throw new SafeNetworkError("Network host was denied by the permission policy.", "policy_denied", false, {
          cause: error,
        });
      }
      const pinnedAddress = await resolvePinnedAddress({
        url: currentUrl,
        signal: input.signal,
        timeoutMs: remainingMs,
        allowPrivateNetworkForTests: allowPrivate,
        resolver,
      });
      const isReadOnly = READ_ONLY_METHODS.has(input.spec.method);
      const plan = await planWithFallback(input.network, currentUrl, input.signal, remainingMs, isReadOnly);
      const eligibleRoutes = READ_ONLY_METHODS.has(input.spec.method) ? plan.routes : plan.routes.slice(0, 1);
      let response: ToolNetworkResponse | undefined;
      let lastFailure: SafeNetworkError | undefined;
      for (let index = 0; index < eligibleRoutes.length; index += 1) {
        const entry = eligibleRoutes[index]!;
        routes.add(entry.route);
        const remainingToolBytes = maxToolBytes - toolBytes;
        const remainingBytes = Math.min(input.spec.maxResponseBytes, remainingToolBytes, lease.remainingBytes());
        if (remainingBytes <= 0) {
          throw new SafeNetworkError("Network byte budget was exhausted.", "response_too_large", false);
        }
        let attemptBytes = 0;
        const streaming = safeFinalBodyConsumer({
          consumer: input.finalBodyConsumer,
          expectedContentTypes: input.spec.expectedContentTypes,
          accountBytes: (received) => {
            attemptBytes += received;
            accountBytes(received);
          },
        });
        try {
          const routeRemainingMs = deadline - Date.now();
          if (routeRemainingMs <= 0) {
            throw new SafeNetworkError("Network tool time budget was exhausted.", "timeout", false);
          }
          lease.consumeRequest();
          response = await input.network.request(currentUrl, {
            method: input.spec.method,
            headers: currentHeaders,
            body: transportBody,
            redirect: "manual",
            signal: input.signal,
          }, {
            route: entry.route,
            timeoutMs: Math.max(1, Math.min(routeRemainingMs, input.spec.timeoutMs)),
            maxResponseBytes: remainingBytes,
            pinnedAddress,
            bodyConsumer: streaming.consumer,
            collectBody: streaming.collectBody,
          });
          const reportedBytes = response.sizeBytes ?? response.body.byteLength;
          if (reportedBytes > attemptBytes) accountBytes(reportedBytes - attemptBytes);
          attempts.push({ route: entry.route, source: entry.source, outcome: "success" });
          break;
        } catch (error) {
          const failure = classifySafeNetworkFailure(error);
          lastFailure = failure;
          attempts.push({ route: entry.route, source: entry.source, outcome: "error", errorType: failure.networkErrorType });
          const hasNext = index + 1 < eligibleRoutes.length;
          if (!READ_ONLY_METHODS.has(input.spec.method) || !failure.retryable || !hasNext) throw failure;
        }
      }
      if (!response) throw lastFailure ?? new SafeNetworkError("No network route was available.", "connection", false);
      if (REDIRECT_STATUSES.has(response.status)) {
        const location = responseHeader(response, "location");
        const readOnly = READ_ONLY_METHODS.has(input.spec.method);
        if (readOnly && input.spec.maxRedirects > 0 && redirects.length >= input.spec.maxRedirects) {
          throw new SafeNetworkError("Network redirect limit was exceeded.", "policy_denied", false);
        }
        // State-changing methods and explicit maxRedirects=0 treat 3xx as a
        // terminal, inspectable HTTP response. They never replay the request.
        if (readOnly && input.spec.maxRedirects > 0 && location) {
          let nextUrl: URL;
          try {
            nextUrl = parseSafeHttpUrl(/^[a-z][a-z\d+.-]*:/iu.test(location)
              ? location
              : new URL(location, currentUrl).toString());
          } catch (error) {
            if (error instanceof SafeNetworkError) throw error;
            throw new SafeNetworkError("Redirect target URL is invalid.", "policy_denied", false, { cause: error });
          }
          if (currentUrl.protocol === "https:" && nextUrl.protocol !== "https:") {
            throw new SafeNetworkError("HTTPS redirects must not downgrade to plain HTTP.", "policy_denied", false);
          }
          currentHeaders = redirectHeaders(currentHeaders, currentUrl, nextUrl);
          mergeBoundedRedactionSecrets(
            redactionSecrets,
            requestRedactionSecrets(nextUrl, currentHeaders, undefined),
          );
          redirects.push({
            status: response.status,
            fromUrl: redactUrl(currentUrl.toString(), [...redactionSecrets]),
            toUrl: redactUrl(nextUrl.toString(), [...redactionSecrets]),
          });
          currentUrl = nextUrl;
          continue;
        }
      }
      validateExpectedContentType(response, input.spec.expectedContentTypes);
      const contentType = contentTypeEssence(response.headers);
      const terminalLocation = responseHeader(response, "location");
      let terminalLocationUrl: URL | undefined;
      if (terminalLocation) {
        try {
          terminalLocationUrl = new URL(terminalLocation, currentUrl);
        } catch {
          // Invalid or non-URL Location values are omitted from persisted output.
        }
        if (terminalLocationUrl) {
          mergeBoundedRedactionSecrets(
            redactionSecrets,
            requestRedactionSecrets(terminalLocationUrl, currentHeaders, undefined),
          );
        }
      }
      const finalUrl = redactUrl(currentUrl.toString(), [...redactionSecrets]);
      const safeHeaders = filterHighSignalHeaders(response.headers, [...redactionSecrets]);
      if (terminalLocationUrl) {
        safeHeaders.location = redactUrl(terminalLocationUrl.toString(), [...redactionSecrets]);
      }
      const safeRedirects = redirects.map((redirect) => ({
        ...redirect,
        fromUrl: redactUrl(redirect.fromUrl, [...redactionSecrets]),
        toUrl: redactUrl(redirect.toUrl, [...redactionSecrets]),
      }));
      const summary: NetworkResponseSummary = {
        status: response.status,
        ok: response.ok,
        finalUrl,
        contentType,
        sizeBytes: response.sizeBytes ?? response.body.byteLength,
        sha256: response.sha256 ?? createHash("sha256").update(response.body).digest("hex"),
        truncated: false,
        fetchedAt: new Date().toISOString(),
        redirects: safeRedirects,
        attempts,
        headers: safeHeaders,
      };
      return {
        response,
        summary,
        redactionSecrets: [...redactionSecrets],
        audit: {
          requestCount: attempts.length,
          methods: [input.spec.method],
          hosts: [...hosts],
          routes: [...routes],
          redirectCount: redirects.length,
          bytesReceived: toolBytes,
          status: response.status,
        },
      };
    }
  } catch (error) {
    const failure = classifySafeNetworkFailure(error);
    failure.message = redactSensitiveText(failure.message, [...redactionSecrets]);
    failure.audit ??= {
      requestCount: attempts.length,
      methods: [input.spec.method],
      hosts: [...hosts],
      routes: [...routes],
      redirectCount: redirects.length,
      bytesReceived: toolBytes,
      errorType: failure.networkErrorType,
    };
    throw failure;
  } finally {
    lease.release();
  }
}
