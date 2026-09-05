/**
 * Motion, read from the tokens rather than spelled in a component
 * (AGENTS.md: "no static visual values, ever"; docs/ux-theme.md `--motion-*`).
 *
 * CSS transitions take the token directly — `duration-(--motion-morph)`. The
 * two places that cannot (a Web Animation needs a number, and the island's
 * maximize hop crosses a containing block so it cannot be a CSS transition)
 * read the same custom property here, so a person who changes the token in
 * Settings changes every motion in the app, including those two.
 */

export type MotionToken = "--motion-instant" | "--motion-fast" | "--motion-slow" | "--motion-morph";

const FALLBACK: Record<MotionToken, number> = {
  "--motion-instant": 75,
  "--motion-fast": 150,
  "--motion-slow": 200,
  "--motion-morph": 260,
};

/** Milliseconds for a motion token, as the document currently defines it. */
export function motionMs(token: MotionToken): number {
  if (typeof document === "undefined" || typeof getComputedStyle !== "function") return FALLBACK[token];
  const raw = getComputedStyle(document.documentElement).getPropertyValue(token).trim();
  if (raw.endsWith("ms")) {
    const ms = Number.parseFloat(raw);
    return Number.isFinite(ms) ? ms : FALLBACK[token];
  }
  if (raw.endsWith("s")) {
    const s = Number.parseFloat(raw);
    return Number.isFinite(s) ? s * 1000 : FALLBACK[token];
  }
  return FALLBACK[token];
}

/** The easing every morph uses, from the token. */
export function motionEase(): string {
  if (typeof document === "undefined" || typeof getComputedStyle !== "function") return "cubic-bezier(0.2, 0.8, 0.2, 1)";
  return getComputedStyle(document.documentElement).getPropertyValue("--motion-ease").trim() || "cubic-bezier(0.2, 0.8, 0.2, 1)";
}

export function prefersReducedMotion(): boolean {
  return typeof matchMedia === "function" && matchMedia("(prefers-reduced-motion: reduce)").matches;
}
