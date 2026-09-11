/**
 * WorkerServer (M0-T6) with a fake driver: dispatch, seq numbering, replay on
 * load, dialog notifications, and error mapping. The real driver is covered
 * by stable-sdk.*.test.ts.
 */
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { PRODUCT_NAME, PROJECT_DIR_NAME, SESSION_AGENT_ENTRY_TYPE } from "@lasercode/protocol";
import type { ContentBlock, JsonRpcMessage, SessionState, UiDialogRequest } from "@lasercode/protocol";
import { WorkerServer } from "../src/server.js";
import type { DriverEvent, DriverListener, ExtensionModelWorkHandler, FirstTurnOptions, PromptOptions, SessionDriver } from "../src/driver.js";
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
  prepareGate: Promise<void> | undefined;
  prepareObserved: (() => void) | undefined;
  prepareFailure: Error | undefined;
  abortPreparation = false;
  generation = "original";
  routed: Array<{ route: string; generation: string; content?: unknown; options?: PromptOptions }> = [];
  rollbacks = 0;
  acceptPrompt = true;
  /** Hold every accepted prompt until `releasePrompt()`, streaming meanwhile; `nextHeld()` is the barrier. */
  holdPrompts = false;
  private held: Array<{ resolve: (result: { accepted: boolean; queued: boolean }) => void }> = [];
  private heldWaiters: Array<() => void> = [];
  /** Pi's two lanes as `clearQueue()` reports them: what steer/follow_up and a queued prompt put there. */
  engine = { steering: [] as string[], followUp: [] as string[] };
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
  async prepareFirstTurn(options: FirstTurnOptions) {
    this.prepared.push(options);
    this.prepareObserved?.();
    await this.prepareGate;
    if (this.prepareFailure) throw this.prepareFailure;
    this.generation = "selected";
  }
  async rollbackFirstTurn() { this.rollbacks += 1; this.generation = "original"; }
  async prompt(content: unknown[], options?: PromptOptions) {
    this.prompted.push(content);
    this.routed.push({ route: "prompt", generation: this.generation, content, ...(options ? { options } : {}) });
    if (!this.acceptPrompt) return { accepted: false, queued: false };
    // Like Pi: an explicitly queued prompt while streaming goes into that
    // lane, is accepted at once, and answers before the turn it joins ends.
    if (this.st.isStreaming && options?.streamingBehavior) {
      (options.streamingBehavior === "steer" ? this.engine.steering : this.engine.followUp).push(textOf(content as ContentBlock[]));
      options.onAccepted?.();
      this.emit({ type: "update", update: { kind: "queue_update", steering: [...this.engine.steering], followUp: [...this.engine.followUp] } });
      return { accepted: true, queued: true };
    }
    options?.onAccepted?.();
    this.st = { ...this.st, messageCount: this.st.messageCount + 1 };
    this.emit({ type: "update", update: { kind: "agent_start" } });
    if (this.holdPrompts) {
      this.setStreaming(true);
      const result = new Promise<{ accepted: boolean; queued: boolean }>((resolve) => this.held.push({ resolve }));
      for (const waiter of this.heldWaiters.splice(0)) waiter();
      return result;
    }
    this.emit({ type: "update", update: { kind: "text_delta", delta: "hi", contentIndex: 0 } });
    this.emit({ type: "update", update: { kind: "agent_settled" } });
    return { accepted: true, queued: false };
  }
  /** Resolves once the next prompt is held (or at once if one already is). */
  nextHeld(): Promise<void> {
    if (this.held.length > 0) return Promise.resolve();
    return new Promise<void>((resolve) => this.heldWaiters.push(resolve));
  }
  /** The held turn ends: settled first, then the prompt promise, as Pi does. */
  releasePrompt() {
    const pending = this.held.shift();
    if (!pending) throw new Error("No prompt is held.");
    this.setStreaming(false);
    this.emit({ type: "update", update: { kind: "agent_settled" } });
    pending.resolve({ accepted: true, queued: false });
  }
  async steer(content: ContentBlock[]) { this.routed.push({ route: "steer", generation: this.generation, content }); this.engine.steering.push(textOf(content)); }
  async followUp(content: ContentBlock[]) { this.routed.push({ route: "followUp", generation: this.generation, content }); this.engine.followUp.push(textOf(content)); }
  async clearQueue() {
    const cleared = { steering: this.engine.steering, followUp: this.engine.followUp };
    this.engine = { steering: [], followUp: [] };
    return cleared;
  }
  async abort() {
    this.routed.push({ route: "abort", generation: this.generation });
    if (this.abortPreparation && this.generation === "original") this.prepareFailure = new Error("cancelled during preparation");
  }
  async listModels() { this.routed.push({ route: "models", generation: this.generation }); return [{ provider: "p", id: "m" }]; }
  async setModel() { this.routed.push({ route: "model", generation: this.generation }); return this.st; }
  async setThinkingLevel(level: SessionState["thinkingLevel"]) { this.routed.push({ route: "thinking", generation: this.generation }); this.st = { ...this.st, thinkingLevel: level }; return this.st; }
  async rename() { this.routed.push({ route: "rename", generation: this.generation }); }
  async compact() { this.routed.push({ route: "compact", generation: this.generation }); }
  /** Every move, with the options the server handed over. */
  moves: Array<{ op: "navigate" | "fork"; entryId: string; options: unknown }> = [];
  async navigateTree(entryId: string, options?: unknown) { this.routed.push({ route: "navigate", generation: this.generation }); this.moves.push({ op: "navigate", entryId, options }); return { cancelled: false }; }
  async fork(entryId: string, options?: unknown) { this.moves.push({ op: "fork", entryId, options }); this.st = { ...this.st, path: `/tmp/fake/fork-${entryId}.jsonl` }; return { state: this.st, editorText: "redo" }; }
  respondToUi(r: unknown) { this.answered.push(r); }
  deliverExtensionCommand(command: unknown) { this.extensionCommands.push(command); return true; }
  /** The server's admission for extension work that can enter the model; a test drives it the way an extension's `sendMessage` would. */
  extensionWork: ExtensionModelWorkHandler | undefined;
  setExtensionModelWorkHandler(handler: ExtensionModelWorkHandler | undefined) { this.extensionWork = handler; }
  pendingUi() { return this.pending; }
  async entries() { this.routed.push({ route: "entries", generation: this.generation }); return { entries: [], leafId: null }; }
  async goalState() { return null; }
  async commands() { return [{ name: "skill:test", source: "skill" as const, description: "Test skill" }]; }
  async prompts() { return []; }
  async dispose() { this.disposed = true; this.emit({ type: "closed", reason: "disposed" }); }
}

