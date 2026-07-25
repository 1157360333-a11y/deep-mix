import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import sharp from "sharp";
import { afterEach, describe, expect, it } from "vitest";
import { GovernorRuntime } from "../packages/core-governor/src/index.js";
import { SessionStore } from "../packages/persistence/src/index.js";
import {
  createCodingWorkerRouteProfile,
  createGovernorRouteProfile,
  createVisionWorkerRouteProfile,
} from "../packages/route-resolver/src/index.js";
import { SpecialistBroker } from "../packages/specialist-broker/src/index.js";
import { ToolRuntime } from "../packages/tool-runtime/src/index.js";
import type {
  AssistantResponse,
  DiagnosticReportRecord,
  ModelCompletionRequest,
  RoutingDecisionRecord,
  StreamCallbacks,
  SupervisorDecision,
  WorkerSessionLinkRecord,
} from "../packages/shared-schema/src/index.js";
import { GlmWorkerError, type CodingWorkerRunner, type GlmCodingWorkerExecutionResult } from "../packages/worker-glm-coding/src/index.js";
import { KimiVisionWorkerError, type KimiVisionWorkerExecutionResult, type VisionWorkerRunner } from "../packages/worker-kimi-vision/src/index.js";

class ScriptedModelClient {
  private index = 0;

  public constructor(private readonly responses: AssistantResponse[]) {}

  public async streamCompletion(
    _request: ModelCompletionRequest,
    callbacks?: StreamCallbacks,
  ): Promise<AssistantResponse> {
    const response = this.responses[this.index];
    if (!response) {
      throw new Error(`Unexpected model call index ${this.index}`);
    }
    this.index += 1;

    for (const char of response.content) {
      callbacks?.onTextDelta?.(char);
    }

    return response;
  }
}

const temporaryRoots: string[] = [];

async function writeSvgPng(filePath: string, options: { width: number; height: number; body: string }): Promise<void> {
  const svg = `
    <svg xmlns="http://www.w3.org/2000/svg" width="${options.width}" height="${options.height}" viewBox="0 0 ${options.width} ${options.height}">
      ${options.body}
    </svg>
  `;
  await sharp(Buffer.from(svg)).png().toFile(filePath);
}

