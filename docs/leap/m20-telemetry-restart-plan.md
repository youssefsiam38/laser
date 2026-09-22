# M20-T3 — restart-safe child spend correction plan

Status: investigation complete; implementation intentionally blocked on parent approval.

Base investigated: `917f5840db4e28973acf4853914b0059f5c506d0`.

## Finding

A live whole-session telemetry read has two authorities today:

1. `packages/host/src/router.ts` routes `pi/session/telemetry` to the open worker with `routeLive()` and uses `SessionTelemetryReader` only when no worker owns the session.
2. `packages/worker/src/server.ts` folds the open parent and asks `ChildTelemetryCache.sources()` for descendants.
3. `ChildTelemetryCache` receives membership from `this.harness.runs()`. That collection is process-local, is capped at `MAX_RETAINED_RUNS = 500`, and is rebuilt only from work observed by that worker generation.
4. On a worker restart/reopen, the parent transcript is reopened but historical child-run membership is not. The worker therefore returns only the parent's spend (plus any children created after restart).
5. The cold path does not have this defect: `SessionTelemetryReader` receives the host `AgentRunRegistry`, calls `runsBeneathSession()`, deduplicates by child `sessionPath`, and folds those durable child files.

The existing router tests do not exercise this seam. They call worker-side and host-side helpers with the same manually supplied run list, so both implementations agree while production live routing loses the list.

This is an authority defect, not a display or arithmetic defect. The host registry is the durable authority for child membership. Worker process memory may be a live overlay, but must not become durable membership authority.

## Constraints retained

- The public read remains `pi/session/telemetry`; no UI-selected max, polling workaround, or larger harness cap.
- The host never broadcasts the global run registry. A sync is limited to descendants of the one requested root and to spend-only fields.
- The worker does not import host code and never reads `agent-runs.json` directly.
- Transcript files remain single-writer. Telemetry performs read-only indexed reads; no new session or registry writer is introduced.
- Parent/child/grandchild selection continues to use `runsBeneathSession()` and the current root/parent rules. A child query still excludes its siblings.
- Multiple run records that name one child session contribute that child once.
- Account-provider usage remains in all-usage accounting and billing detection but never enters API totals. No missing usage or price is estimated.
- Turn-scoped telemetry remains parent-turn-only. Child sources are consulted only for session-scoped reads whose requested sections include spend.
- Existing `revision` and `environmentKey` checks happen against the same parent snapshot, with the same errors. Child spend does not weaken or replace either fence.
- All source reads are project/root scoped, registry bounded, incremental after the first fold, and subject to existing protocol frame limits.

## Correction

### 1. Canonical, bounded source shape

Add an internal protocol value representing only the data `mergeChild()` consumes:

- child `sessionPath` (deduplication key);
- optional recorded `provider/id` model;
- billing flags;
- all-usage totals and API-only totals;
- all-usage and API-only per-model lines;
- availability: `available`, `missing`, or `unreadable`.

Do not transport `TelemetryFoldState`: its record counts, timestamps, tool maps, child counts, token series, and cost series are irrelevant to child spend and make the bridge unnecessarily large. The internal schema caps source count to the host registry's existing retained-run bound, caps per-source model lines at a named constant, and rejects duplicate or malformed paths. Host construction deduplicates before serialization. If an exceptional child exceeds the model-line/encoded-byte budget, send it as unavailable and expose the coverage gap; never truncate totals, silently coalesce attribution, or exceed the worker frame limit.

Expose one host-to-worker-only request (working name `pi/session/telemetry/sources`) carrying `{ rootSessionPath, sources }`. The host router must reject this method from normal clients, as it already does for `pi/session/close`. It is not a relay/UI capability and does not alter public request parameters.

### 2. Host-owned durable baseline

Factor the existing `SessionTelemetryReader` child loop into a root-scoped source builder:

1. call the host registry's scoped `list(rootSessionPath)`;
2. apply `runsBeneathSession(rootSessionPath, runs)` exactly once;
3. deduplicate by child `sessionPath`;
4. read each child through the existing `SessionIndexCache` and project only the spend fields above;
5. emit an unavailable source when a canonical child is missing, deleted, malformed, or unreadable—never retain or invent its previous value.

The durable response path consumes this same builder, so durable and live routes cannot acquire different membership rules.

