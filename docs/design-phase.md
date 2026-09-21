# Design

Status: **binding design** (decision D-353; implemented under `PLAN.md`
M21-T10–M21-T14 as amended). A companion contract of
[`project-lifecycle-leap.md`](project-lifecycle-leap.md), indexed there under
"Companion contracts" and expanding its
[Design contract](project-lifecycle-leap.md#design-contract). Tools follow
[`agent-tool-contract.md`](agent-tool-contract.md); models come from
[`model-profiles.md`](model-profiles.md). Standalone-first per D-352.

## The idea in one paragraph

Design in Laser is grounded in the project's real design system, never in a
generic house style. For a project with code, Laser first builds a reviewed
**Design Index** — tokens, components, conventions, eras — by parsing source,
and every design is composed from that index. For a greenfield project, Laser
and the person co-design a **Foundation** first, and the built source becomes
the index. For a feature inside an existing page, the design is composed **in
context**: a static capture of the host page, an insertion region, and a new
subtree built from the index's right era, under one of two explicit
strategies, Conform or Island. **The Design phase never runs the project**
(D-353): no dev server, no preview runner, no browser automation, no
serve-time tagging. Everything is parse-only and finishes in seconds to
minutes; real rendering proof belongs to Build through M20 checkpoints.

## Three cases, one workspace

| Case | Trigger | Path |
| --- | --- | --- |
| **A · Greenfield** | no index and no UI source found | Foundation mode → approve → Build implements foundation → source becomes the index |
| **B · Brownfield** | UI source exists | Design Index (build or reuse) → review → compose from the index |
| **C · In context** | the design targets an existing page | Index + host capture → insertion region → Conform or Island → compose |

`/design <text>` picks the case from the index state and the text; the
person can override in the header ("Design a new page" / "Change an existing
page" / "Start a foundation").

## The Design Index

### What it is

A derived, reviewed, project-owned index of everything a designer needs to
compose in this project's language. It is the `DesignSystemManifest` of the
leap, made operational.

```text
DesignIndex (project-owned; revisioned like an artifact)
  stack             frameworks, versions, styling approach, build tool, package manager
  eras[]            named layers of the UI codebase (e.g. "legacy-bootstrap3", "current-react")
                    each: roots (paths), stack, tokens, components, conventions, useForNewWork: bool
  tokens            DTCG document: primitives, semantic aliases, modes/themes; each token cites sources
  components[]      name, era, import/usage form, props/variants/slots (typed where the source is typed),
                    purpose, when-to-use, do-not-use-for, examples (parsed from stories/docs/usages),
                    status: active | deprecated | internal
  conventions[]     navigation, page templates, forms, empty/loading/error, feedback, spacing rhythm,
                    density, iconography, copy voice, a11y practices — each with cited examples
  assets            icon sets, illustration/asset dirs, fonts
  philosophy        short statement of the observed visual language, cited
  provenance        every entry: sources[], confidence (declared | observed | inferred | proposed), digest
  review            accepted | renamed | merged | rejected per entry; reviewer; reviewedAt
  builtFrom         repository state (RepositoryStateRef) and source digests
```

### How it is built — two layers, no execution

| Layer | Runs on | Does | Label |
| --- | --- | --- | --- |
| **L0 · Static facts** | deterministic code, no model | detect stack from manifests/lockfiles/config; mine CSS/SCSS/Less/Tailwind config/CSS-in-JS/styled objects for values (colours, type, spacing, radii, shadows, motion, z-index, breakpoints); read existing DTCG/Figma-token/Style Dictionary/Terrazzo files; inventory components from exports, prop types (react-docgen, vue-docgen, svelte types, Angular decorators, Web Component definitions), Storybook/Ladle/Cosmos stories **parsed as text**, MDX docs; routes/pages/templates; icon libs; asset dirs; i18n | `declared` (typed/config), `observed` (mined) |
| **L1 · Synthesis** | **Smart profile**, bounded | cluster mined values into candidate primitives; propose semantic names; describe each component (purpose, when, variants) from its source, stories and usages; extract conventions from page/template structure; identify eras and which is current; write the philosophy | `inferred` (from ≥2 L0 facts, cited) / `proposed` (naming, grouping) |

Nothing imports project config, executes project code, starts a server or
opens a browser. Story files, config files and typed token objects are
parsed, never evaluated. A file that cannot be parsed statically is recorded
as a gap, not guessed.

### Review — the index is a proposal until a person accepts it

Comparable tools report ~70 % mapping accuracy for automated component
discovery; Laser therefore shows the index like a Research: every entry with
its confidence chip, sources and excerpt. The person can accept, rename,
merge, split, reject, mark a component `deprecated`, mark an era
`useForNewWork`, and pin a convention. Unreviewed entries compose with a
visible "unreviewed" chip; the Design gate may require a reviewed index.
The reviewed index is the source of truth for every Design.

### Storage

- `<project>/.laser/design/index.json` — the reviewed index (DTCG tokens
  inline), committed with the repository so a team shares one truth.
- `<project>/.laser/design/review.json` — review decisions and who made them.
- Laser state, per project — parse caches keyed by source digest; never
  required to rebuild.
- Existing source stays authoritative; the index is derived and says so.

### Re-index

- Manual **Re-index** in the Design tab header; also proposed (never forced)
  when the L0 digests of authoritative sources change materially.
- Incremental: only files whose digest changed are re-parsed; L1 re-runs for
  affected entries only; review decisions are preserved by stable entry ids
  and shown as "changed since review" where the underlying facts moved.
- Dependent Designs are marked stale when an entry they reference changes
  (leap stale rule; links only).
- Runs as a visible fleet Command with a budget; the person can stop it.

## Case A · Foundation mode

1. Inputs the person may give: brand colours, fonts, reference screenshots,
   URLs (read through the Research `web` adapter as text), "feels like".
2. Laser proposes, in order and each editable: principles → primitive tokens
   (DTCG) → semantic tokens and modes → type scale → spacing, radius, shadow,
   z-index → motion → icon and asset sources → layout rules → accessibility
   floor → core component contracts (Button, Input, Select, Checkbox, Card,
   Dialog, Toast, Nav, Table, Empty/Error/Loading).
3. The composition canvas renders sample screens with the proposal; the
   person edits tokens in the same token editor Laser's Settings uses, on a
   different target.
4. Approve → Design Profile digest v1; sandbox components live in Laser
   state; the repository is unchanged until Build.
5. Build implements the foundation first (Terrazzo/Style Dictionary emit CSS
   variables, Tailwind theme, TS objects or the framework's idiom); the
   built source is then indexed and replaces the proposal as authority.

Everything in Foundation mode is `proposed` until built.

## Case B · Compose from the index

- The canvas offers only tokens and components from the eras marked
  `useForNewWork` unless the person widens the palette.
- Every node references index entries by stable id; free values are refused
  with the nearest token suggested.
- Fidelity per node: **Mapped** (composed from reviewed index entries) or
  **Proposed** (new component or token); a screen shows the conservative
  aggregate.
- The inspector shows, for any node, the index entry, its sources and its
  review state, and offers "open source file".

## Case C · Design in context

### Grounding the host page — static only

| Source | Always? | What it yields | Host fidelity |
| --- | --- | --- | --- |
| Template/route parse | yes | the template, partials, includes, owning controller/stylesheets for the route the person names or the model finds; a structural outline of the page (regions, headings, lists, forms) | Mapped |
| Existing screenshots in the repo/docs | if present | images referenced by docs/stories, parsed as reference | Mapped |
| Person-supplied screenshot | optional | a pasted image of the live page; untrusted, bounded, shown as reference | Proposed |

There is no runtime capture (D-353). The host is a **frozen `HostPage`
node**: structural outline + optional reference image, not editable, with
its files listed.

### Insertion region

The person picks a region on the outline or the image, or the model proposes
one; the region records `{ templatePath, structuralPath, textHash, box? }`.
Comments and later revisions anchor to it; if the template changes so the
structural path no longer resolves, the anchor is shown as orphaned, never
silently moved.

### Two strategies, chosen explicitly

| Strategy | Meaning | Index era used | Typical when |
| --- | --- | --- | --- |
| **Conform** | build in the host's own idiom — its classes, partials, helpers, directives | the host's era | small feature, page stays, team knows the stack |
| **Island** | mount one self-contained modern component (Web Component or framework island) in the region; bridge the look by mapping the host era's values to CSS custom properties at the boundary; events/API contract across the seam | current era inside, host era at the boundary | larger feature, migration wanted, host stack cannot express it |

The model proposes one with reasons and the trade-offs; the person chooses;
the Design records the strategy, the target files and the integration
contract. A Design may record Island only as a proposal for the Plan; the
tooling consequences (bundling an island into a legacy build) are Plan/Task
work, previewed like any repository change.

### Validation without running

Composition renders the new subtree on the canvas; in context, it is shown in
place on the host outline or overlaid on the reference image at the region.
That is **Mapped** at best. **Native** evidence exists only at Build: an M20
checkpoint whose preview the person accepts is linked `verified_at` to the
Design revision. The Design gate cannot require Native.

## Fidelity, revised

| Label | Meaning | Where it appears |
| --- | --- | --- |
| **Mapped** | composed from reviewed index entries, or a host outline parsed from real templates | Design phase |
| **Proposed** | new token/component/foundation, or a person-supplied image | Design phase |
| **Native** | rendered by the project's real build at an M20 checkpoint | Build evidence only, linked back to the Design |

Mapped is never presented as Native; unreviewed index entries are shown as
such on every node that uses them.

## Model profiles

| Work | Profile |
| --- | --- |
| Index L1 synthesis, Foundation proposals, Island/Conform recommendation | **Smart** (`designIndexProfileId`, default = Smart) |
| Composition edits, revisions, comments | the session's profile |
| Re-index classification of changed entries | **Fast** |

## Tools (model-facing)

Under the tool contract; capability-gated on a project with an index or in
Foundation mode.

| Tool | Purpose |
| --- | --- |
| `inspect_design_index` | search/get index entries by era, kind, name; summary by default |
| `build_design_index` | start or re-run indexing as a fleet Command with a budget; returns the command id |
| `review_design_index` | accept/rename/merge/reject entries (person-attributed when the person acts; model-attributed otherwise and shown so) |
| `compose_design` | create/revise a `DesignTree` referencing index ids; refuses free values; returns validation issues |
| `propose_foundation` | Foundation mode proposals in the fixed order |
| `ground_host_page` | resolve a route/template to a `HostPage` outline and file list; attach a person-supplied image |
| `inspect_project_work`, `request_project_review` | leap tools, reused |

There is no free-form HTML/CSS/JS tool; the model composes trees.

## What a person sees

- Design tab: **Index** (entries by era/kind with chips, review actions,
  Re-index, gaps), **Foundation** (Case A wizard/canvas), **Screens** and
  **Flows** (canvas, inspector, states, viewports, themes), **Review**
  (anchored comments, before/after).
- In context: host outline on the left, region highlighted, new subtree
  composed inside; reference image toggle; strategy chip (Conform/Island)
  with the reasons.
- Every empty, loading (indexing progress by files, not percent), gap,
  stale, unreviewed and offline state designed; phone is read-only canvas
  plus review actions.

## Security, privacy and resources

- Parse-only: no execution of project code, no server, no browser, no
  network except the Research `web` adapter for person-given reference URLs.
- Screenshots are untrusted images, bounded in size, never OCR-trusted as
  instructions.
- Index build is a bounded fleet Command (files, bytes, time); large
  monorepos index per app root chosen by the person.
- `.laser/design/*` is written only through Laser's project-config path;
  secrets and absolute paths are never written into it.

## Affected areas

| Layer | Change |
| --- | --- |
| Protocol | `DesignIndex` schema (eras, tokens as DTCG, components, conventions, provenance, review), `HostPage`/`InsertionRegion` nodes and `strategy` on `DesignTree`, fidelity enum without `Native` in Design records, `designIndexProfileId`, tool schemas |
| Worker | `design/index/{l0-*,l1-synthesis}.ts` parsers (manifests, CSS family, Tailwind config as text, CSS-in-JS, docgen family, stories as text, templates), digest cache, fleet Command wrapper, tools |
| Host | index authority and review writes, `.laser/design/*` project-config writer, stale propagation from index changes |
| UI | Design tab sections above, token editor reuse, in-context canvas, strategy chip, review chips |
| Plan | M21-T10 becomes the Design Index (L0/L1, storage, review, re-index); M21-T12 loses the runner and becomes static host grounding and source selection; M21-T13/T14 as amended; M21-T19 verification uses Build-time Native evidence only |
| Docs | leap Design contract and fidelity text amended; `agents.md` tool tables |
| Tests | parse-only guarantee (no `child_process`, no network in index code); confidence rules; review preservation across re-index; free-value refusal; orphaned anchors; strategy recorded; fidelity never `Native` in Design records |
