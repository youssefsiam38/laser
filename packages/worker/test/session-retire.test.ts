/**
 * RP-4 · retirement as one atomic transition inside the worker.
 *
 * The race this closes: the host used to ask whether a worker was idle, get an
 * answer, and then end the pipe — with a window in between that a request could
 * land in. Now the worker closes admission synchronously when the retire
 * request is dispatched, drains what it had already accepted, re-checks the
 * same canonical predicate under that fence, and either refuses (admission
 * reopens) or acknowledges (admission never reopens). Nothing is queued: a
 * request that arrives is refused retryably, and its arrival is itself a reason
 * to refuse.
 */
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ErrorCodes, LIFETIME_RETRY, PRODUCT_NAME } from "@lasercode/protocol";
import type { AgentsSnapshot, ClientRequests, ContentBlock, JsonRpcMessage, ModelRef, SessionState, UiDialogRequest } from "@lasercode/protocol";
import type { DriverEvent, DriverListener, DriverReleaseReadiness, SessionDriver } from "../src/driver.js";
import { fallbackSnapshot } from "../src/agents/definitions.js";
import type { CompletionContext, CompletionResult, CompletionRuntime } from "../src/agents/session-naming.js";
import { WorkerServer } from "../src/server.js";

/** The profile session naming is assigned to in this file's settings. */
const NAMING_PROFILE_ID = "mp_testretirenaming000000";

/** A private agent directory holding one naming profile, for this file only. */
let agentDir = "";

/**
 * Naming is on exactly when a profile is assigned to it (`docs/plain-chat.md`);
 * there is no built-in to qualify and nothing else to switch.
 */
function writeSettings(naming: boolean): void {
  writeFileSync(
    join(agentDir, "settings.json"),
    JSON.stringify({
      modelProfiles: [{
        id: NAMING_PROFILE_ID,
        name: "Fast",
        models: [{ provider: "stub", id: "stub-1" }],
        origin: "seeded",
        updatedAt: "2026-01-01T00:00:00.000Z",
      }],
      defaultProfileId: NAMING_PROFILE_ID,
      namingProfileId: naming ? NAMING_PROFILE_ID : null,
    }),
  );
}

beforeEach(() => {
  agentDir = mkdtempSync(join(tmpdir(), `${PRODUCT_NAME}-retire-agent-`));
  writeSettings(false);
});

afterEach(() => {
  rmSync(agentDir, { recursive: true, force: true });
});

/**
 * A naming model whose completion this test releases by hand, so a real
 * completion is in flight while retirement is decided — driven only through
 * `agents/sync` and `session/prompt`.
 */
