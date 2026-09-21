# M21-T10/T13 review — every index build is a visible, session-owned Command

Single independent review of the full ownership branch
`agents/finish-index-lifecycle-corrections-ecf555b3` @ `3ef60030`
(= `89dff93b` original, merged `6e61180b`, plus `fa6682db` and `8e34a25f`
settlement/owner-resolution corrections). Reviewed in an isolated worktree that
merged the whole target before any test ran; the reviewed tree differs from
`3ef60030` in nothing but the two planning files the parent carried forward.

**Verdict: approve.** No structural regression, no missed structural
simplification of the kind this review looks for, no spaghetti growth. The
correction round did what the parent's gap report asked: one admission,
an owner that is an argument rather than a mutable field, a required
`sessionPath` on the wire, retention bounded at settlement, terminal rows
written from the outcome instead of from a phase, and a fail-closed UI owner
resolution. Two low-severity findings below are follow-ups, not blockers.

## What the change is, and why it is the right shape

`docs/design-phase.md` ("Re-index", line 107) and
`docs/project-lifecycle-leap.md` ("index builds are bounded fleet Commands the
person can stop", line 723) make an unwatched build a contract violation, not a
missing row. The branch makes that rule a type fact instead of a discipline:

- **One admission.** `DesignWorkspace.startBuild`
  (`packages/worker/src/design/workspace.ts:260`) is the only way a build
  starts; both faces reach it — the person through `design/index/build`
  (`workspace.ts:245`) and the model through a per-session `DesignIndexBridge`
  built in `server.ts:2334` (`designSurface(live)`), which reads the live
  conversation's path at invocation and refuses (fail-closed, empty path →
  `no_owning_session`) when the record has not landed. `ProjectDesignIndex` is
  deliberately no longer a `DesignIndexBridge` (`bridge.ts:80`): it cannot know
  an owner, so it cannot start a build.
- **The owner is immutable state.** `startingFor` is gone; `DesignBuildOwner`
  rides in `ProjectDesignIndex.startBuild` → `onCommand` → `HeldBuild` →
  `Tracked.sessionPath`, all final. Two concurrent builds cannot take each
  other's row (`workspace.test.ts`, "keeps each session's own build when two
  start at once").
