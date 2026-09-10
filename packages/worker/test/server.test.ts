/**
 * WorkerServer (M0-T6) with a fake driver: dispatch, seq numbering, replay on
 * load, dialog notifications, and error mapping. The real driver is covered
 * by stable-sdk.*.test.ts.
 */
import { afterEach, describe, expect, it } from "vitest";
import { mkdirSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { PRODUCT_NAME, PROJECT_DIR_NAME } from "@lasercode/protocol";
import type { JsonRpcMessage, SessionState, UiDialogRequest } from "@lasercode/protocol";
import { WorkerServer } from "../src/server.js";
import type { DriverEvent, DriverListener, FirstTurnOptions, PromptOptions, SessionDriver } from "../src/driver.js";
import { fallbackDefaultAgent, fallbackSnapshot } from "../src/agents/definitions.js";

class FakeDriver implements SessionDriver {
  readonly kind = "stable-sdk" as const;
  listeners = new Set<DriverListener>();
  opened: unknown;
  pending: UiDialogRequest[] = [];
  answered: unknown[] = [];
  extensionCommands: unknown[] = [];
  disposed = false;
  prompted: unknown[][] = [];
  prepared: FirstTurnOptions[] = [];
  rollbacks = 0;
  acceptPrompt = true;
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
  /** Where this session runs, for the settings fan-out's project-scope check. */
  setCwd(cwd: string) { this.st = { ...this.st, cwd }; }
  /** A turn in flight, as the driver reports it (`pi/session/close` refuses then). */
  setStreaming(streaming: boolean) { this.st = { ...this.st, isStreaming: streaming }; }
  /** Settings reloads asked of this driver (M13-T55). Optional on the interface, so tests can take it away. */
  reloads = 0;
  reloadSettings?: () => Promise<{ deferred: boolean }> = async () => { this.reloads += 1; return { deferred: false }; };
  subscribe(l: DriverListener) { this.listeners.add(l); return () => this.listeners.delete(l); }
  emit(e: DriverEvent) { for (const l of this.listeners) l(e); }
  async prepareFirstTurn(options: FirstTurnOptions) { this.prepared.push(options); }
  async rollbackFirstTurn() { this.rollbacks += 1; }
  async prompt(content: unknown[], options?: PromptOptions) {
    this.prompted.push(content);
    if (!this.acceptPrompt) return { accepted: false, queued: false };
    options?.onAccepted?.();
    this.st = { ...this.st, messageCount: this.st.messageCount + 1 };
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
  /** Every move, with the options the server handed over. */
  moves: Array<{ op: "navigate" | "fork"; entryId: string; options: unknown }> = [];
  async navigateTree(entryId: string, options?: unknown) { this.moves.push({ op: "navigate", entryId, options }); return { cancelled: false }; }
  async fork(entryId: string, options?: unknown) { this.moves.push({ op: "fork", entryId, options }); this.st = { ...this.st, path: `/tmp/fake/fork-${entryId}.jsonl` }; return { state: this.st, editorText: "redo" }; }
  respondToUi(r: unknown) { this.answered.push(r); }
  deliverExtensionCommand(command: unknown) { this.extensionCommands.push(command); return true; }
  pendingUi() { return this.pending; }
  async entries() { return { entries: [], leafId: null }; }
  async goalState() { return null; }
  async commands() { return [{ name: "skill:test", source: "skill" as const, description: "Test skill" }]; }
  async prompts() { return []; }
  async dispose() { this.disposed = true; this.emit({ type: "closed", reason: "disposed" }); }
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
  it("lists project commands before a session exists without attaching the preview driver", async () => {
    const h = harness();
    const listed = await h.call(1, "pi/commands/list", { cwd: "/tmp/fake" });

    expect(listed.result).toEqual({ commands: [{ name: "skill:test", source: "skill", description: "Test skill" }] });
    expect(h.server.openSessions()).toEqual([]);
    expect(h.drivers).toHaveLength(1);
    expect(h.drivers[0]?.disposed).toBe(true);
  });

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

  it("binds a custom agent to the same pristine path at first-prompt acceptance", async () => {
    const h = harness();
    const snapshot = fallbackSnapshot();
    await h.call(1, "agents/sync", {
      snapshot: {
        ...snapshot,
        agents: [...snapshot.agents, { ...fallbackDefaultAgent(), name: "reviewer", engineInstructions: false, instructions: "Review carefully." }],
      },
    });
    await h.call(2, "session/new", { cwd: "/tmp/fake" });
    const driver = h.drivers[0]!;
    const prompted = await h.call(3, "session/prompt", {
      path: "/tmp/fake/s1.jsonl",
      content: [{ type: "text", text: "check this" }],
      firstTurn: { agentName: "reviewer", thinkingLevel: "high" },
    });

    expect(prompted.result).toEqual({ accepted: true, queued: false });
    expect(driver.prepared).toHaveLength(1);
    expect(driver.prepared[0]).toMatchObject({ agent: { definition: { name: "reviewer" } }, thinkingLevel: "high" });
    expect(driver.prompted).toEqual([[{ type: "text", text: "check this" }]]);
    expect(driver.rollbacks).toBe(0);
    expect(h.server.openSessions()).toEqual(["/tmp/fake/s1.jsonl"]);
    const loaded = await h.call(4, "session/load", { path: "/tmp/fake/s1.jsonl" });
    expect(loaded.result).toMatchObject({ state: { path: "/tmp/fake/s1.jsonl", agent: { agentName: "reviewer", kind: "root" } } });
  });

  it("rolls back a refused first-turn prompt for retry and rejects a stale bind", async () => {
    const h = harness();
    const snapshot = fallbackSnapshot();
    await h.call(1, "agents/sync", {
      snapshot: {
        ...snapshot,
        agents: [...snapshot.agents, { ...fallbackDefaultAgent(), name: "reviewer" }],
      },
    });
    await h.call(2, "session/new", { cwd: "/tmp/fake" });
    const driver = h.drivers[0]!;
    driver.acceptPrompt = false;
    const refused = await h.call(3, "session/prompt", {
      path: "/tmp/fake/s1.jsonl",
      content: [{ type: "text", text: "first try" }],
      firstTurn: { agentName: "reviewer" },
    });
    expect(refused.result).toEqual({ accepted: false, queued: false });
    expect(driver.rollbacks).toBe(1);

    driver.acceptPrompt = true;
    const accepted = await h.call(4, "session/prompt", {
      path: "/tmp/fake/s1.jsonl",
      content: [{ type: "text", text: "retry" }],
      firstTurn: { agentName: "reviewer" },
    });
    const stale = await h.call(5, "session/prompt", {
      path: "/tmp/fake/s1.jsonl",
      content: [{ type: "text", text: "duplicate" }],
      firstTurn: { agentName: "reviewer" },
    });
    expect(accepted.result).toEqual({ accepted: true, queued: false });
    expect(stale.error?.code).toBe(-32602);
    expect(driver.prompted).toHaveLength(2);
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

  it("reports its current seq so a client that read the file can stamp it", async () => {
    // The defect this exists for: a session that ran while nothing was
    // attached (a child agent) is read through `pi/session/entries`, so the
    // client has the whole transcript and has seen no live update. If it then
    // re-opens from seq 0 the worker dutifully replays every buffered update
    // on top of what is already on screen, and the transcript doubles.
    const h = harness();
    await h.call(1, "session/new", { cwd: "/tmp/fake" });
    const d = h.drivers[0]!;
    for (let i = 0; i < 3; i++) d.emit({ type: "update", update: { kind: "turn_start" } });

    // A fresh open (no `fromSeq`): nothing is replayed, and the reply says
    // which watermark the snapshot the client is about to read corresponds to.
    h.out.length = 0;
    const opened = await h.call(2, "session/load", { path: "/tmp/fake/s1.jsonl" });
    expect(opened.result).toMatchObject({ replayFrom: 0, seq: 3 });
    expect(h.notifications("session/update")).toHaveLength(0);

    // Asking from 0 really does replay everything — this is the doubling, and
    // it is why `seq` has to be stamped rather than inferred from silence.
    h.out.length = 0;
    const naive = await h.call(3, "session/load", { path: "/tmp/fake/s1.jsonl", fromSeq: 0 });
    expect(naive.result).toMatchObject({ replayFrom: 0, seq: 3 });
    expect(h.notifications("session/update").map((n) => (n.params as { seq: number }).seq)).toEqual([1, 2, 3]);

    // Asking from the stamped watermark replays nothing.
    h.out.length = 0;
    const truthful = await h.call(4, "session/load", { path: "/tmp/fake/s1.jsonl", fromSeq: 3 });
    expect(truthful.result).toMatchObject({ replayFrom: 3, seq: 3 });
    expect(h.notifications("session/update")).toHaveLength(0);
  });

  it("reports seq 0 for a session it has only just opened", async () => {
    const h = harness();
    const loaded = await h.call(1, "session/load", { path: "/tmp/fake/s2.jsonl" });
    expect(loaded.result).toMatchObject({ replayFrom: 0, seq: 0 });
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

  it("hands stopFirst to the driver, whose stop-then-move it is, and never invents it", async () => {
    const h = harness();
    await h.call(1, "session/new", { cwd: "/tmp/fake" });
    const driver = h.drivers[0]!;
    // One request each: the worker does not stop with `session/cancel` and
    // then move — a failure between the two would be the UI's to notice.
    expect((await h.call(2, "pi/session/navigate", { path: "/tmp/fake/s1.jsonl", entryId: "e1", stopFirst: true })).result).toEqual({ cancelled: false });
    expect((await h.call(3, "pi/session/navigate", { path: "/tmp/fake/s1.jsonl", entryId: "e2", label: "x" })).result).toEqual({ cancelled: false });
    expect((await h.call(4, "pi/session/fork", { path: "/tmp/fake/s1.jsonl", entryId: "e3", stopFirst: true })).result).toMatchObject({ editorText: "redo" });
    expect((await h.call(5, "pi/session/fork", { path: "/tmp/fake/fork-e3.jsonl", entryId: "e4" })).result).toMatchObject({ editorText: "redo" });
    expect(driver.moves).toEqual([
      { op: "navigate", entryId: "e1", options: { stopFirst: true } },
      { op: "navigate", entryId: "e2", options: { label: "x" } },
      { op: "fork", entryId: "e3", options: { stopFirst: true } },
      { op: "fork", entryId: "e4", options: {} },
    ]);
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

  // M13-T58: the host moves a session's file only once no worker holds it.
  it("lets go of one session on pi/session/close, refuses mid-turn, and says when it held nothing", async () => {
    const h = harness();
    await h.call(1, "session/new", { cwd: "/tmp/fake" });
    await h.call(2, "session/load", { path: "/tmp/other.jsonl" });
    const driver = h.drivers[0]!;

    driver.setStreaming(true);
    const busy = await h.call(3, "pi/session/close", { path: "/tmp/fake/s1.jsonl" });
    expect(busy.error?.code).toBe(-32001);
    expect(driver.disposed).toBe(false);
    expect(h.server.openSessions().sort()).toEqual(["/tmp/fake/s1.jsonl", "/tmp/other.jsonl"]);

    driver.setStreaming(false);
    const closed = await h.call(4, "pi/session/close", { path: "/tmp/fake/s1.jsonl" });
    expect(closed.result).toEqual({ closed: true });
    expect(driver.disposed).toBe(true);
    // Only that session: the other one is untouched, and the closed one is
    // not served any more.
    expect(h.server.openSessions()).toEqual(["/tmp/other.jsonl"]);
    expect(h.drivers[1]?.disposed).toBe(false);
    const gone = await h.call(5, "pi/model/list", { path: "/tmp/fake/s1.jsonl" });
    expect(gone.error?.code).toBe(-32000);

    const again = await h.call(6, "pi/session/close", { path: "/tmp/fake/s1.jsonl" });
    expect(again.result).toEqual({ closed: false });
    await h.server.dispose();
  });
});

/**
 * M13-T55: a settings write makes the sessions it touches read it again. The
 * adapter writes real files, so this harness owns a temp project and agent
 * directory; the user's own are never touched.
 */
describe("WorkerServer settings writes and live sessions", () => {
  let base: string;

  afterEach(() => {
    if (base) rmSync(base, { recursive: true, force: true });
  });

  /** Two sessions: one in the project's checkout, one in a worktree of it. */
  async function twoSessions() {
    base = mkdtempSync(join(tmpdir(), `${PRODUCT_NAME}-server-settings-`));
    const cwd = join(base, "project");
    const agentDir = join(base, "agent");
    mkdirSync(cwd, { recursive: true });
    mkdirSync(agentDir, { recursive: true });
    const out: JsonRpcMessage[] = [];
    const drivers: FakeDriver[] = [];
    const server = new WorkerServer({
      cwd,
      agentDir,
      projectTrusted: true,
      createDriver: () => { const d = new FakeDriver(); drivers.push(d); return d; },
      send: (m) => out.push(m),
    });
    const call = async (id: number, method: string, params?: unknown) => {
      await server.handle({ jsonrpc: "2.0", id, method, params });
      return out.find((m) => "id" in m && m.id === id) as { result?: { snapshot?: { effective: Record<string, unknown> } }; error?: { code: number } };
    };
    await call(1, "session/new", { cwd });
    await call(2, "session/load", { path: join(cwd, ".worktrees", "child", "s2.jsonl") });
    const [project, worktree] = drivers as [FakeDriver, FakeDriver];
    project.setCwd(cwd);
    worktree.setCwd(join(cwd, ".worktrees", "child"));
    return { cwd, agentDir, server, call, project, worktree };
  }

  it("a global write reaches every open session, after the file holds it", async () => {
    const h = await twoSessions();
    const written = await h.call(3, "pi/settings/set", { cwd: h.cwd, scope: "global", changes: [{ path: "steeringMode", op: "set", value: "all" }] });
    expect(written.error).toBeUndefined();
    expect(written.result?.snapshot?.effective["steeringMode"]).toBe("all");
    expect(JSON.parse(readFileSync(join(h.agentDir, "settings.json"), "utf8"))).toMatchObject({ steeringMode: "all" });
    expect(h.project.reloads).toBe(1);
    expect(h.worktree.reloads).toBe(1);
    await h.server.dispose();
  });

  it("a project write reaches only the sessions in this project's checkout", async () => {
    const h = await twoSessions();
    const written = await h.call(3, "pi/settings/set", { cwd: h.cwd, scope: "project", changes: [{ path: "defaultThinkingLevel", op: "set", value: "high" }] });
    expect(written.error).toBeUndefined();
    expect(JSON.parse(readFileSync(join(h.cwd, PROJECT_DIR_NAME, "settings.json"), "utf8"))).toEqual({ defaultThinkingLevel: "high" });
    // The worktree session reads its own `.laser`, which this write did not touch.
    expect(h.project.reloads).toBe(1);
    expect(h.worktree.reloads).toBe(0);
    await h.server.dispose();
  });

  it("a refused write reloads nothing", async () => {
    const h = await twoSessions();
    const refused = await h.call(3, "pi/settings/set", { cwd: h.cwd, scope: "global", changes: [{ path: "steeringMode", op: "set", value: "sideways" }] });
    expect(refused.error).toBeDefined();
    expect(h.project.reloads).toBe(0);
    expect(h.worktree.reloads).toBe(0);
    await h.server.dispose();
  });

  it("a session that cannot reload, or a driver without the verb, never fails the write", async () => {
    const h = await twoSessions();
    h.project.reloadSettings = async () => { throw new Error("engine says no"); };
    h.worktree.reloadSettings = undefined;
    const written = await h.call(3, "pi/settings/set", { cwd: h.cwd, scope: "global", changes: [{ path: "steeringMode", op: "set", value: "all" }] });
    expect(written.error).toBeUndefined();
    expect(written.result?.snapshot?.effective["steeringMode"]).toBe("all");
    await h.server.dispose();
  });
});
