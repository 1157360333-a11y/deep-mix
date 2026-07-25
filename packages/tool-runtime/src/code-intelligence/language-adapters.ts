import { createHash } from "node:crypto";
import path from "node:path";
import ts from "typescript";

import type {
  CodeRange,
  CodeRelationKind,
  CodeSymbolKind,
} from "../../../shared-schema/src/index.js";
import type {
  IndexedCodeSnippet,
  IndexedCodeSymbol,
  IndexedIdentifierOccurrence,
  IndexedToken,
  LanguageAdapter,
  LanguageAdapterContext,
  LanguageExtraction,
} from "./contracts.js";

export const TYPESCRIPT_FAMILY_EXTENSIONS = Object.freeze([
  ".ts",
  ".tsx",
  ".mts",
  ".cts",
  ".js",
  ".jsx",
  ".mjs",
  ".cjs",
]);

const MAX_TOKEN_LENGTH = 128;
const MAX_SNIPPET_TOKENS = 96;

function sha256(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}

function compareStableText(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0;
}

function throwIfInterrupted(context: LanguageAdapterContext): void {
  if (context.signal?.aborted) {
    if (context.signal.reason instanceof Error) throw context.signal.reason;
    throw new Error(typeof context.signal.reason === "string" ? context.signal.reason : "Code indexing was aborted.");
  }
  if (Date.now() >= context.deadlineAt) {
    throw new Error("Code index build duration limit exceeded.");
  }
}

class TextCoordinateMap {
  private readonly lineStarts: number[] = [0];

  public constructor(private readonly content: string) {
    for (let index = 0; index < content.length; index += 1) {
      const code = content.charCodeAt(index);
      if (code === 13 && content.charCodeAt(index + 1) === 10) {
        index += 1;
        this.lineStarts.push(index + 1);
      } else if (code === 10 || code === 13) {
        this.lineStarts.push(index + 1);
      }
    }
  }

  private position(offset: number): { line: number; column: number } {
    const bounded = Math.max(0, Math.min(offset, this.content.length));
    let low = 0;
    let high = this.lineStarts.length;
    while (low + 1 < high) {
      const middle = Math.floor((low + high) / 2);
      if ((this.lineStarts[middle] ?? 0) <= bounded) low = middle;
      else high = middle;
    }
    return {
      line: low + 1,
      column: bounded - (this.lineStarts[low] ?? 0) + 1,
    };
  }

  public range(start: number, end: number): CodeRange {
    return {
      start: this.position(start),
      end: this.position(Math.max(start, end)),
    };
  }
}

function compactText(value: string, maxChars: number): string {
  const compact = value.replace(/\s+/gu, " ").trim();
  if (compact.length <= maxChars) return compact;
  return `${compact.slice(0, Math.max(0, maxChars - 1))}…`;
}

/** Stable local search terms; this is tokenization, not an embedding call. */
export function normalizeSearchTokens(value: string): string[] {
  const separated = value
    .replace(/([a-z\d])([A-Z])/g, "$1 $2")
    .replace(/([A-Z]+)([A-Z][a-z])/g, "$1 $2")
    .replace(/[^\p{L}\p{N}_$]+/gu, " ");
  const tokens = new Set<string>();
  for (const part of separated.split(/[\s_$]+/u)) {
    const normalized = part.normalize("NFKC").toLocaleLowerCase("en-US");
    if (!normalized || normalized.length > MAX_TOKEN_LENGTH) continue;
    tokens.add(normalized);
  }
  const whole = value.normalize("NFKC").toLocaleLowerCase("en-US");
  if (/^[\p{L}\p{N}_$]+$/u.test(whole) && whole.length <= MAX_TOKEN_LENGTH) tokens.add(whole);
  return [...tokens].sort(compareStableText);
}

function scanWords(content: string): IterableIterator<RegExpExecArray> {
  return content.matchAll(/[\p{L}_$][\p{L}\p{N}_$\u200c\u200d]*/gu);
}

