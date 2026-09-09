/**
 * subagents — the model-facing half of the agent harness (D-140).
 *
 * The worker's harness (packages/worker/src/agents) owns runs, child
 * sessions, worktrees, timeouts and the parent notification. What only this
 * module can do, because it runs inside the engine session:
 *
 *   1. **Register the tools the model sees.** A parent-capable session gets
 *      exactly `start_agent`, `send_agent_message`, `list_agents`,
 *      `wait_for_agents` and `stop_agent`; a child gets `complete_agent_run`,
 *      the only successful ending of a run. `start_agent` is one generic tool
 *      over a compact catalog — never one tool per agent
 *      (docs/agents-leap/references/agent-harness-architecture.md).
 *   2. **Tell a child who it is.** Its role — instance name, definition,
 *      task, the person's goal for the parent, and the checkout it works in
 *      (its own worktree, or its parent's, said plainly) — is appended to the
 *      system prompt each turn; nothing is written into the transcript.
 *   3. **Deliver agent events to the parent model** at a safe boundary, as
 *      one custom message per event (`AGENT_EVENT_MESSAGE_TYPE`), so the
 *      transcript stores each event once and the UI can render it.
 *
 * Every call delegates to the {@link AgentHarnessBridge}; a rejection is
 * rethrown so the engine marks the tool result as an error. The module never
 * touches sessions, files or worktrees itself.
 */
import { StringEnum } from "@earendil-works/pi-ai";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import {
  AGENT_EVENT_MESSAGE_TYPE,
  AGENT_MESSAGE_MAX,
  AGENT_NAME_MAX,
  AGENT_TASK_EXCERPT,
  AGENT_TASK_MAX,
  SUBAGENT_NAME_MAX,
} from "@lasercode/protocol";
import { Type } from "typebox";
import type {
  AgentCatalogEntry,
  AgentHarnessBridge,
  AgentModelEvent,
  AgentRunSummary,
  HarnessSessionRole,
  StartAgentResult,
} from "../agents-bridge.js";
import type { LaserModule, ModuleContext } from "./index.js";

interface State {
  /** The catalog `start_agent` was last registered with; re-registered only when it changes. */
  catalogKey: string;
  offRoleChange?: () => void;
}

const states = new WeakMap<ModuleContext, State>();

// ---------------------------------------------------------------------------
// Text the model reads
// ---------------------------------------------------------------------------

/** The reference's description with the compact catalog appended: `name — description; …`. */
export function startAgentDescription(catalog: AgentCatalogEntry[]): string {
  const entries = catalog.map((entry) => `${entry.agentName} — ${entry.description}`).join("; ");
  return `Start another agent for an independent piece of work. Available agents: ${entries || "none are allowed for this session"}.`;
}

/**
 * One event, as a compact block the model can read: the type, the four
 * identities, who ended it (with the person's verbatim reason) and the message.
 */
export function formatEvent(event: AgentModelEvent): string {
  const lines = [
    event.type,
    `agent_name: ${event.agentName}`,
    `subagent_name: ${event.subagentName}`,
    `sessionId: ${event.sessionId}`,
    `runId: ${event.runId}`,
  ];
  if (event.endedBy) {
    lines.push(`endedBy: ${event.endedBy.initiator}${event.endedBy.reason ? ` — ${event.endedBy.reason}` : ""}`);
  }
  lines.push("", event.message);
  return lines.join("\n");
}

/**
 * What is appended to the system prompt. A child learns its role; a
 * parent-capable session gets a two-sentence reminder of how delegation
 * works. A child that can also delegate gets both.
 */
