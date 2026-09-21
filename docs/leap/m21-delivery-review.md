# M21-T18 delivery-evidence review · independent

Reviewer: review-delivery-evidence (independent review agent). One cycle.
Scope: M21-T18 as committed in `85ee5ea4` (base `a729f9a9`) plus the parent
integration edits that touch it — the `sessionPath` closure `fbe9a300` and the
async-`ProjectWorkMethods`/router/mention integration — as present at
`408366ae` (this worktree `agents/review-delivery-evidence-061f9fae`).
Out of scope by instruction: the rest of the greenfield/design-workspace/interop
design (other owners active), full `pnpm verify`, browser runs.

Read first: `AGENTS.md`, `STATUS.md`, `docs/project-lifecycle-leap.md`
("Repository provenance" 156–207, "Execution and convergence" 467–497),
`PLAN.md` M21-T18 (line 934), `docs/leap/m21-tools-plan.md` T18 + D-357.a–j.
Primary files read in full: `packages/host/src/source-control/read.ts`,
`project-work/{delivery,captures,methods,store,schema}.ts`,
`packages/worker/src/git-actions/{git-ops,service}.ts`,
`project-work/{bridge,session,tools}.ts`, `worker/src/server.ts`
(executionShape), `protocol/src/{project-work,project-work-methods,git-actions,project-work-bridge}.ts`,
plus the T18 tests and the M20 checkpoint/retention engine the links depend on.

## Assessment

The core of the task is well built. `implemented_by` has exactly one door,
person-only, digest-validated, with the canonical capture stored **before** the
acceptance transaction (`methods.ts:830–891`, `captures.ts`); `based_on` is
best-effort and never undoes a revision; supersession appends; missing objects
are reported, never resolved to `HEAD`; changed paths come only from git and
feed T15's observed scope; schema v2 migrates both fresh (step 0 then step 1)
and existing v1 stores correctly. The T18 tests run against real git
repositories and exercise the rules a mock would assume away. The file
decomposition (`read.ts` / `delivery.ts` / `captures.ts`) is the right shape.

Three findings are contract-level blockers in the exact areas the convergence
contract depends on; the first is the one the parent flagged, confirmed and
sharpened with the M20 retention evidence below.

---

## F1 · BLOCKER — `verified_at` evidence is not durable: no capture, no write-time validation, and checkpoint commits are pruned routinely

**Contract violated.** `docs/project-lifecycle-leap.md:198–205`: "A repository
link used to approve an artifact, accept delivery or mark a Task done **must
remain reviewable**: if its Git object is not durably reachable, Laser first
stores the bounded diff manifest and required source captures in the
content-addressed store… Session checkpoint retention may then prune its ref
**without deleting the canonical evidence**." `PLAN.md:934`: "gate/done
evidence stays reviewable through bounded canonical captures after checkpoint
pruning."

**Evidence.**

- `methods.ts:921–925` (`keepEvidenceReviewable`): a state link
  (`verified_at`) with no capture is **skipped** whenever git currently has the
  commit — nothing is stored. D-357.i (`m21-tools-plan.md:262–265`) deliberately
  says "a state link has no capture… the commit must still exist, or the
  decision is refused". That covers only the *already missing* case.
- Checkpoint commits are **parentless and ref-only-reachable**:
  `worker/src/source-control/capture.ts:173` builds them with
  `commit-tree <tree> -m …` (no `-p`), published only under
  `refs/<product>/checkpoints/<session>/<turn>` (`capture.ts:177`). The T18
  fixture reproduces the same shape (`delivery.test.ts:107–118`).
- Those refs are pruned **routinely, not exceptionally**:
  `retention.ts:7–17` deletes them when the keep-list overflows, and
  `service.ts:390` calls `pruneSessionCheckpoints` **after every checkpoint
  capture**; `applyRetention` with keep 0 deletes all of them
  (`service.ts:275–279`). Once pruned, the commit is unreachable and any gc
  reclaims it (the test's `prune()` at `delivery.test.ts:127–129` shows the
  end state: commit gone, `sourceAvailable: false`).
