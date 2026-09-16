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
import { SESSION_PIN_DETAIL_MAX, SESSION_SAFETY_MAX, sessionPinSchema } from "@lasercode/protocol";
import type { DriverReleaseReadiness } from "../src/driver.js";
import { ErrorCodes, LIFETIME_RETRY } from "@lasercode/protocol";
import type { AgentsSnapshot, ClientRequests, ContentBlock, JsonRpcMessage, ModelRef, SessionState, SessionUpdateParams, UiDialogRequest } from "@lasercode/protocol";
import { WorkerServer } from "../src/server.js";
import { fallbackSnapshot } from "../src/agents/definitions.js";
import type { NamerCompletion, NamerContext, NamerModelRuntime } from "../src/agents/namer.js";
import type { DriverEvent, DriverListener, SessionDriver } from "../src/driver.js";

const PATH = "/tmp/unload/s1.jsonl";

/** The agents snapshot the host sends with, and without, a model Namer may use. */
function namerSnapshot(model: { provider: string; id: string } | null): AgentsSnapshot {
  const snapshot = fallbackSnapshot();
  return { ...snapshot, namer: { ...snapshot.namer, status: model ? "ready" : "unqualified", model } };
}

/**
 * A naming model whose completion this test releases by hand, which is how a
 * real Namer completion in flight is represented without a private field: the
 * worker is driven entirely through `session/prompt` and `agents/sync`.
 */
function gatedNamer() {
  const waiting: Array<(text: string) => void> = [];
  return {
    /** What Namer was actually asked about, one entry per completion. */
    asked: [] as string[],
    getModel: (provider: string, id: string) => ({ provider, id }),
    completeSimple(_model: { provider: string; id: string }, context: NamerContext): Promise<NamerCompletion> {
      this.asked.push(context.messages.map((message) => message.content).join("\n"));
      return new Promise<NamerCompletion>((resolve) => {
        waiting.push((text) => resolve({ content: [{ type: "text", text }] }));
      });
    },
    /** Let the oldest completion still waiting return this title. */
    answerWith(text: string) {
      waiting.shift()?.(text);
    },
  };
}

/** Let the floated naming promise reach its next step (it never delays a turn). */
const settle = async () => {
  for (let step = 0; step < 4; step += 1) await new Promise<void>((resolve) => setTimeout(resolve, 0));
};

class FakeDriver implements SessionDriver {
  readonly kind = "stable-sdk" as const;
  disposed = false;
  aborts = 0;
  pending: UiDialogRequest[] = [];
  history: { entries: unknown[]; leafId: string | null } = { entries: [], leafId: null };
  /** Resolves `entries()` only when a test lets it, so a read can be in flight. */
  entriesGate: Promise<void> | undefined;
  /** What `prepareRelease()` answers; the default is a reopenable record. */
  readiness: DriverReleaseReadiness = { ok: true };
  /** Set to make `dispose()` fail; `disposeEmitsClosed` says whether it got that far. */
  disposeFailure: Error | undefined;
  disposeEmitsClosed = false;
  releases = 0;
  /** Runs while `prepareRelease()` is in flight, so a test can race the fence. */
  onPrepare: (() => void) | undefined;
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
  /** Prompts this driver was actually asked to run (RP-4c's premise). */
  promptCalls = 0;
  async prompt() { this.promptCalls += 1; return { accepted: true, queued: false }; }
  async steer() {}
  async followUp() {}
  async clearQueue() { return { steering: [], followUp: [] }; }
  async abort() { this.aborts += 1; }
  async listModels(): Promise<ModelRef[]> { return []; }
  async setModel() { return this.st; }
  async setThinkingLevel() { return this.st; }
  async rename(name: string) { this.st = { ...this.st, name }; }
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
  async prepareRelease(): Promise<DriverReleaseReadiness> {
    this.releases += 1;
    this.onPrepare?.();
    return this.readiness;
  }
  async dispose() {
    this.disposing?.();
    if (this.disposeGate) await this.disposeGate;
    if (this.disposeFailure) {
      if (this.disposeEmitsClosed) {
        this.disposed = true;
        this.emit({ type: "closed", reason: "disposed" });
      }
      throw this.disposeFailure;
    }
    this.disposed = true;
    this.emit({ type: "closed", reason: "disposed" });
  }
}

