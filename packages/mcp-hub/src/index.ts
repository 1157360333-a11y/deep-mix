import { existsSync, promises as fs } from "node:fs";
import path from "node:path";
import { spawn } from "node:child_process";
import sharp from "sharp";
import type {
  LifecycleWarning,
  McpResourceDiscoveryResult,
  McpResourceProtocolDescriptor,
  McpResourceProtocolPage,
  McpResourceProtocolReadResult,
  McpServerConfigEntry,
  McpServerConfigFile,
  McpServerStatus,
  McpToolDescriptor,
} from "../../shared-schema/src/index.js";
import {
  resolveProjectMcpConfigPath,
  resolveUserMcpConfigPath,
  resolveWorkspaceStateDirectory,
} from "../../state-location/src/index.js";

export interface McpInvocationResult {
  output: string;
  structuredContent?: unknown;
}

export interface McpResourceProtocolListRequest {
  cursor?: string;
  limit: number;
}

export interface McpAdapter {
  start(): Promise<McpServerStatus>;
  listTools(): McpToolDescriptor[];
  invokeTool(toolName: string, input: unknown): Promise<McpInvocationResult>;
  /** MCP Resource protocol. It is intentionally separate from invokeTool(). */
  listResources?(request: McpResourceProtocolListRequest): Promise<McpResourceProtocolPage>;
  /** MCP Resource protocol. It is intentionally separate from invokeTool(). */
  readResource?(uri: string): Promise<McpResourceProtocolReadResult>;
}

export interface McpRegistryOptions {
  /** Test/embedding seam for a configured server adapter; returning undefined uses the built-in adapter. */
  createAdapter?: (entry: McpServerConfigEntry, workspaceRoot: string) => McpAdapter | undefined;
}

const MCP_RESOURCE_PROTOCOL_PAGE_LIMIT = 200;
const MCP_RESOURCE_DISCOVERY_MAX = 10_000;
const MCP_RESOURCE_DISCOVERY_MAX_PAGES_PER_SERVER = 100;
const MCP_RESOURCE_URI_MAX_CHARS = 4_096;
const MCP_RESOURCE_NAME_MAX_CHARS = 255;
const MCP_RESOURCE_DESCRIPTION_MAX_CHARS = 4_000;
const MCP_RESOURCE_TEXT_MAX_BYTES = 64 * 1024 * 1024;
const MCP_RESOURCE_BINARY_MAX_BYTES = 256 * 1024 * 1024;
const SENSITIVE_URI_PARAMETER = /(?:api[-_]?key|authorization|cookie|credential|password|secret|session[-_]?token|token)/iu;
const MCP_DYNAMIC_SELECTION_STOP_WORDS = new Set(["list", "mcp", "read", "resource", "resources", "tool", "tools"]);

function mcpResourceError(code: string, message: string): Error {
  return Object.assign(new Error(message), { code });
}

function now(): string {
  return new Date().toISOString();
}

async function exists(targetPath: string): Promise<boolean> {
  try {
    await fs.access(targetPath);
    return true;
  } catch {
    return false;
  }
}

function tokenize(text: string): string[] {
  return text
    .toLowerCase()
    .split(/[^a-z0-9\u4e00-\u9fff]+/i)
    .map((entry) => entry.trim())
    .filter((entry) => entry.length >= 2);
}

function redactWorkspacePaths(value: string, workspaceRoot?: string): string {
  if (!workspaceRoot) return value;
  const normalizedRoot = workspaceRoot
    .replace(/^\\\\\?\\/u, "")
    .replaceAll("\\", "/");
  const segments = normalizedRoot.split("/").filter(Boolean);
  if (segments.length === 0) return value;
  const pattern = new RegExp(
    `${normalizedRoot.startsWith("/") ? "[\\\\/]+" : ""}${segments
      .map((segment) => segment.replace(/[.*+?^${}()|[\]\\]/gu, "\\$&"))
      .join("[\\\\/]+")}`,
    "giu",
  );
  return value.replace(/\\\\\?\\/gu, "").replace(pattern, "<workspace>");
}

function redactEmbeddedUris(value: string): string {
  return value.replace(
    /\b[a-z][a-z0-9+.-]*:(?:\/\/)?[^\s"'<>]+/giu,
    (match) => {
      let core = match;
      let trailing = "";
      while (/[),.;!?]$/u.test(core)) {
        trailing = `${core.at(-1)!}${trailing}`;
        core = core.slice(0, -1);
      }
      try {
        const parsed = new URL(core);
        const hierarchical = core.slice(parsed.protocol.length).startsWith("//");
        if (!hierarchical) return `${parsed.protocol}[REDACTED]${trailing}`;
        const pathSummary = parsed.pathname && parsed.pathname !== "/" ? "/[REDACTED]" : parsed.pathname;
        const querySummary = parsed.search ? "?parameters=[REDACTED]" : "";
        const fragmentSummary = parsed.hash ? "#[REDACTED]" : "";
        return `${parsed.protocol}//${parsed.host}${pathSummary}${querySummary}${fragmentSummary}${trailing}`;
      } catch {
        return `[REDACTED_URI]${trailing}`;
      }
    },
  );
}

