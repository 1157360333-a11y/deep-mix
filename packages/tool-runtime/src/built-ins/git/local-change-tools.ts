import { createHash } from "node:crypto";
import { promises as fs } from "node:fs";
import path from "node:path";

import type {
  GitOperationPreview,
  GitOperationResult,
  GitRepositorySnapshot,
  ToolErrorType,
  ToolPermissionProfile,
  ToolResult,
  ToolStructuredError,
} from "../../../../shared-schema/src/index.js";
import { isProtectedReadPath } from "../../repository-explorer.js";
import type {
  RuntimeToolExecutionContext,
  RuntimeToolSpec,
  ToolAccessResolutionContext,
  ToolModuleContext,
} from "../../tool-module.js";

import {
  buildGitCommand,
  executeGitCommand,
  literalGitPathspec,
  normalizeGitPath,
  redactGitText,
  validateGitRevision,
  type GitCommandExecutionResult,
} from "./command-builder.js";
import {
  captureGitRepositorySnapshot,
  resolveTrustedRepositoryPath,
  withGitMutationLock,
} from "./repository-state.js";

interface GitBaseArguments {
  cwd?: string;
}

interface GitStageArguments extends GitBaseArguments {
  paths: string[];
  patch?: string;
}

interface GitCommitArguments extends GitBaseArguments {
  message: string;
  confirmationToken?: string;
}

type GitRestoreArea = "worktree" | "index" | "both";
type GitRestoreSource = "index" | "head" | "revision";

interface GitRestoreArguments extends GitBaseArguments {
  area: GitRestoreArea;
  source: GitRestoreSource;
  revision?: string;
  paths: string[];
}

type GitIntegrateAction = "merge" | "rebase" | "cherry_pick" | "revert";
type GitIntegrateMode = "start" | "continue" | "abort";

interface GitIntegrateArguments extends GitBaseArguments {
  action: GitIntegrateAction;
  mode?: GitIntegrateMode;
  target?: string;
  revisions?: string[];
  confirmationToken?: string;
}

interface GitPreparedPreview {
  snapshot: GitRepositorySnapshot;
  preview?: GitOperationPreview;
  error?: ToolStructuredError;
}

const MUTATION_ACCESS = "local_git_repository";
const PROTECTED_BRANCHES = ["main", "master"] as const;
const MAX_COMMIT_MESSAGE_CHARS = 20_000;
const MAX_PATCH_CHARS = 1_000_000;

function services(
  context: ToolAccessResolutionContext | RuntimeToolExecutionContext,
): ToolModuleContext {
  return "moduleContext" in context ? context.moduleContext : context;
}

function protectedBranches(context: ToolAccessResolutionContext | RuntimeToolExecutionContext): string[] {
  const configured = services(context).settings.git?.protectedBranches ?? [];
  return [...new Set([...PROTECTED_BRANCHES, ...configured])];
}

async function gitExecutable(
  context: ToolAccessResolutionContext | RuntimeToolExecutionContext,
): Promise<string | undefined> {
  const capability = await services(context).capabilities.get("git");
  return capability?.available ? capability.command : undefined;
}

async function snapshot(
  context: ToolAccessResolutionContext | RuntimeToolExecutionContext,
  cwd = ".",
): Promise<GitRepositorySnapshot> {
  const executable = await gitExecutable(context);
  if (!executable) {
    const capturedAt = services(context).clock.now();
    return {
      repositoryState: "not_repository",
      cwd: services(context).paths.normalize(cwd),
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
      stateDigest: createHash("sha256").update(`missing:${cwd}`).digest("hex"),
      capturedAt,
    };
  }
  return captureGitRepositorySnapshot({
    workspaceRoot: context.workspaceRoot,
    gitExecutable: executable,
    processes: services(context).processes,
    clock: services(context).clock,
    environment: services(context).environment,
  }, cwd, protectedBranches(context));
}

function mutableRepositoryError(toolName: string, repository: GitRepositorySnapshot): ToolStructuredError | undefined {
  if (!repository.isRepository) return structuredError("not_found", `${toolName} requires a Git repository.`, toolName, false);
  if (!repository.gitDirTrusted || !repository.commonDirTrusted || !repository.stateComplete) {
    return structuredError(
      "invalid_state",
      `${toolName} requires complete Git state and metadata contained by the trusted workspace.`,
      toolName,
      true,
      { details: repository.stateFailures.map((message) => ({ path: "repository_state", message })) },
    );
  }
  if (repository.isBare) return structuredError("invalid_state", `${toolName} does not mutate bare repositories.`, toolName, false);
  if (repository.isSubmodule) {
    return structuredError(
      "invalid_state",
      `${toolName} does not mutate a submodule worktree because the superproject state is outside this operation.`,
      toolName,
      false,
    );
  }
  return undefined;
}

function structuredError(
  type: ToolErrorType,
  message: string,
  toolName: string,
  retryable: boolean,
  extra: Partial<ToolStructuredError> = {},
): ToolStructuredError {
  return { type, message: redactGitText(message), retryable, toolName, ...extra };
}

function repositoryRoot(context: RuntimeToolExecutionContext, repository: GitRepositorySnapshot): string {
  if (!repository.repositoryRoot) throw new Error("Git repository root is unavailable.");
  return path.resolve(context.workspaceRoot, repository.repositoryRoot);
}

function mutationLockKey(context: RuntimeToolExecutionContext, repository: GitRepositorySnapshot): string {
  if (repository.commonDirTrusted && repository.commonDir) {
    return path.resolve(context.workspaceRoot, repository.commonDir);
  }
  return repositoryRoot(context, repository);
}

function normalizeExplicitPaths(paths: readonly string[]): string[] {
  if (paths.length === 0 || paths.length > 256) throw new Error("Git operations require 1-256 explicit paths.");
  const normalized = [...new Set(paths.map((value) => normalizeGitPath(value)))];
  for (const value of normalized) {
    if (isProtectedReadPath(value)) throw new Error(`Protected runtime path cannot be changed through Git tools: ${value}.`);
  }
  return normalized;
}

function isProtectedRepositoryMutationPath(repository: GitRepositorySnapshot, filePath: string): boolean {
  const normalized = filePath.replace(/\\/gu, "/");
  const workspacePath = repository.repositoryRoot
    ? path.posix.join(repository.repositoryRoot.replace(/\\/gu, "/"), normalized)
    : normalized;
  return normalized === ".git" || normalized.startsWith(".git/") ||
    isProtectedReadPath(normalized) || isProtectedReadPath(workspacePath);
}

function scopeDigest(paths: readonly string[]): string {
  return createHash("sha256").update(JSON.stringify([...new Set(paths)].sort())).digest("hex");
}

function statusForPath(repository: GitRepositorySnapshot, filePath: string): string {
  return JSON.stringify({
    staged: repository.staged.filter((entry) => entry.path === filePath),
    unstaged: repository.unstaged.filter((entry) => entry.path === filePath),
    untracked: repository.untracked.includes(filePath),
    conflicted: repository.conflicted.includes(filePath),
  });
}

function changedExplicitPaths(
  before: GitRepositorySnapshot,
  after: GitRepositorySnapshot,
  paths: readonly string[],
): string[] {
  return paths.filter((filePath) => statusForPath(before, filePath) !== statusForPath(after, filePath));
}

function changedSnapshotPaths(repository: GitRepositorySnapshot): string[] {
  return [...new Set([
    ...repository.staged.map((entry) => entry.path),
    ...repository.unstaged.map((entry) => entry.path),
    ...repository.untracked,
    ...repository.conflicted,
  ])].sort();
}

function approvedStateError(
  context: RuntimeToolExecutionContext,
  repository: GitRepositorySnapshot,
  toolName: string,
): ToolStructuredError | undefined {
  const expected = context.approvalContext?.stateDigest;
  if (typeof expected === "string" && expected !== repository.stateDigest) {
    return structuredError(
      "invalid_state",
      "Repository state changed after approval; inspect the new HEAD and dirty state before retrying.",
      toolName,
      true,
    );
  }
  return undefined;
}

function approvedScopeError(
  context: RuntimeToolExecutionContext,
  paths: readonly string[],
  toolName: string,
): ToolStructuredError | undefined {
  const expected = context.approvalContext?.scopeDigest;
  if (typeof expected === "string" && expected !== scopeDigest(paths)) {
    return structuredError(
      "invalid_state",
      "The exact Git path scope changed after approval; inspect and approve the new scope before retrying.",
      toolName,
      true,
    );
  }
  return undefined;
}

function result(
  context: RuntimeToolExecutionContext,
  startedAt: string,
  startedEpoch: number,
  body: Omit<GitOperationResult, "durationMs">,
  success: boolean,
): ToolResult<GitOperationResult> {
  const durationMs = Math.max(0, Date.now() - startedEpoch);
  const operationBody: GitOperationResult = { ...body, durationMs };
  return {
    toolName: body.toolName,
    callId: context.callId,
    startedAt,
    endedAt: context.moduleContext.clock.now(),
    success,
    output: JSON.stringify(operationBody),
    structuredContent: operationBody,
    operationAudit: {
      action: body.action,
      argumentSummary: context.approval.presentation?.argumentSummary ?? { action: body.action },
      resultStatus: body.status,
      durationMs,
      headBefore: body.headBefore?.oid,
      headAfter: body.headAfter?.oid,
      changedPaths: body.changedPaths,
    },
    error: body.error?.message,
  };
}