async function createFixtureWorkspace(): Promise<string> {
  const workspaceRoot = await fs.mkdtemp(path.join(os.tmpdir(), "deep-mix-phase5-"));
  temporaryRoots.push(workspaceRoot);
  await fs.mkdir(path.join(workspaceRoot, "src", "routes"), { recursive: true });
  await fs.mkdir(path.join(workspaceRoot, "src", "services"), { recursive: true });
  await fs.mkdir(path.join(workspaceRoot, "fixtures"), { recursive: true });
  await fs.mkdir(path.join(workspaceRoot, ".deep-mix", "api-key-library"), { recursive: true });

  await fs.writeFile(
    path.join(workspaceRoot, "tsconfig.json"),
    JSON.stringify(
      {
        compilerOptions: {
          target: "ES2022",
          module: "NodeNext",
          moduleResolution: "NodeNext",
          strict: true,
          noEmit: true,
        },
        include: ["src/**/*.ts"],
      },
      null,
      2,
    ),
    "utf8",
  );

  await fs.writeFile(
    path.join(workspaceRoot, "src", "routes", "index.ts"),
    [
      "export function registerRoutes() {",
      "  return ['/ping'];",
      "}",
      "",
    ].join("\n"),
    "utf8",
  );
  await fs.writeFile(
    path.join(workspaceRoot, "src", "services", "health.ts"),
    [
      "export function getHealthStatus() {",
      "  return 'healthy';",
      "}",
      "",
    ].join("\n"),
    "utf8",
  );
  await fs.writeFile(
    path.join(workspaceRoot, "src", "script.ts"),
    [
      "export function addOne(value: number) {",
      "  return value + 1;",
      "}",
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
          kimi_vision: {
            provider: "kimi",
            role: "vision_worker",
            apiKey: "fake-local-key",
            baseUrl: "https://example.invalid",
            chatPath: "/v1/chat/completions",
            model: "kimi-k2.6",
            supportsMultimodalInput: true,
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

  await writeSvgPng(path.join(workspaceRoot, "fixtures", "error.png"), {
    width: 1400,
    height: 900,
    body: `
      <rect width="1400" height="900" fill="#111827"/>
      <rect x="120" y="120" width="1160" height="660" rx="28" fill="#1f2937" stroke="#ef4444" stroke-width="8"/>
      <text x="180" y="260" font-size="52" fill="#fca5a5" font-family="Arial">TypeError: Cannot read properties of undefined</text>
      <text x="180" y="350" font-size="38" fill="#f8fafc" font-family="Arial">at renderDashboard (src/dashboard.ts:42)</text>
    `,
  });

  return workspaceRoot;
}

function createCodingWorkerResult(): GlmCodingWorkerExecutionResult {
  return {
    artifact: {
      summary: "Updated the script helper and related route wiring.",
      changedFiles: ["src/script.ts"],
      testCommands: [],
      risks: ["Route consumers should keep the return contract stable."],
      confidence: 0.87,
      notes: ["No workspace files were written directly by the worker."],
      metadata: {
        source: "fake-worker",
      },
    },
    patch: [
      "*** Begin Patch",
      "*** Update File: src/script.ts",
      "@@",
      " export function addOne(value: number) {",
      "-  return value + 1;",
      "+  return value + 2;",
      " }",
      "*** End Patch",
    ].join("\n"),
    rawResponse: "<code_artifact>{}</code_artifact><patch>*** Begin Patch</patch>",
  };
}

function createVisionSuccessResult(summary: string): KimiVisionWorkerExecutionResult {
  return {
    artifact: {
      summary,
      confidence: 0.91,
      issues: [],
      ocrBlocks: [{ text: "TypeError: Cannot read properties of undefined", confidence: 0.98, regionId: "err-1" }],
      regions: [{ id: "err-1", label: "stack-trace", confidence: 0.95, bbox: { x: 120, y: 120, width: 1160, height: 280 } }],
      components: [{ id: "panel-1", type: "error_panel", label: "Error panel", confidence: 0.9, regionId: "err-1" }],
      errorText: ["TypeError: Cannot read properties of undefined"],
      suspectedCauses: ["renderDashboard dereferenced an undefined value."],
      evidenceRegions: ["err-1"],
    },
    rawResponse: JSON.stringify({ ok: true }),
  };
}

function createFinalOnlyRuntime(
  workspaceRoot: string,
  broker: SpecialistBroker,
  finalMessage: string,
): GovernorRuntime {
  return new GovernorRuntime({
    workspaceRoot,
    permissionMode: "danger-full-access",
    specialistBroker: broker,
    modelClient: new ScriptedModelClient([
      {
        content: finalMessage,
        toolCalls: [],
      },
    ]),
  });
}

async function loadRoutingDecisions(sessionStore: SessionStore, sessionId: string): Promise<RoutingDecisionRecord[]> {
  const events = await sessionStore.loadEvents(sessionId);
  return events.filter((event): event is RoutingDecisionRecord => event.recordType === "routing_decision");
}

async function loadDiagnosticReports(sessionStore: SessionStore, sessionId: string): Promise<DiagnosticReportRecord[]> {
  const events = await sessionStore.loadEvents(sessionId);
  return events.filter((event): event is DiagnosticReportRecord => event.recordType === "diagnostic_report");
}

async function loadWorkerSessionIds(sessionStore: SessionStore, sessionId: string): Promise<string[]> {
  const events = await sessionStore.loadEvents(sessionId);
  return events
    .filter((event): event is WorkerSessionLinkRecord => event.recordType === "worker_session_link")
    .map((event) => event.workerSessionId);
}

afterEach(async () => {
  await Promise.all(
    temporaryRoots.splice(0).map(async (root) => {
      await fs.rm(root, { recursive: true, force: true });
    }),
  );
});

describe("phase 5 routing policy and diagnostics", () => {
  it("exposes complete route profiles for governor, coding worker, and vision worker", async () => {
    const governorRoute = createGovernorRouteProfile({
      apiKey: "fake-key",
      baseUrl: "https://example.invalid",
      model: "deepseek-chat",
      role: "governor",
      endpointPath: "/chat/completions",
      stream: true,
      contextWindow: 128000,
      maxRetries: 2,
      timeoutMs: 120000,
      contextSoftLimitTokens: 96000,
      contextCompactThresholdTokens: 84000,
      contextReserveOutputTokens: 8000,
      contextSummaryMaxTokens: 2048,
      contextRecentTailMaxTokens: 24000,
      maxHistoryMessages: 12,
      historyCharBudget: 16000,
      temperature: 0.2,
      thinking: {
        type: "adaptive",
        reasoningEffort: "medium",
      },
    });
    const codingRoute = createCodingWorkerRouteProfile({
      apiKey: "fake-key",
      baseUrl: "https://example.invalid",
      endpointPath: "/chat/completions",
      model: "glm-5.2",
      role: "coding_worker",
      contextWindow: 128000,
      maxRetries: 1,
      timeoutMs: 180000,
      temperature: 0.1,
      maxContextChars: 24000,
      maxContextFiles: 6,
      headers: { "Content-Type": "application/json" },
      requestDefaults: {},
      workspaceWriteAccess: false,
    });
    const visionRoute = createVisionWorkerRouteProfile({
      apiKey: "fake-key",
      baseUrl: "https://example.invalid",
      endpointPath: "/v1/chat/completions",
      model: "kimi-k2.6",
      role: "vision_worker",
      contextWindow: 256000,
      maxRetries: 1,
      timeoutMs: 120000,
      maxContextChars: 12000,
      maxImageBytes: 4 * 1024 * 1024,
      maxImageDimension: 4096,
      targetImageDimension: 2048,
      targetImageBytes: 4 * 1024 * 1024,
      imageInputMode: "base64_data_url",
      responseFormat: "json_object",
      headers: { "Content-Type": "application/json" },
      requestDefaults: {},
      supportsMultimodalInput: true,
    });

    for (const route of [governorRoute, codingRoute, visionRoute]) {
      expect(route.contextWindow).toBeGreaterThan(0);
      expect(route.toolCallingMode).toBeDefined();
      expect(route.thinkingMode.mode).toBeDefined();
      expect(route.pricing.input.available).toBeTypeOf("boolean");
      expect(route.pricing.output.available).toBeTypeOf("boolean");
      expect(route.pricing.cacheRead.available).toBeTypeOf("boolean");
      expect(route.pricing.cacheWrite.available).toBeTypeOf("boolean");
    }
  });

  it("auto-routes a complex backend task to GLM and records the routing decision", async () => {
    const workspaceRoot = await createFixtureWorkspace();
    const sessionStore = new SessionStore(workspaceRoot);
    await sessionStore.ensureInitialized();

    const broker = new SpecialistBroker({
      workspaceRoot,
      sessionStore,
      codingWorkerFactory: () =>
        ({
          runTask: async () => createCodingWorkerResult(),
        }) satisfies CodingWorkerRunner,
    });
    const runtime = createFinalOnlyRuntime(workspaceRoot, broker, "GLM route completed and returned a structured artifact.");
    const presentationEvents: string[] = [];

    const result = await runtime.runTurn({
      prompt:
        "Refactor the backend health flow across file://src/routes/index.ts and file://src/services/health.ts so the API structure stays consistent.",
      callbacks: {
        onToolBatchStart: (batch) => presentationEvents.push(
          `batch:${batch.assistantMessageId}:${batch.turnId}:${batch.toolCalls.map((toolCall) => toolCall.name).join(",")}`,
        ),
        onToolStart: (toolCall) => presentationEvents.push(`tool:${toolCall.name}`),
      },
    });

    expect(result.session.status).toBe("waiting_for_user");
    expect(presentationEvents[0]).toMatch(/^batch:[^:]+:[^:]+:invoke_coding_worker$/u);
    expect(presentationEvents[1]).toBe("tool:invoke_coding_worker");

    const routingDecisions = await loadRoutingDecisions(sessionStore, result.sessionId);
    expect(routingDecisions[0]?.finalTarget).toBe("glm_coding");
    expect(routingDecisions[0]?.automaticTarget).toBe("glm_coding");
    expect(routingDecisions[0]?.reasonCodes).toContain("backend_implementation_task");

    const workerSessionIds = await loadWorkerSessionIds(sessionStore, result.sessionId);
    expect(workerSessionIds).toHaveLength(1);
    const workerMeta = await sessionStore.loadWorkerSession(workerSessionIds[0]!);
    expect(workerMeta?.route.role).toBe("coding_worker");
  }, 30_000);

  it("routes screenshot work to Kimi first, then falls back to DeepSeek when vision parsing fails", async () => {
    const workspaceRoot = await createFixtureWorkspace();
    const sessionStore = new SessionStore(workspaceRoot);
    await sessionStore.ensureInitialized();

    const broker = new SpecialistBroker({
      workspaceRoot,
      sessionStore,
      visionWorkerFactory: () =>
        ({
          runTask: async () => {
            throw new KimiVisionWorkerError("response_parse_failed", "Could not parse the screenshot.", {
              retryable: false,
              rawResponse: "<bad-response>",
            });
          },
        }) satisfies VisionWorkerRunner,
    });
    const runtime = createFinalOnlyRuntime(workspaceRoot, broker, "Please upload a clearer screenshot or paste the error text.");

    const result = await runtime.runTurn({
      prompt: "Analyze this error screenshot file://fixtures/error.png and explain the likely cause.",
    });

    expect(result.finalResponse).toContain("clearer screenshot");

    const routingDecisions = await loadRoutingDecisions(sessionStore, result.sessionId);
    expect(routingDecisions[0]?.finalTarget).toBe("kimi_vision");
    expect(routingDecisions[1]?.mode).toBe("fallback");
    expect(routingDecisions[1]?.finalTarget).toBe("ds_direct");
    expect(routingDecisions[1]?.reasonCodes).toContain("vision_worker_failed");
  });

  it("records both automatic and manual override targets when the route is forced", async () => {
    const workspaceRoot = await createFixtureWorkspace();
    const sessionStore = new SessionStore(workspaceRoot);
    await sessionStore.ensureInitialized();

    const broker = new SpecialistBroker({
      workspaceRoot,
      sessionStore,
      codingWorkerFactory: () =>
        ({
          runTask: async () => createCodingWorkerResult(),
        }) satisfies CodingWorkerRunner,
    });
    const runtime = createFinalOnlyRuntime(workspaceRoot, broker, "Manual route override dispatched the coding worker.");

    const result = await runtime.runTurn({
      prompt: "Small patch: update file://src/script.ts in one file only.",
      routeOverride: "glm_coding",
    });

    const routingDecisions = await loadRoutingDecisions(sessionStore, result.sessionId);
    expect(routingDecisions[0]?.mode).toBe("manual_override");
    expect(routingDecisions[0]?.automaticTarget).toBe("ds_direct");
    expect(routingDecisions[0]?.finalTarget).toBe("glm_coding");
    expect(routingDecisions[0]?.reasonCodes[0]).toBe("manual_override");
  });

  it("keeps a small single-file fix on DeepSeek direct and auto-runs diagnostics after apply_patch", async () => {
    const workspaceRoot = await createFixtureWorkspace();
    const sessionStore = new SessionStore(workspaceRoot);
    await sessionStore.ensureInitialized();

    const broker = new SpecialistBroker({
      workspaceRoot,
      sessionStore,
    });
    const runtime = new GovernorRuntime({
      workspaceRoot,
      permissionMode: "danger-full-access",
      specialistBroker: broker,
      modelClient: new ScriptedModelClient([
        {
          content: "",
          toolCalls: [
            {
              id: "patch-1",
              name: "apply_patch",
              rawArguments: JSON.stringify({
                changes: [
                  {
                    path: "src/script.ts",
                    action: "upsert",
                    content: ["export function addOne(value: number) {", "  return value + 2;", "}", ""].join("\n"),
                  },
                ],
              }),
              arguments: {
                changes: [
                  {
                    path: "src/script.ts",
                    action: "upsert",
                    content: ["export function addOne(value: number) {", "  return value + 2;", "}", ""].join("\n"),
                  },
                ],
              },
            },
          ],
        },
        {
          content: "DeepSeek handled the single-file patch directly.",
          toolCalls: [],
        },
      ]),
    });

    const result = await runtime.runTurn({
      prompt: "Small patch: update file://src/script.ts in one file only.",
    });

    expect(result.finalResponse).toContain("DeepSeek handled");
    const routingDecisions = await loadRoutingDecisions(sessionStore, result.sessionId);
    expect(routingDecisions[0]?.finalTarget).toBe("ds_direct");

    const diagnosticReports = await loadDiagnosticReports(sessionStore, result.sessionId);
    expect(diagnosticReports.some((report) => report.trigger === "apply_patch")).toBe(true);
    const applyPatchReport = diagnosticReports.find((report) => report.trigger === "apply_patch");
    expect(applyPatchReport?.diagnostics.some((entry) => entry.kind === "lsp")).toBe(true);
    expect(applyPatchReport?.diagnostics.some((entry) => entry.kind === "typecheck")).toBe(true);

    const telemetry = await sessionStore.loadTelemetrySummary();
    expect(telemetry.counters.directDsSuccessCount).toBe(1);

    const sessionJsonl = await fs.readFile(path.join(workspaceRoot, ".deep-mix", "sessions", `${result.sessionId}.jsonl`), "utf8");
    expect(sessionJsonl).toContain("\"recordType\":\"diagnostic_report\"");
    const sessionRecords = sessionJsonl.trim().split(/\r?\n/u).map(
      (line) => JSON.parse(line) as Record<string, unknown>,
    );
    const applyPatchToolMessage = sessionRecords.find(
      (record) => record["recordType"] === "message" && record["role"] === "tool" && record["name"] === "apply_patch",
    );
    expect(typeof applyPatchToolMessage?.["content"]).toBe("string");
    const applyPatchToolMetadata = applyPatchToolMessage?.["metadata"] as Record<string, unknown> | undefined;
    expect(typeof applyPatchToolMetadata?.["startedAt"]).toBe("string");
    expect(typeof applyPatchToolMetadata?.["endedAt"]).toBe("string");
    expect(Date.parse(String(applyPatchToolMetadata?.["endedAt"]))).toBeGreaterThanOrEqual(
      Date.parse(String(applyPatchToolMetadata?.["startedAt"])),
    );
    const applyPatchToolBody = JSON.parse(String(applyPatchToolMessage?.["content"])) as {
      diagnosticReport?: { recordType?: string; diagnostics?: Array<{ kind?: string }> };
    };
    expect(applyPatchToolBody.diagnosticReport?.recordType).toBe("diagnostic_report");
    expect(applyPatchToolBody.diagnosticReport?.diagnostics?.map((entry) => entry.kind)).toEqual(
      expect.arrayContaining(["lsp", "lint", "typecheck"]),
    );
    expect(sessionJsonl).not.toContain("diagnostics=lsp:ok");
  }, 60_000);

  it("applies an accepted worker patch with diagnostics feedback and updates acceptance telemetry", async () => {
    const workspaceRoot = await createFixtureWorkspace();
    const sessionStore = new SessionStore(workspaceRoot);
    await sessionStore.ensureInitialized();

    const broker = new SpecialistBroker({
      workspaceRoot,
      sessionStore,
      codingWorkerFactory: () =>
        ({
          runTask: async () => createCodingWorkerResult(),
        }) satisfies CodingWorkerRunner,
    });
    const runtime = createFinalOnlyRuntime(workspaceRoot, broker, "Worker artifact collected.");

    const turnResult = await runtime.runTurn({
      prompt:
        "Refactor the backend helper across file://src/routes/index.ts and file://src/services/health.ts, then keep the script helper consistent.",
    });
    const workerSessionId = (await loadWorkerSessionIds(sessionStore, turnResult.sessionId))[0]!;
    const supervisor = runtime.getSupervisorReviewService();
    const acceptDecision: SupervisorDecision = {
      action: "accept",
      reason: "Artifact is ready for promotion.",
      evidenceRefs: [],
    };
    await supervisor.accept({
      workerSessionId,
      decision: acceptDecision,
    });
    const applyResult = await supervisor.applyAcceptedPatch({
      workerSessionId,
    });

    expect(applyResult.success).toBe(true);
    const structured = applyResult.structuredContent as { diagnostics: Array<{ kind: string; ok: boolean }> };
    expect(structured.diagnostics.some((entry) => entry.kind === "lsp")).toBe(true);
    expect(structured.diagnostics.some((entry) => entry.kind === "typecheck")).toBe(true);

    const updatedScript = await fs.readFile(path.join(workspaceRoot, "src", "script.ts"), "utf8");
    expect(updatedScript).toContain("return value + 2;");

    const telemetry = await sessionStore.loadTelemetrySummary();
    expect(telemetry.counters.workerAcceptanceRate).toBe(1);

    const diagnosticReports = await loadDiagnosticReports(sessionStore, turnResult.sessionId);
    expect(diagnosticReports.some((report) => report.trigger === "apply_artifact_patch")).toBe(true);
  }, 60_000);

  it("falls back to run_tests when diagnostics are unavailable", async () => {
    const workspaceRoot = await createFixtureWorkspace();
    await fs.rm(path.join(workspaceRoot, "tsconfig.json"));

    const sessionStore = new SessionStore(workspaceRoot);
    await sessionStore.ensureInitialized();
    const session = await sessionStore.createSession("diagnostic fallback");
    const runtime = new ToolRuntime({
      workspaceRoot,
      sessionStore,
      permissionMode: "danger-full-access",
    });

    const result = await runtime.executeManualTool(
      "apply_patch",
      {
        runTestsCommand: "Write-Output '1 passing'",
        changes: [
          {
            path: "src/script.ts",
            action: "upsert",
            content: ["export function addOne(value: number) {", "  return value + 2;", "}", ""].join("\n"),
          },
        ],
      },
      session.sessionId,
    );

    expect(result.success).toBe(true);
    const diagnosticReports = await loadDiagnosticReports(sessionStore, session.sessionId);
    const report = diagnosticReports.find((entry) => entry.trigger === "apply_patch");
    expect(report?.diagnostics.some((entry) => entry.kind === "lsp" && entry.status === "unavailable")).toBe(true);
    expect(report?.diagnostics.some((entry) => entry.kind === "typecheck" && entry.status === "unavailable")).toBe(true);
    expect(report?.diagnostics.some((entry) => entry.kind === "run_tests" && entry.ok)).toBe(true);
  });

  it("falls back to DeepSeek when the coding worker fails and records fallback telemetry", async () => {
    const workspaceRoot = await createFixtureWorkspace();
    const sessionStore = new SessionStore(workspaceRoot);
    await sessionStore.ensureInitialized();

    const broker = new SpecialistBroker({
      workspaceRoot,
      sessionStore,
      codingWorkerFactory: () =>
        ({
          runTask: async () => {
            throw new GlmWorkerError("response_parse_failed", "Mock parse failure from coding worker.", {
              retryable: false,
              rawResponse: "<broken-worker-response>",
            });
          },
        }) satisfies CodingWorkerRunner,
    });
    const runtime = createFinalOnlyRuntime(workspaceRoot, broker, "DeepSeek fell back to direct handling after the worker failure.");

    const result = await runtime.runTurn({
      prompt:
        "Implement a backend refactor across file://src/routes/index.ts and file://src/services/health.ts, then report the failure path if the worker breaks.",
    });

    expect(result.finalResponse).toContain("fell back");

    const routingDecisions = await loadRoutingDecisions(sessionStore, result.sessionId);
    expect(routingDecisions[0]?.finalTarget).toBe("glm_coding");
    expect(routingDecisions[1]?.mode).toBe("fallback");
    expect(routingDecisions[1]?.reasonCodes).toContain("coding_worker_failed");

    const telemetry = await sessionStore.loadTelemetrySummary();
    expect(telemetry.counters.fallbackCount).toBeGreaterThan(0);
    expect(telemetry.counters.fallbackRate).toBeGreaterThan(0);
  });

  it("keeps a usable Kimi success path when the vision worker returns structured output", async () => {
    const workspaceRoot = await createFixtureWorkspace();
    const sessionStore = new SessionStore(workspaceRoot);
    await sessionStore.ensureInitialized();

    const broker = new SpecialistBroker({
      workspaceRoot,
      sessionStore,
      visionWorkerFactory: () =>
        ({
          runTask: async () => createVisionSuccessResult("Detected the main error text from the screenshot."),
        }) satisfies VisionWorkerRunner,
    });
    const runtime = createFinalOnlyRuntime(workspaceRoot, broker, "Kimi returned structured screenshot findings.");

    const result = await runtime.runTurn({
      prompt: "Analyze this error screenshot file://fixtures/error.png and summarize the visible exception.",
    });

    expect(result.finalResponse).toContain("Kimi returned");
    const routingDecisions = await loadRoutingDecisions(sessionStore, result.sessionId);
    expect(routingDecisions[0]?.finalTarget).toBe("kimi_vision");
    const workerSessionId = (await loadWorkerSessionIds(sessionStore, result.sessionId))[0]!;
    const workerMeta = await sessionStore.loadWorkerSession(workerSessionId);
    expect(workerMeta?.route.role).toBe("vision_worker");
  });
});
