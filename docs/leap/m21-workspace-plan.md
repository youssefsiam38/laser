# M21 workspace — the client store and the embedded workspace (T5 → T6)

Working notes and checkpoints for the person-facing half of the project
lifecycle leap. The binding contracts are
[`docs/project-lifecycle-leap.md`](../project-lifecycle-leap.md) ("Embedded
workspace", D-355, and "Flexibility", D-352) and the spine's wire shapes in
[`m21-spine-plan.md`](m21-spine-plan.md). This file records what landed, the
decisions taken where the contract is silent, and **exactly** which component
slots M21-T7, T8, T13 and T16 fill in.

Rule used for every open question: **the workspace is a reader and a caller of
the host's authority — it never invents state, and it never holds a second
copy of the truth** (D-331, D-355).

## Task ledger

| Task | State | Evidence |
| --- | --- | --- |
| M21-T5 UI client store, reconcile and deep links | done | `pnpm -F @lasercode/ui test` (`test/project-work/*`) |
| M21-T6 Embedded workspace shell | done | `pnpm -F @lasercode/ui test`, `pnpm -F @lasercode/ui typecheck` |
| M21-T16 Plans and Tasks workspace | done | `pnpm -F @lasercode/ui test` (`test/project-work/{plan-graph,plan-detail,task-detail,board-transitions}*`), `pnpm -F @lasercode/ui typecheck` |
| M21-T8 Comments, reviews and approval gates (UI half) | done | `pnpm -F @lasercode/ui test` (`test/project-work/{comments,gates,approval}*` 24) |

---

## M21-T5 · The client store

### What landed

| File | What it owns |
| --- | --- |
| `packages/ui/src/project-work/store.ts` | `ProjectWorkStore`: one project's cache, the sequence rules, reconcile, and every mutation call |
| `packages/ui/src/project-work/registry.ts` | one store per **stable `projectId`**, the `cwd → projectId` resolution, and the live wiring to a `HostClient` |
| `packages/ui/src/project-work/deep-link.ts` | `#/work/<projectId>/<kind>/<entityId>[/<revisionId>]` and the `laser://work/…` form, parsed, formatted and consumed |
| `packages/ui/src/project-work/model.ts` | pure view models: filtering, sorting, saved views, board columns, attention grouping, kind vocabulary |
| `packages/ui/src/project-work/hooks.ts` | the React bindings (`useProjectWork`, `useProjectWorkCounts`, `useWorkspaceUi`) |
| `packages/ui/test/project-work/*` | the store, the sequence rules, reconnect, deep links, relocation |

### Decisions where the contract is silent

1. **The cache is keyed by `projectId`, never by path.** A directory is only
   ever a *lookup*: `project/work/list { cwd }` answers with the stable id, the
   registry remembers `cwd → projectId`, and a second path that resolves to the
   same id joins the store that already exists. A worktree and its owner, and a
   relocated project and its old path, are therefore one cache with one
   sequence — two projects can never alias, because nothing is ever stored
   under a path.
2. **Sequence order is the only order.** An event with `seq <= known` is
   dropped (a replay, or a second delivery of the same change). An event with
   `seq > known + 1` is a **gap**: the store keeps what it has, marks itself
   `behind` and reconciles with `project/work/list { sinceSeq: known }`. No
   event is ever applied out of order, and a dropped notification degrades to
   one extra read rather than to a wrong list.
3. **Reconnect never empties the screen.** The cache survives a closed socket;
   the reconcile that follows merges `items`, drops `removed[]` and, only when
   the host answers `reset: true`, replaces the cache wholesale. The person
   sees the rows they had, with a "reconnecting" note, not an empty state.
4. **A deep link is resolved, not guessed.** The link carries all four parts of
   an identity (`projectId + kind + entityId + revisionId`); the workspace
   opens on exactly that revision and says so ("Revision 3 of 5 · this is not
   the current revision"). A link whose project is not known to this device is
   an explained refusal, never a silent redirect to something current.
5. **Mutations go through the store**, so the optimistic-concurrency fence
   (`expectedRevisionId`) and the idempotency key are minted in one place and
   a conflict (-32010) or a quota refusal (-32011) is decoded into one typed
   result the surfaces render as a person-readable banner.

---

## M21-T6 · The embedded workspace

### What landed

| File | What it owns |
| --- | --- |
| `packages/ui/src/components/project-work/ProjectWorkControl.tsx` | the top bar's one control, with live counts |
| `packages/ui/src/components/project-work/Workspace.tsx` | the shell surface: header, tabs, "← Back to the conversation", the morph, the inspector sheet |
| `packages/ui/src/components/project-work/WorkBacklog.tsx` | filters, sort, saved views, the adopted `data-table` and the narrow rows |
| `packages/ui/src/components/project-work/WorkDetail.tsx` | the kind-aware detail frame, the revision switcher and the historical/stale banners |
| `packages/ui/src/components/project-work/bodies/*` | every kind's body, read-only and complete, from the protocol's own fields |
| `packages/ui/src/components/project-work/Inspector.tsx` | the kind-aware inspector (gate, links, comments, evidence, history) |
| `packages/ui/src/components/project-work/Board.tsx` | the Tasks board and its real drag transitions |
| `packages/ui/src/components/project-work/NeedsYou.tsx` | the queue, with each row's reason in words |
| `packages/ui/src/components/project-work/Recent.tsx` | revisions newest first, on the adopted `timeline` |
| `packages/ui/src/components/project-work/CreateDialog.tsx` | one dialog, the next key shown before creating |
| `packages/ui/src/components/project-work/KindBadge.tsx` | the type badge, the key tag, the status chip and the needs-you chip |
| `packages/ui/src/components/project-work/ConfirmDialogs.tsx` | Archive and Delete, typed confirmation, Enter confirms neither |
| `packages/ui/src/components/project-work/create-work.tsx` | the four commands' one action, and the projectless Chat's project picker |
| `packages/ui/src/components/project-work/work-commands.ts` | the command list both the composer and the palette use |
| `packages/ui/src/components/project-work/ProjectWorkBridge.tsx` | the registry's one meeting with the connection: notifications, reconnect, environment reset, saved views, deep links |
| `packages/ui/src/project-work/{vocabulary,board,views}.ts` | what each kind and state is called; the board's rules; filters, sorts and saved views |
| `packages/ui/src/components/assistant-ui/elements/todo-list.tsx` | the reinstated catalog element, de-demoed and retoned |

Edits outside those files, all of them entry points: `components/shell/Shell.tsx`
(mounts the workspace, the bridge and the picker, and hides the fleet/monitor
columns while the workspace has their room), `components/shell/TopBar.tsx`
(the control; the two column toggles step aside while the workspace is open),
`components/shell/CommandPalette.tsx` (the destination, the queue, the four
commands and every item by key), `components/thread/Composer.tsx` (the four
slash commands), `theme/{primitives,types,compile}.ts` + `globals.css` +
`components/settings/appearance/TokenEditor.tsx` (the five kind tokens), and
`test/world/fake-host.tsx` (a `project/work/list` the shell tests can read).

### Decisions

1. **The workspace is a main-area destination, not a panel.** It takes the
   main column and hides the fleet and monitor columns while it is open; the
   saved shell preferences are untouched and return the moment it closes. The
   conversation stays mounted underneath (`hidden`, not unmounted), so scroll,
   draft, stream and approvals survive — proven by
   `test/project-work/workspace-keeps-the-conversation.test.tsx`.
2. **The kind is a colour token and an SVG icon, never an emoji.**
   `--kind-spec`, `--kind-research`, `--kind-design`, `--kind-plan` and
   `--kind-task` are derived in `theme/compile.ts` from one categorical ramp
   (as the fleet's agent tints are), can be pinned by any preset, and are
   editable in Settings → Appearance like every other token.
3. **A command's text is the whole input.** `/spec <text>` creates the Spec
   with that text as its brief and opens the workspace on it. With no text the
   same command opens the Create dialog with the kind chosen, because an empty
   artifact with an empty brief is not a thing worth creating.
4. **The board pre-checks every drop with the protocol's own transition
   function** and refuses an illegal one with the missing keys named, before
   any request is sent. The host's refusal is rendered with the same banner:
   the client's check is a courtesy, the authority is the host (M21-T15).
   `hasAcceptanceEvidence` is passed as true in that pre-check *on purpose*: a
   list row does not carry evidence, and refusing a completion this window
   cannot see the evidence for would be inventing a fact. The engine refuses
   it, with the sentence a person should read.
5. **The status chip says what the row can prove.** A list row carries the
   entity's review or task state, so the chip speaks that state in the kind's
   own words (`Awaiting design approval`, `Running`). The vocabularies that
   live in the *body* — Research `open/partial/answered`, Design
   `Sketch/Mapped/Proposed`, a Plan's task counts, a Spec's brief-versus-full
   — are shown in the detail, where the body has been read. Nothing guesses a
   body-level status from a list row.
6. **Keys rank first in the palette.** Typing `TASK-44` into `Cmd+K` finds
   TASK-44: every item in the current project is a palette row above the
   sessions. The global "Search all sessions" dialog is session-shaped and is
   left to M21-T9, which owns cross-project search and mentions.
7. **The backlog has two forms of one list.** With nothing open it has the
   whole room and reads as the adopted table; with something open it is a
   column of rows beside the detail. Same rows, fewer columns — never smaller
   type.

### What T7, T8, T13 and T16 fill in

The detail frame is built from **slots**. Everything below is an existing
component boundary with a real, honest reading state in it today — never a
placeholder card.

| Slot | File | Today | Filled by |
| --- | --- | --- | --- |
| `SpecBodyView` | `components/project-work/bodies/index.tsx` | the real body read-only: form, brief, problem, outcomes, non-goals, requirements with levels, acceptance with the machine-verifiable mark, constraints, and the Markdown document through the shared renderer | **M21-T7** adds editing, the brief→full revision flow and the Jira chip |
| `ResearchBodyView` | `components/project-work/bodies/index.tsx` | the real body read-only: question, scope, status, the question tree with each node's state and answer, findings with confidence/licence/trust/excerpt/provenance, options, unresolved facts, sources | **M21-T7** adds the two-column tree ↔ source panel, Quote, Open source and the retrieval budget bar (`docs/research-phase.md`) |
| `DesignBodyView` | `components/project-work/bodies/index.tsx` | the real body read-only: brief, aggregate fidelity, foundation principles, screens with their fidelity and interaction states, flows, sketches (identity and bounds only — never the bytes), host page and strategy | **M21-T13** replaces the body with the canvas and the Design Index inspector; **M21-T14** the greenfield foundation |
| `PlanBodyView` | `components/project-work/bodies/index.tsx` | the real body read-only: brief, phases with their task keys, dependencies as key pairs, boundaries, migrations, risks, verification, rollback, and the Markdown document | **M21-T16** adds the Document/Dependencies switch and the real graph |
| `TaskBodyView` | `components/project-work/bodies/index.tsx` | the real body read-only: outcome, non-goals, dependencies as key cards, scope, acceptance with commands, verification commands, visual-evidence requirement, assignment, plan key, notes | **M21-T16** adds attempts, evidence, checkpoints and Start… |
| `InspectorGateCard` | `components/project-work/Inspector.tsx` | the gate's own facts: which gate, its approvals so far, and why it cannot be approved now (blocking comments, stale inputs) | **M21-T8** adds Approve / Request changes and the digest-bound approval |
| `InspectorComments` | `components/project-work/Inspector.tsx` | every comment on the entity, its anchor, its state and who wrote it | **M21-T8** adds writing, anchoring, addressed/resolved and the blocking rules |

Deferred on purpose, and recorded here rather than implied:

- **Creating and revising bodies beyond the create dialog's first revision.**
  The dialog writes the first revision of each kind from one field (title,
  question or brief) — which is exactly what `/spec`, `/research`, `/design`
  and `/plan` are defined to do (D-352). Rich editing is T7 (Spec, Research)
  and T16 (Plan, Task); the Design canvas is T13.
- **Comments, approvals and gates as *actions*.** M21-T8 owns every write;
  T6 shows their current state and says who may act.
- **Mentions (`@SPEC-12`) in the composer**, the transcript's compact artifact
  card, and the sessions sidebar's `TASK-n` chip. M21-T9 owns the mention
  adapter and the transcript surfaces; T6 ships the pieces each of them draws
  — `TypeBadge`, `KeyTag`, `StatusChip`, `WorkIdentity`
  (`components/project-work/KindBadge.tsx`) — so none of them is rebuilt.
- **"Link something…"**, the act. The inspector shows every link an entity
  has, in both directions, and says plainly that links are optional; adding
  and removing one is a write over `project/work/link` / `unlink` and belongs
  with the surfaces that have something to link — M21-T7 (Spec ↔ Research ↔
  Design) and M21-T16 (Plan ↔ Task). The slot is the inspector's `Links`
  section.
- **The global "Search all sessions" dialog.** Keys are searchable in the
  palette and in the backlog today. M21-T9 owns `project/work/search` in the
  cross-project surfaces.
- **The Design canvas, the Design Index panel and Prototype mode.** M21-T13;
  the Design body reads its real fields today and names the sketches it has
  without ever rendering their bytes.
- **Model tools and execution linking.** M21-T17.

---

## M21-T7 · Specs and Research

The two slots the T6 table left open, filled exactly: `SpecBodyView` gains
editing, the brief → full revision flow and its conflict banner;
`ResearchBodyView` is replaced in the detail by the tree ↔ findings pair.
"Link something…", deferred by T6 to whichever surface had something to link,
lands here as the inspector's own act.
## M21-T16 · Plans and Tasks

### What landed

| File | What it owns |
| --- | --- |
| `packages/ui/src/project-work/spec.ts` | the Spec draft: brief ↔ full, what a *full* spec is missing, and one body rendered as stable text for the difference |
| `packages/ui/src/project-work/research.ts` | the question tree in reading order, a question's findings, the cited span, where a source opens, `[from …]`, the quote's Markdown, and the three writes a person may make |
| `packages/ui/src/project-work/search.ts` | `project/work/search` merged into the backlog's filter, exact key first |
| `packages/ui/src/project-work/store.ts` | `revise`, `link` and `unlink` beside the reads (the fence and the idempotency key stay minted in one place) |
| `packages/ui/src/components/project-work/bodies/SpecDocument.tsx` | the Spec: reading form, editor, revision, conflict banner, difference dialog |
| `packages/ui/src/components/project-work/bodies/ResearchDetail.tsx` | the compact bar, the tree, the findings panel, the option matrix, the unresolved list, the person-side resolutions |
| `packages/ui/src/components/project-work/bodies/editor-fields.tsx` | the writing half of a body's fields, including Markdown source/preview |
| `packages/ui/src/components/project-work/bodies/context.ts` | what a body needs to write: the store, the exact revision, whether it may be edited and why not |
| `packages/ui/src/components/project-work/LinkDialog.tsx` | "Link something…": relation, target by key, one edge between two exact revisions |
| `packages/ui/src/components/project-work/quote.ts` | Quote as an event the composer listens for, so the workspace never reaches into the conversation's runtime |
| `packages/ui/src/components/assistant-ui/elements/research-report.tsx` | the adopted catalog element, retoned, as the selectable question outline |
| `packages/ui/test/project-work/{spec-research-model,spec-editor,research-detail,links}.test.*` | the rules, the revise round trip and its conflict, the tree/findings/source panel, link and unlink |

Edited: `bodies/index.tsx` (routes Spec and Research through the two new
components when a context exists, keeps the reading forms), `WorkDetail.tsx`
(builds that context; `editable` is decided once, from the revision, the
archive state and `project/work/revise`), `Inspector.tsx` (Link something… and
unlink), `WorkBacklog.tsx` (the filter also searches bodies),
`thread/Composer.tsx` (takes a quote into the draft it already holds),
`components/project-work/index.ts` (the quote seam).

### Decisions

1. **A save is a child revision, never a replacement.** `project/work/revise`
   is fenced by the revision the person was *reading*. A refused write keeps
   every word on screen, shows the difference between the two real revisions
   (the adopted `code-diff` over `specBodyText`) and offers "keep mine as a
   new revision", which writes fenced by what the host says is current. There
   is no path in the file that overwrites bytes nobody saw.
2. **Brief and full are two documents, not one with gaps.** A brief asks for
   its brief and nothing else; the full form names what a full spec records
   (problem, outcomes, requirements, acceptance) as a description beside the
   fields, and still saves without them.
3. **Findings are read-only here, and it is said out loud.** They are written
   by the research loop's tools (`record_finding`, M21-T17/T26) and a
   correction is a new finding that contradicts the old one. The empty state
   is "No findings yet — the research loop records them", not a disabled
   "Add finding" button. Confidence is by rule and carries its rule in a
   tooltip; a person may resolve, hand over, reopen or add a question, and
   those go through `project/work/revise` with the whole body.
4. **A highlight is a claim about the source's own words**, so the cited span
   is matched literally — a quoted phrase from the claim, or the longest run
   the two share, pulled back to whole words — and nothing is marked on a
   resemblance.
5. **Only identities the adapter contract fixes become a URL**: an absolute
   URL, a known forge at an exact commit, a registry this app ships an adapter
   for, a DOI through its published resolver. A local path opens through the
   existing file opener, a `SPEC-4`-shaped project source opens that artifact,
   and anything else says there is nothing to open rather than guessing a host.
6. **Quote is an event, not a reach into another surface's runtime.** The
   composer is mounted the whole time the workspace is open (D-355), so the
   Markdown — key, claim, verbatim excerpt, `[from …]` — is appended to the
   draft the person already has rather than replacing it.
7. **The backlog's one filter does both halves of search.** Rows are filtered
   locally by key and title; the same text asks the host to search the bodies
   it projects, and a row that only matched inside a document joins the list
   with "matched inside the document" on it. An exact key outranks everything.
   A search never steps around the other filters and never removes a row the
   person can already see.
8. **Derived status is derived.** A Research revision's `status` is computed
   from its question states before every write; a question handed to a person
   is *not* counted as settled.

### Deferred, with the reason

- **The Jira chip on the Spec header** (named in the T6 slot table). No wire
  shape for an external work link exists yet — nothing in
  `packages/protocol/src/project-work*.ts` carries a tracker key — and drawing
  a chip over data the protocol does not have would be inventing state.
  `docs/external-work-links.md` owns that contract.
- **The global "Search all sessions" dialog**, which the T6 plan assigns to
  M21-T9 with the rest of cross-project search and mentions. `project/work/search`
  now has a real client (`project-work/search.ts`) for T9 to mount there.
- **Approve, Request changes and comments** on the Spec's gate card: M21-T8.
- **The retrieval budget of a *running* research run** in the compact bar. The
  body carries no budget field; the bar shows what the revision can prove —
  sources read, findings kept, questions settled — and says so. The run's own
  `maxSearches`/`maxReads`/`maxBytes` arrive with the loop (M21-T26) and the
  fleet row.
| `packages/ui/src/project-work/plan-graph.ts` | the declared graph's layout: dependency depth, reading order, arrow-key steps, the host's problems and orphans carried through untouched |
| `packages/ui/src/project-work/task-model.ts` | attempts from execution links, evidence matched to them by provenance, checkpoints from repository links, the blocked sentence, the stale-upstream decode, the conflict sentence, assignment options |
| `packages/ui/src/project-work/board.ts` | `dropFor`: what a drop *is*, separated from the gesture (added; `checkDrop` and `actionForDrop` unchanged) |
| `packages/ui/src/components/project-work/PlanDetail.tsx` | the compact bar (`from SPEC-n` / standalone — the prompt was the brief), the Document ↔ Dependencies tabs, phases through `agent-plan` |
| `packages/ui/src/components/project-work/PlanGraph.tsx` | the graph: nodes as buttons with key, type badge and state chip; edges as token-stroked SVG; one tab stop and arrow keys; the host's refusals and orphans in its own words |
| `packages/ui/src/components/project-work/TaskDetail.tsx` | Start…, attempts, evidence, checkpoints, acceptance, the blocked / stale / conflict banners, the assignment control, the move menu |
| `packages/ui/src/components/project-work/TaskStart.tsx` | the chooser that records `project/task/link-execution` against a session **in this project**, and shows the conflicts the host answers with |
| `packages/ui/src/components/project-work/TaskCancel.tsx` | the reason a cancellation needs, asked for before the request |
| `packages/ui/src/components/project-work/TaskInspector.tsx` | dependencies as key cards (state and all), and the Plan a Task belongs to |
| `packages/ui/src/components/project-work/Board.tsx` | finished: the cascade said out loud, the per-card move menu extracted, and the phone's compact `todo-list` form |
| `packages/ui/src/components/assistant-ui/elements/agent-plan.tsx` | reinstalled from the registry and restyled: phases, real `done/total`, no percentage, no cursor |
| `packages/ui/src/components/assistant-ui/elements/todo-list.tsx` | `TodoItem.action` and `header={false}` (two additions, nothing else) |
| `packages/ui/src/components/assistant-ui/elements/checkpoint-history.tsx` | `CheckpointTrail`: the same element's second form, for checkpoints from git |
| `packages/ui/test/project-work/{plan-graph,plan-detail,task-detail,board-transitions}.test.*` | 39 tests over the real components and the pure models |

Edits to files this task does not own, each as small as it could be and listed
so a merge can check them:

- `components/project-work/WorkDetail.tsx` — the detail switch routes `plan` to
  `PlanDetail` and `task` to `TaskDetail`; every other kind still renders
  `WorkBody`.
- `components/project-work/Inspector.tsx` — a Task is read with `body: "full"`
  (its dependencies and its Plan live in the body) and `TaskInspectorSections`
  is rendered for it.
- `project-work/store.ts` — `revise()` and `linkExecution()` added beside
  `taskAction()`, and the `refused` failure carries the host's typed `data`
  (that is how `{ refused: "stale_upstream", upstream }` reaches a banner).

### Decisions where the contract is silent

1. **The graph is Laser's own surface, the phases are the adopted element.**
   D-355 keeps the board, the badges and the graph Laser-owned, and
   `ux-elements.md` claims `agent-plan` for a Plan's phases. So the Document
   view mounts `agent-plan` over real Tasks and the Dependencies view is
   `PlanGraph`: HTML buttons for nodes (so type never shrinks and text never
   clips) over one SVG layer for edges, stroked with `var(--line)` and
   `var(--danger)`. Node geometry is three constants in one place, so the
   edges and the nodes cannot drift apart.
2. **A node this window has not read is still a node.** It says "unread"
   rather than disappearing: a Plan's phase that looks two Tasks short because
   the backlog page ended is a lie about the Plan.
3. **A cycle is survivable.** The host refuses to store one, but a refusal has
   to be *shown* — so the layout detects the loop, stops, marks every node and
   edge it names and draws the rest normally, with the host's sentence above.
4. **What this window can prove, it refuses itself; everything else it sends.**
   The board pre-refuses by the state machine and the row's unmet keys and
   sends a completion (a list row cannot see evidence). The Task detail *has*
   read `readiness`, so it refuses a completion with no acceptance evidence
   itself, with the sentence that says why. Same rule, different knowledge.
5. **Evidence is matched to an attempt by provenance, never by guesswork.** An
   evidence record carries `origin.sessionId`, not an attempt number, so it is
   listed under the attempt whose session it came from and otherwise stands on
   its own. Nothing is assigned to an attempt by time.
6. **Accepting shared-checkout risk is a revision, and only a person's.**
   There is no task action for it (`PROJECT_TASK_ACTIONS` is closed and every
   action maps to a state), so the panel writes `scope.sharedWith` through
   `project/work/revise` — an immutable revision that says who accepted it and
   when. The host refuses an agent's revision that adds one (M21-T15).
7. **Start… does the part that is real.** It records
   `project/task/link-execution` against a session **in this project**,
   because the link exists before any prompt is sent and it moves nothing.
   There is no "new session" or "agent run" button standing there greyed out:
   starting a run, the implementation context packet and the model tools are
   M21-T17, and a button that cannot work is worse than one that is not there
   yet. An attempt whose session this device still has offers **Open the
   conversation**, which is the existing `openSession`.
8. **No Jira chip is drawn.** Nothing in a Task revision carries an external
   issue key today; the external-work link is M25. A chip for a link that does
   not exist would be a promise the data cannot keep.
9. **The Plan keeps the generic inspector.** D-355 says a Plan's inspector is
   "none", meaning it has no *kind-specific* panel — its context is the graph,
   which is in the middle column. The cross-kind links, comments and revision
   history that T6 gives every kind are left alone rather than removed for one
   kind.
10. **A cancellation is asked why, not refused.** The engine refuses a
    `cancel` that says nothing and writes the reason as durable evidence
    (M21-T15), so both the board and the detail open one small dialog first
    and send the note with the action. A control whose every press comes back
    refused is not a control. Enter cancels nothing: the reason is a textarea
    and "Keep it" holds focus.
11. **The phone's board is the same board.** Columns keep their identity,
    their counts and their transitions; only the card becomes a `todo-list`
    row with the same "Move to" menu. Nothing is shown at a smaller size, and
    the columns still scroll sideways with no page scroll.

### What is proven, and what is not

Proven by `pnpm -F @lasercode/ui test`: the drop mapping, the move's exact
method and action, the pre-refusal naming the missing keys with **no request
sent**, the host's `done`-without-evidence refusal rendered, the stale-upstream
banner built from the refusal's `data`, the conflict panel and the
`scope.sharedWith` revision it writes, the execution link (and that it is not a
transition), the assignment revision, the graph's layout, its problems and
orphans from a fixture, the tab roles and the single tab stop.

Not proven by a test, and named rather than claimed: the **pointer drag
itself**. dnd-kit measures real layout rectangles and happy-dom has none, so
what a drag resolves to is proven as `dropFor` and the request it makes is
proven through the same `move` the per-card menu calls — the path a keyboard
and a coarse pointer take. A person dragging a card is the acceptance run
(AGENTS.md, D-342).


---

## M21-T8 · Comments, the gate card and the review request

The host half is in [`m21-spine-plan.md`](m21-spine-plan.md) § M21-T8; this is
what a person sees and touches.
---

## M21-T9 · Cross-session and cross-project mentions

The slot the T6 plan left open ("Mentions (`@SPEC-12`) in the composer, the
transcript's compact artifact card, and the sessions sidebar's `TASK-n` chip"),
plus the global search the T7 notes deferred here, filled exactly. The
contract is `docs/project-lifecycle-leap.md` "Cross-session mentions and
context" and "Outside the workspace"; the behaviour is written up for people
in [`docs/project-mentions.md`](../project-mentions.md) beside the machine-file
mentions it extends.

### What landed

| File | What it owns |
| --- | --- |
| `packages/ui/src/project-work/review.ts` | the pure half: gate and role vocabulary, `focusedGate`, `isDecidable`, `approvalPhrase`, anchor labels, `reviewThreads`, `batchedChanges`/`batchedNote` |
| `packages/ui/src/components/project-work/GateCard.tsx` | the gate card: the three gates as tabs, what each needs, the complete digest set, the outcome picker with the permission mode, the typed confirmation, "Ask for a decision", and the way onto the gated path |
| `packages/ui/src/components/project-work/CommentsPanel.tsx` | threads, the anchor picker built from the body's own targets, the orphaned state, the blocking flag, addressed/resolved/reopen, and the batched revision request with its before/after preview |
| `packages/ui/src/components/project-work/ApprovalRequestCard.tsx` | the lifecycle review request above the composer, on the existing Approval Card |
| `packages/ui/test/project-work/{comments,gates,approval}*.tsx` | 24 tests over the three surfaces, plus `gates-fixture.ts` |

Shared files edited, minimally and additively: `project-work/store.ts` gained
`comment`, `resolveComment`, `review` and `approve` (every mutation's fence and
idempotency key is minted in that one place, which is what the file is for);
`components/project-work/Inspector.tsx` swapped its two T6 placeholders for the
real gate card and comments panel and now reads the body with the detail (an
anchor is named against the revision on screen); `components/thread/Thread.tsx`
mounts `ApprovalRequestCard` in the footer beside `ThreadDialogCards`.

### Decisions where the contract is silent

1. **The gate card is drawn from the host's `gates` report and adds nothing.**
   Every requirement sentence, the covered digest set and the refusal come from
   `project/work/get`. The card decides *layout and vocabulary* only, so a rule
   can never differ between the surface and the authority.
2. **Approve is disabled, visible and explained.** A blocked gate keeps its
   Approve control on screen, disabled, with the host's sentence beside it and
   the blocking comments listed by key and excerpt. Request changes stays
   enabled: a blocked gate is not a dead end.
3. **Two deliberate acts, never one.** Recording an approval needs an outcome
   chosen *and* the subject's key typed into a field that swallows Enter — the
   same shape as Delete's typed confirmation, for the same reason (D-332).
   Changing gate or revision clears both.
4. **A draft is not up for decision.** The spine has no `draft → approved`
   edge, so the card offers "Ask for a decision" (`project/work/review
   request_review`) instead of letting a person press Approve into a refusal.
5. **The transcript card navigates; it never decides.** Its single choice opens
   the workspace at the exact revision, and the autofocused control is "Not
   now". Enter can dismiss; there is no approval here for it to hit.
6. **The anchor picker offers the body's own targets** (`anchorTargets`), so a
   comment is pinned to a requirement, a criterion, a screen, a node, a flow
   edge or a token — never to a coordinate, and never to an id the revision
   does not have.
7. **A batched request is one `return_to_draft` with a note** naming every
   unresolved thread, its anchor, the text as it stands and what was asked.
   Laser asks for the change; it does not write it.

### Deferred, with the reason

- **Pins on the design canvas.** The anchors and their orphaned state are here
  and the canvas is M21-T13's; the panel lists what a canvas will draw pins for.
- **Resolving from the Needs you queue.** The queue still only opens the item:
  a decision needs what it is deciding on screen (D-355).
| `packages/protocol/src/project-work-mentions.ts` | the token grammar both sides read: the human form, the link-reference definition, the spans, `withProjectWorkMentions`, `projectWorkMentionProse`, and the projection/outcome shapes |
| `packages/host/src/project-work/mention-projection.ts` | the bounded projection per kind, the `[from …]` provenance, and the sentence for each way a body can be missing |
| `packages/host/src/router.ts` | `session/prompt` send-time validation: read scope, project, revision, digest; the projection the worker receives; the outcomes the sender is told |
| `packages/ui/src/project-work/mentions.ts` | the query (`@KEY`, `@spec:` …), the ranking, the picker row identity, the pins, the send-time expansion, and the sessions sidebar's session → Task links |
| `packages/ui/src/components/project-work/MentionChip.tsx` | the chip, in a transcript and in the sidebar |
| `packages/ui/src/components/project-work/ArtifactCard.tsx` | the compact card for a message that *is* a reference |
| `packages/ui/test/project-work/mentions*.test.*` | the query, the ranking, the pick, the stored shape vs the visible text, the chip, the card, the sidebar link and the sender's outcomes |
| `packages/host/test/project-work/mentions.test.ts` | validation and projection over the wire, including the search index projection |

Edited, each as small as it could be: `components/thread/project-path.ts` (the
transcript formatter yields work mentions and drops the identity lines),
`components/thread/finished-mentions.ts` (`noteChoice`, and a `work` kind so a
restored draft's `@TASK-44` is the mention it was chosen as rather than a
handle nobody started), `components/thread/composer-mention-tags.tsx` (the
kind's colour token on the tag), `components/thread/Composer.tsx` (the rows,
the insertion and the pin), `components/assistant-ui/elements/directive-text{,.aui}.tsx`
(one `renderMention` seam), `components/assistant-ui/elements/thread-list.aui.tsx`
(the sidebar chip, four lines), `components/shell/GlobalSearch.tsx` (project
work above the conversations), `runtime/adapter.ts` (the send path expands the
draft and reports the outcomes), `host/src/session-search.ts` and `host/src/catalog.ts` (a user
message is indexed and previewed as its prose), `host/src/server.ts` (`projectPaths`, so provenance
can name a project a person recognises).

### Decisions where the contract is silent

1. **The identity lives in the message, at its foot.** A conversation stores
   text and images; there is no per-message side channel, and a mention has to
   survive a reload, an edit, a fork and a second device. So the sent message
   carries one Markdown link-reference definition per mention
   (`[TASK-44]: laser://work/<project>/<kind>/<entity>/<revision> "sha256-…"`),
   the prose keeps the human form, and the transcript drops the definitions
   entirely. "Visible and copied text is the stable human form" therefore holds
   literally: what is on screen, and what a person selects out of a bubble, is
   `@TASK-44 "Rework the picker"`.
2. **The host parses the message rather than trusting a parameter.** The
   identities are already in the text it was asked to send, so nothing extra is
   trusted, and an *edited* or *forked* message keeps its mentions working with
   no extra plumbing. `session/prompt`'s `projectWork` is host-supplied only;
   whatever a client sends there is dropped.
3. **The projection is delivered on the request, not pasted into the
   conversation.** The leap says a mention is captured *by reference, not
   copied*, so the bounded projection rides on `session/prompt` as typed data
   and never becomes message content nobody wrote. **Open item:** the worker
   consumes `projectWork` in M21-T17, with the context packet it already owns;
   until then the model reads the human form and the work link in the message
   text, and the host's projection is validated, bounded and delivered but not
   yet used by the engine. This is stated here rather than implied, because
   nothing in the UI pretends otherwise.
4. **Picking writes the draft itself.** The text an insertion produces depends
   on the draft it lands in — the same key pinned twice at two revisions needs
   two labels — which a directive formatter cannot know. So the picker's
   navigation writes it, pins the identity, and records the choice as finished.
5. **A pin is a memory, not an authority.** The window remembers the last 64
   picks by label, so the send path can attach the revision that was on screen;
   the host re-reads every mention anyway and re-pins it when the digest
   disagrees.
6. **Other projects are ordered and labelled, not nested behind a category.**
   The picker's category mode is a second keystroke before any result is
   visible; a block of rows under its project's name answers "where is this
   from" without one. Exact keys still outrank everything.
7. **The sidebar reads execution links once per project sequence.** A backlog
   row says how many execution links a Task has, never which, so the Tasks that
   have any are read (bounded to 30, `body: "none"`) and the map is shared by
   every row. A project this window has not read has no chips, rather than a
   chip that guesses from a title.

### What is proven, and what is not

Proven by `pnpm -F @lasercode/protocol test`, `env -i … pnpm -F @lasercode/host test`
and `pnpm -F @lasercode/ui test`: the token grammar and its idempotence, the
search projection storing the prose once, the ranking, the pick's draft and the
identity it pins, a hand-typed key resolved from the project cache, the host's
validation (digest mismatch → re-pinned, missing revision → unavailable with the
reason, unknown project, a connection without read scope), the bounded
projection and its provenance, a stale revision sent as the revision it names,
the transcript chip and card and the exact revision they open, the composer's
finished record, and the sidebar's session → Task link.

Not proven by a test, and named rather than claimed: how any of it **looks** —
the chip's weight beside prose, the tag's tint in both themes, the picker's
blocks on a phone. That is the person's acceptance run (AGENTS.md, D-342).
