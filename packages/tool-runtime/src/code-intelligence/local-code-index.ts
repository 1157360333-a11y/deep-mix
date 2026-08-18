import { createHash } from "node:crypto";
import { promises as fs } from "node:fs";
import type { Dirent, Stats } from "node:fs";
import path from "node:path";

import type { CodeRange } from "../../../shared-schema/src/index.js";
import { resolveWorkspaceStateDirectory } from "../../../state-location/src/index.js";
import { publishTextFileAtomic } from "../atomic-file.js";
import {
  isProbablyTextFile,
  isProtectedReadPath,
  normalizeRepositoryPath,
  RepositoryIgnoreResolver,
} from "../repository-explorer.js";
import {
  CODE_INDEX_SCHEMA_VERSION,
  DEFAULT_CODE_INDEX_LIMITS,
  type CodeIndexBuildStats,
  type CodeIndexFileLookup,
  type CodeIndexFileLookupOptions,
  type CodeIndexLimits,
  type CodeIndexRefreshOptions,
  type CodeIndexSkipCounts,
  type CodeIndexSkipReason,
  type IndexedFileRecord,
  type LocalCodeIndexOptions,
  type LocalCodeIndexSnapshot,
  type PersistedCodeIndexState,
  type RepositoryFingerprintProvider,
} from "./contracts.js";
import {
  createDefaultLanguageAdapterRegistry,
  LanguageAdapterRegistry,
} from "./language-adapters.js";

const STATE_FILE = "index-v1.json";
const PROVISIONAL_INDEX_VERSION = `code-index-v1.pending.${"0".repeat(48)}`;
const UNAVAILABLE_REPOSITORY_FINGERPRINT = "repository-fingerprint-unavailable";
const MAX_GIT_TEXT_METADATA_BYTES = 4 * 1024 * 1024;
const MAX_GIT_INDEX_BYTES = 64 * 1024 * 1024;
const INDEX_METADATA_RESERVE_BYTES = 16_384;

const HARD_EXCLUDED_DIRECTORY_SEGMENTS = new Set([
  ".deep-mix",
  ".git",
  ".cache",
  ".next",
  "node_modules",
  "vendor",
  "vendors",
  "generated",
  "__generated__",
  "gen",
  "dist",
  "build",
  "out",
  "coverage",
  "target",
  "tmp",
  "temp",
]);

const GENERATED_FILE_PATTERNS = [
  /(?:^|\.)min\.(?:css|js|mjs|cjs)$/iu,
  /\.map$/iu,
];

interface CandidateFile {
  relativePath: string;
  absolutePath: string;
  sizeBytes: number;
  mtimeMs: number;
}

interface MutableBuildStats {
  mode: "full" | "incremental";
  startedAt: string;
  startedMs: number;
  filesScanned: number;
  skipped: CodeIndexSkipCounts;
  truncated: boolean;
}

function sha256(value: string | Uint8Array): string {
  return createHash("sha256").update(value).digest("hex");
}

function comparePaths(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0;
}

function canonicalWorkspacePath(value: string): string {
  const normalized = normalizeRepositoryPath(value).replace(/\/+$/u, "");
  return process.platform === "win32" || process.platform === "darwin"
    ? normalized.toLocaleLowerCase("en-US")
    : normalized;
}

function createSkipCounts(): CodeIndexSkipCounts {
  return {
    ignored: 0,
    protected: 0,
    symlink: 0,
    binary: 0,
    invalid_utf8: 0,
    oversized: 0,
    file_capacity: 0,
    source_capacity: 0,
    index_capacity: 0,
    not_regular_file: 0,
    read_error: 0,
  };
}

function incrementSkip(stats: MutableBuildStats, reason: CodeIndexSkipReason): void {
  stats.skipped[reason] += 1;
  if (["oversized", "file_capacity", "source_capacity", "index_capacity", "read_error"].includes(reason)) {
    stats.truncated = true;
  }
}

function throwIfAborted(signal: AbortSignal | undefined): void {
  if (!signal?.aborted) return;
  if (signal.reason instanceof Error) throw signal.reason;
  throw new Error(typeof signal.reason === "string" ? signal.reason : "Code indexing was aborted.");
}

function throwIfInterrupted(signal: AbortSignal | undefined, deadlineAt: number): void {
  throwIfAborted(signal);
  if (Date.now() > deadlineAt) throw new Error("Code index build duration limit exceeded.");
}

interface GitMetadataDigest {
  descriptor: string;
  content?: Buffer;
}

