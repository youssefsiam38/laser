/**
 * Our type, inside Pierre's shadow roots.
 *
 * `@pierre/diffs` draws code in a font stack of its own
 * (`--diffs-font-fallback: "SF Mono", Monaco, …`) and its chrome in
 * `system-ui`. Neither font exists on most Linux machines, so the renderer
 * fell back to whatever the system offered — the "pixelated" diff. Our colours
 * already reach it (the Shiki theme is Laser's own, `var(--syntax-*)`); our
 * type did not.
 *
 * The library documents the way in: every value it paints with is read through
 * a custom property with a fallback — `var(--diffs-font-family, …)`,
 * `var(--diffs-font-size, 13px)`, `var(--diffs-line-height, 20px)`,
 * `var(--diffs-font-features)`, `var(--diffs-fg-number-override, …)`. Custom
 * properties inherit through a shadow boundary, so there are two ways to set
 * them and we use both, on purpose:
 *
 *  - {@link DIFF_HOST_VARS} on the light-DOM wrapper, so the *first* painted
 *    frame is already our face — no observer has to run first; and
 *  - one constructed stylesheet, {@link diffTypographySheet}, **appended** to
 *    each `diffs-container` root, which carries the things a variable cannot
 *    say: tabular numerals in the gutter, the separator's sans label, and a
 *    hit box and focus ring on the hunk expanders.
 *
 * The sheet is deliberately unlayered. Pierre's core CSS lives in
 * `@layer base`, and an unlayered declaration beats a layered one whatever the
 * specificity, so nothing here has to out-specify their selectors.
 *
 * The trap, from `docs/source-control-spike-evidence.md` §4: their constructor
 * assigns `adoptedStyleSheets = [coreSheet]`. Always **append**; replacing the
 * array takes their core CSS away and the diff stops painting entirely.
 *
 * Sizes are token arithmetic, never literals: `calc(var(--space-unit) * 8)` is
 * what Tailwind's `h-8` compiles to in this app, and `* 11` is `min-h-11`, the
 * coarse-pointer target. Colours are tokens. There is no px in this file.
 */
import type { CSSProperties } from "react";

/** Fine-pointer control box: the same arithmetic as the app's `h-8`. */
const CONTROL_BOX = "calc(var(--space-unit) * 8)";
/** Coarse-pointer target: the same arithmetic as the app's `min-h-11`. */
const TOUCH_BOX = "calc(var(--space-unit) * 11)";

/**
 * The variables Pierre reads, mapped onto our tokens. Set on the light-DOM
 * wrapper so they inherit into every shadow root under it, including roots
 * React has not created yet.
 */
export const DIFF_HOST_VARS: Record<string, string> = {
  "--diffs-font-family": "var(--font-mono)",
  "--diffs-header-font-family": "var(--font-sans)",
  "--diffs-font-size": "var(--text-code)",
  "--diffs-line-height": "var(--text-code--line-height)",
  /* Tabular figures for the gutter; `calt` off is what `globals.css` does to
     every `code`/`pre`, so ligatures never re-shape source text. */
  "--diffs-font-features": '"tnum" 1, "calt" 0',
  "--diffs-fg-number-override": "var(--ink-3)",
  "--diffs-tab-size": "2",
  "--diffs-gap-inline": "calc(var(--space-unit) * 2)",
  "--diffs-gap-block": "calc(var(--space-unit) * 2)",
  "--diffs-bg-override": "var(--surface)",
  "--diffs-fg-override": "var(--ink)",
};

export const DIFF_HOST_STYLE = DIFF_HOST_VARS as CSSProperties;

/**
 * The same mapping again on `:host`, plus what only a rule can say. Kept as
 * one string so a test can read it.
 */
