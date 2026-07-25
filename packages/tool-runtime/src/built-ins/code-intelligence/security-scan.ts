import { createHash } from "node:crypto";
import { promises as fs } from "node:fs";
import path from "node:path";

import type {
  NormalizedFindingSeverity,
  SecurityFinding,
  SecurityFindingSource,
  SecurityScanResult,
  ToolAccessRequest,
  ToolResult,
} from "../../../../shared-schema/src/index.js";
import {
  isProtectedReadPath,
  normalizeRepositoryPath,
} from "../../repository-explorer.js";
import { redactProcessText } from "../../process-manager.js";
import type {
  RuntimeToolExecutionContext,
  RuntimeToolSpec,
  ToolModuleContext,
  ToolProcessResult,
} from "../../tool-module.js";
import {
  createRequestDigest,
  paginateAuthoritativeItems,
  ResultPageBudgetError,
} from "./pagination.js";

export interface StaticScannerProbe {
  available: boolean;
  name: string;
  command?: string;
  version?: string;
  message: string;
}

export interface StaticScannerRequest {
  workspaceRoot: string;
  paths: string[];
  rules: string[];
  timeoutMs: number;
  maxOutputChars: number;
  signal?: AbortSignal;
}

export interface StaticScannerResponse {
  name: string;
  version?: string;
  rawReport: string;
  exitCode: number | null;
  timedOut: boolean;
  outputTruncated: boolean;
  spawnError?: string;
}

export interface StaticScannerRunner {
  probe(context: ToolModuleContext): Promise<StaticScannerProbe>;
  scan(request: StaticScannerRequest, context: RuntimeToolExecutionContext): Promise<StaticScannerResponse>;
}

export interface SecurityScanToolOptions {
  scanner?: StaticScannerRunner;
}

interface SecurityScanArgs {
  scanner?: "semgrep";
  paths?: string[];
  rules: string[];
  timeoutMs?: number;
  maxResults?: number;
  maxResultChars?: number;
  maxEvidenceChars?: number;
  cursor?: string;
}

interface NormalizedArgs {
  scanner: "semgrep";
  paths: string[];
  rules: string[];
  timeoutMs: number;
  maxResults: number;
  maxResultChars: number;
  maxEvidenceChars: number;
  cursor?: string;
}

interface SemgrepReport {
  version?: unknown;
  results?: unknown;
  errors?: unknown;
}

interface SemgrepResult {
  check_id?: unknown;
  path?: unknown;
  start?: unknown;
  end?: unknown;
  extra?: unknown;
}

const MAX_RAW_REPORT_CHARS = 16 * 1024 * 1024;
const MAX_SCANNER_TARGET_BYTES = 2 * 1024 * 1024;
const MAX_FINDING_VALIDATION_SOURCE_BYTES = 128 * 1024 * 1024;
const FINDING_VALIDATION_DEADLINE_MS = 10_000;
const MAX_NORMALIZED_FINDINGS = 50_000;
const MAX_SCANNED_FILES = 10_000;
const SCAN_FORMAT_VERSION = "semgrep-json-v1";
const SECRET_PATTERN = /\b((?:(?:[a-z0-9]+)[_-])*(?:api[_-]?key|access[_-]?token|refresh[_-]?token|token|secret|secret[_-]?access[_-]?key|password|passwd|pwd|authorization|connection[_-]?string|accountkey|sharedaccesskey|sharedaccesssignature|github[_-]?pat))\s*([=:])\s*(?:"(?:\\.|[^"\r\n])*"|'(?:\\.|[^'\r\n])*'|[^\s,;}\]\r\n]+)/giu;
const URI_CREDENTIAL_PATTERN = /\b([a-z][a-z0-9+.-]*:\/\/)([^\s/@:]+)(?::[^\s/@]*)?@/giu;
const BEAR_PATTERN = /\b(Bearer)\s+[A-Za-z0-9._~+/=-]+/giu;
const BARE_JWT_PATTERN = /\beyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\b/gu;
const KNOWN_TOKEN_PATTERN = /\b(?:sk-(?:proj-)?[A-Za-z0-9_-]{16,}|gh[opusr]_[A-Za-z0-9]{20,}|github_pat_[A-Za-z0-9_]{20,}|xox[baprs]-[A-Za-z0-9-]{10,}|glpat-[A-Za-z0-9_-]{10,}|npm_[A-Za-z0-9]{20,}|(?:AKIA|ASIA)[A-Z0-9]{16})\b/gu;
const PEM_PATTERN = /-----BEGIN [A-Z0-9 ]*PRIVATE KEY-----[\s\S]*?-----END [A-Z0-9 ]*PRIVATE KEY-----/gu;
const SECRET_KEY_PATTERN = /(?:api[_-]?key|access[_-]?token|refresh[_-]?token|token|secret|password|passwd|pwd|authorization|connection[_-]?string|accountkey|sharedaccesskey|sharedaccesssignature)/iu;

function sha256(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}

function stableText(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0;
}

