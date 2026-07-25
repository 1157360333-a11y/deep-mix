import type { MessageRecord, ToolResult } from "../../../../packages/shared-schema/src/index.js";
import type { DesktopMessageAttachment } from "../shared/desktop-message-attachments.js";
export type { DesktopMessageAttachment } from "../shared/desktop-message-attachments.js";

export interface ToolCallState {
  id: string;
  name: string;
  displayName?: string;
  status: "queued" | "running" | "success" | "error";
  args?: unknown;
  result?: ToolResult;
  startedAt?: string;
}

export interface DisplayMessage {
  id: string;
  turnId?: string;
  role: MessageRecord["role"] | "status";
  content: string;
  name?: string;
  toolCalls?: ToolCallState[];
  timestamp?: string;
  streaming?: boolean;
  attachments?: DesktopMessageAttachment[];
  turnDurationMs?: number;
}

export type InspectorPanel = "context" | "plan" | "activity" | "plugins" | "settings";
export type ThemeMode = "light" | "dark";
