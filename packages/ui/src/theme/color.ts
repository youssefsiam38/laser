/**
 * Colour math for the theme system: OKLCH in, sRGB hex out, WCAG contrast.
 *
 * Everything the theme writes to the page is a six-digit hex. Presets and the
 * primitive ramps are *authored* in OKLCH because it is perceptually even —
 * a step in lightness looks like the same step on every hue — and because a
 * guard rail that "raises text until it clears its ground" is one loop over
 * lightness. Hex is what leaves this module so the contrast readout, the boot
 * script and any editor deal with one format.
 */

export type Rgb = { r: number; g: number; b: number }; // 0..1 linear-encoded sRGB (gamma applied)
export type Oklch = { l: number; c: number; h: number }; // l 0..1, c 0..~0.4, h degrees

const clamp01 = (x: number): number => (x < 0 ? 0 : x > 1 ? 1 : x);

function srgbToLinear(c: number): number {
  return c <= 0.04045 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4;
}
function linearToSrgb(c: number): number {
  return c <= 0.0031308 ? c * 12.92 : 1.055 * c ** (1 / 2.4) - 0.055;
}

/** OKLCH → sRGB without gamut clipping. Components may fall outside 0..1. */
function oklchToRgbRaw({ l, c, h }: Oklch): Rgb {
  const hr = (h * Math.PI) / 180;
  const a = c * Math.cos(hr);
  const b = c * Math.sin(hr);
  const l_ = l + 0.3963377774 * a + 0.2158037573 * b;
  const m_ = l - 0.1055613458 * a - 0.0638541728 * b;
  const s_ = l - 0.0894841775 * a - 1.291485548 * b;
  const L = l_ ** 3;
  const M = m_ ** 3;
  const S = s_ ** 3;
  return {
    r: linearToSrgb(4.0767416621 * L - 3.3077115913 * M + 0.2309699292 * S),
    g: linearToSrgb(-1.2684380046 * L + 2.6097574011 * M - 0.3413193965 * S),
    b: linearToSrgb(-0.0041960863 * L - 0.7034186147 * M + 1.707614701 * S),
  };
}

function inGamut({ r, g, b }: Rgb): boolean {
  const eps = 1e-4;
  return r >= -eps && r <= 1 + eps && g >= -eps && g <= 1 + eps && b >= -eps && b <= 1 + eps;
}

/**
 * OKLCH → sRGB, reducing chroma (never lightness or hue) until the colour fits
 * in gamut. Keeping lightness fixed is what keeps contrast predictable.
 */
export function oklchToRgb(color: Oklch): Rgb {
  let rgb = oklchToRgbRaw(color);
  if (inGamut(rgb)) return clampRgb(rgb);
  let lo = 0;
  let hi = color.c;
  for (let i = 0; i < 24; i++) {
    const mid = (lo + hi) / 2;
    rgb = oklchToRgbRaw({ ...color, c: mid });
    if (inGamut(rgb)) lo = mid;
    else hi = mid;
  }
  return clampRgb(oklchToRgbRaw({ ...color, c: lo }));
}

function clampRgb({ r, g, b }: Rgb): Rgb {
  return { r: clamp01(r), g: clamp01(g), b: clamp01(b) };
}

export function rgbToOklch({ r, g, b }: Rgb): Oklch {
  const lr = srgbToLinear(r);
  const lg = srgbToLinear(g);
  const lb = srgbToLinear(b);
  const l_ = Math.cbrt(0.4122214708 * lr + 0.5363325363 * lg + 0.0514459929 * lb);
  const m_ = Math.cbrt(0.2119034982 * lr + 0.6806995451 * lg + 0.1073969566 * lb);
  const s_ = Math.cbrt(0.0883024619 * lr + 0.2817188376 * lg + 0.6299787005 * lb);
  const L = 0.2104542553 * l_ + 0.793617785 * m_ - 0.0040720468 * s_;
  const a = 1.9779984951 * l_ - 2.428592205 * m_ + 0.4505937099 * s_;
  const bb = 0.0259040371 * l_ + 0.7827717662 * m_ - 0.808675766 * s_;
  const c = Math.hypot(a, bb);
  let h = (Math.atan2(bb, a) * 180) / Math.PI;
  if (h < 0) h += 360;
  return { l: L, c, h: c < 1e-4 ? 0 : h };
}

export function rgbToHex({ r, g, b }: Rgb): string {
  const to = (x: number) =>
    Math.round(clamp01(x) * 255)
      .toString(16)
      .padStart(2, "0");
  return `#${to(r)}${to(g)}${to(b)}`;
}

/** `oklch(l c h)` → `#rrggbb`. The one entry point presets use. */
export function oklch(l: number, c: number, h: number): string {
  return rgbToHex(oklchToRgb({ l, c, h }));
}

