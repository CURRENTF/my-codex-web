import { describe, expect, it } from "vitest";
import { FOCUS_RESCAN_INTERVAL_MS, shouldRunFocusRescan } from "../../apps/web/src/focus-rescan.js";

describe("focus-triggered Project rescans", () => {
  it("runs at most once per interval", () => {
    expect(shouldRunFocusRescan({ now: FOCUS_RESCAN_INTERVAL_MS - 1, lastScanAt: 0 })).toBe(false);
    expect(shouldRunFocusRescan({ now: FOCUS_RESCAN_INTERVAL_MS, lastScanAt: 0 })).toBe(true);
  });
});
