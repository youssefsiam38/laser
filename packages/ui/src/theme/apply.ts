/**
 * The runtime applier. One style write, no reload, no remount, no flash.
 *
 * The compiled declarations go into a single `<style id="laser-theme">`
 * whose selector is `:root[data-theme]`. That beats the `:root` defaults in
 * `globals.css` on specificity, so it wins regardless of where Vite inserts
 * the stylesheet (dev injects late), and it leaves the root's inline `style`
 * alone for the properties other code owns there (`--kb`, `--vvh`).
 *
 * The same shape is persisted for the inline boot script in `index.html`,
 * which replays it before first paint without knowing anything about themes.
 */
import { dottedStorageKey, namespaced } from "@lasercode/protocol";
import { STARTUP_SCREEN_TOKEN_NAMES } from "@lasercode/protocol/startup-screen";
import type { CompiledTheme, ThemeBase } from "./types.js";

export const THEME_STYLE_ID = namespaced("theme");
export const THEME_STORAGE_KEY = dottedStorageKey("theme");
export const THEME_SELECTOR = ":root[data-theme]";

/** What the boot script reads. Versioned so a stale blob is ignored, not misread. */
export type BootBlob = {
  v: 1;
  followSystem: boolean;
  /** Applied when not following the system. */
  active: BootEntry;
  /** Applied by `prefers-color-scheme` when following the system. */
  dark: BootEntry;
  light: BootEntry;
  /** Opaque store state, round-tripped by the store; the boot script ignores it. */
  state?: unknown;
};

export type BootEntry = { id: string; base: ThemeBase; bg: string; css: string };

export function bootEntry(compiled: CompiledTheme): BootEntry {
  return { id: compiled.id, base: compiled.base, bg: compiled.vars["--bg"] ?? "", css: compiled.css };
}

function hasDom(): boolean {
  return typeof document !== "undefined";
}

let lastCss = "";

/**
 * Writes a compiled theme to the page. Idempotent: applying the same theme
 * twice touches nothing, so the boot script's work is not redone on mount.
 */
export function applyCompiled(entry: BootEntry): void {
  if (!hasDom()) return;
  const root = document.documentElement;
  const text = `${THEME_SELECTOR} { ${entry.css} }`;
  let style = document.getElementById(THEME_STYLE_ID) as HTMLStyleElement | null;
  if (!style) {
    style = document.createElement("style");
    style.id = THEME_STYLE_ID;
    document.head.appendChild(style);
  }
  if (style.textContent !== text) {
    style.textContent = text;
    lastCss = text;
  }
  if (root.dataset["theme"] !== entry.id) root.dataset["theme"] = entry.id;
  if (root.dataset["base"] !== entry.base) root.dataset["base"] = entry.base;
  root.classList.toggle("dark", entry.base === "dark");
  setThemeColorMeta(entry.bg);
}

/** Keeps the browser chrome (PWA title bar, mobile status bar) on the page ground. */
function setThemeColorMeta(bg: string): void {
  if (!bg) return;
  const metas = document.querySelectorAll<HTMLMetaElement>('meta[name="theme-color"]');
  for (const m of metas) if (m.content !== bg) m.content = bg;
}

export function readBootBlob(): BootBlob | null {
  if (typeof localStorage === "undefined") return null;
  try {
    const raw = localStorage.getItem(THEME_STORAGE_KEY);
    if (!raw) return null;
    const blob = JSON.parse(raw) as Partial<BootBlob>;
    if (blob.v !== 1 || !blob.active || !blob.dark || !blob.light) return null;
    // Also on the way in, not only when a theme is written: a person who chose
    // their theme long ago would otherwise wait for the next change before the
    // shell learned what to paint the opening screen with.
    reportStartupGround(blob as BootBlob);
    return blob as BootBlob;
  } catch {
    return null;
  }
}

export function writeBootBlob(blob: BootBlob): void {
  reportStartupGround(blob);
  if (typeof localStorage === "undefined") return;
  try {
    localStorage.setItem(THEME_STORAGE_KEY, JSON.stringify(blob));
  } catch {
    /* storage unavailable: the theme still applies for this page */
  }
}

/**
 * The desktop shell shows the opening screen before this page exists, from a
 * document with an opaque origin that cannot read `localStorage`. So the same
 * few declarations that screen needs go to the main process as well, and it
 * keeps them beside the window state — a person who chose Paper sees Paper
 * while the host starts, not the default preset followed by a colour change.
 *
 * The first launch of all has nothing recorded and gets the default presets,
 * which is exactly what the app is about to paint anyway.
 */
type DesktopThemeSink = { setTheme(base: ThemeBase, ground?: StartupGroundRecord): void };

export type StartupGroundRecord = {
  followSystem: boolean;
  active: Record<string, string>;
  dark: Record<string, string>;
  light: Record<string, string>;
};

function reportStartupGround(blob: BootBlob): void {
  const desktop = (globalThis as typeof globalThis & { desktop?: DesktopThemeSink }).desktop;
  if (!desktop || typeof desktop.setTheme !== "function") return;
  try {
    desktop.setTheme(blob.active.base, {
      followSystem: blob.followSystem,
      active: startupTokensOf(blob.active.css),
      dark: startupTokensOf(blob.dark.css),
      light: startupTokensOf(blob.light.css),
    });
  } catch {
    /* the opening screen falls back to the default presets */
  }
}

/** The declarations the opening screen reads, picked out of a compiled theme. */
export function startupTokensOf(css: string): Record<string, string> {
  const found: Record<string, string> = {};
  for (const name of STARTUP_SCREEN_TOKEN_NAMES) {
    // `--text-xl` must not match `--text-xl--line-height`: the colon is what
    // ends the name, so it is part of the pattern.
    const match = new RegExp(`(?:^|;)\\s*${name.replaceAll("-", "\\-")}\\s*:\\s*([^;]+)`).exec(css);
    if (match?.[1]) found[name] = match[1].trim();
  }
  return found;
}

/** For tests: the last text written to the style element. */
export function lastAppliedCss(): string {
  return lastCss;
}
