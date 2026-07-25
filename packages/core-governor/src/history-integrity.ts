import type {
  ContextSummaryRecord,
  HistoryIntegrityAction,
  HistoryIntegrityIssue,
  HistoryIntegrityOutcome,
  MessageRecord,
  SessionStatus,
  ToolOutputContextExposureSnapshot,
} from "../../shared-schema/src/index.js";
import { estimateMessageRecordBatchTokens, estimateMessageRecordTokens, estimateTextTokens } from "./context-usage.js";

const TOOL_TRUNCATION_SUFFIX = "\n...[raw tool output truncated by model context token budget; re-read a narrower range to continue]";
const PLAIN_TRUNCATION_SUFFIX = "\n...[message truncated for model history]";
const MIN_TOOL_MESSAGE_CHAR_LIMIT = 256;
export const TOOL_CONTEXT_SUMMARY_CANDIDATE_METADATA_KEY = "contextSummaryCandidate";
export const PROVIDER_TURN_CONTEXT_METADATA_KEY = "providerTurnContext";
// Kept as public compatibility exports. Post-exposure summaries now apply to
// every non-empty tool result instead of a giant-output allowlist.
export const TOOL_OUTPUT_SUMMARY_MIN_CHARS = 0;
export const POST_EXPOSURE_SUMMARY_TOOL_NAMES = ["*"] as const;

export function isPostExposureToolSummaryEligible(
  name: string | undefined,
  rawOutputChars: number,
): boolean {
  return typeof name === "string" &&
    name.trim().length > 0 &&
    Number.isFinite(rawOutputChars) &&
    rawOutputChars > TOOL_OUTPUT_SUMMARY_MIN_CHARS;
}

export function formatPostExposureToolSummary(input: {
  toolName?: string;
  rawOutputRef: string;
  summary: string;
}): string {
  return [
    `[summary source=${input.toolName ?? "tool"} raw=${input.rawOutputRef}]`,
    input.summary,
    "Exact raw output remains in the session audit log. If omitted details matter, obtain a fresh read-only observation; never repeat a side effect only to recover output text.",
  ].join("\n");
}

interface PendingToolGroup {
  assistant: MessageRecord;
  assistantIndex: number;
  expectedToolCallIds: string[];
  collectedToolMessages: MessageRecord[];
}

interface SanitizedHistory {
  messages: MessageRecord[];
  issues: HistoryIntegrityIssue[];
  actions: HistoryIntegrityAction[];
}

interface HistoryBlock {
  kind: "single" | "tool_group";
  messages: MessageRecord[];
  turnId?: string;
  toolCallIds: string[];
}

interface ToolGroupFitResult {
  messages: MessageRecord[];
  size: number;
  actions: HistoryIntegrityAction[];
}

interface SummaryLookupEntry {
  summaryId: string;
  summaryText: string;
  rawOutputRef?: string;
}

export interface HistoryIntegrityReport {
  outcome: HistoryIntegrityOutcome;
  summary: string;
  messageCountBefore: number;
  messageCountAfter: number;
  safeBoundaryTurnId?: string;
  issues: HistoryIntegrityIssue[];
  actions: HistoryIntegrityAction[];
}

export interface MessageHistoryValidationResult {
  valid: boolean;
  issues: HistoryIntegrityIssue[];
}

export interface PreparedMessageHistory {
  messages: MessageRecord[];
  report: HistoryIntegrityReport;
  estimatedTokensBefore: number;
  estimatedTokensAfter: number;
  usedSummaryIds: string[];
  toolOutputExposure: ToolOutputContextExposureSnapshot;
}

export class HistoryIntegrityError extends Error {
  public readonly scope: "resume_check" | "pre_model_request";

  public readonly report: HistoryIntegrityReport;

  public constructor(scope: "resume_check" | "pre_model_request", report: HistoryIntegrityReport) {
    const prefix = scope === "resume_check" ? "Local history integrity error before resume" : "Local history integrity error before model request";
    super(`${prefix}: ${report.summary}`);
    this.name = "HistoryIntegrityError";
    this.scope = scope;
    this.report = report;
  }
}

export class ProviderRequestError extends Error {
  public readonly report: HistoryIntegrityReport;

  public constructor(message: string, report: HistoryIntegrityReport) {
    super(`Provider request error after local history validation passed: ${message} | history=${report.summary}`);
    this.name = "ProviderRequestError";
    this.report = report;
  }
}

function cloneMessage(message: MessageRecord, overrides: Partial<MessageRecord>): MessageRecord {
  return {
    ...message,
    ...overrides,
    metadata: message.metadata ? { ...message.metadata } : undefined,
  };
}

