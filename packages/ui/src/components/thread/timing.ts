/**
 * Local wall-clock timing for tool rows and reasoning groups.
 *
 * `ThreadMessageLike` tool parts carry no `timing`, so the row records when it
 * first saw a part running and when it saw it settle. Marks live in a
 * module-level map keyed by a stable id (tool call id, message id + part
 * index), so a row that unmounts (thread switch, virtualization) and comes
 * back keeps its duration. A part that was already complete when first seen
 * (hydrated history) gets no mark and shows no duration.
 */
import { useEffect, useState } from "react";

interface Mark {
  start: number;
  end?: number;
}

const marks = new Map<string, Mark>();

/**
 * Marks outlive the rows that made them (a thread switch must not lose a
 * duration), so the map is bounded instead: the oldest entries go first. A
 * supervisor tab that visits many sessions would otherwise grow it forever.
 */
const MAX_MARKS = 2000;

export type TimingPhase = "running" | "done" | "idle";

export function markRunning(key: string, now = Date.now()): void {
  if (marks.has(key)) return;
  if (marks.size >= MAX_MARKS) {
    // Map preserves insertion order, so the first keys are the oldest.
    let drop = marks.size - MAX_MARKS + 1;
    for (const oldest of marks.keys()) {
      marks.delete(oldest);
      if (--drop <= 0) break;
    }
  }
  marks.set(key, { start: now });
}

/** Drop every mark whose key starts with `prefix` (a closed thread's rows). */
export function forgetTiming(prefix: string): void {
  for (const key of [...marks.keys()]) if (key.startsWith(prefix)) marks.delete(key);
}

export function markDone(key: string, now = Date.now()): void {
  const mark = marks.get(key);
  if (mark && mark.end === undefined) mark.end = now;
}

export function elapsedOf(key: string, now = Date.now()): number | undefined {
  const mark = marks.get(key);
  if (!mark) return undefined;
  return (mark.end ?? now) - mark.start;
}

/** Test seam. */
export function resetTiming(): void {
  marks.clear();
}

/** Re-render every `intervalMs` while `active`. */
export function useTick(active: boolean, intervalMs = 100): number {
  const [tick, setTick] = useState(0);
  useEffect(() => {
    if (!active) return;
    const id = setInterval(() => setTick((t) => t + 1), intervalMs);
    return () => clearInterval(id);
  }, [active, intervalMs]);
  return tick;
}

/**
 * Elapsed ms for `key`. Ticks while `phase === "running"`, freezes on
 * `"done"`, and is `undefined` for parts never seen running.
 */
export function useElapsed(key: string, phase: TimingPhase): number | undefined {
  // Recording at commit time, not in the render body: a discarded concurrent
  // render (or StrictMode's double render) must not stamp a start.
  useEffect(() => {
    if (phase === "running") markRunning(key);
    else if (phase === "done") markDone(key);
  }, [key, phase]);
  useTick(phase === "running");
  return elapsedOf(key);
}

/** Seconds left on a dialog timeout, counted from mount. `undefined` when there is no timeout. */
export function useCountdown(timeoutMs: number | undefined): number | undefined {
  const [deadline] = useState(() => (timeoutMs ? Date.now() + timeoutMs : undefined));
  useTick(deadline !== undefined, 1000);
  if (deadline === undefined) return undefined;
  return Math.max(0, Math.ceil((deadline - Date.now()) / 1000));
}
