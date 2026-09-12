# MCP client: discovery, context and safe composition

## Status and scope

M16-T25, milestone 1: **research and proposed implementation contract, not shipped
behaviour**. Source baseline: `8c92c7b946ec98f134fc87d54cf9e244fe758cbc`.
Research retrieved on 2026-09-12. The implementation milestones below require
separate assignments and verification. Until then, [mcp.md](mcp.md) describes the
current product; this document does not claim its old defaults have changed.

The design follows every recommendation in the [client best-practices guide][guide].
Where the guide offers alternative strategies or runtimes, implementing the
recommendation means choosing and justifying one, not installing every alternative.

**Decisions proposed for review:**

- Every server uses progressive discovery by default, regardless of tool count.
  Only a person's explicit per-server Advanced override preloads tools.
- A **2% share of the selected model's context window**, not forty tools,
  budgets automatic discovery responses. Overrides are measured against that
  share and warned about, not silently overridden.
- Keep the MCP gateway and script definitions stable throughout a conversation.
  Discovery returns schemas in tool-result messages; it does not register more
  provider tools. Explicitly preloaded tools are snapshotted before the first request.
- Reuse the pinned adapter's keyword retrieval, execution, approval, lifecycle,
  schema rendering and SDK cache. Fix upstream internals with tracked patches;
  do not implement a second MCP client in the UI or host process.
- Separate durable configuration from a session's connection choices. The model
  may use only configured, trusted, person-enabled servers. It cannot turn a
  person's disabled server back on or write configuration.
- Replace the script executor's Node `vm` isolation before claiming safe execution
  of model-generated code. Retain its broker and evaluate authorization per call.

Here, **host-side cache/broker** means the MCP host application's trusted worker,
not `packages/host`. The latter still only routes protocol requests. Only worker
and companion may import adapter code (AGENTS.md invariant 6b). Any companion
integration belongs in its existing MCP module, not a new extension/package.

## Evidence and citation conventions

All source coordinates below refer to the baseline and its installed dependencies:

| Prefix | Exact location |
| --- | --- |
| `P` | `packages/protocol/src/mcp.ts` |
| `W/` | `packages/worker/src/mcp/` |
| `U/` | `packages/ui/src/components/settings/mcp/` |
| `A/` | `packages/worker/node_modules/pi-mcp-adapter/`, version **2.33.0**, with `patches/pi-mcp-adapter@2.33.0.patch` |
| `S` | `node_modules/.pnpm/@modelcontextprotocol+client@https+++pkg.pr.new+@modelcontextprotocol+client@3b205e7dd2f997b6a87e479e36421f7eaa2058e0/node_modules/@modelcontextprotocol/client/dist/index.mjs` |

The SDK revision is the adapter's actual pinned dependency, not a claim about a
released generic SDK. Source inspection establishes implementation paths, not
successful runtime/security acceptance. New patches must be recorded in
[upstream.md](upstream.md), extending the existing exact-version patch precedent.
No upstream issue or PR has been filed for this milestone.

The [documentation index][index] was fetched alongside the guide, its linked
[caching utility][caching], [tools][tools] (including security, errors and output
schema), and [agent skills][skills]. The index led to [discovery][discover],
[pagination][pagination], [multi-round-trip requests][mrtr] and [schema/reference
rules][basic]. Provider search and caching references appear below. The guide's
sandbox alternatives were also examined; their selection is recorded under
execution defaults.

## Requirement-by-requirement coverage

`Yes: adapter` means a reusable adapter change belongs in the tracked adapter
patch. `SDK` identifies a lower-level gap: prefer a correction in the pinned SDK;
a narrowly scoped adapter workaround is acceptable only with tests proving the
same contract. `No` means product mapping, protocol, UI or tests suffice.

### Discovery and context

| ID / guide recommendation | Laser today (source) | Pinned adapter/SDK today (source) | Gap and proposed change | Owner/location | Upstream patch? |
| --- | --- | --- | --- | --- | --- |
| D1 · Fetch definitions, defer model injection | `P:345–467` gallery mixes direct/on-demand; `P:473` fixes cap at 40; `U/model.ts:238,411,592,622` defaults direct | `A/metadata-cache.ts:195–240` reconstructs definitions; `A/proxy-modes.ts:610,675,1010` supplies describe/search/call | Progressive for **every** server; explicit override only. Cache availability is not model exposure | `P`, `W/adapter-config.ts`, `U/model.ts`, gallery/import/add flows | No for mapping |
| D2 · Context-window percentage threshold; small sets may preload | `U/model.ts:238` counts tools, not tokens; no model budget in policy | `A/index.ts:269–279` has lazy direct tools but no context-share policy | Replace count heuristic with 2% token budget. Choose the guide's progressive path even below it, per the person's instruction; threshold controls discovery volume, never an implicit eager mode | Worker session policy and protocol diagnostics | No; adapter hook if budget cannot be passed into discovery |
| D3 · Keyword/embedding/subagent/hybrid strategy choice | `W/session.ts:74` delegates factory to adapter | `A/search-ranking.ts:12–18,105–185,205–253` weighted keyword/phrase/prefix matching, coverage gates, deterministic ranking, cached tokenization | Ship existing ranked keyword strategy (an equivalent keyword retrieval approach, **not** call it BM25). Add a strategy interface accepting an authorized catalog snapshot; leave embedding/subagent/hybrid implementations unbuilt | Adapter search seam driven by worker | Yes: small strategy seam, not new ranking engine |
| D4 · Consider provider-native search | `W/session.ts:74` is provider-neutral | `A/index.ts:1384–1403` exposes a normal gateway | Keep provider-neutral discovery for consistent trust filtering and stable requests across Pi providers. Native deferred references remain a future strategy, not a prerequisite | Worker/provider boundary; documented decision | No |
| D5 · Catalog: lightweight search with concise matches | No separate product search policy; `W/adapter-config.ts:47–50` maps exposure | `A/proxy-modes.ts:675–817` searches all known enabled metadata, default 12 results **with schemas**; `A/mcp-code.ts:189–218` returns summaries | Default names/descriptions; group by server; page and token-budget results. Search only known authorized tools, report which servers still need connection rather than imply an exhaustive negative | Adapter gateway/search and worker policy | Yes: result levels/grouping/budget |
| D6 · Inspect one tool: full input/output schema and documentation | `W/inspector.ts:424–449` provides UI input schemas, not session discovery state | `A/proxy-modes.ts:650–670` renders input shape and holds metadata in details; `A/mcp-code.ts:222–257` includes output schema but not a typed return shape | Inspect returns complete original input/output schemas plus readable input/return shapes and documentation. Never substitute a lossy shape for the actual contract | Adapter describe; protocol/UI inspector | Yes: full model-facing descriptor/return shape |
| D7 · Execute after inspection, without all definitions in context | `W/adapter-config.ts:48` maps `search` to lazy direct activation | `A/proxy-modes.ts:1010–1582` already routes gateway calls; `A/index.ts:356–377` activates searched direct tools | Use `directTools: false` for progressive servers, **not** `"search"`; gateway calls remain available without direct registration | Worker config mapping; adapter stable-surface setting | No for routing; test/fix freeze gaps upstream |
| D8 · Name-only / name+description / full-schema levels | UI exposure choices are not response-detail choices (`U/McpAddDialog.tsx:347–379`) | `A/proxy-modes.ts:683–685` only `includeSchemas`; script search only summaries (`A/mcp-code.ts:198–210`) | Explicit `names`, `summary`, `full`; identical semantics inside/outside scripts; `describe` always full for one tool | Adapter gateway/script discovery | Yes |
| D9 · Group tools by their server | `P:175–205` tool information; `U/McpServerList.tsx` groups configuration rows, not model discovery | `A/search-ranking.ts:21–25` preserves server identity; `A/proxy-modes.ts:785–815` renders a flat ranked list | Group the ranked page by server, retaining per-tool rank and globally correct continuation; never group by untrusted server-reported title as identity | Adapter result projection | Yes |
| D10 · Preserve cached prompt prefix when definitions are discovered | Running sessions receive a config snapshot (`W/session.ts:68–79`); no provider-array regression asserted here | `A/index.ts:356–377` appends activated names; `:705–722` supports `freezeDirectTools`; other paths still synchronize tools | Stable gateway route: MCP-owned `tools` entries byte-identical across search/inspect/list refresh. Freeze explicit direct definitions before first request. Inspect the actual provider request, not just active-name order | Worker session setup + adapter freeze; provider-capture tests | Potential adapter fixes; **dedicated prompt-cache review** |
| D11 · Disconnect at conversation boundaries, not to trim each turn | Durable settings already apply to later sessions (`W/session.ts:68–79`); startup maps to lazy lifecycles (`W/adapter-config.ts`) | `A/lifecycle.ts:30,135–160,407–419` manages idle shutdown/reconnect; `A/index.ts:1176` can resync | Model disable blocks new dispatch immediately but queues physical disconnect until end of the current prompt invocation and in-flight calls settle. Never remove schemas/history mid-conversation. Direct override removal takes a new conversation | Worker session lifecycle + adapter lifecycle hook | Yes if lifecycle cannot defer close; prompt-cache review |
| D12 · Consult provider caching guidance | Worker snapshots config (`W/session.ts:68–79`), without a measured provider-prefix budget | Freeze/append facilities (`A/index.ts:356–377,705–722`) exist, but do not themselves prove provider-cache hits | Adopt stable tools/system prefixes; definitions arrive in appended results. Do not promise cache hits, which depend on provider/model/minimum prefix/TTL | This design; capture-based regression | No |

