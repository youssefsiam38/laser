# Runs, plans and ledgers — the domain model for agent work

Status: **decided 2026-09-05 (D-19); decisions 1 and 3 superseded by D-140
(2026-09-08); the rendering half superseded by M13-T26 (2026-09-08).** M3 built
on this. Since D-140 the runs are Laser's own harness
([`agents.md`](agents.md)): a child is a sub-session in the sidebar under its
parent, and every top-level session has a full-screen live map. The
pi-subagents concepts in the tables below are kept as the history that shaped
it, not as anything that still ships.

## How this relates to the fleet

[`docs/ux-fleet.md`](ux-fleet.md) is the **rendering** system: two kinds of
work, one permanent column, and where a question to the person is answered.

This document is the **domain** model behind it. It answers a different
question — not *how does it render*, but *what are the things*:

| This document | Where it renders |
| --- | --- |
| a **run** | a fleet item of kind `agent`, and a sub-session in the sidebar |
| a **plan** | history: nothing persists a plan since D-140 |
| a **ledger** | history: the mission ledger went with pi-subagents |
| a **session goal** | a persistent row below the top bar; never a fleet item |

Read the fleet document first. This one exists because agent work is the
richest domain laser has, and without a model for it a run would be a grab
bag of fields.

## The problem

Pi and `pi-subagents` grew at least eight kinds of not-the-main-conversation
work, separately, each with its own data shape, lifetime and permissions.

| Concept | Where it comes from | What makes it awkward |
| --- | --- | --- |
| Foreground subagent | `async: false` | No status file, no control, no index — invisible until it writes a transcript |
| Background subagent | `async: true` | Detached process, observable only through files, and with no text deltas |
| Nested subagent | a child that fans out | Only interrupt and resume; no steer, no stop |
| Declarative workflow | `chain` / `parallel` | Persists a phase tree, not a dependency graph |
| Scripted workflow | `workflowScript` | Persists **no** structure at all — it is just JavaScript |
| Mission | `mission.create` | Durable across days and compactions; joins runs that no longer exist |
| Scheduled run | `schedules/` | Project-local files, invisible to the parent session |
| External run | another extension | Display-only; we cannot control it |

Give each one a screen and the product is unusable.

## Three nouns

**A RUN** is a unit of agent work with a lifecycle, a transcript and an
outcome. The parent session is a run. So is every child, at any depth, from
any origin. They differ by attributes, not by being different objects:

| Attribute | Values |
| --- | --- |
| `origin` | you · a parent agent · a schedule · another extension |
| `attachment` | live (we stream it) · detached (it runs without us) · terminal |
| `control` | which of steer / stop / resume / interrupt actually work |
| `depth` | position in the run tree |

Since D-140 the harness's own run record is `AgentRun`
(`packages/protocol/src/agents.ts`): `origin` is `agent` or `user`, `depth`
counts from 1 for a child of a top-level session, and the state vocabulary is
`AgentRunStatus` — `queued`, `running`, `needs_input`, `completed`, `blocked`,
`failed`, `cancelled`. The child model may only choose `completed` or
`blocked`, through `complete_agent_run`; the harness sets the rest, and
`endedBy` says whether the parent, the person or the harness ended it.
`needs_input` (M13-T45) is the live state where nothing happens until someone
acts: the child raised a question through the portable UI surface and its
loop is paused on it, the question is on the run, and the parent or the person
answers it ([`agents.md`](agents.md) "Questions"). The UI maps these onto the
five-word status language of `DESIGN.md` in one place
(`packages/ui/src/agents/model.ts`): `running` is "Working" in the live tone;
`needs_input` is live "Asking" in the attention tone and counts as needing you.
Terminal `blocked` is neutral "Blocked" under Finished, with no needs-you count or pulse.

**A PLAN** is the intended shape of multi-run work: workflow phases and lanes,
mission objectives, acceptance criteria. A plan is either *declared*, when
pi-subagents persisted one, or *inferred*, when we rebuilt it from trace
timestamps.

**A LEDGER** is the durable record: missions, their decisions, artifacts, run
history.

Three nouns, and the CLI uses the same words.

## Session goals

A goal is the one durable objective governing the current session. It is not a
run and it is not fleet work. While present it stays in a single row directly
below the top bar with its status, objective, automatic
continuation count and latest block/wait reason. Goals have no budgets and no
separate usage accounting; session telemetry owns consumption. Controls
appear only when the current status permits them.

Goal state is branch-local session data. Switching, starting or forking a
session must never carry another session's goal across. Pi-native goal logic
owns persistence and continuation safety; Laser owns the row and the neutral
protocol. See [`product-boundary.md`](product-boundary.md).

