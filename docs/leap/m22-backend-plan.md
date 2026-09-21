# M22 backend plan (protocol → worker → host)

Owner: worker agent "Model profiles backend", branch
`agents/model-profiles-backend-819b3a73`. Contract: `docs/model-profiles.md`,
`PLAN.md` "M22 · Model profiles", decision D-346. Backend half only:
M22-T1 → M22-T5. `packages/ui` and `packages/cli` belong to another owner and
are deliberately left red where the protocol rename reaches them.

## M22-T1 · Protocol

1. `src/fallback.ts` keeps the runtime record and gains the profile domain:
   `ModelProfile`, `ProfileModelRef`, `MODEL_PROFILES_SETTING`, `profileById`,
   `validateModelProfiles`, `readModelProfilesValue`, bounds.
2. `FallbackActivation.chainKey` → `profileId`; snapshot entries carry `thinking`.
3. `SessionState` gains `profile: { id, name } | null` and `pinned`;
   `model` stays as the effective model; summary keyed by profile.
4. Assignment settings constants: default / naming / oracle / design index.
5. `AgentDefinition.model` → `profileId`; `AgentModelChoice`, `NamerState`,
   `BeamState`, `ChatState` removed; `builtinProfiles` on the snapshot.
6. New methods `models/profiles/{list,save,delete}`, `session/profile/set`,
   `session/model/pin`; removed `agents/builtin/set-model`,
   `agents/namer/qualify`, notification `agents/beam/choose-model`.
7. Closed Zod schemas + method-policy rows + transport-pressure row for the
   replacement notification `models/profiles/seeded`.
8. `pi/model/set` documented as the pin path (code comment + policy comment).
9. Telemetry `TelemetryModel.profileId`; `AgentRun.profileId`.
10. Evidence: `pnpm -F @lasercode/protocol build && test`.

### Decisions taken (contract was silent)

- **D-a** The activation snapshot stores `profileId` only, no profile name. The
  name is resolved from settings at read time; a profile that disappeared makes
  the session display as pinned, which is what a session without a profile is.
- **D-b** `session/model/pin` is the explicit pin method; `pi/model/set` keeps
  its row and now means the same thing (documented in both places) so an older
  client's model change pins rather than silently re-anchoring a profile.
- **D-c** The first-provider prompt notification `agents/beam/choose-model`
  becomes `models/profiles/seeded` — it is no longer about an agent.
- **D-d** `AgentsSnapshot.namer/beam/chat` collapse into
  `builtinProfiles: { beam, chat, namer }` (profile ids). Namer qualification,
  its candidates and Beam's suggestion state are deleted, not repurposed.

## M22-T2 · Worker settings, migration and seeds

1. `readModelProfiles(agentDir)` over the global file only, like chains were.
2. Descriptors: `modelProfiles` + the four assignment ids replace
   `defaultModel`/`defaultProvider`/`defaultThinkingLevel`/`modelThinkingLevels`
   and the "Fallback chains" field in the product catalogue.
3. `validateSettingValue` runs `validateModelProfiles` for the product key and
   an id-exists check for the assignment keys.
4. `migrateToModelProfiles(...)` — pure planner + `SettingsManager` writer.
5. Sources: `fallbackChains`, `defaultProvider`+`defaultModel`,
   `defaultThinkingLevel`/`modelThinkingLevels`, built-in models, agent files.
6. Idempotent: a `modelProfiles` key that already exists is never rewritten;
   the preview record under the state directory is rewritten each run.
7. Old keys stay in place (D-346).
8. Seeds Smart/Balanced/Fast from connected models when nothing exists, using
   the same suggestion rule onboarding uses (`host/src/agents/models.ts`).
9. Fixtures: a 0.11 settings file, an empty file, a half-migrated file.
10. Evidence: `pnpm -F @lasercode/worker test`.

## M22-T3 · Worker runtime on profiles

1. `activate()` keyed by profile id with the profile's list as the snapshot.
2. Start-time walk: the first *available* model, recording every skip.
3. Fallback stays inside the activation; a pin clears it.
4. `lasercode/fallback` entries carry `profileId`; `chainKey` entries read back
   as history and never re-activate.
5. `SessionDriver.setProfile` on both drivers; seam test updated.
6. `setModel` becomes the pin path in the driver.
7. Thinking level comes from the profile entry, then the model default.
8. Edit-during-run: the snapshot is never re-read mid-activation.
9. Re-run the M15-T3/T8 verification list.
10. Evidence: `pnpm -F @lasercode/worker test`.

## M22-T4 · Agents and naming on profiles

1. `resolveAgentModel` → `resolveAgentProfile` (definition id, else default).
2. Unknown profile id: warning on field `profile`, runs on `defaultProfileId`.
3. The substitution is visible in fleet row data.
4. `start_agent` children inherit the parent's profile or name one.
5. Built-ins hold profile ids.
6. Naming: one-shot walk of `namingProfileId`, no qualification.
7. `namer.ts` loses the benchmark path.
8. `first-turn.ts` carries a profile, not a model.
9. Harness tests: inheritance, warning, substitution.
10. Evidence: `pnpm -F @lasercode/worker test`.

## M22-T5 · Host authority and projections

1. Route the five new methods; drop the two removed ones.
2. Migration at host start, once, with the preview record.
3. First-provider prompt offers the seeded profiles.
4. Catalog and session projection expose profile + effective model.
5. Delete-with-replacement enforced server-side.
6. Agent file `model:` → `profile:` with per-file rewrite records.
7. `builtins.ts` holds profile ids.
8. `pnpm verify` green except ui/cli rename fallout.
9. `pnpm identity:check`.
10. Evidence: commit hashes + command output in the final report.

### M22-T1 checkpoint — done

Changed: `protocol/src/{fallback,messages,agents,schemas,method-policy,transport-pressure,telemetry}.ts`,
`protocol/test/{fallback,schemas}.test.ts`.
Green: `pnpm -F @lasercode/protocol build` and `test` (464 tests, 0 type errors),
`pnpm identity:check`.
Left for T2–T5: every downstream package is red until the worker and host move.
