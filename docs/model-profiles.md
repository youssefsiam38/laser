# Model profiles

Status: **binding design for M22** (`PLAN.md` "M22 · Model profiles"; decision
D-346). A companion contract of
[`project-lifecycle-leap.md`](project-lifecycle-leap.md), the root source of
truth for the leap; it is indexed there under "Companion contracts". Supersedes [`model-fallback-chains.md`](model-fallback-chains.md),
which stays as the record of the M15-T3 runtime this milestone reuses. Read
[`AGENTS.md`](../AGENTS.md) invariants 1, 3, 4 and 6, and
[`architecture.md`](architecture.md) first.

## The idea in one paragraph

Laser has one model-routing concept: a **Model Profile**. A profile is a
person-named, ordered list of connected models. The first model is the one the
profile prefers; the rest are what it falls back to, in order, when the model
in use stops being reachable. Every place that used to choose a *model* —
Settings defaults, onboarding, the composer, agents, built-ins, session naming,
consultation — chooses a *profile*. A session, an agent, a naming request all
carry a profile id as durable intent and record the model that actually
answered as evidence. There is no separate "fallback chain" entity, no "tier"
entity and no fixed number of profiles.

## Domain

```text
ModelProfile
  id            opaque, stable; survives rename (mp_<ulid>)
  name          1–40 chars, unique case-insensitively among profiles
  description   0–200 chars, optional
  models[]      1–12 entries, ordered, no duplicates
    provider    provider id
    id          model id
    thinking?   ThinkingLevel; absent = the model's default
  origin        "seeded" | "person"
  updatedAt     ISO time of last edit (history, not identity)
```

- Laser seeds three editable profiles on first run and on an empty-profile
  migration: **Smart**, **Balanced**, **Fast**. They are ordinary profiles:
  renamable, reorderable, deletable once nothing references them.
- A person may create any number of profiles up to a large bound
  (`MAX_MODEL_PROFILES = 200`); the bound exists for storage and UI sanity,
  not as a product tier.
- A model may appear in any number of profiles. Only connected, enabled models
  are offered when editing; a profile whose model is no longer connected keeps
  the entry and shows it as unavailable.
- Profiles are **global** (one settings file), never per project. A project can
  choose which global profile a surface uses, never define its own models.

## Assignments

Every surface that selects a model holds a **profile id**, never a raw model,
except the explicit per-session override below.

| Surface | Setting | Default |
| --- | --- | --- |
| New sessions in a project or projectless chat | `defaultProfileId` | Balanced |
| Session naming (title generation) | `namingProfileId` | Fast |
| Fresh-context consultation (Ask Oracle, when it lands) | `oracleProfileId` | Smart |
| Design Index synthesis and Foundation proposals (`design-phase.md`) | `designIndexProfileId` | Smart |
| Each agent definition | `profile:` in the agent file | inherit `defaultProfileId` |
| Built-in agents while they exist | per-built-in profile choice | Balanced / Balanced / Fast |

Rules:

- Deleting a profile that is referenced anywhere requires choosing a
  replacement in the same dialog; the delete never leaves a dangling id.
- Renaming never changes an id; assignments do not break.
- An agent file that names an unknown profile validates with a warning on the
  `profile` field and runs on `defaultProfileId`; the fleet row shows the
  substitution.

## Per-session override

The composer's model control shows the session's **profile** and, beneath it,
the **model actually in use**. Choosing a different profile re-anchors the
session to that profile's first model. Choosing a specific model instead pins
the session to that one model with **no fallback** and the control says so
("Pinned · no fallback"). Pinning is a session-level, deliberate escape hatch;
it does not create a profile and is never the default path.

## Runtime

The M15-T3 controller is kept; its unit of activation changes from *the chain
whose first model equals the selected model* to *the session's profile*.

- A session starts on its profile's first available model. If the first is
  unavailable at start (no credentials, disabled), the start walks the profile
  in order and records the skip, exactly as an activation would.
- Fallback moves only within the session's profile. It never crosses to another
  profile: a different profile is a different intent, not a spare model.
