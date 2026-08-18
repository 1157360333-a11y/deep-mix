import type {
  ContextBudgetSnapshot,
  ContextCompactionRecord,
  PermissionMode,
  RouteTarget,
  RuntimeCapabilitySnapshot,
  SessionStatus,
  TaskDurationSnapshot,
  TokenUsageSnapshot,
  ToolOutputArtifact,
} from "../../../packages/shared-schema/src/index.js";
import type { CliShellState, ProfileStatusEntry, ProfileStatusReport } from "./session-shell.js";

export type TuiMessageKind = "user" | "assistant" | "tool" | "system" | "error";
export type TuiToolStatus = "running" | "ok" | "error";
export type TuiInputMode = "prompt" | "approval" | "question";

export interface TerminalViewport {
  columns: number;
  rows: number;
}

export interface TerminalTuiHeaderState {
  version: string;
  workspaceRoot: string;
  permissionMode: PermissionMode;
  routeOverride?: RouteTarget;
  profiles: ProfileStatusReport;
  capabilities: RuntimeCapabilitySnapshot;
}

export interface TerminalTuiMessage {
  id: string;
  kind: TuiMessageKind;
  title: string;
  content: string;
  streaming?: boolean;
  toolGroup?: TerminalTuiToolGroup;
  processGroup?: TerminalTuiProcessGroup;
}

export interface TerminalTuiToolEntry {
  callId?: string;
  name: string;
  status: TuiToolStatus;
  fallback?: string;
  artifacts?: ToolOutputArtifact[];
  startedAtMs?: number;
  endedAtMs?: number;
  output?: string;
  error?: string;
  structuredContent?: unknown;
}

export interface TerminalTuiToolGroup {
  batchId?: string;
  sequence: number;
  expanded: boolean;
  running: boolean;
  startedAtMs: number;
  endedAtMs?: number;
  tools: TerminalTuiToolEntry[];
}

export interface TerminalTuiProcessGroup {
  expanded: boolean;
  durationMs?: number;
  messages: TerminalTuiMessage[];
}

export interface TerminalTuiApprovalState {
  toolName: string;
  actionLabel: string;
  requestKey: string;
  riskLabel: string;
  reason: string;
  detailLines?: string[];
}

export interface TerminalTuiInputState {
  mode: TuiInputMode;
  value: string;
  cursor: number;
  placeholder: string;
  submitHint: string;
  promptText: string;
}

export interface TerminalTuiActivityState {
  mode: "thinking" | "approval" | "notice";
  label: string;
  detail?: string;
  frame: number;
}

export interface TerminalTuiState {
  header?: TerminalTuiHeaderState;
  cliState: CliShellState;
  sessionId?: string;
  sessionStatus?: SessionStatus;
  routeSummary?: string;
  fallbackSummary?: string;
  workerSummary?: string;
  latestContextBudget?: ContextBudgetSnapshot;
  latestTaskDuration?: TaskDurationSnapshot;
  latestTokenUsage?: TokenUsageSnapshot;
  cumulativeTokenUsage?: TokenUsageSnapshot;
  latestCompaction?: ContextCompactionRecord;
  currentTool?: TerminalTuiToolEntry;
  recentTools: TerminalTuiToolEntry[];
  approval?: TerminalTuiApprovalState;
  messages: TerminalTuiMessage[];
  helpVisible: boolean;
  helpLines: string[];
  input: TerminalTuiInputState;
  activity?: TerminalTuiActivityState;
  messageScrollOffset: number;
  debugVisible: boolean;
  debugLines: string[];
}

export interface RenderedTerminalFrame {
  output: string;
  cursor: {
    row: number;
    column: number;
  };
}

