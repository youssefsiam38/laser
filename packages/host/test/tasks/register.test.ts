import { mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { ProtocolError, type BackgroundTask, type BackgroundTaskUpdate } from "@lasercode/protocol";
import { MAX_REGISTER_BYTES, MAX_SESSIONS_WITH_TASKS, MAX_TASKS_PER_SESSION, TaskRegister } from "../../src/tasks/register.js";

const PATH = "/sessions/a.jsonl";
const OTHER = "/sessions/b.jsonl";
/** Where a fork puts the conversation that used to live at `PATH`. */
const FORKED = "/sessions/a-forked.jsonl";
const dirs: string[] = [];

afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

function world(logRoot?: string) {
  const notify = vi.fn();
  const register = new TaskRegister({ notify, ...(logRoot ? { logRoot } : {}) });
  const broadcast = (): BackgroundTask[] => notify.mock.calls.map(([, params]) => (params as { task: BackgroundTask }).task);
  return { register, notify, broadcast };
}

const update = (over: Partial<BackgroundTaskUpdate> = {}): BackgroundTaskUpdate => ({
  id: "t-1",
  command: "pnpm -r test",
  title: "pnpm -r test",
  status: "running",
  origin: "background",
  startedAt: "2026-09-08T10:00:00.000Z",
  outputBytes: 0,
  ...over,
});

describe("TaskRegister", () => {
  it("keeps the log path to itself and broadcasts the task with its session", () => {
    const w = world();
    const logPath = "/tmp/whatever/t-1.log";
    expect(w.register.observeExtensionMessage(PATH, { type: "lasercode/task/update", task: update({ logPath, logSegments: [0] }) })).toBe(true);
    expect(w.broadcast()).toEqual([expect.objectContaining({ id: "t-1", sessionPath: PATH })]);
    // Neither the path nor the files are ever told to a client.
    expect(JSON.stringify(w.broadcast())).not.toContain(logPath);
    expect(JSON.stringify(w.broadcast())).not.toContain("logSegments");
    expect(w.register.list(PATH)).toHaveLength(1);
    // Any other extension message is somebody else's.
    expect(w.register.observeExtensionMessage(PATH, { type: "lasercode/capabilities", active: [], failed: [] })).toBe(false);
  });

  it("carries changes, not heartbeats, and remembers the log path across updates", async () => {
    const dir = mkdtempSync(join(tmpdir(), "task-register-"));
    dirs.push(dir);
    // The window is immutable segments named for the stream byte they start
    // at; `logPath` is their base name (RP-6).
    const logPath = join(dir, "t-1");
    writeFileSync(`${logPath}.0.log`, "hello world");
    const w = world(dir);
    // The writer names its own segments; the host reads those and nothing else.
    w.register.observeExtensionMessage(PATH, { type: "lasercode/task/update", task: update({ logPath, logSegments: [0] }) });
    w.register.observeExtensionMessage(PATH, { type: "lasercode/task/update", task: update({ logPath, logSegments: [0] }) });
    expect(w.broadcast()).toHaveLength(1);
    // A later update need not repeat the path for the read to still work.
    w.register.observeExtensionMessage(PATH, { type: "lasercode/task/update", task: update({ outputBytes: 11 }) });
    expect(w.broadcast()).toHaveLength(2);
    expect(await w.register.read(PATH, "t-1", 0)).toEqual({ id: "t-1", from: 0, bytes: 11, chunk: "hello world", eof: true });
    expect(await w.register.read(PATH, "t-1", 6)).toMatchObject({ from: 6, chunk: "world", eof: true });
  });

  it("refuses a read for a task of another session, one with no file, and one outside the private root", async () => {
    const dir = mkdtempSync(join(tmpdir(), "task-register-root-"));
    dirs.push(dir);
    const w = world(dir);
    w.register.observeExtensionMessage(PATH, { type: "lasercode/task/update", task: update({ logPath: join(dir, "t-1"), logSegments: [0] }) });
    w.register.observeExtensionMessage(OTHER, { type: "lasercode/task/update", task: update({ id: "t-2" }) });
    await expect(w.register.read(OTHER, "t-1", 0)).rejects.toThrow(ProtocolError);
    await expect(w.register.read(OTHER, "t-1", 0)).rejects.toThrow(/does not belong to this session/);
    // No log file at all is a different, nameable thing from a missing one.
    await expect(w.register.read(OTHER, "t-2", 0)).rejects.toThrow(/kept no log file/);
    await expect(w.register.read(PATH, "t-1", 0)).rejects.toThrow(/has been cleaned up/);

    // A path an extension message named outside the private root is a claim,
    // not a permission: the host will not read it, whatever is there (RP-6).
    const outside = mkdtempSync(join(tmpdir(), "task-register-outside-"));
    dirs.push(outside);
    writeFileSync(join(outside, "secrets.log"), "not yours");
    w.register.observeExtensionMessage(PATH, { type: "lasercode/task/update", task: update({ id: "t-outside", logPath: join(outside, "secrets"), logSegments: [0] }) });
    await expect(w.register.read(PATH, "t-outside", 0)).rejects.toThrow(/kept no log file/);
    // Nor one that is a symlink into somebody else's file.
    writeFileSync(join(outside, "target.log"), "also not yours");
    symlinkSync(join(outside, "target.log"), join(dir, "t-link.0.log"));
    w.register.observeExtensionMessage(PATH, { type: "lasercode/task/update", task: update({ id: "t-link", logPath: join(dir, "t-link"), logSegments: [0] }) });
    await expect(w.register.read(PATH, "t-link", 0)).rejects.toThrow(/has been cleaned up/);
    // A symlinked *directory* inside the root escapes it just as well, and
    // `O_NOFOLLOW` would not have noticed: containment is decided on the
    // resolved parent directory, not on the string.
    const elsewhere = mkdtempSync(join(tmpdir(), "task-register-elsewhere-"));
    dirs.push(elsewhere);
    writeFileSync(join(elsewhere, "secret.log"), "still not yours");
    symlinkSync(elsewhere, join(dir, "opaque"));
    w.register.observeExtensionMessage(PATH, { type: "lasercode/task/update", task: update({ id: "t-dir", logPath: join(dir, "opaque", "secret"), logSegments: [0] }) });
    await expect(w.register.read(PATH, "t-dir", 0)).rejects.toThrow(/kept no log file/);
  });

  it("says so when running commands hold it above its bounds, rather than implying it is inside them", () => {
    const w = world();
    // More live commands than the session bound: every one of their rows stays,
    // because the fleet is drawing them, and the overflow is named.
    for (let index = 0; index < MAX_SESSIONS_WITH_TASKS + 20; index++) {
      w.register.observeExtensionMessage(`/sessions/live${index}.jsonl`, { type: "lasercode/task/update", task: update({ id: `t-${index}` }) });
    }
    const retained = w.register.retained();
    expect(retained.count).toBe(MAX_SESSIONS_WITH_TASKS + 20);
    expect(retained.overflow).toBe("running_commands");
    // Not one running row was erased to make the number look tidy.
    expect(w.register.list().filter((task) => task.status === "running")).toHaveLength(MAX_SESSIONS_WITH_TASKS + 20);
  });

  it("keeps a private artifact path out of everything a client can see", () => {
    const canary = "/tmp/CANARY-PRIVATE-ARTIFACT-PATH/t-1";
    const w = world("/tmp/CANARY-PRIVATE-ARTIFACT-PATH");
    w.register.observeExtensionMessage(PATH, {
      type: "lasercode/task/update",
      task: update({ logPath: canary, logSegments: [0], activity: "still going" }),
    });
    // The broadcast, the list and the single-row read: none of them names a
    // file, and neither does the retention the diagnostics surface publishes.
    expect(JSON.stringify(w.broadcast())).not.toContain("CANARY");
    expect(JSON.stringify(w.register.list())).not.toContain("CANARY");
    expect(JSON.stringify(w.register.get(PATH, "t-1"))).not.toContain("CANARY");
    expect(JSON.stringify(w.register.retained())).not.toContain("CANARY");
  });

  it("counts retained bytes in UTF-8, not in string units", () => {
    const w = world();
    const command = "echo \u201c\u4f60\u597d\u4e16\u754c\ud83d\ude80\u201d";
    w.register.observeExtensionMessage(PATH, { type: "lasercode/task/update", task: update({ command, title: command, activity: command }) });
    const serialized = JSON.stringify(w.register.list(PATH)[0]);
    expect(w.register.retained()).toEqual({ count: 1, bytes: Buffer.byteLength(serialized, "utf8") });
    expect(Buffer.byteLength(serialized, "utf8")).toBeGreaterThan(serialized.length);
  });

  it("ends running tasks when the worker that ran them goes away, and says why", () => {
    const w = world();
    w.register.observeExtensionMessage(PATH, { type: "lasercode/task/update", task: update() });
    w.register.observeExtensionMessage(PATH, { type: "lasercode/task/update", task: update({ id: "t-done", status: "completed", exitCode: 0, endedAt: "2026-09-08T10:01:00.000Z" }) });
    w.notify.mockClear();
    w.register.workerLost([PATH], "the worker stopped");
    // Only the live one changes; a finished task is not re-ended.
    expect(w.broadcast()).toEqual([
      expect.objectContaining({ id: "t-1", status: "stopped", exitCode: null, terminalReason: "the worker stopped" }),
    ]);
    expect(w.register.get(PATH, "t-done")?.status).toBe("completed");
  });

  it("reads a windowed log across both its segments, with stream offsets and the digest", async () => {
    const dir = mkdtempSync(join(tmpdir(), "task-register-window-"));
    dirs.push(dir);
    const logPath = join(dir, "t-1");
    // A long command's log is a window of immutable segments (RP-6), each
    // named for the stream byte it starts at. Offsets stay stream offsets, so
    // a follower's arithmetic never has to know a rotation happened — and a
    // record that is a rotation out of date cannot mislabel anything, because
    // the offsets come from the files.
    writeFileSync(`${logPath}.999978.log`, "middle-part");
    writeFileSync(`${logPath}.999989.log`, "latest-part");
    const digest = "a".repeat(64);
    const w = world(dir);
    w.register.observeExtensionMessage(PATH, {
      type: "lasercode/task/update",
      // Deliberately stale: the record still says the window began 12 bytes
      // earlier than it does. The read must not believe it.
      task: update({ logPath, logSegments: [999_978, 999_989], outputBytes: 1_000_000, retainedFromByte: 999_966, logState: "truncated", outputDigest: digest }),
    });

    const head = await w.register.read(PATH, "t-1", 0);
    expect(head).toMatchObject({ from: 999_978, chunk: "middle-part", retainedFrom: 999_978, digest, bytes: 1_000_000, eof: false });
    const tail = await w.register.read(PATH, "t-1", 999_989);
    expect(tail).toMatchObject({ from: 999_989, chunk: "latest-part", eof: true });
  });

  it("reads only the segments the writer named, whatever else is in the directory", async () => {
    const dir = mkdtempSync(join(tmpdir(), "task-register-decoys-"));
    dirs.push(dir);
    const logPath = join(dir, "t-1");
    writeFileSync(`${logPath}.0.log`, "the real bytes");
    // Ten thousand names that look exactly like segments of this task. A read
    // that listed the directory would open, measure and sort all of them, and
    // would believe whichever one came last; this one never looks at them,
    // because the writer said which two files it has (RP-6).
    for (let index = 1; index <= 10_000; index++) writeFileSync(`${logPath}.${index * 1000}.log`, `decoy ${index}`);
    const w = world(dir);
    w.register.observeExtensionMessage(PATH, {
      type: "lasercode/task/update",
      task: update({ logPath, logSegments: [0], outputBytes: 14, status: "completed", exitCode: 0 }),
    });

    const started = Date.now();
    const chunk = await w.register.read(PATH, "t-1", 0);
    expect(chunk).toMatchObject({ from: 0, chunk: "the real bytes", bytes: 14, eof: true });
    // Nothing about the answer, or the work behind it, grew with the decoys.
    expect(Date.now() - started).toBeLessThan(500);
    expect(JSON.stringify(chunk)).not.toContain("decoy");
  });

  it("says a released log is gone rather than reading a file that is not it", async () => {
    const dir = mkdtempSync(join(tmpdir(), "task-register-released-"));
    dirs.push(dir);
    const logPath = join(dir, "t-1");
    writeFileSync(`${logPath}.0.log`, "stale");
    const w = world(dir);
    w.register.observeExtensionMessage(PATH, {
      type: "lasercode/task/update",
      task: update({ logPath, logSegments: [0], status: "completed", exitCode: 0, outputBytes: 5_000, logState: "released", retainedFromByte: 5_000 }),
    });
    await expect(w.register.read(PATH, "t-1", 0)).rejects.toThrow(/kept no log file/);
  });

  it("bounds itself by records and bytes, and never forgets a session with a command still running", () => {
    const w = world();
    // One session with a live command, then many finished ones.
    w.register.observeExtensionMessage(PATH, { type: "lasercode/task/update", task: update({ id: "t-live" }) });
    for (let index = 0; index < 260; index++) {
      w.register.observeExtensionMessage(`/sessions/s${index}.jsonl`, {
        type: "lasercode/task/update",
        task: update({ id: `t-${index}`, status: "completed", exitCode: 0, endedAt: "2026-09-08T10:01:00.000Z", command: "x".repeat(2000), title: "x" }),
      });
    }
    const retained = w.register.retained();
    // Exactly the bound, and the session whose command is still running is one
    // of the rows inside it: finished sessions went first, oldest first.
    expect(w.register.list().length).toBe(MAX_SESSIONS_WITH_TASKS);
    expect(retained.count).toBe(MAX_SESSIONS_WITH_TASKS);
    expect(retained.bytes).toBeLessThanOrEqual(MAX_REGISTER_BYTES);
    expect(retained.overflow).toBeUndefined();
    expect(w.register.list(PATH).map((task) => task.id)).toEqual(["t-live"]);
    expect(w.register.list().some((task) => task.id === "t-live")).toBe(true);
  });

  // ------------------------------------------------ a fork moved the session

  /**
   * RP-4: a fork changes a session's *file*, not its commands.
   *
   * The register is keyed by path, so without this transition the row of a
   * command that is still running stays under a path no runtime serves: a
   * ghost the fleet can never lose, a `tasks/list` that hands a reconnecting
   * client a stale *running* row, and a Stop that reaches nothing.
   */
  describe("when a fork moves a session's file", () => {
    it("takes the commands with it and leaves no row behind", () => {
      const w = world();
      w.register.observeExtensionMessage(PATH, { type: "lasercode/task/update", task: update({ id: "t-live" }) });
      w.register.observeExtensionMessage(PATH, { type: "lasercode/task/update", task: update({ id: "t-done", status: "completed", exitCode: 0, endedAt: "2026-09-08T10:01:00.000Z" }) });
      w.register.observeExtensionMessage(OTHER, { type: "lasercode/task/update", task: update({ id: "t-elsewhere" }) });
      const before = w.broadcast().length;

      w.register.rekeySession(PATH, FORKED);

      // One row per command, under the conversation that exists.
      expect(w.register.list(PATH)).toEqual([]);
      expect(w.register.list(FORKED).map((task) => task.id)).toEqual(["t-live", "t-done"]);
      expect(w.register.list(FORKED).every((task) => task.sessionPath === FORKED)).toBe(true);
      expect(w.register.list().map((task) => task.id).sort()).toEqual(["t-done", "t-elsewhere", "t-live"]);
      expect(w.register.get(FORKED, "t-live")?.status).toBe("running");
      expect(w.register.get(PATH, "t-live")).toBeUndefined();
      // Another conversation's command never moved.
      expect(w.register.list(OTHER).map((task) => task.id)).toEqual(["t-elsewhere"]);

      // Every client is told where each moved command hangs now, and nothing
      // private travels with it.
      const told = w.broadcast().slice(before);
      expect(told.map((task) => task.id)).toEqual(["t-live", "t-done"]);
      expect(told.every((task) => task.sessionPath === FORKED)).toBe(true);
      expect(JSON.stringify(told)).not.toContain("logPath");

      // Idempotent, and a path it never held moves nothing.
      w.register.rekeySession(PATH, FORKED);
      w.register.rekeySession("/sessions/never.jsonl", OTHER);
      w.register.rekeySession(FORKED, FORKED);
      expect(w.broadcast().length).toBe(before + 2);
      expect(w.register.list(FORKED).map((task) => task.id)).toEqual(["t-live", "t-done"]);
      expect(w.register.list(OTHER).map((task) => task.id)).toEqual(["t-elsewhere"]);
    });

    it("keeps the row published after the move, and never turns a finished command back into a running one", () => {
      const w = world();
      // The worker re-keys its own structures before it answers the fork, so a
      // row can already have arrived under the new path — including the one
      // that says the command ended — before the host learns the session moved.
      w.register.observeExtensionMessage(PATH, { type: "lasercode/task/update", task: update({ id: "t-1", outputBytes: 10 }) });
      w.register.observeExtensionMessage(FORKED, {
        type: "lasercode/task/update",
        task: update({ id: "t-1", status: "completed", exitCode: 0, endedAt: "2026-09-08T10:01:00.000Z", outputBytes: 4_096, terminalReason: "exit code 0" }),
      });
      // And the same command's *stale* running row is still under the old path.
      w.register.rekeySession(PATH, FORKED);

      const moved = w.register.list(FORKED);
      expect(moved).toHaveLength(1);
      expect(moved[0]).toMatchObject({ id: "t-1", status: "completed", outputBytes: 4_096, terminalReason: "exit code 0", sessionPath: FORKED });
      // The newer row was already broadcast when it arrived; the move does not
      // re-tell a client something it has.
      expect(w.broadcast().filter((task) => task.status === "completed")).toHaveLength(1);
      expect(w.broadcast().some((task) => task.status === "running" && task.sessionPath === FORKED)).toBe(false);

      // The guard from the other side: a command that ended before the fork is
      // not resurrected by a running row that happens to sit at the new path.
      const other = world();
      other.register.observeExtensionMessage(PATH, { type: "lasercode/task/update", task: update({ id: "t-2", status: "failed", exitCode: 2, endedAt: "2026-09-08T10:02:00.000Z" }) });
      other.register.observeExtensionMessage(FORKED, { type: "lasercode/task/update", task: update({ id: "t-2" }) });
      other.register.rekeySession(PATH, FORKED);
      expect(other.register.list(FORKED)).toEqual([expect.objectContaining({ id: "t-2", status: "failed", sessionPath: FORKED })]);
    });

    it("keeps reading the moved command's output, and refuses it from the path it left", async () => {
      const dir = mkdtempSync(join(tmpdir(), "task-register-fork-"));
      dirs.push(dir);
      const logPath = join(dir, "t-1");
      writeFileSync(`${logPath}.0.log`, "hello world");
      const w = world(dir);
      w.register.observeExtensionMessage(PATH, { type: "lasercode/task/update", task: update({ logPath, logSegments: [0], outputBytes: 11 }) });
      // The row that arrived under the new path before the fork was answered
      // need not repeat where the bytes are.
      w.register.observeExtensionMessage(FORKED, { type: "lasercode/task/update", task: update({ outputBytes: 11, activity: "hello world" }) });

      w.register.rekeySession(PATH, FORKED);

      expect(await w.register.read(FORKED, "t-1", 0)).toMatchObject({ chunk: "hello world", eof: true });
      await expect(w.register.read(PATH, "t-1", 0), "the old path owns nothing now").rejects.toThrow(/does not belong to this session/);
      expect(JSON.stringify(w.register.list(FORKED))).not.toContain(dir);
    });

    it("holds exactly the bytes of what it kept, and prunes at the path it moved to", () => {
      const w = world();
      for (let index = 0; index < MAX_TASKS_PER_SESSION + 20; index++) {
        w.register.observeExtensionMessage(PATH, {
          type: "lasercode/task/update",
          task: update({ id: `t-${index}`, status: "completed", exitCode: 0, endedAt: "2026-09-08T10:01:00.000Z", command: "pnpm \u{1f680} test" }),
        });
      }
      w.register.observeExtensionMessage(PATH, { type: "lasercode/task/update", task: update({ id: "t-live" }) });

      w.register.rekeySession(PATH, FORKED);

      // The same rows a register that had only ever seen the new path would
      // hold, and the same exact UTF-8 bytes — the emoji costs more bytes than
      // characters on both sides.
      const mirror = world();
      for (const task of w.register.list(FORKED)) mirror.register.upsert(FORKED, task);
      expect(w.register.retained().count).toBe(mirror.register.retained().count);
      expect(w.register.retained().bytes).toBe(mirror.register.retained().bytes);
      // The per-session bound applies where the rows now live, and the command
      // still running is never one of the forgotten.
      expect(w.register.list(FORKED).length).toBe(MAX_TASKS_PER_SESSION);
      expect(w.register.list(FORKED).some((task) => task.id === "t-live")).toBe(true);
      expect(w.register.list(PATH)).toEqual([]);
    });

    it("does not end a moved command when the file it came from is closed", () => {
      const w = world();
      w.register.observeExtensionMessage(PATH, { type: "lasercode/task/update", task: update({ id: "t-live" }) });
      w.register.rekeySession(PATH, FORKED);

      // The old path is closed — it is a file nothing serves — and the command
      // that moved keeps running, because it did.
      w.register.sessionClosed(PATH);
      w.register.workerLost([PATH]);
      expect(w.register.get(FORKED, "t-live")?.status).toBe("running");

      // Losing the worker that really runs it still ends it, at the path it is.
      w.register.workerLost([FORKED]);
      expect(w.register.get(FORKED, "t-live")).toMatchObject({ status: "stopped", terminalReason: "the worker stopped" });
    });
  });

  it("lists one session or every session", () => {
    const w = world();
    w.register.observeExtensionMessage(PATH, { type: "lasercode/task/update", task: update() });
    w.register.observeExtensionMessage(OTHER, { type: "lasercode/task/update", task: update({ id: "t-2" }) });
    expect(w.register.list(PATH).map((t) => t.id)).toEqual(["t-1"]);
    expect(w.register.list().map((t) => t.id).sort()).toEqual(["t-1", "t-2"]);
    expect(w.register.list("/sessions/never.jsonl")).toEqual([]);
  });
});
