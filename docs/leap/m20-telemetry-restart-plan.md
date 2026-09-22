# M20-T3 — restart-safe child spend correction plan

Status: revised after review; implementation intentionally blocked on brief approval.

Base investigated: `917f5840db4e28973acf4853914b0059f5c506d0`.
Plan revisions: correct concurrent route semantics, make partial coverage visible, define streaming propagation, and state registry retention honestly.

## Finding

A live whole-session telemetry read has two authorities today:

1. `packages/host/src/router.ts` routes `pi/session/telemetry` to the open worker with `routeLive()` and uses `SessionTelemetryReader` only when no worker owns the session.
2. `packages/worker/src/server.ts` folds the open parent and asks `ChildTelemetryCache.sources()` for descendants.
3. `ChildTelemetryCache` receives membership from `this.harness.runs()`. That collection is process-local and rebuilt only from work observed by that worker generation.
4. On a worker restart/reopen, the parent transcript is reopened but historical child-run membership is not. The worker therefore returns only the parent's spend plus children observed after restart.
5. The cold path does not have this defect: `SessionTelemetryReader` receives the host `AgentRunRegistry`, calls `runsBeneathSession()`, deduplicates by child `sessionPath`, and folds registry-known durable child files.

Existing router tests call worker and host helpers with the same manually supplied run list. They do not exercise the production host-to-successor-worker seam, so both helpers agree while production live routing loses membership.

This is an authority defect, not a display or arithmetic defect. The host registry is the canonical authority for **registry-known** durable child membership. Worker memory is only a current-generation live overlay.

## Existing limits and non-goals

The host registry is not an all-time ledger:

- terminal rows expire after 30 days by default;
- at most 500 terminal rows are retained per project by default;
- live rows are retained in addition to those terminal rows;
- pruning a run can remove the only membership record for a child session.

Therefore this repair guarantees exact totals for the registry-known set represented by a response. It does not reconstruct pruned ancestry and must not claim lifetime completeness. Spend may decrease after registry pruning, session deletion, or loss of an unreadable child. Changing retention, adding a second accounting ledger, or increasing either existing cap is out of scope.

Other retained constraints:

- Public callers continue to send the unchanged `pi/session/telemetry` params.
- No global registry broadcast, UI max workaround, polling loop, or worker read of `agent-runs.json`.
- No transcript writer is added. Host indexing is read-only and incremental after first fold.
- Descendant/root filtering continues to use `runsBeneathSession()`; a child query excludes siblings.
- Duplicate runs sharing one child `sessionPath` contribute once.
- Account-provider usage affects billing but never enters API totals. Missing usage/pricing is never estimated.
- Turn scope remains parent-turn-only and never requests child sources.
- Parent `revision`, `environmentKey`, scope, and turn refusals remain unchanged.

## Corrected authority and transport

### 1. Compact source snapshot

Add an internal spend-only snapshot:

```ts
interface TelemetryChildSpendSnapshot {
  scopeSessionPath: string;
  generation: number;
  sources: TelemetryChildSpendSource[];
  coverage: {
    knownChildren: number;
    includedChildren: number;
    unavailableChildren: number;
  };
}
```

An available source contains child `sessionPath`, optional recorded model, billing flags, all/API totals, and all/API per-model lines. An unavailable source carries no invented fold. `includedChildren + unavailableChildren === knownChildren`; all counts are distinct child session paths, not run rows.

`knownChildren` means “distinct descendants still known to `AgentRunRegistry` for this scoped session,” not “every child ever created.” That name and protocol documentation prevent retention pruning from being presented as complete historical coverage.

Do not transport `TelemetryFoldState`: records, timestamps, tools, child counts, token series, and cost series are irrelevant to child spend.

Independent transport/read budgets are explicit constants, separate from registry retention:

- at most 512 serialized child sources per snapshot;
- at most 128 model lines per available child source;
- at most 2 MiB encoded snapshot payload, below the transport frame ceiling.

The host first deduplicates registry rows by `sessionPath`, prioritizing live descendants and then newest terminal descendants. It reads at most 512 child indexes. It continues the in-memory membership pass to count distinct omitted descendants, but performs no file reads for them. A child over the model-line or remaining byte budget and every source-count overflow child increments `unavailableChildren`; none silently disappears from coverage. Totals and attribution are never truncated or coalesced into a misleading exact result.

