import { execFile } from "node:child_process";
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import { promisify } from "node:util";

import { afterEach, describe, expect, it, vi } from "vitest";

import { SessionStore } from "../packages/persistence/src/index.js";
import { SpecialistBroker } from "../packages/specialist-broker/src/index.js";
import type {
  ApprovalRecord,
  GitOperationResult,
  PermissionMode,
  ToolDefinition,
  ToolResult,
} from "../packages/shared-schema/src/index.js";
import {
  PermissionRequiredError,
  ToolRuntime,
} from "../packages/tool-runtime/src/index.js";
import { buildGitCommand } from "../packages/tool-runtime/src/built-ins/git/command-builder.js";

const execFileAsync = promisify(execFile);
const temporaryRoots: string[] = [];
const disposables: Array<{ dispose(): Promise<void> }> = [];

// A single phase-18 tool call intentionally performs several independent Git
// preflight probes. Windows process-tree cleanup makes that safety work slower
// than the repository-wide 30 second default, so this file uses a bounded but
// realistic integration timeout instead of weakening those probes.
vi.setConfig({ testTimeout: 180_000, hookTimeout: 180_000 });

const PHASE18_TOOL_NAMES = [
  "git_history",
  "git_branch",
  "git_worktree",
  "git_stage",
  "git_commit",
  "git_restore",
  "git_integrate",
] as const;

const FROZEN_CORE_TOOL_NAMES = [
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

interface GitFixture {
  root: string;
  repoRoot: string;
  repoCwd: string;
  worktreesRoot: string;
  sessionStore: SessionStore;
  sessionId: string;
}

interface GitCommandResult {
  stdout: string;
  stderr: string;
}

function fixtureGitEnvironment(): NodeJS.ProcessEnv {
  return {
    ...process.env,
    GIT_CONFIG_NOSYSTEM: "1",
    GIT_CONFIG_GLOBAL: process.platform === "win32" ? "NUL" : "/dev/null",
    GIT_TERMINAL_PROMPT: "0",
    GCM_INTERACTIVE: "Never",
    LANG: "C",
    LC_ALL: "C",
  };
}

async function runGit(
  cwd: string,
  args: string[],
): Promise<GitCommandResult> {
  const result = await execFileAsync("git", args, {
    cwd,
    encoding: "utf8",
    env: fixtureGitEnvironment(),
    windowsHide: true,
    maxBuffer: 10 * 1024 * 1024,
  });
  return {
    stdout: result.stdout.trimEnd(),
    stderr: result.stderr.trimEnd(),
  };
}

async function createGitFixture(options: {
  initialCommit?: boolean;
  repositoryName?: string;
} = {}): Promise<GitFixture> {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "deep-mix-phase18-"));
  temporaryRoots.push(root);
  const repositoryName = options.repositoryName ?? "repo with spaces";
  const repoRoot = path.join(root, repositoryName);
  const repoCwd = repositoryName.replace(/\\/gu, "/");
  const worktreesRoot = path.join(root, "worktrees");
  await fs.mkdir(repoRoot, { recursive: true });
  await fs.mkdir(worktreesRoot, { recursive: true });
  await runGit(repoRoot, ["init"]);
  await runGit(repoRoot, ["symbolic-ref", "HEAD", "refs/heads/main"]);
  await runGit(repoRoot, ["config", "user.name", "Deep Mix Phase18"]);
  await runGit(repoRoot, ["config", "user.email", "phase18@example.invalid"]);
  await runGit(repoRoot, ["config", "commit.gpgsign", "false"]);
  await runGit(repoRoot, ["config", "core.autocrlf", "false"]);
  await runGit(repoRoot, ["config", "core.filemode", "false"]);

  await fs.mkdir(path.join(repoRoot, "src"), { recursive: true });
  await fs.writeFile(path.join(repoRoot, ".gitignore"), "*.runtime-ignore\n", "utf8");
  await fs.writeFile(path.join(repoRoot, "tracked.txt"), "base line\n", "utf8");
  await fs.writeFile(path.join(repoRoot, "other.txt"), "other base\n", "utf8");
  await fs.writeFile(path.join(repoRoot, "src", "routes.ts"), "export const route = 'base';\n", "utf8");
  if (options.initialCommit !== false) {
    await runGit(repoRoot, ["add", "--", ".gitignore", "tracked.txt", "other.txt", "src/routes.ts"]);
    await runGit(repoRoot, ["commit", "-m", "initial fixture"]);
  }

  const sessionStore = new SessionStore(root);
  await sessionStore.ensureInitialized();
  const session = await sessionStore.createSession("phase 18 integration");
  return {
    root,
    repoRoot,
    repoCwd,
    worktreesRoot,
    sessionStore,
    sessionId: session.sessionId,
  };
}

async function createExternalMetadataFixture(): Promise<{ fixture: GitFixture; externalRoot: string }> {
  const externalRoot = await fs.mkdtemp(path.join(os.tmpdir(), "deep-mix-phase18-external-origin-"));
  const workspaceRoot = await fs.mkdtemp(path.join(os.tmpdir(), "deep-mix-phase18-external-workspace-"));
  temporaryRoots.push(workspaceRoot, externalRoot);
  await runGit(externalRoot, ["init"]);
  await runGit(externalRoot, ["symbolic-ref", "HEAD", "refs/heads/main"]);
  await runGit(externalRoot, ["config", "user.name", "Deep Mix Phase18"]);
  await runGit(externalRoot, ["config", "user.email", "phase18@example.invalid"]);
  await runGit(externalRoot, ["config", "commit.gpgsign", "false"]);
  await fs.writeFile(path.join(externalRoot, "tracked.txt"), "external base\n", "utf8");
  await runGit(externalRoot, ["add", "--", "tracked.txt"]);
  await runGit(externalRoot, ["commit", "-m", "external initial"]);
  const linkedRoot = path.join(workspaceRoot, "linked worktree");
  await runGit(externalRoot, ["worktree", "add", "-b", "linked-topic", linkedRoot, "main"]);
  const sessionStore = new SessionStore(workspaceRoot);
  await sessionStore.ensureInitialized();
  const session = await sessionStore.createSession("phase 18 external metadata boundary");
  return {
    externalRoot,
    fixture: {
      root: workspaceRoot,
      repoRoot: linkedRoot,
      repoCwd: "linked worktree",
      worktreesRoot: path.join(workspaceRoot, "worktrees"),
      sessionStore,
      sessionId: session.sessionId,
    },
  };
}

function createRuntime(
  fixture: GitFixture,
  permissionMode: PermissionMode = "danger-full-access",
  environmentOverrides: NodeJS.ProcessEnv = {},
  protectedBranches: string[] = ["main", "master"],
  worktreeRoots: string[] | null = ["worktrees"],
): ToolRuntime {
  const runtime = new ToolRuntime({
    workspaceRoot: fixture.root,
    sessionStore: fixture.sessionStore,
    permissionMode,
    environment: { ...fixtureGitEnvironment(), ...environmentOverrides },
    specialistBroker: new SpecialistBroker({
      workspaceRoot: fixture.root,
      sessionStore: fixture.sessionStore,
    }),
    settings: {
      version: 1,
      git: {
        protectedBranches,
        ...(worktreeRoots === null ? {} : { worktreeRoots }),
      },
    },
  });
  disposables.push(runtime);
  return runtime;
}

async function commitFile(
  fixture: GitFixture,
  relativePath: string,
  content: string,
  subject: string,
): Promise<string> {
  const absolutePath = path.join(fixture.repoRoot, relativePath);
  await fs.mkdir(path.dirname(absolutePath), { recursive: true });
  await fs.writeFile(absolutePath, content, "utf8");
  await runGit(fixture.repoRoot, ["add", "--", relativePath]);
  await runGit(fixture.repoRoot, ["commit", "-m", subject]);
  return (await runGit(fixture.repoRoot, ["rev-parse", "HEAD"])).stdout;
}

function operation(result: ToolResult): GitOperationResult {
  const body = result.structuredContent as GitOperationResult;
  expect(body).toMatchObject({
    kind: "git_operation",
    toolName: result.toolName,
  });
  expect(body.durationMs).toBeGreaterThanOrEqual(0);
  expect(Array.isArray(body.changedPaths)).toBe(true);
  expect(body.repository).toMatchObject({
    conflict: expect.objectContaining({ files: expect.any(Array), nextSteps: expect.any(Array) }),
  });
  return body;
}

async function pendingApproval(
  promise: Promise<ToolResult>,
): Promise<ApprovalRecord> {
  try {
    await promise;
  } catch (error) {
    expect(error).toBeInstanceOf(PermissionRequiredError);
    if (!(error instanceof PermissionRequiredError) || !error.approvalRecord) {
      throw new Error("Expected PermissionRequiredError with a persisted approval record.");
    }
    expect(error.approvalRecord).toMatchObject({
      status: "pending",
      decision: "ask",
      callId: expect.any(String),
      presentation: {
        summary: expect.any(String),
        argumentSummary: expect.any(Object),
      },
    });
    return error.approvalRecord;
  }
  throw new Error("Expected the Git write call to stop for approval.");
}

function schemaProperties(definition: ToolDefinition): Record<string, Record<string, unknown>> {
  return (definition.inputSchema.properties ?? {}) as Record<string, Record<string, unknown>>;
}

function actionEnum(definition: ToolDefinition): string[] {
  const value = schemaProperties(definition).action?.enum;
  return Array.isArray(value) ? value.filter((entry): entry is string => typeof entry === "string") : [];
}

async function rawHead(repoRoot: string): Promise<string> {
  return (await runGit(repoRoot, ["rev-parse", "HEAD"])).stdout;
}

type IntegrationAction = "merge" | "rebase" | "cherry_pick" | "revert";

interface IntegrationRequest {
  action: IntegrationAction;
  target?: string;
  revisions?: string[];
}

async function runConfirmedIntegration(
  fixture: GitFixture,
  runtime: ToolRuntime,
  request: IntegrationRequest,
): Promise<{ result: ToolResult; body: GitOperationResult }> {
  const args = {
    cwd: fixture.repoCwd,
    action: request.action,
    mode: "start",
    ...(request.target === undefined ? {} : { target: request.target }),
    ...(request.revisions === undefined ? {} : { revisions: request.revisions }),
  };
  const preview = await runtime.executeManualTool("git_integrate", args, fixture.sessionId);
  expect(preview.success).toBe(true);
  const previewBody = operation(preview);
  expect(previewBody).toMatchObject({
    action: request.action,
    status: "preview",
    preview: { confirmationToken: expect.any(String) },
  });
  const result = await runtime.executeManualTool(
    "git_integrate",
    { ...args, confirmationToken: previewBody.preview!.confirmationToken },
    fixture.sessionId,
  );
  return { result, body: operation(result) };
}

