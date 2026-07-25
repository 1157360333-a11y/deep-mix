import path from "node:path";

import type {
  CodeLocation,
  CodeRange,
  CodeResultPage,
  CodeResultProvenance,
  CodeSymbol,
  CodeSymbolKind,
  ToolResult,
} from "../../../../shared-schema/src/index.js";
import { normalizeRepositoryPath } from "../../repository-explorer.js";
import type {
  RuntimeToolExecutionContext,
  RuntimeToolSpec,
} from "../../tool-module.js";
import {
  type LocalCodeIndex,
  type LocalCodeIndexSnapshot,
  openLocalCodeIndex,
} from "../../code-intelligence/index.js";
import {
  createRequestDigest,
  paginateAuthoritativeItems,
  ResultPageBudgetError,
} from "./pagination.js";

const TOOL_NAME = "code_symbols";
const RESULT_ORDER_VERSION = "code-symbols-path-position-v1";
const MAX_COLLECTED_SYMBOLS = 50_000;
const MAX_WARNING_CHARS = 300;

const SYMBOL_KINDS = Object.freeze([
  "module",
  "namespace",
  "class",
  "interface",
  "type",
  "enum",
  "enum_member",
  "function",
  "method",
  "constructor",
  "property",
  "field",
  "variable",
  "constant",
  "parameter",
  "import",
  "export",
  "unknown",
] as const satisfies readonly CodeSymbolKind[]);

const SYMBOL_KIND_SET = new Set<string>(SYMBOL_KINDS);

export interface LspCodeSymbol {
  name: string;
  kind: CodeSymbolKind;
  language: string;
  location: CodeLocation;
  selectionRange?: CodeRange;
  containerName?: string;
  signature?: string;
  exported?: boolean;
}

export interface CodeSymbolsLspRequest {
  workspaceRoot: string;
  scope: "file" | "workspace";
  filePath?: string;
  query?: string;
  kinds: CodeSymbolKind[];
  languages: string[];
  indexVersion: string;
  /** Trusted local hashes used only to reject stale LSP responses. */
  documentVersions: Array<{ path: string; contentHash: string }>;
  maxSymbols: number;
  signal?: AbortSignal;
}

export interface CodeSymbolsLspResult {
  available: boolean;
  symbols: LspCodeSymbol[];
  /** Must match both the pre-request and post-request refreshed local snapshots. */
  indexVersion: string;
  stale: boolean;
  truncated?: boolean;
  reason?: string;
  warnings?: string[];
}

/** Optional local language-server bridge. This tool never starts or installs a server. */
export interface CodeSymbolsLspProvider {
  listSymbols(request: CodeSymbolsLspRequest): Promise<CodeSymbolsLspResult>;
}

export interface CodeSymbolsToolOptions {
  lspProvider?: CodeSymbolsLspProvider;
  /** Injectable shared local-index service; production module supplies one instance per workspace. */
  openIndex?: (workspaceRoot: string) => Promise<LocalCodeIndex>;
}

interface CodeSymbolsArgs {
  scope?: "file" | "workspace";
  path?: string;
  query?: string;
  kinds?: CodeSymbolKind[];
  languages?: string[];
  maxResults?: number;
  maxResultChars?: number;
  cursor?: string;
}

interface NormalizedArgs {
  scope: "file" | "workspace";
  filePath?: string;
  query?: string;
  normalizedQuery?: string;
  kinds: CodeSymbolKind[];
  languages: string[];
  maxResults: number;
  maxResultChars: number;
  cursor?: string;
}

export type CodeSymbolsResult = CodeResultPage<CodeSymbol> & CodeResultProvenance & {
  scope: "file" | "workspace";
  filePath?: string;
  query?: string;
  automaticChangesApplied: false;
};

