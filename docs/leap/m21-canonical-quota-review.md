# M21-T2 / D-365 — first independent storage review of the canonical quota accounting

- **Target:** `40c89aa1` + `8e69281b` over base `613b9192` (full ancestry preserved, including the
  frozen Native checkpoint `36e163ed` under the base). Source read at
  `/home/youssef/projects/laser/.worktrees/correct-canonical-quota-boundaries-f4e5c207`
  (`agents/correct-canonical-quota-boundaries-f4e5c207`, clean at `8e69281b`). Review-only; the
  source worktree was not modified.
- **Governing requirements:** `docs/project-lifecycle-leap.md` (canonical history/quotas),
  `docs/leap/m21-canonical-quota-plan.md` §13/§14 with the final parent amendment **D-365**, and
  `docs/leap/m21-canonical-quota-corrections.md`. Superseded plan clauses (§2 "workspace shape",
  §4 per-statement `requireRoom`, §3 file-size factor) were treated as withdrawn, per §13.
- **Scope reviewed in full:** `packages/host/src/project-work/{accounting.ts,store.ts,schema.ts,
  errors.ts,methods.ts}`, `packages/protocol/src/project-work-methods.ts`, both diffs
  (613b9192→40c89aa1 and →8e69281b), and the test changes. The Native `36e163ed` proofs were
  treated as a prerequisite: only their interactions with accounting/deletion were checked, not
  the pending full T19 runtime/UI review.

## Verdict

**Not approved yet — one substantive blocker (H-1).** The accounting core is sound and unusually
well-tested: the single charge definition, stored charges with persisted credits, net-transaction
admission, independent raw-row recompute, no-clamp drift refusal, bounded migration and the
cross-owner proof protection all hold up under independent reading and testing. H-1 is a
copy-honesty regression of exactly the class D-365 and correction #2 fixed elsewhere: three doors
whose gate stores the capture in an **earlier** transaction still refuse with "Nothing from this
action was saved" while that capture is saved and readable. The fix is small and local.

## Findings

### H-1 (blocker, medium): the preparation-truthful refusal is missing on the delivery, verified-state and attachCapture doors

`settle()` takes its refusal sentence from `preparedGate` (`store.ts:703, 775-786`), which is set
only in `approve` (`store.ts:1849`) and `taskAction` (`store.ts:2871`). Three more doors consume a
capture that `storeCapture` wrote in a **separate earlier transaction**, and none of them sets it:

| Door | Earlier-transaction capture | Decision transaction |
| --- | --- | --- |
| accept a delivery | `gate.ts:346` (`"Accepting this delivery"`) | `store.link` type `delivery` → `acceptDelivery` (`store.ts:2251`) |
| record / accept a verified state | `gate.ts:469` (`"Recording this state"` / `"Accepting this preview"`) | a later `link` evidence with `verified.captureBlobId`, or `attachCapture` |
| correct a link's capture | `gate.ts:679` | `store.attachCapture` (`store.ts:2705`) |

A refusal at either scope on those doors falls back to `PROJECT_FULL_RECOVERY` /
`GLOBAL_FULL_RECOVERY` (`store.ts:146-155`), whose last sentence — *"Nothing from this action was
saved."* — is false: the capture the person just watched being taken is still stored and readable.

Reproduced twice at the exact revision (built `dist/` of `8e69281b`, owned temp fixtures under
`/tmp/quota-review-scratch/`, no source mutation):

- `project/work/link` (delivery, `capture` present) refused at the project byte ceiling →
  recovery ends *"Nothing from this action was saved."*; `readBlob` of the prepared capture
  returns intact bytes; usage unchanged.
- `attachCapture` (correction gate capture stored first) refused at the project byte ceiling →
  same false sentence; the prepared capture still stored and readable; the pointer move rolled
  back.

