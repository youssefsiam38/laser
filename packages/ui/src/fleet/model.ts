/**
 * The fleet's data model (docs/ux-fleet.md). Pure: sessions, runs, tasks and
 * open views in — groups of work items out. No React, no DOM, no host calls.
 * Tested in test/fleet/model.test.ts.
 *
 * Two kinds of work, one list, because from the person's side they are the
 * same question — *what is going on, and does it need me?*
 *
 *   agent   one execution of an agent in its own child session
 *   task    one long command an agent left running
 *
 * Structure is the point. A group is a top-level session; inside it, agent
 * items nest exactly as the agent tree nests, and a session's background tasks
 * hang off the item for the session that started them. Ordering is creation
 * order, never attention order: a list that reshuffles is a list you cannot
 * learn. Attention still reaches you, because it rolls *up*: an item wears the
 * loudest state anywhere beneath it, so a question three levels down lights the
 * group you can actually see.
 *
 * `buildFleet` builds every group there is; `scopeFleet` cuts it down to the
 * one the person is shown — the open session's tree — plus work whose root
 * session was deleted, which no session can show (M13-T51).
 */
import { highestAttention, humanizeLabel, isTerminalRunStatus, type AgentRun, type Attention, type BackgroundTask, type SessionSummary } from "@lasercode/protocol";
import { buildAgentTree, createAncestryIndex, type AgentTreeNode } from "../agents/run-tree.js";
import { runStatusTone, type AgentStatusTone } from "../agents/model.js";
import { sessionTitle } from "../runtime/threadList.js";
import { viewFirstUserText } from "../view-summary.js";
import type { SessionView } from "../store.js";
import { samePresentationViews } from "../runtime/presentation-state.js";
import { agentHeadline, agentInitials, agentStrip, taskHeadline, taskStrip, type FleetHeadline, type FleetStrip } from "./row.js";

export type FleetItemKind = "agent" | "task";

/** What the row's dot and word say. Both vocabularies map onto this one. */
export type FleetState =
  | "queued"
  | "running"
  /** Live, paused on a question until someone answers (M13-T45). */
  | "needs_input"
  | "blocked"
  | "completed"
  | "failed"
  | "cancelled";

export const FLEET_STATE_LABEL: Readonly<Record<FleetState, string>> = {
  queued: "Waiting",
  running: "Working",
  needs_input: "Asking",
  blocked: "Blocked",
  completed: "Done",
  failed: "Failed",
  cancelled: "Ended",
};

const STATE_ATTENTION: Readonly<Record<FleetState, Attention>> = {
  queued: "working",
  running: "working",
  needs_input: "waiting_for_input",
  // Terminal blocking is neutral history. The message still explains why the
  // run ended; only a live `needs_input` question requires attention.
  blocked: "idle",
  completed: "finished_unread",
  failed: "error",
  cancelled: "idle",
};

export interface FleetItem {
  /** Stable identity and React key: `agent:<sessionPath>` or `task:<taskId>`. */
  key: string;
  kind: FleetItemKind;
  /** What you would address it by: the subagent's name, or the task's id. */
  title: string;
  /** The line under the title: the agent's task excerpt, or the whole command. */
  subtitle: string | undefined;
  state: FleetState;
  tone: AgentStatusTone;
  /** This item's own dot. */
  own: Attention;
  /** This item's dot including everything beneath it. */
  attention: Attention;
  /**
   * Line 2 of the collapsed row (leap §3 A.1). Never the task brief. Priority:
   * the question, live activity, a command's last line, the terminal reason,
   * the result's first sentence.
   */
  headline: FleetHeadline | undefined;
  /** Line 3: agent identity and spend, or the command's own facts. */
  strip: FleetStrip;
  /** Agent tile letters, from `agentName`. Undefined on a command. */
  initials: string | undefined;
  /** Never lost: "you ended it", "exit code 2". */
  terminalReason: string | undefined;
  startedAt: string | undefined;
  endedAt: string | undefined;
  /** Live while the work is going; frozen once it ends. */
  elapsedMs: number | undefined;
  /** Reached an end state, without considering children. */
  terminal: boolean;
  /**
   * The session this item's "open" control moves to. An agent item's is its
   * own chat; a task has no conversation of its own, so this is the session
   * whose agent ran the command — which is why the two kinds do not share
   * one label (`DetailActions`).
   */
  sessionPath: string;
  /** Ending it: an agent run by `runId`, a task by `taskId` in its session. */
  stop: { kind: "agent"; runId: string } | { kind: "task"; path: string; id: string } | undefined;
  model: string | undefined;
  /** Bytes the task has written; the liveness signal a follower reacts to. */
  outputBytes: number | undefined;
  run: AgentRun | undefined;
  task: BackgroundTask | undefined;
  depth: number;
  children: FleetItem[];
}

