import { createHash } from "node:crypto";
import { promises as fs } from "node:fs";

import type {
  DiagnosticEntry,
  DiagnosticKind,
  DiagnosticReportRecord,
  ToolResult,
} from "../../../../shared-schema/src/index.js";
import type {
  RuntimeToolExecutionContext,
  RuntimeToolSpec,
  ToolModule,
} from "../../tool-module.js";
import { publishTextFileAtomic } from "../../atomic-file.js";
import { assertForegroundShellCommand } from "../../process-command-policy.js";

interface ApplyPatchTextReplacement {
  oldText: string;
  newText: string;
  replaceAll?: boolean;
  expectedOccurrences?: number;
}

interface ApplyPatchChange {
  path: string;
  action: "upsert" | "replace_text" | "delete";
  content?: string;
  replacements?: ApplyPatchTextReplacement[];
  expectedSha256?: string;
  allowDestructiveReplace?: boolean;
}

interface ApplyPatchArguments {
  reason?: string;
  lintCommand?: string;
  typecheckCommand?: string;
  runTestsCommand?: string;
  changes: ApplyPatchChange[];
}

interface PreparedApplyPatchChange {
  path: string;
  absolutePath: string;
  action: ApplyPatchChange["action"];
  content?: string;
  existed: boolean;
  beforeChars: number;
  afterChars: number;
  beforeSha256?: string;
  afterSha256?: string;
  lineEndingNormalizedMatches?: number;
  lineEndingAdjustedReplacements?: number;
}

interface NormalizedTextWithOffsets {
  text: string;
  originalOffsets?: Uint32Array;
}

interface LineEndingAwareMatch {
  start: number;
  end: number;
  requiredLineEndingNormalization: boolean;
}

interface AppliedTextReplacements {
  content: string;
  lineEndingNormalizedMatches: number;
  lineEndingAdjustedReplacements: number;
}

type LineEnding = "\r\n" | "\n" | "\r";

const DESTRUCTIVE_REPLACE_MIN_EXISTING_CHARS = 256;
const DESTRUCTIVE_REPLACE_RETAINED_RATIO = 0.5;

function sha256(value: string): string {
  return createHash("sha256").update(value, "utf8").digest("hex");
}

function throwIfAborted(signal: AbortSignal | undefined): void {
  if (!signal?.aborted) return;
  if (signal.reason instanceof Error) throw signal.reason;
  throw new Error(typeof signal.reason === "string" ? signal.reason : "apply_patch was aborted.");
}

function assertUniqueChangePaths(
  changes: ApplyPatchChange[],
  normalize: (relativePath: string) => string,
): string[] {
  const paths: string[] = [];
  const seen = new Map<string, string>();
  for (const change of changes) {
    const normalized = normalize(change.path);
    const identity = process.platform === "win32" ? normalized.toLocaleLowerCase() : normalized;
    const prior = seen.get(identity);
    if (prior) {
      throw new Error(
        `apply_patch rejects duplicate target paths (${prior}, ${normalized}). ` +
        "Multiple upserts would be last-write-wins and could erase a file; combine edits into one replace_text change with multiple replacements.",
      );
    }
    seen.set(identity, normalized);
    paths.push(normalized);
  }
  return paths;
}

function normalizeLineEndings(value: string): string {
  return value.replace(/\r\n|\r/gu, "\n");
}

function normalizeTextWithOffsets(value: string): NormalizedTextWithOffsets {
  if (!value.includes("\r")) return { text: value };

  const text = normalizeLineEndings(value);
  const originalOffsets = new Uint32Array(text.length + 1);
  let originalIndex = 0;
  let normalizedIndex = 0;
  originalOffsets[0] = 0;
  while (originalIndex < value.length) {
    if (value[originalIndex] === "\r") {
      originalIndex += value[originalIndex + 1] === "\n" ? 2 : 1;
    } else {
      originalIndex += 1;
    }
    normalizedIndex += 1;
    originalOffsets[normalizedIndex] = originalIndex;
  }
  return { text, originalOffsets };
}

function findLineEndingAwareMatches(content: string, needle: string): LineEndingAwareMatch[] {
  const normalizedContent = normalizeTextWithOffsets(content);
  const normalizedNeedle = normalizeLineEndings(needle);
  const matches: LineEndingAwareMatch[] = [];
  let cursor = 0;
  while (true) {
    const normalizedStart = normalizedContent.text.indexOf(normalizedNeedle, cursor);
    if (normalizedStart < 0) return matches;
    const normalizedEnd = normalizedStart + normalizedNeedle.length;
    const start = normalizedContent.originalOffsets?.[normalizedStart] ?? normalizedStart;
    const end = normalizedContent.originalOffsets?.[normalizedEnd] ?? normalizedEnd;
    matches.push({
      start,
      end,
      requiredLineEndingNormalization: content.slice(start, end) !== needle,
    });
    cursor = normalizedEnd;
  }
}