export function roleBlock(role: HarnessSessionRole, canDelegate: boolean, cwd: string): string | undefined {
  const parts: string[] = [];
  if (role.kind === "child") {
    const instance = role.subagentName ?? role.agentName;
    const parent = role.parent
      ? `your parent agent "${role.parent.agentName}"${role.parent.subagentName ? ` (${role.parent.subagentName})` : ""}, session ${role.parent.sessionId},`
      : "your parent agent";
    const task = excerpt(role.task ?? "", AGENT_TASK_EXCERPT);
    parts.push(
      "# Your role",
      `You are "${instance}", an instance of the agent "${role.agentName}", started by ${parent} to do this task:`,
      task ? task.split("\n").map((line) => `> ${line}`).join("\n") : "> (the task is in the first message)",
    );
    if (role.goal) {
      parts.push(
        `The person's active goal for the parent is: "${role.goal.objective}". Your role is only your task toward that goal; the parent owns the goal itself.`,
      );
    }
    parts.push(
      'End your work by calling complete_agent_run with status "completed" or "blocked" and a self-contained final message: what you did, the evidence, and any important next step. It is the only way this run ends; do not write a closing reply instead of it. Do not ask the parent questions you can answer yourself by reading the code.',
    );
    // The one sentence a child that shares its parent's checkout is owed: it
    // keeps every tool, so it can only judge what to touch if it is told.
    parts.push(
      role.isolated === false
        ? `You are working in ${cwd}, your parent's own checkout, not a worktree of your own: you are not isolated from it. Your parent and any other agent in that checkout see every change you make there at once, so change only what your task actually asks for, and say in your final message anything you left behind.`
        : `Work only inside your own worktree: ${cwd}.`,
    );
  }
  if (canDelegate) {
    parts.push(
      "You can start other agents with start_agent; they run in the background, by default each in its own isolated worktree, and their results arrive here as messages. Use wait_for_agents when you need a result before continuing, and stop_agent for work that is no longer needed.",
    );
  }
  return parts.length > 0 ? parts.join("\n") : undefined;
}

function excerpt(text: string, max: number): string {
  const trimmed = text.trim();
  return trimmed.length > max ? `${trimmed.slice(0, max)}…` : trimmed;
}

/**
 * What `start_agent` answers: the four identities, the run's status, and the
 * fact the parent needs afterwards — where the child is working, and the
 * branch when it has one of its own. No branch means it is not isolated; the
 * absence is the signal, so no placeholder is invented.
 */
export function startedView(result: StartAgentResult): Record<string, unknown> {
  return {
    agent_name: result.agentName,
    subagent_name: result.subagentName,
    sessionId: result.sessionId,
    runId: result.runId,
    status: result.status,
    working_directory: result.cwd,
    ...(result.branch !== undefined ? { branch: result.branch } : {}),
  };
}

/** The reference's vocabulary for the model: `agent_name` / `subagent_name`, never camel case. */
function modelView(summary: AgentRunSummary | (Omit<AgentRunSummary, "startedAt"> & { startedAt?: string })): Record<string, unknown> {
  const { agentName, subagentName, ...rest } = summary;
  return { agent_name: agentName, subagent_name: subagentName, ...rest };
}

function asResult(view: unknown, details: unknown) {
  return { content: [{ type: "text" as const, text: JSON.stringify(view, null, 2) }], details };
}

// ---------------------------------------------------------------------------
// Tools
// ---------------------------------------------------------------------------

function registerStartAgent(pi: ExtensionAPI, bridge: AgentHarnessBridge, catalog: AgentCatalogEntry[]): void {
  pi.registerTool({
    name: "start_agent",
    label: "Start an agent",
    description: startAgentDescription(catalog),
    promptSnippet: "Start another agent in the background for an independent piece of work",
    promptGuidelines: [
      "Use start_agent for independent work another agent can do in parallel; it returns immediately with sessionId and runId, so continue working or call wait_for_agents rather than polling with list_agents.",
      "Give start_agent a self-contained task: the new agent sees none of this conversation.",
      "Leave start_agent's worktree alone for work that changes files, and pass worktree false only for a task that just reads, such as a review or a search.",
    ],
    parameters: Type.Object({
      agent_name: Type.String({ minLength: 1, maxLength: AGENT_NAME_MAX, description: "The unique name of the reusable agent to start." }),
      subagent_name: Type.String({ minLength: 1, maxLength: SUBAGENT_NAME_MAX, description: "A short name for this running instance and its task." }),
      task: Type.String({ minLength: 1, maxLength: AGENT_TASK_MAX, description: "The complete task and all context the new agent needs." }),
      worktree: Type.Optional(
        Type.Boolean({
          description:
            "Give the new agent its own git worktree, isolated from your files. Default true. Pass false for a task that only reads — a review, a search, an explanation: the agent then works in the same checkout and the same files as you, keeps every tool, and anything it writes lands in your working copy. false is also the only way to start an agent in a project that is not a git repository or has no commit yet.",
        }),
      ),
    }),
    async execute(_toolCallId, params, signal) {
      const result = await bridge.startAgent(
        {
          agentName: params.agent_name,
          subagentName: params.subagent_name,
          task: params.task,
          ...(params.worktree !== undefined ? { worktree: params.worktree } : {}),
        },
        signal,
      );
      return asResult(startedView(result), result);
    },
  });
}

