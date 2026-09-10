/**
 * M2-T1 done-when: "test covers restart and duplicate-cwd refusal".
 *
 * Against a fake worker (a real child process speaking the fd-3 protocol, so
 * the spawn, the pipe and the exit are the real ones) rather than the Pi
 * worker: this is the pool's state machine under test, not Pi.
 */
import { PRODUCT_NAME } from "@lasercode/protocol";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { JsonRpcNotification, WorkerInfo } from "@lasercode/protocol";
import { WorkerPool } from "../src/worker-pool.js";

/**
 * Speaks just enough protocol: announces `ready`, answers `session/load`, and
 * exits on `pi/test/crash` so a crash is a real process death.
 */
const FAKE_WORKER = `
import { Socket } from "node:net";
const cwd = process.argv[process.argv.indexOf("--cwd") + 1];
const socket = new Socket({ fd: 3, readable: true, writable: true });
const send = (m) => socket.write(JSON.stringify(m) + "\\n");
let buffer = "";
socket.setEncoding("utf8");
socket.on("data", (chunk) => {
  buffer += chunk;
  let i;
  while ((i = buffer.indexOf("\\n")) >= 0) {
    const line = buffer.slice(0, i);
    buffer = buffer.slice(i + 1);
    if (!line) continue;
    const req = JSON.parse(line);
    if (req.method === "pi/test/crash") process.exit(9);
    if (req.method === "pi/test/argv") { send({ jsonrpc: "2.0", id: req.id, result: { argv: process.argv.slice(2), processCwd: process.cwd() } }); continue; }
    if (req.method === "session/load" && req.params.path === "/sessions/unwritten.jsonl") { send({ jsonrpc: "2.0", id: req.id, error: { code: -32001, message: "No saved transcript. Start a new session." } }); continue; }
    send({ jsonrpc: "2.0", id: req.id, result: { ok: true, method: req.method } });
  }
});
socket.on("end", () => process.exit(0));
send({ jsonrpc: "2.0", method: "pi/worker/status", params: { cwd, status: "ready" } });
`;

/**
 * The same worker, but it takes a moment to die after the pipe closes — which
 * is what a real worker tearing a Pi session down does. Without that delay the
 * retire/get race below cannot be observed at all.
 */
const SLOW_EXIT_WORKER = FAKE_WORKER.replace(
  'socket.on("end", () => process.exit(0));',
  'socket.on("end", () => setTimeout(() => process.exit(0), 400));',
);

let dir: string;
let workerMain: string;
let project: string;
let notifications: JsonRpcNotification[];
let statuses: WorkerInfo[];
let pool: WorkerPool;

const statusesOf = (cwd: string) => statuses.filter((s) => s.cwd === cwd).map((s) => s.status);

/** Fire scheduled backoff timers by hand so a test never waits on wall clock. */
let timers: Array<{ fn: () => void; ms: number }>;

function makePool(options: Partial<ConstructorParameters<typeof WorkerPool>[0]> = {}): WorkerPool {
  return new WorkerPool({
    workerMain,
    onNotification: (_cwd, n) => notifications.push(n),
    onStatus: (info) => statuses.push(info),
    setTimer: (fn, ms) => {
      timers.push({ fn, ms });
      return setTimeout(() => {}, 0) as ReturnType<typeof setTimeout>;
    },
    ...options,
  });
}

const runTimers = () => {
  const due = timers.splice(0, timers.length);
  for (const timer of due) timer.fn();
};

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), `${PRODUCT_NAME}-pool-`));
  project = join(dir, "project");
  mkdirSync(project);
  workerMain = join(dir, "fake-worker.mjs");
  writeFileSync(workerMain, FAKE_WORKER);
  notifications = [];
  statuses = [];
  timers = [];
});

afterEach(async () => {
  await pool?.stopAll();
  rmSync(dir, { recursive: true, force: true });
});