For an open session and only when session-scope spend is requested, the host's existing `routeLive()` callback first sends that root's source snapshot to the already-open worker, then sends the unchanged public telemetry request. This preserves the important `routeLive()` behavior: a cold telemetry read does not start a worker merely to synchronize sources. The route lease orders source replacement before the corresponding telemetry reply.

### 3. Worker live overlay

Replace worker disk-backed child authority with a union keyed by child `sessionPath`:

- **baseline:** the latest host snapshot for the queried root;
- **overlay:** descendant runs known to this worker generation, folded from `entriesNow()` when live and from the existing incremental local fold when a just-settled runtime is retained.

For each path, an available live fold replaces—not adds to—the durable baseline. A newly started local child absent from the last host snapshot is added once. Two active/terminal run records for the same path still produce one child source. When the next host snapshot includes that child, the path key turns replacement into a no-op rather than a double charge.

A process restart naturally drops all baseline and live caches; the first post-reopen telemetry request primes the new generation before reading it. A root/session rekey moves the matching baseline and live-fold keys through the existing `rekey()` lifecycle. Closing a root drops its baseline. Replacing a host snapshot removes canonical paths no longer present instead of preserving stale spend.

### 4. Cache invalidation and lifecycle

| Event | Required behavior |
| --- | --- |
| Parent first opens | No eager global scan. First session-spend read receives the host baseline. |
| Child transcript append | `SessionIndexCache` detects identity/size change and extends its fold; the next root-spend read replaces the worker baseline. |
| Child opens/reopens live | Current runtime entries replace that child's baseline at the same path key. Non-prefix history uses the existing fold reset behavior. |
| Child settles | Retained local fold remains the overlay until the next authoritative host snapshot contains the same path. |
| New child starts after baseline | Local descendant overlay adds it once before the host snapshot catches up. |
| Duplicate run row | Host and worker both deduplicate by child session path. |
| Child is deleted/unreadable | Host marks it unavailable, removes any stale durable fold, and reports incomplete coverage. A genuinely live runtime may replace that unavailable source for that response. |
| Parent or child rekeys/forks | Apply current run-registry relation/rekey rules; move cache keys, do not infer ancestry from filenames. |
| Worker restart/crash/manual restart | All process-local snapshots vanish. The host registry and indexed files reconstruct the next request exactly. |
| Root closes | Drop its source snapshot; no cross-root cache reuse. |

Streaming updates continue using incremental in-process folds. There is no transcript reread on each update and no polling loop. A fresh canonical baseline is requested at the public telemetry read boundary; live child entries cover changes between those boundaries.

### 5. Truthful partial data

Add an additive `TelemetrySpend.coverage` value:

```ts
{ children: number; included: number; unavailable: number }
```

It reports canonical distinct child sessions, how many contributed a fold, and how many could not be read. A live overlay that supplies an otherwise unavailable child counts as included for that response. No child paths or private error text leave the host/worker boundary.

Without this field, a deleted or unreadable child is indistinguishable from a real zero and the UI can present a false exact total. The backend milestone will populate and schema-test the field. A person-facing “partial” projection, if desired for the current telemetry surface, must be assigned separately to the UI owner; this task will not edit project-work UI files.

**Approval point:** approve this additive coverage contract. If public shape must remain byte-for-byte unchanged, the only truthful alternative is to refuse the entire spend section whenever any canonical child is unavailable; silently returning the known subtotal is not acceptable.

## Concurrency and fences

- Source sync and the paired live telemetry request execute in one existing per-session route lease. A reply cannot observe a later request's baseline before its own baseline is installed.
- The sync replaces one root snapshot atomically (build a new map, then swap); it never mutates entries while telemetry is folding.
- Worker process generation is the lifetime boundary. Old-generation requests already fail through the current worker-client generation handling; snapshots are never copied to a successor.
- Parent `revision` and `environmentKey` validation remains in `WorkerServer` before projection. Turn validation remains unchanged and never merges children.
- The parent fence remains based on the indexed parent snapshot exactly as today. The source builder uses each child index's coherent snapshot; unavailable/change-during-read children become coverage gaps rather than stale values.
- Run registration precedes host notifications in the existing lifecycle. A local active child can still appear before that durable registration through the live overlay; session-path replacement prevents later duplication.

## Red regression design

### Real host ↔ worker restart test (required red first)

Add a built-worker host e2e test, following `worker-oom.e2e.test.ts`, with isolated temporary `agent`, `sessions`, `state`, and project directories. It must use `HostServer`, its real `WorkerClient` child process, JSON-RPC routing, `session/load`, and `pi/worker/restart`; it must not call telemetry helpers as the assertion path.

