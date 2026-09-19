# L2 — Checkpoints, scopes, restore

Branch: `agents/l2-checkpoints-and-restore-d0309ce4`
Base: `c61b7d2288869810dc75d53208c91f3bae9eec51`

## Design

### Ref layout

`refs/<PRODUCT_NAME>/checkpoints/<sessionKey>/<turn>`

- `PRODUCT_NAME` comes from `@lasercode/protocol` identity. Source never spells the product.
- `sessionKey` is `sha256(sessionPath).hex.slice(0, 32)` so the path is git-ref-safe.
- Turn `0` is the open-time baseline; each settled turn increments.

Refs live in the repository's git common dir. They are invisible to `git log`, `git status`, `git branch`, and the person's HEAD reflog. Capture never writes the person's index or working tree.

### Capture

For every repository `sessionRepositories(workdir)` returns, after session open (turn 0 if none exist) and after `agent_settled`:

1. Isolated temp index at `<git-common-dir>/<product>-checkpoint-index-<uuid>`.
2. `GIT_INDEX_FILE` is set only in that command's `env`. Inherited `GIT_INDEX_FILE` is scrubbed first. Never assigned on `process.env`.
3. `read-tree HEAD` (if HEAD exists), then `git add -A -- .` against the isolated index only, then `write-tree` / `commit-tree` / `update-ref`.
4. Temp index and `.lock` are removed.
5. Failures are quiet: the session continues; `pi/project/checkpoint/list` carries `lastError`.
6. Captures for one session are queued so open and settle cannot race.

`git add` against `GIT_INDEX_FILE` is not a mutation of the person's index. Tests compare the person's `.git/index`, porcelain, `git branch -a`, `git log`, HEAD reflog, and a known worktree file before/after capture.

Ignored files are never in the tree (asserted with `.gitignore` + `cat-file -e` and `git grep` on the checkpoint).

### Scopes (`pi/project/changes`)

| Scope | Range |
| --- | --- |
| `session` | first checkpoint → isolated snapshot of now |
| `turn` | checkpoint(N−1) → checkpoint(N) |
| `uncommitted` | HEAD → isolated snapshot of now |
| `range` | two caller refs |
| `agent` | run `baseCommit` → snapshot of the worktree (or session checkpoints if uninsulated) |

"Now" is an isolated `write-tree`, not `git diff` against the live index, so new unignored files appear as additions. Untracked files that were already in the first checkpoint produce no session/turn diff. Uncommitted lists everything `git status` would, including pre-session untracked files.

Empty repos are omitted (untouched workspace siblings are not listed). A pruned starting checkpoint returns `pruned.detail` and no file list rather than a wrong range.

Patches (`pi/project/file_diff`, `pi/project/file_source`) are paged with the transcript's 64 KiB byte-range discipline.

### Restore (`pi/project/restore`)

Scope: **`session_write`**. Undo-this-turn is a conversation act, paired with `pi/session/navigate`, refused while a turn streams (`SessionBusy` + a sentence). It is not `execution` (that is MCP / project env) and not `work_control` (stop/restart runtimes).

Without `confirm`, only the preview is returned: repositories, paths that would change, currently uncommitted paths that would be lost, and `hidden` for options that would no-op. With `confirm`, `git restore --source <commit> --worktree --staged` then `git clean -fd` (not `-x`; ignored files stay). Conversation restore calls `navigateTree` when an `entry=` was stored on the checkpoint.

### Retention

Default **200** turns per session, oldest-first. Per-project file: `<cwd>/<PROJECT_DIR_NAME>/source-control.json` key `checkpointRetention`: `50` · `200` · `1000` · `all` · `off`. Off deletes that session's refs. After prune, `git pack-refs --include=<namespace>/**`.

Deleting a session unlinks the transcript and deletes matching checkpoint refs (best-effort git). The delete dialog says checkpoints go with it.

## Decisions the orchestrator should record

