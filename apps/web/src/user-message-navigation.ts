import type { SessionItem, SessionTurn } from "@codex-web/shared-types";
import type { OptimisticUserMessage } from "./store";

type UserMessage = Extract<SessionItem, { type: "userMessage" }>;

export interface UserMessageTarget {
  key: string;
  turnIndex: number;
  preview: string;
  responsePreview: string;
  optimistic: boolean;
}

export const DEFAULT_USER_MESSAGE_TICKS = 20;
export const MAX_USER_MESSAGE_TICKS = 60;
export const USER_MESSAGE_TICK_SPACING = 12;

export function userMessageTickCapacity(height: number): number {
  if (!Number.isFinite(height) || height <= 0) return DEFAULT_USER_MESSAGE_TICKS;
  // Leave room for the centered hover preview at both ends of the rail.
  return Math.max(1, Math.min(MAX_USER_MESSAGE_TICKS, Math.floor((height - 2 * 72 - 4) / USER_MESSAGE_TICK_SPACING)));
}

export function visibleUserMessageIndices(count: number, focusIndex: number, capacity = DEFAULT_USER_MESSAGE_TICKS): number[] {
  if (count <= 0) return [];
  const limit = Number.isFinite(capacity) ? Math.max(1, Math.floor(capacity)) : DEFAULT_USER_MESSAGE_TICKS;
  if (count <= limit) return Array.from({ length: count }, (_, index) => index);

  const focus = Math.max(0, Math.min(count - 1, Math.round(focusIndex)));
  const start = Math.max(0, Math.min(count - limit, focus - Math.floor(limit / 2)));
  return Array.from({ length: limit }, (_, index) => start + index);
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
    let preceding: UserMessageTarget | null = null;
    turn.items.forEach((item) => {
      if (item.type === "userMessage") {
        preceding = { key: item.id, turnIndex, preview: preview(userMessageText(item)), responsePreview: "", optimistic: false };
        targets.push(preceding);
      } else if (item.type === "agentMessage" && preceding && item.text.trim() && preceding.responsePreview.length < 240) {
        preceding.responsePreview = preview(`${preceding.responsePreview} ${item.text}`);
      }
    });
  });
  optimisticMessages.forEach((message) => {
    targets.push({ key: `optimistic:${message.clientUserMessageId}`, turnIndex: Math.max(0, turns.length - 1), preview: preview(message.text), responsePreview: "", optimistic: true });
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
