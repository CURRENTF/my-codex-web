import { useEffect, useState } from "react";
import { ArrowClockwise, CheckCircle, GitBranch, SpinnerGap, WarningCircle } from "@phosphor-icons/react";
import * as Dialog from "@radix-ui/react-dialog";
import { useMutation, useQuery } from "@tanstack/react-query";
import type { SelfUpdateStatus } from "@codex-web/shared-types";
import { endpoints, isPasswordRequiredError } from "../api";

const ACTIVE_UPDATE_RUN_KEY = "codex-web-active-update-run";
let updateReloadMonitor: number | null = null;

function stopUpdateReloadMonitor(removeMarker: boolean): void {
  if (updateReloadMonitor !== null) window.clearInterval(updateReloadMonitor);
  updateReloadMonitor = null;
  if (removeMarker) window.sessionStorage.removeItem(ACTIVE_UPDATE_RUN_KEY);
}

function beginUpdateReloadMonitor(runId: string): void {
  window.sessionStorage.setItem(ACTIVE_UPDATE_RUN_KEY, runId);
  stopUpdateReloadMonitor(false);
  const startedAt = Date.now();
  updateReloadMonitor = window.setInterval(() => {
    void fetch("/api/system/update", { cache: "no-store", credentials: "same-origin" }).then(async (response) => {
      if (response.status === 401) {
        stopUpdateReloadMonitor(true);
        window.location.reload();
        return;
      }
      if (!response.ok) return;
      const status = await response.json() as SelfUpdateStatus;
      if (status.runId !== runId) return;
      if (status.state === "succeeded") {
        stopUpdateReloadMonitor(true);
        window.location.reload();
      } else if (status.state === "failed" || status.state === "upToDate") {
        stopUpdateReloadMonitor(true);
      }
    }).catch(() => undefined);
    if (Date.now() - startedAt > 30 * 60_000) stopUpdateReloadMonitor(true);
  }, 1_500);
}

function shortCommit(commit: string | null): string {
  return commit?.slice(0, 8) ?? "未知";
}

function stepLabel(status: SelfUpdateStatus): string {
  if (!status.enabled || status.state === "unavailable") return "未配置";
  if (status.state === "upToDate") return "已是最新";
  if (status.state === "succeeded") return "更新完成";
  if (status.state === "failed") return "更新失败";
  if (status.state === "restarting") return "正在重启";
  if (status.state !== "running") return shortCommit(status.currentCommit);
  if (status.step === "checking") return "正在检查";
  if (status.step === "installing") return "安装依赖";
  if (status.step === "validating") return "验证候选版本";
  if (status.step === "deploying") return "正在部署";
  return "正在更新";
}

function StatusIcon({ status }: { status: SelfUpdateStatus }) {
  if (status.state === "running" || status.state === "restarting") return <SpinnerGap size={17} className="spinning" />;
  if (status.state === "succeeded" || status.state === "upToDate") return <CheckCircle size={17} weight="fill" />;
  if (status.state === "failed" || status.state === "unavailable") return <WarningCircle size={17} weight="fill" />;
  return <ArrowClockwise size={17} />;
}

