import type { SessionItem, SessionTurn } from "@codex-web/shared-types";
import type { OptimisticUserMessage } from "./store";

type UserMessage = Extract<SessionItem, { type: "userMessage" }>;

export interface UserMessageTarget {
  key: string;
  turnIndex: number;
  preview: string;
  optimistic: boolean;
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
