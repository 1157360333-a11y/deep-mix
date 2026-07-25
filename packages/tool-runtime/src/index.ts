import { randomUUID } from "node:crypto";
import { promises as fs } from "node:fs";
import path from "node:path";
import type {
  ApprovalRecord,
  ApprovalPersistence,
  CheckpointRecord,
  DeepMixSettings,
  McpToolDescriptor,
  PermissionMode,
  ProviderToolDefinition,
  RuntimeCapabilitySnapshot,
  SideEffectLevel,
  ToolErrorType,
  ToolExecutionOrigin,
  TimeoutCategory,
  ToolCall,
  ToolAccessRequest,
  ToolDefinition,
  ToolModuleManifest,
  ToolOutputArtifact,
  ToolPermissionCategory,
  ToolPermissionProfile,
  ToolProcessSession,
  ToolActivationRecord,
  ToolSelectionContext,
  ToolSelectionSummary,
  ToolStructuredError,
  ToolResult,
} from "../../shared-schema/src/index.js";
import { SessionStore } from "../../persistence/src/index.js";
import { PermissionLayer } from "../../safety/src/index.js";
import { SpecialistBroker } from "../../specialist-broker/src/index.js";
import { McpRegistry } from "../../mcp-hub/src/index.js";
import { loadDeepMixSettingsSync } from "../../settings/src/index.js";
import {
  detectRuntimeCapabilities,
  RuntimeCapabilityRegistry,
} from "./runtime-capabilities.js";
import { ToolProcessManager } from "./process-manager.js";
import { ToolRegistry } from "./tool-registry.js";
import {
  disposeToolModules,
  initializeToolModules,
  registerToolModules,
  type RuntimeToolExecutionContext,
  type RuntimeToolSpec,
  type ToolModule,
  type ToolModuleContext,
} from "./tool-module.js";
import { builtInToolModules } from "./built-ins/index.js";
import {
  createDirectToolNetworkService,
  type ToolNetworkService,
} from "./network/index.js";
import { createSafeNetworkDeadline, SafeNetworkError } from "./network/safe-http.js";
import { isProtectedReadPath } from "./repository-explorer.js";

type PostEditVerificationToolName = "run_tests" | "lint" | "typecheck";
type PostEditVerificationParentName = "apply_patch" | "apply_artifact_patch";

interface ExecutionParentLink {
  callId: string;
  toolName: PostEditVerificationParentName;
}

interface ToolAuditLink {
  executionOrigin?: ToolExecutionOrigin;
  parentCallId?: string;
  parentToolName?: string;
}

const POST_EDIT_VERIFICATION_TOOL_NAMES = new Set<string>(["run_tests", "lint", "typecheck"]);

const EXPERIMENTAL_MANAGED_PROCESS_TOOL_NAMES = new Set<string>([
  "start_process",
  "process_input",
  "process_output",
  "stop_process",
]);

const MANAGED_PROCESS_DISABLED_REASON =
  "Managed background processes are experimental and disabled by default. " +
  "Set experimental.managedProcesses=true only after reviewing docs/security-model.md.";

export class PermissionRequiredError extends Error {
  public readonly toolName: string;

  public readonly approvalId: string;

  public readonly requestKey: string;

  public readonly permissionCategory: ToolPermissionCategory;

  public readonly approvalRecord?: ApprovalRecord;

  public constructor(
    toolName: string,
    approvalId: string,
    requestKey: string,
    permissionCategory: ToolPermissionCategory,
    message: string,
    approvalRecord?: ApprovalRecord,
  ) {
    super(message);
    this.name = "PermissionRequiredError";
    this.toolName = toolName;
    this.approvalId = approvalId;
    this.requestKey = requestKey;
    this.permissionCategory = permissionCategory;
    this.approvalRecord = approvalRecord;
  }
}

export class ToolArgumentError extends Error {
  public readonly fieldPath?: string;

  public readonly details?: Array<{ path: string; message: string }>;

  public constructor(
    message: string,
    options?: { fieldPath?: string; details?: Array<{ path: string; message: string }> },
  ) {
    super(message);
    this.name = "ToolArgumentError";
    this.fieldPath = options?.fieldPath;
    this.details = options?.details;
  }
}

export interface RuntimeOptions {
  workspaceRoot: string;
  sessionStore: SessionStore;
  permissionMode: PermissionMode;
  environment?: NodeJS.ProcessEnv;
  settings?: DeepMixSettings;
  networkService?: ToolNetworkService;
  specialistBroker?: SpecialistBroker;
  mcpRegistry?: McpRegistry;
  mcpExecutor?: (args: {
    server: string;
    tool: string;
    input?: unknown;
  }) => Promise<{
    output: string;
    structuredContent?: unknown;
  }>;
  registry?: ToolRegistry<RuntimeToolSpec>;
  modules?: readonly ToolModule[];
  processManager?: ToolProcessManager;
}

export interface ToolListOptions extends ToolSelectionContext {
  includeAllMcpTools?: boolean;
}

export interface SelectedToolSet {
  definitions: ToolDefinition[];
  providerTools: ProviderToolDefinition[];
  summary: ToolSelectionSummary;
}

export interface ActiveToolSelectionLeaseState {
  providerCycle: number;
  leaseIds: string[];
  toolNames: string[];
  estimatedSchemaTokens: number;
}

function now(): string {
  return new Date().toISOString();
}

const PROMPT_ATTACHMENT_EXTENSIONS = [
  "pdf", "docx",
  "xlsx", "csv", "tsv",
  "pptx", "ipynb",
  "png", "jpg", "jpeg", "webp", "gif", "tif", "tiff",
  "zip", "tar", "gz", "gzip",
] as const;

const PHASE20_RICH_DOCUMENT_TOOL_NAMES = new Set([
  "read_spreadsheet",
  "write_spreadsheet",
  "read_presentation",
  "write_presentation",
  "read_notebook",
  "edit_notebook",
  "read_image",
  "archive_manage",
  "convert_document",
]);

const PROMPT_ATTACHMENT_MIME_ALIASES = new Map<string, string>([
  ["application/pdf", "application/pdf"],
  ["application/vnd.openxmlformats-officedocument.wordprocessingml.document", "application/vnd.openxmlformats-officedocument.wordprocessingml.document"],
  ["application/vnd.openxmlformats-officedocument.spreadsheetml.sheet", "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet"],
  ["text/csv", "text/csv"],
  ["application/csv", "text/csv"],
  ["text/tab-separated-values", "text/tab-separated-values"],
  ["application/vnd.openxmlformats-officedocument.presentationml.presentation", "application/vnd.openxmlformats-officedocument.presentationml.presentation"],
  ["application/x-ipynb+json", "application/x-ipynb+json"],
  ["image/png", "image/png"],
  ["image/jpeg", "image/jpeg"],
  ["image/webp", "image/webp"],
  ["image/gif", "image/gif"],
  ["image/tif", "image/tiff"],
  ["image/tiff", "image/tiff"],
  ["application/zip", "application/zip"],
  ["application/x-zip-compressed", "application/zip"],
  ["application/x-tar", "application/x-tar"],
  ["application/gzip", "application/gzip"],
  ["application/x-gzip", "application/gzip"],
]);

const PROMPT_ATTACHMENT_EXTENSION_PATTERN = new RegExp(
  `\\.(${PROMPT_ATTACHMENT_EXTENSIONS.join("|")})(?=\\b|[\\]\\)"'])`,
  "giu",
);

function normalizedAttachmentExtension(value: string): string {
  const normalized = value.trim().toLocaleLowerCase();
  if (!normalized) return normalized;
  return normalized.startsWith(".") ? normalized : `.${normalized}`;
}

function normalizedAttachmentMimeType(value: string): string {
  const normalized = value.split(";", 1)[0]!.trim().toLocaleLowerCase();
  return PROMPT_ATTACHMENT_MIME_ALIASES.get(normalized) ?? normalized;
}

