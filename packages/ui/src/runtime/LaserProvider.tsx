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
  useAuiState,
  useExternalStoreRuntime,
  useRemoteThreadListRuntime,
} from "@assistant-ui/react";
import type { AssistantRuntime, CreateAttachment, RemoteThreadListAdapter, ThreadComposerRuntime, ThreadMessageLike } from "@assistant-ui/react";
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
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  useSyncExternalStore,
  type ReactNode,
} from "react";
import { createAgentsActions, type AgentsActions } from "../agents/actions.js";
import { takeWorktreeDisposition } from "../agents/worktree.js";
import { createTasksActions, type TasksActions } from "../fleet/actions.js";
import { HostClient } from "../client.js";
import { initialState, reduce, type Action, type AppState, type SessionView } from "../store.js";
import { createThreadAdapter, sendToSession, type SendBehavior } from "./adapter.js";
import { useDiscardFirstTurnOnLeave } from "./first-turn.js";
import { createSessionLauncher, type NewSessionOptions } from "./new-session.js";
import {
  codeProjectForSession,
  creationTargetForDestination,
  destinationSessionForTab,
  initialMainDestination,
  isSessionInCodeProject,
  type MainDestination,
  type MainTab,
} from "./main-destination.js";
import {
  rememberSessionForTab,
  rememberSessionsTab,
  rememberedSessionForTab,
  rememberedSessionsTab,
  sessionKindTab,
} from "./session-tab-memory.js";
import { useThemeSync } from "./prefs.js";
import { projectSessionView, shareProjectedMessages, splitDialogs } from "./projection.js";
import {
  createArchiveStore,
  createThreadListAdapter,
  mergeSessions,
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

/**
 * How a session-tree move treats a running turn. The engine will not move the
 * leaf mid-turn; `stopFirst` has the worker stop the turn and then move, as
 * one request. Without it a move during a turn is refused, as it always was.
 */
export interface MoveOptions {
  stopFirst?: boolean;
}

export interface LaserActions {
  /** Navigate the main window to this session, aligning its tab and Code memory. */
  openSession(path: string): Promise<void>;
  /** Navigate the main window to one tab. */
  goTab(tab: MainTab): Promise<void>;
  /** Navigate to a Code project and its remembered session or safe landing. */
  goProject(cwd: string): Promise<void>;
  /** Retry the current unavailable destination without changing its identity. */
  retryDestination(): Promise<void>;
  /** Leave the main session on its safe tab landing. */
  leaveSession(): void;
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
  /**
   * Fork before `entryId` into a new session and select it. `stopFirst` is
   * for a fork asked for while a turn runs: the worker stops that turn first
   * (recorded on the branch being left, exactly as the Stop button would)
   * and forks only then, in one request — so a fork that fails leaves the
   * session stopped and untouched, never half-moved (M13-T46).
   */
  fork(entryId: string, options?: MoveOptions): Promise<void>;
  /**
   * Move this session's leaf to `entryId`, in this file, and re-hydrate.
   * Answers with the engine's own text for that entry when it is a prompt —
   * navigating onto a user message puts the session *before* it, which is what
   * makes editing and re-running land beside the old version instead of after
   * it. `false` when nothing moved: a feature vetoed it, a turn is running and
   * `stopFirst` was not asked for, or the entry is gone. Whatever the reason,
   * the person has already been told.
   */
  navigate(entryId: string, options?: MoveOptions): Promise<{ editorText?: string } | false>;
  /** `navigate`, plus the engine's text into the composer. The menu's "Jump to this entry". */
  jump(entryId: string, options?: MoveOptions): Promise<void>;
  refreshSessions(): Promise<void>;
  refreshEntries(): Promise<void>;
  /** Refresh cross-app allowance for the session's account provider. */
  refreshAccountUsage(): Promise<void>;
  goal(action: GoalAction): Promise<void>;
  /**
   * Empty both queues: the pending tray and whatever the engine already holds.
   * Resolves with the text of everything dropped, so the composer can offer it
   * back rather than lose it.
   */
  clearQueue(): Promise<string>;
  // Per-message tray operations (steer, edit, drop) go through the thread
  // adapter's queue, which is the one route to the worker — see adapter.ts.
  /**
   * `pi/project/add` — server-side, so every client and the CLI see it.
   * Resolves with the host's record, or `undefined` when the add failed (the
   * failure is already on screen as a toast).
   */
  addProject(cwd: string): Promise<ProjectInfo | undefined>;
  /** Persist project priority shared by the rail and grouped sessions list. */
  reorderProjects(cwds: string[]): Promise<void>;
  removeProject(cwd: string): Promise<void>;
  /**
   * `pi/session/move` (M13-T58): a Chat session becomes `cwd`'s, with its
   * history and name; resolves with the path it lives at now. The old path
   * is let go of here — its view and its subscription — because nothing
   * serves it any more. Throws with the host's reason rather than toasting:
   * the move dialog shows it where the person is looking.
   */
  moveSession(path: string, cwd: string): Promise<string>;
  refreshProjects(): Promise<void>;
  /** Answer a `pi/project/trust_request`. The held-back worker starts (or does not). */
  answerTrust(cwd: string, trusted: boolean, remember: boolean): Promise<void>;
  /** Start a crashed or retired worker again (`pi/worker/restart`). */
  restartWorker(cwd: string): Promise<void>;
  /** Tell the host this session has been read up to its latest update. */
  markSeen(path: string, seq: number, force?: boolean): void;
  /** The composer has taken the text a jump or fork handed back for `path`. */
  takeEditorText(path: string): void;
  dismissToast(id: number): void;
  toast(level: "info" | "warning" | "error", text: string): void;
  /** Agent definitions, runs, Beam and Namer (`agents/*`). See agents/actions.ts for failure styles. */
  agents: AgentsActions;
  /** Background commands the agent left running (`tasks/*`). See fleet/actions.ts. */
  tasks: TasksActions;
}

export interface LaserContextValue {
  state: AppState;
  dispatch: (action: Action) => void;
  client: HostClient;
  /** The currently open session view, if any. */
  view: SessionView | undefined;
  /** Destination for this runtime context; scopes replace the main value. */
  destination: MainDestination;
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
  /** Main adapters are fenced by the canonical destination; scoped adapters are not. */
  main?: boolean | undefined;
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

type MainComposerState = ReturnType<ThreadComposerRuntime["getState"]>;
interface MainLandingDraft {
  text: string;
  runConfig: MainComposerState["runConfig"];
  quote: MainComposerState["quote"];
  attachments: Array<File | CreateAttachment>;
}

const codeLandingKey = (destination: MainDestination): string | undefined =>
  destination.tab === "code" && destination.phase === "ready" && destination.path === undefined
    ? `code:${destination.codeProject ?? ""}`
    : undefined;

const captureLandingDraft = (composer: ThreadComposerRuntime): MainLandingDraft => {
  const state = composer.getState();
  return {
    text: state.text,
    runConfig: state.runConfig,
    quote: state.quote,
    attachments: state.attachments.flatMap<File | CreateAttachment>((attachment) => {
      if (attachment.file) return [attachment.file];
      if (!attachment.content) return [];
      return [{
        id: attachment.id,
        type: attachment.type,
        name: attachment.name,
        ...(attachment.contentType !== undefined ? { contentType: attachment.contentType } : {}),
        content: attachment.content,
      }];
    }),
  };
};

export function LaserProvider({ children, url }: LaserProviderProps): ReactNode {
  const store = useMemo(() => {
    const destination: MainDestination = {
      ...initialMainDestination,
      tab: rememberedSessionsTab(),
      codeProject: readString(PROJECT_STORAGE_KEY),
    };
    return createStateStore({ ...initialState, destination });
  }, []);
  const dispatch = store.dispatch;
  // Always the committed state, even inside a socket callback that runs before
  // React re-renders.
  const readState = store.getSnapshot;
  const state = useSyncExternalStore(store.subscribe, store.getSnapshot, store.getSnapshot);

  const currentProject = state.destination.codeProject;
  const [startupRestoring, setStartupRestoring] = useState(true);
  const [projectList, setProjectList] = useState<ProjectInfo[]>([]);
  const [trustRequests, setTrustRequests] = useState<TrustRequest[]>([]);
  const intentRef = useRef(state.destination.intent);
  if (state.destination.intent > intentRef.current) intentRef.current = state.destination.intent;
  // assistant-ui owns one local (pathless) thread. Key its composer state by
  // Code project so switching between two landings cannot carry a draft,
  // attachment, quote, or first-turn choice into the wrong directory.
  const mainComposerRef = useRef<ThreadComposerRuntime | undefined>(undefined);
  const landingDraftsRef = useRef(new Map<string, MainLandingDraft>());
  const saveMainLandingDraft = useCallback((destination: MainDestination): void => {
    const key = codeLandingKey(destination);
    const composer = mainComposerRef.current;
    if (!key || !composer) return;
    landingDraftsRef.current.set(key, captureLandingDraft(composer));
    void composer.reset();
  }, []);

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
   * Sessions whose leaf is being moved right now (`navigate`, `fork`). A
   * move that stops a turn first settles that turn *inside* the request, and
   * the transcript re-reads the tree whenever a turn settles: that re-read
   * would race the move — and after a fork the old path is not served at all.
   * The move re-hydrates when it lands, so the re-read has nothing to add.
   */
  const moving = useRef(new Set<string>());

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
        const { state: session, replayFrom, seq: loadedSeq } = await client.request("session/load", {
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
        }
        if (!hydrated || needsResync) {
          const seqBefore = readState().open[path]?.lastSeq ?? 0;
          const { entries, leafId } = await client.request("pi/session/entries", { path });
          // The snapshot is the transcript as the worker held it at `loadedSeq`,
          // so that — not 0 — is the watermark this view now carries. Leaving it
          // at 0 makes the next open ask for `fromSeq: 0` and receive the whole
          // replay buffer on top of the transcript it already shows. `expectSeq`
          // still owns the race: an update that landed while the snapshot was in
          // flight keeps the live blocks, and its higher seq wins the stamp.
          dispatch({ type: "hydrate", path, entries, leafId, expectSeq: seqBefore, seq: loadedSeq });
        }
        // Monotonic: the resume `session/load` after a dropped socket asks from
        // here, so an unstamped view would replay its whole buffer there too.
        client.track(path, readState().open[path]?.lastSeq ?? loadedSeq);
        const { goal } = await client.request("session/goal/get", { path });
        dispatch({ type: "goal", path, goal });
        // The pending tray, once, now that the view exists. A numbered update
        // can overtake this request, including the empty update that acknowledges
        // delivery. Capture the array itself as a watermark so a delayed list
        // cannot resurrect an older row; unrelated view updates preserve it.
        const expectPending = readState().open[path]?.pending;
        const { messages } = await client.request("session/pending/list", { path });
        if (expectPending) dispatch({ type: "pending", path, messages, expectPending });
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

  const launchSession = useMemo(() => createSessionLauncher({
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

  // --- one main-window destination ---------------------------------------

  const beginDestination = useCallback((tab: MainTab, codeProject: string | undefined, targetPath?: string): number => {
    saveMainLandingDraft(readState().destination);
    const intent = ++intentRef.current;
    rememberSessionsTab(tab);
    dispatch({ type: "destination", destination: { tab, codeProject, path: undefined, targetPath, phase: "resolving", intent } });
    return intent;
  }, [readState, saveMainLandingDraft]);

  const commitDestination = useCallback((destination: MainDestination): boolean => {
    if (intentRef.current !== destination.intent) return false;
    dispatch({ type: "destination", destination });
    rememberSessionsTab(destination.tab);
    if (destination.tab === "code" && destination.codeProject !== undefined) {
      writeString(PROJECT_STORAGE_KEY, destination.codeProject);
    }
    if (destination.path !== undefined) {
      rememberSessionForTab(destination.tab, destination.path);
      if (destination.tab === "code" && destination.codeProject !== undefined) {
        const snapshot = readState();
        const sessions = mergeSessions(snapshot.sessions, snapshot.open);
        const selected = sessions.find((session) => session.path === destination.path);
        if (selected && isSessionInCodeProject(selected, sessions, snapshot.agents.runs, destination.codeProject)) {
          const remembered = readStringMap(SESSION_STORAGE_KEY);
          if (remembered[destination.codeProject] !== destination.path) {
            writeString(SESSION_STORAGE_KEY, JSON.stringify({ ...remembered, [destination.codeProject]: destination.path }));
          }
        }
      }
    }
    return true;
  }, [readState]);

  const failDestination = useCallback((intent: number, message: string): void => {
    const current = readState().destination;
    if (intentRef.current !== intent || current.intent !== intent) return;
    dispatch({
      type: "destination",
      destination: { ...current, path: undefined, phase: "unavailable", unavailable: message },
    });
  }, [readState]);

  const resolveSessionIntent = useCallback(async (path: string, intent: number): Promise<boolean> => {
    const resolving = readState().destination;
    if (intentRef.current === intent && resolving.intent === intent && resolving.targetPath !== path) {
      dispatch({ type: "destination", destination: { ...resolving, targetPath: path } });
    }
    try {
      await openSession(path, { select: false });
    } catch (error) {
      // A superseded load may finish (or fail) into cache, but it does not own
      // the visible destination or its errors anymore.
      if (intentRef.current !== intent) return false;
      failDestination(intent, error instanceof Error ? error.message : String(error));
      throw error;
    }
    if (intentRef.current !== intent) return false;
    const next = readState();
    const merged = mergeSessions(next.sessions, next.open);
    const session = merged.find((item) => item.path === path);
    if (!session) {
      const message = "That conversation could not be loaded. Retry it or start a new one.";
      failDestination(intent, message);
      throw new Error(message);
    }
    const tab = sessionKindTab(session, next.agents.snapshot?.workspaces ?? {});
    const codeProject = tab === "code"
      ? codeProjectForSession(session, merged, next.agents.runs, next.destination.codeProject)
      : next.destination.codeProject;
    return commitDestination({ tab, codeProject, path, targetPath: undefined, phase: "ready", intent });
  }, [commitDestination, dispatch, failDestination, openSession, readState]);

  const resolveTabIntent = useCallback(async (tab: MainTab, intent: number): Promise<void> => {
    if (intentRef.current !== intent) return;
    const current = readState();
    const workspaces = current.agents.snapshot?.workspaces;
    const remembered = rememberedSessionForTab(tab)
      ?? (tab === "code" && current.destination.codeProject ? readStringMap(SESSION_STORAGE_KEY)[current.destination.codeProject] : undefined);
    const target = destinationSessionForTab(tab, remembered, {
      sessions: current.sessions,
      views: current.open,
      workspaces: workspaces ?? {},
      archived: (path) => archive.has(path),
    });
    if (target) {
      await resolveSessionIntent(target.path, intent);
      return;
    }
    if (tab === "code") {
      commitDestination({ ...current.destination, tab, path: undefined, targetPath: undefined, phase: "ready", intent });
      return;
    }
    const creation = creationTargetForDestination(current.destination, workspaces?.chat);
    // The agents snapshot is still arriving. Stay visibly Chat and inert; the
    // effect below resumes this same intent rather than guessing a project.
    if (!creation) return;
    try {
      const path = await launchSession(creation.cwd, { agentName: "chat", select: false });
      if (intentRef.current !== intent) return;
      commitDestination({ ...readState().destination, tab: "chat", path, targetPath: undefined, phase: "ready", intent });
    } catch (error) {
      if (intentRef.current !== intent) return;
      failDestination(intent, error instanceof Error ? error.message : String(error));
      throw error;
    }
  }, [archive, commitDestination, failDestination, launchSession, readState, resolveSessionIntent]);

  const goTab = useCallback(async (tab: MainTab): Promise<void> => {
    const current = readState().destination;
    if (current.tab === tab && current.phase === "ready" && current.path !== undefined) return;
    const intent = beginDestination(tab, current.codeProject);
    await resolveTabIntent(tab, intent);
  }, [beginDestination, readState, resolveTabIntent]);

  const goProject = useCallback(async (cwd: string): Promise<void> => {
    const intent = beginDestination("code", cwd);
    writeString(PROJECT_STORAGE_KEY, cwd);
    const current = readState();
    const remembered = readStringMap(SESSION_STORAGE_KEY)[cwd];
    const merged = mergeSessions(current.sessions, current.open);
    const candidate = remembered
      ? merged.find((session) => session.path === remembered
          && sessionKindTab(session, current.agents.snapshot?.workspaces ?? {}) === "code"
          && isSessionInCodeProject(session, merged, current.agents.runs, cwd))
      : undefined;
    if (candidate) await resolveSessionIntent(candidate.path, intent);
    else commitDestination({ tab: "code", codeProject: cwd, path: undefined, targetPath: undefined, phase: "ready", intent });
  }, [beginDestination, commitDestination, readState, resolveSessionIntent]);

  const navigateSession = useCallback(async (path: string): Promise<void> => {
    const current = readState();
    const merged = mergeSessions(current.sessions, current.open);
    const known = merged.find((session) => session.path === path);
    const tab = known ? sessionKindTab(known, current.agents.snapshot?.workspaces ?? {}) : current.destination.tab;
    const codeProject = known && tab === "code"
      ? codeProjectForSession(known, merged, current.agents.runs, current.destination.codeProject)
      : current.destination.codeProject;
    const intent = beginDestination(tab, codeProject, path);
    await resolveSessionIntent(path, intent);
  }, [beginDestination, readState, resolveSessionIntent]);

  const navigateNewSession = useCallback(async (cwd: string, options: NewSessionOptions = {}): Promise<string> => {
    if (options.select === false) return launchSession(cwd, options);
    const agentName = options.agentName;
    const tab: MainTab = agentName === "chat" ? "chat" : "code";
    const previous = readState().destination;
    const codeProject = tab === "code" && agentName !== "beam" ? cwd : previous.codeProject;
    const intent = beginDestination(tab, codeProject);
    try {
      const path = await launchSession(cwd, { ...options, select: false });
      if (intentRef.current === intent) commitDestination({ tab, codeProject, path, targetPath: undefined, phase: "ready", intent });
      return path;
    } catch (error) {
      if (intentRef.current === intent) failDestination(intent, error instanceof Error ? error.message : String(error));
      throw error;
    }
  }, [beginDestination, commitDestination, failDestination, launchSession, readState]);

  const retryDestination = useCallback(async (): Promise<void> => {
    const current = readState().destination;
    const intent = beginDestination(current.tab, current.codeProject, current.targetPath);
    if (current.targetPath) await resolveSessionIntent(current.targetPath, intent);
    else await resolveTabIntent(current.tab, intent);
  }, [beginDestination, readState, resolveTabIntent]);

  const leaveSession = useCallback((): void => {
    const current = readState().destination;
    const intent = beginDestination(current.tab, current.codeProject);
    commitDestination({ ...readState().destination, path: undefined, targetPath: undefined, phase: "ready", intent });
  }, [beginDestination, commitDestination, readState]);

  // Resume a Chat intent that started before the authoritative workspace
  // snapshot arrived. The intent is not replaced, so a later click still wins.
  useEffect(() => {
    const destination = state.destination;
    if (state.connection !== "open" || destination.tab !== "chat" || destination.phase !== "resolving" || destination.targetPath !== undefined) return;
    if (!state.agents.snapshot?.workspaces.chat) return;
    void resolveTabIntent("chat", destination.intent).catch(() => {});
  }, [resolveTabIntent, state.agents.snapshot?.workspaces.chat, state.connection, state.destination]);

  // `requireCurrent`, `send`, `answerDialog` and `fork` live inside
  // `buildActions` below: they read "the current session" through the state
  // reader they are built with, so a `LaserThreadScope` can rebind the same
  // actions to its own session.

  // --- agents -------------------------------------------------------------

  const agentsActions = useMemo(() => createAgentsActions({ client, dispatch, guard }), [client, guard]);
  const tasksActions = useMemo(() => createTasksActions({ client, dispatch, guard }), [client, guard]);

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
      const snapshot = readScoped();
      const path = snapshot.current;
      if (!path) throw new Error("No session is open.");
      if (readScoped === readState) {
        const destination = snapshot.destination;
        if (destination.phase !== "ready" || destination.path !== path) {
          throw new Error("That conversation is still changing. Your action was not sent.");
        }
      }
      return path;
    };

    const send = async (content: ContentBlock[], behavior: SendBehavior) => {
      const path = requireCurrent();
      // One implementation of the optimistic block and its rollback, shared
      // with the thread adapter.
      await sendToSession(client, path, content, behavior, dispatch);
    };

    const answerDialog = async (response: UiDialogResponse) => {
      const path = requireCurrent();
      const dialog = readScoped().open[path]?.dialogs.find((candidate) => candidate.id === response.id);
      if (!dialog) throw new Error("That question no longer belongs to this conversation.");
      dispatch({ type: "dialogAnswered", id: response.id, path });
      try {
        await client.request("pi/ui/response", response);
      } catch (error) {
        // The extension is still blocked on `ask()`: put the card back rather
        // than strand it with no way to answer.
        dispatch({ type: "notification", method: "pi/ui/request", params: { path, ...dialog } });
        throw error;
      }
    };

    const fork = async (entryId: string, options?: MoveOptions) => {
      const path = requireCurrent();
      moving.current.add(path);
      let session: SessionState;
      let editorText: string | undefined;
      let entries: unknown[];
      let leafId: string | null | undefined;
      try {
        // A stop asked for here reaches this store as the original session's
        // own updates (the aborted reply, then settled) before the reply
        // below: its transcript records the stop before it is left behind.
        ({ state: session, editorText } = await client.request("pi/session/fork", { path, entryId, ...(options?.stopFirst ? { stopFirst: true } : {}) }));
        client.untrack(path);
        client.track(session.path, 0);
        // Read the fork's transcript before putting it on screen. Switching
        // first and hydrating after an await shows an empty transcript for a
        // frame and rebuilds the thread runtime twice; both dispatches land in
        // one task instead.
        ({ entries, leafId } = await client.request("pi/session/entries", { path: session.path }));
      } finally {
        moving.current.delete(path);
      }
      dispatch({ type: "forked", from: path, state: session });
      dispatch({ type: "hydrate", path: session.path, entries, leafId });
      if (editorText) {
        dispatch({
          type: "notification",
          method: "pi/ui/event",
          params: { path: session.path, method: "setEditorText", text: editorText },
        });
      }
      void refreshSessions();
    };

    /**
     * Move the leaf inside this session file (Pi's `navigateTree`). The engine
     * refuses while a turn is streaming and an extension may veto it; both are
     * answered here rather than swallowed, so no control is a silent no-op.
     */
    const navigate = async (entryId: string, options?: MoveOptions): Promise<{ editorText?: string } | false> => {
      const path = requireCurrent();
      moving.current.add(path);
      try {
        // The worker owns stop-then-move: a failure after the stop leaves the
        // session stopped and unmoved, and the error reaches `guard` as usual.
        const { editorText, cancelled } = await client.request("pi/session/navigate", { path, entryId, ...(options?.stopFirst ? { stopFirst: true } : {}) });
        if (cancelled) {
          dispatch({ type: "toast", level: "warning", text: "A feature stopped that change." });
          return false;
        }
        const { entries, leafId } = await client.request("pi/session/entries", { path });
        dispatch({ type: "hydrate", path, entries, leafId });
        return editorText !== undefined ? { editorText } : {};
      } finally {
        moving.current.delete(path);
      }
    };

    return {
      openSession: (path) => guard(() => readScoped === readState ? navigateSession(path) : openSession(path, { select: false })).then(() => undefined),
      goTab: (tab) => guard(() => goTab(tab)).then(() => undefined),
      goProject: (cwd) => guard(() => goProject(cwd)).then(() => undefined),
      retryDestination: () => guard(() => retryDestination()).then(() => undefined),
      leaveSession: () => leaveSession(),
      newSession: (cwd, options) => readScoped === readState ? navigateNewSession(cwd, options) : launchSession(cwd, { ...options, select: false }),
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
      fork: (entryId, options) => guard(() => fork(entryId, options)).then(() => undefined),
      navigate: (entryId, options) => guard(() => navigate(entryId, options)).then((result) => result ?? false),
      jump: (entryId, options) =>
        guard(async () => {
          const path = requireCurrent();
          const moved = await navigate(entryId, options);
          // Navigating onto a prompt leaves the session before it and hands
          // its text back: that text belongs in the composer, not nowhere.
          if (moved && moved.editorText !== undefined) {
            dispatch({
              type: "notification",
              method: "pi/ui/event",
              params: { path, method: "setEditorText", text: moved.editorText },
            });
          }
        }).then(() => undefined),
      refreshSessions,
      refreshEntries: () =>
        guard(async () => {
          const path = requireCurrent();
          // A move in flight re-hydrates this session itself; a read now
          // could land after it with the leaf as it was.
          if (moving.current.has(path)) return;
          const { entries, leafId } = await client.request("pi/session/entries", { path });
          dispatch({ type: "entries", path, entries, leafId });
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
          const path = requireCurrent();
          // Both, always: the person asked for an empty queue, and a tray left
          // behind by a control called "Clear queue" is the control lying.
          const [{ messages }, { steering, followUp }] = await Promise.all([
            client.request("session/pending/clear", { path }),
            client.request("pi/session/clear_queue", { path }),
          ]);
          return [...steering, ...followUp, ...messages.map((message) => message.text)].filter(Boolean).join("\n\n");
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
      moveSession: async (path, cwd) => {
        const { path: moved } = await client.request("pi/session/move", { path, cwd });
        // The host has closed and moved it: the old path has no worker and no
        // file. Drop this side's view and stop following it before the lists
        // are re-read, so nothing here reopens a path that is gone.
        client.untrack(path);
        dispatch({ type: "closeView", path });
        await refreshProjects();
        await refreshSessions();
        return moved;
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
            const destination = readState().destination;
            if (destination.codeProject === cwd) {
              saveMainLandingDraft(destination);
              dispatch({
                type: "destination",
                destination: { ...destination, codeProject: undefined, intent: ++intentRef.current },
              });
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
      takeEditorText: (path) => dispatch({ type: "editorTextTaken", path }),
      agents: agentsActions,
      tasks: tasksActions,
    };
  }, [
    agentsActions,
    tasksActions,
    applyState,
    archive,
    client,
    guard,
    goProject,
    goTab,
    launchSession,
    leaveSession,
    markSeen,
    navigateNewSession,
    navigateSession,
    openSession,
    refreshProjects,
    retryDestination,
    refreshSessions,
    saveMainLandingDraft,
  ]);

  const actions = useMemo<LaserActions>(() => buildActions(readState), [buildActions, readState]);

  const actionsRef = useRef<LaserActions>(actions);
  actionsRef.current = actions;

  const setCurrentProject = useCallback((cwd: string | undefined) => {
    const current = readState().destination;
    // Compatibility for code that only remembers a project: on a Code landing
    // this is also a newer, completed landing intent, so an older startup
    // restoration cannot leave the page inert in its resolving phase.
    const codeLanding = current.tab === "code" && current.path === undefined;
    if (codeLanding && current.codeProject !== cwd) saveMainLandingDraft(current);
    const destination = {
      ...current,
      codeProject: cwd,
      ...(codeLanding ? { targetPath: undefined, phase: "ready" as const, unavailable: undefined } : {}),
      intent: ++intentRef.current,
    };
    dispatch({ type: "destination", destination });
    writeString(PROJECT_STORAGE_KEY, cwd);
  }, [readState, saveMainLandingDraft]);

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
    if (currentProject !== undefined || !projects[0]) return;
    const destination = readState().destination;
    dispatch({ type: "destination", destination: { ...destination, codeProject: projects[0] } });
    writeString(PROJECT_STORAGE_KEY, projects[0]);
  }, [currentProject, projects, readState]);

  /**
   * Remember the session being read, per project.
   *
   * Written from the committed state rather than from the click, so it also
   * follows a session opened by a deep link, by the command palette or by the
   * sessions panel — there is one place a session becomes current, and this is
   * downstream of it.
   */
  useEffect(() => {
    const destination = state.destination;
    if (destination.phase !== "ready" || !destination.path) return;
    rememberSessionForTab(destination.tab, destination.path);
    if (destination.tab !== "code" || !destination.codeProject) return;
    const sessions = mergeSessions(state.sessions, state.open);
    const selected = sessions.find((session) => session.path === destination.path);
    if (!selected || !isSessionInCodeProject(selected, sessions, state.agents.runs, destination.codeProject)) return;
    const remembered = readStringMap(SESSION_STORAGE_KEY);
    if (remembered[destination.codeProject] !== destination.path) {
      writeString(SESSION_STORAGE_KEY, JSON.stringify({ ...remembered, [destination.codeProject]: destination.path }));
    }
  }, [state.destination, state.sessions, state.open, state.agents.runs]);

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
    if (restoredSession.current || state.connection !== "open" || !state.sessionsLoaded) return;
    if (/^#\/session\//.test(globalThis.location?.hash ?? "")) return;
    restoredSession.current = true;
    // A click, project pick, or explicit open that happened while the catalog
    // was connecting is newer than startup memory. Never let restoration take
    // the destination back after the person has already chosen one.
    if (readState().destination.intent > 0) return;
    void goTab(readState().destination.tab).catch(() => {});
  }, [goTab, readState, state.connection, state.sessionsLoaded]);

  useEffect(() => {
    if (state.connection !== "open") return;
    if (state.destination.phase === "ready" || state.destination.phase === "unavailable") setStartupRestoring(false);
  }, [state.connection, state.destination.phase]);

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
    void navigateSession(path)
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
  }, [state.connection, navigateSession, onError]);

  // --- runtime ------------------------------------------------------------

  const snapshotStore = useMemo(
    () => createSnapshotStore<RuntimeSnapshot>({ store, client, dispatch, onError, openSession: (path) => openSession(path, { select: false }), main: true }),
    // eslint-disable-next-line react-hooks/exhaustive-deps -- created once; kept in sync below
    [],
  );

  useEffect(() => {
    snapshotStore.set({ store, client, dispatch, onError, openSession: (path) => openSession(path, { select: false }), main: true });
  }, [snapshotStore, store, client, dispatch, onError, openSession]);

  /** Number of `initialize()` calls in flight; gates the thread-list reload and the controlled selection. */
  const [initializing, setInitializing] = useState(0);
  const initializingRef = useRef(0);
  const beginInitialize = useCallback(() => {
    initializingRef.current += 1;
    setInitializing((n) => n + 1);
  }, []);
  const endInitialize = useCallback(() => {
    initializingRef.current = Math.max(0, initializingRef.current - 1);
    setInitializing((n) => Math.max(0, n - 1));
  }, []);

  const threadListAdapter = useMemo(
    () =>
      createThreadListAdapter({
        sessions: () => readState().sessions,
        views: () => readState().open,
        archive,
        creationTarget: () => creationTargetForDestination(
          readState().destination,
          readState().agents.snapshot?.workspaces.chat,
        ),
        // Quietly: the runtime is adopting this path into its "new" thread and
        // selects it through `onThreadIdChange` once that is done. Selecting
        // here — in particular a listed, unstarted session the launcher reuses
        // (one the CLI created, M13-T53) — moved the runtime onto a row it was
        // about to drop, and every render threw.
        createSession: async (target) => {
          const path = await launchSession(target.cwd, {
            ...(target.agentName !== undefined ? { agentName: target.agentName } : {}),
            select: false,
          });
          // assistant-ui adopts the returned path on the settling microtask.
          // Commit only afterward and only for the intent that initialized it.
          setTimeout(() => {
            const current = readState().destination;
            if (target.intent === current.intent && current.path === undefined && current.phase !== "unavailable") {
              commitDestination({ ...current, path, phase: "ready" });
            }
          }, 0);
          return path;
        },
        renameSession: async (path, name) => {
          await client.request("pi/session/rename", { path, name });
        },
        deleteSession: async (path) => {
          // The delete confirmation left its answer about the child's worktree
          // here; absent, the host keeps it (M13-T42).
          await client.request("pi/session/delete", { path, worktree: takeWorktreeDisposition(path) });
        },
        loadSession: (path) => openSession(path, { select: false }),
        refreshSessions,
        beginInitialize,
        endInitialize,
      }),
    [archive, beginInitialize, client, commitDestination, endInitialize, launchSession, openSession, refreshSessions],
  );

  const onThreadIdChange = useCallback((threadId: string | undefined) => {
    const destination = readState().destination;
    if (!threadId || initializingRef.current > 0 || destination.phase !== "ready" || threadId === destination.path) return;
    void navigateSession(threadId).catch(() => {});
  }, [navigateSession, readState]);

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
    // Held while a thread is being initialized: a selection that moves the
    // runtime onto a row it is about to fold into the new thread leaves the
    // main thread pointing at nothing (M13-T53). It catches up once the
    // bracket closes, by which time the path resolves to the adopted thread.
    threadId: useHeldWhile(initializing > 0, state.destination.path),
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
      destination: state.destination,
      currentProject,
      startupRestoring,
      setCurrentProject,
      projects,
      projectInfo,
      trustRequests,
      archive,
      actions,
    }),
    [actions, archive, client, currentProject, dispatch, projectInfo, projects, setCurrentProject, startupRestoring, state.destination, trustRequests],
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
            <MainLandingComposerMemory
              destination={state.destination}
              composerRef={mainComposerRef}
              draftsRef={landingDraftsRef}
            />
            {children}
          </AssistantRuntimeProvider>
        </LaserInternalsContext.Provider>
      </LaserStableContext.Provider>
    </LaserStateContext.Provider>
  );
}

