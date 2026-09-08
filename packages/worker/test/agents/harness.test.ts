/**
 * M13-T3 · the harness lifecycle with a fake host: start → running →
 * complete through the bridge; blocked; stops by a person and by the parent;
 * timeout; failure on close; settle-without-completion; waiting; follow-up
 * messages; nesting and allow-list refusals; run notifications; the run panel.
 */
import { AGENT_RUN_TIMEOUT_DEFAULT_MINUTES, SESSION_RUN_ENTRY_TYPE, validatePanelEvent, type AgentDefinition, type AgentRun, type AgentsSnapshot, type ContentBlock, type SessionState, type UiDialogResponse } from "@lasercode/protocol";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { DriverAgentOptions, DriverEvent, DriverListener, PromptOptions, SessionDriver } from "../../src/driver.js";
import type { AgentModelEvent, HarnessSessionRole } from "../../src/agents/bridge.js";
import { DefinitionsCache, fallbackDefaultAgent, fallbackSnapshot } from "../../src/agents/definitions.js";
import { AgentHarness, NUDGE_TEXT, runPanel, runPanelId, type SessionHost, type WorktreeProvider } from "../../src/agents/harness.js";
import { HarnessError } from "../../src/agents/errors.js";
import { rootRecord, rootRole } from "../../src/agents/session-config.js";
import type { CreateWorktreeInput, Worktree } from "../../src/agents/worktrees.js";

class FakeDriver implements SessionDriver {
  readonly kind = "stable-sdk" as const;
  prompted: Array<{ text: string; options?: PromptOptions }> = [];
  steers: string[] = [];
  followUps: string[] = [];
  custom: Array<{ type: string; data: unknown }> = [];
  aborts = 0;
  names: string[] = [];
  goal: { id: string; objective: string } | null = null;
  lastText: string | undefined;
  acceptPrompts = true;
  private readonly listeners = new Set<DriverListener>();
  constructor(private st: SessionState) {}
  async open() { return this.st; }
  state() { return this.st; }
  setStreaming(value: boolean) { this.st = { ...this.st, isStreaming: value }; }
  subscribe(l: DriverListener) { this.listeners.add(l); return () => this.listeners.delete(l); }
  emit(e: DriverEvent) { for (const l of this.listeners) l(e); }
  async prompt(content: ContentBlock[], options?: PromptOptions) {
    const text = content.map((b) => (b.type === "text" ? b.text : "")).join("");
    this.prompted.push({ text, ...(options ? { options } : {}) });
    return { accepted: this.acceptPrompts, queued: false };
  }
  async steer(content: ContentBlock[]) { this.steers.push(content.map((b) => (b.type === "text" ? b.text : "")).join("")); }
  async followUp(content: ContentBlock[]) { this.followUps.push(content.map((b) => (b.type === "text" ? b.text : "")).join("")); }
  async clearQueue() { return { steering: [], followUp: [] }; }
  async abort() { this.aborts += 1; }
  async listModels() { return []; }
  async setModel() { return this.st; }
  async setThinkingLevel() { return this.st; }
  async rename(name: string) { this.names.push(name); this.st = { ...this.st, name }; }
  async compact() {}
  async navigateTree() { return { cancelled: false }; }
  async fork() { return { state: this.st }; }
  respondToUi(_r: UiDialogResponse) {}
  async commands() { return []; }
  async prompts() { return []; }
  async entries() { return []; }
  async goalState() { return this.goal ? { id: this.goal.id, objective: this.goal.objective, status: "active" as const, startedAt: 0, updatedAt: 0, iteration: 0, automaticTurns: 0 } : null; }
  async appendEntry(type: string, data: unknown) { this.custom.push({ type, data }); return `e${this.custom.length}`; }
  lastAssistantText() { return this.lastText; }
  async dispose() {}
}
function stateFor(path: string, id: string, cwd: string): SessionState {
  return { path, id, cwd, model: { provider: "stub", id: "stub-1" }, thinkingLevel: "medium", isStreaming: false, isCompacting: false, steeringMode: "one-at-a-time", followUpMode: "one-at-a-time", autoCompactionEnabled: true, messageCount: 0, pendingMessageCount: 0 };
}

interface Notification { method: string; params: unknown }

