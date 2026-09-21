/**
 * M13-T3 · WorkerServer with a fake driver: agent-aware `session/new` and
 * `session/load`, the agent info on every state a client sees, user-origin
 * runs from `session/prompt`, `agents/sync`, `agents/runs/stop`, and the
 * ending a run on the person's behalf.
 */
import { PRODUCT_NAME, PROJECT_DIR_NAME, SESSION_AGENT_ENTRY_TYPE, type AgentRun, type ContentBlock, type JsonRpcMessage, type SessionState, type UiDialogResponse } from "@lasercode/protocol";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { execFileSync } from "node:child_process";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { fallbackSnapshot } from "../../src/agents/definitions.js";
import type { CompletionRuntime } from "../../src/agents/session-naming.js";
import type { DriverEvent, DriverListener, DriverOpenOptions, PromptOptions, SessionDriver } from "../../src/driver.js";
import { WorkerServer } from "../../src/server.js";

let base: string;
let counter = 0;

class FakeDriver implements SessionDriver {
  readonly kind = "stable-sdk" as const;
  opened!: DriverOpenOptions;
  prompted: Array<{ content: ContentBlock[]; options: PromptOptions | undefined }> = [];
  promptObserved: ((content: ContentBlock[]) => void) | undefined;
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
  async prompt(content: ContentBlock[], options?: PromptOptions) {
    this.prompted.push({ content, options });
    options?.onAccepted?.();
    this.promptObserved?.(content);
    return { accepted: true, queued: false };
  }
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
  async entries() { return { entries: [], leafId: null }; }
  async appendEntry(type: string, data: unknown) { this.custom.push({ type, data }); return "e"; }
  async dispose() { this.emit({ type: "closed", reason: "disposed" }); }
}

