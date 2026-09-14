import { describe, expect, it, vi, afterEach } from "vitest";
import { cpuUtilization, parseNvidiaMetrics, MachineMetricsSampler } from "../../apps/server/src/machine-metrics";
import { cpus } from "node:os";

vi.mock("node:child_process", () => ({ execFile: vi.fn((_file, _args, _options, callback) => callback(null, { stdout: "0, NVIDIA H100, 73, 40960, 81920, 286.5, 700\n" })) }));
afterEach(() => vi.useRealTimers());
describe("machine metrics", () => {
  it("preserves missing metrics instead of reporting zero and supports multiple GPUs", () => {
    const result = parseNvidiaMetrics("0, NVIDIA H100, 73, 40960, 81920, 286.5, 700\n1, NVIDIA H100, [N/A], 0, 81920, [Not Supported], 700\n");
    expect(result).toHaveLength(2);
    expect(result[0]).toMatchObject({ utilizationPercent: 73, memoryUsedMiB: 40960, powerWatts: 286.5 });
    expect(result[1]).toMatchObject({ utilizationPercent: null, memoryUsedMiB: 0, powerWatts: null });
    expect(parseNvidiaMetrics("invalid output")).toEqual([]);
  });
  it("measures CPU deltas and rejects invalid samples", () => {
    const before = [{ model: "test", speed: 0, times: { user: 100, nice: 0, sys: 0, idle: 100, irq: 0 } }];
    const after = [{ ...before[0]!, times: { user: 125, nice: 0, sys: 0, idle: 175, irq: 0 } }];
    expect(cpuUtilization(before, after)).toBe(25);
    expect(cpuUtilization(before, before)).toBeNull();
    expect(cpuUtilization(after, before)).toBeNull();
    expect(cpuUtilization(before, [])).toBeNull();
  });
  it("coalesces concurrent requests and caches completed samples", async () => {
    vi.useFakeTimers();
    const sampler = new MachineMetricsSampler();
    const first = sampler.read();
    expect(sampler.read()).toBe(first);
    await vi.advanceTimersByTimeAsync(200);
    const data = await first;
    expect(data.cpu.logicalCores).toBe(cpus().length);
    expect(data.gpus).toHaveLength(1);
    expect(await sampler.read()).toBe(data);
  });
});
