/**
 * M13-T43 · a session is named from its first prompt when the prompt goes in,
 * not when its turn ends. The driver's `prompt()` resolves only when the whole
 * turn is over, so a fake whose prompt never resolves is the honest way to say
 * "a turn that takes minutes": everything below happens while it is pending.
 */
import { PRODUCT_NAME, type JsonRpcMessage, type SessionState } from "@lasercode/protocol";
import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { fallbackSnapshot } from "../../src/agents/definitions.js";
import type { NamerModelRuntime } from "../../src/agents/namer.js";
import type { DriverEvent, DriverListener, DriverOpenOptions, PromptOptions, SessionDriver } from "../../src/driver.js";
import { WorkerServer } from "../../src/server.js";

let base: string;
let counter = 0;

/** A driver whose turn never ends: `prompt()` records the call and stays pending. */
class LongTurnDriver implements SessionDriver {
  readonly kind = "stable-sdk" as const;
  prompted: Array<{ text: string; streamingBehavior?: string }> = [];
  private readonly listeners = new Set<DriverListener>();
  private st: SessionState = { path: "", id: "", cwd: "", model: null, thinkingLevel: "medium", isStreaming: false, isCompacting: false, steeringMode: "one-at-a-time", followUpMode: "one-at-a-time", autoCompactionEnabled: true, messageCount: 0, pendingMessageCount: 0 };
  async open(o: DriverOpenOptions) {
    counter += 1;
    this.st = { ...this.st, path: o.sessionPath ?? join(base, "sessions", `s${counter}.jsonl`), id: `id-${counter}`, cwd: o.cwd };
    return this.st;
  }
  state() { return this.st; }
  /** What the engine does while a turn runs; `prompt()` flips it itself. */
  streaming(on: boolean) { this.st = { ...this.st, isStreaming: on }; }
  subscribe(l: DriverListener) { this.listeners.add(l); return () => this.listeners.delete(l); }
  emit(e: DriverEvent) { for (const l of this.listeners) l(e); }
  prompt(content: Array<{ type: string; text?: string }>, options?: PromptOptions) {
    this.prompted.push({ text: content.map((b) => b.text ?? "").join(""), ...(options?.streamingBehavior ? { streamingBehavior: options.streamingBehavior } : {}) });
    options?.onAccepted?.();
    if (!options?.streamingBehavior) this.streaming(true);
    return new Promise<{ accepted: boolean; queued: boolean }>(() => {});
  }
  async steer() {} async followUp() {}
  async clearQueue() { return { steering: [], followUp: [] }; }
  async abort() {}
  async listModels() { return []; }
  async setModel() { return this.st; }
  async setThinkingLevel() { return this.st; }
  async rename(name: string) { this.st = { ...this.st, name }; }
  async compact() {}
  async navigateTree() { return { cancelled: false }; }
  async fork() { return { state: this.st }; }
  respondToUi() {}
  async commands() { return []; }
  async prompts() { return []; }
  async entries() { return []; }
  async appendEntry() { return "e"; }
  async dispose() { this.emit({ type: "closed", reason: "disposed" }); }
}

function fakeNamerRuntime(answer: () => string): NamerModelRuntime & { calls: number } {
  const runtime = {
    calls: 0,
    getModel: (provider: string, id: string) => ({ provider, id }),
    async completeSimple() {
      runtime.calls += 1;
      return { content: [{ type: "text", text: answer() }] };
    },
  };
  return runtime;
}

function namedSnapshot() {
  const snapshot = fallbackSnapshot();
  return { ...snapshot, namer: { ...snapshot.namer, status: "ready" as const, model: { provider: "stub", id: "stub-1" } } };
}

const tick = () => new Promise<void>((resolve) => setTimeout(resolve, 0));

function harness(runtime: NamerModelRuntime) {
  const out: JsonRpcMessage[] = [];
  const drivers: LongTurnDriver[] = [];
  const server = new WorkerServer({
    cwd: join(base, "project"),
    agentDir: join(base, "agent"),
    sessionDir: join(base, "sessions"),
    stateDir: join(base, "state"),
    createDriver: () => { const d = new LongTurnDriver(); drivers.push(d); return d; },
    send: (m) => out.push(m),
    namerModels: async () => runtime,
  });
  const call = async (id: number, method: string, params?: unknown) => {
    await server.handle({ jsonrpc: "2.0", id, method, params });
    return out.find((m) => "id" in m && m.id === id) as { result?: unknown; error?: { code: number; message: string } };
  };
  /** A prompt whose turn does not end: the request stays open, like the turn. */
  const prompt = (id: number, path: string, text: string, streamingBehavior?: "steer" | "followUp") => {
    void server.handle({ jsonrpc: "2.0", id, method: "session/prompt", params: { path, content: [{ type: "text", text }], ...(streamingBehavior ? { streamingBehavior } : {}) } });
  };
  const open = async (id: number) => {
    const created = await call(id, "session/new", { cwd: join(base, "project") });
    return (created.result as { state: SessionState }).state.path;
  };
  return { server, drivers, call, prompt, open };
}

