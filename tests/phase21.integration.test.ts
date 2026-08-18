import { randomUUID } from "node:crypto";
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";

import { afterEach, describe, expect, it, vi } from "vitest";

import {
  McpRegistry,
  type McpAdapter,
  type McpInvocationResult,
  type McpResourceProtocolListRequest,
} from "../packages/mcp-hub/src/index.js";
import { SessionStore } from "../packages/persistence/src/index.js";
import {
  createCodingWorkerRouteProfile,
  createVisionWorkerRouteProfile,
  type GlmCodingWorkerConfig,
  type KimiVisionWorkerConfig,
} from "../packages/route-resolver/src/index.js";
import type {
  ArtifactExportResult,
  ArtifactReadResult,
  ArtifactSummary,
  CheckpointSummary,
  LifecyclePage,
  McpResourceDescriptor,
  McpResourceProtocolDescriptor,
  McpResourceProtocolPage,
  McpResourceProtocolReadResult,
  McpResourceReadResult,
  McpServerStatus,
  McpServerSummary,
  McpToolDescriptor,
  ToolErrorType,
  ToolResult,
  WorkerCancelResult,
  WorkerOutputPage,
  WorkerSessionRecord,
  WorkerStatusSummary,
  WorkerTask,
} from "../packages/shared-schema/src/index.js";
import { SpecialistBroker } from "../packages/specialist-broker/src/index.js";
import { ToolRuntime } from "../packages/tool-runtime/src/index.js";
import { catalogToolModule } from "../packages/tool-runtime/src/built-ins/catalog/index.js";
import { mcpResourceLifecycleToolModule } from "../packages/tool-runtime/src/built-ins/mcp-resources/index.js";
import { recoveryToolModule } from "../packages/tool-runtime/src/built-ins/recovery/index.js";
import { recoveryLifecycleToolModule } from "../packages/tool-runtime/src/built-ins/recovery/lifecycle.js";
import { workerLifecycleToolModule } from "../packages/tool-runtime/src/built-ins/workers/lifecycle.js";
import { GlmWorkerError } from "../packages/worker-glm-coding/src/index.js";
import type { PreparedVisionInput, VisionWorkerToolInput } from "../packages/worker-kimi-vision/src/index.js";

vi.setConfig({ testTimeout: 120_000, hookTimeout: 120_000 });

const temporaryRoots: string[] = [];
const runtimes: ToolRuntime[] = [];

interface Fixture {
  workspaceRoot: string;
  sessionStore: SessionStore;
  sessionId: string;
}

async function createFixture(prefix = "deep-mix-phase21-"): Promise<Fixture> {
  const workspaceRoot = await fs.mkdtemp(path.join(os.tmpdir(), prefix));
  temporaryRoots.push(workspaceRoot);
  const sessionStore = new SessionStore(workspaceRoot);
  await sessionStore.ensureInitialized();
  const session = await sessionStore.createSession("phase 21 lifecycle integration");
  return { workspaceRoot, sessionStore, sessionId: session.sessionId };
}

function trackedRuntime(runtime: ToolRuntime): ToolRuntime {
  runtimes.push(runtime);
  return runtime;
}

function requireSuccess<T>(result: ToolResult): T {
  expect(result.success, result.output).toBe(true);
  return result.structuredContent as T;
}

function requireErrorType(result: ToolResult, type: ToolErrorType): void {
  expect(result.success).toBe(false);
  expect((result.structuredContent as { error?: { type?: string } } | undefined)?.error?.type).toBe(type);
}

async function startPendingToolSearchTurn(
  sessionStore: SessionStore,
  sessionId: string,
  requestSummary: string,
): Promise<string> {
  const turn = await sessionStore.startTurn({
    sessionId,
    requestSummary,
    userMessageId: `phase21-tool-search-${randomUUID()}`,
  });
  await sessionStore.recordToolSelection({
    recordType: "tool_selection",
    selectionId: `phase21-selection-${turn.turnId}`,
    sessionId,
    turnId: turn.turnId,
    createdAt: new Date().toISOString(),
    providerCycle: 1,
    activationLeaseIds: [],
    activatedToolNames: [],
    estimatedToolSchemaTokens: 0,
    selectedCount: 1,
    unselectedCount: 0,
    selectedToolNames: ["tool_search"],
    reasonCounts: { always_available: 1 },
  });
  return turn.turnId;
}

function codingTask(objective: string): WorkerTask {
  return {
    workerType: "coding",
    objective,
    constraints: ["Return only a structured artifact."],
    contextRefs: [{ refType: "summary", label: "phase21", summary: "lifecycle fixture" }],
    expectedOutput: "code_artifact",
    acceptanceChecks: ["artifact is public"],
  };
}

const codingRoute = createCodingWorkerRouteProfile({
  apiKey: "fixture-key-never-sent",
  baseUrl: "https://example.invalid",
  endpointPath: "/chat/completions",
  model: "glm-5.2",
  role: "coding_worker",
  contextWindow: 128_000,
  maxRetries: 1,
  timeoutMs: 180_000,
  temperature: 0.1,
  maxContextChars: 24_000,
  maxContextFiles: 6,
  headers: { "Content-Type": "application/json" },
  requestDefaults: {},
  workspaceWriteAccess: false,
});

const visionRoute = createVisionWorkerRouteProfile({
  apiKey: "fixture-key-never-sent",
  baseUrl: "https://example.invalid",
  endpointPath: "/chat/completions",
  model: "kimi-vision",
  role: "vision_worker",
  contextWindow: 128_000,
  maxRetries: 1,
  timeoutMs: 180_000,
  maxContextChars: 24_000,
  maxImageBytes: 8 * 1024 * 1024,
  maxImageDimension: 8_192,
  targetImageDimension: 2_048,
  targetImageBytes: 2 * 1024 * 1024,
  imageInputMode: "base64_data_url",
  responseFormat: "json_object",
  headers: { "Content-Type": "application/json" },
  requestDefaults: {},
  supportsMultimodalInput: true,
});

async function createWorker(
  store: SessionStore,
  parentSessionId: string,
  objective: string,
): Promise<WorkerSessionRecord> {
  return store.createWorkerSession({
    parentSessionId,
    task: codingTask(objective),
    route: codingRoute,
    timeoutMs: 180_000,
    maxRetries: 1,
  });
}

afterEach(async () => {
  await Promise.all(runtimes.splice(0).map((runtime) => runtime.dispose().catch(() => undefined)));
  await Promise.all(temporaryRoots.splice(0).map((root) => fs.rm(root, { recursive: true, force: true })));
});

