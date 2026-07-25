import type {
  InvokeCodingWorkerResult,
  InvokeVisionWorkerResult,
  WorkerContextRef,
} from "../../../../shared-schema/src/index.js";
import { buildCodingWorkerTask } from "../../../../worker-glm-coding/src/index.js";
import { buildVisionWorkerTask } from "../../../../worker-kimi-vision/src/index.js";

import type { RuntimeToolSpec, ToolModule } from "../../tool-module.js";

interface CodingWorkerArgs {
  workerType: "coding";
  objective: string;
  constraints: string[];
  contextRefs: WorkerContextRef[];
  expectedOutput: "code_artifact";
  acceptanceChecks: string[];
}

interface VisionWorkerArgs {
  workerType: "vision";
  taskType: "ocr_extract" | "ui_parse" | "error_screenshot" | "diagram_parse";
  image: {
    sourceType: "local_path" | "uploaded_file" | "browser_capture";
    ref: string;
    crop?: {
      x: number;
      y: number;
      width: number;
      height: number;
    };
  };
  instructions?: string;
  constraints?: string[];
}

function createCodingWorkerTool(): RuntimeToolSpec {
  return {
    name: "invoke_coding_worker",
    description:
      "Route a complex coding task to the isolated GLM coding worker and return the complete structured CodeArtifact record, including its patch reference, changed files, validation commands, risks, and metadata.",
    inputSchema: {
      type: "object",
      additionalProperties: false,
      required: [
        "workerType",
        "objective",
        "constraints",
        "contextRefs",
        "expectedOutput",
        "acceptanceChecks",
      ],
      properties: {
        workerType: { type: "string", enum: ["coding"] },
        objective: { type: "string", minLength: 1 },
        constraints: {
          type: "array",
          items: { type: "string", minLength: 1 },
        },
        contextRefs: {
          type: "array",
          items: {
            oneOf: [
              { type: "string", pattern: "^(file|artifact)://.+" },
              {
                type: "object",
                additionalProperties: false,
                required: ["refType", "label", "summary"],
                properties: {
                  refType: { const: "summary" },
                  label: { type: "string", minLength: 1 },
                  summary: { type: "string", minLength: 1, maxLength: 4000 },
                },
              },
            ],
          },
        },
        expectedOutput: { type: "string", enum: ["code_artifact"] },
        acceptanceChecks: {
          type: "array",
          items: { type: "string", minLength: 1 },
        },
      },
    },
    readOnly: false,
    permissionCategory: "execute_command",
    sideEffectLevel: "low",
    timeoutCategory: "slow",
    groups: ["workers", "coding"],
    selection: {
      groups: ["workers", "coding"],
      workerRoutes: ["coding"],
      keywords: ["implement", "refactor", "coding worker", "代码", "实现", "重构", "修复", "编码"],
    },
    resolveAccess: (rawArgs) => {
      const args = rawArgs as CodingWorkerArgs;
      const refs = args.contextRefs.filter(
        (ref): ref is Extract<WorkerContextRef, string> => typeof ref === "string",
      );
      const readableRefs = refs.map((ref) => (ref.startsWith("file://") ? ref.slice("file://".length) : ref));
      return [
        ...(readableRefs.length > 0
          ? [
              {
                kind: "filesystem_read" as const,
                paths: readableRefs,
                reason: "Resolve the file and artifact context explicitly supplied to the coding worker.",
              },
            ]
          : []),
        {
          kind: "external_system" as const,
          systems: ["glm_coding_worker"],
          reason: "Invoke the isolated GLM coding worker through the injected worker service.",
        },
      ];
    },
    execute: async (rawArgs, context) => {
      const startedAt = context.moduleContext.clock.now();
      const workers = context.moduleContext.optional.workers;
      if (!workers) {
        throw new Error("Worker services are unavailable.");
      }
      try {
        const task = buildCodingWorkerTask(rawArgs);
        const result = await workers.invokeCodingWorker({
          parentSessionId: context.sessionId,
          task,
        });
        return {
          toolName: "invoke_coding_worker",
          callId: context.callId,
          startedAt,
          endedAt: context.moduleContext.clock.now(),
          success: result.artifact !== undefined,
          output: JSON.stringify(result, null, 2),
          structuredContent: result as InvokeCodingWorkerResult,
          error: result.error?.message,
        };
      } catch (error) {
        const body = {
          workerSessionId: "not_created",
          error: {
            errorType: "configuration_error" as const,
            message: (error as Error).message,
            retryable: false,
          },
        } satisfies InvokeCodingWorkerResult;
        return {
          toolName: "invoke_coding_worker",
          callId: context.callId,
          startedAt,
          endedAt: context.moduleContext.clock.now(),
          success: false,
          output: JSON.stringify(body, null, 2),
          error: (error as Error).message,
          structuredContent: body,
        };
      }
    },
  };
}

