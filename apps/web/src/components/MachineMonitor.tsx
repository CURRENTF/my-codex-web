import { useLayoutEffect, useRef, useState, type KeyboardEvent, type PointerEvent } from "react";
import { useQuery } from "@tanstack/react-query";
import { CaretDown, Cpu, DotsSixVertical, X } from "@phosphor-icons/react";
import type { MachineMetrics } from "@codex-web/shared-types";
import { api } from "../api";
import { useMachineMonitorPreferences } from "../machine-monitor-preferences";

const percent = (value: number | null | undefined) => value == null ? "—" : `${Math.round(value)}%`;
const gib = (value: number) => (value / 1024).toFixed(1);
const ratio = (used: number | null, total: number | null) => used == null || total == null || total <= 0 ? null : used / total * 100;
const tone = (value: number | null | undefined) => value == null ? "unknown" : value >= 90 ? "high" : value >= 60 ? "medium" : "low";

export function fitMachineMonitorPosition(
  position: { x: number; y: number },
  size: { width: number; height: number },
  viewport: { x: number; y: number; width: number; height: number },
) {
  return {
    x: Math.max(viewport.x + 8, Math.min(position.x, viewport.x + viewport.width - size.width - 8)),
    y: Math.max(viewport.y + 8, Math.min(position.y, viewport.y + viewport.height - size.height - 8)),
  };
}

function Meter({ value, children }: { value: number | null; children: React.ReactNode }) {
  return <div className={`machine-monitor-meter ${tone(value)}`}><span>{children}</span><span className="machine-monitor-track" aria-hidden="true"><i style={{ width: `${Math.min(100, Math.max(0, value ?? 0))}%` }} /></span></div>;
}

export function MachineMonitorSetting() {
  const { enabled, setEnabled } = useMachineMonitorPreferences();
  return <button className="app-settings-row" role="switch" aria-checked={enabled} aria-label="显示机器资源" onClick={() => setEnabled(!enabled)}>
    <Cpu size={18} /><span><strong>显示机器资源</strong><small>服务端 CPU / GPU，支持拖动和展开。仅保存到此浏览器。</small></span>
    <span className={`settings-toggle ${enabled ? "enabled" : ""}`} aria-hidden="true"><span /></span>
  </button>;
}

export function MachineMonitor() {
  const enabled = useMachineMonitorPreferences((state) => state.enabled);
  return enabled ? <MachineMonitorContent /> : null;
}

