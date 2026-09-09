/**
 * The tree an agent reads through `inspect_fleet` (D-163), and the promise
 * behind it: it is the tree the person's fleet column draws. The second
 * describe feeds one fixture to the worker's builder and to the UI's
 * `buildFleet` / `scopeFleet` and compares row for row — structure, order,
 * titles and status words. Neither side imports the other in production; this
 * test is where they are held to agree.
 */
import { describe, expect, it } from "vitest";
import type { AgentRun, BackgroundTask } from "@lasercode/protocol";
import { buildFleetTree, FLEET_STATUS_WORD, flattenFleetRows, formatElapsed } from "../../src/agents/fleet.js";
import { buildFleet, FLEET_STATE_LABEL, flattenFleet, scopeFleet } from "../../../ui/src/fleet/model.js";

const ROOT = "/sessions/root.jsonl";
const NOW = Date.parse("2026-09-09T10:10:00.000Z");

function run(partial: Partial<AgentRun> & Pick<AgentRun, "runId" | "sessionPath" | "subagentName" | "startedAt">): AgentRun {
  return {
    agentName: "worker",
    sessionId: `id-${partial.sessionPath}`,
    projectCwd: "/repo",
    rootSessionPath: ROOT,
    depth: 1,
    parent: { sessionPath: ROOT, sessionId: "root-1" },
    worktree: null,
    origin: "agent",
    status: "running",
    task: `Task for ${partial.subagentName}`,
    updatedAt: partial.startedAt,
    ...partial,
  };
}

function task(partial: Partial<BackgroundTask> & Pick<BackgroundTask, "id" | "sessionPath" | "startedAt">): BackgroundTask {
  return {
    command: `echo ${partial.id}`,
    title: `echo ${partial.id}`,
    status: "running",
    origin: "background",
    outputBytes: 0,
    ...partial,
  };
}

/**
 * One tree with everything in it: a child paused on a question with a child
 * of its own and a failed command; a child that ended blocked; a child the
 * person ended; a child that finished; the root's own commands, one live and
 * one done. Started at distinct times, in an order that is not the order of
 * attention, so both sides have to sort the same way.
 */
const runs: AgentRun[] = [
  run({ runId: "run_1", sessionPath: "/sessions/c1.jsonl", subagentName: "migrate", startedAt: "2026-09-09T10:00:00.000Z", status: "needs_input", question: { id: "q", kind: "select", title: "Which database?", options: ["a", "b"], askedAt: "2026-09-09T10:05:00.000Z" }, activity: { turns: 2, tools: 3, currentTool: "bash", lastAt: "2026-09-09T10:05:00.000Z" } }),
  run({ runId: "run_2", sessionPath: "/sessions/c2.jsonl", subagentName: "review", startedAt: "2026-09-09T10:01:00.000Z", status: "blocked", endedAt: "2026-09-09T10:04:00.000Z", result: { status: "blocked", message: "Which config is canonical?" } }),
  run({ runId: "run_3", sessionPath: "/sessions/g1.jsonl", subagentName: "check-tests", startedAt: "2026-09-09T10:02:00.000Z", depth: 2, parent: { sessionPath: "/sessions/c1.jsonl", sessionId: "id-/sessions/c1.jsonl" }, activity: { turns: 1, tools: 1, label: "Reading packages/ui/src/store.ts", lastAt: "2026-09-09T10:03:00.000Z" } }),
  run({ runId: "run_4", sessionPath: "/sessions/c3.jsonl", subagentName: "ended", startedAt: "2026-09-09T10:03:00.000Z", status: "cancelled", endedAt: "2026-09-09T10:06:00.000Z", endedBy: { initiator: "user" } }),
  // A second run in the first child's session: the row stands on this one.
  run({ runId: "run_5", sessionPath: "/sessions/c4.jsonl", subagentName: "done", startedAt: "2026-09-09T10:04:00.000Z", status: "completed", endedAt: "2026-09-09T10:07:00.000Z", result: { status: "completed", message: "Counted the files.\nThere are 3." } }),
];
const tasks: BackgroundTask[] = [
  task({ id: "t-dev", sessionPath: ROOT, startedAt: "2026-09-09T09:55:00.000Z", title: "pnpm vite dev", command: "pnpm vite dev --host", activity: "ready in 412 ms" }),
  task({ id: "t-test", sessionPath: "/sessions/c1.jsonl", startedAt: "2026-09-09T10:01:30.000Z", title: "pnpm test", command: "pnpm test", status: "failed", exitCode: 1, endedAt: "2026-09-09T10:02:30.000Z", terminalReason: "exit code 1", activity: "1 failed | 660 passed" }),
  task({ id: "t-build", sessionPath: ROOT, startedAt: "2026-09-09T10:08:00.000Z", title: "pnpm -r build", command: "pnpm -r build", status: "completed", exitCode: 0, endedAt: "2026-09-09T10:09:00.000Z" }),
];
const tasksOf = (path: string): BackgroundTask[] => tasks.filter((candidate) => candidate.sessionPath === path);