export function SelfUpdateControl() {
  const [open, setOpen] = useState(false);
  const statusQuery = useQuery({
    queryKey: ["self-update"],
    queryFn: endpoints.selfUpdateStatus,
    refetchInterval: (query) => {
      const state = (query.state.data as SelfUpdateStatus | undefined)?.state;
      return open || state === "running" || state === "restarting" ? 1_500 : 30_000;
    },
    retry: true,
  });
  const update = useMutation({
    mutationFn: endpoints.startSelfUpdate,
    onSuccess: (status) => {
      if (status.runId) beginUpdateReloadMonitor(status.runId);
      void statusQuery.refetch();
    },
  });
  const status = statusQuery.data;
  useEffect(() => {
    const activeRun = window.sessionStorage.getItem(ACTIVE_UPDATE_RUN_KEY);
    if (activeRun) beginUpdateReloadMonitor(activeRun);
  }, []);
  useEffect(() => {
    if (!status?.runId) return;
    const activeRun = window.sessionStorage.getItem(ACTIVE_UPDATE_RUN_KEY);
    if (activeRun !== status.runId) return;
    if (status.state === "succeeded") {
      stopUpdateReloadMonitor(true);
      window.location.reload();
    } else if (status.state === "failed" || status.state === "upToDate") {
      stopUpdateReloadMonitor(true);
    }
  }, [status?.runId, status?.state]);
  useEffect(() => {
    if (!isPasswordRequiredError(statusQuery.error) || !window.sessionStorage.getItem(ACTIVE_UPDATE_RUN_KEY)) return;
    stopUpdateReloadMonitor(true);
    window.location.reload();
  }, [statusQuery.error]);

  const running = status?.state === "running" || status?.state === "restarting" || update.isPending;
  const controlLabel = status ? stepLabel(status) : "检查更新";
  return <>
    <button className={`icon-button self-update-trigger ${status?.state ?? "loading"}`} onClick={() => setOpen(true)} aria-label={`更新 Codex Web：${controlLabel}`} title={`更新 Codex Web：${controlLabel}`}>
      {status ? <StatusIcon status={status} /> : <SpinnerGap size={17} className="spinning" />}
    </button>
    <Dialog.Root open={open} onOpenChange={setOpen}>
      <Dialog.Portal>
        <Dialog.Overlay className="dialog-overlay" />
        <Dialog.Content className="dialog-content self-update-dialog" aria-describedby="self-update-description">
          <div className="dialog-heading"><ArrowClockwise size={18} weight="bold" /><Dialog.Title>更新 Codex Web</Dialog.Title></div>
          <Dialog.Description className="dialog-description" id="self-update-description">从配置的 GitHub 分支获取最新代码。候选版本会先完成依赖安装、检查、测试和构建，通过后才快进部署并重启服务。</Dialog.Description>
          {status && <div className="self-update-source">
            <span><GitBranch size={14} />来源</span><code>{status.remote}/{status.branch}</code>
            <span>当前版本</span><code>{shortCommit(status.currentCommit)}</code>
            {status.targetCommit && <><span>目标版本</span><code>{shortCommit(status.targetCommit)}</code></>}
          </div>}
          <div className={`self-update-status ${status?.state ?? "loading"}`} role="status">
            {status ? <StatusIcon status={status} /> : <SpinnerGap size={17} className="spinning" />}
            <span><strong>{status ? stepLabel(status) : "正在读取更新状态"}</strong><small>{status?.message ?? "请稍候…"}</small></span>
          </div>
          {status && !status.enabled && <p className="self-update-config-note">在服务环境中配置 <code>CODEX_WEB_UPDATE_RESTART_COMMAND_JSON</code> 后启用。运行目录还必须是干净的 Git checkout。</p>}
          <p className="self-update-safety-note">更新期间不能有运行中的 Turn。运行目录若有未提交改动、分支不匹配或远端不是快进后继，部署会自动停止。</p>
          {update.isError && <p className="dialog-error" role="alert">{update.error.message}</p>}
          {statusQuery.isError && <p className="dialog-error" role="alert">暂时无法连接更新服务，正在重试。</p>}
          <div className="dialog-actions">
            <Dialog.Close asChild><button className="button secondary">{running ? "后台运行" : "关闭"}</button></Dialog.Close>
            <button className="button primary" disabled={!status?.enabled || status.state === "unavailable" || running} onClick={() => update.mutate()}>{running ? <><SpinnerGap size={15} className="spinning" />正在更新</> : <><ArrowClockwise size={15} />检查并更新</>}</button>
          </div>
        </Dialog.Content>
      </Dialog.Portal>
    </Dialog.Root>
  </>;
}
