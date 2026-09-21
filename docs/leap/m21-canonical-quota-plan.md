# M21-T2 — canonical metadata accounting and quotas

> **Implemented.** §§1–12 below are the source audit and the original plan; the
> parent's amendment (D-365) and then §13 override them where they differ.
> Read §13 for what the code actually does.


Reopened T2 gap: the durable budget counts revision bodies and blobs only, so
every other canonical row — comments, approvals, decisions, evidence, edges,
repository links, capture associations, decision bindings, execution links —
is written free of charge. The root contract (`docs/project-lifecycle-leap.md`
lines 135–138 and 729–733) puts canonical comments and approval history inside
the budget that refuses, and inside the history nothing may ever evict.

Source audited: `packages/host/src/project-work/{store,schema,blobs}.ts` at
`36e163ed` (frozen backend checkpoint, read-only). All SQL in this area lives
in those three files: `captures.ts`, `delivery.ts`, `gate.ts`, `gates.ts`,
`methods.ts`, `mention-projection.ts`, `required-facts.ts` and `task-engine.ts`
contain no `INSERT`/`UPDATE`/`DELETE` and reach storage only through the store.
No store was instantiated and no test was run for this plan; it is a source
audit. Nothing here is implemented yet.

## 1. Audit — every writer, what it costs today, what it needs

Line numbers are `store.ts` at `36e163ed` unless stated.

| Writer (door) | Rows written | Charged today | Needed |
| --- | --- | --- | --- |
| `create` @811 | `revisions` 839, `entities` 858 | body bytes + 1 entity (832, 861) | body + all other revision/entity columns; record count |
| `revise` @894 | `revisions` 929, `entities` UPDATE 948 | body bytes (919, 950) | as above; entity row re-charge (title changes) |
| `comment` @1108 | `comments` 1141 | **nothing** | charge text + anchor + origin + row |
| `resolveComment` @1230 | `comments` UPDATE 1246–1255 | n/a | re-charge (state/timestamps: bounded delta) |
| `review` @1369 | `entities` UPDATE 1402 | n/a | re-charge entity row |
| `approve` @1427 | `approvals` 1488 (+ bindings) | **nothing** | charge covers_json/note/origin + row |
| `link` type `edge` @1583 | `edges` 1626 | **nothing** | charge |
| `link` type `evidence` | `evidence` 1763, `repository_links` 1922 for `verified_at` | **nothing** | charge both |
| `link` type `decision` | `decisions` 1797 | **nothing** | charge |
| `acceptDelivery` @1840 | `repository_links` ×N subjects 1922, `repository_link_captures` 1979 | capture **blob** only, earlier and separately (`captures.ts` 719 → `putBlob` 3186) | charge every link row and every association row |
| `insertRepositoryLink` @1913 | `repository_links` 1922 (+ first association) | **nothing** | charge |
| `appendCaptureAssociation` @1963 | `repository_link_captures` 1979 | **nothing** | charge (append-only history is canonical, D-363) |
| `attachCapture` @2276 | `repository_links` UPDATE 2287/2290, association append | **nothing** | re-charge link row + charge association |
| `bindDecisionProof` @2201 | `decision_capture_bindings` 2227, `decision_capture_binding_sets` 2247 | **nothing** | charge both |
| `taskAction` @2428 | `entities` UPDATE, `evidence` via `insertEvidence` 2791, bindings | **nothing** | charge evidence + bindings |
| `linkExecution` @2881 | `execution_links` INSERT 3010 / UPDATE 2991 (`repositories_json`), `evidence` 2791 | **nothing** | charge insert; re-charge on the `repositories_json` update |
| `applyStale` @3086 | `entities` UPDATE 3122 (`stale_json`) | **nothing** | re-charge entity row |
| `invalidateApprovals` @3160 | `approvals` UPDATE 3175 | n/a | re-charge (bounded delta) |
| `ensureRepository` @504 | `repositories` 528 | **nothing** | infrastructure class (§2), uncharged, bounded |
| `projectIdFor` @386 / `relinkProject` @425 | `projects` 396, `project_paths` 397/433 | **nothing** | infrastructure class |
| `nextKey` @764 | `key_sequences` 770 | **nothing** | infrastructure class (≤ one row per kind) |
| `putBlob` @3184 | `blobs`, `blob_chunks` (`blobs.ts` 60–99) | payload bytes, dedup-aware | unchanged |
| `raise` @603 | `events` 610 + prune 615–618 | **nothing** | derived class, bounded by `eventsRetained` |
| `writeSearchProjection` @801 | `search_projection` 804 | **nothing** | derived class, ≤1 row per entity |
| `remember` @652 / `once` @668 | `idempotency` | **nothing**, never pruned | charge (§2, A-3) |
| `delete` @1065 | deletes 10 tables 1081–1090 | credits `SUM(body_bytes)` + entity blobs (1075, 1091) | credit exactly what was charged; delete the rows it currently orphans (A-2) |
| `unlink` @2342 | deletes edges/links/execution/evidence/decisions 2374–2408 | credits **nothing** | credit exactly |
| `deleteProjectWork` @457 | deletes every partitioned table 463–491, then `projects` | counter row disappears with the project | unchanged; global total falls automatically |
| `releaseDerived` 3219–3225 | `releaseBlob` | credits freed bytes | unchanged |

