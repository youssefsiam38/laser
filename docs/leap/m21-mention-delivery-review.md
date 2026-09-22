# M21-T9/T17 mention-context delivery review · independent

Reviewer: review-exact-mention-delivery (independent review agent). One cycle.
Target: `318077ae` on `agents/finish-mention-budget-corrections-e90c1ce4`
(review worktree branch `agents/review-exact-mention-delivery-6824d974`, which
carries the target merged as merge commit `957b7100`). Feature base `446c7c99`.
Scoped deltas reviewed: the SDK seam patch `98bd11f4`, the five-consumer path
`e7ec426d`, the whole-feature merge `5b3beb7d` onto parent `d405e5d5` (merge
verified clean, `5b3beb7d` parents are `d405e5d5` + `e7ec426d`; the only
post-merge divergence in the mention area is the pre-existing
`project-work/session.ts` foundation thunk, out of scope), and the correction
commit `318077ae` itself. Unrelated parent interop/design changes excluded per
instruction.

Read first: `AGENTS.md`, `docs/project-mentions.md`, `docs/project-lifecycle-leap.md`
("Cross-session mentions and context", "Protocol and authority"),
`docs/upstream.md` (the correlation-id patch entry), `STATUS_DETAILED.md` D-362
and the M21-T9 notes, `docs/leap/m21-mention-context-followup.md` (plan rev 4 +
"Corrections after the first inspection"). Primary code read in full:
`packages/worker/src/project-work/mentions.ts`, the mention deltas of
`packages/worker/src/drivers/stable-sdk.ts`, `packages/worker/src/pending.ts`,
the five send routes and `queueIntoChild`/`promptRequest`/`promptWithFence` in
`packages/worker/src/server.ts`, the mention additions of
`packages/host/src/router.ts`, the `context` hook in
`packages/pi-extension/src/modules/project-work.ts`, the protocol schema/type
additions, `packages/ui/src/runtime/adapter.ts`, and the full patch hunks for
`agent-session.js`/`agent-session.d.ts`/`session-manager.js`. Tests read in
full: the three live files, `project-work/mentions.test.ts`,
`server.mentions.test.ts`, the pending/host/extension mention additions.

## Validation performed in this worktree

```
git merge 318077ae                       # 957b7100, no conflicts
pnpm install --frozen-lockfile && pnpm -r build
pnpm -F @lasercode/worker exec vitest run \
  test/project-work/mentions.test.ts test/server.mentions.test.ts test/pending.test.ts \
  test/pi-correlation-seam.live.test.ts test/mention-context.live.test.ts \
  test/mention-context-lifecycle.live.test.ts      # 6 files, 67 passed
pnpm -F @lasercode/worker test                     # 1682 passed, 4 skipped (137 files)
pnpm -F @lasercode/worker typecheck                # clean
pnpm identity:check                                # clean
pnpm -F @lasercode/host exec vitest run test/project-work/mentions.test.ts   # 25 passed
pnpm -F @lasercode/pi-extension exec vitest run test/project-work.test.ts    # 14 passed
```

D-362's original acceptance gaps (real compaction, real held-settle fallback)
are now closed by real evidence: the new lifecycle test drives threshold
compaction through reported usage against the real pinned engine and asserts
the orphan block appears at the end of every post-cut call, labelled, with the
summary request carrying no projection; the fallback test moves the turn A→B
and asserts the retry carries the same block beside the same message. The 300 ms
summary delay and the post-turn 100/50 ms waits are genuine completion
synchronisation on real engine events (bounded `waitFor` on
`compaction_start`), not `blocks([])` stand-ins; the only remaining sleeps are
settle-drain bounds on deterministic engine events, which is reasonable. The
deliberate stub loopback is the documented harness; no artificial empty-proof
is presented as engine behaviour.

Two mutation probes were run and reverted (`test/zz-review-probe.test.ts`,
removed; tree clean at `957b7100`):

- **Wire leak probe (negative, clean).** With a carrier attached and a mention
  sent, the full subscribed driver event stream contains no `lmc-` id and the
  `message_start`/`message_end` frames carry none. `mapEvent`
  (`stable-sdk.ts:2469–2545`) projects `role`/`speaker`/`stopReason`/`usage`
  and never the message's id, so the projection-bearing path's identity layer
  does not leak onto the wire.
