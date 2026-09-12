/**
 * App state and the reducer that folds protocol notifications into it.
 * Pure: no React, no DOM. Tested in test/store.test.ts.
 *
 * Transcript blocks are assembled from message/tool events (Pi emits
 * `entry_appended` only for extension custom entries, so it is not the source
 * of transcript state). Past sessions hydrate from `pi/session/entries`.
 */
import { AGENT_EVENT_MESSAGE_TYPE, SESSION_FALLBACK_ENTRY_TYPE, SESSION_RUN_ENTRY_TYPE, TASK_EVENT_MESSAGE_TYPE, failureWording, isTerminalRunStatus } from "@lasercode/protocol";
import { imagesOfContent, splitAttachedFiles, type AttachedFile } from "./runtime/attachments.js";
import type {
  ImageContent,
  HistoryWindow,
  AgentEvent,
  BackgroundTask,
  AgentModelChoice,
  AgentRun,
  AgentsSnapshot,
  HostNotificationMethod,
  HostNotifications,
  MessageSpeaker,
  PendingMessage,
  PiExtensionModuleName,
  SessionState,
  SessionGoal,
  SessionSummary,
  SessionUpdate,
  StopReason,
  UiDialogRequest,
  UiFireAndForget,
  Usage,
} from "@lasercode/protocol";

import { activePathIds } from "./components/thread/entries.js";
import { initialMainDestination, mainPath, type MainDestination } from "./runtime/main-destination.js";
import { receiveHistoryUpdate, reduceHistory, type HistoryAction } from "./runtime/history-loader.js";

/**
 * A user message a parent agent put into this child session, rather than the
 * person at the keyboard: the opening task, or a later `send_agent_message`
 * (docs/agents.md "Follow-up messages and user-origin runs").
 *
 * The harness records it durably in the child's own file — a
 * `lasercode/agent-run` custom entry with `moment: "started"`, written
 * immediately before the child is prompted — so the attribution is rebuilt
 * from disk after a reload or a host restart, never guessed from the text.
 * A message a person typed into a child carries none of this: those runs have
 * `origin: "user"` and no marker.
 */
export interface SentByParent {
  /** The parent session's file path — the identity the header's parent control already opens. */
  parentPath: string;
  /** The run this task started, when the marker named one. */
  runId?: string;
}

/**
 * `at` is the ISO timestamp the block first appeared (from the notification's
 * `at`, or the persisted entry's `timestamp`). Optional: a block assembled by
 * `applyUpdate` outside the reducer has none.
 */
export type Block =
  | {
      kind: "user";
      id: string;
      at?: string;
      text: string;
      images: ImageContent[];
      files: AttachedFile[];
      optimistic?: boolean;
      sentBy?: SentByParent;
      /**
       * Pi's entry for this prompt, stamped when it was persisted (its own
       * `message_end`, or the entry it was rebuilt from). Absent only for a
       * prompt the engine has not written yet, and for one an older worker
       * reported without it — the ordinal lookup in `thread/entries.ts` covers
       * that case.
       */
      entryId?: string;
    }
  | {
      kind: "assistant";
      id: string;
      at?: string;
      text: string;
      thinking: string;
      streaming: boolean;
      /**
       * Why this turn ended, from `message_end`. `stop` and `toolUse` are the
       * ordinary endings; anything else is a turn that stopped short and the
       * transcript says so out loud.
       */
      stopReason?: StopReason;
      /** The provider's own words when `stopReason` is `error`. */
      errorMessage?: string;
      /** This one turn's token counts. Never a running total. */
      usage?: Usage;
      /** Set only when something other than the session's own agent spoke. */
      speaker?: MessageSpeaker;
    }
  | { kind: "tool"; id: string; at?: string; name: string; args: unknown; partial?: string; result?: unknown; isError?: boolean; done: boolean }
  | { kind: "notice"; id: string; at?: string; level: "info" | "warning" | "error"; text: string }
  /**
   * A custom message the transcript draws itself (Lane U2, agents leap): an
   * agent event a parent received (`lasercode/agent-event`) or a background
   * task's exit (`lasercode/task-event`). `details` is the structured payload
   * the module attached; `text` is the block the model read. Only the types in
   * {@link CUSTOM_MESSAGE_BLOCK_TYPES} become blocks; every other custom
   * message stays invisible, as before.
   */
  | { kind: "custom"; id: string; at?: string; customType: string; text: string; details: unknown };

/** Custom message types that render as transcript blocks. */
export const CUSTOM_MESSAGE_BLOCK_TYPES: ReadonlySet<string> = new Set([AGENT_EVENT_MESSAGE_TYPE, TASK_EVENT_MESSAGE_TYPE]);

export interface SessionView {
  path: string;
  state: SessionState;
  blocks: Block[];
  lastSeq: number;
  updateEpoch?: string | undefined;
  running: boolean;
  queue: { steering: string[]; followUp: string[] };
  /**
   * The pending tray: what the person wrote while the agent was working, in
   * order, with an id each (`@lasercode/protocol` `pending.ts`). Laser's own
   * list, so a row can be steered, edited or dropped on its own; the engine's
   * `queue` above holds only what has already been steered into it.
   */
  pending: PendingMessage[];
  dialogs: UiDialogRequest[];
  statuses: Record<string, string>;
  widgets: Record<string, { lines: string[]; placement: "aboveEditor" | "belowEditor" }>;
  title?: string;
  editorText?: string;
  /**
   * When this view was first opened. Stands in for `createdAt`/`modifiedAt`
   * while the session is not yet in the catalog (Pi writes the file on the
   * first message); a wall-clock read at use time would make every derived
   * list — and the thread-list signature — change on every render.
   */
  openedAt: string;
  hydrated: boolean;
  /** Loaded entries; history distinguishes incomplete messages from unloaded versions. */
  entries: unknown[];
  history?: Omit<HistoryWindow, "live"> | undefined;
  /** Accepted updates buffered only while an authoritative window read is in flight. */
  historyPending?: { token: string; updates: HostNotifications["session/update"][] } | undefined;
  /**
   * The entry the session is sitting on. The conversation is the path from the
   * root to it; anything off that path is a version the person can go back to
   * through the message's version picker. `null` is a leaf reset to before the
   * first entry (editing the opening message); `undefined` is "not told", and
   * then the last entry stands in, as the engine itself does on re-open.
   */
  leafId?: string | null | undefined;
  /**
   * Reviewed engine modules active in this session. The session snapshot is
   * authoritative; later capability notifications keep it current.
   */
  capabilities: PiExtensionModuleName[];
  /** Durable objective for this session, or null when Goal mode is inactive. */
  goal: SessionGoal | null;
  /**
   * Namer's early labels for tool calls still running, by tool call id
   * (`lasercode/namer/label`). A label that does not change leaves the view
   * identity alone, like `capabilities`.
   */
  namerLabels: Record<string, string>;
  /**
   * The MCP servers this session started with, in snapshot order
   * (`lasercode/mcp/status`, docs/mcp.md). A transcript reads it to know that
   * `playwright_browser_navigate` is Playwright's own tool rather than a tool
   * nobody recognises. Absent until the companion reports, and never emptied
   * by the shutdown snapshot: a session being read back would otherwise lose
   * the names its rows are drawn from.
   */
  mcpServers?: readonly string[];
  /**
   * The attribution the next parent-sent user message gets, live. The harness
   * writes its durable marker straight to the session file, which raises no
   * engine event, so a transcript that is already open cannot read it before
   * the next hydration: the `agents/run` notification the harness publishes
   * *before* it prompts the child is the live source instead, and it says the
   * same thing. Cleared when a user block consumes it, and on hydration, where
   * the file's own marker takes over.
   */
  pendingSentBy?: SentByParent | undefined;
}

