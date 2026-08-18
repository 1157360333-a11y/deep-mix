import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import {
  GovernorRuntime,
  PermissionRequiredError,
  validateMessageHistory,
} from "../packages/core-governor/src/index.js";
import { SessionStore } from "../packages/persistence/src/index.js";
import { SpecialistBroker } from "../packages/specialist-broker/src/index.js";
import type {
  AssistantResponse,
  ContextSummaryRecord,
  ConversationMessage,
  ModelCompletionRequest,
  ModelClient,
  RuntimeCapabilitySnapshot,
  StreamCallbacks,
  ToolActivationRecord,
  ToolExecutionAuditRecord,
  ToolSelectionRecord,
} from "../packages/shared-schema/src/index.js";
import {
  builtInToolModules,
  ToolRegistry,
  ToolRuntime,
  type RuntimeToolSpec,
  type ToolModule,
} from "../packages/tool-runtime/src/index.js";

const temporaryRoots: string[] = [];
const disposables: Array<{ dispose(): Promise<void> }> = [];

const CORE_TOOL_NAMES = [
  "lsp_diagnostics",
  "lint_diagnostics",
  "typecheck_diagnostics",
  "read_file",
  "search_files",
  "list_files",
  "apply_patch",
  "run_shell",
  "run_tests",
  "lint",
  "typecheck",
  "git_status",
  "git_diff",
  "apply_artifact_patch",
  "rollback_checkpoint",
  "undo",
  "invoke_coding_worker",
  "invoke_vision_worker",
  "update_plan",
] as const;

const PHASE15_TOOL_NAMES = [
  "tool_search",
  "request_user_input",
  "get_runtime_capabilities",
  "glob_files",
  "read_many_files",
  "file_metadata",
  "manage_path",
] as const;

class ScriptedModelClient implements ModelClient {
  private index = 0;

  public readonly requests: ModelCompletionRequest[] = [];

  public constructor(
    private readonly responses: Array<
      AssistantResponse | ((request: ModelCompletionRequest) => AssistantResponse | Promise<AssistantResponse>)
    >,
  ) {}

  public async streamCompletion(
    request: ModelCompletionRequest,
    callbacks?: StreamCallbacks,
  ): Promise<AssistantResponse> {
    this.requests.push(request);
    const scripted = this.responses[this.index++];
    if (!scripted) throw new Error(`Unexpected model call ${this.index - 1}.`);
    const response = typeof scripted === "function" ? await scripted(request) : scripted;
    for (const character of response.content) callbacks?.onTextDelta?.(character);
    return response;
  }
}

async function createWorkspace(prefix: string): Promise<{
  workspaceRoot: string;
  sessionStore: SessionStore;
  sessionId: string;
}> {
  const workspaceRoot = await fs.mkdtemp(path.join(os.tmpdir(), prefix));
  temporaryRoots.push(workspaceRoot);
  const sessionStore = new SessionStore(workspaceRoot);
  await sessionStore.ensureInitialized();
  const session = await sessionStore.createSession("phase 15 integration");
  return { workspaceRoot, sessionStore, sessionId: session.sessionId };
}

function createRuntime(input: {
  workspaceRoot: string;
  sessionStore: SessionStore;
  permissionMode?: "plan" | "auto" | "danger-full-access";
  registry?: ToolRegistry<RuntimeToolSpec>;
  modules?: readonly ToolModule[];
}): ToolRuntime {
  const runtime = new ToolRuntime({
    workspaceRoot: input.workspaceRoot,
    sessionStore: input.sessionStore,
    permissionMode: input.permissionMode ?? "danger-full-access",
    registry: input.registry,
    modules: input.modules,
    specialistBroker: new SpecialistBroker({
      workspaceRoot: input.workspaceRoot,
      sessionStore: input.sessionStore,
    }),
  });
  disposables.push(runtime);
  return runtime;
}

async function startPendingTurn(sessionStore: SessionStore, sessionId: string, prompt = "phase 15"): Promise<string> {
  const turn = await sessionStore.startTurn({
    sessionId,
    requestSummary: prompt,
    userMessageId: "pending-user-message",
  });
  await sessionStore.recordToolSelection({
    recordType: "tool_selection",
    selectionId: `selection-${turn.turnId}-1`,
    sessionId,
    turnId: turn.turnId,
    createdAt: new Date().toISOString(),
    providerCycle: 1,
    activationLeaseIds: [],
    activatedToolNames: [],
    estimatedToolSchemaTokens: 0,
    selectedCount: 2,
    unselectedCount: 0,
    selectedToolNames: ["tool_search", "request_user_input"],
    reasonCounts: { always_available: 2 },
  });
  return turn.turnId;
}