function safeRemoteErrorMessage(error: unknown, workspaceRoot?: string): string {
  const raw = error instanceof Error ? error.message : String(error);
  return redactWorkspacePaths(redactEmbeddedUris(raw), workspaceRoot)
    .replace(/\bBearer\s+[^\s,;]+/giu, "Bearer [REDACTED]")
    .replace(/\b(?:ghp|github_pat|sk|xox[baprs])[-_A-Za-z0-9]{8,}\b/giu, "[REDACTED]")
    .replace(/((?:api[-_]?key|authorization|cookie|credential|password|secret|session[-_]?token|token)\s*[:=]\s*)[^\s,;]+/giu, "$1[REDACTED]")
    .replace(/\b(?=[A-Z0-9_-]{8,}\b)(?=[A-Z0-9_-]*[_-])[A-Z0-9_-]+\b/gu, "[REDACTED]")
    .slice(0, 4_000);
}

function validateResourceUri(uri: unknown): string {
  if (typeof uri !== "string" || uri.length < 1 || uri.length > MCP_RESOURCE_URI_MAX_CHARS) {
    throw mcpResourceError("ERR_TOOL_INVALID_ARGUMENTS", "MCP resource URI must contain 1 to 4,096 characters.");
  }
  let parsed: URL;
  try {
    parsed = new URL(uri);
  } catch {
    throw mcpResourceError("ERR_TOOL_INVALID_ARGUMENTS", "MCP resource URI is invalid.");
  }
  if (!parsed.protocol || parsed.username || parsed.password || parsed.hash) {
    throw mcpResourceError("ERR_TOOL_INVALID_ARGUMENTS", "MCP resource URI contains unsafe authority or fragment data.");
  }
  for (const key of parsed.searchParams.keys()) {
    if (SENSITIVE_URI_PARAMETER.test(key)) {
      throw mcpResourceError("ERR_TOOL_INVALID_ARGUMENTS", "MCP resource URI contains a sensitive query parameter.");
    }
  }
  return uri;
}

function normalizeResourceDescriptor(value: unknown): McpResourceProtocolDescriptor {
  if (!value || typeof value !== "object") {
    throw mcpResourceError("ERR_TOOL_CORRUPT_RECORD", "MCP resource descriptor is not an object.");
  }
  const candidate = value as Partial<McpResourceProtocolDescriptor>;
  const uri = validateResourceUri(candidate.uri);
  if (typeof candidate.name !== "string" || !candidate.name.trim()) {
    throw mcpResourceError("ERR_TOOL_CORRUPT_RECORD", "MCP resource descriptor has no name.");
  }
  if (candidate.name.length > MCP_RESOURCE_NAME_MAX_CHARS) {
    throw mcpResourceError("ERR_TOOL_CORRUPT_RECORD", "MCP resource descriptor name exceeds the protocol limit.");
  }
  if (candidate.description !== undefined && (
    typeof candidate.description !== "string" || candidate.description.length > MCP_RESOURCE_DESCRIPTION_MAX_CHARS
  )) {
    throw mcpResourceError("ERR_TOOL_CORRUPT_RECORD", "MCP resource descriptor description is invalid.");
  }
  if (candidate.mimeType !== undefined && (
    typeof candidate.mimeType !== "string" || candidate.mimeType.length > 255 || /[\r\n]/u.test(candidate.mimeType)
  )) {
    throw mcpResourceError("ERR_TOOL_CORRUPT_RECORD", "MCP resource descriptor MIME type is invalid.");
  }
  if (candidate.sizeBytes !== undefined && (
    !Number.isSafeInteger(candidate.sizeBytes) || candidate.sizeBytes < 0
  )) {
    throw mcpResourceError("ERR_TOOL_CORRUPT_RECORD", "MCP resource descriptor size is invalid.");
  }
  if (candidate.updatedAt !== undefined && (
    typeof candidate.updatedAt !== "string" || !Number.isFinite(Date.parse(candidate.updatedAt))
  )) {
    throw mcpResourceError("ERR_TOOL_CORRUPT_RECORD", "MCP resource descriptor timestamp is invalid.");
  }
  return {
    uri,
    name: candidate.name.trim(),
    ...(candidate.description === undefined ? {} : { description: candidate.description }),
    ...(candidate.mimeType === undefined ? {} : { mimeType: candidate.mimeType }),
    ...(candidate.sizeBytes === undefined ? {} : { sizeBytes: candidate.sizeBytes }),
    ...(candidate.updatedAt === undefined ? {} : { updatedAt: new Date(candidate.updatedAt).toISOString() }),
  };
}