function registerParentTools(pi: ExtensionAPI, bridge: AgentHarnessBridge): void {
  pi.registerTool({
    name: "send_agent_message",
    label: "Message an agent",
    description:
      "Send a message to an agent you started, addressed by its sessionId. A running agent receives it as its next instruction; an idle agent starts a new run and the result carries the new runId.",
    promptSnippet: "Continue a conversation with an agent you started, by sessionId",
    promptGuidelines: [
      "Use send_agent_message with sessionId to continue a conversation with an agent; set interrupt true only when it must change course now.",
    ],
    parameters: Type.Object({
      sessionId: Type.String({ minLength: 1, description: "The sessionId returned by start_agent." }),
      message: Type.String({ minLength: 1, maxLength: AGENT_MESSAGE_MAX, description: "What the agent should do or know next." }),
      interrupt: Type.Optional(
        Type.Boolean({ description: "Deliver now, interrupting current work. Default false: the message waits for the current work to finish." }),
      ),
    }),
    async execute(_toolCallId, params) {
      const result = await bridge.sendAgentMessage({ sessionId: params.sessionId, message: params.message, interrupt: params.interrupt === true });
      return asResult(result, result);
    },
  });

  pi.registerTool({
    name: "list_agents",
    label: "List agents",
    description: "List the agents this session started, newest first, with each one's status and result when it has ended.",
    promptSnippet: "List the agents this session started and their status",
    promptGuidelines: ["Use list_agents to see what is running or has ended; use wait_for_agents, not repeated list_agents calls, to wait for a result."],
    parameters: Type.Object({}),
    async execute() {
      const runs = await bridge.listAgents();
      return asResult({ agents: runs.map(modelView) }, { runs });
    },
  });

  pi.registerTool({
    name: "wait_for_agents",
    label: "Wait for agents",
    description:
      "Block until the given runs have ended or the timeout passes. Returns each run's status and final message; timedOut is true when some were still running.",
    promptSnippet: "Wait for runs you started to end, by runId",
    promptGuidelines: ["Use wait_for_agents with the runIds you need before continuing; it returns each run's final message, so you do not need to read child sessions."],
    parameters: Type.Object({
      runIds: Type.Array(Type.String({ minLength: 1 }), { minItems: 1, maxItems: 100, description: "The runIds to wait for." }),
      timeoutSeconds: Type.Optional(Type.Number({ minimum: 1, description: "Return with timedOut true after this many seconds; omit for the harness default." })),
    }),
    async execute(_toolCallId, params, signal) {
      const result = await bridge.waitForAgents(
        { runIds: params.runIds, ...(params.timeoutSeconds !== undefined ? { timeoutSeconds: params.timeoutSeconds } : {}) },
        signal,
      );
      return asResult({ runs: result.runs.map(modelView), timedOut: result.timedOut }, result);
    },
  });

  pi.registerTool({
    name: "stop_agent",
    label: "Stop an agent",
    description: "End one run now. The agent's session stays and can be messaged again later.",
    promptSnippet: "Stop a run that is no longer needed, by runId",
    promptGuidelines: ["Use stop_agent only for work that is no longer needed; give a reason."],
    parameters: Type.Object({
      runId: Type.String({ minLength: 1, description: "The runId to stop." }),
      reason: Type.Optional(Type.String({ maxLength: 1000, description: "Why it is no longer needed; recorded with the run." })),
    }),
    async execute(_toolCallId, params) {
      const result = await bridge.stopAgent({ runId: params.runId, ...(params.reason !== undefined ? { reason: params.reason } : {}) });
      return asResult(modelView(result), result);
    },
  });
}

