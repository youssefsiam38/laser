# M21 spine — protocol, store, host authority (T1 → T4, T15)

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
| M21-T15 Plan DAG and Project Task engine | done | `env -i … pnpm -F @lasercode/host test` (1121; `project-work/task-engine.test.ts` 17), `pnpm -F @lasercode/protocol test` (631) |
| M21-T8 Comments, reviews and approval gates (host half) | done | `env -i … pnpm -F @lasercode/host test` (1139; `project-work/gates.test.ts` 18), `pnpm -F @lasercode/protocol test` (643; `project-work-gates.test.ts` 12) |

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

---

## M21-T3 · Host authority, methods, policy and event stream

### What landed

| File | What it owns |
| --- | --- |
| `packages/host/src/project-work/methods.ts` | `ProjectWorkMethods.handle(request, caller)`: the whole inventory against the store, actor derivation, project resolution, trust, error mapping, audit |
| `packages/host/src/project-work/notifier.ts` | store event → `project/work/updated`, plus the attention diff that decides when `project/work/attention` is worth sending |
| `packages/host/test/project-work/harness.ts` | a Router whose `WorkerPool` throws on `get`/`prepare`/`broadcastRequest` |
| `packages/host/test/project-work/methods.test.ts` | 20 tests: the inventory worker-free, concurrency, idempotency, the event sequence, policy/reach, authorization, audit |

Edits elsewhere: `router.ts` gained `projectWork`/`projectWorkUnavailable` in
`RouterDeps` and a 16-case delegating switch (nothing else); `server.ts` wires
the store's `onEvent` into the notifier and builds the authority with the
project registry's trust and the log store; `access.ts` gained one refusal
sentence. In the protocol: `jsonrpc.ts` gained the two error codes,
`method-policy.ts` the `project_write` scope, `project-work-methods.ts` the
`cwd` alternative on `list`. In the UI, one sentence in the
`Record<MethodScope, string>` of `runtime/environment-capabilities.ts`.

### Decisions

1. **`project_write` is its own scope**, replacing T1's `settings` stopgap.
   An environment may well want a phone that can write and approve project
   work without being able to change how the machine is configured, or the
   reverse; `settings` could express neither. `METHOD_SCOPES` is the default
   for both `local` and `remote`, so nothing a person has configured loses a
   capability by the addition. Reads stay `read`; every row keeps reach `any`.
2. **A client connection is always a `person`; only the worker bridge may be
   an `agent`.** The actor *kind* is decided by the source of the call and
   never read from the request body, so `origin: { actor: { kind: "person" } }`
   sent by a tool changes nothing. That is what makes "only a person approves"
   (D-332) an enforced rule rather than an honour system: the store's
   transition functions already refuse an agent's approval, and this is the
   only place that can tell them who is calling. A client *may* supply the
   label and the session id, which are provenance and confer nothing (D-329).
3. **`project/work/list` accepts `cwd` as an alternative to `projectId`.**
   Everything else takes the opaque id only. The host canonicalises the path,
   maps a worktree to its parent project root, and mints the project id if the
   folder is new — an empty page with a stable id, which is what a session that
   has never opened the workspace needs. No other method accepts a path.
4. **Trust gates mutations, never reads.** A project whose folder a person
   declined refuses every write with `ErrorCodes.ProjectUntrusted` and a
   sentence naming the fix. Reads stay open: the store reads no project file,
   and hiding work the person already wrote would be the worse answer.
5. **Errors are three shapes.** Conflict → `ErrorCodes.ProjectWorkConflict`
   (-32010) with `{ conflict: "revision", current, expectedRevisionId }`;
   quota → `ErrorCodes.ProjectWorkQuota` (-32011) with
   `{ refused: "quota", scope, recovery, usedBytes, limitBytes }`; not-found
   and refusals → `InvalidParams` with the store's person-readable message.
   Both numbers moved into `ErrorCodes`; `PROJECT_WORK_CONFLICT_CODE` and
   `PROJECT_WORK_QUOTA_CODE` are aliases of those members.
6. **Delete without `confirm` writes nothing** and answers with the orphan
   preview, so the typed confirmation has something exact to show.