interface CollectedSymbols {
  items: CodeSymbol[];
  source: "lsp" | "ast" | "lexical" | "semantic";
  fallbackType: "none" | "ast" | "lexical" | "local_index";
  precision: "exact" | "approximate";
  confidence: number;
  totalExact: boolean;
  warnings: string[];
}

function stableText(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0;
}

function sanitizeMessage(error: unknown): string {
  const value = error instanceof Error ? error.message : String(error);
  return value
    .replace(/\b(?:api[_-]?key|token|secret|password)\s*[=:]\s*[^\s,;]+/giu, "[REDACTED]")
    .replace(/https:\/\/[^\s/@]+@/giu, "https://[REDACTED]@")
    .slice(0, 1_000);
}

function boundedWarnings(values: readonly string[]): string[] {
  return [...new Set(values.map((value) => sanitizeMessage(value).slice(0, MAX_WARNING_CHARS)))]
    .filter(Boolean)
    .slice(0, 12);
}

function isRange(value: unknown): value is CodeRange {
  if (!value || typeof value !== "object") return false;
  const range = value as Partial<CodeRange>;
  for (const position of [range.start, range.end]) {
    if (
      !position ||
      !Number.isSafeInteger(position.line) ||
      !Number.isSafeInteger(position.column) ||
      position.line < 1 ||
      position.column < 1
    ) return false;
  }
  return (
    range.end!.line > range.start!.line ||
    (range.end!.line === range.start!.line && range.end!.column >= range.start!.column)
  );
}

