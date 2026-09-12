# Cross-package performance audit

## Bottom line

**Keep the chat-loading work moving. The strongest additional opportunities are unnecessary work outside the visible conversation, synchronous host work, and oversized payload handling—not shorter animations or fewer features.**

Start with:

1. Fix the catalog scanner's quadratic copying of large JSONL lines.
2. Deduplicate directory-containment checks and whole-catalog lookups.
3. Stop broadcasting full provider request bodies to ordinary views.
4. Narrow remaining shell/fleet subscriptions and publish streaming store changes once per batch.
5. Bound Git reads before allocation; cancel superseded history searches.

This is a report, not an implementation or a promise of bug-free speedups. Every proposed change below includes a correctness boundary. Measured costs are **not additive savings**.

## 1. Revision, scope and evidence

**Source of truth:** the live files under `/home/youssef/projects/laser/.worktrees/chat-loading-9210c750`, branch `agents/chat-loading-9210c750`, HEAD `ae423a5`. Paths and line numbers below refer to that worktree, not necessarily the root checkout. Short source references such as `host/src/catalog.ts` are relative to its `packages/` directory; line numbers identify the inspected snapshot and may move.

The worktree changed during inspection. Initially Git reported no tracked changes; later `packages/protocol/src/{messages,schemas,index}.ts` changed and `history-window.ts` appeared. The new window request, epoch, sequence, interpretation-context and live-snapshot contracts are **in-flight M16-T16 work**, not omissions to assign to another implementer. Final reinspection also found the host window route, worker/driver live snapshot capture, UI history snapshot/prepend actions, and `LaserProvider` tail-40/earlier/all-history requests being wired. Their diffs were read; this report does not assess that unfinished implementation as a completed feature or assign its remaining work elsewhere. A clean status was only a point-in-time observation. Recheck findings against the current worktree before implementing them.

This audit:

- Inventoried 578 source/style files, approximately 119,527 lines, across all ten packages at one checkpoint; counts can grow during concurrent work.
- Traced the principal runtime paths and performed targeted source review, not a claim that every line or dependency received an exhaustive correctness review.
- Examined UI/runtime, host, worker, harness, background commands, protocol/display projections, desktop startup, MCP, files/Git, logging, relay, crypto and PWA caching.
- Read existing `docs/perf-analysis.md` and `docs/perf-chat-loading.md` rather than reassigning their completed fixes.
- Ran isolated, credential-free source microprobes. No installed host, user session, agent worktree or app setting was changed. No new application build or browser acceptance matrix was run.
- Created only this report and planning records in the repository. Probe programs, fixtures, raw results and source fingerprints are under `/tmp/laser-wide-perf-audit/`.

### Evidence labels

- **Measured:** fresh synthetic probe against the relevant source function. Not end-to-end application latency.
- **Confirmed:** source establishes the extra work; its user-visible cost still needs measurement.
- **Investigate:** plausible opportunity requiring profiling or lifecycle validation before implementation.

### Fresh measurements

Node `v24.20.0`, local filesystem, no artificial CPU throttling. Other development work was running on the machine. Fresh catalog objects mean a cold **application cache**, not a cold OS page cache. Timing samples are small; no p95 or production speedup is claimed.

| Probe | Result | Meaning |
| --- | ---: | --- |
| Catalog scan, one 1 MiB payload line | 2.35 ms median | 5 uninstrumented scans |
| Same, 4 MiB | 7.72 ms | 5 scans |
| Same, 16 MiB | **175.73 ms** | Synchronous event-loop occupation |
| Same, 32 MiB | **866.02 ms** | Range 841.81–922.81 ms |
| Scanner `Buffer.concat` traffic, 16 / 32 MiB | **561.77 MB / 2.20 GB** | Cumulative copying, not retained heap; excludes additional `Buffer.from` copies |
| Warm catalog list, 150 / 1,500 / 5,000 sessions | 0.39 / 2.69 / 8.86 ms | 7 samples each |
| Router-decorated list on the same fixtures | **4.73 / 33.31 / 114.14 ms** | Four exclusion roots; one distinct project cwd |
| Containment realpath calls for 5,000 rows | **40,000** | Same project checked repeatedly |
| Projection + sharing, 240 blocks | 0.108 + 0.146 ms median | 200 measured iterations after 50 warmups |
| Same, 2,400 blocks | 0.636 + 1.440 ms | Settled part cache already enabled |
| Same, 10,000 blocks | **3.232 + 6.866 ms** | No React rendering included |
| Git's oversized-file helper, 32 MiB file | Reads entire file; returns 0 lines; 14.20 ms | One helper invocation; configured skip threshold 1 MiB |
| File ranking, 50,000 matching paths → 50 results | 10.44 ms median | 15 calls, cached scan, broad `index` query |
| Provider log ingestion, 1 / 4 / 16 MiB text payload | 2.38 / 9.90 / **51.54 ms** median | 7 calls; in-memory SQLite, repeated identical payload |
| Provider broadcast, 4 MiB payload, two mock local clients | **8,389,066 serialized bytes**, both reducers unchanged | Real broadcast method, mock socket sends; not a network benchmark |
| Computed diff, 1,998 lines with one changed line | 11.04 ms median | 7 calls; near the existing LCS cell ceiling |

The large-line fixture contains synthetic base64-like data, not a decodable image. It tests scanning, not image decode. The Git probe's process-wide memory delta was contaminated by unrelated collection and is **not** retained-memory evidence. Provider broadcast timings in the raw artifact include simulated client JSON parsing in the same process; do not present them as host latency.

## 2. Existing work: preserve it, do not redo it

| Area | Observed state | Audit treatment |
| --- | --- | --- |
| Catalog paging | Implemented in `catalog-page.ts`, `catalog-loader.ts` and sidebar controls | Keep seven ordinary rows/project, pins/exceptions, real totals, stale-reply guards and full-summary escape routes |
| Transcript paging, windowing and switch continuity | M16-T16 design plus live protocol implementation observed | Coordinate with that owner; not a new implementation lane |
| Speculative history prefetch | Part of M16-T16 | Do not start workers, trust flows or mark sessions seen on hover |
| Stream batching | `ui/src/client.ts:250–290` already uses rAF plus timer fallback | Remaining opportunity is store publication/selector work, not adding another rAF layer |
| Footer subscriptions, timestamps, entry lookups | Prior batch landed; current thinking hook selects session metadata and timestamp formatter is cached | Do not reuse historical footer execution counts as current measurements |
| Projection parts | WeakMap caches already retain settled tool/assistant parts | Whole-message traversal/sharing still remains, measured above |
| Highlighting | Markdown fences stay plain during streaming; wrapper/grammars/Mermaid have lazy paths | Audit eager import bypasses, not remove languages or highlighting |
| Map layout | Memoized by structural key, box and direction | Do not relayout on status/text changes |
| Git and project files | TTL caches and in-flight dedup already exist | Improve work within a cache miss and oversized-file admission |
| Project-file preview cache | Eight-entry, character-budgeted, 30-second cache | Preserve; not an unbounded-cache finding |
| Referenced project images | `use-project-image.ts` gates reads on visibility and releases component-held results offscreen | Preserve; new work concerns embedded history bytes, not adding this existing gate |
| SQLite | WAL/NORMAL, content references and deferred retention already present | No per-token SQLite write: text deltas are not logged |
| Worker lifecycle | Spawn dedup, one worker/project, retirement fences and live-run protection | Not candidates for removal in the name of speed |
| Harness activity | Chatty tool-end activity can avoid publishing; no run update on every text token | Do not claim per-token registry persistence |
| Reconnect and first-turn ownership | Sequence, generation and destination fences already exist | Optimization must preserve them |

