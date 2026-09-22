# M21-T6 follow-up — kind-aware creation and authoring

Status: **Milestone 1 implemented; ready for review**. Milestone 2 remains out
of scope until Milestone 1 review and integration. The binding contracts are [`project-lifecycle-leap.md`](../project-lifecycle-leap.md)
("Flexibility", "Embedded workspace" and "Detail, by kind"), D-352 and D-355,
[`design-phase.md`](../design-phase.md), [`research-phase.md`](../research-phase.md),
and the closed bodies in
`packages/protocol/src/project-work-bodies.ts`.

The reported defect is real: `CreateDialog.tsx` changes one label, but every
kind still gets the same title + textarea form, and `ProjectWorkStore.create()`
turns that textarea into `firstBody(kind, text)`. Useful structure typed during
creation cannot cross `project/work/create`. After opening, Spec and Design have
substantial editors, Research has question actions, and Plan and Task are
mostly readers. The five experiences therefore do not yet answer the same four
developer questions consistently:

1. What is this?
2. Where does it stand?
3. What is actually missing or blocking it?
4. What can I do next?

This plan fixes that without changing the protocol, host authority, slash
commands, optional-link rule, Design index receiver, gates, Commands, evidence,
or proof surfaces.

## Approval conditions recorded for Milestone 1

- The five forms expose concise kind-specific structure immediately; they do
  not hide every difference behind one identical collapsed disclosure. The
  two required values still remain enough to create.
- Markdown source is stored byte-for-byte, including leading and trailing
  whitespace. `trim()` is only an emptiness check; the slash-command
  `firstBody()` path retains its existing trimming behavior.
- Kind switching preserves each draft and the mounted editor state needed for
  selection/undo, with a bounded number of editor views rather than one hidden
  view per possible schema row.
- Only explicit Create writes. Enter in Title is inert, an IME composition
  shortcut is inert, every other form action is `type="button"`, and a
  synchronous pending/scope fence rejects duplicate and stale completions
  across close, project or store changes.
- Body-first caller fixtures exercise the realistic store/host boundary. Tests
  distinguish exercised keyboard/IME/renderer behavior from visual, RTL and
  assistive-technology checks that remain for the person.
- The approved exact MIT editor pins are `@uiw/react-codemirror@4.25.11` and
  `@codemirror/lang-markdown@6.5.2`. The resolved graph selected, and the
  implementation directly imports, `@codemirror/language@6.12.4`,
  `@codemirror/view@6.43.13`, and `@lezer/highlight@1.2.3`; they are therefore
  exact direct pins too. No other editor framework or textarea overlay is used.

## Non-negotiable boundaries

- Any kind remains independently creatable. No form requires or nags for an
  upstream Spec, Research, Design, Plan, gate, or link (D-352).
- `/spec`, `/research`, `/design`, and `/plan` retain their current one-text
  behavior and project picker. There is still no `/task`.
- `project/work/create` remains the only creation write. The submitted body is
  one of the existing `ProjectWorkBody` variants; no flattened catch-all
  `brief`, protocol field, host method, or second authority is added.
- Optional fields are omitted or empty because the person left them empty, not
  filled with model claims, fake evidence, approval, completeness, references,
  or generated artifacts.
- Design creation never fabricates a screen, tree, sketch record/blob,
  `designIndexRef`, host capture, insertion region, strategy, fixture, asset,
  review state, or Native evidence. Those records exist only after their real
  producer runs.
- Research creation never fabricates findings, sources, confidence, licence,
  provenance, or answers.
- Plan and Task creation never **prefill or infer** schedules, percentages,
  evidence, attempts, dependencies, commands, or assignment. Values the
  person explicitly enters or selects are persisted in their typed fields.
- Existing `GateCard`, `CommentsPanel`, Design canvas/index/foundation
  components, Plan graph, Task start/transition/verification/attempt/evidence/
  checkpoint components, repository proof, archive/delete, import/export, and
  revision switcher are retained and recomposed rather than replaced.
- No Design implementation edit under `packages/ui/src/components/design/*`.
  The sole Milestone 1 exception is the required body-first caller migration in
  `FoundationWizard.tsx`; it changes no Design behavior or receiver seam.
  `use-design-access.ts` remains owned by the index-receiver repair, and
  `packages/ui/test/project-work/workspace.test.tsx` is not edited.
