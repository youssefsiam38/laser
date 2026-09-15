/**
 * RP-4 · the worker-wide replay ceiling.
 *
 * Per-session bounds say what one conversation may keep; this says what the
 * process may keep across all of them, and it is hard: pressure never wins,
 * however many sessions are streaming at once. What gives instead is the
 * oldest replayable suffix, whose floor rises — and a raised floor is exactly
 * what `session/load` already turns into a snapshot resync.
 */
import { describe, expect, it } from "vitest";
import type { ClientRequests, JsonRpcMessage, ModelRef, SessionState, SessionUpdate } from "@lasercode/protocol";
import { ReplayBudget, ReplayBuffer } from "../src/replay-buffer.js";
import { WorkerServer } from "../src/server.js";
import type { DriverEvent, DriverListener, SessionDriver } from "../src/driver.js";

function update(seq: number, text: string) {
  return {
    sessionPath: "/tmp/s.jsonl",
    seq,
    epoch: "e",
    at: "2026-01-01T00:00:00.000Z",
    update: { kind: "text_delta", delta: text, contentIndex: 0 } as SessionUpdate,
  };
}

describe("ReplayBuffer floors", () => {
  it("keeps a contiguous suffix and remembers what it no longer has", () => {
    const buffer = new ReplayBuffer(2, 1024 * 1024);
    buffer.push(update(1, "a"));
    buffer.push(update(2, "b"));
    expect(buffer.floor).toBe(0);
    buffer.push(update(3, "c"));
    expect(buffer.size).toBe(2);
    expect(buffer.floor).toBe(1);
    expect([...buffer].map((value) => value.seq)).toEqual([2, 3]);
    // The floor is always "the seq just before the oldest one still here".
    expect(buffer.first!.seq - 1).toBe(buffer.floor);
  });
});

describe("ReplayBudget", () => {
  it("holds the worker ceiling even when every session is pushing", () => {
    const budget = new ReplayBudget(4_000);
    let clock = 0;
    const buffers = [0, 1, 2].map(() => new ReplayBuffer(1_000, 1_000_000, budget, () => (clock += 1)));
    for (let seq = 1; seq <= 40; seq += 1) {
      for (const buffer of buffers) buffer.push(update(seq, "x".repeat(200)));
      // Checked after every single push, not only at the end: the ceiling is
      // a bound on what is held at any moment, not an average.
      expect(budget.bytes).toBeLessThanOrEqual(budget.limitBytes);
    }
    expect(budget.evictions).toBeGreaterThan(0);
    expect(budget.floorAdvances).toBe(budget.evictions);
    // Nothing was lost silently: every buffer that gave bytes says so.
    for (const buffer of buffers) {
      if (buffer.floor > 0) expect(buffer.first!.seq).toBe(buffer.floor + 1);
    }
  });

  it("takes from the least recently active session before the one that is pushing", () => {
    // Sized from the real serialized cost of one update, so the test states a
    // relationship ("nine updates fit") rather than a magic number.
    const probe = new ReplayBuffer(1_000, 1_000_000);
    probe.push(update(1, "d".repeat(200)));
    const budget = new ReplayBudget(probe.bytes * 9);
    let clock = 0;
    const dormant = new ReplayBuffer(1_000, 1_000_000, budget, () => (clock += 1));
    const active = new ReplayBuffer(1_000, 1_000_000, budget, () => (clock += 1));
    for (let seq = 1; seq <= 4; seq += 1) dormant.push(update(seq, "d".repeat(200)));
    const held = dormant.size;
    for (let seq = 1; seq <= 8; seq += 1) active.push(update(seq, "a".repeat(200)));
    expect(budget.bytes).toBeLessThanOrEqual(budget.limitBytes);
    // The dormant session paid the whole bill; the streaming one paid nothing.
    expect(held).toBe(4);
    expect(dormant.size).toBeLessThan(held);
    expect(dormant.floor).toBeGreaterThan(0);
    expect(active.size).toBe(8);
    expect(active.floor).toBe(0);
  });

  it("gives up its own oldest bytes when it is the only session left", () => {
    const budget = new ReplayBudget(600);
    const only = new ReplayBuffer(1_000, 1_000_000, budget);
    for (let seq = 1; seq <= 10; seq += 1) only.push(update(seq, "z".repeat(200)));
    expect(budget.bytes).toBeLessThanOrEqual(600);
    expect(only.floor).toBeGreaterThan(0);
    expect(only.first!.seq).toBe(only.floor + 1);
  });

  it("returns a released session's bytes to the worker's allowance", () => {
    const budget = new ReplayBudget(10_000);
    const buffer = new ReplayBuffer(1_000, 1_000_000, budget);
    buffer.push(update(1, "y".repeat(500)));
    expect(budget.bytes).toBeGreaterThan(0);
    buffer.dispose();
    expect(budget.bytes).toBe(0);
  });
});

// --------------------------------------------------------------- integration

const CWD = "/tmp/replay";