function buildTokenFrequencies(
  context: LanguageAdapterContext,
): { tokens: IndexedToken[]; truncated: boolean } {
  const frequencies = new Map<string, number>();
  let occurrenceCount = 0;
  let truncated = false;
  tokenScan: for (const match of scanWords(context.content)) {
    if ((occurrenceCount & 0xff) === 0) throwIfInterrupted(context);
    for (const token of normalizeSearchTokens(match[0])) {
      if (occurrenceCount >= context.limits.maxTokenOccurrencesPerFile) {
        truncated = true;
        break tokenScan;
      }
      occurrenceCount += 1;
      if (!frequencies.has(token) && frequencies.size >= context.limits.maxUniqueTokensPerFile) {
        truncated = true;
        continue;
      }
      frequencies.set(token, (frequencies.get(token) ?? 0) + 1);
    }
  }
  return {
    tokens: [...frequencies.entries()]
      .sort(([left], [right]) => compareStableText(left, right))
      .map(([token, count]) => ({ token, count })),
    truncated,
  };
}

function snippetTokens(text: string): string[] {
  const tokens = new Set<string>();
  for (const match of scanWords(text)) {
    for (const token of normalizeSearchTokens(match[0])) {
      tokens.add(token);
      if (tokens.size >= MAX_SNIPPET_TOKENS) return [...tokens].sort(compareStableText);
    }
  }
  return [...tokens].sort(compareStableText);
}

function createSnippet(
  context: LanguageAdapterContext,
  coordinates: TextCoordinateMap,
  start: number,
  end: number,
  text: string,
  symbol?: IndexedCodeSymbol,
): IndexedCodeSnippet {
  const boundedText = text.length <= context.limits.maxSnippetChars
    ? text
    : `${text.slice(0, Math.max(0, context.limits.maxSnippetChars - 1))}…`;
  return {
    snippetId: sha256(
      `${context.relativePath}\0${context.contentHash}\0${start}\0${end}\0${symbol?.symbolId ?? "chunk"}`,
    ),
    text: boundedText,
    location: {
      path: context.relativePath,
      language: symbol?.language ?? "text",
      contentHash: context.contentHash,
      range: coordinates.range(start, end),
    },
    tokens: snippetTokens(boundedText),
    ...(symbol ? { symbolId: symbol.symbolId, symbolName: symbol.name } : {}),
  };
}

function chunkSnippets(
  context: LanguageAdapterContext,
  coordinates: TextCoordinateMap,
  language: string,
): { snippets: IndexedCodeSnippet[]; truncated: boolean } {
  const snippets: IndexedCodeSnippet[] = [];
  let start = 0;
  let truncated = false;
  while (start < context.content.length) {
    throwIfInterrupted(context);
    if (snippets.length >= context.limits.maxSnippetsPerFile) {
      truncated = true;
      break;
    }
    let end = Math.min(context.content.length, start + context.limits.maxSnippetChars);
    if (end < context.content.length) {
      const newline = Math.max(context.content.lastIndexOf("\n", end), context.content.lastIndexOf("\r", end));
      if (newline > start + Math.floor(context.limits.maxSnippetChars / 2)) end = newline + 1;
    }
    const text = context.content.slice(start, end);
    if (/\S/u.test(text)) {
      const snippet = createSnippet(context, coordinates, start, end, text);
      snippet.location.language = language;
      snippets.push(snippet);
    }
    start = Math.max(start + 1, end);
  }
  return { snippets, truncated };
}

function languageForTypeScriptPath(relativePath: string): string {
  switch (path.extname(relativePath).toLocaleLowerCase("en-US")) {
    case ".tsx":
      return "typescriptreact";
    case ".jsx":
      return "javascriptreact";
    case ".js":
    case ".mjs":
    case ".cjs":
      return "javascript";
    default:
      return "typescript";
  }
}

function scriptKindForPath(relativePath: string): ts.ScriptKind {
  switch (path.extname(relativePath).toLocaleLowerCase("en-US")) {
    case ".js":
    case ".mjs":
    case ".cjs":
      return ts.ScriptKind.JS;
    case ".jsx":
      return ts.ScriptKind.JSX;
    case ".tsx":
      return ts.ScriptKind.TSX;
    default:
      return ts.ScriptKind.TS;
  }
}