### 2. Request-scoped live read, not a shared pre-sync

`SessionRouteLeases` are readers-writer leases: routed requests are concurrent readers. They do **not** serialize two telemetry reads. The implementation must not make route readers exclusive.

Use one host-to-worker-only request (working name `pi/session/telemetry/with-sources`) carrying the unchanged public params plus one complete source snapshot. The worker validates the parent fence and computes that response directly from the payload attached to that request. It does not read a mutable shared baseline to answer the paired request.

Consequences:

- overlapping public reads may carry different snapshots and each consumes its own intended snapshot;
- a later cache update cannot change an earlier in-flight response;
- there is no separate “sync then read” interleaving window;
- public telemetry params and response authority remain unchanged.

Each host source-build operation reserves a per-`scopeSessionPath` monotonically increasing `generation` **before** asynchronous index work. The worker may also install the payload into its streaming cache, but only when `generation` is greater than the cached generation. If generation 2 finishes before generation 1, response 1 still uses its request payload and the shared cache remains generation 2; generation 1 cannot overwrite it.

One router helper performs the internal request. Both production live paths use it:

1. the ordinary `routeLive()` fast path;
2. the final `route()` fallback that starts/routes a worker when the durable reader returns `route-live`.

There is no direct worker telemetry request that bypasses bootstrap. Cold durable answers continue to avoid starting a worker.

### 3. Boundary validation and cheap refusals

The internal method exists only on the host-worker pipe. The normal router explicitly rejects it from local and paired clients; it receives no public capability/method-policy grant. Schemas are strict and enforce count/line/byte-safe shapes.

The host derives `scopeSessionPath` from the already authorized public request, calls `assertDurableReadPath`, resolves its project/root through host-owned catalog/registry data, and accepts child paths only from `runsBeneathSession(scopeSessionPath, registry.list(scopeSessionPath))`. No worker-supplied path can select a root, and the worker never opens a source path from the payload.

Avoid expensive descendant scans for requests already known to fail:

- reject a foreign `environmentKey` at the host before source construction;
- durable reads keep their existing parent revision check before child construction;
- a live request carrying `revision` first uses a lightweight worker fence preflight, then builds sources only when the worker accepts that parent fence;
- turn scope or an include list without spend bypasses child construction entirely.

The combined worker request revalidates the fence against the exact parent snapshot used for the response, so the preflight is only an optimization, never authority.

## Streaming cache, invalidation, and publication

The request payload fixes direct reads. A separate cache supports the existing no-polling contract for telemetry embedded in `session/update`.

### Cache ownership and freshness

For each open scoped parent, worker state is one of:

- `uninitialized`: no host-canonical snapshot has arrived in this worker generation;
- `fresh(generation, baseline)`: safe to merge into streaming updates;
- `dirty(generation)`: the host has observed a descendant change but has not supplied the replacement snapshot yet.

Rules:

1. Session-scope telemetry is never attached to an update while the baseline is `uninitialized` or `dirty`. In particular, a successor worker cannot emit a complete-looking parent-only value before bootstrap.
2. A newer host generation atomically replaces the whole canonical baseline. Older generations are ignored.
3. A local overlay is eligible only while the child has a current runtime **and** a nonterminal local run. It is keyed by `sessionPath` and replaces the same canonical source.
4. A newly active local child absent from the last baseline is added once.
5. Settled/closed/disappeared child folds never override a newer baseline. Applying a newer generation drops terminal/non-live overlays; removing a canonical path removes its stale spend.
6. Reopen/non-prefix history resets the existing incremental live fold. Rekey moves matching baseline and overlay keys; closing the scoped session drops them.

This prevents a retained live fold from indefinitely masking host truth after deletion, pruning, or a later unreadable snapshot.

### Host propagation

Add a host telemetry-source coordinator shared by the router and `HostServer.observe()`.

A relevant descendant signal is:

- `agents/run` registration/status/rekey affecting membership;
- a persisted telemetry update kind (`message_end`, `tool_execution_end`, `compaction_end`, `agent_settled`, `state`, or `entry_appended`);
- successful `session/load`/reopen of a registry-known child, which discovers an inactive-file append;
- child close/move/delete lifecycle that can remove or rekey a source.

