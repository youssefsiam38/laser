# M20-T3 — independent review of restart-safe descendant spend

Reviewed revision: `f2684685` (`agents/correct-spend-snapshot-bounds-5c2c07e9`), ancestry
`949dd49f` (original repair) + `9e4034e8`/`05153a85` (plan) + `f2684685` (parent-found
corrections) preserved intact. Code compared against `6e10aac8` (main). Ledgers, existing
entity UI and `STATUS*` checkpoint rows excluded from the reviewed delta, per scope.
One review cycle; findings below are for the parent's single triage batch.

## Verdict

**No blocking findings.** The corrected implementation matches the approved plan's
authority model, fences and bounds; the parent-identified holes (partial-baseline live
over-count, injected-cap bypass, delayed-ack membership regression, build-after-scope-loss,
settled-request mutation of recreated interest) are each closed by code and pinned by a
test. Recommend two non-blocking corrections (F1, F2) and record three accepted
limitations (L1–L3).

## What the delta does (verified against source)

- `packages/protocol`: compact `TelemetryChildSpendSnapshot`/`TelemetryChildSpendSource`
  (512 sources · 128 model lines · 2 MiB encoded envelope, `telemetry.ts:36-40`),
  additive `TelemetrySpend.coverage` with strict sum refinement
  (`schemas.ts:254-327`), three private host→worker methods with `reach: "native"`
  (`messages.ts:1687-1705`, `method-policy.ts:164-173`). Public
  `pi/session/telemetry` params and response authority unchanged.
- `packages/host`: one shared descendant source builder (`SessionTelemetryReader.childSnapshot`,
  `session-telemetry.ts:119-190`) used by both the durable read and live routing;
  a 255-line request-scoped coordinator (`session-telemetry-coordinator.ts`) that reserves
  a per-scope generation before the async build, marks dirty on persisted child/run
  signals, coalesces rebuilds (20 ms), fences apply by scope identity + accepted
  generation, and strips stale embedded telemetry from ordinary updates while dirty
  (`withoutStaleTelemetry`, `:100-117`). Router sends `with-sources` on both the
  `routeLive()` fast path and the durable fallback-to-live route (`router.ts:783-806`);
  rejects all three internal methods from every client (`router.ts:770-773`).
  `HostServer.observe()` fires `childChanged` only for persisted, non-synthetic child
  signals (`server.ts:1207-1212`) and strips the private marker at broadcast
  (`server.ts:783`).
- `packages/worker`: `ChildTelemetryCache` (`worker/src/telemetry.ts:93-330`) with
  uninitialized/fresh/dirty baselines, request-attached snapshots (the worker never reads
  the registry), conservative partial-membership rule (`:207-218`), budgeted live
  replacement/addition, pre-bootstrap and dirty suppression, and one numbered
  `state` republication through the existing `onDriverEvent` path
  (`server.ts:949-969`, `:3481-3498`).
- `packages/ui`: partial spend states in `format.ts`/`spend-section.tsx` only, via the
  existing `FigureNote` primitive; complete coverage keeps today's compact states.

## Review findings (non-blocking)

### F1 — trim's delete branch can double-count membership when a trimmed path is later re-encountered as live (latent; confirmed by experiment)

`worker/src/telemetry.ts:295-311` (`trimSnapshotToBytes`) demotes contributed sources to
unavailable and then **deletes** entries once none contribute, without removing those
paths from any seen-set. The live-overlay loop (`:212-218`) treats a live run whose
canonical entry was deleted as a *new* path while
`serializedMembershipComplete` (computed once, `:207`) is still true — so that child is
counted again in `knownChildren`/`unavailableChildren` and its serialized membership is
lost. Reproduced with a scratch probe against the built worker: complete-membership
baseline of 6 spend sources, injected `bytes` limit below the all-unavailable envelope,
two live runs (one new path, one canonical) → resolved coverage `{ knownChildren: 8,
unavailableChildren: 8 }` where the truth is 7 distinct children.

