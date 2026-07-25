import type { DiagnosticEntry, ToolAccessRequest, ToolResult } from "../../../../shared-schema/src/index.js";
import {
  runLspDiagnostics,
  runSimpleLintDiagnostics,
  runTypecheckDiagnostics,
} from "../../../../diagnostics/src/index.js";

import type {
  RuntimeToolExecutionContext,
  RuntimeToolSpec,
  ToolModule,
  ToolModuleContext,
} from "../../tool-module.js";

interface DiagnosticArgs {
  paths?: string[];
}

type DiagnosticRunner = (
  workspaceRoot: string,
  paths: string[],
) => Promise<DiagnosticEntry>;

const diagnosticInputSchema = {
  type: "object",
  additionalProperties: false,
  properties: {
    paths: {
      type: "array",
      items: { type: "string" },
    },
  },
} as const;

function normalizePaths(args: DiagnosticArgs, context: ToolModuleContext): string[] {
  return Array.isArray(args.paths)
    ? args.paths.map((value) => context.paths.normalize(value))
    : [];
}

function createResult(
  toolName: string,
  entry: DiagnosticEntry,
  context: RuntimeToolExecutionContext,
): ToolResult<DiagnosticEntry> {
  const timestamp = context.moduleContext.clock.now();
  return {
    toolName,
    callId: context.callId,
    startedAt: timestamp,
    endedAt: timestamp,
    success: entry.ok,
    output: JSON.stringify(entry),
    structuredContent: entry,
    error: entry.ok ? undefined : entry.summary,
  };
}

function createDiagnosticTool(input: {
  name: "lsp_diagnostics" | "lint_diagnostics" | "typecheck_diagnostics";
  description: string;
  keywords: string[];
  runner: DiagnosticRunner;
  resolvePaths: (args: DiagnosticArgs, context: ToolModuleContext) => string[];
}): RuntimeToolSpec {
  return {
    name: input.name,
    description: input.description,
    inputSchema: diagnosticInputSchema,
    readOnly: true,
    permissionCategory: "read_only",
    sideEffectLevel: "none",
    timeoutCategory: "slow",
    groups: ["diagnostics"],
    selection: {
      groups: ["diagnostics"],
      keywords: input.keywords,
    },
    resolveAccess: (rawArgs, context): ToolAccessRequest[] => {
      const paths = input.resolvePaths((rawArgs ?? {}) as DiagnosticArgs, context);
      return [
        {
          kind: "filesystem_read",
          paths,
          reason: `Read workspace sources required by ${input.name}.`,
        },
      ];
    },
    execute: async (rawArgs, context) => {
      const paths = normalizePaths((rawArgs ?? {}) as DiagnosticArgs, context.moduleContext);
      const entry = await input.runner(context.workspaceRoot, paths);
      return createResult(input.name, entry, context);
    },
  };
}

export const diagnosticsToolModule: ToolModule = {
  manifest: {
    id: "builtin.diagnostics",
    version: "1.0.0",
    description: "Built-in LSP, lint, and typecheck diagnostics.",
    source: "built_in",
  },
  create: () => [
    createDiagnosticTool({
      name: "lsp_diagnostics",
      description: "Collect built-in TypeScript LSP-style diagnostics for edited files.",
      keywords: ["lsp", "diagnostic", "diagnostics", "typescript", "诊断"],
      runner: runLspDiagnostics,
      // TypeScript program construction can read tsconfig.json and transitive project sources.
      resolvePaths: () => ["."],
    }),
    createDiagnosticTool({
      name: "lint_diagnostics",
      description: "Collect built-in lint diagnostics for edited text files.",
      keywords: ["lint", "diagnostic", "diagnostics", "style", "代码检查"],
      runner: runSimpleLintDiagnostics,
      resolvePaths: (args, context) => normalizePaths(args, context),
    }),
    createDiagnosticTool({
      name: "typecheck_diagnostics",
      description: "Collect built-in project typecheck diagnostics for the current workspace.",
      keywords: ["typecheck", "type check", "typescript", "diagnostic", "类型检查"],
      runner: runTypecheckDiagnostics,
      // Typechecking resolves the full project graph even when results are filtered to paths.
      resolvePaths: () => ["."],
    }),
  ],
};
