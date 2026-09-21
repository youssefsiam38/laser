# M21 spine — protocol, store, host authority (T1 → T4)

Working notes and checkpoints for the canonical backend spine of the project
lifecycle leap. The binding contract is
[`docs/project-lifecycle-leap.md`](../project-lifecycle-leap.md); this file
records what was built, the decisions taken where the contract is silent, and
the exact wire shapes the workspace UI (M21-T5/T6) and the model tools
(M21-T17/M21-T26) consume.

Rule used for every open question: **keep Laser the single authority, and keep
links optional** (D-331, D-352).

## Task ledger

| Task | State | Evidence |
| --- | --- | --- |
| M21-T1 Protocol domain, revisions and transition rules | done | `pnpm -F @lasercode/protocol test` |
| M21-T2 Stable project identity and canonical store | done | `env -i … pnpm -F @lasercode/host test` |
| M21-T3 Host authority, methods, policy and event stream | done | `env -i … pnpm -F @lasercode/host test` |
| M21-T4 Bounded bodies, search and derived projections | done | `env -i … pnpm -F @lasercode/host test` |

---

## M21-T1 · Protocol domain, revisions and transition rules

### What landed

| File | What it owns |
| --- | --- |
| `packages/protocol/src/project-work.ts` | identities, keys, states, edges, supporting records, pure transition and staleness functions |
| `packages/protocol/src/project-work-bodies.ts` | the closed body schema of every primary kind, plus `SourceRef`, `DesignTree`, `Sketch` and `DesignIndex` |
| `packages/protocol/src/project-work-methods.ts` | the method inventory: params/result types, zod param schemas, per-method byte limits, notification shapes |
| `packages/protocol/test/project-work.test.ts` | domain, keys, refs, "no session owner" |
| `packages/protocol/test/project-work-transitions.test.ts` | legal/illegal transitions per kind, `done` evidence rule, no automatic run→done, stale propagation |
| `packages/protocol/test/project-work-methods.test.ts` | round-trip samples per method, policy rows, pressure rows, byte limits |

Registration edits (nothing else changed in those files): `messages.ts`
(`ClientRequests` + `HostNotifications` rows), `schemas.ts` (spread of
`projectWorkParamsSchemas`), `method-policy.ts` (`METHOD_POLICY` +
`NOTIFICATION_SCOPE` rows), `transport-pressure.ts` (`NOTIFICATION_PRESSURE`
rows), `index.ts` (three exports).

### Decisions where the contract is silent

1. **Method scopes.** Reads (`list`, `get`, `search`, `blob/read`) are `read`
   with reach `any`. Every mutation — writes, review, approval, relations and
   task actions — is `settings` with reach `any`.
   *Why not a new `project_write` / `project_review` scope:* `MethodScope` is
   consumed by `Record<MethodScope, string>` in
   `packages/ui/src/runtime/environment-capabilities.ts`, which this task may
   not edit; adding a member there breaks that build. `settings` is the closest
   existing meaning ("configuration that outlives a turn", host-owned, not a
   conversation and not an executable). D-332's requirement that lifecycle
   approval does **not** borrow the session `approval` scope is satisfied:
   nothing here uses `approval`.
   *Follow-up for a task that may touch the UI (M21-T22 is the natural home):*
   add `project_write` and `project_review` to `MethodScope`/`METHOD_SCOPES`,
   add their two sentences to `SCOPE_EXPLANATION`, and move the rows.
2. **Reach.** Every row is `any`. The leap never names a method that the relay
   must not reach; destructive acts are gated by an explicit `confirm` field
   and an audit event instead (leap, "Security, privacy and resource rules").
3. **Bodies are canonical JSON.** A revision body is a closed, validated object;
   its canonical JSON encoding is what the digest covers and what a ranged text
   read pages through. Large, opaque payloads (a Sketch document, a screenshot,
   a source capture) are **not** in the body: they are content-addressed blobs
   referenced by `blobId`, read through `project/work/blob/read`.
4. **Session provenance without session ownership.** No entity and no revision
   has an owner. A revision, comment, approval and evidence record may carry
   `origin: { actor, sessionId? }` as provenance only; a missing session makes
   the link unavailable and changes nothing about the entity (D-329).
5. **Archived is a flag, not a lost state.** Artifact kinds have `archived` in
   their state union, so archiving records `state: "archived"` plus
   `stateBeforeArchive`, and unarchiving restores it. Task states have no
   `archived` member, so an archived Task keeps its task state and carries
   `archivedAt`. Both are reversible and keep every link.
