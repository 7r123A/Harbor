import { useEffect, type RefObject } from "react";

const EASE_MS = 55;
const MULTIPLIER = 1;
const SETTLE_PX = 0.5;

const overflowYCache = new WeakMap<Element, string>();

function scrollableAncestorBefore(from: EventTarget | null, stop: HTMLElement): boolean {
  let node = from instanceof HTMLElement ? from : null;
  while (node && node !== stop) {
    let oy = overflowYCache.get(node);
    if (oy === undefined) {
      oy = getComputedStyle(node).overflowY;
      overflowYCache.set(node, oy);
    }
    if ((oy === "auto" || oy === "scroll") && node.scrollHeight > node.clientHeight + 1)
      return true;
    node = node.parentElement;
  }
  return false;
}

export function useSmoothWheel(ref: RefObject<HTMLElement | null>, enabled: boolean): void {
  useEffect(() => {
    const el = ref.current;
    if (!el || !enabled) return;
    const reducedMotion = window.matchMedia("(prefers-reduced-motion: reduce)");

    // Keep our own position and scroll range. Reading scrollTop or scrollHeight in
    // a wheel or animation frame forces a synchronous layout of whatever the card
    // mount queue just committed, which is the duplicate layout that made Discover
    // miss frames while its rails revealed cards. The resize observer is the only
    // place that measures, and it runs after layout.
    let maxScroll = el.scrollHeight - el.clientHeight;
    let pos = el.scrollTop;
    let target = pos;
    let raf = 0;
    let lastFrame = 0;

    const measure = () => {
      maxScroll = el.scrollHeight - el.clientHeight;
      if (pos > maxScroll) pos = maxScroll;
    };
    const ro = new ResizeObserver(measure);
    ro.observe(el);
    if (el.firstElementChild) ro.observe(el.firstElementChild);

    const step = (time: number) => {
      const diff = target - pos;
      if (Math.abs(diff) < SETTLE_PX) {
        pos = target;
        el.scrollTop = target;
        raf = 0;
        return;
      }
      // Time-based easing stays consistent when moving between 60/120/144Hz screens.
      const elapsed = Math.max(0, time - lastFrame);
      lastFrame = time;
      const amount = 1 - Math.exp(-elapsed / EASE_MS);
      pos += diff * amount;
      el.scrollTop = pos;
      raf = requestAnimationFrame(step);
    };

    // An external scroll (scrollbar, keyboard, restored view position) is the only
    // thing that can move the element between our writes, and it is idle by
    // definition. Our own animated writes have raf set.
    const onScroll = () => {
      if (!raf) pos = el.scrollTop;
    };

    const onWheel = (e: WheelEvent) => {
      if (e.defaultPrevented || !e.cancelable || reducedMotion.matches) return;
      if (e.ctrlKey || e.metaKey || e.altKey || e.shiftKey) return;
      if (e.deltaMode !== 0) return;
      if (!Number.isFinite(e.deltaY) || e.deltaY === 0) return;
      if (Math.abs(e.deltaX) > Math.abs(e.deltaY)) return;
      if (maxScroll <= 0) return;
      if (scrollableAncestorBefore(e.target, el)) return;
      // Reversing the wheel should reverse motion immediately, not drain old momentum.
      const continuing = raf && Math.sign(target - pos) === Math.sign(e.deltaY);
      const next = Math.max(
        0,
        Math.min(maxScroll, (continuing ? target : pos) + e.deltaY * MULTIPLIER),
      );
      if (next === target && raf) {
        e.preventDefault();
        return;
      }
      target = next;
      if (target === pos && !raf) return;
      e.preventDefault();
      if (!raf) {
        lastFrame = performance.now();
        raf = requestAnimationFrame(step);
      }
    };

    const cancel = () => {
      if (raf) cancelAnimationFrame(raf);
      raf = 0;
    };

    el.addEventListener("wheel", onWheel, { passive: false });
    el.addEventListener("scroll", onScroll, { passive: true });
    el.addEventListener("pointerdown", cancel, { passive: true, capture: true });
    el.addEventListener("touchstart", cancel, { passive: true });
    window.addEventListener("keydown", cancel, { capture: true });
    reducedMotion.addEventListener("change", cancel);
    return () => {
      el.removeEventListener("wheel", onWheel);
      el.removeEventListener("scroll", onScroll);
      el.removeEventListener("pointerdown", cancel, true);
      el.removeEventListener("touchstart", cancel);
      window.removeEventListener("keydown", cancel, true);
      reducedMotion.removeEventListener("change", cancel);
      ro.disconnect();
      cancel();
    };
  }, [ref, enabled]);
}
