# L6 — Overlay toolbar git actions

Toolbar half of milestone L6 (M18-T6). Engine half is already merged; this
fills the marked slot in the changes overlay.

Branch: `agents/l6-overlay-toolbar-actions-0e31ec9a`

## What was built

Git actions live in `packages/ui/src/source-control/` only, in the overlay
toolbar (settled decision 11 / D-311). Nothing was added beside the composer
or in the transcript.

| File | Role |
| --- | --- |
| `git-model.ts` | Pure helpers: target repo, copyable argv display, `expect` round-trip, host sentences, merge methods |
| `git-toolbar.tsx` | Toolbar slot: Commit on desktop, Git menu everywhere, per-repo host sentence |
| `git-dialog.tsx` | Preview → edit → confirm dialogs for commit, push, branch, PR create, PR read / checkout / merge |
| `data.ts` / `host-adapter.ts` / `mock.ts` | Adapter methods for the ten git RPCs; host fills `cwd`/`path`; mock is tests-only |
| `store.ts` | `gitAction` request; overlay shortcuts yield while it is open |

The host adapter calls the engine as `l6-report.md` specifies. Preview omits
`confirm`. The write sends `confirm: true` and the preview's `expect`.

## Decisions the orchestrator should record as `D-<n>`

Existing, implemented here: **D-311** (toolbar only), **D-312** (session-model
prose, editable before use).

Propose:

- **Preview then confirm in the overlay.** Omitting `confirm` is the dialog's
  review step. The person must see branch, remote and files before the write.
  A file-set change after preview disables the write until a new preview.
- **`needs_copy` is a status.** Copyable `argv` (joined for display only) plus
  one sentence. Never `role="alert"`, never a failure colour, never a secret.
- **Uncertain never retries.** No “Try again” that re-sends `confirm: true`.
  The copy names what may already have happened and what to do next.
- **Expect is the confirmation.** The confirming call always forwards the
  preview's `expect`. A mismatch is the engine's sentence, then “Review again”
  (a new preview), not a blind write.
- **PR create does not silently push.** Push is its own confirmed action. If
  the host does not have the head branch, the engine's refusal is shown.
- **`pi/project/pr/viewed` is not wired.** Overlay viewed ticks stay local.
  GitHub/Bitbucket viewed sync is a later overlay-rail change, not this
  toolbar.

## `docs/ux-elements.md` rows followed

| Row | How it was used |
| --- | --- |
| Approval card / Elicitation form | Not mounted. Git confirmation is a Dialog with editable fields and an explicit confirm, same shape as `EndAgentDialog` (safe Cancel, fields, person-facing errors). The payload is not a tool `confirm`/`choice`. |
| Terminal block / ProjectLine Create PR | Copyable commands use the existing `terminal` ground and Copy control. `ProjectLine.tsx` was not edited. |
| Reviewable diff | Still not applicable for hunk apply. PR create/review moved here from the composer line for this leap. |
| Spec sheet | Not used. Confirmation is labelled repository / branch / remote / files. |

No new catalog element. No `@pierre/diffs` import.

## Designed states

- No repository host / no remote to push
- Signed-out CLI (`Run gh auth login.`) while a neighbour still commits
- Unsupported / unusable host: `fix` sentence, other repos keep working
- Nothing to commit
- Commit in flight (`Working…`, controls disabled, no auto-retry)
- Generated prose, then an edited message used on confirm
- Refused `expect` (HEAD moved): sentence + Review again
- `needs_copy`: copyable command, not an error
- Uncertain push: “This may already have happened”, no retry
- On the default branch when opening a PR
- PR with failing checks (count + list); merge still reviewable
- PR that is not open: merge hidden
- Bitbucket: rebase not offered; sentence says merge or squash
- 320 px: Commit drops off the toolbar; Git menu still reaches every action

## What the engine could not give

- Whether the head branch is already on the remote, so the toolbar does not
  auto-push before `pr/create`.
- Agent-scope worktree as `cwd`. Git calls use the session project root and
  the overlay's `repo` path. If a child's worktree must be the git cwd, the
  engine/host would need to say so; this half does not guess.
- `timedOut`/`killed` on `runGit` (already noted in `l6-report.md`). Uncertain
  is rendered when the engine returns it.

## Validation

```
pnpm install --frozen-lockfile
pnpm -F @lasercode/ui test          # 298 files, 2754 passed, 1 skipped
pnpm -F @lasercode/ui typecheck     # clean
pnpm -F @lasercode/ui build
pnpm identity:check                 # after git add
```

`pnpm verify` was not run. No browser, no Playwright.

Focused evidence: `test/source-control/git-actions.test.tsx` (10),
`git-model.test.ts` (7), host-adapter preview/confirm, overlay keyboard yields.

### Chunk measurement

| | file | raw | gzip |
| --- | --- | --- | --- |
| main | `index-Bq3Z4d-C.js` | 2,409.18 kB | 727.67 kB |
| renderer | `diff-body-0sRaLRJu.js` | 310.16 kB | 80.31 kB |

`@pierre` / `registerCustomTheme` / `diffs-container` are absent from main and
present in `diff-body-0sRaLRJu.js`. Git chrome sits in main with the overlay
host (already statically imported from `App.tsx`).

## Visual acceptance — try this first

1. Open Changes on a dirty repo. Commit: generated message is editable; the
   dialog names branch and files; Confirm is what writes.
2. Edit the message, confirm, see the commit on `git log`.
3. 320-wide: Git menu still reaches Commit / Push / branch / PR. Type stays
   12 px.
4. Both themes, mouse and keyboard: Tab to Commit, edit, Cancel, Confirm.
5. **Signed-out without a real remote:** fake `gitHosts` so one repo is
   `usable: false` with `fix: "Run gh auth login."` and its neighbour is
   usable. The sentence appears; Commit still works on the neighbour.
6. **`needs_copy` without a real remote:** have the adapter return
   `outcome: "needs_copy"` with `copyable.argv`. The dialog shows a Copy
   command, not an error.

Designed states 5 and 6 are covered by the jsdom tests; the sandbox can stub
the same adapter if a live CLI is signed in.
