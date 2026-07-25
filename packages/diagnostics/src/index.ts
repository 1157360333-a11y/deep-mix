import { promises as fs } from "node:fs";
import path from "node:path";
import ts from "typescript";
import type { DiagnosticEntry, DiagnosticIssue } from "../../shared-schema/src/index.js";

interface TsContext {
  configPath: string;
  parsed: ts.ParsedCommandLine;
  program: ts.Program;
}

function normalizeRelative(targetPath: string): string {
  return targetPath.replace(/\\/g, "/");
}

function toRelative(workspaceRoot: string, absolutePath: string): string {
  return normalizeRelative(path.relative(workspaceRoot, absolutePath));
}

function resolveTrackedSet(workspaceRoot: string, trackedFiles: string[]): Set<string> | undefined {
  if (trackedFiles.length === 0) {
    return undefined;
  }
  return new Set(trackedFiles.map((entry) => normalizeRelative(entry)));
}

function severityFromCategory(category: ts.DiagnosticCategory): DiagnosticIssue["severity"] {
  switch (category) {
    case ts.DiagnosticCategory.Warning:
      return "warning";
    case ts.DiagnosticCategory.Error:
      return "error";
    default:
      return "warning";
  }
}

function flattenMessage(messageText: string | ts.DiagnosticMessageChain): string {
  return ts.flattenDiagnosticMessageText(messageText, "\n");
}

function toDiagnosticIssue(
  workspaceRoot: string,
  diagnostic: ts.Diagnostic,
): DiagnosticIssue {
  const issue: DiagnosticIssue = {
    severity: severityFromCategory(diagnostic.category),
    message: flattenMessage(diagnostic.messageText),
    code: diagnostic.code,
  };

  if (diagnostic.file && typeof diagnostic.start === "number") {
    const position = diagnostic.file.getLineAndCharacterOfPosition(diagnostic.start);
    issue.file = toRelative(workspaceRoot, diagnostic.file.fileName);
    issue.line = position.line + 1;
    issue.column = position.character + 1;
  }

  return issue;
}

function summarize(kind: DiagnosticEntry["kind"], issues: DiagnosticIssue[], okLabel: string): DiagnosticEntry {
  const errorCount = issues.filter((issue) => issue.severity === "error").length;
  const warningCount = issues.length - errorCount;
  const summary =
    issues.length === 0
      ? okLabel
      : `${kind} found ${errorCount} error(s) and ${warningCount} warning(s).`;

  return {
    kind,
    status: errorCount > 0 ? "failed" : "ok",
    ok: errorCount === 0,
    summary,
    errorCount,
    warningCount,
    fileCount: new Set(issues.map((issue) => issue.file).filter(Boolean)).size,
    issues,
  };
}

function unavailable(kind: DiagnosticEntry["kind"], reason: string): DiagnosticEntry {
  return {
    kind,
    status: "unavailable",
    ok: false,
    summary: `${kind} unavailable: ${reason}`,
    unavailableReason: reason,
  };
}

function createTsContext(workspaceRoot: string): TsContext | undefined {
  const configPath = ts.findConfigFile(workspaceRoot, ts.sys.fileExists, "tsconfig.json");
  if (!configPath) {
    return undefined;
  }

  const configFile = ts.readConfigFile(configPath, ts.sys.readFile);
  if (configFile.error) {
    throw new Error(flattenMessage(configFile.error.messageText));
  }

  const parsed = ts.parseJsonConfigFileContent(configFile.config, ts.sys, path.dirname(configPath));
  if (parsed.errors.length > 0) {
    throw new Error(parsed.errors.map((entry) => flattenMessage(entry.messageText)).join("; "));
  }

  return {
    configPath,
    parsed,
    program: ts.createProgram({
      rootNames: parsed.fileNames,
      options: {
        ...parsed.options,
        noEmit: true,
      },
    }),
  };
}

function filterIssuesByTrackedFiles(
  workspaceRoot: string,
  issues: DiagnosticIssue[],
  trackedFiles: string[],
): DiagnosticIssue[] {
  const tracked = resolveTrackedSet(workspaceRoot, trackedFiles);
  if (!tracked) {
    return issues;
  }
  return issues.filter((issue) => !issue.file || tracked.has(issue.file));
}

function isTypeScriptFile(filePath: string): boolean {
  return /\.(cts|mts|ts|tsx|js|jsx)$/i.test(filePath);
}

