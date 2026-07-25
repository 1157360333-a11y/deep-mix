import { promises as fs } from "node:fs";

import type { ToolAccessRequest, ToolResult } from "../../../../shared-schema/src/index.js";
import {
  formatSearchMatches,
  listFilesWithNodeFs,
  searchFilesWithNodeFs,
} from "../../repository-explorer.js";
import type {
  RuntimeToolExecutionContext,
  RuntimeToolSpec,
  ToolModule,
} from "../../tool-module.js";

import {
  buildFallbackFailureResult,
  buildListOutput,
  classifyProcessFailure,
  formatWithLineNumbers,
  normalizeRelativePath,
  parseRipgrepFileList,
  parseRipgrepSearchMatches,
  toWorkspaceRelativePath,
} from "./helpers.js";

interface ReadFileArgs {
  path: string;
  startLine?: number;
  endLine?: number;
  maxChars?: number;
}

interface SearchFilesArgs {
  pattern: string;
  cwd?: string;
  glob?: string;
  exclude?: string[];
  maxResults?: number;
  maxFileBytes?: number;
}

interface ListFilesArgs {
  cwd?: string;
  glob?: string;
  exclude?: string[];
  maxDepth?: number;
  maxResults?: number;
}

const DEFAULT_LIST_MAX_DEPTH = 64;
const DEFAULT_LIST_MAX_RESULTS = 5_000;
const DEFAULT_SEARCH_MAX_RESULTS = 5_000;
const DEFAULT_SEARCH_MAX_FILE_BYTES = 10 * 1024 * 1024;
const MAX_READ_FILE_CHARS = 2_000_000;
const DEFAULT_READ_FILE_CHARS = MAX_READ_FILE_CHARS;

type ReadFileTruncationReason = "max_chars" | "oversized_line";

interface ReadFileSlice {
  content: string;
  returnedStartLine: number;
  returnedEndLine?: number;
  returnedChars: number;
  nextStartLine?: number;
  rangeComplete: boolean;
  truncationReason?: ReadFileTruncationReason;
}

function sliceReadFileRange(
  lines: string[],
  startLine: number,
  endLine: number,
  maxChars: number,
): ReadFileSlice {
  const selectedLines = endLine >= startLine ? lines.slice(startLine - 1, endLine) : [];
  const selectedContent = selectedLines.join("\n");
  if (selectedContent.length <= maxChars) {
    return {
      content: selectedContent,
      returnedStartLine: startLine,
      returnedEndLine: selectedLines.length > 0 ? startLine + selectedLines.length - 1 : undefined,
      returnedChars: selectedContent.length,
      rangeComplete: true,
    };
  }

  const boundedPrefix = selectedContent.slice(0, maxChars);
  const lastCompleteNewline = boundedPrefix.lastIndexOf("\n");
  if (lastCompleteNewline >= 0) {
    const content = boundedPrefix.slice(0, lastCompleteNewline);
    const completeLineCount = content.split("\n").length;
    const nextStartLine = startLine + completeLineCount;
    return {
      content,
      returnedStartLine: startLine,
      returnedEndLine: nextStartLine - 1,
      returnedChars: content.length,
      nextStartLine: nextStartLine <= endLine ? nextStartLine : undefined,
      rangeComplete: false,
      truncationReason: "max_chars",
    };
  }

  if (selectedContent[maxChars] === "\n") {
    return {
      content: boundedPrefix,
      returnedStartLine: startLine,
      returnedEndLine: startLine,
      returnedChars: boundedPrefix.length,
      nextStartLine: startLine + 1 <= endLine ? startLine + 1 : undefined,
      rangeComplete: false,
      truncationReason: "max_chars",
    };
  }

  const content = selectedLines[0]?.slice(0, maxChars) ?? "";
  const nextStartLine = startLine + 1;
  return {
    content,
    returnedStartLine: startLine,
    returnedEndLine: selectedLines.length > 0 ? startLine : undefined,
    returnedChars: content.length,
    nextStartLine: nextStartLine <= endLine ? nextStartLine : undefined,
    rangeComplete: false,
    truncationReason: "oversized_line",
  };
}

