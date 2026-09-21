# M21-T19 review · durable verification end to end — FIRST FULL independent review

Reviewer: independent reviewer session (`agents/review-durable-verification-end-to-end-b77f0884`).
Candidate under review: **`7115a97665dde77e8249ff3828a21243b4421a49`** on `work/m21-proof-review`
(whole `00f6b934` + whole `8e69281b` atop parent `1475fa28`, conflict-free). Frozen, UNACCEPTED
review candidate — not main integration. Read-only: candidate source was read and tested, never
edited, and no source/change branch was merged.

Scope: the full verification/proof feature since parent `d408e8ea` — protocol
`project-work-verification.ts` and the history/capture/method/bridge schema additions; host
`project-work/{captures,required-facts,gate,methods,store,schema,delivery,verification/*}` and
`source-control/read.ts`; worker `project-work/verification/*`, bridge/session/tool registration,
evals, and the narrow server/worker-lifetime hooks; UI `NativeAcceptance`/`ProofTrail`/
`ProofReader`/`VerificationPanel`/`VerificationReport`/models/client store and their tests.
This is one cohesive correctness review, not a runtime-only review. The M21
foundation/index/mentions/interop milestones are not re-reviewed; their seams were protected.

The parallel storage review (`run_3a28ca40`, quota 40+8e over `613b9192`) covers byte/record
accounting, migration and credits in its own tree. Findings it owns — notably the known H1
(false no-save quota recovery after an earlier capture write) and the receipt/migration-page
corrections — are **not** restated here as T19 findings. Where this review touches
quota/attachment behaviour it only checked the *feature integration* of the guards, not the
accounting arithmetic.

## Verdict

**Approve for the parent's final correction batch — no T19 blocker found in this review.**
The candidate is the product of several already-integrated review batches (D-361, D-363, D-364,
the F1–F9 set, the runtime corrections and the two follow-ups), and this review confirms the
approval bar's structural conditions hold in the frozen source: the exact-durability contract
is enforced at all three readers (Native evaluator, decision gates, delivery door) from one
expectation module; capture precedes decision; decisions bind the exact immutable proof they
consumed inside their own transaction; convergence reads stored joins only; the Command
lifetime settles on actual drain with pins held through settlement; and the person's acceptance
door records a host-written attestation the caller cannot mint. One should-fix finding (S1,
Windows already-gone kill misread as a refusal to end), two nonblocking structural notes
(S2, S3), and two open contract questions (O1, O2) below. All are safe to fix in the parent's
one final batch; none changes a recorded decision's meaning.

## Findings

### S1 · should-fix · Windows "tree already gone" is reported as a refusal to end it

