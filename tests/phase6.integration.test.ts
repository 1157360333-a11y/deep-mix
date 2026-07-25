import { promises as fs } from "node:fs";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { GovernorRuntime } from "../packages/core-governor/src/index.js";
import { McpRegistry } from "../packages/mcp-hub/src/index.js";
import { SessionStore } from "../packages/persistence/src/index.js";
import { SpecialistBroker } from "../packages/specialist-broker/src/index.js";
import type {
  AssistantResponse,
  ModelCompletionRequest,
  StreamCallbacks,
  WorkflowRunResult,
} from "../packages/shared-schema/src/index.js";
import { PermissionRequiredError, ToolRuntime } from "../packages/tool-runtime/src/index.js";
import type { CodingWorkerRunner, GlmCodingWorkerExecutionResult } from "../packages/worker-glm-coding/src/index.js";

class ScriptedModelClient {
  private index = 0;

  public requests: ModelCompletionRequest[] = [];

  public constructor(private readonly responses: AssistantResponse[]) {}

  public async streamCompletion(
    request: ModelCompletionRequest,
    callbacks?: StreamCallbacks,
  ): Promise<AssistantResponse> {
    this.requests.push(request);
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
const servers: http.Server[] = [];

async function createFixtureWorkspace(): Promise<string> {
  const workspaceRoot = await fs.mkdtemp(path.join(os.tmpdir(), "deep-mix-phase6-"));
  temporaryRoots.push(workspaceRoot);

  await fs.mkdir(path.join(workspaceRoot, "src"), { recursive: true });
  await fs.mkdir(path.join(workspaceRoot, ".deep-mix", "api-key-library"), { recursive: true });

  await fs.writeFile(
    path.join(workspaceRoot, "src", "script.ts"),
    ["export function addOne(value: number) {", "  return value + 1;", "}", ""].join("\n"),
    "utf8",
  );

  await fs.writeFile(
    path.join(workspaceRoot, "AGENTS.md"),
    "# Fixture Rules\n\nUse this file only for repository rules.\n",
    "utf8",
  );

  await fs.writeFile(
    path.join(workspaceRoot, ".deep-mix", "api-key-library", "profiles.local.json"),
    JSON.stringify(
      {
        version: 1,
        profiles: {
          deepseek_governor: {
            provider: "deepseek",
            role: "governor",
            apiKey: "fake-local-key",
            baseUrl: "https://example.invalid",
            chatPath: "/chat/completions",
            model: "deepseek-chat",
            headers: {
              "Content-Type": "application/json",
            },
            requestDefaults: {},
          },
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

  return workspaceRoot;
}

function createCodingWorkerResult(): GlmCodingWorkerExecutionResult {
  return {
    artifact: {
      summary: "Updated the script helper through the workflow worker step.",
      changedFiles: ["src/script.ts"],
      testCommands: [],
      risks: [],
      confidence: 0.88,
      notes: ["Worker stayed artifact-only."],
      metadata: {
        source: "workflow-test",
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
    rawResponse: "<code_artifact />",
  };
}

async function startLocalServer(): Promise<{ server: http.Server; baseUrl: string }> {
  const server = http.createServer((request, response) => {
    const url = new URL(request.url ?? "/", "http://127.0.0.1");

    if (url.pathname === "/search/repositories") {
      response.writeHead(200, { "Content-Type": "application/json" });
      response.end(
        JSON.stringify({
          total_count: 1,
          items: [
            {
              full_name: "deep-mix/example",
              html_url: "https://example.com/deep-mix/example",
              description: "Example Deep-Mix repository",
            },
          ],
        }),
      );
      return;
    }

    if (url.pathname === "/repos/test/demo/pulls/7") {
      response.writeHead(200, { "Content-Type": "application/json" });
      response.end(
        JSON.stringify({
          title: "Phase 6 MCP integration",
          state: "open",
          html_url: "https://example.com/test/demo/pull/7",
          user: { login: "tester" },
          body: `${"P".repeat(320)}MCP_BODY_TAIL_SENTINEL`,
        }),
      );
      return;
    }

    if (url.pathname === "/page") {
      response.writeHead(200, { "Content-Type": "text/html; charset=utf-8" });
      response.end(`
        <html>
          <head><title>Deep Mix Test Page</title></head>
          <body>
            <main>
              <h1>Phase 6 MCP Screenshot Fixture</h1>
              <p>This page is served locally for screenshot capture.</p>
            </main>
          </body>
        </html>
      `);
      return;
    }

    response.writeHead(404, { "Content-Type": "text/plain" });
    response.end("not found");
  });

  servers.push(server);
  await new Promise<void>((resolve) => {
    server.listen(0, "127.0.0.1", () => resolve());
  });
  const address = server.address();
  if (!address || typeof address === "string") {
    throw new Error("Failed to bind local test server.");
  }

  return {
    server,
    baseUrl: `http://127.0.0.1:${address.port}`,
  };
}

async function writeWorkflow(workspaceRoot: string, name: string, payload: unknown): Promise<void> {
  const workflowsDir = path.join(workspaceRoot, ".deep-mix", "workflows");
  await fs.mkdir(workflowsDir, { recursive: true });
  await fs.writeFile(path.join(workflowsDir, `${name}.workflow.json`), JSON.stringify(payload, null, 2), "utf8");
}

afterEach(async () => {
  await Promise.all(
    temporaryRoots.splice(0).map(async (root) => {
      await fs.rm(root, { recursive: true, force: true });
    }),
  );

  await Promise.all(
    servers.splice(0).map(
      (server) =>
        new Promise<void>((resolve) => {
          server.close(() => resolve());
        }),
    ),
  );
});

describe("phase 6 skills, workflows, and mcp", () => {
  it("discovers project skills by priority, respects enable flags, and injects matched skill content", async () => {
    const workspaceRoot = await createFixtureWorkspace();

    await fs.mkdir(path.join(workspaceRoot, ".deep-mix", "skills", "release-check"), { recursive: true });
    await fs.mkdir(path.join(workspaceRoot, ".agents", "skills", "release-check"), { recursive: true });
    await fs.mkdir(path.join(workspaceRoot, ".deep-mix", "skills", "manual-only"), { recursive: true });

    await fs.writeFile(
      path.join(workspaceRoot, ".deep-mix", "skills", "release-check", "SKILL.md"),
      [
        "---",
        "name: release-check",
        "description: Prepare and verify a release. Use when the user asks to release, publish, or run pre-release checks.",
        "---",
        "",
        "# Release Check",
        "",
        "Project release check from high priority.",
      ].join("\n"),
      "utf8",
    );
    await fs.writeFile(
      path.join(workspaceRoot, ".agents", "skills", "release-check", "SKILL.md"),
      [
        "---",
        "name: release-check",
        "description: Compatibility fallback skill.",
        "---",
        "",
        "Compatibility release check that should be shadowed.",
      ].join("\n"),
      "utf8",
    );
    await fs.writeFile(
      path.join(workspaceRoot, ".deep-mix", "skills", "manual-only", "SKILL.md"),
      [
        "---",
        "name: manual-only",
        "description: Manual-only skill.",
        "metadata:",
        "  allow-implicit-invocation: false",
        "---",
        "",
        "# Manual Only",
      ].join("\n"),
      "utf8",
    );
    await fs.writeFile(
      path.join(workspaceRoot, ".deep-mix", "settings.json"),
      JSON.stringify(
        {
          enabledSkills: {
            "manual-only": false,
          },
        },
        null,
        2,
      ),
      "utf8",
    );

    const modelClient = new ScriptedModelClient([
      {
        content: "release flow complete",
        toolCalls: [],
      },
    ]);
    const runtime = new GovernorRuntime({
      workspaceRoot,
      permissionMode: "danger-full-access",
      modelClient,
    });

    const skills = await runtime.listSkills();
    expect(skills.find((skill) => skill.name === "release-check")?.sourceScope).toBe("project");
    expect(skills.find((skill) => skill.name === "manual-only")?.enabled).toBe(false);

    const result = await runtime.runTurn({
      prompt: "Please prepare a release and publish checklist before we ship.",
    });

    expect(result.finalResponse).toBe("release flow complete");
    const turnContext = modelClient.requests[0]?.messages
      .filter((message) => message.role === "system")
      .map((message) => message.content ?? "")
      .join("\n") ?? "";
    expect(turnContext).toContain("### release-check");
    expect(turnContext).toContain("Project release check from high priority.");
    expect(turnContext).not.toContain("Compatibility release check that should be shadowed.");
  });

  it("runs a newly added workflow with governor, tool, and worker steps without changing core runtime", async () => {
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

    await writeWorkflow(workspaceRoot, "phase6-smoke", {
      name: "phase6-smoke",
      description: "Governor, tool, and worker smoke test.",
      steps: [
        {
          id: "governor-note",
          type: "governor",
          action: "record_message",
          message: "workflow-started",
        },
        {
          id: "read-script",
          type: "tool",
          toolName: "read_file",
          arguments: {
            path: "src/script.ts",
          },
        },
        {
          id: "coding-worker",
          type: "worker",
          workerType: "coding",
          input: {
            workerType: "coding",
            objective: "Adjust the script helper.",
            constraints: ["Do not change deployment config."],
            contextRefs: ["file://src/script.ts"],
            expectedOutput: "code_artifact",
            acceptanceChecks: ["Return a valid CodeArtifact summary."],
          },
        },
      ],
    });

    const runtime = new GovernorRuntime({
      workspaceRoot,
      permissionMode: "danger-full-access",
      specialistBroker: broker,
      modelClient: new ScriptedModelClient([
        {
          content: "unused",
          toolCalls: [],
        },
      ]),
    });

    const workflowResult = (await runtime.runWorkflow({
      name: "phase6-smoke",
    })) as WorkflowRunResult;

    expect(workflowResult.runId).toBeTruthy();
    expect(workflowResult.success).toBe(true);
    expect(workflowResult.stepResults).toHaveLength(3);
    expect(workflowResult.stepResults.every((step) => step.success)).toBe(true);
    expect(workflowResult.stepResults[1]?.output).toContain("export function addOne");
    expect(String(workflowResult.stepResults[2]?.output)).toContain("Updated the script helper through the workflow worker step.");
  });

  it("continues after a configured workflow step failure and preserves later steps", async () => {
    const workspaceRoot = await createFixtureWorkspace();
    const runtime = new GovernorRuntime({
      workspaceRoot,
      permissionMode: "danger-full-access",
      modelClient: new ScriptedModelClient([
        {
          content: "unused",
          toolCalls: [],
        },
      ]),
    });

    await writeWorkflow(workspaceRoot, "phase6-continue", {
      name: "phase6-continue",
      description: "Continue after failure.",
      steps: [
        {
          id: "missing-file",
          type: "tool",
          toolName: "read_file",
          arguments: {
            path: "src/does-not-exist.ts",
          },
          onError: "continue",
        },
        {
          id: "after-failure",
          type: "governor",
          action: "record_message",
          message: "workflow-continued",
        },
      ],
    });

    const result = await runtime.runWorkflow({ name: "phase6-continue" });

    expect(result.success).toBe(false);
    expect(result.stepResults[0]?.continuedAfterError).toBe(true);
    expect(result.stepResults[1]?.success).toBe(true);
  });

  it("connects GitHub and Playwright MCP servers, injects tools on demand, and keeps MCP under the permission layer", async () => {
    const workspaceRoot = await createFixtureWorkspace();
    const { baseUrl } = await startLocalServer();

    await fs.mkdir(path.join(workspaceRoot, ".deep-mix", "mcp"), { recursive: true });
    await fs.writeFile(
      path.join(workspaceRoot, ".deep-mix", "mcp", "servers.json"),
      JSON.stringify(
        {
          version: 1,
          servers: [
            {
              name: "github",
              type: "github",
              enabled: true,
              toolSelection: {
                keywords: ["github", "repo", "pull request"],
              },
              options: {
                apiBaseUrl: baseUrl,
                userAgent: "Deep-Mix-Test",
              },
            },
            {
              name: "playwright",
              type: "playwright",
              enabled: true,
              toolSelection: {
                keywords: ["browser", "page", "screenshot", "capture"],
              },
              options: {
                screenshotDir: ".deep-mix/mcp-artifacts/playwright",
                preferSyntheticCapture: true,
              },
            },
          ],
        },
        null,
        2,
      ),
      "utf8",
    );

    const registry = new McpRegistry(workspaceRoot);
    await registry.initialize();

    const sessionStore = new SessionStore(workspaceRoot);
    await sessionStore.ensureInitialized();

    const permissiveRuntime = new ToolRuntime({
      workspaceRoot,
      sessionStore,
      permissionMode: "danger-full-access",
      mcpRegistry: registry,
    });
    const session = await sessionStore.createSession("phase6 mcp");

    const githubPromptTools = permissiveRuntime.listToolDefinitions({
      prompt: "Search a GitHub pull request and repository.",
    });
    expect(githubPromptTools.some((tool) => tool.name === "mcp_github_search_repositories")).toBe(true);
    expect(githubPromptTools.some((tool) => tool.name === "mcp_playwright_capture_screenshot")).toBe(false);

    const playwrightPromptTools = permissiveRuntime.listToolDefinitions({
      prompt: "Capture a browser screenshot for this website.",
    });
    expect(playwrightPromptTools.some((tool) => tool.name === "mcp_playwright_capture_screenshot")).toBe(true);

    const githubResult = await permissiveRuntime.executeManualTool(
      "mcp_github_search_repositories",
      {
        query: "deep mix",
      },
      session.sessionId,
    );
    expect(githubResult.success).toBe(true);
    expect(githubResult.output).toContain("deep-mix/example");

    const pullRequestResult = await permissiveRuntime.executeManualTool(
      "mcp_github_read_pull_request",
      { owner: "test", repo: "demo", number: 7 },
      session.sessionId,
    );
    expect(pullRequestResult.success).toBe(true);
    expect(pullRequestResult.output).toContain("MCP_BODY_TAIL_SENTINEL");

    const screenshotResult = await permissiveRuntime.executeManualTool(
      "mcp_playwright_capture_screenshot",
      {
        url: `${baseUrl}/page`,
        outputName: "phase6-shot",
      },
      session.sessionId,
    );
    expect(screenshotResult.success).toBe(true);
    const screenshotPath = String((screenshotResult.structuredContent as { filePath?: string }).filePath);
    expect(await fs.stat(screenshotPath)).toBeTruthy();

    const guardedRuntime = new ToolRuntime({
      workspaceRoot,
      sessionStore,
      permissionMode: "auto",
      mcpRegistry: registry,
    });
    const guardedSession = await sessionStore.createSession("phase6 guarded mcp");
    await expect(
      guardedRuntime.executeManualTool(
        "mcp_playwright_capture_screenshot",
        {
          url: `${baseUrl}/page`,
        },
        guardedSession.sessionId,
      ),
    ).rejects.toBeInstanceOf(PermissionRequiredError);
  }, 15000);

  it("keeps the main governor session usable when skill, workflow, or mcp loading fails", async () => {
    const workspaceRoot = await createFixtureWorkspace();

    await fs.mkdir(path.join(workspaceRoot, ".deep-mix", "mcp"), { recursive: true });
    await fs.writeFile(path.join(workspaceRoot, ".deep-mix", "mcp", "servers.json"), "{bad json", "utf8");
    await writeWorkflow(workspaceRoot, "broken", {
      name: "broken",
      description: "will be replaced by invalid json",
      steps: [],
    });
    await fs.writeFile(path.join(workspaceRoot, ".deep-mix", "workflows", "broken.workflow.json"), "{broken", "utf8");
    await fs.mkdir(path.join(workspaceRoot, ".deep-mix", "skills", "broken"), { recursive: true });
    await fs.writeFile(path.join(workspaceRoot, ".deep-mix", "skills", "broken", "SKILL.md"), "---\nname: broken\n---\n", "utf8");

    const modelClient = new ScriptedModelClient([
      {
        content: "base session still works",
        toolCalls: [],
      },
    ]);
    const runtime = new GovernorRuntime({
      workspaceRoot,
      permissionMode: "danger-full-access",
      modelClient,
    });

    const result = await runtime.runTurn({
      prompt: "Just answer directly without any extra tools.",
    });

    expect(result.finalResponse).toBe("base session still works");
    expect(modelClient.requests[0]?.messages.some((message) =>
      message.role === "system" && message.content?.includes("Extension Loader Errors"))).toBe(true);
  });
});