function dominantLineEnding(value: string, fallback?: LineEnding): LineEnding | undefined {
  const counts = new Map<LineEnding, number>([["\r\n", 0], ["\n", 0], ["\r", 0]]);
  let first: LineEnding | undefined;
  for (let index = 0; index < value.length; index += 1) {
    let lineEnding: LineEnding | undefined;
    if (value[index] === "\r") {
      if (value[index + 1] === "\n") {
        lineEnding = "\r\n";
        index += 1;
      } else {
        lineEnding = "\r";
      }
    } else if (value[index] === "\n") {
      lineEnding = "\n";
    }
    if (!lineEnding) continue;
    first ??= lineEnding;
    counts.set(lineEnding, (counts.get(lineEnding) ?? 0) + 1);
  }

  const maximum = Math.max(...counts.values());
  if (maximum === 0) return fallback;
  const candidates = [...counts.entries()]
    .filter(([, count]) => count === maximum)
    .map(([lineEnding]) => lineEnding);
  if (fallback && candidates.includes(fallback)) return fallback;
  if (first && candidates.includes(first)) return first;
  return candidates[0];
}

function convertLineEndings(value: string, lineEnding: LineEnding): string {
  return value.replace(/\r\n|[\r\n]/gu, lineEnding);
}

function applyTextReplacements(
  pathLabel: string,
  original: string,
  replacements: ApplyPatchTextReplacement[] | undefined,
): AppliedTextReplacements {
  if (!replacements || replacements.length === 0) {
    throw new Error(`apply_patch replace_text requires at least one replacement: ${pathLabel}`);
  }
  let content = original;
  let lineEndingNormalizedMatches = 0;
  let lineEndingAdjustedReplacements = 0;
  for (const [index, replacement] of replacements.entries()) {
    if (!replacement.oldText) {
      throw new Error(`apply_patch replace_text oldText cannot be empty: ${pathLabel} replacement ${index + 1}`);
    }
    const expectedOccurrences = replacement.expectedOccurrences ?? 1;
    if (!Number.isSafeInteger(expectedOccurrences) || expectedOccurrences < 1) {
      throw new Error(`apply_patch replace_text expectedOccurrences must be a positive integer: ${pathLabel} replacement ${index + 1}`);
    }
    if (!replacement.replaceAll && expectedOccurrences !== 1) {
      throw new Error(`apply_patch replace_text requires replaceAll=true when expectedOccurrences is greater than one: ${pathLabel} replacement ${index + 1}`);
    }
    const matches = findLineEndingAwareMatches(content, replacement.oldText);
    const actualOccurrences = matches.length;
    if (actualOccurrences !== expectedOccurrences) {
      throw new Error(
        `apply_patch replace_text anchor mismatch for ${pathLabel} replacement ${index + 1}: ` +
        `expected ${expectedOccurrences} occurrence(s), found ${actualOccurrences} ` +
        "after treating CRLF, LF, and CR line endings as equivalent; no file was written.",
      );
    }
    const selectedMatches = replacement.replaceAll ? matches : matches.slice(0, 1);
    const fallbackLineEnding = dominantLineEnding(content) ?? "\n";
    const pieces: string[] = [];
    let contentCursor = 0;
    for (const match of selectedMatches) {
      pieces.push(content.slice(contentCursor, match.start));
      const matchedText = content.slice(match.start, match.end);
      const lineEnding = dominantLineEnding(matchedText, fallbackLineEnding) ?? fallbackLineEnding;
      const newText = convertLineEndings(replacement.newText, lineEnding);
      if (match.requiredLineEndingNormalization) lineEndingNormalizedMatches += 1;
      if (newText !== replacement.newText) lineEndingAdjustedReplacements += 1;
      pieces.push(newText);
      contentCursor = match.end;
    }
    pieces.push(content.slice(contentCursor));
    content = pieces.join("");
  }
  return { content, lineEndingNormalizedMatches, lineEndingAdjustedReplacements };
}

function assertExpectedHash(change: ApplyPatchChange, existingHash: string | undefined): void {
  if (!change.expectedSha256) return;
  if (existingHash !== change.expectedSha256.toLocaleLowerCase()) {
    throw new Error(
      `apply_patch expectedSha256 mismatch for ${change.path}; the file changed since it was inspected and no file was written.`,
    );
  }
}