/**
 * Everything the agents feature holds outside a session: the definitions
 * snapshot, the live run registry and the transient inter-agent moments.
 * Runs and events are keyed by the identities the protocol names — `runId`
 * and the event's own `id` — never by position.
 */
export interface AgentsSlice {
  /** From `agents/list`, kept current by `agents/updated`. */
  snapshot: AgentsSnapshot | null;
  /** True while `agents/list` is in flight. */
  loading: boolean;
  /** The last `agents/list` or `agents/runs/list` failure, written for a person. */
  error: string | null;
  /** Every run the host has told us about, by `runId`. */
  runs: Record<string, AgentRun>;
  /** Newest last, capped at {@link AGENT_EVENTS_MAX}, deduplicated by id. */
  events: AgentEvent[];
  /** `agents/beam/choose-model` is pending until the UI picks or dismisses. */
  chooseBeamModel: { suggested: AgentModelChoice | null } | null;
}

/**
 * Every background command the host knows about, by task id. One flat map
 * rather than a per-session one: the fleet shows work across sessions, and a
 * task's own `sessionPath` is what groups it (docs/ux-fleet.md).
 */
export interface TasksSlice {
  tasks: Record<string, BackgroundTask>;
  /** Sessions whose `tasks/list` has landed, so an empty fleet group is real. */
  listed: string[];
}

export const initialTasks: TasksSlice = { tasks: {}, listed: [] };

/** Bubbles are transient; anything older than the newest hundred is history the transcript already holds. */
export const AGENT_EVENTS_MAX = 100;

export const initialAgents: AgentsSlice = {
  snapshot: null,
  loading: false,
  error: null,
  runs: {},
  events: [],
  chooseBeamModel: null,
};

export interface AppState {
  versionMismatch?: string;
  connection: "connecting" | "open" | "closed";
  sessions: SessionSummary[];
  catalogGroups?: Array<{ cwd: string; total: number; cursor?: string }>;
  archivedSessionCount?: number;
  catalogPresence?: Record<string, boolean> | undefined;
  /** True once a `pi/session/list` has landed, so an empty list is real. */
  sessionsLoaded: boolean;
  open: Record<string, SessionView>;
  /** Also covers the interval before session/load creates a view. */
  sessionLoads: Record<string, { phase: "opening" | "failed"; reason?: string | undefined }>;
  /** Read projection of `destination.path`; scoped runtimes overlay only this field. */
  current: string | undefined;
  /** The sole tab/project/session intent for the main window. */
  destination: MainDestination;
  workers: Record<string, { status: string; message?: string }>;
  toasts: Array<{ id: number; level: "info" | "warning" | "error"; text: string }>;
  agents: AgentsSlice;
  /** Background commands agents left running (docs/ux-fleet.md). */
  tasks: TasksSlice;
}

export const initialState: AppState = {
  connection: "closed",
  sessions: [],
  sessionsLoaded: false,
  open: {},
  sessionLoads: {},
  current: undefined,
  destination: initialMainDestination,
  workers: {},
  toasts: [],
  agents: initialAgents,
  tasks: initialTasks,
};

export type Action =
  | { type: "versionMismatch"; version: string }
  | { type: "connection"; state: AppState["connection"] }
  | { type: "sessions"; sessions: SessionSummary[]; groups?: Array<{ cwd: string; total: number; cursor?: string }>; archivedCount?: number; presence?: Record<string, boolean> }
  /** Loading/creation warms a view only; only the destination controller selects. */
  | { type: "opened"; state: SessionState }
  | { type: "sessionLoad"; path: string; phase: "opening" | "ready"; reason?: never }
  | { type: "sessionLoad"; path: string; phase: "error"; reason: string }
  /** Controller-owned atomic main-window transition; `current` is its projection. */
  | { type: "destination"; destination: MainDestination }
  | { type: "closeView"; path: string }
  /**
   * Replace the transcript from a persisted snapshot. `expectSeq` guards the
   * round trip: when live updates advanced `lastSeq` while `pi/session/entries`
   * was in flight the snapshot is stale, so only `entries` is refreshed and the
   * live blocks are kept.
   *
   * `seq` is the worker's watermark for the session when it handed the snapshot
   * over (`session/load`'s `seq`). Stamping it is what makes the *next* open ask
   * for the updates it is actually missing: a view left at 0 asks from 0 and the
   * worker replays its whole buffer on top of the transcript already on screen.
   * It only ever raises the watermark, so an update that overtook the snapshot
   * still wins.
   */
  | { type: "hydrate"; path: string; entries: unknown[]; leafId?: string | null | undefined; expectSeq?: number; seq?: number }
  | { type: "entries"; path: string; entries: unknown[]; leafId?: string | null | undefined }
  | HistoryAction
  | { type: "goal"; path: string; goal: SessionGoal | null }
  /** `session/pending/list`, applied only if no newer tray update replaced the captured reference. */
  | { type: "pending"; path: string; messages: PendingMessage[]; expectPending: PendingMessage[] }
  /**
   * The worker that owns this session restarted its per-process `seq` counter
   * (worker crash, host restart). Adopt the new epoch and re-hydrate, or every
   * later update is deduped away as a "replay" (see `applyNotification`).
   */
  | { type: "resync"; path: string; lastSeq: number }
  | { type: "forked"; from: string; state: SessionState }
  | { type: "optimisticUser"; path: string; text: string; images: ImageContent[]; id?: string }
  /** A prompt never reached the worker: drop the block that stood in for it. */
  | { type: "optimisticFailed"; path: string; id: string }
  | { type: "dialogAnswered"; id: string; path?: string }
  /** The composer took `view.editorText`; it must not be applied twice. */
  | { type: "editorTextTaken"; path: string }
  | { type: "toast"; level: "info" | "warning" | "error"; text: string }
  | { type: "notification"; method: HostNotificationMethod; params: HostNotifications[HostNotificationMethod] }
  | { type: "dismissToast"; id: number }
  // --- agents ---
  /** `agents/list` is in flight. */
  | { type: "agents/loading" }
  /** `agents/list` landed: authoritative, replaces whatever revision we held. */
  | { type: "agents/loaded"; snapshot: AgentsSnapshot }
  /** `agents/updated`, or the snapshot inside a mutation's result. Older revisions are ignored. */
  | { type: "agents/updated"; snapshot: AgentsSnapshot }
  | { type: "agents/run"; run: AgentRun }
  /**
   * `agents/runs/list`. Without `path` the list is the whole registry; with it,
   * only the tree containing `path`, so runs of other trees are kept.
   */
  | { type: "agents/runs/loaded"; runs: AgentRun[]; path?: string }
  | { type: "agents/event"; event: AgentEvent }
  | { type: "agents/choose-beam-model"; suggested: AgentModelChoice | null }
  | { type: "agents/choose-beam-model/clear" }
  | { type: "agents/error"; error: string }
  // --- background tasks ---
  | { type: "tasks/update"; task: BackgroundTask }
  /** `tasks/list`. Without `path` the list is every session's. */
  | { type: "tasks/loaded"; tasks: BackgroundTask[]; path?: string };

