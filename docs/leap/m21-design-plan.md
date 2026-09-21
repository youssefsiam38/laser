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

# M21-T13 — the design workspace, in-context grounding, Ground it, anchored review

Owner: worker "Design workspace wiring", branch
`agents/design-workspace-wiring-21ba22db`, base `8e7a229d`.
Binding text: [`../design-phase.md`](../design-phase.md) (D-353, D-354) —
"What a person sees", "Re-index", "Case C · Design in context",
"Sketch → Ground it", "`/design` — three forms";
[`../project-lifecycle-leap.md`](../project-lifecycle-leap.md) "Design
contract"; `PLAN.md` row M21-T13. It is the wire T11 left injectable and the
surfaces that wire feeds.

## What lands

| Layer | Files | What |
| --- | --- | --- |
| Protocol | `packages/protocol/src/design-workspace.ts` | six closed methods (`design/index/{get,build,stop,review}`, `design/host/ground`, `design/sketch/ground`), their params/results, `DesignIndexCommand` (progress by files), `DESIGN_KIT_PRIMITIVES`; policy rows; `designScreenSchema` exported from `project-work-bodies.ts` |
| Host | `src/router.ts`, `src/server.ts` | `projectId` → project root → that project's worker; the caller's `cwd` is replaced by the resolved one; an unknown project is refused before a worker starts |
| Worker | `src/design/workspace.ts`, `src/design/sketch/ground.ts`, `src/server.ts`, `src/design/index/{bridge,command}.ts` | the six handlers over `ProjectDesignIndex`/`ProjectHostGrounding`, the deterministic sketch grounding, the fleet Command row and its Stop |
| UI | `components/design/{use-design-access.ts,HostContextPanel.tsx}`, `src/design/{review.ts,host-context.ts}`, `DesignDetail.tsx`, `DesignCanvas.tsx`, `ScreenFrame.tsx` | the wire, the five sections, in-context grounding with the strategy chip, Ground it into the draft, pins with orphans, before/after |
| Docs | `docs/ux-elements.md` | three rows: design workspace sections, design in context, design pins |

## Decisions taken inside the contracts

1. **The design workspace is answered by the worker, not the host.** Every
   other `project/*` method is the host's own authority over its store
   (D-331), because those are Laser's records. The index, `review.json` and
   the templates they are parsed from are **files in the project**, and one
   worker process owns one project directory (AGENTS.md invariant 5). So the
   host does what it does for `mcp/*` and the git actions: it resolves the
   project and forwards. The opaque `projectId` is the client's only handle;
   the directory is the host's answer and overwrites anything the caller
   sent, and the worker refuses a directory that is not its own on top of
   that.
2. **`ground_sketch` is deterministic, not model-assisted.** A brief allowed a
   bounded one-shot completion. It is not taken: the same sketch must ground
   the same way twice, a project whose machine has no Design profile must
   still be able to ground, and the unmapped list is worth more as a fact than
   as an opinion. The parse maps elements onto index components by their own
   names, draws everything else with the kit as `Proposed` and lists it, turns
   the script's behaviour into **states** (included, or skipped with the
   reason), and validates the result with `validateDesignBody` before it
   returns. Rewriting a grounded tree with a model is `compose_design`, which
   already exists.
3. **The Command row rides the road Commands already ride.** An index build is
   published as a `lasercode/task/update` extension message under the session
   the person started it from, so the host's task register, `tasks/list`,
   `tasks/update` and the fleet's own grouping need no change, and Stop from
   the fleet row (`tasks/stop` → `pi/task/stop`) is answered by the worker for
   a `design-index-*` id. A build nobody started from a session takes no row
   at all — the Design tab's own progress line is the whole truth — rather
   than inventing a session for it.
4. **A build yields between files.** Parsing is synchronous, so before this
   the whole walk ran in one tick: the row would have jumped from "started" to
   "read 4 000 files", Stop could not have been delivered while it ran, and
   the worker would have answered nothing else meanwhile. `buildDesignIndex`
   now gives the loop back every `YIELD_EVERY_FILES` files. "Progress by
   files" is only true if a file is a moment.
5. **The reference image travels once, with its bytes, and only from the
   repository.** `design/host/ground` carries the first repository-referenced
   screenshot inline (bounded, base64) so a region can be drawn on it. A
   person-supplied screenshot stays a blob on the revision and never crosses
   this method, and nothing anywhere reads an image for text (D-353).
6. **A box never becomes an anchor.** The insertion region is
   `{ templatePath, structuralPath, textHash }` picked on the outline; a box
   drawn on the reference image is recorded beside it and says, in the
   surface's own words, that it only positions the region for the eye. A
   template whose path is gone shows the region orphaned with the candidate as
   an offer — `resolveInsertionRegion` decides, and nothing re-anchors without
   the person.
7. **Ground it lands in the draft, not in a revision.** The rebuilt tree is
   added to the body being edited beside its sketch (which keeps
   `groundedIntoScreenId` as provenance) and the person saves the revision
   with the fence they were reading, exactly as every other canvas edit does.
   Grounding never writes behind the person's back.
8. **`DesignDetail` reads the wire itself when no access is injected.**
   `WorkDetail.tsx` is another task's file; the detail therefore calls
   `useDesignAccess` by default and lets props win, which keeps every test
   injectable and leaves the shared file untouched.
9. **The kit's names are shared, the kit is not.** `DESIGN_KIT_PRIMITIVES`
   lives in the protocol because anything composing a tree outside the window
   must name the same sixteen primitives; the kit's contract, stylesheet and
   renderer stay the window's. A UI test pins `KIT_NAMES` to that list so they
   cannot drift.

## Left for the tasks that own them

- **Foundation** (M21-T14) is a designed slot with the honest sentence, in its
  own section, exactly where its wizard will mount.
- **`/design from <route>` as a command** creates the design with the text as
  its brief (D-352); this task reads the route back out of the brief and opens
  the in-context panel pointed at it. The composer's own parsing of the form
  belongs to the workspace-shell task that owns `work-commands.ts`.
- **Person-supplied screenshots** (a pasted image as a `proposed` reference)
  are a blob on the revision; the grounding method takes only the repository's
  own images.

## Checkpoints

- Plan read, contracts read, T10/T11/T12/T17 shapes read; protocol methods,
  policy rows and samples landed.
- Worker: `design/workspace.ts`, `design/sketch/ground.ts`, the six handlers,
  the fleet row and its Stop; the TDZ in `ProjectDesignIndex.startBuild`'s
  progress hook fixed (it would have thrown on the first report the moment a
  listener existed) and the build made yielding.
- Host: routing with project resolution, in `router.ts` + one deps line in
  `server.ts`.
- UI: the wire hook, the five sections, the in-context panel, pins, the
  before/after diff, the hand-off into the composer.
- Validation: see the final report.