function gatedNamer() {
  const waiting: Array<(text: string) => void> = [];
  return {
    asked: [] as string[],
    getModel: (provider: string, id: string) => ({ provider, id }),
    completeSimple(_model: { provider: string; id: string }, context: CompletionContext): Promise<CompletionResult> {
      this.asked.push(context.messages.map((message) => message.content).join("\n"));
      return new Promise<CompletionResult>((resolve) => {
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

const PATH = "/tmp/retire/s1.jsonl";

class FakeDriver implements SessionDriver {
  readonly kind = "stable-sdk" as const;
  disposed = false;
  pending: UiDialogRequest[] = [];
  /** Holds `prompt()` open so a handler is genuinely accepted and unfinished. */
  promptGate: Promise<void> | undefined;
  prompting: (() => void) | undefined;
  private readonly listeners = new Set<DriverListener>();
  private st: SessionState = {
    path: PATH, id: "s1", cwd: "/tmp/retire", model: null, thinkingLevel: "medium",
    isStreaming: false, isCompacting: false, steeringMode: "one-at-a-time", followUpMode: "one-at-a-time",
    autoCompactionEnabled: true, messageCount: 1, pendingMessageCount: 0,
  };
  async open(options: { sessionPath?: string }) {
    if (options.sessionPath) this.st = { ...this.st, path: options.sessionPath };
    return this.st;
  }
  state() { return this.st; }
  patch(next: Partial<SessionState>) { this.st = { ...this.st, ...next }; }
  subscribe(listener: DriverListener) { this.listeners.add(listener); return () => this.listeners.delete(listener); }
  emit(event: DriverEvent) { for (const listener of this.listeners) listener(event); }
  async prompt() {
    this.prompting?.();
    if (this.promptGate) await this.promptGate;
    return { accepted: true, queued: false };
  }
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
  pendingUi() { return this.pending; }
  async commands() { return []; }
  async prompts() { return []; }
  async entries() { return { entries: [], leafId: null }; }
  sessionHeader() { return { id: this.st.id, cwd: this.st.cwd }; }
  async prepareRelease(): Promise<DriverReleaseReadiness> { return { ok: true }; }
  async dispose() { this.disposed = true; this.emit({ type: "closed", reason: "disposed" }); }
}

function world(options: { retireLeaseMs?: number; namer?: CompletionRuntime } = {}) {
  const out: JsonRpcMessage[] = [];
  const drivers: FakeDriver[] = [];
  const server = new WorkerServer({
    cwd: "/tmp/retire",
    agentDir,
    createDriver: () => { const driver = new FakeDriver(); drivers.push(driver); return driver; },
    send: (message) => out.push(message),
    ...(options.namer ? { namingModels: async () => options.namer! } : {}),
    ...(options.retireLeaseMs !== undefined ? { retireLeaseMs: options.retireLeaseMs } : {}),
  });
  let id = 0;
  const send = (method: string, params?: unknown) => {
    const current = ++id;
    const answered = server.handle({ jsonrpc: "2.0", id: current, method, params });
    return { answered, reply: () => out.find((message) => "id" in message && message.id === current) as { result?: unknown; error?: { code: number; message: string; data?: { retry?: string } } } | undefined };
  };
  const call = async <T>(method: string, params?: unknown) => {
    const sent = send(method, params);
    await sent.answered;
    return sent.reply() as { result?: T; error?: { code: number; message: string; data?: { retry?: string } } };
  };
  const retire = async (mode: "automatic" | "explicit" = "automatic") =>
    (await call<ClientRequests["pi/worker/retire"]["result"]>("pi/worker/retire", { mode })).result!;
  return { server, out, drivers, call, send, retire };
}

const text = (value: string): ContentBlock[] => [{ type: "text", text: value }];

describe("pi/worker/retire", () => {
  it("retires a worker holding nothing, and refuses every request afterwards", async () => {
    const w = world();
    expect(await w.retire()).toEqual({ retiring: true });
    // Admission never reopens: whatever arrives now is told to come back to a
    // new worker, and it is told before anything runs.
    const late = await w.call("session/load", { path: PATH });
    expect(late.error?.code).toBe(ErrorCodes.DriverUnavailable);
    expect(late.error?.data?.retry).toBe(LIFETIME_RETRY);
    // Idempotent: the same answer, not a second transition.
    expect(await w.retire()).toEqual({ retiring: true });
  });

  it("refuses when a conversation is holding work, and keeps serving it", async () => {
    const w = world();
    await w.call("session/load", { path: PATH });
    w.drivers[0]!.pending = [{ id: "d1", kind: "confirm", message: "Proceed?" } as UiDialogRequest];
    const refused = await w.retire();
    expect(refused).toMatchObject({ retiring: false, reason: "pinned" });
    expect(refused.retiring === false && refused.pins[0]!.pins.map((pin) => pin.kind)).toEqual(["question"]);
    // Admission reopened: the worker is a working worker again.
    expect(await w.call("session/load", { path: PATH })).toHaveProperty("result");
  });

  it("waits for a handler it had already accepted, and refuses because that handler pinned the session", async () => {
    const w = world();
    await w.call("session/load", { path: PATH });
    const driver = w.drivers[0]!;
    let finishPrompt = () => {};
    driver.promptGate = new Promise<void>((resolve) => { finishPrompt = resolve; });
    const prompting = new Promise<void>((resolve) => {
      driver.prompting = () => {
        // The turn this accepted handler started keeps running after the
        // handler answers, which is what the recheck under the fence must see.
        driver.patch({ isStreaming: true });
        resolve();
      };
    });
    const prompt = w.send("session/prompt", { path: PATH, content: text("hello") });
    await prompting;

    // The retire arrives with that prompt still running.
    const retiring = w.send("pi/worker/retire", { mode: "automatic" });
    await Promise.resolve();
    finishPrompt();
    await Promise.all([prompt.answered, retiring.answered]);
    expect(prompt.reply()).toHaveProperty("result");
    // The drain waited for it; the recheck then saw the session it had touched.
    const answer = (retiring.reply() as { result: ClientRequests["pi/worker/retire"]["result"] }).result;
    expect(answer).toMatchObject({ retiring: false, reason: "pinned" });
    expect(answer.retiring === false && answer.pins[0]!.pins.map((pin) => pin.kind)).toEqual(["streaming"]);
    expect(w.drivers[0]!.disposed).toBe(false);
  });

  it("refuses because a request arrived while it was deciding, and that request is retryable", async () => {
    const w = world();
    await w.call("session/load", { path: PATH });
    const retiring = w.send("pi/worker/retire", { mode: "automatic" });
    // Dispatched after the fence closed, before the decision is answered.
    const arriving = w.send("pi/session/entries", { path: PATH });
    await Promise.all([retiring.answered, arriving.answered]);

    const answer = (retiring.reply() as { result: ClientRequests["pi/worker/retire"]["result"] }).result;
    expect(answer).toMatchObject({ retiring: false, reason: "arrived" });
    const refused = arriving.reply() as { error?: { code: number; data?: { retry?: string } } };
    expect(refused.error?.code).toBe(ErrorCodes.DriverUnavailable);
    expect(refused.error?.data?.retry).toBe(LIFETIME_RETRY);
    // And the worker is still a worker: the retry works.
    expect(await w.call("pi/session/entries", { path: PATH })).toHaveProperty("result");
  });

  it("lets an explicit stop through an advisory pin, where the idle sweep would refuse", async () => {
    const namer = gatedNamer();
    writeSettings(true);
    const w = world({ namer });
    await w.call("session/load", { path: PATH });
    // A session actually being named is advisory: real work, but not work a
    // person asking for a stop should be made to wait for.
    await w.call("session/prompt", { path: PATH, content: text("explore the repo") });
    await settle();
    expect(namer.asked.join("\n")).toContain("explore the repo");
    expect(w.server.sessionSafety().sessions[0]!.pins.map((pin) => pin.kind)).toEqual(["naming"]);

    const refused = await w.retire("automatic");
    expect(refused).toMatchObject({ retiring: false, reason: "pinned" });
    expect(refused.retiring === false && refused.pins[0]!.pins.map((pin) => pin.kind)).toEqual(["naming"]);
    expect(await w.retire("explicit")).toEqual({ retiring: true });

    // The completion lands after the stop was granted: it finds no one to
    // rename, and settles without taking the worker with it.
    namer.answerWith("Explore the repo");
    await settle();
    expect(w.server.sessionSafety().sessions[0]!.pins).toEqual([]);
  });

  it("retires naturally with a first prompt nothing is assigned to name", async () => {
    const namer = gatedNamer();
    const w = world({ namer });
    await w.call("session/load", { path: PATH });
    // Nothing is assigned to naming, so the request does not run: no model is
    // asked, nothing is parked, and this worker is not kept alive by an intent
    // nobody can perform (`docs/plain-chat.md`).
    expect(await w.call("session/prompt", { path: PATH, content: text("explore the repo") })).toHaveProperty("result");
    await settle();
    expect(namer.asked).toEqual([]);
    expect(w.server.sessionSafety().sessions).toEqual([{ path: PATH, pins: [] }]);
    expect(await w.retire("automatic")).toEqual({ retiring: true });
  });

  it("goes back to work when the acknowledgement was lost and the pipe never closed", async () => {
    // The host asked, this worker agreed and fenced itself — and then nothing
    // happened: the answer was lost, or the host had already given up. A worker
    // that stayed fenced would refuse every request until somebody killed it.
    const w = world({ retireLeaseMs: 40 });
    await w.call("session/load", { path: PATH });
    expect(await w.retire()).toEqual({ retiring: true });
    const refusedNow = await w.call("pi/session/entries", { path: PATH });
    expect(refusedNow.error?.code).toBe(ErrorCodes.DriverUnavailable);

    await new Promise((resolve) => setTimeout(resolve, 80));

    // The lease expired: this is a working worker again, with its conversation.
    expect(await w.call("pi/session/entries", { path: PATH })).toHaveProperty("result");
    expect(w.server.openSessions()).toEqual([PATH]);
    expect(w.drivers[0]!.disposed).toBe(false);
    // And it can be asked again, from scratch.
    expect(await w.retire()).toEqual({ retiring: true });
  });

  it("refuses an explicit stop on work in flight, exactly as the sweep does", async () => {
    const w = world();
    await w.call("session/load", { path: PATH });
    w.drivers[0]!.patch({ isStreaming: true });
    expect(await w.retire("explicit")).toMatchObject({ retiring: false, reason: "pinned" });
    expect(await w.retire("automatic")).toMatchObject({ retiring: false, reason: "pinned" });
  });
});