function inferPromptAttachmentExtensions(prompt: string): string[] {
  return [...prompt.matchAll(PROMPT_ATTACHMENT_EXTENSION_PATTERN)]
    .map((match) => normalizedAttachmentExtension(match[1]!));
}

function inferPromptAttachmentMimeTypes(prompt: string): string[] {
  const normalizedPrompt = prompt.toLocaleLowerCase();
  return [...PROMPT_ATTACHMENT_MIME_ALIASES.entries()]
    .filter(([alias]) => normalizedPrompt.includes(alias))
    .map(([, canonical]) => canonical);
}

function hasCodingImplementationIntent(prompt: string): boolean {
  const normalized = prompt.toLocaleLowerCase();
  const mentionsCodeArtifact = /\b(?:code|parser|parsing\s+library|library|script|program|function|class|interface|api|cli|typescript|javascript|node(?:\.js)?|python|rust|golang|java|vitest|jest|unit\s+tests?|repository|codebase)\b|代码|解析器|程序|脚本|函数|接口|代码库|仓库|单元测试/u.test(normalized);
  const requestsCodingWork = /\b(?:write|create|build|implement|develop|refactor|debug|fix|test|add)\b|编写|创建|实现|开发|修复|调试|重构|测试|新增|添加/u.test(normalized);
  const hasStrongCodingContext = /\b(?:typescript|javascript|node(?:\.js)?|python|rust|golang|java|vitest|jest|unit\s+tests?|repository|codebase)\b|代码|解析器|代码库|仓库|单元测试/u.test(normalized);
  return mentionsCodeArtifact && (requestsCodingWork || hasStrongCodingContext);
}

function promptSelectionReason(
  definition: ToolDefinition,
  prompt: string,
): "keyword_match" | "keyword_group_match" | undefined {
  const normalizedPrompt = prompt.toLocaleLowerCase();
  if (definition.selection?.keywords?.some(
    (keyword) => normalizedPrompt.includes(keyword.toLocaleLowerCase()),
  )) return "keyword_match";
  if (definition.selection?.keywordGroups?.some((group) =>
    group.length > 0 && group.every((keyword) => normalizedPrompt.includes(keyword.toLocaleLowerCase())))) {
    return "keyword_group_match";
  }
  return undefined;
}

function hasExplicitDocumentWriteIntent(prompt: string): boolean {
  const normalized = prompt.toLocaleLowerCase();
  const mentionsDocument = /pdf|docx|word\s*(?:document|file)?|spreadsheet|workbook|xlsx|csv|tsv|presentation|powerpoint|pptx|notebook|jupyter|ipynb|image|png|jpe?g|webp|gif|tiff?|archive|zip|tar|gzip|word文档|word文件|表格|电子表格|工作簿|演示文稿|幻灯片|笔记本|图片|图像|压缩包|归档/u.test(normalized);
  const requestsWrite = /\b(?:write|create|generate|export|save|overwrite|modify|update|rewrite|edit|convert)\b|生成|创建|导出|保存|输出|写入|覆盖|修改|更新|重写|制作|编辑|转换|转为|压缩/u.test(
    normalized,
  );
  return mentionsDocument && requestsWrite;
}

/** Deterministic phase-17 intent hints keep complete lifecycle/quality tool sets in the Provider boundary. */
export function inferProcessAndQualityToolNames(prompt: string): string[] {
  const normalized = prompt.toLocaleLowerCase();
  const requested = new Set<string>();
  if (
    /\b(?:dev(?:elopment)?\s+server|watch(?:er|\s+mode)?|background\s+process|interactive\s+(?:command|shell)|long[- ]running\s+process|start\s+(?:the\s+)?server|listener)\b/u.test(normalized) ||
    /后台进程|开发服务器|监听器|监视模式|交互(?:命令|进程|shell)|启动(?:本地)?服务/u.test(normalized)
  ) {
    for (const name of ["start_process", "process_input", "process_output", "stop_process"]) requested.add(name);
  }
  if (/\b(?:build|compile|bundle)\b|构建|编译/u.test(normalized)) requested.add("build");
  if (/\b(?:format(?:ter|ting)?|prettier)\b|格式化|格式检查/u.test(normalized)) requested.add("format");
  if (/\b(?:test\s+coverage|coverage(?:\s+threshold)?)\b|测试覆盖率|覆盖率/u.test(normalized)) {
    requested.add("test_coverage");
  }
  if (
    /\b(?:inspect|analyse|analyze|review|parse)\s+(?:the\s+)?logs?\b|\berror\s+logs?\b|日志(?:检查|分析|审查|解析)|错误日志/u.test(normalized)
  ) {
    requested.add("inspect_logs");
  }
  return [...requested];
}

function projectToolForPermissionMode(
  definition: ToolDefinition,
  permissionMode: PermissionMode,
): ToolDefinition {
  const planModeActions = definition.selection?.planModeActions;
  if (permissionMode !== "plan" || !planModeActions || planModeActions.length === 0) {
    return definition;
  }
  const properties = definition.inputSchema.properties as Record<string, unknown> | undefined;
  const action = properties?.action as Record<string, unknown> | undefined;
  if (!properties || !action || !Array.isArray(action.enum)) return definition;
  const allowed = new Set(planModeActions);
  return {
    ...definition,
    inputSchema: {
      ...definition.inputSchema,
      properties: {
        ...properties,
        action: {
          ...action,
          enum: action.enum.filter((value): value is string => typeof value === "string" && allowed.has(value)),
        },
      },
    },
  };
}

function normalizeRelativePath(targetPath: string): string {
  return targetPath.replace(/\\/g, "/");
}

function toWorkspaceRelativePath(workspaceRoot: string, targetPath: string): string {
  const relative = normalizeRelativePath(path.relative(workspaceRoot, targetPath));
  return relative || ".";
}

function resolveInsideWorkspace(workspaceRoot: string, inputPath: string): string {
  const absolutePath = path.resolve(workspaceRoot, inputPath);
  const relative = path.relative(workspaceRoot, absolutePath);
  if (relative.startsWith("..") || path.isAbsolute(relative)) {
    throw new Error(
      `Path escapes workspace root (${workspaceRoot}): ${inputPath}. Retry with '.' or a path relative to the current workspace.`,
    );
  }
  return absolutePath;
}

async function resolveRealPathInside(root: string, targetPath: string, label: string): Promise<string> {
  const [realRoot, realTarget] = await Promise.all([fs.realpath(root), fs.realpath(targetPath)]);
  const relative = path.relative(realRoot, realTarget);
  if (relative.startsWith("..") || path.isAbsolute(relative)) {
    throw new Error(`${label} escapes its trusted root.`);
  }
  return realTarget;
}

const MCP_RUNTIME_MANIFEST: ToolModuleManifest = {
  id: "mcp.runtime",
  version: "1.0.0",
  description: "Dynamic MCP descriptors mediated by the Tool Runtime.",
  source: "mcp",
};

function createStructuredError(input: {
  type: ToolErrorType;
  message: string;
  retryable: boolean;
  toolName: string;
  path?: string;
  cwd?: string;
  dependency?: string;
  command?: string;
  exitCode?: number;
  stdout?: string;
  stderr?: string;
  fieldPath?: string;
  details?: Array<{ path: string; message: string }>;
}): ToolStructuredError {
  return {
    type: input.type,
    message: input.message,
    retryable: input.retryable,
    toolName: input.toolName,
    path: input.path,
    cwd: input.cwd,
    dependency: input.dependency,
    command: input.command,
    exitCode: input.exitCode,
    stdout: input.stdout,
    stderr: input.stderr,
    fieldPath: input.fieldPath,
    details: input.details,
  };
}

