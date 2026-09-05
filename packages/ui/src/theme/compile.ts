/**
 * Theme → custom properties. Pure: no DOM. `applyTheme` writes the result.
 *
 * Everything a component can read is decided here: the colour tokens, the
 * type scale after the text-size setting and the legibility floor, the
 * spacing unit after density, the radius base, the durations after the motion
 * setting, and the two font stacks. Tailwind's utilities read the same
 * properties (see `globals.css`, `@theme inline reference`), so `text-sm`,
 * `p-3`, `rounded-lg` and `duration-(--motion-fast)` all move with the theme.
 */
import { pickOnColor, raiseContrast, toHex } from "./color.js";
import { fontStack } from "./fonts.js";
import {
  ANSI,
  DURATIONS,
  EASE_MORPH,
  EYEBROW_FLOOR_PX,
  RADIUS_BASE,
  SHADOWS,
  SPACE_UNIT,
  SYNTAX,
  TERMINAL,
  TEXT_FLOOR_PX,
  TEXT_SCALE,
  TOUCH_INPUT_MIN_PX,
  TYPE_SCALE,
  type TypeStep,
} from "./primitives.js";
import type { CompiledTheme, Theme, ThemeTokens } from "./types.js";

/** Contrast a text token must clear against every ground, per contrast setting. */
export const CONTRAST_TARGET = { normal: 4.5, high: 7 } as const;
/** Hairlines and the `line` token: visible, not readable. */
export const LINE_CONTRAST_TARGET = { normal: 1.25, high: 3 } as const;

/** Text tokens: everything a person reads, plus the status colours used as text and dots. */
export const TEXT_TOKENS = ["ink", "ink-2", "ink-3", "live", "attention", "danger", "ok"] as const;
/** Grounds text sits on. `surface-2` is the one that fights hardest in both bases. */
export const GROUND_TOKENS = ["bg", "surface", "surface-2"] as const;

/** Font size for a step after scaling, never under its floor, whole pixels. */
export function scaledType(step: TypeStep, scale: number): { size: number; leading: number } {
  const [size, leading] = TYPE_SCALE[step];
  const floor = step === "2xs" ? EYEBROW_FLOOR_PX : TEXT_FLOOR_PX;
  const s = Math.max(floor, Math.round(size * scale));
  // Leading scales with the same factor the size actually got, so a floored
  // size keeps its authored proportion instead of gaining air.
  const l = Math.round(leading * (s / size));
  return { size: s, leading: l };
}

/**
 * Fills in every derived colour a preset left out, and raises text to the
 * contrast target when the theme asks for high contrast. Returns hex only.
 */
export function resolveTokens(theme: Theme): Required<ThemeTokens> {
  const t = theme.tokens;
  const base = theme.base;
  const grounds = GROUND_TOKENS.map((g) => toHex(t[g]));
  const target = CONTRAST_TARGET[theme.contrast];
  const direction = base === "dark" ? "lighter" : "darker";

  const text: Record<(typeof TEXT_TOKENS)[number], string> = {
    ink: toHex(t.ink),
    "ink-2": toHex(t["ink-2"]),
    "ink-3": toHex(t["ink-3"]),
    live: toHex(t.live),
    attention: toHex(t.attention),
    danger: toHex(t.danger),
    ok: toHex(t.ok),
  };
  for (const name of TEXT_TOKENS) {
    text[name] = raiseContrast(text[name], grounds, target, direction);
  }
  const line = raiseContrast(toHex(t.line), grounds, LINE_CONTRAST_TARGET[theme.contrast], direction);

  const darkInk = base === "dark" ? toHex(t.bg) : text.ink;
  const lightInk = base === "dark" ? text.ink : toHex(t.surface);
  const on = (ground: string, given: string | undefined) => (given ? toHex(given) : pickOnColor(ground, darkInk, lightInk));

  const syntax = SYNTAX[base];
  const shadows = SHADOWS[base];
  const ansi = Object.fromEntries(ANSI.map((v, i) => [`ansi-${i}`, t[`ansi-${i as 0}`] ?? v])) as Record<`ansi-${0}`, string>;

  return {
    bg: toHex(t.bg),
    surface: toHex(t.surface),
    "surface-2": toHex(t["surface-2"]),
    line,
    ...text,
    "on-live": on(text.live, t["on-live"]),
    "on-attention": on(text.attention, t["on-attention"]),
    "on-danger": on(text.danger, t["on-danger"]),
    "on-ok": on(text.ok, t["on-ok"]),
    "terminal-bg": t["terminal-bg"] ?? TERMINAL.bg,
    "terminal-ink": t["terminal-ink"] ?? TERMINAL.ink,
    "terminal-ink-2": t["terminal-ink-2"] ?? TERMINAL.ink2,
    "terminal-line": t["terminal-line"] ?? TERMINAL.line,
    ...(ansi as Required<Pick<ThemeTokens, `ansi-${0}`>>),
    "syntax-keyword": t["syntax-keyword"] ?? syntax.keyword,
    "syntax-string": t["syntax-string"] ?? syntax.string,
    "syntax-number": t["syntax-number"] ?? syntax.number,
    "syntax-comment": t["syntax-comment"] ?? syntax.comment,
    "syntax-function": t["syntax-function"] ?? syntax.function,
    "syntax-type": t["syntax-type"] ?? syntax.type,
    "syntax-variable": t["syntax-variable"] ?? syntax.variable,
    "syntax-punctuation": t["syntax-punctuation"] ?? syntax.punctuation,
    "shadow-float": t["shadow-float"] ?? shadows.float,
    "shadow-float-sm": t["shadow-float-sm"] ?? shadows.floatSm,
  } as Required<ThemeTokens>;
}

