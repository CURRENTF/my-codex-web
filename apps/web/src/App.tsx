import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState, type CSSProperties, type FormEvent } from "react";
import { FolderOpen, List, LockKey, ShieldWarning, SpinnerGap, TerminalWindow, WarningCircle, X } from "@phosphor-icons/react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useLocation, useNavigate } from "react-router";
import type { Preferences, Project, SessionSummary, TurnUiEventPayload, UiEvent } from "@codex-web/shared-types";
import { api, authenticateWebUi, bootstrap, endpoints, isPasswordRequiredError, newClientRequestId, type SessionPayload } from "./api";
import { applySessionEvent } from "./live-session";
import { COMPOSER_FOCUS_RETRY_DELAYS, shouldRestoreComposerFocus } from "./composer-focus";
import { shouldWarnAboutParallelFullAccess } from "./parallel-write-warning";
import { resizedSideChatWidth } from "./side-chat-layout";
import { bootstrapGate } from "./bootstrap-gate";
import { shouldRunFocusRescan } from "./focus-rescan";
import { refreshProjectAvailability, refreshProjectAvailabilityAfterError } from "./project-refresh";
import { recentSessionToAutoOpen, sessionCreationProjectId } from "./session-selection";
import { browserNotificationControlState, currentBrowserNotificationPermission, persistTurnCompletionNotificationsEnabled, readTurnCompletionNotificationsEnabled, requestBrowserNotificationPermission, shouldNotifyTurnCompletion, showTurnCompletionNotification, type BrowserNotificationPermission } from "./browser-notifications";
import { playCompletionNotificationSound, preloadCompletionNotificationSound, unlockCompletionNotificationSound } from "./notification-sound";
import { queryClient } from "./main";
import { useAppStore } from "./store";
import { ProjectDirectoryDialog } from "./components/ProjectDirectoryDialog";
import { SessionPane } from "./components/SessionPane";
import { ProjectSettingsDialog } from "./components/ProjectSettingsDialog";
import { Sidebar } from "./components/Sidebar";

function threadIdFromPath(pathname: string): string | null { return /^\/sessions\/([^/]+)$/.exec(pathname)?.[1] ?? null; }

function AuthGate() {
  return <main className="blocking-page"><div className="blocking-panel"><div className="blocking-icon"><ShieldWarning size={28} weight="fill" /></div><h1>需要 Codex 登录</h1><p>请先在启动 Codex Web 所使用的 CODEX_HOME 中通过 CLI 完成登录，然后重新启动服务。</p><code>codex login</code><p className="blocking-note">Web UI 不读取或保存凭证。</p></div></main>;
}

function ConnectionGate() {
  return <main className="blocking-page"><div className="blocking-panel"><div className="blocking-icon"><WarningCircle size={28} weight="fill" /></div><h1>Codex App Server 连接中断</h1><p>本地服务正在尝试重新连接。恢复后刷新此页面；若持续失败，请检查服务日志和 Codex CLI。</p></div></main>;
}

function WebPasswordGate({ onAuthenticated }: { onAuthenticated(): Promise<void> }) {
  const [password, setPassword] = useState("");
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState("");
  const submit = async (event: FormEvent) => {
    event.preventDefault();
    if (!password || submitting) return;
    setSubmitting(true);
    setError("");
    try {
      await authenticateWebUi(password);
      setPassword("");
      await onAuthenticated();
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "登录失败，请重试。");
    } finally {
      setSubmitting(false);
    }
  };
  return <main className="blocking-page password-page">
    <form className="blocking-panel password-panel" onSubmit={(event) => void submit(event)}>
      <div className="blocking-icon password-icon"><LockKey size={27} weight="fill" /></div>
      <div className="password-heading"><span>CODEX WEB</span><h1>进入工作区</h1></div>
      <p>此服务可执行本机项目任务。请输入访问密码继续。</p>
      <label className="password-field">
        <span>访问密码</span>
        <input autoFocus type="password" autoComplete="current-password" value={password} onChange={(event) => setPassword(event.target.value)} placeholder="Password" />
      </label>
      {error && <p className="password-error" role="alert">{error}</p>}
      <button className="button primary password-submit" type="submit" disabled={!password || submitting}>
        {submitting ? <><SpinnerGap size={16} className="spinning" />正在验证</> : <>继续<LockKey size={15} /></>}
      </button>
      <p className="blocking-note">登录状态仅保存在当前浏览器的安全 Cookie 中。</p>
    </form>
  </main>;
}