function MachineMonitorContent() {
  const [open, setOpen] = useState(false);
  const { position, setPosition } = useMachineMonitorPreferences();
  const container = useRef<HTMLDivElement>(null);
  const anchor = useRef(position);
  const drag = useRef<{ pointerId: number; x: number; y: number; left: number; top: number } | null>(null);
  const query = useQuery({ queryKey: ["machine-metrics"], queryFn: ({ signal }) => api<MachineMetrics>("/api/machine-metrics", { signal, cache: "no-store" }), refetchInterval: 3000, refetchIntervalInBackground: false, staleTime: 2000, retry: false });
  const data = query.data;
  const utilization = data?.gpus.flatMap((gpu) => gpu.utilizationPercent == null ? [] : [gpu.utilizationPercent]) ?? [];
  const maxGpu = utilization.length ? Math.max(...utilization) : null;

  const moveTo = (x: number, y: number) => {
    const element = container.current;
    if (!element) return;
    const visualViewport = window.visualViewport;
    const viewport = { x: visualViewport?.offsetLeft ?? 0, y: visualViewport?.offsetTop ?? 0, width: visualViewport?.width ?? window.innerWidth, height: visualViewport?.height ?? window.innerHeight };
    // Size first: clamping against the visible viewport also handles zoom and the mobile keyboard.
    element.style.maxWidth = `${Math.max(0, viewport.width - 16)}px`;
    element.style.maxHeight = `${Math.max(0, viewport.height - 16)}px`;
    const bounds = element.getBoundingClientRect();
    const { x: left, y: top } = fitMachineMonitorPosition({ x, y }, bounds, viewport);
    element.style.left = `${left}px`;
    element.style.top = `${top}px`;
    element.style.right = "auto";
    return { x: left, y: top };
  };

  const finishDrag = (event?: { pointerId: number }) => {
    if (!drag.current || (event && drag.current.pointerId !== event.pointerId)) return;
    drag.current = null;
    const bounds = container.current!.getBoundingClientRect();
    setPosition({ x: bounds.left, y: bounds.top });
  };

  useLayoutEffect(() => {
    const element = container.current;
    if (!element) return;
    // Expansion may move the panel inward, but must not overwrite the user's anchor.
    if (position && Number.isFinite(position.x) && Number.isFinite(position.y)) anchor.current = position;
    if (!anchor.current || !Number.isFinite(anchor.current.x) || !Number.isFinite(anchor.current.y)) {
      const bounds = element.getBoundingClientRect();
      anchor.current = { x: bounds.left, y: bounds.top };
    }
    const fit = () => {
      if (!drag.current && anchor.current) moveTo(anchor.current.x, anchor.current.y);
    };
    // Run before paint on both expand and collapse, not only after ResizeObserver fires.
    fit();
    const observer = new ResizeObserver(fit);
    observer.observe(element);
    const finishOnBlur = () => finishDrag();
    // Capture release outside the handle as well; do not leave a stale drag blocking layout.
    window.addEventListener("pointerup", finishDrag, true);
    window.addEventListener("pointercancel", finishDrag, true);
    window.addEventListener("blur", finishOnBlur);
    window.addEventListener("resize", fit);
    window.visualViewport?.addEventListener("resize", fit);
    window.visualViewport?.addEventListener("scroll", fit);
    return () => {
      observer.disconnect();
      window.removeEventListener("pointerup", finishDrag, true);
      window.removeEventListener("pointercancel", finishDrag, true);
      window.removeEventListener("blur", finishOnBlur);
      window.removeEventListener("resize", fit);
      window.visualViewport?.removeEventListener("resize", fit);
      window.visualViewport?.removeEventListener("scroll", fit);
    };
  }, [position, open]);

  const startDrag = (event: PointerEvent<HTMLButtonElement>) => {
    if (!event.isPrimary || event.button !== 0) return;
    event.preventDefault();
    event.currentTarget.focus({ preventScroll: true });
    const bounds = container.current!.getBoundingClientRect();
    drag.current = { pointerId: event.pointerId, x: event.clientX, y: event.clientY, left: bounds.left, top: bounds.top };
    event.currentTarget.setPointerCapture(event.pointerId);
  };
  const moveWithKeyboard = (event: KeyboardEvent<HTMLButtonElement>) => {
    const delta = { ArrowLeft: [-1, 0], ArrowRight: [1, 0], ArrowUp: [0, -1], ArrowDown: [0, 1] }[event.key];
    if (!delta) return;
    event.preventDefault();
    const bounds = container.current!.getBoundingClientRect();
    const step = event.shiftKey ? 40 : 10;
    const next = moveTo(bounds.left + delta[0]! * step, bounds.top + delta[1]! * step);
    if (next) setPosition(next);
  };

  return <div ref={container} className={`machine-monitor ${open ? "expanded" : ""}`} role="region" aria-label="机器资源" onKeyDown={(event) => { if (event.key === "Escape") { setOpen(false); container.current?.querySelector<HTMLButtonElement>(".machine-monitor-toggle")?.focus(); } }}>
    <div className="machine-monitor-toolbar">
      <button type="button" className="machine-monitor-drag" aria-label="拖动机器资源，或使用方向键移动" data-tooltip="拖动移动 · 方向键微调" onPointerDown={startDrag} onPointerMove={(event) => {
        const current = drag.current;
        if (current?.pointerId === event.pointerId) moveTo(current.left + event.clientX - current.x, current.top + event.clientY - current.y);
      }} onPointerUp={finishDrag} onPointerCancel={finishDrag} onLostPointerCapture={finishDrag} onKeyDown={moveWithKeyboard}><DotsSixVertical size={16} weight="bold" /></button>
      <button type="button" className="machine-monitor-toggle" aria-label={open ? "收起机器资源" : "机器资源，点击展开"} aria-expanded={open} aria-controls="machine-monitor-details" onClick={() => setOpen(!open)}>
        <Cpu size={14} />{open ? <span className="machine-monitor-title">机器资源<small data-tooltip={data?.hostname}>{data?.hostname ?? "服务端"}</small></span> : <span className="machine-monitor-summary">{query.isError ? "资源离线" : !data ? "采集中…" : <><span>CPU <b className={tone(data.cpu.utilizationPercent)}>{percent(data.cpu.utilizationPercent)}</b></span>{maxGpu != null && <span data-tooltip="最高 GPU 利用率">GPU <b className={tone(maxGpu)}>{percent(maxGpu)}</b></span>}</>}</span>}
        {open ? <X size={14} /> : <CaretDown size={12} />}
      </button>
    </div>
    {open && <div className="machine-monitor-panel" id="machine-monitor-details">
      {query.isError && <p className="machine-monitor-notice" role="status">连接中断，正在重试{data ? " · 以下为上次采样" : ""}</p>}
      {!data && !query.isError && <p className="machine-monitor-notice" role="status">正在采集资源情况…</p>}
      {data && <>
        <table className="machine-monitor-table" aria-label="CPU 和 GPU 资源使用情况">
          <thead><tr><th scope="col">设备</th><th scope="col">利用率</th><th scope="col">内存 / 显存<small>已用 / 总量 · GiB</small></th><th scope="col">功率<small>W</small></th></tr></thead>
          <tbody>
            <tr><th scope="row">CPU<small>{data.cpu.logicalCores} 逻辑核</small></th><td><Meter value={data.cpu.utilizationPercent}>{percent(data.cpu.utilizationPercent)}</Meter></td><td><Meter value={ratio(data.memory.usedBytes, data.memory.totalBytes)}>{gib(data.memory.usedBytes / 1024 / 1024)}<em> / {gib(data.memory.totalBytes / 1024 / 1024)}</em></Meter></td><td>{data.cpu.powerWatts == null ? <span className="machine-monitor-unavailable" data-tooltip="功率数据不可用">—</span> : Math.round(data.cpu.powerWatts)}</td></tr>
            {data.gpus.map((gpu) => <tr key={gpu.id}><th scope="row">GPU {gpu.id}<small data-tooltip={gpu.name}>{gpu.name}</small></th><td><Meter value={gpu.utilizationPercent}>{percent(gpu.utilizationPercent)}</Meter></td><td><Meter value={ratio(gpu.memoryUsedMiB, gpu.memoryTotalMiB)}>{gpu.memoryUsedMiB == null || gpu.memoryTotalMiB == null ? "—" : <>{gib(gpu.memoryUsedMiB)}<em> / {gib(gpu.memoryTotalMiB)}</em></>}</Meter></td><td>{gpu.powerWatts == null ? <span className="machine-monitor-unavailable" data-tooltip="功率数据不可用">—</span> : <>{Math.round(gpu.powerWatts)}{gpu.powerLimitWatts != null && <small>/ {Math.round(gpu.powerLimitWatts)}</small>}</>}</td></tr>)}
          </tbody>
        </table>
        {data.gpus.length === 0 && <p className="machine-monitor-notice">GPU 数据不可用 · 需要 NVIDIA 驱动及 nvidia-smi</p>}
        <footer><span className="machine-monitor-legend"><i className="low" />低 <i className="medium" />中 <i className="high" />高占用</span><span>{query.isError ? "上次 " : ""}{new Date(data.sampledAt).toLocaleTimeString([], { hour12: false })} · 3s</span></footer>
      </>}
    </div>}
  </div>;
}
