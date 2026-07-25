import { createHash } from "node:crypto";
import { promises as fs } from "node:fs";
import path from "node:path";

import type {
  CodeLocation,
  CodeSearchMatch,
  CodeSearchResult,
  CodeSymbol,
  ToolAccessRequest,
  ToolPermissionProfile,
  ToolResult,
} from "../../../../shared-schema/src/index.js";
import {
  isProbablyTextFile,
  isProtectedReadPath,
  normalizeRepositoryPath,
  RepositoryIgnoreResolver,
} from "../../repository-explorer.js";
import type { ToolNetworkService } from "../../network/index.js";
import type {
  RuntimeToolExecutionContext,
  RuntimeToolSpec,
  ToolAccessResolutionContext,
} from "../../tool-module.js";
import {
  type ExternalSemanticProviderPolicy,
  type LocalCodeIndex,
  type LocalCodeIndexSnapshot,
  normalizeSearchTokens,
  openLocalCodeIndex,
  resolveSemanticProviderPolicy,
} from "../../code-intelligence/index.js";
import {
  createRequestDigest,
  paginateAuthoritativeItems,
  ResultPageBudgetError,
} from "./pagination.js";

export interface ExternalSemanticCandidate {
  id: string;
  location: CodeLocation;
  snippet: string;
  snippetTruncated: boolean;
  snippetOriginalChars: number;
  symbolName?: string;
  localScore: number;
}

export interface ExternalSemanticProviderRequest {
  provider: string;
  endpoint: string;
  declaredDataBoundary: string;
  query: string;
  candidates: ExternalSemanticCandidate[];
  maxRankedResults: number;
  signal?: AbortSignal;
}

export interface ExternalSemanticProviderResponse {
  rankings: Array<{
    candidateId: string;
    score: number;
    confidence?: number;
    explanation?: string;
  }>;
  warnings?: string[];
}

export interface ExternalSemanticProvider {
  search(
    request: ExternalSemanticProviderRequest,
    services: { network: ToolNetworkService },
  ): Promise<ExternalSemanticProviderResponse>;
}

export interface SemanticSearchToolOptions {
  externalProvider?: ExternalSemanticProvider;
  /** Injectable shared local-index service; production module supplies one instance per workspace. */
  openIndex?: (workspaceRoot: string) => Promise<LocalCodeIndex>;
  /** Test/integration seam for keeping local ranking work bounded. */
  localRankingLimits?: Partial<LocalRankingLimits>;
}

export interface LocalRankingLimits {
  maxScannedSnippets: number;
  deadlineMs: number;
  yieldEvery: number;
}

interface SemanticSearchArgs {
  query: string;
  paths?: string[];
  languages?: string[];
  provider?: "local" | "external";
  maxResults?: number;
  maxResultChars?: number;
  maxSnippetChars?: number;
  cursor?: string;
}

interface NormalizedArgs {
  query: string;
  scopes: string[];
  languages: string[];
  provider: "local" | "external";
  maxResults: number;
  maxResultChars: number;
  maxSnippetChars: number;
  cursor?: string;
}

interface RankedSearch {
  items: CodeSearchMatch[];
  indexVersion: string;
  paginationVersion?: string;
  workspaceId: string;
  source: "semantic" | "lexical";
  fallbackType: "none" | "local_index" | "lexical";
  localOnly: boolean;
  externalDataShared: boolean;
  externalProvider?: string;
  totalExact: boolean;
  warnings: string[];
}

