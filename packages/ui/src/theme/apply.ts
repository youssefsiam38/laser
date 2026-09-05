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
    return blob as BootBlob;
  } catch {
    return null;
  }
}

export function writeBootBlob(blob: BootBlob): void {
  if (typeof localStorage === "undefined") return;
  try {
    localStorage.setItem(THEME_STORAGE_KEY, JSON.stringify(blob));
  } catch {
    /* storage unavailable: the theme still applies for this page */
  }
}

/** For tests: the last text written to the style element. */
export function lastAppliedCss(): string {
  return lastCss;
}