afterEach(async () => {
  await Promise.allSettled(disposables.splice(0).reverse().map((value) => value.dispose()));
  for (const root of temporaryRoots.splice(0)) {
    if (!path.basename(root).startsWith("deep-mix-phase18-")) {
      throw new Error(`Refusing to remove a non-phase18 fixture root: ${root}`);
    }
    await fs.rm(root, {
      recursive: true,
      force: true,
      maxRetries: process.platform === "win32" ? 10 : 0,
      retryDelay: 100,
    });
  }
});

describe("phase 18 local Git tools", () => {
  it("registers the seven tools after the frozen core and exposes no destructive or remote contract", async () => {
    const fixture = await createGitFixture();
    const runtime = createRuntime(fixture);
    const definitions = runtime.listToolDefinitions();
    expect(definitions.slice(0, FROZEN_CORE_TOOL_NAMES.length).map((entry) => entry.name))
      .toEqual(FROZEN_CORE_TOOL_NAMES);

    const phaseDefinitions = new Map(
      definitions
        .filter((entry) => PHASE18_TOOL_NAMES.includes(entry.name as (typeof PHASE18_TOOL_NAMES)[number]))
        .map((entry) => [entry.name, entry]),
    );
    expect([...phaseDefinitions.keys()]).toEqual(PHASE18_TOOL_NAMES);
    expect(actionEnum(phaseDefinitions.get("git_history")!)).toEqual(["log", "show", "blame"]);
    expect(actionEnum(phaseDefinitions.get("git_branch")!)).toEqual(["list", "create", "switch", "delete"]);
    expect(actionEnum(phaseDefinitions.get("git_worktree")!)).toEqual(["list", "create", "remove"]);
    expect(actionEnum(phaseDefinitions.get("git_integrate")!)).toEqual([
      "merge",
      "rebase",
      "cherry_pick",
      "revert",
    ]);
    expect(schemaProperties(phaseDefinitions.get("git_integrate")!).mode?.enum).toEqual([
      "start",
      "continue",
      "abort",
    ]);

    const forbiddenFields = [
      "force",
      "push",
      "pull",
      "fetch",
      "remote",
      "reset",
      "clean",
      "amend",
      "noVerify",
    ];
    for (const definition of phaseDefinitions.values()) {
      expect(Object.keys(schemaProperties(definition))).not.toEqual(expect.arrayContaining(forbiddenFields));
    }

    const before = await rawHead(fixture.repoRoot);
    const invalid = await runtime.executeManualTool(
      "git_integrate",
      { action: "push", cwd: fixture.repoCwd, target: "origin/main" },
      fixture.sessionId,
    );
    expect(invalid.success).toBe(false);
    expect(invalid.structuredContent).toMatchObject({
      error: { type: "invalid_arguments" },
    });
    expect(await rawHead(fixture.repoRoot)).toBe(before);
  });

  it("rejects force, destructive, and remote Git commands at the shared command-builder boundary", async () => {
    const fixture = await createGitFixture();
    const forbiddenCommands = [
      ["push", "origin", "main"],
      ["pull", "origin", "main"],
      ["fetch", "origin"],
      ["remote", "-v"],
      ["reset", "--hard", "HEAD"],
      ["clean", "-fd"],
      ["checkout", "main"],
      ["branch", "-D", "topic"],
      ["branch", "-fd", "topic"],
      ["branch", "-Dtopic"],
      ["branch", "--forc", "topic"],
      ["worktree", "remove", "--force", "worktrees/topic"],
      ["worktree", "prune"],
      ["apply", "--unsafe-paths", "-"],
      ["merge", "--force", "topic"],
      ["rebase", "--onto", "main", "topic"],
      ["rebase", "--autostash", "main"],
      ["commit", "--no-verify", "-m", "bypass hooks"],
      ["commit", "--amend", "-m", "rewrite history"],
    ] as const;

    for (const args of forbiddenCommands) {
      expect(() => buildGitCommand({
        executable: "git",
        args,
        cwd: fixture.repoRoot,
        purpose: "Phase 18 forbidden-command contract probe",
      })).toThrow();
    }

    const sanitized = buildGitCommand({
      executable: "git",
      args: ["status", "--short"],
      cwd: fixture.repoRoot,
      purpose: "Phase 18 Git environment routing guard",
      environment: {
        PATH: process.env.PATH,
        GIT_DIR: path.join(fixture.root, "outside.git"),
        git_index_file: path.join(fixture.root, "outside.index"),
      },
    });
    expect(sanitized.environment?.PATH).toBe(process.env.PATH);
    expect(Object.keys(sanitized.environment ?? {}).map((name) => name.toUpperCase()))
      .not.toEqual(expect.arrayContaining(["GIT_DIR", "GIT_INDEX_FILE"]));

    expect(await rawHead(fixture.repoRoot)).toBeTruthy();
    expect((await runGit(fixture.repoRoot, ["status", "--short"])).stdout).toBe("");
  });

  it("returns bounded history results together with staged, unstaged, and untracked snapshot state", async () => {
    const fixture = await createGitFixture();
    const runtime = createRuntime(fixture);
    const historyHead = await commitFile(
      fixture,
      "tracked.txt",
      "history marker\n",
      "phase18 history marker",
    );
    await fs.writeFile(path.join(fixture.repoRoot, "tracked.txt"), "staged marker\n", "utf8");
    await runGit(fixture.repoRoot, ["add", "--", "tracked.txt"]);
    await fs.writeFile(path.join(fixture.repoRoot, "other.txt"), "unstaged marker\n", "utf8");
    await fs.writeFile(path.join(fixture.repoRoot, "loose file.txt"), "untracked marker\n", "utf8");

    const log = await runtime.executeManualTool(
      "git_history",
      {
        action: "log",
        cwd: fixture.repoCwd,
        limit: 2,
        path: "tracked.txt",
        author: "Deep Mix Phase18",
        since: "2000-01-01T00:00:00Z",
        until: "2100-01-01T00:00:00Z",
        maxChars: 4096,
      },
      fixture.sessionId,
    );
    expect(log.success).toBe(true);
    const logBody = operation(log);
    expect(logBody).toMatchObject({ action: "log", status: "completed" });
    expect(logBody.repository).toMatchObject({
      repositoryState: "worktree",
      isRepository: true,
      isBare: false,
      dirty: true,
      head: { oid: historyHead, branch: "main", detached: false, unborn: false },
      conflict: { status: "none", files: [] },
    });
    expect(logBody.repository.staged.map((entry) => entry.path)).toContain("tracked.txt");
    expect(logBody.repository.unstaged.map((entry) => entry.path)).toContain("other.txt");
    expect(logBody.repository.untracked).toContain("loose file.txt");
    expect(log.output).toContain("phase18 history marker");

    const show = await runtime.executeManualTool(
      "git_history",
      { action: "show", cwd: fixture.repoCwd, revision: historyHead, mode: "diff", maxChars: 4096 },
      fixture.sessionId,
    );
    expect(show.success).toBe(true);
    expect(operation(show)).toMatchObject({ action: "show", status: "completed" });
    expect(show.output).toContain("history marker");

    const blame = await runtime.executeManualTool(
      "git_history",
      {
        action: "blame",
        cwd: fixture.repoCwd,
        path: "tracked.txt",
        revision: historyHead,
        startLine: 1,
        endLine: 1,
        maxChars: 4096,
      },
      fixture.sessionId,
    );
    expect(blame.success).toBe(true);
    expect(operation(blame)).toMatchObject({ action: "blame", status: "completed" });
    expect(blame.output).toContain("history marker");

    const missing = await runtime.executeManualTool(
      "git_history",
      { action: "show", cwd: fixture.repoCwd, revision: "missing-revision", mode: "summary" },
      fixture.sessionId,
    );
    expect(missing.success).toBe(false);
    expect(operation(missing)).toMatchObject({
      action: "show",
      status: "not_found",
      error: { type: "not_found" },
    });
  });

  it("reports no-repository, unborn branch, and detached HEAD states structurally", async () => {
    const unbornFixture = await createGitFixture({ initialCommit: false, repositoryName: "unborn repo" });
    const unbornRuntime = createRuntime(unbornFixture);
    const unborn = await unbornRuntime.executeManualTool(
      "git_branch",
      { action: "list", cwd: unbornFixture.repoCwd },
      unbornFixture.sessionId,
    );
    expect(unborn.success).toBe(true);
    expect(operation(unborn).repository).toMatchObject({
      isRepository: true,
      head: { branch: "main", unborn: true, detached: false },
    });

    const detachedFixture = await createGitFixture({ repositoryName: "detached repo" });
    await runGit(detachedFixture.repoRoot, ["checkout", "--detach", "HEAD"]);
    const detachedRuntime = createRuntime(detachedFixture);
    const detached = await detachedRuntime.executeManualTool(
      "git_branch",
      { action: "list", cwd: detachedFixture.repoCwd },
      detachedFixture.sessionId,
    );
    expect(detached.success).toBe(true);
    expect(operation(detached).repository.head).toMatchObject({ detached: true, unborn: false });

    const outsideRepository = await detachedRuntime.executeManualTool(
      "git_history",
      { action: "log", cwd: ".", limit: 1 },
      detachedFixture.sessionId,
    );
    expect(outsideRepository.success).toBe(false);
    expect(operation(outsideRepository).repository).toMatchObject({
      repositoryState: "not_repository",
      isRepository: false,
      isBare: false,
    });
  });

  it("reports bare repositories and submodules while refusing their mutation paths", async () => {
    const fixture = await createGitFixture();
    const runtime = createRuntime(fixture);

    const bareRoot = path.join(fixture.root, "bare repo.git");
    await runGit(fixture.root, ["init", "--bare", bareRoot]);
    const bareCwd = path.relative(fixture.root, bareRoot).replace(/\\/gu, "/");
    const bareList = await runtime.executeManualTool(
      "git_branch",
      { action: "list", cwd: bareCwd },
      fixture.sessionId,
    );
    expect(bareList.success).toBe(true);
    expect(operation(bareList).repository).toMatchObject({
      repositoryState: "bare",
      isRepository: true,
      isBare: true,
      isSubmodule: false,
    });
    const bareMutation = await runtime.executeManualTool(
      "git_branch",
      { action: "create", cwd: bareCwd, name: "not-created", startPoint: "HEAD" },
      fixture.sessionId,
    );
    expect(bareMutation.success).toBe(false);
    expect(operation(bareMutation)).toMatchObject({
      action: "create",
      status: "invalid_state",
      repository: { isBare: true },
    });

    const sourceRoot = path.join(fixture.root, "submodule source");
    await fs.mkdir(sourceRoot, { recursive: true });
    await runGit(sourceRoot, ["init"]);
    await runGit(sourceRoot, ["symbolic-ref", "HEAD", "refs/heads/main"]);
    await runGit(sourceRoot, ["config", "user.name", "Deep Mix Phase18"]);
    await runGit(sourceRoot, ["config", "user.email", "phase18@example.invalid"]);
    await fs.writeFile(path.join(sourceRoot, "child.txt"), "submodule base\n", "utf8");
    await runGit(sourceRoot, ["add", "--", "child.txt"]);
    await runGit(sourceRoot, ["commit", "-m", "submodule initial"]);
    await runGit(fixture.repoRoot, [
      "-c",
      "protocol.file.allow=always",
      "submodule",
      "add",
      sourceRoot,
      "modules/child",
    ]);
    const submoduleCwd = path.relative(fixture.root, path.join(fixture.repoRoot, "modules", "child"))
      .replace(/\\/gu, "/");
    const submoduleList = await runtime.executeManualTool(
      "git_branch",
      { action: "list", cwd: submoduleCwd },
      fixture.sessionId,
    );
    expect(submoduleList.success).toBe(true);
    expect(operation(submoduleList).repository).toMatchObject({
      repositoryState: "worktree",
      isRepository: true,
      isBare: false,
      isSubmodule: true,
      superprojectRoot: fixture.repoCwd,
    });
    const submoduleMutation = await runtime.executeManualTool(
      "git_branch",
      { action: "create", cwd: submoduleCwd, name: "not-created", startPoint: "HEAD" },
      fixture.sessionId,
    );
    expect(submoduleMutation.success).toBe(false);
    expect(operation(submoduleMutation)).toMatchObject({
      action: "create",
      status: "invalid_state",
      repository: { isSubmodule: true },
    });
  });

  it("fails closed when Git metadata resolves outside the workspace", async () => {
    const { fixture, externalRoot } = await createExternalMetadataFixture();
    const runtime = createRuntime(fixture);
    await fs.writeFile(path.join(fixture.repoRoot, "tracked.txt"), "external user edit\n", "utf8");
    const externalHeadBefore = await rawHead(externalRoot);
    const indexBefore = (await runGit(fixture.repoRoot, ["diff", "--cached", "--binary"])).stdout;

    const branch = await runtime.executeManualTool(
      "git_branch",
      { action: "create", cwd: fixture.repoCwd, name: "must-not-write-external", startPoint: "HEAD" },
      fixture.sessionId,
    );
    expect(branch.success).toBe(false);
    expect(operation(branch)).toMatchObject({
      action: "create",
      status: "protected",
      repository: { gitDirTrusted: false, commonDirTrusted: false, stateComplete: false },
    });

    const staged = await runtime.executeManualTool(
      "git_stage",
      { cwd: fixture.repoCwd, paths: ["tracked.txt"] },
      fixture.sessionId,
    );
    expect(staged.success).toBe(false);
    expect(operation(staged)).toMatchObject({
      action: "stage",
      status: "invalid_state",
      repository: { commonDirTrusted: false },
    });
    expect((await runGit(externalRoot, ["branch", "--list", "must-not-write-external"])).stdout).toBe("");
    expect(await rawHead(externalRoot)).toBe(externalHeadBefore);
    expect((await runGit(fixture.repoRoot, ["diff", "--cached", "--binary"])).stdout).toBe(indexBefore);
    expect(await fs.readFile(path.join(fixture.repoRoot, "tracked.txt"), "utf8")).toBe("external user edit\n");
  });

  it("treats a failed status probe as incomplete dirty state and refuses mutation", async () => {
    const fixture = await createGitFixture({ repositoryName: "corrupt index repo" });
    const runtime = createRuntime(fixture);
    await fs.writeFile(path.join(fixture.repoRoot, ".git", "index"), "not a valid Git index\n", "utf8");

    const created = await runtime.executeManualTool(
      "git_branch",
      { action: "create", cwd: fixture.repoCwd, name: "must-not-create", startPoint: "HEAD" },
      fixture.sessionId,
    );
    expect(created.success).toBe(false);
    expect(operation(created)).toMatchObject({
      action: "create",
      status: "invalid_state",
      repository: {
        dirty: true,
        stateComplete: false,
        stateFailures: expect.arrayContaining(["status_failed"]),
      },
    });
    expect((await runGit(fixture.repoRoot, ["show-ref", "--verify", "--quiet", "refs/heads/must-not-create"])
      .then(() => true, () => false))).toBe(false);
  });

  it("protects a dirty overlapping file during branch switch and still requires approval in auto mode", async () => {
    const fixture = await createGitFixture();
    await runGit(fixture.repoRoot, ["switch", "-c", "topic"]);
    await commitFile(fixture, "tracked.txt", "topic version\n", "topic version");
    await runGit(fixture.repoRoot, ["switch", "main"]);
    await fs.writeFile(path.join(fixture.repoRoot, "tracked.txt"), "local user edit\n", "utf8");
    const runtime = createRuntime(fixture);

    const switched = await runtime.executeManualTool(
      "git_branch",
      { action: "switch", cwd: fixture.repoCwd, name: "topic" },
      fixture.sessionId,
    );
    expect(switched.success).toBe(false);
    expect(operation(switched)).toMatchObject({
      action: "switch",
      status: "invalid_state",
      repository: { dirty: true, head: { branch: "main" } },
    });
    expect(await fs.readFile(path.join(fixture.repoRoot, "tracked.txt"), "utf8"))
      .toBe("local user edit\n");
    expect((await runGit(fixture.repoRoot, ["branch", "--show-current"])).stdout).toBe("main");

    const autoFixture = await createGitFixture({ repositoryName: "auto repo" });
    const autoRuntime = createRuntime(autoFixture, "auto");
    await expect(autoRuntime.executeManualTool(
      "git_branch",
      { action: "create", cwd: autoFixture.repoCwd, name: "approval-required", startPoint: "HEAD" },
      autoFixture.sessionId,
    )).rejects.toBeInstanceOf(PermissionRequiredError);
    expect((await runGit(autoFixture.repoRoot, ["branch", "--list", "approval-required"])).stdout).toBe("");
  });

  it("invalidates branch approval when the target ref moves without using force", async () => {
    const fixture = await createGitFixture({ repositoryName: "moving ref repo" });
    await runGit(fixture.repoRoot, ["branch", "topic", "HEAD"]);
    await runGit(fixture.repoRoot, ["switch", "-c", "new-target"]);
    await commitFile(fixture, "src/routes.ts", "export const route = 'new-target';\n", "new target commit");
    await runGit(fixture.repoRoot, ["switch", "main"]);
    const runtime = createRuntime(fixture, "auto");
    const args = { action: "switch" as const, cwd: fixture.repoCwd, name: "topic" };
    const pending = await pendingApproval(runtime.executeManualTool("git_branch", args, fixture.sessionId));

    await runGit(fixture.repoRoot, ["branch", "-d", "topic"]);
    await runGit(fixture.repoRoot, ["branch", "topic", "new-target"]);
    await runtime.resolveApproval({
      sessionId: fixture.sessionId,
      approvalId: pending.approvalId,
      toolName: pending.toolName,
      requestKey: pending.requestKey,
      persistence: "allow_once",
      reason: "Approve only the original immutable branch target.",
    });

    await expect(runtime.executeManualTool("git_branch", args, fixture.sessionId))
      .rejects.toBeInstanceOf(PermissionRequiredError);
    expect((await runGit(fixture.repoRoot, ["branch", "--show-current"])).stdout).toBe("main");
    expect(await fs.readFile(path.join(fixture.repoRoot, "src", "routes.ts"), "utf8"))
      .toBe("export const route = 'base';\n");
  });

  it("creates and safely deletes only an explicit merged local branch", async () => {
    const fixture = await createGitFixture();
    const runtime = createRuntime(fixture);
    const headBefore = await rawHead(fixture.repoRoot);

    const created = await runtime.executeManualTool(
      "git_branch",
      { action: "create", cwd: fixture.repoCwd, name: "temporary-topic", startPoint: "HEAD" },
      fixture.sessionId,
    );
    expect(created.success, created.output).toBe(true);
    expect(operation(created)).toMatchObject({
      action: "create",
      status: "completed",
      headBefore: { oid: headBefore, branch: "main" },
      headAfter: { oid: headBefore, branch: "main" },
      details: { branch: "temporary-topic", startPoint: "HEAD" },
    });
    expect((await runGit(fixture.repoRoot, ["branch", "--list", "temporary-topic"])).stdout)
      .toContain("temporary-topic");
    expect((await runGit(fixture.repoRoot, ["branch", "--show-current"])).stdout).toBe("main");

    const deleted = await runtime.executeManualTool(
      "git_branch",
      { action: "delete", cwd: fixture.repoCwd, name: "temporary-topic" },
      fixture.sessionId,
    );
    expect(deleted.success).toBe(true);
    expect(operation(deleted)).toMatchObject({
      action: "delete",
      status: "completed",
      headBefore: { oid: headBefore, branch: "main" },
      headAfter: { oid: headBefore, branch: "main" },
      details: { branch: "temporary-topic" },
    });
    expect((await runGit(fixture.repoRoot, ["branch", "--list", "temporary-topic"])).stdout).toBe("");
    expect(await rawHead(fixture.repoRoot)).toBe(headBefore);

    const protectedDeletion = await runtime.executeManualTool(
      "git_branch",
      { action: "delete", cwd: fixture.repoCwd, name: "main" },
      fixture.sessionId,
    );
    expect(protectedDeletion.success).toBe(false);
    expect(operation(protectedDeletion)).toMatchObject({
      action: "delete",
      status: "protected",
      repository: { protectedBranch: true, head: { branch: "main", oid: headBefore } },
      error: { type: "protected_branch" },
    });
    expect((await runGit(fixture.repoRoot, ["branch", "--show-current"])).stdout).toBe("main");
  });

  it("keeps main and master protected when local-change settings add only a custom branch", async () => {
    const fixture = await createGitFixture();
    const runtime = createRuntime(fixture, "danger-full-access", {}, ["release"]);
    await fs.writeFile(path.join(fixture.repoRoot, "tracked.txt"), "protected branch edit\n", "utf8");

    const staged = await runtime.executeManualTool(
      "git_stage",
      { cwd: fixture.repoCwd, paths: ["tracked.txt"] },
      fixture.sessionId,
    );
    expect(staged.success).toBe(true);
    expect(operation(staged)).toMatchObject({
      action: "stage",
      status: "completed",
      repository: { head: { branch: "main" }, protectedBranch: true },
    });
  });

  it("creates a bounded worktree but refuses to remove it when it contains user changes", async () => {
    const fixture = await createGitFixture();
    const runtime = createRuntime(fixture);
    const relativeWorktree = "worktrees/topic tree";
    const created = await runtime.executeManualTool(
      "git_worktree",
      {
        action: "create",
        cwd: fixture.repoCwd,
        path: relativeWorktree,
        branch: "worktree-topic",
        startPoint: "HEAD",
        createBranch: true,
      },
      fixture.sessionId,
    );
    expect(created.success).toBe(true);
    expect(operation(created)).toMatchObject({ action: "create", status: "completed" });
    const worktreePath = path.join(fixture.root, relativeWorktree);
    expect(await fs.readFile(path.join(worktreePath, "tracked.txt"), "utf8")).toBe("base line\n");

    const listed = await runtime.executeManualTool(
      "git_worktree",
      { action: "list", cwd: fixture.repoCwd },
      fixture.sessionId,
    );
    expect(listed.success).toBe(true);
    expect(operation(listed).repository.worktrees.some((entry) => entry.path.includes("topic tree")))
      .toBe(true);

    await fs.writeFile(path.join(worktreePath, "tracked.txt"), "dirty worktree edit\n", "utf8");
    const removed = await runtime.executeManualTool(
      "git_worktree",
      { action: "remove", cwd: fixture.repoCwd, path: relativeWorktree },
      fixture.sessionId,
    );
    expect(removed.success).toBe(false);
    expect(operation(removed)).toMatchObject({ action: "remove", status: "invalid_state" });
    expect(await fs.readFile(path.join(worktreePath, "tracked.txt"), "utf8"))
      .toBe("dirty worktree edit\n");

    await runGit(worktreePath, ["restore", "--source=HEAD", "--worktree", "--", "tracked.txt"]);
    const cleanRemoval = await runtime.executeManualTool(
      "git_worktree",
      { action: "remove", cwd: fixture.repoCwd, path: relativeWorktree },
      fixture.sessionId,
    );
    expect(cleanRemoval.success).toBe(true);
    expect(operation(cleanRemoval)).toMatchObject({
      action: "remove",
      status: "completed",
      details: { path: expect.stringContaining("topic tree") },
    });
    await expect(fs.access(worktreePath)).rejects.toThrow();

    const escaped = await runtime.executeManualTool(
      "git_worktree",
      {
        action: "create",
        cwd: fixture.repoCwd,
        path: "../phase18-escape",
        branch: "escape-topic",
        startPoint: "HEAD",
        createBranch: true,
      },
      fixture.sessionId,
    );
    expect(escaped.success).toBe(false);
    expect(escaped.structuredContent).toMatchObject({ error: expect.any(Object) });
  });

  it("uses the default managed worktree root when no custom root is configured", async () => {
    const fixture = await createGitFixture({ repositoryName: "default worktree root repo" });
    const runtime = createRuntime(fixture, "danger-full-access", {}, ["main", "master"], null);
    const relativePath = ".deep-mix/worktrees/default topic";
    const created = await runtime.executeManualTool(
      "git_worktree",
      {
        action: "create",
        cwd: fixture.repoCwd,
        path: relativePath,
        branch: "default-root-topic",
        startPoint: "HEAD",
        createBranch: true,
      },
      fixture.sessionId,
    );
    expect(created.success, created.output).toBe(true);
    expect(operation(created)).toMatchObject({ action: "create", status: "completed" });
    expect(await fs.readFile(path.join(fixture.root, relativePath, "tracked.txt"), "utf8")).toBe("base line\n");

    const removed = await runtime.executeManualTool(
      "git_worktree",
      { action: "remove", cwd: fixture.repoCwd, path: relativePath },
      fixture.sessionId,
    );
    expect(removed.success).toBe(true);
    await expect(fs.access(path.join(fixture.root, relativePath))).rejects.toThrow();
  });

  it("refuses to materialize or remove a worktree tree containing protected runtime paths", async () => {
    const fixture = await createGitFixture({ repositoryName: "protected worktree tree repo" });
    await runGit(fixture.repoRoot, ["switch", "-c", "protected-tree"]);
    const protectedRelative = ".deep-mix/checkpoints/sentinel.txt";
    await fs.mkdir(path.dirname(path.join(fixture.repoRoot, protectedRelative)), { recursive: true });
    await fs.writeFile(path.join(fixture.repoRoot, protectedRelative), "non-sensitive sentinel\n", "utf8");
    await runGit(fixture.repoRoot, ["add", "--", protectedRelative]);
    await runGit(fixture.repoRoot, ["commit", "-m", "protected tree fixture"]);
    await runGit(fixture.repoRoot, ["switch", "main"]);
    const runtime = createRuntime(fixture);
    const blockedPath = "worktrees/blocked protected tree";

    const blockedCreate = await runtime.executeManualTool(
      "git_worktree",
      {
        action: "create",
        cwd: fixture.repoCwd,
        path: blockedPath,
        branch: "must-not-materialize",
        startPoint: "protected-tree",
        createBranch: true,
      },
      fixture.sessionId,
    );
    expect(blockedCreate.success).toBe(false);
    expect(operation(blockedCreate)).toMatchObject({ action: "create", status: "protected" });
    await expect(fs.access(path.join(fixture.root, blockedPath))).rejects.toThrow();
    expect((await runGit(fixture.repoRoot, ["branch", "--list", "must-not-materialize"])).stdout).toBe("");

    const removablePath = path.join(fixture.worktreesRoot, "protected remove");
    await runGit(fixture.repoRoot, ["worktree", "add", removablePath, "protected-tree"]);
    const blockedRemove = await runtime.executeManualTool(
      "git_worktree",
      { action: "remove", cwd: fixture.repoCwd, path: "worktrees/protected remove" },
      fixture.sessionId,
    );
    expect(blockedRemove.success).toBe(false);
    expect(operation(blockedRemove)).toMatchObject({ action: "remove", status: "protected" });
    expect(await fs.access(path.join(removablePath, protectedRelative)).then(() => true, () => false)).toBe(true);
  });

  it("stages only explicit paths and commits through preview confirmation while preserving unrelated changes", async () => {
    const fixture = await createGitFixture();
    const runtime = createRuntime(fixture);
    await fs.writeFile(path.join(fixture.repoRoot, "tracked.txt"), "selected staged edit\n", "utf8");
    await fs.writeFile(path.join(fixture.repoRoot, "other.txt"), "unrelated unstaged edit\n", "utf8");
    await fs.writeFile(path.join(fixture.repoRoot, "loose file.txt"), "unrelated untracked edit\n", "utf8");

    const staged = await runtime.executeManualTool(
      "git_stage",
      { cwd: fixture.repoCwd, paths: ["tracked.txt"] },
      fixture.sessionId,
    );
    expect(staged.success).toBe(true);
    const stagedBody = operation(staged);
    expect(stagedBody).toMatchObject({ action: "stage", status: "completed" });
    expect(stagedBody.changedPaths).toContain("tracked.txt");
    expect(stagedBody.repository.staged.map((entry) => entry.path)).toContain("tracked.txt");
    expect(stagedBody.repository.unstaged.map((entry) => entry.path)).toContain("other.txt");
    expect(stagedBody.repository.untracked).toContain("loose file.txt");
    const porcelainAfterStage = (await runGit(fixture.repoRoot, ["status", "--short"])).stdout;
    expect(porcelainAfterStage).toContain("M  tracked.txt");
    expect(porcelainAfterStage).toContain(" M other.txt");
    expect(porcelainAfterStage).toContain("?? \"loose file.txt\"");

    const headBefore = await rawHead(fixture.repoRoot);
    const preview = await runtime.executeManualTool(
      "git_commit",
      { cwd: fixture.repoCwd, message: "commit selected path" },
      fixture.sessionId,
    );
    expect(preview.success).toBe(true);
    const previewBody = operation(preview);
    expect(previewBody).toMatchObject({
      action: "commit",
      status: "preview",
      preview: {
        confirmationToken: expect.any(String),
        stagedDiffSummary: expect.any(String),
        commitMessage: "commit selected path",
      },
    });
    expect(await rawHead(fixture.repoRoot)).toBe(headBefore);

    const committed = await runtime.executeManualTool(
      "git_commit",
      {
        cwd: fixture.repoCwd,
        message: "commit selected path",
        confirmationToken: previewBody.preview!.confirmationToken,
      },
      fixture.sessionId,
    );
    expect(committed.success).toBe(true);
    const committedBody = operation(committed);
    expect(committedBody).toMatchObject({ action: "commit", status: "completed" });
    expect(committedBody.headBefore?.oid).toBe(headBefore);
    expect(committedBody.headAfter?.oid).not.toBe(headBefore);
    expect((await runGit(fixture.repoRoot, ["log", "-1", "--pretty=%s"])).stdout)
      .toBe("commit selected path");
    const porcelainAfterCommit = (await runGit(fixture.repoRoot, ["status", "--short"])).stdout;
    expect(porcelainAfterCommit).not.toContain("tracked.txt");
    expect(porcelainAfterCommit).toContain(" M other.txt");
    expect(porcelainAfterCommit).toContain("?? \"loose file.txt\"");
    expect(await fs.readFile(path.join(fixture.repoRoot, "other.txt"), "utf8"))
      .toBe("unrelated unstaged edit\n");
  });

  it("applies an explicit path-bounded patch to the index without staging unrelated changes", async () => {
    const fixture = await createGitFixture();
    const runtime = createRuntime(fixture);
    await fs.writeFile(path.join(fixture.repoRoot, "tracked.txt"), "patch-selected edit\n", "utf8");
    await fs.writeFile(path.join(fixture.repoRoot, "other.txt"), "unrelated patch-era edit\n", "utf8");
    const patch = (await runGit(fixture.repoRoot, ["diff", "--", "tracked.txt"])).stdout;
    expect(patch).toContain("patch-selected edit");

    const staged = await runtime.executeManualTool(
      "git_stage",
      { cwd: fixture.repoCwd, paths: ["tracked.txt"], patch },
      fixture.sessionId,
    );
    expect(staged.success).toBe(true);
    expect(operation(staged)).toMatchObject({
      action: "stage",
      status: "completed",
      changedPaths: ["tracked.txt"],
      details: { patchApplied: true },
      repository: {
        staged: expect.arrayContaining([expect.objectContaining({ path: "tracked.txt" })]),
        unstaged: expect.arrayContaining([expect.objectContaining({ path: "other.txt" })]),
      },
    });
    expect((await runGit(fixture.repoRoot, ["diff", "--cached", "--name-only"])).stdout)
      .toBe("tracked.txt");
    expect((await runGit(fixture.repoRoot, ["diff", "--name-only"])).stdout)
      .toBe("other.txt");
    expect(await fs.readFile(path.join(fixture.repoRoot, "other.txt"), "utf8"))
      .toBe("unrelated patch-era edit\n");
  });

  it("rejects an undeclared traditional patch section after complete git-apply scope parsing", async () => {
    const fixture = await createGitFixture({ repositoryName: "complete patch scope repo" });
    const runtime = createRuntime(fixture);
    await fs.writeFile(path.join(fixture.repoRoot, "tracked.txt"), "declared patch edit\n", "utf8");
    await fs.writeFile(path.join(fixture.repoRoot, "other.txt"), "undeclared traditional edit\n", "utf8");
    const declaredPatch = (await runGit(fixture.repoRoot, ["diff", "--", "tracked.txt"])).stdout;
    const traditionalSection = (await runGit(fixture.repoRoot, ["diff", "--", "other.txt"]))
      .stdout
      .split(/\r?\n/gu)
      .filter((line) => !line.startsWith("diff --git ") && !line.startsWith("index "))
      .join("\n");

    const staged = await runtime.executeManualTool(
      "git_stage",
      { cwd: fixture.repoCwd, paths: ["tracked.txt"], patch: `${declaredPatch}\n${traditionalSection}\n` },
      fixture.sessionId,
    );
    expect(staged.success).toBe(false);
    expect(operation(staged)).toMatchObject({
      action: "stage",
      status: "invalid_state",
      changedPaths: [],
      error: { type: "invalid_arguments" },
    });
    expect((await runGit(fixture.repoRoot, ["diff", "--cached", "--name-only"])).stdout).toBe("");
  });

  it("blocks directory stage and restore scopes that include a protected runtime descendant", async () => {
    const fixture = await createGitFixture({ repositoryName: "protected pathspec repo" });
    const protectedRelative = "nested/.deep-mix/checkpoints/sentinel.txt";
    const allowedRelative = "nested/allowed.txt";
    await fs.mkdir(path.dirname(path.join(fixture.repoRoot, protectedRelative)), { recursive: true });
    await fs.writeFile(path.join(fixture.repoRoot, protectedRelative), "protected base\n", "utf8");
    await fs.writeFile(path.join(fixture.repoRoot, allowedRelative), "allowed base\n", "utf8");
    await runGit(fixture.repoRoot, ["add", "--", protectedRelative, allowedRelative]);
    await runGit(fixture.repoRoot, ["commit", "-m", "protected pathspec base"]);
    await fs.writeFile(path.join(fixture.repoRoot, protectedRelative), "protected user edit\n", "utf8");
    await fs.writeFile(path.join(fixture.repoRoot, allowedRelative), "allowed user edit\n", "utf8");
    const runtime = createRuntime(fixture);

    const staged = await runtime.executeManualTool(
      "git_stage",
      { cwd: fixture.repoCwd, paths: ["nested"] },
      fixture.sessionId,
    );
    expect(staged.success).toBe(false);
    expect(operation(staged)).toMatchObject({ action: "stage", status: "invalid_state", changedPaths: [] });
    expect((await runGit(fixture.repoRoot, ["diff", "--cached", "--name-only"])).stdout).toBe("");

    const checkpointsBefore = (await fixture.sessionStore.loadEvents(fixture.sessionId))
      .filter((event) => event.recordType === "checkpoint").length;
    const restored = await runtime.executeManualTool(
      "git_restore",
      { cwd: fixture.repoCwd, area: "worktree", source: "head", paths: ["nested"] },
      fixture.sessionId,
    );
    expect(restored.success).toBe(false);
    const checkpointsAfter = (await fixture.sessionStore.loadEvents(fixture.sessionId))
      .filter((event) => event.recordType === "checkpoint").length;
    expect(checkpointsAfter).toBe(checkpointsBefore);
    expect(await fs.readFile(path.join(fixture.repoRoot, protectedRelative), "utf8"))
      .toBe("protected user edit\n");
    expect(await fs.readFile(path.join(fixture.repoRoot, allowedRelative), "utf8"))
      .toBe("allowed user edit\n");
  });

  it("invalidates stage approval when dirty bytes change without changing the status shape", async () => {
    const fixture = await createGitFixture({ repositoryName: "content digest repo" });
    const runtime = createRuntime(fixture, "auto");
    const args = { cwd: fixture.repoCwd, paths: ["tracked.txt"] };
    await fs.writeFile(path.join(fixture.repoRoot, "tracked.txt"), "content one\n", "utf8");
    const pending = await pendingApproval(runtime.executeManualTool("git_stage", args, fixture.sessionId));
    await fs.writeFile(path.join(fixture.repoRoot, "tracked.txt"), "content two\n", "utf8");
    await runtime.resolveApproval({
      sessionId: fixture.sessionId,
      approvalId: pending.approvalId,
      toolName: pending.toolName,
      requestKey: pending.requestKey,
      persistence: "allow_once",
      reason: "Approve only the first dirty-byte fingerprint.",
    });

    await expect(runtime.executeManualTool("git_stage", args, fixture.sessionId))
      .rejects.toBeInstanceOf(PermissionRequiredError);
    expect((await runGit(fixture.repoRoot, ["diff", "--cached", "--name-only"])).stdout).toBe("");
    expect(await fs.readFile(path.join(fixture.repoRoot, "tracked.txt"), "utf8")).toBe("content two\n");
  });

  it("refuses an empty commit and active hooks before they can change the confirmed staged scope", async () => {
    const fixture = await createGitFixture();
    const runtime = createRuntime(fixture);

    const empty = await runtime.executeManualTool(
      "git_commit",
      { cwd: fixture.repoCwd, message: "must not create an empty commit" },
      fixture.sessionId,
    );
    expect(empty.success).toBe(false);
    expect(operation(empty)).toMatchObject({
      action: "commit",
      status: "invalid_state",
      changedPaths: [],
      error: { type: "invalid_state" },
    });

    await fs.writeFile(path.join(fixture.repoRoot, "tracked.txt"), "hook-blocked staged edit\n", "utf8");
    const staged = await runtime.executeManualTool(
      "git_stage",
      { cwd: fixture.repoCwd, paths: ["tracked.txt"] },
      fixture.sessionId,
    );
    expect(staged.success).toBe(true);
    const hookPath = path.join(fixture.repoRoot, ".git", "hooks", "pre-commit");
    await fs.writeFile(
      hookPath,
      "#!/bin/sh\necho \"hook changed unrelated content\" > other.txt\ngit add -- other.txt\nexit 0\n",
      "utf8",
    );
    await fs.chmod(hookPath, 0o755);
    const headBefore = await rawHead(fixture.repoRoot);

    const refused = await runtime.executeManualTool(
      "git_commit",
      { cwd: fixture.repoCwd, message: "active hook must be refused" },
      fixture.sessionId,
    );
    expect(refused.success).toBe(false);
    const refusedBody = operation(refused);
    expect(refusedBody).toMatchObject({
      action: "commit",
      status: "invalid_state",
      changedPaths: [],
      error: { type: "invalid_state" },
    });
    expect(JSON.stringify(refusedBody.error)).toContain("active commit hooks");
    expect(await rawHead(fixture.repoRoot)).toBe(headBefore);
    expect((await runGit(fixture.repoRoot, ["diff", "--cached", "--name-only"])).stdout)
      .toBe("tracked.txt");
    expect(await fs.readFile(path.join(fixture.repoRoot, "other.txt"), "utf8")).toBe("other base\n");
    expect((await runGit(fixture.repoRoot, ["log", "-1", "--pretty=%s"])).stdout)
      .toBe("initial fixture");
  });

  it("checkpoints explicit worktree restore paths and undo restores the user's original edit", async () => {
    const fixture = await createGitFixture();
    const runtime = createRuntime(fixture);
    await fs.writeFile(path.join(fixture.repoRoot, "tracked.txt"), "user edit to restore later\n", "utf8");
    await fs.writeFile(path.join(fixture.repoRoot, "other.txt"), "unrelated user edit\n", "utf8");

    const restored = await runtime.executeManualTool(
      "git_restore",
      {
        cwd: fixture.repoCwd,
        area: "worktree",
        source: "head",
        paths: ["tracked.txt"],
      },
      fixture.sessionId,
    );
    expect(restored.success).toBe(true);
    const restoreBody = operation(restored);
    expect(restoreBody).toMatchObject({
      action: "restore",
      status: "completed",
      checkpointId: expect.any(String),
      undo: {
        available: true,
        checkpointId: expect.any(String),
        scope: "worktree_files",
      },
    });
    expect(restoreBody.changedPaths).toEqual(["tracked.txt"]);
    expect(await fs.readFile(path.join(fixture.repoRoot, "tracked.txt"), "utf8")).toBe("base line\n");
    expect(await fs.readFile(path.join(fixture.repoRoot, "other.txt"), "utf8"))
      .toBe("unrelated user edit\n");
    expect((await fixture.sessionStore.listUndoCandidates(fixture.sessionId)).map((entry) => entry.checkpointId))
      .toContain(restoreBody.checkpointId);

    const undone = await runtime.executeManualTool(
      "undo",
      { checkpointId: restoreBody.checkpointId, mode: "code" },
      fixture.sessionId,
    );
    expect(undone.success).toBe(true);
    expect(await fs.readFile(path.join(fixture.repoRoot, "tracked.txt"), "utf8"))
      .toBe("user edit to restore later\n");
    expect(await fs.readFile(path.join(fixture.repoRoot, "other.txt"), "utf8"))
      .toBe("unrelated user edit\n");
  });

  it("unstages only explicit index paths and restores worktree bytes from an explicit revision", async () => {
    const fixture = await createGitFixture();
    const runtime = createRuntime(fixture);
    const initialRevision = await rawHead(fixture.repoRoot);
    await fs.writeFile(path.join(fixture.repoRoot, "tracked.txt"), "staged index edit\n", "utf8");
    await runGit(fixture.repoRoot, ["add", "--", "tracked.txt"]);

    const unstaged = await runtime.executeManualTool(
      "git_restore",
      {
        cwd: fixture.repoCwd,
        area: "index",
        source: "head",
        paths: ["tracked.txt"],
      },
      fixture.sessionId,
    );
    expect(unstaged.success).toBe(true);
    expect(operation(unstaged)).toMatchObject({
      action: "restore",
      status: "completed",
      changedPaths: ["tracked.txt"],
      checkpointId: expect.any(String),
      undo: {
        available: false,
        checkpointId: expect.any(String),
        scope: "index",
        limitations: expect.arrayContaining([expect.stringContaining("index staging bits")]),
      },
      repository: {
        staged: [],
        unstaged: expect.arrayContaining([expect.objectContaining({ path: "tracked.txt" })]),
      },
    });
    expect((await runGit(fixture.repoRoot, ["diff", "--cached", "--name-only"])).stdout).toBe("");
    expect((await runGit(fixture.repoRoot, ["diff", "--name-only"])).stdout).toBe("tracked.txt");
    expect(await fs.readFile(path.join(fixture.repoRoot, "tracked.txt"), "utf8"))
      .toBe("staged index edit\n");

    await runGit(fixture.repoRoot, ["restore", "--source=HEAD", "--worktree", "--", "tracked.txt"]);
    const intermediateRevision = await commitFile(
      fixture,
      "tracked.txt",
      "intermediate committed line\n",
      "intermediate tracked revision",
    );
    await commitFile(fixture, "tracked.txt", "newer committed line\n", "newer tracked revision");
    const headBeforeRevisionRestore = await rawHead(fixture.repoRoot);
    const restoredRevision = await runtime.executeManualTool(
      "git_restore",
      {
        cwd: fixture.repoCwd,
        area: "worktree",
        source: "revision",
        revision: initialRevision,
        paths: ["tracked.txt"],
      },
      fixture.sessionId,
    );
    expect(restoredRevision.success).toBe(true);
    expect(operation(restoredRevision)).toMatchObject({
      action: "restore",
      status: "completed",
      changedPaths: ["tracked.txt"],
      checkpointId: expect.any(String),
      headBefore: { oid: headBeforeRevisionRestore },
      headAfter: { oid: headBeforeRevisionRestore },
      undo: {
        available: true,
        checkpointId: expect.any(String),
        scope: "worktree_files",
      },
      details: {
        area: "worktree",
        source: "revision",
        revision: initialRevision,
      },
    });
    expect(await fs.readFile(path.join(fixture.repoRoot, "tracked.txt"), "utf8")).toBe("base line\n");
    expect((await runGit(fixture.repoRoot, ["diff", "--name-only"])).stdout).toBe("tracked.txt");
    expect(await rawHead(fixture.repoRoot)).toBe(headBeforeRevisionRestore);

    const restoredWhileStillModified = await runtime.executeManualTool(
      "git_restore",
      {
        cwd: fixture.repoCwd,
        area: "worktree",
        source: "revision",
        revision: intermediateRevision,
        paths: ["tracked.txt"],
      },
      fixture.sessionId,
    );
    expect(restoredWhileStillModified.success).toBe(true);
    expect(operation(restoredWhileStillModified)).toMatchObject({
      action: "restore",
      status: "completed",
      changedPaths: ["tracked.txt"],
      headBefore: { oid: headBeforeRevisionRestore },
      headAfter: { oid: headBeforeRevisionRestore },
    });
    expect(await fs.readFile(path.join(fixture.repoRoot, "tracked.txt"), "utf8"))
      .toBe("intermediate committed line\n");
    expect((await runGit(fixture.repoRoot, ["diff", "--name-only"])).stdout).toBe("tracked.txt");
  });

  it("retains usable worktree undo evidence when Git restore fails after checkpoint creation", async () => {
    const fixture = await createGitFixture({ repositoryName: "restore failure checkpoint repo" });
    const runtime = createRuntime(fixture);
    await fs.writeFile(path.join(fixture.repoRoot, "tracked.txt"), "staged bytes before failed restore\n", "utf8");
    await runGit(fixture.repoRoot, ["add", "--", "tracked.txt"]);
    const indexLock = path.join(fixture.repoRoot, ".git", "index.lock");
    await fs.writeFile(indexLock, "fixture lock\n", "utf8");

    const restored = await runtime.executeManualTool(
      "git_restore",
      { cwd: fixture.repoCwd, area: "both", source: "head", paths: ["tracked.txt"] },
      fixture.sessionId,
    );
    expect(restored.success).toBe(false);
    const body = operation(restored);
    expect(body).toMatchObject({
      action: "restore",
      status: "failed",
      checkpointId: expect.any(String),
      undo: {
        available: true,
        checkpointId: expect.any(String),
        scope: "worktree_files",
        limitations: expect.arrayContaining([expect.stringContaining("retained checkpoint")]),
      },
    });
    await fs.rm(indexLock);
    const undone = await runtime.executeManualTool(
      "undo",
      { checkpointId: body.checkpointId, mode: "code" },
      fixture.sessionId,
    );
    expect(undone.success).toBe(true);
    expect(await fs.readFile(path.join(fixture.repoRoot, "tracked.txt"), "utf8"))
      .toBe("staged bytes before failed restore\n");
  });

  it("rejects a confirmed integration when unrelated dirty state appears after preview", async () => {
    const fixture = await createGitFixture({ repositoryName: "stale integration preview repo" });
    await runGit(fixture.repoRoot, ["switch", "-c", "integration-topic"]);
    await commitFile(fixture, "src/routes.ts", "export const route = 'topic';\n", "integration topic");
    await runGit(fixture.repoRoot, ["switch", "main"]);
    const runtime = createRuntime(fixture);
    const args = {
      cwd: fixture.repoCwd,
      action: "merge" as const,
      mode: "start" as const,
      target: "integration-topic",
    };
    const headBefore = await rawHead(fixture.repoRoot);
    const preview = await runtime.executeManualTool("git_integrate", args, fixture.sessionId);
    const previewBody = operation(preview);
    expect(previewBody).toMatchObject({ status: "preview", preview: { confirmationToken: expect.any(String) } });
    await fs.writeFile(path.join(fixture.repoRoot, "unrelated-after-preview.txt"), "user state\n", "utf8");

    const refused = await runtime.executeManualTool(
      "git_integrate",
      { ...args, confirmationToken: previewBody.preview!.confirmationToken },
      fixture.sessionId,
    );
    expect(refused.success).toBe(false);
    expect(operation(refused)).toMatchObject({ action: "merge", status: "invalid_state", changedPaths: [] });
    expect(await rawHead(fixture.repoRoot)).toBe(headBefore);
    expect(await fs.readFile(path.join(fixture.repoRoot, "unrelated-after-preview.txt"), "utf8"))
      .toBe("user state\n");
  });

  it("blocks an integration range that would modify a protected runtime path", async () => {
    const fixture = await createGitFixture({ repositoryName: "protected integration repo" });
    await runGit(fixture.repoRoot, ["switch", "-c", "protected-source"]);
    const protectedRelativePath = ".deep-mix/sessions/runtime-state.json";
    const protectedAbsolutePath = path.join(fixture.repoRoot, protectedRelativePath);
    await fs.mkdir(path.dirname(protectedAbsolutePath), { recursive: true });
    await fs.writeFile(protectedAbsolutePath, "fixture-only protected state\n", "utf8");
    await runGit(fixture.repoRoot, ["add", "-f", "--", protectedRelativePath]);
    await runGit(fixture.repoRoot, ["commit", "-m", "protected runtime path change"]);
    await runGit(fixture.repoRoot, ["switch", "main"]);
    const runtime = createRuntime(fixture);
    const headBefore = await rawHead(fixture.repoRoot);

    const blocked = await runtime.executeManualTool(
      "git_integrate",
      {
        cwd: fixture.repoCwd,
        action: "merge",
        mode: "start",
        target: "protected-source",
      },
      fixture.sessionId,
    );
    expect(blocked.success).toBe(false);
    expect(operation(blocked)).toMatchObject({
      action: "merge",
      status: "protected",
      changedPaths: [],
      headBefore: { oid: headBefore },
      headAfter: { oid: headBefore },
      error: {
        type: "invalid_path",
        path: protectedRelativePath,
      },
    });
    expect(await rawHead(fixture.repoRoot)).toBe(headBefore);
    expect((await runGit(fixture.repoRoot, ["branch", "--show-current"])).stdout).toBe("main");
    await expect(fs.access(protectedAbsolutePath)).rejects.toThrow();
  });

  it.each(["merge", "rebase", "cherry_pick", "revert"] as const)(
    "completes an explicitly previewed local %s integration",
    async (action) => {
      const fixture = await createGitFixture({ repositoryName: `${action} success repo` });
      let request: IntegrationRequest;
      const expectedFiles: Array<[string, string]> = [];
      let revertedPath: string | undefined;

      if (action === "merge") {
        await runGit(fixture.repoRoot, ["switch", "-c", "merge-source"]);
        await commitFile(fixture, "merge-only.txt", "merged content\n", "merge source commit");
        await runGit(fixture.repoRoot, ["switch", "main"]);
        request = { action, target: "merge-source" };
        expectedFiles.push(["merge-only.txt", "merged content\n"]);
      } else if (action === "rebase") {
        await runGit(fixture.repoRoot, ["switch", "-c", "rebase-topic"]);
        await commitFile(fixture, "rebase-topic.txt", "topic content\n", "rebase topic commit");
        await runGit(fixture.repoRoot, ["switch", "main"]);
        await commitFile(fixture, "rebase-main.txt", "main content\n", "rebase main commit");
        await runGit(fixture.repoRoot, ["switch", "rebase-topic"]);
        request = { action, target: "main" };
        expectedFiles.push(
          ["rebase-topic.txt", "topic content\n"],
          ["rebase-main.txt", "main content\n"],
        );
      } else if (action === "cherry_pick") {
        await runGit(fixture.repoRoot, ["switch", "-c", "cherry-source"]);
        const pickedRevision = await commitFile(
          fixture,
          "cherry-only.txt",
          "picked content\n",
          "cherry source commit",
        );
        await runGit(fixture.repoRoot, ["switch", "main"]);
        request = { action, target: pickedRevision };
        expectedFiles.push(["cherry-only.txt", "picked content\n"]);
      } else {
        const revertedRevision = await commitFile(
          fixture,
          "revert-only.txt",
          "content to revert\n",
          "revert target commit",
        );
        request = { action, revisions: [revertedRevision] };
        revertedPath = "revert-only.txt";
      }

      const runtime = createRuntime(fixture);
      const headBefore = await rawHead(fixture.repoRoot);
      const { result, body } = await runConfirmedIntegration(fixture, runtime, request);
      expect(result.success).toBe(true);
      expect(body).toMatchObject({
        action,
        status: "completed",
        headBefore: { oid: headBefore },
        headAfter: { oid: expect.any(String) },
        conflict: { status: "none", files: [] },
        details: {
          mode: "start",
          conflictPreserved: false,
          automaticAbortUsed: false,
          pathEnumerationComplete: true,
        },
      });
      expect(body.changedPaths.length).toBeGreaterThan(0);
      expect(await rawHead(fixture.repoRoot)).not.toBe(headBefore);
      for (const [filePath, content] of expectedFiles) {
        expect(await fs.readFile(path.join(fixture.repoRoot, filePath), "utf8")).toBe(content);
      }
      if (revertedPath) {
        await expect(fs.access(path.join(fixture.repoRoot, revertedPath))).rejects.toThrow();
      }
      expect((await runGit(fixture.repoRoot, ["status", "--short"])).stdout).toBe("");
    },
  );

  it.each(["rebase", "cherry_pick", "revert"] as const)(
    "preserves a structured %s conflict without automatic cleanup",
    async (action) => {
      const fixture = await createGitFixture({ repositoryName: `${action} conflict repo` });
      let request: IntegrationRequest;

      if (action === "rebase") {
        await runGit(fixture.repoRoot, ["switch", "-c", "rebase-conflict-topic"]);
        await commitFile(fixture, "tracked.txt", "topic conflict line\n", "rebase topic conflict");
        await runGit(fixture.repoRoot, ["switch", "main"]);
        await commitFile(fixture, "tracked.txt", "main conflict line\n", "rebase main conflict");
        await runGit(fixture.repoRoot, ["switch", "rebase-conflict-topic"]);
        request = { action, target: "main" };
      } else if (action === "cherry_pick") {
        await runGit(fixture.repoRoot, ["switch", "-c", "cherry-conflict-source"]);
        const conflictingRevision = await commitFile(
          fixture,
          "tracked.txt",
          "cherry conflict line\n",
          "cherry conflict source",
        );
        await runGit(fixture.repoRoot, ["switch", "main"]);
        await commitFile(fixture, "tracked.txt", "main conflict line\n", "cherry main conflict");
        request = { action, target: conflictingRevision };
      } else {
        const conflictingRevision = await commitFile(
          fixture,
          "tracked.txt",
          "revert target line\n",
          "revert conflict target",
        );
        await commitFile(fixture, "tracked.txt", "later competing line\n", "later competing change");
        request = { action, revisions: [conflictingRevision] };
      }

      const runtime = createRuntime(fixture);
      const { result, body } = await runConfirmedIntegration(fixture, runtime, request);
      expect(result.success).toBe(false);
      expect(body).toMatchObject({
        action,
        status: "conflicted",
        conflict: {
          status: "conflicted",
          operation: action,
          files: expect.arrayContaining(["tracked.txt"]),
          nextSteps: expect.any(Array),
        },
        repository: {
          dirty: true,
          conflicted: expect.arrayContaining(["tracked.txt"]),
          conflict: { status: "conflicted", operation: action },
        },
        details: { mode: "start", conflictPreserved: true, pathEnumerationComplete: true },
        error: { type: "conflicted" },
      });
      expect(body.changedPaths).toContain("tracked.txt");
      expect(body.conflict.nextSteps.length).toBeGreaterThan(0);
      expect((await runGit(fixture.repoRoot, ["diff", "--name-only", "--diff-filter=U"])).stdout)
        .toContain("tracked.txt");
      expect(await fs.readFile(path.join(fixture.repoRoot, "tracked.txt"), "utf8"))
        .toContain("<<<<<<<");
    },
  );

  it("previews merge risk and preserves the real conflict state after confirmation", async () => {
    const fixture = await createGitFixture();
    await runGit(fixture.repoRoot, ["switch", "-c", "conflict-topic"]);
    await commitFile(fixture, "tracked.txt", "topic conflict line\n", "topic conflict");
    await runGit(fixture.repoRoot, ["switch", "main"]);
    await commitFile(fixture, "tracked.txt", "main conflict line\n", "main conflict");
    const runtime = createRuntime(fixture);
    const headBefore = await rawHead(fixture.repoRoot);

    const preview = await runtime.executeManualTool(
      "git_integrate",
      {
        cwd: fixture.repoCwd,
        action: "merge",
        mode: "start",
        target: "conflict-topic",
      },
      fixture.sessionId,
    );
    expect(preview.success).toBe(true);
    const previewBody = operation(preview);
    expect(previewBody).toMatchObject({
      action: "merge",
      status: "preview",
      preview: {
        confirmationToken: expect.any(String),
        riskSummary: expect.any(Array),
      },
    });
    expect(await rawHead(fixture.repoRoot)).toBe(headBefore);

    const merged = await runtime.executeManualTool(
      "git_integrate",
      {
        cwd: fixture.repoCwd,
        action: "merge",
        mode: "start",
        target: "conflict-topic",
        confirmationToken: previewBody.preview!.confirmationToken,
      },
      fixture.sessionId,
    );
    const mergeBody = operation(merged);
    expect(mergeBody).toMatchObject({
      action: "merge",
      status: "conflicted",
      conflict: {
        status: "conflicted",
        operation: "merge",
        files: expect.arrayContaining(["tracked.txt"]),
        nextSteps: expect.any(Array),
      },
    });
    expect(mergeBody.conflict.nextSteps.length).toBeGreaterThan(0);
    expect(mergeBody).toMatchObject({
      details: { mode: "start", conflictPreserved: true, pathEnumerationComplete: true },
    });
    expect(mergeBody.changedPaths).toContain("tracked.txt");
    expect(mergeBody.repository.conflicted).toContain("tracked.txt");
    expect((await runGit(fixture.repoRoot, ["diff", "--name-only", "--diff-filter=U"])).stdout)
      .toContain("tracked.txt");
    expect(await fs.readFile(path.join(fixture.repoRoot, ".git", "MERGE_HEAD"), "utf8"))
      .toContain((await runGit(fixture.repoRoot, ["rev-parse", "conflict-topic"])).stdout);
    expect(await fs.readFile(path.join(fixture.repoRoot, "tracked.txt"), "utf8"))
      .toContain("<<<<<<<");
  });

  it("continues an explicitly resolved cherry-pick conflict without an editor or implicit cleanup", async () => {
    const fixture = await createGitFixture({ repositoryName: "cherry continue recovery repo" });
    await runGit(fixture.repoRoot, ["switch", "-c", "cherry-continue-source"]);
    const conflictingRevision = await commitFile(
      fixture,
      "tracked.txt",
      "cherry continue source line\n",
      "cherry continue source",
    );
    await runGit(fixture.repoRoot, ["switch", "main"]);
    await commitFile(fixture, "tracked.txt", "main line before cherry continue\n", "cherry continue main");
    const headBefore = await rawHead(fixture.repoRoot);
    const runtime = createRuntime(fixture, "danger-full-access", {
      GIT_EDITOR: "false",
      GIT_SEQUENCE_EDITOR: "false",
    });

    const started = await runConfirmedIntegration(fixture, runtime, {
      action: "cherry_pick",
      target: conflictingRevision,
    });
    expect(started.result.success).toBe(false);
    expect(started.body).toMatchObject({
      action: "cherry_pick",
      status: "conflicted",
      conflict: {
        status: "conflicted",
        operation: "cherry_pick",
        files: expect.arrayContaining(["tracked.txt"]),
      },
      details: { mode: "start", conflictPreserved: true },
    });
    expect(await rawHead(fixture.repoRoot)).toBe(headBefore);
    expect(await fs.readFile(path.join(fixture.repoRoot, ".git", "CHERRY_PICK_HEAD"), "utf8"))
      .toContain(conflictingRevision);
    expect(await fs.readFile(path.join(fixture.repoRoot, "tracked.txt"), "utf8"))
      .toContain("<<<<<<<");

    await fs.writeFile(path.join(fixture.repoRoot, "tracked.txt"), "explicit cherry resolution\n", "utf8");
    const staged = await runtime.executeManualTool(
      "git_stage",
      { cwd: fixture.repoCwd, paths: ["tracked.txt"] },
      fixture.sessionId,
    );
    expect(staged.success).toBe(true);
    expect(operation(staged)).toMatchObject({
      action: "stage",
      status: "completed",
      changedPaths: ["tracked.txt"],
      repository: {
        staged: expect.arrayContaining([expect.objectContaining({ path: "tracked.txt" })]),
        conflicted: [],
        conflict: { status: "conflicted", operation: "cherry_pick", files: [] },
      },
    });

    const continueArgs = {
      cwd: fixture.repoCwd,
      action: "cherry_pick" as const,
      mode: "continue" as const,
    };
    const preview = await runtime.executeManualTool("git_integrate", continueArgs, fixture.sessionId);
    expect(preview.success).toBe(true);
    const previewBody = operation(preview);
    expect(previewBody).toMatchObject({
      action: "cherry_pick",
      status: "preview",
      headBefore: { oid: headBefore },
      headAfter: { oid: headBefore },
      conflict: { status: "conflicted", operation: "cherry_pick", files: [] },
      preview: {
        confirmationToken: expect.any(String),
        riskSummary: expect.arrayContaining([expect.stringContaining("Continue")]),
      },
    });
    expect(await rawHead(fixture.repoRoot)).toBe(headBefore);
    await expect(fs.access(path.join(fixture.repoRoot, ".git", "CHERRY_PICK_HEAD"))).resolves.toBeUndefined();

    const continued = await runtime.executeManualTool(
      "git_integrate",
      { ...continueArgs, confirmationToken: previewBody.preview!.confirmationToken },
      fixture.sessionId,
    );
    expect(continued.success).toBe(true);
    const continueBody = operation(continued);
    expect(continueBody).toMatchObject({
      action: "cherry_pick",
      status: "completed",
      headBefore: { oid: headBefore },
      headAfter: { oid: expect.any(String) },
      changedPaths: expect.arrayContaining(["tracked.txt"]),
      repository: { dirty: false, conflicted: [], conflict: { status: "none", files: [] } },
      details: {
        mode: "continue",
        conflictPreserved: false,
        automaticAbortUsed: false,
        pathEnumerationComplete: true,
      },
    });
    expect(continueBody.headAfter?.oid).not.toBe(headBefore);
    expect(await fs.readFile(path.join(fixture.repoRoot, "tracked.txt"), "utf8"))
      .toBe("explicit cherry resolution\n");
    expect((await runGit(fixture.repoRoot, ["status", "--short"])).stdout).toBe("");
    expect((await runGit(fixture.repoRoot, ["log", "-1", "--pretty=%s"])).stdout)
      .toBe("cherry continue source");
    await expect(fs.access(path.join(fixture.repoRoot, ".git", "CHERRY_PICK_HEAD"))).rejects.toThrow();
  }, 180_000);

  it("aborts a merge conflict only after explicit preview and confirmation", async () => {
    const fixture = await createGitFixture({ repositoryName: "merge abort recovery repo" });
    await runGit(fixture.repoRoot, ["switch", "-c", "merge-abort-source"]);
    await commitFile(fixture, "tracked.txt", "merge abort source line\n", "merge abort source");
    await runGit(fixture.repoRoot, ["switch", "main"]);
    await commitFile(fixture, "tracked.txt", "main line before merge abort\n", "merge abort main");
    const headBefore = await rawHead(fixture.repoRoot);
    const runtime = createRuntime(fixture);

    const started = await runConfirmedIntegration(fixture, runtime, {
      action: "merge",
      target: "merge-abort-source",
    });
    expect(started.result.success).toBe(false);
    expect(started.body).toMatchObject({
      action: "merge",
      status: "conflicted",
      conflict: {
        status: "conflicted",
        operation: "merge",
        files: expect.arrayContaining(["tracked.txt"]),
      },
      details: { mode: "start", conflictPreserved: true },
    });
    expect(await rawHead(fixture.repoRoot)).toBe(headBefore);
    await expect(fs.access(path.join(fixture.repoRoot, ".git", "MERGE_HEAD"))).resolves.toBeUndefined();
    expect(await fs.readFile(path.join(fixture.repoRoot, "tracked.txt"), "utf8"))
      .toContain("<<<<<<<");

    const abortArgs = {
      cwd: fixture.repoCwd,
      action: "merge" as const,
      mode: "abort" as const,
    };
    const preview = await runtime.executeManualTool("git_integrate", abortArgs, fixture.sessionId);
    expect(preview.success).toBe(true);
    const previewBody = operation(preview);
    expect(previewBody).toMatchObject({
      action: "merge",
      status: "preview",
      headBefore: { oid: headBefore },
      headAfter: { oid: headBefore },
      conflict: {
        status: "conflicted",
        operation: "merge",
        files: expect.arrayContaining(["tracked.txt"]),
      },
      preview: {
        confirmationToken: expect.any(String),
        riskSummary: expect.arrayContaining([expect.stringContaining("Abort")]),
      },
    });
    expect(await rawHead(fixture.repoRoot)).toBe(headBefore);
    await expect(fs.access(path.join(fixture.repoRoot, ".git", "MERGE_HEAD"))).resolves.toBeUndefined();
    expect(await fs.readFile(path.join(fixture.repoRoot, "tracked.txt"), "utf8"))
      .toContain("<<<<<<<");

    const aborted = await runtime.executeManualTool(
      "git_integrate",
      { ...abortArgs, confirmationToken: previewBody.preview!.confirmationToken },
      fixture.sessionId,
    );
    expect(aborted.success).toBe(true);
    expect(operation(aborted)).toMatchObject({
      action: "merge",
      status: "completed",
      headBefore: { oid: headBefore },
      headAfter: { oid: headBefore },
      changedPaths: expect.arrayContaining(["tracked.txt"]),
      repository: { dirty: false, staged: [], unstaged: [], conflicted: [], conflict: { status: "none", files: [] } },
      details: {
        mode: "abort",
        conflictPreserved: false,
        automaticAbortUsed: false,
        pathEnumerationComplete: true,
      },
    });
    expect(await rawHead(fixture.repoRoot)).toBe(headBefore);
    expect(await fs.readFile(path.join(fixture.repoRoot, "tracked.txt"), "utf8"))
      .toBe("main line before merge abort\n");
    expect((await runGit(fixture.repoRoot, ["status", "--short"])).stdout).toBe("");
    await expect(fs.access(path.join(fixture.repoRoot, ".git", "MERGE_HEAD"))).rejects.toThrow();
  }, 180_000);

  it("selects history, branch, and worktree intents narrowly without injecting unrelated Git writers", async () => {
    const fixture = await createGitFixture();
    const runtime = createRuntime(fixture);
    const phaseSelection = (prompt: string): string[] => runtime.selectToolsForTurn({ prompt })
      .definitions
      .map((entry) => entry.name)
      .filter((name) => PHASE18_TOOL_NAMES.includes(name as (typeof PHASE18_TOOL_NAMES)[number]));

    expect(phaseSelection("git log commit history for tracked.txt")).toEqual(["git_history"]);
    expect(phaseSelection("git branch create a local topic branch")).toEqual(["git_branch"]);
    expect(phaseSelection("git worktree create a linked worktree")).toEqual(["git_worktree"]);

    for (const selected of [
      phaseSelection("git branch switch to the local topic branch"),
      phaseSelection("git worktree list the linked worktrees"),
    ]) {
      expect(selected).not.toEqual(expect.arrayContaining([
        "git_stage",
        "git_commit",
        "git_restore",
        "git_integrate",
      ]));
    }
  });

  it("persists generic action, risk, path, and revision context for every Git write approval", async () => {
    const fixture = await createGitFixture({ repositoryName: "approval presentation repo" });
    const runtime = createRuntime(fixture, "auto");
    await fs.writeFile(path.join(fixture.repoRoot, "tracked.txt"), "approval edit\n", "utf8");

    const stageApproval = await pendingApproval(runtime.executeManualTool(
      "git_stage",
      { cwd: fixture.repoCwd, paths: ["tracked.txt"] },
      fixture.sessionId,
    ));
    const restoreApproval = await pendingApproval(runtime.executeManualTool(
      "git_restore",
      {
        cwd: fixture.repoCwd,
        area: "worktree",
        source: "head",
        paths: ["tracked.txt"],
      },
      fixture.sessionId,
    ));

    await runGit(fixture.repoRoot, ["add", "--", "tracked.txt"]);
    const commitPreviewResult = await runtime.executeManualTool(
      "git_commit",
      { cwd: fixture.repoCwd, message: "approval presentation commit" },
      fixture.sessionId,
    );
    const commitToken = operation(commitPreviewResult).preview?.confirmationToken;
    expect(commitToken).toMatch(/^[a-f0-9]{64}$/u);
    if (!commitToken) throw new Error("Missing commit confirmation token.");
    const commitApproval = await pendingApproval(runtime.executeManualTool(
      "git_commit",
      {
        cwd: fixture.repoCwd,
        message: "approval presentation commit",
        confirmationToken: commitToken,
      },
      fixture.sessionId,
    ));

    await runGit(fixture.repoRoot, [
      "restore",
      "--source=HEAD",
      "--staged",
      "--worktree",
      "--",
      "tracked.txt",
    ]);
    await runGit(fixture.repoRoot, ["switch", "-c", "approval-topic"]);
    await commitFile(fixture, "tracked.txt", "approval topic edit\n", "approval topic commit");
    await runGit(fixture.repoRoot, ["switch", "main"]);
    const integratePreviewResult = await runtime.executeManualTool(
      "git_integrate",
      {
        cwd: fixture.repoCwd,
        action: "merge",
        mode: "start",
        target: "approval-topic",
      },
      fixture.sessionId,
    );
    const integrateToken = operation(integratePreviewResult).preview?.confirmationToken;
    expect(integrateToken).toMatch(/^[a-f0-9]{64}$/u);
    if (!integrateToken) throw new Error("Missing integrate confirmation token.");
    const integrateApproval = await pendingApproval(runtime.executeManualTool(
      "git_integrate",
      {
        cwd: fixture.repoCwd,
        action: "merge",
        mode: "start",
        target: "approval-topic",
        confirmationToken: integrateToken,
      },
      fixture.sessionId,
    ));

    expect(stageApproval).toMatchObject({
      toolName: "git_stage",
      sideEffectLevel: "medium",
      presentation: {
        action: "stage",
        paths: ["tracked.txt"],
        argumentSummary: { paths: ["tracked.txt"] },
      },
    });
    expect(commitApproval).toMatchObject({
      toolName: "git_commit",
      sideEffectLevel: "high",
      presentation: {
        action: "commit",
        paths: ["tracked.txt"],
        argumentSummary: {
          message: "approval presentation commit",
          confirmationToken: "[provided]",
        },
      },
    });
    expect(restoreApproval).toMatchObject({
      toolName: "git_restore",
      sideEffectLevel: "high",
      presentation: {
        action: "restore",
        paths: ["tracked.txt"],
        revisions: ["HEAD"],
        argumentSummary: {
          area: "worktree",
          source: "head",
          paths: ["tracked.txt"],
        },
      },
    });
    expect(integrateApproval).toMatchObject({
      toolName: "git_integrate",
      sideEffectLevel: "high",
      presentation: {
        action: "merge",
        paths: ["tracked.txt"],
        revisions: ["approval-topic"],
        argumentSummary: {
          action: "merge",
          mode: "start",
          target: "approval-topic",
          confirmationToken: "[provided]",
        },
      },
    });
  }, 180_000);

  it("projects only read actions in plan mode and preserves legacy git_status/git_diff results", async () => {
    const fixture = await createGitFixture();
    const planRuntime = createRuntime(fixture, "plan");
    const selected = planRuntime.selectToolsForTurn({
      requestedToolNames: [...PHASE18_TOOL_NAMES],
    }).definitions;
    expect(selected.map((entry) => entry.name)).toEqual(expect.arrayContaining([
      "git_history",
      "git_branch",
      "git_worktree",
    ]));
    expect(selected.map((entry) => entry.name)).not.toEqual(expect.arrayContaining([
      "git_stage",
      "git_commit",
      "git_restore",
      "git_integrate",
    ]));
    expect(actionEnum(selected.find((entry) => entry.name === "git_branch")!)).toEqual(["list"]);
    expect(actionEnum(selected.find((entry) => entry.name === "git_worktree")!)).toEqual(["list"]);
    expect(actionEnum(selected.find((entry) => entry.name === "git_history")!)).toEqual([
      "log",
      "show",
      "blame",
    ]);

    await fs.writeFile(path.join(fixture.repoRoot, "src", "routes.ts"), "export const route = 'changed';\n", "utf8");
    const legacyStore = new SessionStore(fixture.repoRoot);
    await legacyStore.ensureInitialized();
    const legacySession = await legacyStore.createSession("phase18 legacy git regression");
    const legacyRuntime = new ToolRuntime({
      workspaceRoot: fixture.repoRoot,
      sessionStore: legacyStore,
      permissionMode: "danger-full-access",
      environment: fixtureGitEnvironment(),
      specialistBroker: new SpecialistBroker({
        workspaceRoot: fixture.repoRoot,
        sessionStore: legacyStore,
      }),
      settings: { version: 1 },
    });
    disposables.push(legacyRuntime);
    const cwdArg = process.platform === "win32" ? "src\\.." : "src/..";
    const status = await legacyRuntime.executeManualTool(
      "git_status",
      { cwd: cwdArg },
      legacySession.sessionId,
    );
    const diff = await legacyRuntime.executeManualTool(
      "git_diff",
      { cwd: cwdArg, pathspec: "src/routes.ts" },
      legacySession.sessionId,
    );
    expect(status.success).toBe(true);
    expect(diff.success).toBe(true);
    expect(status.structuredContent).toMatchObject({
      kind: "git_status",
      cwd: ".",
      raw: { args: ["status", "--short"] },
    });
    expect(diff.structuredContent).toMatchObject({
      kind: "git_diff",
      cwd: ".",
      pathspec: "src/routes.ts",
      raw: { args: ["diff", "--", "src/routes.ts"] },
    });
    expect(diff.output).toContain("changed");
  });
});