- **D-308** (settled): hidden checkpoint refs through an isolated index; person's index/tree/branches/history untouched.
- **D-316** (settled): retention default 200, configurable, follows session deletion.
- **Proposed D-318**: `pi/project/restore` is `session_write` (justification above).
- **Proposed D-319**: session key is a truncated sha256 of the session path, not the file basename.
- **Proposed D-320**: "now" for diffs is an isolated write-tree, so untracked unignored files participate without reading the person's index.

## Seam to M18-T1

`packages/worker/src/source-control/repositories.ts` exports one function:

```ts
sessionRepositories(cwd): Promise<RepoRef[]>
```

Body: `rev-parse --show-toplevel` if inside a work tree; otherwise immediate child repositories, bounded, skipping `node_modules`/`dist`/dot dirs. Marked `TODO(M18-T1): replace this body with the shared workspace resolver`.

Host cleanup (`packages/host/src/source-control/cleanup.ts`) has a parallel walk with the same TODO. Rewire both to the shared resolver — a few lines each. Do **not** add `pi/project/workspace`.

## Left for another milestone / the orchestrator

- Settings UI for retention (`packages/ui/src/components/settings/**` is M18-T1). Storage, default and prune effect are implemented.
- Transcript "undo this turn" control. Protocol is ready; placing it in the overlay (L5) avoids redesigning turn footers.
- Live vs durable authority identity for telemetry files (L3).

## Validation

| Command | Result |
| --- | --- |
| `pnpm install --frozen-lockfile` | lockfile up to date |
| `pnpm -F @lasercode/protocol test` | 409 passed |
| `pnpm -F @lasercode/worker exec vitest run test/source-control.test.ts` | 11 passed |
| `pnpm -F @lasercode/worker test` | 1109 passed; 1 MCP prompt-context flake under parallel load, 27/27 on rerun |
| `pnpm -F @lasercode/host exec vitest run test/router.test.ts` | 43 passed (forwards + delete-ref cleanup) |
| `pnpm -F @lasercode/host test` | e2e 12/12, router 43/43; fake-worker pool tests fail launch identity (untouched `worker-client.ts`) |
| `pnpm -F @lasercode/ui exec vitest run test/runtime/environment-capabilities.test.ts test/shell/delete-session-worktree.test.tsx` | 11 passed |
| `pnpm -r typecheck` | passed |
| `pnpm identity:check` | passed |
| Browser / Playwright | not run (forbidden) |

No `pnpm verify`.

## Acceptance

1. Isolated capture; person's index/worktree/branches/log/reflog unchanged — `test/source-control.test.ts` capture suite.
2. Tracked + new unignored in; ignored secret blob absent — same file.
3. Five scopes + uncommitted extra completeness — scopes suite.
4. Untouched workspace sibling omitted — scopes suite.
5. Default 200, prune 50, pack-refs, off deletes, pruned scope says so — retention suite.
6. Session delete removes refs; dialog copy names checkpoints — host router test + UI delete dialog test.
7. `file_diff` / `file_source` page at 64 KiB — paged payloads suite.
8. Restore preview names repos/lost work; confirm restores files+staging; refused while streaming — restore suite.
9. Types, schemas, policy, round-trip samples, router coverage — protocol + host tests.
10. No browser run.

## Corrections

Branch: `agents/l2-checkpoint-corrections-21256537`
Rejected milestone: multi-repository restore destroyed untracked files in every repository after the first and reported success; `git clean` ran after any `ls-files` failure.

### Blockers

- **B1** — Restore and preview resolve the checkpoint **per repository** (`listSessionCheckpoints` / `CheckpointInfo.repos`). A foreign OID is never applied. Multi-repo fixture uses genuinely different trees (`alpha-one` vs `beta-one`). After deleting beta's ref, alpha restores and beta keeps its untracked file; `restored.repos` records the refusal.
- **B2** — `rev-parse <commit>^{commit}` and `ls-files` exit 0 are required **before** any worktree write or delete. Two-phase: validate every repository, then mutate. Failures are per-repo sentences, not a mid-loop `ProtocolError`. Clean/delete only after a successful `git restore --worktree`.

### Should-fix

