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
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { SessionLifetime } from "../src/session-lifetime.js";
import { WorkerRetiredError } from "../src/worker-client.js";
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
  it("pressure releases at most one oldest authorized session", async () => {
    const world = policyWorld([
      row("/s/new.jsonl", { activity: 900 }),
      row("/s/old.jsonl", { activity: 100 }),
    ]);
    const result = await world.lifetime.pressurePass(() => "authorized");
    expect(result).toEqual({ action: "idle_session_unload", outcome: "released", released: { count: 1 } });
    expect(world.asked).toEqual([{ path: "/s/old.jsonl", reason: "budget" }]);
    expect(world.loaded.has("/s/new.jsonl")).toBe(true);
  });

  it("pressure preserves a pinned session and uses the sweep's refusal backoff", async () => {
    const world = policyWorld([row("/s/pinned.jsonl", { pins: [{ kind: "turn", detail: "running" }] })], { maxLoadedPerWorker: 0 });
    expect(await world.lifetime.pressurePass(() => "authorized")).toEqual({ action: "idle_session_unload", outcome: "held", reason: "pins_held" });
    expect(await world.lifetime.pressurePass(() => "authorized")).toEqual({ action: "idle_session_unload", outcome: "held", reason: "pins_held" });
    expect(world.asked).toHaveLength(1);
  });

  it("pressure preserves membership acquired on its destructive recheck", async () => {
    let checks = 0;
    const unload = vi.fn();
    const lifetime = new SessionLifetime({
      holders: () => ++checks === 1 ? 0 : 1,
      loadedSessions: () => [{ cwd: "/repo", path: "/s/race.jsonl" }],
      lastActivity: () => 1,
      unload,
      now: () => 2,
    }, { workerIdleMs: 0, maxLoadedPerWorker: 0 });
    expect(await lifetime.pressurePass(() => "authorized")).toEqual({ action: "idle_session_unload", outcome: "held", reason: "membership_held" });
    expect(unload).not.toHaveBeenCalled();
  });

  it("pressure distinguishes a moved generation from a worker outside this pass", async () => {
    const moved = policyWorld([row("/s/race.jsonl")], { maxLoadedPerWorker: 0 });
    expect(await moved.lifetime.pressurePass(() => "generation_moved")).toEqual({ action: "idle_session_unload", outcome: "refused", reason: "generation_mismatch" });
    expect(moved.asked).toEqual([]);

    const absent = policyWorld([row("/s/not-authorized.jsonl")], { maxLoadedPerWorker: 0 });
    expect(await absent.lifetime.pressurePass(() => "not_in_pass")).toEqual({ action: "idle_session_unload", outcome: "nothing_to_give" });
    expect(absent.asked).toEqual([]);
  });

  it("does not call a transport-failure backoff pins held", async () => {
    let attempts = 0;
    const lifetime = new SessionLifetime({
      holders: () => 0,
      loadedSessions: () => [{ cwd: "/repo", path: "/s/unavailable.jsonl" }],
      lastActivity: () => 0,
      unload: async () => { attempts += 1; throw new Error("pipe closed"); },
      now: () => 1_000_000,
    }, { workerIdleMs: 0, maxLoadedPerWorker: 0 });
    expect(await lifetime.pressurePass(() => "authorized")).toEqual({ action: "idle_session_unload", outcome: "unavailable" });
    expect(await lifetime.pressurePass(() => "authorized")).toEqual({ action: "idle_session_unload", outcome: "unavailable" });
    expect(attempts).toBe(1);
  });

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
    // A refusal waits its turn before it is asked again, so the next sweep
    // skips it rather than spending the tick on the same pin.
    await world.lifetime.sweep();
    expect(world.asked).toHaveLength(1);
    expect(world.lifetime.counts().skippedBackoff).toBe(1);
    world.advance(world.lifetime.sessionIdleMs);
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

  it("keeps scanning past a permanently pinned oldest row until the worker is back inside its set", async () => {
    // Six conversations nobody is following, a set of four, and the two oldest
    // refusing for ever. The two that have to go are further down the list.
    const rows = Array.from({ length: 6 }, (_, index) =>
      row(`/s/${index}.jsonl`, { activity: 1_000_000 + index, pins: index < 2 ? [{ kind: "approval" as const }] : [] }),
    );
    const world = policyWorld(rows, { maxLoadedPerWorker: 4 });
    await world.lifetime.sweep();
    expect([...world.loaded.keys()].sort()).toEqual(["/s/0.jsonl", "/s/1.jsonl", "/s/4.jsonl", "/s/5.jsonl"]);
    expect(world.lifetime.counts()).toMatchObject({ budgetTarget: expect.any(Number), budgetRemoved: 2 });

    // And the pins that never clear cost one attempt occasionally, not the tick.
    const askedBefore = world.asked.length;
    await world.lifetime.sweep();
    expect(world.asked.length - askedBefore).toBeLessThanOrEqual(1);
  });

  it("gives every worker a share of one sweep, and rotates which goes first", async () => {
    const rows = [
      ...Array.from({ length: 8 }, (_, index) => row(`/a/${index}.jsonl`, { cwd: "/a", activity: 1_000 + index, pins: [{ kind: "streaming" as const }] })),
      row("/b/0.jsonl", { cwd: "/b", activity: 1_000 }),
      row("/b/1.jsonl", { cwd: "/b", activity: 1_001 }),
    ];
    const world = policyWorld(rows, { maxUnloadsPerTick: 4 });
    world.advance(world.lifetime.sessionIdleMs + 100);
    await world.lifetime.sweep();
    // The refusing worker cannot spend the whole tick: the other one was asked
    // in the same sweep and its sessions are gone.
    expect(world.asked.some((ask) => ask.path.startsWith("/b/"))).toBe(true);
    expect(world.loaded.has("/b/0.jsonl")).toBe(false);
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
const launchId = process.argv[process.argv.indexOf("--launch-id") + 1];
const socket = new Socket({ fd: 3, readable: true, writable: true });
const send = (m) => socket.write(JSON.stringify(m) + "\\n");
let buffer = "";
let pins = [];
let mode = "answer";
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
    if (req.method === "pi/test/crash") process.exit(9);
    if (req.method === "pi/test/pin") { pins = req.params.pins; send({ jsonrpc: "2.0", id: req.id, result: {} }); continue; }
    if (req.method === "pi/test/mode") { mode = req.params.mode; send({ jsonrpc: "2.0", id: req.id, result: {} }); continue; }
    if (req.method === "session/load") {
      loaded.add(req.params.path);
      send({ jsonrpc: "2.0", id: req.id, result: { state: { path: req.params.path }, replayFrom: 0, seq: 0 } });
      continue;
    }
    if (req.method === "pi/worker/retire") {
      if (mode === "silent") continue;
      if (mode === "slow-ack") {
        // Agrees, but its answer arrives long after the host gave up: the
        // ambiguous case the retirement lease exists for.
        setTimeout(() => send({ jsonrpc: "2.0", id: req.id, result: { retiring: true } }), 300);
        continue;
      }
      if (mode === "error") { send({ jsonrpc: "2.0", id: req.id, error: { code: -32603, message: "cannot look" } }); continue; }
      if (mode === "malformed") { send({ jsonrpc: "2.0", id: req.id, result: { ok: true } }); continue; }
      if (pins.length > 0) {
        send({ jsonrpc: "2.0", id: req.id, result: { retiring: false, reason: "pinned", sessions: undefined, pins: [...loaded].map((path) => ({ path, pins })) } });
        continue;
      }
      send({ jsonrpc: "2.0", id: req.id, result: { retiring: true } });
      continue;
    }
    if (req.method === "pi/worker/safety") {
      if (mode === "silent") continue;
      if (mode === "error") { send({ jsonrpc: "2.0", id: req.id, error: { code: -32603, message: "cannot look" } }); continue; }
      if (mode === "truncated") { send({ jsonrpc: "2.0", id: req.id, result: { sessions: [...loaded].map((path) => ({ path, pins })), complete: false } }); continue; }
      if (mode === "partial") { send({ jsonrpc: "2.0", id: req.id, result: { sessions: [], complete: true } }); continue; }
      send({ jsonrpc: "2.0", id: req.id, result: { sessions: [...loaded].map((path) => ({ path, pins })), complete: true } });
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
send({ jsonrpc: "2.0", method: "pi/worker/status", params: { cwd, status: "starting", launchId, mode: "normal" } });
send({ jsonrpc: "2.0", method: "pi/worker/status", params: { cwd, status: "ready", launchId, mode: "normal" } });
`;

/** The same worker, without RP-4's methods: an older generation the host must tolerate. */
const SILENT_WORKER = SAFETY_WORKER
  .replace('if (req.method === "pi/worker/retire") {', 'if (false) {')
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

  const retireIfSafe = (worker: WorkerPool) =>
    (worker as unknown as { retireIfSafe(entry: unknown): Promise<void> }).retireIfSafe(
      (worker as unknown as { entries: Map<string, unknown> }).entries.get(project),
    );

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
    await retireIfSafe(pool);
    expect(pool.workerInfo(project)?.status).toBe("ready");

    await client.request("pi/test/pin", { pins: [] });
    await retireIfSafe(pool);
    expect(pool.workerInfo(project)?.status).toBe("retired");
  });

  it("refuses an explicit stop while a conversation holds work, and allows it afterwards", async () => {
    pool = makePool(join(dir, "safety-worker.mjs"));
    const client = await openSession(pool, "/s/one.jsonl");
    await client.request("pi/test/pin", { pins: [{ kind: "pending_tray", detail: "1 message(s) waiting in the tray" }] });
    await expect(pool.stop(project)).rejects.toThrow(/could not be stopped: one of its conversations is holding work/);
    expect(pool.workerInfo(project)?.status).toBe("ready");

    await client.request("pi/test/pin", { pins: [] });
    await pool.stop(project);
    expect(pool.workerInfo(project)?.status).toBe("retired");
  });

  it("writes nothing to a worker while its retirement is being decided, and refuses the request that tried", async () => {
    pool = makePool(join(dir, "safety-worker.mjs"), { idleMs: 1_000, now: () => 0, retireTimeoutMs: 400, retireLeaseMs: 50 });
    const client = await openSession(pool, "/s/one.jsonl");
    // This worker never answers the retirement question, so the decision is
    // open for the whole timeout — the exact window the old check-then-kill
    // code could write into.
    await client.request("pi/test/mode", { mode: "silent" });
    const deciding = retireIfSafe(pool);
    await new Promise((resolve) => setTimeout(resolve, 20));

    await expect(client.request("session/prompt", { path: "/s/one.jsonl", params: {} })).rejects.toBeInstanceOf(WorkerRetiredError);
    // A caller going through the pool waits for the decision instead.
    const waiting = pool.get(project);
    await deciding;
    const same = await waiting;
    expect(same).toBe(client);
    expect(client.alive).toBe(true);
    expect(pool.workerInfo(project)?.status).toBe("ready");
    // Admission reopened with the refusal, so the retry lands.
    await expect(client.request("pi/test/argv", {})).resolves.toBeDefined();
  });
  it("waits out a silent worker's lease, never kills it, and ignores an acknowledgement that arrives late", async () => {
    pool = makePool(join(dir, "safety-worker.mjs"), { retireTimeoutMs: 60, retireLeaseMs: 80 });
    const client = await openSession(pool, "/s/one.jsonl");
    await client.request("pi/test/mode", { mode: "slow-ack" });

    const started = Date.now();
    await expect(pool.stop(project)).rejects.toThrow(/could not be stopped/);
    // The host waited for the worker's own lease before writing again, rather
    // than reopening onto a worker that may still be fenced.
    expect(Date.now() - started).toBeGreaterThanOrEqual(120);

    // Nothing was killed, and the late acknowledgement cannot stop it either.
    expect(client.alive).toBe(true);
    expect(pool.workerInfo(project)?.status).toBe("ready");
    await new Promise((resolve) => setTimeout(resolve, 300));
    expect(client.alive).toBe(true);
    expect(pool.workerInfo(project)?.status).toBe("ready");

    // Admission reopened: this worker takes work again.
    await client.request("pi/test/mode", { mode: "answer" });
    await expect(client.request("pi/test/argv", {})).resolves.toBeDefined();
    expect(pool.openSessions(project)).toEqual(["/s/one.jsonl"]);
  });

  it("moves a session's row when a fork moves its file, leaving no phantom behind", async () => {
    pool = makePool(join(dir, "safety-worker.mjs"));
    await openSession(pool, "/s/source.jsonl");
    expect(pool.loadedSessions()).toEqual([{ cwd: project, path: "/s/source.jsonl" }]);

    // What the router does after a fork answers with a new path.
    pool.rekeySession("/s/source.jsonl", "/s/forked.jsonl", project);
    expect(pool.loadedSessions()).toEqual([{ cwd: project, path: "/s/forked.jsonl" }]);
    expect(pool.openSessions(project)).toEqual(["/s/forked.jsonl"]);
    expect(pool.cwdOfSession("/s/source.jsonl")).toBeUndefined();
    expect(pool.cwdOfSession("/s/forked.jsonl")).toBe(project);

    // The lifetime works on the row that exists, and the worker knows it.
    expect(await pool.unloadSession(project, "/s/forked.jsonl")).toEqual({ unloaded: true, pins: [] });
    expect(pool.loadedSessions()).toEqual([]);

    // Opening the source again is a separate runtime with a row of its own.
    await openSession(pool, "/s/source.jsonl");
    expect(pool.loadedSessions()).toEqual([{ cwd: project, path: "/s/source.jsonl" }]);
    // And a rekey onto a path this worker already serves keeps one row, not two.
    await openSession(pool, "/s/forked.jsonl");
    pool.rekeySession("/s/source.jsonl", "/s/forked.jsonl", project);
    expect(pool.loadedSessions()).toEqual([{ cwd: project, path: "/s/forked.jsonl" }]);
  });

  it("refuses a release the worker never answered, without forgetting the session", async () => {
    pool = makePool(join(dir, "silent-worker.mjs"));
    await openSession(pool, "/s/one.jsonl");
    expect(await pool.unloadSession(project, "/s/one.jsonl")).toEqual({ unloaded: false, pins: [] });
    expect(pool.openSessions(project)).toEqual(["/s/one.jsonl"]);
  });
});
