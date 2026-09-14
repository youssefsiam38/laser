/**
 * The worker's task index (D-163): fed from `lasercode/task/update` messages
 * going past, read by the harness for `inspect_fleet` and for `task_output`
 * on a child's command. And the bounded tail read behind that.
 */
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { TASK_OUTPUT_MAX_BYTES, type BackgroundTaskUpdate } from "@lasercode/protocol";
import { MAX_CLOSED_SESSIONS, MAX_INDEXED_TASKS_PER_SESSION, MIN_SESSION_LOG_BYTES, TaskIndex, readLogTail } from "../../src/agents/tasks.js";

const retention = (partial: Partial<Parameters<TaskIndex["observe"]>[1] extends never ? never : never> | Record<string, number> = {}) => ({
  live: 0,
  terminal: 0,
  liveTailBytes: 0,
  excerptBytes: 0,
  logBytes: 0,
  evicted: 0,
  released: 0,
  ...partial,
});

const dirs: string[] = [];
afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

function update(partial: Partial<BackgroundTaskUpdate> & Pick<BackgroundTaskUpdate, "id">): BackgroundTaskUpdate {
  return { command: `echo ${partial.id}`, title: `echo ${partial.id}`, status: "running", origin: "background", startedAt: "2026-09-09T10:00:00.000Z", outputBytes: 0, ...partial };
}

describe("TaskIndex retained state and the per-worker log budget (RP-6)", () => {
  it("reports what its sessions hold, and forgets it when a session closes", () => {
    const index = new TaskIndex();
    index.observe("/s/a.jsonl", { type: "lasercode/task/update", task: update({ id: "t-1" }) });
    index.observe("/s/b.jsonl", { type: "lasercode/task/update", task: update({ id: "t-2" }) });
    expect(index.observe("/s/a.jsonl", { type: "lasercode/task/retention", retention: retention({ live: 1, terminal: 3, liveTailBytes: 1000, excerptBytes: 500, logBytes: 10 }) })).toBe(true);
    index.observe("/s/b.jsonl", { type: "lasercode/task/retention", retention: retention({ terminal: 2, excerptBytes: 250, logBytes: 20 }) });

    // Records are metadata; tails and excerpts are the memory they cost.
    expect(index.retainedStores()).toEqual({ taskRegistry: { count: 2, bytes: 1750 } });
    expect(index.logBytes()).toBe(30);

    index.sessionClosed("/s/b.jsonl");
    expect(index.retainedStores().taskRegistry.bytes).toBe(1500);
    expect(index.logBytes()).toBe(10);
  });

  it("hands each session a share when the worker is over its log budget, and never below the floor", () => {
    const index = new TaskIndex();
    for (const path of ["/s/a.jsonl", "/s/b.jsonl"]) {
      index.observe(path, { type: "lasercode/task/update", task: update({ id: `t-${path}` }) });
    }
    index.observe("/s/a.jsonl", { type: "lasercode/task/retention", retention: retention({ logBytes: 90 * 1024 * 1024 }) });
    index.observe("/s/b.jsonl", { type: "lasercode/task/retention", retention: retention({ logBytes: 1024 }) });

    // Inside the budget: nobody is asked to release anything.
    expect(index.logBudgets(200 * 1024 * 1024)).toEqual([]);

    // Over it: the biggest holder is told what it may keep, the small one is
    // left alone, and the share never drops below one segment.
    const budgets = index.logBudgets(64 * 1024 * 1024);
    expect(budgets.map((budget) => budget.path)).toEqual(["/s/a.jsonl"]);
    expect(budgets[0]!.bytes).toBeGreaterThanOrEqual(MIN_SESSION_LOG_BYTES);
    expect(index.logBudgets(1)[0]!.bytes).toBe(MIN_SESSION_LOG_BYTES);
  });

  it("moves a session's retention with it when a fork rekeys the path", () => {
    const index = new TaskIndex();
    index.observe("/s/old.jsonl", { type: "lasercode/task/update", task: update({ id: "t-1" }) });
    index.observe("/s/old.jsonl", { type: "lasercode/task/retention", retention: retention({ logBytes: 42, excerptBytes: 7 }) });
    index.rekeySession("/s/old.jsonl", "/s/new.jsonl");
    expect(index.logBytes()).toBe(42);
    expect(index.retainedStores()).toEqual({ taskRegistry: { count: 1, bytes: 7 } });
  });
});

