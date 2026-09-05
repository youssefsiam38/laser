/**
 * The theme store: one module-level source of truth, framework-free, with a
 * `useSyncExternalStore`-shaped subscription for React (`use-theme.ts`).
 *
 * State is a `Theme` plus two things a theme cannot hold about itself: whether
 * to follow the OS colour scheme, and which preset to use for each base when
 * it does. Knobs (fonts, text size, density, corners, contrast, motion) belong
 * to the person, not the preset: switching presets keeps them.
 *
 * Persistence is in two places, on purpose. `localStorage` (`laser.theme`)
 * holds the shape the boot script in `index.html` replays before first paint,
 * so a reload never flashes. The host holds the same state in its own
 * `theme` preference namespace (`pi/prefs/*`, M11-T6), which is what makes the
 * theme a property of your laser rather than of one browser: a paired phone
 * opens wearing what the desktop wears. `hydrate` and `subscribe` are the seam
 * the sync uses; see `runtime/prefs.ts`.
 */
import { THEME_STORAGE_KEY, applyCompiled, bootEntry, readBootBlob, type BootBlob, writeBootBlob } from "./apply.js";
import { compileTheme } from "./compile.js";
import { ensureFontLoaded } from "./fonts.js";
import { isApplicable } from "./guard.js";
import { DEFAULT_LIGHT_PRESET_ID, DEFAULT_PRESET, DEFAULT_PRESET_ID, getPreset, presetsFor } from "./presets.js";
import type { CompiledTheme, Theme, ThemeBase, ThemePreset } from "./types.js";

export type ThemeState = {
  theme: Theme;
  followSystem: boolean;
  pair: { dark: string; light: string };
};

/**
 * `followSystem: true` is the default because a person who has set their
 * desktop to light has already answered this question. Opening laser for the
 * first time on a light desktop and getting a dark window is the app telling
 * them their preference does not count. Picking a preset in Settings turns it
 * off (`setPreset`), which is the moment they *did* answer it here.
 */
export const DEFAULT_STATE: ThemeState = {
  theme: stripTagline(DEFAULT_PRESET),
  followSystem: true,
  pair: { dark: DEFAULT_PRESET_ID, light: DEFAULT_LIGHT_PRESET_ID },
};

const DARK_QUERY = "(prefers-color-scheme: dark)";
const REDUCED_MOTION_QUERY = "(prefers-reduced-motion: reduce)";
const listeners = new Set<() => void>();
let state: ThemeState = DEFAULT_STATE;
let compiled: CompiledTheme = compileTheme(state.theme);
let initialised = false;

function stripTagline(preset: ThemePreset): Theme {
  const { tagline: _tagline, ...theme } = preset;
  return theme;
}

/**
 * The OS asked for less motion. It wins over whatever the theme says, and it
 * is never written back: the person's own Motion knob keeps its value, so
 * turning the OS switch off restores the animation they chose.
 */
function systemReducedMotion(): boolean {
  if (typeof window === "undefined" || typeof window.matchMedia !== "function") return false;
  return window.matchMedia(REDUCED_MOTION_QUERY).matches;
}

function systemBase(): ThemeBase {
  if (typeof window === "undefined" || typeof window.matchMedia !== "function") return "dark";
  return window.matchMedia(DARK_QUERY).matches ? "dark" : "light";
}

/** The preset the pair names for a base, falling back to the first of that base. */
function pairedPreset(s: ThemeState, base: ThemeBase): ThemePreset {
  return getPreset(s.pair[base]) ?? presetsFor(base)[0] ?? DEFAULT_PRESET;
}

/** A preset's design with the person's knobs kept. */
function withKnobs(preset: ThemePreset, from: Theme, adoptFonts: boolean): Theme {
  return {
    id: preset.id,
    name: preset.name,
    base: preset.base,
    tokens: { ...preset.tokens },
    fonts: adoptFonts ? { ...preset.fonts } : { ...from.fonts },
    textSize: from.textSize,
    density: from.density,
    radius: from.radius,
    contrast: preset.contrast === "high" ? "high" : from.contrast,
    motion: from.motion,
  };
}

function isThemeState(x: unknown): x is ThemeState {
  if (!x || typeof x !== "object") return false;
  const s = x as Partial<ThemeState>;
  return !!s.theme && typeof s.theme === "object" && typeof s.followSystem === "boolean" && !!s.pair;
}

function emit(): void {
  for (const l of listeners) l();
}

