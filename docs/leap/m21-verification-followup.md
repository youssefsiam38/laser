# M21-T19 · verification repairs (batch 1: Fleet Command, convergence, deviations)

Follow-up to [`m21-tools-plan.md`](m21-tools-plan.md) § M21-T19. Three
acceptance gaps were found in review; this file records what was repaired, what
was deliberately left, and the one contract that is still open.

Binding text: [`../project-lifecycle-leap.md`](../project-lifecycle-leap.md)
("Execution and convergence", "Lifecycle and gates"),
[`../agents.md`](../agents.md) §6 (bounded, stoppable Commands),
[`../design-phase.md`](../design-phase.md) (D-353),
[`../../AGENTS.md`](../../AGENTS.md) and D-342.

## A · A verification run is a real Fleet Command

It was not one: the run object had the vocabulary of a Command and nothing
published it, and the plan deferred the row to another task. It now travels the
same road an index build's row travels (M21-T13), and nothing new was invented
for it.

- **The row.** `VerificationService` publishes a `BackgroundTask` through
  `publishTask`, which `server.ts` sends as a `lasercode/task/update`
  extension message — the message the worker's `TaskIndex` and the host's task
  register already fold in, and `inspect_fleet` already renders. A Project Task
  is **not** a fleet kind; what appears in the fleet is a Command row, exactly
  as a shell command's is.
- **The id.** `verificationFleetTaskId(runId) = "verify-<runId>"`, with
  `isVerificationFleetTaskId` / `verificationRunIdOf` beside it, so the row and
  its Stop find each other and can never be confused with a shell command's id
  or an index build's.
- **Stop.** `pi/task/stop` gains one branch beside T13's: a `verify-…` id is
  answered by this worker (there is no companion process behind the run), and
  an id nobody here holds answers `delivered: false` rather than silently.
  **A stop is honest immediately**: the row says `stopped` the moment a person
  asks, not when the run next notices — a run still waiting on a command's
  process or on the app's own authority was previously left saying "running"
  after it had been stopped.
- **Progress.** Published on start (forced), on every phase change, and at most
  every `VERIFICATION_ROW_INTERVAL_MS` (250 ms) otherwise. `activity` is the
  run's own line — the command being run and how many there are — and
  `outputBytes` is 0: the commands' bytes live in the report, and the row never
  pretends to be a log.

### Session ownership: there are no invisible runs

A Command nobody can see in the fleet is a Command nobody can stop, so every
run belongs to a conversation and `VerificationRunState.sessionPath` is
required rather than optional.

| Start | The conversation | If there is none |
| --- | --- | --- |
| `verify_project_task` | the session the tool call ran in, taken from the worker (`live.path`), never from the model | the tool refuses with `no_session_identity` |
| `pi/project/verify/start` | `sessionPath`, checked against the sessions this worker is **actually holding** | refused with `VERIFICATION_NEEDS_SESSION`, which names Start… |

The Task detail picks the conversation the Task is already being worked on in —
its newest attempt this window still has a session for, preferring one that is
still running — and when there is none it disables Verify and hands the person
to **Start…**, the existing act that joins a Task to a conversation. Nothing
invents a session, and no run starts without a row.

**Bug found while wiring this:** a person-started run had no conversation's
bridge behind it and therefore had never learnt its project, so it failed
immediately with "this session is not working in a project". A run now resolves
the project the way a session does — one `project/work/list { cwd }`, the
host's answer — and a folder this app keeps no work for is a sentence rather
than a crash.

## C · A missing command binding is not an exemption

`convergenceOf` counted only what the run **could** decide
(`machineDecidable`), so a required criterion an authority declared
machine-verifiable, with no command bound to it, was dropped from the count and
a Task could converge on criteria nothing had checked.

`mustBeProven(criterion)` is now the rule convergence uses: `required &&
(machineVerifiable || kind === "review")` — **whether or not a command was ever
bound**. `machineDecidable` stays, and means only "this run has a way to decide
it"; it routes the evaluation and no longer decides what has to hold. A
criterion that declares itself checkable and binds no command is reported as
unproven, blocks, and says so in the report: *"…says it can be checked by a
command, and none is bound to it, so nothing proved it."* A required criterion
with no finding at all still blocks as "never checked".