export interface FleetGroup {
  /** The top-level session. Its own row is the group header, not an item. */
  path: string;
  cwd: string;
  title: string;
  /** Not open in this client: its work kept going without it. */
  orphaned: boolean;
  /**
   * Its root session is gone from the catalog, so this work has no session to
   * be seen in. Only ever true once a catalog has arrived: an empty catalog is
   * one that has not loaded, not proof that a session was deleted.
   */
  deleted: boolean;
  items: FleetItem[];
  /** Items still going, anywhere in the group. */
  running: number;
  /** Items that need a person, anywhere in the group. */
  needsYou: number;
  /** Terminal items, anywhere in the group. */
  ended: number;
  attention: Attention;
}

export interface FleetInput {
  sessions: readonly SessionSummary[];
  runs: Readonly<Record<string, AgentRun>>;
  tasks: Readonly<Record<string, BackgroundTask>>;
  views: Readonly<Record<string, SessionView | undefined>>;
  /** The session the person is looking at, so "orphaned" means what it says. */
  currentPath?: string | undefined;
  /**
   * Whether `sessions` is the catalog or merely its absence. Without it a
   * root missing from an empty list is read as "not loaded yet", never as
   * "deleted".
   */
  sessionsLoaded?: boolean | undefined;
  /** With a paged catalog, only explicit host absence proves deletion. */
  sessionPresence?: Readonly<Record<string, boolean>> | undefined;
  now: number;
}

const time = (value: string | undefined): number => {
  const parsed = value === undefined ? Number.NaN : Date.parse(value);
  return Number.isNaN(parsed) ? 0 : parsed;
};

function elapsed(startedAt: string | undefined, endedAt: string | undefined, live: boolean, now: number): number | undefined {
  const start = time(startedAt);
  if (!start) return undefined;
  const end = endedAt ? time(endedAt) : live ? now : undefined;
  return end === undefined || end === 0 ? undefined : Math.max(0, end - start);
}

const TASK_STATE: Readonly<Record<BackgroundTask["status"], FleetState>> = {
  running: "running",
  completed: "completed",
  failed: "failed",
  stopped: "cancelled",
};

function taskItem(task: BackgroundTask, depth: number, now: number): FleetItem {
  const state = TASK_STATE[task.status];
  const own = STATE_ATTENTION[state];
  const terminalReason = task.terminalReason;
  return {
    key: `task:${task.id}`,
    kind: "task",
    title: task.title,
    subtitle: task.command === task.title ? undefined : task.command,
    state,
    // `completed` is muted, not `ok`: green means happening now (D-154).
    tone: state === "running" ? "live" : state === "failed" ? "danger" : "muted",
    own,
    attention: own,
    headline: taskHeadline(task, terminalReason),
    strip: taskStrip(task),
    initials: undefined,
    terminalReason,
    startedAt: task.startedAt,
    endedAt: task.endedAt,
    elapsedMs: elapsed(task.startedAt, task.endedAt, task.status === "running", now),
    terminal: task.status !== "running",
    sessionPath: task.sessionPath,
    stop: task.status === "running" ? { kind: "task", path: task.sessionPath, id: task.id } : undefined,
    model: undefined,
    outputBytes: task.outputBytes,
    run: undefined,
    task,
    depth,
    children: [],
  };
}

/**
 * One agent-tree node, plus the background tasks its session started. A task
 * belongs to the session that ran it, so it hangs off that session's item
 * rather than floating at the top of the group: a command a child agent
 * started is that child's, and saying otherwise would lose the parentage.
 */
