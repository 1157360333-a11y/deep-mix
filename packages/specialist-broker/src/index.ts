import { createHash } from "node:crypto";
import { promises as fs } from "node:fs";
import path from "node:path";
import sharp from "sharp";
import { SessionStore, type WorkerLifecycleEventScan } from "../../persistence/src/index.js";
import {
  createCodingWorkerRouteProfile,
  createModelAssignmentSnapshot,
  createVisionWorkerRouteProfile,
  loadCodingWorkerModelCandidates,
  loadVisionWorkerModelCandidates,
  type CodingWorkerModelConfig,
  type VisionWorkerModelConfig,
} from "../../route-resolver/src/index.js";
import type {
  InvokeCodingWorkerResult,
  InvokeVisionWorkerResult,
  LifecycleWarning,
  VisionImageRef,
  WorkerArtifactSummary,
  WorkerCancelResult,
  WorkerDispatchKind,
  WorkerLifecycleStage,
  WorkerPublicOutputEvent,
  WorkerSessionEvent,
  WorkerSessionRecord,
  WorkerStatusSummary,
  WorkerTask,
  WorkerToolError,
} from "../../shared-schema/src/index.js";
import {
  CodingWorkerClient,
  CodingWorkerError,
  FallbackCodingWorkerRunner,
  type CodingWorkerRunner,
} from "../../worker-glm-coding/src/index.js";
import {
  buildVisionArtifact,
  FallbackVisionWorkerRunner,
  VisionWorkerClient,
  VisionWorkerError,
  toVisionToolSummary,
  type PreparedVisionInput,
  type VisionWorkerRunner,
  type VisionWorkerToolInput,
} from "../../worker-kimi-vision/src/index.js";

interface SpecialistBrokerOptions {
  workspaceRoot: string;
  sessionStore: SessionStore;
  codingWorkerFactory?: (config: CodingWorkerModelConfig) => CodingWorkerRunner;
  visionWorkerFactory?: (config: VisionWorkerModelConfig) => VisionWorkerRunner;
}

export interface WorkerPublicOutputSnapshot {
  status: WorkerStatusSummary;
  events: WorkerPublicOutputEvent[];
  scanned: number;
  partial: boolean;
  warnings: LifecycleWarning[];
  availableResult?: InvokeCodingWorkerResult | InvokeVisionWorkerResult;
}

function now(): string {
  return new Date().toISOString();
}

function resolveInsideWorkspace(workspaceRoot: string, inputPath: string): string {
  const absolutePath = path.resolve(workspaceRoot, inputPath);
  const relative = path.relative(workspaceRoot, absolutePath);
  if (relative.startsWith("..") || path.isAbsolute(relative)) {
    throw new Error(`Path escapes workspace root: ${inputPath}`);
  }
  return absolutePath;
}

function truncateBlock(content: string, maxChars: number): string {
  if (content.length <= maxChars) {
    return content;
  }
  if (maxChars <= 32) {
    return content.slice(0, maxChars);
  }
  return `${content.slice(0, maxChars - 16)}\n...[truncated]`;
}