function formatReadFileTruncation(input: {
  slice: ReadFileSlice;
  totalLines: number;
  totalChars: number;
  maxChars: number;
}): string {
  const range = input.slice.returnedEndLine === undefined
    ? "none"
    : `${input.slice.returnedStartLine}-${input.slice.returnedEndLine}`;
  const next = input.slice.nextStartLine === undefined ? "unavailable" : String(input.slice.nextStartLine);
  const notice = [
    `[read_file truncated: returned lines ${range}`,
    `returnedChars=${input.slice.returnedChars}`,
    `totalLines=${input.totalLines}`,
    `totalChars=${input.totalChars}`,
    `maxChars=${input.maxChars}`,
    `reason=${input.slice.truncationReason}`,
    `nextStartLine=${next}]`,
  ].join("; ");
  if (input.slice.truncationReason !== "oversized_line") {
    return notice;
  }
  return `${notice}\n[warning: the returned line itself exceeds maxChars; its remaining characters were not returned.]`;
}

function createSuccessResult(
  toolName: string,
  output: string,
  structuredContent: Record<string, unknown>,
  context: RuntimeToolExecutionContext,
): ToolResult {
  const timestamp = context.moduleContext.clock.now();
  return {
    toolName,
    callId: context.callId,
    startedAt: timestamp,
    endedAt: timestamp,
    success: true,
    output,
    structuredContent,
  };
}

function repositorySelection(): Pick<RuntimeToolSpec, "groups" | "selection"> {
  return {
    groups: ["core", "repository"],
    selection: {
      alwaysAvailable: true,
      groups: ["core", "repository"],
    },
  };
}

const readFileTool: RuntimeToolSpec = {
  name: "read_file",
  description: "Read up to 2,000,000 UTF-8 source characters from a workspace file with an optional line range.",
  inputSchema: {
    type: "object",
    additionalProperties: false,
    required: ["path"],
    properties: {
      path: { type: "string" },
      startLine: { type: "integer", minimum: 1 },
      endLine: { type: "integer", minimum: 1 },
      maxChars: { type: "integer", minimum: 1, maximum: MAX_READ_FILE_CHARS, default: DEFAULT_READ_FILE_CHARS },
    },
  },
  readOnly: true,
  permissionCategory: "read_only",
  sideEffectLevel: "none",
  timeoutCategory: "fast",
  ...repositorySelection(),
  resolveAccess: (rawArgs, context): ToolAccessRequest[] => {
    const args = rawArgs as ReadFileArgs;
    return [
      {
        kind: "filesystem_read",
        paths: [context.paths.normalize(args.path)],
        reason: "Read the requested workspace or trusted artifact text file.",
      },
    ];
  },
  execute: async (rawArgs, context) => {
    const args = rawArgs as ReadFileArgs;
    const resolved = await context.moduleContext.paths.resolveReadable(args.path);
    const content = (await resolved.readBytes()).toString("utf8");
    const lines = content.split(/\r?\n/);
    const startLine = Math.max(1, args.startLine ?? 1);
    const endLine = Math.min(lines.length, args.endLine ?? lines.length);
    const maxChars = args.maxChars ?? DEFAULT_READ_FILE_CHARS;
    const slice = sliceReadFileRange(lines, startLine, endLine, maxChars);
    const truncated = !slice.rangeComplete;
    const fileComplete = slice.rangeComplete && slice.returnedEndLine === lines.length;
    const resultPath =
      resolved.workspaceRelativePath ??
      resolved.artifactRef ??
      context.moduleContext.paths.normalize(args.path);
    const numberedContent = formatWithLineNumbers(slice.content, slice.returnedStartLine);
    const output = truncated
      ? `${numberedContent}\n${formatReadFileTruncation({
          slice,
          totalLines: lines.length,
          totalChars: content.length,
          maxChars,
        })}`
      : numberedContent;
    return createSuccessResult(
      "read_file",
      output,
      {
        kind: "read_file",
        path: resultPath,
        startLine,
        endLine,
        content: slice.content,
        truncated,
        totalLines: lines.length,
        totalChars: content.length,
        returnedStartLine: slice.returnedStartLine,
        returnedEndLine: slice.returnedEndLine,
        returnedChars: slice.returnedChars,
        nextStartLine: slice.nextStartLine,
        rangeComplete: slice.rangeComplete,
        fileComplete,
        truncationReason: slice.truncationReason,
      },
      context,
    );
  },
};