const RANKING_VERSION = "semantic-weighted-v1";
const MAX_LOCAL_MATCHES = 50_000;
const DEFAULT_LOCAL_RANKING_LIMITS: Readonly<LocalRankingLimits> = Object.freeze({
  maxScannedSnippets: 100_000,
  deadlineMs: 5_000,
  yieldEvery: 256,
});
const MAX_EXTERNAL_CANDIDATES = 200;
const MAX_EXTERNAL_SOURCE_CHARS = 100_000;
const MAX_LEXICAL_FILES = 20_000;
const MAX_LEXICAL_SOURCE_BYTES = 128 * 1024 * 1024;
const MAX_LEXICAL_FILE_BYTES = 2 * 1024 * 1024;
const MAX_LEXICAL_MATCHES = 50_000;
const LEXICAL_DEADLINE_MS = 10_000;
const HARD_EXCLUDED = new Set([
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
const STOP_WORDS = new Set([
  "a",
  "an",
  "and",
  "code",
  "find",
  "for",
  "implementation",
  "in",
  "is",
  "of",
  "or",
  "search",
  "that",
  "the",
  "to",
  "where",
  "with",
  "代码",
  "实现",
  "搜索",
  "查找",
  "相关",
  "逻辑",
]);

function sha256(value: string | Uint8Array): string {
  return createHash("sha256").update(value).digest("hex");
}

function stableText(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0;
}

function clamp(value: number, low: number, high: number): number {
  return Math.max(low, Math.min(high, value));
}

function rounded(value: number): number {
  return Math.round(value * 1_000_000) / 1_000_000;
}

function sanitizedError(error: unknown): string {
  const message = error instanceof Error ? error.message : String(error);
  return message
    .replace(/\b(?:api[_-]?key|token|secret|password)\s*[=:]\s*[^\s,;]+/giu, "[REDACTED]")
    .replace(/https:\/\/[^\s/@]+@/giu, "https://[REDACTED]@")
    .slice(0, 1_000);
}

function interrupted(signal: AbortSignal | undefined, deadline: number): void {
  if (signal?.aborted) {
    throw signal.reason instanceof Error ? signal.reason : new Error("semantic_search was cancelled.");
  }
  if (Date.now() >= deadline) throw new Error("semantic_search lexical fallback deadline exceeded.");
}

function hardExcluded(relativePath: string, directory: boolean): boolean {
  const normalized = normalizeRepositoryPath(relativePath).replace(/^\.\//u, "");
  if (normalized.split("/").some((segment) => HARD_EXCLUDED.has(segment.toLocaleLowerCase("en-US")))) {
    return true;
  }
  if (!directory) {
    const name = path.posix.basename(normalized);
    if (/\.map$/iu.test(name) || /(?:^|\.)min\.(?:css|js|mjs|cjs)$/iu.test(name)) return true;
  }
  return false;
}

function withinScope(file: string, scope: string): boolean {
  return scope === "." || file === scope || file.startsWith(`${scope}/`);
}

function inferLanguage(file: string): string {
  const ext = path.extname(file).toLocaleLowerCase("en-US");
  const known: Record<string, string> = {
    ".ts": "typescript",
    ".mts": "typescript",
    ".cts": "typescript",
    ".tsx": "typescriptreact",
    ".js": "javascript",
    ".mjs": "javascript",
    ".cjs": "javascript",
    ".jsx": "javascriptreact",
    ".py": "python",
    ".go": "go",
    ".rs": "rust",
    ".java": "java",
    ".c": "c",
    ".h": "c",
    ".cc": "cpp",
    ".cpp": "cpp",
    ".hpp": "cpp",
    ".cs": "csharp",
    ".sh": "shell",
    ".ps1": "powershell",
    ".sql": "sql",
  };
  return known[ext] ?? "text";
}

function expandLanguages(values: string[] | undefined): string[] {
  const expanded = new Set<string>();
  for (const raw of values ?? []) {
    const value = raw.trim().toLocaleLowerCase("en-US");
    if (!value) continue;
    if (value === "ts" || value === "typescript") {
      expanded.add("typescript");
      expanded.add("typescriptreact");
    } else if (value === "tsx" || value === "typescriptreact") {
      expanded.add("typescriptreact");
    } else if (value === "js" || value === "javascript") {
      expanded.add("javascript");
      expanded.add("javascriptreact");
    } else if (value === "jsx" || value === "javascriptreact") {
      expanded.add("javascriptreact");
    } else {
      expanded.add(value);
    }
  }
  return [...expanded].sort(stableText);
}

function languageAllowed(language: string, filters: readonly string[]): boolean {
  return filters.length === 0 || filters.includes(language);
}

function queryTokens(query: string): string[] {
  const raw = normalizeSearchTokens(query);
  const useful = raw.filter((token) => !STOP_WORDS.has(token));
  return useful.length > 0 ? useful : raw;
}

interface FoldedUtf16Line {
  text: string;
  originalStarts: number[];
  originalEnds: number[];
}

function foldUtf16Line(line: string): FoldedUtf16Line {
  let text = "";
  const originalStarts: number[] = [];
  const originalEnds: number[] = [];
  for (let index = 0; index < line.length;) {
    const codePoint = String.fromCodePoint(line.codePointAt(index)!);
    const width = codePoint.length;
    const folded = codePoint.toLocaleLowerCase("en-US");
    text += folded;
    for (let offset = 0; offset < folded.length; offset += 1) {
      originalStarts.push(index);
      originalEnds.push(index + width);
    }
    index += width;
  }
  return { text, originalStarts, originalEnds };
}

function foldedMatchRange(
  folded: FoldedUtf16Line,
  term: string,
): { start: number; end: number } | undefined {
  const needle = term.toLocaleLowerCase("en-US");
  if (!needle) return undefined;
  const index = folded.text.indexOf(needle);
  if (index < 0) return undefined;
  const start = folded.originalStarts[index];
  const end = folded.originalEnds[index + needle.length - 1];
  return start === undefined || end === undefined ? undefined : { start, end };
}

function bounded(value: string, maxChars: number): {
  text: string;
  truncated: boolean;
  original: number;
} {
  return {
    text: value.slice(0, maxChars),
    truncated: value.length > maxChars,
    original: value.length,
  };
}

function boundedSymbol(symbol: CodeSymbol | undefined): CodeSymbol | undefined {
  if (!symbol) return undefined;
  return {
    ...symbol,
    warnings: symbol.warnings.slice(0, 8).map((entry) => entry.slice(0, 300)),
    ...(symbol.signature ? { signature: symbol.signature.slice(0, 800) } : {}),
  };
}

function sortMatches(items: CodeSearchMatch[]): CodeSearchMatch[] {
  return items.sort((left, right) =>
    right.score - left.score ||
    right.confidence - left.confidence ||
    stableText(left.location.path, right.location.path) ||
    left.location.range.start.line - right.location.range.start.line ||
    left.location.range.start.column - right.location.range.start.column ||
    stableText(left.symbol?.name ?? "", right.symbol?.name ?? "") ||
    stableText(left.snippet, right.snippet)
  );
}

type SemanticNormalizationContext = RuntimeToolExecutionContext | ToolAccessResolutionContext;

function pathServices(context: SemanticNormalizationContext) {
  return "moduleContext" in context ? context.moduleContext.paths : context.paths;
}

function normalizeScopes(raw: string[] | undefined, context: SemanticNormalizationContext): string[] {
  const root = path.resolve(context.workspaceRoot);
  const values = raw?.length ? raw : ["."];
  const scopes = values.map((entry) => {
    const absolute = pathServices(context).resolveWorkspace(entry);
    const relative = path.relative(root, absolute);
    if (relative.startsWith("..") || path.isAbsolute(relative)) {
      throw new Error("semantic_search path escapes the workspace.");
    }
    return normalizeRepositoryPath(relative) || ".";
  });
  const unique = [...new Set(scopes)].sort(stableText);
  return unique.filter((scope, index, all) =>
    !all.some((parent, parentIndex) => parentIndex !== index && withinScope(scope, parent))
  );
}

function normalizeArgs(raw: SemanticSearchArgs, context: SemanticNormalizationContext): NormalizedArgs {
  const query = raw.query?.trim().normalize("NFKC");
  if (!query) throw new Error("semantic_search query must be non-empty.");
  const result: NormalizedArgs = {
    query,
    scopes: normalizeScopes(raw.paths, context),
    languages: expandLanguages(raw.languages),
    provider: raw.provider ?? "local",
    maxResults: raw.maxResults ?? 50,
    maxResultChars: raw.maxResultChars ?? 40_000,
    maxSnippetChars: raw.maxSnippetChars ?? 800,
    ...(raw.cursor ? { cursor: raw.cursor } : {}),
  };
  if (!Number.isSafeInteger(result.maxResults) || result.maxResults < 1 || result.maxResults > 500) {
    throw new Error("semantic_search maxResults is invalid.");
  }
  if (
    !Number.isSafeInteger(result.maxResultChars) ||
    result.maxResultChars < 4_096 ||
    result.maxResultChars > 200_000
  ) {
    throw new Error("semantic_search maxResultChars is invalid.");
  }
  if (
    !Number.isSafeInteger(result.maxSnippetChars) ||
    result.maxSnippetChars < 40 ||
    result.maxSnippetChars > 1_200
  ) {
    throw new Error("semantic_search maxSnippetChars is invalid.");
  }
  return result;
}

function identity(
  args: Pick<NormalizedArgs, "query" | "scopes" | "languages" | "provider" | "maxSnippetChars">,
): Record<string, unknown> {
  return {
    query: args.query,
    scopes: args.scopes,
    languages: args.languages,
    provider: args.provider,
    maxSnippetChars: args.maxSnippetChars,
    rankingVersion: RANKING_VERSION,
  };
}

function externalApprovalContext(
  args: NormalizedArgs,
  policy: ExternalSemanticProviderPolicy,
): Record<string, unknown> {
  return {
    semanticProvider: policy.provider,
    host: policy.host,
    endpointDigest: createRequestDigest(policy.endpoint),
    dataBoundaryDigest: createRequestDigest(policy.declaredDataBoundary),
    queryFilterDigest: createRequestDigest(identity(args)),
    maxExternalCandidates: MAX_EXTERNAL_CANDIDATES,
    maxExternalSourceChars: MAX_EXTERNAL_SOURCE_CHARS,
    maxSnippetChars: args.maxSnippetChars,
  };
}

function assertExternalApprovalBinding(
  args: NormalizedArgs,
  policy: ExternalSemanticProviderPolicy,
  context: RuntimeToolExecutionContext,
): void {
  const approved = context.approvalContext;
  const expected = externalApprovalContext(args, policy);
  if (!approved || createRequestDigest(approved) !== createRequestDigest(expected)) {
    throw new Error("External semantic approval context no longer matches the provider, endpoint, query filters, or data boundary; no source data was shared.");
  }
}

function resolveLocalRankingLimits(
  requested: Partial<LocalRankingLimits> | undefined,
): Readonly<LocalRankingLimits> {
  const resolve = (value: number | undefined, fallback: number, name: string): number => {
    const selected = value ?? fallback;
    if (!Number.isSafeInteger(selected) || selected < 1) {
      throw new Error(`semantic_search ${name} must be a positive safe integer.`);
    }
    return selected;
  };
  return {
    maxScannedSnippets: resolve(
      requested?.maxScannedSnippets,
      DEFAULT_LOCAL_RANKING_LIMITS.maxScannedSnippets,
      "localRankingLimits.maxScannedSnippets",
    ),
    deadlineMs: resolve(
      requested?.deadlineMs,
      DEFAULT_LOCAL_RANKING_LIMITS.deadlineMs,
      "localRankingLimits.deadlineMs",
    ),
    yieldEvery: resolve(
      requested?.yieldEvery,
      DEFAULT_LOCAL_RANKING_LIMITS.yieldEvery,
      "localRankingLimits.yieldEvery",
    ),
  };
}

function throwIfRankingAborted(signal: AbortSignal | undefined): void {
  if (!signal?.aborted) return;
  throw signal.reason instanceof Error ? signal.reason : new Error("semantic_search local ranking was cancelled.");
}

async function localRank(
  snapshot: LocalCodeIndexSnapshot,
  args: NormalizedArgs,
  signal: AbortSignal | undefined,
  limits: Readonly<LocalRankingLimits>,
): Promise<{
  items: CodeSearchMatch[];
  truncated: boolean;
  containsSemantic: boolean;
  semanticAvailable: boolean;
}> {
  throwIfRankingAborted(signal);
  const deadlineAt = Date.now() + limits.deadlineMs;
  const terms = queryTokens(args.query);
  const normalizedPhrase = args.query.toLocaleLowerCase("en-US");
  const matches: CodeSearchMatch[] = [];
  let truncated = false;
  let containsSemantic = false;
  let semanticAvailable = false;
  let scannedSnippets = 0;
  files: for (const file of snapshot.files) {
    if (Date.now() >= deadlineAt) {
      truncated = true;
      break;
    }
    if (
      !args.scopes.some((scope) => withinScope(file.path, scope)) ||
      !languageAllowed(file.language, args.languages)
    ) continue;
    if (file.adapterId !== "strict-utf8-lexical-v1") semanticAvailable = true;
    const corpus = new Set(file.tokens.map((entry) => entry.token));
    const symbols = new Map(file.symbols.map((entry) => [entry.symbolId, entry]));
    const pathTerms = new Set(normalizeSearchTokens(file.path));
    const lexicalFile = file.adapterId === "strict-utf8-lexical-v1";
    for (const snippet of file.snippets) {
      scannedSnippets += 1;
      if (scannedSnippets > limits.maxScannedSnippets || Date.now() >= deadlineAt) {
        truncated = true;
        break files;
      }
      if (scannedSnippets % limits.yieldEvery === 0) {
        await new Promise<void>((resolve) => setImmediate(resolve));
        throwIfRankingAborted(signal);
        if (Date.now() >= deadlineAt) {
          truncated = true;
          break files;
        }
      }
      const snippetTerms = new Set(snippet.tokens);
      const symbol = snippet.symbolId ? symbols.get(snippet.symbolId) : undefined;
      const symbolTerms = new Set(normalizeSearchTokens(symbol?.name ?? ""));
      const snippetHits = terms.filter((term) => snippetTerms.has(term));
      const symbolHits = terms.filter((term) => symbolTerms.has(term));
      const pathHits = terms.filter((term) => pathTerms.has(term));
      const corpusHits = terms.filter((term) => corpus.has(term));
      const phraseHit = normalizedPhrase.length > 1 &&
        snippet.text.toLocaleLowerCase("en-US").includes(normalizedPhrase);
      const symbolExact = symbol?.name.toLocaleLowerCase("en-US") === normalizedPhrase;
      if (
        !phraseHit &&
        !symbolExact &&
        snippetHits.length === 0 &&
        symbolHits.length === 0 &&
        pathHits.length === 0
      ) continue;
      const score = rounded(
        (phraseHit ? 8 : 0) +
        (symbolExact ? 8 : 0) +
        symbolHits.length * 4 +
        snippetHits.length * 2 +
        pathHits.length +
        corpusHits.length * 0.25,
      );
      const semanticConfidence = rounded(clamp(
        0.42 + Math.min(
          0.3,
          snippetHits.length * 0.05 + symbolHits.length * 0.08 + (phraseHit ? 0.12 : 0),
        ),
        0,
        0.82,
      ));
      const excerpt = bounded(snippet.text, args.maxSnippetChars);
      const match: CodeSearchMatch = lexicalFile
        ? {
            source: "lexical",
            fallbackType: "lexical",
            precision: "approximate",
            confidence: Math.min(0.45, semanticConfidence),
            indexVersion: snapshot.indexVersion,
            stale: snapshot.stale,
            warnings: ["Lexical local-index match; not an exact semantic relation."],
            location: snippet.location,
            snippet: excerpt.text,
            snippetTruncated: excerpt.truncated,
            snippetOriginalChars: excerpt.original,
            score,
            explanation: `Lexical index match: phrase=${String(phraseHit)}, snippetTokens=${snippetHits.length}, pathTokens=${pathHits.length}.`,
          }
        : {
            source: "semantic",
            fallbackType: "local_index",
            precision: "approximate",
            confidence: semanticConfidence,
            indexVersion: snapshot.indexVersion,
            stale: snapshot.stale,
            warnings: ["Local weighted token/symbol/snippet ranking; not an LSP-exact semantic relation."],
            location: snippet.location,
            ...(symbol ? { symbol: boundedSymbol(symbol) } : {}),
            snippet: excerpt.text,
            snippetTruncated: excerpt.truncated,
            snippetOriginalChars: excerpt.original,
            score,
            explanation: `Local weighted index match: phrase=${String(phraseHit)}, symbolTokens=${symbolHits.length}, snippetTokens=${snippetHits.length}, pathTokens=${pathHits.length}, corpusTokens=${corpusHits.length}.`,
          };
      matches.push(match);
      if (!lexicalFile) containsSemantic = true;
      if (matches.length >= MAX_LOCAL_MATCHES) {
        truncated = true;
        break files;
      }
    }
  }
  return { items: sortMatches(matches), truncated, containsSemantic, semanticAvailable };
}

async function assertNoSymlinkComponents(root: string, absolute: string): Promise<void> {
  const relative = path.relative(root, absolute);
  if (relative.startsWith("..") || path.isAbsolute(relative)) {
    throw new Error("lexical scope escapes workspace.");
  }
  let current = root;
  for (const segment of relative.split(path.sep).filter(Boolean)) {
    current = path.join(current, segment);
    if ((await fs.lstat(current)).isSymbolicLink()) {
      throw new Error("lexical scope contains a symlink or junction.");
    }
  }
  const real = await fs.realpath(absolute);
  const relReal = path.relative(await fs.realpath(root), real);
  if (relReal.startsWith("..") || path.isAbsolute(relReal)) {
    throw new Error("lexical scope escapes workspace through a link.");
  }
}

async function lexicalFallback(
  args: NormalizedArgs,
  context: RuntimeToolExecutionContext,
  reason: string,
): Promise<RankedSearch> {
  const deadline = Date.now() + LEXICAL_DEADLINE_MS;
  const resolver = new RepositoryIgnoreResolver(context.workspaceRoot);
  const terms = queryTokens(args.query);
  const matches: CodeSearchMatch[] = [];
  const fingerprints: string[] = [];
  let files = 0;
  let bytes = 0;
  let truncated = false;

  const visitFile = async (relative: string, absolute: string): Promise<void> => {
    interrupted(context.signal, deadline);
    if (files >= MAX_LEXICAL_FILES || matches.length >= MAX_LEXICAL_MATCHES) {
      truncated = true;
      return;
    }
    if (
      hardExcluded(relative, false) ||
      isProtectedReadPath(relative) ||
      await resolver.isIgnored(relative, false)
    ) return;
    const stat = await fs.lstat(absolute);
    if (!stat.isFile() || stat.isSymbolicLink()) return;
    if (stat.size > MAX_LEXICAL_FILE_BYTES || bytes + stat.size > MAX_LEXICAL_SOURCE_BYTES) {
      truncated = true;
      return;
    }
    const language = inferLanguage(relative);
    if (!languageAllowed(language, args.languages) || !await isProbablyTextFile(absolute)) return;
    await assertNoSymlinkComponents(context.workspaceRoot, absolute);
    const buffer = await fs.readFile(absolute);
    if (buffer.includes(0)) return;
    let content: string;
    try {
      content = new TextDecoder("utf-8", { fatal: true }).decode(buffer);
    } catch {
      return;
    }
    files += 1;
    bytes += buffer.length;
    const contentHash = sha256(buffer);
    fingerprints.push(`${relative}\0${contentHash}`);
    const lines = content.split(/\r\n|\n|\r/u);
    for (let lineIndex = 0; lineIndex < lines.length; lineIndex += 1) {
      interrupted(context.signal, deadline);
      const line = lines[lineIndex] ?? "";
      const folded = foldUtf16Line(line);
      const hitTerms = terms.filter((term) => foldedMatchRange(folded, term) !== undefined);
      if (hitTerms.length === 0) continue;
      const chosen = hitTerms.sort((left, right) =>
        right.length - left.length || stableText(left, right)
      )[0]!;
      const matchedRange = foldedMatchRange(folded, chosen);
      if (!matchedRange) continue;
      const phrase = folded.text.includes(args.query.toLocaleLowerCase("en-US"));
      const excerpt = bounded(line, args.maxSnippetChars);
      matches.push({
        source: "lexical",
        fallbackType: "lexical",
        precision: "approximate",
        confidence: phrase ? 0.45 : 0.28,
        indexVersion: "pending-lexical-version",
        stale: false,
        warnings: ["Lexical fallback after local semantic-index capability failure; not an exact semantic match."],
        location: {
          path: relative,
          language,
          contentHash,
          range: {
            start: { line: lineIndex + 1, column: matchedRange.start + 1 },
            end: { line: lineIndex + 1, column: matchedRange.end + 1 },
          },
        },
        snippet: excerpt.text,
        snippetTruncated: excerpt.truncated,
        snippetOriginalChars: excerpt.original,
        score: rounded((phrase ? 5 : 0) + hitTerms.length),
        explanation: `Explicit lexical fallback matched ${hitTerms.length} query token(s) on this line.`,
      });
      if (matches.length >= MAX_LEXICAL_MATCHES) {
        truncated = true;
        break;
      }
    }
  };

  const walk = async (relativeDir: string): Promise<void> => {
    interrupted(context.signal, deadline);
    const absoluteDir = relativeDir === "."
      ? context.workspaceRoot
      : path.join(context.workspaceRoot, relativeDir);
    const entries = await fs.readdir(absoluteDir, { withFileTypes: true });
    entries.sort((left, right) => stableText(left.name, right.name));
    for (const entry of entries) {
      if (truncated) return;
      const relative = normalizeRepositoryPath(
        relativeDir === "." ? entry.name : `${relativeDir}/${entry.name}`,
      );
      if (
        entry.isSymbolicLink() ||
        hardExcluded(relative, entry.isDirectory()) ||
        isProtectedReadPath(relative) ||
        await resolver.isIgnored(relative, entry.isDirectory())
      ) continue;
      if (entry.isDirectory()) await walk(relative);
      else if (entry.isFile()) await visitFile(relative, path.join(context.workspaceRoot, relative));
    }
  };

  for (const scope of args.scopes) {
    if (truncated) break;
    const absolute = scope === "." ? context.workspaceRoot : path.join(context.workspaceRoot, scope);
    let stat: Awaited<ReturnType<typeof fs.lstat>>;
    try {
      stat = await fs.lstat(absolute);
    } catch {
      continue;
    }
    if (
      stat.isSymbolicLink() ||
      hardExcluded(scope, stat.isDirectory()) ||
      isProtectedReadPath(scope) ||
      await resolver.isIgnored(scope, stat.isDirectory())
    ) continue;
    if (stat.isDirectory()) await walk(scope);
    else if (stat.isFile()) await visitFile(scope, absolute);
  }

  const indexVersion = `lexical-v1.${sha256(fingerprints.sort(stableText).join("\n"))}`;
  for (const item of matches) item.indexVersion = indexVersion;
  const realWorkspaceRoot = normalizeRepositoryPath(await fs.realpath(context.workspaceRoot)).replace(/\/+$/u, "");
  const canonicalWorkspaceRoot = process.platform === "win32" || process.platform === "darwin"
    ? realWorkspaceRoot.toLocaleLowerCase("en-US")
    : realWorkspaceRoot;
  return {
    items: sortMatches(matches),
    indexVersion,
    workspaceId: sha256(`workspace\0${canonicalWorkspaceRoot}`),
    source: "lexical",
    fallbackType: "lexical",
    localOnly: true,
    externalDataShared: false,
    totalExact: !truncated,
    warnings: [
      `Lexical fallback used because local semantic indexing was unavailable: ${reason.slice(0, 300)}`,
      ...resolver.listWarnings().slice(0, 8),
    ],
  };
}

function externalCandidates(
  snapshot: LocalCodeIndexSnapshot,
  args: NormalizedArgs,
): { candidates: ExternalSemanticCandidate[]; truncated: boolean } {
  const candidates: ExternalSemanticCandidate[] = [];
  let chars = 0;
  let truncated = false;
  files: for (const file of snapshot.files) {
    if (
      !args.scopes.some((scope) => withinScope(file.path, scope)) ||
      !languageAllowed(file.language, args.languages)
    ) continue;
    const symbols = new Map(file.symbols.map((symbol) => [symbol.symbolId, symbol]));
    for (const snippet of file.snippets) {
      const excerpt = bounded(snippet.text, args.maxSnippetChars);
      if (
        candidates.length >= MAX_EXTERNAL_CANDIDATES ||
        chars + excerpt.text.length > MAX_EXTERNAL_SOURCE_CHARS
      ) {
        truncated = true;
        break files;
      }
      candidates.push({
        id: snippet.snippetId,
        location: snippet.location,
        snippet: excerpt.text,
        snippetTruncated: excerpt.truncated,
        snippetOriginalChars: excerpt.original,
        ...(snippet.symbolId && symbols.get(snippet.symbolId)
          ? { symbolName: symbols.get(snippet.symbolId)!.name }
          : {}),
        localScore: 0,
      });
      chars += excerpt.text.length;
    }
  }
  return { candidates, truncated };
}

async function externalRank(
  snapshot: LocalCodeIndexSnapshot,
  args: NormalizedArgs,
  context: RuntimeToolExecutionContext,
  provider: ExternalSemanticProvider,
  onShare: () => void,
): Promise<RankedSearch> {
  const policy = resolveSemanticProviderPolicy({
    requestedProvider: "external",
    settings: context.moduleContext.settings,
  });
  if (policy.mode !== "external") throw new Error("External semantic provider policy was not resolved.");
  assertExternalApprovalBinding(args, policy, context);
  const selected = externalCandidates(snapshot, args);
  if (selected.candidates.length === 0) {
    return {
      items: [],
      indexVersion: snapshot.indexVersion,
      workspaceId: snapshot.workspaceId,
      source: "semantic",
      fallbackType: "none",
      localOnly: false,
      externalDataShared: false,
      externalProvider: policy.provider,
      totalExact: !snapshot.truncated,
      warnings: ["No bounded local candidates matched the requested scope; no external data was shared."],
    };
  }
  await context.moduleContext.permissions.assertNetworkHosts([policy.host]);
  onShare();
  const response = await provider.search({
    provider: policy.provider,
    endpoint: policy.endpoint,
    declaredDataBoundary: policy.declaredDataBoundary,
    query: args.query,
    candidates: selected.candidates,
    maxRankedResults: selected.candidates.length,
    signal: context.signal,
  }, { network: context.moduleContext.network });
  const byId = new Map(selected.candidates.map((candidate) => [candidate.id, candidate]));
  const used = new Set<string>();
  const items: CodeSearchMatch[] = [];
  let invalidRankings = 0;
  let duplicateRankings = 0;
  for (const ranking of response.rankings) {
    const candidate = byId.get(ranking.candidateId);
    if (!candidate || !Number.isFinite(ranking.score) ||
        (ranking.confidence !== undefined && !Number.isFinite(ranking.confidence))) {
      invalidRankings += 1;
      continue;
    }
    if (used.has(ranking.candidateId)) {
      duplicateRankings += 1;
      continue;
    }
    used.add(ranking.candidateId);
    items.push({
      source: "semantic",
      fallbackType: "none",
      precision: "approximate",
      confidence: rounded(clamp(ranking.confidence ?? 0.65, 0, 0.9)),
      indexVersion: snapshot.indexVersion,
      stale: snapshot.stale,
      warnings: ["Explicitly approved external ranking over bounded local candidates; not an LSP-exact result."],
      location: candidate.location,
      snippet: candidate.snippet,
      snippetTruncated: candidate.snippetTruncated,
      snippetOriginalChars: candidate.snippetOriginalChars,
      score: rounded(clamp(ranking.score, 0, 1)),
      explanation: (ranking.explanation ?? "External provider ranked this approved bounded candidate.").slice(0, 500),
    });
  }
  const sortedItems = sortMatches(items);
  const rankingComplete = used.size === selected.candidates.length &&
    invalidRankings === 0 && duplicateRankings === 0;
  const resultSetDigest = createRequestDigest(sortedItems);
  return {
    items: sortedItems,
    indexVersion: snapshot.indexVersion,
    paginationVersion: `external-semantic-v1.${sha256(`${snapshot.indexVersion}\0${resultSetDigest}`)}`,
    workspaceId: snapshot.workspaceId,
    source: "semantic",
    fallbackType: "none",
    localOnly: false,
    externalDataShared: true,
    externalProvider: policy.provider,
    totalExact: rankingComplete && !selected.truncated && !snapshot.truncated,
    warnings: [
      ...(selected.truncated ? ["External candidate upload was bounded; total is not exact."] : []),
      ...(!rankingComplete
        ? [`External provider omitted or returned invalid/duplicate rankings (accepted=${used.size}, candidates=${selected.candidates.length}, invalid=${invalidRankings}, duplicate=${duplicateRankings}); total is not exact.`]
        : []),
      ...(response.warnings ?? []).slice(0, 8)
        .filter((entry): entry is string => typeof entry === "string")
        .map((entry) => entry.slice(0, 300)),
    ],
  };
}

function failure(
  context: RuntimeToolExecutionContext,
  code: string,
  message: string,
  extra: Record<string, unknown> = {},
): ToolResult {
  const body = {
    kind: "semantic_search",
    errorCode: code,
    message,
    automaticChangesApplied: false,
    ...extra,
  };
  const now = context.moduleContext.clock.now();
  return {
    toolName: "semantic_search",
    callId: context.callId,
    startedAt: now,
    endedAt: now,
    success: false,
    output: JSON.stringify(body, null, 2),
    structuredContent: body,
    error: message,
  };
}

export function createSemanticSearchTool(options: SemanticSearchToolOptions = {}): RuntimeToolSpec {
  let indexPromise: Promise<LocalCodeIndex> | undefined;
  const acquireIndex = (workspaceRoot: string): Promise<LocalCodeIndex> => {
    indexPromise ??= (options.openIndex ?? openLocalCodeIndex)(workspaceRoot).catch((error) => {
      indexPromise = undefined;
      throw error;
    });
    return indexPromise;
  };

  return {
    name: "semantic_search",
    displayName: "Semantic Search / 语义搜索",
    description: "Search a local privacy-preserving code index with approximate provenance. Use returned path/range with read_file; full files are never read automatically. External ranking requires an explicit configured and approved request.",
    inputSchema: {
      type: "object",
      additionalProperties: false,
      required: ["query"],
      properties: {
        query: { type: "string", minLength: 1, maxLength: 2_000 },
        paths: {
          type: "array",
          maxItems: 50,
          items: { type: "string", minLength: 1, maxLength: 8_192 },
        },
        languages: {
          type: "array",
          maxItems: 20,
          items: { type: "string", minLength: 1, maxLength: 64 },
        },
        provider: { type: "string", enum: ["local", "external"], default: "local" },
        maxResults: { type: "integer", minimum: 1, maximum: 500, default: 50 },
        maxResultChars: { type: "integer", minimum: 4_096, maximum: 200_000, default: 40_000 },
        maxSnippetChars: { type: "integer", minimum: 40, maximum: 1_200, default: 800 },
        cursor: { type: "string", minLength: 1, maxLength: 4_096 },
      },
    },
    readOnly: true,
    permissionCategory: "read_only",
    sideEffectLevel: "none",
    timeoutCategory: "slow",
    groups: ["code-intelligence", "repository", "search"],
    selection: {
      groups: ["code-intelligence", "repository", "search"],
      keywords: [
        "semantic search",
        "find similar implementation",
        "related code",
        "语义搜索",
        "相似实现",
        "实现类似功能",
        "找相关逻辑",
        "相关逻辑",
      ],
      keywordGroups: [
        ["find", "implementation"],
        ["search", "code", "meaning"],
        ["查找", "实现"],
        ["实现", "类似", "功能"],
        ["代码", "相关", "逻辑"],
      ],
    },
    resolveAccess: (rawArgs, context): ToolAccessRequest[] => {
      const args = rawArgs as SemanticSearchArgs;
      const policy = resolveSemanticProviderPolicy({
        requestedProvider: args.provider,
        settings: context.settings,
      });
      return [{
        kind: "filesystem_read",
        paths: [context.paths.normalize(".")],
        reason: "Reconcile the repository-wide local source index; paths only filter returned and externally ranked candidates.",
      }, ...policy.accessRequests];
    },
    resolvePermission: (rawArgs, context): ToolPermissionProfile => {
      const args = normalizeArgs(rawArgs as SemanticSearchArgs, context);
      const policy = resolveSemanticProviderPolicy({
        requestedProvider: args.provider,
        settings: context.settings,
      });
      if (policy.mode === "local") {
        return { permissionCategory: "read_only", sideEffectLevel: "none", readOnly: true };
      }
      return {
        permissionCategory: "external_system",
        sideEffectLevel: "medium",
        readOnly: false,
        approvalContext: externalApprovalContext(args, policy),
      };
    },
    redactArguments: (rawArgs) => {
      const args = rawArgs as SemanticSearchArgs;
      return {
        ...args,
        query: "[SEMANTIC_QUERY_REDACTED]",
        queryChars: args.query?.length ?? 0,
      };
    },
    execute: async (rawArgs, context) => {
      let args: NormalizedArgs;
      try {
        args = normalizeArgs(rawArgs as SemanticSearchArgs, context);
      } catch (error) {
        return failure(context, "invalid_arguments", sanitizedError(error));
      }

      let ranked: RankedSearch;
      let externalCallAttempted = false;
      try {
        const unsupportedLanguage = args.languages.some((language) =>
          !["typescript", "typescriptreact", "javascript", "javascriptreact", "text"].includes(language)
        );
        if (unsupportedLanguage && args.provider === "local") {
          ranked = await lexicalFallback(
            args,
            context,
            "No verified semantic adapter exists for the requested language.",
          );
        } else {
          const index = await acquireIndex(context.workspaceRoot);
          await index.refresh({ paths: args.scopes, signal: context.signal });
          const snapshot = index.snapshot();
          if (args.provider === "external") {
            if (!options.externalProvider) {
              return failure(
                context,
                "capability_unavailable",
                "No external semantic provider implementation is available; no source data was shared.",
                { localFallbackAvailable: true, externalDataShared: false },
              );
            }
            ranked = await externalRank(
              snapshot,
              args,
              context,
              options.externalProvider,
              () => { externalCallAttempted = true; },
            );
          } else {
            const local = await localRank(
              snapshot,
              args,
              context.signal,
              resolveLocalRankingLimits(options.localRankingLimits),
            );
            const semanticResult = local.containsSemantic || (local.items.length === 0 && local.semanticAvailable);
            ranked = {
              items: local.items,
              indexVersion: snapshot.indexVersion,
              workspaceId: snapshot.workspaceId,
              source: semanticResult ? "semantic" : "lexical",
              fallbackType: semanticResult ? "local_index" : "lexical",
              localOnly: true,
              externalDataShared: false,
              totalExact: !snapshot.truncated && !local.truncated,
              warnings: [
                ...(snapshot.truncated ? ["The local index is incomplete because a file/read or capacity limit prevented full coverage; total is not exact."] : []),
                ...(local.truncated ? ["Semantic ranking reached its bounded match, scan, cancellation-yield, or time budget; total is not exact."] : []),
              ],
            };
          }
        }
      } catch (error) {
        if (args.provider === "external") {
          return failure(
            context,
            "capability_unavailable",
            `External semantic search failed: ${sanitizedError(error)}`,
            { localFallbackAvailable: true, externalDataShared: externalCallAttempted },
          );
        }
        try {
          ranked = await lexicalFallback(args, context, sanitizedError(error));
        } catch (fallbackError) {
          return failure(
            context,
            "capability_unavailable",
            `Local index and lexical fallback are unavailable: ${sanitizedError(fallbackError)}`,
          );
        }
      }

      const requestDigest = createRequestDigest(identity(args));
      const warnings = [...new Set(ranked.warnings)].slice(0, 12).map((entry) => entry.slice(0, 300));
      const buildEnvelope = (
        items: CodeSearchMatch[],
        page: { cursor?: string; nextCursor?: string; hasMore: boolean; truncated: boolean },
      ): CodeSearchResult => ({
        query: args.query,
        source: ranked.source,
        fallbackType: ranked.fallbackType,
        precision: "approximate",
        confidence: items.length
          ? Math.max(...items.map((item) => item.confidence))
          : (ranked.source === "lexical" ? 0.2 : 0.5),
        indexVersion: ranked.indexVersion,
        stale: false,
        warnings,
        localOnly: ranked.localOnly,
        externalDataShared: ranked.externalDataShared,
        ...(ranked.externalProvider ? { externalProvider: ranked.externalProvider } : {}),
        dataBoundary: ranked.localOnly ? "local_only" : "approved_external_snippets",
        items,
        total: ranked.items.length,
        totalExact: ranked.totalExact,
        returned: items.length,
        ...(page.cursor ? { cursor: page.cursor } : {}),
        ...(page.nextCursor ? { nextCursor: page.nextCursor } : {}),
        hasMore: page.hasMore,
        truncated: page.truncated || !ranked.totalExact,
        maxResultChars: args.maxResultChars,
      }) as CodeSearchResult;

      let result: CodeSearchResult;
      try {
        result = paginateAuthoritativeItems({
          allItems: ranked.items,
          cursor: args.cursor,
          binding: {
            workspaceId: ranked.workspaceId,
            tool: "semantic_search",
            indexVersion: ranked.paginationVersion ?? ranked.indexVersion,
            requestDigest,
          },
          maxItems: args.maxResults,
          maxResultChars: args.maxResultChars,
          buildEnvelope,
        }).envelope;
      } catch (error) {
        if (error instanceof ResultPageBudgetError) {
          return failure(context, "result_budget_too_small", error.message, {
            requiredChars: error.requiredChars,
            maxResultChars: error.maxResultChars,
            items: [],
          });
        }
        return failure(context, "invalid_cursor", sanitizedError(error), { items: [] });
      }

      let artifact;
      try {
        artifact = await context.moduleContext.persistence.storeToolOutputArtifact({
          sessionId: context.sessionId,
          turnId: context.turnId,
          toolCallId: context.callId,
          sourceToolName: "semantic_search",
          fileName: `semantic-search-${context.callId}.json`,
          mimeType: "application/json",
          kind: "text",
          summary: `Recovery copy of ${result.returned} complete semantic_search items; not a substitute for the authoritative current page.`,
          content: JSON.stringify(result, null, 2),
          signal: context.signal,
        });
        const withArtifact = { ...result, artifactUri: artifact.uri };
        if (JSON.stringify(withArtifact, null, 2).length <= args.maxResultChars) result = withArtifact;
      } catch {
        // The authoritative inline page remains complete when recovery persistence is unavailable.
      }
      const now = context.moduleContext.clock.now();
      return {
        toolName: "semantic_search",
        callId: context.callId,
        startedAt: now,
        endedAt: now,
        success: true,
        output: JSON.stringify(result, null, 2),
        structuredContent: result,
        ...(artifact ? { artifacts: [artifact] } : {}),
      };
    },
  };
}
