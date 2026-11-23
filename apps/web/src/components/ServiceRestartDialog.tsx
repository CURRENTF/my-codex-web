import { useEffect, useState } from "react";
import { ArrowClockwise, CheckCircle, SpinnerGap, WarningCircle } from "@phosphor-icons/react";
import * as Dialog from "@radix-ui/react-dialog";
import { useMutation, useQuery } from "@tanstack/react-query";
import { ApiError, endpoints, isPasswordRequiredError } from "../api";

export function ServiceRestartDialog({ open, onOpenChange }: { open: boolean; onOpenChange: (open: boolean) => void }) {
  const [watching, setWatching] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const statusQuery = useQuery({ queryKey: ["service-restart"], queryFn: endpoints.serviceRestartStatus, enabled: open, refetchInterval: open ? 3_000 : false });
  const restart = useMutation({
    mutationFn: endpoints.restartService,
    onSuccess: (status) => setWatching(status.instanceId),
    onError: (failure) => {
      if (!(failure instanceof ApiError) && statusQuery.data) {
        // The service may have stopped before the accepted response arrived.
        setWatching(statusQuery.data.instanceId);
      } else setError(failure.message);
    },
  });

  useEffect(() => {
    if (!watching) return;
    let cancelled = false;
    let timer: number;
    const deadline = Date.now() + 60_000;
    const poll = async () => {
      try {
        const status = await endpoints.serviceRestartStatus();
        if (cancelled) return;
        if (status.instanceId !== watching) { window.location.reload(); return; }
        if (status.state === "failed") {
          setError(status.message);
          setWatching(null);
          void statusQuery.refetch();
          return;
        }
      } catch (failure) {
        if (cancelled) return;
        if (isPasswordRequiredError(failure)) { window.location.reload(); return; }
      }
      if (!cancelled) timer = window.setTimeout(() => { void poll(); }, 1_000);
    };
    timer = window.setTimeout(() => { void poll(); }, 1_000);
    const timeout = window.setTimeout(() => {
      cancelled = true;
      window.clearTimeout(timer);
      setWatching(null);
      setError("等待服务恢复超时，请稍后刷新页面或检查服务状态。");
    }, deadline - Date.now());
    return () => { cancelled = true; window.clearTimeout(timer); window.clearTimeout(timeout); };
  }, [watching]);

  const status = statusQuery.data;
  const running = restart.isPending || watching !== null || status?.state === "restarting";
  const statusTone = running ? "restarting" : !status ? "loading" : !status.enabled ? "unavailable" : status.state === "failed" ? "failed" : "idle";
  const statusTitle = running ? "正在重启" : !status ? "读取中" : !status.enabled ? "未配置" : status.state === "failed" ? "重启失败" : "就绪";
  return <Dialog.Root open={open} onOpenChange={onOpenChange}>
    <Dialog.Portal>
      <Dialog.Overlay className="dialog-overlay" />
      <Dialog.Content className="dialog-content self-update-dialog">
        <div className="dialog-heading"><ArrowClockwise size={18} /><Dialog.Title>重启 my-codex-web</Dialog.Title></div>
        <Dialog.Description className="dialog-description">重启 Web 服务会暂时断开连接，恢复后页面会自动刷新。请先等待正在运行的任务完成。</Dialog.Description>
        <div className={`self-update-status ${statusTone}`} role="status">
          {running || !status ? <SpinnerGap size={17} className="spinning" /> : !status.enabled || status.state === "failed" ? <WarningCircle size={17} weight="fill" /> : <CheckCircle size={17} weight="fill" />}
          <span><strong>{statusTitle}</strong><small>{running ? "正在重启，等待服务恢复…" : status?.message ?? "正在读取服务状态…"}</small></span>
        </div>
        {error && <p className="dialog-error" role="alert">{error}</p>}
        {statusQuery.isError && !running && <p className="dialog-error" role="alert">无法读取服务状态，请稍后重试。</p>}
        <div className="dialog-actions">
          <Dialog.Close asChild><button className="button secondary">{running ? "后台等待" : "取消"}</button></Dialog.Close>
          <button className="button primary" disabled={!status?.enabled || running || statusQuery.isError} onClick={() => { setError(null); restart.mutate(); }}>
            {running ? <><SpinnerGap size={15} className="spinning" />正在重启</> : <><ArrowClockwise size={15} />确认重启</>}
          </button>
        </div>
      </Dialog.Content>
    </Dialog.Portal>
  </Dialog.Root>;
}
