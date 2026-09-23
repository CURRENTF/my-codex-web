import { useEffect, useId, useRef, useState } from "react";
import type { UserMessageTarget } from "../user-message-navigation";

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
  const previewId = useId();

  useEffect(() => {
    const scroller = rail.current?.parentElement?.querySelector<HTMLElement>(".timeline");
    const trackElement = track.current;
    const positionElement = position.current;
    if (!scroller || !trackElement || !positionElement) return;
    const update = () => {
      const scrollable = scroller.scrollHeight - scroller.clientHeight;
      scrollProgress.current = scrollable > 0 ? scroller.scrollTop / scrollable : 1;
      positionElement.style.transform = `translateY(${Math.max(0, trackElement.clientHeight - positionElement.offsetHeight) * scrollProgress.current}px)`;
    };
    scroller.addEventListener("scroll", update, { passive: true });
    const resizeObserver = new ResizeObserver(update);
    resizeObserver.observe(trackElement);
    update();
    return () => { scroller.removeEventListener("scroll", update); resizeObserver.disconnect(); };
  }, [virtual, targets.length]);

  if (!targets.length) return null;
  const lastIndex = targets.length - 1;
  const indexAt = (clientY: number) => {
    const bounds = track.current?.getBoundingClientRect();
    if (!bounds || !bounds.height) return 0;
    return Math.max(0, Math.min(lastIndex, Math.round(((clientY - bounds.top) / bounds.height) * lastIndex)));
  };
  const selected = previewIndex === null ? null : targets[previewIndex];
  const selectedPosition = lastIndex > 0 && previewIndex !== null ? previewIndex / lastIndex * 100 : 50;

  return <div className="user-message-rail" ref={rail}>
    <div className="user-message-rail-track" ref={track} aria-hidden="true">
      {targets.map((target, index) => <span key={`${target.key}-${index}`} className={`user-message-rail-tick ${index === previewIndex ? "selected" : ""}`} style={{ top: `${lastIndex > 0 ? index / lastIndex * 100 : 50}%` }} />)}
      <span className="user-message-rail-position" ref={position} />
    </div>
    <button type="button" className="user-message-rail-hit" aria-label={`我的消息导航，共 ${targets.length} 条${previewIndex !== null ? `，第 ${previewIndex + 1} 条` : ""}`} aria-description="上下方向键选择消息，回车跳转" aria-describedby={selected ? previewId : undefined}
      onPointerMove={(event) => setPreviewIndex(indexAt(event.clientY))}
      onPointerLeave={() => setPreviewIndex(null)}
      onFocus={() => setPreviewIndex(Math.round(scrollProgress.current * lastIndex))}
      onBlur={() => setPreviewIndex(null)}
      onKeyDown={(event) => {
        const current = previewIndex ?? Math.round(scrollProgress.current * lastIndex);
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
        const index = event.detail === 0 ? previewIndex ?? Math.round(scrollProgress.current * lastIndex) : indexAt(event.clientY);
        setPreviewIndex(index);
        onNavigate(targets[index]!);
      }} />
    {selected && <div className="user-message-rail-preview" id={previewId} role="tooltip" style={{ top: `clamp(54px, ${selectedPosition}%, calc(100% - 54px))` }}>
      <strong>我的消息 {previewIndex! + 1} / {targets.length}</strong>
      <p>{selected.preview}</p>
    </div>}
  </div>;
}