function canonicalFsPath(value: string): string {
  const normalized = path.resolve(value).replaceAll("\\", "/").replace(/\/+$/u, "");
  return process.platform === "win32" || process.platform === "darwin"
    ? normalized.toLocaleLowerCase("en-US")
    : normalized;
}

function sameFsPath(left: string, right: string): boolean {
  return canonicalFsPath(left) === canonicalFsPath(right);
}

function isDeepMixPath(relative: string): boolean {
  const normalized = process.platform === "win32" || process.platform === "darwin"
    ? relative.toLocaleLowerCase("en-US")
    : relative;
  return normalized === ".deep-mix" || normalized.startsWith(".deep-mix/");
}

function redact(value: string, maxChars = MAX_RAW_REPORT_CHARS): string {
  return redactProcessText(value
    .replace(PEM_PATTERN, "[REDACTED_PEM]")
    .replace(SECRET_PATTERN, "$1$2[REDACTED]")
    .replace(URI_CREDENTIAL_PATTERN, "$1[REDACTED]@")
    .replace(BEAR_PATTERN, "$1 [REDACTED]")
    .replace(BARE_JWT_PATTERN, "[REDACTED_JWT]")
    .replace(KNOWN_TOKEN_PATTERN, "[REDACTED_TOKEN]"))
    .slice(0, maxChars);
}

function redactJsonValue(value: unknown, depth = 0): unknown {
  if (depth > 32) return "[TRUNCATED_DEPTH]";
  if (typeof value === "string") return redact(value, 100_000);
  if (Array.isArray(value)) {
    return value.slice(0, 100_000).map((entry) => redactJsonValue(entry, depth + 1));
  }
  if (!value || typeof value !== "object") return value;
  return Object.fromEntries(
    Object.entries(value as Record<string, unknown>)
      .slice(0, 100_000)
      .map(([key, entry]) => [
        key,
        SECRET_KEY_PATTERN.test(key) ? "[REDACTED]" : redactJsonValue(entry, depth + 1),
      ]),
  );
}

function serializeRedactedReport(value: unknown): string {
  const redacted = redactJsonValue(value);
  if (redacted && typeof redacted === "object" && !Array.isArray(redacted)) {
    const root = redacted as Record<string, unknown>;
    if (Array.isArray(root.results)) {
      root.results = root.results.map((entry) => {
        if (!entry || typeof entry !== "object" || Array.isArray(entry)) return entry;
        const finding = entry as Record<string, unknown>;
        const extra = finding.extra && typeof finding.extra === "object" && !Array.isArray(finding.extra)
          ? finding.extra as Record<string, unknown>
          : {};
        const signal = `${typeof finding.check_id === "string" ? finding.check_id : ""} ${typeof extra.message === "string" ? extra.message : ""}`;
        if (!/secret|credential|token|password|private[_ -]?key/iu.test(signal)) return finding;
        return {
          check_id: finding.check_id,
          path: finding.path,
          start: finding.start,
          end: finding.end,
          extra: {
            message: "[REDACTED_SENSITIVE_MESSAGE]",
            severity: extra.severity,
            metadata: "[REDACTED_SENSITIVE_METADATA]",
            lines: "[REDACTED_SENSITIVE_EVIDENCE]",
            metavars: "[REDACTED_SENSITIVE_EVIDENCE]",
            dataflow_trace: "[REDACTED_SENSITIVE_EVIDENCE]",
            fixed_lines: "[REDACTED_SENSITIVE_EVIDENCE]",
          },
        };
      });
    }
  }
  const serialized = JSON.stringify(redacted, null, 2);
  if (serialized.length <= MAX_RAW_REPORT_CHARS) return serialized;
  return JSON.stringify({
    reportType: "semgrep_redacted_report_truncated",
    originalChars: serialized.length,
    sha256: sha256(serialized),
    prefix: serialized.slice(0, Math.floor(MAX_RAW_REPORT_CHARS / 2)),
  }, null, 2);
}

function safeError(error: unknown): string {
  return redact(error instanceof Error ? error.message : String(error), 1_000);
}

function asRecord(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown>
    : {};
}

function text(value: unknown, fallback = ""): string {
  return typeof value === "string" ? value : fallback;
}

function integer(value: unknown, fallback: number): number {
  return Number.isSafeInteger(value) && (value as number) >= 1 ? value as number : fallback;
}

function normalizeSeverity(raw: unknown): {
  severity: NormalizedFindingSeverity;
  rawSeverity?: string;
  severityNormalization: string;
} {
  const rawSeverity = text(raw).trim().slice(0, 100);
  const value = rawSeverity.toLocaleLowerCase("en-US");
  const mapping: Record<string, NormalizedFindingSeverity> = {
    critical: "critical",
    error: "high",
    high: "high",
    warning: "medium",
    warn: "medium",
    medium: "medium",
    info: "low",
    informational: "low",
    low: "low",
  };
  return {
    severity: mapping[value] ?? "unknown",
    ...(rawSeverity ? { rawSeverity } : {}),
    severityNormalization: rawSeverity
      ? `Mapped Semgrep severity '${rawSeverity}' using Deep-Mix normalization v1.`
      : "Semgrep severity was absent; normalized to unknown.",
  };
}