Reachability with production constants: effectively none. A 512-source all-unavailable
envelope is ≈15 KB, so with the 2 MiB limit the delete branch never fires and the
demotion-only path keeps every path in `sources` (demoted paths are still `canonical`,
so their live fold fills once, correctly — covered by
`worker/test/telemetry.test.ts:249`). It is reachable only through the injected test
limits, which are exactly the configurations the bounds tests use. Minimal fix
direction: collect paths removed by the delete branch into a set and skip them in the
loop (`if (!canonical && trimmedPaths.has(path)) continue;`), or drop the delete branch
altogether — deletion frees ~30 B/entry and cannot help once every source is
unavailable. Not a production defect today; fix opportunistically.

### F2 — test-only legacy fold transport remains in the protocol

`protocol/src/telemetry.ts:177` (`TelemetryChildSource`), `:645` (`mergeChild`) and the
`children?: readonly TelemetryChildSource[]` option of `sessionTelemetryOf` (`:688`,
`:694`) have no production callers left: host and worker both use `childSpend` +
`coverage`. The plan explicitly forbids transporting `TelemetryFoldState`; this dead
surface (full fold in, full fold merged) survives only because
`protocol/test/telemetry.test.ts:164-180` still exercises the old shape. Recommend
repointing that test to `childSpend` and deleting the legacy path in the next batch —
it keeps two parallel merge semantics in the authority's core file for no behavior.

### F3 — byte budget is re-serialized O(n²) per build (bounded; note only)

`host/src/session-telemetry.ts:158` encodes the whole growing candidate envelope per
child (up to 512 × ≤2 MiB ≈ hundreds of MB of `JSON.stringify` churn in the worst
reachable case per snapshot build); `worker/src/telemetry.ts` repeats the pattern per
live addition (`:262`, `:287`) and therefore per streaming update through
`streaming()`. Typical snapshots are small, so this is an efficiency note, not a
correctness one; incremental size accounting (or an upper-bound estimate that only
falls back to exact encode near the limit) would remove the worst case.

### F4 — plan wording vs implementation on the method-policy grant (documentation drift)

The plan says the internal methods "receive no public capability/method-policy grant",
but the diff registers all three in `METHOD_POLICY` with `reach: "native"` and updates
the four policy inventories (`method-policy.ts:164-173`, `environment-policy.test.ts`,
`host/test/access.test.ts:310-312`, `ui/test/runtime/environment-capabilities.test.ts`).
Behavior is safe — `reach: "native"` is unreachable by local and paired clients and the
router rejects the methods outright before access evaluation, both pinned by tests
(`session-telemetry.router.test.ts:165`). Record the deviation in the plan's evidence
appendix (or reword the plan sentence) so the inventories don't read as a grant.

### F5 — cross-worker refresh is structurally covered but not directly tested

