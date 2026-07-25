import path from "node:path";

import type { ToolProcessRunner, ToolProcessResult } from "../../tool-module.js";

const LOCAL_GIT_SUBCOMMANDS = new Set([
  "add",
  "apply",
  "blame",
  "branch",
  "cat-file",
  "check-ref-format",
  "cherry-pick",
  "commit",
  "config",
  "diff",
  "diff-tree",
  "for-each-ref",
  "log",
  "ls-tree",
  "ls-files",
  "merge",
  "merge-base",
  "rebase",
  "restore",
  "rev-list",
  "rev-parse",
  "revert",
  "show",
  "show-ref",
  "status",
  "switch",
  "symbolic-ref",
  "worktree",
] as const);

const FORBIDDEN_GIT_SUBCOMMANDS = new Set([
  "checkout",
  "clean",
  "clone",
  "fetch",
  "ls-remote",
  "pull",
  "push",
  "remote",
  "reset",
  "send-pack",
  "submodule",
] as const);

const FORBIDDEN_OPTION_TOKENS = new Set([
  "--amend",
  "--autostash",
  "--delete",
  "--discard-changes",
  "--force",
  "--force-if-includes",
  "--force-with-lease",
  "--hard",
  "--ignore-unmerged",
  "--no-verify",
  "--onto",
  "-B",
  "-C",
  "-D",
  "-f",
] as const);

const OPTION_VALUE_TOKENS = new Set([
  "--author",
  "--date",
  "--format",
  "--max-count",
  "--message",
  "--since",
  "--source",
  "--until",
  "-L",
  "-m",
] as const);

const ALLOWED_SHORT_OPTIONS = new Set(["-L", "-b", "-d", "-m", "-r", "-z"] as const);
const ALLOWED_LONG_OPTIONS = new Set([
  "--abort",
  "--absolute-git-dir",
  "--author",
  "--binary",
  "--branch",
  "--cached",
  "--check",
  "--continue",
  "--date",
  "--exclude-standard",
  "--format",
  "--full-index",
  "--git-common-dir",
  "--get",
  "--is-ancestor",
  "--is-bare-repository",
  "--is-inside-work-tree",
  "--line-porcelain",
  "--max-count",
  "--name-only",
  "--no-color",
  "--no-commit-id",
  "--no-edit",
  "--no-ext-diff",
  "--no-patch",
  "--no-renames",
  "--no-textconv",
  "--numstat",
  "--others",
  "--patch",
  "--porcelain",
  "--quiet",
  "--root",
  "--short",
  "--show-superproject-working-tree",
  "--show-toplevel",
  "--since",
  "--sort",
  "--source",
  "--staged",
  "--stat",
  "--summary",
  "--until",
  "--untracked-files",
  "--verify",
  "--whitespace",
  "--worktree",
] as const);

const FORBIDDEN_ROUTING_ENVIRONMENT = new Set([
  "GIT_ALTERNATE_OBJECT_DIRECTORIES",
  "GIT_COMMON_DIR",
  "GIT_DIR",
  "GIT_INDEX_FILE",
  "GIT_OBJECT_DIRECTORY",
  "GIT_WORK_TREE",
] as const);

const MAX_ARGUMENT_COUNT = 512;
const MAX_ARGUMENT_CHARS = 32_768;
const DEFAULT_MAX_OUTPUT_CHARS = 2_000_000;

export interface GitCommandSpec {
  executable: string;
  args: string[];
  cwd: string;
  display: string;
  purpose: string;
  maxOutputChars: number;
  timeoutMs: number;
  input?: string;
  environment?: NodeJS.ProcessEnv;
}

export interface GitCommandExecutionResult extends ToolProcessResult {
  success: boolean;
  display: string;
  purpose: string;
}

export interface BuildGitCommandInput {
  executable: string;
  args: readonly string[];
  cwd: string;
  purpose: string;
  maxOutputChars?: number;
  timeoutMs?: number;
  input?: string;
  environment?: NodeJS.ProcessEnv;
}

