import { useCallback, useSyncExternalStore } from "react";

export type Theme = "light" | "dark";
export type ThemePreference = Theme | "system";

export const THEME_STORAGE_KEY = "piorbit-theme";

const DARK_QUERY = "(prefers-color-scheme: dark)";
const listeners = new Set<() => void>();

function hasDom(): boolean {
  return typeof window !== "undefined" && typeof document !== "undefined";
}

/** Persisted preference; "system" when nothing (valid) is stored. */
export function getThemePreference(): ThemePreference {
  if (!hasDom()) return "system";
  try {
    const raw = window.localStorage.getItem(THEME_STORAGE_KEY);
    return raw === "dark" || raw === "light" ? raw : "system";
  } catch {
    return "system";
  }
}

function systemTheme(): Theme {
  if (!hasDom() || typeof window.matchMedia !== "function") return "light";
  return window.matchMedia(DARK_QUERY).matches ? "dark" : "light";
}

/** Resolved theme: the preference, or the OS theme when the preference is "system". */
export function resolveTheme(pref: ThemePreference = getThemePreference()): Theme {
  return pref === "system" ? systemTheme() : pref;
}

/** Applies `.dark` on <html> and syncs `color-scheme`. Idempotent. */
export function applyTheme(theme: Theme): void {
  if (!hasDom()) return;
  const root = document.documentElement;
  root.classList.toggle("dark", theme === "dark");
  root.style.colorScheme = theme;
}

function emit(): void {
  for (const l of listeners) l();
}

/** Persists the preference ("system" clears storage), applies it, notifies subscribers. */
export function setThemePreference(pref: ThemePreference): void {
  try {
    if (pref === "system") window.localStorage.removeItem(THEME_STORAGE_KEY);
    else window.localStorage.setItem(THEME_STORAGE_KEY, pref);
  } catch {
    /* storage unavailable: still apply for this page */
  }
  applyTheme(resolveTheme(pref));
  emit();
}

/** Flips light <-> dark from the currently resolved theme. */
export function toggleTheme(): Theme {
  const next: Theme = resolveTheme() === "dark" ? "light" : "dark";
  setThemePreference(next);
  return next;
}

let wired = false;
function wireGlobalListeners(): void {
  if (wired || !hasDom()) return;
  wired = true;
  // OS theme changes matter only while the preference is "system".
  if (typeof window.matchMedia === "function") {
    window.matchMedia(DARK_QUERY).addEventListener("change", () => {
      if (getThemePreference() === "system") applyTheme(systemTheme());
      emit();
    });
  }
  // Another tab changed the stored preference.
  window.addEventListener("storage", (e) => {
    if (e.key === THEME_STORAGE_KEY || e.key === null) {
      applyTheme(resolveTheme());
      emit();
    }
  });
}

function subscribe(cb: () => void): () => void {
  wireGlobalListeners();
  listeners.add(cb);
  return () => listeners.delete(cb);
}

export interface UseTheme {
  /** Resolved theme currently applied. */
  theme: Theme;
  /** Persisted preference. */
  preference: ThemePreference;
  setTheme: (pref: ThemePreference) => void;
  toggle: () => void;
}

/**
 * Theme state for the rail toggle. `index.html` applies the class before first
 * paint; this hook keeps it in sync afterwards (OS changes, other tabs).
 */
export function useTheme(): UseTheme {
  const theme = useSyncExternalStore(subscribe, resolveTheme, () => "light" as Theme);
  const preference = useSyncExternalStore(
    subscribe,
    getThemePreference,
    () => "system" as ThemePreference,
  );
  const setTheme = useCallback((pref: ThemePreference) => setThemePreference(pref), []);
  const toggle = useCallback(() => {
    toggleTheme();
  }, []);
  return { theme, preference, setTheme, toggle };
}