function isProviderTurnContextMessage(message: MessageRecord): boolean {
  const marker = message.metadata?.[PROVIDER_TURN_CONTEXT_METADATA_KEY];
  return marker === true || (
    typeof marker === "object" &&
    marker !== null &&
    (marker as { version?: unknown }).version === 1
  );
}

function createIssue(
  type: HistoryIntegrityIssue["type"],
  detail: string,
  context: {
    turnId?: string;
    messageId?: string;
    toolCallId?: string;
  } = {},
): HistoryIntegrityIssue {
  return {
    type,
    detail,
    ...context,
  };
}

function createAction(
  type: HistoryIntegrityAction["type"],
  detail: string,
  context: {
    turnId?: string;
    messageIds?: string[];
    toolCallIds?: string[];
  } = {},
): HistoryIntegrityAction {
  return {
    type,
    detail,
    ...context,
  };
}

function countActions(actions: HistoryIntegrityAction[], type: HistoryIntegrityAction["type"]): number {
  return actions.filter((action) => action.type === type).length;
}

function estimateMessagesSize(messages: MessageRecord[]): number {
  return estimateMessageRecordBatchTokens(messages);
}

function truncateText(
  text: string,
  maxChars: number,
  suffix: string,
): {
  text: string;
  truncated: boolean;
} {
  if (text.length <= maxChars) {
    return {
      text,
      truncated: false,
    };
  }

  if (maxChars <= suffix.length) {
    return {
      text: suffix.slice(0, Math.max(0, maxChars)),
      truncated: true,
    };
  }

  return {
    text: `${text.slice(0, maxChars - suffix.length)}${suffix}`,
    truncated: true,
  };
}

function truncateTextToTokenBudget(
  text: string,
  tokenBudget: number,
  suffix: string,
): {
  text: string;
  truncated: boolean;
} {
  if (tokenBudget <= 0) {
    return {
      text: "",
      truncated: false,
    };
  }

  if (estimateTextTokens(text) <= tokenBudget) {
    return {
      text,
      truncated: false,
    };
  }

  let low = 0;
  let high = text.length;
  let best = truncateText(text, 0, suffix).text;

  while (low <= high) {
    const middle = Math.floor((low + high) / 2);
    const candidate = truncateText(text, middle, suffix).text;
    if (estimateTextTokens(candidate) <= tokenBudget) {
      best = candidate;
      low = middle + 1;
    } else {
      high = middle - 1;
    }
  }

  return {
    text: best,
    truncated: true,
  };
}

function buildSummaryLookup(contextSummaries: ContextSummaryRecord[] | undefined): {
  byToolCallId: Map<string, SummaryLookupEntry>;
  byMessageId: Map<string, SummaryLookupEntry>;
} {
  const byToolCallId = new Map<string, SummaryLookupEntry>();
  const byMessageId = new Map<string, SummaryLookupEntry>();

  for (const summary of contextSummaries ?? []) {
    if (summary.sourceType !== "tool_output") {
      continue;
    }
    if (summary.toolOutputLifecycle !== "raw_once_then_summary_v1") {
      continue;
    }
    const entry = {
      summaryId: summary.summaryId,
      summaryText: summary.summary,
      rawOutputRef: summary.rawOutputRef,
    };
    if (summary.sourceToolCallId) {
      byToolCallId.set(summary.sourceToolCallId, entry);
    }
    if (summary.sourceMessageId) {
      byMessageId.set(summary.sourceMessageId, entry);
    }
  }

  return {
    byToolCallId,
    byMessageId,
  };
}

function rewriteMessagesForModel(
  messages: MessageRecord[],
  contextSummaries: ContextSummaryRecord[] | undefined,
): {
  messages: MessageRecord[];
  summaryIdsByMessageId: Map<string, string>;
} {
  const lookup = buildSummaryLookup(contextSummaries);
  const summaryIdsByMessageId = new Map<string, string>();

  const rewritten = messages.map((message) => {
    if (message.role !== "tool") {
      return message;
    }

    const summary =
      (message.toolCallId ? lookup.byToolCallId.get(message.toolCallId) : undefined) ??
      lookup.byMessageId.get(message.messageId);
    if (!summary) {
      return message;
    }

    if (!isPostExposureToolSummaryEligible(message.name, message.content.length)) {
      return message;
    }

    const persistedCandidate = message.metadata?.[TOOL_CONTEXT_SUMMARY_CANDIDATE_METADATA_KEY];
    const hasPersistedCandidate =
      typeof persistedCandidate === "object" &&
      persistedCandidate !== null &&
      (persistedCandidate as { version?: unknown }).version === 1;
    if (!hasPersistedCandidate) {
      // Never trust a legacy standalone summary as evidence that an ordinary
      // tool result was shown raw. New summaries are promoted only after a
      // durable model response or tool-cycle checkpoint.
      return message;
    }

    const rawOutputRef = summary.rawOutputRef ?? `message://${message.messageId}`;
    const summaryText = formatPostExposureToolSummary({
      toolName: message.name,
      rawOutputRef,
      summary: summary.summaryText,
    });
    if (estimateTextTokens(summaryText) >= estimateTextTokens(message.content)) {
      return message;
    }

    summaryIdsByMessageId.set(message.messageId, summary.summaryId);
    return cloneMessage(message, {
      content: summaryText,
    });
  });

  return {
    messages: rewritten,
    summaryIdsByMessageId,
  };
}

