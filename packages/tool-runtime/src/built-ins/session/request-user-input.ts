import type {
  ToolResult,
  UserInputOption,
  UserInputQuestion,
  UserInputRequestMode,
  UserInputRequestRecord,
} from "../../../../shared-schema/src/index.js";
import { USER_INPUT_LIMITS } from "../../../../shared-schema/src/index.js";

import type {
  RuntimeToolExecutionContext,
  RuntimeToolSpec,
  ToolModuleContext,
} from "../../tool-module.js";

interface RequestUserInputArgs {
  title?: string;
  mode?: UserInputRequestMode;
  questions: Array<{
    id: string;
    prompt: string;
    kind: UserInputQuestion["kind"];
    required?: boolean;
    options?: UserInputOption[];
    allowFreeform?: boolean;
    defaultValue?: UserInputQuestion["defaultValue"];
    placeholder?: string;
  }>;
}

function invalidResult(
  message: string,
  context: RuntimeToolExecutionContext,
  startedAt: string,
): ToolResult {
  const body = {
    error: {
      type: "invalid_arguments" as const,
      message,
      retryable: false,
      toolName: "request_user_input",
    },
  };
  return {
    toolName: "request_user_input",
    callId: context.callId,
    startedAt,
    endedAt: context.moduleContext.clock.now(),
    success: false,
    output: JSON.stringify(body),
    structuredContent: body,
    error: message,
  };
}

function normalizeOptions(options: UserInputOption[] | undefined): UserInputOption[] | undefined {
  return options?.map((option) => ({
    id: option.id.trim(),
    label: option.label.trim(),
    description: option.description?.trim() || undefined,
  }));
}

function validateAndNormalizeQuestions(
  questions: RequestUserInputArgs["questions"],
): { questions?: UserInputQuestion[]; error?: string } {
  const normalized: UserInputQuestion[] = [];
  const questionIds = new Set<string>();
  for (const question of questions) {
    const id = question.id.trim();
    const prompt = question.prompt.trim();
    if (!id || !prompt) return { error: "Question ids and prompts must contain non-whitespace text." };
    if (questionIds.has(id)) return { error: `Duplicate question id: ${id}.` };
    questionIds.add(id);

    const options = normalizeOptions(question.options);
    if (options?.some((option) => !option.id || !option.label)) {
      return { error: `Question ${id} has an option with an empty id or label.` };
    }
    if (options && new Set(options.map((option) => option.id)).size !== options.length) {
      return { error: `Question ${id} has duplicate option ids.` };
    }
    if (question.kind === "single_select" || question.kind === "multi_select") {
      if (!options || options.length < 2) {
        return { error: `Question ${id} requires at least two explicit options.` };
      }
    } else if (options && options.length > 0) {
      return { error: `Question ${id} of kind ${question.kind} cannot declare options.` };
    }
    if (question.allowFreeform && question.kind !== "single_select" && question.kind !== "multi_select") {
      return { error: `Question ${id} can allow freeform only for a select question.` };
    }

    const optionIds = new Set(options?.map((option) => option.id) ?? []);
    const defaultValue = question.defaultValue;
    if (defaultValue !== undefined) {
      if (question.kind === "confirm" && typeof defaultValue !== "boolean") {
        return { error: `Question ${id} requires a boolean default.` };
      }
      if ((question.kind === "text" || question.kind === "single_select") && typeof defaultValue !== "string") {
        return { error: `Question ${id} requires a string default.` };
      }
      if (question.kind === "multi_select" && !Array.isArray(defaultValue)) {
        return { error: `Question ${id} requires an array default.` };
      }
      if (
        question.kind === "multi_select" &&
        Array.isArray(defaultValue) &&
        (new Set(defaultValue).size !== defaultValue.length ||
          defaultValue.some((value) => typeof value !== "string" || !value || value.length > 80))
      ) {
        return { error: `Question ${id} default contains duplicate or invalid selections.` };
      }
      if (
        question.kind === "multi_select" &&
        Array.isArray(defaultValue) &&
        (question.required ?? true) &&
        defaultValue.length === 0
      ) {
        return { error: `Question ${id} requires a non-empty default selection.` };
      }
      if (
        question.kind === "single_select" &&
        typeof defaultValue === "string" &&
        !optionIds.has(defaultValue) &&
        !question.allowFreeform
      ) {
        return { error: `Question ${id} default must identify one declared option.` };
      }
      if (
        question.kind === "multi_select" &&
        Array.isArray(defaultValue) &&
        defaultValue.some((value) => !optionIds.has(value))
      ) {
        return { error: `Question ${id} default contains an unknown option id.` };
      }
    }

    normalized.push({
      id,
      prompt,
      kind: question.kind,
      required: question.required ?? true,
      options,
      allowFreeform: question.allowFreeform,
      defaultValue,
      placeholder: question.placeholder?.trim() || undefined,
    });
  }
  return { questions: normalized };
}

