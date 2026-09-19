# Open-time baseline vs first turn

## Mechanism

The first idle `session/prompt` waits for the pending open-time baseline. Session open stays fire-and-forget.

Not chosen: awaiting capture inside `openAndAttach`. Isolated snapshot on this worktree is fast (see below), but `git add` is bounded at 30s per command. Making `session/new` wait that bound would stall the composer on a large unignored tree. The person can type while capture runs; only Send waits, and only for the first idle prompt.

Steer / follow-up do not wait. Those are not the open-time turn. Waiting there held the first-turn lock across a still-running snapshot and missed close/fence races.

`SourceControlService.awaitBaseline(path)` is the gate. `promptLive` calls it while `FirstTurnLock` is already held. A settled baseline returns synchronously (`baselineSettled`), so later prompts do not yield.

## What was measured

This worktree, isolated index (`GIT_INDEX_FILE` temp, `core.fsmonitor=false`):

| Step | Wall |
| --- | --- |
| `read-tree HEAD` | 0.00s |
| `add -A -- .` | 0.05s |
| `write-tree` | 0.00s |

Ignored trees (`node_modules`, build output) are not in the add. A repository with many unignored files can approach the 30s per-command timeout. Open therefore does not await. First-prompt wait is capped at `BASELINE_WAIT_MS` (60s).

## How the race is forced

`SourceControlDeps.runGit` wraps the real runner. For `add -A` it signals a latch, then waits on a second latch, then calls `runGit`.

1. `void captureBaseline` (same as session open).
2. Wait until `add` has started and is gated.
3. Start the first turn: `awaitBaseline`, then write `src/feature.ts`, then `captureAfterTurn`.
4. Assert the file is still absent (the turn is blocked on the snapshot).
5. Release `add`. Baseline finishes on the pre-turn tree. The turn then writes and captures.

Without `awaitBaseline`, `git add` sees `src/feature.ts`. Turn 0 contains it; `turn` 1 is empty.

## When the baseline cannot be captured

`awaitBaseline` times out or capture fails:

- An abort flag is set. `update-ref` for turn 0 is skipped even if a late `add` already saw first-turn files.
- A **failed** turn-0 marker is published from `HEAD^{tree}` (not the late isolated tree), so a later open does not recapture.
- `lastError` records the timeout/failure.
- `session` / `turn` scopes use the existing pruned path (`PrunedScope.detail`, empty file list) rather than a range that pretends the first turn did nothing.

Nothing waits forever: git commands already time out; the first prompt's wait has a 60s cap. The person's index, working tree, branches and reflog are untouched. Ignored files stay out.
