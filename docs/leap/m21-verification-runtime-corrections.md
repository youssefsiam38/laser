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
