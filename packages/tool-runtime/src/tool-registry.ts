import type {
  ToolAvailability,
  ToolDefinition,
  ToolModuleManifest,
  ToolSelectionContext,
  ToolSelectionSummary,
} from "../../shared-schema/src/index.js";
import { Ajv, type ErrorObject, type ValidateFunction } from "ajv";

export type ToolRegistryErrorCode =
  | "invalid_module_manifest"
  | "invalid_tool_definition"
  | "duplicate_module"
  | "duplicate_tool"
  | "module_initialization_failed";

export interface ToolRegistryExtensionError {
  code: ToolRegistryErrorCode;
  message: string;
  moduleId?: string;
  toolName?: string;
  existingSource?: string;
  incomingSource?: string;
}

export class ToolRegistryError extends Error {
  public readonly detail: ToolRegistryExtensionError;

  public constructor(detail: ToolRegistryExtensionError) {
    super(detail.message);
    this.name = "ToolRegistryError";
    this.detail = detail;
  }
}

export interface RegisteredTool<TTool extends ToolDefinition = ToolDefinition> {
  module: ToolModuleManifest;
  tool: TTool;
  availability: ToolAvailability;
}

export interface ToolArgumentValidationResult {
  valid: boolean;
  errors: Array<{
    path: string;
    message: string;
  }>;
}

interface RegisteredModule<TTool extends ToolDefinition> {
  manifest: ToolModuleManifest;
  tools: Map<string, RegisteredTool<TTool>>;
}

const AVAILABLE: ToolAvailability = {
  status: "available",
  available: true,
};

function validateModuleManifest(manifest: ToolModuleManifest): void {
  if (!/^[a-z][a-z0-9._-]*$/.test(manifest.id)) {
    throw new ToolRegistryError({
      code: "invalid_module_manifest",
      message: `Invalid tool module id: ${manifest.id || "<empty>"}.`,
      moduleId: manifest.id,
    });
  }
  if (!/^\d+\.\d+\.\d+(?:[-+][0-9A-Za-z.-]+)?$/.test(manifest.version)) {
    throw new ToolRegistryError({
      code: "invalid_module_manifest",
      message: `Invalid version for tool module ${manifest.id}: ${manifest.version || "<empty>"}.`,
      moduleId: manifest.id,
    });
  }
  if (!manifest.description.trim() || (manifest.source !== "built_in" && manifest.source !== "mcp")) {
    throw new ToolRegistryError({
      code: "invalid_module_manifest",
      message: `Incomplete manifest for tool module ${manifest.id}.`,
      moduleId: manifest.id,
    });
  }
}

function validateToolDefinition(tool: ToolDefinition, module: ToolModuleManifest): void {
  if (!/^[a-z][a-z0-9_]*$/.test(tool.name)) {
    throw new ToolRegistryError({
      code: "invalid_tool_definition",
      message: `Invalid tool name in module ${module.id}: ${tool.name || "<empty>"}.`,
      moduleId: module.id,
      toolName: tool.name,
    });
  }
  if (
    !tool.description.trim() ||
    !tool.inputSchema ||
    typeof tool.inputSchema !== "object" ||
    Array.isArray(tool.inputSchema) ||
    typeof tool.readOnly !== "boolean" ||
    !tool.permissionCategory ||
    !tool.sideEffectLevel ||
    !tool.timeoutCategory
  ) {
    throw new ToolRegistryError({
      code: "invalid_tool_definition",
      message: `Incomplete definition for tool ${tool.name} from module ${module.id}.`,
      moduleId: module.id,
      toolName: tool.name,
    });
  }
  const schemaType = tool.inputSchema.type;
  if (schemaType !== undefined && schemaType !== "object") {
    throw new ToolRegistryError({
      code: "invalid_tool_definition",
      message: `Tool ${tool.name} must use an object input schema.`,
      moduleId: module.id,
      toolName: tool.name,
    });
  }
  if (tool.moduleId && tool.moduleId !== module.id) {
    throw new ToolRegistryError({
      code: "invalid_tool_definition",
      message: `Tool ${tool.name} declares module ${tool.moduleId} but was registered by ${module.id}.`,
      moduleId: module.id,
      toolName: tool.name,
    });
  }
  const version = tool.version ?? module.version;
  if (!/^\d+\.\d+\.\d+(?:[-+][0-9A-Za-z.-]+)?$/.test(version)) {
    throw new ToolRegistryError({
      code: "invalid_tool_definition",
      message: `Invalid version for tool ${tool.name}: ${version || "<empty>"}.`,
      moduleId: module.id,
      toolName: tool.name,
    });
  }
}

