import type { ConversationMessage } from "../../shared-schema/src/index.js";

export const SESSION_TITLE_SYSTEM_PROMPT = [
  "You generate concise titles for software-assistant sessions.",
  "Summarize the actual task, not the opening words or the assistant's activity.",
  "Return only one title: 6-18 Chinese characters or 3-10 English words.",
  "Do not use quotes, Markdown, emoji, ending punctuation, or generic labels such as New task.",
].join("\n");

const GENERIC_TITLES = new Set([
  "new task",
  "new session",
  "session",
  "task",
  "任务",
  "新任务",
  "会话",
]);

function truncate(value: string, maxChars: number): string {
  const characters = Array.from(value);
  return characters.length <= maxChars ? value : characters.slice(0, maxChars).join("");
}

export function normalizeGeneratedSessionTitle(raw: string): string | undefined {
  const firstLine = raw
    .split(/\r?\n/u)
    .map((line) => line.trim())
    .find(Boolean);
  if (!firstLine) return undefined;

  const normalized = truncate(
    firstLine
      .replace(/^#{1,6}\s*/u, "")
      .replace(/^(?:标题|会话标题|任务标题|title)\s*[:：-]\s*/iu, "")
      .replace(/^[`"'“”‘’]+|[`"'“”‘’]+$/gu, "")
      .replace(/\p{Extended_Pictographic}/gu, "")
      .replace(/[\u200D\uFE0E\uFE0F]/gu, "")
      .replace(/\s+/gu, " ")
      .replace(/[。.!！?？;；,:：]+$/gu, "")
      .trim(),
    36,
  );

  if (Array.from(normalized).length < 2 || GENERIC_TITLES.has(normalized.toLocaleLowerCase())) {
    return undefined;
  }
  return normalized;
}

export function buildSessionTitleMessages(input: {
  userRequest: string;
  assistantResponse: string;
}): ConversationMessage[] {
  return [{
    role: "user",
    content: [
      "User request:",
      truncate(input.userRequest.trim(), 4_000),
      "",
      "Assistant result:",
      truncate(input.assistantResponse.trim(), 3_000),
    ].join("\n"),
  }];
}