function permissionProfile(input: {
  repository: GitRepositorySnapshot;
  readOnly: boolean;
  permissionCategory: "read_only" | "execute_command" | "write_file";
  sideEffectLevel: "none" | "medium" | "high";
  action: string;
  summary: string;
  paths?: string[];
  revisions?: string[];
  scopeDigest?: string;
  argumentSummary: Record<string, unknown>;
}): ToolPermissionProfile {
  return {
    permissionCategory: input.permissionCategory,
    sideEffectLevel: input.sideEffectLevel,
    readOnly: input.readOnly,
    approvalContext: {
      repositoryRoot: input.repository.repositoryRoot,
      head: input.repository.head.oid,
      stateDigest: input.repository.stateDigest,
      scopeDigest: input.scopeDigest,
      action: input.action,
    },
    approvalPresentation: {
      action: input.action,
      summary: input.summary,
      paths: input.paths,
      revisions: input.revisions,
      argumentSummary: input.argumentSummary,
    },
  };
}

async function runGit(
  context: ToolAccessResolutionContext | RuntimeToolExecutionContext,
  root: string,
  args: string[],
  purpose: string,
  options: { maxOutputChars?: number; input?: string } = {},
): Promise<GitCommandExecutionResult> {
  const executable = await gitExecutable(context);
  if (!executable) {
    return {
      command: "git",
      cwd: root,
      stdout: "",
      stderr: "Git executable is unavailable.",
      exitCode: -1,
      timedOut: false,
      spawnError: { code: "ENOENT", message: "Git executable is unavailable." },
      success: false,
      display: "git",
      purpose,
    };
  }
  return executeGitCommand(services(context).processes, buildGitCommand({
    executable,
    args,
    cwd: root,
    purpose,
    maxOutputChars: options.maxOutputChars,
    input: options.input,
    environment: services(context).environment,
  }));
}

function commandError(toolName: string, command: GitCommandExecutionResult): ToolStructuredError {
  return structuredError(
    command.timedOut ? "timeout" : command.spawnError?.code === "ENOENT" ? "missing_dependency" : "command_failed",
    command.timedOut
      ? `${toolName} timed out while running ${command.display}.`
      : `${toolName} command failed with exit code ${command.exitCode ?? -1}: ${command.stderr || command.stdout}`,
    toolName,
    command.timedOut,
    {
      command: command.display,
      cwd: command.cwd,
      exitCode: command.exitCode ?? undefined,
      stdout: command.stdout,
      stderr: command.stderr,
    },
  );
}

function mutationAccess(cwd: string, command: string, reason: string): Array<{
  kind: "command_execute" | "external_system";
  cwd?: string;
  command?: string;
  systems?: string[];
  reason: string;
}> {
  return [
    { kind: "command_execute", cwd, command, reason },
    { kind: "external_system", systems: [MUTATION_ACCESS], reason: "Journal one local Git state mutation." },
  ];
}

function normalizedPatchInput(patchText: string): string {
  if (!patchText || patchText.length > MAX_PATCH_CHARS || /GIT binary patch/iu.test(patchText)) {
    throw new Error(`git_stage patch must contain 1-${MAX_PATCH_CHARS} text characters and no binary patch.`);
  }
  return patchText.endsWith("\n") ? patchText : `${patchText}\n`;
}

function parsePatchNumstat(output: string): string[] {
  const paths = new Set<string>();
  const records = output.split("\0").filter(Boolean);
  for (let index = 0; index < records.length; index += 1) {
    const record = records[index]!;
    const match = /^(?:\d+|-)\t(?:\d+|-)\t(.*)$/su.exec(record);
    if (!match) throw new Error("git apply returned an ambiguous patch path record.");
    if (match[1]) {
      paths.add(normalizeGitPath(match[1]));
      continue;
    }
    const oldPath = records[++index];
    const newPath = records[++index];
    if (!oldPath || !newPath) throw new Error("git apply returned an incomplete rename/copy path record.");
    paths.add(normalizeGitPath(oldPath));
    paths.add(normalizeGitPath(newPath));
  }
  if (paths.size === 0) throw new Error("git_stage patch does not contain a complete parseable path set.");
  return [...paths].sort();
}

async function inspectPatchScope(
  context: ToolAccessResolutionContext | RuntimeToolExecutionContext,
  root: string,
  repository: GitRepositorySnapshot,
  patchInput: string,
): Promise<{ paths: string[]; error?: ToolStructuredError }> {
  const command = await runGit(
    context,
    root,
    ["apply", "--numstat", "-z", "-"],
    "Enumerate the complete explicit index patch scope",
    { input: patchInput, maxOutputChars: 500_000 },
  );
  if (!command.success || command.outputTruncated) {
    return {
      paths: [],
      error: command.outputTruncated
        ? structuredError("invalid_state", "Patch scope exceeded the bounded parser output.", "git_stage", false)
        : commandError("git_stage", command),
    };
  }
  try {
    const paths = parsePatchNumstat(command.stdout);
    const protectedPath = paths.find((entry) => isProtectedRepositoryMutationPath(repository, entry));
    return protectedPath
      ? {
          paths,
          error: structuredError("invalid_path", `Patch touches a protected runtime path: ${protectedPath}.`, "git_stage", false),
        }
      : { paths };
  } catch (error) {
    return { paths: [], error: structuredError("invalid_arguments", (error as Error).message, "git_stage", false) };
  }
}

async function inspectStagePathScope(
  context: ToolAccessResolutionContext | RuntimeToolExecutionContext,
  root: string,
  repository: GitRepositorySnapshot,
  paths: readonly string[],
): Promise<{ paths: string[]; error?: ToolStructuredError }> {
  const command = await runGit(
    context,
    root,
    ["ls-files", "--cached", "--others", "--exclude-standard", "-z", "--", ...paths.map(literalGitPathspec)],
    "Enumerate the complete explicit index path scope",
    { maxOutputChars: 500_000 },
  );
  if (!command.success || command.outputTruncated) {
    return {
      paths: [],
      error: command.outputTruncated
        ? structuredError("invalid_state", "Stage path scope exceeded the bounded parser output.", "git_stage", false)
        : commandError("git_stage", command),
    };
  }
  const expanded = parseNullTerminatedPaths(command.stdout);
  const protectedPath = expanded.find((entry) => isProtectedRepositoryMutationPath(repository, entry));
  return protectedPath
    ? {
        paths: expanded,
        error: structuredError("invalid_path", `Stage path scope contains a protected runtime path: ${protectedPath}.`, "git_stage", false),
      }
    : { paths: expanded };
}

async function executeGitStage(
  args: GitStageArguments,
  context: RuntimeToolExecutionContext,
): Promise<ToolResult<GitOperationResult>> {
  const startedAt = context.moduleContext.clock.now();
  const startedEpoch = Date.now();
  let before = await snapshot(context, args.cwd ?? ".");
  const paths = normalizeExplicitPaths(args.paths);
  const baseError = mutableRepositoryError("git_stage", before) ?? approvedStateError(context, before, "git_stage");
  if (baseError) {
    return result(context, startedAt, startedEpoch, {
      kind: "git_operation",
      toolName: "git_stage",
      action: "stage",
      status: baseError.type === "not_found" ? "not_found" : "invalid_state",
      repository: before,
      headBefore: before.head,
      headAfter: before.head,
      changedPaths: [],
      conflict: before.conflict,
      error: baseError,
    }, false);
  }
  const root = repositoryRoot(context, before);
  return withGitMutationLock(mutationLockKey(context, before), async () => {
    before = await snapshot(context, before.repositoryRoot!);
    const stateError = mutableRepositoryError("git_stage", before) ?? approvedStateError(context, before, "git_stage");
    if (stateError) {
      return result(context, startedAt, startedEpoch, {
        kind: "git_operation",
        toolName: "git_stage",
        action: "stage",
        status: "invalid_state",
        repository: before,
        headBefore: before.head,
        headAfter: before.head,
        changedPaths: [],
        conflict: before.conflict,
        error: stateError,
      }, false);
    }
    const patchInput = args.patch === undefined ? undefined : normalizedPatchInput(args.patch);
    const inspected = patchInput === undefined
      ? await inspectStagePathScope(context, root, before, paths)
      : await inspectPatchScope(context, root, before, patchInput);
    let scopeError = inspected.error ?? approvedScopeError(context, inspected.paths, "git_stage");
    if (!scopeError && patchInput !== undefined) {
      const allowed = new Set(paths);
      const undeclared = inspected.paths.filter((value) => !allowed.has(value));
      if (undeclared.length > 0) {
        scopeError = structuredError(
          "invalid_arguments",
          `Patch touches undeclared paths: ${undeclared.join(", ")}.`,
          "git_stage",
          false,
        );
      }
    }
    if (scopeError) {
      return result(context, startedAt, startedEpoch, {
        kind: "git_operation",
        toolName: "git_stage",
        action: "stage",
        status: scopeError.type === "invalid_path" ? "protected" : "invalid_state",
        repository: before,
        headBefore: before.head,
        headAfter: before.head,
        changedPaths: [],
        conflict: before.conflict,
        error: scopeError,
      }, false);
    }
    let command: GitCommandExecutionResult;
    if (patchInput !== undefined) {
      const check = await runGit(
        context,
        root,
        ["apply", "--cached", "--check", "--whitespace=nowarn", "-"],
        "Validate an explicit bounded index patch",
        { input: patchInput, maxOutputChars: 256_000 },
      );
      if (!check.success) command = check;
      else {
        command = await runGit(
          context,
          root,
          ["apply", "--cached", "--whitespace=nowarn", "-"],
          "Stage an explicit bounded index patch",
          { input: patchInput, maxOutputChars: 256_000 },
        );
      }
    } else {
      command = await runGit(
        context,
        root,
        ["add", "--", ...paths.map(literalGitPathspec)],
        "Stage only explicitly declared repository paths",
        { maxOutputChars: 256_000 },
      );
    }
    const after = await snapshot(context, before.repositoryRoot!);
    const changedPaths = changedExplicitPaths(before, after, inspected.paths);
    const error = command.success ? undefined : commandError("git_stage", command);
    return result(context, startedAt, startedEpoch, {
      kind: "git_operation",
      toolName: "git_stage",
      action: "stage",
      status: error ? "failed" : changedPaths.length > 0 ? "completed" : "unchanged",
      repository: after,
      headBefore: before.head,
      headAfter: after.head,
      changedPaths,
      conflict: after.conflict,
      details: {
        staged: after.staged,
        unstaged: after.unstaged,
        untracked: after.untracked,
        patchApplied: args.patch !== undefined,
      },
      error,
    }, !error);
  }, context.signal);
}

