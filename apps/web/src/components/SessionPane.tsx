import { useMemo } from "react";
import { DotsThree, GitFork, SidebarSimple, TerminalWindow, X } from "@phosphor-icons/react";
import * as DropdownMenu from "@radix-ui/react-dropdown-menu";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import type { ModelOption, Project, RuntimeState } from "@codex-web/shared-types";
import { api, endpoints } from "../api";
import { useAppStore } from "../store";
import { Composer } from "./Composer";
import { GoalBar } from "./GoalBar";
import { PendingBanner } from "./PendingBanner";
import { StatusIcon, statusText } from "./StatusIcon";
import { Timeline } from "./Timeline";

function firstQuestion(turns: import("../api").CodexTurn[]): string {
  const item = turns[0]?.items.find((candidate) => candidate.type === "userMessage") as Extract<import("../api").CodexItem, { type: "userMessage" }> | undefined;
  return item?.content.map((part) => part.text ?? "").join("\n") ?? "";
}

export function SessionPane({ threadId, project, models, sideChat = false, onOpenThread, onOpenSideChat, onCloseSideChat }: {
  threadId: string; project: Project; models: ModelOption[]; sideChat?: boolean;
  onOpenThread(threadId: string): void; onOpenSideChat(threadId: string): void; onCloseSideChat?(): void;
}) {
  const queryClient = useQueryClient(); const setDraft = useAppStore((state) => state.setDraft);
  const query = useQuery({ queryKey: ["session", threadId], queryFn: () => endpoints.session(threadId), refetchInterval: false });
  const liveRuntime = useAppStore((state) => state.runtimes[threadId]); const payload = query.data;
  const runtime = liveRuntime ?? payload?.runtime; const state: RuntimeState = runtime?.state ?? "idle";
  const title = sideChat ? "Side Chat" : payload?.thread.name || payload?.thread.preview || "Session";
  const fork = useMutation({ mutationFn: async ({ turnId, position }: { turnId: string | null; position: "before" | "after" }) => {
    if (position === "before" && turnId === null) {
      const created = await api<{ thread: { id: string } }>(`/api/projects/${project.id}/sessions`, { method: "POST", body: JSON.stringify({ clientRequestId: crypto.randomUUID() }) });
      setDraft(created.thread.id, firstQuestion(payload?.thread.turns ?? [])); return created;
    }
    const inheritGoal = payload?.goal ? window.confirm("继承父 Session 的 Goal？") : false;
    return api<{ thread: { id: string } }>(`/api/sessions/${threadId}/forks`, { method: "POST", body: JSON.stringify({ lastTurnId: turnId, inheritGoal, clientRequestId: crypto.randomUUID() }) });
  }, onSuccess: (result) => { void queryClient.invalidateQueries({ queryKey: ["sessions"] }); onOpenThread(result.thread.id); } });
  const side = useMutation({ mutationFn: (anchorTurnId: string | null) => api<{ threadId: string }>(`/api/sessions/${threadId}/side-chat`, { method: "POST", body: JSON.stringify({ anchorTurnId }) }), onSuccess: (result) => onOpenSideChat(result.threadId) });
  const rename = useMutation({ mutationFn: async () => { const name = window.prompt("Session 名称", title); if (!name?.trim()) return; return api(`/api/sessions/${threadId}/name`, { method: "PATCH", body: JSON.stringify({ name: name.trim() }) }); }, onSuccess: () => { void queryClient.invalidateQueries({ queryKey: ["session", threadId] }); void queryClient.invalidateQueries({ queryKey: ["sessions"] }); } });
  const archive = useMutation({ mutationFn: () => api(`/api/sessions/${threadId}/archive`, { method: "POST" }), onSuccess: () => { void queryClient.invalidateQueries({ queryKey: ["sessions"] }); } });
  const projectLabel = sideChat ? project.name : project.name;
  const turns = useMemo(() => payload?.thread.turns ?? [], [payload?.thread.turns]);
  if (query.isLoading) return <div className="pane-loading"><div className="header-skeleton" /><div className="timeline-skeleton"><i /><i /><i /></div></div>;
  if (query.isError || !payload) return <div className="pane-error"><TerminalWindow size={28} /><h2>无法打开 Session</h2><p>{query.error?.message ?? "Session 不可用"}</p><button className="button secondary" onClick={() => query.refetch()}>重试</button></div>;
  return <section className={`session-pane ${sideChat ? "side-chat-pane" : ""}`}>
    <header className="session-header"><div className="breadcrumb"><span>{projectLabel}</span><span>/</span><strong>{title}</strong></div><div className="header-status"><StatusIcon state={state} /><span>{statusText(state)}</span></div><span className="header-spacer" />
      {!sideChat && <button className="header-button" onClick={() => side.mutate(null)} disabled={side.isPending}><SidebarSimple size={16} />Side Chat</button>}
      {!sideChat && <a className="header-button" href={`vscode://file/${encodeURI(payload.thread.cwd)}`}><TerminalWindow size={16} />在编辑器中打开</a>}
      {sideChat ? <button className="icon-button" onClick={onCloseSideChat} aria-label="关闭 Side Chat"><X size={17} /></button> : <DropdownMenu.Root><DropdownMenu.Trigger asChild><button className="icon-button" aria-label="更多"><DotsThree size={20} weight="bold" /></button></DropdownMenu.Trigger><DropdownMenu.Portal><DropdownMenu.Content className="menu-content" sideOffset={5} align="end"><DropdownMenu.Item className="menu-item" onSelect={() => rename.mutate()}>重命名</DropdownMenu.Item><DropdownMenu.Item className="menu-item" onSelect={() => fork.mutate({ turnId: turns.at(-1)?.id ?? null, position: "after" })}><GitFork size={14} />Fork 当前最新位置</DropdownMenu.Item><DropdownMenu.Separator className="menu-separator" /><DropdownMenu.Item className="menu-item danger-item" onSelect={() => archive.mutate()}>归档</DropdownMenu.Item></DropdownMenu.Content></DropdownMenu.Portal></DropdownMenu.Root>}
    </header>
    {!sideChat && <GoalBar threadId={threadId} goal={payload.goal} />}
    <PendingBanner threadId={threadId} />
    <div className="timeline-area"><Timeline turns={turns} canFork={!sideChat} onFork={(turnId, position) => fork.mutate({ turnId, position })} onSideChat={(turnId) => side.mutate(turnId)} /></div>
    <Composer threadId={threadId} project={project} models={models} runtimeState={state} activeTurnId={runtime?.activeTurnId} initialSettings={payload.settings} compact={sideChat} />
  </section>;
}
