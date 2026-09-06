/**
 * Layer 1 — primitive scales. Raw values with no meaning attached.
 *
 * This file and `presets.ts` are the only places in `packages/ui/src` where a
 * literal visual value may appear (docs/ux-theme.md T1). A component never
 * imports from here; it reads the semantic tokens the compiler writes.
 */
import { oklch } from "./color.js";

/* ----------------------------------------------------------------------------
 * Neutral ramps. One lightness ladder, tinted per family. Step 0 is darkest.
 * -------------------------------------------------------------------------- */

/** OKLCH lightness per step. Even steps perceptually, dense where UIs live. */
export const NEUTRAL_LIGHTNESS = [
  0.05, // 0  near-black (high-contrast dark ground)
  0.13, // 1
  0.17, // 2  dark bg
  0.21, // 3  dark surface
  0.25, // 4  dark surface-2
  0.31, // 5  dark line
  0.38, // 6
  0.46, // 7  light ink-2
  0.52, // 8  light ink-3
  0.6, // 9
  0.68, // 10 dark ink-3
  0.76, // 11 dark ink-2
  0.84, // 12 light line
  0.905, // 13 dark ink / light surface-2 (lightest common ground)
  0.945, // 14 light surface-2
  0.975, // 15 light bg
  1, // 16 white
] as const;

export type NeutralFamily = "graphite" | "slate" | "stone" | "ink";

/** Hue and chroma of the tint each neutral family carries. */
export const NEUTRAL_TINT: Record<NeutralFamily, { h: number; c: number }> = {
  graphite: { h: 260, c: 0.004 }, // a plain grey with the faintest cool cast
  slate: { h: 245, c: 0.022 }, // blue-black, the original Ground Station
  stone: { h: 70, c: 0.01 }, // warm paper greys
  ink: { h: 0, c: 0 }, // pure, for the high-contrast presets
};

/** The full ramp for a family, `#rrggbb` per step. */
export function neutralRamp(family: NeutralFamily): readonly string[] {
  const { h, c } = NEUTRAL_TINT[family];
  return NEUTRAL_LIGHTNESS.map((l) => oklch(l, l >= 0.99 || l <= 0.06 ? 0 : c, h));
}

/* ----------------------------------------------------------------------------
 * Accent ramps. One ramp per hue; a preset picks a hue and a base.
 * -------------------------------------------------------------------------- */

export type AccentHueName =
  | "blue"
  | "sky"
  | "indigo"
  | "violet"
  | "magenta"
  | "rose"
  | "coral"
  | "orange"
  | "amber"
  | "lime"
  | "green"
  | "teal"
  | "cyan";

/** The curated hue row in Settings → Appearance → Accent. Degrees, OKLCH. */
export const ACCENT_HUES: Record<AccentHueName, number> = {
  blue: 255,
  sky: 235,
  indigo: 275,
  violet: 300,
  magenta: 340,
  rose: 10,
  coral: 30,
  orange: 55,
  amber: 80,
  lime: 125,
  green: 150,
  teal: 175,
  cyan: 200,
};

/**
 * A status colour at the lightness and chroma that reads on each base.
 * `text` is the value used as text and as a dot (≥ 4.5:1 on the base's
 * grounds by construction); `fill` is slightly stronger for a filled button.
 */
export function accentRamp(hue: number, base: "dark" | "light") {
  return base === "dark"
    ? {
        text: oklch(0.78, 0.13, hue),
        fill: oklch(0.72, 0.15, hue),
        soft: oklch(0.32, 0.06, hue),
      }
    : {
        text: oklch(0.5, 0.17, hue),
        fill: oklch(0.55, 0.19, hue),
        soft: oklch(0.93, 0.04, hue),
      };
}

/**
 * Attention is warm by convention and must never share the accent's hue
 * (T3). Its lightness differs from the accent's so the two also differ in
 * value, not just hue — a colour-blind person still sees two states.
 */
export function attentionRamp(hue: number, base: "dark" | "light") {
  return base === "dark" ? oklch(0.83, 0.15, hue) : oklch(0.52, 0.13, hue);
}

/* ----------------------------------------------------------------------------
 * Type scale. Pixels at text size "default"; the compiler multiplies and
 * rounds, never below the floor.
 * -------------------------------------------------------------------------- */

export type TypeStep = "2xs" | "xs" | "sm" | "base" | "md" | "lg" | "xl" | "2xl" | "code";

/** [font-size, line-height] in px at scale 1. */
export const TYPE_SCALE: Record<TypeStep, readonly [size: number, leading: number]> = {
  "2xs": [11, 16], // eyebrow only: uppercase category labels, never a value
  xs: [12, 16], // the floor for anything read as data
  sm: [13, 18],
  base: [14, 21],
  md: [15, 24], // transcript prose
  lg: [18, 26],
  xl: [22, 28],
  "2xl": [28, 34], // display: empty states
  code: [12, 18], // code and terminal blocks want looser leading than xs
};

