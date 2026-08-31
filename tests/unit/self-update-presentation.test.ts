import { describe, expect, it } from "vitest";
import { UPDATE_SUCCESS_INDICATOR_MS, shouldShowUpdateSuccessIndicator } from "../../apps/web/src/self-update-presentation";

describe("self update success presentation", () => {
  const now = 2_000_000_000_000;

  it("shows successful update feedback for less than thirty minutes", () => {
    expect(shouldShowUpdateSuccessIndicator({ state: "succeeded", finishedAt: now }, now)).toBe(true);
    expect(shouldShowUpdateSuccessIndicator({ state: "succeeded", finishedAt: now - UPDATE_SUCCESS_INDICATOR_MS + 1 }, now)).toBe(true);
    expect(shouldShowUpdateSuccessIndicator({ state: "succeeded", finishedAt: now - UPDATE_SUCCESS_INDICATOR_MS }, now)).toBe(false);
  });

  it("applies the same bounded feedback to an up-to-date check", () => {
    expect(shouldShowUpdateSuccessIndicator({ state: "upToDate", finishedAt: now - 1_000 }, now)).toBe(true);
    expect(shouldShowUpdateSuccessIndicator({ state: "upToDate", finishedAt: null }, now)).toBe(false);
    expect(shouldShowUpdateSuccessIndicator({ state: "failed", finishedAt: now }, now)).toBe(false);
  });
});
