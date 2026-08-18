import { createHash } from "node:crypto";
import { promises as fs } from "node:fs";
import path from "node:path";

import type {
  GitOperationResult,
  GitOperationStatus,
  GitRepositorySnapshot,
  ToolAccessRequest,
  ToolAvailability,
  ToolErrorType,
  ToolPermissionProfile,
  ToolResult,
  ToolStructuredError,
} from "../../../../shared-schema/src/index.js";
import type {
  RuntimeToolExecutionContext,
  RuntimeToolSpec,
  ToolAccessResolutionContext,
  ToolModuleContext,
} from "../../tool-module.js";
import {
  isProtectedReadPath,
} from "../../repository-explorer.js";

import {
  buildGitCommand,
  executeGitCommand,
  literalGitPathspec,
  normalizeGitPath,
  redactGitText,
  validateGitBranchName,
  validateGitRevision,
  type GitCommandExecutionResult,
} from "./command-builder.js";
import {
  captureGitRepositorySnapshot,
  isProtectedGitBranch,
  resolveTrustedRepositoryPath,
  withGitMutationLock,
  type GitRepositoryContext,
} from "./repository-state.js";

type AnyGitContext = ToolAccessResolutionContext | RuntimeToolExecutionContext;
type HistoryAction = "log" | "show" | "blame";
type BranchAction = "list" | "create" | "switch" | "delete";
type WorktreeAction = "list" | "create" | "remove";

interface HistoryArguments {
  action: HistoryAction;
  cwd?: string;
  limit?: number;
  path?: string;
  author?: string;
  since?: string;
  until?: string;
  revision?: string;
  mode?: "summary" | "diff" | "content";
  startLine?: number;
  endLine?: number;
  maxChars?: number;
}

interface BranchArguments {
  action: BranchAction;
  cwd?: string;
  name?: string;
  startPoint?: string;
}

interface WorktreeArguments {
  action: WorktreeAction;
  cwd?: string;
  path?: string;
  branch?: string;
  startPoint?: string;
  createBranch?: boolean;
}

interface TextDetails {
  text: string;
  truncated: boolean;
  maxChars: number;
  command: string;
  outputTruncatedByRuntime: boolean;
}

interface BranchEntry {
  name: string;
  oid: string;
  current: boolean;
  protected: boolean;
  checkedOutAt?: string;
  subject?: string;
}

const DEFAULT_HISTORY_CHARS = 20_000;
const MAX_HISTORY_CHARS = 200_000;
const DEFAULT_HISTORY_LIMIT = 20;
const MAX_HISTORY_LIMIT = 100;
const MAX_BLAME_LINES = 500;
const DEFAULT_PROTECTED_BRANCHES = ["main", "master"] as const;

function moduleContext(context: AnyGitContext): ToolModuleContext {
  return "moduleContext" in context ? context.moduleContext : context;
}

function now(context: AnyGitContext): string {
  return moduleContext(context).clock.now();
}

function normalizedWorkspacePath(workspaceRoot: string, absolutePath: string): string {
  return (path.relative(workspaceRoot, absolutePath) || ".").replace(/\\/gu, "/");
}

function isInside(root: string, target: string): boolean {
  const relative = path.relative(path.resolve(root), path.resolve(target));
  return relative === "" || (!relative.startsWith("..") && !path.isAbsolute(relative));
}

function emptySnapshot(context: AnyGitContext, cwd = "."): GitRepositorySnapshot {
  const body: Omit<GitRepositorySnapshot, "stateDigest" | "capturedAt"> = {
    repositoryState: "not_repository",
    cwd: cwd.replace(/\\/gu, "/"),
    gitDirTrusted: false,
    commonDirTrusted: false,
    isRepository: false,
    isBare: false,
    isSubmodule: false,
    head: { detached: false, unborn: false },
    protectedBranch: false,
    dirty: false,
    staged: [],
    unstaged: [],
    untracked: [],
    conflicted: [],
    worktrees: [],
    conflict: { status: "none", files: [], nextSteps: [] },
    stateComplete: false,
    stateFailures: ["git_capability_unavailable"],
  };
  return {
    ...body,
    stateDigest: createHash("sha256").update(JSON.stringify(body)).digest("hex"),
    capturedAt: now(context),
  };
}

function objectArguments(rawArgs: unknown): Record<string, unknown> {
  if (!rawArgs || typeof rawArgs !== "object" || Array.isArray(rawArgs)) {
    throw new Error("Git tool arguments must be an object.");
  }
  return rawArgs as Record<string, unknown>;
}

function optionalString(value: unknown, field: string, maximum = 8_192): string | undefined {
  if (value === undefined) return undefined;
  if (typeof value !== "string" || value.length === 0 || value.length > maximum || value.includes("\0")) {
    throw new Error(`${field} must be a non-empty string of at most ${maximum} characters.`);
  }
  return value;
}

function boundedInteger(
  value: unknown,
  field: string,
  minimum: number,
  maximum: number,
  fallback: number,
): number {
  if (value === undefined) return fallback;
  if (typeof value !== "number" || !Number.isInteger(value)) {
    throw new Error(`${field} must be an integer.`);
  }
  return Math.min(maximum, Math.max(minimum, value));
}

function parseHistoryArguments(rawArgs: unknown): HistoryArguments {
  const raw = objectArguments(rawArgs);
  if (raw.action !== "log" && raw.action !== "show" && raw.action !== "blame") {
    throw new Error("git_history action must be log, show, or blame.");
  }
  const mode = raw.mode;
  if (mode !== undefined && mode !== "summary" && mode !== "diff" && mode !== "content") {
    throw new Error("git_history mode must be summary, diff, or content.");
  }
  return {
    action: raw.action,
    cwd: optionalString(raw.cwd, "cwd"),
    limit: raw.limit === undefined
      ? undefined
      : boundedInteger(raw.limit, "limit", 1, MAX_HISTORY_LIMIT, DEFAULT_HISTORY_LIMIT),
    path: optionalString(raw.path, "path"),
    author: optionalString(raw.author, "author", 512),
    since: optionalString(raw.since, "since", 512),
    until: optionalString(raw.until, "until", 512),
    revision: optionalString(raw.revision, "revision", 512),
    mode,
    startLine: raw.startLine === undefined
      ? undefined
      : boundedInteger(raw.startLine, "startLine", 1, 10_000_000, 1),
    endLine: raw.endLine === undefined
      ? undefined
      : boundedInteger(raw.endLine, "endLine", 1, 10_000_000, 1),
    maxChars: raw.maxChars === undefined
      ? undefined
      : boundedInteger(raw.maxChars, "maxChars", 256, MAX_HISTORY_CHARS, DEFAULT_HISTORY_CHARS),
  };
}

function parseBranchArguments(rawArgs: unknown): BranchArguments {
  const raw = objectArguments(rawArgs);
  if (raw.action !== "list" && raw.action !== "create" && raw.action !== "switch" && raw.action !== "delete") {
    throw new Error("git_branch action must be list, create, switch, or delete.");
  }
  return {
    action: raw.action,
    cwd: optionalString(raw.cwd, "cwd"),
    name: optionalString(raw.name, "name", 255),
    startPoint: optionalString(raw.startPoint, "startPoint", 512),
  };
}

function parseWorktreeArguments(rawArgs: unknown): WorktreeArguments {
  const raw = objectArguments(rawArgs);
  if (raw.action !== "list" && raw.action !== "create" && raw.action !== "remove") {
    throw new Error("git_worktree action must be list, create, or remove.");
  }
  if (raw.createBranch !== undefined && typeof raw.createBranch !== "boolean") {
    throw new Error("createBranch must be a boolean.");
  }
  return {
    action: raw.action,
    cwd: optionalString(raw.cwd, "cwd"),
    path: optionalString(raw.path, "path"),
    branch: optionalString(raw.branch, "branch", 255),
    startPoint: optionalString(raw.startPoint, "startPoint", 512),
    createBranch: raw.createBranch,
  };
}

function protectedBranches(context: AnyGitContext): string[] {
  return [...new Set([
    ...DEFAULT_PROTECTED_BRANCHES,
    ...(moduleContext(context).settings.git?.protectedBranches ?? []),
  ].map((entry) => entry.trim()).filter(Boolean))];
}

async function gitRepositoryContext(context: AnyGitContext): Promise<GitRepositoryContext> {
  const services = moduleContext(context);
  const capability = await services.capabilities.get("git");
  if (!capability?.available || !capability.command) {
    throw new Error("Git executable is unavailable.");
  }
  return {
    workspaceRoot: context.workspaceRoot,
    managedWorktreeRoot: services.paths.resolveState("worktrees"),
    gitExecutable: capability.command,
    processes: services.processes,
    clock: services.clock,
    environment: services.environment,
  };
}

async function snapshotFor(
  context: AnyGitContext,
  cwd = ".",
): Promise<{ git: GitRepositoryContext; snapshot: GitRepositorySnapshot }> {
  const git = await gitRepositoryContext(context);
  const snapshot = await captureGitRepositorySnapshot(git, cwd, protectedBranches(context));
  return { git, snapshot };
}

async function runGit(
  git: GitRepositoryContext,
  cwd: string,
  args: readonly string[],
  purpose: string,
  maxOutputChars = 200_000,
): Promise<GitCommandExecutionResult> {
  return executeGitCommand(git.processes, buildGitCommand({
    executable: git.gitExecutable,
    args,
    cwd,
    purpose,
    maxOutputChars,
    environment: git.environment,
  }));
}

