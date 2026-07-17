import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState, type CSSProperties } from "react";
import { FolderOpen, List, ShieldWarning, SpinnerGap, TerminalWindow, WarningCircle, X } from "@phosphor-icons/react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useLocation, useNavigate } from "react-router-dom";
import type { Preferences, Project, SessionSummary, UiEvent } from "@codex-web/shared-types";
import { api, bootstrap, endpoints, newClientRequestId, type SessionPayload } from "./api";
import { applySessionEvent } from "./live-session";
import { COMPOSER_FOCUS_RETRY_DELAYS, shouldRestoreComposerFocus } from "./composer-focus";
import { shouldWarnAboutParallelFullAccess } from "./parallel-write-warning";
import { resizedSideChatWidth } from "./side-chat-layout";
import { queryClient } from "./main";
import { useAppStore } from "./store";
import { SessionPane } from "./components/SessionPane";
import { ProjectSettingsDialog } from "./components/ProjectSettingsDialog";
import { Sidebar } from "./components/Sidebar";

function threadIdFromPath(pathname: string): string | null { return /^\/sessions\/([^/]+)$/.exec(pathname)?.[1] ?? null; }

function AuthGate() {
  return <main className="blocking-page"><div className="blocking-panel"><div className="blocking-icon"><ShieldWarning size={28} weight="fill" /></div><h1>需要 Codex 登录</h1><p>请先在启动 Codex Web 所使用的 CODEX_HOME 中通过 CLI 完成登录，然后重新启动服务。</p><code>codex login</code><p className="blocking-note">Web UI 不读取或保存凭证。</p></div></main>;
}

function EmptyWorkspace({ onAdd }: { onAdd(): void }) {
  return <main className="empty-workspace"><div className="empty-illustration"><FolderOpen size={34} /></div><h1>添加第一个 Project</h1><p>选择一个本地文件夹，Codex Web 会扫描启动服务所使用的 CODEX_HOME 中与该路径匹配的 Session。</p><button className="button primary large" onClick={onAdd}><FolderOpen size={17} />选择文件夹</button></main>;
}

