# Agent scope, viewed marks, and worktree git actions

Closes three named gaps left by the source-control leap. Ready for the
orchestrator's review. Not the leap being done.

## Protocol fact, and why that home

`ProjectChanges.agent?: AgentScopeFacts` with `runId`, optional
`worktreeRemoved`, optional `branchGone`.

Why the changes result, not `AgentWorktree` / `AgentWorktreeStatus`:

- It is **computed from git at query time** (`git show-ref --verify --quiet
  refs/heads/<branch>` as one argv element). A host restart recomputes it.
  A flag on the persisted run record would go stale between writes.
- `AgentWorktree` is history (path, branch, `baseCommit`, `removedAt`). Old
  `agent-runs.json` rows without the new field still load.
- `AgentWorktreeStatus.unmergedCommits === null` means "git could not
  answer", which is not "the branch is gone". Sniffing `detail` would be a
  guess.
- The overlay's question is "show this agent's changes". `ProjectChanges` is
  that answer.

Git action params gained optional `runId` so the engine can resolve a run's
worktree the same way `reposFor` does. The host still rewrites `cwd` through
`projectRootOf`, so sending the worktree as `cwd` cannot retarget the action.

## Gap 1 — §8.5 four cases

| Case | Result | Evidence |
| --- | --- | --- |
| Live worktree | Range `baseCommit` → worktree snapshot; `agent: { runId }` | `test/source-control.test.ts` "agent scope §8.5" |
| No worktree (`worktree: null`) | Session checkpoints in the shared checkout; not `worktreeRemoved` | same |
| Removed worktree, branch survives | Parent repo, `baseCommit` → `refs/heads/<branch>` (no uncommitted side); `worktreeRemoved: true` | same; overlay maps to "Showing branch …, which still exists." |
| Branch gone | Empty repos, `branchGone: true`, no throw | same; overlay `AgentGoneState` from `list.agent.branchGone` |

`mapAgentRunContext` still never sets `branchGone` from `removedAt` alone.
`mapProjectChanges` copies the computed facts. Overlay:
`agent?.branchGone \|\| list?.agent?.branchGone`.

## Gap 2 — viewed marks

A rail tick always updates the local set first (never blocks, never lost).

- No pull request (the common case): stays local. Rail copy: **Viewed on this
  device.** Tick accessible name says the same.
- After a successful `pi/project/pr/read`, `attachOverlayPullRequest` records
  `{ repo, number }` and seeds ticks from `files[].viewed`. Later ticks call
  `pi/project/pr/viewed`.
- Engine failure: local mark kept; engine `message` shown when present
  ("The mark is local-only until it syncs with GitHub."). A throw uses that
  same sentence. No second story.

Evidence: `test/source-control/overlay.test.tsx` (local until PR; host call;
failure keeps the tick), `host-adapter.test.ts`.

## Gap 3 — git actions in the agent scope

`GitActionsService.actionRepo` prefers `runId`:

- Live worktree → that directory (still fenced inside the project).
- Gone or unreadable worktree → refuse with a sentence. Never the parent.
- Shared checkout (`worktree: null`) → project / `repo` as before.

The overlay adapter sends `runId` on every git RPC while the scope is
`agent`. Host discovery no longer drops an in-project worktree just because
it is not a workspace root.

Evidence: `test/git-actions.test.ts` "commits in the run's worktree and
refuses a removed worktree instead of the parent";
`host-adapter.test.ts` "sends runId on git actions"; host router forwards
`runId` on `pi/project/git/commit`.

## Not closed

- Overlay still has no dedicated PR *scope*; viewed sync starts when the
  person reads a PR in the toolbar dialog.
- Merge is still not offered from the agent reader (D-314).

## Validation

```
pnpm install --frozen-lockfile
pnpm -F @lasercode/protocol test     # 442 passed
pnpm -F @lasercode/worker test       # 1155 passed, 4 skipped
pnpm -F @lasercode/host test         # 972 passed (launch env scrubbed)
pnpm -F @lasercode/ui test           # 2768 passed, 1 skipped
pnpm -r typecheck                    # all packages
pnpm identity:check                  # after git add
```

No `pnpm verify`. No browser, no Playwright.
