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
(D-342).

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
