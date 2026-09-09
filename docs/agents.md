# Agents

Status: **binding for M13 (D-140).** Agents are first-class in Laser: a
person defines reusable agents on an Agents page, any session can start other
agents through one `start_agent` tool, every child is a sub-session the person
can chat with — in a worktree of its own unless its parent said otherwise — a
live map shows each top-level session's agent tree, long commands run as
background tasks, and Beam, Chat and Namer are built-in agents with their own
product integrations.

The binding references are
[`agents-leap/references/original-request.md`](agents-leap/references/original-request.md)
and
[`agents-leap/references/agent-harness-architecture.md`](agents-leap/references/agent-harness-architecture.md).
This document is the product and engineering reference for what was built on
them. The vocabulary is `packages/protocol/src/agents.ts`; the in-process
contract between the worker's harness and the companion extension is
`packages/pi-extension/src/agents-bridge.ts`.

Laser owns the harness. `pi-subagents` is no longer loaded or bundled; the
host file layer and CLI commands that observed it are retired by M13-T11.
Its reference notes stay at
[`agents-leap/references/pi-subagents-reference.md`](agents-leap/references/pi-subagents-reference.md)
because its run-directory discipline, control semantics and prompt hygiene
were copied on purpose.

---

## 1. Definitions

An agent definition is one reusable `agent_name` (`AgentDefinition`). The name
is the id: lower case, starts with a letter, letters/digits/hyphens, at most 40
characters. There is no separate agent id, type or profile name.

