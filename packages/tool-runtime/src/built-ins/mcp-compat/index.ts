import type { RuntimeToolSpec, ToolModule } from "../../tool-module.js";

interface InvokeMcpToolArgs {
  server: string;
  tool: string;
  input?: unknown;
}

function createInvokeMcpTool(): RuntimeToolSpec {
  return {
    name: "invoke_mcp_tool",
    description: "Invoke an opaque external MCP tool through the permission layer without exposing a full MCP hub.",
    inputSchema: {
      type: "object",
      additionalProperties: false,
      required: ["server", "tool"],
      properties: {
        server: { type: "string", minLength: 1 },
        tool: { type: "string", minLength: 1 },
        input: {},
      },
    },
    readOnly: false,
    permissionCategory: "external_mcp",
    sideEffectLevel: "high",
    timeoutCategory: "default",
    groups: ["mcp", "compatibility"],
    selection: {
      alwaysAvailable: true,
      groups: ["mcp", "compatibility"],
      keywords: ["mcp", "external tool", "外部工具"],
    },
    resolveAccess: (rawArgs) => {
      const args = rawArgs as InvokeMcpToolArgs;
      return [
        {
          kind: "external_system",
          systems: [args.server],
          reason: `Invoke MCP tool ${args.server}/${args.tool} through the compatibility executor.`,
        },
      ];
    },
    execute: async (rawArgs, context) => {
      const args = rawArgs as InvokeMcpToolArgs;
      const startedAt = context.moduleContext.clock.now();
      const executor = context.moduleContext.optional.mcpExecutor;
      if (!executor || context.moduleContext.optional.mcpRegistry) {
        throw new Error("The opaque MCP compatibility executor is unavailable.");
      }
      const result = await executor({
        server: args.server,
        tool: args.tool,
        input: args.input,
      });
      const visibleResult = {
        rawOutput: result.output,
        ...(result.structuredContent === undefined ? {} : { structuredContent: result.structuredContent }),
      };
      return {
        toolName: "invoke_mcp_tool",
        callId: context.callId,
        startedAt,
        endedAt: context.moduleContext.clock.now(),
        success: true,
        output: JSON.stringify(visibleResult),
        structuredContent: result.structuredContent,
      };
    },
  };
}

export const mcpCompatToolModule: ToolModule = {
  manifest: {
    id: "builtin.mcp-compat",
    version: "1.0.0",
    description: "Compatibility bridge for the legacy opaque MCP executor injection.",
    source: "built_in",
  },
  create: (context) =>
    context.optional.mcpExecutor && !context.optional.mcpRegistry
      ? [createInvokeMcpTool()]
      : [],
};
