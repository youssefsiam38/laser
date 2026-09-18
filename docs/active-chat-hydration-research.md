# Hydration research: conversation continuity first

Status: researched recommendations for M16-T81/T82, not a claim that the proposed cache extensions are implemented. Parent-owned research; implementation stays with the history/image area owner. D-295 controls priority: active conversation continuity outranks ordinary cache targets.

## Recommendation

Use **progressive, identity-verified hydration with three storage tiers**:

```text
Retained logical timeline: stable identities, order, loaded ranges, reading position
                                │
           visible/requested content first; nearby content next
                                │
               RAM → permitted desktop disk cache → host
                                │
            decode/render the needed content; preserve its geometry
```

The logical conversation is not the DOM, the decoded-image pool, or the raw-body cache. Releasing an offscreen bitmap must not remove its message or make the image permanently unavailable. Releasing a background cache must not replace the reader's history with the latest tail.

There is no demonstrated universally best hydration library. The best fit here combines proven techniques, existing safeguards, and measured user journeys. A new storage engine alone would not fix the current ownership/admission defects.

## What the current code already provides

| Foundation | Existing code | Consequence |
| --- | --- | --- |
| Durable source history | Host session JSONL and body-range serving | The reported history was not deleted from disk. Fixing the view is necessary even without a new cache. |
| Desktop persistence | `packages/ui/src/runtime/tail-cache/` | IndexedDB already holds bounded conversation tails. Large images become references, not a complete image archive. |
| Storage privacy/lifecycle | `device-storage.ts`, tail-cache lifecycle/record/vault, desktop `keychain.ts` | Use opaque canonical identities, not filesystem paths or path-derived disk keys. OS-key encryption is supported; unavailable keychains have an explicitly disclosed unencrypted fallback. Do not claim universal encryption or silently weaken policy. |
| Incremental rendering/anchoring | `transcript-viewport.tsx`, `messages.tsx`, geometric follow controller | Custom windowing and `content-visibility` already exist. Improve their contracts; do not replace them merely because a newer library exposes similar features. |
| Verified image/body reads | `image-blobs.ts`, shared body reader/revision fence | Keep region-versus-whole digest semantics, environment/epoch fencing, and truthful accounting while fixing admission/retry/ownership. |

### Reproduced baseline

Before T81/T82, parent-owned browser tests sent synthetic images through the real composer and waited for the actual `agent_settled` event, body/history-read quiescence, and decoding. They scrolled the requested image into view and attempted opening it.

- One 768px PNG: displayed and opened after settlement and after reload.
- Twenty-five 768px PNGs: 343,681 total file bytes, 58,982,400 decoded-surface bytes. After settlement all 25 were unavailable; after reload 24 decoded and the requested last image remained disabled while visibly in the viewport.
- The 24-image admission ceiling explains the reload boundary. The all-unavailable settled phase still needs its own causal trace; it must not be attributed to that ceiling without evidence.
- Captions remained intact. Both isolated runs reported no surviving fixture processes.

Artifacts: `/tmp/parent-chat-single-image-uat/run-Rmit4r`, `/tmp/parent-chat-25-image-uat/run-gpUUzz`; scenario `/tmp/parent-chat-image-settled-uat.mjs`.

Follow-up on the unintegrated T81 candidate `8f003578`: the same 25-image scenario now displays 24 immediately after actual settlement; image 25 remains visibly disabled, and reload stays at 24. Artifact `/tmp/parent-images-with-active-retention/run-KVysVo`, no surviving fixture processes. A 24-image boundary control on the same candidate passes settlement, reload, and opening the requested image (`/tmp/parent-image-admission-control/run-PWskRR`); screenshots were visually inspected. This is measured improvement with the history/retention changes, not proof that a particular subchange alone caused it or that T81/T82 are fully accepted.

## Five techniques, in implementation order

### 1. Retain active logical history independently of cache eviction

Keep a session-owned logical timeline and its requested ranges while the person is reading. Component unmounting, bitmap release, or a soft per-view share must not erase that timeline. Cache collection should reclaim unowned/inactive data first. Large bodies can remain reconstructible references rather than forcing every byte into RAM.

