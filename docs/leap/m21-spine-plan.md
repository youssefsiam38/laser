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

---

## M21-T2 · Stable project identity and canonical store

### What landed

| File | What it owns |
| --- | --- |
| `packages/host/src/project-work/schema.ts` | opening the database, versioning, atomic migrations, backup-before-migrate, newer-version refusal |
| `packages/host/src/project-work/store.ts` | `ProjectWorkStore`: identity, keys, revisions, review, links, tasks, events, quotas, reads |
| `packages/host/src/project-work/blobs.ts` | content-addressed blobs, chunked above 1 MiB, ranged reads that verify every chunk |
| `packages/host/src/project-work/ids.ts` | opaque id minting, canonical JSON + digest, repository identity key |
| `packages/host/src/project-work/errors.ts` | conflict, quota, not-found, refusal, unavailable — each written for a person |
| `packages/host/test/project-work/*` | store, migrations, crash (a real SIGKILL), bounds |

`server.ts` gained the store's lifecycle only: it is opened at
`<stateDir>/project-work.db` (overridable with `projectWorkFile`) and closed
with the host. Routing is M21-T3.

### Decisions where the contract is silent

1. **One database, partitioned by `projectId` on every row** — not a file per
   project. The leap requires cross-project mention and search; a file per
   project would make that a fan-out over every project a person has opened,
   and would multiply the migration and quota story by N. The rule the leap
   actually states — partition by stable id, never by path — is satisfied by
   the key.
2. **Order is the project event sequence, not a timestamp.** Every entity row
   carries `updated_seq`, set by the same transaction that raised its event, so
   "newest first" is exact even for two writes in the same millisecond.
3. **Backup before *any* migration of a database that already holds tables**,
   including one with `user_version = 0` written by a pre-release. Canonical
   revisions are not reproducible, so the copy is taken before the first
   statement of the first step.
4. **Repository identity is the root commit when git has one, the resolved
   common directory when it does not.** A worktree resolves to its owner's
   common dir before it reaches the store, so it shares the owner's id; a
   relocated checkout keeps its id through the root commit.
5. **Evidence and decisions are links.** The leap's method inventory is closed
   and has no `project/work/evidence`; both records are joined to an exact
   revision, which is what a link is, so they travel through
   `project/work/link` and are removed by `project/work/unlink`.
6. **Archived is reversible and keeps state.** Artifact kinds record
   `state: "archived"` plus `state_before_archive`; a Task keeps its task state
   and carries `archived_at`. Restoring puts the old state back.
7. **A stale upstream does not change a Task's state.** It joins the "needs
   you" queue and `taskFacts` refuses a start or a completion while it lasts —
   a Task has no `stale` state to move to.

### Bounds and budgets

| Limit | Default | Behaviour at the cap |
| --- | --- | --- |
| project bytes | 512 MiB | the durable write is refused with an export/delete recovery; nothing canonical is evicted |
| global bytes | 4 GiB | same, naming another project as the place to free space |
| entities per project | 20 000 | refused with "archive or delete some project work" |
| events retained per project | 5 000 | older events fall off; a client asking from before them gets `reset: true` and a full page |
| blob chunking | above 1 MiB | 256 KiB chunks, each with its own digest |
