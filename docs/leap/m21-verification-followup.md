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
| **F9** | Capture decoding is strict: a blob whose decoded form does not weigh what git says it weighs (or carries a NUL) is recorded as `omitted: "binary"` with its **true** byte count and its blob id, and its bytes are not captured. **Corrected below**: that comparison was made after a lossy decode and could not see the case it was written for |

### F9, corrected: the comparison has to be made on bytes

The first fix compared `Buffer.from(stdout, "utf8").byteLength` with the size
git reports — but `runGit` has already decoded `stdout` leniently, and an
invalid sequence becomes U+FFFD, which re-encodes to three bytes of its own.
A file whose bytes are `f0 90 80` (a truncated four-byte sequence) therefore
weighed exactly three bytes after the round trip and passed the test, and its
mojibake was captured as if it were source. A file that genuinely contains
U+FFFD passed it too — correctly, but for no reason.

`source-control/read.ts` now reads the blob as **raw bytes** (`readBytes`, a
bounded `execFile` with `encoding: "buffer"` over the same `gitEnv`, no shell,
same timeout) and decodes with
`TextDecoder("utf-8", { fatal: true, ignoreBOM: true })`. `ignoreBOM` is not a
detail: a decoder eats a leading byte-order mark by default, so a file that
starts with one would be captured without it, weigh less than git says it does
and digest differently from its own bytes. Invalid
or truncated UTF-8 is a decode failure, a NUL is checked on the bytes, and a
file that really contains U+FFFD is ordinary text and is kept — there is no
blanket rejection of valid source. `bytes` stays git's own size, the blob id
stays recorded identity, truncation still cuts on a character boundary, and a
read that does not account for every byte git promised answers nothing rather
than storing a partial file as a whole one.

Proved in `packages/host/test/project-work/source-read.test.ts` over real
repositories: the invalid-sequence file (with the byte-length coincidence
asserted in the test, so the old check is shown to have passed it), a valid
Unicode file including U+FFFD, a file whose leading BOM round-trips to the
exact bytes, a NUL-carrying file, and a long multi-byte file cut on a
boundary. The BOM and invalid-sequence tests were both run against the
previous code and fail there.

(The parent found the same lossy conversion in the interop importer's
`readTextFile` and fixed `export/paths.ts` at `d405e5d5`; no file overlaps
this one.)

### Closed: the person's way in (N2 refinement 4)

The acceptance door was host-side only; a person could not reach it. It is now
reachable from the Task's verification panel — **Record my review…** — and the
honesty of what it records is the whole design of it.

**What it is.** Native evidence is the project's own build, rendered by that
build, looked at by a person. Laser renders nothing: there is no preview runner
in this codebase, `CheckpointTrail` is an identity list, and M20's overlay
shows a diff, which is not a running app. So the dialog records exactly one
thing a person can honestly assert — *I opened this project's build at this
checkpoint and compared it with this exact revision* — behind an explicit
attestation and a typed confirmation of the subject's key. No design code is
run, no browser is opened, and nothing on this surface is labelled as a
rendering.

**The tuple is identity, never derivation.** The repository id, object format,
checkpoint ref and commit all come from the `AttemptRepositoryRecord`s the host
wrote from git when the attempt was recorded (`project-work.ts`
`attemptRepositoryRecordSchema`). A workspace with two repositories offers two
rows with **two different commits**; there is no workspace-wide "commit of this
turn" and this surface cannot invent one. No new method was added: the identity
is the Task's own attempt records, and `pi/project/checkpoint/list` answers
whether that ref is still there, joined on ref **and** per-repository commit.

**The subject is the criterion's authority**, mirroring
`verification/evaluate.ts`: a `visual` criterion that came from a Design is
recorded against that Design revision, anything else against the Task's. The
link is written on that entity with its own `expectedRevisionId`, so a
revision that has moved is the host's refusal, shown as written.

