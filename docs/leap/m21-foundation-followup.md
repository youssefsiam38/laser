# M21-T14 follow-up — the three gaps the foundation left open

Owner: worker "Complete foundation integration", branch
`agents/complete-foundation-integration-775d8b76`, base `408366ae`
(`work/fallback-update`, T10/T11/T12/T13/T14 + T18/T21 merged).

This is **not a redesign**. The T14 implementation on `9ba83ea9` stands; this
closes the three gaps its own plan named as deviations, plus the greenfield
entry path, against the acceptance in `PLAN.md` M21-T14 and
`docs/design-phase.md` "Case A · Foundation mode" / "Model profiles".

Binding text re-read before this plan: `AGENTS.md`, `STATUS.md` (summary
stale, ledger current), `docs/goal-project-lifecycle-leap.md`,
`docs/design-phase.md` (Case A, "Model profiles", "What a person sees"),
`docs/model-profiles.md` ("Assignments"), `docs/leap/m21-design-plan.md`
(T11/T13/T14 sections, T14 deviations 1 and 2 and decision 6),
`docs/leap/m21-design-index-plan.md`, `PLAN.md` M21-T14.

## The three gaps, as observed in the tree

| # | Gap | Where |
| --- | --- | --- |
| 1 | The Design-index profile is never wired: `ProjectWorkSession.foundationModels` is never passed by `server.ts`, and `ProjectDesignIndex.synthesis` likewise. Every foundation step and every L1 synthesis is therefore the neutral/absent path on every machine | `packages/worker/src/server.ts`, `design/index/bridge.ts`, `project-work/session.ts` |
| 2 | `FoundationTokenEditor` re-implements the Settings row instead of sharing it (T14 decision 6 named it and left it) | `packages/ui/src/components/design/FoundationTokenEditor.tsx`, `settings/appearance/TokenEditor.tsx` |
| 3 | `DesignDetail` returns early whenever `draft.foundation` exists, which hides T13's Index/Foundation/Screens/Flows/Review sections; the real Foundation section is still a read-only summary | `packages/ui/src/components/project-work/bodies/DesignDetail.tsx` |
| 4 | Greenfield entry: nothing in the window offers "Start a foundation"; a design with no screens says screens arrive from the index even when the project has no index at all | same file |

## Decisions taken inside the contracts

1. **The Design-index profile inherits only when nothing is assigned.** An
   **absent** assignment takes the ordinary rule,
   `resolveProfile(profiles, assignments, "designIndexProfileId")` — the
   default for new sessions, then the first profile — because
   `docs/model-profiles.md` gives this surface a default (Smart) and records
   no opt-in exception; the opt-in rule is naming's, and that doc records
   naming's deviation explicitly. An **explicit** assignment is never traded
   for another profile: a profile the person chose for design work that holds
   no model, or whose every model is spent, leaves design work on the parse
   and the neutral foundation *with the reason*, rather than quietly spending
   a profile they did not pick for this. An assignment whose profile was
   deleted is gone, not unusable, and inherits like any absence. A machine
   with no profile at all resolves to `null`, which is the honest fallback
   both engines already have. No new credential, runtime or setting.
