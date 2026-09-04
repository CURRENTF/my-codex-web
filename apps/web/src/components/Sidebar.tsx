import { useEffect, useMemo, useRef, useState } from "react";
import { Archive, Bell, BellSlash, CaretDown, CaretRight, ClockCounterClockwise, DotsThreeCircle, Folder, FolderOpen, GitFork, MagnifyingGlass, Plus, PushPin, Target, WarningCircle, X } from "@phosphor-icons/react";
import * as DropdownMenu from "@radix-ui/react-dropdown-menu";
import type { CodeServerStatus, Preferences, Project, SessionSummary } from "@codex-web/shared-types";
import { codeServerFolderUrl } from "../code-server-url";
import { useAppStore } from "../store";
import { statusText } from "./StatusIcon";
import type { BrowserNotificationControlState } from "../browser-notifications";
import { SelfUpdateControl } from "./SelfUpdateControl";

export function relativeTime(timestamp: number, now = Date.now()): string {
  const seconds = Math.max(0, Math.floor((now - timestamp) / 1_000));
  if (seconds < 60) return "刚刚";
  const minutes = Math.floor(seconds / 60); if (minutes < 60) return `${minutes} 分钟前`;
  const hours = Math.floor(minutes / 60); if (hours < 24) return `${hours} 小时前`;
  const days = Math.floor(hours / 24); return days === 1 ? "昨天" : `${days} 天前`;
}

export const SESSION_SWIPE_ACTION_WIDTH = 132;

export function sessionSwipeIsRevealed(scrollLeft: number): boolean {
  return scrollLeft >= SESSION_SWIPE_ACTION_WIDTH / 2;
}