function capabilitySnapshot(rgAvailable: boolean): RuntimeCapabilitySnapshot {
  return {
    checkedAt: "2026-07-13T00:00:00.000Z",
    capabilities: {
      rg: {
        name: "rg",
        available: rgAvailable,
        command: rgAvailable ? "rg" : "",
        version: rgAvailable ? "test-rg" : undefined,
        message: rgAvailable ? "available" : "unavailable",
      },
    },
    fallbacks: {
      listFiles: rgAvailable ? "rg" : "node_fs",
      searchFiles: rgAvailable ? "rg" : "node_text",
    },
  } as RuntimeCapabilitySnapshot;
}

function injectCapabilitySnapshot(runtime: ToolRuntime, snapshot: RuntimeCapabilitySnapshot): void {
  Reflect.set(runtime, "capabilitySnapshot", snapshot);
}

function toolCall(id: string, name: string, args: Record<string, unknown>) {
  return {
    id,
    name,
    arguments: args,
    rawArguments: JSON.stringify(args),
  };
}

function expectConversationHistoryLegal(messages: ConversationMessage[]): void {
  const pending: string[] = [];
  for (const message of messages) {
    if (message.role === "assistant" && message.tool_calls?.length) {
      pending.push(...message.tool_calls.map((call) => call.id));
    } else if (message.role === "tool") {
      expect(message.tool_call_id).toBe(pending.shift());
    }
  }
  expect(pending).toHaveLength(0);
}

function fixtureTool(
  name: string,
  input: {
    readOnly?: boolean;
    workflowOnly?: boolean;
    keywords?: string[];
    onExecute?: () => void;
  } = {},
): RuntimeToolSpec {
  const readOnly = input.readOnly ?? true;
  return {
    name,
    displayName: name,
    description: `Phase 15 fixture ${name}.`,
    inputSchema: { type: "object", additionalProperties: false, properties: {} },
    readOnly,
    permissionCategory: readOnly ? "read_only" : "write_file",
    sideEffectLevel: readOnly ? "none" : "high",
    timeoutCategory: "fast",
    groups: ["phase15_fixture"],
    selection: {
      groups: ["phase15_fixture"],
      keywords: input.keywords ?? [name],
      workflowOnly: input.workflowOnly,
      attachmentExtensions: [],
      mimeTypes: [],
    },
    resolveAccess: () => [],
    execute: async (_args, context) => {
      input.onExecute?.();
      const timestamp = context.moduleContext.clock.now();
      return {
        toolName: name,
        callId: context.callId,
        startedAt: timestamp,
        endedAt: timestamp,
        success: true,
        output: `${name}:ok`,
      };
    },
  };
}

afterEach(async () => {
  await Promise.allSettled(disposables.splice(0).map((runtime) => runtime.dispose()));
  await Promise.all(temporaryRoots.splice(0).map((root) => fs.rm(root, { recursive: true, force: true })));
});