### Dynamic servers and definition caching

| ID / guide recommendation | Laser today (source) | Pinned adapter/SDK today (source) | Gap and proposed change | Owner/location | Upstream patch? |
| --- | --- | --- | --- | --- | --- |
| C1 · Registry of available servers with high-level descriptions | `W/store.ts:148` returns enabled trusted definitions; `W/session.ts:48,68` snapshots them; disabled servers are omitted | `A/proxy-modes.ts:417–504` status lists configured servers, but no ranked available-server catalog | Search configured-but-unconnected, trusted, person-enabled servers by configured label/description/catalog description. No filesystem/env/auth values in descriptions | Protocol server metadata; worker registry; adapter gateway verbs | Yes for gateway verbs; product policy stays in worker |
| C2 · Connect only when needed, minimal always-on set | `P:77–80` startup vocabulary; `U/model.ts:586` on-demand default | `A/proxy-modes.ts:932–1009` explicit connect; `A/lifecycle.ts` existing lifecycle management | `enable_server` leases a trusted server to the caller's session, connects through existing manager, lists capabilities and reports sign-in failures honestly. Concurrent enables coalesce | Worker runtime bridge + adapter manager | Yes: programmatic session-control seam |
| C3 · Disable irrelevant servers and free context | `P:514` disconnect controls **inspector**, not session; `W/inspector.ts` owns its connections | `A/proxy-modes.ts:125–130` disabled response points at terminal commands; lifecycle can close connections | `disable_server` marks session unavailable, defers transport close to safe boundary. Frees connection resources/future definition output, **cannot erase past context**. UI override wins over model enables | Worker session control; protocol status/UI | Yes; no config-file writes |
| C4 · Skills can name servers needed only on invocation | Existing trusted skill discovery is described in `docs/architecture.md:147–151`; MCP session factory is independent (`W/session.ts:65–80`) | Scripting skill exists (`A/skills/`); gateway descriptions reference it (`A/index.ts:1129`) | Let a skill's instructions name registry servers and call the same enable verb when used. No standard MCP dependency field exists in the linked skills spec; do not invent automatic execution of arbitrary frontmatter | Trusted skills instructions + worker registry | No; no skill installer or new extension |
| C5 · Host-side memoized definitions, separate from model context | `W/engine.ts:156–168` loads persistent cache; `W/inspector.ts:110–119` counts it | `A/metadata-cache.ts:43–80,114–139` persistent metadata; `S:2120–2209` cache generations and freshness reads | Reuse SDK cache as freshness authority; keep catalog indexing distinct from retained stale metadata. Counts may be stale/unknown and must say so | Adapter cache/index integration; worker diagnostics | Yes: persistent-cache corrections |
| C6 · Honor each list's `ttlMs`/`cacheScope`, including discovery/resource reads | Worker wraps engine, does not implement wire caching (`W/engine.ts:133–168`) | `A/init.ts:599–606` saves tool hints; `A/metadata-cache.ts:129–138` honors positive/zero TTL but missing/invalid TTL falls back to **7 days**. `S:3782–3810,3882–3910` defaults missing TTL to 0 and missing scope to private | Use 0 for missing/negative TTL; no seven-day freshness assumption. Audit persistent cache separately from SDK cache, all list methods and resource reads; retain stale metadata only as marked historical data | Adapter persistent cache; SDK integration | Yes: adapter; SDK aggregate fixes below |
| C7 · Correct method/parameter/cursor and authorization cache keys | Persistent cache indexes by server name plus config hash (`A/metadata-cache.ts:83–112`, used by `W/engine.ts:162–168`) | `S:2143–2175` supports server/principal partitioning; `A/server-manager.ts:1089–1117` supplies no explicit partition. Persistent hash includes bearer/header inputs but not a proven OAuth authorization generation | Partition by scoped server identity, config revision and opaque authorization generation; rotate/evict on auth changes. Do not share private data across sessions with different principals, even with the same server name | Adapter auth/cache; worker scope identity seam | Yes: adapter. Never copy raw credentials into cache keys/UI |
| C8 · Immediate `list_changed` invalidation and re-index | Worker receives status snapshots, not an invalidation-aware session catalog (`W/session.ts:75–79`; companion `modules/mcp.ts:74–84`) | `S:2126–2130,3186–3194,4330–4353` has invalidation/generation handling; `A/server-manager.ts:1142–1159` publishes refreshed tools; `A/search-ranking.ts:205–223` rebuilds on metadata-array identity change | Mark adapter catalog/persistent aggregate stale immediately, before awaiting refetch. On failure never call old schemas current; successful refresh replaces revision/index atomically. Callback must update hints too, not reset old TTL with a new timestamp | Adapter notification/cache publication + worker status | Yes: adapter; preserve SDK generation fences |
| C9 · TTL expires on next access, not a polling interval; recover from errors | Worker delegates lifecycle (`W/session.ts:74`) | `S:2203–2209,3808–3835` reads only fresh responses; adapter has health/backoff (`A/lifecycle.ts:135–160,383–407`) | Re-fetch on demand; keep health checks distinct from TTL polling. Allow marked stale display on network error, not stale authority for new execution. Unknown-tool/schema mismatch can invalidate before TTL; no automatic retry of side effects | Adapter catalog access + execution error path | Yes where catalog bypasses SDK freshness |
| C10 · Paginated results have independent freshness; invalid cursor restarts | Inspector receives aggregated tools (`W/inspector.ts:137–160`) | `A/server-manager.ts:1448–1475` takes first-page hints; **SDK already auto-aggregates** `S:3727–3780` and caches using page-one hints | Fix per-page method/params/cursor clocks, or aggregate freshness bounded by earliest absolute expiry, with consistent scope and complete generation. Invalid cursor discards walk and restarts; repeated cursor must not masquerade as complete | Pinned SDK cache/pagination, adapter aggregate persistence | Yes: SDK (or tested adapter bypass using raw page requests) |
| C11 · Do not cache input-required/interactively retried responses | No worker cache for these (`W/engine.ts:133–168`) | SDK cacheable methods call typed request path (`S:3751–3780,3894–3909`); no claim here that all MRTR retry variants are excluded | Test `input_required`, `inputResponses`, `requestState` exclusion, including resource reads and discover. Add exclusions where absent; partial/interactively conditioned results must never enter reusable metadata | SDK boundary, adapter conformance tests | Conditional SDK patch; not presumed covered |

