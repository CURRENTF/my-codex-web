import { useEffect, useMemo, useRef, useState } from "react";
import { GitFork } from "@phosphor-icons/react";
import * as Popover from "@radix-ui/react-popover";
import type { SessionSummary } from "@codex-web/shared-types";
import { forkPositionLabel, layoutForkTree, sessionForkTree, type ForkTreeEntry } from "../fork-tree";

function ForkDiagram({ entries, threadId, onOpen }: {
  entries: ForkTreeEntry[]; threadId: string; onOpen(id: string): void;
}) {
  const container = useRef<HTMLDivElement>(null);
  const height = Math.max(...entries.map((entry) => entry.end)) + 24;
  const width = Math.max(...entries.map((entry) => entry.depth)) * 24 + 240;
  useEffect(() => {
    container.current?.querySelector<HTMLElement>("[aria-current=page]")?.scrollIntoView({ block: "nearest", inline: "nearest" });
  }, [threadId]);
  return <div className="fork-diagram-scroll labeled" ref={container}>
    <nav className="fork-diagram" aria-label="对话分支树" style={{ width, height }} onKeyDown={(event) => {
      if (!["ArrowUp", "ArrowDown", "Home", "End"].includes(event.key)) return;
      const buttons = [...event.currentTarget.querySelectorAll<HTMLButtonElement>("button")].sort((a, b) => parseFloat(a.style.top) - parseFloat(b.style.top));
      const index = buttons.indexOf(document.activeElement as HTMLButtonElement);
      if (index < 0) return;
      event.preventDefault();
      const next = event.key === "Home" ? 0 : event.key === "End" ? buttons.length - 1 : Math.max(0, Math.min(buttons.length - 1, index + (event.key === "ArrowUp" ? -1 : 1)));
      buttons[next]?.focus();
    }}>
      <svg width={width} height={height} aria-hidden="true" className="fork-tree-lines">
        {entries.map(({ node, depth, start, end, parentDepth, activePath, activeEnd }) => {
          const x = 24 + depth * 24;
          const path = (tip: number) => parentDepth === null ? `M ${x} ${start} V ${tip}` : `M ${x - 24} ${start} H ${x - 10} Q ${x} ${start} ${x} ${start + 10} V ${tip}`;
          return <g key={node.id}><path d={path(end)} />{activePath && <path d={path(activeEnd)} className="active-path" />}</g>;
        })}
      </svg>
      {entries.map(({ node, depth, end }) => {
        const current = node.id === threadId;
        const position = node.session ? forkPositionLabel(node.session) : "原始对话不可用";
        return node.session ? <button key={node.id} type="button" className={`fork-tree-tip${current ? " current" : ""}`} style={{ left: 8 + depth * 24, top: end - 16 }}
          aria-label={`切换到 ${node.title}`} aria-current={current ? "page" : undefined}
          data-tooltip={`${node.title}\n${position}${current ? "\n当前 Session" : ""}`}
          onClick={() => { if (!current) onOpen(node.id); }}>
          <span className="fork-tree-tick" aria-hidden="true" />
          {<span className="fork-tree-label"><strong>{node.title}</strong><small>{position}{current ? "，当前" : ""}</small></span>}
        </button> : <span key={node.id} className="fork-tree-missing" style={{ left: 8 + depth * 24, top: end - 16 }} data-tooltip={`${node.title}\n原始对话不可用`}><span className="fork-tree-tick" />{<span className="fork-tree-label"><strong>{node.title}</strong><small>原始对话不可用</small></span>}</span>;
      })}
    </nav>
  </div>;
}

export function ForkTreeButton({ sessions, threadId, onOpen }: { sessions: SessionSummary[]; threadId: string; onOpen(id: string): void }) {
  const [open, setOpen] = useState(false);
  const tree = useMemo(() => sessionForkTree(sessions, threadId), [sessions, threadId]);
  const entries = useMemo(() => tree ? layoutForkTree(tree, threadId) : [], [tree, threadId]);
  if (!tree) return null;
  const count = entries.filter((entry) => entry.node.session).length;
  return <Popover.Root open={open} onOpenChange={setOpen}>
      <Popover.Trigger asChild><button className="header-button" aria-label="查看对话分支" data-tooltip="对话分支"><GitFork size={16} /></button></Popover.Trigger>
      <Popover.Portal><Popover.Content className="fork-tree-popover" side="bottom" align="end" sideOffset={8} collisionPadding={12} aria-label="对话分支">
        <header><GitFork size={15} /><strong>对话分支</strong><span>{count}</span></header>
        <ForkDiagram entries={entries} threadId={threadId} onOpen={(id) => { setOpen(false); onOpen(id); }} />
      </Popover.Content></Popover.Portal>
  </Popover.Root>;
}