let blockCounter = 0;
let toastCounter = 0;
const nextBlockId = () => `b${++blockCounter}`;

/**
 * Mint a block id outside the reducer, so a caller that dispatches an
 * optimistic block can also address it later (`optimisticFailed`).
 */
export function newBlockId(): string {
  return nextBlockId();
}

const historyFold = { applyUpdate, blocksFromEntries, modelNamesOf, stampNewBlocks, textOf };

export function reduce(state: AppState, action: Action): AppState {
  switch (action.type) {
    case "connection":
      return { ...state, connection: action.state };
    case "versionMismatch":
      return { ...state, versionMismatch: action.version };
    case "sessions":
      return { ...state, sessions: action.sessions.map(summary => summary.firstMessage ? { ...summary, firstMessage: summary.firstMessage.split(/(?:^|\s)<attached-file\b/)[0]!.trim() } : summary), sessionsLoaded: true,
        ...(action.groups ? { catalogGroups: action.groups, catalogPresence: action.groups.length ? action.presence ?? {} : undefined } : {}),
        ...(action.archivedCount !== undefined ? { archivedSessionCount: action.archivedCount } : {}),
      };
    case "sessionLoad": {
      const { [action.path]: _previous, ...rest } = state.sessionLoads;
      return { ...state, sessionLoads: action.phase === "ready" ? rest : {
        ...rest, [action.path]: { phase: action.phase === "error" ? "failed" : "opening", reason: action.reason },
      } };
    }
    case "opened": {
      const existing = state.open[action.state.path];
      const capabilities = action.state.capabilities ?? existing?.capabilities ?? [];
      const view: SessionView = existing
        ? { ...existing, state: action.state, capabilities }
        : {
            path: action.state.path,
            state: action.state,
            blocks: [],
            lastSeq: 0,
            running: action.state.isStreaming,
            queue: { steering: [], followUp: [] },
            pending: [],
            dialogs: [],
            statuses: {},
            widgets: {},
            openedAt: new Date().toISOString(),
            hydrated: false,
            entries: [],
            capabilities,
            goal: null,
            namerLabels: {},
          };
      return { ...state, open: { ...state.open, [view.path]: view } };
    }
    case "forked": {
      // The old view's live state moved to a new path; carry the transcript over.
      const old = state.open[action.from];
      const { [action.from]: _gone, ...rest } = state.open;
      const prepared = state.open[action.state.path];
      const view: SessionView = prepared?.hydrated ? { ...prepared, state: action.state } : old
        ? { ...old, path: action.state.path, state: action.state, lastSeq: 0, hydrated: false, entries: [], history: undefined, historyPending: undefined, goal: null }
        : { path: action.state.path, state: action.state, blocks: [], lastSeq: 0, running: false, queue: { steering: [], followUp: [] }, pending: [], dialogs: [], statuses: {}, widgets: {}, openedAt: new Date().toISOString(), hydrated: false, entries: [], capabilities: [], goal: null, namerLabels: {} };
      return { ...state, open: { ...rest, [view.path]: view } };
    }
    case "destination":
      return { ...state, destination: action.destination, current: mainPath(action.destination) };
    case "closeView": {
      const { [action.path]: _gone, ...rest } = state.open;
      const { [action.path]: _load, ...sessionLoads } = state.sessionLoads;
      return { ...state, open: rest, sessionLoads };
    }
    case "historyBegin":
    case "historyEnd":
    case "historySnapshot":
    case "historyMetadata":
    case "historyPrepend":
      return updateView(state, action.path, v => reduceHistory(v, action, historyFold));
    case "hydrate":
      return updateView(state, action.path, (v) => {
        // The snapshot came from the worker at `seq`; a live update that
        // overtook it is further ahead, so the watermark never goes backwards.
        const lastSeq = action.seq !== undefined && action.seq > v.lastSeq ? action.seq : v.lastSeq;
        // Live updates landed while the snapshot was in flight: they already
        // carry what the snapshot has, plus what it does not.
        return action.expectSeq !== undefined && v.lastSeq !== action.expectSeq
          ? { ...v, entries: action.entries, leafId: action.leafId, history: undefined, historyPending: undefined, hydrated: true, lastSeq }
          : { ...v, blocks: blocksFromEntries(action.entries, action.leafId, modelNamesOf(v.state)), entries: action.entries, leafId: action.leafId, history: undefined, historyPending: undefined, hydrated: true, pendingSentBy: undefined, lastSeq };
      });
    case "entries":
      return updateView(state, action.path, (v) => ({ ...v, entries: action.entries, leafId: action.leafId }));
    case "goal":
      return updateView(state, action.path, (v) => ({ ...v, goal: action.goal }));
    case "editorTextTaken":
      return updateView(state, action.path, (v) => {
        if (v.editorText === undefined) return v;
        const { editorText: _taken, ...rest } = v;
        return rest as typeof v;
      });
    case "resync":
      return updateView(state, action.path, (v) =>
        v.lastSeq <= action.lastSeq ? v : { ...v, lastSeq: action.lastSeq, hydrated: false },
      );
    case "optimisticUser":
      return updateView(state, action.path, (v) => ({
        ...v,
        blocks: [
          ...v.blocks,
          { kind: "user", id: action.id ?? nextBlockId(), ...splitAttachedFiles(action.text), images: action.images, optimistic: true },
        ],
      }));
    case "optimisticFailed":
      return updateView(state, action.path, (v) => {
        const index = v.blocks.findIndex((b) => b.id === action.id && b.kind === "user" && b.optimistic === true);
        return index === -1 ? v : { ...v, blocks: [...v.blocks.slice(0, index), ...v.blocks.slice(index + 1)] };
      });
    case "dismissToast":
      return { ...state, toasts: state.toasts.filter((t) => t.id !== action.id) };
    case "toast":
      return pushToast(state, action.level, action.text);
    case "dialogAnswered": {
      const drop = (v: SessionView): SessionView =>
        v.dialogs.some((d) => d.id === action.id) ? { ...v, dialogs: v.dialogs.filter((d) => d.id !== action.id) } : v;
      // Dialog ids are only unique per session; scope the removal when the
      // caller knows which session raised it.
      if (action.path !== undefined) return updateView(state, action.path, drop);
      const open: Record<string, SessionView> = {};
      for (const [path, v] of Object.entries(state.open)) open[path] = drop(v);
      return { ...state, open };
    }
    case "pending":
      return updateView(state, action.path, (v) => {
        // A numbered pending_update can overtake the opening list request. The
        // array reference is its watermark: unrelated view updates preserve it,
        // while every real tray change replaces it, including newer `[]`.
        if (v.pending !== action.expectPending) return v;
        return v.pending.length === 0 && action.messages.length === 0 ? v : { ...v, pending: displayPending(action.messages) };
      });
    case "notification":
      return applyNotification(state, action.method, action.params);
    case "agents/loading":
      return updateAgents(state, (a) => (a.loading ? a : { ...a, loading: true }));
    case "agents/loaded":
      return updateAgents(state, (a) => ({ ...a, snapshot: action.snapshot, loading: false, error: null }));
    case "agents/updated":
      return updateAgents(state, (a) =>
        // A broadcast and a mutation result can cross on the wire; the revision
        // says which one is the truth. Equal revisions replace, so a snapshot
        // that carries fresher warnings under the same number still lands.
        a.snapshot && a.snapshot.revision > action.snapshot.revision ? a : { ...a, snapshot: action.snapshot },
      );
    case "agents/run": {
      // The first time we hear of a run is the only time it can be the start
      // of one; every later publication is activity on a run we already know.
      const first = state.agents.runs[action.run.runId] === undefined;
      const next = updateAgents(state, (a) => {
        const existing = a.runs[action.run.runId];
        if (existing && (sameRun(existing, action.run) || isOlderRun(action.run, existing))) return a;
        return { ...a, runs: { ...a.runs, [action.run.runId]: action.run } };
      });
      return first ? expectParentTask(next, action.run) : next;
    }
    case "agents/runs/loaded":
      return updateAgents(state, (a) => ({ ...a, error: null, runs: mergeRuns(a.runs, action.runs, action.path) }));
    case "agents/event":
      return updateAgents(state, (a) => {
        if (a.events.some((e) => e.id === action.event.id)) return a;
        const events = [...a.events, action.event];
        return { ...a, events: events.length > AGENT_EVENTS_MAX ? events.slice(events.length - AGENT_EVENTS_MAX) : events };
      });
    case "agents/choose-beam-model":
      return updateAgents(state, (a) => ({ ...a, chooseBeamModel: { suggested: action.suggested } }));
    case "agents/choose-beam-model/clear":
      return updateAgents(state, (a) => (a.chooseBeamModel === null ? a : { ...a, chooseBeamModel: null }));
    case "agents/error":
      return updateAgents(state, (a) => ({ ...a, loading: false, error: action.error }));
    case "tasks/update":
      return updateTasks(state, (t) => {
        const existing = t.tasks[action.task.id];
        if (existing && sameTask(existing, action.task)) return t;
        return { ...t, tasks: { ...t.tasks, [action.task.id]: action.task } };
      });
    case "tasks/loaded":
      return updateTasks(state, (t) => {
        // The host's list is the truth for the range it covers: a task it no
        // longer holds is gone, not hidden.
        const next: Record<string, BackgroundTask> = {};
        for (const [id, task] of Object.entries(t.tasks)) {
          if (action.path === undefined || task.sessionPath === action.path) continue;
          next[id] = task;
        }
        for (const task of action.tasks) next[task.id] = task;
        const listed = action.path === undefined
          ? [...new Set(action.tasks.map((task) => task.sessionPath))]
          : t.listed.includes(action.path) ? t.listed : [...t.listed, action.path];
        return { ...t, tasks: next, listed };
      });
  }
}