function normalizeTool<TTool extends ToolDefinition>(tool: TTool, module: ToolModuleManifest): TTool {
  return {
    ...tool,
    moduleId: module.id,
    moduleVersion: module.version,
    version: tool.version ?? module.version,
    groups: [...new Set([...(tool.groups ?? []), ...(tool.selection?.groups ?? [])])].sort(),
  };
}

function intersects(values: readonly string[] | undefined, requested: ReadonlySet<string>): boolean {
  return values?.some((value) => requested.has(value.toLowerCase())) ?? false;
}

function selectionReason(tool: ToolDefinition, context: ToolSelectionContext): string | undefined {
  if (context.includeAll) return "include_all";

  const policy = tool.selection;
  if (!policy) return "legacy_default";
  if (policy.alwaysAvailable) return "always_available";

  if (context.workflowToolNames?.includes(tool.name)) return "workflow_request";
  if (context.requestedToolNames?.includes(tool.name)) return "explicit_request";
  if (policy.workflowOnly) return undefined;
  if (context.activatedToolNames?.includes(tool.name)) return "selection_lease";

  const requestedGroups = new Set((context.requestedGroups ?? []).map((value) => value.toLowerCase()));
  if (intersects(policy.groups ?? tool.groups, requestedGroups)) return "group_match";

  const normalizedPrompt = context.prompt?.toLocaleLowerCase() ?? "";
  if (policy.keywords?.some((keyword) => normalizedPrompt.includes(keyword.toLocaleLowerCase()))) {
    return "keyword_match";
  }
  if (policy.keywordGroups?.some((group) =>
    group.length > 0 && group.every((keyword) => normalizedPrompt.includes(keyword.toLocaleLowerCase())))) {
    return "keyword_group_match";
  }

  const extensions = new Set((context.attachmentExtensions ?? []).map((value) => value.toLowerCase()));
  if (intersects(policy.attachmentExtensions, extensions)) return "attachment_extension";

  const mimeTypes = new Set((context.attachmentMimeTypes ?? []).map((value) => value.toLowerCase()));
  if (intersects(policy.mimeTypes, mimeTypes)) return "attachment_mime";

  const routes = new Set(context.workerRoutes ?? []);
  if (policy.workerRoutes?.some((route) => routes.has(route))) return "worker_route";

  return undefined;
}

export class ToolRegistry<TTool extends ToolDefinition = ToolDefinition> {
  private readonly ajv = new Ajv({
    allErrors: true,
    strict: false,
    coerceTypes: false,
    removeAdditional: false,
    useDefaults: false,
  });

  private readonly modules = new Map<string, RegisteredModule<TTool>>();

  private readonly tools = new Map<string, RegisteredTool<TTool>>();

  private readonly extensionErrors: ToolRegistryExtensionError[] = [];

  private readonly validators = new Map<string, ValidateFunction>();

