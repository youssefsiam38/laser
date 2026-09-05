import { useSyncExternalStore } from "react";

/** DESIGN.md breakpoints: mobile < 768, tablet 768–1023, desktop >= 1024, wide >= 1280. */
export const BREAKPOINTS = {
  tablet: 768,
  desktop: 1024,
  wide: 1280,
} as const;

export type Breakpoint = "mobile" | "tablet" | "desktop";

const queryCache = new Map<string, MediaQueryList>();
function mql(query: string): MediaQueryList | null {
  if (typeof window === "undefined" || typeof window.matchMedia !== "function") return null;
  let m = queryCache.get(query);
  if (!m) {
    m = window.matchMedia(query);
    queryCache.set(query, m);
  }
  return m;
}

/** Reactive `matchMedia`. False during SSR / when matchMedia is missing. */
export function useMediaQuery(query: string): boolean {
  return useSyncExternalStore(
    (cb) => {
      const m = mql(query);
      if (!m) return () => {};
      m.addEventListener("change", cb);
      return () => m.removeEventListener("change", cb);
    },
    () => mql(query)?.matches ?? false,
    () => false,
  );
}

/** Viewport narrower than 768px: thread only, sheets for everything else. */
export function useIsMobile(): boolean {
  return useMediaQuery(`(max-width: ${BREAKPOINTS.tablet - 1}px)`);
}

/** Viewport narrower than 1024px (mobile or tablet): rail + thread, sessions/telemetry as sheets. */
export function useIsCompact(): boolean {
  return useMediaQuery(`(max-width: ${BREAKPOINTS.desktop - 1}px)`);
}

/** Viewport 768–1023px. */
export function useIsTablet(): boolean {
  return useMediaQuery(
    `(min-width: ${BREAKPOINTS.tablet}px) and (max-width: ${BREAKPOINTS.desktop - 1}px)`,
  );
}

/** Viewport >= 1280px: telemetry rail visible by default. */
export function useIsWide(): boolean {
  return useMediaQuery(`(min-width: ${BREAKPOINTS.wide}px)`);
}

export function useBreakpoint(): Breakpoint {
  const mobile = useIsMobile();
  const compact = useIsCompact();
  if (mobile) return "mobile";
  if (compact) return "tablet";
  return "desktop";
}

/** Coarse pointer (touch): 16px inputs, larger hit targets. */
/**
 * True only for touch-primary devices with no fine pointer available.
 *
 * This is deliberately the same query assistant-ui's
 * `unstable_insertNewlineOnTouchEnter` uses. The composer's own key handler
 * runs before the primitive's, and it bows out on touch so plain Enter inserts
 * a newline. If the two queries disagreed — a tablet with a trackpad reports
 * `(pointer: coarse)` while `(any-pointer: fine)` is also true — our handler
 * would bow out, the primitive would submit anyway, and the steer / follow-up
 * run config chosen by `composerSendPlan` would be lost.
 */
export function useIsTouch(): boolean {
  return useMediaQuery("(pointer: coarse) and (not (any-pointer: fine))");
}
