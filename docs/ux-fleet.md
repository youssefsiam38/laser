# The fleet — how work renders in laser

Status: **decided 2026-09-08 (M13-T26).** Binding on every surface, as
`packages/ui/DESIGN.md` is. Supersedes `docs/ux-panels.md`, which described
the panel system this replaced.

## Why this document exists at all

laser used to have a *panel contract*: a general-purpose bus on which any
extension could declare one of six shapes — `run`, `plan`, `document`,
`stream`, `collection`, `decision` — which laser then placed on one of four
surfaces (ambient, inline, dock, sheet). It was a good answer to a real
problem, and it was wrong in one specific way: **a general bus for showing
things is a second app inside the app.** It grew a dock column, a sticky tab
strip, a pop-out browser window per panel, a placement table, a store, a
geometry model and four bodies, and the thing a person actually wanted from
all of it — *what is going on, and does it need me?* — was spread across six
surfaces, none of which answered it completely.

The fleet answers it in one place. It is not a generalisation; it is a domain
model. Two kinds of work, one column.

## The two kinds of work

| Kind | What it is | Where it comes from |
| --- | --- | --- |
| **agent** | one execution of an agent in its own child session | the harness (`docs/agents.md`), as `agents/run` |
| **task** | one long command an agent left running | the companion's `background-work` module, as `tasks/update` |

That list is closed, and closing it is the point. A third kind is a decision
recorded in `STATUS_DETAILED.md`, not a convenience. Anything that is *not*
work — a document to read, a set of search results, a log — is not in the
fleet:

- **Search results are already in the chat.** They arrive in the tool call
  that found them, where the reader is.
- **Logs are already a page.** The workbench's Logs screen is the whole
  history with a query over it, which is strictly more than a live tail.
- **Documents are already renderers.** `components/preview/` draws markdown,
  diffs, images and text wherever bytes turn up.
- **Metrics are already a column.** Context, tokens and cost live in the
  monitor.

An extension that wants to *show* something shows it through the tool call
that produced it. An extension that wants to *ask* something asks it inline
(see "Questions"). There is no third road, and adding one is the decision this
document exists to force.

## The layout

Desktop, ≥1280px:

```
[rail] [sessions] [ TopBar · GoalBar · Thread ] [fleet] [monitor]
```

Three side columns, each a real column and each collapsing on its own. The
monitor is outermost; the fleet sits immediately inside it. Both remember
their state in the same preferences object the sessions column uses
(`storageKey("panels")` — the string is unchanged on purpose, because renaming
it would silently drop everyone's saved layout; only the fields inside it
changed).

Keyboard: `[` the sessions column, `\` the fleet, `]` the monitor.

**The fleet is a column only where a third column fits.** Below 1280px it is a
sheet instead — the same `FleetPanel`, summoned rather than resident. There is
room for the sessions column and *one* right column at 1024; a second right
column there leaves the conversation about eighty pixels, which is not a
narrower layout but a broken one. This is the legibility floor applied to
layout: a surface that cannot fit its content shows less of it, and a column
that cannot fit is not a column.

The fleet's toggle lives beside the monitor's in the top bar, and it carries a
count of what needs a person — which wins over a count of what is merely
going, because "3 need you" is the sentence you act on.

## What a row says

One row is one piece of work. Collapsed:

```
● explorer                 Working              4m 12s
  Reading packages/ui/src/runtime/adapter.ts
