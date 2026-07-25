import { createHash } from "node:crypto";
import { promises as fs } from "node:fs";
import path from "node:path";

import type {
  GitConflictOperation,
  GitConflictState,
  GitPathChange,
  GitPathChangeKind,
  GitRepositorySnapshot,
  GitWorktreeState,
} from "../../../../shared-schema/src/index.js";
import type { ToolProcessRunner } from "../../tool-module.js";
import { isProtectedReadPath } from "../../repository-explorer.js";

import {
  buildGitCommand,
  executeGitCommand,
  type GitCommandExecutionResult,
} from "./command-builder.js";

export interface GitRepositoryContext {
  workspaceRoot: string;
  gitExecutable: string;
  processes: ToolProcessRunner;
  clock?: { now(): string };
  environment?: NodeJS.ProcessEnv;
}

const mutationLocks = new Map<string, Promise<void>>();
const MAX_STATE_FINGERPRINT_BYTES = 2_000_000;
const MAX_STATE_FINGERPRINT_FILES = 256;

function normalizedRelative(root: string, target: string): string {
  return (path.relative(root, target) || ".").replace(/\\/gu, "/");
}

function isInside(root: string, target: string): boolean {
  const relative = path.relative(root, target);
  return relative === "" || (!relative.startsWith("..") && !path.isAbsolute(relative));
}

async function trustedAbsolutePath(workspaceRoot: string, value: string): Promise<string> {
  const lexical = path.isAbsolute(value) ? path.resolve(value) : path.resolve(workspaceRoot, value);
  if (!isInside(path.resolve(workspaceRoot), lexical)) throw new Error(`Git cwd escapes the trusted workspace: ${value}.`);
  const [realWorkspace, realTarget] = await Promise.all([fs.realpath(workspaceRoot), fs.realpath(lexical)]);
  if (!isInside(realWorkspace, realTarget)) throw new Error(`Git cwd resolves outside the trusted workspace: ${value}.`);
  return realTarget;
}

async function run(
  context: GitRepositoryContext,
  cwd: string,
  args: string[],
  purpose: string,
  maxOutputChars = 2_000_000,
): Promise<GitCommandExecutionResult> {
  return executeGitCommand(context.processes, buildGitCommand({
    executable: context.gitExecutable,
    args,
    cwd,
    purpose,
    maxOutputChars,
    environment: context.environment,
  }));
}

function changeKind(code: string): GitPathChangeKind {
  switch (code) {
    case "A": return "added";
    case "M": return "modified";
    case "D": return "deleted";
    case "R": return "renamed";
    case "C": return "copied";
    case "T": return "type_changed";
    case "U": return "unmerged";
    default: return "unknown";
  }
}

function change(pathValue: string, code: string, previousPath?: string): GitPathChange {
  return {
    path: pathValue.replace(/\\/gu, "/"),
    previousPath: previousPath?.replace(/\\/gu, "/"),
    status: code,
    kind: changeKind(code),
  };
}

export function parseGitStatusPorcelainV2(output: string): {
  staged: GitPathChange[];
  unstaged: GitPathChange[];
  untracked: string[];
  conflicted: string[];
} {
  const staged: GitPathChange[] = [];
  const unstaged: GitPathChange[] = [];
  const untracked: string[] = [];
  const conflicted = new Set<string>();
  const records = output.split("\0");
  for (let index = 0; index < records.length; index += 1) {
    const record = records[index];
    if (!record || record.startsWith("# ") || record.startsWith("! ")) continue;
    if (record.startsWith("? ")) {
      untracked.push(record.slice(2).replace(/\\/gu, "/"));
      continue;
    }
    let xy = "..";
    let filePath = "";
    let previousPath: string | undefined;
    if (record.startsWith("1 ")) {
      const match = /^1 ([^. ]{0,2}|[^ ]{2}) [^ ]+ [^ ]+ [^ ]+ [^ ]+ [^ ]+ [^ ]+ (.*)$/u.exec(record);
      if (!match) continue;
      xy = match[1]!;
      filePath = match[2]!;
    } else if (record.startsWith("2 ")) {
      const match = /^2 ([^ ]{2}) [^ ]+ [^ ]+ [^ ]+ [^ ]+ [^ ]+ [^ ]+ [^ ]+ (.*)$/u.exec(record);
      if (!match) continue;
      xy = match[1]!;
      filePath = match[2]!;
      previousPath = records[index + 1] || undefined;
      index += 1;
    } else if (record.startsWith("u ")) {
      const parts = record.split(" ");
      xy = parts[1] ?? "UU";
      filePath = parts.slice(10).join(" ");
      if (filePath) conflicted.add(filePath.replace(/\\/gu, "/"));
    } else {
      continue;
    }
    if (!filePath) continue;
    const [indexCode = ".", worktreeCode = "."] = xy;
    const isConflict = record.startsWith("u ") || /^(?:DD|AU|UD|UA|DU|AA|UU)$/u.test(xy);
    if (isConflict) conflicted.add(filePath.replace(/\\/gu, "/"));
    if (indexCode !== ".") staged.push(change(filePath, isConflict ? "U" : indexCode, previousPath));
    if (worktreeCode !== ".") unstaged.push(change(filePath, isConflict ? "U" : worktreeCode, previousPath));
  }
  return {
    staged: staged.sort((a, b) => a.path.localeCompare(b.path)),
    unstaged: unstaged.sort((a, b) => a.path.localeCompare(b.path)),
    untracked: [...new Set(untracked)].sort(),
    conflicted: [...conflicted].sort(),
  };
}