function serializeStructuredFailure(
  error: ToolStructuredError,
  structuredContent?: Record<string, unknown>,
): string {
  return JSON.stringify({
    ...structuredContent,
    error,
  });
}

function buildFailureToolResult(
  toolName: string,
  startedAt: string,
  error: ToolStructuredError,
  callId?: string,
  structuredContent?: Record<string, unknown>,
): ToolResult {
  const failureBody = {
    ...structuredContent,
    error,
  };
  return {
    toolName,
    callId: callId ?? randomUUID(),
    startedAt,
    endedAt: now(),
    success: false,
    output: JSON.stringify(failureBody),
    structuredContent: failureBody,
    error: error.message,
  };
}

function classifyException(
  toolName: string,
  error: unknown,
  details?: {
    command?: string;
    cwd?: string;
    targetPath?: string;
  },
): ToolStructuredError {
  const value = error as NodeJS.ErrnoException;
  if (error instanceof SafeNetworkError) {
    return createStructuredError({
      type: error.networkErrorType === "timeout"
        ? "timeout"
        : "network_error",
      message: error.message,
      retryable: error.retryable,
      toolName,
    });
  }
  if (error instanceof ToolArgumentError) {
    return createStructuredError({
      type: "invalid_arguments",
      message: error.message,
      retryable: false,
      toolName,
      fieldPath: error.fieldPath,
      details: error.details,
    });
  }
  const explicitTypeByCode = {
    ERR_TOOL_INVALID_ARGUMENTS: "invalid_arguments",
    ERR_TOOL_MISSING_DEPENDENCY: "missing_dependency",
    ERR_TOOL_NOT_FOUND: "not_found",
    ERR_TOOL_CORRUPT_RECORD: "corrupt_record",
    ERR_TOOL_PERMISSION_DENIED: "permission_denied",
    ERR_TOOL_UNAVAILABLE: "unavailable",
    ERR_TOOL_UNSUPPORTED_PROTOCOL: "unsupported_protocol",
    ERR_TOOL_CONFLICTED: "conflicted",
  } as const;
  const explicitType = explicitTypeByCode[value.code as keyof typeof explicitTypeByCode];
  if (explicitType) {
    return createStructuredError({
      type: explicitType,
      message: value.message,
      retryable: explicitType === "unavailable",
      toolName,
      command: details?.command,
      cwd: details?.cwd,
    });
  }
  if (
    value.message.includes("Path escapes workspace root") ||
    value.message.includes("escapes its trusted root") ||
    value.message.includes("escapes trusted state root")
  ) {
    return createStructuredError({
      type: "invalid_path",
      message: value.message,
      retryable: false,
      toolName,
      path: details?.targetPath,
      cwd: details?.cwd,
    });
  }
  if (
    value.message.includes("outside the writable sandbox") ||
    value.message.includes("outside the sandbox") ||
    value.message.includes("outside the readable sandbox") ||
    value.message.includes("Network access is disabled by the permission policy")
  ) {
    return createStructuredError({
      type: "sandbox_denied",
      message: value.message,
      retryable: false,
      toolName,
      path: details?.targetPath,
      cwd: details?.cwd,
    });
  }
  if (value.code === "ENOENT" || value.code === "ENOTDIR" || value.code === "EISDIR") {
    return createStructuredError({
      type: "invalid_path",
      message: value.message,
      retryable: false,
      toolName,
      path: details?.targetPath,
      cwd: details?.cwd,
    });
  }
  return createStructuredError({
    type: "command_failed",
    message: value.message,
    retryable: true,
    toolName,
    path: details?.targetPath,
    cwd: details?.cwd,
    command: details?.command,
  });
}
export class ToolRuntime {
  private readonly workspaceRoot: string;

  private readonly sessionStore: SessionStore;

  private readonly permissionMode: PermissionMode;

  private readonly environment: NodeJS.ProcessEnv;

  private readonly settings: DeepMixSettings;

  private readonly networkService: ToolNetworkService;

  private readonly processManager: ToolProcessManager;

  private readonly specialistBroker?: SpecialistBroker;

  private readonly permissionLayer: PermissionLayer;

  private readonly mcpRegistry?: McpRegistry;

  private readonly mcpExecutor?: RuntimeOptions["mcpExecutor"];

  private readonly registry: ToolRegistry<RuntimeToolSpec>;

  private readonly modules: readonly ToolModule[];

  private readonly moduleContext: ToolModuleContext;

  private readonly capabilityRegistry = new RuntimeCapabilityRegistry();

  private readonly mcpToolNames = new Set<string>();

  private readonly activeApprovalResolutions = new Set<string>();

  private capabilitySnapshot?: RuntimeCapabilitySnapshot;

  private initializationPromise?: Promise<void>;

  public constructor(options: RuntimeOptions) {
    this.workspaceRoot = options.workspaceRoot;
    this.sessionStore = options.sessionStore;
    this.permissionMode = options.permissionMode;
    this.environment = options.environment ?? process.env;
    this.settings = options.settings ?? loadDeepMixSettingsSync(this.workspaceRoot, {
      collectErrors: true,
    }).settings;
    this.networkService = options.networkService ?? createDirectToolNetworkService();
    this.processManager = options.processManager ?? new ToolProcessManager({
      workspaceRoot: this.workspaceRoot,
      environment: this.environment,
      assertSession: async (sessionId) => {
        const session = await this.sessionStore.loadSession(sessionId);
        return Boolean(
          session &&
          session.status !== "completed" &&
          session.status !== "failed" &&
          session.status !== "interrupted",
        );
      },
    });
    this.specialistBroker = options.specialistBroker;
    this.mcpRegistry = options.mcpRegistry;
    this.mcpExecutor = options.mcpExecutor;
    this.permissionLayer = new PermissionLayer(this.workspaceRoot, this.permissionMode, this.sessionStore);
    this.registry = options.registry ?? new ToolRegistry<RuntimeToolSpec>();
    this.modules = options.registry && options.modules === undefined ? [] : (options.modules ?? builtInToolModules);
    this.moduleContext = this.createModuleContext();
    if (this.modules.length > 0) {
      registerToolModules(this.registry, this.modules, this.moduleContext);
    }
    this.registerMcpTools();
    this.applyExperimentalToolAvailability();
  }

  public async initialize(): Promise<void> {
    if (this.initializationPromise) return this.initializationPromise;
    this.initializationPromise = (async () => {
      await this.processManager.initialize();
      const snapshot = await detectRuntimeCapabilities(this.environment, this.capabilityRegistry);
      this.capabilitySnapshot = snapshot;
      this.applyCapabilityAvailability(snapshot);
      await this.sessionStore.saveRuntimeCapabilities(snapshot);
      await initializeToolModules(this.registry, this.modules, this.moduleContext);
      await this.refreshDeclaredToolAvailability();
      this.applyExperimentalToolAvailability();
    })().catch((error) => {
      this.initializationPromise = undefined;
      throw error;
    });
    return this.initializationPromise;
  }

  public async getCapabilitySnapshot(): Promise<RuntimeCapabilitySnapshot> {
    if (!this.capabilitySnapshot) {
      await this.initialize();
    }
    return this.capabilitySnapshot!;
  }

  private async refreshDeclaredToolAvailability(): Promise<void> {
    for (const entry of this.registry.listRegisteredTools()) {
      if (!entry.availability.available || !entry.tool.getAvailability) continue;
      try {
        this.registry.setToolAvailability(entry.tool.name, await entry.tool.getAvailability(this.moduleContext));
      } catch (error) {
        this.registry.setToolAvailability(entry.tool.name, {
          status: "unavailable",
          available: false,
          reason: `Tool availability check failed: ${(error as Error).message}`,
        });
      }
    }
  }

