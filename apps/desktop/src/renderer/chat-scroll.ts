export const CHAT_BOTTOM_THRESHOLD_PX = 80;

export interface ScrollViewportMetrics {
  scrollTop: number;
  scrollHeight: number;
  clientHeight: number;
}

export function isChatViewportNearBottom(
  viewport: ScrollViewportMetrics,
  threshold = CHAT_BOTTOM_THRESHOLD_PX,
): boolean {
  return viewport.scrollHeight - viewport.clientHeight - viewport.scrollTop <= threshold;
}
