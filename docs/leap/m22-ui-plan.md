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

- `scripts/packaging/clean-machine.mjs` (packaged onboarding gate) must expect
  the onboarding step id `profiles` instead of `model`, and the review copy
  "Review your profiles" instead of the model-step copy.
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

Status: planned.

Changed: `onboarding/ProfilesStep.tsx` (new) replaces `ModelStep.tsx`;
`FirstRunFlow.tsx` steps are provider → profiles → project; `setup-model.ts`
tracks profile readiness instead of a default model.
Tests: `test/onboarding/profiles-step.test.tsx`, `setup-model.test.ts`.

## M22-T8 · Composer, status line, fleet, logs

Status: planned.

Changed: `model-selector.tsx` (profile list + effective model + pin),
`reasoning-effort.tsx`, `thread/StatusLine.tsx`, `store.ts` (profile state,
"moved to" copy, seeded notification), `runtime/LaserProvider.tsx` (setProfile /
pinModel actions), `fleet/model.ts` + `row.ts` + `FleetPanel.tsx`
(profile column, substituted profile), `runtime/threadList.ts`,
`mobile/MobileSurfaces.tsx`, `logs/ApiRequestDialog.tsx`.

## M22-T9 · Agents page and CLI

Status: planned.

Changed: `agents/page/{model.ts,BuiltinPanel.tsx,dialogs.tsx,AgentEditor*.tsx}`,
`beam/{BeamModelDialog.tsx,beam-model.ts}`, `agents/actions.ts`;
CLI `commands/{doctor,runs,session}.ts`.
