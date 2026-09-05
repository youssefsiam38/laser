"use client";
/**
 * The one stateful shell of the UI: owns the `HostClient`, the reducer, the
 * selected project, and the assistant-ui runtime.
 *
 * Shape mirrors `@assistant-ui/react-pi`'s `usePiRuntime`: a
 * `useRemoteThreadListRuntime` over the session catalog whose per-thread
 * `runtimeHook` builds a `useExternalStoreRuntime` for the open session.
 *
 * Everything piorbit needs that assistant-ui does not model — free-standing
 * extension dialogs, status pills, widgets, worker status, projects, the
 * session tree — hangs off {@link usePiorbit} instead of being forced into a
 * runtime seam.
 *
 * Why the snapshot store: `useRemoteThreadListRuntime` stores `runtimeHook` in
 * a subscribable it refreshes in an effect, so a closure over React state
 * reaches the per-thread hook one render late. The hook therefore subscribes to
 * a small external store that this component keeps in sync, and reads no
 * closed-over state at all.
 */
import {
  AssistantRuntimeProvider,
  useAui,
  useAuiEvent,
  useAuiState,
  useExternalStoreRuntime,
  useRemoteThreadListRuntime,
} from "@assistant-ui/react";
import type { AssistantRuntime, ThreadMessageLike } from "@assistant-ui/react";
import type {
  ContentBlock,
  HostNotificationMethod,
  HostNotifications,
  ModelRef,
  ProjectInfo,
  SessionState,
  SessionSummary,
  ThinkingLevel,
  UiDialogRequest,
  UiDialogResponse,
  WorkerInfo,
} from "@piorbit/protocol";
import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState,
  useSyncExternalStore,
  type ReactNode,
} from "react";
import { HostClient } from "../client.js";
import { initialState, reduce, type Action, type AppState, type SessionView } from "../store.js";
import { createThreadAdapter, sendToSession, type SendBehavior } from "./adapter.js";
import { projectSessionView, shareProjectedMessages, splitDialogs } from "./projection.js";
import {
  createArchiveStore,
  createThreadListAdapter,
  threadListSignature,
  type ArchiveStore,
} from "./threadList.js";

export const PROJECT_STORAGE_KEY = "piorbit-project";
/**
 * Pre-M2 project list. Projects now live in the host (`pi/project/*`) so the
 * CLI, a second browser and a phone all see one list; this key is only read
 * once, to hand old local entries to the host, and then removed.
 */
export const PROJECTS_STORAGE_KEY = "piorbit-projects";

/** A project-trust question the host is holding a worker start on (M2-T4). */
export type TrustRequest = HostNotifications["pi/project/trust_request"];

// ---------------------------------------------------------------------------
// Context
// ---------------------------------------------------------------------------

export interface PiorbitActions {
  /** `session/load` (+ `pi/session/entries` on first open) and select it. */
  openSession(path: string): Promise<void>;
  /** `session/new` in `cwd`; resolves with the new session path. */
  newSession(cwd: string): Promise<string>;
  /** Send to the current session with an explicit behavior. */
  send(content: ContentBlock[], behavior: SendBehavior): Promise<void>;
  abort(): Promise<void>;
  answerDialog(response: UiDialogResponse): Promise<void>;
  setModel(model: ModelRef | null): Promise<void>;
  setThinking(level: ThinkingLevel): Promise<void>;
  listModels(): Promise<ModelRef[]>;
  rename(name: string): Promise<void>;
  compact(instructions?: string): Promise<void>;
  /** Fork before `entryId` into a new session and select it. */
  fork(entryId: string): Promise<void>;
  /** Move the session's leaf to `entryId` and re-hydrate. */
  jump(entryId: string): Promise<void>;
  refreshSessions(): Promise<void>;
  refreshEntries(): Promise<void>;
  /** `pi/session/clear_queue`; resolves with the text to restore into the composer. */
  clearQueue(): Promise<string>;
  /**
   * `pi/project/add` — server-side, so every client and the CLI see it.
   * Resolves with the host's record, or `undefined` when the add failed (the
   * failure is already on screen as a toast).
   */
  addProject(cwd: string): Promise<ProjectInfo | undefined>;
  removeProject(cwd: string): Promise<void>;
  refreshProjects(): Promise<void>;
  /** Answer a `pi/project/trust_request`. The held-back worker starts (or does not). */
  answerTrust(cwd: string, trusted: boolean, remember: boolean): Promise<void>;
  /** Start a crashed or retired worker again (`pi/worker/restart`). */
  restartWorker(cwd: string): Promise<void>;
  /** Tell the host this session has been read up to its latest update. */
  markSeen(path: string, seq: number): void;
  dismissToast(id: number): void;
  toast(level: "info" | "warning" | "error", text: string): void;
}

export interface PiorbitContextValue {
  state: AppState;
  dispatch: (action: Action) => void;
  client: HostClient;
  /** The currently open session view, if any. */
  view: SessionView | undefined;
  currentProject: string | undefined;
  setCurrentProject: (cwd: string | undefined) => void;
  /** Every cwd we know about: the host's project list, plus any open session's. */
  projects: string[];
  /** The host's project records, keyed by cwd (trust, pin, session count). */
  projectInfo: Readonly<Record<string, ProjectInfo>>;
  /** Project-trust questions waiting for an answer. */
  trustRequests: TrustRequest[];
  archive: ArchiveStore;
  actions: PiorbitActions;
}

