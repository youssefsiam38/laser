import { storageKey } from "@lasercode/protocol";
import { useEffect, useState } from "react";

export type ActivityDetailLevel = "answers" | "reasoning" | "everything";

const PREFIX = storageKey("activity-detail:");
const EVENT = storageKey("session-preference");
const LEVELS = new Set<ActivityDetailLevel>(["answers", "reasoning", "everything"]);

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

/** Errors and decisions remain visible regardless of a quiet preference. */
export function activityGroupDefaultOpen(
  level: ActivityDetailLevel,
  _hasReasoning: boolean,
  needsAttention: boolean,
): boolean {
  return needsAttention || level === "everything";
}

export function toolDetailsDefaultOpen(level: ActivityDetailLevel): boolean {
  return level === "everything";
}