function commandError(
  toolName: string,
  result: GitCommandExecutionResult,
  message: string,
  type: ToolErrorType = "command_failed",
): ToolStructuredError {
  if (result.timedOut) type = "timeout";
  if (result.spawnError?.code === "ENOENT") type = "missing_dependency";
  return {
    type,
    message,
    retryable: type === "timeout" || type === "command_failed",
    toolName,
    command: result.display,
    cwd: result.cwd,
    exitCode: result.exitCode ?? undefined,
    stdout: result.stdout || undefined,
    stderr: result.stderr || result.spawnError?.message,
  };
}

function structuredError(
  toolName: string,
  type: ToolErrorType,
  message: string,
  options: { path?: string; cwd?: string; retryable?: boolean } = {},
): ToolStructuredError {
  return {
    type,
    message,
    retryable: options.retryable ?? false,
    toolName,
    path: options.path,
    cwd: options.cwd,
  };
}

function redactUnexpectedError(context: AnyGitContext, error: unknown): string {
  const raw = error instanceof Error ? error.message : String(error);
  return redactGitText(raw).split(path.resolve(context.workspaceRoot)).join("<workspace>");
}

function auditDetails(details: Record<string, unknown> | undefined): Record<string, unknown> {
  if (!details) return {};
  const allowed = [
    "path",
    "branch",
    "revision",
    "mode",
    "startLine",
    "endLine",
    "startPoint",
    "createBranch",
    "allowedRoot",
    "maxChars",
  ];
  const summary: Record<string, unknown> = {};
  for (const key of allowed) {
    const value = details[key];
    if (typeof value === "string") summary[key] = value.slice(0, 1_000);
    else if (typeof value === "number" || typeof value === "boolean") summary[key] = value;
  }
  return summary;
}

function operationResult<TDetails extends Record<string, unknown>>(
  context: RuntimeToolExecutionContext,
  input: {
    toolName: string;
    action: string;
    startedAt: string;
    startedMs: number;
    repository: GitRepositorySnapshot;
    status: GitOperationStatus;
    changedPaths?: string[];
    headBefore?: GitRepositorySnapshot["head"];
    headAfter?: GitRepositorySnapshot["head"];
    details?: TDetails;
    error?: ToolStructuredError;
  },
): ToolResult<GitOperationResult<TDetails>> {
  const durationMs = Math.max(0, Date.now() - input.startedMs);
  const body: GitOperationResult<TDetails> = {
    kind: "git_operation",
    toolName: input.toolName,
    action: input.action,
    status: input.status,
    repository: input.repository,
    headBefore: input.headBefore,
    headAfter: input.headAfter,
    changedPaths: [...new Set(input.changedPaths ?? [])].sort(),
    conflict: input.repository.conflict,
    durationMs,
    details: input.details,
    error: input.error,
  };
  const success = input.status === "completed" || input.status === "unchanged";
  return {
    toolName: input.toolName,
    callId: context.callId,
    startedAt: input.startedAt,
    endedAt: now(context),
    success,
    output: JSON.stringify(body),
    structuredContent: body,
    operationAudit: {
      action: input.action,
      argumentSummary: {
        status: input.status,
        ...auditDetails(input.details),
      },
      resultStatus: input.status,
      durationMs,
      headBefore: input.headBefore?.oid,
      headAfter: input.headAfter?.oid,
      changedPaths: body.changedPaths,
    },
    error: input.error?.message,
  };
}

function truncateText(result: GitCommandExecutionResult, maximum: number): TextDetails {
  const raw = result.stdout;
  const truncated = raw.length > maximum || result.outputTruncated === true;
  return {
    text: raw.length > maximum ? raw.slice(0, maximum) : raw,
    truncated,
    maxChars: maximum,
    command: result.display,
    outputTruncatedByRuntime: result.outputTruncated === true,
  };
}

function splitNullOrLines(output: string): string[] {
  const separator = output.includes("\0") ? /\0/gu : /\r?\n/gu;
  return output.split(separator).map((entry) => entry.trim()).filter(Boolean);
}

function stableGitDate(value: string): string {
  const timestamp = Date.parse(value);
  return Number.isFinite(timestamp) ? `@${Math.floor(timestamp / 1_000)}` : value;
}

async function safeRepositoryPath(
  context: RuntimeToolExecutionContext,
  snapshot: GitRepositorySnapshot,
  requestedPath: string,
): Promise<{ repositoryRelativePath: string; workspaceRelativePath: string }> {
  if (!snapshot.repositoryRoot) throw new Error("The Git repository root is unavailable.");
  const normalized = normalizeGitPath(requestedPath);
  const resolved = await resolveTrustedRepositoryPath(
    context.workspaceRoot,
    snapshot.repositoryRoot,
    normalized,
  );
  if (
    isProtectedReadPath(resolved.workspaceRelativePath) ||
    isProtectedReadPath(resolved.repositoryRelativePath) ||
    resolved.repositoryRelativePath === ".git" ||
    resolved.repositoryRelativePath.startsWith(".git/")
  ) {
    throw new Error(`Git history access is blocked for protected path: ${requestedPath}.`);
  }
  return resolved;
}

function containsProtectedRepositoryPath(
  snapshot: GitRepositorySnapshot,
  repositoryPath: string,
): boolean {
  if (!snapshot.repositoryRoot) return true;
  const workspacePath = path.posix.join(snapshot.repositoryRoot.replace(/\\/gu, "/"), repositoryPath);
  return isProtectedReadPath(repositoryPath) || isProtectedReadPath(workspacePath) ||
    repositoryPath === ".git" || repositoryPath.startsWith(".git/");
}

function repositoryRootAbsolute(context: AnyGitContext, snapshot: GitRepositorySnapshot): string {
  if (!snapshot.repositoryRoot) throw new Error("The Git repository root is unavailable.");
  return moduleContext(context).paths.resolveWorkspace(snapshot.repositoryRoot);
}

function mutationLockKey(context: AnyGitContext, snapshot: GitRepositorySnapshot): string {
  if (snapshot.commonDirTrusted && snapshot.commonDir) {
    return moduleContext(context).paths.resolveWorkspace(snapshot.commonDir);
  }
  return repositoryRootAbsolute(context, snapshot);
}

async function verifyCommit(
  git: GitRepositoryContext,
  root: string,
  revision: string,
): Promise<GitCommandExecutionResult> {
  const safeRevision = validateGitRevision(revision);
  return runGit(
    git,
    root,
    ["rev-parse", "--verify", "--quiet", `${safeRevision}^{commit}`],
    "Validate a local Git revision",
    8_192,
  );
}

async function inspectCommitTreePaths(
  git: GitRepositoryContext,
  root: string,
  commitOid: string,
): Promise<{ result: GitCommandExecutionResult; paths: string[] }> {
  const result = await runGit(
    git,
    root,
    ["ls-tree", "-r", "--name-only", "-z", commitOid],
    "Enumerate a bounded immutable worktree commit tree",
    500_000,
  );
  return {
    result,
    paths: result.success && !result.outputTruncated
      ? result.stdout.split("\0").map((entry) => entry.replace(/\\/gu, "/")).filter(Boolean)
      : [],
  };
}

async function protectedDescendant(root: string): Promise<string | undefined> {
  const pending: Array<{ absolute: string; relative: string }> = [{ absolute: root, relative: "" }];
  let visited = 0;
  while (pending.length > 0) {
    const current = pending.pop()!;
    let entries;
    try {
      entries = await fs.readdir(current.absolute, { withFileTypes: true });
    } catch {
      throw new Error(`Unable to enumerate managed worktree path safely: ${current.relative || "."}.`);
    }
    for (const entry of entries) {
      const relative = current.relative ? `${current.relative}/${entry.name}` : entry.name;
      if (relative === ".git") continue;
      visited += 1;
      if (visited > 100_000) throw new Error("Managed worktree path enumeration exceeded 100000 entries.");
      if (isProtectedReadPath(relative)) return relative;
      if (entry.isDirectory() && !entry.isSymbolicLink()) {
        pending.push({ absolute: path.join(current.absolute, entry.name), relative });
      }
    }
  }
  return undefined;
}

function pathScopeDigest(paths: readonly string[]): string {
  return createHash("sha256").update(JSON.stringify([...new Set(paths)].sort())).digest("hex");
}

async function preflightShowPaths(
  git: GitRepositoryContext,
  root: string,
  revision: string,
): Promise<GitCommandExecutionResult> {
  return runGit(
    git,
    root,
    ["show", "--no-color", "--format=", "--name-only", "-z", "--max-count", "1", revision],
    "Inspect paths touched by a local revision before showing history",
    200_000,
  );
}

