# L6 — Git actions engine

Engine half of milestone L6 (M18-T6). Overlay toolbar is a different owner; this document is the call contract.

Branch: `agents/l6-git-actions-engine-9beb1415`

## Method surface

All names follow the existing `pi/` convention. Mutating calls take `confirm?: boolean`; only `confirm: true` writes. Omitted `confirm` is a preview: same `confirmation` and `copyable` payload, `outcome: "preview"`, nothing mutated.

| Method | Scope | Why that scope | What it does |
| --- | --- | --- | --- |
| `pi/project/git/hosts` | `read` | Inspects remotes and CLI status. No executable that mutates. | Per-repository host row |
| `pi/project/pr/read` | `read` | Fetches a PR. No write. | PR + comments + checks + viewed |
| `pi/project/git/prose` | `session_write` | Uses the **session's current model** (token spend, needs a live session). Not the Namer. Does not run git. | Editable commit/PR text |
| `pi/project/git/commit` | `execution` | Runs `git` | Commit an explicit path set |
| `pi/project/git/push` | `execution` | Runs `git push` (never force) | Push named branch to named remote |
| `pi/project/git/branch` | `execution` | Runs `git branch` / `git switch -c` | Create a branch from an explicit base |
| `pi/project/pr/create` | `execution` | Runs `gh` or Bitbucket HTTP | Open a PR |
| `pi/project/pr/checkout` | `execution` | Runs `gh pr checkout` or `git fetch`+`switch` | Check out the PR branch |
| `pi/project/pr/merge` | `execution` | Runs `gh pr merge` or Bitbucket merge | Merge the PR |
| `pi/project/pr/viewed` | `execution` | GitHub: GraphQL via `gh`. Bitbucket: local JSON file. | Mark a file viewed |

Reach is `any` for all of them (pairing already grants agent control). They are cwd-routed to the project's worker.

Shared result envelope (`GitActionResult`):

```
outcome: "preview" | "done" | "refused" | "uncertain" | "needs_copy"
message?: string          // person-facing; never a credential or raw API body
confirmation: { repo, branch, remote?, files?, summary }
copyable?: { argv: string[], cwd: string, url?: string }
```

`uncertain` means a remote mutation may already have happened. **Never retry automatically.** Show `message` and let the person look.

JSON-RPC `InvalidParams` is only for "cannot even start": path outside the project, no live session for prose, missing CLI/token at locate time. The `message` is the one command that fixes it.

## Host discovery

`pi/project/git/hosts { cwd, repos? }`

- `repos` omitted: every repository the workspace resolver found (or `cwd` if none).
- `repos` set: optional filter of that list. One failure never blocks another.
- Each path is fenced inside the project (realpath; no `..`).
- Host from remotes (`origin` preferred): `github.com` → GitHub, `bitbucket.org` → Bitbucket, anything else → `unsupported`.
- GitHub: `gh --version` / `gh auth status`. Missing → `Install the GitHub CLI, then run gh auth login.` Signed out → `Run gh auth login.`
- Bitbucket: `BITBUCKET_API_TOKEN` in the process environment (Atlassian API token with Bitbucket scopes, Bearer). Missing → sentence pointing at `https://id.atlassian.com/manage-profile/security/api-tokens`. Never prompted, never stored.
- GitLab / self-hosted / no git: `usable: false` plus a sentence. Other rows still answer.

## Prose

`pi/project/git/prose { cwd, path, repo?, kind: "commit"|"pr_title"|"pr_description", files, summary? }`

- Requires the session named by `path` to be open on this worker.
- Completes through the session's current model (`completeSimple` on the engine runtime), **not** the Namer.
- Prompt includes: project `AGENTS.md` or `CONTRIBUTING.md` (first 4k, if present), last 20 commit subjects, the file list, optional numstat `summary`, a bounded conversation excerpt.
- Returns `{ kind, text, model }` — never commits, never opens a PR. The toolbar must put `text` in an editor and send it back as `message` / `title` / `body`.

## Safety

