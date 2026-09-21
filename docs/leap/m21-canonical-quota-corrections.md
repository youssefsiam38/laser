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
