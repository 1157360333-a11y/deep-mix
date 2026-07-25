import type {
  ArtifactPromotionRecord,
  DiagnosticEntry,
  DiagnosticKind,
  DiagnosticReportRecord,
  RollbackMode,
  ToolResult,
  WorkerArtifactRecord,
} from "../../../../shared-schema/src/index.js";

import { applyArtifactPatch, parseArtifactPatch } from "../../artifact-patch.js";
import type {
  RuntimeToolExecutionContext,
  RuntimeToolSpec,
  ToolAccessResolutionContext,
  ToolModule,
} from "../../tool-module.js";

interface ApplyArtifactPatchArgs {
  workerSessionId: string;
  artifactRef: string;
  verificationCommands: Array<{
    toolName: "run_tests" | "lint" | "typecheck";
    command: string;
  }>;
}

interface CheckpointArgs {
  checkpointId: string;
  mode?: RollbackMode;
}

interface UndoArgs {
  checkpointId?: string;
  mode?: RollbackMode;
}

interface CheckpointManifestView {
  trackedFiles: Array<{
    path: string;
    existed: boolean;
  }>;
  sessionSnapshot: {
    sessionId: string;
  };
}

function assertPinnedArtifact(
  args: ApplyArtifactPatchArgs,
  artifact: WorkerArtifactRecord,
): asserts artifact is WorkerArtifactRecord & { summary: Extract<WorkerArtifactRecord["summary"], { kind: "code_artifact" }> } {
  if (artifact.summary.kind !== "code_artifact") {
    throw new Error(`Worker session ${args.workerSessionId} does not have a code artifact.`);
  }
  if (artifact.artifactRef !== args.artifactRef) {
    throw new Error("The requested artifactRef does not match the latest worker artifact.");
  }
  const pinnedTestCommands = args.verificationCommands
    .filter((entry) => entry.toolName === "run_tests")
    .map((entry) => entry.command);
  if (JSON.stringify(pinnedTestCommands) !== JSON.stringify(artifact.summary.testCommands)) {
    throw new Error("The requested verification commands do not match the pinned worker artifact.");
  }
  const lintCount = args.verificationCommands.filter((entry) => entry.toolName === "lint").length;
  const typecheckCount = args.verificationCommands.filter((entry) => entry.toolName === "typecheck").length;
  if (lintCount > 1 || typecheckCount > 1) {
    throw new Error("At most one lint and one typecheck command may accompany an artifact promotion.");
  }
}

function uniqueNormalizedPaths(paths: readonly string[], context: ToolAccessResolutionContext): string[] {
  return [...new Set(paths.map((entry) => context.paths.normalize(entry)))];
}

async function resolveArtifactPatchAccess(
  args: ApplyArtifactPatchArgs,
  context: ToolAccessResolutionContext,
) {
  const artifact = await context.persistence.loadLatestWorkerArtifact(args.workerSessionId);
  if (!artifact) {
    throw new Error(`No artifact found for worker session ${args.workerSessionId}.`);
  }
  assertPinnedArtifact(args, artifact);
  const decisions = await context.persistence.loadSupervisorDecisions(
    context.sessionId,
    args.workerSessionId,
  );
  const latestDecision = [...decisions].reverse()[0];
  if (latestDecision?.action !== "accept" || latestDecision.artifactRef !== args.artifactRef) {
    throw new Error("The pinned artifact is not the latest artifact accepted by the supervisor.");
  }
  const patchContent = await context.persistence.readArtifactRef(artifact.summary.patchRef);
  if (!patchContent) {
    throw new Error(`Artifact patch not found: ${artifact.summary.patchRef}`);
  }
  const paths = uniqueNormalizedPaths(
    parseArtifactPatch(patchContent).map((change) => change.path),
    context,
  );
  return [
    {
      kind: "filesystem_read" as const,
      paths: [artifact.summary.patchRef],
      reason: "Read the accepted worker artifact patch from trusted state.",
    },
    {
      kind: "filesystem_write" as const,
      paths,
      reason: "Apply the accepted worker artifact patch to its declared workspace paths.",
    },
  ];
}

