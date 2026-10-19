import { cpus, hostname, freemem, totalmem } from "node:os";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import type { MachineMetrics } from "@codex-web/shared-types";

const exec = promisify(execFile);
const GPU_STALE_LIMIT_MS = 30_000;
type GpuSample = Pick<MachineMetrics, "gpus" | "gpuStatus" | "gpuSampledAt" | "gpuUnavailableReason">;
type CpuTimes = ReturnType<typeof cpus>;
export function cpuUtilization(before: CpuTimes, after: CpuTimes): number | null {
  if (!before.length || before.length !== after.length) return null;
  let idle = 0; let total = 0;
  for (let i = 0; i < after.length; i++) {
    for (const key of Object.keys(after[i]!.times) as Array<keyof CpuTimes[number]["times"]>) {
      const delta = after[i]!.times[key] - before[i]!.times[key];
      if (delta < 0) return null;
      total += delta;
      if (key === "idle") idle += delta;
    }
  }
  return total > 0 ? Math.max(0, Math.min(100, 100 * (1 - idle / total))) : null;
}
const metric = (text: string | undefined): number | null => {
  if (!text?.trim()) return null;
  const value = Number(text);
  return Number.isFinite(value) && value >= 0 ? value : null;
};
export function parseNvidiaMetrics(output: string): MachineMetrics["gpus"] {
  return output.trim().split(/\r?\n/).filter(Boolean).flatMap((line) => {
    const columns = line.split(",").map((part) => part.trim());
    if (columns.length !== 7 || !/^\d+$/.test(columns[0]!)) return [];
    const [id, name, utilization, used, total, power, limit] = columns;
    return [{ id: id!, name: name!, utilizationPercent: metric(utilization), memoryUsedMiB: metric(used), memoryTotalMiB: metric(total), powerWatts: metric(power), powerLimitWatts: metric(limit) }];
  });
}

// On-demand, shared across clients. No timers or privileged commands while unused.
export class MachineMetricsSampler {
  private cached: MachineMetrics | undefined;
  private cachedAt = 0;
  private pending: Promise<MachineMetrics> | undefined;
  private lastGpu: { gpus: MachineMetrics["gpus"]; sampledAt: string; at: number } | undefined;
  read(): Promise<MachineMetrics> {
    if (this.cached && performance.now() - this.cachedAt < 2000) return Promise.resolve(this.cached);
    if (this.pending) return this.pending;
    this.pending = this.sample().then((data) => {
      this.cached = data; this.cachedAt = performance.now(); return data;
    }).finally(() => { this.pending = undefined; });
    return this.pending;
  }
  private async sampleGpu(): Promise<GpuSample> {
    let reason: MachineMetrics["gpuUnavailableReason"] = "query-failed";
    for (let attempt = 0; attempt < 2; attempt++) {
      try {
        const { stdout } = await exec("nvidia-smi", ["--query-gpu=index,name,utilization.gpu,memory.used,memory.total,power.draw,power.limit", "--format=csv,noheader,nounits"], { timeout: 2500, maxBuffer: 128 * 1024, windowsHide: true });
        const gpus = parseNvidiaMetrics(stdout);
        if (gpus.length) {
          const sampledAt = new Date().toISOString();
          this.lastGpu = { gpus, sampledAt, at: performance.now() };
          return { gpus, gpuStatus: "available", gpuSampledAt: sampledAt };
        }
        reason = stdout.trim() ? "query-failed" : "no-devices";
      } catch (error) {
        reason = (error as NodeJS.ErrnoException).code === "ENOENT" ? "not-found" : "query-failed";
        if (reason === "not-found") break;
      }
      if (attempt === 0) await new Promise((resolve) => setTimeout(resolve, 150));
    }
    // Keep short-lived failures from removing every GPU row, without presenting old values as live.
    if (this.lastGpu && performance.now() - this.lastGpu.at < GPU_STALE_LIMIT_MS) {
      return { gpus: this.lastGpu.gpus, gpuStatus: "stale", gpuSampledAt: this.lastGpu.sampledAt, gpuUnavailableReason: reason };
    }
    return { gpus: [], gpuStatus: "unavailable", gpuUnavailableReason: reason };
  }
  private async sample(): Promise<MachineMetrics> {
    // A short measurement window stays meaningful even after monitoring was disabled.
    const previous = cpus();
    const [gpu, current] = await Promise.all([
      this.sampleGpu(),
      new Promise<CpuTimes>((resolve) => setTimeout(() => resolve(cpus()), 200)),
    ]);
    return { sampledAt: new Date().toISOString(), hostname: hostname(), cpu: { utilizationPercent: cpuUtilization(previous, current), logicalCores: current.length, powerWatts: null }, memory: { usedBytes: totalmem() - freemem(), totalBytes: totalmem() }, ...gpu };
  }
}
