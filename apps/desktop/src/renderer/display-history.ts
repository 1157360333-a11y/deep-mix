import type {
  MessageRecord,
  ToolOutputArtifact,
  ToolResult,
  TurnRecord,
} from "../../../../packages/shared-schema/src/index.js";
import { readDesktopMessagePresentation } from "../shared/desktop-message-attachments.js";
import type { DisplayMessage, ToolCallState } from "./types.js";

const artifactKinds = new Set<ToolOutputArtifact["kind"]>(["file", "document", "image", "text", "binary"]);
const PROVIDER_TURN_CONTEXT_METADATA_KEY = "providerTurnContext";

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function isToolOutputArtifact(value: unknown): value is ToolOutputArtifact {
  if (!isRecord(value)) return false;
  return typeof value.uri === "string"
    && typeof value.fileName === "string"
    && typeof value.mimeType === "string"
    && typeof value.sizeBytes === "number"
    && typeof value.kind === "string"
    && artifactKinds.has(value.kind as ToolOutputArtifact["kind"])
    && typeof value.sourceToolName === "string"
    && typeof value.summary === "string"
    && typeof value.createdAt === "string"
    && (value.workspaceRelativePath === undefined || typeof value.workspaceRelativePath === "string");
}

function historicalArtifacts(message: MessageRecord): ToolOutputArtifact[] {
  const metadata = message.metadata;
  if (!metadata) return [];
  const nestedResult = isRecord(metadata.result) ? metadata.result : undefined;
  const value = metadata.artifacts ?? nestedResult?.artifacts;
  return Array.isArray(value) ? value.filter(isToolOutputArtifact) : [];
}

function historicalDisplayName(message: MessageRecord): string | undefined {
  const metadata = message.metadata;
  if (!metadata) return undefined;
  const tool = isRecord(metadata.tool) ? metadata.tool : undefined;
  const definition = isRecord(metadata.toolDefinition) ? metadata.toolDefinition : undefined;
  const value = metadata.toolDisplayName ?? metadata.displayName ?? tool?.displayName ?? definition?.displayName;
  return typeof value === "string" && value.trim() ? value.trim() : undefined;
}

function historicalToolTimestamp(message: MessageRecord, key: "startedAt" | "endedAt"): string {
  const metadata = message.metadata;
  const nestedResult = isRecord(metadata?.result) ? metadata.result : undefined;
  const value = metadata?.[key] ?? nestedResult?.[key];
  return typeof value === "string" && value.trim() ? value : message.createdAt;
}

function historicalToolResult(message: MessageRecord, tool: ToolCallState): ToolCallState {
  const success = typeof message.metadata?.success === "boolean" ? message.metadata.success : true;
  const metadataError = message.metadata?.error;
  const error = typeof metadataError === "string" && metadataError ? metadataError : undefined;
  const artifacts = historicalArtifacts(message);
  const result: ToolResult = {
    toolName: tool.name,
    callId: tool.id,
    startedAt: historicalToolTimestamp(message, "startedAt"),
    endedAt: historicalToolTimestamp(message, "endedAt"),
    success,
    output: message.content,
    ...(artifacts.length > 0 ? { artifacts } : {}),
    ...(error ? { error } : {}),
  };

  return {
    ...tool,
    ...(historicalDisplayName(message) ? { displayName: historicalDisplayName(message) } : {}),
    status: success ? "success" : "error",
    result,
  };
}

/**
 * Persistence stores one assistant record per provider response. Keep those
 * response boundaries: each assistant.toolCalls batch is one visible tool round,
 * and the following assistant record remains immediately after that round.
 * Matching tool records enrich their owning round instead of rendering twice.
 */
export function buildDisplayHistory(records: MessageRecord[], turns: TurnRecord[] = []): DisplayMessage[] {
  const display: DisplayMessage[] = [];
  const toolsById = new Map<string, { owner: DisplayMessage; index: number }>();
  const durationByTurn = new Map(turns.map((turn) => [turn.turnId, turn.durationMs]));

  for (const record of records) {
    if (record.role === "system" && record.metadata?.[PROVIDER_TURN_CONTEXT_METADATA_KEY]) {
      continue;
    }
    if (record.role === "assistant") {
      const isInternalRoutingRecord = Boolean(
        record.toolCalls?.length
        && record.metadata?.routeTarget
        && record.metadata?.routeMode,
      );
      const owner: DisplayMessage = {
        id: record.messageId,
        turnId: record.turnId,
        role: "assistant",
        content: isInternalRoutingRecord ? "" : record.content,
        toolCalls: [],
        timestamp: record.createdAt,
        ...(durationByTurn.get(record.turnId) !== undefined
          ? { turnDurationMs: durationByTurn.get(record.turnId) }
          : {}),
      };
      for (const toolCall of record.toolCalls ?? []) {
        const tool: ToolCallState = {
          id: toolCall.id,
          name: toolCall.name,
          ...(historicalDisplayName(record) ? { displayName: historicalDisplayName(record) } : {}),
          status: "queued",
          args: toolCall.arguments,
        };
        const index = owner.toolCalls!.push(tool) - 1;
        toolsById.set(tool.id, { owner, index });
      }
      display.push(owner);
      continue;
    }

    if (record.role === "tool") {
      const linked = record.toolCallId ? toolsById.get(record.toolCallId) : undefined;
      const owner = linked?.owner;
      if (owner) {
        owner.toolCalls![linked.index] = historicalToolResult(record, owner.toolCalls![linked.index]!);
        continue;
      }

      const tool: ToolCallState = {
        id: record.toolCallId ?? record.messageId,
        name: record.name ?? "tool",
        status: "success",
      };
      display.push({
        id: record.messageId,
        turnId: record.turnId,
        role: "tool",
        content: record.content,
        name: record.name,
        toolCalls: [historicalToolResult(record, tool)],
        timestamp: record.createdAt,
        ...(durationByTurn.get(record.turnId) !== undefined
          ? { turnDurationMs: durationByTurn.get(record.turnId) }
          : {}),
      });
      continue;
    }

    const desktopPresentation = record.role === "user"
      ? readDesktopMessagePresentation(record.content, record.metadata)
      : undefined;
    display.push({
      id: record.messageId,
      turnId: record.turnId,
      role: record.role,
      content: desktopPresentation?.prompt ?? record.content,
      name: record.name,
      timestamp: record.createdAt,
      ...(durationByTurn.get(record.turnId) !== undefined
        ? { turnDurationMs: durationByTurn.get(record.turnId) }
        : {}),
      ...(desktopPresentation?.attachments.length
        ? { attachments: desktopPresentation.attachments }
        : {}),
    });
  }

  return display.filter((message) =>
    message.role !== "assistant"
    || Boolean(message.content || message.toolCalls?.length),
  );
}