function updateView(state: AppState, path: string, fn: (v: SessionView) => SessionView): AppState {
  const view = state.open[path];
  if (!view) return state;
  const next = fn(view);
  // A reducer that returns the same view must not produce a new state object,
  // or every no-op notification re-renders every subscriber.
  return next === view ? state : { ...state, open: { ...state.open, [path]: next } };
}

/**
 * A run a parent just started on a session we hold open: the prompt that
 * carries its task has not arrived yet, so arm the attribution for it. A run
 * the person started (`origin: "user"`) is their own message and gets none,
 * and a run that is already over never had a live prompt to attribute.
 */
function expectParentTask(state: AppState, run: AgentRun): AppState {
  if (run.origin !== "agent" || !run.parent || isTerminalRunStatus(run.status)) return state;
  const sentBy: SentByParent = { parentPath: run.parent.sessionPath, runId: run.runId };
  return updateView(state, run.sessionPath, (v) => ({ ...v, pendingSentBy: sentBy }));
}

function updateAgents(state: AppState, fn: (a: AgentsSlice) => AgentsSlice): AppState {
  const next = fn(state.agents);
  return next === state.agents ? state : { ...state, agents: next };
}

function updateTasks(state: AppState, fn: (t: TasksSlice) => TasksSlice): AppState {
  const next = fn(state.tasks);
  return next === state.tasks ? state : { ...state, tasks: next };
}

/**
 * The fields a re-sent task could differ in. A task that grew no bytes and
 * changed no state keeps the store identity, so a chatty running command does
 * not re-render the fleet on every heartbeat.
 */
function sameTask(a: BackgroundTask, b: BackgroundTask): boolean {
  return (
    a.status === b.status &&
    a.outputBytes === b.outputBytes &&
    a.activity === b.activity &&
    a.endedAt === b.endedAt &&
    a.exitCode === b.exitCode &&
    a.terminalReason === b.terminalReason &&
    a.error === b.error &&
    a.title === b.title
  );
}

const runTime = (value: string | undefined): number => {
  const time = value === undefined ? Number.NaN : Date.parse(value);
  return Number.isNaN(time) ? 0 : time;
};

/** A replayed or reordered notification must never rewind a run. */
function isOlderRun(incoming: AgentRun, existing: AgentRun): boolean {
  return runTime(incoming.updatedAt) < runTime(existing.updatedAt);
}

/** The fields a re-sent run could differ in; identical ones keep the store identity. */
function sameRun(a: AgentRun, b: AgentRun): boolean {
  return (
    a.status === b.status &&
    a.updatedAt === b.updatedAt &&
    a.endedAt === b.endedAt &&
    a.error === b.error &&
    a.result?.status === b.result?.status &&
    a.result?.message === b.result?.message &&
    a.endedBy?.initiator === b.endedBy?.initiator &&
    a.endedBy?.reason === b.endedBy?.reason &&
    a.activity?.lastAt === b.activity?.lastAt &&
    a.activity?.currentTool === b.activity?.currentTool &&
    a.activity?.label === b.activity?.label &&
    a.activity?.turns === b.activity?.turns &&
    a.activity?.tools === b.activity?.tools &&
    a.worktree?.path === b.worktree?.path &&
    a.cwd === b.cwd &&
    a.model?.id === b.model?.id &&
    a.model?.provider === b.model?.provider
  );
}

/**
 * Fold an `agents/runs/list` answer into the registry. The host's list is the
 * truth for the range it covers — the whole registry, or one tree — except
 * where a live notification already moved a run past what the list says.
 */
function mergeRuns(current: Record<string, AgentRun>, listed: AgentRun[], scope: string | undefined): Record<string, AgentRun> {
  const root = scope === undefined ? undefined : rootOfScope(current, listed, scope);
  const next: Record<string, AgentRun> = {};
  if (root !== undefined) {
    for (const [id, run] of Object.entries(current)) if (run.rootSessionPath !== root) next[id] = run;
  }
  for (const run of listed) {
    const existing = current[run.runId];
    next[run.runId] = existing && isOlderRun(run, existing) ? existing : run;
  }
  return next;
}

/** The root of the tree a scoped list covers: from the list, else from what we hold, else the path itself. */
function rootOfScope(current: Record<string, AgentRun>, listed: AgentRun[], scope: string): string {
  const fromList = listed[0]?.rootSessionPath;
  if (fromList !== undefined) return fromList;
  for (const run of Object.values(current)) {
    if (run.sessionPath === scope) return run.rootSessionPath;
    if (run.rootSessionPath === scope) return scope;
  }
  return scope;
}

