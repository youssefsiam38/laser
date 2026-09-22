# M21-T13 + T14 integration review — design workspace, greenfield foundation, profile wiring

Reviewer: independent review of the combined Design milestone slice. Target under
review: `agents/complete-foundation-integration-775d8b76` at **bfd81088**
(worker stopped, tree clean), comprising original T13 `4d10cffd`, original T14
`9ba83ea9`, parent conflict integration `408366ae`, follow-ups `b2f2d4e9` and
`bfd81088`. T18/T19 verification and T21 interoperability are other reviewers';
not covered. One review cycle; the parent triages one fix batch to a continuing
owner.

## Verdict

The combined behaviour is real and the prior findings the parent returned are
repaired, with genuine tests behind each repair. Three findings carry forward,
one structural and two behavioural; none re-opens the repairs. The structural
one should be fixed in the triaged batch.

## What was verified as repaired (parent's earlier findings)

| Prior finding | Evidence of repair |
| --- | --- |
| Missing profile wiring (L1 and Foundation both ran the neutral/absent path everywhere) | `packages/worker/src/server.ts:2296-2322` builds one `DesignModelAccess` per use from `design/profile.ts` and passes it as a thunk to both `ProjectDesignIndex` (`synthesis`, resolved at `startBuild`, `packages/worker/src/design/index/bridge.ts:60-62`) and `ProjectWorkSession` (`foundationModels`, resolved inside the tool binding's `run`, `packages/worker/src/project-work/session.ts:206-221`). `packages/worker/test/design/server-profile.test.ts` proves it end to end through `WorkerServer`: a real settings file with `designIndexProfileId`, a stub completion runtime, `design/index/build` over `server.handle` asks exactly `smart-1` (never the default's `balanced-1`) and records `builtWith.profileId`; the `ProjectWorkSession` handed to the driver at `open()` is captured and its real `propose_foundation` binding is run, with the host's `project/work/create` answered over the live bridge. With no profile, nothing is asked and the honest gaps/note are recorded. |
| Duplicated token editor row | `packages/ui/src/components/tokens/TokenEditorRow.tsx` is the one row both editors draw; `settings/appearance/TokenEditor.tsx:163-199` is the Theme adapter, `components/design/FoundationTokenEditor.tsx:109-171` the DTCG adapter. `test/settings/token-editor.test.tsx` (7 tests) was written against the old row and re-run unchanged against the shared one — reported and re-verified here (green). |
| `DesignDetail` early return hiding the other four sections | The `draft.foundation` early return is gone (`packages/ui/src/components/project-work/bodies/DesignDetail.tsx:703-751`): the wizard mounts in the Foundation section beside Index/Screens/Flows/Review; `test/design/foundation.test.tsx:283` asserts the five sections coexist and a superseded index diff shows inside the section. |
| "No index" copy claiming no interface code | `FoundationStart` (`DesignDetail.tsx:771-798`) now says only that no index has been built here and names what would answer the question; `test/design/detail.test.tsx:155` names itself a **copy proxy** and asserts the sentences shown, not source discovery. |

## Acceptance checks run against bfd81088

- Real configured `designIndexProfileId` through the server for **both** L1 and
  Foundation — proven above. Bounded one-shot per step: one completion attempt
  per model in the chosen profile, in order, 45 s each
  (`packages/worker/src/design/foundation/proposals.ts:665-694`), then the
  neutral fallback with the reason. Intent honoured: an explicitly assigned
  profile is never substituted, even when it holds no model
  (`packages/worker/src/design/profile.ts:78-100`); a deleted assignment
  inherits; a machine with no profile resolves to `null` with the sentence.
- Ordered editable proposals: the order rule is the protocol's
  (`packages/protocol/src/design-foundation.ts:104-158`), used by the tool
  (`proposals.ts:584`) and by the wizard; each step editable, acceptance is the
  person's, everything stays `proposed` (`storage.ts`, `tools.ts`).
- Licence constraints: `unknown` blocks and says so; exact pin required for a
  recommendation; `MIT OR GPL` taken at its most permissive branch, copyleft
  refused with a sentence (`licence.ts`). The wizard lists blocked sources and
  the Plan's foundation task repeats them in its notes
  (`design-foundation.ts:255-257`).
- Proposal repo unchanged before Build: `storage.ts` imports no filesystem API;
  `packages/worker/test/design/foundation.test.ts:288` proves the project
  directory byte-identical after a whole foundation, and the module-graph proof
  at line 520 pins the no-`node:fs` import.