function MainLandingComposerMemory({
  destination,
  composerRef,
  draftsRef,
}: {
  destination: MainDestination;
  composerRef: { current: ThreadComposerRuntime | undefined };
  draftsRef: { current: Map<string, MainLandingDraft> };
}): null {
  const aui = useAui();
  const key = codeLandingKey(destination);
  useLayoutEffect(() => {
    const composer = aui.composer as unknown as ThreadComposerRuntime;
    composerRef.current = composer;
    if (!key) return () => {
      if (composerRef.current === composer) composerRef.current = undefined;
    };
    const draft = draftsRef.current.get(key);
    let cancelled = false;
    void (async () => {
      await composer.reset();
      if (cancelled || composerRef.current !== composer || !draft) return;
      composer.setText(draft.text);
      composer.setRunConfig(draft.runConfig);
      composer.setQuote(draft.quote);
      for (const attachment of draft.attachments) {
        if (cancelled || composerRef.current !== composer) return;
        await composer.addAttachment(attachment);
      }
    })();
    return () => {
      cancelled = true;
      if (composerRef.current === composer) composerRef.current = undefined;
    };
  }, [aui, composerRef, draftsRef, key]);
  return null;
}

/**
 * `value`, except while `hold` is true, when it is the value from just before
 * the hold began. Decided during render (the "adjust state while rendering"
 * pattern) so a held value never reaches a consumer for even one commit.
 */