function applyNotification(state: AppState, method: HostNotificationMethod, params: unknown): AppState {
  switch (method) {
    case "session/update": {
      const p = params as HostNotifications["session/update"];
      return updateView(state, p.sessionPath, v => receiveHistoryUpdate(v, p, historyFold));
    }
    case "pi/ui/request": {
      const p = params as HostNotifications["pi/ui/request"];
      const { path, ...request } = p;
      return updateView(state, path, (v) =>
        v.dialogs.some((d) => d.id === request.id) ? v : { ...v, dialogs: [...v.dialogs, request as UiDialogRequest] },
      );
    }
    case "pi/ui/event": {
      const p = params as HostNotifications["pi/ui/event"];
      const { path, ...event } = p;
      return applyUiEvent(state, path, event as UiFireAndForget);
    }
    case "pi/extension/message": {
      const p = params as HostNotifications["pi/extension/message"];
      if (p.message.type === "lasercode/capabilities") {
        const active = p.message.active;
        return updateView(state, p.path, (v) =>
          v.capabilities.length === active.length && active.every((m, i) => v.capabilities[i] === m)
            ? v
            : { ...v, capabilities: [...active] },
        );
      }
      if (p.message.type === "lasercode/goal/state") {
        const goal = p.message.goal;
        return updateView(state, p.path, (v) => ({ ...v, goal }));
      }
      if (p.message.type === "lasercode/account-usage/state") {
        const accountUsage = p.message.state;
        return updateView(state, p.path, (v) => ({
          ...v,
          state: { ...v.state, accountUsage },
        }));
      }
      if (p.message.type === "lasercode/module/log" && p.message.level === "error") {
        return pushToast(state, "error", `${p.message.module}: ${p.message.message}`);
      }
      if (p.message.type === "lasercode/mcp/status") {
        const names = p.message.snapshot.servers.map((server) => server.name);
        // An empty snapshot is "this session has no MCP" — which is also what
        // shutdown reports. Keeping the last non-empty list means closing a
        // session never un-names the rows already on screen.
        if (names.length === 0) return state;
        return updateView(state, p.path, (v) =>
          v.mcpServers !== undefined && v.mcpServers.length === names.length && names.every((n, i) => v.mcpServers![i] === n)
            ? v
            : { ...v, mcpServers: names },
        );
      }
      if (p.message.type === "lasercode/namer/label") {
        const { toolCallId, label } = p.message;
        return updateView(state, p.path, (v) =>
          v.namerLabels[toolCallId] === label ? v : { ...v, namerLabels: { ...v.namerLabels, [toolCallId]: label } },
        );
      }
      return state;
    }
    case "pi/worker/status": {
      const p = params as HostNotifications["pi/worker/status"];
      const next = { ...state, workers: { ...state.workers, [p.cwd]: { status: p.status, ...(p.message ? { message: p.message } : {}) } } };
      return p.status === "crashed" ? pushToast(next, "error", `Worker for ${p.cwd} crashed: ${p.message ?? ""}`) : next;
    }
    case "agents/updated":
      return reduce(state, { type: "agents/updated", snapshot: params as HostNotifications["agents/updated"] });
    case "agents/run":
      return reduce(state, { type: "agents/run", run: (params as HostNotifications["agents/run"]).run });
    case "agents/event":
      return reduce(state, { type: "agents/event", event: params as HostNotifications["agents/event"] });
    case "agents/beam/choose-model":
      return reduce(state, { type: "agents/choose-beam-model", suggested: (params as HostNotifications["agents/beam/choose-model"]).suggested });
    case "tasks/update":
      return reduce(state, { type: "tasks/update", task: (params as HostNotifications["tasks/update"]).task });
    default:
      return state;
  }
}

/**
 * Stamp `at` on blocks the update just appended. Blocks are append-only, so the
 * only candidates are the ones past `before.length`; the common delta (same
 * length, same tail id) does no work at all.
 */
export function stampNewBlocks(before: Block[], after: Block[], at: string): Block[] {
  if (before === after || !at) return after;
  if (after.length <= before.length) return after;
  let changed = false;
  const next = after.slice();
  for (let i = before.length; i < next.length; i++) {
    const b = next[i]!;
    if (b.at !== undefined) continue;
    next[i] = { ...b, at };
    changed = true;
  }
  return changed ? next : after;
}

function pushToast(state: AppState, level: "info" | "warning" | "error", text: string): AppState {
  return { ...state, toasts: [...state.toasts, { id: ++toastCounter, level, text }] };
}

function applyUiEvent(state: AppState, path: string, event: UiFireAndForget): AppState {
  switch (event.method) {
    // The worker settled a pending dialog without us (timeout, abort, session
    // end). Drop it so the card/tool footer disappears instead of hanging.
    case "dialogResolved":
      return updateView(state, path, (v) =>
        v.dialogs.some((d) => d.id === event.id) ? { ...v, dialogs: v.dialogs.filter((d) => d.id !== event.id) } : v,
      );
    case "notify":
      return pushToast(state, event.level, event.message);
    case "setStatus":
      return updateView(state, path, (v) => {
        const statuses = { ...v.statuses };
        if (event.text === undefined) delete statuses[event.key];
        else statuses[event.key] = event.text;
        return { ...v, statuses };
      });
    case "setWidget":
      return updateView(state, path, (v) => {
        const widgets = { ...v.widgets };
        if (!event.lines) delete widgets[event.key];
        else widgets[event.key] = { lines: event.lines, placement: event.placement };
        return { ...v, widgets };
      });
    case "setTitle":
      return updateView(state, path, (v) => ({ ...v, title: event.title }));
    case "setEditorText":
      return updateView(state, path, (v) => ({ ...v, editorText: event.text }));
  }
}

function lastAssistant(blocks: Block[]): Extract<Block, { kind: "assistant" }> | undefined {
  const last = blocks.at(-1);
  return last?.kind === "assistant" && last.streaming ? last : undefined;
}

function replaceLast(blocks: Block[], block: Block): Block[] {
  return [...blocks.slice(0, -1), block];
}

function replaceAt(blocks: Block[], index: number, block: Block): Block[] {
  const next = blocks.slice();
  next[index] = block;
  return next;
}

/**
 * Index of the newest block still standing in for a prompt we sent. A refused
 * prompt steers instead, so assistant deltas can land between the optimistic
 * block and the real user `message_start`: only a backwards scan finds it.
 */
function lastOptimisticUserIndex(blocks: Block[]): number {
  for (let i = blocks.length - 1; i >= 0; i--) {
    const b = blocks[i]!;
    if (b.kind === "user" && b.optimistic === true) return i;
  }
  return -1;
}

function displayQueuedText(raw: string): string {
  const { text, files } = splitAttachedFiles(raw);
  return text || files.map(file => file.name).join(", ");
}

/** PendingMessage.text is wire-bounded; parse the whole retained content once on arrival. */
function displayPending(messages: PendingMessage[]): PendingMessage[] {
  return messages.map(message => ({ ...message, text: displayQueuedText(textOf(message.content)) }));
}