/** Everything that does not change when the transcript does. */
export type PiorbitStable = Omit<PiorbitContextValue, "state" | "view">;

const PiorbitStableContext = createContext<PiorbitStable | null>(null);
const PiorbitStateContext = createContext<StateStore | null>(null);

export function usePiorbitStable(): PiorbitStable {
  const value = useContext(PiorbitStableContext);
  if (!value) throw new Error("usePiorbit must be used inside <PiorbitProvider>.");
  return value;
}

const identity = <T,>(value: T): T => value;

/**
 * Subscribe to one slice of app state. A streamed token replaces the whole
 * `AppState`, so a component that reads the context value wholesale re-renders
 * per delta; a selector re-renders only when the slice it reads changes.
 *
 * `isEqual` lets a selector that allocates (a derived list) stay stable.
 */
export function usePiorbitState<T>(selector: (state: AppState) => T, isEqual: (a: T, b: T) => boolean = Object.is): T {
  const store = useContext(PiorbitStateContext);
  if (!store) throw new Error("usePiorbitState must be used inside <PiorbitProvider>.");
  const selectorRef = useRef(selector);
  selectorRef.current = selector;
  const isEqualRef = useRef(isEqual);
  isEqualRef.current = isEqual;
  const cache = useRef<{ state: AppState; value: T } | undefined>(undefined);

  const getSnapshot = useCallback((): T => {
    const state = store.getSnapshot();
    const previous = cache.current;
    if (previous && previous.state === state) return previous.value;
    const next = selectorRef.current(state);
    if (previous && isEqualRef.current(previous.value, next)) {
      cache.current = { state, value: previous.value };
      return previous.value;
    }
    cache.current = { state, value: next };
    return next;
  }, [store]);

  return useSyncExternalStore(store.subscribe, getSnapshot, getSnapshot);
}

/** The currently open session view. Identity is stable while it does not change. */
export function usePiorbitView(): SessionView | undefined {
  return usePiorbitState((s) => (s.current ? s.open[s.current] : undefined));
}

/**
 * The whole context. Kept for consumers that genuinely need all of it; anything
 * on a hot path should use {@link usePiorbitState} instead.
 */
export function usePiorbit(): PiorbitContextValue {
  const stable = usePiorbitStable();
  const state = usePiorbitState(identity);
  const view = usePiorbitView();
  return useMemo(() => ({ ...stable, state, view }), [stable, state, view]);
}

// ---------------------------------------------------------------------------
// State store: one mutable AppState the reducer folds into, published through
// `useSyncExternalStore` so consumers can subscribe per slice.
// ---------------------------------------------------------------------------

interface StateStore {
  getSnapshot(): AppState;
  subscribe(listener: () => void): () => void;
  dispatch(action: Action): void;
}

function createStateStore(): StateStore {
  let current = initialState;
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
      const next = reduce(current, action);
      if (Object.is(next, current)) return;
      current = next;
      for (const listener of [...listeners]) listener();
    },
  };
}

// ---------------------------------------------------------------------------
// Snapshot store (see the file header)
// ---------------------------------------------------------------------------

interface RuntimeSnapshot {
  /** The app state store; the thread hook subscribes to just its own slice. */
  store: StateStore;
  client: HostClient;
  dispatch: (action: Action) => void;
  onError: (error: unknown) => void;
  openSession: (path: string) => Promise<void>;
}

interface SnapshotStore<T> {
  set(value: T): void;
  subscribe(listener: () => void): () => void;
  getSnapshot(): T;
}

function createSnapshotStore<T>(initial: T): SnapshotStore<T> {
  let current = initial;
  const listeners = new Set<() => void>();
  return {
    set(value) {
      if (Object.is(value, current)) return;
      current = value;
      for (const listener of listeners) listener();
    },
    subscribe(listener) {
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
      };
    },
    getSnapshot: () => current,
  };
}

// ---------------------------------------------------------------------------
// localStorage helpers (never throw: private mode, quota, SSR)
// ---------------------------------------------------------------------------

const storage = (): Storage | null => {
  try {
    return globalThis.localStorage ?? null;
  } catch {
    return null;
  }
};

const readString = (key: string): string | undefined => {
  try {
    return storage()?.getItem(key) ?? undefined;
  } catch {
    return undefined;
  }
};

const writeString = (key: string, value: string | undefined): void => {
  try {
    if (value === undefined) storage()?.removeItem(key);
    else storage()?.setItem(key, value);
  } catch {
    /* ignore */
  }
};

const readStringList = (key: string): string[] => {
  try {
    const parsed: unknown = JSON.parse(storage()?.getItem(key) ?? "[]");
    return Array.isArray(parsed) ? parsed.filter((v): v is string => typeof v === "string") : [];
  } catch {
    return [];
  }
};

// ---------------------------------------------------------------------------
// Provider
// ---------------------------------------------------------------------------

export interface PiorbitProviderProps {
  children: ReactNode;
  /** Override the host WebSocket URL (defaults to the page origin). */
  url?: string | undefined;
}

