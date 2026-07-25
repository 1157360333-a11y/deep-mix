import type {
  ToolActivationRecord,
  ToolActivationRejectionReason,
  ToolSearchMatch,
  ToolSearchQuery,
  ToolSelectionLease,
  ToolSelectionRecord,
  ToolResult,
} from "../../../../shared-schema/src/index.js";
import { TOOL_SEARCH_LIMITS } from "../../../../shared-schema/src/index.js";

import type {
  RuntimeToolExecutionContext,
  RuntimeToolSpec,
  ToolCatalogRegistration,
  ToolModuleContext,
} from "../../tool-module.js";

interface ToolSearchArgs {
  query: string;
  mode?: "discover" | "activate";
  groups?: string[];
  moduleIds?: string[];
  sources?: Array<"built_in" | "mcp">;
  maxResults?: number;
  maxActivations?: number;
}

interface RankedMatch {
  entry: ToolCatalogRegistration;
  match: ToolSearchMatch;
}

function normalize(value: string): string {
  return value.trim().toLocaleLowerCase();
}

function normalizedList(values: string[] | undefined): string[] {
  return [...new Set((values ?? []).map(normalize).filter(Boolean))];
}

function includesTerm(value: string | undefined, term: string): boolean {
  return Boolean(value && normalize(value).includes(term));
}

function rankTool(entry: ToolCatalogRegistration, query: ToolSearchQuery): RankedMatch | undefined {
  const definition = entry.definition;
  const requestedGroups = new Set(normalizedList(query.groups));
  const requestedModules = new Set(normalizedList(query.moduleIds));
  const requestedSources = new Set(query.sources ?? []);
  const groups = definition.groups ?? [];

  if (requestedGroups.size > 0 && !groups.some((group) => requestedGroups.has(normalize(group)))) {
    return undefined;
  }
  if (requestedModules.size > 0 && !requestedModules.has(normalize(entry.module.id))) {
    return undefined;
  }
  if (requestedSources.size > 0 && !requestedSources.has(entry.module.source)) {
    return undefined;
  }

  const normalizedQuery = normalize(query.query);
  if (!normalizedQuery) return undefined;
  const terms = [...new Set([
    normalizedQuery,
    ...normalizedQuery.split(/[\s,，;；/]+/u).filter(Boolean),
  ])];
  const reasons = new Set<string>();
  let score = 0;

  for (const term of terms) {
    if (normalize(definition.name) === term) {
      score += 120;
      reasons.add("exact_name");
    } else if (includesTerm(definition.name, term)) {
      score += 70;
      reasons.add("name");
    }
    if (includesTerm(definition.displayName, term)) {
      score += 45;
      reasons.add("display_name");
    }
    if (includesTerm(definition.description, term)) {
      score += 25;
      reasons.add("description");
    }
    if (groups.some((group) => includesTerm(group, term))) {
      score += 40;
      reasons.add("group");
    }
    if (includesTerm(entry.module.id, term)) {
      score += 35;
      reasons.add("module");
    }
    if (includesTerm(entry.module.description, term)) {
      score += 15;
      reasons.add("module_description");
    }
    if (includesTerm(entry.module.source, term)) {
      score += 20;
      reasons.add("source");
    }
    if (definition.selection?.keywords?.some((keyword) => includesTerm(keyword, term))) {
      score += 55;
      reasons.add("keyword");
    }
  }

  if (score === 0) return undefined;

  let activatable = true;
  let activationBlockedReason: string | undefined;
  if (!entry.availability.available) {
    activatable = false;
    activationBlockedReason = "unavailable";
  } else if (definition.selection?.workflowOnly) {
    activatable = false;
    activationBlockedReason = "workflow_only";
  } else if (definition.selection?.alwaysAvailable) {
    activatable = false;
    activationBlockedReason = "already_selected";
  }

  return {
    entry,
    match: {
      name: definition.name,
      displayName: definition.displayName,
      moduleId: definition.moduleId ?? entry.module.id,
      moduleVersion: definition.moduleVersion ?? entry.module.version,
      source: entry.module.source,
      description: definition.description,
      groups: [...groups],
      permissionCategory: definition.permissionCategory,
      sideEffectLevel: definition.sideEffectLevel,
      availability: {
        ...entry.availability,
        missingCapabilities: entry.availability.missingCapabilities
          ? [...entry.availability.missingCapabilities]
          : undefined,
        fallbackCapabilities: entry.availability.fallbackCapabilities
          ? [...entry.availability.fallbackCapabilities]
          : undefined,
        warnings: entry.availability.warnings ? [...entry.availability.warnings] : undefined,
      },
      score,
      matchReasons: [...reasons].sort(),
      activatable,
      activationBlockedReason,
    },
  };
}

