/**
 * RP-4 · when a worker session's runtime is released, and when a worker may be
 * retired at all.
 *
 * Two halves. The policy is tested on its own, with injected deps and an
 * injected clock, because "before retirement" is a statement about time. The
 * pool half runs a real child process speaking the fd-3 protocol, so the
 * release, the refusal and the retirement admission are the real requests.
 */
import { PRODUCT_NAME, type SessionPin } from "@lasercode/protocol";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { SessionLifetime } from "../src/session-lifetime.js";
import { WorkerPool } from "../src/worker-pool.js";

// --------------------------------------------------------------- the policy

interface Loaded {
  cwd: string;
  path: string;
  activity: number;
  holders: number;
  pins: SessionPin[];
}

function policyWorld(rows: Loaded[], options: Parameters<typeof SessionLifetime>[1] = {}) {
  const asked: Array<{ path: string; reason: string }> = [];
  let clock = 1_000_000;
  const loaded = new Map(rows.map((row) => [row.path, { ...row }]));
  const lifetime = new SessionLifetime(
    {
      holders: (path) => loaded.get(path)?.holders ?? 0,
      loadedSessions: () => [...loaded.values()].map(({ cwd, path }) => ({ cwd, path })),
      lastActivity: (path) => loaded.get(path)?.activity,
      unload: async (_cwd, path, reason) => {
        asked.push({ path, reason });
        const row = loaded.get(path)!;
        if (row.pins.length > 0) return { unloaded: false, pins: row.pins };
        loaded.delete(path);
        return { unloaded: true, pins: [] };
      },
      now: () => clock,
      // The policy's own timer is never started here: each test drives sweeps.
      setTimer: () => setInterval(() => {}, 1_000_000),
    },
    { workerIdleMs: 10 * 60_000, ...options },
  );
  return {
    lifetime,
    asked,
    loaded,
    advance: (ms: number) => { clock += ms; },
    hold: (path: string, holders: number) => { loaded.get(path)!.holders = holders; },
  };
}

const row = (path: string, patch: Partial<Loaded> = {}): Loaded => ({
  cwd: "/repo",
  path,
  activity: 1_000_000,
  holders: 0,
  pins: [],
  ...patch,
});

