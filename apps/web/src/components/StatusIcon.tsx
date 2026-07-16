import { CheckCircle, Circle, PauseCircle, SpinnerGap, WarningCircle, XCircle } from "@phosphor-icons/react";
import type { RuntimeState } from "@codex-web/shared-types";

export function StatusIcon({ state, size = 15 }: { state: RuntimeState; size?: number }) {
  if (state === "running") return <SpinnerGap className="status-icon spinning" size={size} weight="bold" aria-label="正在执行" />;
  if (state === "waitingForInput") return <PauseCircle className="status-icon waiting" size={size} weight="fill" aria-label="等待确认" />;
  if (state === "justFinished") return <CheckCircle className="status-icon success" size={size} weight="fill" aria-label="刚刚完成" />;
  if (state === "failed") return <XCircle className="status-icon danger" size={size} weight="fill" aria-label="执行失败" />;
  if (state === "interrupted") return <WarningCircle className="status-icon muted" size={size} weight="fill" aria-label="已中断" />;
  if (state === "disconnected") return <WarningCircle className="status-icon danger" size={size} weight="fill" aria-label="连接中断" />;
  return <Circle className="status-icon idle" size={size} aria-label="空闲" />;
}

export function statusText(state: RuntimeState): string {
  return ({ idle: "空闲", running: "正在执行", waitingForInput: "等待确认", justFinished: "刚刚完成", interrupted: "已中断", failed: "失败", disconnected: "连接中断" })[state];
}
