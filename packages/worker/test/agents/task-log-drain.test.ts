/**
 * What the worker can still read after the companion compacts under pressure
 * (RP-8), across the two packages that actually decide it: the extension's
 * `TaskLog` and `SessionRetention` on one side, this process's `TaskIndex` and
 * `readLogTail` on the other. Nothing is simulated here except the moment the
 * platform acknowledges a write.
 *
 * The rule under test: a finished command whose bytes are still on their way to
 * disk is not forgotten, because the record that holds it is the only thing
 * that still tells this process where those bytes are. Forget it early and a
 * rotation moments later leaves the indexed row naming a file that is gone.
 */
import { mkdtempSync, rmSync, write as writeFd } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import type { BackgroundTaskUpdate } from "@lasercode/protocol";
// The worker depends on the companion; a test may read its source directly, and
// the dependency runs in this direction only.
import { TaskLog } from "../../../pi-extension/src/modules/task-log.js";
import { SessionRetention } from "../../../pi-extension/src/modules/task-retention.js";
import { TaskIndex, readLogTail } from "../../src/agents/tasks.js";

const dirs: string[] = [];
const logs: TaskLog[] = [];
afterEach(() => {
  for (const log of logs.splice(0)) log.release();
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

/** The shape the module tracks: a command, its log, its tail and its excerpt. */
function record(id: string, log: TaskLog, startedAtMs: number) {
  const task = {
    id,
    startedAtMs,
    log,
    tail: 0,
    excerpt: 0,
    endedAtMs: undefined as number | undefined,
    tailBytes: () => task.tail,
    shrinkTail: (limit: number) => {
      const freed = Math.max(0, task.tail - limit);
      task.tail = Math.min(task.tail, limit);
      return freed;
    },
    releaseTail: () => {
      const freed = task.tail;
      task.tail = 0;
      task.excerpt = Math.min(freed, 8 * 1024);
      return freed;
    },
    excerptBytes: () => task.excerpt,
  };
  return task;
}

const row = (id: string, log: TaskLog): BackgroundTaskUpdate => ({
  id,
  command: "printf",
  title: "printf",
  status: "completed",
  origin: "background",
  startedAt: "2026-09-09T10:00:00.000Z",
  outputBytes: log.bytes,
  logPath: log.path,
  logSegments: log.segmentOffsets,
});

describe("a compacted command stays readable while its log drains (RP-8)", () => {
  it("keeps the draining record, keeps publishing its window, and only then lets it go", async () => {
    const root = mkdtempSync(join(tmpdir(), "task-drain-"));
    dirs.push(root);
    const session = "/s/a.jsonl";
    const index = new TaskIndex();
    const forgotten: string[] = [];
    const alive = new Map<string, ReturnType<typeof record>>();
    const clock = 5_000_000;

    const retention = new SessionRetention({
      forget: (id) => {
        forgotten.push(id);
        alive.delete(id);
      },
      now: () => clock,
    });

    // One write at a time, settled by this test rather than by the platform.
    const waiting: Array<{ resolve: (written: number) => void; length: number }> = [];
    let hold = true;
    const log: TaskLog = new TaskLog({
      dir: root,
      id: "old",
      // Small segments, so a few bytes are enough to rotate past the first one.
      segmentBytes: 8,
      queueBytes: 64 * 1024,
      // Real bytes, on the platform's own terms — except that the first write
      // lands only when this test says so.
      write: async (fd, chunk) => {
        const put = (): Promise<number> =>
          new Promise<number>((resolve, reject) => {
            writeFd(fd, chunk, 0, chunk.length, null, (error, written) => (error ? reject(error) : resolve(written)));
          });
        if (!hold) return put();
        return new Promise<number>((resolve, reject) => {
          waiting.push({ resolve: () => void put().then(resolve, reject), length: chunk.length });
        });
      },
      admit: (bytes) => retention.admit(log, bytes),
      onChange: () => {
        retention.note("old");
        // Exactly what the module does: while this record is still ours, every
        // move of the window is published again for the same task.
        const own = alive.get("old");
        if (own) index.observe(session, { type: "lasercode/task/update", task: row("old", own.log) });
      },
    });
    logs.push(log);

    const task = record("old", log, 0);
    alive.set("old", task);
    retention.track(task);
    log.append(Buffer.from("abcdefgh"));
    // It finished long ago, with its first write still in flight.
    task.endedAtMs = clock - 30 * 60_000;
    task.excerpt = 8 * 1024;
    retention.markTerminal("old");
    index.observe(session, { type: "lasercode/task/update", task: row("old", log) });
    const indexed = (id: string) => index.tasksOf(session).find((entry) => entry.id === id)!;
    const published = indexed("old");
    expect(published.logSegments).toEqual([0]);
    expect(log.pendingBytes).toBe(8);

    // Six newer finished commands, so the floor of five is not what saves it.
    hold = false;
    for (let n = 0; n < 6; n += 1) {
      const other: TaskLog = new TaskLog({ dir: root, id: `new-${n}`, segmentBytes: 1024, queueBytes: 1024, admit: (bytes) => retention.admit(other, bytes) });
      logs.push(other);
      const newer = record(`new-${n}`, other, 10 + n);
      newer.endedAtMs = clock - 30 * 60_000;
      newer.excerpt = 8 * 1024;
      alive.set(newer.id, newer);
      retention.track(newer);
      retention.markTerminal(newer.id);
    }

    const before = retention.snapshot();
    const digestBefore = log.digest();
    retention.releaseUnder("critical");
    const after = retention.snapshot();

    // Pressure took the settled records and left the draining one exactly as it
    // was: its bytes, its digest, its pending count, and nothing released.
    expect(forgotten).not.toContain("old");
    expect(alive.has("old")).toBe(true);
    expect(log.pendingBytes).toBe(8);
    expect(log.bytes).toBe(8);
    expect(log.digest()).toBe(digestBefore);
    expect(after.pendingLogBytes).toBe(8);
    expect(after.released).toBe(before.released);

    // The write lands, and enough more to rotate past the first segment: the
    // record is still this session's to publish for, so the indexed row moves
    // with the window.
    for (const write of waiting.splice(0)) write.resolve(write.length);
    await log.drained();
    log.append(Buffer.from("ijklmnop"));
    log.append(Buffer.from("qrstuvwx"));
    await log.drained();
    expect(log.segmentOffsets).not.toContain(0);

    const current = indexed("old");
    expect(current.logSegments).toEqual(log.segmentOffsets);
    // The stale coordinates name a file that no longer exists; the published
    // ones read the bytes that do.
    expect(await readLogTail(log.path, 5, root, published.logSegments)).toBeUndefined();
    // What the writer still has is what this process reads: the same window,
    // byte for byte.
    const window = log.readTail(64)!.toString("utf8");
    expect(window).toContain("qrstuvwx");
    expect(window).not.toContain("abcdefgh");
    expect(await readLogTail(log.path, 5, root, current.logSegments)).toBe(window);

    // Nothing is in flight now, so the next ask may have it — and the row this
    // process holds still reads the same bytes afterwards.
    retention.releaseUnder("critical");
    expect(forgotten).toContain("old");
    const kept = indexed("old");
    expect(kept.logSegments).toEqual(current.logSegments);
    expect(await readLogTail(kept.logPath, 5, root, kept.logSegments)).toBe(window);
  });
});