/**
 * Parses `#rgb`, `#rrggbb`, `#rrggbbaa` (alpha ignored), `rgb()` / `rgba()`
 * with 0..255 components, and `oklch()` with a 0..1 or percentage lightness.
 * Returns null for anything else — a `var()`, a `color-mix()`, a keyword —
 * so a caller can say "cannot measure" rather than measure nonsense.
 */
export function parseColor(input: string): Rgb | null {
  const s = input.trim().toLowerCase();
  const hex = /^#([0-9a-f]{3,8})$/.exec(s);
  if (hex) {
    const h = hex[1]!;
    if (h.length === 3 || h.length === 4) {
      return {
        r: parseInt(h[0]! + h[0]!, 16) / 255,
        g: parseInt(h[1]! + h[1]!, 16) / 255,
        b: parseInt(h[2]! + h[2]!, 16) / 255,
      };
    }
    if (h.length === 6 || h.length === 8) {
      return {
        r: parseInt(h.slice(0, 2), 16) / 255,
        g: parseInt(h.slice(2, 4), 16) / 255,
        b: parseInt(h.slice(4, 6), 16) / 255,
      };
    }
    return null;
  }
  const rgb = /^rgba?\(\s*([\d.]+)[\s,]+([\d.]+)[\s,]+([\d.]+)/.exec(s);
  if (rgb) {
    return { r: clamp01(+rgb[1]! / 255), g: clamp01(+rgb[2]! / 255), b: clamp01(+rgb[3]! / 255) };
  }
  const ok = /^oklch\(\s*([\d.]+)(%?)\s+([\d.]+)\s+([\d.]+)/.exec(s);
  if (ok) {
    const l = ok[2] ? +ok[1]! / 100 : +ok[1]!;
    return oklchToRgb({ l, c: +ok[3]!, h: +ok[4]! });
  }
  if (s === "white") return { r: 1, g: 1, b: 1 };
  if (s === "black") return { r: 0, g: 0, b: 0 };
  return null;
}

/** Normalises any parseable colour to `#rrggbb`; returns the input untouched otherwise. */
export function toHex(input: string): string {
  const rgb = parseColor(input);
  return rgb ? rgbToHex(rgb) : input;
}

/** WCAG relative luminance. */
export function luminance({ r, g, b }: Rgb): number {
  return 0.2126 * srgbToLinear(r) + 0.7152 * srgbToLinear(g) + 0.0722 * srgbToLinear(b);
}

/**
 * WCAG 2 contrast ratio, 1..21. Accepts hex / rgb() / oklch() strings or
 * parsed colours. Returns `NaN` when either side cannot be parsed, so an
 * editor can show "—" instead of a false pass.
 */
export function contrastRatio(fg: string | Rgb, bg: string | Rgb): number {
  const a = typeof fg === "string" ? parseColor(fg) : fg;
  const b = typeof bg === "string" ? parseColor(bg) : bg;
  if (!a || !b) return NaN;
  const la = luminance(a);
  const lb = luminance(b);
  const [hi, lo] = la > lb ? [la, lb] : [lb, la];
  return (hi + 0.05) / (lo + 0.05);
}

/** OKLCH hue of a colour in degrees, or `null` for a neutral (chroma ≈ 0). */
export function hueOf(input: string): number | null {
  const rgb = parseColor(input);
  if (!rgb) return null;
  const { c, h } = rgbToOklch(rgb);
  return c < 0.02 ? null : h;
}

/** Shortest angular distance between two hues, 0..180. */
export function hueDistance(a: number, b: number): number {
  const d = Math.abs(((a - b) % 360 + 360) % 360);
  return d > 180 ? 360 - d : d;
}

/**
 * Moves `color` away from `grounds` in OKLCH lightness — up on a dark base,
 * down on a light one — until it reaches `target` contrast against every
 * ground, or runs out of lightness. Chroma and hue are kept, so a raised
 * accent is still recognisably that accent. This is the whole of "high
 * contrast raises every text token until it clears its ground".
 */
export function raiseContrast(color: string, grounds: readonly string[], target: number, direction: "lighter" | "darker"): string {
  const rgb = parseColor(color);
  if (!rgb) return color;
  const worst = (candidate: Rgb): number => Math.min(...grounds.map((g) => contrastRatio(candidate, g)));
  if (worst(rgb) >= target) return rgbToHex(rgb);
  const start = rgbToOklch(rgb);
  const step = direction === "lighter" ? 0.01 : -0.01;
  let l = start.l;
  let best = rgb;
  for (let i = 0; i < 100; i++) {
    l += step;
    if (l < 0 || l > 1) break;
    const next = oklchToRgb({ l, c: start.c, h: start.h });
    best = next;
    if (worst(next) >= target) break;
  }
  return rgbToHex(best);
}

/** Picks whichever of the two inks reads better on `ground`. */
export function pickOnColor(ground: string, darkInk: string, lightInk: string): string {
  return contrastRatio(darkInk, ground) >= contrastRatio(lightInk, ground) ? darkInk : lightInk;
}