export function PiorbitProvider({ children, url }: PiorbitProviderProps): ReactNode {
  const store = useMemo(() => createStateStore(), []);
  const dispatch = store.dispatch;
  // Always the committed state, even inside a socket callback that runs before
  // React re-renders.
  const readState = store.getSnapshot;
  const state = useSyncExternalStore(store.subscribe, store.getSnapshot, store.getSnapshot);

  const [currentProject, setCurrentProjectState] = useState<string | undefined>(() => readString(PROJECT_STORAGE_KEY));
  const [projectList, setProjectList] = useState<ProjectInfo[]>([]);
  const [trustRequests, setTrustRequests] = useState<TrustRequest[]>([]);
  const projectRef = useRef<string | undefined>(currentProject);
  projectRef.current = currentProject;

  const archive = useMemo(() => createArchiveStore(storage()), []);

  /**
   * Host notifications the reducer does not model: the project list, trust
   * questions, per-session attention, and a worker that came back. Kept in a
   * ref so the `HostClient` identity does not depend on it.
   */
  const onHostNotification = useRef<(method: HostNotificationMethod, params: unknown) => void>(() => {});

  const client = useMemo(() => {
    const created: HostClient = new HostClient({
      ...(url !== undefined ? { url } : {}),
      onNotification: (method, params) => {
        dispatch({ type: "notification", method, params });
        onHostNotification.current(method, params);
      },
      onConnection: (s) => dispatch({ type: "connection", state: s }),
      // A worker that restarted numbers its updates from 1 again; without this
      // the reducer would dedupe every one of them as a replay and the session
      // would look alive but render nothing.
      onResume: (path, replayFrom) => {
        if (replayFrom < (readState().open[path]?.lastSeq ?? 0)) {
          created.resync(path, replayFrom);
          dispatch({ type: "resync", path, lastSeq: replayFrom });
        }
      },
      // Never re-open a Pi session the app has dropped.
      shouldResume: (path) => readState().open[path] !== undefined,
    });
    return created;
  }, [url]);

  /** Surface every failed request as a toast; never a silent rejection. */
  const onError = useCallback((error: unknown) => {
    dispatch({ type: "toast", level: "error", text: error instanceof Error ? error.message : String(error) });
  }, []);

  const guard = useCallback(
    <T,>(work: () => Promise<T>): Promise<T | undefined> =>
      work().catch((error: unknown) => {
        onError(error);
        return undefined;
      }),
    [onError],
  );

  // --- connection ---------------------------------------------------------

  useEffect(() => {
    client.connect();
    return () => client.close();
  }, [client]);

  const refreshSessions = useCallback(async () => {
    try {
      const { sessions } = await client.request("pi/session/list", {});
      dispatch({ type: "sessions", sessions });
    } catch {
      /* not connected yet */
    }
  }, [client]);

  /**
   * Coalesced re-list, for attention on a session we do not hold yet (a
   * terminal-started one, or a session another client just made). A burst of
   * these arrives when several projects wake at once, and each list is a
   * catalog scan, so they collapse into one.
   */
  const sessionRefreshTimer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  const scheduleSessionRefresh = useCallback(() => {
    if (sessionRefreshTimer.current) return;
    sessionRefreshTimer.current = setTimeout(() => {
      sessionRefreshTimer.current = undefined;
      void refreshSessions();
    }, 250);
  }, [refreshSessions]);
  useEffect(() => () => clearTimeout(sessionRefreshTimer.current), []);

  const refreshProjects = useCallback(async () => {
    try {
      const { projects } = await client.request("pi/project/list", {});
      setProjectList(projects);
    } catch {
      /* not connected yet */
    }
  }, [client]);

  /**
   * One-time migration: projects used to live in this browser. Hand them to
   * the host so every client gets them, then drop the key.
   */
  const migratedProjects = useRef(false);
  const migrateLocalProjects = useCallback(async () => {
    if (migratedProjects.current) return;
    migratedProjects.current = true;
    const local = readStringList(PROJECTS_STORAGE_KEY);
    if (local.length === 0) return;
    for (const cwd of local) {
      await client.request("pi/project/add", { cwd }).catch(() => {});
    }
    writeString(PROJECTS_STORAGE_KEY, undefined);
    await refreshProjects();
  }, [client, refreshProjects]);

  // Pi creates the session file on the first message and renames happen
  // mid-session, so refresh on connect, whenever a session settles, and on a
  // slow poll while connected.
  const runningCount = Object.values(state.open).filter((v) => v.running).length;
  useEffect(() => {
    if (state.connection === "open") void refreshSessions();
  }, [state.connection, runningCount, refreshSessions]);
  useEffect(() => {
    if (state.connection !== "open") return;
    void migrateLocalProjects().then(() => refreshProjects());
  }, [state.connection, migrateLocalProjects, refreshProjects]);
  useEffect(() => {
    if (state.connection !== "open") return;
    const timer = setInterval(() => void refreshSessions(), 20_000);
    return () => clearInterval(timer);
  }, [state.connection, refreshSessions]);

  // --- session lifecycle --------------------------------------------------

  /**
   * The thread-list `fetch` and the per-thread `isMain` effect both open a
   * thread; without this they race and each one's snapshot clobbers the other.
   */
  const openInFlight = useRef(new Map<string, Promise<void>>());

  const openSession = useCallback(
    (path: string): Promise<void> => {
      const running = openInFlight.current.get(path);
      if (running) return running;
      const work = (async () => {
        const view = readState().open[path];
        const hydrated = view?.hydrated === true;
        // Not hydrated yet: the snapshot below carries the whole transcript, so
        // asking the worker to replay its buffer would only duplicate it.
        const { state: session, replayFrom } = await client.request("session/load", {
          path,
          ...(hydrated ? { fromSeq: view.lastSeq } : {}),
        });
        dispatch({ type: "opened", state: session });
        // `replayFrom` is the earliest seq the worker can actually replay. Below
        // what we hold means a fresh worker epoch; *above* it means its replay
        // buffer no longer reaches back to us and there is a hole. Either way
        // the transcript has to be re-read rather than patched.
        const needsResync = hydrated && replayFrom !== (view?.lastSeq ?? 0);
        if (needsResync) {
          // `seq` restarts at 1 in a new worker, so a mark from the old epoch
          // would suppress every future one and the row would stay unread
          // while the user is looking straight at it.
          seenSeq.current.delete(path);
          client.resync(path, replayFrom);
          dispatch({ type: "resync", path, lastSeq: replayFrom });
        } else {
          client.track(path, hydrated ? view.lastSeq : 0);
        }
        if (!hydrated || needsResync) {
          const seqBefore = readState().open[path]?.lastSeq ?? 0;
          const { entries } = await client.request("pi/session/entries", { path });
          dispatch({ type: "hydrate", path, entries, expectSeq: seqBefore });
        }
      })();
      const tracked = work.finally(() => {
        if (openInFlight.current.get(path) === tracked) openInFlight.current.delete(path);
      });
      openInFlight.current.set(path, tracked);
      return tracked;
    },
    [client],
  );

  const newSession = useCallback(
    async (cwd: string) => {
      const { state: session } = await client.request("session/new", { cwd });
      client.track(session.path, 0);
      dispatch({ type: "opened", state: session });
      dispatch({ type: "hydrate", path: session.path, entries: [] });
      void refreshSessions();
      return session.path;
    },
    [client, refreshSessions],
  );

  const requireCurrent = useCallback((): string => {
    const path = readState().current;
    if (!path) throw new Error("No session is open.");
    return path;
  }, []);

  // --- attention ("seen") -------------------------------------------------

  /** Highest seq we have told the host about, per session, in the current worker epoch. */
  const seenSeq = useRef(new Map<string, number>());

  // A reconnect can land on a restarted host or restarted workers, so every
  // remembered seq belongs to an epoch that may no longer exist.
  useEffect(() => {
    if (state.connection !== "open") seenSeq.current.clear();
  }, [state.connection]);

  /**
   * Only the session on screen counts as "attached" for the host's idle
   * retirement guard. The host used to add a path on every `session/load` and
   * never remove one, so every project touched today kept its worker — and its
   * whole Pi runtime — resident for the life of the window.
   */
  const detached = useRef(new Set<string>());
  useEffect(() => {
    if (state.connection !== "open") {
      detached.current.clear();
      return;
    }
    for (const path of Object.keys(state.open)) {
      if (path === state.current) {
        detached.current.delete(path);
        continue;
      }
      if (detached.current.has(path)) continue;
      detached.current.add(path);
      // Bookkeeping only: nothing is closed, and switching back re-attaches
      // through the `session/load` that `openSession` always sends.
      client.request("pi/session/detach", { path }).catch(() => detached.current.delete(path));
    }
  }, [client, state.connection, state.current, state.open]);

  const markSeen = useCallback(
    (path: string, seq: number) => {
      if ((seenSeq.current.get(path) ?? -1) >= seq) return;
      seenSeq.current.set(path, seq);
      // Fire and forget: attention is a convenience, and a failed mark is
      // corrected by the next one.
      client.request("pi/session/seen", { path, seq }).catch(() => {});
    },
    [client],
  );

  const currentPath = state.current;
  const currentView = currentPath ? state.open[currentPath] : undefined;
  const currentSeq = currentView?.lastSeq ?? 0;
  const currentRunning = currentView?.running ?? false;

  // Read = on screen and settled. While the agent is still working the row
  // should stay "working"; it becomes read when it finishes under your eyes.
  useEffect(() => {
    if (!currentPath || state.connection !== "open" || currentRunning) return;
    if (typeof document !== "undefined" && document.visibilityState === "hidden") return;
    markSeen(currentPath, currentSeq);
  }, [currentPath, currentRunning, currentSeq, markSeen, state.connection]);

  // Coming back to the tab counts as reading it.
  useEffect(() => {
    if (typeof document === "undefined") return;
    const onVisible = () => {
      const s = readState();
      if (document.visibilityState !== "visible" || !s.current) return;
      const view = s.open[s.current];
      if (view && !view.running) markSeen(s.current, view.lastSeq);
    };
    document.addEventListener("visibilitychange", onVisible);
    return () => document.removeEventListener("visibilitychange", onVisible);
  }, [markSeen]);

  // --- actions ------------------------------------------------------------

  const send = useCallback(
    async (content: ContentBlock[], behavior: SendBehavior) => {
      const path = requireCurrent();
      // One implementation of the optimistic block and its rollback, shared
      // with the thread adapter.
      await sendToSession(client, path, content, behavior, dispatch);
    },
    [client, requireCurrent],
  );

  const answerDialog = useCallback(
    async (response: UiDialogResponse) => {
      const path = readState().current;
      const dialog = path ? readState().open[path]?.dialogs.find((d) => d.id === response.id) : undefined;
      dispatch({ type: "dialogAnswered", id: response.id, ...(path !== undefined ? { path } : {}) });
      try {
        await client.request("pi/ui/response", response);
      } catch (error) {
        // The extension is still blocked on `ask()`: put the card back rather
        // than strand it with no way to answer.
        if (path !== undefined && dialog) {
          dispatch({ type: "notification", method: "pi/ui/request", params: { path, ...dialog } });
        }
        throw error;
      }
    },
    [client],
  );

  const applyState = useCallback((session: SessionState) => {
    dispatch({ type: "opened", state: session });
  }, []);

  /**
   * Fold the host-only notifications into local state. Attention is patched
   * onto the catalog rows we already hold rather than triggering a re-list: a
   * running agent changes attention often, and re-listing on each change would
   * mean a full catalog scan per turn.
   */
  onHostNotification.current = (method, params) => {
    switch (method) {
      case "pi/project/updated":
        setProjectList((params as HostNotifications["pi/project/updated"]).projects);
        return;
      case "pi/project/trust_request": {
        const request = params as TrustRequest;
        setTrustRequests((current) => (current.some((r) => r.id === request.id) ? current : [...current, request]));
        return;
      }
      case "pi/project/trust_resolved": {
        const { id } = params as HostNotifications["pi/project/trust_resolved"];
        setTrustRequests((current) => current.filter((r) => r.id !== id));
        return;
      }
      case "pi/session/attention": {
        const { path, attention } = params as HostNotifications["pi/session/attention"];
        const sessions = readState().sessions;
        let changed = false;
        let known = false;
        const next: SessionSummary[] = sessions.map((summary) => {
          if (summary.path !== path) return summary;
          known = true;
          if (summary.attention === attention) return summary;
          changed = true;
          return { ...summary, attention };
        });
        // A session we have never listed: started from a terminal, or created
        // in another client. Dropping this would keep it out of the inbox until
        // the next poll, which is exactly when it is asking for a person.
        if (!known) {
          if (attention !== "idle") scheduleSessionRefresh();
          return;
        }
        if (changed) dispatch({ type: "sessions", sessions: next });
        return;
      }
      case "pi/worker/status": {
        const info = params as WorkerInfo;
        // The host restarted a worker and re-opened its sessions. Their update
        // stream numbers from 1 again, so re-load ours to adopt the new epoch
        // (`openSession` resyncs and re-hydrates when it sees the lower seq).
        if (info.status !== "ready" || !info.reopened?.length) return;
        const open = readState().open;
        for (const path of info.reopened) {
          if (open[path]) void actionsRef.current.openSession(path);
        }
        return;
      }
      default:
        return;
    }
  };

  const fork = useCallback(
    async (entryId: string) => {
      const path = requireCurrent();
      const { state: session, editorText } = await client.request("pi/session/fork", { path, entryId });
      client.untrack(path);
      client.track(session.path, 0);
      dispatch({ type: "forked", from: path, state: session });
      const { entries } = await client.request("pi/session/entries", { path: session.path });
      dispatch({ type: "hydrate", path: session.path, entries });
      if (editorText) {
        dispatch({
          type: "notification",
          method: "pi/ui/event",
          params: { path: session.path, method: "setEditorText", text: editorText },
        });
      }
      void refreshSessions();
    },
    [client, refreshSessions, requireCurrent],
  );

  const actions = useMemo<PiorbitActions>(
    () => ({
      openSession: (path) => guard(() => openSession(path)).then(() => undefined),
      newSession: (cwd) => newSession(cwd),
      send: (content, behavior) => send(content, behavior),
      abort: () => guard(async () => client.request("session/cancel", { path: requireCurrent() })).then(() => undefined),
      answerDialog: (response) => guard(() => answerDialog(response)).then(() => undefined),
      setModel: (model) =>
        guard(async () => {
          if (!model) return;
          const { state: session } = await client.request("pi/model/set", {
            path: requireCurrent(),
            model: { provider: model.provider, id: model.id },
          });
          applyState(session);
        }).then(() => undefined),
      setThinking: (level) =>
        guard(async () => {
          const { state: session } = await client.request("pi/thinking/set", { path: requireCurrent(), level });
          applyState(session);
        }).then(() => undefined),
      listModels: () =>
        guard(async () => {
          const { models } = await client.request("pi/model/list", { path: requireCurrent() });
          return models;
        }).then((models) => models ?? []),
      rename: (name) =>
        guard(async () => {
          await client.request("pi/session/rename", { path: requireCurrent(), name });
          await refreshSessions();
        }).then(() => undefined),
      compact: (instructions) =>
        guard(async () => {
          await client.request("pi/session/compact", {
            path: requireCurrent(),
            ...(instructions !== undefined ? { instructions } : {}),
          });
        }).then(() => undefined),
      fork: (entryId) => guard(() => fork(entryId)).then(() => undefined),
      jump: (entryId) =>
        guard(async () => {
          const path = requireCurrent();
          await client.request("pi/session/navigate", { path, entryId });
          const { entries } = await client.request("pi/session/entries", { path });
          dispatch({ type: "hydrate", path, entries });
        }).then(() => undefined),
      refreshSessions,
      refreshEntries: () =>
        guard(async () => {
          const path = requireCurrent();
          const { entries } = await client.request("pi/session/entries", { path });
          dispatch({ type: "entries", path, entries });
        }).then(() => undefined),
      clearQueue: () =>
        guard(async () => {
          const { steering, followUp } = await client.request("pi/session/clear_queue", { path: requireCurrent() });
          return [...steering, ...followUp].join("\n\n");
        }).then((text) => text ?? ""),
      addProject: (cwd) =>
        guard(async () => {
          const trimmed = cwd.trim();
          if (!trimmed) throw new Error("Type a directory path first.");
          const { project } = await client.request("pi/project/add", { cwd: trimmed });
          setProjectList((current) =>
            current.some((p) => p.cwd === project.cwd) ? current : [...current, project],
          );
          return project;
        }),
      removeProject: (cwd) =>
        guard(async () => {
          await client.request("pi/project/remove", { cwd });
          setProjectList((current) => current.filter((p) => p.cwd !== cwd || p.sessionCount > 0));
          await refreshProjects();
        }).then(() => undefined),
      refreshProjects,
      answerTrust: (cwd, trusted, remember) =>
        guard(async () => {
          const { project } = await client.request("pi/project/trust", { cwd, trusted, remember });
          setProjectList((current) => current.map((p) => (p.cwd === project.cwd ? project : p)));
          setTrustRequests((current) => current.filter((r) => r.cwd !== project.cwd));
        }).then(() => undefined),
      restartWorker: (cwd) =>
        guard(async () => {
          await client.request("pi/worker/restart", { cwd });
        }).then(() => undefined),
      markSeen,
      dismissToast: (id) => dispatch({ type: "dismissToast", id }),
      toast: (level, text) => dispatch({ type: "toast", level, text }),
    }),
    [
      answerDialog,
      applyState,
      client,
      fork,
      guard,
      markSeen,
      newSession,
      openSession,
      refreshProjects,
      refreshSessions,
      requireCurrent,
      send,
    ],
  );

  const actionsRef = useRef<PiorbitActions>(actions);
  actionsRef.current = actions;

  const setCurrentProject = useCallback((cwd: string | undefined) => {
    setCurrentProjectState(cwd);
    writeString(PROJECT_STORAGE_KEY, cwd);
  }, []);

  // The host owns the list; a session opened before the list arrives (or in a
  // directory the host has not indexed yet) still gets a rail icon. Via a
  // string key so the array identity survives a delta — it feeds the stable
  // half of the context.
  const projectsKey = useMemo(() => {
    const set = new Set<string>(projectList.map((p) => p.cwd));
    for (const open of Object.values(state.open)) set.add(open.state.cwd);
    return [...set].sort((a, b) => a.localeCompare(b)).join("\n");
  }, [projectList, state.open]);
  const projects = useMemo(() => (projectsKey ? projectsKey.split("\n") : []), [projectsKey]);
  const projectInfo = useMemo(() => {
    const map: Record<string, ProjectInfo> = {};
    for (const project of projectList) map[project.cwd] = project;
    return map;
  }, [projectList]);

  // Default the project to the first one we learn about.
  useEffect(() => {
    if (currentProject === undefined && projects[0]) setCurrentProject(projects[0]);
  }, [currentProject, projects, setCurrentProject]);

  /**
   * Deep link: `piorbit open` / `piorbit new --open` send the browser to
   * `#/session/<encodeURIComponent(path)>`. Honour it once per hash, and clear
   * the fragment afterwards so a reload does not drag the user back to a
   * session they have since navigated away from. Failure is surfaced through
   * `onError` like any other open, not swallowed — a stale link in a shell
   * history is exactly the case where silence would be confusing.
   */
  const consumedHash = useRef<string | undefined>(undefined);
  useEffect(() => {
    if (state.connection !== "open") return;
    const hash = globalThis.location?.hash ?? "";
    if (hash === consumedHash.current) return;
    const match = /^#\/session\/(.+)$/.exec(hash);
    if (!match?.[1]) return;
    consumedHash.current = hash;
    let path: string;
    try {
      path = decodeURIComponent(match[1]);
    } catch {
      onError(new Error(`That link is not a valid session path: ${hash}`));
      return;
    }
    void openSession(path)
      .then(() => {
        const cwd = readState().open[path]?.state.cwd;
        if (cwd) setCurrentProject(cwd);
      })
      .catch((error: unknown) => {
        onError(
          new Error(
            `Could not open ${path} from the link: ${error instanceof Error ? error.message : String(error)}. ` +
              `Run \`piorbit sessions\` to see what exists.`,
          ),
        );
      })
      .finally(() => {
        const { pathname, search } = globalThis.location;
        globalThis.history?.replaceState(null, "", `${pathname}${search}`);
      });
  }, [state.connection, openSession, onError, readState, setCurrentProject]);

  // --- runtime ------------------------------------------------------------

  const snapshotStore = useMemo(
    () => createSnapshotStore<RuntimeSnapshot>({ store, client, dispatch, onError, openSession }),
    // eslint-disable-next-line react-hooks/exhaustive-deps -- created once; kept in sync below
    [],
  );

  useEffect(() => {
    snapshotStore.set({ store, client, dispatch, onError, openSession });
  }, [snapshotStore, store, client, dispatch, onError, openSession]);

  /** Number of `initialize()` calls in flight; gates the thread-list reload. */
  const [initializing, setInitializing] = useState(0);

  const threadListAdapter = useMemo(
    () =>
      createThreadListAdapter({
        sessions: () => readState().sessions,
        views: () => readState().open,
        archive,
        currentProject: () => projectRef.current ?? Object.values(readState().open)[0]?.state.cwd,
        createSession: (cwd) => actionsRef.current.newSession(cwd),
        renameSession: async (path, name) => {
          await client.request("pi/session/rename", { path, name });
        },
        loadSession: (path) => openSession(path),
        refreshSessions,
        beginInitialize: () => setInitializing((n) => n + 1),
        endInitialize: () => setInitializing((n) => Math.max(0, n - 1)),
      }),
    [archive, client, openSession, refreshSessions],
  );

  const onThreadIdChange = useCallback((threadId: string | undefined) => {
    if (!threadId || threadId === readState().current) return;
    void actionsRef.current.openSession(threadId);
  }, []);

  // Stable so `useRemoteThreadListRuntime` does not re-publish the hook (and
  // re-render every mounted thread) on each of our state updates; the hook
  // reads everything it needs from `snapshotStore`.
  const runtimeHook = useCallback(
    // oxlint-disable-next-line react-hooks/rules-of-hooks -- invoked by useRemoteThreadListRuntime at a stable hook position
    () => useThreadRuntime(snapshotStore),
    [snapshotStore],
  );

  const runtime: AssistantRuntime = useRemoteThreadListRuntime({
    allowNesting: true,
    adapter: threadListAdapter,
    threadId: state.current,
    onThreadIdChange,
    runtimeHook,
  });

  // Keep the thread list in step with the catalog without swapping the adapter
  // (which would drop cached threads and cancel in-flight mutations).
  const signature = useMemo(
    () => threadListSignature(state.sessions, state.open, archive),
    [archive, state.sessions, state.open],
  );
  // Held back while the thread list is adopting a freshly created thread; see
  // `beginInitialize` in threadList.ts. `initializing` is a dependency so the
  // deferred reload runs as soon as the count returns to zero.
  useEffect(() => {
    if (initializing > 0) return;
    void runtime.threads.reload().catch(() => {});
  }, [runtime, signature, initializing]);

  // Identity survives every transcript delta, so a consumer that only reads
  // actions/projects never re-renders while the agent streams.
  const stable = useMemo<PiorbitStable>(
    () => ({
      dispatch,
      client,
      currentProject,
      setCurrentProject,
      projects,
      projectInfo,
      trustRequests,
      archive,
      actions,
    }),
    [actions, archive, client, currentProject, dispatch, projectInfo, projects, setCurrentProject, trustRequests],
  );

  return (
    <PiorbitStateContext.Provider value={store}>
      <PiorbitStableContext.Provider value={stable}>
        <AssistantRuntimeProvider runtime={runtime}>
          <ThreadSelectionSync />
          {children}
        </AssistantRuntimeProvider>
      </PiorbitStableContext.Provider>
    </PiorbitStateContext.Provider>
  );
}

