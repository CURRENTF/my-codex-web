import { useEffect, useMemo, useRef, useState, type CSSProperties } from "react";
import { FolderOpen, List, ShieldWarning, SpinnerGap, TerminalWindow, X } from "@phosphor-icons/react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useLocation, useNavigate } from "react-router-dom";
import type { Preferences, Project, SessionSummary, UiEvent } from "@codex-web/shared-types";
import { api, bootstrap, endpoints } from "./api";
import { queryClient } from "./main";
import { useAppStore } from "./store";
import { SessionPane } from "./components/SessionPane";
import { Sidebar } from "./components/Sidebar";

function threadIdFromPath(pathname: string): string | null { return /^\/sessions\/([^/]+)$/.exec(pathname)?.[1] ?? null; }

function AuthGate() {
  return <main className="blocking-page"><div className="blocking-panel"><div className="blocking-icon"><ShieldWarning size={28} weight="fill" /></div><h1>需要 Codex 登录</h1><p>Codex Web 使用隔离的 CODEX_HOME。请在终端完成一次登录，然后重新启动服务。</p><code>CODEX_HOME=~/.codex-web/codex-home codex login</code><p className="blocking-note">Web UI 不读取或保存凭证。</p></div></main>;
}

function EmptyWorkspace({ onAdd }: { onAdd(): void }) {
  return <main className="empty-workspace"><div className="empty-illustration"><FolderOpen size={34} /></div><h1>添加第一个 Project</h1><p>选择一个本地文件夹，Codex Web 会扫描隔离 CODEX_HOME 中与该路径匹配的 Session。</p><button className="button primary large" onClick={onAdd}><FolderOpen size={17} />选择文件夹</button></main>;
}