function symbolKind(node: ts.Node): CodeSymbolKind | undefined {
  if (ts.isClassDeclaration(node) || ts.isClassExpression(node)) return "class";
  if (ts.isInterfaceDeclaration(node)) return "interface";
  if (ts.isTypeAliasDeclaration(node)) return "type";
  if (ts.isEnumDeclaration(node)) return "enum";
  if (ts.isEnumMember(node)) return "enum_member";
  if (ts.isModuleDeclaration(node)) {
    return node.flags & ts.NodeFlags.Namespace ? "namespace" : "module";
  }
  if (ts.isFunctionDeclaration(node) || ts.isFunctionExpression(node)) return "function";
  if (ts.isMethodDeclaration(node) || ts.isMethodSignature(node)) return "method";
  if (ts.isConstructorDeclaration(node)) return "constructor";
  if (ts.isPropertyDeclaration(node)) return "field";
  if (ts.isPropertySignature(node) || ts.isPropertyAssignment(node)) return "property";
  if (ts.isParameter(node)) return "parameter";
  if (ts.isVariableDeclaration(node)) {
    if (node.initializer && (ts.isArrowFunction(node.initializer) || ts.isFunctionExpression(node.initializer))) {
      return "function";
    }
    const list = ts.isVariableDeclarationList(node.parent) ? node.parent : undefined;
    return list && (list.flags & ts.NodeFlags.Const) !== 0 ? "constant" : "variable";
  }
  if (
    ts.isImportClause(node) ||
    ts.isImportSpecifier(node) ||
    ts.isNamespaceImport(node) ||
    ts.isImportEqualsDeclaration(node)
  ) return "import";
  if (ts.isExportSpecifier(node)) return "export";
  return undefined;
}

function declarationNameNode(node: ts.Node): ts.DeclarationName | undefined {
  const candidate = (node as ts.NamedDeclaration).name;
  if (!candidate) return undefined;
  return ts.isIdentifier(candidate) ||
    ts.isPrivateIdentifier(candidate) ||
    ts.isStringLiteral(candidate) ||
    ts.isNumericLiteral(candidate) ||
    ts.isComputedPropertyName(candidate)
    ? candidate
    : undefined;
}

function nameText(node: ts.DeclarationName, sourceFile: ts.SourceFile): string {
  if (
    ts.isIdentifier(node) ||
    ts.isPrivateIdentifier(node) ||
    ts.isStringLiteral(node) ||
    ts.isNumericLiteral(node)
  ) return node.text;
  return compactText(node.getText(sourceFile), 160);
}

function containerName(node: ts.Node, sourceFile: ts.SourceFile): string | undefined {
  let current = node.parent;
  while (current && !ts.isSourceFile(current)) {
    const kind = symbolKind(current);
    const name = declarationNameNode(current);
    if (kind && name) return nameText(name, sourceFile);
    current = current.parent;
  }
  return undefined;
}

function hasExportModifier(node: ts.Node): boolean {
  let current: ts.Node | undefined = node;
  while (current && !ts.isSourceFile(current)) {
    if (ts.canHaveModifiers(current)) {
      const modifiers = ts.getModifiers(current);
      if (modifiers?.some((modifier) =>
        modifier.kind === ts.SyntaxKind.ExportKeyword || modifier.kind === ts.SyntaxKind.DefaultKeyword
      )) return true;
    }
    if (!ts.isVariableDeclaration(current) && !ts.isVariableDeclarationList(current)) break;
    current = current.parent;
  }
  return false;
}

function signatureText(node: ts.Node, sourceFile: ts.SourceFile): string | undefined {
  let end = node.getEnd();
  if (
    ts.isFunctionDeclaration(node) ||
    ts.isFunctionExpression(node) ||
    ts.isMethodDeclaration(node) ||
    ts.isConstructorDeclaration(node) ||
    ts.isGetAccessorDeclaration(node) ||
    ts.isSetAccessorDeclaration(node) ||
    ts.isArrowFunction(node)
  ) {
    if (node.body) end = node.body.getStart(sourceFile);
  }
  if ((ts.isClassDeclaration(node) || ts.isClassExpression(node)) && node.members.pos > node.getStart(sourceFile)) {
    end = Math.min(end, node.members.pos);
  }
  const signature = compactText(sourceFile.text.slice(node.getStart(sourceFile), end), 320);
  return signature || undefined;
}

function isDeclarationIdentifier(node: ts.Identifier): boolean {
  const parent = node.parent;
  if (!parent) return false;
  if (!symbolKind(parent)) return false;
  const name = declarationNameNode(parent);
  return name === node;
}

function referenceTarget(node: ts.Identifier): ts.Node {
  const parent = node.parent;
  if (parent && ts.isPropertyAccessExpression(parent) && parent.name === node) return parent;
  return node;
}

