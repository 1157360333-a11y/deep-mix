import { createHash } from "node:crypto";
import { promises as fs } from "node:fs";
import path from "node:path";

import type {
  ToolOutputArtifact,
  ToolResult,
  ToolStructuredError,
} from "../../../../shared-schema/src/index.js";
import { redactProcessText, summarizeProcessCommand } from "../../process-manager.js";
import type {
  RuntimeToolExecutionContext,
  RuntimeToolSpec,
  ToolAccessResolutionContext,
  ToolProcessResult,
} from "../../tool-module.js";

type CoverageMetricName = "lines" | "branches" | "functions" | "statements";

interface CoverageThresholds {
  lines?: number;
  branches?: number;
  functions?: number;
  statements?: number;
}

interface TestCoverageArguments {
  command?: string;
  args?: string[];
  cwd?: string;
  timeoutMs?: number;
  reportPath?: string;
  thresholds?: CoverageThresholds;
}

interface CoverageInvocation {
  file: string;
  args: string[];
  source: "explicit" | "package_script";
  scriptName?: string;
  commandSummary: string;
}

interface NormalizedCoverageMetric {
  pct: number | null;
  covered: number | null;
  total: number | null;
  skipped: number | null;
}

type NormalizedCoverageMetrics = Record<CoverageMetricName, NormalizedCoverageMetric>;

interface BoundedReport {
  content: string;
  truncated: boolean;
  mimeType: string;
  source: "coverage_summary_json" | "command_output";
  workspaceRelativePath?: string;
  fingerprint?: CoverageReportFingerprint;
}

interface CoverageReportFingerprint {
  sizeBytes: number;
  mtimeMs: number;
  sha256: string;
}

const TEST_COVERAGE_SCHEMA = {
  type: "object",
  additionalProperties: false,
  properties: {
    command: { type: "string", minLength: 1, maxLength: 4096 },
    args: {
      type: "array",
      maxItems: 128,
      items: { type: "string", minLength: 1, maxLength: 8192 },
    },
    cwd: { type: "string" },
    timeoutMs: { type: "integer", minimum: 1000, maximum: 300000 },
    reportPath: { type: "string", minLength: 1, maxLength: 2048 },
    thresholds: {
      type: "object",
      additionalProperties: false,
      properties: {
        lines: { type: "number", minimum: 0, maximum: 100 },
        branches: { type: "number", minimum: 0, maximum: 100 },
        functions: { type: "number", minimum: 0, maximum: 100 },
        statements: { type: "number", minimum: 0, maximum: 100 },
      },
    },
  },
} as const;

const COVERAGE_METRIC_NAMES = ["lines", "branches", "functions", "statements"] as const;
const DEFAULT_REPORT_PATH = "coverage/coverage-summary.json";
const MAX_REPORT_BYTES = 2_000_000;
const MAX_PROCESS_OUTPUT_CHARS = 2_000_000;
const MAX_KEY_ERRORS = 20;

class CoverageCapabilityError extends Error {
  public readonly code = "ERR_TOOL_MISSING_DEPENDENCY";

  public constructor(message: string) {
    super(message);
    this.name = "CoverageCapabilityError";
  }
}

function normalizeRelative(value: string): string {
  return value.replace(/\\/gu, "/") || ".";
}

function emptyMetric(): NormalizedCoverageMetric {
  return { pct: null, covered: null, total: null, skipped: null };
}

function emptyMetrics(): NormalizedCoverageMetrics {
  return {
    lines: emptyMetric(),
    branches: emptyMetric(),
    functions: emptyMetric(),
    statements: emptyMetric(),
  };
}

function finiteNumber(value: unknown): number | null {
  const parsed = typeof value === "number" ? value : typeof value === "string" ? Number(value) : Number.NaN;
  return Number.isFinite(parsed) ? parsed : null;
}

function validPercentage(value: unknown): number | null {
  const parsed = finiteNumber(value);
  if (parsed === null || parsed < 0 || parsed > 100) return null;
  return parsed;
}

function validCount(value: unknown): number | null {
  const parsed = finiteNumber(value);
  if (parsed === null || parsed < 0) return null;
  return parsed;
}

