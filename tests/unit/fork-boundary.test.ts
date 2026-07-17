import { describe, expect, it } from "vitest";
import type { CodexTurn } from "../../apps/web/src/api";
import { forkBoundaryForTurn, questionForTurn } from "../../apps/web/src/fork-boundary";

function turn(id: string, status: CodexTurn["status"]): CodexTurn {
  return { id, status, items: [], startedAt: 1, completedAt: status === "inProgress" ? null : 2, durationMs: 1_000 };
}

describe("Fork timeline boundaries", () => {
  it("offers Fork only for completed Turns and uses the previous completed boundary", () => {
    const turns = [turn("first", "completed"), turn("failed", "failed"), turn("second", "completed"), turn("active", "inProgress")];
    expect(forkBoundaryForTurn(turns, 0)).toEqual({ canFork: true, previousCompletedTurnId: null });
    expect(forkBoundaryForTurn(turns, 1)).toEqual({ canFork: false, previousCompletedTurnId: "first" });
    expect(forkBoundaryForTurn(turns, 2)).toEqual({ canFork: true, previousCompletedTurnId: "first" });
    expect(forkBoundaryForTurn(turns, 3)).toEqual({ canFork: false, previousCompletedTurnId: "second" });
  });

  it("prefills the selected completed Turn question when earlier Turns failed", () => {
    const turns = [
      { ...turn("failed", "failed"), items: [{ id: "u1", type: "userMessage", content: [{ type: "text", text: "failed question" }] }] },
      { ...turn("completed", "completed"), items: [{ id: "u2", type: "userMessage", content: [{ type: "text", text: "selected question" }] }] },
    ] as CodexTurn[];

    expect(forkBoundaryForTurn(turns, 1)).toEqual({ canFork: true, previousCompletedTurnId: null });
    expect(questionForTurn(turns, "completed")).toBe("selected question");
  });
});
