# M23-T4 UI plan (remove Beam, plain Chat entry points)

Owner: worker agent "Plain chat UI and CLI", branch
`agents/plain-chat-ui-and-cli-26bc7136`, base `64cff8db`. Contract:
[`docs/plain-chat.md`](../plain-chat.md), `PLAN.md` "M23 · Plain Chat" row
M23-T4. The backend half is described in
[`m23-backend-plan.md`](m23-backend-plan.md) and its compile-error list in
[`m23-ui-red-spots.md`](m23-ui-red-spots.md).

Write scope: `packages/ui`, `packages/cli`, `scripts/browser-check` (Beam
fixtures only), this file. Nothing else.

## Shape decisions (where the contract is silent)

- **D-t · a new Chat is `session/new { cwd: workspaces.chat, sessionKind:
  "chat" }`.** `agentName: "chat"` is gone with the built-in, and the protocol
  refuses the two together. `NewSessionOptions` therefore carries
  `sessionKind`, the launcher keys its reuse on `cwd + agent + kind`, and
  `creationTargetForDestination` returns a session kind instead of an agent
  name for the Chat landing.
- **D-u · session rows group on `sessionKind`, not on the workspace
  directory.** `SessionAgentInfo.sessionKind` is the host's answer and wins; a
  session with no record falls back to "is its cwd inside `workspaces.chat`".
  A legacy record that still says `kind: "beam"` is read as a Chat by
  `sessionKindOf`, so old Beam conversations list in the Chat tab with no mark
  of their own and no rewrite of the record.
- **D-v · the third entry point is `Mod+Shift+N`.** The contract asks for a
  keyboard shortcut that starts an empty Chat; `Mod+N` already means "new
  session in this project". `Mod+Shift+N` is its Chat counterpart, listed in
  Settings → Keyboard beside it, on the palette row and on the Chat tab's `+`
  tooltip. `format.ts#shortcutLabel` gained a `{ shift }` option so the label
  is `⇧⌘N` on Apple and `Ctrl+Shift+N` elsewhere.
- **D-w · the Agents page keeps the shipped `default` agent in "Your
  agents".** It is an ordinary editable definition (`kind: "custom"`), not a
  built-in. The designed empty state appears when the person has written no
  agent of their own beside it.
