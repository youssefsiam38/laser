/**
 * RP-4 · a fork moves a session's file, and the host's memory of its commands
 * moves with it.
 *
 * Through the **real** `Router`, its real route lease and a real
 * `TaskRegister`: the fork is forwarded to the worker, the worker answers with
 * a state that carries a new path, and everything the host keys by the old
 * path follows inside that same lease — the pool's row, and the register.
 *
 * What was wrong without it: the register kept the pre-fork rows under a file
 * no runtime serves. A person who forked a conversation while a command ran
 * saw the command twice — once as a live row under the conversation that
 * exists, once as a *running* ghost under the one that does not — and the
 * ghost never ended, because only the worker's loss ends a row and that worker
 * was perfectly alive.
 *
 * The worker stub here does what the real worker does in the order it does it:
 * it re-keys its own structures and publishes under the new path *before* it
 * answers the fork, because its notifications and its reply travel the same
 * ordered connection.
 */
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { ErrorCodes, PRODUCT_NAME, ProtocolError, type BackgroundTask, type BackgroundTaskUpdate, type SessionSummary } from "@lasercode/protocol";
import { AttentionTracker } from "../../src/attention.js";
import type { SessionCatalog } from "../../src/catalog.js";
import { ProjectRegistry } from "../../src/projects.js";
import { Router } from "../../src/router.js";
import { SessionRouteLeases } from "../../src/session-route-lease.js";
import { TaskRegister } from "../../src/tasks/register.js";
import { ViewCache } from "../../src/views.js";
import type { WorkerPool } from "../../src/worker-pool.js";
import { LOCAL_ACCESS, testAccess } from "../actors.js";

const CWD = "/projects/a";
const PATH = "/sessions/a.jsonl";
const FORKED = "/sessions/a-forked.jsonl";

const cleanups: Array<() => void> = [];
afterEach(() => {
  for (const cleanup of cleanups.splice(0)) cleanup();
});

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

/**
 * A Router over a real register, with a worker whose answer to a fork the test
 * writes — including anything it publishes on the way, as the real one does.
 */
function harness(options: { fork?: (register: TaskRegister) => unknown } = {}) {
  const dir = mkdtempSync(join(tmpdir(), `${PRODUCT_NAME}-fork-rekey-`));
  const open = new Set([PATH]);
  const rows: SessionSummary[] = [
    { path: PATH, id: "session-1", cwd: CWD, createdAt: "2026-06-01T00:00:00.000Z", modifiedAt: "2026-06-01T00:00:00.000Z", messageCount: 1 },
  ];
  const catalog = {
    list: () => rows.map((row) => ({ ...row, size: 1 })),
    get: (path: string) => rows.find((row) => row.path === path),
    getListed: (path: string) => rows.find((row) => row.path === path),
    cwdOf: (path: string) => rows.find((row) => row.path === path)?.cwd ?? CWD,
    cwdCounts: () => new Map<string, number>(),
    invalidate: () => {},
  } as unknown as SessionCatalog;

  const broadcast: BackgroundTask[] = [];
  const tasks = new TaskRegister({ notify: (_method, params) => broadcast.push(params.task) });
  const leases = new SessionRouteLeases();
  const worker = {
    request: async (method: string, params: unknown) => {
      const path = (params as { path?: string }).path;
      if (method !== "session/load" && path !== undefined && !open.has(path)) {
        throw new ProtocolError(ErrorCodes.SessionNotFound, `session ${path} is not open in this worker`);
      }
      if (method === "pi/session/fork") {
        return options.fork ? options.fork(tasks) : { state: { path: FORKED, id: "session-1", cwd: CWD, messageCount: 2, isStreaming: false } };
      }
      return {};
    },
  };
  const pool = {
    routeLeases: leases,
    openSessions: (cwd: string) => (cwd === CWD ? [...open] : []),
    cwdOfSession: (path: string) => (open.has(path) ? CWD : undefined),
    bindSession: (path: string) => open.add(path),
    recoverOpenedSession: async () => undefined,
    rekeySession: (from: string, to: string) => {
      open.delete(from);
      open.add(to);
    },
    ownerOfSession: () => undefined,
    get: async () => worker,
  } as unknown as WorkerPool;

  const attention = new AttentionTracker({});
  const projects = new ProjectRegistry({ catalog, agentDir: dir });
  projects.add(CWD);
  const router = new Router(pool, catalog, { attention, projects, views: new ViewCache(2), access: testAccess(), routeLeases: leases, tasks });
  cleanups.push(() => {
    projects.close();
    attention.close();
    rmSync(dir, { recursive: true, force: true });
  });
  const call = (method: string, params: unknown) =>
    router.handle({ jsonrpc: "2.0", id: 1, method, params }, LOCAL_ACCESS) as Promise<{ result?: unknown; error?: { code: number; message: string } }>;
  const listed = async (path?: string): Promise<BackgroundTask[]> => {
    const answer = await call("tasks/list", path === undefined ? {} : { path });
    expect(answer.error, JSON.stringify(answer.error)).toBeUndefined();
    return (answer.result as { tasks: BackgroundTask[] }).tasks;
  };
  return { call, tasks, broadcast, listed, open };
}