async function resolveCheckpointWriteAccess(
  checkpointId: string,
  mode: RollbackMode,
  context: ToolAccessResolutionContext,
) {
  if (mode === "conversation") return [];

  const manifest = (await context.persistence.loadCheckpointManifest(checkpointId)) as CheckpointManifestView;
  if (manifest.sessionSnapshot.sessionId !== context.sessionId) {
    throw new Error(`Checkpoint ${checkpointId} does not belong to session ${context.sessionId}.`);
  }
  return [
    {
      kind: "filesystem_write" as const,
      paths: uniqueNormalizedPaths(
        manifest.trackedFiles.map((entry) => entry.path),
        context,
      ),
      reason: `Restore workspace files tracked by checkpoint ${checkpointId}.`,
    },
  ];
}

function toDiagnosticEntryFromToolResult(kind: DiagnosticKind, result: ToolResult): DiagnosticEntry {
  if (kind === "run_tests") {
    const content = (result.structuredContent ?? {}) as {
      command?: string;
      exitCode?: number;
      failed?: number;
      passed?: number;
    };
    const failed = typeof content.failed === "number" ? content.failed : result.success ? 0 : 1;
    const passed = typeof content.passed === "number" ? content.passed : undefined;
    return {
      kind,
      status: result.success ? "ok" : "failed",
      ok: result.success,
      summary: result.success
        ? `run_tests passed${passed !== undefined ? ` with ${passed} passing test(s)` : ""}.`
        : `run_tests failed${failed > 0 ? ` with ${failed} failing test(s)` : ""}.`,
      command: content.command,
      exitCode: typeof content.exitCode === "number" ? content.exitCode : undefined,
      errorCount: failed,
      rawOutput: result.output,
    };
  }

  const content = (result.structuredContent ?? {}) as {
    command?: string;
    exitCode?: number;
    errorCount?: number;
    warningCount?: number;
  };
  const errorCount = typeof content.errorCount === "number" ? content.errorCount : result.success ? 0 : 1;
  const warningCount = typeof content.warningCount === "number" ? content.warningCount : 0;
  return {
    kind,
    status: result.success ? "ok" : "failed",
    ok: result.success,
    summary: result.success
      ? `${kind} passed.`
      : `${kind} failed with ${errorCount} error(s) and ${warningCount} warning(s).`,
    command: content.command,
    exitCode: typeof content.exitCode === "number" ? content.exitCode : undefined,
    errorCount,
    warningCount,
    rawOutput: result.output,
  };
}

async function runPostEditDiagnostics(input: {
  context: RuntimeToolExecutionContext;
  trackedFiles: string[];
  lintCommand?: string;
  typecheckCommand?: string;
  verificationResults: ToolResult[];
}): Promise<{
  diagnostics: DiagnosticEntry[];
  report: DiagnosticReportRecord;
}> {
  const { context } = input;
  const executeManual = context.moduleContext.tools.executeManual;
  const diagnostics: DiagnosticEntry[] = [];

  const lspResult = await executeManual(
    "lsp_diagnostics",
    { paths: input.trackedFiles },
    context.sessionId,
  );
  diagnostics.push((lspResult.structuredContent ?? {}) as DiagnosticEntry);

  if (input.lintCommand) {
    const lintResult = input.verificationResults.find((result) => result.toolName === "lint");
    if (!lintResult) throw new Error("The pinned lint verification result is missing.");
    diagnostics.push(toDiagnosticEntryFromToolResult("lint", lintResult));
  } else {
    const lintResult = await executeManual(
      "lint_diagnostics",
      { paths: input.trackedFiles },
      context.sessionId,
    );
    diagnostics.push((lintResult.structuredContent ?? {}) as DiagnosticEntry);
  }

  if (input.typecheckCommand) {
    const typecheckResult = input.verificationResults.find((result) => result.toolName === "typecheck");
    if (!typecheckResult) throw new Error("The pinned typecheck verification result is missing.");
    diagnostics.push(toDiagnosticEntryFromToolResult("typecheck", typecheckResult));
  } else {
    const typecheckResult = await executeManual(
      "typecheck_diagnostics",
      { paths: input.trackedFiles },
      context.sessionId,
    );
    diagnostics.push((typecheckResult.structuredContent ?? {}) as DiagnosticEntry);
  }

  if (diagnostics.some((entry) => entry.status === "unavailable")) {
    diagnostics.push(
      ...input.verificationResults
        .filter((result) => result.toolName === "run_tests")
        .map((result) => toDiagnosticEntryFromToolResult("run_tests", result)),
    );
  }

  const report: DiagnosticReportRecord = {
    recordType: "diagnostic_report",
    sessionId: context.sessionId,
    createdAt: context.moduleContext.clock.now(),
    trigger: "apply_artifact_patch",
    trackedFiles: input.trackedFiles,
    diagnostics,
  };
  await context.moduleContext.persistence.recordDiagnosticReport(report);
  return { diagnostics, report };
}