function dropPendingGroup(
  sanitized: MessageRecord[],
  pendingGroup: PendingToolGroup,
  issues: HistoryIntegrityIssue[],
  actions: HistoryIntegrityAction[],
  issue: HistoryIntegrityIssue,
): void {
  issues.push(issue);
  sanitized.splice(pendingGroup.assistantIndex, sanitized.length - pendingGroup.assistantIndex);
  actions.push(
    createAction(
      "drop_incomplete_tool_group",
      `Dropped incomplete tool group for assistant message ${pendingGroup.assistant.messageId}.`,
      {
        turnId: pendingGroup.assistant.turnId,
        messageIds: [
          pendingGroup.assistant.messageId,
          ...pendingGroup.collectedToolMessages.map((message) => message.messageId),
        ],
        toolCallIds: pendingGroup.expectedToolCallIds,
      },
    ),
  );
}

function sanitizeMessageHistory(
  messages: MessageRecord[],
  options: {
    allowTrailingPendingToolGroup: boolean;
  },
): SanitizedHistory {
  const sanitized: MessageRecord[] = [];
  const issues: HistoryIntegrityIssue[] = [];
  const actions: HistoryIntegrityAction[] = [];
  let pendingGroup: PendingToolGroup | undefined;

  for (const originalMessage of messages) {
    let message: MessageRecord | undefined = originalMessage;

    while (message) {
      if (!pendingGroup) {
        if (message.role === "tool") {
          issues.push(
            createIssue(
              "orphan_tool",
              `Found tool message ${message.messageId} without a preceding assistant.tool_calls message.`,
              {
                turnId: message.turnId,
                messageId: message.messageId,
                toolCallId: message.toolCallId,
              },
            ),
          );
          issues.push(
            createIssue(
              "missing_assistant_tool_calls",
              `Tool message ${message.messageId} is missing its preceding assistant.tool_calls context.`,
              {
                turnId: message.turnId,
                messageId: message.messageId,
                toolCallId: message.toolCallId,
              },
            ),
          );
          actions.push(
            createAction("drop_orphan_tool", `Dropped orphan tool message ${message.messageId}.`, {
              turnId: message.turnId,
              messageIds: [message.messageId],
              toolCallIds: message.toolCallId ? [message.toolCallId] : undefined,
            }),
          );
          message = undefined;
          continue;
        }

        const assistantIndex = sanitized.length;
        sanitized.push(message);
        if (message.role === "assistant" && Array.isArray(message.toolCalls) && message.toolCalls.length > 0) {
          pendingGroup = {
            assistant: message,
            assistantIndex,
            expectedToolCallIds: message.toolCalls.map((toolCall) => toolCall.id),
            collectedToolMessages: [],
          };
        }
        message = undefined;
        continue;
      }

      if (message.role !== "tool") {
        dropPendingGroup(
          sanitized,
          pendingGroup,
          issues,
          actions,
          createIssue(
            "incomplete_tool_group",
            `Tool group for assistant message ${pendingGroup.assistant.messageId} ended before all tool responses arrived.`,
            {
              turnId: pendingGroup.assistant.turnId,
              messageId: pendingGroup.assistant.messageId,
              toolCallId: pendingGroup.expectedToolCallIds[pendingGroup.collectedToolMessages.length],
            },
          ),
        );
        pendingGroup = undefined;
        continue;
      }

      const expectedToolCallId = pendingGroup.expectedToolCallIds[pendingGroup.collectedToolMessages.length];
      if (message.toolCallId !== expectedToolCallId) {
        const issueType = pendingGroup.expectedToolCallIds.includes(message.toolCallId ?? "")
          ? "tool_call_order_mismatch"
          : "tool_call_id_not_found";
        dropPendingGroup(
          sanitized,
          pendingGroup,
          issues,
          actions,
          createIssue(
            issueType,
            `Tool message ${message.messageId} did not match the expected tool_call_id ${expectedToolCallId ?? "unknown"}.`,
            {
              turnId: message.turnId,
              messageId: message.messageId,
              toolCallId: message.toolCallId,
            },
          ),
        );
        pendingGroup = undefined;
        continue;
      }

      sanitized.push(message);
      pendingGroup.collectedToolMessages.push(message);
      if (pendingGroup.collectedToolMessages.length === pendingGroup.expectedToolCallIds.length) {
        pendingGroup = undefined;
      }
      message = undefined;
    }
  }

  if (pendingGroup && !options.allowTrailingPendingToolGroup) {
    dropPendingGroup(
      sanitized,
      pendingGroup,
      issues,
      actions,
      createIssue(
        "incomplete_tool_group",
        `Tool group for assistant message ${pendingGroup.assistant.messageId} was still incomplete at the end of history.`,
        {
          turnId: pendingGroup.assistant.turnId,
          messageId: pendingGroup.assistant.messageId,
          toolCallId: pendingGroup.expectedToolCallIds[pendingGroup.collectedToolMessages.length],
        },
      ),
    );
  }

  return {
    messages: sanitized,
    issues,
    actions,
  };
}