async function executeGitHistory(
  rawArgs: unknown,
  context: RuntimeToolExecutionContext,
): Promise<ToolResult<GitOperationResult<Record<string, unknown>>>> {
  const startedAt = now(context);
  const startedMs = Date.now();
  let action = "unknown";
  let snapshot = emptySnapshot(context);
  try {
    const args = parseHistoryArguments(rawArgs);
    action = args.action;
    const captured = await snapshotFor(context, args.cwd ?? ".");
    snapshot = captured.snapshot;
    if (!snapshot.isRepository) {
      return operationResult(context, {
        toolName: "git_history",
        action,
        startedAt,
        startedMs,
        repository: snapshot,
        status: "not_found",
        error: structuredError("git_history", "not_found", "No trusted local Git repository was found at cwd.", {
          cwd: snapshot.cwd,
        }),
      });
    }
    if (!snapshot.gitDirTrusted || !snapshot.commonDirTrusted) {
      return operationResult(context, {
        toolName: "git_history",
        action,
        startedAt,
        startedMs,
        repository: snapshot,
        status: "protected",
        error: structuredError(
          "git_history",
          "invalid_path",
          "Git history is blocked because repository metadata resolves outside the trusted workspace.",
        ),
      });
    }
    const root = repositoryRootAbsolute(context, snapshot);
    const maximum = args.maxChars ?? DEFAULT_HISTORY_CHARS;

    if (args.action === "log") {
      const commandArgs = [
        "log",
        "--no-color",
        "--date=iso-strict",
        "--format=%H%x09%h%x09%aN%x09%aE%x09%aI%x09%s",
        "--max-count",
        String(args.limit ?? DEFAULT_HISTORY_LIMIT),
      ];
      if (args.author) commandArgs.push("--author", args.author);
      if (args.since) commandArgs.push("--since", stableGitDate(args.since));
      if (args.until) commandArgs.push("--until", stableGitDate(args.until));
      if (args.path) {
        const safePath = await safeRepositoryPath(context, snapshot, args.path);
        commandArgs.push("--", literalGitPathspec(safePath.repositoryRelativePath));
      }
      const result = await runGit(captured.git, root, commandArgs, "Read bounded local Git history", maximum);
      if (!result.success) {
        return operationResult(context, {
          toolName: "git_history",
          action,
          startedAt,
          startedMs,
          repository: snapshot,
          status: snapshot.head.unborn ? "not_found" : "failed",
          error: commandError(
            "git_history",
            result,
            snapshot.head.unborn ? "The repository has no commits to list." : "Unable to read local Git history.",
            snapshot.head.unborn ? "not_found" : "command_failed",
          ),
        });
      }
      return operationResult(context, {
        toolName: "git_history",
        action,
        startedAt,
        startedMs,
        repository: snapshot,
        status: "completed",
        details: truncateText(result, maximum) as unknown as Record<string, unknown>,
      });
    }

    const revision = validateGitRevision(args.revision ?? "HEAD");
    const revisionProbe = await verifyCommit(captured.git, root, revision);
    if (!revisionProbe.success) {
      return operationResult(context, {
        toolName: "git_history",
        action,
        startedAt,
        startedMs,
        repository: snapshot,
        status: "not_found",
        error: commandError(
          "git_history",
          revisionProbe,
          `Local Git revision was not found: ${revision}.`,
          "not_found",
        ),
      });
    }

    if (args.action === "show") {
      const mode = args.mode ?? "summary";
      let safePath: Awaited<ReturnType<typeof safeRepositoryPath>> | undefined;
      if (args.path) safePath = await safeRepositoryPath(context, snapshot, args.path);
      if (mode === "content" && !safePath) {
        throw new Error("git_history show mode=content requires an explicit path.");
      }
      if (!safePath) {
        const paths = await preflightShowPaths(captured.git, root, revision);
        if (!paths.success || paths.outputTruncated) {
          return operationResult(context, {
            toolName: "git_history",
            action,
            startedAt,
            startedMs,
            repository: snapshot,
            status: "failed",
            error: paths.outputTruncated
              ? structuredError(
                  "git_history",
                  "invalid_state",
                  "The requested revision path set exceeded the bounded preflight; history output was not exposed.",
                )
              : commandError("git_history", paths, "Unable to inspect paths for the requested revision."),
          });
        }
        if (splitNullOrLines(paths.stdout).some((entry) => containsProtectedRepositoryPath(snapshot, entry))) {
          return operationResult(context, {
            toolName: "git_history",
            action,
            startedAt,
            startedMs,
            repository: snapshot,
            status: "protected",
            error: structuredError(
              "git_history",
              "invalid_path",
              "The requested revision touches a protected path; specify a safe explicit path instead.",
            ),
          });
        }
      }
      const commandArgs = mode === "content"
        ? ["show", `${revision}:${safePath!.repositoryRelativePath}`]
        : [
          "show",
          "--no-color",
          "--format=fuller",
          "--max-count",
          "1",
          ...(mode === "diff" ? ["--patch", "--stat"] : ["--summary", "--stat"]),
          revision,
          ...(safePath ? ["--", literalGitPathspec(safePath.repositoryRelativePath)] : []),
        ];
      const result = await runGit(captured.git, root, commandArgs, "Show a bounded local Git revision", maximum);
      if (!result.success) {
        return operationResult(context, {
          toolName: "git_history",
          action,
          startedAt,
          startedMs,
          repository: snapshot,
          status: "not_found",
          error: commandError("git_history", result, "The requested revision or path was not found.", "not_found"),
        });
      }
      return operationResult(context, {
        toolName: "git_history",
        action,
        startedAt,
        startedMs,
        repository: snapshot,
        status: "completed",
        details: {
          ...truncateText(result, maximum),
          mode,
          revision,
          path: safePath?.repositoryRelativePath,
        },
      });
    }

    if (!args.path) throw new Error("git_history blame requires an explicit path.");
    const safePath = await safeRepositoryPath(context, snapshot, args.path);
    const startLine = args.startLine ?? 1;
    const endLine = args.endLine ?? startLine + 199;
    if (endLine < startLine || endLine - startLine + 1 > MAX_BLAME_LINES) {
      throw new Error(`git_history blame requires an ordered range of at most ${MAX_BLAME_LINES} lines.`);
    }
    const result = await runGit(
      captured.git,
      root,
      [
        "blame",
        "--line-porcelain",
        "-L",
        `${startLine},${endLine}`,
        revision,
        "--",
        safePath.repositoryRelativePath,
      ],
      "Read a bounded local Git blame range",
      maximum,
    );
    if (!result.success) {
      return operationResult(context, {
        toolName: "git_history",
        action,
        startedAt,
        startedMs,
        repository: snapshot,
        status: "not_found",
        error: commandError("git_history", result, "The requested blame path or range was not found.", "not_found"),
      });
    }
    return operationResult(context, {
      toolName: "git_history",
      action,
      startedAt,
      startedMs,
      repository: snapshot,
      status: "completed",
      details: {
        ...truncateText(result, maximum),
        revision,
        path: safePath.repositoryRelativePath,
        startLine,
        endLine,
      },
    });
  } catch (error) {
    const type: ToolErrorType = /protected path/iu.test(error instanceof Error ? error.message : "")
      ? "invalid_path"
      : /unavailable/iu.test(error instanceof Error ? error.message : "")
        ? "missing_dependency"
        : "invalid_arguments";
    return operationResult(context, {
      toolName: "git_history",
      action,
      startedAt,
      startedMs,
      repository: snapshot,
      status: type === "invalid_path" ? "protected" : "failed",
      error: structuredError("git_history", type, redactUnexpectedError(context, error)),
    });
  }
}

async function localBranchProbe(
  git: GitRepositoryContext,
  root: string,
  branch: string,
): Promise<GitCommandExecutionResult> {
  return runGit(
    git,
    root,
    ["show-ref", "--verify", "--quiet", `refs/heads/${branch}`],
    "Check whether a local Git branch exists",
    8_192,
  );
}

function parseBranchList(
  output: string,
  snapshot: GitRepositorySnapshot,
  protectedNames: readonly string[],
): BranchEntry[] {
  return output.split(/\r?\n/gu).filter(Boolean).map((line) => {
    const [name = "", oid = "", currentMarker = "", subject = ""] = line.split("\t");
    const worktree = snapshot.worktrees.find((entry) => entry.branch === name);
    return {
      name,
      oid,
      current: currentMarker.trim() === "*" || snapshot.head.branch === name,
      protected: isProtectedGitBranch(name, protectedNames),
      checkedOutAt: worktree?.path,
      subject: subject || undefined,
    };
  }).filter((entry) => entry.name.length > 0);
}

function approvalDigest(context: RuntimeToolExecutionContext): string | undefined {
  const value = context.approvalContext?.repositoryStateDigest;
  return typeof value === "string" ? value : undefined;
}

function staleApprovalResult(
  context: RuntimeToolExecutionContext,
  input: {
    toolName: string;
    action: string;
    startedAt: string;
    startedMs: number;
    repository: GitRepositorySnapshot;
    headBefore: GitRepositorySnapshot["head"];
  },
): ToolResult<GitOperationResult<Record<string, unknown>>> {
  return operationResult(context, {
    ...input,
    status: "invalid_state",
    error: structuredError(
      input.toolName,
      "invalid_state",
      "Repository state changed after approval; inspect the current snapshot and request approval again.",
    ),
  });
}

function invalidRepositoryMutation(
  context: RuntimeToolExecutionContext,
  input: {
    toolName: string;
    action: string;
    startedAt: string;
    startedMs: number;
    repository: GitRepositorySnapshot;
    message: string;
    type?: ToolErrorType;
    status?: GitOperationStatus;
    path?: string;
  },
): ToolResult<GitOperationResult<Record<string, unknown>>> {
  return operationResult(context, {
    toolName: input.toolName,
    action: input.action,
    startedAt: input.startedAt,
    startedMs: input.startedMs,
    repository: input.repository,
    status: input.status ?? "invalid_state",
    headBefore: input.repository.head,
    error: structuredError(input.toolName, input.type ?? "invalid_state", input.message, {
      path: input.path,
      cwd: input.repository.cwd,
    }),
  });
}