function inferLanguage(relativePath: string): string {
  const ext = path.extname(relativePath).toLocaleLowerCase("en-US");
  const known: Record<string, string> = {
    ".ts": "typescript",
    ".tsx": "typescriptreact",
    ".js": "javascript",
    ".jsx": "javascriptreact",
    ".mjs": "javascript",
    ".cjs": "javascript",
    ".py": "python",
    ".go": "go",
    ".rs": "rust",
    ".java": "java",
    ".cs": "csharp",
    ".c": "c",
    ".cc": "cpp",
    ".cpp": "cpp",
    ".h": "c",
    ".hpp": "cpp",
  };
  return known[ext] ?? "text";
}

async function normalizeWorkspacePath(
  raw: string,
  context: Pick<RuntimeToolExecutionContext, "workspaceRoot" | "moduleContext">,
  kind: "scan" | "rule",
): Promise<string> {
  const absolute = context.moduleContext.paths.resolveWorkspace(raw);
  const relative = normalizeRepositoryPath(path.relative(context.workspaceRoot, absolute)) || ".";
  if (relative === ".." || relative.startsWith("../") || path.isAbsolute(relative)) {
    throw new Error(`${kind} path escapes the workspace.`);
  }
  const protectedRelative = process.platform === "win32" || process.platform === "darwin"
    ? relative.toLocaleLowerCase("en-US")
    : relative;
  if (
    isProtectedReadPath(relative) ||
    protectedRelative === ".deep-mix" ||
    protectedRelative.startsWith(".deep-mix/")
  ) throw new Error(`${kind} path is protected.`);
  if (relative.startsWith("-")) throw new Error(`${kind} path cannot begin with '-'.`);
  const stat = await fs.lstat(absolute);
  if (stat.isSymbolicLink()) throw new Error(`${kind} path cannot be a symbolic link or junction.`);
  if (kind === "rule" && !stat.isFile()) throw new Error("Semgrep rules must be local files.");
  if (kind === "scan" && !stat.isFile() && !stat.isDirectory()) {
    throw new Error("Security scan paths must be files or directories.");
  }
  const realRoot = await fs.realpath(context.workspaceRoot);
  const real = await fs.realpath(absolute);
  const escaped = path.relative(realRoot, real);
  if (escaped === ".." || escaped.startsWith(`..${path.sep}`) || path.isAbsolute(escaped)) {
    throw new Error(`${kind} path escapes the workspace through a link.`);
  }
  if (!sameFsPath(real, relative === "." ? realRoot : path.resolve(realRoot, relative))) {
    throw new Error(`${kind} path traverses a symbolic link or junction.`);
  }
  return relative;
}

async function normalizeArgs(
  raw: SecurityScanArgs,
  context: RuntimeToolExecutionContext,
): Promise<NormalizedArgs> {
  if (!Array.isArray(raw.rules) || raw.rules.length < 1 || raw.rules.length > 20) {
    throw new Error("security_scan requires 1..20 explicit local Semgrep rule files.");
  }
  if ((raw.paths?.length ?? 1) > 100) throw new Error("security_scan accepts at most 100 paths.");
  const rules = [...new Set(await Promise.all(raw.rules.map((entry) =>
    normalizeWorkspacePath(entry, context, "rule")
  )))].sort(stableText);
  const paths = [...new Set(await Promise.all((raw.paths?.length ? raw.paths : ["."]).map((entry) =>
    normalizeWorkspacePath(entry, context, "scan")
  )))].sort(stableText);
  const result: NormalizedArgs = {
    scanner: raw.scanner ?? "semgrep",
    rules,
    paths,
    timeoutMs: raw.timeoutMs ?? 60_000,
    maxResults: raw.maxResults ?? 100,
    maxResultChars: raw.maxResultChars ?? 60_000,
    maxEvidenceChars: raw.maxEvidenceChars ?? 600,
    ...(raw.cursor ? { cursor: raw.cursor } : {}),
  };
  if (!Number.isSafeInteger(result.timeoutMs) || result.timeoutMs < 1_000 || result.timeoutMs > 300_000) {
    throw new Error("security_scan timeoutMs must be between 1000 and 300000.");
  }
  if (!Number.isSafeInteger(result.maxResults) || result.maxResults < 1 || result.maxResults > 500) {
    throw new Error("security_scan maxResults must be between 1 and 500.");
  }
  if (!Number.isSafeInteger(result.maxResultChars) || result.maxResultChars < 4_096 || result.maxResultChars > 200_000) {
    throw new Error("security_scan maxResultChars must be between 4096 and 200000.");
  }
  if (!Number.isSafeInteger(result.maxEvidenceChars) || result.maxEvidenceChars < 40 || result.maxEvidenceChars > 2_000) {
    throw new Error("security_scan maxEvidenceChars must be between 40 and 2000.");
  }
  return result;
}