- Approval: digest over `foundationCanonicalJson` (status/profile/supersededBy
  excluded), computed by the caller's crypto (worker `createHash`, window
  `crypto.subtle` over the same bytes); the wizard revises, then reads the
  gate back and passes the **host's own** `covers` to `project/work/approve`
  (`FoundationWizard.tsx:98-146`); unsaved-draft approval refused; Enter never
  approves.
- Foundation-first Plan and supersession: `foundationPlanSkeleton` puts exactly
  one Task in the first phase and every other Task depends on it
  (`design-foundation.ts:288-371`); a built index supersedes inside the
  section with the token-name diff.
- Parse-only and static grounding: no `child_process`/net/http in
  `packages/worker/src/design/**`; `test/design/parse-only.test.ts` pins it.
  `ground_sketch` is deterministic text-only parsing whose answer is validated
  with `validateDesignBody` before it is returned
  (`packages/worker/src/design/sketch/ground.ts:341-360`); logic becomes
  included or skipped-with-reason states; nothing from the sketch executes or
  survives except as states/fixtures.
- Reference image: first repository-referenced screenshot only, bounded,
  typed, person-supplied images never travel this way
  (`packages/worker/src/design/workspace.ts:396-432`). Paths come from the
  project's own scanned file set, so no traversal out of the project.
- Host authority: the six `design/*` methods resolve the opaque project id,
  refuse an unknown project, `assertProject` the resolved root, and forward
  with the resolved directory, discarding the caller's `cwd`; the worker
  refuses any directory but its own (`packages/host/src/router.ts:417-455`,
  `packages/worker/src/server.ts:2262-2281`). Method policy: read for
  `design/index/get`, `project_write` for the rest
  (`packages/protocol/src/method-policy.ts:402-417`).
- Honest states and copy: no fidelity badge over zero screens
  (`DesignDetail.tsx:468`), "Start a foundation" writes nothing and claims
  nothing while the index is loading/failed/erroring (`detail.test.tsx:140-215`),
  sketch-only designs cannot be handed off, unreviewed chips carried on mapped
  nodes, fallback steps carry the neutral note naming the profile that had
  nothing in it.
- Token editor: real shared row (`TokenEditorRow`), contrast of the value as
  typed, foundation floor honoured, aliases resolved before measuring,
  non-colour rows without a swatch.

## Tests re-run in the target tree (this review, bfd81088)

| Command | Result |
| --- | --- |
| `pnpm -F @lasercode/protocol exec vitest run test/design-foundation.test.ts test/design-workspace.test.ts` | 25 passed |
| `pnpm -F @lasercode/worker exec vitest run test/design` | 204 passed, 15 files |
| `pnpm -F @lasercode/ui exec vitest run test/design test/settings/token-editor.test.tsx` | 113 passed |
| `pnpm -F @lasercode/host exec vitest run test/router.design.test.ts` | 6 passed |

## Findings, in priority order

### F1 · Structural — `DesignDetail.tsx` crossed 1 000 lines inside this scope

**`packages/ui/src/components/project-work/bodies/DesignDetail.tsx` — 1 117
lines.** The file was 554 lines before T13 (`4d10cffd~1`); T13 alone took it to
991, and the parent integration plus the follow-ups pushed it to 1 117. It now
holds, in one file: the detail shell, draft/save/conflict, selection, blob
reading, sketch grounding, five sections' wiring, and four whole local
components that are modules in all but name — `FoundationSection` (line 705),
`FoundationStart` (771), `FlowsSection` (800), `ReviewSection` (860, ~200
lines of pins + before/after), `ImplementControl` (1058), plus
`decodeBase64`/`readBlob` (103, 1092) and the section constants.

Violated contract: the repo's own review standard — a change that pushes a
file past 1 000 lines needs a decomposition, and the seams here are already
drawn (each section is a pure function of props). This is the one file every
design task will keep touching (T15+ stale marking, T17 hand-off, T22
hardening all land here or beside it).

Minimal remedy (behaviour-preserving, one batch): move `ReviewSection` +
`DesignPin`-list rendering into `components/design/ReviewPanel.tsx`,
`FlowsSection` into `components/design/FlowsPanel.tsx`, and
`FoundationSection`/`FoundationStart`/`ImplementControl`/`readBlob` into
`components/design/FoundationSection.tsx` (or split the blob reader into
`src/design/blob-read.ts`). `DesignDetail` drops to roughly 650 lines of pure
orchestration and every extracted unit already has injectable props from the
existing tests.

### F2 · Behaviour sharpness — an accepted step can be rewritten by a tool call, with no person-intent signal