/**
 * assistant-ui → piorbit: a thread picked in an assistant-ui `ThreadList`
 * becomes the open session here. The reverse direction is the controlled
 * `threadId` prop above.
 */
function ThreadSelectionSync(): null {
  const { actions } = usePiorbitStable();
  const current = usePiorbitState((s) => s.current);
  const aui = useAui();
  useAuiEvent("threads.selectionChanged", ({ threadId }) => {
    let remoteId: string | undefined;
    try {
      remoteId = aui.threads.item({ id: threadId }).getState().remoteId;
    } catch {
      remoteId = undefined;
    }
    if (!remoteId || remoteId === current) return;
    void actions.openSession(remoteId);
  });
  return null;
}

// ---------------------------------------------------------------------------
// Per-thread runtime
// ---------------------------------------------------------------------------

function useThreadRuntime(store: SnapshotStore<RuntimeSnapshot>): AssistantRuntime {
  const snapshot = useSyncExternalStore(store.subscribe, store.getSnapshot, store.getSnapshot);
  const aui = useAui();
  const threadListItem = useAuiState((s) => s.threadListItem);
  const isMain = useAuiState((s) => s.threads.mainThreadId === s.threadListItem.id);
  const path = threadListItem.externalId ?? threadListItem.remoteId;

  // Subscribe to this thread's slice only: a delta in another session must not
  // re-render (and re-project) this one.
  const stateStore = snapshot.store;
  const readView = useCallback(
    () => (path ? stateStore.getSnapshot().open[path] : undefined),
    [path, stateStore],
  );
  const view = useSyncExternalStore(stateStore.subscribe, readView, readView);
  const readConnection = useCallback(() => stateStore.getSnapshot().connection, [stateStore]);
  const connection = useSyncExternalStore(stateStore.subscribe, readConnection, readConnection);

  // Load + hydrate a thread the first time it becomes the main one. Cheap and
  // idempotent: an already-hydrated view is skipped, and a load the thread list
  // already started is joined rather than duplicated.
  useEffect(() => {
    if (!isMain || !path) return;
    const current = store.getSnapshot();
    if (current.store.getSnapshot().open[path]?.hydrated) return;
    void current.openSession(path).catch(current.onError);
  }, [isMain, path, store]);

  const projection = useMemo(() => projectSessionView(view), [view]);
  const sharedRef = useRef<readonly ThreadMessageLike[]>([]);
  const messages = useMemo(() => {
    const shared = shareProjectedMessages(projection.messages, sharedRef.current);
    sharedRef.current = shared;
    return shared;
  }, [projection]);

  const resolvePath = useCallback(async () => {
    const { remoteId, externalId } = await aui.threadListItem.initialize();
    return externalId ?? remoteId;
  }, [aui]);

  const adapter = useMemo(
    () =>
      createThreadAdapter({
        client: snapshot.client,
        path,
        view,
        connection,
        dispatch: snapshot.dispatch,
        onError: snapshot.onError,
        resolvePath,
        projection: { ...projection, messages: messages as ThreadMessageLike[] },
      }),
    [connection, messages, path, projection, resolvePath, snapshot, view],
  );

  return useExternalStoreRuntime<ThreadMessageLike>(adapter);
}

