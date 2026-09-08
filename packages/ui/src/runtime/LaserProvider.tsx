"use client";
import { accountUsageRefreshError } from "./account-usage-error.js";
/**
 * The one stateful shell of the UI: owns the `HostClient`, the reducer, the
 * selected project, and the assistant-ui runtime.
 *
 * Shape mirrors `@assistant-ui/react-pi`'s `usePiRuntime`: a
 * `useRemoteThreadListRuntime` over the session catalog whose per-thread
 * `runtimeHook` builds a `useExternalStoreRuntime` for the open session.
 *
 * Everything laser needs that assistant-ui does not model — free-standing
 * extension dialogs, status pills, widgets, worker status, projects, the
 * session tree — hangs off {@link useLaser} instead of being forced into a
 * runtime seam.
 *
 * Why the snapshot store: `useRemoteThreadListRuntime` stores `runtimeHook` in
 * a subscribable it refreshes in an effect, so a closure over React state
 * reaches the per-thread hook one render late. The hook therefore subscribes to
 * a small external store that this component keeps in sync, and reads no
 * closed-over state at all.
 */
import { PRODUCT_NAME, storageKey } from "@lasercode/protocol";
import {
  AssistantRuntimeProvider,
  AuiConfig,
  AuiProvider,
  useAui,
  useAuiEvent,
  useAuiState,
  useExternalStoreRuntime,
  useRemoteThreadListRuntime,
} from "@assistant-ui/react";
import type { AssistantRuntime, RemoteThreadListAdapter, ThreadMessageLike } from "@assistant-ui/react";
import type {
  ContentBlock,
  GoalAction,
  HostNotificationMethod,
  HostNotifications,
  ModelRef,
  ProjectInfo,
  SessionAgentInfo,
  SessionState,
  SessionSummary,
  ThinkingLevel,
  UiDialogRequest,
  UiDialogResponse,
  WorkerInfo,
} from "@lasercode/protocol";
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
import { createAgentsActions, type AgentsActions } from "../agents/actions.js";
import { HostClient } from "../client.js";
import { initialState, reduce, type Action, type AppState, type SessionView } from "../store.js";
import { createThreadAdapter, sendToSession, type SendBehavior } from "./adapter.js";
import { createSessionLauncher, type NewSessionOptions } from "./new-session.js";
import { useThemeSync } from "./prefs.js";
import { projectSessionView, shareProjectedMessages, splitDialogs } from "./projection.js";
import {
  createArchiveStore,
  createThreadListAdapter,
  orderProjectInfos,
  threadListSignature,
  visibleProjectCwds,
  type ArchiveStore,
} from "./threadList.js";

export const PROJECT_STORAGE_KEY = storageKey("project");
/**
 * Pre-M2 project list. Projects now live in the host (`pi/project/*`) so the
 * CLI, a second browser and a phone all see one list; this key is only read
 * once, to hand old local entries to the host, and then removed.
 */
export const PROJECTS_STORAGE_KEY = storageKey("projects");

/**
 * The last session read in each project, so a reload comes back to it.
 *
 * Identity and position survive every transition (AGENTS.md, "Motion is a
 * material"), and a browser reload is a transition like any other: coming back
 * to "No session open" after refreshing is the app forgetting where the person
 * was. Per project, because switching projects in the rail should land on that
 * project's work, not on whatever was open last anywhere.
 */
export const SESSION_STORAGE_KEY = storageKey("session");

/** A project-trust question the host is holding a worker start on (M2-T4). */
export type TrustRequest = HostNotifications["pi/project/trust_request"];

// ---------------------------------------------------------------------------
// Context
// ---------------------------------------------------------------------------

export interface LaserActions {
  /** `session/load` (+ `pi/session/entries` on first open) and select it. */
  openSession(path: string): Promise<void>;
  /**
   * Select an unstarted session in `cwd`, or create one; returns its path.
   * `agentName` picks the definition (omitted: the default agent); an empty
   * session is only reused for the same agent.
   */
  newSession(cwd: string, options?: NewSessionOptions): Promise<string>;
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
  /** Refresh cross-app allowance for the session's account provider. */
  refreshAccountUsage(): Promise<void>;
  goal(action: GoalAction): Promise<void>;
  /** `pi/session/clear_queue`; resolves with the text to restore into the composer. */
  clearQueue(): Promise<string>;
  /**
   * `pi/project/add` — server-side, so every client and the CLI see it.
   * Resolves with the host's record, or `undefined` when the add failed (the
   * failure is already on screen as a toast).
   */
  addProject(cwd: string): Promise<ProjectInfo | undefined>;
  /** Persist project priority shared by the rail and grouped sessions list. */
  reorderProjects(cwds: string[]): Promise<void>;
  removeProject(cwd: string): Promise<void>;
  refreshProjects(): Promise<void>;
  /** Answer a `pi/project/trust_request`. The held-back worker starts (or does not). */
  answerTrust(cwd: string, trusted: boolean, remember: boolean): Promise<void>;
  /** Start a crashed or retired worker again (`pi/worker/restart`). */
  restartWorker(cwd: string): Promise<void>;
  /** Tell the host this session has been read up to its latest update. */
  markSeen(path: string, seq: number, force?: boolean): void;
  dismissToast(id: number): void;
  toast(level: "info" | "warning" | "error", text: string): void;
  /** Agent definitions, runs, Beam and Namer (`agents/*`). See agents/actions.ts for failure styles. */
  agents: AgentsActions;
}