async function changedPathsBetween(
  git: GitRepositoryContext,
  root: string,
  before: string,
  after: string,
): Promise<{ paths: string[]; result: GitCommandExecutionResult }> {
  const result = await runGit(
    git,
    root,
    ["diff", "--name-only", "-z", before, after, "--"],
    "Inspect paths affected by a local branch switch",
    200_000,
  );
  return { paths: result.success ? splitNullOrLines(result.stdout) : [], result };
}

async function executeGitBranch(
  rawArgs: unknown,
  context: RuntimeToolExecutionContext,
): Promise<ToolResult<GitOperationResult<Record<string, unknown>>>> {
  const startedAt = now(context);
  const startedMs = Date.now();
  let action = "unknown";
  let snapshot = emptySnapshot(context);
  try {
    const args = parseBranchArguments(rawArgs);
    action = args.action;
    const captured = await snapshotFor(context, args.cwd ?? ".");
    snapshot = captured.snapshot;
    if (!snapshot.isRepository) {
      return operationResult(context, {
        toolName: "git_branch",
        action,
        startedAt,
        startedMs,
        repository: snapshot,
        status: "not_found",
        error: structuredError("git_branch", "not_found", "No trusted local Git repository was found at cwd."),
      });
    }
    if (!snapshot.gitDirTrusted || !snapshot.commonDirTrusted) {
      return invalidRepositoryMutation(context, {
        toolName: "git_branch",
        action,
        startedAt,
        startedMs,
        repository: snapshot,
        message: "Local branch access is blocked because Git metadata resolves outside the trusted workspace.",
        status: "protected",
      });
    }
    const root = repositoryRootAbsolute(context, snapshot);
    const protectedNames = protectedBranches(context);

    if (args.action === "list") {
      const result = await runGit(
        captured.git,
        root,
        [
          "for-each-ref",
          "--format=%(refname:short)%09%(objectname)%09%(HEAD)%09%(subject)",
          "--sort=refname",
          "refs/heads",
        ],
        "List bounded local Git branches",
        200_000,
      );
      if (!result.success) {
        return operationResult(context, {
          toolName: "git_branch",
          action,
          startedAt,
          startedMs,
          repository: snapshot,
          status: "failed",
          error: commandError("git_branch", result, "Unable to list local Git branches."),
        });
      }
      const branches = parseBranchList(result.stdout, snapshot, protectedNames);
      return operationResult(context, {
        toolName: "git_branch",
        action,
        startedAt,
        startedMs,
        repository: snapshot,
        status: "completed",
        details: {
          branches,
          current: snapshot.head.branch,
          detached: snapshot.head.detached,
          unborn: snapshot.head.unborn,
          truncated: result.outputTruncated === true,
        },
      });
    }

    if (!snapshot.stateComplete) {
      return invalidRepositoryMutation(context, {
        toolName: "git_branch",
        action,
        startedAt,
        startedMs,
        repository: snapshot,
        message: `Branch mutation is blocked because Git state inspection is incomplete: ${snapshot.stateFailures.join(", ")}.`,
      });
    }

    if (snapshot.isBare || snapshot.isSubmodule) {
      return invalidRepositoryMutation(context, {
        toolName: "git_branch",
        action,
        startedAt,
        startedMs,
        repository: snapshot,
        message: snapshot.isBare
          ? "Branch mutations are disabled for bare repositories."
          : "Branch mutations are disabled for submodules in phase 18.",
      });
    }
    if (snapshot.conflict.status === "conflicted") {
      return invalidRepositoryMutation(context, {
        toolName: "git_branch",
        action,
        startedAt,
        startedMs,
        repository: snapshot,
        message: "Branch mutations are blocked while the repository has an unresolved conflict operation.",
        type: "conflicted",
        status: "conflicted",
      });
    }
    if (!args.name) throw new Error(`git_branch ${action} requires name.`);
    const branch = validateGitBranchName(args.name);

    if ((args.action === "switch" || args.action === "delete") && snapshot.dirty) {
      return invalidRepositoryMutation(context, {
        toolName: "git_branch",
        action,
        startedAt,
        startedMs,
        repository: snapshot,
        message: `git_branch ${action} is blocked because staged, unstaged, untracked, or conflicted user changes exist.`,
      });
    }
    if ((args.action === "switch" || args.action === "delete") && snapshot.head.unborn) {
      return invalidRepositoryMutation(context, {
        toolName: "git_branch",
        action,
        startedAt,
        startedMs,
        repository: snapshot,
        message: `git_branch ${action} is unavailable while HEAD is unborn.`,
      });
    }
    if (args.action === "delete" && isProtectedGitBranch(branch, protectedNames)) {
      return invalidRepositoryMutation(context, {
        toolName: "git_branch",
        action,
        startedAt,
        startedMs,
        repository: snapshot,
        message: `Protected local branch cannot be deleted: ${branch}.`,
        type: "protected_branch",
        status: "protected",
      });
    }
    if (args.action === "delete" && snapshot.head.branch === branch) {
      return invalidRepositoryMutation(context, {
        toolName: "git_branch",
        action,
        startedAt,
        startedMs,
        repository: snapshot,
        message: `The current branch cannot be deleted: ${branch}.`,
      });
    }
    const occupied = snapshot.worktrees.find((entry) => entry.branch === branch);
    if (occupied && (
      args.action === "delete" ||
      (args.action === "switch" && occupied.path !== snapshot.repositoryRoot)
    )) {
      return invalidRepositoryMutation(context, {
        toolName: "git_branch",
        action,
        startedAt,
        startedMs,
        repository: snapshot,
        message: `Local branch ${branch} is already checked out at worktree ${occupied.path}.`,
      });
    }
    if (args.action === "switch" && snapshot.head.branch === branch) {
      return operationResult(context, {
        toolName: "git_branch",
        action,
        startedAt,
        startedMs,
        repository: snapshot,
        status: "unchanged",
        headBefore: snapshot.head,
        headAfter: snapshot.head,
        details: { branch },
      });
    }

    const existence = await localBranchProbe(captured.git, root, branch);
    if (args.action === "create" && existence.success) {
      return invalidRepositoryMutation(context, {
        toolName: "git_branch",
        action,
        startedAt,
        startedMs,
        repository: snapshot,
        message: `Local branch already exists: ${branch}.`,
      });
    }
    if (args.action !== "create" && !existence.success) {
      return operationResult(context, {
        toolName: "git_branch",
        action,
        startedAt,
        startedMs,
        repository: snapshot,
        status: "not_found",
        headBefore: snapshot.head,
        error: structuredError("git_branch", "not_found", `Local branch was not found: ${branch}.`),
      });
    }

    let startPoint = "HEAD";
    let targetOid: string | undefined;
    if (args.action === "create") {
      startPoint = validateGitRevision(args.startPoint ?? "HEAD");
      const startProbe = await verifyCommit(captured.git, root, startPoint);
      if (!startProbe.success) {
        return operationResult(context, {
          toolName: "git_branch",
          action,
          startedAt,
          startedMs,
          repository: snapshot,
          status: "not_found",
          headBefore: snapshot.head,
          error: commandError("git_branch", startProbe, `Branch start point was not found: ${startPoint}.`, "not_found"),
        });
      }
      targetOid = startProbe.stdout.trim();
    } else {
      const targetProbe = await verifyCommit(captured.git, root, branch);
      if (!targetProbe.success || targetProbe.outputTruncated) {
        return operationResult(context, {
          toolName: "git_branch",
          action,
          startedAt,
          startedMs,
          repository: snapshot,
          status: "not_found",
          headBefore: snapshot.head,
          error: commandError("git_branch", targetProbe, `Local branch target could not be resolved: ${branch}.`, "not_found"),
        });
      }
      targetOid = targetProbe.stdout.trim();
    }
    if (typeof context.approvalContext?.targetOid === "string" && context.approvalContext.targetOid !== targetOid) {
      return staleApprovalResult(context, {
        toolName: "git_branch",
        action,
        startedAt,
        startedMs,
        repository: snapshot,
        headBefore: snapshot.head,
      });
    }

    let switchPaths: string[] = [];
    if (args.action === "switch") {
      if (!snapshot.head.oid) {
        return invalidRepositoryMutation(context, {
          toolName: "git_branch",
          action,
          startedAt,
          startedMs,
          repository: snapshot,
          message: "Branch switch requires an existing HEAD commit.",
        });
      }
      const changed = await changedPathsBetween(captured.git, root, snapshot.head.oid, targetOid!);
      if (!changed.result.success || changed.result.outputTruncated) {
        return operationResult(context, {
          toolName: "git_branch",
          action,
          startedAt,
          startedMs,
          repository: snapshot,
          status: "failed",
          headBefore: snapshot.head,
          error: commandError(
            "git_branch",
            changed.result,
            "Unable to establish a complete bounded path set for branch switch.",
          ),
        });
      }
      switchPaths = changed.paths;
      if (typeof context.approvalContext?.changedPathScopeDigest === "string" &&
          context.approvalContext.changedPathScopeDigest !== pathScopeDigest(switchPaths)) {
        return staleApprovalResult(context, {
          toolName: "git_branch",
          action,
          startedAt,
          startedMs,
          repository: snapshot,
          headBefore: snapshot.head,
        });
      }
      const protectedPath = switchPaths.find((entry) => containsProtectedRepositoryPath(snapshot, entry));
      if (protectedPath) {
        return invalidRepositoryMutation(context, {
          toolName: "git_branch",
          action,
          startedAt,
          startedMs,
          repository: snapshot,
          message: `Branch switch would modify a protected path: ${protectedPath}.`,
          type: "invalid_path",
          status: "protected",
          path: protectedPath,
        });
      }
    }

    return withGitMutationLock(mutationLockKey(context, snapshot), async () => {
      const fresh = await captureGitRepositorySnapshot(
        captured.git,
        snapshot.repositoryRoot,
        protectedNames,
      );
      if (fresh.stateDigest !== approvalDigest(context)) {
        return staleApprovalResult(context, {
          toolName: "git_branch",
          action,
          startedAt,
          startedMs,
          repository: fresh,
          headBefore: snapshot.head,
        });
      }
      if ((args.action === "switch" || args.action === "delete") && fresh.dirty) {
        return invalidRepositoryMutation(context, {
          toolName: "git_branch",
          action,
          startedAt,
          startedMs,
          repository: fresh,
          message: `git_branch ${action} is blocked because the repository became dirty.`,
        });
      }
      const freshTarget = await verifyCommit(captured.git, root, args.action === "create" ? startPoint : branch);
      if (!freshTarget.success || freshTarget.outputTruncated || freshTarget.stdout.trim() !== targetOid) {
        return staleApprovalResult(context, {
          toolName: "git_branch",
          action,
          startedAt,
          startedMs,
          repository: fresh,
          headBefore: snapshot.head,
        });
      }
      if (args.action === "switch" && fresh.head.oid) {
        const freshChanged = await changedPathsBetween(captured.git, root, fresh.head.oid, targetOid!);
        if (!freshChanged.result.success || freshChanged.result.outputTruncated ||
            pathScopeDigest(freshChanged.paths) !== pathScopeDigest(switchPaths)) {
          return staleApprovalResult(context, {
            toolName: "git_branch",
            action,
            startedAt,
            startedMs,
            repository: fresh,
            headBefore: snapshot.head,
          });
        }
      }

      if (args.action === "delete") {
        const merged = await runGit(
          captured.git,
          root,
          ["merge-base", "--is-ancestor", targetOid!, "HEAD"],
          "Verify that a local branch is merged before deletion",
          8_192,
        );
        if (!merged.success) {
          return invalidRepositoryMutation(context, {
            toolName: "git_branch",
            action,
            startedAt,
            startedMs,
            repository: fresh,
            message: `Local branch is not fully merged into HEAD and cannot be deleted: ${branch}.`,
          });
        }
      }

      const commandArgs = args.action === "create"
        ? ["branch", branch, targetOid!]
        : args.action === "switch"
          ? ["switch", branch]
          : ["branch", "-d", branch];
      const result = await runGit(
        captured.git,
        root,
        commandArgs,
        `Perform approved local Git branch ${action}`,
        200_000,
      );
      if (!result.success) {
        const current = await captureGitRepositorySnapshot(
          captured.git,
          snapshot.repositoryRoot,
          protectedNames,
        );
        return operationResult(context, {
          toolName: "git_branch",
          action,
          startedAt,
          startedMs,
          repository: current,
          status: "invalid_state",
          headBefore: snapshot.head,
          headAfter: current.head,
          error: commandError("git_branch", result, `Unable to ${action} local branch ${branch}.`, "invalid_state"),
        });
      }
      const after = await captureGitRepositorySnapshot(
        captured.git,
        snapshot.repositoryRoot,
        protectedNames,
      );
      return operationResult(context, {
        toolName: "git_branch",
        action,
        startedAt,
        startedMs,
        repository: after,
        status: "completed",
        changedPaths: args.action === "switch" ? switchPaths : [],
        headBefore: snapshot.head,
        headAfter: after.head,
        details: {
          branch,
          startPoint: args.action === "create" ? startPoint : undefined,
          command: result.display,
        },
      });
    }, context.signal);
  } catch (error) {
    const type: ToolErrorType = /unavailable/iu.test(error instanceof Error ? error.message : "")
      ? "missing_dependency"
      : "invalid_arguments";
    return operationResult(context, {
      toolName: "git_branch",
      action,
      startedAt,
      startedMs,
      repository: snapshot,
      status: "failed",
      headBefore: snapshot.head,
      error: structuredError("git_branch", type, redactUnexpectedError(context, error)),
    });
  }
}