The existing chat-loading document's 2,000-message switch measurements remain historical baseline evidence. This audit did not repeat them and does not claim that unfinished changes already improve those numbers.

## 3. Ranked findings

Priorities describe implementation order by risk/value, not deadlines. **P1**: clear, worthwhile next candidates. **P2**: useful after the major path stabilizes. **P3**: profile first or specialist workload.

### F01 · P1 · Quadratic catalog scanning of large lines — measured

**Source:** `host/src/catalog.ts:206–242`, `scanBody`.

For each 256 KiB chunk, the scanner concatenates the entire unfinished line with the new bytes, searches the combined data again, then copies the unfinished suffix. A single large image/tool line is repeatedly copied and rescanned. The intended incremental file offset does not prevent this within-line quadratic work. An unterminated line can also be reread on successive file growth notifications.

**Change:** track incoming chunks and a scan cursor; search only new bytes and assemble a completed line once. Consider selective streaming extraction for very large records only after the linear implementation is proved. Retain complete-line byte offsets and avoid keeping a giant partial line indefinitely.

**Guard:** UTF-8 characters split across chunks; partial writes; rename/agent/goal records; first visible user text; append, truncation and rewrite invalidation. Do not arbitrarily truncate a line and silently lose catalog semantics.

**Proof:** repeat 1/4/16/32 MiB fixtures and assert approximately linear copy traffic; concurrently measure host heartbeat and permission-response delay. Async filesystem calls alone do not fix the copying algorithm.

### F02 · P1 · Repeated filesystem containment and full-catalog lookups — measured/confirmed

**Source:** `host/src/router.ts:202–218,304,768–771`; `host/src/projects.ts:87–109,133–154`; `host/src/paths.ts:33–46`.

Each summary's project exclusion checks resolve both paths for each exclusion root. Thousands of sessions commonly share relatively few projects. The 5,000-row fixture performs 40,000 `realpathSync` calls. Router decoration is much slower than the warm metadata list alone.

`isWorkspaceSession(path)` and delete lookup use `catalog.list().find(...)`; one-path questions cause a full scan. Project `get()` calls `list()`, while `add()` emits a complete list then gets the project, repeating work.

**Change:** request-scoped memoization by cwd/root for presentation classification; compute one decorated snapshot and reuse its per-project counts/indexes within an operation; use `catalog.get(path)` for known-path questions where the same validation is retained.

**Guard:** preserve symlink-aware containment and trust checks. Do not install a permanent cached authorization decision: revalidate mutation/spawn boundaries and symlink changes. Main-worktree and child-worktree ownership remain distinct.

**Proof:** call-count tests should scale with distinct cwd/root pairs, not session count; test moved/deleted files and symlink swaps. Repeat paired list timings with many sessions in few and many projects.

### F03 · P1 · Full provider request payload broadcast nobody needs — measured/confirmed

**Source:** `pi-extension/src/modules/provider-log.ts:15–26`; `worker/src/server.ts:1390–1400`; `host/src/server.ts:366–369,637–641,793–810`; `ui/src/store.ts:660–702`.

The companion forwards the provider request body to the worker, the host logs it, then the generic notification path broadcasts that same body to every connected view. The UI reducer ignores this request message. The request inspector retrieves retained data through `pi/logs/query` and `pi/logs/content` instead.

The actual host broadcast method sent a 4 MiB payload to two mock clients: 8.39 MB of serialized data for no store change. Paired-device forwarding may serialize an oversized body before rejecting/reducing it for its frame limit.

**Change:** keep full capture for the host's diagnostic store, but exclude raw provider request/response capture messages from default UI broadcasts. Use the existing log-row/content-reference route; provide explicit opt-in if a diagnostic client needs the raw event stream. Audit CLI/desktop consumers before changing that contract.

**Guard:** preserve retained payload, request provenance, redaction, request/response correlation and live log notifications. Do not filter unrelated extension events such as questions, capabilities or MCP status.

**Proof:** real-host test with desktop/browser/relay listeners: default traffic contains a small log reference, inspector still retrieves the identical retained request, and questions arrive promptly beside a large capture. This is also less duplication of sensitive conversation data, not a claim about an external data leak.

### F04 · P1 · One frame still publishes the external store once per delta — confirmed

**Source:** `ui/src/client.ts:280–290`; `ui/src/runtime/LaserProvider.tsx:354–370,508–514`.

`flushUpdates()` loops through every buffered update. Each invokes the provider reducer and every external-store subscriber. React may combine rendering, but selector notifications and reducer allocations still occur per update.

**Change:** add an explicit store batch transaction: reduce every event in order, retain the final immutable snapshot, and notify subscribers once. Keep event-level listeners and required barriers ordered. Optimize adjacent textual accumulation only as a separate, proved step.

**Guard:** replay watermarks, every accepted sequence, terminal/tool boundaries, approval ordering, queue delivery, stop, disconnect flushing and first-turn rollback. Do not merge terminal results into partial output. `startTransition` is not a substitute for batching an external store.

**Proof:** identical final state and event order for batched/unbatched input; one subscriber publication per eligible flush; immediate flush before dialogs/RPC replies; hidden-tab timer fallback. Measure reducer, selector and React costs separately.

### F05 · P1 · Remaining shell/fleet work follows irrelevant text changes — confirmed

**Source:** `ui/src/runtime/LaserProvider.tsx:490,592–596,644,863–879,1288–1293,1392–1395`; `ui/src/fleet/hooks.ts:43–85`; `ui/src/components/shell/TelemetryPanel.tsx:67,179,291,527`; `ui/src/runtime/threadList.ts:488–512`.

The provider subscribes to the entire app state. On text changes it can rebuild/sort catalog reference sets, walk open sessions, compute project visibility and generate a merged/sorted thread-list signature. Stable resulting strings avoid some downstream updates, but do not eliminate their computation.

`useFleet()` depends on the entire `open` map. A text delta replaces that map even when the fleet's metadata did not change. Several telemetry sections subscribe to a complete view despite needing stable metadata or entries.

**Change:** separate conversation content from small session/fleet metadata selectors; memoize reference sets on run/task identities; share one derived fleet model; update clocks independently from structural derivation. Narrow remaining whole-view consumers, including composer utilities that only need the session path.

