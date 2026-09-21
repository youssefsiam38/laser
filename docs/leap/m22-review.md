# M22 review · Model profiles

Reviewer: independent code-quality review of range `724ec0dd..4718925a`
(`work/fallback-update`; protocol `e692e4b9`, worker `717c7c33`/`ad23a25e`,
host `c4d4ec48`/`e9ba67c9`, ui/cli `14318ffa`/`69f7bf9c`/`60671df9`/`1e2c031c`/`8eb2ec03`/`00748c93`).
Contract: `docs/model-profiles.md` (binding, D-346) and the M22-T1..T9
acceptance column of `PLAN.md`. Read-only; no changes were made.

## Overall

The implementation is strong on the axes the contract cares about. The seed
rule lives once in the protocol and feeds the migration and onboarding alike;
the migration is a pure planner over a real `SettingsAdapter` write path and is
idempotent on disk (`packages/worker/test/profiles/migrate.test.ts`); the
runtime is the M15 controller with the profile as its activation unit, keeping
`chainKey` records as history that never re-activates
(`packages/worker/src/fallback/state.ts` `restoreFallbackState`); the UI has
one `useModelProfiles` hook and one `ProfilePicker` shared by settings,
onboarding, the composer, the agents page and the CLI's data path, so there is
no second implementation of what "Balanced" is. Grep checks are clean: no
`@earendil-works` import outside worker/pi-extension, no hex or raw-px values
in the new/changed `packages/ui/src` files, no "chain"/"tier" on a person
surface (only comments, the legacy `chainKey` identifier, and CLI's
unrelated "node_modules chain" diagnostic). No `as any`; protocol boundaries
are closed Zod schemas with round-trip samples.

Two migration items in the binding contract were **not** implemented, and the
migration record the person reviews papers over both. That is the substance of
this review.

## Blocking

### B1 · Pre-M22 built-in model choices are dropped, not migrated

Contract migration table: "built-in `beamModel`/`chatModel`/`namerModel` → each
becomes that built-in's profile: an existing profile starting with the model,
else a new single-model profile named after the built-in". M22-T2/T5
acceptance repeats it ("built-in models ... with a preview record").

What the code does:

- The previous generation persisted the choices in `agents.json`
  (`namer.model`, `beam.model`, `chat.model`; see
  `git show 724ec0dd:packages/host/src/agents/store.ts`, `persist()`).
- The new store reads only `builtinProfiles`
  (`packages/host/src/agents/store.ts:463`, `readBuiltinProfiles`) and the next
  `persist()` (`store.ts:587`) rewrites version 2 **without** the legacy keys —
  the person's Beam/Chat/Namer choices are destroyed on the first write after
  upgrade, with no conversion anywhere.
- `adoptSeededBuiltinProfiles` (`packages/host/src/server.ts:1230`) only fills a
  `null` with the matching *assignment* default; it never looks at the legacy
  model, so "an existing profile starting with the model" and "a new
  single-model profile named after the built-in" both never happen.
- The preview record fabricates the evidence:
  `packages/host/src/server.ts:1259` writes `builtins: [{ name, from: null, to }]`
  for every built-in on every record write, whether or not anything was
  migrated.

Fix: at migration time, read the legacy `beam`/`chat`/`namer` state from
`agents.json` (before the first persist drops it), reuse
`profileStartingWith`/seed-rule helpers to find-or-create the profile that
starts with that model, set `builtinProfiles`, and write real `from`/`to` pairs
into the record. If the choice is instead "defaults are good enough", that is a
contract amendment that must be recorded (D-346 territory) and the record must
stop claiming conversions it did not make.

### B2 · Agent files are not migrated; a legacy `model:` field breaks the file, and the record pretends otherwise

Contract migration table: "agent file `model: provider/id` → rewritten to
`profile:` naming the profile that starts with that model, else a new
single-model profile named after the agent; the rewrite is recorded per file".
M22-T5 acceptance item 6: "Agent file `model:` → `profile:` with per-file
rewrite records."