/** Every custom property the page reads, in the order they are written. */
export function compileVars(theme: Theme): Record<string, string> {
  const tokens = resolveTokens(theme);
  const vars: Record<string, string> = {};

  for (const [name, value] of Object.entries(tokens)) vars[`--${name}`] = value;
  vars["--on-accent"] = tokens["on-live"];

  vars["--font-sans"] = fontStack(theme.fonts.sans, "sans");
  vars["--font-mono"] = fontStack(theme.fonts.mono, "mono");

  const scale = TEXT_SCALE[theme.textSize];
  vars["--text-scale"] = String(scale);
  for (const step of Object.keys(TYPE_SCALE) as TypeStep[]) {
    const { size, leading } = scaledType(step, scale);
    vars[`--text-${step}`] = `${size}px`;
    vars[`--text-${step}--line-height`] = `${leading}px`;
    vars[`--leading-${step}`] = `${leading}px`;
  }
  vars["--text-floor"] = `${TEXT_FLOOR_PX}px`;
  vars["--text-touch-min"] = `${TOUCH_INPUT_MIN_PX}px`;

  vars["--space-unit"] = `${SPACE_UNIT[theme.density]}px`;
  vars["--radius"] = `${RADIUS_BASE[theme.radius]}px`;

  const off = theme.motion === "reduced";
  vars["--motion-instant"] = off ? "0ms" : `${DURATIONS.instant}ms`;
  vars["--motion-fast"] = off ? "0ms" : `${DURATIONS.fast}ms`;
  vars["--motion-slow"] = off ? "0ms" : `${DURATIONS.slow}ms`;
  vars["--motion-morph"] = off ? "0ms" : `${DURATIONS.morph}ms`;
  vars["--motion-ease"] = EASE_MORPH;

  vars["color-scheme"] = theme.base;
  return vars;
}

/** `--a: b; --c: d;` — one string, one style write. */
export function varsToCss(vars: Record<string, string>): string {
  return Object.entries(vars)
    .map(([k, v]) => `${k}: ${v};`)
    .join(" ");
}

export function compileTheme(theme: Theme): CompiledTheme {
  const vars = compileVars(theme);
  return { id: theme.id, base: theme.base, vars, css: varsToCss(vars) };
}

/**
 * The legibility floor as the document currently defines it, in px.
 *
 * `TEXT_FLOOR_PX` is the compile-time constant; this is the same number read
 * back from `--text-floor`, so a component that must decide in JavaScript
 * whether a numeral fits (rather than in CSS) follows the person's text-size
 * setting instead of a baked 12. Falls back to the constant off the DOM.
 */
export function textFloorPx(): number {
  if (typeof document === "undefined" || typeof getComputedStyle !== "function") return TEXT_FLOOR_PX;
  const raw = getComputedStyle(document.documentElement).getPropertyValue("--text-floor").trim();
  const px = Number.parseFloat(raw);
  return Number.isFinite(px) && px > 0 ? px : TEXT_FLOOR_PX;
}