- No browser functional or acceptance tests. The person performs the visual
  and interaction pass after implementation (D-342).

## One visual and interaction grammar

The dialog remains one **Create project work** surface, but not one generic
form.

- The kind picker is a keyboard-navigable tab/radio row with the existing icon,
  kind token and next key. Its active panel carries kind-specific noun, helper
  copy, primary field, validation and optional details.
- Title stays plain text and required. The primary field is the kind's real
  noun: Brief, Question, Experience brief, Plan brief, or Outcome.
- The required pair is enough to create every kind. **Add details** reveals
  optional structured fields for that kind. Collapsing never clears them.
- The dialog uses a scrollable body and persistent action footer. At phone
  width it uses the viewport safely, fields remain at the legibility floor,
  and all targets remain 44px for a coarse pointer. No page-level horizontal
  scroll is introduced.
- Kind changes morph the panel using existing motion tokens; reduced motion
  makes the same state change instant. All color, spacing, type, radius,
  shadow and duration values remain tokens.
- A separate draft, including title, optional-detail expansion and Markdown
  editor state, is retained for each of the five kinds until success or an
  explicit close. Switching kinds never copies or resets another kind's text.
- Submit validates the active kind only, focuses the first invalid control,
  and associates one concise message with that control. The host refusal stays
  visible with every draft untouched. Editing after a refusal clears only a
  now-obsolete field error; it does not silently dismiss the host's recovery
  sentence.
- A synchronous submission guard prevents double clicks and repeated
  Cmd/Ctrl+Enter. While the request is pending, kind changes, fields, closing,
  outside click, Escape and submit are protected; the exact submitted snapshot
  remains on screen. Failure unlocks it. Success closes, selects the returned
  entity and resets all drafts for the next opening.
- Plain Enter remains text/newline behavior. Cmd/Ctrl+Enter is the one optional
  create shortcut; IME composition never submits.

## Exact first-revision fields

Blank optional rows are removed at serialization. Nonblank values are trimmed
only at their edges; Markdown bytes inside the value are otherwise preserved.
IDs are minted when a row is added, not during submit, so validation and retry
send the same body. Existing schema limits are shown before the host has to
refuse them.

### Spec

Required:

- **Title** → entity title.
- **Brief** → `spec.brief`.

Optional **Full spec details**:

| Control | Persisted field |
| --- | --- |
| Brief / Full spec choice | `spec.form` (`brief` by default; choosing Full is explicit) |
| Problem | `spec.problem` |
| Outcomes, ordered rows | `spec.outcomes[]` |
| Non-goals, ordered rows | `spec.nonGoals[]` |
| Requirements: level + text | `spec.requirements[]` with stable `id`, `must | should | may` |
| Acceptance: checkable/by a person + text | `spec.acceptance[]` with stable `id` and `machineVerifiable` |
| Constraints, ordered rows | `spec.constraints[]` |
| Long-form document | `spec.document` |

`gated` stays absent. Choosing Full does not approve it and an incomplete Full
spec may still be created, matching the existing editor; the form names its
empty sections as optional facts, not errors. Brief does not read as an
unfinished Full spec.

### Research

Required:

- **Title** → entity title.
- **Question** → `research.question` and the one root
  `research.questions[]` node (`open`, no findings).

Optional **Frame the research**:

| Control | Persisted field |
| --- | --- |
| In scope, ordered rows | `research.scope.in[]` |
| Out of scope, ordered rows | `research.scope.out[]` |
| Constraints, ordered rows | `research.scope.constraints[]` |
| Follow-up questions, ordered rows | additional root-child `questions[]` nodes, each `open` with no findings |

The initial status is `open`; `findings`, `sources`, `unresolved` are empty and
`options` is absent. The form offers no source, confidence, licence, excerpt or
answer field because only the retrieval loop can produce those truthfully.

### Design

Required:

- **Title** → entity title.
- **Experience brief** → `design.brief`.

Optional **Start a foundation**:

| Control | Persisted field |
| --- | --- |
| Principles, ordered rows | `design.foundation.principles[]` |
| Direction / references in the person's words | `design.foundation.notes` |

