import { promises as fs } from "node:fs";
import path from "node:path";

import { MANDATORY_DENIED_PATH_PREFIXES } from "../../safety/src/index.js";

export interface FileListResult {
  files: string[];
  truncated: boolean;
  candidateCount?: number;
  totalPathChars?: number;
  truncationReason?: "max_results" | "max_path_chars" | "max_total_path_chars" | "rg_output";
  warnings?: string[];
}

export interface RepositoryGlobOptions {
  workspaceRoot: string;
  cwd: string;
  globs: string[];
  exclude?: string[];
  maxDepth: number;
  maxResults: number;
  maxPathChars?: number;
  maxTotalPathChars?: number;
}

export interface SearchMatch {
  path: string;
  lineNumber: number;
  lineText: string;
  matchText?: string;
}

export interface FileSearchResult {
  matches: SearchMatch[];
  truncated: boolean;
  skippedBinaryFiles: number;
  skippedLargeFiles: number;
}

interface BaseExplorerOptions {
  workspaceRoot: string;
  cwd: string;
  glob?: string;
  exclude?: string[];
}

interface ListOptions extends BaseExplorerOptions {
  maxDepth: number;
  maxResults: number;
}

interface SearchOptions extends BaseExplorerOptions {
  pattern: string;
  maxResults: number;
  maxFileBytes: number;
}

export const DEFAULT_IGNORED_PREFIXES = [
  "node_modules",
  ...MANDATORY_DENIED_PATH_PREFIXES,
];

/**
 * Plain workspace paths under these prefixes are never readable by built-in
 * file tools. Trusted artifact:// references are resolved separately by the
 * runtime and do not pass through this workspace-path policy.
 */
export const PROTECTED_READ_PREFIXES = [...MANDATORY_DENIED_PATH_PREFIXES];

const MAX_IGNORE_FILE_BYTES = 256 * 1024;
export const DEFAULT_MAX_REPOSITORY_PATH_CHARS = 2_000;
export const DEFAULT_MAX_REPOSITORY_TOTAL_PATH_CHARS = 2_000_000;

interface RepositoryIgnoreRule {
  basePath: string;
  pattern: string;
  negated: boolean;
  directoryOnly: boolean;
  anchored: boolean;
  containsSlash: boolean;
}

export function normalizeRepositoryPath(value: string): string {
  return value.replace(/\\/g, "/");
}

function comparePaths(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0;
}

function escapeRegex(value: string): string {
  return value.replace(/[|\\{}()[\]^$+?.]/g, "\\$&");
}

function globToRegExp(pattern: string): RegExp {
  const normalized = normalizeRepositoryPath(pattern);
  let source = "^";
  for (let index = 0; index < normalized.length; index += 1) {
    const current = normalized[index];
    const next = normalized[index + 1];
    if (current === "*" && next === "*") {
      source += ".*";
      index += 1;
      continue;
    }
    if (current === "*") {
      source += "[^/]*";
      continue;
    }
    if (current === "?") {
      source += "[^/]";
      continue;
    }
    source += escapeRegex(current);
  }
  source += "$";
  return new RegExp(source);
}

