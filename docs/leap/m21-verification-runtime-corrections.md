# M21-T19 — parent corrections to runtime checkpoint 33d3163e

The checkpoint preserves the whole proof backend36e163ed and implements useful
TaskIndex/rekey/dispatch-boundary/retention/file-move seams. It is **not ready
for the first full T19 review**. Parent inspected commands.ts, run.ts,
service.ts, server.ts safetySnapshot and WorkerLifetime retirement. The
continuation message to the stopped source owner was refused, not delivered.
The next owner must preserve the entire33d3163e branch and finish this single
batch; host proof/accounting and UI writers remain separate.

1. **Actual drain, not grace-period completion.** commands.ts currently settles
   two seconds after child `exit` even if inherited stdout/stderr remains open.
   That can publish Passed/release the task pin with descendant output still
   live, contrary to D-364. Its still-attached data listeners can then update a
   finalized hash. A timer may request owned-tree cleanup or expose a waiting
   problem; it cannot substitute for actual child/stdio closure. Keep the run
   unsettled until actual close; finalize byte count/digest/tail once, detach
   safely. Use an inert child/stdio double: exit → advance beyond grace → late
   output → close. No report/pin release before close, late bytes included.
2. **Observe Windows termination failure.** taskkill's callback currently
   discards every error. Observe asynchronous failure (and synchronous throw)
   through supported owned-tree facilities/seams. Do not invent exit, report
   content-free diagnostics and an honest live problem, and retain safety.
   Tests are injected doubles, never platform process probes.
3. **Restart-unique durable identity.** run.ts's module counter restarts at
   ver_0001, while verify-ver_0001 is a project-wide durable idempotency key.
   Use a restart-unique per-run id within the existing 64-character schema
   (UUID is suitable), stable for that run/report. Prove fresh worker/run
   instances cannot collide with a previous durable host receipt, not merely
   that two sequential runs in one module have different counters.
4. **Detached work still protects worker retirement.** Unexpected driver close
   stops/detaches verification and removes the runtime/TaskIndex row, while
   command draining/report settlement can remain private and unfinished.
   Retirement currently reads runtimes, so that private work needs a canonical
   worker-level busy guard until settlement, without republishing a dead path.
   Recheck under the retirement fence after accepted handlers drain, not merely
   before calling the asynchronous retirement operation.
   Prove retirement refuses after unexpected closure while drain/report is
   held, then succeeds after actual completion; same-Live rekey remains distinct.
5. **Diagnostics cannot own settlement.** service.publish catches a throwing
   publisher but calls the injected logger unguarded. If the logger throws,
   settleHeld can reject the floated .then chain and skip retention. Protect
   the diagnostic observer too. Test publisher+logger failures together with
   no unhandled rejection and bounded finished-run retention; do not promise
   external row delivery when its observer throws.

Preserve D-364's exact pre-/post-report dispatch semantics, genuine report
write failures, held-versus-cancelled distinction, source ancestry and current
passing tests. No longer claim timer-based completion is actual drain. One
first full independent T19 review follows this batch plus the settled proof
consumer and quota repair; no second runtime planning round is required.

## Implemented

Both branches were merged whole into one parent-based tree first (`33d3163e`,
then `59468295`); no cherry-pick, rewrite or deletion, and no file of the proof
consumer, the quota owner or the parent's uncommitted work was touched.

| # | What the source does now | Where |
| --- | --- | --- |
| 1 | A record is made on the child's `close` and nowhere else. The post-`exit` timer asks the owned tree to be cleaned up once and logs one content-free waiting line; it settles nothing, so a run whose output never closes stays unsettled and pinned. Bytes/digest/tail are finalized once and the output and abort listeners are detached with the record, so late bytes are kept before it and cannot change it after | `worker/src/project-work/verification/commands.ts` |
| 2 | `killVerificationTree(child, onProblem, seams)` reports the Windows `taskkill` failure its callback used to discard, and still throws on a synchronous POSIX refusal; `ESRCH` stays "already gone". A failed kill invents no exit: unsettled state, live problem, one bounded line carrying a system code only | same file |
| 3 | `ver_<uuid>` per run — restart-unique, stable for the row, state, report and `verify-<runId>` key, inside the 64/80-character limits | `worker/src/project-work/verification/run.ts` |
| 4 | `VerificationService.unsettledWork()` → `WorkerLifetime.detachedWork` → a `task` pin row for any owed path no loaded runtime accounts for, re-read **under the retirement fence after accepted handlers drain**. Nothing is published to say it; a loaded session's own pins and the fork path are unchanged | `verification/service.ts`, `worker/src/worker-lifetime.ts`, `worker/src/server.ts` |
| 5 | The bounded diagnostic is itself guarded, and `settleHeld` marks the run finished and prunes whatever the row observer or its logger did. No external delivery is promised when an observer throws | `verification/service.ts` |
| UI | Stop is disabled while `run.stopping` or the `reporting` phase holds, reading *Stopping…* / *Saving results…* from the same state, so no cancellation is offered that cannot happen | `ui/src/components/project-work/VerificationPanel.tsx` |

Tests: `worker/test/project-work/verification.test.ts` (drain without a timer,
finalize-once, Windows kill failure through both seams, restart-unique ids
against a receipt-keeping host double, publisher + logger both throwing with no
unhandled rejection and retention still at 20),
`worker/test/project-work/verify-server.test.ts` (unexpected driver close →
retirement refuses while the drain/report is held → settles privately with no
row under the dead path → retirement allowed; fork stays the other case),
`host/test/project-work/verification-run-identity.test.ts` (new file: a spent
key answers with the first run's receipt and the second run's record is never
written), `ui/test/project-work/verification-stop.test.tsx` (new file). Every
one was seen to fail against the unfixed source.

Evidence and the honest limits are in
[`m21-verification-command-plan.md`](m21-verification-command-plan.md) § *The
parent's correction batch, as implemented*. The first full independent T19
review is still unused.

## Parent follow-up to13514908

The actual-close, restart-unique-id, service observer-guard and Stop-button
corrections are now implemented; whole runtime/proof ancestry is preserved in
8dbbad75 → ae93fd82 →13514908. Two remaining holes need a bounded follow-up
before the full review (continuation to the stopped owner was refused):

- A same-path reload after unexpected closure makes the private run invisible
  again: WorkerLifetime.safety skips extra owed work when the path is already
  listed, while the new Live's safetySnapshot sees only its empty TaskIndex.
  Include canonical unsettled verification in safety even for loaded/reloaded
  paths, correctly deduplicating actual task identities/counts. Prove crash →
  reload same path → held drain/report → unload and retirement refused → actual
  settlement → allowed, without publishing a task under a dead path.
- commands.ts still invokes its diagnostic logger unguarded in cannotEnd and
  the lingering-output timer; a throwing sink can escape an abort or async
  taskkill callback. Guard these diagnostics too. The promised live failure
  explanation must reach VerificationRun's visible problem, not just stderr:
  a bounded, safe callback may report that the command could not be stopped
  and is still waiting to close. It must not settle/unpin, leak output or let
  a throwing observer control the runner. Test sync/async termination failures,
  throwing sinks and retained safety.

No host/accounting/proof-consumer changes are needed. This finishes the same
approved D-364 correction batch; do not start another design or framework.
