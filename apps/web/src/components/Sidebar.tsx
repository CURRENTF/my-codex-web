import { useEffect, useMemo, useState } from "react";
import { CaretDown, CaretRight, ClockCounterClockwise, Folder, FolderOpen, GitFork, MagnifyingGlass, Plus, Target, X } from "@phosphor-icons/react";
import * as DropdownMenu from "@radix-ui/react-dropdown-menu";
import type { CodeServerStatus, Preferences, Project, SessionSummary } from "@codex-web/shared-types";
import { codeServerFolderUrl } from "../code-server-url";
import { useAppStore } from "../store";
import { StatusIcon } from "./StatusIcon";

export function relativeTime(timestamp: number, now = Date.now()): string {
  const seconds = Math.max(0, Math.floor((now - timestamp) / 1_000));
  if (seconds < 60) return "刚刚";
  const minutes = Math.floor(seconds / 60); if (minutes < 60) return `${minutes} 分钟前`;
  const hours = Math.floor(minutes / 60); if (hours < 24) return `${hours} 小时前`;
  const days = Math.floor(hours / 24); return days === 1 ? "昨天" : `${days} 天前`;
}

function SessionRow({ session, active, projectName, now, onOpen }: { session: SessionSummary; active: boolean; projectName: string; now: number; onOpen(threadId: string): void }) {
  const liveRuntime = useAppStore((state) => state.runtimes[session.threadId]);
  const connectionState = useAppStore((state) => state.connectionState);
  const runtimeState = connectionState === "connected" ? (liveRuntime?.state ?? session.runtimeState) : "disconnected";
  return <div className={`session-row-shell ${active ? "active" : ""}`} data-thread-id={session.threadId} data-updated-at={session.updatedAt}>
    <button className="session-row" onClick={() => onOpen(session.threadId)}>
      <span className="session-copy"><span className="session-title">{session.title}</span><span className="session-meta">{projectName}<span aria-hidden>·</span>{relativeTime(session.updatedAt, now)}</span></span>
      <span className="session-signals">{session.hasGoal && <Target size={13} weight="bold" />}{session.parentThreadId && <GitFork size={13} weight="bold" />}<StatusIcon state={runtimeState} /></span>
    </button>
    {session.parentThreadId && <button className="fork-source-link" onClick={() => onOpen(session.parentThreadId!)}><GitFork size={11} /><span>从「{session.forkSourceTitle ?? "父 Session"}」{session.forkTurnNumber ? `第 ${session.forkTurnNumber} 轮` : ""}分叉</span></button>}
  </div>;
}

export interface SidebarProps {
  projects: Project[]; sessions: SessionSummary[]; activeThreadId: string | null; preferences: Preferences; codeServer: CodeServerStatus;
  search: string; onSearch(value: string): void; onMode(mode: Preferences["sidebarMode"]): void;
  onSort(direction: Preferences["sortDirection"]): void; onReorder(projectId: string, targetProjectId: string): void;
  onOpen(threadId: string): void; onNew(projectId?: string): void; onAddProject(): void;
  onRescan(projectId: string): void; onRenameProject(project: Project): void; onRemoveProject(project: Project): void;
}

export function Sidebar(props: SidebarProps) {
  const [expanded, setExpanded] = useState<Record<string, boolean>>({});
  const [showAll, setShowAll] = useState<Record<string, boolean>>({});
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    const timer = window.setInterval(() => setNow(Date.now()), 30_000);
    return () => window.clearInterval(timer);
  }, []);
  const projectNames = useMemo(() => Object.fromEntries(props.projects.map((p) => [p.id, p.name])), [props.projects]);
  return <aside className="sidebar">
    <div className="sidebar-top">
      <button className="new-session-button" onClick={() => props.onNew()}><Plus size={17} weight="bold" />新建 Session</button>
      <button className="icon-button" aria-label="添加 Project" onClick={props.onAddProject}><FolderOpen size={18} /></button>
    </div>
    <label className="search-field"><MagnifyingGlass size={15} /><input value={props.search} onChange={(event) => props.onSearch(event.target.value)} placeholder="搜索 Session" aria-label="搜索 Session" />{props.search && <button onClick={() => props.onSearch("")} aria-label="清除搜索"><X size={13} /></button>}</label>
    <div className="sidebar-switch" role="tablist">
      <button className={props.preferences.sidebarMode === "recent" ? "active" : ""} onClick={() => props.onMode("recent")}><ClockCounterClockwise size={15} />最近</button>
      <button className={props.preferences.sidebarMode === "projects" ? "active" : ""} onClick={() => props.onMode("projects")}><Folder size={15} />项目</button>
    </div>
    <div className="sidebar-list">
      {props.preferences.sidebarMode === "recent" ? <>
        <div className="list-caption"><span>最近</span><button className="sort-button" onClick={() => props.onSort(props.preferences.sortDirection === "desc" ? "asc" : "desc")}>更新时间 {props.preferences.sortDirection === "desc" ? "↓" : "↑"}</button></div>
        {props.sessions.map((session) => <SessionRow key={session.threadId} session={session} active={session.threadId === props.activeThreadId} projectName={projectNames[session.projectId] ?? "Other"} now={now} onOpen={props.onOpen} />)}
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
                  ? <DropdownMenu.Item asChild><a className="menu-item" href={codeServerFolderUrl(props.codeServer.url, project.canonicalPath)} target="_blank" rel="noreferrer">在 code-server 中打开</a></DropdownMenu.Item>
                  : <DropdownMenu.Item className="menu-item" disabled>{props.codeServer.state === "checking" ? "正在检查 code-server" : "code-server 不可用"}</DropdownMenu.Item>}
                <DropdownMenu.Item className="menu-item" onSelect={() => props.onRenameProject(project)}>修改显示名称</DropdownMenu.Item>
                <DropdownMenu.Separator className="menu-separator" />
                <DropdownMenu.Item className="menu-item danger-item" onSelect={() => props.onRemoveProject(project)}>从侧边栏移除</DropdownMenu.Item>
              </DropdownMenu.Content></DropdownMenu.Portal></DropdownMenu.Root>
            </div>
            {isExpanded && <div className="project-sessions">{visible.map((session) => <SessionRow key={session.threadId} session={session} active={session.threadId === props.activeThreadId} projectName={project.name} now={now} onOpen={props.onOpen} />)}
              {!showAll[project.id] && projectSessions.length > 8 && <button className="show-more" onClick={() => setShowAll((state) => ({ ...state, [project.id]: true }))}>展开其余 {projectSessions.length - 8} 个</button>}
            </div>}
          </section>;
        })}
      </>}
      {!props.sessions.length && <div className="sidebar-empty"><Folder size={24} /><p>{props.projects.length ? "没有找到 Session" : "添加一个本地文件夹开始"}</p></div>}
    </div>
  </aside>;
}
