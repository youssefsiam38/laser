import { useCallback, useSyncExternalStore } from "react";

import { PRESETS } from "./presets.js";
import { themeStore, type ThemeState } from "./store.js";
import type { CompiledTheme, Theme, ThemeBase, ThemePreset } from "./types.js";

export type UseTheme = {
  /** The theme as applied (after follow-the-system resolution). */
  theme: Theme;
  base: ThemeBase;
  /** The custom properties currently on the page. */
  compiled: CompiledTheme;
  followSystem: boolean;
  textDirection: ThemeState["textDirection"];
  setTextDirection: typeof themeStore.setTextDirection;
  pair: ThemeState["pair"];
  presets: readonly ThemePreset[];
  setTheme: typeof themeStore.setTheme;
  updateTheme: typeof themeStore.updateTheme;
  setPreset: typeof themeStore.setPreset;
  toggleBase: typeof themeStore.toggleBase;
  setFollowSystem: typeof themeStore.setFollowSystem;
  reset: typeof themeStore.reset;
};

const serverState = (): ThemeState => themeStore.getState();

/** Reactive view of the theme store, for Settings → Appearance and anything that needs the base. */
export function useTheme(): UseTheme {
  const state = useSyncExternalStore(themeStore.subscribe, themeStore.getState, serverState);
  const compiled = useSyncExternalStore(themeStore.subscribe, themeStore.getCompiled, themeStore.getCompiled);
  const setTheme = useCallback<typeof themeStore.setTheme>((t) => themeStore.setTheme(t), []);
  const updateTheme = useCallback<typeof themeStore.updateTheme>((p) => themeStore.updateTheme(p), []);
  const setPreset = useCallback<typeof themeStore.setPreset>((id, o) => themeStore.setPreset(id, o), []);
  const toggleBase = useCallback(() => themeStore.toggleBase(), []);
  const setFollowSystem = useCallback((on: boolean) => themeStore.setFollowSystem(on), []);
  const reset = useCallback(() => themeStore.reset(), []);
  return {
    theme: state.theme,
    base: state.theme.base,
    compiled,
    followSystem: state.followSystem,
    textDirection: state.textDirection,
    setTextDirection: themeStore.setTextDirection,
    pair: state.pair,
    presets: PRESETS,
    setTheme,
    updateTheme,
    setPreset,
    toggleBase,
    setFollowSystem,
    reset,
  };
}

/** Just the base, for the few components that branch on dark vs light (sonner, the highlighter). */
export function useThemeBase(): ThemeBase {
  return useSyncExternalStore(themeStore.subscribe, () => themeStore.getTheme().base, () => themeStore.getTheme().base);
}