function assertNonDestructiveReplacement(
  change: ApplyPatchChange,
  before: string | undefined,
  after: string,
  existingHash: string | undefined,
): void {
  if (before === undefined || before.length === 0) return;
  const destructive = after.length === 0 || (
    before.length >= DESTRUCTIVE_REPLACE_MIN_EXISTING_CHARS &&
    after.length < Math.floor(before.length * DESTRUCTIVE_REPLACE_RETAINED_RATIO)
  );
  if (!destructive) return;
  if (change.allowDestructiveReplace === true && change.expectedSha256?.toLocaleLowerCase() === existingHash) return;
  throw new Error(
    `apply_patch blocked a destructive replacement of ${change.path}: ${before.length} -> ${after.length} characters. ` +
    "Use replace_text for surgical edits. An intentional destructive replacement requires allowDestructiveReplace=true " +
    `and expectedSha256=${existingHash ?? "<current file sha256>"}; no file was written.`,
  );
}

async function readExistingText(absolutePath: string): Promise<string | undefined> {
  try {
    const stat = await fs.stat(absolutePath);
    if (!stat.isFile()) throw new Error(`apply_patch target is not a regular file: ${absolutePath}`);
    return await fs.readFile(absolutePath, "utf8");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined;
    throw error;
  }
}

async function prepareApplyPatchChanges(
  args: ApplyPatchArguments,
  context: RuntimeToolExecutionContext,
  trackedFiles: string[],
): Promise<PreparedApplyPatchChange[]> {
  const prepared: PreparedApplyPatchChange[] = [];
  for (let index = 0; index < args.changes.length; index += 1) {
    throwIfAborted(context.signal);
    const change = args.changes[index]!;
    const normalizedPath = trackedFiles[index]!;
    const absolutePath = context.moduleContext.paths.resolveWorkspace(normalizedPath);
    const before = await readExistingText(absolutePath);
    const beforeSha256 = before === undefined ? undefined : sha256(before);
    assertExpectedHash(change, beforeSha256);

    if (change.action === "delete") {
      prepared.push({
        path: normalizedPath,
        absolutePath,
        action: change.action,
        existed: before !== undefined,
        beforeChars: before?.length ?? 0,
        afterChars: 0,
        beforeSha256,
      });
      continue;
    }

    let content = change.content;
    let lineEndingNormalizedMatches: number | undefined;
    let lineEndingAdjustedReplacements: number | undefined;
    if (change.action === "replace_text") {
      if (before === undefined) {
        throw new Error(`apply_patch replace_text target does not exist: ${normalizedPath}`);
      }
      const applied = applyTextReplacements(normalizedPath, before, change.replacements);
      content = applied.content;
      lineEndingNormalizedMatches = applied.lineEndingNormalizedMatches;
      lineEndingAdjustedReplacements = applied.lineEndingAdjustedReplacements;
    }
    if (typeof content !== "string") {
      throw new Error(`apply_patch requires content for upsert: ${normalizedPath}`);
    }
    assertNonDestructiveReplacement(change, before, content, beforeSha256);
    prepared.push({
      path: normalizedPath,
      absolutePath,
      action: change.action,
      content,
      existed: before !== undefined,
      beforeChars: before?.length ?? 0,
      afterChars: content.length,
      beforeSha256,
      afterSha256: sha256(content),
      lineEndingNormalizedMatches,
      lineEndingAdjustedReplacements,
    });
  }
  return prepared;
}

function toDiagnosticEntryFromToolResult(
  kind: DiagnosticKind,
  result: ToolResult,
): DiagnosticEntry {
  if (kind === "run_tests") {
    const content = (result.structuredContent ?? {}) as {
      command?: string;
      exitCode?: number;
      failed?: number;
      passed?: number;
    };
    const failed = typeof content.failed === "number" ? content.failed : result.success ? 0 : 1;
    const passed = typeof content.passed === "number" ? content.passed : undefined;
    return {
      kind,
      status: result.success ? "ok" : "failed",
      ok: result.success,
      summary: result.success
        ? `run_tests passed${passed !== undefined ? ` with ${passed} passing test(s)` : ""}.`
        : `run_tests failed${failed > 0 ? ` with ${failed} failing test(s)` : ""}.`,
      command: content.command,
      exitCode: typeof content.exitCode === "number" ? content.exitCode : undefined,
      errorCount: failed,
      rawOutput: result.output,
    };
  }

  const content = (result.structuredContent ?? {}) as {
    command?: string;
    exitCode?: number;
    errorCount?: number;
    warningCount?: number;
  };
  const errorCount =
    typeof content.errorCount === "number" ? content.errorCount : result.success ? 0 : 1;
  const warningCount = typeof content.warningCount === "number" ? content.warningCount : 0;
  return {
    kind,
    status: result.success ? "ok" : "failed",
    ok: result.success,
    summary: result.success
      ? `${kind} passed.`
      : `${kind} failed with ${errorCount} error(s) and ${warningCount} warning(s).`,
    command: content.command,
    exitCode: typeof content.exitCode === "number" ? content.exitCode : undefined,
    errorCount,
    warningCount,
    rawOutput: result.output,
  };
}

