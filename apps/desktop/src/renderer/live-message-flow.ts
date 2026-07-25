import type { ToolCall, ToolResult } from "../../../../packages/shared-schema/src/index.js";
import type { DisplayMessage, ToolCallState } from "./types.js";

export interface LiveMessageFlowState {
  runId: string;
  turnId: string;
  nextSequence: number;
  activeMessageId?: string;
  activeHasTools: boolean;
  forceNewPhase: boolean;
  activeBatchId?: string;
  batchMessageIds: Record<string, string>;
  messageIds: string[];
}

export type LiveMessageFlowEvent =
  | { type: "text"; chunk: string }
  | { type: "tool_batch_start"; batchId: string; toolCalls?: ToolCall[] }
  | { type: "tool_start"; toolCall: ToolCall; displayName?: string }
  | { type: "tool_end"; result: ToolResult; displayName?: string }
  | { type: "complete" };

export interface LiveMessageFlowResult {
  messages: DisplayMessage[];
  state: LiveMessageFlowState;
}

export function createLiveMessageFlowState(
  runId = `stream-${Date.now()}`,
  turnId = `live-turn-${runId}`,
): LiveMessageFlowState {
  return {
    runId,
    turnId,
    nextSequence: 1,
    activeHasTools: false,
    forceNewPhase: false,
    batchMessageIds: {},
    messageIds: [],
  };
}

function ensureActiveMessage(
  messages: DisplayMessage[],
  state: LiveMessageFlowState,
  timestamp: string,
): { messages: DisplayMessage[]; state: LiveMessageFlowState; messageId: string } {
  if (state.activeMessageId && !state.forceNewPhase) {
    return { messages, state, messageId: state.activeMessageId };
  }

  const messageId = `${state.runId}-phase-${state.nextSequence}`;
  return {
    messages: [...messages, {
      id: messageId,
      turnId: state.turnId,
      role: "assistant",
      content: "",
      toolCalls: [],
      timestamp,
      streaming: true,
    }],
    state: {
      ...state,
      nextSequence: state.nextSequence + 1,
      activeMessageId: messageId,
      activeHasTools: false,
      forceNewPhase: false,
      messageIds: [...state.messageIds, messageId],
    },
    messageId,
  };
}

function updateMessage(
  messages: DisplayMessage[],
  messageId: string,
  update: (message: DisplayMessage) => DisplayMessage,
): DisplayMessage[] {
  return messages.map((message) => message.id === messageId ? update(message) : message);
}

function queueBatchTools(messages: DisplayMessage[], messageId: string, toolCalls: ToolCall[] = []): DisplayMessage[] {
  if (toolCalls.length === 0) return messages;
  return updateMessage(messages, messageId, (message) => {
    const tools = [...(message.toolCalls ?? [])];
    for (const toolCall of toolCalls) {
      if (tools.some((tool) => tool.id === toolCall.id)) continue;
      tools.push({
        id: toolCall.id,
        name: toolCall.name,
        status: "queued",
        args: toolCall.arguments,
      });
    }
    return { ...message, toolCalls: tools };
  });
}

/**
 * Projects live runtime callbacks into ordered assistant phases. Text after a
 * tool group starts the next phase, so it renders below that group. A future
 * explicit tool-batch callback can call `tool_batch_start`; repeated batch ids
 * are idempotently rebound to the same phase.
 */