Foundation is opt-in and requires at least one nonblank principle before a
`foundation` object is emitted; it is stored with `status: "proposed"`.
Otherwise `foundation` is absent. Both forms start with real empty
`screens`, `flows`, `sketches`, and `fixtures`, and the schema-required
fidelity remains `proposed`; the UI calls the zero-screen state **Not drawn
yet**, not a fidelity achievement.

No "screen name" field is offered: a screen without a real `DesignTree` or
Sketch blob reference would be fake. No route field is offered in this
milestone: the only existing typed destination is a fully parsed `HostPage`,
so storing an ungrounded string there would lie. `/design from <route>` and
the existing `HostContextPanel` remain the honest route path. No Sketch/Tree
choice is offered before either artifact exists.

### Plan

Required:

- **Title** → entity title.
- **Plan brief** → `plan.brief`.

Optional **Structure the plan**:

| Control | Persisted field |
| --- | --- |
| Phases: name + optional summary | `plan.phases[]` with stable id |
| Existing Tasks selected per phase | each phase's `taskKeys[]` |
| "Task waits on" rows between selected Tasks, optional reason | `plan.dependencies[]` (`from` waits on `to`) |
| Boundaries: scope + rule | `plan.boundaries[]` |
| Risks: severity + summary + control | `plan.risks[]` |
| Verification checks, ordered rows | `plan.verification[]` |
| Long-form document | `plan.document` |

Tasks are chosen only from real Task rows already read for this project. A
phase may exist before it has Tasks. Dependency controls appear only when the
Plan names enough Tasks, reject self/cyclic/out-of-plan edges with the protocol
`validatePlanGraph` result, and still rely on the host as authority. Migrations,
rollback and task creation remain detail work; the dialog does not perform a
multi-entity transaction or imply that a standalone Plan needs Tasks now.

### Project Task

Required:

- **Title** → entity title.
- **Outcome** → `task.outcome`.

Optional **Define the work**:

| Control | Persisted field |
| --- | --- |
| Non-goals, ordered rows | `task.nonGoals[]` |
| Existing Task dependencies | `task.dependencies[]` |
| Affected area rows classified as package, repository or path | corresponding `task.scope.{packages,repositories,paths}[]` |
| Acceptance: checkable/by a person + text + optional command | `task.acceptance[]` with stable id |
| Verification commands | `task.verificationCommands[]` |
| Visual evidence required | `task.visualEvidenceRequired` |
| Owner: nobody, you, or one real agent definition | `task.assignment` |
| Optional existing Plan | `task.planKey` |
| Notes | `task.notes` |

`scope.capabilities` and `scope.sharedWith` start empty; capabilities need a
real declared vocabulary and shared-checkout acceptance is a later explicit
person action. Plan and dependencies default to none and never appear as
missing prerequisites. No attempt, evidence or state transition is created.

## Typed store seam

`CreateWorkInput` becomes body-first instead of text-first:

```ts
type CreateWorkInput = {
  title: string;
  body: ProjectWorkBody;
  sessionId?: string;
  actorLabel?: string;
};
```

`ProjectWorkStore.create()` takes `kind` from `input.body.kind` and forwards the
body unchanged to existing `project/work/create`. A mismatched duplicate
`kind` cannot be expressed. `firstBody(kind, text)` remains the minimal body
builder used by slash commands; `startProjectWork()` changes only its internal
call to `store.create({ title, body: firstBody(kind, text), … })`. Command
behavior and tests stay byte-for-byte equivalent at the wire.

A pure `create-draft.ts` owns draft constructors, stable row IDs, cleanup,
per-kind validation and `ProjectWorkBody` serialization. React does not build
wire objects inline, and the store does not reinterpret a rich body.

## Markdown authoring decision — approval required

### What exists

- `MarkdownDocument` is already the one safe read/preview renderer. It uses the
  transcript's `MarkdownText`, GFM, math and fenced-code handling, does not use
  `rehype-raw`, and lazily highlights settled fences with Shiki.
- `bodies/fields.tsx` `Prose` is currently plain `white-space: pre-wrap`, so
  brief/problem/outcome/answer prose does not render Markdown.
