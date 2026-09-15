/**
 * RP-4 · releasing an idle session's runtime, and refusing to release one that
 * is holding anything.
 *
 * The rule under test everywhere here: an unload is a refusal or a release,
 * never a cancellation. Every pinned case asserts that the driver is still
 * alive and that what pinned it — a turn, a question, an approval, a tray
 * message, a running command, a request in flight — is untouched afterwards.
 */
import { describe, expect, it } from "vitest";
import { SESSION_SAFETY_MAX } from "@lasercode/protocol";
import type { ClientRequests, ContentBlock, JsonRpcMessage, ModelRef, SessionState, SessionUpdateParams, UiDialogRequest } from "@lasercode/protocol";
import { WorkerServer } from "../src/server.js";
import type { DriverEvent, DriverListener, SessionDriver } from "../src/driver.js";

const PATH = "/tmp/unload/s1.jsonl";

class FakeDriver implements SessionDriver {
  readonly kind = "stable-sdk" as const;
  disposed = false;
  aborts = 0;
  pending: UiDialogRequest[] = [];
  history: { entries: unknown[]; leafId: string | null } = { entries: [], leafId: null };
  /** Resolves `entries()` only when a test lets it, so a read can be in flight. */
  entriesGate: Promise<void> | undefined;
  /** Holds `open()` so a load is genuinely in flight while something else looks. */
  openGate: Promise<void> | undefined;
  /** Holds `dispose()` open, so a load can arrive while a release is running. */
  disposeGate: Promise<void> | undefined;
  disposing: (() => void) | undefined;
  private readonly listeners = new Set<DriverListener>();
  private st: SessionState = {
    path: PATH,
    id: "s1",
    cwd: "/tmp/unload",
    model: null,
    thinkingLevel: "medium",
    isStreaming: false,
    isCompacting: false,
    steeringMode: "one-at-a-time",
    followUpMode: "one-at-a-time",
    autoCompactionEnabled: true,
    messageCount: 2,
    pendingMessageCount: 0,
  };

  async open(options: { sessionPath?: string }) {
    if (this.openGate) await this.openGate;
    if (options.sessionPath) this.st = { ...this.st, path: options.sessionPath };
    return this.st;
  }
  state() { return this.st; }
  patch(next: Partial<SessionState>) { this.st = { ...this.st, ...next }; }
  subscribe(listener: DriverListener) { this.listeners.add(listener); return () => this.listeners.delete(listener); }
  emit(event: DriverEvent) { for (const listener of this.listeners) listener(event); }
  async prompt() { return { accepted: true, queued: false }; }
  async steer() {}
  async followUp() {}
  async clearQueue() { return { steering: [], followUp: [] }; }
  async abort() { this.aborts += 1; }
  async listModels(): Promise<ModelRef[]> { return []; }
  async setModel() { return this.st; }
  async setThinkingLevel() { return this.st; }
  async rename() {}
  async compact() {}
  async navigateTree() { return { cancelled: false }; }
  async fork() { return { state: this.st }; }
  respondToUi() {}
  pendingUi() { return this.pending; }
  async commands() { return []; }
  async prompts() { return []; }
  async entries() {
    if (this.entriesGate) await this.entriesGate;
    return { ...this.history };
  }
  sessionHeader() { return { id: this.st.id, cwd: this.st.cwd }; }
  async dispose() {
    this.disposing?.();
    if (this.disposeGate) await this.disposeGate;
    this.disposed = true;
    this.emit({ type: "closed", reason: "disposed" });
  }
}