### Programmatic calling, errors and safety

| ID / guide recommendation | Laser today (source) | Pinned adapter/SDK today (source) | Gap and proposed change | Owner/location | Upstream patch? |
| --- | --- | --- | --- | --- | --- |
| E1 · Compose calls in code; return only selected outputs | `W/adapter-config.ts:197` enables script mode | `A/mcp-code.ts:143–186,277–319,373–389` brokers intermediate results separately; `A/mcp-script-worker.mjs:100–109` captures emit/console | Preserve composition/filtering/loops. Script traces remain bounded audit metadata, not duplicate raw results in model context | Adapter script runner; worker integration tests | No for basic composition |
| E2 · Generate typed API from input and optional output schemas | Worker loads adapter (`W/engine.ts:133–168`) | `A/mcp-code.ts:222–244` describes input TypeScript and output schema; worker proxy exposes functions (`A/mcp-script-worker.mjs:68–96`) | Keep lazy typed descriptors, add return TypeScript for `structuredContent`; retain original JSON schemas. Do not inject a generated definition for every server tool into the prompt | Adapter `ts-shape.ts`, describe/script descriptors | Yes: output typing/descriptor completeness |
| E3 · Missing output schema: generic type **or** host-brokered typed extraction | No extractor in worker's MCP wrapper (`W/session.ts:65–80`) | `A/mcp-code.ts:240–244` includes output schema only when present | Choose the guide's simple generic path: `unknown` result payload with runtime narrowing. Do not add a second model, hallucinated schema, or per-loop extraction. If extraction is ever added it must use the broker, validate output, and stay outside loops | Adapter type projection and script guidance | No extractor; small type projection patch |
| E4 · Real sandbox; no direct network or arbitrary I/O | Script mode is enabled without a worker isolation override (`W/adapter-config.ts:197`) | `A/mcp-script-worker.mjs:113–122` uses Node `vm` with code generation disabled; host functions are injected. `A/mcp-code.ts:277–285` uses worker thread with empty env | Replace vm executor with restricted QuickJS-in-Wasm runtime, JSON-only bridge, no filesystem/network/process/module imports. Node explicitly says vm is **not** a security mechanism ([documentation][node-vm]) | Adapter script executor and packaged runtime assets | **Yes; dedicated security review** |
| E5 · Credentials held by host, not generated code | `W/session.ts:60–62` resolves secrets into worker configuration | `A/mcp-code.ts:148,277–285` dispatches in host, empty worker env; script API exposes call/describe/search | Keep credentials outside guest memory. Pass only bounded JSON args/results, never host object references or configuration. Treat returned secret-like data as untrusted tool output, not proof the executor leaked auth | Adapter broker + worker secret boundary | Preserve; test with sentinel credentials |
| E6 · Per-call authorization, not script-wide approval | `W/adapter-config.ts:121–122` maps ask-first policy; `W/session.ts:107–180` preserves extension dialogs | `A/mcp-code.ts:148` calls normal executor with origin `script`; `A/proxy-modes.ts:1353` calls approval; `A/tool-approval.ts:92–176` offers broker event, allow once/session, denial/headless refusal | Preserve every-call evaluation; add script-run-scoped categorical grants only when person explicitly chooses them. Script approval never bypasses inner approval; direct and script inputs follow same policy | Worker permission bridge + existing companion MCP module; adapter approval seam | Yes if run identity/grant scope missing; **dedicated approval review** |
| E7 · Cross-server results are untrusted inputs; review outgoing inputs | UI controls `approve`; inspector Run is an explicit person action (`W/inspector.ts:226–255`) | `A/tool-approval.ts:100–112` passes actual args to broker; fallback preview truncates at 500 chars (`:161–169`) | Show complete expandable, safely rendered outbound arguments and destination for sensitive calls. No approval inferred from source server annotations or script text. Apply identical review even after arbitrary script transformation; truncation is not exfiltration prevention | Worker approval contract + transcript approval surface | Yes for broker/run metadata; UI/product rules local |
| E8 · Resource limits: timeout **and memory** | Script enabled, no product limits policy (`W/adapter-config.ts:197`) | `A/mcp-code.ts:15–16,118–120,173–184,326–369` has 30s default, arbitrary positive requested timeout, 16 MiB transfer budget and cancellation; no worker heap limit (`:277–285`) | Bound execution heap, stack, timeout, queued calls, code and emit volume; terminate guest and fence pending broker calls on abort/exit. Preserve committed-side-effect trace | Adapter executor/broker | Yes |
| E9 · Validate/filter/truncate output before model sees it | Inspector guards results (`W/inspector.ts:251–255`) | `A/mcp-code.ts:293–301` accumulates output until final guard `:373–389`; `A/mcp-output-guard.ts:14–16,113–165` bounds final output/details | Enforce incremental output limit **before** unbounded accumulation/IPC; keep final guard and image validation. Bound trace/details too; no unbounded spill-file side channel | Adapter script runner/output guard | Yes: streaming accumulation limits |
| E10 · Convert `isError: true` to thrown errors; surface uncaught failures | Worker exposes adapter script semantics unchanged (`W/session.ts:74–76`) | `A/proxy-modes.ts:1489,1518` recognizes isError; `A/mcp-code.ts:155–169` creates `{ok:false,error}`; `A/mcp-script-worker.mjs:50–65` resolves, never rejects. Uncaught JS errors are surfaced (`A/mcp-code.ts:348–363`) | Script wrappers throw typed bounded errors for tool/protocol/approval failures; `try/catch` works. Uncaught error is script failure result, with partial-call trace; no automatic rollback/retry claim | Adapter guest wrapper and guidance | Yes: deliberate API behaviour change |
| E11 · Tool security: inputs/results validation, sensitive-call confirmation, timeouts, audit | `P:94` approve policy; `W/inspector.ts:251–255` guards display; no new direct/script guarantee proven here | `A/server-manager.ts:1096` supplies schema validator; `S:3837–3865` isolates invalid output schemas; `A/tool-approval.ts` confirms; `A/mcp-code.ts:126–142` tracks calls | Validate args and declared structured output, reject bad schemas individually. Log destination, decision, duration/outcome under existing retention/redaction; don't persist a new raw credential-bearing audit database | Adapter validators/call path + worker logs/approval UI | Tests first; patch absent input bounds/validation |
| E12 · `$ref` safety, dialect handling, bounded validation (linked tools security) | Worker relies on adapter validator (`W/engine.ts:133–168`) | `A/json-schema-validator.ts` and `S:3837–3865` compile output validators; no network-reference/security acceptance performed | Local refs only; never fetch external refs. Support default JSON Schema 2020-12, fail unsupported dialect/unresolved ref per tool; bound schema depth/count and compilation time | Adapter validator/SDK schema path | Conditional adapter/SDK patch after negative tests |
| E13 · Combine discovery with scripts to avoid definition and result overhead | Both gateways enabled by same snapshot (`W/session.ts:68–79`) | `A/mcp-code.ts:189–257` already exposes search/describe inside scripts | One authorized catalog, levels, revisions and budgets for both paths; discover → inspect → script integration test with large intermediate data, small final output | Adapter shared projection + worker real-engine test | Shared patches above, no second implementation |

