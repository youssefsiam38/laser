# M26 · Tool contract conformance — review

Read-only review of the four target commits on `work/fallback-update` (HEAD
`f0267525`): `a6ed4028` (T1, lint + helper), `b54e2f06` (T2, ten tools),
`5efd53e1` (T3, evaluation harness), `bb8180ca` (T4, UI rows). Binding text:
`docs/agent-tool-contract.md` (§4 amended by T3), `PLAN.md` "M26 · Tool
contract conformance", D-350/D-359 and the D-350.a–h drafts in
`docs/leap/m26-plan.md`.

## Verification

- `pnpm -F @lasercode/protocol test` — 34 files, **521 passed**, no type
  errors (re-run for this review, 2.2 s).
- `pnpm identity:check` — clean.
- `pnpm verify` green was reported by the T1–T4 workers and the merged-tree
  `pnpm tool-eval` is 20/20 (10 fixtures × 2 profiles); not re-run here.
- Lint soundness probed directly against the built protocol package
  (`node -e toolContract(...)`), four probes, quoted under F-B1.

## Findings

Order: blocking, should-fix, nit. Each with file:line and a one-line fix.

### Blocking

**F-B1 · The lint is not sound: four schema constructs bypass it entirely.**
`packages/protocol/src/tool-contract.ts:289-323` (`checkValue` walks only
`anyOf ?? oneOf` and only scalar `type` values). Probed against the built
package — a schema whose nested object hides inside `allOf` (which is exactly
what TypeBox `Type.Intersect` emits), with no `additionalProperties: false`,
an undescribed property and an unbounded string, returns **zero issues**;
likewise `type: ["string","null"]` (unbounded string passes `string-bounds`),
a `oneOf` branch is ignored whenever `anyOf` is also present, and a non-record
branch inside `anyOf` (e.g. `[42, {…}]`) is skipped silently. So §5's promise
("A new Laser tool fails typecheck/tests until it conforms") does not hold for
those shapes, and closure can be evaded at any nesting depth. Note the
inconsistency this creates: the harness's `schema-check.ts:19-21` states the
right policy for the same subset — "a construct it does not know is reported
as unvalidatable rather than silently accepted" — while the lint fails open,
so a schema can be conforming to the lint and unvalidatable to the measure.
*Fix:* make `checkValue` fail loud like the validator — walk `allOf` and
`prefixItems`, handle `type` arrays, flag unknown or non-record branches as
`input-closed`/`property-described` issues — plus one negative test per shape.

### Should-fix

**F-S1 · No pin that every registered tool has a fixture.**
`packages/worker/test/tool-eval/fixtures.test.ts:24-35` (`TOOLS`) is a
hand-maintained list and the only cross-check is `fixtures == TOOLS`;
nothing asserts `laserToolRegistry()` keys ⊆ `TOOLS`. `registry.ts`
(`ensureToolsRegistered`) already fills the registry the honest way, so the
missing assertion is one line — and without it, an M21/M24/M25 tool registered
without a fixture sails through the matrix test. *Fix:* after the matrix run,
expect every `laserToolRegistry()` name to appear in `TOOLS`.

**F-S2 · Preview detection runs against every tool row, including bash, read
and MCP.** `packages/ui/src/components/thread/ToolRow.tsx:167` applies
`toolPreview(result)` unconditionally, and `tool-preview.ts:96-121` will parse
**JSON in any result text** that starts with `{`. A bash command, `read`, or an
MCP tool whose output happens to contain `preview: true`, a digest-shaped
string and a `summary` draws the preview card with a "Nothing has happened
yet" banner over a result that already happened. The details/direct paths are
fine; the loosest path is the generic one. *Fix:* keep details/direct for all
rows, but restrict the JSON-in-text fallback to Laser tools (registry name) or
drop it until a producer needs it.

