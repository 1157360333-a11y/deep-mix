export const DESKTOP_SHORTCUT_IDS = [
  "sendMessage",
  "newLine",
  "stopTask",
  "dismissOverlay",
  "newTask",
  "toggleLeftSidebar",
  "toggleRightPanel",
  "focusComposer",
  "zoomIn",
  "zoomOut",
  "resetZoom",
] as const;

export type DesktopShortcutId = typeof DESKTOP_SHORTCUT_IDS[number];
export type DesktopShortcutBindings = Record<DesktopShortcutId, string | null>;

export const DEFAULT_DESKTOP_SHORTCUTS: DesktopShortcutBindings = {
  sendMessage: "Enter",
  newLine: "Shift+Enter",
  stopTask: "Ctrl+Period",
  dismissOverlay: "Escape",
  newTask: "Ctrl+KeyN",
  toggleLeftSidebar: "Ctrl+KeyB",
  toggleRightPanel: "Ctrl+Shift+KeyB",
  focusComposer: "Ctrl+KeyL",
  zoomIn: "Ctrl+Equal",
  zoomOut: "Ctrl+Minus",
  resetZoom: "Ctrl+Digit0",
};

const KEY_ALIASES: Record<string, string> = {
  plus: "Equal", equals: "Equal", equal: "Equal", minus: "Minus", dash: "Minus", period: "Period", dot: "Period",
  space: "Space", esc: "Escape", escape: "Escape", enter: "Enter", tab: "Tab",
  backspace: "Backspace", delete: "Delete", arrowup: "ArrowUp", arrowdown: "ArrowDown",
  arrowleft: "ArrowLeft", arrowright: "ArrowRight", home: "Home", end: "End",
  pageup: "PageUp", pagedown: "PageDown",
};

function normalizeKey(raw: string): string | null {
  const key = raw.trim();
  if (/^Key[A-Z]$/i.test(key)) return `Key${key.slice(-1).toUpperCase()}`;
  if (/^Digit[0-9]$/i.test(key)) return `Digit${key.slice(-1)}`;
  if (/^[A-Z]$/i.test(key)) return `Key${key.toUpperCase()}`;
  if (/^[0-9]$/.test(key)) return `Digit${key}`;
  if (/^F(?:[1-9]|1[0-2])$/i.test(key)) return key.toUpperCase();
  return KEY_ALIASES[key.toLowerCase()] ?? null;
}

/** Canonical bindings use KeyboardEvent.code so they remain layout-stable. */
export function normalizeDesktopShortcut(value: string): string | null {
  const parts = value.split("+").map((part) => part.trim()).filter(Boolean);
  if (parts.length === 1) {
    const key = normalizeKey(parts[0]);
    return key === "Enter" || key === "Escape" ? key : null;
  }
  const modifiers = new Set<string>();
  let key: string | null = null;
  for (const part of parts) {
    const normalized = part.toLowerCase();
    if (normalized === "ctrl" || normalized === "control" || normalized === "cmd" || normalized === "command" || normalized === "meta") modifiers.add("Ctrl");
    else if (normalized === "alt" || normalized === "option") modifiers.add("Alt");
    else if (normalized === "shift") modifiers.add("Shift");
    else if (!key) key = normalizeKey(part);
    else return null;
  }
  if (!key || modifiers.size === 0) return null;
  return ["Ctrl", "Alt", "Shift"].filter((modifier) => modifiers.has(modifier)).concat(key).join("+");
}

export function shortcutFromKeyboardEvent(event: Pick<KeyboardEvent, "code" | "ctrlKey" | "metaKey" | "altKey" | "shiftKey">): string | null {
  if (/^(?:Control|Meta|Alt|Shift)(?:Left|Right)?$/.test(event.code)) return null;
  const key = normalizeKey(event.code);
  if (!key) return null;
  if (!(event.ctrlKey || event.metaKey || event.altKey || event.shiftKey)) return key === "Enter" || key === "Escape" ? key : null;
  return [
    (event.ctrlKey || event.metaKey) ? "Ctrl" : null,
    event.altKey ? "Alt" : null,
    event.shiftKey ? "Shift" : null,
    key,
  ].filter((part): part is string => Boolean(part)).join("+");
}

export function formatDesktopShortcut(shortcut: string | null): string {
  if (!shortcut) return "未设置";
  return shortcut.split("+").map((part) => {
    if (/^Key[A-Z]$/.test(part)) return part.slice(3);
    if (/^Digit[0-9]$/.test(part)) return part.slice(5);
    if (part === "Equal") return "=";
    if (part === "Minus") return "-";
    if (part === "Period") return ".";
    if (part === "Space") return "空格";
    return part;
  }).join(" + ");
}

export function resolveDesktopShortcuts(value: unknown): DesktopShortcutBindings {
  const input = value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : {};
  return Object.fromEntries(DESKTOP_SHORTCUT_IDS.map((id) => {
    const candidate = input[id];
    if (candidate === null) return [id, null];
    if (typeof candidate === "string") return [id, normalizeDesktopShortcut(candidate) ?? DEFAULT_DESKTOP_SHORTCUTS[id]];
    return [id, DEFAULT_DESKTOP_SHORTCUTS[id]];
  })) as DesktopShortcutBindings;
}