- `bodies/editor-fields.tsx` `MarkdownField` toggles a plain `<Textarea>` and a
  preview. `SpecDocument` initializes it in source mode.
- Shiki and `react-shiki` are read-only renderers. The existing
  `InstructionTemplateEditor` also edits in a plain textarea and shows
  highlighting only in a separate read-only mode. Neither is a safe basis for
  editable syntax color.

A transparent textarea over a highlighted `<pre>` is explicitly rejected: its
caret, proportional wrapping, scroll synchronization, IME composition,
selection, RTL and accessibility failure modes are too brittle.

### Proposed component

Approve two exact-pinned MIT dependencies:

- `@uiw/react-codemirror@4.25.11`
- `@codemirror/lang-markdown@6.5.2`

They provide CodeMirror 6's established editable surface, Markdown parser,
selection/IME behavior, line virtualization and React lifecycle. The
implementation adds a lazy `MarkdownSourceEditor` chunk and a
`MarkdownAuthoringField` wrapper:

- **Write** keeps one mounted CodeMirror editor with token-mapped syntax colors,
  line wrapping, `aria-label`, described validation and no `indentWithTab`
  keyboard trap.
- **Preview** renders the current unsaved string through `MarkdownDocument`.
  Switching changes no draft and performs no request. The editor remains
  mounted but hidden from layout and accessibility, preserving selection,
  undo history and scroll; returning to Write requests a measure, restores
  focus and the exact selection.
- At rest, opened entities render only `MarkdownDocument`; editing is entered
  explicitly. Entering edit starts in Write. Cancel drops the local draft and
  returns to the saved rendered view. Save sends the exact current draft as a
  new revision. Neither switching mode nor leaving focus saves, submits,
  requests review or approves.
- CodeMirror's theme is built entirely from Laser CSS variables and type/
  spacing/radius tokens; both themes, high contrast, RTL text, coarse pointer
  and reduced motion keep the same behavior. Syntax color is supplemental;
  punctuation and source remain readable without it.
- Source is bounded by the owning protocol field (`500`, `2,000`, `4,000`,
  or `PROJECT_WORK_MARKDOWN_MAX` as applicable). The editor is loaded only when
  a Markdown field is edited. CodeMirror virtualizes long source; preview uses
  the already-deferred Markdown pipeline. No full-document Shiki tokenization
  runs on every keystroke. Repeated prose rows mount a CodeMirror view only for
  the row actively being edited; inactive rows use the safe rendered view, so
  a schema-limit fixture does not create hundreds of editor instances.
- Composition events never trigger Cmd/Ctrl+Enter. Tab leaves the editor;
  normal Markdown typing, browser undo/redo, selection and assistive editing
  remain CodeMirror's. Write/Preview is a labelled tab pair with one active
  panel; the inactive panel is not exposed to a screen reader.

If the dependency is not approved, implementation stops for a smaller decision;
it does **not** silently substitute an overlay or call the plain textarea
"highlighted".

### Which values are Markdown

Markdown applies to authored prose, not every string:

| Kind | Markdown-capable prose |
| --- | --- |
| Spec | brief, problem, requirement and acceptance prose, long-form document |
| Research | root/follow-up question, authored answer, option summary/reason and "what would settle it"; never source title, claim, path or verbatim excerpt |
| Design | brief and foundation notes; DesignTree node text remains validated escaped text |
| Plan | brief, phase summaries, boundary rules, migration notes, risk controls, rollback and document |
| Task | outcome, acceptance prose and notes |

Titles, keys, short list labels (outcomes, non-goals, constraints, principles,
risk summaries), tags, source claims/excerpts, commands, paths,
repository/package names, agent names and digests remain plain controls/text.
The distinction follows the schema's prose/Markdown values rather than making
every string executable-looking source. `Prose` and the specific structured
paragraph rows are changed to the safe `MarkdownDocument` pipeline for saved
authored prose; literal/untrusted source fields continue using direct text
nodes.

## Opened detail: kind-specific hierarchy

The shared `WorkDetail` header continues to own key, type, title, entity state,
revision switcher, historical/stale notices, copy/archive/delete and the exact
revision fence. Each kind then owns an orientation strip and body hierarchy.
The strip carries only facts the loaded detail proves; it never computes a
score or percentage.

