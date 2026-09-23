import { useEffect, useId, useMemo, useRef, useState } from "react";
import { userMessageIndexAtProgress, userMessageIndexAtReadingLine, visibleUserMessageIndices, type UserMessageTarget } from "../user-message-navigation";

export function UserMessageRail({ targets, virtual, onNavigate }: {
  targets: UserMessageTarget[];
  virtual: boolean;
  onNavigate(target: UserMessageTarget): void;
}) {
  const rail = useRef<HTMLDivElement>(null);
  const track = useRef<HTMLDivElement>(null);
  const position = useRef<HTMLSpanElement>(null);
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
      const bounds = scroller.getBoundingClientRect();
      const readingLine = bounds.top + 16;
      const anchors = [...scroller.querySelectorAll<HTMLElement>("[data-user-message-id]")].flatMap((message) => {
        const index = targetIndex.get(message.dataset.userMessageId ?? "");
        return index === undefined ? [] : [{ index, top: message.getBoundingClientRect().top }];
      });
      // Both the expanded marks and the indicator use message order, not pixel
      // scroll progress (which also changes as Virtuoso measures long turns).
      const focus = scroller.scrollTop <= 2 ? 0
        : scrollable - scroller.scrollTop <= 2 ? targets.length - 1
        : userMessageIndexAtReadingLine(anchors, readingLine);
      if (focus === null) return; // Keep the last reading position during virtual remounts.
      const progress = targets.length > 1 ? focus / (targets.length - 1) : .5;
      positionElement.style.transform = `translateY(${trackElement.clientHeight * progress}px) translateY(-50%)`;
      setFocusIndex((previous) => previous === focus ? previous : focus);
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
