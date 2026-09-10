import { useState } from "react";
import { WarningCircle, X } from "@phosphor-icons/react";

export function ErrorTime({ timestamp }: { timestamp?: number | null }) {
  if (timestamp == null) return <small>发生时间未知</small>;
  const date = new Date(timestamp);
  return <time dateTime={date.toISOString()} title={date.toLocaleString("zh-CN", { hour12: false })}>{date.toLocaleString("zh-CN", { hour12: false })}</time>;
}

/** Key by error occurrence so dismissing one failure never hides the next. */
export function ErrorNotice({ message, timestamp, onDismiss }: { message: string; timestamp?: number | null; onDismiss?(): void }) {
  const [dismissed, setDismissed] = useState(false);
  // Local request failures are first rendered when the request rejects. Historical
  // errors explicitly pass null when their occurrence time is unavailable.
  const [observedAt] = useState(Date.now);
  if (dismissed) return null;
  return <div className="session-action-error session-error-notice" role="alert">
    <WarningCircle size={16} weight="fill" />
    <span><ErrorTime timestamp={timestamp === undefined ? observedAt : timestamp} /><span className="session-error-message">{message}</span></span>
    <button type="button" onClick={() => { setDismissed(true); onDismiss?.(); }} aria-label="关闭错误提示"><X size={14} /></button>
  </div>;
}