Two further facts the repair depends on:

- **`delete` orphans canonical rows.** `repository_link_captures`,
  `decision_capture_bindings` and `decision_capture_binding_sets` key on
  `project_id` only (`schema.ts` steps 3 and 4), so an entity delete removes
  the link rows but leaves their history rows unreachable and undeleted. Under
  charging they would also stay charged for ever (A-2).
- **The only `ON DELETE CASCADE` is from `projects`.** No table references
  `entities`. `deleteProjectWork` deletes each table explicitly and drops the
  `projects` row last, so no charged row can vanish behind the counters' back,
  and no trigger machinery is needed for cascade credit.

## 2. Classification — what the budget counts

Every table partitioned by `project_id` falls in exactly one class. A guard
test (§7, T-11) enumerates `sqlite_master` and fails if a future table is in
none, which is what stops this being a history-only patch.

| Class | Tables | Budget |
| --- | --- | --- |
| **Canonical** | `entities`, `revisions`, `edges`, `comments`, `approvals`, `decisions`, `evidence`, `repository_links`, `repository_link_captures`, `execution_links`, `decision_capture_bindings`, `decision_capture_binding_sets`, `blobs`, `idempotency` | charged; refuses at the cap; never auto-evicted |
| **Infrastructure** | `projects`, `project_paths`, `repositories`, `key_sequences` | uncharged; bounded by workspace shape (paths a project has lived at, repositories in it, one row per kind) |
| **Derived / bounded** | `events` (≤ `eventsRetained`, 5000, pruned in `raise` 615–618), `search_projection` (≤1 row per entity, rebuildable from the current revision) | uncharged; may be pruned or rebuilt; never a reason to refuse |

`blob_chunks` carries no `project_id`: its payload is already counted once by
its `blobs.bytes`, and its per-chunk digests are overhead (§3).

## 3. The accounting definition (one definition, stated once)

For a charged row:

```
charge(row) = ROW_OVERHEAD_BYTES                      // fixed, 64
            + Σ columns:  TEXT → Buffer.byteLength(value, "utf8")
                          BLOB → value.byteLength
                          INTEGER | REAL | NULL → 0   // covered by the overhead
```

- **Logical payload, not file size.** What is counted is the bytes the store
  chose to keep: canonical JSON text exactly as stored, UTF-8, plus the fixed
  per-row constant. SQLite page, index, free-list, WAL and chunk-digest
  overhead is explicitly **not** counted. The cap is therefore a logical
  budget; the plan records the observed file-size factor (measure once during
  implementation on the bounds fixture; expected ≈1.2–1.6×) in the module
  comment, and never enforces it.
- **Blobs keep today's rule**: `blobs.bytes` of the deduplicated payload,
  charged once at first insert (`putBlob` 3186–3189), so the same capture
  stored twice costs one copy.
- **Revision bodies keep `body_bytes`** — the same number the row already
  stores — and the revision's other columns are added on top (A-4).
- **Counts**: `projects.record_count` tracks charged rows; `entity_count`
  stays exactly what it is and keeps its existing cap. No new count knob is
  proposed (A-1).

Charges are **stored**, not recomputed: each charged table gains
`charged_bytes INTEGER NOT NULL DEFAULT 0`. A credit therefore returns exactly
what was taken, for ever, even if a later release changes the cost function.
Recomputing at delete time was the alternative and is rejected: it silently
drifts across versions.