function normalizeMetric(value: unknown): NormalizedCoverageMetric {
  if (!value || typeof value !== "object" || Array.isArray(value)) return emptyMetric();
  const raw = value as Record<string, unknown>;
  const covered = validCount(raw.covered);
  const total = validCount(raw.total);
  const skipped = validCount(raw.skipped);
  const declaredPct = validPercentage(raw.pct);
  const pct =
    declaredPct ??
    (covered !== null && total !== null
      ? total === 0
        ? 100
        : Math.round((covered / total) * 10_000) / 100
      : null);
  return { pct, covered, total, skipped };
}

function parseCoverageSummaryJson(content: string): NormalizedCoverageMetrics | undefined {
  try {
    const parsed = JSON.parse(content) as unknown;
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return undefined;
    const root = parsed as Record<string, unknown>;
    const total = root.total;
    if (!total || typeof total !== "object" || Array.isArray(total)) return undefined;
    const rawMetrics = total as Record<string, unknown>;
    const metrics = emptyMetrics();
    for (const name of COVERAGE_METRIC_NAMES) metrics[name] = normalizeMetric(rawMetrics[name]);
    return hasCoverageMetrics(metrics) ? metrics : undefined;
  } catch {
    return undefined;
  }
}

function splitTableLine(line: string): string[] {
  return line.split("|").map((column) => column.trim());
}

function tableColumnIndex(headers: readonly string[], metric: CoverageMetricName): number {
  const patterns: Record<CoverageMetricName, RegExp> = {
    lines: /(?:%\s*)?lines?/iu,
    branches: /(?:%\s*)?branches?/iu,
    functions: /(?:%\s*)?(?:funcs?|functions?)/iu,
    statements: /(?:%\s*)?(?:stmts?|statements?)/iu,
  };
  return headers.findIndex((header) => patterns[metric].test(header));
}

function parseCoverageTable(content: string): NormalizedCoverageMetrics | undefined {
  const lines = content.split(/\r?\n/u);
  for (let index = 0; index < lines.length; index += 1) {
    const headerLine = lines[index] ?? "";
    if (!headerLine.includes("|") || !/(?:%\s*)?(?:stmts?|statements?|lines?)/iu.test(headerLine)) continue;
    const headers = splitTableLine(headerLine);
    const row = lines.slice(index + 1).find((line) => /^\s*(?:all files|total)\s*\|/iu.test(line));
    if (!row) continue;
    const columns = splitTableLine(row);
    const metrics = emptyMetrics();
    for (const name of COVERAGE_METRIC_NAMES) {
      const columnIndex = tableColumnIndex(headers, name);
      if (columnIndex < 0) continue;
      metrics[name] = {
        ...emptyMetric(),
        pct: validPercentage((columns[columnIndex] ?? "").replace(/%/gu, "").trim()),
      };
    }
    if (hasCoverageMetrics(metrics)) return metrics;
  }
  return undefined;
}

function parseCoverageLabels(content: string): NormalizedCoverageMetrics | undefined {
  const patterns: Record<CoverageMetricName, RegExp> = {
    lines: /\blines?\s*[:=]\s*([0-9]+(?:\.[0-9]+)?)\s*%?(?:\s*\(\s*(\d+)\s*\/\s*(\d+)\s*\))?/iu,
    branches: /\bbranches?\s*[:=]\s*([0-9]+(?:\.[0-9]+)?)\s*%?(?:\s*\(\s*(\d+)\s*\/\s*(\d+)\s*\))?/iu,
    functions: /\bfunctions?\s*[:=]\s*([0-9]+(?:\.[0-9]+)?)\s*%?(?:\s*\(\s*(\d+)\s*\/\s*(\d+)\s*\))?/iu,
    statements: /\bstatements?\s*[:=]\s*([0-9]+(?:\.[0-9]+)?)\s*%?(?:\s*\(\s*(\d+)\s*\/\s*(\d+)\s*\))?/iu,
  };
  const metrics = emptyMetrics();
  for (const name of COVERAGE_METRIC_NAMES) {
    const match = patterns[name].exec(content);
    if (!match) continue;
    metrics[name] = {
      pct: validPercentage(match[1]),
      covered: validCount(match[2]),
      total: validCount(match[3]),
      skipped: null,
    };
  }
  return hasCoverageMetrics(metrics) ? metrics : undefined;
}