const searchFilesTool: RuntimeToolSpec = {
  name: "search_files",
  description: "Search text contents inside workspace files using ripgrep with a Node.js fallback. This does not search file names; use list_files, glob_files, or file_metadata to establish path existence.",
  inputSchema: {
    type: "object",
    additionalProperties: false,
    required: ["pattern"],
    properties: {
      pattern: { type: "string" },
      cwd: { type: "string" },
      glob: { type: "string" },
      exclude: {
        type: "array",
        items: { type: "string" },
      },
      maxResults: { type: "integer", minimum: 1, maximum: 5_000, default: DEFAULT_SEARCH_MAX_RESULTS },
      maxFileBytes: { type: "integer", minimum: 1024, maximum: 10 * 1024 * 1024, default: DEFAULT_SEARCH_MAX_FILE_BYTES },
    },
  },
  readOnly: true,
  permissionCategory: "read_only",
  sideEffectLevel: "none",
  timeoutCategory: "fast",
  ...repositorySelection(),
  capabilityRequirements: [
    {
      name: "rg",
      required: false,
      fallback: "node_text",
      reason: "Node text search preserves repository search when ripgrep is unavailable.",
    },
  ],
  resolveAccess: (rawArgs, context): ToolAccessRequest[] => {
    const args = rawArgs as SearchFilesArgs;
    return [
      {
        kind: "filesystem_read",
        paths: [context.paths.normalize(args.cwd ?? ".")],
        reason: "Traverse and search readable workspace files.",
      },
    ];
  },
  execute: async (rawArgs, context) => {
    const args = rawArgs as SearchFilesArgs;
    const cwd = context.moduleContext.paths.resolveWorkspace(args.cwd ?? ".");
    const normalizedCwd = toWorkspaceRelativePath(context.workspaceRoot, cwd);
    const maxResults = args.maxResults ?? DEFAULT_SEARCH_MAX_RESULTS;
    const maxFileBytes = args.maxFileBytes ?? DEFAULT_SEARCH_MAX_FILE_BYTES;
    const exclude = Array.isArray(args.exclude)
      ? args.exclude.map((value) => normalizeRelativePath(value))
      : undefined;
    const rgCapability = await context.moduleContext.capabilities.get("rg");
    const attempts: Array<Record<string, unknown>> = [];

    if (rgCapability?.available) {
      const rgArgs = [
        "--json",
        "--line-number",
        "--hidden",
        "--max-count",
        String(maxResults + 1),
        "--max-filesize",
        `${Math.max(1, Math.floor(maxFileBytes / 1024))}K`,
      ];
      if (args.glob) {
        rgArgs.push("--glob", args.glob);
      }
      rgArgs.push(args.pattern, ".");
      const rgResult = await context.moduleContext.processes.run({
        command: rgCapability.command,
        args: rgArgs,
        mode: "direct",
        cwd,
        timeoutMs: 20000,
        environment: context.moduleContext.environment,
      });
      if (!rgResult.spawnError && (rgResult.exitCode === 0 || rgResult.exitCode === 1)) {
        const parsed = parseRipgrepSearchMatches(
          rgResult.stdout,
          context.workspaceRoot,
          cwd,
          {
            glob: args.glob,
            exclude,
            maxResults,
          },
        );
        return createSuccessResult(
          "search_files",
          formatSearchMatches(parsed.matches, {
            cwd: normalizedCwd,
            glob: args.glob,
            maxResults,
            maxFileBytes,
            truncated: parsed.truncated,
          }),
          {
            kind: "search_files",
            queryKind: "file_content",
            cwd: normalizedCwd,
            pattern: args.pattern,
            glob: args.glob,
            strategy: "rg",
            fallbackUsed: false,
            truncated: parsed.truncated,
            maxResults,
            maxFileBytes,
            pathExistenceEstablished: false,
            matches: parsed.matches,
          },
          context,
        );
      }
      const rgError = classifyProcessFailure(
        "search_files",
        rgCapability.command,
        `${rgCapability.command} ${rgArgs.join(" ")}`,
        normalizedCwd,
        rgResult,
      );
      attempts.push({
        strategy: "rg",
        success: false,
        error: rgError,
      });
    } else {
      attempts.push({
        strategy: "rg",
        success: false,
        skipped: true,
        reason: rgCapability?.message ?? "missing",
      });
    }

    try {
      const fallback = await searchFilesWithNodeFs({
        workspaceRoot: context.workspaceRoot,
        cwd,
        pattern: args.pattern,
        glob: args.glob,
        exclude,
        maxResults,
        maxFileBytes,
      });
      return createSuccessResult(
        "search_files",
        formatSearchMatches(fallback.matches, {
          cwd: normalizedCwd,
          glob: args.glob,
          maxResults,
          maxFileBytes,
          truncated: fallback.truncated,
          skippedBinaryFiles: fallback.skippedBinaryFiles,
          skippedLargeFiles: fallback.skippedLargeFiles,
        }),
        {
          kind: "search_files",
          queryKind: "file_content",
          cwd: normalizedCwd,
          pattern: args.pattern,
          glob: args.glob,
          strategy: "node_text",
          fallbackUsed: true,
          truncated: fallback.truncated,
          maxResults,
          maxFileBytes,
          pathExistenceEstablished: false,
          matches: fallback.matches,
          skippedBinaryFiles: fallback.skippedBinaryFiles,
          skippedLargeFiles: fallback.skippedLargeFiles,
          attempts,
        },
        context,
      );
    } catch (error) {
      return buildFallbackFailureResult(
        "search_files",
        context,
        error,
        {
          cwd: normalizedCwd,
          command: args.pattern,
        },
        {
          kind: "search_files",
          cwd: normalizedCwd,
          attempts,
        },
      );
    }
  },
};