- Eligibility, retry ordering, cooldowns, single bounded return attempts,
  compaction-before-rejecting (M15-T8), task continuity, fencing on manual
  change and the persisted `lasercode/fallback` session entry all stay as
  `model-fallback-chains.md` §3–§6 specify, with `chainKey` replaced by
  `profileId` plus the profile's model list snapshot at activation.
- Editing a profile does not disturb a running turn. The new list applies at
  the next activation; a session on a model that was removed stays on it until
  the next failure, then falls back using the new list.
- Naming and consultation requests are one-shot: they walk the profile once,
  with the same eligibility classes, and fail with a person-readable reason
  when the profile is exhausted. They never create a session or a fleet row.

## What a person sees

- Settings → Providers and models → **Model profiles**: list, add, duplicate,
  rename, reorder models, remove, and a "used by" line per profile (sessions
  default, naming, consultation, N agents).
- Onboarding: connect a provider → **review the three seeded profiles** with
  models pre-filled from what just connected → add a project. A person may
  edit or skip; skipping leaves the seeds.
- Composer and status line: profile name, effective model, a fallback badge
  while switched, and the M15-T3 transcript record on every transition.
- Fleet, session list, logs and usage: the profile as the intent column and
  the effective model as the evidence column; usage totals stay per model.
- Copy never says "chain", "tier" or "fallback chain". The word for the ordered
  list is the profile; the word for a switch is "moved to".

## Migration (one-way, previewed, SettingsManager only)

Read from the global settings file:

| Old key | New meaning |
| --- | --- |
| `fallbackChains[]` | each old list becomes a profile named after the model it prefers — **“Sonnet profile”**, never “Sonnet chain”: the migration is where the old word would otherwise survive in a person's own data (D-e) — editable, `origin: "person"` |
| `defaultProvider` + `defaultModel` | a profile that starts with that model becomes `defaultProfileId`; if none exists, a profile `"Default"` is created with that single model |
| `defaultThinkingLevel`, `modelThinkingLevels` | folded into the matching profile entries' `thinking` |
| built-in `beamModel` / `chatModel` / `namerModel` | each becomes that built-in's profile: an existing profile starting with the model, else a new single-model profile named after the built-in |
| agent file `model: provider/id` | rewritten to `profile:` naming the profile that starts with that model, else a new single-model profile named after the agent; the rewrite is recorded per file |

- Migration runs once at host start, writes a preview record to the state
  directory, and is idempotent. The old keys are left in place until the
  release after M22 (D-346), so a rollback of the app reads them unchanged.
- Existing sessions keep `model` + `thinkingLevel` and have no profile; they
  display as pinned. Their persisted `lasercode/fallback` entries keyed by
  `chainKey` are read for history and never re-activated.
- If no profiles exist after migration, the three seeds are created from the
  connected models using the same suggestion rule onboarding uses.

## Bounds and policy

- `MAX_MODEL_PROFILES = 200`, `MAX_PROFILE_MODELS = 12`, name ≤ 40, description ≤ 200.
- Methods: `models/profiles/list` (read, any reach), `models/profiles/save`,
  `models/profiles/delete` (settings scope), `session/profile/set` and
  `session/model/pin` (session_write). Every method has a closed Zod schema, a
  round-trip sample and a method-policy row.
- The protocol carries no Pi vocabulary; profiles are a Laser concept written
  to the product-owned `modelProfiles` key of the global settings file through
  `SettingsManager` only.

## Breaking change — affected areas

This change breaks the settings shape, the protocol, the agent file format and
every model-choosing surface. The list below is the inventory M22 must clear;
a task that touches an area not listed here adds it to this table first.

**Status — the inventory is cleared.** Every row below landed in M22-T1–T10
(commits `e692e4b9` … `1a1efdcd`); the only thing still open is the release
itself, which is not code. The mark in the first cell says how:

| Mark | Means |
| --- | --- |
| ✓ | landed as written here |
| ≠ | landed, deliberately differently; the cell says how and why |
| ○ | not done, and named as open |

### Protocol (`packages/protocol`)

