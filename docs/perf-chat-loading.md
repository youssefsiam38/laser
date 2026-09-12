# M16-T16 — chat-style conversation loading

## Recommendation

Separate **catalog summaries**, **loaded history**, and **mounted rows**. Page the first two and virtualize the third. Keep the current conversation mounted until the destination is ready; never make an old composer send to a pending destination.

This document contains research, a fresh baseline, and the implementation contract. **Catalog paging (A) is implemented below; transcript stages B–E remain outstanding.** Baseline base: `a0690d36d600bbc3913a055abae1680dc5930f8f`, isolated branch `agents/chat-loading-9210c750`.

## Research: established techniques, not guesses about competitors

| Source | Supported finding | Application here |
| --- | --- | --- |
| [Slack: being lazy](https://slack.engineering/making-slack-faster-by-being-lazy/) | Load active-channel history first; lightweight unread metadata; prioritize likely-next histories. Slack describes 42-message pages. | Seven summary rows per project; provisional 40-message transcript tail; bounded speculation. |
| [Slack: lazy loading, part 2](https://slack.engineering/making-slack-faster-by-being-lazy-part-2/) | Broad persistent message caches bring correctness and startup costs. | Session/epoch-scoped memory cache, not a second persistent transcript store. |
| [Slack: cursor pagination](https://slack.engineering/evolving-api-pagination-at-slack/) | Cursor pagination handles changing collections better than positional offsets. | Stable entry IDs and snapshot-aware history cursors; catalog tie-break by path. |
| [Discord: native performance](https://discord.com/blog/how-discord-achieves-native-ios-performance-with-react-native) | Describes virtualized web lists and recycled native lists, lazy inflation, and chat data fetched through JavaScript. | Do not mount every message merely because CSS skips its paint. Native results are not web benchmark predictions. |
| [WhatsApp: linked-device history](https://faq.whatsapp.com/web/chats/about-message-history-on-linked-devices?lang=en) | Recent history is synchronized to linked devices; available history differs by device. | A usable recent conversation need not await its entire archive. This does not establish WhatsApp's DOM implementation. |
| [Apple: Messages setup](https://support.apple.com/guide/iphone/set-up-messages-iph3d039b67/ios) | Documents history synchronization, not its row-windowing implementation. | Do not claim a specific iMessage virtualizer or page size. |
| [Linear: delta sync](https://linear.app/now/rebuilding-delta-sync-read-path) | Checkpointed changes and selective enrichment avoid repeatedly transferring whole records. | Preserve sequence boundaries and reuse settled message identities; do not introduce a second sync engine. |
| [OpenAI: web networking](https://help.openai.com/en/articles/9247338) / [Anthropic: personalization](https://support.anthropic.com/en/articles/10185728-understanding-claude-s-personalization-features) | Document transport/history capabilities, not authoritative details of ChatGPT/Claude web row virtualization. | No verified claim about their exact loading algorithm. Public API pagination is not evidence of the web client's implementation. |
| [React: useDeferredValue](https://react.dev/reference/react/useDeferredValue) / [Suspense](https://react.dev/reference/react/Suspense) | Deferral can keep stale content displayed and interrupt background rendering. It does not reduce network requests or guarantee a cheap commit. | Destination readiness is explicit; transitions supplement, never replace, identity and cancellation guards. |
| [web.dev: content-visibility](https://web.dev/articles/content-visibility) | Skips offscreen rendering work while retaining DOM. | Keep as a supplementary optimization, not the solution to mounted subscriptions and teardown. |
| [assistant-ui primitives](../.agents/skills/primitives/references/messages.md#virtualization), [runtime](../.agents/skills/runtime/SKILL.md), [thread lists](../.agents/skills/thread-list/SKILL.md) | Virtualizer plus `ThreadPrimitive.MessageByIndex`; external-store runtime owns its data; thread lists support loading more. | Keep existing primitives/runtime. Connect server paging to existing group controls rather than replacing the sidebar. Verify installed declarations before implementation. |

Searches used `web_search`; competitor statements above are limited to what public sources establish. No authenticated competitor sessions or private data were inspected.

## Current implementation and constraints

- The real method is **`pi/session/list`**, not `pi/sessions/list` (`packages/host/src/router.ts:260`). It returns every decorated summary. `SessionCatalog.list()` enumerates every project directory and session file, performs cached/incremental summary scans, then sorts everything. Its cache is an in-memory metadata index, not a full-text index.
- M16-T10's `Load more` only unfolds already-delivered rows (`thread-list.aui.tsx`). Paging must retain empty-first ordering, archive-tree semantics, and selected/live/attention reachability. Never interpret a partial catalog as proof a remembered conversation was deleted.
- Saved-history `session/search` independently streams session bodies in the host (`session-search.ts`). It does not start workers or transfer full transcripts. **“Never loads bodies” is achievable for the sidebar/client, not a description of the existing full-text search implementation.** Retain this search route over the full catalog. A persistent full-text index would be a separate change, not a hidden requirement of paging.
- `pi/session/entries` returns a full cached `{entries, leafId}`, otherwise forwards to a worker and caches its full response (`router.ts:332`). Never put a partial page into that full-snapshot cache.
- `StableSdkDriver.open()` opens `SessionManager`, reads existing entries/overrides, builds the runtime and its resources, binds extensions, and restores fallback state. Its `entries()` returns the engine's complete tree plus the **in-memory leaf**, which can differ from the last disk entry after navigation. Keep engine loading unchanged. A host disk tail is not an authoritative replacement for an already-open engine's leaf.
- `LaserProvider.openSession()` deduplicates opens, resumes by sequence, hydrates history after `session/load`, and fetches goal/pending decorations independently. Its `expectSeq` prevents stale hydration replacing live blocks. Paging requires a distinct prepend action; reusing full `hydrate` would replace live content or lose the older page on a race.
- `blocksFromEntries()` follows parent IDs, interprets durable/custom records and pairs tool results with calls. Slicing the last 40 JSON records is incorrect: a page must preserve complete message/tool groups, stable original ordinals and interpretation context.
- `ThreadPrimitive.Messages` mounts every projected row. Current `content-visibility` still leaves 56,512 elements for a 2,000-message conversation in the three-session fixture.
- `mainPath()` returns no displayed session during a resolving destination. Preserving a view therefore belongs in the destination/runtime projection, not a CSS screenshot or cloned DOM. The prior report explicitly warns that pending destinations do not own composers/drafts.

## Fresh baseline

### Environment and method

All fresh measurements use this worktree's newly built UI, host and worker at the SHA above, Node **24.11.1**, headless system Chrome, **1360×900 / light**, no CPU throttling. Synthetic sessions are created by the worktree's pinned `SessionManager`, using a local stub model and no personal credentials. No prompt/provider call is needed for opening these fixtures.

The original `/tmp/perf` scripts contain parent-checkout imports and shared mutable state. They were **read, not executed unchanged**. Adapted scripts, state, HOME, sessions and output live under `/tmp/chat-loading`; imports point to this worktree. The allowlisted environment drops inherited authentication/session variables. Root dependencies were initially unavailable; the prescribed two-minute wait and one retry produced a successful complete build. No `pnpm install` was run by this worker.

Measurements distinguish three operations:

1. **Switch:** resolved pointer coordinates before timing; capture-listener click timestamp → expected assistant-row count and enabled textarea → one further animation frame. Three samples/destination, warmed host, one browser, three sidebar sessions. This is a DOM-ready/paint-opportunity proxy, **not measured input latency**.
2. **Fresh-browser restoration:** navigation time origin → the same readiness criterion, fresh browser context per sample, warm host/worker. Three samples/size. This later fixture has 154 catalog sessions, so it is **not directly comparable to the switch table's sidebar workload**.
3. **RPC:** separate Node WebSocket without a busy browser; five warm reads/size. Wire bytes include the JSON-RPC envelope.

### Results

| Destination | Switch median (range), ms | Fresh-browser restoration median (range), ms | Warm entries median, ms | Entries wire bytes |
| --- | ---: | ---: | ---: | ---: |
| 4 messages | 1,390.1 (332.3–1,439.1) | 767.9 (767.5–780.3) | 0.327 | 1,924–1,925 |
| 240 messages | 639.7 (389.2–664.7) | 1,160.6 (1,139.2–1,163.0) | 0.820 | 96,706–96,707 |
| 2,000 messages | 4,133.0 (4,072.6–4,721.4) | 2,717.3 (2,654.9–2,730.6) | 4.797 | 805,107–805,108 |

Switch order repeats **2,000 → 4 → 240 → 2,000**. The slow 4-message destination is evidence that the previous transcript's work matters; it is not evidence that four messages take 1.4 seconds to fetch. Full DOM counts after switching: **615–616 / 7,220 / 56,512** respectively. Warm `session/load` medians are **1.368 / 1.081 / 1.267 ms** respectively.

An additional **40-message** sizing fixture restored in **806.4 ms median (793.5–916.1)**, 3,915 total DOM elements with 155 catalog sessions. This supports starting at **40 displayed messages**, not an optimality claim: text-only fixtures do not bound the height/bytes of a tool-heavy turn. A true paged 40-message view must be benchmarked again; this probe is a complete short session, not an implemented tail.

**Catalog:** exactly **150 nonempty sessions across 10 projects**, six `pi/session/list` reads: **5.26 ms median (4.81–6.33)**, **54,398 bytes**, all 150 rows returned. Temporary fixture parking excluded the other synthetic controls during this probe; they were restored afterward. This measures the warm full catalog route, not cold filesystem traversal. An earlier 153-session sample is retained separately in `rpc-results.json` and is not substituted for the exact-150 result.

**Image wire probe:** a user image part containing **1,048,576 decoded bytes** produced **1,398,990 wire bytes**, **19.15 ms** for one entries read. Its base64 encodes synthetic zero bytes, **not a decodable PNG**; this establishes transport amplification only, not image rendering/decode performance. Text pagination alone does not cap a page containing a large image.

Historical `docs/perf-analysis.md` reports 241/663 ms switches and ~115 KB for 240 messages; `/tmp/session-open-report.md` reports ~630 ms cold engine loading. Those are different revisions/workloads/operation definitions, **not this run's baseline**. Cold-worker opening, phone/dark performance, real image decode and input latency remain unmeasured here.

### Targets, not claimed improvements

| Gate | Target |
| --- | --- |
| Warm click → destination tail, 4/240/2,000 | median ≤150 ms; p95 ≤250 ms with at least 20 paired samples |
| Relative large-history switch cost | 2,000-message median ≤1.5× 240-message median |
| Fresh-browser restored conversation | ≤1,000 ms for all three sizes on this machine, warm host |
| Cold engine loading | unchanged semantics; report separately rather than promise <150 ms |
| Ordinary initial catalog rows | 70 across 10 projects, plus explicit pinned exceptions and required ancestors |
| Catalog payload, this fixture | <30 KB; warm RPC no regression beyond 10 ms |
| Plain-text first history page, this fixture | <25 KB at N=40, independent of total history length |
| Mounted transcript rows | viewport + overscan, ordinarily <40; focused/edited/approval rows may be pinned |
| Prepend position | same first-visible message ID and offset within 2 CSS pixels after measurement settles |
| Switching continuity | no frame with a blank transcript while a prior conversation is available |

## Proposed contracts and dependency order

### A. Paged catalog

Extend existing `pi/session/list` with an explicit paged variant; preserve the full route for callers that genuinely need complete summaries. First response includes **all project headers** (and totals) and seven recent ordinary rows per project; subsequent request identifies a project and its opaque cursor. Only summary fields travel.

- Sort deterministically by recency plus path. Exceptions are running, attention, empty, selected/needed destinations, and ancestor summaries required to keep their tree navigable. Deduplicate exceptions against the ordinary page; document that exceptions can exceed seven.
- Keep the empty-first rule in presentation. Do not count an empty pinned row against the seven recent ordinary rows.
- Return explicit `hasMore`/cursor per project. `Load more` requests seven more ordinary rows; `Show fewer` reduces visibility without throwing away fetched summary identities.
- Archive is currently client-owned. Supply an explicit exclusion/visibility scope or refill past archived rows until seven visible ordinary rows are available. Paging raw rows and then hiding the first seven can otherwise yield a falsely empty group. Refresh must reconcile removals without dropping already-fetched older pages or their fold state.
- Cursor scope includes project/filter/order revision. A changed catalog can invalidate/restart a page rather than silently skip/duplicate rows. Concurrent refresh and load-more are fenced per project; stale responses cannot resurrect deleted rows.
- Confirmed by the coordinator: “never loads bodies” refers to the client/sidebar. Full-catalog search remains host-side, independent of the loaded sidebar page, retaining its current streaming file reads. No persistent full-text index is required. Destination resolution and archive-tree operations must not mistake the partial sidebar array for the full catalog.

**Tests:** schema round-trip and router route inventory; tied timestamps; 150/10 fixture; exceptions/dedup/ancestor closure; archive-only first page; empty-first; refresh while paging; deletion/move; hidden remembered destination; keyboard/touch Load more and Show fewer. **Invariants:** host-only metadata parsing (1), engine-neutral protocol (2), no file writes (8), native attention/seen ownership unchanged.

### B. Tail-first entries and incremental hydration

Proposed request shape: `{path, window: {tail: 40}}`, older `{path, window: {before: cursor, limit: 40}}`; omitted window retains full-tree retrieval. Return page entries, authoritative leaf, cursor/completeness, stable original message ordinals, interpretation context and a snapshot identity. Implement the protocol first and validate limits/cursor size/scope.

- Page **active-branch displayed message groups**, not raw array offsets. Keep tool calls/results, parent-agent markers, goals, compaction/model context and attachments interpretable at the cut. Include only needed context records, not old message/image bodies disguised as context.
- Preserve original ordinals/IDs across prepend so edit/fork/jump/search destinations cannot shift to a different message. Incomplete versions/tree are explicitly incomplete, never falsely “one version”. Load required history/tree before actions that need it. Engine still owns stop-first edit/fork/jump semantics.
- Do not cache a partial response as a full `views` snapshot. Cursor binds to path and branch/snapshot identity; navigation invalidates old pages. An append may preserve the prefix cursor; a branch change/rewrite requires a new tail.
- Page state is per conversation: loaded entries, oldest cursor, completeness, in-flight/error, snapshot epoch. Prepend deduplicates by stable entry ID and builds only older groups; reuse settled blocks/messages. A stale page must neither regress `lastSeq` nor overwrite current live blocks.
- Preserve `expectSeq` during initial hydration. Explicitly test an update arriving before and after both tail and older-page responses: today's “keep live blocks” rule alone is insufficient when a partial view has not yet incorporated the historical prefix. Snapshot sequence and live suffix must compose, not silently lose one side.
- Settlement refresh updates the tail/tree metadata without converting every partial conversation back to a full history. Deduplicate initial refresh/settlement reads by session/snapshot and in-flight identity.
- Use a top sentinel **and an accessible Load earlier button**. Coalesce repeated intersections; errors remain retryable. Capture first-visible message ID and offset before prepend, then restore after React commit and measured heights, not a fixed timeout or scrollHeight delta.
- Loaded-history find states its scope and offers **Load all to search**. Cancel/close invalidates asynchronous search work. Global saved-history results first load the needed history, then locate the true ordinal. Images outside loaded pages do not arrive; image bytes inside a page remain a separate byte-budget concern.

**Tests:** real worker + host router, full-route compatibility, cursor validation, branch cuts and malformed IDs, tool call/result cut, custom/goal records, late pages after switch/rewrite, stream/tail/prepend races, replay gap/restart, settled refresh, live partial output remains artifact not terminal result, find/load-all cancellation, unloaded edit/fork/jump, no duplicate messages. **Invariants:** engine-neutral protocol (1/2), both driver seams if touched (3), one writer (8), transcript escaping (9), live activity guards and sequence ownership.

### C. Preserve the previous transcript during switching

Represent requested destination and displayed ready destination separately in the existing destination controller. Retain the old runtime/DOM until the new tail is accepted, then atomically swap. Preserve the pending sidebar indication; do not acknowledge the new session as seen until it is genuinely displayed/focused.

Fence actions on the retained conversation while a different destination is pending, clearly identify loading, and preserve its draft/attachments. Do **not** implement an implicit queue into the new destination. A→B→C must ignore late B; failed B retains A with a retryable destination error. Same-session refresh keeps the bound composer usable as today. Initial opening without a prior transcript retains the existing delayed skeleton; no fake transcript for empty/new sessions.

**Tests:** DOM-node continuity through delayed tail, failed open/retry, rapid A/B/C, same-session refresh, drafts/attachments and send routing, seen/attention gating, Beam scope, reconnect, reduced motion. **Invariants:** destination identity, one acknowledged visible session, no accidental prompt/stop, pending optional reads remain independent.

### D. Window mounted rows

Use a measured-height virtualizer around existing `ThreadPrimitive.MessageByIndex` (installed declarations are authoritative). Preserve the actual thread viewport and sticky composer, stable message-ID keys, padding spacers and token-derived sizing estimates. Start with roughly five rows of overscan; measure tall-tool/Markdown/image cases before tuning.

Keep all **loaded** messages in runtime state; only mount the visible window. Pin focused/editing/active approval rows until interaction finishes. Integrate scroll-to-message/find/conversation-map with a shared “ensure mounted, then measure” operation. Native DOM ranges cannot find unmounted text. Disclosure/image resize restores the message anchor unless the person is following the live tail; do not fight user scrolling. Reduced motion changes animation, not reachability.

`content-visibility` alone does not satisfy this stage. Deferring the same 2,000-row commit is not virtualization. Avoid introducing another competing scroll controller beside the existing restoration/disclosure/find logic.

**Tests:** bounded DOM count; first/last/distant row reachability; reverse scroll/page prepend; tall resizing content; keyboard focus/edit pinning; native find range after mounting; map/jump; version changes; disclosure anchoring after commit; bottom-follow during streaming and detached scroll position. **Invariants:** activity/approval ownership, keyboard/touch/theme parity, value-only search and token system.

### E. Bounded speculative tail prefetch

After A–D settle, pointer hover and keyboard focus may prefetch one likely destination tail. Reuse the previous conversation's accepted tail. Bound to two cached conversations / one speculative request and a byte budget; use short dwell, deduplicate against actual open, and discard stale path/branch/epoch replies. Touch opens normally and never depends on hover.

Prefetch is read-only and must not select/attach/mark seen, request trust, start a model turn, or hydrate an inactive runtime. **Current cache misses start a worker** through `workerFor`; do not disguise that as cheap metadata prefetch. Prefer an already-authoritative cached snapshot or an explicitly read-only host path; a disk read must not override an open engine's in-memory leaf. If neither is available, skip speculation rather than introduce a new worker lifecycle as a side effect.

**Tests:** dwell/cancel, hover A then B, keyboard focus, open joins prefetch, stale replies after branch/worker restart, byte/LRU eviction, failed speculation invisible to current view, no seen/attach/trust/worker-start side effects, phone has no hover dependency.

## Validation recipe and remaining work

Fresh commands executed:

```sh
export PATH=$HOME/.nvm/versions/node/v24.11.1/bin:$PATH
pnpm -r build
# Initial missing-package failure; prescribed wait 120 seconds; retry passed.
python3 /tmp/chat-loading/clean.py node /tmp/chat-loading/host.mjs
python3 /tmp/chat-loading/clean.py node /tmp/chat-loading/seed.mjs
python3 /tmp/chat-loading/clean.py node /tmp/chat-loading/measure.mjs
python3 /tmp/chat-loading/clean.py node /tmp/chat-loading/rpc.mjs
python3 /tmp/chat-loading/clean.py node /tmp/chat-loading/startup.mjs
python3 /tmp/chat-loading/clean.py node /tmp/chat-loading/seed-tail.mjs
python3 /tmp/chat-loading/clean.py node /tmp/chat-loading/tail-startup.mjs
python3 /tmp/chat-loading/clean.py node /tmp/chat-loading/catalog.mjs
```

Evidence: `/tmp/chat-loading/{baseline-results,startup-results,tail-startup-results,rpc-results,catalog-results}.json`; scripts beside them. Build logs: `/tmp/chat-loading-build.log`, `/tmp/chat-loading-build-retry.log`. The baseline screenshot is inspection evidence only, not a four-layout acceptance matrix.

Transcript implementation B–E is **outstanding**; A is recorded below. Each A–E is an independently testable commit boundary, with B requiring the largest lifecycle contract. After each implemented boundary run host/protocol/UI tests, touched worker seam tests and identity; finish with the required real 1360/390 × light/dark browser matrix, normal/reduced motion, keyboard/touch and before/after paired samples. Append after results here; do not compare a 154-session startup to a three-session switch or call a short complete transcript a proven paged implementation.

## Implementation A — paged catalog

The existing `pi/session/list` now accepts `page` with a default seven-row quota, keyset cursor, per-project expanded quotas, archive exclusions, explicitly included destinations/pins, and presence probes for fleet references. The omitted-page route still returns all summaries; saved-history search remains unchanged. All project headers and true counts remain available. Chat's private directories page as one logical group, as does Beam.

Running/attention/empty rows bypass the ordinary quota. Selected/pinned parents retain their branch and visible children retain ancestors. Thus seven is an ordinary-row quota, not a promise that live work will be hidden to enforce a hard cap. Presence probes return booleans for referenced paths, not a complete client-side identity index; absence from a page never proves deletion. Beam restoration, fleet deletion/reachability, startup memory, project counts/removal, archive-tree operations, both searches and the command palette were audited against this distinction.

The UI requests older pages from the host and retains fetched summaries when folded. Project and Chat controls retain focus through a delayed final page and `Show fewer`; empty-first and live exceptions remain. Identical in-flight refreshes coalesce, stale replies are fenced, expanded quotas survive a component/provider remount within the same page, and periodic refreshes refill those quotas. Explicit archive disclosure, title/global search and the command palette may request the complete **summary** list on demand; archive mutations query the complete summary tree without installing it into the sidebar. No message bodies are fetched by these catalog operations.

Implementation detail versus the proposal: catalog cursors are deterministic `(modifiedAt, path)` keysets, not retained immutable catalog snapshots. A refresh reconciles the expanded quota against current recency; pages deduplicate by path. The existing host catalog still scans/stats its complete metadata index. This change bounds rows transferred/mounted initially, not host filesystem enumeration.

### A measurements

Final production UI/host built from this worktree, same isolated Node/Chrome recipe. Ten alternating full/paged route samples over **exactly 150 seen, nonempty sessions / ten projects**:

| Route on the same fixture | Rows | Wire bytes | Median ms (range) |
| --- | ---: | ---: | ---: |
| Full summaries | 150 | 58,148–58,149 | 5.13 (4.48–5.60) |
| Paged summaries | 70 | 30,300–30,301 | 7.68 (6.67–8.83) |

**47.9% fewer bytes and 53.3% fewer initial rows**, at ~2.55 ms additional host RPC time. The <10 ms target passes; the provisional <30 KB target narrowly misses (30.3 KB). The earlier 54,398-byte baseline had different attention/seen fields, so the paired full route above is the byte comparator. Unread/attention exceptions can legitimately return every row; the synthetic fixture was explicitly marked seen before this comparison.

The browser fixture additionally has five control sessions and fifteen Chat sessions. Its initial response is **82 rows / 36,151 bytes**, received **once** per fresh context rather than three identical initial reads observed during development. No transcript switch/open improvement is claimed at A: entries and mounted-message work are unchanged until B–D.

### A validation

- Production builds: protocol, host and UI **pass**; `/tmp/chat-loading-a-build-final.log`.
- Protocol: **106 tests / 10 files pass**; `/tmp/chat-loading-a-protocol-final.log`.
- Host: **236 tests / 31 files pass**, including router pagination, full-route compatibility and no worker start; `/tmp/chat-loading-a-host-final.log`.
- UI: **1,365 tests / 164 files pass, one existing benchmark skipped**, including type checks, delayed paging/focus, stale replies, archives and fleet presence; `/tmp/chat-loading-a-ui-final.log`.
- Staged identity and diff checks **pass**; `/tmp/chat-loading-a-identity-final.log`. Worker code/driver seam is untouched at A, so its focused SDK suite was not repeated.
- Real browser **1360/390 × light/dark passes**: both Project and Chat go 7 → 14 → 15 → 7, four actual cursor requests per case, original project-row DOM retained, final-page/fold focus retained, no horizontal page overflow or page errors. Desktop uses keyboard Enter; phone exercises touch; light cases use reduced motion, dark normal motion. Screenshots inspected at every width/theme. Evidence: `/tmp/chat-loading/a-browser-results.json`, `a-browser-final.log`, `a-{catalog,chat}-{1360,390}-{light,dark}.png`.
- Browser harness corrections: `data-base` is the theme mode (`data-theme` is the preset ID), and phone navigation must finish closing its sheet before reopening it. The rejected runs were harness errors, not successful matrix evidence.

Reproduce with `/tmp/chat-loading/catalog-browser.mjs` and `/tmp/chat-loading/catalog.mjs` through the allowlisted wrapper. The latter temporarily parks only its own synthetic controls, measures the exact-150 catalog, then restores them in `finally`. Raw route samples: `/tmp/chat-loading/a-catalog-results.json`. Remaining acceptance: B–E and their long-history/live/find/scroll/switch browser proofs.