`packages/worker/src/project-work/verification/commands.ts` — `killVerificationTree`'s Windows
branch treats "already ended" as benign only when `terminationCode(error)` yields `"ESRCH"`.
But a real `taskkill` refusal for a process that already exited is a **non-zero exit code**
(Node's `execFile` sets `error.code` to that number), so `terminationCode` answers `"128"` /
`"exit 128"`, never `"ESRCH"`. The benign case therefore reaches `onProblem` → `cannotEnd` →
`COMMAND_STILL_RUNNING_PROBLEM.cannotEnd`: the person is told *"This run's command could not
be stopped (128), so it is still running"* while the run is in fact settling normally from the
`close` event that follows. No settlement impact (the record is still made on close and the
live problem is dropped at settlement), but it is a false person-facing problem in the most
common Windows stop case, plus a spurious log line.

- The test that guards the benign case
  (`packages/worker/test/project-work/verification.test.ts:1202` *"says nothing when the
  Windows kill found the tree already gone"*) drives the seam with the **synthetic**
  shape `error.code = "ESRCH"` — a shape real `taskkill` output never produces — so the test
  passes while the real-world case misreports.
- Remedy: in the Windows branch, accept `taskkill`'s "not found" outcome (exit 128) as
  already-gone the same way `ESRCH` is on POSIX; add one seam test with the **real** shape
  (`runTaskkill` invoked, `error.code = 128`) asserting no problem is raised. Severity: low
  (honesty of the person-facing problem sentence; no data or settlement effect).

### S2 · nonblocking · structural — `store.ts` grew another 1,035 lines

`packages/host/src/project-work/store.ts` was already 3,314 lines before this candidate and is
now 4,349. The growth is the capture-association and decision-proof-binding cluster —
`appendCaptureAssociation`, `currentCaptureAssociation`, `originalCaptureAssociation`,
`captureHistoryPage`, `decisionBindingPage`, `bindDecisionProof`, `attachCapture`
(`store.ts` ≈ 2375–2905) — which is a self-contained slice of D-363 with its own two tables.
The candidate already made the right extraction moves elsewhere (gate out of `methods.ts`,
`required-facts.ts`, one shared capture selector), but the store keeps absorbing every new
canonical record. Recommendation for the parent's next batch: extract that cluster into
`project-work/capture-history.ts` behind the same store surface. Behaviour-preserving, and it
reverses the largest single file's drift before more schema versions accrete. Not a blocker;
no reader contract changes.

### S3 · nonblocking · a fallback VerificationService that cannot publish rows

`packages/worker/src/project-work/session.ts:234` — when `options.verification` is absent, a
session mints `new VerificationService({ bridgeFor: () => bridge })` with **no `publishTask`,
no `holdsSession` and no sessionPath thunk**, i.e. exactly the fleet-invisible run the whole
M21-T19 design forbids. Today only `tool-eval/run.ts:289` constructs a session without the
option (documented as "a narrow test, a fixture"), and production always passes the shared
service (`server.ts:2310`). Risk: any future production construction path that forgets the
option silently reintroduces invisible runs. Remedy: keep the fallback only for the eval
world (or assert the option at the tool boundary) so the "runs are never invisible" invariant
does not depend on every constructor passing the option.

### O1 · open question for the parent · multi-repository visual evidence

`packages/host/src/project-work/verification/evaluate.ts` (`acceptedPreview`) satisfies a
`visual` criterion with **one** accepted `verified_at` preview on **either** repository of the
workspace. In a two-repository workspace, a person who accepted repo A's build and never
reviewed repo B's change still gets *satisfied* naming A's commit. The followup document fixes
the per-repo *identity* rule (two rows, two commits, never one workspace-wide commit) but does
not state whether a visual criterion requires an acceptance **per repository**. Not contracted
either way; the parent should decide and, if per-repo acceptance is required, extend
`acceptedPreview` + `attemptOrigin` accordingly with a test. Nonblocking.

### O2 · low · two different blobs answer "is the proof readable"

`acceptedPreview` checks `captureReadable(link)` — which reads the link's **current pointer**
blob — while `captureComplete` (methods.ts:1038–1044) reads the **acceptance-bound** blob
(`acceptance.captureBlobId`, falling back to the first `first_capture` association). Blobs are
never auto-released, so the two cannot disagree today, but the readable-check and the
completeness-check should read the same blob (the bound one) so a future correction or release
policy cannot make the check diverge. One-line alignment.

### Documented limits, restated for the record (not new findings)

- A verification run's own `plan`/`report` bridge calls carry **no execution envelope on the
  wire today** (`HostProjectWorkBridge.writeEnvelope` attaches it for `create`/`revise`
  only), so the durable verification record does not name the checkout or the owning session;
  traceability lives in the ephemeral fleet row and run state, which die with the worker. This
  is a parent-documented limit of the D-364 batch, not a regression introduced silently.
- `sessionClosed`/detach: publication stops under a dead path while settlement and retention
  complete privately, pinned via `unsettledWork()` identities re-read under the retirement
  fence — implemented as approved, including the same-path-reload deduplication.

## Acceptance matrix

Legend: ✅ = verified by this review in the frozen source (reproduced test or code-traced);
📖 = verified by reading code and prior evidence, not re-executed; 👤 = person-owned (D-342),
must not be inferred from unit tests.

**1 · Exact durable source**

| Item | Status | Where |
| --- | --- | --- |
| Selected host-confirmed repository/state/change, per repository | ✅ | `gate.attemptFacts`/`delivery.repositoryFacts` write per-`repositoryId` records from git; `acceptanceCheckpoints` keeps two repositories as two rows with two commits (`native-acceptance.ts`) |
| Attempt BASE → EXACT selected checkpoint, never aggregate `changedPaths`/HEAD/newest | ✅ | `selectRequired` diffs `record.base.commitObjectId → state.commitObjectId`; `buildStateCapture` no longer overrides with the parent (`captures.ts`); tested incl. what the first checkpoint changed and a later-reverted file |
| Distinct repos; scoped tree bound before truncation; gitlinks cannot vanish | ✅ | `treeListing(repo, commit, limit, scope)` puts the `:(literal)` scope **into** git; `unreadable` rows named; F1 tests red-before/green-after |
| Required add/modify-after/delete-before/rename-both, no partial/binary/truncated/overbudget masquerading complete | ✅ | `selectRequired` `--no-renames` (rename = delete+add), delete body read at base with `side: "before"`; `captureRequired` refuses binary/truncated/too-large/over-budget **before** `storeCapture`; all four refusal classes tested |
| Required identity derived from persisted authority; basis cannot substitute itself | ✅ | `required-facts.ts` derives repository/target/bases/base/scope/attempt from the persisted link + attempt record only; `provesLink` checks the base for **every** basis; parent-only proof of a multi-commit attempt refused by test |
| Strict raw UTF-8; BOM preserved; U+FFFD is text | ✅ | `read.ts` `readBytes` + `TextDecoder(fatal, ignoreBOM)`; NUL on bytes; byte accounting against git's own size; source-read tests over real repos |
| Captures before decision; CAS losers atomic; zero-change only as complete bounded state | ✅ | `storeCapture` before the link transaction; `attachCapture` CAS (`changes === 1`) with lost-race refusal; zero-change → `complete_bounded_state` with scoped `ls-tree`, over-cap scope refused |
| Retained capture survives prune+GC; convergence reads stored joins, never live Git | ✅ | round-trip test: accept → delete refs → `git gc --prune=now` → verify again finds the visual criterion satisfied from the store alone |
| Supersession immutable; no metadata-only Native upgrade | ✅ | `originalCaptureAssociation` answers only for `first_capture`; `legacy_baseline` never certifies an old acceptance; old partial Native reads `needs_person` |

**2 · Decisions consume exact proof**

| Item | Status | Where |
| --- | --- | --- |
| Association history immutable and bounded/pageable (≤ 50 rows **total**, cursor, next-page fact) | ✅ | `captureHistoryPage` ordered `link_id, seq DESC`, `limit+1` probe; `ProofTrail` pages and replaces; history over the prefix tested |
| Original capture never inferred from migration baseline/timestamps | ✅ | bindings key on the real approval id / completion event sequence; `known` vs empty-set vs unknown distinction; `decision-proof.test.ts` |
| Approval/Task-done binds blob + association revision/seq; stale binding rolls back | ✅ | `bindDecisionProof` inside `approve`/`taskAction` transactions, rechecking pointer **and** newest association; mismatch throws → approval/completion and bindings roll back; tested both sides |
| Known-empty distinct from legacy-unknown and wrong-entity | ✅ | `decision_capture_binding_sets` written even when empty; `known` scoped by entity (cross-entity unknown test); UI renders three sentences |
| Later pointer correction cannot rewrite consumed proof | ✅ | convergence reads `acceptance.captureBlobId` then `first_capture` only; `ProofTrail` reads by the bound blob's own content address |
| Delete/unlink preserve surviving shared historical proof | ✅ | `unlink` refuses when `decisionRestsOn` (bindings/evidence/acceptance/approved/done state) or agent-actor; `store.delete` refuses when `proofConsumedElsewhere` |

**3 · Native is the person's acceptance**

| Item | Status | Where |
| --- | --- | --- |
| Person's actual build/checkpoint acceptance, not metadata "approved"/Sketch/model assertion | ✅ | `acceptedPreview` six stored facts (person creator, host-written `acceptance` agreeing with ref→commit, readable+complete capture, joined passing `person_acceptance`); no preview runner exists; Sketch cannot pass a gate |
| Only a person may ask; host writes the acceptance record; agent ask refused | ✅ | `prepareVerifiedAt` person-only actor from the connection (`originFor` derives kind from source, not body); request body cannot mint `RepositoryLinkAcceptance` |
| Exact subject/per-repo state; stale/ambiguous handling | ✅ | subject must be the store's current revision+digest; checkpoint must be a real ref **resolving to** the named commit; attempt tuple (ref **and** commit, per repo) matched; ambiguous two-attempt checkpoint loses the attempt and is refused |
| Explicit UI checkpoint context, typed key + attestation, Enter never submits, cancel/focus/scope fences | ✅ | `NativeAcceptance.tsx`: `ready` requires attestation + typed key + non-ambiguous + live checkpoint; both inputs `preventDefault` on Enter; cancel button takes autofocus; confirmation cleared on subject/checkpoint change; disabled with the next act named |
| Host enforces authority; client is not the gate | ✅ | every rule re-derived host-side (`attemptOrigin`), refusals written by the host |
| No second project-runtime preview runner / browser-agent acceptance | ✅ | none exists in the codebase; matrix criteria hand steps to the person |
| Unsupported binary/limits: honest refusals, not silent partial success | ✅ | binary/too-large/over-budget/over-cap required sets refuse the acceptance/delivery naming the file |

**4 · Verifier authorities and truthfulness**

| Item | Status | Where |
| --- | --- | --- |
| Spec/Design/Plan/Task authorities + required criteria at exact revisions | ✅ | `authorities.ts` gathers at the store's current revisions; every criterion carries source key/revision/digest |
| Proper Native/design-state matrix | ✅ | `visual`/`browser_matrix` always `needs_person`; matrix cells bounded `VERIFICATION_MATRIX_CELLS_MAX`, steps generated |
| Declared commands/diffs/review/feedback; missing binding blocks | ✅ | `mustBeProven` counts required machine-verifiable criteria whether or not a command is bound; "none is bound to it" sentence in the report |
| Deviation flow; affected-only staleness | ✅ | deviations stored `proposed` whatever the caller sent; blockers cover blocking comments, invalidated approvals, stale upstream, unmet dependencies |
| Failed/missing/stale criteria cannot read Done; passing machine checks may `needs_review`, never automatic `done` | ✅ | `convergenceOf`; `convergeTask` is the only state move (`in_progress → needs_review`) and returns `undefined` for a `done` Task — rerun semantics safe, no regression |
| Evidence freshness / already-completed rerun | ✅ | host **re-derives the plan at report time** (`verifyReport`), so a stale run cannot pass criteria it never read; changed commands read "did not run" and block |
| One truthful stored final report; readable bounded evidence UI; nothing permanently hidden | ✅ | one blob per run, idempotent `verify-<runId>`; `VerificationReport`/`ProofTrail`/`ProofReader` page everything captured |

**5 · Command lifetime**

| Item | Status | Where |
| --- | --- | --- |
| Observe TaskIndex before transport | ✅ | `verification()`'s `publishTask` calls `this.tasks.observe(path, …)` before `this.notify(...)` |
| Immutable logical owner; canonical rekey; no global current-session attribution | ✅ | run state is the single source of `sessionPath`; `rekeySession` moves held runs and republishes unsettled ones; bridge `execution()` reads the owner thunk at call time |
| Start foreign/no-session refusal | ✅ | `holdsSession` checks the runtime table; `VERIFICATION_NEEDS_SESSION`; tool refuses without the worker's own `live.path` |
| Pre-dispatch Stop aborts; stays pinned through ACTUAL child+stdio close AND stopped-report settlement | ✅ | `stop()` sets `stopping`, no phase/`endedAt`; row running + pinned until `close` and the report barrier resolve; the runner settles **only** on `close` (no timer-based terminal) |
| Post-dispatch Stop cannot mutate payload/revoke outcome; held ≠ cancelled; write failure visible | ✅ | `reportDispatched` boundary; refused stop keeps *Saving results…*; failed report write becomes `problem` in state and row `error`/`terminalReason` |
| OS termination failure / lingering output stays unsettled with a safe bounded live problem | ✅ | no exit invented; `killVerificationTree(child, onProblem)` + `COMMAND_STILL_RUNNING_PROBLEM`; guarded `note`/`raise` sinks; exception: S1's Windows already-gone shape |
| Every observer/log exception contained | ✅ | guarded publisher + logger, `settleHeld` marks finished and prunes regardless; bounded content-free diagnostics (id + error name only) |
| Output count/digest once incl. late bytes | ✅ | `BoundedOutput.done()` memoizes; `add` refuses post-finalize; data listeners detached with the record |
| Ids restart-unique vs durable idempotency | ✅ | `ver_<uuid>` (40 ≤ 64/80 limits); host receipt test proves a spent key replays and never overwrites |
| Finished ≤ 20 at settlement, active kept | ✅ | `settleHeld` → `prune()` selects on `settled`; unsettled never evicted |
| Explicit file moves refuse under lock; unexpected close stops/detaches without dead-path rows; same-path reload pin deduped; under-fence recheck | ✅ | `pi/session/close` refuses under `firstTurnLock` on running tasks or unsettled runs; `sessionClosed` detaches + stops; `pinsOf()` = own pins ∪ owed work, deduped by fleet row identity; `retire()` re-reads under the fence after drain |
| Both SDK drivers compile | 📖 | parent's `pnpm -r build` green at this revision (t-3b8f0a93); seam not re-executed here |

**6 · UI / evidence reading**

| Item | Status | Where |
| --- | --- | --- |
| Immutable bound blob as actual source text | ✅ | `ProofTrail` reads by `row.proofId`; link pointer corrections irrelevant |
| Accessible all files/decisions via bounded pages | ✅ | full source/omission indexes + `proofPageOf` pagers; decisions offered by name; nothing unreachable |
| Exact UTF-8 across 512 KB boundaries / surrogates; single fatal decode; strict base64 | ✅ | `proofPageBytes`/`proofTextFrom`/`proofSourceWindow` (whole-character cuts); straddling-character, BOM, cut-inside-character tests |
| Only one body retained; bounded memory | ✅ | parsed capture is a local that goes out of scope; retained = index + one file's text (≤ 128 KB), replaced per selection; window bound `PROOF_CAPTURE_MAX_BYTES` |
| Escaped literal markup | ✅ | text rendered in a wrapping `<pre>`; markup-heavy-source test proves no element node |
| Scope/store/unmount/request races fenced before paint | ✅ | `ProofTrailFor` keyed by store identity+project+entity+revision; generation fence bumps on every read and scope change; held-open-read tests |
| Missing/corrupt/released/unknown states truthful; Stop disabled while stopping/saving | ✅ | distinct sentences per failure kind; `VerificationPanel` disables Stop while `stopping`/`reporting` and says which |
| Tokens both widths/themes/pointer/reduced motion | 👤 | tokens used throughout (`text-ink-*`, `leading-xs`, `pointer-coarse:min-h-11`); visual acceptance is the person's (D-342) |

**7 · Tool / gating / evaluation**

| Item | Status | Where |
| --- | --- | --- |
| Feature gating and project scope | ✅ | `verify_project_task` registered only when the bridge has a project **and** a checkout (`session.ts`); projectless sessions get the read-only surface |
| Method policy | ✅ | `verify/start` execution-scoped, `verify/state` read, `verify/stop` execution (`method-policy.ts:184–186`) |
| Error contracts / recovery | ✅ | `refuseProjectWork` codes with next steps; `VERIFY_TOOL_RECOVERY` |
| Evaluation fixture coverage | ✅ | `verify_project_task.json` fixture over the real driver/registrations; `host-link.test.ts` added |
| No external privacy/exploit probes | ✅ | tests use inert spawn doubles and owned temp fixtures; no external targets |
| Traceable tests for behaviour, not schema copy | ✅ | drain/stop/rekey/retention/proof-binding suites assert lifecycle points, several proven red-before-fix |

## Validation evidence

Reproduced by this review, in the frozen candidate at `7115a976` (read-only; tests used owned
temp fixtures; no live source, `pnpm` hardlinks, shared worktrees or user state mutated):

| Command | Result |
| --- | --- |
| `env -i PATH="$PATH" HOME="$HOME" pnpm -F @lasercode/host exec vitest run test/project-work/{capture-completeness,capture-history,decision-proof,verification,delivery,source-read,verification-run-identity}.test.ts` | 92 passed (7 files), 7.77 s |
| `env -i PATH="$PATH" HOME="$HOME" pnpm -F @lasercode/worker exec vitest run test/project-work/{verification,verify-server}.test.ts` | 53 passed (2 files) |
| `env -i PATH="$PATH" HOME="$HOME" pnpm -F @lasercode/ui exec vitest run test/project-work/{native-acceptance,verification,proof-reader,verification-stop}.test.tsx` | 57 passed (4 files) |
| `env -i PATH="$PATH" HOME="$HOME" pnpm -F @lasercode/protocol exec vitest run test/project-work-verification.test.ts` | 19 passed, no type errors |

Read-only evidence (not re-executed here):

- Parent candidate check `t-3b8f0a93` (log `/tmp/laser-proof-candidate-check.log`): frozen
  install, `pnpm -r build`, host `test/project-work` 347 tests / 22 files, focused protocol
  71 tests / 3 files + types, `pnpm identity:check` — all green at this revision.
- Parent full-suite gates: source-`00` build+worker203/UI57/host40/identity (`t-c072d4b3`,
  `/tmp/laser-verification-final-parent.log`) and quota-8e host344
  (`/tmp/laser-quota-parent-check.log`) — passed; storage review separately completed.

Not run by this review, deliberately: full package suites, `pnpm verify`, `identity:check`
re-run, any browser (D-342), timeout inflation, skips or retries.

## Unproven, person-owned items (D-342)

- Visual acceptance of the whole verification surface — Task detail verification panel, native
  acceptance dialog (including its new refusal sentences and the ambiguous-attempt state),
  proof trail/reader, stopping/saving button states — in **both themes, both widths, pointer
  and touch, reduced motion**.
- The real-project round trip: open a Task with a design-backed visual criterion, Verify…,
  Record my review… (attestation + typed key), record, verify again — the visual criterion
  should read satisfied naming the commit and the evidence list should carry the
  `person_acceptance` row; also pick a checkpoint two attempts both recorded and check the
  action stays unavailable with the sentence that says why.
- `inspect_fleet` rendering of a `verify-…` row and Stop from it in a live shell (unit tests
  pin the row through the same `tasks.tasksOf` array the fleet reads — a proxy, named as one).

## Next step for the parent

One final correction batch may take S1 (with the real-shape seam test), the S2 extraction if
wanted, the S3 hard-wiring, and whichever way the parent answers O1; O2 is a one-line
alignment. After the batch, the parent runs the full gate; this review is not a second round —
these are the only findings this review produces.