describe("phase 21 artifact, worker, and MCP resource lifecycle tools", () => {
  it("pages isolated checkpoints and safely reads, exports, checkpoints, and undoes artifacts", async () => {
    const fixture = await createFixture("deep-mix-phase21-artifacts-");
    const otherSession = await fixture.sessionStore.createSession("other owner");
    const runtime = trackedRuntime(new ToolRuntime({
      workspaceRoot: fixture.workspaceRoot,
      sessionStore: fixture.sessionStore,
      permissionMode: "danger-full-access",
      modules: [recoveryToolModule, recoveryLifecycleToolModule],
    }));

    await fs.writeFile(path.join(fixture.workspaceRoot, "tracked.txt"), "checkpoint source", "utf8");
    const checkpoints = [];
    for (let index = 0; index < 3; index += 1) {
      checkpoints.push(await fixture.sessionStore.createCheckpoint({
        sessionId: fixture.sessionId,
        scope: "manual_undo_anchor",
        trackedFiles: ["tracked.txt"],
        reason: `checkpoint ${index}`,
        turnId: `turn-${index}`,
        toolCallId: `checkpoint-call-${index}`,
        sourceToolName: "phase21_fixture",
      }));
    }

    const checkpointPage1 = requireSuccess<LifecyclePage<CheckpointSummary>>(
      await runtime.executeManualTool("list_checkpoints", { limit: 1 }, fixture.sessionId),
    );
    expect(checkpointPage1.returned).toBe(1);
    expect(checkpointPage1.hasMore).toBe(true);
    expect(checkpointPage1.nextCursor).toBeTruthy();
    const checkpointCursor = checkpointPage1.nextCursor!;
    const nonCanonicalAlias: Record<string, string> = { A: "B", Q: "R", g: "h", w: "x" };
    const cursorTail = checkpointCursor.at(-1)!;
    expect(nonCanonicalAlias[cursorTail]).toBeTruthy();
    const tamperedCheckpointCursor = `${checkpointCursor.slice(0, -1)}${nonCanonicalAlias[cursorTail]}`;
    requireErrorType(
      await runtime.executeManualTool(
        "list_checkpoints",
        { limit: 1, cursor: tamperedCheckpointCursor },
        fixture.sessionId,
      ),
      "invalid_arguments",
    );
    const restartedStore = new SessionStore(fixture.workspaceRoot);
    await restartedStore.ensureInitialized();
    const restartedRuntime = trackedRuntime(new ToolRuntime({
      workspaceRoot: fixture.workspaceRoot,
      sessionStore: restartedStore,
      permissionMode: "danger-full-access",
      modules: [recoveryLifecycleToolModule],
    }));
    const checkpointPage2 = requireSuccess<LifecyclePage<CheckpointSummary>>(
      await restartedRuntime.executeManualTool(
        "list_checkpoints",
        { limit: 1, cursor: checkpointPage1.nextCursor },
        fixture.sessionId,
      ),
    );
    expect(checkpointPage2.items[0]?.checkpointId).not.toBe(checkpointPage1.items[0]?.checkpointId);
    const filteredCheckpoints = requireSuccess<LifecyclePage<CheckpointSummary>>(
      await runtime.executeManualTool("list_checkpoints", { turnId: "turn-1" }, fixture.sessionId),
    );
    expect(filteredCheckpoints.items.map((item) => item.checkpointId)).toEqual([checkpoints[1]!.checkpointId]);
    requireErrorType(
      await runtime.executeManualTool("list_checkpoints", { sessionId: otherSession.sessionId }, fixture.sessionId),
      "permission_denied",
    );

    const secondWorkspace = await createFixture("deep-mix-phase21-cursor-workspace-");
    const secondRuntime = trackedRuntime(new ToolRuntime({
      workspaceRoot: secondWorkspace.workspaceRoot,
      sessionStore: secondWorkspace.sessionStore,
      permissionMode: "danger-full-access",
      modules: [recoveryLifecycleToolModule],
    }));
    requireErrorType(
      await secondRuntime.executeManualTool(
        "list_checkpoints",
        { cursor: checkpointPage1.nextCursor, limit: 1 },
        secondWorkspace.sessionId,
      ),
      "invalid_arguments",
    );

    const structuredArtifact = await fixture.sessionStore.storeToolOutputArtifact({
      sessionId: fixture.sessionId,
      toolCallId: "structured-artifact",
      sourceToolName: "phase21_fixture",
      fileName: "report.json",
      mimeType: "application/json",
      kind: "text",
      summary: "structured lifecycle artifact",
      content: JSON.stringify({ ok: true, password: "TOP_SECRET", workspacePath: fixture.workspaceRoot }),
    });
    const binaryBytes = Buffer.from([255, 254, 0, 65]);
    const binaryArtifact = await fixture.sessionStore.storeToolOutputArtifact({
      sessionId: fixture.sessionId,
      toolCallId: "binary-artifact",
      sourceToolName: "phase21_fixture",
      fileName: "payload.bin",
      mimeType: "application/octet-stream",
      kind: "binary",
      summary: "binary lifecycle artifact",
      content: binaryBytes,
    });

    const artifactPage1 = requireSuccess<LifecyclePage<ArtifactSummary>>(
      await runtime.executeManualTool("list_artifacts", { limit: 1 }, fixture.sessionId),
    );
    const artifactPage2 = requireSuccess<LifecyclePage<ArtifactSummary>>(
      await runtime.executeManualTool(
        "list_artifacts",
        { limit: 1, cursor: artifactPage1.nextCursor },
        fixture.sessionId,
      ),
    );
    expect(new Set([...artifactPage1.items, ...artifactPage2.items].map((item) => item.uri)).size).toBe(2);
    const filteredArtifacts = requireSuccess<LifecyclePage<ArtifactSummary>>(
      await runtime.executeManualTool(
        "list_artifacts",
        { sourceToolName: "phase21_fixture", mimeType: "application/json" },
        fixture.sessionId,
      ),
    );
    expect(filteredArtifacts.items.map((item) => item.uri)).toEqual([structuredArtifact.uri]);

    const structuredRead = requireSuccess<ArtifactReadResult>(
      await runtime.executeManualTool("read_artifact", { uri: structuredArtifact.uri }, fixture.sessionId),
    );
    expect(structuredRead.mode).toBe("structured");
    expect(JSON.stringify(structuredRead)).not.toContain("TOP_SECRET");
    expect(JSON.stringify(structuredRead)).not.toContain(fixture.workspaceRoot);
    expect(JSON.stringify(structuredRead)).toContain("[REDACTED]");
    const binaryRead = requireSuccess<ArtifactReadResult>(
      await runtime.executeManualTool("read_artifact", { uri: binaryArtifact.uri }, fixture.sessionId),
    );
    expect(binaryRead).toMatchObject({ mode: "binary_metadata", binaryInline: false, returnedChars: 0 });
    expect(binaryRead).not.toHaveProperty("content");
    requireErrorType(
      await runtime.executeManualTool("read_artifact", { uri: binaryArtifact.uri }, otherSession.sessionId),
      "permission_denied",
    );
    requireErrorType(
      await secondRuntime.executeManualTool("read_artifact", { uri: binaryArtifact.uri }, secondWorkspace.sessionId),
      "permission_denied",
    );

    const expiredArtifact = await fixture.sessionStore.storeToolOutputArtifact({
      sessionId: fixture.sessionId,
      toolCallId: "expired-artifact",
      sourceToolName: "expired_fixture",
      fileName: "expired.txt",
      mimeType: "text/plain",
      kind: "text",
      summary: "metadata retained after payload expiry",
      content: "expired payload",
    });
    await fs.rm(fixture.sessionStore.resolveToolOutputArtifactPath(expiredArtifact.uri));
    const expiredCatalog = requireSuccess<LifecyclePage<ArtifactSummary>>(
      await runtime.executeManualTool(
        "list_artifacts",
        { sourceToolName: "expired_fixture" },
        fixture.sessionId,
      ),
    );
    expect(expiredCatalog.items).toHaveLength(1);
    expect(expiredCatalog.items[0]).toMatchObject({ uri: expiredArtifact.uri, partial: true });
    expect(expiredCatalog.warnings).toContainEqual(expect.objectContaining({ code: "missing_payload" }));
    requireErrorType(
      await runtime.executeManualTool("read_artifact", { uri: expiredArtifact.uri }, fixture.sessionId),
      "not_found",
    );

    const targetPath = "exports/payload.bin";
    const absoluteTarget = path.join(fixture.workspaceRoot, targetPath);
    await fs.mkdir(path.dirname(absoluteTarget), { recursive: true });
    await fs.writeFile(absoluteTarget, "before", "utf8");
    const exported = requireSuccess<ArtifactExportResult>(
      await runtime.executeManualTool(
        "export_artifact",
        { uri: binaryArtifact.uri, targetPath, overwrite: true },
        fixture.sessionId,
      ),
    );
    expect(exported).toMatchObject({ sourceUri: binaryArtifact.uri, targetPath, overwritten: true });
    expect(await fs.readFile(absoluteTarget)).toEqual(binaryBytes);
    requireSuccess(
      await runtime.executeManualTool(
        "undo",
        { checkpointId: exported.checkpointId, mode: "code" },
        fixture.sessionId,
      ),
    );
    expect(await fs.readFile(absoluteTarget, "utf8")).toBe("before");
  });

  it("exposes only public worker lifecycle state and keeps cancellation terminal and idempotent", async () => {
    const fixture = await createFixture("deep-mix-phase21-workers-");
    const standaloneSk = "sk-standalonePhase21Secret123456";
    const bearerSecret = "Bearer phase21BearerCredential123456";
    const bareJwt = "eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiJwaGFzZTIxIn0.c2lnbmF0dXJlc2VjcmV0";
    const otherSession = await fixture.sessionStore.createSession("worker non-owner");
    const broker = new SpecialistBroker({ workspaceRoot: fixture.workspaceRoot, sessionStore: fixture.sessionStore });
    const runtime = trackedRuntime(new ToolRuntime({
      workspaceRoot: fixture.workspaceRoot,
      sessionStore: fixture.sessionStore,
      permissionMode: "danger-full-access",
      specialistBroker: broker,
      modules: [workerLifecycleToolModule],
    }));

    const running = await createWorker(fixture.sessionStore, fixture.sessionId, "running worker");
    await fixture.sessionStore.setWorkerSessionStatus({
      workerSessionId: running.workerSessionId,
      status: "running",
      dispatchKind: "initial",
      attemptNumber: 1,
      reason: "public running state",
    });
    const completed = await createWorker(fixture.sessionStore, fixture.sessionId, "completed worker");
    await fixture.sessionStore.setWorkerSessionStatus({
      workerSessionId: completed.workerSessionId,
      status: "running",
      dispatchKind: "initial",
      attemptNumber: 1,
    });
    const artifact = await fixture.sessionStore.storeCodeArtifact({
      workerSessionId: completed.workerSessionId,
      artifact: {
        kind: "code_artifact",
        summary: `public code artifact ${standaloneSk}`,
        confidence: 0.9,
        risks: [],
        metadata: {},
        changedFiles: ["src/example.ts"],
        testCommands: ["npm test"],
        notes: ["bounded public note"],
      },
      patchContent: "*** Begin Patch\n*** End Patch",
    });
    await fixture.sessionStore.appendWorkerMessage({
      workerSessionId: completed.workerSessionId,
      role: "assistant",
      content: "HIDDEN_REASONING private-token-should-never-appear",
      metadata: { private: true },
    });
    await fixture.sessionStore.recordPromotion({
      recordType: "artifact_promotion",
      promotionId: randomUUID(),
      sessionId: fixture.sessionId,
      workerSessionId: completed.workerSessionId,
      createdAt: new Date().toISOString(),
      artifactRef: artifact.artifactRef,
      promotedFields: ["patchRef"],
      changedFiles: ["src/example.ts"],
      riskSummary: [],
      verificationSummary: ["typecheck passed"],
    });
    await fixture.sessionStore.recordSupervisorDecision({
      recordType: "supervisor_decision",
      decisionId: randomUUID(),
      sessionId: fixture.sessionId,
      workerSessionId: completed.workerSessionId,
      createdAt: new Date().toISOString(),
      action: "accept",
      reason: "public verification passed",
      evidenceRefs: [artifact.artifactRef as `artifact://${string}`],
      verificationCommands: ["npm run check"],
      resultingState: "accepted",
      artifactRef: artifact.artifactRef,
    });
    await fixture.sessionStore.setWorkerSessionStatus({
      workerSessionId: completed.workerSessionId,
      status: "completed",
      dispatchKind: "initial",
      attemptNumber: 1,
      reason: "artifact ready",
    });

    const failed = await createWorker(fixture.sessionStore, fixture.sessionId, "failed worker");
    await fixture.sessionStore.setWorkerSessionStatus({
      workerSessionId: failed.workerSessionId,
      status: "failed",
      dispatchKind: "initial",
      attemptNumber: 1,
      reason: `public failure ${bearerSecret}`,
      errorType: "model_call_failed",
      errorMessage: `bounded public failure ${bareJwt}`,
    });
    const cancellable = await createWorker(fixture.sessionStore, fixture.sessionId, "cancelled worker");
    const vision = await fixture.sessionStore.createWorkerSession({
      parentSessionId: fixture.sessionId,
      task: {
        workerType: "vision",
        objective: "inspect one bounded screenshot",
        constraints: ["Return only a vision artifact."],
        contextRefs: [{ refType: "summary", label: "image", summary: "synthetic vision fixture" }],
        expectedOutput: "vision_artifact",
        acceptanceChecks: ["outer lifecycle contract remains typed"],
      },
      route: visionRoute,
      timeoutMs: 180_000,
      maxRetries: 1,
    });

    const runningStatus = requireSuccess<WorkerStatusSummary>(
      await runtime.executeManualTool("worker_status", { workerSessionId: running.workerSessionId }, fixture.sessionId),
    );
    expect(runningStatus).toMatchObject({ status: "running", stage: "running", terminal: false });
    expect(runningStatus.progress).toBeUndefined();
    const completedStatus = requireSuccess<WorkerStatusSummary>(
      await runtime.executeManualTool("worker_status", { workerSessionId: completed.workerSessionId }, fixture.sessionId),
    );
    expect(completedStatus).toMatchObject({ status: "completed", stage: "artifact_ready", terminal: true, artifactCount: 1 });
    const failedStatus = requireSuccess<WorkerStatusSummary>(
      await runtime.executeManualTool("worker_status", { workerSessionId: failed.workerSessionId }, fixture.sessionId),
    );
    expect(failedStatus).toMatchObject({ status: "failed", stage: "failed", terminal: true });
    expect(JSON.stringify(failedStatus)).not.toContain("phase21BearerCredential123456");
    expect(JSON.stringify(failedStatus)).toContain("Bearer [REDACTED]");
    const failedOutput = requireSuccess<WorkerOutputPage>(
      await runtime.executeManualTool(
        "worker_output",
        { workerSessionId: failed.workerSessionId, limit: 50, maxChars: 65_536 },
        fixture.sessionId,
      ),
    );
    expect(JSON.stringify(failedOutput)).not.toContain(bareJwt);
    expect(JSON.stringify(failedOutput)).toContain("[REDACTED_JWT]");
    const visionStatus = requireSuccess<WorkerStatusSummary>(
      await runtime.executeManualTool("worker_status", { workerSessionId: vision.workerSessionId }, fixture.sessionId),
    );
    const visionOutput = requireSuccess<WorkerOutputPage>(
      await runtime.executeManualTool(
        "worker_output",
        { workerSessionId: vision.workerSessionId, limit: 50, maxChars: 65_536 },
        fixture.sessionId,
      ),
    );
    expect(visionStatus.workerType).toBe("vision");
    expect(visionOutput).toMatchObject({ workerType: "vision", status: "queued" });
    requireErrorType(
      await runtime.executeManualTool("worker_status", { workerSessionId: randomUUID() }, fixture.sessionId),
      "not_found",
    );
    requireErrorType(
      await runtime.executeManualTool("worker_status", { workerSessionId: completed.workerSessionId }, otherSession.sessionId),
      "permission_denied",
    );

    const output1 = requireSuccess<WorkerOutputPage>(
      await runtime.executeManualTool(
        "worker_output",
        { workerSessionId: completed.workerSessionId, limit: 2, maxChars: 65_536 },
        fixture.sessionId,
      ),
    );
    expect(output1.hasMore).toBe(true);
    const output2 = requireSuccess<WorkerOutputPage>(
      await runtime.executeManualTool(
        "worker_output",
        { workerSessionId: completed.workerSessionId, limit: 200, cursor: output1.nextCursor, maxChars: 262_144 },
        fixture.sessionId,
      ),
    );
    const publicOutput = JSON.stringify([output1, output2]);
    expect(publicOutput).not.toContain("HIDDEN_REASONING");
    expect(publicOutput).not.toContain("private-token-should-never-appear");
    expect(publicOutput).not.toContain(standaloneSk);
    expect(publicOutput).toContain("[REDACTED_TOKEN]");
    expect([...new Set([...output1.events, ...output2.events].map((event) => event.kind))]).toEqual(
      expect.arrayContaining(["status", "artifact", "promotion", "verification"]),
    );
    const artifactOnly = requireSuccess<WorkerOutputPage>(
      await runtime.executeManualTool(
        "worker_output",
        { workerSessionId: completed.workerSessionId, kinds: ["artifact"], limit: 50, maxChars: 65_536 },
        fixture.sessionId,
      ),
    );
    expect(artifactOnly.events).toHaveLength(1);
    expect(artifactOnly.events[0]?.kind).toBe("artifact");

    const firstCancel = requireSuccess<WorkerCancelResult>(
      await runtime.executeManualTool(
        "worker_cancel",
        { workerSessionId: cancellable.workerSessionId, reason: `phase21 cancellation ${standaloneSk}` },
        fixture.sessionId,
      ),
    );
    expect(firstCancel).toMatchObject({ previousStatus: "queued", finalStatus: "cancelled", cancelled: true, idempotent: false });
    expect(firstCancel.reason).not.toContain(standaloneSk);
    expect(firstCancel.reason).toContain("[REDACTED_TOKEN]");
    expect(requireSuccess<WorkerStatusSummary>(
      await runtime.executeManualTool("worker_status", { workerSessionId: cancellable.workerSessionId }, fixture.sessionId),
    )).toMatchObject({ status: "cancelled", stage: "cancelled", terminal: true });
    const secondCancel = requireSuccess<WorkerCancelResult>(
      await runtime.executeManualTool(
        "worker_cancel",
        { workerSessionId: cancellable.workerSessionId, reason: `phase21 cancellation ${standaloneSk}` },
        fixture.sessionId,
      ),
    );
    expect(secondCancel).toMatchObject({ finalStatus: "cancelled", cancelled: true, idempotent: true });
    const completedCancel = requireSuccess<WorkerCancelResult>(
      await runtime.executeManualTool(
        "worker_cancel",
        { workerSessionId: completed.workerSessionId, reason: "must remain completed" },
        fixture.sessionId,
      ),
    );
    expect(completedCancel).toMatchObject({ previousStatus: "completed", finalStatus: "completed", cancelled: false, idempotent: true, artifactCountPreserved: 1 });

    const runningCancel = requireSuccess<WorkerCancelResult>(
      await runtime.executeManualTool(
        "worker_cancel",
        { workerSessionId: running.workerSessionId, reason: "cancel running worker" },
        fixture.sessionId,
      ),
    );
    expect(runningCancel.finalStatus).toBe("cancelled");
    await fixture.sessionStore.setWorkerSessionStatus({
      workerSessionId: running.workerSessionId,
      status: "completed",
      dispatchKind: "initial",
      attemptNumber: 1,
      reason: "late provider completion",
    });
    expect((await fixture.sessionStore.loadWorkerSession(running.workerSessionId))?.status).toBe("cancelled");

    const corrupt = await createWorker(fixture.sessionStore, fixture.sessionId, "corrupt worker");
    await fs.writeFile(fixture.sessionStore.getWorkerSessionMetaPath(corrupt.workerSessionId), "{", "utf8");
    requireErrorType(
      await runtime.executeManualTool("worker_status", { workerSessionId: corrupt.workerSessionId }, fixture.sessionId),
      "corrupt_record",
    );
  });

  it("authorizes worker cancellation by persisted status version before aborting or queuing cancellation", async () => {
    const fixture = await createFixture("deep-mix-phase21-worker-cancel-cas-");
    const broker = new SpecialistBroker({ workspaceRoot: fixture.workspaceRoot, sessionStore: fixture.sessionStore });
    const worker = await createWorker(fixture.sessionStore, fixture.sessionId, "stale cancellation approval");
    const approved = await broker.previewWorkerCancellation(fixture.sessionId, worker.workerSessionId);
    await fixture.sessionStore.setWorkerSessionStatus({
      workerSessionId: worker.workerSessionId,
      status: "running",
      dispatchKind: "retry",
      attemptNumber: 1,
      reason: "newer worker attempt started",
    });

    const controller = new AbortController();
    const brokerState = broker as unknown as {
      activeControllers: Map<string, AbortController>;
      pendingCancellations: Map<string, unknown>;
    };
    brokerState.activeControllers.set(worker.workerSessionId, controller);
    await expect(broker.cancelOwnedWorkerSession({
      parentSessionId: fixture.sessionId,
      workerSessionId: worker.workerSessionId,
      reason: "stale approved cancellation",
      approvedStatusVersion: approved.statusVersion,
    })).rejects.toMatchObject({ code: "ERR_TOOL_CONFLICTED" });
    expect(controller.signal.aborted).toBe(false);
    expect((await fixture.sessionStore.loadWorkerSession(worker.workerSessionId))?.status).toBe("running");
    expect((await fixture.sessionStore.scanWorkerLifecycleEvents(
      fixture.sessionId,
      worker.workerSessionId,
    )).workerEvents.filter((event) => event.recordType === "worker_cancellation")).toHaveLength(0);

    brokerState.activeControllers.delete(worker.workerSessionId);
    await expect(broker.cancelOwnedWorkerSession({
      parentSessionId: fixture.sessionId,
      workerSessionId: worker.workerSessionId,
      reason: "stale retry without active controller",
      approvedStatusVersion: approved.statusVersion,
    })).rejects.toMatchObject({ code: "ERR_TOOL_CONFLICTED" });
    expect(brokerState.pendingCancellations.has(worker.workerSessionId)).toBe(false);
  });

  it("does not call coding retry or vision providers after a persisted cancellation wins the running transition", async () => {
    const fixture = await createFixture("deep-mix-phase21-worker-retry-boundary-");
    const codingSession = await createWorker(fixture.sessionStore, fixture.sessionId, "cancel before coding retry");
    const visionTask: WorkerTask = {
      workerType: "vision",
      objective: "cancel before vision provider invocation",
      constraints: ["Return only a structured artifact."],
      contextRefs: [{ refType: "summary", label: "phase21", summary: "retry boundary fixture" }],
      expectedOutput: "vision_artifact",
      acceptanceChecks: ["cancelled workers do not invoke providers"],
    };
    const visionSession = await fixture.sessionStore.createWorkerSession({
      parentSessionId: fixture.sessionId,
      task: visionTask,
      route: visionRoute,
      timeoutMs: 180_000,
      maxRetries: 1,
    });
    const codingRun = vi.fn(async () => {
      await fixture.sessionStore.cancelOwnedWorkerSession({
        workerSessionId: codingSession.workerSessionId,
        parentSessionId: fixture.sessionId,
        requestedBySessionId: fixture.sessionId,
        requestedAt: new Date().toISOString(),
        reason: "cancelled while the first coding attempt was in flight",
      });
      throw new GlmWorkerError("model_call_failed", "retryable provider failure", { retryable: true });
    });
    const visionRun = vi.fn(async () => {
      throw new Error("vision provider must not run after cancellation");
    });
    const broker = new SpecialistBroker({
      workspaceRoot: fixture.workspaceRoot,
      sessionStore: fixture.sessionStore,
      codingWorkerFactory: () => ({ runTask: codingRun }),
      visionWorkerFactory: () => ({ runTask: visionRun }),
    });
    const codingConfig: GlmCodingWorkerConfig = {
      apiKey: "fixture-key-never-sent",
      baseUrl: "https://example.invalid",
      endpointPath: "/chat/completions",
      model: "glm-5.2",
      role: "coding_worker",
      contextWindow: 128_000,
      maxRetries: 1,
      timeoutMs: 180_000,
      temperature: 0.1,
      maxContextChars: 24_000,
      maxContextFiles: 6,
      headers: { "Content-Type": "application/json" },
      requestDefaults: {},
      workspaceWriteAccess: false,
    };
    const visionConfig: KimiVisionWorkerConfig = {
      apiKey: "fixture-key-never-sent",
      baseUrl: "https://example.invalid",
      endpointPath: "/chat/completions",
      model: "kimi-vision",
      role: "vision_worker",
      contextWindow: 128_000,
      maxRetries: 1,
      timeoutMs: 180_000,
      maxContextChars: 24_000,
      maxImageBytes: 8 * 1024 * 1024,
      maxImageDimension: 8_192,
      targetImageDimension: 2_048,
      targetImageBytes: 2 * 1024 * 1024,
      imageInputMode: "base64_data_url",
      responseFormat: "json_object",
      headers: { "Content-Type": "application/json" },
      requestDefaults: {},
      supportsMultimodalInput: true,
    };
    const visionInput: VisionWorkerToolInput = {
      workerType: "vision",
      taskType: "ui_parse",
      image: { sourceType: "uploaded_file", ref: "file://unused.png" },
    };
    const preparedVisionInput: PreparedVisionInput = {
      taskType: "ui_parse",
      image: visionInput.image,
      inputMode: "base64_data_url",
      originalImageRef: "artifact://images/original.png",
      processedImageRef: "artifact://images/processed.webp",
      mimeType: "image/webp",
      originalBytes: 1,
      processedBytes: 1,
      originalWidth: 1,
      originalHeight: 1,
      processedWidth: 1,
      processedHeight: 1,
      preprocessing: { resized: false, cropped: false, recompressed: false },
      processedDataUrl: "data:image/webp;base64,AA==",
    };
    const runner = broker as unknown as {
      runCodingWorkerSession(input: {
        session: WorkerSessionRecord;
        config: GlmCodingWorkerConfig;
        task: WorkerTask;
        initialDispatchKind: "initial";
        firstAttemptReason: string;
      }): Promise<unknown>;
      runVisionWorkerSession(input: {
        session: WorkerSessionRecord;
        config: KimiVisionWorkerConfig;
        task: WorkerTask;
        visionInput: VisionWorkerToolInput;
      }): Promise<unknown>;
      prepareVisionInput(...args: unknown[]): Promise<PreparedVisionInput>;
    };
    vi.spyOn(runner, "prepareVisionInput").mockImplementation(async () => {
      await fixture.sessionStore.cancelOwnedWorkerSession({
        workerSessionId: visionSession.workerSessionId,
        parentSessionId: fixture.sessionId,
        requestedBySessionId: fixture.sessionId,
        requestedAt: new Date().toISOString(),
        reason: "cancelled after vision preparation",
      });
      return preparedVisionInput;
    });

    await runner.runCodingWorkerSession({
      session: codingSession,
      config: codingConfig,
      task: codingTask("cancel before coding retry"),
      initialDispatchKind: "initial",
      firstAttemptReason: "first coding attempt",
    });
    await runner.runVisionWorkerSession({
      session: visionSession,
      config: visionConfig,
      task: visionTask,
      visionInput,
    });

    expect(codingRun).toHaveBeenCalledTimes(1);
    expect(visionRun).not.toHaveBeenCalled();
    expect((await fixture.sessionStore.loadWorkerSession(codingSession.workerSessionId))?.status).toBe("cancelled");
    expect((await fixture.sessionStore.loadWorkerSession(visionSession.workerSessionId))?.status).toBe("cancelled");
  });

  it("hides malformed worker lifecycle events and returns partial public status and output", async () => {
    const fixture = await createFixture("deep-mix-phase21-worker-malformed-");
    const broker = new SpecialistBroker({ workspaceRoot: fixture.workspaceRoot, sessionStore: fixture.sessionStore });
    const runtime = trackedRuntime(new ToolRuntime({
      workspaceRoot: fixture.workspaceRoot,
      sessionStore: fixture.sessionStore,
      permissionMode: "danger-full-access",
      specialistBroker: broker,
      modules: [workerLifecycleToolModule],
    }));
    const worker = await createWorker(fixture.sessionStore, fixture.sessionId, "malformed lifecycle records");
    const createdAt = new Date().toISOString();
    const hiddenMarker = "MALFORMED_PRIVATE_WORKER_PAYLOAD";
    await fs.appendFile(
      fixture.sessionStore.getWorkerSessionJsonlPath(worker.workerSessionId),
      [
        {
          recordType: "worker_status",
          workerSessionId: worker.workerSessionId,
          workspaceId: fixture.sessionStore.workspaceId,
          parentSessionId: fixture.sessionId,
          createdAt,
          status: "running",
          dispatchKind: "initial",
          attemptNumber: 1,
          reason: { hiddenMarker },
        },
        {
          recordType: "worker_artifact",
          workerSessionId: worker.workerSessionId,
          workspaceId: fixture.sessionStore.workspaceId,
          parentSessionId: fixture.sessionId,
          artifactId: randomUUID(),
          createdAt,
          artifactRef: "artifact://patches/malformed.patch",
          summary: {
            kind: "code_artifact",
            summary: hiddenMarker,
            patchRef: "artifact://patches/malformed.patch",
            confidence: 0.5,
            risks: [],
          },
        },
        {
          recordType: "worker_message",
          workerSessionId: worker.workerSessionId,
          createdAt,
          role: "assistant",
          content: hiddenMarker,
        },
      ].map((event) => JSON.stringify(event)).join("\n") + "\n",
      "utf8",
    );
    await fs.appendFile(
      fixture.sessionStore.getSessionJsonlPath(fixture.sessionId),
      `${JSON.stringify({
        recordType: "artifact_promotion",
        promotionId: randomUUID(),
        sessionId: fixture.sessionId,
        workerSessionId: worker.workerSessionId,
        createdAt,
        artifactRef: "artifact://patches/malformed.patch",
        promotedFields: ["patchRef"],
        changedFiles: [hiddenMarker],
        riskSummary: [],
      })}\n`,
      "utf8",
    );

    const status = requireSuccess<WorkerStatusSummary>(
      await runtime.executeManualTool("worker_status", { workerSessionId: worker.workerSessionId }, fixture.sessionId),
    );
    const output = requireSuccess<WorkerOutputPage>(
      await runtime.executeManualTool(
        "worker_output",
        { workerSessionId: worker.workerSessionId, limit: 50, maxChars: 65_536 },
        fixture.sessionId,
      ),
    );
    expect(status.partial).toBe(true);
    expect(output.partial).toBe(true);
    expect(status.warnings.some((warning) => warning.code === "corrupt_record")).toBe(true);
    expect(output.warnings.some((warning) => warning.code === "corrupt_record")).toBe(true);
    expect(JSON.stringify([status, output])).not.toContain(hiddenMarker);
    expect(output.events.some((event) => event.kind === "artifact" || event.kind === "promotion")).toBe(false);
  });

  it("uses a separate paginated MCP Resource protocol with redacted long-text and binary artifacts", async () => {
    const fixture = await createFixture("deep-mix-phase21-mcp-");
    await fs.mkdir(path.join(fixture.workspaceRoot, ".deep-mix", "mcp"), { recursive: true });
    await fs.writeFile(
      path.join(fixture.workspaceRoot, ".deep-mix", "mcp", "servers.json"),
      JSON.stringify({
        version: 1,
        servers: [
          { name: "fake", type: "github", enabled: true },
          { name: "legacy", type: "github", enabled: true },
          { name: "down", type: "github", enabled: true },
        ],
      }),
      "utf8",
    );

    const longText = `${"L".repeat(2_000_010)} token=TOP_SECRET`;
    const signedUri = "memory://fake/path-TOP_SECRET/report?sig=TOP_SECRET";
    const remoteErrorUri = "memory://fake/error-TOP_SECRET?sig=TOP_SECRET";
    const descriptors: McpResourceProtocolDescriptor[] = [
      { uri: "memory://fake/structured", name: "Structured", mimeType: "application/json; token=TOP_SECRET" },
      { uri: "memory://fake/long", name: "Long", mimeType: "text/plain" },
      { uri: "memory://fake/blob", name: "Blob", mimeType: "application/octet-stream", sizeBytes: 4 },
      { uri: signedUri, name: "Signed document TOP_SECRET", description: `Private source ${signedUri}`, mimeType: "text/plain" },
      { uri: "memory://fake/key-path-TOP_SECRET?key=TOP_SECRET", name: "Opaque key resource TOP_SECRET", mimeType: "text/plain" },
      { uri: "memory://fake/unsafe?token=TOP_SECRET", name: "Unsafe", mimeType: "text/plain" },
      { uri: "memory://TOP_SECRET@fake/private#TOP_SECRET", name: "Unsafe authority", mimeType: "text/plain" },
    ];

    class FakeAdapter implements McpAdapter {
      public toolInvocations = 0;

      public resourceReads = 0;

      public lastReadUri?: string;

      public async start(): Promise<McpServerStatus> {
        return { name: "fake", type: "github", enabled: true, state: "ready", toolCount: 1, lastCheckedAt: new Date().toISOString() };
      }

      public listTools(): McpToolDescriptor[] {
        return [{
          serverName: "fake",
          serverType: "github",
          name: "mcp_fake_echo",
          description: "Fake dynamic MCP tool for separation regression coverage.",
          inputSchema: { type: "object", additionalProperties: false },
          readOnly: true,
          permissionCategory: "mcp_read_only",
          sideEffectLevel: "none",
          timeoutCategory: "fast",
          selectionKeywords: ["fake echo"],
        }];
      }

      public async invokeTool(): Promise<McpInvocationResult> {
        this.toolInvocations += 1;
        return { output: "dynamic tool called", structuredContent: { dynamic: true } };
      }

      public async listResources(request: McpResourceProtocolListRequest): Promise<McpResourceProtocolPage> {
        const start = request.cursor ? Number(request.cursor) : 0;
        const resources = descriptors.slice(start, start + request.limit);
        return {
          resources,
          nextCursor: start + resources.length < descriptors.length ? String(start + resources.length) : undefined,
        };
      }

      public async readResource(uri: string): Promise<McpResourceProtocolReadResult> {
        this.resourceReads += 1;
        this.lastReadUri = uri;
        if (uri === descriptors[0]!.uri) {
          return {
            descriptor: descriptors[0]!,
            representation: "structured",
            structuredData: {
              ok: true,
              password: "TOP_SECRET",
              path: fixture.workspaceRoot,
              pathCaseVariant: fixture.workspaceRoot.toUpperCase(),
              pathSlashVariant: fixture.workspaceRoot.replaceAll("\\", "/").toLowerCase(),
              pathExtendedVariant: `\\\\?\\${fixture.workspaceRoot}`,
            },
          };
        }
        if (uri === descriptors[1]!.uri) {
          return { descriptor: descriptors[1]!, representation: "text", text: longText };
        }
        if (uri === descriptors[2]!.uri) {
          return {
            descriptor: descriptors[2]!,
            representation: "binary",
            binaryData: new Uint8Array([255, 254, 0, 65]),
            sizeBytes: 4,
          };
        }
        if (uri === signedUri) {
          return {
            descriptor: descriptors[3]!,
            representation: "text",
            text: `Loaded ${signedUri} for TOP_SECRET`,
          };
        }
        if (uri === remoteErrorUri) {
          throw Object.assign(new Error(
            `provider failed while reading ${remoteErrorUri}; Bearer TOP_SECRET; workspace=${fixture.workspaceRoot}`,
          ), { code: "ERR_TOOL_NOT_FOUND" });
        }
        if (uri === "memory://fake/denied") {
          throw Object.assign(new Error("permission denied token=TOP_SECRET"), { code: "ERR_TOOL_PERMISSION_DENIED" });
        }
        throw Object.assign(new Error("resource not found token=TOP_SECRET"), { code: "ERR_TOOL_NOT_FOUND" });
      }
    }

    const fake = new FakeAdapter();
    const down: McpAdapter = {
      start: async () => ({
        name: "down",
        type: "github",
        enabled: true,
        state: "error",
        error: "authorization=TOP_SECRET",
        toolCount: 0,
      }),
      listTools: () => [],
      invokeTool: async () => { throw new Error("down"); },
      listResources: async () => ({ resources: [] }),
      readResource: async () => { throw new Error("down"); },
    };
    const registry = new McpRegistry(fixture.workspaceRoot, {
      createAdapter: (entry) => entry.name === "fake" ? fake : entry.name === "down" ? down : undefined,
    });
    await registry.initialize();
    const runtime = trackedRuntime(new ToolRuntime({
      workspaceRoot: fixture.workspaceRoot,
      sessionStore: fixture.sessionStore,
      permissionMode: "danger-full-access",
      mcpRegistry: registry,
      modules: [catalogToolModule, mcpResourceLifecycleToolModule],
    }));

    const servers = requireSuccess<LifecyclePage<McpServerSummary>>(
      await runtime.executeManualTool("list_mcp_servers", { limit: 10 }, fixture.sessionId),
    );
    expect(Object.fromEntries(servers.items.map((server) => [server.name, server.resourceSupport]))).toMatchObject({
      fake: "supported",
      legacy: "unsupported",
      down: "unavailable",
    });
    expect(JSON.stringify(servers)).not.toContain("TOP_SECRET");
    const serverPage1 = requireSuccess<LifecyclePage<McpServerSummary>>(
      await runtime.executeManualTool("list_mcp_servers", { limit: 1 }, fixture.sessionId),
    );
    const serverPage2 = requireSuccess<LifecyclePage<McpServerSummary>>(
      await runtime.executeManualTool(
        "list_mcp_servers",
        { limit: 1, cursor: serverPage1.nextCursor },
        fixture.sessionId,
      ),
    );
    expect(serverPage1.nextCursor).toBeTruthy();
    expect(serverPage2.items[0]?.name).not.toBe(serverPage1.items[0]?.name);

    const page1 = requireSuccess<LifecyclePage<McpResourceDescriptor>>(
      await runtime.executeManualTool("list_mcp_resources", { serverName: "fake", limit: 1 }, fixture.sessionId),
    );
    const page2 = requireSuccess<LifecyclePage<McpResourceDescriptor>>(
      await runtime.executeManualTool(
        "list_mcp_resources",
        { serverName: "fake", limit: 1, cursor: page1.nextCursor },
        fixture.sessionId,
      ),
    );
    expect(page1.nextCursor).toBeTruthy();
    expect(page2.items[0]?.uri).not.toBe(page1.items[0]?.uri);
    expect(JSON.stringify([page1, page2])).not.toContain("TOP_SECRET");
    expect(page1.partial || page2.partial).toBe(true);
    const allResources = requireSuccess<LifecyclePage<McpResourceDescriptor>>(
      await runtime.executeManualTool("list_mcp_resources", { serverName: "fake", limit: 10 }, fixture.sessionId),
    );
    expect(JSON.stringify(allResources)).not.toContain("TOP_SECRET");
    expect(JSON.stringify(allResources)).not.toContain("path-TOP_SECRET");
    expect(JSON.stringify(allResources)).not.toContain("unsafe?token");
    expect(allResources.items.find((item) => item.name === "Structured")?.mimeType)
      .toBe("application/json; token=[REDACTED]");
    expect(allResources.items.every((item) => item.uri.startsWith("mcp-resource://fake/"))).toBe(true);
    const signedReference = allResources.items.find((item) => item.name.startsWith("Signed document"));
    expect(signedReference).toMatchObject({ name: "Signed document [REDACTED]" });
    expect(signedReference?.description).not.toContain("TOP_SECRET");
    const oversizedWarnings = Array.from({ length: 100 }, (_, index) => ({
      code: "capability_unavailable" as const,
      message: `${index}: ${"W".repeat(3_990)}`,
    }));
    vi.spyOn(registry, "discoverResources").mockResolvedValueOnce({
      resources: [{ serverName: "fake", ...descriptors[0]! }],
      scanned: 1,
      partial: true,
      warnings: oversizedWarnings,
    });
    const boundedSingleItem = requireSuccess<LifecyclePage<McpResourceDescriptor>>(
      await runtime.executeManualTool("list_mcp_resources", { serverName: "fake", limit: 1 }, fixture.sessionId),
    );
    expect(boundedSingleItem.items).toHaveLength(1);
    expect(JSON.stringify(boundedSingleItem).length).toBeLessThanOrEqual(262_144);
    expect(boundedSingleItem.warnings[0]?.code).toBe("content_truncated");
    const binaryOnly = requireSuccess<LifecyclePage<McpResourceDescriptor>>(
      await runtime.executeManualTool(
        "list_mcp_resources",
        { serverName: "fake", uriScheme: "memory", mimeType: "application/octet-stream" },
        fixture.sessionId,
      ),
    );
    expect(binaryOnly.items).toHaveLength(1);
    expect(binaryOnly.items[0]?.uri).toMatch(/^mcp-resource:\/\/fake\/[A-Za-z0-9_-]{43}$/u);
    requireErrorType(
      await runtime.executeManualTool(
        "list_mcp_resources",
        { serverName: "fake", mimeType: "text/plain", limit: 1, cursor: page1.nextCursor },
        fixture.sessionId,
      ),
      "invalid_arguments",
    );

    const structured = requireSuccess<McpResourceReadResult>(
      await runtime.executeManualTool(
        "read_mcp_resource",
        { serverName: "fake", uri: descriptors[0]!.uri },
        fixture.sessionId,
      ),
    );
    expect(JSON.stringify(structured)).not.toContain("TOP_SECRET");
    expect(JSON.stringify(structured)).not.toContain(fixture.workspaceRoot);
    expect(structured.structuredData).toMatchObject({
      path: "<workspace>",
      pathCaseVariant: "<workspace>",
      pathSlashVariant: "<workspace>",
      pathExtendedVariant: "<workspace>",
    });
    expect(JSON.stringify(structured)).toContain("[REDACTED]");

    const long = requireSuccess<McpResourceReadResult>(
      await runtime.executeManualTool(
        "read_mcp_resource",
        { serverName: "fake", uri: descriptors[1]!.uri },
        fixture.sessionId,
      ),
    );
    expect(long).toMatchObject({ representation: "text", truncated: true, returnedChars: 2_000_000, binaryInline: false });
    expect(long.artifact).toBeTruthy();
    expect(long.content).not.toContain("TOP_SECRET");
    expect(await fixture.sessionStore.readTextToolOutputArtifact(long.artifact!.uri)).not.toContain("TOP_SECRET");

    const binary = requireSuccess<McpResourceReadResult>(
      await runtime.executeManualTool(
        "read_mcp_resource",
        { serverName: "fake", uri: descriptors[2]!.uri },
        fixture.sessionId,
      ),
    );
    expect(binary).toMatchObject({ representation: "binary", truncated: false, binaryInline: false, sizeBytes: 4 });
    expect(binary).not.toHaveProperty("content");
    expect(await fixture.sessionStore.readBinaryToolOutputArtifact(binary.artifact!.uri)).toEqual(Buffer.from([255, 254, 0, 65]));
    const signed = requireSuccess<McpResourceReadResult>(
      await runtime.executeManualTool(
        "read_mcp_resource",
        { serverName: "fake", uri: signedReference!.uri },
        fixture.sessionId,
      ),
    );
    expect(JSON.stringify(signed)).not.toContain("TOP_SECRET");
    expect(JSON.stringify(signed)).not.toContain("path-TOP_SECRET");
    expect(fake.lastReadUri).toBe(signedUri);
    expect(fake.toolInvocations).toBe(0);
    expect(fake.resourceReads).toBe(4);

    requireErrorType(
      await runtime.executeManualTool("list_mcp_resources", { serverName: "legacy" }, fixture.sessionId),
      "unsupported_protocol",
    );
    requireErrorType(
      await runtime.executeManualTool("list_mcp_resources", { serverName: "down" }, fixture.sessionId),
      "unavailable",
    );
    const missing = await runtime.executeManualTool(
      "read_mcp_resource",
      { serverName: "fake", uri: "memory://fake/missing" },
      fixture.sessionId,
    );
    requireErrorType(missing, "not_found");
    expect(missing.output).not.toContain("TOP_SECRET");
    const remoteError = await runtime.executeManualTool(
      "read_mcp_resource",
      { serverName: "fake", uri: remoteErrorUri },
      fixture.sessionId,
    );
    requireErrorType(remoteError, "not_found");
    expect(remoteError.output).toContain("provider failed while reading");
    expect(remoteError.output).toContain("Bearer [REDACTED]");
    expect(remoteError.output).not.toContain("TOP_SECRET");
    expect(remoteError.output).not.toContain("error-TOP_SECRET");
    expect(remoteError.output).not.toContain(remoteErrorUri);
    expect(remoteError.output).not.toContain(fixture.workspaceRoot);
    const denied = await runtime.executeManualTool(
      "read_mcp_resource",
      { serverName: "fake", uri: "memory://fake/denied" },
      fixture.sessionId,
    );
    requireErrorType(denied, "permission_denied");
    expect(denied.output).not.toContain("TOP_SECRET");

    const resourceSelection = runtime.selectToolsForTurn({ prompt: "List MCP resources" }).definitions.map((tool) => tool.name);
    expect(resourceSelection).toContain("list_mcp_resources");
    expect(resourceSelection).not.toContain("mcp_fake_echo");

    await startPendingToolSearchTurn(fixture.sessionStore, fixture.sessionId, "discover a dynamic MCP tool");
    const dynamicSearch = requireSuccess<{
      matches: Array<{ name: string; source: string }>;
      activation: {
        activatedToolNames: string[];
        rejectedTools: Array<{ name: string; reason: string }>;
      };
    }>(await runtime.executeManualTool("tool_search", {
      query: "mcp_fake_echo",
      mode: "activate",
      sources: ["mcp"],
      maxResults: 5,
      maxActivations: 1,
    }, fixture.sessionId));
    expect(dynamicSearch.matches).toEqual([
      expect.objectContaining({ name: "mcp_fake_echo", source: "mcp" }),
    ]);
    expect(dynamicSearch.matches.some((match) => match.name === "list_mcp_resources")).toBe(false);
    expect(dynamicSearch.activation.activatedToolNames).toEqual([]);
    expect(dynamicSearch.activation.rejectedTools).toContainEqual(expect.objectContaining({
      name: "mcp_fake_echo",
      reason: "workflow_only",
    }));

    requireSuccess(await runtime.executeManualTool("mcp_fake_echo", {}, fixture.sessionId));
    expect(fake.toolInvocations).toBe(1);

    const events = await fixture.sessionStore.loadEvents(fixture.sessionId);
    expect(events).toContainEqual(expect.objectContaining({
      recordType: "approval",
      toolName: "read_mcp_resource",
      permissionCategory: "mcp_read_only",
    }));
    expect(events).toContainEqual(expect.objectContaining({
      recordType: "tool_execution_audit",
      toolName: "read_mcp_resource",
      accessKinds: ["external_system"],
    }));
    expect(events).toContainEqual(expect.objectContaining({
      recordType: "tool_execution_audit",
      toolName: "read_mcp_resource",
      artifactUris: expect.arrayContaining([long.artifact!.uri]),
    }));

    await fs.writeFile(
      path.join(fixture.workspaceRoot, ".deep-mix", "mcp", "servers.json"),
      JSON.stringify({
        version: 1,
        servers: [
          { name: "fake", type: "github", enabled: true },
          { name: "legacy", type: "github", enabled: true },
        ],
      }),
      "utf8",
    );
    const mixedRegistry = new McpRegistry(fixture.workspaceRoot, {
      createAdapter: (entry) => entry.name === "fake" ? fake : undefined,
    });
    await mixedRegistry.initialize();
    const mixedDiscovery = await mixedRegistry.discoverResources();
    expect(mixedDiscovery.resources.length).toBeGreaterThan(0);
    expect(mixedDiscovery.partial).toBe(true);
    expect(mixedDiscovery.warnings).toContainEqual(expect.objectContaining({
      code: "capability_unavailable",
      recordId: "legacy",
    }));
  });

  it("keeps the complete 50-tool phase 15-21 catalog separate from Provider subsets and MCP compatibility", async () => {
    const fixture = await createFixture("deep-mix-phase21-registry-");
    await fs.mkdir(path.join(fixture.workspaceRoot, ".deep-mix", "mcp"), { recursive: true });
    await fs.writeFile(
      path.join(fixture.workspaceRoot, ".deep-mix", "mcp", "servers.json"),
      JSON.stringify({ version: 1, servers: [] }),
      "utf8",
    );
    const registry = new McpRegistry(fixture.workspaceRoot);
    await registry.initialize();
    const broker = new SpecialistBroker({ workspaceRoot: fixture.workspaceRoot, sessionStore: fixture.sessionStore });
    const runtime = trackedRuntime(new ToolRuntime({
      workspaceRoot: fixture.workspaceRoot,
      sessionStore: fixture.sessionStore,
      permissionMode: "danger-full-access",
      specialistBroker: broker,
      mcpRegistry: registry,
    }));
    const definitions = runtime.listRegisteredToolDefinitions();
    const names = definitions.map((tool) => tool.name);
    const phase15To21 = [
      "tool_search", "request_user_input", "get_runtime_capabilities", "glob_files", "read_many_files", "file_metadata", "manage_path",
      "web_fetch", "http_request", "download_file",
      "start_process", "process_input", "process_output", "stop_process", "build", "format", "test_coverage", "inspect_logs",
      "git_history", "git_branch", "git_worktree", "git_stage", "git_commit", "git_restore", "git_integrate",
      "semantic_search", "code_symbols", "go_to_definition", "find_references", "dependency_audit", "security_scan",
      "read_spreadsheet", "write_spreadsheet", "read_presentation", "write_presentation", "read_notebook", "edit_notebook", "read_image", "archive_manage", "convert_document",
      "list_checkpoints", "list_artifacts", "read_artifact", "export_artifact", "worker_status", "worker_output", "worker_cancel", "list_mcp_servers", "list_mcp_resources", "read_mcp_resource",
    ];
    const phase21 = phase15To21.slice(-10);
    expect(phase15To21).toHaveLength(50);
    expect(names).toHaveLength(75);
    expect(new Set(names).size).toBe(75);
    expect(names.slice(-10)).toEqual(phase21);
    expect(names).toEqual(expect.arrayContaining(phase15To21));
    expect(names).not.toContain("invoke_mcp_tool");

    const selected = (prompt: string) => runtime.selectToolsForTurn({ prompt }).definitions.map((tool) => tool.name);
    const ordinaryProviderTools = selected("Refactor this TypeScript function.");
    expect(ordinaryProviderTools.length).toBeLessThan(names.length);
    expect(ordinaryProviderTools.filter((name) => phase21.includes(name))).toEqual([]);
    expect(selected("List artifacts for this session").filter((name) => phase21.includes(name))).toEqual(["list_artifacts"]);
    expect(selected("Check worker status").filter((name) => phase21.includes(name))).toEqual(["worker_status"]);
    expect(selected("List MCP resources").filter((name) => phase21.includes(name))).toEqual(["list_mcp_resources"]);

    const turnId = await startPendingToolSearchTurn(
      fixture.sessionStore,
      fixture.sessionId,
      "activate a built-in lifecycle tool",
    );
    const lifecycleSearch = requireSuccess<{
      matches: Array<{ name: string; source: string }>;
      activation: { activatedToolNames: string[]; lease?: { turnId: string } };
    }>(await runtime.executeManualTool("tool_search", {
      query: "list_artifacts",
      mode: "activate",
      sources: ["built_in"],
      maxResults: 1,
      maxActivations: 1,
    }, fixture.sessionId));
    expect(lifecycleSearch.matches).toEqual([
      expect.objectContaining({ name: "list_artifacts", source: "built_in" }),
    ]);
    expect(lifecycleSearch.activation.activatedToolNames).toEqual(["list_artifacts"]);
    expect(lifecycleSearch.activation.lease).toMatchObject({ turnId });
    const activeLease = await runtime.loadActiveToolSelectionLeases(fixture.sessionId, turnId);
    expect(activeLease.toolNames).toEqual(["list_artifacts"]);
    expect(runtime.selectToolsForTurn({
      prompt: "opaque follow-up",
      activatedToolNames: activeLease.toolNames,
    }).definitions.map((tool) => tool.name)).toContain("list_artifacts");

    const compatibilityFixture = await createFixture("deep-mix-phase21-mcp-compat-");
    const compatibilityRuntime = trackedRuntime(new ToolRuntime({
      workspaceRoot: compatibilityFixture.workspaceRoot,
      sessionStore: compatibilityFixture.sessionStore,
      permissionMode: "danger-full-access",
      mcpExecutor: async () => ({ output: "legacy compatibility", structuredContent: { legacy: true } }),
    }));
    expect(compatibilityRuntime.listRegisteredToolDefinitions().map((tool) => tool.name)).toContain("invoke_mcp_tool");
    expect(requireSuccess<{ legacy: boolean }>(
      await compatibilityRuntime.executeManualTool(
        "invoke_mcp_tool",
        { server: "legacy", tool: "read", input: {} },
        compatibilityFixture.sessionId,
      ),
    )).toEqual({ legacy: true });
  });
});
