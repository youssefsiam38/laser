# Project lifecycle leap

Goal: make the complete coding lifecycle a first-class, embedded part of Laser.
A project owns durable Specs, Research, Designs, Plans and Tasks. A person can
open, edit, review, approve, mention and execute them from any session without
making that session their owner. The lifecycle runs from a brief through
research and design to an approved implementation plan, dependency-ordered
Tasks, execution, verification and convergence.

This document is the binding product and implementation contract for M21 and
the root source of truth for the whole leap. Its entity names, ownership
rules, revision semantics, gates, surfaces and security boundaries are
decisions, not illustrative suggestions. Companion contracts that the leap
depends on are listed under [Companion contracts](#companion-contracts); a
rule stated there binds here. The dependency-ordered implementation index
remains in [`PLAN.md`](../PLAN.md#M21--the-project-lifecycle-leap).

Done when: two sessions in one project and a projectless Chat can mention the
same Spec, Design, Plan and Task by stable identity; deleting either session
leaves every entity intact; an established project can produce and approve a
code-backed design that follows its real design system; a greenfield project
can approve a proposed foundation before source is written; an approved Plan
produces dependency-ordered Tasks; a Task can be attempted in multiple sessions
without becoming a run; implementation is reviewed through M20 checkpoints and
diffs; verification links evidence and deviations to the exact approved
revisions; artifact revisions retain exact many-to-many links to the repository
states and changes they came from, produced or verified; restart, project
relocation, worktrees, phone review and relay
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
| **Repository link** | Joins an exact artifact revision to an exact repository state or change as `based_on`, `implemented_by`, `verified_at` or `published_as` |
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

Artifact revision ── repository links ── exact commits / checkpoints / changes

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
  comments, approvals, decisions, evidence, repository links, execution links and
  project event sequence numbers;
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

## Repository provenance

Git is source and implementation evidence, not the authority for project work.
The store gives every repository in the project's M20 `workspaceShape` a stable,
opaque `repositoryId` independent of its checkout path, worktree, branch or
remote URL. A repository link has this closed shape:

```text
RepositoryLink =
  projectId + linkId + subject: ProjectWorkRef
  + relation: based_on | implemented_by | verified_at | published_as
  + repositoryId
  + target: RepositoryStateRef | RepositoryChangeRef
  + createdBy + createdAt + supersedesLinkId?

RepositoryStateRef =
  vcs: git + objectFormat + commitObjectId
  + checkpointId? + path? + blobObjectId? + contentDigest?

RepositoryChangeRef =
  base: RepositoryStateRef + head: RepositoryStateRef + diffDigest
```

An M20 checkpoint is a commit object, so uncommitted work is linked through its
exact checkpoint id and object id rather than through a mutable working tree.
The optional path is repository-relative and names the path at that state; the
blob object id and content digest fence file-level evidence. One artifact
revision may link several repositories, states or changes, and one repository
state or change may link several artifact revisions. `based_on` and `verified_at`
target states, `implemented_by` targets a change, and `published_as` targets a
state plus its exported path.

A worktree shares its repository identity with its common-dir owner. Relocation
reconnects an already-known identity through the project relink flow; neither a
path nor a matching remote silently merges or replaces repository history.

Commit object ids and digests are identity. Branch, checkout, worktree, pull
request and scrubbed remote are display or execution context only. Moving a
branch, rebasing, relocating the project or removing a worktree never retargets
a historical link. If Git no longer has the object or a checkpoint was pruned,
the link keeps its recorded identity and reports the source as unavailable; it
never resolves to current `HEAD`. A correction appends a superseding link and
retains the old provenance. A repository link used to approve an artifact,
accept delivery or mark a Task done must remain reviewable: if its Git object is
not durably reachable, Laser first stores the bounded diff manifest and required
source captures in the content-addressed store. A full durable budget refuses
the gate instead of accepting digest-only evidence. Session checkpoint retention
may then prune its ref without deleting the canonical evidence.

`based_on` records the code state an artifact revision was derived from;
`implemented_by` records the exact delivered change; `verified_at` records the
state against which its evidence ran; `published_as` records an explicit
repository export. Creating any of these links does not approve an artifact,
complete a Task or make Git a second lifecycle writer. Ordinary `HEAD` movement
does not make an artifact stale. Only a material change to a declared
authoritative source, detected by its fenced path/blob/profile digest or
recorded during reconciliation, applies the stale rules below.

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

## Flexibility

The lifecycle is one way to use the artifacts, not the way (D-352). The rules
below override any reading of this document that would make an artifact wait
on another.

**Any command, alone, from any session.** `/spec`, `/research`, `/design` and
`/plan` each work by themselves. The text beside the command is the whole
input: `/plan <text>` treats that text as the Plan's own brief and produces the
Plan and its Tasks without creating a Spec; `/design <text>` produces a Design
with no Spec and no Research; `/research <text>` a Research with nothing else.
A Spec is created only by `/spec` or by an explicit later choice.

**Any order, any subset.** Research after Design, Plan before Spec, Tasks with
nothing above them, a Spec that never gets a Design — all normal.

**Links are optional in every direction.** `supports`, `based_on`, "derived
from", Spec ↔ Design ↔ Plan ↔ Task relations exist only when a person or the
model adds them, at any time, or never. No artifact is pending, incomplete or
nagged because a link is missing; no empty state asks for an upstream
artifact. Stale propagation runs only along links that exist; with no links,
nothing stales.

**Gates only when chosen.** Brief, Design and Build approvals apply to a Spec a
person opts into the gated path. A standalone Plan may go straight to Tasks
and execution with no approval.

**Ownership is the one hard rule.** Every artifact belongs to an existing
Laser project — never to a session and never to a person-level store. In a
project session the command uses that project. In a projectless Chat the
command first shows the project picker (current-first, then most recent,
"New project…" last — the same picker as "Move to a project"), creates the
artifact there, and continues in the same chat; the Chat stays projectless and
works on the artifact through the cross-project mention and write rules.
Executing a Task always happens in the owning project's checkout.

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

**The full path is the maximum, not the minimum** (D-352). See
[Flexibility](#flexibility): every artifact kind can be created alone, in any
order, from any chat, with no upstream artifact and no gate. The gates and the
order above bind only when a person chooses to run a Spec through them.

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

The Research body, its sources and adapters, the model-facing tools, the
retrieval loop the agent runs, budgets, entry points (`/research` from any
chat, Research… on a Spec or Design, the Research tab) and the person's
surfaces are fixed in [`research-phase.md`](research-phase.md) (D-351,
standalone per D-352 and [Flexibility](#flexibility)). Note: the loop is run by the
session's own model through single-purpose tools; retrieval is never delegated
to a child agent, confidence is assigned by rule rather than by the model, and
no free-text research document exists — the body is built from cited findings.

## Design contract

Design is usable alone (D-352, [Flexibility](#flexibility)): `/design <text>`
from any session creates a Design with no Spec, no Research and no gate; the
Design gate applies only when a Spec is run through the lifecycle. The Design
lives in the chosen project and discovers that project's design system as
usual.

React is the implementation engine for Laser's embedded design workspace. It
is not the target application's framework and never changes the framework a
project ships.

| Layer | Contract |
| --- | --- |
| Laser workspace and composition canvas | React, tokenized through Laser's visual system |
| Saved `DesignTree` | framework-neutral nodes, token references, variants, states, flows and stable ids |
| Project design system | the project's real tokens, components, assets, themes, constraints and philosophy |
| Native evidence | produced only at Build: an M20 checkpoint preview the person accepts, linked `verified_at` to the Design (D-353) |
| Production implementation | the project's actual framework and repository conventions |

A `DesignSystemManifest` normalizes stack, token sources, themes, typography,
icons, assets, breakpoints, component imports, props, variants, examples,
providers, layouts, accessibility constraints, philosophy and provenance. It is
a derived index: existing project code remains authoritative. Each field is
labelled `declared`, `observed`, `inferred` or `proposed` and cites its source.
Conflicts and gaps remain visible.

Discovery is parse-only — **the Design phase never runs the project**
(D-353): no dev server, no preview runner, no browser, no serve-time tagging.
The operational contract — the two-layer Design Index (static facts, then
Smart-profile synthesis), its review, storage in `.laser/design/`, re-index,
Foundation mode, design in context with a static host capture, and the
Conform/Island strategies — is fixed in [`design-phase.md`](design-phase.md).
In brief:

- parse manifests, lockfiles, design documents, CSS variables, DTCG data,
  Tailwind themes, typed token objects, stories and docs as text, without
  importing or evaluating project config;
- inspect exports, prop types, registries, consuming screens, routes and
  templates statically;
- preserve original token and component identities instead of translating the
  project into a generic house design system;
- cache by source digest and mark every dependent Design stale when an
  authoritative source it links to changes materially.

The workspace has one renderer, **Composition**: the React canvas renders
`DesignTree` through the reviewed index. In context, the new subtree is shown
in place on a static host outline or over a person-supplied reference image.

Every design node records one fidelity label: **Mapped** (composed from
reviewed index entries or parsed from real templates) or **Proposed** (new
foundation, component, token or a supplied image). **Native** exists only as
Build evidence — an accepted M20 checkpoint preview linked `verified_at` to the
Design revision. A screen shows the conservative aggregate and can reveal the
per-node labels. Mapped is never presented as Native, and the Design gate
cannot require Native.

A Design revision contains foundation decisions, Design Profile digest, flows,
screens, applicable themes, viewports, interaction states, fixtures, component
nodes, token references, assets and, for a design in context, the host page
outline, insertion region and Conform/Island strategy. Loading, empty,
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

A Plan is usable alone (D-352, [Flexibility](#flexibility)): `/plan <text>`
records the text as the Plan's own brief, produces the Plan and its Tasks, and
requires no Spec, Design or Research. Links to those are added only if wanted.
Tasks under a standalone Plan execute exactly like any other.

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
- attempts, checkpoints, diffs, commits, repository links, reviews, comments and
  final evidence as linked records.

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

An execution session, agent run or consultation runs on a **Model Profile**
([`model-profiles.md`](model-profiles.md)): the session's profile for
execution, `oracleProfileId` for fresh-context consultation, `namingProfileId`
for titles. The attempt records the profile as intent and the model that
answered as evidence; a Task never names a raw model.

The implementation context packet contains exact approved revisions, unresolved
comments, Task dependencies, acceptance criteria, project instructions and the
last attempt's evidence. It is bounded, provenance-labelled and refreshed at
model-call boundaries. The agent receives tools to inspect project work, create
revisions, request review and report Task evidence; those tools call a
worker-supplied bridge and never persist through Pi.

Each implementation attempt records its session/run identity, workspace shape,
checkout, base commit, M20 checkpoints, changed repositories and terminal
outcome. Checkpoints and git determine changed files; tool calls never do. The
attempt's approved input revisions receive `implemented_by` links only for the
exact repository changes accepted as delivery; verification adds `verified_at`
links to the exact tested states. Commit, push and pull-request actions retain
M20's explicit previews and confirmations.

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
`write_project_artifact`, `request_project_review`, `report_project_task` and,
with M25, `export_project_work`. Every one follows
[`agent-tool-contract.md`](agent-tool-contract.md). Tool descriptions state
the current project and revision rules. They are
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

Laser-owned slash commands `/spec`, `/research`, `/design` and `/plan` create
or open the corresponding workspace destination; they do not become engine
commands. All four work from a projectless Chat: the command opens the project
picker first, then continues in the same chat ([Flexibility](#flexibility),
D-352). Command-palette and pointer
paths perform the same action.

AI-assisted authoring is always session-backed and visible. **Draft with agent**
or **Revise with agent** targets the current eligible session, another chosen
session or a new top-level session in the owning project. That session's model
uses the project-work tools; Laser does not run a hidden second model, disguise
an agent run as a design operation or make the resulting entity session-owned.

## Security, privacy and resource rules

- Design discovery parses source without executing project configuration or
  code; the Design phase starts no server, build or browser (D-353). Project
  builds and previews happen only at Build through M20 checkpoints, under the
  source-control leap's trust and sandbox rules.
- Project output is untrusted text/data. No raw HTML, JSX, script, CSS or SVG
  reaches the Laser renderer; URLs, assets and component props are validated.
- The React composition engine is a lazy chunk; index builds are bounded fleet
  Commands the person can stop. Closing the workspace leaves no hidden
  permanent fleet work.
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
stable ids, revision digests, relations, repository links and attachment
references. Publishing an export into a repository adds `published_as` only
after the exact committed or checkpoint state is known. Re-export is an explicit
replace or new-revision decision.

Optional Figma, Penpot, Storybook or registry connectors are project sources,
not required infrastructure and not authorities over Laser approvals. Offline
and self-hosted paths remain complete. Every imported component, asset or code
candidate retains licence and source provenance.

## Companion contracts

The leap is one change made of several contracts. This document is the root;
each companion below is binding for its area and is read through this index.
A companion that is not yet written is listed so the dependency is visible,
with the decisions already taken.

| Contract | Document | Status | What the leap takes from it |
| --- | --- | --- | --- |
| Model Profiles | [`model-profiles.md`](model-profiles.md) | binding (M22, D-346) | one model-routing concept: person-named ordered lists, unlimited count, seeded Smart/Balanced/Fast; sessions, agents, naming and consultation choose a profile by stable id; `chainKey` → `profileId`; the breaking-change inventory across protocol, worker, host, UI, CLI, persistence and docs; M22 ships before anything below |
| Repository provenance | this document, [Repository provenance](#repository-provenance) | binding (D-345) | `RepositoryLink`, stable repository identity, `based_on` / `implemented_by` / `verified_at` / `published_as` |
| Plain Chat and built-in agent removal | [`plain-chat.md`](plain-chat.md) | binding (M23, D-347) | Beam, Chat and Namer stop being `AgentDefinition`s; Chat is a `sessionKind: "chat"` session on `defaultProfileId` whose whole instruction template is `{{availableTools}}`, `{{toolGuidelines}}`, `{{availableSkills}}`; naming is a one-shot request on `namingProfileId`; Beam and its spark are removed |
| Ask Oracle | [`ask-oracle.md`](ask-oracle.md) | binding (M24, D-348) | `ask_oracle` is a one-shot, tool-less consultation on `oracleProfileId` with the caller's agent instructions and trust policy, explicit bounded `text`/`work`/`repo` context only, no history, no session, no fleet row, no model switch; usage and logs attribute it as a consultation |
| External work links (Jira) | [`external-work-links.md`](external-work-links.md) | binding (M25, D-349) | `ExternalWorkLink` records the exact revision exported to a Jira issue; creation, update and transition are explicit and previewed, never automatic sync; Jira never approves, completes or mutates Laser work; issue property carries Laser identity, remote link points back; least-privilege OAuth in the keychain, host-only calls |
| Design | [`design-phase.md`](design-phase.md) | binding (M21-T10–T14 as amended, D-353) | Design never runs the project; two-layer Design Index (static facts, Smart synthesis) reviewed by the person and stored in `.laser/design/`; eras with `useForNewWork`; Foundation mode for greenfield; design in context with static host grounding, insertion region and explicit Conform/Island strategy; fidelity `Mapped`/`Proposed` only, `Native` is Build evidence |
| Research | [`research-phase.md`](research-phase.md) | binding (M21-T7, M21-T26, D-351, D-352) | standalone `/research` from any chat, no Spec required, project picker when projectless; Research body as a question tree resolved by cited findings; `SourceRef` with digest, licence and trust; confidence assigned by rule (`declared`/`observed`/`inferred`/`proposed`); one adapter per source kind (`web`, `project`, `repository`, `package`, `document`, then `scholarly`, `tracker`), no undocumented endpoints; `search_sources`/`read_source`/`record_finding`/`resolve_question` under the tool contract; the agent ranks itself and never delegates retrieval; visible budgets; no free-text research document |
| Agent-facing tool contract | [`agent-tool-contract.md`](agent-tool-contract.md) | binding (M26, D-350) | one standard for every Laser-owned tool: intent-named, single-purpose, closed schemas, opaque ids, exact revisions with digests, annotations, reads separated from mutations, `expectedRevisionId` and idempotency keys, previews for external or destructive writes, host-side authorization, summary-by-default with pagination and references, actionable errors; `toolContract()` lint and an evaluation harness across every configured profile |

Every companion is binding through its own document, plan milestone and
decision entry. Order of landing: M22 → M23 → M26 alongside M21-T17 → M24 →
M25; M21 implementation stays gated on the person's M20 acceptance.

## Implementation index

The stable task ids, dependencies and acceptance criteria remain in
[`PLAN.md`](../PLAN.md#M21--the-project-lifecycle-leap). Execution state and
evidence remain in [`STATUS_DETAILED.md`](../STATUS_DETAILED.md#M21--the-project-lifecycle-leap).
