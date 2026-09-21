# M21-T11 — DesignTree, canvas, primitive kit, prototypes and Sketch

Status: **working plan** for the M21-T11 worker (branch
`agents/design-canvas-and-sketch-d39d20b5`). Binding contracts are
[`docs/design-phase.md`](../design-phase.md) (D-353, D-354),
[`docs/project-lifecycle-leap.md`](../project-lifecycle-leap.md) "Design
contract" and "Detail, by kind → Design", and `PLAN.md` M21-T11. This file is
the plan and the checkpoint log; it decides nothing the contracts have not
already decided.

## What lands

| Layer | Files | What |
| --- | --- | --- |
| Protocol (additive) | `packages/protocol/src/design-tree.ts` | pure `validateDesignTree` / `validateDesignBody` (non-executable, stable ids, declarative actions), `migrateDesignBody`, the DTCG flattener `designTokenCustomProperties`, `suggestNearestToken` |
| UI model | `packages/ui/src/design/*` | tree editing, the primitive kit contract and its token-only stylesheet, canvas viewport maths, the prototype machine, sketch document handling |
| UI surface | `packages/ui/src/components/design/*` | `DesignCanvas`, `ScreenFrame`, `TreeFrame` (Shadow DOM), the kit renderer, `SketchFrame`, node inspector, Design Index panel |
| UI detail | `packages/ui/src/components/project-work/bodies/DesignDetail.tsx` | the Design body's detail: canvas + inspector, Prototype mode, full screen, phone read-only |
| Tests | `packages/protocol/test/design-tree.test.ts`, `packages/ui/test/design/*` | refusals, round-trip, flattening, shadow-root custom properties, free-value refusal, prototype transitions, sketch attributes/CSP, "a sketch cannot be approved", canvas keyboard, a11y |

Shared files touched, smallest additive edit only:

- `packages/protocol/src/index.ts` — one `export * from "./design-tree.js"`.
- `packages/ui/src/components/project-work/WorkDetail.tsx` — one branch in the
  detail switch, the same shape as Plan's and Task's.
- `docs/ux-elements.md` — the canvas rows.

## Decisions taken inside the contracts

1. **No new dependency.** The canvas is one transformed layer with pointer,
   wheel and pinch handlers and SVG edges — a few dozen lines of maths in
   `src/design/canvas.ts`. `@xyflow/react` stays the agents map's; a design
   frame is a Shadow DOM host that must survive pan/zoom without remounting,
   which a node-graph library's virtualisation does not promise. Nothing new
   is adopted, so there is no new licence to list.
2. **Tokens inside the frame are custom properties, outside it are Laser's.**
   The frame's shadow root gets `--design-*` custom properties flattened from
   the index's DTCG document; the kit stylesheet reads only those, each with
   a fallback to Laser's own token of the same role. A design with no token
   document therefore draws in Laser's tokens and says so — never a hex.
3. **The kit is skinned only by custom properties.** No kit rule carries a
   literal colour, size, radius, shadow or duration.
4. **Everything the worker owns stays the worker's.** The UI imports no worker
   code: the DTCG flattener the frame needs is a pure function in the protocol
   package, beside the schema it flattens.
5. **What waits on M21-T17** is drawn as a designed pending state with the
   honest sentence, never a dead button: the Design Index panel's review
   actions and Re-index, and "Ground it". Both take an injected access object
   so T17 wires them without touching the surfaces.

## What waits on M21-T17 (designed pending states, not dead buttons)

| Surface | Today | Wire it by |
| --- | --- | --- |
| Design Index panel | `unavailable` state with `INDEX_PENDING_SENTENCE`; entries, chips, filters and Accept/Rename/Merge/Reject render as soon as an index is passed | `DesignDetail` props `index` + `indexAccess` (`DesignIndexAccess`: `state`, `review`, `reindex`, `reindexing`, `stopReindex`) |
| Re-index | absent until `indexAccess.reindex` exists; progress is by files, stoppable | same |
| Ground it | `GROUND_PENDING_SENTENCE` until `groundSketch` is passed | `DesignDetail` prop `groundSketch(sketchId)` |
| Implement… | popover with `IMPLEMENT_PENDING_SENTENCE` + Copy the key; refuses outright on a sketch-only design | the `/design implement @KEY` form |
| Sketch bytes | read today through `project/work/blob/read` (the only route the window has) | — |
| Index tokens | `index.tokensDocument` when passed; else the foundation's `tokensBlobId`; else this app's tokens, said under the canvas | same `index` prop |

