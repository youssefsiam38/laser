# L3 — Telemetry query

Branch: `agents/l3-telemetry-query-224529b5`
Base: `c61b7d2288869810dc75d53208c91f3bae9eec51`

## What was built

`pi/session/telemetry` computes the numbers the telemetry panel renders, over the **whole** session, on the authority that owns it:

- **Worker** when the session is live (engine entries, live context overlay, child runs this worker holds).
- **Host** when it is not (the session index fold, no worker started).

Both authorities use the same pure fold in `packages/protocol/src/telemetry.ts`. A section the caller did not ask for is absent. Numbers only: no entries, no bodies, no message text.

The UI no longer aggregates loaded entries for spend. `usageFromEntries`, `usageByModel`, `spendSeries`, `sessionBillingMode` and `backgroundUsageSources` are deleted. The panel requests the query once and then takes snapshots from the existing `session/update` channel (`telemetry` on `SessionUpdateParams`). It never polls.

## Decisions for the orchestrator to record

### D-n · History held-count is the client's

The result carries `history.records` (the session total). The client does **not** send how many records it currently holds. That number is already on the loaded page; the authority cannot verify it. The panel compares `rows.length` against `history.records` and, when they differ, says so **on that figure** (`N of M`).

### D-n · Files is not this method

`SessionTelemetry` defines nothing for changed files. They come from git (Part E / L2). An optional empty field would be a compatibility path; it is omitted.

### D-n · Context composition is live-only and currently omitted

Spec C.4: composition is computed from the live request the engine assembled, never guessed from the transcript. Pi's `ContextUsage` is `{ tokens, contextWindow, percent }` with no tools/chat/thinking/system breakdown. The `composition` field exists on the type and is left absent until the engine exposes one. Live fills tokens/window/percent/auto-compact from `getContextUsage()` + session state. Durable omits `context` (it cannot reconstruct the live window). Identity tests compare record-derived sections (`spend`, `work`, `history`, `model`).

### D-n · Child costs come from child session files, found via the run registry

`AgentRun` has no usage (D-140). The registry is how we **find** child sessions by root; the fold of each child's JSONL supplies tokens and cost. A child with a model but no readable file still flips billing mode and adds no invented numbers. Child costs roll into `spend.byModel` and totals, not into the parent's per-turn sparkline.

### D-n · A pinned stale revision is refused; the current snapshot is unpinned

`environmentKey` mismatch → refuse. `revision` present and not current → `RevisionUnavailable`. The panel's first request omits both and always receives the current snapshot, stamped with the revision it was computed at. A reply is never numbers from a different state than the stamp.

### D-n · Streaming delivery is an optional field on `session/update`, not a new kind

`SessionUpdateParams.telemetry` carries a full snapshot (it is small: numbers only) on `message_end`, `tool_execution_end`, `compaction_end`, `agent_settled`, `state`, `entry_appended`. Text/thinking/tool-call deltas do not recompute. No second channel.

### D-n · `historyRows` stays as CheckpointHistory's view-model

It is a tree projection of the **loaded page** for fork/jump, not a session total. Deleting it would require editing `checkpoint-history.tsx` (outside this milestone's ownership). History **counts** come from the authority.

### D-n · Histogram bound

Top 8 named tool rows, then an `other` bucket of remaining **calls**. Failed tools: top 8 named.

## Validation

```
pnpm install --frozen-lockfile          # already up to date
pnpm -F @lasercode/protocol test        # 415 passed
pnpm -F @lasercode/worker test          # 1101 passed, 4 skipped
pnpm -F @lasercode/host test            # see below
pnpm -F @lasercode/ui test              # see below
pnpm -r typecheck                       # all 10 packages passed
pnpm identity:check                     # after git add of new files
```

`pnpm verify` was not run (orchestrator owns the integrated gate). No browser / Playwright / `scripts/browser-check`.

### Host suite

New tests passed in isolation and in the full run:

- `test/session-telemetry.test.ts` (4) — whole-session vs live fold identity, incrementality by counted pushes, stale/foreign fence, omitted sections
- `test/session-telemetry.router.test.ts` (3) — durable without spawning, live owner wins, stale refuse
- `test/session-index.test.ts` (18) — index still green with the telemetry fold in the scan
- `test/session-route-lease.test.ts` (25) — telemetry on the live-fast-path lease

The full `pnpm -F @lasercode/host test` also reported 61 failures, all `WorkerRpcError: The app could not verify the project runtime it started`, concentrated in fake-worker pool tests (`worker-pool`, `session-lifetime` WorkerPool cases, `worker-client.pressure`, etc.). Real-worker e2e (`host.e2e`, `session-unload.e2e`, `environment`, `pressure.e2e`) **passed**. Those spawn failures reproduce without this milestone's telemetry tests and look like fake-worker launch-identity, not the query. Rebuilding the worker did not change them.

### UI suite

`test:types` passed after adding `pi/session/telemetry` to the capabilities inventory. Shell tests (`model.test.ts`, `telemetry-history.test.ts`) passed. A full `vitest run` had 21 failures in three unrelated files (`request-dialog`, `output-fold`, `trim-interaction`); the same files passed when re-run focused (63/63). Treated as parallel-run flakiness, not this change.

## Acceptance criteria

| # | Criterion | Evidence |
| --- | --- | --- |
| 1 | Method end to end | types + zod + method-policy + router test + schema sample + implementation tests |
| 2 | Whole session, longer than a page, compacted ranges, child roll-up | protocol `telemetry.test.ts`; host 30-turn session (60 records) vs live fold |
| 3 | Live and durable identical | host test strips `authority` and deep-equals the rest |
| 4 | Incremental, counted work | host `onTelemetryPush`: 24 then 24 then +2; protocol `recordsFolded` |
| 5 | Fenced | stale revision and foreign environmentKey refused |
| 6 | Client aggregations deleted | `usageFromEntries` / `usageByModel` / `spendSeries` gone; callers updated |
| 7 | Blanket apology gone | `LoadedHistoryNotice` deleted; history says `N of M` on that figure |
| 8 | Suites above; no browser | as listed |

## Left for later milestones

- Visual rebuild of the telemetry column (L4): scope bar, section layout, Work section as specified, Files from git.
- `composition` tokens once the engine exposes a live-request breakdown.
- `historyRows` remaining as CheckpointHistory's loaded-page tree (L4 may replace the list).
- `useSessionFileChanges` / Files section untouched (Part E / L2).
