# M26 · Tool contract conformance — T1/T2 working plan and checkpoint

Owner: worker "Tool contract lint and retrofit", branch
`agents/tool-contract-lint-and-retrofit-b8d4d62a`, base `fb595633`.
Binding text: [`../agent-tool-contract.md`](../agent-tool-contract.md) (D-350).
This file is the per-task checkpoint for M26-T1 and M26-T2 and the handover
note for the M26-T3 (evaluation harness) and M26-T4 (UI) owners.

## M26-T1 — protocol shapes and lint, one registration helper

What landed:

| Path | What |
| --- | --- |
| `packages/protocol/src/tool-contract.ts` | `ToolAnnotations` + `mcpToolAnnotations()`, `ToolError` (closed Zod schema, `toolError()` builder, render/parse pair, carrier reader), `LaserToolSpec`, `toolContract()` lint and `assertToolContract()` |
| `packages/protocol/test/tool-contract.test.ts` | one positive and one negative case per lint rule, plus the error shape and the MCP mapping |
| `packages/protocol/src/index.ts` | exports the module |
| `packages/pi-extension/src/register-tool.ts` | `registerLaserTool(pi, tool, execute)`: lints at registration and throws, strips the injected `activity_label` before `execute`, converts a thrown failure into a rendered `ToolError` |
| `packages/pi-extension/test/register-tool.test.ts` | registration lint, label stripping, error conversion, success pass-through |
| `packages/worker/src/agents/errors.ts` | `HarnessError` carries an optional `{ code, committed, next }` so a refusal can name its own recovery instead of taking the tool's default |

### The lint rules

`toolContract(spec)` returns one issue per violation; `assertToolContract()`
throws with all of them. Rules, in the order the contract lists them:

| Rule id | Checks |
| --- | --- |
| `name` | `^[a-z][a-z0-9]*(_[a-z0-9]+)+$` — verb + object, snake_case, at least two words |
| `description` | present, non-empty, ≤ 1 200 characters |
| `input-closed` | input is a JSON Schema object with `additionalProperties: false`, at every object level |
| `property-described` | every property, at every level, has a non-empty `description` |
| `string-bounds` | every string has `maxLength` unless it is an `enum` or a `const` |
| `array-bounds` | every array has `maxItems`; its items are bounded too |
| `page-size-bounds` | a number/integer whose name is a page size (`limit`, `tail`, `messages`, `count`, `rows`, `lines`, `results`, `page_size`, `num_results`, `max_results`, `size`, `depth`) has `maximum` |
| `enum-closed` | an `enum` is a non-empty list of scalars on a typed node |
| `annotations` | all four flags present and boolean; `readOnly` and `destructive` are never both true |
| `label` | `label: "injected"` exactly when D-277 says the tool gets one, `"exempt"` for `start_agent`, `complete_agent_run`, `inspect_fleet`; the input schema never declares `activity_label` itself (the worker injects it) |
| `output-schema` | a declared object output with at least one described property |

### Decisions

- **D-350.a — a failing tool throws its `ToolError`, rendered; it is not
  returned as a successful result.** The engine's agent loop discards a tool's
  `details` on a throw (`createErrorToolResult` in `pi-agent-core`'s
  `agent-loop.js` builds `{ content: [{ type: "text", text: message }],
  details: {} }`), and a *returned* result is not an error at all: `isError`
  is only ever true for a throw. So the four fields travel in the thrown
  message, in one fixed rendering that `parseToolError()` reads back:

  ```
  [no_such_run] No run called "run_9" was started by this session.
  Nothing was changed.
  Next: call inspect_fleet to list the agents under you with their runIds.
  ```

  `committed: true` renders as `Some of this was already saved.` instead.
  Both the model and the person read plain sentences; the UI (M26-T4) recovers
  the fields with `parseToolError()` rather than by matching prose.
- **D-350.b — `committed` is honest by construction, not by assertion.** A
  read-only tool's failures are always `committed: false` (the helper forces
  it, so a mis-declared recovery cannot claim otherwise). A mutating tool
  defaults to `false` and a refusal that knows better says so through
  `HarnessError`'s `committed` option. No harness refusal today happens after
  a partial write; the ones that can (worktree removal) are reported with the
  state they left behind in their message.
