import { describe, expect, it } from "vitest";
import type { SessionTurn } from "@codex-web/shared-types";
import { userMessageIndexAtReadingLine, MAX_USER_MESSAGE_TICKS, userMessageIndexAtProgress, userMessageTargets, userMessageText, visibleUserMessageIndices } from "../../apps/web/src/user-message-navigation";

describe("user message navigation", () => {
  it("shows only a contiguous window of up to 20 nearby messages", () => {
    expect(visibleUserMessageIndices(0, 0)).toEqual([]);
    expect(visibleUserMessageIndices(1, 0)).toEqual([0]);
    expect(visibleUserMessageIndices(20, 10)).toEqual(Array.from({ length: 20 }, (_, index) => index));
    expect(visibleUserMessageIndices(94, 0)).toEqual(Array.from({ length: 20 }, (_, index) => index));
    const middle = visibleUserMessageIndices(94, 47);
    expect(middle).toEqual(Array.from({ length: 20 }, (_, index) => 37 + index));
    expect(middle).not.toContain(0);
    expect(middle).not.toContain(93);
    expect(visibleUserMessageIndices(94, 93)).toEqual(Array.from({ length: 20 }, (_, index) => 74 + index));
    for (let slot = 0; slot < MAX_USER_MESSAGE_TICKS; slot += 1) {
      expect(middle[userMessageIndexAtProgress(middle.length, slot / 19)]).toBe(37 + slot);
    }
  });

  it("keeps a middle window stable as more history loads and moves it only with the reading anchor", () => {
    expect(visibleUserMessageIndices(150, 47)).toEqual(visibleUserMessageIndices(94, 47));
    expect(visibleUserMessageIndices(94, 48)).toEqual(visibleUserMessageIndices(94, 47).map((index) => index + 1));
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

describe("reading position", () => {
  it("keeps a long answer attached to its preceding question", () => {
    expect(userMessageIndexAtReadingLine([{ index: 3, top: -5000 }, { index: 4, top: 100 }], 16)).toBe(3);
    expect(userMessageIndexAtReadingLine([{ index: 3, top: -5084 }, { index: 4, top: 16 }], 16)).toBe(4);
  });
  it("does not advance when virtual overscan drops the preceding bubble", () => {
    expect(userMessageIndexAtReadingLine([{ index: 4, top: 100 }], 16)).toBe(3);
    expect(userMessageIndexAtReadingLine([], 16)).toBeNull();
  });
});