class StreamDriver implements SessionDriver {
  readonly kind = "stable-sdk" as const;
  private readonly listeners = new Set<DriverListener>();
  private st: SessionState;
  constructor(path: string) {
    this.st = {
      path, id: path, cwd: CWD, model: null, thinkingLevel: "medium",
      isStreaming: false, isCompacting: false, steeringMode: "one-at-a-time", followUpMode: "one-at-a-time",
      autoCompactionEnabled: true, messageCount: 1, pendingMessageCount: 0,
    };
  }
  async open(options: { sessionPath?: string }) {
    if (options.sessionPath) this.st = { ...this.st, path: options.sessionPath, id: options.sessionPath };
    return this.st;
  }
  state() { return this.st; }
  subscribe(listener: DriverListener) { this.listeners.add(listener); return () => this.listeners.delete(listener); }
  emit(event: DriverEvent) { for (const listener of this.listeners) listener(event); }
  stream(text: string) { this.emit({ type: "update", update: { kind: "text_delta", delta: text, contentIndex: 0 } }); }
  async prompt() { return { accepted: true, queued: false }; }
  async steer() {}
  async followUp() {}
  async clearQueue() { return { steering: [], followUp: [] }; }
  async abort() {}
  async listModels(): Promise<ModelRef[]> { return []; }
  async setModel() { return this.st; }
  async setThinkingLevel() { return this.st; }
  async rename() {}
  async compact() {}
  async navigateTree() { return { cancelled: false }; }
  async fork() { return { state: this.st }; }
  respondToUi() {}
  async commands() { return []; }
  async prompts() { return []; }
  async entries() { return { entries: [], leafId: null }; }
  sessionHeader() { return { id: this.st.id, cwd: CWD }; }
  async dispose() { this.emit({ type: "closed", reason: "disposed" }); }
}

describe("a worker under replay pressure", () => {
  it("stays inside its ceiling with several sessions streaming, and tells the client to resync", async () => {
    const out: JsonRpcMessage[] = [];
    const drivers = new Map<string, StreamDriver>();
    const server = new WorkerServer({
      cwd: CWD,
      createDriver: () => new StreamDriver("pending") as unknown as SessionDriver,
      send: (message) => out.push(message),
      replayBuffer: 10_000,
      replayBytes: 1024 * 1024,
      replayBudgetBytes: 8_000,
    });
    let id = 0;
    const call = async <T>(method: string, params: unknown): Promise<T> => {
      const current = ++id;
      await server.handle({ jsonrpc: "2.0", id: current, method, params });
      return (out.find((message) => "id" in message && message.id === current) as { result: T }).result;
    };
    const paths = ["/tmp/replay/a.jsonl", "/tmp/replay/b.jsonl", "/tmp/replay/c.jsonl"];
    for (const path of paths) {
      const driver = new StreamDriver(path);
      drivers.set(path, driver);
      (server as unknown as { options: { createDriver: () => SessionDriver } }).options.createDriver = () => driver as unknown as SessionDriver;
      await call<ClientRequests["session/load"]["result"]>("session/load", { path });
    }

    // Every session streams at once: nothing here is idle, so the ceiling
    // cannot be honoured by waiting for someone to stop.
    for (let round = 0; round < 40; round += 1) {
      for (const path of paths) drivers.get(path)!.stream("chunk ".repeat(40));
      expect(server.replayStats().bytes).toBeLessThanOrEqual(8_000);
    }
    const stats = server.replayStats();
    expect(stats.sessions).toBe(3);
    expect(stats.evictions).toBeGreaterThan(0);
    expect(stats.floorAdvances).toBe(stats.evictions);

    // A client that was following the session with the oldest suffix is told
    // the earliest seq that can still be replayed, which is later than the one
    // it held: that inequality is the resync signal.
    const reload = await call<ClientRequests["session/load"]["result"]>("session/load", { path: paths[0]!, fromSeq: 1 });
    expect(reload.replayFrom).toBeGreaterThan(1);
    expect(reload.replayFrom).toBeLessThanOrEqual(reload.seq);

    // Canonical state is untouched by any of it: the session is still served.
    expect(server.openSessions().sort()).toEqual([...paths].sort());

    // And the newest updates — the ones that say a turn ended — are the ones
    // eviction keeps: a client that is only a little behind still receives the
    // terminal event rather than having to re-read the transcript for it.
    const before = out.length;
    drivers.get(paths[0]!)!.emit({ type: "update", update: { kind: "agent_settled" } });
    const settled = out.slice(before).find((message) => "method" in message && message.method === "session/update") as
      | { params: { seq: number; update: { kind: string } } }
      | undefined;
    expect(settled?.params.update.kind).toBe("agent_settled");
    const tail = await call<ClientRequests["session/load"]["result"]>("session/load", { path: paths[0]!, fromSeq: settled!.params.seq - 1 });
    expect(tail.replayFrom).toBe(settled!.params.seq - 1);
    const replayed = out.filter((message) => "method" in message && message.method === "session/update")
      .map((message) => (message as { params: { seq: number; update: { kind: string } } }).params)
      .filter((params) => params.seq === settled!.params.seq && params.update.kind === "agent_settled");
    expect(replayed.length).toBeGreaterThanOrEqual(2);
  });
});
