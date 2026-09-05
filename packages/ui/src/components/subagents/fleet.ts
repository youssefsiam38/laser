"use client";
/**
 * Whether the fleet sheet is open. A four-line external store rather than a
 * context, because the two things that open it are far apart in the tree: the
 * fleet pill in the status line above the composer (`panels/Ambient.tsx`) and
 * the run strip under the top bar. A context would have to wrap both, which
 * means wrapping the whole shell to carry one boolean.
 */
import { useSyncExternalStore } from "react";

let open = false;
/** The run the sheet should scroll to and reveal, when it was opened from a tab. */
let focus: string | undefined;
const listeners = new Set<() => void>();

const publish = (): void => {
  for (const listener of [...listeners]) listener();
};

export function openFleet(revealPanelId?: string): void {
  focus = revealPanelId;
  if (open) {
    publish();
    return;
  }
  open = true;
  publish();
}

export function closeFleet(): void {
  if (!open) return;
  open = false;
  focus = undefined;
  publish();
}

export function setFleetOpen(next: boolean): void {
  if (next) openFleet();
  else closeFleet();
}

const subscribe = (listener: () => void): (() => void) => {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
};

export function useFleetOpen(): boolean {
  return useSyncExternalStore(subscribe, () => open, () => false);
}

export function useFleetFocus(): string | undefined {
  return useSyncExternalStore(subscribe, () => focus, () => undefined);
}
