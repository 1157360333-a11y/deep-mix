import path from "node:path";

import type {
  ToolResult,
  ToolStructuredError,
} from "../../../../shared-schema/src/index.js";
import {
  isIgnoredPath,
  matchesRepositoryExclude,
  matchesRepositoryFileGlob,
  type SearchMatch,
} from "../../repository-explorer.js";
import type {
  RuntimeToolExecutionContext,
  ToolProcessResult,
} from "../../tool-module.js";

export function normalizeRelativePath(targetPath: string): string {
  return targetPath.replace(/\\/g, "/");
}

export function toWorkspaceRelativePath(workspaceRoot: string, targetPath: string): string {
  const relative = normalizeRelativePath(path.relative(workspaceRoot, targetPath));
  return relative || ".";
}

export function formatWithLineNumbers(content: string, startLine: number): string {
  return content
    .split(/\r?\n/)
    .map((line, index) => `${String(startLine + index).padStart(4, " ")} | ${line}`)
    .join("\n");
}

export function buildListOutput(
  files: string[],
  options?: {
    cwd: string;
    glob?: string;
    maxDepth: number;
    maxResults: number;
    truncated: boolean;
  },
): string {
  if (!options) {
    return files.length > 0 ? files.join("\n") : "No files found.";
  }
  const scope = `cwd=${options.cwd}; glob=${options.glob ?? "all"}; maxDepth=${options.maxDepth}`;
  const status = options.truncated
    ? `[list_files truncated: returned ${files.length} path(s) at maxResults=${options.maxResults}; omitted paths may exist. Do not infer that an unlisted file is absent; narrow cwd/glob or use glob_files/file_metadata. ${scope}]`
    : `[list_files complete: returned ${files.length} path(s) within the requested scope; no maxResults truncation. ${scope}]`;
  return [status, files.length > 0 ? files.join("\n") : "No files found within the requested scope."].join("\n");
}

function shouldIncludeRepositoryPath(input: {
  workspaceRelativePath: string;
  cwdRelativePath: string;
  glob?: string;
  exclude?: string[];
}): boolean {
  if (isIgnoredPath(input.workspaceRelativePath)) {
    return false;
  }
  if (
    input.exclude &&
    input.exclude.length > 0 &&
    matchesRepositoryExclude(input.cwdRelativePath, input.exclude)
  ) {
    return false;
  }
  if (input.glob && !matchesRepositoryFileGlob(input.cwdRelativePath, [input.glob])) {
    return false;
  }
  return true;
}

export function parseRipgrepFileList(
  stdout: string,
  workspaceRoot: string,
  cwd: string,
  options: {
    glob?: string;
    exclude?: string[];
    maxResults: number;
  },
): { files: string[]; truncated: boolean } {
  const files: string[] = [];
  const seen = new Set<string>();
  for (const line of stdout
    .split(/\r?\n/)
    .map((entry) => entry.trim())
    .filter(Boolean)) {
    const absolutePath = path.resolve(cwd, line);
    const workspaceRelativePath = toWorkspaceRelativePath(workspaceRoot, absolutePath);
    const cwdRelativePath = normalizeRelativePath(line);
    if (
      !shouldIncludeRepositoryPath({
        workspaceRelativePath,
        cwdRelativePath,
        glob: options.glob,
        exclude: options.exclude,
      })
    ) {
      continue;
    }
    if (seen.has(cwdRelativePath)) {
      continue;
    }
    seen.add(cwdRelativePath);
    files.push(cwdRelativePath);
    if (files.length > options.maxResults) {
      return {
        files: files.slice(0, options.maxResults),
        truncated: true,
      };
    }
  }
  return {
    files,
    truncated: false,
  };
}