## What the current cache does well—and what it does not prove

There are **two distinct caches**, not one missing feature:

1. The SDK response cache knows method/resource keys, freshness, scope partitions,
   invalidation generations and JSON-copy mutation barriers (`S:2120–2209`). It
   defaults missing TTL to zero and missing scope to private. It also retains
   definitions for schema validation without treating that retention as freshness.
2. Adapter `mcp-cache.json` reconstructs metadata without live connections. It
   stores tool/output schemas and configuration identity, and carries `toolListHints`.
   It is useful for startup and registry display; it is not automatically a
   spec-compliant fresh, authorization-partitioned cache.

**Concrete risks, not hypothetical completion claims:**

- `A/metadata-cache.ts:35–36,129–138` falls back to seven-day freshness when TTL is
  absent/invalid. That disagrees with the chosen zero-TTL policy and the SDK default.
- Both adapter and SDK aggregation retain first-page hints. A later page can
  expire earlier; saving that aggregate with page one's TTL can overstate freshness.
  `A/init.ts:606` stamps persistence time, not each page's receipt time.
- Persistent identity hashing includes configured bearer/header values, but that
  is not proof of isolation across refreshed OAuth credentials, user changes,
  dynamic headers or identically named scoped servers. The SDK's partitioning
  support must not be mistaken for its use by the persistent cache.
- Successful list-change callbacks replace tools but do not carry fresh list hints
  (`A/server-manager.ts:1142–1159`). Failed refresh leaves old metadata available.
  Immediate catalog invalidation and truthful stale status need explicit tests.

**Ownership:** Laser can set defaults, pass scoped identities/auth generations and
show truthful state. Correcting cache clocks, page handling and persistence belongs
in the adapter/SDK, with tracked patches. Do not bolt a competing fresh-cache layer
onto `packages/host`, or merely change a UI label while serving stale schemas.

**Person-facing guarantee:** “Tool information can change. We refresh it when the
server tells us it changed or when its saved information expires.” While refresh
fails: “Showing previously saved tools. Reconnect to check what is available now.”
Never guarantee that a server will send notifications, that cached authorization
is still valid, or that a tool shown in an old conversation remains callable.

## Claude Code and Codex: findings and choices

Public documentation is mutable. These findings describe the retrieved pages,
not unspecified older versions or every supported provider deployment.

| Source / concrete finding | Adopt / reject and why |
| --- | --- |
| [Claude Code MCP][claude], “Scale with MCP tool search”: **deferred by default**, names and server instructions at startup, no fixed per-server cap; descriptions/instructions truncated at 2 KiB each | **Adopt** default deferral and removal of count cap. **Differ:** use bounded searchable server summaries, not an unlimited startup inventory/instruction concatenation. Preserve full documentation on explicit inspect; do not silently truncate schema-critical input guidance |
| [Claude Code MCP][claude], “Exempt a server from deferral”: per-server `alwaysLoad: true` preloads every tool, irrespective of search mode | **Adopt directly:** person's per-server Advanced override. Ours is product-owned UI/config, not an engine environment setting; it applies to newly started conversations |
| [Claude search configuration][claude-search]: unset = defer; `auto` preloads below **10%**; `auto:N` changes share; discovery defaults to up to **five** relevant tools; model/provider fallbacks differ | **Reject** auto-preloading below 10% and universal 10% budget. Ours remains progressive below 2%, which budgets response detail. **Adopt** small schema batches. Do not incorrectly report that current Claude defaults to threshold-based `auto` |
| [Claude Code MCP][claude]: project trust/approval before helper execution; `get/list` can health-check approved servers; project disabled choices are respected | **Adopt** trust before execution, including env/helpers; a model cannot upgrade a person's disable/trust decision. Our research deliberately did not run health-checking list/get commands |
| [Claude Code MCP][claude]: OAuth, scoped config, cached remote tools, background connections, `alwaysLoad` may wait up to 5s; output warning at 10,000 tokens and configurable output handling | **Adopt** inspectability, host-held auth and nonblocking ordinary startup. **Reject** using warning-only output control as memory protection; bound script output before accumulation. Keep existing transports/OAuth instead of copying another client's config machinery |
| [Anthropic API search][anthropic-search]: deferred schemas become inline `tool_reference` blocks without rewriting tools prefix; [prompt caching][anthropic-cache] caches tools → system → messages | **Adopt** stable-prefix principle. **Reject for initial implementation** a dependency on provider-specific reference blocks: normal gateway results work across Pi providers. No claim that appending names to Pi's active list alone preserves API caching |
| [Codex MCP documentation][codex]: stdio and Streamable HTTP, OAuth, global/project configuration, enabled/disabled tool filters, startup/tool timeouts (10s/60s defaults on retrieved page), enabled/required controls and per-tool approval settings | **Adopt** bounded connects/calls, explicit tool filters and person-owned enable policy; already broadly present in adapter. **Reject** importing Codex config semantics as product settings or treating its CLI flags as proof of sandboxed MCP execution |
| [Codex source, pinned research revision][codex-source] (`tool_search_spec.rs:94`): searches deferred metadata with **BM25**, exposes matches on next model call, warns not to use resource-list tools for tool discovery. Handler uses shared default-limit constant; the spec tests pass 8, which alone does **not** establish a shipped default | **Adopt** dedicated tool discovery, deterministic keyword ranking and separate resources/tools. Reuse adapter's existing weighted lexical ranker rather than duplicate BM25. **Reject** asserting a universal Codex threshold/default result count from test values |
| [OpenAI API tool search][openai-search]: deferred tool search is an API facility, distinct from the Codex client | **Adopt** inspect-then-use and provider caching guidance. **Reject** conflating OpenAI Agents SDK/Responses documentation with installed Codex runtime behaviour |

