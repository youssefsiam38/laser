/**
 * WorkerServer (M0-T6) with a fake driver: dispatch, seq numbering, replay on
 * load, dialog notifications, and error mapping. The real driver is covered
 * by stable-sdk.*.test.ts.
 */
import { describe, expect, it } from "vitest";
import type { JsonRpcMessage, SessionState, UiDialogRequest } from "@piorbit/protocol";
import { WorkerServer } from "../src/server.js";
import type { DriverEvent, DriverListener, SessionDriver } from "../src/driver.js";

class FakeDriver implements SessionDriver {
  readonly kind = "stable-sdk" as const;
  listeners = new Set<DriverListener>();
  opened: unknown;
  pending: UiDialogRequest[] = [];
  answered: unknown[] = [];
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
  async open(o: unknown) {
    this.opened = o;
    const path = (o as { sessionPath?: string }).sessionPath;
    if (path) this.st = { ...this.st, path };
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
  async fork(entryId: string) { this.st = { ...this.st, path: `/tmp/fake/fork-${entryId}.jsonl` }; return this.st; }
  respondToUi(r: unknown) { this.answered.push(r); }
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

  it("forwards ui and extension events, routes ui responses to drivers", async () => {
    const h = harness();
    await h.call(1, "session/new", { cwd: "/tmp/fake" });
    const d = h.drivers[0]!;
    d.emit({ type: "ui_request", request: { method: "confirm", id: "ui-1", title: "Sure?" } });
    d.emit({ type: "ui_event", event: { method: "notify", message: "m", level: "info" } });
    d.emit({ type: "extension", message: { type: "piorbit/capabilities", active: ["provider-log"], failed: [] } });
    expect(h.notifications("pi/ui/request")[0]!.params).toMatchObject({ id: "ui-1", method: "confirm" });
    expect(h.notifications("pi/ui/event")[0]!.params).toMatchObject({ method: "notify" });
    expect(h.notifications("pi/extension/message")[0]!.params).toMatchObject({ message: { type: "piorbit/capabilities" } });

    await h.call(2, "pi/ui/response", { id: "ui-1", confirmed: true });
    expect(d.answered).toEqual([{ id: "ui-1", confirmed: true }]);
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
    expect(forked.result).toMatchObject({ state: { path: "/tmp/fake/fork-e9.jsonl" } });
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
