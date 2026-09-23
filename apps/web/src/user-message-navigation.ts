import type { SessionItem, SessionTurn } from "@codex-web/shared-types";
import type { OptimisticUserMessage } from "./store";

type UserMessage = Extract<SessionItem, { type: "userMessage" }>;

export interface UserMessageTarget {
  key: string;
  turnIndex: number;
  preview: string;
  optimistic: boolean;
}

export const MAX_USER_MESSAGE_TICKS = 20;

export function visibleUserMessageIndices(count: number, focusIndex: number): number[] {
  if (count <= 0) return [];
  if (count <= MAX_USER_MESSAGE_TICKS) return Array.from({ length: count }, (_, index) => index);

  const focus = Math.max(0, Math.min(count - 1, Math.round(focusIndex)));
  const start = Math.max(0, Math.min(count - MAX_USER_MESSAGE_TICKS, focus - Math.floor(MAX_USER_MESSAGE_TICKS / 2)));
  return Array.from({ length: MAX_USER_MESSAGE_TICKS }, (_, index) => start + index);
}

export function userMessageIndexAtProgress(count: number, progress: number): number {
  return Math.max(0, Math.min(count - 1, Math.round(progress * (count - 1))));
}

export function userMessageText(item: UserMessage): string {
  return item.content.map((part) => part.type === "skill" && part.name ? `$${part.name}` : part.text ?? "").filter(Boolean).join("\n");
}

function preview(text: string): string {
  return text.replace(/\s+/g, " ").trim().slice(0, 240) || "图片或附件";
}

export function userMessageTargets(turns: SessionTurn[], optimisticMessages: OptimisticUserMessage[]): UserMessageTarget[] {
  const targets: UserMessageTarget[] = [];
  turns.forEach((turn, turnIndex) => {
    turn.items.forEach((item) => {
      if (item.type === "userMessage") targets.push({ key: item.id, turnIndex, preview: preview(userMessageText(item)), optimistic: false });
    });
  });
  optimisticMessages.forEach((message) => {
    targets.push({ key: `optimistic:${message.clientUserMessageId}`, turnIndex: Math.max(0, turns.length - 1), preview: preview(message.text), optimistic: true });
  });
  return targets;
}

// Retain the preceding question throughout its answer. Choosing the nearest
// bubble switches early on long answers and depends on virtual overscan.
export function userMessageIndexAtReadingLine(anchors: { index: number; top: number }[], readingLine: number): number | null {
  let preceding: number | null = null;
  let first: number | null = null;
  for (const anchor of anchors) {
    if (first === null || anchor.index < first) first = anchor.index;
    if (anchor.top <= readingLine + 1 && (preceding === null || anchor.index > preceding)) preceding = anchor.index;
  }
  return preceding ?? (first === null ? null : Math.max(0, first - 1));
}