### Read-only machine observations

`claude --version` reported **2.1.263 (Claude Code)**; `codex --version` reported
**codex-cli 0.151.0**. Both resolve from the person's local executable directory.
`claude mcp --help` lists add/get/list/login/logout/remove, project-choice reset
and serve; its help explicitly says unapproved project servers are not connected,
while approved get/list operations health-check. `codex mcp --help` lists
list/get/add/remove/login/logout and config/feature overrides.

These commands are evidence of installed versions and exposed management verbs,
**not** active MCP servers, effective discovery defaults or policy enforcement.
No credential files, session data or private configuration contents were read;
no login, list/get health-check, server mutation or agent request was issued to
either client. Public Codex source was pinned to
`ee6814bfa4889fe9b2b3dcc9cc8bdd91effa8ab8`; it is not attributed to the installed
0.151.0 binary without matching revision evidence.

## Measured context cost and defaults

### Playwright measurement

A temporary process ran the already-installed `@playwright/mcp@0.0.80` with
`--headless --isolated`, sent only `initialize`, `notifications/initialized` and
`tools/list`, then terminated it. No browser tool ran; no browser profile or
credentials were read. Server self-identification was Playwright
`1.63.0-alpha-2026-08-31`; negotiated protocol `2025-11-25`; **24 tools**.
The package version and server-reported version are deliberately both recorded.

Counted with `tiktoken 0.14.0`, encoding `o200k_base`, compact UTF-8 JSON
(`ensure_ascii=False`, separators `(',', ':')`):

| Representation of all 24 tools | Bytes | Tokens |
| --- | ---: | ---: |
| Array of `{name}` | 699 | 141 |
| Array of `{name, description}` | 2,732 | 533 |
| Array of `{name, description, inputSchema}` (plus outputSchema if supplied) | 15,921 | 3,402 |
| OpenAI-style `{type:"function", name:"playwright_" + name, description, parameters:inputSchema}` | 16,593 | **3,522** |

Full tool schemas ranged from **45 to 303 tokens** individually. A count cap
therefore ignores a 6.7× size spread even within this one server. All summaries
cost **84.9% less** than the OpenAI-style definitions; names cost **96.0% less**.
These are tokenizer measurements, not billed provider usage: framing, schema
rewrites, other tools, system instructions and provider tokenizers add differences.

Compact raw tool-array SHA-256:
`5d5d92a7c727ef75bd9a70f076039dbdbfd331c56f022915c2e89b76f7fc88f0`.
Research artifacts: `/tmp/mcp-research/measure.py`, `playwright-tools.json`,
`measurement.json`; the script makes the read-only probe reproducible on this
machine. Tokenizer dependencies were isolated under `/tmp/mcp-research/python`;
no repository dependencies were installed or changed.

For reproduction elsewhere: launch that exact MCP package in isolated mode,
collect the complete tools/list array without invoking tools, construct the four
representations above, and compute `len(tiktoken.get_encoding('o200k_base').encode(json))`.
Server schema/version/hash changes must be reported rather than compared as if
they were the same fixture.

### Context-share policy

Let `C` be the selected model's **declared total context window**, not its remaining
free tokens; `B = floor(0.02 × C)`. Use the actual provider-format definitions and
an available matching local tokenizer; otherwise label the estimate and use a
conservative UTF-8 byte upper bound for admission. Never report the Playwright
OpenAI count as an exact count for Anthropic. Unknown context size means progressive
summary-only automatic discovery and an “unavailable” percentage, not a guessed
model capacity or automatic direct exposure.

| Example window (not assumed model configuration) | 2% budget | Playwright's 3,522 definition tokens as window share |
| --- | ---: | ---: |
| 32,768 | 655 | 10.75% |
| 131,072 | 2,621 | 2.69% |
| 200,000 | 4,000 | 1.76% |
| 1,000,000 | 20,000 | 0.35% |

**Why 2%:** within the guide's 1–5% range, it leaves 98% outside the automatic
MCP definition budget, admits a small useful schema selection at 32K, but avoids
preloading this ordinary 24-tool server at 128K. At 200K all 24 could fit; they
still stay deferred unless the person overrides. At one million tokens the
absolute budget grows, but page limits still prevent a giant default result.
This is a conservative initial policy justified by one measured server, not a
claim of globally optimal retrieval accuracy.

The budget is **aggregate across servers**, not 2% per server. It bounds the next
automatic discovery response's metadata plus already preloaded MCP definitions.
It is not a promise to cap accumulated conversation history: repeated explicit
inspection can exceed it, and tool results cannot be silently deleted. Reserve
space for gateway descriptors when admitting results. If overrides consume the
budget, automatic discovery returns the smallest useful names/summary page with
an over-budget diagnostic; explicit inspection of one tool remains possible.

A complete schema is atomic: never cut JSON in half to hit a token budget. Full
search pages shrink before returning; an individually oversize schema is fetched
only through explicit inspect, with its size reported. If a schema cannot fit the
model's hard request limit, return a clear refusal, not invalid JSON or invented
partial parameters. A person's preload override bypasses the **soft 2% policy**,
not the provider's hard context limit. Warn before saving and refuse an impossible
request with a concrete next step: turn the override off or choose a larger model.

### Discovery, caching and lifecycle defaults

