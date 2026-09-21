/**
 * The world a fixture is evaluated in.
 *
 * The harness tools reach the fleet through {@link AgentHarnessBridge}. An
 * evaluation run must not start real agents, remove real worktrees or stop
 * real runs — a fixture is run on a person's machine, live, with a real model
 * choosing the calls — so this is the one part of the path that is scripted:
 * a bridge that answers from the fixture's declared state and refuses
 * everything that is not in it.
 *
 * What stays real, and is what the measures read: the registered tool
 * surface, the closed schemas the engine validates against, D-277's label
 * stripping, the `ToolError` rendering every refusal travels in
 * (`HarnessError` → `registerLaserTool` → the model), and the whole engine
 * turn around them. The background tools (`task_output`, `task_stop`) do not
 * come through here at all: they run real commands in the run's own temporary
 * project directory.
 *
 * Refusals are written exactly as the harness writes them — the sentence, the
 * code, the next call — because "the model recovered from the refusal" is a
 * measure, and a refusal that did not say what to do next could not be
 * recovered from.
 */
import type {
  AgentCatalogEntry,
  AgentHarnessBridge,
  AgentModelEvent,
  AgentRunSummary,
  CompleteRunInput,
  CompleteRunResult,
  FleetRow,
  HarnessSessionRole,
  InspectAgentInput,
  InspectAgentResult,
  InspectFleetResult,
  RemoveAgentWorktreeInput,
  RemoveAgentWorktreeResult,
  SendAgentMessageInput,
  SendAgentMessageResult,
  StartAgentInput,
  StartAgentResult,
  StopAgentInput,
} from "@lasercode/pi-extension";
import type { AgentRunQuestion } from "@lasercode/protocol";
import { HarnessError } from "../agents/errors.js";
import type { ToolEvalFixture, ToolEvalWorldAgent } from "./fixture.js";

/** A stable ISO time, so two runs of one fixture differ in nothing but the profile. */
const AT = "2026-01-01T09:00:00.000Z";

const FLEET_STATUS: Record<ToolEvalWorldAgent["status"], string> = {
  running: "Working",
  needs_input: "Asking",
  completed: "Done",
  blocked: "Blocked",
  failed: "Failed",
  cancelled: "Ended",
};

/** One background command of this session, as the run learns about it. */
export interface WorldCommand {
  taskId: string;
  command: string;
}

/**
 * The scripted bridge, plus the two things the runner needs to keep in step
 * with it: the commands the run started (so `inspect_fleet` lists them, which
 * is how a model finds the id it then reads) and the calls that were refused.
 */
export class ScriptedWorld implements AgentHarnessBridge {
  private readonly agents: ToolEvalWorldAgent[];
  private readonly commands: WorldCommand[] = [];
  private readonly sessionRole: HarnessSessionRole;
  private readonly delegates: boolean;
  private started = 0;

  constructor(private readonly fixture: ToolEvalFixture) {
    this.agents = (fixture.world.agents ?? []).map((agent) => ({ ...agent }));
    const kind = fixture.world.role ?? "root";
    this.sessionRole = kind === "child"
      ? {
        agentName: "worker",
        kind: "child",
        subagentName: "Evaluation run",
        depth: 1,
        parent: { sessionPath: "<parent>", sessionId: "ses_parent", agentName: "orchestrator" },
        runId: "run_child",
        task: fixture.task,
      }
      : { agentName: "orchestrator", kind: "root", depth: 0 };
    // A child of a child would be a third level; the fixtures that exercise
    // `complete_agent_run` are leaves, and a leaf delegates to nothing. That
    // is also the contract's capability gating: the parent tools are simply
    // not registered for it.
    this.delegates = kind !== "child";
  }

  /** The runner tells the world about a command the session really started. */
  noteCommand(command: WorldCommand): void {
    if (!this.commands.some((entry) => entry.taskId === command.taskId)) this.commands.push(command);
  }

  role(): HarnessSessionRole {
    return this.sessionRole;
  }

  canDelegate(): boolean {
    return this.delegates;
  }

  catalog(): AgentCatalogEntry[] {
    return (this.fixture.world.catalog ?? []).map((entry) => ({ ...entry }));
  }