function parseCoverageText(content: string): NormalizedCoverageMetrics | undefined {
  return parseCoverageTable(content) ?? parseCoverageLabels(content);
}

function hasCoverageMetrics(metrics: NormalizedCoverageMetrics): boolean {
  return COVERAGE_METRIC_NAMES.some((name) => metrics[name].pct !== null);
}

async function readPackageScripts(
  cwd: string,
  workspaceRoot: string,
  paths: ToolAccessResolutionContext["paths"],
): Promise<Record<string, string>> {
  try {
    const relativePath = normalizeRelative(path.relative(workspaceRoot, path.join(cwd, "package.json")));
    const source = await paths.resolveReadable(relativePath);
    const parsed = JSON.parse((await source.readBytes()).toString("utf8")) as {
      scripts?: Record<string, unknown>;
    };
    return Object.fromEntries(
      Object.entries(parsed.scripts ?? {}).filter((entry): entry is [string, string] => typeof entry[1] === "string"),
    );
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return {};
    throw new CoverageCapabilityError(`Cannot inspect package.json coverage scripts: ${(error as Error).message}`);
  }
}

async function resolveCoverageInvocation(
  args: TestCoverageArguments,
  context: ToolAccessResolutionContext | RuntimeToolExecutionContext,
): Promise<CoverageInvocation> {
  if (args.command) {
    const commandArgs = args.args ?? [];
    return {
      file: args.command,
      args: commandArgs,
      source: "explicit",
      commandSummary: summarizeProcessCommand(args.command, commandArgs),
    };
  }
  const services = "moduleContext" in context ? context.moduleContext : context;
  const cwd = services.paths.resolveWorkspace(args.cwd ?? ".");
  const scripts = await readPackageScripts(cwd, context.workspaceRoot, services.paths);
  const scriptName = ["test:coverage", "coverage"].find((candidate) => typeof scripts[candidate] === "string");
  if (!scriptName) {
    throw new CoverageCapabilityError(
      "No trusted test:coverage or coverage package script was found; provide an explicit coverage executable and argument list.",
    );
  }
  const npm = await services.capabilities.get("npm");
  if (!npm?.available) {
    throw new CoverageCapabilityError("The trusted package coverage script requires npm, but npm is unavailable.");
  }
  const commandArgs = ["run", scriptName];
  return {
    file: npm.command,
    args: commandArgs,
    source: "package_script",
    scriptName,
    commandSummary: summarizeProcessCommand(npm.command, commandArgs),
  };
}

function resolveReportLocation(
  args: TestCoverageArguments,
  context: ToolAccessResolutionContext | RuntimeToolExecutionContext,
): { absolutePath: string; relativePath: string } {
  const services = "moduleContext" in context ? context.moduleContext : context;
  const cwd = services.paths.resolveWorkspace(args.cwd ?? ".");
  const absolutePath = path.resolve(cwd, args.reportPath ?? DEFAULT_REPORT_PATH);
  const relativePath = path.relative(context.workspaceRoot, absolutePath);
  if (relativePath.startsWith("..") || path.isAbsolute(relativePath)) {
    throw new Error("Coverage report path escapes the workspace root.");
  }
  return { absolutePath, relativePath: normalizeRelative(relativePath) };
}

async function readBoundedCoverageReport(
  context: RuntimeToolExecutionContext,
  relativePath: string,
): Promise<BoundedReport | undefined> {
  let resolved;
  try {
    resolved = await context.moduleContext.paths.resolveReadable(relativePath);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined;
    throw error;
  }
  let stat;
  try {
    stat = await fs.lstat(resolved.absolutePath);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined;
    throw error;
  }
  if (!stat.isFile() || stat.isSymbolicLink()) {
    throw new Error(`Coverage report must be a regular workspace file: ${relativePath}.`);
  }
  const handle = await fs.open(resolved.absolutePath, "r");
  try {
    const buffer = Buffer.alloc(Math.min(stat.size, MAX_REPORT_BYTES) + (stat.size > MAX_REPORT_BYTES ? 0 : 1));
    const { bytesRead } = await handle.read(buffer, 0, buffer.byteLength, 0);
    const content = buffer.subarray(0, bytesRead).toString("utf8");
    return {
      content,
      truncated: stat.size > MAX_REPORT_BYTES,
      mimeType: path.extname(relativePath).toLocaleLowerCase("en-US") === ".json" ? "application/json" : "text/plain",
      source: "coverage_summary_json",
      workspaceRelativePath: resolved.workspaceRelativePath ?? relativePath,
      fingerprint: {
        sizeBytes: stat.size,
        mtimeMs: stat.mtimeMs,
        sha256: createHash("sha256").update(content).digest("hex"),
      },
    };
  } finally {
    await handle.close();
  }
}