describe("SessionLifetime policy", () => {
  it("never releases a session a connection or a scope is holding", async () => {
    const world = policyWorld([row("/s/held.jsonl", { holders: 1 })]);
    world.advance(10 * 60_000);
    await world.lifetime.sweep();
    expect(world.asked).toEqual([]);
    expect(world.loaded.has("/s/held.jsonl")).toBe(true);
  });

  it("releases a session nobody follows once it has been quiet for the threshold", async () => {
    const world = policyWorld([row("/s/dormant.jsonl")]);
    await world.lifetime.sweep();
    expect(world.asked).toEqual([]);
    world.advance(world.lifetime.sessionIdleMs);
    await world.lifetime.sweep();
    expect(world.asked).toEqual([{ path: "/s/dormant.jsonl", reason: "idle" }]);
    expect(world.loaded.has("/s/dormant.jsonl")).toBe(false);
  });

  it("releases the least recently active sessions when a worker holds more than its set", async () => {
    const rows = Array.from({ length: 6 }, (_, index) => row(`/s/${index}.jsonl`, { activity: 1_000_000 + index }));
    const world = policyWorld(rows, { maxLoadedPerWorker: 4 });
    // Nothing is idle yet: the set, not the clock, is what releases these.
    await world.lifetime.sweep();
    expect(world.asked.map((ask) => ask.path)).toEqual(["/s/0.jsonl", "/s/1.jsonl"]);
    expect(world.asked.every((ask) => ask.reason === "budget")).toBe(true);
  });

  it("keeps a session the worker refuses, counts the pin and asks again later", async () => {
    const world = policyWorld([row("/s/busy.jsonl", { pins: [{ kind: "approval", detail: "1 approval(s) waiting" }] })]);
    world.advance(world.lifetime.sessionIdleMs);
    await world.lifetime.sweep();
    expect(world.loaded.has("/s/busy.jsonl")).toBe(true);
    expect(world.lifetime.counts()).toMatchObject({ considered: 1, unloaded: 0, refused: 1, pins: { approval: 1 } });
    await world.lifetime.sweep();
    expect(world.asked).toHaveLength(2);
  });

  it("does not ask about a session somebody opened while the pass was walking the list", async () => {
    const world = policyWorld([row("/s/a.jsonl", { activity: 1 }), row("/s/b.jsonl", { activity: 2 })]);
    world.advance(world.lifetime.sessionIdleMs);
    // The first release is where a person opens the second one.
    const original = world.loaded.get("/s/a.jsonl")!;
    world.loaded.set("/s/a.jsonl", { ...original });
    const sweep = world.lifetime.sweep();
    world.hold("/s/b.jsonl", 1);
    await sweep;
    expect(world.asked.map((ask) => ask.path)).toEqual(["/s/a.jsonl"]);
  });

  it("attempts at most its per-tick cap, so one sweep is never unbounded work", async () => {
    const rows = Array.from({ length: 9 }, (_, index) => row(`/s/${index}.jsonl`, { activity: 1_000_000 + index }));
    const world = policyWorld(rows, { maxUnloadsPerTick: 3 });
    world.advance(world.lifetime.sessionIdleMs + 100);
    await world.lifetime.sweep();
    expect(world.asked).toHaveLength(3);
  });

  it("always schedules itself inside the worker's own retirement threshold", () => {
    for (const workerIdleMs of [400, 1_500, 15_000, 60_000, 10 * 60_000]) {
      const lifetime = new SessionLifetime(
        { holders: () => 0, loadedSessions: () => [], lastActivity: () => undefined, unload: async () => ({ unloaded: false, pins: [] }) },
        { workerIdleMs },
      );
      expect(lifetime.sessionIdleMs + 2 * lifetime.sweepMs, `worker idle ${workerIdleMs}`).toBeLessThan(workerIdleMs);
    }
  });

  it("refuses a configuration where a release would happen after retirement", () => {
    expect(
      () =>
        new SessionLifetime(
          { holders: () => 0, loadedSessions: () => [], lastActivity: () => undefined, unload: async () => ({ unloaded: false, pins: [] }) },
          { workerIdleMs: 10_000, sessionIdleMs: 10_000 },
        ),
    ).toThrow(/must precede worker retirement/);
  });

  it("keeps a session whose worker could not answer at all", async () => {
    const lines: string[] = [];
    const lifetime = new SessionLifetime({
      holders: () => 0,
      loadedSessions: () => [{ cwd: "/repo", path: "/s/x.jsonl" }],
      lastActivity: () => 0,
      unload: async () => { throw new Error("worker went away"); },
      log: (line) => lines.push(line),
      now: () => 10 * 60_000,
      setTimer: () => setInterval(() => {}, 1_000_000),
    });
    await lifetime.sweep();
    expect(lines.join(" ")).toMatch(/worker went away/);
    expect(lifetime.counts()).toMatchObject({ considered: 1, unloaded: 0, refused: 0 });
  });
});

// ------------------------------------------------------------ with the pool

/**
 * A worker that holds one session and answers RP-4's two methods from a state
 * a test can change through a request, so a refusal is a real refusal.
 */
const SAFETY_WORKER = `
import { Socket } from "node:net";
const cwd = process.argv[process.argv.indexOf("--cwd") + 1];
const socket = new Socket({ fd: 3, readable: true, writable: true });
const send = (m) => socket.write(JSON.stringify(m) + "\\n");
let buffer = "";
let pins = [];
let loaded = new Set();
socket.setEncoding("utf8");
socket.on("data", (chunk) => {
  buffer += chunk;
  let i;
  while ((i = buffer.indexOf("\\n")) >= 0) {
    const line = buffer.slice(0, i);
    buffer = buffer.slice(i + 1);
    if (!line) continue;
    const req = JSON.parse(line);
    if (req.method === "pi/test/pin") { pins = req.params.pins; send({ jsonrpc: "2.0", id: req.id, result: {} }); continue; }
    if (req.method === "session/load") {
      loaded.add(req.params.path);
      send({ jsonrpc: "2.0", id: req.id, result: { state: { path: req.params.path }, replayFrom: 0, seq: 0 } });
      continue;
    }
    if (req.method === "pi/worker/safety") {
      send({ jsonrpc: "2.0", id: req.id, result: { sessions: [...loaded].map((path) => ({ path, pins })) } });
      continue;
    }
    if (req.method === "pi/session/unload") {
      if (pins.length > 0) { send({ jsonrpc: "2.0", id: req.id, result: { unloaded: false, pins } }); continue; }
      loaded.delete(req.params.path);
      send({ jsonrpc: "2.0", id: req.id, result: { unloaded: true, pins: [] } });
      continue;
    }
    send({ jsonrpc: "2.0", id: req.id, result: { ok: true, method: req.method } });
  }
});
socket.on("end", () => process.exit(0));
send({ jsonrpc: "2.0", method: "pi/worker/status", params: { cwd, status: "ready" } });
`;

/** The same worker, without RP-4's methods: an older generation the host must tolerate. */
const SILENT_WORKER = SAFETY_WORKER
  .replace('if (req.method === "pi/worker/safety") {', 'if (false) {')
  .replace('if (req.method === "pi/session/unload") {', 'if (false) {');