export function validateMessageHistory(
  messages: MessageRecord[],
  options: {
    allowTrailingPendingToolGroup?: boolean;
  } = {},
): MessageHistoryValidationResult {
  const issues: HistoryIntegrityIssue[] = [];
  let pendingGroup:
    | {
        assistant: MessageRecord;
        expectedToolCallIds: string[];
        matchedCount: number;
      }
    | undefined;

  for (const message of messages) {
    if (!pendingGroup) {
      if (message.role === "tool") {
        issues.push(
          createIssue(
            "orphan_tool",
            `Tool message ${message.messageId} has no preceding assistant.tool_calls message.`,
            {
              turnId: message.turnId,
              messageId: message.messageId,
              toolCallId: message.toolCallId,
            },
          ),
        );
        issues.push(
          createIssue(
            "missing_assistant_tool_calls",
            `Tool message ${message.messageId} is missing its assistant.tool_calls parent.`,
            {
              turnId: message.turnId,
              messageId: message.messageId,
              toolCallId: message.toolCallId,
            },
          ),
        );
        break;
      }

      if (message.role === "assistant" && Array.isArray(message.toolCalls) && message.toolCalls.length > 0) {
        pendingGroup = {
          assistant: message,
          expectedToolCallIds: message.toolCalls.map((toolCall) => toolCall.id),
          matchedCount: 0,
        };
      }
      continue;
    }

    if (message.role !== "tool") {
      issues.push(
        createIssue(
          "incomplete_tool_group",
          `Assistant message ${pendingGroup.assistant.messageId} is missing one or more tool responses.`,
          {
            turnId: pendingGroup.assistant.turnId,
            messageId: pendingGroup.assistant.messageId,
            toolCallId: pendingGroup.expectedToolCallIds[pendingGroup.matchedCount],
          },
        ),
      );
      break;
    }

    const expectedToolCallId = pendingGroup.expectedToolCallIds[pendingGroup.matchedCount];
    if (message.toolCallId !== expectedToolCallId) {
      issues.push(
        createIssue(
          pendingGroup.expectedToolCallIds.includes(message.toolCallId ?? "")
            ? "tool_call_order_mismatch"
            : "tool_call_id_not_found",
          `Tool message ${message.messageId} did not match the expected tool_call_id ${expectedToolCallId ?? "unknown"}.`,
          {
            turnId: message.turnId,
            messageId: message.messageId,
            toolCallId: message.toolCallId,
          },
        ),
      );
      break;
    }

    pendingGroup.matchedCount += 1;
    if (pendingGroup.matchedCount === pendingGroup.expectedToolCallIds.length) {
      pendingGroup = undefined;
    }
  }

  if (pendingGroup && !options.allowTrailingPendingToolGroup) {
    issues.push(
      createIssue(
        "incomplete_tool_group",
        `Assistant message ${pendingGroup.assistant.messageId} ended with missing tool responses.`,
        {
          turnId: pendingGroup.assistant.turnId,
          messageId: pendingGroup.assistant.messageId,
          toolCallId: pendingGroup.expectedToolCallIds[pendingGroup.matchedCount],
        },
      ),
    );
  }

  return {
    valid: issues.length === 0,
    issues,
  };
}

function buildHistoryBlocks(messages: MessageRecord[]): HistoryBlock[] {
  const blocks: HistoryBlock[] = [];

  for (let index = 0; index < messages.length; index += 1) {
    const message = messages[index]!;
    if (message.role === "assistant" && Array.isArray(message.toolCalls) && message.toolCalls.length > 0) {
      const groupMessages = [message];
      for (const toolCall of message.toolCalls) {
        index += 1;
        const toolMessage = messages[index];
        if (!toolMessage || toolMessage.role !== "tool" || toolMessage.toolCallId !== toolCall.id) {
          throw new Error(`Invariant violation while grouping tool history at assistant message ${message.messageId}.`);
        }
        groupMessages.push(toolMessage);
      }
      blocks.push({
        kind: "tool_group",
        messages: groupMessages,
        turnId: message.turnId,
        toolCallIds: message.toolCalls.map((toolCall) => toolCall.id),
      });
      continue;
    }

    blocks.push({
      kind: "single",
      messages: [message],
      turnId: message.turnId,
      toolCallIds: [],
    });
  }

  return blocks;
}