- **D-350.c — the `bash` override stays an engine tool.** `background-work`
  overrides the engine's own `bash` definition, inheriting its description,
  prompt text and renderers (invariant: engine tools are not Laser's to
  reshape; the contract's own §1 says the same). It is not registered through
  `registerLaserTool` and not linted. `task_output` and `task_stop` are Laser
  tools and are.
- **D-350.d — `web_search` is a Laser tool and is under the contract.** The
  engine does not define it; the `web-access` module registers it from the
  person's configured provider, so its schema, description and failures are
  ours. It is `readOnly` + `external` (`openWorldHint`). This makes ten tools
  under the lint, not nine.
- **D-350.e — the contract's view of a tool lives in a registry, not in the
  engine's tool definition.** `ToolDefinition` has nowhere to put annotations,
  a declared output or a recovery, so `registerLaserTool` keeps them in
  `laserToolRegistry()` (keyed by tool name, last registration wins). That is
  what a conformance fixture (M26-T3) and the docs-table tests read. It
  describes the tool *surface*, not per-session state; only `start_agent`'s
  description differs per session, because it carries that session's catalog.

## M26-T2 — the harness and background tools under the contract

What landed:

| Path | What |
| --- | --- |
| `packages/pi-extension/src/modules/subagents.ts` | the seven harness tools registered through `registerLaserTool` with closed, bounded, fully described schemas, declared outputs and annotations |
| `packages/pi-extension/src/modules/background-work.ts` | `task_output` and `task_stop` likewise; `bash` unchanged (D-350.c) |
| `packages/pi-extension/src/modules/web-access.ts` | `web_search` likewise (D-350.d) |
| `docs/agents.md` §2, §6 | annotation columns matching the code |

### Annotations, as registered

| Tool | readOnly | idempotent | destructive | external | Why |
| --- | --- | --- | --- | --- | --- |
| `start_agent` | no | no | no | no | creates a session, a run and usually a worktree; two identical calls start two agents. Not `external`: everything it touches is this machine's project, under Laser's own authority |
| `send_agent_message` | no | no | no | no | not idempotent: a repeated call delivers a second message, and in `interrupt` mode cancels a second invocation. There is no idempotency key on this tool yet (see "What T3/T4 owners must know") |
| `inspect_fleet` | yes | yes | no | no | reads the tree; wakes nothing |
| `inspect_agent` | yes | yes | no | no | reads one agent; never delivers |
| `stop_agent` | no | yes | yes | no | ends a run; repeating it on an ended run reports it as it is |
| `remove_agent_worktree` | no | yes | yes | no | removes a directory and a branch; repeating it on an already-removed worktree is refused, not re-done |
| `complete_agent_run` | no | no | no | no | publishes the run's ending and terminates the turn |
| `task_output` | yes | yes | no | no | reads a bounded window of a command's output |
| `task_stop` | no | yes | yes | no | kills a process tree; an ended task is reported as is |
| `web_search` | yes | yes | no | yes | leaves this machine for the person's provider |

### Deviations that survive (ready to become D-\<n\> entries)

1. **`bash` is not linted** (D-350.c above): it is the engine's tool with a
   Laser behaviour added, and re-declaring its schema would fork the engine's
   own contract for `command`/`timeout`.
2. **No `expectedRevisionId` or `idempotencyKey` on the harness mutations.**
   The contract requires them for mutations *of project work*; agent runs,
   worktrees and background commands are not project-work artifacts and have
   no revision. When M21 lands lifecycle artifacts, its tools carry both. The
   lint therefore does not require either field, and requiring it would have
   failed every existing tool for a field with nothing to point at.
3. **No preview/confirm on `stop_agent`, `remove_agent_worktree`, `task_stop`.**
   They are destructive but local and reversible in kind (a stopped run can be
   messaged again; `remove_agent_worktree` already refuses unmerged work
   unless `force: true` is passed). Adding a two-call preview handshake to
   tools the model uses in a loop would cost a round trip per call for a
   refusal path that already exists. Recorded rather than silently skipped.
4. **`send_agent_message` is not idempotent and has no key.** A repeat is a
   second message on purpose: the parent redirecting a child twice is a real
   intention. Recorded so the annotation is not read as an oversight.
5. **`start_agent`'s description degrades instead of overflowing.** The
   description carries the session's agent catalog, which a project controls:
   60 agents with 300-character descriptions cannot fit in 1 200 characters.
   Rather than exempt the tool from the budget or refuse to register it,
   `startAgentDescription()` degrades in three steps — each agent's own
   description cut to 120 characters, then descriptions dropped and names
   kept, then names cut with an honest count of the rest, which `start_agent`
   still accepts. What is lost is detail about an agent, never the ability to
   start it. Pinned by a test with 60 agents.
6. **Harness refusals keep their existing sentences.** `HarnessError` gained
   optional `{ code, committed, next }`, but the ~60 throw sites in
   `packages/worker/src/agents/harness.ts` were not touched: each failure
   takes its calling tool's declared recovery, so the model gets a correct
   `next` for every path today, and a site that wants a more specific code can
   opt in later without a migration. Retrofitting sixty sites was outside this
   task's write boundary and would have churned messages that are already
   written for a person.

## What the M26-T3 and M26-T4 owners must know

**Fixture format (T3).** Every Laser tool can be read as a `LaserToolSpec`
without starting a session: after a module has registered its tools,
`laserToolRegistry()` (exported from `@lasercode/pi-extension`) holds one spec
per tool name, and `laserToolSpec(definition)` builds one from a definition
directly. A conformance fixture for a tool therefore needs only:

```jsonc
{
  "tool": "inspect_agent",
  "spec": { /* the LaserToolSpec, captured from laserToolSpec() */ },
  "prompts": [{ "task": "…", "expectedTool": "inspect_agent", "maxCalls": 2 }],
  "budget": { "inputTokens": 0, "outputTokens": 0 }
}
```

The runner should call `toolContract(spec)` for the schema-violation measure
(zero issues) and use `parseToolError()` on any recorded error result to check
the retry/unsafe-attempt measures — a recovered error is one whose `next` the
model then called.

**`ToolError` fields the UI renders (T4).** The transcript stores the thrown
message; `parseToolError(text)` returns `{ code, message, committed, next }`
or `undefined` for an error that is not a Laser tool error (an engine tool, an
MCP tool, a crash). Render `message` as the error body, `committed` as the
one-line fact about whether anything was saved, and `next` as the suggested
next call. Never show `code` as the headline — it is for correlation and for
the evaluation harness.

## Checkpoints

- **T1 done.** `packages/protocol/src/tool-contract.ts` (+49 tests),
  `packages/pi-extension/src/register-tool.ts` (+14 tests),
  `packages/worker/src/agents/errors.ts` (+3 tests), both barrels export.
  `pnpm -F @lasercode/protocol test` 515 passed; `pnpm -F
  @lasercode/pi-extension test` 218 passed; `pnpm -F @lasercode/worker test`
  1226 passed. Commit `a6ed4028`.
- **T2 done.** Ten tools through the helper (7 harness + `task_output` +
  `task_stop` + `web_search`); `bash` deliberately not (D-350.c);
  `docs/agents.md` §2 and §6 gained annotation columns. New tests: harness
  contract + error shape (subagents), task tools + error shape
  (background-work), `web_search` spec + error shape (web-access).

## M26-T4 — the transcript's error and preview rows

Owner: worker "Tool error and preview rows", branch
`agents/tool-error-and-preview-rows-90d4811e`, base `3e48f73c`. Write set:
`packages/ui` only, plus this section and the `docs/ux-elements.md` rows for
what it draws.

### A failed Laser tool row

A Laser tool fails by throwing its rendered `ToolError` (D-359.a). The UI
never matches prose: it calls `parseToolError(text)` and, when that answers,
draws the fields.

| Path | What |
| --- | --- |
| `packages/ui/src/components/assistant-ui/elements/tool-error.tsx` | `ToolErrorReport` — the parsed failure; falls through to the existing `ToolError` when the text is not one |
| `packages/ui/src/components/assistant-ui/elements/tool-fallback.aui.tsx` | an unknown/Laser tool's row draws the report in its `error` section instead of the raw result |
| `packages/ui/src/components/thread/ToolRow.tsx` | every known tool's body and every collapsed row's peek go through the report too |

Three things, in the order a person reads them:

1. **the message** as the headline, in primary ink next to the danger mark —
   the row already carries the danger rail and the alert icon, and a sentence
   written for a person reads better in ink than in red;
2. **what was saved**, in its own tone: `text-attention` for "Some of this was
   already saved." — the line that may need you — and `text-danger-quiet` for
   "Nothing was changed.", which is a statement, not a task. The report also
   carries `data-committed="true" | "false"`;
3. **the next step**, quieter, under a `Next` eyebrow with its own mark, so it
   reads as the suggestion it is.

The `code` is never the headline. It draws as a small typed chip
(`data-slot="tool-error-code"`) for correlation and for the evaluation
harness. A collapsed row's peek shows the headline and the saved line only.

An error that does not parse — an engine tool, an MCP tool, a crash, a capture
from before the contract, or an excerpt of a folded body — renders exactly as
it did before, through `ToolError`.

### Preview rows, and the result shape they detect

A preview draws through **the same component the person's git actions use**:
the card the commit / push / branch / pull-request dialogs show between Review
and Confirm was extracted to
`packages/ui/src/source-control/change-preview.tsx` (`ChangePreview`;
`GitChangePreview` maps a `GitActionConfirmation` onto it), and
`packages/ui/src/components/thread/ToolPreviewRow.tsx` mounts it in the
transcript. `git-dialog.tsx` now renders the same card, so the two cannot
drift.

**The shape the transcript detects** (`packages/ui/src/components/thread/tool-preview.ts`).
M21-T17 and M25-T4 producers: match this and your `preview: true` answer draws
itself.

```jsonc
{
  "preview": true,                        // the literal boolean — required
  "digest": "b8f0c1a4e93d5f17",           // required; the confirming call repeats it
  "summary": "Export SPEC-12 revision 4 to the tracker as a new issue.",
  "target": "acme/laser",                 // optional: where it would land
  "branch": "main",                       // optional
  "remote": "origin",                     // optional
  "items": ["SPEC-12", "TASK-44"],        // optional: what it would write
  "confirmWith": "export_project_work"    // optional: the tool that takes the digest back
}
```

| Rule | Value |
| --- | --- |
| Where it is read from | the result's `details` (a Laser tool's declared output), then the result object itself, then JSON in the result text — a stored transcript keeps whichever the session had |
| Required | `preview === true`, a `digest` matching `^[A-Za-z0-9][A-Za-z0-9._:-]{7,127}$`, a non-empty `summary`. Any one missing and it is an ordinary result, drawn the ordinary way |
| Bounds | `summary` ≤ 400 chars, `target`/`branch`/`remote`/`confirmWith` ≤ 200, `items` ≤ 200 entries of ≤ 400 chars (the card paints the first 50 and says how many more), a body over 64 KB is not searched for one |
| Untrusted | every field is text a model or a service wrote: clamped, escaped by React, wrong types dropped rather than rendered |

The row sits **outside the fold**, beside an approval, because a write that
has not happened yet is not a detail, and it has **no confirm button**: the
contract's handshake is a second tool call carrying `confirmed: true` and this
digest, so the row says that in words ("It goes ahead only when the agent asks
again with this exact preview through `<tool>`") and shows the digest. A
control that pretended to confirm would either do nothing or claim an
authority the transcript does not have.

### Validation

`packages/ui/test/thread/tool-contract-rows.test.tsx` (16 tests): both
`committed` values with their tones, the code never as the headline and the
rendered three lines never as one block, the alert role, the collapsed peek, a
non-conforming error unchanged (asserted as "the pre-existing `tool-error`
element with the text intact and no report" — a named proxy for "unchanged",
not a pixel comparison), the preview card with its digest and zero buttons,
its group role and name, the same card under `GitChangePreview` and
`ToolPreviewRow`, and the detection rules and bounds above.

Not run by an agent: the browser. `pnpm -r build && pnpm sandbox` and the two
themes/widths are the person's (D-342).
