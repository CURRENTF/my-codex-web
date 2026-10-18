import { useId, useRef, useState, type ReactNode } from "react";
import { downloadFile } from "../file-download";

export function DownloadLink({ href, className, title, "aria-label": ariaLabel, onError, children }: {
  href: string;
  className?: string;
  title?: string;
  "aria-label"?: string;
  onError?(message: string): void;
  children: ReactNode;
}) {
  const inFlight = useRef(false);
  const [checking, setChecking] = useState(false);
  const [error, setError] = useState("");
  const errorId = useId();
  return <><a href={href} download className={className} data-tooltip={checking ? "正在检查下载…" : title} aria-label={ariaLabel} aria-busy={checking || undefined} aria-disabled={checking || undefined} aria-describedby={error ? errorId : undefined} onClick={(event) => {
    event.preventDefault();
    if (inFlight.current) return;
    inFlight.current = true; setChecking(true); setError(""); onError?.("");
    void downloadFile(href).catch((reason) => {
      const message = reason instanceof Error ? reason.message : "下载失败，请重试。";
      if (onError) onError(message); else setError(message);
    }).finally(() => { inFlight.current = false; setChecking(false); });
  }}>{children}</a>{error && <span className="file-download-error" id={errorId} role="alert">{error}</span>}</>;
}
