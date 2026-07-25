import { describe, expect, it } from "vitest";
import { relativeTime } from "../../apps/web/src/components/Sidebar";

describe("Sidebar relative time", () => {
  it("advances labels when the Sidebar clock ticks", () => {
    const updatedAt = 1_000_000;
    expect(relativeTime(updatedAt, updatedAt + 30_000)).toBe("刚刚");
    expect(relativeTime(updatedAt, updatedAt + 2 * 60_000)).toBe("2 分钟前");
    expect(relativeTime(updatedAt, updatedAt + 24 * 60 * 60_000)).toBe("昨天");
  });
});
