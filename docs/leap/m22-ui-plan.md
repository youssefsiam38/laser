# M22 UI and CLI plan (T6 → T9)

Owner: worker agent "Model profiles UI and CLI", branch
`agents/model-profiles-ui-and-cli-0d93c72c`. Contract: `docs/model-profiles.md`,
`PLAN.md` "M22 · Model profiles", decision D-346. Front half only: M22-T6 →
M22-T9. `packages/protocol`, `packages/worker`, `packages/host` belong to the
backend owner (branch `agents/model-profiles-backend-819b3a73`); this branch
compiles against the protocol as it is declared, not as the host has yet
implemented it.

## Assumptions about host behaviour (protocol was silent)

- **U-a** Profile CRUD goes through `models/profiles/{list,save,delete}`, never
  through a raw `pi/settings/set` of `modelProfiles`. The host is the only
  writer, so delete-with-replacement stays server-enforced (M22-T5 acceptance).
  The UI still runs `validateModelProfiles` locally so the refusal sentence a
  person reads is the sentence the worker would have written.
- **U-b** Assignments (`defaultProfileId`, `namingProfileId`, `oracleProfileId`,
  `designIndexProfileId`) are ordinary settings keys, written with
  `pi/settings/set` at **global** scope, and read back from
  `models/profiles/list` → `assignments`. There is no `models/assignments/set`
  method in the protocol, and profiles are global (`docs/model-profiles.md`
  "Domain"), so the Settings form writes them at global scope only.
- **U-c** Profile ids are minted by the client when a profile is created:
  `mp_` + a 32-char hex from `crypto.randomUUID()`, which satisfies
  `MODEL_PROFILE_ID_PATTERN`. A host that re-mints ids on save is still
  correct; the UI re-reads the returned list either way.
- **U-d** `models/profiles/save` and `delete` return the whole
  `{ profiles, assignments }` pair, so the tab never re-reads after a write.
- **U-e** The `models/profiles/seeded` notification carries profiles that the
  host has **already written**. Onboarding shows them for review; skipping
  writes nothing.
- **U-f** `SessionState.profile` is `null` for a pinned session and for any
  session written before M22; `pinned` marks the deliberate pin. Both display
  as "Pinned · no fallback", but only `pinned` is a person's own act.
- **U-g** `AgentsSnapshot.builtinProfiles` holds profile ids (or `null` =
  inherit `defaultProfileId`), set with `agents/builtin/set-profile`.

## For the docs/gates owner

- `packages/desktop/scripts/clean-machine.mjs:414-420` writes a scratch global
  settings file with `defaultProvider` / `defaultModel` / `enabledModels`. It
  drives the host head-less, not the onboarding UI, so nothing there breaks
  with this branch — but once the worker migration lands it should either rely
  on that migration or write `modelProfiles` + `defaultProfileId` directly, so
  the gate proves a packaged app starts a session on a profile.
- The onboarding step id a device remembers changed from `model` to `profiles`
  (`setup-model.ts`); a remembered `model` simply falls back to the welcome,
  which is the existing behaviour for an unknown value.
- `pnpm identity:check` copy guard for "chain"/"tier" on person surfaces: the
  UI no longer writes either word on a person surface after T8.

## M22-T6 · Settings: Model profiles tab and assignment pickers

Status: done.

Changed:
- Added `src/components/assistant-ui/elements/model-profiles.tsx`: the shared
  `useModelProfiles` hook (list/save/delete over the protocol methods),
  `ProfilePicker`, `newProfileId`, `profileModelSummary`.
- Added `src/components/settings/models/profile-usage.ts` (pure: usage lines,
  duplicate naming, reorder/remove helpers) and `ModelProfilesTab.tsx`.
- Deleted `src/components/settings/fallback/FallbackChainsTab.tsx` and
  `test/settings/fallback-chains.test.tsx`.
- `ModelsTab.tsx`: the inner tab is "Model profiles" and mounts the new tab.
- `SettingsForm.tsx`: the four assignment paths render a `ProfilePicker`;
  the `defaultProvider`/`defaultModel`/`modelThinkingLevels` special cases are
  gone with the descriptors that fed them.
- Tests: `test/settings/model-profiles.test.tsx`,
  `test/settings/profile-usage.test.ts`; the policed-method fixture in
  `test/runtime/environment-capabilities.test.ts` picked up the five new
  methods and dropped the two removed ones, and `test/settings/models-tab.test.tsx`
  gained `useLaserState` in its runtime mock (the profiles pane is mounted
  beside the one it tests).

Validation: `npx vitest run test/settings test/runtime/environment-capabilities.test.ts`
(all green), `pnpm -F @lasercode/ui typecheck` red only in the files T7–T9 own.

Left for later tasks: the composer, agents page, onboarding and CLI still name
models; the whole-package typecheck and build stay red until T9.

## M22-T7 · Onboarding profile review

Status: done.

