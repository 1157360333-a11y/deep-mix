import type { McpRegistry } from "../../mcp-hub/src/index.js";
import type { SessionStore } from "../../persistence/src/index.js";
import type {
  ApprovalRecord,
  InvokeCodingWorkerResult,
  CheckpointRecord,
  CapabilityProbeDefinition,
  DeepMixSettings,
  PermissionMode,
  RuntimeCapabilityProbe,
  RuntimeCapabilitySnapshot,
  ToolAccessRequest,
  ToolAvailability,
  ToolDefinition,
  ToolExecutionContext,
  ToolModuleManifest,
  ToolOutputArtifact,
  ToolPermissionProfile,
  ToolProcessInputResult,
  ToolProcessOutputChunk,
  ToolProcessSession,
  ToolProcessStopResult,
  ToolResult,
  ToolStructuredError,
  WorkerTask,
} from "../../shared-schema/src/index.js";
import type { SpecialistBroker } from "../../specialist-broker/src/index.js";

import { ToolRegistry } from "./tool-registry.js";
import type { ToolNetworkService } from "./network/index.js";
import type {
  ToolProcessArtifactSnapshot,
  ToolProcessReadRequest,
  ToolProcessStartRequest,
  ToolProcessStartResult,
  ToolProcessStopRequest,
  ToolProcessWriteRequest,
} from "./process-manager.js";

export interface ToolProcessRequest {
  command: string;
  args?: string[];
  /** Optional bounded UTF-8 stdin for direct non-shell commands. */
  input?: string;
  mode?: "direct" | "shell";
  cwd?: string;
  timeoutMs?: number;
  /** Bound combined stdout/stderr captured in memory; excess output is discarded. */
  maxOutputChars?: number;
  environment?: NodeJS.ProcessEnv;
  signal?: AbortSignal;
}

export interface ToolProcessResult {
  command: string;
  cwd: string;
  stdout: string;
  stderr: string;
  exitCode: number | null;
  timedOut: boolean;
  outputTruncated?: boolean;
  spawnError?: {
    code?: string;
    message: string;
  };
}

export interface ToolProcessRunner {
  run(request: ToolProcessRequest): Promise<ToolProcessResult>;
}

/** Long-lived lifecycle operations are separate from the compatible short-command runner. */
export interface ToolProcessServices extends ToolProcessRunner {
  start(request: ToolProcessStartRequest): Promise<ToolProcessStartResult>;
  writeInput(request: ToolProcessWriteRequest): Promise<ToolProcessInputResult>;
  readOutput(request: ToolProcessReadRequest): Promise<ToolProcessOutputChunk>;
  stop(request: ToolProcessStopRequest): Promise<ToolProcessStopResult>;
  list(sessionId?: string): ToolProcessSession[];
  getArtifactSnapshot(ownerSessionId: string, processSessionId: string): ToolProcessArtifactSnapshot;
  attachArtifact(
    ownerSessionId: string,
    processSessionId: string,
    artifact: ToolOutputArtifact,
    capturedThroughCursor: number,
    truncated: boolean,
    reservationId: string,
  ): boolean;
  releaseArtifactReservation(ownerSessionId: string, processSessionId: string, reservationId: string): void;
}

export interface ToolPathServices {
  normalize(relativePath: string): string;
  resolveWorkspace(relativePath: string): string;
  resolveState(relativePath: string): string;
  resolveReadable(refOrPath: string): Promise<{
    absolutePath: string;
    workspaceRelativePath?: string;
    artifactRef?: string;
    /** Read through the trust boundary for this resolved source. */
    readBytes(): Promise<Buffer>;
  }>;
}

export interface ToolCapabilityServices {
  get(name: string): Promise<RuntimeCapabilityProbe | undefined>;
  list(): Promise<Record<string, RuntimeCapabilityProbe>>;
  /** List declaratively registered capability names without executing their probes. */
  listRegisteredNames(): string[];
  /** Return only an already-detected snapshot; this method must never trigger probes. */
  loadSnapshot(): Promise<RuntimeCapabilitySnapshot | undefined>;
  registerProbe(definition: CapabilityProbeDefinition): void;
}

export interface ToolWorkerServices {
  invokeCodingWorker(input: {
    parentSessionId: string;
    task: WorkerTask;
  }): Promise<InvokeCodingWorkerResult>;
  invokeVisionWorker: SpecialistBroker["invokeVisionWorker"];
  getWorkerStatus: SpecialistBroker["getWorkerStatus"];
  getWorkerPublicOutput: SpecialistBroker["getWorkerPublicOutput"];
  previewWorkerCancellation: SpecialistBroker["previewWorkerCancellation"];
  cancelOwnedWorkerSession: SpecialistBroker["cancelOwnedWorkerSession"];
}

export interface ToolOptionalDependencies {
  workers?: ToolWorkerServices;
  mcpRegistry?: McpRegistry;
  mcpExecutor?: (input: {
    server: string;
    tool: string;
    input?: unknown;
  }) => Promise<{ output: string; structuredContent?: unknown }>;
}

export interface ToolCatalogRegistration {
  module: ToolModuleManifest;
  definition: ToolDefinition;
  availability: ToolAvailability;
}