  async startAgent(input: StartAgentInput): Promise<StartAgentResult> {
    const known = this.catalog().some((entry) => entry.agentName === input.agentName);
    if (!known) {
      throw new HarnessError(
        `No agent called "${input.agentName}" can be started from this session. The agents you may start are listed in start_agent's own description.`,
        undefined,
        { code: "no_such_agent", next: "call start_agent again with an agent_name from the list in this tool's description" },
      );
    }
    const serial = ++this.started;
    const agent: ToolEvalWorldAgent = {
      agentName: input.agentName,
      subagentName: input.subagentName,
      sessionId: `ses_started_${String(serial)}`,
      runId: `run_started_${String(serial)}`,
      status: "running",
      task: input.task,
      messageCount: 0,
    };
    this.agents.push(agent);
    return {
      agentName: agent.agentName,
      subagentName: agent.subagentName,
      sessionId: agent.sessionId,
      runId: agent.runId,
      status: "running",
      cwd: `<worktree>/${agent.sessionId}`,
      isolation: {
        mode: input.worktree === false ? "shared" : "worktree",
        shape: "repo",
        reason: input.worktree === false ? "It works in your checkout, as you asked." : "It has a worktree of its own.",
      },
      ...(input.worktree === false ? {} : { branch: `agents/${agent.sessionId}` }),
    };
  }

  async sendAgentMessage(input: SendAgentMessageInput): Promise<SendAgentMessageResult> {
    const agent = this.bySession(input.sessionId);
    if (input.mode === "answer") {
      if (!agent.question) {
        return {
          sessionId: agent.sessionId,
          runId: agent.runId,
          status: agent.status,
          delivery: "refused",
          error: "That agent has no open question, so there was nothing to answer.",
        };
      }
      const answered = this.question(agent);
      agent.status = "running";
      delete agent.question;
      return { sessionId: agent.sessionId, runId: agent.runId, status: "running", delivery: "answered", answered };
    }
    return { sessionId: agent.sessionId, runId: agent.runId, status: agent.status, delivery: "delivered" };
  }

  async inspectFleet(): Promise<InspectFleetResult> {
    const rows: FleetRow[] = [
      ...this.agents.map((agent): FleetRow => ({
        kind: "agent",
        title: agent.subagentName,
        state: agent.status,
        status: FLEET_STATUS[agent.status],
        elapsed: "2m 10s",
        line: agent.task.slice(0, 120),
        startedAt: AT,
        depth: 0,
        children: [],
        agentName: agent.agentName,
        subagentName: agent.subagentName,
        sessionId: agent.sessionId,
        runId: agent.runId,
      })),
      ...this.commands.map((command): FleetRow => ({
        kind: "command",
        title: command.command,
        state: "running",
        status: "Working",
        line: command.command,
        startedAt: AT,
        depth: 0,
        children: [],
        taskId: command.taskId,
      })),
    ];
    const finished = this.agents.filter((agent) => agent.status !== "running" && agent.status !== "needs_input").length;
    return {
      rows,
      working: rows.length - finished - this.agents.filter((agent) => agent.status === "needs_input").length,
      needsYou: this.agents.filter((agent) => agent.status === "needs_input").length,
      finished,
      total: rows.length,
      omitted: 0,
    };
  }

  async inspectAgent(input: InspectAgentInput): Promise<InspectAgentResult> {
    const agent = this.byRunOrSession(input);
    const wanted = input.messages ?? 1;
    const messages = Array.from({ length: Math.min(wanted, agent.messageCount ?? 0) }, (_unused, index) => ({
      at: AT,
      // Long enough that asking for many of them costs real context, which is
      // what the truncation measure is about.
      text: `Step ${String(index + 1)}: ${"the agent reported progress on its task. ".repeat(12)}`,
    }));
    return {
      agentName: agent.agentName,
      subagentName: agent.subagentName,
      sessionId: agent.sessionId,
      runId: agent.runId,
      status: agent.status,
      startedAt: AT,
      task: agent.task,
      origin: "agent",
      depth: 1,
      cwd: `<worktree>/${agent.sessionId}`,
      worktree: agent.worktree
        ? { path: `<worktree>/${agent.sessionId}`, branch: agent.worktree.branch, exists: true, unmergedCommits: agent.worktree.unmergedCommits ?? 0, uncommittedFiles: 0 }
        : null,
      updatedAt: AT,
      messages,
      agents: [],
      ...(agent.question ? { question: this.question(agent) } : {}),
    };
  }