interface ManagedWorktreePath {
  absolutePath: string;
  workspaceRelativePath: string;
  allowedRoot: string;
}

async function nearestExistingAncestor(value: string): Promise<string> {
  let candidate = path.resolve(value);
  while (true) {
    try {
      await fs.lstat(candidate);
      return candidate;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
      const parent = path.dirname(candidate);
      if (parent === candidate) throw error;
      candidate = parent;
    }
  }
}

async function resolveManagedWorktreePath(
  context: AnyGitContext,
  requestedPath: string,
): Promise<ManagedWorktreePath> {
  const services = moduleContext(context);
  const normalized = normalizeGitPath(requestedPath);
  const configured = services.settings.git?.worktreeRoots;
  const roots = configured && configured.length > 0 ? configured : [".deep-mix/worktrees"];
  const usingExternalDefault = !configured || configured.length === 0;
  const absolutePath = usingExternalDefault && (normalized === ".deep-mix/worktrees" || normalized.startsWith(".deep-mix/worktrees/"))
    ? path.resolve(services.paths.resolveState("worktrees"), path.posix.relative(".deep-mix/worktrees", normalized))
    : services.paths.resolveWorkspace(normalized);
  let matched: { input: string; absolute: string } | undefined;
  for (const rootInput of roots) {
    const safeRoot = normalizeGitPath(rootInput, { allowDot: true });
    const absoluteRoot = usingExternalDefault
      ? services.paths.resolveState("worktrees")
      : services.paths.resolveWorkspace(safeRoot);
    if (path.resolve(absolutePath) !== path.resolve(absoluteRoot) && isInside(absoluteRoot, absolutePath)) {
      matched = { input: safeRoot, absolute: absoluteRoot };
      break;
    }
  }
  if (!matched) {
    throw new Error(`Worktree path is outside configured managed roots: ${requestedPath}.`);
  }
  const workspaceRelativePath = normalized;
  if (isProtectedReadPath(workspaceRelativePath)) {
    throw new Error(`Worktree path is protected: ${workspaceRelativePath}.`);
  }

  const trustRoot = usingExternalDefault ? services.paths.resolveState(".") : context.workspaceRoot;
  const [realTrustRoot, existingAncestor, rootAncestor] = await Promise.all([
    fs.realpath(trustRoot),
    nearestExistingAncestor(absolutePath),
    nearestExistingAncestor(matched.absolute),
  ]);
  const [realExistingAncestor, realRootAncestor] = await Promise.all([
    fs.realpath(existingAncestor),
    fs.realpath(rootAncestor),
  ]);
  if (!isInside(realTrustRoot, realExistingAncestor) || !isInside(realTrustRoot, realRootAncestor)) {
    throw new Error(`Worktree path resolves outside the trusted managed root: ${requestedPath}.`);
  }
  if (isInside(matched.absolute, existingAncestor) && !isInside(realRootAncestor, realExistingAncestor)) {
    throw new Error(`Worktree path crosses a symlink outside its managed root: ${requestedPath}.`);
  }
  return {
    absolutePath,
    workspaceRelativePath,
    allowedRoot: matched.input,
  };
}

async function pathExists(value: string): Promise<boolean> {
  try {
    await fs.lstat(value);
    return true;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return false;
    throw error;
  }
}

function findRegisteredWorktree(
  snapshot: GitRepositorySnapshot,
  workspaceRelativePath: string,
) {
  const normalized = workspaceRelativePath.replace(/\\/gu, "/");
  return snapshot.worktrees.find((entry) => entry.trusted && entry.path.replace(/\\/gu, "/") === normalized);
}

