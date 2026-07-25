import type { ToolAvailability, ToolDefinition, ToolResult } from "../../../../shared-schema/src/index.js";
import type {
  RuntimeToolExecutionContext,
  RuntimeToolSpec,
  ToolCatalogRegistration,
  ToolModule,
  ToolModuleContext,
} from "../../tool-module.js";

import { createToolSearch } from "./tool-search.js";
import { createGetRuntimeCapabilities } from "./get-runtime-capabilities.js";

interface ListToolsArgs {
  availableOnly?: boolean;
  group?: string;
  query?: string;
}

interface ToolCatalogItem {
  name: string;
  displayName?: string;
  description: string;
  moduleId: string;
  moduleVersion: string;
  moduleSource: "built_in" | "mcp";
  groups: string[];
  readOnly: boolean;
  permissionCategory: ToolDefinition["permissionCategory"];
  sideEffectLevel: ToolDefinition["sideEffectLevel"];
  timeoutCategory: ToolDefinition["timeoutCategory"];
  availability: ToolAvailability;
  selection: {
    alwaysAvailable: boolean;
    workflowOnly: boolean;
    attachmentExtensions: string[];
    mimeTypes: string[];
    workerRoutes: Array<"coding" | "vision">;
  };
}

function normalized(value: string | undefined): string {
  return value?.trim().toLocaleLowerCase() ?? "";
}

function matchesFilters(entry: ToolCatalogRegistration, args: ListToolsArgs): boolean {
  if (args.availableOnly && !entry.availability.available) return false;

  const requestedGroup = normalized(args.group);
  if (requestedGroup && !(entry.definition.groups ?? []).some((group) => normalized(group) === requestedGroup)) {
    return false;
  }

  const query = normalized(args.query);
  if (!query) return true;
  return [
    entry.definition.name,
    entry.definition.displayName,
    entry.definition.description,
    entry.definition.moduleId,
    entry.module.id,
    ...(entry.definition.groups ?? []),
  ].some((value) => normalized(value).includes(query));
}

function toCatalogItem(entry: ToolCatalogRegistration): ToolCatalogItem {
  const policy = entry.definition.selection;
  return {
    name: entry.definition.name,
    displayName: entry.definition.displayName,
    description: entry.definition.description,
    moduleId: entry.definition.moduleId ?? entry.module.id,
    moduleVersion: entry.definition.moduleVersion ?? entry.module.version,
    moduleSource: entry.module.source,
    groups: [...(entry.definition.groups ?? [])],
    readOnly: entry.definition.readOnly,
    permissionCategory: entry.definition.permissionCategory,
    sideEffectLevel: entry.definition.sideEffectLevel,
    timeoutCategory: entry.definition.timeoutCategory,
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
    selection: {
      alwaysAvailable: policy?.alwaysAvailable ?? false,
      workflowOnly: policy?.workflowOnly ?? false,
      attachmentExtensions: [...(policy?.attachmentExtensions ?? [])],
      mimeTypes: [...(policy?.mimeTypes ?? [])],
      workerRoutes: [...(policy?.workerRoutes ?? [])],
    },
  };
}

async function executeListTools(
  args: ListToolsArgs,
  context: RuntimeToolExecutionContext,
): Promise<ToolResult> {
  const registered = context.moduleContext.tools.listRegistered();
  const tools = registered.filter((entry) => matchesFilters(entry, args)).map(toCatalogItem);
  const timestamp = context.moduleContext.clock.now();
  const catalog = {
    kind: "tool_catalog",
    totalRegistered: registered.length,
    returnedCount: tools.length,
    availableCount: registered.filter((entry) => entry.availability.available).length,
    filters: {
      availableOnly: args.availableOnly ?? false,
      group: args.group?.trim() || undefined,
      query: args.query?.trim() || undefined,
    },
    tools,
  };
  return {
    toolName: "list_tools",
    callId: context.callId,
    startedAt: timestamp,
    endedAt: timestamp,
    success: true,
    output: JSON.stringify(catalog),
    structuredContent: catalog,
  };
}

function createListTools(_context: ToolModuleContext): RuntimeToolSpec {
  return {
    name: "list_tools",
    displayName: "List Tools",
    description:
      "Return the authoritative complete Tool Registry catalog with module, availability, groups, and safety metadata without injecting every tool schema.",
    inputSchema: {
      type: "object",
      additionalProperties: false,
      properties: {
        availableOnly: {
          type: "boolean",
          description: "When true, omit tools currently marked unavailable.",
        },
        group: {
          type: "string",
          minLength: 1,
          maxLength: 100,
          description: "Optionally return tools in one exact tool group.",
        },
        query: {
          type: "string",
          minLength: 1,
          maxLength: 100,
          description: "Optionally search names, descriptions, modules, and groups.",
        },
      },
    },
    readOnly: true,
    permissionCategory: "read_only",
    sideEffectLevel: "none",
    timeoutCategory: "fast",
    groups: ["runtime", "tools", "catalog"],
    selection: {
      alwaysAvailable: true,
      groups: ["runtime", "tools", "catalog"],
      keywords: ["tool list", "available tools", "what tools", "工具列表", "可用工具", "有哪些工具", "全部工具"],
    },
    execute: (rawArgs, executionContext) => executeListTools(rawArgs as ListToolsArgs, executionContext),
  };
}

export const catalogToolModule: ToolModule = {
  manifest: {
    id: "builtin.catalog",
    version: "1.0.0",
    description: "Read-only authoritative Tool Registry catalog.",
    source: "built_in",
  },
  create: (context) => [
    createListTools(context),
    createToolSearch(context),
    createGetRuntimeCapabilities(context),
  ],
};