async function readGitMetadataDigest(
  gitDirectory: string,
  relativePath: string,
  maxBytes: number,
  signal: AbortSignal | undefined,
): Promise<GitMetadataDigest> {
  throwIfAborted(signal);
  const normalized = normalizeRepositoryPath(relativePath).replace(/^\.\//u, "");
  const absolutePath = path.resolve(gitDirectory, ...normalized.split("/"));
  const relative = path.relative(gitDirectory, absolutePath);
  if (!normalized || relative.startsWith("..") || path.isAbsolute(relative)) {
    return { descriptor: `${normalized || "[empty]"}:invalid_path` };
  }
  const stat = await fs.lstat(absolutePath).catch((error: NodeJS.ErrnoException) => {
    if (error.code === "ENOENT") return undefined;
    throw error;
  });
  throwIfAborted(signal);
  if (!stat) return { descriptor: `${normalized}:missing` };
  if (!stat.isFile() || stat.isSymbolicLink()) {
    return { descriptor: `${normalized}:unsupported_type` };
  }
  if (stat.size > maxBytes) {
    return {
      descriptor: `${normalized}:oversized:${stat.size}:${Math.trunc(stat.mtimeMs)}:${Math.trunc(stat.ctimeMs)}`,
    };
  }
  const content = await fs.readFile(absolutePath, { signal });
  throwIfAborted(signal);
  return {
    descriptor: `${normalized}:${content.length}:${sha256(content)}`,
    content,
  };
}

async function defaultGitRepositoryFingerprint(
  workspaceRoot: string,
  signal: AbortSignal | undefined,
): Promise<string> {
  throwIfAborted(signal);
  const gitDirectory = path.join(workspaceRoot, ".git");
  const gitStat = await fs.lstat(gitDirectory).catch((error: NodeJS.ErrnoException) => {
    if (error.code === "ENOENT") return undefined;
    throw error;
  });
  if (!gitStat) return sha256("git-metadata:none");
  // Worktree/submodule gitdir indirection may escape the workspace. Do not follow it implicitly.
  if (!gitStat.isDirectory() || gitStat.isSymbolicLink()) {
    return sha256("git-metadata:unsupported-or-indirect");
  }

  const parts: string[] = [];
  const head = await readGitMetadataDigest(gitDirectory, "HEAD", MAX_GIT_TEXT_METADATA_BYTES, signal);
  parts.push(head.descriptor);
  if (head.content) {
    const headText = new TextDecoder("utf-8", { fatal: false }).decode(head.content).trim();
    const refMatch = /^ref:\s+(refs\/[A-Za-z0-9._/-]+)$/u.exec(headText);
    const refPath = refMatch?.[1];
    if (refPath && !refPath.split("/").some((segment) => segment === ".." || segment.length === 0)) {
      parts.push((await readGitMetadataDigest(
        gitDirectory,
        refPath,
        MAX_GIT_TEXT_METADATA_BYTES,
        signal,
      )).descriptor);
    } else if (headText.startsWith("ref:")) {
      parts.push("HEAD-ref:invalid");
    }
  }
  parts.push((await readGitMetadataDigest(
    gitDirectory,
    "packed-refs",
    MAX_GIT_TEXT_METADATA_BYTES,
    signal,
  )).descriptor);
  parts.push((await readGitMetadataDigest(
    gitDirectory,
    "index",
    MAX_GIT_INDEX_BYTES,
    signal,
  )).descriptor);
  parts.push((await readGitMetadataDigest(
    gitDirectory,
    "index.lock",
    MAX_GIT_TEXT_METADATA_BYTES,
    signal,
  )).descriptor);
  return sha256(parts.join("\0"));
}

function mergeLimits(overrides: Partial<CodeIndexLimits> | undefined): Readonly<CodeIndexLimits> {
  const limits: CodeIndexLimits = { ...DEFAULT_CODE_INDEX_LIMITS, ...overrides };
  for (const [name, value] of Object.entries(limits)) {
    if (!Number.isSafeInteger(value) || value <= 0) {
      throw new Error(`Code index limit ${name} must be a positive safe integer.`);
    }
  }
  return Object.freeze(limits);
}

function normalizeRelativePath(workspaceRoot: string, requestedPath: string): string {
  if (!requestedPath || requestedPath.includes("\0")) throw new Error("Code index path must be non-empty and contain no NUL bytes.");
  const absolutePath = path.isAbsolute(requestedPath)
    ? path.resolve(requestedPath)
    : path.resolve(workspaceRoot, requestedPath);
  const relativePath = path.relative(workspaceRoot, absolutePath);
  if (relativePath.startsWith("..") || path.isAbsolute(relativePath)) {
    throw new Error("Code index path escapes the workspace root.");
  }
  return normalizeRepositoryPath(relativePath).replace(/^\.\//u, "") || ".";
}

function isWithinScope(relativePath: string, scope: string): boolean {
  return scope === "." || relativePath === scope || relativePath.startsWith(`${scope}/`);
}

function isHardExcluded(relativePath: string, isDirectory: boolean): boolean {
  const normalized = normalizeRepositoryPath(relativePath).replace(/^\.\//u, "");
  const segments = normalized.split("/").filter(Boolean).map((segment) => segment.toLocaleLowerCase("en-US"));
  if (segments.some((segment) => HARD_EXCLUDED_DIRECTORY_SEGMENTS.has(segment))) return true;
  if (!isDirectory) {
    const basename = path.posix.basename(normalized);
    if (GENERATED_FILE_PATTERNS.some((pattern) => pattern.test(basename))) return true;
  }
  return false;
}

function cloneRecord(record: IndexedFileRecord): IndexedFileRecord {
  return structuredClone(record);
}

function markRecordSymbolsStale(record: IndexedFileRecord): IndexedFileRecord {
  const cloned = cloneRecord(record);
  return {
    ...cloned,
    symbols: cloned.symbols.map((symbol) => {
      if (symbol.source === "lsp" && symbol.precision === "exact") {
        return { ...symbol, precision: "approximate" as const, stale: true as const };
      }
      return { ...symbol, stale: true as const };
    }),
  };
}

function serializedRecordBytes(record: IndexedFileRecord): number {
  return Buffer.byteLength(JSON.stringify(record), "utf8");
}

function minimumRecordBytes(candidate: CandidateFile): number {
  return Buffer.byteLength(JSON.stringify({
    schemaVersion: CODE_INDEX_SCHEMA_VERSION,
    path: candidate.relativePath,
    adapterId: "",
    language: "",
    contentHash: "0".repeat(64),
    sizeBytes: candidate.sizeBytes,
    mtimeMs: candidate.mtimeMs,
    indexedAt: new Date(0).toISOString(),
    symbols: [],
    snippets: [],
    tokens: [],
    occurrences: [],
    truncated: { symbols: false, snippets: false, tokens: false, occurrences: false },
  }), "utf8");
}

function sortedRecords(records: Map<string, IndexedFileRecord>): IndexedFileRecord[] {
  return [...records.values()].sort((left, right) => comparePaths(left.path, right.path));
}

function fileFingerprint(records: Map<string, IndexedFileRecord>): string {
  const state = sortedRecords(records)
    .map((record) =>
      `${record.path}\0${record.contentHash}\0${record.sizeBytes}\0${record.mtimeMs}\0${record.adapterId}`
    )
    .join("\n");
  return sha256(state);
}

function versionFor(
  workspaceId: string,
  repositoryFingerprint: string,
  filesFingerprint: string,
  generation: number,
): string {
  const digest = sha256(`${workspaceId}\0${repositoryFingerprint}\0${filesFingerprint}\0${generation}`).slice(0, 32);
  return `code-index-v1.${generation}.${digest}`;
}

function stampRecordVersion(record: IndexedFileRecord, indexVersion: string): IndexedFileRecord {
  return {
    ...record,
    symbols: record.symbols.map((symbol) => {
      if (symbol.source === "lsp" && symbol.precision === "approximate") {
        return { ...symbol, indexVersion };
      }
      return { ...symbol, indexVersion, stale: false };
    }),
  };
}

function isPersistedState(value: unknown): value is PersistedCodeIndexState {
  if (!value || typeof value !== "object") return false;
  const candidate = value as Partial<PersistedCodeIndexState>;
  return candidate.schemaVersion === CODE_INDEX_SCHEMA_VERSION &&
    typeof candidate.workspaceId === "string" &&
    Number.isSafeInteger(candidate.generation) &&
    typeof candidate.indexVersion === "string" &&
    typeof candidate.repositoryFingerprint === "string" &&
    typeof candidate.fileFingerprint === "string" &&
    typeof candidate.builtAt === "string" &&
    typeof candidate.stale === "boolean" &&
    typeof candidate.truncated === "boolean" &&
    Array.isArray(candidate.files);
}

function isIndexedFileRecord(value: unknown): value is IndexedFileRecord {
  if (!value || typeof value !== "object") return false;
  const candidate = value as Partial<IndexedFileRecord>;
  return candidate.schemaVersion === CODE_INDEX_SCHEMA_VERSION &&
    typeof candidate.path === "string" &&
    typeof candidate.adapterId === "string" &&
    typeof candidate.language === "string" &&
    typeof candidate.contentHash === "string" &&
    typeof candidate.sizeBytes === "number" &&
    typeof candidate.mtimeMs === "number" &&
    typeof candidate.indexedAt === "string" &&
    Array.isArray(candidate.symbols) &&
    Array.isArray(candidate.snippets) &&
    Array.isArray(candidate.tokens) &&
    Array.isArray(candidate.occurrences) &&
    !!candidate.truncated && typeof candidate.truncated === "object";
}

async function ensureRealPathContained(workspaceRoot: string, absolutePath: string): Promise<void> {
  const resolvedPath = path.resolve(absolutePath);
  const realPath = await fs.realpath(resolvedPath);
  const relative = path.relative(workspaceRoot, realPath);
  if (
    canonicalWorkspacePath(realPath) !== canonicalWorkspacePath(resolvedPath) ||
    relative.startsWith("..") ||
    path.isAbsolute(relative)
  ) {
    throw new Error("Code index candidate resolves outside the workspace root.");
  }
}

async function ensureStateDirectorySafe(stateDirectory: string, create: boolean): Promise<string> {
  const existing = await fs.lstat(stateDirectory).catch((error: NodeJS.ErrnoException) => {
    if (error.code === "ENOENT") return undefined;
    throw error;
  });
  if (!existing) {
    if (!create) return stateDirectory;
    await fs.mkdir(stateDirectory, { recursive: true, mode: 0o700 });
  }
  const confirmed = await fs.lstat(stateDirectory);
  if (!confirmed.isDirectory() || confirmed.isSymbolicLink()) {
    throw new Error("Code index state directory is not a trusted real directory.");
  }
  const realDirectory = await fs.realpath(stateDirectory);
  if (canonicalWorkspacePath(realDirectory) !== canonicalWorkspacePath(path.resolve(stateDirectory))) {
    throw new Error("Code index state directory resolves through an untrusted link or junction.");
  }
  return stateDirectory;
}

async function strictUtf8File(candidate: CandidateFile): Promise<{ content: string; hash: string; stat: Stats }> {
  if (!(await isProbablyTextFile(candidate.absolutePath))) throw Object.assign(new Error("binary"), { code: "EBINARY" });
  const buffer = await fs.readFile(candidate.absolutePath);
  let content: string;
  try {
    content = new TextDecoder("utf-8", { fatal: true }).decode(buffer);
  } catch {
    throw Object.assign(new Error("invalid_utf8"), { code: "EUTF8" });
  }
  const stat = await fs.lstat(candidate.absolutePath);
  if (!stat.isFile() || stat.isSymbolicLink()) throw Object.assign(new Error("not_regular_file"), { code: "ENOTREGULAR" });
  if (stat.size !== buffer.byteLength) throw Object.assign(new Error("changed_during_read"), { code: "ECHANGED" });
  return { content, hash: sha256(buffer), stat };
}

function rangeWithinUtf16Content(range: CodeRange, content: string): boolean {
  const { start, end } = range;
  if (
    !Number.isSafeInteger(start.line) || start.line < 1 ||
    !Number.isSafeInteger(start.column) || start.column < 1 ||
    !Number.isSafeInteger(end.line) || end.line < start.line ||
    !Number.isSafeInteger(end.column) || end.column < 1 ||
    (end.line === start.line && end.column < start.column)
  ) return false;
  const lines = content.split(/\r\n|\n|\r/u);
  if (start.line > lines.length || end.line > lines.length) return false;
  const startLimit = (lines[start.line - 1]?.length ?? -1) + 1;
  const endLimit = (lines[end.line - 1]?.length ?? -1) + 1;
  return start.column <= startLimit && end.column <= endLimit;
}

export class LocalCodeIndex {
  public readonly workspaceRoot: string;

  public readonly workspaceId: string;

  public readonly statePath: string;

  private readonly stateDirectory: string;

  public readonly limits: Readonly<CodeIndexLimits>;

  public readonly adapters: LanguageAdapterRegistry;

  private readonly defaultRepositoryFingerprint?: string | RepositoryFingerprintProvider;

  private readonly telemetry?: LocalCodeIndexOptions["telemetry"];

  private records = new Map<string, IndexedFileRecord>();

  private generation = 0;

  private indexVersion: string;

  private repositoryFingerprint = sha256(UNAVAILABLE_REPOSITORY_FINGERPRINT);

  private filesFingerprint = sha256("");

  private builtAt = new Date(0).toISOString();

  private stale = true;

  private truncated = false;

  private mutationQueue: Promise<void> = Promise.resolve();

  private constructor(workspaceRoot: string, workspaceId: string, options: LocalCodeIndexOptions) {
    this.workspaceRoot = workspaceRoot;
    this.workspaceId = workspaceId;
    this.stateDirectory = path.resolve(
      options.stateDirectory ?? path.join(resolveWorkspaceStateDirectory(workspaceRoot), "code-index"),
    );
    this.statePath = path.join(this.stateDirectory, STATE_FILE);
    this.limits = mergeLimits(options.limits);
    this.adapters = createDefaultLanguageAdapterRegistry(options.adapters);
    this.defaultRepositoryFingerprint = options.repositoryFingerprint ??
      ((signal) => defaultGitRepositoryFingerprint(workspaceRoot, signal));
    this.telemetry = options.telemetry;
    this.indexVersion = versionFor(this.workspaceId, this.repositoryFingerprint, this.filesFingerprint, 0);
  }

  public static async open(workspaceRoot: string, options: LocalCodeIndexOptions = {}): Promise<LocalCodeIndex> {
    const resolvedRoot = path.resolve(workspaceRoot);
    const stat = await fs.lstat(resolvedRoot);
    if (!stat.isDirectory() || stat.isSymbolicLink()) throw new Error("Code index workspace root must be a real directory.");
    const realRoot = await fs.realpath(resolvedRoot);
    const workspaceId = sha256(`workspace\0${canonicalWorkspacePath(realRoot)}`);
    const index = new LocalCodeIndex(realRoot, workspaceId, options);
    await index.loadPersistedState();
    return index;
  }

  private async loadPersistedState(): Promise<void> {
    await ensureStateDirectorySafe(this.stateDirectory, false);
    const stat = await fs.lstat(this.statePath).catch((error: NodeJS.ErrnoException) => {
      if (error.code === "ENOENT") return undefined;
      throw error;
    });
    if (!stat || !stat.isFile() || stat.isSymbolicLink() || stat.size > this.limits.maxIndexBytes) return;
    try {
      const buffer = await fs.readFile(this.statePath);
      const content = new TextDecoder("utf-8", { fatal: true }).decode(buffer);
      const parsed: unknown = JSON.parse(content);
      if (!isPersistedState(parsed) || parsed.workspaceId !== this.workspaceId) return;
      const loaded = new Map<string, IndexedFileRecord>();
      for (const record of parsed.files) {
        if (!isIndexedFileRecord(record)) return;
        const normalized = normalizeRelativePath(this.workspaceRoot, record.path);
        if (normalized !== record.path || isHardExcluded(normalized, false) || isProtectedReadPath(normalized)) return;
        if (loaded.has(normalized)) return;
        if (record.symbols.some((symbol) => symbol.indexVersion !== parsed.indexVersion)) return;
        loaded.set(normalized, markRecordSymbolsStale(record));
      }
      const recomputedFileFingerprint = fileFingerprint(loaded);
      if (recomputedFileFingerprint !== parsed.fileFingerprint) return;
      const recomputedVersion = versionFor(
        this.workspaceId,
        parsed.repositoryFingerprint,
        recomputedFileFingerprint,
        parsed.generation,
      );
      if (recomputedVersion !== parsed.indexVersion) return;
      this.records = loaded;
      this.generation = parsed.generation;
      this.indexVersion = parsed.indexVersion;
      this.repositoryFingerprint = parsed.repositoryFingerprint;
      this.filesFingerprint = recomputedFileFingerprint;
      this.builtAt = parsed.builtAt;
      this.truncated = parsed.truncated;
      // A persisted index has not yet been reconciled against live files in this process.
      this.stale = true;
    } catch {
      // Corrupt or incompatible local state is ignored. It is never treated as source input.
    }
  }

  public snapshot(): LocalCodeIndexSnapshot {
    return {
      schemaVersion: CODE_INDEX_SCHEMA_VERSION,
      workspaceId: this.workspaceId,
      generation: this.generation,
      indexVersion: this.indexVersion,
      repositoryFingerprint: this.repositoryFingerprint,
      fileFingerprint: this.filesFingerprint,
      builtAt: this.builtAt,
      stale: this.stale,
      truncated: this.truncated,
      files: sortedRecords(this.records).map((record) => this.stale ? markRecordSymbolsStale(record) : cloneRecord(record)),
    };
  }

  private markFileLookupStale(relativePath: string, record: IndexedFileRecord): IndexedFileRecord {
    const staleRecord = markRecordSymbolsStale(record);
    this.records.set(relativePath, staleRecord);
    this.stale = true;
    return cloneRecord(staleRecord);
  }

  public async getFile(
    requestedPath: string,
    options: CodeIndexFileLookupOptions = {},
  ): Promise<CodeIndexFileLookup> {
    const relativePath = normalizeRelativePath(this.workspaceRoot, requestedPath);
    const record = this.records.get(relativePath);
    if (!record) return { stale: true, reason: "not_indexed" };
    if (options.validate === false) {
      return {
        record: this.stale ? this.markFileLookupStale(relativePath, record) : cloneRecord(record),
        stale: this.stale,
      };
    }
    throwIfAborted(options.signal);
    try {
      const stat = await fs.lstat(path.join(this.workspaceRoot, relativePath));
      if (!stat.isFile() || stat.isSymbolicLink()) {
        return { record: this.markFileLookupStale(relativePath, record), stale: true, reason: "missing" };
      }
      if (stat.size > this.limits.maxFileBytes) {
        return { record: this.markFileLookupStale(relativePath, record), stale: true, reason: "changed" };
      }
      await ensureRealPathContained(this.workspaceRoot, path.join(this.workspaceRoot, relativePath));
      const candidate: CandidateFile = {
        relativePath,
        absolutePath: path.join(this.workspaceRoot, relativePath),
        sizeBytes: stat.size,
        mtimeMs: stat.mtimeMs,
      };
      const live = await strictUtf8File(candidate);
      throwIfAborted(options.signal);
      const changed = live.hash !== record.contentHash || live.stat.mtimeMs !== record.mtimeMs;
      const stale = this.stale || changed;
      return {
        record: stale ? this.markFileLookupStale(relativePath, record) : cloneRecord(record),
        stale,
        ...(changed ? { reason: "changed" as const } : {}),
      };
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") {
        return { record: this.markFileLookupStale(relativePath, record), stale: true, reason: "missing" };
      }
      throwIfAborted(options.signal);
      return { record: this.markFileLookupStale(relativePath, record), stale: true, reason: "unreadable" };
    }
  }

  /** Validates public one-based UTF-16 ranges against the exact indexed file bytes. */
  public async validateRanges(
    requestedPath: string,
    ranges: readonly CodeRange[],
    signal?: AbortSignal,
  ): Promise<boolean> {
    let relativePath: string;
    try {
      relativePath = normalizeRelativePath(this.workspaceRoot, requestedPath);
    } catch {
      return false;
    }
    const record = this.records.get(relativePath);
    if (!record || this.stale) return false;
    throwIfAborted(signal);
    try {
      const absolutePath = path.join(this.workspaceRoot, relativePath);
      const stat = await fs.lstat(absolutePath);
      if (!stat.isFile() || stat.isSymbolicLink() || stat.size > this.limits.maxFileBytes) {
        this.markFileLookupStale(relativePath, record);
        return false;
      }
      await ensureRealPathContained(this.workspaceRoot, absolutePath);
      const live = await strictUtf8File({
        relativePath,
        absolutePath,
        sizeBytes: stat.size,
        mtimeMs: stat.mtimeMs,
      });
      throwIfAborted(signal);
      if (live.hash !== record.contentHash || live.stat.mtimeMs !== record.mtimeMs) {
        this.markFileLookupStale(relativePath, record);
        return false;
      }
      return ranges.every((range) => rangeWithinUtf16Content(range, live.content));
    } catch {
      throwIfAborted(signal);
      this.markFileLookupStale(relativePath, record);
      return false;
    }
  }

  public async isFileStale(requestedPath: string, signal?: AbortSignal): Promise<boolean> {
    return (await this.getFile(requestedPath, { validate: true, signal })).stale;
  }

  public refresh(options: CodeIndexRefreshOptions = {}): Promise<CodeIndexBuildStats> {
    let resolveResult!: (value: CodeIndexBuildStats) => void;
    let rejectResult!: (reason: unknown) => void;
    const result = new Promise<CodeIndexBuildStats>((resolve, reject) => {
      resolveResult = resolve;
      rejectResult = reject;
    });
    this.mutationQueue = this.mutationQueue
      .catch(() => undefined)
      .then(async () => {
        try {
          resolveResult(await this.refreshInternal(options));
        } catch (error) {
          rejectResult(error);
        }
      });
    return result;
  }

  private async resolveRepositoryFingerprint(
    requested: string | RepositoryFingerprintProvider | undefined,
    signal: AbortSignal | undefined,
  ): Promise<string> {
    throwIfAborted(signal);
    const source = requested ?? this.defaultRepositoryFingerprint;
    const value = typeof source === "function" ? await source(signal) : source;
    throwIfAborted(signal);
    return sha256(`repository\0${value?.trim() || UNAVAILABLE_REPOSITORY_FINGERPRINT}`);
  }

  private removeScope(records: Map<string, IndexedFileRecord>, scope: string): void {
    for (const relativePath of records.keys()) {
      if (isWithinScope(relativePath, scope)) records.delete(relativePath);
    }
  }

  private async collectCandidates(
    scope: string,
    resolver: RepositoryIgnoreResolver,
    stats: MutableBuildStats,
    signal: AbortSignal | undefined,
    deadlineAt: number,
  ): Promise<CandidateFile[]> {
    const candidates: CandidateFile[] = [];
    let capacityExceeded = false;
    const walk = async (relativeDirectory: string): Promise<void> => {
      throwIfInterrupted(signal, deadlineAt);
      const absoluteDirectory = relativeDirectory === "."
        ? this.workspaceRoot
        : path.join(this.workspaceRoot, relativeDirectory);
      let entries: Dirent<string>[];
      try {
        entries = await fs.readdir(absoluteDirectory, { withFileTypes: true, encoding: "utf8" });
      } catch {
        incrementSkip(stats, "read_error");
        return;
      }
      entries.sort((left, right) => comparePaths(left.name, right.name));
      for (const entry of entries) {
        throwIfInterrupted(signal, deadlineAt);
        const relativePath = normalizeRepositoryPath(
          relativeDirectory === "." ? entry.name : `${relativeDirectory}/${entry.name}`,
        );
        if (entry.isSymbolicLink()) {
          incrementSkip(stats, "symlink");
          continue;
        }
        const isDirectory = entry.isDirectory();
        if (isHardExcluded(relativePath, isDirectory)) {
          incrementSkip(stats, "ignored");
          continue;
        }
        if (isProtectedReadPath(relativePath)) {
          incrementSkip(stats, "protected");
          continue;
        }
        let ignored = true;
        try {
          ignored = await resolver.isIgnored(relativePath, isDirectory);
        } catch {
          incrementSkip(stats, "read_error");
          continue;
        }
        if (ignored) {
          incrementSkip(stats, "ignored");
          continue;
        }
        if (isDirectory) {
          await walk(relativePath);
          if (capacityExceeded) return;
          continue;
        }
        if (!entry.isFile()) {
          incrementSkip(stats, "not_regular_file");
          continue;
        }
        if (candidates.length >= this.limits.maxFiles) {
          incrementSkip(stats, "file_capacity");
          capacityExceeded = true;
          return;
        }
        try {
          const absolutePath = path.join(this.workspaceRoot, relativePath);
          const stat = await fs.lstat(absolutePath);
          if (!stat.isFile() || stat.isSymbolicLink()) {
            incrementSkip(stats, stat.isSymbolicLink() ? "symlink" : "not_regular_file");
            continue;
          }
          candidates.push({ relativePath, absolutePath, sizeBytes: stat.size, mtimeMs: stat.mtimeMs });
        } catch {
          incrementSkip(stats, "read_error");
        }
      }
    };

    if (scope === ".") {
      await walk(".");
    } else {
      const absoluteScope = path.join(this.workspaceRoot, scope);
      let stat: Stats;
      try {
        stat = await fs.lstat(absoluteScope);
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code === "ENOENT") return [];
        incrementSkip(stats, "read_error");
        return [];
      }
      if (stat.isSymbolicLink()) {
        incrementSkip(stats, "symlink");
        return [];
      }
      if (isHardExcluded(scope, stat.isDirectory())) {
        incrementSkip(stats, "ignored");
        return [];
      }
      if (isProtectedReadPath(scope)) {
        incrementSkip(stats, "protected");
        return [];
      }
      let ignored = true;
      try {
        ignored = await resolver.isIgnored(scope, stat.isDirectory());
      } catch {
        incrementSkip(stats, "read_error");
        return [];
      }
      if (ignored) {
        incrementSkip(stats, "ignored");
        return [];
      }
      if (stat.isDirectory()) await walk(scope);
      else if (stat.isFile()) candidates.push({
        relativePath: scope,
        absolutePath: absoluteScope,
        sizeBytes: stat.size,
        mtimeMs: stat.mtimeMs,
      });
      else incrementSkip(stats, "not_regular_file");
    }
    return candidates.sort((left, right) => comparePaths(left.relativePath, right.relativePath));
  }

  private async indexCandidate(
    candidate: CandidateFile,
    previous: IndexedFileRecord | undefined,
    stats: MutableBuildStats,
    signal: AbortSignal | undefined,
    deadlineAt: number,
  ): Promise<IndexedFileRecord | undefined> {
    throwIfInterrupted(signal, deadlineAt);
    if (candidate.sizeBytes > this.limits.maxFileBytes) {
      incrementSkip(stats, "oversized");
      return undefined;
    }
    try {
      await ensureRealPathContained(this.workspaceRoot, candidate.absolutePath);
      const decoded = await strictUtf8File(candidate);
      throwIfInterrupted(signal, deadlineAt);
      if (decoded.stat.size > this.limits.maxFileBytes) {
        incrementSkip(stats, "oversized");
        return undefined;
      }
      if (
        previous?.contentHash === decoded.hash &&
        previous.adapterId === this.adapters.resolve(candidate.relativePath)?.id &&
        previous.symbols.length <= this.limits.maxSymbolsPerFile &&
        previous.snippets.length <= this.limits.maxSnippetsPerFile &&
        previous.tokens.length <= this.limits.maxUniqueTokensPerFile &&
        previous.tokens.reduce((total, token) => total + token.count, 0) <= this.limits.maxTokenOccurrencesPerFile &&
        previous.occurrences.length <= this.limits.maxIdentifierOccurrencesPerFile &&
        previous.snippets.every((snippet) => snippet.text.length <= this.limits.maxSnippetChars) &&
        Object.values(previous.truncated).every((value) => !value)
      ) {
        return {
          ...cloneRecord(previous),
          sizeBytes: decoded.stat.size,
          mtimeMs: decoded.stat.mtimeMs,
        };
      }
      const adapter = this.adapters.resolve(candidate.relativePath);
      if (!adapter) {
        incrementSkip(stats, "read_error");
        return undefined;
      }
      const extraction = adapter.extract({
        workspaceRoot: this.workspaceRoot,
        relativePath: candidate.relativePath,
        content: decoded.content,
        contentHash: decoded.hash,
        indexVersion: PROVISIONAL_INDEX_VERSION,
        limits: this.limits,
        signal,
        deadlineAt,
      });
      return {
        schemaVersion: CODE_INDEX_SCHEMA_VERSION,
        path: candidate.relativePath,
        adapterId: adapter.id,
        language: extraction.language,
        contentHash: decoded.hash,
        sizeBytes: decoded.stat.size,
        mtimeMs: decoded.stat.mtimeMs,
        indexedAt: new Date().toISOString(),
        symbols: extraction.symbols,
        snippets: extraction.snippets,
        tokens: extraction.tokens,
        occurrences: extraction.occurrences,
        truncated: extraction.truncated,
      };
    } catch (error) {
      throwIfInterrupted(signal, deadlineAt);
      const code = (error as NodeJS.ErrnoException).code;
      if (code === "EBINARY") incrementSkip(stats, "binary");
      else if (code === "EUTF8") incrementSkip(stats, "invalid_utf8");
      else if (code === "ENOTREGULAR") incrementSkip(stats, "not_regular_file");
      else incrementSkip(stats, "read_error");
      return undefined;
    }
  }

  private enforceGlobalCapacities(
    records: Map<string, IndexedFileRecord>,
    stats: MutableBuildStats,
  ): Map<string, IndexedFileRecord> {
    const bounded = new Map<string, IndexedFileRecord>();
    let sourceBytes = 0;
    let indexBytes = INDEX_METADATA_RESERVE_BYTES;
    for (const record of sortedRecords(records)) {
      if (record.sizeBytes > this.limits.maxFileBytes) {
        incrementSkip(stats, "oversized");
        continue;
      }
      if (bounded.size >= this.limits.maxFiles) {
        incrementSkip(stats, "file_capacity");
        continue;
      }
      if (sourceBytes + record.sizeBytes > this.limits.maxSourceBytes) {
        incrementSkip(stats, "source_capacity");
        continue;
      }
      const recordBytes = serializedRecordBytes(record);
      if (indexBytes + recordBytes > this.limits.maxIndexBytes) {
        incrementSkip(stats, "index_capacity");
        continue;
      }
      bounded.set(record.path, record);
      sourceBytes += record.sizeBytes;
      indexBytes += recordBytes;
    }
    return bounded;
  }

  private async refreshInternal(options: CodeIndexRefreshOptions): Promise<CodeIndexBuildStats> {
    const startedMs = Date.now();
    const deadlineAt = startedMs + this.limits.maxBuildMs;
    const normalizedScopes = options.paths?.length
      ? [...new Set(options.paths.map((entry) => normalizeRelativePath(this.workspaceRoot, entry)))].sort(comparePaths)
      : ["."];
    const full = this.stale || normalizedScopes.includes(".");
    const requestedScopes = full
      ? ["."]
      : normalizedScopes.filter((scope) => !normalizedScopes.some((parent) => parent !== scope && isWithinScope(scope, parent)));
    const stats: MutableBuildStats = {
      mode: full ? "full" : "incremental",
      startedAt: new Date(startedMs).toISOString(),
      startedMs,
      filesScanned: 0,
      skipped: createSkipCounts(),
      truncated: false,
    };
    throwIfInterrupted(options.signal, deadlineAt);
    const repositoryFingerprint = await this.resolveRepositoryFingerprint(options.repositoryFingerprint, options.signal);
    const resolver = new RepositoryIgnoreResolver(this.workspaceRoot);
    let working = full
      ? new Map<string, IndexedFileRecord>()
      : new Map([...this.records.entries()].map(([entryPath, record]) => [entryPath, cloneRecord(record)]));
    working = this.enforceGlobalCapacities(working, stats);
    let sourceBytes = [...working.values()].reduce((total, record) => total + record.sizeBytes, 0);
    let indexBytes = INDEX_METADATA_RESERVE_BYTES + [...working.values()]
      .reduce((total, record) => total + serializedRecordBytes(record), 0);
    let stopExtraction = false;
    const removeWorkingRecord = (relativePath: string): void => {
      const existing = working.get(relativePath);
      if (!existing) return;
      working.delete(relativePath);
      sourceBytes -= existing.sizeBytes;
      indexBytes = Math.max(INDEX_METADATA_RESERVE_BYTES, indexBytes - serializedRecordBytes(existing));
    };

    for (const scope of requestedScopes) {
      throwIfInterrupted(options.signal, deadlineAt);
      const candidates = await this.collectCandidates(scope, resolver, stats, options.signal, deadlineAt);
      const candidatePaths = new Set(candidates.map((candidate) => candidate.relativePath));
      if (!full) {
        for (const existingPath of [...working.keys()]) {
          if (isWithinScope(existingPath, scope) && !candidatePaths.has(existingPath)) {
            removeWorkingRecord(existingPath);
          }
        }
      }
      for (const candidate of candidates) {
        stats.filesScanned += 1;
        removeWorkingRecord(candidate.relativePath);
        if (stopExtraction) {
          incrementSkip(stats, "index_capacity");
          continue;
        }
        if (candidate.sizeBytes > this.limits.maxFileBytes) {
          incrementSkip(stats, "oversized");
          continue;
        }
        if (working.size >= this.limits.maxFiles) {
          incrementSkip(stats, "file_capacity");
          continue;
        }
        if (sourceBytes + candidate.sizeBytes > this.limits.maxSourceBytes) {
          incrementSkip(stats, "source_capacity");
          continue;
        }
        if (indexBytes + Math.max(512, minimumRecordBytes(candidate)) > this.limits.maxIndexBytes) {
          incrementSkip(stats, "index_capacity");
          continue;
        }
        const indexed = await this.indexCandidate(
          candidate,
          this.records.get(candidate.relativePath),
          stats,
          options.signal,
          deadlineAt,
        );
        if (!indexed) continue;
        if (sourceBytes + indexed.sizeBytes > this.limits.maxSourceBytes) {
          incrementSkip(stats, "source_capacity");
          continue;
        }
        const recordBytes = serializedRecordBytes(indexed);
        if (indexBytes + recordBytes > this.limits.maxIndexBytes) {
          incrementSkip(stats, "index_capacity");
          stopExtraction = true;
          continue;
        }
        working.set(candidate.relativePath, indexed);
        sourceBytes += indexed.sizeBytes;
        indexBytes += recordBytes;
      }
    }

    working = this.enforceGlobalCapacities(working, stats);
    throwIfInterrupted(options.signal, deadlineAt);
    let filesFingerprint = fileFingerprint(working);
    const nextTruncated = (!full && this.truncated) ||
      stats.truncated ||
      sortedRecords(working).some((record) => Object.values(record.truncated).some(Boolean));
    const contentChanged = filesFingerprint !== this.filesFingerprint ||
      repositoryFingerprint !== this.repositoryFingerprint ||
      nextTruncated !== this.truncated;
    const generation = contentChanged ? this.generation + 1 : this.generation;
    let indexVersion = contentChanged
      ? versionFor(this.workspaceId, repositoryFingerprint, filesFingerprint, generation)
      : this.indexVersion;
    working = new Map(
      sortedRecords(working).map((record) => [record.path, stampRecordVersion(record, indexVersion)]),
    );
    filesFingerprint = fileFingerprint(working);

    let finalState: PersistedCodeIndexState = {
      schemaVersion: CODE_INDEX_SCHEMA_VERSION,
      workspaceId: this.workspaceId,
      generation,
      indexVersion,
      repositoryFingerprint,
      fileFingerprint: filesFingerprint,
      builtAt: new Date().toISOString(),
      stale: false,
      truncated: nextTruncated,
      files: sortedRecords(working),
    };
    let serialized = JSON.stringify(finalState);
    while (Buffer.byteLength(serialized, "utf8") > this.limits.maxIndexBytes && working.size > 0) {
      const lastPath = [...working.keys()].sort(comparePaths).at(-1);
      if (!lastPath) break;
      working.delete(lastPath);
      incrementSkip(stats, "index_capacity");
      filesFingerprint = fileFingerprint(working);
      indexVersion = versionFor(this.workspaceId, repositoryFingerprint, filesFingerprint, generation);
      working = new Map(sortedRecords(working).map((record) => [record.path, stampRecordVersion(record, indexVersion)]));
      finalState = {
        ...finalState,
        indexVersion,
        fileFingerprint: filesFingerprint,
        truncated: true,
        files: sortedRecords(working),
      };
      serialized = JSON.stringify(finalState);
    }
    if (Buffer.byteLength(serialized, "utf8") > this.limits.maxIndexBytes) {
      throw new Error("Code index metadata alone exceeds maxIndexBytes.");
    }

    throwIfInterrupted(options.signal, deadlineAt);
    await ensureStateDirectorySafe(this.stateDirectory, true);
    await publishTextFileAtomic(this.statePath, serialized, options.signal);
    await fs.chmod(this.statePath, 0o600).catch(() => undefined);
    throwIfInterrupted(options.signal, deadlineAt);

    let filesAdded = 0;
    let filesUpdated = 0;
    let filesReused = 0;
    for (const record of working.values()) {
      const previous = this.records.get(record.path);
      if (!previous) filesAdded += 1;
      else if (
        previous.contentHash !== record.contentHash ||
        previous.mtimeMs !== record.mtimeMs ||
        previous.adapterId !== record.adapterId
      ) filesUpdated += 1;
      else filesReused += 1;
    }
    const filesDeleted = [...this.records.keys()].filter((entryPath) => !working.has(entryPath)).length;
    this.records = working;
    this.generation = generation;
    this.indexVersion = indexVersion;
    this.repositoryFingerprint = repositoryFingerprint;
    this.filesFingerprint = filesFingerprint;
    this.builtAt = finalState.builtAt;
    this.stale = false;
    this.truncated = finalState.truncated;

    const buildStats: CodeIndexBuildStats = {
      workspaceId: this.workspaceId,
      mode: stats.mode,
      indexVersion,
      generation,
      startedAt: stats.startedAt,
      durationMs: Date.now() - stats.startedMs,
      filesScanned: stats.filesScanned,
      filesIndexed: working.size,
      filesReused,
      filesAdded,
      filesUpdated,
      filesDeleted,
      sourceBytes: [...working.values()].reduce((total, record) => total + record.sizeBytes, 0),
      indexBytes: Buffer.byteLength(serialized, "utf8"),
      skipped: { ...stats.skipped },
      truncated: finalState.truncated,
      stale: false,
      fileFingerprint: filesFingerprint,
      repositoryFingerprint,
    };
    try {
      this.telemetry?.({ type: "code_index_build", stats: buildStats });
    } catch {
      // Telemetry is summary-only and must not make a successful local build fail.
    }
    return buildStats;
  }
}

export async function openLocalCodeIndex(
  workspaceRoot: string,
  options: LocalCodeIndexOptions = {},
): Promise<LocalCodeIndex> {
  return LocalCodeIndex.open(workspaceRoot, options);
}
