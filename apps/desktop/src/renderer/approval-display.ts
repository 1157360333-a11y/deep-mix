import type { ApprovalRecord } from "../../../../packages/shared-schema/src/index.js";

const MAX_DISPLAY_TEXT_CHARS = 4_096;
const MAX_DISPLAY_ITEMS = 256;

function sanitizeDisplayText(value: string): string {
  return value
    .replace(/[\u0000-\u001f\u007f]+/gu, " ")
    .trim()
    .slice(0, MAX_DISPLAY_TEXT_CHARS);
}

function sanitizeDisplayItems(values: readonly string[] | undefined): string[] {
  return (values ?? [])
    .slice(0, MAX_DISPLAY_ITEMS)
    .map(sanitizeDisplayText)
    .filter(Boolean);
}

export interface DesktopApprovalDisplayDetails {
  action?: string;
  risk?: ApprovalRecord["sideEffectLevel"];
  summary: string;
  paths: string[];
  revisions: string[];
}

/**
 * Builds the user-visible, bounded approval scope. Deliberately excludes
 * argumentSummary because it may contain sensitive or unnecessarily verbose
 * command parameters; paths and revisions are the explicit review surface.
 */
export function buildApprovalDisplayDetails(
  approval: ApprovalRecord,
): DesktopApprovalDisplayDetails {
  const presentation = approval.presentation;
  const summary = sanitizeDisplayText(presentation?.summary ?? approval.reason);
  const action = presentation?.action
    ? sanitizeDisplayText(presentation.action)
    : undefined;
  return {
    ...(action ? { action } : {}),
    ...(approval.sideEffectLevel ? { risk: approval.sideEffectLevel } : {}),
    summary,
    paths: sanitizeDisplayItems(presentation?.paths),
    revisions: sanitizeDisplayItems(presentation?.revisions),
  };
}