beforeEach(() => {
  base = mkdtempSync(join(tmpdir(), `${PRODUCT_NAME}-naming-`));
  for (const dir of ["project", "agent", "sessions", "state"]) mkdirSync(join(base, dir), { recursive: true });
});
afterEach(() => {
  rmSync(base, { recursive: true, force: true });
});

describe("naming a session at the start of its first turn", () => {
  it("names the session while the first turn is still running", async () => {
    const runtime = fakeNamerRuntime(() => "Fix the login form");
    const h = harness(runtime);
    await h.call(1, "agents/sync", { snapshot: namedSnapshot() });
    const path = await h.open(2);
    h.prompt(3, path, "please fix the login form");
    await tick();
    const driver = h.drivers[0]!;
    // The turn has not ended — the driver is still inside `prompt()` — and
    // the name is already there.
    expect(driver.prompted).toEqual([{ text: "please fix the login form" }]);
    expect(driver.state().isStreaming).toBe(true);
    expect(driver.state().name).toBe("Fix the login form");
    expect(runtime.calls).toBe(1);
  });

  it("does not name an empty prompt, and never renames a session that has a name", async () => {
    const runtime = fakeNamerRuntime(() => "Anything");
    const h = harness(runtime);
    await h.call(1, "agents/sync", { snapshot: namedSnapshot() });
    const path = await h.open(2);
    h.prompt(3, path, "   ");
    await tick();
    expect(runtime.calls).toBe(0);
    expect(h.drivers[0]!.state().name).toBeUndefined();
    // The person (or the harness, for a child) got there first.
    await h.call(4, "pi/session/rename", { path, name: "Mine" });
    h.drivers[0]!.streaming(false);
    h.prompt(5, path, "now do the thing");
    await tick();
    expect(runtime.calls).toBe(0);
    expect(h.drivers[0]!.state().name).toBe("Mine");
  });

  it("judges acceptance up front: refused while busy, named when queued behind the turn", async () => {
    const runtime = fakeNamerRuntime(() => "Second thoughts");
    const h = harness(runtime);
    await h.call(1, "agents/sync", { snapshot: namedSnapshot() });
    const path = await h.open(2);
    const driver = h.drivers[0]!;
    driver.streaming(true);
    // Busy and not asked to queue: the driver would answer `accepted: false`,
    // so nothing is named.
    h.prompt(3, path, "are you there");
    await tick();
    expect(runtime.calls).toBe(0);
    expect(driver.state().name).toBeUndefined();
    // Queued on request: that goes in, so it names.
    h.prompt(4, path, "and then run the tests", "followUp");
    await tick();
    expect(driver.prompted.at(-1)).toEqual({ text: "and then run the tests", streamingBehavior: "followUp" });
    expect(driver.state().name).toBe("Second thoughts");
  });

  it("holds a first prompt sent before Namer had a model, and names it once when one arrives", async () => {
    const runtime = fakeNamerRuntime(() => "Explore the repo");
    const h = harness(runtime);
    const path = await h.open(1);
    h.prompt(2, path, "explore the repo");
    await tick();
    expect(runtime.calls).toBe(0);
    expect(h.drivers[0]!.state().name).toBeUndefined();
    // The model lands while the turn is still running.
    await h.call(3, "agents/sync", { snapshot: namedSnapshot() });
    await tick();
    expect(h.drivers[0]!.state().name).toBe("Explore the repo");
    expect(runtime.calls).toBe(1);
    await h.call(4, "agents/sync", { snapshot: namedSnapshot() });
    await tick();
    expect(runtime.calls).toBe(1);
  });

  it("lets a person who renames mid-turn win over a slow Namer", async () => {
    let answer: (name: string) => void = () => {};
    const runtime: NamerModelRuntime & { calls: number } = {
      calls: 0,
      getModel: (provider: string, id: string) => ({ provider, id }),
      async completeSimple() {
        runtime.calls += 1;
        return { content: [{ type: "text", text: await new Promise<string>((resolve) => (answer = resolve)) }] };
      },
    };
    const h = harness(runtime);
    await h.call(1, "agents/sync", { snapshot: namedSnapshot() });
    const path = await h.open(2);
    h.prompt(3, path, "rename the auth module");
    await tick();
    expect(runtime.calls).toBe(1);
    await h.call(4, "pi/session/rename", { path, name: "Auth cleanup" });
    answer("Rename auth module");
    await tick();
    expect(h.drivers[0]!.state().name).toBe("Auth cleanup");
  });
});
