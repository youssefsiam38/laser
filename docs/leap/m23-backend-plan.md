# M23 backend plan (protocol → worker → host)

Owner: worker agent "Plain chat backend", branch
`agents/plain-chat-backend-67bf3cde`, base `e12c4916`. Contract:
[`docs/plain-chat.md`](../plain-chat.md), `PLAN.md` "M23 · Plain Chat",
decision D-347. Backend half only: M23-T1 → M23-T2 → M23-T3, one commit each.
`packages/ui` and `packages/cli` belong to another owner and are deliberately
left red where the protocol removal reaches them; the red spots are listed in
[`m23-ui-red-spots.md`](m23-ui-red-spots.md).

## Shape decisions (where the contract is silent)

- **D-o · `sessionKind` lives on `SessionAgentInfo`, `SessionAgentKind` keeps
  `"chat"`.** `SessionKind = "chat" | "project"` is the product concept a
  reader wants ("is this a plain conversation?"); `SessionAgentKind` stays the
  *storage* fact a catalog reads out of a session file
  (`root` | `child` | `chat`). `"beam"` leaves the union and is mapped to
  `"chat"` wherever a stored record is parsed, so an existing Beam transcript
  opens as a Chat session without its record being rewritten (history is
  evidence). One helper, `sessionKindOf(kind)`, is the only place the mapping
  is made.
- **D-p · `agentName` becomes optional** on `SessionAgentInfo` and
  `SessionAgentRecord`. A Chat session runs no definition, so naming one would
  be a lie; TypeScript strict then points at every reader that assumed one.
  New Chat records are written as `{ kind: "chat" }` with no `agentName`;
  legacy records keep whatever they say and their `agentName` is ignored.
- **D-q · the instruction-template target disappears with the built-ins.**
  With Beam, Chat and Namer gone there is exactly one kind of editable
  template — a custom agent's — so `InstructionTemplateTarget`, the per-field
  `targets` list and the `target` argument of `instructionTemplateFields`,
  `instructionTemplateIssue`, `instructionTemplateFieldRanges` and
  `renderInstructionTemplate` are removed rather than reduced to one member.
  The catalogue is the agent catalogue; the Chat prompt is a worker constant
  rendered through the same field values, not a definition anyone can edit.
- **D-r · the Namer's profile carries over through `pi/settings/set`, not a
  new method.** The host already holds `builtinProfiles.namer` (what the Namer
  built-in ran on after M22) and the legacy `namer` blob. After the M22
  migration answers, if the settings file has no `namingProfileId` and that
  carried id names a real profile, the host writes it with the ordinary
  `pi/settings/set` request it is already allowed to make. No protocol
  addition, one writer of the settings file, and naming keeps the person's
  choice.
- **D-s · the parked-first-prompt queue goes with the Namer.** `docs/plain-chat.md`
  says a naming request that cannot start simply does not run, which is the
  M18-T17 pin special case removed at its source: with no `NamerService` there
  is no "Namer unavailable" state to park against. `unnamed`, `waitToName`,
  `nameWaitingSessions` and the `namer.enabled()` gate are removed; the
  `naming` safety pin keeps its meaning (a completion is in flight right now)
  and nothing else changes about release safety.

## M23-T1 · Protocol removal and `sessionKind`

1. `agents.ts`: `AgentKind` → `"custom"`; delete `BUILTIN_AGENT_NAMES`,
   `BuiltinAgentName`, `isBuiltinAgentName`, `BuiltinInstructionOverrides`,
   `BuiltinProfiles`; `AgentsSnapshot` loses `builtinProfiles`,
   `builtinInstructions` and `workspaces.beam`; `effectiveAgents` and
   `canReferenceAgent` lose their built-in branches.
2. `SessionAgentKind` → `root | child | chat`; `SessionKind`,
   `SESSION_KINDS`, `sessionKindOf`; `SessionAgentInfo.sessionKind`;
   `agentName` optional on info and record.
