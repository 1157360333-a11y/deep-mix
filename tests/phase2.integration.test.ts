import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { GovernorRuntime } from "../packages/core-governor/src/index.js";
import { SessionStore } from "../packages/persistence/src/index.js";
import { SpecialistBroker } from "../packages/specialist-broker/src/index.js";
import type {
  AssistantResponse,
  ModelClient,
  ModelCompletionRequest,
  StreamCallbacks,
  WorkerTask,
} from "../packages/shared-schema/src/index.js";
import { GlmWorkerError, type CodingWorkerRunner, type GlmCodingWorkerExecutionResult } from "../packages/worker-glm-coding/src/index.js";

class ScriptedModelClient implements ModelClient {
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
const envBackups = new Map<string, string | undefined>();

function setEnv(key: string, value: string | undefined): void {
  if (!envBackups.has(key)) {
    envBackups.set(key, process.env[key]);
  }

  if (value === undefined) {
    delete process.env[key];
    return;
  }

  process.env[key] = value;
}

async function createFixtureWorkspace(): Promise<string> {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "deep-mix-phase2-"));
  temporaryRoots.push(root);
  await fs.mkdir(path.join(root, "src", "routes"), { recursive: true });
  await fs.mkdir(path.join(root, ".deep-mix", "api-key-library"), { recursive: true });
  await fs.writeFile(
    path.join(root, "src", "routes", "index.ts"),
    [
      "import { Router } from 'express';",
      "",
      "export function registerRoutes(router: Router) {",
      "  router.get('/ping', (_req, res) => {",
      "    res.json({ ok: true });",
      "  });",
      "}",
      "",
    ].join("\n"),
    "utf8",
  );
  await fs.writeFile(
    path.join(root, ".deep-mix", "api-key-library", "profiles.local.json"),
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
  return root;
}

function createTask(): WorkerTask {
  return {
    workerType: "coding",
    objective: "Add a GET /health endpoint next to the existing /ping route.",
    constraints: ["Do not change deployment config.", "Do not modify package.json."],
    contextRefs: [
      "file://src/routes/index.ts",
      {
        refType: "summary",
        label: "Route style",
        summary: "Keep using the existing registerRoutes(router) pattern and return JSON.",
      },
    ],
    expectedOutput: "code_artifact",
    acceptanceChecks: ["Return a valid apply_patch envelope.", "List the changed route file."],
  };
}

function createSuccessfulWorkerResult(): GlmCodingWorkerExecutionResult {
  const rawResponse = [
    "<code_artifact>",
    JSON.stringify(
      {
        summary: "Added a /health route beside /ping.",
        changedFiles: ["src/routes/index.ts"],
        testCommands: ["npm test -- routes"],
        risks: ["Health payload shape should stay stable."],
        confidence: 0.88,
        notes: ["No workspace files were modified directly by the worker."],
      },
      null,
      2,
    ),
    "</code_artifact>",
    "<patch>",
    "*** Begin Patch",
    "*** Update File: src/routes/index.ts",
    "@@",
    " export function registerRoutes(router: Router) {",
    "   router.get('/ping', (_req, res) => {",
    "     res.json({ ok: true });",
    "   });",
    "+  router.get('/health', (_req, res) => {",
    "+    res.json({ status: 'healthy' });",
    "+  });",
    " }",
    "*** End Patch",
    "</patch>",
  ].join("\n");

  return {
    artifact: {
      summary: "Added a /health route beside /ping.",
      changedFiles: ["src/routes/index.ts"],
      testCommands: ["npm test -- routes"],
      risks: ["Health payload shape should stay stable."],
      confidence: 0.88,
      notes: ["No workspace files were modified directly by the worker."],
      metadata: {
        source: "fake-worker",
      },
    },
    patch: [
      "*** Begin Patch",
      "*** Update File: src/routes/index.ts",
      "@@",
      " export function registerRoutes(router: Router) {",
      "   router.get('/ping', (_req, res) => {",
      "     res.json({ ok: true });",
      "   });",
      "+  router.get('/health', (_req, res) => {",
      "+    res.json({ status: 'healthy' });",
      "+  });",
      " }",
      "*** End Patch",
    ].join("\n"),
    rawResponse,
  };
}