export function applyUpdate(v: SessionView, u: SessionUpdate): SessionView {
  switch (u.kind) {
    case "entry_appended": {
      // Durable goal lifecycle must reach presentation before agent_end, and
      // survive the upstream complete -> null transition. Never rehydrate the
      // whole transcript mid-stream just to observe an extension entry.
      const entry = u.entry as { id?: string; type?: string; customType?: string } | undefined;
      if (entry?.type !== "custom" || entry.customType !== "goal-state") return v;
      if (entry.id && v.entries.some(raw => (raw as { id?: string })?.id === entry.id)) return v;
      return { ...v, entries: [...v.entries, u.entry] };
    }
    case "agent_start":
      return { ...v, running: true };
    case "agent_end":
      // A retryable provider failure ends one engine attempt, not the run the
      // person started. Keep the session working through its quiet backoff.
      if (u.willRetry) return { ...v, running: true };
      return { ...v, running: false, blocks: closeStreaming(v.blocks) };
    case "agent_settled":
      return { ...v, running: false, blocks: closeStreaming(v.blocks) };
    case "state":
      return { ...v, state: u.state, running: u.state.isStreaming };
    case "message_start": {
      if (u.role === "user") {
        // An optimistic block already stands in for this message — the person
        // typed it, so it keeps no attribution and consumes none.
        if (lastOptimisticUserIndex(v.blocks) !== -1) return v;
        const sentBy = v.pendingSentBy;
        return {
          ...v,
          pendingSentBy: undefined,
          blocks: [...v.blocks, { kind: "user", id: nextBlockId(), text: "", files: [], images: [], ...(sentBy ? { sentBy } : {}) }],
        };
      }
      if (u.role === "assistant") {
        // The child spoke before any prompt landed: whatever was armed was not
        // this turn's, and holding it would attribute a later message wrongly.
        return {
          ...v,
          pendingSentBy: undefined,
          blocks: [...closeStreaming(v.blocks), { kind: "assistant", id: nextBlockId(), text: "", thinking: "", streaming: true }],
        };
      }
      // A custom message with a speaker is a child run talking into this
      // session — the one case where words arrive that the session's own agent
      // did not say. It gets a block of its own so the transcript can put a
      // name over it; a custom message with no speaker is Pi's internal
      // bookkeeping and stays invisible, as before.
      if (u.role === "custom" && u.speaker) {
        return {
          ...v,
          blocks: [
            ...closeStreaming(v.blocks),
            { kind: "assistant", id: nextBlockId(), text: "", thinking: "", streaming: true, speaker: u.speaker },
          ],
        };
      }
      return v;
    }
    case "text_delta": {
      const a = lastAssistant(v.blocks);
      if (!a) return { ...v, blocks: [...v.blocks, { kind: "assistant", id: nextBlockId(), text: u.delta, thinking: "", streaming: true }] };
      return { ...v, blocks: replaceLast(v.blocks, { ...a, text: a.text + u.delta }) };
    }
    case "thinking_delta": {
      const a = lastAssistant(v.blocks);
      if (!a) return { ...v, blocks: [...v.blocks, { kind: "assistant", id: nextBlockId(), text: "", thinking: u.delta, streaming: true }] };
      return { ...v, blocks: replaceLast(v.blocks, { ...a, thinking: a.thinking + u.delta }) };
    }
    case "message_end": {
      const msg = u.message as { role?: string; content?: unknown } | undefined;
      if (msg?.role === "user") {
        const text = textOf(msg.content);
        const optimistic = lastOptimisticUserIndex(v.blocks);
        const index = optimistic !== -1 ? optimistic : v.blocks.at(-1)?.kind === "user" ? v.blocks.length - 1 : -1;
        if (index === -1) return v;
        const block = v.blocks[index] as Extract<Block, { kind: "user" }>;
        const blocks = replaceAt(v.blocks, index, { ...block, ...splitAttachedFiles(text), images: imagesOfContent(msg.content), optimistic: false, ...(u.entry ? { id: `entry:${u.entry.id}`, entryId: u.entry.id } : {}) });
        // The prompt's place in the tree arrives with it, so its actions (fork,
        // jump, edit, versions, the request it produced) work while the turn
        // runs. The tree holds a copy until the next full read: the entry is
        // real, only the read of the file has not happened yet. The leaf stays
        // where the last read put it — the entries between are not here, and
        // a path that cannot be walked would strip every older prompt of its id.
        if (!u.entry || v.entries.some((raw) => (raw as { id?: string } | null)?.id === u.entry!.id)) return { ...v, blocks };
        return { ...v, blocks, entries: [...v.entries, { type: "message", id: u.entry.id, parentId: u.entry.parentId, message: msg }] };
      }
      // A custom message the transcript renders (an agent event, a task exit)
      // becomes its own block. It carries no speaker, so nothing above claims it.
      if (msg?.role === "custom" && !u.speaker) {
        const block = customBlock(msg, undefined);
        return block ? { ...v, blocks: [...closeStreaming(v.blocks), block] } : v;
      }
      if (msg?.role === "assistant" || (msg?.role === "custom" && u.speaker)) {
        const a = lastAssistant(v.blocks);
        if (!a) return v;
        const finalText = textOf(msg.content);
        return {
          ...v,
          blocks: replaceLast(v.blocks, {
            ...a,
            text: finalText || a.text,
            streaming: false,
            ...(u.stopReason !== undefined ? { stopReason: u.stopReason } : {}),
            ...(u.errorMessage !== undefined ? { errorMessage: u.errorMessage } : {}),
            ...(u.usage !== undefined ? { usage: u.usage } : {}),
            ...(u.speaker !== undefined ? { speaker: u.speaker } : {}),
          }),
        };
      }
      return v;
    }
    case "tool_execution_start":
      return { ...v, blocks: [...closeStreaming(v.blocks), { kind: "tool", id: u.toolCallId, name: u.toolName, args: u.args, done: false }] };
    case "tool_execution_update":
      return { ...v, blocks: v.blocks.map((b) => (b.kind === "tool" && b.id === u.toolCallId ? { ...b, partial: String(stringify(u.partial)) } : b)) };
    case "tool_execution_end":
      return {
        ...v,
        blocks: v.blocks.map((b) => (b.kind === "tool" && b.id === u.toolCallId ? { ...b, result: u.result, isError: u.isError, done: true } : b)),
      };
    case "queue_update":
      return { ...v, queue: { steering: u.steering.map(displayQueuedText), followUp: u.followUp.map(displayQueuedText) } };
    case "pending_update":
      return { ...v, pending: displayPending(u.pending) };
    case "compaction_start":
      return notice(v, "info", "Compacting context…");
    case "compaction_end":
      return notice(v, u.ok ? "info" : "warning", u.ok ? "Context compacted." : "Compaction did not complete.");
    case "auto_retry_start":
      // The engine has accepted this failure for automatic recovery. It stays
      // in low-level logs and engine history, but it is not an answer and must
      // never look like a red stopped turn beside a still-working session.
      return { ...v, running: true, blocks: dropRetryingProviderError(v.blocks) };
    case "model_fallback": {
      // A switch is a durable record in the transcript, where the person was
      // reading. The steps that lead to one — trying a candidate, one failing —
      // are transient control state, like a provider retry (D-180): the status
      // line carries them and nothing lands in the conversation.
      if (u.phase === "switched") return notice(v, "info", switchedText(u.to, u.detail));
      if (u.phase === "exhausted") return notice(v, "warning", exhaustedText(u.detail));
      return v;
    }
    case "extension_error":
      return notice(v, "error", `${u.extension}: ${u.message}`);
    default:
      return v;
  }
}