export interface LaserContextValue {
  state: AppState;
  dispatch: (action: Action) => void;
  client: HostClient;
  /** The currently open session view, if any. */
  view: SessionView | undefined;
  currentProject: string | undefined;
  /** The remembered startup destination is still connecting or hydrating. */
  startupRestoring: boolean;
  setCurrentProject: (cwd: string | undefined) => void;
  /** Every cwd we know about: the host's project list, plus any open session's. */
  projects: string[];
  /** The host's project records, keyed by cwd (trust, pin, session count). */
  projectInfo: Readonly<Record<string, ProjectInfo>>;
  /** Project-trust questions waiting for an answer. */
  trustRequests: TrustRequest[];
  archive: ArchiveStore;
  actions: LaserActions;
}

/** Everything that does not change when the transcript does. */
export type LaserStable = Omit<LaserContextValue, "state" | "view">;

const LaserStableContext = createContext<LaserStable | null>(null);
const LaserStateContext = createContext<StateStore | null>(null);

/**
 * What a `LaserThreadScope` needs from the provider and nothing else sees:
 * the real store, the client, the quiet session open and the actions
 * factory. Internal to this file on purpose.
 */
interface LaserInternals {
  store: StateStore;
  client: HostClient;
  dispatch: (action: Action) => void;
  onError: (error: unknown) => void;
  openSession: (path: string, options?: { select?: boolean }) => Promise<void>;
  buildActions: (readScoped: () => AppState) => LaserActions;
  archive: ArchiveStore;
  refreshSessions: () => Promise<void>;
  /** Keep `path` attached on the host while a scope shows it; returns the release. */
  attach: (path: string) => () => void;
}
const LaserInternalsContext = createContext<LaserInternals | null>(null);