This violates the D-365 amendment ("recovery copy must distinguish a refused decision transaction
from evidence prepared in an earlier transaction") and the acceptance item "prepared gate captures
can precede the decision transaction: both project AND global byte/count refusals say preparation
retained, decision not recorded". `gateRefusedForSpace` (`captures.ts:743`) only covers the
capture write itself, not the later decision write.

**Remedy (small):** record the gate for these doors too — e.g. set `preparedGate` in
`acceptDelivery` when `input.capture` is present, in `attachCapture` when `context.gate` is
present, and in the `verified.captureBlobId` evidence path — or take a caller-supplied recovery
sentence like §8 originally specified. Add the two refusals (project and global, bytes and
counts) to `quota.test.ts` next to the existing approve tests at lines 726-891.

### M-1 (non-blocking, invariant hygiene): `remember()` keeps `INSERT OR REPLACE`

`store.ts:916-924` writes the idempotency receipt with `INSERT OR REPLACE` and a pre-read of
`existing`, then `chargeRow`. Reachability analysis: `once()` (`store.ts:940-948`) replays before
`work()` and returns before `remember()`, and no door nests a same-key `once` inside another, so a
replacement is unreachable today; cross-process interleaving is excluded by the one-worker-per-
directory invariant. If it ever fired, the `REPLACE` resets `charged_bytes` to 0 and `chargeRow`
would add the full charge on top of the charge already in the counters — a fail-closed
over-count, never an under-count, so it cannot hide drift. Still, the simplest maintainable
invariant is a plain `INSERT`: any future double-`remember` becomes a constraint failure rolled
back with the transaction instead of a silent re-price, and the `existing` pre-read disappears.
One line plus one removed statement; no behaviour change today.

### M-2 (non-blocking, bound honesty): the scan bound is 500 **rows**, not bytes

`CHARGE_SCAN_BATCH_ROWS = 500` (`accounting.ts:116`) bounds rows per read; the comment
(`accounting.ts:110-115`) says the memory "is the size of one page". That is a row bound: the
worst-case page materialises 500 of the largest rows, and `revisions.body` may be up to 4 MB
(`PROJECT_WORK_BODY_MAX_BYTES`), so a theoretically aligned page is ~2 GB — bounded in practice by
the legacy 512 MB project byte cap (~≤500 MB), and the scan runs once per migration. The traced-db
test (`quota.test.ts:1445`) honestly asserts rows-per-read ≤ 500, no `SELECT *`, and no
`blobs.data` in any read — it does not assert, and was never claimed to assert, a byte ceiling.
Acceptable as a one-time bound; the comment should say "bounded **rows**" and name the worst-case
page size, or add a byte-based early page cut. Do not read this as approval of a byte bound —
there is none, and none is claimed in code, which is the honest part.

### M-3 (nit, legibility): the count fields in `toProtocolError` are a nested conditional spread

`methods.ts:1256-1258` builds `measure`/`usedCount`/`limitCount` with a one-line nested ternary
spread. A small `if (error.measure !== "bytes") { … }` block says the same thing legibly. No
behaviour change; the protocol shape itself (`project-work-methods.ts:146-166`) is right — bytes
stay bytes, counts carry their own pair, and the protocol test holds both halves.

### M-4 (non-blocking, structure): `store.ts` keeps growing

`store.ts` is 4,349 lines at `8e69281b` (+626 in this change; ~3,723 at the base). The extraction
of the charge definition into `accounting.ts` was the right move and is the single definition the
plan required. The next cohesive extraction candidate is the deletion cluster — `delete`,
`creditRows` wiring, `proofConsumedElsewhere` and `dependentProofRefusal` (`store.ts:1352-1535`),
~230 lines that share one concern and one contract — but nothing in this change is a regression
against a file that was already far past 1k. Record it as debt, not a blocker.

## Independently verified (all green at `8e69281b`)

- **Charging definition.** `rowCharge` (`accounting.ts:137-161`) is the one definition: 64-byte
  floor, exact UTF-8 of stored TEXT, byte length of stored BLOB, integers/reals/nulls under the
  floor; `blobs.data` excluded from the read projection and the payload charged once through
  `bytes`; a released derived blob keeps its metadata charge and returns the payload. Revisions
  are charged `body` once plus their other columns. The module comment explicitly disclaims any
  physical file-size guarantee.
- **Classification.** `CANONICAL_TABLES` / `BOOKKEEPING_TABLES` / `DERIVED_TABLES` /
  `UNPARTITIONED_TABLES` cover every table exactly once; the guard test checks `sqlite_master`
  both directions, and `key_sequences` is genuinely bounded (PK `(project_id, kind)`, ≤5 rows per
  project, never grows). `project_paths` and `repositories` are charged as the amendment required.
- **Every canonical identity/content/history row charged.** The invariant test walks create,
  revise, comment, resolve, review, approve, edge/decision/evidence links, delivery, capture
  association, attach CAS, execution start/end, task action, archive, unlink, delete,
  relink, removeProject and asserts `usage() === recomputeProjectUsage()` (raw-row, never sums
  `charged_bytes`) after each. Mappings charged with correct inserted/recharge flags;
  `relinkProject` refuses a path owned by another project (`store.ts:514-530`), so no cross-project
  counter drift is reachable through it.
- **Idempotency.** Receipt charged inside the deciding transaction after the work; refusal rolls
  the key back free; replay changes nothing (`quota.test.ts:626`); receipts survive entity delete
  on purpose and the deletion test asserts the counter difference is exactly the receipts
  (`quota.test.ts:434`).
- **Admission.** Net-transaction settlement (`settle()`, `store.ts:775-853`): one counter read per
  project in the ledger plus one global `SUM`, ceilings consulted only on positive net deltas,
  decided inside `transaction()` before commit — a refusal leaves no row, counter movement, `seq`
  bump, event or receipt. Defaults: records 200k/1M new; bytes 512 MB/4 GB and entities 20k
  unchanged (asserted). Over-cap migrated stores stay readable and admit net-nongrowth recovery,
  including delete-with-receipt (`quota.test.ts:645, 1363`).
- **Drift.** No clamp: `bytes = bytes + ?`, then a read-back that refuses a negative total with an
  honest sentence (`store.ts:826-853`), and the fixture proves the same deletion succeeds once the
  counters match the rows (`quota.test.ts:1212`).
- **Deletion and proof protection.** `proofConsumedElsewhere` (`store.ts:1447`) probes: other
  entities' bindings to these links/blobs, other evidence naming these links/blobs, other links'
  current capture pointer, retained Native acceptance `$.captureBlobId`, and older associations in
  other links' append-only history. Refusal names the dependent key and offers no false recovery.
  Explicit deletion removes and credits the rows it used to orphan (`repository_link_captures`,
  `decision_capture_bindings`, `decision_capture_binding_sets`) and credits exactly the persisted
  `charged_bytes` of every predicate it deletes. D-363 CAS, bindings and the
  bound-nothing-vs-unknown distinction are intact (decision-proof and capture-history suites pass).
- **Migration v5→v6.** Backup beside the file, one atomic step, `charged_bytes` added
  idempotently, counters **replaced** from a recompute that never reads stored charges, re-run
  idempotent, no row lost, `.v5.backup` asserted. Keyset pagination orders by each table's own
  primary key (row-value comparison for the two composite keys), `charged_bytes` is in no key, and
  every page is materialised before it is written back.
- **Statement shapes.** All SQL is from fixed literals; `statement()` caches by SQL string
  (`store.ts:414-421`); per write the cost is one read per touched row plus settlement — no
  per-write canonical scan anywhere.

## Validation run (this review, isolated)

- `env -i PATH="$PATH" HOME="$HOME" pnpm -F @lasercode/host exec vitest run
  test/project-work/quota.test.ts test/project-work/migrations.test.ts
  test/project-work/decision-proof.test.ts test/project-work/capture-history.test.ts`
  → **4 files, 53 tests, all pass** (quota 33).
- `pnpm -F @lasercode/protocol exec vitest run test/project-work-methods.test.ts` → 22 pass,
  no type errors.
- `pnpm -F @lasercode/host exec tsc -p tsconfig.json --noEmit` → clean.
- `pnpm identity:check` → clean.
- Two runtime reproductions of H-1 against the built `dist/` of the exact revision, with owned
  temp fixtures under `/tmp/quota-review-scratch/` (deleted store files stay there; nothing in the
  source worktree or any user store was written). Not left as committed artifacts.

## Limits

- The full host project-work suite (344) was reproduced by the parent and not re-run here; the
  four focused files above were. No full `pnpm verify`, UI, worker or monorepo gate (parent owns).
- The red-first 11-failure claim was traced by the parent; not re-verified here. The
  crowded-upgrade test is, as its own notes say, a no-data-loss and idempotency proof; the bound
  evidence for pagination is the traced-db test, which bounds **rows** (see M-2).
- The Native T19 runtime/UI full review remains pending elsewhere; only its storage interactions
  with accounting/deletion were checked.
- M-1's reachability is argued from the code (single-threaded writes, `once()` ordering, no nested
  same-key `once`); no runtime mutation test was built for it.
- Migration performance on very large real stores was not measured; the fixture is ~1k rows.