The worker stores review in `.laser/design/review.json` through
`design/index/review.ts` (`applyReviewAction`); the panel's verbs are the
four of the leap's inspector row and map 1:1 onto `DesignReviewAction`.

## Checkpoints

- Plan written; contracts read (design-phase, leap Design sections, D-353,
  D-354, PLAN M21-T11, T10's `tokens.ts`/`review.ts` for how review is
  stored). Done.
- Protocol: `design-tree.ts` + `test/design-tree.test.ts` (21 tests). Done.
- UI model: `src/design/*` + `test/design/model.test.ts` (22 tests). Done.
- UI surfaces: `components/design/*`, `bodies/DesignDetail.tsx`, wired in
  `WorkDetail.tsx`; `test/design/{frame,sketch-frame,inspector,canvas,detail}.test.tsx`. Done.
- One surprise: a `useLaserStable()` that returns a fresh `client` object per
  render restarted the blob reads forever; the detail now keys those effects
  on *having* a client and reads it through a ref.
- Static-value note: the kit sheet's only literal fallbacks are hairline and
  focus-ring widths (`1px`/`2px`), the same values `DESIGN.md` fixes for
  hairlines and the app's `outline-2`; every colour, size, radius, shadow,
  weight and duration is a token with a token fallback.
- Validation: see the final report.

---

# M21-T14 — Greenfield design foundation

Status: **working plan and record** for the M21-T14 worker (branch
`agents/greenfield-design-foundation-caf9ce9d`). Binding contracts:
[`docs/design-phase.md`](../design-phase.md) "Case A · Foundation mode",
"Model profiles", "Tools"; [`docs/project-lifecycle-leap.md`](../project-lifecycle-leap.md)
"Design contract" (greenfield paragraph, licence provenance);
`PLAN.md` M21-T14. It decides nothing those have not already decided.

## What lands

| Layer | Files | What |
| --- | --- | --- |
| Protocol (additive) | `packages/protocol/src/project-work-bodies.ts` | the foundation shape on `DesignBody.foundation`: principles, DTCG `tokens`, semantic `modes`, `typeScale`, `scales` (spacing/radius/shadow/z-index), `motion`, `sources` with their licence record, `layoutRules`, `accessibility`, `components`, the ordered `steps`, `status`, `profile` (digest v1) and `supersededBy`. Every field optional — a body written before this still validates |
| Protocol (new) | `packages/protocol/src/design-foundation.ts` | the rules both sides read: `FOUNDATION_STEPS` and the order rule (`checkFoundationStepOrder`), `foundationProgress`/`foundationIsComplete`, `foundationCanonicalJson` (the bytes the digest is taken over), `foundationTokenNames`/`foundationTokenDiff`, `foundationBlockedSources`, and the implementation-ordering helpers `foundationPlanSkeleton`/`foundationPlanWithKeys` |
| Worker | `packages/worker/src/design/foundation/{proposals,neutral,licence,storage,tools,index}.ts` | one bounded completion per step on `designIndexProfileId`, strict JSON read into a patch and validated against the protocol schema; the documented neutral foundation with the honest note; licence classification where `unknown` blocks the recommendation; storage as a Design revision body through the host authority; `propose_foundation` |
| Worker (wiring) | `packages/worker/src/project-work/session.ts` | `designTools()` offers `propose_foundation` when the session has a design surface and a project |
| UI model | `packages/ui/src/design/foundation.ts` | token rows and in-place token writes over the DTCG document, alias resolution, the digest through `crypto.subtle`, the superseded diff, and the sample screens composed from the T11 kit |
| UI surface | `packages/ui/src/components/design/{FoundationWizard,FoundationCanvas,FoundationTokenEditor}.tsx` | the ordered steps each editable, the canvas of samples skinned by the proposal, the token editor on a foundation target, licence chips, Approve, the Plan, the superseded state |
| UI detail | `packages/ui/src/components/project-work/bodies/DesignDetail.tsx` | the Foundation slot |
| Tests | `packages/protocol/test/design-foundation.test.ts`, `packages/worker/test/design/foundation.test.ts`, `packages/ui/test/design/foundation.test.tsx`, `packages/worker/test/fixtures/tool-eval/propose_foundation.json` + `test/fixtures/design/greenfield/` | order, validation, licence classification incl. unknown blocking, repository untouched, refs, digest, ordering helper, wizard steps/edit/approve/plan/superseded, kit renders the proposal's tokens |

