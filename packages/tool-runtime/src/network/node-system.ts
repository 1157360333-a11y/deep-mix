import { execFile } from "node:child_process";
import { promisify } from "node:util";

import { ProxyAgent } from "proxy-agent";

import {
  PinnedHttpProxyAgent,
  isNetworkResponseHandlingError,
  requestWithNodeTransport,
  runBoundedNetworkOperation,
  type ToolNetworkResponse,
  type ToolNetworkRouteSource,
  type ToolNetworkService,
} from "./index.js";

const execFileAsync = promisify(execFile);

export interface ResolvedSystemProxy {
  proxyUrl?: string;
  noProxy: string[];
  source: Exclude<ToolNetworkRouteSource, "electron_system" | "direct">;
}

function firstEnvironmentValue(environment: NodeJS.ProcessEnv, names: string[]): string | undefined {
  for (const name of names) {
    const value = environment[name]?.trim();
    if (value) return value;
  }
  return undefined;
}

function environmentProxy(url: URL, environment: NodeJS.ProcessEnv): ResolvedSystemProxy | undefined {
  const proxyUrl = url.protocol === "https:"
    ? firstEnvironmentValue(environment, ["https_proxy", "HTTPS_PROXY", "http_proxy", "HTTP_PROXY", "all_proxy", "ALL_PROXY"])
    : firstEnvironmentValue(environment, ["http_proxy", "HTTP_PROXY", "all_proxy", "ALL_PROXY"]);
  if (!proxyUrl) return undefined;
  return {
    proxyUrl,
    noProxy: (firstEnvironmentValue(environment, ["no_proxy", "NO_PROXY"]) ?? "")
      .split(/[;,]/u)
      .map((entry) => entry.trim())
      .filter(Boolean),
    source: "environment",
  };
}

function registryValueData(values: ReadonlyArray<{ name?: string; data?: unknown }>, name: string): unknown {
  return values.find((entry) => entry.name?.toLocaleLowerCase() === name.toLocaleLowerCase())?.data;
}

export function normalizePacUrl(value: string): string {
  return value.startsWith("pac+") ? value : `pac+${value}`;
}

