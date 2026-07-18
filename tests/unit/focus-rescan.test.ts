import { describe, expect, it } from "vitest";
import { FOCUS_RESCAN_INTERVAL_MS, shouldRunFocusRescan } from "../../apps/web/src/focus-rescan.js";

describe("focus-triggered Project rescans", () => {
  it("does not rescan when focus returns from a product-owned modal", () => {
    expect(shouldRunFocusRescan({
      now: FOCUS_RESCAN_INTERVAL_MS + 1,
      lastScanAt: 0,
      modalFocusSuppressed: true,
    })).toBe(false);
  });

  it("runs at most once per interval outside product-owned modals", () => {
    expect(shouldRunFocusRescan({ now: FOCUS_RESCAN_INTERVAL_MS - 1, lastScanAt: 0, modalFocusSuppressed: false })).toBe(false);
    expect(shouldRunFocusRescan({ now: FOCUS_RESCAN_INTERVAL_MS, lastScanAt: 0, modalFocusSuppressed: false })).toBe(true);
  });
});
