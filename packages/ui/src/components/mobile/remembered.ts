import { storageKey } from "@piorbit/protocol";
import { useCallback, useSyncExternalStore } from "react";

/**
 * Dismissals a phone should remember: the insecure-origin notice for this
 * origin, the install sheet for a fortnight. localStorage never throws here
 * (private mode, quota, SSR): failure means "not remembered", which shows the
 * thing again, which is the safe direction.
 */

const listeners = new Set<() => void>();

function read(key: string): string | undefined {
  try {
    return globalThis.localStorage?.getItem(key) ?? undefined;
  } catch {
    return undefined;
  }
}

function write(key: string, value: string | undefined): void {
  try {
    if (value === undefined) globalThis.localStorage?.removeItem(key);
    else globalThis.localStorage?.setItem(key, value);
  } catch {
    /* ignore */
  }
  for (const l of listeners) l();
}

/** True while the dismissal is in force. */
export function isDismissed(key: string, now = Date.now()): boolean {
  const raw = read(key);
  if (raw === undefined) return false;
  const until = Number(raw);
  return !Number.isFinite(until) || until > now;
}

/** `ttlMs` undefined = forever. */
export function dismiss(key: string, ttlMs?: number, now = Date.now()): void {
  write(key, ttlMs === undefined ? "forever" : String(now + ttlMs));
}

export function undismiss(key: string): void {
  write(key, undefined);
}

function subscribe(cb: () => void): () => void {
  listeners.add(cb);
  return () => listeners.delete(cb);
}

export function useDismissed(key: string): [dismissed: boolean, dismiss: (ttlMs?: number) => void] {
  const dismissed = useSyncExternalStore(subscribe, () => isDismissed(key), () => false);
  const set = useCallback((ttlMs?: number) => dismiss(key, ttlMs), [key]);
  return [dismissed, set];
}

export const INSECURE_KEY = (origin: string): string => storageKey(`mobile-insecure-dismissed:${origin}`);
export const INSTALL_KEY = storageKey("mobile-install-dismissed");
export const NOTIFY_HINT_KEY = storageKey("mobile-notify-hint-dismissed");
export const FORTNIGHT_MS = 14 * 24 * 60 * 60 * 1000;
