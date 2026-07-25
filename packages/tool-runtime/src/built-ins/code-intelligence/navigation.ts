import path from "node:path";

import type {
  CodeLocation,
  CodePosition,
  CodeRelation,
  CodeRelationKind,
  CodeResultPage,
  CodeResultProvenance,
  ToolAccessRequest,
  ToolPermissionProfile,
  ToolResult,
} from "../../../../shared-schema/src/index.js";
import {
  type IndexedFileRecord,
  type IndexedIdentifierOccurrence,
  type LocalCodeIndex,
  type LocalCodeIndexSnapshot,
  openLocalCodeIndex,
} from "../../code-intelligence/index.js";
import { normalizeRepositoryPath } from "../../repository-explorer.js";
import type {
  RuntimeToolExecutionContext,
  RuntimeToolSpec,
} from "../../tool-module.js";
import {
  createRequestDigest,
  paginateAuthoritativeItems,
  ResultPageBudgetError,
} from "./pagination.js";

const NAVIGATION_VERSION = "code-navigation-v1";
const MAX_CANDIDATES = 50_000;
const MAX_LSP_WARNINGS = 8;
const MAX_WARNING_CHARS = 300;
const TYPESCRIPT_FAMILY = new Set([
  "typescript",
  "typescriptreact",
  "javascript",
  "javascriptreact",
]);

export type ReferenceRelationKind = Exclude<CodeRelationKind, "definition">;
const REFERENCE_RELATIONS = new Set<ReferenceRelationKind>([
  "declaration",
  "reference_read",
  "reference_write",
  "reference_unknown",
]);

export interface LspNavigationTarget {
  /** Workspace-relative or workspace-contained path with a required source hash. */
  location: CodeLocation & { contentHash: string };
  /** Required for references; ignored and normalized to definition for definitions. */
  relation?: ReferenceRelationKind;
}

export interface LspNavigationRequest {
  workspaceRoot: string;
  workspaceId: string;
  indexVersion: string;
  file: string;
  /** Public one-based line and UTF-16 column. */
  position: CodePosition;
  sourceContentHash: string;
  symbol?: string;
  maxResults: number;
  maxFiles: number;
  signal?: AbortSignal;
}

export interface LspNavigationResponse {
  workspaceId: string;
  indexVersion: string;
  sourceContentHash: string;
  /** A provider must positively attest freshness; stale output is never exact. */
  stale: boolean;
  /** Whether the provider returned the full semantic result set. */
  complete: boolean;
  targets: LspNavigationTarget[];
  warnings?: string[];
}

export interface LspNavigationProvider {
  goToDefinition?(request: LspNavigationRequest): Promise<LspNavigationResponse>;
  findReferences?(request: LspNavigationRequest): Promise<LspNavigationResponse>;
}

export interface CodeNavigationToolOptions {
  lspProvider?: LspNavigationProvider;
  /** Injectable for deterministic tests; production defaults to the local index. */
  openIndex?: (workspaceRoot: string) => Promise<LocalCodeIndex>;
}

interface NavigationArgs {
  file: string;
  line: number;
  column: number;
  symbol?: string;
  maxResults?: number;
  maxFiles?: number;
  maxResultChars?: number;
  cursor?: string;
}

interface NormalizedNavigationArgs {
  file: string;
  line: number;
  column: number;
  symbol?: string;
  maxResults: number;
  maxFiles: number;
  maxResultChars: number;
  cursor?: string;
}

type NavigationOperation = "go_to_definition" | "find_references";

export type CodeNavigationResult = CodeResultPage<CodeRelation> & CodeResultProvenance & {
  operation: NavigationOperation;
  origin: CodeLocation;
  requestedSymbol?: string;
  resolvedSymbol?: string;
  exact: boolean;
  /** True means the entries are navigation candidates, not a semantic resolution claim. */
  candidateOnly: boolean;
  filesReturned: number;
  automaticChangesApplied: false;
};

interface NavigationCollection {
  items: CodeRelation[];
  provenance: CodeResultProvenance;
  totalExact: boolean;
  warnings: string[];
  resolvedSymbol?: string;
}

interface LspAttempt {
  collection?: NavigationCollection;
  warnings: string[];
}

function stableText(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0;
}

function normalizedName(value: string): string {
  return value.normalize("NFKC").toLocaleLowerCase("en-US");
}

function boundedWarnings(values: readonly string[]): string[] {
  return [...new Set(values.map((entry) => entry.trim()).filter(Boolean))]
    .slice(0, 12)
    .map((entry) => entry.slice(0, MAX_WARNING_CHARS));
}