  private applyExperimentalToolAvailability(): void {
    if (this.settings.experimental?.managedProcesses === true) return;
    for (const toolName of EXPERIMENTAL_MANAGED_PROCESS_TOOL_NAMES) {
      if (!this.registry.getTool(toolName)) continue;
      this.registry.setToolAvailability(toolName, {
        status: "unavailable",
        available: false,
        reason: MANAGED_PROCESS_DISABLED_REASON,
      });
    }
  }

  public async dispose(): Promise<void> {
    await this.processManager.dispose();
    await disposeToolModules(this.modules, this.moduleContext);
    await this.networkService.dispose();
  }

  public listManagedProcesses(sessionId?: string): ToolProcessSession[] {
    return this.processManager.list(sessionId);
  }

  public async stopSessionProcesses(
    sessionId: string,
    reason: "session_interrupted" | "runtime_dispose" = "session_interrupted",
  ): Promise<void> {
    await this.processManager.stopSession(sessionId, reason);
  }

  private createModuleContext(): ToolModuleContext {
    return {
      workspaceRoot: this.workspaceRoot,
      permissionMode: this.permissionMode,
      settings: this.settings,
      network: this.networkService,
      persistence: this.sessionStore,
      capabilities: {
        get: async (name) => {
          const snapshot = await this.getCapabilitySnapshot();
          return snapshot.capabilities[name as keyof typeof snapshot.capabilities];
        },
        list: async () => {
          const snapshot = await this.getCapabilitySnapshot();
          return { ...snapshot.capabilities };
        },
        listRegisteredNames: () =>
          this.capabilityRegistry.listDefinitions().map((definition) => definition.name),
        loadSnapshot: async () =>
          this.capabilitySnapshot ?? await this.sessionStore.loadRuntimeCapabilities(),
        registerProbe: (definition) => this.capabilityRegistry.registerProbe(definition),
      },
      processes: this.processManager,
      paths: {
        normalize: normalizeRelativePath,
        resolveWorkspace: (relativePath) => resolveInsideWorkspace(this.workspaceRoot, relativePath),
        resolveReadable: async (refOrPath) => {
          if (refOrPath.startsWith("artifact://tool-outputs/") || refOrPath.startsWith("file://")) {
            const absolutePath = path.resolve(this.sessionStore.resolveToolOutputArtifactPath(refOrPath));
            const trustedRoot = refOrPath.startsWith("file://")
              ? this.workspaceRoot
              : path.resolve(this.workspaceRoot, ".deep-mix", "tool-outputs");
            if (refOrPath.startsWith("file://")) {
              const workspaceRelativePath = toWorkspaceRelativePath(this.workspaceRoot, absolutePath);
              if (isProtectedReadPath(workspaceRelativePath)) {
                throw new Error("The requested workspace path is outside the readable sandbox because it is protected.");
              }
            }
            const realPath = await resolveRealPathInside(trustedRoot, absolutePath, "Readable artifact path");
            if (refOrPath.startsWith("file://")) {
              const realWorkspaceRoot = await fs.realpath(this.workspaceRoot);
              const canonicalRelativePath = toWorkspaceRelativePath(realWorkspaceRoot, realPath);
              if (isProtectedReadPath(canonicalRelativePath)) {
                throw new Error("The requested workspace path is outside the readable sandbox because its canonical target is protected.");
              }
            }
            return {
              absolutePath: realPath,
              artifactRef: refOrPath.startsWith("artifact://") ? refOrPath : undefined,
              workspaceRelativePath: refOrPath.startsWith("file://")
                ? toWorkspaceRelativePath(this.workspaceRoot, absolutePath)
                : undefined,
              readBytes: () => refOrPath.startsWith("artifact://tool-outputs/")
                ? this.sessionStore.readBinaryToolOutputArtifact(refOrPath)
                : fs.readFile(realPath),
            };
          }
          if (refOrPath.startsWith("artifact://")) {
            const absolutePath = path.resolve(this.sessionStore.resolveArtifactPath(refOrPath));
            const trustedRoot = path.resolve(this.workspaceRoot, ".deep-mix");
            const realPath = await resolveRealPathInside(trustedRoot, absolutePath, "Readable artifact path");
            return { absolutePath: realPath, artifactRef: refOrPath, readBytes: () => fs.readFile(realPath) };
          }
          const absolutePath = resolveInsideWorkspace(this.workspaceRoot, refOrPath);
          const workspaceRelativePath = toWorkspaceRelativePath(this.workspaceRoot, absolutePath);
          if (isProtectedReadPath(workspaceRelativePath)) {
            throw new Error("The requested workspace path is outside the readable sandbox because it is protected.");
          }
          const realPath = await resolveRealPathInside(this.workspaceRoot, absolutePath, "Readable workspace path");
          const realWorkspaceRoot = await fs.realpath(this.workspaceRoot);
          const canonicalRelativePath = toWorkspaceRelativePath(realWorkspaceRoot, realPath);
          if (isProtectedReadPath(canonicalRelativePath)) {
            throw new Error("The requested workspace path is outside the readable sandbox because its canonical target is protected.");
          }
          return {
            absolutePath: realPath,
            workspaceRelativePath,
            readBytes: () => fs.readFile(realPath),
          };
        },
      },
      permissions: {
        assertNetworkHosts: (hosts) => this.permissionLayer.assertNetworkHosts(hosts),
      },
      tools: {
        executeManual: (name, args, sessionId) => this.executeManualTool(name, args, sessionId),
        listRegistered: () => this.registry.listRegisteredTools().map((entry) => ({
          module: { ...entry.module },
          definition: this.toToolDefinition(entry.tool),
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
        })),
      },
      clock: { now },
      ids: { create: randomUUID },
      environment: this.environment,
      optional: {
        workers: this.specialistBroker
          ? {
              invokeCodingWorker: (input) => this.specialistBroker!.invokeCodingWorker(input),
              invokeVisionWorker: (input) => this.specialistBroker!.invokeVisionWorker(input),
              getWorkerStatus: (parentSessionId, workerSessionId) =>
                this.specialistBroker!.getWorkerStatus(parentSessionId, workerSessionId),
              getWorkerPublicOutput: (parentSessionId, workerSessionId) =>
                this.specialistBroker!.getWorkerPublicOutput(parentSessionId, workerSessionId),
              previewWorkerCancellation: (parentSessionId, workerSessionId) =>
                this.specialistBroker!.previewWorkerCancellation(parentSessionId, workerSessionId),
              cancelOwnedWorkerSession: (input) => this.specialistBroker!.cancelOwnedWorkerSession(input),
            }
          : undefined,
        mcpRegistry: this.mcpRegistry,
        mcpExecutor: this.mcpExecutor,
      },
    };
  }

  private applyCapabilityAvailability(snapshot: RuntimeCapabilitySnapshot): void {
    for (const entry of this.registry.listRegisteredTools()) {
      if (!entry.availability.available || !entry.tool.capabilityRequirements?.length) continue;
      const missingRequired = entry.tool.capabilityRequirements
        .filter((requirement) => requirement.required && !snapshot.capabilities[requirement.name]?.available)
        .map((requirement) => requirement.name);
      if (missingRequired.length > 0) {
        this.registry.setToolAvailability(entry.tool.name, {
          status: "unavailable",
          available: false,
          missingCapabilities: missingRequired,
          reason: `Missing required capabilities: ${missingRequired.join(", ")}.`,
        });
        continue;
      }
      const fallbacks = entry.tool.capabilityRequirements
        .filter((requirement) => !requirement.required && !snapshot.capabilities[requirement.name]?.available)
        .map((requirement) => requirement.fallback)
        .filter((fallback): fallback is string => Boolean(fallback));
      if (fallbacks.length > 0) {
        this.registry.setToolAvailability(entry.tool.name, {
          status: "degraded",
          available: true,
          fallbackCapabilities: fallbacks,
          warnings: [`Using built-in fallback: ${fallbacks.join(", ")}.`],
        });
      }
    }
  }