export const gitStageTool: RuntimeToolSpec<GitStageArguments> = {
  name: "git_stage",
  description: "Stage only explicit local repository paths or an explicit path-bounded patch; never stages all changes.",
  inputSchema: {
    type: "object",
    additionalProperties: false,
    required: ["paths"],
    properties: {
      cwd: { type: "string" },
      paths: { type: "array", minItems: 1, maxItems: 256, uniqueItems: true, items: { type: "string", minLength: 1 } },
      patch: { type: "string", minLength: 1, maxLength: MAX_PATCH_CHARS },
    },
  },
  readOnly: false,
  permissionCategory: "execute_command",
  sideEffectLevel: "medium",
  timeoutCategory: "default",
  groups: ["git", "local_changes"],
  selection: {
    groups: ["git_stage", "local_changes"],
    keywords: ["git stage", "stage selected paths", "stage patch", "暂存指定文件", "暂存补丁"],
  },
  capabilityRequirements: [{ name: "git", required: true, reason: "git_stage invokes the Git executable." }],
  resolveAccess: (rawArgs, context) => mutationAccess(
    context.paths.normalize(rawArgs.cwd ?? "."),
    "git add/apply --cached <parameterized explicit paths>",
    "Stage only explicitly declared repository paths through the local Git runtime.",
  ),
  resolvePermission: async (rawArgs, context) => {
    const repository = await snapshot(context, rawArgs.cwd ?? ".");
    const declaredPaths = normalizeExplicitPaths(rawArgs.paths);
    let blocked = Boolean(mutableRepositoryError("git_stage", repository));
    let paths = declaredPaths;
    if (!blocked && repository.repositoryRoot) {
      const root = path.resolve(context.workspaceRoot, repository.repositoryRoot);
      const patchInput = rawArgs.patch === undefined ? undefined : normalizedPatchInput(rawArgs.patch);
      const inspected = patchInput === undefined
        ? await inspectStagePathScope(context, root, repository, declaredPaths)
        : await inspectPatchScope(context, root, repository, patchInput);
      if (inspected.error) blocked = true;
      if (patchInput !== undefined) {
        const allowed = new Set(declaredPaths);
        const undeclared = inspected.paths.filter((value) => !allowed.has(value));
        if (undeclared.length > 0) blocked = true;
      }
      paths = inspected.paths;
    }
    return permissionProfile({
      repository,
      readOnly: blocked,
      permissionCategory: blocked ? "read_only" : "execute_command",
      sideEffectLevel: blocked ? "none" : "medium",
      action: "stage",
      summary: `Stage only ${paths.length} explicitly declared path(s).`,
      paths,
      scopeDigest: scopeDigest(paths),
      argumentSummary: {
        declaredPaths,
        paths,
        patch: rawArgs.patch === undefined ? undefined : `[${rawArgs.patch.length} chars]`,
      },
    });
  },
  redactArguments: (rawArgs) => ({
    cwd: rawArgs.cwd,
    paths: rawArgs.paths,
    patch: rawArgs.patch === undefined ? undefined : `[${rawArgs.patch.length} chars]`,
  }),
  execute: executeGitStage,
};

function validateCommitMessage(message: string): string {
  if (!message.trim() || message.length > MAX_COMMIT_MESSAGE_CHARS || /\u0000/u.test(message)) {
    throw new Error(`git_commit message must contain 1-${MAX_COMMIT_MESSAGE_CHARS} characters and no NUL bytes.`);
  }
  return message;
}

async function activeCommitHooks(
  context: ToolAccessResolutionContext | RuntimeToolExecutionContext,
  root: string,
  repository: GitRepositorySnapshot,
): Promise<{ hooks: string[]; error?: ToolStructuredError }> {
  const configured = await runGit(
    context,
    root,
    ["config", "--get", "core.hooksPath"],
    "Detect configured commit hook routing without executing hooks",
    { maxOutputChars: 8_192 },
  );
  if (configured.outputTruncated || (configured.exitCode !== 0 && configured.exitCode !== 1)) {
    return {
      hooks: [],
      error: configured.outputTruncated
        ? structuredError("invalid_state", "Commit hook configuration exceeded the bounded probe.", "git_commit", false)
        : commandError("git_commit", configured),
    };
  }
  if (configured.stdout.trim()) return { hooks: ["configured core.hooksPath"] };
  if (!repository.commonDirTrusted || !repository.commonDir) {
    return {
      hooks: [],
      error: structuredError("invalid_state", "Commit hook directory is outside the trusted workspace.", "git_commit", false),
    };
  }
  const hookRoot = path.resolve(context.workspaceRoot, repository.commonDir, "hooks");
  const hookNames = ["pre-commit", "prepare-commit-msg", "commit-msg", "post-commit", "pre-merge-commit"];
  const hooks: string[] = [];
  for (const hookName of hookNames) {
    try {
      const info = await fs.lstat(path.join(hookRoot, hookName));
      if (info.isFile() && (process.platform === "win32" || (info.mode & 0o111) !== 0)) hooks.push(hookName);
    } catch (error) {
      const code = (error as NodeJS.ErrnoException).code;
      if (code !== "ENOENT" && code !== "ENOTDIR") {
        return {
          hooks: [],
          error: structuredError("invalid_state", "Commit hook state could not be inspected safely.", "git_commit", true),
        };
      }
    }
  }
  return { hooks };
}

