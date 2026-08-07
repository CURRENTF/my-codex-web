import { useEffect, useMemo, useState } from "react";
import { DotsThree, GitFork, ShieldWarning, SidebarSimple, Target, TerminalWindow, WarningCircle, X } from "@phosphor-icons/react";
import * as Dialog from "@radix-ui/react-dialog";
import * as DropdownMenu from "@radix-ui/react-dropdown-menu";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import type { AccessMode, CodeServerStatus, ModelOption, Project, RuntimeState } from "@codex-web/shared-types";
import { api, endpoints, newClientRequestId } from "../api";
import { codeServerFolderUrl } from "../code-server-url";
import { questionForTurn } from "../fork-boundary";
import { shouldShowFullAccessNotice } from "../full-access-notice";
import { refreshProjectAvailabilityAfterError } from "../project-refresh";
import { canBranchSession } from "../session-selection";
import { useAppStore } from "../store";
import { canReconcileOptimisticUserMessages, confirmedClientUserMessageIds } from "../timeline-presentation";
import { Composer } from "./Composer";
import { ContextUsageIndicator } from "./ContextUsageIndicator";
import { GoalBar } from "./GoalBar";
import { PendingBanner } from "./PendingBanner";
import { StatusIcon, statusText } from "./StatusIcon";
import { SubagentStatus } from "./SubagentStatus";
import { Timeline } from "./Timeline";