For such a signal the coordinator:

1. resolves every affected registry-known ancestor scope, including the tree root, on the host;
2. reserves a generation and marks each affected scope dirty in both the coordinator and its current owning worker immediately;
3. marks the host child index dirty when the signal can rewrite rather than append;
4. coalesces repeated signals per scope, then rebuilds one bounded snapshot through `SessionIndexCache`;
5. sends an internal `apply-and-publish` request to the worker currently owning that ancestor scope, even when the child notification came from another worker;
6. the ancestor worker applies only a newer generation and, if that session previously served telemetry, emits one numbered/replayable `session/update` using the existing `state` update shape plus corrected telemetry.

`HostServer.observe()` runs before broadcast. While a scope is dirty, it strips stale embedded telemetry from that scope's ordinary updates; transcript updates still broadcast normally. The corrected synthetic `state` update comes from the ancestor's worker, so it owns `seq`, `epoch`, replay buffering, parent revision, and environment fence. The host does not invent a session sequence.

The internal result acknowledges the worker's current/applied generation and whether publication occurred. The coordinator clears dirty state only after an acknowledgement at least as new as its latest dirty generation. A concurrent public combined read that supersedes a dirty generation is sent with `publishIfWanted`; it both answers its caller and publishes the same accepted snapshot to existing listeners. Thus a stale coalesced refresh rejected behind a newer public read cannot leave the scope dirty or leave other listeners on the old subtotal.

No text/thinking/tool-call delta causes file I/O. Relevant persisted signals are coalesced, and `SessionIndexCache` extends an append from its previous offset. Cross-worker descendants converge through the host coordinator and each ancestor scope's current owning worker. If an affected scope is cold or nobody has requested telemetry, the host records dirtiness but does not start a worker; the next durable/public read computes current data.

An out-of-process edit to an inactive child has no app event and cannot be pushed without a file watcher. It is discovered on child reopen or the next explicit telemetry read. This is the honest limit; no polling or new global session watcher is introduced.

## Partial coverage is a required visible state

Add `TelemetrySpend.coverage` with the three registry-known counts above. It is present on session-scope spend responses, including zero known children. It is absent from turn-scope responses. Older/mixed-version absence remains treated as complete for compatibility.

`unavailableChildren > 0` means every displayed API number is a known subtotal, not a total. The UI changes in this milestone are limited to:

- `packages/ui/src/components/telemetry/spend-section.tsx`;
- `packages/ui/src/components/telemetry/format.ts`;
- `packages/ui/src/components/telemetry/section.tsx` only if the existing note primitive cannot express the state;
- telemetry-specific tests.

Required copy behavior:

- known API cost above zero: collapsed header is `“$N · partial”`; expanded content includes `“Known API subtotal · N child session(s) unavailable.”` beside the existing meter;
- zero/absent known API with unavailable children: collapsed header is `“Partial”` or `“Account · partial”` when known account billing exists; expanded content says `“API cost is incomplete · N child session(s) unavailable.”`, never `“No API cost”`;
- known account allowance remains separate and continues to render when billing is `account` or `mixed`;
- no child path, model error, provider payload, or private reason appears in copy.

Complete coverage keeps today's compact “None”, “Account”, and no-API states.

## Production call flow

### Public whole-session spend read

1. Router authorizes/path-validates and performs cheap environment/fence preflight.
2. Host coordinator reserves generation and builds one scoped canonical snapshot.
3. Router sends `pi/session/telemetry/with-sources` to the selected worker, on both standard and fallback-live routes.
4. Worker folds the exact parent snapshot, merges request-scoped canonical sources with eligible current live overlays by child path, returns the public result, and conditionally advances its streaming cache.
5. Concurrent requests remain independent; shared cache generation is monotonic.

### Durable read

`SessionTelemetryReader` uses the same source builder and coverage accounting directly. Live and durable routes therefore share membership, deduplication, budgets, overflow, and missing-child semantics.

### Restart/reopen

A successor starts `uninitialized`. Parent updates before bootstrap carry no telemetry. The first public spend read or host descendant refresh supplies a host snapshot. Only then may streaming parent updates contain spend. The new process never relies on predecessor harness history.

## Behavioral regression design

### Real host ↔ worker restart test (red first)