function relationForIdentifier(node: ts.Identifier): CodeRelationKind {
  if (isDeclarationIdentifier(node)) return "declaration";
  const target = referenceTarget(node);
  const parent = target.parent;
  if (parent && ts.isBinaryExpression(parent) && parent.left === target) {
    const operator = parent.operatorToken.kind;
    if (operator >= ts.SyntaxKind.FirstAssignment && operator <= ts.SyntaxKind.LastAssignment) {
      return "reference_write";
    }
  }
  if (
    parent &&
    (ts.isPrefixUnaryExpression(parent) || ts.isPostfixUnaryExpression(parent)) &&
    (parent.operator === ts.SyntaxKind.PlusPlusToken || parent.operator === ts.SyntaxKind.MinusMinusToken)
  ) return "reference_write";
  return "reference_read";
}

function astExtraction(context: LanguageAdapterContext): LanguageExtraction {
  const language = languageForTypeScriptPath(context.relativePath);
  const sourceFile = ts.createSourceFile(
    context.relativePath,
    context.content,
    ts.ScriptTarget.Latest,
    true,
    scriptKindForPath(context.relativePath),
  );
  const coordinates = new TextCoordinateMap(context.content);
  const symbols: IndexedCodeSymbol[] = [];
  const occurrences: IndexedIdentifierOccurrence[] = [];
  let symbolsTruncated = false;
  let occurrencesTruncated = false;
  let visited = 0;

  const visit = (node: ts.Node): void => {
    visited += 1;
    if ((visited & 0xff) === 0) throwIfInterrupted(context);

    const kind = symbolKind(node);
    const nameNode = kind ? declarationNameNode(node) : undefined;
    if (kind && nameNode) {
      if (symbols.length >= context.limits.maxSymbolsPerFile) {
        symbolsTruncated = true;
      } else {
        const start = node.getStart(sourceFile);
        const end = node.getEnd();
        const selectionStart = nameNode.getStart(sourceFile);
        const selectionEnd = nameNode.getEnd();
        const name = nameText(nameNode, sourceFile);
        symbols.push({
          symbolId: sha256(
            `${context.relativePath}\0${context.contentHash}\0${kind}\0${name}\0${start}\0${end}`,
          ),
          name,
          kind,
          language,
          location: {
            path: context.relativePath,
            language,
            contentHash: context.contentHash,
            range: coordinates.range(start, end),
          },
          selectionRange: coordinates.range(selectionStart, selectionEnd),
          containerName: containerName(node, sourceFile),
          signature: signatureText(node, sourceFile),
          exported: hasExportModifier(node),
          source: "ast",
          fallbackType: "ast",
          precision: "approximate",
          confidence: 0.88,
          indexVersion: context.indexVersion,
          stale: false,
          warnings: ["Approximate TypeScript compiler AST fallback; not LSP-verified."],
        });
      }
    }

    if (ts.isIdentifier(node)) {
      if (occurrences.length >= context.limits.maxIdentifierOccurrencesPerFile) {
        occurrencesTruncated = true;
      } else {
        occurrences.push({
          name: node.text,
          normalizedName: node.text.normalize("NFKC").toLocaleLowerCase("en-US"),
          range: coordinates.range(node.getStart(sourceFile), node.getEnd()),
          relation: relationForIdentifier(node),
          source: "ast",
          fallbackType: "ast",
          precision: "approximate",
          confidence: 0.82,
        });
      }
    }
    ts.forEachChild(node, visit);
  };
  visit(sourceFile);
  throwIfInterrupted(context);

  symbols.sort((left, right) =>
    left.location.range.start.line - right.location.range.start.line ||
    left.location.range.start.column - right.location.range.start.column ||
    compareStableText(left.kind, right.kind) ||
    compareStableText(left.name, right.name)
  );
  occurrences.sort((left, right) =>
    left.range.start.line - right.range.start.line ||
    left.range.start.column - right.range.start.column ||
    compareStableText(left.name, right.name)
  );

  const chunkResult = chunkSnippets(context, coordinates, language);
  const snippets = chunkResult.snippets;
  const seenSnippetIds = new Set(snippets.map((snippet) => snippet.snippetId));
  for (const symbol of symbols) {
    if (snippets.length >= context.limits.maxSnippetsPerFile) break;
    const startPosition = sourceFile.getPositionOfLineAndCharacter(
      symbol.location.range.start.line - 1,
      symbol.location.range.start.column - 1,
    );
    const rawEnd = Math.min(context.content.length, startPosition + context.limits.maxSnippetChars);
    const snippet = createSnippet(
      context,
      coordinates,
      startPosition,
      rawEnd,
      context.content.slice(startPosition, rawEnd),
      symbol,
    );
    if (!seenSnippetIds.has(snippet.snippetId)) {
      snippets.push(snippet);
      seenSnippetIds.add(snippet.snippetId);
    }
  }
  snippets.sort((left, right) =>
    left.location.range.start.line - right.location.range.start.line ||
    left.location.range.start.column - right.location.range.start.column ||
    compareStableText(left.snippetId, right.snippetId)
  );

  const tokenResult = buildTokenFrequencies(context);
  return {
    language,
    symbols,
    snippets,
    tokens: tokenResult.tokens,
    occurrences,
    truncated: {
      symbols: symbolsTruncated,
      snippets: chunkResult.truncated,
      tokens: tokenResult.truncated,
      occurrences: occurrencesTruncated,
    },
  };
}