const ANSI_REGEX = /\x1b\[[0-9;]*m/g;
const RESET = "\x1b[0m";

const palette = {
  brandDark: "#1552cf",
  brandBase: "#2d75ff",
  brandMix: "#22c3d6",
  brandLight: "#9ed9ff",
  text: "#dbe8ff",
  muted: "#8da5cf",
  dim: "#5f7294",
  success: "#63d68d",
  warning: "#f5c768",
  danger: "#ff6f6f",
  user: "#dff4ff",
  assistant: "#dbe8ff",
  system: "#a9c0e8",
  line: "#294567",
  surface: "#0b1220",
};

function fg(hex: string): string {
  const value = hex.replace("#", "");
  const red = Number.parseInt(value.slice(0, 2), 16);
  const green = Number.parseInt(value.slice(2, 4), 16);
  const blue = Number.parseInt(value.slice(4, 6), 16);
  return `\x1b[38;2;${red};${green};${blue}m`;
}

function bg(hex: string): string {
  const value = hex.replace("#", "");
  const red = Number.parseInt(value.slice(0, 2), 16);
  const green = Number.parseInt(value.slice(2, 4), 16);
  const blue = Number.parseInt(value.slice(4, 6), 16);
  return `\x1b[48;2;${red};${green};${blue}m`;
}

function color(text: string, ...codes: string[]): string {
  return `${codes.join("")}${text}${RESET}`;
}

function bold(text: string): string {
  return `\x1b[1m${text}${RESET}`;
}

function dim(text: string): string {
  return `\x1b[2m${text}${RESET}`;
}

function stripAnsi(text: string): string {
  return text.replace(ANSI_REGEX, "");
}

function terminalCellWidth(char: string): number {
  const codePoint = char.codePointAt(0);
  if (codePoint === undefined) {
    return 0;
  }
  if (codePoint === 0 || codePoint < 0x20 || (codePoint >= 0x7f && codePoint < 0xa0)) {
    return 0;
  }
  if (
    (codePoint >= 0x0300 && codePoint <= 0x036f) ||
    (codePoint >= 0x1ab0 && codePoint <= 0x1aff) ||
    (codePoint >= 0x1dc0 && codePoint <= 0x1dff) ||
    (codePoint >= 0x20d0 && codePoint <= 0x20ff) ||
    (codePoint >= 0xfe00 && codePoint <= 0xfe0f) ||
    (codePoint >= 0xfe20 && codePoint <= 0xfe2f) ||
    codePoint === 0x200d
  ) {
    return 0;
  }
  if (
    codePoint >= 0x1100 &&
    (codePoint <= 0x115f ||
      codePoint === 0x2329 ||
      codePoint === 0x232a ||
      (codePoint >= 0x2e80 && codePoint <= 0xa4cf && codePoint !== 0x303f) ||
      (codePoint >= 0xac00 && codePoint <= 0xd7a3) ||
      (codePoint >= 0xf900 && codePoint <= 0xfaff) ||
      (codePoint >= 0xfe10 && codePoint <= 0xfe19) ||
      (codePoint >= 0xfe30 && codePoint <= 0xfe6f) ||
      (codePoint >= 0xff00 && codePoint <= 0xff60) ||
      (codePoint >= 0xffe0 && codePoint <= 0xffe6) ||
      (codePoint >= 0x1f300 && codePoint <= 0x1faff) ||
      (codePoint >= 0x20000 && codePoint <= 0x3fffd))
  ) {
    return 2;
  }
  return 1;
}

function visibleLength(text: string): number {
  return Array.from(stripAnsi(text)).reduce((width, char) => width + terminalCellWidth(char), 0);
}

function cropVisible(text: string, width: number): string {
  if (width <= 0) {
    return "";
  }
  if (visibleLength(text) <= width) {
    return text;
  }
  let collected = "";
  let visible = 0;
  const segments = text.split(/(\x1b\[[0-9;]*m)/g).filter(Boolean);
  for (const segment of segments) {
    if (segment.startsWith("\x1b[")) {
      collected += segment;
      continue;
    }
    for (const char of segment) {
      const charWidth = terminalCellWidth(char);
      if (visible + charWidth > width) {
        return `${collected}${RESET}`;
      }
      collected += char;
      visible += charWidth;
    }
  }
  return collected;
}

function padRightVisible(text: string, width: number): string {
  const cropped = cropVisible(text, width);
  const extra = width - visibleLength(cropped);
  return extra > 0 ? `${cropped}${" ".repeat(extra)}` : cropped;
}

function truncateMiddle(text: string, width: number): string {
  if (width <= 0) {
    return "";
  }
  const plain = stripAnsi(text);
  if (plain.length <= width) {
    return plain;
  }
  if (width <= 3) {
    return ".".repeat(width);
  }
  const left = Math.ceil((width - 3) / 2);
  const right = Math.floor((width - 3) / 2);
  return `${plain.slice(0, left)}...${plain.slice(Math.max(plain.length - right, left))}`;
}

function wrapText(text: string, width: number): string[] {
  if (width <= 1) {
    return [stripAnsi(text)];
  }
  const plain = stripAnsi(text).replace(/\r/g, "");
  const paragraphs = plain.split("\n");
  const lines: string[] = [];
  for (const paragraph of paragraphs) {
    if (!paragraph) {
      lines.push("");
      continue;
    }
    const words = paragraph.split(/\s+/).filter(Boolean);
    let current = "";
    for (const word of words) {
      if (!current) {
        if (word.length <= width) {
          current = word;
        } else {
          for (let index = 0; index < word.length; index += width) {
            lines.push(word.slice(index, index + width));
          }
        }
        continue;
      }
      if (`${current} ${word}`.length <= width) {
        current = `${current} ${word}`;
      } else {
        lines.push(current);
        current = word;
      }
    }
    if (current) {
      lines.push(current);
    }
  }
  return lines.length > 0 ? lines : [""];
}

function wrapInputText(text: string, width: number): string[] {
  if (width <= 1) {
    return [text];
  }
  const plain = text.replace(/\r/g, "");
  if (!plain) {
    return [""];
  }
  const lines: string[] = [];
  for (let index = 0; index < plain.length; index += width) {
    lines.push(plain.slice(index, index + width));
  }
  return lines;
}

function separator(width: number): string {
  return color("─".repeat(Math.max(width, 1)), fg(palette.line));
}

function shortSessionId(sessionId?: string): string {
  return sessionId ? sessionId.slice(0, 8) : "none";
}

function formatTokenCount(value: number | undefined): string {
  if (value === undefined || !Number.isFinite(value)) {
    return "unavailable";
  }
  if (value >= 1000) {
    return `${(value / 1000).toFixed(value >= 10000 ? 0 : 1)}k`;
  }
  return String(Math.round(value));
}

function formatUsageSource(source: ContextBudgetSnapshot["source"] | TokenUsageSnapshot["source"] | undefined): string {
  if (!source) {
    return "unavailable";
  }
  switch (source) {
    case "provider_exact":
      return "exact";
    case "provider_partial":
      return "partial";
    case "local_estimated":
      return "estimated";
    default:
      return "unavailable";
  }
}

function resolveDurationMs(snapshot: TaskDurationSnapshot | undefined): number | undefined {
  if (!snapshot) {
    return undefined;
  }
  if (snapshot.durationMs !== undefined) {
    return snapshot.durationMs;
  }
  if (!snapshot.startedAt) {
    return undefined;
  }
  return Math.max(0, Date.now() - new Date(snapshot.startedAt).getTime());
}

function formatDuration(durationMs: number | undefined): string {
  if (durationMs === undefined || !Number.isFinite(durationMs)) {
    return "unavailable";
  }
  const totalSeconds = Math.max(0, Math.round(durationMs / 1000));
  const hours = Math.floor(totalSeconds / 3600);
  const minutes = Math.floor((totalSeconds % 3600) / 60);
  const seconds = totalSeconds % 60;
  if (hours > 0) {
    return `${hours}h ${minutes}m ${seconds}s`;
  }
  if (minutes > 0) {
    return `${minutes}m ${seconds}s`;
  }
  return `${seconds}s`;
}

function readyLabel(profile: ProfileStatusEntry): string {
  if (!profile.exists) {
    return color("missing", fg(palette.danger));
  }
  if (!profile.hasKey) {
    return color("missing-key", fg(palette.warning));
  }
  return color("ready", fg(palette.success));
}

function pixelMark(): string[] {
  const rows = [
    [" ", " ", "█", "█", " "],
    [" ", "█", "█", "█", "█"],
    ["█", "█", "█", "█", "█"],
    [" ", "█", "█", "█", "█"],
    [" ", " ", "█", "█", " "],
  ];
  const colors = [
    ["", "", palette.brandDark, palette.brandBase, ""],
    ["", palette.brandDark, palette.brandBase, palette.brandMix, palette.brandLight],
    [palette.brandBase, palette.brandBase, palette.brandMix, palette.brandMix, palette.brandLight],
    ["", palette.brandBase, palette.brandMix, palette.brandMix, palette.brandLight],
    ["", "", palette.brandMix, palette.brandLight, ""],
  ];
  return rows.map((row, rowIndex) =>
    row
      .map((cell, columnIndex) => (cell === "█" ? color("██", fg(colors[rowIndex]![columnIndex]!)) : "  "))
      .join(""),
  );
}

function renderTopBar(state: TerminalTuiState, width: number): string[] {
  const activityChip = renderActivityChip(state.activity);
  const brand = `${color(bold("Deep-Mix"), fg(palette.brandLight))} ${color(state.header ? `v${state.header.version}` : "", fg(palette.muted))}`;
  const route = truncateMiddle(state.routeSummary ?? "ready", Math.max(width - 40, 12));
  const line1 = padRightVisible(`${brand}  ${activityChip}`, width);
  const workspace = truncateMiddle(state.header?.workspaceRoot ?? "Starting...", Math.max(width - 24, 12));
  const meta = color(`#${shortSessionId(state.sessionId)} · ${state.sessionStatus ?? state.cliState} · ${route}`, fg(palette.dim));
  const line2 = padRightVisible(`${color(workspace, fg(palette.muted))}  ${meta}`, width);
  const budget = state.latestContextBudget;
  const durationMs = resolveDurationMs(state.latestTaskDuration);
  const durationLabel = durationMs !== undefined ? ` · ${state.latestTaskDuration?.endedAt ? "done" : "elapsed"} ${formatDuration(durationMs)}` : "";
  const compactionLabel =
    state.latestCompaction?.triggered && state.latestCompaction.tokensSaved > 0
      ? ` · compact ${formatTokenCount(state.latestCompaction.tokensSaved)}`
      : "";
  const contextLine = budget
    ? `context ${budget.usagePercent.toFixed(1)}% · ${formatTokenCount(budget.usedInputTokens)} / ${formatTokenCount(
        budget.inputBudgetTokens,
      )} · left ${formatTokenCount(budget.remainingInputTokens)} · ${formatUsageSource(budget.source)}${compactionLabel}${durationLabel}`
    : `context unavailable${durationLabel}`;
  const line3 = padRightVisible(color(contextLine, fg(palette.muted)), width);
  return [line1, line2, line3];
}

function renderActivityChip(activity: TerminalTuiActivityState | undefined): string {
  if (!activity) {
    return color("就绪", fg(palette.success));
  }
  if (activity.mode === "approval") {
    return color(`等待审批 · ${activity.detail ?? ""}`, fg(palette.warning));
  }
  if (activity.mode === "notice") {
    return color(activity.label, fg(palette.brandLight));
  }
  const frames = [".  ", ".. ", "..."];
  const frame = frames[activity.frame % frames.length] ?? "...";
  const detail = activity.detail ? ` · ${activity.detail}` : "";
  return color(`${activity.label}${frame}${detail}`, fg(palette.brandLight));
}

function renderWelcomeBlock(state: TerminalTuiState, width: number): string[] {
  const mark = pixelMark();
  const slotReadyLabel = (slot: "governor" | "coding" | "vision"): string => {
    const configured = state.header?.profiles.slots?.[slot]?.primary;
    if (configured) {
      return `${configured.profileId}/${configured.model ?? configured.status.model ?? "?"} ${readyLabel(configured.status)}`;
    }
    const legacy = slot === "governor"
      ? state.header?.profiles.deepseek_governor
      : slot === "coding"
        ? state.header?.profiles.glm_coding_worker
        : state.header?.profiles.kimi_vision;
    return legacy ? readyLabel(legacy) : "missing";
  };
  const lines = [
    color(bold("开始输入你的任务"), fg(palette.text)),
    color("Enter 发送  ·  PgUp/PgDn 浏览消息  ·  Ctrl+T 工具详情  ·  F1 帮助", fg(palette.muted)),
    `${color("workspace", fg(palette.dim))} ${truncateMiddle(state.header?.workspaceRoot ?? "unknown", Math.max(width - 16, 12))}`,
    state.header
      ? `${color("models", fg(palette.dim))} governor ${slotReadyLabel("governor")}  coding ${slotReadyLabel("coding")}  vision ${slotReadyLabel("vision")}`
      : color("profiles loading...", fg(palette.dim)),
  ];
  const markWidth = 10;
  const textWidth = Math.max(width - markWidth - 3, 12);
  return Array.from({ length: Math.max(mark.length, lines.length) }, (_, index) => {
    const markLine = mark[index] ?? " ".repeat(markWidth);
    const textLine = lines[index] ?? "";
    return `${padRightVisible(markLine, markWidth)}   ${padRightVisible(cropVisible(textLine, textWidth), textWidth)}`;
  });
}

function renderHelpBlock(state: TerminalTuiState, width: number): string[] {
  const lines = (state.helpLines.length > 0 ? state.helpLines : ["F1 关闭帮助"]).flatMap((line) =>
    wrapText(line, Math.max(width - 2, 12)),
  );
  return [color("帮助", fg(palette.brandLight)), ...lines.map((line) => color(line, fg(palette.muted)))];
}

function renderApprovalBanner(state: TerminalTuiState, width: number): string[] {
  if (!state.approval) {
    return [];
  }
  const title = `${color("审批", fg(palette.warning))} ${state.approval.toolName} · ${state.approval.riskLabel}`;
  const actions = color("1 仅本次  ·  2 本会话  ·  3 拒绝", fg(palette.muted));
  const details = (state.approval.detailLines ?? [])
    .flatMap((line) => wrapText(line, Math.max(width, 8)))
    .map((line) => color(line, fg(palette.muted)));
  return [cropVisible(title, width), ...details, cropVisible(actions, width)];
}

function normalizeInlineMarkdown(text: string): string {
  return text
    .replace(/!\[([^\]]*)\]\(([^)]+)\)/g, "$1")
    .replace(/\[([^\]]+)\]\(([^)]+)\)/g, "$1")
    .replace(/`([^`]+)`/g, "$1")
    .replace(/\*\*([^*]+)\*\*/g, "$1")
    .replace(/__([^_]+)__/g, "$1")
    .replace(/\*([^*\n]+)\*/g, "$1")
    .replace(/_([^_\n]+)_/g, "$1")
    .replace(/~~([^~]+)~~/g, "$1")
    .trimEnd();
}

function isHorizontalRule(line: string): boolean {
  return /^\s*([-*_])(?:\s*\1){2,}\s*$/.test(line);
}

function isFence(line: string): boolean {
  return /^\s*```/.test(line);
}