export function reduceLiveMessageFlow(
  currentMessages: DisplayMessage[],
  currentState: LiveMessageFlowState,
  event: LiveMessageFlowEvent,
  timestamp = new Date().toISOString(),
): LiveMessageFlowResult {
  let messages = currentMessages;
  let state: LiveMessageFlowState = {
    ...currentState,
    batchMessageIds: { ...currentState.batchMessageIds },
    messageIds: [...currentState.messageIds],
  };

  if (event.type === "complete") {
    const liveIds = new Set(state.messageIds);
    return {
      messages: messages.map((message) => liveIds.has(message.id) ? { ...message, streaming: false } : message),
      state: { ...state, activeMessageId: undefined, activeHasTools: false, forceNewPhase: false },
    };
  }

  if (event.type === "tool_batch_start") {
    const existingMessageId = state.batchMessageIds[event.batchId]
      ?? messages.find((message) => message.id === event.batchId && message.role === "assistant")?.id;
    if (existingMessageId) {
      messages = updateMessage(messages, existingMessageId, (message) => ({ ...message, streaming: true }));
      messages = queueBatchTools(messages, existingMessageId, event.toolCalls);
      const ownerTurnId = messages.find((message) => message.id === existingMessageId)?.turnId;
      return {
        messages,
        state: {
          ...state,
          turnId: ownerTurnId ?? state.turnId,
          activeMessageId: existingMessageId,
          activeHasTools: Boolean(messages.find((message) => message.id === existingMessageId)?.toolCalls?.length),
          forceNewPhase: false,
          activeBatchId: event.batchId,
          batchMessageIds: { ...state.batchMessageIds, [event.batchId]: existingMessageId },
          messageIds: state.messageIds.includes(existingMessageId)
            ? state.messageIds
            : [...state.messageIds, existingMessageId],
        },
      };
    }

    if (state.activeHasTools) {
      state.activeMessageId = undefined;
      state.forceNewPhase = true;
    }
    const ensured = ensureActiveMessage(messages, state, timestamp);
    messages = queueBatchTools(ensured.messages, ensured.messageId, event.toolCalls);
    state = {
      ...ensured.state,
      activeHasTools: Boolean(event.toolCalls?.length),
      activeBatchId: event.batchId,
      batchMessageIds: {
        ...ensured.state.batchMessageIds,
        [event.batchId]: ensured.messageId,
      },
    };
    return { messages, state };
  }

  if (event.type === "text") {
    if (state.activeHasTools) {
      state.activeMessageId = undefined;
      state.forceNewPhase = true;
      state.activeBatchId = undefined;
    }
    const ensured = ensureActiveMessage(messages, state, timestamp);
    messages = ensured.messages;
    state = ensured.state;
    if (event.chunk) {
      messages = updateMessage(messages, ensured.messageId, (message) => ({
        ...message,
        content: message.content + event.chunk,
      }));
    }
    return { messages, state };
  }

  if (event.type === "tool_start") {
    const ensured = ensureActiveMessage(messages, state, timestamp);
    messages = ensured.messages;
    state = ensured.state;
    messages = updateMessage(messages, ensured.messageId, (message) => {
      const tools = [...(message.toolCalls ?? [])];
      const existingIndex = tools.findIndex((tool) => tool.id === event.toolCall.id);
      const running: ToolCallState = {
        ...(existingIndex >= 0 ? tools[existingIndex] : {}),
        id: event.toolCall.id,
        name: event.toolCall.name,
        ...(event.displayName ? { displayName: event.displayName } : {}),
        status: "running",
        args: event.toolCall.arguments,
        startedAt: timestamp,
      };
      if (existingIndex >= 0) tools[existingIndex] = running;
      else tools.push(running);
      return { ...message, toolCalls: tools };
    });
    state = { ...state, activeHasTools: true };
    return { messages, state };
  }

  let matchedMessageId: string | undefined;
  for (let index = messages.length - 1; index >= 0; index -= 1) {
    if (messages[index]?.toolCalls?.some((tool) => tool.id === event.result.callId)) {
      matchedMessageId = messages[index]!.id;
      break;
    }
  }
  const ensured = matchedMessageId
    ? { messages, state, messageId: matchedMessageId }
    : ensureActiveMessage(messages, state, timestamp);
  messages = ensured.messages;
  state = ensured.state;
  messages = updateMessage(messages, ensured.messageId, (message) => {
    const tools = [...(message.toolCalls ?? [])];
    const targetIndex = tools.findIndex((tool) => (
      tool.id === event.result.callId
      || (tool.name === event.result.toolName && tool.status === "running")
    ));
    const completed: ToolCallState = {
      ...(targetIndex >= 0
        ? tools[targetIndex]
        : { id: event.result.callId, name: event.result.toolName }),
      ...(event.displayName ? { displayName: event.displayName } : {}),
      status: event.result.success ? "success" : "error",
      result: event.result,
    };
    if (targetIndex >= 0) tools[targetIndex] = completed;
    else tools.push(completed);
    return { ...message, toolCalls: tools };
  });
  state = { ...state, activeHasTools: true };
  return { messages, state };
}