function parseStringArray(value: unknown): string[] {
  if (typeof value === "string") return [value];
  return Array.isArray(value)
    ? value.filter((entry): entry is string => typeof entry === "string")
    : [];
}

function normalizeCwe(metadata: Record<string, unknown>): string[] | undefined {
  const values = [
    ...parseStringArray(metadata.cwe),
    ...parseStringArray(metadata.CWE),
  ].flatMap((entry) => entry.match(/CWE-\d+/giu) ?? [])
    .map((entry) => entry.toLocaleUpperCase("en-US"));
  return values.length ? [...new Set(values)].sort(stableText).slice(0, 20) : undefined;
}

interface ValidatedScanScope {
  realPath: string;
  isFile: boolean;
}

interface ValidatedFindingFile {
  relative: string;
  lineColumnCeilings: number[];
}

interface FindingPathValidationContext {
  realRoot: string;
  scopes: ValidatedScanScope[];
  cache: Map<string, Promise<ValidatedFindingFile | undefined>>;
  signal?: AbortSignal;
  deadlineAt: number;
  sourceBytes: number;
  sourceCapacityExceeded: boolean;
}

class FindingValidationInterruptedError extends Error {
  public constructor(
    public readonly code: "normalization_cancelled" | "normalization_timeout",
    message: string,
  ) {
    super(message);
    this.name = "FindingValidationInterruptedError";
  }
}

function throwIfFindingValidationInterrupted(validation: FindingPathValidationContext): void {
  if (validation.signal?.aborted) {
    throw new FindingValidationInterruptedError("normalization_cancelled", "Security finding normalization was cancelled.");
  }
  if (Date.now() > validation.deadlineAt) {
    throw new FindingValidationInterruptedError("normalization_timeout", "Security finding normalization exceeded its 10 second safety deadline.");
  }
}

function pathIsWithin(parent: string, child: string): boolean {
  const relative = path.relative(parent, child);
  return relative === "" || (
    relative !== ".." &&
    !relative.startsWith(`..${path.sep}`) &&
    !path.isAbsolute(relative)
  );
}

async function createFindingPathValidationContext(
  workspaceRoot: string,
  requestedPaths: readonly string[],
  signal?: AbortSignal,
): Promise<FindingPathValidationContext> {
  const realRoot = await fs.realpath(workspaceRoot);
  const scopes: ValidatedScanScope[] = [];
  const validation: FindingPathValidationContext = {
    realRoot, scopes, cache: new Map(), signal, deadlineAt: Date.now() + FINDING_VALIDATION_DEADLINE_MS,
    sourceBytes: 0, sourceCapacityExceeded: false,
  };
  for (const relative of requestedPaths) {
    throwIfFindingValidationInterrupted(validation);
    const absolute = relative === "." ? workspaceRoot : path.resolve(workspaceRoot, relative);
    try {
      const stat = await fs.lstat(absolute);
      if (stat.isSymbolicLink() || (!stat.isFile() && !stat.isDirectory())) continue;
      const realPath = await fs.realpath(absolute);
      const expected = relative === "." ? realRoot : path.resolve(realRoot, relative);
      if (!sameFsPath(realPath, expected) || !pathIsWithin(realRoot, realPath)) continue;
      scopes.push({ realPath, isFile: stat.isFile() });
    } catch {
      // A scope removed or replaced while the scanner ran cannot authorize findings.
    }
  }
  return validation;
}

