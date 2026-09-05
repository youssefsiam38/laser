/**
 * Compatibility view of the theme store for the rail toggle, sonner and the
 * highlighter: a two-state "dark" | "light" plus a toggle. The real system is
 * `@/theme` (docs/ux-theme.md); new code should import `useTheme` from there.
 */
import { useCallback } from "react";

import { themeStore } from "@/theme/store";
import { useTheme as useFullTheme } from "@/theme/use-theme";

export type Theme = "light" | "dark";
export type ThemePreference = Theme | "system";

export { THEME_STORAGE_KEY } from "@/theme/apply";

/** Resolved base currently applied. */
export function resolveTheme(): Theme {
  return themeStore.getTheme().base;
}

/** "system" while following the OS, otherwise the applied base. */
export function getThemePreference(): ThemePreference {
  const s = themeStore.getState();
  return s.followSystem ? "system" : s.theme.base;
}

export function setThemePreference(pref: ThemePreference): void {
  if (pref === "system") {
    themeStore.setFollowSystem(true);
    return;
  }
  const s = themeStore.getState();
  if (s.followSystem) themeStore.setFollowSystem(false);
  if (themeStore.getTheme().base !== pref) themeStore.toggleBase();
}

export function toggleTheme(): Theme {
  return themeStore.toggleBase();
}

export interface UseTheme {
  /** Resolved base currently applied. */
  theme: Theme;
  /** "system" while following the OS. */
  preference: ThemePreference;
  setTheme: (pref: ThemePreference) => void;
  toggle: () => void;
}

export function useTheme(): UseTheme {
  const { base, followSystem, toggleBase } = useFullTheme();
  const setTheme = useCallback((pref: ThemePreference) => setThemePreference(pref), []);
  const toggle = useCallback(() => {
    toggleBase();
  }, [toggleBase]);
  return { theme: base, preference: followSystem ? "system" : base, setTheme, toggle };
}
