import { useState } from "react";
import { useQuery } from "@tanstack/react-query";
import * as Popover from "@radix-ui/react-popover";
import { Cpu, X } from "@phosphor-icons/react";
import type { MachineMetrics } from "@codex-web/shared-types";
import { api } from "../api";
import { useMachineMonitorPreferences } from "../machine-monitor-preferences";

const percent = (value: number | null | undefined) => value == null ? "-" : `${Math.round(value)}%`;
const watts = (value: number | null) => value == null ? "不可用" : `${Math.round(value)} W`;
const gib = (value: number) => (value / 1024).toFixed(1);

export function MachineMonitorSetting() {
  const { enabled, setEnabled } = useMachineMonitorPreferences();
  return <button className="app-settings-row" role="switch" aria-checked={enabled} aria-label="显示机器资源" onClick={() => setEnabled(!enabled)}>
    <Cpu size={18} /><span><strong>显示机器资源</strong><small>服务端 CPU / GPU，悬浮栏点击展开。仅保存到此浏览器。</small></span>
    <span className={`settings-toggle ${enabled ? "enabled" : ""}`} aria-hidden="true"><span /></span>
  </button>;
}

export function MachineMonitor() {
  const enabled = useMachineMonitorPreferences((state) => state.enabled);
  return enabled ? <MachineMonitorContent /> : null;
}

function MachineMonitorContent() {
  const [open, setOpen] = useState(false);
  const query = useQuery({ queryKey: ["machine-metrics"], queryFn: ({ signal }) => api<MachineMetrics>("/api/machine-metrics", { signal, cache: "no-store" }), refetchInterval: 3000, refetchIntervalInBackground: false, staleTime: 2000, retry: false });
  const data = query.data;
  const utilization = data?.gpus.flatMap((gpu) => gpu.utilizationPercent == null ? [] : [gpu.utilizationPercent]) ?? [];
  return <Popover.Root open={open} onOpenChange={setOpen}>
    <Popover.Trigger asChild><button className="machine-monitor-trigger" aria-label="机器资源，点击展开" title="服务端机器资源">
      <Cpu size={14} /><span>{query.isError ? "资源离线" : !data ? "采集中" : <>CPU {percent(data.cpu.utilizationPercent)}{utilization.length > 0 && <span className="machine-monitor-gpu">GPU {percent(Math.max(...utilization))}</span>}</>}</span>
    </button></Popover.Trigger>
    <Popover.Portal><Popover.Content className="machine-monitor-panel popover-content" side="bottom" align="end" sideOffset={6} collisionPadding={8} aria-label="机器资源详情">
      <header><div><strong>机器资源</strong><small>{data?.hostname ?? "运行 Web 服务的机器"}</small></div><Popover.Close asChild><button className="icon-button" aria-label="收起机器资源"><X size={16} /></button></Popover.Close></header>
      {query.isError && <p role="status">暂时无法连接，正在重试。{data ? "以下为上次采样。" : ""}</p>}
      {!data && !query.isError && <p role="status">正在采集资源情况…</p>}
      {data && <>
        <section aria-label="CPU 资源"><div className="machine-monitor-device"><strong>CPU</strong><span>{data.cpu.logicalCores} 逻辑核</span></div>
          <dl><div><dt>利用率</dt><dd>{percent(data.cpu.utilizationPercent)}</dd></div><div><dt>内存</dt><dd>{gib(data.memory.usedBytes / 1024 / 1024)} / {gib(data.memory.totalBytes / 1024 / 1024)} GiB</dd></div><div><dt>功率</dt><dd>{watts(data.cpu.powerWatts)}</dd></div></dl>
        </section>
        {data.gpus.map((gpu) => <section key={gpu.id} aria-label={`GPU ${gpu.id}`}>
          <div className="machine-monitor-device"><strong>GPU {gpu.id}</strong><span title={gpu.name}>{gpu.name}</span></div>
          <dl><div><dt>利用率</dt><dd>{percent(gpu.utilizationPercent)}</dd></div><div><dt>显存</dt><dd>{gpu.memoryUsedMiB == null || gpu.memoryTotalMiB == null ? "不可用" : `${gib(gpu.memoryUsedMiB)} / ${gib(gpu.memoryTotalMiB)} GiB`}</dd></div><div><dt>功率</dt><dd>{watts(gpu.powerWatts)}{gpu.powerWatts != null && gpu.powerLimitWatts != null ? ` / ${Math.round(gpu.powerLimitWatts)} W` : ""}</dd></div></dl>
        </section>)}
        {data.gpus.length === 0 && <p>GPU 信息不可用，需要 NVIDIA 驱动及 nvidia-smi。</p>}
        <footer>每 3 秒刷新{data.gpus.length > 1 ? "，折叠时显示最高 GPU 利用率" : ""}<br />采样于 {new Date(data.sampledAt).toLocaleTimeString()}</footer>
      </>}
    </Popover.Content></Popover.Portal>
  </Popover.Root>;
}