async function validateFindingFile(
  rawPathValue: unknown,
  workspaceRoot: string,
  validation: FindingPathValidationContext,
): Promise<ValidatedFindingFile | undefined> {
  throwIfFindingValidationInterrupted(validation);
  const rawPath = text(rawPathValue).replace(/\\/gu, "/");
  if (!rawPath) return undefined;
  const absolute = path.isAbsolute(rawPath) ? path.resolve(rawPath) : path.resolve(workspaceRoot, rawPath);
  const relative = normalizeRepositoryPath(path.relative(workspaceRoot, absolute));
  if (
    !relative ||
    relative === "." ||
    relative === ".." ||
    relative.startsWith("../") ||
    path.isAbsolute(relative) ||
    isProtectedReadPath(relative) ||
    isDeepMixPath(relative)
  ) return undefined;

  const cacheKey = canonicalFsPath(absolute);
  const cached = validation.cache.get(cacheKey);
  if (cached) return cached;
  if (validation.cache.size >= MAX_SCANNED_FILES) return undefined;

  const pending = (async (): Promise<ValidatedFindingFile | undefined> => {
    try {
      throwIfFindingValidationInterrupted(validation);
      const stat = await fs.lstat(absolute);
      if (stat.isSymbolicLink() || !stat.isFile() || stat.size > MAX_SCANNER_TARGET_BYTES) return undefined;
      const realPath = await fs.realpath(absolute);
      if (
        !pathIsWithin(validation.realRoot, realPath) ||
        !sameFsPath(realPath, path.resolve(validation.realRoot, relative))
      ) return undefined;
      const authorized = validation.scopes.some((scope) =>
        scope.isFile ? sameFsPath(scope.realPath, realPath) : pathIsWithin(scope.realPath, realPath)
      );
      if (!authorized) return undefined;
      const realRelative = normalizeRepositoryPath(path.relative(validation.realRoot, realPath));
      if (!realRelative || isProtectedReadPath(realRelative) || isDeepMixPath(realRelative)) return undefined;
      if (validation.sourceBytes + stat.size > MAX_FINDING_VALIDATION_SOURCE_BYTES) {
        validation.sourceCapacityExceeded = true;
        return undefined;
      }
      validation.sourceBytes += stat.size;
      throwIfFindingValidationInterrupted(validation);
      const bytes = await fs.readFile(realPath, { signal: validation.signal });
      if (bytes.byteLength > stat.size) {
        const growth = bytes.byteLength - stat.size;
        if (validation.sourceBytes + growth > MAX_FINDING_VALIDATION_SOURCE_BYTES) {
          validation.sourceCapacityExceeded = true;
          return undefined;
        }
        validation.sourceBytes += growth;
      }
      throwIfFindingValidationInterrupted(validation);
      if (bytes.includes(0)) return undefined;
      let content: string;
      try {
        content = new TextDecoder("utf-8", { fatal: true }).decode(bytes);
      } catch {
        return undefined;
      }
      const lineColumnCeilings = content.split(/\r\n|\n|\r/u).map((line) => line.length + 1);
      return { relative: realRelative, lineColumnCeilings };
    } catch (error) {
      if (error instanceof FindingValidationInterruptedError) throw error;
      if (error instanceof Error && error.name === "AbortError") {
        throw new FindingValidationInterruptedError(
          "normalization_cancelled",
          "Security finding normalization was cancelled.",
        );
      }
      return undefined;
    }
  })();
  validation.cache.set(cacheKey, pending);
  return pending;
}

function normalizeFinding(
  raw: SemgrepResult,
  file: ValidatedFindingFile,
  index: number,
  source: SecurityFindingSource,
  maxEvidenceChars: number,
): SecurityFinding | undefined {
  const relative = file.relative;
  const start = asRecord(raw.start);
  const end = asRecord(raw.end);
  const extra = asRecord(raw.extra);
  const metadata = asRecord(extra.metadata);
  const ruleId = redact(text(raw.check_id, `semgrep-unknown-${index}`), 300);
  const rawMessage = redact(text(extra.message, "Semgrep reported a security finding."), 1_000);
  const sensitiveRule = /secret|credential|token|password|private[_ -]?key/iu.test(`${ruleId} ${rawMessage}`);
  const message = sensitiveRule
    ? "Sensitive static-analysis finding; interpolated details were redacted."
    : rawMessage;
  const evidenceRaw = text(extra.lines, rawMessage);
  const evidence = sensitiveRule
    ? "[REDACTED_SENSITIVE_EVIDENCE]"
    : redact(evidenceRaw, maxEvidenceChars);
  const severity = normalizeSeverity(extra.severity);
  const startLine = integer(start.line, 0);
  const startColumn = integer(start.col, 0);
  const endLine = integer(end.line, 0);
  const endColumn = integer(end.col, 0);
  if (
    startLine < 1 || startColumn < 1 || endLine < startLine || endColumn < 1 ||
    (endLine === startLine && endColumn < startColumn) ||
    endLine > file.lineColumnCeilings.length ||
    startColumn > (file.lineColumnCeilings[startLine - 1] ?? 0) ||
    endColumn > (file.lineColumnCeilings[endLine - 1] ?? 0)
  ) return undefined;
  const location = {
    path: relative,
    language: inferLanguage(relative),
    range: {
      start: { line: startLine, column: startColumn },
      end: { line: endLine, column: endColumn },
    },
  };
  const fingerprint = sha256(JSON.stringify({
    ruleId,
    path: relative,
    range: location.range,
    message,
  }));
  const cwe = normalizeCwe(metadata);
  const recommendationMetadata = text(metadata.remediation) || text(metadata.recommendation);
  const recommendation = sensitiveRule
    ? "Review this sensitive-data finding, move the value to an approved secret store, and rotate it if exposure is possible."
    : redact(
      recommendationMetadata || `Review ${ruleId} at the reported location and apply a manually reviewed remediation.`,
      1_000,
    );
  return {
    id: `semgrep:${fingerprint.slice(0, 24)}`,
    ruleId,
    title: message.slice(0, 240),
    ...severity,
    location,
    evidence: {
      summary: evidence || "[REDACTED OR EMPTY EVIDENCE]",
      ...(evidence ? { snippet: evidence } : {}),
      redacted: sensitiveRule || evidence !== evidenceRaw,
    },
    recommendation,
    source,
    confidence: 0.9,
    ...(cwe ? { cwe } : {}),
    fingerprint,
  };
}

function severityRank(value: NormalizedFindingSeverity): number {
  return { critical: 6, high: 5, medium: 4, low: 3, info: 2, unknown: 1 }[value];
}

