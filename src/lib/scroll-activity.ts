/**
 * Marks active scrolling on <html> so CSS can hold back work that cannot be seen
 * while content moves: the 300ms poster fade and the skeleton shimmer. Every
 * fading poster promotes a compositing layer and fires transition events, and a
 * fast first scroll revealed dozens at once — the largest source of double-vsync
 * frames the profiler attributed to Home. The attribute is removed shortly after
 * the last scroll, so the resting reveal is unchanged.
 */
const SCROLL_IDLE_MS = 160;
let timer: number | undefined;

export function isScrollActive(): boolean {
  return timer !== undefined;
}

export function noteScrollActivity(): void {
  if (typeof document === "undefined") return;
  const root = document.documentElement;
  if (!root.hasAttribute("data-scrolling")) root.setAttribute("data-scrolling", "");
  if (timer !== undefined) window.clearTimeout(timer);
  timer = window.setTimeout(() => {
    timer = undefined;
    root.removeAttribute("data-scrolling");
  }, SCROLL_IDLE_MS);
}