**When it cannot be used it says so.** No run yet, no visual criterion, or no
attempt with a checkpoint: the action stays visible and disabled with the
sentence that names the next act (Verify…, or Start… for a conversation to work
in). Cancelling, an untiked attestation, a mistyped key, a pruned or moved
checkpoint and a host refusal all write nothing; Enter confirms nothing; the
cancelling control takes focus; changing the checkpoint or the subject clears
the confirmation, because it was about something else; and only the newest
liveness answer is kept.

**Where it sits.** `components/project-work/native-acceptance.ts` (pure model),
`NativeAcceptance.tsx` (dialog + action), wired into `VerificationPanel.tsx`.
After a successful write the Task is read again, so the next run's
`acceptedPreview()` finds the stored `verified_at` + `person_acceptance` join.

**What stays person-owned, stated rather than automated:** opening the build,
looking at it, and judging it. The dialog offers *See the files that changed at
it* (M20's overlay at that turn) as a help, labelled as a diff and never as the
build. Laser will not grow a browser acceptance harness for this (D-342).

## Short plan · authoritative required sources for a capture (review F1)

**Rejected in review. Kept for the record; superseded by "Short plan v2"
below, which lists the objections that rejected it.** Nothing in this section
was implemented.

**Not yet implemented — this is the plan, for approval before any code.**

**The gap.** `requiredPaths` is helper-only: `buildStateCapture` accepts it and
nothing supplies it (`gate.ts` `prepareVerifiedAt`, `keepEvidenceReviewable`).
Even when supplied it is not sound: the tree is sliced to
`REPOSITORY_CAPTURE_FILES_MAX` **before** required paths are prioritised, a
required path that is absent from the tree is never noticed, a required path
that is binary is silently listed rather than refused, and the **parented**
branch delegates to `buildCapture`, which ignores required paths entirely. The
result can be an accepted decision whose capture is the first N files of a tree
plus a marker — not the sources a person would need to review that decision.

**The contract this has to satisfy** (leap, "Repository provenance"): accepted
evidence must stay *reviewable*; a full durable budget refuses the gate instead
of accepting digest-only evidence.

### 1 · Where the required set comes from — the host, never the caller

| Case | Required sources |
| --- | --- |
| `verified_at` acceptance at a checkpoint that a Task attempt recorded | that attempt's `changedPaths` **for that repositoryId**, as the host wrote them from git (matched by `repositoryId` + the checkpoint's ref/commit) |
| `verified_at` on a **parented** commit | the paths of its own `commit^ → commit` diff |
| `implemented_by` delivery | the paths of the accepted change's diff (what `buildCapture` already walks) |
| a parentless state with **no** attempt record | there is no authoritative change set. A plain `verified_at` write keeps today's behaviour (manifest + bounded sources, no required set); an **acceptance** is refused with what to do (record the attempt, or accept at a checkpoint this Task recorded) |

A caller-supplied `requiredPaths` is removed from the surface: it is not on the
protocol, and "the agent said these were the files" is exactly the guess the
attempt record exists to replace (leap: tool calls never contribute paths).

### 2 · Propagation

- `gate.prepareVerifiedAt` derives the set (store lookup over the subject's
  execution links → `AttemptRepositoryRecord`) and passes it to
  `buildStateCapture`; the acceptance path and the plain write path both go
  through it.
- `gate.keepEvidenceReviewable` derives the same set per link when it backfills,
  so a gate-time capture is not weaker than a write-time one.
- `buildCapture` gains the identical `requiredPaths` handling, so the parented
  branch cannot bypass completeness.

### 3 · Completeness, checked in every variant

One shared helper, used by both `buildCapture` and `buildStateCapture`:

1. **Select before slicing.** Required entries are taken out of the full tree /
   diff listing first; the file cap then fills from the remainder. A required
   path beyond `REPOSITORY_CAPTURE_FILES_MAX` can no longer fall off the end.
2. **Absent is a refusal.** A required path the state does not contain is named
   and the decision refused — not omitted as "budget".
3. **Binary is a refusal for a required path.** Its bytes are not reviewable, so
   a decision resting on it cannot be called durable.
