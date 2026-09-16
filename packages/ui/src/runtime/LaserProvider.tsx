"use client";
import { accountUsageRefreshError } from "./account-usage-error.js";
import { TranscriptPresentation } from "./transcript-presentation.js";
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
import { EDITABLE_TEXT_MAX_BYTES, PRODUCT_NAME, PRODUCT_VERSION, utf8ByteLength } from "@lasercode/protocol";
import {
  AssistantRuntimeProvider,
  AuiConfig,
  AuiProvider,
  useAui,
  useAuiState,
  useExternalStoreRuntime,
  useRemoteThreadListRuntime,
} from "@assistant-ui/react";
import type { AssistantRuntime, RemoteThreadListAdapter, ThreadComposerRuntime, ThreadMessageLike } from "@assistant-ui/react";
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
  Fragment,
  createContext,
  useCallback,
  useContext,
  useEffect,
  useId,
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
import { hydrationEpochOf, isDormantView } from "../view-summary.js";
import { atLiveEdge, onStanding } from "./anchored-messages.js";
import { createViewCache, type ActionReservation, type RendererViewCounters, type ViewCache } from "./view-cache.js";
import {
  PRESSURE_REFUSAL_MESSAGES,
  PressureRefusedError,
  createRendererPressureController,
  createRendererPressureSampler,
  type RendererPressureState,
} from "./pressure/index.js";
import { createThreadAdapter, sendToSession, type SendBehavior } from "./adapter.js";
import { firstTurnFromRunConfig, useDiscardFirstTurnOnLeave } from "./first-turn.js";
import { createSessionLauncher, type NewSessionOptions } from "./new-session.js";
import {
  codeProjectForSession,
  isMainReady,
  isSessionInCodeProject,
  mainCodeProject,
  mainPath,
  pendingSessionPath,
  mainTab,
  sessionOpenPhase,
  sameSessionOpenPhase,
  rememberedCodeOf,
  type MainDestination,
  type MainTab,
} from "./main-destination.js";
import {
  initialDestinationFromMemory,
  useMainDestinationController,
  readDestinationMemory,
  type MainInitializationToken,
} from "./main-destination-controller.js";
import { createCatalogLoader } from "./catalog-loader.js";
import { DEVICE_KEYS, deviceStore } from "./device-storage.js";
import { createEnvironmentLifecycle, useEnvironmentSubtreeKey, type EnvironmentLifecycle } from "./environment-lifecycle.js";
import { tailCache } from "./tail-cache/index.js";
import { sessionIdForPath } from "./provisional-paint.js";
import { createProvisionalAuthority, sessionAuthorityRefusal } from "./provisional-authority.js";
import { createHistoryLoader, type HistoryReads } from "./history-loader.js";
import { createHistoryWindows, MAIN_WINDOW_SCOPE, type HistoryWindowOwner, type HistoryWindows } from "./history-owners.js";
import { sessionsList } from "../components/shell/session-groups.js";
import { sessionFolds } from "../components/assistant-ui/elements/session-folds.js";
import { rehydrateFleetState } from "../fleet/fleet-state.js";
import { beamStore } from "../components/beam/beam-store.js";
import { createShellSnapshot } from "./presentation-state.js";
import { startVisiblePoll } from "./visible-poll.js";
import { useWorkerReadiness } from "./worker-readiness.js";
import { createMainLandingDraftStore, useMainLandingDrafts } from "./main-landing-drafts.js";
import { sessionKindTab } from "./session-tab-memory.js";
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
  jump(entryId: string, options?: MoveOptions): Promise<boolean>;
  refreshSessions(): Promise<void>;
  loadMoreSessions(cwd: string): Promise<boolean>;
  allSessionSummaries(): Promise<SessionSummary[]>;
  expandCatalog(): () => void;
  refreshEntries(options?: { tail?: boolean }): Promise<void>;
  loadEarlierEntries(): Promise<boolean>;
  /** Replace what a trim released with the conversation's recent history. */
  reloadRecentHistory(): Promise<boolean>;
  loadAllEntries(): Promise<boolean>;
  /** Refresh cross-app allowance for the session's account provider. */
  refreshAccountUsage(): Promise<void>;
  goal(action: GoalAction): Promise<void>;
  /**
   * Empty both queues: the pending tray and whatever the engine already holds.
   * Resolves with the content of everything dropped, so the composer can offer it
   * back rather than lose it.
   */
  clearQueue(): Promise<ContentBlock[]>;
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
  /**
   * What this renderer is holding of the conversations it has shown (RP-5).
   * A snapshot, read on demand: the diagnostics surface asks for it, nothing
   * pushes it, and it is this device's own — a renderer somewhere else has
   * its own view state and this says nothing about it.
   */
  rendererViews: () => RendererViewCounters;
  /**
   * What this window has measured about its own memory, what it released and
   * what it is refusing right now (RP-8, D-265). This device's own state: it is
   * never sent anywhere, and it says nothing about any other window.
   */
  pressure: () => RendererPressureState;
  /** Subscribe to that state; the returned function unsubscribes. */
  subscribePressure: (listener: () => void) => () => void;
  /**
   * Hold room in the renderer for something a person is about to do — today,
   * rebuilding an oversized prompt so it can be edited (RP-5b §2). The caller
   * keeps the token for as long as it holds those bytes.
   */
  reserveViewAction: (path: string, bytes: number) => ActionReservation | undefined;
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
  openSession: (path: string, options?: { select?: boolean; policy?: "recent" }) => Promise<void>;
  buildActions: (readScoped: () => AppState, history?: HistoryReads) => LaserActions;
  windows: HistoryWindows;
  archive: ArchiveStore;
  refreshSessions: () => Promise<void>;
  /** Keep `path` attached on the host while a scope shows it; returns the release. */
  attach: (path: string) => () => void;
}
const LaserInternalsContext = createContext<LaserInternals | null>(null);

/**
 * Whether this renderer can take a prompt the engine handed back (RP-5b B3).
 *
 * The worker has already refused to serialize anything past the editable bound,
 * so what arrives is bounded; this is the renderer's own accounting on top of
 * it. The reservation it takes belongs to the composer from here on, and is
 * released when the composer lets the text go — not when this returns.
 */
function admitEditorText(cache: { reserveAction: ViewCache["reserveAction"] }, path: string, text: string) {
  const bytes = utf8ByteLength(text);
  if (!Number.isSafeInteger(bytes) || bytes > EDITABLE_TEXT_MAX_BYTES) return undefined;
  return cache.reserveAction(path, bytes * 2);
}

export function useLaserStable(): LaserStable {
  const value = useContext(LaserStableContext);
  if (!value) throw new Error("useLaser must be used inside <LaserProvider>.");
  return value;
}

/**
 * This window's own memory-pressure state, as a subscription (RP-8, D-265).
 *
 * Surfaces read it to say what is paused and why. It is local: a phone reading
 * a desktop host's diagnostics reports its own window, never the other one.
 */
export function useRendererPressure(): RendererPressureState {
  const { pressure, subscribePressure } = useLaserStable();
  return useSyncExternalStore(subscribePressure, pressure, pressure);
}

const identity = <T,>(value: T): T => value;

/** Conversations promoted into the cache's hot set per environment (RP-10/11). */
const PRIME_RECENT_SESSIONS = 8;

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

/** The canonical presentation owner is shared by main and Beam, not their DOM placement. */
export function useTranscriptPresentation(): TranscriptPresentation {
  const store = useContext(LaserStateContext);
  // A row mounted outside the app's store (a harness, a preview) still gets an
  // owner, so no caller carries a second edit/question implementation.
  const [detached] = useState(() => (store ? undefined : new TranscriptPresentation()));
  return store?.presentation ?? detached!;
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
  presentation: TranscriptPresentation;
  getSnapshot(): AppState;
  subscribe(listener: () => void): () => void;
  dispatch(action: Action): void;
}

