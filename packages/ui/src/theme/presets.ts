/**
 * Presets. Each is a design, not a hue rotation: its own neutral family, its
 * own accent and attention hues, its own fonts. Colours are authored from the
 * primitive ramps so every preset inherits the contrast the ramps were tuned
 * for; the guard test in `test/theme.test.ts` re-measures every one anyway.
 *
 * The default is the Laser brand pair (T5). Most people never open Appearance,
 * so it gets the scrutiny of a single-theme product: the approved mark's
 * black, warm-white and beam green, amber for "needs you", and the two default
 * faces. Graphite and Paper remain available as quieter alternatives.
 */
import { PRODUCT, PRODUCT_DISPLAY_NAME, PRODUCT_NAME } from "@lasercode/protocol";
import { ACCENT_HUES, accentRamp, attentionRamp, neutralRamp, type NeutralFamily } from "./primitives.js";
import { oklch, pickOnColor } from "./color.js";
import { DEFAULT_FONTS } from "./fonts.js";
import type { ThemeBase, ThemePreset, ThemeTokens } from "./types.js";

export const DEFAULT_PRESET_ID = PRODUCT_NAME;
/** The light preset a fresh install flips to when following the system. */
export const DEFAULT_LIGHT_PRESET_ID = `${PRODUCT_NAME}-light`;

/** Approved website mark colours. The SVG is the identity source of truth. */
export const LASER_BRAND = {
  black: PRODUCT.branding.black.toLowerCase(),
  warmWhite: PRODUCT.branding.warmWhite.toLowerCase(),
  green: PRODUCT.branding.light.toLowerCase(),
} as const;

type Palette = {
  family: NeutralFamily;
  base: ThemeBase;
  accentHue: number;
  attentionHue: number;
  /** Ramp steps for the grounds and inks, darkest-first indices into the neutral ramp. */
  steps: { bg: number; surface: number; surface2: number; line: number; ink: number; ink2: number; ink3: number };
};

function paletteTokens(p: Palette): ThemeTokens {
  const n = neutralRamp(p.family);
  const at = (i: number) => n[i]!;
  const accent = accentRamp(p.accentHue, p.base);
  const danger = p.base === "dark" ? oklch(0.75, 0.16, 22) : oklch(0.5, 0.19, 27);
  const ok = p.base === "dark" ? oklch(0.8, 0.15, 150) : oklch(0.5, 0.15, 150);
  const attention = attentionRamp(p.attentionHue, p.base);
  const darkInk = at(1);
  const lightInk = at(16);
  return {
    bg: at(p.steps.bg),
    surface: at(p.steps.surface),
    "surface-2": at(p.steps.surface2),
    line: at(p.steps.line),
    ink: at(p.steps.ink),
    "ink-2": at(p.steps.ink2),
    "ink-3": at(p.steps.ink3),
    live: accent.text,
    attention,
    danger,
    ok,
    "on-live": pickOnColor(accent.text, darkInk, lightInk),
    "on-attention": pickOnColor(attention, darkInk, lightInk),
    "on-danger": pickOnColor(danger, darkInk, lightInk),
    "on-ok": pickOnColor(ok, darkInk, lightInk),
  };
}

const DARK_STEPS = { bg: 2, surface: 3, surface2: 4, line: 5, ink: 13, ink2: 11, ink3: 10 };
const LIGHT_STEPS = { bg: 15, surface: 16, surface2: 14, line: 12, ink: 1, ink2: 7, ink3: 8 };

const knobs = { textSize: "default", density: "comfortable", radius: "soft", contrast: "normal", motion: "full" } as const;