function commit(next: ThemeState, persist = true): void {
  const resolved: ThemeState = next.followSystem
    ? { ...next, theme: withKnobs(pairedPreset(next, systemBase()), next.theme, false) }
    : next;
  if (!isApplicable(resolved.theme)) return; // an editor shows the issue; the page keeps the last good theme
  state = resolved;
  compiled = compileTheme(state.theme);
  // The compiled theme is written to `:root[data-theme]`, which outranks the
  // `@media (prefers-reduced-motion)` block on bare `:root` — so the OS
  // preference has to be folded in here or it never reaches the tokens at
  // all. What is *persisted* stays the person's own theme.
  const applied = systemReducedMotion() && state.theme.motion !== "reduced" ? compileTheme({ ...state.theme, motion: "reduced" }) : compiled;
  ensureFontLoaded(state.theme.fonts.sans, "sans");
  ensureFontLoaded(state.theme.fonts.mono, "mono");
  applyCompiled(bootEntry(applied));
  if (persist) writeBootBlob(toBlob(state, compiled));
  emit();
}

function toBlob(s: ThemeState, active: CompiledTheme): BootBlob {
  const dark = s.theme.base === "dark" ? active : compileTheme(withKnobs(pairedPreset(s, "dark"), s.theme, false));
  const light = s.theme.base === "light" ? active : compileTheme(withKnobs(pairedPreset(s, "light"), s.theme, false));
  return { v: 1, followSystem: s.followSystem, active: bootEntry(active), dark: bootEntry(dark), light: bootEntry(light), state: s };
}

let wired = false;
function wireGlobalListeners(): void {
  if (wired || typeof window === "undefined") return;
  wired = true;
  if (typeof window.matchMedia === "function") {
    window.matchMedia(DARK_QUERY).addEventListener("change", () => {
      if (state.followSystem) commit(state);
    });
    // Toggling the OS switch re-applies the tokens immediately, both ways.
    window.matchMedia(REDUCED_MOTION_QUERY).addEventListener("change", () => commit(state, false));
  }
  window.addEventListener("storage", (e) => {
    if (e.key !== null && e.key !== THEME_STORAGE_KEY) return;
    const blob = readBootBlob();
    if (blob && isThemeState(blob.state)) commit(blob.state, false);
  });
}

export const themeStore = {
  /**
   * Called once from `main.tsx`. Reads what the boot script read, applies it
   * through the real compiler (a no-op when the boot script already wrote the
   * same text), and starts listening to the OS and other tabs.
   */
  init(): void {
    if (initialised) return;
    initialised = true;
    wireGlobalListeners();
    const blob = readBootBlob();
    commit(blob && isThemeState(blob.state) ? blob.state : DEFAULT_STATE, !blob);
  },

  getState: (): ThemeState => state,
  getTheme: (): Theme => state.theme,
  getCompiled: (): CompiledTheme => compiled,

  /** Replaces the whole theme. Refused (returns false) when the guard finds an error. */
  setTheme(theme: Theme): boolean {
    if (!isApplicable(theme)) return false;
    const pair = { ...state.pair };
    if (getPreset(theme.id)) pair[theme.base] = theme.id;
    commit({ ...state, theme, followSystem: state.followSystem && !!getPreset(theme.id), pair });
    return true;
  },

  /** Merges a partial edit. Editing a token by hand turns the id into "custom". */
  updateTheme(patch: Partial<Omit<Theme, "tokens">> & { tokens?: Partial<Theme["tokens"]> }): boolean {
    const { tokens, ...rest } = patch;
    const next: Theme = { ...state.theme, ...rest, tokens: { ...state.theme.tokens, ...(tokens ?? {}) } };
    if (tokens && Object.keys(tokens).length) {
      next.id = "custom";
      next.name = "Custom";
    }
    return themeStore.setTheme(next);
  },

  /** Switches to a preset, keeping the person's knobs unless `adoptFonts`. */
  setPreset(id: string, opts: { adoptFonts?: boolean } = {}): boolean {
    const preset = getPreset(id);
    if (!preset) return false;
    const pair = { ...state.pair, [preset.base]: preset.id };
    commit({ ...state, theme: withKnobs(preset, state.theme, opts.adoptFonts ?? false), pair });
    return true;
  },

  /** Flips to the paired preset of the other base and stops following the system. */
  toggleBase(): ThemeBase {
    const base: ThemeBase = state.theme.base === "dark" ? "light" : "dark";
    const preset = pairedPreset(state, base);
    commit({ ...state, followSystem: false, theme: withKnobs(preset, state.theme, false) });
    return base;
  },

  setFollowSystem(on: boolean): void {
    commit({ ...state, followSystem: on });
  },

  /** Replaces state from elsewhere (settings sync). Invalid input is ignored. */
  hydrate(next: unknown): boolean {
    if (!isThemeState(next)) return false;
    commit(next);
    return true;
  },

  /** Back to a fresh install. */
  reset(): void {
    commit(DEFAULT_STATE);
  },

  subscribe(cb: () => void): () => void {
    wireGlobalListeners();
    listeners.add(cb);
    return () => {
      listeners.delete(cb);
    };
  },
};
