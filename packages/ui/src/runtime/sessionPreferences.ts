import { storageKey } from "@lasercode/protocol";
import { useEffect, useState } from "react";

const PREFIX = storageKey("reasoning-expanded:");
const EVENT = "laser:session-preference";

export function reasoningExpanded(path: string | undefined): boolean {
  if (!path) return true;
  try {
    return globalThis.localStorage?.getItem(`${PREFIX}${path}`) !== "false";
  } catch {
    return true;
  }
}

export function setReasoningExpanded(path: string, expanded: boolean): void {
  try {
    globalThis.localStorage?.setItem(`${PREFIX}${path}`, String(expanded));
  } catch {
    // Private browsing can deny storage; this tab still receives the event.
  }
  globalThis.dispatchEvent?.(new CustomEvent(EVENT, { detail: { path, expanded } }));
}

export function useReasoningExpanded(path: string | undefined): boolean {
  const [expanded, setExpanded] = useState(() => reasoningExpanded(path));
  useEffect(() => {
    setExpanded(reasoningExpanded(path));
    const listener = (event: Event) => {
      const detail = (event as CustomEvent<{ path: string; expanded: boolean }>).detail;
      if (detail?.path === path) setExpanded(detail.expanded);
    };
    globalThis.addEventListener?.(EVENT, listener);
    return () => globalThis.removeEventListener?.(EVENT, listener);
  }, [path]);
  return expanded;
}
