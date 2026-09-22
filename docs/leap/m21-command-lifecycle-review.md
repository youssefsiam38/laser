# M21-T10/T13 second review — the host register follows a fork, and a Stop tells the truth

Single narrow review of the *new* cross-layer Command lifecycle additions on top
of the already-approved work. Scope: the delta from the approved ownership
branch (`e92e6392`, its worker rekey correction `7b814e1f`/`d7213b26`, both
already inspected by the parent) to the target
`agents/finish-preserved-command-lifecycle-12c41b75` @ `0cd96a9a` — i.e. the
preserved WIP `641288f9` plus `0cd96a9a` (`TaskRegister.rekeySession`, the
router's canonical rekey hook, and truthful Stop). Excluded by instruction:
the already-approved index-ownership feature, the worker rekey correction, and
all transcript/SDK/planning changes. Reviewed in an isolated worktree that
merged the whole target before any test ran; no source, test or planning file
was changed.

**Verdict: approve.** No structural regression, no missed simplification, no
unjustified file growth, no spaghetti. The two behaviours are end-to-end and
each is proved from the seam a person's action really travels: a real `Router`
for the host move, a real `WorkerServer` for the worker's truthful Stop. One
low finding (a dense winner expression) is a legibility nit, not a blocker.

## What the delta is

### A. The host's `TaskRegister.rekeySession` and its call site

`packages/host/src/tasks/register.ts` gains `rekeySession(oldPath, newPath)`;
`packages/host/src/router.ts` gains one line — `this.deps.tasks?.rekeySession(path, moved)` —
right after `this.pool.rekeySession(path, moved, owner)`, *inside* the RP-4c
route lease, where `moved` is the validated answer's `state.path !== path`.
That is the correct and only place: no move is inferred from a display name, a
project, or a task update; the optional register lets a register-less host
still fork. Confirmed by reading rather than by the comment: the hook is at
`router.ts:1752-1761`, inside `this.route(path, async () => {...})`
(`router.ts:1727`), and `moved` is `answer.state.path` compared to `path`
(`router.ts:1739`).

The migration is right:

- The old bucket is deleted, not copied (`this.bySession.delete(oldPath)`), so
  `list(oldPath)` answers nothing and the global list keeps one row per id.
- Both active and finished rows move; `logPath`/`logSegments` (the private
  output metadata) survive whichever record wins, via
  `existing?.logPath ?? held.logPath` — and a `list`/broadcast carries only the
  public task (JSON assertion in the test proves no path leaks).
- Byte accounting is recomputed in UTF-8 for whatever is kept
  (`Buffer.byteLength`, not `JSON.stringify(...).length`), and `prune` /
  `pruneSessions` run against the destination path, so the per-session bound
  and the register bound apply where the rows now live.
- Destination-wins is an ordering fact, and it is the real one: the worker
  re-keys its own structures and (for a running design build) republishes under
  the new path *before* it answers the fork, and notifications and the reply
  travel the same ordered connection (`host/src/server.ts:1246` consumes
  `pi/extension/message` against `params.path`), so anything already filed at
  the new path was published after everything at the old one. The fork handler
  at `worker/src/server.ts:774` runs `rekeySessionState` before it returns the
  answer — verified in code, not assumed.
- The "a finished command never goes back to running" rule is kept as a
  *guard*, not as a precedence: one ordered stream cannot produce a
  terminal-then-running sequence for the same command id, because the
  workspace's `isRunning` is `settled === undefined` and a terminal row is
  published once; the worker's shell-task index likewise cannot re-emit running
  for a settled command. I checked this against the actual state transitions
  rather than the comment, and it holds — the guard is defensive dead code
  whose test fabricates the ordering directly on the register, which is the
  right way to test an unreachable-in-practice branch.
- Closing the file the conversation *left* does not end the command that moved:
  `sessionClosed(oldPath)` is a no-op because the rows are gone; `workerLost`
  at the path the worker reports (the rekeyed one) still ends it. Proved in
  `register.test.ts` ("does not end a moved command when the file it came from
  is closed").

### B. Truthful Stop (`worker/src/design/index/command.ts`)

`stopped` was decided once, in the file loop; a Stop accepted anywhere else —
above all during `describing`, the build's one long await — was forgotten.
`stopped` is now *asked, never remembered*: `aborted()` is a function reading
`options.signal` at the pre-scan point, in the loop, after synthesis, and once
more after the write (the last synchronous-run boundary before the outcome
exists). A write failure throws before that last check, so a Stop never hides
a failure; a Stop after settlement changes nothing.

`DesignBuildResult.stoppedBy` (`"person" | "budget"`) reaches the workspace's
one `Settled` value (`workspace.ts:300-301`), and `stoppedReason`
(`workspace.ts:121`) gives three sentences — "you stopped it", "it reached its
budget before the end", and the fallback "it ended before the end" — so a
budget-stopped build never accuses the person, and an engine that said nothing
is not guessed into their words. Person wins over budget when both apply.

## Validation, reproduced in this worktree

Frozen install, clean recursive build, then `env -i PATH="$PATH" HOME="$HOME"`,
one suite at a time:

| Command | Result | Claim |
| --- | --- | --- |
| `pnpm -F @lasercode/host exec vitest run test/tasks test/session-route-lease.test.ts test/router.test.ts test/router.design.test.ts test/router.move.test.ts` | **115 passed** (7 files) | matches |
| `pnpm -F @lasercode/worker exec vitest run test/design` | **241 passed** (17 files) | matches |
| `pnpm -F @lasercode/worker exec vitest run test/session-safety.test.ts test/agents/tasks.test.ts test/session-unload.test.ts test/session-retire.test.ts test/server.test.ts` | **94 passed** (5 files) | matches |
| `pnpm -F @lasercode/host typecheck`, `pnpm -F @lasercode/worker typecheck`, `pnpm identity:check` | clean | matches |

Also run and green: `test/design/command.test.ts` (14), `test/design/workspace.test.ts` (27),
`test/design/index-command-rekey.test.ts` (6), `test/session-safety.test.ts` (6),
`test/agents/tasks.test.ts` (10) — 63 passing across the exact target files.

The red-before/red-after claims were not re-run (reproducing them needs
checking out the pre-correction files, which this review is not permitted to
do). They were assessed by construction instead:

- host, at `c8baee11`: `router.ts`/`tasks/register.ts` have no `rekeySession`,
  so the five register proofs and the two router proofs would fail on
  `rekeySession is not a function` — deterministic, not load-sensitive.
- worker, at `c8baee11`: `command.ts` set `stopped` only in the loop, so a Stop
  accepted during `describing` (exactly what the rekey test does — aborts, then
  answers the model) would leave `stopped === false`, the row `completed`, and
  `expected 'completed' to be 'stopped'` — the reported bug, reproduced by
  construction from the code I read.

## Ordering and async boundaries checked (not just asserted)

- Worker `rekeySessionState` is synchronous, called inside the fork's
  `firstTurnLock.run` *before* the bounded fork answer is returned. The design
  workspace's republish and the host's `observeExtensionMessage` both happen
  before the reply travels the shared ordered transport.
- Host `rekeySession` is synchronous, no await, called inside the lease after
  `pool.rekeySession`. `notify` precedes `prune`, matching `upsert`'s order.
- `router.ts:1771-1785` hoists `forked` out of the lease for catalog/view
  invalidation — presentation only, no authority — as before.
- Reentrancy: the register is a per-host object mutated without async
  interleaving; no reentry hazard introduced.

## Acceptance items, one by one

- `hosttasks.rekeySession` at `Router.pool.rekeySession` validated moved-state
  inside request lease — confirmed at `router.ts:1752-1761` / `1727`.
- migrate active/finished held public path/private output metadata — confirmed;
  `logPath`/`logSegments` carried across the winner boundary, never broadcast.
- remove old bucket global/per-session lists — confirmed; `bySession.delete`.
- correct UTF-8 byte accounting/prune/session bounds — confirmed; mirror test.
- destination notification may arrive before fork reply, must not regress
  terminal — confirmed; `fork-rekey.test.ts` second case files at `FORKED`
  inside the stub fork handler before it answers.
- ordered connection basis attested, worker TaskIndex rekey publishes before
  answer — confirmed for design builds (republish) and consistent for shell
  tasks (the host merges on the reply's signal; any newPath-filed row predates
  the reply on one ordered stream).
- host server ~1246 observes `pi/extension/message` synchronously — confirmed.
- no old-session closing stops a moved command / no private-field broadcast —
  confirmed, tested.
- worker command abort before outcome must stop, preserve parsed index; write
  failure still fails; stop after settlement not relabelled — confirmed, tested.
- `stoppedBy` person/budget propagates to one `Settled`; budget never
  "you stopped it" — confirmed, tested.
- real `WorkerServer` fork + `pi/task/stop` test requires `stopped` / new path /
  pin cleared / no completed row — confirmed in `index-command-rekey.test.ts`
  (terminal row `stopped`, `terminalReason` "you stopped it", no row ever
  `completed`, pin gone).
- single workspace admission, immutable logical-owner address rekey, TaskIndex
  pin/unload/Stop, truthful terminal→prune→release ≤8 finished, bounded
  content-free diagnostic, other-session isolation — all preserved; spot-checked
  the diagnostic (`bridge.ts:219-236`, id + error kind only, sweep still runs)
  and the owner replacement (`bridge.ts:145`, `{ ...owner, sessionPath }`, never
  mutated).

## Sharper rules

- No new framework, no new token, no new wire schema; `stoppedBy` is a
  same-generation field addition consistent with invariant 10.
- File sizes: `register.ts` 411 (+~75), `command.ts` 330 (+~66),
  `workspace.ts` 611, `router.ts` 2118 (pre-existing sprawl, +9 here). Nothing
  crossed 1k because of this delta.
- The test seams are honest: `fork-rekey.test.ts` uses the real `Router`, real
  `SessionRouteLeases` and real `TaskRegister` with an explicitly-labelled
  worker stub; `index-command-rekey.test.ts` is the real `WorkerServer`. No
  UI reducer is involved — and there is no UI change to review in this delta.

## Findings

### F1 · low — the winner expression is denser than the rule it encodes

`packages/host/src/tasks/register.ts`:
`existing !== undefined && !(existing.task.status === "running" && held.task.status !== "running") ? existing : held`.
The intended rule ("destination wins, except a terminal row never loses to a
running one") is readable from the double-short-circuit only after back-tracking
the negation. A two-line named decision (e.g.
`const terminalBeatsRunning = existing?.task.status === "running" && held.task.status !== "running";`
`const winner = existing === undefined || terminalBeatsRunning ? held : existing;`)
keeps the same truth table and removes the `!` inversion. Behavior-preserving
and optional; not a blocker — the guard is well-commented above and the tests
pin both directions.

## Non-findings checked explicitly

- The "old terminal beats new running" rule would be *unreachable* in the real
  ordered stream (terminal rows are published once; `isRunning` is
  `settled === undefined`), so keeping it as a defensive guard is honest, and
  the comment says so. The test that exercises it fabricates the ordering
  directly on the register, which is the correct technique for an
  unreachable-in-practice branch.
- A budget-stopped build still runs its synthesis after the loop breaks; this
  is unchanged from the pre-correction code (`options.signal?.aborted !== true`)
  and is not a regression introduced here.
- The host's `fork-rekey.test.ts` asserts the destination-wins ordering through
  the stub's own `fork` callback, which is the same ordering a real worker
  produces — a stub at the engine boundary, not at the seam under test.

## Not proven / not covered here

- The followup doc's claim that every worker-spawning host suite fails in *any*
  worktree on launch identity is **not evidenced in the material I reviewed**
  and was not re-run (out of scope: no full suites per the review instruction).
  It does not affect this delta: none of the changed paths is covered by a
  worker-spawning suite — `test/tasks`, `register.test.ts` and
  `fork-rekey.test.ts` all pass without a real worker, and the rekey test
  explicitly labels its worker stub.
- Red-before counts (host 7, worker 5 + the `completed → stopped` rekey
  failure) were assessed by construction, not re-executed — see above.
- Visual acceptance of the fleet row while a forked conversation's command
  moves is the person's (D-342); no UI source changed in this delta.

## Bookkeeping for the parent

- Reviewed tree: `agents/review-command-lifecycle-projections-9c98f688` @ merge
  commit `1ec9d3ed` (= `3a45e494` ⊕ `0cd96a9a`, fast source ancestry retained);
  the merge differs from `0cd96a9a` only in `STATUS.md`/`STATUS_DETAILED.md`
  (the parent's newer rows carried forward), so the planning files need
  regenerating after integration as usual.
- The only new file is this review document; no source, test or planning file
  was changed.