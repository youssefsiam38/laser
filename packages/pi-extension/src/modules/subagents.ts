/**
 * subagents — the model-facing half of the agent harness (D-140).
 *
 * The worker's harness (packages/worker/src/agents) owns runs, child
 * sessions, worktrees, timeouts and the parent notification. What only this
 * module can do, because it runs inside the engine session:
 *
 *   1. **Register the tools the model sees.** A parent-capable session gets
 *      exactly `start_agent`, `send_agent_message`, `inspect_fleet`,
 *      `inspect_agent`, `stop_agent` and `remove_agent_worktree`; a child
 *      gets `complete_agent_run`, the only successful ending of a run.
 *      `start_agent` is one generic tool over a compact catalog — never one
 *      tool per agent (docs/agents-leap/references/agent-harness-architecture.md).
 *      There is no waiting tool: a child's ending is delivered to its parent
 *      as a message that wakes it, so nothing is lost by not waiting;
 *      `inspect_fleet` shows the whole tree of work under the session — the
 *      agents and the background commands, in the fleet column's own rows
 *      (D-163) — and `inspect_agent` reads one agent in depth (M13-T45).
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
  AGENT_FLEET_ROWS_MAX,
  AGENT_INSPECT_MESSAGES_DEFAULT,
  AGENT_INSPECT_MESSAGES_MAX,
  AGENT_MESSAGE_MAX,
  AGENT_NAME_MAX,
  AGENT_TASK_EXCERPT,
  AGENT_TASK_MAX,
  SUBAGENT_NAME_MAX,
  type AgentRunQuestion,
} from "@lasercode/protocol";
import { Type } from "typebox";
import type {
  AgentCatalogEntry,
  AgentHarnessBridge,
  AgentModelEvent,
  AgentRunSummary,
  FleetRow,
  HarnessSessionRole,
  InspectAgentResult,
  InspectFleetResult,
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
  return (
    `Start another agent for an independent piece of work. Available agents: ${entries || "none are allowed for this session"}. ` +
    "It runs in the background: do not wait for it — its result is delivered to you as a message when it ends, and inspect_agent shows how it is doing meanwhile. " +
    "Unless you pass worktree false, the agent gets a git worktree and a branch of its own; reviewing that branch, merging it, and removing the worktree with remove_agent_worktree are yours, not the agent's."
  );
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
      'If you genuinely cannot go on without an answer from your parent, end with status "blocked" and put the question, and what you have done so far, in that final message: your parent reads it and can send you the answer, which starts a new run in this same session with your history intact.',
    );
    // Whose job the worktree is (M13-T42). A child that is not told this will
    // helpfully merge its own work away, and a parent that is not told will
    // leave the directory for ever; both sentences are written for the shape
    // this child is actually in, and neither names a branch that does not exist.
    parts.push(childWorktreeRule(role, cwd));
  }
  if (canDelegate) {
    parts.push(
      "You can start other agents with start_agent; they run in the background, by default each in its own isolated worktree, and their results arrive here as messages that wake you. Never wait for one: carry on with your own work. inspect_fleet shows everything going on under you — the agents you started, theirs, and every background command — as the one tree the person sees; use inspect_agent to check on a single agent — it also shows a question the agent is paused on, which you can answer with send_agent_message. Use stop_agent for work that is no longer needed.",
      "A child with its own worktree leaves its work on a branch of its own when it finishes. Reviewing that branch, merging it into your checkout with git, and removing the worktree with remove_agent_worktree are yours: nothing does any of it for you, and the directory stays until you ask for it to go. A child started with worktree false has neither a branch nor a worktree, because its changes are already in your files.",
    );
  }
  return parts.length > 0 ? parts.join("\n") : undefined;
}

function excerpt(text: string, max: number): string {
  const trimmed = text.trim();
  return trimmed.length > max ? `${trimmed.slice(0, max)}…` : trimmed;
}

/**
 * Where a child works and what it must not do there. Two shapes and only two
 * (D-156): a git worktree of its own, or its parent's checkout. Each sentence
 * is true in the shape it is written for, and a branch is named only when one
 * exists.
 */
export function childWorktreeRule(role: HarnessSessionRole, cwd: string): string {
  if (role.isolated === false) {
    return (
      `You are working in ${cwd}, your parent's own checkout, not a worktree of your own: you are not isolated from it. ` +
      "Your parent and any other agent in that checkout see every change you make there at once, so change only what your task actually asks for. " +
      "You have no branch and no worktree of your own, so there is nothing for you to merge and nothing to remove: leave your parent's git state alone — no branch, no merge, no commit it did not ask for — and say in your final message anything you left behind."
    );
  }
  const on = role.branch ? `, on the branch ${role.branch}` : "";
  return (
    `Work only inside your own worktree: ${cwd}${on}. ` +
    "Never write into your parent's checkout or another agent's. Do not merge your work anywhere and do not delete the worktree when you are done: your parent reviews the branch, merges what it wants and removes the worktree itself. " +
    "Say in your final message what you changed and where it is, so it can."
  );
}