- **D-x · one verb for all three entry points.** `newChat()` and `canChat`
  live on the shell context beside `newSession()`/`canCreate`; the sidebar
  `+`, the palette row and the shortcut all call it. One implementation, one
  set of refusals ("Not connected to the host yet." / "Chat is not ready yet.
  Try again in a moment.").

## What changed

### Deleted

- `packages/ui/src/components/beam/*` (bubble, spark, empty state, profile
  dialog, session mark, store, model) and its tests
  (`test/beam/{bubble,bubble-start,spark,profile-dialog,scope-isolation,entry-points}`).
- `packages/ui/src/components/agents/page/BuiltinPanel.tsx`, the
  `BuiltinProfileDialog` and its copy table in `page/dialogs.tsx`.
- `agents/actions.ts`: `setBuiltinProfile`, `setBuiltinInstructions`.
- `runtime/main-destination.ts`: the `beam-session` code destination, the
  `beam` landing workspace and `projectReturnOf` (an identity function once
  the Beam destination was gone).
- `Thread.tsx`: the `emptyState` / `followUps` override props — the bubble was
  their only caller.
- `use-conversation-find.tsx`: the two `[data-slot="beam-bubble"]` checks
  (both were `null !== null` once the bubble was gone).
- `DEVICE_KEYS.beamSession`.

### Changed

- `agents/model.ts`: `isWorkspaceCwd` → `"chat" | null`; new `sessionKindFor`
  (record first, `sessionKindOf`-mapped, directory as fallback);
  `sessionAgentName` answers `undefined` for a Chat; `agentDisplayName` keeps
  only the shipped default; `isBuiltinAgent` removed.
- `agents/hooks.ts`: `useSessionAgent` carries `sessionKind` and omits
  `agentName` for a Chat.
- `runtime/new-session.ts`, `main-destination*.ts`, `threadList.ts`,
  `LaserProvider.tsx`: `sessionKind` travels from every entry point to
  `session/new`; reuse of an empty session matches kind as well as agent.
- Shell: `newChat`/`canChat` on the context, `Mod+Shift+N`, palette row,
  Settings → Keyboard row; `Rail`, `TopBar`, `SessionsPanel` lost the spark,
  the mark and the Beam group branch.
- `session-groups.ts`, `thread-list.aui.tsx`, `GlobalSearch.tsx`: one
  workspace kind (`chat`), grouping by `sessionKindOf(record.kind)`.
- Agents page: one `agentsInScope(...).custom` list; a designed
  `agent-list-empty` state ("No agents of your own yet" + New agent) when the
  only definition is the shipped default; instruction-template editor and
  source lost the `target` argument.
- `settings/models/profile-usage.ts`: "used by" counts assignments and the
  person's agents; built-ins are not a kind of user any more.
- `theme/presets.ts`: the three taglines say "the mark's green" / "green"
  rather than "beam green" (person-visible copy).
- CLI: `format.ts#sessionPlace` — the `sessions` and `runs` tables, `attach`
  and `tail` print **Chat** for a Chat conversation instead of its private
  workspace directory; a pre-M23 `beam` record reads as Chat.
- `scripts/browser-check`: the soak creates Chat sessions only
  (`sessionKind: 'chat'`), `workspaceSessionsPerKind` → `chatSessions`,
  retirement/keyboard/storage/affordance fixtures lost their Beam branches.

### Tests

New: `test/shell/new-chat-entry-points.test.tsx` (the three entry points over
the real Shell and provider: one `session/new` with `sessionKind: "chat"` and
no `agentName`, the created session empty, the composer focused, no agent
chip); `test/agents/page/screen.test.tsx` "explains how to write the first
agent…"; `packages/cli/test/session-place.test.ts`.

Rewritten rather than deleted, because the behaviour still exists: the
`sessionKind` grouping cases in `test/shell/session-groups-workspaces.test.ts`
(a pre-M23 `beam` record lists in the Chat tab), `test/shell/sessions-tabs.test.tsx`
(Code is projects only, no Beam mark), `test/runtime/tab-destination.test.ts`
(a legacy Beam record opens in the Chat tab without poisoning Code memory) and
`test/runtime/new-session.test.ts` (a blank Chat and a blank project session
never take each other over).

Moved: `test/beam/fake-host.tsx` → `test/world/fake-host.tsx` (`BEAM_CWD` →
`CHAT_CWD`), `test/beam/thread-stub.tsx` → `test/world/thread-stub.tsx`,
`test/beam/{dictation-scope,landing-dictation}` → `test/thread/`.

## Deliberate survivors of the `beam` grep

| Where | Why it stays |
| --- | --- |
| `globals.css` `--startup-beam-*`, `.startup-restoration-beams`, `@keyframes startup-beam`; `test/startup-screen.test.ts` | The startup drawing, pinned to `@lasercode/protocol/startup-screen`, which M23-T1 deliberately left alone. Beams of light, not the assistant. |
| `ActivityBeam` / `.activity-beam` (`thinking-indicator.tsx`, `tool-fallback.aui.tsx`, `tool-group.aui.tsx`, `globals.css`, `test/thread/activity-disclosure.test.tsx`) | The travelling line of light under a running tool row — the same kind of drawing as the startup beams, never the assistant, and not person-visible copy. Renaming it would churn five files and two tests for no product meaning. |
| `loading-state.tsx` "Magic UI's Animated Beam composition" | A citation of a third-party component's own name. |
| `device-storage.ts` `storageKey("beam-session")` in `LEGACY_EXACT_KEYS` (and its purge case in `test/runtime/device-storage.test.ts`) | The key the bubble wrote before M23. Dropping it from the purge list would leave the orphan on every existing install forever. |
| Migration comments and fixtures naming a stored `beam` record (`agents/model.ts`, `session-groups.ts`, `threadList.ts`, `main-destination-controller.ts`, `cli/format.ts`, and the tests that prove the mapping) | `docs/plain-chat.md` keeps those records unrewritten; the code that reads them has to say which records it means. |

Not a survivor but worth knowing: **`LaserThreadScope` (and its store,
history window, refusal context and `view-cache` scope accounting) has no
mount point in the app any more** — the bubble was its only caller. It is a
generic "second conversation on screen" seam, it is still covered by
`test/runtime/scope-adapter-identity.test.tsx` and
`test/thread/first-turn-refusal.test.tsx`, and removing it would be a much
larger change than this milestone (`history-owners.ts`, `view-cache.ts`,
`transcript-presentation.ts` are all written around more than one surface).
Flagged for the coordinator rather than done here.

## Depends on the host (M23-T3)

Nothing outstanding: `work/fallback-update` (host at `b4162a27`) was merged
into this branch and the whole workspace is green.

## For the docs and gates owner (M23-T5)

- `clean-machine.mjs` still expects the Beam skill (not in my write scope).
- The identity guard for "Beam"/"Namer" must be written against **person
  surfaces**, not a blanket grep of `packages/ui/src`: the startup drawing and
  `activity-beam` keep the word as a description of light (see the survivor
  table). `packages/ui/src` has no person-visible "Beam"/"Namer" copy left.
- `docs/mobile.md`, `docs/ux-elements.md`, `docs/ux-theme.md` and
  `docs/agents.md` §7 still describe the spark, the bubble and the Beam group;
  the code no longer has them. (`packages/ui/DESIGN.md` and
  `packages/ui/README.md` never named Beam and needed no change.)
- The new keyboard shortcut `Mod+Shift+N` (D-v) wants a line wherever
  shortcuts are documented.

## Validation

| Command | Result |
| --- | --- |
| `pnpm -F @lasercode/ui typecheck` | clean |
| `pnpm -F @lasercode/ui test` (types + vitest) | 319 files, 2989 passed / 1 skipped |
| `pnpm -F @lasercode/cli build` + `test` | clean; 19 files, 39 tests pass |
| `pnpm test:browser-check` | 104 tests, all pass (after the host merge) |
| `pnpm -r build`, `pnpm -r typecheck` | clean |
| `pnpm verify` | passed in 113 s |
| `pnpm identity:check` | clean |

## M23 review fixes (UI half)

### S1 · one directory rule, in the protocol

D-u said a record-less session falls back to "is its cwd **inside**
`workspaces.chat`", but `isWorkspaceCwd` (`packages/ui/src/agents/model.ts`)
tested the root for equality, while `workspaceKindOf`
(`components/shell/session-groups.ts`) did its own normalized prefix
containment and the host had a third rule of its own. One rule now:
`isChatWorkspaceCwd` in `@lasercode/protocol` (`src/agents.ts`, beside
`sessionKindOf`) — containment over the roots the host sends in
`AgentsSnapshot.workspaces`, the retired pre-M23 sibling directory included,
with the containment test injectable so the host can resolve filesystem
aliases first.

- `isWorkspaceCwd` is **deleted**; `agentKindOf`, `sessionKindFor` and
  `runtime/new-session.ts` call the protocol rule directly.
- `workspaceKindOf` stays as the group vocabulary's `"chat" | undefined`
  shape and does nothing but delegate, so its twelve call sites are unchanged.
- Host: `isChatWorkspace` (`packages/host/src/paths.ts`) delegates too,
  passing its realpath-resolving `isWithinDirectory`.
- Tests: `packages/protocol/test/agents.test.ts` "the Chat workspace directory
  rule" (containment, the retired directory, a sibling that merely shares the
  prefix, trailing separators, an unarrived snapshot, an alias-resolving
  caller); `packages/ui/test/agents/model.test.ts` "places a record-less
  session by containment, not by the workspace root alone (D-u)";
  `packages/ui/test/shell/session-groups-workspaces.test.ts` "recognises every
  private per-session directory as part of the Chat workspace".