async function prepareCommit(
  args: GitCommitArguments,
  context: ToolAccessResolutionContext | RuntimeToolExecutionContext,
): Promise<GitPreparedPreview> {
  const repository = await snapshot(context, args.cwd ?? ".");
  const baseError = mutableRepositoryError("git_commit", repository);
  if (baseError) return { snapshot: repository, error: baseError };
  if (repository.conflict.status === "conflicted") {
    return {
      snapshot: repository,
      error: structuredError("conflicted", "git_commit refuses while unresolved Git conflicts remain.", "git_commit", true),
    };
  }
  const message = validateCommitMessage(args.message);
  if (repository.staged.length === 0) {
    return {
      snapshot: repository,
      error: structuredError("invalid_state", "git_commit requires a non-empty staged change set.", "git_commit", true),
    };
  }
  if (!repository.repositoryRoot) {
    return { snapshot: repository, error: structuredError("not_found", "Git repository root is unavailable.", "git_commit", false) };
  }
  const executable = await gitExecutable(context);
  if (!executable) {
    return { snapshot: repository, error: structuredError("missing_dependency", "Git executable is unavailable.", "git_commit", false) };
  }
  const root = path.resolve(context.workspaceRoot, repository.repositoryRoot);
  const hookState = await activeCommitHooks(context, root, repository);
  if (hookState.error) return { snapshot: repository, error: hookState.error };
  if (hookState.hooks.length > 0) {
    return {
      snapshot: repository,
      error: structuredError(
        "invalid_state",
        `git_commit refuses active commit hooks because they can change the staged scope after preview: ${hookState.hooks.join(", ")}.`,
        "git_commit",
        false,
        { details: hookState.hooks.map((message) => ({ path: "commit_hooks", message })) },
      ),
    };
  }
  const execute = (commandArgs: string[], purpose: string, maxOutputChars: number) => executeGitCommand(
    services(context).processes,
    buildGitCommand({
      executable,
      args: commandArgs,
      cwd: root,
      purpose,
      maxOutputChars,
      environment: services(context).environment,
    }),
  );
  const [diff, stat] = await Promise.all([
    execute(["diff", "--cached", "--binary", "--no-ext-diff", "--no-color"], "Preview the exact staged commit diff", 500_000),
    execute(["diff", "--cached", "--stat", "--no-color"], "Summarize the exact staged commit diff", 64_000),
  ]);
  if (!diff.success || diff.outputTruncated) {
    return {
      snapshot: repository,
      error: diff.outputTruncated
        ? structuredError("invalid_state", "Staged diff exceeded the bounded exact preview; commit was not authorized.", "git_commit", false)
        : commandError("git_commit", diff),
    };
  }
  if (!stat.success || stat.outputTruncated) {
    return {
      snapshot: repository,
      error: stat.outputTruncated
        ? structuredError("invalid_state", "Staged diff summary exceeded the bounded preview; commit was not authorized.", "git_commit", false)
        : commandError("git_commit", stat),
    };
  }
  const diffHash = createHash("sha256").update(diff.stdout).digest("hex");
  const confirmationToken = createHash("sha256").update(JSON.stringify({
    stateDigest: repository.stateDigest,
    message,
    diffHash,
  })).digest("hex");
  const summaryParts = [stat.stdout.trim(), diff.stdout.slice(0, 20_000).trim()].filter(Boolean);
  return {
    snapshot: repository,
    preview: {
      summary: `Commit ${repository.staged.length} staged path(s) with the supplied message.`,
      confirmationToken,
      paths: repository.staged.map((entry) => entry.path),
      stagedDiffSummary: summaryParts.join("\n\n"),
      commitMessage: message,
      riskSummary: [
        "Only the currently staged index is committed; unstaged and untracked paths remain untouched.",
        "Active commit hooks are refused because phase 18 neither bypasses hooks nor permits them to alter the confirmed scope.",
        "Signing policy is not bypassed.",
      ],
    },
  };
}

async function executeGitCommit(
  args: GitCommitArguments,
  context: RuntimeToolExecutionContext,
): Promise<ToolResult<GitOperationResult>> {
  const startedAt = context.moduleContext.clock.now();
  const startedEpoch = Date.now();
  let prepared = await prepareCommit(args, context);
  if (prepared.error) {
    return result(context, startedAt, startedEpoch, {
      kind: "git_operation",
      toolName: "git_commit",
      action: "commit",
      status: prepared.error.type === "not_found" ? "not_found" : prepared.error.type === "conflicted" ? "conflicted" : "invalid_state",
      repository: prepared.snapshot,
      headBefore: prepared.snapshot.head,
      headAfter: prepared.snapshot.head,
      changedPaths: [],
      conflict: prepared.snapshot.conflict,
      error: prepared.error,
    }, false);
  }
  if (!args.confirmationToken) {
    return result(context, startedAt, startedEpoch, {
      kind: "git_operation",
      toolName: "git_commit",
      action: "commit",
      status: "preview",
      repository: prepared.snapshot,
      headBefore: prepared.snapshot.head,
      headAfter: prepared.snapshot.head,
      changedPaths: [],
      conflict: prepared.snapshot.conflict,
      preview: prepared.preview,
    }, true);
  }
  if (args.confirmationToken !== prepared.preview!.confirmationToken) {
    const error = structuredError(
      "invalid_state",
      "Commit confirmation does not match the current staged diff, message, and repository state.",
      "git_commit",
      true,
    );
    return result(context, startedAt, startedEpoch, {
      kind: "git_operation",
      toolName: "git_commit",
      action: "commit",
      status: "invalid_state",
      repository: prepared.snapshot,
      headBefore: prepared.snapshot.head,
      headAfter: prepared.snapshot.head,
      changedPaths: [],
      conflict: prepared.snapshot.conflict,
      preview: prepared.preview,
      error,
    }, false);
  }
  const root = repositoryRoot(context, prepared.snapshot);
  return withGitMutationLock(mutationLockKey(context, prepared.snapshot), async () => {
    prepared = await prepareCommit(args, context);
    const stateError = approvedStateError(context, prepared.snapshot, "git_commit");
    const tokenMismatch = args.confirmationToken !== prepared.preview?.confirmationToken;
    if (prepared.error || stateError || tokenMismatch) {
      const error = prepared.error ?? stateError ?? structuredError(
        "invalid_state",
        "The staged diff changed before commit execution; request a new preview.",
        "git_commit",
        true,
      );
      return result(context, startedAt, startedEpoch, {
        kind: "git_operation",
        toolName: "git_commit",
        action: "commit",
        status: error.type === "conflicted" ? "conflicted" : "invalid_state",
        repository: prepared.snapshot,
        headBefore: prepared.snapshot.head,
        headAfter: prepared.snapshot.head,
        changedPaths: [],
        conflict: prepared.snapshot.conflict,
        preview: prepared.preview,
        error,
      }, false);
    }
    const before = prepared.snapshot;
    const command = await runGit(
      context,
      root,
      ["commit", "-m", validateCommitMessage(args.message)],
      "Commit the confirmed staged diff without bypassing hooks or signing policy",
      { maxOutputChars: 500_000 },
    );
    const after = await snapshot(context, before.repositoryRoot!);
    const error = command.success ? undefined : commandError("git_commit", command);
    const committedPaths = before.staged.map((entry) => entry.path);
    const subject = after.head.oid && after.head.oid !== before.head.oid
      ? (await runGit(context, root, ["show", "--no-patch", "--format=%s", after.head.oid], "Read committed subject", { maxOutputChars: 32_000 })).stdout.trim()
      : undefined;
    return result(context, startedAt, startedEpoch, {
      kind: "git_operation",
      toolName: "git_commit",
      action: "commit",
      status: error ? "failed" : "completed",
      repository: after,
      headBefore: before.head,
      headAfter: after.head,
      changedPaths: error ? [] : committedPaths,
      conflict: after.conflict,
      details: {
        commitHash: error ? undefined : after.head.oid,
        subject,
        preservedUnstaged: after.unstaged.map((entry) => entry.path),
        preservedUntracked: after.untracked,
        hookBypassUsed: false,
        amendUsed: false,
      },
      error,
    }, !error);
  }, context.signal);
}

export const gitCommitTool: RuntimeToolSpec<GitCommitArguments> = {
  name: "git_commit",
  description: "Preview and then commit the exact staged diff with an explicit message and confirmation token.",
  inputSchema: {
    type: "object",
    additionalProperties: false,
    required: ["message"],
    properties: {
      cwd: { type: "string" },
      message: { type: "string", minLength: 1, maxLength: MAX_COMMIT_MESSAGE_CHARS },
      confirmationToken: { type: "string", pattern: "^[a-f0-9]{64}$" },
    },
  },
  readOnly: false,
  permissionCategory: "execute_command",
  sideEffectLevel: "high",
  timeoutCategory: "default",
  groups: ["git", "local_changes"],
  selection: {
    groups: ["git_commit", "local_changes"],
    keywords: ["git commit staged", "commit staged changes", "提交暂存变更", "确认本地提交"],
  },
  capabilityRequirements: [{ name: "git", required: true, reason: "git_commit invokes the Git executable." }],
  resolveAccess: (rawArgs, context) => rawArgs.confirmationToken
    ? mutationAccess(context.paths.normalize(rawArgs.cwd ?? "."), "git commit -m <parameterized message>", "Commit the confirmed staged diff.")
    : [{
        kind: "command_execute" as const,
        cwd: context.paths.normalize(rawArgs.cwd ?? "."),
        command: "git diff --cached <bounded preview>",
        reason: "Read the staged diff before any commit is authorized.",
      }],
  resolvePermission: async (rawArgs, context) => {
    const prepared = await prepareCommit(rawArgs, context);
    const confirmed = Boolean(
      !prepared.error && rawArgs.confirmationToken && rawArgs.confirmationToken === prepared.preview?.confirmationToken,
    );
    return permissionProfile({
      repository: prepared.snapshot,
      readOnly: !confirmed,
      permissionCategory: confirmed ? "execute_command" : "read_only",
      sideEffectLevel: confirmed ? "high" : "none",
      action: "commit",
      summary: confirmed ? "Commit the confirmed staged diff." : "Preview the staged diff and commit message without writing.",
      paths: prepared.preview?.paths,
      argumentSummary: {
        message: rawArgs.message,
        confirmationToken: rawArgs.confirmationToken ? "[provided]" : "[preview only]",
      },
    });
  },
  redactArguments: (rawArgs) => ({
    cwd: rawArgs.cwd,
    message: rawArgs.message,
    confirmationToken: rawArgs.confirmationToken ? "[provided]" : undefined,
  }),
  execute: executeGitCommit,
};

