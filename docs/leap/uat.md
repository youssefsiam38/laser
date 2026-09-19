# The source-control leap — acceptance testing

This is the hand-off for the person's acceptance of M20, the source-control
leap (`docs/source-control-leap.md`). Agents did all the programming and all
the programmatic tests; **every visual and manual judgement is yours** (spec
§13.1). Nothing is released until you say it is good (§13.5).

## Starting the sandbox

```bash
cd ~/projects/laser
HOME=/tmp/leap-sandbox-home \
XDG_CONFIG_HOME=/tmp/leap-sandbox-home/.config \
XDG_DATA_HOME=/tmp/leap-sandbox-home/.local/share \
XDG_STATE_HOME=/tmp/leap-sandbox-home/.local/state \
SANDBOX_SOURCE_CONTROL=1 SANDBOX_AGENTS=1 PORT=41477 \
node scripts/sandbox.mjs
```

It prints its URL and four seeded directories. Everything lives under a private
`HOME` and a temp state root: your installed app, your host, your credentials
and your sessions are never touched, adopted or restarted.

What it seeds:

| Directory | Shape | What is in it |
| --- | --- | --- |
| `project` | one repository | a modified file, a new file, a deleted file, a rename, a binary, and a `.gitignore`d `secrets.env` that must never appear anywhere |
| `monorepo` | one `.git`, two packages | the same kinds of change |
| `workspace-of-repos` | root is **not** a repository, `alpha`/`beta`/`gamma` are | `alpha` and `beta` are dirty, `gamma` is clean, so an untouched repository can be seen to stay out of the list |
| `no-git` | no git at all | the "no repository here" state |

All four are pinned as trusted projects, so they are in the rail when you open
the UI.

The stub model answers a prompt containing **change** by really writing
`src/feature.ts` and editing `src/index.ts` through the engine's own tools —
that is what gives a turn a real diff, a real checkpoint and real telemetry.
**delegate** starts a subagent, **background** starts a command, **fleet** makes
the model read the fleet.

## What to try, in this order

### 1. The fleet column (§3)

1. Say **delegate**, then watch the row while the child works.
2. Line 1 is the name and elapsed time; **line 2 must be what the work is doing
   right now, never a copy of the brief**; line 3 is agent · model · turns ·
   branch chip.
3. An agent tile is round with initials; a command tile is square and mono —
   tell them apart without reading.
4. Filters: Going · Asking · Ended, plus all/agents/commands, each with counts.
5. On an asking row, **Enter must not answer**. Tab to Answer, press Enter, and
   nothing may happen; Space or a click navigates.
6. The branch chip carries a hint saying why the agent works where it does.
7. **Changes** on an agent row opens the overlay scoped to that run.

### 2. The telemetry column (§4)

1. The first row says what the numbers cover (`Whole session · N records · M
   compactions`) — there is no blanket apology anywhere.
2. Six sections: Context, Spend, Model, Work, Files, History. Collapse each one
   and check the header still carries its number.
3. The context ring opens the window-health inspector.
4. Files is git-backed: it lists what the session actually changed, grouped by
   repository, and each row opens the overlay.
5. Open the `no-git` project: Files must say there is **no repository here**,
   not "no changes".

### 3. The overlay (§8)

1. Open a file from Files. It is full screen, read-only; Escape returns you to
   exactly where you were, with your draft intact.
2. Split is the default; the unified toggle is remembered.
3. Narrow the window until two columns of code no longer fit: it switches to
   unified itself and says so once.
4. The binary (`logo.png`), the rename and the deleted file each get a written
   state, never a blank body.
5. Tabs: open several files, middle-click to close, reopen the overlay and see
   the set survive.
6. Viewed ticks and their running count.
7. Find inside the overlay, and copy a few lines: the clipboard must carry the
   source with no line numbers and no `+`/`−`.

### 4. Checkpoints and undo (§7)

1. Say **change** twice so the session has two turns of real work.
2. On a finished turn, use **Undo** in the prompt footer. The confirmation must
   name what is restored, in which repositories, and what uncommitted work
   would be lost — and say that staging is not restored.
3. Cancel must do nothing at all. Confirm must actually restore the files.
4. Try Undo while a turn is streaming: it must refuse in a sentence.
5. In Settings → Projects, change checkpoint retention and agent isolation.

### 5. The harness in each shape (§6)

1. In `no-git` and in `workspace-of-repos`, say **delegate**. The agent must
   start anyway, in the shared checkout, and the result must say why.
2. In `project`, a default `delegate` gets its own worktree and branch.

### 6. Git actions (§9)

The sandbox repositories have no remote, so the toolbar's Git menu will tell
you each repository's host status in a sentence — that is the honest path to
look at. Commit is the one action you can exercise end to end: it previews,
lets you edit the message the session's model wrote, names the branch and the
files, and only writes after you confirm.

## Deliberately not in this leap (§12)

Editing files in the overlay; a commit control in the transcript or beside the
composer; changes outside the project's workspace; filesystem watchers; cloning
and publishing; linked pull requests, stacks and auto-merge; GitLab, Gitea,
Forgejo and Azure DevOps; ignored files; submodules and bare repositories.

## Known and recorded

- A command row shows no process id (D-323) and an agent row shows no token
  total or output sparkline (D-324) — both would have needed data the
  architecture deliberately does not carry.
- Restore returns files, not staging (D-321); the confirmation says so.
- Pull-request *viewed* marks sync with GitHub; Bitbucket keeps ours locally.
