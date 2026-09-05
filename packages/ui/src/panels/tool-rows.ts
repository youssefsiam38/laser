"use client";
/**
 * Which tool rows are on screen right now.
 *
 * The placement table gives `decision × inline` exactly one cell — "inline, in
 * its tool row" — and that placement is only correct when the row is actually
 * rendered: a tool call scrolled out of a virtualised transcript, or a
 * decision whose `toolCallId` names a call from an earlier turn, has no row to
 * live in and must fall back to the card above the composer rather than
 * disappear.
 *
 * So the rows register themselves here as they mount, and `placementOf` is
 * asked with the answer. A tiny external store rather than context: a tool row
 * is a leaf far below the panel provider, and re-rendering the whole decision
 * surface on every tool mount would be worse than the problem.
 */
import { useEffect, useSyncExternalStore } from "react";

const counts = new Map<string, number>();
let snapshot: ReadonlySet<string> = new Set();
const listeners = new Set<() => void>();

function publish(): void {
  snapshot = new Set(counts.keys());
  for (const listener of [...listeners]) listener();
}

function subscribe(listener: () => void): () => void {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

/** Mounted tool-call ids. Stable identity while nothing mounted or unmounted. */
export function useToolRowIds(): ReadonlySet<string> {
  return useSyncExternalStore(subscribe, () => snapshot, () => snapshot);
}

/** A tool row declares itself while it is on screen. Reference-counted: React may mount twice in strict mode. */
export function useRegisterToolRow(toolCallId: string | undefined): void {
  useEffect(() => {
    if (!toolCallId) return;
    counts.set(toolCallId, (counts.get(toolCallId) ?? 0) + 1);
    publish();
    return () => {
      const next = (counts.get(toolCallId) ?? 1) - 1;
      if (next <= 0) counts.delete(toolCallId);
      else counts.set(toolCallId, next);
      publish();
    };
  }, [toolCallId]);
}

/** Test seam. */
export function resetToolRows(): void {
  counts.clear();
  publish();
}