function blockedReasonForMode(
  ranked: RankedMatch,
  context: RuntimeToolExecutionContext,
  currentProviderToolNames?: ReadonlySet<string>,
): ToolActivationRejectionReason | undefined {
  if (currentProviderToolNames?.has(ranked.entry.definition.name)) return "already_selected";
  if (!ranked.entry.availability.available) return "unavailable";
  if (ranked.entry.definition.selection?.workflowOnly) return "workflow_only";
  if (ranked.entry.definition.selection?.alwaysAvailable) return "already_selected";
  if (
    context.permissionMode === "plan" &&
    !ranked.entry.definition.readOnly &&
    !(ranked.entry.definition.selection?.planModeActions?.length)
  ) return "mode_denied";
  return undefined;
}

function rejectionMessage(reason: ToolActivationRejectionReason, name: string): string {
  switch (reason) {
    case "unavailable":
      return `${name} is discoverable but currently unavailable.`;
    case "workflow_only":
      return `${name} is workflow-only and cannot be unlocked by tool_search.`;
    case "mode_denied":
      return `${name} is side-effecting and cannot be activated in plan mode.`;
    case "permission_denied":
      return `${name} is denied by the current permission policy.`;
    case "already_selected":
      return `${name} is already available without a selection lease.`;
    case "search_limit":
      return `${name} exceeds the per-search activation limit.`;
    case "turn_limit":
      return `${name} exceeds the cumulative activation limit for this turn.`;
    case "not_matched":
      return `${name} was not part of the bounded search result.`;
  }
}

function buildSearchQuery(args: ToolSearchArgs): ToolSearchQuery {
  return {
    query: args.query.trim(),
    mode: args.mode ?? "discover",
    groups: normalizedList(args.groups),
    moduleIds: normalizedList(args.moduleIds),
    sources: [...new Set(args.sources ?? [])],
    maxResults: Math.min(
      args.maxResults ?? TOOL_SEARCH_LIMITS.defaultResults,
      TOOL_SEARCH_LIMITS.maxResultsPerSearch,
    ),
    maxActivations: Math.min(
      args.maxActivations ?? TOOL_SEARCH_LIMITS.defaultActivations,
      TOOL_SEARCH_LIMITS.maxActivationsPerSearch,
    ),
  };
}

