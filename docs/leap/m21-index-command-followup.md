# M21-T10/T13 follow-up — every index build is a visible, session-owned Command

Root contract: `docs/design-phase.md` ("Re-index", "Security", "What a person
sees") and `docs/project-lifecycle-leap.md` ("Outside the workspace → Fleet";
"index builds are bounded fleet Commands the person can stop"). A build that
runs where nobody can see or stop it is a contract violation. The integration
review's non-finding — "a build nobody started from a session takes no row, as
decided" — is superseded by that contract: there is no such build any more.

## The gap, as it was on `224af3a2`

| Path | What happened |
| --- | --- |
| model | `ProjectWorkSession.designTools()` bound `build_design_index` straight to the project's `ProjectDesignIndex`. The build started, `onCommand` reached `DesignWorkspace.observeCommand`, `startingFor` was `undefined`, and `publish()` returned before publishing anything. The model got a command id for work no one could see or stop. |
| person | `design/index/build.sessionPath` was optional and `useDesignAccess` never sent one, so every Re-index from the Design tab was invisible too. |
| carrier | `startingFor` was a mutable field written by `build()` and read by `observeCommand()` — correct only because the path between them happened to be synchronous, and bypassed entirely by anything that called the engine directly. |
| bound | `ProjectDesignIndex.builds` was never pruned: one command object, and the closure over its whole build, per build, for the life of the worker. |

## What it is now — one admission, one immutable owner

`DesignWorkspace.startBuild` is the **only** way a build starts in a worker.
Both faces reach it, and the owner is decided there, before the engine is asked
for anything:

```text
person  →  design/index/build ─┐
                               ├─► DesignWorkspace.startBuild({ sessionPath, … })
model   →  build_design_index ─┘        ownerOf(): this worker holds it?
           (session-bound bridge;              │      no → refused, nothing read
            path read at invocation)           ▼
                               ProjectDesignIndex.startBuild({ …, owner })
                                       onCommand(command, owner)
                                               ▼
                               observeCommand(command, owner) → fleet row,
                               published before the first file is opened
```

- **The owner is an argument.** `startingFor` is gone; `Tracked.sessionPath` and
  `DesignIndexCommand.sessionPath` are required. Two sessions building at once
  cannot take each other's command (`workspace.test.ts`, "keeps each session's
  own build when two start at once").
- **The model binds the live session at invocation.** `server.designSurface(live)`
  gives each session a `DesignIndexBridge` whose `startBuild` reads that
  conversation's path when the tool is called, and goes through the same
  admission. `ProjectDesignIndex` is deliberately no longer a `DesignIndexBridge`:
  it cannot know an owner, so it cannot be one.
- **Refusals happen before work.** No session, or a session this worker does not
  hold: `DesignBuildRefused` with a sentence and a next step — a `ProtocolError`
  for the window, an ordinary tool refusal for the model through the design
  tools' existing `asToolFailure`. Nothing is written and no cache is cleared.
- **The wire says it too.** `sessionPath` is required on `design/index/build`
  and on `DesignIndexCommand`; same-generation change, no fallback.
- **Command ids are unique per build.** They were `sha256(cwd, appRoot, ms)`, so
  two builds in the same millisecond were one row; a process counter is now part
  of the id.

### Eligibility: "held by this worker" *is* "belongs to this project"

The admission asks one question — does this worker hold that conversation open?
It needs no project comparison because a worker can only ever hold its own
project's sessions:

| Way in | Rule |
| --- | --- |
| `session/new` | refuses any directory but the worker's own (`server.ts:1712`) |
| `session/load` | opens with `cwd: this.options.cwd` (`server.ts:1782`) |
| `openChild` | the harness opens a child in a worktree of this project (invariant 5) |

A child agent's session has its own `cwd` and is eligible — it is the same
project's work — which is why the check is holding, not a path comparison
(`workspace.test.ts`, "lets a child agent's worktree session own a build").
`index-command-owner.test.ts` proves the invariant from the real admission: a
`session/new` for another directory is refused with "this worker serves …".

