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
| Name | `name` | Editable and unique; built-in names (`beam`, `chat`, `namer`), current names and historical rename aliases are refused |
| Description | `description` | ≤ 300 chars. Answers "when should another agent start this one?" — it is the compact catalog text |
| Instructions | `instructions`, `engineInstructions` | Answers "how should this agent work?" The shipped `default` agent starts with `engineInstructions: true`: Laser's own neutral coding prompt, readable through `agents/engine-instructions`; a person may replace it with their own text |
| Model | `model` | `{ provider, id }` or `null` to follow the configured default model |
| Thinking | `thinkingLevel` | `null` follows the default |
| Supports subagents | `supportsSubagents` | When on, the agent gets `start_agent` and its siblings |
| Agents it can run | `allowedAgents` | Multi-select of custom agents, including another instance of the same definition; never a built-in. Meaningful only with `supportsSubagents` |
| Scoped skills | `scopedSkills`, `skills` | Off by default: every discovered skill is offered. On: only the listed `AgentSkillRef`s (`name`, `path`, `scope`), chosen from what Laser discovers at definition time (`agents/skills`, listing `<agentDir>/skills` and `~/.agents/skills` as `global`, `<project>/.laser/skills` and `<project>/.agents/skills` as `project` when the project is trusted) |
| Default | snapshot `defaultAgent` | "Default" only means the agent a new session opens with (the `i` mark beside the toggle says so). The current default cannot be deleted; pick another default first |

The ordinary new-session composer exposes custom definitions as a searchable
selector immediately before the model, preselects `defaultAgent`, and removes
the control after the first prompt. Before that prompt, a different choice is
tentative composer state only: it creates no session, writes no setting and
does not change persisted identity. Leaving the composer discards it. The first
prompt binds the choice to that same unstarted session before delivery, exactly
once; a started session's identity never changes. After start, the top bar keeps
the canonical persisted agent visible as a read-only label beside the model. It
never offers switching and never substitutes tentative state or today's default
when a historical session has no recorded attribution. Built-ins stay reserved
for their dedicated product channels and never enter this list.

Policy (`AgentPolicy`, `agents/set-policy`): `maxDepth` (default 3, at most 6)
and `foregroundCommandSeconds` (default 120, 10–3600).

Validation (`agents/validate`, and the gate inside `agents/save`) returns
`AgentIssue[]`, each naming its field (`skills[2]`, `allowedAgents`, `name`) so
the form shows the message beside the control.

Renaming carries `originalName` through validation and save. The host moves the
definition, the default pointer and every `allowedAgents` reference in one
commit. `AgentsSnapshot.renamedAgents` retains old-name → current-name aliases
so a worker reopening a session whose immutable record names the old definition
still loads the renamed one. Deleting that definition retires its aliases.

Periodic validation (`packages/host/src/agents/skills-check.ts`) stats every
scoped skill of every custom agent every 30 s and right after a save, and
flags a child list that names an agent that no longer exists. A problem
becomes an `AgentWarning { agentName, field, target, message, since }` on the
snapshot; the Agents page shows a gentle yellow warning and deep-links to the
exact field. `since` is when the problem was first seen and does not move
between ticks.

