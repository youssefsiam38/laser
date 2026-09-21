# M23 "Plain Chat" — independent review

- **Range**: `07bf9571^..436dd1b0` on `work/fallback-update`, restricted to
  `5aebaee4` (protocol), `0051d591` (worker), `79404b7c` (host),
  `aaa11063`/`744cedfd`/`7dec4688`/`72f0a3a1` (ui/cli), `0cd83795`
  (identity guard). Reviewed at HEAD `436dd1b0`, read-only.
- **Contract**: `docs/plain-chat.md` (binding), `PLAN.md` "M23 · Plain Chat"
  rows M23-T1…T5, `docs/leap/m23-backend-plan.md` (D-o…D-s),
  `docs/leap/m23-ui-plan.md` (D-t…D-x).
- **Given evidence**: `pnpm verify` green after the UI merge; protocol 466,
  worker 1223, host 1027, ui 2989 tests pass. I did not re-run the suite; the
  findings below come from reading the code at the exact revision plus one
  disposable filesystem probe (noted inline).

## Verdict

**Not approved as-is — one migration-safety blocker, four should-fixes.** The
removal itself is clean and well-shaped: the protocol/worker/host surgery
matches the contract almost exactly, the byte-for-byte chat-prompt proof is
genuine, naming is a proper one-shot function, and the UI/CLI deletion left no
Beam/Namer residue on person surfaces. The one real defect is in the Beam
workspace re-home: the physical folder move contradicts the never-rewritten
session header, which silently detaches a pre-M23 conversation from the files
in its workspace and permanently regrows the retired directory.

---

## Blocking

### B1 · The Beam re-home move silently detaches a pre-M23 session from its workspace files — and the retired directory regrows for ever

- **Where**: `packages/host/src/paths.ts:112-144` (`rehomeRetiredWorkspaces`,
  called at host start, `packages/host/src/server.ts:423`), against
  `packages/host/src/paths.ts:51-56` (`isChatWorkspace` accepts the retired
  dir), `packages/worker/src/agents/session-config.ts:204-230`
  (`ensureWorkspaceSessionCwd` mkdirs the *stored header* cwd), and
  `packages/host/src/server.ts:776-786` (`resolveTrust` → `ensureWorkspace(cwd)`).
