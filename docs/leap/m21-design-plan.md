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