async function executeToolSearch(
  args: ToolSearchArgs,
  context: RuntimeToolExecutionContext,
): Promise<ToolResult> {
  const startedAt = context.moduleContext.clock.now();
  const query = buildSearchQuery(args);
  const ranked = context.moduleContext.tools.listRegistered()
    .map((entry) => rankTool(entry, query))
    .filter((entry): entry is RankedMatch => Boolean(entry))
    .sort((left, right) => right.match.score - left.match.score || left.match.name.localeCompare(right.match.name));
  const bounded = ranked.slice(0, query.maxResults);
  if (context.permissionMode === "plan") {
    for (const entry of bounded) {
      if (
        !entry.entry.definition.readOnly &&
        !(entry.entry.definition.selection?.planModeActions?.length)
      ) {
        entry.match.activatable = false;
        entry.match.activationBlockedReason = "mode_denied";
      }
    }
  }
  const matches = bounded.map(({ match }) => ({ ...match }));
  const resultBase = {
    kind: "tool_search",
    query,
    totalMatched: ranked.length,
    returnedCount: matches.length,
    truncated: ranked.length > matches.length,
    limits: { ...TOOL_SEARCH_LIMITS },
    matches,
  };

  if (query.mode === "discover") {
    return {
      toolName: "tool_search",
      callId: context.callId,
      startedAt,
      endedAt: context.moduleContext.clock.now(),
      success: true,
      output: JSON.stringify(resultBase),
      structuredContent: resultBase,
    };
  }

  const session = await context.moduleContext.persistence.loadSession(context.sessionId);
  const turnId = session?.activeTurnId;
  if (!turnId) {
    const message = "tool_search activation requires an active pending turn.";
    const body = { ...resultBase, error: { type: "invalid_state", message, retryable: false } };
    return {
      toolName: "tool_search",
      callId: context.callId,
      startedAt,
      endedAt: context.moduleContext.clock.now(),
      success: false,
      output: JSON.stringify(body),
      structuredContent: body,
      error: message,
    };
  }

  const events = await context.moduleContext.persistence.loadEvents(context.sessionId);
  const priorActivations = events.filter(
    (event): event is ToolActivationRecord => event.recordType === "tool_activation" && event.turnId === turnId,
  );
  const selectionRecords = events.filter(
    (event): event is ToolSelectionRecord => event.recordType === "tool_selection" && event.turnId === turnId,
  );
  const activationCycle = selectionRecords.reduce(
    (maximum, record, index) => Math.max(maximum, record.providerCycle ?? index + 1),
    0,
  );
  const currentProviderToolNames = new Set(selectionRecords.at(-1)?.selectedToolNames ?? []);
  for (const entry of bounded) {
    if (!currentProviderToolNames.has(entry.match.name)) continue;
    entry.match.activatable = false;
    entry.match.activationBlockedReason = "already_selected";
    const visibleMatch = matches.find((match) => match.name === entry.match.name);
    if (visibleMatch) {
      visibleMatch.activatable = false;
      visibleMatch.activationBlockedReason = "already_selected";
    }
  }
  const previouslyActivated = new Set(priorActivations.flatMap((record) => record.activatedToolNames));
  const currentlyLeased = new Set(
    priorActivations
      .map((record) => record.lease)
      .filter((lease) => lease && activationCycle <= lease.expiresAfterProviderCycle)
      .flatMap((lease) => lease?.toolNames ?? []),
  );
  const perSearchLimit = query.maxActivations ?? TOOL_SEARCH_LIMITS.defaultActivations;
  const remainingTurnCapacity = Math.max(
    0,
    TOOL_SEARCH_LIMITS.maxActivationsPerTurn - previouslyActivated.size,
  );
  const requestedToolNames = bounded
    .filter((entry) => !blockedReasonForMode(entry, context, currentProviderToolNames))
    .map((entry) => entry.match.name);
  const activatedToolNames: string[] = [];
  let newlyActivatedThisSearch = 0;
  const rejectedTools: ToolActivationRecord["rejectedTools"] = [];

  for (const entry of bounded) {
    const name = entry.match.name;
    const blocked = blockedReasonForMode(entry, context, currentProviderToolNames);
    if (blocked) {
      rejectedTools.push({ name, reason: blocked, message: rejectionMessage(blocked, name) });
      continue;
    }
    if (currentlyLeased.has(name)) {
      rejectedTools.push({
        name,
        reason: "already_selected",
        message: `${name} already has an active lease for this turn.`,
      });
      continue;
    }
    if (activatedToolNames.length >= perSearchLimit) {
      rejectedTools.push({ name, reason: "search_limit", message: rejectionMessage("search_limit", name) });
      continue;
    }
    if (!previouslyActivated.has(name)) {
      if (newlyActivatedThisSearch >= remainingTurnCapacity) {
        rejectedTools.push({ name, reason: "turn_limit", message: rejectionMessage("turn_limit", name) });
        continue;
      }
      newlyActivatedThisSearch += 1;
    }
    activatedToolNames.push(name);
  }

  const activationId = context.moduleContext.ids.create();
  const lease: ToolSelectionLease | undefined = activatedToolNames.length > 0
    ? {
        leaseId: context.moduleContext.ids.create(),
        sessionId: context.sessionId,
        turnId,
        sourceToolCallId: context.callId,
        sourceQuery: query,
        toolNames: [...activatedToolNames],
        createdAt: context.moduleContext.clock.now(),
        activationCycle,
        firstProviderCycle: activationCycle + 1,
        expiresAfterProviderCycle: activationCycle + TOOL_SEARCH_LIMITS.leaseProviderCycles,
        expiresOn: ["turn_completed", "turn_failed", "turn_cancelled", "session_interrupted"],
      }
    : undefined;
  const estimatedSchemaTokens = activatedToolNames.reduce((total, name) => {
    const definition = bounded.find((entry) => entry.match.name === name)?.entry.definition;
    return total + (definition ? Math.ceil(JSON.stringify(definition.inputSchema).length / 4) : 0);
  }, 0);
  const activationRecord: ToolActivationRecord = {
    recordType: "tool_activation",
    activationId,
    sessionId: context.sessionId,
    turnId,
    toolCallId: context.callId,
    createdAt: context.moduleContext.clock.now(),
    query,
    matches,
    requestedToolNames,
    activatedToolNames,
    rejectedTools,
    lease,
    estimatedSchemaTokens,
  };
  await context.moduleContext.persistence.recordToolActivation(activationRecord);

  const result = {
    ...resultBase,
    activation: activationRecord,
    note: "Activated tools become eligible only on later Provider calls; execution still requires normal availability, mode, permission, and approval checks.",
  };
  return {
    toolName: "tool_search",
    callId: context.callId,
    startedAt,
    endedAt: context.moduleContext.clock.now(),
    success: true,
    output: JSON.stringify(result),
    structuredContent: result,
  };
}