- **Wire leak probe (positive, real).** The driver's `message_end` frame
  carries `update.message.correlationId` (a live-engine observation reproduced
  in this worktree: `{"kind":"message_end","message":{"role":"user",…,
  "correlationId":"lmc-28466ba1cd7268d371"}}`). It is not a **leak** in the
  D-362 sense (no id reaches a provider body, a session file, the entry
  projection or a host-served read; every one of those is asserted in the
  live suites), but it is an avoidable channel: it reaches any
  `session/update` subscriber, including the phone relay, which the same
  reviewer posture treats as untrusted. Cheap fix for the parent's batch, in
  the driver, at the hold: in `flushHeldUserEnd`
  (`stable-sdk.ts:2016–2044`), push the frame with the id stripped from
  `held.update.message` — the copy semantics already shipped in the pinned
  patch make the one-line variant a mirror of `appendMessage`. Do not change
  the seam or the live-message identity. Until then: wire-only, no persistence,
  provider, relay-crypto or search exposure; the seam test and the
  session-file assertions all stay green.

A third behaviour probe was run read-only against the built carrier:
an orphan block's `afterIndex` points at the **last message of the list**
(`messages.length - 1`), not at the orphan's insertion point, and the context
hook clamps `afterIndex + 1` to `next.length` before splicing. So an orphan
block lands at the end of the window as designed — including in the
tied-orphan case below. No off-by-one.

---

## Assessment

The seam and the carrier are the right architecture, and this revision fixed
the real defects the parent's first inspection found. The identity contract is
honest: one opaque worker-minted id minted before the engine is asked, carried
by the engine on the message it creates, stripped from the persisted copy, and
used for association at exactly two boundaries (`message_start` and the
`context` transform). No text/FIFO/depth inference remains anywhere in the
path. The carrier is genuinely read-only: no bridge, no host call, no
project resolution, no cwd change, and the projectless route is proven by a
live test (`mention-context.live.test.ts:264–277`). Host-side, `sendWithMentions`
drops any client-supplied `projectWork` before validation and rebuilds the
projection from the store for all five methods, and the schema keeps the field
host-forwardable while the host never trusts it. Authority is unchanged: a
mention projection grants no tool, no project, no cwd and no write; the
overflow wording names no tool (`renderKeysOnly`, `mentions.ts:296–320`), and
the refusal is enforced at the slot itself (`reserve`, `mentions.ts:110–125`),
not only at the friendly early check.

The four correction claims inspect as real, not cosmetic:

- **C1 (byte ceiling, reserve-then-upgrade)** is in `blocks()`
  (`mentions.ts:220–285`): per-message share `floor(24 000 / max(active,16))`,
  summary-first, oldest-first whole-message upgrades, `clampBytes` walking back
  UTF-8 continuation bytes. The worst-case test (16 messages × 8 projections ×
  multi-byte titles/excerpts) asserts the total is ≤ 24 000 bytes **and** that
  the ceiling is actually used (> 70%), so it cannot pass timidly.
- **C2 (atomic reservation)** is at the mutation (`reserve()` throws
  `SessionBusy`), with the server-side two-sends race test
  (`server.mentions.test.ts:261–297`) and a carrier test
  (`mentions.test.ts:190–213`) failing without it.
- **C3 (no tool in the recovery line)** is in `renderKeysOnly`, and the
  dedicated test asserts neither `inspect_project_work` nor the word "tool"
  appears.
- **C4 (all pre-engine exits give the slot back)** is the `dropUnlessAccepted`
  guard around the goal-command activation/preflight loop plus the
  `onInvocation` guard that also releases the fence; the two live tests
  (`mention-context-lifecycle.live.test.ts:343–424`) exercise both exits
  against the real engine and assert the next real send still works.

The original debug artifacts (`async steer(...) { this.note("steer", …) }` and
the `console.error("SENT", …)` line) present in the correction branch are
gone at `318077ae`; the driver's `steer`/`followUp` are the real engine calls
and the server tests are real paths.