**Guard:** running/needs-input/attention/title changes must still render immediately; return stable references from selectors; maintain Beam's independent scope. Do not freeze an actual activity line merely because it resembles a text update.

**Proof:** instrument selectors and components during 1/8/32 concurrent synthetic streams. An unrelated text delta should not rebuild the sidebar/fleet tree. Test live tool activity, child questions, unseen completion, rename and changes in project membership.

### F06 · P1, coordinate M16-T16 · Whole-history projection remains linear — measured

**Source:** `ui/src/runtime/projection.ts:497–595`; `ui/src/runtime/goal-history.ts:27–77`; `ui/src/runtime/LaserProvider.tsx:1502–1509`.

Part caches are effective, but every update still visits all blocks, regenerates message wrappers/metadata, scans goal records and deep-compares the complete projected array. Ten thousand blocks cost about 10.10 ms in projection/sharing alone in the microprobe.

**Change:** reuse complete message groups and their metadata by immutable input identity; cache durable goal interpretation separately from the live suffix; maintain the affected-group boundary. History paging lowers initial input size, but a person who has loaded the full history still benefits.

**Guard:** regrouping on speaker/turn changes, tools adjacent to page cuts, compaction, branch changes, goal completion and stable original ordinals. No mutation of previous snapshots.

**Proof:** reference stability and projection equivalence tests; compare 240/2,400/10,000 blocks with text/tool/goal histories. Treat this as a contribution to the active history work, not a competing projector rewrite.

### F07 · P1 · Superseded history searches keep consuming resources — confirmed

**Source:** `host/src/session-search.ts:44–120`; `host/src/router.ts:280–283`; `ui/src/components/shell/use-session-search.ts:22–48`.

The UI debounces and rejects stale replies, which protects correctness. It does not cancel the host scan already started. The host visits up to 100 files or 50 hits sequentially, parsing every JSONL record, with no byte budget or cancellation argument. A single enormous file defeats the apparent file-count bound. Rapid searches from several views can overlap.

**Change:** connection/request-scoped cancellation for obsolete reads; bounded scan concurrency, initially a small measured limit; CPU-friendly yielding or a dedicated search worker when parsing/projection dominates. Consider an incremental display-content index only as a separately designed follow-up.

**Guard:** collect results in the original file order with a contiguous cursor; preserve source ranking, goal filtering, call/result pairing, Unicode and unreadable counts. Search stays host-only and must not spawn agent workers.

**Important:** a naive `rawLine.includes(query)` prefilter is incorrect: JSON escaping and display projections can change searchable text. Preserve the shared value-only projection contract.

**Proof:** close/change search while a huge synthetic file is being read; assert stream closure and bounded work. Check exact excerpts/cursors under out-of-order completion, deletion and concurrent append. Compare warm/cold scans and host heartbeat, not only query latency.

### F08 · P1 · Git reads oversized files before deciding to skip them — confirmed/measured

**Source:** `worker/src/git.ts:260–274`.

`linesOfNewFiles()` calls `readFile()` and only then checks the 1 MiB ceiling or binary header. Up to 500 new files can be considered. A generated multi-gigabyte artifact can cause a major allocation despite being excluded from the displayed count.

**Change:** open the file safely, verify it is regular, read a bounded binary header, and read/count at most the admitted size plus a sentinel byte. Limit total work as well as the number of files. Use bounded concurrency for admitted files.

**Guard:** a pre-read stat alone is not enough if the file grows or is replaced. Avoid FIFOs/devices and symlink surprises. Preserve line-count semantics and the existing exclusion of files present at baseline.

**Proof:** huge/sparse/binary/growing/disappearing files, no unbounded read or hang, accurate small-file counts. The existing `ProjectFilesService.read()` already provides useful bounded-handle patterns.

### F09 · P2 · Independent Git subprocesses run in serial stages — confirmed

**Source:** `worker/src/git.ts:213–274`; `worker/src/files.ts:186–217`.

Branch/status are already parallel. After that, upstream discovery, ahead/behind, remote URL, baseline diff and new-file counting execute largely sequentially. The project file list waits for cached/deleted lists before starting the independent untracked-file command.

**Change:** preserve dependency order but overlap independent reads. Ahead/behind and remote URL can run together once upstream is known; baseline diff need not await upstream; file counting can begin once status is known. Start the three `ls-files` reads together while retaining tracked-first merge precedence.

**Guard:** no extra writes, no git hooks, no index locking, no concurrency explosion. Baseline capture is a consistency-sensitive operation, not an arbitrary collection of independent commands.

**Proof:** instrument subprocess start/end events; retain tests for unborn/detached HEAD, absent upstream, ignored/deleted files, renames and failed commands. Measure cold misses separately from the existing TTL cache.

### F10 · P2 · Large provider captures block the host; retention timers do not offload work — measured/confirmed

**Source:** `host/src/logstore.ts:294–391,542–582,602–618,854–874`.

A provider capture is serialized for its description, redacted/copied, serialized again, hashed and stored synchronously. The synthetic 16 MiB case occupied about 51.54 ms even with in-memory SQLite and repeated content. This is per capture, **not per token**.

Retention is scheduled with a timer but still runs synchronous SQL on the host loop. Large deletes/orphan sweeps can create pauses in an old database. Statement preparation is repeated for fixed SQL.

**Change:** remove redundant serializations and reuse fixed statements first. Profile an aged real-shaped synthetic DB before introducing a dedicated logging worker/process with a byte-bounded queue and ordered ingestion. Chunk maintenance or run it with an explicit work budget.

**Guard:** redaction before diagnostic exposure; unchanged provenance offsets/digests; captured payload must not change after enqueue; request/response ordering; defined flush/failure policy. Do not silently drop requested diagnostics or weaken SQLite durability. Worker messages also copy data: measure the transfer cost.

**Proof:** event-loop-delay distribution during multi-agent large captures and retention. Test disk full, read-only DB, shutdown drain and concurrent request inspection.

### F11 · P2 · Session/replay caches are count-bounded or lifetime-bound, not byte-bounded — confirmed

**Source:** `host/src/views.ts:31–85`; `worker/src/server.ts:95–105,151,1355–1369`; `ui/src/runtime/LaserProvider.tsx:837–879`; `ui/src/store.ts:400–404`.

Eight full history snapshots can be large with embedded images. The worker retains up to 5,000 update objects per loaded session; one object may include a large tool result. Removing old updates uses front-splice. UI views retain previously opened conversation data, while detach only changes host attachment bookkeeping. A live project worker can retain many session runtimes until retirement.

**Change:** profile retained bytes by owner. Use a byte-aware LRU for reconstructible host/UI history, a ring/deque plus explicit replay byte policy, and separate small session metadata from optional historical bodies. Coordinate UI history eviction with M16-T16's page/cache design.

**Guard:** never evict live/answerable state, draft attachments, active edits or pending transactions. A replay eviction must advance the replay floor and force correct hydration, not hide a gap. Closing a UI cache must not stop an agent or its background command.

