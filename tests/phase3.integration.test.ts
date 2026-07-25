import { execFile } from "node:child_process";
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import { afterEach, describe, expect, it } from "vitest";
import { SupervisorReviewService } from "../packages/core-governor/src/index.js";
import { SessionStore } from "../packages/persistence/src/index.js";
import type { WorkerTask } from "../packages/shared-schema/src/index.js";
import { SpecialistBroker } from "../packages/specialist-broker/src/index.js";
import { ToolRuntime, PermissionRequiredError } from "../packages/tool-runtime/src/index.js";
import { GlmWorkerError, type CodingWorkerRunner, type GlmCodingWorkerExecutionResult } from "../packages/worker-glm-coding/src/index.js";

const execFileAsync = promisify(execFile);
const temporaryRoots: string[] = [];

async function runGit(args: string[], cwd: string): Promise<string> {
  const result = await execFileAsync("git", args, { cwd });
  return result.stdout.trim();
}

async function initializeGitRepo(workspaceRoot: string): Promise<string> {
  await runGit(["init"], workspaceRoot);
  await runGit(["config", "user.name", "Deep Mix Test"], workspaceRoot);
  await runGit(["config", "user.email", "deep-mix-test@local.invalid"], workspaceRoot);
  await runGit(["add", "."], workspaceRoot);
  await runGit(["commit", "-m", "initial"], workspaceRoot);
  return runGit(["rev-parse", "HEAD"], workspaceRoot);
}

async function createFixtureWorkspace(options?: {
  initialExpression?: string;
  withGitRepo?: boolean;
}): Promise<{ workspaceRoot: string; initialHead?: string }> {
  const workspaceRoot = await fs.mkdtemp(path.join(os.tmpdir(), "deep-mix-phase3-"));
  temporaryRoots.push(workspaceRoot);
  const initialExpression = options?.initialExpression ?? "a - b";
  await fs.mkdir(path.join(workspaceRoot, "src"), { recursive: true });
  await fs.mkdir(path.join(workspaceRoot, "test"), { recursive: true });
  await fs.mkdir(path.join(workspaceRoot, ".deep-mix", "api-key-library"), { recursive: true });
  await fs.writeFile(
    path.join(workspaceRoot, "package.json"),
    JSON.stringify(
      {
        name: "phase3-fixture",
        private: true,
        type: "module",
      },
      null,
      2,
    ),
    "utf8",
  );
  await fs.writeFile(
    path.join(workspaceRoot, "src", "add.js"),
    ["export function add(a, b) {", `  return ${initialExpression};`, "}", ""].join("\n"),
    "utf8",
  );
  await fs.writeFile(
    path.join(workspaceRoot, "test", "add.test.js"),
    [
      "import test from 'node:test';",
      "import assert from 'node:assert/strict';",
      "import { add } from '../src/add.js';",
      "",
      "test('add sums two numbers', () => {",
      "  assert.equal(add(2, 3), 5);",
      "});",
      "",
    ].join("\n"),
    "utf8",
  );
  await fs.writeFile(
    path.join(workspaceRoot, ".deep-mix", "api-key-library", "profiles.local.json"),
    JSON.stringify(
      {
        version: 1,
        profiles: {
          glm_coding_worker: {
            provider: "glm",
            role: "coding_worker",
            apiKey: "fake-local-key",
            baseUrl: "https://example.invalid",
            chatPath: "/chat/completions",
            model: "glm-5.2",
            headers: {
              "Content-Type": "application/json",
            },
            requestDefaults: {},
          },
        },
      },
      null,
      2,
    ),
    "utf8",
  );

  return {
    workspaceRoot,
    initialHead: options?.withGitRepo ? await initializeGitRepo(workspaceRoot) : undefined,
  };
}

function createTask(extraContextRefs: WorkerTask["contextRefs"] = []): WorkerTask {
  return {
    workerType: "coding",
    objective: "Fix add(a, b) so it returns the sum.",
    constraints: ["Keep the existing module API.", "Do not modify package.json."],
    contextRefs: ["file://src/add.js", ...extraContextRefs],
    expectedOutput: "code_artifact",
    acceptanceChecks: ["Return a valid apply_patch envelope.", "Keep the tests green."],
  };
}

