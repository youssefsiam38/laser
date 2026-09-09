"use client";
/**
 * Which fleet row is revealed, and whether the sub-desktop sheet is open.
 *
 * A small external store rather than a context, because the things that ask
 * are far apart in the tree — a task-exit notice in the transcript, the top
 * bar's toggle, the composer's waiting line — and the fleet that answers is
 * mounted once. A context would have to wrap the whole shell to carry two
 * fields.
 *
 * The *column's* open state is not here: it belongs to the shell's remembered
 * layout, beside the sessions and monitor columns, because it is a shape of
 * the window rather than a moment.
 */
import { storageKey } from "@lasercode/protocol";
import { useSyncExternalStore } from "react";

let sheetOpen = false;
/** The item key the fleet should scroll to and expand, when it was asked for. */
let revealed: string | undefined;
const listeners = new Set<() => void>();

const publish = (): void => {
  for (const listener of [...listeners]) listener();
};

/**
 * Show a particular piece of work. On a desktop the column is already there,
 * so this only expands the row; below desktop it also opens the sheet. The
 * caller passes `sheet: false` when it knows the column is on screen.
 */
export function revealInFleet(key: string | undefined, options: { sheet?: boolean } = {}): void {
  revealed = key;
  if (options.sheet !== false) sheetOpen = true;
  publish();
}

export function openFleetSheet(): void {
  if (sheetOpen) return;
  sheetOpen = true;
  publish();
}

export function closeFleetSheet(): void {
  if (!sheetOpen) return;
  sheetOpen = false;
  revealed = undefined;
  publish();
}

export function setFleetSheetOpen(next: boolean): void {
  if (next) openFleetSheet();
  else closeFleetSheet();
}

/** The reveal has been honoured; a second press of the same row must work. */
export function clearFleetReveal(): void {
  if (revealed === undefined) return;
  revealed = undefined;
  publish();
}

/**
 * When the person last put the finished work away.
 *
 * Nothing is deleted: an agent run and a background command are both records
 * the host owns, and the sessions behind them are still in the sidebar and
 * still on disk. This is a per-viewer "I have read these", so it lives in
 * `localStorage` and is guarded like every other read of it — a browser that
 * refuses site data simply never clears anything, which is the harmless way
 * for it to fail. Work that finishes *after* the mark still appears.
 */
const CLEARED_KEY = storageKey("fleet-cleared");

const readCleared = (): string | undefined => {
  try {
    return globalThis.localStorage?.getItem(CLEARED_KEY) ?? undefined;
  } catch {
    return undefined;
  }
};

let clearedBefore: string | undefined = readCleared();

/** Put every piece of work finished up to now out of sight. */
export function clearFinishedFleet(at: string = new Date().toISOString()): void {
  clearedBefore = at;
  try {
    globalThis.localStorage?.setItem(CLEARED_KEY, at);
  } catch {
    // Only this window forgets, and only until it is reloaded.
  }
  publish();
}

const subscribe = (listener: () => void): (() => void) => {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
};

export function useFleetSheetOpen(): boolean {
  return useSyncExternalStore(subscribe, () => sheetOpen, () => false);
}

export function useFleetReveal(): string | undefined {
  return useSyncExternalStore(subscribe, () => revealed, () => undefined);
}

export function useFleetClearedBefore(): string | undefined {
  return useSyncExternalStore(subscribe, () => clearedBefore, () => undefined);
}

/** Test seam. */
export function resetFleetState(): void {
  sheetOpen = false;
  revealed = undefined;
  clearedBefore = undefined;
  try {
    globalThis.localStorage?.removeItem(CLEARED_KEY);
  } catch {
    // Nothing to reset if nothing could be stored.
  }
  publish();
}