describe("TaskIndex", () => {
  it("keeps one record per task per session, stamped with the session, replacing in place and remembering the log path", () => {
    const index = new TaskIndex();
    expect(index.observe("/s/a.jsonl", { type: "lasercode/capabilities", active: [], failed: [] })).toBe(false);
    expect(index.observe("/s/a.jsonl", { type: "lasercode/task/update", task: update({ id: "t-1", logPath: "/tmp/t-1.log" }) })).toBe(true);
    index.observe("/s/a.jsonl", { type: "lasercode/task/update", task: update({ id: "t-2" }) });
    index.observe("/s/b.jsonl", { type: "lasercode/task/update", task: update({ id: "t-1", status: "completed", exitCode: 0 }) });
    expect(index.tasksOf("/s/a.jsonl").map((task) => [task.id, task.sessionPath, task.logPath])).toEqual([
      ["t-1", "/s/a.jsonl", "/tmp/t-1.log"],
      ["t-2", "/s/a.jsonl", undefined],
    ]);
    // Same id, another session: another task.
    expect(index.tasksOf("/s/b.jsonl")).toEqual([expect.objectContaining({ id: "t-1", status: "completed", sessionPath: "/s/b.jsonl" })]);
    // An update without the log path keeps the one already known; one with it replaces it.
    index.observe("/s/a.jsonl", { type: "lasercode/task/update", task: update({ id: "t-1", status: "failed", exitCode: 2, outputBytes: 12 }) });
    expect(index.tasksOf("/s/a.jsonl")[0]).toMatchObject({ id: "t-1", status: "failed", exitCode: 2, outputBytes: 12, logPath: "/tmp/t-1.log" });
    expect(index.tasksOf("/s/a.jsonl")).toHaveLength(2);
    expect(index.tasksOf("/s/none.jsonl")).toEqual([]);
  });

  it("marks what was still running as stopped when the session closes, and leaves ended tasks alone", () => {
    const index = new TaskIndex();
    index.observe("/s/a.jsonl", { type: "lasercode/task/update", task: update({ id: "t-live" }) });
    index.observe("/s/a.jsonl", { type: "lasercode/task/update", task: update({ id: "t-done", status: "completed", exitCode: 0, endedAt: "2026-09-09T10:01:00.000Z" }) });
    index.sessionClosed("/s/a.jsonl");
    index.sessionClosed("/s/unknown.jsonl");
    const [live, done] = index.tasksOf("/s/a.jsonl");
    expect(live).toMatchObject({ id: "t-live", status: "stopped", exitCode: null, terminalReason: "the session ended", endedAt: expect.any(String) });
    expect(done).toMatchObject({ id: "t-done", status: "completed", exitCode: 0, endedAt: "2026-09-09T10:01:00.000Z" });
  });

  it("forgets the oldest finished tasks past the cap, never a running one", () => {
    const index = new TaskIndex();
    index.observe("/s/a.jsonl", { type: "lasercode/task/update", task: update({ id: "t-first-live" }) });
    for (let i = 0; i < MAX_INDEXED_TASKS_PER_SESSION + 5; i++) {
      index.observe("/s/a.jsonl", { type: "lasercode/task/update", task: update({ id: `t-${i}`, status: "completed", exitCode: 0 }) });
    }
    const kept = index.tasksOf("/s/a.jsonl");
    expect(kept).toHaveLength(MAX_INDEXED_TASKS_PER_SESSION);
    expect(kept[0]!.id).toBe("t-first-live");
    expect(kept.some((task) => task.id === "t-0")).toBe(false);
    expect(kept.at(-1)!.id).toBe(`t-${MAX_INDEXED_TASKS_PER_SESSION + 4}`);
  });

  it("forgets the commands of long-closed sessions, never those of an open one", () => {
    const index = new TaskIndex();
    // An open session, and one that closed before all the others.
    index.observe("/s/open.jsonl", { type: "lasercode/task/update", task: update({ id: "t-open" }) });
    index.observe("/s/first.jsonl", { type: "lasercode/task/update", task: update({ id: "t-first" }) });
    index.sessionClosed("/s/first.jsonl");
    for (let i = 0; i < MAX_CLOSED_SESSIONS; i++) {
      const path = `/s/closed-${i}.jsonl`;
      index.observe(path, { type: "lasercode/task/update", task: update({ id: `t-${i}` }) });
      index.sessionClosed(path);
    }

    expect(index.tasksOf("/s/first.jsonl")).toEqual([]); // the oldest closed session is gone
    expect(index.tasksOf(`/s/closed-${MAX_CLOSED_SESSIONS - 1}.jsonl`)).toHaveLength(1);
    expect(index.tasksOf("/s/open.jsonl")).toHaveLength(1); // never counted, never dropped

    // A session that opens again is live again, and outlasts the newer closures.
    const reopened = `/s/closed-${MAX_CLOSED_SESSIONS - 1}.jsonl`;
    index.observe(reopened, { type: "lasercode/task/update", task: update({ id: "t-again" }) });
    for (let i = 0; i < MAX_CLOSED_SESSIONS; i++) {
      const path = `/s/late-${i}.jsonl`;
      index.observe(path, { type: "lasercode/task/update", task: update({ id: `l-${i}` }) });
      index.sessionClosed(path);
    }
    expect(index.tasksOf(reopened)).toHaveLength(2);
    expect(index.tasksOf("/s/open.jsonl")).toHaveLength(1);
  });
});

describe("readLogTail", () => {
  it("returns the last lines, bounded to the same window the host serves, and nothing for a file it cannot read", async () => {
    const dir = mkdtempSync(join(tmpdir(), "task-tail-"));
    dirs.push(dir);
    const log = join(dir, "t.log");
    writeFileSync(log, "one\ntwo\nthree\n");
    expect(await readLogTail(log, 2)).toBe("two\nthree");
    expect(await readLogTail(log, 10)).toBe("one\ntwo\nthree");
    expect(await readLogTail(log, 0)).toBe("three");
    writeFileSync(log, "");
    expect(await readLogTail(log, 5)).toBe("");
    expect(await readLogTail(join(dir, "missing.log"), 5)).toBeUndefined();
    expect(await readLogTail(undefined, 5)).toBeUndefined();
    expect(await readLogTail("relative.log", 5)).toBeUndefined();
    // Past the window only the tail is read, aligned to a character boundary.
    const big = join(dir, "big.log");
    const line = "é".repeat(50) + "\n";
    const lines = Math.ceil((TASK_OUTPUT_MAX_BYTES * 1.5) / Buffer.byteLength(line));
    writeFileSync(big, line.repeat(lines) + "last\n");
    const tail = await readLogTail(big, 3);
    expect(tail).toBe(`${"é".repeat(50)}\n${"é".repeat(50)}\nlast`);
    expect(tail).not.toContain("�");
  });
});