7. **Attention is diffed, not repeated.** `project/work/updated` goes out per
   event; `project/work/attention` only when the exact count or the exact item
   set changed. A project nothing has been announced for is treated as an
   empty queue, so a draft nobody is waiting on announces nothing.
8. **The audit names decisions, not edits.** Approve, delete and archive write
   a `host` row (`project_work_approved` / `_deleted` / `_archived` /
   `_unarchived`) naming the actor kind and label, the proven actor class and
   id, the project, the key, the exact revision ids and digests — and for an
   approval, every revision it covers as `KEY@revision#digest`. The fields are
   assembled in the handler rather than passed through, so no body, title or
   note can reach the log by accident. A comment or a revision writes no row.

### Wire shapes the UI and the tools consume

- `Router.handle` answers all sixteen methods from the host; the delegation is
  `this.projectWork().handle(req, { actor, source: "client" })`. A host whose
  store could not be opened refuses with `Unsupported` and the reason, and
  never starts a worker to compensate.
- The worker bridge (M21-T17) calls the same `handle` with
  `{ actor, source: "worker", agent: { label, sessionId?, runId? } }` and gets
  identical results, minus what only a person may do.
- `project/work/list { cwd }` → `{ projectId, seq, items, counts, … }`: the
  first call a session makes, and where the workspace learns the project id.
- `project/work/list { sinceSeq }` → the entities touched since that sequence,
  plus `removed[]`, plus `reset: true` when the event window has moved past it.
- Every mutation result carries `seq`; a replayed idempotent call also carries
  `replayed: true`.

---

## M21-T4 · Bounded bodies, search and derived projections

### What landed

| File | What it owns |
| --- | --- |
| `packages/host/src/project-work/store.ts` | projection fence repair before every search, `releaseDerived`, `projectionFence` |
| `packages/host/src/project-work/methods.ts` | the ranged blob answer (base64, `nextOffset`, `released`, corrupt refusal) |
| `packages/host/test/project-work/bodies.test.ts` | 16 tests: ranged bodies and blobs, value-only search, fences, release, quota, containment |

### Decisions

1. **A search repairs before it answers.** Every `search_projection` row names
   the revision it was built from. A row whose fence is behind its entity is
   rebuilt from the canonical body *before* anything is scored, bounded to 200
   rows per call; a row whose entity or revision is gone is deleted rather
   than searched. Text that cannot be fenced to a stored revision is never
   served — which is the rule the leap states, and the reason a migration that
   adds a projected field needs no backfill pass of its own.
2. **The closed projection is the exclusion mechanism, not a scanner.**
   `searchableBodyValues` projects the fields that *say* something — briefs,
   outcomes, requirements, findings, screen and node text, titles. Commands,
   scopes, paths, assignments, source URLs, digests, blob ids and every blob's
   bytes are not in it, so a credential in a command or a secret inside an
   attachment is not searchable and cannot come back in a snippet. No
   credential heuristic runs over a person's own prose: it would be wrong in
   both directions, and the projection already excludes the fields where a
   credential plausibly lands.
3. **Only derived content is ever released.** `releaseDerived` keeps the blob
   row, its size, its media type and its digest, drops the bytes, records
   `{ reason, detail }` and returns the space to the project's budget. A read
   of it answers `{ totalBytes, released }` with no `data` — labelled, never
   empty. Canonical revisions, comments and approvals have no such path: a
   full budget refuses the write instead.
4. **A ranged body page never re-parses.** `mode: "full"` returns the text and
   the parsed body; `mode: "range"` returns a UTF-8 slice cut on a character
   boundary with `totalBytes` and `nextOffset`, and the parsed body only when
   the range happened to cover everything; `mode: "none"` returns no body and
   still names the fence.
5. **Damaged bytes are a refusal.** A blob whose stored chunks no longer match
   their digests is `ErrorCodes.Internal` with what to do, never a plausible
   page of whatever was on disk.

### Wire shapes the UI and the tools consume

