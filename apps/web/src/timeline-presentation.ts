import type { SessionItem, SessionTurn } from "@codex-web/shared-types";

export type ActivityItem = Extract<SessionItem, {
  type: "reasoning" | "commandExecution" | "fileChange" | "mcpToolCall" | "genericToolCall";
}>;

export type TimelineEntry =
  | { kind: "item"; item: SessionItem }
  | { kind: "activity"; items: ActivityItem[] };

export function isActivityItem(item: SessionItem): item is ActivityItem {
  return item.type === "reasoning"
    || item.type === "commandExecution"
    || item.type === "fileChange"
    || item.type === "mcpToolCall"
    || item.type === "genericToolCall";
}

export function groupTimelineItems(items: SessionItem[]): TimelineEntry[] {
  const entries: TimelineEntry[] = [];
  for (const item of items) {
    if (!isActivityItem(item)) {
      entries.push({ kind: "item", item });
      continue;
    }
    const previous = entries.at(-1);
    if (previous?.kind === "activity") previous.items.push(item);
    else entries.push({ kind: "activity", items: [item] });
  }
  return entries;
}

export function confirmedClientUserMessageIds(turns: SessionTurn[]): string[] {
  return turns.flatMap((turn) => turn.items.flatMap((item) => item.type === "userMessage" && item.clientId ? [item.clientId] : []));
}

export function unconfirmedOptimisticUserMessages<T extends { clientUserMessageId: string }>(turns: SessionTurn[], messages: T[]): T[] {
  const confirmed = new Set(confirmedClientUserMessageIds(turns));
  return messages.filter((message) => !confirmed.has(message.clientUserMessageId));
}

export function canReconcileOptimisticUserMessages(turns: SessionTurn[]): boolean {
  return !turns.some((turn) => turn.status === "inProgress");
}

export function formatTurnDuration(durationMs: number | null): string {
  if (durationMs === null || !Number.isFinite(durationMs) || durationMs < 0) return "";
  const totalSeconds = Math.max(1, Math.round(durationMs / 1_000));
  const minutes = Math.floor(totalSeconds / 60);
  const seconds = totalSeconds % 60;
  return minutes > 0 ? `${minutes}分钟${seconds}秒` : `${seconds}秒`;
}

function twoDigits(value: number): string {
  return String(value).padStart(2, "0");
}

export function formatTurnCompletedAt(completedAt: number | null): string {
  if (completedAt === null || !Number.isFinite(completedAt)) return "";
  const date = new Date(completedAt * 1_000);
  if (Number.isNaN(date.getTime())) return "";
  return `${date.getFullYear()}-${twoDigits(date.getMonth() + 1)}-${twoDigits(date.getDate())} ${twoDigits(date.getHours())}:${twoDigits(date.getMinutes())}:${twoDigits(date.getSeconds())}`;
}