  public registerModule(manifest: ToolModuleManifest, tools: readonly TTool[] = []): void {
    try {
      validateModuleManifest(manifest);
      const existingModule = this.modules.get(manifest.id);
      if (existingModule) {
        throw new ToolRegistryError({
          code: "duplicate_module",
          message: `Duplicate tool module ${manifest.id}: ${existingModule.manifest.version} and ${manifest.version}.`,
          moduleId: manifest.id,
          existingSource: `${existingModule.manifest.id}@${existingModule.manifest.version}`,
          incomingSource: `${manifest.id}@${manifest.version}`,
        });
      }

      const normalizedTools = tools.map((tool) => {
        validateToolDefinition(tool, manifest);
        const existingTool = this.tools.get(tool.name);
        if (existingTool) {
          throw new ToolRegistryError({
            code: "duplicate_tool",
            message: `Duplicate tool ${tool.name}: module ${existingTool.module.id} conflicts with ${manifest.id}.`,
            moduleId: manifest.id,
            toolName: tool.name,
            existingSource: `${existingTool.module.id}@${existingTool.module.version}`,
            incomingSource: `${manifest.id}@${manifest.version}`,
          });
        }
        let validator: ValidateFunction;
        try {
          validator = this.ajv.compile(tool.inputSchema);
        } catch (error) {
          throw new ToolRegistryError({
            code: "invalid_tool_definition",
            message: `Invalid input schema for tool ${tool.name} from module ${manifest.id}: ${(error as Error).message}`,
            moduleId: manifest.id,
            toolName: tool.name,
          });
        }
        return {
          tool: normalizeTool(tool, manifest),
          validator,
        };
      });

      const duplicateWithinModule = normalizedTools.find(
        (entry, index) =>
          normalizedTools.findIndex((candidate) => candidate.tool.name === entry.tool.name) !== index,
      );
      if (duplicateWithinModule) {
        throw new ToolRegistryError({
          code: "duplicate_tool",
          message: `Duplicate tool ${duplicateWithinModule.tool.name} inside module ${manifest.id}.`,
          moduleId: manifest.id,
          toolName: duplicateWithinModule.tool.name,
          incomingSource: `${manifest.id}@${manifest.version}`,
        });
      }

      const moduleRecord: RegisteredModule<TTool> = {
        manifest: { ...manifest },
        tools: new Map(),
      };
      for (const { tool } of normalizedTools) {
        const entry: RegisteredTool<TTool> = {
          module: moduleRecord.manifest,
          tool,
          availability: { ...AVAILABLE },
        };
        moduleRecord.tools.set(tool.name, entry);
      }
      this.modules.set(manifest.id, moduleRecord);
      for (const entry of moduleRecord.tools.values()) {
        this.tools.set(entry.tool.name, entry);
      }
      for (const { tool, validator } of normalizedTools) {
        this.validators.set(tool.name, validator);
      }
    } catch (error) {
      if (error instanceof ToolRegistryError) {
        this.extensionErrors.push(error.detail);
        throw error;
      }
      const detail: ToolRegistryExtensionError = {
        code: "module_initialization_failed",
        message: `Tool module ${manifest.id || "<unknown>"} failed to register: ${(error as Error).message}`,
        moduleId: manifest.id,
      };
      this.extensionErrors.push(detail);
      throw new ToolRegistryError(detail);
    }
  }

  public registerTool(moduleId: string, tool: TTool): void {
    const module = this.modules.get(moduleId);
    if (!module) {
      const detail: ToolRegistryExtensionError = {
        code: "invalid_module_manifest",
        message: `Cannot register tool ${tool.name} for unknown module ${moduleId}.`,
        moduleId,
        toolName: tool.name,
      };
      this.extensionErrors.push(detail);
      throw new ToolRegistryError(detail);
    }
    validateToolDefinition(tool, module.manifest);
    const existing = this.tools.get(tool.name);
    if (existing) {
      const detail: ToolRegistryExtensionError = {
        code: "duplicate_tool",
        message: `Duplicate tool ${tool.name}: module ${existing.module.id} conflicts with ${moduleId}.`,
        moduleId,
        toolName: tool.name,
        existingSource: `${existing.module.id}@${existing.module.version}`,
        incomingSource: `${module.manifest.id}@${module.manifest.version}`,
      };
      this.extensionErrors.push(detail);
      throw new ToolRegistryError(detail);
    }
    const normalized = normalizeTool(tool, module.manifest);
    let validator: ValidateFunction;
    try {
      validator = this.ajv.compile(normalized.inputSchema);
    } catch (error) {
      const detail: ToolRegistryExtensionError = {
        code: "invalid_tool_definition",
        message: `Invalid input schema for tool ${tool.name} from module ${moduleId}: ${(error as Error).message}`,
        moduleId,
        toolName: tool.name,
      };
      this.extensionErrors.push(detail);
      throw new ToolRegistryError(detail);
    }
    const entry: RegisteredTool<TTool> = {
      module: module.manifest,
      tool: normalized,
      availability: { ...AVAILABLE },
    };
    module.tools.set(normalized.name, entry);
    this.tools.set(normalized.name, entry);
    this.validators.set(normalized.name, validator);
  }

