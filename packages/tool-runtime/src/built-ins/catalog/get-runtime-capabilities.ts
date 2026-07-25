import type {
  RuntimeCapabilityProbe,
  RuntimeCapabilitySnapshot,
  ToolResult,
} from "../../../../shared-schema/src/index.js";

import type {
  RuntimeToolExecutionContext,
  RuntimeToolSpec,
  ToolModuleContext,
} from "../../tool-module.js";

const DEFAULT_RESULT_LIMIT = 256;
const MAX_RESULT_LIMIT = 256;
const MAX_NAME_FILTERS = 256;
const SNAPSHOT_STALE_AFTER_MS = 15 * 60 * 1000;
const MAX_FUTURE_CLOCK_SKEW_MS = 5 * 60 * 1000;
const SAFE_CAPABILITY_NAME = /^[a-z][a-z0-9._-]{0,99}$/u;

type SafeListFilesFallback = "rg" | "node_fs";
type SafeSearchFilesFallback = "rg" | "node_text";

interface GetRuntimeCapabilitiesArgs {
  name?: string;
  names?: string[];
  maxResults?: number;
}

interface CapabilitySnapshotFreshness {
  stale: boolean;
  reason?: "missing_snapshot" | "invalid_checked_at" | "age_exceeded" | "future_clock_skew";
  ageMs?: number;
}

interface SafeCapabilityEntry {
  name: string;
  available: boolean;
  status: "available" | "unavailable";
}

function normalizeRequestedNames(name: string | undefined, names: string[] | undefined): string[] {
  return [...new Set([name, ...(names ?? [])]
    .filter((value): value is string => typeof value === "string")
    .map((value) => value.trim().toLocaleLowerCase())
    .filter(Boolean))];
}

function isSafeCapabilityName(name: string): boolean {
  return SAFE_CAPABILITY_NAME.test(name);
}

function checkedAtValue(snapshot: RuntimeCapabilitySnapshot | undefined): string | undefined {
  if (!snapshot?.checkedAt) return undefined;
  const timestamp = Date.parse(snapshot.checkedAt);
  return Number.isFinite(timestamp) ? new Date(timestamp).toISOString() : undefined;
}

function snapshotFreshness(
  snapshot: RuntimeCapabilitySnapshot | undefined,
  queriedAt: string,
): CapabilitySnapshotFreshness {
  if (!snapshot) return { stale: true, reason: "missing_snapshot" };
  const checkedAt = Date.parse(snapshot.checkedAt);
  if (!Number.isFinite(checkedAt)) return { stale: true, reason: "invalid_checked_at" };

  const queryTime = Date.parse(queriedAt);
  const ageMs = queryTime - checkedAt;
  if (ageMs < -MAX_FUTURE_CLOCK_SKEW_MS) {
    return { stale: true, reason: "future_clock_skew", ageMs };
  }
  if (ageMs > SNAPSHOT_STALE_AFTER_MS) {
    return { stale: true, reason: "age_exceeded", ageMs };
  }
  return { stale: false, ageMs: Math.max(0, ageMs) };
}

function sanitizeCapabilityEntries(
  snapshot: RuntimeCapabilitySnapshot | undefined,
  registeredNames: ReadonlySet<string>,
): Array<[string, RuntimeCapabilityProbe]> {
  if (!snapshot?.capabilities || typeof snapshot.capabilities !== "object") return [];
  return Object.entries(snapshot.capabilities)
    .filter(([name, capability]) =>
      isSafeCapabilityName(name) &&
      registeredNames.has(name) &&
      capability !== null &&
      typeof capability === "object" &&
      typeof capability.available === "boolean")
    .sort(([left], [right]) => left.localeCompare(right));
}

function safeListFilesFallback(snapshot: RuntimeCapabilitySnapshot | undefined): SafeListFilesFallback | undefined {
  const value = snapshot?.fallbacks?.listFiles;
  return value === "rg" || value === "node_fs" ? value : undefined;
}

function safeSearchFilesFallback(snapshot: RuntimeCapabilitySnapshot | undefined): SafeSearchFilesFallback | undefined {
  const value = snapshot?.fallbacks?.searchFiles;
  return value === "rg" || value === "node_text" ? value : undefined;
}