async function waitForWorkerSessionId(workspaceRoot: string): Promise<string> {
  const workerDir = path.join(workspaceRoot, ".deep-mix", "worker-sessions");
  for (let attempt = 0; attempt < 50; attempt += 1) {
    try {
      const files = await fs.readdir(workerDir);
      const match = files.find((file) => file.endsWith(".json"));
      if (match) {
        return match.replace(/\.json$/, "");
      }
    } catch {
      // Ignore and retry.
    }

    await new Promise((resolve) => setTimeout(resolve, 20));
  }

  throw new Error("Timed out waiting for worker session metadata.");
}

afterEach(async () => {
  for (const [key, value] of envBackups) {
    if (value === undefined) {
      delete process.env[key];
    } else {
      process.env[key] = value;
    }
  }
  envBackups.clear();

  await Promise.all(
    temporaryRoots.splice(0).map(async (root) => {
      await fs.rm(root, { recursive: true, force: true });
    }),
  );
});

describe("phase 2 GLM coding worker integration", () => {
  it("routes a complex coding task through invoke_coding_worker and keeps the patch only in artifact store", async () => {
    const workspaceRoot = await createFixtureWorkspace();
    const broker = new SpecialistBroker({
      workspaceRoot,
      sessionStore: new SessionStore(workspaceRoot),
      codingWorkerFactory: () =>
        ({
          runTask: async ({ resolvedContext }) => {
            expect(resolvedContext).toContain("file://src/routes/index.ts");
            expect(resolvedContext).toContain("router.get('/ping'");
            return createSuccessfulWorkerResult();
          },
        }) satisfies CodingWorkerRunner,
    });

    const runtime = new GovernorRuntime({
      workspaceRoot,
      specialistBroker: broker,
      modelClient: new ScriptedModelClient([
        {
          content: "",
          toolCalls: [
            {
              id: "worker-1",
              name: "invoke_coding_worker",
              rawArguments: JSON.stringify(createTask()),
              arguments: createTask(),
            },
          ],
        },
        {
          content: "Collected the complete CodeArtifact record from GLM and kept the patch in artifact storage.",
          toolCalls: [],
        },
      ]),
    });

    const result = await runtime.runTurn({
      prompt: "Add a health endpoint via the coding worker.",
    });

    expect(result.session.status).toBe("waiting_for_user");
    expect(result.finalResponse).toContain("CodeArtifact");

    const stateRoot = path.join(workspaceRoot, ".deep-mix");
    const sessionJsonl = await fs.readFile(path.join(stateRoot, "sessions", `${result.sessionId}.jsonl`), "utf8");
    expect(sessionJsonl).toContain("\"recordType\":\"worker_session_link\"");
    expect(sessionJsonl).toContain("artifact://patches/");
    expect(sessionJsonl).not.toContain("*** Begin Patch");
    expect(sessionJsonl).not.toContain("status: 'healthy'");

    const workerSessionId = await waitForWorkerSessionId(workspaceRoot);
    const workerMeta = JSON.parse(
      await fs.readFile(path.join(stateRoot, "worker-sessions", `${workerSessionId}.json`), "utf8"),
    ) as { status: string; parentSessionId: string; route: { role: string }; retryCount: number };
    expect(workerMeta.status).toBe("completed");
    expect(workerMeta.parentSessionId).toBe(result.sessionId);
    expect(workerMeta.route.role).toBe("coding_worker");
    expect(workerMeta.retryCount).toBe(0);

    const workerHistory = await fs.readFile(path.join(stateRoot, "worker-sessions", `${workerSessionId}.jsonl`), "utf8");
    expect(workerHistory).toContain("\"recordType\":\"worker_message\"");
    expect(workerHistory).toContain("\"recordType\":\"worker_artifact\"");

    const patchDir = path.join(stateRoot, "worker-artifacts", "patches", workerSessionId);
    const patchFiles = await fs.readdir(patchDir);
    expect(patchFiles).toHaveLength(1);
    const patchContent = await fs.readFile(path.join(patchDir, patchFiles[0]!), "utf8");
    expect(patchContent).toContain("*** Begin Patch");
    expect(patchContent).toContain("/health");
  });

  it("returns a structured failure to the main session without breaking the governor loop", async () => {
    const workspaceRoot = await createFixtureWorkspace();
    const broker = new SpecialistBroker({
      workspaceRoot,
      sessionStore: new SessionStore(workspaceRoot),
      codingWorkerFactory: () =>
        ({
          runTask: async () => {
            throw new GlmWorkerError("response_parse_failed", "Mock parse failure from coding worker.", {
              retryable: false,
              rawResponse: "not-a-valid-worker-response",
            });
          },
        }) satisfies CodingWorkerRunner,
    });

    const runtime = new GovernorRuntime({
      workspaceRoot,
      specialistBroker: broker,
      modelClient: new ScriptedModelClient([
        {
          content: "",
          toolCalls: [
            {
              id: "worker-1",
              name: "invoke_coding_worker",
              rawArguments: JSON.stringify(createTask()),
              arguments: createTask(),
            },
          ],
        },
        {
          content: "The coding worker failed with a parse error, so the governor can continue without crashing the session.",
          toolCalls: [],
        },
      ]),
    });

    const result = await runtime.runTurn({
      prompt: "Try the coding worker and report if it fails.",
    });

    expect(result.session.status).toBe("waiting_for_user");
    expect(result.finalResponse).toContain("failed");

    const stateRoot = path.join(workspaceRoot, ".deep-mix");
    const sessionJsonl = await fs.readFile(path.join(stateRoot, "sessions", `${result.sessionId}.jsonl`), "utf8");
    expect(sessionJsonl).toContain("response_parse_failed");
    expect(sessionJsonl).not.toContain("*** Begin Patch");

    const workerSessionId = await waitForWorkerSessionId(workspaceRoot);
    const workerMeta = JSON.parse(
      await fs.readFile(path.join(stateRoot, "worker-sessions", `${workerSessionId}.json`), "utf8"),
    ) as { status: string; lastErrorType?: string };
    expect(workerMeta.status).toBe("failed");
    expect(workerMeta.lastErrorType).toBe("response_parse_failed");
  });

  it("retries the same task once after a retryable worker error and keeps retry state separate from revise state", async () => {
    const workspaceRoot = await createFixtureWorkspace();
    setEnv("GLM_CODING_WORKER_MAX_RETRIES", "1");

    let attempt = 0;
    const sessionStore = new SessionStore(workspaceRoot);
    await sessionStore.ensureInitialized();
    const mainSession = await sessionStore.createSession("Create worker retry fixture.");

    const broker = new SpecialistBroker({
      workspaceRoot,
      sessionStore,
      codingWorkerFactory: () =>
        ({
          runTask: async () => {
            attempt += 1;
            if (attempt === 1) {
              throw new GlmWorkerError("response_parse_failed", "Temporary parse failure.", {
                retryable: true,
                rawResponse: "<broken>",
              });
            }
            return createSuccessfulWorkerResult();
          },
        }) satisfies CodingWorkerRunner,
    });

    const result = await broker.invokeCodingWorker({
      parentSessionId: mainSession.sessionId,
      task: createTask(),
    });

    expect(result.artifact?.changedFiles).toEqual(["src/routes/index.ts"]);
    expect(attempt).toBe(2);

    const workerSessionId = result.workerSessionId;
    const workerMeta = await sessionStore.loadWorkerSession(workerSessionId);
    expect(workerMeta?.status).toBe("completed");
    expect(workerMeta?.retryCount).toBe(1);
    expect(workerMeta?.revisionCount).toBe(0);

    const history = await sessionStore.loadWorkerEvents(workerSessionId);
    expect(history.some((event) => event.recordType === "worker_status" && event.status === "failed")).toBe(true);
    expect(history.some((event) => event.recordType === "worker_status" && event.dispatchKind === "retry")).toBe(true);
  });

  it("supports cancelling an active worker session from the governor entry point", async () => {
    const workspaceRoot = await createFixtureWorkspace();
    const sessionStore = new SessionStore(workspaceRoot);
    await sessionStore.ensureInitialized();
    const mainSession = await sessionStore.createSession("Create worker cancel fixture.");

    const broker = new SpecialistBroker({
      workspaceRoot,
      sessionStore,
      codingWorkerFactory: () =>
        ({
          runTask: async ({ signal }) =>
            new Promise<GlmCodingWorkerExecutionResult>((_resolve, reject) => {
              signal?.addEventListener("abort", () => {
                reject(new Error("aborted"));
              });
            }),
        }) satisfies CodingWorkerRunner,
    });

    const pending = broker.invokeCodingWorker({
      parentSessionId: mainSession.sessionId,
      task: createTask(),
    });
    const workerSessionId = await waitForWorkerSessionId(workspaceRoot);

    await broker.cancelWorkerSession(workerSessionId, "Cancelled during test.");
    const result = await pending;

    expect(result.error?.errorType).toBe("worker_interrupted");
    const workerMeta = await sessionStore.loadWorkerSession(workerSessionId);
    expect(workerMeta?.status).toBe("cancelled");
  });
});
