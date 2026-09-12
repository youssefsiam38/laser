/**
 * The fleet as an agent reads it (`inspect_fleet`, D-163): the tree of work
 * under one session — the agents it started, theirs, and the background
 * commands any of them left running or finished — in the words the person's
 * fleet column uses for the same rows.
 *
 * This file mirrors `packages/ui/src/fleet/model.ts` on purpose and does not
 * import it (nothing in the worker imports the UI). The two must agree on
 * structure (agent items nest as the tree nests; a session's commands hang off
 * the row for the session that ran them, after its child agents), on ordering
 * (creation order, never attention order), on each row's title (the agent's
 * instance name, the command's first line) and on the status word
 * (`FLEET_STATUS_WORD` below is the UI's `FLEET_STATE_LABEL`). A worker test
 * feeds one fixture to both and compares; change one side, and it tells you.
 *
 * Pure: runs, a task lookup and a clock in — rows out. Nothing here reads a
 * file or an engine.
 */
import { AGENT_FLEET_ROWS_MAX, isTerminalRunStatus, type AgentRun, type BackgroundTask } from "@lasercode/protocol";
import type { FleetAgentRow, FleetCommandRow, FleetRow, FleetRowState, InspectFleetResult } from "./bridge.js";

/**
 * The status word beside every row. Must equal the UI's `FLEET_STATE_LABEL`
 * word for word: the person reading the column and the agent reading this
 * result are looking at the same work.
 */
export const FLEET_STATUS_WORD: Readonly<Record<FleetRowState, string>> = {
  queued: "Waiting",
  running: "Working",
  needs_input: "Asking",
  blocked: "Blocked",
  completed: "Done",
  failed: "Failed",
  cancelled: "Ended",
};

/** A command's status in the row vocabulary (the UI's `TASK_STATE`). */
const COMMAND_STATE: Readonly<Record<BackgroundTask["status"], FleetRowState>> = {
  running: "running",
  completed: "completed",
  failed: "failed",
  stopped: "cancelled",
};

/** How much of a final message, a task, or a last line one row carries. */
const LINE_MAX = 160;

export interface FleetTreeInput {
  /** The session whose tree this is: rows are everything under it, never it. */
  callerPath: string;
  /** Every run the harness knows, in creation order. */
  runs: readonly AgentRun[];
  /** The background commands one session started, oldest first. */
  tasksOf: (sessionPath: string) => readonly BackgroundTask[];
  now: number;
  /** Rows to keep; the rest are cut deepest-first. Defaults to `AGENT_FLEET_ROWS_MAX`. */
  maxRows?: number;
}

const time = (value: string | undefined): number => {
  const parsed = value === undefined ? Number.NaN : Date.parse(value);
  return Number.isNaN(parsed) ? 0 : parsed;
};

/** 1 for a run that can still act (`running`, `needs_input`), 0 for one that waits or has ended: nothing outranks a run that can still write. */
const liveness = (run: AgentRun): number => (run.status === "queued" || isTerminalRunStatus(run.status) ? 0 : 1);

/**
 * When a session's first run started — its place among its siblings, fixed
 * for good. Read across every run rather than from the head of the sorted
 * list, whose head is the run least able to act (a queued successor during a
 * declared completion), not the oldest. Mirrors `run-tree.ts` `startedAt`.
 */
function earliestStart(runs: readonly AgentRun[]): number {
  let earliest = 0;
  for (const run of runs) {
    const started = time(run.startedAt);
    if (started > 0 && (earliest === 0 || started < earliest)) earliest = started;
  }
  return earliest;
}

/** `4m 12s`, as the fleet column formats it (`packages/ui/src/format.ts`, `formatElapsed`). */
export function formatElapsed(ms: number): string {
  const s = Math.floor(ms / 1000);
  if (s < 60) return `${s}s`;
  const m = Math.floor(s / 60);
  if (m < 60) return `${m}m ${String(s % 60).padStart(2, "0")}s`;
  const h = Math.floor(m / 60);
  return `${h}h ${String(m % 60).padStart(2, "0")}m`;
}