### Spec — outcome → requirements → acceptance → review

- Read mode opens rendered. The first screen shows Brief/Full, the brief,
  actual counts for outcomes/requirements/acceptance, and the entity/gate state
  already returned by the host.
- The document order is Brief, Problem, Outcomes, Requirements, Acceptance,
  Non-goals, Constraints, Document. Empty sections are absent in read mode.
- A Brief says it is deliberately complete as a brief. Only a Full spec uses
  `fullSpecGaps`, as neutral "Not written yet" facts with **Edit spec**.
- Existing Edit enters one cohesive draft, now using the highlighted
  Write/Preview field for Markdown prose. Save, conflict comparison, keep-mine
  flow, historical read-only rule and sticky narrow footer stay intact.
- Review/approval remains `GateCard` in the inspector; no count or local
  heuristic implies approval.

### Research — question tree → findings → provenance → unresolved

- The root question and derived Research status lead. The selectable question
  tree and selected question's answer/findings are the dominant split; scope
  follows the root instead of separating the tree from its purpose.
- The orientation strip reports real question states, source/finding counts,
  unresolved count and whether a question is handed to the person. It does not
  show percent complete.
- **Edit framing** revises the root question and scope while preserving every
  finding/source/options record. Changing the root updates its stable root
  node rather than creating a second root. Add/resolve/reopen/hand-off actions
  remain the existing fenced revision writes.
- Findings stay read-only, confidence stays rule-assigned, excerpts stay
  literal text with `[from …]`, and Open/Quote keep their existing adapters.
- Empty findings offer one real next action: **Continue in the conversation**
  places a visible request referencing the exact `RES-n` into the already
  mounted composer; it does not start a hidden run or create another Research.
  Add question remains available separately.

### Design — screens/flows dominant, with state and review context

- The existing `DesignDetail` remains the orchestrator and continues calling
  `useDesignAccess`; no Design index, grounding, canvas, prototype, foundation,
  sketch sandbox or review component is replaced. **Edit brief** opens the
  shared highlighted Write/Preview field over the existing Design draft and
  saves through the same fenced `save()` path as canvas changes.
- When screens exist, Screens is the default and the canvas stays dominant;
  the orientation strip names **Not drawn yet** or the real aggregate fidelity,
  host route/strategy when present, screen/flow/sketch counts, unresolved pins,
  validation issues and unsaved state.
- Screen state coverage and selected screen/node/index provenance stay in the
  existing inspectors. Flows and Review tabs expose their actual counts and
  lead to the existing `FlowsPanel` and `ReviewPanel`.
- The empty state offers only real paths: build/review the index through
  `DesignIndexPanel`, start a genuine foundation through `FoundationStart`,
  ground a route already supplied through `HostContextPanel`, or place a
  visible "compose screens for @DES-n" request in the conversation. It never
  creates an empty screen or Sketch record.
- Sketch-only gate refusal, Ground it, Implement, Prototype, full screen,
  conflict preservation and phone read-only canvas remain unchanged.

### Plan — phases → DAG → blockers → implementation order

- Document and Dependencies remain two views. The Document view leads with the
  brief and adopted `AgentPlan`; Dependencies keeps the existing `PlanGraph`.
- A factual orientation strip shows phase/task counts, graph validity, orphaned
  Tasks and the host-computed topological order. "Implementation order" is
  that order only; no schedule, cursor, percentage or inferred next Task.
- Actual unmet dependency keys, invalid edges and orphaned Tasks form the
  blocker section. Every key opens the real Task when present.
- **Edit plan** writes one fenced body revision: brief, phases and task
  membership, dependencies, boundaries, migrations, risks, verification,
  rollback and document. Existing Tasks are selected by key; client validation
  uses `validatePlanGraph`, names cycles/unknown keys, and the host remains the
  authority. Save errors and conflicts keep the whole draft.
- A Plan without Tasks or links stays valid and says "Brief only" with Edit;
  it is not described as blocked.

### Task — outcome → scope/readiness → attempts → verification/evidence

- The existing Start, assignment, transition, cancellation, stale/blocker,
  shared-checkout, verification, attempts, evidence and checkpoint behaviors
  remain their current components and host calls.