Shared files touched, smallest additive edit only:

- `packages/protocol/src/index.ts` — one `export * from "./design-foundation.js"`.
- `packages/protocol/src/tool-contract.ts` — `propose_foundation` in `LASER_TOOL_NAMES`.
- `packages/worker/src/project-work/session.ts` — one binding in `designTools()`
  and one option (`foundationModels`).
- `packages/worker/test/tool-eval/fixtures.test.ts` — the tool in the matrix list.
- `packages/ui/src/components/project-work/bodies/DesignDetail.tsx` — three
  edits: the import, the Foundation branch (a design with a `foundation` renders
  the wizard), and the token source (`index` → foundation blob → the
  foundation's inline `tokens`).
- `packages/ui/src/{design/index.ts,components/design/index.ts}` — exports.

## Decisions taken inside the contracts

1. **The token document rides in the body, not a blob.** There is no
   blob-write method on the worker bridge, and ten steps of DTCG is kilobytes
   against a 4 MB body budget. `foundation.tokensBlobId` stays in the shape
   and the window still reads it, so a document stored as a blob keeps
   working.
2. **The digest is taken over content, by the caller's own crypto.**
   `foundationCanonicalJson` fixes the bytes; the worker would hash them with
   Node's `createHash`, the window does it with `crypto.subtle`. `status`,
   `profile` and `supersededBy` are excluded, so approving a foundation does
   not change the digest of the thing being approved.
3. **The model's licence claim is a declaration, never a verdict.** Whatever
   `propose_foundation` is told about a source's licence goes through
   `licence.ts`, so an unrecognised or absent licence is `unknown` and blocks
   the recommendation with a sentence. An exact version is part of
   "recommended": a range can bring in something licensed differently.
4. **A step that breaks its own rule falls back rather than being repaired.**
   A type scale with a step under the legibility floor, or an accessibility
   floor below AA, is dropped whole and the neutral step stands in with the
   issue named. Quietly fixing a proposal would hide that the model does not
   hold the rule.
5. **Approve is two writes and one read.** The revision carrying
   `status: "approved"` and the digest; then `project/work/get` for the gate
   report; then `project/work/approve` with the host's own `covers`,
   unchanged. Approving is disabled while the draft is unsaved — an approval
   records an exact revision, and an unsaved one is not a revision.
6. **The token editor shares the Settings editor's rows and its contrast
   rule, not its component.** `settings/appearance/TokenEditor.tsx` is typed
   to this app's fixed `Theme` token names; a foundation is a DTCG document
   with the person's own names, in a base document and in modes. The rows,
   the draft-while-typing field and the contrast readout of *the value typed*
   come from the same `@/theme` functions Appearance measures with, against
   the foundation's own ground/ink and its own recorded floor. Lifting one
   row component into a shared file is a follow-up both owners would have to
   agree on; it is named here rather than done unilaterally.

## Deviations

1. **No server wiring for the proposal models.** `ProjectWorkSession` takes
   `foundationModels`, and `packages/worker/src/server.ts` does not pass one —
   the same state L1 synthesis is in today (`ProjectDesignIndex` takes
   `synthesis` and the server passes none). Until that lands, every step is
   the documented neutral foundation with its honest note, which is a
   designed state rather than a broken one. Wiring both at once belongs with
   the Design-index profile work.
2. **A source is added from the chat, not the wizard.** Removing a proposed
   source is a button; adding one needs the licence read and classified,
   which is the worker's, so the surface says that in a sentence instead of
   offering a field that could record an unchecked licence.

## Checkpoints

- Contracts read (design-phase Case A, model profiles, tools; leap Design
  contract; PLAN M21-T14; T10's index and T11's kit/canvas). Done.
- Protocol shape + rules + tests (13). Done.
- Worker `design/foundation/**` + tests (33), tool-eval fixture and the
  greenfield fixture project; matrix green. Done.
- UI model, three surfaces, the Foundation slot, tests (12). Done.
- Validation: see the final report.