function agentItem(node: AgentTreeNode, tasksOf: (path: string) => BackgroundTask[], depth: number, now: number): FleetItem {
  const run = node.run;
  // A session with no run of its own is still a node of the tree; it is
  // "working" or it is nothing, and nothing is not an error.
  const state: FleetState = node.status === "working" ? "running" : node.status === "idle" ? "completed" : node.status;
  const own: Attention = node.status === "idle" ? "idle" : STATE_ATTENTION[state];
  const terminalReason = reasonOfRun(run);
  const agentName = run?.agentName ?? node.title;
  return {
    key: `agent:${node.sessionPath}`,
    kind: "agent",
    title: humanizeLabel(node.subagentName ?? node.title),
    subtitle: run?.task,
    state,
    tone: node.status === "idle" ? "muted" : node.status === "working" ? "live" : runStatusTone(node.status),
    own,
    attention: own,
    headline: agentHeadline(run, node.ended, terminalReason),
    strip: agentStrip(run, agentName),
    initials: agentInitials(agentName),
    terminalReason,
    startedAt: run?.startedAt,
    endedAt: run?.endedAt,
    elapsedMs: elapsed(run?.startedAt, run?.endedAt, !node.ended, now),
    terminal: node.ended,
    sessionPath: node.sessionPath,
    stop: run && !isTerminalRunStatus(run.status) ? { kind: "agent", runId: run.runId } : undefined,
    model: run?.model ? `${run.model.provider}/${run.model.id}` : undefined,
    outputBytes: undefined,
    run,
    task: undefined,
    depth,
    // Child agents are prepended by the caller, which owns the tree walk.
    children: tasksOf(node.sessionPath).map((task) => taskItem(task, depth + 1, now)),
  };
}

function reasonOfRun(run: AgentRun | undefined): string | undefined {
  if (!run) return undefined;
  if (run.endedBy?.reason) return run.endedBy.reason;
  if (run.error) return run.error;
  if (run.status === "cancelled") return run.endedBy?.initiator === "user" ? "you ended it" : "the parent ended it";
  if (run.status === "blocked") return run.result?.message;
  return undefined;
}

/** Roll attention up and count what is going, in one post-order walk. */
function settle(items: readonly FleetItem[], counts: { running: number; needsYou: number; ended: number }): Attention {
  const seen: Attention[] = [];
  for (const item of items) {
    const below = settle(item.children, counts);
    item.attention = highestAttention([item.own, below]);
    if (!item.terminal) counts.running += 1;
    else counts.ended += 1;
    if (item.state === "needs_input") counts.needsYou += 1;
    seen.push(item.attention);
  }
  return highestAttention(seen);
}

/**
 * Every group of work the person could be shown. A session with no agent work
 * and no background command is not a group: the fleet is a list of work, not a
 * second session list.
 */
