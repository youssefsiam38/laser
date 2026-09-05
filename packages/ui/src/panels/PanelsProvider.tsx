"use client";
/**
 * The panel system's stateful shell (docs/ux-panels.md).
 *
 * Owns one store with two slices — panels and per-session dock geometry —
 * published through `useSyncExternalStore` so islands re-render on their own
 * slice only.
 *
 * Inputs:
 *   pi/panel/upsert · pi/panel/close   declared panels, from the host
 *   pi/panel/list                       on (re)attach, to reconcile
 *   the app store's SessionViews        the fallback: widgets → stream,
 *                                       dialogs → decision (fallback.ts)
 *
 * Outputs: pi/panel/action for declared panels, pi/ui/response for fallback
 * decisions, pi/panel/read for refs. Everything a component needs comes
 * through {@link usePanelsState} and {@link usePanelActions}.
 */
import { sliceUtf8 } from "@piorbit/protocol";
import type {
  HostNotificationMethod,
  HostNotifications,
  LogSection,
  Panel,
  PanelReadResult,
  UiDialogRequest,
} from "@piorbit/protocol";
import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useSyncExternalStore,
  type ReactNode,
} from "react";
import { usePiorbitStable, usePiorbitState } from "../runtime/index.js";
import type { AppState, SessionView } from "../store.js";
import {
  DOCK_MIN_WIDTH,
  applyDockPrefs,
  defaultDockWidth,
  initialDock,
  parseDockPrefs,
  reduceDock,
  type DockAction,
  type DockIsland,
  type DockState,
  type IslandSize,
} from "./dock-state.js";
import {
  dialogIdOf,
  fallbackPanels,
  inlineContent,
  isFallbackDialogId,
  uiResponseFor,
} from "./fallback.js";
import { logContent, logPanelId, logStreamPanel, recordLogRows } from "./logs.js";
import { isIsland, type Viewport } from "./placement.js";
import {
  clearPath,
  closePanel,
  emptyPanels,
  entriesForPath,
  markSeen,
  panelKey,
  prunePanels,
  reconcilePath,
  upsertPanel,
  type PanelEntry,
  type PanelsState,
} from "./store.js";

// ---------------------------------------------------------------------------
// State
// ---------------------------------------------------------------------------

export interface PanelsRoot {
  panels: PanelsState;
  /** Dock geometry per session path; a session you have not looked at has none. */
  docks: Readonly<Record<string, DockState>>;
  /** Width and hidden state travel across sessions. */
  dockPrefs: { width: number; hidden: boolean };
}

const initialRoot: PanelsRoot = { panels: emptyPanels, docks: {}, dockPrefs: { width: initialDock.width, hidden: false } };

type RootAction =
  | { type: "panels"; fn: (state: PanelsState) => PanelsState }
  | { type: "dock"; path: string; action: DockAction }
  | { type: "dockPrefs"; prefs: Partial<PanelsRoot["dockPrefs"]> };

function reduceRoot(state: PanelsRoot, action: RootAction): PanelsRoot {
  switch (action.type) {
    case "panels": {
      const panels = action.fn(state.panels);
      return panels === state.panels ? state : { ...state, panels };
    }
    case "dock": {
      const current = state.docks[action.path] ?? { ...initialDock, width: state.dockPrefs.width, hidden: state.dockPrefs.hidden };
      const next = reduceDock(current, action.action);
      if (next === current && state.docks[action.path]) return state;
      // Width and hidden are shared: a change in one session's dock is the dock.
      const prefs =
        next.width !== state.dockPrefs.width || next.hidden !== state.dockPrefs.hidden
          ? { width: next.width, hidden: next.hidden }
          : state.dockPrefs;
      return { ...state, docks: { ...state.docks, [action.path]: next }, dockPrefs: prefs };
    }
    case "dockPrefs": {
      const prefs = { ...state.dockPrefs, ...action.prefs };
      const docks: Record<string, DockState> = {};
      for (const [path, dock] of Object.entries(state.docks)) docks[path] = applyDockPrefs(dock, prefs);
      return { ...state, dockPrefs: prefs, docks };
    }
  }
}

