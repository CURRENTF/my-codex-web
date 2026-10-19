import { describe, expect, it, vi, afterEach, beforeEach } from "vitest";
import { cpuUtilization, parseNvidiaMetrics, MachineMetricsSampler } from "../../apps/server/src/machine-metrics";
import { cpus } from "node:os";

const { runNvidia } = vi.hoisted(() => ({ runNvidia: vi.fn() }));
const gpuOutput = "0, NVIDIA H100, 73, 40960, 81920, 286.5, 700\n";
vi.mock("node:child_process", () => ({ execFile: runNvidia }));
beforeEach(() => { runNvidia.mockReset().mockImplementation((_file, _args, _options, callback) => callback(null, { stdout: gpuOutput })); });
afterEach(() => vi.useRealTimers());
async function readSample(sampler: MachineMetricsSampler) {
  const pending = sampler.read();
  await vi.advanceTimersByTimeAsync(200);
  return pending;
}
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
    expect(runNvidia).toHaveBeenCalledTimes(1);
  });
  it("retries a transient timeout and returns the recovered GPU data", async () => {
    vi.useFakeTimers();
    runNvidia.mockImplementationOnce((_file, _args, _options, callback) => callback(Object.assign(new Error("timeout"), { killed: true, code: "ETIMEDOUT" })));
    const data = await readSample(new MachineMetricsSampler());
    expect(data).toMatchObject({ gpuStatus: "available", gpus: [{ id: "0" }] });
    expect(data.gpuSampledAt).toBeDefined();
    expect(data.gpuUnavailableReason).toBeUndefined();
    expect(runNvidia).toHaveBeenCalledTimes(2);
  });
  it("keeps recent GPU rows on failure, expires them, and recovers on a later sample", async () => {
    vi.useFakeTimers();
    const sampler = new MachineMetricsSampler();
    const first = await readSample(sampler);
    runNvidia.mockImplementation((_file, _args, _options, callback) => callback(new Error("NVML query failed")));
    await vi.advanceTimersByTimeAsync(3000);
    const stale = await readSample(sampler);
    expect(stale).toMatchObject({ gpuStatus: "stale", gpus: first.gpus, gpuSampledAt: first.gpuSampledAt, gpuUnavailableReason: "query-failed" });
    expect(stale.sampledAt).not.toBe(first.sampledAt);

    await vi.advanceTimersByTimeAsync(30_000);
    expect(await readSample(sampler)).toMatchObject({ gpuStatus: "unavailable", gpus: [], gpuUnavailableReason: "query-failed" });
    runNvidia.mockImplementation((_file, _args, _options, callback) => callback(null, { stdout: gpuOutput.replace(", 73,", ", 25,") }));
    await vi.advanceTimersByTimeAsync(3000);
    const recovered = await readSample(sampler);
    expect(recovered).toMatchObject({ gpuStatus: "available", gpus: [{ utilizationPercent: 25 }] });
    expect(recovered.gpuSampledAt).not.toBe(first.gpuSampledAt);
    expect(recovered.gpuUnavailableReason).toBeUndefined();
  });
  it("does not retry a missing executable or confuse it with a query failure", async () => {
    vi.useFakeTimers();
    runNvidia.mockImplementation((_file, _args, _options, callback) => callback(Object.assign(new Error("missing"), { code: "ENOENT" })));
    expect(await readSample(new MachineMetricsSampler())).toMatchObject({ gpuStatus: "unavailable", gpus: [], gpuUnavailableReason: "not-found" });
    expect(runNvidia).toHaveBeenCalledTimes(1);
  });
  it.each(["", "invalid output"])("does not report successful collection for empty or invalid output: %j", async (stdout) => {
    vi.useFakeTimers();
    runNvidia.mockImplementation((_file, _args, _options, callback) => callback(null, { stdout }));
    expect(await readSample(new MachineMetricsSampler())).toMatchObject({ gpuStatus: "unavailable", gpus: [], gpuUnavailableReason: stdout ? "query-failed" : "no-devices" });
    expect(runNvidia).toHaveBeenCalledTimes(2);
  });
  it("shares the same in-flight retry across clients", async () => {
    vi.useFakeTimers();
    runNvidia.mockImplementationOnce((_file, _args, _options, callback) => callback(new Error("busy")));
    const sampler = new MachineMetricsSampler();
    const pending = sampler.read();
    await vi.advanceTimersByTimeAsync(100);
    expect(sampler.read()).toBe(pending);
    expect(runNvidia).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(100);
    expect((await pending).gpuStatus).toBe("available");
    expect(runNvidia).toHaveBeenCalledTimes(2);
  });
});