describe("a forked conversation's commands, through the router", () => {
  it("moves them to the file the fork gave it, leaving nothing under the old one", async () => {
    const h = harness();
    h.tasks.observeExtensionMessage(PATH, { type: "lasercode/task/update", task: update() });
    expect((await h.listed(PATH)).map((task) => task.id)).toEqual(["t-1"]);

    const forked = await h.call("pi/session/fork", { path: PATH, entryId: "e1" });
    expect(forked.error, JSON.stringify(forked.error)).toBeUndefined();

    // One command, one row, under the conversation that exists — for a client
    // asking about the new session, for one re-listing the old one, and for the
    // fleet, which asks for all of them at once and keys them by id.
    expect(await h.listed(PATH)).toEqual([]);
    expect(await h.listed(FORKED)).toEqual([expect.objectContaining({ id: "t-1", status: "running", sessionPath: FORKED })]);
    expect(await h.listed()).toHaveLength(1);
    expect(h.broadcast.at(-1)).toMatchObject({ id: "t-1", sessionPath: FORKED, status: "running" });
  });

  it("keeps the row the worker published before it answered, rather than the one the fork superseded", async () => {
    // The real ordering: the worker re-keys its own structures and publishes
    // under the new path, then answers. The reply is what tells the host the
    // session moved, so by then the newer row is already filed at the new path.
    const h = harness({
      fork: (register) => {
        register.observeExtensionMessage(FORKED, {
          type: "lasercode/task/update",
          task: update({ status: "completed", exitCode: 0, endedAt: "2026-09-08T10:01:00.000Z", outputBytes: 2_048, terminalReason: "exit code 0" }),
        });
        return { state: { path: FORKED, id: "session-1", cwd: CWD, messageCount: 2, isStreaming: false } };
      },
    });
    h.tasks.observeExtensionMessage(PATH, { type: "lasercode/task/update", task: update({ outputBytes: 12 }) });

    const forked = await h.call("pi/session/fork", { path: PATH, entryId: "e1" });
    expect(forked.error).toBeUndefined();

    const all = await h.listed();
    expect(all).toHaveLength(1);
    expect(all[0]).toMatchObject({ id: "t-1", status: "completed", outputBytes: 2_048, terminalReason: "exit code 0", sessionPath: FORKED });
    // A command that ended is never shown as running again because its
    // session's file moved.
    expect(h.broadcast.filter((task) => task.status === "running" && task.sessionPath === FORKED)).toEqual([]);
    expect(await h.listed(PATH)).toEqual([]);
  });

  it("moves nothing when the fork itself failed", async () => {
    const h = harness({
      fork: () => {
        throw new ProtocolError(ErrorCodes.InvalidParams, "that entry is not in this conversation");
      },
    });
    h.tasks.observeExtensionMessage(PATH, { type: "lasercode/task/update", task: update() });
    const told = h.broadcast.length;

    const refused = await h.call("pi/session/fork", { path: PATH, entryId: "nope" });
    expect(refused.error?.message).toMatch(/not in this conversation/);

    // Nothing moved, nothing was said, and the conversation that really exists
    // still owns its command.
    expect((await h.listed(PATH)).map((task) => task.id)).toEqual(["t-1"]);
    expect(await h.listed(FORKED)).toEqual([]);
    expect(h.broadcast.length).toBe(told);
  });

  it("does nothing at all when the answer names the same file", async () => {
    const h = harness({
      fork: () => ({ state: { path: PATH, id: "session-1", cwd: CWD, messageCount: 2, isStreaming: false } }),
    });
    h.tasks.observeExtensionMessage(PATH, { type: "lasercode/task/update", task: update() });
    const told = h.broadcast.length;

    expect((await h.call("pi/session/fork", { path: PATH, entryId: "e1" })).error).toBeUndefined();

    expect((await h.listed(PATH)).map((task) => task.id)).toEqual(["t-1"]);
    expect(h.broadcast.length).toBe(told);
  });
});