export function createToolSearch(_context: ToolModuleContext): RuntimeToolSpec {
  return {
    name: "tool_search",
    displayName: "Tool Search",
    description:
      "Search the bounded Tool Registry catalog by English or Chinese terms and optionally lease the most relevant eligible tools for later Provider calls without executing them.",
    inputSchema: {
      type: "object",
      additionalProperties: false,
      required: ["query"],
      properties: {
        query: { type: "string", minLength: 1, maxLength: 160, pattern: "\\S" },
        mode: { type: "string", enum: ["discover", "activate"] },
        groups: {
          type: "array",
          maxItems: 8,
          items: { type: "string", minLength: 1, maxLength: 80 },
        },
        moduleIds: {
          type: "array",
          maxItems: 8,
          items: { type: "string", minLength: 1, maxLength: 120 },
        },
        sources: {
          type: "array",
          maxItems: 2,
          items: { type: "string", enum: ["built_in", "mcp"] },
        },
        maxResults: {
          type: "integer",
          minimum: 1,
          maximum: TOOL_SEARCH_LIMITS.maxResultsPerSearch,
          default: TOOL_SEARCH_LIMITS.defaultResults,
        },
        maxActivations: {
          type: "integer",
          minimum: 1,
          maximum: TOOL_SEARCH_LIMITS.maxActivationsPerSearch,
        },
      },
    },
    readOnly: true,
    permissionCategory: "read_only",
    sideEffectLevel: "none",
    timeoutCategory: "fast",
    groups: ["runtime", "tools", "catalog", "discovery"],
    selection: {
      alwaysAvailable: true,
      groups: ["runtime", "tools", "catalog", "discovery"],
      keywords: [
        "tool search",
        "find tool",
        "activate tool",
        "工具搜索",
        "查找工具",
        "发现工具",
        "激活工具",
      ],
      attachmentExtensions: [],
      mimeTypes: [],
    },
    resolveAccess: () => [],
    execute: (rawArgs, executionContext) => executeToolSearch(rawArgs as ToolSearchArgs, executionContext),
  };
}