  private toToolDefinition(tool: RuntimeToolSpec): ToolDefinition {
    return {
      name: tool.name,
      description: tool.description,
      inputSchema: tool.inputSchema,
      readOnly: tool.readOnly,
      permissionCategory: tool.permissionCategory,
      sideEffectLevel: tool.sideEffectLevel,
      timeoutCategory: tool.timeoutCategory,
      moduleId: tool.moduleId,
      moduleVersion: tool.moduleVersion,
      version: tool.version,
      displayName: tool.displayName,
      groups: tool.groups,
      selection: tool.selection,
      capabilityRequirements: tool.capabilityRequirements,
      checkpoint: tool.checkpoint,
    };
  }

  public listRegisteredToolDefinitions(): ToolDefinition[] {
    return this.registry.listRegisteredTools().map(({ tool }) => this.toToolDefinition(tool));
  }

  public listAvailableToolDefinitions(): ToolDefinition[] {
    return this.registry.listAvailableTools().map(({ tool }) => this.toToolDefinition(tool));
  }

  public selectToolsForTurn(options: ToolListOptions = {}): SelectedToolSet {
    const prompt = options.prompt ?? "";
    const phase17ToolNames = inferProcessAndQualityToolNames(prompt);
    const desktopAttachmentPrompt = prompt.includes("[Desktop attachments]");
    const codingImplementationIntent = hasCodingImplementationIntent(prompt);
    const inferPathAsInput = desktopAttachmentPrompt || (
      !hasExplicitDocumentWriteIntent(prompt) && !codingImplementationIntent
    );
    const inferredExtensions = inferPathAsInput
      ? inferPromptAttachmentExtensions(prompt)
      : [];
    const inferredMimeTypes = inferPathAsInput ? inferPromptAttachmentMimeTypes(prompt) : [];
    const attachmentExtensions = [...new Set([
      ...(options.attachmentExtensions ?? []).map(normalizedAttachmentExtension),
      ...inferredExtensions,
    ])];
    const attachmentMimeTypes = [...new Set([
      ...(options.attachmentMimeTypes ?? []).map(normalizedAttachmentMimeType),
      ...inferredMimeTypes,
    ])].filter((mimeType) => mimeType !== "application/json" || attachmentExtensions.includes(".ipynb"));
    const injectedMcpTools = this.mcpRegistry
      ? options.includeAllMcpTools
        ? [...this.mcpToolNames]
        : this.mcpRegistry.listInjectedToolDescriptors(prompt).map((tool) => tool.name)
      : [];
    const selectionContext: ToolSelectionContext = {
      ...options,
      attachmentExtensions,
      attachmentMimeTypes,
      requestedToolNames: [
        ...(options.requestedToolNames ?? []),
        ...phase17ToolNames,
        ...injectedMcpTools,
      ],
      permissionMode: this.permissionMode,
    };
    const initialSelection = this.registry.selectToolsDetailed(selectionContext);
    const selection = codingImplementationIntent
      ? (() => {
          const promptIndependentToolNames = new Set(
            this.registry.selectToolsDetailed({ ...selectionContext, prompt: "" }).tools
              .map(({ tool }) => tool.name),
          );
          const removed = initialSelection.tools.filter(({ tool }) =>
            PHASE20_RICH_DOCUMENT_TOOL_NAMES.has(tool.name) && !promptIndependentToolNames.has(tool.name));
          if (removed.length === 0) return initialSelection;
          const tools = initialSelection.tools.filter(({ tool }) => !removed.some(
            ({ tool: removedTool }) => removedTool.name === tool.name,
          ));
          const reasonCounts = { ...initialSelection.summary.reasonCounts };
          for (const { tool } of removed) {
            const reason = promptSelectionReason(tool, prompt);
            if (!reason || !reasonCounts[reason]) continue;
            reasonCounts[reason] -= 1;
            if (reasonCounts[reason] === 0) delete reasonCounts[reason];
          }
          reasonCounts.coding_context_suppressed = removed.length;
          return {
            tools,
            summary: {
              selectedCount: tools.length,
              unselectedCount: this.registry.listRegisteredTools().length - tools.length,
              selectedToolNames: tools.map(({ tool }) => tool.name),
              reasonCounts,
            },
          };
        })()
      : initialSelection;
    const definitions = selection.tools.map(({ tool }) =>
      projectToolForPermissionMode(this.toToolDefinition(tool), this.permissionMode));
    return {
      definitions,
      providerTools: definitions.map((tool) => ({
        type: "function",
        function: {
          name: tool.name,
          description: tool.description,
          parameters: tool.inputSchema,
        },
      })),
      summary: selection.summary,
    };
  }

  public listToolDefinitions(options?: ToolListOptions): ToolDefinition[] {
    return options ? this.selectToolsForTurn(options).definitions : this.listRegisteredToolDefinitions();
  }

  public listProviderTools(options?: ToolListOptions): ProviderToolDefinition[] {
    return this.selectToolsForTurn(options).providerTools;
  }

  public async loadActiveToolSelectionLeases(
    sessionId: string,
    turnId: string,
  ): Promise<ActiveToolSelectionLeaseState> {
    const [session, events] = await Promise.all([
      this.sessionStore.loadSession(sessionId),
      this.sessionStore.loadEvents(sessionId),
    ]);
    const providerCycle = events.filter(
      (event) => event.recordType === "tool_selection" && event.turnId === turnId,
    ).length + 1;
    if (session?.activeTurnId !== turnId) {
      return {
        providerCycle,
        leaseIds: [],
        toolNames: [],
        estimatedSchemaTokens: 0,
      };
    }
    const records = events.filter(
      (event): event is ToolActivationRecord => event.recordType === "tool_activation" && event.turnId === turnId,
    );
    const activeRecords = records.filter((record) =>
      record.lease &&
      record.lease.firstProviderCycle <= providerCycle &&
      providerCycle <= record.lease.expiresAfterProviderCycle);
    const toolNames = [...new Set(activeRecords.flatMap((record) => record.lease?.toolNames ?? []))];
    const definitions = new Map(this.listRegisteredToolDefinitions().map((definition) => [definition.name, definition]));
    const estimatedSchemaTokens = toolNames.reduce((total, name) => {
      const definition = definitions.get(name);
      return total + (definition ? Math.ceil(JSON.stringify(definition.inputSchema).length / 4) : 0);
    }, 0);
    return {
      providerCycle,
      leaseIds: activeRecords.flatMap((record) => record.lease ? [record.lease.leaseId] : []),
      toolNames,
      estimatedSchemaTokens,
    };
  }

  public async executeTool(
    call: ToolCall,
    sessionId: string,
    options: { turnId?: string; signal?: AbortSignal } = {},
  ): Promise<ToolResult> {
    return this.executeResolvedTool(call, sessionId, {
      turnId: options.turnId,
      signal: options.signal,
      executionOrigin: "direct",
    });
  }

  public async executeManualTool(
    name: string,
    args: unknown,
    sessionId: string,
    options: { turnId?: string; signal?: AbortSignal } = {},
  ): Promise<ToolResult> {
    return this.executeResolvedTool(
      {
        id: randomUUID(),
        name,
        arguments: args,
        rawArguments: JSON.stringify(args),
      },
      sessionId,
      {
        turnId: options.turnId,
        signal: options.signal,
        executionOrigin: "direct",
      },
    );
  }