What an authority declared a person's — a visual check, a browser matrix, a
design state, a boundary — is `machineVerifiable: false` and does **not** block:
`needs_review` is precisely the state that hands those to a person.

## D · Deviations

The model tool can already persist one: `deviation_reason` +
`deviation_upstream_key` + `deviation_proposal`, resolved through the bridge to
the upstream's **exact `revisionId` and `digest`**, stored by the host as
`state: "proposed"` whatever the caller sent. That path is now covered by a
test rather than only by the evaluation fixture. No typed body input was added:
accepting a proposal is the ordinary `project/work/revise` a person sends, and
a whole proposed body on the tool would be an enhancement rather than this
milestone.

## B · Native proof — still open, and not pretended otherwise

**There is no explicit preview-acceptance record in this codebase today.**
`person_acceptance` is a declared `EvidenceKind` that nothing writes, and the
`verified_at` write path (`store.ts`, M21-T18) validates no checkpoint at all:
any person-origin call with any `checkpointId` string is accepted. The approved
contract (**N2**) is a host-validated acceptance written at the moment a person
confirms:

1. the link's subject **revision and digest** equal the criterion's, so a
   preview accepted against an older Design revision proves nothing about a
   newer one;
2. the checkpoint ref is one git really holds, resolving to the recorded
   commit;
3. a joined `person_acceptance` record carries the confirmation;
4. and — because the root requires accepted evidence to survive pruning — the
   proof is kept by a **durable canonical capture**, so a checkpoint
   disappearing later does not invalidate what was already accepted.

(4) is the shared durability and transaction contract the M21-T18 owner is
finishing; capture and storage are deliberately **not** touched here, so that
one owner writes them. Until it lands, `acceptedPreview()` checks the relation,
the person who made the link and the presence of a checkpoint id, and its
documentation says plainly that this is not yet the authoritative test. The
exact N2 plan follows once that contract arrives.

## Batch 2 · durable native proof (D-361) and the T18 review set

### B · N2, as approved

`verifiedAt.acceptance: { kind: "checkpoint_preview" }` is an **explicit
request for a person's action**, never the proof of one. What the host does
with it, through the one existing evidence-link door:

1. **Only a person may ask.** The actor kind is the host's, from the
   connection; an agent's ask is refused with what to do instead.
2. **The subject is the authority's current revision.** The link's subject
   revision and digest must be the ones the store holds for that entity now, so
   a preview accepted against a revision the work has moved past cannot be
   inherited by the revision that replaced it.
3. **The checkpoint is proved, not asserted.** `state.checkpointId` must be a
   ref `listCheckpointRefs` really returns, **and it must resolve to
   `state.commitObjectId`**. That the commit exists is explicitly not the
   test — a commit id can be borrowed from anywhere in the repository.
4. **The capture is stored before the transaction.** A quota refusal
   (`-32011`) accepts nothing: there is no accepted preview whose evidence was
   never kept.
5. **The host writes its own record.** `RepositoryLink.acceptance` holds the
   ref it found, the commit that ref pointed at, the subject digest, who
   accepted and when. A request body cannot mint that field, which is what
   makes it proof.

**Every** `verified_at` write is now validated and captured, not only the ones
asking for acceptance: a state link naming a commit nobody ever had, or one
whose checkpoint has been pruned, would otherwise sit in the record looking
exactly like proof. This supersedes D-357.i's implementation-only "a state link
has no capture" claim, per D-361; the formal ledger is the parent's.

**Capture shape.** `RepositoryCapture` is a discriminated union — exactly one
of `change` and `state`, never both and never neither. A parented commit is
captured as its own `commit^ → commit` difference; a **parentless** M20
checkpoint (the normal case) as a bounded `ls-tree -r` manifest carrying path,
**mode and blob object id** — identity that stays true after gc — plus the
sources the budget allows, required paths first. A required source that cannot
be kept whole **refuses the acceptance** rather than storing a truncated
placeholder and calling it durable proof.

