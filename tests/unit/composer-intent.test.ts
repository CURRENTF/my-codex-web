import { describe, expect, it } from "vitest";
import { expectedSteerTurnId } from "../../apps/web/src/composer-intent";

describe("Composer submission intent", () => {
  it("preserves a Steer target after the Turn finishes before click dispatch", () => {
    expect(expectedSteerTurnId("turn-active", false, undefined)).toBe("turn-active");
  });

  it("uses the live Turn when there is no remembered draft intent", () => {
    expect(expectedSteerTurnId(null, true, "turn-live")).toBe("turn-live");
    expect(expectedSteerTurnId(null, false, undefined)).toBeNull();
  });
});