Kinds: `custom` (a person's, including the seeded `default`) and `builtin`
(Beam, Chat, Namer — visible at the bottom of the Agents page, never deletable,
never the default and never another agent's child). A person may edit each
built-in's system instructions and model; restoring instructions drops the
override and follows the shipped prompt again. All three use the same
connected-provider-only model picker (D-145). `AgentsSnapshot` carries
`builtinInstructions` plus `beam`, `chat` and `namer` state; Chat's specialized
state is the model choice alone, because it has neither a suggestion nor a
benchmark behind it.

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
| `send_agent_message { sessionId, message, interrupt? }` | same | a running child receives it as its next instruction: while its engine streams, the message goes into the engine's own queue — the follow-up lane, or the steering lane with `interrupt: true` — and the result says `delivery: "queued"`; an idle child starts a new run and the result carries the new `runId` with `delivery: "delivered"` only once the child's engine has accepted the message as its next turn — never before admission is known — or `delivery: "refused"` with `error` (and a `failed` run for the attempt) when it would not take it; a child that is `needs_input` has its open question **answered** by the message (`delivery: "answered"`, the question returned as `answered`) — see "Questions" below. A message sent while the child is finishing a declared completion waits, in order, on the one successor run the harness reserves behind it (still `"queued"`); with `interrupt: true` it also aborts the finishing invocation, which cannot change the result that invocation's tool already declared — see "Completion" |
| `inspect_fleet` | same | the tree of work under this session, as the person's fleet column draws it (D-163, below): the agents it started, theirs, and the background commands any of them — the caller included — left running or finished. One row per session, standing on its newest run, and one per command; every row carries its kind (`agent` or `command`), title, the fleet's status word, elapsed time, one line (what it is doing, or how it ended) and the id to follow it with (`runId`, `taskId`). At most `AGENT_FLEET_ROWS_MAX` = 50 rows, cut deepest-first with `omitted` saying how many. Read-only; never transcripts |
| `inspect_agent { runId? \| sessionId?, messages? }` | same | one agent in depth — any agent row of the caller's tree, a child or a child's child (D-163): the run summary (identities, status, result, `endedBy`, the open `question`) plus the **whole** task, `origin`, `depth`, `model`, `cwd` and `branch` (only with a worktree), the worktree as it is now (`exists`, `unmergedCommits`, `uncommittedFiles`, `removedAt?`), `activity` (turns, tool calls, the tool running now, when it was last active), its last assistant messages excerpted (`messages`: default `AGENT_INSPECT_MESSAGES_DEFAULT` = 1, at most `AGENT_INSPECT_MESSAGES_MAX` = 10, each cut at `AGENT_INSPECT_MESSAGE_EXCERPT` = 1000 characters), the question it is paused on, a `what_it_needs` sentence when it is stalled, and its own children as run summaries. Read-only: it never wakes the child or delivers anything to it. A live child is read through its driver; an ended child whose driver is gone, from its session file |
| `stop_agent { runId, reason? }` | same | ends one run now with `endedBy: { initiator: "parent", reason }`; the session stays addressable |
| `remove_agent_worktree { sessionId? \| runId?, force? }` | same | removes a finished child's worktree and branch (M13-T42, §3 below) |
| `complete_agent_run { status: "completed" \| "blocked", message }` | every child | the only successful ending; the tool result terminates the child turn. Inside the tool the harness records the declared result, empties the engine's steering and follow-up queues into one successor run, and keeps the run `running` until the engine's prompt promise resolves — see "Completion" |

Children never block, and **parents never wait**: `start_agent` returns
before the child has done anything, there is no foreground mode, and there
is no waiting tool (M13-T45). A child's ending is delivered to its parent as
a message that wakes it (below), so nothing is lost by not waiting; a parent
that wants to know how things stand meanwhile calls `inspect_fleet` for the
whole tree or `inspect_agent` for one agent. The parent's guidelines and role
block say so in the same words.

### The fleet, as the agent reads it (M13-T62, D-163)

The agent reads running work through one tool, `inspect_fleet`, and what it
gets is **the same tree the person sees** in the fleet column
(`docs/ux-fleet.md`), scoped to the caller: the agent runs and background
commands under its session, its children's, and theirs. A child sees its own
subtree; the root sees everything under it; nobody sees another root's work.
`list_agents` and `task_list` are gone — they were two half-views of one
thing, in two vocabularies.

The rows are the fleet's rows. `packages/worker/src/agents/fleet.ts` builds
them and mirrors `packages/ui/src/fleet/model.ts` without importing it:
agent rows nest as the tree nests, a session's commands hang off the row for
the session that ran them (after its child agents), ordering is creation
order, the title is the instance name or the command's first line, the status
word is the column's (`FLEET_STATUS_WORD` = `FLEET_STATE_LABEL`: Waiting,
Working, Asking, Blocked, Done, Failed, Ended), elapsed is formatted the
same way, and the line is what the row says — the question a paused child is
stuck on, the tool it is running, the last line a command printed; else the
final message, the error, the exit code, or who ended it (the column's "you
ended it" becomes "the person ended it" for the agent: only the pronoun
changes). `packages/worker/test/agents/fleet.test.ts` feeds one fixture to
both builders and compares row for row; a change on one side fails it.

Both kinds of work meet in the worker, which is the one process that sees the
whole tree (invariant 5): `WorkerServer` keeps a `TaskIndex`
(`packages/worker/src/agents/tasks.ts`) fed from the `lasercode/task/update`
messages it already forwards to the host, and the harness joins it with its
runs. The companion's modules never see each other's tasks (§6a), so the
`background-work` module's `task_output` reads a command of another session
in the caller's tree through the worker (`BackgroundWorkOptions.readTask`),
from the command's log file, bounded as `tasks/output` is; a command outside
the tree is refused with a sentence that names `inspect_fleet`. `task_stop`
stays the caller's own.

`inspect_agent` and `task_output` are the per-row detail, and both accept any
row in the caller's subtree — a parent may read a grandchild, read-only, as
the person may open any chat in the tree. The verbs that act on an agent
(`send_agent_message`, `stop_agent`, `remove_agent_worktree`) still take a
direct child only. Endings still arrive as messages that wake the turn
(D-158, D-162); `inspect_fleet` is for reading on demand, and its result says
so.

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

**Declared is not published (M13-T98).** The tool call only *declares* the
end: the session's lifecycle moves to `terminal-pending`, and the run stays
`running` — in the registry, the fleet, `inspect_fleet` and `inspect_agent`
— for exactly as long as the engine invocation that ran the tool can still
write. That window is real: Pi executes every other tool of the same batch,
calls the model again after a batch in which not every tool terminated, and
would carry any queued steering or follow-up message on under the run
(`_handlePostAgentRun` → `agent.continue()`). So, still inside the tool, the
harness empties the engine's queues (`clearQueue()`) and puts every message
it held — plus every message waiting in its own inbox — on **one** successor
run, in order, each exactly once; a text the engine had already delivered is
gone, a text the harness never sent is kept. So is a custom message an
extension queued straight into a lane behind the running turn — a background
command's exit, a grandchild's ending, sent while the child streamed — which
the engine's own queue never lists and its clear would silently drop: the
driver reads agent-core's queues first (`ClearedQueue.custom`), the transfer
keeps each as a message of its own (its text; the custom type is gone) and
writes a `warn` line with the counts. Everything that arrives during
the window joins that successor: a parent's `send_agent_message`, a person's
queued prompt, an extension's triggering send, a goal's automatic
continuation, a background command's exit. A person's message written while
the child worked reaches it through the pending tray's drain at
`agent_settled`; the admission lease the server took for that delivery is
released the moment the harness parks the message, because an extension's
send ahead of it on the successor starts through the same lease — held until
the person's acceptance, it would wait for the very turn that acceptance
follows. `interrupt: true` and a person's
stop additionally abort the finishing invocation (the declared result
stands: first declaration wins), and a stop of the run while it is still
invoking empties the engine's queues into the successor *before* the abort,
so nothing continues under a cancelled run. The completion is published only
when the prompt promise — the one engine-ready fence — resolves: the old run
turns terminal, the successor becomes the session's live run, and only then
is the parent told. Every ending of an owning run publishes through that
same fence and takes the successor — the tool's declaration, a stop, a
settle without the tool, the failed nudge — so a run reserved while the
owner had settled but was not yet fenced is started by the ending, never
left waiting for nobody. Late callbacks stamped with the finished invocation's
epoch are dropped, and never touch the successor. If the session closes
during the window, the declared result is still what the run ends with; the
successor that never started fails with "The agent's session closed before
this queued message could start.", and whoever was waiting on it (a person's
prompt, an extension's send) is answered with that sentence. The harness
writes each of these moments — admission decisions, phase changes, successor
reservation and activation, queue transfers as counts, terminal publication,
dropped late callbacks — as credential-free `module:subagents` lines in the
host's log store (identities, phases, counts and timestamps; never a prompt
or a message body). Pinned by
`packages/worker/test/agents/queued-completion.test.ts` against the real
engine.

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
[`ux-elements.md`](ux-elements.md)). A run's ending is pushed only once the
run is truly terminal — after its engine invocation has stopped — and, when
a successor was waiting behind it, only after that successor has become the
session's live run, so a parent that reacts to the ending by messaging the
child reaches the run that is actually working. A person's own sends into a
child's chat — `pi/session/steer`, `pi/session/follow_up`, a pending-tray
row's Steer, the tray's own drain at `agent_settled`, and
`pi/session/clear_queue` — go through the same fence as the parent's
messages, so nothing a person types can enter a queue the engine is about to
drop. A clear takes back only the person's texts; a custom message an
extension had queued behind the turn is parked for the fence instead, and
never returned to a composer. A dialog is stamped with the invocation that raised it; one
from an invocation the session no longer owns is cancelled (never the
successor's question, never left hanging) and is not shown to the person.

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
| `blocked` | no | the child **ended** by saying it could not finish (`complete_agent_run { status: "blocked" }`); the question it asked its parent, if any, is its final `result.message`. Finished work, not a live question (D-189) |

The parent can tell "working" from "stuck waiting on me" from the status
alone, in `inspect_fleet` (the row says *Asking*, with the question as its
line), `inspect_agent` and the `start_agent` guidance; in
the UI the two live shapes are "Working" (live tone) and "Asking" (the warm
attention tone), and only `needs_input` counts as needing someone in the
sidebar chip, the fleet and the map summary.

A terminal `blocked` run is **neutral finished work** (D-189). Its word is
*Blocked* and its tone is muted, the same ink as Done and Ended
(`RUN_STATUS_LABEL` / `RUN_STATUS_TONE` in `packages/ui/src/agents/model.ts`,
`FLEET_STATE_LABEL` / `STATE_ATTENTION` in `packages/ui/src/fleet/model.ts`,
`FLEET_STATUS_WORD` in `packages/worker/src/agents/fleet.ts`); it sits in the
finished fold with every other ended run, and it counts as finished, never as
needing someone, in the fleet header, the sidebar chip, `inspect_fleet`'s
`needsYou` and the map summary. It also never outranks a newer active run: a
session stands on its newest run (`latestRunForSession`,
`compareRunsNewestFirst`), so yesterday's blocked ending cannot hide what the
same session is doing now. Nothing is lost by the move: the final message
still says what the child could not do, and a live descendant keeps its whole
branch out of the fold, because a branch is settled only when its whole
subtree is.

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

A child's work can come to rest on its parent in exactly two ways, and each
has its own status — one live, one ended:

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
   `blocked`. The run is over, so this is finished work rather than a live
   question (D-189), and what it asked survives in its final message. The
   parent reads that without opening the session: it is the `result.message`
   in the `agent.blocked` event, in `inspect_fleet` (*Blocked*, with the
   message as the row's line) and in `inspect_agent` (whose `what_it_needs`
   says so and says how to reply: `send_agent_message` starts a new run in the
   same session with the child's history intact). The child's role block tells
   it this is the way to ask when it genuinely cannot go on.

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
- `task_output` and `task_stop` (`BACKGROUND_TOOL_NAMES`) to follow tasks —
  read output before the exit, or end one; there is no waiting tool (D-162,
  the rule D-158 set for child agents) and no list: `inspect_fleet` shows
  every command in the session's tree beside the agents that ran them
  (D-163), and `task_output` takes any of them, reading another session's
  through the worker. A task is `running`, `completed`, `failed` or `stopped`;
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
| `beam` | one opaque, persistent directory per session under `<state>/workspaces/beam` | every tool and every user- or project-discovered skill, like any unscoped agent | two ways in (D-143, D-173): every press of the spark at the bottom left beside Settings starts a fresh bubble chat, while earlier Beam sessions remain in Beam's sidebar group; the `+` on that group starts a fresh chat in the window. Opening the bubble immediately creates or reuses an unstarted Beam session without moving the main view (D-183). The sidebar `+` uses the same launcher, reusing that empty session even in its private subdirectory; simultaneous requests allocate once. The bubble's maximize control moves its current chat into the window and selects Code. No other Beam entry point exists |
| `chat` | one opaque, persistent directory per session under `<state>/workspaces/chat` | every tool, isolated from unrelated Chat sessions | the Chat tab, first in the sidebar before Code; projectless chats |
| `namer` | the project's own worker | not a session agent | names things from a small context |

The Agents page exposes the effective system instructions for all three.
Saving writes a durable override; restoring stores `null` so a later release's
improved shipped prompt takes effect. Beam and Chat apply the effective prompt
when a session opens. Namer layers it into session-title, activity-label and
qualification requests while keeping the per-operation short-output contract.

Instructions are restricted Handlebars templates (D-175). The editor owns the
syntax: **Insert field** shows searchable, human-labelled live values and puts
the chosen field at the caret, so a person never has to type or remember a
template name. The available fields are scoped to the agent. They cover the
current product, agent, model, reasoning level and working directory; the live
tool catalogue and its guidance; project instructions, discovered skills and
additional instructions; the allowed child-agent catalogue; Beam's state
locations; and Namer's current naming input. Unknown fields, helpers, blocks
and malformed templates are refused before saving. At `before_agent_start`
the worker renders the template from the real session resources, before the
companion adds compulsory role and goal context. The saved template is exact:
only fields the person inserted expand, with no legacy additions appended.

**A Chat session can move into a project** (M13-T58). The open chat's top bar
and the row's menu both offer "Move to a project…", which opens a dialog listing the Code
tab's projects — current first, then most recently used — with "New project…"
last; that runs the same folder choice as the rail's Add project (the
operating system's picker in the desktop app, a typed path in a browser) and
the folder becomes a project. Nothing is converted or copied: the session
keeps its history, its name and its id, and only where it lives changes. The
host does the move (`pi/session/move { path, cwd } → { path }`) while no
worker holds the file: it closes the session in the Chat worker when one has
it open (`pi/session/close`, host → worker only), rewrites the file into the
project's session directory with the header's `cwd` set to the project and
the `lasercode/agent` record replaced in place by the default agent's plain
top-level record (never appended — the first record wins), renames it into
place atomically, removes the old file, invalidates the catalog and view
caches for both paths, carries the seen mark across so the move does not
light the row up as unread, and registers the project as Add project would.
Refused, with the reason a person can act on: a streaming turn (the worker's
refusal), a live agent run of the session, a child session (its parent's tree
is one thing), a target that is missing, a file, a built-in workspace or a
worktree. After the move the Code tab shows the session selected under its
project, and the transcript is the same transcript.

**Skills are discovered, not managed.** Laser ships and writes no skills. It
discovers a person's global skills and trusted project skills from the roots
listed in the definition table, then either offers all of them or the subset
chosen for a scoped agent. Beam is unscoped. Its product-specific knowledge —
where Laser stores sessions, agents, runs, preferences, projects and logs — is
part of its editable built-in instructions, not a hidden skill.

**Beam's model** is an average-but-fast one. When the first provider is
connected and Beam has no model, the host sends `agents/beam/choose-model`
with a suggestion (`suggestBeamModel`: the priciest fast-tier model in the
mid-to-low price band among providers with a credential) and the UI opens the
choice dialog, which explains what Beam does. The suggestion is never applied
silently; `BeamState.needsChoice` stays true until the person picks or
dismisses.

**Namer** (`packages/worker/src/agents/namer.ts`) is a service, never a
session: one small completion per request with an 8 s ceiling, as many at
once as a burst of tool calls needs (D-165), and it never throws — a name that does not arrive is
simply not shown. It accepts a plain answer as well as harmless quotes,
prefixes, Markdown fences and small JSON wrappers, then safely shortens the
result instead of rejecting useful wording for its packaging. It names a
session from its first prompt (25–30 characters,
`SESSION_NAME_MIN`/`SESSION_NAME_MAX`, quotes and trailing punctuation
stripped, cut at a word boundary), a tool call the moment it starts in a
top-level session — never in a child agent's, whose rows its parent reads
through `inspect_fleet` (D-165) — (a present-progressive label of at most 40
characters, sent as
`lasercode/namer/label { toolCallId, label }` before the tool ends) and an
in-progress aggregate in the chat view. Its model is qualified rather than
picked: `agents/namer/qualify` deterministically ranks enabled models from
connected providers — the current choice, small affordable models, other
affordable models, then available fallbacks, at most six. It tests candidates
in parallel on both real jobs: a session title and a present-progressive tool
label. A usable answer outranks speed and price; among equally correct models,
combined latency and list price choose the winner. Rechecking never discards a
model that was already working. A failed check remains retryable instead of
turning a temporary formatting or provider failure into a permanent verdict,
and a later worker retries it automatically. The result records
`NamerState { status, model, candidates, qualifiedAt, reason }`; `status` is
`unqualified`, `qualifying`, `ready` or `unavailable`.

## 8. Persistence

| Where | What |
| --- | --- |
| `<stateDir>/agents.json` | custom agents (the seeded `default` among them), `defaultAgent`, policy, every built-in's instruction override and model choice, `revision`. Built-in identities and null-overridden prompts are rebuilt from `packages/host/src/agents/builtins.ts` on every load |
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
| `agents/validate` | `{ agent, originalName }` → `{ issues }` (`originalName: null` means create) |
| `agents/save` | `{ agent, originalName }` → `{ agent, snapshot }` (an edited name is an atomic rename) |
| `agents/delete` | `{ name }` → `{ snapshot }` |
| `agents/set-default` | `{ name }` → `{ snapshot }` |
| `agents/set-policy` | `{ policy }` → `{ snapshot }` |
| `agents/skills` | `{ cwd }` → `AgentSkillsListing` (routed by cwd) |
| `agents/engine-instructions` | `{ cwd }` → `{ text }` (routed by cwd) |
| `agents/runs/list` | `{ path? }` → `{ runs }` (`path` narrows to that session's tree) |
| `agents/runs/stop` | `{ runId, reason? }` → `{ run }` (recorded as user-initiated; the parent is told) |
| `agents/builtin/set-model` | `{ name, model }` → `{ snapshot }` (`name` is `beam`, `chat` or `namer`; `null` follows the default model, and for Namer returns it to the next qualification) |
| `agents/builtin/set-instructions` | `{ name, instructions }` → `{ snapshot }` (`instructions` is the replacement system prompt; `null` restores the shipped prompt) |
| `agents/namer/qualify` | `{ cwd }` → `NamerState` (routed to the built-in workspace worker) |
| `agents/sync` | host → worker only; refused from clients |
| `session/new` | gains `agentName?` (omitted = the default agent) |
| `pi/session/move` | `{ path, cwd }` → `{ path }` (a Chat session becomes `cwd`'s; the result is where it lives now, M13-T58) |
| `pi/session/close` | host → worker only; refused from clients (the host lets a worker go of a session before moving its file) |

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
- The packaged gate: `check-packaged-session` reports the active modules;
  `packages/desktop/scripts/clean-machine.mjs` asserts `subagents` and
  `background-work` are active.

## 11. Regression checks

The binding list lives in `AGENTS.md` ("Agents harness regression checks"):

- One `start_agent` tool and four identities only.
- Children never block, and parents never wait: there is no waiting tool, and
  the `start_agent` result says not to.
- A child paused on a question is `needs_input`, never `running`; a child that
  ended asking is `blocked`. Every reader of `AgentRunStatus` — the sidebar
  chip and folds, the fleet, the live map, `agents/model.ts`, the CLI — has a
  test for the live-and-stuck value, in the attention tone, never folded away.
- Terminal `blocked` is neutral finished work (D-189): the neutral word
  *Blocked* in the muted tone, inside the finished fold, counted as finished
  and never as needing someone, and never outranking a newer active run of the
  same session in the fleet, the sidebar or `inspect_fleet`. A live descendant
  still keeps its branch out of the fold.
- `inspect_agent` is read-only and bounded (at most 10 excerpted messages).
- One `inspect_fleet` and no list of either kind (D-163): the tree it returns
  is the fleet column's, scoped to the caller — a child never sees a sibling
  — with the column's status words and titles, pinned by the agreement test
  in `packages/worker/test/agents/fleet.test.ts`; at most 50 rows, cut
  deepest-first and counted; `inspect_agent` and `task_output` accept any row
  in the caller's subtree and refuse one outside it in a sentence; nothing the
  model reads names `list_agents` or `task_list`.
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
- Beam has two ways in, and no more: every spark press prepares an unstarted
  bubble chat immediately without deleting earlier sessions. The sidebar `+`
  reuses and selects that same empty session, including private workspaces and
  simultaneous quiet/selecting requests; a started session is never reused.
- A project composer's pre-turn custom-agent choice is tentative: choosing,
  changing back or navigating away sends no session/settings request and keeps
  text and attachments in place. Its first prompt binds one chosen identity to
  the same unstarted session and is delivered once across concurrent activation
  and retryable failure; no duplicate is deleted to make the count look right.
- Dictation belongs to the composer that started it: with the bubble open,
  two composers are mounted, and a phrase must land where it was spoken.