function assertBoundedText(value: string, label: string, maximum = MAX_ARGUMENT_CHARS): void {
  if (!value || value.length > maximum || /[\u0000]/u.test(value)) {
    throw new Error(`${label} must contain 1-${maximum} characters and no NUL bytes.`);
  }
}

function quoteDisplayArgument(value: string): string {
  const redacted = redactGitText(value);
  return /^[A-Za-z0-9_./:@{}^~+=,-]+$/u.test(redacted)
    ? redacted
    : JSON.stringify(redacted);
}

function validateGitArguments(args: readonly string[]): void {
  if (args.length === 0 || args.length > MAX_ARGUMENT_COUNT) {
    throw new Error(`Git commands require 1-${MAX_ARGUMENT_COUNT} parameterized arguments.`);
  }
  const subcommand = args[0]!;
  if (FORBIDDEN_GIT_SUBCOMMANDS.has(subcommand as never) || !LOCAL_GIT_SUBCOMMANDS.has(subcommand as never)) {
    throw new Error(`Git subcommand is outside the local phase-18 allowlist: ${subcommand}.`);
  }
  let afterPathSeparator = false;
  let skipOptionValue = false;
  for (const [index, argument] of args.entries()) {
    assertBoundedText(argument, `Git argument ${index}`);
    if (index === 0) continue;
    if (afterPathSeparator) continue;
    if (skipOptionValue) {
      skipOptionValue = false;
      continue;
    }
    if (argument === "--") {
      afterPathSeparator = true;
      continue;
    }
    if (argument.startsWith("--")) {
      const name = argument.split("=", 1)[0]!;
      if (!ALLOWED_LONG_OPTIONS.has(name as never)) {
        throw new Error(`Unsupported Git long option: ${name}.`);
      }
    } else if (argument.startsWith("-") && argument !== "-" && !ALLOWED_SHORT_OPTIONS.has(argument as never)) {
      throw new Error(`Unsupported or combined Git short option: ${argument}.`);
    }
    if (OPTION_VALUE_TOKENS.has(argument as never)) {
      skipOptionValue = true;
      continue;
    }
    if (FORBIDDEN_OPTION_TOKENS.has(argument as never)) {
      throw new Error(`Destructive Git option is not supported: ${argument}.`);
    }
    if (/^--(?:force|remote|upload-pack|receive-pack)(?:=|$)/u.test(argument)) {
      throw new Error(`Remote or force Git option is not supported: ${argument.split("=", 1)[0]}.`);
    }
  }
  if (subcommand === "worktree" && args[1] && !["add", "list", "remove"].includes(args[1])) {
    throw new Error(`Unsupported Git worktree action: ${args[1]}.`);
  }
  if (subcommand === "config" && !(args.length === 3 && args[1] === "--get" && args[2] === "core.hooksPath")) {
    throw new Error("Git config access is limited to reading core.hooksPath for deterministic commit safety.");
  }
}

function sanitizeGitEnvironment(environment: NodeJS.ProcessEnv | undefined): NodeJS.ProcessEnv | undefined {
  if (!environment) return undefined;
  return Object.fromEntries(Object.entries(environment).filter(([name]) => (
    !FORBIDDEN_ROUTING_ENVIRONMENT.has(name.toLocaleUpperCase("en-US") as never)
  )));
}