Fixture graph:

- parent: account-provider (`openai-codex`) usage/cost;
- child: API-provider usage/cost;
- grandchild: different API-provider usage/cost;
- second run row naming the same child session;
- unrelated root and child with a conspicuously large API cost.

Assertions, using exact token and cost literals from the fixture:

1. cold durable parent telemetry includes child + grandchild once, excludes unrelated root, reports `billing: "mixed"`, and API totals include only child/grandchild;
2. load parent into the real worker; live telemetry equals those durable spend totals;
3. call `pi/worker/restart`, wait for the same parent path to reopen in the successor, then query again; authority is live and every billing/API/coverage value remains exact;
4. query the child root and prove its spend includes the grandchild but not parent, sibling, or unrelated root;
5. append one API-billed entry to the inactive child file, query again, and prove only that exact delta appears;
6. reopen the child runtime, query the parent, and prove the durable baseline plus live child is replacement, not addition;
7. add a newly active child after the baseline and prove it appears once before and once after the host registry snapshot catches up;
8. delete or make one canonical child unreadable and prove stale cost disappears while coverage becomes incomplete.

On current code, assertion 2 is red immediately: the new worker has no harness run rows, so live parent spend omits both descendants. Assertions 3 and 5 also expose restart and stale worker-file-cache behavior.

### Focused tests

- **Protocol:** internal source schema bounds/strictness; malformed/duplicate inputs; `TelemetrySpend.coverage` response parsing; unchanged public telemetry params.
- **Host reader:** parent/child/grandchild filtering, duplicate run rows, unrelated roots, rekey/fork relations, missing/deleted/unreadable child, append identity invalidation, and exact API/account split.
- **Host router:** sync occurs before an open worker telemetry request; no sync/no worker start for a cold durable read, turn scope, or an include list without spend; clients cannot call the internal method.
- **Worker:** baseline-only after restart; live path replaces baseline; newly active path adds once; duplicate active runs deduplicate; snapshot replacement prunes old paths; rekey and close clear/move state; turn scope and revision/environment refusals are unchanged.
- **Seam:** stable and chord driver compilation remains covered by the normal worker gate; no driver interface change is planned.

Tests assert returned behavior and process boundaries, not class names, source strings, or UI markup.

## Permitted implementation paths after approval

- `packages/protocol/src/telemetry.ts`, request/message/schema/method-policy files needed for the internal request, and directly related protocol tests;
- `packages/host/src/session-telemetry.ts`, `packages/host/src/router.ts`, and directly related host tests/new telemetry restart e2e fixture;
- `packages/worker/src/telemetry.ts`, `packages/worker/src/server.ts`, and directly related worker tests;
- this plan, if implementation evidence needs a short appendix.

Not permitted: ledgers, `todo.md`, release metadata, project-work UI entity files, private stores, live/network data, unrelated refactors, a registry-cap increase, or global run broadcast.

## Implementation order after approval

1. Add and run the real restart e2e test; capture the expected current failure.
2. Add the compact protocol source and coverage contracts plus schema tests.
3. Factor host canonical source construction and use it in the durable reader.
4. Add host-to-worker scoped sync and router ordering/refusal tests.
5. Replace worker membership authority with baseline + live path overlay and lifecycle invalidation tests.
6. Re-run the real e2e test, focused package tests, `pnpm -r build`, then `pnpm verify`.
7. Inspect the diff for prohibited paths and report any person-run UI acceptance needed for the partial-data label.

## Investigation validation

The base was built before test execution.

- `pnpm -r build` — pass (existing Vite CSS/chunk warnings only).
- `env -i PATH="$PATH" HOME="$HOME" pnpm -F @lasercode/host exec vitest run test/session-telemetry.test.ts test/session-telemetry.router.test.ts` — 8/8 pass.
- `env -i PATH="$PATH" HOME="$HOME" pnpm -F @lasercode/worker exec vitest run test/telemetry.test.ts test/telemetry-dispatch.test.ts` — 7/7 pass.
- `pnpm -F @lasercode/protocol exec vitest run test/telemetry.test.ts test/schemas.test.ts` — 54/54 pass, no type errors.

These green tests establish the current helper behavior only; they do not invalidate the production restart finding because none starts a real host/worker pair with durable child membership.
