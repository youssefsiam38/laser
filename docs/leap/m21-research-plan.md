# M21-T26 · Research phase: adapters, tools and loop — working plan and checkpoint

Owner: worker "Research adapters and tools", branch
`agents/research-adapters-and-tools-9dc26c01`, base `e00ac50e`.
Binding text: [`../research-phase.md`](../research-phase.md) (D-351), under
[`../agent-tool-contract.md`](../agent-tool-contract.md) (D-350).
This file is the per-task checkpoint for M21-T26 and the handover note for the
**host owner** (M21-T3/T4 authority) and the **UI owner** (M21-T7).

Write set: `packages/worker/src/research/**`, `packages/worker/src/settings.ts`
(the Research sources descriptors), `packages/worker/src/tool-eval/fixture.ts`
(+ `research-world.ts`, the scripted world the fixtures replay against),
`packages/protocol/src/research.ts` (new) and one additive field in
`packages/protocol/src/project-work-bodies.ts`, tests and fixtures under
`packages/worker/test/`, and this file. `packages/ui` and `packages/host` are
other owners'.

## What this task is, in one paragraph

The Research contract's **worker half**: five shipping adapters behind one
interface, the readable-text extraction and digest cache they share, the
budget ledger that stops a run, the confidence rule that decides a finding's
confidence instead of the model, the four model-facing tools under the tool
contract, and the engine-instruction playbook that runs the loop. The
**host half** — applying a write, enforcing the rules on the way in, cache
quotas, attention items — is the host owner's, and it is handed over as one
protocol-level operation shape with a pure applier both sides run.

## Decisions

- **D-351.a — the writers send a body-typed operation, not a body.**
  `record_finding` and `resolve_question` do not build a `ResearchBody` and
  post it: they send a `ResearchOperation` (`packages/protocol/src/research.ts`),
  which the host applies with `applyResearchOperation()` and then stores through
  the existing `project/work/revise` method with the resulting body. One pure
  function is the authority for every rule in the contract's "Rules" section,
  it runs in the worker as a pre-check (so a refusal costs no round trip) and in
  the host as the real gate (so a tool that skipped the pre-check changes
  nothing). No new protocol method, no second writer on one artifact.
- **D-351.b — `inferred` is citable, so the body says what it was derived
  from.** The contract's rule is "`inferred` = derived from ≥ 2 findings,
  citing them", and the body had nowhere to put those citations: `supports[]`
  points at Spec/Design decisions and `contradicts[]` is the opposite
  relation. `ResearchFinding` gains an optional `derivedFrom: string[]`
  (≤ 32 finding ids), and `researchFindingSchema` refuses an `inferred`
  finding with fewer than two. Additive: every existing body still validates.
- **D-351.c — confidence is computed, never accepted.** `confidenceFor()`
  (`packages/worker/src/research/confidence.ts`) derives the confidence from
  the source's kind, its trust, whether the excerpt was read in this session
  and how many findings it was derived from. `record_finding` takes the
  model's `confidence` as a *claim* and answers with the rule's verdict and
  the reason when they differ; the operation applier refuses a confidence the
  rule cannot justify. A model cannot promote a blog post to `declared`.
- **D-351.d — injected instructions are kept, marked and never obeyed.** The
  readable-text extractor discards scripts, styles and forms (they are not
  prose) but **keeps** sentences that look like instructions to a model. They
  are evidence about the page. `read_source` returns them inside the text,
  preceded by the provenance line `[from <canonical>]` and a notice naming the
  pattern and the line it sits on, as data. Deleting them would hide what the
  page does; obeying them is what the notice exists to prevent.
- **D-351.e — the `repository` adapter is git, not a host API.** Resolving a
  repository, pinning a commit, listing releases and reading files all happen
  through `git ls-remote` / a partial `git fetch` / `git show`, run through
  git-actions' own `ProcessRunner` (argv, scrubbed env, no shell). No GitHub
  or Bitbucket REST call is added by this task: the `tracker` adapter, which
  is where an issue/PR API would belong, is a descriptor marked not shipped.
  A private host fails the way git fails and the refusal says the person's
  existing credentials are how it would be read.
- **D-351.f — PDF is a recorded gap, not a dependency.** The only PDF parser
  anywhere in the tree is `unpdf@1.8.1` (MIT), and it is there as a
  *transitive* dependency of the Pi package `pi-web-access@0.28.0` — not a
  workspace dependency, not pinned by any `package.json` of ours, and gone the
  day that package changes its own tree. Importing it from the worker would
  make a Pi package's private dependency part of Laser's runtime, which is the
  coupling the pin invariant exists to prevent, and adding it directly is a new
  dependency this task is not authorised to take. So the `document` adapter
  reads text, Markdown, JSON, CSV and source files; a PDF is refused with a
  sentence that says what is missing and what to do instead, and the same
  sentence is the recorded gap (`RESEARCH_GAPS.pdf`). Adopting `unpdf` as an
  exact-pinned direct dependency of the worker is a task of its own.
