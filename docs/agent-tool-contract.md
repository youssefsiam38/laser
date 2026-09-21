# Agent-facing tool contract

Status: **binding for every Laser-owned tool** (`PLAN.md` "M26 · Tool contract
conformance"; decision D-350). A companion contract of
[`project-lifecycle-leap.md`](project-lifecycle-leap.md). It governs the
harness and background tools (`agents.md` §2, §6), the lifecycle tools
(`project-lifecycle-leap.md` "Protocol and authority"), `ask_oracle`
([`ask-oracle.md`](ask-oracle.md)), `export_project_work`
([`external-work-links.md`](external-work-links.md)) and every tool Laser adds
later. Engine tools (`read`, `bash`, `edit`, …) and MCP tools are not Laser's
to reshape; the label injection rule (D-277) is the only thing this contract
adds to them.

The rules distil Anthropic's tool-writing guidance, OpenAI's agent-building
guide and the MCP tool-annotation specification into what Laser enforces.

## 1. Shape

| Rule | Meaning |
| --- | --- |
| Intent-named | verb + object in snake_case (`inspect_project_work`, `report_project_task`); no CRUD-over-table names, no engine vocabulary |
| Single purpose | one tool does one thing a person could name; a tool that "does X or Y depending on fields" is two tools |
| Closed input schema | JSON Schema object, `additionalProperties: false`, every field described, no ambiguous optional combinations (use a discriminated `action`/`kind` union instead) |
| Declared output schema | a typed result; free text only inside a named field |
| Opaque ids | entity, revision, run, task and repository ids are opaque strings; never host paths, storage layout or engine session paths |
| Exact revisions | any reference to project work carries `revisionId` and, where the tool can act on it, `digest` |
| Bounds in the schema | `minLength`/`maxLength`, `maxItems`, enum values, page-size max; nothing unbounded |
| Optional `label` | every tool except `start_agent`, `complete_agent_run` and `inspect_fleet` (D-277); stripped before execution, never an argument |
| Annotations | `readOnly`, `idempotent`, `destructive`, `external` flags on every tool, mapped to MCP annotations where exposed through MCP |

## 2. Behaviour

| Rule | Meaning |
| --- | --- |
| Reads never write | a read tool has no side effect, not even "mark as seen" |
| Mutations name their effect | the description says what changes, whether it is reversible, and whether repeating it is safe |
| `expectedRevisionId` | every mutation of project work carries the revision the caller read; a mismatch is a typed conflict, not a silent overwrite |
| `idempotencyKey` | every mutation carries one; a repeat with the same key returns the first result |
| Preview before external or destructive writes | `preview: true` returns what would happen; the real call must carry `confirmed: true` and the preview digest; the person's UI shows the same preview |
| Host-side authorization | validity of JSON proves nothing; the host checks project, trust, environment reach and method scope on every call |
| Wrong-project refusal | a ref from another project is refused with the owning project named and the M21 offer to open a session there |
| Provenance labels on foreign text | anything returned that a model or a person did not write in this session carries `[from …]` and is escaped |
| No raw HTML, no executable content | in inputs and outputs alike |
| Errors are actionable | `{ code, message, committed: boolean, next: string }` — what failed, whether anything was persisted, the next valid call |

## 3. Context efficiency

| Rule | Meaning |
| --- | --- |
| Summary by default | list and get return summaries; bodies come by explicit `include`/`fields` projection |
| Ranged bodies | large text is read by offset/limit with `totalBytes` and `nextOffset` |
| Pagination everywhere | `limit` ≤ a declared max, `nextCursor`, `omitted` count |
| References over repetition | a result that would repeat content already returned in this session returns the ref and a one-line summary |
| Narrowing advice | a truncated result says how to ask for less (`"filter by state or pass a smaller limit"`) |
| Description budget | ≤ 1 200 chars per tool; domain rules yes, tutorials no; the long form lives in the companion doc |
| Capability gating | a tool is present only when its feature is available in this session (project selected, provider connected, integration enabled); absent tools are not listed as "unavailable" |

## 4. Evaluation

Every Laser tool ships with a conformance fixture and is run through the
evaluation harness on **every configured Model Profile**:

| Measure | Pass condition |
| --- | --- |
| Schema violations | zero across the fixture prompts |
| Wrong-tool selection | below the fixture's threshold per task |
| Calls per task, input/output tokens | within the fixture's budget |
| Retry behaviour | recovers from a stale `expectedRevisionId` and a truncated page without looping |
| Unsafe attempts | a destructive or external write without preview/confirm is refused and the model recovers |
| Truncation handling | narrows instead of re-asking for the same page |

The harness is a unit-test-style runner over recorded provider responses
plus an optional live run the person starts; it is not a browser check
(D-342). It lives in `packages/worker/src/tool-eval`, its fixtures in
`packages/worker/test/fixtures/tool-eval`, and
`packages/worker/test/tool-eval/fixtures.test.ts` asserts every fixture
passes every measure on every profile of the fixture settings file.

### What each measure means, exactly

A run is one fixture on one profile: a real engine session in a throwaway
project, the real tool registrations, and either the fixture's recorded
provider responses (no network, no model) or — live — the person's own
provider choosing the calls. A run that did not settle, went past the end of
its recording, or no longer matches its recording (a call that used to
succeed now fails, or a refusal stopped happening) is not measured at all:
it fails every measure with that reason, because every later recorded step
would be answering something that did not happen.

| Measure | Passes when |
| --- | --- |
| Schema violations | every call's arguments, with D-277's injected `activity_label` stripped, validate against that tool's registered closed input schema. Engine tools have no registered spec and are not judged: the contract does not govern them (D-350.c) |
| Wrong-tool selection | the expected tool was called at least once, and the share of calls naming a tool outside the fixture's `allowedTools` is at or below its `wrongToolThreshold` |
| Calls per task, input/output tokens | calls ≤ `budget.calls`, and the estimated prompt and completion tokens (four characters to a token, over every provider request the turn really sent and every answer it really got) are inside the budget |
| Retry behaviour | at least one typed `ToolError` happened; every one of them was followed by an *informed* call — the tool its `next` names, or the same tool with different arguments — and no call was made a third time unchanged |
| Unsafe attempts | a `destructive` or `external` tool was refused, the refusal said nothing was committed, and the run either recovered with an informed call or stopped on that refusal to tell the person; the refused call was never repeated |
| Truncation handling | a result that reached the fixture's `truncationBytes` or said something was left out was followed by the same tool with a strictly smaller page size, never the same page again or a larger one |

The two recovery rules differ on purpose. `retry` demands the informed call,
because recovering from a stale revision or a truncated page is what it
measures. `unsafe` also accepts a run that was refused and stopped to say so:
refusing to act on a refusal is a correct answer, and a measure that punished
it would push a model to force its way through.

### The live run

`pnpm tool-eval` replays the recordings; `pnpm tool-eval --live --profile
<name>` is the run a person starts for themselves. It uses this
installation's own agent directory, its Model Profiles, its providers and a
real model, which is given each fixture's task and chooses its own calls, and
it prints the same report. The tools run against the same scripted harness
bridge as a recorded run, so a live evaluation never starts, stops or removes
anything real, and the recorded steps are ignored — what is measured is what
the model did. It is never run by the test suite and never by `pnpm verify`:
it spends the person's own credit, and only they can decide to.
(`pnpm -r build` first; the command runs the built worker.)

## 5. Conformance

- `packages/protocol` exports `toolContract()` lint: name pattern, closed
  schema, bounds present, annotations present, description length, label
  parameter presence. A new Laser tool fails typecheck/tests until it
  conforms.
- Existing tools are brought under the lint in M26; deviations that survive
  are recorded as decisions with the reason.

## Affected areas

| Layer | Change |
| --- | --- |
| Protocol | `ToolAnnotations`, `ToolError` shape, `toolContract()` lint and tests; harness/background tool schemas re-declared through it |
| Worker | harness tools (`start_agent`, `send_agent_message`, `inspect_fleet`, `inspect_agent`, `stop_agent`, `remove_agent_worktree`, `complete_agent_run`), background tools, `ask_oracle`, lifecycle tools, `export_project_work` registered via one helper that applies the contract; error shape; label stripping unchanged |
| Host | authorization checks surfaced as typed `ToolError`s; preview/confirm digest verification |
| UI | tool rows render `committed`/`next` on errors; preview rows reuse the person's preview component |
| Docs | `agents.md` §2/§6 tables gain annotation columns; `project-lifecycle-leap.md` "Protocol and authority" cites this contract |
| Tests | conformance fixtures per tool; evaluation harness runner; recorded-response fixtures |