async function runPostEditDiagnostics(
  input: {
    trackedFiles: string[];
    lintCommand?: string;
    typecheckCommand?: string;
    runTestsCommand?: string;
  },
  context: RuntimeToolExecutionContext,
): Promise<{
  diagnostics: DiagnosticEntry[];
  report: DiagnosticReportRecord;
}> {
  const diagnostics: DiagnosticEntry[] = [];
  const executeManual = context.moduleContext.tools.executeManual;
  const executePostEditVerification = context.executePostEditVerification;
  if (!executePostEditVerification) {
    throw new Error("apply_patch is missing its scoped post-edit verification capability.");
  }

  const lspResult = await executeManual(
    "lsp_diagnostics",
    { paths: input.trackedFiles },
    context.sessionId,
  );
  diagnostics.push((lspResult.structuredContent ?? {}) as DiagnosticEntry);

  if (input.lintCommand) {
    const lintResult = await executePostEditVerification(
      "lint",
      { command: input.lintCommand, cwd: "." },
    );
    diagnostics.push(toDiagnosticEntryFromToolResult("lint", lintResult));
  } else {
    const lintResult = await executeManual(
      "lint_diagnostics",
      { paths: input.trackedFiles },
      context.sessionId,
    );
    diagnostics.push((lintResult.structuredContent ?? {}) as DiagnosticEntry);
  }

  if (input.typecheckCommand) {
    const typecheckResult = await executePostEditVerification(
      "typecheck",
      { command: input.typecheckCommand, cwd: "." },
    );
    diagnostics.push(toDiagnosticEntryFromToolResult("typecheck", typecheckResult));
  } else {
    const typecheckResult = await executeManual(
      "typecheck_diagnostics",
      { paths: input.trackedFiles },
      context.sessionId,
    );
    diagnostics.push((typecheckResult.structuredContent ?? {}) as DiagnosticEntry);
  }

  if (diagnostics.some((entry) => entry.status === "unavailable") && input.runTestsCommand) {
    const runTestsResult = await executePostEditVerification(
      "run_tests",
      { command: input.runTestsCommand, cwd: "." },
    );
    diagnostics.push(toDiagnosticEntryFromToolResult("run_tests", runTestsResult));
  }

  const report: DiagnosticReportRecord = {
    recordType: "diagnostic_report",
    sessionId: context.sessionId,
    createdAt: context.moduleContext.clock.now(),
    trigger: "apply_patch",
    trackedFiles: input.trackedFiles,
    diagnostics,
  };
  await context.moduleContext.persistence.recordDiagnosticReport(report);
  return { diagnostics, report };
}

