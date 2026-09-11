# M13-T98 — Premature completion and unowned worker continuation

**Severity: High — execution ownership and safe handoff failure.**
**State: unresolved release-blocking incident; mandatory regression gate for M13-T94.**
**Ownership: the continuing M13-T93/HLC-010 lifecycle owner, not a parallel implementation writer.**

## Evidence provenance and scope

This document preserves the detailed incident report supplied by the person. Its transcript observations and inspected-source explanation are recorded as reported evidence; the planning update did not reopen private transcripts, inspect live processes, restart anything, or independently identify the historical in-memory build. Source line references below belong to the inspected main/installed implementation, not necessarily the newer development checkout. Remap them by symbol and exact revision before implementing a correction.

The incident was real according to the supplied transcript evidence: Laser declared the worker completed while its engine continued processing queued instructions and editing files. Subsequent correction and interrupt requests were treated as new runs, then immediately failed because the same engine was still busy.

This was **not the original GitHub CI failure**, which had already been repaired. It prevented safe review, integration and the next release. Preserve the existing lifecycle development work; do not rebuild from scratch. A later frozen commit is not independent approval or evidence that refused correction requests were handled.

## 1. Evidence and timeline

Worker: `hlc010-admission-owner`.
Child session: `01a08d0a-9a10-70c8-b0d6-ec794e6de23d`.
All times below are UTC on September 10, 2026.

| Time | Event reported from inspected evidence |
| --- | --- |
| 22:27:38.322 | `complete_agent_run` marks `run_a5d563d6` completed, reporting frozen commit `2178d1266a9f11cc5bd856e045e1a34ec81df3ac`. |
| 22:27:38.329 | An older queued correction enters the child transcript **after completion**. |
| 22:27:38.333 | An assistant invocation reports **“This operation was aborted.”** |
| 22:27:38.335 | Another queued instruction enters the transcript. |
| 22:28:42.545 | A source edit succeeds: the worker removes the admission helper's `WeakMap` machinery. |
| 22:29:19.399 | Correction run `run_238c9586` starts and fails in the same millisecond: **“The agent's session refused the task because it was busy.”** |
| 22:29:59.739–740 | Safety request with `interrupt:true` creates `run_674a3acd`, which also immediately fails busy. |
| 22:30–22:33 | The child continues editing, testing and committing despite those failed requests. |
| 22:33:11.483 | It commits `aca859180f664d01f10d7a5d8e2a3c56033c9c09`. |
| 22:33:51.892 | Its next completion attempt returns **“This run already ended.”** |
| 22:34:02.343 | Its latest recorded response says the backend is frozen and awaiting UI authorization. |

The child advanced the checkout after the parent stopped. The development source checkpoint became `aca859180f664d01f10d7a5d8e2a3c56033c9c09`, with only `STATUS.md` and `STATUS_DETAILED.md` modified at the subsequent handoff inspection. That is the baseline before this documentation-only incident addition; it does not establish that the newest correction request was processed.

## 2. Inspected-code explanation and causal limits

The supplied report identifies the following mechanism in the inspected lifecycle implementation. Reproduce it against an identified runtime before claiming the historical loaded build is known or the current development branch is fixed.

### A. Completion publishes before execution has stopped

In `packages/worker/src/agents/harness.ts:906–920`, the inspected `completeRun()`:

1. Marks `completedByTool`.
2. Sets the session-level `abortOnTurn` flag.
3. Immediately calls `endRun()`.

`endRun()` removes the active run identity, persists terminal status and notifies the parent. It does not wait for the actual invocation to finish. Thus “completed” is published before a safe handoff boundary is established.

### B. The abort protection is one-shot, but queued work survives

At the inspected `harness.ts:406–411`, the next turn clears `abortOnTurn` and requests an asynchronous abort.

The inspected Pi implementation:

- Aborts the current engine run without clearing its queues.
- Checks for remaining queued messages in `_handlePostAgentRun()`.
- Calls `agent.continue()` when messages remain.
- Creates a fresh abort controller for a subsequent engine run.

