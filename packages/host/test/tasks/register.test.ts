import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { ProtocolError, type BackgroundTask, type BackgroundTaskUpdate } from "@lasercode/protocol";
import { TaskRegister } from "../../src/tasks/register.js";

const PATH = "/sessions/a.jsonl";
const OTHER = "/sessions/b.jsonl";
const dirs: string[] = [];

afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

function world() {
  const notify = vi.fn();
  const register = new TaskRegister({ notify });
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
    expect(w.register.observeExtensionMessage(PATH, { type: "lasercode/task/update", task: update({ logPath }) })).toBe(true);
    expect(w.broadcast()).toEqual([expect.objectContaining({ id: "t-1", sessionPath: PATH })]);
    // The path a client is never told.
    expect(JSON.stringify(w.broadcast())).not.toContain(logPath);
    expect(w.register.list(PATH)).toHaveLength(1);
    // Any other extension message is somebody else's.
    expect(w.register.observeExtensionMessage(PATH, { type: "lasercode/capabilities", active: [], failed: [] })).toBe(false);
  });

  it("carries changes, not heartbeats, and remembers the log path across updates", async () => {
    const dir = mkdtempSync(join(tmpdir(), "task-register-"));
    dirs.push(dir);
    const logPath = join(dir, "t-1.log");
    writeFileSync(logPath, "hello world");
    const w = world();
    w.register.observeExtensionMessage(PATH, { type: "lasercode/task/update", task: update({ logPath }) });
    w.register.observeExtensionMessage(PATH, { type: "lasercode/task/update", task: update({ logPath }) });
    expect(w.broadcast()).toHaveLength(1);
    // A later update need not repeat the path for the read to still work.
    w.register.observeExtensionMessage(PATH, { type: "lasercode/task/update", task: update({ outputBytes: 11 }) });
    expect(w.broadcast()).toHaveLength(2);
    expect(await w.register.read(PATH, "t-1", 0)).toEqual({ id: "t-1", from: 0, bytes: 11, chunk: "hello world", eof: true });
    expect(await w.register.read(PATH, "t-1", 6)).toMatchObject({ from: 6, chunk: "world", eof: true });
  });

  it("refuses a read for a task of another session, and one with no file", async () => {
    const w = world();
    w.register.observeExtensionMessage(PATH, { type: "lasercode/task/update", task: update({ logPath: "/tmp/gone/t-1.log" }) });
    w.register.observeExtensionMessage(OTHER, { type: "lasercode/task/update", task: update({ id: "t-2" }) });
    await expect(w.register.read(OTHER, "t-1", 0)).rejects.toThrow(ProtocolError);
    await expect(w.register.read(OTHER, "t-1", 0)).rejects.toThrow(/does not belong to this session/);
    // No log file at all is a different, nameable thing from a missing one.
    await expect(w.register.read(OTHER, "t-2", 0)).rejects.toThrow(/kept no log file/);
    await expect(w.register.read(PATH, "t-1", 0)).rejects.toThrow(/has been cleaned up/);
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

  it("lists one session or every session", () => {
    const w = world();
    w.register.observeExtensionMessage(PATH, { type: "lasercode/task/update", task: update() });
    w.register.observeExtensionMessage(OTHER, { type: "lasercode/task/update", task: update({ id: "t-2" }) });
    expect(w.register.list(PATH).map((t) => t.id)).toEqual(["t-1"]);
    expect(w.register.list().map((t) => t.id).sort()).toEqual(["t-1", "t-2"]);
    expect(w.register.list("/sessions/never.jsonl")).toEqual([]);
  });
});