const applyPatchTool: RuntimeToolSpec = {
  name: "apply_patch",
  description: "Atomically create, replace, surgically edit, or delete workspace files through the runtime checkpoint flow. Use replace_text with exact unique anchors for existing files; CRLF, LF, and CR are matched equivalently while replacement text preserves the target style. Upsert replaces the complete file and destructive shrinkage is guarded.",
  inputSchema: {
    type: "object",
    additionalProperties: false,
    required: ["changes"],
    properties: {
      reason: { type: "string" },
      lintCommand: { type: "string" },
      typecheckCommand: { type: "string" },
      runTestsCommand: { type: "string" },
      changes: {
        type: "array",
        minItems: 1,
        items: {
          type: "object",
          additionalProperties: false,
          required: ["path", "action"],
          properties: {
            path: { type: "string" },
            action: {
              type: "string",
              enum: ["upsert", "replace_text", "delete"],
            },
            content: { type: "string" },
            replacements: {
              type: "array",
              minItems: 1,
              items: {
                type: "object",
                additionalProperties: false,
                required: ["oldText", "newText"],
                properties: {
                  oldText: { type: "string", minLength: 1 },
                  newText: { type: "string" },
                  replaceAll: { type: "boolean", default: false },
                  expectedOccurrences: { type: "integer", minimum: 1, default: 1 },
                },
              },
            },
            expectedSha256: { type: "string", pattern: "^[A-Fa-f0-9]{64}$" },
            allowDestructiveReplace: { type: "boolean", default: false },
          },
        },
      },
    },
  },
  readOnly: false,
  permissionCategory: "write_file",
  sideEffectLevel: "high",
  timeoutCategory: "default",
  groups: ["core", "workspace"],
  selection: {
    alwaysAvailable: true,
    groups: ["core", "workspace"],
  },
  checkpoint: {
    mode: "before_write",
    scope: "pre_patch",
    restoreOnFailure: false,
  },
  resolveAccess: (rawArgs, context) => {
    const args = rawArgs as ApplyPatchArguments;
    const trackedFiles = assertUniqueChangePaths(args.changes, (filePath) => context.paths.normalize(filePath));
    for (const [label, command] of [
      ["apply_patch lintCommand", args.lintCommand],
      ["apply_patch typecheckCommand", args.typecheckCommand],
      ["apply_patch runTestsCommand", args.runTestsCommand],
    ] as const) {
      if (command) assertForegroundShellCommand(label, command);
    }
    return [
      {
        kind: "filesystem_write",
        paths: trackedFiles,
        reason: args.reason ?? "apply_patch",
      },
    ];
  },
  execute: async (rawArgs, context) => {
    const args = rawArgs as ApplyPatchArguments;
    const startedAt = context.moduleContext.clock.now();
    if (!context.checkpoint) {
      throw new Error("apply_patch requires a runtime checkpoint before writing.");
    }

    const trackedFiles = assertUniqueChangePaths(
      args.changes,
      (filePath) => context.moduleContext.paths.normalize(filePath),
    );
    const preparedChanges = await prepareApplyPatchChanges(args, context, trackedFiles);
    try {
      for (const change of preparedChanges) {
        throwIfAborted(context.signal);
        if (change.action === "delete") {
          await fs.rm(change.absolutePath, { force: true });
        } else {
          await publishTextFileAtomic(change.absolutePath, change.content!, context.signal);
        }
      }
    } catch (error) {
      try {
        await context.moduleContext.persistence.restoreCheckpoint({
          sessionId: context.sessionId,
          checkpointId: context.checkpoint.checkpointId,
          mode: "code",
          reason: "Automatic rollback after apply_patch mutation failed or was interrupted.",
        });
      } catch (rollbackError) {
        const combined = new Error(
          `apply_patch mutation failed and automatic checkpoint restore also failed: ${(rollbackError as Error).message}`,
        );
        (combined as Error & { cause?: unknown }).cause = error;
        throw combined;
      }
      throw error;
    }

    const diagnosticsResult = await runPostEditDiagnostics(
      {
        trackedFiles,
        lintCommand: args.lintCommand,
        typecheckCommand: args.typecheckCommand,
        runTestsCommand: args.runTestsCommand,
      },
      context,
    );
    const diagnosticFailures = diagnosticsResult.diagnostics.filter(
      (entry) => entry.status === "failed",
    ).length;
    const success = diagnosticFailures === 0;

    const structuredContent = {
      trackedFiles,
      checkpointId: context.checkpoint.checkpointId,
      changes: preparedChanges.map((change) => ({
        path: change.path,
        action: change.action,
        existed: change.existed,
        beforeChars: change.beforeChars,
        afterChars: change.afterChars,
        beforeSha256: change.beforeSha256,
        afterSha256: change.afterSha256,
        atomic: change.action !== "delete",
        ...(change.action === "replace_text" ? {
          lineEndingNormalizedMatches: change.lineEndingNormalizedMatches ?? 0,
          lineEndingAdjustedReplacements: change.lineEndingAdjustedReplacements ?? 0,
        } : {}),
      })),
      diagnostics: diagnosticsResult.diagnostics,
      diagnosticReport: diagnosticsResult.report,
    };
    return {
      toolName: "apply_patch",
      callId: context.callId,
      startedAt,
      endedAt: context.moduleContext.clock.now(),
      success,
      output: JSON.stringify(structuredContent),
      structuredContent,
      error: success ? undefined : "Post-edit diagnostics reported one or more failures.",
    };
  },
};

export const workspaceToolModule: ToolModule = {
  manifest: {
    id: "builtin.workspace",
    version: "1.0.0",
    description: "Built-in checkpointed workspace mutation tools.",
    source: "built_in",
  },
  create: () => applyPatchTool,
};