This matches the reported sequence: one aborted invocation, immediately followed by another queued message and continued work. The one-shot protection stops one turn; it does not establish lasting ownership around continuation.

### C. Resume and interrupt consult the run record instead of execution ownership

At the inspected `harness.ts:631–684`, `sendAgentMessage()` uses `interrupt` to steer only when an active harness run exists.

After premature completion, there is no active run, so it instead:

1. Creates a new run.
2. Reports `delivery:"delivered"`.
3. Starts `kick()` asynchronously.

`kick()` attempts a bare prompt. The driver refuses because the previous engine invocation is still busy, and the new run is recorded as failed.

This explains the reported `interrupt:true` failure: it took the new-run branch rather than routing to the actual busy execution.

### D. Continued execution has no valid completion owner

The old run is terminal and attempted successors failed, yet the worker continues executing queued instructions. When it later calls `complete_agent_run`, the harness finds no active run and returns “This run already ended.”

**Root failure class:** persisted run lifecycle and real engine execution lifecycle diverge. Completion, queued continuation, admission and interruption lack one authoritative ownership boundary. Treat the exact historical loaded-build attribution as unresolved, not as a reason to waive the regression requirement.

## 3. Required fix contract

1. **Separate terminal declaration from settled completion.** Record the requested outcome first. Publish final completion only after the owning invocation releases execution ownership. Never await an invocation's own shutdown inside its completion tool; avoid self-deadlock.
2. **Own queued continuations explicitly.** A queued message stays attached to valid current ownership or transfers to a successor before execution starts. Never silently execute under a terminal run or discard accepted work to make status appear correct.
3. **Serialize admission against actual invocation lifetime.** Terminal status, `isStreaming:false` and an individual settled event are not independently sufficient proof that another invocation can enter.
4. **Make interrupt work during terminal-pending execution.** Route against the actual execution owner. Do not create a doomed new run just because its predecessor's result was published.
5. **Make delivery acknowledgements truthful.** Distinguish queued, accepted, refused and completed. Do not report delivered before admission is known. Any needed wire-contract change belongs in protocol first, with all callers and alternate drivers kept aligned.
6. **Fence every callback by session generation, run and invocation.** Late abort, error, settlement and `finally` callbacks cannot clear or mutate successor ownership.
7. **Expose contradictions rather than hiding them.** Fleet and agent map must not imply safe completion while an invocation can still write. Add structured, credential-free lifecycle diagnostics covering ownership, queue transitions, admission and terminal publication. Do not log credentials or raw private prompts/transcripts. Keep diagnostics observational, not a second owner.

Preserve the current HLC-010 implementation, pinned Pi, goals, existing goal/web policy patches and resolved lifecycle findings. This is a concrete regression and acceptance obligation within the same coupled lifecycle area, not permission for HLC-005 decomposition or a second writer.

## 4. Mandatory regression reproduction

Use the **real pinned Pi runtime**, a fake provider, temporary HOME/project/state and deterministic barriers. A passing harness mock is insufficient.

1. Start a child and queue **at least two** follow-up messages.
2. Have the child call `complete_agent_run` while both remain pending.
3. Exercise the next-turn abort and remaining-queue continuation.
4. Send both an ordinary correction and `interrupt:true` across that boundary.
5. Assert all of the following:
   - No engine or tool execution lacks an owner.
   - No premature safe-completion notification reaches the parent or visible projections.
   - No false delivered acknowledgement.
   - No overlapping invocation or duplicate successor.
   - Accepted queued messages are preserved and consumed exactly once.
   - Interrupt reaches the execution it targets.
   - A legitimate successor completes successfully rather than receiving “This run already ended.”
   - Late predecessor callbacks cannot terminate or mutate the successor.
6. Cover cancellation, close, extension-generated sends, goal continuation and background notifications across the same boundaries.

Use explicit barriers and assertions, not correctness sleeps, queue deletion, a status-label change or a timeout escape. Record exact test names/commands, source SHA and pinned runtime identity. Demonstrate the faulty behavior on an identified pre-fix build where feasible; require the complete scenario to pass on the final fixed candidate. Existing goal/custom-successor tests do not automatically satisfy this exact two-queued-message scenario.

