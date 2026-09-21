# Plain Chat and the end of built-in agents

Status: **binding design for M23** (`PLAN.md` "M23 · Plain Chat"; decision
D-347). A companion contract of
[`project-lifecycle-leap.md`](project-lifecycle-leap.md), indexed there under
"Companion contracts". Depends on [`model-profiles.md`](model-profiles.md)
(M22) for every model choice below. Read [`AGENTS.md`](../AGENTS.md)
invariants 6 and 12 and [`agents.md`](agents.md) §7 first: §7 describes what
this document removes.

## The idea in one paragraph

Beam, Chat and Namer stop being agents. **Chat** stays as the product's plain
conversation: a session with no persona, no project and a system prompt made
only of the live tool catalogue, the tool guidelines and the discovered
skills. **Naming** becomes a one-shot request on the naming profile with no
identity, no editable prompt and no qualification benchmark. **Beam** is
removed: its spark, bubble, workspace, model dialog, sidebar group and
product-guidance prompt go with it. `AgentKind` loses `"builtin"`; the Agents
page shows only agents a person wrote.

## Chat

A Chat session is an ordinary session with `sessionKind: "chat"` instead of an
`agentName`. It carries:

| Property | Value |
| --- | --- |
| Instruction template | exactly `{{availableTools}}\n\n{{toolGuidelines}}\n\n{{availableSkills}}`; not editable, not a built-in definition |
| Identity paragraph | none; no product name, no role, no hidden coding persona |
| Project instructions | none — there is no project |
| Profile | `defaultProfileId`, changeable per session like any session |
| Workspace | one opaque persistent directory per session under `<state>/workspaces/chat` (M13-T79), unchanged |
| Tools | every tool the engine offers, plus the harness and background tools; no product-guidance skill |
| Skills | every discovered global skill (project skills need a project) |
| Move to a project | unchanged (M13-T58); the moved session becomes an ordinary project session on the default agent |
| Sidebar | the Chat tab, first before Code, unchanged |
| Entry points | sidebar `+` in the Chat tab, `New chat` in the command palette, keyboard shortcut; every one of them starts an empty Chat |

The compulsory companion additions at `before_agent_start` (role and goal
context, D-140) still apply to agent runs; a Chat session that is not an agent
run receives none of them. The rendered prompt is exactly the three fields.

## Naming

`NamerService` becomes a plain function of the worker: one bounded completion
walking `namingProfileId` in order with the M22 eligibility classes, an 8 s
ceiling, the existing tolerant normalisation and length rules, and silence on
failure. Removed: `NamerState`, `agents/namer/qualify`, the qualification
sample and ranking, the Namer instruction template and its fields, the Namer
model dialog, the Namer row on the Agents page and the M18-T17 naming pin
special case (there is no Namer to be unavailable; a naming request that
cannot start simply does not run).

## Beam

Removed entirely (D-347). The person's earlier one open question — keep the
spark as "New Chat" — is answered **no**: the Chat tab's `+` and the palette
are the entry points, and a floating launcher that opens a bubble is a second
conversation surface the product no longer has. Removal covers the spark, the
bubble and its maximize path, `BeamState`, `agents/beam/choose-model`, the
first-provider prompt, the Beam sidebar group and mark, `<state>/workspaces/beam`
(existing Beam sessions are re-homed as Chat sessions on next host start and
keep their history), the Beam empty state, the Beam-specific composer
isolation rules, the Beam instruction template with its state-location
fields, and the M13-T100 overlap rule that existed only for the bubble.

## What a person sees

- Agents page: only their own agents. The empty state explains how to write
  one; nothing built-in is listed, editable or restorable.
- Chat tab: unchanged shape; a new chat opens with the composer focused and no
  hint that names an assistant.
- Settings → Providers and models: the default, naming and consultation
  profile pickers (M22) are where Chat's and naming's models live now.
- Session rows: no Beam mark, no built-in badge.

## Migration

- Stored built-in instruction overrides and model choices (`beamModel`,
  `chatModel`, `namerModel`, `instructions.*`) are read once, mapped to
  profile ids by the M22 migration, then ignored; the keys stay one release.
- Existing sessions whose `lasercode/agent` record names `beam` or `chat`
  open as `sessionKind: "chat"`; the record is not rewritten (history is
  evidence). Sessions under `workspaces/beam` are listed in the Chat tab.
- Agent files that list `beam`, `chat` or `namer` in `allowedAgents` validate
  with a warning on that field and run with the name dropped.

## Breaking change — affected areas

**Status: every row below has landed** — M23-T1 `5aebaee4` (protocol), M23-T2
`0051d591` (worker), M23-T3 `79404b7c` (host), M23-T4 `72f0a3a1` (UI and CLI),
M23-T5 `0cd83795` (identity guard) and this document's own commit (docs).
Four things landed differently from this document and are marked `≠` below:

- `≠` **`scripts/browser-check` Beam fixtures.** Deleted with the UI in
  M23-T4; the soak creates Chat sessions (`sessionKind: 'chat'`) and no
  fixture drives a bubble any more.
- `≠` **`clean-machine.mjs` no longer expects the Beam skill.** Nothing to
  remove: by the time M23 ran, that script asserted only the `subagents` and
  `background-work` modules and the adapter's own published skills. The row is
  satisfied without an edit.
- `≠` **A Chat's tools.** The "Chat" table above says "every tool the engine
  offers, plus the harness and background tools". What landed is every engine
  tool plus the background-work tools; the harness tools are not there, because
  `start_agent` and its siblings are registered only when `canDelegate()` is
  true, and that reads `definition.supportsSubagents` — a Chat has no
  definition. A Chat therefore starts no agents
  (`packages/pi-extension/src/modules/subagents.ts`,
  `packages/worker/src/agents/harness.ts`). Deciding whether a plain
  conversation *should* be able to delegate is a product question, not a
  documentation one; it is recorded here rather than quietly written either
  way.
- `≠` **The identity guard** is check 3 of `scripts/identity/check.mjs`, beside
  the model-vocabulary patterns rather than as a guard of its own: `\bBeam\b`
  and `\bNamer\b` are forbidden in person-facing string literals in
  `packages/{ui,cli,host,worker,desktop}/src`. Identifiers, comments and the
  startup drawing's plural "beams" are deliberately outside it.

One deliberate leftover, flagged rather than done: `LaserThreadScope` (with its
store, history window, refusal context and `view-cache` scope accounting) is
kept and still tested, but has **no mount point** — the removed bubble was its
only caller. It is a generic "second conversation on screen" seam; removing it
touches `history-owners.ts`, `view-cache.ts` and `transcript-presentation.ts`
and is a larger change than this milestone.

| Layer | What changes |
| --- | --- |
| Protocol | `AgentKind` → `"custom"` only; `BUILTIN_AGENT_NAMES`, `BuiltinAgentName`, `BeamState`, `NamerState`, `ChatState` removed; `agents/builtin/*`, `agents/beam/choose-model`, `agents/namer/qualify` removed from messages, schemas and policy; `SessionAgentInfo` gains `sessionKind`; instruction-template field catalogue loses the Beam and Namer fields; `startup-screen.ts` "beam" is a drawing, untouched |
| Worker | `agents/definitions.ts`, `session-config.ts`, `instruction-templates.ts`, `engine-instructions.ts`: no built-in branches, chat template constant; `namer.ts` reduced to the one-shot function on the naming profile; `first-turn.ts` naming call; `stable-sdk.ts` and `worker-lifetime.ts` naming pin removal; `packages.ts` Beam skill remnants; tests for each |
| Host | `agents/builtins.ts` deleted; `agents/{index,store,validate,models}.ts` no built-in synthesis; `paths.ts` `workspaceAgentFor` → chat only, Beam workspace re-home at start; `catalog.ts`, `session-projection.ts`, `transcript-delivery.ts` chat kind; `router.ts`, `server.ts`, `worker-client.ts` removed methods and first-provider Beam prompt |
| UI | `components/beam/*` deleted; `Shell.tsx`, `Rail.tsx`, `TopBar.tsx`, `SessionsPanel.tsx`, `session-groups.ts`, `GlobalSearch.tsx` lose the Beam group, mark and spark; `agents/page/{AgentList,AgentsEditorColumn,BuiltinPanel,dialogs,model,instruction-template-model}` lose built-ins; `agent-selector.tsx` no built-in rows; `Composer.tsx`, `Thread.tsx`, `main-destination*.ts`, `new-session.ts`, `threadList.ts`, `LaserProvider.tsx`, `store.ts`, `device-storage.ts`, `history-*.ts`, `projection.ts`, `view-cache.ts`, `transcript-presentation.ts`, `finished-mentions.ts`, `use-conversation-find.tsx`, `FleetPanel.tsx`, `DictateButton.tsx`, `loading-state.tsx`, `thinking-indicator.tsx`, `theme/presets.ts` Beam tokens; every test naming Beam or Namer |
| Desktop | `main.ts`, `startup-ground.ts`, `error-page.ts` Beam references |
| Persistence | host state built-in choices ignored after M22 migration; `workspaces/beam` re-homed; session records untouched |
| Docs and gates | `agents.md` §7 rewritten, `product-boundary.md` Beam/Chat/Namer rows, `architecture.md`, `mobile.md`, `ux-fleet.md`, `ux-elements.md`, `ux-theme.md` Beam tokens, `environment-policy.md`, `project-mentions.md`, `transcript-reading.md`; `scripts/browser-check` fixtures that drive Beam are deleted with it; identity guard for "Beam" and "Namer" on person surfaces; `clean-machine.mjs` no longer expects the Beam skill |
| Plan | M13 rows naming Beam/Namer stay as history; M18-T17 behaviour superseded |