  async stopAgent(input: StopAgentInput): Promise<AgentRunSummary> {
    const agent = this.byRun(input.runId);
    agent.status = "cancelled";
    return {
      agentName: agent.agentName,
      subagentName: agent.subagentName,
      sessionId: agent.sessionId,
      runId: agent.runId,
      status: "cancelled",
      startedAt: AT,
      endedAt: AT,
      endedBy: { initiator: "parent", ...(input.reason !== undefined ? { reason: input.reason } : {}) },
    };
  }

  async removeAgentWorktree(input: RemoveAgentWorktreeInput): Promise<RemoveAgentWorktreeResult> {
    const agent = this.byRunOrSession(input);
    if (agent.status === "running" || agent.status === "needs_input") {
      throw new HarnessError(
        `${agent.subagentName} is still working. Removing its worktree now would take the directory out from under it.`,
        undefined,
        { code: "agent_still_running", next: "call stop_agent with its runId, or wait for its ending to be delivered to you, then call remove_agent_worktree again" },
      );
    }
    if (!agent.worktree) {
      throw new HarnessError(
        `${agent.subagentName} was started without a worktree of its own: it worked in your checkout, and there is nothing to remove.`,
        undefined,
        { code: "no_worktree", next: "carry on; nothing needs removing for this agent" },
      );
    }
    const unmerged = agent.worktree.unmergedCommits ?? 0;
    if (unmerged > 0 && input.force !== true) {
      throw new HarnessError(
        `${agent.worktree.branch} still holds ${String(unmerged)} commits your checkout does not have.`,
        undefined,
        {
          code: "unmerged_work",
          next: `merge ${agent.worktree.branch} with git and call remove_agent_worktree again, or pass force true to throw that work away`,
        },
      );
    }
    const branch = agent.worktree.branch;
    delete agent.worktree;
    return {
      agentName: agent.agentName,
      subagentName: agent.subagentName,
      sessionId: agent.sessionId,
      removed: true,
      path: `<worktree>/${agent.sessionId}`,
      branch,
      ...(unmerged > 0 ? { discarded: { commits: unmerged, uncommittedFiles: 0 } } : {}),
    };
  }

  async completeRun(input: CompleteRunInput): Promise<CompleteRunResult> {
    if (this.sessionRole.kind !== "child") return { ok: false, error: "This session is not an agent run, so it has nothing to complete." };
    return { ok: true, runId: this.sessionRole.runId ?? "run_child" };
  }

  onEvent(_deliver: (event: AgentModelEvent) => void): () => void {
    return () => {};
  }

  onRoleChange(_listener: (role: HarnessSessionRole) => void): () => void {
    return () => {};
  }

  // ------------------------------------------------------------- lookups

  /** The open question, in the protocol's own shape. */
  private question(agent: ToolEvalWorldAgent): AgentRunQuestion {
    return { id: `q_${agent.runId}`, kind: "input", title: agent.question?.text ?? "", askedAt: AT };
  }

  private bySession(sessionId: string): ToolEvalWorldAgent {
    const agent = this.agents.find((entry) => entry.sessionId === sessionId);
    if (!agent) throw this.unknown(`No agent with sessionId "${sessionId}" was started by this session.`);
    return agent;
  }

  private byRun(runId: string): ToolEvalWorldAgent {
    const agent = this.agents.find((entry) => entry.runId === runId);
    if (!agent) throw this.unknown(`No run called "${runId}" was started by this session.`);
    return agent;
  }

  private byRunOrSession(input: { runId?: string; sessionId?: string }): ToolEvalWorldAgent {
    if (input.runId !== undefined) return this.byRun(input.runId);
    if (input.sessionId !== undefined) return this.bySession(input.sessionId);
    throw this.unknown("Name the agent by a runId or a sessionId; this call named neither.");
  }

  private unknown(message: string): HarnessError {
    return new HarnessError(message, undefined, {
      code: "no_such_run",
      next: "call inspect_fleet to list the agents under you with their runIds, then call this tool with one of them",
    });
  }
}