interface RootStore {
  getSnapshot(): PanelsRoot;
  subscribe(listener: () => void): () => void;
  dispatch(action: RootAction): void;
}

function createRootStore(initial: PanelsRoot): RootStore {
  let current = initial;
  const listeners = new Set<() => void>();
  return {
    getSnapshot: () => current,
    subscribe(listener) {
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
      };
    },
    dispatch(action) {
      const next = reduceRoot(current, action);
      if (Object.is(next, current)) return;
      current = next;
      for (const listener of [...listeners]) listener();
    },
  };
}

// ---------------------------------------------------------------------------
// Persistence (per browser session, DESIGN: "remembered per session")
// ---------------------------------------------------------------------------

const DOCK_STORAGE_KEY = "piorbit-dock:v1";

interface StoredDock {
  width?: number;
  hidden?: boolean;
  /** panel key → size, so a reload keeps what you were watching. */
  sizes?: Record<string, DockIsland["size"]>;
  dividers?: Record<string, [number, number]>;
}

const readStored = (): StoredDock => {
  try {
    const raw: unknown = JSON.parse(globalThis.sessionStorage?.getItem(DOCK_STORAGE_KEY) ?? "{}");
    if (!raw || typeof raw !== "object") return {};
    const prefs = parseDockPrefs(raw);
    const dividers: Record<string, [number, number]> = {};
    const rawDividers = (raw as { dividers?: unknown }).dividers;
    if (rawDividers && typeof rawDividers === "object") {
      for (const [path, value] of Object.entries(rawDividers as Record<string, unknown>)) {
        if (Array.isArray(value) && value.length === 2 && value.every((v) => typeof v === "number")) {
          dividers[path] = [value[0] as number, value[1] as number];
        }
      }
    }
    return {
      ...(prefs.width !== undefined ? { width: prefs.width } : {}),
      ...(prefs.hidden !== undefined ? { hidden: prefs.hidden } : {}),
      ...(prefs.sizes ? { sizes: prefs.sizes } : {}),
      dividers,
    };
  } catch {
    return {};
  }
};

const writeStored = (root: PanelsRoot): void => {
  try {
    const sizes: Record<string, DockIsland["size"]> = {};
    const dividers: Record<string, [number, number]> = {};
    for (const [path, dock] of Object.entries(root.docks)) {
      for (const [key, island] of Object.entries(dock.islands)) if (island.size !== "minimal") sizes[key] = island.size;
      if (dock.dividers[0] !== 0.5 || dock.dividers[1] !== 0.5) dividers[path] = [dock.dividers[0], dock.dividers[1]];
    }
    const stored: StoredDock = { width: root.dockPrefs.width, hidden: root.dockPrefs.hidden, sizes, dividers };
    globalThis.sessionStorage?.setItem(DOCK_STORAGE_KEY, JSON.stringify(stored));
  } catch {
    /* private mode, quota: the dock still works, it just forgets */
  }
};

// ---------------------------------------------------------------------------
// Context
// ---------------------------------------------------------------------------

export interface PanelActions {
  setSize(path: string, key: string, size: Exclude<IslandSize, "maximized">): void;
  toggleExpanded(path: string, key: string): void;
  maximize(path: string, key: string): void;
  restore(path: string): void;
  /** Open the panel in its own tab; the dock island shrinks and points there. */
  popOut(path: string, key: string): void;
  /** Bring the popped-out tab forward, if it is still open. */
  focusPoppedOut(key: string): boolean;
  dismiss(path: string, key: string): void;
  watched(path: string, key: string): void;
  setColumns(path: string, columns: 1 | 2): void;
  setWidth(width: number, maxWidth: number): void;
  setDivider(path: string, column: 0 | 1, ratio: number): void;
  setHidden(hidden: boolean): void;
  markSeen(key: string): void;
  /** A person pressed an action on a declared panel. */
  act(entry: PanelEntry, actionId: string, value?: string): Promise<boolean>;
  /**
   * Answer a decision. `values` keyed by field id; `undefined` cancels.
   * Fallback decisions go back through `pi/ui/response`; declared ones as a
   * `pi/panel/action` with actionId `answer` (JSON values) or `cancel`.
   */
  answerDecision(entry: PanelEntry, values: Record<string, string | boolean> | undefined): Promise<boolean>;
  /** Ranged read of a ref: client-local for `inline:`, the host otherwise. */
  readRef(path: string, ref: string, from: number, to: number): Promise<PanelReadResult>;
  /**
   * Watch one of the host's log sections in the dock, as a `stream` island.
   * Idempotent: pressing it again just brings the island back to expanded.
   */
  watchLogs(path: string, section: LogSection): void;
  /** Open a ref (an artifact, a collection hit) as a client-local document panel in the dock. */
  openRefAsDocument(path: string, ref: string, label: string, source: string): void;
}