6. **Edge direction.** An edge is `subject —relation→ object`.
   `supports` makes the *subject* the upstream (evidence supports a document);
   `implements`, `depends_on`, `verifies` and `derived_from` make the *object*
   the upstream; `supersedes` is not a staleness edge at all. Staleness flows
   from a materially changed **approved** upstream to reachable dependents,
   only along edges that exist.
7. **Keys.** `<PREFIX>-<n>` with prefixes `SPEC`, `RES`, `DES`, `PLAN`, `TASK`
   (D-355). The key is a projection carried on `ProjectWorkRef` beside the
   opaque ids; identity is always `projectId` + `entityId` + `revisionId`.

### Wire shapes the UI and the tools consume

Every mutation carries `expectedRevisionId` (optimistic concurrency) and
`idempotencyKey`; every mutation result carries the project event `seq`.
A conflict is `ErrorCodes.Conflict` data
`{ conflict: "revision", current: ProjectWorkRef }` — never an overwrite.

| Method | Params (abridged) | Result |
| --- | --- | --- |
| `project/work/list` | `projectId`, `kinds?`, `states?`, `needsYou?`, `hasLinks?`, `updatedSince?`, `sinceSeq?`, `cursor?`, `limit?` | `{ projectId, seq, items, counts, nextCursor?, removed?, reset? }` |
| `project/work/get` | `projectId`, `entityId?` \| `key?`, `revisionId?`, `body?: {mode,offset?,limit?}` | `{ ref, entity, revision, body?, edges, repositoryLinks, executionLinks, comments, approvals, evidence, truncated }` |
| `project/work/search` | `projectId?`, `query`, `kinds?`, `limit?` | `{ results: [{ ref, key, title, kind, state, score, matches }], truncated }` |
| `project/work/blob/read` | `projectId`, `blobId`, `offset?`, `limit?` | `{ blobId, mediaType, digest, totalBytes, offset, bytes, nextOffset?, data(base64), released? }` |
| `project/work/create` | `projectId`, `kind`, `title`, `body`, `idempotencyKey`, `origin?` | `{ ref, entity, revision, seq }` |
| `project/work/revise` | `projectId`, `entityId`, `expectedRevisionId`, `title?`, `body`, `idempotencyKey` | `{ ref, entity, revision, seq }` |
| `project/work/archive` | `projectId`, `entityId`, `expectedRevisionId`, `archived`, `idempotencyKey` | `{ entity, seq }` |
| `project/work/delete` | `projectId`, `entityId`, `expectedRevisionId`, `confirm`, `idempotencyKey` | `{ deleted, orphanedLinks, seq }` |
| `project/work/comment` | `projectId`, `entityId`, `revisionId`, `anchor`, `text`, `blocking?`, `idempotencyKey` | `{ comment, seq }` |
| `project/work/review` | `projectId`, `entityId`, `expectedRevisionId`, `action`, `note?`, `idempotencyKey` | `{ entity, seq }` |
| `project/work/approve` | `projectId`, `entityId`, `expectedRevisionId`, `gate`, `decision`, `covers[]`, `mode?`, `note?`, `idempotencyKey` | `{ approval, entity, seq }` |
| `project/work/resolve-comment` | `projectId`, `commentId`, `resolution`, `idempotencyKey` | `{ comment, seq }` |
| `project/work/link` | `projectId`, `link` (edge \| repository \| evidence \| decision), `idempotencyKey` | `{ link, seq }` |
| `project/work/unlink` | `projectId`, `linkId`, `idempotencyKey` | `{ removed, seq }` |
| `project/task/action` | `projectId`, `entityId`, `expectedRevisionId`, `action`, `evidenceId?`, `idempotencyKey` | `{ entity, transition, seq }` |
| `project/task/link-execution` | `projectId`, `entityId`, `execution`, `idempotencyKey` | `{ link, seq }` |

Notifications: `project/work/updated` (`{ projectId, seq, change }`) and
`project/work/attention` (`{ projectId, seq, needsYou, items }`). Both are
`state` in `NOTIFICATION_PRESSURE` — a client re-reads them with
`project/work/list { sinceSeq }`, but losing one silently would leave the
workspace stale, and the reconcile path is the recovery, not the design.