const listFilesTool: RuntimeToolSpec = {
  name: "list_files",
  description: "List workspace file paths using ripgrep with a Node.js fallback. The result explicitly reports whether maxResults truncated the requested scope.",
  inputSchema: {
    type: "object",
    additionalProperties: false,
    properties: {
      cwd: { type: "string" },
      glob: { type: "string" },
      exclude: {
        type: "array",
        items: { type: "string" },
      },
      maxDepth: { type: "integer", minimum: 0, maximum: 64, default: DEFAULT_LIST_MAX_DEPTH },
      maxResults: { type: "integer", minimum: 1, maximum: 5_000, default: DEFAULT_LIST_MAX_RESULTS },
    },
  },
  readOnly: true,
  permissionCategory: "read_only",
  sideEffectLevel: "none",
  timeoutCategory: "fast",
  ...repositorySelection(),
  capabilityRequirements: [
    {
      name: "rg",
      required: false,
      fallback: "node_fs",
      reason: "Node filesystem traversal preserves listing when ripgrep is unavailable.",
    },
  ],
  resolveAccess: (rawArgs, context): ToolAccessRequest[] => {
    const args = (rawArgs ?? {}) as ListFilesArgs;
    return [
      {
        kind: "filesystem_read",
        paths: [context.paths.normalize(args.cwd ?? ".")],
        reason: "Traverse readable workspace files.",
      },
    ];
  },
  execute: async (rawArgs, context) => {
    const args = (rawArgs ?? {}) as ListFilesArgs;
    const cwd = context.moduleContext.paths.resolveWorkspace(args.cwd ?? ".");
    const normalizedCwd = toWorkspaceRelativePath(context.workspaceRoot, cwd);
    const maxDepth = args.maxDepth ?? DEFAULT_LIST_MAX_DEPTH;
    const maxResults = args.maxResults ?? DEFAULT_LIST_MAX_RESULTS;
    const exclude = Array.isArray(args.exclude)
      ? args.exclude.map((value) => normalizeRelativePath(value))
      : undefined;
    const rgCapability = await context.moduleContext.capabilities.get("rg");
    const attempts: Array<Record<string, unknown>> = [];

    if (rgCapability?.available) {
      const rgArgs = ["--files", "--hidden", "--max-depth", String(maxDepth)];
      if (args.glob) {
        rgArgs.push("--glob", args.glob);
      }
      rgArgs.push(".");
      const rgResult = await context.moduleContext.processes.run({
        command: rgCapability.command,
        args: rgArgs,
        mode: "direct",
        cwd,
        timeoutMs: 20000,
        environment: context.moduleContext.environment,
      });
      if (!rgResult.spawnError && rgResult.exitCode === 0) {
        const parsed = parseRipgrepFileList(
          rgResult.stdout,
          context.workspaceRoot,
          cwd,
          {
            glob: args.glob,
            exclude,
            maxResults,
          },
        );
        return createSuccessResult(
          "list_files",
          buildListOutput(parsed.files, {
            cwd: normalizedCwd,
            glob: args.glob,
            maxDepth,
            maxResults,
            truncated: parsed.truncated,
          }),
          {
            kind: "list_files",
            cwd: normalizedCwd,
            glob: args.glob,
            strategy: "rg",
            fallbackUsed: false,
            truncated: parsed.truncated,
            resultComplete: !parsed.truncated,
            returnedCount: parsed.files.length,
            maxDepth,
            maxResults,
            files: parsed.files,
          },
          context,
        );
      }
      const rgError = classifyProcessFailure(
        "list_files",
        rgCapability.command,
        `${rgCapability.command} ${rgArgs.join(" ")}`,
        normalizedCwd,
        rgResult,
      );
      attempts.push({
        strategy: "rg",
        success: false,
        error: rgError,
      });
    } else {
      attempts.push({
        strategy: "rg",
        success: false,
        skipped: true,
        reason: rgCapability?.message ?? "missing",
      });
    }

    try {
      const fallback = await listFilesWithNodeFs({
        workspaceRoot: context.workspaceRoot,
        cwd,
        glob: args.glob,
        exclude,
        maxDepth,
        maxResults,
      });
      return createSuccessResult(
        "list_files",
        buildListOutput(fallback.files, {
          cwd: normalizedCwd,
          glob: args.glob,
          maxDepth,
          maxResults,
          truncated: fallback.truncated,
        }),
        {
          kind: "list_files",
          cwd: normalizedCwd,
          glob: args.glob,
          strategy: "node_fs",
          fallbackUsed: true,
          truncated: fallback.truncated,
          resultComplete: !fallback.truncated,
          returnedCount: fallback.files.length,
          maxDepth,
          maxResults,
          files: fallback.files,
          attempts,
        },
        context,
      );
    } catch (error) {
      return buildFallbackFailureResult(
        "list_files",
        context,
        error,
        { cwd: normalizedCwd },
        {
          kind: "list_files",
          cwd: normalizedCwd,
          attempts,
        },
      );
    }
  },
};

export const repositoryToolModule: ToolModule = {
  manifest: {
    id: "builtin.repository",
    version: "1.0.0",
    description: "Built-in workspace text reading, search, and file listing tools.",
    source: "built_in",
  },
  create: () => [readFileTool, searchFilesTool, listFilesTool],
};
