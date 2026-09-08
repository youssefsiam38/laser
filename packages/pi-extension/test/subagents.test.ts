import { describe, expect, it, vi } from "vitest";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { AGENT_EVENT_MESSAGE_TYPE, type AgentRun } from "@lasercode/protocol";
import type { AgentCatalogEntry, AgentHarnessBridge, AgentModelEvent, AgentRunSummary, HarnessSessionRole } from "../src/agents-bridge.js";
import { createLaserExtension } from "../src/index.js";
import type { ModuleContext } from "../src/modules/index.js";
import { formatEvent, roleBlock, startAgentDescription, subagentsModule } from "../src/modules/subagents.js";

interface FakeTool {
  name: string;
  description: string;
  promptGuidelines?: string[];
  parameters: { properties: Record<string, unknown>; required?: string[] };
  execute: (...args: unknown[]) => Promise<{ content: Array<{ type: string; text: string }>; details: unknown; terminate?: boolean }>;
}

const PARENT_TOOLS = ["start_agent", "send_agent_message", "list_agents", "wait_for_agents", "stop_agent"];

function fakePi() {
  const handlers = new Map<string, Array<(...args: any[]) => unknown>>();
  const tools = new Map<string, FakeTool>();
  const registrations: string[] = [];
  const sendMessage = vi.fn();
  const pi = {
    on: (name: string, callback: (...args: any[]) => unknown) => handlers.set(name, [...(handlers.get(name) ?? []), callback]),
    registerTool: (tool: FakeTool) => {
      tools.set(tool.name, tool);
      registrations.push(tool.name);
    },
    sendMessage,
    events: { on: () => () => {}, emit: () => {} },
  } as unknown as ExtensionAPI;
  return { pi, handlers, tools, registrations, sendMessage };
}

const run: AgentRun = {
  agentName: "reviewer",
  subagentName: "review-auth-refresh",
  sessionId: "session_42",
  runId: "run_7",
  sessionPath: "/sessions/42.jsonl",
  projectCwd: "/project",
  rootSessionPath: "/sessions/1.jsonl",
  depth: 1,
  parent: { sessionPath: "/sessions/1.jsonl", sessionId: "session_1" },
  worktree: { path: "/project/.worktrees/review-auth-refresh", branch: "agents/review-auth-refresh", baseCommit: "abc" },
  origin: "agent",
  status: "completed",
  task: "Review the authentication changes.",
  startedAt: "2026-09-08T10:00:00.000Z",
  updatedAt: "2026-09-08T10:05:00.000Z",
};

const summary: AgentRunSummary = {
  agentName: "reviewer",
  subagentName: "review-auth-refresh",
  sessionId: "session_42",
  runId: "run_7",
  status: "completed",
  startedAt: run.startedAt,
  endedAt: run.updatedAt,
  result: { status: "completed", message: "Found one bug." },
};

const catalog: AgentCatalogEntry[] = [
  { agentName: "explorer", description: "codebase research" },
  { agentName: "worker", description: "implementation" },
];

const root: HarnessSessionRole = { agentName: "default", kind: "root", depth: 0 };
const child: HarnessSessionRole = {
  agentName: "reviewer",
  kind: "child",
  subagentName: "review-auth-refresh",
  depth: 1,
  parent: { sessionPath: "/sessions/1.jsonl", sessionId: "session_1", agentName: "default" },
  runId: "run_7",
  goal: { id: "g1", objective: "Ship the auth refactor without regressions" },
  task: "Review the authentication changes. ".repeat(40),
};