3. Methods `agents/builtin/set-profile` and `agents/builtin/set-instructions`
   removed from `ClientRequests`, `schemas.ts`, `method-policy.ts` and the
   round-trip samples; `builtinAgentNameSchema` deleted.
4. `instruction-templates.ts`: Beam's six state-location fields and Namer's
   `sourceText` removed; target argument removed (D-q).
5. `startup-screen.ts` untouched — its "beam" is a drawing.
6. `session/new` gains `sessionKind?: SessionKind`: with the built-ins gone
   there is no `agentName: "chat"` to ask for a plain conversation with, and
   the two are refused together by the schema.
7. Evidence: `pnpm -F @lasercode/protocol build && test`.

### M23-T1 checkpoint — done

Changed: `protocol/src/{agents,instruction-templates,schemas,method-policy,messages,fallback,tool-label}.ts`,
`protocol/test/{agents,instruction-templates,schemas,fallback}.test.ts`.

- `AgentKind` is `"custom"`; `BUILTIN_AGENT_NAMES`, `BuiltinAgentName`,
  `isBuiltinAgentName`, `BuiltinProfiles`, `BuiltinInstructionOverrides`,
  `builtinAgentNameSchema`, `AgentsSnapshot.builtinProfiles`/
  `builtinInstructions` and `workspaces.beam` are gone, as are
  `agents/builtin/set-profile` and `agents/builtin/set-instructions` — from the
  request map, the Zod table, the method policy and the round-trip samples, so
  an old client's call is an unknown method rather than a refused one.
- `RETIRED_AGENT_NAMES` / `isRetiredAgentName` are what is left of the three
  names: the host needs them to warn about an `allowedAgents` entry (M23-T3).
- `SessionAgentInfo` carries `sessionKind` and an optional `agentName`;
  `SessionAgentKind` is `root | child | chat` and `sessionKindOf` maps a
  stored `"beam"` to `"chat"` without rewriting anything.
- The instruction-template catalogue is 12 agent fields with no target
  argument; `{{sourceText}}` and the six Beam state-location fields are now
  refused by `instructionTemplateIssue` like any other unknown field.
- `startup-screen.ts` untouched: its "beam" is a drawing.
- `session/new` takes `sessionKind`, and refuses `sessionKind: "chat"` beside
  an `agentName` on the field a person would have to change.

Green: `pnpm -F @lasercode/protocol build` (identity check + 0 type errors),
`pnpm -F @lasercode/protocol test` 466 passed, `pnpm identity:check`.
Downstream packages are red until T2/T3, as expected between commits.

## M23-T2 · Worker: chat prompt and one-shot naming

1. `agents/definitions.ts`: no `fallbackBeamAgent`, `fallbackChatAgent`,
   `fallbackNamerAgent`, no built-in branch in `sync()`; `DefinitionsCache`
   loses `namerProfileId`, `namerInstructions`, `beamProfileId`,
   `chatProfileId`.
2. `agents/session-config.ts`: `rootRole`/`rootRecord` take a session kind;
   `ensureWorkspaceSessionCwd` is Chat-only; the record parser maps `beam`.
3. `agents/instruction-templates.ts`: `CHAT_INSTRUCTION_TEMPLATE` constant;
   a session with no definition renders exactly it.
4. `agents/namer.ts` → one exported function `nameSession(text, options)`.
5. `server.ts`: naming call sites, no parking, no `namer` built-in reads.
6. `packages.ts`: Beam skill remnants.
7. Byte-for-byte prompt test; naming tests; seam test.
8. Evidence: `pnpm -F @lasercode/worker test`.

### M23-T2 checkpoint — done

Changed: `worker/src/agents/{definitions,session-config,instruction-templates,template-provenance,harness,index}.ts`,
`worker/src/agents/session-naming.ts` (new, replaces `namer.ts`),
`worker/src/{server,driver,first-turn,index,main,packages,worker-lifetime}.ts`,
`worker/src/drivers/stable-sdk.ts`, `worker/src/git-actions/prose.ts`,
`pi-extension/src/agents-bridge.ts`, `pi-extension/src/modules/subagents.ts`,
and the tests listed in the evidence below.