Changed: `onboarding/ProfilesStep.tsx` (new) replaces `ModelStep.tsx` (deleted);
`FirstRunFlow.tsx` steps are welcome → provider → profiles → project → ready and
its facts come from `models/profiles/list`; `setup-model.ts` renames the step
and the fact (`hasDefaultModel` → `hasProfiles`); `onboarding/index.ts`.
`useModelProfiles` now also listens for `models/profiles/seeded` and re-reads,
so a seed that lands while the step is open appears without a reload.

The step edits two things and no more: which profile new conversations use
(`defaultProfileId` at global scope) and which model a profile reaches for
first (`models/profiles/save`, the chosen model moved to the front). Renaming
and adding models stay in Settings, and the step says so. Arriving and leaving
writes nothing, which is what "skip leaves the seeds" means.

Tests: `test/onboarding/profiles-step.test.tsx` (six cases incl. the pending
state, the seeded notification and the error state), `setup-model.test.ts`
updated.
Validation: `npx vitest run` in packages/ui — 323 files, 3005 passed.

## M22-T8 · Composer, status line, fleet, logs

Status: done.

Changed:
- `elements/model-selector.tsx`: `SessionModelSelector` is now a profile
  control. The trigger names the profile and, beneath it, the model answering;
  a pinned conversation reads "Pinned · no fallback". The menu has two groups —
  Profiles (`session/profile/set`, or `defaultProfileId` at project scope with
  no conversation open) and "Pin one model" (`session/model/pin`, or the
  composer's first-turn model intent on a pristine conversation). Rows carry
  `data-option="profile" | "model"`. `defaultModelChanges` →
  `defaultProfileChanges`. Catalogue display names for profile entries come
  from one cached `pi/models/catalog` read per project, as the old project
  default did.
- `elements/reasoning-effort.tsx`: the level follows the profile's first model
  and that entry's `thinking`, then the model default.
- `elements/model-profiles.tsx`: `useProfileNames` (one shared read per
  directory, dropped on a save or a seeding).
- `thread/StatusLine.tsx`: "moving to <model>" while a profile moves.
- `store.ts`: `AgentsSlice.seededProfiles` replaces `chooseBeamModel`, the
  `models/profiles/seeded` notification replaces `agents/beam/choose-model`,
  `modelNamesOf` reads `fallback.models`, and the transcript record says
  "Moved to X" / "No other model in this profile could take over".
- `runtime/LaserProvider.tsx`: `setModel` is the pin path (`session/model/pin`)
  and `setProfile` is new; `runtime/provisional-paint.ts` paints `profile: null`.
- `agents/{actions,hooks}.ts`: `setBuiltinProfile` replaces `setBuiltinModel`;
  `qualifyNamer` and `dismissBeamChoice` are gone; `useSeededProfiles`.
- Fleet: `fleet/model.ts` items carry `profileId` and `substitutedProfile`,
  `fleet/row.ts` has `profileLabel` and a strip that reads
  `agent · profile · model · turns · worktree`, `FleetWorkRow` marks a
  substitution in the attention colour, `FleetPanel` has a Profile field with
  the substitution sentence, and `components/fleet/profile-names.tsx` reads the
  names once for the column.
- Session list: `thread-list.aui.tsx` rows carry `runningOn` ("Balanced ·
  Sonnet 4.5" or "Pinned · <model>") in the row tooltip; the visible row keeps
  its title and activity mark (DESIGN.md forbids status words there).
- Usage: `telemetry/model-section.tsx` names the profile beside the model, or
  says the conversation is pinned; `shell/TelemetryPanel.tsx` resolves the name.
- The phone uses the same `SessionModelSelector` through `MobileComposer`, so
  the picker moved with it; no second control was written.

Tests: `test/thread/profile-selector.test.tsx` (replaces
`fallback-chain-badge.test.tsx`), `test/thread/profile-status-line.test.tsx`
and `profile-move-record.test.ts` (renamed), plus updates to
`test/agents/{fixtures,store,actions,hooks}`, `test/beam/fake-host.tsx`
(profiles, `session/profile/set`, `session/model/pin`,
`agents/builtin/set-profile`), `test/thread/{first-turn-refusal,message-queue,
model-selector,reasoning-effort}`, `test/settings/picker-refresh.test.tsx`,
`test/beam/scope-isolation.test.tsx` and four `SessionState` fixtures.

Open item for the protocol owner (M22-T10 reconciliation):
`ProviderRequestContext` (`protocol/src/pi-extension.ts`) carries no
`profileId`, so the logs inspector cannot attribute a **captured** request to
the profile that was in force when it ran. Rather than print the conversation's
current profile beside an older capture — which would be a claim the record
does not support — the inspector is left naming provider, model and API only.
Add `profileId` to the capture context and the inspector gains a row.

Validation: `npx vitest run` in packages/ui — 320 of 323 files green; the three
red ones (`test/agents/page/{screen,phone}`, `test/beam/model-dialog`) are
M22-T9's.

## M22-T9 · Agents page and CLI

Status: planned.

Changed: `agents/page/{model.ts,BuiltinPanel.tsx,dialogs.tsx,AgentEditor*.tsx}`,
`beam/{BeamModelDialog.tsx,beam-model.ts}`, `agents/actions.ts`;
CLI `commands/{doctor,runs,session}.ts`.