The first internal goal prompt projects as the exact original objective with a
“Goal set” label; subsequent automatic prompts stay out of the visible chat.
Accepted completion is a persistent activity disclosure outside tool aggregates:
original objective, the actual completion summary, and an objective/status
timeline. It survives automatic clearing and reload. It is collapsed by default
and follows the session's full-detail preference. Use the adopted ToolFallback,
Timeline and chat Markdown elements; do not synthesize an extra assistant answer
or change the engine's terminating completion behavior. Failed/stale completions
remain inspectable tool calls. Search indexes the displayed goal content, not
the engine prompt or guard IDs. Raw session entries remain untouched.

## Navigating runs

Three ways in, each for a different question, and no sticky tab strip: the run
tabs under the top bar went with the panels (M13-T26), because a strip that
shows one level of one session answers a narrower question than the fleet does
and cost a permanent band of vertical space to do it.

- **The fleet column** — *what is going on around this?* Every run and every
  background command of the session being read, nested as it really nests,
  with the loudest state rolled up to the row you can see; a child shows its
  root's tree with itself marked ([`ux-fleet.md`](ux-fleet.md), M13-T51).
- **The sidebar** — *where is this conversation?* Since D-140 a child is a
  sub-session listed under its parent (`SessionSummary.agent`), opened as the
  normal chat.
- **The live map** — *what is the shape of this tree?* Full-screen, per
  top-level session.
In the sidebar, a child is opened as the normal chat where the person reads,
queues or interrupts, and ends the run with a reason the parent receives. The
map is a read-only React Flow view of the tree with status, transient event
bubbles and a go-to-chat action per node, laid out by the measured size of its
surface ([`agents.md`](agents.md) §4–5).

The fleet renders the open session's work as chronological root-first subtrees with
a continuous lineage rail. A child is structurally inside its parent, never a
globally sorted flat row that merely looks indented; attention rolls up to the
ancestor's status without moving the branch.

## What each run path actually permits

This is capability honesty (`ux-fleet.md` R4) made concrete. Controls are hidden, not
disabled, when they do not apply.

| Run path | Steer | Stop | Resume | Interrupt |
| --- | --- | --- | --- | --- |
| Harness child (D-140): a sub-session, addressed by `sessionId` from the parent or from its own composer by the person | yes | yes | yes (a message to an idle child starts a new run) | yes |
| Background, via control inbox (pi-subagents, retired) | yes | yes | no | yes |
| Background, parent alive | yes | yes | yes | yes |
| Foreground child | no | no | no | no |
| Nested child | no | no | yes | yes |
| External run | no | no | no | no |

## Plans (history)

A plan was the intended shape of several runs: phases, steps, dependencies. It
came from pi-subagents' workflow graphs, and nothing persists one since D-140 —
the harness has runs and nothing above them. The rule the plan renderer existed
to enforce outlived it and is now `ux-fleet.md` R5: dependencies are drawn only
where they were declared, and a reconstruction is labelled as one. A canvas
implies we know the graph; for scripted work we did not.

## What this costs

- **The session list narrows.** It stops being every Pi session on disk and
  becomes things you started. Children live in their parent — since D-140,
  literally: as rows under it.
- **We render less than the data offers.** No live token stream for detached
  runs, no speculative graph for scripted workflows. Honesty over richness.
- **Three ways into a run to keep consistent** — the fleet, the sidebar and the
  map — though they share one data model (`agents/run`).

## Decisions (each resolved to its lean, D-19)

1. **Do background children ever appear in the session list?** They are real
   Pi sessions with real files. *Lean: no — only inside their parent and in the
   fleet sheet, so the session list keeps meaning "things I started".*
   **Superseded by D-140:** every child is a sub-session listed under its
   parent in the sidebar, fully controllable from its own chat.
2. **Where does an orphaned background run live** when its parent session is
   closed but it is still working? *Lean: the fleet keeps it and the project
   ring shows attention; opening it reopens the parent read-only.*
   **Settled by M13-T26:** the fleet is a permanent column, and an orphaned
   group says "session closed".
3. **Is a full-screen fleet board worth building**, as a peer of the thread?
   *Lean: a sheet is enough; revisit if you run many at once.*
   **Superseded by D-140 and M13-T26:** each top-level session has a live map,
   and the fleet is a permanent column rather than a sheet you summon.
4. **Do scheduled runs exist in v1?** Project-local files, and you have none.
   *Lean: defer. Add the noun when you have a use for it.*
5. **Does the CLI speak these nouns** (`laser runs`, `laser plan`)?
   *Lean: yes — different vocabulary in the terminal and the app would make it
   feel like two products.*
6. **Are read-only foreground children acceptable?** You decided to support
   them (D-3), but they have no index, no controls and no live status, so under
   capability and fidelity honesty they are read-only cards that appear late. *Lean: ship them
   read-only and file the upstream index patch — unless late-appearing cards
   feel broken to you, in which case that patch is a prerequisite for M3.*

The fleet separates lifecycle without flattening lineage: a branch belongs to
**In progress** while anything inside it is still going, then moves whole to
the collapsible **Finished** section. Completed, failed and cancelled rows keep
their own terminal labels. Since M13-T26 background commands *are* fleet work,
listed beside agent runs under the session that started them.
