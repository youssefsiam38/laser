"use client";
/**
 * Which run a person is being asked to end. An external store, like the
 * fleet's (`src/fleet/fleet-state.ts`), because the things that ask are
 * far apart in the tree — a sessions-panel row menu, a run tab under the top
 * bar, a node on the live map — and the one dialog that answers is mounted
 * once in the shell. A context would have to wrap the whole app to carry one
 * run id.
 */
import { useSyncExternalStore } from "react";

export interface EndAgentRequest {
  readonly runId: string;
}

let request: EndAgentRequest | undefined;
const listeners = new Set<() => void>();

const publish = (): void => {
  for (const listener of [...listeners]) listener();
};

/** Ask the shell's `EndAgentDialog` about this run. A second request replaces the first. */
export function requestEndAgent(runId: string): void {
  if (request?.runId === runId) return;
  request = { runId };
  publish();
}

/** The dialog closed, or the question no longer applies. */
export function clearEndAgentRequest(): void {
  if (!request) return;
  request = undefined;
  publish();
}

const subscribe = (listener: () => void): (() => void) => {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
};

const read = (): EndAgentRequest | undefined => request;
const none = (): EndAgentRequest | undefined => undefined;

export function useEndAgentRequest(): EndAgentRequest | undefined {
  return useSyncExternalStore(subscribe, read, none);
}
