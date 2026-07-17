export const MIN_SIDE_CHAT_PERCENT = 28;
export const MAX_SIDE_CHAT_PERCENT = 65;

export function resizedSideChatWidth(startPercent: number, horizontalDelta: number, workspaceWidth: number): number {
  if (!Number.isFinite(workspaceWidth) || workspaceWidth <= 0) return startPercent;
  return Math.min(MAX_SIDE_CHAT_PERCENT, Math.max(MIN_SIDE_CHAT_PERCENT, startPercent + horizontalDelta / workspaceWidth * 100));
}