| Area | Today | After |
| --- | --- | --- |
| ✓ `src/fallback.ts` | `FallbackChain`, `FallbackModelRef`, `FALLBACK_CHAINS_SETTING`, `chainFor`, `validateFallbackChains`, `MAX_FALLBACK_CHAINS` | `ModelProfile`, `MODEL_PROFILES_SETTING`, `profileById`, `validateModelProfiles`, bounds above; `FallbackActivation.chainKey` → `profileId` + snapshot |
| ✓ `src/messages.ts` | `SessionState.model: ModelRef`, `SessionFallbackSummary`, `model_fallback` notice, settings `defaultModel`/`defaultProvider`/`defaultThinkingLevel` | `SessionState.profile: { id, name } | null` plus `model` as effective; summary keyed by profile; new `defaultProfileId`, `namingProfileId`, `oracleProfileId`. `designIndexProfileId` landed with them, and `SessionState.pinned` says a conversation has nothing to move to |
| ≠ `src/agents.ts` | `AgentModelChoice`, `AgentDefinition.model`, `agents/builtin/set-model`, `agents/beam/choose-model`, `agents/namer/qualify` | `AgentDefinition.profileId`, `agents/builtin/set-profile`; first-provider prompt offers seeded profiles; Namer qualification is replaced by the naming profile. **Differently:** the qualification method was dropped, not repurposed — `agents/namer/qualify`, `NamerState` and `BeamState` are gone, and `agents/beam/choose-model` became the host notification `models/profiles/seeded` (a review of what Laser filled in, with nothing pending) |
| ✓ `src/schemas.ts` | Zod for the above | closed schemas for profiles, assignments, `session/profile/set`, `session/model/pin` |
| ≠ `src/method-policy.ts` | rows for `agents/builtin/set-model`, `agents/namer/qualify`, `pi/model/set` | rows for the new methods; `pi/model/set` becomes the pin path. **Differently:** a fifth method was needed — `models/profiles/migrate` (settings scope, native reach, host → worker), because only the worker writes the global settings file |
| ✓ `src/telemetry.ts` | per-model usage lines | per-model lines unchanged; run/session attribution gains `profileId` |
| ≠ `src/pi-extension.ts` | `ProviderRequestContext` carried provider, model and API | gains `profileId`, stamped by the worker (which holds the activation), so the logs inspector attributes a captured request to the profile that was in force. **Added by this rule:** the row did not exist when the inventory was written |

### Worker (`packages/worker`)

