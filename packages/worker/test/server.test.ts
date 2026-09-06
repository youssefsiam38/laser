/**
 * WorkerServer (M0-T6) with a fake driver: dispatch, seq numbering, replay on
 * load, dialog notifications, and error mapping. The real driver is covered
 * by stable-sdk.*.test.ts.
 */
import { describe, expect, it } from "vitest";
import type { JsonRpcMessage, SessionState, UiDialogRequest } from "@lasercode/protocol";
import { WorkerServer } from "../src/server.js";
import type { DriverEvent, DriverListener, SessionDriver } from "../src/driver.js";

class FakeDriver implements SessionDriver {
  readonly kind = "stable-sdk" as const;
  listeners = new Set<DriverListener>();
  opened: unknown;
  pending: UiDialogRequest[] = [];
  answered: unknown[] = [];
  extensionCommands: unknown[] = [];
  private st: SessionState = {
    path: "/tmp/fake/s1.jsonl",
    id: "s1",
    cwd: "/tmp/fake",
    model: null,
    thinkingLevel: "medium",
    isStreaming: false,
    isCompacting: false,
    steeringMode: "one-at-a-time",
    followUpMode: "one-at-a-time",
    autoCompactionEnabled: true,
    messageCount: 0,
    pendingMessageCount: 0,
  };
  /** Set to make `open()` yield, so a second request can arrive mid-open. */
  static gate: Promise<void> | undefined;
  /** Event emitted during open, before the JSON-RPC response exists. */
  static openingEvent: DriverEvent | undefined;
  async open(o: unknown) {
    if (FakeDriver.gate) await FakeDriver.gate;
    this.opened = o;
    const path = (o as { sessionPath?: string }).sessionPath;
    if (path) this.st = { ...this.st, path };
    if (FakeDriver.openingEvent) this.emit(FakeDriver.openingEvent);
    return this.st;
  }
  state() { return this.st; }
  subscribe(l: DriverListener) { this.listeners.add(l); return () => this.listeners.delete(l); }
  emit(e: DriverEvent) { for (const l of this.listeners) l(e); }
  async prompt() {
    this.emit({ type: "update", update: { kind: "agent_start" } });
    this.emit({ type: "update", update: { kind: "text_delta", delta: "hi", contentIndex: 0 } });
    this.emit({ type: "update", update: { kind: "agent_settled" } });
    return { accepted: true, queued: false };
  }
  async steer() {} async followUp() {}
  async clearQueue() { return { steering: [], followUp: [] }; }
  async abort() {}
  async listModels() { return [{ provider: "p", id: "m" }]; }
  async setModel() { return this.st; }
  async setThinkingLevel(level: SessionState["thinkingLevel"]) { this.st = { ...this.st, thinkingLevel: level }; return this.st; }
  async rename() {} async compact() {}
  async navigateTree() { return { cancelled: false }; }
  async fork(entryId: string) { this.st = { ...this.st, path: `/tmp/fake/fork-${entryId}.jsonl` }; return { state: this.st, editorText: "redo" }; }
  respondToUi(r: unknown) { this.answered.push(r); }
  deliverExtensionCommand(command: unknown) { this.extensionCommands.push(command); return true; }
  pendingUi() { return this.pending; }
  async entries() { return []; }
  async dispose() { this.emit({ type: "closed", reason: "disposed" }); }
}

function harness() {
  const out: JsonRpcMessage[] = [];
  const drivers: FakeDriver[] = [];
  const server = new WorkerServer({
    cwd: "/tmp/fake",
    createDriver: () => { const d = new FakeDriver(); drivers.push(d); return d; },
    send: (m) => out.push(m),
    replayBuffer: 3,
  });
  const call = async (id: number, method: string, params?: unknown) => {
    await server.handle({ jsonrpc: "2.0", id, method, params });
    return out.find((m) => "id" in m && m.id === id) as { result?: unknown; error?: { code: number } };
  };
  const notifications = (method: string) => out.filter((m) => "method" in m && !("id" in m) && m.method === method) as Array<{ params: never }>;
  return { server, out, drivers, call, notifications };
}