function createWorkerResult(input: {
  summary: string;
  fromExpression: string;
  toExpression: string;
  risks?: string[];
  testCommands?: string[];
}): GlmCodingWorkerExecutionResult {
  const testCommands = input.testCommands ?? ["node --test test/add.test.js"];
  return {
    artifact: {
      summary: input.summary,
      changedFiles: ["src/add.js"],
      testCommands,
      risks: input.risks ?? ["No known additional risk."],
      confidence: 0.9,
      notes: ["Worker only returned an artifact and patch."],
      metadata: {
        source: "fake-worker",
      },
    },
    patch: [
      "*** Begin Patch",
      "*** Update File: src/add.js",
      "@@",
      " export function add(a, b) {",
      `-  return ${input.fromExpression};`,
      `+  return ${input.toExpression};`,
      " }",
      "*** End Patch",
    ].join("\n"),
    rawResponse: [
      "<code_artifact>",
      JSON.stringify(
        {
          summary: input.summary,
          changedFiles: ["src/add.js"],
          testCommands,
          risks: input.risks ?? ["No known additional risk."],
          confidence: 0.9,
          notes: ["Worker only returned an artifact and patch."],
        },
        null,
        2,
      ),
      "</code_artifact>",
      "<patch>",
      "*** Begin Patch",
      "*** Update File: src/add.js",
      "@@",
      " export function add(a, b) {",
      `-  return ${input.fromExpression};`,
      `+  return ${input.toExpression};`,
      " }",
      "*** End Patch",
      "</patch>",
    ].join("\n"),
  };
}

async function createPhase3Harness(options: {
  permissionMode: "edit" | "danger-full-access";
  workerFactory: () => CodingWorkerRunner;
  withGitRepo?: boolean;
  initialExpression?: string;
}): Promise<{
  workspaceRoot: string;
  sessionStore: SessionStore;
  toolRuntime: ToolRuntime;
  broker: SpecialistBroker;
  supervisor: SupervisorReviewService;
  sessionId: string;
  initialHead?: string;
}> {
  const { workspaceRoot, initialHead } = await createFixtureWorkspace({
    withGitRepo: options.withGitRepo,
    initialExpression: options.initialExpression,
  });
  const sessionStore = new SessionStore(workspaceRoot);
  await sessionStore.ensureInitialized();
  const session = await sessionStore.createSession("phase 3 test session");
  const broker = new SpecialistBroker({
    workspaceRoot,
    sessionStore,
    codingWorkerFactory: () => options.workerFactory(),
  });
  const toolRuntime = new ToolRuntime({
    workspaceRoot,
    sessionStore,
    permissionMode: options.permissionMode,
    specialistBroker: broker,
  });
  const supervisor = new SupervisorReviewService(sessionStore, toolRuntime, broker);
  return {
    workspaceRoot,
    sessionStore,
    toolRuntime,
    broker,
    supervisor,
    sessionId: session.sessionId,
    initialHead,
  };
}

afterEach(async () => {
  await Promise.all(
    temporaryRoots.splice(0).map(async (root) => {
      await fs.rm(root, { recursive: true, force: true });
    }),
  );
});

