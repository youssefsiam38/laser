# Project lifecycle leap

Goal: make the complete coding lifecycle a first-class, embedded part of Laser.
A project owns durable Specs, Research, Designs, Plans and Tasks. A person can
open, edit, review, approve, mention and execute them from any session without
making that session their owner. The lifecycle runs from a brief through
research and design to an approved implementation plan, dependency-ordered
Tasks, execution, verification and convergence.

This document is the binding product and implementation contract for M21. Its
entity names, ownership rules, revision semantics, gates, surfaces and security
boundaries are decisions, not illustrative suggestions. The dependency-ordered
implementation index remains in [`PLAN.md`](../PLAN.md#M21--the-project-lifecycle-leap).

Done when: two sessions in one project and a projectless Chat can mention the
same Spec, Design, Plan and Task by stable identity; deleting either session
leaves every entity intact; an established project can produce and approve a
code-backed design that follows its real design system; a greenfield project
can approve a proposed foundation before source is written; an approved Plan
produces dependency-ordered Tasks; a Task can be attempted in multiple sessions
without becoming a run; implementation is reviewed through M20 checkpoints and
diffs; verification links evidence and deviations to the exact approved
revisions; restart, project relocation, worktrees, phone review and relay
reconnection preserve the same project state; no project entity becomes a
fleet item or an extension-defined panel.

Dependencies: M13's harness and run registry, M18's bounded worker-free reads,
M20's accepted source-control leap, and M16-T86 before composer mention work.
M21 implementation starts after the person accepts M20's sandbox. M17-T11's
session `plan` mode is absorbed: permission modes become **Explore** and
**Build**, while **Plan** means the project artifact.

## Product boundary

- **The project owns the lifecycle.** Every primary entity carries a stable
  `projectId`; no primary entity carries an owning `sessionId`.
- **Sessions are contexts, not containers.** A session may create, mention,
  revise or execute project work. Those relations are many-to-many links that
  may disappear without deleting either side.
- **The domain is closed.** The primary kinds are Spec, Research, Design, Plan
  and Project Task. Adding another primary kind requires a decision and a
  protocol change; this is not the panel bus returning.
- **Execution remains execution.** Agent runs and background commands retain
  their existing session-scoped identities and Fleet rendering. A Project Task
  may link to many runs; it never becomes a third fleet kind.
- **Goals remain session-local.** A Project Task may start a session whose goal
  describes the current attempt, but the goal does not own or replace the Task
  and cannot change project state without the project-work tools.

This narrowly supersedes D-140's statement that nothing persists above runs.
D-140's harness, sessions, run lifecycle and worktree ownership remain binding.
D-147 remains binding: the new workspace is a Laser-owned product destination,
not a general UI bus and not a place extensions can declare surfaces.

## Vocabulary and identities

Primary entities:

| Entity | What it owns | Required contents | Independent use |
| --- | --- | --- | --- |
| **Spec** | The product outcome and its lifecycle | Brief, problem, outcomes, non-goals, requirements, acceptance, constraints, linked revisions | may exist before Research, Design or Plan |
| **Research** | Evidence used to make a decision | question, sources, excerpts, findings, provenance, licence, confidence, unresolved facts | may support several Specs or Designs |
| **Design** | The intended experience | foundation, flows, screens, states, `DesignTree`, profile digest, fidelity, assets, review comments | may be reused or revised independently |
| **Plan** | The dependency-ordered implementation strategy | phases, dependency graph, boundaries, risks, verification, linked approved inputs | may cover one or more Specs |
| **Project Task** | One bounded unit of intended project work | outcome, dependencies, scope, acceptance, assignee policy, evidence and attempts | may be resumed from any session |

Supporting records:

| Record | Purpose |
| --- | --- |
| **Comment** | Threaded review anchored to a revision and semantic target; open → addressed → resolved |
| **Approval** | Actor, gate, immutable revision digests, decision and permission mode |
| **Decision** | A durable choice with rationale, consequences and supersession |
| **Evidence** | Test, diff, screenshot, source location, commit, review or person acceptance |
| **Execution link** | Joins a Project Task to a session, agent run, checkpoint, branch or command without transferring ownership |

Every identity is opaque and stable. Slugs and titles may change. A reference is:

```text
ProjectWorkRef = projectId + kind + entityId + revisionId + digest + label
```

The revision and digest are mandatory in a sent message, approval, execution
packet and evidence record. UI navigation may follow `currentRevisionId`, but a
historical transcript never silently changes what it referred to.

## Relationship graph

```text
Project
 ├─ Spec ─────────────┬─ Research revisions
 │                    ├─ Design revisions
 │                    ├─ Plan revisions
 │                    └─ Decisions / approvals / comments
 ├─ Design ───────────── may support several Specs
 ├─ Plan ─────────────── depends on approved Spec + Design revisions
 └─ Project Tasks ────── form the Plan DAG
        ├─ execution links ── sessions / agent runs / commands
        ├─ checkpoints and diffs
        └─ verification evidence

Session ── mentions ProjectWorkRef[] and may link execution
        └─ never owns, cascades or deletes project work
```

Deleting or archiving a session retains its references and execution history as
unavailable links. Removing a project hides its work but retains it until an
explicit **Delete project work** confirmation. Reattaching or relocating the
project reconnects the stable `projectId`; a path match alone never merges two
project histories.

## Canonical persistence

The authority is a host-owned `ProjectWorkStore` under the product state root,
partitioned by stable `projectId`, not by session path or current filesystem
path. It contains:

- a versioned transactional database for entities, immutable revisions, edges,
  comments, approvals, decisions, evidence, execution links and project event
  sequence numbers;
- content-addressed blobs for large design trees, screenshots, source captures
  and generated previews, each with length, media type and digest;
- a bounded search projection containing only searchable values, never binary
  image bytes, credentials or hidden metadata;
- atomic schema migrations, integrity checks, backup-before-migrate and refusal
  of a database written by a newer version;
- per-project and global byte/count quotas, visible release states for
  reproducible derived data, ranged reads and no worker spawn for browsing or
  search. Canonical revisions and approval history require explicit deletion;
  at their cap the store refuses a new write with a recovery action.

The selected project directory remains source, not lifecycle storage. Laser
never writes lifecycle drafts into the repository merely because an agent
planned something. A person may explicitly publish or export a revision to a
chosen repository path, including `<project>/.laser/work/`; that export is a
snapshot, never a second authority. Import and re-import require a preview and
conflict decision.

A worktree resolves to the parent project's `projectId` through M20's
`workspaceShape` and common-dir ownership. Worktree sessions therefore see the
same Specs and Tasks, while their execution links retain the checkout and branch
where work happened.

Every mutation uses optimistic concurrency (`expectedRevisionId`), an
idempotency key and one transaction. A stale write returns the current revision
and a merge/retry choice; it never overwrites another session's work.

## Revision and staleness model

- Revisions are immutable. Editing creates a child revision and moves the
  entity's current pointer only after the write commits.
- Dependency edges name exact revisions and a relation such as `supports`,
  `implements`, `depends_on`, `verifies`, `supersedes` or `derived_from`.
- Changing an approved upstream artifact marks dependent revisions **stale**;
  it never rewrites, deletes or silently re-approves them.
- A stale Design pauses new dependent implementation. A stale Plan prevents
  not-yet-started Tasks from starting; already-running attempts may finish but
  cannot mark the Task done until reconciliation.
- Branching conversation history does not branch project work automatically.
  A session fork keeps the same references. A deliberate artifact fork creates
  a new revision or entity and records its origin.

Artifact review states are `draft`, `needs_review`, `approved`, `stale`,
`superseded` and `archived`. They use the existing status tones; no new status
colour is introduced.

Project Task states are `draft`, `blocked`, `ready`, `in_progress`,
`needs_review`, `done` and `cancelled`. A failed execution attempt is evidence,
not a failed Task. The Task becomes blocked, remains in progress, or starts a
new attempt through an explicit transition. `done` requires acceptance evidence.
There is no model-invented percentage or scheduling metadata.

## Lifecycle and gates

```text
Shape
  Spec brief → Brief approval → Research → Design → Design approval

Commit
  Full Spec → Plan → Project Tasks → Build approval

Execute
  Implement → Verify and converge → Done or revise an upstream artifact
```

The Spec is both the lifecycle root and the evolving requirements document. Its
Brief revision is deliberately small; after Research and Design, a full Spec
revision records the agreed behavior and acceptance criteria.

There are three hard gates:

| Gate | Required revisions | Outcomes |
| --- | --- | --- |
| **Brief** | Spec Brief | approve direction · request changes · archive |
| **Design** | Design plus Design Profile digest; skipped only with a recorded no-UI reason | approve · request changes |
| **Build** | full Spec, Design or skip record, Plan and complete Task graph | build autonomously · build with manual tool review · request changes |

An approval records the complete digest set. Blocking comments prevent approval.
The agent may mark a comment addressed but only the person resolves it or
approves all addressed comments. A change request creates a revision; it never
edits the approved bytes. Material changes invalidate the affected gate and
only the downstream graph reachable from that revision.

Verification produces evidence but does not invent approval. Passing all
machine-verifiable acceptance criteria may move a Task to `needs_review`; the
person or an explicit approved policy moves it to `done`. A completed Spec can
be reopened by a new revision without erasing the delivered revision.

## Research contract

Research is a typed, project-owned artifact rather than prose trapped in a
session. Each finding carries its question, source identity, retrieval time in
the event metadata, bounded excerpt or local path, source digest where possible,
licence/reuse classification, confidence (`declared`, `observed`, `inferred`,
`proposed`) and which Spec or Design decision it supports.

External content is untrusted evidence. Instructions found in researched pages
are never executed. Secrets, raw authenticated responses and personal account
identifiers are not retained. Repository research records exact repository,
revision, package, licence and the code or concept proposed for reuse. A
Research revision can be mentioned or reused by any later session.

## Design contract

React is the implementation engine for Laser's embedded design workspace. It
is not the target application's framework and never changes the framework a
project ships.

| Layer | Contract |
| --- | --- |
| Laser workspace and composition canvas | React, tokenized through Laser's visual system |
| Saved `DesignTree` | framework-neutral nodes, token references, variants, states, flows and stable ids |
| Project design system | the project's real tokens, components, assets, themes, constraints and philosophy |
| Native validation | the project's actual framework, build system and components |
| Production implementation | the project's actual framework and repository conventions |

A `DesignSystemManifest` normalizes stack, token sources, themes, typography,
icons, assets, breakpoints, component imports, props, variants, examples,
providers, layouts, accessibility constraints, philosophy and provenance. It is
a derived index: existing project code remains authoritative. Each field is
labelled `declared`, `observed`, `inferred` or `proposed` and cites its source.
Conflicts and gaps remain visible.

Discovery is adapter-driven and non-executing by default:

- parse manifests, lockfiles, design documents, CSS variables, DTCG data,
  Tailwind themes and typed token objects without importing project config;
- inspect exports, prop types, registries, Storybook/Ladle/Cosmos examples,
  consuming screens and framework metadata;
- after explicit trust, run the project's own preview to observe computed
  styles, component stacks, responsive behavior and interaction states;
- preserve original token and component identities instead of translating the
  project into a generic house design system;
- cache by source digest and mark every dependent Design stale when an
  authoritative source changes materially.

The workspace has two complementary renderers:

1. **Composition** — the React canvas renders `DesignTree` through the project's
   design-system adapter. React projects may mount actual components; other
   frameworks use verified design-time mappings without claiming native
   execution.
2. **Native validation** — an isolated runner renders the proposed screen with
   the project's actual Vue, Svelte, Angular, React, Web Components, Flutter,
   SwiftUI, Compose or other supported adapter. It proves framework behavior,
   provider requirements and responsive states.

Every design node records one fidelity label: **Native** (actual project
runtime), **Mapped** (verified design contract and tokens) or **Proposed**
(new foundation/component). A screen shows the conservative aggregate and can
reveal the per-node labels. Mapped is never presented as Native. Approval may
require Native evidence per project policy; the person may explicitly accept a
Mapped limitation with its reason.

A Design revision contains foundation decisions, Design Profile digest, flows,
screens, applicable themes, viewports, interaction states, fixtures, component
nodes, token references, assets and native-validation evidence. Loading, empty,
error, permission, offline, focus, keyboard, touch and reduced-motion states are
included where applicable or skipped with a reason. The model cannot submit raw
HTML, executable JavaScript, free-form CSS, event handlers or unvalidated URLs.

For a greenfield project, Design first proposes a foundation: principles,
primitive and semantic tokens, modes, typography, icon and asset sources,
layout rules, motion, accessibility floor and core component contracts. Sandbox
components live in Laser state and do not modify the repository. The approved
Build Plan implements the foundation before dependent feature Tasks. Once built,
source replaces the proposal as the authoritative profile.

Review comments anchor to a stable design node, token, flow edge, text range or
whole screen. Coordinates only position a pin; they are not the identity. A
revision preserves anchors where ids survive and shows removed anchors as
orphaned rather than losing them. Several comments can be batched into one
revision request with a before/after node diff.

Open-source libraries are implementation details behind Laser-owned adapters.
Puck may be evaluated as a React composition renderer; react-grab or a small
serve-time tagger may support React source context; Storybook, shadcn registries,
react-docgen, Terrazzo, Style Dictionary and source parsers may feed manifests.
No upstream schema becomes canonical. Every dependency is exact-pinned,
permissively licensed and replaceable; mixed-licence directories, hosted
services, telemetry and source mutation are excluded unless separately approved.

## Plan and Project Task contract

A Plan is a dependency graph, not a chronological schedule. It records phases,
Tasks, declared dependencies, package/layer boundaries, data migrations,
security and accessibility consequences, risk controls, verification and
rollback. It contains no model-invented scheduling metadata or progress
percentages.

A Project Task is one bounded action with:

- one outcome and explicit non-goals;
- dependency ids and readiness derived from their accepted states;
- affected package/repository scope and declared capabilities;
- acceptance criteria, verification commands and required visual evidence;
- assignment policy (`unassigned`, `person`, or an agent definition) without
  embedding a session or run id;
- attempts, checkpoints, diffs, commits, reviews, comments and final evidence as
  linked records.

A Task may have several execution attempts, sequential or deliberately parallel.
A run ending never automatically marks the Task done. A failed run records its
reason and leaves the Task actionable. Two active Tasks whose declared or
observed file scopes overlap show a conflict before another write starts; the
person may serialize them, isolate them or explicitly accept shared-checkout
risk.

The noun **Task** in this workspace always means `ProjectTask`. Existing
long-running shell work is called **Command** in person-facing Fleet copy. Its
wire type and model tools remain `BackgroundTask`, `task_output` and `task_stop`
for compatibility. Project Tasks never enter `tasks/list` and never appear as a
fleet kind.

## Execution and convergence

Starting a Task creates an execution link before any prompt is sent. The person
chooses an existing eligible session, a new top-level session or an agent run;
the owning project determines the worker and checkout. A session from another
project may discuss the Task but cannot execute it in the wrong project; Laser
offers to open or create an execution session in the owning project.

The implementation context packet contains exact approved revisions, unresolved
comments, Task dependencies, acceptance criteria, project instructions and the
last attempt's evidence. It is bounded, provenance-labelled and refreshed at
model-call boundaries. The agent receives tools to inspect project work, create
revisions, request review and report Task evidence; those tools call a
worker-supplied bridge and never persist through Pi.

Each implementation attempt records its session/run identity, workspace shape,
checkout, base commit, M20 checkpoints, changed repositories and terminal
outcome. Checkpoints and git determine changed files; tool calls never do.
Commit, push and pull-request actions retain M20's explicit previews and
confirmations.

Verification compares the implementation against four authorities:

1. Spec acceptance criteria and behavioral tests.
2. Design states, token/component usage and native visual evidence.
3. Plan boundaries, security, accessibility and migration requirements.
4. Task-specific commands, diffs, reviews and person feedback.

The verifier may fix an implementation within the approved packet. A required
behavioral or visual change to an approved upstream artifact creates a new
revision, marks the reachable graph stale and pauses only affected Tasks. The
final report lists satisfied criteria, deviations with reasons, evidence links
and remaining person decisions. Nothing is called converged while a blocking
comment, stale approval or failed required check remains.

## Cross-session mentions and context

The existing assistant-ui mention adapter gains project-work results; it is not
forked. Typing `@` searches child handles and paths as today, plus project work
with category prefixes such as `@spec:`, `@research:`, `@design:`, `@plan:` and
`@task:`. The current project's results rank first; other accessible projects
are grouped and labelled. Picking one finishes the query under D-299/D-304 and
inserts one accessible chip.

The stored message carries the typed `ProjectWorkRef`, while visible/copied text
uses a stable human form. At send time the host validates the project, revision,
digest and read scope, then supplies the exact bounded projection to the worker.
The transcript chip opens the embedded workspace at that revision. Search
indexes the visible title and projected content once, never duplicate preview
or hidden JSON.

Any session, including projectless Chat, may mention an entity from any project
the environment permits it to read. Reading does not retarget the session's
cwd. A mutation or execution is always routed to the entity's owning project
and requires that project's trust and method scope. A cross-project mention is
therefore useful context, not an implicit multi-project worker.

Mentioned content is captured by reference, not copied into the session file.
Soft-deleted revisions remain readable to historical messages. If policy or
retention makes a body unavailable, the chip keeps its identity and explains
why instead of resolving to whatever is current.

## Protocol and authority

All public methods are engine-neutral and originate in `@lasercode/protocol`.
The initial inventory is:

| Family | Methods |
| --- | --- |
| Read | `project/work/list`, `project/work/get`, `project/work/search`, `project/work/blob/read` |
| Write | `project/work/create`, `project/work/revise`, `project/work/archive`, `project/work/delete` |
| Review | `project/work/comment`, `project/work/review`, `project/work/approve`, `project/work/resolve-comment` |
| Relations | `project/work/link`, `project/work/unlink`, `project/task/action`, `project/task/link-execution` |
| Live | `project/work/updated`, `project/work/attention` notifications with project sequence numbers |

Every request schema has a round-trip sample, router owner, environment reach,
method scope, byte limit and conflict behavior. Reads are served by the host
without starting a worker. Writes use the host authority. Worker model tools use
a typed bridge to that authority through one `project-work` companion module;
nothing above the worker imports Pi and no new bridge package is created.

The compact model tool surface is `inspect_project_work`,
`write_project_artifact`, `request_project_review` and `report_project_task`.
Tool descriptions state the current project and revision rules. They are
feature-gated, carry the normal optional activity label, expose no host paths or
storage layout and return references rather than large bodies.

## Embedded workspace

The selected project's top bar has one **Specs** control with concise state,
for example `3 specs · 1 review`. It opens a Laser-owned workspace inside the
main shell; it does not open a browser, a second window or a transcript panel.
The conversation remains mounted so its scroll, draft, stream and approvals
survive closing the workspace.

Desktop workspace:

```text
[project + back] [Overview · Specs · Research · Designs · Plans · Tasks] [search]
┌ entity list / filters ┬ document, graph or canvas ┬ inspect / comments / history ┐
│ status and attention │ exact selected revision   │ sources, links, review        │
└───────────────────────┴───────────────────────────┴───────────────────────────────┘
```

The workspace uses the thread's available width. It temporarily gives its
primary artifact the room normally held by Fleet and Monitor rather than adding
another permanent shell column; a person's saved shell preferences return on
close. At constrained desktop widths, inspector and comments become a sheet.
On phone, project overview → entity list → full-screen detail is a forward/back
path with a sticky review footer and no horizontal page scroll.

The Overview answers five questions: what is active, what needs review, what is
ready, what is blocked, and what changed recently. Specs show lifecycle stage
and linked artifacts. Research is source-first. Designs open flows/canvas and
review. Plans show declared dependencies. Tasks offer list and dependency-board
views without a percentage or timeline guess.

All entity surfaces have intentional empty, loading, stale, conflict, offline,
permission and damaged-data states. Keyboard, pointer and touch reach the same
actions. Dark/light, LTR/RTL, coarse pointer, reduced motion and the 12px data
floor are release requirements.

Use the assistant-ui catalog rather than recreating claimed surfaces:
`agent-plan`, `todo-list`, `research-report`, `approval-card`, `artifact-card`,
`timeline`, `spec-sheet`, `data-table`, `checkpoint-history`, `canvas-split`
and the shared Markdown renderer are installed or reinstated when their producer
lands, stripped of demo data and restyled through Laser tokens. The inventory is
updated in the same change. The design canvas itself is Laser's domain surface,
not assistant-ui Generative UI and not model-authored presentation.

Lifecycle review requests appear in the transcript only as a durable, compact
link to the exact revision and, when an answer is required, through the existing
Approval Card above the composer. Enter never approves. Full reading and editing
happen in the embedded workspace. This preserves D-147's rule against an
extension panel bus and the fleet's closed work model.

Laser-owned slash commands `/spec`, `/design` and `/plan` create or open the
corresponding project workspace destination; they do not become engine commands.
If no project is selected, they open project choice. Command-palette and pointer
paths perform the same action.

AI-assisted authoring is always session-backed and visible. **Draft with agent**
or **Revise with agent** targets the current eligible session, another chosen
session or a new top-level session in the owning project. That session's model
uses the project-work tools; Laser does not run a hidden second model, disguise
an agent run as a design operation or make the resulting entity session-owned.

## Security, privacy and resource rules

- Static discovery parses source without executing project configuration.
  Running a native preview or project build requires explicit project trust and
  names the command/capability before it starts.
- Preview code runs outside the main renderer with sandboxing, context isolation,
  no Node bridge, scrubbed credentials, an environment allow-list, navigation
  guards and network off unless the person explicitly enables it.
- Project output is untrusted text/data. No raw HTML, JSX, script, CSS or SVG
  reaches the Laser renderer; URLs, assets and component props are validated.
- The React composition engine and native preview are lazy chunks/services.
  Closing the workspace stops preview infrastructure after a bounded idle period;
  it never becomes hidden permanent fleet work.
- Phone and relay clients receive bounded frames, semantic hit regions and typed
  artifact data, not executable project bundles. Environment policy may make
  preview read-only while retaining comments and approval.
- Lists are paged, bodies and blobs are ranged, notifications carry summaries,
  and per-project/global budgets release derived previews and caches first.
  Canonical revisions, comments and approvals are never evicted automatically;
  a full durable budget refuses the write and offers export or explicit cleanup.
  Released derived content is labelled, never returned as empty.
- Search uses the shared value-only projection contract. Secrets, ignored files,
  credentials, hidden metadata and binary blobs are excluded at ingestion.
- Export, deletion, approval, Build-mode entry and any destructive reconciliation
  require explicit confirmation and an audit event naming actor, project and
  exact revisions without body content.

## Import, export and interoperability

Laser may import GitHub Spec Kit, OpenSpec, compatible Markdown, issue trackers
and an existing `PLAN.md` through explicit adapters. Import creates a previewed
revision with provenance; it never watches an external tool as a second writer.
Export produces deterministic Markdown plus a machine-readable manifest with
stable ids, revision digests, relations and attachment references. Re-export is
an explicit replace or new-revision decision.

Optional Figma, Penpot, Storybook or registry connectors are project sources,
not required infrastructure and not authorities over Laser approvals. Offline
and self-hosted paths remain complete. Every imported component, asset or code
candidate retains licence and source provenance.

## Implementation index

The stable task ids, dependencies and acceptance criteria remain in
[`PLAN.md`](../PLAN.md#M21--the-project-lifecycle-leap). Execution state and
evidence remain in [`STATUS_DETAILED.md`](../STATUS_DETAILED.md#M21--the-project-lifecycle-leap).