2. **The profile is read per use, not per construction.** `ProjectDesignIndex`
   lives for the life of the worker and a `ProjectWorkSession` for the life of
   a session; a profile assigned in Settings in the meantime must count. So
   both options become thunks resolved at the moment of use
   (`synthesis?: () => …` read when a build starts, `foundationModels?: () =>
   …` read inside the tool binding's `run`). `SynthesisOptions` and
   `FoundationModelAccess` themselves stay the pure shapes they are.
3. **The shared editor is the row, not the editor.** The two editors have
   genuinely different targets (Settings: this app's fixed `Theme` token
   names, derived/pinned, its own contrast rule; Foundation: a DTCG document
   with the person's names, aliases, modes, non-colour values). What is
   duplicated is the *row*: the layout, the draft-while-typing field, the
   swatch, the hairline, the readout typography. That is what is extracted,
   with a Theme adapter and a DTCG adapter on top of it. Extracting the whole
   editor would mean teaching one component two token models.
4. **"Start a foundation" hands off to the chat; it does not fabricate one.**
   A foundation step is proposed by the worker (models, or the neutral
   starting point with its note); the window cannot make one. The greenfield
   offer therefore puts the request in the composer the way "Implement…"
   does, and says so. Writing an empty `foundation: {}` into a revision to
   make the wizard appear would be exactly the fake empty-state success the
   brief forbids.

## Exact seams

### Worker — the profile wiring

| File | Change |
| --- | --- |
| `packages/worker/src/design/profile.ts` (new) | `chooseDesignProfile(profiles, assignments)` — the rule, pure — plus `designProfileChoice(agentDir)` (never throws) and `designModelAccess({ agentDir, models }): { models; profile; unavailable? }`, the one shape both engines take. `unavailable` is one sentence a person can act on, carried into the synthesis gap and the step's note |
| `packages/worker/src/design/index/bridge.ts` | `ProjectDesignIndexOptions.synthesis` becomes `() => DesignBuildOptions["synthesis"] \| undefined`, resolved in `startBuild` |
| `packages/worker/src/project-work/session.ts` | `foundationModels` accepts a thunk; `designTools()` resolves it inside `run` (design options/registration only — T19's verification registration untouched) |
| `packages/worker/src/server.ts` | one private `designModels()` built from `design/profile.ts` with `this.options.designModels ?? (() => this.modelCatalog().modelRuntime())`, exactly as naming does; passed to `designIndex()` (`synthesis`) and to `projectWorkSession()` (`foundationModels`). One new option `designModels?: () => Promise<CompletionRuntime>` beside `namingModels`, for tests |
| `packages/worker/src/design/index/l1-synthesis.ts` | `SynthesisOptions.unavailable`, used as the no-profile gap's first sentence ("connected", matching the foundation's note, now that inheritance means `null` = no profile anywhere) |
| `packages/worker/src/design/foundation/{neutral,proposals}.ts` | `foundationFallbackNote(reason)` composes the same fact + the tail `FOUNDATION_FALLBACK_NOTE` already said; a step with nothing to ask now names *which* profile had nothing in it |

### UI — the shared token row

| File | Change |
| --- | --- |
| `packages/ui/src/components/tokens/TokenEditorRow.tsx` (new) | `TokenEditorRow` (label, optional swatch, value field that keeps its own draft, commit predicate, `aria-invalid`, trailing status slot, trailing action slot, hairline, two width variants) and `TokenContrastReadout` (`x.xx:1` + the sentence, danger when it fails). Tokens only, nothing below 12px, both editors' current aria-labels preserved verbatim |
| `settings/appearance/TokenEditor.tsx` | its `TokenRow` becomes the Theme adapter over the shared row: same groups, same `readout()`, same derived/pinned "Derived" button, same labels |
| `components/design/FoundationTokenEditor.tsx` | its `TokenRow` becomes the DTCG adapter over the shared row: alias handling, non-colour rows without a swatch, read-only, same labels |

### UI — the Foundation section and the greenfield entry

| File | Change |
| --- | --- |
| `bodies/DesignDetail.tsx` | the `draft.foundation` early return is deleted. The Foundation **section** renders `FoundationWizard` (edits, accept, approve, plan, superseded diff) and keeps the read-only summary for a design that has no foundation. `section` defaults to `foundation` when a foundation exists and there are no screens; Index/Screens/Flows/Review keep working beside it. With no screens, the canvas area shows an honest "nothing drawn yet" note instead of an empty canvas, and the fidelity badge and Prototype/Full screen are absent rather than claiming "Mapped" for zero screens. The empty-state branch is entered only when there is no foundation, and it then offers **Start a foundation** (composer hand-off, per decision 4) when the project has no index to compose from |

Supersession is unchanged: `FoundationWizard` already takes `liveIndex` (the
parent merge resolved that), so a built index still supersedes the proposal
and shows the token-name diff — now inside the section, with the other four
sections still reachable.

## Tests

| Test | Proves |
| --- | --- |
| `packages/worker/test/design/profile.test.ts` (new) | `designIndexProfileId` is honoured; an unassigned surface inherits `defaultProfileId`; a machine with no profiles resolves to `null`; a broken/absent settings file resolves to `null` rather than throwing |
| `packages/worker/test/design/synthesis.test.ts` (extend) | the bridge calls its synthesis thunk per build, so a profile assigned after construction counts |
| `packages/worker/test/design/server-profile.test.ts` (new) | **end to end through `server.ts`**: a real settings file with `designIndexProfileId`, `WorkerServer` with a fake completion runtime, `design/index/build` on a fixture project → the fake is asked for exactly the configured profile's model and the built index records `builtWith.profileId`; with no profile in the file, no completion is attempted and the index carries the honest gap |
| `packages/worker/test/design/foundation.test.ts` (extend) | `ProjectWorkSession.designTools()` → `propose_foundation` runs on the access the thunk returns (recorded model), and the neutral path with its note survives when the thunk returns a `null` profile |
| `packages/ui/test/settings/token-editor.test.tsx` (new, written and green **before** the extraction) | Settings behaviour unchanged: pinned vs derived, "Derived" unpins, the contrast readout measures the typed value, a half-typed value is not committed |
| `packages/ui/test/design/foundation.test.tsx` (extend) | the wizard's edits/approval/plan/superseded still hold **and** the other four sections are reachable from the same body; a built index still supersedes inside the section |
| `packages/ui/test/design/detail.test.tsx` (extend) | a design with a foundation still shows Index/Screens/Flows/Review; a design with no foundation and no index offers "Start a foundation" and puts the request in the composer (no revision written) |

## Validation (run, with results)

Revision under test: this branch at the commit below, worktree
`.worktrees/complete-foundation-integration-775d8b76`.

| Command | Result |
| --- | --- |
| `pnpm -F @lasercode/worker exec vitest run test/design/profile.test.ts test/design/synthesis.test.ts` | 20 passed |
| `pnpm -F @lasercode/worker exec vitest run test/design/server-profile.test.ts` | 5 passed (the end-to-end server wiring) |
| `pnpm -F @lasercode/worker exec vitest run test/design/foundation.test.ts` | 35 passed (33 before + 2 new) |
| `pnpm -F @lasercode/worker test` | **1633 passed**, 4 skipped, 132 files |
| `pnpm -F @lasercode/ui exec vitest run test/settings/token-editor.test.tsx` | 7 passed **before** the extraction and 7 passed **after** it — the same suite, unchanged |
| `pnpm -F @lasercode/ui exec vitest run test/design` | 97 passed |
| `pnpm -F @lasercode/ui test` | **3281 passed**, 1 skipped, 352 files |
| `pnpm -r build` | Done, every package |
| `pnpm -r typecheck` | Done, every package |
| `pnpm identity:check` | "every generated file agrees, no stray literals" |

No browser run of any kind (D-342). No new dependency. Visual acceptance of
the Foundation section, the greenfield offer and both token editors in both
themes and both widths is the person's.

## What the tests actually prove

| Claim | Proof |
| --- | --- |
| The server invokes the configured profile for **L1 synthesis** | `test/design/server-profile.test.ts` — a real settings file with `designIndexProfileId`, a `WorkerServer` with a stub completion runtime, `design/index/build` over `server.handle`: the stub is asked for exactly the assigned profile's model (`["smart-1"]`, never the default's), and the built index records `builtWith.profileId`/`model` and `layers: ["l0","l1"]` |
| The server invokes the configured profile for **Foundation proposals** | same file — the `ProjectWorkSession` the worker hands the driver at `open()` is captured, its `propose_foundation` binding is run, the host's `project/work/create` is answered over the real worker→host link, and the assigned profile's model is the only one asked |
| The honest fallback is retained | same file — with no profile on the machine nothing is asked, the index carries "No model profile is connected for design work" in its gaps and is still written from the parse; the foundation step comes back `fallback: true` with the neutral note |
| Configured vs default, and exhaustion | `test/design/profile.test.ts` (assigned wins; absent inherits default, then first; a deleted assignment inherits; an assigned profile with no model is **kept** with its reason) and `test/design/synthesis.test.ts` ("every model of the profile answered unusably" → said, no second profile tried) |
| The profile is read per use | `test/design/foundation.test.ts` "the session's binding" — nothing is read at registration, one read per call, and a profile that appears between two calls is used by the second |
| Settings behaviour is unchanged | `test/ui/settings/token-editor.test.tsx` green against the old row and the new shared one, unmodified between the two runs |
| Wizard edits/approval/plan and T13's sections coexist | `test/design/foundation.test.tsx` — five sections on a design with a foundation, Foundation open first, Index/Screens/Review reachable, an edit in the section saved by the detail's own Save; the existing approval, plan and superseded tests still pass through the section |
| A built index supersedes | unchanged `once the built source is indexed` test, now asserting inside the section |
| The greenfield offer writes nothing | `test/design/detail.test.tsx` — the request goes into the composer naming `@DES-3`, `calls` is empty (no revision, no fabricated foundation), and the offer says nothing about the project while the index is loading or failed |

## Out of scope, deliberately

Host, protocol method families, `PLAN.md`/`STATUS*`, verification modules and
`TaskDetail` (M21-T19 is live in another worktree). If the wiring turns out to
need a protocol or host change, that stops and is reported rather than taken.

## Shared files touched (smallest edit that closes the gap)

- `packages/worker/src/server.ts` — one option (`designModels`), one private
  `designModels()`, and the two lines that pass it to the index and the
  session. Nothing else in that file moved.
- `packages/worker/src/project-work/session.ts` — the `foundationModels`
  option type, one private resolver and the binding's `run`. M21-T19's
  verification registration is untouched.
- `packages/ui/src/components/settings/appearance/TokenEditor.tsx` — its row
  became an adapter; the groups, the contrast rule and the copy are as they
  were.
- New: `packages/worker/src/design/profile.ts`,
  `packages/ui/src/components/tokens/TokenEditorRow.tsx`.

## Known limits, named

1. **The readout measures the last value the target took**, not a half-typed
   one. For a colour that is the same thing (a value commits the moment it
   parses); while a value is unparseable the Foundation editor used to
   recompute a readout from it and now shows the row's type instead. Settings
   behaved this way already.
2. **An assigned profile holding no model is unreachable from a settings
   file** — `readModelProfilesValue` drops a profile with no models, so the
   assignment dangles and inherits. The rule is still implemented and proved
   over `chooseDesignProfile` directly, because a profile can reach the
   engines from elsewhere and "never substitute an explicit choice" is the
   binding behaviour.
3. **The Design tab's case picker** ("Design a new page" / "Change an existing
   page" / "Start a foundation" as a header override across the whole tab) is
   the workspace shell's; what landed here is the override on the Design
   itself, in the Foundation section and on an empty design, which is the
   surface this task owns.
4. Model profiles, the composer and the chat are not touched: the request the
   offer writes is ordinary composer text, sent by the person.

## Checkpoints

- Contracts read, gaps confirmed in the tree, plan written, approved with four
  refinements (explicit assignment never substituted; thunk resolved at the
  build/tool boundary; shared row with adapters; composer hand-off naming the
  exact key, header override kept in established projects, no claim of absence
  before the index has answered). All four are implemented as approved.
- Worker wiring + tests, UI shared row + adapters, Foundation section and the
  greenfield entry, full validation above. Done.

## Independent-review correction batch (F1–F4)

Owner: worker "Finish design review corrections", branch
`agents/finish-design-review-corrections-10539c04`, base `48479e57` with
`agents/complete-foundation-integration-775d8b76` merged into it (merge commit
first on the branch; `b2f2d4e9` and `bfd81088` preserved verbatim — nothing
from the earlier owner was rewritten or reverted).

The findings are `docs/leap/m21-design-integration-review.md`, triaged by the
parent into one batch. Nothing here re-opens the repairs that review verified;
every change is additive to them.

### F1 · `DesignDetail.tsx` decomposed along the seams it already had

1 117 → **686 lines**, pure orchestration: the draft and its save, the
selection, the wire, the render contexts, which section is open. What moved,
unchanged in behaviour and with the same injectable props the existing tests
use:

| Moved out | To |
| --- | --- |
| `ReviewSection` (pins, grounding report, before/after) | `components/design/ReviewPanel.tsx` (`ReviewPanel`) |
| `FlowsSection` + `flowActionLabel` | `components/design/FlowsPanel.tsx` (`FlowsPanel`) |
| `FoundationSection`, `FoundationStart` and their copy | `components/design/FoundationSection.tsx` |
| `ImplementControl` + `IMPLEMENT_SENTENCE` | `components/design/ImplementControl.tsx` |
| `readBlob`/`decodeBase64` + the `BlobRequest` shape | `src/design/blob-read.ts` (bounded page budget named there) |

State ownership is exactly as it was: `ReviewPanel` keeps its own
compare-revision reading, everything else stays a pure function of props.
`DesignDetail` re-exports `IMPLEMENT_SENTENCE`, `foundationRequestFor`,
`FOUNDATION_PENDING_SENTENCE`, `FOUNDATION_START_SENTENCE` and
`FoundationStart`, so its public surface — and the existing tests' imports —
did not move. No generic framework, no LOC target: the seams are the five
sections the contract already names.

### F2 · An accepted step is the person's to reopen

`proposeFoundationStep` no longer passes `{ replace: true }`
(`packages/worker/src/design/foundation/proposals.ts`), so the protocol's
`already_accepted` refusal is reachable on the model path — before any model
is asked, so a refused call spends nothing. The refusal's `next` is the act
that expresses the person's intent: *reopen this step in Foundation before
proposing it again* (`FOUNDATION_REOPEN_NEXT`). No `reconsider` boolean was
added: a flag the model sets is the model asserting the person's consent, not
carrying it. The wizard's existing **Reopen** button plus Save is the real
consent path, and it works unchanged — the reopened step is stored as
`proposed` on a new revision, and the tool may then propose it.

Tests (`packages/worker/test/design/foundation.test.ts`): the default refusal
with its code, its sentence and zero completions spent; the whole persisted
path — propose → person accepts and saves → tool refused → person reopens and
saves → tool proposes — asserting four distinct revisions, four distinct
digests, `revisionCount` 4, the earlier revisions still there, and that a
write fenced by the superseded revision is still refused.

### F3 · One ordered step-record replacement, shared

`withFoundationStep(foundation, record)` in
`packages/protocol/src/design-foundation.ts` is now the only place a step row
is written. The worker's `withStep` is that function; the window's `withStep`
writes its patch through it. The two *patch semantics* stay distinct on
purpose — the worker replaces with a record it just composed, the window
patches the record it is showing and does nothing for a step nobody proposed —
which is why this is a replacement helper and not a reducer. An id outside the
fixed order sorts last rather than being dropped.

### F4 · The small honesty and bound gaps

| Gap | Fix |
| --- | --- |
| `complete()` swallowed every failure | It now answers `{ ok: false, reason }` and the loop pushes one `issues` line per model: not connected on this machine, no answer within *n* seconds, stopped, could not be reached, answered with nothing. The provider's own error text is **never** quoted — it can carry the endpoint, a header or a key — so the class of failure is what is said. The tool bounds the answer to its own schema (8 issues, 500 chars each). |
| The window's save gate ignored index entries | `DesignDetail` builds one vocabulary (`primitives` + `entryIds` when a live index is readable) and validates both the save and the inline problem list with it, so a node pointing at an entry a review merged away is refused. With no index read, the kit names are all it checks — it invents no refusal it cannot justify. |
| `DesignWorkspace.tracked` never pruned | Finished builds are bounded to the last 8 (`FINISHED_BUILDS_KEPT`). A running build is never counted and never evicted; the terminal row is published **before** the prune, so the fleet never loses a build's final state; Stop stays idempotent and still answers for a build that has been forgotten. |

Tests: `packages/worker/test/design/foundation.test.ts` (transport/timeout/
cancel/missing-model issues, no secret in the issue or the record, bounded
answer), `packages/worker/test/design/workspace.test.ts` (eviction order,
terminal row before cleanup, running never evicted, Stop twice and after
eviction), `packages/ui/test/design/detail.test.tsx` (the index-aware save
gate, both ways), `packages/protocol/test/design-foundation.test.ts`
(`withFoundationStep`).

### Validation (this batch, run in this worktree)

| Command | Result |
| --- | --- |
| `pnpm -F @lasercode/protocol exec vitest run test/design-foundation.test.ts test/design-workspace.test.ts` | 26 passed (25 + 1 new) |
| `pnpm -F @lasercode/worker exec vitest run test/design` | 214 passed, 15 files (204 + 10 new) |
| `pnpm -F @lasercode/ui exec vitest run test/design test/settings/token-editor.test.tsx` | 115 passed (113 + 2 new) |
| `pnpm -F @lasercode/host exec vitest run test/router.design.test.ts` | 6 passed |
| `pnpm -r build` | Done, every package |
| `pnpm -r typecheck` | Done, every package |
| `pnpm identity:check` | "every generated file agrees, no stray literals" |

No browser run of any kind (D-342). No new dependency. No edit to the server
prompt/admission/driver/companion turn context, the verification and Fleet
handlers (T19), the host canonical store or interop.

### Limits of this batch, named

1. **Gate staleness after a reopen is not proved here.** *(Closed by the
   approval-authority follow-up below.)* The worker harness
   (`ScriptedProjectWorkWorld`) keeps revisions and the stale fence but models
   no gates. The host-side proof now lives in
   `packages/host/test/project-work/foundation-approval.test.ts`.
2. **Visual acceptance stays the person's**: the five sections after the
   extraction (nothing about what is drawn changed, but the files did), the
   Foundation section and the greenfield offer in both themes and widths.
   `pnpm -r build && pnpm sandbox`, Design tab on a fixture project.
3. The refusal sentence a model sees combines the protocol's message ("…is
   already accepted. Propose it again only when the person asks…") with the
   worker's `next`. The protocol string itself was left alone deliberately —
   this batch is additive in `packages/protocol`.

## Approval authority — what makes a foundation approved

Same owner and branch as the batch above; second commit. This closes the
approval item the batch left open, after the parent's diff inspection found a
real gap in the wizard:

> `FoundationWizard` read `approved = foundation.status === "approved" ||
> foundation.profile !== undefined`, and the approve flow **writes that body
> before** asking the host to approve it. A refused gate, or a reopen that
> carries the fields along, therefore left the badge saying **Approved** and
> offered **Create the plan** over a decision nobody had recorded. The
> standalone branch said "this project has no design gate" and recorded
> nothing at all, although the host explicitly supports an off-gated-path
> `project/work/approve` with exact covers (D-352, `gates.ts` `check`).

### What the authority actually is

`packages/host/src/project-work/store.ts` and `gates.ts`, unchanged by this
work and now proved from the outside:

| Fact | Where |
| --- | --- |
| Off the gated path a decision is legal and durable: no Spec, no gate report, the approval is recorded on the design itself | `gates.ts` `check` — `if (!spec \|\| !report \|\| !report.gated) return { ok: true }` |
| Every covered revision must be exactly what the store holds | `store.ts` `approve` — refuses "changed since this was prepared" |
| Only a person approves, and `draft` has no edge to `approved` | `approve` + `artifactTransition` — hence `request_review` first |
| A material revision invalidates the approvals that cover it; an identical-bytes save invalidates nothing | `store.ts` `invalidateApprovals` — "the digest is the test of material" |

### What changed in the window

| File | Change |
| --- | --- |
| `packages/ui/src/design/foundation.ts` | new `foundationApprovalState({ foundation, approvals, entityId, digest, dirty })` → `{ approval, approved, unbacked? }`. It takes the **last `design` decision still standing** for the bytes on screen — not invalidated, covering this entity at **the digest on screen** — and only then asks whether that decision was `approved`; approved also requires a complete foundation and no unsaved edits. The order matters: the host appends a `changes_requested` or `archived` row **beside** the approval it overrides without invalidating it (`store.approve`), so filtering for approvals first would resurrect a superseded one. This is the same reading the host's own gate engine uses (`settledApproval`). `unbacked` is the sentence for a body that carries the marker with nothing behind it |
| `packages/ui/src/components/design/FoundationWizard.tsx` | badge, the profile-digest line, **Create the plan** and the approve block all read that state instead of `foundation.status`/`profile`. A new `[data-slot="foundation-unbacked"]` note says which of the four cases it is (edited here, a step reopened, an approval invalidated, or a decision that was never recorded). The standalone branch now **records the approval**: `request_review` when the design is still a draft, then `project/work/approve` with `covers = [this design at the revision the host just answered with]`, and says so; a host refusal is an error toast and nothing is claimed |

The digest — not the revision id — is what the window matches on, because that
is what the host binds: a save that changed no bytes keeps the approval, and
matching the revision id would have contradicted the host's own rule.

### Staging, named honestly

The approved marker (`status: "approved"` + `profile.digest`) **must** be
written into the revision *before* the host decision, because the decision
covers the revision that carries the digest; writing it afterwards would
invalidate the approval it recorded. So a refused or abandoned approval leaves
a revision whose body claims more than happened. This batch does not pretend
otherwise: the body keeps the marker, no surface reads it as a decision, and
the wizard says in one sentence that nothing backs it and offers the approval
again. The host test asserts exactly this — a reopened revision still carrying
`status: "approved"` with its approval invalidated.

### Tests

`packages/host/test/project-work/foundation-approval.test.ts` (new, 7 tests,
Router + real store, no worker, **no host production writes**):

- a design no Spec gates has no gate report, and is still approved on itself —
  person actor, covers = exact revision **and** digest, entity `approved`;
- covers whose digest is not what the store holds are refused, and nothing is
  recorded;
- approving a design nobody asked a decision on is refused (`draft cannot
  become approved`), which is why the window sends for review first;
- **reopening a step invalidates the approval** and takes the design out of
  `approved`, while the body still claims `status: "approved"` — the point;
- an edit to the foundation's content does the same;
- a byte-identical save keeps the approval (state returns to `draft`, which is
  the review spine's rule, named in the test);
- settling it again records a second, valid approval beside the invalidated one.

`packages/ui/test/design/foundation.test.tsx` — decision ordering (4 tests):
approved then `changes_requested` on the same digest reads as not approved
with the sentence that says so; approved then `archived` likewise; a fresh
approval after a change request restores it; a decision covering other bytes
is ignored.

`packages/ui/test/design/foundation.test.tsx` (5 further tests): a staged profile
is not an approval (no badge, no plan, the sentence, the offer still there);
an invalidated approval stops reading as approved; reopening a step in the
wizard stops it immediately and writes nothing; a refused host gate records no
decision and claims nothing; the standalone path calls `request_review` then
`approve` with the host's own revision and digest. The existing "creates the
plan" test now supplies a real approval row, which is the behaviour change in
one line.

### Validation (approval follow-up)

| Command | Result |
| --- | --- |
| `pnpm -F @lasercode/host exec vitest run test/project-work/gates.test.ts test/project-work/foundation-approval.test.ts test/router.design.test.ts` | 31 passed |
| `pnpm -F @lasercode/ui exec vitest run test/design test/settings/token-editor.test.tsx` | 120 passed |
| `pnpm -F @lasercode/worker exec vitest run test/design` | 214 passed |
| `pnpm -F @lasercode/protocol exec vitest run test/design-foundation.test.ts test/design-workspace.test.ts` | 26 passed |
| `pnpm -r build` / `pnpm -r typecheck` / `pnpm identity:check` | all clean |

### Limits, named

1. **The window needs the approvals on the read.** `WorkDetail` and the
   Inspector both ask for `include.approvals`, so the detail the Design body
   renders from carries them; a caller that read a design without them would
   see an approved foundation as unapproved (never the other way round, which
   is the safe direction).
2. **Entity state is not the badge.** A revised design returns to `draft` even
   when the bytes did not change; the foundation badge follows the approval
   row and its digest, and the two can disagree in exactly that case.
3. The unbacked note is drawn in tokens only (`border-line`, `bg-surface-2`) —
   no new colour ratio was introduced for it.
4. Visual acceptance of the new note and the standalone toast is the person's.

## Review fix (parent diff inspection)

`FoundationStart`'s `absent` copy said "there is no interface code to compose
from". A missing index proves only that no index has been built here — only an
index build reads the source — so the sentence now says exactly that and names
what would answer the question, and the override stays available either way.
`test/design/detail.test.tsx` gains "never reads an absent index as an absence
of interface code", named in the test as the **copy proxy** it is: it asserts
the sentences the offer shows, not source discovery.
Validated: `pnpm -F @lasercode/ui exec vitest run test/design` → 106 passed;
`pnpm -F @lasercode/ui exec tsc --noEmit` → clean.

## Parent integration: gated draft-to-review transition

The final host test establishes that `draft → approved` is refused. Staging a
profile creates a draft for gated Designs too, but the window only requested
review on the standalone path. Parent reproduced the missing call with a
request-order assertion (red: review index -1), then added the same fenced
review transition before gated approval. A refused review stops before any
approval request. No host authority changed.

Validation on the integrated tree: UI design/shared-token tests 125 passed,
UI typecheck passed, host foundation/gate/router tests 31 passed, identity
check passed. The UI tests prove actual request fields/order; host tests prove
the state rule. They are not browser acceptance. Full merged verification
passed build/typecheck and all non-UI packages but hit an unrelated image-pool
fixture assertion, separately owned under M16-T82. No full gate is claimed.
