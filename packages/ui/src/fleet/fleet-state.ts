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
import { useSyncExternalStore } from "react";

import { DEVICE_KEYS, deviceStore } from "../runtime/device-storage.js";
import { DEFAULT_FLEET_FILTER, type FleetFilter, type FleetKindFilter } from "./filter.js";

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
const readCleared = (): string | undefined => deviceStore.read(DEVICE_KEYS.fleetCleared);

function parseFleetFilter(value: unknown): FleetFilter | undefined {
  if (!value || typeof value !== "object") return undefined;
  const rec = value as Record<string, unknown>;
  const lifecycle = rec.lifecycle;
  if (!lifecycle || typeof lifecycle !== "object") return undefined;
  const flags = lifecycle as Record<string, unknown>;
  if (typeof flags.going !== "boolean" || typeof flags.asking !== "boolean" || typeof flags.ended !== "boolean") return undefined;
  const kind = rec.kind;
  if (kind !== "all" && kind !== "agent" && kind !== "task") return undefined;
  return {
    lifecycle: { going: flags.going, asking: flags.asking, ended: flags.ended },
    kind: kind as FleetKindFilter,
  };
}

const readFilter = (): FleetFilter => deviceStore.readJson(DEVICE_KEYS.fleetFilter, parseFleetFilter) ?? DEFAULT_FLEET_FILTER;

let clearedBefore: string | undefined = readCleared();
let filter: FleetFilter = readFilter();

/** Put every piece of work finished up to now out of sight. */
export function clearFinishedFleet(at: string = new Date().toISOString()): void {
  clearedBefore = at;
  deviceStore.write(DEVICE_KEYS.fleetCleared, at);
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

export function setFleetFilter(next: FleetFilter): void {
  if (
    filter.kind === next.kind &&
    filter.lifecycle.going === next.lifecycle.going &&
    filter.lifecycle.asking === next.lifecycle.asking &&
    filter.lifecycle.ended === next.lifecycle.ended
  ) {
    return;
  }
  filter = next;
  deviceStore.writeJson(DEVICE_KEYS.fleetFilter, next);
  publish();
}

export function useFleetFilter(): FleetFilter {
  return useSyncExternalStore(subscribe, () => filter, () => DEFAULT_FLEET_FILTER);
}

/** Test seam: forget the mark entirely, in memory and on the device. */
export function resetFleetState(): void {
  sheetOpen = false;
  revealed = undefined;
  clearedBefore = undefined;
  filter = DEFAULT_FLEET_FILTER;
  deviceStore.write(DEVICE_KEYS.fleetCleared, undefined);
  deviceStore.writeJson(DEVICE_KEYS.fleetFilter, undefined);
  publish();
}

/**
 * Adopt the environment that has just been opened: the sheet closes and the
 * "I have read these" mark is the new namespace's, never the old one's.
 *
 * Driven by the device store's own lifecycle rather than by a caller that has
 * to remember (RP-13).
 */
export function rehydrateFleetState(): void {
  sheetOpen = false;
  revealed = undefined;
  clearedBefore = readCleared();
  filter = readFilter();
  publish();
}

deviceStore.subscribe((event) => {
  if (event.kind === "deactivated") {
    sheetOpen = false;
    revealed = undefined;
    clearedBefore = undefined;
    filter = DEFAULT_FLEET_FILTER;
    publish();
    return;
  }
  rehydrateFleetState();
});