// ---------------------------------------------------------------------------
// Focused hooks for the shell
// ---------------------------------------------------------------------------

export interface HostUiRequests {
  /** Dialogs with no owning tool row; render these above the composer. */
  requests: UiDialogRequest[];
  respond(response: UiDialogResponse): Promise<void>;
}

/** Free-standing extension dialogs for the current session. */
export function useHostUiRequests(): HostUiRequests {
  const { actions } = usePiorbitStable();
  const view = usePiorbitView();
  const requests = useMemo(() => {
    if (!view) return [];
    const toolCallIds = new Set(view.blocks.filter((b) => b.kind === "tool").map((b) => b.id));
    return splitDialogs(view.dialogs, toolCallIds).freeStanding;
  }, [view]);
  return { requests, respond: actions.answerDialog };
}

export interface SessionMeta {
  path: string | undefined;
  session: SessionState | undefined;
  model: ModelRef | null;
  thinkingLevel: ThinkingLevel | undefined;
  contextUsage: SessionState["contextUsage"];
  running: boolean;
  compacting: boolean;
  connection: AppState["connection"];
  /** Worker status for this session's project directory. */
  worker: { status: string; message?: string } | undefined;
}

export function useSessionMeta(): SessionMeta {
  const view = usePiorbitView();
  const connection = usePiorbitState((s) => s.connection);
  const workers = usePiorbitState((s) => s.workers);
  return useMemo(
    () => ({
      path: view?.path,
      session: view?.state,
      model: view?.state.model ?? null,
      thinkingLevel: view?.state.thinkingLevel,
      contextUsage: view?.state.contextUsage,
      running: view?.running ?? false,
      compacting: view?.state.isCompacting ?? false,
      connection,
      worker: view ? workers[view.state.cwd] : undefined,
    }),
    [connection, view, workers],
  );
}