interface PanelsContextValue {
  store: RootStore;
  actions: PanelActions;
}

const PanelsContext = createContext<PanelsContextValue | null>(null);

function usePanelsContext(): PanelsContextValue {
  const value = useContext(PanelsContext);
  if (!value) throw new Error("usePanels* must be used inside <PanelsProvider>.");
  return value;
}

/** Subscribe to one slice of panel state. Selector results are compared with `isEqual` (default Object.is). */
export function usePanelsState<T>(selector: (root: PanelsRoot) => T, isEqual: (a: T, b: T) => boolean = Object.is): T {
  const { store } = usePanelsContext();
  const selectorRef = useRef(selector);
  selectorRef.current = selector;
  const isEqualRef = useRef(isEqual);
  isEqualRef.current = isEqual;
  const cache = useRef<{ root: PanelsRoot; value: T } | undefined>(undefined);
  const getSnapshot = useCallback((): T => {
    const root = store.getSnapshot();
    const previous = cache.current;
    if (previous && previous.root === root) return previous.value;
    const next = selectorRef.current(root);
    if (previous && isEqualRef.current(previous.value, next)) {
      cache.current = { root, value: previous.value };
      return previous.value;
    }
    cache.current = { root, value: next };
    return next;
  }, [store]);
  return useSyncExternalStore(store.subscribe, getSnapshot, getSnapshot);
}

export function usePanelActions(): PanelActions {
  return usePanelsContext().actions;
}

const sameKeys = (a: readonly PanelEntry[], b: readonly PanelEntry[]): boolean =>
  a.length === b.length && a.every((e, i) => e === b[i]);

/** Every panel entry of a session, in creation order. Stable while nothing changed. */
export function usePanelEntries(path: string | undefined): PanelEntry[] {
  return usePanelsState((root) => entriesForPath(root.panels, path), sameKeys);
}

/** The entries that live as islands on this viewport (dock, or chip-and-sheet on a phone). */
export function useIslandEntries(path: string | undefined, viewport: Viewport): PanelEntry[] {
  return usePanelsState(
    (root) => entriesForPath(root.panels, path).filter((e) => isIsland(e.panel, viewport)),
    sameKeys,
  );
}

export function useDock(path: string | undefined): DockState {
  return usePanelsState((root) => {
    const dock = path ? root.docks[path] : undefined;
    return dock ?? { ...initialDock, width: root.dockPrefs.width, hidden: root.dockPrefs.hidden };
  }, (a, b) => a === b || (a.order.length === 0 && b.order.length === 0 && a.width === b.width && a.hidden === b.hidden));
}

// ---------------------------------------------------------------------------
// Provider
// ---------------------------------------------------------------------------

/** Where a pop-out lands. Handled by the Shell (`#/panel/<path>/<id>`). */
export const POPOUT_HASH_PREFIX = "#/panel/";
export const POPOUT_CHANNEL = "piorbit-panels";

export function popoutHash(path: string, id: string): string {
  return `${POPOUT_HASH_PREFIX}${encodeURIComponent(path)}/${encodeURIComponent(id)}`;
}

export function parsePopoutHash(hash: string): { path: string; id: string } | undefined {
  if (!hash.startsWith(POPOUT_HASH_PREFIX)) return undefined;
  const rest = hash.slice(POPOUT_HASH_PREFIX.length);
  const slash = rest.indexOf("/");
  if (slash === -1) return undefined;
  try {
    return { path: decodeURIComponent(rest.slice(0, slash)), id: decodeURIComponent(rest.slice(slash + 1)) };
  } catch {
    return undefined;
  }
}