function normalizeResourceReadResult(
  requestedUri: string,
  value: unknown,
): McpResourceProtocolReadResult {
  if (!value || typeof value !== "object") {
    throw mcpResourceError("ERR_TOOL_CORRUPT_RECORD", "MCP resource read result is not an object.");
  }
  const candidate = value as Partial<McpResourceProtocolReadResult>;
  const descriptor = normalizeResourceDescriptor(candidate.descriptor);
  if (descriptor.uri !== requestedUri) {
    throw mcpResourceError("ERR_TOOL_CORRUPT_RECORD", "MCP resource read result URI does not match the requested URI.");
  }
  if (candidate.representation === "text") {
    if (typeof candidate.text !== "string") {
      throw mcpResourceError("ERR_TOOL_CORRUPT_RECORD", "MCP text resource has no text payload.");
    }
    const sizeBytes = Buffer.byteLength(candidate.text, "utf8");
    if (sizeBytes > MCP_RESOURCE_TEXT_MAX_BYTES) {
      throw mcpResourceError("ERR_TOOL_UNAVAILABLE", "MCP text resource exceeds the 64 MiB trusted-read limit.");
    }
    if ((candidate.sizeBytes !== undefined && candidate.sizeBytes !== sizeBytes) ||
      (descriptor.sizeBytes !== undefined && descriptor.sizeBytes !== sizeBytes)) {
      throw mcpResourceError("ERR_TOOL_CORRUPT_RECORD", "MCP text resource size metadata does not match its payload.");
    }
    return { descriptor, representation: "text", text: candidate.text, sizeBytes };
  }
  if (candidate.representation === "structured") {
    if (!("structuredData" in candidate)) {
      throw mcpResourceError("ERR_TOOL_CORRUPT_RECORD", "MCP structured resource has no structured payload.");
    }
    let serialized: string;
    try {
      serialized = JSON.stringify(candidate.structuredData);
    } catch {
      throw mcpResourceError("ERR_TOOL_CORRUPT_RECORD", "MCP structured resource is not JSON-serializable.");
    }
    if (serialized === undefined) {
      throw mcpResourceError("ERR_TOOL_CORRUPT_RECORD", "MCP structured resource is not JSON-serializable.");
    }
    const sizeBytes = Buffer.byteLength(serialized, "utf8");
    if (sizeBytes > MCP_RESOURCE_TEXT_MAX_BYTES) {
      throw mcpResourceError("ERR_TOOL_UNAVAILABLE", "MCP structured resource exceeds the 64 MiB trusted-read limit.");
    }
    if ((candidate.sizeBytes !== undefined && candidate.sizeBytes !== sizeBytes) ||
      (descriptor.sizeBytes !== undefined && descriptor.sizeBytes !== sizeBytes)) {
      throw mcpResourceError("ERR_TOOL_CORRUPT_RECORD", "MCP structured resource size metadata does not match its payload.");
    }
    return { descriptor, representation: "structured", structuredData: candidate.structuredData, sizeBytes };
  }
  if (candidate.representation === "binary") {
    if (!(candidate.binaryData instanceof Uint8Array)) {
      throw mcpResourceError("ERR_TOOL_CORRUPT_RECORD", "MCP binary resource has no byte payload.");
    }
    if (candidate.binaryData.byteLength > MCP_RESOURCE_BINARY_MAX_BYTES) {
      throw mcpResourceError("ERR_TOOL_UNAVAILABLE", "MCP binary resource exceeds the 256 MiB trusted-read limit.");
    }
    if ((candidate.sizeBytes !== undefined && candidate.sizeBytes !== candidate.binaryData.byteLength) ||
      (descriptor.sizeBytes !== undefined && descriptor.sizeBytes !== candidate.binaryData.byteLength)) {
      throw mcpResourceError("ERR_TOOL_CORRUPT_RECORD", "MCP binary resource size metadata does not match its payload.");
    }
    return {
      descriptor,
      representation: "binary",
      binaryData: candidate.binaryData,
      sizeBytes: candidate.binaryData.byteLength,
    };
  }
  throw mcpResourceError("ERR_TOOL_CORRUPT_RECORD", "MCP resource representation is invalid.");
}

function createDefaultConfig(): McpServerConfigFile {
  return {
    version: 1,
    servers: [
      {
        name: "github",
        type: "github",
        enabled: true,
        toolSelection: {
          keywords: ["github", "repo", "repository", "issue", "pr", "pull request"],
        },
        options: {
          apiBaseUrl: "https://api.github.com",
          userAgent: "Deep-Mix/0.1",
        },
      },
      {
        name: "playwright",
        type: "playwright",
        enabled: true,
        toolSelection: {
          keywords: ["browser", "page", "url", "website", "screenshot", "capture"],
        },
        options: {
          screenshotDir: ".deep-mix/mcp-artifacts/playwright",
        },
      },
    ],
  };
}

function escapeXml(value: string): string {
  return value
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&apos;");
}

