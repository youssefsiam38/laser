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
| `fallbackChains[]` | each chain becomes a profile named after its first model (`"Sonnet chain"` style, editable), `origin: "person"` |
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

### Protocol (`packages/protocol`)

| Area | Today | After |
| --- | --- | --- |
| `src/fallback.ts` | `FallbackChain`, `FallbackModelRef`, `FALLBACK_CHAINS_SETTING`, `chainFor`, `validateFallbackChains`, `MAX_FALLBACK_CHAINS` | `ModelProfile`, `MODEL_PROFILES_SETTING`, `profileById`, `validateModelProfiles`, bounds above; `FallbackActivation.chainKey` → `profileId` + snapshot |
| `src/messages.ts` | `SessionState.model: ModelRef`, `SessionFallbackSummary`, `model_fallback` notice, settings `defaultModel`/`defaultProvider`/`defaultThinkingLevel` | `SessionState.profile: { id, name } | null` plus `model` as effective; summary keyed by profile; new `defaultProfileId`, `namingProfileId`, `oracleProfileId` |
| `src/agents.ts` | `AgentModelChoice`, `AgentDefinition.model`, `agents/builtin/set-model`, `agents/beam/choose-model`, `agents/namer/qualify` | `AgentDefinition.profileId`, `agents/builtin/set-profile`; first-provider prompt offers seeded profiles; Namer qualification is replaced by the Fast profile (drop or repurpose the method) |
| `src/schemas.ts` | Zod for the above | closed schemas for profiles, assignments, `session/profile/set`, `session/model/pin` |
| `src/method-policy.ts` | rows for `agents/builtin/set-model`, `agents/namer/qualify`, `pi/model/set` | rows for the new methods; `pi/model/set` becomes the pin path |
| `src/telemetry.ts` | per-model usage lines | per-model lines unchanged; run/session attribution gains `profileId` |

### Worker (`packages/worker`)

| Area | Change |
| --- | --- |
| `src/settings.ts` | descriptors for `defaultModel`, `defaultThinkingLevel`, `modelThinkingLevels`, the "Fallback chains" field, `readFallbackChains`, the product-owned validation hook → profile descriptors, `readModelProfiles`, profile validation, migration entry point |
| `src/fallback/{controller,policy,engine-port,state}.ts` | activation keyed by profile; start-time walk; edit-during-run rule; `lasercode/fallback` entry gains `profileId`, still reads `chainKey` entries for history |
| `src/drivers/stable-sdk.ts` | session start resolves profile → first available model; `setModel` becomes pin; `setProfile` added |
| `src/drivers/chord.ts` | `SessionDriver` interface gains `setProfile`; stub keeps compiling; seam test updated |
| `src/agents/{definitions,session-config,harness}.ts` | agent profile resolution, inherit rule, unknown-profile warning, `start_agent` child inherits or names a profile |
| `src/agents/namer.ts`, `src/first-turn.ts` | naming becomes a one-shot walk of `namingProfileId`; Namer model choice and qualification removed from this path |
| `src/thinking-level` handling | thinking comes from the profile entry, then the model default |
| `packages/pi-extension/src/modules/account-usage.ts` | unchanged data; label copy reviewed for "chain" |
| tests | `fallback/*.test.ts`, `settings.test.ts`, `thinking-level.test.ts`, `agents/stable-sdk.agent.test.ts` rewritten around profiles; migration fixtures added |

### Host (`packages/host`)

| Area | Change |
| --- | --- |
| `src/agents/builtins.ts` | `beamModel`/`chatModel`/`namerModel` → profile ids; seeded defaults |
| `src/agents/{store,validate,agent-file,agent-files-watch}.ts` | `model:` frontmatter → `profile:`; validation warning field `profile`; one-time rewrite with per-file record |
| `src/router.ts`, `src/server.ts`, `src/worker-client.ts` | new methods, removed methods, migration at start, first-provider profile prompt |
| `src/catalog.ts`, `src/session-projection.ts` | session rows expose profile intent and effective model |

### UI (`packages/ui`)

| Area | Change |
| --- | --- |
| `settings/fallback/FallbackChainsTab.tsx` | replaced by `settings/models/ModelProfilesTab.tsx` (list, edit, duplicate, used-by, delete-with-replacement) |
| `settings/ModelsTab.tsx`, `settings/SettingsForm.tsx` | default model/thinking fields → default, naming and consultation profile pickers |
| `onboarding/{FirstRunFlow,ModelStep,ProviderStep}.tsx` | "pick a model" step → "review your profiles" step with pre-filled seeds |
| `assistant-ui/elements/model-selector.tsx`, `reasoning-effort.tsx` | profile list, effective model, pin action, pinned state |
| `thread/StatusLine.tsx`, `thread/Composer.tsx` | badge copy "moved to"; pinned copy |
| `agents/page/{AgentsEditorColumn,BuiltinPanel,dialogs,model}.tsx` | model pickers → profile pickers; unknown-profile warning |
| `beam/{BeamModelDialog,beam-model}.ts(x)` | Beam profile choice (or removed with Beam) |
| `fleet/model.ts`, `fleet/FleetPanel.tsx`, `shell/model.ts`, `runtime/threadList.ts`, `mobile/MobileSurfaces.tsx` | profile + effective model columns; phone picker |
| `logs/ApiRequestDialog.tsx`, usage views | profile attribution beside the model |
| `store.ts`, `runtime/LaserProvider.tsx` | profile state, methods, reconcile |
| tests | `settings/fallback-chains.test.tsx`, `thread/fallback-chain-badge.test.tsx` replaced; onboarding, selector, agents-page tests updated |

### CLI (`packages/cli`)

| Area | Change |
| --- | --- |
| `commands/doctor.ts` | auth check walks every model of every profile and names the profile in its report |
| `commands/{runs,session}.ts` | output shows profile and effective model |

### Persistence and migration

| Store | Change |
| --- | --- |
| Global settings file | `modelProfiles`, `defaultProfileId`, `namingProfileId`, `oracleProfileId` written; old keys kept one release |
| Host state (built-in choices, onboarding state) | built-in model choices → profile ids; "first provider connected, Beam has no model" → "no profile" |
| Agent files (global and `.laser/agents`) | `model:` → `profile:` rewrite |
| Session JSONL | untouched for existing sessions; new sessions record `profileId` on the session entry; fallback entries carry `profileId` |
| Migration preview record | written under the state directory; idempotent |

### Documents and gates

| Item | Change |
| --- | --- |
| `docs/model-fallback-chains.md` | superseded banner; kept as runtime record |
| `docs/agents.md`, `docs/product-boundary.md`, `docs/settings-scope-audit.md`, `docs/architecture.md`, `docs/ux-fleet.md`, `docs/mobile.md` | model → profile vocabulary and ownership |
| `pnpm identity:check` | copy guard for "chain"/"tier" on person surfaces |
| `clean-machine.mjs` packaged gate | onboarding path through the profile step |
| Release | ships as its own minor release with migration notes; invariant 10 holds because host, worker and UI move together |

### Dependents that consume profiles (separate milestones)

- Removing Beam, Chat and Namer as built-in agents: Chat becomes a plain
  session on `defaultProfileId`; naming on `namingProfileId`; Beam's dialog
  goes with Beam.
- Ask Oracle consumes `oracleProfileId`.
- M21 model tools inherit the calling session's profile.
