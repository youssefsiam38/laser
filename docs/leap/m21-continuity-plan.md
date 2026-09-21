# M21-T20 — cross-session continuity and recovery

The plan for the continuity task, written before the code. Acceptance
(`PLAN.md` M21-T20): create in one session, revise in another, execute in a
third, resume after restart/retirement, archive/delete sessions, relocate the
project and remove a worktree with entity and repository-link identity intact.

Contract read first: `docs/project-lifecycle-leap.md` — "Relationship graph"
(*"Deleting or archiving a session retains its references and execution history
as unavailable links. Removing a project hides its work but retains it until an
explicit Delete project work confirmation. Reattaching or relocating the project
reconnects the stable `projectId`; a path match alone never merges two project
histories."*), "Canonical persistence" (D-331), "Repository provenance" (D-345),
"Flexibility" (D-352), plus AGENTS.md invariant 6 (project configuration lives
in `<project>/.laser`, never `.pi`) and D-365 (every canonical row charged).

## 1. Inventory: every T20 flow against the code as it stands

| # | Flow | Where it lives today | State |
| --- | --- | --- | --- |
| 1 | Create in session A | `store.create` records `origin.sessionId`; no owning session anywhere in the schema | **works** |
| 2 | Revise in session B | `store.revise` + `expectedRevisionId`; revision rows keep each origin | **works** |
| 3 | Execute in session C | `project/task/link-execution` → `execution_links`, attempt records from git (`delivery.ts`) | **works** |
| 4 | Host restart | `openProjectWorkDatabase` + migrations; `crash.test.ts` covers a torn write | **works, unproven for T20's three-session story** |
| 5 | Worker retirement | worker holds no project state; verification runs are worker-local, the report is a store blob | **works, unproven** |
| 6 | Session deleted | `pi/session/delete` unlinks the file, drops checkpoints and run rows. It never touches project work — but it also never marks the execution links, so `execution_links.target_unavailable` (column, protocol field, UI copy, worker packet sentence) is **dead**: nothing ever sets it | **gap A** |
| 7 | Session archived | archive is device-local (`laser-archived` in the UI, `page.exclude` on `pi/session/list`); the host has no archive | **works by construction; needs a regression fence** |
| 8 | Project removed | `pi/project/remove` → `ProjectRegistry.remove` only. `store.removeProject`/`isRemoved` have **no caller**; nothing hides the work, nothing restores it on re-add | **gap B** |
| 9 | Project relocated | identity is path-only: `store.projectIdFor(root)` mints a **new** id for a moved folder. `store.relinkProject` exists with no caller and no protocol method | **gap C** |
| 10 | Worktree | `projectRootOf` maps `<project>/.worktrees/x` to the project; `repositoryIdentityKey` is the root commit, so a worktree shares its owner's repository id | **works, unproven for removal** |
| 11 | Delete project work | `project/work/delete` (entity) and `store.deleteProjectWork` (whole project, no caller yet) | entity works; project-level delete stays out of scope for T20 beyond the retained-until-delete sentence |

Everything the parent flagged is confirmed. Two further findings:

- **`isRemoved` is never read**, so wiring `removeProject` alone would hide
  nothing; `project/work/list` must answer the removed state, and re-adding a
  project must clear it.
- **`target_unavailable` has consumers already** (UI `TaskDetail` — "no longer
  on this device" vs "not in this device's list"; `task-model.attemptsOf`;
  worker `context-packet`), which is why gap A is a host-side write only: no
  new vocabulary is needed downstream.

## 2. What gets built

### A. Session delete marks, never cascades

- `store.markExecutionTargetsUnavailable(projectId, targetIds)` — one
  transaction, `UPDATE execution_links SET target_unavailable = 1`, each touched
  row re-charged through `chargeRow` (D-365), an event per affected entity so a
  live workspace re-reads.
- `ProjectWorkMethods.sessionDeleted({ cwd, sessionId, runIds })` — host-only
  entry point (not a protocol method): resolves the project for the session's
  cwd *without minting* (`create: false`), marks the session id and every run id
  owned by it. Never deletes a row.
- `Router` calls it from `pi/session/delete` after the transcript is unlinked.
- Fence tests: revisions, evidence, repository links, approvals and the
  execution rows all still readable after the delete; only the flag moved.
- Archive: a device-local hide stays device-local — a test asserts the host
  has no archive path and the links keep `targetUnavailable` unset.

### B. Removing a project hides its work; it is retained until an explicit delete

- `ProjectWorkMethods.projectRemoved(cwd)` / `projectRestored(cwd)`, wired to
  `pi/project/remove` and `pi/project/add`.
- `store.restoreProject(projectId)` clears `removed_at` (relink already does).
- `project/work/list` reports `removed: true` for a hidden project instead of
  pretending it is empty, so the workspace can say the retained-until-delete
  sentence rather than showing a lying empty state.

### C. Relocation reconnects the stable id, and never merges two histories

**The marker.** `<project>/.laser/project.json`:

```json
{ "version": 1, "projectId": "prj_…" }
```

- Written when the store first mints an id for a path, best effort: an
  unwritable folder is not an error and absence is always tolerated.
- Not in `TRUST_REQUIRING` (`settings.json`, `worktree-setup`, `agents`), so
  writing it never turns an ordinary folder into a trust prompt.
- `.laser`, never `.pi` (invariant 6). Host-owned, like
  `writeProjectCheckpointRetention`.

**Resolution rules** (`project-work/identity.ts`, used by both places that
resolve a project: `resolveProject` for clients and `projectOf` for the worker
bridge):

| Situation | Answer |
| --- | --- |
| path already has a `project_paths` row | that id; write the marker if it is missing |
| no row, no marker | mint (today's behaviour); write the marker |
| no row, marker names an **unknown** id that parses as an opaque id | adopt it as this store's id for the folder — the file is not rewritten, so the same folder keeps one identity across installs and machines |
| no row, marker names a **known** id whose current path no longer exists | reconnect: `relinkProject`, silently — this is the relocation case |
| no row, marker names a **known** id whose current path still exists | **conflict**: mint a fresh id so the app keeps working, and offer the person the previewed choice |
| marker names a known id whose current path *is* another live folder, and this folder already has work of its own | refuse to reconnect: two histories never merge |

Adopting an unknown marker id is the one deviation from "the store mints": the
id stays opaque, the store still owns the row, and the alternative (rewriting
another install's marker) both churns a file inside the repository and loses
the only thing that makes a later relocation reconnectable. Recorded here and
in the code.

**Protocol** (`packages/protocol/src/project-work-continuity.ts`, ACP-shaped,
host-answered, in `METHOD_POLICY`, `clientParamsSchemas`, the limits table and
the sample table):

- `project/work/relink/preview { cwd }` → the folder's current project, the
  marked project, whether a choice exists, what each choice does, counts for
  both sides, and a `previewDigest`. Scope `read`.
- `project/work/relink/apply { cwd, projectId, previewDigest, confirm: true,
  idempotencyKey }` → performs the reconnect. Scope `project_write`. A stale
  digest, a marker that changed underneath, or a folder whose current project
  already holds work is refused with what to do instead.

**UI**: the workspace shows a reconnect notice when the preview offers a
choice — "Reconnect here" / "Start fresh", honest copy naming both folders,
token-only visuals, keyboard reachable, no new colour.

### D. Restart / retirement / worktree proofs

`packages/host/test/project-work/continuity.test.ts`, on real git fixtures:

1. Spec created in session A, revised in session B, Task executed in session C
   with a real checkpoint; the store is closed and reopened over the same file
   (a restarted host) and every id, revision, digest, origin, execution link and
   repository link reads back identically.
2. A second worker (new bridge caller, new run id) continues the same Task: the
   attempt history is additive, nothing is retargeted, the ephemeral
   verification run is gone while the stored report blob and its evidence are
   intact.
3. The project folder is moved; the marker reconnects the same `projectId`;
   every entity key, revision digest and repository link commit id is unchanged.
4. A copied folder with the same marker does **not** merge: the preview offers
   the choice, and an unconfirmed read keeps the two histories apart.
5. A linked worktree resolves to the owner project; after `git worktree remove`,
   every repository link still names the same commit ids and the same
   `repositoryId`, and nothing retargets to `HEAD`.
6. Session delete marks the links unavailable and deletes no project row.

Protocol tests cover the two new methods (schema, policy, limit, sample,
confirm/digest fences). UI tests cover the relink notice model. Worker tests
cover any surface touched (expected: none beyond reading the existing field).

## 3. Constraints honoured

No Pi imports above the worker, nothing above the worker reads `.pi`, no Pi
vocabulary in copy, tokens only in the UI, every canonical row charged
(`chargeRow`, including the `project_paths` row a relink writes), no SDK /
Legend / lockfile / interop changes, no browser (D-342).

## 4. Validation

Frozen install, `pnpm -r build`, then
`pnpm -F @lasercode/host exec vitest run test/project-work test/router*.test.ts
test/session-move.test.ts`, the protocol suite, `@lasercode/worker
test/project-work`, `@lasercode/ui test/project-work`, typecheck of the touched
packages and `pnpm identity:check`. Red-before-fix is recorded per gap.
