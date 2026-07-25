import { spawnSync } from "node:child_process";
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { GovernorRuntime, PromptCompiler } from "../packages/core-governor/src/index.js";
import { SessionStore } from "../packages/persistence/src/index.js";
import type {
  AssistantResponse,
  ModelClient,
  ModelCompletionRequest,
  RuntimeCapabilitySnapshot,
  StreamCallbacks,
  ToolDefinition,
} from "../packages/shared-schema/src/index.js";
import { ToolRuntime } from "../packages/tool-runtime/src/index.js";
import { parseRipgrepSearchMatches } from "../packages/tool-runtime/src/built-ins/repository/helpers.js";

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
    for (const chunk of response.content) {
      callbacks?.onTextDelta?.(chunk);
    }
    return response;
  }
}

const temporaryRoots: string[] = [];

function getPathKey(env: NodeJS.ProcessEnv): string {
  return Object.keys(env).find((key) => key.toLowerCase() === "path") ?? "PATH";
}

function resolveExecutable(command: string): string {
  const locator = process.platform === "win32" ? "where.exe" : "which";
  const result = spawnSync(locator, [command], {
    encoding: "utf8",
    env: process.env,
  });
  const firstLine = result.stdout
    .split(/\r?\n/)
    .map((line) => line.trim())
    .find(Boolean);
  if (!firstLine) {
    throw new Error(`Could not resolve executable: ${command}`);
  }
  return firstLine;
}

function runGit(args: string[], cwd: string): void {
  const executable = process.platform === "win32" ? "git.exe" : "git";
  const result = spawnSync(executable, args, {
    cwd,
    encoding: "utf8",
    env: process.env,
  });
  if (result.status !== 0) {
    throw new Error(result.stderr || result.stdout || `git ${args.join(" ")} failed`);
  }
}

function buildMinimalRuntimeEnv(commands: string[]): NodeJS.ProcessEnv {
  const delimiter = process.platform === "win32" ? ";" : ":";
  const key = getPathKey(process.env);
  const directories = new Set(
    commands.map((command) => path.dirname(resolveExecutable(command))),
  );
  return {
    ...process.env,
    [key]: [...directories].join(delimiter),
  };
}

function buildEnvWithoutRg(): NodeJS.ProcessEnv {
  if (process.platform === "win32") {
    return buildMinimalRuntimeEnv(["git.exe", "powershell.exe", "node.exe", "npm.cmd"]);
  }
  return buildMinimalRuntimeEnv(["git", "node", "npm", "sh"]);
}

function buildEnvWithoutGit(): NodeJS.ProcessEnv {
  if (process.platform === "win32") {
    return buildMinimalRuntimeEnv(["powershell.exe", "node.exe", "npm.cmd"]);
  }
  return buildMinimalRuntimeEnv(["node", "npm", "sh"]);
}

