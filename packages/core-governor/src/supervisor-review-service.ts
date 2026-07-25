import { randomUUID } from "node:crypto";
import type {
  InvokeCodingWorkerResult,
  RollbackMode,
  SupervisorDecision,
  SupervisorDecisionRecord,
  SupervisorState,
  ToolResult,
  WorkerTask,
} from "../../shared-schema/src/index.js";
import { SessionStore } from "../../persistence/src/index.js";
import { SpecialistBroker } from "../../specialist-broker/src/index.js";
import { ToolRuntime } from "../../tool-runtime/src/index.js";

interface SupervisorReviewServiceOptions {
  maxReviewAttempts?: number;
}

function now(): string {
  return new Date().toISOString();
}

function mapDecisionToState(action: SupervisorDecision["action"]): SupervisorState {
  switch (action) {
    case "accept":
      return "accepted";
    case "revise":
      return "revising";
    case "retryWithMoreContext":
      return "retrying";
    case "fallbackToGovernor":
      return "governor_fallback";
    case "continueVerification":
      return "verifying";
    case "abort":
      return "aborted";
  }
}

function parseVerificationCommand(rawCommand: string): {
  toolName: "run_tests" | "lint" | "typecheck" | "read_file" | "git_diff";
  arguments: unknown;
} {
  const normalized = rawCommand.trim();
  const [head, ...rest] = normalized.includes(":")
    ? normalized.split(":")
    : normalized.split(/\s+/);
  const payload = normalized.includes(":")
    ? normalized.slice(normalized.indexOf(":") + 1).trim()
    : rest.join(" ").trim();

  switch (head) {
    case "run_tests":
    case "lint":
    case "typecheck":
      return {
        toolName: head,
        arguments: {
          command: payload,
          cwd: ".",
        },
      };
    case "read_file":
      return {
        toolName: "read_file",
        arguments: {
          path: payload,
        },
      };
    case "git_diff":
      return {
        toolName: "git_diff",
        arguments: payload ? { pathspec: payload, cwd: "." } : { cwd: "." },
      };
    default:
      throw new Error(`Unsupported verification command: ${rawCommand}`);
  }
}

export class SupervisorReviewService {
  private readonly maxReviewAttempts: number;

  public constructor(
    private readonly sessionStore: SessionStore,
    private readonly toolRuntime: ToolRuntime,
    private readonly specialistBroker: SpecialistBroker,
    options?: SupervisorReviewServiceOptions,
  ) {
    this.maxReviewAttempts = options?.maxReviewAttempts ?? 3;
  }

  public async continueVerification(input: {
    workerSessionId: string;
    decision: SupervisorDecision;
  }): Promise<{
    decision: SupervisorDecisionRecord;
    verificationResults: ToolResult[];
    canAccept: boolean;
  }> {
    if (!input.decision.verificationCommands?.length) {
      throw new Error("continueVerification requires verificationCommands.");
    }

    const { sessionId } = await this.loadWorkerParentSession(input.workerSessionId);
    const decision = await this.recordDecision({
      sessionId,
      workerSessionId: input.workerSessionId,
      decision: input.decision,
    });
    const verificationResults: ToolResult[] = [];
    for (const command of input.decision.verificationCommands) {
      const parsed = parseVerificationCommand(command);
      verificationResults.push(await this.toolRuntime.executeManualTool(parsed.toolName, parsed.arguments, sessionId));
    }

    return {
      decision,
      verificationResults,
      canAccept: verificationResults.every((result) => result.success),
    };
  }

  public async accept(input: {
    workerSessionId: string;
    decision: SupervisorDecision;
  }): Promise<SupervisorDecisionRecord> {
    const { sessionId } = await this.loadWorkerParentSession(input.workerSessionId);
    const artifact = await this.sessionStore.loadLatestWorkerArtifact(input.workerSessionId);
    if (!artifact) {
      throw new Error("Cannot accept a worker session without a code artifact.");
    }

    return this.recordDecision({
      sessionId,
      workerSessionId: input.workerSessionId,
      decision: input.decision,
      artifactRef: artifact.artifactRef,
    });
  }

  public async revise(input: {
    workerSessionId: string;
    decision: SupervisorDecision;
    revisionRequest: string;
  }): Promise<{
    decision: SupervisorDecisionRecord;
    result: InvokeCodingWorkerResult;
  }> {
    await this.assertReviewBudget(input.workerSessionId);
    const { sessionId } = await this.loadWorkerParentSession(input.workerSessionId);
    const decision = await this.recordDecision({
      sessionId,
      workerSessionId: input.workerSessionId,
      decision: input.decision,
    });
    const result = await this.specialistBroker.reviseCodingWorker({
      workerSessionId: input.workerSessionId,
      revisionRequest: input.revisionRequest,
    });
    return { decision, result };
  }

