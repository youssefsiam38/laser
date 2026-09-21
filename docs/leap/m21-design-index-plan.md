# M21-T10 · the Design Index — plan and checkpoint

Owner: worker "Design index parsers", branch
`agents/design-index-parsers-47fb00c6`, base `2a60034e`.
Binding text: [`../design-phase.md`](../design-phase.md) (D-353) "The Design
Index", "How it is built — two layers, no execution", "Review", "Storage",
"Re-index", "Model profiles", "Tools", "Security"; `PLAN.md` row M21-T10.

## What this task owns

`packages/worker/src/design/index/**` — the whole parse-only index engine —
plus the additive `DesignIndex` fields the engine needs in
`packages/protocol/src/project-work-bodies.ts`, its tests and its fixtures.
Host writes (T11–T13) and every pixel of the Design tab are **not** here.

## Dependencies

**None added.** `react-docgen`, `postcss`, `sass` and the Tailwind resolver
were all considered and rejected:

| Candidate | Licence | Why not |
| --- | --- | --- |
| `react-docgen` | MIT | pulls a full Babel parse chain (~30 packages) for prop tables this task reads from TS types directly; the contract only needs typed props, defaults and string-union variants |
| `postcss` + `postcss-scss` | MIT | a declaration-level miner is ~200 lines and needs no plugin ecosystem or AST version pinning |
| `tailwindcss` resolver | MIT | **it evaluates the project's config** — exactly what D-353 forbids. Tailwind config is read as text |
| `sass` / `less` | MIT / Apache-2.0 | compiling is executing |

Everything is a hand-written, bounded text/structure parser. That is also what
makes the parse-only guarantee testable: there is no transitive dependency that
could reach `child_process` or the network behind our back.

## Shape

| File | Owns |
| --- | --- |
| `facts.ts` | `DesignFact`, `FactSource` (path + line range + digest), `Gap`, confidence labels, the stable id function |
| `scan.ts` | the bounded file walk: ignore list, per-file and total byte budgets, sha256 per file, a gap for anything skipped |
| `l0-stack.ts` | manifests and lockfiles → frameworks, styling, build tool, package manager; config files recognised **by name**, read as text |
| `l0-styles.ts` | CSS/SCSS/Less declarations, custom properties, `$`/`@` variables, `@media` breakpoints, `@font-face`; Tailwind config as text; CSS-in-JS and styled/theme object literals |
| `l0-tokens.ts` | existing DTCG / Style Dictionary / Terrazzo token documents → `declared` tokens |
| `l0-components.ts` | exported components (React/Vue/Svelte), typed props, defaults, string-union variants, status; stories and MDX parsed as text for examples |
| `l0-templates.ts` | routes/pages/templates (Next/Nuxt/SvelteKit/ERB/Blade/Twig/HTML) → outlines, class vocabulary, form/empty-state signals |
| `l0-assets.ts` | icon libraries, asset dirs, fonts, i18n catalogues |
| `tokens.ts` | the DTCG document: declared tokens kept as they are, observed values clustered and counted, every token citing its sources |
| `eras.ts` | era detection from roots and stack signals, `useForNewWork` |
| `l1-synthesis.ts` | one bounded completion per model of `designIndexProfileId`, strict JSON, every item citing L0 fact ids; `inferred` / `proposed` |
| `review.ts` | the review document, its actions, preservation by stable ids, "changed since review" |
| `storage.ts` | `<project>/.laser/design/{index,review}.json` through the project-config path; the digest-keyed parse cache in Laser state |
| `command.ts` | the build as a bounded, stoppable command with progress by files |
| `tools.ts` | `inspect_design_index`, `build_design_index`, `review_design_index` under the tool contract |

## Decisions

1. **Stable entry ids are content-free.** `entryId = sha256(kind|eraId|name)`
   truncated. A re-index that parses the same component out of a moved file
   produces the same id, so the review survives; a rename produces a new id and
   the rename is recorded in the review document, which is what keeps
   accept/rename/merge decisions across re-index.
2. **"Changed since review" is a digest comparison, not a diff.** Each entry
   carries `factsDigest` over its own parsed facts; the review record stores the
   digest it was made against. They differ → `changedSinceReview: true`.
3. **The parse cache is keyed by file digest only.** A file whose digest is
   unchanged is not re-read at all, so an incremental re-index is exactly "the
   files that changed", and the cache can be deleted at any time.
4. **L1 is optional and never fabricates.** No profile, no model, a timeout or
   unparseable JSON leaves the index at its L0 truth plus a gap that says
   synthesis did not run. A synthesised item citing a fact id that does not
   exist is dropped rather than shown.
5. **The command is the worker's own, not a shell task.** Parse-only means
   there is no process to spawn; `command.ts` therefore exposes the same
   vocabulary a fleet row needs (title, state, progress by files, stop) so
   M21-T13 can publish it without the engine's background-task machinery.