function repositoryGlobToRegExp(pattern: string): RegExp {
  const normalized = normalizeRepositoryPath(pattern).replace(/^\.\//, "");
  let source = "^";
  for (let index = 0; index < normalized.length; index += 1) {
    const current = normalized[index];
    const next = normalized[index + 1];
    if (current === "*" && next === "*") {
      if (normalized[index + 2] === "/") {
        source += "(?:.*/)?";
        index += 2;
        continue;
      }
      source += ".*";
      index += 1;
      continue;
    }
    if (current === "*") {
      source += "[^/]*";
      continue;
    }
    if (current === "?") {
      source += "[^/]";
      continue;
    }
    if (current === "[") {
      const closingIndex = normalized.indexOf("]", index + 1);
      if (closingIndex > index + 1) {
        let characterClass = normalized.slice(index + 1, closingIndex).replace(/\\/g, "\\\\");
        if (characterClass.startsWith("!")) characterClass = `^${characterClass.slice(1)}`;
        else if (characterClass.startsWith("^")) characterClass = `\\${characterClass}`;
        source += `[${characterClass}]`;
        index = closingIndex;
        continue;
      }
    }
    source += escapeRegex(current);
  }
  source += "$";
  return new RegExp(source, process.platform === "win32" ? "i" : undefined);
}

export function matchesAnyGlob(targetPath: string, patterns: string[]): boolean {
  const normalized = normalizeRepositoryPath(targetPath).replace(/^\.\//, "");
  return patterns.some((pattern) => globToRegExp(pattern).test(normalized));
}

export function matchesRepositoryFileGlob(targetPath: string, patterns: string[]): boolean {
  const normalized = normalizeRepositoryPath(targetPath).replace(/^\.\//, "");
  return patterns.some((pattern) => {
    const normalizedPattern = normalizeRepositoryPath(pattern).replace(/^\.\//, "");
    return repositoryGlobToRegExp(normalizedPattern).test(
      normalizedPattern.includes("/") ? normalized : path.posix.basename(normalized),
    );
  });
}

export function matchesRepositoryExclude(targetPath: string, patterns: string[]): boolean {
  const normalized = normalizeRepositoryPath(targetPath).replace(/^\.\//, "");
  return patterns.some((pattern) => {
    const normalizedPattern = normalizeRepositoryPath(pattern).replace(/^\.\//, "");
    const matcher = repositoryGlobToRegExp(normalizedPattern);
    if (normalizedPattern.includes("/")) return matcher.test(normalized);
    return normalized.split("/").some((segment) => matcher.test(segment));
  });
}

export function isIgnoredPath(relativeWorkspacePath: string): boolean {
  const normalized = normalizeRepositoryPath(relativeWorkspacePath).replace(/^\.\//, "");
  const candidate = process.platform === "win32" ? normalized.toLocaleLowerCase("en-US") : normalized;
  return DEFAULT_IGNORED_PREFIXES.some((prefix) => {
    const comparedPrefix = process.platform === "win32" ? prefix.toLocaleLowerCase("en-US") : prefix;
    return candidate === comparedPrefix || candidate.startsWith(`${comparedPrefix}/`);
  });
}

function isRepositoryEnhancementIgnoredPath(relativeWorkspacePath: string): boolean {
  const normalized = normalizeRepositoryPath(relativeWorkspacePath).replace(/^\.\//, "");
  const candidate = process.platform === "win32" ? normalized.toLocaleLowerCase("en-US") : normalized;
  return DEFAULT_IGNORED_PREFIXES.some((prefix) => {
    const comparedPrefix = process.platform === "win32" ? prefix.toLocaleLowerCase("en-US") : prefix;
    return candidate === comparedPrefix ||
      candidate.startsWith(`${comparedPrefix}/`) ||
      candidate.endsWith(`/${comparedPrefix}`) ||
      candidate.includes(`/${comparedPrefix}/`);
  });
}

export function isProtectedReadPath(relativeWorkspacePath: string): boolean {
  const normalized = normalizeRepositoryPath(relativeWorkspacePath).replace(/^\.\//, "");
  const caseInsensitivePlatform = process.platform === "win32" || process.platform === "darwin";
  const candidate = caseInsensitivePlatform ? normalized.toLocaleLowerCase("en-US") : normalized;
  return PROTECTED_READ_PREFIXES.some((prefix) => {
    const comparedPrefix = caseInsensitivePlatform ? prefix.toLocaleLowerCase("en-US") : prefix;
    return candidate === comparedPrefix ||
      candidate.startsWith(`${comparedPrefix}/`) ||
      candidate.endsWith(`/${comparedPrefix}`) ||
      candidate.includes(`/${comparedPrefix}/`);
  });
}

function parseIgnoreFile(content: string, basePath: string): RepositoryIgnoreRule[] {
  const rules: RepositoryIgnoreRule[] = [];
  for (const rawLine of content.split(/\r?\n/)) {
    let line = rawLine.trim();
    if (!line || line.startsWith("#")) continue;
    const escapedControlPrefix = line.startsWith("\\#") || line.startsWith("\\!");
    if (escapedControlPrefix) line = line.slice(1);
    const negated = !escapedControlPrefix && line.startsWith("!");
    if (negated) line = line.slice(1);
    if (!line) continue;
    const directoryOnly = line.endsWith("/");
    if (directoryOnly) line = line.slice(0, -1);
    const anchored = line.startsWith("/");
    if (anchored) line = line.slice(1);
    const pattern = normalizeRepositoryPath(line);
    if (!pattern) continue;
    rules.push({
      basePath,
      pattern,
      negated,
      directoryOnly,
      anchored,
      containsSlash: pattern.includes("/"),
    });
  }
  return rules;
}

function pathWithinBase(workspaceRelativePath: string, basePath: string): string | undefined {
  if (!basePath || basePath === ".") return workspaceRelativePath;
  if (workspaceRelativePath === basePath) return ".";
  if (!workspaceRelativePath.startsWith(`${basePath}/`)) return undefined;
  return workspaceRelativePath.slice(basePath.length + 1);
}

function ignoreRuleMatches(
  workspaceRelativePath: string,
  isDirectory: boolean,
  rule: RepositoryIgnoreRule,
): boolean {
  const relativePath = pathWithinBase(workspaceRelativePath, rule.basePath);
  if (!relativePath || relativePath === ".") return false;
  const segments = relativePath.split("/");
  const maximumSegments = rule.directoryOnly && !isDirectory
    ? Math.max(0, segments.length - 1)
    : segments.length;
  for (let length = maximumSegments; length >= 1; length -= 1) {
    const candidate = segments.slice(0, length).join("/");
    if (rule.anchored || rule.containsSlash) {
      if (repositoryGlobToRegExp(rule.pattern).test(candidate)) return true;
      continue;
    }
    const matcher = repositoryGlobToRegExp(rule.pattern);
    if (candidate.split("/").some((segment) => matcher.test(segment))) {
      return true;
    }
  }
  return false;
}

async function readIgnoreRules(
  filePath: string,
  basePath: string,
  workspaceRoot: string,
): Promise<RepositoryIgnoreRule[]> {
  try {
    const linkStat = await fs.lstat(filePath);
    if (!linkStat.isFile() || linkStat.isSymbolicLink()) {
      throw new Error("Repository ignore metadata is outside the readable sandbox because it is not a safe regular file.");
    }
    if (linkStat.size > MAX_IGNORE_FILE_BYTES) {
      throw new Error("Repository ignore metadata is outside the readable sandbox because it exceeds the safe size limit.");
    }
    const [realRoot, realFile] = await Promise.all([fs.realpath(workspaceRoot), fs.realpath(filePath)]);
    const relative = path.relative(realRoot, realFile);
    if (relative.startsWith("..") || path.isAbsolute(relative)) {
      throw new Error("Repository ignore metadata is outside the readable sandbox because it escapes the workspace boundary.");
    }
    const handle = await fs.open(realFile, "r");
    try {
      const stat = await handle.stat();
      if (!stat.isFile() || stat.size > MAX_IGNORE_FILE_BYTES) {
        throw new Error("Repository ignore metadata is outside the readable sandbox because it is not a bounded regular file.");
      }
      const buffer = Buffer.alloc(stat.size);
      const { bytesRead } = await handle.read(buffer, 0, buffer.length, 0);
      let content: string;
      try {
        content = new TextDecoder("utf-8", { fatal: true }).decode(buffer.subarray(0, bytesRead));
      } catch {
        throw new Error("Repository ignore metadata is outside the readable sandbox because it is not valid UTF-8.");
      }
      return parseIgnoreFile(content, basePath);
    } finally {
      await handle.close();
    }
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return [];
    const relativePath = normalizeRepositoryPath(path.relative(workspaceRoot, filePath));
    throw new Error(
      `Repository ignore metadata is outside the readable sandbox and cannot be used safely: ${relativePath || ".gitignore"}.`,
    );
  }
}

/**
 * Bounded, cached resolver for repository-local ignore rules. It covers the
 * root/nested .gitignore files and .git/info/exclude without consulting global
 * machine configuration, keeping fallback behaviour reproducible.
 */
export class RepositoryIgnoreResolver {
  private readonly rulesByDirectory = new Map<string, Promise<RepositoryIgnoreRule[]>>();

  private readonly repositoryRules: Promise<RepositoryIgnoreRule[]>;

  public constructor(private readonly workspaceRoot: string) {
    this.repositoryRules = readIgnoreRules(
      path.join(workspaceRoot, ".git", "info", "exclude"),
      ".",
      workspaceRoot,
    );
  }

  private rulesForDirectory(relativeDirectory: string): Promise<RepositoryIgnoreRule[]> {
    const normalized = normalizeRepositoryPath(relativeDirectory) || ".";
    const existing = this.rulesByDirectory.get(normalized);
    if (existing) return existing;
    const loaded = readIgnoreRules(
      path.join(this.workspaceRoot, normalized === "." ? "" : normalized, ".gitignore"),
      normalized,
      this.workspaceRoot,
    );
    this.rulesByDirectory.set(normalized, loaded);
    return loaded;
  }

  public async isIgnored(relativeWorkspacePath: string, isDirectory = false): Promise<boolean> {
    const normalized = normalizeRepositoryPath(relativeWorkspacePath).replace(/^\.\//, "");
    if (isRepositoryEnhancementIgnoredPath(normalized)) return true;

    const parent = normalizeRepositoryPath(path.posix.dirname(normalized));
    const directoryParts = parent === "." ? [] : parent.split("/");
    const directories = ["."];
    for (let index = 0; index < directoryParts.length; index += 1) {
      directories.push(directoryParts.slice(0, index + 1).join("/"));
    }
    const rules = [
      ...await this.repositoryRules,
      ...(await Promise.all(directories.map((directory) => this.rulesForDirectory(directory)))).flat(),
    ];
    let ignored = false;
    for (const rule of rules) {
      if (ignoreRuleMatches(normalized, isDirectory, rule)) ignored = !rule.negated;
    }
    if (!ignored && parent !== "." && parent !== normalized) {
      // Git cannot re-include an entry while one of its parent directories is
      // still ignored. Preserve that fail-closed rule in the Node fallback.
      return this.isIgnored(parent, true);
    }
    return ignored;
  }

  public listWarnings(): string[] {
    return [];
  }
}

function relativeFrom(basePath: string, targetPath: string): string {
  return normalizeRepositoryPath(path.relative(basePath, targetPath)) || ".";
}

export async function isProbablyTextFile(filePath: string): Promise<boolean> {
  const handle = await fs.open(filePath, "r");
  try {
    const buffer = Buffer.alloc(4096);
    const { bytesRead } = await handle.read(buffer, 0, buffer.length, 0);
    for (let index = 0; index < bytesRead; index += 1) {
      if (buffer[index] === 0) {
        return false;
      }
    }
    return true;
  } finally {
    await handle.close();
  }
}

function buildMatchOutput(matches: SearchMatch[]): string {
  if (matches.length === 0) {
    return "No matches found.";
  }
  return matches.map((entry) => `${entry.path}:${entry.lineNumber}:${entry.lineText}`).join("\n");
}

export function formatSearchMatches(
  matches: SearchMatch[],
  options?: {
    cwd: string;
    glob?: string;
    maxResults: number;
    maxFileBytes: number;
    truncated: boolean;
    skippedBinaryFiles?: number;
    skippedLargeFiles?: number;
  },
): string {
  if (!options) {
    return buildMatchOutput(matches);
  }
  const status = options.truncated
    ? `[search_files truncated: returned ${matches.length} content match(es) at maxResults=${options.maxResults}; additional content matches may exist.]`
    : `[search_files complete within configured content-search limits: returned ${matches.length} content match(es).]`;
  const semantics = "[search_files semantics: this tool searches text inside files, not file names. Zero content matches do not prove that a file path is absent; use list_files, glob_files, or file_metadata for path existence.]";
  const scope = `[search_files scope: cwd=${options.cwd}; glob=${options.glob ?? "all"}; maxFileBytes=${options.maxFileBytes}; files beyond size, binary, ignore, or permission limits are outside this result.]`;
  const skipped = (options.skippedBinaryFiles ?? 0) > 0 || (options.skippedLargeFiles ?? 0) > 0
    ? `[search_files skipped: binary=${options.skippedBinaryFiles ?? 0}; oversized=${options.skippedLargeFiles ?? 0}.]`
    : undefined;
  return [status, semantics, scope, skipped, buildMatchOutput(matches)]
    .filter((value): value is string => typeof value === "string")
    .join("\n");
}

export async function listFilesWithNodeFs(options: ListOptions): Promise<FileListResult> {
  const exclude = options.exclude ?? [];
  const files: string[] = [];
  let truncated = false;

  const visit = async (currentDir: string, depth: number): Promise<void> => {
    if (truncated || depth > options.maxDepth) {
      return;
    }

    const entries = await fs.readdir(currentDir, { withFileTypes: true });
    entries.sort((left, right) => left.name.localeCompare(right.name));

    for (const entry of entries) {
      if (truncated) {
        return;
      }
      const absolutePath = path.join(currentDir, entry.name);
      const relativeWorkspacePath = relativeFrom(options.workspaceRoot, absolutePath);
      const relativeCwdPath = relativeFrom(options.cwd, absolutePath);
      if (isIgnoredPath(relativeWorkspacePath)) {
        continue;
      }
      if (exclude.length > 0 && matchesRepositoryExclude(relativeCwdPath, exclude)) {
        continue;
      }
      if (entry.isSymbolicLink()) {
        continue;
      }
      if (entry.isDirectory()) {
        await visit(absolutePath, depth + 1);
        continue;
      }
      if (options.glob && !matchesRepositoryFileGlob(relativeCwdPath, [options.glob])) {
        continue;
      }
      files.push(relativeCwdPath);
      if (files.length > options.maxResults) {
        files.length = options.maxResults;
        truncated = true;
        return;
      }
    }
  };

  await visit(options.cwd, 0);
  return {
    files,
    truncated,
  };
}

export async function searchFilesWithNodeFs(options: SearchOptions): Promise<FileSearchResult> {
  const exclude = options.exclude ?? [];
  const matcher = new RegExp(options.pattern);
  const matches: SearchMatch[] = [];
  let truncated = false;
  let skippedBinaryFiles = 0;
  let skippedLargeFiles = 0;

  const visit = async (currentDir: string): Promise<void> => {
    if (truncated) {
      return;
    }

    const entries = await fs.readdir(currentDir, { withFileTypes: true });
    entries.sort((left, right) => left.name.localeCompare(right.name));

    for (const entry of entries) {
      if (truncated) {
        return;
      }
      const absolutePath = path.join(currentDir, entry.name);
      const relativeWorkspacePath = relativeFrom(options.workspaceRoot, absolutePath);
      const relativeCwdPath = relativeFrom(options.cwd, absolutePath);
      if (isIgnoredPath(relativeWorkspacePath)) {
        continue;
      }
      if (exclude.length > 0 && matchesRepositoryExclude(relativeCwdPath, exclude)) {
        continue;
      }
      if (entry.isSymbolicLink()) {
        continue;
      }
      if (entry.isDirectory()) {
        await visit(absolutePath);
        continue;
      }
      if (options.glob && !matchesRepositoryFileGlob(relativeCwdPath, [options.glob])) {
        continue;
      }

      const stat = await fs.stat(absolutePath);
      if (stat.size > options.maxFileBytes) {
        skippedLargeFiles += 1;
        continue;
      }
      if (!(await isProbablyTextFile(absolutePath))) {
        skippedBinaryFiles += 1;
        continue;
      }

      const content = await fs.readFile(absolutePath, "utf8");
      const lines = content.split(/\r?\n/);
      for (let index = 0; index < lines.length; index += 1) {
        matcher.lastIndex = 0;
        const lineText = lines[index] ?? "";
        const matched = matcher.exec(lineText);
        if (!matched) {
          continue;
        }
        matches.push({
          path: relativeCwdPath,
          lineNumber: index + 1,
          lineText,
          matchText: matched[0],
        });
        if (matches.length > options.maxResults) {
          matches.length = options.maxResults;
          truncated = true;
          return;
        }
      }
    }
  };

  await visit(options.cwd);
  return {
    matches,
    truncated,
    skippedBinaryFiles,
    skippedLargeFiles,
  };
}

/** Node-only implementation used by glob_files when rg is unavailable. */
export async function globFilesWithNodeFs(options: RepositoryGlobOptions): Promise<FileListResult> {
  const ignoreResolver = new RepositoryIgnoreResolver(options.workspaceRoot);
  const exclude = options.exclude ?? [];
  const files: string[] = [];
  let truncated = false;
  let candidateCount = 0;
  let totalPathChars = 0;
  let truncationReason: FileListResult["truncationReason"];
  const maxPathChars = options.maxPathChars ?? DEFAULT_MAX_REPOSITORY_PATH_CHARS;
  const maxTotalPathChars = options.maxTotalPathChars ?? DEFAULT_MAX_REPOSITORY_TOTAL_PATH_CHARS;

  const visit = async (currentDir: string, depth: number): Promise<void> => {
    if (truncated || depth > options.maxDepth) return;
    const entries = await fs.readdir(currentDir, { withFileTypes: true });
    entries.sort((left, right) => comparePaths(left.name, right.name));
    for (const entry of entries) {
      if (truncated) return;
      const absolutePath = path.join(currentDir, entry.name);
      const relativeWorkspacePath = relativeFrom(options.workspaceRoot, absolutePath);
      const relativeCwdPath = relativeFrom(options.cwd, absolutePath);
      if (entry.isSymbolicLink()) continue;
      if (await ignoreResolver.isIgnored(relativeWorkspacePath, entry.isDirectory())) continue;
      if (exclude.length > 0 && matchesRepositoryExclude(relativeCwdPath, exclude)) continue;
      if (entry.isDirectory()) {
        await visit(absolutePath, depth + 1);
        continue;
      }
      if (!entry.isFile() || !matchesRepositoryFileGlob(relativeCwdPath, options.globs)) continue;
      candidateCount += 1;
      if (relativeWorkspacePath.length > maxPathChars) {
        truncated = true;
        truncationReason = "max_path_chars";
        return;
      }
      if (totalPathChars + relativeWorkspacePath.length > maxTotalPathChars) {
        truncated = true;
        truncationReason = "max_total_path_chars";
        return;
      }
      files.push(relativeWorkspacePath);
      totalPathChars += relativeWorkspacePath.length;
      if (files.length > options.maxResults) {
        truncated = true;
        truncationReason = "max_results";
        files.length = options.maxResults;
        return;
      }
    }
  };

  await visit(options.cwd, 0);
  files.sort(comparePaths);
  return {
    files,
    truncated,
    candidateCount,
    totalPathChars,
    truncationReason,
    warnings: ignoreResolver.listWarnings(),
  };
}