| Setting | Proposed default / rationale |
| --- | --- |
| Server exposure | Progressive for all servers; override off. Explicit person instruction and Claude's current deferred/alwaysLoad pattern |
| Catalog detail | `summary`: name + concise description + server, no schemas. Measured 533 vs 3,522 tokens for Playwright |
| Other detail levels | `names` for broad inventory; `full` for selected schemas. Inspect always complete for one tool, preserving outputSchema |
| Summary/name page | 12 results by default, maximum 50; retain adapter default 12 (`A/proxy-modes.ts:682`) while adding a hard cap. 12 is half the measured server, not an unbounded inventory |
| Full-schema page | At most 5 by default, additionally budget-limited. Claude's documented five-result search is a concrete comparator; five average Playwright schemas are about 734 OpenAI-style tokens before response framing |
| Paging | Stable ranked snapshot/revision + cursor/offset, total, hasMore; changing catalog rejects/restarts old continuation rather than silently skipping tools. Groups don't reset the global limit |
| Retrieval | Adapter weighted keyword matching; no embedding requests, model calls or new index service. Strategy seam accepts an already authorized snapshot |
| TTL | Honor nonnegative server TTL from receipt; missing/negative = 0; no TTL polling. Historical display metadata may remain after expiry but is not fresh execution authority |
| Cache scope | Missing = private; no cross-authorization reuse. Initially no cross-project public sharing either: permitted sharing is optional, correctness is not |
| Pagination cache | Per-page clocks/keys preferred; persisted aggregate expires at earliest page expiry. All pages must agree on scope. Invalid/repeating cursor cannot yield a supposedly complete snapshot |
| Invalidation | Immediate generation bump/stale flag on notification; one coalesced refresh, discard superseded results. Re-index atomically on successful replacement, no notification debounce window of stale authority |
| Connections | Preserve existing on-demand default. Person-selected at-start/always policies remain explicit. Model enable only a session lease; disable drains at invocation boundary, does not rewrite config |
| Skills | Name configured servers in skill instructions; same trusted enable verb. No unsupported automatic frontmatter dependency grammar |

## Execution design and numerical limits

**Current risk:** Node's own [vm documentation][node-vm] says “not a security
mechanism. Do not use it to run untrusted code.” The existing script tool even
calls its input “trusted JavaScript” (`A/index.ts:1129`). An empty worker env and
`codeGeneration: {strings:false, wasm:false}` do not establish safe execution of
model-authored code. No exploit was attempted; no sandbox penetration test passed.
There is also no guest heap limit, output accumulates before guarding, and failed
tool calls resolve envelopes instead of rejecting promises.

**Proposed runtime:** retain the adapter's worker/broker architecture but execute
JavaScript in [QuickJS compiled to Wasm][quickjs], with no guest modules, filesystem,
network, process, environment or host object handles. Only JSON-valued asynchronous
call/search/describe and bounded emit stubs cross the boundary. QuickJS exposes
heap/stack limits and an interrupt handler; Wasm provides the guest memory boundary.
This is an implementation choice pending packaged x64/ARM64 proof, not an assertion
that the current adapter already uses QuickJS.

| Guide runtime alternative | Decision |
| --- | --- |
| [Deno][deno] | Not selected: deny-by-default permissions are useful, but bundling another executable runtime and enforcing a separate permission launch contract adds distribution work |
| [isolated-vm][isolated-vm] | Not selected: native ABI/platform bindings and its documented untrusted-code cautions; its memoryLimit is explicitly a guideline rather than a hard whole-process cap |
| [Monty][monty] | Not selected: Python and experimental; would change the adapter's JavaScript API/language |
| [pctx][pctx] | Not selected: useful code-mode concepts but another broker/runtime layer duplicates the adapter we already own at the embedding boundary |
| [Wasmtime][wasmtime] | Keep the Wasm capability-isolation principle; do not add a separate Rust runtime to execute existing JavaScript APIs |

| Bound | Proposed value / numerical justification |
| --- | --- |
| Guest execution timeout | Default **30s**, maximum **120s** per invocation. Preserve adapter's 30s default; at most four default periods prevents model-supplied unbounded timeout. No automatic retries of partial side effects |
| Guest heap | **32 MiB** QuickJS heap, enforced by runtime limit; twice the existing 16 MiB transfer allowance leaves a bounded workspace for transformations. This is not a claim that every 16 MiB JSON object fits after parsing |
| Guest stack | **512 KiB**; separately limited with QuickJS's stack API so recursion cannot consume the heap budget or host stack unchecked. Initial engineering bound, to validate against representative scripts |
| Script source | **64 KiB** UTF-8 maximum; 1/512 of the guest heap. Reject oversize input before guest compilation |
| Intermediate transfer | **16 MiB cumulative per run**, retaining adapter limit. Bound each message before transfer and budget every accepted response. Guest heap can reject sooner; upstream response allocation is a separate risk |
| Emitted output | **64 KiB cumulative** accepted from guest, then existing **50 KiB / 2,000-line** model-output guard. Headroom permits a truncation notice; enforce before host accumulation, not only at final serialization |
| Result details/trace | **16 KiB** final details, retaining output-guard default; bounded call metadata only, no second full result copy |
| Broker work | Maximum **4 concurrent calls**, **128 dispatched calls/run**; bounded queue backpressure. These initial admission limits prevent a short script from creating arbitrary host work and bound trace growth. They are engineering ceilings to test, not performance measurements |
| Schema validation | Reject external network refs; bound depth **64**, subschemas **4,096**, and compilation/validation **250ms** in an interruptible execution boundary. Finite bounds implement linked spec DoS guidance; adversarial tests must prove enforcement, not a timer around blocking synchronous code |

The sandbox milestone must benchmark legitimate chained scripts under these limits
and adjust with recorded evidence if needed. A limit error says which limit was
hit and suggests smaller batches; it never asks the model to bypass authorization.
Deadlines include pending broker calls/questions; cancellation closes the exact
invocation's questions and fences late replies. Execution cannot silently continue
after the guest returns or is terminated.

### Authorization and untrusted data contract

- Invoke the same broker authorization check for **every** direct and script call,
  with resolved scoped server/tool, actual outbound arguments and invocation ID.
- Existing explicit ask-first policy remains authoritative. Sensitive operations
  need confirmation unless covered by an explicit person-granted permission;
  server `readOnlyHint`/other annotations are not grants.
- “Allow this tool for this script” may create a categorical grant scoped to
  server, tool, policy revision and script run. Check it on every iteration;
  discard it on completion/cancel. It is not “allow anything this script calls”.
- A result from server A remains untrusted when sent to B. Preview B's complete
  arguments in an expandable approval surface. Do not trust a transformation,
  an injected instruction or a substring truncation as evidence of safe data flow.
- OutputSchema validation is separate from safe rendering/truncation. Reject
  invalid structured results and unsafe schema references without damaging other tools.
- `tools.call` and generated wrappers reject on `isError`, transport/protocol
  failure or permission denial. A caught error can be handled in the guest;
  an uncaught one yields a failed script result with a bounded partial-call trace.
  Update adapter tool descriptions and scripting skill examples with this
  intentional departure from `{ok:false,error}` semantics.

