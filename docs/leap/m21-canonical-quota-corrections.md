# M21-T2 — parent corrections to accounting checkpoint 40c89aa1

The full36e163ed backend is preserved through613b9192; the accounting repair
has substantial focused coverage (worker reports335 host project-work tests
and754 protocol tests). Parent inspected accounting.ts and the store diff,
including evidence insertion and deletion guards. Before the independent
storage review, finish this single approved batch. The continuation message
to the stopped owner was refused, not delivered; preserve its entire branch.

1. **Bound migration memory.** rechargeProject currently uses SELECT * then
   all(projectId), including inline blob payloads. A metadata migration must
   not materialize every stored payload in a project at once. Use stable,
   bounded keyset batches and a projection that excludes blob data already
   counted through bytes; do not rely on mutating a live scan cursor. Prove
   batch bounds/counter parity on an owned multi-page fixture and retain
   atomic backup/migration/no-data-loss behavior.
2. **Global quota copy must preserve preparation truth.** settle's project
   branches use this.recovery, but its global byte/record branches hard-code
   GLOBAL_FULL_RECOVERY, which says nothing from this action was saved. A gate
   may already have stored a capture in an earlier transaction. Honor the
   decision-specific recovery for both global dimensions; prove preparation
   retained, decision/receipt/events rolled back, and truthful refusal copy.
3. **Reject drift, never silently clamp it.** The counter UPDATE still uses
   MAX(0, ...) despite the approved no-clamp invariant. Reject inconsistent
   negative final counters atomically rather than making a bad ledger appear
   valid. Preserve legitimate over-cap net-shrinking recovery and ordinary
   exact credits, with a targeted corruption/invariant fixture.
4. **Preserve all cross-owner proof references.** proofConsumedElsewhere
   checks decision bindings, evidence.repository_link_id and current capture
   pointers, but not another entity's direct evidence.blob_id, an older
   association of another surviving link, or retained Native acceptance that
   names the old blob after a pointer correction. Evidence insertion accepts
   blobId without same-entity ownership; these are meaningful references, not
   hypothetical absent fields. Protect them before deleting the owning
   entity's blobs. Test historical proof readability and atomic refusal.
   Refusal copy must identify a bounded dependent key and not offer false
   recovery: superseding a decision or recapturing current state does not
   remove its immutable historical references. Explain retaining the item or
   explicitly deleting dependent work, with no silent history rewriting.

Ownership remains host accounting/schema/blob/store/error helpers and focused
project-work tests, with only necessary quota protocol changes. No UI,
verification runtime, worker/lifetime, SDK/Legend or planning-file writes.
Keep D-365's byte/count limits, classifications, deduplication, idempotency,
net-transaction admission, persisted deletion credits and raw-row recompute.
Run focused host project-work/protocol tests, build/types/identity; parent owns
full gates and the first independent storage review. No unrelated framework,
raised limits, weakened assertions, skips or live user-store experiments.

## Implemented

All four corrections are implemented on the merged `40c89aa1` branch, in
`packages/host/src/project-work/{accounting.ts,store.ts}` with focused tests in
`packages/host/test/project-work/quota.test.ts`. What each one does, what was
proved and what was deliberately left alone is in §14 of
[`m21-canonical-quota-plan.md`](m21-canonical-quota-plan.md): bounded keyset
pages with a payload-free projection for the migration and the recount;
preparation-truthful recovery copy on both global ceilings; a refused
transaction instead of a clamped counter; and the three added cross-owner proof
probes with refusal copy that names the dependent key and offers no recovery
that does not exist. Host project-work 344 tests, protocol 754, build,
typecheck and identity clean. The independent storage review is still pending.

## Parent triage of independent review472b1347 — one final correction batch

- **H-1 accepted:** capture preparation also precedes accept-delivery,
  verified-state evidence and attachCapture. All these doors need truthful
  project/global byte/count refusal context. Prefer a small typed preparation
  context over scattered unrelated copy; distinguish approval/completion from
  evidence/link writes where wording matters. Prove retained preparation and
  complete rollback of the refused write at each door.
- **M-1 accepted:** use plain INSERT for immutable idempotency receipts and
  remove the replacement pre-read. A duplicate must fail atomically, not reset
  its persisted charge. Preserve ordinary replay and charge invariants.
- **M-2 elevated for correction:** a page that can materialize roughly500 MB of
  revision bodies is not an acceptable metadata-migration memory strategy.
  Do not merely relabel the row bound. Compute charge from stored byte lengths
  without returning source/body/payload strings in migration scan result rows,
  or use an equivalently strict bounded-byte approach. Preserve exact UTF-8
  including NUL/non-ASCII, BLOB handling, released payload and numeric/null
  semantics; account explicitly for SQLite encoding. Keep raw-value recompute
  independent of persisted charged_bytes and validate SQL/JS parity. Use owned
  multi-page large-text fixtures and structural projection/bound assertions,
  not a timing or RSS assertion. Existing logical limits stay unchanged.
- **M-3 accepted:** simplify count-refusal serialization to a named, clear
  branch or typed object rather than a nested conditional spread.
- **M-4 deferred explicitly:** the existing large store's deletion cluster is
  a cohesive future extraction candidate. Do not refactor its whole authority
  during this bounded final correction; retain the report as structural debt.

The full T19 reviewer is reading immutable candidate7115a976. Apply this batch
in a NEW isolated branch based on that entire candidate plus this review and
triage; never modify either frozen review target. Only one source fixer is
active. Any later T19 correction follows this batch, in dependency order.
The parent verifies the final storage delta and focused tests; there is no
second independent storage review (the reviewer's request to re-review is not
adopted). Preserve full source/review ancestry and record evidence precisely.
