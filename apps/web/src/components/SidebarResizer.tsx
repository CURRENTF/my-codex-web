import { useLayoutEffect, useRef, useState } from "react";

const STORAGE_KEY = "codex-web:sidebar-width:v1";
const MIN_WIDTH = 220;
const MAX_WIDTH = 520;
const MIN_WORKSPACE_WIDTH = 360;

function readWidth(): number | null {
  try {
    const value = Number(localStorage.getItem(STORAGE_KEY));
    return Number.isFinite(value) && value >= MIN_WIDTH && value <= MAX_WIDTH ? value : null;
  } catch { return null; }
}

export function SidebarResizer() {
  const handle = useRef<HTMLDivElement>(null);
  const drag = useRef<{ pointerId: number; startX: number; startWidth: number; previousWidth: number | null } | null>(null);
  const [width, setWidth] = useState(readWidth);
  const [bounds, setBounds] = useState({ width: 244, max: MAX_WIDTH });

  const shell = () => handle.current?.parentElement;
  const sidebar = () => handle.current?.previousElementSibling;
  const maxWidth = () => {
    const element = shell();
    if (!element) return MAX_WIDTH;
    const style = getComputedStyle(element);
    return Math.max(MIN_WIDTH, Math.min(MAX_WIDTH, element.clientWidth - parseFloat(style.paddingLeft) - parseFloat(style.paddingRight) - (parseFloat(style.columnGap) || 0) - MIN_WORKSPACE_WIDTH));
  };
  const clamp = (value: number) => Math.max(MIN_WIDTH, Math.min(maxWidth(), value));
  const save = (value: number | null) => {
    setWidth(value);
    try {
      if (value === null) localStorage.removeItem(STORAGE_KEY);
      else localStorage.setItem(STORAGE_KEY, String(value));
    } catch { /* Resizing remains available when browser storage is disabled. */ }
  };
  useLayoutEffect(() => {
    if (width === null) shell()?.style.removeProperty("--sidebar-width");
    else shell()?.style.setProperty("--sidebar-width", `${width}px`);
  }, [width]);
  useLayoutEffect(() => {
    const element = shell();
    const panel = sidebar();
    if (!element || !panel) return;
    const update = () => setBounds({ width: Math.round(panel.getBoundingClientRect().width), max: maxWidth() });
    const observer = new ResizeObserver(update);
    observer.observe(element);
    observer.observe(panel);
    update();
    return () => { observer.disconnect(); element.classList.remove("sidebar-resizing"); };
  }, []);
  const finish = (cancelled: boolean) => {
    const current = drag.current;
    if (!current) return;
    drag.current = null;
    shell()?.classList.remove("sidebar-resizing");
    save(cancelled ? current.previousWidth : clamp(sidebar()?.getBoundingClientRect().width ?? current.startWidth));
    if (handle.current?.hasPointerCapture(current.pointerId)) handle.current.releasePointerCapture(current.pointerId);
  };

  return <div ref={handle} className="sidebar-resizer" role="separator" aria-label="调整 Session 侧栏宽度" aria-orientation="vertical" aria-valuemin={MIN_WIDTH} aria-valuemax={bounds.max} aria-valuenow={bounds.width} tabIndex={0}
    onPointerDown={(event) => {
      if (event.button !== 0 || !event.isPrimary || drag.current) return;
      event.preventDefault();
      event.currentTarget.focus();
      drag.current = { pointerId: event.pointerId, startX: event.clientX, startWidth: sidebar()?.getBoundingClientRect().width ?? bounds.width, previousWidth: width };
      event.currentTarget.setPointerCapture(event.pointerId);
      shell()?.classList.add("sidebar-resizing");
    }}
    onPointerMove={(event) => {
      const current = drag.current;
      if (current?.pointerId === event.pointerId) setWidth(clamp(current.startWidth + event.clientX - current.startX));
    }}
    onPointerUp={(event) => { if (drag.current?.pointerId === event.pointerId) finish(false); }}
    onPointerCancel={(event) => { if (drag.current?.pointerId === event.pointerId) finish(true); }}
    onLostPointerCapture={() => finish(true)}
    onDoubleClick={() => save(null)}
    onKeyDown={(event) => {
      if (event.key === "Escape" && drag.current) { event.preventDefault(); finish(true); return; }
      if (drag.current) return;
      const current = sidebar()?.getBoundingClientRect().width ?? bounds.width;
      const step = event.shiftKey ? 40 : 10;
      const next = event.key === "ArrowLeft" ? current - step : event.key === "ArrowRight" ? current + step : event.key === "Home" ? MIN_WIDTH : event.key === "End" ? maxWidth() : null;
      if (next === null) return;
      event.preventDefault();
      save(clamp(next));
    }}
  />;
}