function elapsed(startedAt: string | undefined, endedAt: string | undefined, live: boolean, now: number): string | undefined {
  const start = time(startedAt);
  if (!start) return undefined;
  const end = endedAt ? time(endedAt) : live ? now : undefined;
  return end === undefined || end === 0 ? undefined : formatElapsed(Math.max(0, end - start));
}

/** The first line of a text, cut to one row's width. */
function oneLine(text: string | undefined): string | undefined {
  const line = text?.split("\n").find((candidate) => candidate.trim() !== "")?.trim();
  if (!line) return undefined;
  return line.length > LINE_MAX ? `${line.slice(0, LINE_MAX - 1)}…` : line;
}

/**
 * The fleet's ending words are written for the person ("you ended it"); the
 * same fact for the agent names the person instead. Only the pronoun changes.
 */
function forAgent(reason: string | undefined): string | undefined {
  if (reason === undefined) return undefined;
  return reason.replace(/^you\b/i, "the person");
}

/** How a run ended, in one line: the fleet's `reasonOfRun`, then the final message it shows expanded. */
function endingOfRun(run: AgentRun): string | undefined {
  if (run.endedBy?.reason) return oneLine(run.endedBy.reason);
  if (run.error) return oneLine(run.error);
  if (run.status === "cancelled") return run.endedBy?.initiator === "user" ? "the person ended it" : "the parent ended it";
  if (run.result) return oneLine(run.result.message);
  return undefined;
}

/** What a live run is doing, in its own words: the fleet's `activity`. */
function activityOfRun(run: AgentRun): string | undefined {
  if (run.status === "needs_input" && run.question) return oneLine(run.question.title);
  return oneLine(run.activity?.label) ?? (run.activity?.currentTool ? `Running ${run.activity.currentTool}` : undefined);
}

function commandRow(task: BackgroundTask, depth: number, now: number): FleetCommandRow {
  const state = COMMAND_STATE[task.status];
  const live = task.status === "running";
  const ending = live ? undefined : (forAgent(task.terminalReason) ?? (task.exitCode !== undefined ? `exit code ${task.exitCode ?? "none"}` : undefined));
  const line = live ? oneLine(task.activity) : ending;
  const when = elapsed(task.startedAt, task.endedAt, live, now);
  return {
    kind: "command",
    taskId: task.id,
    title: task.title,
    state,
    status: FLEET_STATUS_WORD[state],
    ...(when !== undefined ? { elapsed: when } : {}),
    ...(line !== undefined ? { line } : {}),
    startedAt: task.startedAt,
    ...(task.endedAt !== undefined ? { endedAt: task.endedAt } : {}),
    ...(task.exitCode !== undefined ? { exitCode: task.exitCode } : {}),
    depth,
    children: [],
  };
}

function agentRow(run: AgentRun, depth: number, now: number): FleetAgentRow {
  const live = !isTerminalRunStatus(run.status);
  const state: FleetRowState = run.status;
  const line = live ? (activityOfRun(run) ?? oneLine(run.task)) : (endingOfRun(run) ?? oneLine(run.task));
  const when = elapsed(run.startedAt, run.endedAt, live, now);
  return {
    kind: "agent",
    agentName: run.agentName,
    subagentName: run.subagentName,
    sessionId: run.sessionId,
    runId: run.runId,
    title: run.subagentName,
    ...(run.worktree?.environment ? { environment: run.worktree.environment } : {}),
    ...(run.worktree?.setup ? { setup: run.worktree.setup } : {}),
    state,
    status: FLEET_STATUS_WORD[state],
    ...(when !== undefined ? { elapsed: when } : {}),
    ...(line !== undefined ? { line } : {}),
    startedAt: run.startedAt,
    ...(run.endedAt !== undefined ? { endedAt: run.endedAt } : {}),
    depth,
    children: [],
  };
}

/** Every row of a tree, depth-first in row order. */
export function flattenFleetRows(rows: readonly FleetRow[]): FleetRow[] {
  const out: FleetRow[] = [];
  const walk = (list: readonly FleetRow[]): void => {
    for (const row of list) {
      out.push(row);
      walk(row.children);
    }
  };
  walk(rows);
  return out;
}

/**
 * The tree under `callerPath`. A session appears once, standing on its newest
 * run (the fleet does the same: one row per child session); its children are
 * the sessions whose newest run names it as parent, in the order their first
 * run started, then the commands it ran, oldest first.
 */