**Proof:** 100 switch cycles and multiple simultaneous streams; heap-retainer snapshots after explicit GC; reopen/branch/find/draft/Beam tests. Counted bytes are not a precise JS-heap estimator, so measure both.

### F12 · P2 · PWA installation downloads every lazy chunk — confirmed

**Source:** `ui/src/pwa/vite-plugin.ts:188–193`; `ui/src/pwa/sw.ts:87–96`; `ui/src/pwa/register.ts:51–76`.

The plugin puts **every** emitted JS/CSS/font chunk in `PRECACHE`; install calls `cache.addAll()` with `cache: reload`. Lazy loading may save initial execution, but it does not avoid eventual first-install network/cache traffic. Page-only resource measurements can miss service-worker fetches.

The existing worktree build contains 371 precache URLs, including 319 JS URLs and about 15.34 MB of existing listed files. This is artifact inspection, **not a freshly reproduced build or measured transfer**. It includes optional renderers/grammars and font variants.

**Change:** distinguish the critical shell from optional assets. Prioritize shell installation, reuse verified content-hashed cached assets across generations, and cache optional modules on demand or warm them later under a defined offline policy.

**Guard:** reducing precache changes what works offline. Preserve the currently promised offline experience or obtain an explicit product decision. User-chosen updates, generation handshakes and “never cache transcripts” remain binding.

**Proof:** record service-worker network targets during fresh install/update on slow connectivity; test offline shell and previously used optional views. Ensure one optional download failure does not make the critical shell unavailable.

### F13 · P2 · Eager imports bypass some otherwise-lazy renderer boundaries — confirmed

**Source:** `ui/src/components/thread/{FileCard,FileViewer}.tsx`; `ui/src/components/assistant-ui/elements/{tool-code-highlights,shiki-highlighter,markdown-text}.tsx`; `ui/src/components/agents/map/{AgentMap,LineageList,MapCanvas}.tsx`; `ui/src/components/shell/Shell.tsx:5`.

Filename-to-language helpers live in the same module as `react-shiki`/`shiki` imports and are imported by ordinary file cards. Tool highlighting also imports that implementation directly. The lazy Markdown wrapper therefore does not establish laziness for the entire application graph. Map modules are imported from the shell; even the compact lineage list imports `emptyCaption` from the heavy canvas module. KaTeX plugins are eager.

**Change:** move lightweight helpers/constants into dependency-light modules; lazy-load actual map/highlighter/math implementations at their usage boundaries. Profile module execution rather than counting every distributed grammar as startup code.

**Guard:** preserve all languages, math/currency/code parsing, token-based colours and the same-sized plain-code fallback. A newly encountered feature must not shift layout or lose focus. No generic “delete dependencies” recommendation.

**Proof:** fresh production source-map/bundle analysis and browser execution trace with plain text, file cards, math, code and map paths. Confirm dynamic imports are not pulled back into the entry by another static import.

### F14 · P2 · Conversation map measures the entire preceding DOM on scroll — confirmed

**Source:** `ui/src/components/assistant-ui/elements/conversation-map.aui.tsx:129–170`.

Every scheduled scroll measurement queries all message elements and reads their rectangles until the bottom of the viewport. Near a long transcript's tail, this visits nearly the entire history. rAF prevents repeated measurements within one frame but does not reduce the number of elements examined.

**Change:** use the shared virtualizer's visible range once M16-T16 provides it; otherwise track message visibility/geometry incrementally. Share the “ensure mounted, then measure” operation with jump/find instead of adding a separate scroll controller.

**Guard:** tall tools/images, sticky composer, reduced motion, manual scroll, branch changes and reading-position restoration. Preserve active-turn identity.

**Proof:** DOM-measurement counts while scrolling near the end of 2,000+ messages; scrolling with disclosures/images resizing must remain anchored.

### F15 · P2 · Find reprojects/searches and rebuilds DOM ranges too broadly — confirmed

**Source:** `ui/src/components/thread/use-conversation-find.tsx:59–75,110–136`; `protocol/src/search-content.ts:225–233`.

While find is open, message-array changes rebuild matches across loaded history. Mutation/scroll events schedule a traversal of every mounted message and reconstruct native ranges. Tool projections can recompute diffs. Range positions generally move with scroll without needing a new text match operation.

**Change:** cache display text by immutable message/part identity; recompute matches only for changed content or query; invalidate ranges for changed/remounted nodes rather than all history. Separate text matching from selected-result geometry. Integrate loaded-history scope with M16-T16.

**Guard:** keep native ranges; never wrap React-owned text nodes. Value-only conversation search and full-JSON request-inspector search are different contracts. Preserve disclosure restoration, selected occurrence and keyboard/touch focus.

**Proof:** search stays open during a long stream, repeated scroll and delayed highlighter render. Test distant folded tools and page loading/cancellation.

### F16 · P2 · Diff computation is bounded, but still expensive and repeatable — measured

**Source:** `protocol/src/tool-diff.ts:43–99,107`; `protocol/src/search-content.ts:225–233`.

The LCS table has a four-million-cell guard, which must be credited. Below that threshold, a 1,998-line mostly identical pair still costs about 11 ms in the probe. Rendering only 400 lines does not prevent full diff computation first. Search and presentation can request the same projection repeatedly.

**Change:** cache by immutable tool inputs/results. Add a fast path for identical text; investigate common-prefix/suffix trimming or a better diff algorithm only with output-equivalence fixtures. Move exceptionally costly computation off the renderer if profiling warrants it.

**Guard:** repeated-line tie-breaking, hunk grouping, original line numbers, full diff statistics, search/display agreement and the existing bounded fallback. Do not lower quality by merely lowering the ceiling.

**Proof:** duplicate-line adversarial cases plus large mostly-unchanged edits; measure repeated search and tool disclosure, not just one function call.

### F17 · P2 · Full model catalog fetched for a small capability lookup — confirmed

**Source:** `ui/src/components/assistant-ui/elements/reasoning-effort.tsx:167–234`; `worker/src/packages.ts:482–541`.

The shared promise cache already prevents one request per consumer. Nevertheless an ordinary thinking-level control fetches the complete model inventory before a chooser is opened. A historical report measured roughly 447 KB in one synthetic catalog; that number was not remeasured here.

**Change:** expose/cache the small effective-model capability tuple needed by the composer; fetch the complete chooser inventory when required. Coalesce existing consumers across control surfaces and scope caches to client/host/configuration generation.

**Guard:** agent defaults, first-turn overrides, provider reconnect, fallback model changes and thinking-level clamping. Do not show a false unsupported state while information is pending.

**Proof:** normal chat startup does not request the full inventory; opening the chooser still shows the same models and current connection state.

### F18 · P2 · MCP setup repeats configuration discovery — confirmed

**Source:** `worker/src/mcp/session.ts:42–66`; `worker/src/mcp/service.ts:287–296`; `worker/src/mcp/import.ts:138–148`.