- Nothing validates the state at write time either: the `evidence` link path
  with `verifiedAt` (`store.ts:1630–1651`) checks only repository membership.
  The store is synchronous and cannot read git, and `methods.ts:504–512`
  routes `project/work/link` straight into the store for non-delivery types —
  so a `verified_at` link can name a commit id that never existed (this is the
  "generic evidence+verifiedAt trusts the caller's checkpointId" gap T19
  confirmed).
- The existing test covers only refusal **at completion time**
  (`delivery.test.ts:657–717`). There is no test that a *completed* Task's
  `verified_at` evidence is still reviewable after pruning — because it
  would fail.

**Consequence.** A verification runs, the Task is marked done, the checkpoint
ref is pruned by routine retention (or the session closes and its refs are
deleted), gc runs — and the `verified_at` evidence is permanently gone while
the Task stays done. For `implemented_by` this cannot happen (the capture is
taken before acceptance); for `verified_at` it is the default path.

**Minimal remedy (shared with T19, no schema change).**

1. **Write-time validation** in `methods.ts` for `project/work/link` of type
   `evidence` with `verifiedAt`: the named `commitObjectId` must exist in the
   named repository (`commitExists`, `read.ts:186–200`); refuse naming it
   otherwise. This is the host-validated-at-write-time rule T19 proposes; the
   store cannot do it (it cannot spawn git), so it belongs beside
   `captureDelivery`/`acceptDelivery`.
2. **Durability**: extend the capture-before-decision rule to state links.
   `buildCapture` needs one small extension: given a state, capture the
   commit's own diff `commit^ → commit` when a parent exists; for the
   parentless checkpoint commits (the common case) record a bounded
   `ls-tree -r` manifest (path + blob oid + mode, bounded by
   `REPOSITORY_CAPTURE_FILES_MAX`, optionally with bounded sources for the
   paths of the delivered change the gate already knows). Blob oids stay
   recorded identity after gc, exactly like every other link. Attach via the
   **existing** `captureBlobId` / `attachCapture` (`store.ts:1743–1751`,
   idempotent `capture_blob_id IS NULL` guard) —
   `captureReadable`/`linkAvailability`/`repositoryStatus` already handle state
   links with captures with zero further changes.
3. **Transaction order**: `storeCapture` (quota refusal `-32011`, accepts
   nothing) **before** the evidence+link transaction that already exists
   (`store.ts:1630–1669`) — the same order delivery uses. Gate-time backfill
   keeps `attachCapture`.
4. For T19's `person_acceptance`: the acceptance must reference the **stored**
   record (evidence row's `repositoryLinkId` → link → `captureBlobId`), never
   a re-read of git at evaluation time — re-reading fails exactly when the
   contract's protection matters (see the pruned test at
   `delivery.test.ts:592–615`). Write-time validation is necessary; it is not
   the final authority, durability is.
5. Whichever shape is chosen, update D-357.i and record the deviation
   (`D-<n>`), and add the missing test: verify → done → prune → evidence still
   readable (`captureAvailable: true`).

## F2 · HIGH — a closing call attributes the *newest* open attempt, not its own session's

**Contract/acceptance violated.** Task acceptance "session-key checkpoint
isolation for simultaneous sessions"; D-357.f's intent.

**Evidence.** `store.ts:2391–2400` selects the open attempt by
`project/entity/kind/targetId … ORDER BY attempt DESC LIMIT 1` — no session
match; the closing call carries no `executionLinkId`, and `methods.ts:723–756`
(`attemptFacts`) reads that same newest open row for `startedAt`/`previous`.
With two concurrent open attempts on one Task (two sessions), each closing call
closes the **other, newer** attempt and `store.ts:2436` overwrites its
`checkpoint_key` (`COALESCE(?, checkpoint_key)` — new wins), mixing one
session's checkpoints into the other session's attempt row. Isolation holds
*inside* `attemptFacts` (refs filtered by the caller's own session key,
`delivery.ts:196–205`) but not at attribution.

