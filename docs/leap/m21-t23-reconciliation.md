# M21-T23 · Product-language and element reconciliation — what was checked, and what is still open

Owner: worker "Reconcile product language and elements", branch
`agents/reconcile-product-language-and-elements-3230568d`, base `257b175a`.
Acceptance (PLAN.md M21-T23): *D-140/D-147/goal/fleet docs updated; M17-T11
absorbed; background work says Command on person surfaces; every claimed
assistant-ui row installed/mapped or rejected with reason.*

This file is the evidence and the handover. It records decisions as
**proposals only** — nothing here numbers itself `D-<n>`; the ledger is the
parent's.

## 1. Docs reconciliation

| Document | What changed | Why |
| --- | --- | --- |
| `docs/ux-fleet.md` | the two-kinds table names **Command** as the word a person reads and `task` as the identifier; new section "The project lifecycle leap, as built (M21-T23)"; the wire block and the implementation map name the worker's own Command producers; `pi/task/stop` records that the worker answers its own ids | D-147 amended, never rewritten: no third kind, no panel bus, and the new producers publish onto the existing surface |
| `docs/agents.md` | §6 retitled "Commands (the wire calls them tasks)" with the noun rule; new §12 "As built after the project lifecycle leap (M21-T23)" | D-140 amended, never rewritten: the harness, the identities, the worktree rule and invariant 5 stand; what changed is that project work now persists above runs, and a run is linked to, never owned |
| `docs/architecture.md` | the companion-module table gains `mcp`, `project-work` and the small modules; `session/set_mode` moves out of the implemented product-request list into an explicit "in the schema, no worker implements it" line; "Data we own" gains `project-work.db` and the Design index files | the layer document described a system from before the leap |
| `docs/ux-elements.md` | new "The verification ledger (M21-T23)" — every claimed row with a verdict and evidence; one stale test reference corrected | acceptance's fourth clause |
| `docs/goal-project-lifecycle-leap.md` | `docs/ux-fleet.md` added to the area-doc reading list | it is binding for anything that shows work in flight and was missing. **The "Done means" list is untouched.** |

Facts behind the fleet section, each read from the code:

- an index build is a Command with no process: `worker/src/design/index/command.ts`,
  published by `design/workspace.ts` as a `BackgroundTask` under
  `designCommandTaskId`, stopped by the worker itself in `server.ts`
  (`pi/task/stop` → `isDesignCommandTaskId`);
- a verification run likewise: `project-work/verification/service.ts` publishes
  under `verificationFleetTaskId`, `server.ts` routes Stop by
  `isVerificationFleetTaskId`;
- both refuse to start without an owning session (`DesignIndexBuildParams`
  requires `sessionPath`; the verification protocol comment states the same
  rule), and the workspace hides Re-index with the reason in its place when no
  conversation can own it (`components/design/build-owner.ts`);
- a Research run does **not** reach the fleet: `worker/src/research/command.ts`
  defines `ResearchCommand` in full, and nothing in `worker/src/server.ts`
  constructs it, so a running Research has a budget line in its header
  (`ResearchDetail.tsx`) and no row and no Stop. Recorded, not fixed.

## 2. M17-T11 (plan mode) — the honest verdict: **not absorbed, because it is not there**

What exists today, exhaustively:

| Layer | State | Evidence |
| --- | --- | --- |
| protocol | the method exists as a shape only: `{ path, mode: string }` → `{}` | `protocol/src/messages.ts`, `schemas.ts` (`mode: z.string().min(1)` — not a `build`/`plan` union), `method-policy.ts` (`session_write`, reach `any`), round-trip sample in `protocol/test/schemas.test.ts` |
| host | no case of its own; it forwards to the worker | `host/src/router.ts` `default: … forwardToWorker` |
| worker | **refuses**: `throw new ProtocolError(ErrorCodes.Unsupported, "session/set_mode is not supported by this worker yet")` | `worker/src/server.ts`, and the refusal is the only test (`worker/test/server.test.ts`, expects `-32004`) |
| driver seam | no `setMode` on `SessionDriver`; neither `StableSdkDriver` nor `ChordDriver` has one | `worker/src/driver.ts` |
| session state | no mode field anywhere | `SessionState` in `protocol/src/messages.ts` |
| UI | nothing: no segmented control, no status-line word, no caller of `session/set_mode` | grep across `packages/ui/src` finds zero references |

So the task's "if it is implemented, prove it; if partly, finish it minimally"
has a third answer, which is the true one: **only the refusing stub exists.**
Everything M17-T11 promises — the two modes, the restricted tool set, the
person-facing refusal, the composer control, the status line, the mid-session
switch — is unwritten, and the unwritten part contains three product decisions
that are not this task's to take. Writing a segmented control that calls a
method the worker refuses would be the "reads as done work and is not" failure
`ux-elements.md` exists to prevent, so M21-T23 changed no source for it.

### What it would take, smallest honest version

1. **Protocol** — `SessionMode = "build" | "plan"`, the schema narrowed from
   `string` to that union, `mode` on `SessionState` so every client draws the
   same truth, and `session/set_mode` answering `{ state }` like
   `pi/model/set` does rather than `{}`.
