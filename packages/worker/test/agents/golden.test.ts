/**
 * M13-T3 · the golden path against the real engine: a parent session whose
 * model calls `start_agent`, a child in a `.worktrees/` checkout whose model
 * calls `complete_agent_run`, the run reaching `completed`, and the parent
 * receiving one `AGENT_EVENT_MESSAGE_TYPE` custom message with that result —
 * without ever waiting: there is no waiting tool (M13-T45), and the parent's
 * turn ends after `start_agent`.
 *
 * M13-T45 · the other golden path: a child raises a question through the
 * portable UI surface while a tool runs, the run is `needs_input`, the parent
 * is woken, reads the question through `inspect_agent`, answers it through
 * `send_agent_message`, and the child's dialog resolves with that answer.
 *
 * Needs the companion extension's harness module (Lane X). Until its
 * `start_agent` registration exists the suite is skipped, and says so.
 */
import { AGENT_EVENT_MESSAGE_TYPE, PRODUCT_NAME, SESSION_AGENT_ENTRY_TYPE, WORKTREES_DIR_NAME, type AgentRun, type JsonRpcMessage } from "@lasercode/protocol";
import type { SessionDriver } from "../../src/driver.js";
import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { fallbackSnapshot } from "../../src/agents/definitions.js";
import { StableSdkDriver } from "../../src/drivers/stable-sdk.js";
import { WorkerServer } from "../../src/server.js";
import { startStubProvider, toolNamesOf, writeStubModels, type StubProvider, type StubRequest } from "./stub-provider.js";

/** True once the companion extension's built module registers the harness tools. */
const harnessModulePresent = (() => {
  try {
    const modulePath = join(import.meta.dirname, "..", "..", "..", "pi-extension", "dist", "modules", "subagents.js");
    return existsSync(modulePath) && readFileSync(modulePath, "utf8").includes("start_agent");
  } catch {
    return false;
  }
})();

const haveGit = (() => {
  try {
    execFileSync("git", ["--version"], { stdio: "ignore" });
    return true;
  } catch {
    return false;
  }
})();

const ENV = { ...process.env, GIT_AUTHOR_NAME: "t", GIT_AUTHOR_EMAIL: "t@x", GIT_COMMITTER_NAME: "t", GIT_COMMITTER_EMAIL: "t@x" };
const git = (cwd: string, ...args: string[]) => execFileSync("git", args, { cwd, stdio: "pipe", env: ENV }).toString().trim();

let base: string;
let stub: StubProvider;
/** What the parent's model asks for; a test sets it before prompting. */
let startArgs: Record<string, unknown>;
/** The scripted models for the question path; a test switches this on before prompting. */
let questionScene = false;

/** The name of the last tool the model called in this request, if the last message answers it. */
function lastToolName(request: StubRequest): string | undefined {
  const last = request.messages.at(-1);
  if (last?.role !== "tool") return undefined;
  for (let i = request.messages.length - 1; i >= 0; i--) {
    const m = request.messages[i]!;
    const calls = m.tool_calls as Array<{ id?: string; function?: { name?: string } }> | undefined;
    if (m.role === "assistant" && calls?.length) {
      const named = calls.find((call) => call.id === last.tool_call_id) ?? calls.at(-1);
      return named?.function?.name;
    }
  }
  return undefined;
}

function textOfContent(content: unknown): string {
  if (typeof content === "string") return content;
  if (Array.isArray(content)) return content.map((part) => (part && typeof part === "object" && "text" in part ? String((part as { text: unknown }).text) : "")).join("");
  return "";
}