export function createStateStore(initial: AppState = initialState): StateStore & {
  batch(deliver: () => void): void;
  observeTransactions(observer: (action: Action, before: AppState, after: AppState) => boolean): () => void;
  publishTransactions(): void;
} {
  let current = initial;
  const presentation = new TranscriptPresentation();
  let depth = 0;
  let dirty = false;
  const listeners = new Set<() => void>();
  /**
   * Observers of the whole transaction, not of the state after it: an owner
   * that has to know *what changed* — which session, and how — rather than
   * diff two snapshots for it. Owner-local transcript windows use it to replay
   * an action into their own copy; the view bound uses it to keep its measure
   * of one path without walking every other (RP-5).
   */
  const observers = new Set<(action: Action, before: AppState, after: AppState) => boolean>();
  const publish = () => {
    if (depth || !dirty) return;
    dirty = false;
    presentation.reconcile(current);
    for (const listener of [...listeners]) listener();
  };
  return {
    presentation,
    getSnapshot: () => current,
    subscribe(listener) {
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
      };
    },
    dispatch(action) {
      const before = current;
      current = reduce(before, action);
      dirty = dirty || current !== before;
      // An owner's replay may need an event the canonical watermark already
      // saw. Finish every fold before any React subscriber sees the transaction.
      for (const observer of [...observers]) dirty = observer(action, before, current) || dirty;
      publish();
    },
    observeTransactions(observer) { observers.add(observer); return () => { observers.delete(observer); }; },
    publishTransactions() { dirty = true; publish(); },
    batch(deliver) {
      depth++;
      try {
        deliver();
      } finally {
        depth--;
        publish();
      }
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
  /**
   * Report whether this thread's composer holds words a person wrote and
   * nobody else has (RP-5). A session with one is never released.
   */
  setDraft?: ((path: string, held: boolean) => void) | undefined;
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
// Device state (RP-13: one environment-scoped authority, `device-storage.ts`)
// ---------------------------------------------------------------------------

/**
 * Forget every remembered destination, so the next load opens no session.
 * Setup owns the window only while nothing is open (D-47); without this, a
 * reload during setup would restore the last session and hide the flow.
 */
export function forgetRememberedSessions(): void {
  deviceStore.write(DEVICE_KEYS.sessionsByProject, undefined);
  deviceStore.write(DEVICE_KEYS.destination, undefined);
  deviceStore.write(DEVICE_KEYS.project, undefined);
}

/** Last path segment, for a sentence about a directory. */
const basenameOf = (cwd: string): string => cwd.replace(/[/\\]+$/, "").split(/[/\\]/).pop() || cwd;

// ---------------------------------------------------------------------------
// Provider
// ---------------------------------------------------------------------------

export interface LaserProviderProps {
  children: ReactNode;
  /** Override the host WebSocket URL (defaults to the page origin). */
  url?: string | undefined;
}

export function LaserProvider({ children, url }: LaserProviderProps): ReactNode {
  const store = useMemo(() => createStateStore({ ...initialState, destination: initialDestinationFromMemory() }), []);
  const dispatch = store.dispatch;
  // Always the committed state, even inside a socket callback that runs before
  // React re-renders.
  const readState = store.getSnapshot;
  const shellSnapshot = useMemo(() => createShellSnapshot(store.getSnapshot), [store]);
  const state = useSyncExternalStore(store.subscribe, shellSnapshot, shellSnapshot);

  const currentProject = mainCodeProject(state.destination);
  const [projectList, setProjectList] = useState<ProjectInfo[]>([]);
  const [trustRequests, setTrustRequests] = useState<TrustRequest[]>([]);
  const landingDrafts = useMemo(() => createMainLandingDraftStore(), []);

  const archive = useMemo(() => createArchiveStore(), []);
  useEffect(() => () => archive.dispose(), [archive]);
  const archiveRevision = useSyncExternalStore(archive.subscribe, archive.getSnapshot, archive.getSnapshot);

  /**
   * Host notifications the reducer does not model: the project list, trust
   * questions, per-session attention, and a worker that came back. Kept in a
   * ref so the `HostClient` identity does not depend on it.
   */
  const onHostNotification = useRef<(method: HostNotificationMethod, params: unknown) => void>(() => {});

  const rehydrate = useRef<(path: string) => void>(() => {});

  /**
   * Everything that is derived from an environment and lives outside the
   * reducer: module-level stores, the landing drafts held in memory, and the
   * per-session bookkeeping this provider keeps in refs.
   *
   * Assigned during render (not in an effect) because the socket callbacks
   * below can fire as soon as the client connects, and a reset that had not
   * been wired yet would leave the old environment's state on screen.
   */
  const resetEnvironmentState = useRef<() => void>(() => {});
  /**
   * Assigned in the same `useMemo` as the client, because it needs that exact
   * client: the attachments it drops must be the ones this connection holds.
   */
  const environmentLifecycle = useRef<EnvironmentLifecycle>({ accept: () => ({ ok: true }), fail: () => {} });

  const client = useMemo(() => {
    const created: HostClient = new HostClient({
      ...(url !== undefined ? { url } : {}),
      batchNotifications: store.batch,
      onNotification: (method, params) => {
        dispatch({ type: "notification", method, params });
        onHostNotification.current(method, params);
      },
      onConnection: (s) => dispatch({ type: "connection", state: s }),
      onVersionMismatch: (version) => dispatch({ type: "versionMismatch", version }),
      /**
       * The environment, before this connection opens (RP-13).
       *
       * The decision of what to keep and what to throw away lives in
       * `environment-lifecycle.ts`; this is only the wiring. A refusal there
       * keeps the client closed, so nothing is read, written, resumed or
       * requested in an environment this device could not be prepared for.
       */
      onEnvironment: (environment) => environmentLifecycle.current.accept(environment),
      onEnvironmentFailure: (reason) => environmentLifecycle.current.fail(reason),
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
          rehydrate.current(path);
        }
      },
      // Never re-open a Pi session the app has dropped, and never re-read one
      // whose transcript was released: it is opened again when somebody opens
      // it, not because a socket came back (RP-5).
      shouldResume: (path) => {
        const view = readState().open[path];
        return view !== undefined && !isDormantView(view);
      },
    });
    environmentLifecycle.current = createEnvironmentLifecycle({
      forgetAttachments: () => created.forgetAttachments(),
      dispatch,
      reset: () => resetEnvironmentState.current(),
      restoreDestination: () => dispatch({ type: "restoreDestination", destination: initialDestinationFromMemory() }),
    });
    return created;
  }, [url]);

  /** Loads have an in-place Retry; a second toast would cover it on a phone. */
  const onError = useCallback((error: unknown) => {
    const text = error instanceof Error ? error.message : String(error);
    // Not an error: this window said "not right now" on purpose, and the
    // sentence already says what still works.
    if (error instanceof PressureRefusedError) {
      dispatch({ type: "toast", level: "warning", text });
      return;
    }
    const current = readState();
    if (error instanceof SessionLoadError || sessionOpenPhase(current, current.current).reason === text) return;
    dispatch({ type: "toast", level: "error", text });
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

  const catalogLoader = useMemo(() => createCatalogLoader({
    initialSizes: Object.fromEntries(sessionsList.get().revealed),
    request: (params) => client.request("pi/session/list", params),
    current: () => ({ sessions: readState().sessions, ...(readState().catalogGroups ? { groups: readState().catalogGroups! } : {}) }),
    apply: (result) => dispatch({ type: "sessions", ...result }),
    exclude: () => archive.list(),
    probe: () => [...new Set([
      ...Object.values(readState().agents.runs).flatMap(run => [run.sessionPath, run.rootSessionPath, ...(run.parent ? [run.parent.sessionPath] : [])]),
      ...Object.values(readState().tasks.tasks).map(task => task.sessionPath),
    ])],
    include: () => {
      const pending = pendingSessionPath(readState().destination);
      const beam = beamStore.getSnapshot().path;
      const memory = readDestinationMemory();
      const code = memory.code;
      return [...new Set([...(readState().current ? [readState().current!] : []), ...scopedPaths.current.keys(), ...sessionsList.get().pinned,
        ...(pending ? [pending] : []), ...(beam ? [beam] : []),
        ...(memory.chat ? [memory.chat] : []), ...("path" in code ? [code.path] : []),
        ...(code.kind === "beam-session" && "path" in code.returnTo ? [code.returnTo.path] : []),
      ])];
    },
  }), [archive, client]);
  const refreshSessions = useCallback(async () => {
    try { await catalogLoader.refresh(); } catch { /* reconnect will retry */ }
  }, [catalogLoader]);
  const catalogReferences = [...new Set([
    ...Object.values(state.agents.runs).flatMap(run => [run.sessionPath, run.rootSessionPath, ...(run.parent ? [run.parent.sessionPath] : [])]),
    ...Object.values(state.tasks.tasks).map(task => task.sessionPath),
  ])].sort().join("\n");
  useEffect(() => { if (state.connection === "open") void refreshSessions(); }, [archiveRevision, catalogReferences, refreshSessions, state.connection]);

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

  // Pi creates the session file on the first message and renames happen
  // mid-session, so refresh on connect, whenever a session settles, and on a
  // slow poll while connected.
  const runningCount = Object.values(state.open).filter((v) => v.running).length;
  useEffect(() => {
    if (state.connection === "open") void refreshSessions();
  }, [state.connection, runningCount, refreshSessions]);
  useEffect(() => {
    if (state.connection !== "open") return;
    void refreshProjects();
  }, [state.connection, refreshProjects]);
  useEffect(() => {
    if (state.connection !== "open") return;
    return startVisiblePoll(() => void refreshSessions(), 20_000);
  }, [state.connection, refreshSessions]);

  // --- session lifecycle --------------------------------------------------

  /**
   * The thread-list `fetch` and the per-thread `isMain` effect both open a
   * thread; without this they race and each one's snapshot clobbers the other.
   */
  const openInFlight = useRef(new Map<string, { promise: Promise<void> }>());
  const openEpochs = useRef(new Map<string, symbol>());
  /**
   * Sessions whose leaf is being moved right now (`navigate`, `fork`). A
   * move that stops a turn first settles that turn *inside* the request, and
   * the transcript re-reads the tree whenever a turn settles: that re-read
   * would race the move — and after a fork the old path is not served at all.
   * The move re-hydrates when it lands, so the re-read has nothing to add.
   */
  const moving = useRef(new Set<string>());
  /**
   * Sessions a `LaserThreadScope` is showing (the Beam bubble). They are on
   * screen too, so they stay attached for as long as the scope holds them;
   * the counter re-runs the effect when a scope comes or goes.
   */
  const scopedPaths = useRef(new Map<string, number>());
  /**
   * Threads whose composer holds words a person wrote and nobody else has:
   * text, an attachment, or a tentative first-turn choice. Reported by each
   * thread runtime as its composer changes (RP-5); an empty composer reports
   * nothing and pins nothing.
   */
  const composerDrafts = useRef(new Map<string, number>());
  const notifyPins = useRef<() => void>(() => {});
  /**
   * What a composer is holding, in bytes (RP-5, RP-5b B3). A boolean said a
   * draft was there; a message read back for editing can be tens of kilobytes,
   * and the bound must count them for as long as the composer owns them.
   */
  const setComposerDraft = useCallback((path: string, held: boolean | number) => {
    const before = composerDrafts.current.get(path) ?? 0;
    const bytes = typeof held === "number" ? Math.max(0, held) : held ? Math.max(before, 1) : 0;
    if (bytes <= 0) {
      composerDrafts.current.delete(path);
      composerRooms.current.get(path)?.release();
      composerRooms.current.delete(path);
    } else composerDrafts.current.set(path, bytes);
    // Words appearing or going is a change in what is held, and the store did
    // not move: the bound has to be told (RP-5).
    if (before !== bytes) notifyPins.current();
  }, []);
  /**
   * Room a composer is holding with the words it was given (RP-5b B3). It is
   * released when those words go — sent, cleared, the path closed, the
   * environment changed — and a handover that arrives after any of that gives
   * its room straight back rather than taking a successor's.
   */
  const composerRooms = useRef(new Map<string, ActionReservation>());
  const releaseComposerRoom = useCallback((path: string) => {
    const held = composerRooms.current.get(path);
    if (!held) return;
    composerRooms.current.delete(path);
    held.release();
  }, []);
  const holdForComposer = useCallback((path: string, text: string, room: ActionReservation) => {
    releaseComposerRoom(path);
    composerRooms.current.set(path, room);
    setComposerDraft(path, utf8ByteLength(text));
  }, [releaseComposerRoom, setComposerDraft]);
  useEffect(() => () => {
    for (const [path] of composerRooms.current) releaseComposerRoom(path);
  }, [releaseComposerRoom]);

  const windows = useMemo(() => createHistoryWindows(store), [store]);
  useEffect(() => () => windows.dispose(), [windows]);

  /**
   * The bound on retained transcripts (RP-5). Every session keeps its light
   * record; only a bounded set keeps the entries, blocks, images and
   * projections that cost memory. It releases nothing a person is using, and
   * releasing stops this window resuming that path until it is opened again.
   */
  const viewCache = useMemo(() => createViewCache({
    read: () => store.getSnapshot(),
    dispatch: store.dispatch,
    environment: {
      scoped: () => scopedPaths.current.keys(),
      hasDraft: (path) => composerDrafts.current.has(path) || store.presentation.hasEditDraft(path),
      // Exact bytes, so a draft read back from a conversation is counted for
      // as long as the composer holds it, not merely pinned (RP-5b B3).
      draftBytes: (path) => composerDrafts.current.get(path) ?? 0,
    },
    onRelease: (paths) => {
      // A released transcript is not resumed on the next reconnect: it would
      // arrive as a replay with nothing to apply it to, and re-read fifty
      // conversations nobody is looking at.
      for (const path of paths) client.untrack(path);
    },
  }), [client, store]);
  notifyPins.current = viewCache.notifyPins;
  useEffect(() => {
    // The transaction, not the state after it: the bound follows the action to
    // the one session it touched instead of walking every record per token.
    const stop = store.observeTransactions((action, before, after) => {
      viewCache.observeTransaction(action, before, after);
      return false;
    });
    return () => { stop(); viewCache.dispose(); };
  }, [store, viewCache]);

  /**
   * This window's own memory-pressure actor (RP-8, D-265).
   *
   * It measures what this environment can honestly measure, gives back its
   * rebuildable caches and the transcripts nobody is reading, and refuses new
   * whole-transcript hydration while it is under pressure. It reports nothing
   * anywhere: a window's memory is its own business, and the host's summary
   * arrives here rather than the other way round.
   */
  const pressure = useMemo(() => createRendererPressureController({
    sample: createRendererPressureSampler(),
    cache: { releaseUnder: (level) => viewCache.releaseUnder(level), counters: () => viewCache.counters() },
  }), [viewCache]);
  useEffect(() => {
    pressure.start();
    const stop = client.subscribe((method, params) => {
      if (method === "resource/pressure") pressure.observePublication(params);
    });
    return () => { stop(); pressure.dispose(); };
  }, [client, pressure]);
  useEffect(() => {
    // A socket that has just opened may be a host that restarted, and its
    // pressure epoch starts again at one. A window holding the old fence would
    // never hear it.
    if (state.connection === "open") pressure.forgetHost();
  }, [pressure, state.connection]);
  // The main window is registered wherever it is, so a scope that shows the
  // same session keeps its own loaded transcript instead of sharing this one.
  const mainWindowPath = mainPath(state.destination) ?? state.current;
  windows.owner(MAIN_WINDOW_SCOPE, mainWindowPath);
  useEffect(() => () => windows.forget(MAIN_WINDOW_SCOPE, mainWindowPath), [windows, mainWindowPath]);
  const historyLoader = useMemo(() => createHistoryLoader({
    isCurrent: (candidate: string) => mainPath(readState().destination) === candidate,
    get: path => readState().open[path],
    request: params => client.request("pi/session/entries", params),
    dispatch,
    adoptEpoch: (path, seq) => { client.resync(path, seq); seenSeq.current.delete(path); },
    track: (path, seq) => client.track(path, seq),
  }), [client]);
  const readHistory = historyLoader.read;

  /**
   * The opaque id of the conversation at this path, from canonical state.
   *
   * The device cache is addressed by the session's own id and never by a path
   * (RP-10): a path is a private filesystem locator, so the mapping stays here,
   * in the state that owns it — the open view's authoritative session state
   * first, then the catalog.
   */
  const sessionIdOf = useCallback((path: string): string | undefined => sessionIdForPath(readState(), path), []);

  /**
   * The lifecycle of what this device paints before the host answers (RP-11):
   * the paint itself, retiring exactly the record it painted, bounded warming,
   * and the one fence every host-mutating control asks. It lives in its own
   * module; the provider only wires it to the store and the cache.
   */
  const provisional = useMemo(() => createProvisionalAuthority({
    readState,
    dispatch,
    appVersion: PRODUCT_VERSION,
  }), []);

  /** Hydrate one cached view. Main-window selection belongs to the controller. */
  const openSession = useCallback(
    (path: string, options: { select?: boolean; refreshHistory?: boolean; policy?: "recent" } = {}): Promise<void> => {
      const running = openInFlight.current.get(path);
      if (running) return running.promise;
      dispatch({ type: "sessionLoad", path, phase: "opening" });
      const epoch = Symbol();
      openEpochs.current.set(path, epoch);
      // A person is here: this conversation is the most recently used one.
      viewCache.touch(path);
      // Optional reads may outlive readiness, but not a newer open or Retry —
      // and not a release of the transcript this read is for (RP-5).
      let failed = false;
      const hydration = hydrationEpochOf(readState().open[path]);
      const accepting = () => !failed && openEpochs.current.get(path) === epoch
        && hydrationEpochOf(readState().open[path]) === hydration;
      const work = (async () => {
        // The page and the socket come up together: without this the first
        // session someone clicks after a reload was a dead click.
        // An already-open socket can start the request now, before React
        // tears down the old transcript. An unconditional await yields that
        // head start even though there is no connection left to wait for.
        if (readState().connection !== "open") await client.whenConnected();
        const view = readState().open[path];
        const hydrated = view?.hydrated === true;
        // session/load is metadata only. The entries snapshot below is the
        // transcript; replaying the buffer as well would duplicate it.
        const { state: session, replayFrom, seq: loadedSeq } = await client.request("session/load", {
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
        }
        // These reads are independent once the worker has loaded the session.
        // Capture each race watermark before issuing them. Only history is
        // required for readiness; a missing goal or tray must never hide it.
        const expectPending = readState().open[path]?.pending;
        // A normal re-entry replaces whatever this surface had paged in with the
        // session's recent tail, before anything older can be mounted again.
        const history = options.policy === "recent" ? historyLoader.recent(path, accepting, loadedSeq)
          : (!hydrated || needsResync || options.refreshHistory)
          ? readHistory(path, false, accepting, loadedSeq) : Promise.resolve();
        void client.request("session/goal/get", { path }).then(({ goal }) => {
          if (accepting()) dispatch({ type: "goal", path, goal });
        }).catch(() => {});
        // A numbered tray update can overtake this list, including the empty
        // acknowledgement of delivery. The original array is its watermark.
        void client.request("session/pending/list", { path }).then(({ messages }) => {
          if (accepting() && expectPending) dispatch({ type: "pending", path, messages, expectPending });
        }).catch(() => {});
        await history;
        // The host has spoken for this conversation: if it replaced what this
        // device painted, exactly that record is retired (RP-10/11).
        provisional.settle(path);
        // Monotonic: the resume `session/load` after a dropped socket asks from
        // here, so an unstamped view would replay its whole buffer there too.
        client.track(path, readState().open[path]?.lastSeq ?? loadedSeq);
        dispatch({ type: "sessionLoad", path, phase: "ready" });
        if (!catalogLoader.hasIncluded(path)) void refreshSessions();
      })().catch((error: unknown) => {
        failed = true;
        dispatch({ type: "sessionLoad", path, phase: "error", reason: error instanceof Error ? error.message : String(error) });
        throw new SessionLoadError(error);
      });
      const entry = {
        promise: work.finally(() => {
          if (openInFlight.current.get(path) === entry) openInFlight.current.delete(path);
        }),
      };
      openInFlight.current.set(path, entry);
      return entry.promise;
    },
    [client, refreshSessions, readHistory],
  );

  // A worker can restart at the same zero watermark. Its reopen notification
  // still warrants a fresh tree, without changing the selected destination.
  rehydrate.current = (path) => { void openSession(path, { refreshHistory: true }).catch(onError); };

  const launchSession = useMemo(() => createSessionLauncher({
    state: readState,
    archived: (path) => archive.has(path),
    refresh: async () => {
      await client.whenConnected();
      await refreshSessions();
    },
    open: openSession,
    // Main and scoped callers coordinate selection outside the quiet launcher.
    select: () => {},
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
      dispatch({ type: "opened", state: session });
      dispatch({ type: "hydrate", path: session.path, entries: [] });
      dispatch({ type: "goal", path: session.path, goal: null });
      void refreshSessions();
      return session.path;
    },
  }), [archive, client, openSession, refreshSessions]);

  // The extracted controller is the sole writer of the main destination.
  const destination = useMainDestinationController({
    state,
    readState,
    dispatch,
    loadSession: (path) => openSession(path, { select: false, policy: "recent" }),
    paintProvisional: provisional.paint,
    launchSession: (cwd, options) => launchSession(cwd, { ...options, select: false }),
    archived: (path) => archive.has(path),
    onError,
    beforeTransition: (current) => landingDrafts.captureBeforeTransition(current),
  });
  const startupRestoring = destination.startupRestoring;

  // `requireCurrent`, `send`, `answerDialog` and `fork` live inside
  // `buildActions` below: they read "the current session" through the state
  // reader they are built with, so a `LaserThreadScope` can rebind the same
  // actions to its own session.

  // --- agents -------------------------------------------------------------

  const agentsActions = useMemo(() => createAgentsActions({ client, dispatch, guard, authority: provisional }), [client, guard, provisional]);
  /**
   * RP-5b §7: replacing what a trim released.
   *
   * The first read happens as soon as the current view carries a new trim
   * stamp. If its page did not contain what the surface was standing on, the
   * view keeps what it has and waits: the second — and last — read is spent at
   * the first safe moment, which is the transcript reaching the live edge, a
   * person coming back to this conversation, or a person asking for it. Losing
   * focus and ordinary scrolling are not safe moments and do nothing.
   */
  const currentPath = mainPath(state.destination);
  const trimmedStamp = currentPath ? state.open[currentPath]?.trimmed?.at : undefined;
  const deferredStamp = currentPath && state.open[currentPath]?.trimmed?.deferred ? trimmedStamp : undefined;
  const firstRead = useRef(new Map<string, string>());
  /** Called by an action once the engine has accepted it, never before. */
  const reconcileAfterAction = useRef<(path: string) => void>(() => {});
  const reconcileNow = useCallback((path: string) => {
    const epoch = openEpochs.current.get(path);
    return historyLoader.reconcile(path, () => !moving.current.has(path) && openEpochs.current.get(path) === epoch);
  }, [historyLoader]);
  // One read the moment a new stamp appears on the conversation on screen.
  useEffect(() => {
    if (!currentPath || trimmedStamp === undefined) return;
    if (firstRead.current.get(currentPath) === trimmedStamp) return;
    firstRead.current.set(currentPath, trimmedStamp);
    void reconcileNow(currentPath);
  }, [currentPath, reconcileNow, trimmedStamp]);
  // The second, at the first safe moment: the live edge, or coming back here.
  useEffect(() => {
    if (!currentPath || deferredStamp === undefined) return;
    if (atLiveEdge(currentPath)) { void reconcileNow(currentPath); return; }
    return onStanding(currentPath, () => {
      if (atLiveEdge(currentPath)) void reconcileNow(currentPath);
    });
  }, [currentPath, deferredStamp, reconcileNow]);
  // Coming back to this conversation is the other safe moment.
  const previousPath = useRef<string | undefined>(undefined);
  useEffect(() => {
    const returned = previousPath.current !== undefined && previousPath.current !== currentPath;
    previousPath.current = currentPath;
    if (!returned || !currentPath) return;
    if (state.open[currentPath]?.trimmed?.deferred) void reconcileNow(currentPath);
  }, [currentPath, reconcileNow, state.open]);
  /** After an accepted action on an old row, and never before it. */
  const afterAction = useCallback((path: string) => {
    if (readState().open[path]?.trimmed?.deferred) void reconcileNow(path);
  }, [reconcileNow]);
  reconcileAfterAction.current = afterAction;

  const tasksActions = useMemo(() => createTasksActions({ client, dispatch, guard, authority: provisional }), [client, guard, provisional]);

  // Definitions and the run registry come up with the connection and again
  // after every reconnect: a restarted host may hold different agents, and a
  // run that ended while we were away is only in its list.
  useEffect(() => {
    if (state.connection !== "open") return;
    void agentsActions.refresh();
    void agentsActions.runs();
  }, [agentsActions, state.connection]);

  // Warm the conversations a person is most likely to open, bounded by the
  // cache's own hot set (RP-10): a promoted record is what lets the next
  // re-entry paint in the same frame as the click (RP-11). From the catalog
  // the host published, and again only when that shortlist actually changes —
  // never per keystroke, and never a read this device pays for twice.
  const warmedFor = useRef<string | undefined>(undefined);
  useEffect(() => {
    const environmentKey = state.environment?.environmentKey;
    if (state.connection !== "open" || !state.sessionsLoaded || environmentKey === undefined) return;
    const targets = [...state.sessions]
      .sort((left, right) => Date.parse(right.modifiedAt) - Date.parse(left.modifiedAt))
      .flatMap((summary) => (typeof summary.id === "string" && summary.id !== ""
        ? [{ path: summary.path, sessionId: summary.id }] : []))
      .slice(0, PRIME_RECENT_SESSIONS);
    if (targets.length === 0) return;
    const shortlist = `${environmentKey}\u0000${targets.map((target) => target.sessionId).join("\u0000")}`;
    if (warmedFor.current === shortlist) return;
    warmedFor.current = shortlist;
    provisional.warm(targets);
  }, [provisional, state.connection, state.environment?.environmentKey, state.sessions, state.sessionsLoaded]);

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
   * The label each live scope holds its session with (RP-6).
   *
   * The host counts transcript delivery per connection *and* per surface, so a
   * bubble over a session and the session's own view are two holders and the
   * session stops being delivered when the last of them lets go. The label is
   * this window's own opaque counter — never a path, a session id, a run or a
   * device value — and it grants nothing: it only says which of this
   * connection's surfaces is still looking.
   */
  const scopeClaims = useRef(new Map<string, string>());
  const nextScopeOwner = useRef(0);
  /** Which connection each scope last claimed on: membership is per connection. */
  const scopeClaimedAt = useRef(new Map<string, number>());
  const connectionEpoch = useRef(0);
  const [scopeRevision, setScopeRevision] = useState(0);
  const claimScope = useCallback(
    (owner: string, path: string) => {
      // `fromSeq` is what this window already holds, so claiming a surface
      // never costs a replay of the buffer it has already applied.
      const seq = readState().open[path]?.lastSeq ?? 0;
      const claimedOn = connectionEpoch.current;
      client.request("session/load", { path, owner, fromSeq: seq }).then(
        () => {
          // Only a claim the host took counts as made on this connection. A
          // failed one is retried by the next reconnect rather than leaving
          // the bubble quietly unsubscribed for the life of the socket.
          if (scopeClaims.current.get(owner) === path) scopeClaimedAt.current.set(owner, claimedOn);
        },
        (error: unknown) => {
          scopeClaimedAt.current.delete(owner);
          // The host refuses a surface it cannot follow with a sentence a
          // person can act on ("close one before opening another"). Said here,
          // where the bubble is, rather than swallowed into a silent staleness.
          if (scopeClaims.current.get(owner) === path) onError(error);
        },
      );
    },
    [client, onError, readState],
  );
  const attachScope = useCallback((path: string): (() => void) => {
    const owner = `scope:${nextScopeOwner.current++}`;
    scopedPaths.current.set(path, (scopedPaths.current.get(path) ?? 0) + 1);
    scopeClaims.current.set(owner, path);
    claimScope(owner, path);
    // A scope now holds this session, and letting go below releases it.
    notifyPins.current();
    setScopeRevision((n) => n + 1);
    return () => {
      const left = (scopedPaths.current.get(path) ?? 1) - 1;
      if (left <= 0) scopedPaths.current.delete(path);
      else scopedPaths.current.set(path, left);
      scopeClaims.current.delete(owner);
      scopeClaimedAt.current.delete(owner);
      client.request("pi/session/detach", { path, owner }).catch(() => {});
      notifyPins.current();
      setScopeRevision((n) => n + 1);
    };
  }, [claimScope, client]);
  // A reconnect is a new connection, so its membership starts empty: every
  // scope still on screen says so again before it can expect updates.
  useEffect(() => {
    if (state.connection !== "open") {
      connectionEpoch.current += 1;
      return;
    }
    // A reconnect is a new connection, so its membership starts empty; so is a
    // claim the host refused or that never arrived. Both are retried here.
    for (const [owner, path] of scopeClaims.current) {
      if (scopeClaimedAt.current.get(owner) === connectionEpoch.current) continue;
      claimScope(owner, path);
    }
  }, [claimScope, state.connection, scopeRevision]);
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
      // This view has stopped showing the session. A scope holding the same
      // session keeps its own hold, so this releases one surface and not the
      // conversation: nothing is closed, and switching back re-attaches
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

  /**
   * The provider's own share of an environment reset (RP-13).
   *
   * The reducer drops everything it holds, and the refs this component keeps
   * about sessions go with it. The module-level stores and the archive keep
   * themselves up to date through the device store's own lifecycle, so they
   * are not enumerated here.
   */
  resetEnvironmentState.current = () => {
    seenSeq.current.clear();
    scopedPaths.current.clear();
    composerDrafts.current.clear();
    // Counters, recency and any tail captured but not handed over belong to
    // the environment they were taken in (RP-13).
    viewCache.reset();
    pressure.reset();
    scopeClaims.current.clear();
    scopeClaimedAt.current.clear();
    detached.current.clear();
    openInFlight.current.clear();
    openEpochs.current.clear();
    moving.current.clear();
    landingDrafts.drafts.clear();
    setProjectList([]);
    setTrustRequests([]);
    dispatch({ type: "resetEnvironment" });
    // The module-level stores are not listed here on purpose: each one
    // subscribes to the device store and re-reads whatever namespace is in
    // force, including the first one (`device-storage.ts`). A list here would
    // be a second place to forget.
  };

  // --- actions ------------------------------------------------------------

  // A refreshed snapshot of a session that is already current where it was
  // asked for (`setModel`, `setThinking`): never a selection. Inside a
  // `LaserThreadScope` a selecting `opened` would drag the main view onto the
  // bubble's session.
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
          // A released transcript has nothing to re-read into; its next open
          // reads the session again anyway (RP-5).
          if (open[path] && !isDormantView(open[path])) rehydrate.current(path);
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
  const buildActions = useCallback((readScoped: () => AppState, history: HistoryReads = historyLoader): LaserActions => {
    /**
     * The one thing this window refuses while it is short of memory, recorded
     * once and refused before any request leaves the process (RP-8, D-265).
     * Every bounded read, every reconnect and every mutation stays available.
     */
    const refuseWholeTranscript = (): void => {
      if (pressure.admits("whole_transcript")) return;
      pressure.refused("whole_transcript");
      throw new PressureRefusedError("whole_transcript", PRESSURE_REFUSAL_MESSAGES.whole_transcript);
    };
    const requireCurrent = (): string => {
      const snapshot = readScoped();
      const path = snapshot.current;
      if (!path) throw new Error("No session is open.");
      if (readScoped === readState) {
        const currentDestination = snapshot.destination;
        if (!isMainReady(currentDestination) || mainPath(currentDestination) !== path) {
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

    const ensureEntry = async (path: string, entryId: string) => {
      await history.ensure(path, entryId, () => readScoped().current === path);
      if (requireCurrent() !== path) throw new Error("The conversation changed. Choose the message again.");
      // The engine, not a client-side tree projection, validates the target.
    };

    const fork = async (entryId: string, options?: MoveOptions) => {
      const path = requireCurrent();
      await ensureEntry(path, entryId);
      moving.current.add(path);
      let session: SessionState;
      let editorText: string | undefined;
      let omitted = false;
      try {
        // A stop asked for here reaches this store as the original session's
        // own updates (the aborted reply, then settled) before the reply
        // below: its transcript records the stop before it is left behind.
        const forked = await client.request("pi/session/fork", { path, entryId, ...(options?.stopFirst ? { stopFirst: true } : {}) });
        session = forked.state;
        editorText = forked.editorText;
        omitted = forked.editorTextOmitted === true;
        client.untrack(path);
        client.track(session.path, 0);
        // Prepare the fork in its own cached view; the visible source survives
        // until this tail (and any intervening live updates) is ready.
        dispatch({ type: "opened", state: session });
        await history.read(session.path);
      } finally {
        moving.current.delete(path);
      }
      dispatch({ type: "forked", from: path, state: session });
      // The action was accepted and the row it named has done its work; only
      // now may a replacement page be read (RP-5b §7).
      reconcileAfterAction.current(session.path);
      if (readScoped === readState) destination.replaceMainSession(path, session);
      if (omitted) {
        dispatch({ type: "toast", level: "warning", text: "That message is too large to put back in the composer here. It is unchanged in the conversation you forked from." });
      } else if (editorText) {
        // A fork hands back the prompt it forked from. That prompt can be far
        // larger than this surface may hold, so it is admitted only when the
        // renderer's own accounting has room for it — and refused in words
        // otherwise, leaving the fork itself untouched (RP-5b §2).
        const room = admitEditorText(viewCache, session.path, editorText);
        if (room) {
          dispatch({
            type: "notification",
            method: "pi/ui/event",
            params: { path: session.path, method: "setEditorText", text: editorText },
          });
          // The composer holds these bytes now, and holds the room with them:
          // the reservation is handed over, not given back (RP-5b B3).
          holdForComposer(session.path, editorText, room);
        } else {
          dispatch({ type: "toast", level: "warning", text: "That message is too large to put back in the composer here. It is unchanged in the conversation you forked from." });
        }
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
      await ensureEntry(path, entryId);
      moving.current.add(path);
      try {
        // The worker owns stop-then-move: a failure after the stop leaves the
        // session stopped and unmoved, and the error reaches `guard` as usual.
        const { editorText, editorTextOmitted, cancelled } = await client.request("pi/session/navigate", { path, entryId, ...(options?.stopFirst ? { stopFirst: true } : {}) });
        if (cancelled) {
          dispatch({ type: "toast", level: "warning", text: "A feature stopped that change." });
          return false;
        }
        await history.read(path);
        reconcileAfterAction.current(path);
        if (editorTextOmitted) {
          // The move has already happened — this is the conversation's own
          // leaf, moved by the engine — so the only thing that did not happen
          // is the handback. Say exactly that (RP-5b B3).
          dispatch({ type: "toast", level: "warning", text: "The conversation moved to that message, but it is too large to put back in the composer here. Open it to read or copy what you need." });
          return {};
        }
        if (editorText === undefined) return {};
        // The same gate on the way back from a move, and the room stays held
        // for as long as the composer holds the words.
        const room = admitEditorText(viewCache, path, editorText);
        if (!room) {
          dispatch({ type: "toast", level: "warning", text: "The conversation moved to that message, but there is no room to put it back in the composer here. Open it to read or copy what you need." });
          return {};
        }
        holdForComposer(path, editorText, room);
        return { editorText };
      } finally {
        moving.current.delete(path);
      }
    };

    return {
      openSession: (path) => guard(() => readScoped === readState && mainPath(readState().destination) !== path
        ? destination.openSession(path) : openSession(path, { select: false })).then(() => undefined),
      goTab: (tab) => guard(() => destination.goTab(tab)).then(() => undefined),
      goProject: (cwd) => guard(() => destination.goProject(cwd)).then(() => undefined),
      retryDestination: () => guard(() => destination.retry()).then(() => undefined),
      leaveSession: () => destination.leave(),
      newSession: (cwd, options) => readScoped === readState ? destination.newSession(cwd, options) : launchSession(cwd, { ...options, select: false }),
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
          return Boolean(moved);
        }).then(Boolean),
      refreshSessions,
      loadMoreSessions: (cwd) => catalogLoader.more(cwd),
      allSessionSummaries: () => catalogLoader.all(),
      expandCatalog: () => {
        const release = catalogLoader.expand();
        void catalogLoader.refresh().catch(onError);
        return () => { release(); void refreshSessions(); };
      },
      refreshEntries: (options) =>
        guard(async () => {
          // The whole tree, every branch and every version, is the largest read
          // this window makes; under pressure it is the one thing it will not
          // start (RP-8 step 7). Refused before anything is asked for, so no
          // request is sent and nothing here changes. A manual refresh is not
          // an exception to the policy — there is no way to force it.
          if (!options?.tail) refuseWholeTranscript();
          const path = requireCurrent();
          if (moving.current.has(path)) return;
          const epoch = openEpochs.current.get(path);
          const accepting = () => !moving.current.has(path) && openEpochs.current.get(path) === epoch;
          if (!options?.tail) { await history.read(path, true, accepting); return; }
          await history.metadata(path, accepting);
        }).then(() => undefined),
      loadAllEntries: () => guard(async () => {
        refuseWholeTranscript();
        const path = requireCurrent();
        const epoch = openEpochs.current.get(path);
        return history.all(path, () => !moving.current.has(path) && openEpochs.current.get(path) === epoch);
      }).then(Boolean),
      /**
       * RP-5b §7: read this conversation's recent history again, to replace
       * what a trim released. A person asking for it is the safest moment
       * there is, so this spends a read even when the stamp already has one.
       */
      reloadRecentHistory: () => guard(async () => {
        const path = requireCurrent();
        const epoch = openEpochs.current.get(path);
        await history.reconcile(path, () => !moving.current.has(path) && openEpochs.current.get(path) === epoch);
        return true;
      }).then(Boolean),
      loadEarlierEntries: () => guard(async () => {
        const path = requireCurrent();
        const epoch = openEpochs.current.get(path);
        return history.earlier(path, () => !moving.current.has(path) && openEpochs.current.get(path) === epoch);
      }).then(Boolean),
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
          return [...[...steering, ...followUp].filter(Boolean).map(text => ({ type: "text" as const, text })), ...messages.flatMap(message => message.content)];
        }).then((content) => content ?? []),
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
        provisional.assertSession(path);
        const { path: moved } = await client.request("pi/session/move", { path, cwd });
        // The host has closed and moved it: the old path has no worker and no
        // file. Drop this side's view and stop following it before the lists
        // are re-read, so nothing here reopens a path that is gone.
        client.untrack(path);
        dispatch({ type: "closeView", path });
        if (readScoped === readState) destination.closeMainView(path);
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
          const unarchivedCount = readState().catalogGroups?.find(group => group.cwd === cwd)?.total
            ?? Math.max(0, (still?.sessionCount ?? 0) - archivedCount);
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
            if (mainCodeProject(readState().destination) === cwd) destination.setCodeProject(undefined);
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
    destination.closeMainView,
    destination.goProject,
    destination.goTab,
    destination.leave,
    destination.newSession,
    destination.openSession,
    destination.replaceMainSession,
    destination.retry,
    launchSession,
    markSeen,
    openSession,
    pressure,
    readState,
    readHistory,
    historyLoader,
    refreshProjects,
    refreshSessions,
  ]);

  const actions = useMemo<LaserActions>(() => buildActions(readState), [buildActions, readState]);

  const actionsRef = useRef<LaserActions>(actions);
  actionsRef.current = actions;

  const prepareProject = useWorkerReadiness({ currentProject, connection: state.connection, sessionsLoaded: state.sessionsLoaded, projects: projectList, client, readState, archive });
  const setCurrentProject = useCallback((cwd: string | undefined) => {
    destination.setCodeProject(cwd);
    prepareProject(cwd);
  }, [destination.setCodeProject, prepareProject]);

  // The host owns the list; a session opened before the list arrives (or in a
  // directory the host has not indexed yet) still gets a rail icon. Via a
  // string key so the array identity survives a delta — it feeds the stable
  // half of the context.
  const projectsKey = useMemo(() => {
    const workspaces = state.agents.snapshot?.workspaces;
    return visibleProjectCwds(projectList, state.sessions, state.open, archive, { exclude: workspaces ? [workspaces.beam, workspaces.chat] : [],
      ...(state.catalogGroups ? { visibleCounts: Object.fromEntries(state.catalogGroups.map(group => [group.cwd, group.total])) } : {}),
    }).join("\n");
  }, [archive, archiveRevision, projectList, state.open, state.sessions, state.catalogGroups, state.agents.snapshot?.workspaces]);
  const projects = useMemo(() => (projectsKey ? projectsKey.split("\n") : []), [projectsKey]);
  const projectInfo = useMemo(() => {
    const map: Record<string, ProjectInfo> = {};
    for (const project of projectList) map[project.cwd] = project;
    return map;
  }, [projectList]);

  // Default Code memory to the first project without selecting an unrelated session.
  useEffect(() => {
    if (currentProject !== undefined || !projects[0]) return;
    const current = readState().destination;
    if (current.intent === 0 && mainCodeProject(current) === undefined && mainPath(current) === undefined) destination.setDefaultCodeProject(projects[0]);
  }, [currentProject, destination.setDefaultCodeProject, projects, readState]);

  // --- runtime ------------------------------------------------------------

  const snapshotStore = useMemo(
    () => createSnapshotStore<RuntimeSnapshot>({ store, client, dispatch, onError, openSession: (path) => openSession(path, { select: false }), setDraft: setComposerDraft, main: true }),
    // eslint-disable-next-line react-hooks/exhaustive-deps -- created once; kept in sync below
    [],
  );

  useEffect(() => {
    snapshotStore.set({ store, client, dispatch, onError, openSession: (path) => openSession(path, { select: false }), setDraft: setComposerDraft, main: true });
  }, [snapshotStore, store, client, dispatch, onError, openSession, setComposerDraft]);

  const initializationTokens = useRef(new Map<number, MainInitializationToken>());

  const threadListAdapter = useMemo(
    () =>
      createThreadListAdapter({
        sessions: () => readState().sessions,
        allSessions: async () => (await client.request("pi/session/list", {})).sessions,
        views: () => readState().open,
        archive,
        creationTarget: destination.creationTarget,
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
          const token = target.intent === undefined ? undefined : initializationTokens.current.get(target.intent);
          if (token) setTimeout(() => destination.finishInitialization(token, path), 0);
          return path;
        },
        renameSession: async (path, name) => {
          // Renaming a row is a mutation on that conversation: it waits for the
          // host's authority exactly as the conversation's own verbs do (RP-11).
          provisional.assertSession(path);
          await client.request("pi/session/rename", { path, name });
        },
        deleteSession: async (path) => {
          provisional.assertSession(path);
          // The delete confirmation left its answer about the child's worktree
          // here; absent, the host keeps it (M13-T42).
          const sessionId = sessionIdOf(path);
          await client.request("pi/session/delete", { path, worktree: takeWorktreeDisposition(path) });
          // A conversation the person deleted loses what this device cached of
          // it: awaited, so the deletion is proved before the caller carries
          // on, and keyed by the session's own opaque id (RP-10).
          if (sessionId) await tailCache.forget({ sessionId });
        },
        loadSession: (path) => openSession(path, { select: false }),
        refreshSessions,
        beginInitialize: (target) => {
          if (target.intent === undefined) return;
          initializationTokens.current.set(target.intent, destination.beginInitialization({ ...target, intent: target.intent }));
        },
        endInitialize: (target) => {
          if (target.intent === undefined) return;
          const token = initializationTokens.current.get(target.intent);
          if (!token) return;
          initializationTokens.current.delete(target.intent);
          destination.endInitialization(token);
        },
      }),
    [archive, client, destination.beginInitialization, destination.creationTarget, destination.endInitialization, destination.finishInitialization, launchSession, openSession, refreshSessions],
  );

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
    threadId: destination.controlledPath,
    onThreadIdChange: destination.onAssistantThreadChange,
    runtimeHook,
  });

  // Keep the thread list in step with the catalog without swapping the adapter
  // (which would drop cached threads and cancel in-flight mutations).
  const signature = useMemo(
    () => threadListSignature(state.sessions, state.open, archive),
    [archive, archiveRevision, state.sessions, state.open],
  );
  // The controller holds selection while assistant-ui adopts a created thread.
  useEffect(() => {
    if (destination.initializing > 0) return;
    void runtime.threads.reload().catch(() => {});
  }, [runtime, signature, destination.initializing]);

  // Identity survives every transcript delta, so a consumer that only reads
  // actions/projects never re-renders while the agent streams.
  const environmentSubtreeKey = useEnvironmentSubtreeKey(state.environment?.environmentKey);

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
      rendererViews: viewCache.counters,
      reserveViewAction: viewCache.reserveAction,
      pressure: pressure.getSnapshot,
      subscribePressure: pressure.subscribe,
    }),
    [actions, archive, client, currentProject, dispatch, pressure, projectInfo, projects, setCurrentProject, startupRestoring, state.destination, trustRequests, viewCache],
  );

  const internals = useMemo<LaserInternals>(
    () => ({ store, client, dispatch, onError, openSession, buildActions, archive, refreshSessions, attach: attachScope, windows }),
    [archive, attachScope, buildActions, client, dispatch, onError, openSession, refreshSessions, store, windows],
  );

  return (
    <LaserStateContext.Provider value={store}>
      <LaserStableContext.Provider value={stable}>
        <LaserInternalsContext.Provider value={internals}>
          <AssistantRuntimeProvider runtime={runtime}>
            <MainLandingDraftBridge destination={state.destination} store={landingDrafts} />
            {/*
              * The screens below are keyed by the environment (RP-13).
              *
              * Logs, MCP, the resource inventory and every other surface that
              * keeps a query, a filter or a fetched page in component state
              * would otherwise carry it from one environment into the next.
              * A switch (or a failure, which is no environment at all) remounts
              * them; a reconnect into the same environment keeps the same key
              * and remounts nothing. This unmounts client-local views only —
              * the host's own work is untouched by a view going away.
              *
              * The first environment is not a change: nothing can have been
              * fetched from anywhere before the connection opens, so a remount
              * there would only throw away this connection's own startup.
              */}
            <Fragment key={environmentSubtreeKey}>{children}</Fragment>
          </AssistantRuntimeProvider>
        </LaserInternalsContext.Provider>
      </LaserStableContext.Provider>
    </LaserStateContext.Provider>
  );
}

