/**
 * Visual-viewport guards for the phone.
 *
 * `dvh`/`svh` ignore the on-screen keyboard, and `interactive-widget` is
 * Chromium-only, so layout that must respect the keyboard is driven from
 * `visualViewport` (`--kb`, in hooks/use-keyboard-inset.ts). Two active WebKit
 * bugs (322900, 323322) make that unreliable in an *installed* PWA: after the
 * first keyboard show the visual viewport can stay short, and the `resize`
 * event can fail to fire on the way back. This module re-measures at the
 * moments the bugs bite — `pageshow`, `visibilitychange`, focus moving in and
 * out of an input, orientation change — and publishes:
 *
 *   --vvh      the visual viewport height in px (use instead of 100dvh)
 *   --vv-top   the visual viewport's offset from the layout viewport
 *
 * It also nudges every other `visualViewport` listener by dispatching a
 * synthetic `resize`, so `--kb` follows without those hooks growing new
 * listeners of their own.
 */

export const VISUAL_HEIGHT_VAR = "--vvh";
export const VISUAL_TOP_VAR = "--vv-top";

export interface ViewportMetrics {
  height: number;
  offsetTop: number;
}

/** What the guard writes, for the given measurements. Pure. */
export function viewportVars(vv: ViewportMetrics | undefined, innerHeight: number): Record<string, string> {
  const height = Math.round(vv?.height ?? innerHeight);
  const top = Math.round(vv?.offsetTop ?? 0);
  return { [VISUAL_HEIGHT_VAR]: `${height}px`, [VISUAL_TOP_VAR]: `${top}px` };
}

/**
 * The keyboard animates for ~250ms on iOS and a single measurement lands
 * mid-flight; sample on a few frames spread over that window.
 */
export const SETTLE_DELAYS_MS: readonly number[] = [0, 80, 200, 400];

export function installViewportGuards(win: Window = window): () => void {
  const root = win.document.documentElement;
  const vv = win.visualViewport;
  let last = "";

  const measure = (): void => {
    const vars = viewportVars(vv ?? undefined, win.innerHeight);
    const key = `${vars[VISUAL_HEIGHT_VAR]}|${vars[VISUAL_TOP_VAR]}`;
    if (key === last) return;
    last = key;
    for (const [name, value] of Object.entries(vars)) root.style.setProperty(name, value);
  };

  const timers = new Set<ReturnType<typeof setTimeout>>();
  const settle = (): void => {
    for (const delay of SETTLE_DELAYS_MS) {
      const t = setTimeout(() => {
        timers.delete(t);
        measure();
        // Wake `--kb` and anything else listening to the visual viewport.
        vv?.dispatchEvent(new Event("resize"));
      }, delay);
      timers.add(t);
    }
  };

  const onVisible = (): void => {
    if (win.document.visibilityState === "visible") settle();
  };
  const onFocus = (event: FocusEvent): void => {
    const target = event.target;
    if (target instanceof HTMLElement && (target.matches("input, textarea, select, [contenteditable]") || target.isContentEditable)) settle();
  };

  vv?.addEventListener("resize", measure);
  vv?.addEventListener("scroll", measure);
  win.addEventListener("resize", measure);
  win.addEventListener("orientationchange", settle);
  win.addEventListener("pageshow", settle);
  win.document.addEventListener("visibilitychange", onVisible);
  win.document.addEventListener("focusin", onFocus);
  win.document.addEventListener("focusout", onFocus);
  measure();

  return () => {
    for (const t of timers) clearTimeout(t);
    vv?.removeEventListener("resize", measure);
    vv?.removeEventListener("scroll", measure);
    win.removeEventListener("resize", measure);
    win.removeEventListener("orientationchange", settle);
    win.removeEventListener("pageshow", settle);
    win.document.removeEventListener("visibilitychange", onVisible);
    win.document.removeEventListener("focusin", onFocus);
    win.document.removeEventListener("focusout", onFocus);
  };
}