**Remedy.** At close, prefer the open attempt whose `checkpoint_key` equals the
caller's derived key (`checkpointSessionKey(sessionPath)`, already computed in
`attemptFacts`); fall back to newest only when no key matches. One query
change in `store.linkExecution` plus threading the key through
`openAttemptFor`; no contract change.

## F3 · HIGH — `based_on` for an agent run's writes records the worker spawn cwd, not the run's worktree

**Contract violated.** D-357.d ("the exact commit it was on") and the leap:
"`based_on` records the code state an artifact revision was derived from" —
whose stated purpose is "this record exists to replace guesses".

**Evidence.** `methods.ts:238`: git is read in
`params.attempt?.checkout ?? caller.cwd`, and `caller.cwd` is the directory the
host spawned the worker for (`server.ts:782–801` — one worker per project).
`writeProjectArtifact` (`tools.ts:597`) calls `create`/`revise` at
`tools.ts:617/647` **without** the attempt envelope, so a Task run executing in
its own worktree records `based_on` at the **project root's `HEAD`**, while the
same session's attempt record (`session.ts:315`, `tools.ts:958`) carries the
worktree's base — two records of the same session disagree. The plumbing
already exists; the write calls simply don't send it.

**Remedy.** Attach the attempt envelope in one place:
`HostProjectWorkBridge.call` may default `attempt: attemptEnvelope(await
this.options.execution())` for `create`/`revise` when no extras were given
(`bridge.ts:151–170`). Alternatively pass it at `tools.ts:617/647`. One or two
lines; no host change.

## F4 · MEDIUM — file growth: `methods.ts` crossed 1k lines in this task

`packages/host/src/project-work/methods.ts` went 827 → 1,179 lines at
`85ee5ea4` (1,317 now with T21). The gate/delivery orchestration added here —
`get`+`repositoryStatus` (673–703), `checkoutOf`/`repositoriesOf` (705–721),
`attemptFacts` (723–771), `recordBasedOn` (773–828), `acceptDelivery`/
`captureDelivery` (830–891), `keepEvidenceReviewable` (893–932) — is delivery
policy living in the router-authority, while the modules created for exactly
this work sit one import away. Extract the block into
`project-work/delivery.ts` (or a `gate.ts` beside it) as a small object taking
`{ store, caller }`; `methods.ts` keeps only the route lines. Behavior-neutral,
and it keeps the authority scannable before T19 adds its own write-time
validation next door. `worker/project-work/tools.ts` also crossed (987 → 1,018)
by a hair; low priority.

## F5 · MEDIUM — the tools-plan "Known gap" section is stale

`m21-tools-plan.md:271–282` still says the `executionShape().sessionPath` line
is open and tells "whoever next owns `packages/worker/src/server.ts`" to add
it. `fbe9a300` closed it (via a `() => live.path` closure threaded through
`executionShape`, `server.ts:2139/2162–2172`, which is equivalent and
call-time-safe). Replace the paragraph with one line recording the closure so
T19's owner does not re-derive it.

## F6 · LOW — a supplied base commit that no longer exists silently becomes `HEAD`

`delivery.ts:176–190`: for a **new** attempt with no open record, a
caller-supplied `baseCommitObjectId` that git no longer has falls back to
`row.head`. That is the guess this record exists to replace (when an open
attempt *does* exist, the missing base is correctly kept as identity). Prefer
recording nothing for the base, or marking the record `unavailable`, over
resolving to `HEAD`.

## F7 · LOW — delivery/verification links are agent-unlinkable

`store.ts:1873–1879`: `project/work/unlink` deletes `repository_links`
unconditionally, with no person-only door and no refusal for links a completed
or approved decision rests on. Creating `implemented_by` is person-only, but
destroying it is not — an agent can erase accepted-delivery provenance,
contrary to D-332's "an agent proposes, a person decides". Minimal remedy:
person-only removal for `implemented_by`/`verified_at` links that an existing
decision names (the capture blob survives either way, which is what makes this
non-blocking).

