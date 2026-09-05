/**
 * Fonts: the curated lists from docs/ux-theme.md, their fallback stacks, and
 * on-demand loading by family.
 *
 * Two kinds of source:
 * - `self-hosted`: served from this origin (`public/fonts`, precached by the
 *   service worker). The two defaults are self-hosted so a fresh install
 *   never announces itself to a font CDN and renders offline in its real
 *   face. Their `@font-face` rules live in `globals.css`; the browser fetches
 *   a file only when the family is used, so unused ones cost nothing.
 * - `google`: fetched from Google Fonts only once chosen. One `<link>` per
 *   family, never re-added.
 * - `system`: no webfont at all.
 *
 * Every entry names a metric-compatible local fallback and, where the
 * numbers are known, `size-adjust` / `ascent-override` / `descent-override`
 * so text set in the fallback occupies the same lines as the webfont and the
 * swap does not reflow. The overrides are injected as a `<family> Fallback`
 * face and the stack lists it right after the real family.
 */
import { namespaced } from "@lasercode/protocol";
import type { FontChoice } from "./types.js";

export type FontKind = "sans" | "mono";
export type FontSource = "self-hosted" | "google" | "system";

export type FontEntry = {
  id: string;
  family: string;
  kind: FontKind;
  source: FontSource;
  /** Google Fonts axis spec, e.g. `wght@400..700`. Unused for self-hosted and system. */
  axes?: string;
  /** One line for the picker: why someone would choose it. */
  note: string;
  /** Local face to draw before the webfont arrives, with metric overrides when known. */
  fallback?: {
    local: string;
    sizeAdjust?: string;
    ascentOverride?: string;
    descentOverride?: string;
    lineGapOverride?: string;
  };
};

const SANS_TAIL = 'ui-sans-serif, system-ui, -apple-system, "Segoe UI", Roboto, "Helvetica Neue", Arial, sans-serif';
const MONO_TAIL = 'ui-monospace, "SFMono-Regular", "SF Mono", Menlo, Consolas, "Liberation Mono", monospace';

export const INTERFACE_FONTS: readonly FontEntry[] = [
  {
    id: "inter",
    family: "Inter",
    kind: "sans",
    source: "self-hosted",
    note: "Drawn for screens at 12–14px. The default.",
    fallback: { local: "Arial", sizeAdjust: "107.12%", ascentOverride: "90.44%", descentOverride: "22.52%", lineGapOverride: "0%" },
  },
  {
    id: "ibm-plex-sans",
    family: "IBM Plex Sans",
    kind: "sans",
    source: "google",
    axes: "wght@400..700",
    note: "Sturdy, a little formal; pairs with IBM Plex Mono.",
    fallback: { local: "Arial", sizeAdjust: "100.1%", ascentOverride: "102.6%", descentOverride: "27.6%", lineGapOverride: "0%" },
  },
  {
    id: "source-sans-3",
    family: "Source Sans 3",
    kind: "sans",
    source: "google",
    axes: "wght@400..700",
    note: "Narrow and quiet; fits more in a row.",
    fallback: { local: "Arial", sizeAdjust: "94.3%", ascentOverride: "108.9%", descentOverride: "30.2%", lineGapOverride: "0%" },
  },
  {
    id: "public-sans",
    family: "Public Sans",
    kind: "sans",
    source: "google",
    axes: "wght@400..700",
    note: "Neutral, built for government forms — very legible.",
    fallback: { local: "Arial", sizeAdjust: "104.2%", ascentOverride: "92.2%", descentOverride: "23.5%", lineGapOverride: "0%" },
  },
  {
    id: "figtree",
    family: "Figtree",
    kind: "sans",
    source: "google",
    axes: "wght@400..700",
    note: "Rounder and friendlier.",
    fallback: { local: "Arial", sizeAdjust: "101.4%", ascentOverride: "93.7%", descentOverride: "24.6%", lineGapOverride: "0%" },
  },
  {
    id: "atkinson-hyperlegible",
    family: "Atkinson Hyperlegible",
    kind: "sans",
    source: "google",
    axes: "wght@400;700",
    note: "Drawn for low vision: every glyph is unmistakable.",
    fallback: { local: "Arial", sizeAdjust: "102.5%", ascentOverride: "97.5%", descentOverride: "24.6%", lineGapOverride: "0%" },
  },
  {
    id: "host-grotesk",
    family: "Host Grotesk",
    kind: "sans",
    source: "self-hosted",
    note: "Characterful; the first design's face.",
    fallback: { local: "Arial" },
  },
  {
    id: "system-sans",
    family: "",
    kind: "sans",
    source: "system",
    note: "Whatever your device uses. No webfont.",
  },
];