### S3 · `LaserThreadScope` — deferred, deliberately, with the reason

**Not removed.** The review asks for the dead second-surface seam to go; the
removal is not bounded the way this fix is. Measured at this revision:

| File | What the seam owns there | Lines at stake |
| --- | --- | --- |
| `packages/ui/src/runtime/LaserProvider.tsx` | `LaserThreadScope`, `ScopedRuntime`, `ScopeComposerMemory`, `createScopedStateStore`, `ThreadScopeRefusalContext`/`useThreadScopeRefusal`, `attachScope`/`claimScope`/`scopeClaims`/`scopeRevision`, and the `readScoped === readState` parameterization of `buildActions` (~8 branch points across ~300 lines of actions) | ~500 |
| `packages/ui/src/runtime/history-owners.ts` | the whole owner-local transcript window (D-236) exists so a second surface can page one session independently; it **re-runs the store reducer** per surface | 173 (+206 test) |
| `packages/ui/src/runtime/view-cache.ts` | the `"scope"` retention reason and `environment.scoped()` accounting | ~15 |
| `packages/ui/src/runtime/transcript-presentation.ts` | the "never a thread scope" ownership rule | ~5 |
| `packages/ui/src/runtime/index.ts`, `new-session.ts` | exports and the quiet-launch path shared with the main surface | ~10 |
| `packages/ui/test/runtime/scope-adapter-identity.test.tsx`, `packages/ui/test/thread/first-turn-refusal.test.tsx`, `packages/ui/test/runtime/history-owners.test.ts` | the tests that would go with it | 813 |

That is well over the ~600-line bound this fix was given, and it lands on the
transcript reducer path (`history-owners.ts` feeds `reduce` its own action
stream before React sees a transaction), which is exactly the code a
half-removal would break silently. Removing the seam is a task with its own
row and its own evidence — M24's consultation row or M26's tool contract
pre-work, per the review — not a side effect of a review fix. Until then
`LaserThreadScope` stays mounted nowhere and fully tested; nothing in this fix
touched it.