function stripHtml(html: string): string {
  return html
    .replace(/<script[\s\S]*?<\/script>/gi, " ")
    .replace(/<style[\s\S]*?<\/style>/gi, " ")
    .replace(/<[^>]+>/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

function extractTitle(html: string): string {
  const match = html.match(/<title[^>]*>([\s\S]*?)<\/title>/i);
  return match?.[1]?.replace(/\s+/g, " ").trim() || "Untitled page";
}

async function readUrl(url: string): Promise<{ html: string; title: string }> {
  if (url.startsWith("file://")) {
    const filePath = url.slice("file://".length);
    const html = await fs.readFile(filePath, "utf8");
    return {
      html,
      title: extractTitle(html),
    };
  }

  const response = await fetch(url, {
    headers: {
      "User-Agent": "Deep-Mix/0.1",
    },
  });
  if (!response.ok) {
    throw new Error(`Request failed: ${response.status} ${response.statusText}`);
  }
  const html = await response.text();
  return {
    html,
    title: extractTitle(html),
  };
}

function resolveRelativePath(workspaceRoot: string, targetPath: string): string {
  return path.isAbsolute(targetPath) ? targetPath : path.join(workspaceRoot, targetPath);
}

async function runBrowserCommand(
  executable: string,
  args: string[],
): Promise<boolean> {
  return new Promise((resolve) => {
    const child = spawn(executable, args, {
      stdio: "ignore",
      windowsHide: true,
    });
    child.on("error", () => resolve(false));
    child.on("close", (code) => resolve(code === 0));
  });
}

class GitHubAdapter implements McpAdapter {
  private readonly apiBaseUrl: string;

  private readonly userAgent: string;

  public constructor(private readonly entry: McpServerConfigEntry) {
    this.apiBaseUrl = String(entry.options?.apiBaseUrl ?? "https://api.github.com").replace(/\/+$/, "");
    this.userAgent = String(entry.options?.userAgent ?? "Deep-Mix/0.1");
  }

  public async start(): Promise<McpServerStatus> {
    return {
      name: this.entry.name,
      type: "github",
      enabled: this.entry.enabled,
      state: this.entry.enabled ? "ready" : "disabled",
      toolCount: this.listTools().length,
      lastCheckedAt: now(),
    };
  }

  public listTools(): McpToolDescriptor[] {
    const selectionKeywords = [...(this.entry.toolSelection?.keywords ?? [])];
    return [
      {
        serverName: this.entry.name,
        serverType: "github",
        name: "mcp_github_search_repositories",
        description: "Search GitHub repositories via the configured GitHub MCP server.",
        inputSchema: {
          type: "object",
          additionalProperties: false,
          required: ["query"],
          properties: {
            query: { type: "string", minLength: 1 },
            perPage: { type: "number", minimum: 1, maximum: 100, default: 100 },
          },
        },
        readOnly: true,
        permissionCategory: "mcp_read_only",
        sideEffectLevel: "none",
        timeoutCategory: "default",
        selectionKeywords,
      },
      {
        serverName: this.entry.name,
        serverType: "github",
        name: "mcp_github_read_pull_request",
        description: "Read a GitHub pull request through the configured GitHub MCP server.",
        inputSchema: {
          type: "object",
          additionalProperties: false,
          required: ["owner", "repo", "number"],
          properties: {
            owner: { type: "string", minLength: 1 },
            repo: { type: "string", minLength: 1 },
            number: { type: "number", minimum: 1 },
          },
        },
        readOnly: true,
        permissionCategory: "mcp_read_only",
        sideEffectLevel: "none",
        timeoutCategory: "default",
        selectionKeywords,
      },
    ];
  }

  public async invokeTool(toolName: string, input: unknown): Promise<McpInvocationResult> {
    switch (toolName) {
      case "mcp_github_search_repositories":
        return this.searchRepositories(input);
      case "mcp_github_read_pull_request":
        return this.readPullRequest(input);
      default:
        throw new Error(`Unsupported GitHub MCP tool: ${toolName}`);
    }
  }

  private async searchRepositories(input: unknown): Promise<McpInvocationResult> {
    const args = (input ?? {}) as { query?: string; perPage?: number };
    if (!args.query?.trim()) {
      throw new Error("GitHub search requires a non-empty query.");
    }

    const url = new URL(`${this.apiBaseUrl}/search/repositories`);
    url.searchParams.set("q", args.query.trim());
    url.searchParams.set("per_page", String(args.perPage ?? 100));

    const response = await fetch(url, {
      headers: {
        Accept: "application/vnd.github+json",
        "User-Agent": this.userAgent,
      },
    });
    if (!response.ok) {
      throw new Error(`GitHub search failed: ${response.status} ${response.statusText}`);
    }

    const payload = (await response.json()) as {
      total_count?: number;
      items?: Array<{
        full_name?: string;
        html_url?: string;
        description?: string;
      }>;
    };
    return {
      output: JSON.stringify(payload),
      structuredContent: payload,
    };
  }

  private async readPullRequest(input: unknown): Promise<McpInvocationResult> {
    const args = (input ?? {}) as { owner?: string; repo?: string; number?: number };
    if (!args.owner?.trim() || !args.repo?.trim() || typeof args.number !== "number") {
      throw new Error("GitHub pull request read requires owner, repo, and number.");
    }

    const response = await fetch(`${this.apiBaseUrl}/repos/${args.owner}/${args.repo}/pulls/${args.number}`, {
      headers: {
        Accept: "application/vnd.github+json",
        "User-Agent": this.userAgent,
      },
    });
    if (!response.ok) {
      throw new Error(`GitHub PR read failed: ${response.status} ${response.statusText}`);
    }

    const payload = (await response.json()) as {
      title?: string;
      state?: string;
      html_url?: string;
      user?: { login?: string };
      body?: string;
    };
    return {
      output: JSON.stringify(payload),
      structuredContent: payload,
    };
  }
}

class PlaywrightAdapter implements McpAdapter {
  private readonly screenshotDir: string;

  private readonly browserCommand?: string;

  private readonly preferSyntheticCapture: boolean;

  public constructor(
    private readonly workspaceRoot: string,
    private readonly entry: McpServerConfigEntry,
  ) {
    const configuredScreenshotDir = typeof entry.options?.screenshotDir === "string"
      ? entry.options.screenshotDir.trim()
      : "";
    this.screenshotDir = !configuredScreenshotDir || configuredScreenshotDir === ".deep-mix/mcp-artifacts/playwright"
      ? path.join(resolveWorkspaceStateDirectory(workspaceRoot), "mcp-artifacts", "playwright")
      : resolveRelativePath(workspaceRoot, configuredScreenshotDir);
    this.browserCommand =
      typeof entry.options?.browserCommand === "string" && entry.options.browserCommand.trim()
        ? entry.options.browserCommand.trim()
        : undefined;
    this.preferSyntheticCapture = entry.options?.preferSyntheticCapture === true;
  }

  public async start(): Promise<McpServerStatus> {
    return {
      name: this.entry.name,
      type: "playwright",
      enabled: this.entry.enabled,
      state: this.entry.enabled ? "ready" : "disabled",
      toolCount: this.listTools().length,
      lastCheckedAt: now(),
    };
  }

  public listTools(): McpToolDescriptor[] {
    const selectionKeywords = [...(this.entry.toolSelection?.keywords ?? [])];
    return [
      {
        serverName: this.entry.name,
        serverType: "playwright",
        name: "mcp_playwright_get_page_title",
        description: "Load a page and return its document title through the Playwright MCP server.",
        inputSchema: {
          type: "object",
          additionalProperties: false,
          required: ["url"],
          properties: {
            url: { type: "string", minLength: 1 },
          },
        },
        readOnly: true,
        permissionCategory: "mcp_read_only",
        sideEffectLevel: "none",
        timeoutCategory: "default",
        selectionKeywords,
      },
      {
        serverName: this.entry.name,
        serverType: "playwright",
        name: "mcp_playwright_capture_screenshot",
        description: "Capture a page screenshot through the Playwright MCP server and store it in the user-level workspace state directory.",
        inputSchema: {
          type: "object",
          additionalProperties: false,
          required: ["url"],
          properties: {
            url: { type: "string", minLength: 1 },
            outputName: { type: "string", minLength: 1 },
            width: { type: "number", minimum: 320, maximum: 2400 },
            height: { type: "number", minimum: 240, maximum: 2400 },
          },
        },
        readOnly: false,
        permissionCategory: "mcp_side_effectful",
        sideEffectLevel: "medium",
        timeoutCategory: "slow",
        selectionKeywords,
      },
    ];
  }

  public async invokeTool(toolName: string, input: unknown): Promise<McpInvocationResult> {
    switch (toolName) {
      case "mcp_playwright_get_page_title":
        return this.getPageTitle(input);
      case "mcp_playwright_capture_screenshot":
        return this.captureScreenshot(input);
      default:
        throw new Error(`Unsupported Playwright MCP tool: ${toolName}`);
    }
  }

  private async getPageTitle(input: unknown): Promise<McpInvocationResult> {
    const args = (input ?? {}) as { url?: string };
    if (!args.url?.trim()) {
      throw new Error("Playwright title lookup requires a URL.");
    }

    const document = await readUrl(args.url.trim());
    const payload = {
      title: document.title,
      url: args.url.trim(),
    };
    return {
      output: JSON.stringify(payload),
      structuredContent: payload,
    };
  }

  private async captureScreenshot(input: unknown): Promise<McpInvocationResult> {
    const args = (input ?? {}) as {
      url?: string;
      outputName?: string;
      width?: number;
      height?: number;
    };
    if (!args.url?.trim()) {
      throw new Error("Playwright screenshot requires a URL.");
    }

    const width = Math.round(args.width ?? 1280);
    const height = Math.round(args.height ?? 720);
    const outputName = (args.outputName?.trim() || `capture-${Date.now()}`).replace(/[^a-z0-9-_]+/gi, "-");
    const outputDir = this.screenshotDir;
    const outputPath = path.join(outputDir, `${outputName}.png`);
    await fs.mkdir(outputDir, { recursive: true });

    const document = await readUrl(args.url.trim());
    const browserCapture = await this.tryBrowserCapture(args.url.trim(), outputPath, width, height);
    if (!browserCapture) {
      await this.renderSyntheticScreenshot(outputPath, document.title, stripHtml(document.html), width, height, args.url.trim());
    }
    const payload = {
      filePath: outputPath,
      url: args.url.trim(),
      title: document.title,
      captureMode: browserCapture ? "browser" : "synthetic",
      width,
      height,
    };

    return {
      output: JSON.stringify(payload),
      structuredContent: payload,
    };
  }

  private async tryBrowserCapture(url: string, outputPath: string, width: number, height: number): Promise<boolean> {
    if (this.preferSyntheticCapture) {
      return false;
    }

    const command = await this.resolveBrowserCommand();
    if (!command) {
      return false;
    }

    return runBrowserCommand(command, [
      "--headless=new",
      "--disable-gpu",
      "--hide-scrollbars",
      `--window-size=${width},${height}`,
      `--screenshot=${outputPath}`,
      url,
    ]);
  }

  private async resolveBrowserCommand(): Promise<string | undefined> {
    const candidates = [
      this.browserCommand,
      "C:\\Program Files\\Microsoft\\Edge\\Application\\msedge.exe",
      "C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe",
      "C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe",
      "C:\\Program Files (x86)\\Google\\Chrome\\Application\\chrome.exe",
    ].filter((entry): entry is string => Boolean(entry));

    for (const candidate of candidates) {
      if (await exists(candidate)) {
        return candidate;
      }
    }
    return undefined;
  }

  private async renderSyntheticScreenshot(
    outputPath: string,
    title: string,
    bodyText: string,
    width: number,
    height: number,
    url: string,
  ): Promise<void> {
    const excerpt = bodyText.slice(0, 640) || "No page text was available.";
    const svg = `
      <svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${height}">
        <rect width="${width}" height="${height}" fill="#0f172a" />
        <rect x="32" y="32" width="${width - 64}" height="${height - 64}" rx="24" fill="#111827" stroke="#38bdf8" stroke-width="3" />
        <text x="56" y="88" fill="#e2e8f0" font-size="28" font-family="Segoe UI, Arial">Synthetic Playwright Capture</text>
        <text x="56" y="126" fill="#94a3b8" font-size="18" font-family="Segoe UI, Arial">${escapeXml(url)}</text>
        <text x="56" y="176" fill="#f8fafc" font-size="24" font-family="Segoe UI, Arial">${escapeXml(title)}</text>
        <foreignObject x="56" y="212" width="${width - 112}" height="${height - 268}">
          <div xmlns="http://www.w3.org/1999/xhtml" style="color:#cbd5e1;font:18px 'Segoe UI', Arial; line-height:1.45; white-space:pre-wrap;">
            ${escapeXml(excerpt)}
          </div>
        </foreignObject>
      </svg>
    `;
    await sharp(Buffer.from(svg)).png().toFile(outputPath);
  }
}

export class McpRegistry {
  private initialized = false;

  private readonly adapters = new Map<string, McpAdapter>();

  private readonly tools = new Map<string, McpToolDescriptor>();

  private statuses: McpServerStatus[] = [];

  private errors: string[] = [];

  public constructor(
    private readonly workspaceRoot: string,
    private readonly options: McpRegistryOptions = {},
  ) {}

  public async initialize(): Promise<void> {
    if (this.initialized) {
      return;
    }

    const configPath = [
      resolveProjectMcpConfigPath(this.workspaceRoot),
      resolveUserMcpConfigPath(),
    ].find((candidate) => existsSync(candidate));
    const configSource = configPath ?? "<built-in-default>";

    try {
      const config = configPath
        ? JSON.parse(await fs.readFile(configPath, "utf8")) as McpServerConfigFile
        : createDefaultConfig();
      if (!Array.isArray(config.servers)) {
        throw new Error("MCP config requires a servers array.");
      }

      for (const entry of config.servers) {
        try {
          if (typeof entry.name !== "string" || !/^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/u.test(entry.name)) {
            throw new Error("MCP server name is invalid.");
          }
          if (typeof entry.enabled !== "boolean") {
            throw new Error(`MCP server ${entry.name} has an invalid enabled flag.`);
          }
          if (this.adapters.has(entry.name) || this.statuses.some((status) => status.name === entry.name)) {
            throw new Error(`Duplicate MCP server name: ${entry.name}`);
          }
          const adapter = this.createAdapter(entry);
          const status = await adapter.start();
          if (
            status.name !== entry.name ||
            status.type !== entry.type ||
            status.enabled !== entry.enabled ||
            !(["ready", "disabled", "error"] as const).includes(status.state) ||
            !Number.isSafeInteger(status.toolCount) ||
            status.toolCount < 0
          ) {
            throw new Error(`MCP server ${entry.name} returned an invalid status record.`);
          }
          status.resourceSupport = !status.enabled || status.state !== "ready"
            ? "unavailable"
            : adapter.listResources && adapter.readResource
              ? "supported"
              : "unsupported";
          if (status.error !== undefined) status.error = safeRemoteErrorMessage(status.error, this.workspaceRoot);
          const tools = adapter.listTools();
          const seen = new Set<string>();
          for (const tool of tools) {
            if (tool.serverName !== entry.name || tool.serverType !== entry.type) {
              throw new Error(`MCP tool ${tool.name} has invalid server ownership.`);
            }
            if (seen.has(tool.name) || this.tools.has(tool.name)) {
              throw new Error(`Duplicate MCP tool name: ${tool.name} from server ${entry.name}`);
            }
            seen.add(tool.name);
          }
          this.adapters.set(entry.name, adapter);
          this.statuses.push(status);
          for (const tool of tools) {
            this.tools.set(tool.name, tool);
          }
        } catch (error) {
          const message = safeRemoteErrorMessage(error, this.workspaceRoot);
          this.errors.push(`${configSource}: ${message}`);
          if (
            typeof entry.name === "string" &&
            !this.statuses.some((status) => status.name === entry.name) &&
            (entry.type === "github" || entry.type === "playwright")
          ) {
            this.statuses.push({
              name: entry.name,
              type: entry.type,
              enabled: entry.enabled === true,
              state: "error",
              error: message,
              toolCount: 0,
              resourceSupport: "unavailable",
              lastCheckedAt: now(),
            });
          }
        }
      }
    } catch {
      this.errors.push(`${configSource}: MCP server configuration could not be loaded.`);
    }

    this.initialized = true;
  }

  public listServerStatuses(): McpServerStatus[] {
    return this.statuses.map((status) => ({ ...status }));
  }

  public listErrors(): string[] {
    return [...this.errors];
  }

  public listToolDescriptors(): McpToolDescriptor[] {
    return [...this.tools.values()];
  }

  public async discoverResources(input: {
    serverName?: string;
    maxResources?: number;
  } = {}): Promise<McpResourceDiscoveryResult> {
    await this.initialize();
    const maxResources = input.maxResources ?? MCP_RESOURCE_DISCOVERY_MAX;
    if (!Number.isInteger(maxResources) || maxResources < 1 || maxResources > MCP_RESOURCE_DISCOVERY_MAX) {
      throw mcpResourceError(
        "ERR_TOOL_INVALID_ARGUMENTS",
        `MCP resource discovery limit must be between 1 and ${MCP_RESOURCE_DISCOVERY_MAX}.`,
      );
    }
    const selected = this.statuses
      .filter((status) => input.serverName === undefined || status.name === input.serverName)
      .sort((left, right) => left.name.localeCompare(right.name));
    if (input.serverName !== undefined && selected.length === 0) {
      throw mcpResourceError("ERR_TOOL_NOT_FOUND", `MCP server was not found: ${input.serverName}`);
    }

    const resources: McpResourceDiscoveryResult["resources"] = [];
    const warnings: LifecycleWarning[] = [];
    const seen = new Set<string>();
    let scanned = 0;
    let partial = false;
    let supportedServerCount = 0;
    let unavailableServerCount = 0;
    let unsupportedServerCount = 0;
    for (const status of selected) {
      if (!status.enabled || status.state !== "ready") {
        unavailableServerCount += 1;
        if (input.serverName !== undefined) {
          throw mcpResourceError(
            "ERR_TOOL_UNAVAILABLE",
            `MCP server is unavailable: ${status.name}${status.error ? ` (${safeRemoteErrorMessage(status.error, this.workspaceRoot)})` : ""}`,
          );
        }
        partial = true;
        warnings.push({
          code: "capability_unavailable",
          message: `MCP server ${status.name} is unavailable; its resources were not scanned.`,
          recordId: status.name,
        });
        continue;
      }
      const adapter = this.adapters.get(status.name);
      if (!adapter?.listResources || !adapter.readResource) {
        unsupportedServerCount += 1;
        if (input.serverName !== undefined) {
          throw mcpResourceError(
            "ERR_TOOL_UNSUPPORTED_PROTOCOL",
            `MCP server does not support the Resource protocol: ${status.name}`,
          );
        }
        partial = true;
        warnings.push({
          code: "capability_unavailable",
          message: `MCP server ${status.name} does not support Resources.`,
          recordId: status.name,
        });
        continue;
      }
      supportedServerCount += 1;

      let cursor: string | undefined;
      const seenCursors = new Set<string>();
      let serverCount = 0;
      let pageCount = 0;
      try {
        do {
          pageCount += 1;
          if (pageCount > MCP_RESOURCE_DISCOVERY_MAX_PAGES_PER_SERVER) {
            throw mcpResourceError(
              "ERR_TOOL_UNAVAILABLE",
              `MCP resource discovery exceeded ${MCP_RESOURCE_DISCOVERY_MAX_PAGES_PER_SERVER} pages for ${status.name}.`,
            );
          }
          const remaining = maxResources - resources.length;
          if (remaining <= 0) {
            partial = true;
            warnings.push({
              code: "scan_limit_reached",
              message: `MCP resource discovery stopped at ${maxResources} records.`,
            });
            break;
          }
          const page = await adapter.listResources({
            ...(cursor === undefined ? {} : { cursor }),
            limit: Math.min(MCP_RESOURCE_PROTOCOL_PAGE_LIMIT, remaining),
          });
          if (!page || !Array.isArray(page.resources)) {
            throw mcpResourceError("ERR_TOOL_CORRUPT_RECORD", "MCP resource list response is invalid.");
          }
          if (page.resources.length > Math.min(MCP_RESOURCE_PROTOCOL_PAGE_LIMIT, remaining)) {
            throw mcpResourceError("ERR_TOOL_CORRUPT_RECORD", "MCP server exceeded the requested resource page limit.");
          }
          scanned += page.resources.length;
          for (const candidate of page.resources) {
            try {
              const descriptor = normalizeResourceDescriptor(candidate);
              const key = `${status.name}\0${descriptor.uri}`;
              if (seen.has(key)) {
                partial = true;
                warnings.push({
                  code: "corrupt_record",
                  message: `Duplicate MCP resource URI was ignored for server ${status.name}.`,
                  recordId: status.name,
                });
                continue;
              }
              seen.add(key);
              serverCount += 1;
              resources.push({ serverName: status.name, ...descriptor });
            } catch (error) {
              partial = true;
              warnings.push({
                code: "corrupt_record",
                message: safeRemoteErrorMessage(error, this.workspaceRoot),
                recordId: status.name,
              });
            }
          }
          if (page.nextCursor !== undefined && (
            typeof page.nextCursor !== "string" || page.nextCursor.length < 1 || page.nextCursor.length > 4_096
          )) {
            throw mcpResourceError("ERR_TOOL_CORRUPT_RECORD", "MCP server returned an invalid resource cursor.");
          }
          if (page.nextCursor !== undefined && (page.nextCursor === cursor || seenCursors.has(page.nextCursor))) {
            throw mcpResourceError("ERR_TOOL_CORRUPT_RECORD", "MCP server repeated a resource cursor.");
          }
          if (page.nextCursor !== undefined) seenCursors.add(page.nextCursor);
          cursor = page.nextCursor;
        } while (cursor !== undefined);
        if (!partial || cursor === undefined) status.resourceCount = serverCount;
      } catch (error) {
        const code = (error as { code?: unknown }).code;
        if (input.serverName !== undefined) {
          if (typeof code === "string" && code.startsWith("ERR_TOOL_")) {
            throw mcpResourceError(code, safeRemoteErrorMessage(error, this.workspaceRoot));
          }
          throw mcpResourceError(
            "ERR_TOOL_UNAVAILABLE",
            `MCP resource discovery failed for ${status.name}: ${safeRemoteErrorMessage(error, this.workspaceRoot)}`,
          );
        }
        partial = true;
        warnings.push({
          code: code === "ERR_TOOL_CORRUPT_RECORD" ? "corrupt_record" : "capability_unavailable",
          message: `MCP resource discovery failed for ${status.name}: ${safeRemoteErrorMessage(error, this.workspaceRoot)}`,
          recordId: status.name,
        });
      }
    }

    if (supportedServerCount === 0) {
      if (unsupportedServerCount > 0) {
        throw mcpResourceError(
          "ERR_TOOL_UNSUPPORTED_PROTOCOL",
          "No selected MCP server supports the Resource protocol.",
        );
      }
      if (unavailableServerCount > 0 || selected.length === 0) {
        throw mcpResourceError("ERR_TOOL_UNAVAILABLE", "No selected MCP Resource capability is currently available.");
      }
    }
    resources.sort((left, right) => left.serverName.localeCompare(right.serverName) || left.uri.localeCompare(right.uri));
    return { resources, scanned, partial, warnings };
  }

  public async readResource(serverName: string, uri: string): Promise<McpResourceProtocolReadResult> {
    await this.initialize();
    if (typeof serverName !== "string" || !/^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/u.test(serverName)) {
      throw mcpResourceError("ERR_TOOL_INVALID_ARGUMENTS", "A valid MCP server name is required.");
    }
    const validatedUri = validateResourceUri(uri);
    const status = this.statuses.find((candidate) => candidate.name === serverName);
    if (!status) throw mcpResourceError("ERR_TOOL_NOT_FOUND", `MCP server was not found: ${serverName}`);
    if (!status.enabled || status.state !== "ready") {
      throw mcpResourceError(
        "ERR_TOOL_UNAVAILABLE",
        `MCP server is unavailable: ${serverName}${status.error ? ` (${safeRemoteErrorMessage(status.error, this.workspaceRoot)})` : ""}`,
      );
    }
    const adapter = this.adapters.get(serverName);
    if (!adapter?.readResource || !adapter.listResources) {
      throw mcpResourceError(
        "ERR_TOOL_UNSUPPORTED_PROTOCOL",
        `MCP server does not support the Resource protocol: ${serverName}`,
      );
    }
    try {
      return normalizeResourceReadResult(validatedUri, await adapter.readResource(validatedUri));
    } catch (error) {
      const code = (error as { code?: unknown }).code;
      if (typeof code === "string" && code.startsWith("ERR_TOOL_")) {
        throw mcpResourceError(code, safeRemoteErrorMessage(error, this.workspaceRoot));
      }
      throw mcpResourceError(
        "ERR_TOOL_UNAVAILABLE",
        `MCP resource read failed for ${serverName}: ${safeRemoteErrorMessage(error, this.workspaceRoot)}`,
      );
    }
  }

  public listInjectedToolDescriptors(prompt: string): McpToolDescriptor[] {
    const promptTokens = new Set(tokenize(prompt).filter((token) => !MCP_DYNAMIC_SELECTION_STOP_WORDS.has(token)));
    if (promptTokens.size === 0) {
      return [];
    }

    return this.listToolDescriptors().filter((tool) => {
      const status = this.statuses.find((entry) => entry.name === tool.serverName);
      if (!status || status.state !== "ready" || !status.enabled) {
        return false;
      }

      const keywords = new Set<string>([
        tool.serverName.toLowerCase(),
        tool.serverType.toLowerCase(),
        ...tool.selectionKeywords.flatMap((entry) => tokenize(entry)),
        ...tokenize(tool.name),
      ].filter((token) => !MCP_DYNAMIC_SELECTION_STOP_WORDS.has(token)));
      return [...promptTokens].some((token) => keywords.has(token));
    });
  }

  public async invokeTool(toolName: string, input: unknown): Promise<McpInvocationResult> {
    const descriptor = this.tools.get(toolName);
    if (!descriptor) {
      throw new Error(`Unknown MCP tool: ${toolName}`);
    }
    const adapter = this.adapters.get(descriptor.serverName);
    if (!adapter) {
      throw new Error(`MCP server is not active: ${descriptor.serverName}`);
    }
    const status = this.statuses.find((entry) => entry.name === descriptor.serverName);
    if (!status || !status.enabled || status.state !== "ready") {
      throw new Error(`MCP server is unavailable: ${descriptor.serverName}${status?.error ? ` (${status.error})` : ""}`);
    }
    return adapter.invokeTool(toolName, input);
  }

  private createAdapter(entry: McpServerConfigEntry): McpAdapter {
    const configured = this.options.createAdapter?.(entry, this.workspaceRoot);
    if (configured) return configured;
    switch (entry.type) {
      case "github":
        return new GitHubAdapter(entry);
      case "playwright":
        return new PlaywrightAdapter(this.workspaceRoot, entry);
      default:
        throw new Error(`Unsupported MCP server type: ${(entry as { type?: string }).type ?? "unknown"}`);
    }
  }
}