describe("phase 15 tool discovery, interaction, and repository enhancements", () => {
  it("registers the seven trusted tools at the stable tail with bilingual and attachment-aware selection metadata", async () => {
    const fixture = await createWorkspace("deep-mix-phase15-registry-");
    const runtime = createRuntime(fixture);
    const definitions = runtime.listToolDefinitions();

    // Phase 15 freezes the 32-tool baseline but later phases may append tools.
    expect(definitions.length).toBeGreaterThanOrEqual(32);
    expect(definitions.slice(0, 19).map((tool) => tool.name)).toEqual(CORE_TOOL_NAMES);
    expect(PHASE15_TOOL_NAMES.every((name) => definitions.some((tool) => tool.name === name))).toBe(true);

    const expectedModules = new Map<string, string>([
      ["tool_search", "builtin.catalog"],
      ["request_user_input", "builtin.session"],
      ["get_runtime_capabilities", "builtin.catalog"],
      ["glob_files", "builtin.repository.enhancements"],
      ["read_many_files", "builtin.repository.enhancements"],
      ["file_metadata", "builtin.repository.enhancements"],
      ["manage_path", "builtin.workspace.paths"],
    ]);
    for (const name of PHASE15_TOOL_NAMES) {
      const definition = definitions.find((tool) => tool.name === name)!;
      expect(definition.moduleId).toBe(expectedModules.get(name));
      expect(definition.selection?.groups?.length).toBeGreaterThan(0);
      expect(definition.selection?.keywords?.some((keyword) => /[a-z]/iu.test(keyword))).toBe(true);
      expect(definition.selection?.keywords?.some((keyword) => /[\u3400-\u9fff]/u.test(keyword))).toBe(true);
      expect(definition.selection).toHaveProperty("attachmentExtensions");
      expect(definition.selection).toHaveProperty("mimeTypes");
    }

    expect(
      runtime.selectToolsForTurn({ prompt: "Hello, how are you?" }).definitions
        .map((tool) => tool.name)
        .filter((name) => PHASE15_TOOL_NAMES.includes(name as (typeof PHASE15_TOOL_NAMES)[number])),
    ).toEqual(["request_user_input", "tool_search"]);
    expect(runtime.selectToolsForTurn({ attachmentExtensions: [".ts"] }).definitions.map((tool) => tool.name))
      .toEqual(expect.arrayContaining(["read_many_files", "file_metadata"]));
  });

  it("ranks, bounds, activates, and expires tool_search leases only on later Provider cycles", async () => {
    const direct = await createWorkspace("deep-mix-phase15-search-direct-");
    const directRuntime = createRuntime(direct);
    const turnId = await startPendingTurn(direct.sessionStore, direct.sessionId, "opaque discovery task");
    const activation = await directRuntime.executeManualTool(
      "tool_search",
      {
        query: "get_runtime_capabilities",
        mode: "activate",
        maxResults: 1,
        maxActivations: 1,
      },
      direct.sessionId,
    );
    const activationBody = activation.structuredContent as {
      matches: Array<{ name: string; score: number }>;
      activation: ToolActivationRecord;
    };
    expect(activation.success).toBe(true);
    expect(activationBody.matches).toHaveLength(1);
    expect(activationBody.matches[0]?.name).toBe("get_runtime_capabilities");
    expect(activationBody.activation.activatedToolNames).toEqual(["get_runtime_capabilities"]);
    expect(activationBody.activation.lease).toMatchObject({
      turnId,
      firstProviderCycle: 2,
      expiresAfterProviderCycle: 5,
    });
    expect((await direct.sessionStore.loadEvents(direct.sessionId)).filter(
      (event): event is ToolExecutionAuditRecord => event.recordType === "tool_execution_audit",
    ).map((event) => event.toolName)).toEqual(["tool_search"]);

    const active = await directRuntime.loadActiveToolSelectionLeases(direct.sessionId, turnId);
    expect(active.providerCycle).toBe(2);
    expect(active.toolNames).toEqual(["get_runtime_capabilities"]);
    for (let providerCycle = 2; providerCycle <= 5; providerCycle += 1) {
      await direct.sessionStore.recordToolSelection({
        recordType: "tool_selection",
        selectionId: `selection-${providerCycle}`,
        sessionId: direct.sessionId,
        turnId,
        createdAt: new Date().toISOString(),
        providerCycle,
        activationLeaseIds: [activationBody.activation.lease!.leaseId],
        activatedToolNames: ["get_runtime_capabilities"],
        estimatedToolSchemaTokens: 1,
        selectedCount: 1,
        unselectedCount: 31,
        selectedToolNames: ["get_runtime_capabilities"],
        reasonCounts: { selection_lease: 1 },
      });
    }
    expect((await directRuntime.loadActiveToolSelectionLeases(direct.sessionId, turnId)).toolNames).toEqual([]);

    const providerRoot = await fs.mkdtemp(path.join(os.tmpdir(), "deep-mix-phase15-search-provider-"));
    temporaryRoots.push(providerRoot);
    const client = new ScriptedModelClient([
      (request) => {
        expect(request.tools.map((tool) => tool.function.name)).not.toContain("get_runtime_capabilities");
        return {
          content: "",
          toolCalls: [toolCall("search-call", "tool_search", {
            query: "get_runtime_capabilities",
            mode: "activate",
            maxResults: 1,
            maxActivations: 1,
          })],
        };
      },
      (request) => {
        expect(request.tools.map((tool) => tool.function.name)).toContain("get_runtime_capabilities");
        return {
          content: "",
          toolCalls: [toolCall("capability-call", "get_runtime_capabilities", { maxResults: 1 })],
        };
      },
      { content: "Discovery and later-cycle execution completed.", toolCalls: [] },
    ]);
    const governor = new GovernorRuntime({
      workspaceRoot: providerRoot,
      permissionMode: "danger-full-access",
      modelClient: client,
    });
    disposables.push(governor);
    const result = await governor.runTurn({ prompt: "Opaque task zqxv-15; use the discovery catalog first." });
    const verificationStore = new SessionStore(providerRoot);
    const auditNames = (await verificationStore.loadEvents(result.sessionId))
      .filter((event): event is ToolExecutionAuditRecord => event.recordType === "tool_execution_audit")
      .map((event) => event.toolName);
    expect(auditNames).toEqual(expect.arrayContaining(["tool_search", "get_runtime_capabilities"]));
    expect(auditNames.indexOf("tool_search")).toBeLessThan(auditNames.indexOf("get_runtime_capabilities"));
  }, 30_000);

  it("keeps tool_search behind availability, workflow, permission, and plan-mode boundaries", async () => {
    let highRiskExecutions = 0;
    const fixtureModule: ToolModule = {
      manifest: {
        id: "test.phase15.boundaries",
        version: "1.0.0",
        description: "Phase 15 tool-search boundary fixtures.",
        source: "built_in",
      },
      create: () => [
        fixtureTool("phase15_workflow_only", { workflowOnly: true }),
        fixtureTool("phase15_unavailable"),
        fixtureTool("phase15_high_risk", { readOnly: false, onExecute: () => { highRiskExecutions += 1; } }),
      ],
    };

    const planFixture = await createWorkspace("deep-mix-phase15-search-plan-");
    const planRegistry = new ToolRegistry<RuntimeToolSpec>();
    const planRuntime = createRuntime({
      ...planFixture,
      permissionMode: "plan",
      registry: planRegistry,
      modules: [...builtInToolModules, fixtureModule],
    });
    planRegistry.setToolAvailability("phase15_unavailable", {
      status: "unavailable",
      available: false,
      reason: "fixture unavailable",
    });
    await startPendingTurn(planFixture.sessionStore, planFixture.sessionId);

    const workflow = await planRuntime.executeManualTool(
      "tool_search",
      { query: "phase15_workflow_only", mode: "activate" },
      planFixture.sessionId,
    );
    const unavailable = await planRuntime.executeManualTool(
      "tool_search",
      { query: "phase15_unavailable", mode: "activate" },
      planFixture.sessionId,
    );
    const planDenied = await planRuntime.executeManualTool(
      "tool_search",
      { query: "phase15_high_risk", mode: "activate" },
      planFixture.sessionId,
    );
    expect((workflow.structuredContent as { activation: ToolActivationRecord }).activation.rejectedTools)
      .toContainEqual(expect.objectContaining({ name: "phase15_workflow_only", reason: "workflow_only" }));
    expect((unavailable.structuredContent as { activation: ToolActivationRecord }).activation.rejectedTools)
      .toContainEqual(expect.objectContaining({ name: "phase15_unavailable", reason: "unavailable" }));
    expect((planDenied.structuredContent as { activation: ToolActivationRecord }).activation.rejectedTools)
      .toContainEqual(expect.objectContaining({ name: "phase15_high_risk", reason: "mode_denied" }));

    const approvalFixture = await createWorkspace("deep-mix-phase15-search-approval-");
    const approvalRuntime = createRuntime({
      ...approvalFixture,
      permissionMode: "auto",
      modules: [...builtInToolModules, fixtureModule],
    });
    await startPendingTurn(approvalFixture.sessionStore, approvalFixture.sessionId);
    const activated = await approvalRuntime.executeManualTool(
      "tool_search",
      { query: "phase15_high_risk", mode: "activate", maxActivations: 1 },
      approvalFixture.sessionId,
    );
    expect((activated.structuredContent as { activation: ToolActivationRecord }).activation.activatedToolNames)
      .toEqual(["phase15_high_risk"]);
    await expect(approvalRuntime.executeManualTool("phase15_high_risk", {}, approvalFixture.sessionId))
      .rejects.toBeInstanceOf(PermissionRequiredError);
    expect(highRiskExecutions).toBe(0);
  });

  it("answers, cancels, deduplicates, and restart-recovers structured user input with legal history", async () => {
    const workspaceRoot = await fs.mkdtemp(path.join(os.tmpdir(), "deep-mix-phase15-input-answer-"));
    temporaryRoots.push(workspaceRoot);
    const askingClient = new ScriptedModelClient([{
      content: "",
      toolCalls: [
        toolCall("ask-choice", "request_user_input", {
          title: "Choose mode",
          questions: [{
            id: "mode",
            prompt: "Which mode should continue?",
            kind: "single_select",
            options: [
              { id: "safe", label: "Safe" },
              { id: "fast", label: "Fast" },
            ],
          }],
        }),
        toolCall("after-wait", "tool_search", { query: "runtime capabilities" }),
      ],
    }]);
    const askingRuntime = new GovernorRuntime({
      workspaceRoot,
      permissionMode: "danger-full-access",
      modelClient: askingClient,
    });
    disposables.push(askingRuntime);
    const waiting = await askingRuntime.runTurn({ prompt: "Ask me for a mode before continuing." });
    expect(waiting.session.status).toBe("waiting_for_user");
    expect(waiting.pendingUserInput?.questions[0]?.id).toBe("mode");

    const restartClient = new ScriptedModelClient([{
      content: "Resumed the original turn with the explicit answer.",
      toolCalls: [],
    }]);
    const restartedRuntime = new GovernorRuntime({
      workspaceRoot,
      permissionMode: "danger-full-access",
      modelClient: restartClient,
    });
    disposables.push(restartedRuntime);
    const resumed = await restartedRuntime.respondToUserInput({
      sessionId: waiting.sessionId,
      requestId: waiting.pendingUserInput!.requestId,
      answers: [{ questionId: "mode", value: "safe", source: "selected_option" }],
    });
    expect(resumed.finalResponse).toContain("Resumed the original turn");
    const answerStore = new SessionStore(workspaceRoot);
    const answerState = await answerStore.loadUserInputRequestState(
      waiting.sessionId,
      waiting.pendingUserInput!.requestId,
    );
    expect(answerState?.status).toBe("resumed");
    expect(answerState?.response).toMatchObject({ status: "answered", answers: [{ value: "safe" }] });
    const answerMessages = await answerStore.loadMessages(waiting.sessionId);
    expect(validateMessageHistory(answerMessages).valid).toBe(true);
    expect(answerMessages.filter((message) => message.role === "tool").map((message) => message.toolCallId))
      .toEqual(expect.arrayContaining(["ask-choice", "after-wait"]));
    await expect(restartedRuntime.respondToUserInput({
      sessionId: waiting.sessionId,
      requestId: waiting.pendingUserInput!.requestId,
      answers: [{ questionId: "mode", value: "fast", source: "selected_option" }],
    })).rejects.toThrow(/already|resumed/iu);

    const cancelRoot = await fs.mkdtemp(path.join(os.tmpdir(), "deep-mix-phase15-input-cancel-"));
    temporaryRoots.push(cancelRoot);
    const cancelRuntime = new GovernorRuntime({
      workspaceRoot: cancelRoot,
      permissionMode: "danger-full-access",
      modelClient: new ScriptedModelClient([{
        content: "",
        toolCalls: [toolCall("ask-cancel", "request_user_input", {
          questions: [{ id: "confirm", prompt: "Continue?", kind: "confirm" }],
        })],
      }]),
    });
    disposables.push(cancelRuntime);
    const cancelWaiting = await cancelRuntime.runTurn({ prompt: "Ask before cancelling." });
    const cancelled = await cancelRuntime.respondToUserInput({
      sessionId: cancelWaiting.sessionId,
      requestId: cancelWaiting.pendingUserInput!.requestId,
      cancel: true,
      cancelReason: "User stopped the task.",
    });
    expect(cancelled.session.status).toBe("interrupted");
    const cancelState = await new SessionStore(cancelRoot).loadUserInputRequestState(
      cancelWaiting.sessionId,
      cancelWaiting.pendingUserInput!.requestId,
    );
    expect(cancelState?.status).toBe("cancelled");
    expect(cancelState?.response).toMatchObject({ status: "cancelled", cancelReason: "User stopped the task." });
  }, 30_000);

  it("keeps glob_files rg and Node traversal equivalent across ignore and truncation boundaries", async () => {
    const fixture = await createWorkspace("deep-mix-phase15-glob-");
    await fs.mkdir(path.join(fixture.workspaceRoot, "nested"), { recursive: true });
    await fs.writeFile(path.join(fixture.workspaceRoot, ".gitignore"), "ignored.txt\nnested/drop.txt\n", "utf8");
    await fs.writeFile(path.join(fixture.workspaceRoot, "alpha.txt"), "alpha", "utf8");
    await fs.writeFile(path.join(fixture.workspaceRoot, "zeta.txt"), "zeta", "utf8");
    await fs.writeFile(path.join(fixture.workspaceRoot, "ignored.txt"), "ignored", "utf8");
    await fs.writeFile(path.join(fixture.workspaceRoot, "nested", "beta.txt"), "beta", "utf8");
    await fs.writeFile(path.join(fixture.workspaceRoot, "nested", "drop.txt"), "drop", "utf8");

    const rgRuntime = createRuntime(fixture);
    injectCapabilitySnapshot(rgRuntime, capabilitySnapshot(true));
    const nodeRuntime = createRuntime(fixture);
    injectCapabilitySnapshot(nodeRuntime, capabilitySnapshot(false));
    const args = { globs: ["**/*.txt"], maxDepth: 4, maxResults: 20 };
    const rgResult = await rgRuntime.executeManualTool("glob_files", args, fixture.sessionId);
    const nodeResult = await nodeRuntime.executeManualTool("glob_files", args, fixture.sessionId);
    const rgBody = rgResult.structuredContent as {
      files: string[];
      strategy: string;
      fallbackUsed?: boolean;
      attempts?: Array<{ strategy?: string; reason?: string }>;
    };
    const nodeBody = nodeResult.structuredContent as { files: string[]; strategy: string };
    expect(["rg", "node_fs"]).toContain(rgBody.strategy);
    if (rgBody.strategy === "node_fs") {
      // A stale positive capability snapshot must degrade safely when the
      // executable is absent on the current machine.
      expect(rgBody.fallbackUsed).toBe(true);
      expect(rgBody.attempts).toContainEqual(expect.objectContaining({ strategy: "rg", reason: "spawn_failed" }));
    }
    expect(nodeBody.strategy).toBe("node_fs");
    expect(rgBody.files).toEqual(["alpha.txt", "nested/beta.txt", "zeta.txt"]);
    expect(nodeBody.files).toEqual(rgBody.files);

    const basenameArgs = { globs: ["beta.txt"], maxDepth: 4, maxResults: 20 };
    const rgBasename = await rgRuntime.executeManualTool("glob_files", basenameArgs, fixture.sessionId);
    const nodeBasename = await nodeRuntime.executeManualTool("glob_files", basenameArgs, fixture.sessionId);
    expect((rgBasename.structuredContent as { files: string[] }).files).toEqual(["nested/beta.txt"]);
    expect((nodeBasename.structuredContent as { files: string[] }).files).toEqual(["nested/beta.txt"]);
    expect(rgBasename.output).toContain("[glob_files complete:");
    expect(nodeBasename.output).toContain("[glob_files complete:");

    const truncated = await nodeRuntime.executeManualTool(
      "glob_files",
      { ...args, maxResults: 1 },
      fixture.sessionId,
    );
    expect(truncated.structuredContent).toMatchObject({
      truncated: true,
      resultComplete: false,
      selectedCount: 1,
      truncation: { truncated: true, maxResults: 1 },
    });
    expect(truncated.output).toContain("[glob_files truncated:");
    expect(truncated.output).toContain("Do not infer absence");
  });

  it("shows partial batch reads raw once, then records a stable summary while artifact-backing explicit overflow", async () => {
    const direct = await createWorkspace("deep-mix-phase15-read-many-");
    await fs.writeFile(path.join(direct.workspaceRoot, ".gitignore"), "ignored.txt\n", "utf8");
    await fs.writeFile(path.join(direct.workspaceRoot, "large.txt"), `LARGE:${"A".repeat(13_500)}`, "utf8");
    await fs.writeFile(path.join(direct.workspaceRoot, "small.txt"), "small content", "utf8");
    await fs.writeFile(path.join(direct.workspaceRoot, "binary.bin"), Buffer.from([0, 1, 2, 3]));
    await fs.writeFile(path.join(direct.workspaceRoot, "ignored.txt"), "ignored", "utf8");
    const directRuntime = createRuntime(direct);
    injectCapabilitySnapshot(directRuntime, capabilitySnapshot(false));
    const result = await directRuntime.executeManualTool(
      "read_many_files",
      {
        paths: ["large.txt", "small.txt", "binary.bin", "ignored.txt", "missing.txt"],
        maxFiles: 10,
        maxCharsPerFile: 14_000,
        maxTotalChars: 20_000,
      },
      direct.sessionId,
    );
    const body = result.structuredContent as {
      files: Array<{ path: string; status: string; success: boolean }>;
      summary: { succeeded: number; failed: number };
      artifactFriendly: { outputArtifactUri?: string };
    };
    expect(body.summary.succeeded).toBe(2);
    expect(body.summary.failed).toBe(3);
    expect(body.files).toEqual(expect.arrayContaining([
      expect.objectContaining({ path: "large.txt", status: "ok", success: true }),
      expect.objectContaining({ path: "binary.bin", status: "binary", success: false }),
      expect.objectContaining({ path: "ignored.txt", status: "ignored", success: false }),
      expect.objectContaining({ path: "missing.txt", status: "error", success: false }),
    ]));
    expect("contextSummary" in result).toBe(false);
    expect(result.artifacts?.[0]?.uri).toMatch(/^artifact:\/\/tool-outputs\//u);
    expect(body.artifactFriendly.outputArtifactUri).toBe(result.artifacts?.[0]?.uri);
    const artifactText = await direct.sessionStore.readTextToolOutputArtifact(result.artifacts![0]!.uri);
    expect(artifactText).toContain("LARGE:");
    expect(artifactText).not.toContain(direct.workspaceRoot);

    const defaultLargeContent = `DEFAULT_LARGE:${"D".repeat(80_000)}:DEFAULT_TAIL_SENTINEL`;
    await fs.writeFile(
      path.join(direct.workspaceRoot, "default-large.txt"),
      defaultLargeContent,
      "utf8",
    );
    const defaultLarge = await directRuntime.executeManualTool(
      "read_many_files",
      { paths: ["default-large.txt"] },
      direct.sessionId,
    );
    expect(defaultLarge.output).toContain("DEFAULT_TAIL_SENTINEL");
    expect(defaultLarge.structuredContent).toMatchObject({
      summary: {
        totalCharsRead: defaultLargeContent.length,
        maxCharsPerFile: 2_000_000,
        maxTotalChars: 2_000_000,
      },
      files: [expect.objectContaining({ path: "default-large.txt", truncated: false })],
    });

    const governorRoot = await fs.mkdtemp(path.join(os.tmpdir(), "deep-mix-phase15-read-many-governor-"));
    temporaryRoots.push(governorRoot);
    await fs.writeFile(path.join(governorRoot, "large.ts"), `export const large = "${"Z".repeat(14_000)}";\n`, "utf8");
    const client = new ScriptedModelClient([
      {
        content: "",
        toolCalls: [toolCall("read-many-call", "read_many_files", {
          paths: ["large.ts"],
          maxCharsPerFile: 15_000,
          maxTotalChars: 15_000,
        })],
      },
      (request) => {
        expectConversationHistoryLegal(request.messages);
        const toolMessage = request.messages.find((message) => message.role === "tool");
        expect(toolMessage?.content).not.toContain("[summary source=");
        expect(toolMessage?.content).toContain("Z".repeat(500));
        return { content: "Batch raw output remained authoritative.", toolCalls: [] };
      },
    ]);
    const governor = new GovernorRuntime({
      workspaceRoot: governorRoot,
      permissionMode: "danger-full-access",
      modelClient: client,
    });
    disposables.push(governor);
    const turn = await governor.runTurn({ prompt: "Batch read many files from large.ts." });
    const events = await new SessionStore(governorRoot).loadEvents(turn.sessionId);
    const summary = events.find(
      (event): event is ContextSummaryRecord =>
        event.recordType === "context_summary" && event.sourceToolName === "read_many_files",
    );
    expect(summary).toMatchObject({
      sourceToolName: "read_many_files",
      toolOutputLifecycle: "raw_once_then_summary_v1",
      rawOutputRef: expect.stringMatching(/^message:\/\//u),
    });
    expect(validateMessageHistory(await new SessionStore(governorRoot).loadMessages(turn.sessionId)).valid).toBe(true);
  }, 30_000);

  it("returns redacted stale runtime capabilities without probing or rewriting the cached snapshot", async () => {
    const fixture = await createWorkspace("deep-mix-phase15-capabilities-");
    const snapshot = {
      checkedAt: "2020-01-01T00:00:00.000Z",
      capabilities: {
        rg: {
          name: "rg",
          available: true,
          command: "C:\\secret\\rg.exe",
          version: "super-secret-version",
          message: "api_key=super-secret-key",
        },
      },
      fallbacks: { listFiles: "rg", searchFiles: "node_text" },
    } as RuntimeCapabilitySnapshot;
    await fixture.sessionStore.saveRuntimeCapabilities(snapshot);
    const snapshotPath = fixture.sessionStore.paths.runtimeCapabilitiesPath;
    const before = await fs.readFile(snapshotPath, "utf8");
    const runtime = createRuntime(fixture);
    const result = await runtime.executeManualTool(
      "get_runtime_capabilities",
      { names: ["rg", "unknown-secret-name"], maxResults: 2 },
      fixture.sessionId,
    );
    expect(result.structuredContent).toMatchObject({
      source: "runtime-capabilities.json",
      stale: true,
      staleReason: "age_exceeded",
      probePerformed: false,
      unknownNameCount: 1,
      capabilities: [{ name: "rg", available: true, status: "available" }],
      fallbacks: { listFiles: "rg", searchFiles: "node_text" },
    });
    expect(result.output).not.toMatch(/secret|api_key|C:\\/iu);
    expect(await fs.readFile(snapshotPath, "utf8")).toBe(before);
  });

  it("bounds file_metadata and checkpoints every manage_path action with undo, guards, budgets, and failure envelopes", async () => {
    const fixture = await createWorkspace("deep-mix-phase15-paths-");
    const runtime = createRuntime(fixture);
    await fs.writeFile(path.join(fixture.workspaceRoot, "large.txt"), "M".repeat(20_000), "utf8");
    const metadata = await runtime.executeManualTool(
      "file_metadata",
      { path: "large.txt", includeHash: true, hashMaxBytes: 100 },
      fixture.sessionId,
    );
    expect(metadata.structuredContent).toMatchObject({
      path: "large.txt",
      type: "file",
      sizeBytes: 20_000,
      sample: { bytesRead: 4_096, maxBytes: 4_096, contentReturned: false },
      hash: { requested: true, computed: false, reason: "size_limit", maxBytes: 100 },
    });
    expect(metadata.output).not.toContain("M".repeat(100));
    expect(metadata.output).not.toContain(fixture.workspaceRoot);

    const undo = async () => runtime.executeManualTool("undo", { mode: "code" }, fixture.sessionId);

    const mkdir = await runtime.executeManualTool(
      "manage_path",
      {
        action: "mkdir",
        path: "created/nested",
        recursive: true,
        maxEntries: 4,
        maxTotalBytes: 0,
      },
      fixture.sessionId,
    );
    expect(mkdir.success).toBe(true);
    expect(await fs.stat(path.join(fixture.workspaceRoot, "created", "nested"))).toBeDefined();
    expect((await undo()).success).toBe(true);
    await expect(fs.stat(path.join(fixture.workspaceRoot, "created"))).rejects.toMatchObject({ code: "ENOENT" });

    await fs.writeFile(path.join(fixture.workspaceRoot, "copy-source.txt"), "copy", "utf8");
    const copy = await runtime.executeManualTool(
      "manage_path",
      { action: "copy", source: "copy-source.txt", destination: "copy-target.txt" },
      fixture.sessionId,
    );
    expect(copy.success).toBe(true);
    expect(await fs.readFile(path.join(fixture.workspaceRoot, "copy-target.txt"), "utf8")).toBe("copy");
    expect((await undo()).success).toBe(true);
    await expect(fs.stat(path.join(fixture.workspaceRoot, "copy-target.txt"))).rejects.toMatchObject({ code: "ENOENT" });

    await fs.writeFile(path.join(fixture.workspaceRoot, "move-source.txt"), "move", "utf8");
    expect((await runtime.executeManualTool(
      "manage_path",
      { action: "move", source: "move-source.txt", destination: "moved.txt" },
      fixture.sessionId,
    )).success).toBe(true);
    expect((await undo()).success).toBe(true);
    expect(await fs.readFile(path.join(fixture.workspaceRoot, "move-source.txt"), "utf8")).toBe("move");
    await expect(fs.stat(path.join(fixture.workspaceRoot, "moved.txt"))).rejects.toMatchObject({ code: "ENOENT" });

    await fs.mkdir(path.join(fixture.workspaceRoot, "rename-dir"), { recursive: true });
    await fs.writeFile(path.join(fixture.workspaceRoot, "rename-dir", "before.txt"), "rename", "utf8");
    expect((await runtime.executeManualTool(
      "manage_path",
      { action: "rename", source: "rename-dir/before.txt", destination: "rename-dir/after.txt" },
      fixture.sessionId,
    )).success).toBe(true);
    expect((await undo()).success).toBe(true);
    expect(await fs.readFile(path.join(fixture.workspaceRoot, "rename-dir", "before.txt"), "utf8")).toBe("rename");

    await fs.mkdir(path.join(fixture.workspaceRoot, "delete-tree", "empty"), { recursive: true });
    await fs.writeFile(path.join(fixture.workspaceRoot, "delete-tree", "data.txt"), "delete", "utf8");
    expect((await runtime.executeManualTool(
      "manage_path",
      {
        action: "delete",
        path: "delete-tree",
        recursive: true,
        maxEntries: 20,
        maxTotalBytes: 10_000,
      },
      fixture.sessionId,
    )).success).toBe(true);
    expect((await undo()).success).toBe(true);
    expect(await fs.readFile(path.join(fixture.workspaceRoot, "delete-tree", "data.txt"), "utf8")).toBe("delete");
    expect((await fs.stat(path.join(fixture.workspaceRoot, "delete-tree", "empty"))).isDirectory()).toBe(true);

    const escaped = await runtime.executeManualTool(
      "manage_path",
      { action: "delete", path: "../escape" },
      fixture.sessionId,
    );
    expect(escaped.success).toBe(false);
    expect(escaped.structuredContent).toMatchObject({
      kind: "manage_path",
      action: "delete",
      stage: "resolve_access",
      completed: [],
      uncompleted: [expect.objectContaining({ step: "preflight", action: "delete" })],
      automaticRestore: "not_required",
    });

    const protectedResult = await runtime.executeManualTool(
      "manage_path",
      { action: "mkdir", path: ".deep-mix/blocked", recursive: true },
      fixture.sessionId,
    );
    expect(protectedResult.structuredContent).toMatchObject({
      kind: "manage_path",
      completed: [],
      automaticRestore: "not_required",
    });

    await fs.mkdir(path.join(fixture.workspaceRoot, "budget-source"), { recursive: true });
    await fs.writeFile(path.join(fixture.workspaceRoot, "budget-source", "a.txt"), "a", "utf8");
    await fs.writeFile(path.join(fixture.workspaceRoot, "budget-source", "b.txt"), "b", "utf8");
    const budgetFailure = await runtime.executeManualTool(
      "manage_path",
      {
        action: "copy",
        source: "budget-source",
        destination: "budget-target",
        recursive: true,
        maxEntries: 1,
        maxTotalBytes: 100,
      },
      fixture.sessionId,
    );
    expect(budgetFailure.success).toBe(false);
    expect(budgetFailure.structuredContent).toMatchObject({ completed: [], automaticRestore: "not_required" });
    await expect(fs.stat(path.join(fixture.workspaceRoot, "budget-target"))).rejects.toMatchObject({ code: "ENOENT" });

    await fs.writeFile(path.join(fixture.workspaceRoot, "existing.txt"), "existing", "utf8");
    const noOverwrite = await runtime.executeManualTool(
      "manage_path",
      { action: "copy", source: "copy-source.txt", destination: "existing.txt" },
      fixture.sessionId,
    );
    expect(noOverwrite.success).toBe(false);
    expect(noOverwrite.structuredContent).toMatchObject({ completed: [], uncompleted: [expect.any(Object)] });
    expect(await fs.readFile(path.join(fixture.workspaceRoot, "existing.txt"), "utf8")).toBe("existing");
  }, 30_000);
});