function EmptyWorkspace({ onAdd }: { onAdd(): void }) {
  return <main className="empty-workspace"><div className="empty-illustration"><FolderOpen size={34} /></div><h1>添加第一个 Project</h1><p>选择一个本地文件夹，Codex Web 会扫描启动服务所使用的 CODEX_HOME 中与该路径匹配的 Session。</p><button className="button primary large" onClick={onAdd}><FolderOpen size={17} />选择文件夹</button></main>;
}

export function App() {
  const navigate = useNavigate(); const location = useLocation(); const client = useQueryClient();
  const selectedThreadId = threadIdFromPath(location.pathname); const [search, setSearch] = useState(""); const [mobilePane, setMobilePane] = useState<"main" | "side">("main"); const [sidebarOpen, setSidebarOpen] = useState(false); const [autoOpenSuppressed, setAutoOpenSuppressed] = useState(false);
  const [settingsProject, setSettingsProject] = useState<Project | null>(null);
  const [projectPickerOpen, setProjectPickerOpen] = useState(false);
  const [sideCloseError, setSideCloseError] = useState<string | null>(null);
  const [sessionCreateError, setSessionCreateError] = useState<string | null>(null);
  const [turnNotificationsEnabled, setTurnNotificationsEnabled] = useState(readTurnCompletionNotificationsEnabled);
  const [notificationPermission, setNotificationPermission] = useState<BrowserNotificationPermission>(currentBrowserNotificationPermission);
  const initialized = useRef(false); const lastFocusScan = useRef(0); const modalFocusSuppressed = useRef(false); const autoOpenSuppressedRef = useRef(false); const workspaceRef = useRef<HTMLElement>(null); const mainComposerRef = useRef<HTMLTextAreaElement>(null);
  const sessionCreationInFlight = useRef(false);
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
  const bootstrapQuery = useQuery({
    queryKey: ["bootstrap"],
    queryFn: bootstrap,
    staleTime: Infinity,
    retry: (failureCount, error) => !isPasswordRequiredError(error) && failureCount < 2,
  });
  const bootstrapData = bootstrapQuery.data; const preferences = bootstrapData?.preferences;
  const codeServerQuery = useQuery({
    queryKey: ["code-server-status"],
    queryFn: endpoints.codeServerStatus,
    enabled: !!bootstrapData?.authReady,
    initialData: bootstrapData?.codeServer,
    refetchInterval: 15_000,
    refetchIntervalInBackground: true,
    retry: false,
  });
  const codeServer = codeServerQuery.data ?? bootstrapData?.codeServer ?? { url: null, state: "unconfigured" as const, checkedAt: null };
  const projectsQuery = useQuery({ queryKey: ["projects"], queryFn: endpoints.projects, enabled: !!bootstrapData });
  const allSessionsQuery = useQuery({ queryKey: ["sessions", "", preferences?.sortDirection], queryFn: ({ signal }) => endpoints.sessions("", preferences?.sortDirection ?? "desc", signal), enabled: !!bootstrapData?.authReady });
  const filteredSessionsQuery = useQuery({ queryKey: ["sessions", search, preferences?.sortDirection], queryFn: ({ signal }) => endpoints.sessions(search, preferences?.sortDirection ?? "desc", signal), enabled: !!bootstrapData?.authReady && !!search.trim() });
  const consume = useAppStore((state) => state.consume); const initialize = useAppStore((state) => state.initialize); const markDisconnected = useAppStore((state) => state.markDisconnected); const sideChats = useAppStore((state) => state.sideChats);
  const projects = projectsQuery.data ?? bootstrapData?.projects ?? []; const allSessions = allSessionsQuery.data ?? []; const sessions = search.trim() ? (filteredSessionsQuery.data ?? []) : allSessions;
  const bootstrapReady = !!bootstrapData;
  const selected = allSessions.find((session) => session.threadId === selectedThreadId); const selectedProject = projects.find((project) => project.id === selected?.projectId) ?? null;
  const sideChat = useMemo(() => Object.values(sideChats).find((item) => item.parentThreadId === selectedThreadId), [sideChats, selectedThreadId]);
  const sideThreadId = sideChat?.threadId ?? null;
  const notificationContext = useRef({ activeThreadId: selectedThreadId, sessions: allSessions, enabled: turnNotificationsEnabled, permission: notificationPermission });
  notificationContext.current = { activeThreadId: selectedThreadId, sessions: allSessions, enabled: turnNotificationsEnabled, permission: notificationPermission };
  useEffect(() => setSideCloseError(null), [sideThreadId]);
  const mainRuntime = useAppStore((state) => selectedThreadId ? state.runtimes[selectedThreadId] : undefined);
  const sideRuntime = useAppStore((state) => sideThreadId ? state.runtimes[sideThreadId] : undefined);
  const mainSessionForWarning = useQuery({ queryKey: ["session", selectedThreadId], queryFn: ({ signal }) => endpoints.session(selectedThreadId!, signal), enabled: !!selectedThreadId && !!sideThreadId });
  const sideSessionForWarning = useQuery({ queryKey: ["session", sideThreadId], queryFn: ({ signal }) => endpoints.session(sideThreadId!, signal), enabled: !!sideThreadId, retry: false });
  const parallelWriteWarning = shouldWarnAboutParallelFullAccess(
    mainRuntime && mainSessionForWarning.data ? { state: mainRuntime.state, accessMode: mainSessionForWarning.data.settings.accessMode } : null,
    sideRuntime && sideSessionForWarning.data ? { state: sideRuntime.state, accessMode: sideSessionForWarning.data.settings.accessMode } : null,
  );

  useEffect(() => {
    if (!bootstrapData || initialized.current) return; initialized.current = true; initialize(bootstrapData.runtimeStates, bootstrapData.activeSideChats, bootstrapData.itemDeltas, bootstrapData.pendingRequests, bootstrapData.connection.state, bootstrapData.eventSeq, bootstrapData.sessionPrefills, bootstrapData.subagents);
  }, [bootstrapData, initialize]);
  useEffect(() => {
    if (!allSessionsQuery.isSuccess) return;
    const threadId = recentSessionToAutoOpen(selectedThreadId, allSessions, projects, preferences?.lastProjectId, autoOpenSuppressedRef.current || autoOpenSuppressed);
    if (threadId) navigate(`/sessions/${threadId}`, { replace: true });
  }, [allSessions, allSessionsQuery.isSuccess, autoOpenSuppressed, navigate, preferences?.lastProjectId, projects, selectedThreadId]);
  useEffect(() => {
    if (!bootstrapReady) return;
    let socket: WebSocket | null = null; let retryTimer: number | undefined; let retryAttempt = 0; let disposed = false; let snapshotRefresh: Promise<boolean> | null = null;
    let buffering = false; let bufferedEvents: UiEvent[] = [];
    const applyEvent = (event: UiEvent) => {
      if (event.seq <= useAppStore.getState().lastEventSeq) return;
      const liveDeltas = useAppStore.getState().deltas;
      const eventConnectionState = event.type === "connection.changed" ? (event.payload as { state?: string }).state : undefined;
      if (eventConnectionState !== "connected") consume(event);
      if (eventConnectionState === "connected") void refreshSnapshot().catch(resetSocketAndReconnect);
      if (event.type === "session.summary.updated" && event.threadId) {
        const prefill = typeof event.payload === "object" && event.payload !== null && "prefill" in event.payload
          ? (event.payload as { prefill?: unknown }).prefill
          : undefined;
        if (typeof prefill === "string" && prefill) useAppStore.getState().restorePrefill(event.threadId, prefill);
      }
      if (event.type === "turn.completed" && event.threadId) {
        const turn = (event.payload as Partial<TurnUiEventPayload>).turn;
        const context = notificationContext.current;
        if (turn) {
          const input = {
            threadId: event.threadId,
            turnId: turn.id,
            status: turn.status,
            sessionTitle: context.sessions.find((session) => session.threadId === event.threadId)?.title ?? "Codex Session",
            activeThreadId: context.activeThreadId,
            documentVisible: document.visibilityState === "visible",
          };
          if (shouldNotifyTurnCompletion(input, context.enabled, context.permission)) {
            if (showTurnCompletionNotification(input, (threadId) => navigate(`/sessions/${threadId}`))) playCompletionNotificationSound();
          }
        }
      }
      if (["turn.started", "turn.completed", "turn.error", "item.upserted", "item.delta", "goal.updated", "goal.cleared", "session.settings.updated"].includes(event.type) && event.threadId) {
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
        await Promise.all([
          client.invalidateQueries({ queryKey: ["sessions"] }),
          client.invalidateQueries({ queryKey: ["session"] }),
        ]);
        if (disposed) return false;
        initialize(fresh.runtimeStates, fresh.activeSideChats, fresh.itemDeltas, fresh.pendingRequests, fresh.connection.state, fresh.eventSeq, fresh.sessionPrefills, fresh.subagents);
        const replay = bufferedEvents.filter((event) => event.seq > fresh.eventSeq).sort((left, right) => left.seq - right.seq);
        bufferedEvents = [];
        buffering = false;
        for (const event of replay) applyEvent(event);
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
    const closeCurrentSocket = () => {
      const current = socket;
      socket = null;
      if (!current) return;
      current.onopen = null;
      current.onmessage = null;
      current.onclose = null;
      current.onerror = null;
      current.close();
    };
    const scheduleReconnect = () => {
      if (disposed || retryTimer !== undefined) return;
      const delay = Math.min(10_000, 500 * 2 ** retryAttempt++);
      retryTimer = window.setTimeout(() => {
        retryTimer = undefined;
        void refreshSnapshot().then((ready) => { if (ready) connect(); }).catch(scheduleReconnect);
      }, delay);
    };
    const resetSocketAndReconnect = () => {
      closeCurrentSocket();
      markDisconnected();
      scheduleReconnect();
    };
    const connect = () => {
      if (socket && (socket.readyState === WebSocket.CONNECTING || socket.readyState === WebSocket.OPEN)) return;
      const protocol = window.location.protocol === "https:" ? "wss" : "ws";
      const nextSocket = new WebSocket(`${protocol}://${window.location.host}/api/events`);
      socket = nextSocket;
      nextSocket.onopen = () => {
        if (socket !== nextSocket) return;
        retryAttempt = 0;
        void refreshSnapshot().catch(resetSocketAndReconnect);
      };
      nextSocket.onmessage = (message) => {
        if (socket !== nextSocket) return;
        const event = JSON.parse(message.data) as UiEvent;
        if (buffering) bufferedEvents.push(event);
        else applyEvent(event);
      };
      nextSocket.onclose = () => {
        if (socket !== nextSocket) return;
        socket = null;
        markDisconnected();
        scheduleReconnect();
      };
    };
    connect();
    return () => { disposed = true; if (retryTimer !== undefined) window.clearTimeout(retryTimer); closeCurrentSocket(); };
  }, [bootstrapReady, client, consume, initialize, markDisconnected, navigate]);
  useEffect(() => {
    const refreshNotificationState = () => {
      setNotificationPermission(currentBrowserNotificationPermission());
      setTurnNotificationsEnabled(readTurnCompletionNotificationsEnabled());
    };
    window.addEventListener("focus", refreshNotificationState);
    window.addEventListener("storage", refreshNotificationState);
    return () => {
      window.removeEventListener("focus", refreshNotificationState);
      window.removeEventListener("storage", refreshNotificationState);
    };
  }, []);
  useEffect(() => {
    if (!turnNotificationsEnabled) return;
    preloadCompletionNotificationSound();
    const unlock = () => { unlockCompletionNotificationSound(); };
    window.addEventListener("pointerdown", unlock, { once: true });
    window.addEventListener("keydown", unlock, { once: true });
    return () => {
      window.removeEventListener("pointerdown", unlock);
      window.removeEventListener("keydown", unlock);
    };
  }, [turnNotificationsEnabled]);
  useEffect(() => {
    const onFocus = () => {
      const now = Date.now();
      if (!shouldRunFocusRescan({ now, lastScanAt: lastFocusScan.current, modalFocusSuppressed: modalFocusSuppressed.current })) return;
      lastFocusScan.current = now;
      void Promise.allSettled(projects.map((project) => api(`/api/projects/${project.id}/rescan`, {
        method: "POST",
        body: JSON.stringify({ clientRequestId: newClientRequestId() }),
      }))).then(() => Promise.all([
        client.invalidateQueries({ queryKey: ["projects"] }),
        client.invalidateQueries({ queryKey: ["sessions"] }),
      ]));
    };
    window.addEventListener("focus", onFocus); return () => window.removeEventListener("focus", onFocus);
  }, [client, projects]);
  useLayoutEffect(() => {
    if (!sideThreadId && restoreMainComposerFocus.current) scheduleMainComposerFocus();
  }, [scheduleMainComposerFocus, sideThreadId]);
  useEffect(() => () => { for (const timer of focusTimers.current) window.clearTimeout(timer); }, []);

  const updatePreferences = useMutation({ mutationFn: (changes: Partial<Preferences>) => endpoints.preferences(changes), onSuccess: (updated) => client.setQueryData(["bootstrap"], bootstrapData ? { ...bootstrapData, preferences: updated } : bootstrapData) });
  const notificationState = browserNotificationControlState(turnNotificationsEnabled, notificationPermission);
  const toggleTurnNotifications = async () => {
    if (notificationState === "unsupported" || notificationState === "blocked") return;
    if (notificationState === "enabled") {
      persistTurnCompletionNotificationsEnabled(false);
      setTurnNotificationsEnabled(false);
      return;
    }
    preloadCompletionNotificationSound();
    unlockCompletionNotificationSound();
    const permission = await requestBrowserNotificationPermission();
    setNotificationPermission(permission);
    if (permission !== "granted") return;
    persistTurnCompletionNotificationsEnabled(true);
    setTurnNotificationsEnabled(true);
    playCompletionNotificationSound();
  };
  const fullAccessNoticeSeen = selectedProject
    ? preferences?.fullAccessNoticeSeenProjects.includes(selectedProject.id) ?? false
    : true;
  const acknowledgeFullAccess = () => {
    if (!selectedProject) return;
    updatePreferences.mutate({
      fullAccessNoticeSeenProjects: [...new Set([...(preferences?.fullAccessNoticeSeenProjects ?? []), selectedProject.id])],
    });
  };
  const suppressAutoOpen = (suppressed: boolean) => { autoOpenSuppressedRef.current = suppressed; setAutoOpenSuppressed(suppressed); };
  const addProject = () => {
    setSessionCreateError(null);
    setProjectPickerOpen(true);
  };
  const addProjectAtPath = async (root: string) => {
    const project = await api<Project>("/api/projects", { method: "POST", body: JSON.stringify({ path: root.trim(), clientRequestId: newClientRequestId() }) });
    const updatedPreferences = await endpoints.preferences({ lastProjectId: project.id });
    client.setQueryData(["bootstrap"], bootstrapData ? { ...bootstrapData, preferences: updatedPreferences } : bootstrapData);
    await client.invalidateQueries({ queryKey: ["projects"] }); await client.invalidateQueries({ queryKey: ["sessions"] });
    const discovered = await api<SessionSummary[]>(`/api/sessions?projectId=${encodeURIComponent(project.id)}&sortDirection=desc&search=`);
    if (discovered[0]) navigate(`/sessions/${discovered[0].threadId}`);
    else navigate("/", { replace: true });
  };
  const createSession = async (projectId?: string) => {
    if (sessionCreationInFlight.current) return;
    sessionCreationInFlight.current = true;
    setSessionCreateError(null);
    try {
      const target = sessionCreationProjectId(projectId, selected?.projectId, preferences?.lastProjectId, projects); if (!target) { addProject(); return; }
      const result = await api<{ thread: { id: string } }>(`/api/projects/${target}/sessions`, { method: "POST", body: JSON.stringify({ clientRequestId: crypto.randomUUID() }) });
      await client.invalidateQueries({ queryKey: ["sessions"] }); navigate(`/sessions/${result.thread.id}`);
    } catch (error) {
      await refreshProjectAvailabilityAfterError(error, (queryKey) => client.invalidateQueries({ queryKey }));
      setSessionCreateError(error instanceof Error ? error.message : "新建 Session 失败，请检查当前 Session 列表后重试。");
    } finally {
      sessionCreationInFlight.current = false;
    }
  };
  const reorder = async (sourceId: string, targetId: string) => {
    const ordered = [...projects]; const from = ordered.findIndex((p) => p.id === sourceId); const to = ordered.findIndex((p) => p.id === targetId); if (from < 0 || to < 0) return;
    const [moved] = ordered.splice(from, 1); if (!moved) return; ordered.splice(to, 0, moved);
    await Promise.all(ordered.map((project, index) => api(`/api/projects/${project.id}`, { method: "PATCH", body: JSON.stringify({ orderIndex: index, clientRequestId: newClientRequestId() }) }))); void client.invalidateQueries({ queryKey: ["projects"] });
  };
  const removeProject = async (project: Project) => {
    modalFocusSuppressed.current = true;
    let confirmed: boolean;
    try {
      confirmed = window.confirm(`从侧边栏移除 ${project.name}？目录和 Codex Session 不会被删除。`);
    } finally {
      window.setTimeout(() => { modalFocusSuppressed.current = false; }, 0);
    }
    if (!confirmed) return;
    const removedSelectedProject = selected?.projectId === project.id;
    if (removedSelectedProject) {
      suppressAutoOpen(true);
      await Promise.all([
        selectedThreadId ? client.cancelQueries({ queryKey: ["session", selectedThreadId] }) : Promise.resolve(),
        client.cancelQueries({ queryKey: ["sessions"] }),
      ]);
      navigate("/", { replace: true });
    }
    try {
      await api(`/api/projects/${project.id}`, { method: "DELETE", body: JSON.stringify({ clientRequestId: newClientRequestId() }) });
      if (settingsProject?.id === project.id) setSettingsProject(null);
      await Promise.all([
        client.invalidateQueries({ queryKey: ["bootstrap"] }),
        client.invalidateQueries({ queryKey: ["projects"] }),
        client.invalidateQueries({ queryKey: ["sessions"] }),
      ]);
      if (removedSelectedProject && selectedThreadId) client.removeQueries({ queryKey: ["session", selectedThreadId] });
    } finally {
      if (removedSelectedProject) suppressAutoOpen(false);
    }
  };
  const handleArchived = async (threadId: string) => {
    suppressAutoOpen(true);
    try {
      await Promise.all([
        client.cancelQueries({ queryKey: ["session", threadId] }),
        client.cancelQueries({ queryKey: ["sessions"] }),
      ]);
      navigate("/", { replace: true });
      client.removeQueries({ queryKey: ["session", threadId] });
      await client.invalidateQueries({ queryKey: ["sessions"] });
    } finally {
      suppressAutoOpen(false);
    }
  };
  const closeSide = async () => {
    if (!sideThreadId) return;
    setSideCloseError(null);
    try {
      await api(`/api/side-chats/${sideThreadId}`, { method: "DELETE", body: JSON.stringify({ clientRequestId: newClientRequestId() }) });
      restoreMainComposerFocus.current = true; focusOrigin.current = document.activeElement;
      setMobilePane("main");
      scheduleMainComposerFocus();
    } catch (error) {
      setMobilePane("side");
      setSideCloseError(error instanceof Error ? error.message : "Side Chat 仍在运行，暂时无法安全关闭");
    }
  };

  if (bootstrapQuery.isLoading) return <main className="app-loading"><SpinnerGap size={26} className="spinning" /><span>正在连接 Codex App Server</span></main>;
  if (isPasswordRequiredError(bootstrapQuery.error)) return <WebPasswordGate onAuthenticated={async () => {
    const result = await bootstrapQuery.refetch();
    if (result.error) throw result.error;
  }} />;
  if (bootstrapQuery.isError || !bootstrapData) return <main className="blocking-page"><div className="blocking-panel"><TerminalWindow size={32} /><h1>服务初始化失败</h1><p>{bootstrapQuery.error?.message}</p><button className="button primary" onClick={() => bootstrapQuery.refetch()}>重试</button></div></main>;
  const gate = bootstrapGate(bootstrapData.connection.state, bootstrapData.authReady);
  if (gate === "disconnected") return <ConnectionGate />;
  if (gate === "authRequired") return <AuthGate />;
  if (!projects.length) return <><EmptyWorkspace onAdd={addProject} /><ProjectDirectoryDialog open={projectPickerOpen} onOpenChange={setProjectPickerOpen} onAdd={addProjectAtPath} /></>;
  return <div className={`app-shell ${sidebarOpen ? "sidebar-open" : ""}`}><button className="mobile-sidebar-toggle" onClick={() => setSidebarOpen((open) => !open)} aria-label={sidebarOpen ? "关闭侧边栏" : "打开侧边栏"}>{sidebarOpen ? <X size={18} /> : <List size={19} />}</button><button className="sidebar-scrim" aria-label="关闭侧边栏" onClick={() => setSidebarOpen(false)} /><Sidebar projects={projects} sessions={sessions} activeThreadId={selectedThreadId} preferences={preferences!} codeServer={codeServer} notificationState={notificationState} search={search} onSearch={setSearch} onMode={(sidebarMode) => updatePreferences.mutate({ sidebarMode })} onSort={(sortDirection) => updatePreferences.mutate({ sortDirection })} onToggleNotifications={() => void toggleTurnNotifications()} onReorder={(source, target) => void reorder(source, target)} onOpen={(id) => { navigate(`/sessions/${id}`); setSidebarOpen(false); }} onNew={(id) => void createSession(id)} onAddProject={() => void addProject()} onRescan={(id) => void api(`/api/projects/${id}/rescan`, { method: "POST", body: JSON.stringify({ clientRequestId: newClientRequestId() }) }).then(() => refreshProjectAvailability((queryKey) => client.invalidateQueries({ queryKey })))} onRenameProject={setSettingsProject} onRemoveProject={(project) => void removeProject(project)} />
    <main ref={workspaceRef} className="workspace">
      {(sessionCreateError || sideCloseError) && <div className="workspace-error-stack">
        {sessionCreateError && <div className="workspace-error"><WarningCircle size={15} weight="fill" /><span>{sessionCreateError}</span><button onClick={() => setSessionCreateError(null)} aria-label="关闭新建 Session 错误"><X size={14} /></button></div>}
        {sideCloseError && <div className="workspace-error"><WarningCircle size={15} weight="fill" /><span>{sideCloseError}</span><button onClick={() => setSideCloseError(null)} aria-label="关闭 Side Chat 错误"><X size={14} /></button></div>}
      </div>}
      <div className={`workspace-layout ${sideThreadId ? "with-side-chat" : ""} ${parallelWriteWarning ? "has-parallel-warning" : ""}`} style={sideThreadId ? { "--side-width": `${preferences?.sideChatWidth ?? 42}%` } as CSSProperties : undefined}>
        {sideThreadId && <div className="compact-workspace-header"><div className="mobile-pane-tabs"><button className={mobilePane === "main" ? "active" : ""} onClick={() => setMobilePane("main")}>Main Session</button><button className={mobilePane === "side" ? "active" : ""} onClick={() => setMobilePane("side")}>Side Chat</button></div>{parallelWriteWarning && <div className="compact-parallel-warning"><WarningCircle size={14} weight="fill" /><span>主 Session 和 Side Chat 可能同时修改同一工作区</span></div>}</div>}
        <div className={`main-pane ${mobilePane === "main" ? "mobile-active" : ""}`}>{selectedThreadId && selectedProject ? <SessionPane threadId={selectedThreadId} project={selectedProject} projects={projects} models={bootstrapData.models} codeServer={codeServer} linkedSideChatActive={sideRuntime?.state === "running" || sideRuntime?.state === "waitingForInput"} fullAccessNoticeSeen={fullAccessNoticeSeen} onAcknowledgeFullAccess={acknowledgeFullAccess} onComposerReady={bindMainComposer} onOpenThread={(id) => navigate(`/sessions/${id}`)} onOpenSideChat={() => setMobilePane("side")} onArchived={(id) => void handleArchived(id)} /> : <div className="no-selection"><div className="no-selection-mark" aria-hidden="true"><TerminalWindow size={28} weight="duotone" /></div><div className="no-selection-copy"><h2>{allSessionsQuery.isLoading ? "正在加载 Session" : "开始新的 Session"}</h2><p>{allSessionsQuery.isLoading ? "正在读取最近的工作。" : "当前 Project 还没有可打开的 Session。"}</p></div>{!allSessionsQuery.isLoading && <button className="button primary" onClick={() => void createSession()}>新建 Session</button>}</div>}</div>
        {sideThreadId && selectedProject && <><div className="resizable-divider" onPointerDown={(event) => { const startX = event.clientX; const startWidth = preferences?.sideChatWidth ?? 42; const workspaceWidth = workspaceRef.current?.getBoundingClientRect().width ?? window.innerWidth; const move = (moveEvent: PointerEvent) => { const next = resizedSideChatWidth(startWidth, startX - moveEvent.clientX, workspaceWidth); workspaceRef.current?.style.setProperty("--live-side-width", `${next}%`); }; const finish = (finishEvent: PointerEvent) => { const next = resizedSideChatWidth(startWidth, startX - finishEvent.clientX, workspaceWidth); workspaceRef.current?.style.removeProperty("--live-side-width"); updatePreferences.mutate({ sideChatWidth: next }); window.removeEventListener("pointermove", move); window.removeEventListener("pointerup", finish); window.removeEventListener("pointercancel", finish); }; window.addEventListener("pointermove", move); window.addEventListener("pointerup", finish); window.addEventListener("pointercancel", finish); }} /><div className={`side-pane ${mobilePane === "side" ? "mobile-active" : ""}`}><SessionPane threadId={sideThreadId} project={selectedProject} projects={projects} models={bootstrapData.models} codeServer={codeServer} sideChat parallelWriteWarning={parallelWriteWarning} fullAccessNoticeSeen={fullAccessNoticeSeen} onAcknowledgeFullAccess={acknowledgeFullAccess} onOpenThread={(id) => navigate(`/sessions/${id}`)} onOpenSideChat={() => undefined} onCloseSideChat={() => void closeSide()} /></div></>}
      </div>
    </main><ProjectSettingsDialog project={settingsProject} models={bootstrapData.models} onClose={() => setSettingsProject(null)} /><ProjectDirectoryDialog open={projectPickerOpen} onOpenChange={setProjectPickerOpen} onAdd={addProjectAtPath} />
  </div>;
}