Relay provides a useful precedent: retained query data is not garbage-collected while an owner retains it; release is an explicit lifetime transition. This is an ownership pattern to reuse, **not** a recommendation to introduce GraphQL or Relay into Laser.

For T81, bounded `beforeEntry` recovery must prepend without resetting the reader to a tail. Stale cursors and non-user live refresh need the same continuity rule. Paging to the first marker is insufficient if intermediate history becomes unreachable.

Source: [Relay — Presence of Data](https://relay.dev/docs/guided-tour/reusing-cached-data/presence-of-data/).

### 2. Use granular, verified disk records—not whole-app snapshots

Use the existing desktop cache boundaries first. If extending persistence to bodies/images, store independently addressable records, with verified immutable body identity, separate timeline metadata, and bounded asynchronous writes. Read authorized local bytes first when their identity matches; reconcile mutable session metadata without discarding the active reading window.

Do not key an immutable image only by the session's changing revision. Conversely, do not reuse bytes merely because an entry ID matches: preserve environment/authorization scope, component identity, and the existing region/whole digest distinction. Use opaque session IDs on disk; current tail-cache rules explicitly forbid session paths and path-derived identifiers in keys, records, or authenticated metadata.

This extension requires an explicit policy/schema decision: `environment-policy.ts` currently permits attachment `reference` or `none`, not arbitrary full-size image persistence. Desktop authorization does not automatically authorize persistence for every remote environment.

web.dev warns that persisting large nested state objects can cause substantial structured-cloning work. Store only changed records, keep foreground work small, and measure whether writes actually cause long tasks. Browser disk storage remains a cache: quota errors, eviction, corruption, or unavailable keys must not destroy the canonical transcript or break active reading.

Sources: [IndexedDB best practices](https://web.dev/articles/indexeddb-best-practices-app-state), [browser storage and eviction](https://web.dev/articles/storage-for-the-web).

### 3. Prioritize requested content; queue pressure instead of declaring failure

Use a small, cancellable work queue with explicit priorities:

1. The image/body the person explicitly opens, copies, or requests.
2. Content currently visible in the active conversation.
3. Nearby content in the current reading direction.
4. Background cache warming and persistence.

An offscreen mounted row is not necessarily visible. Use actual visibility/proximity signals and existing viewport ownership. Admit useful work before speculative work, coalesce identical verified reads, and release obsolete reservations/holders exactly once. A temporary admission refusal must remain recoverable as capacity or visibility changes.

IntersectionObserver margins can start nearby work before it enters the viewport. Start with conservative lookahead; adapt direction/distance only when traces justify it. Do not fetch or decode the entire history speculatively. A 25-image conversation does not require all offscreen originals to remain decoded simultaneously; every image must become viewable when requested.

Source: [MDN — IntersectionObserver rootMargin](https://developer.mozilla.org/en-US/docs/Web/API/IntersectionObserver/rootMargin).

### 4. Hydrate content without moving the reader

Keep stable message identities and a measured visual anchor across prepend, streaming growth, late image decode, disclosure, and session restoration. Preserve known geometry while bodies arrive. Follow output only when the person was already following the live edge.

TanStack's current chat guidance independently supports stable keys, measured rows, prepend anchoring, and follow-on-append only from the end. Laser does not currently depend on TanStack Virtual; its new API is not a drop-in migration plan. Keep one scroll authority rather than combining browser anchoring, a new virtualizer, and the existing geometric controller.

Existing `content-visibility` can reduce offscreen rendering cost while keeping DOM semantics. DOM windowing requires separate guarantees for selection, Find, focused controls, accessibility, and approvals; performance work cannot silently remove those paths.

Sources: [TanStack Virtual — Chat](https://tanstack.com/virtual/latest/docs/chat), [content-visibility](https://web.dev/articles/content-visibility).

### 5. Keep expensive hydration work off the interaction path

Measure parsing, decryption, storage writes, Markdown/render work, and image decoding separately. Move substantial parsing/decryption/storage work to a worker when its cost warrants the boundary; defer nonurgent writes. Feature-detect `scheduler.postTask` and preserve a fallback rather than assuming every phone browser implements it.

Treat an image as ready when decoding succeeds, not merely when a URL exists. `HTMLImageElement.decode()` supplies that readiness signal. Thumbnail-sized decoded representations and full-resolution-on-open are candidates for image-heavy sessions, but resizing APIs do not by themselves prove a lower peak allocation: measure actual native/renderer memory and release bitmap resources correctly.

Sources: [MDN — scheduler.postTask](https://developer.mozilla.org/en-US/docs/Web/API/Scheduler/postTask), [image decode](https://developer.mozilla.org/en-US/docs/Web/API/HTMLImageElement/decode), [createImageBitmap](https://developer.mozilla.org/en-US/docs/Web/API/Window/createImageBitmap).

## Storage choice: reuse first, benchmark alternatives

| Option | Fit here | Recommendation |
| --- | --- | --- |
| Existing IndexedDB | Transactional records/blobs, current lifecycle and key handling, multi-window use | First candidate for a scoped cache extension; retain content permissions and privacy. |
| OPFS | File-oriented binary workloads; synchronous access handles available in dedicated workers | Benchmark if large-body I/O is demonstrably a bottleneck; it is still origin/quota-bound and does not supply encryption. |
| SQLite WASM on OPFS | Rich local indexing/query workloads | Not justified solely to display cached images. VFS locking, worker and multi-window constraints add real complexity. |
| New native filesystem/database service | Potential control over disk layout and quotas | Only with a measured need and a separate reviewed ownership/security contract; do not create another transcript authority. |

SQLite documents performance/locking tradeoffs between its OPFS implementations; these are not proof that OPFS or SQLite will outperform this app's IndexedDB cache. Likewise, desktop disk is not automatically faster than an already-local host. Compare warm/cold reads, decoding and end-to-end paint, including a slow remote connection.

Sources: [MDN — OPFS](https://developer.mozilla.org/en-US/docs/Web/API/File_System_API/Origin_private_file_system), [SQLite — Persistent Storage Options](https://sqlite.org/wasm/doc/trunk/persistence.md).

## Acceptance decides whether this design succeeds

| User journey | Required observation |
| --- | --- |
| Read backwards while output and compaction continue | First, intermediate and recent markers remain reachable; no replacement by a recent tail, duplicates, lost focus/selection, or false completeness. |
| Send/open/revisit an image-heavy conversation | Captions survive; each requested image actually decodes and opens, including image 25 after scrolling; no permanent disabled cache-pressure placeholder. |
| Switch among busy sessions, reopen, and use warm/cold cache | Active reading stays stable; warm authorized bytes reduce redundant body transfers; background work cannot monopolize admission. |
| Simulate quota/eviction, corrupt cache, stale revision, disconnect and permission narrowing | Recover or explain the actual failure without deleting history, serving mismatched bytes, leaking data across environments, or silently persisting forbidden content. |
| Use pointer, keyboard and touch at both widths/themes | Correct focus, selection, Find, disclosure, viewer/zoom and reduced motion; measure interaction latency, long tasks, anchor delta and real decoded readiness. |

Record source/bundle hashes, wire requests, decoded image dimensions, screenshots and process teardown. Compare against a failing pre-fix control. Report p50/p95 open-to-readable and requested-image-to-decoded latency, warm-cache body transfers, and main-thread stalls; memory is a diagnostic and safety measure, not a substitute for passing these journeys. Performance targets are proposals until measured, not claims of present speed.

## Research provenance

Online research was checked against primary documentation, including seven pages fetched directly with HTTP 200. The local source manifest contains URLs and response SHA-256 hashes: `/tmp/laser-hydration-research/sources.json`. Relevant passages were read, not only search summaries. The findings above distinguish documented techniques, existing code, reproduced behavior, and proposed changes. They do not authorize a new dependency, storage engine, or broad cache rewrite without a bounded implementation plan.