function world() {
  const out: JsonRpcMessage[] = [];
  const drivers: FakeDriver[] = [];
  let pendingOpenGate: Promise<void> | undefined;
  const server = new WorkerServer({
    cwd: "/tmp/unload",
    createDriver: () => {
      const driver = new FakeDriver();
      if (pendingOpenGate) {
        driver.openGate = pendingOpenGate;
        pendingOpenGate = undefined;
      }
      drivers.push(driver);
      return driver;
    },
    send: (message) => out.push(message),
    replayBuffer: 50,
  });
  let id = 0;
  const call = async <T = unknown>(method: string, params?: unknown): Promise<{ result?: T; error?: { code: number; message: string } }> => {
    const current = ++id;
    await server.handle({ jsonrpc: "2.0", id: current, method, params });
    return out.find((message) => "id" in message && message.id === current) as { result?: T; error?: { code: number; message: string } };
  };
  const send = (method: string, params?: unknown) => {
    const current = ++id;
    const answered = server.handle({ jsonrpc: "2.0", id: current, method, params });
    return { answered, reply: () => out.find((message) => "id" in message && message.id === current) as { result?: unknown } | undefined };
  };
  const load = async (fromSeq?: number) =>
    (await call<ClientRequests["session/load"]["result"]>("session/load", { path: PATH, ...(fromSeq !== undefined ? { fromSeq } : {}) })).result!;
  const unload = async () => (await call<ClientRequests["pi/session/unload"]["result"]>("pi/session/unload", { path: PATH, reason: "idle" })).result!;
  const safety = async () => (await call<ClientRequests["pi/worker/safety"]["result"]>("pi/worker/safety", {})).result!;
  const updates = () => out.filter((m) => "method" in m && m.method === "session/update") as Array<{ params: SessionUpdateParams }>;
  return {
    server, out, drivers, call, send, load, unload, safety, updates,
    /** The next driver this worker builds holds its `open()` on this gate. */
    nextOpenGate: (gate: Promise<void>) => { pendingOpenGate = gate; },
  };
}

const text = (value: string): ContentBlock[] => [{ type: "text", text: value }];

