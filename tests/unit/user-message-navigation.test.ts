import { describe, expect, it } from "vitest";
import type { SessionTurn } from "@codex-web/shared-types";
import { userMessageIndexAtReadingLine, DEFAULT_USER_MESSAGE_TICKS, userMessageIndexAtProgress, userMessageTargets, userMessageText, userMessageTickCapacity, visibleUserMessageIndices } from "../../apps/web/src/user-message-navigation";

describe("user message navigation", () => {
  it("uses a contiguous 20-message window before the viewport is measured", () => {
    expect(visibleUserMessageIndices(0, 0)).toEqual([]);
    expect(visibleUserMessageIndices(1, 0)).toEqual([0]);
    expect(visibleUserMessageIndices(20, 10)).toEqual(Array.from({ length: 20 }, (_, index) => index));
    expect(visibleUserMessageIndices(94, 0)).toEqual(Array.from({ length: 20 }, (_, index) => index));
    const middle = visibleUserMessageIndices(94, 47);
    expect(middle).toEqual(Array.from({ length: 20 }, (_, index) => 37 + index));
    expect(middle).not.toContain(0);
    expect(middle).not.toContain(93);
    expect(visibleUserMessageIndices(94, 93)).toEqual(Array.from({ length: 20 }, (_, index) => 74 + index));
    for (let slot = 0; slot < DEFAULT_USER_MESSAGE_TICKS; slot += 1) {
      expect(middle[userMessageIndexAtProgress(middle.length, slot / 19)]).toBe(37 + slot);
    }
  });

  it("fits more ticks on taller timelines up to 60, with room for hover previews", () => {
    expect(userMessageTickCapacity(600)).toBe(37);
    expect(userMessageTickCapacity(900)).toBe(60);
    expect(userMessageTickCapacity(1200)).toBe(60);
    expect(userMessageTickCapacity(4000)).toBe(60);
    expect(userMessageTickCapacity(240)).toBe(7);
    expect(userMessageTickCapacity(100)).toBe(1);
    for (const height of [0, Number.NaN, Number.POSITIVE_INFINITY]) {
      expect(userMessageTickCapacity(height)).toBe(DEFAULT_USER_MESSAGE_TICKS);
    }
  });

  it("resizes the contiguous window around the reading anchor", () => {
    for (const height of [240, 600, 900, 1200]) {
      const capacity = userMessageTickCapacity(height);
      for (const focus of [0, 47, 93]) {
        const indices = visibleUserMessageIndices(94, focus, capacity);
        expect(indices).toHaveLength(capacity);
        expect(indices).toContain(focus);
        expect(indices).toEqual(Array.from({ length: capacity }, (_, index) => indices[0]! + index));
        for (let slot = 0; slot < capacity; slot += 1) {
          expect(indices[userMessageIndexAtProgress(capacity, slot / (capacity - 1))]).toBe(indices[0]! + slot);
        }
      }
    }
    expect(visibleUserMessageIndices(30, 15, 60)).toEqual(Array.from({ length: 30 }, (_, index) => index));
    expect(visibleUserMessageIndices(200, 70, 60)).toEqual(visibleUserMessageIndices(150, 70, 60));
    expect(visibleUserMessageIndices(94, 47, 0)).toEqual([47]);
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
      { key: "first", turnIndex: 0, preview: "First question", responsePreview: "answer", optimistic: false },
      { key: "steer", turnIndex: 0, preview: "$review check this", responsePreview: "", optimistic: false },
      { key: "image", turnIndex: 1, preview: "图片或附件", responsePreview: "", optimistic: false },
      { key: "optimistic:pending", turnIndex: 1, preview: "Later", responsePreview: "", optimistic: true },
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
