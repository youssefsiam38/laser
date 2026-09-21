# M21-T19 · the verification run's Command lifetime — investigation and plan

Parent inspection of runtime33d3163e found five remaining correctness gaps;
[`m21-verification-runtime-corrections.md`](m21-verification-runtime-corrections.md)
is the required correction batch before the first full T19 review. In
particular, timer-based stdio grace is not accepted as actual drain.

**Read-only investigation. No code, no tests and no other file changed by this
owner.** This is the original M21-T19 Command contract — a verification run is
a bounded, visible, stoppable Command — finished rather than extended. Nothing
here is a new feature, a generic Command framework or a second host decision
engine.

Binding text: [`../project-lifecycle-leap.md`](../project-lifecycle-leap.md)
("Execution and convergence"), [`../agents.md`](../agents.md) §6 — *"bounded
lifetime (RP-6) — when a command ends, its ending is published and delivered
first, and only then is the memory that carried it released"* (`docs/agents.md:626`),
[`m21-verification-followup.md`](m21-verification-followup.md) §A (the row, the
id, Stop, session ownership), [`../../AGENTS.md`](../../AGENTS.md) invariant 5
and D-342.

## What was read, and at which revision

| Source | Revision |
| --- | --- |
| `packages/worker/src/project-work/verification/{service,run,commands,tools,index}.ts`, `packages/worker/src/server.ts`, `packages/worker/test/project-work/{verification,verify-server}.test.ts`, `packages/ui/src/components/project-work/VerificationPanel.tsx`, `packages/protocol/src/project-work-verification.ts`, `packages/host/src/project-work/methods.ts` | `b632341a` (the durable-proof owner's worktree; **read only**, nothing touched) |
| `packages/worker/src/server.ts` (canonical rekey hook, `b4ed1003`+`d408e8ea`), `packages/worker/src/design/index/bridge.ts`, `packages/worker/src/design/workspace.ts`, `packages/worker/src/agents/tasks.ts`, `packages/worker/src/session-safety.ts`, `packages/worker/src/worker-lifetime.ts`, `packages/worker/src/process-guards.ts`, `packages/host/src/tasks/register.ts` | `f2f9b12e` (parent checkout = this worktree's base) |

Line numbers below are from those two revisions. The verification sources are
outside the current proof owner's permitted writes, so they are stable; the
`server.ts` verification wiring will arrive in the parent when that branch is
merged, and the canonical rekey hook already exists in the parent — the plan
assumes the merged file, never a re-derived one.

Ancestry of the verification sources: preserved at `9fa1ce26` / `a44248c2`
(merge `b632341a`). No merge, rebase or conflict resolution was performed here.

## The pipeline, as it actually is

```
person  → pi/project/verify/start ─┐
model   → verify_project_task    ─┴→ VerificationService.start()
            └─ VerificationRun.execute()
                 1. bridge.verify({action:"plan"})      HOST READ  (no write)
                 2. runVerificationCommand × N          worker, in the checkout
                 3. bridge.verifyReport({action:"report"}) HOST WRITE ← the only commit
            └─ onProgress → service.publish → publishTask
                 → this.notify("pi/extension/message", {type:"lasercode/task/update"})
                     → host TaskRegister.observeExtensionMessage → tasks/update → fleet
```

- **Ownership.** One `VerificationService` per worker (`server.ts:2222`), one
  run per `VerificationRun`, owner fixed at `start()` (`service.ts:95-119`) and
  never re-derived from any current session.
- **Persistence.** The worker persists nothing. The record is the host's, from
  the instant step 3 lands: evidence + the `verification` blob + the link
  (`host/project-work/methods.ts:939-996`), idempotent on
  `idempotencyKey: verify-<runId>` (`run.ts:235`).
- **Irreversible boundary.** Step 1 is a pure read (`methods.ts:964-971`,
  `project/work/get` carrier). Step 3 is the only write, it takes no abort
  signal (`run.ts:222`), and once the request has left the worker the host may
  commit whether or not the worker ever sees the answer. **Nothing the worker
  does after that point can un-commit it, and there is no host rollback to
  invent.**

## Hypotheses, checked against the code

| # | Hypothesis | Verdict | Evidence |
| --- | --- | --- | --- |
| H1 | `service.Held.sessionPath` is static | **Bug, confirmed** | `service.ts:68` declared, `service.ts:119` set at start, `service.ts:188,205` the only reader; no `rekeySession` anywhere in the file |
| H2 | `run.state.sessionPath` copied at creation | **Bug, confirmed** | `run.ts:71`; `snapshot()` (`run.ts:83`) is what `pi/project/verify/state` answers (`server.ts:1216-1219`) and what `VerificationPanel` holds (`VerificationPanel.tsx:144-150`) |
| H3 | No canonical rekey hook | **Bug, confirmed** | `server.ts:3300-3330` (parent) rekeys harness, tasks, mcp, git, naming, design index, design workspace — and nothing verification |
| H4 | `prune()` only in `start()` | **Bug, confirmed** | `service.ts:123` is the only call site; `service.ts:208-217` |
| H5 | `run.stop()` publishes a terminal phase while the work is still pending, so the safety pin can release before settlement | **Confirmed, with a correction** | `run.ts:96-102` publishes `phase:"stopped"` synchronously; `service.ts:182-196` maps it to a terminal row. The pin consequence is *currently vacuous* — see V1: the pin is never taken at all. After V1 it becomes live |
| H6 | `void run.execute().finally(() => publish)` can leave an unhandled observer error | **Confirmed, with a correction** | `execute()` alone never rejects (`run.ts:110-126` catches everything). A throwing `publishTask` does: `run.ts:141` calls `onProgress` inline, the `catch` at `run.ts:116` publishes again and throws again, and `service.ts:127` floats the result. It does **not** crash the real worker — `main.ts:143` installs the rejection guard — but the guard logs the raw reason/stack (`process-guards.ts:36`) and the run's terminal row is lost, leaving a row that says *running* for ever |

## Findings, in the order they have to be fixed

### V1 · a verification row never enters this worker's own fleet index — so it pins nothing

The design workspace publishes through **both** doors; verification publishes
through one.

```
server.ts:2293-2294 (parent, canonical)   this.tasks.observe(path, message);
                                          this.notify("pi/extension/message", …);
server.ts:2236-2239 (verification)        this.notify("pi/extension/message", …);   ← only
```

The parent's comment at `server.ts:2285-2292` states the rule this breaks
verbatim: *"This worker's own fleet index first, then the host's … because a
session with a running command is pinned (`session-safety.ts`), the
conversation that owns it cannot be released … That is how 'no invisible
running work' is kept."*

Actual consequences, all from code, none from comments:

1. `runningTasks` counts only `this.tasks.tasksOf(live.path)`
   (`server.ts:2662`) → `sessionPins` never adds the `task` pin
   (`session-safety.ts:100`) → `lifetime.unload()` releases a session whose
   verification run is mid-command (`worker-lifetime.ts:124-130`), and
   `retire("automatic"/"manual")` sees no work (`worker-lifetime.ts:245`).
2. `inspect_fleet` in this worker (`harness.ts:1650-1656` → `server.ts:435` →
   `tasks.tasksOf`) does not
   list the run, so an agent in the owning session cannot see or `task_stop`
   a Command its own session owns.
3. `tasks.sessionClosed` (`server.ts:3261`) cannot mark the row stopped,
   because the row was never there.

(The same line is missing from the design workspace *in the proof worktree*
(`server.ts:2357-2360` there) because that branch predates `b4ed1003`; the
parent's version wins on merge. Verification needs its own line either way.)

### V2 · a fork moves the conversation and the run keeps publishing at the old address

`Held.sessionPath` and `state.sessionPath` are both frozen at `start()`, and
`server.ts:3300` never tells the service. After `pi/session/fork` rekeys
(`server.ts:773-781`):

- the host register has **deleted** the old bucket (`host/tasks/register.ts:181-190`,
  whose own comment says *"a row left behind under a path no runtime serves is
  a ghost the fleet can never lose"*). The next verification publish under the
  old path **recreates that bucket** with a `running` row nothing will ever
  terminate;
- once V1 is fixed, the same publish re-creates the old path inside this
  worker's `TaskIndex` and `observe()` calls `reopened(path)`
  (`tasks.ts:83`, `tasks.ts:196`), removing it from the closed list — so the ghost is
  exempt from the `MAX_CLOSED_SESSIONS` bound too;
- `pi/project/verify/state` keeps answering the old `sessionPath` (H2), and the
  moved conversation never receives the row at all (a row is only ever learned
  from a publication).

### V3 · terminal is published before the work settles

`run.stop()` (`run.ts:96-102`) sets `phase:"stopped"` and `endedAt` at once;
`service.publish` (`service.ts:182-196`) turns that into `status:"stopped"`,
`endedAt`, `exitCode:null`. At that moment the run is still going to:

- finish/kill the command in flight (`commands.ts:123-136`), then
- run **step 3**, the host write (`run.ts:217-256`).

With V1 fixed, the row is the pin, so the pin drops while the decision is still
being committed — the session can be unloaded and the worker retired under a
live host write. This is precisely the rule `docs/agents.md:626` states:
publish the ending **after** the work ends.

### V4 · a stopped run whose report could not be written looks exactly like one whose report was written

`run.ts:118`: `if (this.stoppedReason !== undefined) return this.publish({ phase: "stopped", endedAt })` — the error is discarded. A host that was
unreachable, a quota refusal (`-32011`), a revision fence — all produce the
same row (`terminalReason: "you stopped it"`, `service.ts:203`) and the same
`VerificationRunState` as a clean stop that *did* record what it proved. The
person is told the run stopped; they are not told that what it proved was lost.

### V5 · retention is enforced only when the next run starts

`service.ts:123` is the only `prune()` call. Twenty-one runs that all finish
and no twenty-second start → every report stays held (a `VerificationReport`
carries every command record with its tail, `run.ts:251`). The settled pattern
does it the other way round: publish the terminal row, **then** bound
(`design/index/bridge.ts:219-247`, `design/workspace.ts:305-307`). `prune()`
also decides "finished" by reading `phase` (`service.ts:209-211`), which after
V3 would no longer mean "settled".

### V6 · one throwing observer loses the run's ending and logs a raw error

Path in H6. Compare the settled pattern, which is explicit about both halves
(`design/index/bridge.ts:227-247`): the observer call is wrapped, the sweep
still runs, and the diagnostic carries *the id and the error's `name` only* —
never its message, stack or anything the command read. A verification run's
error can carry a project's own command output; the rejection guard currently
prints `reason.stack` (`process-guards.ts:36`).

### V7 · `stopByTaskId` answers `delivered:false` for a run this worker does hold

`service.ts:164-169` returns `this.stop({runId}).stopped`, which is `false`
when the run was already terminal (`service.ts:159`) — although the documented
meaning of `delivered:false` is *"nobody here holds that id"*
(`server.ts:1097-1103`, `m21-verification-followup.md` §A). Today that only
misreports a second Stop; after V3 (a run stays non-terminal while it settles)
a second Stop press would report "nobody holds it" about a run that is
visibly stopping. The existing seam test only asserts `false` for an id this
worker never had (`verify-server.test.ts:142`), so the honest answer is
compatible with it.

### V8 · a run outlives the conversation that was closed

`pi/session/close` refuses only on `isStreaming` (`server.ts:717-731`) — it
does not consult pins — and the driver's `closed` branch drops the runtime and
calls `this.tasks.sessionClosed` (`server.ts:3255-3261`). The verification
service is never told: its commands keep running in the checkout and its next
publish resurrects the closed path (V2's mechanism). `TaskIndex.sessionClosed`
states the intended rule — *"whatever was still running stopped with the
process that ran it … so no row spins for ever"* (`tasks.ts:179`).

## The open contract: Stop versus a report already in flight

**A Stop cannot cancel a decision the host has already committed, and no
rollback exists to invent.** Two facts bound the problem, both read rather than
assumed:

- the report call takes no signal and is the only write (`run.ts:222`);
- a stopped run's report **cannot move the Task**: `stopped: true` feeds
  `convergenceOf` (`run.ts:244`, protocol `project-work-verification.ts:481-512`),
  every unreached required criterion is a reason, so `converged` is false and
  the host's `convergeTask` does not move it. What commits is *evidence that
  the run was stopped and what it had proved so far* — never a state change.

### Option A (recommended) — Stop is bounded refusal of further work, never a cancel

`stop()` means: start no further command, kill the one running, and settle as
soon as the report the run already owes has landed or failed. If the stop
arrives while step 3 is in flight, the run says so in its own words and the
committed evidence is reported as what it is. The row is `running` with a
*Stopping* line until settlement, then terminal.

- Truthful: nothing claims an in-flight commit was cancelled.
- Bounded: the abort kills the process tree immediately
  (`commands.ts:123-136`), and step 3 is one host request.
- Costs: the Stop button stays lit for the length of one host call; the fleet
  row stays pinned for that time — which is the correct pin.

### Option B — Stop is immediate and the report is abandoned

Terminal at once (today's behaviour), and the run drops its own report call:
`stop()` after step 3 has been sent means the host may still commit evidence
nobody is told about.

- Rejected: it is exactly the "accepted Stop cancels an already-committed
  decision" claim that cannot be made, it loses the record of what a long run
  had already proved, and it re-creates V3's pin release.

**Recommendation: Option A.** It needs one decision from the parent, below.

### The one decision Option A needs

The row's *Stopping* sentence has to come from somewhere, and
`verificationRunLine` switches on `phase` only (protocol
`project-work-verification.ts:665-681`); `VERIFICATION_PHASES` has no
non-terminal stopping value (`:560`) and `BackgroundTaskStatus` has no
`"stopping"` (`protocol/src/tasks.ts:17`).

| | Change | Cost |
| --- | --- | --- |
| **A1 (recommended)** | one optional field `VerificationRunState.stopping?: boolean` + one branch in `verificationRunLine` ("Stopping — ending the commands and writing what it proved") | edits `packages/protocol/src/project-work-verification.ts`, which the current proof owner may also be editing. Must be serialized after their checkpoint. Invariant 2 satisfied: the capability lands in the protocol first. UI `TERMINAL` set is unchanged, so `VerificationPanel` keeps polling and shows the honest line with no UI edit |
| A2 | the worker writes the line itself and leaves the protocol alone | two sources of truth for one sentence, and `verificationRunLine` silently stops describing the state it is given |

No new phase, no new task status, no new Command framework.

## Implementation plan (sequential, smallest complete change)

Prerequisite: the proof owner's branch is merged into the parent, so
`server.ts` has both the verification wiring and the canonical rekey hook. One
owner, one pass, in this order.

1. **Index the row (V1).** In `server.ts` `verification()`'s `publishTask`
   (`:2236`), call `this.tasks.observe(path, message)` before
   `this.notify(...)`, with the same comment the design workspace carries.
   *Acceptance:* a running verification run pins its session; `unload` refuses
   with the `task` pin; `inspect_fleet` lists the row.
2. **Settle before terminal (V3, V4, A1).**
   - protocol: `stopping?: boolean` on `VerificationRunState` (+ schema,
     optional) and one `verificationRunLine` branch.
   - `run.stop()` (`run.ts:96`): idempotent (return if `stoppedReason` set),
     record the reason, `abort()`, `clearCommand()`, publish
     `{ stopping: true }` — **no phase change, no `endedAt`**.
   - settlement stays where it already is: `report()` (`run.ts:249`) and the
     `catch` (`run.ts:116-124`) are the only places a terminal phase is
     published. The `catch`'s stopped branch keeps the error as
     `problem` (V4), worded for a person: *"You stopped this run, and what it
     proved could not be recorded: …"*.
   - `service.publish` (`service.ts:182-204`): terminal when the phase is
     terminal, as now; for a stopped row carry `error: state.problem` when
     there is one, and `terminalReason: state.problem ?? "you stopped it"`.
     *Acceptance:* no terminal row and no pin release while the report barrier
     is unresolved; a failed report write is visible in the row.
3. **Canonical rekey (V2, H1–H3).**
   - `VerificationRun.rekeySession(newPath)`: replaces `this.state` with
     `{ ...this.state, sessionPath: newPath }`. It does **not** mutate
     `options` (the caller's object) and does not recompute anything else;
     `options.sessionPath` is read exactly once, at `run.ts:71`, so there is no
     second truth.
   - `VerificationService.rekeySession(oldPath, newPath)`: `if (oldPath === newPath) return;` then for every held run whose `sessionPath === oldPath`,
     replace `held.sessionPath`, call the run's own rekey, and collect the
     ones that have **not settled**; republish those forced, after the loop, so
     the moved conversation learns a row it was never sent. Nothing infers a
     "current session", nothing re-derives ownership, and the old path is never
     published again because `held.sessionPath` is the single source
     (`service.ts:188,205`).
   - `server.ts` `rekeySessionState` (`:3300`): add
     `this.verificationRuns?.rekeySession(oldPath, newPath);` — the **field**,
     not the getter (a conversation that never verified must not acquire a
     service because its file moved), placed after `this.tasks.rekeySession`
     so the republished row lands in the moved index, beside the design lines.
   *Acceptance:* after a fork, every subsequent row is under the new path,
   `verify/state` answers the new path, and no publication ever names the old
   one.
4. **Retention at settlement (V5).** Mark the held run settled in the one place
   that knows — the `.finally` at `service.ts:127` — publish the terminal row
   forced **first**, then `prune()`. `prune()` selects on that settled flag
   rather than on `phase` (the index's `finished` flag,
   `design/index/bridge.ts:249-254`), keeps `VERIFICATION_RUNS_KEPT = 20`,
   never evicts an unsettled run, and never evicts one whose terminal row has
   not been published. Keep the existing `start()` call as a cheap second
   sweep.
   *Acceptance:* 21 concurrent finishes with no further `start()` leave 20 held;
   an unsettled run is never evicted.
5. **Bounded observer safety (V6).** Wrap the `publishTask` call in
   `service.publish` in `try/catch`; on error log one bounded line through an
   injectable `log` option (default `console.error`) carrying the **run id and
   the error's `name` only** — never its message, stack, command text or tail
   — and carry on (nothing retried, nothing queued, the sweep still runs).
   Float the settlement chain explicitly with a `.catch` that cannot itself
   throw. Model: `design/index/bridge.ts:227-247`.
   *Acceptance:* a throwing observer loses no terminal row and emits no raw
   error text.
6. **The closed conversation (V8).** `VerificationService.sessionClosed(path)`
   stops the runs owned by `path` with *"the conversation it was running in was
   closed"*, called from `server.ts:3261` beside `this.tasks.sessionClosed`.
   A stopped run still writes what it proved, which is the T19 contract.
   *Flagged for the parent:* this is the smallest truthful option, but
   `pi/session/close` is also how the host moves a session's file
   (`server.ts:717-720`), so a move ends a run that a person may have wanted to
   keep. **Defer this step if the parent prefers**; V1+V3 already prevent the
   unload path, and nothing else in this plan depends on it.
7. **Honest `delivered` (V7).** `stopByTaskId` returns `true` whenever this
   worker holds the run (it already proved that at `service.ts:167`), and calls
   `stop()` for effect. `service.stop`'s own `stopped` boolean keeps its
   meaning ("this stop changed something") and gains "already stopping" as
   `false`.

Not touched, deliberately: `commands.ts` (bounded output, kill, timeouts are
correct as read), `tools.ts` (the tool's refusals are correct; a stopped run
with no report already refuses through `state.problem`, `tools.ts:152-158`),
the host's evaluation, capture, decision and history paths, the UI, and every
file the current proof owner is writing.

## Tests to write with it (deterministic, no wall-clock sleeps)

The existing worker suite times runs with real `setTimeout`
(`verification.test.ts:253,270,321,337`). The new ones must not: give the fixture a
**deferred barrier** the test resolves by hand — `runner` returns a promise the
test controls, and the `ScriptedHost`'s `verifyReport` does too — so every
assertion below is about an exact point in the lifecycle, and inject `now` for
the timestamps.

| # | Test | Fails before |
| --- | --- | --- |
| 1 | a running run's row reaches this worker's `TaskIndex`, and the session's pins contain `task` (through `WorkerServer`, as `verify-server.test.ts` does) | V1 |
| 2 | `unload` refuses while a run is mid-command, and allows it once the run has settled | V1+V3 |
| 3 | Stop while the command barrier is unresolved: the row is still `running`, its `activity` is the stopping line, no `endedAt`, and no terminal row has been published | V3 |
| 4 | Stop while the **report** barrier is unresolved: still non-terminal; resolving the barrier publishes exactly one terminal `stopped` row, after the host answered | V3 |
| 5 | Stop, then the report barrier **rejects**: the row is `stopped`, carries the write failure, and `VerificationRunState.problem` says what was lost | V4 |
| 6 | a stopped run's committed report does not move the Task (`converged === false`), asserted from the scripted host's stored report | — (guards Option A) |
| 7 | fork rekey: every publication after `rekeySession` names the new path, none names the old, an unsettled run republishes once, and a settled one does not | V2 |
| 8 | `rekeySession` does not mutate the options object the caller passed, and a service with no run for the old path publishes nothing | V2 |
| 9 | `verify/state` answers the new `sessionPath` after a rekey (through the server, with a fake driver whose `fork` moves the path) | H2 |
| 10 | 21 runs settled with no further `start()` → 20 held, the evicted one is the oldest-started, and its terminal row was published before eviction | V5 |
| 11 | an unsettled run is never evicted, whatever the count | V5 |
| 12 | a `publishTask` that throws: the run still settles, the terminal row is attempted, and the logged line contains the run id and the error name and **not** its message | V6 |
| 13 | a second Stop on a stopping run answers `delivered: true`; an id this worker never held still answers `false` | V7 |
| 14 | (with step 6) closing the owning session stops its runs and publishes their terminal rows; nothing is published under that path afterwards | V8 |

Files these belong in: `packages/worker/test/project-work/verification.test.ts`
(1 is a server test → `verify-server.test.ts`; 2 and 9 likewise). Protocol
tests for A1: the optional field round-trips through
`verificationRunStateSchema` and `verificationRunLine` returns the stopping
sentence.

## Adjacent authority mismatches (direct evidence only, no scope expansion)

- `verification()`'s bridge builds `execution: () => this.executionShape(cwd)`
  with **no** `sessionPath` (`server.ts:2227`), while a session's bridge passes
  one (`server.ts:2275`). Any execution envelope a verification-run write
  attaches therefore records no session. Evidence only; out of this milestone.
- `pi/session/close` consults no pins at all (`server.ts:717-731`), unlike
  `unload` (`worker-lifetime.ts:124-130`). That is wider than verification and
  belongs to whoever owns session lifetime, not here.

## What this investigation did **not** do

No code, no tests, no merge, no conflict resolution, no full suite, no browser,
no external command. `commands.ts`'s process handling was read and reasoned
about, not executed. Nothing in the proof owner's worktree was modified: every
read above was `read`/`grep` at `b632341a`.

## Parent disposition — approved only with these corrections (D-364)

The original plan is preserved above. Its claims that `commands.ts` already
waits for termination and that *any* stopped run sends `stopped: true` are
incorrect. Parent checked `commands.ts:123–138` and `run.ts:217–256` directly.
The amendment message to the stopped investigator was refused by the runtime;
these corrections were not delivered there. This section is the approved
implementation contract, after the current proof-consumer checkpoint.

1. **A1, with an explicit dispatch boundary.** Add the optional protocol
   `stopping` field and its shared non-terminal wording. Before the host report
   is dispatched, Stop is accepted: no further command, abort the active one,
   keep the row running/pinned while it drains and the stopped report settles.
   Once `verifyReport` has been invoked, a new Stop cannot change its serialized
   input or revoke a possible `needs_review` transition. Return unchanged /
   not-accepted for that new Stop, retain a truthful Saving-results line and
   the pin, and show the actual host outcome. `delivered` still means this
   worker holds the id, not that cancellation succeeded. Never send a second
   corrective report or invent rollback. A pre-dispatch accepted Stop remains
   stopping through its own report. Test both sides with a deferred RPC barrier.
2. **The runner must really drain.** `onAbort` and timeout currently call
   `kill(); finish()` without waiting for child/stdio close. Fix that lifecycle
   before claiming settlement. An already-aborted request must not spawn;
   synchronous spawn failure must not hit the uninitialized `timer` captured by
   `finish`. Install lifecycle listeners safely, keep bounded output writable
   until drain, and settle/hash it once. Reuse existing owned-process-tree
   facilities, including supported-platform behavior, rather than inventing a
   second process supervisor. Failed termination is not evidence of exit:
   preserve the unsettled safety state and an honest problem rather than a
   manufactured terminal confirmation. Tests use inert spawn doubles for
   delayed close, late output, abort, timeout, spawn failure and kill failure;
   no hostile process or external target is needed.
3. **V8 is required, not deferred.** `pi/session/close` is the host's file-move
   preparation, not a person's free-standing close operation. Refuse it under
   the existing session lock while owned commands/verification are unsettled;
   explain Stop-and-wait before moving. Do not dispose the owner first and then
   recreate its old row. Unexpected driver closure must stop owned work and
   suppress publication that would resurrect the closed path, while private
   settlement/retention still completes. Same-Live fork rekey remains distinct
   and carries the owner to its new address without stopping it.
4. **Attribute bridge requests to that owner.** Fix the directly observed
   verification `executionShape(cwd)` omission. Use the run's explicitly
   admitted, canonically rekeyed session address for per-run bridge context,
   never a global current session or a shared mutable caller request. Preserve
   the immutable logical owner; do not rewrite prior execution/history records.
   Include a real server/bridge-context regression across rekey.
5. **Keep the good parts of the plan:** canonical TaskIndex observation before
   transport notification; run/service rekey without instantiating unused
   services; actual-settlement retention of at most 20 finished runs with no
   next start; idempotent Stop/delivered distinction; visible report-write
   failure; bounded content-free observer diagnostics and no floated rejection.
   An arbitrary throwing observer cannot promise external delivery: prove
   canonical state/retention survives, and label that limitation honestly.

Implementation ownership is worker verification service/run/runner and tests,
narrow server ownership/close hooks, the minimal protocol stopping field and
schema/tests, and this evidence document. Only touch related Stop presentation
if needed to avoid claiming a delivered request cancelled a committed report.
No host-proof/schema/history or proof-viewer edits. First preserve the complete
proof checkpoint and merged Command fixes in the implementation branch. Use
focused protocol/verification/server safety and close/move tests, types and
identity; parent owns full verification. One full T19 review follows all
corrections, not separate micro-reviews. Ask only if a genuinely different
host authority or wire operation becomes necessary.

## What was implemented, and how it was proved (D-364)

Owner: the implementation session for M21-T19's Command lifetime, on
`agents/implement-verification-command-lifetime-801faae2`, from `9f3e8ca7`
with the whole proof checkpoint `36e163ed` merged in first (merge commit, no
cherry-pick, no rewrite, no conflict: the merge was clean). Everything below
is code in this branch, not a proposal. The approved contract is the **Parent
disposition (D-364)** section above; the numbering follows it.

### 1 · the row is indexed before it is transported

`server.ts` `verification()`'s `publishTask` now calls `this.tasks.observe(path, message)` **before** `this.notify(...)`, the same two lines and the same
rule the design workspace carries. A running verification therefore counts in
`runningTasks` (`server.ts:2758`), takes the `task` pin
(`session-safety.ts:100`), and is in the array `inspect_fleet` reads
(`harness.ts:1655` → `host.tasks` → `tasks.tasksOf`).

### 2 · a stop is bounded refusal of further work, never a cancel

- **Protocol first.** `VerificationRunState.stopping?: boolean` with its schema
  entry, one branch in the shared `verificationRunLine`, and
  `isVerificationPhaseTerminal` so the run, the registry and the row agree in
  one place about what "ended" means. No new phase, no new task status, no UI
  edit: `VerificationPanel` reads `run.line` and keeps polling.
- **Before dispatch**, `run.stop()` records the reason, aborts, clears the
  current command and publishes `{ stopping: true }` — no phase change, no
  `endedAt`. The row stays `running`, so the session stays pinned until the
  stopped report has landed or failed.
- **After `verifyReport` has been invoked** (`reportDispatched`), a new stop
  changes nothing: `stopped: false`, state untouched, the serialized payload
  untouched (its arguments were built at the call), no second report, no
  invented rollback, and the row keeps the truthful *Saving what this run
  proved* line and the pin until the host's own outcome arrives — including a
  move to `needs_review`.
- A report write that **fails** after a stop is kept as `problem` and carried
  into the fleet row's `error`/`terminalReason`, so a run whose record was lost
  never looks like one that kept it.

### 3 · the runner really drains

`commands.ts` settles only when the child has gone **and** its output is closed
(`close`), or on a bounded `VERIFICATION_STDIO_GRACE_MS` wait after `exit` when
a pipe nobody owns is still open — and a record made on that bound says the
last of the output may be missing. Asking a tree to end no longer records
anything: `onAbort` and the timeout set the reason and kill, and the record is
made when the close is witnessed. An already-aborted request starts no process;
a synchronous spawn failure is `unavailable` (the `timer` it used to touch is
declared before `finish`); the abort listener is installed after a successful
spawn and removed once, and settlement is once-only. The kill is the worker's
existing owned-tree pattern, process group on POSIX and `taskkill /T` on
Windows (`agents/worktrees.ts`, `project-env.ts`), exported as
`killVerificationTree`; the child is named to the process inventory (RP-1). If
the system refuses to end the tree, **no exit is invented**: the run stays
unsettled — which keeps the pin and the honest row — and one bounded line
carries the system's code and nothing the command read.

### 4 · one canonical rekey, and a bridge that names its owner

`VerificationRun.rekeySession` replaces the state (never the caller's options
object); `VerificationService.rekeySession` moves every run of the old path,
republishes the unsettled ones once, and publishes nothing for a path it holds
nothing for. The run's own state is the single source of the row's
`sessionPath`, so the old path cannot be republished. `server.ts`
`rekeySessionState` calls it through the **field**, after `tasks.rekeySession`.
`bridgeFor(cwd, sessionPath)` gives each run a bridge whose `execution()` is
`executionShape(cwd, undefined, sessionPath)` — the admitted owner's current
canonical address, read at call time, never a global current session and never
a mutated caller request. No historical record is rewritten.

### 5 · retention at settlement, and bounded observer diagnostics

`Held.settled` is set in the one place that knows — the settlement chain — after
the terminal row has been published, and `prune()` selects on it: at most 20
settled runs with no next start, an unsettled run never evicted, and an ending
never lost to eviction. The settlement chain is floated with `then(fn, fn)` so
nothing can reject into the worker's rejection guard. A `publishTask` that
throws is caught: the run still settles, retention still runs, and one bounded
line carries the run id and the error's `name` only.

### 6 · `pi/session/close` is the host's file-move preparation

Under the existing `firstTurnLock`, close now refuses while this conversation
has a running command or an unsettled verification run, with the sentence that
says to stop it and wait; the driver is not disposed first and no old row is
resurrected. An unexpected `closed` event calls
`VerificationService.sessionClosed`, which stops that conversation's runs and
detaches them: nothing further is published under a path no runtime serves,
while the stopped report, settlement and pruning still complete privately. A
same-`Live` fork stays the other case entirely — it moves the address and keeps
the run.

### 7 · `delivered` means this worker holds the id

`stopByTaskId` answers `true` whenever the run is held — already stopping,
already reporting or terminal — and `false` only for an id this worker never
had. `stop().stopped` keeps its own meaning: *this stop changed something*.

### Evidence

Commands run in this worktree, at the revision this section was written for:

| Command | Result |
| --- | --- |
| `pnpm install --frozen-lockfile` | ok |
| `pnpm -r build` | all packages built |
| `pnpm -F @lasercode/worker exec vitest run test/project-work test/session-safety.test.ts test/session-unload.test.ts test/session-retire.test.ts test/server.test.ts test/process-guards.test.ts` | 188 passed (11 files) |
| `pnpm -F @lasercode/protocol exec vitest run test/project-work-verification.test.ts` | 19 passed, no type errors |
| `pnpm -F @lasercode/host exec vitest run test/router.move.test.ts test/session-move.test.ts test/session-route-lease.test.ts` | 37 passed |
| `pnpm -F @lasercode/worker typecheck`, `pnpm -F @lasercode/protocol typecheck`, `pnpm identity:check` | clean |

New tests, all deterministic — deferred barriers the test resolves by hand, an
inert spawn double, and `setImmediate` turns; no wall-clock sleeps, no retries,
no skips. `packages/worker/test/project-work/verify-server.test.ts` drives the
real `WorkerServer` and answers its host requests one at a time:

- the row is published under its conversation and a stop from it is delivered
  without claiming the run ended (still `running`, no `endedAt`, *Stopping*
  line, no terminal row until the report lands);
- the `task` pin holds the session while the run is unsettled: `unload` refuses
  with it, `pi/worker/retire { mode: "explicit" }` refuses with `pinned`, and
  both succeed once the report has landed;
- `pi/session/close` refuses while the run is unsettled and closes after it;
- a fork carries the run: every later row and `pi/project/verify/state` name
  the new path, and nothing names the old one.

`packages/worker/test/project-work/verification.test.ts` adds the stop/report
boundary (both sides), the lost-record wording, the untouched serialized
payload and single report call after dispatch, fork rekey (including the
bridge's owner thunk and another conversation left alone), session close,
retention at settlement, retention under a throwing observer, the bounded
diagnostic, and eight runner-lifecycle cases: pre-aborted (no spawn),
synchronous spawn failure, late output before close, stop-then-close,
timeout-then-close, `ENOENT`, a kill that fails (no record invented, one
bounded line), and the bounded grace when output never closes.

**Limits, stated honestly.** `inspect_fleet` itself is not driven here: what is
asserted is that the row is in this worker's `TaskIndex` through the session's
pins, which is the same `tasks.tasksOf` array the fleet view reads — a proxy,
named as one. The per-run execution shape is proved at the service seam and by
reading `server.ts`: `HostProjectWorkBridge` attaches the execution envelope to
`project/work/create` and `project/work/revise` only, so a verification run's
own `plan`/`report` calls carry no envelope on the wire today. Browser
acceptance remains the person's (D-342), and the full verification suite is the
parent's gate, not this session's.

**One handoff for the UI owner (no UI file touched).** While a run is winding
up its phase is still non-terminal, so `VerificationPanel`'s Stop button stays
visible; a second press answers `stopped: false` with the unchanged run and the
panel already ignores it, so nothing false is shown. If that button should read
*Stopping…* or be disabled while `run.stopping` is true, that is a one-line UI
change on the existing field — reported, not taken.

## The parent's correction batch, as implemented

One owner, one batch, on the branch that preserves the whole runtime
checkpoint `33d3163e` and the whole proof-consumer branch `59468295`. The
approved contract is
[`m21-verification-runtime-corrections.md`](m21-verification-runtime-corrections.md);
what follows is what the source now does and which claims above no longer hold.

**Claims above that are superseded.**

- *"the bounded grace when output never closes"* (the runner-lifecycle list):
  there is no longer any bound on which a record is made. A timer after the
  child's `exit` asks the owned tree to be cleaned up once and says, in one
  bounded line, that this run is waiting — it never settles anything. `close`
  is the only event that makes a record.
- *"the panel already ignores it, so nothing false is shown"* (the UI
  handoff): the button was enabled and a press did send a request that could
  only answer "nothing changed". It is now disabled while the run is winding
  up and reads *Stopping…* / *Saving results…*, from the same state.
- The run id is no longer a module counter. `ver_0001` after a restart was a
  durable key collision, not a cosmetic detail.

**What changed, by finding.**

1. *Actual drain.* `commands.ts` settles only on the child's `close`. The exit
   timer sets no status: past `VERIFICATION_STDIO_GRACE_MS` it asks
   `killTree` for the owned tree once and logs one content-free line. Bytes,
   digest and tail are finalized once (`BoundedOutput.done` memoizes, and
   `add` refuses anything after that), and the data listeners are removed with
   the abort listener when the record is made, so a late chunk can neither be
   counted into a published total nor rehashed into a published digest. A run
   whose output never closes stays unsettled — pinned, visible, honest.
2. *Termination failures are observed.* `killVerificationTree(child, onProblem,
   seams)` reports Windows `taskkill` failures through `onProblem` (the
   callback that used to discard them) and still throws for a synchronous
   POSIX refusal; `ESRCH` is "already gone", not a failure. Either way no exit
   is invented: the run stays unsettled and one bounded line carries the
   system's code — never the command, its output, a stack or a path. The
   `seams` parameter is how the Windows branch is driven in a test without a
   real process anywhere.
3. *Restart-unique durable identity.* `ver_<uuid>` (40 characters, inside the
   protocol's 64 and the store's 80-character idempotency key), minted per run
   and stable for its row, state, report and key.
4. *Detached work still protects retirement.* `VerificationService.unsettledWork()`
   reports what this worker still owes by owning path;
   `WorkerLifetime.safety()` adds a `task` pin row for any such path no loaded
   runtime already accounts for, and `retire()` re-reads it **under the fence,
   after accepted handlers drain**. Nothing is published to say it, so a
   closed path is never resurrected; a loaded session keeps its own pins
   exactly as before, and a fork is still the other case entirely.
5. *Diagnostics cannot own settlement.* The bounded log line goes through a
   guard of its own, and `settleHeld` marks the run finished and prunes
   whatever the observer or its diagnostic did. No external delivery is
   promised when the observer throws — only this worker's own state and bound.

**UI, the smallest truthful projection.** `VerificationPanel`'s Stop is
disabled while `run.stopping` is true or the phase is `reporting`, and says
which of the two is happening. No other verification surface is touched.

### Evidence (correction batch)

| Command | Result |
| --- | --- |
| `pnpm install --frozen-lockfile`, `pnpm -r build` | ok, all packages built |
| worker: `vitest run test/project-work test/session-safety.test.ts test/session-unload.test.ts test/session-retire.test.ts test/server.test.ts test/process-guards.test.ts` | 196 passed (11 files) |
| protocol: `vitest run test/project-work-verification.test.ts` | 19 passed, no type errors |
| host: `vitest run test/project-work/verification-run-identity.test.ts test/router.move.test.ts test/session-move.test.ts test/session-route-lease.test.ts` | 40 passed |
| ui: `vitest run test/project-work/verification.test.tsx test/project-work/native-acceptance.test.tsx test/project-work/proof-reader.test.tsx test/project-work/verification-stop.test.tsx` | 56 passed |
| `typecheck` (worker, ui, host, protocol), `pnpm identity:check` | clean |

Each correction was checked against the unfixed source before it was kept: the
retirement test fails with the `detachedWork` line removed, the
publisher-plus-logger test throws out of `settleHeld` without its guards, and
the Stop test finds an enabled button without the panel change.

**Limits.** The full worker/host/UI/monorepo suites and `pnpm verify` are the
parent's gate, not this session's. Browser acceptance remains the person's
(D-342). The durable-identity regression is proved on both sides — the worker
mints ids that cannot repeat across a restarted module registry, and the host
test shows what a repeated key really does to the record — but no test starts
two real worker processes.

## The parent's two follow-up holes, as implemented

The same approved batch, finished by a second owner on a tree that merges the
whole of `13514908` (and therefore `33d3163e` and `59468295`) into the parent.
The contract is the *Parent follow-up* section of
[`m21-verification-runtime-corrections.md`](m21-verification-runtime-corrections.md).

**Claim above that is superseded.** Finding 4's *"any such path no loaded
runtime already accounts for"* was read as *"any path that is not loaded"*,
which is not the same sentence. A conversation can be opened again at the
path an unexpected close just took down; the new runtime's fleet index is
empty because the detached run publishes nothing into it, so the session's own
pins said nothing was owed while a report was still being written. Safety is
now the union of a session's own pins **and** the work owed under its path,
deduplicated by the exact fleet row identities the index is holding.

1. *Owed work survives a reload.* `unsettledWork()` answers the run
   **identities** per owning path, not a count — a number cannot be
   deduplicated. `server.detachedWork()` drops every owed run that this
   worker's own task index already lists as running under that path, so a live
   session is pinned once by its own row and never twice.
   `WorkerLifetime.pinsOf()` is the one place both halves are read, and it is
   what `safety()`, `unload()`'s first check and `unload()`'s recheck inside
   the release fence all use; `retire()` still re-reads `safety()` under the
   retirement fence after accepted handlers drain. Nothing is published,
   reopened or re-created: a detached run stays detached across a reload, so
   no row appears under a path its own conversation no longer serves, and a
   fork is still the other case entirely.
2. *Command diagnostics cannot own settlement, and the problem is visible.*
   `commands.ts` now speaks through two guarded sinks: `note` for the bounded
   log line and `raise` for a new `onProblem` callback. Both are called from
   an abort listener and from an asynchronous kill callback, where a throw had
   nobody above it and would have left as a worker-wide unhandled error with
   the run unrecorded. `COMMAND_STILL_RUNNING_PROBLEM` holds the two sentences
   — *could not be stopped … still running* and *something it started still
   has its output open* — each carrying at most the platform's own short code,
   never the command, its output, a path, a stack or an error's own words.
   `VerificationRun` publishes that sentence into its existing `problem`
   field: no phase change, no ending, no report, no release of the pin. It is
   dropped at settlement unless the ending brought a problem of its own,
   because "still waiting to close" is not true of a run that closed.
   `VerificationPanel` shows it while the run is running, with no retry — the
   run is still going and Verify… is disabled for that reason.

### Evidence (follow-up)

| Command | Result |
| --- | --- |
| `pnpm install --frozen-lockfile`, `pnpm -r build` | ok, all packages built |
| worker: `vitest run test/project-work test/session-safety.test.ts test/session-unload.test.ts test/session-retire.test.ts test/server.test.ts test/process-guards.test.ts` | 203 passed (11 files) |
| protocol: `vitest run test/project-work-verification.test.ts` | 19 passed, no type errors |
| ui: `vitest run test/project-work/verification.test.tsx test/project-work/native-acceptance.test.tsx test/project-work/proof-reader.test.tsx test/project-work/verification-stop.test.tsx` | 57 passed |
| `typecheck` (worker, ui), `pnpm identity:check`, `pnpm direction:check` | clean |

Seven new tests, each seen red against the unfixed source before it was kept:

- `verify-server.test.ts` — crash → `session/load` at the **same path** →
  `pi/worker/safety` holds one `task` pin for that conversation → `unload`
  refused → `retire explicit` and `retire automatic` refused → plan and report
  answered → nothing republished → pin gone → unload and retirement allowed.
  Red without the merge (`expected [] to have a length of 1`).
- `verify-server.test.ts` — a run this worker's own index is already pinning is
  counted exactly once. Red with the deduplication removed (`+ 2`).
- `verification.test.ts` — a stuck command's sentence reaches the run's
  visible state while the phase stays `running`, `unsettledWork()` still owes
  the path, the row is still a running one with no `error`, and the sentence is
  gone once the run really settles. Red without the `onProblem` wiring.
- `verification.test.ts` — the ending's own problem is not cleared by the live
  one.
- `verification.test.ts` × 3 — a synchronous kill refusal, the asynchronous
  Windows-shaped one, and the lingering-output timer, each with a log **and** a
  watcher that record and then throw: no `unhandledRejection` or
  `uncaughtException` escapes, the run is unsettled, and the record is still
  made from the real `close`. All three red with the sinks unguarded.
- `verification-stop.test.tsx` — the live problem is shown with no retry while
  the run is going, and stops being shown when it settles. Red without the
  panel change.

**Limits (follow-up).** Same gate boundary: no full suite and no `pnpm verify`
here. No host, protocol, store or accounting file was touched, so no host test
was re-run in this session. Termination failures and lingering output are
driven through the runner's seams with inert doubles — there is still no test
that ends a real process tree, and the reload case is proved through
`WorkerServer`'s own dispatch with a fake driver, not a real engine.
`releaseEphemeralCaches` still reads only a session's own snapshot: it decides
whether a `git status` memo is dropped, not whether a runtime or this process
goes away, and it was deliberately left alone.