| Agents page field | Protocol field | Notes |
| --- | --- | --- |
| Name | `name` | Unique; built-in names (`beam`, `chat`, `namer`) are refused |
| Description | `description` | ≤ 300 chars. Answers "when should another agent start this one?" — it is the compact catalog text |
| Instructions | `instructions`, `engineInstructions` | Answers "how should this agent work?" The shipped `default` agent starts with `engineInstructions: true` (the engine's own prompt, readable through `agents/engine-instructions`) and a person may replace it with their own text |
| Model | `model` | `{ provider, id }` or `null` to follow the configured default model |
| Thinking | `thinkingLevel` | `null` follows the default |
| Supports subagents | `supportsSubagents` | When on, the agent gets `start_agent` and its siblings |
| Agents it can run | `allowedAgents` | Multi-select of custom agents; never a built-in. Meaningful only with `supportsSubagents` |
| Scoped skills | `scopedSkills`, `skills` | Off by default: every discovered skill is offered. On: only the listed `AgentSkillRef`s (`name`, `path`, `scope`), chosen from what the engine discovers at definition time (`agents/skills`, listing `<agentDir>/skills` and `~/.agents/skills` as `global`, `<project>/.laser/skills` and `<project>/.agents/skills` as `project` when the project is trusted) |
| Default | snapshot `defaultAgent` | "Default" only means the agent a new session opens with (the `i` mark beside the toggle says so). The current default cannot be deleted; pick another default first |

Policy (`AgentPolicy`, `agents/set-policy`): `maxDepth` (default 3, at most 6)
and `foregroundCommandSeconds` (default 120, 10–3600).

Validation (`agents/validate`, and the gate inside `agents/save`) returns
`AgentIssue[]`, each naming its field (`skills[2]`, `allowedAgents`, `name`) so
the form shows the message beside the control.

Periodic validation (`packages/host/src/agents/skills-check.ts`) stats every
scoped skill of every custom agent every 30 s and right after a save, and
flags a child list that names an agent that no longer exists. A problem
becomes an `AgentWarning { agentName, field, target, message, since }` on the
snapshot; the Agents page shows a gentle yellow warning and deep-links to the
exact field. `since` is when the problem was first seen and does not move
between ticks.

Kinds: `custom` (a person's, including the seeded `default`) and `builtin`
(Beam, Chat, Namer — visible at the bottom of the Agents page, never editable,
never deletable, never the default, never another agent's child; only their
model choices persist). All three take their model from the person, through
the same control on the Agents page and the same picker — connected providers
only (D-145). `AgentsSnapshot` carries `beam`, `chat` and `namer` state; Chat's
is the choice alone, because it has neither a suggestion nor a benchmark
behind it.

## 2. The harness

### One tool, four identities

A session that may delegate sees exactly one delegation tool, `start_agent`,
whose description carries the compact catalog: `name — description; …` for
the agents this session is allowed to start. The parent request never carries
another agent's instructions or model; the harness loads the full
configuration only when it starts that agent (in the child's own request).

The only identities are the four the reference names:

| Field | Means | Used for |
| --- | --- | --- |
| `agent_name` | the reusable definition (also its id) | choosing what to start |
| `subagent_name` | this running instance | the map node, the sidebar row, the worktree slug |
| `sessionId` | the persistent conversation | `send_agent_message`, `inspect_agent`, `remove_agent_worktree` |
| `runId` | one execution inside that session | `inspect_agent`, `stop_agent`, `remove_agent_worktree`, correlation |

Model-facing tools, registered by the companion extension's `subagents`
module from the worker-supplied `AgentHarnessBridge`:

| Tool | Who gets it | Does |
| --- | --- | --- |
| `start_agent { agent_name, subagent_name, task, worktree? }` | a session whose definition permits delegation and whose depth allows another level | validates the name against the allowed list and depth, loads the child's full configuration, creates the child session and (unless `worktree: false`) its worktree, starts the child loop in the background, returns `{ agent_name, subagent_name, sessionId, runId, status: "running", working_directory, branch?, guidance, your_responsibility }` immediately. `guidance` is the sentence the parent reads at the moment it matters: *Do not wait for `<name>`. Carry on with your own work; when it ends, its result will be sent to you as a message. Use `inspect_agent` with runId `<runId>` to check on it meanwhile — a status of `needs_input` means it is paused on a question you can answer with `send_agent_message`.* |
| `send_agent_message { sessionId, message, interrupt? }` | same | a running child receives it as its next instruction (`delivery: "queued"` while busy); an idle child starts a new run and the result carries the new `runId`; a child that is `needs_input` has its open question **answered** by the message (`delivery: "answered"`, the question returned as `answered`) — see "Questions" below |
| `list_agents` | same | runs this session started, newest first: identities, status, result, and the open `question` of a `needs_input` run — never transcripts |
| `inspect_agent { runId? \| sessionId?, messages? }` | same | one child in depth: everything `list_agents` says plus the **whole** task, `origin`, `depth`, `model`, `cwd` and `branch` (only with a worktree), the worktree as it is now (`exists`, `unmergedCommits`, `uncommittedFiles`, `removedAt?`), `activity` (turns, tool calls, the tool running now, when it was last active), its last assistant messages excerpted (`messages`: default `AGENT_INSPECT_MESSAGES_DEFAULT` = 1, at most `AGENT_INSPECT_MESSAGES_MAX` = 10, each cut at `AGENT_INSPECT_MESSAGE_EXCERPT` = 1000 characters), the question it is paused on, a `what_it_needs` sentence when it is stalled, and its own children as `list_agents` would list them. Read-only: it never wakes the child or delivers anything to it. A live child is read through its driver; an ended child whose driver is gone, from its session file |
| `stop_agent { runId, reason? }` | same | ends one run now with `endedBy: { initiator: "parent", reason }`; the session stays addressable |
| `remove_agent_worktree { sessionId? \| runId?, force? }` | same | removes a finished child's worktree and branch (M13-T42, §3 below) |
| `complete_agent_run { status: "completed" \| "blocked", message }` | every child | the only successful ending; the tool result terminates the child turn |

Children never block, and **parents never wait**: `start_agent` returns
before the child has done anything, there is no foreground mode, and there
is no waiting tool (M13-T45). A child's ending is delivered to its parent as
a message that wakes it (below), so nothing is lost by not waiting; a parent
that wants to know how a child is doing meanwhile calls `inspect_agent`. The
parent's guidelines and role block say so in the same words.

### Completion

`complete_agent_run` is handled mechanically by the harness: the message is
stored once as the child's normal final assistant message (so the child session
reads like a complete chat), the run is marked terminal and the child loop
stops, and the parent receives one structured event. A final text without the
tool is not a completion. A child that settles without calling it is nudged
once ("You stopped without calling complete_agent_run…", `NUDGE_TEXT` in
`packages/worker/src/agents/harness.ts`); if it settles again without the tool
the run is `failed` with "Ended without complete_agent_run" and the last
assistant text kept as context — never `completed`.

Every run the harness knows is published exactly once, as `agents/run`
(M13-T26): that notification and `agents/runs/list` are the single truth, and
the fleet, the sidebar and the live map all read it. There is no second
publication of the same facts.

### Events at a safe boundary

The harness pushes `AgentModelEvent`s (`agent.completed`, `agent.blocked`,
`agent.failed`, `agent.cancelled`, `agent.message`, `agent.needs_input`) to the
parent through the bridge. The `subagents` module delivers each one as a
custom message of type `lasercode/agent-event` (`AGENT_EVENT_MESSAGE_TYPE`)
with `deliverAs: "steer"` and `triggerTurn: true`: a running parent sees it
before its next model call, an idle parent wakes up, and the transcript stores
each event exactly once. The text the model reads is the event type, the four
identities, `endedBy` (with the person's verbatim reason) and the message. The
UI renders the same entry as the parent-side card (Handoff row in
[`ux-elements.md`](ux-elements.md)).

### States, and who sets them

`AgentRunStatus`: `queued`, `running`, `needs_input`, `completed`, `blocked`,
`failed`, `cancelled` (`AGENT_RUN_STATUSES`). Terminal states are the last
four (`AGENT_RUN_TERMINAL`, `AgentRunTerminalStatus`). There is no timed-out
state: nothing ends a run for taking long (D-144).

Three of these are live, and the one a parent most needs to tell apart from
`running` is `needs_input` (M13-T45):

| State | Live? | Means |
| --- | --- | --- |
| `running` | yes | the child is working |
| `needs_input` | yes, **stuck** | something the child did raised a question through the portable UI surface (`select`, `confirm`, `input`, `editor` — including any tool that asks before it acts) and its loop is paused until someone answers. The question is on `AgentRun.question` (`AgentRunQuestion`: `id`, `kind`, `title`, `detail?`, `options?`, `toolCallId?`, `toolName?`, `askedAt`). Nothing has ended |
| `blocked` | no | the child **ended** by saying it could not finish (`complete_agent_run { status: "blocked" }`); the question it asked its parent, if any, is its final `result.message` |

The parent can tell "working" from "stuck waiting on me" from the status
alone, in `list_agents`, `inspect_agent` and the `start_agent` guidance; in
the UI the two live shapes are "Working" (live tone) and "Asking" (attention
tone, the same warm hue as "Needs you"), and both `needs_input` and `blocked`
count as needing someone in the sidebar chip, the fleet and the map summary.

| State | Set by |
| --- | --- |
| `needs_input` | the harness, when the child's driver raises a `ui_request` while a run is active; back to `running` when the driver no longer holds that question — answered by the parent, answered by the person, timed out or aborted |
| `completed`, `blocked` | the child model, only through `complete_agent_run` |
| `cancelled` | `stop_agent` (initiator `parent`), `agents/runs/stop` (initiator `user`), or the host when the child's session is deleted (initiator `user`, reason "The session was deleted.") |
| `failed` | the harness on an engine error, on a child that settles twice without `complete_agent_run`, on a child session that closes or refuses the task while busy; the host when a project's worker dies or when it loads `agent-runs.json` after a restart (nothing non-terminal survives, reason "The project's worker stopped before this run ended.") |

`endedBy: { initiator: "parent" | "user" | "harness", reason? }` records who
ended a run. A person ending a run from the UI carries `initiator: "user"` and
the reason verbatim to the parent's event.

### Questions: what a stalled child needs, and who answers (M13-T45)

A child can stall on someone in exactly two ways, and each has its own
status:

1. **It raised a question and is paused on it** — `needs_input`. The question
   travels as a `ui_request` from the child's driver; the harness records it on
   the run (`question`), publishes the run, and sends the parent one
   `agent.needs_input` event (delivered like an ending: `steer`,
   `triggerTurn`, so an idle parent wakes). The event's text names the child,
   the tool that asked when one was running, the question, its choices, how to
   answer it, that the person may answer it instead in the child's own chat,
   and the `inspect_agent` call that shows whether it is still open. The
   oldest open question is the one the run shows; when it is settled and
   another is waiting, the run stays `needs_input` with that one and the parent
   is told again. A question dies with its run: ending a `needs_input` run
   drops it.

   Whoever answers first settles it. The person answers inline in the child's
   transcript, as before (`docs/ux-fleet.md` "Questions"). The parent answers
   through `send_agent_message { sessionId, message }`: while the child is
   `needs_input`, the message **is** the answer — one of the choices (by name,
   case-insensitively, or by 1-based number) for a `select`; a plain yes or no
   for a `confirm`; the text verbatim for an `input` or `editor`. Anything that
   does not fit is refused with the question restated, so an instruction can
   never silently pick an option. The result is
   `{ delivery: "answered", answered: <the question>, status }`, and the
   harness sees the question gone the same way it sees a person's answer: by
   re-reading the driver's open dialogs on the next event.

2. **It asked its parent something in its final message and ended** —
   `blocked`, unchanged. The parent reads the question without opening the
   session: it is the `result.message` in the `agent.blocked` event, in
   `list_agents` and in `inspect_agent` (whose `what_it_needs` says so and
   says how to reply: `send_agent_message` starts a new run in the same
   session with the child's history intact). The child's role block tells it
   this is the way to ask when it genuinely cannot go on.

Inspecting is read-only in both cases: nothing is prompted, steered or
answered by looking.

### Follow-up messages and user-origin runs

A child is a persistent, addressable session. The parent may
`send_agent_message` while it runs or after it finished; the person may open
the child from the sidebar or the map and type into the normal composer.
Either creates a new run on the same session when it is idle; a run the person
started has `origin: "user"`, one the parent started has `origin: "agent"`.
The child's role block is re-read every turn, so a new task reaches its
system prompt.

### Removing a child's worktree (M13-T42, D-157)

Merging is never a tool: it is the parent's own `git merge` in its own
checkout, because a merge tool would have to invent conflict semantics, and
conflicts are where a person's judgement belongs. What the parent gets is the
verb for the end of its ownership, `remove_agent_worktree`:

- Addressed by the identities that exist — the child's `sessionId` or one of
  its `runId`s — never a fifth one. Refused for a child another session
  started.
- Refused while the child is still working (its ending will be delivered;
  `stop_agent` ends it now), refused for a child started with `worktree:
  false` (it has none, and nothing in the parent's checkout is touched),
  refused when the worktree has already been removed.
- Refused, with what it holds and how to merge it, when the branch still has
  commits the parent's checkout does not have or uncommitted files
  (`WorktreeFacts` from `worktrees.facts()`; a count git could not produce is
  `null` and is refused too, never read as zero). `force: true` removes it
  anyway and the result says what was `discarded`.
- On success every run of that session, and the session's record, carry
  `worktree.removedAt`, so no reader offers a path that is gone; the names
  stay, because history is not deleted. The result carries the identities,
  `path`, `branch` and `removed: true`.

The person has the same lever from the fleet: an ended agent's expanded row
offers "Remove worktree…" (`RemoveWorktreeDialog`), which reads
`agents/worktree/status` on open, calls `agents/worktree/remove`, and is
refused by the host over unmerged work unless the person insists ("Remove
anyway"). Deleting a child session asks the same question up front:
`pi/session/delete { path, worktree?: "keep" | "delete" }` — **omitting it
means `keep`**, so a request that forgot the field never destroys work; with
`delete` the host removes the worktree with `force` after the transcript is
unlinked, because the person was shown what it held before choosing. Either
way the reply carries the worktree's status as it was.

### Nesting, model access, worktree ownership

Enforced in the harness, never by prompt alone: a child at `policy.maxDepth`
gets no `start_agent`; `allowedAgents` is checked on every start; a definition
that names a model the person has no credential for is refused with a
person-facing message (and flagged as a warning on the Agents page); a run may
only touch the worktree it created.

Every refusal is a `HarnessError` written for a person and, through the tool
result, for the parent model.

## 3. Worktrees

### The parent chooses (D-156)

`start_agent` takes `worktree?: boolean`. **Absent means true**, so an agent
that says nothing gets exactly what it always got. `worktree: false` is the
parent's judgement that this child only reads — a review, a search, an
explanation — and there is nothing to isolate:

- No worktree is created and no branch is made. The child's cwd is the
  parent's own cwd, and `AgentRun.worktree` is `null`.
- **Nothing is taken away.** The child keeps every tool (D-144 is unchanged),
  no write is refused, and no read-only mode exists. The judgement is the
  parent's; the harness does not second-guess it.
- **The child is told.** Its role block says, only in this case, that it is
  working in its parent's checkout and is not isolated from it — the one thing
  it needs in order to make the judgement this design assumes it will make.
- None of the worktree refusals below apply, so a project that is not a git
  repository, or has no commit yet, can still start a child this way. That is
  most of the point.
- Teardown removes nothing: a run with no worktree leaves nothing behind, and
  nothing in the parent's checkout is ever removed or cleaned.

Either way the result says where the child is working: `working_directory` is
always present, and `branch` is present only when the child has a worktree —
the absence is the signal, and no placeholder is invented. Both reach the UI:
the `start_agent` row in the transcript, the fleet's detail rows, the live
map's inspector, and `laser runs --json` (`cwd`).

### When a child does get one

Everything below is the isolated case, unchanged
(`packages/worker/src/agents/worktrees.ts`):

- Path: `<git toplevel>/.worktrees/<slug>` where `slug` is the sanitised
  `subagent_name` plus the run id suffix (`[a-z0-9-]`, ≤ 60 chars).
- Branch: `agents/<slug>`, created at the commit the parent's working
  directory is on. The child's cwd is the project's directory relative to the
  toplevel, inside the worktree.
- `/.worktrees/` is added once to `<gitdir>/info/exclude`, never to the
  person's `.gitignore`.
- `node_modules` from the parent's checkout is symlinked into the worktree when
  present there and absent in the worktree (best effort; a missing link costs
  an install, never a run).
- Ownership: the path must be a strict child of `.worktrees/`; an existing
  path is refused; a run owns at most one worktree; removal is `worktree
  remove --force`, branch delete, prune — only for a path that passes the same
  check.
- Refusals are person-facing: not a git repository ("Initialise git in the
  project first"), no commits yet ("Make a first commit"), a path another
  agent owns, or a worktree that did not land on the parent's commit.

A worktree of a project runs in that project's worker: invariant 5 reads a
`.worktrees/` child as part of its project, never as a second project
(`projectRootOf` in `packages/host/src/paths.ts`).

## 4. Sub-sessions in the sidebar

Every child is a real session with a real file, attributed by its first custom
entry (`lasercode/agent`). The catalog carries `SessionSummary.agent`
(`agentName`, `kind`, `subagentName`, `parentPath`, `rootPath`, `runId`,
`runStatus`), and the sessions sidebar lists a child under its parent —
D-19's "children never appear in the session list" is superseded. Opening a
child is the normal chat: the person reads it, sends a message to queue or to
interrupt, and ends the run through an end-agent action whose optional reason
reaches the parent. Beam sessions list under a Beam group with its own mark
rather than a folder; projectless chats live in the Chat tab.

## 5. The live map

Each top-level session has a read-only live map (`@xyflow/react`, the
React Flow skill under `.agents/skills/react-flow`). Nodes are the sessions of
the tree (`packages/ui/src/agents/run-tree.ts`: ids are session paths, so a
node keeps its identity across rebuilds; children are in creation order, never
attention order). Each node shows the agent and instance names, status, the
newest run's task excerpt and activity, and a "go to chat" action; a toggle
shows or folds ended agents. Edges are ancestry, from `AgentRun.parent`.

Transient events (`agents/event`: `started`, `message_sent`,
`message_received`, `needs_input`, `completed`, `blocked`, `failed`,
`cancelled`, `stop_requested`) appear as a gentle bubble inside the node that
owns them for a short while, then disappear. A node paused on a question says
"Asking", shows the question as its action, and the inspector lists the
choices; the header counts it as needing you, not as working.

Layout is chosen by the measured size of the surface — a constrained panel, the
full sidebar, fullscreen, a wide desktop and a phone each get a purpose-built
arrangement — and a layout is recomputed only when the tree's structure
changes, never on an output or status update. Reduced motion loses only the
movement.

## 6. Background tasks

The `background-work` module (`packages/pi-extension/src/modules/background-work.ts`)
owns long commands. It overrides the engine's `bash` with one that delegates
execution to the engine's own definition (shell resolution, environment,
process-tree kill, output truncation stay the engine's) and adds:

- `background: true` — start the command and return a task id at once;
- promotion — a foreground command still running after
  `policy.foregroundCommandSeconds` keeps running as the same task; the tool
  returns the output so far and the task id, and the task keeps every byte in
  its log file plus the last 256 KiB in memory, with its exit code when it
  ends;
- `task_list`, `task_output` and `task_stop` (`BACKGROUND_TOOL_NAMES`) to
  follow tasks — read output before the exit, or end one; there is no waiting
  tool (D-162, the rule D-158 set for child agents). A task is `running`,
  `completed`, `failed` or `stopped`;
- one `lasercode/task/update` per task carrying a `BackgroundTaskUpdate`
  (`packages/protocol/src/tasks.ts`), including the log file it streams into,
  so the host can serve `tasks/output` and the fleet can follow it; re-emits
  for output growth are throttled (M13-T26);
- exit notifications as a `lasercode/task-event` custom message
  (`TASK_EVENT_MESSAGE_TYPE`) carrying status, exit code, the tail of the
  output and the task id, delivered with `deliverAs: "steer"` and
  `triggerTurn: true` for every background exit, explicit or promoted alike:
  a running model sees it before its next call, an idle one wakes. The start
  result tells the model so (*Do not wait for task `<id>`. Carry on with your
  own work; when it exits, its status, exit code and the last lines of its
  output will be sent to you as a message.*). The one exception is the
  model's own choice, in words: `bash` with `background: true, notify: false`
  — a dev server, a watcher, anything it said it does not need to hear from —
  is recorded and shown with the next turn, never waking one. `notify`
  without `background` is ignored.

Background tasks and child agents share the fleet's run vocabulary.

### Tools and time

Every agent has every tool (D-144). A definition says what an agent is for in
its instructions, and what it may reach beyond its own work through its
allowed agents and the checkout it was given; a per-agent tool list was a second, weaker
answer to the same question and one more thing to keep in step with the
engine's own set. `web_search` follows the Web search feature, for everyone at
once.

Nothing ends a run for taking too long. There is no run timeout, no default
limit and no timed-out state: an agent may work for minutes or for months, and
a run ends only when the agent reports through `complete_agent_run`, a person
or its parent ends it, or it fails. A project with a run still going is never
idle, so its worker is never retired underneath it.

## 7. Built-in agents

| Agent | Runs in | Tools | Integration |
| --- | --- | --- | --- |
| `beam` | `<state>/workspaces/beam` (`workspaces.beam`) | every tool, like every agent; scoped to the one Beam skill | two ways in (D-143): the spark at the bottom left beside Settings, present in chat, Settings and logs, which opens a bubble that grows out of the icon and holds the normal chat — before the first message the middle hints that Beam is the assistant for Laser, and the first message creates a Beam session in Beam's group — and the `+` on Beam's group in the sessions sidebar, which starts a chat in the window instead. The bubble's maximize control moves the chat it is showing into the window. No other Beam entry point exists |
| `chat` | `<state>/workspaces/chat` (`workspaces.chat`) | every tool, in its own scratch workspace | the Chat tab, first in the sidebar before Code; projectless chats |
| `namer` | the project's own worker | not a session agent | names things from a small context |

**Beam's skill** (`packages/worker/src/agents/beam-skill.ts`) is written by the
worker on start, idempotently, at `<agentDir>/skills/<product>-beam/SKILL.md`
from the real paths of this installation: where sessions, agents, runs,
preferences, projects, logs and settings live and how a person moves around
the app. It is filtered out of every other agent's skills. Beam needs no
special tools because Laser writes its state to disk in real time.

**Beam's model** is an average-but-fast one. When the first provider is
connected and Beam has no model, the host sends `agents/beam/choose-model`
with a suggestion (`suggestBeamModel`: the priciest fast-tier model in the
mid-to-low price band among providers with a credential) and the UI opens the
choice dialog, which explains what Beam does. The suggestion is never applied
silently; `BeamState.needsChoice` stays true until the person picks or
dismisses.

**Namer** (`packages/worker/src/agents/namer.ts`) is a service, never a
session: one small completion per request with an 8 s ceiling, never two at
once for one session, and it never throws — a name that does not arrive is
simply not shown. It names a session from its first prompt (25–30 characters,
`SESSION_NAME_MIN`/`SESSION_NAME_MAX`, quotes and trailing punctuation
stripped, cut at a word boundary), a tool call the moment it starts (a
present-progressive label of at most 40 characters, sent as
`lasercode/namer/label { toolCallId, label }` before the tool ends) and an
in-progress aggregate in the chat view. Its model is qualified rather than
picked: `agents/namer/qualify` nominates cheap, connected models (never a name
matching opus/pro/ultra/max, never a list price over 3 per million tokens
combined, recognisably small ones first, at most six), times each on the
session-naming prompt, keeps the fastest valid answer and records
`NamerState { status, model, candidates, qualifiedAt, reason }`; `status` is
`unqualified`, `qualifying`, `ready` or `unavailable`.

## 8. Persistence

| Where | What |
| --- | --- |
| `<stateDir>/agents.json` | custom agents (the seeded `default` among them), `defaultAgent`, policy, Namer and Beam model choices, `revision`. Built-ins are rebuilt from `packages/host/src/agents/builtins.ts` on every load |
| `<stateDir>/agent-runs.json` | every `AgentRun` the host has heard of, fed by `agents/run` notifications; terminal runs kept 30 days and at most 500 per project; non-terminal runs are failed on host load and on worker loss |
| session custom entry `lasercode/agent` (`SESSION_AGENT_ENTRY_TYPE`) | the first custom entry of every agent-started or agent-defined session: `SessionAgentRecord { agentName, kind, subagentName, parentPath, parentSessionId, rootPath, runId, worktree? }` — `worktree` is absent for a child started with `worktree: false`, and that absence is what a reloaded session reads back — so a catalog that only reads files can attribute it |
| session custom entry `lasercode/agent-run` (`SESSION_RUN_ENTRY_TYPE`) | run lifecycle moments in the child session (started, completed, blocked, failed, cancelled); a question is transient and is not written |
| parent custom message `lasercode/agent-event` (`AGENT_EVENT_MESSAGE_TYPE`) | one message per event the parent received, stored once |
| `<project>/.worktrees/<slug>` | the child's checkout; `<gitdir>/info/exclude` hides it |

The worker keeps a cache of the definitions (`agents/sync` after
`pi/worker/status: ready` and on every change) with built-in fallbacks so a
session opened in the first milliseconds still runs as an agent.

## 9. Protocol

Requests (client → host unless noted):

| Method | Params → result |
| --- | --- |
| `agents/list` | `{}` → `AgentsSnapshot` |
| `agents/validate` | `{ agent }` → `{ issues }` |
| `agents/save` | `{ agent }` → `{ agent, snapshot }` |
| `agents/delete` | `{ name }` → `{ snapshot }` |
| `agents/set-default` | `{ name }` → `{ snapshot }` |
| `agents/set-policy` | `{ policy }` → `{ snapshot }` |
| `agents/skills` | `{ cwd }` → `AgentSkillsListing` (routed by cwd) |
| `agents/engine-instructions` | `{ cwd }` → `{ text }` (routed by cwd) |
| `agents/runs/list` | `{ path? }` → `{ runs }` (`path` narrows to that session's tree) |
| `agents/runs/stop` | `{ runId, reason? }` → `{ run }` (recorded as user-initiated; the parent is told) |
| `agents/builtin/set-model` | `{ name, model }` → `{ snapshot }` (`name` is `beam`, `chat` or `namer`; `null` follows the default model, and for Namer returns it to the next qualification) |
| `agents/namer/qualify` | `{ cwd }` → `NamerState` (routed to the built-in workspace worker) |
| `agents/sync` | host → worker only; refused from clients |
| `session/new` | gains `agentName?` (omitted = the default agent) |

Notifications (host → client): `agents/updated` (`AgentsSnapshot`),
`agents/run` (`{ run }`), `agents/event` (`AgentEvent`),
`agents/beam/choose-model` (`{ suggested }`). `SessionSummary.agent` and
`SessionState.agent` carry `SessionAgentInfo`.

Every method has a schema, a round-trip sample and a router owner
(`packages/protocol/test/schemas.test.ts`, AGENTS.md §6b).

## 10. Testing hooks

- `SANDBOX_AGENTS=1 pnpm sandbox` — the fake provider answers a prompt
  containing "delegate" with one `start_agent` call (`default` / `explorer`);
  a child request (its tool list carries `complete_agent_run`, or its system
  prompt names the subagent role without `start_agent`) answers `bash ls` and
  then `complete_agent_run` with "Counted the files."; everything else is one
  short text. The sandbox project is a git repository with one commit so a
  child gets a worktree; a prompt with both "delegate" and "review" starts the
  child with `worktree: false` instead, in the parent's own checkout. See the
  header of `scripts/sandbox.mjs`.
- The worker's harness test (`packages/worker/test/agents/`): a stub-provider
  child completes through `complete_agent_run` and its parent receives exactly
  one structured event — without waiting, because there is nothing to wait
  with; and (`golden.test.ts`, M13-T45) a child that raises a `select` through
  its real driver's UI bridge inside a running tool goes `needs_input`, its
  parent is woken, reads it through `inspect_agent` and answers it through
  `send_agent_message`, and the child's dialog resolves with that answer.
- The packaged gate: `check-packaged-session` reports the active modules and
  the Beam skill path; `packages/desktop/scripts/clean-machine.mjs` asserts
  `subagents` and `background-work` are active and that the skill file exists.

## 11. Regression checks

The binding list lives in `AGENTS.md` ("Agents harness regression checks"):

- One `start_agent` tool and four identities only.
- Children never block, and parents never wait: there is no waiting tool, and
  the `start_agent` result says not to.
- A child paused on a question is `needs_input`, never `running`; a child that
  ended asking is `blocked`. Every reader of `AgentRunStatus` — the sidebar
  chip and folds, the fleet, the live map, `agents/model.ts`, the CLI — has a
  test for the live-and-stuck value, in the attention tone, never folded away.
- `inspect_agent` is read-only and bounded (at most 10 excerpted messages).
- Every child gets a worktree or a person-facing refusal, unless its parent
  passed `worktree: false`; then it runs in the parent's checkout, is told so,
  and nothing there is removed when the run ends.
- Completion only through `complete_agent_run`, stored once.
- User termination carries `initiator: "user"` and the verbatim reason to the
  parent.
- The catalog in the parent request is compact.
- Test nesting depth, model access, worktree ownership,
  settle-without-completion and reload attribution.
- Background promotion keeps output and exit state.
- The live map never re-layouts on output updates.
- Beam has two ways in, and no more: the spark (the only thing that opens the
  bubble) and the `+` on its sidebar group (which opens a chat in the window).
- Dictation belongs to the composer that started it: with the bubble open,
  two composers are mounted, and a phrase must land where it was spoken.
