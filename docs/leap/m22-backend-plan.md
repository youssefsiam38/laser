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

### M22-T2 checkpoint — done

Changed: `protocol/src/fallback.ts` (seeding rule, migration record,
`models/profiles/migrate`), `protocol/src/{schemas,method-policy}.ts`,
`worker/src/settings.ts` (`readModelProfiles`, `readProfileSettings`,
`readProfileAssignments`, `resolveProfile`, descriptors, validation),
`worker/src/profiles/{migrate,seeds}.ts`, `worker/src/packages.ts` (catalogue
carries profiles and assignments; per-model thinking comes from profile
entries), plus the mechanical rename the package needs to compile
(`fallback/*`, `drivers/*`, `driver.ts`, `agents/*`, `server.ts`) and every
test that named a chain, a default model or a Namer model.

Surprise, recorded as a decision: the whole worker had to move in this commit,
because `AgentDefinition.model` and `FallbackChain` are gone from the protocol
and the package does not compile without it. T3 and T4 carry the behaviour
that is genuinely theirs (start-time walk, pin, `setProfile` seam, agent
inheritance, one-shot naming) and their own tests.

Two more decisions the contract was silent on:

- **D-e** Profiles named after a saved list are `"<Model> profile"`, not the
  `"Sonnet chain"` example in the contract: the same document forbids the word
  "chain" on a person-facing surface, and a profile name is one.
- **D-f** Naming runs only on an explicit `namingProfileId` (or the built-in's
  own choice). Falling through to the profile new sessions use would spend the
  person's best model on titles, which is the opposite of the assignment's
  purpose. The migration and the seeds always set it.

Green: `pnpm -F @lasercode/worker test` (1208 passed, 4 skipped),
`pnpm -F @lasercode/protocol test`, `pnpm identity:check`.

### M22-T3 checkpoint — done

The runtime moved with T2 (the package would not compile otherwise); this
commit carries the parts that are T3's own and the tests that prove them:

- `SessionDriver.setProfile` is on the seam, and the Chord stub fails closed on
  both model paths (`test/seam.test.ts`).
- The start-time walk records every model it passed over, moves the position,
  writes one `activated` record and emits one update whose copy never says
  "chain" (`test/fallback/activation.test.ts`).
- Editing a profile does not disturb a running conversation: the activation
  snapshot is never re-read, and the edit lands at the next activation.
- A pin clears the activation and writes `cleared`; a profile choice writes
  `activated`; a pre-M22 `chainKey` activation reads back as history and never
  re-activates.

Re-run of the M15-T3/T8 verification list (`STATUS_DETAILED.md` M15-T3 notes,
"Verification"): `test/fallback/{policy,activation,compact,engine}.test.ts`
130 passed together with the seam, thinking-level and first-turn suites;
whole worker suite 1211 passed / 4 skipped. Live browser verification belongs
to the person (AGENTS.md) and is not claimed here.

### M22-T4 checkpoint — done

- Agent definition files carry `profile:` (an opaque profile id) instead of
  `model:`; `model:` is now an unknown frontmatter field, which is how a person
  learns the format changed.
- `null` and an absent field both mean "inherit the profile new conversations
  use". An id that is not one this app generated is a save-time issue on the
  `profile` field; an id that *was* generated but no longer answers to anything
  is a **warning** on the same field, raised by the periodic check, and the
  agent keeps working on the default.
- `start_agent` no longer refuses a child whose profile is gone: the run starts
  on the default and carries `substitutedProfile` so the fleet row can say so.
  `AgentRun` also carries `profileId` beside the model that answered.
- Built-ins hold profile ids (`builtinProfiles` on the snapshot, persisted);
  `replaceBuiltinProfile` moves every reference in one write.
- Naming is a one-shot walk of the naming profile: one request per model, in
  order, first usable title wins, no benchmark and no qualification. When the
  whole profile is spent the words are parked, so the conversation is named the
  moment naming becomes possible.

Green (clean environment — see the note below):
`pnpm -F @lasercode/host test` 1012 passed, `pnpm -F @lasercode/worker test`
1211 passed / 4 skipped.

**Environment note.** The host suite spawns child workers, and this agent
session runs inside Laser, so `LASERCODE_FEATURE_GENERATION_ID` and
`LASERCODE_RUNTIME_*` are in the environment; `WorkerClient` reads them and
faults every spawn with "could not verify the project runtime". It is not a
product defect and not caused by M22 — the host tests must be run with those
variables unset (`env -i PATH=… HOME=… pnpm -F @lasercode/host test`).

### M22-T5 checkpoint — done

- `models/profiles/{list,save,delete}` are answered by the host, which picks a
  worker (the only writer of the global settings file) and owns the two
  decisions a worker cannot make: which definitions point at a profile, and
  what happens to them when one is deleted.
- **Delete-with-replacement is enforced server-side.** A profile an agent
  definition or a built-in still uses is refused without a `replacementId`, and
  nothing is asked of the worker in that case, so nothing is written. With a
  replacement, the worker moves the assignments first and the host then moves
  the built-ins and the definitions; no path leaves a dangling id.
- The one-way migration runs once per host run behind the first real worker
  (`models/profiles/migrate`, host → worker, `native` reach), writes the
  preview record to `<stateDir>/model-profiles-migration.json`, and gives each
  built-in that has made no choice the matching assignment.
- The first-provider prompt is now `models/profiles/seeded`, carrying the
  seeded profiles for review; `agents/beam/choose-model` is gone.
- Catalog rows expose the intent and the evidence without opening a session:
  `SessionSummary.profileId` from the last activation record and
  `SessionSummary.model` from the last `model_change`, both read by the scan
  the catalog already runs.

### Decisions needed / left open

- **D-g** "Session projection exposes profile + effective model" is satisfied
  by the catalog scan above and by `SessionState.profile` / `AgentRun.profileId`.
  `session-projection.ts` plans history pages and carries no model attribution
  at all, so there was nothing there to extend.
