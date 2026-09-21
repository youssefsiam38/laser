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

## M21-T16 · Plans and Tasks

### What landed

| File | What it owns |
| --- | --- |
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