function world(options: { namer?: NamerModelRuntime } = {}) {
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
    ...(options.namer ? { namerModels: async () => options.namer! } : {}),
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

  it("refuses a prompt for a session it no longer holds, before the driver sees anything", async () => {
    // The premise the host's route lease (RP-4c) rests on: this refusal happens
    // in `live()`, ahead of the driver, the harness and the engine, so the
    // prompt was never delivered and re-establishing it later cannot be a
    // second delivery. It also carries no retry marker, which is why the
    // host's one-shot lifetime retry cannot save it.
    const w = world();
    await w.load();
    expect(await w.unload()).toEqual({ unloaded: true, pins: [] });
    expect(w.drivers[0]!.promptCalls).toBe(0);

    const refused = await w.call("session/prompt", { path: PATH, content: text("never delivered") });
    expect(refused.error?.code).toBe(ErrorCodes.SessionNotFound);
    expect(refused.error?.message).toMatch(/is not open in this worker/);
    expect((refused.error as { data?: { retry?: string } } | undefined)?.data?.retry).toBeUndefined();
    expect(w.drivers[0]!.promptCalls).toBe(0);
    expect(w.drivers).toHaveLength(1);
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

  it("releases a session whose first prompt has no naming model to name it", async () => {
    const namer = gatedNamer();
    const w = world({ namer });
    await w.load();
    // Credential-free: naming is off, so the first prompt's words are parked in
    // case a model ever appears, and nothing is asked of any model. That intent
    // cannot be performed by anyone, so it is not a refusal — an untitled
    // conversation is the smaller loss.
    expect(await w.call("session/prompt", { path: PATH, content: text("explore the repo") })).toHaveProperty("result");
    await settle();
    expect(namer.asked).toEqual([]);
    expect((await w.safety()).sessions).toEqual([{ path: PATH, pins: [] }]);

    expect(await w.unload()).toEqual({ unloaded: true, pins: [] });
    expect(w.drivers[0]!.disposed).toBe(true);
    // Still a release and not a cancellation.
    expect(w.drivers[0]!.aborts).toBe(0);
  });

  it("refuses while a parked first prompt is actually being named, and releases once the title lands", async () => {
    const namer = gatedNamer();
    const w = world({ namer });
    await w.load();
    expect(await w.call("session/prompt", { path: PATH, content: text("explore the repo") })).toHaveProperty("result");
    await settle();
    // The host qualifies Namer while the session is idle. The words it parked
    // go in as a real completion — which is also what proves they were kept.
    await w.call("agents/sync", { snapshot: namerSnapshot({ provider: "stub", id: "stub-1" }) });
    await settle();
    expect(namer.asked.join("\n")).toContain("explore the repo");

    // Now it is work this runtime is the only holder of, and it says so.
    expect((await w.safety()).sessions[0]!.pins).toEqual([{ kind: "naming", detail: "this session is being named" }]);
    expect(await w.unload()).toMatchObject({ unloaded: false, pins: [{ kind: "naming" }] });
    expect(w.drivers[0]!.disposed).toBe(false);

    // It lands on the runtime the refusal kept alive, and then nothing holds
    // the session: no record of the attempt survives it.
    namer.answerWith("Explore the repo");
    await settle();
    expect(w.drivers[0]!.state().name).toBe("Explore the repo");
    expect((await w.safety()).sessions).toEqual([{ path: PATH, pins: [] }]);
    expect(await w.unload()).toEqual({ unloaded: true, pins: [] });
  });

  it("keeps the pin when the naming model is taken away while its completion is still running", async () => {
    const namer = gatedNamer();
    const w = world({ namer });
    await w.load();
    await w.call("agents/sync", { snapshot: namerSnapshot({ provider: "stub", id: "stub-1" }) });
    expect(await w.call("session/prompt", { path: PATH, content: text("explore the repo") })).toHaveProperty("result");
    await settle();
    expect(namer.asked.join("\n")).toContain("explore the repo");
    expect((await w.safety()).sessions[0]!.pins.map((pin) => pin.kind)).toEqual(["naming"]);

    // Namer's model selection is cleared (a person switched naming off, or a
    // new snapshot arrived without one). The completion already started is
    // still running against this runtime, so the evidence of it must not be
    // erased by the setting going away.
    await w.call("agents/sync", { snapshot: namerSnapshot(null) });
    expect((await w.safety()).sessions[0]!.pins.map((pin) => pin.kind)).toEqual(["naming"]);
    expect(await w.unload()).toMatchObject({ unloaded: false, pins: [{ kind: "naming" }] });

    namer.answerWith("Explore the repo");
    await settle();
    expect((await w.safety()).sessions).toEqual([{ path: PATH, pins: [] }]);
    expect(await w.unload()).toEqual({ unloaded: true, pins: [] });
  });

  it("leaves no naming record behind when the session ends under a running completion", async () => {
    const namer = gatedNamer();
    const w = world({ namer });
    await w.load();
    await w.call("agents/sync", { snapshot: namerSnapshot({ provider: "stub", id: "stub-1" }) });
    await w.call("session/prompt", { path: PATH, content: text("explore the repo") });
    await settle();
    expect((await w.safety()).sessions[0]!.pins.map((pin) => pin.kind)).toEqual(["naming"]);

    // The engine ends the session under the completion (a crash, a close it
    // decided itself): the attempt can no longer be finished.
    w.drivers[0]!.emit({ type: "closed", reason: "disposed" });
    expect(w.server.openSessions()).toEqual([]);
    namer.answerWith("Explore the repo");
    await settle();

    // The same conversation opens again on a new runtime, and the finished
    // attempt left nothing behind that could pin it.
    await w.load();
    expect(w.drivers[1]!.state().name).toBeUndefined();
    expect((await w.safety()).sessions).toEqual([{ path: PATH, pins: [] }]);
    expect(await w.unload()).toEqual({ unloaded: true, pins: [] });
  });

  it("names a session once: a second message during the completion starts no second attempt", async () => {
    const namer = gatedNamer();
    const w = world({ namer });
    await w.load();
    await w.call("agents/sync", { snapshot: namerSnapshot({ provider: "stub", id: "stub-1" }) });
    // Two eligible messages on an idle, still unnamed session. The session is
    // named from its first prompt, so the second does not ask a model the same
    // question again — one completion, one record, whatever a person types
    // while it runs.
    await w.call("session/prompt", { path: PATH, content: text("explore the repo") });
    await w.call("session/prompt", { path: PATH, content: text("and read the build config") });
    await settle();
    expect(namer.asked).toHaveLength(1);
    expect(namer.asked[0]).toContain("explore the repo");
    expect((await w.safety()).sessions[0]!.pins).toEqual([{ kind: "naming", detail: "this session is being named" }]);
    expect(await w.unload()).toMatchObject({ unloaded: false, pins: [{ kind: "naming" }] });

    // The person names it while the completion is still running: theirs wins,
    // the attempt clears, and nothing asks again afterwards.
    await w.call("pi/session/rename", { path: PATH, name: "Mine" });
    namer.answerWith("Explore the repo");
    await settle();
    expect(w.drivers[0]!.state().name).toBe("Mine");
    expect(namer.asked).toHaveLength(1);
    expect((await w.safety()).sessions).toEqual([{ path: PATH, pins: [] }]);
    expect(await w.unload()).toEqual({ unloaded: true, pins: [] });
  });

  it("keeps refusing a session with a parked first prompt while any real guard holds it", async () => {
    const namer = gatedNamer();
    const w = world({ namer });
    await w.load();
    expect(await w.call("session/prompt", { path: PATH, content: text("explore the repo") })).toHaveProperty("result");
    await settle();
    expect(namer.asked).toEqual([]);
    // Naming is not a pin for a prompt nothing can name, and that weakens none
    // of the guards exercised here: a turn, a compaction, queued engine work, a
    // question, an approval, a tray message and a record that cannot be proved
    // reopenable each still hold this session on their own.
    w.drivers[0]!.patch({ isStreaming: true });
    expect((await w.unload()).pins.map((pin) => pin.kind)).toEqual(["streaming"]);
    w.drivers[0]!.patch({ isStreaming: false, isCompacting: true });
    expect((await w.unload()).pins.map((pin) => pin.kind)).toEqual(["compacting"]);
    w.drivers[0]!.patch({ isCompacting: false, pendingMessageCount: 2 });
    expect((await w.unload()).pins.map((pin) => pin.kind)).toEqual(["queued_work"]);
    w.drivers[0]!.patch({ pendingMessageCount: 0 });
    w.drivers[0]!.pending = [{ id: "d1", kind: "confirm", message: "Proceed?" } as UiDialogRequest];
    expect((await w.unload()).pins.map((pin) => pin.kind)).toEqual(["question"]);
    w.drivers[0]!.pending = [{ id: "d2", kind: "confirm", message: "Run it?", toolCallId: "call-1" } as UiDialogRequest];
    expect((await w.unload()).pins.map((pin) => pin.kind)).toEqual(["approval"]);
    w.drivers[0]!.pending = [];
    await w.call("session/pending/add", { path: PATH, content: text("do this next") });
    expect((await w.unload()).pins.map((pin) => pin.kind)).toEqual(["pending_tray"]);
    await w.call("session/pending/clear", { path: PATH });
    w.drivers[0]!.readiness = { ok: false, refusal: "no_record" };
    expect((await w.unload()).pins.map((pin) => pin.kind)).toEqual(["no_record"]);
    expect(w.drivers[0]!.disposed).toBe(false);
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

  it("refuses a release because somebody asked for the conversation, and the refused request works on retry", async () => {
    const w = world();
    await w.load();
    const driver = w.drivers[0]!;
    // The request arrives exactly while the release is proving reopenability,
    // which is inside the fence and after the first pin check.
    let racing: ReturnType<typeof w.send> | undefined;
    driver.onPrepare = () => { racing = w.send("session/prompt", { path: PATH, content: text("are you there") }); };
    const refused = await w.unload();
    expect(refused).toMatchObject({ unloaded: false, pins: [{ kind: "in_flight_request" }] });
    expect(driver.disposed).toBe(false);

    // The racing request was refused before it ran, and said so retryably.
    await racing!.answered;
    const reply = racing!.reply() as { error?: { code: number; data?: { retry?: string } } };
    expect(reply.error?.code).toBe(ErrorCodes.SessionBusy);
    expect(reply.error?.data?.retry).toBe(LIFETIME_RETRY);

    // And the retry lands on the runtime the refusal kept alive.
    driver.onPrepare = undefined;
    const retried = await w.call("session/prompt", { path: PATH, content: text("are you there") });
    expect(retried).toHaveProperty("result");
  });

  it("refuses a load that arrives mid-release and serves it from the runtime that stayed", async () => {
    const w = world();
    await w.load();
    const driver = w.drivers[0]!;
    let racing: ReturnType<typeof w.send> | undefined;
    driver.onPrepare = () => { racing = w.send("session/load", { path: PATH }); };
    expect(await w.unload()).toMatchObject({ unloaded: false, pins: [{ kind: "in_flight_request" }] });
    await racing!.answered;
    expect((racing!.reply() as { error?: { code: number } }).error?.code).toBe(ErrorCodes.SessionBusy);
    expect(w.drivers).toHaveLength(1);
    expect(w.drivers[0]!.disposed).toBe(false);
    expect(w.server.openSessions()).toEqual([PATH]);
    // The retry is an ordinary load of the still-live session.
    driver.onPrepare = undefined;
    const reloaded = await w.load();
    expect(reloaded.state.path).toBe(PATH);
    expect(w.drivers).toHaveLength(1);
  });

  it("refuses when the conversation cannot be reopened from its record, and keeps serving it", async () => {
    const w = world();
    await w.load();
    const driver = w.drivers[0]!;
    for (const refusal of ["no_record", "identity_mismatch", "unreadable"] as const) {
      driver.readiness = { ok: false, refusal, detail: `record ${refusal}` };
      const answer = await w.unload();
      expect(answer.unloaded, refusal).toBe(false);
      expect(answer.pins.map((pin) => pin.kind), refusal).toEqual(["no_record"]);
      expect(driver.disposed, refusal).toBe(false);
      expect(w.server.openSessions()).toEqual([PATH]);
    }
    driver.readiness = { ok: false, refusal: "flush_failed", detail: "disk full" };
    const flush = await w.unload();
    expect(flush.pins.map((pin) => pin.kind)).toEqual(["close_failed"]);
    expect(driver.disposed).toBe(false);

    driver.readiness = { ok: true };
    expect(await w.unload()).toEqual({ unloaded: true, pins: [] });
  });

  it("refuses a driver that cannot prove reopenability at all", async () => {
    const w = world();
    await w.load();
    // A driver that does not implement the verb at all (the stub driver, an
    // alternate runtime): the class method is removed from this instance.
    Object.defineProperty(w.drivers[0]!, "prepareRelease", { value: undefined, configurable: true });
    const answer = await w.unload();
    expect(answer).toMatchObject({ unloaded: false, pins: [{ kind: "no_record" }] });
    expect(w.drivers[0]!.disposed).toBe(false);
  });

  it("keeps serving a runtime that would not close, with its replay intact, and refuses every later release", async () => {
    const w = world();
    await w.load();
    const driver = w.drivers[0]!;
    driver.emit({ type: "update", update: { kind: "text_delta", delta: "before", contentIndex: 0 } });
    const heldBytes = w.server.replayStats().bytes;
    expect(heldBytes).toBeGreaterThan(0);

    driver.disposeFailure = new Error("the engine would not shut down");
    const failed = await w.unload();
    expect(failed).toMatchObject({ unloaded: false, pins: [{ kind: "close_failed" }] });
    expect(w.server.openSessions()).toEqual([PATH]);

    // The conversation is still being served, so everything it needs to answer
    // a reconnect is still here: the replay suffix was not released on the way
    // to a close that never happened, and its bytes are still accounted for.
    expect(w.server.replayStats().bytes).toBeGreaterThanOrEqual(heldBytes);
    driver.emit({ type: "update", update: { kind: "text_delta", delta: "after", contentIndex: 0 } });
    const seq = w.updates().at(-1)!.params.seq;
    expect(w.server.replayStats().bytes).toBeGreaterThan(heldBytes);
    const before = w.updates().length;
    const reloaded = await w.load(seq - 2);
    expect(reloaded.replayFrom).toBe(seq - 2);
    expect(w.updates().length).toBeGreaterThan(before);

    // Remembered: a later attempt, and the whole worker's retirement, refuse too.
    expect((await w.unload()).pins.map((pin) => pin.kind)).toEqual(["close_failed"]);
    expect((await w.safety()).sessions[0]!.pins.map((pin) => pin.kind)).toEqual(["close_failed"]);
  });

  it("never lets an engine's words out of this process", async () => {
    const CANARY = "/private/canary/session.jsonl";
    const SECRET = `sk-${"9".repeat(400)}`;
    const w = world();
    await w.load();
    const driver = w.drivers[0]!;

    // Both boundaries a failure can cross: a readiness refusal and a close that
    // threw. Neither may carry what the engine or the filesystem said.
    driver.readiness = { ok: false, refusal: "unreadable" };
    const refused = await w.unload();
    driver.readiness = { ok: true };
    driver.disposeFailure = new Error(`could not close ${CANARY}: ${SECRET}`);
    const closeFailed = await w.unload();
    const safety = await w.safety();
    const stores = (await w.call<ClientRequests["pi/worker/retained-stores"]["result"]>("pi/worker/retained-stores", {})).result!;

    const everything = JSON.stringify({ refused, closeFailed, safety, stores, out: w.out });
    expect(everything).not.toContain(CANARY);
    expect(everything).not.toContain(SECRET);
    for (const pin of [...refused.pins, ...closeFailed.pins, ...safety.sessions.flatMap((session) => session.pins)]) {
      expect(pin.detail === undefined || pin.detail.length <= SESSION_PIN_DETAIL_MAX).toBe(true);
      // And every one of them is a shape the wire accepts.
      expect(sessionPinSchema.safeParse(pin).success).toBe(true);
    }
  });

  it("reports an honest release when the runtime did go, even though dispose threw afterwards", async () => {
    const w = world();
    await w.load();
    const driver = w.drivers[0]!;
    driver.disposeFailure = new Error("late cleanup failed");
    driver.disposeEmitsClosed = true;
    expect(await w.unload()).toEqual({ unloaded: true, pins: [] });
    expect(w.server.openSessions()).toEqual([]);
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
    const runtimes = (w.server as unknown as { runtimes: { get(path: string): unknown; attach(live: unknown): void } }).runtimes;
    await w.load();
    const only = runtimes.get(PATH) as { path: string };
    for (let index = 0; index < SESSION_SAFETY_MAX + 3; index += 1) {
      runtimes.attach({ ...only, path: `/tmp/unload/extra-${index}.jsonl` });
    }
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
