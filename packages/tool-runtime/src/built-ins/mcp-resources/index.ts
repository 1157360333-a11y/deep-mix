import { createHash, createHmac } from "node:crypto";

import type {
  LifecyclePage,
  LifecycleWarning,
  McpResourceDescriptor,
  McpResourceListRequest,
  McpResourceProtocolDescriptor,
  McpResourceReadRequest,
  McpResourceReadResult,
  McpResourceSupport,
  McpServerListRequest,
  McpServerState,
  McpServerSummary,
  ToolAccessRequest,
} from "../../../../shared-schema/src/index.js";
import {
  encodeLifecycleCursor,
  LIFECYCLE_MAX_LIMIT,
  paginateLifecycleItems,
} from "../../lifecycle-pagination.js";
import { redactProcessText } from "../../process-manager.js";
import type { RuntimeToolExecutionContext, RuntimeToolSpec, ToolModule } from "../../tool-module.js";

const MCP_LIST_OUTPUT_MAX_CHARS = 262_144;
const MCP_RESOURCE_INLINE_MAX_CHARS = 2_000_000;
const MCP_RESOURCE_RESULT_MAX_CHARS = 2_200_000;
const MCP_RESOURCE_DISCOVERY_MAX = 10_000;
const MCP_RESOURCE_SERVER_NAME = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/u;
const MCP_RESOURCE_URI_SCHEME = /^[a-z][a-z0-9+.-]*$/u;
const SECRET_JSON_KEY = /(?:api[-_]?key|authorization|cookie|credential|password|secret|session[-_]?token|token)/iu;
const SERVER_STATES = new Set<McpServerState>(["ready", "disabled", "error"]);
const RESOURCE_SUPPORT = new Set<McpResourceSupport>(["supported", "unsupported", "unavailable"]);

function lifecycleError(code: string, message: string): Error {
  return Object.assign(new Error(message), { code });
}

function requireRegistry(context: RuntimeToolExecutionContext["moduleContext"]): NonNullable<typeof context.optional.mcpRegistry> {
  if (!context.optional.mcpRegistry) {
    throw lifecycleError("ERR_TOOL_UNAVAILABLE", "MCP Registry is unavailable.");
  }
  return context.optional.mcpRegistry;
}

function validLimit(value: unknown): number {
  const limit = value ?? 50;
  if (!Number.isInteger(limit) || (limit as number) < 1 || (limit as number) > LIFECYCLE_MAX_LIMIT) {
    throw lifecycleError("ERR_TOOL_INVALID_ARGUMENTS", `limit must be between 1 and ${LIFECYCLE_MAX_LIMIT}.`);
  }
  return limit as number;
}

function validCursor(value: unknown): string | undefined {
  if (value === undefined) return undefined;
  if (typeof value !== "string" || value.length < 1 || value.length > 4_096) {
    throw lifecycleError("ERR_TOOL_INVALID_ARGUMENTS", "cursor must contain 1 to 4,096 characters.");
  }
  return value;
}

function validServerName(value: unknown, required = false): string | undefined {
  if (value === undefined && !required) return undefined;
  if (typeof value !== "string" || !MCP_RESOURCE_SERVER_NAME.test(value)) {
    throw lifecycleError("ERR_TOOL_INVALID_ARGUMENTS", "A valid MCP server name is required.");
  }
  return value;
}

function serverListArguments(rawArgs: unknown): Required<Pick<McpServerListRequest, "limit">> & {
  cursor?: string;
  state?: McpServerState;
  resourceSupport?: McpResourceSupport;
} {
  const args = (rawArgs ?? {}) as McpServerListRequest;
  if (args.state !== undefined && !SERVER_STATES.has(args.state)) {
    throw lifecycleError("ERR_TOOL_INVALID_ARGUMENTS", "state is invalid.");
  }
  if (args.resourceSupport !== undefined && !RESOURCE_SUPPORT.has(args.resourceSupport)) {
    throw lifecycleError("ERR_TOOL_INVALID_ARGUMENTS", "resourceSupport is invalid.");
  }
  return {
    limit: validLimit(args.limit),
    cursor: validCursor(args.cursor),
    state: args.state,
    resourceSupport: args.resourceSupport,
  };
}