**F-S3 · `committed` is not honest on two real paths, and D-350.b overstates
the mechanism.**
(a) `start_agent`: `packages/worker/src/agents/harness.ts:1234` creates the
worktree, then on `openChild` failure removes it best-effort with
`.catch(() => undefined)` (harness.ts:1265-1267) and rethrows — if that
cleanup fails, a worktree and branch persist while the tool throws
"Nothing was changed."; a failure after `openChild` succeeds (attach /
`createRun`) leaves worktree **and** child session behind with the same
report. (b) The `HarnessErrorRecovery` API added in T1
(`packages/worker/src/agents/errors.ts:11-16,28-33`) has **zero** production
call sites — every one of the ~64 `new HarnessError(...)` throws in
`harness.ts` takes the tool's generic code and `committed: false`; the only
users of the recovery object are `ScriptedWorld`'s scripted refusals
(`tool-eval/world.ts:97-101,246-274,325-330`). The UI's committed line is
therefore always "Nothing was changed." in production, and error codes never
discriminate (every failure of a tool shares one `*_failed` code). *Fix:* pass
`committed: true` (or a state-naming message) from `start_agent`'s cleanup
failure, and either record in D-350.b that production refusals intentionally
carry no per-site codes yet, or start with the handful of throws that follow a
partial write.

**F-S4 · `truncationMeasure` judges only the first truncated call and ends in
dead code.** `packages/worker/src/tool-eval/measures.ts:363-389`: the
`for (const call of truncated)` loop returns inside its first iteration, so a
fixture with two truncated results is judged on one, and the trailing
`return { id: "truncation", pass: false, … }` is unreachable. Also
`NARROWING_MARKERS` (`"omitted"`, measures.ts:28) is a bare substring over
result text, so any result containing the word counts as truncated. *Fix:*
fail on the first violated truncated call and pass only after all of them
narrowed; make the marker list match on the tools' actual sentences.