function sameCoverageReport(
  before: CoverageReportFingerprint | undefined,
  after: CoverageReportFingerprint | undefined,
): boolean {
  return Boolean(
    before &&
    after &&
    before.sizeBytes === after.sizeBytes &&
    before.mtimeMs === after.mtimeMs &&
    before.sha256 === after.sha256,
  );
}

function thresholdEvaluation(metrics: NormalizedCoverageMetrics, configured: CoverageThresholds | undefined) {
  const results: Partial<Record<CoverageMetricName, { required: number; actual: number | null; passed: boolean }>> = {};
  for (const name of COVERAGE_METRIC_NAMES) {
    const required = configured?.[name];
    if (required === undefined) continue;
    const actual = metrics[name].pct;
    results[name] = { required, actual, passed: actual !== null && actual >= required };
  }
  const configuredCount = Object.keys(results).length;
  return {
    configured: configuredCount > 0,
    passed: Object.values(results).every((result) => result.passed),
    results,
  };
}

function keyErrors(result: ToolProcessResult): string[] {
  return redactProcessText(`${result.stderr}\n${result.stdout}`)
    .split(/\r?\n/u)
    .map((line) => line.trim())
    .filter((line) => /\b(?:error|failed|failure|fatal)\b/iu.test(line))
    .slice(0, MAX_KEY_ERRORS)
    .map((line) => line.slice(0, 500));
}

function processFailure(result: ToolProcessResult, commandSummary: string): ToolStructuredError | undefined {
  if (result.timedOut) {
    return {
      type: "timeout",
      message: "Coverage command timed out.",
      retryable: true,
      toolName: "test_coverage",
      command: commandSummary,
      exitCode: result.exitCode ?? undefined,
    };
  }
  if (result.spawnError?.code === "ENOENT") {
    return {
      type: "missing_dependency",
      message: "The requested coverage executable is unavailable; configure it explicitly outside this tool.",
      retryable: false,
      toolName: "test_coverage",
      command: commandSummary,
      dependency: commandSummary.split(" ")[0],
    };
  }
  if (result.spawnError || result.exitCode !== 0) {
    return {
      type: "command_failed",
      message: result.spawnError?.message ?? `Coverage command exited with code ${result.exitCode ?? -1}.`,
      retryable: true,
      toolName: "test_coverage",
      command: commandSummary,
      exitCode: result.exitCode ?? undefined,
    };
  }
  return undefined;
}

async function persistCoverageReport(
  context: RuntimeToolExecutionContext,
  report: BoundedReport,
): Promise<ToolOutputArtifact> {
  const extension = report.mimeType === "application/json" ? "json" : "txt";
  const content = redactProcessText(report.content).slice(0, MAX_REPORT_BYTES);
  return context.moduleContext.persistence.storeToolOutputArtifact({
    sessionId: context.sessionId,
    namespace: "quality",
    turnId: context.turnId,
    toolCallId: context.callId,
    sourceToolName: "test_coverage",
    fileName: `coverage-report-${context.callId}.${extension}`,
    mimeType: report.mimeType,
    kind: "text",
    summary: "Full redacted coverage report captured by the tool",
    content,
    signal: context.signal,
  });
}