/** No data below this, at any text-size setting (T2). */
export const TEXT_FLOOR_PX = 12;
/** The eyebrow's own floor: it is a label, not a value, and may sit one step under. */
export const EYEBROW_FLOOR_PX = 11;

export const TEXT_SCALE: Record<"small" | "default" | "large" | "larger", number> = {
  small: 0.92,
  default: 1,
  large: 1.1,
  larger: 1.2,
};

/** iOS zooms a focused field under 16px; a platform constant, not a design choice. */
export const TOUCH_INPUT_MIN_PX = 16;

/** Readable line measures. Shared so transcript-adjacent surfaces align. */
export const CONTENT_MEASURE = {
  thread: "84ch",
  prose: "80ch",
} as const;

/* ----------------------------------------------------------------------------
 * Spacing, radius, motion.
 * -------------------------------------------------------------------------- */

/** One spacing unit in px; every `--space-*` step and Tailwind's `--spacing` multiply it. */
export const SPACE_UNIT: Record<"comfortable" | "compact", number> = {
  comfortable: 4,
  compact: 3.5,
};

/** `--radius` in px; the named steps derive from it in CSS. */
export const RADIUS_BASE: Record<"sharp" | "soft" | "round", number> = {
  sharp: 3,
  soft: 8,
  round: 14,
};

/** Durations in ms. `reduced` collapses every one to zero. */
export const DURATIONS = {
  instant: 75,
  fast: 150,
  slow: 200,
  morph: 260,
} as const;

export const EASE_MORPH = "cubic-bezier(0.2, 0.8, 0.2, 1)";

/* ----------------------------------------------------------------------------
 * Terminal and ANSI. Dark in both bases: agent output is read on a dark
 * ground everywhere, so the sixteen colours are tuned once against it.
 * -------------------------------------------------------------------------- */

export const TERMINAL = {
  bg: oklch(0.17, 0.012, 250),
  ink: oklch(0.93, 0.008, 250),
  ink2: oklch(0.76, 0.015, 250),
  line: oklch(0.31, 0.02, 250),
} as const;

/** ANSI 0–15. `ansi-0` is a readable grey, not black: black on the terminal ground is invisible. */
export const ANSI: readonly string[] = [
  TERMINAL.ink2,
  oklch(0.74, 0.16, 25), // 1 red
  oklch(0.82, 0.16, 145), // 2 green
  oklch(0.82, 0.14, 85), // 3 yellow
  oklch(0.76, 0.12, 245), // 4 blue
  oklch(0.78, 0.13, 305), // 5 magenta
  oklch(0.8, 0.11, 200), // 6 cyan
  TERMINAL.ink, // 7 white
  oklch(0.66, 0.02, 250), // 8 bright black
  oklch(0.8, 0.13, 25), // 9
  oklch(0.88, 0.14, 145), // 10
  oklch(0.88, 0.13, 85), // 11
  oklch(0.84, 0.1, 245), // 12
  oklch(0.86, 0.1, 305), // 13
  oklch(0.88, 0.09, 200), // 14
  "#ffffff", // 15
];

/** Syntax colours per base, hues chosen to stay apart from every status colour's job. */
export const SYNTAX: Record<"dark" | "light", Record<"keyword" | "string" | "number" | "comment" | "function" | "type" | "variable" | "punctuation", string>> = {
  dark: {
    keyword: oklch(0.78, 0.12, 300),
    string: oklch(0.8, 0.12, 150),
    number: oklch(0.82, 0.12, 70),
    comment: oklch(0.66, 0.02, 250),
    function: oklch(0.8, 0.11, 240),
    type: oklch(0.82, 0.1, 190),
    variable: oklch(0.9, 0.01, 250),
    punctuation: oklch(0.72, 0.015, 250),
  },
  light: {
    keyword: oklch(0.48, 0.17, 300),
    string: oklch(0.48, 0.13, 150),
    number: oklch(0.5, 0.13, 60),
    comment: oklch(0.55, 0.02, 250),
    function: oklch(0.48, 0.15, 250),
    type: oklch(0.5, 0.11, 190),
    variable: oklch(0.25, 0.01, 250),
    punctuation: oklch(0.45, 0.015, 250),
  },
};

/** Floating shadows per base; only floating things cast them (composer, popovers, sheets). */
export const SHADOWS: Record<"dark" | "light", { float: string; floatSm: string }> = {
  dark: {
    float: "0 1px 2px rgb(0 0 0 / 0.4), 0 12px 32px -8px rgb(0 0 0 / 0.6)",
    floatSm: "0 1px 2px rgb(0 0 0 / 0.4), 0 4px 14px -4px rgb(0 0 0 / 0.5)",
  },
  light: {
    float: "0 1px 2px rgb(19 26 34 / 0.06), 0 8px 24px -8px rgb(19 26 34 / 0.18)",
    floatSm: "0 1px 2px rgb(19 26 34 / 0.08), 0 4px 12px -4px rgb(19 26 34 / 0.14)",
  },
};