| Area | Change |
| --- | --- |
| ✓ `src/settings.ts` | descriptors for `defaultModel`, `defaultThinkingLevel`, `modelThinkingLevels`, the "Fallback chains" field, `readFallbackChains`, the product-owned validation hook → profile descriptors, `readModelProfiles`, profile validation, migration entry point |
| ✓ `src/fallback/{controller,policy,engine-port,state}.ts` | activation keyed by profile; start-time walk; edit-during-run rule; `lasercode/fallback` entry gains `profileId`, still reads `chainKey` entries for history |
| ✓ `src/drivers/stable-sdk.ts` | session start resolves profile → first available model; `setModel` becomes pin; `setProfile` added; it also stamps the active profile on every captured provider request |
| ✓ `src/drivers/chord.ts` | `SessionDriver` interface gains `setProfile`; stub keeps compiling; seam test updated |
| ≠ `src/agents/{definitions,session-config,harness}.ts` | agent profile resolution, inherit rule, unknown-profile warning, `start_agent` child inherits or names a profile. **Differently:** resolution lives in `definitions.ts`, `harness.ts` and the worker server's `resolveAgentProfile`; `session-config.ts` needed no change. A child whose profile is gone is no longer refused — it runs on `defaultProfileId` and carries `substitutedProfile` |
| ≠ `src/agents/namer.ts`, `src/first-turn.ts` | naming becomes a one-shot walk of `namingProfileId`; Namer model choice and qualification removed from this path. **Differently:** `namer.ts` was rewritten and the profile is resolved in the worker server (`namingProfile()`, Namer's own choice first, then the assignment); `first-turn.ts` itself needed no change, and its suite pins the new path. With neither assignment set, naming is off rather than falling through to the profile new conversations use |
| ✓ `src/thinking-level` handling | thinking comes from the profile entry, then the model default |
| ✓ `packages/pi-extension/src/modules/account-usage.ts` | unchanged data; label copy reviewed and already clean |
| ✓ tests | `fallback/*.test.ts`, `settings.test.ts`, `thinking-level.test.ts`, `agents/stable-sdk.agent.test.ts` rewritten around profiles; `profiles/migrate.test.ts`, `agents/session-naming.test.ts` and the seam suite added or rewritten |

### Host (`packages/host`)

| Area | Change |
| --- | --- |
| ✓ `src/agents/builtins.ts` | `beamModel`/`chatModel`/`namerModel` → profile ids; seeded defaults |
| ≠ `src/agents/{store,validate,agent-file,agent-files-watch}.ts` | `model:` frontmatter → `profile:`; validation warning field `profile`. **Differently:** there is no one-time rewrite of a person's files. `model:` is simply no longer a frontmatter field, so a hand-written file that still carries it says “Remove the unknown frontmatter field ‘model’” — which is how a person learns the format changed — and the migration record lists each definition's resulting profile instead of a per-file before/after |
| ≠ `src/router.ts`, `src/server.ts` | new methods, removed methods, migration at start, the seeded-profile review. **Differently:** `worker-client.ts` needed no change (the migration is an ordinary request), and the review is the `models/profiles/seeded` notification: offered once per host run, applied never — a built-in with no choice of its own takes the matching assignment at the same moment |
| ≠ `src/catalog.ts`, `src/session-projection.ts` | session rows expose profile intent and effective model. **Differently:** only `catalog.ts` changed — it reads `SessionSummary.profileId` from the session's durable activation entry. `session-projection.ts` carries no model attribution at all, so it had nothing to add |

### UI (`packages/ui`)

| Area | Change |
| --- | --- |
| ✓ `settings/fallback/FallbackChainsTab.tsx` | replaced by `components/settings/models/ModelProfilesTab.tsx` (list, edit, duplicate, used-by, delete-with-replacement). Global scope only: read-only under Project and Effective, and it says why |
| ✓ `settings/ModelsTab.tsx`, `settings/SettingsForm.tsx` | default model/thinking fields → default, naming and consultation profile pickers, written at global scope |
| ≠ `onboarding/{FirstRunFlow,ModelStep,ProviderStep}.tsx` | "pick a model" step → "review your profiles" step with pre-filled seeds. **Differently:** `ModelStep.tsx` was removed rather than rewritten (`ProfilesStep.tsx` replaces it) and `ProviderStep.tsx` needed no change |
| ✓ `assistant-ui/elements/model-selector.tsx`, `reasoning-effort.tsx` | profile list, effective model, pin action, pinned state; the shared profile reads live in the new `elements/model-profiles.tsx` |
| ≠ `thread/StatusLine.tsx`, `thread/Composer.tsx` | badge copy "moved to"; pinned copy. **Differently:** the composer's own file needed no change — its model control is `model-selector.tsx`, which carries the profile line and "Pinned · no fallback" |
| ≠ `agents/page/{AgentsEditorColumn,BuiltinPanel,dialogs,model}.tsx` | model pickers → profile pickers; unknown-profile warning. **Differently:** the edited files are `AgentEditor.tsx`, `AgentEditorFields.tsx`, `AgentEditorResources.tsx`, `BuiltinPanel.tsx`, `dialogs.tsx` and `page/model.ts` |
| ✓ `beam/{BeamModelDialog,beam-model}.ts(x)` | both removed; `BeamProfileDialog.tsx` is the Beam profile choice until Beam itself goes (M23) |
| ≠ `fleet/model.ts`, `fleet/FleetPanel.tsx`, `shell/model.ts`, `runtime/threadList.ts`, `mobile/MobileSurfaces.tsx` | profile + effective model columns; phone picker. **Differently:** `fleet/{model,row}.ts`, `FleetPanel.tsx`, `FleetWorkRow.tsx`, the new `fleet/profile-names.tsx`, `shell/Shell.tsx` and `thread-list.aui.tsx` carry it; `shell/model.ts`, `runtime/threadList.ts` and `mobile/MobileSurfaces.tsx` needed no change, because the phone uses the same composer control as every other width |
| ✓ `logs/ApiRequestDialog.tsx`, usage views | profile attribution beside the model: the request dialog's spec sheet names the profile above provider and model (“Pinned or not recorded” when there is none), and the usage views attribute per-model lines to it |
| ✓ `store.ts`, `runtime/LaserProvider.tsx` | profile state, methods, reconcile |
| ✓ tests | `settings/fallback-chains.test.tsx` and `thread/fallback-chain-badge.test.tsx` deleted; `settings/model-profiles.test.tsx`, `settings/profile-usage.test.ts`, `thread/profile-{selector,status-line,move-record}`, `onboarding/profiles-step.test.tsx`, `beam/profile-dialog.test.tsx` and `logs/request-dialog.test.tsx` cover the replacements |

### CLI (`packages/cli`)

| Area | Change |
| --- | --- |
| ✓ `commands/doctor.ts` | auth check walks every model of every profile and names the profile in its report |
| ✓ `commands/{runs,session}.ts` | output shows profile and effective model |

### Persistence and migration

| Store | Change |
| --- | --- |
| ✓ Global settings file | `modelProfiles`, `defaultProfileId`, `namingProfileId`, `oracleProfileId` and `designIndexProfileId` written; old keys kept one release and read by the migration alone |
| ≠ Host state (built-in choices, onboarding state) | built-in model choices → profile ids (`builtinProfiles` in `agents.json`). **Differently:** “first provider connected, Beam has no model” did not become “no profile” — there is no pending state at all. The host offers the seeded profiles for review once and gives a built-in with no choice the matching assignment |
| ≠ Agent files (global and `.laser/agents`) | `profile:` is the field; a person's files are **not** rewritten. `model:` is an unknown field now and says so on the definition, so nobody's authored file is edited underneath them |
| ≠ Session JSONL | untouched for existing sessions; the durable `lasercode/fallback` entry carries `profileId`. **Differently:** no field was added to the session header — the catalog reads a conversation's profile from that activation entry, so there is one writer and one truth |
| ✓ Migration preview record | written under the state directory; idempotent |

### Documents and gates

| Item | Change |
| --- | --- |
| ✓ `docs/model-fallback-chains.md` | superseded banner; kept as runtime record |
| ✓ `docs/agents.md`, `docs/product-boundary.md`, `docs/settings-scope-audit.md`, `docs/architecture.md`, `docs/ux-fleet.md`, `docs/mobile.md` | model → profile vocabulary and ownership (M22-T10): agent `profile:` frontmatter and built-in profile choice, the settings keys and their owner, the Global-only scope of profiles, the protocol family, and the profile-as-intent / model-as-evidence rule for rows and pickers |
| ✓ `pnpm identity:check` | check 3 fails the build on "chain", "tier" and "fallback chain" in string literals under `packages/{ui,cli,host,worker,desktop}/src`, with a named exemption list for uses that are not about models |
| ≠ `clean-machine.mjs` packaged gate | the gate's scratch settings now hold `modelProfiles` plus `defaultProfileId` and `namingProfileId` instead of a default provider and model, so the packaged app starts on a profile the way a fresh install does. **Differently:** the gate asserts the settings a completed profile review leaves behind; walking the review itself in a browser is the person's acceptance, not an agent's (`AGENTS.md`) |
| ○ Release | ships as its own minor release with migration notes; invariant 10 holds because host, worker and UI move together. Open: the release itself is not part of M22 |

### Dependents that consume profiles (separate milestones)

- Removing Beam, Chat and Namer as built-in agents: Chat becomes a plain
  session on `defaultProfileId`; naming on `namingProfileId`; Beam's dialog
  goes with Beam.
- Ask Oracle consumes `oracleProfileId`.
- M21 model tools inherit the calling session's profile.