Add a built-worker host e2e test following `worker-oom.e2e.test.ts`, using isolated temporary directories, `HostServer`, the real `WorkerClient` process, JSON-RPC, `session/load`, and `pi/worker/restart`. Assertions must traverse production routing rather than call telemetry helpers.

Fixture graph:

- parent with `openai-codex` account-provider usage;
- API-billed child;
- different API-billed grandchild;
- duplicate run row naming the child session;
- sibling and unrelated root with conspicuously large cost.

Assert exact tokens/costs:

1. cold durable parent includes child + grandchild once, excludes sibling/unrelated root, reports mixed billing, and keeps account cost out of API totals;
2. real live parent equals durable;
3. after `pi/worker/restart` and reopen, a pre-bootstrap parent update has no telemetry rather than parent-only “complete” spend;
4. first post-restart live read equals durable in totals, billing, and coverage;
5. child-root read includes grandchild but excludes parent/sibling/unrelated root;
6. append to an inactive child, reopen it, and observe a corrected parent telemetry notification without polling;
7. a live child replaces its durable source; before and after durable registry catch-up it appears exactly once;
8. deletion/unreadability removes stale cost and reports visible incomplete coverage.

Current code is red at assertion 2/4 because the live worker lacks durable descendant membership.

### Race and focused tests

- **Concurrent reads:** gate generation 1's source build, complete generation 2, then release generation 1. Each response uses its attached snapshot; cache remains generation 2; no stale overwrite.
- **Dirty streaming:** descendant persisted event strips old parent telemetry, coalesced refresh applies a newer generation, and one numbered parent state update carries corrected totals.
- **Cross-worker:** child notification from worker A refreshes parent listener in worker B without starting either cold worker.
- **Pre-bootstrap:** successor parent updates omit telemetry until a canonical snapshot arrives.
- **Freshness:** terminal/closed live folds cannot mask a newer missing/unavailable/pruned baseline.
- **Append/reopen:** historical child index extends once; live replacement is not added to durable baseline.
- **Bounds:** more than 512 known paths, a >128-model child, and byte-budget exhaustion preserve known count and increase unavailable count without reading/serializing overflow.
- **Parser/access:** malformed internal payload rejected; normal and paired clients cannot call it; payload paths never cause worker filesystem reads.
- **Fences:** foreign environment and stale revision refuse before child scan where feasible; combined request rechecks; turn scope unchanged.
- **UI behavior:** complete zero remains “No API cost”; incomplete zero never does; nonzero subtotal says partial in collapsed and expanded states; account allowance remains separate; singular/plural copy contains no paths.
- **Driver seam:** stable and chord drivers compile; no driver interface change.

Tests assert behavior and process boundaries, not source strings or CSS classes.

## Permitted implementation paths after approval

- protocol telemetry, request/message/schema/method-policy definitions and telemetry tests;
- host telemetry reader/coordinator, router/server integration, and directly related unit/e2e tests;
- worker telemetry/server cache and internal request handling, plus directly related tests;
- only the UI telemetry projection files and telemetry-specific tests listed above;
- this plan for an evidence appendix.

Not permitted: ledgers, `todo.md`, release metadata, project-work entity/Markdown files, private/live stores, network data, unrelated refactors, retention/cap increases, or a second historical accounting system.

## Implementation order after approval

1. Add/run the real restart red test and overlapping-read/pre-bootstrap red tests.
2. Add compact snapshot/coverage protocol contracts and strict parser/access tests.
3. Factor the host source builder with explicit budgets and shared durable behavior.
4. Add request-scoped combined routing on both live paths and generation race handling.
5. Add coordinator invalidation/publication and worker fresh/dirty/live-overlay rules.
6. Add required partial UI projection and behavioral tests.
7. Run focused protocol, host, worker, and UI tests plus affected package builds. The parent owns `pnpm verify` and the release gate.
8. Inspect the diff for prohibited paths and report the exact revision/results.

## Investigation evidence

Before the first plan revision, base `917f5840` passed:

- `pnpm -r build` (existing Vite warnings only);
- host telemetry tests: 8/8;
- worker telemetry tests: 7/7;
- protocol telemetry/schema tests: 54/54, no type errors.

Those helper tests establish current arithmetic only. They do not cover real restart membership, concurrent reader interleaving, pre-bootstrap notifications, or partial UI behavior.