  public getTool(name: string): RegisteredTool<TTool> | undefined {
    return this.tools.get(name);
  }

  public listRegisteredTools(): RegisteredTool<TTool>[] {
    return [...this.tools.values()];
  }

  public listAvailableTools(): RegisteredTool<TTool>[] {
    return this.listRegisteredTools().filter((entry) => entry.availability.available);
  }

  public selectTools(context: ToolSelectionContext): RegisteredTool<TTool>[] {
    return this.selectToolsDetailed(context).tools;
  }

  public selectToolsDetailed(context: ToolSelectionContext): {
    tools: RegisteredTool<TTool>[];
    summary: ToolSelectionSummary;
  } {
    const tools: RegisteredTool<TTool>[] = [];
    const reasonCounts: Record<string, number> = {};
    for (const entry of this.listRegisteredTools()) {
      if (!entry.availability.available) {
        reasonCounts.unavailable = (reasonCounts.unavailable ?? 0) + 1;
        continue;
      }
      if (
        context.permissionMode === "plan" &&
        !entry.tool.readOnly &&
        !(entry.tool.selection?.planModeActions?.length)
      ) {
        reasonCounts.mode_denied = (reasonCounts.mode_denied ?? 0) + 1;
        continue;
      }
      const reason = selectionReason(entry.tool, context);
      if (!reason) continue;
      tools.push(entry);
      reasonCounts[reason] = (reasonCounts[reason] ?? 0) + 1;
    }
    return {
      tools,
      summary: {
        selectedCount: tools.length,
        unselectedCount: this.tools.size - tools.length,
        selectedToolNames: tools.map((entry) => entry.tool.name),
        reasonCounts,
      },
    };
  }

  public setToolAvailability(name: string, availability: ToolAvailability): void {
    const entry = this.tools.get(name);
    if (!entry) throw new Error(`Unknown tool: ${name}`);
    entry.availability = { ...availability };
  }

  public validateArguments(name: string, args: unknown): ToolArgumentValidationResult {
    const validator = this.validators.get(name);
    if (!validator) {
      return {
        valid: false,
        errors: [{ path: "$", message: `No compiled validator is registered for tool ${name}.` }],
      };
    }
    const valid = validator(args);
    const errors = valid ? [] : (validator.errors ?? []).map(formatValidationError);
    return { valid: Boolean(valid), errors };
  }

  public unregisterModule(moduleId: string): void {
    const module = this.modules.get(moduleId);
    if (!module) return;
    for (const toolName of module.tools.keys()) {
      this.tools.delete(toolName);
      this.validators.delete(toolName);
    }
    this.modules.delete(moduleId);
  }

  public recordModuleInitializationFailure(manifest: ToolModuleManifest, error: unknown): void {
    this.extensionErrors.push({
      code: "module_initialization_failed",
      message: `Tool module ${manifest.id} failed to initialize: ${(error as Error).message}`,
      moduleId: manifest.id,
      incomingSource: `${manifest.id}@${manifest.version}`,
    });
  }

  public listExtensionErrors(): ToolRegistryExtensionError[] {
    return this.extensionErrors.map((error) => ({ ...error }));
  }
}

function formatValidationError(error: ErrorObject): { path: string; message: string } {
  const missingProperty =
    error.keyword === "required" && typeof error.params.missingProperty === "string"
      ? `/${error.params.missingProperty}`
      : "";
  return {
    path: `${error.instancePath || "$"}${missingProperty}`,
    message: error.message ?? `failed ${error.keyword} validation`,
  };
}