  private async executePostEditVerificationTool(
    name: PostEditVerificationToolName,
    args: unknown,
    sessionId: string,
    options: {
      parent: ExecutionParentLink;
      turnId?: string;
      signal?: AbortSignal;
    },
  ): Promise<ToolResult> {
    if (!POST_EDIT_VERIFICATION_TOOL_NAMES.has(name)) {
      throw new Error(`Unsupported post-edit verification tool: ${String(name)}.`);
    }
    if (options.parent.toolName !== "apply_patch" && options.parent.toolName !== "apply_artifact_patch") {
      throw new Error(`Unsupported post-edit verification parent: ${String(options.parent.toolName)}.`);
    }
    return this.executeResolvedTool(
      {
        id: randomUUID(),
        name,
        arguments: args,
        rawArguments: JSON.stringify(args),
      },
      sessionId,
      {
        turnId: options.turnId,
        signal: options.signal,
        executionOrigin: "runtime_post_edit_verification",
        executionParent: options.parent,
      },
    );
  }

  public redactToolCallForPersistence(call: ToolCall): ToolCall {
    const tool = this.registry.getTool(call.name)?.tool;
    if (!tool?.redactArguments) return call;
    try {
      if (!this.registry.validateArguments(call.name, call.arguments).valid) {
        const failClosed = { redacted: true };
        return {
          ...call,
          arguments: failClosed,
          rawArguments: JSON.stringify(failClosed),
        };
      }
      const safeArguments = tool.redactArguments(call.arguments);
      if (safeArguments === call.arguments) return call;
      return {
        ...call,
        arguments: safeArguments,
        rawArguments: JSON.stringify(safeArguments),
      };
    } catch {
      return {
        ...call,
        arguments: { redacted: true },
        rawArguments: JSON.stringify({ redacted: true }),
      };
    }
  }

  public refreshMcpTools(): void {
    this.registry.unregisterModule(MCP_RUNTIME_MANIFEST.id);
    this.mcpToolNames.clear();
    this.registerMcpTools();
  }

  public async resolveApproval(input: {
    sessionId: string;
    approvalId: string;
    toolName: string;
    requestKey: string;
    persistence: Extract<ApprovalPersistence, "allow_once" | "allow_session" | "deny">;
    reason: string;
  }): Promise<ApprovalRecord> {
    if (!(new Set(["allow_once", "allow_session", "deny"])).has(input.persistence)) {
      throw new Error("Approval persistence decision is invalid.");
    }
    const resolutionKey = `${input.sessionId}:${input.approvalId}`;
    if (this.activeApprovalResolutions.has(resolutionKey)) {
      throw new Error(`Approval ${input.approvalId} is already being resolved.`);
    }
    this.activeApprovalResolutions.add(resolutionKey);
    try {
      if (!this.registry.getTool(input.toolName)) {
        throw new Error(`Unknown tool for approval resolution: ${input.toolName}`);
      }
      const latestApproval = [...(await this.sessionStore.loadEvents(input.sessionId))]
        .reverse()
        .find((event): event is ApprovalRecord =>
          event.recordType === "approval" && event.approvalId === input.approvalId);
      if (!latestApproval || latestApproval.status !== "pending") {
        throw new Error(`Approval ${input.approvalId} is not pending for this session.`);
      }
      if (latestApproval.toolName !== input.toolName || latestApproval.requestKey !== input.requestKey) {
        throw new Error(`Approval ${input.approvalId} does not match the requested tool operation.`);
      }
      const permissionCategory = latestApproval.permissionCategory;
      const grant = await this.permissionLayer.resolveApproval({
        approvalId: input.approvalId,
        sessionId: input.sessionId,
        toolName: input.toolName,
        permissionCategory,
        requestKey: input.requestKey,
        persistence: input.persistence,
        reason: input.reason,
      });
      const record: ApprovalRecord = {
        recordType: "approval",
        approvalId: input.approvalId,
        sessionId: input.sessionId,
        createdAt: grant.createdAt,
        toolName: input.toolName,
        permissionCategory,
        requestKey: input.requestKey,
        decision: grant.decision,
        reason: input.reason,
        status: "resolved",
        persistence: input.persistence,
        executionOrigin: latestApproval.executionOrigin,
        parentCallId: latestApproval.parentCallId,
        parentToolName: latestApproval.parentToolName,
      };
      await this.sessionStore.recordApproval(record);
      return record;
    } finally {
      this.activeApprovalResolutions.delete(resolutionKey);
    }
  }