- **A Chat session runs no definition at all.** `DriverAgentOptions.definition`
  and `HarnessSessionRole.agentName` are optional; `session/new
  { sessionKind: "chat" }` prepares `chatRole()` / `chatRecord()` and the
  driver renders `CHAT_INSTRUCTION_TEMPLATE` —
  `{{availableTools}}\n\n{{toolGuidelines}}\n\n{{availableSkills}}` — through
  the same field values an agent gets. No core-instructions block (there is no
  definition to prepend it to), no engine default prompt, no project
  instructions, and no D-140 role block: `roleBlock` now returns nothing for a
  chat, and the delegation half was already gated on `canDelegate()`, which a
  session with no definition never has.
- **The proof is byte-for-byte.** `test/agents/chat-prompt.test.ts` runs a real
  engine turn against the stub provider and reads the instruction provenance
  recorded beside the request: the three field regions are `availableTools`,
  `toolGuidelines`, `availableSkills` in that order, the first starts at byte
  0, the last ends at the last byte, the bytes between them are exactly
  `\n\n`, and no span is attributed to a definition, a core block or an
  unrecorded writer. A second case is the control: an ordinary project session
  in the same harness still carries the core block and its `AGENTS.md`.
- **Naming is a function.** `agents/session-naming.ts` exports
  `nameSession(text, { models, profile, timeoutMs })`: one bounded completion
  per model of the naming profile, in order, 8 s ceiling, the existing tolerant
  normalisation and length rules, silent on failure. `NamerService`,
  `NamerState`, the Namer instruction template and the editable-prompt hook
  are gone, and the request carries no identity at all (asserted).
- **The parked-prompt queue went with it (D-s).** `unnamed`, `UNNAMED_MAX`,
  `waitToName`, `nameWaitingSessions` and the `definitions.onChange` naming
  hook are removed: with nothing assigned to naming the request does not run,
  and the `naming` safety pin now means exactly "a completion is in flight".
  The M18-T17 behaviour it corrected cannot recur, because the state it
  corrected no longer exists.
- `packages.ts`, `main.ts`, `worker-lifetime.ts` and `first-turn.ts` lost
  their last Beam/Namer vocabulary; the only surviving mention of `beam` in
  the worker is the legacy record kind `session-config.ts` reads and maps.

Green: `pnpm -F @lasercode/worker build`, `pnpm -F @lasercode/worker test`
1223 passed / 4 skipped (includes `test/seam.test.ts` 4 passed),
`pnpm -F @lasercode/pi-extension test` 204 passed,
`pnpm -F @lasercode/protocol test` 466 passed, `pnpm identity:check`.
The host is red until T3, as expected between commits.

## M23-T3 · Host: no built-ins, Beam re-home

1. `agents/builtins.ts` deleted; `seedDefaultAgent` moves to `agents/seed.ts`.
2. `store.ts`: built-in profiles/instructions become private legacy state read
   once for the migration and written back verbatim; snapshot loses them.
3. `validate.ts`: `allowedAgents` naming `beam`/`chat`/`namer` is a **warning**
   on that field and the name is dropped before the definition runs.
4. `paths.ts`: `workspaceAgentFor` → chat only; `rehomeBeamWorkspaces` moves
   `<state>/workspaces/beam/session-*` into `…/chat` at host start.
5. `catalog.ts`, `session-projection.ts`, `transcript-delivery.ts`: chat kind.
6. `router.ts`/`server.ts`: removed methods unrouted, no Beam prompt,
   `namingProfileId` carry (D-r).
7. Evidence: `env -i … pnpm -F @lasercode/host test`, `pnpm -r build`,
   `pnpm -r typecheck`, `pnpm identity:check`.