export function useLaserStable(): LaserStable {
  const value = useContext(LaserStableContext);
  if (!value) throw new Error("useLaser must be used inside <LaserProvider>.");
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
export function useLaserState<T>(selector: (state: AppState) => T, isEqual: (a: T, b: T) => boolean = Object.is): T {
  const store = useContext(LaserStateContext);
  if (!store) throw new Error("useLaserState must be used inside <LaserProvider>.");
  const selectorRef = useRef(selector);
  selectorRef.current = selector;
  const isEqualRef = useRef(isEqual);
  isEqualRef.current = isEqual;
  const cache = useRef<{ state: AppState; selector: (state: AppState) => T; value: T } | undefined>(undefined);

  const getSnapshot = useCallback((): T => {
    const state = store.getSnapshot();
    const selector = selectorRef.current;
    const previous = cache.current;
    // The selector is part of the key: one that closes over a prop (a session
    // path, a project list) must answer for the new prop even when no state
    // has changed since. A memoized selector still pays nothing per render.
    if (previous && previous.state === state && previous.selector === selector) return previous.value;
    const next = selector(state);
    if (previous && isEqualRef.current(previous.value, next)) {
      cache.current = { state, selector, value: previous.value };
      return previous.value;
    }
    cache.current = { state, selector, value: next };
    return next;
  }, [store]);

  return useSyncExternalStore(store.subscribe, getSnapshot, getSnapshot);
}

/**
 * Test seam: mount the state hooks over a bare store, with no host connection.
 * Only {@link useLaserState} and what is built on it work inside; anything that
 * needs actions or the client still requires the full provider.
 */
export function LaserStoreProvider({ store, children }: { store: StateStore; children: ReactNode }): ReactNode {
  return <LaserStateContext.Provider value={store}>{children}</LaserStateContext.Provider>;
}

/** The currently open session view. Identity is stable while it does not change. */
export function useLaserView(): SessionView | undefined {
  return useLaserState((s) => (s.current ? s.open[s.current] : undefined));
}

/**
 * The whole context. Kept for consumers that genuinely need all of it; anything
 * on a hot path should use {@link useLaserState} instead.
 */
export function useLaser(): LaserContextValue {
  const stable = useLaserStable();
  const state = useLaserState(identity);
  const view = useLaserView();
  return useMemo(() => ({ ...stable, state, view }), [stable, state, view]);
}

// ---------------------------------------------------------------------------
// State store: one mutable AppState the reducer folds into, published through
// `useSyncExternalStore` so consumers can subscribe per slice.
// ---------------------------------------------------------------------------

export interface StateStore {
  getSnapshot(): AppState;
  subscribe(listener: () => void): () => void;
  dispatch(action: Action): void;
}

export function createStateStore(initial: AppState = initialState): StateStore {
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

/**
 * Forget every remembered destination, so the next load opens no session.
 * Setup owns the window only while nothing is open (D-47); without this, a
 * reload during setup would restore the last session and hide the flow.
 */
export function forgetRememberedSessions(): void {
  writeString(SESSION_STORAGE_KEY, undefined);
}

/** `{ "<project cwd>": "<session path>" }`, and never anything else. */
const readStringMap = (key: string): Record<string, string> => {
  try {
    const parsed: unknown = JSON.parse(storage()?.getItem(key) ?? "{}");
    if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) return {};
    return Object.fromEntries(Object.entries(parsed as Record<string, unknown>).filter((entry): entry is [string, string] => typeof entry[1] === "string"));
  } catch {
    return {};
  }
};

/** Last path segment, for a sentence about a directory. */
const basenameOf = (cwd: string): string => cwd.replace(/[/\\]+$/, "").split(/[/\\]/).pop() || cwd;

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

export interface LaserProviderProps {
  children: ReactNode;
  /** Override the host WebSocket URL (defaults to the page origin). */
  url?: string | undefined;
}

export function LaserProvider({ children, url }: LaserProviderProps): ReactNode {
  const store = useMemo(() => createStateStore(), []);
  const dispatch = store.dispatch;
  // Always the committed state, even inside a socket callback that runs before
  // React re-renders.
  const readState = store.getSnapshot;
  const state = useSyncExternalStore(store.subscribe, store.getSnapshot, store.getSnapshot);

  const [currentProject, setCurrentProjectState] = useState<string | undefined>(() => readString(PROJECT_STORAGE_KEY));
  const [startupRestoring, setStartupRestoring] = useState(true);
  const [projectList, setProjectList] = useState<ProjectInfo[]>([]);
  const [trustRequests, setTrustRequests] = useState<TrustRequest[]>([]);
  const projectRef = useRef<string | undefined>(currentProject);
  projectRef.current = currentProject;

  const archive = useMemo(() => createArchiveStore(storage()), []);
  const archiveRevision = useSyncExternalStore(archive.subscribe, archive.getSnapshot, archive.getSnapshot);

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
      onVersionMismatch: (version) => dispatch({ type: "versionMismatch", version }),
      // A worker that restarted numbers its updates from 1 again; without this
      // the reducer would dedupe every one of them as a replay and the session
      // would look alive but render nothing.
      // Compared against the watermark the *request* carried, never against
      // live state: the worker sends its replayed updates from inside the
      // `session/load` handler, so they are already flushed into the store by
      // the time this runs. Reading `lastSeq` here would see the replay's own
      // tail and rewind the dedupe watermark on every healthy reconnect —
      // which duplicates the transcript on the next one.
      onResume: (path, replayFrom, sentFromSeq) => {
        if (replayFrom !== sentFromSeq) {
          seenSeq.current.delete(path);
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

  // The theme is host-owned (M11-T6): it arrives on connect and any device's
  // change reaches the others, so a phone opens wearing what the desktop wears.
  useThemeSync(client, state.connection === "open");

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
  const openInFlight = useRef(new Map<string, { promise: Promise<void>; select: boolean }>());

  /**
   * `select: false` loads without making the session current: a scoped
   * surface (`LaserThreadScope`, the Beam bubble) reads its session this way
   * so the main view stays where it is.
   */
  const openSession = useCallback(
    (path: string, options: { select?: boolean } = {}): Promise<void> => {
      const select = options.select !== false;
      const running = openInFlight.current.get(path);
      if (running) {
        // A selecting open that joins a quiet one still has to land on the
        // session once it is there; a quiet one joins a selecting one as-is.
        if (!select || running.select) return running.promise;
        return running.promise.then(() => {
          if (readState().open[path] && readState().current !== path) dispatch({ type: "select", path });
        });
      }
      const work = (async () => {
        // The page and the socket come up together: without this the first
        // session someone clicks after a reload was a dead click.
        await client.whenConnected();
        const view = readState().open[path];
        const hydrated = view?.hydrated === true;
        // Not hydrated yet: the snapshot below carries the whole transcript, so
        // asking the worker to replay its buffer would only duplicate it.
        const { state: session, replayFrom } = await client.request("session/load", {
          path,
          ...(hydrated ? { fromSeq: view.lastSeq } : {}),
        });
        dispatch({ type: "opened", state: session, ...(select ? {} : { select: false }) });
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
        const { goal } = await client.request("session/goal/get", { path });
        dispatch({ type: "goal", path, goal });
      })();
      const entry = {
        select,
        promise: work.finally(() => {
          if (openInFlight.current.get(path) === entry) openInFlight.current.delete(path);
        }),
      };
      openInFlight.current.set(path, entry);
      return entry.promise;
    },
    [client],
  );

  const newSession = useMemo(() => createSessionLauncher({
    state: readState,
    archived: (path) => archive.has(path),
    refresh: async () => {
      await client.whenConnected();
      const { sessions } = await client.request("pi/session/list", {});
      dispatch({ type: "sessions", sessions });
    },
    open: openSession,
    select: (path) => dispatch({ type: "select", path }),
    // A session with no attribution runs the default agent, and so does a
    // request with no `agentName`: both resolve through the snapshot so the
    // launcher compares definitions, not the presence of a field.
    resolveAgent: (name) => name ?? readState().agents.snapshot?.defaultAgent,
    create: async (cwd, options) => {
      const { state: session } = await client.request("session/new", {
        cwd,
        ...(options.agentName !== undefined ? { agentName: options.agentName } : {}),
      });
      client.track(session.path, 0);
      dispatch({ type: "opened", state: session, ...(options.select === false ? { select: false } : {}) });
      dispatch({ type: "hydrate", path: session.path, entries: [] });
      dispatch({ type: "goal", path: session.path, goal: null });
      void refreshSessions();
      return session.path;
    },
  }), [archive, client, openSession, refreshSessions]);

  // `requireCurrent`, `send`, `answerDialog` and `fork` live inside
  // `buildActions` below: they read "the current session" through the state
  // reader they are built with, so a `LaserThreadScope` can rebind the same
  // actions to its own session.

  // --- agents -------------------------------------------------------------

  const agentsActions = useMemo(() => createAgentsActions({ client, dispatch, guard }), [client, guard]);

  // Definitions and the run registry come up with the connection and again
  // after every reconnect: a restarted host may hold different agents, and a
  // run that ended while we were away is only in its list.
  useEffect(() => {
    if (state.connection !== "open") return;
    void agentsActions.refresh();
    void agentsActions.runs();
  }, [agentsActions, state.connection]);

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
  /**
   * Sessions a `LaserThreadScope` is showing (the Beam bubble). They are on
   * screen too, so they stay attached for as long as the scope holds them;
   * the counter re-runs the effect when a scope comes or goes.
   */
  const scopedPaths = useRef(new Map<string, number>());
  const [scopeRevision, setScopeRevision] = useState(0);
  const attachScope = useCallback((path: string): (() => void) => {
    scopedPaths.current.set(path, (scopedPaths.current.get(path) ?? 0) + 1);
    // The scope's own `session/load` re-attaches it on the host; forget the
    // detach so it is sent again once the scope lets go.
    detached.current.delete(path);
    setScopeRevision((n) => n + 1);
    return () => {
      const left = (scopedPaths.current.get(path) ?? 1) - 1;
      if (left <= 0) scopedPaths.current.delete(path);
      else scopedPaths.current.set(path, left);
      setScopeRevision((n) => n + 1);
    };
  }, []);
  useEffect(() => {
    if (state.connection !== "open") {
      detached.current.clear();
      return;
    }
    for (const path of Object.keys(state.open)) {
      if (path === state.current || scopedPaths.current.has(path)) {
        detached.current.delete(path);
        continue;
      }
      if (detached.current.has(path)) continue;
      detached.current.add(path);
      // Bookkeeping only: nothing is closed, and switching back re-attaches
      // through the `session/load` that `openSession` always sends.
      client.request("pi/session/detach", { path }).catch(() => detached.current.delete(path));
    }
  }, [client, scopeRevision, state.connection, state.current, state.open]);

  const markSeen = useCallback(
    (path: string, seq: number, force = false) => {
      if (!force && (seenSeq.current.get(path) ?? -1) >= seq) return;
      seenSeq.current.set(path, seq);
      // Fire and forget: attention is a convenience, and a failed mark is
      // corrected by the next one.
      client.request("pi/session/seen", { path, seq }).catch(() => {
        if (seenSeq.current.get(path) === seq) seenSeq.current.delete(path);
      });
    },
    [client],
  );

  // --- actions ------------------------------------------------------------

  // A refreshed snapshot of a session that is already current where it was
  // asked for (`setModel`, `setThinking`): never a selection. Inside a
  // `LaserThreadScope` a selecting `opened` would drag the main view onto the
  // bubble's session.
  const applyState = useCallback((session: SessionState) => {
    dispatch({ type: "opened", state: session, select: false });
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
      case "agents/run": {
        // A run in a session we have never listed is a child an agent just
        // started: list again so its row and its map node have a title.
        const { run } = params as HostNotifications["agents/run"];
        if (!readState().sessions.some((summary) => summary.path === run.sessionPath)) scheduleSessionRefresh();
        return;
      }
      default:
        return;
    }
  };

  /**
   * The actions, built over a state reader. The provider's own actions read
   * the real store, so "the current session" is `state.current`; a
   * `LaserThreadScope` builds a second set over a store whose `current` is its
   * own session, and every session-bound verb below follows it — the composer
   * inside the Beam bubble sets Beam's model, not the main session's.
   */
  const buildActions = useCallback((readScoped: () => AppState): LaserActions => {
    const requireCurrent = (): string => {
      const path = readScoped().current;
      if (!path) throw new Error("No session is open.");
      return path;
    };

    const send = async (content: ContentBlock[], behavior: SendBehavior) => {
      const path = requireCurrent();
      // One implementation of the optimistic block and its rollback, shared
      // with the thread adapter.
      await sendToSession(client, path, content, behavior, dispatch);
    };

    const answerDialog = async (response: UiDialogResponse) => {
      const path = readScoped().current;
      const dialog = path ? readScoped().open[path]?.dialogs.find((d) => d.id === response.id) : undefined;
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
    };

    const fork = async (entryId: string) => {
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
    };

    return {
      openSession: (path) => guard(() => openSession(path)).then(() => undefined),
      newSession: (cwd, options) => newSession(cwd, options),
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
      refreshAccountUsage: () =>
        guard(async () => {
          const { delivered } = await client.request("pi/account-usage/refresh", { path: requireCurrent() }).catch(error => { throw accountUsageRefreshError(error); });
          if (!delivered) throw new Error("Account allowance is not available in this session.");
        }).then(() => undefined),
      goal: (action) =>
        guard(async () => {
          const path = requireCurrent();
          const { goal } = await client.request("session/goal/action", { path, action });
          dispatch({ type: "goal", path, goal });
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
      reorderProjects: async (cwds) => {
        // Reorder immediately; the local host normally answers within a frame,
        // but the interaction should not snap back while it waits.
        setProjectList((current) => orderProjectInfos(current, cwds));
        const result = await guard(() => client.request("pi/project/reorder", { cwds }));
        if (result) setProjectList(result.projects);
        else await refreshProjects();
      },
      removeProject: (cwd) =>
        guard(async () => {
          await client.request("pi/project/remove", { cwd });
          const { projects: after } = await client.request("pi/project/list", {});
          setProjectList(after);
          // Removing unpins; it never deletes, and two things can keep the
          // directory on screen anyway: the host still lists it because the
          // session catalog has seen sessions there, or this client is holding
          // one of its sessions open (a project whose session is open must
          // never lose its rail icon — see `projectsKey`). Either way, a row
          // that stays put after "Remove" reads as a button that does not work,
          // so say which it is.
          const still = after.find((project) => project.cwd === cwd);
          const openHere = Object.values(readState().open).some((view) => view.state.cwd === cwd);
          const archivedCount = readState().sessions.filter(
            (session) => session.cwd === cwd && archive.has(session.path),
          ).length;
          const unarchivedCount = Math.max(0, (still?.sessionCount ?? 0) - archivedCount);
          if (still && unarchivedCount > 0) {
            dispatch({
              type: "toast",
              level: "info",
              text: `${basenameOf(cwd)} is still listed: ${unarchivedCount} unarchived chat${unarchivedCount === 1 ? "" : "s"} remain. Archive them to take it off the list; nothing was deleted.`,
            });
          } else if (openHere) {
            dispatch({
              type: "toast",
              level: "info",
              text: `${basenameOf(cwd)} is off the list. It stays in the rail while one of its sessions is open, so that session cannot go missing.`,
            });
          } else {
            if (projectRef.current === cwd) {
              setCurrentProjectState(undefined);
              writeString(PROJECT_STORAGE_KEY, undefined);
            }
            dispatch({ type: "toast", level: "info", text: `${basenameOf(cwd)} is off the list. Nothing on disk was deleted.` });
          }
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
      agents: agentsActions,
    };
  }, [
    agentsActions,
    applyState,
    archive,
    client,
    guard,
    markSeen,
    newSession,
    openSession,
    refreshProjects,
    refreshSessions,
  ]);

  const actions = useMemo<LaserActions>(() => buildActions(readState), [buildActions, readState]);

  const actionsRef = useRef<LaserActions>(actions);
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
    const workspaces = state.agents.snapshot?.workspaces;
    return visibleProjectCwds(projectList, state.sessions, state.open, archive, { exclude: workspaces ? [workspaces.beam, workspaces.chat] : [] }).join("\n");
  }, [archive, archiveRevision, projectList, state.open, state.sessions, state.agents.snapshot?.workspaces]);
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
   * Remember the session being read, per project.
   *
   * Written from the committed state rather than from the click, so it also
   * follows a session opened by a deep link, by the command palette or by the
   * sessions panel — there is one place a session becomes current, and this is
   * downstream of it.
   */
  useEffect(() => {
    const path = state.current;
    if (!path) return;
    const cwd = state.open[path]?.state.cwd;
    if (!cwd) return;
    const remembered = readStringMap(SESSION_STORAGE_KEY);
    if (remembered[cwd] === path) return;
    writeString(SESSION_STORAGE_KEY, JSON.stringify({ ...remembered, [cwd]: path }));
  }, [state.current, state.open]);

  /**
   * Reopen it once, on the first connection, unless a deep link is asking for
   * something else — that link is a deliberate instruction and this is a memory.
   *
   * A session that has since been deleted or archived simply does not come
   * back: the entry is dropped and the landing screen stands. Nothing is said
   * about it, because the person did not ask for it this time.
   */
  const restoredSession = useRef(false);
  useEffect(() => {
    if (restoredSession.current || state.connection !== "open") return;
    if (/^#\/session\//.test(globalThis.location?.hash ?? "")) return;
    restoredSession.current = true;
    const cwd = projectRef.current;
    if (!cwd) {
      setStartupRestoring(false);
      return;
    }
    const remembered = readStringMap(SESSION_STORAGE_KEY);
    const path = remembered[cwd];
    if (!path) {
      setStartupRestoring(false);
      return;
    }
    void openSession(path)
      .catch(() => {
        const { [cwd]: _gone, ...rest } = readStringMap(SESSION_STORAGE_KEY);
        writeString(SESSION_STORAGE_KEY, JSON.stringify(rest));
      })
      .finally(() => setStartupRestoring(false));
  }, [state.connection, openSession, readState]);

  /**
   * Deep link: `laser open` / `laser new --open` send the browser to
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
      setStartupRestoring(false);
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
              `Run \`${PRODUCT_NAME} sessions\` to see what exists.`,
          ),
        );
      })
      .finally(() => {
        const { pathname, search } = globalThis.location;
        globalThis.history?.replaceState(null, "", `${pathname}${search}`);
        setStartupRestoring(false);
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
        deleteSession: async (path) => {
          await client.request("pi/session/delete", { path });
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
  const stable = useMemo<LaserStable>(
    () => ({
      dispatch,
      client,
      currentProject,
      startupRestoring,
      setCurrentProject,
      projects,
      projectInfo,
      trustRequests,
      archive,
      actions,
    }),
    [actions, archive, client, currentProject, dispatch, projectInfo, projects, setCurrentProject, startupRestoring, trustRequests],
  );

  const internals = useMemo<LaserInternals>(
    () => ({ store, client, dispatch, onError, openSession, buildActions, archive, refreshSessions, attach: attachScope }),
    [archive, attachScope, buildActions, client, dispatch, onError, openSession, refreshSessions, store],
  );

  return (
    <LaserStateContext.Provider value={store}>
      <LaserStableContext.Provider value={stable}>
        <LaserInternalsContext.Provider value={internals}>
          <AssistantRuntimeProvider runtime={runtime}>
            <ThreadSelectionSync />
            {children}
          </AssistantRuntimeProvider>
        </LaserInternalsContext.Provider>
      </LaserStableContext.Provider>
    </LaserStateContext.Provider>
  );
}

/**
 * assistant-ui → laser: a thread picked in an assistant-ui `ThreadList`
 * becomes the open session here. The reverse direction is the controlled
 * `threadId` prop above.
 */
function ThreadSelectionSync(): null {
  const { actions } = useLaserStable();
  const current = useLaserState((s) => s.current);
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
// A second thread, scoped: the Beam bubble
// ---------------------------------------------------------------------------

/**
 * The same app state with `current` replaced by the scope's session, so every
 * `useLaserState`, `useLaserView` and `useSessionMeta` under the scope reads
 * that session while the store itself stays one. Derived lazily and cached
 * per underlying state, so identity survives every unrelated delta.
 */
function createScopedStateStore(store: StateStore, path: string | undefined): StateStore {
  let source: AppState | undefined;
  let derived: AppState | undefined;
  return {
    getSnapshot: () => {
      const state = store.getSnapshot();
      if (state !== source || derived === undefined) {
        source = state;
        derived = state.current === path ? state : { ...state, current: path };
      }
      return derived;
    },
    subscribe: store.subscribe,
    dispatch: store.dispatch,
  };
}

/** Everything the scope's filter is asked about, for catalog rows and open views alike. */
export interface ScopedSessionShape {
  cwd: string;
  agent?: SessionAgentInfo | undefined;
}

export interface LaserThreadScopeProps {
  /** The session this scope shows; `undefined` is a thread that does not exist yet. */
  path: string | undefined;
  /**
   * The scope adopted a session: its first message created one, or the one it
   * was given cannot be opened any more (then `undefined`).
   */
  onPathChange: (path: string | undefined) => void;
  /** Which sessions belong to this scope's thread list. */
  filter: (session: ScopedSessionShape, state: AppState) => boolean;
  /**
   * Where a brand-new session is created and which agent runs it. `undefined`
   * (the host has not said yet) refuses creation with `unavailable`, written
   * for the person who just pressed Enter.
   */
  createIn: (state: AppState) => { cwd: string; agentName?: string } | undefined;
  unavailable: string;
  children: ReactNode;
}

const ISOLATED_ROOT = AuiConfig({});

/**
 * A failure the scope has already put in front of the person (its refusal
 * notice); the thread adapter's error path must not toast it a second time.
 */
const SURFACED = Symbol.for("lasercode.scope.surfaced");
const markSurfaced = (error: unknown): Error => {
  const wrapped = error instanceof Error ? error : new Error(String(error));
  (wrapped as Error & { [SURFACED]?: true })[SURFACED] = true;
  return wrapped;
};
const isSurfaced = (error: unknown): boolean => error instanceof Error && (error as Error & { [SURFACED]?: true })[SURFACED] === true;

export interface ThreadScopeRefusal {
  /** Why the last message could not start a session, in the host's words; `undefined` when nothing is wrong. */
  refusal: string | undefined;
  dismissRefusal(): void;
}

const ThreadScopeRefusalContext = createContext<ThreadScopeRefusal>({ refusal: undefined, dismissRefusal: () => {} });

/** The scope's refusal, for a notice rendered inside the scope (the Beam bubble). */
export function useThreadScopeRefusal(): ThreadScopeRefusal {
  return useContext(ThreadScopeRefusalContext);
}

/**
 * A second, independent thread over the same host connection and store
 * (AGENTS.md invariant 8 holds: one session is still written by one worker;
 * this only reads it from a second place).
 *
 * The bubble and the main view show different sessions at once, so the scope
 * owns three things: a state store whose `current` is its own session (so the
 * ordinary `Thread`, composer and status line inside read it), a set of
 * actions bound to that store (so "set model" inside the bubble sets Beam's
 * model), and its own `useRemoteThreadListRuntime` under an isolated aui root
 * — nested under the main runtime it would silently become a no-op bound to
 * the main thread. Sessions it opens are opened quietly (`select: false`),
 * so the main view never moves.
 */
export function LaserThreadScope({ path, onPathChange, filter, createIn, unavailable, children }: LaserThreadScopeProps): ReactNode {
  const internals = useContext(LaserInternalsContext);
  if (!internals) throw new Error("LaserThreadScope must be used inside <LaserProvider>.");
  const parent = useLaserStable();
  const { store, client, dispatch, onError, openSession, buildActions, archive, refreshSessions, attach } = internals;

  // Latest props for callbacks that must keep their identity (the adapter is
  // built once; swapping it drops cached threads).
  const pathRef = useRef(path);
  pathRef.current = path;
  const filterRef = useRef(filter);
  filterRef.current = filter;
  const createInRef = useRef(createIn);
  createInRef.current = createIn;

  // Inside the scope "the current project" is the scope's own workspace: the
  // composer must not refuse to send for want of a project, and what it asks
  // about a directory (commands, files, the default model) is asked there.
  const workspace = useLaserState(useCallback((s: AppState) => createInRef.current(s)?.cwd, []));
  const scopedStore = useMemo(() => createScopedStateStore(store, path), [store, path]);
  const stable = useMemo<LaserStable>(
    () => ({ ...parent, ...(workspace !== undefined ? { currentProject: workspace } : {}), actions: buildActions(scopedStore.getSnapshot) }),
    [parent, buildActions, scopedStore, workspace],
  );
  const unavailableRef = useRef(unavailable);
  unavailableRef.current = unavailable;
  const onPathChangeRef = useRef(onPathChange);
  onPathChangeRef.current = onPathChange;
  const newSessionRef = useRef(parent.actions.newSession);
  newSessionRef.current = parent.actions.newSession;

  // On screen means attached, for as long as the scope holds the session.
  useEffect(() => (path ? attach(path) : undefined), [attach, path]);

  // A first message the host refused (no model Beam can call, no workspace
  // yet): said inside the scope, and the message handed back to the composer,
  // rather than lost to a corner toast. `lastText` is the composer's last
  // non-empty text, remembered because a send clears it before the host answers.
  const [refusal, setRefusal] = useState<string | undefined>(undefined);
  const lastText = useRef("");
  const dismissRefusal = useCallback(() => setRefusal(undefined), []);
  const refusalValue = useMemo<ThreadScopeRefusal>(() => ({ refusal, dismissRefusal }), [refusal, dismissRefusal]);
  const scopedOnError = useCallback((error: unknown) => {
    if (!isSurfaced(error)) onError(error);
  }, [onError]);

  const sessions = useCallback((): SessionSummary[] => {
    const state = store.getSnapshot();
    return state.sessions.filter((session) => filterRef.current(session, state));
  }, [store]);
  const views = useCallback((): Record<string, SessionView> => {
    const state = store.getSnapshot();
    const mine: Record<string, SessionView> = {};
    for (const [key, view] of Object.entries(state.open)) {
      if (view && filterRef.current({ cwd: view.state.cwd, agent: view.state.agent }, state)) mine[key] = view;
    }
    return mine;
  }, [store]);

  const [initializing, setInitializing] = useState(0);
  const adapter = useMemo<RemoteThreadListAdapter>(
    () =>
      createThreadListAdapter({
        sessions,
        views,
        archive,
        currentProject: () => createInRef.current(store.getSnapshot())?.cwd,
        createSession: async (cwd) => {
          try {
            const target = createInRef.current(store.getSnapshot());
            if (!target) throw new Error(unavailableRef.current);
            const created = await newSessionRef.current(cwd, {
              ...(target.agentName !== undefined ? { agentName: target.agentName } : {}),
              select: false,
            });
            // Adopt once assistant-ui has mapped the new thread onto this path
            // (its `initialize` settles in the same microtask turn). Changing
            // the controlled `threadId` synchronously here would make it fetch
            // the session a second time as a stranger.
            setTimeout(() => onPathChangeRef.current(created), 0);
            setRefusal(undefined);
            return created;
          } catch (error) {
            setRefusal(error instanceof Error ? error.message : String(error));
            throw markSurfaced(error);
          }
        },
        renameSession: async (target, name) => {
          await client.request("pi/session/rename", { path: target, name });
        },
        deleteSession: async (target) => {
          await client.request("pi/session/delete", { path: target });
        },
        loadSession: (target) =>
          openSession(target, { select: false }).catch((error: unknown) => {
            // The remembered session is gone: start fresh rather than sit on a
            // thread that cannot load.
            if (target === pathRef.current) onPathChangeRef.current(undefined);
            throw error;
          }),
        refreshSessions,
        beginInitialize: () => setInitializing((n) => n + 1),
        endInitialize: () => setInitializing((n) => Math.max(0, n - 1)),
      }),
    [archive, client, openSession, refreshSessions, sessions, store, views],
  );

  const snapshotStore = useMemo(
    () => createSnapshotStore<RuntimeSnapshot>({ store, client, dispatch, onError: scopedOnError, openSession: (target) => openSession(target, { select: false }) }),
    // eslint-disable-next-line react-hooks/exhaustive-deps -- created once; kept in sync below
    [],
  );
  useEffect(() => {
    snapshotStore.set({ store, client, dispatch, onError: scopedOnError, openSession: (target) => openSession(target, { select: false }) });
  }, [snapshotStore, store, client, dispatch, scopedOnError, openSession]);

  const runtimeHook = useCallback(
    // oxlint-disable-next-line react-hooks/rules-of-hooks -- invoked by useRemoteThreadListRuntime at a stable hook position
    () => useThreadRuntime(snapshotStore),
    [snapshotStore],
  );

  const onThreadIdChange = useCallback((threadId: string | undefined) => {
    if (threadId !== undefined && threadId !== pathRef.current) onPathChangeRef.current(threadId);
  }, []);

  // The list's signature over this scope's sessions only; the parent store
  // is read here, above the scoped provider.
  const archiveRevision = useSyncExternalStore(archive.subscribe, archive.getSnapshot, archive.getSnapshot);
  const signature = useLaserState(
    useCallback(() => threadListSignature(sessions(), views(), archive), [archive, archiveRevision, sessions, views]),
  );

  return (
    <LaserStateContext.Provider value={scopedStore}>
      <LaserStableContext.Provider value={stable}>
        <ThreadScopeRefusalContext.Provider value={refusalValue}>
          <AuiProvider extends={null} config={ISOLATED_ROOT}>
            <ScopedRuntime adapter={adapter} threadId={path} onThreadIdChange={onThreadIdChange} runtimeHook={runtimeHook} signature={signature} initializing={initializing}>
              <ScopeComposerMemory lastText={lastText} refusal={refusal} />
              {children}
            </ScopedRuntime>
          </AuiProvider>
        </ThreadScopeRefusalContext.Provider>
      </LaserStableContext.Provider>
    </LaserStateContext.Provider>
  );
}

/**
 * Remembers the composer's last non-empty text and, when the host refuses
 * the message that cleared it, puts it back so nothing the person typed is
 * lost. Lives under the scope's runtime so it reads the scope's composer.
 */
function ScopeComposerMemory({ lastText, refusal }: { lastText: { current: string }; refusal: string | undefined }): null {
  const aui = useAui();
  const text = useAuiState((s) => s.composer.text);
  useEffect(() => {
    if (text.trim()) lastText.current = text;
  }, [lastText, text]);
  useEffect(() => {
    if (refusal === undefined || !lastText.current) return;
    if (!aui.composer.getState().text.trim()) aui.composer.setText(lastText.current);
  }, [aui, lastText, refusal]);
  return null;
}

interface ScopedRuntimeProps {
  adapter: RemoteThreadListAdapter;
  threadId: string | undefined;
  onThreadIdChange: (threadId: string | undefined) => void;
  runtimeHook: () => AssistantRuntime;
  signature: string;
  initializing: number;
  children: ReactNode;
}

/** Rendered under the isolated aui root, so the hook builds a real runtime. */
function ScopedRuntime({ adapter, threadId, onThreadIdChange, runtimeHook, signature, initializing, children }: ScopedRuntimeProps): ReactNode {
  const runtime: AssistantRuntime = useRemoteThreadListRuntime({
    allowNesting: true,
    adapter,
    threadId,
    onThreadIdChange,
    runtimeHook,
  });
  // Same discipline as the provider: reload on a signature change, held back
  // while a freshly created thread is being adopted.
  useEffect(() => {
    if (initializing > 0) return;
    void runtime.threads.reload().catch(() => {});
  }, [runtime, signature, initializing]);
  return <AssistantRuntimeProvider runtime={runtime}>{children}</AssistantRuntimeProvider>;
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
  const { actions } = useLaserStable();
  const view = useLaserView();
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
  const view = useLaserView();
  const connection = useLaserState((s) => s.connection);
  const workers = useLaserState((s) => s.workers);
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
  const view = useLaserView();
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
  const { trustRequests, actions } = useLaserStable();
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
  const { actions } = useLaserStable();
  const toasts = useLaserState((s) => s.toasts);
  return useMemo(() => ({ toasts, dismiss: actions.dismissToast }), [actions.dismissToast, toasts]);
}