export function buildFleet(input: FleetInput): FleetGroup[] {
  const { sessions, runs, tasks, views, now } = input;
  const runList = Object.values(runs);
  // A total order, never the map's. `Object.values` follows insertion, and
  // `tasks/loaded` rewrites that insertion order for every session it lists,
  // so two commands that started in the same millisecond would swap rows on a
  // reconnect with nothing about either of them having changed (R1).
  const taskList = Object.values(tasks).sort((a, b) => time(a.startedAt) - time(b.startedAt) || a.id.localeCompare(b.id));
  if (runList.length === 0 && taskList.length === 0) return [];

  const index = createAncestryIndex(runs, sessions);
  const summaries = new Map(sessions.map((summary) => [summary.path, summary]));

  /**
   * The top-level session a piece of work belongs to.
   *
   * A record that names its own root is believed before a chain that has to be
   * walked, because the walk can be one row short of complete: a child whose
   * parent's catalog row has not arrived (or whose run the snapshot does not
   * hold yet) would otherwise become a root of its own for as long as the gap
   * lasts — and its still-running command would leave the tree it belongs to
   * and reappear under "work from a deleted session", in a list with the same
   * markup. That is a row removed here and added there, and back again, while
   * nothing about the work changed: the flicker this function exists to
   * prevent. Membership is decided by what the work declares, not by how
   * complete this snapshot happens to be.
   */
  const declaredRoot = (path: string): string | undefined => {
    const summary = summaries.get(path);
    const declared = summary?.agent?.rootPath ?? views[path]?.state.agent?.rootPath;
    return declared || undefined;
  };
  const rootOfSession = (path: string): string => declaredRoot(path) ?? index.rootOf(path);

  // One group per top-level session that has work anywhere beneath it.
  const roots = new Set<string>();
  const rootOfTask = new Map<string, string>();
  for (const run of runList) roots.add(run.rootSessionPath || rootOfSession(run.sessionPath));
  for (const task of taskList) {
    const root = rootOfSession(task.sessionPath);
    rootOfTask.set(task.id, root);
    roots.add(root);
  }

  const groups: FleetGroup[] = [];

  for (const rootPath of roots) {
    const tree = buildAgentTree({ rootPath, sessions, runs, views });
    /**
     * Where a command hangs in *this* tree: its own session when the tree has
     * a node for it, else the nearest ancestor it does have, else the root.
     *
     * Exactly one place, always a place. A command whose session is in this
     * group can never be dropped for want of a node (R7), and a node that
     * comes and goes moves the command one indent rather than into another
     * list — the ancestor is still the truth, just less of it.
     */
    const hostOf = (path: string): string => {
      if (tree.byPath.has(path)) return path;
      const ancestry = index.ancestryOf(path);
      for (let i = ancestry.length - 1; i >= 0; i -= 1) {
        const ancestor = ancestry[i]!;
        if (tree.byPath.has(ancestor)) return ancestor;
      }
      return rootPath;
    };
    const tasksHere = new Map<string, BackgroundTask[]>();
    for (const task of taskList) {
      if (rootOfTask.get(task.id) !== rootPath) continue;
      const host = hostOf(task.sessionPath);
      const list = tasksHere.get(host);
      if (list) list.push(task);
      else tasksHere.set(host, [task]);
    }
    const tasksOf = (path: string): BackgroundTask[] => tasksHere.get(path) ?? [];
    // The root node is the session itself; the group header says who it is, so
    // its own row would be a second copy of the same fact.
    const build = (node: AgentTreeNode, depth: number): FleetItem => {
      const item = agentItem(node, tasksOf, depth, now);
      const kids = node.children.map((childPath) => tree.byPath.get(childPath)).filter((child): child is AgentTreeNode => child !== undefined);
      item.children = [...kids.map((child) => build(child, depth + 1)), ...item.children];
      return item;
    };
    const items: FleetItem[] = [
      ...tree.root.children
        .map((childPath) => tree.byPath.get(childPath))
        .filter((child): child is AgentTreeNode => child !== undefined)
        .map((child) => build(child, 0)),
      ...tasksOf(rootPath).map((task) => taskItem(task, 0, now)),
    ];
    if (items.length === 0) continue;

    const counts = { running: 0, needsYou: 0, ended: 0 };
    const attention = settle(items, counts);
    const summary = summaries.get(rootPath);
    const view = views[rootPath];
    // A root the catalog does not list, once there is a catalog to list it,
    // was deleted underneath its work. An open view of it is not a
    // counter-proof: the view is the client's memory, not the disk.
    const deleted = input.sessionPresence !== undefined ? input.sessionPresence[rootPath] === false
      : summary === undefined && (input.sessionsLoaded ?? sessions.length > 0);
    groups.push({
      path: rootPath,
      // Sorted, not "the first run the map happens to yield": every run of a
      // root names the same project, and where one disagrees the answer must
      // still be the same answer on the next build.
      cwd: summary?.cwd ?? view?.state.cwd
        ?? runList.filter((run) => run.rootSessionPath === rootPath).map((run) => run.projectCwd).sort()[0]
        ?? "",
      // A root the catalog cannot name is named the way the top bar names an
      // unscanned session — its name, else its first line — and a deleted one
      // with neither is "Unnamed session", not a file name: the header beside it
      // already says it was deleted, so the title says the other true thing.
      title: summary ? sessionTitle(summary, view) : (view?.state.name ?? firstUserLine(view) ?? (deleted ? "Unnamed session" : (rootPath.split("/").at(-1) ?? rootPath))),
      orphaned: view === undefined && rootPath !== input.currentPath,
      deleted,
      items,
      running: counts.running,
      needsYou: counts.needsYou,
      ended: counts.ended,
      attention,
    });
  }

  // The session you are in first — its work is the work you asked about — then
  // the busiest, then alphabetically so the rest never shuffle under you. The
  // path breaks a tie between two sessions with the same title, so the order
  // is total and never falls back to the order a map happened to be built in.
  return groups.sort(
    (a, b) =>
      Number(b.path === input.currentPath) - Number(a.path === input.currentPath) ||
      b.needsYou - a.needsYou ||
      b.running - a.running ||
      a.title.localeCompare(b.title) ||
      a.path.localeCompare(b.path),
  );
}