  private async executeResolvedTool(
    call: ToolCall,
    sessionId: string,
    options: {
      turnId?: string;
      signal?: AbortSignal;
      executionOrigin?: ToolExecutionOrigin;
      executionParent?: ExecutionParentLink;
    } = {},
  ): Promise<ToolResult> {
    const executionStartedAt = now();
    const executionOrigin = options.executionOrigin ?? "direct";
    const auditLink: ToolAuditLink = executionOrigin === "runtime_post_edit_verification"
      ? {
          executionOrigin,
          parentCallId: options.executionParent?.callId,
          parentToolName: options.executionParent?.toolName,
        }
      : {};
    const registered = this.registry.getTool(call.name);
    if (!registered) {
      const result = buildFailureToolResult(
        call.name,
        executionStartedAt,
        createStructuredError({
          type: "missing_dependency",
          message: `Unknown or unregistered tool: ${call.name}.`,
          retryable: false,
          toolName: call.name,
        }),
        call.id,
      );
      await this.recordToolAudit(sessionId, undefined, [], result, auditLink);
      return result;
    }
    const tool = registered.tool;
    const priorExecution = await this.sessionStore.loadToolExecutionJournal(sessionId, call.id);
    if (priorExecution) {
      if (priorExecution.toolName !== tool.name) {
        const result = buildFailureToolResult(
          tool.name,
          executionStartedAt,
          createStructuredError({
            type: "invalid_state",
            message: "Tool call identity conflicts with a prior execution journal entry.",
            retryable: false,
            toolName: tool.name,
          }),
          call.id,
        );
        await this.recordToolAudit(sessionId, registered.module, [], result, auditLink);
        return result;
      }
      if (priorExecution.status === "completed" && priorExecution.result) return priorExecution.result;
      const result = buildFailureToolResult(
        tool.name,
        executionStartedAt,
        createStructuredError({
          type: "invalid_state",
          message: "A state-changing tool call started previously without a completed result; automatic replay was refused.",
          retryable: false,
          toolName: tool.name,
        }),
        call.id,
      );
      await this.recordToolAudit(sessionId, registered.module, [], result, auditLink);
      return result;
    }

    const validation = this.registry.validateArguments(tool.name, call.arguments);
    if (!validation.valid) {
      const result = buildFailureToolResult(
        tool.name,
        executionStartedAt,
        createStructuredError({
          type: "invalid_arguments",
          message: `Invalid arguments for ${tool.name}: ${validation.errors
            .slice(0, 3)
            .map((error) => `${error.path} ${error.message}`)
            .join("; ")}.`,
          retryable: false,
          toolName: tool.name,
          fieldPath: validation.errors[0]?.path,
          details: validation.errors,
        }),
        call.id,
      );
      await this.recordToolAudit(sessionId, registered.module, [], result, auditLink);
      return result;
    }

    if (tool.getAvailability) {
      try {
        this.registry.setToolAvailability(tool.name, await tool.getAvailability(this.moduleContext));
      } catch (error) {
        this.registry.setToolAvailability(tool.name, {
          status: "unavailable",
          available: false,
          reason: `Availability check failed: ${(error as Error).message}`,
        });
      }
    }
    const currentAvailability = this.registry.getTool(tool.name)!.availability;
    if (!currentAvailability.available) {
      const result = buildFailureToolResult(
        tool.name,
        executionStartedAt,
        createStructuredError({
          type: "missing_dependency",
          message: currentAvailability.reason ?? `Tool ${tool.name} is unavailable.`,
          retryable: false,
          toolName: tool.name,
          dependency: currentAvailability.missingCapabilities?.join(", "),
        }),
        call.id,
      );
      await this.recordToolAudit(sessionId, registered.module, [], result, auditLink);
      return result;
    }

    let accessRequests: ToolAccessRequest[] = [];
    let permissionProfile: ToolPermissionProfile = {
      permissionCategory: tool.permissionCategory,
      sideEffectLevel: tool.sideEffectLevel,
      readOnly: tool.readOnly,
    };
    const accessResolutionContext = {
      ...this.moduleContext,
      sessionId,
      callId: call.id,
    };
    let preExecutionStage: "resolve_access" | "access_guard" = "resolve_access";
    try {
      accessRequests = tool.resolveAccess
        ? await tool.resolveAccess(call.arguments, accessResolutionContext)
        : [];
      permissionProfile = tool.resolvePermission
        ? await tool.resolvePermission(call.arguments, accessResolutionContext)
        : permissionProfile;
      preExecutionStage = "access_guard";
      await this.applyAccessGuards(accessRequests);
    } catch (error) {
      const structuredError = classifyException(tool.name, error);
      const defaultOutput = serializeStructuredFailure(structuredError);
      let formattedFailure:
        | { output?: string; structuredContent?: Record<string, unknown> }
        | undefined;
      if (tool.formatPreExecutionFailure) {
        try {
          formattedFailure = await tool.formatPreExecutionFailure(
            {
              stage: preExecutionStage,
              error: structuredError,
              defaultOutput,
            },
            call.arguments,
            accessResolutionContext,
          );
        } catch {
          // A formatter can enrich a failure but must never hide the original
          // guarded Runtime error if its own presentation logic is faulty.
        }
      }
      const result = buildFailureToolResult(
        tool.name,
        executionStartedAt,
        structuredError,
        call.id,
        formattedFailure?.structuredContent,
      );
      if (formattedFailure?.output) result.output = formattedFailure.output;
      await this.recordToolAudit(sessionId, registered.module, accessRequests, result, auditLink);
      return result;
    }

    const approvalId = randomUUID();
    const approval = await this.permissionLayer.evaluate({
      sessionId,
      toolName: tool.name,
      permissionCategory: permissionProfile.permissionCategory,
      sideEffectLevel: permissionProfile.sideEffectLevel,
      readOnly: permissionProfile.readOnly,
      arguments: permissionProfile.approvalContext
        ? { arguments: call.arguments, approvalContext: permissionProfile.approvalContext }
        : call.arguments,
      executionOrigin,
      parentCallId: options.executionParent?.callId,
      parentToolName: options.executionParent?.toolName,
    });
    const approvalRecord: ApprovalRecord = {
      recordType: "approval",
      approvalId,
      sessionId,
      createdAt: now(),
      toolName: tool.name,
      permissionCategory: permissionProfile.permissionCategory,
      requestKey: approval.requestKey,
      decision: approval.decision,
      reason: approval.reason,
      status: approval.decision === "ask" ? "pending" : "resolved",
      persistence:
        approval.grant?.persistence ??
        (approval.decision === "deny" ? "deny" : "mode_default"),
      callId: call.id,
      sideEffectLevel: permissionProfile.sideEffectLevel,
      presentation: permissionProfile.approvalPresentation,
      executionOrigin: executionOrigin === "direct" ? undefined : executionOrigin,
      parentCallId: options.executionParent?.callId,
      parentToolName: options.executionParent?.toolName,
    };
    await this.sessionStore.recordApproval(approvalRecord);

    if (approval.decision === "deny") {
      const error = createStructuredError({
        type: "sandbox_denied",
        message: approval.reason,
        retryable: false,
        toolName: tool.name,
      });
      const result: ToolResult = {
        toolName: tool.name,
        callId: call.id,
        startedAt: executionStartedAt,
        endedAt: now(),
        success: false,
        output: serializeStructuredFailure(error),
        structuredContent: {
          error,
        },
        error: approval.reason,
      };
      await this.permissionLayer.consumeGrantIfNeeded(approval.grant);
      await this.recordToolAudit(sessionId, registered.module, accessRequests, result, auditLink, approvalRecord);
      return result;
    }

    if (approval.decision === "ask") {
      throw new PermissionRequiredError(
        tool.name,
        approvalId,
        approval.requestKey,
        permissionProfile.permissionCategory,
        approval.reason,
        approvalRecord,
      );
    }

    const writePaths = accessRequests
      .filter((request) => request.kind === "filesystem_write")
      .flatMap((request) => request.paths ?? [])
      .map(normalizeRelativePath);
    const writeReason = accessRequests.find((request) => request.kind === "filesystem_write")?.reason;
    let checkpoint: CheckpointRecord | undefined;
    const executionTimeoutMs = tool.resolveExecutionTimeoutMs?.(call.arguments);
    const executionDeadline = executionTimeoutMs === undefined
      ? undefined
      : createSafeNetworkDeadline(options.signal, executionTimeoutMs);
    const executionSignal = executionDeadline?.signal ?? options.signal;
    let postEditVerificationCapabilityActive = true;
    const postEditVerificationParent: ExecutionParentLink | undefined =
      registered.module.id === "builtin.workspace" && tool.name === "apply_patch"
        ? { callId: call.id, toolName: "apply_patch" }
        : registered.module.id === "builtin.recovery" && tool.name === "apply_artifact_patch"
          ? { callId: call.id, toolName: "apply_artifact_patch" }
          : undefined;

    const context: RuntimeToolExecutionContext = {
      workspaceRoot: this.workspaceRoot,
      sessionId,
      turnId: options.turnId,
      permissionMode: this.permissionMode,
      sessionPersistence: this.sessionStore,
      signal: executionSignal,
      callId: call.id,
      module: registered.module,
      moduleContext: this.moduleContext,
      accessRequests,
      approval: approvalRecord,
      approvalContext: permissionProfile.approvalContext,
      executePostEditVerification: postEditVerificationParent
        ? async (name, args) => {
            if (!postEditVerificationCapabilityActive) {
              throw new Error("The post-edit verification capability expired with its parent tool call.");
            }
            return this.executePostEditVerificationTool(name, args, sessionId, {
              parent: postEditVerificationParent,
              turnId: options.turnId,
              signal: executionSignal,
            });
          }
        : undefined,
    };

    let result: ToolResult;
    let completedToolResult: ToolResult | undefined;
    let ownsExecutionJournal = true;
    try {
      if (tool.checkpoint?.mode === "before_write" && writePaths.length > 0) {
        checkpoint = await this.sessionStore.createCheckpoint({
          sessionId,
          scope: tool.checkpoint.scope ?? "pre_tool_write",
          trackedFiles: [...new Set(writePaths)],
          reason: tool.checkpoint.reason ?? writeReason ?? `Before ${tool.name}`,
          turnId: options.turnId,
          toolCallId: call.id,
          sourceToolName: tool.name,
          signal: context.signal,
        });
        context.checkpoint = checkpoint;
      }
      if (accessRequests.some((request) => request.kind === "external_system")) {
        const intent = await this.sessionStore.recordToolExecutionIntent({
          sessionId,
          callId: call.id,
          toolName: tool.name,
        });
        if (!intent.claimed) {
          ownsExecutionJournal = false;
          throw new Error("A concurrent state-changing execution already owns this tool call identity.");
        }
      }
      const toolResult = await tool.execute(call.arguments, context);
      completedToolResult = toolResult;
      const artifacts = await this.persistToolArtifacts(
        sessionId,
        call.id,
        tool.name,
        toolResult.artifacts ?? [],
      );
      const artifactSummary = artifacts.length > 0
        ? `\nartifacts:\n${artifacts
            .map((artifact) => `- ${artifact.fileName} | ${artifact.mimeType} | ${artifact.uri} | ${artifact.summary}`)
            .join("\n")}`
        : "";
      result = {
        ...toolResult,
        output: `${toolResult.output}${artifactSummary}`,
        artifacts,
        toolName: tool.name,
        callId: call.id,
        startedAt: executionStartedAt,
        endedAt: now(),
      };
      if (!result.success && checkpoint && tool.checkpoint?.restoreOnFailure !== false) {
        await this.sessionStore.restoreCheckpoint({
          sessionId,
          checkpointId: checkpoint.checkpointId,
          mode: "code",
          reason: `${tool.name}:automatic_failure_restore`,
        });
      }
    } catch (error) {
      let failure = error;
      if (context.signal?.aborted && context.signal.reason instanceof Error) {
        failure = context.signal.reason;
      }
      if (checkpoint && tool.checkpoint?.restoreOnFailure !== false) {
        try {
          await this.sessionStore.restoreCheckpoint({
            sessionId,
            checkpointId: checkpoint.checkpointId,
            mode: "code",
            reason: `${tool.name}:automatic_exception_restore`,
          });
        } catch (restoreError) {
          failure = new Error(
            `${(error as Error).message}; checkpoint restore failed: ${(restoreError as Error).message}`,
          );
        }
      }
      result = buildFailureToolResult(
        tool.name,
        executionStartedAt,
        classifyException(tool.name, failure),
        call.id,
      );
      if (completedToolResult?.networkAudit) {
        result.networkAudit = completedToolResult.networkAudit;
      }
    } finally {
      postEditVerificationCapabilityActive = false;
      executionDeadline?.dispose();
    }
    if (ownsExecutionJournal) await this.sessionStore.storeCompletedToolResult(sessionId, result);
    await this.recordToolAudit(sessionId, registered.module, accessRequests, result, auditLink, approvalRecord);
    await this.permissionLayer.consumeGrantIfNeeded(approval.grant);
    return result;
  }