describe("pi/session/unload", () => {
  it("releases an idle session and forgets it, without aborting anything", async () => {
    const w = world();
    await w.load();
    expect(w.server.openSessions()).toEqual([PATH]);
    expect((await w.safety()).sessions).toEqual([{ path: PATH, pins: [] }]);

    expect(await w.unload()).toEqual({ unloaded: true, pins: [] });
    expect(w.server.openSessions()).toEqual([]);
    expect(w.drivers[0]!.disposed).toBe(true);
    // A release is not a cancellation: nothing was aborted on the way out.
    expect(w.drivers[0]!.aborts).toBe(0);
    expect((await w.safety()).sessions).toEqual([]);
  });

  it("is idempotent: a session this worker does not hold is not an error", async () => {
    const w = world();
    expect(await w.unload()).toEqual({ unloaded: false, pins: [] });
    await w.load();
    await w.unload();
    expect(await w.unload()).toEqual({ unloaded: false, pins: [] });
    expect(w.drivers).toHaveLength(1);
  });

  it("refuses a streaming turn and a compaction, and leaves them running", async () => {
    const w = world();
    await w.load();
    w.drivers[0]!.patch({ isStreaming: true });
    expect(await w.unload()).toMatchObject({ unloaded: false, pins: [{ kind: "streaming" }] });
    w.drivers[0]!.patch({ isStreaming: false, isCompacting: true });
    expect(await w.unload()).toMatchObject({ unloaded: false, pins: [{ kind: "compacting" }] });
    expect(w.drivers[0]!.disposed).toBe(false);
    expect(w.server.openSessions()).toEqual([PATH]);
  });

  it("refuses an unanswered question and an unanswered approval, and keeps them answerable", async () => {
    const w = world();
    await w.load();
    w.drivers[0]!.pending = [{ id: "d1", kind: "confirm", message: "Proceed?" } as UiDialogRequest];
    expect(await w.unload()).toMatchObject({ unloaded: false, pins: [{ kind: "question" }] });
    w.drivers[0]!.pending = [{ id: "d2", kind: "confirm", message: "Run it?", toolCallId: "call-1" } as UiDialogRequest];
    expect(await w.unload()).toMatchObject({ unloaded: false, pins: [{ kind: "approval" }] });
    expect(w.drivers[0]!.pending).toHaveLength(1);
    expect(w.drivers[0]!.disposed).toBe(false);
  });

  it("refuses queued engine work and a message waiting in the person's tray", async () => {
    const w = world();
    await w.load();
    w.drivers[0]!.patch({ pendingMessageCount: 1 });
    expect(await w.unload()).toMatchObject({ unloaded: false, pins: [{ kind: "queued_work" }] });
    w.drivers[0]!.patch({ pendingMessageCount: 0 });

    await w.call("session/pending/add", { path: PATH, content: text("do this next") });
    const refused = await w.unload();
    expect(refused).toMatchObject({ unloaded: false, pins: [{ kind: "pending_tray" }] });
    // The tray is memory only, so the refusal is what keeps the message.
    const tray = (await w.call<{ messages: unknown[] }>("session/pending/list", { path: PATH })).result!;
    expect(tray.messages).toHaveLength(1);
  });

  it("refuses while a command of the session is running, and releases once it ends", async () => {
    const w = world();
    await w.load();
    const task = {
      id: "task-1",
      command: "pnpm build",
      title: "pnpm build",
      status: "running" as const,
      origin: "background" as const,
      startedAt: new Date().toISOString(),
      outputBytes: 0,
    };
    w.drivers[0]!.emit({ type: "extension", message: { type: "lasercode/task/update", task } });
    expect(await w.unload()).toMatchObject({ unloaded: false, pins: [{ kind: "task" }] });

    w.drivers[0]!.emit({
      type: "extension",
      message: { type: "lasercode/task/update", task: { ...task, status: "exited", exitCode: 0, endedAt: new Date().toISOString() } },
    });
    expect(await w.unload()).toEqual({ unloaded: true, pins: [] });
  });

  it("refuses while a request naming the session is still being served", async () => {
    const w = world();
    await w.load();
    let release = () => {};
    w.drivers[0]!.entriesGate = new Promise<void>((resolve) => { release = resolve; });
    const reading = w.send("pi/session/entries", { path: PATH });
    // The read is in flight; the release must not pull the runtime from under it.
    const refused = await w.unload();
    expect(refused).toMatchObject({ unloaded: false, pins: [{ kind: "in_flight_request" }] });
    release();
    await reading.answered;
    expect(reading.reply()).toHaveProperty("result");
    expect(await w.unload()).toEqual({ unloaded: true, pins: [] });
  });

  it("reopens the same conversation, with a fresh epoch that forces a resync", async () => {
    const w = world();
    const first = await w.load();
    w.drivers[0]!.history = { entries: [{ id: "e1" }, { id: "e2" }], leafId: "e2" };
    // Something happened, so the client holds a watermark from this generation.
    w.drivers[0]!.emit({ type: "update", update: { kind: "text_delta", delta: "hi", contentIndex: 0 } });
    const beforeSeq = w.updates().at(-1)!.params.seq;
    const beforeEpoch = w.updates().at(-1)!.params.epoch;
    const beforeRevision = first.revision;
    expect(await w.unload()).toEqual({ unloaded: true, pins: [] });

    const reopened = await w.load(beforeSeq);
    expect(w.drivers).toHaveLength(2);
    expect(reopened.state.path).toBe(PATH);
    // The new generation numbers from zero, and the reply says so rather than
    // claiming the client missed nothing.
    expect(reopened.seq).toBe(0);
    expect(reopened.replayFrom).toBe(0);
    expect(reopened.replayFrom).not.toBe(beforeSeq);
    // The canonical record is untouched: the same durable revision comes back.
    expect(reopened.revision).toBe(beforeRevision);

    w.drivers[1]!.history = { entries: [{ id: "e1" }, { id: "e2" }], leafId: "e2" };
    const entries = (await w.call<{ entries: unknown[]; leafId: string | null }>("pi/session/entries", { path: PATH })).result!;
    expect(entries).toEqual({ entries: [{ id: "e1" }, { id: "e2" }], leafId: "e2" });
    w.drivers[1]!.emit({ type: "update", update: { kind: "text_delta", delta: "again", contentIndex: 0 } });
    expect(w.updates().at(-1)!.params.epoch).not.toBe(beforeEpoch);
  });

  it("lets a load that arrives during a release win, without disposing anything", async () => {
    const w = world();
    await w.load();
    const releasing = w.send("pi/session/unload", { path: PATH, reason: "idle" });
    const loading = w.send("session/load", { path: PATH });
    await Promise.all([releasing.answered, loading.answered]);
    // The client asking for the session is work in flight, so the release
    // refuses rather than pulling the runtime out from under it.
    expect(releasing.reply()).toMatchObject({ result: { unloaded: false, pins: [{ kind: "in_flight_request" }] } });
    expect(loading.reply()).toHaveProperty("result");
    expect(w.drivers).toHaveLength(1);
    expect(w.drivers[0]!.disposed).toBe(false);
    expect(w.server.openSessions()).toEqual([PATH]);
  });

  it("makes a load that arrives mid-release wait for it and then reopen, never on two runtimes", async () => {
    const w = world();
    await w.load();
    const driver = w.drivers[0]!;
    let finishDispose = () => {};
    driver.disposeGate = new Promise<void>((resolve) => { finishDispose = resolve; });
    const disposing = new Promise<void>((resolve) => { driver.disposing = resolve; });
    const releasing = w.send("pi/session/unload", { path: PATH, reason: "idle" });
    await disposing;

    // The release is past its checks and inside `dispose()`. A load now must
    // not be answered from the runtime that is going away.
    const loading = w.send("session/load", { path: PATH });
    await Promise.resolve();
    expect(w.drivers).toHaveLength(1);
    finishDispose();
    await Promise.all([releasing.answered, loading.answered]);

    expect(releasing.reply()).toMatchObject({ result: { unloaded: true, pins: [] } });
    expect(loading.reply()).toHaveProperty("result");
    expect(w.drivers).toHaveLength(2);
    expect(w.drivers[0]!.disposed).toBe(true);
    expect(w.drivers[1]!.disposed).toBe(false);
    expect(w.server.openSessions()).toEqual([PATH]);
  });

  it("reports what every loaded session is holding, for the pool's retirement admission", async () => {
    const w = world();
    await w.load();
    w.drivers[0]!.patch({ isStreaming: true });
    const safety = await w.safety();
    expect(safety.sessions).toHaveLength(1);
    expect(safety.sessions[0]!.path).toBe(PATH);
    expect(safety.sessions[0]!.pins.map((pin) => pin.kind)).toEqual(["streaming"]);
    // The answer says it is the whole truth, which is what lets the pool read
    // an empty pin list as "safe" rather than as "I could not tell you".
    expect(safety.complete).toBe(true);
  });

  it("says its answer is not complete when it holds more sessions than one answer carries", async () => {
    const w = world();
    const server = w.server as unknown as { sessions: Map<string, unknown> };
    await w.load();
    const only = server.sessions.get(PATH)!;
    for (let index = 0; index < SESSION_SAFETY_MAX + 3; index += 1) server.sessions.set(`/tmp/unload/extra-${index}.jsonl`, only);
    const safety = await w.safety();
    expect(safety.sessions).toHaveLength(SESSION_SAFETY_MAX);
    expect(safety.complete).toBe(false);
  });

  it("lists a session whose load has not answered yet, pinned, so nobody reads it as absent", async () => {
    const w = world();
    await w.load();
    const other = "/tmp/unload/s2.jsonl";
    let openGate = () => {};
    const gate = new Promise<void>((resolve) => { openGate = resolve; });
    // The next driver holds its `open()` so the load is genuinely in flight.
    w.nextOpenGate(gate);
    const loading = w.send("session/load", { path: other });
    await Promise.resolve();
    const safety = await w.safety();
    expect(safety.complete).toBe(true);
    const opening = safety.sessions.find((session) => session.path === other);
    expect(opening?.pins.map((pin) => pin.kind)).toEqual(["opening"]);
    openGate();
    await loading.answered;
  });

  it("reports its retained stores, and they shrink when a runtime is released", async () => {
    const w = world();
    await w.load();
    w.drivers[0]!.emit({ type: "update", update: { kind: "text_delta", delta: "hello", contentIndex: 0 } });
    const held = (await w.call<ClientRequests["pi/worker/retained-stores"]["result"]>("pi/worker/retained-stores", {})).result!;
    expect(held.stores.workerSessions).toEqual({ count: 1 });
    expect(held.stores.workerReplay!.count).toBeGreaterThan(0);
    expect(held.stores.workerReplay!.bytes).toBeGreaterThan(0);
    expect(held.stores.workerCaches).toEqual({ count: 0 });

    await w.unload();
    const released = (await w.call<ClientRequests["pi/worker/retained-stores"]["result"]>("pi/worker/retained-stores", {})).result!;
    expect(released.stores.workerSessions).toEqual({ count: 0 });
    expect(released.stores.workerReplay).toEqual({ count: 0, bytes: 0 });
  });
});
