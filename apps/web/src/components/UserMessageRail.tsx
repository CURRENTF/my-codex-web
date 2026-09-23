import { useEffect, useId, useMemo, useRef, useState } from "react";
import { userMessageIndexAtProgress, visibleUserMessageIndices, type UserMessageTarget } from "../user-message-navigation";

export function UserMessageRail({ targets, virtual, onNavigate }: {
  targets: UserMessageTarget[];
  virtual: boolean;
  onNavigate(target: UserMessageTarget): void;
}) {
  const rail = useRef<HTMLDivElement>(null);
  const track = useRef<HTMLDivElement>(null);
  const position = useRef<HTMLSpanElement>(null);
  const scrollProgress = useRef(1);
  const [previewIndex, setPreviewIndex] = useState<number | null>(null);
  const [focusIndex, setFocusIndex] = useState(Math.max(0, targets.length - 1));
  const previewId = useId();
  const targetKeys = targets.map((target) => target.key).join("\u0000");
  const currentFocus = Math.max(0, Math.min(targets.length - 1, focusIndex));
  const visibleIndices = useMemo(() => visibleUserMessageIndices(targets.length, currentFocus), [targets.length, currentFocus]);

  useEffect(() => { setPreviewIndex(null); }, [targetKeys]);

  useEffect(() => {
    const scroller = rail.current?.parentElement?.querySelector<HTMLElement>(".timeline");
    const trackElement = track.current;
    const positionElement = position.current;
    if (!scroller || !trackElement || !positionElement) return;
    const targetIndex = new Map(targets.map((target, index) => [target.key, index]));
    let frame = 0;
    const update = () => {
      const scrollable = scroller.scrollHeight - scroller.clientHeight;
      scrollProgress.current = scrollable > 0 ? Math.max(0, Math.min(1, scroller.scrollTop / scrollable)) : 1;
      positionElement.style.transform = `translateY(${Math.max(0, trackElement.clientHeight - positionElement.offsetHeight) * scrollProgress.current}px)`;
      const bounds = scroller.getBoundingClientRect();
      const readingLine = bounds.top + bounds.height * .4;
      let nearestIndex: number | null = null;
      let nearestDistance = Infinity;
      for (const message of scroller.querySelectorAll<HTMLElement>("[data-user-message-id]")) {
        const index = targetIndex.get(message.dataset.userMessageId ?? "");
        if (index === undefined) continue;
        const rect = message.getBoundingClientRect();
        const distance = rect.bottom < readingLine ? readingLine - rect.bottom : rect.top > readingLine ? rect.top - readingLine : 0;
        if (distance < nearestDistance) { nearestDistance = distance; nearestIndex = index; }
      }
      const focus = scroller.scrollTop <= 2 ? 0 : scrollable - scroller.scrollTop <= 2 ? targets.length - 1 : nearestIndex ?? userMessageIndexAtProgress(targets.length, scrollProgress.current);
      setFocusIndex((previous) => previous === focus ? previous : focus);
    };
    const schedule = () => { if (!frame) frame = requestAnimationFrame(() => { frame = 0; update(); }); };
    scroller.addEventListener("scroll", schedule, { passive: true });
    const resizeObserver = new ResizeObserver(schedule);
    resizeObserver.observe(trackElement);
    resizeObserver.observe(scroller);
    const mutationObserver = new MutationObserver(schedule);
    mutationObserver.observe(scroller, { childList: true, subtree: true });
    schedule();
    return () => { scroller.removeEventListener("scroll", schedule); resizeObserver.disconnect(); mutationObserver.disconnect(); cancelAnimationFrame(frame); };
  }, [virtual, targetKeys]);

  if (!targets.length) return null;
  const lastIndex = targets.length - 1;
  const indexAt = (clientY: number) => {
    const bounds = track.current?.getBoundingClientRect();
    if (!bounds || !bounds.height) return 0;
    return userMessageIndexAtProgress(targets.length, (clientY - bounds.top) / bounds.height);
  };
  const activePreviewIndex = previewIndex === null ? null : Math.max(0, Math.min(lastIndex, previewIndex));
  const selected = activePreviewIndex === null ? null : targets[activePreviewIndex];
  const selectedPosition = lastIndex > 0 && activePreviewIndex !== null ? activePreviewIndex / lastIndex * 100 : 50;

  return <div className="user-message-rail" ref={rail}>
    <div className="user-message-rail-track" ref={track} aria-hidden="true">
      {visibleIndices.map((index) => <span key={targets[index]!.key} className={`user-message-rail-tick ${index === activePreviewIndex ? "selected" : ""}`} style={{ top: `${lastIndex > 0 ? index / lastIndex * 100 : 50}%` }} />)}
      <span className="user-message-rail-position" ref={position} />
    </div>
    <button type="button" className="user-message-rail-hit" aria-label={`我的消息导航，共 ${targets.length} 条${activePreviewIndex !== null ? `，第 ${activePreviewIndex + 1} 条` : ""}`} aria-description="上下方向键选择消息，回车跳转" aria-describedby={selected ? previewId : undefined}
      onPointerMove={(event) => setPreviewIndex(indexAt(event.clientY))}
      onPointerLeave={() => setPreviewIndex(null)}
      onFocus={() => setPreviewIndex(currentFocus)}
      onBlur={() => setPreviewIndex(null)}
      onKeyDown={(event) => {
        const current = activePreviewIndex ?? currentFocus;
        let next = current;
        if (event.key === "ArrowUp") next = Math.max(0, current - 1);
        else if (event.key === "ArrowDown") next = Math.min(lastIndex, current + 1);
        else if (event.key === "Home") next = 0;
        else if (event.key === "End") next = lastIndex;
        else return;
        event.preventDefault();
        setPreviewIndex(next);
      }}
      onClick={(event) => {
        const index = event.detail === 0 ? activePreviewIndex ?? currentFocus : indexAt(event.clientY);
        setPreviewIndex(index);
        onNavigate(targets[index]!);
      }} />
    {selected && <div className="user-message-rail-preview" id={previewId} role="tooltip" style={{ top: `clamp(54px, ${selectedPosition}%, calc(100% - 54px))` }}>
      <strong>我的消息 {activePreviewIndex! + 1} / {targets.length}</strong>
      <p>{selected.preview}</p>
    </div>}
  </div>;
}