describe("buildFleetTree", () => {
  it("nests as the tree nests, orders by creation, and says each row in the fleet's words", () => {
    const fleet = buildFleetTree({ callerPath: ROOT, runs, tasksOf, now: NOW });
    expect(fleet).toMatchObject({ working: 3, needsYou: 2, finished: 5, total: 8, omitted: 0 });
    expect(fleet.rows.map((row) => row.title)).toEqual(["migrate", "review", "ended", "done", "pnpm vite dev", "pnpm -r build"]);
    const [migrate, review, ended, done, dev, build] = fleet.rows;
    expect(migrate).toMatchObject({ kind: "agent", agentName: "worker", subagentName: "migrate", sessionId: "id-/sessions/c1.jsonl", runId: "run_1", state: "needs_input", status: "Asking", line: "Which database?", elapsed: "10m 00s", depth: 0 });
    expect(migrate!.children.map((row) => row.title)).toEqual(["check-tests", "pnpm test"]);
    expect(migrate!.children[0]).toMatchObject({ kind: "agent", runId: "run_3", status: "Working", line: "Reading packages/ui/src/store.ts", elapsed: "8m 00s", depth: 1, children: [] });
    expect(migrate!.children[1]).toMatchObject({ kind: "command", taskId: "t-test", state: "failed", status: "Failed", line: "exit code 1", exitCode: 1, elapsed: "1m 00s", depth: 1 });
    expect(review).toMatchObject({ kind: "agent", runId: "run_2", state: "blocked", status: "Needs you", line: "Which config is canonical?", elapsed: "3m 00s", endedAt: "2026-09-09T10:04:00.000Z" });
    expect(ended).toMatchObject({ state: "cancelled", status: "Ended", line: "the person ended it" });
    // A final message is one line, its first.
    expect(done).toMatchObject({ state: "completed", status: "Done", line: "Counted the files.", elapsed: "3m 00s" });
    expect(dev).toMatchObject({ kind: "command", taskId: "t-dev", state: "running", status: "Working", line: "ready in 412 ms", elapsed: "15m 00s", depth: 0 });
    expect(dev).not.toHaveProperty("exitCode");
    expect(build).toMatchObject({ kind: "command", state: "completed", status: "Done", line: "exit code 0", exitCode: 0 });
  });

  it("scopes to the caller: a child sees its subtree, a leaf sees nothing, a stranger sees nothing", () => {
    const child = buildFleetTree({ callerPath: "/sessions/c1.jsonl", runs, tasksOf, now: NOW });
    expect(child.rows.map((row) => row.title)).toEqual(["check-tests", "pnpm test"]);
    expect(child.rows[0]).toMatchObject({ depth: 0, runId: "run_3" });
    expect(child).toMatchObject({ working: 1, needsYou: 0, finished: 1, total: 2 });
    expect(buildFleetTree({ callerPath: "/sessions/g1.jsonl", runs, tasksOf, now: NOW })).toEqual({ rows: [], working: 0, needsYou: 0, finished: 0, total: 0, omitted: 0 });
    expect(buildFleetTree({ callerPath: "/sessions/other.jsonl", runs, tasksOf, now: NOW }).rows).toEqual([]);
  });

  it("stands each session on its newest run, and falls back to the task when a live run has said nothing", () => {
    const again = run({ runId: "run_9", sessionPath: "/sessions/c4.jsonl", subagentName: "done", startedAt: "2026-09-09T10:09:00.000Z", task: "One more thing." });
    const fleet = buildFleetTree({ callerPath: ROOT, runs: [...runs, again], tasksOf: () => [], now: NOW });
    const row = fleet.rows.find((candidate) => candidate.title === "done")!;
    expect(row).toMatchObject({ kind: "agent", runId: "run_9", state: "running", status: "Working", line: "One more thing.", elapsed: "1m 00s" });
    // Its place in the order is still where its first run put it.
    expect(fleet.rows.map((candidate) => candidate.title)).toEqual(["migrate", "review", "ended", "done"]);
    expect(fleet.rows.filter((candidate) => candidate.title === "done")).toHaveLength(1);
  });

  it("cuts the deepest rows first, newest first among them, and counts what it cut", () => {
    const deep: AgentRun[] = [];
    for (let i = 0; i < 3; i++) {
      deep.push(run({ runId: `run_c${i}`, sessionPath: `/sessions/d${i}.jsonl`, subagentName: `c${i}`, startedAt: `2026-09-09T10:0${i}:00.000Z` }));
      for (let j = 0; j < 3; j++) {
        deep.push(run({ runId: `run_g${i}${j}`, sessionPath: `/sessions/d${i}-${j}.jsonl`, subagentName: `g${i}${j}`, startedAt: `2026-09-09T10:0${i}:${j}0.000Z`, depth: 2, parent: { sessionPath: `/sessions/d${i}.jsonl`, sessionId: "x" } }));
      }
    }
    const fleet = buildFleetTree({ callerPath: ROOT, runs: deep, tasksOf: () => [], now: NOW, maxRows: 7 });
    expect(fleet).toMatchObject({ total: 12, omitted: 5, working: 12 });
    expect(flattenFleetRows(fleet.rows)).toHaveLength(7);
    // Every top-level row stays; the grandchildren go newest first.
    expect(fleet.rows.map((row) => [row.title, row.children.map((child) => child.title)])).toEqual([
      ["c0", ["g00", "g01", "g02"]],
      ["c1", ["g10"]],
      ["c2", []],
    ]);
    // Cutting reaches the top level only once everything below it is gone.
    const flat = buildFleetTree({ callerPath: ROOT, runs: deep, tasksOf: () => [], now: NOW, maxRows: 2 });
    expect(flat).toMatchObject({ omitted: 10 });
    expect(flat.rows.map((row) => [row.title, row.children.length])).toEqual([
      ["c0", 0],
      ["c1", 0],
    ]);
    expect(buildFleetTree({ callerPath: ROOT, runs: deep, tasksOf: () => [], now: NOW, maxRows: 12 }).omitted).toBe(0);
  });

  it("formats elapsed time the way the column does, and leaves it out when the start is unknown", () => {
    expect(formatElapsed(0)).toBe("0s");
    expect(formatElapsed(59_999)).toBe("59s");
    expect(formatElapsed(252_000)).toBe("4m 12s");
    expect(formatElapsed(3_780_000)).toBe("1h 03m");
    const fleet = buildFleetTree({ callerPath: ROOT, runs: [run({ runId: "r", sessionPath: "/sessions/x.jsonl", subagentName: "x", startedAt: "not a date" })], tasksOf: () => [], now: NOW });
    expect(fleet.rows[0]).not.toHaveProperty("elapsed");
  });
});

