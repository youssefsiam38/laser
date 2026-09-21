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