### Lifetime: released, closed, deleted

An index build's row now goes through the worker's own `TaskIndex` as well as
to the host — it is a Command of that session like any other. Three
consequences, all from rules that already existed:

1. **`inspect_fleet` sees it**, as `docs/design-phase.md` says a fleet Command
   should be seen.
2. **Its conversation is pinned while it runs** (`session-safety.ts`,
   `runningTasks` → a `task` pin), so `pi/session/unload` refuses to release it
   — proved in `index-command-owner.test.ts`.
3. **It therefore cannot be deleted underneath its build**: `pi/session/delete`
   refuses while the session is open in the pool (`router.ts:602`), and the
   session cannot leave the pool while the build pins it. No separate lifecycle
   change is needed for deletion.

If a runtime does go away anyway (a worker that dies takes its build with it;
`TaskRegister.workerLost` ends the rows), the owner is never reassigned. A
**Stop** still reaches a build whose conversation has no live runtime: the
worker answers `pi/task/stop` for a `design-index-*` id **before** it looks up
any session (`server.ts:1067`), and the host reloads the session on the way in
(`workerFor`). Proved by stopping a build through a path this worker has never
opened (`index-command-owner.test.ts`).

No orphan drop in the fleet: the host register keys rows by session path and
only ends them when the worker is lost, and the UI's fleet model renders a root
the catalog no longer lists as deleted-session work rather than dropping its
rows (`packages/ui/src/fleet/model.ts`, `deleted`).

### Settlement: how a build ends, in one place and in one order

Ending a build touches three things — the last row, the retention and the
outcome the window reads — and all three now happen in one ordered step.

`ProjectDesignIndex` learns that a build has ended (its `command.done`
settles), announces **how** it ended through `onSettled(command, owner,
outcome)`, and only then sweeps its map. The workspace is that observer: it
writes the outcome onto the tracked build, publishes the terminal row, and
prunes its own rows. Nothing else attaches to `command.done`, because handler
order is registration order and the index registers first — a second handler in
the workspace would have been a race between the row and the release.

Three corrections come out of that one ordering:

| Was | Is |
| --- | --- |
| The index swept only when the *next* build started, so a burst of builds that all ended and were never followed by another kept every command — and the closure over its whole build — for the life of the worker. | The bound (`FINISHED_COMMANDS_KEPT = 8`) holds **at settlement**: twelve builds that end with nothing after them leave eight. A running build is never counted and never released, and a build whose last row has not been published yet is still held, because the sweep runs after `onSettled` returns. |
| The row's status was derived from whatever state happened to be set: `running ? running : failure ? failed : phase === "stopped" ? stopped : completed`. A progress report carrying a terminal-looking phase arrives before the error is in hand, so the row could say **completed** about a build that was about to be reported as failed. | A build is running until its outcome arrives, whatever a phase says, and the outcome — `completed`, `failed` or `stopped`, taken from the engine's own result — writes the status, the reason and the `endedAt` together. A terminal row is published once, and it is true. |
| A failure's row carried the raw error message. | A refusal that wrote its own sentence is shown as it is, with its next step; anything else is given the sentence it lacked, so a row never reads as a stack trace. |

The workspace's own row retention is unchanged in shape — terminal row
published before the prune, running builds never evicted — but it now rests on
the outcome rather than on a phase, so "still running" and "not prunable" are
the same fact.

### The window

- `useDesignBuildOwner` (new) answers with this window's current conversation,
  and only when its directory resolves to the project being indexed — the
  registry resolves a worktree and its owner to the same `projectId`, so a
  worktree conversation qualifies.
- **The answer belongs to the directory it was made for.** Resolving a
  conversation's folder to a project is one bounded read, so there is always a
  moment when the window has moved to a conversation it knows nothing about
  yet. The resolved state is keyed by that conversation's `cwd` *and* by the
  project being asked about, and an unresolved directory is refused rather than
  inheriting the previous conversation's eligibility — which would have offered
  this project's build to a conversation that turns out to belong to another
  one. Cancellation on unmount and on a change of conversation is unchanged.