async function executeTestCoverage(
  args: TestCoverageArguments,
  context: RuntimeToolExecutionContext,
): Promise<ToolResult> {
  const startedAt = context.moduleContext.clock.now();
  const startedMs = Date.now();
  let commandSummary: string | undefined;
  try {
    const invocation = await resolveCoverageInvocation(args, context);
    commandSummary = invocation.commandSummary;
    const cwd = context.moduleContext.paths.resolveWorkspace(args.cwd ?? ".");
    const normalizedCwd = normalizeRelative(path.relative(context.workspaceRoot, cwd));
    const reportLocation = resolveReportLocation(args, context);
    // A pre-run fingerprint prevents a successful no-op command from reusing a
    // coverage-summary.json left behind by an earlier run.
    const reportBefore = await readBoundedCoverageReport(context, reportLocation.relativePath);
    const result = await context.moduleContext.processes.run({
      command: invocation.file,
      args: invocation.args,
      mode: "direct",
      cwd,
      timeoutMs: args.timeoutMs ?? 180_000,
      maxOutputChars: MAX_PROCESS_OUTPUT_CHARS,
      signal: context.signal,
    });
    if (context.signal?.aborted) {
      throw context.signal.reason instanceof Error
        ? context.signal.reason
        : new Error("test_coverage was cancelled.");
    }

    const combinedOutput = redactProcessText(
      [result.stdout.trimEnd(), result.stderr.trimEnd()].filter(Boolean).join("\n"),
    );
    const fileReport = await readBoundedCoverageReport(context, reportLocation.relativePath);
    const staleFileReport = Boolean(
      fileReport && sameCoverageReport(reportBefore?.fingerprint, fileReport.fingerprint),
    );
    const freshFileReport = staleFileReport ? undefined : fileReport;
    const outputMetrics = parseCoverageText(combinedOutput);
    const report: BoundedReport | undefined =
      freshFileReport ??
      (combinedOutput
        ? {
            content: combinedOutput.slice(0, MAX_REPORT_BYTES),
            truncated: Boolean(result.outputTruncated) || combinedOutput.length > MAX_REPORT_BYTES,
            mimeType: "text/plain",
            source: "command_output",
          }
        : undefined);
    const metrics =
      (freshFileReport ? parseCoverageSummaryJson(freshFileReport.content) : undefined) ??
      outputMetrics ??
      (freshFileReport ? parseCoverageText(freshFileReport.content) : undefined) ??
      emptyMetrics();
    const parsed = hasCoverageMetrics(metrics);
    const thresholds = thresholdEvaluation(metrics, args.thresholds);
    const artifact = report ? await persistCoverageReport(context, report) : undefined;
    const artifacts = artifact ? [artifact] : [];
    let error = processFailure(result, commandSummary);
    if (!error && !parsed) {
      error = {
        type: "invalid_state",
        message: staleFileReport
          ? "Coverage completed without updating the existing report, and command output contained no fresh normalized metrics."
          : "Coverage completed, but no normalized line, branch, function, or statement metrics were found.",
        retryable: true,
        toolName: "test_coverage",
        command: commandSummary,
        exitCode: result.exitCode ?? undefined,
      };
    }
    const capabilityUnavailable = error?.type === "missing_dependency";
    if (!error && !thresholds.passed) {
      error = {
        type: "command_failed",
        message: "One or more configured coverage thresholds were not met.",
        retryable: true,
        toolName: "test_coverage",
        command: commandSummary,
        exitCode: result.exitCode ?? undefined,
      };
    }
    const structuredContent = {
      kind: "test_coverage",
      source: invocation.source,
      scriptName: invocation.scriptName,
      commandSummary,
      cwd: normalizedCwd,
      exitCode: result.exitCode ?? -1,
      durationMs: Date.now() - startedMs,
      ok: !error,
      capabilityAvailable: !capabilityUnavailable,
      suggestion: capabilityUnavailable
        ? "Provide an available coverage executable or define a trusted test:coverage/coverage script; dependencies are never installed automatically."
        : undefined,
      metrics,
      thresholds,
      report: {
        source: report?.source ?? "unavailable",
        path: report?.workspaceRelativePath,
        mimeType: report?.mimeType,
        content: report?.content,
        truncated: Boolean(report?.truncated) || Boolean(result.outputTruncated),
        staleExistingReportIgnored: staleFileReport,
        artifactUris: artifacts.map((entry) => entry.uri),
      },
      commandOutput: combinedOutput,
      commandOutputTruncated: Boolean(result.outputTruncated),
      keyErrors: keyErrors(result),
      dependencyInstallAttempted: false,
      packageConfigurationModified: false,
      ...(error ? { error } : {}),
    };
    const availableMetricCount = COVERAGE_METRIC_NAMES.filter((name) => metrics[name].pct !== null).length;
    return {
      toolName: "test_coverage",
      callId: context.callId,
      startedAt,
      endedAt: context.moduleContext.clock.now(),
      success: !error,
      output: JSON.stringify(structuredContent),
      structuredContent,
      artifacts,
      error: error?.message,
    };
  } catch (error) {
    const capability = error instanceof CoverageCapabilityError;
    const structured: ToolStructuredError = {
      type: capability ? "missing_dependency" : "invalid_arguments",
      message: redactProcessText((error as Error).message).slice(0, MAX_REPORT_BYTES),
      retryable: false,
      toolName: "test_coverage",
      command: commandSummary,
    };
    const body = {
      kind: "test_coverage",
      capabilityAvailable: !capability,
      suggestion: capability
        ? "Provide an explicit coverage executable or define a trusted test:coverage/coverage script; dependencies are never installed automatically."
        : undefined,
      dependencyInstallAttempted: false,
      packageConfigurationModified: false,
      error: structured,
    };
    return {
      toolName: "test_coverage",
      callId: context.callId,
      startedAt,
      endedAt: context.moduleContext.clock.now(),
      success: false,
      output: JSON.stringify(body),
      structuredContent: body,
      error: structured.message,
    };
  }
}

