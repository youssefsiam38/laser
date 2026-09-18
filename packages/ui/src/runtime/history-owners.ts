/**
 * Owner-local transcript windows (D-236).
 *
 * One canonical store owns a session: its metadata, branch and epoch, its
 * questions, its queue and drafts, and the order of the host's updates. What a
 * rendered surface has *loaded* is not canonical — the main window and Beam can
 * show the same session and have paged it to different depths, and re-entering
 * a session normally starts at its recent tail without disturbing the other.
 *
 * So the first surface on a path reads and writes the canonical view, exactly
 * as before, and any further surface on that same path keeps its own window:
 * the same reducer, run over its own loaded entries, fed the same raw actions
 * in the same order, before React hears about the transaction. Nothing here
 * answers a question, sends a message or talks to the host; it only decides
 * which loaded transcript one surface is looking at.
 */
import { reduce, type Action, type AppState, type SessionView } from "../store.js";

/**
 * What one surface loaded, and only that surface: another surface's reads must
 * never reach this window. Its own reads arrive through `owner.dispatch`.
 */
const LOADED_BY_ONE_SURFACE = new Set<Action["type"]>([
  "historyBegin", "historyReset", "historyEnd", "historySnapshot", "historyPrepend", "historyRecover", "historyMetadata", "hydrate", "entries",
  "views/reconcile", "views/reconcileFailed",
]);

/** What a surface loads for itself. Everything else comes from the canonical view. */
function windowOf(canonical: SessionView, owned: SessionView): SessionView {
  const {
    history: _h, historyPending: _p, historyRevision: _r, pendingSentBy: _s,
    stubs: _stubs, trimmed: _trimmed, validated: _validated, provisional: _provisional,
    ...rest
  } = canonical;
  return {
    ...rest,
    entries: owned.entries,
    blocks: owned.blocks,
    hydrated: owned.hydrated,
    lastSeq: owned.lastSeq,
    leafId: owned.leafId,
    ...(owned.stubs ? { stubs: owned.stubs } : {}),
    ...(owned.history ? { history: owned.history } : {}),
    ...(owned.historyPending ? { historyPending: owned.historyPending } : {}),
    ...(owned.historyRevision ? { historyRevision: owned.historyRevision } : {}),
    ...(owned.pendingSentBy ? { pendingSentBy: owned.pendingSentBy } : {}),
    ...(owned.trimmed ? { trimmed: owned.trimmed } : {}),
    ...(owned.validated ? { validated: owned.validated } : {}),
    ...(owned.provisional ? { provisional: owned.provisional } : {}),
  };
}

export interface HistoryWindowRoot {
  getSnapshot(): AppState;
  dispatch(action: Action): void;
  observeTransactions(observer: (action: Action, before: AppState, after: AppState) => boolean): () => void;
  publishTransactions(): void;
}

/** One rendered surface's view of one session's loaded transcript. */
export interface HistoryWindowOwner {
  /** The state this surface sees: canonical, with its own loaded transcript. */
  overlay(state: AppState): AppState;
  /** A history action from this surface's own loader. */
  dispatch(action: Action): void;
}

/**
 * The main window always reads and writes the canonical view: it is the surface
 * a session's watermark, replay and generation adoption follow. Every other
 * surface on the same path keeps a window of its own.
 */
export const MAIN_WINDOW_SCOPE = "main";

export interface HistoryWindows {
  /**
   * Idempotent for one surface identity; safe to call while rendering, and
   * stable: the same `scope` and `path` get the same object for as long as the
   * surface holds them. The identity is load-bearing — the owner is a
   * dependency of the scope's store, its history loader and its thread-list
   * adapter, and assistant-ui treats a new `RemoteThreadListAdapter` as a new
   * adapter: it bumps its generations and throws `ThreadListAdapterChangedError`
   * out of the work already in flight.
   */
  owner(scope: string, path: string | undefined): HistoryWindowOwner;
  /** This surface no longer shows this session. Host work is untouched. */
  forget(scope: string, path: string | undefined): void;
  dispose(): void;
}

export function createHistoryWindows(root: HistoryWindowRoot): HistoryWindows {
  interface Held { scope: string; path: string; owned?: SessionView | undefined; source?: AppState; shown?: SessionView; derived?: AppState }
  const held = new Map<string, Held>();
  /** One owner object per `scope\0path`, for as long as that surface holds it. */
  const owners = new Map<string, HistoryWindowOwner>();
  const key = (scope: string, path: string) => `${scope}\u0000${path}`;

  const ensure = (scope: string, path: string): Held => {
    const existing = held.get(key(scope, path));
    if (existing) return existing;
    const others = [...held.values()].filter(entry => entry.path === path);
    // A session shown in one place only keeps reading and writing the canonical
    // view, exactly as before. When the main window arrives on a path another
    // surface already showed, that surface takes a window of its own from what
    // it is showing now, so neither loses its place to the other.
    if (scope === MAIN_WINDOW_SCOPE) for (const other of others) other.owned ??= root.getSnapshot().open[path];
    const entry: Held = { scope, path, ...(others.length && scope !== MAIN_WINDOW_SCOPE ? { owned: root.getSnapshot().open[path] } : {}) };
    held.set(key(scope, path), entry);
    return entry;
  };

  const stop = root.observeTransactions((action, before, after) => {
    let changed = false;
    for (const entry of held.values()) {
      if (!entry.owned) continue;
      const was = before.open[entry.path], now = after.open[entry.path];
      // The session moved to another branch or another worker generation. That
      // is canonical, not a loaded window: every surface takes the new one
      // rather than staying on a transcript that no longer exists.
      if (now && was && (was.updateEpoch !== now.updateEpoch || was.leafId !== now.leafId)) {
        entry.owned = now; changed = true; continue;
      }
      // Another surface reading its own window says nothing about this one.
      if (LOADED_BY_ONE_SURFACE.has(action.type)) continue;
      // The same reducer, over this surface's own loaded window. A canonical
      // no-op still reaches a surface that is waiting to replay this event.
      const next = reduce({ ...after, open: { ...after.open, [entry.path]: entry.owned } }, action).open[entry.path];
      if (next === entry.owned) continue;
      // A closed session keeps no window: existence is canonical.
      entry.owned = after.open[entry.path] && next ? next : undefined;
      changed = true;
    }
    return changed;
  });

  const inert: HistoryWindowOwner = { overlay: state => state, dispatch: action => root.dispatch(action) };

  return {
    owner(scope, path) {
      if (!path) return inert;
      const cached = owners.get(key(scope, path));
      if (cached) return cached;
      const entry = ensure(scope, path);
      const created: HistoryWindowOwner = {
        overlay(state) {
          const view = state.open[path];
          if (!entry.owned || !view) return state;
          if (state !== entry.source || entry.shown !== entry.owned || entry.derived === undefined) {
            entry.source = state; entry.shown = entry.owned;
            entry.derived = { ...state, open: { ...state.open, [path]: windowOf(view, entry.owned) } };
          }
          return entry.derived;
        },
        dispatch(action) {
          if (!entry.owned) { root.dispatch(action); return; }
          const state = root.getSnapshot();
          const next = reduce({ ...state, open: { ...state.open, [path]: entry.owned } }, action).open[path];
          if (!next || next === entry.owned) return;
          entry.owned = next;
          root.publishTransactions();
        },
      };
      owners.set(key(scope, path), created);
      return created;
    },
    forget(scope, path) {
      if (!path) return;
      held.delete(key(scope, path));
      owners.delete(key(scope, path));
    },
    dispose: stop,
  };
}