| Read | Shape |
| --- | --- |
| `project/work/get { body: { mode: "range", offset, limit } }` | `body: { encoding: "application/json", totalBytes, offset, bytes, nextOffset?, text }` |
| `project/work/get` (any mode) | `fence: { entityId, revisionId, digest, seq }` — what the answer was built from |
| `project/work/blob/read { offset, limit }` | `{ blobId, mediaType, digest, totalBytes, offset, bytes, nextOffset?, data(base64)?, released? }` |
| `project/work/search` | `{ results: [{ ref, key, title, kind, state, score, exactKey, matches }], truncated }`; `matches[].field` is only `key`, `title` or `body` |

Budgets proved over the wire: 400 items page at 50 with no repeat and no row
carrying a body; a ~900 KB body pages in 256 KiB slices that rejoin exactly; a
1.5 MB blob reads in three 512 KiB pages that rehash to its digest; one detail
read inlines at most 100 related records and names what it cut; a search page
is capped and says `truncated`; the attention notification carries at most 50
items while `needsYou` stays exact.

---

## M21-T15 · Plan DAG and Project Task engine

### What landed

| File | What it owns |
| --- | --- |
| `packages/protocol/src/project-work.ts` | `validatePlanGraph` + `planDependencyCycle`/`planCycleMessage`, `PlanGraphReport`, `TaskReadiness`, `TaskConflict`, `overlappingScope`/`scopePathsOverlap`, `StaleUpstreamRef`, the `hasPassingVerification` and `staleUpstream` transition inputs |
| `packages/protocol/src/project-work-bodies.ts` | `ProjectTaskBody.scope.sharedWith` (the explicit shared-checkout acceptance); the plan body's cycle refinement moved out (decision 1) |
| `packages/protocol/src/project-work-methods.ts` | `readiness`/`conflicts`/`planGraph` on `project/work/get`, `planGraph` on a write, `readiness`/`cascaded` on a task action, `attemptEvidence`/`conflicts` on an execution link, and their zod result schemas |
| `packages/host/src/project-work/task-engine.ts` | `TaskEngine`: facts, readiness, the dependency cascade, conflicts, the plan report and a Task's attention reason, all over a `TaskEngineReader` the store implements |
| `packages/host/src/project-work/store.ts` | the reader, plan validation on create/revise, cascade application, the acceptance-evidence rule, the cancellation reason, the attempt evidence, readiness/conflicts/plan graph on every read |
| `packages/host/src/project-work/errors.ts` | `ProjectWorkRefusedError` carries optional typed data (`stale_upstream`) |
| `packages/host/test/project-work/task-engine.test.ts` | 17 tests over the wire through the router harness (zero worker attempts) |
| `packages/protocol/test/project-work-plan-graph.test.ts` | 12 tests: the graph rules, scope overlap, the stale refusals, agent review |

### Decisions

1. **The cycle rule lives in `validatePlanGraph`, not in `planBodySchema`.** One
   pass has to check the cycle *and* every key against the project's own
   entities, and the refusal has to name the keys the cycle goes round (D-355).
   A `superRefine` inside a param schema can do neither: the wire answers
   `invalid params for project/work/create` and puts the detail in `data`. The
   guarantee is unchanged — no cyclic plan can be stored, because the store
   refuses before it writes — and `project-work.test.ts` now pins the layering
   rather than the refinement.
2. **A Plan names Tasks this project already has.** Keys are minted by the
   store, so a key it never minted is a typo, not a forward reference:
   `unknown_task`, and `not_a_task` for a `SPEC-…` in a phase. Both ends of a
   dependency must be listed by the Plan, so a revision that removes a Task and
   leaves a dependency pointing at it is refused (`dependency_outside_plan`).
3. **Dropping a Task from a Plan is recorded, not refused.** A Task whose body
   names this Plan and which the revision no longer lists comes back as
   `planGraph.orphans[]` on the write *and* on every later read of the Plan.
   Refusing would stop a person reshaping a Plan; saying nothing would lose the
   work. (This is the "choose, record" the task allowed — recorded.)
4. **Readiness is derived on every read and cascaded on every dependency
   move.** A dependency reaching `done` moves the Tasks waiting on it from
   `blocked` to `ready`; reopening it puts them back. Only those two states
   move, only as `system` transitions, and each one is checked against the same
   `taskTransition` rules a person's move is. `draft`, `in_progress`,
   `needs_review`, `done` and `cancelled` are never moved by the graph.