  private registerMcpTools(): void {
    if (!this.mcpRegistry) {
      return;
    }

    const descriptors = this.mcpRegistry.listToolDescriptors();
    for (const descriptor of descriptors) this.mcpToolNames.add(descriptor.name);
    this.registry.registerModule(MCP_RUNTIME_MANIFEST, descriptors.map((descriptor) => this.createMcpToolSpec(descriptor)));
    const statuses = new Map(this.mcpRegistry.listServerStatuses().map((status) => [status.name, status]));
    for (const descriptor of descriptors) {
      const status = statuses.get(descriptor.serverName);
      if (!status || !status.enabled || status.state !== "ready") {
        this.registry.setToolAvailability(descriptor.name, {
          status: "unavailable",
          available: false,
          reason: status?.error ?? `MCP server ${descriptor.serverName} is not ready.`,
        });
      }
    }
  }

  private createMcpToolSpec(descriptor: McpToolDescriptor): RuntimeToolSpec {
    return {
      ...descriptor,
      groups: ["mcp"],
      selection: {
        groups: ["mcp"],
        keywords: [],
        workflowOnly: true,
      },
      resolveAccess: () => [
        {
          kind: "external_system",
          systems: [descriptor.serverName],
          reason: `Invoke MCP tool ${descriptor.name}.`,
        },
      ],
      execute: async (rawArgs) => {
        const startedAt = now();
        const result = await this.mcpRegistry!.invokeTool(descriptor.name, rawArgs);
        const visibleResult = {
          rawOutput: result.output,
          ...(result.structuredContent === undefined ? {} : { structuredContent: result.structuredContent }),
        };
        return {
          toolName: descriptor.name,
          callId: randomUUID(),
          startedAt,
          endedAt: now(),
          success: true,
          output: JSON.stringify(visibleResult),
          structuredContent: result.structuredContent,
        };
      },
    };
  }
  private async applyAccessGuards(requests: ToolAccessRequest[]): Promise<void> {
    for (const request of requests) {
      if (request.kind === "filesystem_read") {
        for (const targetPath of request.paths ?? []) {
          await this.moduleContext.paths.resolveReadable(targetPath);
        }
        continue;
      }
      if (request.kind === "filesystem_write") {
        const pathsToWrite = (request.paths ?? []).map((targetPath) => {
          const absolutePath = resolveInsideWorkspace(this.workspaceRoot, targetPath);
          return toWorkspaceRelativePath(this.workspaceRoot, absolutePath);
        });
        await this.permissionLayer.assertWritablePaths(pathsToWrite);
        continue;
      }
      if (request.kind === "command_execute") {
        const cwd = normalizeRelativePath(request.cwd ?? ".");
        resolveInsideWorkspace(this.workspaceRoot, cwd);
        await this.permissionLayer.assertShellCwd(cwd);
        continue;
      }
      if (request.kind === "network_access") {
        await this.permissionLayer.assertNetworkHosts(request.hosts ?? []);
      }
    }
  }

  private async recordToolAudit(
    sessionId: string,
    module: ToolModuleManifest | undefined,
    accessRequests: ToolAccessRequest[],
    result: ToolResult,
    link: ToolAuditLink = {},
    approval?: ApprovalRecord,
  ): Promise<void> {
    const structured = result.structuredContent as { error?: ToolStructuredError } | undefined;
    const operation = result.operationAudit;
    const startedAt = Date.parse(result.startedAt);
    const endedAt = Date.parse(result.endedAt);
    await this.sessionStore.recordToolExecutionAudit({
      recordType: "tool_execution_audit",
      sessionId,
      callId: result.callId,
      toolName: result.toolName,
      moduleId: module?.id,
      createdAt: result.endedAt,
      startedAt: result.startedAt,
      endedAt: result.endedAt,
      success: result.success,
      approvalId: approval?.approvalId,
      approvalDecision: approval?.decision,
      action: operation?.action ?? approval?.presentation?.action,
      argumentSummary: operation?.argumentSummary ?? approval?.presentation?.argumentSummary,
      durationMs: operation?.durationMs ?? (
        Number.isFinite(startedAt) && Number.isFinite(endedAt) ? Math.max(0, endedAt - startedAt) : undefined
      ),
      headBefore: operation?.headBefore,
      headAfter: operation?.headAfter,
      changedPaths: operation?.changedPaths,
      resultStatus: operation?.resultStatus,
      accessKinds: [...new Set(accessRequests.map((request) => request.kind))],
      artifactUris: result.artifacts?.map((artifact) => artifact.uri) ?? [],
      errorType: structured?.error?.type,
      network: result.networkAudit,
      executionOrigin: link.executionOrigin,
      parentCallId: link.parentCallId,
      parentToolName: link.parentToolName,
    });
  }

  private async persistToolArtifacts(
    sessionId: string,
    callId: string,
    toolName: string,
    artifacts: ToolOutputArtifact[],
  ): Promise<ToolOutputArtifact[]> {
    if (artifacts.length === 0) return [];
    const session = await this.sessionStore.loadSession(sessionId);
    const persisted: ToolOutputArtifact[] = [];
    for (const artifact of artifacts) {
      persisted.push(
        await this.sessionStore.recordToolOutputArtifact({
          ...artifact,
          sourceToolName: toolName,
          createdAt: artifact.createdAt || now(),
          sessionId,
          turnId: artifact.turnId ?? session?.activeTurnId,
          toolCallId: callId,
        }),
      );
    }
    return persisted;
  }
}

export function describeToolForPrompt(tool: ToolDefinition): string {
  return [
    `- ${tool.name}`,
    `  readOnly=${String(tool.readOnly)}`,
    `  permissionCategory=${tool.permissionCategory}`,
    `  sideEffectLevel=${tool.sideEffectLevel satisfies SideEffectLevel}`,
    `  timeoutCategory=${tool.timeoutCategory satisfies TimeoutCategory}`,
    `  schema=${JSON.stringify(tool.inputSchema)}`,
  ].join("\n");
}

export * from "./tool-registry.js";
export * from "./tool-module.js";
export * from "./network/index.js";
export * from "./process-manager.js";
export * from "./built-ins/index.js";