describe("phase 3 supervisor review loop", () => {
  it("blocks artifact patch application until approval is granted, then applies the patch, runs verification, and logs promotion details", async () => {
    const harness = await createPhase3Harness({
      permissionMode: "edit",
      withGitRepo: true,
      workerFactory: () =>
        ({
          runTask: async () =>
            createWorkerResult({
              summary: "Replace subtraction with addition.",
              fromExpression: "a - b",
              toExpression: "a + b",
            }),
        }) satisfies CodingWorkerRunner,
    });

    const workerResult = await harness.broker.invokeCodingWorker({
      parentSessionId: harness.sessionId,
      task: createTask(),
    });
    expect(workerResult.artifact?.changedFiles).toEqual(["src/add.js"]);
    const workerArtifact = await harness.sessionStore.loadLatestWorkerArtifact(workerResult.workerSessionId);
    expect(workerArtifact).toBeDefined();

    const verification = await harness.supervisor.continueVerification({
      workerSessionId: workerResult.workerSessionId,
      decision: {
        action: "continueVerification",
        reason: "Read the target file and inspect repository diff before accepting.",
        evidenceRefs: [workerArtifact!.artifactRef as `artifact://${string}`],
        verificationCommands: ["read_file:src/add.js", "git_diff"],
      },
    });
    expect(verification.canAccept).toBe(true);

    await harness.supervisor.accept({
      workerSessionId: workerResult.workerSessionId,
      decision: {
        action: "accept",
        reason: "The artifact summary matches the requested fix and directed verification passed.",
        evidenceRefs: [workerArtifact!.artifactRef as `artifact://${string}`],
      },
    });

    let approvalError: PermissionRequiredError | undefined;
    try {
      await harness.supervisor.applyAcceptedPatch({
        workerSessionId: workerResult.workerSessionId,
      });
    } catch (error) {
      approvalError = error as PermissionRequiredError;
    }
    expect(approvalError).toBeInstanceOf(PermissionRequiredError);
    expect(await fs.readFile(path.join(harness.workspaceRoot, "src", "add.js"), "utf8")).toContain("return a - b;");

    await harness.toolRuntime.resolveApproval({
      sessionId: harness.sessionId,
      approvalId: approvalError!.approvalId,
      toolName: approvalError!.toolName,
      requestKey: approvalError!.requestKey,
      persistence: "allow_session",
      reason: "Approve worker patch application for the test session.",
    });
    const applyResult = await harness.supervisor.applyAcceptedPatch({
      workerSessionId: workerResult.workerSessionId,
    });
    expect(applyResult.success).toBe(true);
    expect(await fs.readFile(path.join(harness.workspaceRoot, "src", "add.js"), "utf8")).toContain("return a + b;");
    const applyBody = JSON.parse(applyResult.output) as {
      verificationResults?: Array<{
        toolName?: string;
        success?: boolean;
        output?: string;
        structuredContent?: { kind?: string; passed?: number; failed?: number; ok?: boolean };
      }>;
      diagnostics?: Array<{ kind?: string; status?: string; rawOutput?: string }>;
      diagnosticReport?: { recordType?: string };
    };
    expect(applyBody.verificationResults).toEqual(expect.arrayContaining([expect.objectContaining({
      toolName: "run_tests",
      success: true,
      structuredContent: expect.objectContaining({ kind: "run_tests", passed: 1, failed: 0, ok: true }),
    })]));
    expect(applyBody.verificationResults?.[0]?.output).toContain("add sums two numbers");
    expect(applyBody.diagnostics).toEqual(expect.arrayContaining([expect.objectContaining({
      kind: "run_tests",
      status: "ok",
      rawOutput: expect.stringContaining("add sums two numbers"),
    })]));
    expect(applyBody.diagnosticReport?.recordType).toBe("diagnostic_report");
    expect(applyResult.output).not.toContain("verification=run_tests:ok");
    const executionEvents = await harness.sessionStore.loadEvents(harness.sessionId);
    expect(executionEvents.find((event) =>
      event.recordType === "approval" &&
      event.toolName === "run_tests" &&
      event.executionOrigin === "runtime_post_edit_verification"
    )).toMatchObject({
      parentToolName: "apply_artifact_patch",
      parentCallId: expect.any(String),
      decision: "allow",
    });
    expect(executionEvents.find((event) =>
      event.recordType === "tool_execution_audit" &&
      event.toolName === "run_tests" &&
      event.executionOrigin === "runtime_post_edit_verification"
    )).toMatchObject({
      parentToolName: "apply_artifact_patch",
      parentCallId: expect.any(String),
      success: true,
    });

    const approvalLog = await fs.readFile(
      path.join(harness.workspaceRoot, ".deep-mix", "approval-records", `${harness.sessionId}.jsonl`),
      "utf8",
    );
    expect(approvalLog).toContain("\"status\":\"pending\"");
    expect(approvalLog).toContain("\"status\":\"resolved\"");
    expect(approvalLog).toContain("\"toolName\":\"apply_artifact_patch\"");

    const promotionLog = await fs.readFile(path.join(harness.workspaceRoot, ".deep-mix", "promotion-log.jsonl"), "utf8");
    expect(promotionLog).toContain("\"recordType\":\"artifact_promotion\"");
    expect(promotionLog).toContain("\"verificationSummary\":[\"run_tests:ok\"]");

    const sessionJsonl = await fs.readFile(
      path.join(harness.workspaceRoot, ".deep-mix", "sessions", `${harness.sessionId}.jsonl`),
      "utf8",
    );
    expect(sessionJsonl).not.toContain("*** Begin Patch");
    expect(sessionJsonl).toContain("\"recordType\":\"supervisor_decision\"");
  }, 30_000);

  it("binds a session approval to the accepted artifact and its exact verification commands", async () => {
    let invocation = 0;
    const harness = await createPhase3Harness({
      permissionMode: "edit",
      workerFactory: () =>
        ({
          runTask: async () => {
            invocation += 1;
            return createWorkerResult({
              summary: invocation === 1 ? "Initial accepted artifact." : "Revised accepted artifact.",
              fromExpression: "a - b",
              toExpression: "a + b",
              testCommands: invocation === 1
                ? ["node --test test/add.test.js"]
                : ["node --test test/add.test.js --test-name-pattern='add sums two numbers'"],
            });
          },
        }) satisfies CodingWorkerRunner,
    });

    const initial = await harness.broker.invokeCodingWorker({
      parentSessionId: harness.sessionId,
      task: createTask(),
    });
    const initialArtifact = await harness.sessionStore.loadLatestWorkerArtifact(initial.workerSessionId);
    await harness.supervisor.accept({
      workerSessionId: initial.workerSessionId,
      decision: {
        action: "accept",
        reason: "Pin the initial artifact for approval identity testing.",
        evidenceRefs: [initialArtifact!.artifactRef as `artifact://${string}`],
      },
    });

    let firstApproval: PermissionRequiredError | undefined;
    try {
      await harness.supervisor.applyAcceptedPatch({ workerSessionId: initial.workerSessionId });
    } catch (error) {
      firstApproval = error as PermissionRequiredError;
    }
    expect(firstApproval).toBeInstanceOf(PermissionRequiredError);
    await harness.toolRuntime.resolveApproval({
      sessionId: harness.sessionId,
      approvalId: firstApproval!.approvalId,
      toolName: firstApproval!.toolName,
      requestKey: firstApproval!.requestKey,
      persistence: "allow_session",
      reason: "Approve only the pinned initial artifact.",
    });

    await harness.supervisor.revise({
      workerSessionId: initial.workerSessionId,
      decision: {
        action: "revise",
        reason: "Create a distinct artifact with a distinct verification command.",
        evidenceRefs: [initialArtifact!.artifactRef as `artifact://${string}`],
      },
      revisionRequest: "Return a revised accepted artifact for approval identity testing.",
    });
    const revisedArtifact = await harness.sessionStore.loadLatestWorkerArtifact(initial.workerSessionId);
    await harness.supervisor.accept({
      workerSessionId: initial.workerSessionId,
      decision: {
        action: "accept",
        reason: "Accept the revised artifact, which must require a fresh approval.",
        evidenceRefs: [revisedArtifact!.artifactRef as `artifact://${string}`],
      },
    });

    let revisedApproval: PermissionRequiredError | undefined;
    try {
      await harness.supervisor.applyAcceptedPatch({ workerSessionId: initial.workerSessionId });
    } catch (error) {
      revisedApproval = error as PermissionRequiredError;
    }
    expect(revisedApproval).toBeInstanceOf(PermissionRequiredError);
    expect(revisedApproval?.requestKey).not.toBe(firstApproval?.requestKey);
    expect(await fs.readFile(path.join(harness.workspaceRoot, "src", "add.js"), "utf8")).toContain("return a - b;");
  }, 15_000);

  it("uses revise on the same worker session after a failed post-apply test run and succeeds on the revised artifact", async () => {
    let invocation = 0;
    const harness = await createPhase3Harness({
      permissionMode: "danger-full-access",
      workerFactory: () =>
        ({
          runTask: async ({ resolvedContext }) => {
            invocation += 1;
            if (invocation === 1) {
              return createWorkerResult({
                summary: "Mistakenly changed add() to multiply values.",
                fromExpression: "a - b",
                toExpression: "a * b",
                risks: ["Tests may fail until the revision is applied."],
              });
            }
            expect(resolvedContext).toContain("Supervisor revision request");
            return createWorkerResult({
              summary: "Revised the worker patch so add() now returns the sum.",
              fromExpression: "a * b",
              toExpression: "a + b",
            });
          },
        }) satisfies CodingWorkerRunner,
    });

    const initial = await harness.broker.invokeCodingWorker({
      parentSessionId: harness.sessionId,
      task: createTask(),
    });
    const initialArtifact = await harness.sessionStore.loadLatestWorkerArtifact(initial.workerSessionId);
    await harness.supervisor.accept({
      workerSessionId: initial.workerSessionId,
      decision: {
        action: "accept",
        reason: "Apply the first artifact so verification can decide whether revise is needed.",
        evidenceRefs: [initialArtifact!.artifactRef as `artifact://${string}`],
      },
    });

    const firstApply = await harness.supervisor.applyAcceptedPatch({
      workerSessionId: initial.workerSessionId,
    });
    expect(firstApply.success).toBe(false);
    expect(await fs.readFile(path.join(harness.workspaceRoot, "src", "add.js"), "utf8")).toContain("return a * b;");

    const revise = await harness.supervisor.revise({
      workerSessionId: initial.workerSessionId,
      decision: {
        action: "revise",
        reason: "Tests failed after applying the patch, so the same worker session must revise it.",
        evidenceRefs: [initialArtifact!.artifactRef as `artifact://${string}`],
      },
      revisionRequest: "Fix add(a, b) so node --test test/add.test.js passes.",
    });
    expect(revise.result.workerSessionId).toBe(initial.workerSessionId);
    expect(revise.result.artifact?.summary).toContain("Revised");

    const revisedArtifact = await harness.sessionStore.loadLatestWorkerArtifact(initial.workerSessionId);
    await harness.supervisor.accept({
      workerSessionId: initial.workerSessionId,
      decision: {
        action: "accept",
        reason: "The revised artifact addresses the failing test output.",
        evidenceRefs: [revisedArtifact!.artifactRef as `artifact://${string}`],
      },
    });
    const secondApply = await harness.supervisor.applyAcceptedPatch({
      workerSessionId: initial.workerSessionId,
    });
    expect(secondApply.success).toBe(true);
    expect(await fs.readFile(path.join(harness.workspaceRoot, "src", "add.js"), "utf8")).toContain("return a + b;");

    const workerMeta = await harness.sessionStore.loadWorkerSession(initial.workerSessionId);
    expect(workerMeta?.revisionCount).toBe(1);
  });

  it("retries with more context and then supports fallback to the governor when the worker still fails", async () => {
    let invocation = 0;
    const harness = await createPhase3Harness({
      permissionMode: "danger-full-access",
      workerFactory: () =>
        ({
          runTask: async ({ resolvedContext }) => {
            invocation += 1;
            if (invocation === 1) {
              return createWorkerResult({
                summary: "Initial artifact without the additional governance context.",
                fromExpression: "a - b",
                toExpression: "a + b",
              });
            }
            expect(resolvedContext).toContain("Need to preserve the public API.");
            throw new GlmWorkerError("response_parse_failed", "Worker still failed after receiving more context.", {
              retryable: false,
              rawResponse: "<broken-response>",
            });
          },
        }) satisfies CodingWorkerRunner,
    });

    const initial = await harness.broker.invokeCodingWorker({
      parentSessionId: harness.sessionId,
      task: createTask(),
    });
    const artifact = await harness.sessionStore.loadLatestWorkerArtifact(initial.workerSessionId);

    const retry = await harness.supervisor.retryWithMoreContext({
      workerSessionId: initial.workerSessionId,
      decision: {
        action: "retryWithMoreContext",
        reason: "Add the missing API constraint context and try the worker again.",
        evidenceRefs: [artifact!.artifactRef as `artifact://${string}`],
        extraContextRefs: [
          {
            refType: "summary",
            label: "API rule",
            summary: "Need to preserve the public API.",
          },
        ],
      },
    });
    expect(retry.result.error?.errorType).toBe("response_parse_failed");

    const fallback = await harness.supervisor.fallbackToGovernor({
      workerSessionId: initial.workerSessionId,
      decision: {
        action: "fallbackToGovernor",
        reason: "The worker still failed after a retry with more context.",
        evidenceRefs: [artifact!.artifactRef as `artifact://${string}`],
      },
    });
    expect(fallback.resultingState).toBe("governor_fallback");

    const workerMeta = await harness.sessionStore.loadWorkerSession(initial.workerSessionId);
    expect(workerMeta?.retryCount).toBe(1);
  });

  it("restores code-only, conversation-only, and both modes without mutating the user repository git history", async () => {
    const harness = await createPhase3Harness({
      permissionMode: "danger-full-access",
      withGitRepo: true,
      workerFactory: () =>
        ({
          runTask: async () =>
            createWorkerResult({
              summary: "Unused worker fixture.",
              fromExpression: "a - b",
              toExpression: "a + b",
            }),
        }) satisfies CodingWorkerRunner,
    });

    const applyAddition = async (): Promise<void> => {
      await harness.toolRuntime.executeManualTool(
        "apply_patch",
        {
          reason: "Switch add() to addition.",
          changes: [
            {
              path: "src/add.js",
              action: "upsert",
              content: ["export function add(a, b) {", "  return a + b;", "}", ""].join("\n"),
            },
          ],
        },
        harness.sessionId,
      );
    };

    const applySubtraction = async (): Promise<void> => {
      await harness.toolRuntime.executeManualTool(
        "apply_patch",
        {
          reason: "Switch add() back to subtraction.",
          changes: [
            {
              path: "src/add.js",
              action: "upsert",
              content: ["export function add(a, b) {", "  return a - b;", "}", ""].join("\n"),
            },
          ],
        },
        harness.sessionId,
      );
    };

    await applyAddition();
    const codeCheckpoint = (await harness.sessionStore.listUndoCandidates(harness.sessionId))[0]!;
    await harness.toolRuntime.executeManualTool(
      "rollback_checkpoint",
      {
        checkpointId: codeCheckpoint.checkpointId,
        mode: "code",
      },
      harness.sessionId,
    );
    expect(await fs.readFile(path.join(harness.workspaceRoot, "src", "add.js"), "utf8")).toContain("return a - b;");

    await applyAddition();
    const conversationCheckpoint = (await harness.sessionStore.listUndoCandidates(harness.sessionId))[0]!;
    await harness.sessionStore.appendMessage({
      sessionId: harness.sessionId,
      turnId: "manual-conversation",
      role: "assistant",
      content: "temporary conversation entry",
    });
    await harness.toolRuntime.executeManualTool(
      "rollback_checkpoint",
      {
        checkpointId: conversationCheckpoint.checkpointId,
        mode: "conversation",
      },
      harness.sessionId,
    );
    expect(await fs.readFile(path.join(harness.workspaceRoot, "src", "add.js"), "utf8")).toContain("return a + b;");
    const conversationJsonl = await fs.readFile(
      path.join(harness.workspaceRoot, ".deep-mix", "sessions", `${harness.sessionId}.jsonl`),
      "utf8",
    );
    expect(conversationJsonl).not.toContain("temporary conversation entry");

    await applySubtraction();
    const bothCheckpoint = (await harness.sessionStore.listUndoCandidates(harness.sessionId))[0]!;
    await harness.sessionStore.appendMessage({
      sessionId: harness.sessionId,
      turnId: "manual-both",
      role: "assistant",
      content: "temporary both entry",
    });
    await harness.toolRuntime.executeManualTool(
      "undo",
      {
        checkpointId: bothCheckpoint.checkpointId,
        mode: "both",
      },
      harness.sessionId,
    );
    expect(await fs.readFile(path.join(harness.workspaceRoot, "src", "add.js"), "utf8")).toContain("return a + b;");
    const finalSessionJsonl = await fs.readFile(
      path.join(harness.workspaceRoot, ".deep-mix", "sessions", `${harness.sessionId}.jsonl`),
      "utf8",
    );
    expect(finalSessionJsonl).not.toContain("temporary both entry");

    const finalHead = await runGit(["rev-parse", "HEAD"], harness.workspaceRoot);
    expect(finalHead).toBe(harness.initialHead);
  });
});
