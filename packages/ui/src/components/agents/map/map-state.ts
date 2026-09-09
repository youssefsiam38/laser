/**
 * The map's own UI state, outside React (docs/agents.md §5).
 *
 * Two hosts draw the same map — the main column and the fullscreen overlay —
 * They are different React trees, so what
 * a person did to the map (which node is selected, where they panned, whether
 * ended agents are shown) lives here, keyed by the tree's root, and survives
 * the switch between hosts. The top bar's toggle and the shell read the same
 * store, so no shell context grows a field for this surface.
 *
 * Tested through test/agents/map/map.test.tsx.
 */
import { useSyncExternalStore } from "react";

export interface MapViewport {
  x: number;
  y: number;
  zoom: number;
}

export interface MapRootState {
  /** The selected node (a session path), highlighted and inspected. */
  selected: string | undefined;
  showEnded: boolean;
  /** Where the person left the camera; only restored once they have panned. */
  viewport: MapViewport | undefined;
  /** The person moved the camera: structure changes stop re-fitting until "Fit". */
  userPanned: boolean;
}

export interface MapUiState {
  /** The main column shows the map instead of the thread. */
  open: boolean;
  /** The fullscreen host is up. */
  fullscreen: boolean;
  /** Roots whose map is held as a dock island. */
  docked: Readonly<Record<string, true>>;
  roots: Readonly<Record<string, MapRootState>>;
}

const EMPTY_ROOT: MapRootState = { selected: undefined, showEnded: false, viewport: undefined, userPanned: false };

const initial: MapUiState = { open: false, fullscreen: false, docked: {}, roots: {} };

let state: MapUiState = initial;
const listeners = new Set<() => void>();

function commit(next: MapUiState): void {
  if (next === state) return;
  state = next;
  for (const listener of [...listeners]) listener();
}

function updateRoot(root: string, fn: (current: MapRootState) => MapRootState): void {
  const current = state.roots[root] ?? EMPTY_ROOT;
  const next = fn(current);
  if (next === current) return;
  commit({ ...state, roots: { ...state.roots, [root]: next } });
}

export const mapUi = {
  get: (): MapUiState => state,
  subscribe(listener: () => void): () => void {
    listeners.add(listener);
    return () => {
      listeners.delete(listener);
    };
  },
  setOpen(open: boolean): void {
    if (state.open !== open) commit({ ...state, open });
  },
  toggleOpen(): void {
    mapUi.setOpen(!state.open);
  },
  setFullscreen(fullscreen: boolean): void {
    if (state.fullscreen !== fullscreen) commit({ ...state, fullscreen });
  },
  setDocked(root: string, docked: boolean): void {
    if (Boolean(state.docked[root]) === docked) return;
    const next = { ...state.docked };
    if (docked) next[root] = true;
    else delete next[root];
    commit({ ...state, docked: next });
  },
  select(root: string, selected: string | undefined): void {
    updateRoot(root, (r) => (r.selected === selected ? r : { ...r, selected }));
  },
  setShowEnded(root: string, showEnded: boolean): void {
    updateRoot(root, (r) => (r.showEnded === showEnded ? r : { ...r, showEnded }));
  },
  /** The camera moved. `byUser` marks a pan or zoom the person made, as opposed to a fit. */
  setViewport(root: string, viewport: MapViewport, byUser: boolean): void {
    updateRoot(root, (r) => ({ ...r, viewport, userPanned: byUser || r.userPanned }));
  },
  /** "Fit": forget the person's camera so structure changes re-fit again. */
  resetViewport(root: string): void {
    updateRoot(root, (r) => (r.userPanned || r.viewport ? { ...r, viewport: undefined, userPanned: false } : r));
  },
  /** Test seam. */
  reset(): void {
    commit(initial);
  },
};

export function useMapUi(): MapUiState {
  return useSyncExternalStore(mapUi.subscribe, mapUi.get, mapUi.get);
}

const rootSelector = (root: string | undefined) => (): MapRootState => (root === undefined ? EMPTY_ROOT : (state.roots[root] ?? EMPTY_ROOT));

export function useMapRootState(root: string | undefined): MapRootState {
  const get = rootSelector(root);
  return useSyncExternalStore(mapUi.subscribe, get, get);
}

export function useMapDocked(root: string | undefined): boolean {
  const get = () => (root === undefined ? false : state.docked[root] === true);
  return useSyncExternalStore(mapUi.subscribe, get, get);
}