**What we must not promise the person:** sandboxing a script does not sandbox an
MCP server. A server can intentionally expose network, filesystem, shell or browser
code execution (Playwright has an explicitly unsafe browser-code tool). Such calls
remain powerful authorized operations. Output truncation does not prevent data
exfiltration; previews/grants are not an information-flow proof. Cancellation
cannot undo already committed remote writes. Guest heap limits are not whole-worker
RSS limits, and upstream response parsing needs its own bounds. Until the runtime,
per-call policy and escape tests pass, do not label the current script executor
“securely sandboxed”.

## Per-server Advanced toggle and inspector

### Configuration and migration

Use an engine-neutral explicit field, proposed `tools.alwaysLoad?: boolean`, with
**missing/false = progressive**. The worker translates it to adapter settings;
only `true` requests eager direct exposure. Existing `tools.exposure` values can
be read during migration, but old `direct` alone cannot prove a person opted in:
it was the gallery/form default. Do **not** silently turn every old direct server
into a permanent override.

Normalize legacy direct/search/on-demand entries to progressive for newly started
conversations unless the new explicit override is true. Preserve include/exclude,
approve, transport, secrets and startup settings. Retain legacy `only` data for
migration transparency, but it is not an exclusion/authorization list and must
not silently disable tools. “Put every tool” means every tool allowed by the
include/exclude policy; show any restrictions. Existing running sessions keep
their snapshot. Explain changed exposure once in the server's settings, not with
a fabricated assistant message. No destructive migration or credential rewrite.

The explicit field and legacy treatment are part of milestone 2 review. They
must round-trip through protocol schemas, imports, edit/save and global/project
resolution without changing exclusions or approval grants.

### Placement and exact copy

Reuse `U/McpServerForm.tsx:480`'s existing **Advanced** disclosure, alongside startup
and tool-policy options. Do not create another global discovery preference or
install the browser-side MCP config element; `docs/ux-elements.md:188` explicitly
rules that element out for this worker-owned design.

- Toggle: **Put every tool in the conversation**
- Off help: **Tools are found when needed, leaving more room for your conversation.**
- On help: **Every enabled tool is included when a new conversation starts. This uses more of the model's space.**
- Scope/lifecycle note: **Applies to new conversations. Conversations already running keep their current tools.**
- Measured warning example: **These tools use about 3,522 tokens—2.7% of this model's space. The usual discovery budget is 2%.**
- Exclusion note: **Tools you've turned off stay off.**
- Unknown model: **Choose a model to see how much space these tools use.**

Remove the add dialog's count-based exposure recommendation (`U/McpAddDialog.tsx:347–379`)
and replace “All direct”/ambiguous per-tool direct switches with consistent exposure
language. Keep actual tool On/Off and Ask first controls. A scoped/global inherited
policy is shown as inherited; saving an override follows current scope semantics.

### What the inspector can truthfully show

`W/inspector.ts:424–449` currently derives “direct” from configuration, not actual
provider context. Do not relabel that count “in context now”. Add **session-scoped
runtime evidence**, separate from the inspector's own connection:

| Information | Required source / visible wording |
| --- | --- |
| Saved default | Saved policy: “Found when needed” / “Included from the start”; pending changes for future conversations |
| Conversation identity | Explicit selected conversation; if opened outside one: “Choose a conversation to see its tools.” Never use the most recently active session implicitly |
| Actual preloaded definitions | Snapshot of MCP-owned definitions in that session's provider tools array: “Included from the start: N” |
| Discoveries | Tool names and descriptor revisions actually returned to that session; distinguish “Found” summary from “Details opened”. Not an inspector-connect event |
| Still retained context | Only claim current retention when selected request/compaction evidence supports it. Otherwise say “Details opened in this conversation”, not “still in context” |
| Budget | Context window, 2% target, estimated/exact tokenizer basis, preloaded tokens and most recent discovery payload size; identify unknown measurements |
| Catalog freshness | Fresh/stale/refreshing, last successful revision, failure/retry action; no credential or auth-partition values |
| Runtime connection | “Connected for this conversation”, “Available when needed”, “Disconnecting after current work”, “Turned off by you”; model vs person origin |

New session diagnostics/control methods must be engine-neutral, `cwd` routed and
session-owned, with schema round-trip samples and host/router tests. Do not overload
`mcp/disconnect`, whose current contract closes an inspector connection. UI person
controls must revoke the session lease and win races with model enables. Durable
Turn off remains a saved setting; a conversation-level disconnect is separate.

Transcript summaries: **Find tools**, **View tool details**, **Connect to {server}**,
**Stop using {server}**. Display actual result/error state, not optimistic success.
Reuse existing tool rows/approval footers and shared search projections
(`packages/protocol/src/search-content.ts:34–53,292`). Never add a separate server
activity dashboard or a static reasoning heading.

All changes use existing theme tokens, at least 12px text, keyboard/touch paths,
reduced-motion handling and the current assistant-ui-backed surfaces. The browser
matrix below is required before shipping, not satisfied by this design document.

## Dependency-ordered implementation milestones

One owner retains this MCP area. No production code belongs to this research
milestone. Each subsequent milestone is independently verifiable and gets a
capability commit, not an unreviewed whole-feature batch.

### 1 · Research/design (this document)

Done when this matrix, sources, measurement, defaults, risks and plan are committed.
Validation: `pnpm identity:check`, `git diff --check`, document structure/whitespace
check. No runtime/browser claims; no source suites required for documentation only.

### 2 · Discovery + stable prompt contract + surfaces

Depends on 1. Implement explicit progressive default/override and migration,
2% budget diagnostics, shared detail levels/grouped paging, inspect schemas,
existing keyword strategy seam, stable MCP gateway array and session discovery
observations. Update `docs/mcp.md` and relevant transcript search projections.

**Dedicated prompt-cache review:** compare serialized provider tools and system
prefix before/after discovery, connection and list refresh. Explicit direct mode
must freeze full schemas, not merely names. No discovery path may invoke lazy
activation behind the stable gateway. Test prompt/compaction/model-switch and
new-conversation boundaries; document intentional non-MCP tool changes separately.

Tests: protocol schema samples/router coverage for new diagnostics; worker real
adapter + stub provider tests for 24 large vs 40 tiny tools, all servers progressive,
unknown model/tokenizer, aggregate 2% policy, explicit override, exact names/summary/
full results, schema completeness, rank/paging and stable prefix. UI interaction
tests exercise global/project/inherited settings, migration, saving during a live
session, refresh failures, selected-session diagnostics and transcript summaries.

Browser: shared MCP fixture matrix plus feature script for Advanced toggle by
pointer and keyboard, save/reopen/new conversation, inspector selected-session
counts, oversize warning, summary/detail discoveries and long schemas. Desktop/
phone, dark/light, touch and reduced motion; ensure no horizontal overflow.

### 3 · Cache correctness

Depends on 2's catalog revision contract. Reuse/fix SDK cache, adapter persistence
and notification publication; all TTL/scope/page/auth rules above. No second cache
service. Update upstream patch documentation with exact dependency targets.