function SessionRow({ session, active, projectName, now, revealed, busy, onReveal, onOpen, onPin, onArchive }: {
  session: SessionSummary; active: boolean; projectName: string; now: number; revealed: boolean; busy: boolean;
  onReveal(threadId: string | null): void; onOpen(threadId: string): void; onPin(session: SessionSummary): void; onArchive(session: SessionSummary): void;
}) {
  const liveRuntime = useAppStore((state) => state.runtimes[session.threadId]);
  const connectionState = useAppStore((state) => state.connectionState);
  const runtimeState = connectionState === "connected" ? (liveRuntime?.state ?? session.runtimeState) : "disconnected";
  const track = useRef<HTMLDivElement>(null);
  const programmaticTarget = useRef<number | null>(null);
  const suppressClick = useRef(false);
  const archiveDisabled = busy || runtimeState === "running" || runtimeState === "waitingForInput" || runtimeState === "disconnected";
  useEffect(() => {
    const element = track.current;
    if (!element) return;
    const target = revealed ? SESSION_SWIPE_ACTION_WIDTH : 0;
    if (Math.abs(element.scrollLeft - target) > 1) {
      programmaticTarget.current = target;
      element.scrollTo({ left: target, behavior: "smooth" });
    }
  }, [revealed]);
  const settleScroll = () => {
    const scrollLeft = track.current?.scrollLeft ?? 0;
    suppressClick.current = false;
    if (programmaticTarget.current !== null && Math.abs(scrollLeft - programmaticTarget.current) <= 2) {
      programmaticTarget.current = null;
      return;
    }
    programmaticTarget.current = null;
    const isRevealed = sessionSwipeIsRevealed(scrollLeft);
    onReveal(isRevealed ? session.threadId : null);
  };
  const open = () => {
    if (suppressClick.current) return;
    if (revealed) { onReveal(null); return; }
    onOpen(session.threadId);
  };
  return <div className={`session-row-shell ${active ? "active" : ""} ${revealed ? "actions-revealed" : ""}`} data-thread-id={session.threadId} data-updated-at={session.updatedAt} data-pinned={session.pinned}>
    <div ref={track} className="session-swipe-track" onScroll={() => { suppressClick.current = true; }} onScrollEnd={settleScroll} onTouchStart={() => { programmaticTarget.current = null; if (!revealed) onReveal(null); }}>
      <div className="session-row-content">
        <div className="session-row-line">
          <button className="session-row" onClick={open}>
            <span className="session-copy"><span className="session-title">{session.title}</span><span className="session-meta">{projectName}<span aria-hidden>·</span>{relativeTime(session.updatedAt, now)}</span></span>
            <span className="session-signals">{session.pinned && <PushPin className="session-pinned-icon" size={13} weight="fill" aria-label="已置顶" />}{session.hasGoal && <Target size={13} weight="bold" />}{session.parentThreadId && <GitFork size={13} weight="bold" />}</span>
          </button>
          <DropdownMenu.Root><DropdownMenu.Trigger asChild><button type="button" className={`session-status-menu ${runtimeState}`} aria-label={`${session.title}：${statusText(runtimeState)}，更多操作`} title={`${statusText(runtimeState)} · 更多操作`}><DotsThreeCircle className={runtimeState === "running" ? "spinning" : undefined} size={20} weight="regular" aria-hidden /></button></DropdownMenu.Trigger><DropdownMenu.Portal><DropdownMenu.Content className="menu-content" sideOffset={4} align="end">
            <DropdownMenu.Item className="menu-item" disabled={busy} onSelect={() => onPin(session)}><PushPin size={14} weight={session.pinned ? "fill" : "regular"} />{session.pinned ? "取消置顶" : "置顶"}</DropdownMenu.Item>
            <DropdownMenu.Separator className="menu-separator" />
            <DropdownMenu.Item className="menu-item danger-item" disabled={archiveDisabled} onSelect={() => onArchive(session)}><Archive size={14} />归档</DropdownMenu.Item>
          </DropdownMenu.Content></DropdownMenu.Portal></DropdownMenu.Root>
        </div>
        {session.parentThreadId && <button className="fork-source-link" onClick={() => { if (suppressClick.current) return; if (revealed) onReveal(null); else onOpen(session.parentThreadId!); }}><GitFork size={11} /><span>从「{session.forkSourceTitle ?? "父 Session"}」{session.forkTurnNumber ? `第 ${session.forkTurnNumber} 轮` : ""}分叉</span></button>}
      </div>
      <div className="session-swipe-actions" aria-hidden={!revealed}>
        <button type="button" className="session-swipe-action pin" tabIndex={revealed ? 0 : -1} disabled={busy} aria-label={session.pinned ? `取消置顶 ${session.title}` : `置顶 ${session.title}`} onClick={() => onPin(session)}><PushPin size={17} weight={session.pinned ? "fill" : "bold"} /><span>{session.pinned ? "取消置顶" : "置顶"}</span></button>
        <button type="button" className="session-swipe-action archive" tabIndex={revealed ? 0 : -1} disabled={archiveDisabled} aria-label={`归档 ${session.title}`} onClick={() => onArchive(session)}><Archive size={17} /><span>归档</span></button>
      </div>
    </div>
  </div>;
}

export interface SidebarProps {
  projects: Project[]; sessions: SessionSummary[]; activeThreadId: string | null; preferences: Preferences; codeServer: CodeServerStatus; notificationState: BrowserNotificationControlState;
  search: string; onSearch(value: string): void; onMode(mode: Preferences["sidebarMode"]): void;
  onSort(direction: Preferences["sortDirection"]): void; onToggleNotifications(): void; onReorder(projectId: string, targetProjectId: string): void;
  onOpen(threadId: string): void; onNew(projectId?: string): void; onAddProject(): void;
  onRescan(projectId: string): void; onRenameProject(project: Project): void; onRemoveProject(project: Project): void;
  onPin(threadId: string, pinned: boolean): Promise<void>; onArchive(threadId: string): Promise<void>;
}