function definition(name: string, partial: Partial<AgentDefinition> = {}): AgentDefinition {
  return { ...fallbackDefaultAgent(), name, description: `${name} agent`, engineInstructions: false, instructions: `You are ${name}.`, supportsSubagents: false, allowedAgents: [], ...partial };
}

function snapshotWith(agents: AgentDefinition[], maxDepth = 3): AgentsSnapshot {
  const base = fallbackSnapshot();
  return { ...base, revision: 1, agents: [...agents, ...base.agents.filter((a) => a.kind === "builtin")], policy: { ...base.policy, maxDepth } };
}

function makeWorld() {
  const drivers = new Map<string, FakeDriver>();
  const notifications: Notification[] = [];
  const opened: Array<{ cwd: string; parentSessionPath: string; agent: DriverAgentOptions }> = [];
  let childCount = 0;
  let unavailable = false;
  let failOpen = false;
  const worktrees: WorktreeProvider & { created: CreateWorktreeInput[]; removed: string[] } = {
    created: [],
    removed: [],
    async create(input) {
      this.created.push(input);
      const path = `/repo/.worktrees/${input.subagentName}-${input.runId.slice(4)}`;
      const worktree: Worktree = { path, branch: `agents/${input.subagentName}`, baseCommit: "abc123", cwd: path, root: "/repo" };
      return worktree;
    },
    async remove(_root, path) { this.removed.push(path); },
    ownedBy: () => undefined,
  };
  const host: SessionHost = {
    async openChild(open) {
      if (failOpen) throw new Error("engine refused");
      childCount += 1;
      const path = `/sessions/child-${childCount}.jsonl`;
      const driver = new FakeDriver(stateFor(path, `child-${childCount}`, open.cwd));
      drivers.set(path, driver);
      opened.push(open);
      return driver.state();
    },
    driver: (path) => drivers.get(path),
    notify: (method, params) => notifications.push({ method, params }),
    modelAvailable: async () => !unavailable,
  };
  const definitions = new DefinitionsCache();
  const harness = new AgentHarness({ host, definitions, worktrees, backgroundWork: (cwd) => ({ cwd, foregroundCommandSeconds: 120 }), now: () => Date.now() });
  const openRoot = (name = "default", path = "/sessions/root.jsonl", id = "root-1") => {
    const def = definitions.definition(name)!;
    const handle = harness.prepareSession({ role: rootRole(name), definition: def, record: rootRecord(name), projectCwd: "/repo" });
    const driver = new FakeDriver(stateFor(path, id, "/repo"));
    drivers.set(path, driver);
    handle.attach(path, id);
    return { handle, driver, path, id };
  };
  const runsNotified = () => notifications.filter((n) => n.method === "agents/run").map((n) => (n.params as { run: AgentRun }).run);
  const events = () => notifications.filter((n) => n.method === "agents/event").map((n) => n.params as { kind: string; sessionPath: string; runId?: string; summary: string });
  const panels = () => notifications.filter((n) => n.method === "pi/extension/message").map((n) => n.params as { path: string; message: { type: string; panel?: unknown; id?: string } });
  return {
    harness, definitions, drivers, notifications, opened, worktrees, openRoot, runsNotified, events, panels,
    setUnavailable: (value: boolean) => { unavailable = value; },
    setFailOpen: (value: boolean) => { failOpen = value; },
  };
}

const PARENT = definition("lead", { supportsSubagents: true, allowedAgents: ["worker", "reviewer"] });
const WORKER = definition("worker", { supportsSubagents: true, allowedAgents: ["worker"] });
const REVIEWER = definition("reviewer", { model: { provider: "stub", id: "stub-1" }, runTimeoutMinutes: 5 });