/**
 * Is this the same row, drawing the same things?
 *
 * Every visible value on a row is derived from the run or the task record,
 * the rolled-up attention and the clock, so those are what is compared —
 * `headline` and `strip` are functions of the same record and need no second
 * comparison. Children are compared by identity, which holds because the
 * reconciliation below is bottom-up.
 */
function sameFleetItem(a: FleetItem, b: FleetItem): boolean {
  return (
    a.key === b.key &&
    a.kind === b.kind &&
    a.title === b.title &&
    a.subtitle === b.subtitle &&
    a.state === b.state &&
    a.own === b.own &&
    a.attention === b.attention &&
    a.terminal === b.terminal &&
    a.terminalReason === b.terminalReason &&
    a.startedAt === b.startedAt &&
    a.endedAt === b.endedAt &&
    a.elapsedMs === b.elapsedMs &&
    a.sessionPath === b.sessionPath &&
    a.model === b.model &&
    a.outputBytes === b.outputBytes &&
    a.initials === b.initials &&
    a.depth === b.depth &&
    a.run === b.run &&
    a.task === b.task &&
    a.children.length === b.children.length &&
    a.children.every((child, index) => child === b.children[index])
  );
}

function sameFleetGroup(a: FleetGroup, b: FleetGroup): boolean {
  return (
    a.path === b.path &&
    a.cwd === b.cwd &&
    a.title === b.title &&
    a.orphaned === b.orphaned &&
    a.deleted === b.deleted &&
    a.running === b.running &&
    a.needsYou === b.needsYou &&
    a.ended === b.ended &&
    a.attention === b.attention &&
    a.items.length === b.items.length &&
    a.items.every((item, index) => item === b.items[index])
  );
}

/**
 * Keep the objects the last build produced wherever this build says the same
 * thing. A command writing output replaces one task record a second; without
 * this, that one record replaces every `FleetItem` in the column — the agent
 * that has not moved, its ancestors, the groups — and every row re-renders on
 * every tick of every command. Bottom-up, so a parent is reused only when all
 * of its children were.
 */
function reuseItems(previous: readonly FleetItem[] | undefined, next: FleetItem[]): FleetItem[] {
  if (!previous || previous.length === 0) return next;
  const byKey = new Map(previous.map((item) => [item.key, item]));
  const out = next.map((item) => {
    const old = byKey.get(item.key);
    if (!old) return item;
    // The item is this build's own, so settling its children in place is safe
    // and keeps the array identity a parent's comparison depends on.
    const children = reuseItems(old.children, item.children);
    if (children !== item.children) item.children = children;
    return sameFleetItem(old, item) ? old : item;
  });
  return out.length === previous.length && out.every((item, index) => item === previous[index]) ? (previous as FleetItem[]) : out;
}

function reuseGroups(previous: readonly FleetGroup[] | undefined, next: FleetGroup[]): FleetGroup[] {
  if (!previous || previous.length === 0) return next;
  const byPath = new Map(previous.map((group) => [group.path, group]));
  return next.map((group) => {
    const old = byPath.get(group.path);
    const items = reuseItems(old?.items, group.items);
    if (items !== group.items) group.items = items;
    return old && sameFleetGroup(old, group) ? old : group;
  });
}

/** Share structural derivation across the column and its ambient controls.
 * Clocks only copy elapsed labels; they never rebuild ancestry or sort work.
 * Weak ownership follows the store's run snapshot, not a process-wide session ID.
 */
