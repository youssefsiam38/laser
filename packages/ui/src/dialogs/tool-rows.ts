"use client";
import { createContext, createElement, useContext, useEffect, useMemo, useSyncExternalStore, type ReactNode } from "react";

/** Mounted placement belongs to a rendered scope, not to the canonical request. */
class ToolRows {
  counts = new Map<string, number>();
  snapshot: ReadonlySet<string> = new Set();
  listeners = new Set<() => void>();
  publish() { this.snapshot = new Set(this.counts.keys()); for (const listener of this.listeners) listener(); }
  subscribe = (listener: () => void) => { this.listeners.add(listener); return () => { this.listeners.delete(listener); }; };
  getSnapshot = () => this.snapshot;
}
const standalone = new ToolRows();
const Context = createContext(standalone);
export function ToolRowScope({ children, scope = "" }: { children: ReactNode; scope?: string }) {
  const store = useMemo(() => new ToolRows(), [scope]);
  return createElement(Context.Provider, { value: store }, children);
}
export function useToolRowIds(): ReadonlySet<string> {
  const store = useContext(Context);
  return useSyncExternalStore(store.subscribe, store.getSnapshot, store.getSnapshot);
}
export function useRegisterToolRow(toolCallId: string | undefined): void {
  const store = useContext(Context);
  useEffect(() => {
    if (!toolCallId) return;
    store.counts.set(toolCallId, (store.counts.get(toolCallId) ?? 0) + 1); store.publish();
    return () => {
      const next = (store.counts.get(toolCallId) ?? 1) - 1;
      if (next <= 0) store.counts.delete(toolCallId); else store.counts.set(toolCallId, next);
      store.publish();
    };
  }, [store, toolCallId]);
}
export function resetToolRows(): void { standalone.counts.clear(); standalone.publish(); }