- **D-351.g — an identical query is refused by the ledger, not by advice.**
  "never re-run an identical query" is a loop rule a model can forget, so the
  budget ledger remembers every `(adapter, normalised query, window)` of the
  run and refuses the repeat with the call to make instead. The same ledger
  enforces one fetch per source id per run (the cache answers the second).
- **D-351.i — one source can be read as several bodies.** A repository read
  of its readme and a read of three named files are two bodies of one source:
  they cite the same commit and neither is the other's cached answer. So a
  read carries a `bodyKey` (the source id unless the adapter split it), the
  cache and the budget count bodies, and the run's read record keeps a *list*
  per source (`ResearchSessionReads`), so an excerpt from any body it really
  read is accepted and one from none of them is refused.
- **D-351.h — no new dependencies.** Nothing was added to any
  `package.json`. The adapters use `fetch` (Node 24), `node:crypto`,
  `node:fs`, and the existing git runner. The one seam every network adapter
  takes (`ResearchFetcher`) is what the tests record against.

## What the host owner must enforce (M21-T3/T4)

The worker cannot be the authority: a tool call that reached the engine is
still a model's request. Everything below is in
`packages/protocol/src/research.ts` and is meant to run **again**, host-side,
on every write. `applyResearchOperation(body, operation, context)` is the
whole gate; it throws `ResearchOperationRefused` with the contract's
`{ code, message, next }` and never partially applies.

| Rule | Where | What the host does |
| --- | --- | --- |
| Confidence by rule | `applyResearchOperation` | refuses `declared` without an official/primary source and a verbatim excerpt (and never for a `person`/`session` source), `observed` without a project source, `inferred` with fewer than two `derivedFrom` ids, `proposed` when the source is official or primary |
| Excerpt in digest | `applyResearchOperation` + `context.reads` | the excerpt must appear in the text the session was given. **Where it runs:** the fetched text lives in the worker's per-project research cache and never crosses to the host, so the worker enforces this one before it sends (`ProjectResearch.apply`, pinned by `refuses an excerpt that is not in what this session read`). The host enforces what it *can* see — that the finding's `source.digest` is one `read_source` reported for that source id in this session — by passing `{ [sourceId]: { digest, text: "" } }` as `context.reads`, or the full text when it keeps a read log of its own |
| Citation on `answered` | `applyResearchOperation` | an `answered` question cites ≥ 1 `declared`/`observed` finding, or carries `inferredOnly: true` |
| `unanswerable` says what would settle it | `applyResearchOperation` | appends to `unresolved[]`; refuses without it |
| `handed_to_person` raises attention | result `.attention` | the applier returns `{ kind: "handed_to_person", questionId, text }`; the host turns it into the leap's attention item |
| Stale propagation | result `.staleRefs` | a new finding that `contradicts` an older one inherits that finding's `supports[]`; the host marks those Spec/Design decisions stale (leap stale propagation) |
| Findings are never edited | `applyResearchOperation` | `record_finding` only appends; a correction is a new finding with `contradicts` |
| Status is derived | `researchStatusFrom()` | body `status` is recomputed from the question states on every write; a client-supplied status is ignored |
| Cache quota | `RESEARCH_CACHE_DEFAULT_MAX_BYTES`, `research.cacheMaxBytes` | the research cache is per project, size-bounded and evictable; the worker evicts to the quota it is given, the host owns the number and excludes the cache from export unless the person includes it |
| `expectedRevisionId` / `idempotencyKey` | the tool input | both are on every writer call; a mismatch is the typed conflict of `docs/agent-tool-contract.md` §2, a repeat with the same key returns the first result |

The transport is unchanged: the host applies the operation and writes the
result through `project/work/revise` with the body the applier returned. No
`project/research/*` method is added (the contract allows either; the
body-typed operation is the smaller surface).

## What the UI consumes (M21-T7)

- `RESEARCH_ADAPTERS` (protocol): id, title, what it does, reach, auth, rate
  policy, whether it ships. Settings → Research sources renders from this
  list, so an adapter added later appears without a UI change.
- `readResearchSources()` + `RESEARCH_BUDGET_DEFAULTS`: the settings shape
  behind the per-adapter switches, the per-project allow/deny domain lists and
  the four budget numbers. The worker's `SETTINGS_FIELDS` already carry the
  descriptors, so the generated settings form draws them.
- `researchBudgetLine()` (worker, `budget.ts`): the one-line budget spent, in
  the words the fleet row and the Research header both show — searches, reads,
  bytes and elapsed, never a percentage.
- `ResearchDocument.notices` and the `[from …]` provenance line: the source
  panel renders the notice list beside the excerpt, as data, escaped.
- `ResearchOperationResult.attention`: the attention item for a
  `handed_to_person` question.

## Adapters, as built