- `useDesignAccess` offers **Re-index** only with an owner, and always sends its
  path. Without one the panel shows the sentence where the button was, plus
  "Back to the conversation" — the existing way to a session — and sends
  nothing. A conversation of another project is never silently used.

## Not touched

Mention/turn-context/verification paths, prompt/steer/follow-up/pending/driver,
Fleet-general controls, the host router's design forwarding, the canonical
store, the harness run state machine, Plain Chat's read/write gates, the
per-invocation design profile read, and the parse-only guarantee (D-353).

## Evidence

| Command | Result |
| --- | --- |
| `pnpm -F @lasercode/worker exec vitest run test/design` | 228 passed |
| `pnpm -F @lasercode/worker exec vitest run` | 1657 passed, 4 skipped |
| `pnpm -F @lasercode/ui exec vitest run test/design` | 122 passed |
| `pnpm -F @lasercode/ui exec vitest run test/fleet test/design test/runtime` | 1146 passed |
| `pnpm -F @lasercode/host exec vitest run test/router.design.test.ts` | 6 passed |
| `pnpm -F @lasercode/protocol exec vitest run` | 729 passed |
| `pnpm -r build && pnpm -r typecheck && pnpm identity:check` | clean |

New proofs, all through a real `WorkerServer` with the real
`ProjectWorkSession` the worker hands the driver
(`packages/worker/test/design/index-command-owner.test.ts`):

- the model's `build_design_index` publishes a **running** row under the
  conversation it was called in, before the build ends, and `design/index/get`
  reports the same owner;
- Stop by the fleet row's own id ends the build for real (terminal row
  `stopped`, "you stopped it") without a runtime answering for that
  conversation;
- the conversation is pinned while the build runs and holds nothing after it;
- a build naming no conversation is refused by the method itself, one naming a
  conversation this worker does not hold is refused with a sentence, and
  neither writes an index;
- another project's conversation can never own one, because it can never be
  opened here.

The settlement corrections (`packages/worker/test/design/workspace.test.ts`,
"when builds end"; `packages/ui/test/design/workspace.test.tsx`, "Re-index, as
a Command"), each of which fails on the code before it:

- twelve builds start together, all end, and **nothing follows them**: eight
  commands are left, the build that is still working (waiting on a model that
  never answers) is neither counted nor released, and every build that ended
  published its terminal row while it was still held;
- a build that reports a terminal-looking phase before its outcome arrives
  keeps a *running* row — the row that says `completed`, `failed` or `stopped`
  is published once, from the outcome, and a failed build's row never says
  completed;
- a real failing build — the index file's own path is a directory, so the
  store's rename cannot land — publishes `failed` with its sentence as the last
  word, before anything is cleaned up, and `design/index/get` reports the same
  one outcome. (This one is coverage rather than a regression: the old code
  reached the same end state by a different route.)
- the Design tab moved to an unresolved conversation offers no build and sends
  no request; when that conversation resolves to another project it still
  offers none; when it resolves to a worktree of this project it offers
  **Re-index** again and the build is owned by that worktree conversation.

### Not proven by tests

Pre-existing and unrelated: every host test that spawns a worker
(`test/worker-pool`, `test/session-lifetime`, `test/worker-client.*`,
`test/pressure/*`, `test/resources/worker-pool`, `test/worker-oom-recovery`,
`test/agents/profiles-migration` — 68 tests) fails in this worktree with
"The app could not verify the project runtime it started" (launch identity).
Those tests write their own worker script and this change touches no host
source; `test/router.design.test.ts` passes.

Visual acceptance is the person's (D-342): the Design tab with and without an
eligible conversation, in both themes and both widths, and the index build's
fleet row while it runs and after Stop. `pnpm -r build && pnpm sandbox`.