/**
 * The agreement. `packages/ui/src/fleet/model.ts` is the person's fleet;
 * `packages/worker/src/agents/fleet.ts` is the agent's. Same fixture in, same
 * rows out: kind, title, status word, depth, order. If this fails, one side
 * changed its words and the other must follow.
 */
describe("the agent's fleet agrees with the person's", () => {
  it("uses the same status words", () => {
    expect(FLEET_STATUS_WORD).toEqual(FLEET_STATE_LABEL);
  });

  it("draws the same rows in the same order for one fixture", () => {
    const ours = flattenFleetRows(buildFleetTree({ callerPath: ROOT, runs, tasksOf, now: NOW }).rows).map((row) => ({
      kind: row.kind,
      title: row.title,
      status: row.status,
      depth: row.depth,
      id: row.kind === "agent" ? row.runId : row.taskId,
    }));
    const groups = buildFleet({ sessions: [], runs: Object.fromEntries(runs.map((candidate) => [candidate.runId, candidate])), tasks: Object.fromEntries(tasks.map((candidate) => [candidate.id, candidate])), views: {}, currentPath: ROOT, sessionsLoaded: false, now: NOW });
    const theirs = flattenFleet(scopeFleet(groups, ROOT).tree!.items).map((item) => ({
      // The column's `task` is the kind; `command` is the word the row wears.
      kind: item.kind === "task" ? "command" : item.kind,
      title: item.title,
      status: FLEET_STATE_LABEL[item.state],
      depth: item.depth,
      id: item.kind === "agent" ? item.run!.runId : item.task!.id,
    }));
    expect(ours).toEqual(theirs);
    expect(ours).toHaveLength(8);
    // And the counts the header says.
    const tree = scopeFleet(groups, ROOT).tree!;
    const fleet = buildFleetTree({ callerPath: ROOT, runs, tasksOf, now: NOW });
    expect({ running: fleet.working, needsYou: fleet.needsYou }).toEqual({ running: tree.running, needsYou: tree.needsYou });
  });

  it("agrees on what a live row is doing and how an ended one ended", () => {
    const groups = buildFleet({ sessions: [], runs: Object.fromEntries(runs.map((candidate) => [candidate.runId, candidate])), tasks: Object.fromEntries(tasks.map((candidate) => [candidate.id, candidate])), views: {}, currentPath: ROOT, sessionsLoaded: false, now: NOW });
    const theirs = flattenFleet(scopeFleet(groups, ROOT).tree!.items);
    const ours = flattenFleetRows(buildFleetTree({ callerPath: ROOT, runs, tasksOf, now: NOW }).rows);
    for (const [i, item] of theirs.entries()) {
      const row = ours[i]!;
      // The column's activity line is the agent's line while the work goes on.
      if (item.activity !== undefined) expect(row.line).toBe(item.activity);
      // Its reason for ending is the agent's line once it has, with "you" turned into "the person".
      if (item.terminalReason !== undefined) expect(row.line).toBe(item.terminalReason.replace(/^you\b/, "the person"));
      // Elapsed is the same number, formatted the same way.
      if (item.elapsedMs !== undefined) expect(row.elapsed).toBe(formatElapsed(item.elapsedMs));
      else expect(row).not.toHaveProperty("elapsed");
    }
  });
});