**F-S5 · The lint's `output-schema` rule checks descriptions only; the
contract's bounds row is left ambiguous.**
`packages/protocol/src/tool-contract.ts:353-376` (`checkOutput`): outputs are
never checked for `additionalProperties: false`, `maxLength`, `maxItems` or
page-size `maximum` — e.g. `inspect_agent`'s declared output has `messages: {
type: "array" }` and unbounded strings everywhere
(`packages/pi-extension/src/modules/subagents.ts:294-306`). §1's "Bounds in
the schema … nothing unbounded" does not say input-only, while §1's
"Closed input schema" does. Today the tools bound their outputs in code, so
nothing is actually unbounded — but the lint gives no protection and the next
tool author gets none. *Fix:* either extend `checkOutput` to the same bounds
walk as input, or amend §1/D-350 to say bounds govern inputs and record why.

**F-S6 · `renderToolError`/`parseToolError` round-trip is ambiguous when the
message itself carries the sentinels.** The three-line rendering is parsed by
`RENDERED` (`packages/protocol/src/tool-contract.ts:219-222`), which
terminates `message` at the **first** occurrence of
`"\nNothing was changed.\nNext: "` — so a tool failure whose message quotes or
contains those lines (and harness messages do quote sentences, e.g.
worktree-removal guidance) parses into wrong `committed`/`next` fields and the
UI (T4) renders the wrong "what was saved" line. `toolError()`
(tool-contract.ts:117-125) does not forbid the sentinel strings in `message`
or `next`. *Fix:* in `toolError()`, reject or rewrite a `message`/`next` that
contains either committed sentence or `"\nNext: "` (one guard, one test).

### Nit

- **N1** · `packages/worker/src/tool-eval/run.ts:225` —
  `estimateTokens("x".repeat(inputBytes))` allocates a request-sized string to
  divide by 4; estimate from `inputBytes` arithmetically.
- **N2** · `isRecord` is re-implemented in ≥6 modules (`tool-contract.ts`,
  `schema-check.ts`, `run.ts`, `fixture.ts`, `tool-preview.ts`,
  `tool-label.ts`); protocol could export one.
- **N3** · `packages/worker/src/tool-eval/fixture.ts:186` — `world` is cast
  `as ToolEvalWorld` with no shape validation, unlike every other fixture
  field that fails with a named field; a typo surfaces deep in
  `ScriptedWorld`.
- **N4** · `packages/ui/src/source-control/change-preview.tsx:113` —
  `GitChangePreview` passes `itemsLabel: ""` to suppress the default
  "Files"; an explicit `itemsLabel?: false` or omit-when-absent would read
  better than an empty-string sentinel.
- **N5** · `PAGE_SIZE_NAMES` (`tool-contract.ts:247-263`) is a fixed list by
  design ("a lint that guesses is a lint people argue with"), but names like
  `take`, `first`, `skip`, `head`, `bytes`, `window` pass unbounded today;
  worth one sentence in `agent-tool-contract.md` §1 on how the list grows.
- **N6** · `buildReport` counts `totals.fixtures` as distinct tools
  (`report.ts:30`), so two fixtures for one tool would silently change the
  number `fixtures.test.ts:71` pins.
- **N7** · `RENDERED` embeds the committed sentences with an unescaped `.`
  (`tool-contract.ts:220`), so "Nothing was changedX" also parses; escape them.

## Answers to the review questions

**1. Lint soundness.** Every §1 rule listed in the m26-plan table is enforced
for the shapes TypeBox normally emits: name, description ≤ 1 200, closure at
every object level *including union branches* (verified by
`tool-contract.test.ts:159-189`), described properties, string/array bounds,
enum closure, annotations (+ the readOnly/destructive conflict), the label
rule (exempt set matches `TOOL_LABEL_EXEMPT`; `activity_label` never declared),
and output-schema-with-descriptions. But four constructs bypass it — F-B1 —
and the bounds rule does not reach outputs — F-S5. Registration coverage is
good: the only `pi.registerTool` outside `registerLaserTool` in Laser code is
the `bash` override (`background-work.ts:697`), recorded as D-350.c, and
`prompt-freeze.ts:170` is a recording proxy, not a second registration door.
A page size under another name (`take`, `bytes`, …) passes — N5.

**2. Error shape.** The rendering/parse pair works for the happy path and the
UI correctly falls back for engine/MCP/crash text (regex miss → `undefined`).
Two weaknesses: sentinel-collision ambiguity (F-S6) and the `committed`
honesty gaps of F-S3 — concretely, `start_agent` can leave a worktree and
branch behind while reporting `committed: false`, and `remove_agent_worktree`
cannot report partial removal because `removeAt` swallows every git failure
(`worktrees.ts:228-233`) — that one is pre-existing behavior, but it is the
path D-350.b points at when it claims the worktree case is honest.

**3. Retrofit fidelity.** Additive only. The ten tools' execute bodies are
re-embedded unchanged (verified in the `b54e2f06` diff for `task_output`,
`task_stop`, `stop_agent`, `inspect_agent`); the only schema-semantic changes
are `additionalProperties: false` on every input, `maxLength: 200` on ids
(harness-minted, so no model-visible regression), `reason` keeps its existing
1000 bound, and `task_output.tail` keeps its pre-existing `maximum: 5000`.
`inspect_agent.messages`'s maximum (`AGENT_INSPECT_MESSAGES_MAX`) predates
M26. The one model-visible behavior change is `start_agent`'s catalog
degradation (D-350 draft 5): full descriptions → 120-char excerpts → names
only → honest count. A model still gets every agent name it may start, and
the 60×280-character test pins the budget; acceptable. The `worktree` union
gains only a union-level description.

**4. Evaluation harness.** The measures are real, not self-referential: a run
opens a real `StableSdkDriver` session, registers the real tools, replays
recorded provider responses through a local 127.0.0.1 OpenAI-compatible
server (`recorded-provider.ts`), and executes every call against the real
schemas, real `ToolError` rendering and real background commands in a
throwaway project (`run.ts:78-170`). A fixture cannot pass trivially: every
measure fails loudly when it has nothing to judge ("no tool failed, so the
fixture proved nothing about retrying", measures.ts:270), and D-350.f refuses
to measure a run that diverges from its recording (tools, order, outcomes,
and `fails: true` must carry the contract's error shape). The profile matrix
genuinely goes through `readModelProfiles` (`harness.ts:38-40`), the same
reader the product uses. No network beyond 127.0.0.1; no credentials — the
sandbox writes `apiKey: "recorded"` and a keyless search connection
(`run.ts:213-233`), and `fixtures.test.ts:100-104` asserts fixtures carry no
secret-shaped strings. Live mode is only ever exercised in tests against a
local stub provider (`live-mode.test.ts`), never the person's credit. The
recorded matrix is honest about its limits (the plan says so): it proves the
tools behave as the contract says when called that way; it cannot prove a
model *will* call them that way — that is `--live`'s job. Determinism: real
`delayMs` waits (500 ms in `task_output.json`) and a 50 ms settle drain are
small but real-time; timeouts are explicit (60 s test, 120 s default). F-S4
is the one measure bug found.

**5. UI.** Tokens only — the new files use the established Tailwind token
scale (`text-attention`, `text-danger-quiet`, `bg-surface-2`, `eyebrow`,
`mono`); no hex literals or raw px. `parseToolError`'s fallback is correct for
engine/MCP errors (regex miss renders the pre-existing `ToolError`), modulo
F-S6's collision case. Preview detection is bounded and untrusted-safe
(clamps, drops wrong types, 64 KB text cap), but its JSON-in-text path is
applied to every tool row — F-S2. The "no confirm button" stance matches §2's
handshake and is argued in code, not just prose.

**6. Structure.** `tool-contract.ts` (420 lines) and `schema-check.ts` (157)
overlap in JSON-Schema traversal but do different jobs (lint a schema vs
validate a value); unifying them into one walker would entangle two error
vocabularies for modest saving — not recommended. The real drift risk between
them is F-B1: the validator fails loud, the lint fails open; aligning the
lint's policy with the validator's is the cheap fix. File growth is healthy:
`harness.ts` untouched (3156 before and after), `subagents.ts` 613 → 798,
`background-work.ts` 916 → 959, `ToolRow.tsx` 604 → 610 — nothing crossed 1k
and the new tool-eval modules are small and single-purpose. No dead code
except `HarnessErrorRecovery`'s unused-in-production option (F-S3b) and the
unreachable return in F-S4. Type boundaries are clean: no `as any`; the two
casts that exist are justified and commented (`laserToolSpec`'s
TypeBox→JsonSchemaNode, `parseFixture`'s world — the latter under-validated,
N3).

**7. What M21-T17/M24/M25 still need.**
- The registry↔fixture pin (F-S1) — otherwise a lifecycle tool without a
  fixture passes the suite silently; the m26-plan's own step 5 assumes the
  pin works.
- The preview shape is published and the detector ready, but producers should
  put previews in `details` (the strict path), not rely on the JSON-text path
  that F-S2 wants narrowed.
- `expectedRevisionId`/`idempotencyKey` for project-work mutations is neither
  lint-enforced nor decision-recorded as future enforcement (T2 deviation 2
  records why it is absent today); when M21 lands, either the lint grows the
  rule or the deviation gets a D-number — decide before the first lifecycle
  tool, so it does not ship un-enforced.
- The retry measure's real target (a stale-revision conflict) has no fixture
  until M21; today's analogue (`task_output` on a stale task id) is fine but
  weaker — the m26-plan already says this; nothing extra needed here.

## Verdict

Not approved as-is. The milestone's core deliverable — enforcement — has one
soundness hole (F-B1) that contradicts §5's promise, and six smaller items.
F-B1, F-S1 and F-S2 are small, contained fixes; F-S3 needs either a code
change or an honest amendment to D-350.b. Everything else — the retrofit's
fidelity, the harness's realness, the error shape, the UI tokens and the
module boundaries — is in good shape.
