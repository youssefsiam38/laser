/**
 * M13-T3 · WorkerServer with a fake driver: agent-aware `session/new` and
 * `session/load`, the agent info on every state a client sees, user-origin
 * runs from `session/prompt`, `agents/sync`, `agents/runs/stop`, and the
 * ending a run on the person's behalf.
 */
import { PRODUCT_NAME, SESSION_AGENT_ENTRY_TYPE, type AgentRun, type JsonRpcMessage, type SessionState, type UiDialogResponse } from "@lasercode/protocol";
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { fallbackSnapshot } from "../../src/agents/definitions.js";
import type { NamerModelRuntime } from "../../src/agents/namer.js";
import type { DriverEvent, DriverListener, DriverOpenOptions, SessionDriver } from "../../src/driver.js";
import { WorkerServer } from "../../src/server.js";

let base: string;
let counter = 0;

class FakeDriver implements SessionDriver {
  readonly kind = "stable-sdk" as const;
  opened!: DriverOpenOptions;
  prompted: string[] = [];
  aborts = 0;
  custom: Array<{ type: string; data: unknown }> = [];
  private readonly listeners = new Set<DriverListener>();
  private st: SessionState = { path: "", id: "", cwd: "", model: null, thinkingLevel: "medium", isStreaming: false, isCompacting: false, steeringMode: "one-at-a-time", followUpMode: "one-at-a-time", autoCompactionEnabled: true, messageCount: 0, pendingMessageCount: 0 };
  async open(o: DriverOpenOptions) {
    this.opened = o;
    counter += 1;
    const path = o.sessionPath ?? join(base, "sessions", `s${counter}.jsonl`);
    this.st = { ...this.st, path, id: `id-${counter}`, cwd: o.cwd };
    return this.st;
  }
  state() { return this.st; }
  subscribe(l: DriverListener) { this.listeners.add(l); return () => this.listeners.delete(l); }
  emit(e: DriverEvent) { for (const l of this.listeners) l(e); }
  async prompt(content: Array<{ type: string; text?: string }>) { this.prompted.push(content.map((b) => b.text ?? "").join("")); return { accepted: true, queued: false }; }
  async steer() {} async followUp() {}
  async clearQueue() { return { steering: [], followUp: [] }; }
  async abort() { this.aborts += 1; }
  async listModels() { return []; }
  async setModel() { return this.st; }
  async setThinkingLevel() { return this.st; }
  async rename(name: string) { this.st = { ...this.st, name }; }
  async compact() {}
  async navigateTree() { return { cancelled: false }; }
  async fork(entryId: string) { this.st = { ...this.st, path: join(base, "sessions", `fork-${entryId}.jsonl`) }; return { state: this.st }; }
  respondToUi(_r: UiDialogResponse) {}
  async commands() { return []; }
  async prompts() { return []; }
  async entries() { return []; }
  async appendEntry(type: string, data: unknown) { this.custom.push({ type, data }); return "e"; }
  async dispose() { this.emit({ type: "closed", reason: "disposed" }); }
}

/** A model runtime for Namer that never touches the engine; `calls` counts completions. */
function fakeNamerRuntime(answer: () => string | Promise<string>): NamerModelRuntime & { calls: number } {
  const runtime = {
    calls: 0,
    getModel: (provider: string, id: string) => ({ provider, id }),
    async completeSimple() {
      runtime.calls += 1;
      return { content: [{ type: "text", text: await answer() }] };
    },
  };
  return runtime;
}

/** The snapshot a host sends once Namer has a model. */
function namedSnapshot() {
  const snapshot = fallbackSnapshot();
  return { ...snapshot, namer: { ...snapshot.namer, status: "ready" as const, model: { provider: "stub", id: "stub-1" } } };
}

/** Let every floated naming/labelling promise settle. */
const tick = () => new Promise<void>((resolve) => setTimeout(resolve, 0));

function harness(options: { namerModels?: () => Promise<NamerModelRuntime> } = {}) {
  const out: JsonRpcMessage[] = [];
  const drivers: FakeDriver[] = [];
  const server = new WorkerServer({
    cwd: join(base, "project"),
    agentDir: join(base, "agent"),
    sessionDir: join(base, "sessions"),
    stateDir: join(base, "state"),
    createDriver: () => { const d = new FakeDriver(); drivers.push(d); return d; },
    send: (m) => out.push(m),
    ...(options.namerModels ? { namerModels: options.namerModels } : {}),
  });
  const call = async (id: number, method: string, params?: unknown) => {
    await server.handle({ jsonrpc: "2.0", id, method, params });
    return out.find((m) => "id" in m && m.id === id) as { result?: unknown; error?: { code: number; message: string } };
  };
  const notifications = (method: string) => out.filter((m) => "method" in m && !("id" in m) && m.method === method) as Array<{ params: never }>;
  return { server, out, drivers, call, notifications };
}

