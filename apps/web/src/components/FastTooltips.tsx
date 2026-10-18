import { useEffect, useId, useLayoutEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";

export const TOOLTIP_DELAY_MS = 150;

// Delegate across the app and Radix portals without wrapping toolbar controls.
export function FastTooltips() {
  const [active, setActive] = useState<{ element: HTMLElement; text: string } | null>(null);
  const [position, setPosition] = useState({ left: 0, top: 0 });
  const tooltip = useRef<HTMLDivElement>(null);
  const id = useId();

  useEffect(() => {
    let timer: ReturnType<typeof setTimeout> | undefined;
    let current: HTMLElement | null = null;
    const candidate = (target: EventTarget | null) => {
      if (!(target instanceof Element)) return null;
      const element = target.closest<HTMLElement>("[data-tooltip], button[aria-label], a[aria-label]");
      if (!element) return null;
      const text = element.getAttribute("data-tooltip") || (!element.textContent?.trim() ? element.getAttribute("aria-label") : null);
      return text ? { element, text } : null;
    };
    const hide = () => { clearTimeout(timer); current = null; setActive(null); };
    const show = (next: NonNullable<ReturnType<typeof candidate>>, immediate: boolean) => {
      if (current === next.element && !immediate) return;
      hide(); current = next.element;
      const open = () => { if (next.element.isConnected) setActive(next); };
      if (immediate) open(); else timer = setTimeout(open, TOOLTIP_DELAY_MS);
    };
    const over = (event: PointerEvent) => {
      if (event.pointerType === "touch") return;
      const next = candidate(event.target);
      if (next) show(next, false); else hide();
    };
    const out = (event: PointerEvent) => { if (candidate(event.relatedTarget)?.element !== current) hide(); };
    const focus = (event: FocusEvent) => {
      const next = candidate(event.target);
      if (next && event.target instanceof Element && event.target.matches(":focus-visible")) show(next, true);
    };
    const key = (event: KeyboardEvent) => { if (event.key === "Escape") hide(); };
    document.addEventListener("pointerover", over);
    document.addEventListener("pointerout", out);
    document.addEventListener("pointerdown", hide, true);
    document.addEventListener("focusin", focus);
    document.addEventListener("focusout", hide);
    document.addEventListener("keydown", key, true);
    document.addEventListener("scroll", hide, true);
    window.addEventListener("resize", hide);
    window.addEventListener("blur", hide);
    return () => {
      clearTimeout(timer);
      document.removeEventListener("pointerover", over);
      document.removeEventListener("pointerout", out);
      document.removeEventListener("pointerdown", hide, true);
      document.removeEventListener("focusin", focus);
      document.removeEventListener("focusout", hide);
      document.removeEventListener("keydown", key, true);
      document.removeEventListener("scroll", hide, true);
      window.removeEventListener("resize", hide);
      window.removeEventListener("blur", hide);
    };
  }, []);

  useLayoutEffect(() => {
    if (!active || !tooltip.current) return;
    const anchor = active.element.getBoundingClientRect();
    const box = tooltip.current.getBoundingClientRect();
    const above = anchor.top - box.height - 8;
    setPosition({
      left: Math.max(8, Math.min(window.innerWidth - box.width - 8, anchor.left + (anchor.width - box.width) / 2)),
      top: Math.max(8, Math.min(window.innerHeight - box.height - 8, above >= 8 ? above : anchor.bottom + 8)),
    });
    const descriptions = (active.element.getAttribute("aria-describedby") ?? "").split(/\s+/).filter(Boolean);
    active.element.setAttribute("aria-describedby", [...descriptions, id].join(" "));
    return () => {
      const remaining = (active.element.getAttribute("aria-describedby") ?? "").split(/\s+/).filter((value) => value && value !== id);
      if (remaining.length) active.element.setAttribute("aria-describedby", remaining.join(" "));
      else active.element.removeAttribute("aria-describedby");
    };
  }, [active, id]);

  return active ? createPortal(<div ref={tooltip} id={id} role="tooltip" className="fast-tooltip" style={position}>{active.text}</div>, document.body) : null;
}
