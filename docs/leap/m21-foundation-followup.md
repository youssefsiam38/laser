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