function validateRestoreArguments(args: GitRestoreArguments): { paths: string[]; revision?: string } {
  const paths = normalizeExplicitPaths(args.paths);
  if (args.source === "revision") {
    if (!args.revision) throw new Error("git_restore source=revision requires an explicit revision.");
    return { paths, revision: validateGitRevision(args.revision) };
  }
  if (args.revision !== undefined) throw new Error("git_restore revision is only valid when source=revision.");
  if (args.source === "index" && args.area !== "worktree") {
    throw new Error("git_restore source=index only supports area=worktree.");
  }
  return { paths };
}

function parseNullTerminatedPaths(output: string): string[] {
  return [...new Set(output.split("\0").map((value) => value.replace(/\\/gu, "/")).filter(Boolean))].sort();
}

async function inspectRestoreImpact(
  context: ToolAccessResolutionContext | RuntimeToolExecutionContext,
  root: string,
  args: GitRestoreArguments,
  validated: { paths: string[]; revision?: string },
): Promise<{ paths: string[]; error?: ToolStructuredError }> {
  const literalPaths = validated.paths.map(literalGitPathspec);
  const sourceRevision = args.source === "head"
    ? "HEAD"
    : args.source === "revision"
      ? validated.revision
      : undefined;
  const commands: Array<Promise<GitCommandExecutionResult>> = [];
  if (args.area === "worktree" || args.area === "both") {
    commands.push(runGit(
      context,
      root,
      sourceRevision
        ? ["diff", "--name-only", "-z", sourceRevision, "--", ...literalPaths]
        : ["diff", "--name-only", "-z", "--", ...literalPaths],
      "Inspect exact worktree paths affected by explicit Git restore",
      { maxOutputChars: 500_000 },
    ));
  }
  if (args.area === "index" || args.area === "both") {
    if (!sourceRevision) {
      return {
        paths: [],
        error: structuredError(
          "invalid_arguments",
          "Index restore requires HEAD or an explicit revision source.",
          "git_restore",
          false,
        ),
      };
    }
    commands.push(runGit(
      context,
      root,
      ["diff", "--cached", "--name-only", "-z", sourceRevision, "--", ...literalPaths],
      "Inspect exact index paths affected by explicit Git restore",
      { maxOutputChars: 500_000 },
    ));
  }
  const results = await Promise.all(commands);
  const failed = results.find((entry) => !entry.success || entry.outputTruncated === true);
  if (failed) {
    return {
      paths: [],
      error: failed.outputTruncated
        ? structuredError(
            "invalid_state",
            "Restore impact exceeded the bounded path output; no restore was executed.",
            "git_restore",
            true,
          )
        : commandError("git_restore", failed),
    };
  }
  return {
    paths: [...new Set(results.flatMap((entry) => parseNullTerminatedPaths(entry.stdout)))].sort(),
  };
}

async function resolveRestoreWritePaths(
  args: GitRestoreArguments,
  context: ToolAccessResolutionContext,
): Promise<string[]> {
  const validated = validateRestoreArguments(args);
  const repository = await snapshot(context, args.cwd ?? ".");
  if (!repository.repositoryRoot) return [];
  const baseError = mutableRepositoryError("git_restore", repository);
  if (baseError) return [];
  const root = path.resolve(context.workspaceRoot, repository.repositoryRoot);
  const impact = await inspectRestoreImpact(context, root, args, validated);
  if (impact.error) throw new Error(impact.error.message);
  const protectedPath = impact.paths.find((entry) => isProtectedRepositoryMutationPath(repository, entry));
  if (protectedPath) throw new Error(`Restore scope contains a protected runtime path: ${protectedPath}.`);
  const paths: string[] = [];
  for (const filePath of impact.paths) {
    paths.push((await resolveTrustedRepositoryPath(
      context.workspaceRoot,
      repository.repositoryRoot,
      filePath,
    )).workspaceRelativePath);
  }
  return paths;
}

async function executeGitRestore(
  args: GitRestoreArguments,
  context: RuntimeToolExecutionContext,
): Promise<ToolResult<GitOperationResult>> {
  const startedAt = context.moduleContext.clock.now();
  const startedEpoch = Date.now();
  const validated = validateRestoreArguments(args);
  let before = await snapshot(context, args.cwd ?? ".");
  const baseError = mutableRepositoryError("git_restore", before) ?? approvedStateError(context, before, "git_restore");
  if (baseError) {
    return result(context, startedAt, startedEpoch, {
      kind: "git_operation",
      toolName: "git_restore",
      action: "restore",
      status: baseError.type === "not_found" ? "not_found" : "invalid_state",
      repository: before,
      headBefore: before.head,
      headAfter: before.head,
      changedPaths: [],
      conflict: before.conflict,
      checkpointId: context.checkpoint?.checkpointId,
      undo: {
        available: false,
        checkpointId: context.checkpoint?.checkpointId,
        scope: "none",
        limitations: ["No worktree mutation was executed."],
      },
      error: baseError,
    }, false);
  }
  if ((args.source === "head" || args.source === "revision") && args.source === "head" && before.head.unborn) {
    const error = structuredError("invalid_state", "git_restore cannot read HEAD on an unborn branch.", "git_restore", false);
    return result(context, startedAt, startedEpoch, {
      kind: "git_operation",
      toolName: "git_restore",
      action: "restore",
      status: "invalid_state",
      repository: before,
      headBefore: before.head,
      headAfter: before.head,
      changedPaths: [],
      conflict: before.conflict,
      checkpointId: context.checkpoint?.checkpointId,
      undo: { available: false, checkpointId: context.checkpoint?.checkpointId, scope: "none" },
      error,
    }, false);
  }
  const root = repositoryRoot(context, before);
  return withGitMutationLock(mutationLockKey(context, before), async () => {
    before = await snapshot(context, before.repositoryRoot!);
    const stateError = mutableRepositoryError("git_restore", before) ?? approvedStateError(context, before, "git_restore");
    if (stateError) {
      return result(context, startedAt, startedEpoch, {
        kind: "git_operation",
        toolName: "git_restore",
        action: "restore",
        status: "invalid_state",
        repository: before,
        headBefore: before.head,
        headAfter: before.head,
        changedPaths: [],
        conflict: before.conflict,
        checkpointId: context.checkpoint?.checkpointId,
        undo: { available: false, checkpointId: context.checkpoint?.checkpointId, scope: "none" },
        error: stateError,
      }, false);
    }
    if (validated.revision) {
      const revisionCheck = await runGit(
        context,
        root,
        ["rev-parse", "--verify", `${validated.revision}^{commit}`],
        "Validate explicit restore revision",
        { maxOutputChars: 8_192 },
      );
      if (!revisionCheck.success) {
        const error = structuredError("not_found", `Restore revision was not found: ${validated.revision}.`, "git_restore", false);
        return result(context, startedAt, startedEpoch, {
          kind: "git_operation",
          toolName: "git_restore",
          action: "restore",
          status: "not_found",
          repository: before,
          headBefore: before.head,
          headAfter: before.head,
          changedPaths: [],
          conflict: before.conflict,
          checkpointId: context.checkpoint?.checkpointId,
          undo: { available: false, checkpointId: context.checkpoint?.checkpointId, scope: "none" },
          error,
        }, false);
      }
    }
    const impact = await inspectRestoreImpact(context, root, args, validated);
    if (impact.error) {
      return result(context, startedAt, startedEpoch, {
        kind: "git_operation",
        toolName: "git_restore",
        action: "restore",
        status: "failed",
        repository: before,
        headBefore: before.head,
        headAfter: before.head,
        changedPaths: [],
        conflict: before.conflict,
        checkpointId: context.checkpoint?.checkpointId,
        undo: {
          available: false,
          checkpointId: context.checkpoint?.checkpointId,
          scope: "none",
          limitations: ["No restore was executed because its complete impact set could not be established."],
        },
        error: impact.error,
      }, false);
    }
    const protectedPath = impact.paths.find((entry) => isProtectedRepositoryMutationPath(before, entry));
    const scopeError = protectedPath
      ? structuredError("invalid_path", `Restore scope contains a protected runtime path: ${protectedPath}.`, "git_restore", false)
      : approvedScopeError(context, impact.paths, "git_restore");
    if (scopeError) {
      return result(context, startedAt, startedEpoch, {
        kind: "git_operation",
        toolName: "git_restore",
        action: "restore",
        status: scopeError.type === "invalid_path" ? "protected" : "invalid_state",
        repository: before,
        headBefore: before.head,
        headAfter: before.head,
        changedPaths: [],
        conflict: before.conflict,
        checkpointId: context.checkpoint?.checkpointId,
        undo: {
          available: false,
          checkpointId: context.checkpoint?.checkpointId,
          scope: "none",
          limitations: ["No restore was executed because its exact scope was not approved."],
        },
        error: scopeError,
      }, false);
    }
    const commandArgs = ["restore"];
    if (args.source === "head") commandArgs.push("--source=HEAD");
    else if (validated.revision) commandArgs.push(`--source=${validated.revision}`);
    if (args.area === "worktree" || args.area === "both") commandArgs.push("--worktree");
    if (args.area === "index" || args.area === "both") commandArgs.push("--staged");
    commandArgs.push("--", ...validated.paths.map(literalGitPathspec));
    const command = await runGit(
      context,
      root,
      commandArgs,
      "Restore only explicitly declared repository paths",
      { maxOutputChars: 256_000 },
    );
    const after = await snapshot(context, before.repositoryRoot!);
    const error = command.success ? undefined : commandError("git_restore", command);
    const changedPaths = error
      ? changedExplicitPaths(before, after, impact.paths)
      : impact.paths;
    const worktreeUndo = (args.area === "worktree" || args.area === "both") && Boolean(context.checkpoint);
    return result(context, startedAt, startedEpoch, {
      kind: "git_operation",
      toolName: "git_restore",
      action: "restore",
      status: error ? "failed" : changedPaths.length > 0 ? "completed" : "unchanged",
      repository: after,
      headBefore: before.head,
      headAfter: after.head,
      changedPaths,
      conflict: after.conflict,
      checkpointId: context.checkpoint?.checkpointId,
      undo: {
        available: worktreeUndo,
        checkpointId: context.checkpoint?.checkpointId,
        scope: worktreeUndo ? "worktree_files" : args.area === "index" ? "index" : "none",
        limitations: [
          ...(args.area === "index" || args.area === "both"
            ? ["The file checkpoint restores worktree bytes; it does not reconstruct prior index staging bits."]
            : []),
          ...(!command.success
            ? ["Git reported failure; the retained checkpoint can restore worktree bytes that may have been partially changed."]
            : []),
        ],
      },
      details: {
        area: args.area,
        source: args.source,
        revision: validated.revision,
        diffSummary: {
          staged: after.staged.filter((entry) => impact.paths.includes(entry.path)),
          unstaged: after.unstaged.filter((entry) => impact.paths.includes(entry.path)),
        },
      },
      error,
    }, !error);
  }, context.signal);
}

