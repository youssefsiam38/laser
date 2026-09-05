# AGENTS.md — how to work in this repo

piorbit is a web-tech desktop app and remote-control relay layered on top of the
Pi coding agent (`@earendil-works/pi-coding-agent`). It visualizes Pi sessions,
subagents (pi-subagents), settings, and low-level logs, and exposes the same UI
to phones through an end-to-end encrypted relay. It builds on the community's
packages; it does not replace them.

## The bar: the Apple of coding agents

piorbit is not a dashboard over Pi. It is meant to be the experience that
makes developers choose an agent because of how it feels to work with, the
way people choose hardware because of how it feels in the hand. Pi owns the
logic; we own the experience, and the experience is the product.

That sets the bar for every screen, every command and every transition:

- **Nothing ships as a placeholder.** Empty states, loading states, error
  states and the first-run moment are designed with the same care as the
  main path. If a state exists, it was drawn on purpose.
- **Motion is a material, not a garnish.** Things morph, they do not pop.
  The same element grows and shrinks; identity, position and scroll survive
  every transition. Sixty frames, no layout shift, and every motion has a
  `prefers-reduced-motion` fallback that loses nothing but the movement.
- **Legibility is a floor, not a goal.** No data below 12px, no overflow, no
  clipped text, no horizontal page scroll, ever. A component that cannot fit
  its content shows less content, never smaller text.
- **The details are the design.** Optical alignment of icons to text, a real
  type scale, tabular numerals wherever digits line up, spacing on a grid,
  hover and focus and pressed states on everything interactive, keyboard
  paths for everything the mouse can do.
- **Errors are written for a person.** What went wrong, and what to do next.
  No stack traces in the UI, no apologies, no vagueness.
- **Both themes, both pointers, both widths.** Dark and light with equal
  care; mouse and touch; a phone and a wide desktop. Not one first and the
  rest adapted.

Three documents are the constitution for this, and they are binding on
every UI change: [`packages/ui/DESIGN.md`](packages/ui/DESIGN.md) for the
visual system, [`docs/ux-panels.md`](docs/ux-panels.md) for how anything
renders, and [`docs/ux-agent-work.md`](docs/ux-agent-work.md) for the model
behind agent work. A UI change that does not fit them is either a bug or a
decision recorded in `STATUS_DETAILED.md` — never a quiet exception.

Before any UI task is marked done, run it in the browser at a desktop width
and a phone width, in both themes, and look at it the way a demanding
designer would. "It builds" is not the bar. "I would show this to someone I
respect" is.

This file is the contract for every agent (human or model) working here. Read it
fully before touching anything. The three planning files it governs are:

| File | Role | Size discipline |
| --- | --- | --- |
| `PLAN.md` | What we are building, in what order, and why. Milestones and tasks with stable IDs. Changes rarely. | Edit only to add/split/drop tasks or record a re-plan. |
| `STATUS.md` | The one-screen answer to "where are we right now". | Must fit on one screen. Regenerated at the end of every work session. |
| `STATUS_DETAILED.md` | Per-task ledger: state, evidence, notes, handoffs, decisions log, open questions. | Append and update rows; never delete history. |

Planning is **dependency-ordered, never time-ordered**. There are no dates,
estimates, sprints, or deadlines anywhere in these files. A task is ready when its
dependencies are `done`, and done when its "done when" is met with evidence.

---

## 1. Start-of-session protocol (do this every time, in this order)

1. Read this file.
2. Read `STATUS.md` in full. It tells you the current milestone, blockers, and
   the next tasks.
3. Find your task in `STATUS_DETAILED.md`. Query by ID:
   ```bash
   grep -n "M1-T3" STATUS_DETAILED.md
   ```
   Read its row, its notes block, and any handoff note that names it.
4. Read the matching milestone section in `PLAN.md`:
   ```bash
   grep -n "^## M1" PLAN.md
   ```
5. Read `docs/architecture.md` if your task touches package boundaries, and
   `docs/research/findings.md` if it touches Pi internals, pi-subagents, the relay,
   or mobile.
6. Claim the task (section 3) **before** writing code.

If `STATUS.md` says it was last updated by a session that never wrote a
finish or handoff note, assume that session died mid-task: read the task's notes,
check `git status` and `git log`, and write a handoff note describing what you
found before continuing.

---

## 2. Query recipes

```bash
# Where are we?
cat STATUS.md

# All tasks currently in progress or blocked
grep -nE "\| (in-progress|blocked) \|" STATUS_DETAILED.md

# Everything about one task (row + notes + handoffs + decisions that cite it)
grep -n "M3-T2" STATUS_DETAILED.md PLAN.md

# Tasks that are ready (deps done) — read the milestone's dependency line in PLAN.md,
# then check each dependency's state:
grep -nE "^\| M0-T[0-9]+ " STATUS_DETAILED.md

# Decisions log (newest at the bottom)
grep -n "^### D-" STATUS_DETAILED.md

# Open questions
sed -n '/^## Open questions/,/^## /p' STATUS_DETAILED.md
```