export function parseWindowsProxyServer(value: string): string | undefined {
  const normalized = value.trim();
  if (!normalized) return undefined;
  if (/^(?:https?|socks(?:4|5)?):\/\//iu.test(normalized)) return normalized;
  if (!normalized.includes("=")) return `http://${normalized}`;
  const entries = Object.fromEntries(normalized.split(";").map((entry) => {
    const [protocol, address] = entry.split("=", 2);
    return [protocol?.trim().toLocaleLowerCase(), address?.trim()];
  }));
  if (entries.https) return `http://${entries.https}`;
  if (entries.http) return `http://${entries.http}`;
  if (entries.socks) return `socks://${entries.socks}`;
  return undefined;
}

export function resolveWindowsProxyValues(
  values: ReadonlyArray<{ name?: string; data?: unknown }>,
): ResolvedSystemProxy | undefined {
  const noProxy = String(registryValueData(values, "ProxyOverride") ?? "")
    .split(";")
    .map((entry) => entry.trim())
    .filter(Boolean);
  const autoConfigUrl = String(registryValueData(values, "AutoConfigURL") ?? "").trim();
  if (autoConfigUrl) {
    return { proxyUrl: normalizePacUrl(autoConfigUrl), noProxy, source: "windows_system" };
  }
  const proxyEnabled = Number(registryValueData(values, "ProxyEnable") ?? 0) !== 0;
  const proxyServer = parseWindowsProxyServer(String(registryValueData(values, "ProxyServer") ?? ""));
  if (proxyEnabled && proxyServer) return { proxyUrl: proxyServer, noProxy, source: "windows_system" };
  const autoDetect = Number(registryValueData(values, "AutoDetect") ?? 0) !== 0;
  return autoDetect
    ? { proxyUrl: "pac+http://wpad/wpad.dat", noProxy, source: "windows_system" }
    : undefined;
}

async function windowsSystemProxy(): Promise<ResolvedSystemProxy | undefined> {
  const { stdout } = await execFileAsync("reg.exe", [
    "query",
    "HKCU\\Software\\Microsoft\\Windows\\CurrentVersion\\Internet Settings",
  ], {
    encoding: "utf8",
    timeout: 3_000,
    windowsHide: true,
  });
  return resolveWindowsProxyValues(parseWindowsRegistryQueryOutput(stdout));
}

export function parseWindowsRegistryQueryOutput(
  output: string,
): Array<{ name: string; data: string | number }> {
  const values: Array<{ name: string; data: string | number }> = [];
  for (const line of output.split(/\r?\n/u)) {
    const match = /^\s+(\S+)\s+REG_(?:SZ|EXPAND_SZ|DWORD)\s+(.+?)\s*$/iu.exec(line);
    if (!match) continue;
    const [, name, rawValue] = match;
    const data = /^0x[\da-f]+$/iu.test(rawValue!) ? Number.parseInt(rawValue!.slice(2), 16) : rawValue!;
    values.push({ name: name!, data });
  }
  return values;
}

function parseScutilValue(output: string, key: string): string | undefined {
  const match = new RegExp(`^\\s*${key}\\s*:\\s*(.+?)\\s*$`, "imu").exec(output);
  return match?.[1]?.trim();
}

function parseScutilExceptions(output: string): string[] {
  const block = /ExceptionsList\s*:\s*<array>\s*\{([\s\S]*?)\n\s*\}/iu.exec(output)?.[1] ?? "";
  return [...block.matchAll(/^\s*\d+\s*:\s*(.+?)\s*$/gmu)].map((match) => match[1]!.trim());
}

export function parseMacosSystemProxyOutput(output: string): ResolvedSystemProxy | undefined {
  const noProxy = parseScutilExceptions(output);
  if (parseScutilValue(output, "ProxyAutoConfigEnable") === "1") {
    const pacUrl = parseScutilValue(output, "ProxyAutoConfigURLString");
    if (pacUrl) return { proxyUrl: normalizePacUrl(pacUrl), noProxy, source: "macos_system" };
  }
  if (parseScutilValue(output, "ProxyAutoDiscoveryEnable") === "1") {
    return { proxyUrl: "pac+http://wpad/wpad.dat", noProxy, source: "macos_system" };
  }
  const candidates: Array<[string, string, string, string]> = [
    ["HTTPSEnable", "HTTPSProxy", "HTTPSPort", "http"],
    ["HTTPEnable", "HTTPProxy", "HTTPPort", "http"],
    ["SOCKSEnable", "SOCKSProxy", "SOCKSPort", "socks"],
  ];
  for (const [enabledKey, hostKey, portKey, protocol] of candidates) {
    if (parseScutilValue(output, enabledKey) !== "1") continue;
    const host = parseScutilValue(output, hostKey);
    const port = parseScutilValue(output, portKey);
    if (host && port) return { proxyUrl: `${protocol}://${host}:${port}`, noProxy, source: "macos_system" };
  }
  return undefined;
}

async function macosSystemProxy(): Promise<ResolvedSystemProxy | undefined> {
  const { stdout } = await execFileAsync("scutil", ["--proxy"], {
    encoding: "utf8",
    timeout: 3_000,
    windowsHide: true,
  });
  return parseMacosSystemProxyOutput(stdout);
}

function isLocalHostname(hostname: string): boolean {
  return hostname === "localhost" || hostname === "127.0.0.1" || hostname === "::1" || !hostname.includes(".");
}

export function matchesNoProxy(url: URL, entries: string[]): boolean {
  const hostname = url.hostname.toLocaleLowerCase();
  const port = url.port || (url.protocol === "https:" ? "443" : "80");
  return entries.some((rawEntry) => {
    const entry = rawEntry.trim().toLocaleLowerCase();
    if (!entry) return false;
    if (entry === "*") return true;
    if (entry === "<local>") return isLocalHostname(hostname);
    const separator = entry.lastIndexOf(":");
    const hasPort = separator > 0 && /^\d+$/u.test(entry.slice(separator + 1));
    const pattern = hasPort ? entry.slice(0, separator) : entry;
    if (hasPort && entry.slice(separator + 1) !== port) return false;
    const suffix = pattern.replace(/^\*\./u, ".");
    if (suffix.startsWith(".")) return hostname === suffix.slice(1) || hostname.endsWith(suffix);
    return hostname === suffix;
  });
}

async function resolveSystemProxy(url: URL, environment: NodeJS.ProcessEnv): Promise<ResolvedSystemProxy | undefined> {
  const fromEnvironment = environmentProxy(url, environment);
  if (fromEnvironment) return fromEnvironment;
  if (process.platform === "win32") return windowsSystemProxy();
  if (process.platform === "darwin") return macosSystemProxy();
  return undefined;
}

export function createNodeSystemToolNetworkService(
  environment: NodeJS.ProcessEnv = process.env,
): ToolNetworkService {
  const activeAgents = new Set<ProxyAgent | PinnedHttpProxyAgent>();
  return {
    plan: async (url) => {
      const proxy = await resolveSystemProxy(url, environment);
      const distinct = Boolean(proxy?.proxyUrl) && !matchesNoProxy(url, proxy?.noProxy ?? []);
      return distinct
        ? {
            routes: [
              { route: "system", source: proxy!.source },
              { route: "direct", source: "direct" },
            ],
            systemRouteDistinct: true,
          }
        : {
            routes: [{ route: "direct", source: "direct" }],
            systemRouteDistinct: false,
          };
    },
    request: async (url, init, options): Promise<ToolNetworkResponse> => {
      let agent: ProxyAgent | PinnedHttpProxyAgent | undefined;
      try {
        if (options.route === "system") {
          const proxy = await runBoundedNetworkOperation(
            resolveSystemProxy(url, environment),
            { signal: init.signal, timeoutMs: options.timeoutMs },
          );
          if (!proxy?.proxyUrl || matchesNoProxy(url, proxy.noProxy)) {
            throw Object.assign(new Error("The planned system proxy route is no longer available."), {
              code: "ERR_PROXY_ROUTE_CHANGED",
            });
          }
          if (proxy.proxyUrl) {
            if (url.protocol === "http:" && options.pinnedAddress && /^https?:/iu.test(proxy.proxyUrl)) {
              agent = new PinnedHttpProxyAgent(proxy.proxyUrl);
            } else {
              if (options.pinnedAddress && /^pac\+/iu.test(proxy.proxyUrl)) {
                throw Object.assign(new Error("PAC proxies are unsupported for pinned requests."), {
                  code: "ERR_PROXY_UNSUPPORTED_PINNED_HTTP",
                });
              }
              agent = new ProxyAgent({ getProxyForUrl: () => proxy.proxyUrl! });
            }
            activeAgents.add(agent);
          }
        }
        return await requestWithNodeTransport(url, init, options, agent);
      } catch (error) {
        if (options.route !== "system" || isNetworkResponseHandlingError(error)) throw error;
        if ((error as NodeJS.ErrnoException).code === "ERR_PROXY_UNSUPPORTED_PINNED_HTTP") throw error;
        throw Object.assign(new Error("System proxy request failed.", { cause: error }), {
          code: "ERR_PROXY_REQUEST_FAILED",
        });
      } finally {
        if (agent) {
          activeAgents.delete(agent);
          agent.destroy();
        }
      }
    },
    dispose: async () => {
      for (const agent of activeAgents) agent.destroy();
      activeAgents.clear();
    },
  };
}