/**
 * What `start_agent` answers: the four identities, the run's status, and the
 * fact the parent needs afterwards — where the child is working, and the
 * branch when it has one of its own. No branch means it is not isolated; the
 * absence is the signal, so no placeholder is invented.
 *
 * `guidance` is read at the one moment it matters — the parent has just
 * started something and is deciding what to do next — and says the thing the
 * old waiting tool used to imply the opposite of: do not wait (M13-T45).
 * `your_responsibility` is the other half of M13-T42: the parent is told, at
 * the moment it starts a child, that the branch and the directory are its own
 * to merge and to remove. A parent that is not told leaves worktrees for ever.
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
    guidance: startedGuidance(result),
    your_responsibility: startedResponsibility(result),
  };
}

/** The sentence a parent reads the moment a child starts: carry on; the ending comes to you. */
export function startedGuidance(result: Pick<StartAgentResult, "subagentName" | "runId">): string {
  return (
    `Do not wait for ${result.subagentName}. Carry on with your own work; when it ends, its result will be sent to you as a message. ` +
    `Use inspect_agent with runId ${result.runId} to check on it meanwhile — a status of needs_input means it is paused on a question you can answer with send_agent_message — or inspect_fleet to see everything running under you at once.`
  );
}

/**
 * `inspect_fleet`'s answer for the model: the tree in the fleet column's
 * rows, with the identities spelled the reference's way (`agent_name`,
 * `subagent_name`), a one-line summary, and the sentence that keeps the
 * parent from polling — endings come to it as messages.
 */
export function fleetView(result: InspectFleetResult): Record<string, unknown> {
  const rows = result.rows.map(fleetRowView);
  const summary = fleetSummary(result);
  return {
    summary,
    rows,
    ...(result.omitted > 0
      ? {
          omitted: result.omitted,
          note: `${result.omitted} more row${result.omitted === 1 ? "" : "s"} ${result.omitted === 1 ? "was" : "were"} left out, the deepest first; inspect_agent on an agent row lists the agents it started.`,
        }
      : {}),
    guidance:
      "Endings are sent to you as messages, so do not call inspect_fleet to wait. inspect_agent with a runId reads one agent in depth; task_output with a taskId reads one command's output; send_agent_message answers an agent that is Asking.",
  };
}

/** "2 working, 1 needs you, 3 finished" — what the fleet's header says, in words. */
export function fleetSummary(result: Pick<InspectFleetResult, "working" | "needsYou" | "finished" | "total">): string {
  if (result.total === 0) return "Nothing is running under this session, and nothing has finished: no agents started, no background commands.";
  const parts = [`${result.working} working`, `${result.needsYou} need${result.needsYou === 1 ? "s" : ""} you`, `${result.finished} finished`];
  return parts.join(", ");
}

function fleetRowView(row: FleetRow): Record<string, unknown> {
  let base: Record<string, unknown>;
  if (row.kind === "agent") {
    const { children: _children, agentName, subagentName, kind, ...others } = row;
    void _children;
    base = { kind, agent_name: agentName, subagent_name: subagentName, ...others };
  } else {
    const { children: _children, ...others } = row;
    void _children;
    base = { ...others };
  }
  return row.children.length > 0 ? { ...base, children: row.children.map(fleetRowView) } : base;
}

/** True in both shapes, and it names a branch only when there is one. */
export function startedResponsibility(result: Pick<StartAgentResult, "cwd" | "branch" | "subagentName">): string {
  if (result.branch === undefined) {
    return `${result.subagentName} is working in your own checkout (${result.cwd}), so its changes land in your files as it makes them. There is no branch and no worktree to merge or remove.`;
  }
  return (
    `When ${result.subagentName} finishes, its work is on the branch ${result.branch} in ${result.cwd}. ` +
    `Reviewing it, merging it into your own checkout with git, and then removing the worktree with remove_agent_worktree are yours to do — nothing removes it for you.`
  );
}

/** The reference's vocabulary for the model: `agent_name` / `subagent_name`, never camel case. */
function modelView(summary: AgentRunSummary | (Omit<AgentRunSummary, "startedAt"> & { startedAt?: string })): Record<string, unknown> {
  const { agentName, subagentName, ...rest } = summary;
  return { agent_name: agentName, subagent_name: subagentName, ...rest };
}

