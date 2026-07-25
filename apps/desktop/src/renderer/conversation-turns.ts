import type { DisplayMessage } from "./types.js";

export interface ConversationTurnProjection {
  id: string;
  turnId?: string;
  user?: DisplayMessage;
  process: DisplayMessage[];
  final?: DisplayMessage;
  durationMs?: number;
  toolRoundCount: number;
  toolCallCount: number;
  running: boolean;
}

interface MutableConversationTurn {
  id: string;
  turnId?: string;
  user?: DisplayMessage;
  events: DisplayMessage[];
}

function hasTools(message: DisplayMessage): boolean {
  return Boolean(message.toolCalls?.length);
}

function latestFinalIndex(events: DisplayMessage[]): number {
  let lastToolIndex = -1;
  for (let index = 0; index < events.length; index += 1) {
    if (hasTools(events[index]!)) lastToolIndex = index;
  }
  for (let index = events.length - 1; index > lastToolIndex; index -= 1) {
    const message = events[index]!;
    if (message.role === "assistant" && !hasTools(message) && message.content.trim()) return index;
  }
  return -1;
}

/**
 * Groups the flat renderer transcript into user turns. Once a turn settles,
 * every progress message and tool round is separated from the last assistant
 * answer so the UI can collapse the former under one "processed" disclosure.
 */
export function projectConversationTurns(
  messages: DisplayMessage[],
  latestTurnRunning: boolean,
): ConversationTurnProjection[] {
  const mutable: MutableConversationTurn[] = [];
  let current: MutableConversationTurn | undefined;

  for (const message of messages) {
    if (message.role === "user") {
      if (current?.turnId && message.turnId === current.turnId) {
        current.events.push(message);
        continue;
      }
      current = {
        id: message.turnId ?? message.id,
        turnId: message.turnId,
        user: message,
        events: [],
      };
      mutable.push(current);
      continue;
    }

    const belongsToAnotherTurn = Boolean(
      current
      && message.turnId
      && current.turnId
      && message.turnId !== current.turnId,
    );
    if (!current || belongsToAnotherTurn) {
      current = {
        id: message.turnId ?? message.id,
        turnId: message.turnId,
        events: [],
      };
      mutable.push(current);
    }
    current.events.push(message);
  }

  return mutable.map((turn, index) => {
    const running = latestTurnRunning && index === mutable.length - 1;
    const finalIndex = running ? -1 : latestFinalIndex(turn.events);
    const final = finalIndex >= 0 ? turn.events[finalIndex] : undefined;
    const process = finalIndex >= 0
      ? turn.events.filter((_, eventIndex) => eventIndex !== finalIndex)
      : turn.events;
    const toolRoundCount = process.filter(hasTools).length;
    const toolCallCount = process.reduce((total, message) => total + (message.toolCalls?.length ?? 0), 0);
    const durationMs = [...turn.events, ...(turn.user ? [turn.user] : [])]
      .map((message) => message.turnDurationMs)
      .find((value) => value !== undefined);

    return {
      id: turn.id,
      turnId: turn.turnId,
      user: turn.user,
      process,
      final,
      durationMs,
      toolRoundCount,
      toolCallCount,
      running,
    };
  });
}
