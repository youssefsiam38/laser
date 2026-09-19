# Undo this turn — transcript control

Branch: `agents/undo-this-turn-5c686777`
Base: `0368c689084db5b5283059688514ece56c7f2c77`

## Where, and why

The control lives on the **user prompt footer** in `packages/ui/src/components/thread/messages.tsx`, beside Fork and Jump, not in the overlay and not as a new surface.

- `UndoTurn` (`packages/ui/src/components/thread/UndoTurn.tsx`) is the action and its confirmation.
- `undo-turn.ts` holds the mapping, hidden-target rules, and person-facing copy.
- It is a turn's own action: `userOrdinal` N restores checkpoint N (turn 0 is the open-time baseline — the state *before* this prompt's work).

Fork and Jump stay in the More menu (`message-actions.tsx`, not this write set). Undo is a separate icon on the same footer so it can open a confirmation without living inside that catalog file.

Capability: `pi/project/restore`. The control is omitted when that method is unavailable, when `pi/project/checkpoint/list` has no kept checkpoint for that turn, or when the capture `failed`.

## States

| State | What you see |
| --- | --- |
| No checkpoint / failed capture / no capability | Nothing. Hidden, not disabled. |
| Checkpoint kept | "Undo this turn" icon on the prompt footer (hover/focus on fine pointers; always on touch). |
| Preview loading | Dialog open, Cancel focused, "Checking what this would restore…" |
| Preview ready | Targets that would do work; repositories, files, uncommitted loss, staging sentence. |
| No-op target | Omitted from the picker (`preview.hidden`). If only one target remains, no picker. |
| Nothing would change | Description says so; no confirm button. |
| Running-turn / pruned / other engine refusal | The engine's sentence in an alert. No confirm. |
| Confirming | "Restoring…" on the destructive button; Cancel disabled. |
| Per-repo refusal | Dialog stays open with those sentences. Close, not a success toast. |
| Full success | Dialog closes. Toast names files and/or conversation. |

Enter on the row button is swallowed (fleet Answer rule). Space or click opens. Cancel owns first focus / first Enter in the dialog. Confirm is `type="button"`, never `submit`.

## What the confirmation says

Title: **Undo this turn?**

Body names, from the preview (`confirm` omitted):

1. **What** — files, conversation, or both (`This restores the files and the conversation.`).
2. **Where** — each repository that would change, by leaf name and branch, with the paths that would be written back.
3. **What would be lost** — `Uncommitted work that would be lost` and those paths, per repository.
4. **Staging** — the engine's `preview.detail` when `staging: "not_restored"`.

Confirm sends exactly one `pi/project/restore` with `confirm: true` and the chosen target. Cancel never sends `confirm: true`. The preview call uses `restore: "both"` only to learn `hidden`; it does not mutate.

## After a restore — what refreshed, what did not

Refreshed (this write set):

- **Conversation** — `actions.rereadHistory()` when `restored.conversation` is true (the worker already ran `navigateTree`).
- **Project line** under the composer — `requestProjectGitRefresh()` when files were restored (the line otherwise only re-reads on settle / a 30s poll).

Not refreshed (not owned here):

- **Telemetry Files** (`useSessionChanges` / `filesRefresh` in `TelemetryPanel`) — bumps only on settle or the section's own Refresh. After undo the counts can stay stale until the next settle or a manual refresh.
- **Changes overlay** — re-fetches only when its scope object changes (`setChangesScope`). Undo does not call that API.

## Validation

| Command | Result |
| --- | --- |
| `pnpm install --frozen-lockfile` | lockfile up to date |
| `pnpm -F @lasercode/ui exec vitest run test/thread/undo-turn.test.ts test/thread/undo-turn-control.test.tsx` | 14 passed |
| `pnpm -F @lasercode/ui test` | 2785 passed, 1 skipped |
| `pnpm -F @lasercode/ui typecheck` | passed |
| `pnpm -F @lasercode/ui build` | passed |
| `pnpm identity:check` | after staging |

No browser, no Playwright, no `pnpm verify`.

## Visual acceptance — try first

1. Open a session that has finished at least one turn in a git project.
2. On the first prompt, Tab to **Undo this turn** (or hover the footer). Enter must not open or confirm; Space or click opens.
3. Read the dialog: repositories, files, uncommitted paths, staging sentence. Cancel (focused) closes with no restore.
4. Open again, pick **Files** / **Conversation** / **Files and conversation** as offered, confirm. Conversation should jump when chosen; the project line's `+/−` should update when files were restored.
5. Send a prompt and, while it streams, open Undo: the running-turn sentence, no confirm.
6. Narrow to ~320px and a phone pointer: targets and footer buttons are 44px tall; nothing below 12px; both themes.

Intentionally unfinished: telemetry Files numbers and an already-open overlay after undo (see above).