/** A model runtime for naming that never touches the engine; `calls` counts completions. */
function fakeNamingRuntime(answer: () => string | Promise<string>): CompletionRuntime & { calls: number } {
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

/** The snapshot a host sends once naming has a profile, plus the profile itself. */
const NAMING_PROFILE_ID = "mp_testnaming000000000000";

function writeNamingProfile(): void {
  mkdirSync(join(base, "agent"), { recursive: true });
  writeFileSync(
    join(base, "agent", "settings.json"),
    JSON.stringify({
      modelProfiles: [{
        id: NAMING_PROFILE_ID,
        name: "Fast",
        models: [{ provider: "stub", id: "stub-1" }],
        origin: "seeded",
        updatedAt: "2026-01-01T00:00:00.000Z",
      }],
      defaultProfileId: NAMING_PROFILE_ID,
      namingProfileId: NAMING_PROFILE_ID,
    }),
  );
}

/** Let every floated naming/labelling promise settle. */
const tick = () => new Promise<void>((resolve) => setTimeout(resolve, 0));

function harness(options: { namingModels?: () => Promise<CompletionRuntime>; projectTrusted?: boolean } = {}) {
  if (options.namingModels) writeNamingProfile();
  const out: JsonRpcMessage[] = [];
  const drivers: FakeDriver[] = [];
  const server = new WorkerServer({
    cwd: join(base, "project"),
    agentDir: join(base, "agent"),
    sessionDir: join(base, "sessions"),
    stateDir: join(base, "state"),
    createDriver: () => { const d = new FakeDriver(); drivers.push(d); return d; },
    send: (m) => out.push(m),
    ...(options.namingModels ? { namingModels: options.namingModels } : {}),
    ...(options.projectTrusted !== undefined ? { projectTrusted: options.projectTrusted } : {}),
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
  it.each([true, false])("honours host project trust for child setup (trusted=%s)", async (projectTrusted) => {
    const project = join(base, "project");
    const git = (...args: string[]) => execFileSync("git", args, { cwd: project, env: { ...process.env, GIT_AUTHOR_NAME: "t", GIT_AUTHOR_EMAIL: "t@x", GIT_COMMITTER_NAME: "t", GIT_COMMITTER_EMAIL: "t@x" } });
    git("init", "-q", "-b", "main");
    writeFileSync(join(project, "source"), "base");
    git("add", "."); git("commit", "-qm", "base");
    mkdirSync(join(project, PROJECT_DIR_NAME));
    const hook = join(project, PROJECT_DIR_NAME, "worktree-setup");
    writeFileSync(hook, "#!/bin/sh\necho done > setup-ran\n");
    chmodSync(hook, 0o755);
    const h = harness({ projectTrusted });
    try {
      await h.call(1, "session/new", { cwd: project });
      const bridge = h.drivers[0]!.opened.agent!.bridge;
      const started = await bridge.startAgent({ agentName: "default", subagentName: "trust", task: "work" });
      const status = projectTrusted ? "ok" : "skipped-untrusted";
      await vi.waitFor(async () => expect((await bridge.inspectAgent({ runId: started.runId })).setup?.status).toBe(status));
      expect(existsSync(join(started.cwd, "setup-ran"))).toBe(projectTrusted);
      expect(h.drivers[1]!.opened.agent!.bridge.role().setup?.status).toBe(status);
    } finally { await h.server.dispose(); }
  });
  it("reloads an unfinished setup as cancelled in the child's live role", async () => {
    const tree = join(base, "project", ".worktrees", "child");
    mkdirSync(tree, { recursive: true });
    const path = join(base, "sessions", "pending-setup.jsonl");
    const logPath = join(tree, "setup.log");
    const data = { agentName: "default", kind: "child", parentPath: join(base, "sessions", "parent.jsonl"), parentSessionId: "parent", worktree: { path: tree, branch: "agents/child", baseCommit: "abc", setup: { status: "pending", logPath } } };
    writeFileSync(path, JSON.stringify({ type: "session", id: "child", cwd: tree }) + "\n" + JSON.stringify({ type: "custom", customType: SESSION_AGENT_ENTRY_TYPE, data }) + "\n");
    const h = harness();
    try {
      expect((await h.call(1, "session/load", { path })).error).toBeUndefined();
      expect(h.drivers[0]!.opened.agent!.bridge.role().setup).toEqual({ status: "cancelled", logPath });
    } finally { await h.server.dispose(); }
  });

  it("opens a new session as the default agent and reports it on the state", async () => {
    const h = harness();
    const created = await h.call(1, "session/new", { cwd: join(base, "project") });
    expect(created.result).toMatchObject({ state: { agent: { agentName: "default", kind: "root" } } });
    const opened = h.drivers[0]!.opened;
    expect(opened.agent).toMatchObject({ definition: { name: "default", engineInstructions: true }, role: { agentName: "default", kind: "root", depth: 0 }, record: { agentName: "default", kind: "root" }, policy: { maxDepth: 3 } });
    expect(opened.agent?.bridge).toBeDefined();
    expect(opened.agent?.backgroundWork).toMatchObject({ cwd: join(base, "project"), foregroundCommandSeconds: 120 });
    // Bound to the session: `task_output` on a command of an agent under it goes through the worker (D-163).
    expect(typeof opened.agent?.backgroundWork?.readTask).toBe("function");
  });

  it("opens a plain chat with no definition and no agent name, and refuses names nothing answers to", async () => {
    const h = harness();
    const chat = await h.call(1, "session/new", { cwd: join(base, "project"), sessionKind: "chat" });
    expect(chat.result).toMatchObject({ state: { agent: { kind: "chat", sessionKind: "chat" } } });
    expect((chat.result as { state: SessionState }).state.agent).not.toHaveProperty("agentName");
    // No definition at all: no persona, no scoped skills, nothing to edit.
    expect(h.drivers[0]!.opened.agent?.definition).toBeUndefined();
    expect(h.drivers[0]!.opened.agent?.record).toEqual({ kind: "chat" });
    // The names that used to be built-in agents answer to nothing now.
    for (const [id, name] of [[2, "beam"], [3, "chat"], [4, "namer"], [5, "nobody"]] as const) {
      expect((await h.call(id, "session/new", { cwd: join(base, "project"), agentName: name })).error?.message)
        .toMatch(new RegExp(`No agent is called "${name}"`));
    }
  });

  it("uses the synced default agent and definitions", async () => {
    const h = harness();
    const snapshot = fallbackSnapshot();
    const lead = { ...snapshot.agents[0]!, name: "lead", instructions: "Lead.", engineInstructions: false };
    expect((await h.call(1, "agents/sync", { snapshot: { ...snapshot, revision: 3, agents: [...snapshot.agents, lead], defaultAgent: "lead" } })).result).toEqual({});
    const created = await h.call(2, "session/new", { cwd: join(base, "project") });
    expect(created.result).toMatchObject({ state: { agent: { agentName: "lead", kind: "root", sessionKind: "project" } } });
    expect(h.drivers[0]!.opened.agent?.definition?.instructions).toBe("Lead.");

    // A later sync replaces the definition a new session runs.
    const revised = { ...lead, instructions: "Answer every question as a patient teacher." };
    await h.call(3, "agents/sync", { snapshot: { ...snapshot, revision: 4, agents: [...snapshot.agents, revised], defaultAgent: "lead" } });
    await h.call(4, "session/new", { cwd: join(base, "project") });
    expect(h.drivers.at(-1)!.opened.agent?.definition?.instructions).toBe("Answer every question as a patient teacher.");
  });

  it("recovers a stored child session's agent from its record and decorates state updates", async () => {
    const h = harness();
    const environment = { path: "/w", branch: "agents/fixer", baseCommit: "abc", parentCheckout: join(base, "project"), absentDirectories: ["build-cache/"] };
    const setup = { status: "failed", exitCode: 2, logPath: "/w/setup.log" };
    const parentPath = join(base, "sessions", "parent.jsonl");
    const childPath = join(base, "sessions", "child.jsonl");
    writeFileSync(parentPath, `${JSON.stringify({ type: "session", id: "p" })}\n${JSON.stringify({ type: "custom", customType: SESSION_AGENT_ENTRY_TYPE, data: { agentName: "default", kind: "root" } })}\n`);
    writeFileSync(childPath, `${JSON.stringify({ type: "session", id: "c" })}\n${JSON.stringify({ type: "custom", customType: SESSION_AGENT_ENTRY_TYPE, data: { agentName: "default", kind: "child", subagentName: "fixer", parentPath, parentSessionId: "p", rootPath: parentPath, runId: "run_old", worktree: { path: "/w", branch: "agents/fixer", baseCommit: "abc", environment, setup } } })}\n`);
    const loaded = await h.call(1, "session/load", { path: childPath });
    expect(loaded.result).toMatchObject({ state: { agent: { agentName: "default", kind: "child", subagentName: "fixer", parentPath, rootPath: parentPath } } });
    const state = (loaded.result as { state: SessionState }).state;
    expect(state.agent?.runId).toBeUndefined(); // idle: no live run after a reload
    expect(h.drivers[0]!.opened.agent?.role).toMatchObject({ kind: "child", depth: 1, subagentName: "fixer", parent: { sessionPath: parentPath, sessionId: "p", agentName: "default" } });
    // A person's prompt on the idle child starts a user-origin run through
    // the harness, preserving the exact multimodal payload at the real server caller.
    const content: ContentBlock[] = [
      { type: "text", text: "what changed?" },
      { type: "image", mimeType: "image/png", data: "AAAA" },
    ];
    await h.call(2, "session/prompt", { path: childPath, content });
    expect(h.drivers[0]!.prompted[0]?.content).toEqual(content);
    expect(h.drivers[0]!.prompted[0]?.options?.onAccepted).toBeTypeOf("function");
    const runs = h.notifications("agents/run").map((n) => (n.params as { run: AgentRun }).run);
    expect(runs.at(-1)).toMatchObject({ origin: "user", status: "running", sessionPath: childPath, parent: { sessionPath: parentPath, sessionId: "p" }, task: "what changed?" });
    expect(runs.at(-1)?.worktree).toMatchObject({ environment, setup });
    // State updates carry the agent info, including the live run.
    h.drivers[0]!.emit({ type: "update", update: { kind: "state", state: h.drivers[0]!.state() } });
    const update = h.notifications("session/update").map((n) => n.params as { update: { kind: string; state?: SessionState } }).find((u) => u.update.kind === "state")!;
    expect(update.update.state?.agent).toMatchObject({ kind: "child", runId: runs.at(-1)!.runId, runStatus: "running" });
    // A second prompt while the run is active starts no second run.
    await h.call(3, "session/prompt", { path: childPath, content: [{ type: "text", text: "more" }] });
    expect(h.notifications("agents/run").filter((n) => (n.params as { run: AgentRun }).run.status === "running")).toHaveLength(1);

    // The real tray drain caller also crosses the harness boundary. Its
    // onAccepted acknowledgement removes the item at the engine boundary.
    let trayAccepted!: () => void;
    const trayAcceptedPromise = new Promise<void>((resolve) => { trayAccepted = resolve; });
    h.drivers[0]!.promptObserved = (promptContent) => {
      if (promptContent.some((block) => block.type === "text" && block.text === "from tray")) trayAccepted();
    };
    await h.call(4, "session/pending/add", { path: childPath, content: [{ type: "text", text: "from tray" }] });
    h.drivers[0]!.emit({ type: "update", update: { kind: "agent_settled" } });
    await trayAcceptedPromise;
    expect(h.drivers[0]!.prompted.at(-1)?.content).toEqual([{ type: "text", text: "from tray" }]);
    expect((await h.call(5, "session/pending/list", { path: childPath })).result).toEqual({ messages: [] });

    // A person ends the run.
    const runId = runs.at(-1)!.runId;
    const stopped = await h.call(6, "agents/runs/stop", { runId, reason: "enough" });
    expect(stopped.result).toMatchObject({ run: { runId, status: "cancelled", endedBy: { initiator: "user", reason: "enough" } } });
    expect(h.drivers[0]!.aborts).toBe(1);
    expect((await h.call(7, "agents/runs/stop", { runId: "run_unknown" })).error?.message).toMatch(/No run is called run_unknown/);
    // The run is published once, as itself; nothing publishes it a second time.
    expect(h.notifications("agents/run").map((n) => (n.params as { run: AgentRun }).run).at(-1)).toMatchObject({ runId, status: "cancelled" });
    expect(h.notifications("pi/extension/message").some((n) => String((n.params as { message: { type: string } }).message.type).startsWith("lasercode/panel"))).toBe(false);
  });

  // A fork moves a session's file. Everything this worker holds under the old
  // path has to move with it, or the session half exists: findings #5 and #6.
  it("moves a forked child's run, its commands and its place in the fleet", async () => {
    const h = harness();
    const created = await h.call(1, "session/new", { cwd: join(base, "project") });
    const rootPath = (created.result as { state: SessionState }).state.path;
    const parent = h.server.agents().bridgeOf(rootPath)!;
    const started = await parent.startAgent({ agentName: "default", subagentName: "forked", task: "work", worktree: false });
    const childDriver = h.drivers[1]!;
    const childPath = childDriver.state().path;
    const command = { id: "t-dev", command: "pnpm vite dev", title: "pnpm vite dev", status: "running" as const, origin: "background" as const, startedAt: new Date(Date.now() - 5_000).toISOString(), outputBytes: 240, activity: "ready in 412 ms" };
    childDriver.emit({ type: "extension", message: { type: "lasercode/task/update", task: command } });
    expect(h.server.agents().activeRun(childPath)?.runId).toBe(started.runId);

    // The person forks the child's conversation while its run is still going.
    const forked = await h.call(2, "pi/session/fork", { path: childPath, entryId: "e1" });
    const newPath = (forked.result as { state: SessionState }).state.path;
    expect(newPath).not.toBe(childPath);

    // The run followed the driver that is executing it.
    expect(h.server.agents().run(started.runId)).toMatchObject({ sessionPath: newPath, status: "running" });
    expect(h.server.agents().activeRun(newPath)?.runId).toBe(started.runId);
    expect(h.server.agents().activeRun(childPath)).toBeUndefined();

    // The parent still sees the child, and the child's command under it.
    const fleet = await parent.inspectFleet();
    expect(fleet.rows.map((row) => row.title)).toEqual(["Forked"]);
    expect(fleet.rows[0]!.children.map((row) => row.title)).toEqual(["pnpm vite dev"]);
    expect(fleet.rows[0]!.children[0]).toMatchObject({ kind: "command", taskId: "t-dev", status: "Working" });

    // And stopping it reaches the driver, rather than marking a run cancelled
    // while the child carries on working.
    const stopped = await h.call(3, "agents/runs/stop", { runId: started.runId, reason: "enough" });
    expect(stopped.result).toMatchObject({ run: { runId: started.runId, status: "cancelled", sessionPath: newPath } });
    expect(childDriver.aborts).toBe(1);
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
    // The listing contains only user- and project-discovered skills; the product adds none.
    for (const skill of skills.skills as Array<{ scope: string }>) expect(["global", "project"]).toContain(skill.scope);
    const instructions = (await h.call(2, "agents/engine-instructions", { cwd: join(base, "project") })).result as { text: string };
    expect(instructions.text).toContain("{{availableTools}}");
    expect((await h.call(3, "agents/list", {})).error?.message).toMatch(/answered by the host/);
  });

  it("does not name a session when nothing is assigned to naming", async () => {
    // There is no built-in to be unavailable: with no assignment the request
    // does not run, nothing is parked and no model is asked (`docs/plain-chat.md`).
    const runtime = fakeNamingRuntime(() => "Fix the login form");
    const h = harness();
    const created = await h.call(1, "session/new", { cwd: join(base, "project") });
    const path = (created.result as { state: SessionState }).state.path;
    await h.call(2, "session/prompt", { path, content: [{ type: "text", text: "please fix the login form" }] });
    await tick();
    expect(h.drivers[0]!.state().name).toBeUndefined();
    expect(runtime.calls).toBe(0);
    await h.call(3, "agents/sync", { snapshot: fallbackSnapshot() });
    await tick();
    expect(h.drivers[0]!.state().name).toBeUndefined();
    expect(runtime.calls).toBe(0);
  });

  it("names on the first prompt once a model is there, and leaves a named session alone", async () => {
    const runtime = fakeNamingRuntime(() => '"Rename the auth module."');
    const h = harness({ namingModels: async () => runtime });
    await h.call(1, "agents/sync", { snapshot: fallbackSnapshot() });
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

  it("asks for no model completion when a tool starts", async () => {
    const runtime = fakeNamingRuntime(() => "This must not be requested");
    const h = harness({ namingModels: async () => runtime });
    await h.call(1, "agents/sync", { snapshot: fallbackSnapshot() });
    await h.call(2, "session/new", { cwd: join(base, "project") });
    h.drivers[0]!.emit({ type: "update", update: { kind: "tool_execution_start", toolCallId: "t1", toolName: "bash", args: { command: "ls", activity_label: "Listing files" } } });
    await tick();
    expect(runtime.calls).toBe(0);
    expect(h.notifications("pi/extension/message").some((notification) =>
      (notification.params as { message: { type: string } }).message.type.includes("label"),
    )).toBe(false);
  });

  // D-163: a background command going past the worker is indexed there, so
  // the harness can put it beside the runs in the fleet an agent reads, and
  // a closed session's running commands are recorded as stopped.
  it("indexes background commands as they go past and shows them in the session's fleet", async () => {
    const h = harness();
    const created = await h.call(1, "session/new", { cwd: join(base, "project") });
    const path = (created.result as { state: SessionState }).state.path;
    const bridge = h.server.agents().bridgeOf(path)!;
    expect(await bridge.inspectFleet()).toEqual({ rows: [], working: 0, needsYou: 0, finished: 0, total: 0, omitted: 0 });
    const driver = h.drivers[0]!;
    const update = { id: "t-dev", command: "pnpm vite dev", title: "pnpm vite dev", status: "running" as const, origin: "background" as const, startedAt: new Date(Date.now() - 5_000).toISOString(), outputBytes: 240, activity: "ready in 412 ms", logPath: join(base, "t-dev.log") };
    driver.emit({ type: "extension", message: { type: "lasercode/task/update", task: update } });
    // Still forwarded to the host, unchanged.
    expect(h.notifications("pi/extension/message").at(-1)!.params).toMatchObject({ path, message: { type: "lasercode/task/update", task: { id: "t-dev", logPath: join(base, "t-dev.log") } } });
    const fleet = await bridge.inspectFleet();
    expect(fleet).toMatchObject({ working: 1, finished: 0, total: 1 });
    expect(fleet.rows[0]).toMatchObject({ kind: "command", taskId: "t-dev", title: "pnpm vite dev", status: "Working", line: "ready in 412 ms", depth: 0 });
    // An update replaces in place.
    driver.emit({ type: "extension", message: { type: "lasercode/task/update", task: { ...update, status: "completed", exitCode: 0, endedAt: new Date().toISOString() } } });
    expect((await bridge.inspectFleet()).rows).toEqual([expect.objectContaining({ taskId: "t-dev", state: "completed", status: "Done", line: "exit code 0" })]);
    // A session that closes under a running command leaves it stopped, not spinning.
    driver.emit({ type: "extension", message: { type: "lasercode/task/update", task: { ...update, id: "t-live" } } });
    await driver.dispose();
    expect(h.server.openSessions()).toEqual([]);
    const reopened = await h.call(2, "session/load", { path });
    expect(reopened.error).toBeUndefined();
    const again = h.server.agents().bridgeOf(path)!;
    expect((await again.inspectFleet()).rows.map((row) => [row.title, row.status, row.line])).toEqual([
      ["pnpm vite dev", "Done", "exit code 0"],
      ["pnpm vite dev", "Ended", "the session ended"],
    ]);
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
