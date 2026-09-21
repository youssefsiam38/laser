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

## Review corrections (`docs/leap/m21-index-command-review.md`)

The single review of this branch approved it with three low findings. All three
are addressed here; nothing else about the ownership story changed, and the
logical owner of a build is still decided once, at admission, from an argument.

### F2 — a fork moved the conversation's file and the build did not follow

The hole: `WorkerServer.rekeySessionState` is the one place that moves
everything a worker holds under a session's old path when `pi/session/fork`
replaces the file — the harness, the task index, MCP, git, a naming completion
in flight. The design structures were not in that list, so
`DesignWorkspace.Tracked.sessionPath` and `ProjectDesignIndex.HeldBuild.owner`
kept naming a path no runtime serves. Two consequences, both real: the next
progress report and the terminal row were published under the old path, and the
row `TaskIndex.rekeySession` had just moved to the new path stayed `running`
for ever — pinning the moved conversation against an unload that should have
been allowed.

The correction is a canonical transition on the structures that already exist,
in that same central handler:

```text
pi/session/fork → rekeySessionState(old, new)
    harness · tasks · mcp · git · naming            (unchanged)
    projectDesignIndex?.rekeySession(old, new)      HeldBuild.owner  → new
    projectDesignWorkspace?.rekeySession(old, new)  Tracked.sessionPath → new,
                                                    running rows republished
```

- **The logical owner never changes.** The same conversation owns the same
  builds; what moves is its *address*. Nothing reads a "current conversation"
  at publish time and `startingFor` is not coming back — the admission argument
  is still the only thing that decides who owns a build.
- **The admission's argument object is never written to.** `rekeySession`
  *replaces* the recorded owner (`{ ...owner, sessionPath }`); the object the
  caller passed in stays as it was, which the test proves with a frozen one.
- **Nothing is instantiated to move.** The handler uses the two fields, not
  their getters, so a Chat that never asked anything about design does not
  acquire an index and a workspace because its file moved.
- **Active and finished builds both move**, so `design/index/get`, the index's
  own `owner()` and the worker's `TaskIndex` keep agreeing.
- **A running build republishes its row once**, after `tasks.rekeySession` has
  moved the index, because a row is only ever learned from a publication: a
  build that reports nothing for a while would otherwise be missing from the
  conversation that now exists until it ended.

Still open, deliberately, and **not** this milestone's: the host's own
`TaskRegister` has no rekey either, so the host keeps the pre-fork row under the
old path until the worker is lost. That is shared with every shell command a
forked conversation owns — one host-side lifecycle fix, not a design one.

### F1 — a settlement observer that threw said nothing

`ProjectDesignIndex.settle` caught an exception from `onSettled` and dropped
it, so a lost terminal row was invisible. It now writes one bounded line to the
worker's own diagnostic channel (`console.error` with the product prefix, the
convention every other worker diagnostic uses, injected as `log`): the build's
id and the error's *kind*, never its message or stack — an index build walks a
person's repository and that channel is not a place for its contents. Nothing
is retried and nothing is queued; the sweep after it still runs, so an observer
bug cannot hold every finished build in the worker for the life of the process.

On the review's suggested mechanism, precisely: `publishTask` folds the row
into the worker's own `TaskIndex` **before** the transport write, so an
exception from the write cannot leave a stale `running` row or a stale pin —
what it loses is the host's copy of the message. A stale pin needs a throw
*before* that fold. Neither has been observed in production; the diagnostic is
there so that if it ever happens it is not silent.

### F3 — a failure sentence cut mid-word

`failureSentence` sliced at 500 characters. It now backs up to the last space
(when that keeps at least three quarters of the budget — a path or a digest
longer than that is cut where it is) and ends with an ellipsis, so a row reads
as a long sentence rather than as a rendering fault.

### Evidence for the corrections

Frozen install, clean recursive build, then (`env -i PATH="$PATH" HOME="$HOME"`,
one suite at a time):

| Command | Result |
| --- | --- |
| `pnpm -F @lasercode/worker exec vitest run test/design` | 234 passed (17 files) |
| `pnpm -F @lasercode/worker exec vitest run test/agents/tasks.test.ts test/session-unload.test.ts test/session-retire.test.ts test/server.test.ts` | 88 passed |
| `pnpm -F @lasercode/worker exec vitest run test/session-safety.test.ts test/agents/harness.test.ts test/agents/session-naming.test.ts` | 130 passed |
| `pnpm -F @lasercode/worker typecheck`, `pnpm identity:check` | clean |

The new proofs (`packages/worker/test/design/index-command-rekey.test.ts`, six
tests) all fail on the code before this correction — the first two with rows
still under the old path, the next two because the transition did not exist,
the fifth with no diagnostic at all. F2 is taken through a real `WorkerServer`
and its real `pi/session/fork` → `rekeySessionState` seam, with the real design
workspace, index and build engine; the only stub is the session driver at the
engine boundary, whose `fork` moves the session file as the real driver's does,
and a Design profile whose model answers only when the test says so, which is
what keeps the build genuinely running across the fork with no timing window.

For one build running across a fork: the row is republished under the new path
and the old path is never published to again; `pi/worker/safety` keeps the
`task` pin on the new path and `pi/session/unload` still refuses;
`design/index/get` and `ProjectDesignIndex.owner()` both answer the new path,
for a finished build as well as a running one; `pi/task/stop` from the fleet
row still reaches the build after the move; settlement publishes the terminal
row at the new path and the pin is gone; and a second conversation's build,
started at the same time, is untouched by the fork.

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

## Interrupted continuation checkpoint (not complete)

Run `run_f0dc9f86` ended without its completion tool after merging `d7213b26` as `c8baee11`. Parent inspected the stopped run and three modified files, then preserved them for transfer: host Router's canonical rekey hook; a TaskRegister migration implementation; build command abort/outcome changes. **No new tests, typecheck or validation were completed for these partial changes.** The workspace/result stopped-reason plumbing and strengthened fork test remain unfinished. Review the destination-versus-source terminal precedence against the approved newer-destination rule; do not treat the untested implementation as authoritative. Parent resumption attempt failed with the exact returned session id. Preserve this checkpoint and finish the approved end-to-end milestone before its narrow independent review.