5. **A stale upstream refusal names the upstream.** `PLAN-3 changed after this
   task was planned. Reconcile it before starting this task.`, with
   `data: { refused: "stale_upstream", upstream: { entityId, kind, key, revisionId } }`
   so a client can offer the reconcile without reading the graph again. A
   running attempt still reaches `needs_review`; nothing reaches `done`.
6. **A run ending writes evidence and moves nothing.**
   `project/task/link-execution` with `outcome`/`endedAt` records one
   `command_output` evidence row, `role: "supporting"` (`completed` → passed,
   `failed` → failed, `blocked`/`cancelled` → inconclusive) and leaves the Task
   exactly where it was. Acceptance evidence must be `role: "acceptance"` with
   `outcome: "passed"`; linking a failed acceptance is refused with the
   sentence that a failed attempt is evidence, not a failed task.
7. **A cancellation says why, durably.** `cancel` without a note is refused;
   with one it writes a `review`/`deviation`/`inconclusive` evidence record
   `Cancelled: <note>`, so the reason survives the event window rather than
   living only in the change stream.
8. **An agent reports before it asks for review.** `submit_for_review` by an
   agent needs at least one passing evidence record; a person never does.
   Completion is unchanged: no agent, no run and no system trigger reaches
   `done` (only a person, or an explicitly approved completion policy).
9. **Shared-checkout risk is accepted in the body, by a person.**
   `scope.sharedWith: ["TASK-9"]` is the acceptance, recorded in an immutable
   revision that says who wrote it and when; the host refuses an agent's
   revision that *adds* one. There is no new task action, because
   `PROJECT_TASK_ACTIONS` is a closed set where every action maps to a state,
   and accepting a risk changes no state.
10. **Observed scope comes from recorded repository links**, the only place a
    changed path exists today (`target.state.path`, and a change's base/head
    paths). When M21-T18 records changed files per attempt, it feeds the same
    `observed` side of the conflict; nothing else needs to change.

### Wire shapes the Board and the Task detail consume

| Read or write | Shape |
| --- | --- |
| `project/work/get` (task) | `readiness: { ready, unmetDependencies[], stalePausedBy?: { entityId, kind, key, revisionId }, hasAcceptanceEvidence, hasPassingVerification, blockingComments }` |
| `project/work/get` (task) | `conflicts?: [{ entityId, key, title, state, overlap: { packages[], paths[] }, observed, accepted }]` — absent when there are none |
| `project/work/get` (plan) | `planGraph: { ok, problems[], orphans[], order[] }`; `order` is dependency-first and empty for a cyclic graph |
| `project/work/list` (task rows) | `unmetDependencies[]` per row, as before |
| `project/work/create` / `revise` (plan) | `planGraph` on success; a refusal is `InvalidParams` whose message is the problem's own sentence |
| `project/task/action` | `{ entity, transition, seq, readiness, cascaded?: [{ entityId, key, from, to }] }` |
| `project/task/action` refusal | message names the unmet keys (`TASK-7, DES-3 must be done first.`) or the stale upstream; `data` carries `stale_upstream` when that is the reason |
| `project/task/link-execution` | `{ link, entity, seq, attemptEvidence?, conflicts? }` — the Task's state is never changed by it |
| `project/work/attention` | a Task's `reason` is `blocking_comment`, `blocked_task` (state `blocked`), `stale` (a stale Plan or Design upstream) or `gate` |

`PlanGraphProblem.problem` is one of `cycle`, `unknown_task`, `not_a_task`,
`self_dependency`, `dependency_outside_plan`; every one carries `keys[]` and a
sentence written for a person.


---

## M21-T8 · Comments, reviews and the three digest-bound gates

The UI half is in [`m21-workspace-plan.md`](m21-workspace-plan.md) § M21-T8.

### What landed