## 4. Enforcement

One choke point in `store.ts`; every canonical mutation goes through it.

```ts
const CANONICAL_TABLES = [...] as const;     // §2, drives helpers + reconcile + guard test
private chargeOf(values: readonly unknown[]): number;
private insertCharged(table, columns, values): number;      // requireRoom → INSERT → addBytes
private rechargeRow(table, pkColumn, pkValue): void;         // after an UPDATE of a variable column
private creditDeleted(table, whereSql, params): { bytes: number; rows: number };
private requireRoom(projectId, addedBytes, addedEntities, addedRecords, recovery?): void;
reconcileUsage(projectId): { bytes: number; records: number; changed: boolean };
usage(projectId?): { projectBytes, globalBytes, entities, records, limits };
```

Rules the implementation must hold:

1. **Transactional.** Charges, rows and events share the one transaction
   `write()` opens (356–377). A refusal throws inside it, `transaction()`
   rolls back (`schema.ts` 517–531), and `write()` drops `pending`, so a
   refused write leaves no row, no counter movement, no `projects.seq` bump
   and no event on the stream.
2. **Positive deltas only are checked.** `requireRoom` is consulted when the
   net delta is `> 0`. A credit, a delete, `releaseDerived` and a re-charge
   that shrinks a row are always allowed — that is what keeps an already
   over-cap store recoverable.
3. **No double charge on replay.** `once()` (668–680) replays before `work()`
   runs, so a repeated idempotency key never reaches a charge. New charge code
   must sit inside `work()` and nowhere else.
4. **The idempotency row is charged by the write that created it**, after
   `work()` succeeds; if that last charge does not fit, the whole mutation
   refuses and rolls back — including the key, which stays free to retry.
5. **No scan per write.** `requireRoom` reads the project's counter row and
   `SUM(bytes)` over `projects` (`usage` 546–557, one row per project). That pair
   is read **once per transaction** into a per-transaction snapshot held by
   `write()` and updated in memory as charges accumulate, then discarded; a
   ten-link `acceptDelivery` costs one read pair, not ten.
6. **Bounded statement cache.** Every helper builds SQL from a fixed
   `(table, column-list)` pair, so the added cache entries are O(tables), not
   O(writes). No helper may interpolate a variable-length parameter list.
   (Pre-existing dynamic SQL in `list()` is out of scope and untouched.)
7. **Counters are exact.** The `MAX(0, …)` clamp in `addBytes` (593–600) hides
   drift; the helpers keep counters non-negative by construction and the
   invariant test (§7, T-2) asserts `projects.bytes === reconcileUsage().bytes`
   after every scripted mutation.

## 5. Deletion credits

| Door | Credit |
| --- | --- |
| `delete` (entity) | `SUM(charged_bytes)` and `COUNT(*)` per table over `entity_id = ?`, taken immediately before the existing `DELETE`s, plus the entity's blobs as today; `entity_count -1` |
| `unlink` | credit each of the five predicates it already deletes by, with the same `WHERE` clause |
| `deleteProjectWork` | unchanged: the `projects` row goes, so project and global totals fall together |
| `releaseDerived` | unchanged (derived blob bytes only) |
| FK cascade | only from `projects`; see §1 — nothing else can cascade |

