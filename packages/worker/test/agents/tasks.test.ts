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
import { MAX_INDEXED_TASKS_PER_SESSION, TaskIndex, readLogTail } from "../../src/agents/tasks.js";

const dirs: string[] = [];
afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

function update(partial: Partial<BackgroundTaskUpdate> & Pick<BackgroundTaskUpdate, "id">): BackgroundTaskUpdate {
  return { command: `echo ${partial.id}`, title: `echo ${partial.id}`, status: "running", origin: "background", startedAt: "2026-09-09T10:00:00.000Z", outputBytes: 0, ...partial };
}

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