export const CODE_FONTS: readonly FontEntry[] = [
  {
    id: "jetbrains-mono",
    family: "JetBrains Mono",
    kind: "mono",
    source: "self-hosted",
    note: "Tall x-height, unambiguous glyphs. The default.",
    fallback: { local: "Courier New", sizeAdjust: "100%", ascentOverride: "102%", descentOverride: "30%", lineGapOverride: "0%" },
  },
  {
    id: "ibm-plex-mono",
    family: "IBM Plex Mono",
    kind: "mono",
    source: "google",
    axes: "wght@400..600",
    note: "Pairs with IBM Plex Sans.",
    fallback: { local: "Courier New", sizeAdjust: "100%", ascentOverride: "102.6%", descentOverride: "27.6%", lineGapOverride: "0%" },
  },
  {
    id: "source-code-pro",
    family: "Source Code Pro",
    kind: "mono",
    source: "google",
    axes: "wght@400..600",
    note: "Light and open.",
    fallback: { local: "Courier New", sizeAdjust: "100%", ascentOverride: "98.4%", descentOverride: "27.3%", lineGapOverride: "0%" },
  },
  {
    id: "fira-code",
    family: "Fira Code",
    kind: "mono",
    source: "google",
    axes: "wght@400..600",
    note: "Programming ligatures for arrows and operators.",
    fallback: { local: "Courier New", sizeAdjust: "100%", ascentOverride: "93.5%", descentOverride: "24.6%", lineGapOverride: "0%" },
  },
  {
    id: "roboto-mono",
    family: "Roboto Mono",
    kind: "mono",
    source: "google",
    axes: "wght@400..600",
    note: "Plain and even.",
    fallback: { local: "Courier New", sizeAdjust: "100%", ascentOverride: "104.7%", descentOverride: "27.1%", lineGapOverride: "0%" },
  },
  {
    id: "martian-mono",
    family: "Martian Mono",
    kind: "mono",
    source: "self-hosted",
    note: "Wide and technical; the first design's code face.",
    fallback: { local: "Courier New" },
  },
  {
    id: "system-mono",
    family: "",
    kind: "mono",
    source: "system",
    note: "Your device's monospace. No webfont.",
  },
];

export const DEFAULT_FONTS = { sans: "inter", mono: "jetbrains-mono" } as const;

/**
 * Resolves a choice to a catalogue entry. An id that is not in the catalogue
 * is treated as a Google Fonts family name typed by the person.
 */
export function fontEntry(choice: FontChoice, kind: FontKind): FontEntry {
  const list = kind === "sans" ? INTERFACE_FONTS : CODE_FONTS;
  const known = list.find((f) => f.id === choice);
  if (known) return known;
  return {
    id: choice,
    family: choice,
    kind,
    source: "google",
    axes: kind === "sans" ? "wght@400..700" : "wght@400..600",
    note: "Custom family from Google Fonts.",
    fallback: { local: kind === "sans" ? "Arial" : "Courier New" },
  };
}

/** The full `font-family` value for a choice, real family first, tail last. */
export function fontStack(choice: FontChoice, kind: FontKind): string {
  const entry = fontEntry(choice, kind);
  const tail = kind === "sans" ? SANS_TAIL : MONO_TAIL;
  if (entry.source === "system" || !entry.family) return tail;
  const parts = [`"${entry.family}"`];
  if (entry.fallback?.sizeAdjust) parts.push(`"${entry.family} Fallback"`);
  return `${parts.join(", ")}, ${tail}`;
}

const FALLBACK_STYLE_ID = namespaced("font-fallbacks");
const GOOGLE_LINK_PREFIX = namespaced("font-");

function hasDom(): boolean {
  return typeof document !== "undefined";
}

/** `@font-face` for the metric-matched local fallback, or "" when no metrics are known. */
export function fallbackFace(entry: FontEntry): string {
  const f = entry.fallback;
  if (!f?.sizeAdjust || !entry.family) return "";
  const lines = [
    `font-family: "${entry.family} Fallback"`,
    `src: local("${f.local}")`,
    `size-adjust: ${f.sizeAdjust}`,
    f.ascentOverride ? `ascent-override: ${f.ascentOverride}` : "",
    f.descentOverride ? `descent-override: ${f.descentOverride}` : "",
    f.lineGapOverride ? `line-gap-override: ${f.lineGapOverride}` : "",
  ].filter(Boolean);
  return `@font-face { ${lines.join("; ")}; }`;
}

/** Google Fonts stylesheet URL for a family. */
export function googleFontsHref(entry: FontEntry): string {
  const family = entry.family.replace(/ /g, "+");
  const axes = entry.axes ? `:${entry.axes}` : "";
  return `https://fonts.googleapis.com/css2?family=${family}${axes}&display=swap`;
}

const injected = new Set<string>();

/**
 * Makes a font choice renderable: injects the fallback face once, and for a
 * Google family adds its stylesheet once. Self-hosted and system choices are
 * no-ops (their faces are in `globals.css` or the OS). Safe to call often.
 */
export function ensureFontLoaded(choice: FontChoice, kind: FontKind): void {
  if (!hasDom()) return;
  const entry = fontEntry(choice, kind);
  if (entry.source === "system") return;
  const key = `${kind}:${entry.id}`;
  if (injected.has(key)) return;
  injected.add(key);

  const face = fallbackFace(entry);
  if (face) {
    let style = document.getElementById(FALLBACK_STYLE_ID) as HTMLStyleElement | null;
    if (!style) {
      style = document.createElement("style");
      style.id = FALLBACK_STYLE_ID;
      document.head.appendChild(style);
    }
    if (!style.textContent?.includes(`"${entry.family} Fallback"`)) style.textContent += `${face}\n`;
  }

  if (entry.source === "google") {
    const id = `${GOOGLE_LINK_PREFIX}${entry.id}`;
    if (!document.getElementById(id)) {
      const link = document.createElement("link");
      link.id = id;
      link.rel = "stylesheet";
      link.href = googleFontsHref(entry);
      link.crossOrigin = "anonymous";
      document.head.appendChild(link);
    }
  }
}