export const PRESETS: readonly ThemePreset[] = [
  {
    id: PRODUCT_NAME,
    name: PRODUCT_DISPLAY_NAME,
    tagline: "Brand black, warm-white ink and beam green. The default.",
    base: "dark",
    tokens: {
      ...paletteTokens({ family: "graphite", base: "dark", accentHue: ACCENT_HUES.green, attentionHue: ACCENT_HUES.amber, steps: DARK_STEPS }),
      bg: LASER_BRAND.black,
      ink: LASER_BRAND.warmWhite,
      live: LASER_BRAND.green,
      "on-live": LASER_BRAND.black,
    },
    fonts: { ...DEFAULT_FONTS },
    ...knobs,
  },
  {
    id: "graphite",
    name: "Graphite",
    tagline: "Plain dark with a softer green accent.",
    base: "dark",
    tokens: paletteTokens({ family: "graphite", base: "dark", accentHue: ACCENT_HUES.green, attentionHue: ACCENT_HUES.amber, steps: DARK_STEPS }),
    fonts: { ...DEFAULT_FONTS },
    ...knobs,
  },
  {
    id: "midnight",
    name: "Midnight",
    tagline: "Blue-black console, the first Ground Station.",
    base: "dark",
    tokens: paletteTokens({ family: "slate", base: "dark", accentHue: ACCENT_HUES.sky, attentionHue: ACCENT_HUES.amber, steps: DARK_STEPS }),
    fonts: { sans: "host-grotesk", mono: "martian-mono" },
    ...knobs,
  },
  {
    id: "ember",
    name: "Ember",
    tagline: "Warm greys, coral accent, gold for attention.",
    base: "dark",
    tokens: paletteTokens({ family: "stone", base: "dark", accentHue: ACCENT_HUES.coral, attentionHue: 95, steps: DARK_STEPS }),
    fonts: { ...DEFAULT_FONTS },
    ...knobs,
  },
  {
    id: "contrast-dark",
    name: "High contrast dark",
    tagline: "Black ground, white ink, nothing subtle.",
    base: "dark",
    tokens: {
      ...paletteTokens({ family: "ink", base: "dark", accentHue: ACCENT_HUES.cyan, attentionHue: ACCENT_HUES.amber, steps: { bg: 0, surface: 1, surface2: 2, line: 7, ink: 16, ink2: 14, ink3: 12 } }),
      live: oklch(0.85, 0.12, ACCENT_HUES.cyan),
      attention: oklch(0.88, 0.15, ACCENT_HUES.amber),
      danger: oklch(0.8, 0.16, 22),
      ok: oklch(0.86, 0.16, 150),
    },
    fonts: { ...DEFAULT_FONTS },
    textSize: "default",
    density: "comfortable",
    radius: "soft",
    contrast: "high",
    motion: "full",
  },
  {
    id: `${PRODUCT_NAME}-light`,
    name: `${PRODUCT_DISPLAY_NAME} light`,
    tagline: "Brand warm white, black ink and an accessible beam-green tone.",
    base: "light",
    tokens: {
      ...paletteTokens({ family: "stone", base: "light", accentHue: ACCENT_HUES.green, attentionHue: 65, steps: LIGHT_STEPS }),
      bg: LASER_BRAND.warmWhite,
      ink: LASER_BRAND.black,
    },
    fonts: { ...DEFAULT_FONTS },
    ...knobs,
  },
  {
    id: "paper",
    name: "Paper",
    tagline: "Warm white, beam-green accent. Light, easy on the eyes.",
    base: "light",
    tokens: paletteTokens({ family: "stone", base: "light", accentHue: ACCENT_HUES.green, attentionHue: 65, steps: LIGHT_STEPS }),
    fonts: { ...DEFAULT_FONTS },
    ...knobs,
  },
  {
    id: "daylight",
    name: "Daylight",
    tagline: "Cool light, the first Ground Station's day side.",
    base: "light",
    tokens: paletteTokens({ family: "slate", base: "light", accentHue: ACCENT_HUES.blue, attentionHue: 70, steps: LIGHT_STEPS }),
    fonts: { sans: "host-grotesk", mono: "martian-mono" },
    ...knobs,
  },
  {
    id: "contrast-light",
    name: "High contrast light",
    tagline: "White ground, black ink, deep status colours.",
    base: "light",
    tokens: {
      ...paletteTokens({ family: "ink", base: "light", accentHue: ACCENT_HUES.blue, attentionHue: 65, steps: { bg: 16, surface: 16, surface2: 15, line: 9, ink: 0, ink2: 3, ink3: 5 } }),
      live: oklch(0.42, 0.19, ACCENT_HUES.blue),
      attention: oklch(0.45, 0.13, 65),
      danger: oklch(0.45, 0.2, 27),
      ok: oklch(0.42, 0.15, 150),
    },
    fonts: { ...DEFAULT_FONTS },
    textSize: "default",
    density: "comfortable",
    radius: "soft",
    contrast: "high",
    motion: "full",
  },
];

export function getPreset(id: string): ThemePreset | undefined {
  return PRESETS.find((p) => p.id === id);
}

export const DEFAULT_PRESET: ThemePreset = getPreset(DEFAULT_PRESET_ID)!;

/** Presets of one base, for the gallery's two rows and for follow-the-system pairing. */
export function presetsFor(base: ThemeBase): readonly ThemePreset[] {
  return PRESETS.filter((p) => p.base === base);
}