| File | What it owns |
| --- | --- |
| `packages/host/src/project-work/gates.ts` | `GateEngine` over a `GateReader` the store implements: the three gates' required revisions, the complete digest set, the prerequisites, the blocking-comment refusal, and `check()` — the one place a decision is allowed or refused |
| `packages/host/src/project-work/store.ts` | the gate reader, anchor orphaning on write and on every revision, approval invalidation, the gate check inside `approve`, gate attention, and `gates` on every `get` |
| `packages/protocol/src/project-work.ts` | `GATE_ROLES`/`GATE_PROBLEMS`/`GATE_STATES`, `GateReport` and its parts, `GATE_OUTCOMES` + `gateOutcome` + `gateDecisionAllowed`, `commentThreads`, `openBlockingComments`, `commentResolutionAllowed` |
| `packages/protocol/src/project-work-bodies.ts` | `SpecBody.gated`, `anchorTargets`, `findAnchorTarget`, `anchorResolves`, `describeAnchor` |
| `packages/protocol/src/project-work-methods.ts` | `gates?: GateReport` on `project/work/get`, and `gateReportSchema` |
| `packages/host/test/project-work/gates.test.ts` | 18 tests over the router harness (zero worker attempts) |
| `packages/protocol/test/project-work-gates.test.ts` | 11 tests: anchors, threads, the outcome vocabulary |

`methods.ts` was **not** edited: `store.get` already flows through it, so the
gate report reaches the wire without touching the file M21-T17 owns.

### Decisions where the contract is silent

1. **The gated opt-in is `gated: true` on the Spec body**, not a review action.
   It is part of what a person approved: it travels with the revision, the
   digest, the export and the audit, and a later revision that turned the gates
   off is visible as a change to the bytes. A new member of the closed
   `PROJECT_WORK_REVIEW_ACTIONS` set would have been invisible in all four.
2. **Each gate is decided on its own subject**: brief on the Spec, design on
   the linked Design (or on the Spec when the gate is skipped with a recorded
   reason), build on the linked Plan. The subject is where the state moves and
   what the fence is taken against; the *report* is always the Spec's, so the
   card reads the same from any of the three.
3. **The build gate covers Spec + Design + Plan, and binds the task graph
   through the Plan's digest.** The Plan body enumerates the task keys and
   their dependencies, so approving the Plan's exact digest approves the exact
   graph; `planGraph.ok` and "at least one task" are requirements rather than
   64 more covered revisions.
4. **Off the gated path an approval is still a record, but no gate binds it.**
   A Spec nobody put on the gated path (and anything not linked to one) keeps
   the spine's rules — person-only, no blocking comment open, every covered
   digest exactly what the store holds — and gains no requirements,
   prerequisites or mode obligation. "Gates only when chosen" (D-352) is
   enforced by refusing to *impose* a gate, not by refusing the record.
5. **A draft is not up for decision.** `ARTIFACT_EDGES` has no
   `draft → approved`, so a gated draft's gate is `waiting` with
   "…has not been sent for review yet", and `project/work/review
   request_review` is the small deliberate act that opens it.
6. **A comment is never refused for its anchor.** An anchor that does not
   resolve in the current revision is stored `orphaned`, and every revision
   re-decides every comment's orphaned flag in the same transaction — a lost
   target never loses the comment, and a target that comes back un-orphans it.
   A text range is fenced by the sha256 of the exact slice, so an edit inside
   the quoted words orphans rather than silently re-pointing.
7. **Invalidation is "covers it, or `propagateStale` reaches it".** A revision
   whose digest actually changed invalidates every non-invalidated approval
   that covers the changed entity, plus the approvals of the artifacts the
   change made stale — the reachable downstream and nothing else. Identical
   bytes invalidate nothing.
8. **A change request is a record, not an edit.** `changes_requested` writes
   the approval with its note and returns the subject to `draft`; the revision
   it was taken against is untouched and still current, which is the leap's
   "never edits the approved bytes" made structural.
9. **Blocking comments are collected across everything a gate covers**, not
   only the subject, and the refusal names them as `KEY commentId` so a person
   can go straight to them.
10. **Gate attention is bounded.** After a comment, a resolution, an approval
    or a revision, only the Spec and its linked Design and Plan are
    recomputed — never a walk of the project. A gate that is `ready` or
    `invalidated`, or anything with an open blocking comment, is what joins the
    queue; a `waiting` gate waits on the work, not on a person.

