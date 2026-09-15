/**
 * The session's retention policy, on its own (RP-6).
 *
 * The claims here are about the policy rather than about a command: the
 * ceiling is an invariant checked **before** a byte is kept, the totals are
 * exact after every change, room is made in one order, and no bound can forget
 * a command that is still running. They are asserted directly against
 * `SessionRetention` and real `TaskLog`s with a stalled writer — not sampled
 * from the outside and hoped to have caught the worst instant.
 */
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, expect, it } from "vitest";
import { TaskLog } from "../src/modules/task-log.js";
import {
  SESSION_LIVE_TAIL_BYTES_MAX,
  SessionRetention,
  TERMINAL_TASKS_MAX,
  TERMINAL_TASK_MAX_AGE_MS,
  type RetainedTask,
} from "../src/modules/task-retention.js";

const dirs: string[] = [];
const sessions: SessionRetention[] = [];
afterEach(() => {
  for (const session of sessions.splice(0)) session.dispose();
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

function scratch(): string {
  const dir = mkdtempSync(join(tmpdir(), "task-retention-"));
  dirs.push(dir);
  return dir;
}

/** A command as the policy sees it: bytes, and how to give them back. */
function fakeTask(id: string, log: TaskLog, startedAtMs: number): RetainedTask & { tail: number; excerpt: number; endedAtMs?: number } {
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

function session(options: { budget?: number; now?: () => number } = {}) {
  const forgotten: string[] = [];
  const retention = new SessionRetention({
    forget: (id) => forgotten.push(id),
    ...(options.now ? { now: options.now } : {}),
    // No wall clock in a unit test: age is driven explicitly.
    setInterval: () => ({ unref: () => {} }),
    clearInterval: () => {},
  });
  sessions.push(retention);
  if (options.budget !== undefined) retention.setBudget(options.budget);
  return { retention, forgotten };
}

/** A log whose writes never settle: everything it accepts stays pending. */
function stalledLog(dir: string, id: string, retention: SessionRetention, queueBytes = 64 * 1024): TaskLog {
  const log: TaskLog = new TaskLog({
    dir,
    id,
    segmentBytes: 1024 * 1024,
    queueBytes,
    write: () => new Promise<number>(() => {}),
    admit: (bytes) => retention.admit(log, bytes),
    onChange: () => retention.note(id),
  });
  return log;
}

it("never lets what is held pass the share, checked after every single append", () => {
  const dir = scratch();
  const share = 128 * 1024;
  const { retention } = session({ budget: share });
  const logs: TaskLog[] = [];
  for (let index = 0; index < 8; index++) {
    const log = stalledLog(dir, `t-${index}`, retention);
    logs.push(log);
    retention.track(fakeTask(`t-${index}`, log, index));
  }

  // Eight commands, nothing draining, appending in turn. The invariant is
  // asserted **after every append**, not sampled: admission happens before a
  // chunk is retained, so there is no instant at which it is exceeded.
  for (let round = 0; round < 40; round++) {
    for (const log of logs) {
      log.append(Buffer.alloc(8 * 1024, "x"));
      expect(retention.heldBytes).toBeLessThanOrEqual(share);
    }
  }
  // Every command kept counting and digesting whatever happened to its body.
  for (const log of logs) {
    expect(log.bytes).toBe(40 * 8 * 1024);
    expect(log.digest()).toMatch(/^[0-9a-f]{64}$/);
    expect(["retained", "truncated", "released"]).toContain(log.state);
  }
  expect(retention.released).toBeGreaterThan(0);
  expect(retention.snapshot().live).toBe(8);
});

it("refuses a chunk larger than the whole share instead of keeping it", () => {
  const dir = scratch();
  const { retention } = session({ budget: 16 * 1024 });
  const log = stalledLog(dir, "t-big", retention, 8 * 1024 * 1024);
  retention.track(fakeTask("t-big", log, 0));
  log.append(Buffer.alloc(64 * 1024, "y"));
  expect(retention.heldBytes).toBe(0);
  expect(log.state).toBe("released");
  expect(log.bytes).toBe(64 * 1024);
});

it("keeps nothing at all when the worker's share is zero", () => {
  const dir = scratch();
  const { retention } = session({ budget: 0 });
  const log = stalledLog(dir, "t-zero", retention);
  retention.track(fakeTask("t-zero", log, 0));
  log.append(Buffer.from("anything"));
  expect(retention.heldBytes).toBe(0);
  expect(log.state).toBe("released");
  expect(log.bytes).toBe(8);
});

it("makes room from the older bodies before the command that is asking", async () => {
  const dir = scratch();
  const share = 48 * 1024;
  const { retention } = session({ budget: share });
  const make = (id: string, startedAtMs: number): TaskLog => {
    const log: TaskLog = new TaskLog({
      dir,
      id,
      segmentBytes: 1024 * 1024,
      admit: (bytes) => retention.admit(log, bytes),
      onChange: () => retention.note(id),
    });
    retention.track(fakeTask(id, log, startedAtMs));
    return log;
  };
  const older = make("t-older", 1);
  const newer = make("t-newer", 2);
  older.append(Buffer.alloc(32 * 1024, "a"));
  newer.append(Buffer.alloc(8 * 1024, "b"));
  await older.drained();
  await newer.drained();
  expect(retention.heldBytes).toBe(40 * 1024);

  // The newer command asks for more than is left: the older body goes first,
  // and the command that asked keeps its own.
  newer.append(Buffer.alloc(16 * 1024, "c"));
  await newer.drained();
  expect(older.state).toBe("released");
  expect(newer.state).not.toBe("released");
  expect(retention.heldBytes).toBeLessThanOrEqual(share);
  expect(older.bytes).toBe(32 * 1024);
  expect(newer.bytes).toBe(24 * 1024);
});

it("gives up the asking command's own body only when nothing else is left", () => {
  const dir = scratch();
  const { retention } = session({ budget: 32 * 1024 });
  // Everything this session holds is in flight to a stalled disk, so nothing
  // can be reclaimed from anybody else.
  const log = stalledLog(dir, "t-only", retention, 8 * 1024 * 1024);
  retention.track(fakeTask("t-only", log, 1));
  log.append(Buffer.alloc(24 * 1024, "a"));
  expect(retention.heldBytes).toBe(24 * 1024);
  log.append(Buffer.alloc(24 * 1024, "b"));
  expect(log.state).toBe("released");
  expect(log.bytes).toBe(48 * 1024);
  // In-flight bytes cannot be taken back; what is left is bounded by one write.
  expect(retention.heldBytes).toBeLessThanOrEqual(24 * 1024);
});

it("keeps its totals exact through releases, evictions and multibyte excerpts", () => {
  const dir = scratch();
  let clock = 1_000_000;
  const { retention, forgotten } = session({ budget: 1024 * 1024, now: () => clock });
  const task = fakeTask("t-exact", stalledLog(dir, "t-exact", retention), clock);
  retention.track(task);
  task.tail = 4096;
  retention.note("t-exact");
  expect(retention.snapshot().liveTailBytes).toBe(4096);

  task.endedAtMs = clock;
  task.tail = 0;
  // A multibyte excerpt costs what its bytes cost, not what its characters do.
  task.excerpt = Buffer.byteLength("“你好世界🚀”".repeat(10), "utf8");
  retention.markTerminal("t-exact");
  const held = retention.snapshot();
  expect(held.live).toBe(0);
  expect(held.terminal).toBe(1);
  expect(held.liveTailBytes).toBe(0);
  expect(held.excerptBytes).toBe(task.excerpt);
  expect(held.excerptBytes).toBeGreaterThan("“你好世界🚀”".repeat(10).length);

  // Age is a property of a record, checked on its own: no other command has to
  // end for it to apply.
  clock += TERMINAL_TASK_MAX_AGE_MS + 1;
  retention.enforceRecordBounds();
  expect(forgotten).toEqual(["t-exact"]);
  const after = retention.snapshot();
  expect(after.terminal).toBe(0);
  expect(after.excerptBytes).toBe(0);
  expect(after.evicted).toBe(1);
});

it("counts a release once, however many times it is asked for", () => {
  const dir = scratch();
  const { retention } = session({ budget: 1024 * 1024 });
  const log = stalledLog(dir, "t-once", retention);
  retention.track(fakeTask("t-once", log, 0));
  log.append(Buffer.alloc(1024, "z"));
  retention.setBudget(0);
  const released = retention.released;
  expect(released).toBeGreaterThan(0);
  // Nothing left to release: the counter does not move for a no-op.
  retention.setBudget(0);
  retention.enforceBudget();
  expect(retention.released).toBe(released);
});

it("forgets finished records by count, and never a command that is still running", () => {
  const dir = scratch();
  const now = Date.now();
  const { retention, forgotten } = session({ budget: 1024 * 1024 });
  const live = fakeTask("t-live", stalledLog(dir, "t-live", retention), now);
  retention.track(live);
  for (let index = 0; index < TERMINAL_TASKS_MAX + 5; index++) {
    const id = `t-${index}`;
    const task = fakeTask(id, stalledLog(dir, id, retention), now + index + 1);
    retention.track(task);
    // Just ended, so only the count bound can apply.
    task.endedAtMs = now + index + 1;
    retention.markTerminal(id);
  }
  expect(forgotten).toHaveLength(5);
  expect(forgotten).not.toContain("t-live");
  const held = retention.snapshot();
  expect(held.terminal).toBe(TERMINAL_TASKS_MAX);
  expect(held.live).toBe(1);
});

it("holds live tail memory to one ceiling for the session, without touching a command", () => {
  const dir = scratch();
  const { retention } = session({ budget: 1024 * 1024 });
  const tasks = [];
  for (let index = 0; index < 40; index++) {
    const id = `t-${index}`;
    const task = fakeTask(id, stalledLog(dir, id, retention), index);
    retention.track(task);
    task.tail = 256 * 1024;
    retention.note(id);
    tasks.push(task);
  }
  expect(retention.snapshot().liveTailBytes).toBeGreaterThan(SESSION_LIVE_TAIL_BYTES_MAX);
  retention.enforceLiveTailBudget();
  const held = retention.snapshot();
  expect(held.liveTailBytes).toBeLessThanOrEqual(SESSION_LIVE_TAIL_BYTES_MAX);
  expect(held.tailsShrunk).toBeGreaterThan(0);
  // Still forty running commands: memory was released, work was not.
  expect(held.live).toBe(40);
});
