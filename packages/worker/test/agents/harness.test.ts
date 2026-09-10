/**
 * M13-T3 · the harness lifecycle with a fake host: start → running →
 * complete through the bridge; blocked; stops by a person and by the parent;
 * no limit on a run's length; failure on close; settle-without-completion; follow-up
 * messages; nesting and allow-list refusals; run notifications; a child paused
 * on a question (`needs_input`), the parent answering it, and `inspect_agent`
 * (M13-T45). There is no waiting tool: nothing here waits for anything.
 */
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { DriverAgentOptions, DriverEvent, DriverListener, PromptOptions, SessionDriver } from "../../src/driver.js";
import type { AgentModelEvent, HarnessSessionRole } from "../../src/agents/bridge.js";
import { DefinitionsCache, fallbackDefaultAgent, fallbackSnapshot } from "../../src/agents/definitions.js";
import { AgentHarness, NUDGE_TEXT, type SessionHost, type WorktreeProvider } from "../../src/agents/harness.js";
import { HarnessError } from "../../src/agents/errors.js";
import { rootRecord, rootRole } from "../../src/agents/session-config.js";
import type { CreateWorktreeInput, Worktree, WorktreeFacts } from "../../src/agents/worktrees.js";
import type { IndexedTask } from "../../src/agents/tasks.js";
import { SESSION_RUN_ENTRY_TYPE, type AgentDefinition, type AgentRun, type AgentsSnapshot, type ContentBlock, type SessionState, type UiDialogRequest, type UiDialogResponse } from "@lasercode/protocol";

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
  /** Dialogs raised and not yet answered, as `StableSdkDriver.pendingUi()` lists them. */
  pending: UiDialogRequest[] = [];
  responses: UiDialogResponse[] = [];
  /** The session file's lines, for `entries()`; the last one is the leaf. */
  lines: Array<Record<string, unknown>> = [];
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
  respondToUi(r: UiDialogResponse) { this.responses.push(r); this.pending = this.pending.filter((p) => p.id !== r.id); }
  pendingUi(): UiDialogRequest[] { return [...this.pending]; }
  /** Raise a dialog the way the real bridge does: listed as pending first, then announced. */
  ask(request: UiDialogRequest) { this.pending.push(request); this.emit({ type: "ui_request", request }); }
  /** The dialog settled without a client answer (timeout, abort): gone from the list, then announced. */
  resolveDialog(id: string) { this.pending = this.pending.filter((p) => p.id !== id); this.emit({ type: "ui_event", event: { method: "dialogResolved", id } }); }
  async commands() { return []; }
  async prompts() { return []; }
  async entries() { return { entries: [...this.lines], leafId: (this.lines.at(-1)?.["id"] as string | undefined) ?? null }; }
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
  let refuseWorktrees: string | undefined;
  let facts: WorktreeFacts = { exists: true, unmergedCommits: 0, uncommittedFiles: 0 };
  let root: string | undefined = "/repo";
  /** The worker's task index, as the harness reads it: commands by the session that ran them. */
  const tasks = new Map<string, IndexedTask[]>();
  const worktrees: WorktreeProvider & { created: CreateWorktreeInput[]; removed: string[]; removedWith: Array<{ root: string; path: string; branch?: string }> } = {
    created: [],
    removed: [],
    removedWith: [],
    async create(input) {
      if (refuseWorktrees !== undefined) throw new HarnessError(refuseWorktrees);
      this.created.push(input);
      const path = `/repo/.worktrees/${input.subagentName}-${input.runId.slice(4)}`;
      const worktree: Worktree = { path, branch: `agents/${input.subagentName}`, baseCommit: "abc123", cwd: path, root: "/repo" };
      return worktree;
    },
    async remove(root_, path, branch) { this.removed.push(path); this.removedWith.push({ root: root_, path, ...(branch !== undefined ? { branch } : {}) }); },
    ownedBy: () => undefined,
    async rootOf() { return root; },
    async facts() { return facts; },
  };
  const host: SessionHost = {
    async openChild(open) {
      if (failOpen) throw new Error("engine refused");
      childCount += 1;
      const path = `/sessions/child-${childCount}.jsonl`;
      const driver = new FakeDriver(stateFor(path, `child-${childCount}`, open.cwd));
      drivers.set(path, driver);
      opened.push(open);
      // The server forwards every driver event to the harness; so does this host.
      driver.subscribe((event) => harness.onDriverEvent(path, event));
      return driver.state();
    },
    driver: (path) => drivers.get(path),
    notify: (method, params) => notifications.push({ method, params }),
    modelAvailable: async () => !unavailable,
    tasks: (path) => tasks.get(path) ?? [],
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
  const extensionMessages = () => notifications.filter((n) => n.method === "pi/extension/message").map((n) => n.params as { path: string; message: { type: string } });
  return {
    harness, definitions, drivers, notifications, opened, worktrees, openRoot, runsNotified, events, extensionMessages, tasks,
    setUnavailable: (value: boolean) => { unavailable = value; },
    setFailOpen: (value: boolean) => { failOpen = value; },
    /** Stand in for a project git cannot give a worktree: not a repository, no commit, a path another agent owns. */
    setRefuseWorktrees: (message: string | undefined) => { refuseWorktrees = message; },
    /** What the child's branch and directory hold, when the parent asks to remove them. */
    setWorktreeFacts: (next: WorktreeFacts) => { facts = next; },
    setWorktreeRoot: (next: string | undefined) => { root = next; },
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
    expect(result).toEqual({
      agentName: "worker",
      subagentName: "fix-login",
      sessionId: "child-1",
      runId: expect.stringMatching(/^run_[0-9a-f]{8}$/),
      status: "running",
      cwd: expect.stringMatching(/^\/repo\/\.worktrees\/fix-login-/),
      branch: "agents/fix-login",
    });

    // The child session opened in the worktree with the child's definition and role.
    expect(world.worktrees.created[0]).toMatchObject({ projectCwd: "/repo", baseCwd: "/repo", subagentName: "fix-login", runId: result.runId });
    const open = world.opened[0]!;
    expect(open.cwd).toMatch(/^\/repo\/\.worktrees\/fix-login-/);
    expect(open.parentSessionPath).toBe(root.path);
    expect(open.agent.definition.name).toBe("worker");
    expect(open.agent.record).toMatchObject({ agentName: "worker", kind: "child", subagentName: "fix-login", parentPath: root.path, parentSessionId: "root-1", rootPath: root.path, runId: result.runId, worktree: { branch: "agents/fix-login", baseCommit: "abc123" } });
    const role: HarnessSessionRole = open.agent.role;
    expect(role).toMatchObject({ agentName: "worker", kind: "child", subagentName: "fix-login", depth: 1, isolated: true, parent: { sessionPath: root.path, sessionId: "root-1", agentName: "lead" }, runId: result.runId, goal: { id: "g1", objective: "Ship the login fix" }, task: "Fix the login form." });
    expect(open.agent.backgroundWork).toMatchObject({ cwd: open.cwd, foregroundCommandSeconds: 120 });
    // Bound to the child, so its `task_output` can read a command of an agent under it (D-163).
    expect(typeof open.agent.backgroundWork?.readTask).toBe("function");

    // The task was prompted verbatim, without waiting, and the child was named.
    const child = world.drivers.get("/sessions/child-1.jsonl")!;
    expect(child.prompted).toEqual([{ text: "Fix the login form.", options: { expandPromptTemplates: false } }]);
    expect(child.names).toEqual(["fix-login"]);
    expect(child.custom[0]).toMatchObject({ type: SESSION_RUN_ENTRY_TYPE, data: { runId: result.runId, moment: "started", task: "Fix the login form." } });

    // Notifications: the run, and the two started/message_sent moments.
    const running = world.runsNotified().at(-1)!;
    expect(running).toMatchObject({ agentName: "worker", subagentName: "fix-login", sessionId: "child-1", runId: result.runId, sessionPath: "/sessions/child-1.jsonl", status: "running", origin: "agent", depth: 1, parent: { sessionPath: root.path, sessionId: "root-1" }, goal: { id: "g1" }, projectCwd: "/repo", rootSessionPath: root.path, cwd: open.cwd });
    // No deadline: nothing ends a run for taking long (D-144).
    expect(running).not.toHaveProperty("timeoutAt");
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

    // The fleet the parent reads: one row, ended, carrying its final message.
    const fleet = await root.handle.bridge.inspectFleet();
    expect(fleet).toMatchObject({ working: 0, needsYou: 0, finished: 1, total: 1, omitted: 0 });
    expect(fleet.rows).toEqual([expect.objectContaining({ kind: "agent", subagentName: "fix-login", runId: result.runId, state: "completed", status: "Done", line: "done: touched nothing", depth: 0, children: [] })]);
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
    // Idempotent: a second stop changes nothing.
    await world.harness.stopRun(runId, { initiator: "user" });
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

  it("lets a run go on with no limit of any kind: no clock ends it", async () => {
    vi.useFakeTimers();
    world = makeWorld();
    world.definitions.sync(snapshotWith([PARENT, WORKER, REVIEWER]));
    const root = world.openRoot("lead");
    const received: AgentModelEvent[] = [];
    root.handle.bridge.onEvent((event) => received.push(event));
    const { runId } = await root.handle.bridge.startAgent({ agentName: "reviewer", subagentName: "r", task: "t" });
    // A run carries no deadline, and months of silence change nothing (D-144).
    expect(world.harness.run(runId)).not.toHaveProperty("timeoutAt");
    await vi.advanceTimersByTimeAsync(90 * 24 * 60 * 60_000);
    expect(world.harness.run(runId)).toMatchObject({ status: "running" });
    expect(world.drivers.get("/sessions/child-1.jsonl")!.aborts).toBe(0);
    expect(received).toEqual([]);
    // It ends when the agent says so, not when a timer does.
    const childBridge = world.harness.bridgeOf("/sessions/child-1.jsonl")!;
    expect(await childBridge.completeRun({ status: "completed", message: "done at last" })).toEqual({ ok: true, runId });
    expect(world.harness.run(runId)).toMatchObject({ status: "completed" });
    expect(received.at(-1)).toMatchObject({ type: "agent.completed" });
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

  // ---------------------------------------------------------- questions
  // M13-T45: a child paused on a question is `needs_input`, never `running`.
  // The parent can tell the two apart from the status alone, is told once
  // per question, and may answer through `send_agent_message`.
  describe("a child paused on a question", () => {
    const select: UiDialogRequest = { method: "select", id: "ui-1", title: "Which database?", options: ["staging", "production"], toolCallId: "call-1" };

    it("is needs_input while the question is open, tells the parent once, and is running again once someone answers", async () => {
      const root = world.openRoot("lead");
      const received: AgentModelEvent[] = [];
      root.handle.bridge.onEvent((event) => received.push(event));
      const { runId, sessionId } = await root.handle.bridge.startAgent({ agentName: "worker", subagentName: "migrate", task: "Migrate the schema." });
      const path = "/sessions/child-1.jsonl";
      const child = world.drivers.get(path)!;
      child.emit({ type: "update", update: { kind: "tool_execution_start", toolCallId: "call-1", toolName: "ask_person", args: {} } });
      child.ask(select);

      const paused = world.harness.run(runId)!;
      expect(paused.status).toBe("needs_input");
      expect(paused.question).toEqual({ id: "ui-1", kind: "select", title: "Which database?", options: ["staging", "production"], toolCallId: "call-1", toolName: "ask_person", askedAt: expect.any(String) });
      expect(world.runsNotified().at(-1)).toMatchObject({ runId, status: "needs_input", question: { id: "ui-1" } });
      expect(world.harness.sessionInfo(path)).toMatchObject({ runStatus: "needs_input" });
      // The parent's fleet says so too — Asking, with the question as the row's line — so it can tell stuck from working at a glance.
      expect((await root.handle.bridge.inspectFleet()).rows[0]).toMatchObject({ runId, state: "needs_input", status: "Asking", line: "Which database?" });
      // Told once, with the question and how to answer it — and that the person may answer instead.
      expect(received).toHaveLength(1);
      expect(received[0]).toMatchObject({ type: "agent.needs_input", agentName: "worker", subagentName: "migrate", sessionId, runId, run: { status: "needs_input" } });
      expect(received[0]!.message).toContain("migrate is paused on a question");
      expect(received[0]!.message).toContain("raised by its ask_person tool");
      expect(received[0]!.message).toContain("Question (select): Which database?");
      expect(received[0]!.message).toContain('Choices: "staging", "production"');
      expect(received[0]!.message).toContain("send_agent_message with its sessionId and one of the choices");
      expect(received[0]!.message).toContain("the person can answer it in migrate's own chat");
      expect(received[0]!.message).toContain(`inspect_agent with runId ${runId}`);
      expect(world.events().map((e) => `${e.kind}@${e.sessionPath}`)).toEqual(["started@/sessions/child-1.jsonl", "message_sent@/sessions/root.jsonl", "needs_input@/sessions/child-1.jsonl", "message_received@/sessions/root.jsonl"]);
      expect(world.events().at(-2)!.summary).toBe("Asked: Which database?");
      // The same question announced again changes nothing.
      child.emit({ type: "ui_request", request: select });
      expect(received).toHaveLength(1);

      // The person answers in the child's chat: the harness never sees the
      // answer, only that the driver no longer holds the question — which it
      // notices on the child's next move.
      child.respondToUi({ id: "ui-1", value: "staging" });
      expect(world.harness.run(runId)!.status).toBe("needs_input");
      child.emit({ type: "update", update: { kind: "tool_execution_end", toolCallId: "call-1", toolName: "ask_person", result: "staging", isError: false } });
      const resumed = world.harness.run(runId)!;
      expect(resumed.status).toBe("running");
      expect(resumed).not.toHaveProperty("question");
      expect(world.runsNotified().map((r) => r.status).slice(-3)).toEqual(["running", "needs_input", "running"]);
      expect(received).toHaveLength(1);
      // Nothing about the ending changes: it still completes through the tool.
      expect(await world.harness.bridgeOf(path)!.completeRun({ status: "completed", message: "Migrated staging." })).toEqual({ ok: true, runId });
      expect(received.at(-1)).toMatchObject({ type: "agent.completed" });
    });

    it("lets the parent answer through send_agent_message, refusing an answer that does not fit the question", async () => {
      const root = world.openRoot("lead");
      const { runId, sessionId } = await root.handle.bridge.startAgent({ agentName: "worker", subagentName: "migrate", task: "t" });
      const path = "/sessions/child-1.jsonl";
      const child = world.drivers.get(path)!;
      child.ask(select);
      // Not one of the choices: refused with the choices, and the question still stands.
      await expect(root.handle.bridge.sendAgentMessage({ sessionId, message: "use the dev one", interrupt: false })).rejects.toThrow(/not one of the choices.*"staging", "production"/s);
      expect(child.responses).toEqual([]);
      expect(world.harness.run(runId)!.status).toBe("needs_input");
      // A choice, by name (case-insensitively) or by number: the dialog is answered, and nothing is prompted or queued.
      const answered = await root.handle.bridge.sendAgentMessage({ sessionId, message: "Staging", interrupt: false });
      expect(answered).toEqual({ sessionId, runId, status: "running", delivery: "answered", answered: expect.objectContaining({ id: "ui-1", kind: "select" }) });
      expect(child.responses).toEqual([{ id: "ui-1", value: "staging" }]);
      expect(child.prompted.map((p) => p.text)).toEqual(["t"]);
      expect(child.followUps).toEqual([]);
      expect(world.harness.run(runId)).toMatchObject({ status: "running" });
      expect(world.harness.run(runId)).not.toHaveProperty("question");
      expect(world.events().slice(-2).map((e) => `${e.kind}:${e.summary}`)).toEqual(["message_sent:Answered migrate's question", "message_received:Answer from lead"]);

      child.ask({ method: "select", id: "ui-2", title: "Which one?", options: ["a", "b", "c"] });
      expect((await root.handle.bridge.sendAgentMessage({ sessionId, message: "2", interrupt: false })).delivery).toBe("answered");
      expect(child.responses.at(-1)).toEqual({ id: "ui-2", value: "b" });

      // A confirm takes a plain yes or no, nothing else.
      child.ask({ method: "confirm", id: "ui-3", title: "Drop the table?", message: "This cannot be undone." });
      await expect(root.handle.bridge.sendAgentMessage({ sessionId, message: "only if it is empty", interrupt: false })).rejects.toThrow(/Drop the table\?.*This cannot be undone.*yes or no/s);
      expect((await root.handle.bridge.sendAgentMessage({ sessionId, message: "No.", interrupt: false })).answered).toMatchObject({ kind: "confirm" });
      expect(child.responses.at(-1)).toEqual({ id: "ui-3", confirmed: false });
      child.ask({ method: "confirm", id: "ui-4", title: "Continue?" });
      await root.handle.bridge.sendAgentMessage({ sessionId, message: "yes", interrupt: false });
      expect(child.responses.at(-1)).toEqual({ id: "ui-4", confirmed: true });

      // Input and editor take the message as it is.
      child.ask({ method: "input", id: "ui-5", title: "Table name?", placeholder: "users" });
      expect(world.harness.run(runId)!.question).toMatchObject({ kind: "input", detail: "users" });
      await root.handle.bridge.sendAgentMessage({ sessionId, message: "accounts_v2", interrupt: false });
      expect(child.responses.at(-1)).toEqual({ id: "ui-5", value: "accounts_v2" });
      child.ask({ method: "editor", id: "ui-6", title: "Edit the migration", prefill: "-- sql" });
      await root.handle.bridge.sendAgentMessage({ sessionId, message: "-- sql\nALTER TABLE accounts ADD COLUMN v2 int;", interrupt: false });
      expect(child.responses.at(-1)).toEqual({ id: "ui-6", value: "-- sql\nALTER TABLE accounts ADD COLUMN v2 int;" });
      expect(world.harness.run(runId)!.status).toBe("running");
    });

    it("shows the oldest open question, moves to the next when it is settled, and drops one that times out", async () => {
      const root = world.openRoot("lead");
      const received: AgentModelEvent[] = [];
      root.handle.bridge.onEvent((event) => received.push(event));
      const { runId } = await root.handle.bridge.startAgent({ agentName: "worker", subagentName: "w", task: "t" });
      const child = world.drivers.get("/sessions/child-1.jsonl")!;
      child.ask({ method: "confirm", id: "ui-1", title: "First?" });
      child.ask({ method: "confirm", id: "ui-2", title: "Second?" });
      expect(world.harness.run(runId)!.question?.id).toBe("ui-1");
      expect(received.map((e) => e.type)).toEqual(["agent.needs_input"]);
      // The first times out: the second is now the question, and the parent hears about it.
      child.resolveDialog("ui-1");
      expect(world.harness.run(runId)).toMatchObject({ status: "needs_input", question: { id: "ui-2", title: "Second?" } });
      expect(received.map((e) => e.type)).toEqual(["agent.needs_input", "agent.needs_input"]);
      child.resolveDialog("ui-2");
      expect(world.harness.run(runId)).toMatchObject({ status: "running" });
      expect(received).toHaveLength(2);
    });

    it("keeps the question, for a driver that cannot list its dialogs, until that exact dialog is resolved", async () => {
      const root = world.openRoot("lead");
      const { runId } = await root.handle.bridge.startAgent({ agentName: "worker", subagentName: "w", task: "t" });
      const child = world.drivers.get("/sessions/child-1.jsonl")!;
      Object.defineProperty(child, "pendingUi", { value: undefined });
      child.emit({ type: "ui_request", request: { method: "input", id: "ui-1", title: "Name?" } });
      expect(world.harness.run(runId)!.status).toBe("needs_input");
      child.emit({ type: "update", update: { kind: "turn_start" } });
      child.emit({ type: "ui_event", event: { method: "dialogResolved", id: "ui-other" } });
      expect(world.harness.run(runId)!.status).toBe("needs_input");
      child.emit({ type: "ui_event", event: { method: "dialogResolved", id: "ui-1" } });
      expect(world.harness.run(runId)!.status).toBe("running");
    });

    it("lets a question die with its run, and ignores one raised in a session with no run", async () => {
      const root = world.openRoot("lead");
      const received: AgentModelEvent[] = [];
      root.handle.bridge.onEvent((event) => received.push(event));
      const { runId } = await root.handle.bridge.startAgent({ agentName: "worker", subagentName: "w", task: "t" });
      const path = "/sessions/child-1.jsonl";
      const child = world.drivers.get(path)!;
      child.ask(select);
      const run = await world.harness.stopRun(runId, { initiator: "user", reason: "never mind" });
      expect(run.status).toBe("cancelled");
      expect(run).not.toHaveProperty("question");
      expect(received.map((e) => e.type)).toEqual(["agent.needs_input", "agent.cancelled"]);
      // The session is idle now: a dialog there is the person's business, not a run's.
      child.ask({ method: "confirm", id: "ui-9", title: "Still there?" });
      expect(world.harness.run(runId)!.status).toBe("cancelled");
      expect(world.harness.activeRun(path)).toBeUndefined();
      expect(received).toHaveLength(2);
      // A message to the idle child is a new run, not an answer.
      expect((await root.handle.bridge.sendAgentMessage({ sessionId: "child-1", message: "carry on", interrupt: false })).delivery).toBe("delivered");
    });
  });

  // ------------------------------------------------------------ inspect
  describe("inspect_agent", () => {
    it("answers for a live child: the whole task, where it works, activity, its last words, its question and its children", async () => {
      world.definitions.sync(snapshotWith([PARENT, WORKER, REVIEWER], 3));
      const root = world.openRoot("lead");
      const task = `Fix the login form. ${"Details. ".repeat(80)}`.trim();
      const { runId, sessionId } = await root.handle.bridge.startAgent({ agentName: "worker", subagentName: "fix-login", task });
      const path = "/sessions/child-1.jsonl";
      const child = world.drivers.get(path)!;
      world.setWorktreeFacts({ exists: true, unmergedCommits: 1, uncommittedFiles: 2 });
      child.emit({ type: "update", update: { kind: "turn_start" } });
      child.emit({ type: "update", update: { kind: "tool_execution_start", toolCallId: "c1", toolName: "bash", args: {} } });
      child.lines = [
        { type: "session", id: "s" },
        { type: "message", id: "m1", parentId: null, timestamp: "2026-09-09T10:00:00.000Z", message: { role: "user", content: [{ type: "text", text: task }] } },
        { type: "message", id: "m2", parentId: "m1", timestamp: "2026-09-09T10:00:05.000Z", message: { role: "assistant", content: [{ type: "text", text: "Reading the form." }] } },
        { type: "message", id: "m3", parentId: "m2", timestamp: "2026-09-09T10:00:09.000Z", message: { role: "assistant", content: [{ type: "text", text: "Found the bug in validate()." }, { type: "toolCall", name: "bash" }] } },
      ];
      child.ask({ method: "confirm", id: "ui-1", title: "Run the migration?", toolCallId: "c1" });
      const grand = await world.harness.bridgeOf(path)!.startAgent({ agentName: "worker", subagentName: "check-tests", task: "Run the tests." });

      const seen = await root.handle.bridge.inspectAgent({ runId });
      expect(seen).toMatchObject({
        agentName: "worker",
        subagentName: "fix-login",
        sessionId,
        runId,
        status: "needs_input",
        origin: "agent",
        depth: 1,
        model: "stub/stub-1",
        task,
        cwd: expect.stringMatching(/^\/repo\/\.worktrees\/fix-login-/),
        branch: "agents/fix-login",
        worktree: { path: expect.stringMatching(/fix-login/), branch: "agents/fix-login", exists: true, unmergedCommits: 1, uncommittedFiles: 2 },
        activity: { turns: 1, tools: 1, currentTool: "bash", lastAt: expect.any(String) },
        question: { id: "ui-1", kind: "confirm", title: "Run the migration?", toolCallId: "c1", toolName: "bash" },
        messages: [{ at: "2026-09-09T10:00:09.000Z", text: "Found the bug in validate()." }],
        agents: [expect.objectContaining({ runId: grand.runId, subagentName: "check-tests", status: "running" })],
      });
      // The run record still carries only the excerpt; the whole task is inspect's alone.
      expect(world.harness.run(runId)!.task.length).toBeLessThan(task.length);
      // More messages, oldest first; the count is clamped to the cap; zero is allowed.
      expect((await root.handle.bridge.inspectAgent({ runId, messages: 2 })).messages.map((m) => m.text)).toEqual(["Reading the form.", "Found the bug in validate()."]);
      expect((await root.handle.bridge.inspectAgent({ runId, messages: 100 })).messages).toHaveLength(2);
      expect((await root.handle.bridge.inspectAgent({ runId, messages: 0 })).messages).toEqual([]);
      await expect(root.handle.bridge.inspectAgent({ runId, messages: "all" as unknown as number })).rejects.toThrow(/messages must be a number/);
      // By sessionId too — the same child, and nothing was prompted, steered or answered by looking.
      expect((await root.handle.bridge.inspectAgent({ sessionId })).runId).toBe(runId);
      expect(child.prompted.map((p) => p.text)).toEqual([task]);
      expect(child.responses).toEqual([]);
      expect(world.harness.run(runId)!.status).toBe("needs_input");
    });

    it("answers for an ended child whose driver is gone, without a worktree, and refuses a stranger", async () => {
      const root = world.openRoot("lead");
      const { runId, sessionId } = await root.handle.bridge.startAgent({ agentName: "worker", subagentName: "read", task: "Read it.", worktree: false });
      const path = "/sessions/child-1.jsonl";
      await world.harness.bridgeOf(path)!.completeRun({ status: "blocked", message: "Which of the two configs is canonical?" });
      world.drivers.delete(path);
      const seen = await root.handle.bridge.inspectAgent({ sessionId });
      expect(seen).toMatchObject({ runId, status: "blocked", task: "Read it.", cwd: "/repo", worktree: null, result: { status: "blocked", message: "Which of the two configs is canonical?" }, messages: [], agents: [] });
      expect(seen).not.toHaveProperty("branch");
      expect(seen).not.toHaveProperty("question");
      const stranger = world.openRoot("lead", "/sessions/other.jsonl", "other-1");
      await expect(stranger.handle.bridge.inspectAgent({ runId })).rejects.toThrow(/is not in the tree under this session.*inspect_fleet/s);
      await expect(root.handle.bridge.inspectAgent({})).rejects.toThrow(/sessionId or one of its runIds/);
    });

    // D-163: any row of the caller's tree may be read — a child's child too,
    // as the person may open any chat in the tree — but only read. The verbs
    // that act on an agent still take a direct child alone.
    it("reads a grandchild, refuses a row outside the tree, and keeps the acting verbs to direct children", async () => {
      const root = world.openRoot("lead");
      const child = await root.handle.bridge.startAgent({ agentName: "worker", subagentName: "w1", task: "t" });
      const childBridge = world.harness.bridgeOf("/sessions/child-1.jsonl")!;
      const grand = await childBridge.startAgent({ agentName: "worker", subagentName: "w2", task: "t2" });
      world.setWorktreeFacts({ exists: true, unmergedCommits: 2, uncommittedFiles: 0 });
      const seen = await root.handle.bridge.inspectAgent({ runId: grand.runId });
      expect(seen).toMatchObject({ runId: grand.runId, subagentName: "w2", depth: 2, status: "running", worktree: { exists: true, unmergedCommits: 2 } });
      expect((await root.handle.bridge.inspectAgent({ sessionId: grand.sessionId })).runId).toBe(grand.runId);
      // The child reads its own child; the grandchild reads nobody above or beside it.
      expect((await childBridge.inspectAgent({ runId: grand.runId })).runId).toBe(grand.runId);
      const grandBridge = world.harness.bridgeOf("/sessions/child-2.jsonl")!;
      await expect(grandBridge.inspectAgent({ runId: child.runId })).rejects.toThrow(/is not in the tree under this session/);
      const other = world.openRoot("lead", "/sessions/other.jsonl", "other-1");
      await expect(other.handle.bridge.inspectAgent({ sessionId: grand.sessionId })).rejects.toThrow(/is not in the tree under this session/);
      // Acting on a grandchild is refused the old way: it was not started by this session.
      await expect(root.handle.bridge.stopAgent({ runId: grand.runId })).rejects.toThrow(/was started by this session/);
      await expect(root.handle.bridge.removeAgentWorktree({ runId: grand.runId })).rejects.toThrow(/was started by this session/);
      await expect(root.handle.bridge.sendAgentMessage({ sessionId: grand.sessionId, message: "hi", interrupt: false })).rejects.toThrow(/among the agents this session started/);
      expect(world.harness.run(grand.runId)!.status).toBe("running");
    });

    it("says a removed worktree is gone rather than asking git about it", async () => {
      const root = world.openRoot("lead");
      const { runId } = await root.handle.bridge.startAgent({ agentName: "worker", subagentName: "iso", task: "t" });
      await world.harness.bridgeOf("/sessions/child-1.jsonl")!.completeRun({ status: "completed", message: "done" });
      await root.handle.bridge.removeAgentWorktree({ runId });
      const seen = await root.handle.bridge.inspectAgent({ runId });
      expect(seen.worktree).toEqual({ path: expect.stringMatching(/iso/), branch: "agents/iso", exists: false, unmergedCommits: null, uncommittedFiles: null, removedAt: expect.any(String) });
      expect(seen).not.toHaveProperty("branch");
    });
  });

  // ------------------------------------------------------------- fleet
  // D-163: one tool, `inspect_fleet`, returns the tree the person's fleet
  // column shows, scoped to the caller: its agents, theirs, and the
  // background commands any of them ran — the caller's own included.
  describe("inspect_fleet", () => {
    const task = (id: string, sessionPath: string, status: IndexedTask["status"], extra: Partial<IndexedTask> = {}): IndexedTask => ({
      id,
      sessionPath,
      command: `run ${id}`,
      title: `run ${id}`,
      status,
      origin: "background",
      startedAt: "2026-09-09T10:00:00.000Z",
      outputBytes: 0,
      ...extra,
    });

    it("nests agents as the tree nests, hangs commands off the session that ran them, and scopes to the caller", async () => {
      const root = world.openRoot("lead");
      const child = await root.handle.bridge.startAgent({ agentName: "worker", subagentName: "w1", task: "Fix the login form." });
      const childPath = "/sessions/child-1.jsonl";
      const childBridge = world.harness.bridgeOf(childPath)!;
      const grand = await childBridge.startAgent({ agentName: "worker", subagentName: "w2", task: "t2" });
      const sibling = await root.handle.bridge.startAgent({ agentName: "reviewer", subagentName: "r", task: "Review." });
      world.tasks.set(root.path, [task("t-root", root.path, "running", { activity: "ready in 412 ms" })]);
      world.tasks.set(childPath, [task("t-child", childPath, "failed", { exitCode: 1, terminalReason: "exit code 1", endedAt: "2026-09-09T10:01:00.000Z" })]);
      world.drivers.get("/sessions/child-2.jsonl")!.emit({ type: "update", update: { kind: "tool_execution_start", toolCallId: "c", toolName: "bash", args: {} } });

      const fleet = await root.handle.bridge.inspectFleet();
      expect(fleet).toMatchObject({ working: 4, needsYou: 0, finished: 1, total: 5, omitted: 0 });
      // Creation order, never attention order; the root's own command last.
      expect(fleet.rows.map((r) => r.title)).toEqual(["w1", "r", "run t-root"]);
      const [w1, r, own] = fleet.rows;
      expect(w1).toMatchObject({ kind: "agent", agentName: "worker", subagentName: "w1", sessionId: child.sessionId, runId: child.runId, state: "running", status: "Working", line: "Fix the login form.", depth: 0 });
      expect(w1!.elapsed).toMatch(/^\d+s$/);
      // The child's own child, then the child's command.
      expect(w1!.children.map((c) => c.title)).toEqual(["w2", "run t-child"]);
      expect(w1!.children[0]).toMatchObject({ kind: "agent", runId: grand.runId, sessionId: grand.sessionId, status: "Working", line: "Running bash", depth: 1, children: [] });
      expect(w1!.children[1]).toMatchObject({ kind: "command", taskId: "t-child", state: "failed", status: "Failed", line: "exit code 1", exitCode: 1, depth: 1 });
      expect(r).toMatchObject({ kind: "agent", runId: sibling.runId, status: "Working", children: [] });
      expect(own).toMatchObject({ kind: "command", taskId: "t-root", state: "running", status: "Working", line: "ready in 412 ms", depth: 0 });
      expect(own).not.toHaveProperty("exitCode");

      // The child sees its own subtree only: its child, its command; never its sibling or the root's command.
      const childFleet = await childBridge.inspectFleet();
      expect(childFleet.rows.map((r) => r.title)).toEqual(["w2", "run t-child"]);
      expect(childFleet.rows[0]).toMatchObject({ runId: grand.runId, depth: 0 });
      expect(childFleet).toMatchObject({ working: 1, finished: 1, total: 2 });
      // The grandchild sees nothing: it started nothing and ran nothing.
      expect(await world.harness.bridgeOf("/sessions/child-2.jsonl")!.inspectFleet()).toEqual({ rows: [], working: 0, needsYou: 0, finished: 0, total: 0, omitted: 0 });
      // Another root sees none of it.
      expect((await world.openRoot("lead", "/sessions/other.jsonl", "other-1").handle.bridge.inspectFleet()).rows).toEqual([]);
      // Reading changed nothing.
      expect(world.drivers.get(childPath)!.prompted.map((p) => p.text)).toEqual(["Fix the login form."]);
    });

    it("says the endings in the fleet's words: live Asking with the question, terminal Blocked with the message, Ended with who ended it", async () => {
      const root = world.openRoot("lead");
      const asking = await root.handle.bridge.startAgent({ agentName: "worker", subagentName: "asking", task: "t" });
      world.drivers.get("/sessions/child-1.jsonl")!.ask({ method: "confirm", id: "ui-1", title: "Drop the table?" });
      const blocked = await root.handle.bridge.startAgent({ agentName: "worker", subagentName: "blocked", task: "t" });
      await world.harness.bridgeOf("/sessions/child-2.jsonl")!.completeRun({ status: "blocked", message: "Which config is canonical?\nI found two." });
      const ended = await root.handle.bridge.startAgent({ agentName: "worker", subagentName: "ended", task: "t" });
      await world.harness.stopRun(ended.runId, { initiator: "user" });
      const reasoned = await root.handle.bridge.startAgent({ agentName: "worker", subagentName: "reasoned", task: "t" });
      await root.handle.bridge.stopAgent({ runId: reasoned.runId, reason: "no longer needed" });
      const failed = await root.handle.bridge.startAgent({ agentName: "worker", subagentName: "failed", task: "t" });
      world.harness.onDriverEvent("/sessions/child-5.jsonl", { type: "closed", reason: "crash" });
      world.tasks.set(root.path, [task("t-stopped", root.path, "stopped", { exitCode: null, terminalReason: "you stopped it", endedAt: "2026-09-09T10:01:00.000Z" }), task("t-done", root.path, "completed", { exitCode: 0, endedAt: "2026-09-09T10:01:00.000Z" })]);

      const fleet = await root.handle.bridge.inspectFleet();
      expect(fleet).toMatchObject({ working: 1, needsYou: 1, finished: 6, total: 7 });
      const byTitle = new Map(fleet.rows.map((row) => [row.title, row]));
      expect(byTitle.get("asking")).toMatchObject({ runId: asking.runId, state: "needs_input", status: "Asking", line: "Drop the table?" });
      expect(byTitle.get("blocked")).toMatchObject({ runId: blocked.runId, state: "blocked", status: "Blocked", line: "Which config is canonical?" });
      expect(byTitle.get("ended")).toMatchObject({ state: "cancelled", status: "Ended", line: "the person ended it" });
      expect(byTitle.get("reasoned")).toMatchObject({ state: "cancelled", status: "Ended", line: "no longer needed" });
      expect(byTitle.get("failed")).toMatchObject({ runId: failed.runId, state: "failed", status: "Failed", line: "The agent's session closed before it finished." });
      // A command's ending is the person's word with the pronoun turned round, or its exit code.
      expect(byTitle.get("run t-stopped")).toMatchObject({ kind: "command", state: "cancelled", status: "Ended", line: "the person stopped it", exitCode: null });
      expect(byTitle.get("run t-done")).toMatchObject({ kind: "command", state: "completed", status: "Done", line: "exit code 0", exitCode: 0 });
      for (const row of fleet.rows) if (row.kind === "agent" && row.state !== "needs_input") expect(row.elapsed).toBeDefined();
    });

    it("cuts a large tree deepest-first and says how many rows were left out", async () => {
      world.definitions.sync(snapshotWith([PARENT, WORKER, REVIEWER], 4));
      const root = world.openRoot("lead");
      // Three children, each with a child of its own; the root runs 46 commands. 52 rows in all.
      for (let i = 0; i < 3; i++) {
        await root.handle.bridge.startAgent({ agentName: "worker", subagentName: `c${i}`, task: "t" });
        await world.harness.bridgeOf(`/sessions/child-${i * 2 + 1}.jsonl`)!.startAgent({ agentName: "worker", subagentName: `g${i}`, task: "t" });
      }
      world.tasks.set(root.path, Array.from({ length: 46 }, (_, i) => task(`t-${String(i).padStart(2, "0")}`, root.path, "running")));
      const fleet = await root.handle.bridge.inspectFleet();
      expect(fleet).toMatchObject({ total: 52, omitted: 2, working: 52 });
      const kept = fleet.rows.flatMap((row) => [row, ...row.children]);
      expect(kept).toHaveLength(50);
      // The deepest rows go first, newest first among them: g2 and g1 are gone, g0 stays.
      expect(fleet.rows.slice(0, 3).map((row) => row.children.map((c) => c.title))).toEqual([["g0"], [], []]);
      expect(fleet.rows.filter((row) => row.kind === "command")).toHaveLength(46);
    });

    it("reads a command of an agent under this session from its log, and refuses one outside the tree", async () => {
      const root = world.openRoot("lead");
      const child = await root.handle.bridge.startAgent({ agentName: "worker", subagentName: "w1", task: "t" });
      const childPath = "/sessions/child-1.jsonl";
      const grand = await world.harness.bridgeOf(childPath)!.startAgent({ agentName: "worker", subagentName: "w2", task: "t2" });
      const log = join(mkdtempSync(join(tmpdir(), "fleet-log-")), "t-grand.log");
      writeFileSync(log, "one\ntwo\nthree\n");
      world.tasks.set("/sessions/child-2.jsonl", [task("t-grand", "/sessions/child-2.jsonl", "completed", { exitCode: 0, outputBytes: 14, logPath: log }), task("t-quiet", "/sessions/child-2.jsonl", "running", { activity: "still going" })]);
      world.tasks.set("/sessions/other.jsonl", [task("t-other", "/sessions/other.jsonl", "running", { logPath: log })]);
      const readTask = world.opened[0]!.agent.backgroundWork!.readTask!;
      // The child's options read its own child's command; the root's read the grandchild's too.
      const read = await readTask("t-grand", 2);
      expect(read).toEqual({ task: expect.objectContaining({ id: "t-grand", status: "completed", exitCode: 0 }), owner: { agentName: "worker", subagentName: "w2", sessionId: grand.sessionId }, text: "two\nthree" });
      expect(read.task).not.toHaveProperty("logPath");
      expect(read.task).not.toHaveProperty("sessionPath");
      const rootRead = await root.handle.backgroundWork("/repo")!.readTask!("t-grand", 10);
      expect(rootRead.text).toBe("one\ntwo\nthree");
      // No log file: the record comes back and the text is absent, never an empty pane pretending to be output.
      expect(await readTask("t-quiet", 5)).toEqual({ task: expect.objectContaining({ id: "t-quiet", activity: "still going" }), owner: expect.objectContaining({ subagentName: "w2" }) });
      // Outside the tree, or nowhere: refused with the sentence that names the way in.
      await expect(readTask("t-other", 5)).rejects.toThrow(/"t-other" is not in the tree under this session.*inspect_fleet/s);
      await expect(readTask("t-nope", 5)).rejects.toThrow(/is not in the tree under this session/);
      // A grandchild reads nothing of its parent's.
      world.tasks.set(childPath, [task("t-child", childPath, "running", { logPath: log })]);
      await expect(world.opened[1]!.agent.backgroundWork!.readTask!("t-child", 5)).rejects.toThrow(/is not in the tree under this session/);
      void child;
    });
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
    // One session, one row, standing on its newest run.
    expect((await root.handle.bridge.inspectFleet()).rows.map((r) => (r.kind === "agent" ? r.runId : r.taskId))).toEqual([followUp.runId]);
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
    expect((await root.handle.bridge.inspectFleet()).rows).toEqual([]);
  });

  it("says a run exactly once, as `agents/run`, and never a second time as something else", async () => {
    const root = world.openRoot("lead");
    const { runId } = await root.handle.bridge.startAgent({ agentName: "worker", subagentName: "fix-login", task: "t" });
    // D-140: `agents/run` is the single truth. The parent-side run panel that
    // used to carry the same facts is gone with the panels, so there is no
    // second copy to drift.
    expect(world.runsNotified().at(-1)).toMatchObject({
      runId,
      subagentName: "fix-login",
      status: "running",
      sessionPath: "/sessions/child-1.jsonl",
      parent: { sessionPath: root.path },
    });
    expect(world.extensionMessages().some((m) => m.message.type.startsWith("lasercode/panel"))).toBe(false);

    await world.harness.bridgeOf("/sessions/child-1.jsonl")!.completeRun({ status: "completed", message: "done" });
    expect(world.runsNotified().at(-1)).toMatchObject({ runId, status: "completed", endedAt: expect.any(String) });
    expect(world.extensionMessages().some((m) => m.message.type.startsWith("lasercode/panel"))).toBe(false);
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

  // ---------------------------------------------------------------- worktree
  // The parent chooses: `worktree: false` is its judgement that this child
  // only reads. The child keeps every tool (D-144) and is told where it is.

  it("runs a child started with worktree false in the parent's own checkout, with no worktree and no branch", async () => {
    const root = world.openRoot("lead");
    const result = await root.handle.bridge.startAgent({ agentName: "worker", subagentName: "review", task: "Review the auth changes.", worktree: false });
    expect(result).toMatchObject({ subagentName: "review", sessionId: "child-1", status: "running", cwd: "/repo" });
    expect(result).not.toHaveProperty("branch");
    expect(world.worktrees.created).toHaveLength(0);
    const open = world.opened[0]!;
    expect(open.cwd).toBe("/repo");
    expect(open.agent.backgroundWork).toMatchObject({ cwd: "/repo", foregroundCommandSeconds: 120 });
    expect(open.agent.record).not.toHaveProperty("worktree");
    expect(open.agent.role).toMatchObject({ isolated: false });
    const run = world.harness.run(result.runId)!;
    expect(run.worktree).toBeNull();
    expect(run.cwd).toBe("/repo");
    // Nothing else about the harness changes: it still completes only through the tool.
    const child = world.harness.bridgeOf("/sessions/child-1.jsonl")!;
    expect(await child.completeRun({ status: "completed", message: "Reviewed; two notes." })).toEqual({ ok: true, runId: result.runId });
  });

  it("still gives a worktree when the flag is absent or true, and refuses anything that is not a boolean", async () => {
    const root = world.openRoot("lead");
    const absent = await root.handle.bridge.startAgent({ agentName: "worker", subagentName: "a", task: "t" });
    expect(absent.branch).toBe("agents/a");
    expect(world.harness.run(absent.runId)!.worktree).toMatchObject({ branch: "agents/a" });
    const asked = await root.handle.bridge.startAgent({ agentName: "worker", subagentName: "b", task: "t", worktree: true });
    expect(asked.branch).toBe("agents/b");
    expect(world.worktrees.created).toHaveLength(2);
    await expect(root.handle.bridge.startAgent({ agentName: "worker", subagentName: "c", task: "t", worktree: "false" as unknown as boolean })).rejects.toThrow(/worktree must be true or false/);
    expect(world.worktrees.created).toHaveLength(2);
  });

  it("starts an uninsulated child in a project that cannot give a worktree at all", async () => {
    const root = world.openRoot("lead");
    world.setRefuseWorktrees("This project is not a git repository, so agents cannot get an isolated worktree. Initialise git in the project first.");
    await expect(root.handle.bridge.startAgent({ agentName: "worker", subagentName: "iso", task: "t" })).rejects.toThrow(/not a git repository/);
    const shared = await root.handle.bridge.startAgent({ agentName: "worker", subagentName: "read", task: "t", worktree: false });
    expect(shared).toMatchObject({ status: "running", cwd: "/repo" });
    expect(world.harness.run(shared.runId)!.worktree).toBeNull();
  });

  it("removes nothing when a child with no worktree fails to open, ends, or has its session deleted", async () => {
    const root = world.openRoot("lead");
    world.setFailOpen(true);
    await expect(root.handle.bridge.startAgent({ agentName: "worker", subagentName: "w", task: "t", worktree: false })).rejects.toThrow(/Could not start worker/);
    expect(world.worktrees.removed).toEqual([]);

    world.setFailOpen(false);
    const started = await root.handle.bridge.startAgent({ agentName: "worker", subagentName: "read", task: "t", worktree: false });
    await world.harness.bridgeOf("/sessions/child-1.jsonl")!.completeRun({ status: "completed", message: "done" });
    expect(world.worktrees.removed).toEqual([]);
    await world.harness.removeWorktreeFor("/sessions/child-1.jsonl");
    expect(world.worktrees.removed).toEqual([]);
    expect(world.harness.run(started.runId)!.status).toBe("completed");
  });

  // M13-T42 / D-157: merging and removing a child's worktree belong to the
  // parent, so the parent gets a verb for the removal — and only for it.
  describe("the parent removes a child's worktree", () => {
    async function finishedChild() {
      const parent = world.openRoot("lead");
      const started = await parent.handle.bridge.startAgent({ agentName: "worker", subagentName: "iso", task: "t" });
      const child = world.harness.bridgeOf("/sessions/child-1.jsonl")!;
      await child.completeRun({ status: "completed", message: "done" });
      return { parent, started, child };
    }

    it("removes a finished child's worktree, by sessionId or runId, and leaves the registry honest", async () => {
      const { parent, started } = await finishedChild();
      const result = await parent.handle.bridge.removeAgentWorktree({ sessionId: started.sessionId });
      // The bridge speaks the harness's camel case; the module renames it for the model.
      expect(result).toMatchObject({ removed: true, branch: "agents/iso", agentName: "worker", subagentName: "iso", sessionId: started.sessionId });
      expect(world.worktrees.removedWith).toEqual([{ root: "/repo", path: result.path, branch: "agents/iso" }]);
      // Nothing may keep offering a path that is no longer on disk.
      expect(world.harness.run(started.runId)!.worktree).toMatchObject({ branch: "agents/iso", removedAt: expect.any(String) });
      expect(world.runsNotified().at(-1)!.worktree?.removedAt).toBeTruthy();
      // Twice is a refusal, not a second `git worktree remove`.
      await expect(parent.handle.bridge.removeAgentWorktree({ runId: started.runId })).rejects.toThrow(/already been removed/);
      expect(world.worktrees.removed).toHaveLength(1);
    });

    it("refuses while the child is still working, and says how to end it", async () => {
      const parent = world.openRoot("lead");
      const started = await parent.handle.bridge.startAgent({ agentName: "worker", subagentName: "iso", task: "t" });
      await expect(parent.handle.bridge.removeAgentWorktree({ runId: started.runId })).rejects.toThrow(/still working.*stop_agent/s);
      expect(world.worktrees.removed).toEqual([]);
    });

    it("refuses a child that has no worktree, without naming a branch it never had", async () => {
      const parent = world.openRoot("lead");
      const started = await parent.handle.bridge.startAgent({ agentName: "worker", subagentName: "read", task: "t", worktree: false });
      await world.harness.bridgeOf("/sessions/child-1.jsonl")!.completeRun({ status: "completed", message: "read it" });
      const refusal = await parent.handle.bridge.removeAgentWorktree({ runId: started.runId }).catch((error: Error) => error.message);
      expect(refusal).toContain("ran in your own checkout");
      expect(refusal).toContain("nothing to merge and nothing to remove");
      expect(refusal).not.toContain("agents/");
      expect(world.worktrees.removed).toEqual([]);
    });

    it("refuses unmerged work, says what it is and how to merge it, and obeys force", async () => {
      const { parent, started } = await finishedChild();
      world.setWorktreeFacts({ exists: true, unmergedCommits: 3, uncommittedFiles: 2 });
      const refusal = await parent.handle.bridge.removeAgentWorktree({ runId: started.runId }).catch((error: Error) => error.message);
      expect(refusal).toContain("3 commits your checkout does not have and 2 uncommitted files");
      expect(refusal).toContain("git merge agents/iso");
      expect(refusal).toContain("force true");
      expect(world.worktrees.removed).toEqual([]);
      expect(world.harness.run(started.runId)!.worktree?.removedAt).toBeUndefined();

      const forced = await parent.handle.bridge.removeAgentWorktree({ runId: started.runId, force: true });
      expect(forced.discarded).toEqual({ commits: 3, uncommittedFiles: 2 });
      expect(world.worktrees.removed).toHaveLength(1);
    });

    it("refuses when git cannot say what the branch holds, rather than guessing it is empty", async () => {
      const { parent, started } = await finishedChild();
      world.setWorktreeFacts({ exists: true, unmergedCommits: null, uncommittedFiles: null, detail: "not a git repository" });
      await expect(parent.handle.bridge.removeAgentWorktree({ runId: started.runId })).rejects.toThrow(/could not count/);
      expect(world.worktrees.removed).toEqual([]);
    });

    it("refuses a run another session started, and a call that names no agent at all", async () => {
      const { started } = await finishedChild();
      const stranger = world.openRoot("lead", "/sessions/other.jsonl", "other-1");
      await expect(stranger.handle.bridge.removeAgentWorktree({ runId: started.runId })).rejects.toThrow(/was started by this session/);
      await expect(stranger.handle.bridge.removeAgentWorktree({ sessionId: "session-nobody" })).rejects.toThrow(/among the agents this session started/);
      await expect(stranger.handle.bridge.removeAgentWorktree({})).rejects.toThrow(/sessionId or one of its runIds/);
      expect(world.worktrees.removed).toEqual([]);
    });

    it("leaves the worktree alone when git cannot find the repository it belongs to", async () => {
      const { parent, started } = await finishedChild();
      world.setWorktreeRoot(undefined);
      await expect(parent.handle.bridge.removeAgentWorktree({ runId: started.runId })).rejects.toThrow(/Could not find the git repository/);
      expect(world.worktrees.removed).toEqual([]);
    });
  });
});