function applyToolMessageLimit(messages: MessageRecord[], toolMessageTokenLimit: number): ToolGroupFitResult {
  const actions: HistoryIntegrityAction[] = [];
  const limitedMessages = messages.map((message) => {
    if (message.role !== "tool") {
      return message;
    }

    const truncated = truncateTextToTokenBudget(message.content, toolMessageTokenLimit, TOOL_TRUNCATION_SUFFIX);
    if (!truncated.truncated) {
      return message;
    }

    actions.push(
      createAction("trim_tool_message", `Trimmed tool message ${message.messageId} for model history budgeting.`, {
        turnId: message.turnId,
        messageIds: [message.messageId],
        toolCallIds: message.toolCallId ? [message.toolCallId] : undefined,
      }),
    );
    return cloneMessage(message, {
      content: truncated.text,
    });
  });

  return {
    messages: limitedMessages,
    size: estimateMessagesSize(limitedMessages),
    actions,
  };
}

function fitToolGroupToBudget(messages: MessageRecord[], budget: number): ToolGroupFitResult | undefined {
  if (budget <= 0) {
    return undefined;
  }

  const toolMessages = messages.filter((message) => message.role === "tool");
  if (toolMessages.length === 0) {
    const size = estimateMessagesSize(messages);
    return size <= budget ? { messages, size, actions: [] } : undefined;
  }

  const fullSize = estimateMessagesSize(messages);
  if (fullSize <= budget) {
    return {
      messages,
      size: fullSize,
      actions: [],
    };
  }

  const minFit = applyToolMessageLimit(messages, Math.max(8, estimateTextTokens("x".repeat(MIN_TOOL_MESSAGE_CHAR_LIMIT))));
  if (minFit.size > budget) {
    return undefined;
  }

  let low = Math.max(8, estimateTextTokens("x".repeat(MIN_TOOL_MESSAGE_CHAR_LIMIT)));
  let high = Math.max(...toolMessages.map((message) => estimateTextTokens(message.content)));
  let bestFit = minFit;

  while (low <= high) {
    const middle = Math.floor((low + high) / 2);
    const candidate = applyToolMessageLimit(messages, middle);
    if (candidate.size <= budget) {
      bestFit = candidate;
      low = middle + 1;
    } else {
      high = middle - 1;
    }
  }

  return bestFit;
}

function truncatePlainMessageToBudget(message: MessageRecord, budget: number): {
  message: MessageRecord;
  action?: HistoryIntegrityAction;
  size: number;
} | undefined {
  if (budget <= 0) {
    return undefined;
  }

  const originalSize = estimateMessageRecordTokens(message);
  if (originalSize <= budget) {
    return {
      message,
      size: originalSize,
    };
  }

  const truncated = truncateTextToTokenBudget(message.content, Math.max(1, budget - 8), PLAIN_TRUNCATION_SUFFIX);
  if (truncated.text.length === 0) {
    return undefined;
  }

  const truncatedMessage = cloneMessage(message, {
    content: truncated.text,
  });
  return {
    message: truncatedMessage,
    size: estimateMessageRecordTokens(truncatedMessage),
    action: truncated.truncated
      ? createAction("truncate_plain_message", `Truncated plain-text message ${message.messageId} to fit the history budget.`, {
          turnId: message.turnId,
          messageIds: [message.messageId],
        })
      : undefined,
  };
}

function summarizeHistoryReport(report: Omit<HistoryIntegrityReport, "summary">): string {
  const parts = [`kept ${report.messageCountAfter}/${report.messageCountBefore} messages`];
  const droppedOrphanTools = countActions(report.actions, "drop_orphan_tool");
  const droppedIncompleteGroups = countActions(report.actions, "drop_incomplete_tool_group");
  const trimmedToolMessages = countActions(report.actions, "trim_tool_message");
  const droppedToolGroups = countActions(report.actions, "drop_tool_group_for_budget");
  const truncatedPlainMessages = countActions(report.actions, "truncate_plain_message");
  const fallbacks = countActions(report.actions, "fallback_to_turn_boundary");

  if (droppedOrphanTools > 0) {
    parts.push(`dropped orphan tools=${droppedOrphanTools}`);
  }
  if (droppedIncompleteGroups > 0) {
    parts.push(`dropped incomplete tool groups=${droppedIncompleteGroups}`);
  }
  if (trimmedToolMessages > 0) {
    parts.push(`trimmed tool messages=${trimmedToolMessages}`);
  }
  if (droppedToolGroups > 0) {
    parts.push(`dropped tool groups for budget=${droppedToolGroups}`);
  }
  if (truncatedPlainMessages > 0) {
    parts.push(`truncated plain messages=${truncatedPlainMessages}`);
  }
  if (fallbacks > 0) {
    parts.push(`fell back to safe boundary=${report.safeBoundaryTurnId ?? "start_of_history"}`);
  }
  if (report.issues.length === 0 && report.actions.length === 0) {
    parts.push("no integrity repairs required");
  }
  return parts.join("; ");
}

