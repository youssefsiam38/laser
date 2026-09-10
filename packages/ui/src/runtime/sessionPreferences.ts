import { storageKey } from "@lasercode/protocol";
import { useCallback, useEffect, useState } from "react";

export type ActivityDetailLevel = "answers" | "reasoning" | "everything";

const PREFIX = storageKey("activity-detail:");
const EVENT = storageKey("session-preference");
const DISCLOSURE_KEY = storageKey("activity-disclosure-overrides");
const DISCLOSURE_EVENT = storageKey("activity-disclosure-override");
const MAX_DISCLOSURE_OVERRIDES = 400;
const LEVELS = new Set<ActivityDetailLevel>(["answers", "reasoning", "everything"]);

interface ActivityDisclosureOverride {
  path: string;
  id: string;
  open: boolean;
}

const validDisclosureOverride = (value: unknown): value is ActivityDisclosureOverride => {
  if (typeof value !== "object" || value === null) return false;
  const record = value as Record<string, unknown>;
  return typeof record["path"] === "string" && typeof record["id"] === "string" && typeof record["open"] === "boolean";
};

function activityDisclosureOverrides(): ActivityDisclosureOverride[] {
  try {
    const parsed: unknown = JSON.parse(globalThis.localStorage?.getItem(DISCLOSURE_KEY) ?? "[]");
    if (!Array.isArray(parsed)) return [];
    return parsed.filter(validDisclosureOverride).slice(-MAX_DISCLOSURE_OVERRIDES);
  } catch {
    return [];
  }
}

/** A manual row choice, scoped to one persisted session and stable row identity. */
export function activityDisclosureOverride(path: string | undefined, id: string | undefined): boolean | undefined {
  if (!path || !id) return undefined;
  const entries = activityDisclosureOverrides();
  for (let index = entries.length - 1; index >= 0; index--) {
    const entry = entries[index];
    if (entry?.path === path && entry.id === id) return entry.open;
  }
  return undefined;
}

/**
 * Remember the latest bounded set of manual choices. Moving an updated entry
 * to the end makes the bound an insertion-order LRU without timers or cleanup.
 */
export function setActivityDisclosureOverride(path: string, id: string, open: boolean): void {
  const next = activityDisclosureOverrides().filter((entry) => entry.path !== path || entry.id !== id);
  next.push({ path, id, open });
  try {
    globalThis.localStorage?.setItem(DISCLOSURE_KEY, JSON.stringify(next.slice(-MAX_DISCLOSURE_OVERRIDES)));
  } catch {
    // Private browsing can deny storage; this mounted row still receives the event.
  }
  globalThis.dispatchEvent?.(new CustomEvent(DISCLOSURE_EVENT, { detail: { path, id, open } }));
}

/** Manual state survives streaming, preference changes, unmounts and restoration. */
export function useActivityDisclosureOverride(
  path: string | undefined,
  id: string | undefined,
): readonly [boolean | undefined, (open: boolean) => void] {
  // Tie the rendered value to its scope synchronously. Navigation can reuse a
  // component before effects run; the prior session must never flash here.
  const scope = path && id ? `${path}\0${id}` : undefined;
  const [state, setState] = useState<{ scope: string | undefined; open: boolean | undefined }>(() => ({
    scope,
    open: activityDisclosureOverride(path, id),
  }));
  const open = state.scope === scope ? state.open : activityDisclosureOverride(path, id);
  useEffect(() => {
    setState({ scope, open: activityDisclosureOverride(path, id) });
    const listener = (event: Event) => {
      const detail = (event as CustomEvent<ActivityDisclosureOverride>).detail;
      if (detail?.path === path && detail.id === id) setState({ scope, open: detail.open });
    };
    globalThis.addEventListener?.(DISCLOSURE_EVENT, listener);
    return () => globalThis.removeEventListener?.(DISCLOSURE_EVENT, listener);
  }, [path, id, scope]);
  const remember = useCallback(
    (next: boolean) => {
      setState({ scope, open: next });
      if (path && id) setActivityDisclosureOverride(path, id, next);
    },
    [path, id, scope],
  );
  return [open, remember] as const;
}

/** A new session starts quiet; its live summary still says what is happening. */
export function activityDetailLevel(path: string | undefined): ActivityDetailLevel {
  if (!path) return "answers";
  try {
    const value = globalThis.localStorage?.getItem(`${PREFIX}${path}`);
    return LEVELS.has(value as ActivityDetailLevel) ? (value as ActivityDetailLevel) : "answers";
  } catch {
    return "answers";
  }
}

export function setActivityDetailLevel(path: string, level: ActivityDetailLevel): void {
  try {
    globalThis.localStorage?.setItem(`${PREFIX}${path}`, level);
  } catch {
    // Private browsing can deny storage; this tab still receives the event.
  }
  globalThis.dispatchEvent?.(new CustomEvent(EVENT, { detail: { path, level } }));
}

export function useActivityDetailLevel(path: string | undefined): ActivityDetailLevel {
  const [level, setLevel] = useState(() => activityDetailLevel(path));
  useEffect(() => {
    setLevel(activityDetailLevel(path));
    const listener = (event: Event) => {
      const detail = (event as CustomEvent<{ path: string; level: ActivityDetailLevel }>).detail;
      if (detail?.path === path) setLevel(detail.level);
    };
    globalThis.addEventListener?.(EVENT, listener);
    return () => globalThis.removeEventListener?.(EVENT, listener);
  }, [path]);
  return level;
}

/** Only an explicit Everything choice opens an untouched aggregate. */
export function activityGroupDefaultOpen(
  level: ActivityDetailLevel,
  _hasReasoning: boolean,
  _needsAttention: boolean,
): boolean {
  return level === "everything";
}

export function toolDetailsDefaultOpen(level: ActivityDetailLevel): boolean {
  return level === "everything";
}