- **S1** — `changes()` runs repositories concurrently. Isolated snapshots reuse one durable index `<gitDir>/<PRODUCT_NAME>-checkpoint-index` (mutex per gitDir; UUID leftovers swept). Uncommitted uses `git diff HEAD` plus `git status --porcelain` (no write-tree).
- **S2** — A pruned session scope with `oldestTurn` returns the partial range **and** the pruned marker. Empty files only when there is no surviving start.
- **S3** — See decision below.
- **S4** — `file_diff` / `file_source` resolve repositories through `reposFor` (honours `runId` worktrees). Test uses a child path that is not the parent repo.
- **S5** — Restore ignores caller `workdir` unless it is this session's own directory; otherwise refuses with a sentence. Reads still accept an explicit workdir.
- **S6** — See decision below.
- **S7** — Turn numbers increment on every attempt (`nextTurn`). A failed capture publishes a failed-trailer marker from the previous tree when possible, so the next turn does not borrow the neighbour's range. `scope: turn` on a failed turn says it was not captured.
- **S8** — `scope: "turn"` with `turn: 0` is refused: the open-time baseline is not a conversation turn.
- **S9** — At most one pending after-turn capture per session (latest wins). A pending baseline is not dropped.
- **S10** — Session key lives in `@lasercode/protocol/checkpoint-key` (node subpath: the barrel is browser-bundled). Shared `runGit` in `@lasercode/protocol/git-run` (timeout vs overflow vs git exit). `GIT_EMPTY_TREE` / `gitLooksBinary` in protocol `source-control.ts`. Host cleanup uses the workspace resolver. `ClientRequests` points at the param interfaces in `source-control.ts`.

`worker/src/git.ts` still has its own `looksBinary` / `EMPTY_TREE` copies — that file is outside this batch's write set (composer git line, different runner).

### Nits

- Durable index (S1) replaces UUID files; leftovers are swept.
- `hidden` lists every no-op option, not only the requested target.
- Entry ids are git trailers (`Entry:`), so whitespace-bearing ids are not truncated. Legacy `entry=` subjects still parse.
- Timeout and `maxBuffer` overflow are distinct from git exit 1; diffs throw instead of returning "no changes".

### Retention setting

`pi/project/checkpoint/retention/set` (`settings` scope). Host registry + `<project>/<PROJECT_DIR_NAME>/source-control.json` so a live worker reads it on the next capture. **Off** deletes every checkpoint ref in the project's repositories immediately. Settings → Projects segmented control, tokens only.

### S3 decision — staging is not restored

A checkpoint is one isolated `add -A` tree. That tree cannot record the person's staged/unstaged split, so `--staged` was fabricating an index: everything that differed from HEAD appeared staged after undo.

**Choice:** restore the worktree only (`git restore --source … --worktree`). Files not in the checkpoint (untracked and tracked) are removed from disk after a successful restore; ignored files stay. The confirmation carries `staging: "not_restored"` and a sentence. Capturing a second index tree would honour E.4's wording but would write the person's index on undo, and mixing that index with `git clean` is how untracked checkpoint files get deleted. Honesty over a fake split.

### S6 decision — restore is `work_control`

Followed the orchestrator. `restore: "files"` rewrites the working tree and deletes uncommitted work; it does not change the conversation. Precedent: `agents/worktree/remove` is `work_control`. Conversation restore still goes through `pi/session/navigate` (`session_write`) when `restore` includes conversation. UI capability plumbing is method-keyed (`useCapability("pi/project/restore")`), so the policy table is enough.

### Validation

| Command | Result |
| --- | --- |
| `pnpm install --frozen-lockfile` | lockfile up to date |
| `pnpm -F @lasercode/protocol test` | 433 passed |
| `pnpm -F @lasercode/worker test` | 1120 passed, 4 skipped |
| `pnpm -F @lasercode/host test` (launch env scrubbed) | 967 passed |
| `pnpm -F @lasercode/ui test` | 2680 passed, 1 skipped |
| `pnpm -r typecheck` | passed |
| `pnpm identity:check` | passed |

No browser, no Playwright, no `pnpm verify`.
