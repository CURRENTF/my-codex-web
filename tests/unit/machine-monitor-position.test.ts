import { describe, expect, it } from "vitest";
import { fitMachineMonitorPosition } from "../../apps/web/src/components/MachineMonitor";

const viewport = { x: 0, y: 0, width: 1100, height: 760 };
const collapsed = { width: 200, height: 38 };
const expanded = { width: 440, height: 580 };

describe("resource monitor viewport positioning", () => {
  it("keeps an expanded panel inside every edge without changing its saved anchor", () => {
    for (const anchor of [{ x: 8, y: 8 }, { x: 892, y: 8 }, { x: 8, y: 714 }, { x: 892, y: 714 }]) {
      const saved = { ...anchor };
      const result = fitMachineMonitorPosition(anchor, expanded, viewport);
      expect(result.x).toBeGreaterThanOrEqual(8);
      expect(result.y).toBeGreaterThanOrEqual(8);
      expect(result.x + expanded.width).toBeLessThanOrEqual(1092);
      expect(result.y + expanded.height).toBeLessThanOrEqual(752);
      expect(anchor).toEqual(saved);
      expect(fitMachineMonitorPosition(anchor, collapsed, viewport)).toEqual(saved);
    }
  });

  it("restores the anchor after temporary viewport resizing", () => {
    const anchor = { x: 892, y: 714 };
    expect(fitMachineMonitorPosition(anchor, { width: 304, height: 552 }, { x: 0, y: 0, width: 320, height: 568 })).toEqual({ x: 8, y: 8 });
    expect(fitMachineMonitorPosition(anchor, collapsed, viewport)).toEqual(anchor);
  });

  it("uses the visible viewport offset while zoomed or panned", () => {
    expect(fitMachineMonitorPosition({ x: 1000, y: 1000 }, { width: 304, height: 300 }, { x: 40, y: 120, width: 320, height: 400 })).toEqual({ x: 48, y: 212 });
  });
});