export function App() {
  const navigate = useNavigate(); const location = useLocation(); const client = useQueryClient();
  const selectedThreadId = threadIdFromPath(location.pathname); const [search, setSearch] = useState(""); const [mobilePane, setMobilePane] = useState<"main" | "side">("main"); const [sidebarOpen, setSidebarOpen] = useState(false);
  const [settingsProject, setSettingsProject] = useState<Project | null>(null);
  const initialized = useRef(false); const lastFocusScan = useRef(0); const workspaceRef = useRef<HTMLElement>(null); const mainComposerRef = useRef<HTMLTextAreaElement>(null);
  const restoreMainComposerFocus = useRef(false); const focusOrigin = useRef<Element | null>(null); const focusTimers = useRef<number[]>([]);
  const bindMainComposer = useCallback((element: HTMLTextAreaElement | null) => { mainComposerRef.current = element; }, []);
  const scheduleMainComposerFocus = useCallback(() => {
    for (const timer of focusTimers.current) window.clearTimeout(timer);
    focusTimers.current = COMPOSER_FOCUS_RETRY_DELAYS.map((delay, index) => window.setTimeout(() => {
      if (!restoreMainComposerFocus.current) return;
      const target = mainComposerRef.current; const active = document.activeElement;
      if (target?.isConnected && shouldRestoreComposerFocus({
        hasActiveElement: !!active,
        activeIsTarget: active === target,
        activeIsOrigin: active === focusOrigin.current,
        activeIsBody: active === document.body,
        activeIsDocumentElement: active === document.documentElement,
        activeIsConnected: active?.isConnected ?? false,
      })) target.focus({ preventScroll: true });
      if (index === COMPOSER_FOCUS_RETRY_DELAYS.length - 1) { restoreMainComposerFocus.current = false; focusOrigin.current = null; }
    }, delay));
  }, []);
  const bootstrapQuery = useQuery({ queryKey: ["bootstrap"], queryFn: bootstrap, staleTime: Infinity, retry: 2 });
  const bootstrapData = bootstrapQuery.data; const preferences = bootstrapData?.preferences;
  const projectsQuery = useQuery({ queryKey: ["projects"], queryFn: endpoints.projects, enabled: !!bootstrapData });
  const allSessionsQuery = useQuery({ queryKey: ["sessions", "", preferences?.sortDirection], queryFn: () => endpoints.sessions("", preferences?.sortDirection ?? "desc"), enabled: !!bootstrapData?.authReady });
  const filteredSessionsQuery = useQuery({ queryKey: ["sessions", search, preferences?.sortDirection], queryFn: () => endpoints.sessions(search, preferences?.sortDirection ?? "desc"), enabled: !!bootstrapData?.authReady && !!search.trim() });
  const consume = useAppStore((state) => state.consume); const initialize = useAppStore((state) => state.initialize); const markDisconnected = useAppStore((state) => state.markDisconnected); const sideChats = useAppStore((state) => state.sideChats);
  const projects = projectsQuery.data ?? bootstrapData?.projects ?? []; const allSessions = allSessionsQuery.data ?? []; const sessions = search.trim() ? (filteredSessionsQuery.data ?? []) : allSessions;
  const bootstrapReady = !!bootstrapData;
  const selected = allSessions.find((session) => session.threadId === selectedThreadId); const selectedProject = projects.find((project) => project.id === selected?.projectId) ?? null;
  const sideChat = useMemo(() => Object.values(sideChats).find((item) => item.parentThreadId === selectedThreadId), [sideChats, selectedThreadId]);
  const sideThreadId = sideChat?.threadId ?? null;
  const mainRuntime = useAppStore((state) => selectedThreadId ? state.runtimes[selectedThreadId] : undefined);
  const sideRuntime = useAppStore((state) => sideThreadId ? state.runtimes[sideThreadId] : undefined);
  const mainSessionForWarning = useQuery({ queryKey: ["session", selectedThreadId], queryFn: () => endpoints.session(selectedThreadId!), enabled: !!selectedThreadId && !!sideThreadId });
  const sideSessionForWarning = useQuery({ queryKey: ["session", sideThreadId], queryFn: () => endpoints.session(sideThreadId!), enabled: !!sideThreadId, retry: false });
  const parallelWriteWarning = shouldWarnAboutParallelFullAccess(
    mainRuntime && mainSessionForWarning.data ? { state: mainRuntime.state, accessMode: mainSessionForWarning.data.settings.accessMode } : null,
    sideRuntime && sideSessionForWarning.data ? { state: sideRuntime.state, accessMode: sideSessionForWarning.data.settings.accessMode } : null,
  );

  useEffect(() => {
    if (!bootstrapData || initialized.current) return; initialized.current = true; initialize(bootstrapData.runtimeStates, bootstrapData.activeSideChats, bootstrapData.itemDeltas, bootstrapData.pendingRequests, bootstrapData.connection.state);
  }, [bootstrapData, initialize]);
  useEffect(() => {
    if (selectedThreadId || !allSessionsQuery.isSuccess || !allSessions.length) return;
    navigate(`/sessions/${allSessions[0]!.threadId}`, { replace: true });
  }, [allSessions, allSessionsQuery.isSuccess, navigate, selectedThreadId]);
  useEffect(() => {
    if (!bootstrapReady) return;
    let socket: WebSocket | null = null; let retryTimer: number | undefined; let retryAttempt = 0; let disposed = false; let snapshotRefresh: Promise<boolean> | null = null;
    let buffering = false; let bufferedEvents: UiEvent[] = [];
    const applyEvent = (event: UiEvent) => {
      const liveDeltas = useAppStore.getState().deltas;
      const eventConnectionState = event.type === "connection.changed" ? (event.payload as { state?: string }).state : undefined;
      if (eventConnectionState !== "connected") consume(event);
      if (eventConnectionState === "connected") void refreshSnapshot().catch(scheduleReconnect);
      if (["turn.started", "turn.completed", "item.upserted", "item.delta", "goal.updated", "goal.cleared", "session.settings.updated"].includes(event.type) && event.threadId) {
        client.setQueryData<SessionPayload>(["session", event.threadId], (current) => applySessionEvent(current, event, liveDeltas));
      }
      if (["session.summary.updated", "sessions.rescanned", "turn.completed", "turn.started", "goal.updated", "goal.cleared"].includes(event.type)) void client.invalidateQueries({ queryKey: ["sessions"] });
    };
    const refreshSnapshot = () => {
      if (snapshotRefresh) return snapshotRefresh;
      buffering = true;
      snapshotRefresh = (async () => {
        const fresh = await bootstrap();
        if (disposed) return false;
        client.setQueryData(["bootstrap"], fresh);
        client.setQueryData(["projects"], fresh.projects);
        initialize(fresh.runtimeStates, fresh.activeSideChats, fresh.itemDeltas, fresh.pendingRequests, fresh.connection.state);
        const replay = bufferedEvents.filter((event) => event.seq > fresh.eventSeq).sort((left, right) => left.seq - right.seq);
        bufferedEvents = [];
        buffering = false;
        for (const event of replay) applyEvent(event);
        await Promise.all([
          client.invalidateQueries({ queryKey: ["sessions"] }),
          client.invalidateQueries({ queryKey: ["session"] }),
        ]);
        return true;
      })().finally(() => {
        snapshotRefresh = null;
        if (buffering) {
          buffering = false;
          bufferedEvents = [];
        }
      });
      return snapshotRefresh;
    };
    const scheduleReconnect = () => {
      if (disposed) return;
      const delay = Math.min(10_000, 500 * 2 ** retryAttempt++);
      retryTimer = window.setTimeout(() => {
        void refreshSnapshot().then((ready) => { if (ready) connect(); }).catch(scheduleReconnect);
      }, delay);
    };
    const connect = () => {
      const protocol = window.location.protocol === "https:" ? "wss" : "ws";
      socket = new WebSocket(`${protocol}://${window.location.host}/api/events`);
      socket.onopen = () => {
        retryAttempt = 0;
        void refreshSnapshot().catch(() => socket?.close());
      };
      socket.onmessage = (message) => {
        const event = JSON.parse(message.data) as UiEvent;
        if (buffering) bufferedEvents.push(event);
        else applyEvent(event);
      };
      socket.onclose = () => {
        markDisconnected();
        scheduleReconnect();
      };
    };
    connect();
    return () => { disposed = true; if (retryTimer !== undefined) window.clearTimeout(retryTimer); socket?.close(); };
  }, [bootstrapReady, client, consume, initialize, markDisconnected]);
  useEffect(() => {
    const onFocus = () => { if (Date.now() - lastFocusScan.current < 60_000) return; lastFocusScan.current = Date.now(); for (const project of projects) void api(`/api/projects/${project.id}/rescan`, { method: "POST", body: JSON.stringify({ clientRequestId: newClientRequestId() }) }).then(() => client.invalidateQueries({ queryKey: ["sessions"] })); };
    window.addEventListener("focus", onFocus); return () => window.removeEventListener("focus", onFocus);
  }, [client, projects]);
  useLayoutEffect(() => {
    if (!sideThreadId && restoreMainComposerFocus.current) scheduleMainComposerFocus();
  }, [scheduleMainComposerFocus, sideThreadId]);
  useEffect(() => () => { for (const timer of focusTimers.current) window.clearTimeout(timer); }, []);

  const updatePreferences = useMutation({ mutationFn: (changes: Partial<Preferences>) => endpoints.preferences(changes), onSuccess: (updated) => client.setQueryData(["bootstrap"], bootstrapData ? { ...bootstrapData, preferences: updated } : bootstrapData) });
  const addProject = async () => {
    const picked = await api<{ path: string | null }>("/api/system/pick-directory", { method: "POST" });
    const root = picked.path ?? window.prompt("输入本地文件夹的绝对路径"); if (!root?.trim()) return;
    const project = await api<Project>("/api/projects", { method: "POST", body: JSON.stringify({ path: root.trim(), clientRequestId: newClientRequestId() }) });
    const updatedPreferences = await endpoints.preferences({ lastProjectId: project.id });
    client.setQueryData(["bootstrap"], bootstrapData ? { ...bootstrapData, preferences: updatedPreferences } : bootstrapData);
    await client.invalidateQueries({ queryKey: ["projects"] }); await client.invalidateQueries({ queryKey: ["sessions"] });
    const discovered = await api<SessionSummary[]>(`/api/sessions?projectId=${encodeURIComponent(project.id)}&sortDirection=desc&search=`);
    if (discovered[0]) navigate(`/sessions/${discovered[0].threadId}`);
  };
  const createSession = async (projectId?: string) => {
    const target = projectId ?? preferences?.lastProjectId ?? selected?.projectId ?? projects[0]?.id; if (!target) { await addProject(); return; }
    const result = await api<{ thread: { id: string } }>(`/api/projects/${target}/sessions`, { method: "POST", body: JSON.stringify({ clientRequestId: crypto.randomUUID() }) });
    await client.invalidateQueries({ queryKey: ["sessions"] }); navigate(`/sessions/${result.thread.id}`);
  };
  const reorder = async (sourceId: string, targetId: string) => {
    const ordered = [...projects]; const from = ordered.findIndex((p) => p.id === sourceId); const to = ordered.findIndex((p) => p.id === targetId); if (from < 0 || to < 0) return;
    const [moved] = ordered.splice(from, 1); if (!moved) return; ordered.splice(to, 0, moved);
    await Promise.all(ordered.map((project, index) => api(`/api/projects/${project.id}`, { method: "PATCH", body: JSON.stringify({ orderIndex: index, clientRequestId: newClientRequestId() }) }))); void client.invalidateQueries({ queryKey: ["projects"] });
  };
  const closeSide = async () => {
    if (!sideThreadId) return;
    restoreMainComposerFocus.current = true; focusOrigin.current = document.activeElement;
    setMobilePane("main");
    scheduleMainComposerFocus();
    try {
      await api(`/api/side-chats/${sideThreadId}`, { method: "DELETE", body: JSON.stringify({ clientRequestId: newClientRequestId() }) });
    } finally {
      scheduleMainComposerFocus();
    }
  };

  if (bootstrapQuery.isLoading) return <main className="app-loading"><SpinnerGap size={26} className="spinning" /><span>正在连接 Codex App Server</span></main>;
  if (bootstrapQuery.isError || !bootstrapData) return <main className="blocking-page"><div className="blocking-panel"><TerminalWindow size={32} /><h1>服务初始化失败</h1><p>{bootstrapQuery.error?.message}</p><button className="button primary" onClick={() => bootstrapQuery.refetch()}>重试</button></div></main>;
  if (!bootstrapData.authReady) return <AuthGate />;
  if (!projects.length) return <EmptyWorkspace onAdd={() => void addProject()} />;
  return <div className={`app-shell ${sidebarOpen ? "sidebar-open" : ""}`}><button className="mobile-sidebar-toggle" onClick={() => setSidebarOpen((open) => !open)} aria-label={sidebarOpen ? "关闭侧边栏" : "打开侧边栏"}>{sidebarOpen ? <X size={18} /> : <List size={19} />}</button><button className="sidebar-scrim" aria-label="关闭侧边栏" onClick={() => setSidebarOpen(false)} /><Sidebar projects={projects} sessions={sessions} activeThreadId={selectedThreadId} preferences={preferences!} search={search} onSearch={setSearch} onMode={(sidebarMode) => updatePreferences.mutate({ sidebarMode })} onSort={(sortDirection) => updatePreferences.mutate({ sortDirection })} onReorder={(source, target) => void reorder(source, target)} onOpen={(id) => { navigate(`/sessions/${id}`); setSidebarOpen(false); }} onNew={(id) => void createSession(id)} onAddProject={() => void addProject()} onRescan={(id) => void api(`/api/projects/${id}/rescan`, { method: "POST", body: JSON.stringify({ clientRequestId: newClientRequestId() }) }).then(() => client.invalidateQueries({ queryKey: ["sessions"] }))} onRevealProject={(id) => void api(`/api/projects/${id}/reveal`, { method: "POST", body: JSON.stringify({ clientRequestId: newClientRequestId() }) })} onRenameProject={setSettingsProject} onRemoveProject={(project) => { if (window.confirm(`从侧边栏移除 ${project.name}？目录和 Codex Session 不会被删除。`)) void api(`/api/projects/${project.id}`, { method: "DELETE", body: JSON.stringify({ clientRequestId: newClientRequestId() }) }).then(() => { void client.invalidateQueries({ queryKey: ["projects"] }); void client.invalidateQueries({ queryKey: ["sessions"] }); }); }} />
    <main ref={workspaceRef} className="workspace">
      <div className={`workspace-layout ${sideThreadId ? "with-side-chat" : ""} ${parallelWriteWarning ? "has-parallel-warning" : ""}`} style={sideThreadId ? { "--side-width": `${preferences?.sideChatWidth ?? 42}%` } as CSSProperties : undefined}>
        {sideThreadId && <div className="compact-workspace-header"><div className="mobile-pane-tabs"><button className={mobilePane === "main" ? "active" : ""} onClick={() => setMobilePane("main")}>Main Session</button><button className={mobilePane === "side" ? "active" : ""} onClick={() => setMobilePane("side")}>Side Chat</button></div>{parallelWriteWarning && <div className="compact-parallel-warning"><WarningCircle size={14} weight="fill" /><span>主 Session 和 Side Chat 可能同时修改同一工作区</span></div>}</div>}
        <div className={`main-pane ${mobilePane === "main" ? "mobile-active" : ""}`}>{selectedThreadId && selectedProject ? <SessionPane threadId={selectedThreadId} project={selectedProject} projects={projects} models={bootstrapData.models} fullAccessNoticeSeen={preferences?.fullAccessNoticeSeenProjects.includes(selectedProject.id) ?? false} onAcknowledgeFullAccess={() => updatePreferences.mutate({ fullAccessNoticeSeenProjects: [...new Set([...(preferences?.fullAccessNoticeSeenProjects ?? []), selectedProject.id])] })} onComposerReady={bindMainComposer} onOpenThread={(id) => navigate(`/sessions/${id}`)} onOpenSideChat={() => setMobilePane("side")} /> : <div className="no-selection"><TerminalWindow size={30} /><h2>{allSessionsQuery.isLoading ? "正在加载 Session" : "开始新的 Session"}</h2><p>{allSessionsQuery.isLoading ? "正在读取最近的工作。" : "当前 Project 还没有可打开的 Session。"}</p>{!allSessionsQuery.isLoading && <button className="button primary" onClick={() => void createSession()}>新建 Session</button>}</div>}</div>
        {sideThreadId && selectedProject && <><div className="resizable-divider" onPointerDown={(event) => { const startX = event.clientX; const startWidth = preferences?.sideChatWidth ?? 42; const workspaceWidth = workspaceRef.current?.getBoundingClientRect().width ?? window.innerWidth; const move = (moveEvent: PointerEvent) => { const next = resizedSideChatWidth(startWidth, startX - moveEvent.clientX, workspaceWidth); workspaceRef.current?.style.setProperty("--live-side-width", `${next}%`); }; const finish = (finishEvent: PointerEvent) => { const next = resizedSideChatWidth(startWidth, startX - finishEvent.clientX, workspaceWidth); workspaceRef.current?.style.removeProperty("--live-side-width"); updatePreferences.mutate({ sideChatWidth: next }); window.removeEventListener("pointermove", move); window.removeEventListener("pointerup", finish); window.removeEventListener("pointercancel", finish); }; window.addEventListener("pointermove", move); window.addEventListener("pointerup", finish); window.addEventListener("pointercancel", finish); }} /><div className={`side-pane ${mobilePane === "side" ? "mobile-active" : ""}`}><SessionPane threadId={sideThreadId} project={selectedProject} projects={projects} models={bootstrapData.models} sideChat parallelWriteWarning={parallelWriteWarning} onOpenThread={(id) => navigate(`/sessions/${id}`)} onOpenSideChat={() => undefined} onCloseSideChat={() => void closeSide()} /></div></>}
      </div>
    </main><ProjectSettingsDialog project={settingsProject} models={bootstrapData.models} onClose={() => setSettingsProject(null)} />
  </div>;
}
