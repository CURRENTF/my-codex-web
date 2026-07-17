import { describe, expect, it } from "vitest";
import { shouldShowFullAccessNotice } from "../../apps/web/src/full-access-notice";

describe("Full Access notice", () => {
  it("appears as soon as the Composer selects Full Access", () => {
    expect(shouldShowFullAccessNotice("readOnly", "fullAccess", false)).toBe(true);
    expect(shouldShowFullAccessNotice("workspaceWrite", "fullAccess", false)).toBe(true);
  });

  it("is shown only once per Project", () => {
    expect(shouldShowFullAccessNotice("fullAccess", null, false)).toBe(true);
    expect(shouldShowFullAccessNotice("fullAccess", null, true)).toBe(false);
  });
});