export const testCoverageTool: RuntimeToolSpec = {
  name: "test_coverage",
  description: "Run an explicit coverage executable or trusted project coverage script and normalize coverage metrics.",
  inputSchema: TEST_COVERAGE_SCHEMA,
  readOnly: false,
  permissionCategory: "run_tests",
  sideEffectLevel: "medium",
  timeoutCategory: "slow",
  groups: ["quality", "commands", "diagnostics"],
  selection: {
    groups: ["quality", "commands", "diagnostics"],
    keywords: ["coverage", "test coverage", "coverage threshold", "覆盖率"],
    workerRoutes: ["coding"],
  },
  resolveAccess: async (rawArgs, context) => {
    const args = rawArgs as TestCoverageArguments;
    const invocation = await resolveCoverageInvocation(args, context);
    const reportLocation = resolveReportLocation(args, context);
    let reportExists = false;
    try {
      const stat = await fs.lstat(reportLocation.absolutePath);
      reportExists = stat.isFile() && !stat.isSymbolicLink();
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    }
    return [
      {
        kind: "command_execute",
        cwd: context.paths.normalize(args.cwd ?? "."),
        command: invocation.commandSummary,
        reason: "Run a bounded coverage command without installing dependencies.",
      },
      ...(reportExists
        ? [{
            kind: "filesystem_read" as const,
            paths: [reportLocation.relativePath],
            reason: "Fingerprint an existing coverage report before execution so stale results cannot be reused.",
          }]
        : []),
    ];
  },
  redactArguments: (rawArgs) => {
    const args = rawArgs as TestCoverageArguments;
    return {
      ...args,
      command: args.command ? redactProcessText(args.command) : undefined,
      args: args.args?.map((value) => redactProcessText(value)),
    };
  },
  formatPreExecutionFailure: (failure) => {
    const unavailable = /No trusted test:coverage|requires npm|unavailable/iu.test(failure.error.message);
    const error = unavailable
      ? { ...failure.error, type: "missing_dependency" as const, retryable: false }
      : failure.error;
    const body = {
      kind: "test_coverage",
      capabilityAvailable: !unavailable,
      suggestion: unavailable
        ? "Provide an explicit coverage executable or define a trusted test:coverage/coverage script; dependencies are never installed automatically."
        : undefined,
      dependencyInstallAttempted: false,
      packageConfigurationModified: false,
      error,
    };
    return { output: JSON.stringify(body), structuredContent: body };
  },
  resolveExecutionTimeoutMs: (rawArgs) => Math.min(305_000, ((rawArgs as TestCoverageArguments).timeoutMs ?? 180_000) + 5_000),
  execute: (rawArgs, context) => executeTestCoverage(rawArgs as TestCoverageArguments, context),
};