- The orientation strip names the actual Task state, assignment, Plan only when
  one exists, unmet dependencies, declared scope and whether acceptance
  evidence exists. It never converts attempt outcome into Task completion.
- Body order becomes Outcome, Readiness/blockers, Scope/non-goals,
  Acceptance/verification requirements, then live Verification, Attempts,
  Evidence, Checkpoints and Notes.
- **Edit task** writes one fenced revision over outcome, non-goals,
  dependencies, scope, acceptance/commands, verification commands, visual
  evidence requirement, assignment, optional Plan and notes. It does not edit
  attempts/evidence/checkpoints or accept shared-checkout risk.
- No acceptance criteria is an honest "person judgement required" state, not a
  fake failure. Start remains the next action only when existing readiness and
  capability permit it; host refusal remains visible and moves nothing.

## Inspector and width behavior

- The inspector is decision-first: gate/readiness, blocking comments, links,
  evidence/history, then record metadata. `SpecSheet` is retained but no longer
  displaces the action a developer opened the item to take.
- Wide desktop keeps backlog + detail + inspector. Constrained desktop uses the
  existing inspector sheet. Narrow/phone gains the same **Details and review**
  sheet from the detail header, so gates, comments, links and Task dependency
  cards are not desktop-only. It mounts the existing `Inspector`, not a second
  implementation.
- On narrow widths, reading is a forward/back route and edit Save/Cancel stays
  in a sticky safe-area footer. Long tables/graphs/canvas own their horizontal
  scroll; the page does not. Design remains read-only on phone as contracted.
- Empty states name the missing real content and offer an enabled existing
  action. They do not present decorative metrics, disabled theatre, a missing
  optional link, or inferred approval as progress.

## Sequential implementation milestones

The same owner completes these in order. Milestone 2 does not start until
Milestone 1 is reviewed; this is not one unbounded rewrite.

### Milestone 1 — typed kind-aware creation

Outcome: all five forms persist their actual optional fields in the first
revision, with minimal creation still fast and slash commands unchanged.

Write paths:

- `packages/ui/package.json`, `pnpm-lock.yaml` — only after approval of the two
  exact editor dependencies.
- `packages/ui/src/components/project-work/{MarkdownAuthoringField,MarkdownSourceEditor}.tsx` — lazy highlighted Write/Preview control.
- `packages/ui/src/project-work/create-draft.ts` — five drafts, cleanup,
  validation and body serialization.
- `packages/ui/src/components/project-work/CreateDialog.tsx` — layout,
  per-kind panels/drafts, errors and pending guard.
- `packages/ui/src/components/project-work/create-work.tsx` — internal body-first
  store call only; command behavior unchanged.
- `packages/ui/src/project-work/store.ts` — `CreateWorkInput` and `create()`
  only; `firstBody` retained.
- `packages/ui/src/project-work/{index,vocabulary}.ts` — necessary exports and
  kind copy only.
- `packages/ui/src/components/design/FoundationWizard.tsx` — focused caller
  migration from create-then-revise to one typed first revision; no receiver
  or Design workflow change.
- New/focused tests under `packages/ui/test/project-work/` and
  `packages/ui/test/elements/`; existing lifecycle command tests remain the
  slash-command regression.

Acceptance evidence:

1. One unit case per kind captures the actual `project/work/create` params and
   proves every nonblank optional control lands in its typed field.
2. Minimal submit still emits the existing honest empty body for every kind.
3. Design tests prove zero fake screens/sketches/refs/host context/evidence;
   Research proves zero fake findings/sources; Task proves zero attempts/
   evidence.
4. Switching through all kinds preserves each title, prose, rows, disclosure,
   Write/Preview mode and visited-editor selection.
5. Preview renders the unsaved draft and causes zero requests; returning to
   Write restores selection; Cancel causes zero writes; Create sends the exact
   Markdown bytes once.
6. Validation focuses the first invalid field and names plan cycles/invalid
   rows. A host refusal retains every field. Pending state sends one request
   despite repeated clicks/shortcuts and cannot be dismissed mid-write.
7. `/spec`, `/research`, `/design`, `/plan`, projectless picker and no `/task`
   tests remain unchanged in observable behavior.