export function parseGitNameStatus(output: string): GitPathChange[] {
  const records = output.split("\0").filter(Boolean);
  const changes: GitPathChange[] = [];
  for (let index = 0; index < records.length;) {
    const status = records[index++]!;
    const code = status.charAt(0);
    const first = records[index++];
    if (!first) break;
    if (code === "R" || code === "C") {
      const second = records[index++];
      if (!second) break;
      changes.push(change(second, code, first));
    } else {
      changes.push(change(first, code));
    }
  }
  return changes;
}

function displayWorktreePath(workspaceRoot: string, absolutePath: string): { path: string; trusted: boolean } {
  const resolved = path.resolve(absolutePath);
  if (isInside(path.resolve(workspaceRoot), resolved)) {
    return { path: normalizedRelative(workspaceRoot, resolved), trusted: true };
  }
  return { path: `<outside-workspace>/${path.basename(resolved)}`, trusted: false };
}

async function resolveMetadataPath(
  workspaceRoot: string,
  repositoryRoot: string,
  value: string,
): Promise<{ path: string; trusted: boolean }> {
  const absolute = path.isAbsolute(value) ? path.resolve(value) : path.resolve(repositoryRoot, value);
  try {
    const [realWorkspace, realTarget] = await Promise.all([
      fs.realpath(workspaceRoot),
      fs.realpath(absolute),
    ]);
    return displayWorktreePath(realWorkspace, realTarget);
  } catch {
    const displayed = displayWorktreePath(workspaceRoot, absolute);
    return { path: displayed.path, trusted: false };
  }
}