`mcpSessionSetup()` reads enabled servers, then `mcpSessionConfig()` constructs another store and reads them again. Secret reads across servers are already parallel, but project/global fallback scopes and import candidates have independent reads performed serially.

**Change:** build configuration and displayed server identities from one validated snapshot; overlap independent reads and merge in deterministic precedence order. Consider short-lived immutable discovery caching with explicit invalidation.

**Guard:** project trust, scope overrides, secret precedence, config/auth changes and per-session connection ownership. Do not share a mutable adapter/elicitation context across sessions just to avoid connection setup.

**Proof:** one discovery snapshot supplies both config and attribution; source changes mid-setup cannot mix generations; connection/auth failure remains isolated to MCP.

### F19 · P3 · Cold session services and recovery concurrency — investigate

**Source:** `worker/src/drivers/stable-sdk.ts:279–409,423–502`; `worker/src/server.ts:833–900,1039–1054`; `host/src/worker-pool.ts:274–292,524–545`.

Each runtime builds services/resources and binds extensions. The commands preview can open a disposable driver. Recovery reopens sessions sequentially. Historical cold-open timings identify runtime creation as important, but this audit did not remeasure that path.

**Change:** instrument SessionManager load, resource discovery, model/auth resolution, MCP setup, extension binding and first ready state separately. Cache only demonstrably immutable resource facts, keyed by engine/configuration/trust/project identity. Consider bounded recovery concurrency with the visible session prioritized.

**Guard:** global extension/provider side effects, shared auth/settings managers, one writer per session, per-session provenance observers and first-turn ownership. Preserve sequential operations that own a runtime replacement. MCP config is needed before extension construction; do not blindly `Promise.all` the factory.

**Proof:** real pinned-engine cold/warm opens with default features, multiple recovered sessions and a safe fake provider. Packaged-runtime checks remain required. A faster preview must still create no durable conversation.

### F20 · P2 · Run registry repeatedly scans/clones retained history — confirmed

**Source:** `host/src/agents/runs.ts:46–111,200–222`.

Each upsert prunes by scanning retained runs. Lookups by child/root/project scan collections; `latestFor()` clones/sorts child runs and sorts again by live priority. Full decoration creates cloned latest-run records. Retention is bounded per project, not by a small global number.

**Change:** maintain child/root/project indexes and live-run counts; use incremental retention bookkeeping or a scheduled bounded pass instead of a full prune on each upsert. Preserve copies at public mutation boundaries rather than repeatedly cloning internal lookups.

**Guard:** stale updates, worker loss, worktree removal, successor runs and live-before-terminal selection. No run/task completion or question may disappear due to retention changes.

**Proof:** thousands of retained runs plus simultaneous tool/lifecycle updates; compare registry answers with the current implementation and test mutation isolation.

### F21 · P2 · Slow consumers can accumulate transport/output buffers — confirmed, magnitude unmeasured

**Source:** `host/src/server.ts:793–810`; `relay/src/server.ts:411`; `host/src/relay-client.ts:543–585`; `worker/src/main.ts:94`; `pi-extension/src/modules/background-work.ts:294–302`.

Several sends/writes do not enforce a byte high-water mark. A frame-size ceiling is not a total-queue ceiling. Background command output calls the log stream's `write()` without reacting to false; fast output and slow storage can grow pending buffers even though the tail buffer itself is bounded. Relay send promises can queue behind a slow socket.

**Change:** byte-account queues, observe writable backpressure and instrument buffered bytes. Isolate slow clients so they cannot stall healthy views or agent execution. Prefer an explicit disconnect/resume policy over silently dropping authoritative events. Long-command output needs an integration that can pause the producing pipe or a clearly reported bounded logging policy.

**Guard:** cancellation, permissions, durable task output, exit-after-final-output ordering, reconnect and generation ownership. Never parallelize encryption on a shared counter-based cipher. Never enable compression on encrypted relay traffic to solve queue pressure.

**Proof:** throttled client and throttled writable streams, reconnect during terminal events, sustained synthetic output; demonstrate a stable queue ceiling and complete recoverable state.

### F22 · P2 · Send inactive transcript traffic only where needed — confirmed opportunity

**Source:** `host/src/server.ts` broadcast policy and `attached` bookkeeping; `ui/src/store.ts:527–533`; `ui/src/client.ts` attach/resume handling.

Every local client receives every conversation's raw updates. Unopened views usually discard them, but still receive and parse them. Previously opened views can continue reducing them. The cost grows with concurrent agents and connected windows/devices.

**Change:** after F03, consider explicit subscriptions for full transcript content; keep small fleet/attention/question/lifecycle notifications global. This is a protocol/lifecycle feature, not a casual reuse of the existing retirement attachment set.

**Guard:** a phone must still learn of pending questions and finished work; cached histories must become stale or catch up correctly; subscribe/replay/live handoff needs one sequence boundary. Existing consumers may expect the full stream.

**Proof:** two clients following different sessions plus Beam; reopen, reconnect and dropped replay; no missed approvals or wrong unread state. Measure aggregate wire/parse CPU at 1/8/32 active sessions.

### F23 · P3 · Hidden-window and polling work — confirmed mechanisms, power unmeasured

**Source:** `desktop/src/windows.ts:339`; `ui/src/runtime/LaserProvider.tsx:652–655`; `host/src/agents/skills-check.ts:41–43,75–97`; `ui/src/components/thread/ProjectLine.tsx:72–83`.

Electron explicitly disables background throttling. Catalog polling continues while connected without a visibility test; scoped skill validation performs synchronous stats periodically. Git polling already checks visibility and should not be described as always-on.

**Change:** measure hidden/minimized CPU first. Pause nonessential presentation refreshes while hidden, reconcile immediately on return, and deduplicate identical skill-path checks. Retain a slow host reconciliation fallback for externally edited files.

**Guard:** do not pause agent execution, native notifications, pending questions, transport liveness or dictation ownership. Seeing a hidden transcript must never mark it read. Do not flip Electron throttling globally without lifecycle tests.

**Proof:** visible/hidden/minimized measurements with idle and active work; wake/reconnect, late notifications and Settings-covered views.

### F24 · P3 · Static assets and heavyweight diagnostic views — confirmed

**Source:** `host/src/server.ts:933–977`; `ui/src/components/logs/ApiRequestDialog.tsx:158–169,239–281`.

HTTP static serving synchronously stats/reads files and sends no explicit cache validators or immutable-asset headers. The service worker already caches assets after installation, so the remaining benefit depends on cold/update/non-SW paths. The request inspector parses up to 8 MB on the renderer and can render many expanded fields or full JSON/search structures.

**Change:** async static reads/streaming, immutable caching for content-hashed assets, revalidated shell/worker, and optional build-time compression for **static public assets only**. For large diagnostic payloads, profile parse/pretty-print/tokenization and defer heavy work or use a bounded worker with stable source ranges.

**Guard:** retain traversal protection, MIME types, SPA fallback and error isolation. No caching private RPC/transcript data. Inspector copy/full-request search must retain every original key/value/syntax character; do not apply conversation search's value-only filtering.

