/**
 * The worker's task index (D-163): fed from `lasercode/task/update` messages
 * going past, read by the harness for `inspect_fleet` and for `task_output`
 * on a child's command. And the bounded tail read behind that.
 */
import { mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { TASK_OUTPUT_MAX_BYTES, type BackgroundTaskRetention, type BackgroundTaskUpdate } from "@lasercode/protocol";
import { MAX_CLOSED_SESSIONS, MAX_INDEXED_TASKS_PER_SESSION, MIN_SESSION_LOG_BYTES, TaskIndex, readLogTail } from "../../src/agents/tasks.js";

const retention = (partial: Partial<BackgroundTaskRetention> = {}): BackgroundTaskRetention => ({
  live: 0,
  terminal: 0,
  liveTailBytes: 0,
  excerptBytes: 0,
  logBytes: 0,
  pendingLogBytes: 0,
  evicted: 0,
  released: 0,
  tailsShrunk: 0,
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

  it("answers what one session last said it holds, and says nothing rather than zero (RP-8)", () => {
    const index = new TaskIndex();
    index.observe("/s/a.jsonl", { type: "lasercode/task/update", task: update({ id: "t-1" }) });
    // Never published: there is no evidence, which is not the same as none held.
    expect(index.retentionOf("/s/a.jsonl")).toBeUndefined();
    const held = retention({ live: 1, terminal: 24, excerptBytes: 196_608 });
    index.observe("/s/a.jsonl", { type: "lasercode/task/retention", retention: held });
    expect(index.retentionOf("/s/a.jsonl")).toEqual(held);
    // A later snapshot replaces the earlier one, which is what makes a
    // before/after comparison meaningful.
    const after = retention({ live: 1, terminal: 20, excerptBytes: 163_840, evicted: 4 });
    index.observe("/s/a.jsonl", { type: "lasercode/task/retention", retention: after });
    expect(index.retentionOf("/s/a.jsonl")).toEqual(after);
    // A fork moves the session's file; what it holds moves with it.
    index.rekeySession("/s/a.jsonl", "/s/moved.jsonl");
    expect(index.retentionOf("/s/moved.jsonl")).toEqual(after);
    expect(index.retentionOf("/s/a.jsonl")).toBeUndefined();
    expect(index.retentionOf("/s/never.jsonl")).toBeUndefined();
  });

  it("keeps a finished command's row after the companion forgets it (RP-6/RP-8)", () => {
    const index = new TaskIndex();
    const done = update({ id: "t-gone", status: "completed", exitCode: 0, outputBytes: 4_096 });
    index.observe("/s/a.jsonl", { type: "lasercode/task/update", task: { ...done, logPath: "/logs/a/t-gone", logSegments: [0] } });
    // The companion's memory of it goes; the worker's row and its log do not,
    // which is what `task_output` falls back to.
    index.observe("/s/a.jsonl", { type: "lasercode/task/retention", retention: retention({ terminal: 0, excerptBytes: 0, evicted: 1 }) });
    const row = index.tasksOf("/s/a.jsonl").find((task) => task.id === "t-gone")!;
    expect(row).toMatchObject({ id: "t-gone", status: "completed", outputBytes: 4_096 });
    expect(row.logPath).toBe("/logs/a/t-gone");
    expect(row.logSegments).toEqual([0]);
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
    // A window is immutable segments; `logPath` is their base name (RP-6).
    const log = join(dir, "t");
    writeFileSync(`${log}.0.log`, "one\ntwo\nthree\n");
    expect(await readLogTail(log, 2, dir, [0])).toBe("two\nthree");
    expect(await readLogTail(log, 10, dir, [0])).toBe("one\ntwo\nthree");
    expect(await readLogTail(log, 0, dir, [0])).toBe("three");
    // Without the writer's own segment list there is nothing to read: this
    // process never lists a directory of somebody else's commands (RP-6).
    expect(await readLogTail(log, 2, dir)).toBeUndefined();
    writeFileSync(`${log}.0.log`, "");
    expect(await readLogTail(log, 5, dir, [0])).toBe("");
    expect(await readLogTail(join(dir, "missing"), 5, dir, [0])).toBeUndefined();
    expect(await readLogTail(undefined, 5, dir, [0])).toBeUndefined();
    expect(await readLogTail("relative.log", 5, dir, [0])).toBeUndefined();
    // A path outside the private root is a claim, not a permission (RP-6), and
    // neither is a symlink out of it.
    const outside = mkdtempSync(join(tmpdir(), "task-tail-outside-"));
    dirs.push(outside);
    writeFileSync(join(outside, "secret.0.log"), "not yours");
    expect(await readLogTail(join(outside, "secret"), 5, dir, [0])).toBeUndefined();
    symlinkSync(join(outside, "secret.0.log"), join(dir, "link.0.log"));
    expect(await readLogTail(join(dir, "link"), 5, dir, [0])).toBeUndefined();
    // And a symlinked *directory* inside the root: `O_NOFOLLOW` only refuses
    // the last component, so containment is decided on the resolved parent.
    const elsewhere = mkdtempSync(join(tmpdir(), "task-tail-elsewhere-"));
    dirs.push(elsewhere);
    writeFileSync(join(elsewhere, "secret.0.log"), "still not yours");
    symlinkSync(elsewhere, join(dir, "opaque"));
    expect(await readLogTail(join(dir, "opaque", "secret"), 5, dir, [0])).toBeUndefined();
    // Without a root nothing is read at all.
    writeFileSync(`${log}.0.log`, "one\n");
    expect(await readLogTail(log, 5, undefined, [0])).toBeUndefined();
    // Past the window only the tail is read, aligned to a character boundary.
    const big = join(dir, "big");
    const line = "é".repeat(50) + "\n";
    const lines = Math.ceil((TASK_OUTPUT_MAX_BYTES * 1.5) / Buffer.byteLength(line));
    writeFileSync(`${big}.0.log`, line.repeat(lines) + "last\n");
    const tail = await readLogTail(big, 3, dir, [0]);
    expect(tail).toBe(`${"é".repeat(50)}\n${"é".repeat(50)}\nlast`);
    expect(tail).not.toContain("�");
  });
});