/**
 * `inspect_agent`'s answer, with one sentence the parent can act on when the
 * child is waiting on someone: an open question while it is `needs_input`, or
 * the final message it ended `blocked` with.
 */
export function inspectedView(result: InspectAgentResult): Record<string, unknown> {
  const { agents, ...rest } = result;
  const needs = whatItNeeds(result);
  return { ...modelView(rest), ...(needs !== undefined ? { what_it_needs: needs } : {}), agents: agents.map(modelView) };
}

/** What a stalled child needs from its parent, or nothing for a child that is working or done. */
export function whatItNeeds(result: Pick<InspectAgentResult, "status" | "subagentName" | "question" | "result">): string | undefined {
  if (result.status === "needs_input" && result.question) {
    return `${result.subagentName} is paused on a question and cannot continue until it is answered. ${answerHint(result.question)} The person can also answer it in ${result.subagentName}'s own chat.`;
  }
  if (result.status === "blocked") {
    return `${result.subagentName} ended without finishing; its final message says what it could not do or is asking you. Answer with send_agent_message: that starts a new run in the same session, with its history intact.`;
  }
  return undefined;
}

/** How to answer a question of this kind, said once here and once in the harness's event (they must agree). */
function answerHint(question: AgentRunQuestion): string {
  const call = "send_agent_message with its sessionId";
  switch (question.kind) {
    case "select":
      return `Answer it with ${call} and one of the choices, exactly, as the message.`;
    case "confirm":
      return `Answer it with ${call} and "yes" or "no" as the message.`;
    case "input":
      return `Answer it with ${call}; the message is the answer, verbatim.`;
    case "editor":
      return `Answer it with ${call}; the message replaces the text, verbatim.`;
  }
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
      "Use start_agent for independent work another agent can do in parallel; it returns immediately with sessionId and runId. Do not wait for it and do not poll: its result is delivered to you as a message when it ends, and inspect_agent shows one agent in depth meanwhile.",
      "Give start_agent a self-contained task: the new agent sees none of this conversation.",
      "Leave start_agent's worktree alone for work that changes files, and pass worktree false only for a task that just reads, such as a review or a search.",
      "A worktree start_agent created is yours afterwards: review the branch, merge it yourself with git, then call remove_agent_worktree. The child never merges or removes its own work.",
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
      "Send a message to an agent you started, addressed by its sessionId. A running agent receives it as its next instruction; an idle agent starts a new run and the result carries the new runId. " +
      "An agent whose status is needs_input is paused on a question, and your message answers it: one of the choices for a select, yes or no for a confirm, the text itself for an input or editor — anything else is refused with the question restated. " +
      "The result's delivery says what became of the message: queued (waiting its turn, or behind a run the agent is finishing), delivered (the agent's engine accepted it as its next turn), answered (it settled an open question), or refused (the engine would not take it; error says why and the attempt is recorded as a failed run).",
    promptSnippet: "Continue a conversation with an agent you started, or answer its question, by sessionId",
    promptGuidelines: [
      "Use send_agent_message with sessionId to continue a conversation with an agent; set interrupt true only when it must change course now.",
      "When an agent is needs_input, send_agent_message answers its open question; inspect_agent shows the question and the kind of answer it takes.",
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

  // D-163: the agent reads running work the way the person does — one tree,
  // both kinds of work, the same words — scoped to what is under it.
  pi.registerTool({
    name: "inspect_fleet",
    label: "Inspect the fleet",
    description:
      "The work going on under this session, as one tree: the agents you started, the agents they started, and the background commands any of them — you included — left running or finished. " +
      "It is the same tree, in the same words, that the person sees in the fleet column. Each row says its kind (agent or command), its name, its status word (Working, Asking, Needs you, Done, Failed, Ended, Waiting), " +
      "how long it has run, and one line — what it is doing, or how it ended — plus the id to follow it with: an agent row's runId for inspect_agent, a command row's taskId for task_output. " +
      "Asking means an agent is paused on a question you can answer with send_agent_message; Needs you means it ended asking you something. " +
      `At most ${String(AGENT_FLEET_ROWS_MAX)} rows, the deepest cut first; the result says how many were left out. Read-only: it wakes nothing and sends nothing.`,
    promptSnippet: "See everything running under you — agents and background commands — as the tree the person sees",
    promptGuidelines: [
      "Use inspect_fleet to see what is running, asking, or ended under you, agents and background commands alike; do not call inspect_fleet repeatedly to wait for a result, which is delivered to you as a message when the work ends.",
    ],
    parameters: Type.Object({}),
    async execute() {
      const result = await bridge.inspectFleet();
      return asResult(fleetView(result), result);
    },
  });

  // M13-T45: the one way to look closely at an agent without reading its
  // whole conversation into this context. Read-only, so it is always safe.
  pi.registerTool({
    name: "inspect_agent",
    label: "Inspect an agent",
    description:
      "One agent in depth — any agent row inspect_fleet shows: one you started, or one an agent of yours started. Its identities and status, its result when it has ended, its whole task, where it works and whether that directory still exists, its activity (turns, tool calls, the tool running now, when it was last active), " +
      "its last assistant messages (excerpted; 1 by default, at most " + String(AGENT_INSPECT_MESSAGES_MAX) + "), the question it is paused on when its status is needs_input (paused on a question until someone answers), and any agents it started itself. " +
      "Statuses: running, needs_input, completed, blocked (ended without finishing; its final message says what it needs), failed, cancelled. " +
      "Address it by a sessionId or runId from start_agent or inspect_fleet. Read-only: it never wakes the agent or sends it anything.",
    promptSnippet: "Look closely at one agent under you: task, activity, last words, open question",
    promptGuidelines: [
      "Use inspect_agent, by runId or sessionId, to check on one agent — never to wait for it: its ending is delivered to you as a message.",
      "Keep inspect_agent's messages small; pulling an agent's whole conversation into your context defeats delegating.",
    ],
    parameters: Type.Object({
      runId: Type.Optional(Type.String({ minLength: 1, description: "A runId from start_agent or inspect_fleet." })),
      sessionId: Type.Optional(Type.String({ minLength: 1, description: "The agent's sessionId, if you have that rather than a runId." })),
      messages: Type.Optional(
        Type.Integer({
          minimum: 0,
          maximum: AGENT_INSPECT_MESSAGES_MAX,
          description: `How many of the agent's last assistant messages to include, excerpted. Default ${AGENT_INSPECT_MESSAGES_DEFAULT}; at most ${AGENT_INSPECT_MESSAGES_MAX}.`,
        }),
      ),
    }),
    async execute(_toolCallId, params) {
      const result = await bridge.inspectAgent({
        ...(params.runId !== undefined ? { runId: params.runId } : {}),
        ...(params.sessionId !== undefined ? { sessionId: params.sessionId } : {}),
        ...(params.messages !== undefined ? { messages: params.messages } : {}),
      });
      return asResult(inspectedView(result), result);
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

  // M13-T42: the parent owns a child's worktree, so it needs a verb for the
  // end of that ownership. There is deliberately no merge tool — merging is
  // `git merge` in the parent's own checkout, and a tool would have to invent
  // conflict semantics, which is exactly where a person's judgement belongs.
  pi.registerTool({
    name: "remove_agent_worktree",
    label: "Remove an agent's worktree",
    description:
      "Remove the worktree and branch of an agent you started, once you have merged its work or decided against it. Address it by the sessionId or a runId start_agent returned. " +
      "Refused while that agent is still working, refused for an agent started with worktree false (it has none), and refused when the branch still holds commits or changes your checkout does not have — merge those first, or pass force true to throw them away.",
    promptSnippet: "Remove a finished agent's worktree, once its work is merged or rejected",
    promptGuidelines: [
      "When an agent you started has finished and you have merged or rejected its branch, call remove_agent_worktree so its directory does not stay under .worktrees for ever; nothing removes it for you.",
      "If remove_agent_worktree says the branch still holds unmerged work, merge it with git first and call it again; use force only when that work is genuinely to be thrown away.",
    ],
    parameters: Type.Object({
      sessionId: Type.Optional(Type.String({ minLength: 1, description: "The sessionId start_agent returned for that agent." })),
      runId: Type.Optional(Type.String({ minLength: 1, description: "A runId of that agent, if you have it rather than the sessionId." })),
      force: Type.Optional(
        Type.Boolean({
          description: "Remove it even though the branch still holds work your checkout does not have. Default false. Only for work you are deliberately throwing away.",
        }),
      ),
    }),
    async execute(_toolCallId, params) {
      const result = await bridge.removeAgentWorktree({
        ...(params.sessionId !== undefined ? { sessionId: params.sessionId } : {}),
        ...(params.runId !== undefined ? { runId: params.runId } : {}),
        ...(params.force !== undefined ? { force: params.force } : {}),
      });
      const { agentName, subagentName, ...rest } = result;
      return asResult({ agent_name: agentName, subagent_name: subagentName, ...rest }, result);
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