export function Sidebar(props: SidebarProps) {
  const [expanded, setExpanded] = useState<Record<string, boolean>>({});
  const [showAll, setShowAll] = useState<Record<string, boolean>>({});
  const [revealedThreadId, setRevealedThreadId] = useState<string | null>(null);
  const [busyThreadId, setBusyThreadId] = useState<string | null>(null);
  const [actionError, setActionError] = useState("");
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    const timer = window.setInterval(() => setNow(Date.now()), 30_000);
    return () => window.clearInterval(timer);
  }, []);
  useEffect(() => { setRevealedThreadId(null); }, [props.preferences.sidebarMode, props.search]);
  const runSessionAction = async (session: SessionSummary, action: "pin" | "archive") => {
    if (busyThreadId) return;
    setBusyThreadId(session.threadId);
    setActionError("");
    try {
      if (action === "pin") await props.onPin(session.threadId, !session.pinned);
      else await props.onArchive(session.threadId);
      setRevealedThreadId(null);
    } catch (error) {
      setActionError(error instanceof Error ? error.message : `${action === "pin" ? "置顶" : "归档"}失败，请重试。`);
    } finally {
      setBusyThreadId(null);
    }
  };
  const sessionRow = (session: SessionSummary, projectName: string) => <SessionRow key={session.threadId} session={session} active={session.threadId === props.activeThreadId} projectName={projectName} now={now} revealed={revealedThreadId === session.threadId} busy={busyThreadId === session.threadId} onReveal={setRevealedThreadId} onOpen={props.onOpen} onPin={(target) => void runSessionAction(target, "pin")} onArchive={(target) => void runSessionAction(target, "archive")} />;
  const projectNames = useMemo(() => Object.fromEntries(props.projects.map((p) => [p.id, p.name])), [props.projects]);
  const notificationLabel = props.notificationState === "enabled" ? "关闭 Session 完成通知"
    : props.notificationState === "blocked" ? "Chrome 已禁止此站点发送通知，请在网站设置中允许"
      : props.notificationState === "unsupported" ? "当前浏览器不支持系统通知" : "开启 Session 完成通知";
  return <aside className="sidebar">
    <div className="sidebar-top">
      <button className="new-session-button" aria-label="新建 Session" onClick={() => props.onNew()}><Plus size={17} weight="bold" />新建</button>
      <button className={`icon-button notification-button ${props.notificationState}`} aria-label={notificationLabel} title={notificationLabel} disabled={props.notificationState === "blocked" || props.notificationState === "unsupported"} onClick={props.onToggleNotifications}>{props.notificationState === "blocked" || props.notificationState === "unsupported" ? <BellSlash size={18} /> : <Bell size={18} weight={props.notificationState === "enabled" ? "fill" : "regular"} />}</button>
      <SelfUpdateControl />
      <button className="icon-button" aria-label="添加 Project" onClick={props.onAddProject}><FolderOpen size={18} /></button>
    </div>
    <label className="search-field"><MagnifyingGlass size={15} /><input value={props.search} onChange={(event) => props.onSearch(event.target.value)} placeholder="搜索 Session" aria-label="搜索 Session" />{props.search && <button onClick={() => props.onSearch("")} aria-label="清除搜索"><X size={13} /></button>}</label>
    <div className="sidebar-switch" role="tablist">
      <button className={props.preferences.sidebarMode === "recent" ? "active" : ""} onClick={() => props.onMode("recent")}><ClockCounterClockwise size={15} />最近</button>
      <button className={props.preferences.sidebarMode === "projects" ? "active" : ""} onClick={() => props.onMode("projects")}><Folder size={15} />项目</button>
    </div>
    {actionError && <div className="sidebar-action-error" role="alert"><WarningCircle size={14} weight="fill" /><span>{actionError}</span><button type="button" onClick={() => setActionError("")} aria-label="关闭操作错误"><X size={13} /></button></div>}
    <div className="sidebar-list">
      {props.preferences.sidebarMode === "recent" ? <>
        <div className="list-caption"><span>最近</span><button className="sort-button" onClick={() => props.onSort(props.preferences.sortDirection === "desc" ? "asc" : "desc")}>更新时间 {props.preferences.sortDirection === "desc" ? "↓" : "↑"}</button></div>
        {props.sessions.map((session) => sessionRow(session, projectNames[session.projectId] ?? "Other"))}
      </> : <>
        <div className="list-caption"><span>项目</span><button className="caption-action" onClick={props.onAddProject}><Plus size={14} /></button></div>
        {props.projects.map((project) => {
          const isExpanded = expanded[project.id] ?? true;
          const projectSessions = props.sessions.filter((session) => session.projectId === project.id);
          const visible = showAll[project.id] ? projectSessions : projectSessions.slice(0, 8);
          return <section className="project-group" key={project.id} draggable onDragStart={(event) => event.dataTransfer.setData("text/project-id", project.id)} onDragOver={(event) => event.preventDefault()} onDrop={(event) => { event.preventDefault(); const source = event.dataTransfer.getData("text/project-id"); if (source && source !== project.id) props.onReorder(source, project.id); }}>
            <div className="project-row">
              <button className={`project-toggle ${project.available ? "" : "unavailable"}`} onClick={() => setExpanded((state) => ({ ...state, [project.id]: !isExpanded }))}>{isExpanded ? <CaretDown size={14} /> : <CaretRight size={14} />}<span>{project.name}</span>{!project.available && <small>目录不可用</small>}</button>
              <button className="project-add" disabled={!project.available} onClick={() => props.onNew(project.id)} aria-label={`在 ${project.name} 新建 Session`}><Plus size={15} /></button>
              <DropdownMenu.Root><DropdownMenu.Trigger asChild><button className="project-more" aria-label={`${project.name} 更多操作`}>•••</button></DropdownMenu.Trigger><DropdownMenu.Portal><DropdownMenu.Content className="menu-content" sideOffset={5} align="end">
                <DropdownMenu.Item className="menu-item" disabled={!project.available} onSelect={() => props.onNew(project.id)}>新建 Session</DropdownMenu.Item>
                <DropdownMenu.Item className="menu-item" onSelect={() => props.onRescan(project.id)}>重新扫描</DropdownMenu.Item>
                {props.codeServer.state === "available" && props.codeServer.url && project.available
                  ? <DropdownMenu.Item asChild><a className="menu-item" href={codeServerFolderUrl(props.codeServer.url, project.canonicalPath)} target="_blank" rel="noreferrer" title="在 code-server 中打开">code</a></DropdownMenu.Item>
                  : <DropdownMenu.Item className="menu-item" disabled>{props.codeServer.state === "checking" ? "正在检查 code-server" : "code 不可用"}</DropdownMenu.Item>}
                <DropdownMenu.Item className="menu-item" onSelect={() => props.onRenameProject(project)}>修改显示名称</DropdownMenu.Item>
                <DropdownMenu.Separator className="menu-separator" />
                <DropdownMenu.Item className="menu-item danger-item" onSelect={() => props.onRemoveProject(project)}>从侧边栏移除</DropdownMenu.Item>
              </DropdownMenu.Content></DropdownMenu.Portal></DropdownMenu.Root>
            </div>
            {isExpanded && <div className="project-sessions">{visible.map((session) => sessionRow(session, project.name))}
              {!showAll[project.id] && projectSessions.length > 8 && <button className="show-more" onClick={() => setShowAll((state) => ({ ...state, [project.id]: true }))}>展开其余 {projectSessions.length - 8} 个</button>}
            </div>}
          </section>;
        })}
      </>}
      {!props.sessions.length && <div className="sidebar-empty"><Folder size={24} /><p>{props.projects.length ? "没有找到 Session" : "添加一个本地文件夹开始"}</p></div>}
    </div>
  </aside>;
}