export const DIFF_TYPOGRAPHY_CSS = `
:host {
  --diffs-font-family: var(--font-mono);
  --diffs-header-font-family: var(--font-sans);
  --diffs-font-size: var(--text-code);
  --diffs-line-height: var(--text-code--line-height);
  --diffs-font-features: "tnum" 1, "calt" 0;
  --diffs-fg-number-override: var(--ink-3);
  --diffs-tab-size: 2;
}

pre, code, [data-line] {
  font-family: var(--font-mono);
  font-size: var(--text-code);
  line-height: var(--text-code--line-height);
}

/* A line wraps rather than running off the side.

   Pierre draws every line as pre inside a horizontally scrolling column, so
   reading a long line meant scrolling one column while the other stayed put.
   pre-wrap keeps every space and indent exactly as the file has them and
   breaks only where the line already has a space; overflow-wrap and word-break
   stay normal on purpose, so a line with nowhere to break (a minified bundle,
   a base64 blob, a long URL) is not chopped mid-token but scrolls, which is
   the only honest thing to do with it. */
[data-content],
[data-line],
[data-line] span {
  white-space: pre-wrap;
  overflow-wrap: normal;
  word-break: normal;
}

/* The column still scrolls, for the line that genuinely cannot wrap. */
[data-code] {
  overflow-x: auto;
}

/* Digits that line up down the gutter, and a line number that reads as
   reference rather than content. */
[data-column-number],
[data-gutter-buffer],
[data-line-number-content] {
  font-variant-numeric: tabular-nums;
}

/* The hunk separator is chrome, not code: our sans face, the 12px floor,
   tertiary ink. */
[data-separator] [data-separator-content],
[data-separator] [data-unmodified-lines] {
  font-family: var(--font-sans);
  font-size: var(--text-xs);
  line-height: var(--leading-xs);
  font-variant-numeric: tabular-nums;
  color: var(--ink-3);
}

/* The expander is a real control, drawn the way every other disclosure in
   this app is drawn (activityDisclosure, in the adopted assistant-ui
   surfaces.tsx): a 32px box on a fine pointer and 44px on a coarse one, the
   md radius, tertiary ink that goes to full ink on hover over --surface-2,
   and the one focus ring the product uses. */
[data-separator="line-info"],
[data-separator="line-info-basic"],
[data-separator="metadata"] {
  height: ${CONTROL_BOX};
}

[data-expand-button] {
  min-width: ${CONTROL_BOX};
  min-height: ${CONTROL_BOX};
  border-radius: var(--radius-md);
  color: var(--ink-3);
}

[data-expand-button]:hover {
  color: var(--ink);
  background-color: var(--surface-2);
}

[data-expand-button]:active {
  color: var(--ink);
}

[data-expand-button]:focus-visible {
  color: var(--ink);
  outline: 2px solid var(--live);
  outline-offset: -2px;
}

/* Two directions sit side by side, each at full height. Pierre stacks them in
   one 34px column at 50% height each, which is a 17px tall control. */
[data-separator-wrapper][data-separator-multi-button] {
  grid-template-rows: none;
  grid-template-columns: ${CONTROL_BOX} ${CONTROL_BOX} auto;
}

[data-separator-wrapper][data-separator-multi-button] [data-expand-up] {
  grid-area: auto;
  grid-column: 1;
  border-block: 0;
}

[data-separator-wrapper][data-separator-multi-button] [data-expand-down] {
  grid-area: auto;
  grid-column: 2;
  border-block: 0;
}

[data-separator-wrapper][data-separator-multi-button] [data-separator-content] {
  grid-area: auto;
  grid-column: 3;
}

[data-expand-index] [data-separator-wrapper] {
  grid-template-columns: ${CONTROL_BOX} auto;
}

@media (pointer: coarse) {
  [data-separator="line-info"],
  [data-separator="line-info-basic"],
  [data-separator="metadata"] {
    height: ${TOUCH_BOX};
  }

  [data-expand-button] {
    min-width: ${TOUCH_BOX};
    min-height: ${TOUCH_BOX};
  }

  [data-expand-index] [data-separator-wrapper] {
    grid-template-columns: ${TOUCH_BOX} auto;
  }

  [data-separator-wrapper][data-separator-multi-button] {
    grid-template-columns: ${TOUCH_BOX} ${TOUCH_BOX} auto;
  }
}
`;

let sheet: CSSStyleSheet | undefined;

/** One constructed sheet for the whole app; roots share it. */
export function diffTypographySheet(): CSSStyleSheet | undefined {
  if (typeof CSSStyleSheet === "undefined") return undefined;
  if (!sheet) {
    try {
      const next = new CSSStyleSheet();
      next.replaceSync(DIFF_TYPOGRAPHY_CSS);
      sheet = next;
    } catch {
      return undefined;
    }
  }
  return sheet;
}

/**
 * Append our sheet to a root's own sheets. Never replaces: Pierre's core CSS
 * is the first entry of that array and dropping it unpaints the diff.
 * Returns true when the root now carries it.
 */
export function adoptDiffTypography(root: ShadowRoot): boolean {
  const next = diffTypographySheet();
  if (!next) return false;
  if (!("adoptedStyleSheets" in root)) return false;
  if (root.adoptedStyleSheets.includes(next)) return true;
  root.adoptedStyleSheets = [...root.adoptedStyleSheets, next];
  return true;
}

/** Test seam: forget the cached sheet. */
export function resetDiffTypographySheet(): void {
  sheet = undefined;
}