function resourceListArguments(rawArgs: unknown): Required<Pick<McpResourceListRequest, "limit">> & {
  cursor?: string;
  serverName?: string;
  uriScheme?: string;
  mimeType?: string;
} {
  const args = (rawArgs ?? {}) as McpResourceListRequest;
  const uriScheme = args.uriScheme?.toLowerCase();
  if (uriScheme !== undefined && !MCP_RESOURCE_URI_SCHEME.test(uriScheme)) {
    throw lifecycleError("ERR_TOOL_INVALID_ARGUMENTS", "uriScheme is invalid.");
  }
  if (args.mimeType !== undefined && (
    typeof args.mimeType !== "string" || args.mimeType.length < 1 || args.mimeType.length > 255 || /[\r\n]/u.test(args.mimeType)
  )) {
    throw lifecycleError("ERR_TOOL_INVALID_ARGUMENTS", "mimeType is invalid.");
  }
  return {
    limit: validLimit(args.limit),
    cursor: validCursor(args.cursor),
    serverName: validServerName(args.serverName),
    uriScheme,
    mimeType: args.mimeType?.toLowerCase(),
  };
}

function resourceReadArguments(rawArgs: unknown): McpResourceReadRequest {
  const args = (rawArgs ?? {}) as Partial<McpResourceReadRequest>;
  const serverName = validServerName(args.serverName, true)!;
  if (typeof args.uri !== "string" || args.uri.length < 1 || args.uri.length > 4_096) {
    throw lifecycleError("ERR_TOOL_INVALID_ARGUMENTS", "MCP resource URI must contain 1 to 4,096 characters.");
  }
  return { serverName, uri: args.uri };
}

