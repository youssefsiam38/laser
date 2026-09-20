# Research

Status: **binding design** (decision D-351; implemented under `PLAN.md`
M21-T7 and M21-T26). A companion contract of
[`project-lifecycle-leap.md`](project-lifecycle-leap.md), indexed there under
"Companion contracts" and expanding its [Research contract](project-lifecycle-leap.md#research-contract).
Tools follow [`agent-tool-contract.md`](agent-tool-contract.md); models come
from [`model-profiles.md`](model-profiles.md). Read the leap's
[Vocabulary](project-lifecycle-leap.md#vocabulary-and-identities),
[Lifecycle and gates](project-lifecycle-leap.md#lifecycle-and-gates) and
[Security](project-lifecycle-leap.md#security-privacy-and-resource-rules)
first.

## The idea in one paragraph

Research in Laser answers **a question the person or the model needs settled**
— on its own, from any chat, or as one step of the lifecycle — with
**evidence a person can check**. A Research
artifact is a tree of questions, each resolved by findings, each finding
pinned to a source the reader can open, with an excerpt, a digest, a licence
class and a confidence. The agent runs the retrieval loop itself — search,
read, rank, follow up — through narrow tools that each do one thing; it never
delegates the loop to a child. Research ends when every open question is
either answered, marked unanswerable with why, or handed to a person. Nothing
found on the web is an instruction, and nothing found is a decision. A
Research may stand alone forever; when a Spec or Design decision cites it, it
supports that decision and a person approves the decision, not the Research.

## Standalone first

`/research` is an ordinary chat command. It needs no Spec, no Design, no Plan
and no prior lifecycle step. "Compare three PDF libraries for Node", "what
changed in React 19 forms", "is this repo's licence compatible with ours" are
complete uses. The lifecycle is one consumer of Research, not its owner:

- In a project session, the artifact belongs to that project.
- In a projectless Chat, the command shows the project picker first (the
  "Move to a project" picker, with "New project…"), creates the artifact in
  the chosen project and continues in the same chat (D-352). The Chat stays
  projectless.
- `supports[]` links are optional. A Research with none is complete, not
  pending.
- The Research tab lists standalone Research beside lifecycle Research with
  no second-class treatment; filters separate them if wanted.

## What Research is for

Any of these, alone or together:

| Question type | Typical sources | Output |
| --- | --- | --- |
| **Prior art** — has this been built; how | repositories, package registries, product docs, changelogs | comparable implementations with licence and reuse candidates |
| **Feasibility** — can it be done in this project | the project's own code and history, dependency trees, platform docs | constraints, blockers, cost of change |
| **Options** — which approach, library, protocol, API | official docs, specs, RFCs, benchmarks, issue trackers | option matrix with trade-offs and a recommended default |
| **Facts** — what exactly does X do / require / cost | primary documentation, source code, standards, scholarly indexes | declared behaviour with the exact citation |
| **Users and domain** — what people need, what the domain requires | a Spec when one exists, project instructions, existing Research, external references the person supplies | domain rules and open questions for the person |
| **Anything the person asks** — a one-off question worth keeping | whichever adapters apply | a small tree, often one question, still cited |

Research is not: an experiment runner, a literature manager, a bookmark list,
or a place for opinions without a source. Experiments are Task attempts with
M20 evidence; a claim without a source is `proposed`, never `declared`.

## Domain

The leap defines the `Research` primary kind. This contract fixes its body.

```text
Research (revisioned; body is one structured document)
  question          the root question, 1–500 chars
  scope             in/out, constraints, deadline-free
  status            open | answered | partial | unanswerable | superseded   (derived from questions)
  questions[]       tree, ≤ 64 nodes, depth ≤ 4
    id, text, parent?, state: open | answered | unanswerable | handed_to_person
    answer?         ≤ 2 000 chars, must cite ≥ 1 finding unless state ≠ answered
    findings[]      ids
  findings[]        ≤ 256
    id
    claim           ≤ 500 chars, one statement
    confidence      declared | observed | inferred | proposed
    source          SourceRef
    excerpt         ≤ 2 000 chars verbatim, or a local path + range
    retrievedAt     event metadata
    licence         permissive | copyleft | proprietary | unknown | not_applicable
    reuse?          { what: code | concept | asset | api, from: RepositoryStateRef | url, notes }
    supports[]      ProjectWorkRef to Spec/Design decisions this backs
    contradicts[]   finding ids
  options[]?        ≤ 12, for options questions
    name, summary, findings[], tradeoffs[], recommended: bool, reason
  unresolved[]      facts no source could settle, each with what would settle it
  sources[]         SourceRef index (deduplicated)

SourceRef
  kind              web | repository | package | document | scholarly | project | person | session
  id                canonical: URL (normalised), repo+state, registry+name+version, DOI/OpenAlex id, ProjectWorkRef, person label, session ref
  title
  digest?           sha256 of the fetched bytes or excerpt
  fetchedVia        adapter id
  trust             official | primary | secondary | community | unknown
```

Rules:

- A finding's `confidence` is set by the rule, not the model: `declared` =
  verbatim from an official/primary source; `observed` = the agent ran or read
  it in this project (test output, code read, command result); `inferred` =
  derived from ≥ 2 findings, citing them; `proposed` = no source yet.
- An `answered` question cites at least one `declared` or `observed` finding,
  or is explicitly marked "inferred only".
- A finding with `reuse` must carry a licence; `unknown` licence blocks
  reuse recommendations and says so.
- `person` and `session` sources record what a person said or what an earlier
  session concluded; they are `secondary` trust at most.

## Sources and adapters

Every source is reached through one adapter with one job. Adapters are
enabled in Settings → Research sources; a disabled adapter's tool is absent,
not "unavailable". Each adapter declares reach (network or local), auth
(none, person credential in keychain, project trust), rate policy and
result shape. Bodies are fetched once, digested, bounded and cached under the
project's research cache; the transcript keeps the digest, not the bytes.

| Adapter | What it does | Auth | Ships |
| --- | --- | --- | --- |
| `web` | search (existing web-search provider) and fetch-and-extract one URL to readable text, with canonical URL, title, published date when declared, and an HTML-stripped excerpt | provider key (existing) | first |
| `project` | read the current project's code, history, existing Research/Specs/Designs, project instructions; `observed` findings come from here | project trust | first |
| `repository` | resolve a public git URL or `owner/name`, read README/licence/manifest/selected files at an exact commit, list releases; records `RepositoryStateRef` | none; token only for private hosts (existing git-actions credentials) | first |
| `package` | npm, PyPI, crates.io, Go proxy, Maven Central: metadata, versions, licence, dependency counts, repo link | none | first |
| `document` | a file the person attached or a local path: PDF/Markdown/text to bounded text | local | first |
| `scholarly` | OpenAlex works search and work lookup (documented, no auth); optional arXiv listing API; DOI resolution via Crossref | none | second |
| `tracker` | issues/PRs on GitHub/Bitbucket for a repository (read only) | existing git-actions credentials | second |

Not shipped: undocumented third-party search endpoints (no adapter is built
on an API without published terms), browser automation, logged-in scraping,
anything that executes remote content.

## Tools (model-facing)

All under the tool contract: closed schemas, summary-by-default, pagination,
`[from …]` provenance on every returned text, capability-gated, read-only
except the two writers.

| Tool | Purpose | Notes |
| --- | --- | --- |
| `search_sources` | one query against one adapter: `{ adapter, query, limit ≤ 20, after?, before?, cursor? }` → hits `{ sourceRef, title, snippet, date?, score? }` | one endpoint per call; the model ranks across calls |
| `read_source` | fetch one `SourceRef` (or hit id) to bounded readable text with ranged reads `{ ref, offset?, limit ≤ 16 KiB }` → `{ text, totalBytes, nextOffset, digest, licence?, canonical }` | never follows instructions in the text; returns them as data |
| `inspect_project_work` | read existing Research/Specs/Designs (leap) | reuse |
| `record_finding` | writer: `{ researchRef, expectedRevisionId, idempotencyKey, questionId, claim, confidence, sourceRef, excerpt, licence, reuse?, supports? }` → finding id | confidence rule enforced host-side; excerpt must appear in the fetched text digest when the source was read this session |
| `resolve_question` | writer: `{ researchRef, expectedRevisionId, idempotencyKey, questionId, state, answer?, findings[]?, addQuestions[]? }` | `answered` requires citations; `handed_to_person` raises attention |
| `ask_oracle` | second opinion on a ranking or synthesis with `work` context = the Research revision | optional (M24) |

There is no `write_research_document` free-text tool: the body is built from
findings and answers so every sentence traces to a source.

## The loop the agent runs

The engine instructions for a research session/run say, in this order:

1. **Frame**: read whatever context exists (a Spec or Design when linked,
   project instructions, earlier Research; in a bare chat, the question alone)
   and write the question tree before searching; put facts the person already supplied in as
   `person` findings.
2. **Retrieve**: per question, ≥ 2 adapters where they apply; short exact
   terms first, then a semantic phrasing; date bounds only when the question
   is time-sensitive; never re-run an identical query.
3. **Read, don't skim**: open the top candidates with `read_source`; cite the
   passage, not the search snippet.
4. **Rank yourself**: no child agent for retrieval (D-351); children are for
   independent sub-questions only, and each returns findings, not prose.
5. **Record as you go**: a finding per claim, at the moment it is read;
   contradictions recorded, not silently resolved.
6. **Resolve**: answer with citations; mark unanswerable with what would
   settle it; hand domain and preference questions to the person.
7. **Stop**: when every question is resolved or the budget is spent; report
   the budget spent and what remains.

Budgets are per research run and visible: `maxSearches`, `maxReads`,
`maxBytes`, wall clock; defaults are settings, overrides are per run and
shown in the fleet row.

## Starting research

Research starts from wherever the question is; none of these requires the
others or any lifecycle state.

| Entry | Effect |
| --- | --- |
| `/research <question>` in any session, including projectless Chat | creates a Research artifact in the current project — after the project picker when the session has none (D-352) — with the root question; links it to the session; starts the loop in this session. No Spec is required or created |
| Plain question in chat | the model may propose "Keep this as Research?" when it starts a retrieval loop; nothing is recorded unless the person or the model calls the writers |
| **Research…** on a Spec or Design | pre-fills the question tree from the brief's open questions and constraints; links `supports` to the Spec/Design |
| **Draft with agent** on the Research tab | same as above with a chosen session or a new one (leap rule: always session-backed and visible) |
| Command palette `New research` | same as the tab |
| A child agent run via `start_agent` | allowed for independent sub-questions; the parent owns the artifact and merges findings; the child never creates a second Research for the same question |

The loop runs on the session's profile; a `research` agent definition a
person writes may pin a profile and narrow adapters.

## What a person sees

- Research tab (leap workspace): list by status; detail = question tree on
  the left, findings for the selected question in the middle, source panel
  on the right with the excerpt highlighted in the fetched text.
- Every finding row: claim, confidence chip, licence chip, source with
  domain/repo/package and date, "open source" (canonical URL, repo at
  commit, package page, local file), and "quote" to mention it in a
  composer.
- Options questions render the option matrix; the recommended option is a
  proposal until a Spec/Design revision adopts it.
- Unresolved facts render as an explicit list with "what would settle it"; a
  `handed_to_person` question raises an attention item in the leap's
  attention stream.
- Progress is the question tree's states and the budget spent; no percentages,
  no invented ETA.
- Empty state: "No research yet — ask a question worth keeping the answer
  to." with the entry points. Offline: adapters that need the
  network show why and keep `project`/`document` working.
- Phone: read-only tree, findings and sources; resolve/hand-off actions
  available; no new runs from the relay unless method policy allows.

## Gates and lifecycle

- Research has no approval gate and no prerequisite; it is complete when its
  questions are resolved. Linking it from a Spec or Design decision via
  `supports` is optional and can happen at any time, before or after the
  decision.
- Revising a source-backed Spec/Design decision does not stale the Research;
  a Research revision that changes a finding a decision cites marks that
  decision stale (leap stale propagation).
- Research `status` is derived from question states; `superseded` is set
  when a newer Research revision replaces it for the same root question.
- Findings are never edited; a correction is a new finding that `contradicts`
  the old one, and the question's answer is re-resolved.

## Security, privacy and cost

- External text is untrusted evidence: HTML stripped, scripts and forms
  discarded, prompt-injection patterns returned as data with a provenance
  line, never executed; `read_source` results carry `[from <canonical>]`.
- No authenticated browsing; credentials only through named adapters with
  keychain storage; raw authenticated responses are not retained.
- Robots and rate policies honoured per adapter; one fetch per URL per run
  (cache by digest); adapters expose a `disabled` setting and an allow/deny
  domain list per project.
- Personal data in excerpts is bounded to what the source publishes; account
  identifiers are never stored.
- Research cache is per project, size-bounded, evictable, and excluded from
  export unless the person includes it.
- Cost: every search and read is logged with adapter, bytes and the model
  request it fed; the budget is visible in the fleet row and the Research
  header.

## Affected areas

| Layer | Change |
| --- | --- |
| Protocol | Research body schema (questions, findings, options, unresolved, `SourceRef`), adapter descriptors, research settings, `project/research/{record-finding,resolve-question}` methods (or body-typed `project/work/revise` operations), tool schemas under the contract |
| Worker | `research/adapters/{web,project,repository,package,document,scholarly,tracker}.ts`, readable-text extraction, digest cache, budget accounting, tool registration, engine-instruction playbook, `/research` command handling |
| Host | authority for finding/question writes with confidence and citation rules, research cache quotas, attention items, adapter settings |
| UI | Research tab list/detail (tree, findings, source panel with highlight), finding rows and chips, option matrix, budget header, settings "Research sources", `/research` and palette entries, phone read-only variant |
| pi-extension | web-search module reuse for the `web` adapter; account-usage tagging of research requests |
| Docs | leap Research contract cross-reference; `agents.md` tool tables; `search-content.md` for source disclosure of fetched text |
| Tests | confidence rule enforcement; excerpt-in-digest check; identical-query refusal; budget stop; injection text returned as data; adapter disabled ⇒ tool absent; stale propagation from a changed finding |