### Wire shapes the workspace consumes

| Read or write | Shape |
| --- | --- |
| `project/work/get` (spec, design, plan) | `gates: { specEntityId, specKey, gated, next?, gates: [{ gate, state, subject?, requirements[], covers[], outcomes[], blockingComments[], approval?, refusal? }] }` |
| `project/work/get` (any) | `comments[].orphaned` is the anchor's current truth, recomputed on every revision |
| `project/work/approve` | refusals: the wrong subject, an outcome the gate does not have, a build approval with no mode, a missing or moved covered revision, an unmet requirement, an open blocking comment (named), an agent |
| `project/work/attention` | `gate` for a ready or invalidated gate, `blocking_comment` while one is open |

---

## M21-T21 · Import, export and repository publication

Six methods beside the spine's sixteen, in their own protocol module and their
own host modules, so nothing about the canonical store changed to make them
possible.

### What landed

| File | What it owns |
| --- | --- |
| `packages/protocol/src/project-work-interop.ts` | the six methods' params/results and strict schemas, the adapter and mode vocabularies, the bounds, and `projectWorkManifestSchema` |
| `packages/host/src/project-work/export/paths.ts` | project-relative containment, the bounded walk, the atomic write |
| `packages/host/src/project-work/export/markdown.ts` | deterministic Markdown per kind, front matter, links section |
| `packages/host/src/project-work/export/manifest.ts` | the manifest, its attachment enumeration and its canonical bytes |
| `packages/host/src/project-work/export/index.ts` | `ProjectWorkExport`: compute, preview, apply, existing-export detection, stale removal, `-2` revision roots |
| `packages/host/src/project-work/import/text.ts` | front matter, sections, bullets, checklists, tables, licence reading |
| `packages/host/src/project-work/import/adapters.ts` | the five adapters and their proposals |
| `packages/host/src/project-work/import/index.ts` | `ProjectWorkImport`: matching, conflicts, preview digest, apply, provenance records, relation recreation |
| `packages/host/src/project-work/publish/git.ts` | read-only git: repository identity, object format, `ls-tree`, git blob ids |
| `packages/host/src/project-work/publish/index.ts` | `ProjectWorkPublish`: the plan, the commit hand-off, `published_as` per item |
| `packages/host/test/project-work/interop.test.ts` | 19 tests over the router harness, with real temporary git repositories |
| `packages/protocol/test/project-work-interop.test.ts` | 13 tests: inventory, policy, closed schemas, the manifest |
| `packages/ui/src/components/project-work/ImportExport*` | the header menu and the three previewed dialogs |

Registration edits only, elsewhere: `messages.ts`, `schemas.ts`,
`method-policy.ts`, `index.ts` (protocol); six delegating cases in
`project-work/methods.ts` and six more `case` lines in `router.ts`;
`ImportExportMenu` mounted in `Workspace.tsx`; the six store methods in
`packages/ui/src/project-work/store.ts`.

### Decisions where the contract is silent

1. **A separate method family, not an extension of the spine's sixteen.** The
   leap's inventory is closed and `project-work-methods.test.ts` pins it
   exactly; interop is a different concern with a different scope story. So
   `projectWorkInteropParamsSchemas` is its own table, its own limits and its
   own test, and the spine's inventory test still passes untouched.
2. **All six are `project_write`, previews included.** A preview here reads or
   writes the *project's own files* — the tree an adapter parses, the export
   root, the repository it would be published into — which is authority over
   the project rather than the `read` of the product's own state the spine's
   four reads are. Reach stays `any`; every write is gated by `confirm` plus
   the digest of the preview it was decided from.
3. **Publication never commits.** M20's git actions live in the worker, and a
   project-work method may not start one (D-331). So `publish/preview` hands
   back the exact `pi/project/git/commit` request to run — with its own
   preview and typed confirmation — and `publish/apply` takes the commit that
   resulted and *proves* it: one `ls-tree` at that commit, and every exported
   document's git blob id computed locally from the bytes. Git is read
   read-only from the host, which is what "the exact committed state is known"
   requires; nothing here writes to a repository.