async function executeGitWorktree(
  rawArgs: unknown,
  context: RuntimeToolExecutionContext,
): Promise<ToolResult<GitOperationResult<Record<string, unknown>>>> {
  const startedAt = now(context);
  const startedMs = Date.now();
  let action = "unknown";
  let snapshot = emptySnapshot(context);
  try {
    const args = parseWorktreeArguments(rawArgs);
    action = args.action;
    const captured = await snapshotFor(context, args.cwd ?? ".");
    snapshot = captured.snapshot;
    if (!snapshot.isRepository) {
      return operationResult(context, {
        toolName: "git_worktree",
        action,
        startedAt,
        startedMs,
        repository: snapshot,
        status: "not_found",
        error: structuredError("git_worktree", "not_found", "No trusted local Git repository was found at cwd."),
      });
    }
    if (!snapshot.gitDirTrusted || !snapshot.commonDirTrusted) {
      return invalidRepositoryMutation(context, {
        toolName: "git_worktree",
        action,
        startedAt,
        startedMs,
        repository: snapshot,
        message: "Local worktree access is blocked because Git metadata resolves outside the trusted workspace.",
        status: "protected",
      });
    }
    if (args.action === "list") {
      return operationResult(context, {
        toolName: "git_worktree",
        action,
        startedAt,
        startedMs,
        repository: snapshot,
        status: "completed",
        details: {
          worktrees: snapshot.worktrees,
          count: snapshot.worktrees.length,
        },
      });
    }
    if (!snapshot.stateComplete) {
      return invalidRepositoryMutation(context, {
        toolName: "git_worktree",
        action,
        startedAt,
        startedMs,
        repository: snapshot,
        message: `Worktree mutation is blocked because Git state inspection is incomplete: ${snapshot.stateFailures.join(", ")}.`,
      });
    }
    if (snapshot.isBare || snapshot.isSubmodule) {
      return invalidRepositoryMutation(context, {
        toolName: "git_worktree",
        action,
        startedAt,
        startedMs,
        repository: snapshot,
        message: snapshot.isBare
          ? "Worktree mutations are disabled for bare repositories."
          : "Worktree mutations are disabled for submodules in phase 18.",
      });
    }
    if (snapshot.conflict.status === "conflicted") {
      return invalidRepositoryMutation(context, {
        toolName: "git_worktree",
        action,
        startedAt,
        startedMs,
        repository: snapshot,
        message: "Worktree mutations are blocked while the repository has an unresolved conflict operation.",
        type: "conflicted",
        status: "conflicted",
      });
    }
    if (snapshot.dirty) {
      return invalidRepositoryMutation(context, {
        toolName: "git_worktree",
        action,
        startedAt,
        startedMs,
        repository: snapshot,
        message: `git_worktree ${action} is blocked because the source worktree contains user changes.`,
      });
    }
    if (!args.path) throw new Error(`git_worktree ${action} requires an explicit path.`);
    const managedPath = await resolveManagedWorktreePath(context, args.path);
    const root = repositoryRootAbsolute(context, snapshot);
    const protectedNames = protectedBranches(context);

    if (args.action === "remove") {
      const registered = findRegisteredWorktree(snapshot, managedPath.workspaceRelativePath);
      if (!registered) {
        return operationResult(context, {
          toolName: "git_worktree",
          action,
          startedAt,
          startedMs,
          repository: snapshot,
          status: "not_found",
          headBefore: snapshot.head,
          error: structuredError(
            "git_worktree",
            "not_found",
            `Managed worktree was not found: ${managedPath.workspaceRelativePath}.`,
            { path: managedPath.workspaceRelativePath },
          ),
        });
      }
      const primaryPath = snapshot.worktrees[0]?.path;
      if (
        registered.path === snapshot.repositoryRoot ||
        registered.path === primaryPath ||
        path.resolve(managedPath.absolutePath) === path.resolve(root)
      ) {
        return invalidRepositoryMutation(context, {
          toolName: "git_worktree",
          action,
          startedAt,
          startedMs,
          repository: snapshot,
          message: "The primary or current worktree cannot be removed.",
          path: managedPath.workspaceRelativePath,
        });
      }
      if (registered.locked) {
        return invalidRepositoryMutation(context, {
          toolName: "git_worktree",
          action,
          startedAt,
          startedMs,
          repository: snapshot,
          message: `Locked worktree cannot be removed: ${managedPath.workspaceRelativePath}.`,
          path: managedPath.workspaceRelativePath,
        });
      }
      const targetSnapshot = await captureGitRepositorySnapshot(
        captured.git,
        managedPath.workspaceRelativePath,
        protectedNames,
      );
      if (!targetSnapshot.isRepository || !targetSnapshot.gitDirTrusted || !targetSnapshot.commonDirTrusted ||
          !targetSnapshot.stateComplete || targetSnapshot.commonDir !== snapshot.commonDir ||
          targetSnapshot.dirty || targetSnapshot.conflict.status === "conflicted") {
        return invalidRepositoryMutation(context, {
          toolName: "git_worktree",
          action,
          startedAt,
          startedMs,
          repository: snapshot,
          message: !targetSnapshot.isRepository
            ? "The registered worktree target is not a readable trusted repository."
            : "Worktree removal is blocked because the target contains user changes or conflicts.",
          path: managedPath.workspaceRelativePath,
        });
      }
      const protectedTargetPath = await protectedDescendant(managedPath.absolutePath);
      if (protectedTargetPath) {
        return invalidRepositoryMutation(context, {
          toolName: "git_worktree",
          action,
          startedAt,
          startedMs,
          repository: snapshot,
          message: `Managed worktree contains a protected runtime path and cannot be removed: ${protectedTargetPath}.`,
          type: "invalid_path",
          status: "protected",
          path: protectedTargetPath,
        });
      }

      return withGitMutationLock(mutationLockKey(context, snapshot), async () => {
        const fresh = await captureGitRepositorySnapshot(
          captured.git,
          snapshot.repositoryRoot,
          protectedNames,
        );
        if (fresh.stateDigest !== approvalDigest(context)) {
          return staleApprovalResult(context, {
            toolName: "git_worktree",
            action,
            startedAt,
            startedMs,
            repository: fresh,
            headBefore: snapshot.head,
          });
        }
        if (fresh.dirty) {
          return invalidRepositoryMutation(context, {
            toolName: "git_worktree",
            action,
            startedAt,
            startedMs,
            repository: fresh,
            message: "Worktree removal is blocked because the source worktree became dirty.",
          });
        }
        const freshTarget = await captureGitRepositorySnapshot(
          captured.git,
          managedPath.workspaceRelativePath,
          protectedNames,
        );
        if (!freshTarget.isRepository || !freshTarget.gitDirTrusted || !freshTarget.commonDirTrusted ||
            !freshTarget.stateComplete || freshTarget.commonDir !== fresh.commonDir ||
            freshTarget.dirty || freshTarget.conflict.status === "conflicted") {
          return invalidRepositoryMutation(context, {
            toolName: "git_worktree",
            action,
            startedAt,
            startedMs,
            repository: fresh,
            message: "Worktree removal is blocked because the target became dirty or conflicted.",
            path: managedPath.workspaceRelativePath,
          });
        }
        const freshProtectedTargetPath = await protectedDescendant(managedPath.absolutePath);
        if (freshProtectedTargetPath) {
          return invalidRepositoryMutation(context, {
            toolName: "git_worktree",
            action,
            startedAt,
            startedMs,
            repository: fresh,
            message: `Managed worktree gained a protected runtime path after approval: ${freshProtectedTargetPath}.`,
            type: "invalid_path",
            status: "protected",
            path: freshProtectedTargetPath,
          });
        }
        const result = await runGit(
          captured.git,
          root,
          ["worktree", "remove", managedPath.absolutePath],
          "Remove an approved clean managed Git worktree",
          200_000,
        );
        const after = await captureGitRepositorySnapshot(
          captured.git,
          snapshot.repositoryRoot,
          protectedNames,
        );
        if (!result.success) {
          return operationResult(context, {
            toolName: "git_worktree",
            action,
            startedAt,
            startedMs,
            repository: after,
            status: "invalid_state",
            headBefore: snapshot.head,
            headAfter: after.head,
            error: commandError("git_worktree", result, "Unable to remove the managed worktree.", "invalid_state"),
          });
        }
        return operationResult(context, {
          toolName: "git_worktree",
          action,
          startedAt,
          startedMs,
          repository: after,
          status: "completed",
          changedPaths: [managedPath.workspaceRelativePath],
          headBefore: snapshot.head,
          headAfter: after.head,
          details: {
            path: managedPath.workspaceRelativePath,
            branch: registered.branch,
            command: result.display,
          },
        });
      }, context.signal);
    }

    if (await pathExists(managedPath.absolutePath)) {
      return invalidRepositoryMutation(context, {
        toolName: "git_worktree",
        action,
        startedAt,
        startedMs,
        repository: snapshot,
        message: `Worktree target path already exists: ${managedPath.workspaceRelativePath}.`,
        path: managedPath.workspaceRelativePath,
      });
    }
    if (!args.branch) throw new Error("git_worktree create requires branch.");
    const branch = validateGitBranchName(args.branch);
    const createBranch = args.createBranch === true;
    if (!createBranch && args.startPoint) {
      throw new Error("startPoint is only supported when createBranch=true.");
    }
    const revision = validateGitRevision(createBranch ? args.startPoint ?? "HEAD" : branch);
    const branchProbe = await localBranchProbe(captured.git, root, branch);
    if (createBranch && branchProbe.success) {
      return invalidRepositoryMutation(context, {
        toolName: "git_worktree",
        action,
        startedAt,
        startedMs,
        repository: snapshot,
        message: `New worktree branch already exists: ${branch}.`,
      });
    }
    if (!createBranch && !branchProbe.success) {
      return operationResult(context, {
        toolName: "git_worktree",
        action,
        startedAt,
        startedMs,
        repository: snapshot,
        status: "not_found",
        headBefore: snapshot.head,
        error: structuredError("git_worktree", "not_found", `Local worktree branch was not found: ${branch}.`),
      });
    }
    const occupied = snapshot.worktrees.find((entry) => entry.branch === branch);
    if (occupied) {
      return invalidRepositoryMutation(context, {
        toolName: "git_worktree",
        action,
        startedAt,
        startedMs,
        repository: snapshot,
        message: `Local branch ${branch} is already checked out at worktree ${occupied.path}.`,
      });
    }
    const revisionProbe = await verifyCommit(captured.git, root, revision);
    if (!revisionProbe.success) {
      return operationResult(context, {
        toolName: "git_worktree",
        action,
        startedAt,
        startedMs,
        repository: snapshot,
        status: "not_found",
        headBefore: snapshot.head,
        error: commandError("git_worktree", revisionProbe, `Worktree start point was not found: ${revision}.`, "not_found"),
      });
    }
    const targetOid = revisionProbe.stdout.trim();
    const treeScope = await inspectCommitTreePaths(captured.git, root, targetOid);
    if (!treeScope.result.success || treeScope.result.outputTruncated) {
      return operationResult(context, {
        toolName: "git_worktree",
        action,
        startedAt,
        startedMs,
        repository: snapshot,
        status: "failed",
        headBefore: snapshot.head,
        error: treeScope.result.outputTruncated
          ? structuredError("git_worktree", "invalid_state", "Worktree target tree exceeded the bounded path preflight.")
          : commandError("git_worktree", treeScope.result, "Unable to inspect the worktree target tree."),
      });
    }
    const protectedTreePath = treeScope.paths.find((entry) => containsProtectedRepositoryPath(snapshot, entry));
    if (protectedTreePath) {
      return invalidRepositoryMutation(context, {
        toolName: "git_worktree",
        action,
        startedAt,
        startedMs,
        repository: snapshot,
        message: `Worktree target tree contains a protected runtime path: ${protectedTreePath}.`,
        type: "invalid_path",
        status: "protected",
        path: protectedTreePath,
      });
    }
    const approvedTargetOid = context.approvalContext?.targetOid;
    const approvedTreeDigest = context.approvalContext?.treeScopeDigest;
    if ((typeof approvedTargetOid === "string" && approvedTargetOid !== targetOid) ||
        (typeof approvedTreeDigest === "string" && approvedTreeDigest !== pathScopeDigest(treeScope.paths))) {
      return staleApprovalResult(context, {
        toolName: "git_worktree",
        action,
        startedAt,
        startedMs,
        repository: snapshot,
        headBefore: snapshot.head,
      });
    }

    return withGitMutationLock(mutationLockKey(context, snapshot), async () => {
      const fresh = await captureGitRepositorySnapshot(
        captured.git,
        snapshot.repositoryRoot,
        protectedNames,
      );
      if (fresh.stateDigest !== approvalDigest(context)) {
        return staleApprovalResult(context, {
          toolName: "git_worktree",
          action,
          startedAt,
          startedMs,
          repository: fresh,
          headBefore: snapshot.head,
        });
      }
      if (fresh.dirty) {
        return invalidRepositoryMutation(context, {
          toolName: "git_worktree",
          action,
          startedAt,
          startedMs,
          repository: fresh,
          message: "Worktree creation is blocked because the source worktree became dirty.",
        });
      }
      if (await pathExists(managedPath.absolutePath)) {
        return invalidRepositoryMutation(context, {
          toolName: "git_worktree",
          action,
          startedAt,
          startedMs,
          repository: fresh,
          message: `Worktree target path appeared after approval: ${managedPath.workspaceRelativePath}.`,
          path: managedPath.workspaceRelativePath,
        });
      }
      const currentBranchProbe = await localBranchProbe(captured.git, root, branch);
      if ((createBranch && currentBranchProbe.success) || (!createBranch && !currentBranchProbe.success)) {
        return invalidRepositoryMutation(context, {
          toolName: "git_worktree",
          action,
          startedAt,
          startedMs,
          repository: fresh,
          message: `Worktree branch state changed after approval: ${branch}.`,
        });
      }
      if (fresh.worktrees.some((entry) => entry.branch === branch)) {
        return invalidRepositoryMutation(context, {
          toolName: "git_worktree",
          action,
          startedAt,
          startedMs,
          repository: fresh,
          message: `Worktree branch became occupied after approval: ${branch}.`,
        });
      }
      const freshRevision = await verifyCommit(captured.git, root, createBranch ? revision : branch);
      if (!freshRevision.success || freshRevision.stdout.trim() !== targetOid) {
        return staleApprovalResult(context, {
          toolName: "git_worktree",
          action,
          startedAt,
          startedMs,
          repository: fresh,
          headBefore: snapshot.head,
        });
      }
      const freshTreeScope = await inspectCommitTreePaths(captured.git, root, targetOid);
      if (!freshTreeScope.result.success || freshTreeScope.result.outputTruncated ||
          pathScopeDigest(freshTreeScope.paths) !== pathScopeDigest(treeScope.paths) ||
          freshTreeScope.paths.some((entry) => containsProtectedRepositoryPath(fresh, entry))) {
        return invalidRepositoryMutation(context, {
          toolName: "git_worktree",
          action,
          startedAt,
          startedMs,
          repository: fresh,
          message: "Worktree target tree could not be revalidated safely after approval.",
          type: "invalid_path",
          status: "protected",
        });
      }
      const commandArgs = createBranch
        ? ["worktree", "add", "-b", branch, managedPath.absolutePath, targetOid]
        : ["worktree", "add", managedPath.absolutePath, branch];
      const result = await runGit(
        captured.git,
        root,
        commandArgs,
        "Create an approved bounded local Git worktree",
        200_000,
      );
      const after = await captureGitRepositorySnapshot(
        captured.git,
        snapshot.repositoryRoot,
        protectedNames,
      );
      if (!result.success) {
        return operationResult(context, {
          toolName: "git_worktree",
          action,
          startedAt,
          startedMs,
          repository: after,
          status: "invalid_state",
          headBefore: snapshot.head,
          headAfter: after.head,
          error: commandError("git_worktree", result, "Unable to create the managed worktree.", "invalid_state"),
        });
      }
      return operationResult(context, {
        toolName: "git_worktree",
        action,
        startedAt,
        startedMs,
        repository: after,
        status: "completed",
        changedPaths: [managedPath.workspaceRelativePath],
        headBefore: snapshot.head,
        headAfter: after.head,
        details: {
          path: managedPath.workspaceRelativePath,
          allowedRoot: managedPath.allowedRoot,
          branch,
          revision: targetOid,
          createBranch,
          command: result.display,
        },
      });
    }, context.signal);
  } catch (error) {
    const message = redactUnexpectedError(context, error);
    const type: ToolErrorType = /outside|escapes|protected|symlink/iu.test(message)
      ? "invalid_path"
      : /unavailable/iu.test(message)
        ? "missing_dependency"
        : "invalid_arguments";
    return operationResult(context, {
      toolName: "git_worktree",
      action,
      startedAt,
      startedMs,
      repository: snapshot,
      status: type === "invalid_path" ? "protected" : "failed",
      headBefore: snapshot.head,
      error: structuredError("git_worktree", type, message),
    });
  }
}

