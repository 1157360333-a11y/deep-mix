export interface DesktopMessageAttachment {
  id: string;
  name: string;
  path: string;
  ref?: `file://${string}`;
  workspaceRoot?: string;
  size: number;
  mimeType: string;
  kind: "image" | "document" | "code" | "other";
  previewUrl?: string;
}

export const DESKTOP_ORIGINAL_PROMPT_METADATA_KEY = "desktopOriginalPrompt";
export const DESKTOP_ATTACHMENTS_METADATA_KEY = "desktopAttachments";

const DESKTOP_ATTACHMENTS_MARKER = "\n\n[Desktop attachments]\n";
const DESKTOP_ATTACHMENTS_FOOTER = "Use these local files as task inputs.";
const attachmentKinds = new Set<DesktopMessageAttachment["kind"]>(["image", "document", "code", "other"]);

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function isAttachmentDescriptor(value: unknown): value is DesktopMessageAttachment {
  if (!isRecord(value)) return false;
  return typeof value.id === "string"
    && typeof value.name === "string"
    && typeof value.path === "string"
    && typeof value.size === "number"
    && typeof value.mimeType === "string"
    && typeof value.kind === "string"
    && attachmentKinds.has(value.kind as DesktopMessageAttachment["kind"])
    && (value.ref === undefined || typeof value.ref === "string")
    && (value.workspaceRoot === undefined || typeof value.workspaceRoot === "string")
    && (value.previewUrl === undefined || typeof value.previewUrl === "string");
}

function withoutPreview(attachment: DesktopMessageAttachment): DesktopMessageAttachment {
  const { previewUrl: _previewUrl, ...persisted } = attachment;
  return persisted;
}

export function createDesktopMessageMetadata(
  prompt: string,
  attachments: DesktopMessageAttachment[],
): Record<string, unknown> {
  return {
    [DESKTOP_ORIGINAL_PROMPT_METADATA_KEY]: prompt,
    [DESKTOP_ATTACHMENTS_METADATA_KEY]: attachments.map(withoutPreview),
  };
}

export interface DesktopMessagePresentation {
  prompt: string;
  attachments: DesktopMessageAttachment[];
  source: "metadata" | "legacy_prompt";
}

function attachmentPathFromReference(reference: string): string {
  return reference.startsWith("file://") ? reference.slice("file://".length) : reference;
}

/**
 * Compatibility parser for messages persisted before Desktop attachment
 * presentation metadata was introduced. It only accepts the exact footer the
 * Desktop main process generated, so ordinary user text remains untouched.
 */
export function parseLegacyDesktopAttachmentPrompt(content: string): DesktopMessagePresentation | undefined {
  const markerIndex = content.lastIndexOf(DESKTOP_ATTACHMENTS_MARKER);
  if (markerIndex < 0) return undefined;

  const prompt = content.slice(0, markerIndex);
  const tail = content.slice(markerIndex + DESKTOP_ATTACHMENTS_MARKER.length);
  const lines = tail.split(/\r?\n/);
  if (lines.at(-1) !== DESKTOP_ATTACHMENTS_FOOTER) return undefined;

  const attachmentLines = lines.slice(0, -1);
  if (attachmentLines.length === 0 || attachmentLines.length > 50) return undefined;
  const attachments: DesktopMessageAttachment[] = [];
  for (const [index, line] of attachmentLines.entries()) {
    const match = /^- (.+) \((image|document|code|other), ([^)]+)\): (.+)$/.exec(line);
    if (!match) return undefined;
    const [, name, kind, mimeType, reference] = match;
    if (!name || !kind || !mimeType || !reference) return undefined;
    attachments.push({
      id: `legacy-attachment-${index}-${reference}`,
      name,
      path: attachmentPathFromReference(reference),
      ...(reference.startsWith("file://") ? { ref: reference as `file://${string}` } : {}),
      size: 0,
      mimeType,
      kind: kind as DesktopMessageAttachment["kind"],
    });
  }

  return { prompt, attachments, source: "legacy_prompt" };
}

export function readDesktopMessagePresentation(
  content: string,
  metadata?: Record<string, unknown>,
): DesktopMessagePresentation | undefined {
  const originalPrompt = metadata?.[DESKTOP_ORIGINAL_PROMPT_METADATA_KEY];
  const storedAttachments = metadata?.[DESKTOP_ATTACHMENTS_METADATA_KEY];
  if (typeof originalPrompt === "string" && Array.isArray(storedAttachments)) {
    const attachments = storedAttachments.filter(isAttachmentDescriptor);
    if (attachments.length === storedAttachments.length) {
      return { prompt: originalPrompt, attachments, source: "metadata" };
    }
  }
  return parseLegacyDesktopAttachmentPrompt(content);
}