export const gitRestoreTool: RuntimeToolSpec<GitRestoreArguments> = {
  name: "git_restore",
  description: "Checkpoint and restore only explicit paths in the worktree, index, or both from the index, HEAD, or a revision.",
  inputSchema: {
    type: "object",
    additionalProperties: false,
    required: ["area", "source", "paths"],
    properties: {
      cwd: { type: "string" },
      area: { type: "string", enum: ["worktree", "index", "both"] },
      source: { type: "string", enum: ["index", "head", "revision"] },
      revision: { type: "string", minLength: 1, maxLength: 512 },
      paths: { type: "array", minItems: 1, maxItems: 256, uniqueItems: true, items: { type: "string", minLength: 1 } },
    },
  },
  readOnly: false,
  permissionCategory: "write_file",
  sideEffectLevel: "high",
  timeoutCategory: "default",
  groups: ["git", "local_changes", "recovery"],
  selection: {
    groups: ["git_restore", "local_changes"],
    keywords: ["git restore explicit paths", "restore worktree file", "unstage selected paths", "恢复指定 Git 文件", "取消暂存指定文件"],
  },
  capabilityRequirements: [{ name: "git", required: true, reason: "git_restore invokes the Git executable." }],
  resolveAccess: async (rawArgs, context) => {
    const writePaths = await resolveRestoreWritePaths(rawArgs, context);
    return [
      ...mutationAccess(
        context.paths.normalize(rawArgs.cwd ?? "."),
        "git restore <parameterized source/area> -- <explicit paths>",
        "Restore only explicitly declared Git paths.",
      ),
      ...(writePaths.length === 0 ? [] : [{
        kind: "filesystem_write" as const,
        paths: writePaths,
        reason: "Checkpoint explicit restore targets before Git writes worktree bytes.",
      }]),
    ];
  },
  resolvePermission: async (rawArgs, context) => {
    const repository = await snapshot(context, rawArgs.cwd ?? ".");
    const { paths: declaredPaths, revision } = validateRestoreArguments(rawArgs);
    const blocked = Boolean(mutableRepositoryError("git_restore", repository));
    let paths = declaredPaths;
    if (!blocked && repository.repositoryRoot) {
      const root = path.resolve(context.workspaceRoot, repository.repositoryRoot);
      const impact = await inspectRestoreImpact(context, root, rawArgs, { paths: declaredPaths, revision });
      if (impact.error) throw new Error(impact.error.message);
      const protectedPath = impact.paths.find((entry) => isProtectedRepositoryMutationPath(repository, entry));
      if (protectedPath) throw new Error(`Restore scope contains a protected runtime path: ${protectedPath}.`);
      paths = impact.paths;
    }
    return permissionProfile({
      repository,
      readOnly: blocked,
      permissionCategory: blocked ? "read_only" : "write_file",
      sideEffectLevel: blocked ? "none" : "high",
      action: "restore",
      summary: `Restore ${paths.length} explicit path(s) in ${rawArgs.area} from ${rawArgs.source}.`,
      paths,
      revisions: revision ? [revision] : rawArgs.source === "head" ? ["HEAD"] : undefined,
      scopeDigest: scopeDigest(paths),
      argumentSummary: { area: rawArgs.area, source: rawArgs.source, revision, declaredPaths, paths },
    });
  },
  redactArguments: (rawArgs) => ({
    cwd: rawArgs.cwd,
    area: rawArgs.area,
    source: rawArgs.source,
    revision: rawArgs.revision,
    paths: rawArgs.paths,
  }),
  checkpoint: {
    mode: "before_write",
    scope: "pre_tool_write",
    reason: "Before explicit Git restore",
    restoreOnFailure: false,
  },
  execute: executeGitRestore,
};

function integrateRevisions(args: GitIntegrateArguments): string[] {
  const mode = args.mode ?? "start";
  if (mode !== "start") {
    if (args.target !== undefined || args.revisions !== undefined) {
      throw new Error("git_integrate continue/abort does not accept target or revisions.");
    }
    return [];
  }
  if (args.action === "revert") {
    if (!args.revisions?.length || args.revisions.length > 32) {
      throw new Error("git_integrate revert requires 1-32 explicitly ordered revisions.");
    }
    if (args.target !== undefined) throw new Error("git_integrate revert uses revisions, not target.");
    return args.revisions.map(validateGitRevision);
  }
  if (!args.target) throw new Error(`git_integrate ${args.action} requires an explicit target revision.`);
  if (args.revisions !== undefined) throw new Error(`git_integrate ${args.action} uses target, not revisions.`);
  return [validateGitRevision(args.target)];
}

const MAX_INTEGRATION_PATHS = 5_000;
const MAX_REBASE_COMMITS = 100;

function isProtectedIntegrationPath(repository: GitRepositorySnapshot, filePath: string): boolean {
  const normalized = filePath.replace(/\\/gu, "/");
  const workspacePath = repository.repositoryRoot
    ? path.posix.join(repository.repositoryRoot.replace(/\\/gu, "/"), normalized)
    : normalized;
  return normalized === ".git" || normalized.startsWith(".git/") ||
    isProtectedReadPath(normalized) || isProtectedReadPath(workspacePath);
}

async function preparationGit(
  context: ToolAccessResolutionContext | RuntimeToolExecutionContext,
  executable: string,
  root: string,
  args: string[],
  purpose: string,
  maxOutputChars = 500_000,
): Promise<GitCommandExecutionResult> {
  return executeGitCommand(services(context).processes, buildGitCommand({
    executable,
    args,
    cwd: root,
    purpose,
    maxOutputChars,
    environment: services(context).environment,
  }));
}

function boundedIntegrationPaths(
  result: GitCommandExecutionResult,
): { paths: string[]; error?: ToolStructuredError } {
  if (!result.success) return { paths: [], error: commandError("git_integrate", result) };
  if (result.outputTruncated) {
    return {
      paths: [],
      error: structuredError(
        "invalid_state",
        "Integration path preflight exceeded the bounded output; no integration was executed.",
        "git_integrate",
        true,
      ),
    };
  }
  const paths = parseNullTerminatedPaths(result.stdout);
  if (paths.length > MAX_INTEGRATION_PATHS) {
    return {
      paths: [],
      error: structuredError(
        "invalid_state",
        `Integration affects more than ${MAX_INTEGRATION_PATHS} paths; split the operation into a smaller explicit range.`,
        "git_integrate",
        false,
      ),
    };
  }
  return { paths };
}

async function commitPathSet(
  context: ToolAccessResolutionContext | RuntimeToolExecutionContext,
  executable: string,
  root: string,
  revisions: readonly string[],
): Promise<{ paths: string[]; error?: ToolStructuredError }> {
  const paths = new Set<string>();
  for (const revision of revisions) {
    const result = boundedIntegrationPaths(await preparationGit(
      context,
      executable,
      root,
      ["diff-tree", "--root", "--no-commit-id", "--name-only", "-r", "--no-renames", "-z", revision],
      "Inspect paths touched by an explicit local integration commit",
    ));
    if (result.error) return result;
    for (const filePath of result.paths) paths.add(filePath);
    if (paths.size > MAX_INTEGRATION_PATHS) {
      return {
        paths: [],
        error: structuredError(
          "invalid_state",
          `Integration affects more than ${MAX_INTEGRATION_PATHS} paths; split the operation into a smaller explicit range.`,
          "git_integrate",
          false,
        ),
      };
    }
  }
  return { paths: [...paths].sort() };
}