Task IDs are `M<milestone>-T<n>` and are permanent. Decision IDs are `D-<n>`.
Handoff IDs are `H-<n>`. Never renumber.

---

## 3. Write rules

### 3.1 States

`todo` → `in-progress` → `done`, with `blocked` and `dropped` as side exits.

- `in-progress`: exactly one agent owns it. Put your session label in the Owner
  column (for example `claude-2026-09-05-a`, or a human's name).
- `blocked`: the Notes block must name what unblocks it (a task ID, a decision, an
  external answer).
- `done`: the Evidence column must hold a commit hash, a test command that passes,
  or a file path that exists. "Done" without evidence is not done.
- `dropped`: Notes must cite the decision `D-<n>` that dropped it.

### 3.2 The three moments you must write

1. **Claim** — before the first code change: set the row to `in-progress`, set Owner,
   add a one-line note `claimed: <what you intend to do first>`.
2. **Checkpoint** — whenever you finish a meaningful sub-step, hit a surprise, or
   are about to run something long: add a dated line to the task's Notes block.
   Short is fine. The goal is that a crashed session loses nothing important.
3. **Finish or hand off** — when the task is `done`, fill Evidence and flip the state.
   When you stop for any other reason, write a handoff (section 3.4) and leave the
   state as `in-progress` or `blocked`.

Then, **every session, before you stop**, regenerate `STATUS.md` (section 3.5).
A session that changed code but left `STATUS.md` stale has failed its task.

### 3.3 Task row format in `STATUS_DETAILED.md`

```
| M1-T3 | Answer extension dialogs from the UI | in-progress | claude-2026-09-05-a | — | see notes |
```

Columns: ID, Task, State, Owner, Evidence, Notes pointer. The Notes block for a
task lives directly under its milestone table:

```
#### M1-T3 notes
- 2026-09-05 claimed: wire ui-bridge select() to a dialog message
- 2026-09-05 select/confirm/input work; editor needs a multi-line component
- 2026-09-06 done, evidence: `pnpm -F @piorbit/worker test -- ui-bridge`
```

Dates are ISO `YYYY-MM-DD`. They are for reading history, not for planning.

### 3.4 Handoff format

Append to the `## Handoffs` section:

```
### H-7 · M3-T2 · 2026-09-06 · claude-2026-09-06-b
State of the work: parser done, watcher half-done in packages/host/src/subagents/watch.ts.
Uncommitted: yes (git stash list: none; working tree has 3 modified files).
What is broken: fs.watch fires twice on Linux; dedupe by (path, mtime) not yet written.
Next concrete step: implement dedupe, then run `pnpm -F @piorbit/host test`.
Do not: rewrite the parser, it matches pi-subagents 0.65 status.json exactly.
```

### 3.5 Regenerating `STATUS.md`

`STATUS.md` is derived from `STATUS_DETAILED.md`. Rewrite it completely (do not
patch) using the template already in the file:

- **Last updated**: ISO timestamp, your session label, the HEAD commit hash.
- **Current focus**: the milestone with in-progress tasks (one line of intent).
- **Milestone table**: one row per milestone, state = `todo` if no task started,
  `in-progress` if any task is, `done` if all tasks done or dropped.
- **Blockers**: every `blocked` task, one line each, with what unblocks it.
- **Next up**: the three highest-priority `todo` tasks whose dependencies are done.
- **Recently done**: the last five `done` tasks with evidence.

Keep it to one screen. Detail belongs in `STATUS_DETAILED.md`.

### 3.6 Decisions and open questions

- A decision is any choice that a future agent could reasonably re-litigate.
  Append it as `### D-<n> · <date> · <title>` with `Decision`, `Why`, `Consequences`,
  `Supersedes` (optional). Decisions are append-only. To reverse one, add a new
  decision that says `Supersedes: D-<old>`.
- An open question is a decision that only the user can make. Add it under
  `## Open questions` with the task IDs it blocks. Do not guess; if a task needs
  the answer, mark it `blocked`.

### 3.7 Editing `PLAN.md`

Allowed: adding a task (next free `T<n>` in that milestone), splitting a task
(keep the old ID for the first half), dropping a task (state `dropped` in status,
citing a decision), adding a milestone at the end. Not allowed: reordering IDs,
adding dates or estimates, deleting done-when criteria. Any structural change to
`PLAN.md` gets a `D-<n>` entry.

---

## 4. Architecture invariants (violations are bugs, not style)

1. **Nothing above the worker imports Pi.** Only `packages/worker` and
   `packages/pi-extension` may import `@earendil-works/*` or `pi-subagents`.
   Everything else speaks `@piorbit/protocol`. File watchers (pi-subagents runs,
   missions, session catalog) live in the host and parse JSON only, so
   terminal-started sessions stay visible without a worker.
2. **The protocol is ACP-shaped.** `session/new`, `session/load`, `session/prompt`,
   `session/cancel`, `session/request_permission`, plus `pi/*` namespaced extras.
   New capabilities are added to `packages/protocol` first, then implemented.
3. **Two drivers behind one interface.** `SessionDriver` in
   `packages/worker/src/driver.ts` has `StableSdkDriver` (real) and `ChordDriver`
   (stub proving the seam). Any change to the interface must keep both compiling
   and the seam test green.
4. **Pi is pinned inside the worker.** `packages/worker/package.json` depends on an
   exact `@earendil-works/pi-coding-agent` version. The user's global Pi install is
   never used as the runtime. Bumping the pin is a task with its own row.
5. **One worker process per project directory.** The host never runs two projects
   in one Node process.
6. **Extension UI: portable surface only.** `select`, `confirm`, `input`, `editor`,
   `notify`, `setStatus`, `setWidget` (string lines), `setTitle`, `setEditorText`.
   Anything else cancels safely (never hangs). `custom()` is not emulated.
6a. **Pi owns the logic, piorbit owns the experience.** Anything an extension
   wants to show renders through the panel contract in
   [`docs/ux-panels.md`](docs/ux-panels.md): six kinds (`run`, `plan`,
   `document`, `stream`, `collection`, `decision`), four surfaces (ambient,
   inline, dock, sheet), and a placement table that piorbit owns. An extension
   declares a kind and an intent; it never names a surface and never ships
   presentation. Do not invent a bespoke view for one package — either it maps
   onto an existing kind, or adding a kind is a decision recorded in
   `STATUS_DETAILED.md`. Agent work (subagents, workflows, missions) has a
   domain model of its own in [`docs/ux-agent-work.md`](docs/ux-agent-work.md):
   runs, plans and ledgers, which feed the `run` and `plan` kinds.
7. **The relay is a byte forwarder.** `packages/relay` links no crypto library and
   never parses payloads beyond the channel id.
8. **Never two writers on one Pi session file.**
9. **Phone output is untrusted data.** Everything rendered from agent output is
   escaped; no raw HTML from the transcript.

Read `docs/architecture.md` for the layer diagram and the driver seam.

---

## 5. Commands

```bash
pnpm install                      # workspace install
pnpm -r build                     # build all packages
pnpm -r test                      # test all packages
pnpm -F @piorbit/worker test      # one package
pnpm -F @piorbit/worker dev       # run one package in watch mode
```

Conventions: TypeScript strict, ESM everywhere, relative imports use `.js`
specifiers (Pi loads extensions this way and we match it), Node 24, pnpm.

---

## 6. Upstream contributions

When a task needs a change in an upstream project (pi-subagents,
earendil-works/pi, any community package):

- File the PR or issue from the user's fork. Keep it small and self-contained,
  and justify it on its own merits for that project (extensibility, correctness,
  headless-host support).
- Record the PR URL in the task's notes and in `docs/upstream.md`.
- Until merged, the task depends on a local patch or a pinned fork; say which.

## 6a. One companion extension, many modules

All in-process glue for community packages lives in `packages/pi-extension` as
one Pi extension with one module per package (`src/modules/*`). Adding support
for a new package means adding a module, not a package. Modules never import
each other, detect their package at `session_start`, and fail individually
(reported to the UI, never fatal to the session).

---

## 7. Commits

- Commit only when the task owner asks or when a task reaches `done`.
- Conventional prefix (`feat:`, `fix:`, `docs:`, `chore:`), scope = package name.
- No AI attribution trailers of any kind in commit messages or PR bodies.
- Never commit secrets, `auth.json`, session transcripts, or `.env` files.

---

## 8. Do not

- Do not add dates, estimates, or "ETA" anywhere in `PLAN.md`, `STATUS.md`, or
  `STATUS_DETAILED.md` other than the history dates in notes.
- Do not start a task without claiming it.
- Do not mark `done` without evidence.
- Do not delete rows, notes, handoffs, or decisions.
- Do not import Pi outside the worker and the pi-extension package.
- Do not add a new bridge package for a community package; add a module to
  `packages/pi-extension`.
- Do not use the user's global Pi as the runtime.
- Do not write to `~/.pi/agent/settings.json` while a Pi process may be running
  it, except through `SettingsManager` (it takes the lock).
- Do not run two piorbit workers against the same project directory.