async function executeRequestUserInput(
  args: RequestUserInputArgs,
  context: RuntimeToolExecutionContext,
): Promise<ToolResult> {
  const startedAt = context.moduleContext.clock.now();
  const normalized = validateAndNormalizeQuestions(args.questions);
  if (!normalized.questions) return invalidResult(normalized.error ?? "Invalid questions.", context, startedAt);

  const session = await context.moduleContext.persistence.loadSession(context.sessionId);
  const turnId = context.turnId;
  if (!turnId || session?.activeTurnId !== turnId || session.status !== "running") {
    return invalidResult(
      "request_user_input requires the authoritative active turn and cannot attach to a superseding turn.",
      context,
      startedAt,
    );
  }

  const request: UserInputRequestRecord = {
    recordType: "user_input_request",
    requestId: context.moduleContext.ids.create(),
    sessionId: context.sessionId,
    turnId,
    toolCallId: context.callId,
    createdAt: context.moduleContext.clock.now(),
    mode: args.mode ?? "blocking",
    title: args.title?.trim() || undefined,
    questions: normalized.questions,
    status: "pending",
  };
  await context.moduleContext.persistence.recordUserInputRequest(request);
  const structuredContent = {
    kind: "user_input_request",
    request,
    message:
      request.mode === "blocking"
        ? "Waiting for an explicit user answer. Defaults are hints only and were not auto-submitted."
        : "The question was recorded without pausing this turn. Defaults are hints only and were not auto-submitted.",
  };
  return {
    toolName: "request_user_input",
    callId: context.callId,
    startedAt,
    endedAt: context.moduleContext.clock.now(),
    success: true,
    output: JSON.stringify(structuredContent),
    structuredContent,
    control: request.mode === "blocking"
      ? { type: "wait_for_user", requestId: request.requestId, blocking: true }
      : { type: "continue", requestId: request.requestId, blocking: false },
  };
}

export function createRequestUserInput(_context: ToolModuleContext): RuntimeToolSpec {
  return {
    name: "request_user_input",
    displayName: "Request User Input",
    description:
      "Ask up to three concise structured questions, persist them, and optionally pause the current turn until the user explicitly answers. Never invent or auto-submit an answer.",
    inputSchema: {
      type: "object",
      additionalProperties: false,
      required: ["questions"],
      properties: {
        title: { type: "string", minLength: 1, maxLength: 160, pattern: "\\S" },
        mode: { type: "string", enum: ["blocking", "non_blocking"] },
        questions: {
          type: "array",
          minItems: 1,
          maxItems: USER_INPUT_LIMITS.maxQuestionsPerRequest,
          items: {
            type: "object",
            additionalProperties: false,
            required: ["id", "prompt", "kind"],
            properties: {
              id: { type: "string", minLength: 1, maxLength: 80, pattern: "\\S" },
              prompt: {
                type: "string",
                minLength: 1,
                maxLength: USER_INPUT_LIMITS.maxPromptChars,
                pattern: "\\S",
              },
              kind: {
                type: "string",
                enum: ["single_select", "multi_select", "text", "confirm"],
              },
              required: { type: "boolean" },
              allowFreeform: { type: "boolean" },
              placeholder: { type: "string", maxLength: 200 },
              defaultValue: {
                anyOf: [
                  { type: "string", maxLength: USER_INPUT_LIMITS.maxFreeformChars },
                  { type: "boolean" },
                  {
                    type: "array",
                    maxItems: USER_INPUT_LIMITS.maxOptionsPerQuestion,
                    items: { type: "string", minLength: 1, maxLength: 80 },
                  },
                ],
              },
              options: {
                type: "array",
                minItems: 2,
                maxItems: USER_INPUT_LIMITS.maxOptionsPerQuestion,
                items: {
                  type: "object",
                  additionalProperties: false,
                  required: ["id", "label"],
                  properties: {
                    id: { type: "string", minLength: 1, maxLength: 80, pattern: "\\S" },
                    label: {
                      type: "string",
                      minLength: 1,
                      maxLength: USER_INPUT_LIMITS.maxOptionLabelChars,
                      pattern: "\\S",
                    },
                    description: { type: "string", maxLength: 240 },
                  },
                },
              },
            },
          },
        },
      },
    },
    readOnly: true,
    permissionCategory: "read_only",
    sideEffectLevel: "none",
    timeoutCategory: "fast",
    groups: ["session", "interaction", "user_input"],
    selection: {
      alwaysAvailable: true,
      groups: ["session", "interaction", "user_input"],
      keywords: [
        "ask user",
        "request input",
        "clarify with user",
        "询问用户",
        "请求输入",
        "需要确认",
        "向用户提问",
      ],
      attachmentExtensions: [],
      mimeTypes: [],
    },
    resolveAccess: () => [],
    execute: (rawArgs, executionContext) =>
      executeRequestUserInput(rawArgs as RequestUserInputArgs, executionContext),
  };
}