function isLintableTextFile(filePath: string): boolean {
  return /\.(cts|mts|ts|tsx|js|jsx|json|md|mjs|cjs)$/i.test(filePath);
}

export async function runLspDiagnostics(
  workspaceRoot: string,
  trackedFiles: string[],
): Promise<DiagnosticEntry> {
  let context: TsContext | undefined;
  try {
    context = createTsContext(workspaceRoot);
  } catch (error) {
    return unavailable("lsp", (error as Error).message);
  }

  if (!context) {
    return unavailable("lsp", "tsconfig.json not found.");
  }

  const tracked = resolveTrackedSet(workspaceRoot, trackedFiles);
  const sourceFiles = context.program
    .getSourceFiles()
    .filter((sourceFile) => !sourceFile.isDeclarationFile && isTypeScriptFile(sourceFile.fileName))
    .filter((sourceFile) => !tracked || tracked.has(toRelative(workspaceRoot, sourceFile.fileName)));

  if (tracked && sourceFiles.length === 0) {
    return unavailable("lsp", "No tracked TypeScript or JavaScript files were edited.");
  }

  const rawDiagnostics = [
    ...sourceFiles.flatMap((sourceFile) => context.program!.getSyntacticDiagnostics(sourceFile)),
    ...sourceFiles.flatMap((sourceFile) => context.program!.getSemanticDiagnostics(sourceFile)),
  ];
  const issues = rawDiagnostics.map((diagnostic) => toDiagnosticIssue(workspaceRoot, diagnostic));
  return summarize("lsp", issues, "lsp passed for tracked source files.");
}

export async function runTypecheckDiagnostics(
  workspaceRoot: string,
  trackedFiles: string[],
): Promise<DiagnosticEntry> {
  let context: TsContext | undefined;
  try {
    context = createTsContext(workspaceRoot);
  } catch (error) {
    return unavailable("typecheck", (error as Error).message);
  }

  if (!context) {
    return unavailable("typecheck", "tsconfig.json not found.");
  }

  const rawDiagnostics = ts
    .getPreEmitDiagnostics(context.program)
    .map((diagnostic) => toDiagnosticIssue(workspaceRoot, diagnostic));
  const issues = filterIssuesByTrackedFiles(workspaceRoot, rawDiagnostics, trackedFiles);
  return summarize("typecheck", issues, "typecheck passed for the current project scope.");
}

export async function runSimpleLintDiagnostics(
  workspaceRoot: string,
  trackedFiles: string[],
): Promise<DiagnosticEntry> {
  const filesToInspect = trackedFiles.filter((entry) => isLintableTextFile(entry));
  if (filesToInspect.length === 0) {
    return unavailable("lint", "No tracked text files were edited.");
  }

  const issues: DiagnosticIssue[] = [];
  for (const relativePath of filesToInspect) {
    const absolutePath = path.join(workspaceRoot, relativePath);
    let content: string;
    try {
      content = await fs.readFile(absolutePath, "utf8");
    } catch (error) {
      issues.push({
        severity: "error",
        file: normalizeRelative(relativePath),
        message: `Failed to read file for lint diagnostics: ${(error as Error).message}`,
      });
      continue;
    }

    const lines = content.split(/\r?\n/);
    for (let index = 0; index < lines.length; index += 1) {
      const line = lines[index] ?? "";
      if (/[ \t]+$/.test(line)) {
        issues.push({
          severity: "warning",
          file: normalizeRelative(relativePath),
          line: index + 1,
          column: line.length,
          code: "trailing_whitespace",
          message: "Trailing whitespace detected.",
        });
      }
      if (/\t/.test(line)) {
        issues.push({
          severity: "warning",
          file: normalizeRelative(relativePath),
          line: index + 1,
          column: line.indexOf("\t") + 1,
          code: "tab_character",
          message: "Tab indentation detected; prefer spaces.",
        });
      }
    }

    if (content.length > 0 && !content.endsWith("\n")) {
      issues.push({
        severity: "warning",
        file: normalizeRelative(relativePath),
        line: lines.length,
        column: (lines[lines.length - 1] ?? "").length + 1,
        code: "missing_final_newline",
        message: "File should end with a newline.",
      });
    }
  }

  return summarize("lint", issues, "lint passed for tracked files.");
}