async function normalizeReport(
  parsed: SemgrepReport,
  workspaceRoot: string,
  requestedPaths: readonly string[],
  source: SecurityFindingSource,
  maxEvidenceChars: number,
  signal?: AbortSignal,
): Promise<{ items: SecurityFinding[]; warnings: string[]; totalExact: boolean; version?: string }> {
  if (!Array.isArray(parsed.results)) {
    throw new Error("Semgrep report does not contain a results array.");
  }
  if (parsed.errors !== undefined && !Array.isArray(parsed.errors)) {
    throw new Error("Semgrep report errors field is malformed.");
  }
  const rawItems = parsed.results;
  const pathValidation = await createFindingPathValidationContext(workspaceRoot, requestedPaths, signal);
  const byFingerprint = new Map<string, SecurityFinding>();
  let truncated = false;
  let dropped = 0;
  for (let index = 0; index < rawItems.length; index += 1) {
    throwIfFindingValidationInterrupted(pathValidation);
    if (byFingerprint.size >= MAX_NORMALIZED_FINDINGS) {
      truncated = true;
      break;
    }
    const rawFinding = rawItems[index] as SemgrepResult;
    const file = await validateFindingFile(rawFinding.path, workspaceRoot, pathValidation);
    const finding = file
      ? normalizeFinding(rawFinding, file, index, source, maxEvidenceChars)
      : undefined;
    if (!finding) {
      dropped += 1;
      continue;
    }
    const previous = byFingerprint.get(finding.fingerprint);
    if (!previous || severityRank(finding.severity) > severityRank(previous.severity)) {
      byFingerprint.set(finding.fingerprint, finding);
    }
  }
  let items = [...byFingerprint.values()].sort((left, right) =>
    severityRank(right.severity) - severityRank(left.severity) ||
    stableText(left.location.path, right.location.path) ||
    left.location.range.start.line - right.location.range.start.line ||
    left.location.range.start.column - right.location.range.start.column ||
    stableText(left.ruleId, right.ruleId) ||
    stableText(left.fingerprint, right.fingerprint)
  );
  const files = new Set<string>();
  items = items.filter((item) => {
    if (files.has(item.location.path)) return true;
    if (files.size >= MAX_SCANNED_FILES) {
      truncated = true;
      return false;
    }
    files.add(item.location.path);
    return true;
  });
  const errors = Array.isArray(parsed.errors) ? parsed.errors.length : 0;
  return {
    items,
    totalExact: !truncated && dropped === 0 && errors === 0,
    warnings: [
      ...(errors ? [`Semgrep reported ${errors} scanner error(s); inspect the raw artifact.`] : []),
      ...(dropped ? [`Dropped ${dropped} malformed, protected, out-of-scope, missing, linked, or unlocatable finding(s); total is not exact.`] : []),
      ...(pathValidation.sourceCapacityExceeded ? ["Finding validation reached the 128 MiB source-read capacity; total is not exact."] : []),
      ...(truncated ? ["Normalized findings reached a safety capacity; total is not exact."] : []),
    ],
    ...(typeof parsed.version === "string" ? { version: parsed.version } : {}),
  };
}

function failure(
  context: RuntimeToolExecutionContext,
  status: "unavailable" | "degraded",
  code: string,
  message: string,
  extra: Record<string, unknown> = {},
): ToolResult {
  const body = {
    kind: "security_scan",
    status,
    errorCode: code,
    message,
    scannerInstallAttempted: false,
    patchesApplied: false,
    automaticChangesApplied: false,
    ...extra,
  };
  const now = context.moduleContext.clock.now();
  return {
    toolName: "security_scan",
    callId: context.callId,
    startedAt: now,
    endedAt: now,
    success: false,
    output: JSON.stringify(body, null, 2),
    structuredContent: body,
    error: message,
  };
}

export const defaultSemgrepScanner: StaticScannerRunner = {
  async probe(context) {
    const capability = await context.capabilities.get("semgrep");
    return {
      available: capability?.available === true,
      name: "semgrep",
      ...(capability?.command ? { command: capability.command } : {}),
      ...(capability?.version ? { version: capability.version } : {}),
      message: capability?.message ?? "Semgrep capability has not been detected.",
    };
  },
  async scan(request, context) {
    const capability = await context.moduleContext.capabilities.get("semgrep");
    const command = capability?.command || "semgrep";
    const cliPath = (value: string): string => value === "." ? "." : `./${value}`;
    const args = [
      "--json",
      "--metrics=off",
      "--disable-version-check",
      `--max-target-bytes=${MAX_SCANNER_TARGET_BYTES}`,
      "--exclude=.deep-mix/**",
      "--exclude=.git/**",
      "--exclude=node_modules/**",
    ];
    for (const rule of request.rules) args.push("--config", cliPath(rule));
    args.push("--", ...request.paths.map(cliPath));
    const result: ToolProcessResult = await context.moduleContext.processes.run({
      command,
      args,
      mode: "direct",
      cwd: request.workspaceRoot,
      timeoutMs: request.timeoutMs,
      maxOutputChars: request.maxOutputChars,
      signal: request.signal,
    });
    return {
      name: "semgrep",
      ...(capability?.version ? { version: capability.version } : {}),
      rawReport: result.stdout,
      exitCode: result.exitCode,
      timedOut: result.timedOut,
      outputTruncated: result.outputTruncated === true,
      ...(result.spawnError ? { spawnError: result.spawnError.message } : {}),
    };
  },
};