function createVisionWorkerTool(): RuntimeToolSpec {
  return {
    name: "invoke_vision_worker",
    description:
      "Route an image understanding task to the isolated Kimi vision worker and return the complete structured VisionArtifact record plus its artifact references.",
    inputSchema: {
      type: "object",
      additionalProperties: false,
      required: ["workerType", "taskType", "image"],
      properties: {
        workerType: { type: "string", enum: ["vision"] },
        taskType: {
          type: "string",
          enum: ["ocr_extract", "ui_parse", "error_screenshot", "diagram_parse"],
        },
        image: {
          type: "object",
          additionalProperties: false,
          required: ["sourceType", "ref"],
          properties: {
            sourceType: {
              type: "string",
              enum: ["local_path", "uploaded_file", "browser_capture"],
            },
            ref: { type: "string", pattern: "^(file|artifact)://.+" },
            crop: {
              type: "object",
              additionalProperties: false,
              required: ["x", "y", "width", "height"],
              properties: {
                x: { type: "number", minimum: 0 },
                y: { type: "number", minimum: 0 },
                width: { type: "number", exclusiveMinimum: 0 },
                height: { type: "number", exclusiveMinimum: 0 },
              },
            },
          },
        },
        instructions: { type: "string" },
        constraints: {
          type: "array",
          items: { type: "string", minLength: 1 },
        },
      },
    },
    readOnly: false,
    permissionCategory: "execute_command",
    sideEffectLevel: "low",
    timeoutCategory: "slow",
    groups: ["workers", "vision"],
    selection: {
      groups: ["workers", "vision"],
      workerRoutes: ["vision"],
      attachmentExtensions: [".png", ".jpg", ".jpeg", ".webp", ".gif"],
      mimeTypes: ["image/png", "image/jpeg", "image/webp", "image/gif"],
      keywords: ["image", "screenshot", "ocr", "diagram", "图片", "截图", "界面", "图表"],
    },
    resolveAccess: (rawArgs) => {
      const args = rawArgs as VisionWorkerArgs;
      return [
        {
          kind: "filesystem_read",
          paths: [
            args.image.ref.startsWith("file://")
              ? args.image.ref.slice("file://".length)
              : args.image.ref,
          ],
          reason: "Resolve the trusted image reference explicitly supplied to the vision worker.",
        },
        {
          kind: "external_system",
          systems: ["kimi_vision_worker"],
          reason: "Invoke the isolated Kimi vision worker through the injected worker service.",
        },
      ];
    },
    execute: async (rawArgs, context) => {
      const startedAt = context.moduleContext.clock.now();
      const workers = context.moduleContext.optional.workers;
      if (!workers) {
        throw new Error("Worker services are unavailable.");
      }
      try {
        const { input: visionInput, task } = buildVisionWorkerTask(rawArgs);
        const result = await workers.invokeVisionWorker({
          parentSessionId: context.sessionId,
          task,
          visionInput,
        });
        return {
          toolName: "invoke_vision_worker",
          callId: context.callId,
          startedAt,
          endedAt: context.moduleContext.clock.now(),
          success: result.artifact !== undefined,
          output: JSON.stringify(result, null, 2),
          structuredContent: result as InvokeVisionWorkerResult,
          error: result.error?.message,
        };
      } catch (error) {
        const body = {
          workerSessionId: "not_created",
          error: {
            errorType: "configuration_error" as const,
            message: (error as Error).message,
            retryable: false,
          },
        } satisfies InvokeVisionWorkerResult;
        return {
          toolName: "invoke_vision_worker",
          callId: context.callId,
          startedAt,
          endedAt: context.moduleContext.clock.now(),
          success: false,
          output: JSON.stringify(body, null, 2),
          error: (error as Error).message,
          structuredContent: body,
        };
      }
    },
  };
}

export const workersToolModule: ToolModule = {
  manifest: {
    id: "builtin.workers",
    version: "1.0.0",
    description: "Isolated coding and vision worker invocation tools.",
    source: "built_in",
  },
  create: (context) =>
    context.optional.workers
      ? [createCodingWorkerTool(), createVisionWorkerTool()]
      : [],
};