- **Admission is "this worker holds the session"**
  (`holdsSession = runtimes.has(path)`, `server.ts:2279`), checked before the
  engine is asked for anything. Because `session/new` refuses another directory
  (`server.ts:1712`), `session/load` opens with the worker's own `cwd`
  (`server.ts:1782`), and children open in this project's worktrees, holding
  *is* belonging — the branch proves the refusal from the real admission
  (`index-command-owner.test.ts`, "cannot be owned by another project's
  conversation").
- **Settlement is ordered, once.** `ProjectDesignIndex` announces
  `onSettled(command, owner, outcome)` from its own first `done` handler
  (`bridge.ts:157`), *then* sweeps; the workspace publishes the terminal row
  and prunes inside that call (`workspace.ts:203`). `isRunning` is
  `settled === undefined` (`workspace.ts:427`), so a terminal-looking phase can
  no longer make a row say `completed` about a build that is about to fail —
  proved against the real engine by making the index file's own path a
  directory (`workspace.test.ts`, "never says a failing build completed").
- **The bound holds at settlement, not at the next start** (`bridge.ts:67`,
  `FINISHED_COMMANDS_KEPT = 8`; sweep in `release()`, `bridge.ts:213`): twelve
  builds that all end with nothing after them leave eight closures, a running
  build is never counted or released, and the last row is published while the
  build is still held (`workspace.test.ts`, "bounds what it holds when a burst
  of builds all end and none follows").
- **Collision-proof ids**: a process counter joins the clock in
  `command.ts:245`, so two builds in one millisecond are no longer one row.
- **Fleet, pin, stop, delete** come from existing rules, not new ones:
  `publishTask` now also folds the row into the worker's own `TaskIndex`
  (`server.ts:2268`), `runningTasks` pins the session (`session-safety.ts:100`),
  `pi/session/unload` refuses while it runs, `pi/session/delete` refuses while
  the pool holds the session (`host/router.ts:602`), and `pi/task/stop` answers
  `design-index-*` ids before any session lookup (`server.ts:1068`), which the
  host reaches through `workerFor` (`host/router.ts:1103`) — proved by stopping
  a build on a path the worker never opened.
- **The window cannot lend eligibility.** `useDesignBuildOwner`
  (`packages/ui/src/components/design/build-owner.ts`) resolves the current
  conversation's directory keyed by both `cwd` and `forProjectId`; an
  unresolved directory is refused rather than inheriting the previous
  conversation's answer, and `useDesignAccess` sends nothing without an owner
  — the panel shows the sentence where the button was, with "Back to the
  conversation". The provider requirement is not new: `useCapability` already
  demanded it.

## Validation, reproduced in this worktree

Frozen install, clean recursive build, then the focused commands
(`env -i PATH="$PATH" HOME="$HOME"`):

| Command | Result |
| --- | --- |
| `pnpm -F @lasercode/worker exec vitest run test/design` | **228 passed** (matches claim) |
| `pnpm -F @lasercode/worker exec vitest run` (isolated) | **1657 passed, 4 skipped** (matches claim) |
| `pnpm -F @lasercode/ui exec vitest run test/design` | **122 passed** (matches claim) |
| `pnpm -F @lasercode/ui exec vitest run test/fleet test/design test/runtime` | **1146 passed** (matches claim) |
| `pnpm -F @lasercode/host exec vitest run test/router.design.test.ts` | **6 passed** (matches claim) |
| `pnpm -F @lasercode/protocol exec vitest run` | **729 passed** (matches claim) |
| `pnpm -r build`, worker + UI `typecheck`, `pnpm identity:check` | clean |

Environment note: the first full worker run in this worktree (fired while the
machine still had residual load from the build) failed 6 tests across 4 files;
the isolated rerun was fully green with the claimed counts. Consistent with the
branch's own note about load-sensitive suites — run full suites isolated.

## Findings

### F1 · low — a swallowed settlement failure loses the terminal row without a word

`packages/worker/src/design/index/bridge.ts:189-197`. If `onSettled` throws,
the `catch` is empty and the comment says the observer's lost row is "its own
problem to report" — but nothing reports anything, and the terminal row is
never published. I traced the real publication path rather than assuming the
comment: `publishTask` is `TaskIndex.observe` (pure map operations, cannot
throw) followed by `notify` → `send` → `transport.write`
(`worker/src/main.ts:162`), which returns silently on a dead link instead of
throwing, so an exception here is unlikely. But when a row *is* lost this way
the consequence is concrete: the TaskIndex row stays `running`, so
`runningTasks > 0` keeps the session pinned after the build is over
(`design/index/get` says finished; the fleet says running), until the session
closes — and the only self-heal is a person pressing Stop on the stale row,
which republishes the settled row. Suggested follow-up, behavior-preserving:
log the swallowed error (the worker's stderr channel) and/or re-mark the held
row for republication on the next observe, so a real settlement bug cannot
become an invisible one. Not a blocker: the ordering this protects is proved,
and the exception path is defensive.

### F2 · low, pre-existing shape — a fork that moves the session's file unpins a running build

`TaskIndex.rekeySession` (`agents/tasks.ts:101`) moves a session's rows to the
new path when a fork moves the file, but `Tracked.sessionPath` and the fleet
row were fixed at admission, so `DesignWorkspace` keeps publishing to the old
path; the running row lands under a path that is no longer a live runtime, the
`runningTasks` pin no longer applies to the moved conversation, and a build can
outlive an unload it was supposed to prevent. This predates the branch (the
old code bound the row's session at start too); the new admission story makes
the hole worth one deliberate decision rather than an accident. Suggested
follow-up: let `rekeySession` notify the design workspace, or read the live
path at publish time. Not introduced here; no correction required for this
milestone.

### F3 · nit — `failureSentence` truncation can cut a sentence mid-word

`packages/worker/src/design/workspace.ts:135` — `.slice(0, 500)` may end
mid-word; harmless for a fleet row, worth a word-boundary trim if touched
again.

## Non-findings checked explicitly

- Resolved `done` results never carry a `failed` phase (`command.ts:211`
  reports `stopped`/`done`; failure rejects `done`), so the
  `stopped === true || phase === "stopped"` rule at `workspace.ts:227` cannot
  mislabel a completed build.
- `DesignBuildRefused` on the model path survives `asToolFailure`
  (`tools.ts:90`), which keeps `code`/`message`/`next` — the model gets a real
  refusal, not a generic failure.
- `useDesignBuildOwner`'s provider requirement is unchanged
  (`useCapability`/`useLaserStable` already threw outside a provider); the test
  harness `LaserStoreProvider` wraps are wiring, not a new coupling.
- The wire change (required `sessionPath`) is same-generation, per invariant
  10: host, worker and UI ship together; `host/router.design` 6 pass.
- All `startBuild` call sites were enumerated: worker admission paths only,
  plus the scripted evaluation world, which supplies its own fixture owner
  rather than asking the engine for an exception.
- File sizes: `workspace.ts` 537, `bridge.ts` 264, `tools.ts` 669;
  `server.ts` is pre-existing sprawl and this change added ~110 well-fenced
  lines to it. No file crossed 1k because of this branch.

## Not covered here

- Visual acceptance is the person's (D-342): the Design tab with and without an
  eligible conversation, both themes, both widths, and the fleet row while
  running and after Stop. `pnpm -r build && pnpm sandbox`.
- Host suites that spawn workers were not run (they fail in any fresh worktree
  on launch identity; `test/router.design.test.ts` passes) — same limitation
  the branch recorded.
- The fork/rekey hole (F2) has no test either way; it is a shape observation,
  not a proven defect.

## Bookkeeping for the parent

- Reviewed tree: `agents/review-owned-index-commands-5befb651` @ merge commit
  `c065bea7` (= `f1286987` ⊕ `3ef60030`); the merge carried the parent's newer
  `STATUS.md`/`STATUS_DETAILED.md` rows over the branch's older ones, so
  `STATUS.md` will need regenerating after integration as usual.
- The only new file in this worktree is this review document; no source,
  test or planning file was changed.