**Evaluation reads the store, never git.** `acceptedPreview()` now requires
five stored facts: the `verified_at` state on this exact subject revision and
digest, a person creator, the host's own `acceptance` record agreeing with the
link's commit and the subject digest, a capture that is present and readable,
and a joined `person_acceptance` record that passed. Re-reading git at
convergence would fail exactly when retention has done its job.

### The T18 review set

| Finding | What landed |
| --- | --- |
| **F2** | The existing query already filters kind and target, and the new test proves two runs stay two rows; the suggested newest-fallback was **not** applied. What was strengthened is the same-target case: a close is attributed by the caller's own checkpoint key or by an explicit `executionLinkId`, an identity that matches no open attempt is **refused**, and the checkpoint key became immutable (`COALESCE(checkpoint_key, ?)`) so one session's namespace can never land on another's row |
| **F3** | `HostProjectWorkBridge.call` attaches the execution envelope for `create`/`revise` in one place, so `based_on` records the run's own worktree rather than the worker's spawn root. Proved with two real checkouts at different HEADs |
| **F4** | The gate/delivery orchestration moved out of `methods.ts` into `project-work/gate.ts` as `ProjectWorkGate`, taking an explicit `{ store, caller }`; routing and the verifier transaction are unchanged. `methods.ts` 1,445 → 1,214 lines |
| **F5** | The stale "Known gap" section of the tools plan replaced with the closure that closed it |
| **F6** | A supplied base git no longer has is kept as recorded identity and the record is marked `unavailable`; it never becomes `HEAD`, and no commit list is invented for it |
| **F7** | `implemented_by` / `verified_at` are person-only to remove, and once evidence, an acceptance or an approved/completed subject names one, removal is refused: a correction supersedes, it never erases |
| **F8** | **Deferred to M21-T22, explicitly.** The serialized reads are commented as such; no unbounded `Promise.all` was added beside a correctness fix |
| **F9** | Capture decoding is strict: a blob whose decoded form does not weigh what git says it weighs (or carries a NUL) is recorded as `omitted: "binary"` with its **true** byte count and its blob id, and its bytes are not captured |

### Still open: the person's way in (N2 refinement 4)

There is **no UI caller** of `verifiedAt` / `person_acceptance` anywhere in the
merged app — the acceptance door is host-side only, so today a person cannot
reach it. That is an honest gap, not a claim of completeness, and the seam plan
for it is in the handoff report: a checkpoint-preview affordance in the
source-control preview surface plus an accept action in the Task verification
panel, showing the exact checkpoint and subject and confirming before the host
is asked. No code for it was written pending approval of that seam.

## Evidence

| Command | Result |
| --- | --- |
| `pnpm -F @lasercode/protocol test` | 706 passed, 44 files, no type errors (`project-work-verification.test.ts` 17) |
| `env -i PATH="$PATH" HOME="$HOME" pnpm -F @lasercode/host test` | 1195 passed, 111 files (`project-work/verification.test.ts` 11) |
| `pnpm -F @lasercode/worker test` | 1573 passed / 4 skipped (`project-work/verification.test.ts` 16, `project-work/verify-server.test.ts` 3, tool-eval matrix 23 × 2) |
| `pnpm -F @lasercode/ui typecheck` · `pnpm -F @lasercode/ui test` | clean · 3234 passed / 1 skipped (`project-work/verification.test.tsx` 12) |
| `pnpm identity:check` · `pnpm -r build` · `pnpm -r typecheck` | clean |

No browser was opened; every claim above rests on unit tests over the real
components and the real worker dispatch.

## Shared files this batch touched, and the one overlap to watch

- `packages/worker/src/server.ts` — the `pi/task/stop` verify branch, the
  `VerificationService` construction, and `sessionPath: () => live.path` on the
  `ProjectWorkSession` this worker builds. The last line sits in
  `projectWorkSession()`, which the T9/T17 mention-context owner also builds
  into; their edits are to `turnContext` and prompt admission, which this batch
  does not touch.
- `packages/worker/src/project-work/session.ts` — one option
  (`sessionPath`) and the verify tool's registration in `lifecycleTools()`.
  `turnContext` is untouched.