What the code does:

- `parseAgentFile` now rejects `model:` as an unknown frontmatter field
  (`packages/host/src/agents/agent-file.ts:53`) and any issue fails the whole
  parse, so a pre-M22 agent file stops loading and shows
  "Remove the unknown frontmatter field “model”" until the person hand-edits
  it. The T4 checkpoint describes this as intended ("that is how a person
  learns the format changed"), but no decision was recorded against the
  binding contract, and the contract/acceptance still require the rewrite.
- `writeMigrationRecord` (`packages/host/src/server.ts:1261-1262`) writes an
  `agentFiles` entry — `from: null` — for **every** custom agent on every
  record write, rewritten or not. The preview record cannot show what the
  migration actually changed, which is the only thing it is for.

Fix: either (a) implement the rewrite — during the migration pass, parse the
legacy `model:` key, resolve the profile that starts with it (or create a
single-model profile named after the agent), serialize `profile:`, and record
`{ path, from, to }` per changed file; or (b) record the deviation explicitly
in `docs/model-profiles.md` and the ledger as a numbered decision, make the
parser read `model:` into a *warning* (not a parse failure) with a
"choose a profile" sentence, and make `writeMigrationRecord` emit only entries
that actually changed, with real `from` values. As merged, T5's "done" carries
an unimplemented acceptance item.

## Should-fix

### S1 · The start-time walk is wired only to `setProfile`

Contract "Runtime": "A session starts on its profile's first available model.
If the first is unavailable at start (no credentials, disabled), the start
walks the profile in order and records the skip." The walk exists and is tested
(`packages/worker/src/fallback/controller.ts:246` `startWalk`,
`test/fallback/activation.test.ts`), but its only caller is `setProfile`
(`packages/worker/src/drivers/stable-sdk.ts:1394`). `open()` only activates
(`stable-sdk.ts:593`), and first-turn acceptance re-resolves position, never
walking (`stable-sdk.ts:860`). A new conversation whose profile's first model
has no credentials opens on that model; the person's first prompt fails once
and the move happens as an ordinary failover — records read `attempt_failed`
+ traversal, not the start skip the contract asks for.

Fix: call `walkProfileStart()` after open (or at first-turn acceptance, where
the code is already async and the catalogue is available). It is the same
helper `setProfile` uses.

### S2 · Delete-with-replacement can leave a dangling definition id silently

`packages/host/src/router.ts:1564-1568`: a definition whose rewrite via
`store.save(...)` throws is skipped inside an empty `catch` — no log, no
warning. The profile is already deleted (the worker moved assignments first),
so the definition now points at a profile that is gone, contradicting the
worker's own invariant sentence ("There is no path here that leaves an id
pointing at nothing", `packages/worker/src/server.ts:1891`). The periodic
`profileIds` warning (`skills-check.ts`) does eventually surface it, which is
the graceful-degradation story — but the silent catch means nobody knows the
rewrite failed when it failed. Fix: log the failure (and/or push a file
warning) in the catch; note in the comment that the two writes are not atomic
across a crash between them and name the check that sweeps the residue.

### S3 · M22-T8's "logs attribution" is deferred but not carried in the ledger

`ProviderRequestContext` (`packages/protocol/src/pi-extension.ts`) has no
`profileId`, so a captured request cannot be attributed to the profile in force
when it ran; the inspector names provider/model/API only. The deferral is
recorded in `docs/leap/m22-ui-plan.md` ("Open item for the protocol owner"),
but T8 is marked `done` in `STATUS_DETAILED.md` while its acceptance column
still reads "logs attribution", and the T10 row carries no note about it. Fix:
add the open item to the M22-T10 row so reconciliation cannot drop it.

### S4 · Old default model is skipped when profiles already exist — record the decision

`packages/worker/src/profiles/migrate.ts:114` gates
`legacyDefaultModel(doc)` behind `createdProfiles`: a half-migrated file with
person-made profiles ignores `defaultProvider`/`defaultModel` entirely. The
inline rationale (re-reading the old default would invent a profile on every
half-finished file) is sound, but it deviates from the contract table
("a profile that starts with that model becomes `defaultProfileId`; if none
exists, a profile `Default` is created") and no decision records it. Fix: one
decision line in the ledger (D-346 companion), so T11's "real 0.11 file
without loss" pass does not re-litigate it.

## Nits

- `profileNamed` (`packages/ui/src/components/assistant-ui/elements/model-profiles.tsx:400`)
  is an identity wrapper over `profileById`. Delete it and call `profileById`.
- `ModelProfilesTab.tsx` is a new 838-line file. Under the 1k bar and already
  decomposed into in-file components, but it is the growth to watch; if it
  takes Beam-removal fallout, move `DeleteProfileDialog`/`DraftCard` to
  sibling files first.
- Stale routed-method comment: `packages/host/src/router.ts:21` still lists
  `agents/namer/qualify`, which M22-T1 removed.
- Committed scratch: `docs/leap/m22-ui-red-spots.md` and
  `docs/leap/m22-ui-cli-red-spots.txt` are point-in-time tsc dumps. Delete at
  T10; they will rot.
- `useProfileNames` cache is invalidated only by this module's own
  save/delete/seed writes; a rename made by another client lingers until a
  reload. Single-user app, so minor.

## Test quality

- Migration fixtures are real: a 0.11 file, an empty file, and a half-migrated
  file, all run through the real `SettingsAdapter` with on-disk assertions,
  including idempotency (byte-identical file on the second run) and old keys
  preserved (`packages/worker/test/profiles/migrate.test.ts`).
- Host migration tests drive a real child worker over the fd-3 protocol and
  assert the written record and the once-only notification
  (`packages/host/test/agents/profiles-migration.test.ts`). Note what they do
  **not** cover: no legacy built-in model fixture, no legacy `model:` agent
  file fixture — which is how B1/B2 shipped green.
- UI tests assert behaviour (text, disabled state, refusal copy) through
  documented `data-slot` handles; no class-name-only proxy assertions found.
  The selectors/badges tests (`test/thread/profile-selector.test.tsx`,
  `profile-status-line.test.tsx`, `profile-move-record.test.ts`) replace their
  chain-era counterparts.
- Seam test covers both model paths on the stub (`test/seam.test.ts`).

## M23 outlook (Plain Chat)

- The naming prompt still lives in the Namer built-in:
  `builtinInstructions.namer` + `definitions.namerInstructions()` +
  `namerProfileId()`, `agentName: "Namer"` inside
  `packages/worker/src/agents/namer.ts` `renderInstructions`, and the
  `{{model}}`/`{{profile}}` template. Removing the built-in (M23-T2/T3) must
  re-home the editable naming prompt and its storage key, or naming loses the
  person's saved instructions. Plan this explicitly in `docs/plain-chat.md`.
- `BuiltinProfiles`/`BuiltinAgentName` plumbing is spread across
  `protocol/src/agents.ts`, `host/src/agents/{store,builtins}.ts`, the worker
  fallback definitions, and the UI (`BuiltinPanel`, `dialogs`,
  `BeamProfileDialog`, `agents/builtin/set-profile`). Wide but mechanical;
  no hidden entanglement with profiles found. `models/profiles/seeded` is
  already decoupled from Beam (D-c) — the right call.
- `readBuiltinProfiles` (`store.ts`) silently drops stored built-in ids that
  fail the pattern; M23-T3 wants a *warning* when stored data names a removed
  built-in. Keep the distinction in mind.
- `resolveProfile`/`resolveAgentProfile` and the unknown-profile warning path
  are engine-neutral and survive built-in removal unchanged.

## Verdict

Not approvable as-is. The runtime, protocol, seeds and UI halves meet their
acceptance text and the structural bar; the migration half does not (B1, B2),
and it is the half M22-T11 exists to prove on the person's real settings file.
Fix B1/B2 (or record them as explicit contract amendments with an honest
preview record) before T11; S1–S4 before or with T10.