function createApplyArtifactPatchTool(): RuntimeToolSpec {
  return {
    name: "apply_artifact_patch",
    description: "Apply an accepted worker artifact patch after approval, checkpoint, and promotion logging.",
    inputSchema: {
      type: "object",
      additionalProperties: false,
      required: ["workerSessionId", "artifactRef", "verificationCommands"],
      properties: {
        workerSessionId: { type: "string", minLength: 1 },
        artifactRef: { type: "string", minLength: 1 },
        verificationCommands: {
          type: "array",
          items: {
            type: "object",
            additionalProperties: false,
            required: ["toolName", "command"],
            properties: {
              toolName: { type: "string", enum: ["run_tests", "lint", "typecheck"] },
              command: { type: "string", minLength: 1 },
            },
          },
        },
      },
    },
    readOnly: false,
    permissionCategory: "write_file",
    sideEffectLevel: "high",
    timeoutCategory: "slow",
    groups: ["recovery", "worker-artifacts"],
    selection: {
      groups: ["recovery", "worker-artifacts"],
      keywords: ["apply artifact", "worker artifact", "应用产物", "应用补丁"],
    },
    checkpoint: {
      mode: "before_write",
      scope: "pre_patch",
      reason: "Before applying an accepted worker artifact patch.",
      restoreOnFailure: false,
    },
    resolveAccess: (rawArgs, context) =>
      resolveArtifactPatchAccess(rawArgs as ApplyArtifactPatchArgs, context),
    execute: async (rawArgs, context) => {
      const args = rawArgs as ApplyArtifactPatchArgs;
      const startedAt = context.moduleContext.clock.now();
      const workerSession = await context.moduleContext.persistence.loadWorkerSession(args.workerSessionId);
      if (!workerSession) {
        throw new Error(`Unknown worker session: ${args.workerSessionId}`);
      }
      const artifact = await context.moduleContext.persistence.loadLatestWorkerArtifact(args.workerSessionId);
      if (!artifact) {
        throw new Error(`No code artifact available for worker session ${args.workerSessionId}.`);
      }
      assertPinnedArtifact(args, artifact);

      const decisions = await context.moduleContext.persistence.loadSupervisorDecisions(
        context.sessionId,
        args.workerSessionId,
      );
      const latestDecision = [...decisions].reverse()[0];
      if (!latestDecision || latestDecision.action !== "accept") {
        throw new Error("apply_artifact_patch requires a prior supervisor accept decision.");
      }
      if (latestDecision.artifactRef !== args.artifactRef) {
        throw new Error("The latest accepted artifact is stale. Re-run accept for the newest worker artifact.");
      }

      const patchContent = await context.moduleContext.persistence.readArtifactRef(artifact.summary.patchRef);
      if (!patchContent) {
        throw new Error(`Artifact patch missing: ${artifact.summary.patchRef}`);
      }
      const trackedFiles = [
        ...new Set(
          parseArtifactPatch(patchContent).map((change) =>
            context.moduleContext.paths.normalize(change.path),
          ),
        ),
      ];
      if (!context.checkpoint) {
        throw new Error("Runtime did not create the required pre-patch checkpoint.");
      }

      try {
        await applyArtifactPatch(context.workspaceRoot, patchContent, context.signal);
      } catch (error) {
        try {
          await context.moduleContext.persistence.restoreCheckpoint({
            sessionId: context.sessionId,
            checkpointId: context.checkpoint.checkpointId,
            mode: "code",
            reason: "Automatic rollback after accepted artifact patch publication failed or was interrupted.",
          });
        } catch (rollbackError) {
          const combined = new Error(
            `Accepted artifact patch failed and automatic checkpoint restore also failed: ${(rollbackError as Error).message}`,
          );
          (combined as Error & { cause?: unknown }).cause = error;
          throw combined;
        }
        throw error;
      }

      const verificationResults: ToolResult[] = [];
      const executePostEditVerification = context.executePostEditVerification;
      if (!executePostEditVerification) {
        throw new Error("apply_artifact_patch is missing its scoped post-edit verification capability.");
      }
      for (const verificationCommand of args.verificationCommands) {
        verificationResults.push(
          await executePostEditVerification(
            verificationCommand.toolName,
            { command: verificationCommand.command, cwd: "." },
          ),
        );
      }
      const lintCommand = args.verificationCommands.find((entry) => entry.toolName === "lint")?.command;
      const typecheckCommand = args.verificationCommands.find((entry) => entry.toolName === "typecheck")?.command;

      const diagnosticsResult = await runPostEditDiagnostics({
        context,
        trackedFiles,
        lintCommand,
        typecheckCommand,
        verificationResults,
      });

      const promotionRecord: ArtifactPromotionRecord = {
        recordType: "artifact_promotion",
        promotionId: context.moduleContext.ids.create(),
        sessionId: context.sessionId,
        workerSessionId: args.workerSessionId,
        createdAt: context.moduleContext.clock.now(),
        artifactRef: artifact.artifactRef,
        promotedFields: [
          "summary",
          "changedFiles",
          "testCommands",
          "risks",
          "confidence",
          "patchRef",
          "verificationSummary",
        ],
        changedFiles: artifact.summary.changedFiles,
        riskSummary: artifact.summary.risks,
        verificationSummary: verificationResults.map(
          (result) => `${result.toolName}:${result.success ? "ok" : "failed"}`,
        ),
      };
      await context.moduleContext.persistence.recordPromotion(promotionRecord);

      const verificationSucceeded = verificationResults.every((result) => result.success);
      const diagnosticFailures = diagnosticsResult.diagnostics.filter(
        (entry) => entry.status === "failed",
      ).length;
      const allSucceeded = verificationSucceeded && diagnosticFailures === 0;
      const structuredContent = {
        checkpointId: context.checkpoint.checkpointId,
        trackedFiles,
        artifactSummary: artifact.summary,
        verificationResults,
        diagnostics: diagnosticsResult.diagnostics,
        diagnosticReport: diagnosticsResult.report,
      };
      return {
        toolName: "apply_artifact_patch",
        callId: context.callId,
        startedAt,
        endedAt: context.moduleContext.clock.now(),
        success: allSucceeded,
        output: JSON.stringify(structuredContent),
        structuredContent,
        error: allSucceeded
          ? undefined
          : "Verification or post-edit diagnostics failed after patch application.",
      };
    },
  };
}

