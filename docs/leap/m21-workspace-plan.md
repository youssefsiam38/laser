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
| `packages/ui/src/components/project-work/Workspace.tsx` | the shell surface: header, tabs, "← Back to the conversation", the morph |
| `packages/ui/src/components/project-work/WorkBacklog.tsx` | filters, sort, saved views, the wide table and the narrow rows |
| `packages/ui/src/components/project-work/WorkDetail.tsx` | the kind-aware detail frame and the read-only bodies |
| `packages/ui/src/components/project-work/Inspector.tsx` | the kind-aware inspector (links, comments, history, gates) |
| `packages/ui/src/components/project-work/Board.tsx` | the Tasks board and its real drag transitions |
| `packages/ui/src/components/project-work/NeedsYou.tsx` | the queue, on the adopted approval/artifact cards |
| `packages/ui/src/components/project-work/Recent.tsx` | revisions newest first, on the adopted timeline |
| `packages/ui/src/components/project-work/CreateDialog.tsx` | one dialog, the next key shown before creating |
| `packages/ui/src/components/project-work/KindBadge.tsx` | the type badge, the key tag and the status chip |
| `packages/ui/src/components/project-work/confirm.tsx` | Archive and Delete, typed confirmation, Enter confirms neither |

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

### What T7, T8, T13 and T16 fill in

The detail frame is built from **slots**. Everything below is an existing
component boundary with a real, honest reading state in it today — never a
placeholder card.

| Slot | File | Today | Filled by |
| --- | --- | --- | --- |
| `SpecBodyView` | `components/project-work/bodies/SpecBody.tsx` | the real body read-only: form, brief, problem, outcomes, non-goals, requirements with levels, acceptance with the machine-verifiable mark, constraints, and the Markdown document through the shared renderer | **M21-T7** adds editing, the brief→full revision flow and the Jira chip |
| `ResearchBodyView` | `components/project-work/bodies/ResearchBody.tsx` | the real body read-only: question, scope, status, the question tree with each node's state and answer, findings with confidence/licence/trust/excerpt/provenance, options, unresolved facts, sources | **M21-T7** adds the two-column tree ↔ source panel, Quote, Open source and the retrieval budget bar (`docs/research-phase.md`) |
| `DesignBodyView` | `components/project-work/bodies/DesignBody.tsx` | the real body read-only: brief, aggregate fidelity, foundation principles, screens with their fidelity and interaction states, flows, sketches (identity and bounds only — never the bytes), host page and strategy | **M21-T13** replaces the body with the canvas and the Design Index inspector; **M21-T14** the greenfield foundation |
| `PlanBodyView` | `components/project-work/bodies/PlanBody.tsx` | the real body read-only: brief, phases with their task keys, dependencies as key pairs, boundaries, migrations, risks, verification, rollback, and the Markdown document | **M21-T16** adds the Document/Dependencies switch and the real graph |
| `TaskBodyView` | `components/project-work/bodies/TaskBody.tsx` | the real body read-only: outcome, non-goals, dependencies as key cards, scope, acceptance with commands, verification commands, visual-evidence requirement, assignment, plan key, notes | **M21-T16** adds attempts, evidence, checkpoints and Start… |
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
- **Mentions (`@SPEC-12`) in the composer.** M21-T9 owns the mention adapter;
  T6 ships the chip component it will insert and the search ranking behind it.
- **Model tools and execution linking.** M21-T17.