2. **Worker** — `setMode` on `SessionDriver`; `ChordDriver` throws
   `DriverUnavailableError` (the seam test's existing pattern);
   `StableSdkDriver` holds the mode and calls
   `session.setActiveToolsByName(...)` — the same lever `activateGoalTools`
   already uses (`drivers/stable-sdk.ts`) — restoring the full set on `build`.
   The engine rebuilds its system prompt on that call, so the model is told
   what it has; a refusal sentence still has to be written for the case where a
   withheld tool is asked for by name.
3. **UI** — a segmented control in the composer toolbar (the pattern exists:
   `elements/reasoning-effort.tsx` is a real `radiogroup` with one tab stop,
   arrows, Home and End) and the mode in `thread/StatusLine.tsx`'s words, with
   tests at both widths, both themes and the keyboard path.

### Three decisions the parent must take first

**Proposal A — what "read and search tools" means.** The engine offers no
`readOnly` metadata: `ToolInfo` is `name`, `description`, `parameters`,
`promptGuidelines`, `sourceInfo` (checked in the pinned SDK's
`core/extensions/types.d.ts`). So plan mode cannot ask "which tools write?" —
it has to declare it. Recommended: a Laser-owned allowlist for the engine's own
tools; Laser's own tools classified by the annotations the tool contract
already requires (D-350: `readOnly`, `idempotent`, `destructive`); and
**anything Laser cannot classify — every MCP tool, every future extension
tool — withheld in plan**, with the composer saying how many were withheld and
why. A permissive default would make plan mode a promise the product cannot
keep.

**Proposal B — delegation in plan mode.** `start_agent` starts a child that has
every tool (D-144), so a plan-mode session that may delegate has no restriction
at all unless something says so. Recommended: withhold `start_agent` in plan —
it is the smallest rule, and "plan mode plans" is easy to read. The alternative,
a child inheriting its parent's mode, needs the mode on the harness bridge and
one more sentence in the child's role block, and it makes the mode a property of
a tree rather than of a conversation.

**Proposal C — how long a mode lasts.** Whether the mode is durable session
state (written as a session entry and restored on load, the way
`lasercode/agent` is) or a live-runtime setting that returns to `build` when the
worker restarts. The control and the status line must not claim a persistence
the runtime does not have; either answer is fine, but the UI copy follows it.

Until those three are settled, M17-T11 stays what it is: a row in M17, not a
part of M21. Nothing in this branch pretends otherwise.

## 3. Background work says Command

Changed, all person-facing:

| Surface | Before | After |
| --- | --- | --- |
| the transcript notice when one exits (`thread/TaskEventNotice.tsx`) | "Background task `cmd` exited with code 0" | "Command `cmd` exited with code 0" |
| Advanced → resource diagnostics association rows (`settings/resources/ResourceDiagnostics.tsx`) | kind "Background task" | kind "Command" |
| the same screen's store and association labels (`settings/resources/model.ts`) | "Background commands", "Associated background tasks", "Task records and retained tails", "not currently known to the task registry" | "Commands", "Associated commands", "Command records and retained tails", "not currently known to the command register" |
| the harness limits card (`agents/page/HarnessPanel.tsx`) | "is moved to a background task after this long" | "keeps running in the background after this long — as a Command in the fleet, where you can watch it and stop it" |
| the fleet sheet's accessible description (`fleet/FleetSheet.tsx`) | "agents and background commands" | "agents and Commands" |
| the project Bash pre-command help (`settings/ProjectsTab.tsx`) | "worktrees and background commands" | "worktrees and commands left running in the background" |
| the Subagents feature card and its chips (`protocol/src/features.ts`) | "run long commands as background tasks", chip "Background tasks" | "keep long commands running in the fleet", chip "Commands" |

Two more, for the *other* half of the collision: an agent's brief was labelled
**Task** in the fleet detail (`fleet/FleetPanel.tsx`) and in the agents map
inspector (`agents/map/Inspector.tsx`), where `Task` now means `TASK-44`. Both
read **Brief**.

Unchanged on purpose: `tasks/list`, `tasks/update`, `tasks/output`,
`tasks/stop`, `pi/task/stop`, `BackgroundTask`, `task:<id>`, `task_output`,
`task_stop`, the `background-work` module name, the store slice and every test
fixture — identifiers and wire names are not copy. The agent-facing tool result
("Background task `<id>` exited…") is also unchanged: the model is not a person
surface, and that string is part of the tool's documented output.

Engineering prose left alone: `docs/product-boundary.md`,
`docs/project-environment.md`, `docs/environment-policy.md` and
`docs/resource-and-loading-plan.md` still say "background task" where they
describe the mechanism rather than the surface. The rule is about what a person
reads; renaming every internal sentence would churn four documents this task
does not own. `docs/agents.md` and `docs/architecture.md`, which it does own,
read Command throughout.

Guard: `packages/ui/test/product-language.test.ts` walks `packages/ui/src` with
comments stripped, walks the protocol's feature manifests, and fails on
"background task" / "background command" anywhere a person could read it, plus
the two Brief labels. Proven red before the fix (one offender:
`components/thread/TaskEventNotice.tsx`) and green after.

## 4. Element audit

The ledger is **`docs/ux-elements.md` → "The verification ledger (M21-T23)"**,
in four tables: installed and mounted, installed and deliberately unmounted,
mapped to a Laser-owned component, and rejected with the reason — plus a fifth
that answers the leap's own eleven element claims one by one.

Method and result are in that section. Headline: every "adopted" claim in the
inventory is real, the only three unmounted files are the three the inventory
already says are unmounted, `canvas-split` is the one element the leap named
that M21 deliberately did not use, and **no element was installed by this
task** — installing one to complete a table is exactly the failure the
inventory exists to prevent.

## 5. Not done here, and who owns it

- **Person-owned:** the browser pass on the changed copy (D-342). The strings
  above are proven by unit tests and by reading the components; nobody has seen
  them on screen. Worth one look: the harness limits card's longer sentence at
  a narrow width, and the resource-diagnostics association rows.
- **Parent-owned:** the three M17-T11 proposals above; whether the Research
  Command gets wired to the fleet inside M21 or after it; and the ledger rows
  (`PLAN.md`, `STATUS.md`, `STATUS_DETAILED.md`), which this worker did not
  touch.