export class TypeScriptLanguageAdapter implements LanguageAdapter {
  public readonly id = "typescript-compiler-api-v1";

  public readonly priority = 100;

  public supports(relativePath: string): boolean {
    return TYPESCRIPT_FAMILY_EXTENSIONS.includes(
      path.extname(relativePath).toLocaleLowerCase("en-US") as typeof TYPESCRIPT_FAMILY_EXTENSIONS[number],
    );
  }

  public extract(context: LanguageAdapterContext): LanguageExtraction {
    throwIfInterrupted(context);
    return astExtraction(context);
  }
}

export class LexicalLanguageAdapter implements LanguageAdapter {
  public readonly id = "strict-utf8-lexical-v1";

  public readonly priority = -1_000;

  public supports(_relativePath: string): boolean {
    return true;
  }

  public extract(context: LanguageAdapterContext): LanguageExtraction {
    throwIfInterrupted(context);
    const coordinates = new TextCoordinateMap(context.content);
    const occurrences: IndexedIdentifierOccurrence[] = [];
    let occurrencesTruncated = false;
    let inspected = 0;
    for (const match of scanWords(context.content)) {
      inspected += 1;
      if ((inspected & 0xff) === 0) throwIfInterrupted(context);
      if (occurrences.length >= context.limits.maxIdentifierOccurrencesPerFile) {
        occurrencesTruncated = true;
        break;
      }
      const name = match[0];
      occurrences.push({
        name,
        normalizedName: name.normalize("NFKC").toLocaleLowerCase("en-US"),
        range: coordinates.range(match.index, match.index + name.length),
        relation: "reference_unknown",
        source: "lexical",
        fallbackType: "lexical",
        precision: "approximate",
        confidence: 0.35,
      });
    }
    const tokenResult = buildTokenFrequencies(context);
    const chunkResult = chunkSnippets(context, coordinates, "text");
    return {
      language: "text",
      symbols: [],
      snippets: chunkResult.snippets,
      tokens: tokenResult.tokens,
      occurrences,
      truncated: {
        symbols: false,
        snippets: chunkResult.truncated,
        tokens: tokenResult.truncated,
        occurrences: occurrencesTruncated,
      },
    };
  }
}

export class LanguageAdapterRegistry {
  private readonly adapters: LanguageAdapter[] = [];

  public constructor(adapters: LanguageAdapter[] = []) {
    for (const adapter of adapters) this.register(adapter);
  }

  public register(adapter: LanguageAdapter): void {
    if (this.adapters.some((existing) => existing.id === adapter.id)) {
      throw new Error(`Language adapter is already registered: ${adapter.id}`);
    }
    this.adapters.push(adapter);
    this.adapters.sort((left, right) => right.priority - left.priority || compareStableText(left.id, right.id));
  }

  public resolve(relativePath: string): LanguageAdapter | undefined {
    return this.adapters.find((adapter) => adapter.supports(relativePath));
  }

  public list(): readonly LanguageAdapter[] {
    return [...this.adapters];
  }
}

export function createDefaultLanguageAdapterRegistry(
  additionalAdapters: LanguageAdapter[] = [],
): LanguageAdapterRegistry {
  return new LanguageAdapterRegistry([
    ...additionalAdapters,
    new TypeScriptLanguageAdapter(),
    new LexicalLanguageAdapter(),
  ]);
}
