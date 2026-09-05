/**
 * The theme is data (docs/ux-theme.md, "What a theme is"). A component never
 * sees this type; it reads CSS custom properties. Settings edits it, the
 * store persists it, `compileTheme` turns it into the properties.
 */

export type ThemeBase = "dark" | "light";
export type Density = "comfortable" | "compact";
export type Radius = "sharp" | "soft" | "round";
export type Contrast = "normal" | "high";
export type Motion = "full" | "reduced";
export type TextSize = "small" | "default" | "large" | "larger";

/**
 * A font choice is the id of an entry in the curated lists (`fonts.ts`), or
 * any Google Fonts family name typed by the person. Ids are stable strings so
 * a theme serialises without carrying a font stack around.
 */
export type FontChoice = string;

/** The colour tokens every preset must define. Values are `#rrggbb`. */
export type ColorTokenName =
  | "bg"
  | "surface"
  | "surface-2"
  | "line"
  | "ink"
  | "ink-2"
  | "ink-3"
  | "live"
  | "attention"
  | "danger"
  | "ok";

/**
 * Colour tokens a preset *may* define. When absent they are derived: the
 * `on-*` inks from the ground they sit on, the terminal and ANSI set from the
 * base, the syntax set from the base, the shadows from the base.
 */
export type OptionalColorTokenName =
  | "on-live"
  | "on-attention"
  | "on-danger"
  | "on-ok"
  | "terminal-bg"
  | "terminal-ink"
  | "terminal-ink-2"
  | "terminal-line"
  | `ansi-${0 | 1 | 2 | 3 | 4 | 5 | 6 | 7 | 8 | 9 | 10 | 11 | 12 | 13 | 14 | 15}`
  | "syntax-keyword"
  | "syntax-string"
  | "syntax-number"
  | "syntax-comment"
  | "syntax-function"
  | "syntax-type"
  | "syntax-variable"
  | "syntax-punctuation"
  | "shadow-float"
  | "shadow-float-sm";

export type ThemeTokens = Record<ColorTokenName, string> & Partial<Record<OptionalColorTokenName, string>>;

export type Theme = {
  /** Preset id, or "custom" once any token has been edited by hand. */
  id: string;
  name: string;
  /** What `color-scheme` reports and which way the contrast guard pushes. */
  base: ThemeBase;
  /** Semantic colour tokens (layer 2). Sizes, radii and durations are knobs below, not tokens here. */
  tokens: ThemeTokens;
  fonts: { sans: FontChoice; mono: FontChoice };
  textSize: TextSize;
  density: Density;
  radius: Radius;
  contrast: Contrast;
  motion: Motion;
};

/** A preset is a full theme plus one line of intent for the gallery card. */
export type ThemePreset = Theme & { tagline: string };

/** What `compileTheme` produces: the properties the page reads. */
export type CompiledTheme = {
  id: string;
  base: ThemeBase;
  /** `--token` → value, every layer-2 token, ready to write on the root. */
  vars: Record<string, string>;
  /** The `vars` as CSS declarations, `--a: b; --c: d;`, for one style write. */
  css: string;
};