**Proof:** simultaneous asset requests and session traffic; clean install/update/offline generations. Inspector keyboard search, source provenance, wheel scrolling and full copy on multi-megabyte synthetic captures.

## 4. Parallelism: concrete opportunities and non-opportunities

**Bound concurrency; preserve deterministic result order.** Parallel I/O can reduce elapsed time, but simultaneous JSON/diff work on one JS thread is not CPU parallelism.

| Operation | Safe candidate | Must stay ordered / condition |
| --- | --- | --- |
| Git status miss | Baseline diff alongside upstream lookup; counts and URL after upstream; bounded new-file reads | Baseline capture semantics, read limits, subprocess limits |
| Project file scan | Cached/deleted/untracked `ls-files` reads; bounded fallback directory traversal | Tracked-first dedup, ignored/deleted filtering, deterministic 50k ceiling |
| Saved-history search | Small pool of independent files | Goal/tool interpretation within each file; ordered contiguous cursor; cancellation |
| MCP discovery | Import file reads; project/global secret reads | Merge project precedence explicitly; never log secrets |
| MCP setup | Single snapshot, server secret resolution already parallel | Config before adapter construction; per-session tool/question ownership |
| Session move UI refresh | `refreshProjects()` and `refreshSessions()` after successful move (`LaserProvider.tsx:1188–1198`) | Move, untrack and old-view invalidation must finish first |
| Worker recovery | Small pool of independent session opens, visible session first | Real-engine concurrency proof; shared resource registration and first-turn fences |
| Feature changes across projects | Bounded independent worker restarts (`host/src/router.ts:527–536`) | Busy/live-run refusal and restartPending reporting; never concurrent same-project workers |
| Worker shutdown | Independent session disposals, only after lifecycle shutdown admission | Shared MCP/task resources and durable flush ordering need tests first |
| Relay startup | Channel derivations for independent devices (`host/src/server.ts:465–502`) | Small likely gain; cipher send sequences are unrelated and remain serialized |
| Local-project migration | Batch independent requests only after avoiding repeated full project scans | One-time path, low priority; preserve person-defined project order |
| Asset initialization | Critical shell first; optional deferred loading | More parallel downloads can worsen startup contention; do not fetch everything immediately |
| Package installs/settings writes | **Do not parallelize by default** | Existing shared-state locks and serialized package operations protect correctness |
| Parent/child control | **Do not parallelize interrupt/stop/admission steps** | Queue takeover → exact-invocation cancellation → abort/fence → successor admission |
| Crypto transport | **Keep each send direction serialized** | Sequence/nonces/rekey epoch are security invariants; devices may remain independent |

## 5. Smaller opportunities and deliberate deferrals

- **File ranking:** `worker/src/files.ts:276–304` repeatedly normalizes paths/query and sorts every match before returning 50. Cache normalized path/name facts, normalize the query once, and use deterministic top-K selection if 50k-file workloads matter. The 10.44 ms probe is useful but not a startup priority.
- **Directory walkers:** replace front `shift()` queues with an index/deque; the async directory traversal and unnecessary filesystem operations generally matter more than the array operation alone.
- **Run/task clocks:** shared clocks already exist. Avoid adding an interval per row; separate elapsed labels from full tree rebuilding.
- **Large images:** paging avoids fetching old pages, but an image in the visible page is still large. Consider explicit image/content references and dimensioned, asynchronous/lazy previews as a separate transport feature, preserving full-quality zoom/copy/download. Do not silently downsample source attachments.
- **First-start desktop checks:** `host-process.ts:183` starts bundled-engine verification alongside host work already. Do not describe those as wholly sequential or promise its full duration as savings. Profile secrets/shell-environment work separately and retain all version/engine checks before unsafe actions.
- **CLI and package management:** large source files are not evidence of runtime hotspots. The normal UI rejects legacy package installation methods; optimizing that dormant path does not make chat snappier.
- **Crypto:** no evidence here supports replacing WebCrypto/noble algorithms. Keep known-answer tests, non-extractable keys and serial counter ownership.
- **Prompt/provenance:** cannot cache by reopening current instruction files or changing request assembly. Cache only against captured immutable identities/digests and keep observers isolated. Main has provenance work beyond the branch's base; audit any merge before touching this path.
- **Avoid blanket memoization, global GPU flags, shortened animations, lower font sizes, dropped approvals, polling removal without reconciliation, or disabling diagnostic/security checks.** None is a demonstrated solution to these findings.

## 6. Implementation order and acceptance gates

### Dependency-ordered work

1. **Land/settle M16-T16 with its existing owner.** Do not fork another paging/virtualization architecture.
2. **Independent low-surface changes:** F01 scanner copying, F02 request-local metadata dedup, F03 unnecessary raw broadcasts, F08 bounded Git reads. These can be separate lanes with file ownership agreed first.
3. **Streaming work:** F04 batched store publication and F05 narrow selectors; integrate F06 with the settled paging implementation. Coordinate ownership of `LaserProvider.tsx`.
4. **Read/background work:** F07 cancellable search, F09 Git DAG, F10 logging, F20 run indexes; bounded workloads before broad concurrency.
5. **Memory and delivery:** F11 byte budgets, F21 backpressure, F22 content subscriptions; these need explicit lifecycle/protocol designs.
6. **Startup/large surfaces:** F12–F18 and F23–F24, guided by fresh browser/power profiles.

### Measure the experience, not a misleading proxy

Use isolated production builds of UI + host + worker from a recorded source snapshot. Benchmark 4/240/2,000 messages and a larger stress case; text, tools, reasoning, goals, images and branched histories. Include many saved sessions, many projects and concurrent agents.

Record separately:

- Click → correct destination tail; input → next paint; first stream → paint.
- Renderer long tasks, React commits, selector calls, scripting, layout and GC.
- Host/worker event-loop delay while search/logging/Git/streaming compete.
- RPC handler time versus client-observed round trip, wire bytes and queued bytes.
- Mounted message count, retained heap after GC, open runtime count and cache bytes.
- Cold process startup, warm session open, clean SW install/update and hidden-window power.

Use at least 20 paired samples for a p95-oriented acceptance run; retain raw samples and environment identity. Do not combine different fixture sizes or infer production savings from a single microbenchmark. Adopt M16-T16's existing switch/anchor targets rather than inventing a second target set.

### Zero-UX-regression checklist

- Desktop and phone widths, dark/light, pointer/touch/keyboard, normal/reduced motion.
- A→B→C switching, late B response, failed load/retry, prior DOM continuity and destination-owned drafts/attachments.
- No send/stop/approval routed to the pending destination or the wrong Beam composer.
- Live reasoning/tool disclosures, manual override, collapsed bodies genuinely hidden, approvals outside folds.
- Stable visible-message anchor during prepend, disclosure, image/font/highlighter resize and streaming bottom-follow.
- Full history/find/jump/edit/fork navigation with original ordinals; no lost tool results or goal summaries.
- Queue/interrupt/answer/stop fences, first-turn rollback, nested needs-input and correct parent completion delivery.
- Reconnect/replay gap/worker restart/version mismatch; no stale-cache resurrection or duplicate assistant text.
- Native seen/attention behavior unchanged; hidden/unfocused/Settings-covered views do not acknowledge messages.
- Slow clients and disks never lose essential work; errors remain actionable and retryable.
- Existing protocol round-trips/router inventory/worker seams; UI interaction tests; identity and full verification after intended files are staged. Packaged real-session/model-list gate before release.