export function createFleetSelector(build: typeof buildFleet = buildFleet): typeof buildFleet {
  const cache = new WeakMap<FleetInput["runs"], { input: FleetInput; groups: FleetGroup[]; now: number; clocked: FleetGroup[] }>();
  const clockItem = (item: FleetItem, now: number): FleetItem => {
    const children = item.children.map((child) => clockItem(child, now));
    const elapsedMs = elapsed(item.startedAt, item.endedAt, !item.terminal, now);
    if (elapsedMs === item.elapsedMs && children.every((child, index) => child === item.children[index])) return item;
    return { ...item, elapsedMs, children };
  };
  return (input) => {
    let entry = cache.get(input.runs);
    const old = entry?.input;
    if (!old || old.sessions !== input.sessions || old.tasks !== input.tasks
      || old.currentPath !== input.currentPath || old.sessionsLoaded !== input.sessionsLoaded || old.sessionPresence !== input.sessionPresence
      || !samePresentationViews(old.views, input.views)) {
      // The rebuild is structural; the reconciliation is what keeps identity
      // across it, so a row React could update is never a row it replaces.
      const groups = reuseGroups(entry?.clocked, build(input));
      entry = { input, groups, now: input.now, clocked: groups };
      cache.set(input.runs, entry);
    }
    if (entry!.now !== input.now) {
      entry!.now = input.now;
      entry!.clocked = entry!.groups.map((group) => {
        const items = group.items.map((item) => clockItem(item, input.now));
        return items.every((item, index) => item === group.items[index]) ? group : { ...group, items };
      });
    }
    return entry!.clocked;
  };
}

export const selectFleet = createFleetSelector();

/**
 * The transcript's first user line, for a root the catalog has no row for
 * (mirrors the top bar). A released transcript keeps it (RP-5).
 */
function firstUserLine(view: SessionView | undefined): string | undefined {
  const text = viewFirstUserText(view)?.trim();
  return text ? text.replace(/\s+/g, " ").slice(0, 60) : undefined;
}

/** Every item of a group, flattened depth-first — summaries, counts and tests. */
export function flattenFleet(items: readonly FleetItem[]): FleetItem[] {
  const out: FleetItem[] = [];
  const walk = (list: readonly FleetItem[]): void => {
    for (const item of list) {
      out.push(item);
      walk(item.children);
    }
  };
  walk(items);
  return out;
}

/** A section-specific view of one canonical item. Only ancestry repeats. */
export interface FleetProjectedItem {
  /** The one canonical run/task record. Never cloned or rewritten here. */
  item: FleetItem;
  /** True when this row exists only to preserve lineage to included work. */
  contextOnly: boolean;
  /** Attention from actual work included in this projection, rolled upward. */
  attention: Attention;
  children: FleetProjectedItem[];
}

export interface FleetProjectedGroup {
  /** Canonical group metadata: title, path, cwd and deleted state. */
  group: FleetGroup;
  items: FleetProjectedItem[];
  /** Actual work in this section; context rows are excluded. */
  count: number;
  running: number;
  needsYou: number;
  attention: Attention;
}

export interface FleetSectionProjection {
  groups: FleetProjectedGroup[];
  count: number;
  running: number;
  needsYou: number;
  attention: Attention;
}

export interface FleetSections {
  active: FleetSectionProjection;
  finished: FleetSectionProjection;
}

interface ProjectedNode {
  active: FleetProjectedItem | undefined;
  finished: FleetProjectedItem | undefined;
  activeCount: number;
  activeNeedsYou: number;
  finishedCount: number;
}

/** A bad or absent end time is not evidence that a terminal row was cleared. */
function terminalIsVisible(item: FleetItem, clearedBefore: string | undefined): boolean {
  if (!item.terminal || clearedBefore === undefined) return true;
  const mark = time(clearedBefore);
  const ended = time(item.endedAt);
  return mark === 0 || ended === 0 || ended > mark;
}

/**
 * Recursively project one canonical tree into lifecycle sections (D-205).
 *
 * Live work belongs only to In progress and terminal work only to Finished.
 * An agent ancestor is repeated as uncounted context wherever descendants in
 * the other section need it. Clear is part of the same projection: old
 * terminal descendants disappear without taking live/new work or its ancestry
 * with them. Canonical items, records and child arrays are never mutated.
 */
