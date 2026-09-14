/**
 * The bubble's own state: whether it is open, which Beam session it shows,
 * and the spark it grew out of. A small external store rather than React
 * state because the spark (rail or sheet footer) and the bubble (the shell)
 * are far apart in the tree. The spark clears the active path on every press;
 * earlier chats live in the sessions sidebar.
 *
 * Pure of React apart from {@link useBeam}; tested through the bubble.
 */
import { useSyncExternalStore } from "react";

import { DEVICE_KEYS, deviceStore } from "@/runtime/device-storage";

export interface BeamSnapshot {
  open: boolean;
  /** The session the bubble shows; `undefined` while opening prepares one. */
  path: string | undefined;
}

/**
 * The remembered Beam session is a session path, so it belongs to one
 * environment: `deviceStore` answers nothing until the environment is known,
 * and answers a different namespace in a different one (RP-13).
 */
const readPath = (): string | undefined => deviceStore.read(DEVICE_KEYS.beamSession);
const writePath = (path: string | undefined): void => deviceStore.write(DEVICE_KEYS.beamSession, path);

function createBeamStore() {
  let snapshot: BeamSnapshot = { open: false, path: readPath() };
  let anchor: HTMLElement | null = null;
  const listeners = new Set<() => void>();
  const publish = (next: BeamSnapshot): void => {
    if (next.open === snapshot.open && next.path === snapshot.path) return;
    snapshot = next;
    for (const listener of [...listeners]) listener();
  };
  return {
    getSnapshot: (): BeamSnapshot => snapshot,
    subscribe(listener: () => void): () => void {
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
      };
    },
    /** The spark the bubble grows out of and returns focus to. */
    anchor: (): HTMLElement | null => anchor,
    open(from?: HTMLElement | null): void {
      if (from) anchor = from;
      publish({ ...snapshot, open: true });
    },
    close(): void {
      publish({ ...snapshot, open: false });
    },
    /** Adopt a prepared session or let go of one that is gone. */
    setPath(path: string | undefined): void {
      writePath(path);
      publish({ ...snapshot, path });
    },
    /** Detach the bubble; its panel immediately prepares an unstarted Beam session. */
    newChat(): void {
      this.setPath(undefined);
    },
    /**
     * Forget everything and read the remembered path again.
     *
     * The environment's own reset calls this, so the bubble adopts the newly
     * opened namespace instead of staying empty forever (and a test uses it
     * the same way).
     */
    reset(): void {
      anchor = null;
      snapshot = { open: false, path: readPath() };
      for (const listener of [...listeners]) listener();
    },
  };
}

export const beamStore = createBeamStore();

export function useBeam(): BeamSnapshot {
  return useSyncExternalStore(beamStore.subscribe, beamStore.getSnapshot, beamStore.getSnapshot);
}