function sanitizeError(error: unknown, workspaceRoot: string): string {
  const message = error instanceof Error ? error.message : String(error);
  const escapedRoot = workspaceRoot.replace(/[.*+?^${}()|[\]\\]/gu, "\\$&");
  return message
    .replace(new RegExp(escapedRoot, process.platform === "win32" ? "giu" : "gu"), "[WORKSPACE]")
    .replace(/\b(?:api[_-]?key|authorization|token|secret|password)\s*[=:]\s*[^\s,;]+/giu, "[REDACTED]")
    .slice(0, 500);
}

function normalizeFile(rawFile: string, context: RuntimeToolExecutionContext): string {
  const root = path.resolve(context.workspaceRoot);
  const absolute = context.moduleContext.paths.resolveWorkspace(rawFile);
  const relative = path.relative(root, absolute);
  if (!relative || relative.startsWith("..") || path.isAbsolute(relative)) {
    if (!relative) throw new Error("Navigation requires a workspace file, not the workspace directory.");
    throw new Error("Navigation file escapes the workspace.");
  }
  return normalizeRepositoryPath(relative).replace(/^\.\//u, "");
}

function normalizeArgs(
  raw: NavigationArgs,
  context: RuntimeToolExecutionContext,
): NormalizedNavigationArgs {
  if (!raw.file?.trim()) throw new Error("Navigation file must be non-empty.");
  if (!Number.isSafeInteger(raw.line) || raw.line < 1 || raw.line > 10_000_000) {
    throw new Error("Navigation line must be a positive one-based integer.");
  }
  if (!Number.isSafeInteger(raw.column) || raw.column < 1 || raw.column > 10_000_000) {
    throw new Error("Navigation column must be a positive one-based UTF-16 integer.");
  }
  const symbol = raw.symbol?.trim().normalize("NFKC");
  if (symbol && symbol.length > 500) throw new Error("Navigation symbol exceeds 500 characters.");
  const maxResults = raw.maxResults ?? 100;
  const maxFiles = raw.maxFiles ?? 100;
  const maxResultChars = raw.maxResultChars ?? 40_000;
  if (!Number.isSafeInteger(maxResults) || maxResults < 1 || maxResults > 500) {
    throw new Error("Navigation maxResults must be between 1 and 500.");
  }
  if (!Number.isSafeInteger(maxFiles) || maxFiles < 1 || maxFiles > 1_000) {
    throw new Error("Navigation maxFiles must be between 1 and 1000.");
  }
  if (!Number.isSafeInteger(maxResultChars) || maxResultChars < 4_096 || maxResultChars > 200_000) {
    throw new Error("Navigation maxResultChars must be between 4096 and 200000.");
  }
  return {
    file: normalizeFile(raw.file, context),
    line: raw.line,
    column: raw.column,
    ...(symbol ? { symbol } : {}),
    maxResults,
    maxFiles,
    maxResultChars,
    ...(raw.cursor ? { cursor: raw.cursor } : {}),
  };
}

function requestIdentity(operation: NavigationOperation, args: NormalizedNavigationArgs): unknown {
  return {
    operation,
    file: args.file,
    line: args.line,
    column: args.column,
    symbol: args.symbol,
    maxFiles: args.maxFiles,
    navigationVersion: NAVIGATION_VERSION,
  };
}

function containsPosition(
  occurrence: IndexedIdentifierOccurrence,
  line: number,
  column: number,
): boolean {
  const { start, end } = occurrence.range;
  if (line < start.line || line > end.line) return false;
  if (line === start.line && column < start.column) return false;
  if (line === end.line && column >= end.column) return false;
  return true;
}

function occurrenceAt(
  record: IndexedFileRecord,
  line: number,
  column: number,
): IndexedIdentifierOccurrence | undefined {
  return record.occurrences
    .filter((entry) => containsPosition(entry, line, column))
    .sort((left, right) =>
      (left.range.end.line - left.range.start.line) - (right.range.end.line - right.range.start.line) ||
      (left.range.end.column - left.range.start.column) - (right.range.end.column - right.range.start.column) ||
      stableText(left.name, right.name)
    )[0];
}

function originLocation(
  args: NormalizedNavigationArgs,
  record: IndexedFileRecord | undefined,
  occurrence: IndexedIdentifierOccurrence | undefined,
): CodeLocation {
  return {
    path: args.file,
    language: record?.language ?? "text",
    ...(record?.contentHash ? { contentHash: record.contentHash } : {}),
    range: occurrence?.range ?? {
      start: { line: args.line, column: args.column },
      end: { line: args.line, column: args.column },
    },
  };
}

function relationKey(relation: CodeRelation): string {
  const start = relation.to.range.start;
  const end = relation.to.range.end;
  return [
    relation.kind,
    relation.symbolName,
    relation.to.path,
    start.line,
    start.column,
    end.line,
    end.column,
  ].join("\0");
}

function sortRelations(relations: CodeRelation[]): CodeRelation[] {
  const order: Record<CodeRelationKind, number> = {
    definition: 0,
    declaration: 1,
    reference_write: 2,
    reference_read: 3,
    reference_unknown: 4,
  };
  return relations.sort((left, right) =>
    order[left.kind] - order[right.kind] ||
    stableText(left.to.path, right.to.path) ||
    left.to.range.start.line - right.to.range.start.line ||
    left.to.range.start.column - right.to.range.start.column ||
    stableText(left.symbolName, right.symbolName)
  );
}

function deduplicateRelations(relations: CodeRelation[]): CodeRelation[] {
  const seen = new Set<string>();
  return sortRelations(relations.filter((relation) => {
    const key = relationKey(relation);
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  }));
}

function approximateProvenance(
  items: readonly CodeRelation[],
  record: IndexedFileRecord | undefined,
  indexVersion: string,
  stale: boolean,
  warnings: string[],
): CodeResultProvenance {
  const sources = new Set(items.map((item) => item.source));
  if (sources.size === 1 && sources.has("ast")) {
    return {
      source: "ast",
      fallbackType: "ast",
      precision: "approximate",
      confidence: items.length ? Math.max(...items.map((item) => item.confidence)) : 0.7,
      indexVersion,
      stale,
      warnings: boundedWarnings(warnings),
    };
  }
  if (sources.size === 1 && sources.has("lexical")) {
    return {
      source: "lexical",
      fallbackType: "lexical",
      precision: "approximate",
      confidence: items.length ? Math.max(...items.map((item) => item.confidence)) : 0.25,
      indexVersion,
      stale,
      warnings: boundedWarnings(warnings),
    };
  }
  if (items.length > 0) {
    return {
      source: "semantic",
      fallbackType: "local_index",
      precision: "approximate",
      confidence: Math.min(0.75, Math.max(...items.map((item) => item.confidence))),
      indexVersion,
      stale,
      warnings: boundedWarnings(warnings),
    };
  }
  if (record && TYPESCRIPT_FAMILY.has(record.language)) {
    return {
      source: "ast",
      fallbackType: "ast",
      precision: "approximate",
      confidence: 0.5,
      indexVersion,
      stale,
      warnings: boundedWarnings(warnings),
    };
  }
  return {
    source: "lexical",
    fallbackType: record ? "lexical" : "capability_unavailable",
    precision: "approximate",
    confidence: record ? 0.2 : 0,
    indexVersion,
    stale,
    warnings: boundedWarnings(warnings),
  };
}

function capByFilesAndCandidates(
  relations: CodeRelation[],
  maxFiles: number,
): { items: CodeRelation[]; truncated: boolean } {
  const files = new Set<string>();
  const items: CodeRelation[] = [];
  let truncated = false;
  for (const relation of deduplicateRelations(relations)) {
    if (!files.has(relation.to.path) && files.size >= maxFiles) {
      truncated = true;
      continue;
    }
    if (items.length >= MAX_CANDIDATES) {
      truncated = true;
      break;
    }
    files.add(relation.to.path);
    items.push(relation);
  }
  return { items, truncated };
}

function occurrenceRelation(
  occurrence: IndexedIdentifierOccurrence,
  file: IndexedFileRecord,
  origin: CodeLocation,
  indexVersion: string,
  stale: boolean,
  symbolName: string,
  operation: NavigationOperation,
): CodeRelation {
  const isLexicalDefinitionCandidate = operation === "go_to_definition" && occurrence.source === "lexical";
  const kind = operation === "go_to_definition"
    ? (occurrence.relation === "declaration" ? "declaration" : "reference_unknown")
    : occurrence.relation;
  return {
    kind,
    symbolName,
    from: origin,
    to: {
      path: file.path,
      language: file.language,
      contentHash: file.contentHash,
      range: occurrence.range,
    },
    source: occurrence.source,
    fallbackType: occurrence.fallbackType,
    precision: "approximate",
    confidence: isLexicalDefinitionCandidate
      ? Math.min(0.25, occurrence.confidence)
      : Math.min(0.88, occurrence.confidence),
    indexVersion,
    stale,
    warnings: [
      isLexicalDefinitionCandidate
        ? "Lexical name match only; this is not a definition claim."
        : occurrence.source === "ast"
          ? "Approximate TypeScript compiler AST relation; not LSP-verified."
          : "Approximate lexical name match; relation semantics are unknown.",
    ],
  } as CodeRelation;
}

function fallbackNavigation(
  operation: NavigationOperation,
  snapshot: LocalCodeIndexSnapshot,
  record: IndexedFileRecord | undefined,
  args: NormalizedNavigationArgs,
  origin: CodeLocation,
  resolvedSymbol: string | undefined,
  inheritedWarnings: string[],
): NavigationCollection {
  const warnings = [...inheritedWarnings];
  const stale = snapshot.stale;
  if (!record) {
    warnings.push("The requested file is not available in the local index; no navigation claim was made.");
    return {
      items: [],
      provenance: approximateProvenance([], undefined, snapshot.indexVersion, true, warnings),
      totalExact: false,
      warnings: boundedWarnings(warnings),
      ...(resolvedSymbol ? { resolvedSymbol } : {}),
    };
  }
  if (!resolvedSymbol) {
    warnings.push("No indexed identifier covers the requested position and no symbol was supplied.");
    return {
      items: [],
      provenance: approximateProvenance([], record, snapshot.indexVersion, stale, warnings),
      totalExact: false,
      warnings: boundedWarnings(warnings),
    };
  }

  const wanted = normalizedName(resolvedSymbol);
  const relations: CodeRelation[] = [];
  if (operation === "go_to_definition") {
    for (const file of snapshot.files) {
      for (const symbol of file.symbols) {
        if (normalizedName(symbol.name) !== wanted) continue;
        relations.push({
          kind: "declaration",
          symbolName: resolvedSymbol,
          from: origin,
          to: {
            ...symbol.location,
            range: symbol.selectionRange ?? symbol.location.range,
          },
          source: "ast",
          fallbackType: "ast",
          precision: "approximate",
          confidence: Math.min(0.88, symbol.confidence),
          indexVersion: snapshot.indexVersion,
          stale,
          warnings: [
            "Syntactic declaration candidate from the TypeScript compiler AST; not an LSP-resolved definition.",
          ],
        });
      }
    }
  }

  for (const file of snapshot.files) {
    for (const occurrence of file.occurrences) {
      if (occurrence.normalizedName !== wanted) continue;
      if (operation === "go_to_definition" && occurrence.source === "ast" && occurrence.relation !== "declaration") {
        continue;
      }
      relations.push(occurrenceRelation(
        occurrence,
        file,
        origin,
        snapshot.indexVersion,
        stale,
        resolvedSymbol,
        operation,
      ));
    }
  }

  const capped = capByFilesAndCandidates(relations, args.maxFiles);
  warnings.push(
    operation === "go_to_definition"
      ? "LSP exact resolution was unavailable; returned entries are AST declarations or lexical candidates only."
      : "LSP exact references were unavailable; returned relations are AST/local-index/lexical approximations.",
  );
  if (snapshot.truncated) warnings.push("The local index is capacity-truncated; candidates may be incomplete.");
  if (capped.truncated) warnings.push("Navigation candidates reached the file or candidate limit.");
  const provenance = approximateProvenance(
    capped.items,
    record,
    snapshot.indexVersion,
    stale,
    warnings,
  );
  return {
    items: capped.items,
    provenance,
    totalExact: false,
    warnings: boundedWarnings(warnings),
    resolvedSymbol,
  };
}

function normalizeLspLocation(
  location: CodeLocation & { contentHash: string },
  context: RuntimeToolExecutionContext,
  snapshot: LocalCodeIndexSnapshot,
): { location?: CodeLocation; error?: string } {
  let relative: string;
  try {
    relative = normalizeFile(location.path, context);
  } catch {
    return { error: "LSP returned a target outside the workspace." };
  }
  const record = snapshot.files.find((entry) => entry.path === relative);
  if (!record || !location.contentHash || location.contentHash !== record.contentHash) {
    return { error: "LSP target content hash does not match the current local index." };
  }
  const { start, end } = location.range;
  if (
    !Number.isSafeInteger(start.line) || start.line < 1 ||
    !Number.isSafeInteger(start.column) || start.column < 1 ||
    !Number.isSafeInteger(end.line) || end.line < start.line ||
    !Number.isSafeInteger(end.column) || end.column < 1 ||
    (end.line === start.line && end.column < start.column)
  ) return { error: "LSP returned an invalid public range." };
  return {
    location: {
      path: relative,
      language: record.language,
      contentHash: record.contentHash,
      range: location.range,
    },
  };
}

async function tryLsp(
  operation: NavigationOperation,
  provider: LspNavigationProvider | undefined,
  index: LocalCodeIndex,
  snapshot: LocalCodeIndexSnapshot,
  record: IndexedFileRecord,
  args: NormalizedNavigationArgs,
  origin: CodeLocation,
  context: RuntimeToolExecutionContext,
  resolvedSymbol: string | undefined,
): Promise<LspAttempt> {
  const method = operation === "go_to_definition" ? provider?.goToDefinition : provider?.findReferences;
  if (!method) return { warnings: ["LSP navigation capability is unavailable; using a marked local fallback."] };
  if (snapshot.stale) return { warnings: ["The local index is stale; LSP output cannot be accepted as exact."] };

  let response: LspNavigationResponse;
  try {
    response = await method.call(provider, {
      workspaceRoot: context.workspaceRoot,
      workspaceId: snapshot.workspaceId,
      indexVersion: snapshot.indexVersion,
      file: args.file,
      position: { line: args.line, column: args.column },
      sourceContentHash: record.contentHash,
      ...(resolvedSymbol ? { symbol: resolvedSymbol } : {}),
      maxResults: MAX_CANDIDATES,
      maxFiles: args.maxFiles,
      signal: context.signal,
    });
  } catch (error) {
    return {
      warnings: [`LSP navigation failed; using a marked local fallback: ${sanitizeError(error, context.workspaceRoot)}`],
    };
  }
  if (!response || typeof response !== "object" || Array.isArray(response)) {
    return { warnings: ["LSP response was not an object; using a marked local fallback."] };
  }
  if (
    response.stale !== false ||
    typeof response.complete !== "boolean" ||
    response.workspaceId !== snapshot.workspaceId ||
    response.indexVersion !== snapshot.indexVersion ||
    response.sourceContentHash !== record.contentHash
  ) {
    return { warnings: ["LSP response freshness/version metadata did not match the current local index."] };
  }
  if (!Array.isArray(response.targets)) {
    return { warnings: ["LSP response was malformed; using a marked local fallback."] };
  }

  try {
    await index.refresh({ paths: ["."], signal: context.signal });
  } catch (error) {
    return {
      warnings: [`The workspace could not be reconciled after the LSP response; exact output was rejected: ${sanitizeError(error, context.workspaceRoot)}`],
    };
  }
  const reconciled = index.snapshot();
  if (
    reconciled.stale ||
    reconciled.workspaceId !== snapshot.workspaceId ||
    reconciled.indexVersion !== snapshot.indexVersion ||
    reconciled.fileFingerprint !== snapshot.fileFingerprint ||
    reconciled.repositoryFingerprint !== snapshot.repositoryFingerprint
  ) {
    return {
      warnings: ["The workspace changed while the LSP request was running; exact output was rejected."],
    };
  }

  const selectedTargets = response.targets.slice(0, MAX_CANDIDATES);
  const relations: CodeRelation[] = [];
  for (const target of selectedTargets) {
    if (!target || typeof target !== "object" || !target.location) {
      return { warnings: ["LSP response contained a malformed target; exactness was rejected."] };
    }
    if (
      operation === "find_references" &&
      target.relation !== undefined &&
      !REFERENCE_RELATIONS.has(target.relation)
    ) return { warnings: ["LSP response contained an invalid reference relation; exactness was rejected."] };
    const normalized = normalizeLspLocation(target.location, context, snapshot);
    if (!normalized.location) return { warnings: [normalized.error ?? "LSP target validation failed."] };
    relations.push({
      kind: operation === "go_to_definition" ? "definition" : (target.relation ?? "reference_unknown"),
      symbolName: resolvedSymbol ?? args.symbol ?? "[position]",
      from: origin,
      to: normalized.location,
      source: "lsp",
      fallbackType: "none",
      precision: "exact",
      confidence: 1,
      indexVersion: snapshot.indexVersion,
      stale: false,
      warnings: [],
    });
  }
  const capped = capByFilesAndCandidates(relations, args.maxFiles);

  const rangesByFile = new Map<string, CodeLocation["range"][]>([[args.file, [origin.range]]]);
  for (const relation of capped.items) {
    const ranges = rangesByFile.get(relation.to.path) ?? [];
    ranges.push(relation.to.range);
    rangesByFile.set(relation.to.path, ranges);
  }
  for (const [filePath, ranges] of rangesByFile) {
    if (!await index.validateRanges(filePath, ranges, context.signal)) {
      return { warnings: ["An LSP origin or target range was outside the current UTF-16 file boundaries; exact output was rejected."] };
    }
  }
  const postValidation = index.snapshot();
  if (
    postValidation.stale ||
    postValidation.workspaceId !== snapshot.workspaceId ||
    postValidation.indexVersion !== snapshot.indexVersion ||
    postValidation.fileFingerprint !== snapshot.fileFingerprint ||
    postValidation.repositoryFingerprint !== snapshot.repositoryFingerprint
  ) {
    return { warnings: ["The local index changed during LSP validation; exact output was rejected."] };
  }

  const rawWarnings = Array.isArray(response.warnings) ? response.warnings : [];
  const safeWarnings = rawWarnings
    .filter((entry): entry is string => typeof entry === "string")
    .slice(0, MAX_LSP_WARNINGS);
  const warnings = boundedWarnings([
    ...safeWarnings,
    ...(response.warnings !== undefined &&
        (!Array.isArray(response.warnings) || safeWarnings.length !== rawWarnings.length)
      ? ["LSP returned malformed warning metadata; invalid warning entries were ignored."]
      : []),
    ...(capped.truncated || response.targets.length > MAX_CANDIDATES
      ? ["LSP results reached the file or candidate limit; exact entries are complete but the total is not exact."]
      : []),
  ]);
  const provenance: CodeResultProvenance = {
    source: "lsp",
    fallbackType: "none",
    precision: "exact",
    confidence: 1,
    indexVersion: snapshot.indexVersion,
    stale: false,
    warnings,
  };
  return {
    collection: {
      items: capped.items,
      provenance,
      totalExact: response.complete && !capped.truncated && response.targets.length <= MAX_CANDIDATES,
      warnings,
      ...(resolvedSymbol ? { resolvedSymbol } : {}),
    },
    warnings: [],
  };
}

function failure<TStructured = unknown>(
  operation: NavigationOperation,
  context: RuntimeToolExecutionContext,
  code: string,
  message: string,
  extra: Record<string, unknown> = {},
): ToolResult<TStructured> {
  const body = {
    kind: operation,
    errorCode: code,
    message,
    automaticChangesApplied: false,
    ...extra,
  };
  const now = context.moduleContext.clock.now();
  return {
    toolName: operation,
    callId: context.callId,
    startedAt: now,
    endedAt: now,
    success: false,
    output: JSON.stringify(body, null, 2),
    structuredContent: body as TStructured,
    error: message,
  };
}

async function executeNavigation(
  operation: NavigationOperation,
  rawArgs: NavigationArgs,
  context: RuntimeToolExecutionContext,
  options: CodeNavigationToolOptions,
  acquireIndex: (workspaceRoot: string) => Promise<LocalCodeIndex>,
): Promise<ToolResult<CodeNavigationResult>> {
  let args: NormalizedNavigationArgs;
  try {
    args = normalizeArgs(rawArgs, context);
  } catch (error) {
    return failure<CodeNavigationResult>(operation, context, "invalid_arguments", sanitizeError(error, context.workspaceRoot));
  }

  let index: LocalCodeIndex;
  let snapshot: LocalCodeIndexSnapshot;
  let record: IndexedFileRecord | undefined;
  let indexWarnings: string[] = [];
  try {
    index = await acquireIndex(context.workspaceRoot);
    await index.refresh({ paths: ["."], signal: context.signal });
    const lookup = await index.getFile(args.file, { validate: true, signal: context.signal });
    snapshot = index.snapshot();
    record = lookup.record;
    if (lookup.stale) indexWarnings.push(`Requested file is stale (${lookup.reason ?? "unknown"}); exact LSP output is disabled.`);
  } catch (error) {
    return failure<CodeNavigationResult>(
      operation,
      context,
      "capability_unavailable",
      `Local navigation index is unavailable: ${sanitizeError(error, context.workspaceRoot)}`,
    );
  }

  let occurrence = record ? occurrenceAt(record, args.line, args.column) : undefined;
  let resolvedSymbol = args.symbol ?? occurrence?.name;
  let origin = originLocation(args, record, occurrence);
  if (record && !await index.validateRanges(args.file, [origin.range], context.signal)) {
    return failure<CodeNavigationResult>(
      operation,
      context,
      "invalid_position",
      "The requested navigation position is outside the current file's one-based UTF-16 boundaries.",
      { origin },
    );
  }
  let collection: NavigationCollection;
  if (record && !snapshot.stale) {
    const lsp = await tryLsp(
      operation,
      options.lspProvider,
      index,
      snapshot,
      record,
      args,
      origin,
      context,
      resolvedSymbol,
    );
    indexWarnings = [...indexWarnings, ...lsp.warnings];
    if (lsp.collection) {
      collection = lsp.collection;
    } else {
      try {
        await index.refresh({ paths: ["."], signal: context.signal });
        snapshot = index.snapshot();
      } catch (error) {
        return failure<CodeNavigationResult>(
          operation,
          context,
          "capability_unavailable",
          `Local fallback index refresh failed after the LSP attempt: ${sanitizeError(error, context.workspaceRoot)}`,
          { fallbackWarnings: boundedWarnings(indexWarnings) },
        );
      }
      record = snapshot.files.find((entry) => entry.path === args.file);
      occurrence = record ? occurrenceAt(record, args.line, args.column) : undefined;
      resolvedSymbol = args.symbol ?? occurrence?.name;
      origin = originLocation(args, record, occurrence);
      if (record && !await index.validateRanges(args.file, [origin.range], context.signal)) {
        return failure<CodeNavigationResult>(
          operation,
          context,
          "invalid_position",
          "The requested navigation position is outside the refreshed file's one-based UTF-16 boundaries.",
          { origin, fallbackWarnings: boundedWarnings(indexWarnings) },
        );
      }
      collection = fallbackNavigation(
        operation,
        snapshot,
        record,
        args,
        origin,
        resolvedSymbol,
        indexWarnings,
      );
    }
  } else {
    collection = fallbackNavigation(
      operation,
      snapshot,
      record,
      args,
      origin,
      resolvedSymbol,
      indexWarnings,
    );
  }

  const requestDigest = createRequestDigest(requestIdentity(operation, args));
  const buildEnvelope = (
    items: CodeRelation[],
    page: { cursor?: string; nextCursor?: string; hasMore: boolean; truncated: boolean },
  ): CodeNavigationResult => ({
    ...collection.provenance,
    operation,
    origin,
    ...(args.symbol ? { requestedSymbol: args.symbol } : {}),
    ...(collection.resolvedSymbol ? { resolvedSymbol: collection.resolvedSymbol } : {}),
    exact: collection.provenance.source === "lsp" && collection.provenance.precision === "exact",
    candidateOnly: collection.provenance.precision !== "exact",
    items,
    total: collection.items.length,
    totalExact: collection.totalExact,
    returned: items.length,
    ...(page.cursor ? { cursor: page.cursor } : {}),
    ...(page.nextCursor ? { nextCursor: page.nextCursor } : {}),
    hasMore: page.hasMore,
    truncated: page.truncated || !collection.totalExact,
    maxResultChars: args.maxResultChars,
    indexVersion: collection.provenance.indexVersion,
    stale: collection.provenance.stale,
    warnings: boundedWarnings([...collection.provenance.warnings, ...collection.warnings]),
    filesReturned: new Set(items.map((entry) => entry.to.path)).size,
    automaticChangesApplied: false,
  }) as CodeNavigationResult;

  let result: CodeNavigationResult;
  try {
    result = paginateAuthoritativeItems({
      allItems: collection.items,
      cursor: args.cursor,
      binding: {
        workspaceId: snapshot.workspaceId,
        tool: operation,
        indexVersion: collection.provenance.indexVersion,
        requestDigest,
      },
      maxItems: args.maxResults,
      maxResultChars: args.maxResultChars,
      buildEnvelope,
    }).envelope;
  } catch (error) {
    if (error instanceof ResultPageBudgetError) {
      return failure<CodeNavigationResult>(operation, context, "result_budget_too_small", error.message, {
        requiredChars: error.requiredChars,
        maxResultChars: error.maxResultChars,
        items: [],
      });
    }
    return failure<CodeNavigationResult>(operation, context, "invalid_cursor", sanitizeError(error, context.workspaceRoot), { items: [] });
  }

  let artifact;
  try {
    artifact = await context.moduleContext.persistence.storeToolOutputArtifact({
      sessionId: context.sessionId,
      turnId: context.turnId,
      toolCallId: context.callId,
      sourceToolName: operation,
      fileName: `${operation.replaceAll("_", "-")}-${context.callId}.json`,
      mimeType: "application/json",
      kind: "text",
      summary: `Recovery copy of ${result.returned} complete ${operation} items; the inline page is authoritative.`,
      content: JSON.stringify(result, null, 2),
      signal: context.signal,
    });
    const withArtifact = { ...result, artifactUri: artifact.uri };
    if (JSON.stringify(withArtifact, null, 2).length <= args.maxResultChars) result = withArtifact;
  } catch {
    // The complete authoritative inline page remains usable without the recovery artifact.
  }

  const now = context.moduleContext.clock.now();
  return {
    toolName: operation,
    callId: context.callId,
    startedAt: now,
    endedAt: now,
    success: true,
    output: JSON.stringify(result, null, 2),
    structuredContent: result,
    ...(artifact ? { artifacts: [artifact] } : {}),
  };
}

function createNavigationTool(
  operation: NavigationOperation,
  options: CodeNavigationToolOptions,
): RuntimeToolSpec<NavigationArgs, CodeNavigationResult> {
  let indexPromise: Promise<LocalCodeIndex> | undefined;
  const acquireIndex = (workspaceRoot: string): Promise<LocalCodeIndex> => {
    indexPromise ??= (options.openIndex ?? openLocalCodeIndex)(workspaceRoot).catch((error) => {
      indexPromise = undefined;
      throw error;
    });
    return indexPromise;
  };
  const isDefinition = operation === "go_to_definition";
  return {
    name: operation,
    displayName: isDefinition ? "Go to Definition" : "Find References",
    description: isDefinition
      ? "Resolve definitions with a fresh LSP when available; otherwise return explicitly approximate AST/local-index/lexical candidates. Never reads target files automatically."
      : "Find declarations, reads, writes, and unknown references with a fresh LSP when available; otherwise return explicitly approximate local candidates. Never reads target files automatically.",
    inputSchema: {
      type: "object",
      additionalProperties: false,
      required: ["file", "line", "column"],
      properties: {
        file: { type: "string", minLength: 1, maxLength: 8_192 },
        line: { type: "integer", minimum: 1, maximum: 10_000_000 },
        column: { type: "integer", minimum: 1, maximum: 10_000_000 },
        symbol: { type: "string", minLength: 1, maxLength: 500 },
        maxResults: { type: "integer", minimum: 1, maximum: 500, default: 100 },
        maxFiles: { type: "integer", minimum: 1, maximum: 1_000, default: 100 },
        maxResultChars: { type: "integer", minimum: 4_096, maximum: 200_000, default: 40_000 },
        cursor: { type: "string", minLength: 1, maxLength: 4_096 },
      },
    },
    readOnly: true,
    permissionCategory: "read_only",
    sideEffectLevel: "none",
    timeoutCategory: "slow",
    groups: ["code-intelligence", "repository", "navigation"],
    selection: {
      groups: ["code-intelligence", "repository", "navigation"],
      keywords: isDefinition
        ? ["go to definition", "where is defined", "where is this defined", "definition", "symbol declaration", "在哪里定义", "定义在哪里", "跳转到定义"]
        : ["find references", "who references", "where used", "reference read", "reference write", "usages", "谁引用", "查找引用", "谁在使用"],
      keywordGroups: isDefinition
        ? [["go", "definition"], ["find", "declaration"], ["哪里", "定义"]]
        : [["find", "references"], ["symbol", "usages"], ["谁", "引用"]],
    },
    resolveAccess: (_rawArgs, context): ToolAccessRequest[] => [{
      kind: "filesystem_read",
      paths: [context.paths.normalize(".")],
      reason: "Refresh the local workspace index and validate cross-file navigation targets.",
    }],
    resolvePermission: (): ToolPermissionProfile => ({
      permissionCategory: "read_only",
      sideEffectLevel: "none",
      readOnly: true,
    }),
    redactArguments: (rawArgs) => rawArgs,
    execute: (rawArgs, context) => executeNavigation(
      operation,
      rawArgs,
      context,
      options,
      acquireIndex,
    ),
  };
}

export function createGoToDefinitionTool(
  options: CodeNavigationToolOptions = {},
): RuntimeToolSpec<NavigationArgs, CodeNavigationResult> {
  return createNavigationTool("go_to_definition", options);
}

export function createFindReferencesTool(
  options: CodeNavigationToolOptions = {},
): RuntimeToolSpec<NavigationArgs, CodeNavigationResult> {
  return createNavigationTool("find_references", options);
}

export function createCodeNavigationTools(
  options: CodeNavigationToolOptions = {},
): Array<RuntimeToolSpec<NavigationArgs, CodeNavigationResult>> {
  return [createGoToDefinitionTool(options), createFindReferencesTool(options)];
}