- `execFile` argument arrays only. Hostile branch / message / path stay one argv element (proved).
- No `--force`, no stash, no reset, no clean, no history rewrite, no tag move.
- Push of `refs/<product>/…` is refused by name.
- `GIT_INDEX_FILE` is deleted from the child env.
- Errors and results run through `redactSecrets` (ghp_/gho_/github_pat_/ATATT/Bearer/Basic). Raw API JSON is mapped to typed fields and discarded.
- Bitbucket token is only an `Authorization` header, never argv, never a result.
- Bitbucket cannot rebase-merge; that method is refused with a sentence (merge or squash).

## Decisions to record

| ID | Decision |
| --- | --- |
| D-312 | Already settled: prose is the session model, never the Namer. Implemented. |
| *(new)* | Mutating git methods are `execution`; `hosts` and `pr/read` are `read`; `prose` is `session_write` because it spends the session model. |
| *(new)* | `confirm: true` is required to mutate; omitting it is a preview of the same confirmation payload. |
| *(new)* | Bitbucket viewed marks live in `<stateDir>/git-viewed.json` (0600). GitHub uses `markFileAsViewed` / `unmarkFileAsViewed`. |
| *(new)* | Bitbucket rebase-merge is refused; Bitbucket only has merge-commit and squash. |
| *(new)* | Hidden product refs (`refs/<name>/…`) cannot be pushed. Ordinary branches named similarly under `refs/heads/` are allowed. |

## What the overlay toolbar must call

Common params: `cwd` = project root (host rewrites worktrees via `projectRootOf`). `repo` = repository root inside that project when the workspace has several.

### 1. Load the toolbar

```
pi/project/git/hosts { cwd, repos: [repoA, repoB, …] }
→ { hosts: [{ repo, host, remote, remoteUrl, defaultBranch, branch, cli, cliPresent, signedIn, usable, fix? }] }
```

If `usable` is false, show `fix` and disable host actions for that repo. Other repos stay enabled. Always keep `copyable` from a later preview as a fallback for phone/remote.

### 2. Commit

Preview (dialog):

```
pi/project/git/commit { cwd, repo, paths: [...chosen], message: <from prose or editor> }
→ confirmation.summary, confirmation.files, confirmation.branch, copyable
```

Generate message first if empty:

```
pi/project/git/prose { cwd, path: sessionPath, repo, kind: "commit", files, summary? }
→ text  (put in an editable field; do not send it to commit until the person confirms)
```

Run:

```
pi/project/git/commit { …, message, confirm: true }
→ outcome "done" + commit.hash/subject
  | "refused" + message
  | "uncertain" + message   (do not retry)
```

### 3. Push

```
pi/project/git/push { cwd, repo, remote, branch, confirm?: true }
```

`remote` and `branch` from the hosts row. Never send force. On `uncertain`, tell the person to check the remote.

### 4. Branch

```
pi/project/git/branch { cwd, repo, name, base, checkout?: true, confirm?: true }
```

`base` is a commit-ish (usually `defaultBranch` or current `branch`). `checkout: true` switches after create.

### 5. Open a pull request

Prose:

```
pi/project/git/prose { …, kind: "pr_title", files }
pi/project/git/prose { …, kind: "pr_description", files }
```

Create:

```
pi/project/pr/create { cwd, repo, title, body, base, head, confirm?: true }
→ pullRequest: { host, number, url, title }
```

Push the head branch first if it is not on the remote.

### 6. Read / checkout / merge

```
pi/project/pr/read { cwd, repo, number }
→ pullRequest: { title, body, url, state, base, head, comments[], checks[], files[] }

pi/project/pr/checkout { cwd, repo, number, confirm?: true }

pi/project/pr/merge { cwd, repo, number, method: "merge"|"squash"|"rebase", confirm?: true }
```

Bitbucket + `method: "rebase"` → refused with a sentence. Offer merge or squash.

### 7. Viewed tick

```
pi/project/pr/viewed { cwd, repo, number, path, viewed: boolean }
```

No `confirm` (not a commit/push). GitHub syncs github.com; Bitbucket is local only — say so in the tick's accessible name.

### Error shapes the toolbar should switch on

