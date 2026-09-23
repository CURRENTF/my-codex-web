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

  const lastIndex = count - 1;
  const focus = Math.max(0, Math.min(lastIndex, Math.round(focusIndex)));
  const indices = new Set<number>();
  const overviewCount = 8;
  const nearbyCount = MAX_USER_MESSAGE_TICKS - overviewCount;
  for (let index = 0; index < overviewCount; index += 1) {
    indices.add(Math.round(index / (overviewCount - 1) * lastIndex));
  }
  const nearbyStart = Math.max(0, Math.min(count - nearbyCount, focus - Math.floor(nearbyCount / 2)));
  for (let index = nearbyStart; index < nearbyStart + nearbyCount; index += 1) indices.add(index);

  // Overview and nearby marks can overlap. Fill the remaining slots across the largest gaps.
  while (indices.size < MAX_USER_MESSAGE_TICKS) {
    const ordered = [...indices].sort((a, b) => a - b);
    let next = -1;
    let largestGap = -1;
    for (let index = 1; index < ordered.length; index += 1) {
      const gap = ordered[index]! - ordered[index - 1]!;
      if (gap > largestGap) { largestGap = gap; next = Math.floor((ordered[index]! + ordered[index - 1]!) / 2); }
    }
    indices.add(next);
  }
  return [...indices].sort((a, b) => a - b);
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