File-size and layer discipline hold: `mentions.ts` is a new, focused 349-line
module; `pending.ts` grew to 280; the mention additions to `stable-sdk.ts` and
`server.ts` are proportional and live in the layers that own sends. No file
crosses the 1k threshold because of this work (the two large files were already
above it). Protocol additions are additive and typed; the single wire-schema
cast (`custom` mention block spliced as `as unknown as`) is local to the
extension hook and matches Pi's untyped message union.

One finding survives (F1), and it is small, mechanical, and fixable in the
parent's one triage batch without touching the seam or the carrier.

---

## F1 · MINOR — the worker's `message_end` frame puts the correlation id on the wire

- **Where:** `packages/worker/src/drivers/stable-sdk.ts:2016–2044`
  (`flushHeldUserEnd`), fed from `onSessionEvent`'s held
  `message_end` at `stable-sdk.ts:1856–1873`; wire shape
  `packages/protocol/src/messages.ts:539–560`.
- **Consequence:** the live-engine frame is
  `update.message.correlationId = "lmc-…"`. Every subscriber of
  `session/update` — the desktop UI, and through the relay any paired phone —
  receives the worker-minted id in the transcript-frame payload. It is not
  persisted anywhere (the patch strips the stored copy; the live suites assert
  the session file, the provider body, the entry projection and the search
  index are all id-free), so the hard D-362 lines are intact. But the wire is
  the one surface the contract never needed the id on, and the relay is an
  untrusted forwarder. Treat it as unnecessary exposure, not a breach.
- **Evidence:** the positive probe above (run in this worktree against the
  real engine, then removed). The negative probe shows `mapEvent` itself never
  invents the field — it rides in `update.message` only because the held frame
  forwards Pi's message object verbatim.
- **Remedy:** in `flushHeldUserEnd`, push the frame with the id removed from
  the copy of `held.update.message` (one destructure, mirroring the patched
  `appendMessage`), or omit `message` for user frames that already carry the
  entry identity. Alternatively strip it in `mapEvent`'s `message_end` arm for
  every role. No seam change, no carrier change, no test-contract change; the
  existing assertions stay green and a one-line wire assertion
  (`expect(frame.update.message.correlationId).toBeUndefined()`) would pin it.

Nothing else blocks. The remaining notes are non-blocking observations for the
parent's triage, not defects:

- **All-tied orphan case** (`mentions.ts:245–258`): when every active message
  is orphaned, all blocks are end-anchored at `messages.length - 1` and the
  hook inserts them descending by `afterIndex`, so they arrive in envelope
  order (oldest first) at the tail. Deterministic and labelled; acceptable as
  shipped, worth a sentence in the plan if the model ever needs a stronger
  order there.
- **Unprojected-queue dedup window** (`pending.ts:155–175`): a `steer` row is
  removed from the tray before its engine call and its projections deleted
  after the call resolves. Two byte-identical rows steered in the same
  overlap window are disambiguated by their own correlation ids, so no
  projection can be claimed by the wrong message; the only cost of the window
  is that a refusal between removal and deletion would leave the row gone from
  the tray (it returns as `failed`, which is the pre-existing semantics).
  No change requested.
- **`isPendingDirect` lifetime** (`mentions.ts:152–160`): a direct message the
  engine answered as an extension command discards its envelope only in the
  driver's `finally`. A `clearQueue()` racing that window does not touch it
  (`dropQueued` skips `lane === "direct"`), so there is no leak or wrong-drop;
  noting the invariant so it survives refactors.
- **Merge hygiene:** `5b3beb7d` merged the whole feature branch with no
  conflicts and preserved `98bd11f4`/`e7ec426d` verbatim; the only
  post-merge source delta in the mention area is the out-of-scope foundation
  thunk in `project-work/session.ts`. `d405e5d5`'s UTF-8 interop fix and the
  rest of the parent's changes are untouched by this review per instruction.

## Approval bar

Not met for unconditional approval, solely because of F1 — an exposure the
contract does not need, on a surface that is one `session/update` subscriber
away from the phone. Everything else the D-362 acceptance named — the seam,
the five routes, the carrier bounds, the cleanup exits, the lifecycle evidence
— is in place and demonstrated against the real engine. With F1's one-line
driver fix (plus its wire assertion), this reviewer would approve the whole
scope as-is.