function createRollbackCheckpointTool(): RuntimeToolSpec {
  return {
    name: "rollback_checkpoint",
    description: "Restore code and/or conversation state from a known checkpoint.",
    inputSchema: {
      type: "object",
      additionalProperties: false,
      required: ["checkpointId"],
      properties: {
        checkpointId: { type: "string", minLength: 1 },
        mode: { type: "string", enum: ["conversation", "code", "both"] },
      },
    },
    readOnly: false,
    permissionCategory: "write_file",
    sideEffectLevel: "high",
    timeoutCategory: "default",
    groups: ["recovery", "checkpoints"],
    selection: {
      groups: ["recovery", "checkpoints"],
      keywords: ["rollback", "checkpoint", "回滚", "检查点"],
    },
    resolveAccess: (rawArgs, context) => {
      const args = rawArgs as CheckpointArgs;
      return resolveCheckpointWriteAccess(args.checkpointId, args.mode ?? "both", context);
    },
    execute: async (rawArgs, context) => {
      const args = rawArgs as CheckpointArgs;
      const startedAt = context.moduleContext.clock.now();
      const rollback = await context.moduleContext.persistence.restoreCheckpoint({
        sessionId: context.sessionId,
        checkpointId: args.checkpointId,
        mode: args.mode ?? "both",
        reason: `rollback_checkpoint:${args.checkpointId}`,
      });
      return {
        toolName: "rollback_checkpoint",
        callId: context.callId,
        startedAt,
        endedAt: context.moduleContext.clock.now(),
        success: true,
        output: JSON.stringify(rollback),
        structuredContent: rollback,
      };
    },
  };
}