function registerCompleteRun(pi: ExtensionAPI, bridge: AgentHarnessBridge): void {
  pi.registerTool({
    name: "complete_agent_run",
    label: "Complete this run",
    description: "Finish the current run and publish its final message.",
    promptSnippet: "Finish the current run and publish its final message",
    promptGuidelines: [
      "Call complete_agent_run exactly once, as your last action, with a self-contained final message; it ends the run, so do not write a separate closing reply.",
    ],
    parameters: Type.Object({
      status: StringEnum(["completed", "blocked"] as const, {
        description: "completed when the task is done; blocked when it cannot be finished — say what is missing in the message.",
      }),
      message: Type.String({ minLength: 1, maxLength: AGENT_MESSAGE_MAX, description: "The final result, evidence, and any important next step." }),
    }),
    async execute(_toolCallId, { status, message }) {
      const result = await bridge.completeRun({ status, message });
      if (!result.ok) throw new Error(result.error);
      return {
        content: [{ type: "text" as const, text: `Run ${result.runId} ended with status ${status}. Do not send another message.` }],
        details: { runId: result.runId, status },
        terminate: true,
      };
    },
  });
}

// ---------------------------------------------------------------------------
// The module
// ---------------------------------------------------------------------------

export const subagentsModule: LaserModule = {
  name: "subagents",

  detect: (ctx) => Boolean(ctx.agents),

  register(ctx) {
    const bridge = ctx.agents;
    if (!bridge) return;
    const { pi } = ctx;
    const state: State = { catalogKey: "" };
    states.set(ctx, state);

    const role = bridge.role();
    if (role.kind === "child") registerCompleteRun(pi, bridge);
    if (bridge.canDelegate()) {
      const catalog = bridge.catalog();
      state.catalogKey = JSON.stringify(catalog);
      registerStartAgent(pi, bridge, catalog);
      registerParentTools(pi, bridge);
    }

    // A new run on this session may change which agents it may start. Only
    // `start_agent` carries the catalog, and re-registering the same name
    // replaces it in place; everything else stays as it was registered.
    state.offRoleChange = bridge.onRoleChange(() => {
      if (!bridge.canDelegate() || !state.catalogKey) return;
      const catalog = bridge.catalog();
      const key = JSON.stringify(catalog);
      if (key === state.catalogKey) return;
      state.catalogKey = key;
      try {
        registerStartAgent(pi, bridge, catalog);
      } catch (error) {
        ctx.send({ type: "lasercode/module/log", module: "subagents", level: "warn", message: `could not refresh start_agent: ${describe(error)}` });
      }
    });
  },

  activate(ctx) {
    const bridge = ctx.agents;
    if (!bridge) return;
    const { pi } = ctx;
    let disposed = false;

    // Parent side: each event becomes one custom message, stored once in this
    // transcript. `steer` lands it before the next model call of a running
    // turn; `triggerTurn` wakes an idle parent so a result is never left
    // waiting for the person to type something.
    const offEvent = bridge.onEvent((event) => {
      if (disposed) return;
      try {
        pi.sendMessage(
          { customType: AGENT_EVENT_MESSAGE_TYPE, content: formatEvent(event), display: true, details: event },
          { deliverAs: "steer", triggerTurn: true },
        );
      } catch (error) {
        ctx.send({ type: "lasercode/module/log", module: "subagents", level: "warn", message: `could not deliver an agent event: ${describe(error)}` });
      }
    });

    // Child side (and the delegation reminder): re-read the role every turn,
    // because a follow-up message starts a new run with a new task.
    pi.on("before_agent_start", (event, session) => {
      if (disposed) return undefined;
      const block = roleBlock(bridge.role(), bridge.canDelegate(), session.cwd);
      if (!block) return undefined;
      return { systemPrompt: `${event.systemPrompt}\n\n${block}` };
    });

    return () => {
      disposed = true;
      offEvent();
      states.get(ctx)?.offRoleChange?.();
    };
  },
};

function describe(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
