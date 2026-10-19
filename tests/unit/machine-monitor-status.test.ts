import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import type { MachineMetrics } from "@codex-web/shared-types";
import { MachineGpuNotice } from "../../apps/web/src/components/MachineMonitor";

const metrics: MachineMetrics = {
  sampledAt: "2026-10-19T08:00:03.000Z", hostname: "test",
  cpu: { utilizationPercent: 11, logicalCores: 192, powerWatts: null },
  memory: { usedBytes: 100, totalBytes: 1000 },
  gpuStatus: "available", gpuSampledAt: "2026-10-19T08:00:00.000Z",
  gpus: [{ id: "0", name: "NVIDIA H100", utilizationPercent: 73, memoryUsedMiB: 40960, memoryTotalMiB: 81920, powerWatts: 286, powerLimitWatts: 700 }],
};
const notice = (changes: Partial<MachineMetrics>) => renderToStaticMarkup(createElement(MachineGpuNotice, { data: { ...metrics, ...changes } }));

describe("GPU collection notices", () => {
  it("labels retained values with their GPU sample time", () => {
    const html = notice({ gpuStatus: "stale" });
    expect(html).toContain("显示上次成功采样");
    expect(html).toContain(new Date(metrics.gpuSampledAt!).toLocaleTimeString([], { hour12: false }));
    expect(html).not.toContain("驱动");
  });
  it("only suggests checking the installation when the executable is missing", () => {
    expect(notice({ gpuStatus: "unavailable", gpus: [], gpuUnavailableReason: "not-found" })).toContain("未找到 nvidia-smi");
    const failed = notice({ gpuStatus: "unavailable", gpus: [], gpuUnavailableReason: "query-failed" });
    expect(failed).toContain("正在重试");
    expect(failed).not.toContain("驱动");
    expect(notice({ gpuStatus: "unavailable", gpus: [], gpuUnavailableReason: "no-devices" })).toContain("未检测到 NVIDIA GPU");
  });
  it("clears the notice after recovery", () => {
    expect(notice({})).toBe("");
  });
});