function buildReport(
  input: Omit<HistoryIntegrityReport, "summary">,
): HistoryIntegrityReport {
  return {
    ...input,
    summary: summarizeHistoryReport(input),
  };
}

function deriveOutcome(actions: HistoryIntegrityAction[], blocked: boolean): HistoryIntegrityOutcome {
  if (blocked) {
    return "blocked";
  }
  if (actions.some((action) => action.type === "fallback_to_turn_boundary")) {
    return "fallback_to_safe_boundary";
  }
  if (
    actions.some((action) => action.type === "drop_orphan_tool" || action.type === "drop_incomplete_tool_group")
  ) {
    return "auto_repaired";
  }
  return "clean";
}

function findEarliestAffectedTurnId(actions: HistoryIntegrityAction[], originalMessages: MessageRecord[]): string | undefined {
  const turnOrder = new Map<string, number>();
  originalMessages.forEach((message, index) => {
    if (!turnOrder.has(message.turnId)) {
      turnOrder.set(message.turnId, index);
    }
  });

  return actions
    .map((action) => action.turnId)
    .filter((turnId): turnId is string => typeof turnId === "string")
    .sort((left, right) => (turnOrder.get(left) ?? Number.MAX_SAFE_INTEGER) - (turnOrder.get(right) ?? Number.MAX_SAFE_INTEGER))[0];
}

function findTurnStartIndex(messages: MessageRecord[], turnId: string): number {
  return messages.findIndex((message) => message.turnId === turnId);
}

function rawToolOutputExposure(messages: MessageRecord[]): ToolOutputContextExposureSnapshot {
  return {
    rawMessageCount: messages.filter((message) => message.role === "tool").length,
    summarizedMessageCount: 0,
    budgetTruncatedMessageCount: 0,
  };
}

export function inspectHistoryForResume(
  messages: MessageRecord[],
  sessionStatus: SessionStatus,
): PreparedMessageHistory {
  const allowTrailingPendingToolGroup = sessionStatus === "ask_permission" || sessionStatus === "running";
  const sanitized = sanitizeMessageHistory(messages, {
    allowTrailingPendingToolGroup,
  });

  if (allowTrailingPendingToolGroup && sanitized.actions.length > 0) {
    const report = buildReport({
      outcome: "blocked",
      messageCountBefore: messages.length,
      messageCountAfter: sanitized.messages.length,
      issues: sanitized.issues,
      actions: sanitized.actions,
    });
    throw new HistoryIntegrityError("resume_check", report);
  }

  if (sanitized.actions.length === 0) {
    const validation = validateMessageHistory(sanitized.messages, {
      allowTrailingPendingToolGroup,
    });
    const report = buildReport({
      outcome: validation.valid ? "clean" : "blocked",
      messageCountBefore: messages.length,
      messageCountAfter: sanitized.messages.length,
      issues: validation.issues,
      actions: [],
    });
    if (!validation.valid) {
      throw new HistoryIntegrityError("resume_check", report);
    }
    return {
      messages: sanitized.messages,
      report,
      estimatedTokensBefore: estimateMessagesSize(sanitized.messages),
      estimatedTokensAfter: estimateMessagesSize(sanitized.messages),
      usedSummaryIds: [],
      toolOutputExposure: rawToolOutputExposure(sanitized.messages),
    };
  }

  const affectedTurnId = findEarliestAffectedTurnId(sanitized.actions, messages);
  if (!affectedTurnId) {
    const report = buildReport({
      outcome: deriveOutcome(sanitized.actions, false),
      messageCountBefore: messages.length,
      messageCountAfter: sanitized.messages.length,
      issues: sanitized.issues,
      actions: sanitized.actions,
    });
    return {
      messages: sanitized.messages,
      report,
      estimatedTokensBefore: estimateMessagesSize(sanitized.messages),
      estimatedTokensAfter: estimateMessagesSize(sanitized.messages),
      usedSummaryIds: [],
      toolOutputExposure: rawToolOutputExposure(sanitized.messages),
    };
  }

  const turnStartIndex = findTurnStartIndex(messages, affectedTurnId);
  const fallbackMessages = turnStartIndex <= 0 ? [] : messages.slice(0, turnStartIndex);
  const fallbackValidation = validateMessageHistory(fallbackMessages);
  const fallbackActions = [
    ...sanitized.actions,
    createAction("fallback_to_turn_boundary", `Fell back to the last safe turn boundary before ${affectedTurnId}.`, {
      turnId: affectedTurnId,
    }),
  ];
  const report = buildReport({
    outcome: deriveOutcome(fallbackActions, !fallbackValidation.valid),
    messageCountBefore: messages.length,
    messageCountAfter: fallbackMessages.length,
    safeBoundaryTurnId: fallbackMessages.at(-1)?.turnId,
    issues: [...sanitized.issues, ...fallbackValidation.issues],
    actions: fallbackActions,
  });
  if (!fallbackValidation.valid) {
    throw new HistoryIntegrityError("resume_check", report);
  }
  return {
    messages: fallbackMessages,
    report,
    estimatedTokensBefore: estimateMessagesSize(messages),
    estimatedTokensAfter: estimateMessagesSize(fallbackMessages),
    usedSummaryIds: [],
    toolOutputExposure: rawToolOutputExposure(fallbackMessages),
  };
}

