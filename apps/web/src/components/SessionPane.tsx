import { useEffect, useMemo, useState } from "react";
import { DotsThree, GitFork, ShieldWarning, SidebarSimple, Target, TerminalWindow, WarningCircle, X } from "@phosphor-icons/react";
import * as Dialog from "@radix-ui/react-dialog";
import * as DropdownMenu from "@radix-ui/react-dropdown-menu";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import type { AccessMode, ModelOption, Project, RuntimeState } from "@codex-web/shared-types";
import { api, endpoints, newClientRequestId } from "../api";
import { vscodeFileUri } from "../editor-uri";
import { questionForTurn } from "../fork-boundary";
import { shouldShowFullAccessNotice } from "../full-access-notice";
import { useAppStore } from "../store";
import { Composer } from "./Composer";
import { GoalBar } from "./GoalBar";
import { PendingBanner } from "./PendingBanner";
import { StatusIcon, statusText } from "./StatusIcon";
import { Timeline } from "./Timeline";

export function SessionPane({ threadId, project, projects, models, sideChat = false, parallelWriteWarning = false, linkedSideChatActive = false, fullAccessNoticeSeen = true, onAcknowledgeFullAccess, onComposerReady, onOpenThread, onOpenSideChat, onCloseSideChat }: {
  threadId: string; project: Project; projects: Project[]; models: ModelOption[]; sideChat?: boolean;
  parallelWriteWarning?: boolean; linkedSideChatActive?: boolean; fullAccessNoticeSeen?: boolean; onAcknowledgeFullAccess?(): void;
  onComposerReady?(element: HTMLTextAreaElement | null): void;
  onOpenThread(threadId: string): void; onOpenSideChat(threadId: string): void; onCloseSideChat?(): void;
}) {
  const queryClient = useQueryClient(); const setDraft = useAppStore((state) => state.setDraft);
  const query = useQuery({ queryKey: ["session", threadId], queryFn: () => endpoints.session(threadId), refetchInterval: false, retry: sideChat ? false : 2 });
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
    const created = await api<{ thread: { id: string } }>(`/api/sessions/${threadId}/forks`, { method: "POST", body: JSON.stringify({ lastTurnId: turnId, empty, inheritGoal: shouldInheritGoal, clientRequestId: crypto.randomUUID() }) });
    if (empty) setDraft(created.thread.id, questionForTurn(payload?.thread.turns ?? [], sourceTurnId));
    return created;
  }, onSuccess: (result) => { setPendingFork(null); setInheritGoal(false); void queryClient.invalidateQueries({ queryKey: ["sessions"] }); onOpenThread(result.thread.id); } });
  const requestFork = (turnId: string | null, position: "before" | "after", sourceTurnId = turnId ?? "") => {
    if (payload?.goal) { setPendingFork({ turnId, position, sourceTurnId }); setInheritGoal(false); return; }
    fork.mutate({ turnId, position, sourceTurnId, inheritGoal: false });
  };
  const side = useMutation({ mutationFn: (anchorTurnId: string | null) => api<{ threadId: string }>(`/api/sessions/${threadId}/side-chat`, { method: "POST", body: JSON.stringify({ anchorTurnId, clientRequestId: newClientRequestId() }) }), onSuccess: (result) => onOpenSideChat(result.threadId) });
  const rename = useMutation({ mutationFn: async () => { const name = window.prompt("Session 名称", title); if (!name?.trim()) return; return api(`/api/sessions/${threadId}/name`, { method: "PATCH", body: JSON.stringify({ name: name.trim(), clientRequestId: newClientRequestId() }) }); }, onSuccess: () => { void queryClient.invalidateQueries({ queryKey: ["session", threadId] }); void queryClient.invalidateQueries({ queryKey: ["sessions"] }); } });
  const move = useMutation({ mutationFn: (projectId: string) => api(`/api/sessions/${threadId}/project`, { method: "PATCH", body: JSON.stringify({ projectId, clientRequestId: newClientRequestId() }) }), onSuccess: () => { void queryClient.invalidateQueries({ queryKey: ["sessions"] }); } });
  const archive = useMutation({ mutationFn: () => api(`/api/sessions/${threadId}/archive`, { method: "POST", body: JSON.stringify({ clientRequestId: newClientRequestId() }) }), onSuccess: () => { void queryClient.invalidateQueries({ queryKey: ["sessions"] }); } });
  const projectLabel = sideChat ? project.name : project.name;
  const turns = useMemo(() => payload?.thread.turns ?? [], [payload?.thread.turns]);
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
  if (query.isLoading) return <div className="pane-loading"><div className="header-skeleton" /><div className="timeline-skeleton"><i /><i /><i /></div></div>;
  if (query.isError || !payload) return <div className="pane-error"><TerminalWindow size={28} /><h2>{sideChat ? "Side Chat 已不可用" : "无法打开 Session"}</h2><p>{query.error?.message ?? "Session 不可用"}</p><div className="pane-error-actions"><button className="button secondary" onClick={() => query.refetch()}>重试</button>{sideChat && onCloseSideChat && <button className="button danger-ghost" onClick={onCloseSideChat}>关闭 Side Chat</button>}</div></div>;
  return <section className={`session-pane ${sideChat ? "side-chat-pane" : ""}`}>
    <header className="session-header"><div className="breadcrumb"><span>{projectLabel}</span><span>/</span><strong>{title}</strong></div><div className="header-status"><StatusIcon state={state} /><span>{statusText(state)}{elapsed !== null && (state === "running" || state === "waitingForInput") ? ` ${elapsed}s` : ""}</span></div><span className="header-spacer" />
      {!sideChat && <button className="header-button" onClick={() => side.mutate(null)} disabled={side.isPending}><SidebarSimple size={16} />Side Chat</button>}
      {!sideChat && <a className="header-button" href={vscodeFileUri(payload.thread.cwd)}><TerminalWindow size={16} />在编辑器中打开</a>}
      {sideChat ? <button className="icon-button" onClick={onCloseSideChat} aria-label="关闭 Side Chat"><X size={17} /></button> : <DropdownMenu.Root><DropdownMenu.Trigger asChild><button className="icon-button" aria-label="更多"><DotsThree size={20} weight="bold" /></button></DropdownMenu.Trigger><DropdownMenu.Portal><DropdownMenu.Content className="menu-content" sideOffset={5} align="end"><DropdownMenu.Item className="menu-item" disabled={hasActiveTurn} onSelect={() => rename.mutate()}>重命名</DropdownMenu.Item><DropdownMenu.Sub><DropdownMenu.SubTrigger className="menu-item" disabled={hasActiveTurn}>移动到 Project</DropdownMenu.SubTrigger><DropdownMenu.Portal><DropdownMenu.SubContent className="menu-content" sideOffset={6}>{projects.map((candidate) => <DropdownMenu.Item key={candidate.id} className="menu-item" disabled={candidate.id === project.id || !candidate.available} onSelect={() => move.mutate(candidate.id)}>{candidate.name}</DropdownMenu.Item>)}</DropdownMenu.SubContent></DropdownMenu.Portal></DropdownMenu.Sub><DropdownMenu.Item className="menu-item" disabled={!latestCompletedTurnId} onSelect={() => requestFork(latestCompletedTurnId, "after")}><GitFork size={14} />Fork 当前最新位置</DropdownMenu.Item><DropdownMenu.Separator className="menu-separator" /><DropdownMenu.Item className="menu-item danger-item" disabled={hasActiveTurn || linkedSideChatActive} onSelect={() => archive.mutate()}>归档</DropdownMenu.Item></DropdownMenu.Content></DropdownMenu.Portal></DropdownMenu.Root>}
    </header>
      {!sideChat && <GoalBar threadId={threadId} goal={payload.goal} disabled={hasActiveTurn} />}
    <PendingBanner threadId={threadId} />
    {!sideChat && shouldShowFullAccessNotice(payload.settings.accessMode, composerAccessMode, fullAccessNoticeSeen) && <div className="full-access-notice"><ShieldWarning size={16} weight="fill" /><span><strong>此 Project 已启用 Full Access</strong>Codex 可以修改工作区外的文件并执行不经逐次审批的命令。</span><button onClick={onAcknowledgeFullAccess}>知道了</button></div>}
    {parallelWriteWarning && <div className="parallel-write-warning"><WarningCircle size={15} weight="fill" /><span>主 Session 和 Side Chat 可能同时修改同一工作区</span></div>}
    <div className="timeline-area"><Timeline turns={turns} canFork={!sideChat} onFork={requestFork} onSideChat={(turnId) => side.mutate(turnId)} /></div>
    <Composer threadId={threadId} project={project} models={models} runtimeState={state} activeTurnId={runtime?.activeTurnId} initialSettings={payload.settings} compact={sideChat} onTextareaReady={onComposerReady} onAccessModeChange={sideChat ? undefined : setComposerAccessMode} />
    <Dialog.Root open={!!pendingFork} onOpenChange={(open) => { if (!open) { setPendingFork(null); setInheritGoal(false); } }}><Dialog.Portal><Dialog.Overlay className="dialog-overlay" /><Dialog.Content className="dialog-content fork-dialog" aria-describedby="fork-dialog-description"><div className="dialog-heading"><GitFork size={18} weight="fill" /><Dialog.Title>创建 Fork</Dialog.Title></div><Dialog.Description className="dialog-description" id="fork-dialog-description">新 Session 会复制到所选 Turn 边界，并继承当前模型、Reasoning 和权限。</Dialog.Description><label className="goal-inherit-option"><input type="checkbox" checked={inheritGoal} onChange={(event) => setInheritGoal(event.target.checked)} /><span><Target size={16} weight="fill" /><span><strong>继承父 Session 的 Goal</strong><small>默认关闭，避免分叉任务意外推进原目标。</small></span></span></label>{fork.isError && <p className="dialog-error">{fork.error.message}</p>}<div className="dialog-actions"><Dialog.Close asChild><button className="button secondary">取消</button></Dialog.Close><button className="button primary" disabled={fork.isPending || !pendingFork} onClick={() => pendingFork && fork.mutate({ ...pendingFork, inheritGoal })}><GitFork size={14} />创建 Fork</button></div></Dialog.Content></Dialog.Portal></Dialog.Root>
  </section>;
}