function resourceUriSecrets(uri: string): string[] {
  let parsed: URL;
  try {
    parsed = new URL(uri);
  } catch {
    return [];
  }
  const values = new Set<string>();
  const add = (value: string) => {
    if (value.length < 3) return;
    values.add(value);
    try {
      const decoded = decodeURIComponent(value);
      if (decoded.length >= 3) values.add(decoded);
    } catch {
      // Invalid percent encoding is already rejected by the Registry URI validator.
    }
  };
  add(parsed.username);
  add(parsed.password);
  add(parsed.hash.replace(/^#/u, ""));
  for (const segment of parsed.pathname.split("/").filter(Boolean)) add(segment);
  for (const [, value] of parsed.searchParams) {
    add(value);
    add(encodeURIComponent(value));
  }
  return [...values].sort((left, right) => right.length - left.length);
}

function safeText(value: string, workspaceRoot: string, secrets: readonly string[] = []): string {
  const normalizedRoot = workspaceRoot
    .replace(/^\\\\\?\\/u, "")
    .replaceAll("\\", "/");
  const rootSegments = normalizedRoot.split("/").filter(Boolean);
  const rootPattern = rootSegments.length === 0
    ? undefined
    : new RegExp(
      `${normalizedRoot.startsWith("/") ? "[\\\\/]+" : ""}${rootSegments
        .map((segment) => segment.replace(/[.*+?^${}()|[\]\\]/gu, "\\$&"))
        .join("[\\\\/]+")}`,
      "giu",
    );
  let safe = redactProcessText(value).replace(/\\\\\?\\/gu, "");
  if (rootPattern) safe = safe.replace(rootPattern, "<workspace>");
  for (const secret of secrets) safe = safe.split(secret).join("[REDACTED]");
  return safe;
}

function redactStructured(
  value: unknown,
  workspaceRoot: string,
  secrets: readonly string[] = [],
  depth = 0,
): unknown {
  if (depth > 48) {
    throw lifecycleError("ERR_TOOL_UNAVAILABLE", "MCP structured resource exceeds the safe redaction depth.");
  }
  if (typeof value === "string") return safeText(value, workspaceRoot, secrets);
  if (value === null || typeof value !== "object") return value;
  if (Array.isArray(value)) {
    if (value.length > 100_000) {
      throw lifecycleError("ERR_TOOL_UNAVAILABLE", "MCP structured resource exceeds the safe array redaction limit.");
    }
    return value.map((entry) => redactStructured(entry, workspaceRoot, secrets, depth + 1));
  }
  const entries = Object.entries(value as Record<string, unknown>);
  if (entries.length > 100_000) {
    throw lifecycleError("ERR_TOOL_UNAVAILABLE", "MCP structured resource exceeds the safe object redaction limit.");
  }
  return Object.fromEntries(entries.map(([key, entry]) => [
    key,
    SECRET_JSON_KEY.test(key) ? "[REDACTED]" : redactStructured(entry, workspaceRoot, secrets, depth + 1),
  ]));
}

function opaqueResourceUri(input: {
  serverName: string;
  uri: string;
  integrityKey: Uint8Array;
  workspaceId: string;
  sessionId: string;
}): string {
  const token = createHmac("sha256", input.integrityKey)
    .update("deep-mix:mcp-resource-reference:v1\0", "utf8")
    .update(input.workspaceId, "utf8")
    .update("\0", "utf8")
    .update(input.sessionId, "utf8")
    .update("\0", "utf8")
    .update(input.serverName, "utf8")
    .update("\0", "utf8")
    .update(input.uri, "utf8")
    .digest("base64url");
  return `mcp-resource://${input.serverName}/${token}`;
}

function isOpaqueResourceUri(uri: string): boolean {
  return /^mcp-resource:\/\/[A-Za-z0-9][A-Za-z0-9._-]{0,127}\/[A-Za-z0-9_-]{43}$/u.test(uri);
}

function safeDescriptor(
  descriptor: McpResourceProtocolDescriptor,
  serverName: string,
  context: RuntimeToolExecutionContext,
  integrityKey: Uint8Array,
): McpResourceDescriptor {
  const secrets = resourceUriSecrets(descriptor.uri);
  return {
    serverName,
    uri: opaqueResourceUri({
      serverName,
      uri: descriptor.uri,
      integrityKey,
      workspaceId: context.moduleContext.persistence.workspaceId,
      sessionId: context.sessionId,
    }),
    name: safeText(descriptor.name, context.moduleContext.workspaceRoot, secrets).slice(0, 255),
    description: descriptor.description === undefined
      ? undefined
      : safeText(descriptor.description, context.moduleContext.workspaceRoot, secrets).slice(0, 4_000),
    mimeType: descriptor.mimeType === undefined
      ? undefined
      : safeText(descriptor.mimeType, context.moduleContext.workspaceRoot, secrets).slice(0, 255),
    sizeBytes: descriptor.sizeBytes,
    updatedAt: descriptor.updatedAt,
    ownership: {
      workspaceId: context.moduleContext.persistence.workspaceId,
      sessionId: context.sessionId,
      visibility: "workspace",
    },
    partial: false,
    warnings: [],
  };
}

function serverKey(item: McpServerSummary): string {
  return item.name;
}

function resourceKey(item: McpResourceDescriptor): string {
  return `${item.serverName}|${item.uri}`;
}

function uriScheme(uri: string): string {
  return uri.slice(0, uri.indexOf(":"));
}

function boundedWarning(warning: LifecycleWarning): LifecycleWarning {
  return {
    ...warning,
    message: warning.message.slice(0, 4_000),
    recordId: warning.recordId?.slice(0, 512),
  };
}

function fitPage<T>(input: {
  page: LifecyclePage<T>;
  stableKey: (item: T) => string;
  cursorContext: Parameters<typeof encodeLifecycleCursor>[0];
}): LifecyclePage<T> {
  const page = { ...input.page, items: [...input.page.items], warnings: input.page.warnings.slice(0, 100).map(boundedWarning) };
  if (JSON.stringify(page).length <= MCP_LIST_OUTPUT_MAX_CHARS) return page;
  const warning: LifecycleWarning = {
    code: "content_truncated",
    message: "MCP lifecycle page was shortened to the output budget; continue with nextCursor.",
  };
  page.partial = true;
  page.warnings.unshift(warning);
  while (page.items.length > 1 && JSON.stringify(page).length > MCP_LIST_OUTPUT_MAX_CHARS) page.items.pop();
  while (page.warnings.length > 1 && JSON.stringify(page).length > MCP_LIST_OUTPUT_MAX_CHARS) page.warnings.pop();
  if (JSON.stringify(page).length > MCP_LIST_OUTPUT_MAX_CHARS) page.warnings = [warning];
  page.returned = page.items.length;
  page.hasMore = true;
  page.nextCursor = page.items.length > 0
    ? encodeLifecycleCursor(input.cursorContext, input.stableKey(page.items.at(-1)!))
    : input.page.nextCursor;
  return page;
}

function resourceAccess(serverName: string | undefined, action: string): ToolAccessRequest[] {
  return [{
    kind: "external_system",
    systems: [serverName ?? "mcp_registry"],
    reason: `${action} through the MCP Resource protocol; no MCP Tool call is synthesized.`,
  }];
}

function uriFingerprint(uri: string): string {
  return createHash("sha256").update(uri).digest("base64url").slice(0, 24);
}

async function resolveResourceUri(input: {
  registry: ReturnType<typeof requireRegistry>;
  serverName: string;
  requestedUri: string;
  integrityKey: Uint8Array;
  workspaceId: string;
  sessionId: string;
}): Promise<string> {
  if (!isOpaqueResourceUri(input.requestedUri)) return input.requestedUri;
  const discovery = await input.registry.discoverResources({
    serverName: input.serverName,
    maxResources: MCP_RESOURCE_DISCOVERY_MAX,
  });
  const match = discovery.resources.find((resource) => (
    resource.serverName === input.serverName &&
    opaqueResourceUri({
      serverName: input.serverName,
      uri: resource.uri,
      integrityKey: input.integrityKey,
      workspaceId: input.workspaceId,
      sessionId: input.sessionId,
    }) === input.requestedUri
  ));
  if (!match) {
    throw lifecycleError("ERR_TOOL_NOT_FOUND", "MCP resource reference was not found in the current session catalog.");
  }
  return match.uri;
}

function artifactName(serverName: string, uri: string, extension: string): string {
  const safeServer = serverName.replace(/[^A-Za-z0-9._-]+/gu, "-").slice(0, 80);
  return `${safeServer}-${uriFingerprint(uri)}.${extension}`;
}

async function storeResourceArtifact(input: {
  context: RuntimeToolExecutionContext;
  serverName: string;
  uri: string;
  mimeType: string;
  representation: "text" | "structured" | "binary";
  content: string | Uint8Array;
}) {
  const extension = input.representation === "binary"
    ? "bin"
    : input.representation === "structured"
      ? "json"
      : "txt";
  return input.context.moduleContext.persistence.storeToolOutputArtifact({
    sessionId: input.context.sessionId,
    namespace: "mcp-resources",
    turnId: input.context.turnId,
    toolCallId: input.context.callId,
    sourceToolName: "read_mcp_resource",
    fileName: artifactName(input.serverName, input.uri, extension),
    mimeType: input.mimeType,
    kind: input.representation === "binary" ? "binary" : "text",
    summary: `Bounded MCP ${input.representation} resource from ${input.serverName}.`,
    content: input.content,
  });
}

function fitReadResult(result: McpResourceReadResult): McpResourceReadResult {
  if (JSON.stringify(result).length <= MCP_RESOURCE_RESULT_MAX_CHARS) return result;
  if (result.content !== undefined) {
    let low = 0;
    let high = result.content.length;
    while (low < high) {
      const middle = Math.ceil((low + high) / 2);
      const candidate = { ...result, content: result.content.slice(0, middle), returnedChars: middle };
      if (JSON.stringify(candidate).length <= MCP_RESOURCE_RESULT_MAX_CHARS) low = middle;
      else high = middle - 1;
    }
    result.content = result.content.slice(0, low);
    result.returnedChars = low;
    result.truncated = true;
    result.partial = true;
    result.warnings.push({ code: "content_truncated", message: "MCP resource inline body was bounded to the tool output budget." });
  }
  return result;
}

export const listMcpServersTool: RuntimeToolSpec = {
  name: "list_mcp_servers",
  description: "List configured MCP server state and Resource protocol capability through a bounded, auditable lifecycle page.",
  inputSchema: {
    type: "object",
    additionalProperties: false,
    properties: {
      cursor: { type: "string", minLength: 1, maxLength: 4_096 },
      limit: { type: "integer", minimum: 1, maximum: LIFECYCLE_MAX_LIMIT, default: 50 },
      state: { type: "string", enum: [...SERVER_STATES] },
      resourceSupport: { type: "string", enum: [...RESOURCE_SUPPORT] },
    },
  },
  readOnly: true,
  permissionCategory: "mcp_read_only",
  sideEffectLevel: "none",
  timeoutCategory: "fast",
  groups: ["mcp", "lifecycle", "resources"],
  selection: {
    groups: ["mcp", "lifecycle", "resources"],
    keywords: ["list mcp servers", "mcp server status"],
  },
  resolveAccess: () => [{ kind: "trusted_state_read", reason: "Read the configured MCP server status registry." }],
  redactArguments: (rawArgs) => {
    const args = (rawArgs ?? {}) as McpServerListRequest;
    return { limit: args.limit, state: args.state, resourceSupport: args.resourceSupport, cursorProvided: Boolean(args.cursor) };
  },
  execute: async (rawArgs, context) => {
    const startedAt = context.moduleContext.clock.now();
    const args = serverListArguments(rawArgs);
    const registry = requireRegistry(context.moduleContext);
    await registry.initialize();
    const ownership = {
      workspaceId: context.moduleContext.persistence.workspaceId,
      sessionId: context.sessionId,
      visibility: "workspace" as const,
    };
    const cursorIntegrityKey = await context.moduleContext.persistence.getLifecycleCursorIntegrityKey();
    const items: McpServerSummary[] = registry.listServerStatuses().map((status) => ({
      name: status.name,
      type: status.type,
      enabled: status.enabled,
      state: status.state,
      errorSummary: status.error === undefined ? undefined : safeText(status.error, context.moduleContext.workspaceRoot).slice(0, 4_000),
      toolCount: status.toolCount,
      resourceSupport: status.resourceSupport ?? (status.state === "ready" ? "unsupported" : "unavailable"),
      resourceCount: status.resourceCount,
      lastCheckedAt: status.lastCheckedAt,
      ownership,
      partial: false,
      warnings: [],
    })).filter((item) => (
      (args.state === undefined || item.state === args.state) &&
      (args.resourceSupport === undefined || item.resourceSupport === args.resourceSupport)
    )).sort((left, right) => serverKey(left).localeCompare(serverKey(right)));
    const filters = { state: args.state, resourceSupport: args.resourceSupport };
    const cursorContext = {
      scope: "list_mcp_servers",
      workspaceId: ownership.workspaceId,
      sessionId: context.sessionId,
      filters,
      integrityKey: cursorIntegrityKey,
    };
    const pagination = paginateLifecycleItems({
      items,
      cursor: args.cursor,
      limit: args.limit,
      context: cursorContext,
      stableKey: serverKey,
    });
    const configWarnings = registry.listErrors().map((message): LifecycleWarning => ({
      code: "capability_unavailable",
      message: safeText(message, context.moduleContext.workspaceRoot).slice(0, 4_000),
    }));
    const page = fitPage({
      page: {
        ...pagination,
        scanned: items.length,
        partial: configWarnings.length > 0,
        warnings: configWarnings,
      },
      stableKey: serverKey,
      cursorContext,
    });
    return {
      toolName: "list_mcp_servers",
      callId: context.callId,
      startedAt,
      endedAt: context.moduleContext.clock.now(),
      success: true,
      output: JSON.stringify(page),
      structuredContent: page,
    };
  },
};

export const listMcpResourcesTool: RuntimeToolSpec = {
  name: "list_mcp_resources",
  description: "Discover MCP Resources through each server's Resource protocol with stable local pagination; it never invokes an MCP Tool.",
  inputSchema: {
    type: "object",
    additionalProperties: false,
    properties: {
      serverName: { type: "string", minLength: 1, maxLength: 128, pattern: "^[A-Za-z0-9][A-Za-z0-9._-]*$" },
      uriScheme: { type: "string", minLength: 1, maxLength: 32, pattern: "^[a-z][a-z0-9+.-]*$" },
      mimeType: { type: "string", minLength: 1, maxLength: 255 },
      cursor: { type: "string", minLength: 1, maxLength: 4_096 },
      limit: { type: "integer", minimum: 1, maximum: LIFECYCLE_MAX_LIMIT, default: 50 },
    },
  },
  readOnly: true,
  permissionCategory: "mcp_read_only",
  sideEffectLevel: "none",
  timeoutCategory: "default",
  groups: ["mcp", "lifecycle", "resources"],
  selection: {
    groups: ["mcp", "lifecycle", "resources"],
    keywords: ["list mcp resources", "discover mcp resources"],
  },
  resolveAccess: (rawArgs) => resourceAccess(resourceListArguments(rawArgs).serverName, "Discover MCP Resources"),
  redactArguments: (rawArgs) => {
    const args = (rawArgs ?? {}) as McpResourceListRequest;
    return {
      serverName: args.serverName,
      uriScheme: args.uriScheme,
      mimeType: args.mimeType,
      limit: args.limit,
      cursorProvided: Boolean(args.cursor),
    };
  },
  execute: async (rawArgs, context) => {
    const startedAt = context.moduleContext.clock.now();
    const args = resourceListArguments(rawArgs);
    const discovery = await requireRegistry(context.moduleContext).discoverResources({
      serverName: args.serverName,
      maxResources: MCP_RESOURCE_DISCOVERY_MAX,
    });
    const cursorIntegrityKey = await context.moduleContext.persistence.getLifecycleCursorIntegrityKey();
    const items = discovery.resources
      .filter((resource) => (
        (args.uriScheme === undefined || uriScheme(resource.uri).toLowerCase() === args.uriScheme) &&
        (args.mimeType === undefined || resource.mimeType?.toLowerCase() === args.mimeType)
      ))
      .map((resource) => safeDescriptor(resource, resource.serverName, context, cursorIntegrityKey))
      .sort((left, right) => resourceKey(left).localeCompare(resourceKey(right)));
    const filters = { serverName: args.serverName, uriScheme: args.uriScheme, mimeType: args.mimeType };
    const cursorContext = {
      scope: "list_mcp_resources",
      workspaceId: context.moduleContext.persistence.workspaceId,
      sessionId: context.sessionId,
      filters,
      integrityKey: cursorIntegrityKey,
    };
    const pagination = paginateLifecycleItems({
      items,
      cursor: args.cursor,
      limit: args.limit,
      context: cursorContext,
      stableKey: resourceKey,
    });
    const page = fitPage({
      page: {
        ...pagination,
        scanned: discovery.scanned,
        partial: discovery.partial,
        warnings: discovery.warnings,
      },
      stableKey: resourceKey,
      cursorContext,
    });
    return {
      toolName: "list_mcp_resources",
      callId: context.callId,
      startedAt,
      endedAt: context.moduleContext.clock.now(),
      success: true,
      output: JSON.stringify(page),
      structuredContent: page,
    };
  },
};

export const readMcpResourceTool: RuntimeToolSpec = {
  name: "read_mcp_resource",
  description: "Read one MCP Resource through the target server's Resource protocol, promoting long text and all binary payloads to trusted artifacts.",
  inputSchema: {
    type: "object",
    additionalProperties: false,
    required: ["serverName", "uri"],
    properties: {
      serverName: { type: "string", minLength: 1, maxLength: 128, pattern: "^[A-Za-z0-9][A-Za-z0-9._-]*$" },
      uri: { type: "string", minLength: 1, maxLength: 4_096 },
    },
  },
  readOnly: true,
  permissionCategory: "mcp_read_only",
  sideEffectLevel: "none",
  timeoutCategory: "default",
  groups: ["mcp", "lifecycle", "resources"],
  selection: {
    groups: ["mcp", "lifecycle", "resources"],
    keywords: ["read mcp resource", "open mcp resource"],
  },
  resolveAccess: (rawArgs) => {
    const args = resourceReadArguments(rawArgs);
    return resourceAccess(args.serverName, "Read an MCP Resource");
  },
  redactArguments: (rawArgs) => {
    const args = (rawArgs ?? {}) as Partial<McpResourceReadRequest>;
    return {
      serverName: args.serverName,
      uriScheme: typeof args.uri === "string" && args.uri.includes(":") ? args.uri.slice(0, args.uri.indexOf(":")) : undefined,
      uriChars: typeof args.uri === "string" ? args.uri.length : 0,
    };
  },
  execute: async (rawArgs, context) => {
    const startedAt = context.moduleContext.clock.now();
    const args = resourceReadArguments(rawArgs);
    const registry = requireRegistry(context.moduleContext);
    const cursorIntegrityKey = await context.moduleContext.persistence.getLifecycleCursorIntegrityKey();
    const exactUri = await resolveResourceUri({
      registry,
      serverName: args.serverName,
      requestedUri: args.uri,
      integrityKey: cursorIntegrityKey,
      workspaceId: context.moduleContext.persistence.workspaceId,
      sessionId: context.sessionId,
    });
    const raw = await registry.readResource(args.serverName, exactUri);
    const descriptor = safeDescriptor(raw.descriptor, args.serverName, context, cursorIntegrityKey);
    const uriSecrets = resourceUriSecrets(exactUri);
    const warnings: LifecycleWarning[] = [];
    let redacted = false;
    let result: McpResourceReadResult;

    if (raw.representation === "text") {
      const original = raw.text!;
      const content = safeText(original, context.moduleContext.workspaceRoot, uriSecrets);
      redacted = content !== original;
      const inlineContent = content.slice(0, MCP_RESOURCE_INLINE_MAX_CHARS);
      const truncated = content.length > MCP_RESOURCE_INLINE_MAX_CHARS ||
        JSON.stringify(inlineContent).length > MCP_RESOURCE_RESULT_MAX_CHARS - 100_000;
      const artifact = truncated
        ? await storeResourceArtifact({
          context,
          serverName: args.serverName,
          uri: descriptor.uri,
          mimeType: descriptor.mimeType ?? "text/plain; charset=utf-8",
          representation: "text",
          content,
        })
        : undefined;
      result = {
        descriptor,
        representation: "text",
        content: inlineContent,
        artifact,
        sizeBytes: Buffer.byteLength(content, "utf8"),
        returnedChars: inlineContent.length,
        totalChars: content.length,
        truncated,
        binaryInline: false,
        ownership: descriptor.ownership,
        partial: truncated || redacted,
        warnings,
      };
    } else if (raw.representation === "structured") {
      const sanitized = redactStructured(raw.structuredData, context.moduleContext.workspaceRoot, uriSecrets);
      let serialized: string;
      try {
        serialized = JSON.stringify(sanitized);
      } catch {
        throw lifecycleError("ERR_TOOL_CORRUPT_RECORD", "MCP structured resource could not be serialized after redaction.");
      }
      const originalSerialized = JSON.stringify(raw.structuredData);
      redacted = serialized !== originalSerialized;
      const truncated = serialized.length > MCP_RESOURCE_INLINE_MAX_CHARS;
      const artifact = truncated
        ? await storeResourceArtifact({
          context,
          serverName: args.serverName,
          uri: descriptor.uri,
          mimeType: descriptor.mimeType ?? "application/json",
          representation: "structured",
          content: serialized,
        })
        : undefined;
      result = {
        descriptor,
        representation: "structured",
        ...(truncated
          ? { content: serialized.slice(0, MCP_RESOURCE_INLINE_MAX_CHARS) }
          : { structuredData: sanitized }),
        artifact,
        sizeBytes: Buffer.byteLength(serialized, "utf8"),
        returnedChars: Math.min(serialized.length, MCP_RESOURCE_INLINE_MAX_CHARS),
        totalChars: serialized.length,
        truncated,
        binaryInline: false,
        ownership: descriptor.ownership,
        partial: truncated || redacted,
        warnings,
      };
    } else {
      const bytes = raw.binaryData!;
      const artifact = await storeResourceArtifact({
        context,
        serverName: args.serverName,
        uri: descriptor.uri,
        mimeType: descriptor.mimeType ?? "application/octet-stream",
        representation: "binary",
        content: bytes,
      });
      result = {
        descriptor,
        representation: "binary",
        artifact,
        sizeBytes: bytes.byteLength,
        truncated: false,
        binaryInline: false,
        ownership: descriptor.ownership,
        partial: false,
        warnings,
      };
    }

    if (redacted) warnings.push({ code: "content_redacted", message: "Sensitive MCP resource content was redacted before disclosure and artifact storage." });
    if (result.truncated) warnings.push({ code: "content_truncated", message: "Inline MCP resource content was bounded to at most 2,000,000 characters; the artifact contains the full redacted payload." });
    result = fitReadResult(result);
    return {
      toolName: "read_mcp_resource",
      callId: context.callId,
      startedAt,
      endedAt: context.moduleContext.clock.now(),
      success: true,
      output: JSON.stringify(result),
      structuredContent: result,
      artifacts: result.artifact ? [result.artifact] : undefined,
    };
  },
};

export const mcpResourceLifecycleToolModule: ToolModule = {
  manifest: {
    id: "builtin.mcp-resource-lifecycle",
    version: "1.0.0",
    description: "Audited MCP server discovery and separate read-only Resource protocol tools.",
    source: "built_in",
  },
  create: (context) => context.optional.mcpRegistry
    ? [listMcpServersTool, listMcpResourcesTool, readMcpResourceTool]
    : [],
};
