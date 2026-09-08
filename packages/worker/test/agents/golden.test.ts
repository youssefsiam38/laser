/**
 * M13-T3 · the golden path against the real engine: a parent session whose
 * model calls `start_agent`, a child in a `.worktrees/` checkout whose model
 * calls `complete_agent_run`, the run reaching `completed`, and the parent
 * receiving one `AGENT_EVENT_MESSAGE_TYPE` custom message with that result.
 *
 * Needs the companion extension's harness module (Lane X). Until its
 * `start_agent` registration exists the suite is skipped, and says so.
 */
import { AGENT_EVENT_MESSAGE_TYPE, PRODUCT_NAME, SESSION_AGENT_ENTRY_TYPE, WORKTREES_DIR_NAME, type AgentRun, type JsonRpcMessage } from "@lasercode/protocol";
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

beforeEach(async () => {
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
    if (isChild) {
      return sawToolResult ? { text: "done" } : { toolCall: { name: "complete_agent_run", args: { status: "completed", message: "done: touched nothing" } } };
    }
    if (!sawToolResult && tools.includes("start_agent")) {
      return { toolCall: { name: "start_agent", args: { agent_name: "worker", subagent_name: "touch-nothing", task: "Look around and finish without changing anything." } } };
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

      // The parent received exactly one agent event carrying the child's message.
      await wait(() => existsSync(parentPath) && readFileSync(parentPath, "utf8").includes(AGENT_EVENT_MESSAGE_TYPE));
      const parentLines = readFileSync(parentPath, "utf8").trim().split("\n").map((line) => JSON.parse(line) as { type: string; customType?: string; content?: unknown; message?: { customType?: string; content?: unknown } });
      const events = parentLines.filter((line) => line.customType === AGENT_EVENT_MESSAGE_TYPE || line.message?.customType === AGENT_EVENT_MESSAGE_TYPE);
      expect(events).toHaveLength(1);
      expect(JSON.stringify(events[0])).toContain("done: touched nothing");
    } finally {
      await server.dispose();
    }
  }, 90_000);
});

describe.skipIf(harnessModulePresent)("golden path (pending)", () => {
  it("is skipped until the companion extension registers start_agent", () => {
    expect(harnessModulePresent).toBe(false);
  });
});