/** A `custom` block for a message whose type the transcript draws; `undefined` for the rest. */
function customBlock(message: { customType?: unknown; content?: unknown; details?: unknown } | undefined, at: string | undefined): Extract<Block, { kind: "custom" }> | undefined {
  const customType = message?.customType;
  if (typeof customType !== "string" || !CUSTOM_MESSAGE_BLOCK_TYPES.has(customType)) return undefined;
  return { kind: "custom", id: nextBlockId(), ...(at ? { at } : {}), customType, text: textOf(message?.content), details: message?.details };
}

function closeStreaming(blocks: Block[]): Block[] {
  const a = lastAssistant(blocks);
  return a ? replaceLast(blocks, { ...a, streaming: false }) : blocks;
}

function notice(v: SessionView, level: "info" | "warning" | "error", text: string): SessionView {
  return { ...v, blocks: [...v.blocks, { kind: "notice", id: nextBlockId(), level, text }] };
}

/** Remove the failed provider message that immediately triggered a retry. */
function dropRetryingProviderError(blocks: Block[]): Block[] {
  for (let index = blocks.length - 1; index >= 0; index--) {
    const block = blocks[index]!;
    if (block.kind === "assistant" && block.stopReason === "error") {
      return [...blocks.slice(0, index), ...blocks.slice(index + 1)];
    }
    if (block.kind === "user") break;
  }
  return blocks;
}

/**
 * A stored tool result, as the transcript reads it back.
 *
 * A plain text result stays the joined string it has always been: every row
 * that reads one — the terminal body, the diff, the fallback — already treats
 * a string as the output, and nothing about those tools is lost by joining.
 * A result that carries `details`, or a content block that is not text, keeps
 * the envelope `tool_execution_end` delivers live (`{ content, details }`), so
 * a reopened session draws the row the live one drew: an MCP screenshot is an
 * image again, and the server that answered is known from `details.server`
 * even when the session has no MCP snapshot (docs/mcp.md "In the transcript").
 *
 * `details` decides on its own, whatever shape the content has: a stored
 * result whose content is a bare string still carries the diff, the run or the
 * server its row is drawn from.
 */
function storedToolResult(message: { content?: unknown; details?: unknown }): unknown {
  const content = message.content;
  const details = message.details;
  const hasDetails = typeof details === "object" && details !== null && !Array.isArray(details);
  const hasNonText =
    Array.isArray(content) &&
    content.some((part) => typeof part === "object" && part !== null && (part as { type?: unknown }).type !== "text");
  if (!hasDetails && !hasNonText) return textOf(content);
  return { content: Array.isArray(content) ? content : [{ type: "text", text: textOf(content) }], ...(hasDetails ? { details } : {}) };
}


/** The engine's per-turn `usage` on an assistant entry, or nothing when it reported none. */
function usageOfEntry(raw: unknown): Usage | undefined {
  if (!raw || typeof raw !== "object") return undefined;
  const u = raw as Partial<Usage>;
  const n = (value: unknown): number => (typeof value === "number" && Number.isFinite(value) ? value : 0);
  return { input: n(u.input), output: n(u.output), cacheRead: n(u.cacheRead), cacheWrite: n(u.cacheWrite), totalTokens: n(u.totalTokens), ...(u.cost ? { cost: u.cost } : {}) };
}

export function textOf(content: unknown): string {
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return "";
  return content
    .filter((c): c is { type: "text"; text: string } => !!c && typeof c === "object" && (c as { type?: string }).type === "text")
    .map((c) => c.text)
    .join("");
}

function stringify(value: unknown): string {
  if (typeof value === "string") return value;
  try {
    return JSON.stringify(value, null, 2);
  } catch {
    return String(value);
  }
}

/** The stop reasons that draw a stopped row; every other ending is an ordinary one. */
const STOPPED_SHORT = new Set<string>(["aborted", "length", "error", "deferred"]);

/**
 * Rebuild blocks from persisted Pi entries (session-format.md). Unknown shapes
 * are ignored.
 *
 * The file is a tree, not a list: editing a message in place, or running a
 * reply again, leaves the previous version in the file beside the new one.
 * Only the branch the session is sitting on is the conversation, so entries
 * off the path from the root to `leafId` are skipped here — they are reached
 * through the message's version picker instead. Passing no `leafId` reads the
 * last entry as the leaf, which is what the engine does on re-open.
 */
export function blocksFromEntries(entries: unknown[], leafId?: string | null, names?: ModelNames): Block[] {
  const blocks: Block[] = [];
  const toolIndex = new Map<string, number>();
  const branch = activePathIds(entries, leafId);
  /** Armed by a run-started marker; the prompt that follows it is the parent's. */
  let armed: SentByParent | undefined;
  for (const raw of entries) {
    if (branch && !branch.has((raw as { id?: string } | null)?.id ?? "")) continue;
    const e = raw as {
      type?: string;
      id?: unknown;
      timestamp?: unknown;
      message?: {
        role?: string;
        content?: unknown;
        details?: unknown;
        toolCallId?: string;
        toolName?: string;
        isError?: boolean;
        timestamp?: unknown;
        stopReason?: unknown;
        errorMessage?: unknown;
      };
    };
    // A custom message the transcript draws (an agent event, a task exit) is
    // persisted as its own entry type, with the message fields at the top.
    if (e.type === "custom_message") {
      const block = customBlock(raw as { customType?: unknown; content?: unknown; details?: unknown }, entryTimestamp(e.timestamp));
      if (block) blocks.push(typeof e.id === "string" ? { ...block, id: `entry:${e.id}` } : block);
      continue;
    }
    // The harness's run marker is a plain custom entry, not a message: it
    // draws nothing of its own, it says who the next prompt came from.
    if (e.type === "custom") {
      const marker = sentByOfMarker(raw);
      if (marker) {
        armed = marker;
        continue;
      }
      // A model fallback wrote its own record here (M15-T3). Reading a session
      // back must show the same line the person saw when it happened.
      const record = fallbackRecord(raw, entryTimestamp(e.timestamp), names);
      if (record) blocks.push(typeof e.id === "string" ? { ...record, id: `entry:${e.id}` } : record);
      continue;
    }
    if (e.type !== "message" || !e.message) continue;
    const m = e.message;
    const at = entryTimestamp(e.timestamp ?? m.timestamp);
    // A marker attributes the very next message and nothing after it.
    const sentBy = armed;
    armed = undefined;
    if (m.role === "user") {
      blocks.push({
        kind: "user",
        id: typeof e.id === "string" ? `entry:${e.id}` : nextBlockId(),
        ...(at ? { at } : {}),
        ...splitAttachedFiles(textOf(m.content)),
        images: imagesOfContent(m.content),
        ...(sentBy ? { sentBy } : {}),
        ...(typeof e.id === "string" ? { entryId: e.id } : {}),
      });
    } else if (m.role === "assistant") {
      const parts = Array.isArray(m.content) ? (m.content as Array<{ type?: string; text?: string; thinking?: string; id?: string; name?: string; arguments?: unknown }>) : [];
      const text = parts.filter((p) => p.type === "text").map((p) => p.text ?? "").join("");
      const thinking = parts.filter((p) => p.type === "thinking").map((p) => p.thinking ?? "").join("");
      // A turn that ended short belongs in the transcript even when it said
      // nothing: without this, an authentication failure reloads as a bare
      // question with no answer under it and nothing to explain the silence.
      // `stop`, `toolUse` and `pending` end a turn the ordinary way and draw no
      // row — the same list `incompleteReason` in runtime/projection.ts uses.
      const stopReason = STOPPED_SHORT.has(m.stopReason as string) ? (m.stopReason as StopReason) : undefined;
      const errorMessage = typeof m.errorMessage === "string" && m.errorMessage !== "" ? m.errorMessage : undefined;
      // The engine writes the turn's token counts on the entry; a reloaded
      // footer shows the same accounting the live one did.
      const usage = usageOfEntry((m as { usage?: unknown }).usage);
      if (text || thinking || stopReason || parts.some(part => part.type === "toolCall")) {
        blocks.push({
          kind: "assistant",
          id: typeof e.id === "string" ? `entry:${e.id}` : nextBlockId(),
          ...(at ? { at } : {}),
          text,
          thinking,
          streaming: false,
          ...(stopReason ? { stopReason } : {}),
          ...(errorMessage ? { errorMessage } : {}),
          ...(usage ? { usage } : {}),
        });
      }
      for (const p of parts) {
        if (p.type === "toolCall" && p.id) {
          toolIndex.set(p.id, blocks.length);
          blocks.push({ kind: "tool", id: p.id, ...(at ? { at } : {}), name: p.name ?? "tool", args: p.arguments, done: false });
        }
      }
    } else if (m.role === "custom") {
      const block = customBlock(m as { customType?: unknown; content?: unknown; details?: unknown }, at);
      if (block) blocks.push(block);
    } else if (m.role === "toolResult" && m.toolCallId) {
      const i = toolIndex.get(m.toolCallId);
      const result = storedToolResult(m);
      if (i !== undefined) {
        const b = blocks[i] as Extract<Block, { kind: "tool" }>;
        blocks[i] = { ...b, result, isError: m.isError ?? false, done: true };
      }
    }
  }
  return hideRecoveredProviderErrors(blocks);
}

