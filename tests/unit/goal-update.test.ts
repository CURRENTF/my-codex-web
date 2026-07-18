import { describe, expect, it } from "vitest";
import type { Goal } from "../../apps/web/src/api";
import { goalUpdateInput } from "../../apps/web/src/goal-update";

const goal: Goal = {
  threadId: "thread-1", objective: "Ship V1", tokenBudget: 80_000, status: "active",
  tokensUsed: 18_200, timeUsedSeconds: 100, createdAt: 1, updatedAt: 2,
};

describe("Goal update payload", () => {
  it("omits an unchanged Objective when only status or budget changes", () => {
    expect(goalUpdateInput(goal, "Ship V1", 90_000, "paused")).toEqual({ tokenBudget: 90_000, status: "paused" });
  });

  it("includes Objective when it actually changes or a Goal is created", () => {
    expect(goalUpdateInput(goal, "Ship V2", 80_000, "active")).toEqual({ objective: "Ship V2" });
    expect(goalUpdateInput(null, "Ship V1", null, "active")).toEqual({ objective: "Ship V1", tokenBudget: null, status: "active" });
  });
});