### Milestone 2 — cohesive opened authoring

Outcome: opening any kind gives the hierarchy above, rendered Markdown by
default, explicit edit/preview/save, real missing/blocking facts and a reachable
next action at wide and narrow widths.

Write paths:

- `packages/ui/src/components/project-work/{WorkDetail,Inspector,Workspace}.tsx`
  — orientation handoff, decision-first inspector and narrow inspector sheet.
- `packages/ui/src/components/project-work/bodies/{fields,editor-fields,index,SpecDocument,ResearchDetail,DesignDetail}.tsx`
  — safe Markdown reading, reusable writing, and kind hierarchy.
- `packages/ui/src/components/project-work/{PlanDetail,TaskDetail}.tsx` — factual
  summaries and full body editors while retaining graph/workflow/proof pieces.
- Small new helpers/components under `packages/ui/src/project-work/` and
  `packages/ui/src/components/project-work/` for Plan/Task draft cleanup,
  shared orientation chrome and field rows; no giant config-driven form
  renderer.
- Focused tests in new or existing
  `packages/ui/test/project-work/{spec-editor,research-detail,plan-detail,task-detail}*`,
  `packages/ui/test/design/detail.test.tsx`, and a new narrow-detail test. Do
  not modify `workspace.test.tsx`.

Acceptance evidence:

1. Each kind's rendered test answers what it is, current factual state,
   missing/blocking facts and one real next action from a complete, partial and
   minimal body.
2. Saved authored prose uses `MarkdownDocument`; raw HTML/script is never an
   element; source excerpts, paths and commands remain literal.
3. For every kind, enter its prose edit → change source → Preview shows the
   unsaved change → toggle back preserves exact source/selection → Cancel
   performs no write; Save/Create performs exactly one write with the exact
   bytes and current revision fence where applicable.
4. Research framing edits preserve findings/sources and stable question ids;
   findings/confidence remain non-editable. Existing resolve/add/quote/open
   behavior stays green.
5. Design canvas/index/host/foundation/sketch/prototype/review tests stay green;
   the empty state invokes only real existing actions and never appends an
   empty artifact. No import or edit of `components/design/*`.
6. Plan edit validation names self/cycle/out-of-plan errors and renders the
   host's real topological order/blockers. No schedule/progress is inferred.
7. Task body edits preserve attempts/evidence/repository links; Start,
   transitions, acceptance evidence, stale and overlap refusals behave exactly
   as before.
8. Historical/archived/capability-limited revisions remain rendered and
   read-only. A conflict or failed save preserves the unsaved draft.
9. The same inspector actions are keyboard/touch reachable in the wide column
   and narrow sheet; sticky Save/Cancel remains reachable above the safe area.
10. Editor tests cover keyboard-only Write/Preview, screen-reader labels,
    Tab escape, Cmd/Ctrl+Enter outside IME composition, mixed RTL/LTR source,
    200 KiB source behavior, reduced motion and both theme token mappings.

## Validation gates after each milestone

```bash
pnpm -F @lasercode/ui exec vitest run test/project-work test/design-system
pnpm -F @lasercode/ui test:types
pnpm -F @lasercode/ui typecheck
pnpm identity:check
```

Milestone 2 also runs the focused Design detail suite because
`DesignDetail.tsx` changes, but no browser acceptance suite. After code is
ready, the person runs `pnpm -r build && pnpm sandbox` and checks the visual
matrix: all five creation forms, create → opened detail, light/dark, wide/
phone, keyboard/touch, RTL, reduced motion, unsaved Preview/Cancel, host error
preservation and pending dismissal protection.

## Approval decisions needed before implementation

1. Approve the body-first `CreateWorkInput` seam and the exact per-kind fields
   above without a protocol/host change.
2. Approve `@uiw/react-codemirror@4.25.11` and
   `@codemirror/lang-markdown@6.5.2` (MIT, exact direct pins) for editable
   Markdown syntax highlighting.
3. Approve the two sequential milestones and the expanded detail-file
   ownership, including the narrow `Workspace.tsx` inspector affordance, while
   keeping `components/design/*`, `use-design-access.ts` and
   `workspace.test.tsx` outside this owner.