function useHeldWhile<T>(hold: boolean, value: T): T {
  const [held, setHeld] = useState(value);
  if (!hold && held !== value) setHeld(value);
  return hold ? held : value;
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
  const readDestination = useCallback(() => stateStore.getSnapshot().destination, [stateStore]);
  const destination = useSyncExternalStore(stateStore.subscribe, readDestination, readDestination);

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

  const initializedIntent = useRef<number | undefined>(undefined);
  const resolvePath = useCallback(async () => {
    const before = stateStore.getSnapshot().destination;
    const { remoteId, externalId } = await aui.threadListItem.initialize();
    if (snapshot.main && stateStore.getSnapshot().destination.intent !== before.intent) {
      throw new Error("The destination changed before this conversation was ready. Your message was not sent.");
    }
    initializedIntent.current = before.intent;
    return externalId ?? remoteId;
  }, [aui, snapshot.main, stateStore]);

  const assertCanAct = useCallback((resolvedPath?: string) => {
    if (!snapshot.main) return;
    const destination = stateStore.getSnapshot().destination;
    const initializingThisLanding = path === undefined && resolvedPath !== undefined
      && (destination.path === resolvedPath
        || (destination.path === undefined && initializedIntent.current === destination.intent));
    // assistant-ui can adopt an already-listed, unstarted row into the local
    // landing thread before the controlled destination callback commits it.
    // Permit only that exact eligible row; a prior non-empty conversation can
    // never pass this bridge during a tab switch.
    const physical = path ? stateStore.getSnapshot().sessions.find((session) => session.path === path) : undefined;
    const adoptingListedLanding = destination.path === undefined && physical?.messageCount === 0
      && sessionKindTab(physical, stateStore.getSnapshot().agents.snapshot?.workspaces ?? {}) === destination.tab
      && (destination.tab === "chat"
        || codeProjectForSession(
          physical,
          stateStore.getSnapshot().sessions,
          stateStore.getSnapshot().agents.runs,
          destination.codeProject,
        ) === destination.codeProject);
    if (!isMain || destination.phase !== "ready" || (!initializingThisLanding && !adoptingListedLanding && destination.path !== path)) {
      throw new Error("That conversation is still changing. Your action was not sent.");
    }
  }, [isMain, path, snapshot.main, stateStore]);

  // This thread's own composer, for the adapter to hand an unsent message back
  // to (M13-T89 U1). Read lazily: the runtime exists only once the adapter does,
  // and a send can only start after the commit that fills the ref.
  const composerRef = useRef<ThreadComposerRuntime | undefined>(undefined);
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
        composer: () => composerRef.current,
        assertCanAct,
      }),
    [assertCanAct, connection, destination, messages, path, projection, resolvePath, snapshot, view],
  );

  const runtime = useExternalStoreRuntime<ThreadMessageLike>(adapter);
  useEffect(() => {
    composerRef.current = runtime.thread.composer;
  }, [runtime]);
  // A tentative first-turn choice lives only while this thread is the one on
  // screen (M13-T89 U2): keyed on this thread's composer, never on the current one.
  useDiscardFirstTurnOnLeave(runtime.thread.composer, isMain);
  return runtime;
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
  const stable = useMemo<LaserStable>(() => ({
    ...parent,
    destination: {
      tab: "code",
      codeProject: workspace,
      path,
      targetPath: undefined,
      phase: "ready",
      intent: 0,
    },
    ...(workspace !== undefined ? { currentProject: workspace } : {}),
    actions: buildActions(scopedStore.getSnapshot),
  }), [parent, buildActions, path, scopedStore, workspace]);
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
        creationTarget: () => createInRef.current(store.getSnapshot()),
        createSession: async (requested) => {
          try {
            const target = createInRef.current(store.getSnapshot());
            if (!target || target.cwd !== requested.cwd || target.agentName !== requested.agentName) {
              throw new Error(unavailableRef.current);
            }
            const created = await newSessionRef.current(requested.cwd, {
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
          await client.request("pi/session/delete", { path: target, worktree: takeWorktreeDisposition(target) });
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
  }, [snapshotStore, store, client, dispatch, scopedOnError, openSession, path]);

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
    // Same discipline as the provider: the selection waits for the adoption.
    threadId: useHeldWhile(initializing > 0, threadId),
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