No optimization is accepted because the build is green alone. It needs both a measured gain on its intended workload and unchanged behavior on these boundaries.

## 7. Reproduction and audit limitations

Artifacts:

- `/tmp/laser-wide-perf-audit/probes.mts`, `results.json`, `probes.log`
- `/tmp/laser-wide-perf-audit/extra-probes.mts`, `extra-results.json`, `extra.log`
- `/tmp/laser-wide-perf-audit/source-manifest.json`, `precache.json`
- `/tmp/laser-wide-perf-audit/final-worktree-check.json`, `live-history-diff.txt` — final concurrent-change evidence
- Synthetic fixtures under that same directory; no personal transcripts or credentials.

Commands used (the same allowlisted environment for both programs):

```sh
env -i HOME=/tmp/laser-wide-perf-audit/home \
  XDG_CACHE_HOME=/tmp/laser-wide-perf-audit/cache \
  PATH=/opt/Laser/resources/runtime:/usr/bin:/bin \
  /opt/Laser/resources/runtime/node --expose-gc \
  --import /tmp/mcp-explore/spike/node_modules/.pnpm/tsx@4.23.13/node_modules/tsx/dist/loader.mjs \
  /tmp/laser-wide-perf-audit/probes.mts
# Repeat with extra-probes.mts for broadcast/realpath/diff checks.
```

Both programs exited successfully. They import worktree source plus its existing resolved dependencies; they are not a clean full-workspace integration build. Some probes deliberately call TypeScript-private methods at runtime or use mock sockets to isolate a cost. The broadcast test is a source-path test, not a real-host/relay integration test. The manifest is a mid-audit checkpoint, not proof that every file was unchanged throughout the session. Final comparison found ongoing edits in host router, UI store/provider, worker driver/server and Stable SDK driver; catalog, projection, Git/files, logstore and diff source used by the principal numeric probes remained unchanged from that checkpoint. The preserved live diff adds history handling, not a fix for the independent measured bottlenecks.

No new implementation, full test suite, browser performance matrix, real-device power test or release validation is claimed. Findings involving browser commits, memory retention, slow disks/networks, engine service reuse and concurrency remain to be profiled at integration level. A comprehensive static audit cannot establish a "perfect" or bug-free performance outcome without those measurements.

## 8. External references

These support the techniques, not Laser-specific performance estimates:

- [Node: don't block the event loop or worker pool](https://nodejs.org/en/learn/asynchronous-work/dont-block-the-event-loop) — synchronous I/O and long callbacks delay unrelated work; also bound async work.
- [Node filesystem APIs](https://nodejs.org/api/fs.html) — asynchronous filesystem operations and file-handle APIs.
- [Node worker threads](https://nodejs.org/api/worker_threads.html) — CPU parallelism; not a reason to spawn a thread for each I/O read.
- [React useSyncExternalStore](https://react.dev/reference/react/useSyncExternalStore) — stable snapshots and synchronous external-store consistency; transitions do not make arbitrary store changes nonblocking.
- [Electron performance guide](https://www.electronjs.org/docs/latest/tutorial/performance) — avoid blocking critical processes and loading code before it is needed.
- [MDN WebSocket](https://developer.mozilla.org/en-US/docs/Web/API/WebSocket) and [bufferedAmount](https://developer.mozilla.org/en-US/docs/Web/API/WebSocket/bufferedAmount) — no built-in incoming backpressure; queued outgoing bytes are observable but require an application policy.
- Existing `docs/perf-chat-loading.md` — paging/virtualization research and the branch owner's measured baseline/acceptance contract.

## Implemented — renderer lane

### F04 — batched external-store publication

`HostClient` wraps its existing synchronous frame/timer/barrier delivery in a
store transaction. Every reducer action and event listener still runs in arrival
order; imperative snapshots immediately contain each accepted sequence. Only
subscriber publication waits until the transaction finishes (including throws).
No new scheduling layer, delta merging, history action or hydration change.

Measured paired call counts in `test/client.test.ts`: **32 → 1 subscriber
publications** for 32 text deltas, with **32 → 32 reducer calls and event-level
observations**. Identical immutable final state, tested separately at frame,
hidden-tab timer, dialog, RPC-reply and disconnect barriers. These are deterministic
source integration counts, not browser React commits or elapsed-time savings.

Validation at base `413c8e2` plus this commit: UI TypeScript passes; UI suite
**164 files / 1,383 passed, one pre-existing benchmark skipped**; identity passes.
Logs: `/tmp/perf-renderer/f04-{focused,types,ui,identity}.log`. Browser performance
and the lane-wide visible-surface acceptance matrix remain outstanding.

### F05 — presentation subscriptions and shared fleet structure

The provider's render-only snapshot compares the fields its shell derivations
actually read; imperative actions still read the authoritative store. Fleet
consumers share a weakly owned structure cache, with elapsed labels updated
without rebuilding ancestry. Session metadata, telemetry sections, and the draft
restore utility no longer subscribe to transcript bodies. Title inputs (including
the fleet's first nonempty user line), dialogs, lifecycle, catalog membership,
run/task activity and independently scoped stores remain observable.

Measured React executions over **10 separately flushed deltas × 1/8/32 streams**:
broad subscribers **10/80/320**, narrowed shell/fleet/session-meta subscribers
**0/0/0** each, excluding mount. Structural fleet builds across repeated consumers
and five clock ticks: **8 calls → 1 build**; output equals uncached derivation at
every tested timestamp. No browser CPU or power reduction is inferred.

Validation: UI TypeScript, **165 files / 1,388 tests passed, one benchmark skipped**,
and identity pass. `test/runtime/presentation-state.test.tsx` covers counts,
clock/output equivalence, rename, branch prompt, membership and needs-input
invalidation; existing fleet/telemetry/runtime/disclosure tests stay green.
Logs: `/tmp/perf-renderer/f05-{types,ui,identity}.log`. This base has no paged
catalog reference-set derivation; those M16-T16 additions are not rewritten here.

### F14 — implemented locally, browser acceptance blocked (not accepted)

Uncommitted measurement-only change: binary-search the normal-flow message roots
before reading the viewport neighborhood. The existing map owns scrolling;
no virtualizer/history contract or jump controller was added. A ResizeObserver
also follows the existing message container for disclosure/image height changes.
The DOM root query remains linear; the costly rectangle reads do not.

Fresh deterministic 2,000-root test: **2,000 → 14 rectangle reads** near the tail;
reading identity matches the original scan across gaps and tall/resized bodies.
Production browser, 2,000 synthetic messages, 20 alternating tail scroll samples:
**16–17 total message-root rectangle reads/frame** (includes all app callers).
No paired browser latency improvement is claimed. Raw counts and environment:
`/tmp/perf-renderer/f14-browser.json`, `f14-build.log`, `seed.mjs`, `paths.json`.

TypeScript, UI **166 files / 1,390 passed, one benchmark skipped**, production UI
build and identity pass. Browser screenshots at 1360/390 show the correct tail
and no page overflow, but **all captures remained light**, including attempted
dark cases. Those files are explicitly renamed `attempted-dark-actual-light`.
A subsequent theme-button click and browser snapshot search timed out. Browser
matrix, keyboard/touch, find/jump and live resizing acceptance remain incomplete;
do not accept this finding based on its green unit suite. Source is uncommitted.

F14 continuation: coordinator authorized committing the tested implementation
with **browser acceptance outstanding**, to be covered once for the integrated
lane rather than used as a per-finding gate. The preceding blocked checkpoint is
retained as history; the measurement and test evidence above remain unchanged.

### F15 — incremental conversation search and native ranges

Weak caches retain display projections by immutable part and query matches by
immutable message identity (one query per message). A live suffix reuses settled
hits. DOM range caches invalidate only changed/remounted message roots; native
ranges follow scroll without new text walks. Selection changes repaint cached
highlights separately from the selected-result geometry. Literal request-inspector
search is unchanged; no React-owned text nodes are wrapped or replaced.

Measured regression fixtures: updating the last of **2,000 messages** projects
**2,000 → 1 parts**, retaining the settled hit objects and identical search output.
With find open over **240 mounted messages**, coalesced scroll costs **240 → 0
text walks**, one changed/remounted root **240 → 1**, and selection navigation
performs only its one geometry traversal. Tests exercise real MutationObserver,
React remounts, focus, folded content, native ranges and closing cleanup.
Loaded-history scope/window actions stay with M16-T16; flattening the hit list
still visits loaded message identities.

Validation: TypeScript, **167 UI files / 1,392 tests passed, one benchmark skipped**,
identity and diff checks pass. Logs `/tmp/perf-renderer/f15-{types,ui,identity}.log`.
Initial test needed to await the existing selected-result scroll timer rather than
count it as a content invalidation; generated browser YAML was moved intact to
`/tmp/perf-renderer/playwright-artifacts` after identity correctly rejected it as
repository source. Browser acceptance remains outstanding for integrated testing.

### F13 — close eager highlighter and map import paths

File-card filename inference now imports a dependency-light grammar helper.
The public highlighter is a shared lazy boundary for **all** callers (including
request diagnostics and file previews), not just Markdown fences. Themes and
filename helpers do not import react-shiki/core. The compact lineage caption is
independent of the canvas; React Flow loads only when a measured canvas is used.
Map chrome, layout/state and the same-sized plain-code fallback remain in place.

Fresh paired production Vite builds with source maps/manifests (same environment,
F15 source plus/minus F13): static entry **2,648,508 → 2,337,557 bytes**;
gzip **791,658 → 692,628 bytes**. Static dependency traversal finds **2 → 0
XYFlow modules** and **4 → 0 highlighter/core modules**. Optional grammars remain
available, not deleted. Files and raw inventory: `/tmp/perf-renderer/f13-bundle.json`,
`f13-{before,after}/`, `f13-{before,after}-build.log`. This measures emitted code,
not first-install SW transfer or browser execution time.

**Math deferral deliberately not forced:** `markdown-text.tsx:236–264` has one
synchronous parser/component tree with provenance wrapping and eager math plugins.
A lazy plugin inserted after paint changes parsing/height (and may remount source
controls); suspending the whole live message hides existing content. Neither meets
F13's no-layout-shift/focus boundary without a separately proved math-loading
presentation. KaTeX remains eager (two mapped modules), and existing math/currency/
code/provenance behavior is unchanged.

Validation: TypeScript, **168 UI files / 1,393 tests passed, one benchmark skipped**,
identity and both production builds pass. The new highlighter test proves zero
engine-module loads for path labels/streaming and one on settlement, preserving
literal escaped text. Existing full-language and map status/selection/layout tests
pass; map tests now await real lazy-canvas settlement before measuring nodes,
not an assumed synchronous mount. Browser acceptance remains outstanding.

### F17 — stopped at the host capability seam (no renderer workaround)

Reverified: `protocol/src/messages.ts:38–45` gives `ModelRef` only an optional
reasoning boolean, not accepted thinking levels or per-model defaults.
`pi/model/list` (`:1026`) returns that same insufficient type. Only
`ModelCatalogEntry` (`:628–651`) plus `pi/models/catalog` supplies the capability
and configuration defaults consumed by `reasoning-effort.tsx:204–241`.

**Rejected as a renderer-only optimization:** dropping the catalog request or
substituting `reasoning: true` would guess supported levels and break first-turn
agent/model/default clamping. A small host-owned capability response for the
requested/effective model (including accepted levels and configured defaults) is
required first. No host/protocol mutation was made. Startup catalog traffic is
**unchanged**; no byte/latency reduction or implementation completion is claimed.
Caches keyed by client/configuration generation should be addressed with that
method rather than creating a second provisional lookup contract here.

Validation of the unchanged renderer: TypeScript and identity pass; final UI
recheck **168 files / 1,393 passed, one skipped**. One preceding broad run failed
`catalog-arrival.test.tsx:246` after its fixed 100ms wait (destination still blank);
focused reproduction and the full-suite recheck passed without source changes.
This is recorded, not labeled proven flaky. Logs `/tmp/perf-renderer/f17-*` retain
both runs. No new regression test is claimed for an intentionally unimplemented
host seam. Coordinator/host-method ownership is the next action for F17.

### F23 — suspend hidden catalog polling, reconcile on return

The provider's existing 20-second presentation poll now owns a visibility-aware
scheduler: no interval while hidden, one immediate refresh on becoming visible,
then the existing cadence. Duplicate visibility events do not add refreshes;
a queued tick checks visibility before requesting. Disconnect/unmount removes
both timer and listener. Initial/reconnect/notification-driven refreshes are
unchanged; transport, questions, running work, dictation and seen/attention paths
are untouched. Electron throttling and host skill checks remain outside this lane.

Paired fake-clock lifecycle measurement over 60 seconds at the existing cadence:
visible refreshes **3 → 3**; hidden refreshes **3 → 0**; return **one immediate
refresh**; after cleanup **0**. Tests also cover initially hidden views and a
visibility transition before its event is delivered. This is eliminated polling
work, **not measured CPU/power savings or minimized-Electron acceptance**.

Validation: TypeScript, **169 UI files / 1,395 tests passed, one benchmark skipped**,
identity and diff checks pass; logs `/tmp/perf-renderer/f23-{types,ui,identity}.log`.
Browser/minimized-window acceptance remains outstanding for integration.
