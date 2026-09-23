import { describe, expect, it } from "vitest";
import type { SessionTurn } from "@codex-web/shared-types";
import { userMessageTargets, userMessageText } from "../../apps/web/src/user-message-navigation";

describe("user message navigation", () => {
  it("includes every user message within a Turn and pending messages in order", () => {
    const turns: SessionTurn[] = [{
      id: "turn-1", status: "completed", startedAt: null, completedAt: null, durationMs: null,
      items: [
        { type: "userMessage", id: "first", content: [{ type: "text", text: "  First\n\nquestion  " }] },
        { type: "agentMessage", id: "reply", text: "answer" },
        { type: "userMessage", id: "steer", content: [{ type: "skill", name: "review" }, { type: "text", text: "check this" }] },
      ],
    }, {
      id: "turn-2", status: "inProgress", startedAt: null, completedAt: null, durationMs: null,
      items: [{ type: "userMessage", id: "image", content: [{ type: "image", path: "/tmp/image.png" }] }],
    }];

    expect(userMessageText(turns[0]!.items[2]! as Extract<SessionTurn["items"][number], { type: "userMessage" }>)).toBe("$review\ncheck this");
    expect(userMessageTargets(turns, [{ clientUserMessageId: "pending", text: "Later", state: "queued" }])).toEqual([
      { key: "first", turnIndex: 0, preview: "First question", optimistic: false },
      { key: "steer", turnIndex: 0, preview: "$review check this", optimistic: false },
      { key: "image", turnIndex: 1, preview: "图片或附件", optimistic: false },
      { key: "optimistic:pending", turnIndex: 1, preview: "Later", optimistic: true },
    ]);
  });
});