/** Guess a media type from a ref's extension, for refs opened as documents. */
export function mediaTypeOfRef(ref: string): { mediaType: string; renderable: boolean } {
  const ext = /\.([a-z0-9]+)$/i.exec(ref.split("?")[0] ?? "")?.[1]?.toLowerCase();
  switch (ext) {
    case "md":
    case "markdown":
      return { mediaType: "text/markdown", renderable: true };
    case "diff":
    case "patch":
      return { mediaType: "text/x-diff", renderable: true };
    case "png":
    case "jpg":
    case "jpeg":
    case "gif":
    case "webp":
      return { mediaType: `image/${ext === "jpg" ? "jpeg" : ext}`, renderable: true };
    case "svg":
      return { mediaType: "image/svg+xml", renderable: true };
    case "json":
    case "jsonl":
    case "txt":
    case "log":
    case "ts":
    case "js":
    case "py":
    case "sh":
    case "yaml":
    case "yml":
    case "toml":
    case undefined:
      return { mediaType: "text/plain", renderable: true };
    case "pdf":
      return { mediaType: "application/pdf", renderable: false };
    default:
      return { mediaType: "application/octet-stream", renderable: false };
  }
}

export function PanelsProvider({ children }: { children: ReactNode }): ReactNode {
  const { client, actions: app } = usePiorbitStable();
  const store = useMemo(() => {
    const stored = readStored();
    return createRootStore({
      ...initialRoot,
      dockPrefs: {
        // No stored width: open at whatever this screen can carry, so a wide
        // monitor gets two full columns rather than two narrow ones.
        width: stored.width ?? defaultDockWidth(globalThis.innerWidth ?? 0),
        hidden: stored.hidden ?? false,
      },
    });
  }, []);
  const stored = useRef<StoredDock>(readStored());
  const dispatch = store.dispatch;
  const read = store.getSnapshot;
  const popouts = useRef(new Map<string, Window>());
  /** The session a log stream attaches to, read inside the notification handler. */
  const currentPath = useRef<string | undefined>(undefined);

  // --- declared panels from the host --------------------------------------
  useEffect(() => {
    const unsubscribe = client.subscribe((method: HostNotificationMethod, params) => {
      if (method === "pi/panel/upsert") {
        const { path, panel } = params as HostNotifications["pi/panel/upsert"];
        const before = read();
        dispatch({ type: "panels", fn: (s) => upsertPanel(s, path, panel, Date.now()) });
        resurfaceIfNeeded(before, path, panel);
      } else if (method === "pi/panel/close") {
        const { path, id, reason } = params as HostNotifications["pi/panel/close"];
        dispatch({ type: "panels", fn: (s) => closePanel(s, path, id, reason ?? "closed by its extension", Date.now()) });
      } else if (method === "pi/logs/append") {
        // The host's own sections are streams like any other (panels/logs.ts).
        // Only sections someone is actually watching are re-emitted: the buffer
        // takes every row, the dock does not.
        const { entries } = params as HostNotifications["pi/logs/append"];
        const touched = recordLogRows(entries);
        const path = currentPath.current;
        if (!path) return;
        const now = Date.now();
        for (const section of touched) {
          const id = logPanelId(section);
          if (!read().panels.entries[panelKey(path, id)]) continue;
          dispatch({ type: "panels", fn: (s) => upsertPanel(s, path, logStreamPanel(section), now, { fallback: true }) });
        }
      }
    });
    return unsubscribe;
    // eslint-disable-next-line react-hooks/exhaustive-deps -- dispatch/read are stable
  }, [client]);

  /** A dismissed panel that now needs a person comes back (R5). */
  const resurfaceIfNeeded = (before: PanelsRoot, path: string, panel: Panel): void => {
    const key = panelKey(path, panel.id);
    const dock = before.docks[path];
    if (!dock?.dismissed.includes(key)) return;
    const previous = before.panels.entries[key]?.panel;
    const needsYou =
      panel.kind === "decision" ||
      (panel.kind === "run" && (panel.lifecycle === "failed" || panel.attention === "waiting_for_input")) ||
      (panel.kind === "plan" && panel.steps.some((s) => s.state === "failed"));
    const changed = !previous || JSON.stringify(previous) !== JSON.stringify(panel);
    if (needsYou && changed) dispatch({ type: "dock", path, action: { type: "resurface", key, now: Date.now() } });
  };

  // --- reconcile on (re)attach --------------------------------------------
  const current = usePiorbitState((s: AppState) => s.current);
  currentPath.current = current;
  const connection = usePiorbitState((s: AppState) => s.connection);
  useEffect(() => {
    if (!current || connection !== "open") return;
    let cancelled = false;
    client
      .request("pi/panel/list", { path: current })
      .then(({ panels }) => {
        if (cancelled) return;
        dispatch({ type: "panels", fn: (s) => reconcilePath(s, current, panels, Date.now()) });
      })
      .catch(() => {
        // A host without the panel hub yet: declared panels simply do not
        // survive a reload. Fallback panels are derived locally regardless.
      });
    return () => {
      cancelled = true;
    };
  }, [client, current, connection]);

  // --- fallback: widgets and dialogs from the app store -------------------
  const open = usePiorbitState((s: AppState) => s.open);
  const knownFallback = useRef(new Map<string, Set<string>>()); // path → panel ids
  useEffect(() => {
    const now = Date.now();
    const seenPaths = new Set<string>();
    for (const [path, view] of Object.entries(open)) {
      seenPaths.add(path);
      const panels = fallbackPanels(view);
      const ids = new Set(panels.map((p) => p.id));
      const previous = knownFallback.current.get(path) ?? new Set<string>();
      for (const panel of panels) dispatch({ type: "panels", fn: (s) => upsertPanel(s, path, panel, now, { fallback: true }) });
      for (const id of previous) {
        if (ids.has(id)) continue;
        const reason = isFallbackDialogId(id) ? "answered" : "cleared by its extension";
        dispatch({ type: "panels", fn: (s) => closePanel(s, path, id, reason, now) });
      }
      knownFallback.current.set(path, ids);
    }
    for (const path of [...knownFallback.current.keys()]) {
      if (seenPaths.has(path)) continue;
      knownFallback.current.delete(path);
      dispatch({ type: "panels", fn: (s) => clearPath(s, path) });
    }
  }, [open]);

  // --- prune closed notices ------------------------------------------------
  useEffect(() => {
    const timer = setInterval(() => {
      const before = read().panels;
      dispatch({ type: "panels", fn: (s) => prunePanels(s, Date.now()) });
      const after = read().panels;
      if (after === before) return;
      // Islands of pruned panels leave the dock too.
      for (const key of before.order) {
        if (after.entries[key]) continue;
        const path = before.entries[key]?.path;
        if (path) dispatch({ type: "dock", path, action: { type: "unregister", key } });
      }
    }, 1000);
    return () => clearInterval(timer);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // --- persistence ---------------------------------------------------------
  useEffect(() => {
    let timer: ReturnType<typeof setTimeout> | undefined;
    return store.subscribe(() => {
      if (timer) return;
      timer = setTimeout(() => {
        timer = undefined;
        writeStored(read());
      }, 300);
    });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // --- pop-out lifecycle ---------------------------------------------------
  useEffect(() => {
    if (typeof BroadcastChannel === "undefined") return;
    const channel = new BroadcastChannel(POPOUT_CHANNEL);
    channel.onmessage = (event: MessageEvent<unknown>) => {
      const data = event.data as { type?: string; path?: string; id?: string } | null;
      if (!data || typeof data.path !== "string" || typeof data.id !== "string") return;
      const key = panelKey(data.path, data.id);
      if (data.type === "closed") {
        popouts.current.delete(key);
        dispatch({ type: "dock", path: data.path, action: { type: "popIn", key } });
      } else if (data.type === "open") {
        dispatch({ type: "dock", path: data.path, action: { type: "popOut", key, now: Date.now() } });
      }
    };
    return () => channel.close();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // --- actions -------------------------------------------------------------
  const dock = useCallback(
    (path: string, action: DockAction) => dispatch({ type: "dock", path, action }),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [],
  );

  // Views are read at call time through a ref: they change on every
  // transcript delta, and rebuilding the actions object that often would
  // re-render every island.
  const openRef = useRef(open);
  openRef.current = open;

  const act = useCallback(
    async (entry: PanelEntry, actionId: string, value?: string): Promise<boolean> => {
      try {
        const result = await client.request("pi/panel/action", {
          path: entry.path,
          id: entry.panel.id,
          actionId,
          ...(value !== undefined ? { value } : {}),
        });
        // A worker that predates panel actions answers with nothing at all.
        const delivered = result?.delivered === true;
        if (!delivered) {
          app.toast("warning", `"${entry.panel.title}" is no longer listening. The extension that showed it may have moved on.`);
        }
        return delivered;
      } catch (error) {
        app.toast("error", error instanceof Error ? error.message : String(error));
        return false;
      }
    },
    [app, client],
  );

  const actions = useMemo<PanelActions>(
    () => ({
      setSize: (path, key, size) => {
        dock(path, { type: "setSize", key, size, now: Date.now() });
        if (size === "expanded") dispatch({ type: "panels", fn: (s) => markSeen(s, key) });
      },
      toggleExpanded: (path, key) => {
        dock(path, { type: "toggleExpanded", key, now: Date.now() });
        dispatch({ type: "panels", fn: (s) => markSeen(s, key) });
      },
      maximize: (path, key) => {
        dock(path, { type: "maximize", key, now: Date.now() });
        dispatch({ type: "panels", fn: (s) => markSeen(s, key) });
      },
      restore: (path) => dock(path, { type: "restore" }),
      popOut: (path, key) => {
        const entry = read().panels.entries[key];
        if (!entry) return;
        const url = `${location.pathname}${location.search}${popoutHash(path, entry.panel.id)}`;
        const handle = window.open(url, `piorbit-panel:${key}`);
        if (!handle) {
          app.toast("warning", "The browser blocked the new tab. Allow pop-ups for piorbit, or use maximize instead.");
          return;
        }
        popouts.current.set(key, handle);
        dock(path, { type: "popOut", key, now: Date.now() });
      },
      focusPoppedOut: (key) => {
        const handle = popouts.current.get(key);
        if (!handle || handle.closed) {
          popouts.current.delete(key);
          return false;
        }
        handle.focus();
        return true;
      },
      dismiss: (path, key) => dock(path, { type: "dismiss", key }),
      watched: (path, key) => dock(path, { type: "watched", key, now: Date.now() }),
      setColumns: (path, columns) => dock(path, { type: "setColumns", columns }),
      setWidth: (width, maxWidth) =>
        dispatch({
          type: "dockPrefs",
          prefs: { width: Math.round(Math.min(Math.max(width, DOCK_MIN_WIDTH), Math.max(DOCK_MIN_WIDTH, maxWidth))) },
        }),
      setDivider: (path, column, ratio) => dock(path, { type: "setDivider", column, ratio }),
      setHidden: (hidden) => dispatch({ type: "dockPrefs", prefs: { hidden } }),
      markSeen: (key) => dispatch({ type: "panels", fn: (s) => markSeen(s, key) }),
      act,
      answerDecision: async (entry, values) => {
        if (entry.panel.kind !== "decision") return false;
        if (isFallbackDialogId(entry.panel.id)) {
          const dialogId = dialogIdOf(entry.panel.id);
          const views = openRef.current;
          const dialog = findDialog(views, entry.path, dialogId);
          if (!dialog) return false;
          await app.answerDialog(uiResponseFor(dialogId, dialog.method, values));
          // "No" is never a dead end: a note typed while declining follows up.
          const feedback = values?.["feedback"];
          if (dialog.method === "confirm" && values?.["confirmed"] === false && typeof feedback === "string" && feedback.trim()) {
            const view = views[entry.path];
            await app.send([{ type: "text", text: feedback.trim() }], view?.running ? "followUp" : "prompt").catch(() => {});
          }
          return true;
        }
        const delivered = values === undefined ? await act(entry, "cancel") : await act(entry, "answer", JSON.stringify(values));
        // The extension owns the panel and will close it; until it does, an
        // answered question must not keep asking. Its own close (or a re-emit
        // with a new question) replaces this notice.
        if (delivered) {
          dispatch({ type: "panels", fn: (s) => closePanel(s, entry.path, entry.panel.id, values === undefined ? "dismissed" : "answered", Date.now()) });
        }
        return delivered;
      },
      readRef: async (path, ref, from, to) => {
        const local = logContent(ref) ?? inlineContent(openRef.current[path], ref);
        if (local !== undefined) {
          // Bytes, like every other ref scheme: `from`, `bytes` and the
          // follower's own bookkeeping are byte offsets on the wire, and
          // answering a byte request with JS string indices desynchronises the
          // tail on the first non-ASCII character. `sliceUtf8` is the same
          // helper the host reads with.
          const slice = sliceUtf8(local, from, to);
          return {
            ref,
            from: slice.from,
            bytes: slice.bytes,
            chunk: slice.chunk,
            encoding: "utf8",
            eof: to >= slice.bytes,
          };
        }
        return client.request("pi/panel/read", { path, ref, from, to });
      },
      watchLogs: (path, section) => {
        const panel = logStreamPanel(section);
        const key = panelKey(path, panel.id);
        const now = Date.now();
        dispatch({ type: "panels", fn: (s) => upsertPanel(s, path, panel, now, { fallback: true }) });
        dock(path, { type: "register", key, now });
        dock(path, { type: "setSize", key, size: "expanded", now });
        dispatch({ type: "panels", fn: (s) => markSeen(s, key) });
      },
      openRefAsDocument: (path, ref, label, source) => {
        const { mediaType, renderable } = mediaTypeOfRef(ref);
        const panel: Panel = {
          kind: "document",
          id: `local:doc:${ref}`,
          source,
          title: label,
          intent: "follow",
          mediaType,
          renderable,
          content: { ref },
          ...(ref.startsWith("file:") ? { path: ref.slice("file:".length) } : {}),
        };
        const key = panelKey(path, panel.id);
        dispatch({ type: "panels", fn: (s) => upsertPanel(s, path, panel, Date.now(), { fallback: true }) });
        dock(path, { type: "register", key, now: Date.now() });
        dock(path, { type: "setSize", key, size: "expanded", now: Date.now() });
        dispatch({ type: "panels", fn: (s) => markSeen(s, key) });
      },
    }),
    // eslint-disable-next-line react-hooks/exhaustive-deps -- dispatch/read are stable
    [act, app, client, dock],
  );

  // --- dock registration: islands of every session, sized from storage -----
  useEffect(() => {
    return store.subscribe(() => {
      const root = read();
      for (const key of root.panels.order) {
        const entry = root.panels.entries[key];
        if (!entry) continue;
        const dockState = root.docks[entry.path];
        if (dockState?.islands[key]) continue;
        if (!isIsland(entry.panel, "desktop")) continue;
        dispatch({ type: "dock", path: entry.path, action: { type: "register", key, now: Date.now() } });
        const remembered = stored.current.sizes?.[key];
        if (remembered) dispatch({ type: "dock", path: entry.path, action: { type: "setSize", key, size: remembered, now: Date.now() } });
        const dividers = stored.current.dividers?.[entry.path];
        if (dividers && !dockState) {
          dispatch({ type: "dock", path: entry.path, action: { type: "setDivider", column: 0, ratio: dividers[0] } });
          dispatch({ type: "dock", path: entry.path, action: { type: "setDivider", column: 1, ratio: dividers[1] } });
        }
      }
      for (const [path, dockState] of Object.entries(root.docks)) {
        for (const key of dockState.order) {
          if (root.panels.entries[key]) continue;
          dispatch({ type: "dock", path, action: { type: "unregister", key } });
        }
      }
    });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const value = useMemo<PanelsContextValue>(() => ({ store, actions }), [store, actions]);
  return <PanelsContext.Provider value={value}>{children}</PanelsContext.Provider>;
}

function findDialog(open: Readonly<Record<string, SessionView>>, path: string, dialogId: string): UiDialogRequest | undefined {
  return open[path]?.dialogs.find((d) => d.id === dialogId);
}