class SessionLoadError extends Error {
  constructor(cause: unknown) {
    super(cause instanceof Error ? cause.message : String(cause), { cause });
  }
}

function MainLandingDraftBridge({ destination, store }: { destination: MainDestination; store: ReturnType<typeof createMainLandingDraftStore> }): null {
  useMainLandingDrafts(destination, store);
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
  const readThread = useMemo(() => {
    let previous: { view: SessionView | undefined; openPhase: ReturnType<typeof sessionOpenPhase>;
      connection: AppState["connection"]; destination: MainDestination } | undefined;
    return () => {
      const state = stateStore.getSnapshot();
      const view = path ? state.open[path] : undefined;
      const openPhase = sessionOpenPhase(state, path);
      if (previous && previous.view === view && sameSessionOpenPhase(previous.openPhase, openPhase)
        && previous.connection === state.connection && previous.destination === state.destination) return previous;
      return previous = { view, openPhase, connection: state.connection, destination: state.destination };
    };
  }, [path, stateStore]);
  const { view, openPhase, connection, destination } = useSyncExternalStore(stateStore.subscribe, readThread, readThread);

  // Load + hydrate a thread the first time it becomes the main one. Cheap and
  // idempotent: an already-hydrated view is skipped, and a load the thread list
  // already started is joined rather than duplicated.
  useEffect(() => {
    if (!isMain || !path) return;
    const current = store.getSnapshot();
    if (current.store.getSnapshot().open[path]?.hydrated) return;
    void current.openSession(path).catch(current.onError);
  }, [isMain, path, store]);

  // These are the four inputs projectSessionView consumes. Metadata, optional
  // goal/tray reads and transaction changes neither blank nor re-project history.
  const projection = useMemo(() => projectSessionView(view), [view?.blocks, view?.entries, view?.history, view?.running, view?.dialogs]);
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
    const currentDestination = stateStore.getSnapshot().destination;
    const committedPath = mainPath(currentDestination);
    const initializingThisLanding = path === undefined && resolvedPath !== undefined
      && (committedPath === resolvedPath
        || (committedPath === undefined && initializedIntent.current === currentDestination.intent));
    // assistant-ui can adopt an already-listed, unstarted row into the local
    // landing thread before the controlled destination callback commits it.
    // Permit only that exact eligible row; a prior non-empty conversation can
    // never pass this bridge during a tab switch.
    const physical = path ? stateStore.getSnapshot().sessions.find((session) => session.path === path) : undefined;
    const destinationTab = mainTab(currentDestination);
    const destinationProject = mainCodeProject(currentDestination);
    const adoptingListedLanding = committedPath === undefined && physical?.messageCount === 0
      && sessionKindTab(physical, stateStore.getSnapshot().agents.snapshot?.workspaces ?? {}) === destinationTab
      && (destinationTab === "chat"
        || codeProjectForSession(
          physical,
          stateStore.getSnapshot().sessions,
          stateStore.getSnapshot().agents.runs,
          destinationProject,
        ) === destinationProject);
    if (!isMain || !isMainReady(currentDestination) || (!initializingThisLanding && !adoptingListedLanding && committedPath !== path)) {
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
        openPhase,
      }),
    [assertCanAct, connection, destination, openPhase, messages, path, projection, resolvePath, snapshot, view],
  );

  const runtime = useExternalStoreRuntime<ThreadMessageLike>(adapter);
  useEffect(() => {
    composerRef.current = runtime.thread.composer;
  }, [runtime]);
  // Words this person wrote and nobody else has yet (RP-5). The composer of a
  // thread they are not looking at still holds them, so the session keeps its
  // transcript until they are sent or cleared. An empty composer holds nothing.
  const setDraft = snapshot.setDraft;
  useEffect(() => {
    if (!path || !setDraft) return;
    const composer = runtime.thread.composer;
    const report = () => {
      const state = composer.getState();
      setDraft(path, state.text.trim() !== "" || state.attachments.length > 0
        || firstTurnFromRunConfig(state.runConfig) !== undefined);
    };
    report();
    const stop = composer.subscribe(report);
    return () => {
      stop();
      setDraft(path, false);
    };
  }, [path, runtime, setDraft]);
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
function createScopedStateStore(store: StateStore, path: string | undefined, destination: MainDestination, owner: HistoryWindowOwner): StateStore {
  let source: AppState | undefined;
  let derived: AppState | undefined;
  return {
    presentation: store.presentation,
    getSnapshot: () => {
      // The scope's own loaded transcript, when it is not the surface that owns
      // the canonical one; its session state and questions are still canonical.
      const state = owner.overlay(store.getSnapshot());
      if (state !== source || derived === undefined) {
        source = state;
        derived = { ...state, current: path, destination };
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
  const { store, client, dispatch, onError, openSession, buildActions, archive, refreshSessions, attach, windows } = internals;
  // This scope's identity for as long as it is mounted, so its window survives
  // a StrictMode remount and never collides with another scope's.
  const scopeId = useId();
  const owner = windows.owner(scopeId, path);
  useEffect(() => () => windows.forget(scopeId, path), [windows, scopeId, path]);

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
  const scopedDestination = useMemo<MainDestination>(() => path
    ? { phase: "ready-code", intent: 0, code: { kind: "beam-session", path, returnTo: workspace ? { kind: "project-landing", project: workspace } : { kind: "no-project-landing" } } }
    : { phase: "ready-code", intent: 0, code: workspace ? { kind: "project-landing", project: workspace } : { kind: "no-project-landing" } }, [path, workspace]);
  const scopedStore = useMemo(() => createScopedStateStore(store, path, scopedDestination, owner), [store, path, scopedDestination, owner]);
  const scopedHistory = useMemo(() => createHistoryLoader({
    // A scoped surface shows exactly one conversation: the one it was given.
    isCurrent: (target: string) => target === path,
    get: target => scopedStore.getSnapshot().open[target],
    request: params => client.request("pi/session/entries", params),
    dispatch: owner.dispatch,
    // Generation adoption and watermarks belong to the canonical session.
    adoptEpoch: () => {},
    track: () => {},
  }), [client, owner, path, scopedStore]);

  const stable = useMemo<LaserStable>(() => ({
    ...parent,
    destination: scopedDestination,
    ...(workspace !== undefined ? { currentProject: workspace } : {}),
    actions: buildActions(scopedStore.getSnapshot, scopedHistory),
  }), [parent, buildActions, scopedDestination, scopedHistory, scopedStore, workspace]);
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
        allSessions: async () => (await client.request("pi/session/list", {})).sessions,
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
          // The same conversation-addressed fence a scope can answer for
          // itself: what is painted from this device is shared state (RP-11).
          const refusal = sessionAuthorityRefusal(scopedStore.getSnapshot(), target);
          if (refusal) throw new Error(refusal);
          await client.request("pi/session/rename", { path: target, name });
        },
        deleteSession: async (target) => {
          const refusal = sessionAuthorityRefusal(scopedStore.getSnapshot(), target);
          if (refusal) throw new Error(refusal);
          // The scope's own snapshot owns the path ↔ opaque id mapping here,
          // for the same reason the main window's does (RP-10).
          const snapshot = scopedStore.getSnapshot();
          const sessionId = snapshot.open[target]?.state.id ?? snapshot.sessions.find((summary) => summary.path === target)?.id;
          await client.request("pi/session/delete", { path: target, worktree: takeWorktreeDisposition(target) });
          if (sessionId) await tailCache.forget({ sessionId });
        },
        loadSession: (target) =>
          openSession(target, { select: false }).then(async () => {
            // Opening a conversation in this scope starts at its recent tail,
            // whatever this or another surface had paged in before.
            if (target === pathRef.current) await scopedHistory.recent(target, () => target === pathRef.current);
          }).catch((error: unknown) => {
            // The remembered session is gone: start fresh rather than sit on a
            // thread that cannot load.
            if (target === pathRef.current) onPathChangeRef.current(undefined);
            throw error;
          }),
        refreshSessions,
        beginInitialize: () => setInitializing((n) => n + 1),
        endInitialize: () => setInitializing((n) => Math.max(0, n - 1)),
      }),
    [archive, client, openSession, refreshSessions, scopedHistory, sessions, store, views],
  );

  const snapshotStore = useMemo(
    () => createSnapshotStore<RuntimeSnapshot>({ store: scopedStore, client, dispatch, onError: scopedOnError, openSession: (target) => openSession(target, { select: false }) }),
    // eslint-disable-next-line react-hooks/exhaustive-deps -- created once; kept in sync below
    [],
  );
  // On `scopedStore`, not on `path`: the scope's store is also rebuilt when its
  // workspace changes under the same session, and the per-thread runtime reads
  // its destination through this snapshot. Depending on the inputs instead of
  // the store left it on the one built before the workspace arrived.
  useEffect(() => {
    snapshotStore.set({ store: scopedStore, client, dispatch, onError: scopedOnError, openSession: (target) => openSession(target, { select: false }) });
  }, [snapshotStore, scopedStore, client, dispatch, scopedOnError, openSession]);

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
  const path = useLaserState((s) => s.current);
  const session = useLaserState((s) => s.current ? s.open[s.current]?.state : undefined);
  const running = useLaserState((s) => s.current ? s.open[s.current]?.running ?? false : false);
  const connection = useLaserState((s) => s.connection);
  const worker = useLaserState((s) => session ? s.workers[session.cwd] : undefined);
  return useMemo(
    () => ({
      path: session ? path : undefined,
      session,
      model: session?.model ?? null,
      thinkingLevel: session?.thinkingLevel,
      contextUsage: session?.contextUsage,
      running,
      compacting: session?.isCompacting ?? false,
      connection,
      worker,
    }),
    [connection, path, session, running, worker],
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
