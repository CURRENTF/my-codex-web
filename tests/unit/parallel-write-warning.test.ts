import { describe, expect, it } from "vitest";
import { shouldWarnAboutParallelFullAccess } from "../../apps/web/src/parallel-write-warning.js";

describe("parallel workspace warning", () => {
  it("shows only while both panes are active with Full Access", () => {
    expect(shouldWarnAboutParallelFullAccess(
      { state: "running", accessMode: "fullAccess" },
      { state: "waitingForInput", accessMode: "fullAccess" },
    )).toBe(true);
    expect(shouldWarnAboutParallelFullAccess(
      { state: "idle", accessMode: "fullAccess" },
      { state: "running", accessMode: "fullAccess" },
    )).toBe(false);
    expect(shouldWarnAboutParallelFullAccess(
      { state: "running", accessMode: "workspaceWrite" },
      { state: "running", accessMode: "fullAccess" },
    )).toBe(false);
  });
});
