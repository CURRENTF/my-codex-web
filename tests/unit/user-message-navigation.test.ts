import { describe, expect, it } from "vitest";
import type { SessionTurn } from "@codex-web/shared-types";
import { MAX_USER_MESSAGE_TICKS, userMessageIndexAtProgress, userMessageTargets, userMessageText, visibleUserMessageIndices } from "../../apps/web/src/user-message-navigation";

describe("user message navigation", () => {
  it("limits visible marks while keeping every message addressable", () => {
    expect(visibleUserMessageIndices(0, 0)).toEqual([]);
    expect(visibleUserMessageIndices(20, 10)).toEqual(Array.from({ length: 20 }, (_, index) => index));
    const nearStart = visibleUserMessageIndices(94, 0);
    const nearMiddle = visibleUserMessageIndices(94, 47);
    const nearEnd = visibleUserMessageIndices(94, 93);
    for (const indices of [nearStart, nearMiddle, nearEnd]) {
      expect(indices).toHaveLength(MAX_USER_MESSAGE_TICKS);
      expect(indices[0]).toBe(0);
      expect(indices.at(-1)).toBe(93);
      expect(new Set(indices).size).toBe(MAX_USER_MESSAGE_TICKS);
      expect(indices).toEqual([...indices].sort((a, b) => a - b));
    }
    expect(nearStart).toContain(0);
    expect(nearMiddle).toContain(47);
    expect(nearEnd).toContain(93);
    expect(nearStart).not.toEqual(nearMiddle);
    expect(nearMiddle).not.toEqual(nearEnd);
    for (let index = 0; index < 94; index += 1) {
      expect(userMessageIndexAtProgress(94, index / 93)).toBe(index);
    }
  });

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
