# Runs, plans and ledgers — the domain model for agent work

Status: **decided 2026-09-05 (D-19).** M3 builds on this. Every question below was resolved to its stated lean.

## How this relates to the panel contract

[`docs/ux-panels.md`](ux-panels.md) is the **rendering** system: six panel
kinds, four surfaces, and a table that decides where a panel goes. It applies
to everything any extension produces.

This document is the **domain** model for one slice of that: agent work.
It answers a different question — not *how does it render*, but *what are the
things*. Its output feeds two of the six kinds:

| This document | Panel kind |
| --- | --- |
| a **run** | `run` |
| a **plan** | `plan` |
| a **ledger** | rendered as `document` (missions) and `collection` (history) |

Read the panel contract first. This one exists because agent work is the
richest domain piorbit has, and without a model for it the `run` and `plan`
panels would be a grab bag.

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

**A PLAN** is the intended shape of multi-run work: workflow phases and lanes,
mission objectives, acceptance criteria. A plan is either *declared*, when
pi-subagents persisted one, or *inferred*, when we rebuilt it from trace
timestamps.

**A LEDGER** is the durable record: missions, their decisions, artifacts, run
history.

Three nouns, and the CLI uses the same words.

## Navigating runs

The run tree is the tab group. It renders as `run` panels, but the navigation
around them is specific enough to specify here:

- The focused run is the trunk; its children are tabs **under** it, never
  siblings in the session list.
- Desktop: a horizontal tab strip below the top bar. Up to five children, then
  an overflow chip. Each tab is a status dot, the agent name, elapsed time.
- Mobile: a breadcrumb back-stack, `hubtrix › orchestrator › worker#2`,
  because two axes do not fit on a phone. Tapping a crumb opens that level's
  siblings as a sheet.
- Arbitrary depth works because the strip shows exactly **one level** — the
  children of whatever is focused. Depth lives in the breadcrumb.
- **Never a tree widget with expand arrows.** Trees are for files, not live
  work: an expanding tree makes you hunt for the thing that needs you, which is
  what R5 exists to prevent.

## What each run path actually permits

This is R2 (capability honesty) made concrete. Controls are hidden, not
disabled, when they do not apply.

| Run path | Steer | Stop | Resume | Interrupt |
| --- | --- | --- | --- | --- |
| Background, via control inbox | yes | yes | no | yes |
| Background, parent alive | yes | yes | yes | yes |
| Foreground child | no | no | no | no |
| Nested child | no | no | yes | yes |
| External run | no | no | no | no |

## Plans

A plan renders by island size, because a phase column needs width a dock pane
does not have (D-20):

- **Expanded in the dock**: phases as vertical collapsible sections. Each
  section header carries the phase title, a `done/total` count, and a row of
  small squares — one per step, filled as it completes. Expanding a phase
  shows its steps as a table: name, model, tokens, time, and a check when
  done. Cost and tokens for the whole plan sit at the top (R8).
- **Maximized**: phases as columns, steps as run islands inside them.
- **Minimal**: the plan name and `done/total`.

Dependencies are drawn only where they were declared. This is deliberately
**not** a free-form graph canvas: a canvas implies we know the graph, and for
scripted workflows we do not. Inferred connectors are dashed and labelled
`inferred` (R3).

## What this costs

- **The session list narrows.** It stops being every Pi session on disk and
  becomes things you started. Children live in their parent.
- **We render less than the data offers.** No live token stream for detached
  runs, no speculative graph for scripted workflows. Honesty over richness.
- **Two navigation models to maintain**, the tab strip and the breadcrumb,
  though they share one data model.

## Decisions (each resolved to its lean, D-19)

1. **Do background children ever appear in the session list?** They are real
   Pi sessions with real files. *Lean: no — only inside their parent and in the
   fleet sheet, so the session list keeps meaning "things I started".*
2. **Where does an orphaned background run live** when its parent session is
   closed but it is still working? *Lean: the fleet sheet keeps it and the
   project ring shows attention; opening it reopens the parent read-only.*
3. **Is a full-screen fleet board worth building**, as a peer of the thread?
   *Lean: the dock and a sheet are enough; revisit if you run many at once.*
4. **Do scheduled runs exist in v1?** Project-local files, and you have none.
   *Lean: defer. Add the noun when you have a use for it.*
5. **Does the CLI speak these nouns** (`piorbit runs`, `piorbit plan`)?
   *Lean: yes — different vocabulary in the terminal and the app would make it
   feel like two products.*
6. **Are read-only foreground children acceptable?** You decided to support
   them (D-3), but they have no index, no controls and no live status, so under
   R2 and R4 they are read-only cards that appear late. *Lean: ship them
   read-only and file the upstream index patch — unless late-appearing cards
   feel broken to you, in which case that patch is a prerequisite for M3.*