export function projectFleetSections(
  groups: readonly FleetGroup[],
  options: { clearedBefore?: string | undefined } = {},
): FleetSections {
  const projectItem = (item: FleetItem): ProjectedNode => {
    const children = item.children.map(projectItem);
    const activeChildren = children.flatMap((child) => (child.active ? [child.active] : []));
    const finishedChildren = children.flatMap((child) => (child.finished ? [child.finished] : []));
    const ownActive = !item.terminal;
    const ownFinished = item.terminal && terminalIsVisible(item, options.clearedBefore);
    const active =
      ownActive || activeChildren.length > 0
        ? {
            item,
            contextOnly: !ownActive,
            attention: highestAttention([
              ...(ownActive ? [item.own] : []),
              ...activeChildren.map((child) => child.attention),
            ]),
            children: activeChildren,
          }
        : undefined;
    const finished =
      ownFinished || finishedChildren.length > 0
        ? {
            item,
            contextOnly: !ownFinished,
            attention: highestAttention([
              ...(ownFinished ? [item.own] : []),
              ...finishedChildren.map((child) => child.attention),
            ]),
            children: finishedChildren,
          }
        : undefined;
    return {
      active,
      finished,
      activeCount: Number(ownActive) + children.reduce((total, child) => total + child.activeCount, 0),
      activeNeedsYou: Number(ownActive && item.state === "needs_input") + children.reduce((total, child) => total + child.activeNeedsYou, 0),
      finishedCount: Number(ownFinished) + children.reduce((total, child) => total + child.finishedCount, 0),
    };
  };

  const activeGroups: FleetProjectedGroup[] = [];
  const finishedGroups: FleetProjectedGroup[] = [];
  for (const group of groups) {
    const projected = group.items.map(projectItem);
    const activeItems = projected.flatMap((item) => (item.active ? [item.active] : []));
    const finishedItems = projected.flatMap((item) => (item.finished ? [item.finished] : []));
    const activeCount = projected.reduce((total, item) => total + item.activeCount, 0);
    const activeNeedsYou = projected.reduce((total, item) => total + item.activeNeedsYou, 0);
    const finishedCount = projected.reduce((total, item) => total + item.finishedCount, 0);
    if (activeItems.length > 0) {
      activeGroups.push({
        group,
        items: activeItems,
        count: activeCount,
        running: activeCount,
        needsYou: activeNeedsYou,
        attention: highestAttention(activeItems.map((item) => item.attention)),
      });
    }
    if (finishedItems.length > 0) {
      finishedGroups.push({
        group,
        items: finishedItems,
        count: finishedCount,
        running: 0,
        needsYou: 0,
        attention: highestAttention(finishedItems.map((item) => item.attention)),
      });
    }
  }

  const section = (projectedGroups: FleetProjectedGroup[]): FleetSectionProjection => ({
    groups: projectedGroups,
    count: projectedGroups.reduce((total, group) => total + group.count, 0),
    running: projectedGroups.reduce((total, group) => total + group.running, 0),
    needsYou: projectedGroups.reduce((total, group) => total + group.needsYou, 0),
    attention: highestAttention(projectedGroups.map((group) => group.attention)),
  });
  return { active: section(activeGroups), finished: section(finishedGroups) };
}

/**
 * The fleet the person is shown (docs/ux-fleet.md, "One session's tree").
 *
 * `buildFleet` knows every piece of work; this is the cut that makes it the
 * open session's. The tree is the group whose root is the session being read
 * — a child is read inside its root's tree, so opening a child changes what
 * is marked, not what is shown. Work under any other root is simply not here:
 * that session has its own fleet, and the person navigates to it.
 *
 * The one exception is work whose root session was deleted. It is nobody's
 * tree — navigating to a session that no longer exists is not a way to reach
 * it — and it is still running and still spending, so it is carried in
 * `elsewhere`, in every session's fleet and in the no-session state alike,
 * until it ends and is cleared, or is stopped from there.
 */
export interface FleetScope {
  /** The open session's tree: one group, or none when that session has no work. */
  tree: FleetGroup | undefined;
  /** Work whose root session is gone, with nowhere else to be seen. */
  elsewhere: FleetGroup[];
}

export function scopeFleet(groups: readonly FleetGroup[], root: string | undefined): FleetScope {
  let tree: FleetGroup | undefined;
  const elsewhere: FleetGroup[] = [];
  for (const group of groups) {
    // The person is inside this tree; "closed here" is the wrong word for
    // the session they are reading a child of.
    if (group.path === root) tree = { ...group, orphaned: false };
    else if (group.deleted) elsewhere.push(group);
  }
  return { tree, elsewhere };
}

/** What the fleet's toggle says: everything going, and everything waiting on a person. */
export function fleetSummary(groups: readonly FleetGroup[]): { running: number; needsYou: number; attention: Attention } {
  let running = 0;
  let needsYou = 0;
  for (const group of groups) {
    running += group.running;
    needsYou += group.needsYou;
  }
  return { running, needsYou, attention: highestAttention(groups.map((group) => group.attention)) };
}
