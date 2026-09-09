import { describe, expect, it, vi } from "vitest";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { AGENT_EVENT_MESSAGE_TYPE, type AgentRun } from "@lasercode/protocol";
import type { AgentCatalogEntry, AgentHarnessBridge, AgentModelEvent, AgentRunSummary, HarnessSessionRole, InspectAgentResult } from "../src/agents-bridge.js";
import { createLaserExtension } from "../src/index.js";
import type { ModuleContext } from "../src/modules/index.js";
import { formatEvent, roleBlock, startAgentDescription, startedGuidance, subagentsModule, whatItNeeds } from "../src/modules/subagents.js";

interface FakeTool {
  name: string;
  description: string;
  promptGuidelines?: string[];
  parameters: { properties: Record<string, unknown>; required?: string[] };
  execute: (...args: unknown[]) => Promise<{ content: Array<{ type: string; text: string }>; details: unknown; terminate?: boolean }>;
}

const PARENT_TOOLS = ["start_agent", "send_agent_message", "list_agents", "inspect_agent", "stop_agent", "remove_agent_worktree"];

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

const inspected: InspectAgentResult = {
  ...summary,
  status: "needs_input",
  task: "Review the authentication changes. ".repeat(40).trim(),
  origin: "agent",
  depth: 1,
  model: "stub/stub-1",
  cwd: "/project/.worktrees/review-auth-refresh",
  branch: "agents/review-auth-refresh",
  worktree: { path: "/project/.worktrees/review-auth-refresh", branch: "agents/review-auth-refresh", exists: true, unmergedCommits: 0, uncommittedFiles: 1 },
  activity: { turns: 3, tools: 5, currentTool: "bash", lastAt: "2026-09-08T10:04:00.000Z" },
  updatedAt: "2026-09-08T10:04:00.000Z",
  question: { id: "ui-1", kind: "select", title: "Which token store?", options: ["cookie", "header"], askedAt: "2026-09-08T10:04:00.000Z" },
  messages: [{ at: "2026-09-08T10:03:00.000Z", text: "Checked the refresh path." }],
  agents: [{ ...summary, runId: "run_9", subagentName: "grandchild", status: "running" }],
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
    startAgent: vi.fn(async (input) =>
      input.worktree === false
        ? { agentName: input.agentName, subagentName: input.subagentName, sessionId: "session_42", runId: "run_7", status: "running" as const, cwd: "/project" }
        : {
            agentName: input.agentName,
            subagentName: input.subagentName,
            sessionId: "session_42",
            runId: "run_7",
            status: "running" as const,
            cwd: `/project/.worktrees/${input.subagentName}`,
            branch: `agents/${input.subagentName}`,
          },
    ),
    sendAgentMessage: vi.fn(async (input) => ({ sessionId: input.sessionId, runId: "run_8", status: "running" as const, delivery: "delivered" as const })),
    listAgents: vi.fn(async () => [summary]),
    inspectAgent: vi.fn(async () => inspected),
    stopAgent: vi.fn(async () => ({ ...summary, status: "cancelled" as const, endedBy: { initiator: "parent" as const, reason: "no longer needed" } })),
    removeAgentWorktree: vi.fn(async (input) => ({
      agentName: "reviewer",
      subagentName: "review-auth-refresh",
      sessionId: input.sessionId ?? "session_42",
      removed: true as const,
      path: "/project/.worktrees/review-auth-refresh",
      branch: "agents/review-auth-refresh",
    })),
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
  it("gives a parent-capable session exactly the six parent tools, with the catalog in start_agent", async () => {
    const h = moduleHarness(root, true);
    expect(h.registrations).toEqual(PARENT_TOOLS);
    expect(h.tools.has("complete_agent_run")).toBe(false);
    const start = h.tools.get("start_agent")!;
    expect(start.description).toContain(
      "Start another agent for an independent piece of work. Available agents: explorer — codebase research; worker — implementation.",
    );
    // The parent is told whose job the branch and the directory are, where it
    // starts the child (M13-T42).
    expect(start.description).toContain("removing the worktree with remove_agent_worktree are yours, not the agent's");
    expect(start.parameters.required).toEqual(["agent_name", "subagent_name", "task"]);
    expect(Object.keys(start.parameters.properties)).toEqual(["agent_name", "subagent_name", "task", "worktree"]);
    for (const tool of h.tools.values()) {
      for (const guideline of tool.promptGuidelines ?? []) expect(guideline).toContain(tool.name);
    }
    const signal = new AbortController().signal;
    const result = await start.execute("call", { agent_name: "explorer", subagent_name: "find-auth", task: "Find the auth code." }, signal);
    expect(h.bridge.startAgent).toHaveBeenCalledWith({ agentName: "explorer", subagentName: "find-auth", task: "Find the auth code." }, signal);
    expect(JSON.parse(result.content[0]!.text)).toEqual({
      agent_name: "explorer",
      subagent_name: "find-auth",
      sessionId: "session_42",
      runId: "run_7",
      status: "running",
      working_directory: "/project/.worktrees/find-auth",
      branch: "agents/find-auth",
      guidance:
        "Do not wait for find-auth. Carry on with your own work; when it ends, its result will be sent to you as a message. " +
        "Use inspect_agent with runId run_7 to check on it meanwhile — a status of needs_input means it is paused on a question you can answer with send_agent_message.",
      your_responsibility:
        "When find-auth finishes, its work is on the branch agents/find-auth in /project/.worktrees/find-auth. " +
        "Reviewing it, merging it into your own checkout with git, and then removing the worktree with remove_agent_worktree are yours to do — nothing removes it for you.",
    });
    expect(result.details).toMatchObject({ agentName: "explorer", runId: "run_7" });
  });

  it("passes the worktree choice through and says where the child works, with no branch when it is not isolated", async () => {
    const h = moduleHarness(root, true);
    const start = h.tools.get("start_agent")!;
    const worktree = start.parameters.properties["worktree"] as { type: string; description: string };
    expect(worktree.type).toBe("boolean");
    expect(worktree.description).toContain("Default true");
    expect(worktree.description).toContain("only reads");
    // Absent is not sent as `false`: the bridge must see nothing at all.
    await start.execute("call", { agent_name: "explorer", subagent_name: "find-auth", task: "Find it." });
    expect(vi.mocked(h.bridge.startAgent).mock.calls[0]![0]).not.toHaveProperty("worktree");
    const shared = await start.execute("call", { agent_name: "explorer", subagent_name: "review", task: "Review it.", worktree: false });
    expect(h.bridge.startAgent).toHaveBeenLastCalledWith({ agentName: "explorer", subagentName: "review", task: "Review it.", worktree: false }, undefined);
    const view = JSON.parse(shared.content[0]!.text);
    expect(view).toMatchObject({ runId: "run_7", status: "running", working_directory: "/project" });
    expect(view).not.toHaveProperty("branch");
    const isolated = await start.execute("call", { agent_name: "explorer", subagent_name: "fix", task: "Fix it.", worktree: true });
    expect(h.bridge.startAgent).toHaveBeenLastCalledWith({ agentName: "explorer", subagentName: "fix", task: "Fix it.", worktree: true }, undefined);
    expect(JSON.parse(isolated.content[0]!.text)).toMatchObject({ working_directory: "/project/.worktrees/fix", branch: "agents/fix" });
  });

  it("delegates the other parent tools to the bridge and rethrows its errors", async () => {
    const h = moduleHarness(root, true);
    const message = await h.tools.get("send_agent_message")!.execute("c", { sessionId: "session_42", message: "Also check rotation." });
    expect(h.bridge.sendAgentMessage).toHaveBeenCalledWith({ sessionId: "session_42", message: "Also check rotation.", interrupt: false });
    expect(JSON.parse(message.content[0]!.text)).toMatchObject({ runId: "run_8", delivery: "delivered" });
    const list = await h.tools.get("list_agents")!.execute("c", {});
    expect(JSON.parse(list.content[0]!.text).agents[0]).toMatchObject({ agent_name: "reviewer", subagent_name: "review-auth-refresh", runId: "run_7" });
    expect(h.tools.get("list_agents")!.description).toContain("needs_input (paused on a question");
    const stopped = await h.tools.get("stop_agent")!.execute("c", { runId: "run_7", reason: "no longer needed" });
    expect(h.bridge.stopAgent).toHaveBeenCalledWith({ runId: "run_7", reason: "no longer needed" });
    expect(JSON.parse(stopped.content[0]!.text)).toMatchObject({ status: "cancelled", endedBy: { initiator: "parent", reason: "no longer needed" } });
    vi.mocked(h.bridge.startAgent).mockRejectedValueOnce(new Error("Agent \"nope\" is not allowed for this session."));
    await expect(h.tools.get("start_agent")!.execute("c", { agent_name: "nope", subagent_name: "x", task: "y" })).rejects.toThrow("not allowed");
  });

  // M13-T45: there is no waiting tool. A child's ending is delivered to the
  // parent, so the parent is told not to wait, and gets one tool to look
  // closely at one child instead.
  it("has no waiting tool anywhere, and tells the parent not to wait at the moment it starts a child", async () => {
    const h = moduleHarness(root, true);
    expect(h.tools.has("wait_for_agents")).toBe(false);
    for (const tool of h.tools.values()) {
      expect(tool.description).not.toContain("wait_for_agents");
      for (const guideline of tool.promptGuidelines ?? []) expect(guideline).not.toContain("wait_for_agents");
    }
    expect(h.tools.get("start_agent")!.description).toContain("do not wait for it");
    expect(h.tools.get("start_agent")!.promptGuidelines![0]).toContain("Do not wait for it and do not poll");
    expect(startedGuidance({ subagentName: "find-auth", runId: "run_7" })).toBe(
      "Do not wait for find-auth. Carry on with your own work; when it ends, its result will be sent to you as a message. " +
        "Use inspect_agent with runId run_7 to check on it meanwhile — a status of needs_input means it is paused on a question you can answer with send_agent_message.",
    );
    // The guidance is in the result, where the model reads it when it matters — in both worktree shapes.
    const shared = await h.tools.get("start_agent")!.execute("call", { agent_name: "explorer", subagent_name: "review", task: "Read it.", worktree: false });
    expect(JSON.parse(shared.content[0]!.text).guidance).toContain("Do not wait for review.");
  });

  it("gives the parent inspect_agent: one child by runId or sessionId, with a bounded window on its words", async () => {
    const h = moduleHarness(root, true);
    const inspect = h.tools.get("inspect_agent")!;
    expect(Object.keys(inspect.parameters.properties)).toEqual(["runId", "sessionId", "messages"]);
    expect(inspect.parameters.required ?? []).toEqual([]);
    expect(inspect.parameters.properties["messages"]).toMatchObject({ type: "integer", minimum: 0, maximum: 10 });
    expect(inspect.description).toContain("Read-only");
    expect(inspect.description).toContain("needs_input");

    const result = await inspect.execute("call", { runId: "run_7", messages: 3 });
    expect(h.bridge.inspectAgent).toHaveBeenCalledWith({ runId: "run_7", messages: 3 });
    const view = JSON.parse(result.content[0]!.text) as Record<string, unknown>;
    expect(view).toMatchObject({
      agent_name: "reviewer",
      subagent_name: "review-auth-refresh",
      sessionId: "session_42",
      runId: "run_7",
      status: "needs_input",
      task: inspected.task,
      cwd: "/project/.worktrees/review-auth-refresh",
      branch: "agents/review-auth-refresh",
      worktree: { exists: true, uncommittedFiles: 1 },
      activity: { turns: 3, tools: 5, currentTool: "bash" },
      question: { kind: "select", title: "Which token store?", options: ["cookie", "header"] },
      messages: [{ text: "Checked the refresh path." }],
      agents: [{ agent_name: "reviewer", subagent_name: "grandchild", runId: "run_9", status: "running" }],
    });
    expect(view).not.toHaveProperty("agentName");
    expect(view["what_it_needs"]).toBe(
      "review-auth-refresh is paused on a question and cannot continue until it is answered. Answer it with send_agent_message with its sessionId and one of the choices, exactly, as the message. The person can also answer it in review-auth-refresh's own chat.",
    );
    expect(result.details).toBe(inspected);

    // Absent fields are not sent as undefined; by sessionId works the same way.
    await inspect.execute("call", { sessionId: "session_42" });
    expect(h.bridge.inspectAgent).toHaveBeenLastCalledWith({ sessionId: "session_42" });
    vi.mocked(h.bridge.inspectAgent).mockRejectedValueOnce(new Error('No run called "run_x" was started by this session.'));
    await expect(inspect.execute("call", { runId: "run_x" })).rejects.toThrow(/No run called/);
  });

  it("says what a stalled child needs in one sentence, and nothing for one that is working or done", () => {
    const base = { subagentName: "w", result: undefined, question: undefined };
    expect(whatItNeeds({ ...base, status: "running" })).toBeUndefined();
    expect(whatItNeeds({ ...base, status: "completed" })).toBeUndefined();
    expect(whatItNeeds({ ...base, status: "needs_input", question: { id: "q", kind: "confirm", title: "Go?", askedAt: "" } })).toContain('"yes" or "no" as the message');
    expect(whatItNeeds({ ...base, status: "needs_input", question: { id: "q", kind: "input", title: "Name?", askedAt: "" } })).toContain("the message is the answer, verbatim");
    expect(whatItNeeds({ ...base, status: "needs_input", question: { id: "q", kind: "editor", title: "Edit", askedAt: "" } })).toContain("the message replaces the text, verbatim");
    // A child that ended blocked asked in its final message; the answer starts a new run.
    expect(whatItNeeds({ ...base, status: "blocked", result: { status: "blocked", message: "Which config?" } })).toContain("Answer with send_agent_message: that starts a new run in the same session");
  });

  it("tells the parent a message to a needs_input child answers its question", () => {
    const h = moduleHarness(root, true);
    const send = h.tools.get("send_agent_message")!;
    expect(send.description).toContain("needs_input is paused on a question, and your message answers it");
    expect(send.promptGuidelines!.some((line) => line.includes("needs_input"))).toBe(true);
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

  // M13-T42: the parent owns the lifecycle, so it gets the verb for the end
  // of it — and the verb refuses to invent a fifth identity or a merge.
  it("gives the parent a worktree-removal verb addressed by the identities it already has", async () => {
    const h = moduleHarness(root, true);
    const remove = h.tools.get("remove_agent_worktree")!;
    expect(Object.keys(remove.parameters.properties)).toEqual(["sessionId", "runId", "force"]);
    expect(remove.parameters.required ?? []).toEqual([]);
    expect(remove.description).toContain("worktree false");
    expect(remove.description).toContain("force true");
    // No merge tool: merging is the parent's own git, in its own checkout.
    expect(h.tools.has("merge_agent_worktree")).toBe(false);

    const result = await remove.execute("call", { sessionId: "session_42" });
    expect(h.bridge.removeAgentWorktree).toHaveBeenCalledWith({ sessionId: "session_42" });
    expect(JSON.parse(result.content[0]!.text)).toEqual({
      agent_name: "reviewer",
      subagent_name: "review-auth-refresh",
      sessionId: "session_42",
      removed: true,
      path: "/project/.worktrees/review-auth-refresh",
      branch: "agents/review-auth-refresh",
    });

    // The refusal the bridge raises reaches the model as a tool error.
    vi.mocked(h.bridge.removeAgentWorktree).mockRejectedValueOnce(new Error("still holds 2 commits"));
    await expect(remove.execute("call", { runId: "run_7" })).rejects.toThrow(/still holds 2 commits/);
  });

  it("says whose job the worktree is in the start_agent result, in both shapes and with no invented branch", async () => {
    const h = moduleHarness(root, true);
    const start = h.tools.get("start_agent")!;
    const shared = await start.execute("call", { agent_name: "explorer", subagent_name: "review", task: "Read it.", worktree: false });
    const view = JSON.parse(shared.content[0]!.text) as Record<string, string>;
    expect(view).not.toHaveProperty("branch");
    expect(view["your_responsibility"]).toContain("working in your own checkout");
    expect(view["your_responsibility"]).toContain("no branch and no worktree to merge or remove");
    expect(view["your_responsibility"]).not.toContain("agents/");
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

  it("tells a child how to ask its parent something it cannot answer itself", () => {
    const block = roleBlock(child, false, "/w")!;
    expect(block).toContain('end with status "blocked" and put the question, and what you have done so far, in that final message');
    expect(block).toContain("starts a new run in this same session with your history intact");
    expect(block).not.toContain("wait_for_agents");
  });

  it("delivers a child's open question to the parent the same way as an ending, so it wakes", () => {
    const h = moduleHarness(root, true);
    const event: AgentModelEvent = {
      type: "agent.needs_input",
      agentName: "reviewer",
      subagentName: "review-auth-refresh",
      sessionId: "session_42",
      runId: "run_7",
      message: "review-auth-refresh is paused on a question and cannot continue until it is answered.\n\nQuestion (select): Which token store?",
      run: { ...run, status: "needs_input", question: inspected.question! },
    };
    h.emit(event);
    const [message, options] = h.sendMessage.mock.calls[0]!;
    expect(options).toEqual({ deliverAs: "steer", triggerTurn: true });
    expect(message.content).toBe(formatEvent(event));
    expect(message.content.startsWith("agent.needs_input\n")).toBe(true);
    expect(message.content).toContain("Question (select): Which token store?");
    expect(message.content).not.toContain("endedBy");
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
    expect(block).not.toContain(child.task!);
    expect(block).toContain("…");
  });

  it("gives a parent-capable root the delegation reminder only, and a delegating child both", async () => {
    const parent = moduleHarness(root, true);
    const [handler] = parent.handlers.get("before_agent_start")!;
    const result = (await handler!({ systemPrompt: "BASE", prompt: "go" }, { cwd: "/project" })) as { systemPrompt: string };
    expect(result.systemPrompt).toContain("start_agent");
    expect(result.systemPrompt).not.toContain("wait_for_agents");
    expect(result.systemPrompt).toContain("Never wait for one");
    expect(result.systemPrompt).toContain("inspect_agent");
    expect(result.systemPrompt).toContain("answer with send_agent_message");
    expect(result.systemPrompt).not.toContain("# Your role");
    const both = roleBlock(child, true, "/project/.worktrees/x")!;
    expect(both).toContain("# Your role");
    expect(both).toContain("start_agent");
    expect(roleBlock(root, false, "/project")).toBeUndefined();
  });

  it("tells a child that shares its parent's checkout, and only that child", () => {
    const isolated = roleBlock({ ...child, isolated: true }, false, "/project/.worktrees/review-auth-refresh")!;
    expect(isolated).toContain("Work only inside your own worktree: /project/.worktrees/review-auth-refresh.");
    expect(isolated).not.toContain("not isolated");
    // Absent means isolated: nothing said before this flag existed changes.
    expect(roleBlock(child, false, "/w")).toContain("Work only inside your own worktree: /w.");
    const shared = roleBlock({ ...child, isolated: false }, false, "/project")!;
    expect(shared).toContain("/project, your parent's own checkout");
    expect(shared).toContain("you are not isolated from it");
    expect(shared).not.toContain("Work only inside your own worktree");
    // Everything else about the child's role is unchanged.
    expect(shared).toContain('You are "review-auth-refresh", an instance of the agent "reviewer"');
    expect(shared).toContain("complete_agent_run");
    // A root session is never told about a checkout it was not given.
    expect(roleBlock({ ...root, isolated: false }, false, "/project")).toBeUndefined();
  });

  // M13-T42: both sides are told whose job the worktree is, and neither
  // sentence may name a branch in the shape that has none.
  it("tells an isolated child not to merge or delete its own worktree, naming its branch", () => {
    const isolated = roleBlock({ ...child, isolated: true, branch: "agents/review-auth-refresh" }, false, "/project/.worktrees/review-auth-refresh")!;
    expect(isolated).toContain("on the branch agents/review-auth-refresh");
    expect(isolated).toContain("Do not merge your work anywhere and do not delete the worktree");
    expect(isolated).toContain("your parent reviews the branch, merges what it wants and removes the worktree itself");

    // A worktree whose branch the harness did not report says the rest anyway,
    // without inventing a name.
    const nameless = roleBlock({ ...child, isolated: true }, false, "/w")!;
    expect(nameless).toContain("Work only inside your own worktree: /w.");
    expect(nameless).not.toContain("on the branch");
  });

  it("tells a child with no worktree that it has nothing to merge or remove, and names no branch", () => {
    const shared = roleBlock({ ...child, isolated: false }, false, "/project")!;
    expect(shared).toContain("no branch and no worktree of your own");
    expect(shared).toContain("no branch, no merge, no commit it did not ask for");
    expect(shared).not.toContain("agents/");
    expect(shared).not.toContain("remove_agent_worktree");
  });

  it("tells a delegating parent that merging and removing a child's worktree are its own job", () => {
    const parent = roleBlock(root, true, "/project")!;
    expect(parent).toContain("merging it into your checkout with git, and removing the worktree with remove_agent_worktree are yours");
    expect(parent).toContain("nothing does any of it for you");
    // And it is told the other shape exists, so it does not go looking for a
    // branch that a `worktree: false` child never had.
    expect(parent).toContain("A child started with worktree false has neither a branch nor a worktree");
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
    expect(startAgentDescription([])).toContain("Available agents: none are allowed for this session.");
  });
});