- **What happens**: a pre-M23 session's header still says
  `cwd = <state>/workspaces/beam/session-X` ("history is evidence" — nothing
  rewrites it). Re-home physically renames `workspaces/beam/session-X` →
  `workspaces/chat/session-X`. The first time the person opens that
  conversation, the host resolves trust for the header cwd
  (`ensureWorkspace`), and the worker *additionally* ensures the stored header
  cwd (`ensureWorkspaceSessionCwd`, whose own comment says "the engine checks
  that one") — so `workspaces/beam/session-X` is recreated **empty** while the
  person's workspace files sit orphaned in `chat/session-X`. The session keeps
  running against the recreated empty directory; every later host start finds
  a non-empty `beam/` again, and `rehomeRetiredWorkspaces` then "keeps" the
  duplicates (the name is taken), so the retired directory never goes away and
  the "idempotent — a second start finds nothing to do" property
  (`paths.ts:103-105`, and the test at
  `packages/host/test/agents/retired-builtins.test.ts:39-41`) only holds until
  the first old session is opened.
- **Probe**: I ran `rehomeRetiredWorkspaces` from the built host package
  against a disposable temp state (session folder with a `notes.md`), then
  called the production `ensureWorkspace` on the old header path: the old
  `beam/session-aaa` directory came back while the file remained under
  `chat/session-aaa`. No source was modified.
- **Impact**: transcripts survive (the contract's headline promise), but any
  file a pre-M23 Beam/Chat conversation created in its workspace is silently
  no longer in that conversation's working directory, and nothing tells the
  person. It also contradicts the stated design of the move
  (`paths.ts:103-105` "Idempotent — a second run finds nothing to do").
- **Fix (one line of intent)**: delete `rehomeRetiredWorkspaces` and its
  host-start call, and keep only the acceptance half — `isChatWorkspace`
  already treats the retired directory as Chat, so folders stay where they
  are, every old session keeps its files *and* its cwd, and ~40 lines, their
  failure branches and one test block disappear. If the physical move is
  genuinely wanted for tidiness, it must instead rewrite the stored header cwd
  at the same moment (a deliberate one-time transcript mutation, recorded) —
  but "don't move" is the simpler, behavior-preserving option.

---

## Should-fix

### S1 · The "is this the Chat workspace" rule exists in three shapes that can drift

- **Where**:
  - host, containment + retired dir: `packages/host/src/paths.ts:51-56`
    (`isChatWorkspace`);
  - UI grouping, normalized prefix containment, chat root only:
    `packages/ui/src/components/shell/session-groups.ts:51-62`
    (`workspaceKindOf`);
  - UI session-kind fallback, **exact root equality only**:
    `packages/ui/src/agents/model.ts:37-42` (`isWorkspaceCwd`).
- **Why it bites**: D-u (`m23-ui-plan.md`) states the fallback as "is its cwd
  *inside* `workspaces.chat`", but `sessionKindFor` → `isWorkspaceCwd` only
  matches the root itself. Real Chat sessions have per-session folders
  (`chat/session-*`, allocated at `packages/host/src/router.ts:706-716`), so a
  session in the workspace with no agent record — a record-less session from
  the per-session-dir era, or anything the host still counts as chat via
  containment (`router.ts:1325-1328`) — groups as **project** in the UI
  (`agents/model.ts:62-68`) while the host lists it as a workspace session.
  Three predicates, three answers, and the retired-beam acceptance exists in
  only one of them.
- **Fix**: put one directory predicate next to `sessionKindOf` in the protocol
  (or at least one per package, reused), shaped like the host's
  `isChatWorkspace` (containment, chat root + retired sibling), and make
  `isWorkspaceCwd`, `workspaceKindOf` and `sessionKindFor` use it. That also
  answers the "exactly one mapping rule?" question: today `sessionKindOf` is
  the single *record*→kind rule (good — host `catalog.ts:391` and UI
  `agents/model.ts:63` both call it), but the *directory* rule is triplicated.

### S2 · D-r naming carry refires whenever naming is unassigned, not once

- **Where**: `packages/host/src/server.ts:1252-1267`
  (`carryNamingProfile`: `if (report.assignments.namingProfileId) return;`).
- **Why**: the migration pass runs on every provider connect / first worker
  (`server.ts:1167-1232`). The gate is "unset now", not "never carried". A
  person who deliberately clears **Naming conversations** in Settings gets it
  silently re-written at the next pass, for as long as
  `builtinProfiles.namer` still sits in `agents.json` (kept one release,
  `packages/host/src/agents/store.ts:556-557,670-671`). "Never over a choice
  made in Settings" (`server.ts:1244-1249`) should read a *cleared* choice as
  a choice too.
- **Fix**: stamp the carry in the migration record
  (`MODEL_PROFILE_MIGRATION_RECORD`, `server.ts:1279`) and skip when stamped —
  the carry becomes genuinely once-ever and idempotent.

### S3 · `LaserThreadScope` is a dead second-surface seam with growing carrying cost

- **Where**: `packages/ui/src/runtime/LaserProvider.tsx:2348-2460+`
  (component + provider internals), exported at
  `packages/ui/src/runtime/index.ts:145,168`; scope accounting spread over
  `view-cache.ts`, `store.ts`, `history-owners.ts` (~120 "scope" mentions
  across those files). No component mounts it; the plan itself flagged it
  (`m23-ui-plan.md`, "Not a survivor but worth knowing") and deferred the
  decision.
- **Why it matters**: keeping it means every future change to the runtime must
  keep a multi-surface model alive for a surface that no longer exists
  (M24's consultation row and M26's tool contract will both touch this code).
  The cost is not the component; it is the invariant "there may be two
  conversation surfaces" baked into four files.
- **Fix**: schedule the removal as its own owned task (M24 or M26 pre-work),
  not an orphaned follow-up. If a genuine second surface is planned (the
  mobile relay?), write that down where the next reader will find it;
  otherwise the seam should go while its tests
  (`test/runtime/scope-adapter-identity.test.tsx`) can still name what they
  delete.

### S4 · The identity guard's Beam/Namer patterns are narrower than their claim

- **Where**: `scripts/identity/check.mjs:245-246`
  (`/\bBeam\b/`, `/\bNamer\b/`), applied to **string literals only** via
  `scannable.mjs`, in the five person-surface packages, tests excluded.
- **Gaps**:
  1. JSX text nodes are not string literals — `<p>Beam is gone…</p>` passes
     the guard today. (I grepped: no JSX text currently names Beam/Namer, so
     this is a hole, not a live miss.)
  2. Lowercase copy escapes it: the exact regression this guard exists to
     stop — a `"beam green"` tagline returning in
     `packages/ui/src/theme/presets.ts` or a "the namer" sentence — is
     invisible to `/\bBeam\b/`.
- **Fix**: widen to `/\bbeams?\b/i` and `/\bnamer\b/i`, and list the two
  documented light-drawing survivors (startup drawing keys in `globals.css`,
  `activity-beam` in `thinking-indicator.tsx`/`tool-fallback.aui.tsx`/
  `tool-group.aui.tsx`) as exempt lines the way `VOCABULARY_EXEMPT_LINES`
  already works. That keeps the guard honest without weakening it.

---

## Nits

- **N1 · UI test asserts a wire shape no host can send**:
  `packages/ui/test/shell/session-groups-workspaces.test.ts:16` builds a
  summary with `{ agentName: "beam", kind: "beam" }` — `SessionAgentKind` no
  longer contains `"beam"` and the host catalog emits
  `{ kind: "chat", sessionKind: "chat" }` with no agent name
  (`packages/host/src/catalog.ts:383-400`). The real legacy-record proof is
  host-side (`retired-builtins.test.ts:113-129`); the UI case is a proxy for
  protocol-robustness and should say so in its comment.
- **N2 · Stale comment**: `packages/ui/src/components/shell/SessionsPanel.tsx:58`
  still says "projectless conversations of the built-in Chat agent".
- **N3 · Unnecessary optionality**: `sessionKindFor`
  (`packages/ui/src/agents/model.ts:63`) does
  `agent.sessionKind ?? sessionKindOf(agent.kind)`, but `sessionKind` is
  required on `SessionAgentInfo` (`packages/protocol/src/agents.ts:512-520`);
  the `??` arm is dead defensive code that muddies the contract. Same pattern
  at `packages/cli/src/format.ts:42-43`.
- **N4 · "M22 eligibility classes" is implemented as failure-passing**:
  `nameSession` (`packages/worker/src/agents/session-naming.ts:141-156`)
  walks the profile and passes over any model that is missing, slow or errors;
  it does not consult the fallback policy's explicit eligibility check
  (`packages/worker/src/fallback/policy.ts:177`). Practically equivalent for
  this request shape, but the contract phrase
  (`docs/plain-chat.md` "Naming") is satisfied by behavior, not by reuse; if
  M24's consultation walk needs real eligibility, extract the predicate then.
- **N5 · Chat silently drops `{{additionalInstructions}}`**: by contract the
  template is exactly three fields
  (`packages/worker/src/agents/instruction-templates.ts:31-35`), so any future
  `appendSystemPrompt` producer would vanish from chat prompts without an
  error (the provenance recorder would still attribute it,
  `packages/pi-extension/src/prompt-provenance.ts:41-52`). Worth a sentence in
  the template comment so M26 doesn't rediscover it.

---

## Contract conformance, item by item

| Check | Verdict | Evidence |
| --- | --- | --- |
| Chat prompt is EXACTLY the three fields | **Yes, and the byte-for-byte claim is genuine** | `CHAT_INSTRUCTION_TEMPLATE` is the three tokens joined by `\n\n` (`packages/worker/src/agents/instruction-templates.ts:31-35`); a definition-less session renders exactly it and nothing else (`instruction-templates.ts:137-145`: no `agentPrompt`, no core block). `roleBlock` returns `undefined` for `kind: "chat"` (`packages/pi-extension/src/modules/subagents.ts:109-115`) and delegation is gated on `canDelegate()`, false with no definition (`harness.ts` `canDelegate`). The test is a real engine turn through `StableSdkDriver` + stub provider: first field at byte 0, last ends at `system.length`, the joins are exactly `"\n\n"`, the whole prompt equals the three sliced regions, zero `unrecorded` spans, no `Core instructions` span, no `agentName` spans, plus negative content checks (`chat-prompt.test.ts:96-137`). Two honest limits, not defects: the chat bridge is hand-built to the harness shape rather than taken from `server.agentOptions` (a divergence there would not be caught — though `server-agents.test.ts:179-200` covers the `session/new` chat path), and *inside* a field bytes are proven by the slice equality rather than per-byte attribution. The project-session control case proves the absences are the chat's own property. |
| Naming one-shot, 8 s, silent, walks `namingProfileId` | **Yes** | `agents/session-naming.ts:19,141-156`: one completion per profile model in order, `AbortSignal.timeout(8000)`, never throws; worker wrapper is silent and skips when no profile assigned (`server.ts:1912-1921,1966-2005`), one attempt per session via `namingInFlight` with a token. Request carries no identity (asserted, `naming.test.ts:65-77`). See N4 on eligibility. |
| Namer/qualification/naming pin/parked queue gone | **Yes** | `namer.ts` deleted (221 lines); grep of `qualify|waitToName|nameWaitingSessions|NamerState` over worker/host src is clean; `namingInFlight` is the only pin and means "in flight" (`server.ts:1999-2010`). |
| `AgentKind` custom only; built-in symbols gone from protocol | **Yes** | `packages/protocol/src/agents.ts:151-155` (`AgentKind = "custom"` with a reasoned comment), `RETIRED_AGENT_NAMES` is all that remains of the names (`agents.ts:71-80`); `agents/builtin/*` gone from `ClientRequests` (`messages.ts`), schemas (`schemas.ts:1260-1263` removed) and method policy (`method-policy.ts` diff). `startup-screen.ts` untouched by design. |
| `SessionAgentInfo.sessionKind` | **Yes** | `agents.ts:512-520`; produced by the harness (`harness.ts:521`) and the catalog (`catalog.ts:390-400`); `sessionKindOf` is the single record mapping (`agents.ts:504-507`). |
| Beam workspace re-home keeping history | **No — B1** | The move keeps transcripts but detaches workspace files and regrows `workspaces/beam`; see B1. |
| Legacy `beam`/`chat` records open as chat, unrewritten | **Yes** | Parser maps `beam`→`chat` and drops the dead name, never rewriting (`session-config.ts:88-99`); `recoverAgent` returns no definition for kind chat (`server.ts:1802-1805`); host catalog reads them as chat, file bytes unchanged (asserted in `retired-builtins.test.ts:113-129`). |
| `allowedAgents` retired names warn and drop | **Yes** | Dropped on load (`agent-file.ts`) with a warning that takes priority over the profile warning; dropped on save (`store.ts:719`); the names are refused as definition names (`store.ts:214-222,283,296`); end-to-end in `retired-builtins.test.ts:132-166`. |
| Removed methods unrouted | **Yes** | No `agents/builtin` anywhere in host router/worker server; removing them from `ClientRequests` + policy makes an old client's call an unknown method (per plan; verified by absence). |
| D-r Namer→`namingProfileId` carry | **Correct shape, not once-ever — S2** | Runs only when the settings file assigns nothing and the carried id names a real profile (`server.ts:1252-1267`), written through the ordinary `pi/settings/set` (one writer). Idempotent across normal restarts; see S2 for the cleared-choice hole. |
| Three UI entry points start an empty Chat | **Yes** | One verb `shell.newChat()` used by the Chat tab `+`, palette `New chat` and `Mod+Shift+N` (`Shell.tsx:264-285,293-300`; `SessionsPanel.tsx:171-260`; `CommandPalette.tsx:113`), sending `sessionKind: "chat"` with no `agentName`; proven over the real Shell/provider (`new-chat-entry-points.test.tsx`), including "plain Cmd+N stays project" and composer focus. DOM-level assertions (data-slot, activeElement) are the right proxies here and are named as such in the test header. |
| Agents page person-only, designed empty state | **Yes** | `agentsInScope(...).custom` only (`AgentList.tsx:50-72`), `agent-list-empty` block with copy and a New-agent button (`AgentList.tsx:155-166`), covered by `test/agents/page/screen.test.tsx:230`. |
| No Beam mark/badge | **Yes** | `components/beam/*` deleted; no Beam group/mark branches in `Rail`/`TopBar`/`SessionsPanel`/`session-groups`/`GlobalSearch`; `sessions-tabs.test.tsx` asserts the negative. |
| M22 pickers still work | **Yes** | `profile-usage.ts:25-49` keeps all four assignment rows including naming; delete/replace logic unchanged; onboarding uses `namingProfileId`. |

## Grep invariants

- `@earendil-works` outside worker/pi-extension: only in `packages/protocol/dist/index.d.ts` and two symbol-level spots (`packages/protocol/src/index.ts` type re-export, `packages/ui/src/components/thread/tool-summary.ts` and `packages/cli/src/pi.ts` comments about engine tool *names* — not Pi imports). **Pass.** (Dist output is generated; the src references are comments naming Pi's tool names, which the protocol/tool-label layer is allowed to know.)
- Hex/px in changed UI components: the M23 UI diff adds none; the grep hits are pre-existing Tailwind arbitrary values bound to tokens and comments. **Pass.**
- "Beam"/"Namer" in person-facing strings: none; survivors are exactly the documented ones (startup drawing, `ActivityBeam` light, `storageKey("beam-session")` purge key, legacy-record comments/fixtures). **Pass.**
- Identity guard soundness: patterns are capital-initial singular only and string-literal only — S4.

## Migration safety (question 3)

- **Sessions under `workspaces/beam`**: transcripts kept, records untouched, listed as Chat — **but see B1** for the working-directory detachment and the regrowing retired directory.
- **`agents.json` legacy keys** (`builtinProfiles`, `builtinInstructions`, `beamModel`-era blobs): read once for the migration and the naming carry, written back byte-for-byte, dropped from the snapshot (`store.ts:82-110,531-557,670-671`). Model choices map to profiles via the M22 migration (`store.ts:344-400`). **Nothing is lost.**
- **`builtinInstructions` overrides**: kept verbatim on disk but silently stop having any effect, with no warning surfaced — this is what `docs/plain-chat.md` "Migration" prescribes ("read once … then ignored; the keys stay one release"), so it is contract-conpliant; noting it here because it is the one place a person's words stop working without a message anywhere.

## Test quality (question 4)

- The chat-prompt proof is real (see table) — spans plus full-text equality, not just span positions.
- Naming tests cover the walk, the ceiling, silence, and the person-renames-first race (`session-naming.test.ts:265`).
- `retired-builtins.test.ts` covers the move, non-destructive reads, and the allowedAgents warning; it does **not** cover opening a re-homed session through the worker, which is exactly the gap B1 lives in — add that case (or delete the move, per B1, and the gap goes with it).
- Deleted beam tests were deleted with the feature they tested (bubble, spark, profile dialog); the reusable fakes were moved to `test/world/` rather than dropped. No orphaned coverage found.
- Proxies worth naming: the entry-points test asserts DOM slots/focus (stated in its header); the session-groups "beam" test asserts a wire shape the host can no longer send (N1).

## Structure (question 5)

- **No file crossed 1k lines because of this milestone.** `host/router.ts` (1760) and `host/server.ts` (1874) were already over 1k before (1788/1863) and both shrank. New files are small and single-purpose (`session-naming.ts` 156, `seed.ts` 27, `retired-builtins.test.ts` 175).
- Dead code: `LaserThreadScope` (S3) is the only substantial survivor; everything else removed was removed outright (builtins.ts deleted, namer.ts deleted, beam components deleted).
- `sessionKind` derivations: one record rule (`sessionKindOf`), three directory rules (S1).
- The `beam`→`chat` storage mapping exists twice by necessity — protocol `sessionKindOf` (product kind) and worker `parseSessionAgentRecord` (`session-config.ts:69,93`, storage kind whose union no longer holds `"beam"`). Defensible; the doc comment on `KINDS` says why.

## Looking ahead to M24/M26 (question 6)

- **S1** is the one that will cost M26: persistence and tool-contract code keying on session cwd will meet both the retired directory and the B1-recreated duplicates; a single directory predicate fixes the vocabulary before more callers appear.
- **S3**: M26's tool contract touches `LaserProvider` and the store; removing the scope seam first shrinks that surface.
- **N5**: if M24/M26 ever appends system instructions outside an agent definition, the chat template will silently drop them; decide the rule now.
- No other M23 decision adds friction: `AgentKind = "custom"` (kept single-member deliberately, `agents.ts:151-155`) and `sessionKindOf` are exactly the shapes M24's consultation work wants.

## Summary of required actions

| # | Severity | One-line fix |
| --- | --- | --- |
| B1 | Blocking | Delete `rehomeRetiredWorkspaces` (+ host-start call); keep `isChatWorkspace`'s retired-dir acceptance — folders stay put, old sessions keep their files and cwd. |
| S1 | Should-fix | One containment predicate for "is a chat workspace cwd" shared by host and UI (and matching D-u's wording). |
| S2 | Should-fix | Gate the D-r carry on a stamp in the migration record so it runs once, not whenever naming is unassigned. |
| S3 | Should-fix | Give the `LaserThreadScope` removal a named owner/task instead of an unowned follow-up. |
| S4 | Should-fix | Widen the identity guard to case-insensitive `beams?`/`namer` with the two documented light-drawing exemptions. |
