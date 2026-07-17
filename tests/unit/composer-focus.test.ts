import { describe, expect, it } from "vitest";
import { shouldRestoreComposerFocus } from "../../apps/web/src/composer-focus.js";

const base = {
  hasActiveElement: true,
  activeIsTarget: false,
  activeIsOrigin: false,
  activeIsBody: false,
  activeIsDocumentElement: false,
  activeIsConnected: true,
};

describe("Composer focus restoration", () => {
  it("restores focus while the close control still owns it or has disappeared", () => {
    expect(shouldRestoreComposerFocus({ ...base, activeIsOrigin: true })).toBe(true);
    expect(shouldRestoreComposerFocus({ ...base, activeIsConnected: false })).toBe(true);
    expect(shouldRestoreComposerFocus({ ...base, activeIsBody: true })).toBe(true);
  });

  it("does not steal focus after the user chooses another connected control", () => {
    expect(shouldRestoreComposerFocus(base)).toBe(false);
  });
});