| Shape | UI |
| --- | --- |
| JSON-RPC `InvalidParams` | Show `error.message` (already a sentence). |
| `outcome: "preview"` | Confirmation dialog; primary action re-sends with `confirm: true`. |
| `outcome: "done"` | Close dialog; refresh changes. |
| `outcome: "refused"` | Show `message`; leave files as they are. |
| `outcome: "uncertain"` | Show `message`; **do not retry**; offer `copyable`. |
| `outcome: "needs_copy"` | Show `copyable.argv` (join with spaces for display only) and `copyable.url` if present. |

Phone/remote: the worker still runs on the desktop, so `gh`/token usually work. When they do not, `copyable` is the fallback. A preview result includes `expect` (branch, files, HEAD); the confirming call must send it back so a changed tree is refused rather than written.

## Validation

```
pnpm install --frozen-lockfile
pnpm -F @lasercode/protocol test     # 407 passed
pnpm -F @lasercode/worker test       # git-actions 14/14; full suite 1111 passed + 2 MCP prompt-context flakes that pass in isolation
pnpm -F @lasercode/host test         # router + access (git actions) pass; host.e2e 12/12 pass
pnpm -r typecheck                    # all packages pass after protocol build
pnpm identity:check                  # after git add
```

`pnpm verify` was not run (orchestrator owns the integrated gate).

No browser run. No live GitHub/Bitbucket mutation. CLI/HTTP go through an injected runner/fetch. Real `git` is used only against temporary local repositories (including a local bare remote for push).

## Integration notes for the orchestrator

- Overlay toolbar: this document is the contract. Do not read the worker source.
- The ten UI capability rows for git-action methods are in `packages/ui/test/runtime/environment-capabilities.test.ts`.
- Host `worker-pool` / fake-worker launch-identity failures on this worktree were already present before the new methods landed in protocol dist (`host.e2e` against the real worker is green). Re-run the pool suite on a fully built checkout.

## Corrections

Independent review rejected the first L6 engine. This section is the correction batch. Each paragraph is a decision the orchestrator should record as a `D-<n>`.

**Force-push fence.** `git check-ref-format --branch` accepts `+main`. A client-supplied branch that starts with `+` or `:` or contains `:` is refused before git runs. Push requires `git show-ref --verify --quiet refs/heads/<branch>` and uses the fully qualified refspec `refs/heads/<b>:refs/heads/<b>`, so the value cannot be a force refspec or resolve to a tag.

**Literal pathspecs.** Paths starting with `:` are refused. Every path passed to `git add` / `git commit` is prefixed `:(literal)` so pathspec magic (`:/`, `:(exclude)`, globs) cannot expand the set past `confirmation.files`.

**Stage then commit.** `git commit -- <paths>` does not pick up an untracked file the session created. The engine runs `git add --` on the same literal pathspecs first. The confirmation says those paths get staged.

**`needs_copy` is a result.** Missing `gh`, a signed-out GitHub CLI, or a missing Bitbucket token is `outcome: "needs_copy"` with `copyable`, not JSON-RPC `InvalidParams`. `InvalidParams` remains "cannot even start" (path outside the project, no live session for prose).

**`pi/project/git/prose` keeps `session_write`.** It does not match the scope's written definition, but it is the safest available scope because it stops a read-only device spending the person's tokens. The rationale lives next to the row in `method-policy.ts`.

**Expect binds preview to mutation.** Mutating calls take optional `expect` (branch, exact file list, HEAD sha). A preview returns it. A confirm that no longer matches is refused with a person-facing sentence. That also answers a caller that forwards `confirm: true` blindly without the snapshot.

**Bitbucket 403s are not one failure.** Token-scope (`error.detail.required`/`granted`), repository role (`data.key = "INSUFFICIENT_RIGHTS"`), workspace role, and an HTML security challenge are distinct sentences. Throttling is 429. A 202 merge with a task-status link is `uncertain` and is never retried automatically.

**Canonical git env.** Git actions import `runGit` / `gitEnv` from `packages/worker/src/source-control/git-run.ts` and do not reimplement them. The hidden-ref prefix is derived from `CHECKPOINT_REF_NAMESPACE`. Host discovery enumerates `WorkspaceResolver` repositories; `repos` is an optional filter. `runGit` still does not surface `timedOut`/`killed`; git-actions treats a wrapped `runGit` result as not timed-out and would need that signal added on the source-control side.