export function createSecurityScanTool(options: SecurityScanToolOptions = {}): RuntimeToolSpec {
  const scanner = options.scanner ?? defaultSemgrepScanner;
  return {
    name: "security_scan",
    displayName: "Security Scan / 安全扫描",
    description: "Run a configured trusted static scanner and return normalized, deduplicated, report-only findings. Never installs scanners, applies fixes, or modifies source files.",
    inputSchema: {
      type: "object",
      additionalProperties: false,
      required: ["rules"],
      properties: {
        scanner: { type: "string", enum: ["semgrep"], default: "semgrep" },
        paths: { type: "array", maxItems: 100, items: { type: "string", minLength: 1, maxLength: 8_192 } },
        rules: { type: "array", minItems: 1, maxItems: 20, items: { type: "string", minLength: 1, maxLength: 8_192 } },
        timeoutMs: { type: "integer", minimum: 1_000, maximum: 300_000, default: 60_000 },
        maxResults: { type: "integer", minimum: 1, maximum: 500, default: 100 },
        maxResultChars: { type: "integer", minimum: 4_096, maximum: 200_000, default: 60_000 },
        maxEvidenceChars: { type: "integer", minimum: 40, maximum: 2_000, default: 600 },
        cursor: { type: "string", minLength: 1, maxLength: 4_096 },
      },
    },
    readOnly: true,
    permissionCategory: "execute_command",
    sideEffectLevel: "low",
    timeoutCategory: "slow",
    groups: ["security", "audit", "code-intelligence"],
    selection: {
      groups: ["security", "audit"],
      keywords: ["security scan", "security risk", "static analysis", "semgrep", "vulnerability in source", "source vulnerability", "安全扫描", "安全风险", "静态扫描", "代码安全"],
      keywordGroups: [["security", "source"], ["scan", "code"], ["代码", "安全"]],
    },
    resolveAccess: (rawArgs, context): ToolAccessRequest[] => {
      const args = rawArgs as SecurityScanArgs;
      const readPaths = [...(args.paths?.length ? args.paths : ["."]), ...(args.rules ?? [])]
        .map((entry) => context.paths.normalize(entry));
      return [{
        kind: "filesystem_read",
        paths: [...new Set(readPaths)].sort(stableText),
        reason: "Read explicitly scoped source paths and local static-analysis rules.",
      }, {
        kind: "command_execute",
        cwd: context.paths.normalize("."),
        command: "semgrep --json --metrics=off --disable-version-check [explicit local configs and scopes]",
        reason: "Run the probed Semgrep scanner in report-only mode.",
      }];
    },
    redactArguments: (rawArgs) => ({
      ...(rawArgs as SecurityScanArgs),
      rules: (rawArgs as SecurityScanArgs).rules?.map((entry) => path.basename(entry)),
    }),
    resolveExecutionTimeoutMs: (rawArgs) => Math.min(315_000, ((rawArgs as SecurityScanArgs).timeoutMs ?? 60_000) + 15_000),
    execute: async (rawArgs, context) => {
      let args: NormalizedArgs;
      try {
        args = await normalizeArgs(rawArgs as SecurityScanArgs, context);
      } catch (error) {
        return failure(context, "unavailable", "invalid_arguments", safeError(error));
      }
      let probe: StaticScannerProbe;
      try {
        probe = await scanner.probe(context.moduleContext);
      } catch (error) {
        return failure(context, "unavailable", "capability_unavailable", safeError(error));
      }
      if (!probe.available) {
        return failure(
          context,
          "unavailable",
          "capability_unavailable",
          `${redact(probe.message, 500)} The scanner was not installed automatically.`,
          { scanner: probe.name },
        );
      }
      let response: StaticScannerResponse;
      try {
        response = await scanner.scan({
          workspaceRoot: context.workspaceRoot,
          paths: args.paths,
          rules: args.rules,
          timeoutMs: args.timeoutMs,
          maxOutputChars: MAX_RAW_REPORT_CHARS,
          signal: context.signal,
        }, context);
      } catch (error) {
        return failure(context, "degraded", "scanner_failed", safeError(error), { scanner: probe.name });
      }
      if (response.timedOut) {
        return failure(context, "degraded", "timeout", "The static scanner exceeded the approved timeout.", { scanner: response.name });
      }
      if (response.spawnError) {
        return failure(context, "unavailable", "capability_unavailable", redact(response.spawnError, 500), { scanner: response.name });
      }
      if (response.outputTruncated) {
        return failure(context, "degraded", "report_truncated", "The raw scanner report exceeded the safety limit and was not parsed as authoritative.", { scanner: response.name });
      }
      const scannerName = redact(response.name || probe.name || "semgrep", 120);
      let parsedReport: SemgrepReport | undefined;
      let redactedRaw: string;
      try {
        const parsed = JSON.parse(response.rawReport) as unknown;
        if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
          throw new Error("Semgrep JSON root must be an object.");
        }
        parsedReport = parsed as SemgrepReport;
        redactedRaw = serializeRedactedReport(parsed);
      } catch {
        redactedRaw = JSON.stringify({
          reportType: "invalid_semgrep_json",
          redactedText: redact(response.rawReport, 1_000_000),
        }, null, 2);
      }
      let artifact;
      try {
        artifact = await context.moduleContext.persistence.storeToolOutputArtifact({
          sessionId: context.sessionId,
          turnId: context.turnId,
          toolCallId: context.callId,
          sourceToolName: "security_scan",
          fileName: `security-scan-${context.callId}.json`,
          mimeType: "application/json",
          kind: "text",
          summary: "Redacted raw static-scanner report; the normalized current page remains authoritative.",
          content: redactedRaw,
          signal: context.signal,
        });
      } catch (error) {
        return failure(context, "degraded", "artifact_unavailable", `Could not persist the required redacted raw report: ${safeError(error)}`, { scanner: scannerName });
      }
      const sourceVersion = (response.version ?? probe.version)?.slice(0, 200);
      const source: SecurityFindingSource = {
        name: scannerName,
        kind: "static_scanner",
        ...(sourceVersion ? { version: sourceVersion } : {}),
        reportArtifactUri: artifact.uri,
      };
      if (!parsedReport) {
        const result = failure(context, "degraded", "invalid_report", "Semgrep did not return a valid JSON object.", { scanner: scannerName, artifactUri: artifact.uri });
        result.artifacts = [artifact];
        return result;
      }
      let normalized;
      try {
        normalized = await normalizeReport(
          parsedReport, context.workspaceRoot, args.paths, source, args.maxEvidenceChars, context.signal,
        );
      } catch (error) {
        const code = error instanceof FindingValidationInterruptedError ? error.code : "invalid_report";
        const result = failure(
          context, "degraded", code, safeError(error), { scanner: scannerName, artifactUri: artifact.uri },
        );
        result.artifacts = [artifact];
        return result;
      }
      const workspaceId = sha256(await fs.realpath(context.workspaceRoot));
      const reportVersion = `${SCAN_FORMAT_VERSION}.${sha256(redactedRaw)}`;
      const cleanExit = response.exitCode === 0;
      const warnings = [
        ...normalized.warnings,
        ...(!cleanExit
          ? [`Semgrep exited with code ${response.exitCode ?? "unknown"}; results are degraded and may be incomplete.`]
          : []),
      ];
      const totalExact = normalized.totalExact && cleanExit;
      const requestDigest = createRequestDigest({
        scanner: args.scanner,
        paths: args.paths,
        rules: args.rules,
        timeoutMs: args.timeoutMs,
        maxEvidenceChars: args.maxEvidenceChars,
        format: SCAN_FORMAT_VERSION,
      });
      const buildEnvelope = (
        items: SecurityFinding[],
        page: { cursor?: string; nextCursor?: string; hasMore: boolean; truncated: boolean },
      ): SecurityScanResult => ({
        kind: "security_scan",
        status: warnings.length ? "degraded" : "available",
        scanner: scannerName,
        source,
        items,
        total: normalized.items.length,
        totalExact,
        returned: items.length,
        ...(page.cursor ? { cursor: page.cursor } : {}),
        ...(page.nextCursor ? { nextCursor: page.nextCursor } : {}),
        hasMore: page.hasMore,
        truncated: page.truncated || !totalExact,
        maxResultChars: args.maxResultChars,
        warnings: [...new Set(warnings)].slice(0, 20),
        artifactUri: artifact.uri,
        scannerInstallAttempted: false,
        patchesApplied: false,
        automaticChangesApplied: false,
      });
      let result: SecurityScanResult;
      try {
        result = paginateAuthoritativeItems({
          allItems: normalized.items,
          cursor: args.cursor,
          binding: {
            workspaceId,
            tool: "security_scan",
            indexVersion: reportVersion,
            requestDigest,
          },
          maxItems: args.maxResults,
          maxResultChars: args.maxResultChars,
          buildEnvelope,
        }).envelope;
      } catch (error) {
        const code = error instanceof ResultPageBudgetError ? "result_budget_too_small" : "invalid_cursor";
        const failed = failure(context, "degraded", code, safeError(error), { scanner: scannerName, artifactUri: artifact.uri });
        failed.artifacts = [artifact];
        return failed;
      }
      const now = context.moduleContext.clock.now();
      return {
        toolName: "security_scan",
        callId: context.callId,
        startedAt: now,
        endedAt: now,
        success: true,
        output: JSON.stringify(result, null, 2),
        structuredContent: result,
        artifacts: [artifact],
      };
    },
  };
}