function redactPublicWorkerText(value: string, workspaceRoot: string, maxChars = 4_000): string {
  const escapeRegExp = (entry: string) => entry.replace(/[.*+?^${}()|[\]\\]/gu, "\\$&");
  let redacted = value;
  if (process.platform === "win32") {
    const normalized = workspaceRoot.replace(/^\\\\\?\\/u, "").replace(/[\\/]+/gu, "/");
    const mixedSeparatorPattern = normalized.split("/").map(escapeRegExp).join("[\\\\/]+");
    redacted = redacted.replace(
      new RegExp(`${String.raw`(?:\\\\\?\\)?`}${mixedSeparatorPattern}`, "giu"),
      "<workspace>",
    );
  } else {
    redacted = redacted.replace(new RegExp(escapeRegExp(workspaceRoot), "gu"), "<workspace>");
  }
  return redacted
    .replace(/\b(Bearer|Basic)\s+[A-Za-z0-9._~+\/=-]{4,}/giu, "$1 [REDACTED]")
    .replace(/\beyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\b/gu, "[REDACTED_JWT]")
    .replace(
      /\b(?:sk-(?:proj-)?[A-Za-z0-9_-]{12,}|gh[opusr]_[A-Za-z0-9]{20,}|github_pat_[A-Za-z0-9_]{20,}|xox[baprs]-[A-Za-z0-9-]{10,}|glpat-[A-Za-z0-9_-]{10,}|npm_[A-Za-z0-9]{20,}|(?:AKIA|ASIA)[A-Z0-9]{16})\b/gu,
      "[REDACTED_TOKEN]",
    )
    .replace(
      /((?:["']?(?:api[-_]?key|authorization|cookie|credential|password|secret|session[-_]?id|token)["']?)\s*[:=]\s*)["']?[^\s,"';}\]]+["']?/giu,
      "$1[REDACTED]",
    )
    .slice(0, maxChars);
}

function redactPublicWorkerValue(value: unknown, workspaceRoot: string, depth = 0): unknown {
  if (depth > 32) return "[TRUNCATED_DEPTH]";
  if (typeof value === "string") return redactPublicWorkerText(value, workspaceRoot, 1_000);
  if (Array.isArray(value)) return value.slice(0, 100).map((entry) => redactPublicWorkerValue(entry, workspaceRoot, depth + 1));
  if (!value || typeof value !== "object") return value;
  return Object.fromEntries(
    Object.entries(value as Record<string, unknown>)
      .slice(0, 100)
      .map(([key, entry]) => [
        key.slice(0, 128),
        /(?:api[-_]?key|authorization|cookie|credential|password|secret|token)/iu.test(key)
          ? "[REDACTED]"
          : redactPublicWorkerValue(entry, workspaceRoot, depth + 1),
      ]),
  );
}

function sanitizeWorkerArtifact(summary: WorkerArtifactSummary, workspaceRoot: string): WorkerArtifactSummary {
  if (summary.kind === "code_artifact") {
    return {
      ...summary,
      summary: redactPublicWorkerText(summary.summary, workspaceRoot),
      patchRef: redactPublicWorkerText(summary.patchRef, workspaceRoot, 1_000),
      changedFiles: summary.changedFiles.slice(0, 200).map((entry) => redactPublicWorkerText(entry, workspaceRoot, 1_000)),
      testCommands: summary.testCommands.slice(0, 100).map((entry) => redactPublicWorkerText(entry, workspaceRoot, 1_000)),
      risks: summary.risks.slice(0, 100).map((entry) => redactPublicWorkerText(entry, workspaceRoot, 1_000)),
      notes: summary.notes?.slice(0, 100).map((entry) => redactPublicWorkerText(entry, workspaceRoot, 1_000)),
    };
  }
  return {
    ...summary,
    summary: redactPublicWorkerText(summary.summary, workspaceRoot),
    issues: summary.issues.slice(0, 200).map((entry) => redactPublicWorkerText(entry, workspaceRoot, 1_000)),
    metadata: redactPublicWorkerValue(summary.metadata, workspaceRoot) as typeof summary.metadata,
  };
}

function publicEventId(parts: unknown[]): string {
  return createHash("sha256").update(JSON.stringify(parts)).digest("base64url").slice(0, 24);
}

function toWorkerTask(session: WorkerSessionRecord): WorkerTask {
  return {
    workerType: session.workerType,
    objective: session.objective,
    constraints: [...session.constraints],
    contextRefs: [...session.contextRefs],
    expectedOutput: session.expectedOutput,
    acceptanceChecks: [...session.acceptanceChecks],
  };
}

function toWorkerError(
  error: unknown,
  workerSessionId: string,
  signal?: AbortSignal,
): WorkerToolError {
  if (error instanceof CodingWorkerError) {
    return {
      errorType: error.type,
      message: error.message,
      retryable: error.retryable,
      workerSessionId,
    };
  }

  if (signal?.aborted) {
    const reason = String(signal.reason ?? "");
    return {
      errorType: reason === "timeout" ? "call_timeout" : "worker_interrupted",
      message: reason === "timeout" ? "Coding worker timed out." : "Coding worker was interrupted.",
      retryable: false,
      workerSessionId,
    };
  }

  return {
    errorType: "response_parse_failed",
    message: (error as Error).message,
    retryable: false,
    workerSessionId,
  };
}

function toVisionWorkerError(
  error: unknown,
  workerSessionId: string,
  signal?: AbortSignal,
): WorkerToolError {
  if (error instanceof VisionWorkerError) {
    return {
      errorType: error.type,
      message: error.message,
      retryable: error.retryable,
      workerSessionId,
    };
  }

  if (signal?.aborted) {
    const reason = String(signal.reason ?? "");
    return {
      errorType: reason === "timeout" ? "call_timeout" : "worker_interrupted",
      message: reason === "timeout" ? "Vision worker timed out." : "Vision worker was interrupted.",
      retryable: false,
      workerSessionId,
    };
  }

  return {
    errorType: "response_parse_failed",
    message: (error as Error).message,
    retryable: false,
    workerSessionId,
  };
}

function normalizeFileExtension(extension: string | undefined): string {
  const cleaned = (extension ?? "").replace(/^\./, "").toLowerCase();
  return cleaned || "bin";
}

function inferMimeType(extension: string): string {
  switch (extension) {
    case "png":
      return "image/png";
    case "jpg":
    case "jpeg":
      return "image/jpeg";
    case "webp":
      return "image/webp";
    case "gif":
      return "image/gif";
    default:
      throw new VisionWorkerError("input_validation_failed", `Unsupported image format: ${extension}`);
  }
}

export class SpecialistBroker {
  private readonly workspaceRoot: string;

  private readonly sessionStore: SessionStore;

  private readonly codingWorkerFactory: (config: CodingWorkerModelConfig) => CodingWorkerRunner;

  private readonly visionWorkerFactory: (config: VisionWorkerModelConfig) => VisionWorkerRunner;

  private readonly activeControllers = new Map<string, AbortController>();

  private readonly pendingCancellations = new Map<string, {
    parentSessionId: string;
    requestedAt: string;
    reason: string;
  }>();

  public constructor(options: SpecialistBrokerOptions) {
    this.workspaceRoot = options.workspaceRoot;
    this.sessionStore = options.sessionStore;
    this.codingWorkerFactory = options.codingWorkerFactory ?? ((config) => new CodingWorkerClient(config));
    this.visionWorkerFactory = options.visionWorkerFactory ?? ((config) => new VisionWorkerClient(config));
  }

  public async createCodingSession(input: {
    parentSessionId: string;
    task: WorkerTask;
    dispatchKind?: WorkerDispatchKind;
    retryOfWorkerSessionId?: string;
    reviseOfWorkerSessionId?: string;
  }): Promise<{ session: WorkerSessionRecord; config: CodingWorkerModelConfig; candidateConfigs: CodingWorkerModelConfig[]; fallbackPolicy: import("../../shared-schema/src/index.js").ModelFallbackPolicy }> {
    const candidates = await loadCodingWorkerModelCandidates(this.workspaceRoot);
    const config = candidates.configs[0]!;
    const route = createCodingWorkerRouteProfile(config);
    const modelAssignment = createModelAssignmentSnapshot({
      slot: "coding",
      config,
      configRevision: candidates.settingsRevision,
      selectionReason: candidates.preset === "classic" ? "classic_preset" : "primary",
      source: candidates.source,
    });
    const session = await this.sessionStore.createWorkerSession({
      parentSessionId: input.parentSessionId,
      task: input.task,
      route,
      modelAssignment,
      timeoutMs: config.timeoutMs,
      maxRetries: config.maxRetries,
      dispatchKind: input.dispatchKind,
      retryOfWorkerSessionId: input.retryOfWorkerSessionId,
      reviseOfWorkerSessionId: input.reviseOfWorkerSessionId,
    });
    return { session, config, candidateConfigs: candidates.configs, fallbackPolicy: candidates.fallbackPolicy };
  }

  public async createVisionSession(input: {
    parentSessionId: string;
    task: WorkerTask;
  }): Promise<{ session: WorkerSessionRecord; config: VisionWorkerModelConfig; candidateConfigs: VisionWorkerModelConfig[]; fallbackPolicy: import("../../shared-schema/src/index.js").ModelFallbackPolicy }> {
    const candidates = await loadVisionWorkerModelCandidates(this.workspaceRoot);
    const config = candidates.configs[0]!;
    const route = createVisionWorkerRouteProfile(config);
    const modelAssignment = createModelAssignmentSnapshot({
      slot: "vision",
      config,
      configRevision: candidates.settingsRevision,
      selectionReason: candidates.preset === "classic" ? "classic_preset" : "primary",
      source: candidates.source,
    });
    const session = await this.sessionStore.createWorkerSession({
      parentSessionId: input.parentSessionId,
      task: input.task,
      route,
      modelAssignment,
      timeoutMs: config.timeoutMs,
      maxRetries: config.maxRetries,
    });
    return { session, config, candidateConfigs: candidates.configs, fallbackPolicy: candidates.fallbackPolicy };
  }

  public async invokeCodingWorker(input: {
    parentSessionId: string;
    task: WorkerTask;
    dispatchKind?: WorkerDispatchKind;
    retryOfWorkerSessionId?: string;
    reviseOfWorkerSessionId?: string;
  }): Promise<InvokeCodingWorkerResult> {
    const { session, config, candidateConfigs, fallbackPolicy } = await this.createCodingSession(input);
    return this.runCodingWorkerSession({
      session,
      config,
      candidateConfigs,
      fallbackPolicy,
      task: input.task,
      initialDispatchKind: session.dispatchKind,
      firstAttemptReason: "Dispatching coding worker task.",
    });
  }

  public async invokeVisionWorker(input: {
    parentSessionId: string;
    task: WorkerTask;
    visionInput: VisionWorkerToolInput;
  }): Promise<InvokeVisionWorkerResult> {
    const { session, config, candidateConfigs, fallbackPolicy } = await this.createVisionSession({
      parentSessionId: input.parentSessionId,
      task: input.task,
    });
    return this.runVisionWorkerSession({
      session,
      config,
      candidateConfigs,
      fallbackPolicy,
      task: input.task,
      visionInput: input.visionInput,
    });
  }

  public async reviseCodingWorker(input: {
    workerSessionId: string;
    revisionRequest: string;
  }): Promise<InvokeCodingWorkerResult> {
    const session = await this.sessionStore.loadWorkerSession(input.workerSessionId);
    if (!session) {
      throw new Error(`Unknown worker session: ${input.workerSessionId}`);
    }
    const candidates = await loadCodingWorkerModelCandidates(this.workspaceRoot);
    const config = candidates.configs[0]!;
    const latestArtifact = await this.sessionStore.loadLatestWorkerArtifact(input.workerSessionId);
    const task = toWorkerTask(session);
    task.contextRefs = [
      ...task.contextRefs,
      {
        refType: "summary",
        label: "Supervisor revision request",
        summary: input.revisionRequest,
      },
      ...(latestArtifact
        ? [
            {
              refType: "summary" as const,
              label: "Previous worker artifact",
              summary: latestArtifact.summary.summary,
            },
          ]
        : []),
    ];

    return this.runCodingWorkerSession({
      session,
      config,
      candidateConfigs: candidates.configs,
      fallbackPolicy: candidates.fallbackPolicy,
      task,
      initialDispatchKind: "revise",
      firstAttemptReason: "Supervisor requested a worker revision.",
    });
  }

  public async retryCodingWorkerWithMoreContext(input: {
    workerSessionId: string;
    extraContextRefs: WorkerTask["contextRefs"];
  }): Promise<InvokeCodingWorkerResult> {
    const current = await this.sessionStore.loadWorkerSession(input.workerSessionId);
    if (!current) {
      throw new Error(`Unknown worker session: ${input.workerSessionId}`);
    }
    const candidates = await loadCodingWorkerModelCandidates(this.workspaceRoot);
    const config = candidates.configs[0]!;
    const task = toWorkerTask(current);
    task.contextRefs = [...task.contextRefs, ...input.extraContextRefs];
    const session = await this.sessionStore.updateWorkerSession(input.workerSessionId, (existing) => ({
      ...existing,
      contextRefs: task.contextRefs,
    }));

    return this.runCodingWorkerSession({
      session,
      config,
      candidateConfigs: candidates.configs,
      fallbackPolicy: candidates.fallbackPolicy,
      task,
      initialDispatchKind: "retry",
      firstAttemptReason: "Supervisor retried the worker with more context.",
    });
  }

  private async runCodingWorkerSession(input: {
    session: WorkerSessionRecord;
    config: CodingWorkerModelConfig;
    candidateConfigs?: CodingWorkerModelConfig[];
    fallbackPolicy?: import("../../shared-schema/src/index.js").ModelFallbackPolicy;
    task: WorkerTask;
    initialDispatchKind: WorkerDispatchKind;
    firstAttemptReason: string;
  }): Promise<InvokeCodingWorkerResult> {
    const candidateConfigs = input.candidateConfigs ?? [input.config];
    const fallbackWorker = candidateConfigs.length > 1
      ? new FallbackCodingWorkerRunner(
          candidateConfigs.map((config) => ({ config, runner: this.codingWorkerFactory(config) })),
          new Set(input.fallbackPolicy?.on ?? []),
        )
      : undefined;
    const worker = fallbackWorker ?? this.codingWorkerFactory(input.config);
    const resolvedContext = await this.resolveWorkerContext(input.task, input.config);
    let lastError: WorkerToolError | undefined;

    for (let attempt = 0; attempt <= input.config.maxRetries; attempt += 1) {
      const invocationStartedAt = Date.now();
      let modelInvoked = false;
      const dispatchKind = attempt === 0 ? input.initialDispatchKind : "retry";
      const controller = new AbortController();
      this.activeControllers.set(input.session.workerSessionId, controller);
      if (this.pendingCancellations.has(input.session.workerSessionId)) {
        controller.abort("cancelled");
        this.pendingCancellations.delete(input.session.workerSessionId);
      }
      const timeout = setTimeout(() => controller.abort("timeout"), input.config.timeoutMs);

      try {
        if (controller.signal.aborted) throw new Error("cancelled");
        const runningSession = await this.sessionStore.setWorkerSessionStatus({
          workerSessionId: input.session.workerSessionId,
          status: "running",
          dispatchKind,
          attemptNumber: input.session.retryCount + input.session.revisionCount + attempt + 1,
          reason: attempt === 0 ? input.firstAttemptReason : "Retrying coding worker task.",
        });
        if (runningSession.status !== "running") {
          controller.abort("cancelled");
          throw new Error("Coding worker is no longer runnable.");
        }
        await this.sessionStore.appendWorkerMessage({
          workerSessionId: input.session.workerSessionId,
          role: "system",
          content: "Coding worker invoked by Specialist Broker. Workspace writes are disabled.",
          metadata: {
            routeRole: "coding_worker",
            dispatchKind,
            timeoutMs: input.config.timeoutMs,
            maxRetries: input.config.maxRetries,
          },
        });
        await this.sessionStore.appendWorkerMessage({
          workerSessionId: input.session.workerSessionId,
          role: "user",
          content: JSON.stringify(
            {
              objective: input.task.objective,
              constraints: input.task.constraints,
              acceptanceChecks: input.task.acceptanceChecks,
              contextRefs: input.task.contextRefs,
            },
            null,
            2,
          ),
        });

        if (controller.signal.aborted) {
          throw new Error("cancelled");
        }

        modelInvoked = true;
        const result = await worker.runTask({
          task: input.task,
          resolvedContext,
          workerSessionId: input.session.workerSessionId,
          signal: controller.signal,
        });

        if (controller.signal.aborted) throw new Error("cancelled");

        if (fallbackWorker) {
          await this.sessionStore.appendWorkerMessage({
            workerSessionId: input.session.workerSessionId,
            role: "system",
            content: "Coding model candidate selection completed before artifact publication.",
            metadata: {
              attempts: fallbackWorker.attempts,
              selectedFallbackIndex: fallbackWorker.selectedIndex,
            },
          });
        }

        await this.sessionStore.appendWorkerMessage({
          workerSessionId: input.session.workerSessionId,
          role: "assistant",
          content: result.rawResponse,
        });

        if (controller.signal.aborted) throw new Error("cancelled");

        const selectedConfig = fallbackWorker ? candidateConfigs[fallbackWorker.selectedIndex]! : input.config;
        await this.sessionStore.recordModelInvocation(input.session.parentSessionId, createModelAssignmentSnapshot({
          slot: "coding",
          config: selectedConfig,
          configRevision: input.session.modelAssignment?.configRevision ?? 0,
          fallbackIndex: fallbackWorker?.selectedIndex ?? 0,
          selectionReason: (fallbackWorker?.selectedIndex ?? 0) > 0 ? "ordered_fallback" : input.session.modelAssignment?.selectionReason ?? "primary",
          source: input.session.modelAssignment?.source ?? "settings",
        }), {
          result: "success",
          latencyMs: Date.now() - invocationStartedAt,
        }).catch(() => undefined);
        const artifactRecord = await this.sessionStore.storeCodeArtifact({
          workerSessionId: input.session.workerSessionId,
          artifact: {
            kind: "code_artifact",
            summary: result.artifact.summary,
            changedFiles: result.artifact.changedFiles,
            testCommands: result.artifact.testCommands,
            risks: result.artifact.risks,
            confidence: result.artifact.confidence,
            notes: result.artifact.notes,
            metadata: {
              workerSessionId: input.session.workerSessionId,
              provider: selectedConfig.provider ?? "coding-adapter",
              model: selectedConfig.model,
              createdAt: now(),
              ...(result.artifact.metadata ?? {}),
            },
          },
          patchContent: result.patch,
        });

        if (controller.signal.aborted) throw new Error("cancelled");

        const completedSession = await this.sessionStore.setWorkerSessionStatus({
          workerSessionId: input.session.workerSessionId,
          status: "completed",
          dispatchKind,
          attemptNumber: input.session.retryCount + input.session.revisionCount + attempt + 1,
          reason: "Coding worker returned a valid code artifact.",
        });
        if (completedSession.status !== "completed") throw new Error("cancelled");
        if (artifactRecord.summary.kind !== "code_artifact") {
          throw new Error("Expected a code artifact summary from storeCodeArtifact.");
        }

        return {
          workerSessionId: input.session.workerSessionId,
          artifact: artifactRecord.summary,
        };
      } catch (error) {
        if (modelInvoked && input.session.modelAssignment) {
          await this.sessionStore.recordModelInvocation(input.session.parentSessionId, input.session.modelAssignment, {
            result: "failure",
            latencyMs: Date.now() - invocationStartedAt,
          }).catch(() => undefined);
        }
        if (error instanceof CodingWorkerError && error.rawResponse && !controller.signal.aborted) {
          await this.sessionStore.appendWorkerMessage({
            workerSessionId: input.session.workerSessionId,
            role: "assistant",
            content: error.rawResponse,
            metadata: {
              errorType: error.type,
            },
          });
        }

        lastError = toWorkerError(error, input.session.workerSessionId, controller.signal);
        const willRetry = lastError.retryable && attempt < input.config.maxRetries && !controller.signal.aborted;

        await this.sessionStore.setWorkerSessionStatus({
          workerSessionId: input.session.workerSessionId,
          status: willRetry ? "failed" : lastError.errorType === "worker_interrupted" ? "cancelled" : "failed",
          dispatchKind,
          attemptNumber: input.session.retryCount + input.session.revisionCount + attempt + 1,
          reason: willRetry ? `${lastError.message} Retrying.` : lastError.message,
          errorType: lastError.errorType,
          errorMessage: lastError.message,
        });

        if (!willRetry) {
          return {
            workerSessionId: input.session.workerSessionId,
            error: lastError,
          };
        }
      } finally {
        clearTimeout(timeout);
        if (this.activeControllers.get(input.session.workerSessionId) === controller) {
          this.activeControllers.delete(input.session.workerSessionId);
        }
      }
    }

    return {
      workerSessionId: input.session.workerSessionId,
      error:
        lastError ??
        ({
          workerSessionId: input.session.workerSessionId,
          errorType: "worker_interrupted",
          message: "Coding worker exited without producing a result.",
          retryable: false,
      } satisfies WorkerToolError),
    };
  }

  private async runVisionWorkerSession(input: {
    session: WorkerSessionRecord;
    config: VisionWorkerModelConfig;
    candidateConfigs?: VisionWorkerModelConfig[];
    fallbackPolicy?: import("../../shared-schema/src/index.js").ModelFallbackPolicy;
    task: WorkerTask;
    visionInput: VisionWorkerToolInput;
  }): Promise<InvokeVisionWorkerResult> {
    const candidateConfigs = input.candidateConfigs ?? [input.config];
    const fallbackWorker = candidateConfigs.length > 1
      ? new FallbackVisionWorkerRunner(
          candidateConfigs.map((config) => ({ config, runner: this.visionWorkerFactory(config) })),
          new Set(input.fallbackPolicy?.on ?? []),
        )
      : undefined;
    const worker = fallbackWorker ?? this.visionWorkerFactory(input.config);
    const controller = new AbortController();
    this.activeControllers.set(input.session.workerSessionId, controller);
    if (this.pendingCancellations.has(input.session.workerSessionId)) {
      controller.abort("cancelled");
      this.pendingCancellations.delete(input.session.workerSessionId);
    }
    const timeout = setTimeout(() => controller.abort("timeout"), input.config.timeoutMs);
    const invocationStartedAt = Date.now();
    let modelInvoked = false;

    try {
      if (controller.signal.aborted) throw new Error("cancelled");
      const preparedInput = await this.prepareVisionInput(input.session.workerSessionId, input.visionInput.image, input.config, input.visionInput.taskType);
      if (controller.signal.aborted) throw new Error("cancelled");
      const runningSession = await this.sessionStore.setWorkerSessionStatus({
        workerSessionId: input.session.workerSessionId,
        status: "running",
        dispatchKind: input.session.dispatchKind,
        attemptNumber: 1,
        reason: "Dispatching vision worker task.",
      });
      if (runningSession.status !== "running") {
        controller.abort("cancelled");
        throw new Error("Vision worker is no longer runnable.");
      }
      await this.sessionStore.appendWorkerMessage({
        workerSessionId: input.session.workerSessionId,
        role: "system",
        content: "Vision worker invoked by Specialist Broker. Workspace writes are disabled.",
        metadata: {
          routeRole: "vision_worker",
          timeoutMs: input.config.timeoutMs,
          maxRetries: input.config.maxRetries,
          taskType: input.visionInput.taskType,
          sourceType: input.visionInput.image.sourceType,
        },
      });
      await this.sessionStore.appendWorkerMessage({
        workerSessionId: input.session.workerSessionId,
        role: "user",
        content: JSON.stringify(
          {
            objective: input.task.objective,
            constraints: input.task.constraints,
            acceptanceChecks: input.task.acceptanceChecks,
            image: input.visionInput.image,
            preparedInput: {
              originalImageRef: preparedInput.originalImageRef,
              processedImageRef: preparedInput.processedImageRef,
              mimeType: preparedInput.mimeType,
              originalBytes: preparedInput.originalBytes,
              processedBytes: preparedInput.processedBytes,
              originalWidth: preparedInput.originalWidth,
              originalHeight: preparedInput.originalHeight,
              processedWidth: preparedInput.processedWidth,
              processedHeight: preparedInput.processedHeight,
              preprocessing: preparedInput.preprocessing,
            },
          },
          null,
          2,
        ),
      });

      if (controller.signal.aborted) {
        throw new Error("cancelled");
      }

      modelInvoked = true;
      const result = await worker.runTask({
        task: input.task,
        preparedInput,
        workerSessionId: input.session.workerSessionId,
        signal: controller.signal,
      });

      if (controller.signal.aborted) throw new Error("cancelled");

      if (fallbackWorker) {
        await this.sessionStore.appendWorkerMessage({
          workerSessionId: input.session.workerSessionId,
          role: "system",
          content: "Vision model candidate selection completed before artifact publication.",
          metadata: {
            attempts: fallbackWorker.attempts,
            selectedFallbackIndex: fallbackWorker.selectedIndex,
          },
        });
      }

      const selectedConfig = fallbackWorker ? candidateConfigs[fallbackWorker.selectedIndex]! : input.config;
      await this.sessionStore.recordModelInvocation(input.session.parentSessionId, createModelAssignmentSnapshot({
        slot: "vision",
        config: selectedConfig,
        configRevision: input.session.modelAssignment?.configRevision ?? 0,
        fallbackIndex: fallbackWorker?.selectedIndex ?? 0,
        selectionReason: (fallbackWorker?.selectedIndex ?? 0) > 0 ? "ordered_fallback" : input.session.modelAssignment?.selectionReason ?? "primary",
        source: input.session.modelAssignment?.source ?? "settings",
      }), {
        result: "success",
        latencyMs: Date.now() - invocationStartedAt,
      }).catch(() => undefined);

      await this.sessionStore.appendWorkerMessage({
        workerSessionId: input.session.workerSessionId,
        role: "assistant",
        content: result.rawResponse,
      });

      if (controller.signal.aborted) throw new Error("cancelled");

      const artifact = buildVisionArtifact(result.artifact, preparedInput);
      const artifactRecord = await this.sessionStore.storeVisionArtifact({
        workerSessionId: input.session.workerSessionId,
        artifact,
      });

      if (controller.signal.aborted) throw new Error("cancelled");

      const completedSession = await this.sessionStore.setWorkerSessionStatus({
        workerSessionId: input.session.workerSessionId,
        status: "completed",
        dispatchKind: input.session.dispatchKind,
        attemptNumber: 1,
        reason: "Vision worker returned a valid vision artifact.",
      });
      if (completedSession.status !== "completed") throw new Error("cancelled");

      return {
        workerSessionId: input.session.workerSessionId,
        artifact: toVisionToolSummary(artifact, artifactRecord.artifactRef),
      };
    } catch (error) {
      if (modelInvoked && input.session.modelAssignment) {
        await this.sessionStore.recordModelInvocation(input.session.parentSessionId, input.session.modelAssignment, {
          result: "failure",
          latencyMs: Date.now() - invocationStartedAt,
        }).catch(() => undefined);
      }
      if (error instanceof VisionWorkerError && error.rawResponse && !controller.signal.aborted) {
        await this.sessionStore.appendWorkerMessage({
          workerSessionId: input.session.workerSessionId,
          role: "assistant",
          content: error.rawResponse,
          metadata: {
            errorType: error.type,
          },
        });
      }

      const workerError = toVisionWorkerError(error, input.session.workerSessionId, controller.signal);
      await this.sessionStore.setWorkerSessionStatus({
        workerSessionId: input.session.workerSessionId,
        status: workerError.errorType === "worker_interrupted" ? "cancelled" : "failed",
        dispatchKind: input.session.dispatchKind,
        attemptNumber: 1,
        reason: workerError.message,
        errorType: workerError.errorType,
        errorMessage: workerError.message,
      });
      return {
        workerSessionId: input.session.workerSessionId,
        error: workerError,
      };
    } finally {
      clearTimeout(timeout);
      if (this.activeControllers.get(input.session.workerSessionId) === controller) {
        this.activeControllers.delete(input.session.workerSessionId);
      }
    }
  }

  private async prepareVisionInput(
    workerSessionId: string,
    image: VisionImageRef,
    config: VisionWorkerModelConfig,
    taskType: VisionWorkerToolInput["taskType"],
  ): Promise<PreparedVisionInput> {
    const absoluteSourcePath = this.resolveVisionInputPath(image);
    let sourceBuffer: Buffer;
    try {
      sourceBuffer = await fs.readFile(absoluteSourcePath);
    } catch (error) {
      throw new VisionWorkerError(
        "input_validation_failed",
        `Failed to read image ${image.ref}: ${(error as Error).message}`,
      );
    }

    if (sourceBuffer.byteLength === 0) {
      throw new VisionWorkerError("input_validation_failed", `Image is empty: ${image.ref}`);
    }
    if (sourceBuffer.byteLength > config.maxImageBytes) {
      throw new VisionWorkerError(
        "input_validation_failed",
        `Image exceeds the configured size limit (${sourceBuffer.byteLength} > ${config.maxImageBytes}).`,
      );
    }

    const sourceExtension = normalizeFileExtension(path.extname(absoluteSourcePath));
    const originalImage = sharp(sourceBuffer, { animated: false });
    const metadata = await originalImage.metadata();
    if (!metadata.width || !metadata.height || !metadata.format) {
      throw new VisionWorkerError("input_validation_failed", `Unable to determine image dimensions for ${image.ref}.`);
    }

    const format = normalizeFileExtension(metadata.format);
    inferMimeType(format === "jpg" ? "jpeg" : format);
    const originalRef = await this.sessionStore.storeBinaryArtifact({
      workerSessionId,
      namespace: "images",
      filename: `original.${sourceExtension}`,
      content: sourceBuffer,
    });

    let pipeline = sharp(sourceBuffer, { animated: false });
    let cropped = false;
    if (image.crop) {
      pipeline = pipeline.extract({
        left: Math.max(0, Math.round(image.crop.x)),
        top: Math.max(0, Math.round(image.crop.y)),
        width: Math.max(1, Math.round(image.crop.width)),
        height: Math.max(1, Math.round(image.crop.height)),
      });
      cropped = true;
    }

    let resized = false;
    const cropWidth = image.crop ? Math.round(image.crop.width) : metadata.width;
    const cropHeight = image.crop ? Math.round(image.crop.height) : metadata.height;
    if (cropWidth > config.targetImageDimension || cropHeight > config.targetImageDimension) {
      pipeline = pipeline.resize({
        width: config.targetImageDimension,
        height: config.targetImageDimension,
        fit: "inside",
        withoutEnlargement: true,
      });
      resized = true;
    }

    let processedBuffer = await pipeline.webp({ quality: 80 }).toBuffer();
    let recompressed = processedBuffer.byteLength !== sourceBuffer.byteLength || format !== "webp";
    if (processedBuffer.byteLength > config.targetImageBytes) {
      processedBuffer = await sharp(processedBuffer).webp({ quality: 60 }).toBuffer();
      recompressed = true;
    }
    if (processedBuffer.byteLength > config.targetImageBytes) {
      throw new VisionWorkerError(
        "input_validation_failed",
        `Processed image still exceeds the configured size limit (${processedBuffer.byteLength} > ${config.targetImageBytes}).`,
      );
    }

    const processedMetadata = await sharp(processedBuffer).metadata();
    if (!processedMetadata.width || !processedMetadata.height) {
      throw new VisionWorkerError("input_validation_failed", "Unable to determine processed image dimensions.");
    }
    if (processedMetadata.width > config.maxImageDimension || processedMetadata.height > config.maxImageDimension) {
      throw new VisionWorkerError(
        "input_validation_failed",
        `Processed image exceeds the configured dimension limit (${processedMetadata.width}x${processedMetadata.height}).`,
      );
    }

    const processedRef = await this.sessionStore.storeBinaryArtifact({
      workerSessionId,
      namespace: "images",
      filename: "processed.webp",
      content: processedBuffer,
    });

    return {
      taskType,
      image,
      inputMode: config.imageInputMode,
      originalImageRef: originalRef.artifactRef,
      processedImageRef: processedRef.artifactRef,
      mimeType: "image/webp",
      originalBytes: sourceBuffer.byteLength,
      processedBytes: processedBuffer.byteLength,
      originalWidth: metadata.width,
      originalHeight: metadata.height,
      processedWidth: processedMetadata.width,
      processedHeight: processedMetadata.height,
      preprocessing: {
        resized,
        cropped,
        recompressed,
      },
      processedDataUrl: `data:image/webp;base64,${processedBuffer.toString("base64")}`,
    };
  }

  private resolveVisionInputPath(image: VisionImageRef): string {
    if (image.ref.startsWith("file://")) {
      return resolveInsideWorkspace(this.workspaceRoot, image.ref.slice("file://".length));
    }
    if (image.ref.startsWith("artifact://")) {
      return this.sessionStore.resolveArtifactPath(image.ref);
    }
    throw new VisionWorkerError("input_validation_failed", `Unsupported image ref: ${image.ref}`);
  }

  private async requireOwnedWorkerSession(
    parentSessionId: string,
    workerSessionId: string,
  ): Promise<{
    session: WorkerSessionRecord;
    warnings: LifecycleWarning[];
    scan: WorkerLifecycleEventScan;
  }> {
    if (!/^[A-Za-z0-9][A-Za-z0-9_-]{0,127}$/u.test(workerSessionId)) {
      throw Object.assign(new Error("Worker session identifier is invalid."), {
        code: "ERR_TOOL_INVALID_ARGUMENTS",
      });
    }
    let session: WorkerSessionRecord | undefined;
    try {
      session = await this.sessionStore.loadWorkerSession(workerSessionId);
    } catch {
      throw Object.assign(new Error("Worker session metadata is corrupt or unsafe."), {
        code: "ERR_TOOL_CORRUPT_RECORD",
      });
    }
    if (!session) {
      throw Object.assign(new Error("Worker session was not found."), { code: "ERR_TOOL_NOT_FOUND" });
    }
    if (session.workspaceId && session.workspaceId !== this.sessionStore.workspaceId) {
      throw Object.assign(new Error("Worker session belongs to another workspace."), {
        code: "ERR_TOOL_PERMISSION_DENIED",
      });
    }
    if (session.parentSessionId !== parentSessionId) {
      throw Object.assign(new Error("Worker session is not owned by the current session."), {
        code: "ERR_TOOL_PERMISSION_DENIED",
      });
    }
    if (
      session.workerSessionId !== workerSessionId ||
      !["coding", "vision"].includes(session.workerType) ||
      !["queued", "running", "completed", "failed", "cancelled"].includes(session.status) ||
      !["initial", "retry", "revise"].includes(session.dispatchKind) ||
      !Number.isSafeInteger(session.retryCount) || session.retryCount < 0 ||
      !Number.isSafeInteger(session.revisionCount) || session.revisionCount < 0 ||
      !Number.isSafeInteger(session.artifactCount) || session.artifactCount < 0 ||
      (session.statusVersion !== undefined && (!Number.isSafeInteger(session.statusVersion) || session.statusVersion < 0)) ||
      session.jsonlPath !== `worker-sessions/${workerSessionId}.jsonl` ||
      !Number.isFinite(Date.parse(session.createdAt)) ||
      !Number.isFinite(Date.parse(session.updatedAt))
    ) {
      throw Object.assign(new Error("Worker session metadata failed lifecycle validation."), {
        code: "ERR_TOOL_CORRUPT_RECORD",
      });
    }
    const warnings: LifecycleWarning[] = [];
    const scan = await this.sessionStore.scanWorkerLifecycleEvents(parentSessionId, workerSessionId);
    if (!session.workspaceId) {
      if (!scan.linkedFromParentSession) {
        throw Object.assign(new Error("Legacy worker ownership could not be proven from the parent session link."), {
          code: "ERR_TOOL_PERMISSION_DENIED",
        });
      }
      warnings.push({
        code: "legacy_record",
        message: "Worker workspace ownership was inferred from its workspace-scoped parent session.",
        recordId: workerSessionId,
      });
    }
    return { session, warnings, scan };
  }

  private publicWorkerEvents(
    session: WorkerSessionRecord,
    scan: WorkerLifecycleEventScan,
  ): WorkerPublicOutputEvent[] {
    const events: WorkerPublicOutputEvent[] = [];
    for (const event of scan.workerEvents) {
      if (event.recordType === "worker_status") {
        const summary = redactPublicWorkerText(
          event.reason ?? `Worker status changed to ${event.status}.`,
          this.workspaceRoot,
        );
        events.push({
          eventId: `status_${publicEventId([event.createdAt, event.status, event.dispatchKind, event.attemptNumber, summary])}`,
          workerSessionId: session.workerSessionId,
          createdAt: event.createdAt,
          kind: event.status === "failed" || event.status === "cancelled" ? "error" : "status",
          workerType: session.workerType,
          summary,
          status: event.status,
          details: {
            dispatchKind: event.dispatchKind,
            attemptNumber: event.attemptNumber,
          },
        });
      } else if (event.recordType === "worker_artifact") {
        const artifact = sanitizeWorkerArtifact(event.summary, this.workspaceRoot);
        events.push({
          eventId: `artifact_${event.artifactId}`,
          workerSessionId: session.workerSessionId,
          createdAt: event.createdAt,
          kind: "artifact",
          workerType: session.workerType,
          summary: artifact.summary,
          artifactRef: redactPublicWorkerText(event.artifactRef, this.workspaceRoot, 1_000),
          artifact,
          details: { artifactId: event.artifactId, artifactKind: artifact.kind },
        });
      } else {
        events.push({
          eventId: `cancel_${event.cancellationId}`,
          workerSessionId: session.workerSessionId,
          createdAt: event.createdAt,
          kind: event.finalStatus === "cancelled" ? "error" : "status",
          workerType: session.workerType,
          summary: redactPublicWorkerText(event.reason, this.workspaceRoot),
          status: event.finalStatus,
          details: {
            previousStatus: event.previousStatus,
            finalStatus: event.finalStatus,
            cancelled: event.cancelled,
            idempotent: event.idempotent,
            artifactCountPreserved: event.artifactCountPreserved,
          },
        });
      }
    }
    for (const event of scan.parentEvents) {
      if (event.recordType === "artifact_promotion") {
        events.push({
          eventId: `promotion_${event.promotionId}`,
          workerSessionId: session.workerSessionId,
          createdAt: event.createdAt,
          kind: "promotion",
          workerType: session.workerType,
          summary: `Artifact promoted with ${event.verificationSummary.length} verification result(s).`,
          artifactRef: redactPublicWorkerText(event.artifactRef, this.workspaceRoot, 1_000),
          details: redactPublicWorkerValue({
            promotedFields: event.promotedFields,
            changedFiles: event.changedFiles,
            riskSummary: event.riskSummary,
            verificationSummary: event.verificationSummary,
          }, this.workspaceRoot) as Record<string, unknown>,
        });
      } else {
        events.push({
          eventId: `verification_${event.decisionId}`,
          workerSessionId: session.workerSessionId,
          createdAt: event.createdAt,
          kind: "verification",
          workerType: session.workerType,
          summary: redactPublicWorkerText(event.reason, this.workspaceRoot),
          artifactRef: event.artifactRef
            ? redactPublicWorkerText(event.artifactRef, this.workspaceRoot, 1_000)
            : undefined,
          details: redactPublicWorkerValue({
            action: event.action,
            resultingState: event.resultingState,
            evidenceRefs: event.evidenceRefs,
          }, this.workspaceRoot) as Record<string, unknown>,
        });
      }
    }
    return events.sort((left, right) => {
      const byTime = right.createdAt.localeCompare(left.createdAt);
      return byTime !== 0 ? byTime : right.eventId.localeCompare(left.eventId);
    });
  }

  private workerStage(session: WorkerSessionRecord): WorkerLifecycleStage {
    if (session.status === "queued") return "queued";
    if (session.status === "completed") return "artifact_ready";
    if (session.status === "failed") return "failed";
    if (session.status === "cancelled") return "cancelled";
    if (session.dispatchKind === "retry") return "retrying";
    if (session.dispatchKind === "revise") return "revising";
    return "running";
  }

  private buildWorkerStatus(
    session: WorkerSessionRecord,
    ownershipWarnings: LifecycleWarning[],
    scan: WorkerLifecycleEventScan,
    events: WorkerPublicOutputEvent[],
  ): WorkerStatusSummary {
    const warnings = [...ownershipWarnings, ...scan.warnings].slice(0, 100);
    const activeController = this.activeControllers.get(session.workerSessionId);
    return {
      workerSessionId: session.workerSessionId,
      workerType: session.workerType,
      status: session.status,
      stage: this.workerStage(session),
      dispatchKind: session.dispatchKind,
      createdAt: session.createdAt,
      startedAt: session.startedAt,
      endedAt: session.endedAt,
      retryCount: session.retryCount,
      revisionCount: session.revisionCount,
      artifactCount: session.artifactCount,
      recentSummary: events[0]?.summary,
      ...(session.status === "running" && activeController && !activeController.signal.aborted
        ? { progress: { label: `${session.workerType} worker is active; numeric progress is unavailable.` } }
        : {}),
      terminal: ["completed", "failed", "cancelled"].includes(session.status),
      ownership: {
        workspaceId: this.sessionStore.workspaceId,
        sessionId: session.parentSessionId,
        parentSessionId: session.parentSessionId,
        visibility: session.workspaceId ? "current_session" : "legacy_inferred",
      },
      partial: scan.partial || warnings.length > 0,
      warnings,
    };
  }

  public async getWorkerStatus(parentSessionId: string, workerSessionId: string): Promise<WorkerStatusSummary> {
    const { session, warnings, scan } = await this.requireOwnedWorkerSession(parentSessionId, workerSessionId);
    const events = this.publicWorkerEvents(session, scan);
    return this.buildWorkerStatus(session, warnings, scan, events);
  }

  public async getWorkerPublicOutput(
    parentSessionId: string,
    workerSessionId: string,
  ): Promise<WorkerPublicOutputSnapshot> {
    const { session, warnings, scan } = await this.requireOwnedWorkerSession(parentSessionId, workerSessionId);
    const events = this.publicWorkerEvents(session, scan);
    const status = this.buildWorkerStatus(session, warnings, scan, events);
    const rawResult = session.workerType === "coding"
      ? await this.getCodingWorkerResult(workerSessionId)
      : await this.getVisionWorkerResult(workerSessionId);
    let availableResult: InvokeCodingWorkerResult | InvokeVisionWorkerResult | undefined;
    if (rawResult?.artifact) {
      const artifact = sanitizeWorkerArtifact(rawResult.artifact, this.workspaceRoot);
      availableResult = rawResult.artifact.kind === "vision_artifact"
        ? {
            workerSessionId,
            artifact: {
              ...(artifact as Extract<WorkerArtifactSummary, { kind: "vision_artifact" }>),
              artifactRef: redactPublicWorkerText(
                (rawResult as InvokeVisionWorkerResult).artifact!.artifactRef,
                this.workspaceRoot,
                1_000,
              ),
            },
          }
        : { workerSessionId, artifact: artifact as Extract<WorkerArtifactSummary, { kind: "code_artifact" }> };
    } else if (rawResult?.error) {
      availableResult = {
        workerSessionId,
        error: {
          ...rawResult.error,
          message: redactPublicWorkerText(rawResult.error.message, this.workspaceRoot, 1_000),
        },
      };
    }
    return {
      status,
      events,
      scanned: scan.scanned,
      partial: status.partial,
      warnings: status.warnings,
      availableResult,
    };
  }

  public async previewWorkerCancellation(
    parentSessionId: string,
    workerSessionId: string,
  ): Promise<{
    workerType: WorkerSessionRecord["workerType"];
    status: WorkerSessionRecord["status"];
    statusVersion: number;
    artifactCount: number;
  }> {
    const { session } = await this.requireOwnedWorkerSession(parentSessionId, workerSessionId);
    return {
      workerType: session.workerType,
      status: session.status,
      statusVersion: session.statusVersion ?? 0,
      artifactCount: session.artifactCount,
    };
  }

  public async cancelOwnedWorkerSession(input: {
    parentSessionId: string;
    workerSessionId: string;
    reason?: string;
    approvedStatusVersion?: number;
  }): Promise<WorkerCancelResult> {
    const { session, warnings } = await this.requireOwnedWorkerSession(input.parentSessionId, input.workerSessionId);
    const requestedAt = now();
    const reason = redactPublicWorkerText(input.reason ?? "Cancelled by governor.", this.workspaceRoot, 1_000);
    const transition = await this.sessionStore.cancelOwnedWorkerSession({
      workerSessionId: input.workerSessionId,
      parentSessionId: input.parentSessionId,
      requestedBySessionId: input.parentSessionId,
      requestedAt,
      reason,
      expectedStatusVersion: input.approvedStatusVersion,
    });
    if (transition.changed && transition.record.finalStatus === "cancelled") {
      const controller = this.activeControllers.get(input.workerSessionId);
      if (controller && !controller.signal.aborted) {
        controller.abort("cancelled");
      } else {
        this.pendingCancellations.set(input.workerSessionId, {
          parentSessionId: input.parentSessionId,
          requestedAt,
          reason,
        });
      }
    } else {
      this.pendingCancellations.delete(input.workerSessionId);
    }
    return {
      workerSessionId: input.workerSessionId,
      requestedBySessionId: input.parentSessionId,
      requestedAt,
      reason,
      previousStatus: transition.previousStatus,
      finalStatus: transition.record.finalStatus,
      cancelled: transition.record.cancelled,
      idempotent: transition.record.idempotent,
      artifactCountPreserved: transition.record.artifactCountPreserved,
      ownership: {
        workspaceId: this.sessionStore.workspaceId,
        sessionId: input.parentSessionId,
        parentSessionId: input.parentSessionId,
        visibility: session.workspaceId ? "current_session" : "legacy_inferred",
      },
      partial: warnings.length > 0,
      warnings,
    };
  }

  public async cancelWorkerSession(
    workerSessionId: string,
    reason = "Cancelled by governor.",
  ): Promise<WorkerSessionRecord | undefined> {
    const session = await this.sessionStore.loadWorkerSession(workerSessionId);
    if (!session) return undefined;
    await this.cancelOwnedWorkerSession({
      parentSessionId: session.parentSessionId,
      workerSessionId,
      reason,
    });
    return this.sessionStore.loadWorkerSession(workerSessionId);
  }

  public async getCodingWorkerResult(workerSessionId: string): Promise<InvokeCodingWorkerResult | undefined> {
    const session = await this.sessionStore.loadWorkerSession(workerSessionId);
    if (!session) {
      return undefined;
    }

    const events = (await this.sessionStore.scanWorkerLifecycleEvents(
      session.parentSessionId,
      workerSessionId,
    )).workerEvents;
    const artifact = [...events]
      .reverse()
      .find((event): event is Extract<WorkerSessionEvent, { recordType: "worker_artifact" }> => event.recordType === "worker_artifact");

    return artifact && artifact.summary.kind === "code_artifact"
      ? {
          workerSessionId,
          artifact: artifact.summary,
        }
      : {
          workerSessionId,
          error:
            session.lastErrorType && session.lastErrorMessage
              ? {
                  workerSessionId,
                  errorType: session.lastErrorType,
                  message: session.lastErrorMessage,
                  retryable: false,
                }
              : undefined,
        };
  }

  public async getVisionWorkerResult(workerSessionId: string): Promise<InvokeVisionWorkerResult | undefined> {
    const session = await this.sessionStore.loadWorkerSession(workerSessionId);
    if (!session) {
      return undefined;
    }

    const events = (await this.sessionStore.scanWorkerLifecycleEvents(
      session.parentSessionId,
      workerSessionId,
    )).workerEvents;
    const artifact = [...events]
      .reverse()
      .find((event): event is Extract<WorkerSessionEvent, { recordType: "worker_artifact" }> => event.recordType === "worker_artifact");

    return artifact && artifact.summary.kind === "vision_artifact"
      ? {
          workerSessionId,
          artifact: {
            ...artifact.summary,
            artifactRef: artifact.artifactRef,
          },
        }
      : {
          workerSessionId,
          error:
            session.lastErrorType && session.lastErrorMessage
              ? {
                  workerSessionId,
                  errorType: session.lastErrorType,
                  message: session.lastErrorMessage,
                  retryable: false,
                }
              : undefined,
        };
  }

  public async readWorkerHistory(workerSessionId: string): Promise<WorkerSessionEvent[]> {
    return this.sessionStore.loadWorkerEvents(workerSessionId);
  }

  private async resolveWorkerContext(task: WorkerTask, config: CodingWorkerModelConfig): Promise<string> {
    const blocks: string[] = [];
    let remainingChars = config.maxContextChars;
    const selectedRefs = task.contextRefs.slice(0, config.maxContextFiles);

    for (const ref of selectedRefs) {
      if (remainingChars <= 0) {
        break;
      }

      if (typeof ref === "string" && ref.startsWith("file://")) {
        const relativePath = ref.slice("file://".length);
        const absolutePath = resolveInsideWorkspace(this.workspaceRoot, relativePath);
        let content: string;
        try {
          content = await fs.readFile(absolutePath, "utf8");
        } catch (error) {
          content = `[Failed to read file ref ${ref}: ${(error as Error).message}]`;
        }

        const truncated = truncateBlock(content, remainingChars);
        blocks.push(`### ${ref}\n${truncated}`);
        remainingChars -= truncated.length;
        continue;
      }

      if (typeof ref === "string" && ref.startsWith("artifact://")) {
        const content = (await this.sessionStore.readArtifactRef(ref)) ?? `[Artifact not found: ${ref}]`;
        const truncated = truncateBlock(content, remainingChars);
        blocks.push(`### ${ref}\n${truncated}`);
        remainingChars -= truncated.length;
        continue;
      }

      if (typeof ref !== "string") {
        const summaryContent = `### ${ref.label}\n${truncateBlock(ref.summary, remainingChars)}`;
        blocks.push(summaryContent);
        remainingChars -= summaryContent.length;
      }
    }

    if (task.contextRefs.length > selectedRefs.length) {
      blocks.push(`[${task.contextRefs.length - selectedRefs.length} additional context ref(s) omitted due to worker limits.]`);
    }

    return blocks.join("\n\n");
  }
}