async function executeGetRuntimeCapabilities(
  args: GetRuntimeCapabilitiesArgs,
  context: RuntimeToolExecutionContext,
): Promise<ToolResult> {
  const startedAt = context.moduleContext.clock.now();
  // loadSnapshot is deliberately cache-only. It must not call the capability detector.
  const snapshot = await context.moduleContext.capabilities.loadSnapshot();
  const registeredNames = new Set(context.moduleContext.capabilities.listRegisteredNames());
  const requestedNames = normalizeRequestedNames(args.name, args.names);
  const requestedNameSet = new Set(requestedNames);
  const safeEntries = sanitizeCapabilityEntries(snapshot, registeredNames);
  const filteredEntries = requestedNames.length > 0
    ? safeEntries.filter(([name]) => requestedNameSet.has(name))
    : safeEntries;
  const limit = Math.min(args.maxResults ?? DEFAULT_RESULT_LIMIT, MAX_RESULT_LIMIT);
  const boundedEntries = filteredEntries.slice(0, limit);
  const capabilities: SafeCapabilityEntry[] = boundedEntries.map(([name, capability]) => ({
    name,
    available: capability.available,
    status: capability.available ? "available" : "unavailable",
  }));
  const visibleNameSet = new Set(safeEntries.map(([name]) => name));
  const unknownNameCount = requestedNames.filter(
    (name) => !isSafeCapabilityName(name) || !visibleNameSet.has(name),
  ).length;
  const queriedAt = context.moduleContext.clock.now();
  const freshness = snapshotFreshness(snapshot, queriedAt);
  const checkedAt = checkedAtValue(snapshot);
  const fallbackListFiles = safeListFilesFallback(snapshot);
  const fallbackSearchFiles = safeSearchFilesFallback(snapshot);
  const result = {
    kind: "runtime_capabilities",
    source: "runtime-capabilities.json",
    platform: process.platform,
    checkedAt,
    queriedAt,
    stale: freshness.stale,
    staleReason: freshness.reason,
    ageMs: freshness.ageMs,
    staleAfterMs: SNAPSHOT_STALE_AFTER_MS,
    probePerformed: false,
    filters: {
      requestedNameCount: requestedNames.length,
      matchedNames: boundedEntries.map(([name]) => name),
      maxResults: limit,
    },
    totalCount: safeEntries.length,
    matchedCount: filteredEntries.length,
    returnedCount: capabilities.length,
    truncated: filteredEntries.length > capabilities.length,
    unknownNameCount,
    available: capabilities.filter((entry) => entry.available).map((entry) => entry.name),
    unavailable: capabilities.filter((entry) => !entry.available).map((entry) => entry.name),
    fallbacks: {
      listFiles: fallbackListFiles,
      searchFiles: fallbackSearchFiles,
    },
    capabilities,
  };

  return {
    toolName: "get_runtime_capabilities",
    callId: context.callId,
    startedAt,
    endedAt: queriedAt,
    success: true,
    output: JSON.stringify(result),
    structuredContent: result,
  };
}

export function createGetRuntimeCapabilities(_context: ToolModuleContext): RuntimeToolSpec {
  return {
    name: "get_runtime_capabilities",
    displayName: "Get Runtime Capabilities",
    description:
      "Return the complete safe view of the existing registered runtime capability snapshot by default, including availability, fallbacks, platform, probe time, and explicit staleness without running probes.",
    inputSchema: {
      type: "object",
      additionalProperties: false,
      properties: {
        name: {
          type: "string",
          minLength: 1,
          maxLength: 100,
          pattern: "^[a-zA-Z][a-zA-Z0-9._-]*$",
          description: "Optionally return one exact capability name, such as rg or git.",
        },
        names: {
          type: "array",
          maxItems: MAX_NAME_FILTERS,
          uniqueItems: true,
          description: "Optional exact capability names to return, such as rg or git.",
          items: {
            type: "string",
            minLength: 1,
            maxLength: 100,
            pattern: "^[a-zA-Z][a-zA-Z0-9._-]*$",
          },
        },
        maxResults: {
          type: "integer",
          minimum: 1,
          maximum: MAX_RESULT_LIMIT,
          description: "Maximum number of safe capability entries to return.",
        },
      },
    },
    readOnly: true,
    permissionCategory: "read_only",
    sideEffectLevel: "none",
    timeoutCategory: "fast",
    groups: ["runtime", "capabilities", "catalog"],
    selection: {
      groups: ["runtime", "capabilities", "catalog"],
      keywords: [
        "runtime capabilities",
        "runtime capability",
        "capability registry",
        "capability snapshot",
        "dependency availability",
        "is rg available",
        "运行时能力",
        "能力注册表",
        "能力快照",
        "依赖是否可用",
        "rg 是否可用",
      ],
      attachmentExtensions: [],
      mimeTypes: [],
    },
    resolveAccess: () => [],
    execute: (rawArgs, executionContext) =>
      executeGetRuntimeCapabilities(rawArgs as GetRuntimeCapabilitiesArgs, executionContext),
  };
}
