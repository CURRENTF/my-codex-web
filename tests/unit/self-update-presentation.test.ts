import { describe, expect, it } from "vitest";
import {
  UPDATE_RESULT_INDICATOR_MS,
  isUpdateResultState,
  shouldShowUpdateResultIndicator,
} from "../../apps/web/src/self-update-presentation";

describe("self update result presentation", () => {
  const now = 2_000_000_000_000;

  it("shows successful update feedback for less than thirty minutes", () => {
    expect(shouldShowUpdateResultIndicator({ state: "succeeded", finishedAt: now }, now)).toBe(true);
    expect(shouldShowUpdateResultIndicator({ state: "succeeded", finishedAt: now - UPDATE_RESULT_INDICATOR_MS + 1 }, now)).toBe(true);
    expect(shouldShowUpdateResultIndicator({ state: "succeeded", finishedAt: now - UPDATE_RESULT_INDICATOR_MS }, now)).toBe(false);
  });

  it("applies the same bounded feedback to an up-to-date check", () => {
    expect(shouldShowUpdateResultIndicator({ state: "upToDate", finishedAt: now - 1_000 }, now)).toBe(true);
    expect(shouldShowUpdateResultIndicator({ state: "upToDate", finishedAt: null }, now)).toBe(false);
  });

  it("shows failed update feedback for less than thirty minutes", () => {
    expect(shouldShowUpdateResultIndicator({ state: "failed", finishedAt: now }, now)).toBe(true);
    expect(shouldShowUpdateResultIndicator({ state: "failed", finishedAt: now - UPDATE_RESULT_INDICATOR_MS + 1 }, now)).toBe(true);
    expect(shouldShowUpdateResultIndicator({ state: "failed", finishedAt: now - UPDATE_RESULT_INDICATOR_MS }, now)).toBe(false);
  });

  it("does not treat persistent configuration warnings as update results", () => {
    expect(isUpdateResultState("unavailable")).toBe(false);
    expect(shouldShowUpdateResultIndicator({ state: "unavailable", finishedAt: now }, now)).toBe(false);
  });
});