function isHeading(line: string): boolean {
  return /^\s*#{1,6}\s+/.test(line);
}

function isBullet(line: string): boolean {
  return /^\s*[-*+]\s+/.test(line);
}

function isOrdered(line: string): boolean {
  return /^\s*\d+\.\s+/.test(line);
}

function isBlockquote(line: string): boolean {
  return /^\s*>\s?/.test(line);
}

function looksLikeTableAlignment(line: string): boolean {
  return /^\s*\|?[\s:-]+(?:\|[\s:-]+)+\|?\s*$/.test(line);
}

function looksLikeTableRow(line: string): boolean {
  return line.includes("|");
}

function splitTableRow(line: string): string[] {
  const trimmed = line.trim().replace(/^\|/, "").replace(/\|$/, "");
  return trimmed.split("|").map((cell) => normalizeInlineMarkdown(cell.trim()));
}

function applyBaseColor(line: string, kind: TuiMessageKind): string {
  if (!line) {
    return line;
  }
  if (kind === "error") {
    return color(line, fg(palette.danger));
  }
  if (kind === "system") {
    return color(line, fg(palette.system));
  }
  return color(line, fg(palette.assistant));
}

function renderMarkdownBlock(markdown: string, width: number, kind: TuiMessageKind): string[] {
  const lines = markdown.replace(/\r/g, "").split("\n");
  const rendered: string[] = [];
  const plainWidth = Math.max(width, 8);

  const pushBlank = (): void => {
    if (rendered.length > 0 && rendered[rendered.length - 1] !== "") {
      rendered.push("");
    }
  };

  let index = 0;
  while (index < lines.length) {
    const current = lines[index] ?? "";
    const trimmed = current.trim();

    if (!trimmed) {
      pushBlank();
      index += 1;
      continue;
    }

    if (isFence(current)) {
      index += 1;
      const codeLines: string[] = [];
      while (index < lines.length && !isFence(lines[index] ?? "")) {
        codeLines.push(lines[index] ?? "");
        index += 1;
      }
      if (index < lines.length) {
        index += 1;
      }
      for (const codeLine of codeLines) {
        const wrapped = wrapText(codeLine, Math.max(plainWidth - 2, 6));
        for (const segment of wrapped) {
          rendered.push(color(`  ${segment}`, fg(palette.muted)));
        }
      }
      continue;
    }

    if (isHorizontalRule(current)) {
      rendered.push(separator(Math.max(Math.min(plainWidth, 48), 12)));
      index += 1;
      continue;
    }

    if (looksLikeTableRow(current) && index + 1 < lines.length && looksLikeTableAlignment(lines[index + 1] ?? "")) {
      const rowBuffer: string[][] = [];
      rowBuffer.push(splitTableRow(current));
      index += 2;
      while (index < lines.length && looksLikeTableRow(lines[index] ?? "")) {
        rowBuffer.push(splitTableRow(lines[index] ?? ""));
        index += 1;
      }
      const columnCount = Math.max(...rowBuffer.map((row) => row.length));
      const maxColumnWidth = Math.max(Math.floor((plainWidth - Math.max(columnCount - 1, 0) * 3) / columnCount), 6);
      const columnWidths = Array.from({ length: columnCount }, (_, columnIndex) =>
        Math.min(
          maxColumnWidth,
          Math.max(
            4,
            ...rowBuffer.map((row) => (row[columnIndex] ? row[columnIndex]!.length : 0)),
          ),
        ),
      );
      const renderRow = (cells: string[]): string =>
        cells
          .map((cell, columnIndex) => padRightVisible(truncateMiddle(cell ?? "", columnWidths[columnIndex] ?? 8), columnWidths[columnIndex] ?? 8))
          .join(" │ ");
      rendered.push(color(renderRow(rowBuffer[0] ?? []), fg(palette.brandLight)));
      rendered.push(color(columnWidths.map((columnWidth) => "─".repeat(columnWidth)).join("─┼─"), fg(palette.dim)));
      for (const row of rowBuffer.slice(1)) {
        rendered.push(applyBaseColor(renderRow(row), kind));
      }
      continue;
    }

    const headingMatch = current.match(/^\s*(#{1,6})\s+(.+)$/);
    if (headingMatch) {
      const level = headingMatch[1]?.length ?? 1;
      const content = normalizeInlineMarkdown(headingMatch[2] ?? "");
      const wrapped = wrapText(content, plainWidth);
      for (const segment of wrapped) {
        rendered.push(color(level <= 2 ? bold(segment) : segment, fg(level <= 2 ? palette.brandLight : palette.text)));
      }
      index += 1;
      continue;
    }

    const bulletMatch = current.match(/^(\s*)[-*+]\s+(.+)$/);
    if (bulletMatch) {
      const indent = "  ".repeat(Math.floor((bulletMatch[1]?.length ?? 0) / 2));
      const prefix = `${indent}• `;
      const content = normalizeInlineMarkdown(bulletMatch[2] ?? "");
      const wrapped = wrapText(content, Math.max(plainWidth - prefix.length, 6));
      wrapped.forEach((segment, wrappedIndex) => {
        const line = wrappedIndex === 0 ? `${prefix}${segment}` : `${" ".repeat(prefix.length)}${segment}`;
        rendered.push(applyBaseColor(line, kind));
      });
      index += 1;
      continue;
    }

    const orderedMatch = current.match(/^(\s*)(\d+)\.\s+(.+)$/);
    if (orderedMatch) {
      const indent = "  ".repeat(Math.floor((orderedMatch[1]?.length ?? 0) / 2));
      const prefix = `${indent}${orderedMatch[2]}. `;
      const content = normalizeInlineMarkdown(orderedMatch[3] ?? "");
      const wrapped = wrapText(content, Math.max(plainWidth - prefix.length, 6));
      wrapped.forEach((segment, wrappedIndex) => {
        const line = wrappedIndex === 0 ? `${prefix}${segment}` : `${" ".repeat(prefix.length)}${segment}`;
        rendered.push(applyBaseColor(line, kind));
      });
      index += 1;
      continue;
    }

    if (isBlockquote(current)) {
      const content = normalizeInlineMarkdown(current.replace(/^\s*>\s?/, ""));
      const wrapped = wrapText(content, Math.max(plainWidth - 2, 6));
      for (const segment of wrapped) {
        rendered.push(color(`│ ${segment}`, fg(palette.muted)));
      }
      index += 1;
      continue;
    }

    const paragraphLines: string[] = [normalizeInlineMarkdown(current)];
    index += 1;
    while (index < lines.length) {
      const nextLine = lines[index] ?? "";
      const nextTrimmed = nextLine.trim();
      if (
        !nextTrimmed ||
        isFence(nextLine) ||
        isHorizontalRule(nextLine) ||
        isHeading(nextLine) ||
        isBullet(nextLine) ||
        isOrdered(nextLine) ||
        isBlockquote(nextLine) ||
        (looksLikeTableRow(nextLine) && index + 1 < lines.length && looksLikeTableAlignment(lines[index + 1] ?? ""))
      ) {
        break;
      }
      paragraphLines.push(normalizeInlineMarkdown(nextLine));
      index += 1;
    }
    const paragraph = paragraphLines.join(" ").replace(/\s+/g, " ").trim();
    const wrapped = wrapText(paragraph, plainWidth);
    for (const segment of wrapped) {
      rendered.push(applyBaseColor(segment, kind));
    }
  }

  while (rendered.length > 0 && rendered[rendered.length - 1] === "") {
    rendered.pop();
  }

  return rendered.length > 0 ? rendered : [applyBaseColor(normalizeInlineMarkdown(markdown), kind)];
}

const TOOL_DETAIL_CHAR_LIMIT = 12_000;

function toolEntryDuration(entry: TerminalTuiToolEntry): string | undefined {
  if (entry.startedAtMs === undefined) {
    return undefined;
  }
  const end = entry.endedAtMs ?? Date.now();
  return formatDuration(Math.max(end - entry.startedAtMs, 0));
}

function toolGroupDuration(group: TerminalTuiToolGroup): string {
  return formatDuration(Math.max((group.endedAtMs ?? Date.now()) - group.startedAtMs, 0));
}

function stringifyToolDetail(value: unknown): string | undefined {
  if (value === undefined) {
    return undefined;
  }
  try {
    const rendered = JSON.stringify(value, null, 2);
    return rendered === undefined ? undefined : rendered;
  } catch {
    return String(value);
  }
}

function cropToolDetail(value: string): string {
  if (value.length <= TOOL_DETAIL_CHAR_LIMIT) {
    return value;
  }
  return `${value.slice(0, TOOL_DETAIL_CHAR_LIMIT)}\n… 详情过长，已在终端视图中截断；完整结果仍保存在会话记录中。`;
}

function renderToolGroup(group: TerminalTuiToolGroup, width: number): string[] {
  const successCount = group.tools.filter((tool) => tool.status === "ok").length;
  const errorCount = group.tools.filter((tool) => tool.status === "error").length;
  const runningCount = group.tools.filter((tool) => tool.status === "running").length;
  const status = group.running || runningCount > 0
    ? `运行中 · ${group.tools.length} 项`
    : errorCount > 0
      ? `${group.tools.length} 项 · ${successCount} 成功 · ${errorCount} 失败`
      : `${group.tools.length} 项 · 全部完成`;
  const toggleHint = group.expanded ? "Ctrl+T 收起" : "Ctrl+T 展开";
  const marker = group.expanded ? "⌄" : "›";
  const headerColor = errorCount > 0 ? palette.danger : group.running ? palette.brandLight : palette.muted;
  const header = cropVisible(
    color(`${marker} 工具调用 ${group.sequence} · ${status} · ${toolGroupDuration(group)} · ${toggleHint}`, fg(headerColor)),
    width,
  );
  if (!group.expanded) {
    return [header];
  }

  const lines = [header];
  for (const tool of group.tools) {
    const marker = tool.status === "ok" ? "✓" : tool.status === "error" ? "×" : "•";
    const statusColor = tool.status === "ok" ? palette.success : tool.status === "error" ? palette.danger : palette.brandLight;
    const duration = toolEntryDuration(tool);
    const suffix = [duration, tool.fallback ? `fallback ${tool.fallback}` : undefined].filter(Boolean).join(" · ");
    lines.push(cropVisible(color(`  ${marker} ${tool.name}${suffix ? ` · ${suffix}` : ""}`, fg(statusColor)), width));

    const structuredDetail = stringifyToolDetail(tool.structuredContent);
    const distinctStructuredDetail = structuredDetail?.trim() === tool.output?.trim() ? undefined : structuredDetail;
    const details = [
      tool.output,
      distinctStructuredDetail,
      tool.error ? `error: ${tool.error}` : undefined,
      ...(tool.artifacts ?? []).map((artifact) => {
        const location = artifact.workspaceRelativePath ?? artifact.uri;
        return `artifact: ${artifact.fileName} · ${artifact.mimeType} · ${location}`;
      }),
    ].filter((detail): detail is string => Boolean(detail));
    for (const detail of details) {
      for (const detailLine of wrapText(cropToolDetail(detail), Math.max(width - 4, 8))) {
        lines.push(color(`    ${detailLine}`, fg(palette.muted)));
      }
    }
  }
  return lines;
}

function renderProcessGroup(group: TerminalTuiProcessGroup, width: number): string[] {
  const toolGroups = group.messages.filter((message) => message.toolGroup).length;
  const toolCount = group.messages.reduce((count, message) => count + (message.toolGroup?.tools.length ?? 0), 0);
  const progressCount = group.messages.filter((message) => message.kind === "assistant").length;
  const duration = group.durationMs === undefined ? undefined : formatDuration(group.durationMs);
  const parts = [
    duration ? `已处理 ${duration}` : "处理过程",
    toolGroups > 0 ? `${toolGroups} 轮工具` : undefined,
    toolCount > 0 ? `${toolCount} 项调用` : undefined,
    progressCount > 0 ? `${progressCount} 段进度` : undefined,
    group.expanded ? "Ctrl+T 收起过程" : "Ctrl+T 展开过程",
  ].filter((part): part is string => Boolean(part));
  const header = cropVisible(
    color(`${group.expanded ? "⌄" : "›"} ${parts.join(" · ")}`, fg(palette.muted)),
    width,
  );
  if (!group.expanded) {
    return [header];
  }
  const nestedWidth = Math.max(width - 2, 8);
  const nested = group.messages.flatMap((message, index) => {
    const block = renderMessageBlock(message, nestedWidth).map((line) => `  ${line}`);
    return index === 0 ? block : ["", ...block];
  });
  return [header, ...nested];
}

function renderMessageBlock(message: TerminalTuiMessage, width: number): string[] {
  if (message.processGroup) {
    return renderProcessGroup(message.processGroup, width);
  }
  if (message.toolGroup) {
    return renderToolGroup(message.toolGroup, width);
  }
  const plain = message.streaming ? `${message.content || ""}…` : message.content;
  switch (message.kind) {
    case "user": {
      const prefix = color("› ", fg(palette.brandLight));
      const wrapped = wrapText(plain, Math.max(width - 2, 8));
      return wrapped.map((line, index) => (index === 0 ? `${prefix}${line}` : `  ${line}`));
    }
    case "error": {
      const prefix = color("! ", fg(palette.danger));
      const wrapped = wrapText(plain, Math.max(width - 2, 8));
      return wrapped.map((line, index) => (index === 0 ? `${prefix}${line}` : `  ${line}`));
    }
    case "system": {
      return renderMarkdownBlock(plain, Math.max(width, 8), "system");
    }
    case "tool": {
      return wrapText(plain, Math.max(width, 8)).map((line) => color(line, fg(palette.muted)));
    }
    default:
      return renderMarkdownBlock(plain, Math.max(width, 8), message.kind);
  }
}

function renderActivityLine(state: TerminalTuiState, width: number): string[] {
  if (!state.activity || state.activity.mode !== "thinking") {
    return [];
  }
  const frames = [".  ", ".. ", "..."];
  const frame = frames[state.activity.frame % frames.length] ?? "...";
  const detail = state.activity.detail ? ` · ${state.activity.detail}` : "";
  return [cropVisible(color(`· ${state.activity.label}${frame}${detail}`, fg(palette.brandLight)), width)];
}

function renderMessages(state: TerminalTuiState, width: number, height: number): string[] {
  if (height <= 0) {
    return [];
  }
  const rawLines = state.messages.flatMap((message, index) => {
    const block = renderMessageBlock(message, width);
    return index === 0 ? block : ["", ...block];
  });
  const activityLines = renderActivityLine(state, width);
  const combined = activityLines.length > 0 ? [...rawLines, ...(rawLines.length > 0 ? [""] : []), ...activityLines] : rawLines;
  if (combined.length === 0) {
    return Array.from({ length: height }, () => "");
  }
  const offset = Math.max(state.messageScrollOffset, 0);
  const end = Math.max(combined.length - offset, 0);
  const start = Math.max(end - height, 0);
  const lines = combined.slice(start, end);
  while (lines.length < height) {
    lines.unshift("");
  }
  return lines;
}

function renderDebugBlock(state: TerminalTuiState, width: number, maxLines: number): string[] {
  if (!state.debugVisible) {
    return [];
  }
  const lines = state.debugLines
    .slice(Math.max(state.debugLines.length - maxLines, 0))
    .flatMap((line) => wrapText(line, Math.max(width - 2, 12)));
  return [
    color("调试视图 · Ctrl+B 隐藏", fg(palette.brandLight)),
    ...lines.map((line) => color(line, fg(palette.muted))),
  ];
}

function renderInputArea(
  state: TerminalTuiState,
  width: number,
): {
  lines: string[];
  cursorRowOffset: number;
  cursorColumnOffset: number;
} {
  const innerWidth = Math.max(width - 4, 10);
  const rawLines = wrapInputText(state.input.value, innerWidth);
  const showPlaceholder = state.input.value.length === 0;
  const visibleInputLines = rawLines.slice(Math.max(rawLines.length - 2, 0));
  const contentLines = showPlaceholder
    ? [color(dim(state.input.placeholder), fg(palette.dim))]
    : visibleInputLines.map((line) => color(line, fg(palette.text)));
  const promptLine = `${color("› ", fg(palette.brandLight))}${contentLines[0] ?? ""}`;
  const secondLine = contentLines[1] ? `  ${contentLines[1]}` : "";
  const hintLine = color(state.input.submitHint, fg(palette.muted));
  const lines = [separator(width), promptLine, secondLine, hintLine];

  const cursorLines = wrapInputText(state.input.value.slice(0, state.input.cursor), innerWidth);
  const visibleCursorLines = cursorLines.slice(Math.max(cursorLines.length - 2, 0));
  const cursorRowOffset = visibleCursorLines.length > 1 ? 2 : 1;
  const cursorColumnOffset = 3 + (visibleCursorLines[visibleCursorLines.length - 1]?.length ?? 0);

  return {
    lines,
    cursorRowOffset,
    cursorColumnOffset,
  };
}

function renderFooter(state: TerminalTuiState, width: number): string {
  const parts = ["PgUp/PgDn 浏览消息", "Ctrl+T 工具详情", "F1 帮助", "Ctrl+B 调试", "Ctrl+C 中断/退出"];
  if (state.messageScrollOffset > 0) {
    parts.push(`已回看 ${state.messageScrollOffset} 行`);
  }
  return padRightVisible(color(parts.join("  ·  "), fg(palette.dim)), width);
}

export function createInitialTerminalTuiState(): TerminalTuiState {
  return {
    cliState: "idle",
    recentTools: [],
    messages: [],
    helpVisible: false,
    helpLines: [],
    input: {
      mode: "prompt",
      value: "",
      cursor: 0,
      placeholder: "直接输入你的任务",
      submitHint: "Enter 发送  ·  Ctrl+T 工具详情  ·  F1 帮助",
      promptText: "deep-mix> ",
    },
    messageScrollOffset: 0,
    debugVisible: false,
    debugLines: [],
  };
}

export function renderTerminalTui(state: TerminalTuiState, viewport: TerminalViewport): RenderedTerminalFrame {
  const columns = Number.isFinite(viewport.columns) && viewport.columns > 0 ? viewport.columns : 80;
  // Keep the terminal's final column empty. Writing into the last cell puts
  // Windows terminals into pending-wrap state; the following newline can then
  // advance twice and visually insert a blank row through multi-line artwork.
  const contentWidth = Math.max(columns - 1, 1);
  const rows = Number.isFinite(viewport.rows) && viewport.rows > 0 ? viewport.rows : 24;
  const welcomeMode = state.messages.length === 0;

  const topBar = renderTopBar(state, contentWidth);
  const welcomeBlock = welcomeMode ? renderWelcomeBlock(state, contentWidth) : [];
  const helpBlock = state.helpVisible ? renderHelpBlock(state, contentWidth) : [];
  const approvalBanner = renderApprovalBanner(state, contentWidth);
  const inputArea = renderInputArea(state, contentWidth);
  const debugBlock = renderDebugBlock(state, contentWidth, 5);
  const footer = renderFooter(state, contentWidth);

  if (welcomeMode) {
    const screenLines = [
      ...topBar,
      "",
      ...welcomeBlock,
      "",
      ...helpBlock,
      ...(helpBlock.length > 0 ? [""] : []),
      ...approvalBanner,
      ...(approvalBanner.length > 0 ? [""] : []),
      ...inputArea.lines,
      footer,
    ];
    while (screenLines.length < rows) {
      screenLines.push("");
    }
    const cursorRow = topBar.length + 1 + welcomeBlock.length + 1 + helpBlock.length + (helpBlock.length > 0 ? 1 : 0) + approvalBanner.length + (approvalBanner.length > 0 ? 1 : 0) + 2;
    return {
      output: screenLines.slice(0, rows).join("\n"),
      cursor: {
        row: Math.min(rows, cursorRow),
        column: Math.min(contentWidth, inputArea.cursorColumnOffset),
      },
    };
  }

  const reservedHeight =
    topBar.length +
    1 +
    helpBlock.length +
    (helpBlock.length > 0 ? 1 : 0) +
    debugBlock.length +
    (debugBlock.length > 0 ? 1 : 0) +
    approvalBanner.length +
    (approvalBanner.length > 0 ? 1 : 0) +
    inputArea.lines.length +
    1;
  const messageHeight = Math.max(rows - reservedHeight, 6);
  const messages = renderMessages(state, contentWidth, messageHeight);

  const screenLines = [
    ...topBar,
    "",
    ...helpBlock,
    ...(helpBlock.length > 0 ? [""] : []),
    ...debugBlock,
    ...(debugBlock.length > 0 ? [""] : []),
    ...approvalBanner,
    ...(approvalBanner.length > 0 ? [""] : []),
    ...messages,
    ...inputArea.lines,
    footer,
  ];
  while (screenLines.length < rows) {
    screenLines.push("");
  }
  const cursorRow = screenLines.length - inputArea.lines.length - 1 + inputArea.cursorRowOffset;
  return {
    output: screenLines.slice(0, rows).join("\n"),
    cursor: {
      row: Math.min(rows, Math.max(cursorRow, 1)),
      column: Math.min(contentWidth, Math.max(inputArea.cursorColumnOffset, 1)),
    },
  };
}

export function stripAnsiForTest(text: string): string {
  return stripAnsi(text);
}