Tests: controlled-clock **real adapter/SDK wire** fixtures with positive/zero/
missing/negative TTL; differing page expiries; per-cursor keys; invalid/repeated
cursor; private/public scope; two auth contexts/scoped same-name servers; credential
rotation/logout; concurrent list change during refresh; failed refetch and recovery;
notification before TTL; old in-flight response cannot repopulate invalidated index;
MRTR non-cacheability. Assert call counts and search output, not implementation strings.
Resources/read, templates, prompts and discover are included, not only tools/list.

Browser: matrix script drives changed tools and failed refresh while inspector is
open, verifies stale copy/retry and that an inspector refresh does not manufacture
session discoveries. No UI changes beyond this truthful cache state.

### 4 · Trusted session-scoped dynamic servers

Depends on 2 and 3. Registry, enable/disable verbs, lease/status protocol, person
override and safe boundary disconnect. Resolve descriptions without connecting or
exposing secret configuration. Skills use the same verbs, not a separate loader.

Tests: untrusted project cannot spawn servers/helpers; person-disabled cannot be
model-enabled; configured-but-unconnected search; concurrent enable coalescing;
connect failure/auth refusal/retry; person revoke racing model enable; disable
while call/question active; cancellation and safe closure; two sessions cannot
revoke each other's lease; no config writes; no new project worker; session reload
and explicit direct override keep prompt snapshot semantics.

Browser: matrix script observes model connection origin, disables from the selected
conversation, verifies race-safe status and actionable auth/failure text, and
checks the server remains enabled in saved settings unless explicitly changed.

### 5 · Script isolation + per-call approval

Depends on 2–4 so the guest sees the same trusted catalog and dispatch contract.
Patch executor to restricted runtime, bounded bridge/output, typed schema descriptors,
throwing errors and run-scoped grants. Preserve existing MCP broker, cancellation,
output guard and one companion module.

**Dedicated security/approval review:** guest-to-host object boundary, no network/
filesystem/env/import escape, actual outbound argument review, per-call categorical
grant matching/revocation, schema validation DoS, late-call fencing, source/result
prompt injection, and packaged runtime assets. An outer script approval is never
accepted as evidence of inner-call authorization.

Tests: catch/uncaught `isError` and protocol errors; allow/deny/headless and grant
expiry; changed destination/args/policy; cross-server exfiltration attempt requiring
same review as direct; credential sentinel never visible to guest; global/constructor/
prototype/module escapes; CPU loop, recursive stack, heap exhaustion, emit flood,
large frames, concurrency/total-call limits; dangling calls on return; cancellation
of an active question and remote call; partial writes reported without retries.
Use bounded isolated processes for adversarial tests so a regression cannot harm
the test runner. Assert actual outgoing calls and refusals, not missing globals alone.

Browser: matrix script opens script-origin approval, expands complete arguments,
uses pointer/keyboard allow once/run grant/deny, cancels while waiting, and checks
approval remains outside disclosure plus truthful partial failure/truncation rows.
Packaged gate: bundled Node, empty PATH/HOME fixture, all desktop targets carry and
load Wasm/runtime assets and execute the same brokered script without downloads.

### 6 · Integrated acceptance and documentation reconciliation

Depends on 2–5. Real-engine scenario: discover configured server → enable → search
summaries → inspect full schemas → script chaining/filtering → list-change refresh
→ person revoke → safe boundary disconnect → reload/new conversation. Assert stable
provider prefix, accurate context diagnostics, per-call approvals and bounded output.
Reconcile `docs/mcp.md`, this document and `docs/upstream.md` with what actually ships.

Each production capability runs:

```sh
export PATH="$HOME/.nvm/versions/node/v24.11.1/bin:$PATH"
pnpm -F @lasercode/protocol test
pnpm -F @lasercode/worker exec vitest run test/mcp
pnpm -F @lasercode/ui test
pnpm identity:check
pnpm -r build
```

UI acceptance uses the existing harness, with a feature-specific interaction script
added by the owning milestone (the placeholder below denotes that script's path,
not an existing file):

```sh
node scripts/browser-check/run.mjs \
  --target scripts/browser-check/targets/app.mjs --fixture mcp --matrix \
  --script PATH_TO_MILESTONE_INTERACTION_SCRIPT
```

Run broader host/protocol routing and companion tests whenever their contracts
change. Final gate: `pnpm verify`, full browser scenario, and packaged-runtime
acceptance. Record exact revisions, artifacts and failures. A local fake-server
suite does not prove real remote OAuth, provider cache billing or server safety;
report those limits rather than claiming universal conformance.

## Sources

[guide]: https://modelcontextprotocol.io/docs/2026-07-28/develop/clients/client-best-practices.md
[index]: https://modelcontextprotocol.io/llms.txt
[caching]: https://modelcontextprotocol.io/specification/2026-07-28/server/utilities/caching
[tools]: https://modelcontextprotocol.io/specification/2026-07-28/server/tools
[skills]: https://modelcontextprotocol.io/docs/2026-07-28/develop/build-with-agent-skills
[discover]: https://modelcontextprotocol.io/specification/2026-07-28/server/discover
[pagination]: https://modelcontextprotocol.io/specification/2026-07-28/server/utilities/pagination
[mrtr]: https://modelcontextprotocol.io/specification/2026-07-28/basic/patterns/mrtr
[basic]: https://modelcontextprotocol.io/specification/2026-07-28/basic/index#ref-resolution
[claude]: https://code.claude.com/docs/en/mcp
[claude-search]: https://code.claude.com/docs/en/agent-sdk/tool-search
[codex]: https://developers.openai.com/codex/mcp
[codex-source]: https://github.com/openai/codex/blob/ee6814bfa4889fe9b2b3dcc9cc8bdd91effa8ab8/codex-rs/core/src/tools/handlers/tool_search_spec.rs#L94
[openai-search]: https://developers.openai.com/api/docs/guides/tools-tool-search
[anthropic-search]: https://platform.claude.com/docs/en/agents-and-tools/tool-use/tool-search-tool
[anthropic-cache]: https://platform.claude.com/docs/en/build-with-claude/prompt-caching
[node-vm]: https://nodejs.org/api/vm.html
[quickjs]: https://github.com/justjake/quickjs-emscripten#runtime
[deno]: https://docs.deno.com/runtime/fundamentals/security/
[isolated-vm]: https://github.com/laverdet/isolated-vm#security
[monty]: https://github.com/pydantic/monty
[pctx]: https://github.com/portofcontext/pctx
[wasmtime]: https://github.com/bytecodealliance/wasmtime

Additional references examined: [Agent Skills format](https://agentskills.io/specification)
(no standardized MCP dependency frontmatter), [OpenAI prompt caching](https://developers.openai.com/api/docs/guides/prompt-caching),
[Anthropic tool use with caching](https://platform.claude.com/docs/en/agents-and-tools/tool-use/tool-use-with-prompt-caching).
Public web search was used to locate Claude/Codex discovery documentation, then
findings were checked against the retrieved pages/source rather than the search summary.