export function App() {
  const navigate = useNavigate(); const location = useLocation(); const client = useQueryClient();
  const selectedThreadId = threadIdFromPath(location.pathname); const [search, setSearch] = useState(""); const [mobilePane, setMobilePane] = useState<"main" | "side">("main"); const [sidebarOpen, setSidebarOpen] = useState(false);
  const initialized = useRef(false); const lastFocusScan = useRef(0);
  const bootstrapQuery = useQuery({ queryKey: ["bootstrap"], queryFn: bootstrap, staleTime: Infinity, retry: 2 });
  const bootstrapData = bootstrapQuery.data; const preferences = bootstrapData?.preferences;
  const projectsQuery = useQuery({ queryKey: ["projects"], queryFn: endpoints.projects, enabled: !!bootstrapData });
  const sessionsQuery = useQuery({ queryKey: ["sessions", search, preferences?.sortDirection], queryFn: () => endpoints.sessions(search, preferences?.sortDirection ?? "desc"), enabled: !!bootstrapData?.authReady });
  const consume = useAppStore((state) => state.consume); const initialize = useAppStore((state) => state.initialize); const sideChats = useAppStore((state) => state.sideChats);
  const projects = projectsQuery.data ?? bootstrapData?.projects ?? []; const sessions = sessionsQuery.data ?? [];
  const selected = sessions.find((session) => session.threadId === selectedThreadId); const selectedProject = projects.find((project) => project.id === selected?.projectId) ?? null;
  const sideChat = useMemo(() => Object.values(sideChats).find((item) => item.parentThreadId === selectedThreadId), [sideChats, selectedThreadId]);
  const [sideThreadId, setSideThreadId] = useState<string | null>(sideChat?.threadId ?? null);
  useEffect(() => { if (sideChat?.threadId) setSideThreadId(sideChat.threadId); }, [sideChat?.threadId]);

  useEffect(() => {
    if (!bootstrapData || initialized.current) return; initialized.current = true; initialize(bootstrapData.runtimeStates, bootstrapData.activeSideChats);
  }, [bootstrapData, initialize]);
  useEffect(() => {
    if (!bootstrapData) return;
    const protocol = window.location.protocol === "https:" ? "wss" : "ws"; const socket = new WebSocket(`${protocol}://${window.location.host}/api/events`);
    socket.onmessage = (message) => {
      const event = JSON.parse(message.data) as UiEvent; consume(event);
      if (["turn.completed", "item.upserted", "goal.updated", "goal.cleared"].includes(event.type) && event.threadId) void client.invalidateQueries({ queryKey: ["session", event.threadId] });
      if (event.type === "session.summary.updated" || event.type === "turn.completed" || event.type === "turn.started") void client.invalidateQueries({ queryKey: ["sessions"] });
    };
    return () => socket.close();
  }, [bootstrapData, client, consume]);
  useEffect(() => {
    const onFocus = () => { if (Date.now() - lastFocusScan.current < 60_000) return; lastFocusScan.current = Date.now(); for (const project of projects) void api(`/api/projects/${project.id}/rescan`, { method: "POST" }).then(() => client.invalidateQueries({ queryKey: ["sessions"] })); };
    window.addEventListener("focus", onFocus); return () => window.removeEventListener("focus", onFocus);
  }, [client, projects]);

  const updatePreferences = useMutation({ mutationFn: (changes: Partial<Preferences>) => endpoints.preferences(changes), onSuccess: (updated) => client.setQueryData(["bootstrap"], bootstrapData ? { ...bootstrapData, preferences: updated } : bootstrapData) });
  const addProject = async () => {
    const picked = await api<{ path: string | null }>("/api/system/pick-directory", { method: "POST" });
    const root = picked.path ?? window.prompt("输入本地文件夹的绝对路径"); if (!root?.trim()) return;
    const project = await api<Project>("/api/projects", { method: "POST", body: JSON.stringify({ path: root.trim() }) });
    await client.invalidateQueries({ queryKey: ["projects"] }); await client.invalidateQueries({ queryKey: ["sessions"] }); updatePreferences.mutate({ lastProjectId: project.id });
  };
  const createSession = async (projectId?: string) => {
    const target = projectId ?? preferences?.lastProjectId ?? selected?.projectId ?? projects[0]?.id; if (!target) { await addProject(); return; }
    const result = await api<{ thread: { id: string } }>(`/api/projects/${target}/sessions`, { method: "POST", body: JSON.stringify({ clientRequestId: crypto.randomUUID() }) });
    await client.invalidateQueries({ queryKey: ["sessions"] }); navigate(`/sessions/${result.thread.id}`);
  };
  const reorder = async (sourceId: string, targetId: string) => {
    const ordered = [...projects]; const from = ordered.findIndex((p) => p.id === sourceId); const to = ordered.findIndex((p) => p.id === targetId); if (from < 0 || to < 0) return;
    const [moved] = ordered.splice(from, 1); if (!moved) return; ordered.splice(to, 0, moved);
    await Promise.all(ordered.map((project, index) => api(`/api/projects/${project.id}`, { method: "PATCH", body: JSON.stringify({ orderIndex: index }) }))); void client.invalidateQueries({ queryKey: ["projects"] });
  };
  const closeSide = async () => { if (!sideThreadId) return; await api(`/api/side-chats/${sideThreadId}`, { method: "DELETE" }); setSideThreadId(null); setMobilePane("main"); };

  if (bootstrapQuery.isLoading) return <main className="app-loading"><SpinnerGap size={26} className="spinning" /><span>正在连接 Codex App Server</span></main>;
  if (bootstrapQuery.isError || !bootstrapData) return <main className="blocking-page"><div className="blocking-panel"><TerminalWindow size={32} /><h1>服务初始化失败</h1><p>{bootstrapQuery.error?.message}</p><button className="button primary" onClick={() => bootstrapQuery.refetch()}>重试</button></div></main>;
  if (!bootstrapData.authReady) return <AuthGate />;
  if (!projects.length) return <EmptyWorkspace onAdd={() => void addProject()} />;
  return <div className={`app-shell ${sidebarOpen ? "sidebar-open" : ""}`}><button className="mobile-sidebar-toggle" onClick={() => setSidebarOpen((open) => !open)} aria-label={sidebarOpen ? "关闭侧边栏" : "打开侧边栏"}>{sidebarOpen ? <X size={18} /> : <List size={19} />}</button><button className="sidebar-scrim" aria-label="关闭侧边栏" onClick={() => setSidebarOpen(false)} /><Sidebar projects={projects} sessions={sessions} activeThreadId={selectedThreadId} preferences={preferences!} search={search} onSearch={setSearch} onMode={(sidebarMode) => updatePreferences.mutate({ sidebarMode })} onSort={(sortDirection) => updatePreferences.mutate({ sortDirection })} onReorder={(source, target) => void reorder(source, target)} onOpen={(id) => { navigate(`/sessions/${id}`); setSidebarOpen(false); }} onNew={(id) => void createSession(id)} onAddProject={() => void addProject()} onRescan={(id) => void api(`/api/projects/${id}/rescan`, { method: "POST" }).then(() => client.invalidateQueries({ queryKey: ["sessions"] }))} onRenameProject={(project) => { const name = window.prompt("Project 显示名称", project.name); if (name?.trim()) void api(`/api/projects/${project.id}`, { method: "PATCH", body: JSON.stringify({ name: name.trim() }) }).then(() => client.invalidateQueries({ queryKey: ["projects"] })); }} onRemoveProject={(project) => { if (window.confirm(`从侧边栏移除 ${project.name}？目录和 Codex Session 不会被删除。`)) void api(`/api/projects/${project.id}`, { method: "DELETE" }).then(() => { void client.invalidateQueries({ queryKey: ["projects"] }); void client.invalidateQueries({ queryKey: ["sessions"] }); }); }} />
    <main className={`workspace ${sideThreadId ? "with-side-chat" : ""}`} style={sideThreadId ? { "--side-width": `${preferences?.sideChatWidth ?? 42}%` } as CSSProperties : undefined}>
      {sideThreadId && <div className="mobile-pane-tabs"><button className={mobilePane === "main" ? "active" : ""} onClick={() => setMobilePane("main")}>Main Session</button><button className={mobilePane === "side" ? "active" : ""} onClick={() => setMobilePane("side")}>Side Chat</button></div>}
      <div className={`main-pane ${mobilePane === "main" ? "mobile-active" : ""}`}>{selectedThreadId && selectedProject ? <SessionPane threadId={selectedThreadId} project={selectedProject} models={bootstrapData.models} onOpenThread={(id) => navigate(`/sessions/${id}`)} onOpenSideChat={(id) => { setSideThreadId(id); setMobilePane("side"); }} /> : <div className="no-selection"><TerminalWindow size={30} /><h2>选择一个 Session</h2><p>从左侧继续已有工作，或新建 Session。</p></div>}</div>
      {sideThreadId && selectedProject && <><div className="resizable-divider" onPointerDown={(event) => { const startX = event.clientX; const startWidth = preferences?.sideChatWidth ?? 42; const move = (moveEvent: PointerEvent) => { const delta = startX - moveEvent.clientX; const next = Math.min(65, Math.max(28, startWidth + delta / window.innerWidth * 100)); document.documentElement.style.setProperty("--live-side-width", `${next}%`); }; const up = (upEvent: PointerEvent) => { const delta = startX - upEvent.clientX; const next = Math.min(65, Math.max(28, startWidth + delta / window.innerWidth * 100)); document.documentElement.style.removeProperty("--live-side-width"); updatePreferences.mutate({ sideChatWidth: next }); window.removeEventListener("pointermove", move); window.removeEventListener("pointerup", up); }; window.addEventListener("pointermove", move); window.addEventListener("pointerup", up); }} /><div className={`side-pane ${mobilePane === "side" ? "mobile-active" : ""}`}><SessionPane threadId={sideThreadId} project={selectedProject} models={bootstrapData.models} sideChat onOpenThread={(id) => navigate(`/sessions/${id}`)} onOpenSideChat={() => undefined} onCloseSideChat={() => void closeSide()} /></div></>}
    </main>
  </div>;
}