Independent review must inspect this reproduction and the authoritative ownership path. Strong invariants and tests address the failure class; do not promise “never again” based on labels or one passing test.

## 5. Separate unfinished development defects remain blocking

The latest development checkpoint still contains the patterns identified in the refused correction brief:

- False preflight can reject completion without settling admission.
- Streaming custom-message rejection can leave admission pending.
- Error-message-keyed FIFO attribution guesses invocation identity and can retain stale associations.
- The purported false-preflight test uses the wrong fake argument signature, receiving text as options and missing the actual false-callback path.

These are additional M13-T93/HLC-010 repair requirements, **not evidence that they caused this historical installed-runtime incident**. Keep them and the two M13-T89 UI defects open independently. Fixing any one does not discharge M13-T98.

## 6. Runtime-version and packaged acceptance gate

The supplied report says the installed worker manifest is **0.3.5**, but the running project worker executable appears as **`(deleted)`** under `/proc`.

Therefore an installed manifest, files currently on disk or a newly built checkout cannot establish which code an existing process loaded. The exact historical in-memory build remains unverified.

Final acceptance must:

- Exercise the **fixed packaged worker after a controlled restart** in an isolated test environment.
- Verify and record its actual build identity, tied to the candidate source/artifact, not merely its package manifest.
- Reproduce completion/queued continuation/correction/interrupt with that worker and validate host/fleet projections.
- Preserve the session/project and no-two-workers invariants.

No restart was performed for this incident report or its planning addition. Do not stop or restart the person's live worker to satisfy the test. Any live installed-app restart must be coordinated with the person and preserve their work; prefer isolated packaged acceptance. Existing restart/generation safety rules still apply.

## 7. Evidence paths reported as inspected

These are local read-only evidence references, not permission to edit or publish private session contents.

- Parent transcript, particularly lines **242–259**:
  `/home/youssef/.local/share/lasercode/agent/sessions/2026-09-10T20-28-53-863Z_01a08d02-4ee7-70c8-b0d6-ec6920c7475e.jsonl`
- Child transcript, particularly lines **855–883, 919–931**:
  `/home/youssef/.local/share/lasercode/agent/sessions/2026-09-10T20-37-57-392Z_01a08d0a-9a10-70c8-b0d6-ec794e6de23d.jsonl`
- `/home/youssef/.local/share/lasercode/state/agent-runs.json`
- `/home/youssef/projects/laser/packages/worker/src/agents/harness.ts`
- `/home/youssef/projects/laser/packages/worker/src/drivers/stable-sdk.ts`
- `/opt/Laser/resources/app.asar.unpacked/node_modules/@lasercode/worker/dist/agents/harness.js`
- `/opt/Laser/resources/app.asar.unpacked/node_modules/@earendil-works/pi-coding-agent/dist/core/agent-session.js`
- `/opt/Laser/resources/app.asar.unpacked/node_modules/@earendil-works/pi-agent-core/dist/agent.js`
- `/tmp/laser-hlc010-pre-review-followup.md`

Related continuation evidence:

- `/tmp/laser-stabilization-handoff-2026-09-11.md`
- `/tmp/laser-hlc010-report.md`
- `/tmp/laser-ui-acceptance-report.md`

## 8. Next action and acceptance ownership

Give this report and the continuation handoff to the coding agent in the **Code** tab. Establish a single continuing lifecycle owner from the preserved `aca8591` checkpoint, after confirming prior writing has stopped. Require the exact regression above before accepting the fix; validate the current development implementation rather than assuming historical source line numbers still apply.

M13-T98 remains todo until claimed, implemented or proven satisfied by the preserved work, independently reviewed, and backed by the complete real-Pi plus identified-packaged-worker evidence. It is a mandatory dependency of M13-T94. Recording this incident does not implement a fix, authorize a live restart, reopen a frozen agent session, or change the existing release authorization.