  public async retryWithMoreContext(input: {
    workerSessionId: string;
    decision: SupervisorDecision;
  }): Promise<{
    decision: SupervisorDecisionRecord;
    result: InvokeCodingWorkerResult;
  }> {
    if (!input.decision.extraContextRefs?.length) {
      throw new Error("retryWithMoreContext requires extraContextRefs.");
    }
    await this.assertReviewBudget(input.workerSessionId);
    const { sessionId } = await this.loadWorkerParentSession(input.workerSessionId);
    const decision = await this.recordDecision({
      sessionId,
      workerSessionId: input.workerSessionId,
      decision: input.decision,
    });
    const result = await this.specialistBroker.retryCodingWorkerWithMoreContext({
      workerSessionId: input.workerSessionId,
      extraContextRefs: input.decision.extraContextRefs,
    });
    return { decision, result };
  }

  public async fallbackToGovernor(input: {
    workerSessionId: string;
    decision: SupervisorDecision;
  }): Promise<SupervisorDecisionRecord> {
    const { sessionId } = await this.loadWorkerParentSession(input.workerSessionId);
    return this.recordDecision({
      sessionId,
      workerSessionId: input.workerSessionId,
      decision: input.decision,
    });
  }

  public async abort(input: {
    workerSessionId: string;
    decision: SupervisorDecision;
  }): Promise<SupervisorDecisionRecord> {
    const { sessionId } = await this.loadWorkerParentSession(input.workerSessionId);
    return this.recordDecision({
      sessionId,
      workerSessionId: input.workerSessionId,
      decision: input.decision,
    });
  }

  public async applyAcceptedPatch(input: {
    workerSessionId: string;
    lintCommand?: string;
    typecheckCommand?: string;
  }): Promise<ToolResult> {
    const { sessionId } = await this.loadWorkerParentSession(input.workerSessionId);
    const artifact = await this.sessionStore.loadLatestWorkerArtifact(input.workerSessionId);
    if (!artifact || artifact.summary.kind !== "code_artifact") {
      throw new Error(`No code artifact is available for worker session ${input.workerSessionId}.`);
    }
    const verificationCommands = [
      ...artifact.summary.testCommands.map((command) => ({
        toolName: "run_tests" as const,
        command,
      })),
      ...(input.lintCommand
        ? [{ toolName: "lint" as const, command: input.lintCommand }]
        : []),
      ...(input.typecheckCommand
        ? [{ toolName: "typecheck" as const, command: input.typecheckCommand }]
        : []),
    ];
    return this.toolRuntime.executeManualTool(
      "apply_artifact_patch",
      {
        workerSessionId: input.workerSessionId,
        artifactRef: artifact.artifactRef,
        verificationCommands,
      },
      sessionId,
    );
  }

  public async undo(input: {
    sessionId: string;
    checkpointId?: string;
    mode?: RollbackMode;
  }): Promise<ToolResult> {
    return this.toolRuntime.executeManualTool(
      "undo",
      {
        checkpointId: input.checkpointId,
        mode: input.mode ?? "both",
      },
      input.sessionId,
    );
  }

  private async recordDecision(input: {
    sessionId: string;
    workerSessionId: string;
    decision: SupervisorDecision;
    artifactRef?: string;
  }): Promise<SupervisorDecisionRecord> {
    const record: SupervisorDecisionRecord = {
      recordType: "supervisor_decision",
      decisionId: randomUUID(),
      sessionId: input.sessionId,
      workerSessionId: input.workerSessionId,
      createdAt: now(),
      action: input.decision.action,
      reason: input.decision.reason,
      evidenceRefs: input.decision.evidenceRefs,
      extraContextRefs: input.decision.extraContextRefs,
      verificationCommands: input.decision.verificationCommands,
      resultingState: mapDecisionToState(input.decision.action),
      artifactRef: input.artifactRef,
    };
    await this.sessionStore.recordSupervisorDecision(record);
    return record;
  }

  private async loadWorkerParentSession(workerSessionId: string): Promise<{ sessionId: string; task: WorkerTask }> {
    const workerSession = await this.sessionStore.loadWorkerSession(workerSessionId);
    if (!workerSession) {
      throw new Error(`Unknown worker session: ${workerSessionId}`);
    }
    return {
      sessionId: workerSession.parentSessionId,
      task: {
        workerType: workerSession.workerType,
        objective: workerSession.objective,
        constraints: workerSession.constraints,
        contextRefs: workerSession.contextRefs,
        expectedOutput: workerSession.expectedOutput,
        acceptanceChecks: workerSession.acceptanceChecks,
      },
    };
  }

  private async assertReviewBudget(workerSessionId: string): Promise<void> {
    const workerSession = await this.sessionStore.loadWorkerSession(workerSessionId);
    if (!workerSession) {
      throw new Error(`Unknown worker session: ${workerSessionId}`);
    }
    if (workerSession.retryCount + workerSession.revisionCount >= this.maxReviewAttempts) {
      throw new Error(`Worker review limit reached for ${workerSessionId}. Fallback or abort is required.`);
    }
  }
}
