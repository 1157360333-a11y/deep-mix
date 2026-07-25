import type {
  PlanItem,
  ToolResult,
  ToolStructuredError,
} from "../../../../shared-schema/src/index.js";

import type {
  RuntimeToolExecutionContext,
  RuntimeToolSpec,
  ToolModule,
} from "../../tool-module.js";

import { createRequestUserInput } from "./request-user-input.js";

interface UpdatePlanArgs {
  items: PlanItem[];
}

function invalidPlanResult(
  message: string,
  context: RuntimeToolExecutionContext,
  startedAt: string,
): ToolResult {
  const error: ToolStructuredError = {
    type: "invalid_arguments",
    message,
    retryable: false,
    toolName: "update_plan",
    fieldPath: "/items",
    details: [{ path: "/items", message }],
  };
  const body = { error };
  return {
    toolName: "update_plan",
    callId: context.callId,
    startedAt,
    endedAt: context.moduleContext.clock.now(),
    success: false,
    output: JSON.stringify(body),
    structuredContent: body,
    error: message,
  };
}

function createUpdatePlanTool(): RuntimeToolSpec {
  return {
    name: "update_plan",
    description: "Replace the current session plan with a validated set of plan items.",
    inputSchema: {
      type: "object",
      additionalProperties: false,
      required: ["items"],
      properties: {
        items: {
          type: "array",
          items: {
            type: "object",
            additionalProperties: false,
            required: ["id", "title", "status"],
            properties: {
              id: { type: "string" },
              title: { type: "string" },
              status: {
                type: "string",
                enum: ["pending", "in_progress", "completed", "blocked"],
              },
              notes: { type: "string" },
              blockedReason: { type: "string" },
            },
          },
        },
      },
    },
    readOnly: false,
    permissionCategory: "write_file",
    sideEffectLevel: "low",
    timeoutCategory: "fast",
    groups: ["session", "planning"],
    selection: {
      alwaysAvailable: true,
      groups: ["session", "planning"],
      keywords: ["plan", "steps", "计划", "步骤", "进度"],
    },
    resolveAccess: () => [],
    execute: async (rawArgs, context) => {
      const args = rawArgs as UpdatePlanArgs;
      const startedAt = context.moduleContext.clock.now();
      if (args.items.filter((item) => item.status === "in_progress").length > 1) {
        return invalidPlanResult("Only one plan item may be in_progress at a time.", context, startedAt);
      }
      const planItems = await context.moduleContext.persistence.updatePlanItems(
        context.sessionId,
        args.items,
      );
      return {
        toolName: "update_plan",
        callId: context.callId,
        startedAt,
        endedAt: context.moduleContext.clock.now(),
        success: true,
        output: JSON.stringify(planItems, null, 2),
        structuredContent: planItems,
      };
    },
  };
}

export const sessionToolModule: ToolModule = {
  manifest: {
    id: "builtin.session",
    version: "1.0.0",
    description: "Session-local planning tools backed by the injected persistence service.",
    source: "built_in",
  },
  create: (context) => [createUpdatePlanTool(), createRequestUserInput(context)],
};