async function getGitAvailability(
  context: ToolModuleContext,
  toolName: string,
): Promise<ToolAvailability> {
  const capability = await context.capabilities.get("git");
  if (capability?.available) return { status: "available", available: true };
  return {
    status: "unavailable",
    available: false,
    missingCapabilities: ["git"],
    reason: `Missing executable required by ${toolName}: git.`,
  };
}

function argumentSummary(
  rawArgs: unknown,
  fields: readonly string[],
): Record<string, unknown> {
  if (!rawArgs || typeof rawArgs !== "object" || Array.isArray(rawArgs)) return {};
  const raw = rawArgs as Record<string, unknown>;
  const summary: Record<string, unknown> = {};
  for (const field of fields) {
    const value = raw[field];
    if (typeof value === "string") summary[field] = value.slice(0, 1_000);
    else if (typeof value === "number" || typeof value === "boolean") summary[field] = value;
  }
  return summary;
}

async function resolveMutationPermission(
  toolName: "git_branch" | "git_worktree",
  rawArgs: unknown,
  context: ToolAccessResolutionContext,
): Promise<ToolPermissionProfile> {
  const raw = rawArgs && typeof rawArgs === "object" && !Array.isArray(rawArgs)
    ? rawArgs as Record<string, unknown>
    : {};
  const action = typeof raw.action === "string" ? raw.action : "unknown";
  if (action === "list") {
    return {
      permissionCategory: "read_only",
      sideEffectLevel: "none",
      readOnly: true,
    };
  }
  const cwd = typeof raw.cwd === "string" && raw.cwd.length > 0 ? raw.cwd : ".";
  let digest = createHash("sha256").update(`unavailable:${toolName}:${action}`).digest("hex");
  let targetOid: string | undefined;
  let treeScopeDigest: string | undefined;
  let changedPathScopeDigest: string | undefined;
  try {
    const captured = await snapshotFor(context, cwd);
    digest = captured.snapshot.stateDigest;
    if (captured.snapshot.isRepository && captured.snapshot.repositoryRoot &&
        captured.snapshot.gitDirTrusted && captured.snapshot.commonDirTrusted) {
      const root = repositoryRootAbsolute(context, captured.snapshot);
      if (toolName === "git_branch") {
        const args = parseBranchArguments(rawArgs);
        if (args.action !== "list") {
          const revision = args.action === "create" ? args.startPoint ?? "HEAD" : args.name;
          if (revision) {
            const probe = await verifyCommit(captured.git, root, validateGitRevision(revision));
            if (probe.success && !probe.outputTruncated) targetOid = probe.stdout.trim() || undefined;
          }
          if (args.action === "switch" && captured.snapshot.head.oid && targetOid) {
            const changed = await changedPathsBetween(captured.git, root, captured.snapshot.head.oid, targetOid);
            if (changed.result.success && !changed.result.outputTruncated) {
              changedPathScopeDigest = pathScopeDigest(changed.paths);
            }
          }
        }
      } else {
        const args = parseWorktreeArguments(rawArgs);
        if (args.action === "create" && args.branch) {
          const revision = args.createBranch === true ? args.startPoint ?? "HEAD" : args.branch;
          const probe = await verifyCommit(captured.git, root, validateGitRevision(revision));
          if (probe.success && !probe.outputTruncated) {
            targetOid = probe.stdout.trim() || undefined;
            if (targetOid) {
              const tree = await inspectCommitTreePaths(captured.git, root, targetOid);
              if (tree.result.success && !tree.result.outputTruncated) treeScopeDigest = pathScopeDigest(tree.paths);
            }
          }
        }
      }
    }
  } catch {
    // Execution will return the bounded structured error. Mutation permission
    // remains high risk even if the preliminary repository snapshot fails.
  }
  const fields = toolName === "git_branch"
    ? ["action", "cwd", "name", "startPoint"]
    : ["action", "cwd", "path", "branch", "startPoint", "createBranch"];
  const summary = argumentSummary(rawArgs, fields);
  const paths = toolName === "git_worktree" && typeof raw.path === "string" ? [raw.path] : undefined;
  const revisions = [raw.name, raw.branch, raw.startPoint]
    .filter((value): value is string => typeof value === "string")
    .map((value) => value.slice(0, 512));
  return {
    permissionCategory: "execute_command",
    sideEffectLevel: "high",
    readOnly: false,
    approvalContext: {
      repositoryStateDigest: digest,
      action,
      targetOid,
      treeScopeDigest,
      changedPathScopeDigest,
    },
    approvalPresentation: {
      action,
      summary: `${toolName} will perform approved local ${action} state changes only.`,
      paths,
      revisions: revisions.length > 0 ? revisions : undefined,
      argumentSummary: summary,
    },
  };
}