```

- **the dot** — the five-word vocabulary from `DESIGN.md`, unchanged
- **the name** — the subagent's name, or the command's first line
- **the word** — its state; a task says `command` instead, because "running a
  command" is what it is
- **the line** — what it is doing in its own words, else why it ended, else
  what it was asked to do. Never all three: this is a row, not a record.
- **elapsed** — live while the work is, frozen once it ends

Expanded, in place: the task excerpt, the model, the worktree branch, the
reason it ended, the result message — and for a background command, the tail
of its output with ANSI interpreted, plus its exit code. Two controls: **Open
chat**, which navigates to the session the work lives in, and **Stop**, which
is `agents/runs/stop` (through the one End-agent confirmation) or `tasks/stop`.

## Structure, and the two rules that shape it

**Groups are top-level sessions.** Inside a group, agent work nests exactly as
it nests in reality — a child of a child is drawn inside its parent — and a
session's background commands hang off the item for the session that started
them. A command a child agent started is that child's.

**R1 · Ordering is creation order; attention rolls up.** A list that
reshuffles is a list you cannot learn, so nothing is sorted by urgency inside
a group. Attention still reaches you, because an item wears the loudest state
anywhere beneath it: a question three levels down lights the row you can
actually see, the group header, the session row and the toggle. Groups
themselves are ordered: the session you are in, then what needs you, then what
is going, then alphabetically.

**R2 · Lifecycle partitioning moves whole branches.** "In progress" and
"Finished" are the only two sections. A branch is in progress while anything
inside it is, so a finished child stays under its live parent rather than
being filed away somewhere structurally false.

## The rules that survived the panels

These were the panel contract's rules. They were never about panels.

**R3 · One status vocabulary.** The five states in `DESIGN.md` — working,
waiting for you, error, finished-unread, idle — apply to fleet items, runs,
sessions and projects identically. A container's status is the
highest-attention status it contains. No new colours, ever.
(`protocol/src/attention.ts` is the one implementation.)

**R4 · Capability honesty.** A control appears only if it actually works
here. Terminal work is offered no Stop; a task with no log file says so
instead of showing an empty pane. Hide the control, do not disable it, and put
the reason where the control would have been.

**R5 · Provenance honesty.** Anything inferred is marked, and a guess is
never presented as a fact. In particular: **the harness measures what a run
*is*, never what it spent** (D-140), so the monitor's background usage
contributes a *model* and no numbers. An account-billed child still puts the
session in the mixed billing view; it does not invent tokens to do it.

**R6 · Nobody has a progress percentage.** No progress bars in the fleet. A
shell command does not know how far along it is, and neither does an agent. A
stepper is honest where there are steps; a bar is a lie.

**R7 · Nothing vanishes silently.** Work that ends says how it ended. A run
cancelled by a person carries the verbatim reason; a task killed with the
worker says "the worker stopped". A row is never replaced by an empty space.

**R8 · One item, one identity.** `agent:<sessionPath>` and `task:<taskId>`.
An update replaces in place; arriving twice is normal, not an error, and the
store keeps its identity when nothing a row draws has changed.

**R9 · Reads are bounded, always.** A command can print gigabytes.
`tasks/output` serves at most 256 KiB per call, from the byte offset the
follower asks for, aligned to a UTF-8 character boundary; a collapsed row
reads nothing at all. The log path never crosses to a client: the host reads
it, because the task carried it, and only for the session that owns it.

**R10 · Shrink by dropping content, never by shrinking type.** No data below
12px anywhere, at any size, on any device. A long value truncates with the
full text in the tooltip. Nothing overflows its container and the page never
scrolls sideways.

**R11 · Nothing is passed through as markup.** A command's output, an agent's
activity line, a session's name: all of it is agent-authored, and all of it is
rendered as text. ANSI is interpreted into styled spans by `lib/ansi.ts`,
which strips every escape it does not understand.

## Questions

`select`, `confirm`, `input` and `editor` (`pi/ui/request`) are the only
things an extension can ask a person. They are answered **in the transcript**,
never in a column and never in a sheet:

| Where the question is | Where it is drawn |
| --- | --- |
| it blocks one tool, and that tool's row is on screen | inside that row |
| anything else | a card above the composer, one at a time, oldest first |

There is no third place. A question is part of the conversation that raised
it, so it is answered where that conversation is, and the reader never loses
their place to answer one.

Two rules are absolute:

- **Nothing hangs** (AGENTS.md invariant 6). A question of a kind this build
  cannot draw is cancelled on sight rather than shown. A question whose tool
  row is not mounted becomes a card rather than disappearing.
- **"No" is never a dead end.** Declining a `confirm` opens a reason field,
  and the reason travels to the agent as a follow-up.

A question inside a tool row can be scrolled away, and a session that seems
stuck for no visible reason is the worst thing this surface can do. So the
composer says one line — *"A question is waiting further up"* — with a control
that moves the thread's own viewport to it, the same move find makes. The
footer's card is never off screen, so it never needs one.

Tool approvals are a different mechanism and stay where they are: assistant-ui
delivers them on the tool call, and `ToolRow` answers them with
`respondToApproval` / `resume`. Both roads end in the same `DialogBody`, so a
question never looks like two different things depending on how it arrived.

## The wire

```
agents/runs/list      every run the host knows           → state.agents.runs
agents/run            one run appeared or changed        (notification)
agents/runs/stop      a person ends a run

tasks/list            every background command           → state.tasks.tasks
tasks/update          one task appeared or changed       (notification)
tasks/output          a bounded range of its bytes
tasks/stop            a person ends a task
```

Both lists are primed on connect and again after a reconnect
(`useFleetReconcile`): notifications are not replayed, so a client that
reloaded — or a laptop that slept through a run finishing — would otherwise
show a column that is quietly wrong.

`pi/task/stop` is host→worker only. A client calls `tasks/stop`, which the
host answers from its register; the worker hands the stop to the session that
owns the process, because the companion extension owns it and nothing else can
end it.

## Implementation map

| Concern | File |
| --- | --- |
| the work model, pure | `packages/ui/src/fleet/model.ts` |
| the store selector and the clock | `packages/ui/src/fleet/hooks.ts` |
| the sheet's open state and reveals | `packages/ui/src/fleet/fleet-state.ts` |
| following a task's output | `packages/ui/src/fleet/output.ts` |
| `tasks/*` actions | `packages/ui/src/fleet/actions.ts` |
| the column and its sheet | `packages/ui/src/components/fleet/` |
| the list itself | `components/assistant-ui/elements/subagent-list.tsx` |
| questions: the form model | `packages/ui/src/dialogs/model.ts` |
| questions: the one renderer | `packages/ui/src/dialogs/DialogBody.tsx` |
| questions: where they land | `packages/ui/src/dialogs/InlineDialogs.tsx` |
| the register, in the host | `packages/host/src/tasks/register.ts` |
| the producer | `packages/pi-extension/src/modules/background-work.ts` |
| the types | `packages/protocol/src/tasks.ts`, `attention.ts` |

## Related

- [`docs/agents.md`](agents.md) — the harness, and what a run is
- [`docs/ux-agent-work.md`](ux-agent-work.md) — the domain model behind runs
- [`docs/ux-elements.md`](ux-elements.md) — which element owns which surface
- [`packages/ui/DESIGN.md`](../packages/ui/DESIGN.md) — the visual system