describe("AgentHarness", () => {
  let world: ReturnType<typeof makeWorld>;
  beforeEach(() => {
    world = makeWorld();
    world.definitions.sync(snapshotWith([PARENT, WORKER, REVIEWER]));
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  it("offers only allowed, startable agents and refuses the rest", async () => {
    const root = world.openRoot("lead");
    expect(root.handle.bridge.catalog()).toEqual([
      { agentName: "worker", description: "worker agent" },
      { agentName: "reviewer", description: "reviewer agent" },
    ]);
    expect(root.handle.bridge.canDelegate()).toBe(true);
    await expect(root.handle.bridge.startAgent({ agentName: "beam", subagentName: "x", task: "t" })).rejects.toThrow(/No agent is called "beam"/);
    await expect(root.handle.bridge.startAgent({ agentName: "ghost", subagentName: "x", task: "t" })).rejects.toThrow(/No agent is called "ghost"\. Available agents: worker, reviewer/);
    await expect(root.handle.bridge.startAgent({ agentName: "worker", subagentName: "", task: "t" })).rejects.toThrow(/subagent_name is required/);
    await expect(root.handle.bridge.startAgent({ agentName: "worker", subagentName: "x", task: "  " })).rejects.toThrow(/task is required/);
    // A definition that may not start anything.
    const plain = world.openRoot("reviewer", "/sessions/plain.jsonl", "plain-1");
    expect(plain.handle.bridge.canDelegate()).toBe(false);
    await expect(plain.handle.bridge.startAgent({ agentName: "worker", subagentName: "x", task: "t" })).rejects.toThrow(/reviewer may not start "worker"/);
    expect(world.opened).toHaveLength(0);
    expect(world.worktrees.created).toHaveLength(0);
  });

  it("refuses a model without a connected provider before touching a worktree", async () => {
    const root = world.openRoot("lead");
    world.setUnavailable(true);
    await expect(root.handle.bridge.startAgent({ agentName: "reviewer", subagentName: "review", task: "t" })).rejects.toThrow(/stub\/stub-1 is not available: connect stub in Settings → Providers and models/);
    expect(world.worktrees.created).toHaveLength(0);
  });

  it("starts a child in a worktree, returns identities at once, and completes through the bridge", async () => {
    const root = world.openRoot("lead");
    root.driver.goal = { id: "g1", objective: "Ship the login fix" };
    const received: AgentModelEvent[] = [];
    root.handle.bridge.onEvent((event) => received.push(event));

    const result = await root.handle.bridge.startAgent({ agentName: "worker", subagentName: "fix-login", task: "Fix the login form." });
    expect(result).toEqual({ agentName: "worker", subagentName: "fix-login", sessionId: "child-1", runId: expect.stringMatching(/^run_[0-9a-f]{8}$/), status: "running" });

    // The child session opened in the worktree with the child's definition and role.
    expect(world.worktrees.created[0]).toMatchObject({ projectCwd: "/repo", baseCwd: "/repo", subagentName: "fix-login", runId: result.runId });
    const open = world.opened[0]!;
    expect(open.cwd).toMatch(/^\/repo\/\.worktrees\/fix-login-/);
    expect(open.parentSessionPath).toBe(root.path);
    expect(open.agent.definition.name).toBe("worker");
    expect(open.agent.record).toMatchObject({ agentName: "worker", kind: "child", subagentName: "fix-login", parentPath: root.path, parentSessionId: "root-1", rootPath: root.path, runId: result.runId, worktree: { branch: "agents/fix-login", baseCommit: "abc123" } });
    const role: HarnessSessionRole = open.agent.role;
    expect(role).toMatchObject({ agentName: "worker", kind: "child", subagentName: "fix-login", depth: 1, parent: { sessionPath: root.path, sessionId: "root-1", agentName: "lead" }, runId: result.runId, goal: { id: "g1", objective: "Ship the login fix" }, task: "Fix the login form." });
    expect(open.agent.backgroundWork).toEqual({ cwd: open.cwd, foregroundCommandSeconds: 120 });

    // The task was prompted verbatim, without waiting, and the child was named.
    const child = world.drivers.get("/sessions/child-1.jsonl")!;
    expect(child.prompted).toEqual([{ text: "Fix the login form.", options: { expandPromptTemplates: false } }]);
    expect(child.names).toEqual(["fix-login"]);
    expect(child.custom[0]).toMatchObject({ type: SESSION_RUN_ENTRY_TYPE, data: { runId: result.runId, moment: "started", task: "Fix the login form." } });

    // Notifications: the run, and the two started/message_sent moments.
    const running = world.runsNotified().at(-1)!;
    expect(running).toMatchObject({ agentName: "worker", subagentName: "fix-login", sessionId: "child-1", runId: result.runId, sessionPath: "/sessions/child-1.jsonl", status: "running", origin: "agent", depth: 1, parent: { sessionPath: root.path, sessionId: "root-1" }, goal: { id: "g1" }, projectCwd: "/repo", rootSessionPath: root.path });
    expect(running.timeoutAt).toBeDefined();
    expect(world.events().map((e) => `${e.kind}@${e.sessionPath}`)).toEqual(["started@/sessions/child-1.jsonl", "message_sent@/sessions/root.jsonl"]);
    expect(world.harness.sessionInfo("/sessions/child-1.jsonl")).toEqual({ agentName: "worker", kind: "child", subagentName: "fix-login", parentPath: root.path, rootPath: root.path, runId: result.runId, runStatus: "running" });

    // The child completes through its own bridge.
    const childBridge = world.harness.bridgeOf("/sessions/child-1.jsonl")!;
    expect(childBridge.role().runId).toBe(result.runId);
    const done = await childBridge.completeRun({ status: "completed", message: "done: touched nothing" });
    expect(done).toEqual({ ok: true, runId: result.runId });
    expect(await childBridge.completeRun({ status: "completed", message: "again" })).toEqual({ ok: false, error: "This run already ended." });

    const finished = world.runsNotified().at(-1)!;
    expect(finished).toMatchObject({ runId: result.runId, status: "completed", result: { status: "completed", message: "done: touched nothing" } });
    expect(finished.endedAt).toBeDefined();
    expect(received).toHaveLength(1);
    expect(received[0]).toMatchObject({ type: "agent.completed", agentName: "worker", subagentName: "fix-login", sessionId: "child-1", runId: result.runId, message: "done: touched nothing", run: { status: "completed" } });
    expect(childBridge.role().runId).toBeUndefined();
    expect(child.custom.at(-1)).toMatchObject({ type: SESSION_RUN_ENTRY_TYPE, data: { moment: "completed", result: { message: "done: touched nothing" } } });
    expect(world.events().map((e) => e.kind)).toEqual(["started", "message_sent", "completed", "message_received"]);

    // A turn that starts after completion is aborted.
    world.harness.onDriverEvent("/sessions/child-1.jsonl", { type: "update", update: { kind: "turn_start" } });
    expect(child.aborts).toBe(1);

    // Summaries for the parent, newest first.
    expect(await root.handle.bridge.listAgents()).toEqual([expect.objectContaining({ runId: result.runId, status: "completed", result: { status: "completed", message: "done: touched nothing" } })]);
  });

  it("reports blocked the same way, with the child's message", async () => {
    const root = world.openRoot("lead");
    const received: AgentModelEvent[] = [];
    root.handle.bridge.onEvent((event) => received.push(event));
    const { runId } = await root.handle.bridge.startAgent({ agentName: "worker", subagentName: "w", task: "t" });
    const childBridge = world.harness.bridgeOf("/sessions/child-1.jsonl")!;
    expect(await childBridge.completeRun({ status: "blocked", message: "Need credentials for the staging database." })).toEqual({ ok: true, runId });
    expect(received[0]).toMatchObject({ type: "agent.blocked", message: "Need credentials for the staging database.", run: { status: "blocked" } });
    expect(await childBridge.completeRun({ status: "done" as "completed", message: "x" })).toEqual({ ok: false, error: "This run already ended." });
  });

  it("validates completion input while the run is active", async () => {
    const root = world.openRoot("lead");
    await root.handle.bridge.startAgent({ agentName: "worker", subagentName: "w", task: "t" });
    const childBridge = world.harness.bridgeOf("/sessions/child-1.jsonl")!;
    expect(await childBridge.completeRun({ status: "done" as "completed", message: "x" })).toEqual({ ok: false, error: 'status must be "completed" or "blocked".' });
    expect(await childBridge.completeRun({ status: "completed", message: " " })).toMatchObject({ ok: false, error: expect.stringMatching(/message is required/) });
    expect(world.harness.activeRun("/sessions/child-1.jsonl")?.status).toBe("running");
  });

  it("lets a person end a run with a reason the parent reads verbatim", async () => {
    const root = world.openRoot("lead");
    const received: AgentModelEvent[] = [];
    root.handle.bridge.onEvent((event) => received.push(event));
    const { runId } = await root.handle.bridge.startAgent({ agentName: "worker", subagentName: "w", task: "t" });
    const child = world.drivers.get("/sessions/child-1.jsonl")!;
    const run = await world.harness.stopRun(runId, { initiator: "user", reason: "wrong branch, start over" });
    expect(run).toMatchObject({ status: "cancelled", endedBy: { initiator: "user", reason: "wrong branch, start over" } });
    expect(child.aborts).toBe(1);
    expect(received[0]).toMatchObject({ type: "agent.cancelled", endedBy: { initiator: "user", reason: "wrong branch, start over" } });
    expect(received[0]!.message).toBe("The person ended this run. Reason: wrong branch, start over");
    expect(world.events().map((e) => e.kind)).toEqual(["started", "message_sent", "stop_requested", "cancelled", "message_received"]);
    // Idempotent, and a second stop from the panel changes nothing.
    expect(await world.harness.handlePanelAction(runPanelId(runId), "stop")).toBe(true);
    expect(world.runsNotified().filter((r) => r.status === "cancelled")).toHaveLength(1);
    // Without a reason the sentence stands alone.
    const second = await root.handle.bridge.startAgent({ agentName: "worker", subagentName: "w2", task: "t" });
    await world.harness.stopRun(second.runId, { initiator: "user" });
    expect(received[1]!.message).toBe("The person ended this run.");
  });

  it("lets the parent stop its own child, and only its own", async () => {
    const root = world.openRoot("lead");
    const other = world.openRoot("lead", "/sessions/other.jsonl", "other-1");
    const received: AgentModelEvent[] = [];
    root.handle.bridge.onEvent((event) => received.push(event));
    const { runId } = await root.handle.bridge.startAgent({ agentName: "worker", subagentName: "w", task: "t" });
    await expect(other.handle.bridge.stopAgent({ runId })).rejects.toThrow(/was started by this session/);
    const summary = await root.handle.bridge.stopAgent({ runId, reason: "no longer needed" });
    expect(summary).toMatchObject({ runId, status: "cancelled", endedBy: { initiator: "parent", reason: "no longer needed" } });
    expect(received[0]!.message).toBe("The parent ended this run. Reason: no longer needed");
  });

  it("times out a run, aborts the child and tells the parent", async () => {
    vi.useFakeTimers();
    world = makeWorld();
    world.definitions.sync(snapshotWith([PARENT, WORKER, REVIEWER]));
    const root = world.openRoot("lead");
    const received: AgentModelEvent[] = [];
    root.handle.bridge.onEvent((event) => received.push(event));
    const { runId } = await root.handle.bridge.startAgent({ agentName: "reviewer", subagentName: "r", task: "t" });
    const run = world.harness.run(runId)!;
    expect(new Date(run.timeoutAt!).getTime() - new Date(run.startedAt).getTime()).toBe(5 * 60_000);
    await vi.advanceTimersByTimeAsync(5 * 60_000 + 1);
    expect(world.harness.run(runId)).toMatchObject({ status: "timed_out", endedBy: { initiator: "harness" } });
    expect(world.drivers.get("/sessions/child-1.jsonl")!.aborts).toBe(1);
    expect(received[0]).toMatchObject({ type: "agent.timed_out", message: expect.stringMatching(/5-minute limit/) });
    // The default timeout applies when the definition sets none.
    const second = await root.handle.bridge.startAgent({ agentName: "worker", subagentName: "w", task: "t" });
    const secondRun = world.harness.run(second.runId)!;
    expect(new Date(secondRun.timeoutAt!).getTime() - new Date(secondRun.startedAt).getTime()).toBe(AGENT_RUN_TIMEOUT_DEFAULT_MINUTES * 60_000);
  });

  it("fails a run whose session closes", async () => {
    const root = world.openRoot("lead");
    const received: AgentModelEvent[] = [];
    root.handle.bridge.onEvent((event) => received.push(event));
    const { runId } = await root.handle.bridge.startAgent({ agentName: "worker", subagentName: "w", task: "t" });
    world.harness.onDriverEvent("/sessions/child-1.jsonl", { type: "closed", reason: "crash" });
    expect(world.harness.run(runId)).toMatchObject({ status: "failed", error: expect.stringMatching(/closed before it finished/) });
    expect(received[0]).toMatchObject({ type: "agent.failed" });
    expect(world.harness.sessionInfo("/sessions/child-1.jsonl")).toBeUndefined();
  });

  it("nudges a child that settles without the tool, then fails it with its last words", async () => {
    const root = world.openRoot("lead");
    const received: AgentModelEvent[] = [];
    root.handle.bridge.onEvent((event) => received.push(event));
    const { runId } = await root.handle.bridge.startAgent({ agentName: "worker", subagentName: "w", task: "t" });
    const path = "/sessions/child-1.jsonl";
    const child = world.drivers.get(path)!;
    world.harness.onDriverEvent(path, { type: "update", update: { kind: "message_end", role: "assistant", message: { role: "assistant", content: [{ type: "text", text: "I think I am done." }] } } });
    world.harness.onDriverEvent(path, { type: "update", update: { kind: "agent_settled" } });
    await Promise.resolve();
    expect(child.prompted.map((p) => p.text)).toEqual(["t", NUDGE_TEXT]);
    expect(world.harness.run(runId)!.status).toBe("running");
    child.lastText = "I think I am done.";
    world.harness.onDriverEvent(path, { type: "update", update: { kind: "agent_settled" } });
    expect(world.harness.run(runId)).toMatchObject({ status: "failed", error: "Ended without complete_agent_run" });
    expect(received[0]).toMatchObject({ type: "agent.failed" });
    expect(received[0]!.message).toContain("Ended without complete_agent_run");
    expect(received[0]!.message).toContain("I think I am done.");
  });

  it("does not nudge a child that completed through the tool before settling", async () => {
    const root = world.openRoot("lead");
    await root.handle.bridge.startAgent({ agentName: "worker", subagentName: "w", task: "t" });
    const path = "/sessions/child-1.jsonl";
    await world.harness.bridgeOf(path)!.completeRun({ status: "completed", message: "ok" });
    world.harness.onDriverEvent(path, { type: "update", update: { kind: "agent_settled" } });
    expect(world.drivers.get(path)!.prompted).toHaveLength(1);
  });

  it("fails a run whose model errored instead of nudging it", async () => {
    const root = world.openRoot("lead");
    const { runId } = await root.handle.bridge.startAgent({ agentName: "worker", subagentName: "w", task: "t" });
    const path = "/sessions/child-1.jsonl";
    world.harness.onDriverEvent(path, { type: "update", update: { kind: "message_end", role: "assistant", message: {}, stopReason: "error", errorMessage: "429 rate limited" } });
    world.harness.onDriverEvent(path, { type: "update", update: { kind: "agent_settled" } });
    expect(world.harness.run(runId)).toMatchObject({ status: "failed", error: "429 rate limited" });
  });

  it("waits for runs, resolves on completion and reports a timeout", async () => {
    vi.useFakeTimers();
    world = makeWorld();
    world.definitions.sync(snapshotWith([PARENT, WORKER, REVIEWER]));
    const root = world.openRoot("lead");
    const a = await root.handle.bridge.startAgent({ agentName: "worker", subagentName: "a", task: "t" });
    const b = await root.handle.bridge.startAgent({ agentName: "worker", subagentName: "b", task: "t" });
    const waiting = root.handle.bridge.waitForAgents({ runIds: [a.runId, b.runId], timeoutSeconds: 30 });
    await world.harness.bridgeOf("/sessions/child-1.jsonl")!.completeRun({ status: "completed", message: "a done" });
    await vi.advanceTimersByTimeAsync(30_000);
    const timedOut = await waiting;
    expect(timedOut.timedOut).toBe(true);
    expect(timedOut.runs.map((r) => r.status)).toEqual(["completed", "running"]);
    const second = root.handle.bridge.waitForAgents({ runIds: [b.runId] });
    await world.harness.bridgeOf("/sessions/child-2.jsonl")!.completeRun({ status: "completed", message: "b done" });
    await vi.advanceTimersByTimeAsync(0);
    expect(await second).toEqual({ timedOut: false, runs: [expect.objectContaining({ runId: b.runId, status: "completed" })] });
    await expect(root.handle.bridge.waitForAgents({ runIds: ["run_nope"] })).rejects.toThrow(/None of run_nope/);
  });

  it("sends messages: queued while busy, prompted while idle, a new run once ended", async () => {
    const root = world.openRoot("lead");
    const { sessionId, runId } = await root.handle.bridge.startAgent({ agentName: "worker", subagentName: "w", task: "t" });
    const path = "/sessions/child-1.jsonl";
    const child = world.drivers.get(path)!;
    child.setStreaming(true);
    expect(await root.handle.bridge.sendAgentMessage({ sessionId, message: "also check refresh", interrupt: false })).toEqual({ sessionId, runId, status: "running", delivery: "queued" });
    expect(child.followUps).toEqual(["also check refresh"]);
    expect(await root.handle.bridge.sendAgentMessage({ sessionId, message: "stop, wrong file", interrupt: true })).toEqual({ sessionId, runId, status: "running", delivery: "queued" });
    expect(child.steers).toEqual(["stop, wrong file"]);
    child.setStreaming(false);
    expect(await root.handle.bridge.sendAgentMessage({ sessionId, message: "carry on", interrupt: false })).toMatchObject({ runId, delivery: "delivered" });
    expect(child.prompted.map((p) => p.text)).toEqual(["t", "carry on"]);
    await world.harness.bridgeOf(path)!.completeRun({ status: "completed", message: "done" });
    const followUp = await root.handle.bridge.sendAgentMessage({ sessionId, message: "one more thing", interrupt: false });
    expect(followUp.runId).not.toBe(runId);
    expect(followUp).toMatchObject({ sessionId, status: "running", delivery: "delivered" });
    expect(world.harness.activeRun(path)).toMatchObject({ runId: followUp.runId, origin: "agent", task: "one more thing" });
    expect(world.harness.bridgeOf(path)!.role().runId).toBe(followUp.runId);
    expect(child.prompted.at(-1)?.text).toBe("one more thing");
    await expect(root.handle.bridge.sendAgentMessage({ sessionId: "nope", message: "x", interrupt: false })).rejects.toThrow(/No agent session is called "nope"/);
    expect((await root.handle.bridge.listAgents()).map((r) => r.runId)).toEqual([followUp.runId, runId]);
  });

  it("gives a person's prompt on an idle child a run of its own and marks it so for the parent", async () => {
    const root = world.openRoot("lead");
    const received: AgentModelEvent[] = [];
    root.handle.bridge.onEvent((event) => received.push(event));
    const { runId } = await root.handle.bridge.startAgent({ agentName: "worker", subagentName: "w", task: "t" });
    const path = "/sessions/child-1.jsonl";
    await world.harness.bridgeOf(path)!.completeRun({ status: "completed", message: "done" });
    expect(world.harness.startUserRun(path, "what did you change?")).toMatchObject({ origin: "user", status: "running", task: "what did you change?" });
    expect(world.harness.startUserRun(path, "again")).toBeUndefined(); // one active run at a time
    expect(world.harness.startUserRun(root.path, "x")).toBeUndefined(); // roots have no runs
    const userRun = world.harness.activeRun(path)!;
    expect(userRun.runId).not.toBe(runId);
    await world.harness.bridgeOf(path)!.completeRun({ status: "completed", message: "I changed nothing." });
    expect(received[1]!.message).toContain("I changed nothing.");
    expect(received[1]!.message).toContain("started by the person");
  });

  it("enforces nesting depth and lets a child start its own children under the same project", async () => {
    world.definitions.sync(snapshotWith([PARENT, WORKER, REVIEWER], 2));
    const root = world.openRoot("lead");
    await root.handle.bridge.startAgent({ agentName: "worker", subagentName: "w1", task: "t" });
    const child = world.harness.bridgeOf("/sessions/child-1.jsonl")!;
    expect(child.role().depth).toBe(1);
    expect(child.canDelegate()).toBe(true);
    const grand = await child.startAgent({ agentName: "worker", subagentName: "w2", task: "t2" });
    expect(world.worktrees.created[1]).toMatchObject({ projectCwd: "/repo", baseCwd: expect.stringMatching(/^\/repo\/\.worktrees\/w1-/), subagentName: "w2" });
    expect(world.harness.run(grand.runId)).toMatchObject({ depth: 2, parent: { sessionPath: "/sessions/child-1.jsonl", sessionId: "child-1" }, rootSessionPath: root.path, projectCwd: "/repo" });
    const grandBridge = world.harness.bridgeOf("/sessions/child-2.jsonl")!;
    expect(grandBridge.canDelegate()).toBe(false);
    await expect(grandBridge.startAgent({ agentName: "worker", subagentName: "w3", task: "t3" })).rejects.toThrow(/nest at most 2 deep/);
  });

  it("cleans up the worktree when the child session cannot open", async () => {
    const root = world.openRoot("lead");
    world.setFailOpen(true);
    await expect(root.handle.bridge.startAgent({ agentName: "worker", subagentName: "w", task: "t" })).rejects.toThrow(/Could not start worker: engine refused/);
    expect(world.worktrees.removed).toHaveLength(1);
    expect(world.runsNotified()).toHaveLength(0);
    expect(await root.handle.bridge.listAgents()).toEqual([]);
  });

  it("emits a valid run panel to the parent and keeps its lifecycle current", async () => {
    const root = world.openRoot("lead");
    const { runId } = await root.handle.bridge.startAgent({ agentName: "worker", subagentName: "fix-login", task: "t" });
    const upserts = world.panels().filter((p) => p.message.type === "lasercode/panel/upsert");
    expect(upserts.at(-1)).toMatchObject({ path: root.path, message: { panel: { id: runPanelId(runId), kind: "run", lifecycle: "running", handle: "fix-login", title: "fix-login", intent: "follow", source: "agents", parent: { id: root.path, relation: "spawned-by" } } } });
    const panel = runPanel(world.harness.run(runId)!)!;
    expect(panel.kind === "run" && panel.actions?.map((a) => a.id)).toEqual(["open", "stop"]);
    // The same payload, as an extension would emit it, passes the panel contract.
    const { id, kind, title, intent, source, actions, ...data } = panel as unknown as Record<string, unknown> & { actions: unknown };
    expect(validatePanelEvent({ v: 1, id, kind, title, intent, source, actions, data }).ok).toBe(true);
    await world.harness.bridgeOf("/sessions/child-1.jsonl")!.completeRun({ status: "completed", message: "done" });
    const last = world.panels().filter((p) => p.message.type === "lasercode/panel/upsert").at(-1)!;
    expect(last.message.panel).toMatchObject({ id: runPanelId(runId), lifecycle: "done", endedAt: expect.any(String) });
    expect((last.message.panel as { actions: Array<{ id: string }> }).actions.map((a) => a.id)).toEqual(["open"]);
    expect(await world.harness.handlePanelAction(runPanelId(runId), "open")).toBe(true);
    expect(await world.harness.handlePanelAction("subagents:run:x", "open")).toBe(false);
    expect(await world.harness.handlePanelAction(runPanelId("run_missing"), "stop")).toBe(false);
  });

  it("buffers parent events until the parent's module listens, and re-announces roles on a definitions change", async () => {
    const root = world.openRoot("lead");
    await root.handle.bridge.startAgent({ agentName: "worker", subagentName: "w", task: "t" });
    await world.harness.bridgeOf("/sessions/child-1.jsonl")!.completeRun({ status: "completed", message: "early" });
    const received: AgentModelEvent[] = [];
    root.handle.bridge.onEvent((event) => received.push(event));
    expect(received.map((e) => e.message)).toEqual(["early"]);
    const roles: HarnessSessionRole[] = [];
    root.handle.bridge.onRoleChange((role) => roles.push(role));
    world.definitions.sync(snapshotWith([{ ...PARENT, allowedAgents: ["reviewer"] }, WORKER, REVIEWER]));
    expect(roles).toHaveLength(1);
    expect(root.handle.bridge.catalog()).toEqual([{ agentName: "reviewer", description: "reviewer agent" }]);
  });

  it("refuses to stop an unknown run with a sentence", async () => {
    await expect(world.harness.stopRun("run_zzz", { initiator: "user" })).rejects.toBeInstanceOf(HarnessError);
  });
});