function deferred<T = void>() {
  let resolve!: (value: T | PromiseLike<T>) => void;
  const promise = new Promise<T>((done) => { resolve = done; });
  return { promise, resolve };
}

function textOf(content: ContentBlock[]): string {
  return content.map((block) => (block.type === "text" ? block.text : "")).join("");
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
      firstTurn: { agentName: "reviewer", model: null, thinkingLevel: "high" },
    });

    expect(prompted.result).toEqual({ accepted: true, queued: false });
    expect(driver.prepared).toHaveLength(1);
    expect(driver.prepared[0]).toMatchObject({ agent: { definition: { name: "reviewer" } }, model: null, thinkingLevel: "high" });
    expect(driver.prompted).toEqual([[{ type: "text", text: "check this" }]]);
    expect(driver.rollbacks).toBe(0);
    expect(h.server.openSessions()).toEqual(["/tmp/fake/s1.jsonl"]);
    const loaded = await h.call(4, "session/load", { path: "/tmp/fake/s1.jsonl" });
    expect(loaded.result).toMatchObject({ state: { path: "/tmp/fake/s1.jsonl", agent: { agentName: "reviewer", kind: "root" } } });
  });

  it("holds every prompt-entry route at one runtime generation during first-turn replacement", async () => {
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
    const prepare = deferred();
    const entered = deferred();
    driver.prepareGate = prepare.promise;
    driver.prepareObserved = entered.resolve;

    const binding = h.call(3, "session/prompt", {
      path: "/tmp/fake/s1.jsonl",
      content: [{ type: "text", text: "first" }],
      firstTurn: { agentName: "reviewer" },
    });
    await entered.promise;

    // Bare prompt remains a refusal rather than silently changing semantics.
    await expect(h.call(4, "session/prompt", {
      path: "/tmp/fake/s1.jsonl",
      content: [{ type: "text", text: "bare" }],
    })).resolves.toMatchObject({ result: { accepted: false, queued: false } });

    // A queued tray item begins draining while replacement owns the fence.
    await h.call(5, "session/pending/add", {
      path: "/tmp/fake/s1.jsonl",
      content: [{ type: "text", text: "queued tray" }],
    });
    driver.emit({ type: "update", update: { kind: "agent_settled" } });

    const steer = h.call(6, "pi/session/steer", { path: "/tmp/fake/s1.jsonl", content: [{ type: "text", text: "steer" }] });
    const follow = h.call(7, "pi/session/follow_up", { path: "/tmp/fake/s1.jsonl", content: [{ type: "text", text: "follow" }] });
    const thinking = h.call(8, "pi/thinking/set", { path: "/tmp/fake/s1.jsonl", level: "high" });
    const tray = await h.call(9, "session/pending/add", {
      path: "/tmp/fake/s1.jsonl",
      content: [{ type: "text", text: "tray steer" }],
    });
    driver.setStreaming(true);
    const traySteer = h.call(10, "session/pending/steer", {
      path: "/tmp/fake/s1.jsonl",
      id: (tray.result as { message: { id: string } }).message.id,
    });
    driver.routed = [];
    const entries = h.call(11, "pi/session/entries", { path: "/tmp/fake/s1.jsonl" });
    const rename = h.call(12, "pi/session/rename", { path: "/tmp/fake/s1.jsonl", name: "wait" });
    const models = h.call(13, "pi/model/list", { path: "/tmp/fake/s1.jsonl" });

    expect(driver.routed).toEqual([]);
    prepare.resolve();
    await Promise.all([binding, steer, follow, thinking, traySteer, entries, rename, models]);

    expect(driver.routed.map((call) => call.route).sort()).toEqual([
      "entries",
      "followUp",
      "models",
      "prompt",
      "prompt",
      "rename",
      "steer",
      "steer",
      "thinking",
    ]);
    expect(driver.routed.every((call) => call.generation === "selected")).toBe(true);
    expect(driver.prompted).toEqual([
      [{ type: "text", text: "first" }],
      [{ type: "text", text: "queued tray" }],
    ]);
    expect((await h.call(14, "session/pending/list", { path: "/tmp/fake/s1.jsonl" })).result).toEqual({ messages: [] });
  });

  it("lets cancellation reach preparation before acceptance, then rolls back", async () => {
    const h = harness();
    const snapshot = fallbackSnapshot();
    await h.call(1, "agents/sync", { snapshot: { ...snapshot, agents: [...snapshot.agents, { ...fallbackDefaultAgent(), name: "reviewer" }] } });
    await h.call(2, "session/new", { cwd: "/tmp/fake" });
    const driver = h.drivers[0]!;
    const prepare = deferred();
    const entered = deferred();
    driver.prepareGate = prepare.promise;
    driver.prepareObserved = entered.resolve;
    driver.abortPreparation = true;

    const binding = h.call(3, "session/prompt", {
      path: "/tmp/fake/s1.jsonl",
      content: [{ type: "text", text: "must not be accepted" }],
      firstTurn: { agentName: "reviewer" },
    });
    await entered.promise;
    const cancelled = await h.call(4, "session/cancel", { path: "/tmp/fake/s1.jsonl" });
    expect(cancelled.error).toBeUndefined();
    expect(driver.routed.at(-1)).toMatchObject({ route: "abort", generation: "original" });
    prepare.resolve();
    expect((await binding).error).toBeDefined();
    expect(driver.prompted).toEqual([]);
    expect(driver.rollbacks).toBe(1);
    expect(driver.generation).toBe("original");
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
    driver.prepareFailure = new Error("replacement failed");
    const failed = await h.call(3, "session/prompt", {
      path: "/tmp/fake/s1.jsonl",
      content: [{ type: "text", text: "failed replacement" }],
      firstTurn: { agentName: "reviewer", model: null },
    });
    expect(failed.error).toBeDefined();
    expect(driver.rollbacks).toBe(1);
    expect(driver.prompted).toEqual([]);

    driver.prepareFailure = undefined;
    driver.acceptPrompt = false;
    const refused = await h.call(4, "session/prompt", {
      path: "/tmp/fake/s1.jsonl",
      content: [{ type: "text", text: "first try" }],
      firstTurn: { agentName: "reviewer", model: null },
    });
    expect(refused.result).toEqual({ accepted: false, queued: false });
    expect(driver.rollbacks).toBe(2);
    expect(driver.prepared.at(-1)?.model).toBeNull();

    driver.acceptPrompt = true;
    const accepted = await h.call(5, "session/prompt", {
      path: "/tmp/fake/s1.jsonl",
      content: [{ type: "text", text: "retry" }],
      firstTurn: { agentName: "reviewer", model: null },
    });
    const stale = await h.call(6, "session/prompt", {
      path: "/tmp/fake/s1.jsonl",
      content: [{ type: "text", text: "duplicate" }],
      firstTurn: { agentName: "reviewer", model: null },
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

  it("does not forward a dialog the driver no longer holds, so a person is never shown a question nobody can answer", async () => {
    const h = harness();
    await h.call(1, "session/new", { cwd: "/tmp/fake" });
    const d = h.drivers[0]!;
    // The harness cancels an unroutable question synchronously, before the
    // forwarder runs (M13-T98): by the time the event reaches the server the
    // bridge has already let go of the id.
    d.pending = [];
    d.emit({ type: "ui_request", request: { method: "select", id: "ui-gone", title: "Later?", options: ["a"] } });
    expect(h.notifications("pi/ui/request")).toEqual([]);
    // A dialog the bridge still holds is forwarded as before.
    d.pending = [{ method: "select", id: "ui-open", title: "Now?", options: ["a"] }];
    d.emit({ type: "ui_request", request: { method: "select", id: "ui-open", title: "Now?", options: ["a"] } });
    expect(h.notifications("pi/ui/request").map((n) => (n.params as { id: string }).id)).toEqual(["ui-open"]);
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

/**
 * A person typing in a child agent's own chat (M13-T98 §8.4). The three
 * queue verbs go through the harness fence for a child and stay the driver's
 * for a root; the fake driver holds prompts so the terminal-pending window
 * can be observed without an engine.
 */
describe("WorkerServer sends into a child agent's own chat", () => {
  let base: string;
  beforeEach(() => {
    base = mkdtempSync(join(tmpdir(), `${PRODUCT_NAME}-server-child-`));
  });
  afterEach(() => {
    rmSync(base, { recursive: true, force: true });
  });

  function childHarness() {
    const out: JsonRpcMessage[] = [];
    const observers = new Set<(message: JsonRpcMessage) => void>();
    const drivers: FakeDriver[] = [];
    const server = new WorkerServer({
      cwd: base,
      createDriver: () => { const d = new FakeDriver(); drivers.push(d); return d; },
      send: (m) => {
        out.push(m);
        for (const observe of [...observers]) observe(m);
      },
    });
    let nextId = 1;
    const call = async (method: string, params?: unknown) => {
      const id = nextId++;
      await server.handle({ jsonrpc: "2.0", id, method, params });
      return out.find((m) => "id" in m && m.id === id) as { result?: unknown; error?: { code: number; message: string } };
    };
    /** A notification that has not arrived yet. */
    const waitFor = (predicate: (message: JsonRpcMessage) => boolean): Promise<JsonRpcMessage> => {
      const existing = out.find(predicate);
      if (existing) return Promise.resolve(existing);
      return new Promise((resolve) => {
        const observe = (message: JsonRpcMessage) => {
          if (!predicate(message)) return;
          observers.delete(observe);
          resolve(message);
        };
        observers.add(observe);
      });
    };
    const lifecycleLine = (text: string) => (message: JsonRpcMessage) =>
      "method" in message && message.method === "pi/extension/message"
      && (message as { params: { message: { type?: string; message?: string } } }).params.message.type === "lasercode/module/log"
      && ((message as { params: { message: { message?: string } } }).params.message.message ?? "").includes(text);
    const parentPath = join(base, "parent.jsonl");
    const childPath = join(base, "child.jsonl");
    writeFileSync(parentPath, `${JSON.stringify({ type: "session", id: "p" })}\n${JSON.stringify({ type: "custom", customType: SESSION_AGENT_ENTRY_TYPE, data: { agentName: "default", kind: "root" } })}\n`);
    writeFileSync(childPath, `${JSON.stringify({ type: "session", id: "c" })}\n${JSON.stringify({ type: "custom", customType: SESSION_AGENT_ENTRY_TYPE, data: { agentName: "default", kind: "child", subagentName: "fixer", parentPath, parentSessionId: "p", rootPath: parentPath, runId: "run_seed" } })}\n`);
    const runs = () => server.agents().runs().filter((run) => run.sessionPath === childPath);
    const text = (value: string): ContentBlock[] => [{ type: "text", text: value }];
    return { server, out, drivers, call, waitFor, lifecycleLine, childPath, runs, text };
  }

  it("queues a person's steer and follow-up in the engine through the harness while the child streams, forgets them on clear, and holds one for the successor during terminal-pending", async () => {
    const h = childHarness();
    expect((await h.call("session/load", { path: h.childPath })).error).toBeUndefined();
    const d = h.drivers[0]!;
    d.holdPrompts = true;
    const first = h.call("session/prompt", { path: h.childPath, content: h.text("first") });
    await d.nextHeld();
    const [run] = h.runs();
    expect(run).toMatchObject({ origin: "user", status: "running", task: "first" });

    // While it streams: the engine's lanes, through the harness's prompt with
    // the lane as its behaviour — never the driver's direct verb — and the
    // request answers at acceptance, not when the turn ends.
    expect((await h.call("pi/session/follow_up", { path: h.childPath, content: h.text("F") })).result).toEqual({});
    expect((await h.call("pi/session/steer", { path: h.childPath, content: h.text("S") })).result).toEqual({});
    expect(d.routed.filter((entry) => entry.route === "steer" || entry.route === "followUp")).toEqual([]);
    expect(d.routed.slice(-2).map((entry) => [textOf(entry.content as ContentBlock[]), entry.options?.streamingBehavior, entry.options?.expandPromptTemplates])).toEqual([["F", "followUp", true], ["S", "steer", true]]);
    expect(d.engine).toEqual({ steering: ["S"], followUp: ["F"] });
    expect(h.runs()).toHaveLength(1);

    // Clear: the engine's texts come back, and the harness forgets its twins.
    expect((await h.call("pi/session/clear_queue", { path: h.childPath })).result).toEqual({ steering: ["S"], followUp: ["F"] });
    expect(d.engine).toEqual({ steering: [], followUp: [] });
    await h.waitFor(h.lifecycleLine(`queue-cleared runId=${run!.runId} clearedSteering=1 clearedFollowUp=1 twins=2`));

    // Terminal-pending: the completion is declared while the prompt is still
    // held. Nothing was left to transfer, so no successor exists yet.
    expect(await h.server.agents().bridgeOf(h.childPath)!.completeRun({ status: "completed", message: "done" })).toEqual({ ok: true, runId: run!.runId });
    expect(h.runs()).toHaveLength(1);

    // A follow-up now waits for the successor, never the engine, and its
    // request is still open: the engine does not hold the message yet.
    const late = h.call("pi/session/follow_up", { path: h.childPath, content: h.text("P") });
    await h.waitFor(h.lifecycleLine("admission source=person decision=queued-successor"));
    const successor = h.runs().find((candidate) => candidate.runId !== run!.runId)!;
    expect(successor).toMatchObject({ status: "queued", origin: "user", task: "P" });
    expect(d.engine).toEqual({ steering: [], followUp: [] });
    expect(d.routed.filter((entry) => entry.route === "followUp")).toEqual([]);
    let lateSettled = false;
    void late.then(() => { lateSettled = true; });
    await Promise.resolve();
    expect(lateSettled).toBe(false);

    // The old prompt resolves: the successor's own prompt is P, with the
    // follow-up behaviour, and the person's request answers at its acceptance.
    d.releasePrompt();
    expect((await first).result).toEqual({ accepted: true, queued: false });
    await d.nextHeld();
    expect(d.routed.at(-1)).toMatchObject({ route: "prompt", content: h.text("P"), options: { streamingBehavior: "followUp", expandPromptTemplates: true } });
    expect((await late).result).toEqual({});
    expect(h.server.agents().run(run!.runId)).toMatchObject({ status: "completed", result: { message: "done" } });
    expect(h.server.agents().run(successor.runId)?.status).toBe("running");
    expect(d.engine).toEqual({ steering: [], followUp: [] });
    expect(await h.server.agents().bridgeOf(h.childPath)!.completeRun({ status: "completed", message: "successor done" })).toEqual({ ok: true, runId: successor.runId });
    d.releasePrompt();
    await h.waitFor((message) => "method" in message && message.method === "agents/run" && (message as { params: { run: { runId: string; status: string } } }).params.run.runId === successor.runId && (message as { params: { run: { status: string } } }).params.run.status === "completed");
    expect(h.runs().map((candidate) => candidate.status)).toEqual(["completed", "completed"]);
    await h.server.dispose();
  });

  it("releases the lease a parked tray message took, so an extension's message ahead of it on the successor can start", async () => {
    // F1 at the fake level: the tray's drain at agent_settled prompts under
    // the session's admission lease; parked behind an extension's wake on the
    // successor, it must let that lease go — the wake's start runs through
    // the server's wrapper, which takes the same lease before the engine
    // sees the message, and the person's acceptance follows the wake's turn.
    const h = childHarness();
    expect((await h.call("session/load", { path: h.childPath })).error).toBeUndefined();
    const d = h.drivers[0]!;
    d.holdPrompts = true;
    const first = h.call("session/prompt", { path: h.childPath, content: h.text("first") });
    await d.nextHeld();
    const [run] = h.runs();
    expect((await h.call("session/pending/add", { path: h.childPath, content: h.text("T") })).error).toBeUndefined();
    expect(await h.server.agents().bridgeOf(h.childPath)!.completeRun({ status: "completed", message: "done" })).toEqual({ ok: true, runId: run!.runId });

    // During terminal-pending, an extension's custom trigger: first on the
    // successor. Its `start` is reached only through the server's wrapper.
    let started = 0;
    const startedSignal = deferred();
    const completeWake = deferred<{ disposition: "started" }>();
    const admitted = d.extensionWork!({
      kind: "custom",
      content: h.text("wake"),
      task: "wake",
      origin: "agent",
      start: (ownerRunId, onInvocation) => {
        started += 1;
        onInvocation?.({ id: "ext-1", ...(ownerRunId ? { runId: ownerRunId } : {}) });
        startedSignal.resolve();
        return { admission: Promise.resolve(), completion: completeWake.promise };
      },
    });
    void admitted.admission.catch(() => undefined);
    const successor = h.runs().find((candidate) => candidate.runId !== run!.runId)!;
    expect(successor).toMatchObject({ status: "queued", task: "wake" });
    expect(started).toBe(0);

    // The old turn ends: the tray drains, its message is parked behind the
    // wake, the lease that delivery took is released there — and the wake starts.
    d.releasePrompt();
    expect((await first).result).toEqual({ accepted: true, queued: false });
    await startedSignal.promise;
    expect(started).toBe(1);
    expect(h.server.agents().run(run!.runId)).toMatchObject({ status: "completed", result: { message: "done" } });
    expect(h.server.agents().run(successor.runId)?.status).toBe("running");
    // The tray row is still on its way: the wake's turn comes first.
    expect(((await h.call("session/pending/list", { path: h.childPath })).result as { messages: Array<{ state: string; text: string }> }).messages).toMatchObject([{ state: "delivering", text: "T" }]);
    expect(d.routed.filter((entry) => entry.route === "prompt").map((entry) => textOf(entry.content as ContentBlock[]))).toEqual(["first"]);

    // The wake's invocation ends: the tray message is the successor's next
    // prompt, accepted and gone from the tray; nothing holds the lease, so a
    // lease-bound request answers while that prompt is still held.
    completeWake.resolve({ disposition: "started" });
    await d.nextHeld();
    expect(d.routed.at(-1)).toMatchObject({ route: "prompt", content: h.text("T") });
    expect(((await h.call("session/pending/list", { path: h.childPath })).result as { messages: unknown[] }).messages).toEqual([]);
    expect((await h.call("pi/thinking/set", { path: h.childPath, level: "high" })).error).toBeUndefined();
    expect(await h.server.agents().bridgeOf(h.childPath)!.completeRun({ status: "completed", message: "successor done" })).toEqual({ ok: true, runId: successor.runId });
    d.releasePrompt();
    await h.waitFor((message) => "method" in message && message.method === "agents/run" && (message as { params: { run: { runId: string; status: string } } }).params.run.runId === successor.runId && (message as { params: { run: { status: string } } }).params.run.status === "completed");
    expect(h.runs().map((candidate) => candidate.status)).toEqual(["completed", "completed"]);
    await h.server.dispose();
  });

  it("sends a child's pending tray row through the harness fence, never the driver's bare steer", async () => {
    const h = childHarness();
    expect((await h.call("session/load", { path: h.childPath })).error).toBeUndefined();
    const d = h.drivers[0]!;
    d.holdPrompts = true;
    const first = h.call("session/prompt", { path: h.childPath, content: h.text("first") });
    await d.nextHeld();
    const added = (await h.call("session/pending/add", { path: h.childPath, content: h.text("T") })).result as { message: { id: string } };
    expect((await h.call("session/pending/steer", { path: h.childPath, id: added.message.id })).result).toEqual({ steered: true });
    // The row went into the engine's steering lane through the harness's
    // prompt, with the lane as its behaviour — the driver's direct verb was
    // never used, so a declared completion can still carry it to the successor.
    expect(d.routed.filter((entry) => entry.route === "steer")).toEqual([]);
    expect(d.routed.at(-1)).toMatchObject({ route: "prompt", content: h.text("T"), options: { streamingBehavior: "steer", expandPromptTemplates: true } });
    expect(d.engine).toEqual({ steering: ["T"], followUp: [] });
    expect(h.runs()).toHaveLength(1);
    d.releasePrompt();
    expect((await first).result).toEqual({ accepted: true, queued: false });
    await h.server.dispose();
  });

  it("answers a person's deferred follow-up with the harness's sentence when the successor is stopped, and keeps the direct verbs for a root", async () => {
    const h = childHarness();
    await h.call("session/load", { path: h.childPath });
    const d = h.drivers[0]!;
    d.holdPrompts = true;
    const first = h.call("session/prompt", { path: h.childPath, content: h.text("first") });
    await d.nextHeld();
    const [run] = h.runs();
    expect(await h.server.agents().bridgeOf(h.childPath)!.completeRun({ status: "completed", message: "done" })).toEqual({ ok: true, runId: run!.runId });
    const late = h.call("pi/session/follow_up", { path: h.childPath, content: h.text("P") });
    await h.waitFor(h.lifecycleLine("admission source=person decision=queued-successor"));
    const successor = h.runs().find((candidate) => candidate.runId !== run!.runId)!;
    const stopped = await h.call("agents/runs/stop", { runId: successor.runId, reason: "not needed" });
    expect((stopped.result as { run: { status: string } }).run.status).toBe("cancelled");
    const reply = await late;
    expect(reply.result).toBeUndefined();
    expect(reply.error?.message).toMatch(/ended \(cancelled\) before this message could start/);
    expect(d.engine).toEqual({ steering: [], followUp: [] });
    d.releasePrompt();
    expect((await first).result).toEqual({ accepted: true, queued: false });

    // A root keeps the driver's verbs: nothing of the harness in the way.
    await h.call("session/new", { cwd: base });
    const root = h.drivers[1]!;
    expect((await h.call("pi/session/steer", { path: root.state().path, content: h.text("root steer") })).result).toEqual({});
    expect((await h.call("pi/session/follow_up", { path: root.state().path, content: h.text("root follow") })).result).toEqual({});
    expect(root.routed.map((entry) => entry.route)).toEqual(["steer", "followUp"]);
    expect((await h.call("pi/session/clear_queue", { path: root.state().path })).result).toEqual({ steering: ["root steer"], followUp: ["root follow"] });
    expect(h.out.some(h.lifecycleLine("queue-cleared") as (message: JsonRpcMessage) => boolean)).toBe(false);
    await h.server.dispose();
  });
});