describe("WorkerPool", () => {
  it("reports starting before ready, and only one process per cwd", async () => {
    pool = makePool();
    const [a, b] = await Promise.all([pool.get(project), pool.get(project)]);
    expect(a).toBe(b); // one spawn shared by concurrent callers
    expect(pool.cwds()).toEqual([project]);
    expect(statusesOf(project)).toEqual(["starting", "ready"]);
    // The pool refuses to spawn over a live worker rather than trusting itself.
    await expect(pool["spawn"](pool["entries"].get(project))).rejects.toThrow(/already running/);
    expect(pool.cwds()).toHaveLength(1);
  });

  it("restarts a crashed worker with backoff and re-opens its sessions", async () => {
    pool = makePool({ backoffMs: 10 });
    const client = await pool.get(project);
    pool.bindSession("/sessions/a.jsonl", project);
    const firstPid = client.pid;

    client.request("pi/test/crash", {}).catch(() => {});
    await waitFor(() => statusesOf(project).includes("crashed"));
    expect(pool.openSessions(project)).toEqual([]); // desired reopen paths are not live sessions
    const crashed = statuses.findLast((s) => s.status === "crashed")!;
    expect(crashed.message).toMatch(/Restarting in/);
    expect(crashed.restarts).toBe(1);
    expect(timers).toHaveLength(1);
    expect(timers[0]!.ms).toBe(10);

    runTimers();
    await waitFor(() => statusesOf(project).at(-1) === "ready");
    const ready = statuses.findLast((s) => s.status === "ready")!;
    expect(ready.reopened).toEqual(["/sessions/a.jsonl"]);
    expect(ready.pid).not.toBe(firstPid);
    expect(pool.openSessions(project)).toEqual(["/sessions/a.jsonl"]);
    // The count stays: it resets only after the worker has been healthy for a
    // while, so a crash loop still reaches the cap.
    expect(pool.workerInfo(project)?.restarts).toBe(1);
  });

  it("recovers saved sessions but drops an unwritten session the restarted worker refuses", async () => {
    pool = makePool();
    const client = await pool.get(project);
    pool.bindSession("/sessions/unwritten.jsonl", project);
    pool.bindSession("/sessions/saved.jsonl", project);
    client.request("pi/test/crash", {}).catch(() => {});
    await waitFor(() => statusesOf(project).includes("crashed"));
    runTimers();
    await waitFor(() => pool.openSessions(project).includes("/sessions/saved.jsonl"));
    expect(pool.openSessions(project)).toEqual(["/sessions/saved.jsonl"]);
    const recovered = await pool.get(project);
    const result = await recovered.request<{ processCwd: string }>("pi/test/argv", {});
    expect(result.processCwd).toBe(project);
  });

  it("gives up after the restart cap and comes back on an explicit retry", async () => {
    pool = makePool({ backoffMs: 1, maxRestarts: 2 });
    const client = await pool.get(project);
    pool.bindSession("/sessions/a.jsonl", project);

    let current = client;
    for (let attempt = 1; attempt <= 3; attempt++) {
      current.request("pi/test/crash", {}).catch(() => {});
      await waitFor(() => statuses.filter((s) => s.status === "crashed").length === attempt);
      if (attempt === 3) break;
      runTimers();
      await waitFor(() => statusesOf(project).at(-1) === "ready");
      current = await pool.get(project);
    }
    const last = statuses.findLast((s) => s.status === "crashed")!;
    expect(last.message).toMatch(/did not recover after 2 restarts/);
    expect(last.canRestart).toBe(true);
    expect(timers).toHaveLength(0); // no further automatic attempt

    const info = await pool.restart(project);
    expect(info.status).toBe("ready");
    expect(info.restarts).toBe(0);
  });

  it("retires an idle worker, but not one a client is attached to", async () => {
    let attached = true;
    pool = makePool({ idleMs: 1, sweepMs: 0, isAttached: () => attached, });
    await pool.get(project);
    pool.bindSession("/sessions/a.jsonl", project);
    await new Promise((r) => setTimeout(r, 5));

    pool["sweep"]();
    expect(statusesOf(project).at(-1)).toBe("ready");

    attached = false;
    pool["sweep"]();
    await waitFor(() => statusesOf(project).at(-1) === "retired");
    expect(pool.cwds()).toEqual([]);
    expect(pool.openSessions(project)).toEqual([]);
    expect(pool.workerInfo(project)?.canRestart).toBe(true);

    // Retiring is not forgetting the route: the next request starts it again.
    await pool.get(project);
    expect(statusesOf(project).at(-1)).toBe("ready");
  });

  it("never retires a worker while one of its sessions is running", async () => {
    pool = makePool({ idleMs: 1, sweepMs: 0, isAttached: () => false, });
    await pool.get(project);
    pool.bindSession("/sessions/a.jsonl", project);
    pool.noteRunning(project, "/sessions/a.jsonl", true);
    await new Promise((r) => setTimeout(r, 5));

    pool["sweep"]();
    expect(statusesOf(project).at(-1)).toBe("ready");
    await expect(pool.stop(project)).rejects.toThrow(/running an agent/);

    pool.noteRunning(project, "/sessions/a.jsonl", false);
    await new Promise((r) => setTimeout(r, 5));
    pool["sweep"]();
    await waitFor(() => statusesOf(project).at(-1) === "retired");
  });

  it("never retires a worker while one of its agents is still working, however long that takes", async () => {
    // A child agent's turn is not a client request, so nothing else keeps the
    // project alive; retiring here would kill the agent mid-sentence, and a
    // run has no time limit at all (D-144).
    let working = true;
    pool = makePool({ idleMs: 1, sweepMs: 0, isAttached: () => false, hasLiveRun: (cwd) => working && cwd === project });
    await pool.get(project);
    pool.bindSession("/sessions/a.jsonl", project);
    await new Promise((r) => setTimeout(r, 5));

    // Months of an agent working alone, with nobody watching.
    for (let i = 0; i < 5; i++) pool["sweep"]();
    expect(statusesOf(project).at(-1)).toBe("ready");

    working = false;
    pool["sweep"]();
    await waitFor(() => statusesOf(project).at(-1) === "retired");
  });

  it("never spawns a second worker while the first is still shutting down", async () => {
    // The regression: `retire()` used to drop `entry.client` before the child
    // had exited, so a request arriving in that window (a `pi/worker/stop`
    // followed by clicking a session — the server handles both concurrently)
    // spawned a second process on the same directory and the same Pi session
    // files, and the losing retire then stamped "retired" on the live one.
    writeFileSync(workerMain, SLOW_EXIT_WORKER);
    pool = makePool();
    const first = await pool.get(project);
    const firstPid = first.pid!;

    const stopping = pool.stop(project, "stopped from the app");
    await new Promise((r) => setTimeout(r, 20)); // inside the shutdown window
    const second = await pool.get(project);

    expect(isAlive(firstPid)).toBe(false); // the old process was gone first
    expect(second.pid).not.toBe(firstPid);
    await stopping;

    expect(pool.workerInfo(project)).toMatchObject({ status: "ready", pid: second.pid });
    expect(statusesOf(project)).toEqual(["starting", "ready", "retired", "starting", "ready"]);
  });

  it("reports a worker that could not be spawned as crashed, with a retry", async () => {
    pool = makePool({ nodeBinary: join(dir, "no-such-node") });
    await expect(pool.get(project)).rejects.toThrow(/ENOENT/);
    const info = pool.workerInfo(project)!;
    expect(info.status).toBe("crashed");
    expect(info.canRestart).toBe(true);
    expect(info.message).toMatch(/could not start/);
  });

  it("passes --state-dir and primes a worker before get() resolves, surviving a refused prime", async () => {
    const primed: string[] = [];
    const stderr: string[] = [];
    pool = makePool({
      stateDir: join(dir, "state"),
      onStderr: (_cwd, text) => stderr.push(text),
      prime: async (client, cwd) => {
        const result = await client.request<{ ok: boolean; method: string }>("agents/sync", { snapshot: { revision: 1 } });
        primed.push(`${cwd}:${result.method}`);
      },
    });
    const client = await pool.get(project);
    expect(primed).toEqual([`${project}:agents/sync`]); // before anyone else could ask
    const { argv, processCwd } = await client.request<{ argv: string[]; processCwd: string }>("pi/test/argv", {});
    expect(argv[argv.indexOf("--state-dir") + 1]).toBe(join(dir, "state"));
    expect(processCwd).toBe(project);
    expect(processCwd).not.toBe(process.cwd());

    const other = join(dir, "other");
    mkdirSync(other);
    const refusing = makePool({
      onStderr: (_cwd, text) => stderr.push(text),
      prime: async () => {
        throw new Error("unknown method agents/sync");
      },
    });
    const survivor = await refusing.get(other);
    expect(survivor.alive).toBe(true);
    expect(stderr.join("")).toContain("priming failed: unknown method agents/sync");
    expect(await refusing.broadcastRequest("agents/sync", {})).toEqual([{ cwd: other }]);
    await refusing.stopAll();
  });

  it("passes the host's trust decision to the worker and refuses the spawn when trust throws", async () => {
    pool = makePool({ resolveTrust: () => Promise.resolve(false) });
    const client = await pool.get(project);
    const { argv } = await client.request<{ argv: string[] }>("pi/test/argv", {});
    expect(argv).toContain("--project-trusted");
    expect(argv[argv.indexOf("--project-trusted") + 1]).toBe("no");

    const other = join(dir, "untrusted");
    const refusing = makePool({ resolveTrust: () => Promise.reject(new Error("needs approval")) });
    await expect(refusing.get(other)).rejects.toThrow("needs approval");
    expect(refusing.workerInfo(other)).toMatchObject({ status: "crashed", message: "needs approval" });
    await refusing.stopAll();
  });
});

function isAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

async function waitFor(predicate: () => boolean, ms = 5000): Promise<void> {
  const deadline = Date.now() + ms;
  while (!predicate()) {
    if (Date.now() > deadline) throw new Error("timed out waiting for a pool state change");
    await new Promise((r) => setTimeout(r, 5));
  }
}
