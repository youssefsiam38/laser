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
 */
import { highestAttention, isTerminalRunStatus, type AgentRun, type Attention, type BackgroundTask, type SessionSummary } from "@lasercode/protocol";
import { buildAgentTree, createAncestryIndex, type AgentTreeNode } from "../agents/run-tree.js";
import { runStatusTone, type AgentStatusTone } from "../agents/model.js";
import { sessionTitle } from "../runtime/threadList.js";
import type { SessionView } from "../store.js";

export type FleetItemKind = "agent" | "task";

/** What the row's dot and word say. Both vocabularies map onto this one. */
export type FleetState =
  | "queued"
  | "running"
  | "blocked"
  | "completed"
  | "failed"
  | "cancelled";

export const FLEET_STATE_LABEL: Readonly<Record<FleetState, string>> = {
  queued: "Waiting",
  running: "Working",
  blocked: "Needs you",
  completed: "Done",
  failed: "Failed",
  cancelled: "Ended",
};

const STATE_ATTENTION: Readonly<Record<FleetState, Attention>> = {
  queued: "working",
  running: "working",
  blocked: "waiting_for_input",
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
   * One line, the work's own words — the agent's activity, the task's last
   * line. Only while the work is going: "Running complete_agent_run" on a run
   * that finished a minute ago is the last true thing it said, and reading it
   * as the present tense is worse than reading nothing.
   */
  activity: string | undefined;
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
  items: FleetItem[];
  /** Items still going, anywhere in the group. */
  running: number;
  /** Items that need a person, anywhere in the group. */
  needsYou: number;
  attention: Attention;
}

export interface FleetInput {
  sessions: readonly SessionSummary[];
  runs: Readonly<Record<string, AgentRun>>;
  tasks: Readonly<Record<string, BackgroundTask>>;
  views: Readonly<Record<string, SessionView | undefined>>;
  /** The session the person is looking at, so "orphaned" means what it says. */
  currentPath?: string | undefined;
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
    activity: task.status === "running" ? task.activity : undefined,
    terminalReason: task.terminalReason,
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
  return {
    key: `agent:${node.sessionPath}`,
    kind: "agent",
    title: node.subagentName ?? node.title,
    subtitle: run?.task,
    state,
    tone: node.status === "idle" ? "muted" : node.status === "working" ? "live" : runStatusTone(node.status),
    own,
    attention: own,
    activity: node.ended ? undefined : (run?.activity?.label ?? (run?.activity?.currentTool ? `Running ${run.activity.currentTool}` : undefined)),
    terminalReason: reasonOfRun(run),
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
function settle(items: readonly FleetItem[], counts: { running: number; needsYou: number }): Attention {
  const seen: Attention[] = [];
  for (const item of items) {
    const below = settle(item.children, counts);
    item.attention = highestAttention([item.own, below]);
    if (!item.terminal) counts.running += 1;
    if (item.own === "waiting_for_input") counts.needsYou += 1;
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
  const taskList = Object.values(tasks).sort((a, b) => time(a.startedAt) - time(b.startedAt));
  if (runList.length === 0 && taskList.length === 0) return [];

  const index = createAncestryIndex(runs, sessions);
  const tasksByPath = new Map<string, BackgroundTask[]>();
  for (const task of taskList) {
    const list = tasksByPath.get(task.sessionPath);
    if (list) list.push(task);
    else tasksByPath.set(task.sessionPath, [task]);
  }
  const tasksOf = (path: string): BackgroundTask[] => tasksByPath.get(path) ?? [];

  // One group per top-level session that has work anywhere beneath it.
  const roots = new Set<string>();
  for (const run of runList) roots.add(run.rootSessionPath || index.rootOf(run.sessionPath));
  for (const task of taskList) roots.add(index.rootOf(task.sessionPath));

  const summaries = new Map(sessions.map((summary) => [summary.path, summary]));
  const groups: FleetGroup[] = [];

  for (const rootPath of roots) {
    const tree = buildAgentTree({ rootPath, sessions, runs, views });
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

    const counts = { running: 0, needsYou: 0 };
    const attention = settle(items, counts);
    const summary = summaries.get(rootPath);
    const view = views[rootPath];
    groups.push({
      path: rootPath,
      cwd: summary?.cwd ?? view?.state.cwd ?? "",
      title: summary ? sessionTitle(summary, view) : (view?.state.name ?? rootPath.split("/").at(-1) ?? rootPath),
      orphaned: view === undefined && rootPath !== input.currentPath,
      items,
      running: counts.running,
      needsYou: counts.needsYou,
      attention,
    });
  }

  // The session you are in first — its work is the work you asked about — then
  // the busiest, then alphabetically so the rest never shuffle under you.
  return groups.sort(
    (a, b) =>
      Number(b.path === input.currentPath) - Number(a.path === input.currentPath) ||
      b.needsYou - a.needsYou ||
      b.running - a.running ||
      a.title.localeCompare(b.title),
  );
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

/**
 * A branch stays active while anything inside it is active. Moving a finished
 * child away from a live parent would make the fleet easier to scan but
 * structurally false, so lifecycle partitioning always moves whole branches.
 */
export function branchIsActive(item: FleetItem): boolean {
  return !item.terminal || item.children.some(branchIsActive);
}

export function partitionItems(items: readonly FleetItem[]): { active: FleetItem[]; finished: FleetItem[] } {
  const active: FleetItem[] = [];
  const finished: FleetItem[] = [];
  for (const item of items) (branchIsActive(item) ? active : finished).push(item);
  return { active, finished };
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