| Adapter | Reach | Auth | Rate | Search result | Read result |
| --- | --- | --- | --- | --- | --- |
| `web` | network | the person's existing web-search provider key | 20/min, 1 s apart, robots honoured | hits from the provider, normalised URL, title, snippet, date | bounded fetch → readable text, canonical URL, title, published date, digest |
| `project` | local (project trust) | project trust | unmetered, local | matches in the project's own files and git history | the file window or the commit, as `observed` evidence |
| `repository` | network | none for public hosts; a private host fails as git fails | 10/min | tags/releases and the resolved commit | README/licence/manifest/named files at an exact commit, with `RepositoryStateRef` |
| `package` | network | none | 20/min | registry search hits (npm, crates.io, Maven Central) | documented metadata for npm, PyPI, crates.io, the Go module proxy and Maven Central, with a licence class |
| `document` | local | local | unmetered | names the file | text/Markdown/JSON/CSV/source to bounded text; PDF is a recorded gap (D-351.f) |
| `scholarly` | — | — | — | descriptor only, `ships: "second"`, not shipped | — |
| `tracker` | — | — | — | descriptor only, `ships: "second"`, not shipped | — |

## Checkpoints

- **Claimed.** Read `docs/research-phase.md`, the tool contract, M26's fixture
  recipe and M21-T10's tool/bridge/command pattern; wrote this plan.
- **Protocol.** `packages/protocol/src/research.ts` (adapter descriptors,
  settings shape and defaults, the two operation shapes, the applier and its
  refusals, status derivation) and `derivedFrom` on `ResearchFinding`.
- **Worker.** `packages/worker/src/research/` — adapters, readable text,
  cache, budget, confidence, tools, playbook, command, bridge.
- **Settings.** Research sources descriptors in `packages/worker/src/settings.ts`.
- **Tests.** Every rule in the contract's Tests row, adapter result shapes
  from recorded fixtures, and the four tool-eval fixtures replayed against the
  real handlers.
- **Done.** 100 new tests in `packages/worker/test/research/` (readable text,
  budget + cache, operations + settings, adapters, tools + fixtures, the loop
  pieces). `pnpm -F @lasercode/protocol test` 619 passed;
  `pnpm -F @lasercode/worker test` 1452 passed; `pnpm -r build`,
  `pnpm -r typecheck` and `pnpm identity:check` green.
- **Not caused here, and reported:** `pnpm -F @lasercode/host test` has 64
  failures in this worktree, every one of them a test that spawns a real
  worker and gets "The app could not verify the project runtime it started".
  Reproduced on the clean base (`git stash -u`, `pnpm -r build`,
  `test/resources/worker-pool.test.ts` + `test/pressure/pool-road.test.ts`:
  the same 5 failures) before and after this task's changes, so it is the
  worktree's runtime-identity environment, not this work.

## What lands next (M21-T17, and where)

Nothing here is registered with the engine yet, exactly as M21-T10 left the
Design Index tools: the specs, handlers and bridge are final, and the missing
wire is one registration. When M21-T17 does it:

1. `registerLaserTool(pi, spec, handler)` for each of `researchToolSpecs(bridge.adapters())`,
   built from the session's own Research sources, so a disabled adapter's tool
   is genuinely absent from the surface rather than refused at the door.
2. Construct one `ProjectResearch` per research run with the host's
   `ResearchStore`, the person's `WebSearchService.search` as `webSearch`, and
   `createProcessRunner()` for git.
3. Start the session with `researchPlaybook({ question, researchRef, revisionId, adapters, budget })`.
4. Publish a `ResearchCommand` in the fleet and let a person's stop call
   `command.stop()`; the next tool call then refuses with the sentence that
   tells the run to report what it has.
5. Move `packages/worker/test/fixtures/tool-eval/research/*.json` one directory
   up, add the four names to `TOOLS` in `test/tool-eval/fixtures.test.ts`, and
   teach `ScriptedWorld` the research bridge beside `ScriptedResearchWorld`.
   The fixtures run unchanged; `test/research/tools.test.ts` replays them today.

## Files

| Path | What |
| --- | --- |
| `packages/protocol/src/research.ts` | adapter descriptors, `ResearchSources` + budgets + cache quota, the two operations, `applyResearchOperation`, `checkFindingConfidence`, `researchStatusFrom`, host allow/deny |
| `packages/protocol/src/project-work-bodies.ts` | `derivedFrom` on `ResearchFinding` + the `inferred` refinement (D-351.b) |
| `packages/worker/src/research/adapters/*` | `web`, `project`, `repository`, `package`, `document`, the two not-shipped descriptors, the bounded fetcher and the shared serve path |
| `packages/worker/src/research/{readable-text,cache,budget,confidence,tools,playbook,command,bridge,errors}.ts` | the loop's machinery and the four tools |
| `packages/worker/src/tool-eval/research-world.ts` | the scripted world: real everything, recorded network/search/git, host-faithful store |
| `packages/worker/src/settings.ts` | Research sources descriptors, `researchSourcesFrom()` |
| `packages/worker/test/research/*`, `packages/worker/test/fixtures/research/*`, `packages/worker/test/fixtures/tool-eval/research/*` | the tests, the recordings and the four conformance fixtures |
</content>
</invoke>