export interface ToolModuleContext {
  workspaceRoot: string;
  permissionMode: PermissionMode;
  settings: DeepMixSettings;
  network: ToolNetworkService;
  persistence: SessionStore;
  capabilities: ToolCapabilityServices;
  processes: ToolProcessServices;
  paths: ToolPathServices;
  permissions: {
    assertNetworkHosts(hosts: string[]): Promise<void>;
  };
  tools: {
    executeManual(name: string, args: unknown, sessionId: string): Promise<ToolResult>;
    listRegistered(): ToolCatalogRegistration[];
  };
  clock: {
    now(): string;
  };
  ids: {
    create(): string;
  };
  environment: NodeJS.ProcessEnv;
  optional: ToolOptionalDependencies;
}

export interface ToolAccessResolutionContext extends ToolModuleContext {
  sessionId: string;
  callId: string;
}

export interface RuntimeToolExecutionContext extends ToolExecutionContext {
  callId: string;
  /** Governor-authoritative turn identity for model-issued calls. */
  turnId?: string;
  module: ToolModuleManifest;
  moduleContext: ToolModuleContext;
  accessRequests: ToolAccessRequest[];
  /** The exact permission decision bound to this execution and its state context. */
  approval: ApprovalRecord;
  /** Security state which participated in the approval HMAC. */
  approvalContext?: Record<string, unknown>;
  checkpoint?: CheckpointRecord;
  /** Capability granted only to the built-in, permission-checked patch tools. */
  executePostEditVerification?: (
    name: "run_tests" | "lint" | "typecheck",
    args: unknown,
  ) => Promise<ToolResult>;
}

export type ToolPreExecutionStage = "resolve_access" | "access_guard";

export interface ToolPreExecutionFailure {
  stage: ToolPreExecutionStage;
  error: ToolStructuredError;
  defaultOutput: string;
}

export interface ToolPreExecutionFailureFormat {
  output?: string;
  structuredContent?: Record<string, unknown>;
}

export interface RuntimeToolSpec<TArgs = unknown, TResult = unknown> extends ToolDefinition {
  resolveAccess?: (
    args: TArgs,
    context: ToolAccessResolutionContext,
  ) => ToolAccessRequest[] | Promise<ToolAccessRequest[]>;
  resolvePermission?: (
    args: TArgs,
    context: ToolAccessResolutionContext,
  ) => ToolPermissionProfile | Promise<ToolPermissionProfile>;
  /** Return a persistence-safe copy of tool arguments without secret values. */
  redactArguments?: (args: TArgs) => unknown;
  /** Optional end-to-end execution deadline, beginning before checkpoint work. */
  resolveExecutionTimeoutMs?: (args: TArgs) => number | undefined;
  getAvailability?: (context: ToolModuleContext) => ToolAvailability | Promise<ToolAvailability>;
  /** Declaratively add a tool-specific envelope to failures before permission/checkpoint/write. */
  formatPreExecutionFailure?: (
    failure: ToolPreExecutionFailure,
    args: TArgs,
    context: ToolAccessResolutionContext,
  ) => ToolPreExecutionFailureFormat | Promise<ToolPreExecutionFailureFormat>;
  execute: (args: TArgs, context: RuntimeToolExecutionContext) => Promise<ToolResult<TResult>>;
}

export type ToolFactory = (
  context: ToolModuleContext,
) => RuntimeToolSpec | RuntimeToolSpec[];

export interface ToolModule {
  manifest: ToolModuleManifest;
  create: ToolFactory;
  capabilityProbes?: CapabilityProbeDefinition[];
  initialize?: (context: ToolModuleContext) => void | Promise<void>;
  dispose?: (context: ToolModuleContext) => void | Promise<void>;
}

export function registerToolModules(
  registry: ToolRegistry<RuntimeToolSpec>,
  modules: readonly ToolModule[],
  context: ToolModuleContext,
): void {
  for (const module of modules) {
    try {
      for (const probe of module.capabilityProbes ?? []) context.capabilities.registerProbe(probe);
      const created = module.create(context);
      registry.registerModule(module.manifest, Array.isArray(created) ? created : [created]);
    } catch (error) {
      if (!registry.listExtensionErrors().some((entry) => entry.moduleId === module.manifest.id)) {
        registry.recordModuleInitializationFailure(module.manifest, error);
      }
      throw error;
    }
  }
}

export async function initializeToolModules(
  registry: ToolRegistry<RuntimeToolSpec>,
  modules: readonly ToolModule[],
  context: ToolModuleContext,
): Promise<void> {
  for (const module of modules) {
    try {
      await module.initialize?.(context);
    } catch (error) {
      registry.recordModuleInitializationFailure(module.manifest, error);
      for (const tool of registry.listRegisteredTools()) {
        if (tool.module.id === module.manifest.id) {
          registry.setToolAvailability(tool.tool.name, {
            status: "unavailable",
            available: false,
            reason: `Module initialization failed: ${(error as Error).message}`,
          });
        }
      }
    }
  }
}

export async function disposeToolModules(
  modules: readonly ToolModule[],
  context: ToolModuleContext,
): Promise<void> {
  for (const module of [...modules].reverse()) {
    await module.dispose?.(context);
  }
}