export function prepareMessagesForModel(
  messages: MessageRecord[],
  options: {
    tokenBudget?: number;
    maxMessages?: number;
    maxChars?: number;
    contextSummaries?: ContextSummaryRecord[];
  },
): PreparedMessageHistory {
  const tokenBudget = options.tokenBudget ?? Math.max(64, Math.ceil((options.maxChars ?? 4096) / 3));
  const maxMessages = options.maxMessages ?? Number.MAX_SAFE_INTEGER;
  const sanitized = sanitizeMessageHistory(messages, {
    allowTrailingPendingToolGroup: false,
  });
  let modelEligibleMessages = sanitized.messages;
  const repairActions = [...sanitized.actions];
  const repairIssues = [...sanitized.issues];
  let safeBoundaryTurnId: string | undefined;

  if (sanitized.actions.length > 0) {
    const affectedTurnId = findEarliestAffectedTurnId(sanitized.actions, messages);
    if (affectedTurnId) {
      const turnStartIndex = findTurnStartIndex(messages, affectedTurnId);
      modelEligibleMessages = turnStartIndex <= 0 ? [] : messages.slice(0, turnStartIndex);
      safeBoundaryTurnId = modelEligibleMessages[modelEligibleMessages.length - 1]?.turnId;
      repairActions.push(
        createAction("fallback_to_turn_boundary", `Fell back to the last safe turn boundary before ${affectedTurnId}.`, {
          turnId: affectedTurnId,
        }),
      );
      const fallbackValidation = validateMessageHistory(modelEligibleMessages);
      repairIssues.push(...fallbackValidation.issues);
      if (!fallbackValidation.valid) {
        const report = buildReport({
          outcome: "blocked",
          messageCountBefore: messages.length,
          messageCountAfter: modelEligibleMessages.length,
          safeBoundaryTurnId,
          issues: repairIssues,
          actions: repairActions,
        });
        throw new HistoryIntegrityError("pre_model_request", report);
      }
    }
  }

  const estimatedTokensBefore = estimateMessagesSize(modelEligibleMessages);
  const rewritten = rewriteMessagesForModel(modelEligibleMessages, options.contextSummaries);
  modelEligibleMessages = rewritten.messages;
  const blocks = buildHistoryBlocks(modelEligibleMessages);
  let latestTurnContextBlockIndex = -1;
  for (let index = blocks.length - 1; index >= 0; index -= 1) {
    if (blocks[index]?.messages.some(isProviderTurnContextMessage)) {
      latestTurnContextBlockIndex = index;
      break;
    }
  }
  const pinnedBlocks = latestTurnContextBlockIndex >= 0
    ? [blocks[latestTurnContextBlockIndex]!]
    : [];
  const selectableBlocks = blocks.filter((_block, index) => index !== latestTurnContextBlockIndex);
  let selectedMessages: MessageRecord[] = [];
  const selectedActions: HistoryIntegrityAction[] = [];
  let usedTokens = 0;

  // The newest turn context is captured once and must remain at its original
  // history position for both task quality and provider-prefix stability.
  // Older turn snapshots are ordinary history so they cannot permanently
  // crowd the current request out of the token and message budgets.
  for (const block of pinnedBlocks) {
    const remainingTokens = tokenBudget - usedTokens;
    if (remainingTokens <= 0) break;
    const fitted = block.kind === "tool_group"
      ? fitToolGroupToBudget(block.messages, remainingTokens)
      : truncatePlainMessageToBudget(block.messages[0]!, remainingTokens);
    if (!fitted) continue;
    selectedMessages.push(...("messages" in fitted ? fitted.messages : [fitted.message]));
    selectedActions.push(...("actions" in fitted
      ? fitted.actions
      : fitted.action
        ? [fitted.action]
        : []));
    usedTokens += fitted.size;
  }

  for (const block of [...selectableBlocks].reverse()) {
    const remainingTokens = tokenBudget - usedTokens;
    if (remainingTokens <= 0) {
      break;
    }

    const remainingMessageSlots = maxMessages - selectedMessages.length;
    if (block.kind === "tool_group") {
      if (remainingMessageSlots < block.messages.length && selectedMessages.length > 0) {
        selectedActions.push(
          createAction(
            "drop_tool_group_for_budget",
            `Dropped tool group in turn ${block.turnId ?? "unknown"} because it would exceed the remaining message budget.`,
            {
              turnId: block.turnId,
              messageIds: block.messages.map((message) => message.messageId),
              toolCallIds: block.toolCallIds,
            },
          ),
        );
        continue;
      }

      const fittedGroup = fitToolGroupToBudget(block.messages, remainingTokens);
      if (!fittedGroup) {
        selectedActions.push(
          createAction(
            "drop_tool_group_for_budget",
            `Dropped tool group in turn ${block.turnId ?? "unknown"} because it could not fit within the remaining token budget.`,
            {
              turnId: block.turnId,
              messageIds: block.messages.map((message) => message.messageId),
              toolCallIds: block.toolCallIds,
            },
          ),
        );
        continue;
      }

      selectedMessages.unshift(...fittedGroup.messages);
      selectedActions.push(...fittedGroup.actions);
      usedTokens += fittedGroup.size;
      continue;
    }

    if (remainingMessageSlots <= 0) {
      break;
    }

    const truncated = truncatePlainMessageToBudget(block.messages[0]!, remainingTokens);
    if (!truncated) {
      break;
    }

    selectedMessages.unshift(truncated.message);
    if (truncated.action) {
      selectedActions.push(truncated.action);
    }
    usedTokens += truncated.size;
    if (truncated.action) {
      break;
    }
  }

  const selectedByMessageId = new Map(selectedMessages.map((message) => [message.messageId, message]));
  selectedMessages = modelEligibleMessages
    .filter((message) => selectedByMessageId.has(message.messageId))
    .map((message) => selectedByMessageId.get(message.messageId)!);

  const finalValidation = validateMessageHistory(selectedMessages);
  const actions = [...repairActions, ...selectedActions];
  const estimatedTokensAfter = estimateMessagesSize(selectedMessages);
  const report = buildReport({
    outcome: deriveOutcome(actions, !finalValidation.valid),
    messageCountBefore: messages.length,
    messageCountAfter: selectedMessages.length,
    safeBoundaryTurnId,
    issues: [...repairIssues, ...finalValidation.issues],
    actions,
  });
  if (!finalValidation.valid) {
    throw new HistoryIntegrityError("pre_model_request", report);
  }

  const selectedToolMessages = selectedMessages.filter((message) => message.role === "tool");
  const budgetTruncatedMessageIds = new Set(
    selectedActions
      .filter((action) => action.type === "trim_tool_message")
      .flatMap((action) => action.messageIds ?? []),
  );
  const selectedSummaryEntries = selectedToolMessages
    .map((message) => ({
      messageId: message.messageId,
      summaryId: rewritten.summaryIdsByMessageId.get(message.messageId),
    }))
    .filter((entry): entry is { messageId: string; summaryId: string } => typeof entry.summaryId === "string");
  const summarizedMessageIds = new Set(selectedSummaryEntries.map((entry) => entry.messageId));
  const toolOutputExposure: ToolOutputContextExposureSnapshot = {
    rawMessageCount: selectedToolMessages.filter(
      (message) => !summarizedMessageIds.has(message.messageId) && !budgetTruncatedMessageIds.has(message.messageId),
    ).length,
    summarizedMessageCount: selectedToolMessages.filter(
      (message) => summarizedMessageIds.has(message.messageId) && !budgetTruncatedMessageIds.has(message.messageId),
    ).length,
    budgetTruncatedMessageCount: selectedToolMessages.filter(
      (message) => budgetTruncatedMessageIds.has(message.messageId),
    ).length,
  };

  return {
    messages: selectedMessages,
    report,
    estimatedTokensBefore,
    estimatedTokensAfter,
    usedSummaryIds: [...new Set(selectedSummaryEntries.map((entry) => entry.summaryId))],
    toolOutputExposure,
  };
}