function createUndoTool(): RuntimeToolSpec {
  return {
    name: "undo",
    description: "Restore the most recent undo candidate checkpoint or an explicitly provided checkpoint.",
    inputSchema: {
      type: "object",
      additionalProperties: false,
      properties: {
        checkpointId: { type: "string", minLength: 1 },
        mode: { type: "string", enum: ["conversation", "code", "both"] },
      },
    },
    readOnly: false,
    permissionCategory: "write_file",
    sideEffectLevel: "high",
    timeoutCategory: "default",
    groups: ["recovery", "checkpoints"],
    selection: {
      groups: ["recovery", "checkpoints"],
      keywords: ["undo", "revert", "撤销", "恢复"],
    },
    resolveAccess: async (rawArgs, context) => {
      const args = (rawArgs ?? {}) as UndoArgs;
      const checkpointId =
        args.checkpointId ??
        (await context.persistence.listUndoCandidates(context.sessionId))[0]?.checkpointId;
      if (!checkpointId) {
        throw new Error("No undo candidate is available for the current session.");
      }
      return resolveCheckpointWriteAccess(checkpointId, args.mode ?? "both", context);
    },
    execute: async (rawArgs, context) => {
      const args = (rawArgs ?? {}) as UndoArgs;
      const startedAt = context.moduleContext.clock.now();
      const checkpointId =
        args.checkpointId ??
        (await context.moduleContext.persistence.listUndoCandidates(context.sessionId))[0]?.checkpointId;
      if (!checkpointId) {
        throw new Error("No undo candidate is available for the current session.");
      }
      const rollback = await context.moduleContext.persistence.restoreCheckpoint({
        sessionId: context.sessionId,
        checkpointId,
        mode: args.mode ?? "both",
        reason: args.checkpointId ? `undo:${args.checkpointId}` : "undo:last_candidate",
      });
      return {
        toolName: "undo",
        callId: context.callId,
        startedAt,
        endedAt: context.moduleContext.clock.now(),
        success: true,
        output: JSON.stringify(rollback),
        structuredContent: rollback,
      };
    },
  };
}

export const recoveryToolModule: ToolModule = {
  manifest: {
    id: "builtin.recovery",
    version: "1.0.0",
    description: "Accepted worker artifact promotion, checkpoint rollback, and undo tools.",
    source: "built_in",
  },
  create: () => [
    createApplyArtifactPatchTool(),
    createRollbackCheckpointTool(),
    createUndoTool(),
  ],
};