function normalizeLspPath(value: string): string | undefined {
  if (!value || value.includes("\0") || path.isAbsolute(value)) return undefined;
  const normalized = normalizeRepositoryPath(value).replace(/^\.\//u, "");
  if (
    !normalized ||
    normalized === "." ||
    normalized === ".." ||
    normalized.startsWith("../") ||
    path.posix.isAbsolute(normalized) ||
    /^[a-z]:\//iu.test(normalized)
  ) return undefined;
  return normalized;
}

function normalizeRelativePath(
  value: string,
  context: RuntimeToolExecutionContext,
): string {
  if (!value || value.includes("\0")) throw new Error(`${TOOL_NAME} path is invalid.`);
  const root = path.resolve(context.workspaceRoot);
  const absolute = context.moduleContext.paths.resolveWorkspace(value);
  const relative = path.relative(root, absolute);
  if (relative.startsWith("..") || path.isAbsolute(relative)) {
    throw new Error(`${TOOL_NAME} path escapes the workspace.`);
  }
  const normalized = normalizeRepositoryPath(relative).replace(/^\.\//u, "");
  if (!normalized || normalized === ".") throw new Error(`${TOOL_NAME} file scope requires a file path.`);
  return normalized;
}

function normalizeLanguages(values: string[] | undefined): string[] {
  const result = new Set<string>();
  for (const raw of values ?? []) {
    const value = raw.trim().toLocaleLowerCase("en-US");
    if (!value) continue;
    if (value === "ts" || value === "typescript") {
      result.add("typescript");
      result.add("typescriptreact");
    } else if (value === "tsx" || value === "typescriptreact") {
      result.add("typescriptreact");
    } else if (value === "js" || value === "javascript") {
      result.add("javascript");
      result.add("javascriptreact");
    } else if (value === "jsx" || value === "javascriptreact") {
      result.add("javascriptreact");
    } else {
      result.add(value);
    }
  }
  return [...result].sort(stableText);
}

function normalizeArgs(raw: CodeSymbolsArgs, context: RuntimeToolExecutionContext): NormalizedArgs {
  const scope = raw.scope ?? (raw.path ? "file" : "workspace");
  if (scope !== "file" && scope !== "workspace") throw new Error(`${TOOL_NAME} scope is invalid.`);
  if (scope === "workspace" && raw.path) {
    throw new Error(`${TOOL_NAME} path is only valid with file scope.`);
  }
  const query = raw.query?.trim().normalize("NFKC");
  if (raw.query !== undefined && !query) throw new Error(`${TOOL_NAME} query must be non-empty when supplied.`);
  if ((query?.length ?? 0) > 512) throw new Error(`${TOOL_NAME} query is too long.`);

  const kinds = [...new Set(raw.kinds ?? [])];
  if (kinds.some((kind) => !SYMBOL_KIND_SET.has(kind))) throw new Error(`${TOOL_NAME} symbol kind is invalid.`);
  const maxResults = raw.maxResults ?? 100;
  const maxResultChars = raw.maxResultChars ?? 40_000;
  if (!Number.isSafeInteger(maxResults) || maxResults < 1 || maxResults > 500) {
    throw new Error(`${TOOL_NAME} maxResults is invalid.`);
  }
  if (!Number.isSafeInteger(maxResultChars) || maxResultChars < 4_096 || maxResultChars > 200_000) {
    throw new Error(`${TOOL_NAME} maxResultChars is invalid.`);
  }
  if (raw.cursor && raw.cursor.length > 4_096) throw new Error(`${TOOL_NAME} cursor is invalid.`);

  return {
    scope,
    ...(scope === "file" ? { filePath: normalizeRelativePath(raw.path ?? "", context) } : {}),
    ...(query ? { query, normalizedQuery: query.toLocaleLowerCase("en-US") } : {}),
    kinds: kinds.sort(stableText),
    languages: normalizeLanguages(raw.languages),
    maxResults,
    maxResultChars,
    ...(raw.cursor ? { cursor: raw.cursor } : {}),
  };
}

function languageAllowed(language: string, filters: readonly string[]): boolean {
  return filters.length === 0 || filters.includes(language.toLocaleLowerCase("en-US"));
}

function symbolAllowed(
  symbol: Pick<CodeSymbol, "name" | "kind" | "language">,
  args: NormalizedArgs,
): boolean {
  if (args.kinds.length > 0 && !args.kinds.includes(symbol.kind)) return false;
  if (!languageAllowed(symbol.language, args.languages)) return false;
  if (args.normalizedQuery && !symbol.name.normalize("NFKC").toLocaleLowerCase("en-US").includes(args.normalizedQuery)) {
    return false;
  }
  return true;
}

function inRequestedScope(filePath: string, args: NormalizedArgs): boolean {
  return args.scope === "workspace" || filePath === args.filePath;
}

function sortSymbols(items: CodeSymbol[]): CodeSymbol[] {
  return items.sort((left, right) =>
    stableText(left.location.path, right.location.path) ||
    left.location.range.start.line - right.location.range.start.line ||
    left.location.range.start.column - right.location.range.start.column ||
    stableText(left.kind, right.kind) ||
    stableText(left.name, right.name) ||
    stableText(left.signature ?? "", right.signature ?? "")
  );
}

function collectFallbackSymbols(
  snapshot: LocalCodeIndexSnapshot,
  args: NormalizedArgs,
  extraWarnings: string[],
): CollectedSymbols {
  const items: CodeSymbol[] = [];
  let sawAst = false;
  let sawLexical = false;
  let bounded = false;
  let extractionTruncated = false;

  files: for (const file of snapshot.files) {
    if (!inRequestedScope(file.path, args) || !languageAllowed(file.language, args.languages)) continue;
    if (file.adapterId === "typescript-compiler-api-v1") sawAst = true;
    if (file.adapterId === "strict-utf8-lexical-v1") sawLexical = true;
    extractionTruncated ||= file.truncated.symbols || file.truncated.occurrences;

    for (const symbol of file.symbols) {
      if (!symbolAllowed(symbol, args)) continue;
      if (items.length >= MAX_COLLECTED_SYMBOLS) {
        bounded = true;
        break files;
      }
      items.push({
        name: symbol.name,
        kind: symbol.kind,
        language: symbol.language,
        location: symbol.location,
        ...(symbol.selectionRange ? { selectionRange: symbol.selectionRange } : {}),
        ...(symbol.containerName ? { containerName: symbol.containerName } : {}),
        ...(symbol.exported !== undefined ? { exported: symbol.exported } : {}),
        source: "ast",
        fallbackType: "ast",
        precision: "approximate",
        confidence: Math.min(symbol.confidence, 0.88),
        indexVersion: snapshot.indexVersion,
        stale: false,
        warnings: boundedWarnings([
          ...symbol.warnings,
          "Approximate AST symbol fallback; not language-server verified.",
        ]),
        ...(symbol.signature ? { signature: symbol.signature.slice(0, 800) } : {}),
      });
    }

    if (file.adapterId !== "strict-utf8-lexical-v1" || file.symbols.length > 0) continue;
    const seenNames = new Set<string>();
    for (const occurrence of file.occurrences) {
      if (seenNames.has(occurrence.normalizedName)) continue;
      const candidate: CodeSymbol = {
        name: occurrence.name.slice(0, 512),
        kind: "unknown",
        language: file.language,
        location: {
          path: file.path,
          language: file.language,
          contentHash: file.contentHash,
          range: occurrence.range,
        },
        selectionRange: occurrence.range,
        source: "lexical",
        fallbackType: "lexical",
        precision: "approximate",
        confidence: 0.25,
        indexVersion: snapshot.indexVersion,
        stale: false,
        warnings: ["Approximate first lexical identifier occurrence; not a verified declaration or definition."],
      };
      if (!symbolAllowed(candidate, args)) continue;
      seenNames.add(occurrence.normalizedName);
      if (items.length >= MAX_COLLECTED_SYMBOLS) {
        bounded = true;
        break files;
      }
      items.push(candidate);
    }
  }

  const containsAst = items.some((item) => item.source === "ast");
  const containsLexical = items.some((item) => item.source === "lexical");
  const effectiveAst = items.length > 0 ? containsAst : sawAst;
  const effectiveLexical = items.length > 0 ? containsLexical : sawLexical;
  const source: CollectedSymbols["source"] = effectiveAst && effectiveLexical
    ? "semantic"
    : effectiveAst
      ? "ast"
      : "lexical";
  const fallbackType: CollectedSymbols["fallbackType"] = source === "semantic"
    ? "local_index"
    : source;
  const confidence = items.length > 0
    ? Math.min(...items.map((item) => item.confidence))
    : (source === "ast" ? 0.88 : 0.25);
  const warnings = boundedWarnings([
    ...extraWarnings,
    ...(sawAst ? ["Language server unavailable or unusable; returned TypeScript compiler AST symbols."] : []),
    ...(sawLexical ? ["Some files only have lexical identifier candidates; these are not verified symbols."] : []),
    ...(snapshot.truncated ? ["The local code index reached a capacity limit; total is not exact."] : []),
    ...(extractionTruncated ? ["At least one indexed file reached a symbol or identifier extraction limit."] : []),
    ...(bounded ? [`Symbol collection stopped at ${MAX_COLLECTED_SYMBOLS} candidates.`] : []),
  ]);
  return {
    items: sortSymbols(items),
    source,
    fallbackType,
    precision: "approximate",
    confidence,
    totalExact: !snapshot.truncated && !extractionTruncated && !bounded,
    warnings,
  };
}

function provenanceForPage(
  items: readonly CodeSymbol[],
  collected: CollectedSymbols,
): Pick<CollectedSymbols, "source" | "fallbackType" | "precision" | "confidence"> {
  if (collected.precision === "exact") {
    return {
      source: "lsp",
      fallbackType: "none",
      precision: "exact",
      confidence: 1,
    };
  }
  const containsAst = items.some((item) => item.source === "ast");
  const containsLexical = items.some((item) => item.source === "lexical");
  if (containsAst && containsLexical) {
    return {
      source: "semantic",
      fallbackType: "local_index",
      precision: "approximate",
      confidence: Math.min(...items.map((item) => item.confidence)),
    };
  }
  if (containsAst) {
    return { source: "ast", fallbackType: "ast", precision: "approximate", confidence: 0.88 };
  }
  if (containsLexical) {
    return { source: "lexical", fallbackType: "lexical", precision: "approximate", confidence: 0.25 };
  }
  return {
    source: collected.source,
    fallbackType: collected.fallbackType,
    precision: collected.precision,
    confidence: collected.confidence,
  };
}

function boundedLspSymbol(
  symbol: LspCodeSymbol,
  filePath: string,
  contentHash: string,
  indexVersion: string,
  warnings: readonly string[],
): CodeSymbol {
  return {
    name: symbol.name.slice(0, 512),
    kind: symbol.kind,
    language: symbol.language.slice(0, 64),
    location: {
      path: filePath,
      range: symbol.location.range,
      language: symbol.language.slice(0, 64),
      contentHash,
    },
    ...(symbol.selectionRange ? { selectionRange: symbol.selectionRange } : {}),
    ...(symbol.containerName ? { containerName: symbol.containerName.slice(0, 512) } : {}),
    ...(symbol.signature ? { signature: symbol.signature.slice(0, 800) } : {}),
    ...(symbol.exported !== undefined ? { exported: symbol.exported } : {}),
    source: "lsp",
    fallbackType: "none",
    precision: "exact",
    confidence: 1,
    indexVersion,
    stale: false,
    warnings: boundedWarnings(warnings),
  };
}

async function collectLspSymbols(
  provider: CodeSymbolsLspProvider,
  index: LocalCodeIndex,
  snapshot: LocalCodeIndexSnapshot,
  args: NormalizedArgs,
  context: RuntimeToolExecutionContext,
): Promise<{
  snapshot: LocalCodeIndexSnapshot;
  result?: CollectedSymbols;
  fallbackWarnings: string[];
}> {
  let response: CodeSymbolsLspResult;
  try {
    response = await provider.listSymbols({
      workspaceRoot: context.workspaceRoot,
      scope: args.scope,
      ...(args.filePath ? { filePath: args.filePath } : {}),
      ...(args.query ? { query: args.query } : {}),
      kinds: [...args.kinds],
      languages: [...args.languages],
      indexVersion: snapshot.indexVersion,
      documentVersions: snapshot.files.map((file) => ({ path: file.path, contentHash: file.contentHash })),
      maxSymbols: MAX_COLLECTED_SYMBOLS,
      signal: context.signal,
    });
  } catch (error) {
    return {
      snapshot,
      fallbackWarnings: [`Language server symbol request failed: ${sanitizeMessage(error)}`],
    };
  }

  let validatedSnapshot: LocalCodeIndexSnapshot;
  try {
    await index.refresh({
      paths: args.scope === "file" ? [args.filePath!] : ["."],
      signal: context.signal,
    });
    validatedSnapshot = index.snapshot();
  } catch (error) {
    return {
      snapshot: index.snapshot(),
      fallbackWarnings: [
        `Post-LSP local freshness validation failed; exact symbols were rejected: ${sanitizeMessage(error)}`,
      ],
    };
  }

  if (
    !response ||
    typeof response !== "object" ||
    typeof response.available !== "boolean" ||
    !Array.isArray(response.symbols)
  ) {
    return {
      snapshot: validatedSnapshot,
      fallbackWarnings: ["Language server returned an invalid capability payload; exact symbols were rejected."],
    };
  }
  if (!response.available) {
    return {
      snapshot: validatedSnapshot,
      fallbackWarnings: [
        `Language server symbol capability unavailable${response.reason ? `: ${sanitizeMessage(response.reason)}` : "."}`,
      ],
    };
  }

  if (
    snapshot.stale ||
    validatedSnapshot.stale ||
    validatedSnapshot.workspaceId !== snapshot.workspaceId ||
    validatedSnapshot.indexVersion !== snapshot.indexVersion ||
    validatedSnapshot.fileFingerprint !== snapshot.fileFingerprint ||
    validatedSnapshot.repositoryFingerprint !== snapshot.repositoryFingerprint
  ) {
    return {
      snapshot: validatedSnapshot,
      fallbackWarnings: [
        "The local source snapshot changed while the language server request was running; exact symbols were rejected.",
      ],
    };
  }
  if (response.stale !== false || response.indexVersion !== snapshot.indexVersion) {
    return {
      snapshot: validatedSnapshot,
      fallbackWarnings: [
        "Language server freshness metadata was missing, stale, or did not match the validated local index; exact symbols were rejected.",
      ],
    };
  }

  const responseWarnings = Array.isArray(response.warnings)
    ? response.warnings.filter((value): value is string => typeof value === "string")
    : [];
  const files = new Map(validatedSnapshot.files.map((file) => [file.path, file]));
  const items: CodeSymbol[] = [];
  const rangesByFile = new Map<string, CodeRange[]>();
  let invalidFreshness = false;
  let malformed = false;
  let bounded = Boolean(response.truncated);
  for (const symbol of response.symbols.slice(0, MAX_COLLECTED_SYMBOLS + 1)) {
    if (!symbol || typeof symbol !== "object" || !symbol.location || typeof symbol.location !== "object") {
      malformed = true;
      break;
    }
    const filePath = typeof symbol.location.path === "string"
      ? normalizeLspPath(symbol.location.path)
      : undefined;
    if (!filePath) {
      malformed = true;
      break;
    }
    if (!inRequestedScope(filePath, args)) continue;
    const file = files.get(filePath);
    if (!file) continue; // Dependencies, generated files, ignored paths and protected files stay excluded.
    if (
      typeof symbol.name !== "string" ||
      !symbol.name ||
      !SYMBOL_KIND_SET.has(symbol.kind) ||
      typeof symbol.language !== "string" ||
      !symbol.language ||
      !isRange(symbol.location.range) ||
      (symbol.selectionRange !== undefined && !isRange(symbol.selectionRange)) ||
      (symbol.exported !== undefined && typeof symbol.exported !== "boolean")
    ) {
      malformed = true;
      break;
    }
    if (!symbol.location.contentHash || symbol.location.contentHash !== file.contentHash) {
      invalidFreshness = true;
      break;
    }
    if (!symbolAllowed(symbol, args)) continue;
    if (items.length >= MAX_COLLECTED_SYMBOLS) {
      bounded = true;
      break;
    }
    const ranges = rangesByFile.get(filePath) ?? [];
    ranges.push(symbol.location.range);
    if (symbol.selectionRange) ranges.push(symbol.selectionRange);
    rangesByFile.set(filePath, ranges);
    items.push(boundedLspSymbol(
      symbol,
      filePath,
      file.contentHash,
      validatedSnapshot.indexVersion,
      responseWarnings,
    ));
  }

  if (invalidFreshness) {
    return {
      snapshot: validatedSnapshot,
      fallbackWarnings: [
        "A language server target hash differed from the post-request local snapshot; all exact symbols were rejected.",
      ],
    };
  }
  if (malformed) {
    return {
      snapshot: validatedSnapshot,
      fallbackWarnings: ["Language server returned an invalid symbol payload; all exact symbols were rejected."],
    };
  }
  for (const [filePath, ranges] of rangesByFile) {
    if (!await index.validateRanges(filePath, ranges, context.signal)) {
      return {
        snapshot: index.snapshot(),
        fallbackWarnings: [
          "A language server symbol range was outside the current UTF-16 file boundaries; all exact symbols were rejected.",
        ],
      };
    }
  }

  return {
    snapshot: validatedSnapshot,
    result: {
      items: sortSymbols(items),
      source: "lsp",
      fallbackType: "none",
      precision: "exact",
      confidence: 1,
      totalExact: !validatedSnapshot.truncated && !bounded,
      warnings: boundedWarnings([
        ...responseWarnings,
        ...(validatedSnapshot.truncated
          ? ["The local freshness snapshot reached a capacity limit; total is not exact."]
          : []),
        ...(bounded ? [`Language server results were bounded at ${MAX_COLLECTED_SYMBOLS} symbols.`] : []),
      ]),
    },
    fallbackWarnings: [],
  };
}
function requestIdentity(args: NormalizedArgs, strategy: CollectedSymbols["source"]): Record<string, unknown> {
  return {
    scope: args.scope,
    filePath: args.filePath,
    query: args.query,
    kinds: args.kinds,
    languages: args.languages,
    strategy,
    resultOrderVersion: RESULT_ORDER_VERSION,
  };
}

function failure(
  context: RuntimeToolExecutionContext,
  code: string,
  message: string,
  extra: Record<string, unknown> = {},
): ToolResult {
  const body = {
    kind: TOOL_NAME,
    errorCode: code,
    message,
    automaticChangesApplied: false,
    ...extra,
  };
  const now = context.moduleContext.clock.now();
  return {
    toolName: TOOL_NAME,
    callId: context.callId,
    startedAt: now,
    endedAt: now,
    success: false,
    output: JSON.stringify(body, null, 2),
    structuredContent: body,
    error: message,
  };
}

export function createCodeSymbolsTool(options: CodeSymbolsToolOptions = {}): RuntimeToolSpec {
  const indexPromises = new Map<string, Promise<LocalCodeIndex>>();
  const acquireIndex = (workspaceRoot: string): Promise<LocalCodeIndex> => {
    const key = path.resolve(workspaceRoot);
    let pending = indexPromises.get(key);
    if (!pending) {
      pending = (options.openIndex ?? openLocalCodeIndex)(workspaceRoot).catch((error) => {
        indexPromises.delete(key);
        throw error;
      });
      indexPromises.set(key, pending);
    }
    return pending;
  };

  return {
    name: TOOL_NAME,
    displayName: "Code Symbols / 代码符号",
    description: "List file or workspace symbols with LSP-exact provenance when a fresh injected provider is available, otherwise explicitly labeled AST or lexical fallback results.",
    inputSchema: {
      type: "object",
      additionalProperties: false,
      properties: {
        scope: { type: "string", enum: ["file", "workspace"], default: "workspace" },
        path: { type: "string", minLength: 1, maxLength: 8_192 },
        query: { type: "string", minLength: 1, maxLength: 512 },
        kinds: {
          type: "array",
          maxItems: SYMBOL_KINDS.length,
          items: { type: "string", enum: [...SYMBOL_KINDS] },
        },
        languages: {
          type: "array",
          maxItems: 20,
          items: { type: "string", minLength: 1, maxLength: 64 },
        },
        maxResults: { type: "integer", minimum: 1, maximum: 500, default: 100 },
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
      keywords: [
        "list code symbols",
        "file outline",
        "workspace symbols",
        "show classes and functions",
        "代码符号",
        "文件大纲",
        "工作区符号",
        "列出类和函数",
      ],
      keywordGroups: [
        ["list", "symbols"],
        ["file", "outline"],
        ["workspace", "symbols"],
        ["列出", "符号"],
        ["文件", "大纲"],
      ],
    },
    resolveAccess: (_rawArgs, context) => {
      return [{
        kind: "filesystem_read" as const,
        paths: [context.paths.normalize(".")],
        reason: "Reconcile the repository-wide guarded local index; scope/path only filters returned symbols.",
      }];
    },
    execute: async (rawArgs, context) => {
      let args: NormalizedArgs;
      try {
        args = normalizeArgs(rawArgs as CodeSymbolsArgs, context);
      } catch (error) {
        return failure(context, "invalid_arguments", sanitizeMessage(error));
      }

      let index: LocalCodeIndex;
      let snapshot: LocalCodeIndexSnapshot;
      try {
        index = await acquireIndex(context.workspaceRoot);
        await index.refresh({
          paths: args.scope === "file" ? [args.filePath!] : ["."],
          signal: context.signal,
        });
        snapshot = index.snapshot();
      } catch (error) {
        return failure(context, "capability_unavailable", `Local symbol index is unavailable: ${sanitizeMessage(error)}`);
      }

      let collected: CollectedSymbols;
      if (options.lspProvider) {
        const lsp = await collectLspSymbols(options.lspProvider, index, snapshot, args, context);
        snapshot = lsp.snapshot;
        if (lsp.result) {
          collected = lsp.result;
        } else {
          try {
            await index.refresh({
              paths: args.scope === "file" ? [args.filePath!] : ["."],
              signal: context.signal,
            });
            snapshot = index.snapshot();
          } catch (error) {
            return failure(
              context,
              "capability_unavailable",
              `Local fallback index refresh failed after the language-server attempt: ${sanitizeMessage(error)}`,
              { fallbackWarnings: boundedWarnings(lsp.fallbackWarnings) },
            );
          }
          collected = collectFallbackSymbols(snapshot, args, lsp.fallbackWarnings);
        }
      } else {
        collected = collectFallbackSymbols(
          snapshot,
          args,
          ["No language-server provider is configured; using a labeled local fallback."],
        );
      }

      const requestDigest = createRequestDigest(requestIdentity(args, collected.source));
      const buildEnvelope = (
        items: CodeSymbol[],
        page: { cursor?: string; nextCursor?: string; hasMore: boolean; truncated: boolean },
      ): CodeSymbolsResult => {
        const provenance = provenanceForPage(items, collected);
        return ({
          scope: args.scope,
          ...(args.filePath ? { filePath: args.filePath } : {}),
          ...(args.query ? { query: args.query } : {}),
          source: provenance.source,
          fallbackType: provenance.fallbackType,
          precision: provenance.precision,
          confidence: provenance.confidence,
          indexVersion: snapshot.indexVersion,
          stale: false,
          warnings: collected.warnings,
          items,
          total: collected.items.length,
          totalExact: collected.totalExact,
          returned: items.length,
          ...(page.cursor ? { cursor: page.cursor } : {}),
          ...(page.nextCursor ? { nextCursor: page.nextCursor } : {}),
          hasMore: page.hasMore,
          truncated: page.truncated || !collected.totalExact,
          maxResultChars: args.maxResultChars,
          automaticChangesApplied: false,
        }) as CodeSymbolsResult;
      };
      let result: CodeSymbolsResult;
      try {
        result = paginateAuthoritativeItems({
          allItems: collected.items,
          cursor: args.cursor,
          binding: {
            workspaceId: snapshot.workspaceId,
            tool: TOOL_NAME,
            indexVersion: snapshot.indexVersion,
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
        return failure(context, "invalid_cursor", sanitizeMessage(error), { items: [] });
      }

      let artifact;
      try {
        artifact = await context.moduleContext.persistence.storeToolOutputArtifact({
          sessionId: context.sessionId,
          turnId: context.turnId,
          toolCallId: context.callId,
          sourceToolName: TOOL_NAME,
          fileName: `code-symbols-${context.callId}.json`,
          mimeType: "application/json",
          kind: "text",
          summary: `Recovery copy of ${result.returned} complete code_symbols items; the inline current page remains authoritative.`,
          content: JSON.stringify(result, null, 2),
          signal: context.signal,
        });
        const withArtifact = { ...result, artifactUri: artifact.uri };
        if (JSON.stringify(withArtifact, null, 2).length <= args.maxResultChars) result = withArtifact;
      } catch {
        // Persistence failure never replaces or truncates the authoritative inline page.
      }

      const now = context.moduleContext.clock.now();
      return {
        toolName: TOOL_NAME,
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
