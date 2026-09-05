import { useEffect, useSyncExternalStore } from "react";

export const KEYBOARD_INSET_VAR = "--kb";

/**
 * Pixels of the layout viewport covered by the on-screen keyboard.
 * DESIGN.md: `Math.max(0, docHeight - vv.height - vv.offsetTop)`, never `+`.
 * Values under `threshold` are treated as browser chrome jitter, not a keyboard.
 */
export function computeKeyboardInset(
  docHeight: number,
  vv: { height: number; offsetTop: number },
  threshold = 40,
): number {
  const inset = Math.max(0, docHeight - vv.height - vv.offsetTop);
  return inset < threshold ? 0 : Math.round(inset);
}

let current = 0;
const listeners = new Set<() => void>();
let wired = false;

function measure(): number {
  if (typeof window === "undefined" || !window.visualViewport) return 0;
  return computeKeyboardInset(document.documentElement.clientHeight, window.visualViewport);
}

function update(): void {
  const next = measure();
  if (next === current) return;
  current = next;
  document.documentElement.style.setProperty(KEYBOARD_INSET_VAR, `${next}px`);
  for (const l of listeners) l();
}

function wire(): void {
  if (wired || typeof window === "undefined" || !window.visualViewport) return;
  wired = true;
  const vv = window.visualViewport;
  vv.addEventListener("resize", update);
  vv.addEventListener("scroll", update);
  window.addEventListener("orientationchange", update);
  // Coming back from the background (iOS bfcache, or a tab switch) restores a
  // viewport that may no longer match what was measured before it left; both
  // events fire before the first paint of the restored page.
  window.addEventListener("pageshow", update);
  document.addEventListener("visibilitychange", update);
  update();
}

function subscribe(cb: () => void): () => void {
  wire();
  listeners.add(cb);
  return () => listeners.delete(cb);
}

/**
 * Drives `--kb` on <html> from `visualViewport` resize + scroll and returns the
 * inset in px. Mount once near the root; consumers use `pb-kb` / `bottom-kb`
 * utilities (`max(env(safe-area-inset-bottom), var(--kb))`).
 */
export function useKeyboardInset(): number {
  const inset = useSyncExternalStore(subscribe, () => current, () => 0);
  useEffect(() => {
    wire();
    // Body must never scroll while the keyboard is open; the thread viewport does.
    if (inset > 0) window.scrollTo(0, 0);
  }, [inset]);
  return inset;
}
