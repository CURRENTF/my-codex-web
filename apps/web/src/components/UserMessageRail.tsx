import { useEffect, useId, useMemo, useRef, useState, type CSSProperties } from "react";
import type { SessionSummary } from "@codex-web/shared-types";
import type { CodexTurn } from "../api";
import { forkPositionLabel, messageRailBranches } from "../fork-tree";
import { DEFAULT_USER_MESSAGE_TICKS, USER_MESSAGE_TICK_SPACING, userMessageIndexAtProgress, userMessageIndexAtReadingLine, userMessageTickCapacity, visibleUserMessageIndices, type UserMessageTarget } from "../user-message-navigation";

const EMPTY_SESSIONS: SessionSummary[] = [];

export function UserMessageRail({ targets, virtual, onNavigate, sessions = EMPTY_SESSIONS, threadId, turns, onOpenThread }: {
  sessions?: SessionSummary[]; threadId: string; turns: CodexTurn[]; onOpenThread?(id: string): void;
  targets: UserMessageTarget[];
  virtual: boolean;
  onNavigate(target: UserMessageTarget): void;
}) {
  const rail = useRef<HTMLDivElement>(null);
  const track = useRef<HTMLDivElement>(null);
  const [previewIndex, setPreviewIndex] = useState<number | null>(null);
  const [focusKey, setFocusKey] = useState<string | null>(targets.at(-1)?.key ?? null);
  const [capacity, setCapacity] = useState(DEFAULT_USER_MESSAGE_TICKS);
  const previewId = useId();
  const targetKeys = targets.map((target) => target.key).join("\u0000");
  const matchedFocus = targets.findIndex((target) => target.key === focusKey);
  const currentFocus = matchedFocus < 0 ? Math.max(0, targets.length - 1) : matchedFocus;
  const { branches, messageColumns, rowCount } = useMemo(() => messageRailBranches(sessions, threadId, turns, targets), [sessions, threadId, turns, targets]);
  const visibleIndices = useMemo(() => visibleUserMessageIndices(rowCount, currentFocus, capacity), [rowCount, currentFocus, capacity]);

  useEffect(() => { setPreviewIndex(null); }, [targetKeys]);

  useEffect(() => {
    const scroller = rail.current?.parentElement?.querySelector<HTMLElement>(".timeline") ?? rail.current?.parentElement;
    const trackElement = track.current;
    if (!scroller || !trackElement) return;
    const targetIndex = new Map(targets.map((target, index) => [target.key, index]));
    let frame = 0;
    const update = () => {
      const bounds = scroller.getBoundingClientRect();
      setCapacity(userMessageTickCapacity(bounds.height));
      const readingLine = bounds.top + 16;
      const anchors = [...scroller.querySelectorAll<HTMLElement>("[data-user-message-id]")].flatMap((message) => {
        const index = targetIndex.get(message.dataset.userMessageId ?? "");
        return index === undefined ? [] : [{ index, top: message.getBoundingClientRect().top }];
      });
      // Keep the same message anchor while virtualization revises total height.
      const focus = userMessageIndexAtReadingLine(anchors, readingLine);
      if (focus === null) return;
      setFocusKey(targets[focus]?.key ?? null);
    };
    const schedule = () => { if (!frame) frame = requestAnimationFrame(() => { frame = 0; update(); }); };
    scroller.addEventListener("scroll", schedule, { passive: true });
    const resizeObserver = new ResizeObserver(schedule);
    resizeObserver.observe(trackElement);
    resizeObserver.observe(scroller);
    const observeContent = () => {
      for (const child of scroller.children) resizeObserver.observe(child);
    };
    observeContent();
    const mutationObserver = new MutationObserver(() => { observeContent(); schedule(); });
    mutationObserver.observe(scroller, { childList: true, subtree: true });
    schedule();
    return () => { scroller.removeEventListener("scroll", schedule); resizeObserver.disconnect(); mutationObserver.disconnect(); cancelAnimationFrame(frame); };
  }, [virtual, targetKeys]);

  if (!rowCount) return null;
  const firstVisible = visibleIndices[0]!;
  const lastVisible = visibleIndices.at(-1)!;
  const localPosition = (index: number) => visibleIndices.length > 1 ? (index - firstVisible) / (visibleIndices.length - 1) * 100 : 50;
  const indexAt = (clientY: number) => {
    const bounds = track.current?.getBoundingClientRect();
    if (!bounds || !bounds.height) return currentFocus;
    return visibleIndices[userMessageIndexAtProgress(visibleIndices.length, (clientY - bounds.top) / bounds.height)]!;
  };
  const firstMessage = Math.min(firstVisible, targets.length - 1);
  const lastMessage = Math.min(lastVisible, targets.length - 1);
  const activePreviewIndex = !targets.length || previewIndex === null ? null : Math.max(firstMessage, Math.min(lastMessage, previewIndex));
  const selected = activePreviewIndex === null ? null : targets[activePreviewIndex];
  const selectedPosition = activePreviewIndex === null ? 50 : localPosition(activePreviewIndex);

  const messageIndices = visibleIndices.filter((index) => index < targets.length);
  const visibleBranches = branches.filter((branch) => branch.node.session && branch.node.id !== threadId
    && Math.max(branch.end, Math.max(branch.start, branch.sharedUntil) + .45) >= firstVisible
    && Math.max(branch.start, branch.sharedUntil) <= lastVisible);
  const junctions = branches.filter((branch) => branch.parentColumn !== null && branch.start >= firstVisible && branch.start <= lastVisible);
  const emptyColumn = branches.find((branch) => branch.node.id === threadId)?.column ?? 0;
  const columns = [...new Set([
    ...messageIndices.map((index) => messageColumns[index] ?? 0),
    ...visibleBranches.map((branch) => branch.column),
    ...junctions.flatMap((branch) => [branch.parentColumn!, branch.column]),
    ...(!targets.length ? [emptyColumn] : []),
  ])].sort((a, b) => a - b);
  const column = (original: number) => Math.max(0, columns.indexOf(original));
  const lastColumn = Math.max(0, columns.length - 1);
  const compactStep = Math.min(12, 96 / Math.max(1, lastColumn));
  const expandedStep = Math.min(36, 240 / Math.max(1, lastColumn));

  return <div className={`user-message-rail${branches.length ? " with-branches" : ""}`} ref={rail} style={{ "--rail-count": visibleIndices.length, "--rail-columns": lastColumn, "--rail-compact-step": `${compactStep}px`, "--rail-expanded-step": `${expandedStep}px`, "--rail-tick-spacing": `${USER_MESSAGE_TICK_SPACING}px` } as CSSProperties}>
    <div className="user-message-rail-track" ref={track} aria-hidden="true">
      {messageIndices.map((index) => {
        const distance = activePreviewIndex === null ? Infinity : Math.abs(index - activePreviewIndex);
        const scale = [1, .76, .54, .36][distance] ?? .22;
        return <span key={targets[index]!.key} className={`user-message-rail-tick${messageColumns[index] ? " branched" : ""}${branches.length && index === targets.length - 1 ? " leaf" : ""}${index === currentFocus ? " current" : ""}${distance === 0 ? " selected" : ""}`} style={{ "--rail-column": column(messageColumns[index] ?? 0), "--rail-scale": scale, top: `${localPosition(index)}%` } as CSSProperties} />;
      })}
      {!targets.length && branches.length > 0 && <span className="user-message-rail-tick branched leaf" style={{ "--rail-column": column(emptyColumn), "--rail-scale": .25, top: `${localPosition(0)}%` } as CSSProperties} />}
    </div>
    <button type="button" className="user-message-rail-hit" disabled={!targets.length} aria-label={`我的消息导航，显示第 ${firstMessage + 1} 至 ${lastMessage + 1} 条，共 ${targets.length} 条${activePreviewIndex !== null ? `，第 ${activePreviewIndex + 1} 条` : ""}`} aria-description="上下方向键选择消息，回车跳转" aria-describedby={selected ? previewId : undefined}
      onPointerMove={(event) => setPreviewIndex(indexAt(event.clientY))}
      onPointerLeave={() => setPreviewIndex(null)}
      onFocus={() => setPreviewIndex(currentFocus)}
      onBlur={() => setPreviewIndex(null)}
      onKeyDown={(event) => {
        if (event.key === "Escape") { event.preventDefault(); setPreviewIndex(null); return; }
        const current = activePreviewIndex ?? currentFocus;
        let next = current;
        if (event.key === "ArrowUp") next = Math.max(firstMessage, current - 1);
        else if (event.key === "ArrowDown") next = Math.min(lastMessage, current + 1);
        else if (event.key === "Home") next = firstMessage;
        else if (event.key === "End") next = lastMessage;
        else return;
        event.preventDefault();
        setPreviewIndex(next);
      }}
      onClick={(event) => {
        const index = Math.min(targets.length - 1, event.detail === 0 ? activePreviewIndex ?? currentFocus : indexAt(event.clientY));
        setPreviewIndex(index);
        onNavigate(targets[index]!);
      }} />
    {onOpenThread && visibleBranches.map((branch) => {
      const suffixStart = Math.max(branch.start, branch.sharedUntil);
      const tip = Math.max(branch.end, suffixStart + .45);
      const start = Math.max(firstVisible, suffixStart);
      const end = Math.min(lastVisible, tip);
      const top = localPosition(start);
      const bottom = localPosition(end);
      const ticks = branch.node.session!.turnCount === undefined ? [] : visibleIndices.filter((row) => row >= suffixStart && row <= branch.end && Math.abs(row - tip) > .4);
      return <button type="button" key={branch.node.id} className="user-message-rail-branch" aria-label={`切换到 ${branch.node.title}`}
        data-tooltip={`${branch.node.title}\n${forkPositionLabel(branch.node.session!)}`} style={{ "--rail-column": column(branch.column), top: `calc(8px + (100% - 16px) * ${top / 100})`, height: `calc((100% - 16px) * ${(bottom - top) / 100} + 16px)` } as CSSProperties}
        onPointerEnter={() => setPreviewIndex(null)} onFocus={() => setPreviewIndex(null)} onClick={() => onOpenThread(branch.node.id)}>
        {ticks.map((row) => <span className="user-message-rail-branch-tick" key={row} style={{ top: `${8 + (row - start) * USER_MESSAGE_TICK_SPACING}px` }} />)}
        {tip <= lastVisible && <span className="user-message-rail-branch-tick leaf" style={{ top: `calc(100% - 8px)` }} />}
      </button>;
    })}
    {junctions.map((branch) => <span key={`junction:${branch.node.id}`} className="user-message-rail-junction" aria-hidden="true" style={{ "--rail-column": column(branch.parentColumn!), "--rail-span": column(branch.column) - column(branch.parentColumn!), top: `calc(8px + (100% - 16px) * ${localPosition(branch.start) / 100})` } as CSSProperties} />)}
    {selected && <div className="user-message-rail-preview" id={previewId} role="tooltip" style={{ top: `${selectedPosition}%` }}>
      <strong>{selected.preview}</strong>
      {selected.responsePreview && <p>{selected.responsePreview}</p>}
    </div>}
  </div>;
}