export function redactGitText(value: string): string {
  return value
    .replace(/(https?:\/\/)[^\s/@:]+:[^\s/@]+@/giu, "$1[REDACTED]@")
    .replace(/((?:authorization|password|secret|token)\s*[=:]\s*)[^\s,;]+/giu, "$1[REDACTED]")
    .replace(/([?&](?:access_token|auth|key|token)=)[^&#\s]+/giu, "$1[REDACTED]");
}

export function buildGitCommand(input: BuildGitCommandInput): GitCommandSpec {
  assertBoundedText(input.executable, "Git executable", 4_096);
  assertBoundedText(input.purpose, "Git command purpose", 4_096);
  validateGitArguments(input.args);
  if (!path.isAbsolute(input.cwd)) throw new Error("Git command cwd must be an absolute trusted path.");
  const maxOutputChars = input.maxOutputChars ?? DEFAULT_MAX_OUTPUT_CHARS;
  if (!Number.isInteger(maxOutputChars) || maxOutputChars < 1 || maxOutputChars > DEFAULT_MAX_OUTPUT_CHARS) {
    throw new Error(`Git maxOutputChars must be an integer between 1 and ${DEFAULT_MAX_OUTPUT_CHARS}.`);
  }
  if (input.input !== undefined && input.input.length > 1_000_000) {
    throw new Error("Git stdin exceeds the 1,000,000-character safety limit.");
  }
  const timeoutMs = input.timeoutMs ?? 60_000;
  if (!Number.isInteger(timeoutMs) || timeoutMs < 1 || timeoutMs > 300_000) {
    throw new Error("Git timeoutMs must be an integer between 1 and 300000.");
  }
  return {
    executable: input.executable,
    args: [...input.args],
    cwd: path.resolve(input.cwd),
    display: ["git", ...input.args].map(quoteDisplayArgument).join(" "),
    purpose: input.purpose,
    maxOutputChars,
    timeoutMs,
    input: input.input,
    environment: sanitizeGitEnvironment(input.environment),
  };
}

export async function executeGitCommand(
  processes: ToolProcessRunner,
  spec: GitCommandSpec,
): Promise<GitCommandExecutionResult> {
  const result = await processes.run({
    command: spec.executable,
    args: spec.args,
    cwd: spec.cwd,
    timeoutMs: spec.timeoutMs,
    maxOutputChars: spec.maxOutputChars,
    input: spec.input,
    environment: spec.environment,
  });
  const success = !result.spawnError && !result.timedOut && result.exitCode === 0;
  return {
    ...result,
    stdout: success ? result.stdout : redactGitText(result.stdout),
    stderr: success ? result.stderr : redactGitText(result.stderr),
    success,
    display: spec.display,
    purpose: spec.purpose,
  };
}

export function literalGitPathspec(value: string): string {
  return `:(literal)${normalizeGitPath(value)}`;
}

export function normalizeGitPath(value: string, options: { allowDot?: boolean } = {}): string {
  assertBoundedText(value, "Git path", 8_192);
  const normalized = value.replace(/\\/gu, "/").replace(/^\.\//u, "").replace(/\/{2,}/gu, "/");
  if (path.posix.isAbsolute(normalized) || /^[A-Za-z]:\//u.test(normalized)) {
    throw new Error(`Git path must be relative: ${value}.`);
  }
  const segments = normalized.split("/");
  if (segments.some((segment) => !segment || segment === "..")) {
    throw new Error(`Git path escapes or ambiguously addresses the repository: ${value}.`);
  }
  if ((!options.allowDot && normalized === ".") || normalized.startsWith("-")) {
    throw new Error(`Git path is not an explicit safe path: ${value}.`);
  }
  return normalized;
}

export function validateGitRevision(value: string): string {
  assertBoundedText(value, "Git revision", 512);
  if (value.startsWith("-") || /[\s:\\]/u.test(value) || !/^[A-Za-z0-9_./@{}^~+\-]+$/u.test(value)) {
    throw new Error(`Invalid or unsupported Git revision: ${value}.`);
  }
  return value;
}

export function validateGitBranchName(value: string): string {
  assertBoundedText(value, "Git branch name", 255);
  if (
    value.startsWith("-") || value.startsWith("/") || value.endsWith("/") || value.endsWith(".") ||
    value.includes("..") || value.includes("@{") || value.includes("//") ||
    /[\s~^:?*\[\\]/u.test(value) || /(?:^|\/)\./u.test(value) || /\.lock(?:\/|$)/u.test(value)
  ) {
    throw new Error(`Invalid Git branch name: ${value}.`);
  }
  return value;
}