4. **`published_as` is per item, not per export.** The relation joins one
   revision to one state and one path, so each exported document gets its own
   link carrying its own `publishedPath`, `blobObjectId` and `contentDigest`.
   The commit is shared; the path is not. A new publication carries
   `supersedesLinkId` of the previous one, which is kept.
5. **An uncommitted publication needs a checkpoint.** Without one, an apply
   whose commit does not carry the exported bytes is refused by name. With
   one, the state records the checkpoint and the content digest and *no* blob
   id — nothing is invented for bytes git does not hold.
6. **The export writes the exact body beside the document.** Markdown is a
   deliberately lossy view of a closed body, so `bodies/<KEY>.json` carries the
   canonical bytes the digest covers and the `work_export` adapter reads those,
   digest-checked. That is what makes export → import → export byte-identical
   for every kind rather than for the three flat ones.
7. **No timestamps anywhere in an export.** Not in a document, not in the
   manifest. A clock would make every export differ, and a re-export would stop
   being a diff a person can read. Identity that *is* time-like — created,
   updated — stays in the store, which stays the authority.
8. **Attachment bytes stay in the store.** The manifest references every blob
   (id, media type, size, digest) and copies none: a sketch is megabytes, and
   an export is a document set.
9. **Re-export is `replace` or `new_revision`, with no default.** An apply over
   an existing export with no mode is refused naming both. `replace` deletes
   only files the *previous manifest* listed — never a file a person put in
   that folder. `new_revision` writes to the first free `<root>-<n>`.
10. **Provenance is an evidence record, not an edge.** `derived_from` joins two
    artifacts; a source file is not one. Each imported revision carries the
    note `Imported from <path> (<adapter>)` and a `source_location` evidence
    record with the path, the sha256 of the bytes read, the adapter and the
    licence the source declared — or "not declared by the source", which is a
    fact rather than a guess.
11. **An import writes item by item.** One proposal the store refuses is
    recorded as skipped with the store's own sentence and the rest still land;
    per-write idempotency keys are derived from the caller's one, so a retry
    converges rather than duplicating.
12. **Only `work_export` recreates relations.** They were real facts recorded
    in a manifest. No other adapter invents a link: another tool's ids are not
    keys this project minted, and `plan_md` keeps a row's declared dependencies
    as a note on the Task instead.
13. **There is no host-side project-config writer to borrow** (`.laser` is
    written by the worker's settings and design modules, and this may not start
    a worker), so `export/paths.ts` is the writer: contained to the project,
    atomic temp-then-rename, `0o600`, and no symlink is followed by the walk.
14. **`ExternalWorkLink` is M25's slot.** `WORK_IMPORT_ADAPTERS` deliberately
    has no tracker member, and a test pins that: a Jira link is an explicit,
    previewed, never-syncing record of an exported revision, not a file an
    adapter parses.

### Wire shapes the workspace consumes

| Method | Shape (abridged) |
| --- | --- |
| `project/work/import/preview` | `{ adapter, root, previewDigest, proposals[], creates, conflicts, skipped[], truncated?, watches: false }` |
| `project/work/import/apply` | `{ applied[], created, revised, skipped, relations, seq, watches: false }` |
| `project/work/export/preview` | `{ root, previewDigest, files[], entities, attachments, totalBytes, mode, existing?, removes[], decide? }` |
| `project/work/export/apply` | `{ root, mode, files[], removed[], manifestDigest, entities, attachments, totalBytes, seq }` |
| `project/work/publish/preview` | `{ root, previewDigest, repository?, files[], uncommitted[], entities[], commit?, ready, refusal? }` |
| `project/work/publish/apply` | `{ root, repositoryId, commitObjectId, objectFormat, state, published[], seq }` |

A proposal carries `source { adapter, path, digest, licence?, licenceName?,
externalId? }`, and a conflicting one carries `match` plus
`conflict { reason, choices }`; the apply's `decisions[]` answers them.

Audit rows: `project_work_imported`, `project_work_exported`,
`project_work_published` — identity, paths, digests and counts only, never a
title or a body.