beforeEach(() => {
  base = mkdtempSync(join(tmpdir(), `${PRODUCT_NAME}-server-agents-`));
  for (const dir of ["project", "agent", "sessions", "state"]) mkdirSync(join(base, dir), { recursive: true });
});
afterEach(() => {
  rmSync(base, { recursive: true, force: true });
});

describe("WorkerServer agents", () => {
  it("opens a new session as the default agent and reports it on the state", async () => {
    const h = harness();
    const created = await h.call(1, "session/new", { cwd: join(base, "project") });
    expect(created.result).toMatchObject({ state: { agent: { agentName: "default", kind: "root" } } });
    const opened = h.drivers[0]!.opened;
    expect(opened.agent).toMatchObject({ definition: { name: "default", engineInstructions: true }, role: { agentName: "default", kind: "root", depth: 0 }, record: { agentName: "default", kind: "root" }, policy: { maxDepth: 3 } });
    expect(opened.agent?.bridge).toBeDefined();
    expect(opened.agent?.backgroundWork).toEqual({ cwd: join(base, "project"), foregroundCommandSeconds: 120 });
    // The Beam skill was written on construction.
    expect(existsSync(join(base, "agent", "skills", `${PRODUCT_NAME}-beam`, "SKILL.md"))).toBe(true);
  });

  it("opens Beam and Chat with their built-in roles, refuses Namer and unknown names", async () => {
    const h = harness();
    const beam = await h.call(1, "session/new", { cwd: join(base, "project"), agentName: "beam" });
    expect(beam.result).toMatchObject({ state: { agent: { agentName: "beam", kind: "beam" } } });
    expect(h.drivers[0]!.opened.agent?.definition.scopedSkills).toBe(true);
    const chat = await h.call(2, "session/new", { cwd: join(base, "project"), agentName: "chat" });
    expect(chat.result).toMatchObject({ state: { agent: { agentName: "chat", kind: "chat" } } });
    expect((await h.call(3, "session/new", { cwd: join(base, "project"), agentName: "namer" })).error?.message).toMatch(/Namer names things/);
    expect((await h.call(4, "session/new", { cwd: join(base, "project"), agentName: "nobody" })).error?.message).toMatch(/No agent is called "nobody"/);
  });

  it("uses the synced default agent and definitions", async () => {
    const h = harness();
    const snapshot = fallbackSnapshot();
    const lead = { ...snapshot.agents[0]!, name: "lead", instructions: "Lead.", engineInstructions: false };
    expect((await h.call(1, "agents/sync", { snapshot: { ...snapshot, revision: 3, agents: [...snapshot.agents, lead], defaultAgent: "lead" } })).result).toEqual({});
    const created = await h.call(2, "session/new", { cwd: join(base, "project") });
    expect(created.result).toMatchObject({ state: { agent: { agentName: "lead", kind: "root" } } });
    expect(h.drivers[0]!.opened.agent?.definition.instructions).toBe("Lead.");
  });

  it("recovers a stored child session's agent from its record and decorates state updates", async () => {
    const h = harness();
    const parentPath = join(base, "sessions", "parent.jsonl");
    const childPath = join(base, "sessions", "child.jsonl");
    writeFileSync(parentPath, `${JSON.stringify({ type: "session", id: "p" })}\n${JSON.stringify({ type: "custom", customType: SESSION_AGENT_ENTRY_TYPE, data: { agentName: "default", kind: "root" } })}\n`);
    writeFileSync(childPath, `${JSON.stringify({ type: "session", id: "c" })}\n${JSON.stringify({ type: "custom", customType: SESSION_AGENT_ENTRY_TYPE, data: { agentName: "default", kind: "child", subagentName: "fixer", parentPath, parentSessionId: "p", rootPath: parentPath, runId: "run_old", worktree: { path: "/w", branch: "agents/fixer", baseCommit: "abc" } } })}\n`);
    const loaded = await h.call(1, "session/load", { path: childPath });
    expect(loaded.result).toMatchObject({ state: { agent: { agentName: "default", kind: "child", subagentName: "fixer", parentPath, rootPath: parentPath } } });
    const state = (loaded.result as { state: SessionState }).state;
    expect(state.agent?.runId).toBeUndefined(); // idle: no live run after a reload
    expect(h.drivers[0]!.opened.agent?.role).toMatchObject({ kind: "child", depth: 1, subagentName: "fixer", parent: { sessionPath: parentPath, sessionId: "p", agentName: "default" } });
    // A person's prompt on the idle child starts a user-origin run; the parent is told when it ends.
    await h.call(2, "session/prompt", { path: childPath, content: [{ type: "text", text: "what changed?" }] });
    const runs = h.notifications("agents/run").map((n) => (n.params as { run: AgentRun }).run);
    expect(runs.at(-1)).toMatchObject({ origin: "user", status: "running", sessionPath: childPath, parent: { sessionPath: parentPath, sessionId: "p" }, task: "what changed?" });
    // State updates carry the agent info, including the live run.
    h.drivers[0]!.emit({ type: "update", update: { kind: "state", state: h.drivers[0]!.state() } });
    const update = h.notifications("session/update").map((n) => n.params as { update: { kind: string; state?: SessionState } }).find((u) => u.update.kind === "state")!;
    expect(update.update.state?.agent).toMatchObject({ kind: "child", runId: runs.at(-1)!.runId, runStatus: "running" });
    // A second prompt while the run is active starts no second run.
    await h.call(3, "session/prompt", { path: childPath, content: [{ type: "text", text: "more" }] });
    expect(h.notifications("agents/run").filter((n) => (n.params as { run: AgentRun }).run.status === "running")).toHaveLength(1);
    // A person ends the run.
    const runId = runs.at(-1)!.runId;
    const stopped = await h.call(4, "agents/runs/stop", { runId, reason: "enough" });
    expect(stopped.result).toMatchObject({ run: { runId, status: "cancelled", endedBy: { initiator: "user", reason: "enough" } } });
    expect(h.drivers[0]!.aborts).toBe(1);
    expect((await h.call(5, "agents/runs/stop", { runId: "run_unknown" })).error?.message).toMatch(/No run is called run_unknown/);
    // The run is published once, as itself; nothing publishes it a second time.
    expect(h.notifications("agents/run").map((n) => (n.params as { run: AgentRun }).run).at(-1)).toMatchObject({ runId, status: "cancelled" });
    expect(h.notifications("pi/extension/message").some((n) => String((n.params as { message: { type: string } }).message.type).startsWith("lasercode/panel"))).toBe(false);
  });

  it("falls back to the default agent for a session written before agents existed", async () => {
    const h = harness();
    const path = join(base, "sessions", "old.jsonl");
    writeFileSync(path, `${JSON.stringify({ type: "session", id: "o" })}\n${JSON.stringify({ type: "message", message: { role: "user", content: "hi" } })}\n`);
    const loaded = await h.call(1, "session/load", { path });
    expect(loaded.result).toMatchObject({ state: { agent: { agentName: "default", kind: "root" } } });
    expect(h.drivers[0]!.opened.sessionPath).toBe(path);
  });

  it("lists skills for the project and serves the engine's instructions", async () => {
    const h = harness();
    const skills = (await h.call(1, "agents/skills", { cwd: join(base, "project") })).result as { skills: unknown[]; roots: Array<{ scope: string }> };
    expect(skills.roots.map((r) => r.scope)).toEqual(["global", "global", "project", "project"]);
    // The Beam skill is written but never listed; whatever else this machine has is scoped.
    expect(skills.skills.map((s) => (s as { name: string }).name)).not.toContain(`${PRODUCT_NAME}-beam`);
    for (const skill of skills.skills as Array<{ scope: string }>) expect(["global", "project"]).toContain(skill.scope);
    const instructions = (await h.call(2, "agents/engine-instructions", { cwd: join(base, "project") })).result as { text: string };
    expect(instructions.text).toContain("Available tools:");
    expect((await h.call(3, "agents/list", {})).error?.message).toMatch(/answered by the host/);
  });

  it("names a session whose first prompt arrived before Namer had a model", async () => {
    const runtime = fakeNamerRuntime(() => "Fix the login form");
    const h = harness({ namerModels: async () => runtime });
    const created = await h.call(1, "session/new", { cwd: join(base, "project") });
    const path = (created.result as { state: SessionState }).state.path;
    // The host's `agents/sync` has not landed (and qualification may still be
    // running), so there is no model: the prompt is held, not dropped.
    await h.call(2, "session/prompt", { path, content: [{ type: "text", text: "please fix the login form" }] });
    await tick();
    expect(h.drivers[0]!.state().name).toBeUndefined();
    expect(runtime.calls).toBe(0);
    // The model arrives: the waiting session is named from that first prompt.
    await h.call(3, "agents/sync", { snapshot: namedSnapshot() });
    await tick();
    expect(h.drivers[0]!.state().name).toBe("Fix the login form");
    expect(runtime.calls).toBe(1);
    // A later sync names nothing again: the prompt was consumed and the
    // session now has a name.
    await h.call(4, "agents/sync", { snapshot: namedSnapshot() });
    await tick();
    expect(runtime.calls).toBe(1);
  });

  it("names on the first prompt once a model is there, and leaves a named session alone", async () => {
    const runtime = fakeNamerRuntime(() => '"Rename the auth module."');
    const h = harness({ namerModels: async () => runtime });
    await h.call(1, "agents/sync", { snapshot: namedSnapshot() });
    const created = await h.call(2, "session/new", { cwd: join(base, "project") });
    const path = (created.result as { state: SessionState }).state.path;
    await h.call(3, "session/prompt", { path, content: [{ type: "text", text: "rename the auth module please" }] });
    await tick();
    expect(h.drivers[0]!.state().name).toBe("Rename the auth module");
    // A session that already has a name — the person's, or the harness's
    // `subagent_name` — is never renamed by a later prompt.
    await h.call(4, "session/prompt", { path, content: [{ type: "text", text: "and the tests" }] });
    await tick();
    expect(runtime.calls).toBe(1);
  });

  it("labels a burst of tool calls and drops a label whose call already ended", async () => {
    const pending: Array<(value: string) => void> = [];
    const runtime = fakeNamerRuntime(() => new Promise<string>((resolve) => pending.push(resolve)));
    const h = harness({ namerModels: async () => runtime });
    await h.call(1, "agents/sync", { snapshot: namedSnapshot() });
    const created = await h.call(2, "session/new", { cwd: join(base, "project") });
    const path = (created.result as { state: SessionState }).state.path;
    const driver = h.drivers[0]!;
    for (const toolCallId of ["t1", "t2", "t3"]) {
      driver.emit({ type: "update", update: { kind: "tool_execution_start", toolCallId, toolName: "bash", args: { command: "ls" } } });
    }
    await tick();
    expect(pending).toHaveLength(3);
    // t2 ends while its label is still being written: nobody would see it.
    driver.emit({ type: "update", update: { kind: "tool_execution_end", toolCallId: "t2", result: {}, isError: false } });
    pending[0]!("searching auth handlers");
    pending[1]!("reading the build config");
    pending[2]!("listing files");
    await tick();
    const labels = h.notifications("pi/extension/message")
      .map((n) => n.params as { path: string; message: { type: string; toolCallId?: string; label?: string } })
      .filter((n) => n.message.type === "lasercode/namer/label");
    expect(labels.map((l) => `${l.message.toolCallId}:${l.message.label}`)).toEqual(["t1:Searching auth handlers", "t3:Listing files"]);
    expect(labels.every((l) => l.path === path)).toBe(true);
    // The same call is never labelled twice, however often the event repeats.
    driver.emit({ type: "update", update: { kind: "tool_execution_start", toolCallId: "t1", toolName: "bash", args: { command: "ls" } } });
    await tick();
    expect(pending).toHaveLength(3);
  });

  it("labels nothing while Namer has no model", async () => {
    const runtime = fakeNamerRuntime(() => "listing files");
    const h = harness({ namerModels: async () => runtime });
    await h.call(1, "session/new", { cwd: join(base, "project") });
    h.drivers[0]!.emit({ type: "update", update: { kind: "tool_execution_start", toolCallId: "t1", toolName: "bash", args: { command: "ls" } } });
    await tick();
    expect(runtime.calls).toBe(0);
    expect(h.notifications("pi/extension/message").filter((n) => (n.params as { message: { type: string } }).message.type === "lasercode/namer/label")).toHaveLength(0);
  });

  it("follows a fork to the new path", async () => {
    const h = harness();
    const created = await h.call(1, "session/new", { cwd: join(base, "project") });
    const path = (created.result as { state: SessionState }).state.path;
    const forked = await h.call(2, "pi/session/fork", { path, entryId: "e1" });
    const newPath = (forked.result as { state: SessionState }).state.path;
    expect(newPath).not.toBe(path);
    expect(forked.result).toMatchObject({ state: { agent: { agentName: "default", kind: "root" } } });
    expect(h.server.agents().sessionInfo(newPath)).toBeDefined();
    expect(h.server.agents().sessionInfo(path)).toBeUndefined();
  });
});
