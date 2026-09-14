import { storageKey } from "@lasercode/protocol";
import { useCallback, useEffect, useState } from "react";

import { DEVICE_KEYS, deviceStore } from "./device-storage.js";

export type ActivityDetailLevel = "answers" | "reasoning" | "everything";

/**
 * Both records name the session they belong to, so both live inside this
 * environment's namespace (RP-13) and both are one bounded key rather than a
 * key per session path. The two event names are DOM events, not storage.
 */
const EVENT = storageKey("session-preference");
const DISCLOSURE_EVENT = storageKey("activity-disclosure-override");
const MAX_DISCLOSURE_OVERRIDES = 400;
const MAX_DETAIL_LEVELS = 400;
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
  const parsed = deviceStore.readJson(DEVICE_KEYS.activityDisclosure, (value) => (Array.isArray(value) ? value : undefined));
  return (parsed ?? []).filter(validDisclosureOverride).slice(-MAX_DISCLOSURE_OVERRIDES);
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
  deviceStore.writeJson(DEVICE_KEYS.activityDisclosure, next.slice(-MAX_DISCLOSURE_OVERRIDES));
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
const detailLevels = (): Record<string, string> =>
  deviceStore.readJson(DEVICE_KEYS.activityDetail, (value) =>
    value && typeof value === "object" && !Array.isArray(value) ? (value as Record<string, string>) : undefined) ?? {};

export function activityDetailLevel(path: string | undefined): ActivityDetailLevel {
  if (!path) return "answers";
  const value = detailLevels()[path];
  return LEVELS.has(value as ActivityDetailLevel) ? (value as ActivityDetailLevel) : "answers";
}

export function setActivityDetailLevel(path: string, level: ActivityDetailLevel): void {
  const { [path]: _previous, ...rest } = detailLevels();
  // Insertion order is the bound: the oldest choice leaves when the newest
  // arrives, so a long-lived browser never grows a row per session it showed.
  const entries = [...Object.entries(rest), [path, level] as const].slice(-MAX_DETAIL_LEVELS);
  deviceStore.writeJson(DEVICE_KEYS.activityDetail, Object.fromEntries(entries));
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
