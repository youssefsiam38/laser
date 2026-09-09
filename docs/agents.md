# Agents

Status: **binding for M13 (D-140).** Agents are first-class in Laser: a
person defines reusable agents on an Agents page, any session can start other
agents through one `start_agent` tool, every child is an isolated-worktree
sub-session the person can chat with, a live map shows each top-level
session's agent tree, long commands run as background tasks, and Beam, Chat
and Namer are built-in agents with their own product integrations.

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
| `sessionId` | the persistent conversation | `send_agent_message` |
| `runId` | one execution inside that session | `wait_for_agents`, `stop_agent`, correlation |

Model-facing tools, registered by the companion extension's `subagents`
module from the worker-supplied `AgentHarnessBridge`:

| Tool | Who gets it | Does |
| --- | --- | --- |
| `start_agent { agent_name, subagent_name, task }` | a session whose definition permits delegation and whose depth allows another level | validates the name against the allowed list and depth, loads the child's full configuration, creates the child session and its worktree, starts the child loop in the background, returns `{ agent_name, subagent_name, sessionId, runId, status: "running" }` immediately |
| `send_agent_message { sessionId, message, interrupt? }` | same | a running child receives it as its next instruction (`delivery: "queued"` while busy); an idle child starts a new run and the result carries the new `runId` |
| `list_agents` | same | runs this session started, newest first: identities, status, result — never transcripts |
| `wait_for_agents { runIds, timeoutSeconds? }` | same | blocks until those runs end or the timeout passes; `timedOut: true` when some were still running |
| `stop_agent { runId, reason? }` | same | ends one run now with `endedBy: { initiator: "parent", reason }`; the session stays addressable |
| `complete_agent_run { status: "completed" \| "blocked", message }` | every child | the only successful ending; the tool result terminates the child turn |

Children never block: `start_agent` returns before the child has done
anything, and there is no foreground mode.

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

`wait_for_agents` waits 600 s by default and at most 3600 s. Every run the
harness knows is published exactly once, as `agents/run` (M13-T26): that
notification and `agents/runs/list` are the single truth, and the fleet, the
sidebar and the live map all read it. There is no second publication of the
same facts.

### Events at a safe boundary

The harness pushes `AgentModelEvent`s (`agent.completed`, `agent.blocked`,
`agent.failed`, `agent.cancelled`, `agent.message`) to the
parent through the bridge. The `subagents` module delivers each one as a
custom message of type `lasercode/agent-event` (`AGENT_EVENT_MESSAGE_TYPE`)
with `deliverAs: "steer"` and `triggerTurn: true`: a running parent sees it
before its next model call, an idle parent wakes up, and the transcript stores
each event exactly once. The text the model reads is the event type, the four
identities, `endedBy` (with the person's verbatim reason) and the message. The
UI renders the same entry as the parent-side card (Handoff row in
[`ux-elements.md`](ux-elements.md)).

### States, and who sets them

`AgentRunStatus`: `queued`, `running`, `completed`, `blocked`, `failed`,
`cancelled`. Terminal states are the last four. There is no timed-out state:
nothing ends a run for taking long (D-144).

| State | Set by |
| --- | --- |
| `completed`, `blocked` | the child model, only through `complete_agent_run` |
| `cancelled` | `stop_agent` (initiator `parent`), `agents/runs/stop` (initiator `user`), or the host when the child's session is deleted (initiator `user`, reason "The session was deleted.") |
| `failed` | the harness on an engine error, on a child that settles twice without `complete_agent_run`, on a child session that closes or refuses the task while busy; the host when a project's worker dies or when it loads `agent-runs.json` after a restart (nothing non-terminal survives, reason "The project's worker stopped before this run ended.") |

`endedBy: { initiator: "parent" | "user" | "harness", reason? }` records who
ended a run. A person ending a run from the UI carries `initiator: "user"` and
the reason verbatim to the parent's event.

### Follow-up messages and user-origin runs

A child is a persistent, addressable session. The parent may
`send_agent_message` while it runs or after it finished; the person may open
the child from the sidebar or the map and type into the normal composer.
Either creates a new run on the same session when it is idle; a run the person
started has `origin: "user"`, one the parent started has `origin: "agent"`.
The child's role block is re-read every turn, so a new task reaches its
system prompt.

### Nesting, model access, worktree ownership

Enforced in the harness, never by prompt alone: a child at `policy.maxDepth`
gets no `start_agent`; `allowedAgents` is checked on every start; a definition
that names a model the person has no credential for is refused with a
person-facing message (and flagged as a warning on the Agents page); a run may
only touch the worktree it created.

Every refusal is a `HarnessError` written for a person and, through the tool
result, for the parent model.

## 3. Worktrees

Worktrees are not optional (`packages/worker/src/agents/worktrees.ts`):

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
`message_received`, `completed`, `blocked`, `failed`, `cancelled`,
`stop_requested`) appear as a gentle bubble inside the node that
owns them for a short while, then disappear.

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
- `task_list`, `task_output`, `task_wait` (300 s default, 3600 s at most) and
  `task_stop` (`BACKGROUND_TOOL_NAMES`) to follow tasks; a task is `running`,
  `completed`, `failed` or `stopped`;
- one `lasercode/task/update` per task carrying a `BackgroundTaskUpdate`
  (`packages/protocol/src/tasks.ts`), including the log file it streams into,
  so the host can serve `tasks/output` and the fleet can follow it; re-emits
  for output growth are throttled (M13-T26);
- exit notifications as a `lasercode/task-event` custom message
  (`TASK_EVENT_MESSAGE_TYPE`): a promoted task wakes an idle model
  (`triggerTurn: true`, it was told it would hear back); an explicitly
  backgrounded task is recorded and delivered with the next turn.

Background tasks and child agents share the fleet's run vocabulary.

### Tools and time

Every agent has every tool (D-144). A definition says what an agent is for in
its instructions, and what it may reach beyond its own work through its
allowed agents and its worktree; a per-agent tool list was a second, weaker
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
| session custom entry `lasercode/agent` (`SESSION_AGENT_ENTRY_TYPE`) | the first custom entry of every agent-started or agent-defined session: `SessionAgentRecord { agentName, kind, subagentName, parentPath, parentSessionId, rootPath, runId, worktree }` — so a catalog that only reads files can attribute it |
| session custom entry `lasercode/agent-run` (`SESSION_RUN_ENTRY_TYPE`) | run lifecycle moments in the child session (started, completed, blocked, failed, cancelled, timed out) |
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
  short text. The sandbox project is a git repository with one commit so every
  child gets a worktree. See the header of `scripts/sandbox.mjs`.
- The worker's harness test (`packages/worker/test/agents/`): a stub-provider
  child completes through `complete_agent_run` and its parent receives exactly
  one structured event.
- The packaged gate: `check-packaged-session` reports the active modules and
  the Beam skill path; `packages/desktop/scripts/clean-machine.mjs` asserts
  `subagents` and `background-work` are active and that the skill file exists.

## 11. Regression checks

The binding list lives in `AGENTS.md` ("Agents harness regression checks"):

- One `start_agent` tool and four identities only.
- Children never block.
- Every child gets a worktree or a person-facing refusal.
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