describe("WorkerPool session lifetime", () => {
  let dir: string;
  let project: string;
  let pool: WorkerPool | undefined;

  const makePool = (main: string, options: Partial<ConstructorParameters<typeof WorkerPool>[0]> = {}) =>
    new WorkerPool({ workerMain: main, onNotification: () => {}, sweepMs: 0, ...options });

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), `${PRODUCT_NAME}-lifetime-`));
    project = join(dir, "project");
    mkdirSync(project);
    writeFileSync(join(dir, "safety-worker.mjs"), SAFETY_WORKER);
    writeFileSync(join(dir, "silent-worker.mjs"), SILENT_WORKER);
  });

  afterEach(async () => {
    await pool?.stopAll();
    pool = undefined;
    rmSync(dir, { recursive: true, force: true });
  });

  const openSession = async (worker: WorkerPool, path: string) => {
    const client = await worker.get(project);
    await client.request("session/load", { path });
    worker.bindSession(path, project);
    return client;
  };

  it("forgets a session the worker released, and keeps one it refused", async () => {
    pool = makePool(join(dir, "safety-worker.mjs"));
    const client = await openSession(pool, "/s/one.jsonl");
    expect(pool.openSessions(project)).toEqual(["/s/one.jsonl"]);
    expect(pool.loadedSessions()).toEqual([{ cwd: project, path: "/s/one.jsonl" }]);

    await client.request("pi/test/pin", { pins: [{ kind: "streaming" }] });
    const refused = await pool.unloadSession(project, "/s/one.jsonl");
    expect(refused).toEqual({ unloaded: false, pins: [{ kind: "streaming" }] });
    expect(pool.openSessions(project)).toEqual(["/s/one.jsonl"]);

    await client.request("pi/test/pin", { pins: [] });
    const released = await pool.unloadSession(project, "/s/one.jsonl");
    expect(released).toEqual({ unloaded: true, pins: [] });
    expect(pool.openSessions(project)).toEqual([]);
    expect(pool.loadedSessions()).toEqual([]);
  });

  it("does not retire a worker whose session is holding work, and retires it once it is not", async () => {
    let now = 0;
    pool = makePool(join(dir, "safety-worker.mjs"), { idleMs: 1_000, now: () => now });
    const client = await openSession(pool, "/s/one.jsonl");
    await client.request("pi/test/pin", { pins: [{ kind: "question", detail: "1 question(s) waiting" }] });

    now += 10_000;
    await (pool as unknown as { retireIfSafe(entry: unknown): Promise<void> }).retireIfSafe(
      (pool as unknown as { entries: Map<string, unknown> }).entries.get(project),
    );
    expect(pool.workerInfo(project)?.status).toBe("ready");

    await client.request("pi/test/pin", { pins: [] });
    await (pool as unknown as { retireIfSafe(entry: unknown): Promise<void> }).retireIfSafe(
      (pool as unknown as { entries: Map<string, unknown> }).entries.get(project),
    );
    expect(pool.workerInfo(project)?.status).toBe("retired");
  });

  it("refuses an explicit stop while a conversation holds work, and allows it afterwards", async () => {
    pool = makePool(join(dir, "safety-worker.mjs"));
    const client = await openSession(pool, "/s/one.jsonl");
    await client.request("pi/test/pin", { pins: [{ kind: "pending_tray", detail: "1 message(s) waiting in the tray" }] });
    await expect(pool.stop(project)).rejects.toThrow(/holding work in one of its conversations/);
    expect(pool.workerInfo(project)?.status).toBe("ready");

    await client.request("pi/test/pin", { pins: [] });
    await pool.stop(project);
    expect(pool.workerInfo(project)?.status).toBe("retired");
  });

  it("keeps the behaviour it always had with a worker that cannot report safety", async () => {
    let now = 0;
    pool = makePool(join(dir, "silent-worker.mjs"), { idleMs: 1_000, now: () => now });
    await openSession(pool, "/s/one.jsonl");
    // Nothing answered `pi/worker/safety`, so the old guards decide — and they
    // say this worker is idle, attached to nobody and running nothing.
    now += 10_000;
    await (pool as unknown as { retireIfSafe(entry: unknown): Promise<void> }).retireIfSafe(
      (pool as unknown as { entries: Map<string, unknown> }).entries.get(project),
    );
    expect(pool.workerInfo(project)?.status).toBe("retired");
    // And a release it cannot perform is reported as one that did not happen.
    expect(await pool.unloadSession(project, "/s/one.jsonl")).toEqual({ unloaded: false, pins: [] });
  });
});