export function parseRipgrepSearchMatches(
  stdout: string,
  workspaceRoot: string,
  cwd: string,
  options: {
    glob?: string;
    exclude?: string[];
    maxResults: number;
  },
): { matches: SearchMatch[]; truncated: boolean } {
  const matches: SearchMatch[] = [];
  for (const line of stdout.split(/\r?\n/).filter(Boolean)) {
    let parsed: unknown;
    try {
      parsed = JSON.parse(line) as {
        type?: string;
        data?: {
          path?: { text?: string };
          line_number?: number;
          lines?: { text?: string };
          submatches?: Array<{ match?: { text?: string } }>;
        };
      };
    } catch {
      continue;
    }
    const event = parsed as {
      type?: string;
      data?: {
        path?: { text?: string };
        line_number?: number;
        lines?: { text?: string };
        submatches?: Array<{ match?: { text?: string } }>;
      };
    };
    if (
      event.type !== "match" ||
      !event.data?.path?.text ||
      typeof event.data.line_number !== "number"
    ) {
      continue;
    }
    const cwdRelativePath = normalizeRelativePath(event.data.path.text);
    const absolutePath = path.resolve(cwd, cwdRelativePath);
    const workspaceRelativePath = toWorkspaceRelativePath(workspaceRoot, absolutePath);
    if (
      !shouldIncludeRepositoryPath({
        workspaceRelativePath,
        cwdRelativePath,
        glob: options.glob,
        exclude: options.exclude,
      })
    ) {
      continue;
    }
    matches.push({
      path: cwdRelativePath,
      lineNumber: event.data.line_number,
      lineText: event.data.lines?.text?.replace(/\r?\n$/, "") ?? "",
      matchText: event.data.submatches?.[0]?.match?.text,
    });
    if (matches.length > options.maxResults) {
      return {
        matches: matches.slice(0, options.maxResults),
        truncated: true,
      };
    }
  }
  return {
    matches,
    truncated: false,
  };
}

export function classifyProcessFailure(
  toolName: string,
  executable: string,
  command: string,
  cwd: string,
  result: ToolProcessResult,
): ToolStructuredError {
  if (result.timedOut) {
    return {
      type: "timeout",
      message: `${toolName} timed out after waiting for ${command}.`,
      retryable: true,
      toolName,
      command,
      cwd,
      exitCode: result.exitCode ?? undefined,
      stdout: result.stdout,
      stderr: result.stderr,
    };
  }
  if (result.spawnError?.code === "ENOENT") {
    return {
      type: "missing_dependency",
      message: `Missing executable required by ${toolName}: ${executable}.`,
      retryable: false,
      toolName,
      dependency: executable,
      command,
      cwd,
      stderr: result.spawnError.message,
    };
  }
  return {
    type: "command_failed",
    message: `${toolName} command failed with exit code ${result.exitCode}.`,
    retryable: true,
    toolName,
    command,
    cwd,
    exitCode: result.exitCode ?? undefined,
    stdout: result.stdout,
    stderr: result.stderr,
  };
}

function classifyFallbackException(
  toolName: string,
  error: unknown,
  details: { cwd: string; command?: string },
): ToolStructuredError {
  const value = error as NodeJS.ErrnoException;
  if (value.code === "ENOENT" || value.code === "ENOTDIR" || value.code === "EISDIR") {
    return {
      type: "invalid_path",
      message: value.message,
      retryable: false,
      toolName,
      cwd: details.cwd,
    };
  }
  return {
    type: "command_failed",
    message: value.message,
    retryable: true,
    toolName,
    cwd: details.cwd,
    command: details.command,
  };
}

export function buildFallbackFailureResult(
  toolName: string,
  context: RuntimeToolExecutionContext,
  error: unknown,
  details: { cwd: string; command?: string },
  structuredContent: Record<string, unknown>,
): ToolResult {
  const structuredError = classifyFallbackException(toolName, error, details);
  const timestamp = context.moduleContext.clock.now();
  const fullResult = {
    ...structuredContent,
    error: structuredError,
  };
  return {
    toolName,
    callId: context.callId,
    startedAt: timestamp,
    endedAt: timestamp,
    success: false,
    output: JSON.stringify(fullResult),
    structuredContent: fullResult,
    error: structuredError.message,
  };
}