/**
 * Engine history retains every failed provider attempt. Within one user turn,
 * every error except the last was followed by another assistant attempt and
 * therefore recovered (or was superseded by the final failure). Keep only the
 * outcome a person can act on.
 */
function hideRecoveredProviderErrors(blocks: Block[]): Block[] {
  const hidden = new Set<number>();
  let pendingError: number | undefined;
  for (let index = 0; index < blocks.length; index++) {
    const block = blocks[index]!;
    if (block.kind === "user") {
      pendingError = undefined;
      continue;
    }
    if (block.kind !== "assistant") continue;
    if (block.stopReason === "error") {
      if (pendingError !== undefined) hidden.add(pendingError);
      pendingError = index;
      continue;
    }
    if (pendingError !== undefined) {
      hidden.add(pendingError);
      pendingError = undefined;
    }
  }
  return hidden.size === 0 ? blocks : blocks.filter((_, index) => !hidden.has(index));
}

/**
 * The attribution a `lasercode/agent-run` entry carries, or `undefined` for
 * every other custom entry and for the moments that end a run rather than
 * start one. `origin: "user"` is the person's own run: their message is theirs.
 *
 * A message the parent sends to a child that is already busy is queued by the
 * engine and starts no run, so it has no marker and stays unattributed —
 * inventing one from the text would be a guess, and this never guesses.
 */
function sentByOfMarker(raw: unknown): SentByParent | undefined {
  const entry = raw as { customType?: unknown; data?: unknown } | undefined;
  if (entry?.customType !== SESSION_RUN_ENTRY_TYPE) return undefined;
  const data = entry.data as { moment?: unknown; origin?: unknown; parentPath?: unknown; runId?: unknown } | undefined;
  if (!data || data.moment !== "started" || data.origin !== "agent") return undefined;
  if (typeof data.parentPath !== "string" || data.parentPath === "") return undefined;
  return { parentPath: data.parentPath, ...(typeof data.runId === "string" ? { runId: data.runId } : {}) };
}

/**
 * Display names by `provider/id`, for a record that stores identities only.
 *
 * The chain snapshot the worker publishes on the session state carries the
 * catalogue's names, and it holds exactly the models a record can name — so a
 * line read back from the file says "Sonnet 4.5", like the one the person saw
 * when it happened, rather than `claude-sonnet-4-5`.
 */
export type ModelNames = ReadonlyMap<string, string>;

export function modelNamesOf(state: SessionState | undefined): ModelNames {
  const names = new Map<string, string>();
  for (const model of state?.fallback?.chain ?? []) {
    names.set(`${model.provider}/${model.id}`.toLowerCase(), model.name ?? model.id);
  }
  if (state?.model) names.set(`${state.model.provider}/${state.model.id}`.toLowerCase(), state.model.name ?? state.model.id);
  return names;
}

/** "Continued on X · Y is not answering." — one line, both live and on reload. */
function switchedText(to: { name?: string; id: string } | undefined, detail: string | undefined): string {
  const model = to ? (to.name ?? to.id) : "another model";
  return detail ? `Continued on ${model} · ${detail}` : `Continued on ${model}.`;
}

function exhaustedText(detail: string | undefined): string {
  return detail ?? "No other model in this chain could take over.";
}

/**
 * The transcript line a `lasercode/fallback` record carries, or undefined for
 * the records that are state rather than a moment (an activation, a candidate
 * that was skipped). Written by the worker, read here and nowhere else.
 */
function fallbackRecord(raw: unknown, at: string | undefined, names?: ModelNames): Extract<Block, { kind: "notice" }> | undefined {
  const entry = raw as { customType?: unknown; data?: unknown } | undefined;
  if (entry?.customType !== SESSION_FALLBACK_ENTRY_TYPE) return undefined;
  const data = entry.data as {
    event?: unknown;
    from?: { provider?: string; id?: string };
    to?: { provider?: string; id?: string };
    failure?: { class?: unknown };
  } | undefined;
  if (!data) return undefined;
  const failure = typeof data.failure?.class === "string" ? failureWording(data.failure.class as Parameters<typeof failureWording>[0]) : undefined;
  const said = (model: { provider?: string; id?: string } | undefined): string | undefined => {
    if (typeof model?.id !== "string") return undefined;
    const key = `${model.provider ?? ""}/${model.id}`.toLowerCase();
    return names?.get(key) ?? model.id;
  };
  const because = failure && said(data.from) ? `${said(data.from)} ${failure}.` : undefined;
  if (data.event === "switched" || data.event === "returned") {
    const to = said(data.to);
    return { kind: "notice", id: nextBlockId(), ...(at ? { at } : {}), level: "info", text: switchedText(to ? { id: to } : undefined, because) };
  }
  if (data.event === "exhausted") {
    return {
      kind: "notice",
      id: nextBlockId(),
      ...(at ? { at } : {}),
      level: "warning",
      text: because ? `${because} No other model in this chain could take over.` : exhaustedText(undefined),
    };
  }
  return undefined;
}

/** Pi entries stamp `timestamp` as epoch ms or an ISO string; both become ISO. */
function entryTimestamp(value: unknown): string | undefined {
  if (typeof value === "number" && Number.isFinite(value)) return new Date(value).toISOString();
  if (typeof value === "string") {
    const date = new Date(value);
    return Number.isNaN(date.getTime()) ? undefined : date.toISOString();
  }
  return undefined;
}