`delete` must additionally remove the rows it currently orphans
(`repository_link_captures`, `decision_capture_bindings`,
`decision_capture_binding_sets` for the entity's links) and credit them; see
A-2. Nothing else is deleted anywhere for space: there is no automatic caller
of `releaseDerived` in the tree (only `store.ts` defines it; `captures.ts` 719
and `verification/report.ts` 100 only ever `putBlob`), and the plan adds none.

## 6. Migration v5 → v6

`PROJECT_WORK_SCHEMA_VERSION` (`schema.ts` 29) 5 → 6, one `step(db, 5)`, inside
the existing atomic-step-plus-backup machinery (`migrate` 95–128), which copies
the file after a WAL truncate and refuses a newer database.

1. `ALTER TABLE … ADD COLUMN charged_bytes INTEGER NOT NULL DEFAULT 0` on each
   canonical table; `ALTER TABLE projects ADD COLUMN record_count INTEGER NOT
   NULL DEFAULT 0`.
2. One pass per table, computing `charged_bytes` from the row's own stored
   values with the §3 function. Nothing is invented, no row is rewritten
   beyond that column, and no row is deleted.
3. `projects.bytes` and `projects.record_count` are **replaced** by the
   recomputed sums, never added to — bodies and blobs are recounted by the
   same function that counted them before, so no byte is charged twice.
4. One log line per upgraded project naming the old and new totals.

Consequences the plan accepts and the copy must tell the truth about:

- A store can be **over cap after upgrade** because metadata was never counted
  before. It stays fully readable, every row survives, and only growth is
  refused, with the recovery sentence (§8). This is the required behaviour,
  not a failure mode.
- The migration is a single scan **once**, inside the transaction that already
  has a backup beside it; a crash leaves the database at v5 with its v5
  counters, and re-running the step recomputes from scratch rather than
  accumulating (idempotent by replacement).
- No reconciliation runs at open: a restart trusts the counters, because they
  are written in the same transaction as the rows. `reconcileUsage()` is
  exposed for the integrity surface and for tests, and is the only full scan.

## 7. Tests (red first, all against an isolated temp fixture)

Existing `packages/host/test/project-work/{store,bounds,migrations,crash}.test.ts`
patterns and `harness.ts` are reused; no new framework, no live user store, no
browser.

| # | Test |
| --- | --- |
| T-1 | UTF-8: a comment of multi-byte text charges `Buffer.byteLength`, not code-unit count; emoji and combining marks |
| T-2 | **Invariant**: after a scripted run of every mutation door, `usage().projectBytes === reconcileUsage().bytes` and the same for record counts |
| T-3 | Per-writer delta: each door in §1 moves the counters by exactly `chargeOf(row)`; comments/approvals/evidence/links/associations/bindings each asserted individually |
| T-4 | Project boundary: a write that fits by one byte succeeds; the next byte refuses with scope `project` |
| T-5 | Global boundary: two projects, the second refused with scope `global`, its own project counter untouched |
| T-6 | Record counts: `usage().records` and `entities` exact across create/comment/approve/delete |
| T-7 | Refused write writes nothing: no row, no event, `seq` unchanged, no idempotency row, and the same key succeeds later once room exists |
| T-8 | Same idempotency key replayed: `replayed: true`, counters byte-identical |
| T-9 | Restart + migration: a hand-built v5 fixture upgrades to v6 with a `.v5.backup` beside it, row counts identical before and after, counters equal `reconcileUsage`, and a second open changes nothing |
| T-10 | Deletion: entity delete and `unlink` return the counters to exactly their pre-write values (modulo uncharged infrastructure and the project-scoped idempotency rows, asserted explicitly) |
| T-11 | Classification guard: every `project_id`-partitioned table in `sqlite_master` is in exactly one class list |
| T-12 | No canonical eviction: at the cap, the refusal releases nothing — blob rows, comments, approvals and capture history are byte-identical after the refusal |
| T-13 | Over-cap store: a store migrated above its cap answers reads, refuses growth with the recovery sentence, and still allows delete/unlink to bring it back under |
| T-14 | Honest gate copy: an approve refused at the cap **after** a capture was stored by the gate's own earlier transaction does not claim nothing was saved (§8) |
| T-15 | D-363 preserved: association append-only, `attachCapture` CAS still returns `false` on a lost race and appends nothing, binding set rows still distinguish "bound nothing" from "unknown" |

## 8. Error copy

Reuse `ProjectWorkQuotaError` (`errors.ts` 38–56), `PROJECT_WORK_QUOTA_CODE`
(-32011) and `ProjectWorkQuotaRefusal` unchanged. Two honesty fixes:

- `requireRoom` takes the recovery sentence from its caller instead of
  hard-coding "Nothing was saved." Doors whose gate already stored a capture in
  an **earlier** transaction (`captures.ts` `storeCapture` @712, wrapped by
  `gateRefusedForSpace` @743) pass a sentence that says the prepared
  evidence is kept and the decision was not recorded. A refusal must never
  promise that a separate preparation was rolled back — only the decision's own
  transaction was.
- The over-cap-after-upgrade refusal says the saved work is all still there and
  readable, names export or explicit deletion, and never suggests the database
  is damaged.

## 9. Preserved invariants

D-363 append-only capture provenance; prepared-vs-successful decision
distinction (a preparation is never recorded as a decision); the immutable
`attachCapture` compare-and-set and its honest `false`; immutable revisions;
key allocation never reused; one worker per project directory; nothing above
the worker imports Pi. Accounting adds columns and counters only — no
behavioural change to any gate, transition or history rule beyond A-2.

## 10. Protocol / resource integration

None required. The refusal already carries `scope`, `recovery`, `usedBytes`
and `limitBytes` over the wire, which is the whole recovery surface the leap
asks for. `usage()` gains a `records` field in-process only. If a workspace
usage meter is wanted, that is a separate small read (`project/work/usage`, or
a field on `project/work/list`) belonging to M21-T4/T22 — deliberately not
invented here. No existing limit is raised: `PROJECT_WORK_PROJECT_BYTES_DEFAULT`
(512 MB), `PROJECT_WORK_GLOBAL_BYTES_DEFAULT` (4 GB),
`PROJECT_WORK_PROJECT_ENTITIES_DEFAULT` (20 000) and `eventsRetained` (5000)
stay exactly as they are.

## 11. Material ambiguities for the parent

| # | Question | Recommendation |
| --- | --- | --- |
| A-1 | The contract says "byte/count quotas". Add a canonical **record** cap, or let the entity cap remain the count quota? | No new cap. Counters make one a one-line change later |
| A-2 | Entity delete currently orphans capture-association, binding and binding-set rows. Delete and credit them with the entity? | Yes — the parent link row is already deleted, the rows are unreachable, and an explicit permanent delete already removes approvals and comments. Touches D-363's append-only wording, so it needs the parent's nod |
| A-3 | `idempotency` is durable, unbounded in count, and documented as answering "for ever". Charge it, or prune it with a retention knob? | Charge it. Pruning would change a stated contract |
| A-4 | Charging a revision's non-body columns raises reported usage slightly and changes assertions in the existing store tests | Charge uniformly; update those assertions as part of the repair |
| A-5 | `search_projection.values_text` is body-sized and uncharged (≤1 per entity) | Leave uncharged as derived; if the cap should track real disk, apply a documented multiplier rather than charge derived rows |
| A-6 | The 64-byte `ROW_OVERHEAD_BYTES` constant is a judgement call | Fix it at 64 and record the measured file-size factor in the module comment |

## 12. Work order once approved

1. Schema v6: columns, `record_count`, migration step, backup path unchanged.
2. Accounting core: `chargeOf`, the three helpers, `requireRoom` signature and
   per-transaction usage snapshot, `reconcileUsage`, `usage().records`.
3. Convert every writer in §1 to the helpers; convert `delete`/`unlink`
   credits; resolve A-2.
4. Copy fixes (§8).
5. Tests T-1…T-15, red first where the behaviour is new.
6. `pnpm -F @lasercode/host test`, then the full `pnpm verify` at a stable
   point, evidence into the T2 row the parent owns.

## Parent approval with required amendments (D-365)

The source audit and cohesive accounting approach are accepted. The amendment
message to the stopped investigator was refused by the runtime, not delivered.
This section resolves §11 and overrides the conflicting implementation details
above; implementation still requires a named owner.

- **A-1:** enforce explicit canonical-record caps: 200,000 per project and
  1,000,000 globally, configurable through the existing store quota options.
  Existing byte/entity limits are unchanged. Add accurate count-refusal data
  through the minimal existing protocol shape if needed; never label counts as
  `usedBytes`. These are new admission ceilings, not raised existing limits.
- **A-2:** explicit permanent entity deletion may remove that entity's own
  capture/decision history and credit its persisted charges. First refuse a
  deletion that would destroy a blob, association or link proof consumed by a
  **surviving other-entity decision**. Do not blindly delete those other
  bindings or leave them pointing at missing proof. Explicit deletion is not
  automatic eviction and does not permit silently amputating another record.
- **A-3/A-4:** charge durable idempotency receipts, do not prune them; uniformly
  charge revision/entity metadata. Update old body-only assertions with exact
  evidence, not arbitrary larger test budgets.
- **A-5/A-6:** bounded derived search/events remain separately classified and
  uncharged by the canonical budget. A 64-byte logical row floor is accepted;
  it is not a physical SQLite size guarantee. No unmeasured 1.2–1.6× claim or
  disk-size multiplier is approved.
- `project_paths` and `repositories` are canonical identity mappings, not
  actually bounded merely by saying 'workspace shape': charge them too.
  Include project metadata and blob **row metadata**, with blob payload charged
  once under its deduplication rule. Counter/key-sequence bookkeeping must have
  an explicit, genuinely bounded classification; no free arbitrary history.
- Admission must respect **net transaction deltas** against entry usage and
  limits. Per-statement positive checks cannot make an already-over-cap,
  net-shrinking deletion fail merely because `remember()` adds its receipt
  after the credits. Permit net-nongrowth recovery even if usage remains above
  a newly enforced limit. Keep each operation bounded; do not scan all rows per
  mutation. Test mixed credits/updates/receipt writes and final rollback.
- The accounting invariant must independently derive charges from **raw stored
  values**, not only sum `charged_bytes`: summing stale stored charges would
  miss a forgotten recharge after an UPDATE. Credits use persisted charges;
  migration/reconciliation recomputes honestly and without double charging.
- Recovery copy must distinguish a refused decision transaction from evidence
  prepared in an earlier transaction, and must not suggest archive frees
  canonical history. Account for project-scoped receipts that intentionally
  survive entity deletion when explaining explicit cleanup.

The backend at `36e163ed` is frozen. Its old owner is UI-only; the runtime owner
writes worker code and the separate verification-stopping protocol field.
The canonical-accounting owner may merge that entire checkpoint into this
parent line and write host accounting/schema/blob helpers/tests plus minimal
quota protocol types. No UI or worker writes. Use focused host project-work
and relevant protocol suites, build/types/identity; parent owns the full gate.
One independent storage review follows implementation. No general budget
framework, raised limits, silent canonical deletion or unbounded per-write scan.

## 13. What was implemented, and where the plan changed

The repair landed on the merged `36e163ed` backend. Files written:
`packages/host/src/project-work/{accounting.ts,store.ts,schema.ts,errors.ts,
methods.ts}`, `packages/protocol/src/project-work-methods.ts`, and the tests
`packages/host/test/project-work/quota.test.ts` plus assertion updates in
`{store,bodies}.test.ts` and `packages/protocol/test/project-work-methods.test.ts`.

### The definition

`accounting.ts` is the single definition: `ROW_OVERHEAD_BYTES = 64` plus the
UTF-8 length of every stored TEXT value and the byte length of every stored
BLOB; integers, reals and nulls are covered by the floor. A `blobs` row is
charged its own metadata **plus** its deduplicated payload once, and gives the
payload back — keeping the row and its metadata charge — when a derived blob is
released. `blob_chunks` is never charged: it is that same payload.

Classification lives in the same file and is the guard test's input:

| Class | Tables | Why |
| --- | --- | --- |
| `CANONICAL_TABLES` | `projects`, `project_paths`, `repositories`, `entities`, `revisions`, `edges`, `comments`, `approvals`, `decisions`, `evidence`, `repository_links`, `repository_link_captures`, `execution_links`, `decision_capture_bindings`, `decision_capture_binding_sets`, `blobs`, `idempotency` | charged, counted, refused at the cap, never auto-evicted |
| `BOOKKEEPING_TABLES` | `key_sequences` | ≤ one row per project per kind, and a row that never grows — a stated bound, not an appeal to "workspace shape" |
| `DERIVED_TABLES` | `events` (≤ `eventsRetained`, pruned on every raise), `search_projection` (≤ 1 per entity, rebuildable) | reproducible and bounded; never a reason to refuse |
| `UNPARTITIONED_TABLES` | `blob_chunks` | the payload already counted through `blobs.bytes` |

`project_paths` and `repositories` are charged as canonical identity mappings,
per the amendment; the plan's §2 claim that they are bounded by workspace shape
is withdrawn.

### Enforcement: one net decision per transaction

Charges are **stored** in a `charged_bytes` column on each canonical table.
`ProjectWorkStore.chargeRow` prices a row from what is really in it and moves a
per-transaction ledger by the difference from what that row was charged before,
so the same call answers an insert, an update that grew and an update that
shrank. `creditRows` gives back the persisted charge immediately before the
`DELETE` that uses the same `WHERE`.

Admission is decided once, in `settle()`, inside the transaction and before the
commit: a ceiling is only consulted when the transaction's **net** delta for
that dimension is positive, against the usage the transaction started with.
That is what lets an over-cap store recover — a deletion that credits more than
the idempotency receipt it writes afterwards costs is admitted even though the
store is still over the limit when it finishes. Cost is one counter read per
project touched plus one global sum, whatever the transaction wrote; every
statement shape is fixed per table, so the prepared-statement cache is
O(tables).

A refusal throws inside the transaction, so the rows, the counters, the
`projects.seq` bump, the events and the idempotency receipt roll back together.

### Counts

`projects.record_count` counts charged rows. New ceilings, configurable through
the existing `ProjectWorkQuota`: `projectRecords` 200 000, `globalRecords`
1 000 000. `PROJECT_WORK_PROJECT_BYTES_DEFAULT` (512 MB),
`PROJECT_WORK_GLOBAL_BYTES_DEFAULT` (4 GB) and
`PROJECT_WORK_PROJECT_ENTITIES_DEFAULT` (20 000) are unchanged; no limit was
raised. `ProjectWorkQuotaError` gained `measure`/`usedCount`/`limitCount`, and
`ProjectWorkQuotaRefusal` carries them as optional fields over the wire —
`usedBytes` and `limitBytes` remain bytes and only bytes. No new RPC method, no
usage meter.

### Deletion (A-2)

An explicit entity deletion now also removes and credits the rows it used to
orphan: that entity's `repository_link_captures`, `decision_capture_bindings`
and `decision_capture_binding_sets`. Before any of that, `proofConsumedElsewhere`
refuses the deletion outright when a **surviving other** item's decision bound
one of these links or blobs, when another item's evidence names one of these
links, or when another item's link is proved by one of these blobs. Nothing is
blindly unbound and nothing is left pointing at missing proof. `unlink` credits
each predicate it already deleted by, and takes a removed repository link's own
association history with it.

Project-scoped idempotency receipts intentionally survive an entity deletion —
they answer the same key for ever — so the counters do not return exactly to
their pre-write values, and the test asserts the remaining difference is
precisely the receipts.

### Migration

`PROJECT_WORK_SCHEMA_VERSION` 5 → 6, one `step`, inside the existing
backup-then-atomic-step machinery. It adds `charged_bytes` (idempotently, by
asking the table what it has) and `record_count`, then recomputes every row's
charge from its own stored values and **replaces** `bytes`, `record_count` and
`entity_count`. No row is deleted, no column but `charged_bytes` is written, and
re-running it recomputes rather than accumulates. One log line per project.

A store can be over its cap afterwards. It stays fully readable, and only growth
is refused. `reconcileUsage()` is the independent recount: it derives the totals
from the raw rows and never sums `charged_bytes`, so a forgotten recharge after
an UPDATE is a test failure rather than silent drift.

### Copy

The refusal sentences no longer offer archiving as a way to make room —
archiving hides an item and keeps every byte of its history — and no longer say
"Nothing was saved" when the caller's gate stored evidence in an **earlier**
transaction: `approve` and `taskAction` carrying a `proof` preparation refuse
with a sentence that says the prepared evidence is kept and readable and that
the decision itself was not recorded.

### Withdrawn from the plan

- §3's "observed file-size factor … expected ≈1.2–1.6×": not implemented and
  not measured. The budget is logical; nothing claims a relationship to the
  size of the SQLite file.
- §11 A-1's "no new cap" and §2's "bounded by workspace shape": superseded by
  the amendment.
- §4's per-statement `requireRoom(projectId, addedBytes, …)`: replaced by the
  net per-transaction settlement above, for the reason the amendment gives.

### Evidence

- `pnpm -r build` — clean.
- `env -i PATH="$PATH" HOME="$HOME" pnpm -F @lasercode/host exec vitest run test/project-work` — 21 files, 335 tests passing (311 before this work, 24 new in `quota.test.ts`).
- `pnpm -F @lasercode/protocol exec vitest run test/project-work.test.ts test/project-work-methods.test.ts test/schemas.test.ts` — 95 passing, no type errors.
- `pnpm identity:check` — clean.
- Not run here (the parent owns the full gate): `pnpm verify`, the UI and worker suites.