beforeEach(async () => {
  startArgs = { agent_name: "worker", subagent_name: "touch-nothing", task: "Look around and finish without changing anything." };
  questionScene = false;
  base = mkdtempSync(join(tmpdir(), `${PRODUCT_NAME}-golden-`));
  const project = join(base, "project");
  mkdirSync(project, { recursive: true });
  git(project, "init", "-q", "-b", "main");
  writeFileSync(join(project, "README.md"), "hello\n");
  git(project, "add", "README.md");
  git(project, "commit", "-q", "-m", "first");
  mkdirSync(join(base, "sessions"), { recursive: true });
  stub = await startStubProvider((request: StubRequest) => {
    const tools = toolNamesOf(request);
    const isChild = tools.includes("complete_agent_run");
    const sawToolResult = request.messages.some((m) => m.role === "tool");
    if (questionScene) {
      // The child holds a tool open long enough for a question to be raised
      // inside it; once the tool is back it ends. The parent starts the child,
      // ends its turn, and reacts to what it is sent: an open question → look
      // at it → answer it; an ending → note it.
      const last = request.messages.at(-1);
      const lastText = textOfContent(last?.content);
      if (isChild) {
        return lastToolName(request) === "bash" ? { toolCall: { name: "complete_agent_run", args: { status: "completed", message: "done: answered" } } } : { toolCall: { name: "bash", args: { command: "sleep 8" } } };
      }
      const called = lastToolName(request);
      if (called === "start_agent") return { text: "ok" };
      if (called === "inspect_agent") {
        const sessionId = /"sessionId":\s*"([^"]+)"/.exec(lastText)?.[1];
        return { toolCall: { name: "send_agent_message", args: { sessionId, message: "header" } } };
      }
      if (called === "send_agent_message") return { text: "answered" };
      if (last?.role === "user" && lastText.includes("agent.needs_input")) {
        const runId = /runId:\s*(run_[0-9a-f]+)/.exec(lastText)?.[1];
        return { toolCall: { name: "inspect_agent", args: { runId, messages: 2 } } };
      }
      if (!sawToolResult && tools.includes("start_agent")) return { toolCall: { name: "start_agent", args: startArgs } };
      return { text: "noted" };
    }
    if (isChild) {
      return sawToolResult ? { text: "done" } : { toolCall: { name: "complete_agent_run", args: { status: "completed", message: "done: touched nothing" } } };
    }
    if (!sawToolResult && tools.includes("start_agent")) {
      return { toolCall: { name: "start_agent", args: startArgs } };
    }
    return { text: "ok" };
  });
  writeStubModels(join(base, "agent"), stub.url);
});

afterEach(async () => {
  await stub.close();
  rmSync(base, { recursive: true, force: true });
});