The plan's behavioral design lists "child notification from worker A refreshes parent
listener in worker B without starting either cold worker". The coordinator tests use a
single owner stub; owner *replacement* is covered (`coordinator.test.ts` "abandons a
delayed public build…" and "…tears them down on rekey and worker loss"), but no test
routes one invalidate/refresh to a *different* live `WorkerClient` while a third is
irrelevant. Production parent/child usually share one worker (one worker per project
directory), so exposure is low; the `owner(path)` lookup seam (`coordinator.ts:132-142`)
is the only path relying on it untested.

### F6 — the private `telemetryGeneration` marker can reach a client via replay

`worker/src/server.ts:3489,3494` pushes params carrying `telemetryGeneration` into the
replay buffer before notify; the host strips the marker only on the live broadcast path
(`server.ts:783`). A reconnecting client replaying buffered updates therefore sees the
internal number. Harmless (an opaque integer, no spend data), but it contradicts the
"removed by the host before broadcast" contract for the replay leg. Minimal fix: strip
in the replay delivery path too, or omit the marker from the buffered copy.

## Accepted limitations (recorded, per plan)

- **L1 — conservative partial baseline:** an active live child absent from an already
  partial snapshot is not added or counted (`worker/src/telemetry.ts:216-218`); the
  response keeps the host's truthful subtotal until a rebuild prioritizes the path.
  Intentional per the approved rule; UI labels it partial.
- **L2 — host `TELEMETRY_CHILD_CHANGE_KINDS` omits `state`** (`server.ts:224`) to keep
  synthetic corrections from recursing. An ordinary child `state` update (e.g. a model
  change) does not by itself mark ancestors dirty; attribution changes arrive via
  `message_end` anyway. Sound trade-off; worth one evidence line.
- **L3 — a public read whose scope is forgotten/rekeyed/re-owned during its build
  fails with `RevisionUnavailable`** instead of being answered (`coordinator.ts:59-60`,
  pinned by the "abandons a delayed public build" test). A retry succeeds; a cheaper
  "answer anyway" is possible but would complicate the fences. Accepted.

## Correctness checks that passed (no findings)

- Request scoping: each concurrent read consumes its own attached snapshot; a delayed
  generation-1 answer cannot overwrite the cache, ack, membership or dirty state of a
  newer scope (`coordinator.ts:196-215` acceptance fence; tests 1–4).
- Dirty → coalesced refresh → publish fencing, including a stale coalesced refresh
  rejected behind a newer public read leaving neither dirtiness nor stale listeners
  (`refresh` finally block, `:150-181`).
- Pre-bootstrap/dirty streaming suppression (`streaming()` returns undefined unless
  fresh; worker refuses plain session-scope spend reads with `Unsupported` until the
  host supplies canonical spend — no bypass path; both live routes bootstrap, pinned by
  router tests).
- Coverage arithmetic under all three bounds (sources/model-lines/bytes) on both
  authorities, oversized live replacement demotion, unavailable fill-once across
  duplicate runs, settled folds not masking newer missing baselines (worker tests).
- Descendant scoping: root+registry-known child/grandchild deduped by path, sibling and
  unrelated root excluded, child-scope query excludes parent/siblings (e2e, 3.2 s, real
  built worker through production routing).
- API vs account separation, mixed billing, account cost never in API totals (e2e).
- Restart/reopen: pre-restart membership recovered from the host registry after
  `pi/worker/restart`; inactive-child append discovered on reopen and published as one
  numbered parent correction without polling (e2e assertions 2–6).
- Access: internal methods refused to normal and paired clients; strict schema rejects
  malformed snapshots, duplicate paths, wrong scope binding and sum violations
  (`schemas.test.ts:500-528`); worker never reads payload paths from disk (no
  `index`/fs access in `withLiveOverlay`; live entries come only from open runtimes).
- Bounded state: coordinator retains nothing for cold/uninterested scopes
  (`retainedScopes` test), forgets on close/rekey/worker loss; worker baselines drop
  with the session's `closed` event; live folds drop with their child's closure.
  `liveFolds` grows with a child's own turns only.
- UI: partial collapsed/expanded states, incomplete zero never renders "No API cost",
  account allowance separate, no paths/model names in copy; both states tested.
- Layering: no Pi imports above the worker; driver seam untouched; public params
  unchanged; no ledger/release/todo files in the delta.

## Validation performed in this isolated tree

Setup per frozen instructions: `pnpm install --frozen-lockfile` (no lockfile change),
builds in order protocol → worker → host (`BUILD-CHAIN-DONE`, all clean). Then:

| Command | Result |
| --- | --- |
| `pnpm -F @lasercode/protocol exec vitest run test/telemetry.test.ts test/schemas.test.ts test/environment-policy.test.ts` | 72/72 pass, no type errors |
| `pnpm -F @lasercode/worker exec vitest run test/telemetry.test.ts test/telemetry-dispatch.test.ts` | 10/10 pass |
| `pnpm -F @lasercode/host exec vitest run test/session-telemetry.test.ts test/session-telemetry.router.test.ts test/session-telemetry-coordinator.test.ts test/session-telemetry.restart.e2e.test.ts test/access.test.ts` | 48/48 pass, incl. the real `HostServer` + built `WorkerClient` restart case (3.2 s) |
| `pnpm -F @lasercode/ui exec vitest run test/shell/telemetry-format.test.ts test/shell/telemetry-panel.test.tsx test/runtime/environment-capabilities.test.ts` then `tsc -p tsconfig.json --noEmit` | 39/39 pass, typecheck clean |

These independently reproduce the parent's `/tmp/laser-spend-corrected-parent.log`
(72/10/48/39, same suites). Scratch probes for F1 ran against the built worker output
in `/tmp` (`trim-probe*.mjs`), outside the reviewed tree; no reviewed source, ledger or
store was modified. `pnpm verify` and the release gate remain parent-owned; UI tests
are string/DOM-slot proxies, not person acceptance — nothing here claims live/person
verification of the partial-spend copy.