`packages/worker/src/design/foundation/proposals.ts:584` calls
`checkFoundationStepOrder(foundation, stepId, { replace: true })`
unconditionally, which makes the `already_accepted` refusal
(`packages/protocol/src/design-foundation.ts:143-153`) unreachable on the
model path. The protocol comment is explicit that re-proposing an accepted
step is refused "so an accepted decision is never quietly rewritten" and is
overridden only "when the person asks"; `propose_foundation` has no input that
carries that ask (`packages/worker/src/design/foundation/tools.ts:47-79` —
`step`, `key`, `entity_id`, inputs, `idempotency_key`, nothing else). A model
can therefore name an accepted step, replace its content, and drop its record
back to `proposed`. Nothing hides it — the wizard shows the step as `Proposed`
again — but no record says the person asked for the reconsideration, and no
test pins either behaviour on this path.

Violated contract: `docs/design-phase.md` "Case A" — "ordered and each
editable"; the protocol's own stated rule for accepted steps.

Minimal remedy: add a `reconsider` boolean to the tool input (refusing an
accepted step without it, so the chat has to say the person asked) and/or fold
a `note` onto the new record naming that it replaced an accepted decision;
add one worker test for the refusal and one for the reconsider path.

### F3 · Nonblocking — step-state mutation duplicated across worker and window

`FoundationWizard.tsx:372-406` reimplements accept/reopen/edited-step
 bookkeeping (`acceptStep`, `reopenStep`, `editedStep`, local `withStep`) that
 parallels the worker's `acceptFoundationStep`/`withStep`
 (`packages/worker/src/design/foundation/proposals.ts:625-660`). They are not
 identical (the UI's preserves fields, the worker's replaces), which is
 exactly the drift the protocol layer exists to prevent — both sides already
 import `foundationStepState`/`nextFoundationStep` from
 `packages/protocol/src/design-foundation.ts`, where a single
 `setFoundationStepState(foundation, id, patch)` would delete both copies.
 Low urgency; take it with the next batch that touches either file.

### F4 · Nonblocking — small honesty/consistency gaps

- `packages/worker/src/design/foundation/proposals.ts:665-694` — `complete()`
  swallows every exception (timeout, dead provider) and returns `null`, so a
  transport failure moves silently to the next model or the fallback with no
  `issues` entry, while the tool's own schema says `issues` holds "what a model
  answered that could not be used". Push one issue line on the failure; the
  person-facing note stays as it is.
- `packages/ui/src/components/project-work/bodies/DesignDetail.tsx:135,388` —
  the draft is validated with `{ primitives: KIT_NAMES }` only, while the
  sketch-grounding path validates with `entryIds` too
  (`packages/worker/src/design/sketch/ground.ts:355-358`). A node referencing
  an index entry that review later merged away passes the window's save gate.
  Pass `entryIds` when `liveIndex` exists.
- `packages/worker/src/design/workspace.ts:110` — `tracked` never prunes; one
  `Tracked` row per build lives for the worker's lifetime. Trivial, but a
  project that re-indexes daily accrues forever.

## Non-findings checked and cleared

- **Concurrent-build session attribution**: `DesignWorkspace.build` stores
  `startingFor` on an instance field read by `observeCommand`, but the whole
  `startBuild → onCommand` path is synchronous between two awaits
  (`bridge.ts:52-84`), so two builds cannot interleave inside it; the row is
  attributed to the right session.
- **Review double-write**: `ProjectDesignIndex.review` writes `review.json`
  then `index.json` non-atomically, but the index is reconstructed from
  `applyReview(stored, review)` on every read, so a torn write is recoverable,
  not corrupting.
- **Fleet row** rides the existing `lasercode/task/update` extension message
  and `design-index-*` task ids; a build nobody started from a session takes
  no row, as decided. Stop from the fleet routes through `stopByTaskId`.
- **Stop** is idempotent (`index().stop` and `held.command.stop()` stop the
  same `AbortController`).
- **Tokens/min text/reduced motion** in the new UI: `TokenEditorRow` keeps the
  12px floor, `motion-reduce:transition-none` on its transitions, and
  `FoundationCanvas`'s `SAMPLE_SCALE` is proportional zoom maths, not a static
  visual value.

## Remaining acceptance — the person's

Visual and interactive acceptance is untouched by unit tests, by design
(D-342): the Foundation section and the greenfield offer in both themes and
both widths; both token editors side by side against Settings; the five
sections coexisting at phone width; the index build's fleet row while a build
runs and after Stop; the in-context panel with a drawn box over a real
reference image. Run `pnpm -r build && pnpm sandbox` and work the Design tab on
a fixture project.