function fakeBridge(role: HarnessSessionRole, canDelegate: boolean, entries: AgentCatalogEntry[] = catalog) {
  const deliverers = new Set<(event: AgentModelEvent) => void>();
  const roleListeners = new Set<(role: HarnessSessionRole) => void>();
  let currentRole = role;
  let currentCatalog = entries;
  const bridge: AgentHarnessBridge = {
    role: () => currentRole,
    canDelegate: () => canDelegate,
    catalog: () => currentCatalog,
    startAgent: vi.fn(async (input) => ({ agentName: input.agentName, subagentName: input.subagentName, sessionId: "session_42", runId: "run_7", status: "running" as const })),
    sendAgentMessage: vi.fn(async (input) => ({ sessionId: input.sessionId, runId: "run_8", status: "running" as const, delivery: "delivered" as const })),
    listAgents: vi.fn(async () => [summary]),
    waitForAgents: vi.fn(async () => ({ runs: [summary], timedOut: false })),
    stopAgent: vi.fn(async () => ({ ...summary, status: "cancelled" as const, endedBy: { initiator: "parent" as const, reason: "no longer needed" } })),
    completeRun: vi.fn(async () => ({ ok: true as const, runId: "run_7" })),
    onEvent: (deliver) => {
      deliverers.add(deliver);
      return () => deliverers.delete(deliver);
    },
    onRoleChange: (listener) => {
      roleListeners.add(listener);
      return () => roleListeners.delete(listener);
    },
  };
  return {
    bridge,
    deliverers,
    roleListeners,
    emit: (event: AgentModelEvent) => deliverers.forEach((deliver) => deliver(event)),
    change: (next: HarnessSessionRole, nextCatalog: AgentCatalogEntry[]) => {
      currentRole = next;
      currentCatalog = nextCatalog;
      roleListeners.forEach((listener) => listener(next));
    },
  };
}

function moduleHarness(role: HarnessSessionRole, canDelegate: boolean, entries?: AgentCatalogEntry[]) {
  const fake = fakePi();
  const harness = fakeBridge(role, canDelegate, entries);
  const send = vi.fn();
  const ctx: ModuleContext = { pi: fake.pi, send, agents: harness.bridge };
  subagentsModule.register!(ctx);
  const dispose = subagentsModule.activate(ctx) as (() => void) | undefined;
  return { ...fake, ...harness, ctx, send, dispose };
}

