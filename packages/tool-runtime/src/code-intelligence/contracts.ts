import type {
  CodeIntelligenceFallbackType,
  CodeIntelligenceSource,
  CodeLocation,
  CodeRange,
  CodeRelationKind,
  CodeResultPrecision,
  CodeSymbol,
} from "../../../shared-schema/src/index.js";

export const CODE_INDEX_SCHEMA_VERSION = 1 as const;

export interface CodeIndexLimits {
  maxFiles: number;
  maxFileBytes: number;
  maxSourceBytes: number;
  maxIndexBytes: number;
  maxBuildMs: number;
  maxSymbolsPerFile: number;
  maxSnippetsPerFile: number;
  maxTokenOccurrencesPerFile: number;
  maxUniqueTokensPerFile: number;
  maxIdentifierOccurrencesPerFile: number;
  maxSnippetChars: number;
}

export const DEFAULT_CODE_INDEX_LIMITS: Readonly<CodeIndexLimits> = Object.freeze({
  maxFiles: 50_000,
  maxFileBytes: 2 * 1024 * 1024,
  maxSourceBytes: 256 * 1024 * 1024,
  maxIndexBytes: 64 * 1024 * 1024,
  maxBuildMs: 30_000,
  maxSymbolsPerFile: 2_000,
  maxSnippetsPerFile: 2_000,
  maxTokenOccurrencesPerFile: 100_000,
  maxUniqueTokensPerFile: 20_000,
  maxIdentifierOccurrencesPerFile: 50_000,
  maxSnippetChars: 1_200,
});

export type IndexedCodeSymbol = CodeSymbol & {
  /** Stable within a content version; never presented as a language-server id. */
  symbolId: string;
};

export interface IndexedCodeSnippet {
  snippetId: string;
  text: string;
  location: CodeLocation;
  tokens: string[];
  symbolId?: string;
  symbolName?: string;
}

export interface IndexedToken {
  token: string;
  count: number;
}

export interface IndexedIdentifierOccurrence {
  name: string;
  normalizedName: string;
  range: CodeRange;
  relation: CodeRelationKind;
  source: CodeIntelligenceSource;
  fallbackType: CodeIntelligenceFallbackType;
  precision: CodeResultPrecision;
  confidence: number;
}

export interface LanguageExtractionTruncation {
  symbols: boolean;
  snippets: boolean;
  tokens: boolean;
  occurrences: boolean;
}

export interface LanguageExtraction {
  language: string;
  symbols: IndexedCodeSymbol[];
  snippets: IndexedCodeSnippet[];
  tokens: IndexedToken[];
  occurrences: IndexedIdentifierOccurrence[];
  truncated: LanguageExtractionTruncation;
}

export interface LanguageAdapterContext {
  workspaceRoot: string;
  relativePath: string;
  content: string;
  contentHash: string;
  indexVersion: string;
  limits: Readonly<CodeIndexLimits>;
  signal?: AbortSignal;
  deadlineAt: number;
}

export interface LanguageAdapter {
  readonly id: string;
  readonly priority: number;
  supports(relativePath: string): boolean;
  extract(context: LanguageAdapterContext): LanguageExtraction;
}

export interface IndexedFileRecord {
  schemaVersion: typeof CODE_INDEX_SCHEMA_VERSION;
  path: string;
  adapterId: string;
  language: string;
  contentHash: string;
  sizeBytes: number;
  mtimeMs: number;
  indexedAt: string;
  symbols: IndexedCodeSymbol[];
  snippets: IndexedCodeSnippet[];
  tokens: IndexedToken[];
  occurrences: IndexedIdentifierOccurrence[];
  truncated: LanguageExtractionTruncation;
}

export type CodeIndexSkipReason =
  | "ignored"
  | "protected"
  | "symlink"
  | "binary"
  | "invalid_utf8"
  | "oversized"
  | "file_capacity"
  | "source_capacity"
  | "index_capacity"
  | "not_regular_file"
  | "read_error";

export type CodeIndexSkipCounts = Record<CodeIndexSkipReason, number>;

export interface CodeIndexBuildStats {
  /** Hash only. No source path, snippet, token, or source text is exposed here. */
  workspaceId: string;
  mode: "full" | "incremental";
  indexVersion: string;
  generation: number;
  startedAt: string;
  durationMs: number;
  filesScanned: number;
  filesIndexed: number;
  filesReused: number;
  filesAdded: number;
  filesUpdated: number;
  filesDeleted: number;
  sourceBytes: number;
  indexBytes: number;
  skipped: CodeIndexSkipCounts;
  truncated: boolean;
  stale: boolean;
  fileFingerprint: string;
  repositoryFingerprint: string;
}

export interface CodeIndexTelemetryEvent {
  type: "code_index_build";
  stats: CodeIndexBuildStats;
}

export type RepositoryFingerprintProvider = (
  signal?: AbortSignal,
) => string | undefined | Promise<string | undefined>;

export interface LocalCodeIndexOptions {
  stateDirectory?: string;
  limits?: Partial<CodeIndexLimits>;
  adapters?: LanguageAdapter[];
  repositoryFingerprint?: string | RepositoryFingerprintProvider;
  telemetry?: (event: CodeIndexTelemetryEvent) => void;
}

export interface CodeIndexRefreshOptions {
  /** Omit for a full reconciliation. Missing paths remove matching indexed entries. */
  paths?: string[];
  repositoryFingerprint?: string | RepositoryFingerprintProvider;
  signal?: AbortSignal;
}

export interface CodeIndexFileLookupOptions {
  /** Hash the live file before returning it. Defaults to true for precision-sensitive callers. */
  validate?: boolean;
  signal?: AbortSignal;
}

export interface CodeIndexFileLookup {
  record?: IndexedFileRecord;
  stale: boolean;
  reason?: "missing" | "changed" | "unreadable" | "not_indexed";
}

export interface LocalCodeIndexSnapshot {
  schemaVersion: typeof CODE_INDEX_SCHEMA_VERSION;
  workspaceId: string;
  generation: number;
  indexVersion: string;
  repositoryFingerprint: string;
  fileFingerprint: string;
  builtAt: string;
  stale: boolean;
  truncated: boolean;
  /** Always sorted by normalized workspace-relative path. */
  files: IndexedFileRecord[];
}

export interface PersistedCodeIndexState extends LocalCodeIndexSnapshot {
  schemaVersion: typeof CODE_INDEX_SCHEMA_VERSION;
}
