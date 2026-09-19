// @vitest-environment happy-dom
/**
 * The diff in the overlay is set in our type, inside Pierre's shadow roots.
 *
 * Measured before this landed, in the running app: a `[data-line]` reported
 * `SF Mono` at 13px/20px, and the `diffs-container` host reported `system-ui`.
 * Neither font exists on this machine, so the renderer drew code in whatever
 * the system offered — the "pixelated" diff. These tests pin the two halves of
 * the fix: what the sheet says, and that adopting it never takes Pierre's own
 * core CSS away.
 */
import { beforeEach, expect, it } from "vitest";

import {
  DIFF_HOST_VARS,
  DIFF_TYPOGRAPHY_CSS,
  adoptDiffTypography,
  diffTypographySheet,
  resetDiffTypographySheet,
} from "../../src/source-control/diff-typography.js";

beforeEach(() => {
  resetDiffTypographySheet();
});

function shadowRoot(): ShadowRoot {
  const host = document.createElement("div");
  document.body.append(host);
  return host.attachShadow({ mode: "open" });
}

/** What Pierre's own constructor puts there: one core sheet, always first. */
function withCoreSheet(root: ShadowRoot): CSSStyleSheet {
  const core = new CSSStyleSheet();
  core.replaceSync("@layer base { :host { display: block } }");
  root.adoptedStyleSheets = [core];
  return core;
}

it("carries our mono face and the code size into the shadow root", () => {
  expect(DIFF_TYPOGRAPHY_CSS).toContain("--diffs-font-family: var(--font-mono)");
  expect(DIFF_TYPOGRAPHY_CSS).toContain("--diffs-font-size: var(--text-code)");
  expect(DIFF_TYPOGRAPHY_CSS).toContain("--diffs-line-height: var(--text-code--line-height)");
  // The face reaches the code elements directly too, not only through the
  // library's own variable, so a future `@layer` change cannot silently undo it.
  expect(DIFF_TYPOGRAPHY_CSS).toMatch(/pre, code, \[data-line\] \{[^}]*font-family: var\(--font-mono\)/);
  expect(DIFF_TYPOGRAPHY_CSS).toMatch(/pre, code, \[data-line\] \{[^}]*font-size: var\(--text-code\)/);
});

it("lines the gutter up: tabular figures and tertiary ink on the line numbers", () => {
  expect(DIFF_TYPOGRAPHY_CSS).toContain("--diffs-fg-number-override: var(--ink-3)");
  expect(DIFF_TYPOGRAPHY_CSS).toMatch(/\[data-column-number\][\s\S]*?font-variant-numeric: tabular-nums/);
  expect(DIFF_TYPOGRAPHY_CSS).toContain('--diffs-font-features: "tnum" 1, "calt" 0');
});

it("sets the same variables on the light-DOM host, so the first frame is already ours", () => {
  // Custom properties inherit through a shadow boundary; this is what makes
  // the diff correct before any observer has run.
  expect(DIFF_HOST_VARS["--diffs-font-family"]).toBe("var(--font-mono)");
  expect(DIFF_HOST_VARS["--diffs-font-size"]).toBe("var(--text-code)");
  expect(DIFF_HOST_VARS["--diffs-line-height"]).toBe("var(--text-code--line-height)");
  expect(DIFF_HOST_VARS["--diffs-header-font-family"]).toBe("var(--font-sans)");
  expect(DIFF_HOST_VARS["--diffs-fg-number-override"]).toBe("var(--ink-3)");
});

it("names no colour, no raw type size and no literal control box", () => {
  // Every painted value is a token or arithmetic on one: `calc(var(--space-unit)
  // * 8)` is what `h-8` compiles to, and `* 11` is the coarse-pointer target.
  // Comments may say whatever they need to, the same rule `chrome-tokens`
  // applies to component source, so they come out first.
  const declarations = DIFF_TYPOGRAPHY_CSS.replace(/\/\*[\s\S]*?\*\//g, "");
  expect(declarations).not.toMatch(/#[0-9a-fA-F]{3,8}\b/);
  expect(declarations).not.toMatch(/\boklch\(|\brgba?\(|\bhsla?\(/);
  // The focus ring's 2px is the app's own ring width (`outline-2`), and the
  // only length in here that is not a token.
  expect(declarations.replace(/outline: 2px solid|outline-offset: -2px/g, "")).not.toMatch(/\d+(?:px|rem|em)\b/);
  expect(declarations).toContain("calc(var(--space-unit) * 8)");
  expect(declarations).toContain("calc(var(--space-unit) * 11)");
});

it("appends to a root's own sheets and never replaces them", () => {
  const root = shadowRoot();
  const core = withCoreSheet(root);
  expect(adoptDiffTypography(root)).toBe(true);
  expect(root.adoptedStyleSheets).toHaveLength(2);
  // Pierre's core CSS is still first. Replacing the array (their own
  // constructor does `= [coreSheet]`) unpaints the diff entirely.
  expect(root.adoptedStyleSheets[0]).toBe(core);
  expect(root.adoptedStyleSheets[1]).toBe(diffTypographySheet());
});

it("adopts once per root, however many passes run over it", () => {
  const root = shadowRoot();
  withCoreSheet(root);
  adoptDiffTypography(root);
  adoptDiffTypography(root);
  adoptDiffTypography(root);
  expect(root.adoptedStyleSheets).toHaveLength(2);
});

it("shares one constructed sheet across every root", () => {
  const first = shadowRoot();
  const second = shadowRoot();
  withCoreSheet(first);
  withCoreSheet(second);
  adoptDiffTypography(first);
  adoptDiffTypography(second);
  expect(first.adoptedStyleSheets[1]).toBe(second.adoptedStyleSheets[1]);
});