export function SessionPane({ threadId, project, projects, models, codeServer, sideChat = false, parallelWriteWarning = false, linkedSideChatActive = false, fullAccessNoticeSeen = true, onAcknowledgeFullAccess, onComposerReady, onOpenThread, onOpenSideChat, onCloseSideChat, onArchived }: {
  threadId: string; project: Project; projects: Project[]; models: ModelOption[]; sideChat?: boolean;
  codeServer: CodeServerStatus;
  parallelWriteWarning?: boolean; linkedSideChatActive?: boolean; fullAccessNoticeSeen?: boolean; onAcknowledgeFullAccess?(): void;
  onComposerReady?(element: HTMLTextAreaElement | null): void;
  onOpenThread(threadId: string): void; onOpenSideChat(threadId: string): void; onCloseSideChat?(): void; onArchived?(threadId: string): void;
}) {
  const queryClient = useQueryClient(); const restorePrefill = useAppStore((state) => state.restorePrefill);
  const reconcileOptimisticUserMessages = useAppStore((state) => state.reconcileOptimisticUserMessages);
  const query = useQuery({ queryKey: ["session", threadId], queryFn: ({ signal }) => endpoints.session(threadId, signal), refetchInterval: false, retry: sideChat ? false : 2 });
  const liveRuntime = useAppStore((state) => state.runtimes[threadId]); const connectionState = useAppStore((state) => state.connectionState); const payload = query.data;
  const runtime = liveRuntime ?? payload?.runtime; const state: RuntimeState = connectionState === "connected" ? (runtime?.state ?? "idle") : "disconnected";
  const title = sideChat ? "Side Chat" : payload?.thread.name || payload?.thread.preview || "Session";
  const [pendingFork, setPendingFork] = useState<{ turnId: string | null; position: "before" | "after"; sourceTurnId: string } | null>(null);
  const [inheritGoal, setInheritGoal] = useState(false);
  const [composerAccessMode, setComposerAccessMode] = useState<AccessMode | null>(null);
  useEffect(() => setComposerAccessMode(null), [threadId]);
  useEffect(() => {
    if (sideChat) return;
    void api(`/api/sessions/${threadId}/viewed`, { method: "POST", body: JSON.stringify({ clientRequestId: newClientRequestId() }) })
      .then(() => queryClient.invalidateQueries({ queryKey: ["sessions"] }))
      .catch(() => undefined);
  }, [queryClient, sideChat, threadId]);
  const fork = useMutation({ mutationFn: async ({ turnId, position, sourceTurnId, inheritGoal: shouldInheritGoal }: { turnId: string | null; position: "before" | "after"; sourceTurnId: string; inheritGoal: boolean }) => {
    const empty = position === "before" && turnId === null;
    const prefill = empty ? questionForTurn(payload?.thread.turns ?? [], sourceTurnId) : undefined;
    const created = await api<{ thread: { id: string } }>(`/api/sessions/${threadId}/forks`, { method: "POST", body: JSON.stringify({ lastTurnId: turnId, empty, prefill, inheritGoal: shouldInheritGoal, clientRequestId: crypto.randomUUID() }) });
    if (prefill) restorePrefill(created.thread.id, prefill);
    return created;
  }, onSuccess: (result) => { setPendingFork(null); setInheritGoal(false); void queryClient.invalidateQueries({ queryKey: ["sessions"] }); onOpenThread(result.thread.id); }, onError: (error) => {
    void refreshProjectAvailabilityAfterError(error, (queryKey) => queryClient.invalidateQueries({ queryKey }));
  } });
  const requestFork = (turnId: string | null, position: "before" | "after", sourceTurnId = turnId ?? "") => {
    if (payload?.goal) { setPendingFork({ turnId, position, sourceTurnId }); setInheritGoal(false); return; }
    fork.mutate({ turnId, position, sourceTurnId, inheritGoal: false });
  };
  const side = useMutation({ mutationFn: (anchorTurnId: string | null) => api<{ threadId: string }>(`/api/sessions/${threadId}/side-chat`, { method: "POST", body: JSON.stringify({ anchorTurnId, clientRequestId: newClientRequestId() }) }), onSuccess: (result) => onOpenSideChat(result.threadId), onError: (error) => {
    void refreshProjectAvailabilityAfterError(error, (queryKey) => queryClient.invalidateQueries({ queryKey }));
  } });
  const rename = useMutation({ mutationFn: async () => { const name = window.prompt("Session 名称", title); if (!name?.trim()) return; return api(`/api/sessions/${threadId}/name`, { method: "PATCH", body: JSON.stringify({ name: name.trim(), clientRequestId: newClientRequestId() }) }); }, onSuccess: () => { void queryClient.invalidateQueries({ queryKey: ["session", threadId] }); void queryClient.invalidateQueries({ queryKey: ["sessions"] }); } });
  const move = useMutation({ mutationFn: (projectId: string) => api(`/api/sessions/${threadId}/project`, { method: "PATCH", body: JSON.stringify({ projectId, clientRequestId: newClientRequestId() }) }), onSuccess: () => { void queryClient.invalidateQueries({ queryKey: ["sessions"] }); } });
  const archive = useMutation({ mutationFn: () => api(`/api/sessions/${threadId}/archive`, { method: "POST", body: JSON.stringify({ clientRequestId: newClientRequestId() }) }), onSuccess: () => { if (onArchived) onArchived(threadId); else void queryClient.invalidateQueries({ queryKey: ["sessions"] }); } });
  const projectLabel = sideChat ? project.name : project.name;
  const turns = useMemo(() => payload?.thread.turns ?? [], [payload?.thread.turns]);
  const canReconcileOptimistic = canReconcileOptimisticUserMessages(turns);
  useEffect(() => {
    if (!canReconcileOptimistic) return;
    reconcileOptimisticUserMessages(threadId, confirmedClientUserMessageIds(turns));
  }, [canReconcileOptimistic, reconcileOptimisticUserMessages, threadId, turns]);
  const latestCompletedTurnId = useMemo(() => [...turns].reverse().find((turn) => turn.status === "completed")?.id ?? null, [turns]);
  const hasActiveTurn = state === "running" || state === "waitingForInput";
  const activeStartedAt = useMemo(() => turns.find((turn) => turn.status === "inProgress")?.startedAt ?? null, [turns]);
  const [now, setNow] = useState(Date.now());
  useEffect(() => {
    if (!activeStartedAt || (state !== "running" && state !== "waitingForInput")) return;
    setNow(Date.now());
    const timer = window.setInterval(() => setNow(Date.now()), 1_000);
    return () => window.clearInterval(timer);
  }, [activeStartedAt, state]);
  const elapsed = activeStartedAt ? Math.max(0, Math.floor((now - activeStartedAt * 1_000) / 1_000)) : null;
  const sessionDisconnected = state === "disconnected";
  const branchActionsAvailable = canBranchSession(project.available, state);
  if (query.isLoading) return <div className="pane-loading"><div className="header-skeleton" /><div className="timeline-skeleton"><i /><i /><i /></div></div>;
  if (query.isError || !payload) return <div className="pane-error"><TerminalWindow size={28} /><h2>{sideChat ? "Side Chat 已不可用" : "无法打开 Session"}</h2><p>{query.error?.message ?? "Session 不可用"}</p><div className="pane-error-actions"><button className="button secondary" onClick={() => query.refetch()}>重试</button>{sideChat && onCloseSideChat && <button className="button danger-ghost" onClick={onCloseSideChat}>关闭 Side Chat</button>}</div></div>;
  return <section className={`session-pane ${sideChat ? "side-chat-pane" : ""}`}>
    <header className="session-header"><div className="breadcrumb"><span>{projectLabel}</span><span>/</span><strong>{title}</strong></div><div className="header-status"><StatusIcon state={state} /><span>{statusText(state)}{elapsed !== null && (state === "running" || state === "waitingForInput") ? ` ${elapsed}s` : ""}</span></div><ContextUsageIndicator usage={runtime?.contextUsage} /><span className="header-spacer" />
      {!sideChat && <button className="header-button" onClick={() => side.mutate(null)} disabled={side.isPending || !branchActionsAvailable}><SidebarSimple size={16} />Side Chat</button>}
      {!sideChat && (codeServer.state === "available" && codeServer.url
        ? <a className="header-button" href={codeServerFolderUrl(codeServer.url, payload.thread.cwd)} target="_blank" rel="noreferrer"><TerminalWindow size={16} />在 code-server 中打开</a>
        : <button className="header-button unavailable" disabled title={codeServer.state === "checking" ? "正在检查 code-server" : codeServer.state === "unconfigured" ? "未配置 code-server" : "code-server 当前不可用"}><TerminalWindow size={16} />code-server 不可用</button>)}
      {sideChat ? <button className="icon-button" onClick={onCloseSideChat} aria-label="关闭 Side Chat"><X size={17} /></button> : <DropdownMenu.Root><DropdownMenu.Trigger asChild><button className="icon-button" aria-label="更多"><DotsThree size={20} weight="bold" /></button></DropdownMenu.Trigger><DropdownMenu.Portal><DropdownMenu.Content className="menu-content" sideOffset={5} align="end"><DropdownMenu.Item className="menu-item" disabled={sessionDisconnected || rename.isPending} onSelect={() => rename.mutate()}>重命名</DropdownMenu.Item><DropdownMenu.Sub><DropdownMenu.SubTrigger className="menu-item" disabled={hasActiveTurn || sessionDisconnected}>移动到 Project</DropdownMenu.SubTrigger><DropdownMenu.Portal><DropdownMenu.SubContent className="menu-content" sideOffset={6}>{projects.map((candidate) => <DropdownMenu.Item key={candidate.id} className="menu-item" disabled={candidate.id === project.id || !candidate.available} onSelect={() => move.mutate(candidate.id)}>{candidate.name}</DropdownMenu.Item>)}</DropdownMenu.SubContent></DropdownMenu.Portal></DropdownMenu.Sub><DropdownMenu.Item className="menu-item" disabled={!latestCompletedTurnId || !branchActionsAvailable} onSelect={() => requestFork(latestCompletedTurnId, "after")}><GitFork size={14} />Fork 当前最新位置</DropdownMenu.Item><DropdownMenu.Separator className="menu-separator" /><DropdownMenu.Item className="menu-item danger-item" disabled={hasActiveTurn || linkedSideChatActive || sessionDisconnected} onSelect={() => archive.mutate()}>归档</DropdownMenu.Item></DropdownMenu.Content></DropdownMenu.Portal></DropdownMenu.Root>}
    </header>
      {!sideChat && <GoalBar threadId={threadId} goal={payload.goal} disabled={sessionDisconnected} />}
    <PendingBanner threadId={threadId} />
    <div className="session-notices">
      {!sideChat && rename.isError && <div className="session-action-error" role="alert"><WarningCircle size={15} weight="fill" /><span>重命名失败：{rename.error.message}</span><button onClick={() => rename.reset()} aria-label="关闭重命名错误"><X size={14} /></button></div>}
      {!pendingFork && fork.isError && <div className="session-action-error" role="alert"><WarningCircle size={15} weight="fill" /><span>Fork 创建失败：{fork.error.message}</span><button onClick={() => fork.reset()} aria-label="关闭 Fork 创建错误"><X size={14} /></button></div>}
      {!sideChat && side.isError && <div className="session-action-error" role="alert"><WarningCircle size={15} weight="fill" /><span>Side Chat 创建失败：{side.error.message}</span><button onClick={() => side.reset()} aria-label="关闭 Side Chat 创建错误"><X size={14} /></button></div>}
      {shouldShowFullAccessNotice(payload.settings.accessMode, composerAccessMode, fullAccessNoticeSeen) && <div className="full-access-notice"><ShieldWarning size={16} weight="fill" /><span><strong>此 Project 已启用 Full Access</strong>Codex 可以修改工作区外的文件并执行不经逐次审批的命令。</span><button onClick={onAcknowledgeFullAccess}>知道了</button></div>}
      {parallelWriteWarning && <div className="parallel-write-warning"><WarningCircle size={15} weight="fill" /><span>主 Session 和 Side Chat 可能同时修改同一工作区</span></div>}
    </div>
    <SubagentStatus parentThreadId={threadId} rootSettings={payload.settings} />
    <div className="timeline-area"><Timeline key={threadId} threadId={threadId} turns={turns} canFork={!sideChat && branchActionsAvailable} codeServer={codeServer} cwd={payload.thread.cwd} onFork={requestFork} onSideChat={(turnId) => side.mutate(turnId)} /></div>
    <Composer threadId={threadId} project={project} models={models} runtimeState={state} activeTurnId={runtime?.activeTurnId} uncertainTurnStart={runtime?.uncertainTurnStart} initialSettings={payload.settings} goal={payload.goal} contextUsage={runtime?.contextUsage} latestCompletedTurnId={latestCompletedTurnId} compact={sideChat} disabled={!project.available} onTextareaReady={onComposerReady} onAccessModeChange={setComposerAccessMode} onForkLatest={!sideChat && latestCompletedTurnId ? () => requestFork(latestCompletedTurnId, "after") : undefined} onOpenSideChat={!sideChat ? () => side.mutate(latestCompletedTurnId) : undefined} />
    <Dialog.Root open={!!pendingFork} onOpenChange={(open) => { if (!open) { setPendingFork(null); setInheritGoal(false); } }}><Dialog.Portal><Dialog.Overlay className="dialog-overlay" /><Dialog.Content className="dialog-content fork-dialog" aria-describedby="fork-dialog-description"><div className="dialog-heading"><GitFork size={18} weight="fill" /><Dialog.Title>创建 Fork</Dialog.Title></div><Dialog.Description className="dialog-description" id="fork-dialog-description">新 Session 会复制到所选 Turn 边界，并继承当前模型、Reasoning 和权限。</Dialog.Description><label className="goal-inherit-option"><input type="checkbox" checked={inheritGoal} onChange={(event) => setInheritGoal(event.target.checked)} /><span><Target size={16} weight="fill" /><span><strong>继承父 Session 的 Goal</strong><small>默认关闭，避免分叉任务意外推进原目标。</small></span></span></label>{fork.isError && <p className="dialog-error">{fork.error.message}</p>}<div className="dialog-actions"><Dialog.Close asChild><button className="button secondary">取消</button></Dialog.Close><button className="button primary" disabled={fork.isPending || !pendingFork || !branchActionsAvailable} onClick={() => pendingFork && fork.mutate({ ...pendingFork, inheritGoal })}><GitFork size={14} />创建 Fork</button></div></Dialog.Content></Dialog.Portal></Dialog.Root>
  </section>;
}