export interface ExtensionUi {
  statuses: Record<string, string>;
  widgets: Record<string, { lines: string[]; placement: "aboveEditor" | "belowEditor" }>;
  title: string | undefined;
  /** Text an extension (or a fork) asked us to put into the composer. */
  editorText: string | undefined;
}

export function useExtensionUi(): ExtensionUi {
  const view = usePiorbitView();
  return useMemo(
    () => ({
      statuses: view?.statuses ?? {},
      widgets: view?.widgets ?? {},
      title: view?.title,
      editorText: view?.editorText,
    }),
    [view],
  );
}

export interface TrustPrompts {
  /** Oldest first; the host holds a worker start open for each. */
  requests: TrustRequest[];
  answer(cwd: string, trusted: boolean, remember: boolean): Promise<void>;
}

/** Project-trust questions raised by the host (M2-T4). */
export function useTrustPrompts(): TrustPrompts {
  const { trustRequests, actions } = usePiorbitStable();
  return useMemo(
    () => ({ requests: trustRequests, answer: actions.answerTrust }),
    [actions.answerTrust, trustRequests],
  );
}

export interface Toasts {
  toasts: AppState["toasts"];
  dismiss(id: number): void;
}

export function useToasts(): Toasts {
  const { actions } = usePiorbitStable();
  const toasts = usePiorbitState((s) => s.toasts);
  return useMemo(() => ({ toasts, dismiss: actions.dismissToast }), [actions.dismissToast, toasts]);
}