export function buildFleetTree(input: FleetTreeInput): InspectFleetResult {
  const { callerPath, now } = input;
  const maxRows = input.maxRows ?? AGENT_FLEET_ROWS_MAX;

  // Runs by session, oldest first: the newest stands for the row, the oldest
  // fixes its place in the order.
  const runsBySession = new Map<string, AgentRun[]>();
  for (const run of input.runs) {
    const list = runsBySession.get(run.sessionPath);
    if (list) list.push(run);
    else runsBySession.set(run.sessionPath, [run]);
  }
  // A same-millisecond follow-up must not lose to its terminal predecessor's
  // random ID. Match the UI's newest-run comparator, in ascending order —
  // with one rule in front of it: a run that is still executing stands for
  // its session over one that only waits behind it. While a declared
  // completion unwinds, the old invocation can still write, and the row says
  // Working until it truly cannot; the successor is Waiting, not the session.
  for (const list of runsBySession.values()) list.sort((a, b) =>
    liveness(a) - liveness(b)
    || time(a.startedAt) - time(b.startedAt)
    || Number(isTerminalRunStatus(b.status)) - Number(isTerminalRunStatus(a.status))
    || time(a.updatedAt) - time(b.updatedAt)
    || a.runId.localeCompare(b.runId));

  const childrenOf = new Map<string, string[]>();
  for (const [path, runs] of runsBySession) {
    const parent = runs[runs.length - 1]!.parent?.sessionPath;
    if (parent === undefined) continue;
    const list = childrenOf.get(parent);
    if (list) list.push(path);
    else childrenOf.set(parent, [path]);
  }
  for (const list of childrenOf.values()) list.sort((a, b) => earliestStart(runsBySession.get(a)!) - earliestStart(runsBySession.get(b)!) || a.localeCompare(b));

  const seen = new Set<string>([callerPath]);
  const build = (path: string, depth: number): FleetRow[] => {
    const rows: FleetRow[] = [];
    for (const childPath of childrenOf.get(path) ?? []) {
      if (seen.has(childPath)) continue;
      seen.add(childPath);
      const runs = runsBySession.get(childPath)!;
      const row = agentRow(runs[runs.length - 1]!, depth, now);
      row.children = build(childPath, depth + 1);
      rows.push(row);
    }
    for (const task of input.tasksOf(path)) rows.push(commandRow(task, depth, now));
    return rows;
  };
  const rows = build(callerPath, 0);

  let working = 0;
  let needsYou = 0;
  let finished = 0;
  const all = flattenFleetRows(rows);
  for (const row of all) {
    if (isTerminalRunStatus(row.state)) finished += 1;
    else working += 1;
    if (row.state === "needs_input") needsYou += 1;
  }

  const omitted = cutDeepestFirst(rows, all.length, maxRows);
  return { rows, working, needsYou, finished, total: all.length, omitted };
}

/**
 * Keep at most `maxRows`, dropping the deepest rows first and, at one depth,
 * the newest first — the rows a parent can least act on directly, and the
 * ones `inspect_agent` on their parent row still reaches. Returns how many
 * were dropped. Mutates the tree in place.
 */
function cutDeepestFirst(rows: FleetRow[], total: number, maxRows: number): number {
  let remaining = total;
  if (remaining <= maxRows) return 0;
  const byDepth = new Map<number, Array<{ row: FleetRow; siblings: FleetRow[] }>>();
  const index = (list: FleetRow[]): void => {
    for (const row of list) {
      const bucket = byDepth.get(row.depth);
      if (bucket) bucket.push({ row, siblings: list });
      else byDepth.set(row.depth, [{ row, siblings: list }]);
      index(row.children);
    }
  };
  index(rows);
  const depths = [...byDepth.keys()].sort((a, b) => b - a);
  for (const depth of depths) {
    const bucket = byDepth.get(depth)!;
    while (bucket.length > 0 && remaining > maxRows) {
      const { row, siblings } = bucket.pop()!;
      const at = siblings.indexOf(row);
      if (at !== -1) siblings.splice(at, 1);
      remaining -= 1;
    }
    if (remaining <= maxRows) break;
  }
  return total - remaining;
}