## F8 · LOW (perf) — git reads serialized per repository and per link

`delivery.ts:137–152` and `166–171` run each repository's reads (and each
repository itself) sequentially; `methods.ts:684–694` probes availability per
link sequentially (≤100 links × ≤3 `commitExists`, `store.ts:2949–2952`). A
40-repo workspace serializes hundreds of ≤10 s-timeout subprocesses on the
link-execution and `repositoryStatus` paths. `Promise.all` per repository
(each read is independent) removes the latency without changing behavior.

## F9 · LOW (correctness, bounded) — capture sources decode blobs as UTF-8

`read.ts:249` decodes `cat-file blob` output as UTF-8 and `runGit` returns
strings (`protocol/src/git-run.ts:66–67`), so a binary file without a NUL byte
is captured as mojibake "text" and `bytes` reports the re-encoded length, not
the file's. Bounded and deterministic; sniff the raw bytes before the decode if
this surface ever becomes load-bearing.

---

## Durability / transaction requirements for the T19 integration (summary of F1)

The root contract's demand is: **accepted evidence survives pruning.** The
chain that satisfies it, in the order the code must establish it:

1. **Validate at write time** (host, which can read git): `verifiedAt` state
   exists in the named repository; refuse naming it. Store-side validation is
   impossible (`store.link` is synchronous, `store.ts:1630–1651`).
2. **Capture before the decision**: the state's bounded canonical record is
   written via `putBlob` (quota refusal `-32011` accepts nothing) **before**
   the evidence+`verified_at` transaction (`store.ts:1630–1669`), mirroring
   `acceptDelivery` (`methods.ts:849–857`). Backfill at gate time uses the
   idempotent `attachCapture` (`store.ts:1743–1751`).
3. **Evaluate from the store, never from git**: the acceptance and any later
   review read `evidence.repositoryLinkId → link → captureBlobId`
   (`repositoryStatus` + blob read already support this, `delivery.test.ts:592–615`
   shows the post-prune read path working for `implemented_by`). Re-reading
   git at evaluation is wrong precisely when retention has done its job.
4. **One writer per decision**: `person_acceptance` should extend the
   evidence-link door (as delivery extended `project/work/link`), not add a
   parallel one — the sixteen-method inventory and D-357.c's single-door rule
   both point that way.

The minimal shared extension is item 2's state-link capture: one `buildCapture`
variant, no schema change, no protocol change (`captureBlobId` is already on
`RepositoryLink`), and it is the piece both T18's gate and T19's
`person_acceptance` consume.

## Checks run

- `tsc` builds of `@lasercode/protocol`, `@lasercode/host`, `@lasercode/worker`
  at `408366ae` in this isolated worktree: pass.
- `pnpm identity:check`: pass.
- Focused suites in this worktree: host
  `test/project-work/{delivery,methods,bridge,task-engine}.test.ts` — 66/66
  pass (14 delivery tests over real git repos); worker
  `test/git-actions.test.ts` — 25/25; protocol
  `test/project-work.test.ts` + `test/project-work-methods.test.ts` — 44/44.
- An accidental full host suite run (wrong vitest filter) showed 69 failures
  concentrated in `test/pressure/e2e.test.ts` "The app could not verify the
  project runtime it started" — an environment failure of this bare worktree,
  unrelated to project-work; not counted as evidence either way.

## Unverified items

- Full `pnpm verify` is **not** claimed green here (parent reported a
  CLI daemon-policy timeout at `408366ae`; not reproduced or cleared in this
  worktree).
- F1's failure end-state (done Task, pruned `verified_at`, evidence gone) is
  established by code reading + the existing prune/gc fixture, not by a new
  fixture run — writing one was out of this review's permitted writes.
- F2's cross-session close contamination is established by reading the query
  and update; no test exercises two simultaneous sessions (no such test exists
  in the suite).
- UI consumption of `repositoryStatus`/`display`/`linkRef` shapes (out of
  scope; other owners).