6. **The three tools are defined and linted here, not registered yet.**
   Registering them with the engine needs a `design-index` entry in
   `RUNTIME_MODULE_NAMES` and a bridge in the driver's agent options — both
   outside this task's write set, and both the natural shape of M21-T17's
   lifecycle tool wiring. `tools.ts` therefore exports contract-linted
   `LaserToolSpec`s and their handlers against a `DesignIndexBridge`, and the
   conformance fixtures sit in
   `packages/worker/test/fixtures/tool-eval/design-index/` — inside the
   fixtures tree, but not yet in the matrix directory that
   `loadFixtures()` pins, because a fixture for an unregistered tool would make
   the engine matrix fail for a reason that is not about the tool. When M21-T17
   registers them, the three files move up one directory and their names join
   `TOOLS` in `test/tool-eval/fixtures.test.ts`.
7. **Nothing absolute, nothing secret, reaches `.laser/design`.** Every source
   path is project-relative by construction and the writer refuses a document
   that carries an absolute path, a `~` path or a `file://` URL.

## Protocol additions (all optional, all additive)

`DesignIndexEntry`: `factsDigest?`, `reviewedFactsDigest?` (inside `review`),
`renamedFrom?`, `mergedIntoId?`, `splitFromId?`, `pinned?`, `citations?`.
`DesignIndex`: `tokensDocument?` (the DTCG document), `appRoot?`, `builtWith?`
(which layers ran, on which profile/model), `stoppedEarly?`.
`DESIGN_INDEX_REVIEW_STATES` gains `"split"` — the contract's review verbs are
accept/rename/merge/**split**/reject, and nothing consumed the union yet.

## Fixtures

`packages/worker/test/fixtures/design/` holds five project shapes, each a real
(tiny) project a test copies to a temporary directory before indexing it:

| Fixture | Shape | What it proves |
| --- | --- | --- |
| `react-tailwind` | React + Tailwind + Storybook, CSS custom properties, a theme object, stories, routes, icons | declared and observed tokens, typed props and variants, deprecated status, story examples, routes and hand-written states, the DTCG document, **and the parse-only guarantee**: its `tailwind.config.js` and `postcss.config.js` write a marker file when executed, and the marker never appears |
| `vue-scss` | Vue SFCs, SCSS variables, `defineProps<…>` and an options object | preprocessor variables as declared tokens, both Vue prop forms |
| `rails-templates` | Gemfile, ERB views, SCSS, `config/locales/en.yml` | a server-rendered stack with no manifest of the JS kind, routes from `app/views`, copy voice from the locale catalogue |
| `monorepo-eras` | legacy jQuery + Bootstrap 3 package beside a React + Tailwind package | two eras, their roots, and which one is proposed for new work |
| `dtcg-tokens` | a DTCG token document and a Style Dictionary document | `$value`/`$type` leaves, aliases kept as aliases, the legacy `value`/`type` shape |

## What M21-T11 – M21-T13 consume

| Need | Where it is |
| --- | --- |
| The reviewed index of a project | `ProjectDesignIndex.index()` (`design/index/bridge.ts`) — `readIndex` + `applyReview` |
| Start / follow / stop a build | `ProjectDesignIndex.startBuild()`, `.commands()`, `.command(id).progress()`, `.stop(id)`; the fleet row's line is `progressLine(progress)` — files, never a percentage |
| Review from the UI | `ProjectDesignIndex.review({ …, actor: { kind: "person", label } })`; the refusals are `ReviewRefused` with `code` + `next` |
| Tokens for the Shadow DOM frames | `index.tokensDocument` (DTCG); `flattenTokenDocument()` gives `path → token` for CSS custom properties |
| "Unreviewed" and "changed since review" chips | `entry.review.state`, `entry.changedSinceReview`, `reviewProgress(index)` |
| Composing only from the current era | `index.eras[].useForNewWork`, `entry.eraId` |
| Gaps and "stopped early" states | `index.gaps`, `index.stoppedEarly`, `index.builtWith.layers` (an index without `"l1"` has no descriptions and says why in a gap) |
| The three tools | `DESIGN_INDEX_TOOL_SPECS` + the handlers in `design/index/tools.ts`, against `DesignIndexBridge` |

**Host.** Nothing was added to `packages/host`. The index and the review are
project files under `<project>/<PROJECT_DIR_NAME>/design/`, and the worker is
the process that owns a project directory — it already writes
`source-control.json` there the same way. The host's part of this (index
authority over the wire, review writes from the workspace, stale propagation
from index changes) is M21-T13's, and it reads and writes through
`design/index/storage.ts` rather than reimplementing the path.

## Checkpoints

- Plan written; protocol additions and the module shape fixed.
- L0 parsers, tokens, eras, review, storage, command, L1 and tools landed with
  fixtures for five project shapes; 70 tests in `packages/worker/test/design/`
  and 8 in `packages/protocol/test/design-index.test.ts`.
- Validated: `pnpm -F @lasercode/protocol test` (592), `pnpm -F
  @lasercode/worker test` (1344 + the existing tool-eval matrix), `pnpm -F
  @lasercode/pi-extension test` (228), `pnpm -r build`, `pnpm -r typecheck`,
  `pnpm identity:check`.