describe.skipIf(!harnessModulePresent || !haveGit)("golden path: start_agent → complete_agent_run → parent event", () => {
  it("runs a child in a worktree to completion and reports to the parent", async () => {
    const out: JsonRpcMessage[] = [];
    const server = new WorkerServer({
      cwd: join(base, "project"),
      agentDir: join(base, "agent"),
      sessionDir: join(base, "sessions"),
      stateDir: join(base, "state"),
      createDriver: () => new StableSdkDriver(),
      send: (m) => out.push(m),
      features: ["subagents", "goals"],
      projectTrusted: true,
    });
    try {
      const call = async (id: number, method: string, params?: unknown) => {
        await server.handle({ jsonrpc: "2.0", id, method, params });
        return out.find((m) => "id" in m && m.id === id) as { result?: unknown; error?: { message: string } };
      };
      const snapshot = fallbackSnapshot();
      const model = { provider: "stub", id: "stub-1" };
      const lead = { ...snapshot.agents[0]!, name: "lead", engineInstructions: false, instructions: "You lead. Delegate to worker.", model, supportsSubagents: true, allowedAgents: ["worker"] };
      const worker = { ...snapshot.agents[0]!, name: "worker", engineInstructions: false, instructions: "You work. Call complete_agent_run when done.", model, tools: ["read", "ls"], supportsSubagents: false, allowedAgents: [] };
      expect((await call(1, "agents/sync", { snapshot: { ...snapshot, revision: 1, agents: [lead, worker, ...snapshot.agents.slice(1)], defaultAgent: "lead" } })).result).toEqual({});
      const created = await call(2, "session/new", { cwd: join(base, "project"), agentName: "lead" });
      expect(created.error).toBeUndefined();
      const parentPath = (created.result as { state: { path: string } }).state.path;
      const prompted = await call(3, "session/prompt", { path: parentPath, content: [{ type: "text", text: "Delegate a harmless look-around to the worker." }] });
      expect(prompted.result).toEqual({ accepted: true, queued: false });

      const runs = () => out.filter((m) => "method" in m && m.method === "agents/run").map((m) => (m as { params: { run: AgentRun } }).params.run);
      const deadline = Date.now() + 45_000;
      while (Date.now() < deadline && !runs().some((run) => run.status === "completed")) await new Promise((r) => setTimeout(r, 100));
      const completed = runs().find((run) => run.status === "completed");
      const diagnostics = () => JSON.stringify({
        runs: runs().map((r) => [r.runId, r.status, r.error]),
        requests: stub.requests.map((r) => ({ tools: toolNamesOf(r), roles: r.messages.map((m) => m.role) })),
        extension: out.filter((m) => "method" in m && m.method === "pi/extension/message").map((m) => (m as { params: { message: { type: string } } }).params.message).filter((msg) => msg.type !== "lasercode/provider/request" && msg.type !== "lasercode/provider/response"),
        updates: out.filter((m) => "method" in m && m.method === "session/update").map((m) => { const u = (m as { params: { update: { kind: string; message?: unknown; errorMessage?: string } } }).params.update; return u.kind === "message_end" ? `${u.kind}:${JSON.stringify(u.message).slice(0, 300)}` : u.kind + (u.errorMessage ? `:${u.errorMessage}` : ""); }),
      }, null, 1);
      expect(completed, diagnostics()).toBeDefined();
      expect(completed).toMatchObject({ agentName: "worker", subagentName: "touch-nothing", depth: 1, origin: "agent", result: { status: "completed", message: "done: touched nothing" }, parent: { sessionPath: parentPath } });
      expect(completed!.worktree?.path).toContain(join(base, "project", WORKTREES_DIR_NAME));
      expect(existsSync(completed!.worktree!.path)).toBe(true);

      // The child session file lives under the sessions dir, carries its record, and ran in the worktree.
      const wait = async (predicate: () => boolean) => { const until = Date.now() + 15_000; while (Date.now() < until && !predicate()) await new Promise((r) => setTimeout(r, 100)); };
      await wait(() => existsSync(completed!.sessionPath));
      expect(completed!.sessionPath.startsWith(join(base, "sessions"))).toBe(true);
      const childLines = readFileSync(completed!.sessionPath, "utf8").trim().split("\n").map((line) => JSON.parse(line) as { type: string; customType?: string; cwd?: string; data?: { kind?: string } });
      expect(childLines[0]?.cwd).toContain(WORKTREES_DIR_NAME);
      expect(childLines.find((line) => line.customType === SESSION_AGENT_ENTRY_TYPE)?.data).toMatchObject({ kind: "child", agentName: "worker", subagentName: "touch-nothing", parentPath });

      // The parent received exactly one agent event carrying the child's message —
      // without waiting for it: no waiting tool exists, the parent's turn ended
      // right after `start_agent`, and the result told it so.
      await wait(() => existsSync(parentPath) && readFileSync(parentPath, "utf8").includes(AGENT_EVENT_MESSAGE_TYPE));
      const parentLines = readFileSync(parentPath, "utf8").trim().split("\n").map((line) => JSON.parse(line) as { type: string; customType?: string; content?: unknown; message?: { customType?: string; content?: unknown } });
      const events = parentLines.filter((line) => line.customType === AGENT_EVENT_MESSAGE_TYPE || line.message?.customType === AGENT_EVENT_MESSAGE_TYPE);
      expect(events).toHaveLength(1);
      expect(JSON.stringify(events[0])).toContain("done: touched nothing");
      const parentTools = stub.requests.filter((r) => toolNamesOf(r).includes("start_agent")).flatMap(toolNamesOf);
      expect(parentTools).toContain("inspect_agent");
      expect(parentTools).not.toContain("wait_for_agents");
      expect(readFileSync(parentPath, "utf8")).toContain("Do not wait for touch-nothing.");
    } finally {
      await server.dispose();
    }
  }, 90_000);

  /**
   * The other way round: the parent judged this child read-only and passed
   * `worktree: false`. Nothing under `.worktrees/` is made, the child runs in
   * the project itself, and the result still says where it is working.
   */
  it("runs a child with worktree false in the parent's own checkout and says so in the result", async () => {
    startArgs = { agent_name: "worker", subagent_name: "read-only-look", task: "Read the README and finish.", worktree: false };
    const project = join(base, "project");
    const out: JsonRpcMessage[] = [];
    const server = new WorkerServer({
      cwd: project,
      agentDir: join(base, "agent"),
      sessionDir: join(base, "sessions"),
      stateDir: join(base, "state"),
      createDriver: () => new StableSdkDriver(),
      send: (m) => out.push(m),
      features: ["subagents", "goals"],
      projectTrusted: true,
    });
    try {
      const call = async (id: number, method: string, params?: unknown) => {
        await server.handle({ jsonrpc: "2.0", id, method, params });
        return out.find((m) => "id" in m && m.id === id) as { result?: unknown; error?: { message: string } };
      };
      const snapshot = fallbackSnapshot();
      const model = { provider: "stub", id: "stub-1" };
      const lead = { ...snapshot.agents[0]!, name: "lead", engineInstructions: false, instructions: "You lead. Delegate to worker.", model, supportsSubagents: true, allowedAgents: ["worker"] };
      const worker = { ...snapshot.agents[0]!, name: "worker", engineInstructions: false, instructions: "You work. Call complete_agent_run when done.", model, supportsSubagents: false, allowedAgents: [] };
      await call(1, "agents/sync", { snapshot: { ...snapshot, revision: 1, agents: [lead, worker, ...snapshot.agents.slice(1)], defaultAgent: "lead" } });
      const created = await call(2, "session/new", { cwd: project, agentName: "lead" });
      const parentPath = (created.result as { state: { path: string } }).state.path;
      await call(3, "session/prompt", { path: parentPath, content: [{ type: "text", text: "Have the worker read the README." }] });

      const runs = () => out.filter((m) => "method" in m && m.method === "agents/run").map((m) => (m as { params: { run: AgentRun } }).params.run);
      const deadline = Date.now() + 45_000;
      while (Date.now() < deadline && !runs().some((run) => run.status === "completed")) await new Promise((r) => setTimeout(r, 100));
      const completed = runs().find((run) => run.status === "completed");
      expect(completed, JSON.stringify(runs().map((r) => [r.runId, r.status, r.error]))).toBeDefined();
      expect(completed!.subagentName).toBe("read-only-look");
      expect(completed!.worktree).toBeNull();
      expect(completed!.cwd).toBe(project);
      // Nothing was created under `.worktrees/`, and nothing in the project was touched.
      expect(existsSync(join(project, WORKTREES_DIR_NAME))).toBe(false);
      expect(git(project, "status", "--porcelain")).toBe("");

      const wait = async (predicate: () => boolean) => { const until = Date.now() + 15_000; while (Date.now() < until && !predicate()) await new Promise((r) => setTimeout(r, 100)); };
      await wait(() => existsSync(completed!.sessionPath));
      const childLines = readFileSync(completed!.sessionPath, "utf8").trim().split("\n").map((line) => JSON.parse(line) as { customType?: string; cwd?: string; data?: Record<string, unknown> });
      expect(childLines[0]?.cwd).toBe(project);
      const record = childLines.find((line) => line.customType === SESSION_AGENT_ENTRY_TYPE)?.data;
      expect(record).toMatchObject({ kind: "child", subagentName: "read-only-look", parentPath });
      expect(record).not.toHaveProperty("worktree");

      // The parent's transcript carries where the child works, with no branch.
      await wait(() => existsSync(parentPath) && readFileSync(parentPath, "utf8").includes("working_directory"));
      const parentText = readFileSync(parentPath, "utf8");
      expect(parentText).toContain(`working_directory`);
      expect(parentText).toContain(project);
      expect(parentText).not.toContain("agents/read-only-look");
    } finally {
      await server.dispose();
    }
  }, 90_000);

  /**
   * M13-T45: a child paused on a question is `needs_input`, its parent is
   * woken with the question, reads it through `inspect_agent`, answers it
   * through `send_agent_message`, and the child's own dialog resolves with
   * that answer. The question is raised through the real UI bridge of the
   * child's real driver, inside a real running tool.
   */
  it("shows a child's open question to the parent as needs_input, and lets the parent answer it", async () => {
    questionScene = true;
    startArgs = { agent_name: "worker", subagent_name: "ask-first", task: "Ask which token store to use before touching anything." };
    const project = join(base, "project");
    const out: JsonRpcMessage[] = [];
    const server = new WorkerServer({
      cwd: project,
      agentDir: join(base, "agent"),
      sessionDir: join(base, "sessions"),
      stateDir: join(base, "state"),
      createDriver: () => new StableSdkDriver(),
      send: (m) => out.push(m),
      features: ["subagents", "goals"],
      projectTrusted: true,
    });
    try {
      const call = async (id: number, method: string, params?: unknown) => {
        await server.handle({ jsonrpc: "2.0", id, method, params });
        return out.find((m) => "id" in m && m.id === id) as { result?: unknown; error?: { message: string } };
      };
      const snapshot = fallbackSnapshot();
      const model = { provider: "stub", id: "stub-1" };
      const lead = { ...snapshot.agents[0]!, name: "lead", engineInstructions: false, instructions: "You lead. Delegate to worker.", model, supportsSubagents: true, allowedAgents: ["worker"] };
      const worker = { ...snapshot.agents[0]!, name: "worker", engineInstructions: false, instructions: "You work. Call complete_agent_run when done.", model, supportsSubagents: false, allowedAgents: [] };
      await call(1, "agents/sync", { snapshot: { ...snapshot, revision: 1, agents: [lead, worker, ...snapshot.agents.slice(1)], defaultAgent: "lead" } });
      const created = await call(2, "session/new", { cwd: project, agentName: "lead" });
      const parentPath = (created.result as { state: { path: string } }).state.path;
      await call(3, "session/prompt", { path: parentPath, content: [{ type: "text", text: "Delegate; the worker will ask." }] });

      const runs = () => out.filter((m) => "method" in m && m.method === "agents/run").map((m) => (m as { params: { run: AgentRun } }).params.run);
      const wait = async (predicate: () => boolean, ms = 30_000) => { const until = Date.now() + ms; while (Date.now() < until && !predicate()) await new Promise((r) => setTimeout(r, 50)); };
      const diagnostics = () => JSON.stringify({ runs: runs().map((r) => [r.runId, r.status, r.activity?.currentTool, r.error]), requests: stub.requests.map((r) => ({ tools: toolNamesOf(r).filter((t) => t.includes("agent")), last: r.messages.at(-1)?.role, called: lastToolName(r) })) }, null, 1);

      // The child is inside its tool: exactly the moment a question is raised.
      await wait(() => runs().some((run) => run.status === "running" && run.activity?.currentTool === "bash"));
      const running = runs().find((run) => run.status === "running" && run.activity?.currentTool === "bash");
      expect(running, diagnostics()).toBeDefined();
      const childPath = running!.sessionPath;
      type Internals = { ui: { context: { select(title: string, options: string[]): Promise<string | undefined> } } };
      const live = (server as unknown as { sessions: Map<string, { driver: SessionDriver }> }).sessions.get(childPath);
      expect(live, "the child's session is open in this worker").toBeDefined();
      const answered = (live!.driver as unknown as Internals).ui.context.select("Which token store?", ["cookie", "header"]);

      // The run says so, with the question and the tool that raised it.
      await wait(() => runs().some((run) => run.status === "needs_input"));
      const paused = runs().find((run) => run.status === "needs_input");
      expect(paused, diagnostics()).toBeDefined();
      expect(paused!.question).toMatchObject({ kind: "select", title: "Which token store?", options: ["cookie", "header"], toolName: "bash", toolCallId: expect.any(String) });

      // The parent was woken, looked, and answered: the child's dialog resolves with the parent's answer.
      expect(await Promise.race([answered, new Promise<string>((_, reject) => setTimeout(() => reject(new Error(`no answer: ${diagnostics()}`)), 30_000))])).toBe("header");
      const inspected = stub.requests.find((r) => lastToolName(r) === "inspect_agent");
      expect(inspected, diagnostics()).toBeDefined();
      const inspection = textOfContent(inspected!.messages.at(-1)?.content);
      expect(inspection).toContain('"status": "needs_input"');
      expect(inspection).toContain("Which token store?");
      expect(inspection).toContain('"what_it_needs"');
      expect(inspection).toContain(startArgs["task"]);
      await wait(() => stub.requests.some((r) => lastToolName(r) === "send_agent_message"));
      const sent = stub.requests.find((r) => lastToolName(r) === "send_agent_message");
      expect(sent, diagnostics()).toBeDefined();
      expect(textOfContent(sent!.messages.at(-1)?.content)).toContain('"delivery": "answered"');

      // Back to running once answered, then ended the only way a run ends.
      await wait(() => runs().some((run) => run.status === "completed"));
      const statuses = runs().filter((run) => run.runId === paused!.runId).map((run) => run.status);
      expect(statuses, diagnostics()).toContain("completed");
      expect(statuses.indexOf("running", statuses.indexOf("needs_input"))).toBeGreaterThan(statuses.indexOf("needs_input"));
      expect(runs().find((run) => run.status === "completed")).not.toHaveProperty("question");

      // The parent's transcript holds one question event and one ending, each once.
      await wait(() => existsSync(parentPath) && readFileSync(parentPath, "utf8").includes("agent.completed"));
      const parentText = readFileSync(parentPath, "utf8");
      expect(parentText.split("agent.needs_input").length - 1).toBeGreaterThanOrEqual(1);
      expect(parentText).toContain("done: answered");
    } finally {
      await server.dispose();
    }
  }, 120_000);
});

describe.skipIf(harnessModulePresent)("golden path (pending)", () => {
  it("is skipped until the companion extension registers start_agent", () => {
    expect(harnessModulePresent).toBe(false);
  });
});