describe("subagents module: tool registration", () => {
  it("gives a parent-capable session exactly the five parent tools, with the catalog in start_agent", async () => {
    const h = moduleHarness(root, true);
    expect(h.registrations).toEqual(PARENT_TOOLS);
    expect(h.tools.has("complete_agent_run")).toBe(false);
    const start = h.tools.get("start_agent")!;
    expect(start.description).toBe(
      "Start another agent for an independent piece of work. Available agents: explorer — codebase research; worker — implementation.",
    );
    expect(start.parameters.required).toEqual(["agent_name", "subagent_name", "task"]);
    expect(Object.keys(start.parameters.properties)).toEqual(["agent_name", "subagent_name", "task"]);
    for (const tool of h.tools.values()) {
      for (const guideline of tool.promptGuidelines ?? []) expect(guideline).toContain(tool.name);
    }
    const signal = new AbortController().signal;
    const result = await start.execute("call", { agent_name: "explorer", subagent_name: "find-auth", task: "Find the auth code." }, signal);
    expect(h.bridge.startAgent).toHaveBeenCalledWith({ agentName: "explorer", subagentName: "find-auth", task: "Find the auth code." }, signal);
    expect(JSON.parse(result.content[0]!.text)).toEqual({ agent_name: "explorer", subagent_name: "find-auth", sessionId: "session_42", runId: "run_7", status: "running" });
    expect(result.details).toMatchObject({ agentName: "explorer", runId: "run_7" });
  });

  it("delegates the other parent tools to the bridge and rethrows its errors", async () => {
    const h = moduleHarness(root, true);
    const message = await h.tools.get("send_agent_message")!.execute("c", { sessionId: "session_42", message: "Also check rotation." });
    expect(h.bridge.sendAgentMessage).toHaveBeenCalledWith({ sessionId: "session_42", message: "Also check rotation.", interrupt: false });
    expect(JSON.parse(message.content[0]!.text)).toMatchObject({ runId: "run_8", delivery: "delivered" });
    const list = await h.tools.get("list_agents")!.execute("c", {});
    expect(JSON.parse(list.content[0]!.text).agents[0]).toMatchObject({ agent_name: "reviewer", subagent_name: "review-auth-refresh", runId: "run_7" });
    const signal = new AbortController().signal;
    const waited = await h.tools.get("wait_for_agents")!.execute("c", { runIds: ["run_7"], timeoutSeconds: 30 }, signal);
    expect(h.bridge.waitForAgents).toHaveBeenCalledWith({ runIds: ["run_7"], timeoutSeconds: 30 }, signal);
    expect(JSON.parse(waited.content[0]!.text)).toMatchObject({ timedOut: false, runs: [{ agent_name: "reviewer", result: { message: "Found one bug." } }] });
    const stopped = await h.tools.get("stop_agent")!.execute("c", { runId: "run_7", reason: "no longer needed" });
    expect(h.bridge.stopAgent).toHaveBeenCalledWith({ runId: "run_7", reason: "no longer needed" });
    expect(JSON.parse(stopped.content[0]!.text)).toMatchObject({ status: "cancelled", endedBy: { initiator: "parent", reason: "no longer needed" } });
    vi.mocked(h.bridge.startAgent).mockRejectedValueOnce(new Error("Agent \"nope\" is not allowed for this session."));
    await expect(h.tools.get("start_agent")!.execute("c", { agent_name: "nope", subagent_name: "x", task: "y" })).rejects.toThrow("not allowed");
  });

  it("gives a child that cannot delegate only complete_agent_run, which terminates the turn", async () => {
    const h = moduleHarness(child, false);
    expect(h.registrations).toEqual(["complete_agent_run"]);
    const complete = h.tools.get("complete_agent_run")!;
    expect(complete.description).toBe("Finish the current run and publish its final message.");
    expect(complete.parameters.properties["status"]).toMatchObject({ type: "string", enum: ["completed", "blocked"] });
    expect(complete.parameters.required).toEqual(["status", "message"]);
    const result = await complete.execute("c", { status: "completed", message: "Found one bug and added a test." });
    expect(h.bridge.completeRun).toHaveBeenCalledWith({ status: "completed", message: "Found one bug and added a test." });
    expect(result).toEqual({
      content: [{ type: "text", text: "Run run_7 ended with status completed. Do not send another message." }],
      details: { runId: "run_7", status: "completed" },
      terminate: true,
    });
    vi.mocked(h.bridge.completeRun).mockResolvedValueOnce({ ok: false, error: "This run already ended." });
    await expect(complete.execute("c", { status: "blocked", message: "x" })).rejects.toThrow("This run already ended.");
  });

  it("gives a child that can delegate both sets", () => {
    const h = moduleHarness(child, true);
    expect(h.registrations).toEqual(["complete_agent_run", ...PARENT_TOOLS]);
  });

  it("re-registers only start_agent when the catalog changes", () => {
    const h = moduleHarness(root, true);
    h.change(root, catalog);
    expect(h.registrations).toEqual(PARENT_TOOLS);
    h.change(root, [...catalog, { agentName: "reviewer", description: "independent verification" }]);
    expect(h.registrations).toEqual([...PARENT_TOOLS, "start_agent"]);
    expect(h.tools.get("start_agent")!.description).toContain("reviewer — independent verification");
    h.dispose?.();
    h.change(root, []);
    expect(h.registrations).toEqual([...PARENT_TOOLS, "start_agent"]);
    expect(h.roleListeners.size).toBe(0);
  });
});

