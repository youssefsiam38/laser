/**
 * Which sub-session folds are open, per parent row (M13-T24).
 *
 * A parent's sub-sessions live behind a disclosure, and the ones that have
 * settled live behind a second one. Two kinds of "open" meet in that state and
 * they must not overwrite each other:
 *
 *   - what the **person** chose, which wins forever and is remembered per
 *     device (`localStorage`, the right home for a per-viewer convenience);
 *   - what the **app** defaulted to — a branch with live work under it opens
 *     itself, and opening a session reveals the branch it lives in. These are
 *     session-local on purpose: they are recomputed from live state on the next
 *     load, so they never accumulate in storage and never masquerade as a
 *     choice somebody made.
 *
 * A pin only ever *opens*. A run that ends therefore never collapses a branch
 * under the person's cursor — the finished child moves into the second fold,
 * the branch itself stays where it was (DESIGN.md "Motion", AGENTS.md: never
 * re-layout the list on a status update).
 *
 * The store is module-level, like `sessionsList`, so a row's disclosure and the
 * list it controls read the same value without a context the shell would own.
 */
import { storageKey } from "@lasercode/protocol";
import { useSyncExternalStore } from "react";

export const SESSION_FOLDS_STORAGE_KEY = storageKey("session-folds");

/** The two folds a parent row owns: its sub-sessions, and the settled ones. */
export type FoldKind = "children" | "finished";

/** A storage-safe key for one fold of one parent session. */
export const foldKey = (kind: FoldKind, path: string): string => `${kind === "children" ? "c" : "f"}:${path}`;

/**
 * How many remembered choices are kept. A person can only fold so many
 * branches by hand; the cap keeps a long-lived browser from growing a
 * key per session it ever showed.
 */
const MAX_REMEMBERED = 300;

export interface SessionFoldsState {
  /** Explicit choices. Persisted, and they beat every default. */
  readonly chosen: ReadonlyMap<string, boolean>;
  /** Defaults the app applied this session. Never persisted. */
  readonly pinned: ReadonlyMap<string, boolean>;
}

const readChosen = (): Map<string, boolean> => {
  try {
    const parsed: unknown = JSON.parse(globalThis.localStorage?.getItem(SESSION_FOLDS_STORAGE_KEY) ?? "{}");
    const out = new Map<string, boolean>();
    if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
      for (const [key, value] of Object.entries(parsed as Record<string, unknown>)) {
        if (typeof value === "boolean") out.set(key, value);
      }
    }
    return out;
  } catch {
    // Private mode, a quota, or something else wrote nonsense here: the list
    // still works, it just starts from its defaults.
    return new Map();
  }
};

const writeChosen = (chosen: ReadonlyMap<string, boolean>): void => {
  try {
    globalThis.localStorage?.setItem(SESSION_FOLDS_STORAGE_KEY, JSON.stringify(Object.fromEntries(chosen)));
  } catch {
    /* private mode / quota: the choice lives for this tab */
  }
};

let state: SessionFoldsState = { chosen: readChosen(), pinned: new Map() };
const listeners = new Set<() => void>();

const publish = (next: SessionFoldsState): void => {
  state = next;
  for (const listener of [...listeners]) listener();
};

/** Is this fold open? The person's choice, else the app's, else `fallback`. */
export function foldOpen(snapshot: SessionFoldsState, key: string, fallback: boolean): boolean {
  return snapshot.chosen.get(key) ?? snapshot.pinned.get(key) ?? fallback;
}

export const sessionFolds = {
  get: (): SessionFoldsState => state,
  subscribe(listener: () => void): () => void {
    listeners.add(listener);
    return () => {
      listeners.delete(listener);
    };
  },
  /** The person opened or closed this fold. Remembered until they say otherwise. */
  set(key: string, open: boolean): void {
    if (state.chosen.get(key) === open) return;
    const chosen = new Map(state.chosen);
    chosen.delete(key);
    chosen.set(key, open);
    while (chosen.size > MAX_REMEMBERED) chosen.delete(chosen.keys().next().value!);
    writeChosen(chosen);
    publish({ ...state, chosen });
  },
  /**
   * The app opens a fold: live work arrived under it, or the session the person
   * just opened lives inside it. Never closes anything, and never argues with a
   * choice they already made.
   */
  reveal(key: string): void {
    if (state.chosen.has(key) || state.pinned.get(key) === true) return;
    const pinned = new Map(state.pinned);
    pinned.set(key, true);
    publish({ ...state, pinned });
  },
  /** Test seam, and the "forget my folds" path if one is ever offered. */
  reset(): void {
    writeChosen(new Map());
    publish({ chosen: new Map(), pinned: new Map() });
  },
};

/** Subscribe one disclosure to its own fold. Returns the resolved open state. */
export function useFoldOpen(key: string, fallback: boolean): boolean {
  return useSyncExternalStore(
    sessionFolds.subscribe,
    () => foldOpen(state, key, fallback),
    () => fallback,
  );
}