4. **Truncated is a refusal** (today's rule, kept), as is a read that fails.
5. **Bounded, or refused.** Required sources are counted inside the existing
   `REPOSITORY_CAPTURE_BYTES_MAX` / `…SOURCES_MAX`; if the required set alone
   does not fit, the gate is refused with what to do (accept a smaller change,
   free space) — never a larger budget and never a repository backup. A
   `REQUIRED_PATHS_MAX` (= `REPOSITORY_CAPTURE_SOURCES_MAX`) bounds the set
   itself, and exceeding it is the same actionable refusal.

### 4 · Ordering, idempotency and quota — unchanged

Every refusal above happens **before** `storeCapture`, so a refused acceptance
costs no quota and writes no blob; the accepted order stays build → store
(`-32011` accepts nothing) → link transaction; gate-time backfill keeps the
idempotent `attachCapture`. Nothing about the decision's transaction changes.

### 5 · Tests to write with it

Real git repositories, as the T18 suite does: required paths derived from the
attempt record rather than from any caller; refusal when a required path is
absent / binary / truncated / too large; the parented branch refusing on the
same rule; an acceptance whose capture still reads back after the checkpoint is
pruned and gc'd; and a refused acceptance leaving the blob count unchanged.

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

### Batch 3 · the person's door and the byte-level capture fix

After merging this branch into the reviewed design/Foundation line
(`688f014d`), at `7133fb60`:

| Command | Result |
| --- | --- |
| `pnpm -F @lasercode/protocol test` | 745 passed, 47 files, no type errors |
| `env -i PATH="$PATH" HOME="$HOME" pnpm -F @lasercode/host test` | 1241 passed, 115 files (new `project-work/source-read.test.ts`, over real repositories) |
| `pnpm -F @lasercode/worker test` | 1663 passed / 4 skipped |
| `pnpm -F @lasercode/ui test` | 3322 passed / 1 skipped (new `project-work/native-acceptance.test.tsx` 20) |
| `pnpm -r build` · `pnpm -r typecheck` · `pnpm identity:check` | clean |
| `pnpm verify` (with the display environment preserved) | passed |

Three of the new tests are regression proofs in the strict sense — they were
run against the previous code and fail there: the invalid-UTF-8 capture (the
old byte comparison called it text), the leading BOM (the decoder ate it), and
the checkpoint question asked once per checkpoint (the old effect asked three
times in the same scenario).

**Not proven here, and left for the person:** that the dialog looks right in
both themes, at both widths and with a pointer or touch, and that the whole
round trip (verify → record a review → verify again finds native evidence)
behaves on a real project. Steps: open a Task with a design-backed visual
criterion, Verify…, then **Record my review…**, tick the attestation, type the
subject's key, record, and verify again — the visual criterion should read
*satisfied* naming the commit, and the Task's evidence list should carry a
`person_acceptance` row.

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

## Short plan v2 · authoritative required sources for a decision capture (F1)

**Not implemented. This is the plan, revised after the first one was rejected,
for approval before any code.** It replaces every mechanism of the rejected
section above: `attempt.changedPaths`, `subject.executionLinks` and
"absent-at-head refuses" are all gone.

### 0 · Why the first plan was wrong

| Rejected mechanism | Why it cannot stand |
| --- | --- |
| required set = `AttemptRepositoryRecord.changedPaths` | that field is the **first → last checkpoint** aggregate (`project-work.ts` `attemptRepositoryRecordSchema`, `delivery.ts` `repositoryFacts`). It omits what the *first* checkpoint already changed against the attempt's base, and it includes paths a later checkpoint reverted. It describes an aggregate, never the one checkpoint being accepted |
| find the attempt by walking the **subject's** execution links | attempts are on the **Task**; a Design-backed `visual` criterion is accepted on the **Design** (`evaluate.ts` `visualFinding`, `native-acceptance.ts` `acceptanceSubjects`). The subject would have no execution links at all, and picking "the Task's newest attempt" would be the guess the record exists to replace |
| "a required path absent at head is missing source → refuse" | a **deleted** path is legitimately absent at the state; refusing it would make every delete unacceptable |
| prioritise required paths inside the already-sliced tree | `treeManifest` stops at its own `limit`, so a required path beyond the cap was never in the list to prioritise |

### 1 · The identity the host joins on — explicit, bounded, never latest

One new optional field on the existing evidence-link door, no new route:

```ts
verifiedAt: {
  repositoryId; state;
  acceptance?: { kind: "checkpoint_preview" };
  /** Required whenever `acceptance` is present. */
  attempt?: { taskEntityId: string; executionLinkId: string };
}
```

The UI already holds both: the Task detail it renders is the Task, and every
row of `acceptanceCheckpoints()` is built **from one `ExecutionLink`**, so its
`linkId` is carried down instead of being thrown away. The request is
identity the caller *reports*; every part of it is then re-derived host-side
and refused if it does not agree.

`ProjectWorkGate.prepareVerifiedAt` validates, in this order, all before any
git read of file bytes and all before `storeCapture`:

1. `store.executionLink(projectId, executionLinkId)` exists, its `entityId` is
   `taskEntityId`, and that entity is a **task** in this project. Otherwise:
   refused, naming the attempt.
2. **The subject is that Task, or an artifact revision the Task currently pins.**
   The Task's own authority resolution is reused rather than re-invented —
   `gatherAuthorities()` (`verification/authorities.ts`), the same function the
   run used to build the report — and the subject must equal the Task's ref or
   the Spec/Design ref it returns, at **exactly** `subjectRevisionId`. A Design
   the Task no longer pins, or pinned at another revision, is refused with what
   to do. This is the canonical Task ↔ Design ↔ attempt join, and it is the
   same one the evaluator reads back.
3. The existing rule stays on top of it: the subject must be the store's
   **current** revision and digest.
4. The attempt's record for **this exact `repositoryId`**
   (`executionLink.repositories`) exists and is not `unavailable`, and one of
   its `checkpoints` matches the request on **both** `ref === state.checkpointId`
   and `commitObjectId === state.commitObjectId`. Not the newest, not the ref
   alone: the exact recorded tuple. A workspace with two repositories has two
   records and two commits, and one acceptance names one of them; the other
   repository is a second acceptance, never an inferred merge.
5. `listCheckpointRefs` still proves the ref → commit in git today (unchanged).

A request without `attempt` and with `acceptance` is refused with the sentence
that names the missing identity. A request without `acceptance` (a plain
`verified_at`) is unchanged: validated, captured, honest, and **not** Native.

### 2 · The required change set — attempt base → this exact state

While git can still answer, and only then:

- `base = record.base.commitObjectId`, the commit the host wrote when the
  attempt was recorded. If git no longer has it, the acceptance is **refused**
  with what to do (accept at a checkpoint whose attempt base is still there);
  no `HEAD`, no fallback, no partial set.
- `required = diffBetween(repository, base, state.commitObjectId)` — the exact
  difference between what the attempt started from and the state being
  accepted. An older checkpoint therefore carries the file *as it was at that
  checkpoint*, and a path a later checkpoint reverted is simply not in this
  set; a path the first checkpoint changed is.
- Its `files` rows are the required set, with their own `status`
  (`added`/`modified`/`deleted` — `--no-renames` means a rename is the delete
  and the add, which is exactly the two bodies a review needs). No parallel
  state machine is written beside `ChangedFileRow`.
- Bound: `REQUIRED_PATHS_MAX = REPOSITORY_CAPTURE_SOURCES_MAX` (100). More
  required files than that refuses the acceptance with what to do — never a
  silent prefix.

For a **parented** commit (a real commit, not an M20 checkpoint) the required
set is its own `commit^ → commit` diff: the same helper, same rules.

### 3 · What is captured for each required entry

One shared selector used by `buildCapture` and `buildStateCapture`, so the
parented branch cannot bypass completeness:

| Required row | Body kept | Why |
| --- | --- | --- |
| `added` / `modified` | the **after** body, `fileAt(state.commitObjectId, path)` | the state being accepted is the after side |
| `deleted` | the **before** body, `fileAt(base, path)`; the after side is recorded as absent, legitimately | a delete is reviewed by reading what was removed |

`RepositoryCaptureSource` gains `side?: "before" | "after"` (absent = after) so
a before-body can never be read back as the accepted state's content.

Refusals, all before `storeCapture` and before the link transaction:

1. a required body that is **binary** (host-side, from bytes — d534's strict
   decoder is untouched);
2. a required body that is **truncated** (a prefix is labelled `truncated` and
   is honest, and honest is still not the whole source a decision rests on);
3. a required body git cannot read at the side it is wanted on (a *modified*
   path missing at the state, a *deleted* path missing at the base): the state
   contradicts the diff, and that is refused rather than papered over;
4. the required set alone exceeding `REPOSITORY_CAPTURE_BYTES_MAX` /
   `…SOURCES_MAX` — the existing budget, never a larger one, never a second
   store and never a repository backup.

Required entries are looked up **directly by path**, so nothing about them
depends on `treeManifest`'s cap. Non-required files fill what is left of the
budget from the bounded listing, and the note says what the listing is:
*"this listing covers the first N files of the tree"* — the capture never
claims a full tree it did not read.

### 4 · Zero change, and no authoritative attempt

- **Zero-change checkpoint** (`required.files.length === 0`): the state is
  byte-identical to what the attempt began from, so there is no change this
  Task made for a person to have reviewed. The acceptance is **refused**, with
  the next act named (work on the Task, then accept at a checkpoint that has a
  change; or accept at the checkpoint that carries it). An empty required set
  plus a digest-only marker is never written.
- **Parentless state with no attempt identity**: acceptance refused with the
  same actionable guidance. A plain `verified_at` write stays exactly as it is
  today — bounded manifest, bounded sources, honest notes, no `required`
  block, and therefore not Native.

### 5 · The completeness proof, and what reads it back

`RepositoryCapture` gains one host-written block:

```ts
required?: {
  basis: "attempt_base_to_state" | "commit_parent_to_commit";
  from: { baseCommitObjectId: string; executionLinkId?: string; taskEntityId?: string };
  entries: Array<{ path; status; side: "before" | "after"; contentDigest; blobObjectId? }>;
  complete: true;   // written only when every entry has a whole body in `sources`
};
```

It is written by `captures.ts` from what git answered, canonicalised into the
blob, and the blob is content-addressed — so it cannot be minted by a caller
and cannot drift from the bytes it describes. Nothing in it comes from the
request.

`acceptedPreview()` (`verification/evaluate.ts`) gains a **sixth** stored fact
beside the five it has, still reading only the store and never git: the
capture parses as a capture of *this link's* state, and carries
`required.complete === true` with every entry present in `sources` at the
recorded digest and side. Consequences, stated rather than discovered:

- an **older capture** (no `required` block) no longer satisfies a `visual`
  criterion merely because its blob parses. The criterion reads `needs_person`
  with the exact step — record the review again — which is the honest answer;
- **nothing is erased or rewritten.** Links, acceptances, evidence and
  completed Tasks stay exactly as they are (append-only); a re-recorded review
  appends a new link beside the old one;
- **no later git read** is introduced anywhere on this path, so a pruned and
  gc'd checkpoint changes no answer.

### 6 · Backfill and the other gates

- `gate.keepEvidenceReviewable` derives the **same** required set for a link
  that carries the attempt identity. `prepareVerifiedAt` therefore returns the
  `executionLinkId` and the store writes it into the `verified_at`
  `RepositoryLink.executionLinkId` — the field already on the schema and
  already validated against `execution_links` — so a gate-time capture is
  derived from recorded identity rather than re-guessed.
- A historical acceptance link with no capture is backfilled exactly as today
  (bounded capture, so the gate can still be reviewed) and **does not** gain a
  `required` block: the gate passes, and the evaluator still does not call it
  Native. A backfill never manufactures completeness it did not verify.
- Delivery (`implemented_by`) uses the same selector and gains the same
  before-bodies for deletes and the same required-first ordering, and records
  `required` when the accepted change's whole diff fits. When it does not fit,
  it keeps today's bounded capture with its honest note and no `required`
  block — this plan does not add a new refusal to the delivery gate. **Flagged
  explicitly**: if the parent wants delivery to refuse on a required-set
  overflow too, that is a one-line rule change and a test, and I will do it
  under this milestone on request.

### 7 · What is touched

| Package | Change |
| --- | --- |
| `protocol` | `verifiedAt.attempt` (+ schema, required with `acceptance`), `RepositoryCaptureSource.side`, `RepositoryCapture.required`, `REQUIRED_PATHS_MAX`; tests |
| `host` | `project-work/captures.ts` (shared required selector, before-bodies, refusals, `required` block), `project-work/gate.ts` (identity join, base→state derivation, backfill), `project-work/store.ts` (write `executionLinkId` on the `verified_at` link), `verification/evaluate.ts` (sixth stored fact); `source-control/read.ts` only if a bounded read helper is genuinely missing |
| `ui` | `native-acceptance.ts` (`executionLinkId` + `taskEntityId` on a row, unambiguous row identity per attempt, request shape), `NativeAcceptance.tsx` wiring only; no new copy beyond a refusal the host wrote |
| `worker` | only if compilation requires it |

Untouched on purpose: SDK/driver/prompt/steer/pending, design index/workspace,
interop paths/publication/import, transcript/list/cache. No `PLAN.md` /
`STATUS.md` edits from this owner.

### 8 · Tests (real git repositories, owned fixtures, no external targets)

Through the **host router/store path**, not helper-only, except where noted:

1. the required set is the attempt **base → the chosen checkpoint**: an older
   checkpoint is accepted while a *newer* checkpoint reverted one of its files,
   and the capture holds that file as it was at the accepted checkpoint;
2. a file changed by the **first** checkpoint (absent from `changedPaths`) is
   in the required set and captured;
3. a **Design-backed** `visual` criterion accepted on the Design, joined to the
   **Task's** attempt; a Design the Task does not pin, and a stale pinned
   revision, are refused;
4. **multi-repository**: two records, two commits; the acceptance for one
   repository captures that repository's change and nothing of the other;
5. **delete and rename**: the before body is captured, the after side is
   recorded absent, and neither is a refusal;
6. a required path **beyond the manifest cap** is captured (tree larger than
   `REPOSITORY_CAPTURE_FILES_MAX`);
7. refusals — required path **binary**, **truncated**, absent on the side it is
   wanted, required set **over budget**, required set over `REQUIRED_PATHS_MAX`,
   attempt base gone, attempt/checkpoint tuple mismatched, `acceptance` with no
   `attempt` — each asserted to leave the **blob count unchanged** and **no**
   `verified_at` link, evidence record or acceptance written;
8. **zero-change** checkpoint refuses the acceptance and its plain
   `verified_at` counterpart still writes an honest bounded capture;
9. **parented** commit parity: same selection, same refusals, `basis:
   "commit_parent_to_commit"`;
10. **durability end to end**: real repository → attempt recorded → verify →
    record a review → Task `done` → delete the checkpoint refs → `git gc
    --prune=now` → verify again finds the `visual` criterion satisfied from the
    store alone;
11. an acceptance whose capture predates this change (no `required` block) is
    **not** Native, and the report says what to do;
12. unit coverage of the UI model: a row carries its own attempt's
    `executionLinkId`, and the request is refused rather than guessed when a
    row cannot be tied to exactly one attempt.

### 9 · Commands, after approval

```
env -i PATH="$PATH" HOME="$HOME" pnpm -F @lasercode/host exec vitest run test/project-work
pnpm -F @lasercode/protocol test
pnpm -F @lasercode/ui exec vitest run test/project-work/native-acceptance.test.tsx test/project-work/verification.test.tsx
pnpm -r build && pnpm -r typecheck && pnpm identity:check
```

The full `pnpm verify` gate is the parent's; nothing here runs a concurrent
monorepo gate, opens a browser or automates acceptance.