describe("subagents module: events and the child's role", () => {
  it("delivers an event to the parent model as one steering custom message that wakes it", () => {
    const h = moduleHarness(root, true);
    const event: AgentModelEvent = {
      type: "agent.cancelled",
      agentName: "reviewer",
      subagentName: "review-auth-refresh",
      sessionId: "session_42",
      runId: "run_7",
      message: "The run was ended before it finished.",
      endedBy: { initiator: "user", reason: "wrong branch, start over on main" },
      run: { ...run, status: "cancelled", endedBy: { initiator: "user", reason: "wrong branch, start over on main" } },
    };
    h.emit(event);
    expect(h.sendMessage).toHaveBeenCalledTimes(1);
    const [message, options] = h.sendMessage.mock.calls[0]!;
    expect(options).toEqual({ deliverAs: "steer", triggerTurn: true });
    expect(message).toMatchObject({ customType: AGENT_EVENT_MESSAGE_TYPE, display: true, details: event });
    expect(message.content).toBe(formatEvent(event));
    expect(message.content).toContain("agent.cancelled");
    expect(message.content).toContain("subagent_name: review-auth-refresh");
    expect(message.content).toContain("sessionId: session_42");
    expect(message.content).toContain("runId: run_7");
    expect(message.content).toContain("endedBy: user — wrong branch, start over on main");
    expect(message.content).toContain("The run was ended before it finished.");
    h.dispose?.();
    h.emit(event);
    expect(h.sendMessage).toHaveBeenCalledTimes(1);
    expect(h.deliverers.size).toBe(0);
  });

  it("appends the child's role to the system prompt each turn without touching messages", async () => {
    const h = moduleHarness(child, false);
    const [handler] = h.handlers.get("before_agent_start")!;
    const result = (await handler!({ systemPrompt: "BASE", prompt: "go" }, { cwd: "/project/.worktrees/review-auth-refresh" })) as { systemPrompt: string; message?: unknown };
    expect(result.message).toBeUndefined();
    expect(result.systemPrompt.startsWith("BASE\n\n")).toBe(true);
    const block = result.systemPrompt.slice("BASE\n\n".length);
    expect(block).toBe(roleBlock(child, false, "/project/.worktrees/review-auth-refresh"));
    expect(block).toContain('You are "review-auth-refresh", an instance of the agent "reviewer"');
    expect(block).toContain("Ship the auth refactor without regressions");
    expect(block).toContain("complete_agent_run");
    expect(block).toContain("/project/.worktrees/review-auth-refresh");
    expect(block).not.toContain("start_agent");
    // The task is excerpted, not pasted whole.
    expect(block).toContain("> Review the authentication changes.");
    expect(block.length).toBeLessThan(child.task!.length);
    expect(block).toContain("…");
  });

  it("gives a parent-capable root the delegation reminder only, and a delegating child both", async () => {
    const parent = moduleHarness(root, true);
    const [handler] = parent.handlers.get("before_agent_start")!;
    const result = (await handler!({ systemPrompt: "BASE", prompt: "go" }, { cwd: "/project" })) as { systemPrompt: string };
    expect(result.systemPrompt).toContain("start_agent");
    expect(result.systemPrompt).toContain("wait_for_agents");
    expect(result.systemPrompt).not.toContain("# Your role");
    const both = roleBlock(child, true, "/project/.worktrees/x")!;
    expect(both).toContain("# Your role");
    expect(both).toContain("start_agent");
    expect(roleBlock(root, false, "/project")).toBeUndefined();
  });

  it("re-reads the role per turn so a follow-up run carries its new task", async () => {
    const h = moduleHarness(child, false);
    const [handler] = h.handlers.get("before_agent_start")!;
    h.change({ ...child, runId: "run_9", task: "Now check refresh-token rotation." }, []);
    const result = (await handler!({ systemPrompt: "BASE", prompt: "go" }, { cwd: "/w" })) as { systemPrompt: string };
    expect(result.systemPrompt).toContain("> Now check refresh-token rotation.");
  });
});

describe("subagents module: through the extension", () => {
  function extension(agents?: AgentHarnessBridge) {
    const fake = fakePi();
    const send = vi.fn();
    const ext = createLaserExtension({ send, only: ["subagents"], ...(agents ? { agents } : {}) });
    ext.factory(fake.pi);
    return { ...fake, send };
  }

  it("is active with a bridge and absent without one", async () => {
    const withBridge = extension(fakeBridge(root, true).bridge);
    await withBridge.handlers.get("session_start")![0]!({}, {});
    expect(withBridge.send).toHaveBeenCalledWith({ type: "lasercode/capabilities", active: ["subagents"], failed: [] });
    expect(withBridge.registrations).toEqual(PARENT_TOOLS);

    const without = extension();
    await without.handlers.get("session_start")![0]!({}, {});
    expect(without.send).toHaveBeenCalledWith({ type: "lasercode/capabilities", active: [], failed: [] });
    expect(without.registrations).toEqual([]);
  });

  it("describes an empty catalog without inventing agents", () => {
    expect(startAgentDescription([])).toBe("Start another agent for an independent piece of work. Available agents: none are allowed for this session.");
  });
});