describe("WorkerServer", () => {
  it("includes startup capabilities in the session snapshot", async () => {
    FakeDriver.openingEvent = {
      type: "extension",
      message: { type: "lasercode/capabilities", active: ["provider-log", "transcribe"], failed: [] },
    };
    try {
      const h = harness();
      const created = await h.call(1, "session/new", { cwd: "/tmp/fake" });
      expect(created.result).toMatchObject({
        state: { capabilities: ["provider-log", "transcribe"] },
      });
    } finally {
      FakeDriver.openingEvent = undefined;
    }
  });

  it("opens a session, numbers updates, and answers requests", async () => {
    const h = harness();
    const created = await h.call(1, "session/new", { cwd: "/tmp/fake" });
    expect(created.result).toMatchObject({ state: { path: "/tmp/fake/s1.jsonl" } });
    expect(h.server.openSessions()).toEqual(["/tmp/fake/s1.jsonl"]);

    const prompted = await h.call(2, "session/prompt", { path: "/tmp/fake/s1.jsonl", content: [{ type: "text", text: "x" }] });
    expect(prompted.result).toEqual({ accepted: true, queued: false });

    const updates = h.notifications("session/update").map((n) => n.params as { seq: number; update: { kind: string } });
    expect(updates.map((u) => u.seq)).toEqual([1, 2, 3]);
    expect(updates.map((u) => u.update.kind)).toEqual(["agent_start", "text_delta", "agent_settled"]);

    const models = await h.call(3, "pi/model/list", { path: "/tmp/fake/s1.jsonl" });
    expect(models.result).toEqual({ models: [{ provider: "p", id: "m" }] });
    const thinking = await h.call(4, "pi/thinking/set", { path: "/tmp/fake/s1.jsonl", level: "high" });
    expect(thinking.result).toMatchObject({ state: { thinkingLevel: "high" } });
    const refreshed = await h.call(5, "pi/account-usage/refresh", { path: "/tmp/fake/s1.jsonl" });
    expect(refreshed.result).toEqual({ delivered: true });
    expect(h.drivers[0]?.extensionCommands).toContainEqual({ type: "lasercode/account-usage/refresh" });
  });

  it("replays buffered updates after fromSeq and re-emits pending dialogs on load", async () => {
    const h = harness();
    await h.call(1, "session/new", { cwd: "/tmp/fake" });
    const d = h.drivers[0]!;
    for (let i = 0; i < 5; i++) d.emit({ type: "update", update: { kind: "turn_start" } });
    h.out.length = 0; // simulate a client that reconnects having seen up to seq 3

    d.pending = [{ method: "select", id: "ui-9", title: "Pick", options: ["a"] }];
    const loaded = await h.call(2, "session/load", { path: "/tmp/fake/s1.jsonl", fromSeq: 3 });
    expect(loaded.result).toMatchObject({ replayFrom: 3 });

    // Buffer is capped at 3, so seqs 3..5 are retained; only 4 and 5 are after fromSeq.
    const replayed = h.notifications("session/update").map((n) => (n.params as { seq: number }).seq);
    expect(replayed).toEqual([4, 5]);
    const dialogs = h.notifications("pi/ui/request");
    expect(dialogs).toHaveLength(1);
    expect(dialogs[0]!.params).toMatchObject({ path: "/tmp/fake/s1.jsonl", id: "ui-9", method: "select" });
    expect(h.drivers).toHaveLength(1); // attached, not reopened
  });

  it("opens one driver for concurrent loads of the same session file", async () => {
    // Two writers on one Pi session file is AGENTS.md invariant 8. A desktop
    // and a phone, or the pool's crash recovery racing a client's reconnect,
    // both produce exactly this.
    const h = harness();
    let release!: () => void;
    FakeDriver.gate = new Promise<void>((resolve) => (release = resolve));
    try {
      const first = h.call(1, "session/load", { path: "/tmp/fake/s2.jsonl" });
      const second = h.call(2, "session/load", { path: "/tmp/fake/s2.jsonl" });
      release();
      const [a, b] = await Promise.all([first, second]);
      expect(a.result).toMatchObject({ state: { path: "/tmp/fake/s2.jsonl" } });
      expect(b.result).toMatchObject({ state: { path: "/tmp/fake/s2.jsonl" } });
      expect(h.drivers).toHaveLength(1);
      expect(h.server.openSessions()).toEqual(["/tmp/fake/s2.jsonl"]);
    } finally {
      FakeDriver.gate = undefined;
    }
  });

  it("reports the replay floor it can actually honour, not the seq that was asked for", async () => {
    const h = harness(); // replayBuffer: 3
    await h.call(1, "session/new", { cwd: "/tmp/fake" });
    const d = h.drivers[0]!;
    for (let i = 0; i < 10; i++) d.emit({ type: "update", update: { kind: "turn_start" } });

    // The buffer now starts at seq 8, so a client at seq 2 has a hole. Saying
    // "replayFrom: 2" would tell it that it missed nothing.
    const loaded = await h.call(2, "session/load", { path: "/tmp/fake/s1.jsonl", fromSeq: 2 });
    expect(loaded.result).toMatchObject({ replayFrom: 7 });

    const reachable = await h.call(3, "session/load", { path: "/tmp/fake/s1.jsonl", fromSeq: 9 });
    expect(reachable.result).toMatchObject({ replayFrom: 9 });
  });

  it("reports a restarted worker's epoch even once its buffer is no longer empty", async () => {
    // What `WorkerPool.reopen` actually does after a crash: a brand-new worker
    // process re-loads the session while the client still holds the old
    // epoch's seq. The first driver event lands in the buffer before the UI
    // asks, so the empty-buffer branch is not the one that runs.
    const fresh = harness();
    await fresh.call(1, "session/new", { cwd: "/tmp/fake" });
    fresh.drivers[0]!.emit({ type: "update", update: { kind: "turn_start" } }); // seq 1

    const resumed = await fresh.call(2, "session/load", { path: "/tmp/fake/s1.jsonl", fromSeq: 9 });
    // Not 9: this process never had a seq 9, and answering 9 would make the
    // client dedupe every update it is about to receive.
    expect(resumed.result).toMatchObject({ replayFrom: 1 });
  });

  it("forwards ui and extension events, routes ui responses to drivers", async () => {
    const h = harness();
    await h.call(1, "session/new", { cwd: "/tmp/fake" });
    const d = h.drivers[0]!;
    // A real bridge reports the dialog as pending for as long as it is open;
    // the worker only delivers an answer to a driver that claims the id.
    d.pending = [{ method: "confirm", id: "ui-1", title: "Sure?" }];
    d.emit({ type: "ui_request", request: { method: "confirm", id: "ui-1", title: "Sure?" } });
    d.emit({ type: "ui_event", event: { method: "notify", message: "m", level: "info" } });
    d.emit({ type: "extension", message: { type: "lasercode/capabilities", active: ["provider-log"], failed: [] } });
    expect(h.notifications("pi/ui/request")[0]!.params).toMatchObject({ id: "ui-1", method: "confirm" });
    expect(h.notifications("pi/ui/event")[0]!.params).toMatchObject({ method: "notify" });
    expect(h.notifications("pi/extension/message")[0]!.params).toMatchObject({ message: { type: "lasercode/capabilities" } });

    const answer = await h.call(2, "pi/ui/response", { id: "ui-1", confirmed: true });
    expect(answer.result).toEqual({ delivered: true });
    expect(d.answered).toEqual([{ id: "ui-1", confirmed: true }]);

    // An id nobody is holding is reported, not silently swallowed.
    d.pending = [];
    const stale = await h.call(3, "pi/ui/response", { id: "ui-1", confirmed: true });
    expect(stale.result).toEqual({ delivered: false });
  });

  it("routes a ui response only to the session that raised the dialog", async () => {
    const h = harness();
    await h.call(1, "session/new", { cwd: "/tmp/fake" });
    await h.call(2, "session/load", { path: "/tmp/fake/s2.jsonl" });
    const [a, b] = h.drivers as [FakeDriver, FakeDriver];
    expect(h.drivers).toHaveLength(2);

    a.pending = [{ method: "confirm", id: "ui-aaaaaa-1", title: "A?" }];
    b.pending = [{ method: "confirm", id: "ui-bbbbbb-1", title: "B?" }];

    await h.call(3, "pi/ui/response", { id: "ui-bbbbbb-1", confirmed: true });
    expect(a.answered).toEqual([]);
    expect(b.answered).toEqual([{ id: "ui-bbbbbb-1", confirmed: true }]);

    // An id no session owns is dropped, not broadcast.
    await h.call(4, "pi/ui/response", { id: "ui-zzzzzz-9", confirmed: false });
    expect(a.answered).toEqual([]);
    expect(b.answered).toHaveLength(1);
  });

  it("maps protocol and dispatch failures to JSON-RPC errors", async () => {
    const h = harness();
    expect((await h.call(1, "nope/x", {})).error?.code).toBe(-32601);
    expect((await h.call(2, "session/new", { cwd: "" })).error?.code).toBe(-32602);
    expect((await h.call(3, "session/new", { cwd: "/elsewhere" })).error?.code).toBe(-32602);
    expect((await h.call(4, "session/prompt", { path: "/none", content: [{ type: "text", text: "x" }] })).error?.code).toBe(-32000);
    expect((await h.call(5, "pi/session/fork", { path: "/none", entryId: "e" })).error?.code).toBe(-32000);
    expect((await h.call(6, "session/set_mode", { path: "/none", mode: "x" })).error?.code).toBe(-32004);
    await h.server.handle("not an object");
    expect(h.out.at(-1)).toMatchObject({ error: { code: -32600 } });
  });

  it("re-keys a forked session under its new path and announces the state", async () => {
    const h = harness();
    await h.call(1, "session/new", { cwd: "/tmp/fake" });
    const forked = await h.call(2, "pi/session/fork", { path: "/tmp/fake/s1.jsonl", entryId: "e9" });
    expect(forked.result).toMatchObject({ state: { path: "/tmp/fake/fork-e9.jsonl" }, editorText: "redo" });
    expect(h.server.openSessions()).toEqual(["/tmp/fake/fork-e9.jsonl"]);
    const last = h.notifications("session/update").at(-1)!.params as { sessionPath: string; update: { kind: string } };
    expect(last).toMatchObject({ sessionPath: "/tmp/fake/fork-e9.jsonl", update: { kind: "state" } });
    // The old path no longer routes; the new one does.
    expect((await h.call(3, "pi/model/list", { path: "/tmp/fake/s1.jsonl" })).error?.code).toBe(-32000);
    expect((await h.call(4, "pi/model/list", { path: "/tmp/fake/fork-e9.jsonl" })).result).toBeDefined();
  });

  it("drops a session when its driver closes and disposes all on shutdown", async () => {
    const h = harness();
    await h.call(1, "session/new", { cwd: "/tmp/fake" });
    await h.call(2, "session/load", { path: "/tmp/other.jsonl" });
    expect(h.server.openSessions().sort()).toEqual(["/tmp/fake/s1.jsonl", "/tmp/other.jsonl"]);
    h.drivers[0]!.emit({ type: "closed", reason: "test" });
    expect(h.server.openSessions()).toEqual(["/tmp/other.jsonl"]);
    await h.server.dispose();
    expect(h.server.openSessions()).toEqual([]);
  });
});