async function createFixtureWorkspace(prefix: string): Promise<string> {
  const workspaceRoot = await fs.mkdtemp(path.join(os.tmpdir(), prefix));
  temporaryRoots.push(workspaceRoot);
  await fs.mkdir(path.join(workspaceRoot, "src"), { recursive: true });
  await fs.mkdir(path.join(workspaceRoot, "docs"), { recursive: true });
  await fs.mkdir(path.join(workspaceRoot, "node_modules", "ignored"), { recursive: true });
  await fs.mkdir(path.join(workspaceRoot, ".deep-mix", "skills"), { recursive: true });
  await fs.mkdir(path.join(workspaceRoot, ".deep-mix", "sessions"), { recursive: true });
  await fs.mkdir(path.join(workspaceRoot, ".deep-mix", "api-key-library"), { recursive: true });

  await fs.writeFile(
    path.join(workspaceRoot, "src", "routes.ts"),
    [
      "export function describeRoute() {",
      "  return 'health';",
      "}",
      "",
    ].join("\n"),
    "utf8",
  );
  await fs.writeFile(
    path.join(workspaceRoot, "src", "health.ts"),
    [
      "export function getHealthStatus() {",
      "  return 'ok';",
      "}",
      "",
    ].join("\n"),
    "utf8",
  );
  await fs.writeFile(path.join(workspaceRoot, "docs", "readme.md"), "# Repo\n", "utf8");
  await fs.writeFile(path.join(workspaceRoot, "node_modules", "ignored", "index.js"), "module.exports = 1;\n", "utf8");
  await fs.writeFile(path.join(workspaceRoot, ".deep-mix", "skills", "repo-skill.md"), "skill\n", "utf8");
  await fs.writeFile(path.join(workspaceRoot, ".deep-mix", "sessions", "noise.jsonl"), "{\"x\":1}\n", "utf8");
  await fs.writeFile(path.join(workspaceRoot, "binary.bin"), Buffer.from([0, 159, 0, 100]));

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

function createToolDefinition(name: string): ToolDefinition {
  return {
    name,
    description: `${name} test tool`,
    inputSchema: {
      type: "object",
      properties: {},
    },
    readOnly: true,
    permissionCategory: "read_only",
    sideEffectLevel: "none",
    timeoutCategory: "fast",
  };
}

afterEach(async () => {
  await Promise.all(
    temporaryRoots.splice(0).map(async (root) => {
      await fs.rm(root, { recursive: true, force: true });
    }),
  );
});

describe("phase 10 toolchain reliability and fallbacks", () => {
  it("detects startup capabilities, persists them, and activates the rg fallback state when rg is unavailable", async () => {
    const workspaceRoot = await createFixtureWorkspace("deep-mix-phase10-capabilities-");
    const sessionStore = new SessionStore(workspaceRoot);
    await sessionStore.ensureInitialized();
    const runtime = new ToolRuntime({
      workspaceRoot,
      sessionStore,
      permissionMode: "danger-full-access",
      environment: buildEnvWithoutRg(),
    });

    await runtime.initialize();

    const snapshot = await runtime.getCapabilitySnapshot();
    expect(snapshot.capabilities.rg.available).toBe(false);
    expect(snapshot.fallbacks.listFiles).toBe("node_fs");
    expect(snapshot.fallbacks.searchFiles).toBe("node_text");

    const persisted = await sessionStore.loadRuntimeCapabilities();
    expect(persisted?.capabilities.rg.available).toBe(false);
    expect(persisted?.fallbacks.searchFiles).toBe("node_text");
  });

  it("keeps list_files usable without rg by falling back to Node traversal and filtering noisy paths", async () => {
    const workspaceRoot = await createFixtureWorkspace("deep-mix-phase10-list-");
    const sessionStore = new SessionStore(workspaceRoot);
    await sessionStore.ensureInitialized();
    const session = await sessionStore.createSession("list files");
    const runtime = new ToolRuntime({
      workspaceRoot,
      sessionStore,
      permissionMode: "danger-full-access",
      environment: buildEnvWithoutRg(),
    });

    const result = await runtime.executeManualTool("list_files", { cwd: ".", maxResults: 200 }, session.sessionId);
    const structured = result.structuredContent as {
      strategy: string;
      fallbackUsed: boolean;
      files: string[];
    };

    expect(result.success).toBe(true);
    expect(structured.strategy).toBe("node_fs");
    expect(structured.fallbackUsed).toBe(true);
    expect(structured.files).toContain("src/routes.ts");
    expect(structured.files).toContain(".deep-mix/skills/repo-skill.md");
    expect(structured.files.some((entry) => entry.includes("node_modules"))).toBe(false);
    expect(structured.files.some((entry) => entry.includes(".deep-mix/sessions"))).toBe(false);
  });

  it("keeps search_files usable without rg by falling back to Node text search and skipping binary files", async () => {
    const workspaceRoot = await createFixtureWorkspace("deep-mix-phase10-search-");
    const sessionStore = new SessionStore(workspaceRoot);
    await sessionStore.ensureInitialized();
    const session = await sessionStore.createSession("search files");
    const runtime = new ToolRuntime({
      workspaceRoot,
      sessionStore,
      permissionMode: "danger-full-access",
      environment: buildEnvWithoutRg(),
    });

    const result = await runtime.executeManualTool(
      "search_files",
      {
        pattern: "describeRoute",
        cwd: ".",
      },
      session.sessionId,
    );
    const structured = result.structuredContent as {
      strategy: string;
      fallbackUsed: boolean;
      matches: Array<{ path: string; lineNumber: number }>;
      skippedBinaryFiles: number;
    };

    expect(result.success).toBe(true);
    expect(structured.strategy).toBe("node_text");
    expect(structured.fallbackUsed).toBe(true);
    expect(structured.matches[0]?.path).toBe("src/routes.ts");
    expect(structured.matches[0]?.lineNumber).toBe(1);
    expect(structured.skippedBinaryFiles).toBeGreaterThan(0);
  });

  it("matches basename globs at any depth and makes file-existence limits explicit", async () => {
    const workspaceRoot = await createFixtureWorkspace("deep-mix-phase10-filename-search-");
    await fs.mkdir(path.join(workspaceRoot, "static", "js"), { recursive: true });
    await fs.writeFile(path.join(workspaceRoot, "static", "js", "html-docx.js"), "first line\n", "utf8");
    await fs.writeFile(path.join(workspaceRoot, "static", "js", "theme-switcher.js"), "theme code\n", "utf8");

    const syntheticRgEvent = JSON.stringify({
      type: "match",
      data: {
        path: { text: "static/js/html-docx.js" },
        line_number: 1,
        lines: { text: "first line\n" },
        submatches: [{ match: { text: "" } }],
      },
    });
    expect(parseRipgrepSearchMatches(
      syntheticRgEvent,
      workspaceRoot,
      workspaceRoot,
      { glob: "html-docx*", maxResults: 10 },
    ).matches.map((match) => match.path)).toEqual(["static/js/html-docx.js"]);

    const sessionStore = new SessionStore(workspaceRoot);
    await sessionStore.ensureInitialized();
    const session = await sessionStore.createSession("filename search semantics");
    const runtime = new ToolRuntime({
      workspaceRoot,
      sessionStore,
      permissionMode: "danger-full-access",
      environment: buildEnvWithoutRg(),
    });
    const basenameSearch = await runtime.executeManualTool(
      "search_files",
      { cwd: ".", glob: "html-docx*", pattern: "^", maxResults: 10 },
      session.sessionId,
    );
    expect((basenameSearch.structuredContent as { matches: Array<{ path: string }> }).matches)
      .toContainEqual(expect.objectContaining({ path: "static/js/html-docx.js" }));
    expect(basenameSearch.output).toContain("searches text inside files, not file names");

    const noContentMatch = await runtime.executeManualTool(
      "search_files",
      { cwd: ".", glob: "theme-switcher*", pattern: "CONTENT_THAT_IS_NOT_PRESENT", maxResults: 10 },
      session.sessionId,
    );
    expect(noContentMatch.output).toContain("Zero content matches do not prove that a file path is absent");
    expect(noContentMatch.structuredContent).toMatchObject({
      queryKind: "file_content",
      pathExistenceEstablished: false,
    });

    const exactList = await runtime.executeManualTool(
      "list_files",
      { cwd: "static/js", maxDepth: 1, maxResults: 2 },
      session.sessionId,
    );
    expect(exactList.output).toContain("[list_files complete:");
    expect(exactList.structuredContent).toMatchObject({ truncated: false, resultComplete: true, returnedCount: 2 });
    expect(exactList.output).toContain("html-docx.js");
    expect(exactList.output).toContain("theme-switcher.js");

    await fs.writeFile(path.join(workspaceRoot, "static", "js", "z-extra.js"), "extra\n", "utf8");
    const truncatedList = await runtime.executeManualTool(
      "list_files",
      { cwd: "static/js", maxDepth: 1, maxResults: 2 },
      session.sessionId,
    );
    expect(truncatedList.output).toContain("[list_files truncated:");
    expect(truncatedList.output).toContain("Do not infer that an unlisted file is absent");
    expect(truncatedList.structuredContent).toMatchObject({ truncated: true, resultComplete: false, returnedCount: 2 });
  });

  it("uses high-completeness discovery defaults beyond the old result and depth cutoffs", async () => {
    const workspaceRoot = await createFixtureWorkspace("deep-mix-phase10-complete-discovery-");
    const bulkRoot = path.join(workspaceRoot, "bulk");
    await fs.mkdir(bulkRoot, { recursive: true });
    const shallowPaths = Array.from({ length: 501 }, (_, index) => `item-${String(index).padStart(3, "0")}.txt`);
    await Promise.all(shallowPaths.map((fileName) =>
      fs.writeFile(path.join(bulkRoot, fileName), `needle ${fileName}\n`, "utf8"),
    ));
    const deepSegments = Array.from({ length: 25 }, (_, index) => `d${String(index).padStart(2, "0")}`);
    const deepDirectory = path.join(bulkRoot, ...deepSegments);
    await fs.mkdir(deepDirectory, { recursive: true });
    await fs.writeFile(path.join(deepDirectory, "deep-tail.txt"), "needle deep tail\n", "utf8");

    const sessionStore = new SessionStore(workspaceRoot);
    await sessionStore.ensureInitialized();
    const session = await sessionStore.createSession("complete repository discovery defaults");
    const runtime = new ToolRuntime({
      workspaceRoot,
      sessionStore,
      permissionMode: "danger-full-access",
      environment: buildEnvWithoutRg(),
    });

    const search = await runtime.executeManualTool(
      "search_files",
      { cwd: "bulk", pattern: "needle" },
      session.sessionId,
    );
    const searchBody = search.structuredContent as { truncated: boolean; matches: Array<{ path: string }> };
    expect(searchBody.truncated).toBe(false);
    expect(searchBody.matches).toHaveLength(502);
    expect(searchBody.matches.some((match) => match.path.endsWith("deep-tail.txt"))).toBe(true);

    const glob = await runtime.executeManualTool(
      "glob_files",
      { cwd: "bulk", globs: ["**/*.txt"] },
      session.sessionId,
    );
    const globBody = glob.structuredContent as { truncation: { truncated: boolean }; files: string[] };
    expect(globBody.truncation.truncated).toBe(false);
    expect(globBody.files).toHaveLength(502);
    expect(globBody.files.some((filePath) => filePath.endsWith("deep-tail.txt"))).toBe(true);

    const listing = await runtime.executeManualTool(
      "list_files",
      { cwd: "bulk" },
      session.sessionId,
    );
    const listingBody = listing.structuredContent as { truncated: boolean; files: string[] };
    expect(listingBody.truncated).toBe(false);
    expect(listingBody.files).toHaveLength(502);
    expect(listingBody.files.some((filePath) => filePath.endsWith("deep-tail.txt"))).toBe(true);

    const many = await runtime.executeManualTool(
      "read_many_files",
      { cwd: "bulk", paths: shallowPaths.slice(0, 31) },
      session.sessionId,
    );
    const manyBody = many.structuredContent as {
      summary: { selectedCount: number; selectionTruncated: boolean };
      files: Array<{ success: boolean }>;
    };
    expect(manyBody.summary).toMatchObject({ selectedCount: 31, selectionTruncated: false });
    expect(manyBody.files).toHaveLength(31);
    expect(manyBody.files.every((file) => file.success)).toBe(true);
  });

  it("returns structured error classifications for invalid paths, missing dependencies, and timeouts", async () => {
    const workspaceRoot = await createFixtureWorkspace("deep-mix-phase10-errors-");
    const sessionStore = new SessionStore(workspaceRoot);
    await sessionStore.ensureInitialized();
    const session = await sessionStore.createSession("structured errors");

    const permissiveRuntime = new ToolRuntime({
      workspaceRoot,
      sessionStore,
      permissionMode: "danger-full-access",
    });
    const invalidPath = await permissiveRuntime.executeManualTool(
      "read_file",
      {
        path: "../outside.txt",
      },
      session.sessionId,
    );
    expect(invalidPath.success).toBe(false);
    expect((invalidPath.structuredContent as { error: { type: string } }).error.type).toBe("invalid_path");
    expect(JSON.parse(invalidPath.output)).toEqual(invalidPath.structuredContent);

    const noGitRuntime = new ToolRuntime({
      workspaceRoot,
      sessionStore,
      permissionMode: "danger-full-access",
      environment: buildEnvWithoutGit(),
    });
    const missingGit = await noGitRuntime.executeManualTool("git_status", {}, session.sessionId);
    expect(missingGit.success).toBe(false);
    expect((missingGit.structuredContent as { error: { type: string } }).error.type).toBe("missing_dependency");
    expect(JSON.parse(missingGit.output)).toEqual(missingGit.structuredContent);

    const timeoutResult = await permissiveRuntime.executeManualTool(
      "run_shell",
      {
        command: process.platform === "win32" ? "Start-Sleep -Seconds 2" : "sleep 2",
        timeoutMs: 1000,
      },
      session.sessionId,
    );
    expect(timeoutResult.success).toBe(false);
    expect((timeoutResult.structuredContent as { error: { type: string } }).error.type).toBe("timeout");
  });

  it("keeps git_status and git_diff stable with normalized Windows-style cwd inputs", async () => {
    const workspaceRoot = await createFixtureWorkspace("deep-mix-phase10-git-");
    runGit(["init"], workspaceRoot);
    runGit(["config", "user.name", "Deep Mix Test"], workspaceRoot);
    runGit(["config", "user.email", "deep-mix-test@example.invalid"], workspaceRoot);
    runGit(["add", "."], workspaceRoot);
    runGit(["commit", "-m", "initial"], workspaceRoot);

    await fs.writeFile(
      path.join(workspaceRoot, "src", "routes.ts"),
      [
        "export function describeRoute() {",
        "  return 'health-check';",
        "}",
        "",
      ].join("\n"),
      "utf8",
    );

    const sessionStore = new SessionStore(workspaceRoot);
    await sessionStore.ensureInitialized();
    const session = await sessionStore.createSession("git path normalization");
    const runtime = new ToolRuntime({
      workspaceRoot,
      sessionStore,
      permissionMode: "danger-full-access",
    });
    const cwdArg = process.platform === "win32" ? "src\\.." : "src/..";

    const statusResult = await runtime.executeManualTool("git_status", { cwd: cwdArg }, session.sessionId);
    const diffResult = await runtime.executeManualTool(
      "git_diff",
      { cwd: cwdArg, pathspec: "src/routes.ts" },
      session.sessionId,
    );

    expect(statusResult.success).toBe(true);
    expect(diffResult.success).toBe(true);
    expect((statusResult.structuredContent as { cwd: string }).cwd).toBe(".");
    expect((diffResult.structuredContent as { cwd: string }).cwd).toBe(".");
    expect(diffResult.output).toContain("health-check");
  });

  it("adds prompt guidance that keeps repository exploration on built-in tools before run_shell", async () => {
    const compiler = new PromptCompiler({
      model: "deepseek-chat",
      contextWindow: 128000,
      softLimitTokens: 96000,
      compactThresholdTokens: 84000,
      reserveOutputTokens: 8000,
      summaryMaxTokens: 2048,
      recentTailMaxTokens: 24000,
      legacyMaxMessages: 12,
      legacyMaxChars: 8000,
    });
    const snapshot: RuntimeCapabilitySnapshot = {
      checkedAt: "2026-07-09T00:00:00.000Z",
      capabilities: {
        rg: {
          name: "rg",
          available: false,
          command: "rg.exe",
          errorType: "missing_dependency",
          message: "missing",
        },
        git: {
          name: "git",
          available: true,
          command: "git.exe",
          version: "git version 2.49.0.windows.1",
          message: "available",
        },
        powershell: {
          name: "powershell",
          available: true,
          command: "powershell.exe",
          version: "5.1.26100.1",
          message: "available",
        },
        node: {
          name: "node",
          available: true,
          command: "node.exe",
          version: "v22.18.0",
          message: "available",
        },
        npm: {
          name: "npm",
          available: true,
          command: "npm.cmd",
          version: "10.9.3",
          message: "available",
        },
      },
      fallbacks: {
        listFiles: "node_fs",
        searchFiles: "node_text",
      },
    };

    const compiled = await compiler.compile({
      workspaceRoot: process.cwd(),
      currentUserRequest: "帮我分析当前仓库结构",
      planItems: [],
      toolDefinitions: [createToolDefinition("list_files"), createToolDefinition("search_files"), createToolDefinition("read_file")],
      recentMessages: [],
      runtimeCapabilities: snapshot,
    });

    expect(compiled.systemPrompt).toContain("use list_files, search_files, and read_file before run_shell");
    expect(compiled.systemPrompt).toContain("search_files searches text contents only; a zero-match search_files result never proves that a file path is absent");
    expect(compiled.systemPrompt).toContain("Never claim that a file is missing when a listing/search reports truncation");
    expect(compiled.systemPrompt).toContain("Only consider run_shell after the built-in read/search tools and their fallback chains have both failed.");
    expect(compiled.turnContext).toContain("fallbacks=list_files:node_fs, search_files:node_text");
  });

  it("stably analyzes repository structure without immediately escalating to run_shell when rg is unavailable", async () => {
    const workspaceRoot = await createFixtureWorkspace("deep-mix-phase10-governor-");
    const sessionStore = new SessionStore(workspaceRoot);
    await sessionStore.ensureInitialized();
    const runtime = new GovernorRuntime({
      workspaceRoot,
      permissionMode: "auto",
      environment: buildEnvWithoutRg(),
      modelClient: new ScriptedModelClient([
        {
          content: "",
          toolCalls: [
            {
              id: "tool-list",
              name: "list_files",
              rawArguments: JSON.stringify({ cwd: ".", maxResults: 100 }),
              arguments: { cwd: ".", maxResults: 100 },
            },
          ],
        },
        {
          content: "",
          toolCalls: [
            {
              id: "tool-read",
              name: "read_file",
              rawArguments: JSON.stringify({ path: "src/routes.ts" }),
              arguments: { path: "src/routes.ts" },
            },
          ],
        },
        {
          content: "仓库包含 src 与 docs，路由逻辑在 src/routes.ts，健康检查在 src/health.ts。",
          toolCalls: [],
        },
      ]),
    });

    const result = await runtime.runTurn({
      prompt: "帮我分析当前仓库结构",
    });

    expect(result.session.status).toBe("waiting_for_user");
    expect(result.finalResponse).toContain("src/routes.ts");

    const messages = await sessionStore.loadMessages(result.sessionId);
    const toolMessages = messages.filter((message) => message.role === "tool");
    expect(toolMessages.some((message) => message.name === "list_files")).toBe(true);
    expect(toolMessages.some((message) => message.name === "run_shell")).toBe(false);

    const events = await sessionStore.loadEvents(result.sessionId);
    const approvals = events.filter((event) => event.recordType === "approval");
    expect(approvals.some((event) => event.toolName === "run_shell")).toBe(false);
  });
});
