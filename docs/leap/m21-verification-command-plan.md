# M21-T19 · the verification run's Command lifetime — investigation and plan

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