export function parseGitWorktreePorcelain(output: string, workspaceRoot: string): GitWorktreeState[] {
  const records: GitWorktreeState[] = [];
  let current: Partial<GitWorktreeState> | undefined;
  const flush = (): void => {
    if (!current?.path) return;
    records.push({
      path: current.path,
      head: current.head,
      branch: current.branch,
      detached: current.detached ?? false,
      bare: current.bare ?? false,
      locked: current.locked ?? false,
      lockReason: current.lockReason,
      prunable: current.prunable ?? false,
      pruneReason: current.pruneReason,
      trusted: current.trusted ?? false,
    });
    current = undefined;
  };
  for (const line of `${output}\n`.split(/\r?\n/gu)) {
    if (!line) {
      flush();
      continue;
    }
    const separator = line.indexOf(" ");
    const key = separator < 0 ? line : line.slice(0, separator);
    const value = separator < 0 ? "" : line.slice(separator + 1);
    if (key === "worktree") {
      flush();
      const displayed = displayWorktreePath(workspaceRoot, value);
      current = { path: displayed.path, trusted: displayed.trusted };
      continue;
    }
    current ??= {};
    if (key === "HEAD") current.head = value;
    else if (key === "branch") current.branch = value.replace(/^refs\/heads\//u, "");
    else if (key === "detached") current.detached = true;
    else if (key === "bare") current.bare = true;
    else if (key === "locked") {
      current.locked = true;
      current.lockReason = value || undefined;
    } else if (key === "prunable") {
      current.prunable = true;
      current.pruneReason = value || undefined;
    }
  }
  return records;
}

export function isProtectedGitBranch(branch: string | undefined, protectedBranches: readonly string[]): boolean {
  if (!branch) return false;
  const folded = process.platform === "win32" || process.platform === "darwin"
    ? branch.toLocaleLowerCase("en-US")
    : branch;
  return protectedBranches.some((candidate) => (
    process.platform === "win32" || process.platform === "darwin"
      ? candidate.toLocaleLowerCase("en-US")
      : candidate
  ) === folded);
}

async function conflictOperation(
  context: GitRepositoryContext,
  root: string,
): Promise<GitConflictOperation | undefined> {
  const refs: Array<[GitConflictOperation, string]> = [
    ["merge", "MERGE_HEAD"],
    ["rebase", "REBASE_HEAD"],
    ["cherry_pick", "CHERRY_PICK_HEAD"],
    ["revert", "REVERT_HEAD"],
  ];
  for (const [operation, ref] of refs) {
    const result = await run(context, root, ["rev-parse", "--verify", "--quiet", ref], `Detect ${operation} state`, 4_096);
    if (result.success) return operation;
  }
  return undefined;
}

function conflictState(operation: GitConflictOperation | undefined, files: string[]): GitConflictState {
  if (!operation && files.length === 0) return { status: "none", files: [], nextSteps: [] };
  const resolvedOperation = operation ?? "unknown";
  return {
    status: "conflicted",
    operation: resolvedOperation,
    files,
    nextSteps: [
      "Inspect and resolve only the listed conflict files; the runtime has preserved the Git conflict state.",
      "Stage each resolved path explicitly with git_stage.",
      `Invoke git_integrate with action=${resolvedOperation} and mode=continue, or explicitly request mode=abort.`,
    ],
  };
}

function stateDigest(value: Omit<GitRepositorySnapshot, "stateDigest" | "capturedAt">): string {
  return createHash("sha256").update(JSON.stringify(value)).digest("hex");
}

function protectedRepositoryPath(repositoryRoot: string, filePath: string): boolean {
  const normalized = filePath.replace(/\\/gu, "/");
  const workspacePath = path.posix.join(repositoryRoot.replace(/\\/gu, "/"), normalized);
  return normalized === ".git" || normalized.startsWith(".git/") ||
    isProtectedReadPath(normalized) || isProtectedReadPath(workspacePath);
}

async function hashUntrackedState(
  context: GitRepositoryContext,
  root: string,
  paths: readonly string[],
): Promise<{ digest: string; failure?: string }> {
  const hash = createHash("sha256");
  if (paths.length > MAX_STATE_FINGERPRINT_FILES) {
    return { digest: hash.digest("hex"), failure: "untracked_fingerprint_file_limit" };
  }
  let totalBytes = 0;
  const realWorkspace = await fs.realpath(context.workspaceRoot);
  for (const filePath of [...paths].sort()) {
    const absolute = path.resolve(root, filePath);
    if (!isInside(root, absolute) || !isInside(context.workspaceRoot, absolute)) {
      return { digest: hash.digest("hex"), failure: "untracked_path_untrusted" };
    }
    let info;
    try {
      info = await fs.lstat(absolute);
    } catch {
      return { digest: hash.digest("hex"), failure: "untracked_path_unreadable" };
    }
    hash.update(filePath).update("\0");
    if (info.isSymbolicLink()) {
      const target = await fs.readlink(absolute);
      totalBytes += Buffer.byteLength(target);
      if (totalBytes > MAX_STATE_FINGERPRINT_BYTES) {
        return { digest: hash.digest("hex"), failure: "untracked_fingerprint_byte_limit" };
      }
      hash.update("symlink\0").update(target).update("\0");
      continue;
    }
    if (!info.isFile()) {
      return { digest: hash.digest("hex"), failure: "untracked_path_not_file" };
    }
    totalBytes += info.size;
    if (totalBytes > MAX_STATE_FINGERPRINT_BYTES) {
      return { digest: hash.digest("hex"), failure: "untracked_fingerprint_byte_limit" };
    }
    const realFile = await fs.realpath(absolute);
    if (!isInside(realWorkspace, realFile)) {
      return { digest: hash.digest("hex"), failure: "untracked_path_untrusted" };
    }
    hash.update("file\0").update(await fs.readFile(realFile)).update("\0");
  }
  return { digest: hash.digest("hex") };
}

function emptySnapshot(cwd: string, capturedAt: string): GitRepositorySnapshot {
  const body: Omit<GitRepositorySnapshot, "stateDigest" | "capturedAt"> = {
    repositoryState: "not_repository",
    cwd,
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
    stateComplete: true,
    stateFailures: [],
  };
  return { ...body, stateDigest: stateDigest(body), capturedAt };
}

export async function captureGitRepositorySnapshot(
  context: GitRepositoryContext,
  cwd = ".",
  protectedBranches: readonly string[] = ["main", "master"],
): Promise<GitRepositorySnapshot> {
  const requested = await trustedAbsolutePath(context.workspaceRoot, cwd);
  const relativeCwd = normalizedRelative(context.workspaceRoot, requested);
  const capturedAt = context.clock?.now() ?? new Date().toISOString();
  const inside = await run(context, requested, ["rev-parse", "--is-inside-work-tree"], "Detect Git worktree", 4_096);
  const bareProbe = inside.success && inside.stdout.trim() === "true"
    ? undefined
    : await run(context, requested, ["rev-parse", "--is-bare-repository"], "Detect bare Git repository", 4_096);
  const isWorktree = inside.success && inside.stdout.trim() === "true";
  const isBare = Boolean(bareProbe?.success && bareProbe.stdout.trim() === "true");
  if (!isWorktree && !isBare) return emptySnapshot(relativeCwd, capturedAt);

  const rootResult = await run(
    context,
    requested,
    isBare ? ["rev-parse", "--absolute-git-dir"] : ["rev-parse", "--show-toplevel"],
    "Resolve trusted Git repository root",
    8_192,
  );
  if (!rootResult.success || !rootResult.stdout.trim()) return emptySnapshot(relativeCwd, capturedAt);
  const root = await trustedAbsolutePath(context.workspaceRoot, rootResult.stdout.trim());
  const repositoryRoot = normalizedRelative(context.workspaceRoot, root);
  const [gitDirResult, commonDirResult] = await Promise.all([
    run(context, root, ["rev-parse", "--absolute-git-dir"], "Resolve Git metadata directory", 8_192),
    run(context, root, ["rev-parse", "--git-common-dir"], "Resolve shared Git metadata directory", 8_192),
  ]);
  const gitDirLocation = gitDirResult.success && !gitDirResult.outputTruncated && gitDirResult.stdout.trim()
    ? await resolveMetadataPath(context.workspaceRoot, root, gitDirResult.stdout.trim())
    : { path: "<unresolved-git-dir>", trusted: false };
  const commonDirLocation = commonDirResult.success && !commonDirResult.outputTruncated && commonDirResult.stdout.trim()
    ? await resolveMetadataPath(context.workspaceRoot, root, commonDirResult.stdout.trim())
    : { path: "<unresolved-common-dir>", trusted: false };
  const metadataFailures = [
    ...(!gitDirLocation.trusted ? ["git_dir_untrusted"] : []),
    ...(!commonDirLocation.trusted ? ["common_dir_untrusted"] : []),
  ];

  const [branchResult, headResult, superprojectResult, worktreeResult] = await Promise.all([
    run(context, root, ["symbolic-ref", "--quiet", "--short", "HEAD"], "Read current Git branch", 8_192),
    run(context, root, ["rev-parse", "--verify", "HEAD"], "Read current Git HEAD", 8_192),
    isBare
      ? Promise.resolve(undefined)
      : run(context, root, ["rev-parse", "--show-superproject-working-tree"], "Detect Git submodule", 8_192),
    run(context, root, ["worktree", "list", "--porcelain"], "List Git worktrees", 256_000),
  ]);
  const branch = branchResult.success ? branchResult.stdout.trim() || undefined : undefined;
  const oid = headResult.success ? headResult.stdout.trim() || undefined : undefined;
  const head = {
    oid,
    shortOid: oid?.slice(0, 12),
    branch,
    detached: Boolean(oid && !branch),
    unborn: Boolean(branch && !oid),
  };
  const superproject = superprojectResult?.success ? superprojectResult.stdout.trim() : "";
  const superprojectRoot = superproject
    ? displayWorktreePath(context.workspaceRoot, path.resolve(superproject)).path
    : undefined;

  let status = { staged: [] as GitPathChange[], unstaged: [] as GitPathChange[], untracked: [] as string[], conflicted: [] as string[] };
  const stateFailures = [...metadataFailures];
  const contentHash = createHash("sha256");
  if (!isBare) {
    const statusResult = await run(
      context,
      root,
      ["status", "--porcelain=v2", "-z", "--untracked-files=all", "--branch"],
      "Capture bounded Git repository status",
    );
    if (statusResult.success && !statusResult.outputTruncated) {
      status = parseGitStatusPorcelainV2(statusResult.stdout);
      contentHash.update(statusResult.stdout).update("\0");
      const visiblePaths = [
        ...status.staged.map((entry) => entry.path),
        ...status.unstaged.map((entry) => entry.path),
        ...status.untracked,
        ...status.conflicted,
      ];
      if (visiblePaths.some((entry) => protectedRepositoryPath(repositoryRoot, entry))) {
        stateFailures.push("protected_status_path");
      } else {
        if (status.unstaged.length > 0 || status.conflicted.length > 0) {
          const diffResult = await run(
            context,
            root,
            ["diff", "--no-ext-diff", "--no-textconv", "--binary", "--full-index"],
            "Fingerprint bounded dirty worktree content",
          );
          if (diffResult.success && !diffResult.outputTruncated) {
            contentHash.update(diffResult.stdout).update("\0");
          } else {
            stateFailures.push(diffResult.outputTruncated ? "worktree_fingerprint_truncated" : "worktree_fingerprint_failed");
          }
        }
        if (status.untracked.length > 0) {
          const untracked = await hashUntrackedState(context, root, status.untracked);
          contentHash.update(untracked.digest).update("\0");
          if (untracked.failure) stateFailures.push(untracked.failure);
        }
      }
    } else stateFailures.push(statusResult.outputTruncated ? "status_truncated" : "status_failed");
  }
  const operation = isBare ? undefined : await conflictOperation(context, root);
  const conflict = conflictState(operation, status.conflicted);
  const worktrees = worktreeResult.success && !worktreeResult.outputTruncated
    ? parseGitWorktreePorcelain(worktreeResult.stdout, context.workspaceRoot)
    : [];
  if (!worktreeResult.success || worktreeResult.outputTruncated) {
    stateFailures.push(worktreeResult.outputTruncated ? "worktrees_truncated" : "worktrees_failed");
  }
  const body: Omit<GitRepositorySnapshot, "stateDigest" | "capturedAt"> = {
    repositoryState: isBare ? "bare" : "worktree",
    cwd: relativeCwd,
    repositoryRoot,
    gitDir: gitDirLocation.path,
    commonDir: commonDirLocation.path,
    gitDirTrusted: gitDirLocation.trusted,
    commonDirTrusted: commonDirLocation.trusted,
    isRepository: true,
    isBare,
    isSubmodule: Boolean(superproject),
    superprojectRoot,
    head,
    protectedBranch: isProtectedGitBranch(branch, protectedBranches),
    dirty: stateFailures.length > 0 || status.staged.length > 0 || status.unstaged.length > 0 || status.untracked.length > 0 || status.conflicted.length > 0,
    ...status,
    worktrees,
    conflict,
    stateComplete: stateFailures.length === 0,
    stateFailures,
    contentDigest: contentHash.digest("hex"),
  };
  return { ...body, stateDigest: stateDigest(body), capturedAt };
}

export async function resolveTrustedRepositoryPath(
  workspaceRoot: string,
  repositoryRoot: string,
  relativePath: string,
): Promise<{ absolutePath: string; workspaceRelativePath: string; repositoryRelativePath: string }> {
  const root = await trustedAbsolutePath(workspaceRoot, repositoryRoot);
  const absolutePath = path.resolve(root, relativePath);
  if (!isInside(root, absolutePath) || !isInside(path.resolve(workspaceRoot), absolutePath)) {
    throw new Error(`Git path escapes the trusted repository: ${relativePath}.`);
  }
  return {
    absolutePath,
    workspaceRelativePath: normalizedRelative(workspaceRoot, absolutePath),
    repositoryRelativePath: normalizedRelative(root, absolutePath),
  };
}

export async function withGitMutationLock<T>(
  repositoryRoot: string,
  fn: () => Promise<T>,
  signal?: AbortSignal,
): Promise<T> {
  const key = path.resolve(repositoryRoot);
  const previous = mutationLocks.get(key) ?? Promise.resolve();
  let release = (): void => undefined;
  const gate = new Promise<void>((resolve) => {
    release = resolve;
  });
  const tail = previous.then(() => gate);
  mutationLocks.set(key, tail);
  await previous;
  try {
    signal?.throwIfAborted();
    return await fn();
  } finally {
    release();
    if (mutationLocks.get(key) === tail) mutationLocks.delete(key);
  }
}
