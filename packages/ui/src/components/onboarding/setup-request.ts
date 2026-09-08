/**
 * "Run setup again" (Settings → This device) asks for the first-run flow.
 *
 * The flow owns the whole window and is rendered by the shell (D-47), while
 * the button that asks for it lives inside the workbench. Neither can reach
 * the other through props, and `useSetupPending` keeps its own copy of the
 * host's answer per caller — so the request travels as a store, the way the
 * fleet sheet and the end-agent dialog do.
 */
import { useSyncExternalStore } from "react";

import { forgetRememberedSessions } from "@/runtime";

let requested = false;
const listeners = new Set<() => void>();

const emit = (): void => {
  for (const listener of [...listeners]) listener();
};

/** A person asked to see setup again. The shell takes it from here. */
export function requestSetupAgain(): void {
  if (requested) return;
  requested = true;
  emit();
}

/** The shell has the flow on screen; the request is spent. */
export function clearSetupRequest(): void {
  if (!requested) return;
  requested = false;
  emit();
}

const subscribe = (listener: () => void): (() => void) => {
  listeners.add(listener);
  return () => listeners.delete(listener);
};

export function useSetupRequested(): boolean {
  return useSyncExternalStore(
    subscribe,
    () => requested,
    () => false,
  );
}

/**
 * What the shell does with a request. Setup owns the whole window and renders
 * only while no session is open (D-47), so the open session is left behind —
 * its row stays in the sidebar — and the remembered destination is forgotten,
 * or a reload in the middle of setup would restore it and hide the flow. The
 * host is read again because each caller of `useSetupPending` keeps its own
 * copy of the answer, and the one the shell holds predates the button.
 */
export function honourSetupRequest(shell: { refresh: () => void | Promise<void>; leaveSession: () => void }): void {
  void shell.refresh();
  forgetRememberedSessions();
  shell.leaveSession();
}
