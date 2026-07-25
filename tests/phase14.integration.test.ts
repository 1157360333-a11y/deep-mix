import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import { GovernorRuntime, PermissionRequiredError, validateMessageHistory } from "../packages/core-governor/src/index.js";
import { McpRegistry } from "../packages/mcp-hub/src/index.js";
import { SessionStore } from "../packages/persistence/src/index.js";
import type {
  AssistantResponse,
  ConversationMessage,
  ContextBudgetRecord,
  ContextSummaryRecord,
  ModelCompletionRequest,
  ModelClient,
  StreamCallbacks,
  ToolExecutionAuditRecord,
  ToolSelectionRecord,
} from "../packages/shared-schema/src/index.js";
import {
  ToolRegistry,
  ToolRegistryError,
  ToolRuntime,
  type RuntimeToolSpec,
  type ToolModule,
} from "../packages/tool-runtime/src/index.js";

const temporaryRoots: string[] = [];

function manifest(id: string) {
  return {
    id,
    version: "1.0.0",
    description: `Phase 14 fixture ${id}.`,
    source: "built_in" as const,
  };
}

function simpleTool(name: string, overrides: Partial<RuntimeToolSpec> = {}): RuntimeToolSpec {
  return {
    name,
    description: `Phase 14 fixture tool ${name}.`,
    inputSchema: { type: "object", additionalProperties: false, properties: {} },
    readOnly: true,
    permissionCategory: "read_only",
    sideEffectLevel: "none",
    timeoutCategory: "fast",
    selection: { alwaysAvailable: true },
    execute: async (_args, context) => {
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
    ...overrides,
  };
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
  const session = await sessionStore.createSession("phase 14 integration");
  return { workspaceRoot, sessionStore, sessionId: session.sessionId };
}

class ScriptedModelClient implements ModelClient {
  private index = 0;

  public requests: ModelCompletionRequest[] = [];

  public constructor(
    private readonly responses: Array<
      AssistantResponse | ((request: ModelCompletionRequest) => Promise<AssistantResponse>)
    >,
  ) {}

  public async streamCompletion(
    request: ModelCompletionRequest,
    callbacks?: StreamCallbacks,
  ): Promise<AssistantResponse> {
    this.requests.push(request);
    const response = this.responses[this.index++];
    if (!response) throw new Error(`Unexpected model call ${this.index - 1}.`);
    const resolved = typeof response === "function" ? await response(request) : response;
    for (const character of resolved.content) callbacks?.onTextDelta?.(character);
    return resolved;
  }
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

afterEach(async () => {
  await Promise.all(
    temporaryRoots.splice(0).map((root) => fs.rm(root, { recursive: true, force: true })),
  );
});

describe("phase 14 modular built-in tool architecture", () => {
  it("keeps Registry ordering stable and rejects duplicate modules/tools atomically", () => {
    const registry = new ToolRegistry<RuntimeToolSpec>();
    registry.registerModule(manifest("test.first"), [simpleTool("zeta_tool"), simpleTool("alpha_tool")]);
    expect(registry.listRegisteredTools().map((entry) => entry.tool.name)).toEqual(["zeta_tool", "alpha_tool"]);

    expect(() => registry.registerModule(manifest("test.first"), [])).toThrowError(ToolRegistryError);
    expect(() => registry.registerModule(manifest("test.second"), [
      simpleTool("new_tool"),
      simpleTool("alpha_tool"),
    ])).toThrowError(ToolRegistryError);
    expect(registry.getTool("new_tool")).toBeUndefined();
    expect(registry.listRegisteredTools().map((entry) => entry.tool.name)).toEqual(["zeta_tool", "alpha_tool"]);
    expect(registry.listExtensionErrors()).toEqual(expect.arrayContaining([
      expect.objectContaining({ code: "duplicate_module", moduleId: "test.first" }),
      expect.objectContaining({ code: "duplicate_tool", toolName: "alpha_tool" }),
    ]));
  });

  it("keeps workflow-only tools out of ordinary keyword selection", () => {
    const registry = new ToolRegistry<RuntimeToolSpec>();
    registry.registerModule(manifest("test.workflow-only"), [
      simpleTool("workflow_keyword_tool", {
        selection: { workflowOnly: true, keywords: ["workflow-secret-keyword"] },
      }),
    ]);

    expect(registry.selectToolsDetailed({ prompt: "workflow-secret-keyword" }).summary.selectedToolNames).toEqual([]);
    expect(registry.selectToolsDetailed({
      prompt: "workflow-secret-keyword",
      workflowToolNames: ["workflow_keyword_tool"],
    }).summary.selectedToolNames).toEqual(["workflow_keyword_tool"]);
  });

  it("isolates initialize failures and selects required/optional capabilities structurally", async () => {
    const { workspaceRoot, sessionStore } = await createWorkspace("deep-mix-phase14-capability-");
    const registry = new ToolRegistry<RuntimeToolSpec>();
    const goodModule: ToolModule = {
      manifest: manifest("test.good"),
      create: () => [
        simpleTool("good_tool"),
        simpleTool("dependency_unavailable_tool", {
          getAvailability: async () => ({
            status: "unavailable",
            available: false,
            reason: "fixture dependency is unavailable",
          }),
        }),
      ],
    };
    const brokenModule: ToolModule = {
      manifest: manifest("test.broken"),
      create: () => [simpleTool("broken_tool")],
      initialize: async () => {
        throw new Error("fixture initialization failure");
      },
    };
    const capabilityModule: ToolModule = {
      manifest: manifest("test.capabilities"),
      capabilityProbes: [{
        name: "phase14_missing_binary",
        candidates: ["deep-mix-phase14-command-that-does-not-exist"],
        args: ["--version"],
        timeoutMs: 100,
        platforms: [process.platform],
      }],
      create: () => [
        simpleTool("requires_missing_capability", {
          capabilityRequirements: [{ name: "phase14_missing_binary", required: true }],
        }),
        simpleTool("uses_capability_fallback", {
          capabilityRequirements: [{
            name: "phase14_missing_binary",
            required: false,
            fallback: "node_fixture",
          }],
        }),
      ],
    };
    const runtime = new ToolRuntime({
      workspaceRoot,
      sessionStore,
      permissionMode: "danger-full-access",
      registry,
      modules: [goodModule, brokenModule, capabilityModule],
    });

    await runtime.initialize();

    expect(registry.getTool("broken_tool")?.availability).toMatchObject({ available: false, status: "unavailable" });
    expect(registry.getTool("dependency_unavailable_tool")?.availability).toMatchObject({
      available: false,
      status: "unavailable",
      reason: "fixture dependency is unavailable",
    });
    expect(registry.getTool("requires_missing_capability")?.availability).toMatchObject({
      available: false,
      missingCapabilities: ["phase14_missing_binary"],
    });
    expect(registry.getTool("uses_capability_fallback")?.availability).toMatchObject({
      available: true,
      status: "degraded",
      fallbackCapabilities: ["node_fixture"],
    });
    expect(runtime.listAvailableToolDefinitions().map((tool) => tool.name)).toEqual([
      "good_tool",
      "uses_capability_fallback",
    ]);
    expect(registry.listExtensionErrors()).toContainEqual(expect.objectContaining({
      code: "module_initialization_failed",
      moduleId: "test.broken",
    }));
  });

  it("validates arguments before execution while manual calls resolve the full Registry", async () => {
    const { workspaceRoot, sessionStore, sessionId } = await createWorkspace("deep-mix-phase14-validation-");
    let executions = 0;
    const hiddenTool = simpleTool("workflow_hidden_tool", {
      inputSchema: {
        type: "object",
        additionalProperties: false,
        required: ["mode", "count"],
        properties: {
          mode: { type: "string", enum: ["safe"] },
          count: { type: "integer", minimum: 1, maximum: 3 },
        },
      },
      selection: { workflowOnly: true },
      execute: async (_args, context) => {
        executions += 1;
        const timestamp = context.moduleContext.clock.now();
        return {
          toolName: "workflow_hidden_tool",
          callId: context.callId,
          startedAt: timestamp,
          endedAt: timestamp,
          success: true,
          output: "manual full-registry execution",
        };
      },
    });
    const module: ToolModule = {
      manifest: manifest("test.hidden"),
      create: () => [hiddenTool],
    };
    const runtime = new ToolRuntime({
      workspaceRoot,
      sessionStore,
      permissionMode: "danger-full-access",
      modules: [module],
    });

    expect(runtime.selectToolsForTurn({ prompt: "ordinary task" }).definitions).toHaveLength(0);
    const invalid = await runtime.executeManualTool(
      "workflow_hidden_tool",
      { mode: "secret-invalid-value", count: 0, extra: true },
      sessionId,
    );
    expect(invalid.success).toBe(false);
    expect(invalid.structuredContent).toMatchObject({
      error: { type: "invalid_arguments", retryable: false },
    });
    expect(invalid.output).not.toContain("secret-invalid-value");
    expect(executions).toBe(0);

    const valid = await runtime.executeManualTool(
      "workflow_hidden_tool",
      { mode: "safe", count: 1 },
      sessionId,
    );
    expect(valid).toMatchObject({ success: true, output: "manual full-registry execution" });
    expect(executions).toBe(1);
    const audits = (await sessionStore.loadEvents(sessionId)).filter(
      (event): event is ToolExecutionAuditRecord => event.recordType === "tool_execution_audit",
    );
    expect(audits).toEqual(expect.arrayContaining([
      expect.objectContaining({ toolName: "workflow_hidden_tool", success: false, errorType: "invalid_arguments" }),
      expect.objectContaining({ toolName: "workflow_hidden_tool", success: true }),
    ]));
  });

  it("persists sanitized collision-safe artifacts with binary/text separation", async () => {
    const { workspaceRoot, sessionStore, sessionId } = await createWorkspace("deep-mix-phase14-artifacts-");
    const first = await sessionStore.storeToolOutputArtifact({
      sessionId,
      toolCallId: "artifact-one",
      sourceToolName: "fixture_writer",
      fileName: "../report.pdf",
      mimeType: "application/pdf",
      kind: "document",
      summary: "first binary",
      content: Buffer.from([0, 1, 2, 255]),
    });
    const second = await sessionStore.storeToolOutputArtifact({
      sessionId,
      toolCallId: "artifact-two",
      sourceToolName: "fixture_writer",
      fileName: "report.pdf",
      mimeType: "application/pdf",
      kind: "document",
      summary: "second binary",
      content: Buffer.from([3, 4, 5]),
    });
    expect([first.fileName, second.fileName]).toEqual(["report.pdf", "report-2.pdf"]);
    expect(await sessionStore.readBinaryToolOutputArtifact(first.uri)).toEqual(Buffer.from([0, 1, 2, 255]));
    await expect(sessionStore.readArtifactRef(first.uri)).rejects.toThrow(/binary/i);
    expect(() => sessionStore.resolveToolOutputArtifactPath("artifact://tool-outputs/../../escape.pdf")).toThrow();

  });

  it("keeps MCP descriptors in the full Registry and injects Provider tools on demand", async () => {
    const { workspaceRoot, sessionStore, sessionId } = await createWorkspace("deep-mix-phase14-mcp-");
    await fs.mkdir(path.join(workspaceRoot, ".deep-mix", "mcp"), { recursive: true });
    await fs.writeFile(
      path.join(workspaceRoot, ".deep-mix", "mcp", "servers.json"),
      JSON.stringify({
        version: 1,
        servers: [{
          name: "github",
          type: "github",
          enabled: true,
          toolSelection: { keywords: ["github", "repository", "pull request"] },
          options: { apiBaseUrl: "https://example.invalid", userAgent: "Deep-Mix-Phase14-Test" },
        }],
      }),
      "utf8",
    );
    const mcpRegistry = new McpRegistry(workspaceRoot);
    await mcpRegistry.initialize();
    const runtime = new ToolRuntime({
      workspaceRoot,
      sessionStore,
      permissionMode: "danger-full-access",
      mcpRegistry,
    });
    const mcpNames = runtime.listRegisteredToolDefinitions()
      .map((tool) => tool.name)
      .filter((name) => name.startsWith("mcp_github_"));
    expect(mcpNames.length).toBeGreaterThan(0);

    const catalogResult = await runtime.executeManualTool("list_tools", {}, sessionId);
    const catalog = catalogResult.structuredContent as {
      totalRegistered: number;
      tools: Array<{ name: string; moduleSource: string }>;
    };
    expect(catalog.totalRegistered).toBe(runtime.listRegisteredToolDefinitions().length);
    expect(catalog.tools).toEqual(expect.arrayContaining(
      mcpNames.map((name) => expect.objectContaining({ name, moduleSource: "mcp" })),
    ));

    const ordinary = runtime.selectToolsForTurn({ prompt: "Inspect local TypeScript files." });
    expect(ordinary.definitions.some((tool) => tool.name.startsWith("mcp_github_"))).toBe(false);
    const matched = runtime.selectToolsForTurn({ prompt: "Search this GitHub repository." });
    expect(matched.definitions.some((tool) => tool.name === "mcp_github_search_repositories")).toBe(true);
    expect(matched.providerTools.map((tool) => tool.function.name)).toEqual(
      matched.definitions.map((tool) => tool.name),
    );
  });

  it("rejects a model tool call that was not selected for the current Provider turn", async () => {
    const { workspaceRoot } = await createWorkspace("deep-mix-phase14-provider-allowlist-");
    const forbiddenPath = path.join(workspaceRoot, "unselected-shell-ran.txt");
    const shellCall = (id: string): AssistantResponse => ({
      content: "",
      toolCalls: [{
        id,
        name: "run_shell",
        rawArguments: JSON.stringify({
          command: `node -e \"require('node:fs').writeFileSync(${JSON.stringify(forbiddenPath)}, 'ran')\"`,
        }),
        arguments: {
          command: `node -e \"require('node:fs').writeFileSync(${JSON.stringify(forbiddenPath)}, 'ran')\"`,
        },
      }],
    });
    const client = new ScriptedModelClient([
      async (request) => {
        expect(request.tools.map((tool) => tool.function.name)).not.toContain("run_shell");
        return shellCall("phase14-unselected-shell-1");
      },
      async (request) => {
        expectConversationHistoryLegal(request.messages);
        const rejectedToolBody = JSON.parse(
          request.messages.find((message) => message.role === "tool")?.content ?? "{}",
        ) as { kind?: string; error?: { type?: string; retryable?: boolean; toolName?: string } };
        expect(rejectedToolBody).toMatchObject({
          kind: "tool_error",
          error: { type: "tool_not_selected", retryable: true, toolName: "run_shell" },
        });
        expect(request.tools.map((tool) => tool.function.name)).not.toContain("run_shell");
        return shellCall("phase14-unselected-shell-2");
      },
      async (request) => {
        expectConversationHistoryLegal(request.messages);
        expect(request.tools.map((tool) => tool.function.name)).not.toContain("run_shell");
        return { content: "Rejected the unselected tool call safely.", toolCalls: [] };
      },
    ]);
    const runtime = new GovernorRuntime({
      workspaceRoot,
      permissionMode: "danger-full-access",
      modelClient: client,
    });

    const result = await runtime.runTurn({ prompt: "Inspect the local TypeScript source files." });
    await expect(fs.stat(forbiddenPath)).rejects.toMatchObject({ code: "ENOENT" });
    expect(result.session.status).toBe("waiting_for_user");
    const events = await new SessionStore(workspaceRoot).loadEvents(result.sessionId);
    expect(events).toContainEqual(expect.objectContaining({
      recordType: "tool_execution_audit",
      toolName: "run_shell",
      success: false,
      errorType: "tool_not_selected",
    } satisfies Partial<ToolExecutionAuditRecord>));
  });

  it("does not let file-list output inject document tools into an unrelated turn", async () => {
    const { workspaceRoot } = await createWorkspace("deep-mix-phase14-selection-isolation-");
    await fs.writeFile(path.join(workspaceRoot, "reference.pdf"), "not a real PDF", "utf8");
    const client = new ScriptedModelClient([
      async (request) => {
        expect(request.tools.map((tool) => tool.function.name)).not.toContain("read_pdf");
        return {
          content: "",
          toolCalls: [{
            id: "phase14-list-with-pdf",
            name: "list_files",
            rawArguments: JSON.stringify({ cwd: ".", maxResults: 20 }),
            arguments: { cwd: ".", maxResults: 20 },
          }],
        };
      },
      async (request) => {
        expectConversationHistoryLegal(request.messages);
        expect(request.messages.find((message) => message.role === "tool")?.content).toContain("reference.pdf");
        expect(request.tools.map((tool) => tool.function.name)).not.toContain("read_pdf");
        return { content: "The unrelated code inspection is complete.", toolCalls: [] };
      },
    ]);
    const runtime = new GovernorRuntime({
      workspaceRoot,
      permissionMode: "danger-full-access",
      modelClient: client,
    });

    const result = await runtime.runTurn({ prompt: "Inspect the local TypeScript source layout." });
    expect(result.finalResponse).toBe("The unrelated code inspection is complete.");
  });

  it("keeps 12 tool iterations per cycle and automatically continues into the next cycle", async () => {
    const { workspaceRoot } = await createWorkspace("deep-mix-phase14-tool-cycles-");
    await fs.writeFile(
      path.join(workspaceRoot, "cycle-large.ts"),
      `export const CYCLE_RAW_SENTINEL = "${"C".repeat(24_000)}";\n`,
      "utf8",
    );
    const responses: AssistantResponse[] = Array.from({ length: 12 }, (_, index) => ({
      content: "",
      toolCalls: [{
        id: `phase14-cycle-list-${index + 1}`,
        name: "list_files",
        rawArguments: JSON.stringify({ cwd: ".", maxResults: index + 1 }),
        arguments: { cwd: ".", maxResults: index + 1 },
      }],
    }));
    responses[11] = {
      content: "",
      toolCalls: [{
        id: "phase14-cycle-read-large",
        name: "read_file",
        rawArguments: JSON.stringify({ path: "cycle-large.ts" }),
        arguments: { path: "cycle-large.ts" },
      }],
    };
    responses.push({
      content: `Completed the first tool batch; more work remains. ${"[[DEEP_MIX_CONTINUE]]"}`,
      toolCalls: [],
    });
    responses.push({ content: "Continued automatically and completed the task.", toolCalls: [] });
    const client = new ScriptedModelClient(responses);
    const streamed: string[] = [];
    const runtime = new GovernorRuntime({
      workspaceRoot,
      permissionMode: "danger-full-access",
      modelClient: client,
    });

    const result = await runtime.runTurn({
      prompt: "Perform a long repository inspection and continue until it is complete.",
      callbacks: { onTextDelta: (chunk) => streamed.push(chunk) },
    });

    expect(result.session.status).toBe("waiting_for_user");
    expect(result.finalResponse).toBe("Continued automatically and completed the task.");
    expect(client.requests).toHaveLength(14);
    expect(new Set(client.requests.map((request) => request.systemPrompt)).size).toBe(1);
    expect(client.requests[12]?.tools).toEqual([]);
    expect(client.requests[12]?.messages.some((message) =>
      message.role === "system" && message.content?.includes("Tool Cycle Boundary"))).toBe(true);
    expect(client.requests[13]?.tools.length).toBeGreaterThan(0);
    const boundaryToolMessage = client.requests[12]?.messages.find(
      (message) => message.role === "tool" && message.tool_call_id === "phase14-cycle-read-large",
    );
    expect(boundaryToolMessage?.content).toContain("CYCLE_RAW_SENTINEL");
    expect(boundaryToolMessage?.content).not.toContain("[summary source=");
    const nextCycleToolMessage = client.requests[13]?.messages.find(
      (message) => message.role === "tool" && message.tool_call_id === "phase14-cycle-read-large",
    );
    expect(nextCycleToolMessage?.content).toContain("[summary source=read_file");
    expect(nextCycleToolMessage?.content).not.toContain("C".repeat(1_000));
    expect(streamed.join("")).not.toContain("Completed the first tool batch");
    const verificationStore = new SessionStore(workspaceRoot);
    const events = await verificationStore.loadEvents(result.sessionId);
    expect(events).toContainEqual(expect.objectContaining({
      recordType: "context_summary",
      sourceType: "tool_cycle_checkpoint",
      summary: "Completed the first tool batch; more work remains.",
    } satisfies Partial<ContextSummaryRecord>));
    expect(events.some((event) => event.recordType === "turn" && event.status === "failed")).toBe(false);
    expect(validateMessageHistory(await verificationStore.loadMessages(result.sessionId)).valid).toBe(true);
  }, 30_000);

  it("returns recoverable partial progress instead of failing at the global tool-cycle budget", async () => {
    const { workspaceRoot } = await createWorkspace("deep-mix-phase14-global-cycle-budget-");
    const responses: AssistantResponse[] = Array.from({ length: 12 }, (_, index) => ({
      content: "",
      toolCalls: [{
        id: `phase14-budget-list-${index + 1}`,
        name: "list_files",
        rawArguments: JSON.stringify({ cwd: ".", maxResults: index + 1 }),
        arguments: { cwd: ".", maxResults: index + 1 },
      }],
    }));
    responses.push({
      content: `Partial progress is preserved; more work remains. ${"[[DEEP_MIX_CONTINUE]]"}`,
      toolCalls: [],
    });
    const client = new ScriptedModelClient(responses);
    const runtime = new GovernorRuntime({
      workspaceRoot,
      permissionMode: "danger-full-access",
      modelClient: client,
      environment: { ...process.env, DEEP_MIX_MAX_TOOL_CYCLES: "1" },
    });

    const result = await runtime.runTurn({
      prompt: "Perform a bounded repository inspection and preserve partial progress.",
    });

    expect(result.session.status).toBe("waiting_for_user");
    expect(result.finalResponse).toBe("Partial progress is preserved; more work remains.");
    expect(client.requests).toHaveLength(13);
    expect(client.requests[12]?.tools).toEqual([]);
    expect(client.requests[12]?.messages.some((message) =>
      message.role === "system" && message.content?.includes("Tool Cycle Safety Boundary"))).toBe(true);
    const store = new SessionStore(workspaceRoot);
    const events = await store.loadEvents(result.sessionId);
    expect(events.some((event) => event.recordType === "turn" && event.status === "failed")).toBe(false);
    expect(validateMessageHistory(await store.loadMessages(result.sessionId)).valid).toBe(true);
  }, 30_000);

  it("preserves the cycle boundary across approval resume and rejects a concurrent resume", async () => {
    const { workspaceRoot } = await createWorkspace("deep-mix-phase14-approval-cycle-");
    const responses: AssistantResponse[] = Array.from({ length: 11 }, (_, index) => ({
      content: "",
      toolCalls: [{
        id: `phase14-approval-list-${index + 1}`,
        name: "list_files",
        rawArguments: JSON.stringify({ cwd: ".", maxResults: index + 1 }),
        arguments: { cwd: ".", maxResults: index + 1 },
      }],
    }));
    responses.push({
      content: "",
      toolCalls: [{
        id: "phase14-approval-shell",
        name: "run_shell",
        rawArguments: JSON.stringify({ command: "node -e \"console.log('approval-cycle')\"" }),
        arguments: { command: "node -e \"console.log('approval-cycle')\"" },
      }],
    });
    responses.push({
      content: `The approved first cycle is complete; continue. ${"[[DEEP_MIX_CONTINUE]]"}`,
      toolCalls: [],
    });
    responses.push({ content: "Approval resumed at the next cycle and completed.", toolCalls: [] });
    const client = new ScriptedModelClient(responses);
    const runtime = new GovernorRuntime({
      workspaceRoot,
      permissionMode: "auto",
      modelClient: client,
    });
    let sessionId = "";

    await expect(runtime.runTurn({
      prompt: "Inspect the repository for a long task, then run a shell command after approval.",
      callbacks: { onSessionSelected: (selected) => { sessionId = selected; } },
    })).rejects.toBeInstanceOf(PermissionRequiredError);
    const store = new SessionStore(workspaceRoot);
    const pendingApproval = [...await store.loadEvents(sessionId)].reverse().find(
      (event) => event.recordType === "approval" && event.status === "pending",
    );
    expect(pendingApproval).toMatchObject({ toolName: "run_shell" });
    if (!pendingApproval || pendingApproval.recordType !== "approval") throw new Error("Missing pending approval fixture.");
    await runtime.resolveApprovalRequest({
      sessionId,
      approvalId: pendingApproval.approvalId,
      toolName: pendingApproval.toolName,
      requestKey: pendingApproval.requestKey,
      persistence: "allow_once",
      reason: "Phase 14 approval-cycle regression.",
    });

    const continuation = runtime.continuePendingTurn({ sessionId });
    await expect(runtime.continuePendingTurn({ sessionId })).rejects.toThrow("already running");
    const result = await continuation;

    expect(result.finalResponse).toBe("Approval resumed at the next cycle and completed.");
    expect(client.requests).toHaveLength(14);
    expect(client.requests[12]?.tools).toEqual([]);
    expect(client.requests[12]?.messages.some((message) =>
      message.role === "system" && message.content?.includes("Tool Cycle Boundary"))).toBe(true);
    const events = await store.loadEvents(sessionId);
    expect(events.filter((event) =>
      event.recordType === "tool_execution_audit" && event.callId === "phase14-approval-shell" && event.success,
    )).toHaveLength(1);
    expect(events.some((event) => event.recordType === "turn" && event.status === "failed")).toBe(false);
    expect(validateMessageHistory(await store.loadMessages(sessionId)).valid).toBe(true);
  }, 30_000);

  it("preserves interrupted status when an active model request aborts", async () => {
    const { workspaceRoot } = await createWorkspace("deep-mix-phase14-interrupt-status-");
    let signalStarted!: () => void;
    const started = new Promise<void>((resolve) => { signalStarted = resolve; });
    const client = new ScriptedModelClient([
      async (request) => {
        signalStarted();
        return await new Promise<AssistantResponse>((_resolve, reject) => {
          const abort = () => reject(request.signal?.reason instanceof Error
            ? request.signal.reason
            : new Error("aborted"));
          if (request.signal?.aborted) abort();
          else request.signal?.addEventListener("abort", abort, { once: true });
        });
      },
    ]);
    const runtime = new GovernorRuntime({
      workspaceRoot,
      permissionMode: "danger-full-access",
      modelClient: client,
    });
    let sessionId = "";
    const running = runtime.runTurn({
      prompt: "Wait for an explicit interruption.",
      callbacks: { onSessionSelected: (selected) => { sessionId = selected; } },
    });
    await started;
    await runtime.interruptSession(sessionId, "Phase 14 interrupt regression.");
    await expect(running).rejects.toThrow("Phase 14 interrupt regression.");

    const store = new SessionStore(workspaceRoot);
    expect((await store.loadSession(sessionId))?.status).toBe("interrupted");
    const events = await store.loadEvents(sessionId);
    expect(events.some((event) => event.recordType === "turn" && event.status === "failed")).toBe(false);
    expect(events.some((event) => event.recordType === "turn" && event.status === "interrupted")).toBe(true);
  });

  it("forces an early cycle boundary after three identical tool-call batches", async () => {
    const { workspaceRoot } = await createWorkspace("deep-mix-phase14-repeat-convergence-");
    const repeatedResponse = (index: number): AssistantResponse => {
      const argumentsValue = index % 2 === 0
        ? { maxResults: 1, cwd: "." }
        : { cwd: ".", maxResults: 1 };
      return {
        content: "",
        toolCalls: [{
          id: `phase14-repeat-${index}`,
          name: "list_files",
          rawArguments: JSON.stringify(argumentsValue),
          arguments: argumentsValue,
        }],
      };
    };
    const client = new ScriptedModelClient([
      repeatedResponse(1),
      repeatedResponse(2),
      repeatedResponse(3),
      { content: `Stopped the repeated calls and returned a usable answer. ${"[[DEEP_MIX_COMPLETE]]"}`, toolCalls: [] },
    ]);
    const runtime = new GovernorRuntime({
      workspaceRoot,
      permissionMode: "danger-full-access",
      modelClient: client,
    });

    const result = await runtime.runTurn({ prompt: "Inspect the repository and report the result." });
    expect(result.finalResponse).toBe("Stopped the repeated calls and returned a usable answer.");
    expect(result.session.status).toBe("waiting_for_user");
    expect(client.requests).toHaveLength(4);
    expect(client.requests[3]?.tools).toEqual([]);
    const events = await new SessionStore(workspaceRoot).loadEvents(result.sessionId);
    expect(events).toContainEqual(expect.objectContaining({
      recordType: "tool_execution_audit",
      toolName: "list_files",
      success: false,
      errorType: "repeated_tool_call",
    } satisfies Partial<ToolExecutionAuditRecord>));
    const repeatedToolMessage = (await new SessionStore(workspaceRoot).loadMessages(result.sessionId)).find(
      (message) => message.role === "tool" && message.toolCallId === "phase14-repeat-3",
    );
    expect(repeatedToolMessage?.metadata).toMatchObject({ errorType: "repeated_tool_call" });
    const repeatedToolBody = JSON.parse(repeatedToolMessage?.content ?? "{}") as {
      kind?: string;
      error?: { type?: string; message?: string; retryable?: boolean; toolName?: string };
    };
    expect(repeatedToolBody).toMatchObject({
      kind: "tool_error",
      error: { type: "repeated_tool_call", retryable: false, toolName: "list_files" },
    });
    expect(events.some((event) => event.recordType === "turn" && event.status === "failed")).toBe(false);
  });

  it("keeps document selection context for a short continuation turn", async () => {
    const { workspaceRoot } = await createWorkspace("deep-mix-phase14-selection-continuation-");
    const firstTurnResponses: AssistantResponse[] = Array.from({ length: 6 }, (_, index) => ({
      content: "",
      toolCalls: [{
        id: `phase14-continuation-list-${index + 1}`,
        name: "list_files",
        rawArguments: JSON.stringify({ cwd: ".", maxResults: index + 1 }),
        arguments: { cwd: ".", maxResults: index + 1 },
      }],
    }));
    const client = new ScriptedModelClient([
      ...firstTurnResponses,
      { content: "PDF task paused after a long tool history.", toolCalls: [] },
      async (request) => {
        expect(request.tools.map((tool) => tool.function.name)).toContain("read_pdf");
        return { content: "The continuation retained the PDF reader.", toolCalls: [] };
      },
    ]);
    const runtime = new GovernorRuntime({
      workspaceRoot,
      permissionMode: "danger-full-access",
      modelClient: client,
    });
    const first = await runtime.runTurn({ prompt: "请根据根目录pdf中的内容整理分类。" });
    const second = await runtime.runTurn({ sessionId: first.sessionId, prompt: "你再试一下" });
    expect(second.finalResponse).toBe("The continuation retained the PDF reader.");
  });

  it("shows ordinary multi-tool history raw once, then summarizes only when the stable form is smaller", async () => {
    const { workspaceRoot } = await createWorkspace("deep-mix-phase14-history-");
    await fs.mkdir(path.join(workspaceRoot, "src"), { recursive: true });
    await fs.writeFile(path.join(workspaceRoot, "src", "huge.ts"), `export const huge = "${"A".repeat(24_000)}";\n`, "utf8");
    await fs.writeFile(path.join(workspaceRoot, "src", "small.ts"), "export const small = true;\n", "utf8");
    const client = new ScriptedModelClient([
      {
        content: "",
        toolCalls: [
          {
            id: "phase14-read-huge",
            name: "read_file",
            rawArguments: JSON.stringify({ path: "src/huge.ts", maxChars: 50_000 }),
            arguments: { path: "src/huge.ts", maxChars: 50_000 },
          },
          {
            id: "phase14-read-small",
            name: "read_file",
            rawArguments: JSON.stringify({ path: "src/small.ts" }),
            arguments: { path: "src/small.ts" },
          },
        ],
      },
      async (request) => {
        expectConversationHistoryLegal(request.messages);
        const toolMessages = request.messages.filter((message) => message.role === "tool");
        expect(toolMessages.map((message) => message.tool_call_id)).toEqual([
          "phase14-read-huge",
          "phase14-read-small",
        ]);
        expect(toolMessages[0]?.content).toContain("export const huge");
        expect(toolMessages[0]?.content).toContain("A".repeat(1_000));
        expect(toolMessages[0]?.content).not.toContain("[summary source=");
        expect(toolMessages[1]?.content).toContain("export const small");
        expect(toolMessages[1]?.content).not.toContain("[summary source=");
        expect(request.tools?.map((tool) => tool.function.name)).not.toEqual(
          expect.arrayContaining(["read_pdf", "read_docx", "write_pdf", "write_docx"]),
        );
        return { content: "History remained legal and bounded.", toolCalls: [] };
      },
    ]);
    const runtime = new GovernorRuntime({
      workspaceRoot,
      permissionMode: "danger-full-access",
      modelClient: client,
    });
    const result = await runtime.runTurn({
      prompt: "Inspect the two TypeScript files and explain the local runtime.",
    });
    const verificationStore = new SessionStore(workspaceRoot);
    const persistedMessages = await verificationStore.loadMessages(result.sessionId);
    expect(validateMessageHistory(persistedMessages).valid).toBe(true);
    expect(persistedMessages.find((message) => message.toolCallId === "phase14-read-huge")?.content)
      .toContain("A".repeat(1_000));
    const events = await verificationStore.loadEvents(result.sessionId);
    expect(events.find((event): event is ContextSummaryRecord =>
      event.recordType === "context_summary" && event.sourceToolCallId === "phase14-read-huge"))
      .toMatchObject({ toolOutputLifecycle: "raw_once_then_summary_v1" });
    const budgets = events.filter((event): event is ContextBudgetRecord => event.recordType === "context_budget");
    expect(budgets.map((event) => event.scope)).toEqual(expect.arrayContaining(["before_model", "after_model"]));
    expect(budgets.every((event) => event.snapshot.usedInputTokens <= event.snapshot.inputBudgetTokens)).toBe(true);
    expect(budgets.some((event) =>
      (event.snapshot.categories.find((category) => category.key === "tools")?.estimatedTokens ?? 0) > 0)).toBe(true);
    expect(budgets.some((event) =>
      event.scope === "before_model" && event.snapshot.toolOutputExposure?.rawMessageCount === 2)).toBe(true);
    const selections = events.filter((event): event is ToolSelectionRecord => event.recordType === "tool_selection");
    expect(selections.length).toBeGreaterThanOrEqual(2);
    expect(selections.every((record) =>
      !record.selectedToolNames.some((name) => ["read_pdf", "read_docx", "write_pdf", "write_docx"].includes(name)))).toBe(true);
  }, 15_000);
});
