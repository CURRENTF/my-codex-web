import type { SessionItem, SessionTurn, SessionTurnError } from "@codex-web/shared-types";

export type ActivityItem = Extract<SessionItem, {
  type: "reasoning" | "commandExecution" | "fileChange" | "mcpToolCall" | "genericToolCall";
}>;

export type TimelineEntry =
  | { kind: "item"; item: SessionItem }
  | { kind: "activity"; items: ActivityItem[] }
  | { kind: "error"; errors: SessionTurnError[]; positionKnown: boolean; key: string };

export function isActivityItem(item: SessionItem): item is ActivityItem {
  return item.type === "reasoning"
    || item.type === "commandExecution"
    || item.type === "fileChange"
    || item.type === "mcpToolCall"
    || item.type === "genericToolCall";
}

function errorGroupKey(error: SessionTurnError): string {
  // Retry counters describe progress within one failure, not a different failure.
  const message = error.message.trim().replace(/\bReconnecting(?:\.{3}|…)?\s*\d+\s*\/\s*\d+/gi, "Reconnecting…");
  return JSON.stringify([error.code, error.httpStatusCode, message]);
}

export function groupTimelineItems(items: SessionItem[], errors: SessionTurnError[] = []): TimelineEntry[] {
  const entries: TimelineEntry[] = [];
  const ids = new Set(items.map((item) => item.id));
  const errorsByAnchor = new Map<string | null | undefined, Array<{ error: SessionTurnError; index: number }>>();
  errors.forEach((error, index) => {
    const anchor = error.afterItemId === null || (error.afterItemId !== undefined && ids.has(error.afterItemId)) ? error.afterItemId : undefined;
    const bucket = errorsByAnchor.get(anchor) ?? [];
    bucket.push({ error, index });
    errorsByAnchor.set(anchor, bucket);
  });
  const insertErrors = (anchor: string | null | undefined) => {
    let previous: Extract<TimelineEntry, { kind: "error" }> | undefined;
    for (const { error, index } of errorsByAnchor.get(anchor) ?? []) {
      if (previous && errorGroupKey(previous.errors[0]!) === errorGroupKey(error)) previous.errors.push(error);
      else {
        previous = { kind: "error", errors: [error], positionKnown: anchor !== undefined, key: `error-${index}` };
        entries.push(previous);
      }
    }
  };
  insertErrors(null);
  for (const item of items) {
    const previous = entries.at(-1);
    if (!isActivityItem(item)) entries.push({ kind: "item", item });
    else if (previous?.kind === "activity") previous.items.push(item);
    else entries.push({ kind: "activity", items: [item] });
    insertErrors(item.id);
  }
  // Historical snapshots may have no item anchor. Keep them explicitly unlocated.
  insertErrors(undefined);
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