function commandAccess(
  context: ToolAccessResolutionContext,
  cwd: string,
  command: string,
  reason: string,
) {
  return {
    kind: "command_execute" as const,
    cwd: context.paths.normalize(cwd),
    command,
    reason,
  };
}

function safeFilesystemAccessPath(
  context: ToolAccessResolutionContext,
  requestedPath: string,
): string | undefined {
  try {
    const absolutePath = context.paths.resolveWorkspace(requestedPath);
    return normalizedWorkspacePath(context.workspaceRoot, absolutePath);
  } catch {
    return undefined;
  }
}

export const gitHistoryTool: RuntimeToolSpec = {
  name: "git_history",
  description: "Read bounded local Git log, show, or blame history without remote access.",
  inputSchema: {
    type: "object",
    additionalProperties: false,
    required: ["action"],
    properties: {
      action: { type: "string", enum: ["log", "show", "blame"] },
      cwd: { type: "string", maxLength: 8_192 },
      limit: { type: "integer", minimum: 1, maximum: MAX_HISTORY_LIMIT },
      path: { type: "string", minLength: 1, maxLength: 8_192 },
      author: { type: "string", minLength: 1, maxLength: 512 },
      since: { type: "string", minLength: 1, maxLength: 512 },
      until: { type: "string", minLength: 1, maxLength: 512 },
      revision: { type: "string", minLength: 1, maxLength: 512 },
      mode: { type: "string", enum: ["summary", "diff", "content"] },
      startLine: { type: "integer", minimum: 1, maximum: 10_000_000 },
      endLine: { type: "integer", minimum: 1, maximum: 10_000_000 },
      maxChars: { type: "integer", minimum: 256, maximum: MAX_HISTORY_CHARS },
    },
  },
  readOnly: true,
  permissionCategory: "read_only",
  sideEffectLevel: "none",
  timeoutCategory: "default",
  groups: ["git", "repository", "history"],
  selection: {
    groups: ["git", "repository", "history"],
    keywords: [
      "git history",
      "git log",
      "git show",
      "git blame",
      "commit history",
      "提交历史",
      "代码追溯",
    ],
    planModeActions: ["log", "show", "blame"],
  },
  capabilityRequirements: [{
    name: "git",
    required: true,
    reason: "git_history invokes only allowlisted local Git commands.",
  }],
  getAvailability: (context) => getGitAvailability(context, "git_history"),
  resolveAccess: (rawArgs, context) => {
    const summary = argumentSummary(rawArgs, ["cwd"]);
    const cwd = typeof summary.cwd === "string" ? summary.cwd : ".";
    return [commandAccess(
      context,
      cwd,
      "git <parameterized history action>",
      "Read bounded local Git history through the unified command builder.",
    )];
  },
  redactArguments: (rawArgs) => argumentSummary(rawArgs, [
    "action",
    "cwd",
    "limit",
    "path",
    "author",
    "since",
    "until",
    "revision",
    "mode",
    "startLine",
    "endLine",
    "maxChars",
  ]),
  execute: executeGitHistory,
};

export const gitBranchTool: RuntimeToolSpec = {
  name: "git_branch",
  description: "List, create, switch, or safely delete local Git branches without force or remote operations.",
  inputSchema: {
    type: "object",
    additionalProperties: false,
    required: ["action"],
    properties: {
      action: { type: "string", enum: ["list", "create", "switch", "delete"] },
      cwd: { type: "string", maxLength: 8_192 },
      name: { type: "string", minLength: 1, maxLength: 255 },
      startPoint: { type: "string", minLength: 1, maxLength: 512 },
    },
  },
  readOnly: false,
  permissionCategory: "execute_command",
  sideEffectLevel: "high",
  timeoutCategory: "default",
  groups: ["git", "repository", "branch"],
  selection: {
    groups: ["git", "repository", "branch"],
    keywords: [
      "git branch",
      "create branch",
      "switch branch",
      "delete branch",
      "分支",
      "切换分支",
    ],
    planModeActions: ["list"],
  },
  capabilityRequirements: [{
    name: "git",
    required: true,
    reason: "git_branch invokes only allowlisted local Git commands.",
  }],
  getAvailability: (context) => getGitAvailability(context, "git_branch"),
  resolveAccess: (rawArgs, context) => {
    const summary = argumentSummary(rawArgs, ["action", "cwd"]);
    const cwd = typeof summary.cwd === "string" ? summary.cwd : ".";
    const requests: ToolAccessRequest[] = [commandAccess(
      context,
      cwd,
      "git <parameterized branch action>",
      "Inspect or mutate local Git branches through the unified command builder.",
    )];
    if (summary.action !== "list") {
      const writable = safeFilesystemAccessPath(context, cwd);
      if (writable) requests.push({
        kind: "filesystem_write",
        paths: [writable],
        reason: "An approved local branch mutation may update Git metadata or tracked worktree files.",
      });
    }
    return requests;
  },
  resolvePermission: (rawArgs, context) => resolveMutationPermission("git_branch", rawArgs, context),
  redactArguments: (rawArgs) => argumentSummary(rawArgs, ["action", "cwd", "name", "startPoint"]),
  execute: executeGitBranch,
};

export const gitWorktreeTool: RuntimeToolSpec = {
  name: "git_worktree",
  description: "List, create, or safely remove managed local Git worktrees without force or shell deletion.",
  inputSchema: {
    type: "object",
    additionalProperties: false,
    required: ["action"],
    properties: {
      action: { type: "string", enum: ["list", "create", "remove"] },
      cwd: { type: "string", maxLength: 8_192 },
      path: { type: "string", minLength: 1, maxLength: 8_192 },
      branch: { type: "string", minLength: 1, maxLength: 255 },
      startPoint: { type: "string", minLength: 1, maxLength: 512 },
      createBranch: { type: "boolean" },
    },
  },
  readOnly: false,
  permissionCategory: "execute_command",
  sideEffectLevel: "high",
  timeoutCategory: "slow",
  groups: ["git", "repository", "worktree"],
  selection: {
    groups: ["git", "repository", "worktree"],
    keywords: [
      "git worktree",
      "linked worktree",
      "create worktree",
      "remove worktree",
      "工作树",
      "多工作区",
    ],
    planModeActions: ["list"],
  },
  capabilityRequirements: [{
    name: "git",
    required: true,
    reason: "git_worktree invokes only allowlisted local Git commands.",
  }],
  getAvailability: (context) => getGitAvailability(context, "git_worktree"),
  resolveAccess: (rawArgs, context) => {
    const summary = argumentSummary(rawArgs, ["action", "cwd", "path"]);
    const cwd = typeof summary.cwd === "string" ? summary.cwd : ".";
    const requests: ToolAccessRequest[] = [commandAccess(
      context,
      cwd,
      "git <parameterized worktree action>",
      "Inspect or mutate managed local Git worktrees through the unified command builder.",
    )];
    if (summary.action !== "list" && typeof summary.path === "string") {
      const writable = safeFilesystemAccessPath(context, summary.path);
      if (writable) requests.push({
        kind: "filesystem_write",
        paths: [writable],
        reason: "An approved worktree mutation may create or remove only this explicit managed path.",
      });
    }
    return requests;
  },
  resolvePermission: (rawArgs, context) => resolveMutationPermission("git_worktree", rawArgs, context),
  redactArguments: (rawArgs) => argumentSummary(rawArgs, [
    "action",
    "cwd",
    "path",
    "branch",
    "startPoint",
    "createBranch",
  ]),
  execute: executeGitWorktree,
};