async function integrationPathSet(
  args: GitIntegrateArguments,
  context: ToolAccessResolutionContext | RuntimeToolExecutionContext,
  repository: GitRepositorySnapshot,
  executable: string,
  root: string,
  revisions: readonly string[],
): Promise<{ paths: string[]; error?: ToolStructuredError }> {
  const mode = args.mode ?? "start";
  if (mode !== "start") {
    const paths = changedSnapshotPaths(repository);
    const protectedPath = paths.find((entry) => isProtectedIntegrationPath(repository, entry));
    return protectedPath
      ? {
          paths,
          error: structuredError(
            "invalid_path",
            `Conflict recovery would modify a protected path: ${protectedPath}.`,
            "git_integrate",
            false,
            { path: protectedPath },
          ),
        }
      : { paths };
  }

  let pathResult: { paths: string[]; error?: ToolStructuredError };
  if (args.action === "merge") {
    const mergeBase = await preparationGit(
      context,
      executable,
      root,
      ["merge-base", "HEAD", revisions[0]!],
      "Resolve the local merge base for path-risk preflight",
      8_192,
    );
    if (!mergeBase.success || !mergeBase.stdout.trim()) {
      pathResult = { paths: [], error: commandError("git_integrate", mergeBase) };
    } else {
      pathResult = boundedIntegrationPaths(await preparationGit(
        context,
        executable,
        root,
        ["diff", "--name-only", "--no-renames", "-z", mergeBase.stdout.trim(), revisions[0]!, "--"],
        "Inspect the complete local merge path range",
      ));
    }
  } else if (args.action === "rebase") {
    const unique = await preparationGit(
      context,
      executable,
      root,
      ["rev-list", "--max-count", String(MAX_REBASE_COMMITS + 1), `${revisions[0]}..HEAD`],
      "Enumerate the bounded local rebase commit range",
      64_000,
    );
    if (!unique.success || unique.outputTruncated) {
      pathResult = {
        paths: [],
        error: unique.outputTruncated
          ? structuredError("invalid_state", "Rebase commit preflight exceeded its bounded output.", "git_integrate", true)
          : commandError("git_integrate", unique),
      };
    } else {
      const commits = unique.stdout.split(/\r?\n/gu).map((value) => value.trim()).filter(Boolean);
      if (commits.length > MAX_REBASE_COMMITS) {
        pathResult = {
          paths: [],
          error: structuredError(
            "invalid_state",
            `Rebase exceeds the ${MAX_REBASE_COMMITS}-commit local safety boundary.`,
            "git_integrate",
            false,
          ),
        };
      } else {
        const [checkoutDiff, replayed] = await Promise.all([
          preparationGit(
            context,
            executable,
            root,
            ["diff", "--name-only", "--no-renames", "-z", "HEAD", revisions[0]!, "--"],
            "Inspect paths changed when rebasing onto the explicit target",
          ).then(boundedIntegrationPaths),
          commitPathSet(context, executable, root, commits),
        ]);
        pathResult = checkoutDiff.error
          ? checkoutDiff
          : replayed.error
            ? replayed
            : { paths: [...new Set([...checkoutDiff.paths, ...replayed.paths])].sort() };
      }
    }
  } else {
    pathResult = await commitPathSet(context, executable, root, revisions);
  }
  if (pathResult.error) return pathResult;
  const protectedPath = pathResult.paths.find((entry) => isProtectedIntegrationPath(repository, entry));
  if (protectedPath) {
    return {
      paths: pathResult.paths,
      error: structuredError(
        "invalid_path",
        `Integration range touches a protected path: ${protectedPath}.`,
        "git_integrate",
        false,
        { path: protectedPath },
      ),
    };
  }
  return pathResult;
}

async function prepareIntegration(
  args: GitIntegrateArguments,
  context: ToolAccessResolutionContext | RuntimeToolExecutionContext,
): Promise<GitPreparedPreview> {
  const repository = await snapshot(context, args.cwd ?? ".");
  const baseError = mutableRepositoryError("git_integrate", repository);
  if (baseError) return { snapshot: repository, error: baseError };
  const mode = args.mode ?? "start";
  let revisions: string[];
  try {
    revisions = integrateRevisions(args);
  } catch (error) {
    return {
      snapshot: repository,
      error: structuredError("invalid_arguments", (error as Error).message, "git_integrate", false),
    };
  }
  if (mode === "start" && repository.dirty) {
    return {
      snapshot: repository,
      error: structuredError(
        repository.conflict.status === "conflicted" ? "conflicted" : "invalid_state",
        "git_integrate start requires a clean worktree, index, and untracked set.",
        "git_integrate",
        true,
      ),
    };
  }
  if (mode !== "start") {
    if (repository.conflict.status !== "conflicted") {
      return {
        snapshot: repository,
        error: structuredError("invalid_state", `No conflicted ${args.action} operation is available to ${mode}.`, "git_integrate", false),
      };
    }
    if (repository.conflict.operation !== args.action && repository.conflict.operation !== "unknown") {
      return {
        snapshot: repository,
        error: structuredError(
          "invalid_state",
          `Current conflict belongs to ${repository.conflict.operation}, not ${args.action}.`,
          "git_integrate",
          false,
        ),
      };
    }
  }
  if (!repository.repositoryRoot) {
    return { snapshot: repository, error: structuredError("not_found", "Git repository root is unavailable.", "git_integrate", false) };
  }
  const executable = await gitExecutable(context);
  if (!executable) {
    return { snapshot: repository, error: structuredError("missing_dependency", "Git executable is unavailable.", "git_integrate", false) };
  }
  const root = path.resolve(context.workspaceRoot, repository.repositoryRoot);
  for (const revision of revisions) {
    const checked = await executeGitCommand(services(context).processes, buildGitCommand({
      executable,
      args: ["rev-parse", "--verify", `${revision}^{commit}`],
      cwd: root,
      purpose: "Validate explicit integration revision",
      maxOutputChars: 8_192,
      environment: services(context).environment,
    }));
    if (!checked.success) {
      return {
        snapshot: repository,
        error: structuredError("not_found", `Integration revision was not found: ${revision}.`, "git_integrate", false),
      };
    }
  }
  const integrationPaths = await integrationPathSet(
    args,
    context,
    repository,
    executable,
    root,
    revisions,
  );
  if (integrationPaths.error) return { snapshot: repository, error: integrationPaths.error };
  let rangeSummary = "";
  if (mode === "start" && revisions.length > 0) {
    const range = args.action === "rebase"
      ? `${revisions[0]}..HEAD`
      : args.action === "merge"
        ? `HEAD..${revisions[0]}`
        : undefined;
    const previewArgs = range
      ? ["log", "--no-color", "--format=%H %s", "--max-count", "100", range]
      : ["show", "--no-patch", "--format=%H %s", ...revisions];
    const rangeResult = await executeGitCommand(services(context).processes, buildGitCommand({
      executable,
      args: previewArgs,
      cwd: root,
      purpose: "Preview the explicit integration commit range",
      maxOutputChars: 64_000,
      environment: services(context).environment,
    }));
    if (rangeResult.success) rangeSummary = rangeResult.stdout.trim();
  }
  const riskSummary = mode === "abort"
    ? ["Abort is explicit and may discard conflict-resolution edits made after the operation stopped."]
    : mode === "continue"
      ? ["Continue preserves the current conflict resolutions and invokes configured hooks without bypass flags."]
      : [
          `${args.action} will update local HEAD and may modify tracked worktree paths.`,
          "Any conflict is preserved in place and returned as a structured conflicted state.",
          "No abort, cleanup, reset, force, remote, or conflict-resolution script runs automatically.",
        ];
  const confirmationToken = createHash("sha256").update(JSON.stringify({
    stateDigest: repository.stateDigest,
    action: args.action,
    mode,
    revisions,
    paths: integrationPaths.paths,
    rangeSummary,
  })).digest("hex");
  return {
    snapshot: repository,
    preview: {
      summary: `${mode} local Git ${args.action}${revisions.length ? ` for ${revisions.join(", ")}` : ""}.`,
      confirmationToken,
      paths: integrationPaths.paths,
      revisions,
      stagedDiffSummary: rangeSummary,
      riskSummary,
    },
  };
}

function integrationCommand(args: GitIntegrateArguments): string[] {
  const mode = args.mode ?? "start";
  const subcommand = args.action === "cherry_pick" ? "cherry-pick" : args.action;
  if (mode !== "start") return [subcommand, `--${mode}`];
  const revisions = integrateRevisions(args);
  if (args.action === "merge") return ["merge", "--no-edit", revisions[0]!];
  if (args.action === "rebase") return ["rebase", revisions[0]!];
  if (args.action === "cherry_pick") return ["cherry-pick", revisions[0]!];
  return ["revert", "--no-edit", ...revisions];
}

async function changedHeadPaths(
  context: RuntimeToolExecutionContext,
  root: string,
  beforeOid: string | undefined,
  afterOid: string | undefined,
): Promise<{ paths: string[]; complete: boolean }> {
  if (!beforeOid || !afterOid || beforeOid === afterOid) return { paths: [], complete: true };
  const result = await runGit(
    context,
    root,
    ["diff", "--name-only", "--no-renames", "-z", beforeOid, afterOid, "--"],
    "Inspect paths actually changed by local Git integration",
    { maxOutputChars: 500_000 },
  );
  return result.success && !result.outputTruncated
    ? { paths: parseNullTerminatedPaths(result.stdout), complete: true }
    : { paths: [], complete: false };
}

async function executeGitIntegrate(
  args: GitIntegrateArguments,
  context: RuntimeToolExecutionContext,
): Promise<ToolResult<GitOperationResult>> {
  const startedAt = context.moduleContext.clock.now();
  const startedEpoch = Date.now();
  let prepared = await prepareIntegration(args, context);
  if (prepared.error) {
    const status = prepared.error.type === "not_found"
      ? "not_found"
      : prepared.error.type === "conflicted"
        ? "conflicted"
        : prepared.error.type === "invalid_path"
          ? "protected"
        : prepared.error.type === "invalid_arguments"
          ? "failed"
          : "invalid_state";
    return result(context, startedAt, startedEpoch, {
      kind: "git_operation",
      toolName: "git_integrate",
      action: args.action,
      status,
      repository: prepared.snapshot,
      headBefore: prepared.snapshot.head,
      headAfter: prepared.snapshot.head,
      changedPaths: [],
      conflict: prepared.snapshot.conflict,
      error: prepared.error,
    }, false);
  }
  if (!args.confirmationToken) {
    return result(context, startedAt, startedEpoch, {
      kind: "git_operation",
      toolName: "git_integrate",
      action: args.action,
      status: "preview",
      repository: prepared.snapshot,
      headBefore: prepared.snapshot.head,
      headAfter: prepared.snapshot.head,
      changedPaths: [],
      conflict: prepared.snapshot.conflict,
      preview: prepared.preview,
    }, true);
  }
  if (args.confirmationToken !== prepared.preview!.confirmationToken) {
    const error = structuredError(
      "invalid_state",
      "Integration confirmation does not match the current action, revisions, HEAD, and dirty state.",
      "git_integrate",
      true,
    );
    return result(context, startedAt, startedEpoch, {
      kind: "git_operation",
      toolName: "git_integrate",
      action: args.action,
      status: "invalid_state",
      repository: prepared.snapshot,
      headBefore: prepared.snapshot.head,
      headAfter: prepared.snapshot.head,
      changedPaths: [],
      conflict: prepared.snapshot.conflict,
      preview: prepared.preview,
      error,
    }, false);
  }
  const root = repositoryRoot(context, prepared.snapshot);
  return withGitMutationLock(mutationLockKey(context, prepared.snapshot), async () => {
    prepared = await prepareIntegration(args, context);
    const stateError = approvedStateError(context, prepared.snapshot, "git_integrate");
    const tokenMismatch = args.confirmationToken !== prepared.preview?.confirmationToken;
    if (prepared.error || stateError || tokenMismatch) {
      const error = prepared.error ?? stateError ?? structuredError(
        "invalid_state",
        "Repository state changed before integration; request a new preview.",
        "git_integrate",
        true,
      );
      return result(context, startedAt, startedEpoch, {
        kind: "git_operation",
        toolName: "git_integrate",
        action: args.action,
        status: error.type === "conflicted"
          ? "conflicted"
          : error.type === "invalid_path"
            ? "protected"
            : "invalid_state",
        repository: prepared.snapshot,
        headBefore: prepared.snapshot.head,
        headAfter: prepared.snapshot.head,
        changedPaths: [],
        conflict: prepared.snapshot.conflict,
        preview: prepared.preview,
        error,
      }, false);
    }
    const before = prepared.snapshot;
    const command = await runGit(
      context,
      root,
      integrationCommand(args),
      `Execute explicit local Git ${args.action} ${args.mode ?? "start"}`,
      { maxOutputChars: 500_000 },
    );
    const after = await snapshot(context, before.repositoryRoot!);
    const headImpact = await changedHeadPaths(context, root, before.head.oid, after.head.oid);
    const changedPaths = [...new Set([
      ...(headImpact.complete ? headImpact.paths : prepared.preview?.paths ?? []),
      ...changedSnapshotPaths(before),
      ...changedSnapshotPaths(after),
    ])].sort();
    if (!command.success && after.conflict.status === "conflicted") {
      const error = structuredError(
        "conflicted",
        `${args.action} stopped with conflicts; the conflict state was preserved for explicit recovery.`,
        "git_integrate",
        true,
        { command: command.display, exitCode: command.exitCode ?? undefined, stderr: command.stderr },
      );
      return result(context, startedAt, startedEpoch, {
        kind: "git_operation",
        toolName: "git_integrate",
        action: args.action,
        status: "conflicted",
        repository: after,
        headBefore: before.head,
        headAfter: after.head,
        changedPaths,
        conflict: after.conflict,
        details: {
          mode: args.mode ?? "start",
          revisions: integrateRevisions(args),
          conflictPreserved: true,
          pathEnumerationComplete: headImpact.complete,
        },
        error,
      }, false);
    }
    const error = command.success ? undefined : commandError("git_integrate", command);
    return result(context, startedAt, startedEpoch, {
      kind: "git_operation",
      toolName: "git_integrate",
      action: args.action,
      status: error ? "failed" : "completed",
      repository: after,
      headBefore: before.head,
      headAfter: after.head,
      changedPaths,
      conflict: after.conflict,
      details: {
        mode: args.mode ?? "start",
        revisions: integrateRevisions(args),
        conflictPreserved: false,
        automaticAbortUsed: false,
        pathEnumerationComplete: headImpact.complete,
      },
      error,
    }, !error);
  }, context.signal);
}

export const gitIntegrateTool: RuntimeToolSpec<GitIntegrateArguments> = {
  name: "git_integrate",
  description: "Preview and explicitly run local merge, rebase, cherry-pick, or revert while preserving recoverable conflicts.",
  inputSchema: {
    type: "object",
    additionalProperties: false,
    required: ["action"],
    properties: {
      cwd: { type: "string" },
      action: { type: "string", enum: ["merge", "rebase", "cherry_pick", "revert"] },
      mode: { type: "string", enum: ["start", "continue", "abort"], default: "start" },
      target: { type: "string", minLength: 1, maxLength: 512 },
      revisions: { type: "array", minItems: 1, maxItems: 32, items: { type: "string", minLength: 1, maxLength: 512 } },
      confirmationToken: { type: "string", pattern: "^[a-f0-9]{64}$" },
    },
  },
  readOnly: false,
  permissionCategory: "execute_command",
  sideEffectLevel: "high",
  timeoutCategory: "slow",
  groups: ["git", "local_changes", "integration"],
  selection: {
    groups: ["git_integrate", "integration"],
    keywords: ["git merge branch", "git rebase", "git cherry-pick", "git revert commit", "合并 Git 分支", "变基", "拣选提交", "撤销提交"],
  },
  capabilityRequirements: [{ name: "git", required: true, reason: "git_integrate invokes the Git executable." }],
  resolveAccess: (rawArgs, context) => rawArgs.confirmationToken
    ? mutationAccess(
        context.paths.normalize(rawArgs.cwd ?? "."),
        `git ${rawArgs.action} <parameterized explicit mode/revisions>`,
        `Execute an explicitly confirmed local Git ${rawArgs.action}.`,
      )
    : [{
        kind: "command_execute" as const,
        cwd: context.paths.normalize(rawArgs.cwd ?? "."),
        command: "git log/show <bounded integration preview>",
        reason: "Read the integration range and risk summary before authorization.",
      }],
  resolvePermission: async (rawArgs, context) => {
    const prepared = await prepareIntegration(rawArgs, context);
    const confirmed = Boolean(
      !prepared.error && rawArgs.confirmationToken && rawArgs.confirmationToken === prepared.preview?.confirmationToken,
    );
    const revisions = prepared.preview?.revisions;
    return permissionProfile({
      repository: prepared.snapshot,
      readOnly: !confirmed,
      permissionCategory: confirmed ? "execute_command" : "read_only",
      sideEffectLevel: confirmed ? "high" : "none",
      action: rawArgs.action,
      summary: confirmed
        ? `Execute confirmed Git ${rawArgs.action} ${rawArgs.mode ?? "start"}.`
        : `Preview Git ${rawArgs.action} ${rawArgs.mode ?? "start"} without writing.`,
      revisions,
      paths: prepared.preview?.paths,
      argumentSummary: {
        action: rawArgs.action,
        mode: rawArgs.mode ?? "start",
        target: rawArgs.target,
        revisions: rawArgs.revisions,
        confirmationToken: rawArgs.confirmationToken ? "[provided]" : "[preview only]",
      },
    });
  },
  redactArguments: (rawArgs) => ({
    cwd: rawArgs.cwd,
    action: rawArgs.action,
    mode: rawArgs.mode ?? "start",
    target: rawArgs.target,
    revisions: rawArgs.revisions,
    confirmationToken: rawArgs.confirmationToken ? "[provided]" : undefined,
  }),
  execute: executeGitIntegrate,
};
