# L5 — Changes overlay

Branch `agents/l5-changes-overlay-29cb486e`. Ready for review, not for visual
acceptance until the orchestrator mounts the host and wires the two call sites.

## Architecture

Home: `packages/ui/src/source-control/` (one tree; nothing under
`components/source-control`).

| File | Role |
| --- | --- |
| `contract.ts` | Local types matching the L2 shapes. `TODO(M18-T2): replace with the protocol types`. |
| `data.ts` | The only data access. Default is the mock; `setChangesAdapter` is the swap. |
| `mock.ts` | Fixtures for every designed state, including agent checkout variants. |
| `store.ts` | Module store: open/close, tabs and viewed ticks per session, remembered split/unified. |
| `overlay.tsx` | Full-screen read-only dialog over the conversation. Lazy-loads the renderer. |
| `diff-body.tsx` | The only module that imports `@pierre/diffs`. Dynamic chunk. |
| `classify.ts` | Empty-body kinds, 320px unified fallback, bounded expansion. Pure. |
| `copy.ts` | Clip a selection that starts in a file header so copy begins at the code. |
| `find-ranges.ts` (shared) | Roots concept: collect open shadow roots, append a highlight sheet, concatenate per `[data-line]`. |

Entry: `openChanges({ scope, repo?, path?, sessionKey? })`. Escape / the close
control call `closeChanges`. The conversation is not unmounted, so scroll and
draft survive.

## Call sites the orchestrator must wire

The overlay is not in the startup graph until something imports
`ChangesOverlayHost`. Three wirings, none of which this worker owns:

1. **Mount** `ChangesOverlayHost` once, next to `Shell` in `packages/ui/src/App.tsx`
   (or inside `Shell.tsx`). Without this the overlay never paints.
2. **Telemetry Files rows** — `packages/ui/src/components/shell/TelemetryPanel.tsx`.
   A file row calls `openChanges({ scope: { kind: "session" }, repo, path, sessionKey })`.
3. **Fleet row Changes** — `packages/ui/src/components/fleet/**`.
   `openChanges({ scope: { kind: "agent", runId }, sessionKey })`.

§8.5 behaviour lives in the overlay: worktree vs shared checkout, a removed
worktree whose branch still exists, a gone branch that offers nothing.

## Adapter contract

`ChangesDataAdapter` in `data.ts`:

- `listChanges(scope) → ChangesList`
- `getFileDiff(scope, repo, path) → FileDiffPage` (unified patch + metadata, paged)
- `getFileSource?(scope, repo, path, "old" \| "new")` — hydrates expandable context
- `getAgentContext?(runId) → AgentChangesContext`

Replace the mock with `setChangesAdapter(real)` in one place when M18-T2 lands.
Do not implement `pi/project/*` here.

## Decisions to record

Existing, confirmed by this work: D-313 (Pierre), D-315 (split default), D-317
(lazy renderer).

Propose:

- **D-318** · Overlay find uses the shared walker with a roots policy.
  `[data-line]` is the value region inside Pierre's open shadow roots. The
  transcript's `data-search-content` contract is unchanged.
- **D-319** · Empty Pierre bodies (binary, mode-only, pure-rename) and the
  split→unified fallback at a width that cannot hold two code columns are
  Laser's own states, not the library's.
- **D-320** · Git actions in this leap stay an empty, marked toolbar slot
  (`data-slot="changes-git-actions"`). L6 fills it.

## Validation

```
pnpm install
pnpm -F @lasercode/ui test      # 282 files, 2652 passed, 1 skipped
pnpm -F @lasercode/ui typecheck # clean
pnpm -F @lasercode/ui build     # see main-chunk below
pnpm identity:check             # after git add
```

`pnpm verify` was not run. No browser matrix, no Playwright, no screenshots.

### Main-chunk measurement

Same command, this worktree, before any overlay code and after:

| | file | raw | gzip |
| --- | --- | --- | --- |
| before | `index-B64zWq7_.js` | 2,334.39 kB | 706.59 kB |
| after  | `index-CojTfdq0.js` | 2,334.54 kB | 706.62 kB |

Delta **+0.15 kB raw / +0.03 kB gzip**. Pierre is not in the main chunk
(`registerCustomTheme`, `diffs-container`, `@pierre` all absent from
`index-CojTfdq0.js`). Source guards: `overlay.tsx` dynamic-imports
`diff-body.js` and never mentions `@pierre/diffs`; `diff-body.tsx` always
passes `disableWorkerPool` and never references `worker/worker`.

Caveat: because `ChangesOverlayHost` is not yet imported from the app, this
build also omits overlay chrome. After the orchestrator mounts the host,
re-measure: main should grow by chrome only; Pierre must land in a separate
lazy chunk. The spike's +449 kB was a static import — that path is the
failure this lazy load exists to prevent.

## What to change in `code-diff.tsx` later

Not this milestone. For parity with the overlay: word-level diffs, the same
`--ok` / `--danger` tints Pierre already emits through Laser's Shiki theme,
and a shared empty-body row for binary / mode / rename so a tool result and
the overlay do not disagree. Keep the transcript on our `DiffView`; do not
mount Pierre in a message row.

## Visual acceptance — look at this first

Once the host is mounted and a file row opens it:

1. One modified file, split, both themes. Recolour by switching Appearance —
   no remount, no re-highlight.
2. 320-wide (phone): single column, tree as a sheet, unified notice once.
3. Binary, pure rename, mode-only: our sentences, never a blank Pierre body.
4. Huge file: collapsed with “Show the changed hunks”, then hunk expansion
   only (Virtualizer on).
5. Escape: back on the same scroll and the same draft.
6. Ctrl/Cmd+F inside the overlay: matches paint in the shadow tree; gutters
   and headers do not count.

Designed states covered in tests: no changes, one file, huge, binary, deleted
(patch), renamed, mode, failed repository, agent worktree / shared / removed /
branch gone.

## Corrections

Branch `agents/l5-overlay-corrections-2f464e09`. The overlay is mounted once in
`App` next to `Shell`. Call sites (telemetry Files, fleet Changes) are still
owned elsewhere.

### Blockers

| ID | Fix |
| --- | --- |
| B1 | `App.tsx` mounts `ChangesOverlayHost`. Main chunk after mount: `index-BK6npFA5.js` 2,381.01 kB / 719.73 kB gzip (before: `index-LY4fB5Qh.js` 2,343.84 / 708.74). Pierre is `diff-body-DmcBtl02.js` 310.16 kB / 80.31 kB gzip, absent from main. |
| B2 | Default adapter refuses with “Changes are not available in this view.” Host adapter talks to `pi/project/changes`, `file_diff`, `file_source`. Mock is tests-only (`setChangesAdapter(createMockAdapter())`). |
| B3 | `copy` events `preventDefault` and write clipped `text/plain` from the shadow root’s selection. Tested by dispatching a real `copy` event with fake `clipboardData`. |
| B4 | Find scrolls only on query/step. MutationObserver re-ranges without scrolling, debounced 80ms. |
| B5 | Restored `integrity:` on the three `@modelcontextprotocol/*` pkg.pr.new lockfile entries from `c61b7d22`. |

### Should-fix

| ID | Fix |
| --- | --- |
| S1 | Split-view matches deduped by excerpt so context lines count once. |
| S2 | Find matches live in state; status/excerpt/step use the current query. |
| S3 | Rail feeds `fileTreeFromChanges` per repository; keeps DiffStat and viewed tick. |
| S4 | Canonical `Dialog`/`DialogContent` (`showCloseButton={false}`, full-screen classes). |
| S5 | Range fields commit on Enter/blur via `committedRange`. |
| S6 | `openChanges` selects `repo`/`path` without setting `repoFilter`. |
| S7 | Unified-fallback notice is dismissible; split toggle disabled with the reason while it holds. |
| S8 | Truncated pages show “This patch is large…” and fetch `nextOffset` on demand. |
| S9 | `personFacingChangesError` keeps our sentences; stacks go to `console.warn`. |
| S10 | Chunk-graph test bundles `src/source-control/index.ts` with splitting: entry has no `@pierre`, a sibling does. |
| S11 | Tests for find status/hidden/dedupe, `nextHunkIndex`, `loadedDiffFiles`/`appendPatchPage`, prefs. |
| S12 | `ThemeRegistration` typed assignment, not `as never`. |
| Structure | `changesBodyState(...)` tagged union; overlay switches on it. |

### Nits

`@pierre/diffs` alphabetical in `package.json`. `formatBytes` from `@/format`.
Split/phone thresholds named. Overlay measures `--text-code` for mitigation 3.
Removed dead `keyboard` no-op, `isViewed`, `insideShadow`. Range inputs use
`pointer-coarse:text-base`. Line counts use the locale. Tabs are `role="tab"`
with `aria-controls` on `#changes-diff-panel`. Shortcuts listen on `document`
so they work while the phone file sheet has focus.


---

## Crash and chrome

Second pass over the overlay after the first live run against a sandbox host:
one release blocker, then the chrome judged against `packages/ui/DESIGN.md`
and `docs/ux-theme.md`. Files touched: `packages/ui/src/source-control/**`,
`packages/ui/test/source-control/**`. Nothing outside that tree changed.

### The blocker: opening a file took the window into the error boundary

`App.tsx` mounts `ChangesOverlayHost` as a **sibling** of `Shell`, and `Shell`
is where the app's one `TooltipProvider` lives. Every tooltip the overlay
draws — the toolbar's icon buttons, the find bar's stepper, and now the tab
and rail hints — therefore rendered with no provider above them, and Radix
threw `` `Tooltip` must be used within `TooltipProvider` `` during the render
that opened the dialog. React context does reach a portal, so the portal was
never the cause; the mount point was. Every existing jsdom test mounted the
host inside its own provider, so nothing caught it.

Fix: `ChangesOverlaySurface` wraps the overlay and the git dialog in the
project's own `TooltipProvider` (`packages/ui/src/source-control/overlay.tsx`).
The overlay is a window of its own and now carries its own tooltip context
wherever it is mounted; nesting one provider inside another is harmless, so
this stays correct if the host is ever moved inside `Shell`.
`components/ui/tooltip.tsx` was **not** touched: the provider is generic and
correct, and the defect was entirely in this tree's mounting assumption.

Audit of every tooltip under `src/source-control/**`: `toolbar.tsx`
(three `TooltipIconButton`s), `overlay-find.tsx` → `ConversationSearch`
(three more), and the hints added in this pass (`tabs.tsx`, `rail.tsx`,
`git-toolbar.tsx`, `states.tsx`) — all inside the provider added above.
`git-dialog.tsx` had no tooltip and now has none.

Regression test: `test/source-control/overlay-chrome.test.tsx` mounts
`<ChangesOverlayHost />` **alone**, exactly as `App.tsx` does, with no ambient
provider, and asserts toolbar, tab strip, rail and body render. Mutation
evidence: deleting the `TooltipProvider` wrapper from `ChangesOverlaySurface`
turns all six tests in that file red with the production error
`` `Tooltip` must be used within `TooltipProvider` ``; restoring it turns them
green again.

### Chrome

| Change | Reason |
| --- | --- |
| Toolbar degrades through a planned tier (`overlayToolbarPlan`/`overlayToolbarCost` in `classify.ts`), rendered by `data-tier` | "Fits 288px" is now arithmetic that a test holds, not a hope. Labels go first ("This session" → "Session", "Git ⌄" → the icon, "Files" → the panel icon), then secondary controls (Commit into the menu, the split toggle where the body cannot hold two columns anyway), then the totals take their own line. Type size is never part of the answer. |
| `ChangeTotals` (`totals.tsx`) replaces `DiffStat` in the toolbar and rail | `+1 204 −318`: grouped with a no-break space, mono at the 12px floor, tabular, `--ok`/`--danger` for the two directions. |
| Git host status left the toolbar row | It was a sentence clipped to `max-w-48` with a native `title`. One `useGitToolbarState` hook now feeds both the controls and a full-width `GitHostStatusLine` under the row, in `--attention` with the whole sentence in a hint. |
| Tab strip rebuilt | Mono name that truncates in its **middle** (`truncatableParts`, keeps `.tsx`), the status mark plus an `sr-only` status word, selected state = the body's ground plus one hairline (no filled pill), and a real close **button** that appears on hover/focus, is in the tab order, and is 44px on a coarse pointer. The old close affordance was a `role="presentation"` span: unreachable by keyboard and invisible to AT. |
| Rail is a tree | Depth is drawn with one hairline rail per level instead of blank padding; the file name keeps its extension when it truncates; the per-file icon went (the status mark already says what the row is); `+/−` tabular and at the end; the viewed tick is invisible until it is on, focused, hovered, or on touch. Repo rows show the leaf name with the full path and branch in a hint. |
| Body states have a shape | `ChangesNotice` is start-aligned at the body's own rhythm (`px-4`), title in `--text-md` 600, then **what happened** and **what it means or what to do**, then the act. Every designed state — binary, mode, rename, deleted, large, no-changes, no-git, untouched, unsupported, repo failed, diff failed, agent branch gone, and both loading states — now has both lines, and a test asserts each renders at least two sentences. |
| No card inside a card | The git dialog's file list and PR comment list were bordered rounded boxes inside a dialog that is already a card; both are hairline-separated lists now. The overlay's own chrome carries no `border …-line` at all: `hairline-b/e/t` only. |
| Icons | Loose icons (tab close, rail folder, rail tick, rail chevron) are `size-4` (16px). Icons **inside** `Button`/`TooltipIconButton` keep the size their variant sets (`sm` → 14px), which is the design system saying otherwise; overriding them would have made this one toolbar disagree with every other toolbar in the app. No icon sits in a decorative circle. |
| Misc | `[@media(pointer:coarse)]:` → the `pointer-coarse:` variant throughout; `max-w-[40%]` → `max-w-2/5`; the phone sheet's title is a real header on a hairline. |

### Mitigations, unchanged

Renderer still lazy: `pnpm -F @lasercode/ui build` puts `@pierre/diffs` in
`dist/assets/diff-body-CrBN4PA5.js` (310.16 kB / 80.31 kB gzip). The startup
chunk `dist/assets/index-p8rbKHRT.js` (2,428.44 kB / 733.27 kB gzip) contains
no library code from it — the only `pierre` substrings in it are our own
`pierreType` field from `classify.ts`.

Measured against this branch's base (`e2ebfcb7`, the same tree with this
leap's `src/source-control` and `test/source-control` checked out and the new
files removed):

| chunk | before | after |
| --- | --- | --- |
| startup `index-*.js` | 2,423.81 kB / 731.56 kB gzip | 2,428.44 kB / 733.27 kB gzip |
| renderer `diff-body-*.js` | 310.16 kB / 80.31 kB gzip | 310.16 kB / 80.31 kB gzip |

— `+4.63 kB` raw, `+1.71 kB` gzip in the startup chunk for the toolbar plan,
the totals component, the hints and the longer state copy; the renderer chunk
is byte-identical and still nowhere near startup.
`test/source-control/diff-body-guard.test.ts` still pins the split. Our own
empty states, the 320px unified fallback, bounded expansion and
`disableWorkerPool` are untouched.

### Validation

```
pnpm install --frozen-lockfile    # lockfile up to date
pnpm -F @lasercode/ui test        # 307 files, 2815 passed, 1 skipped
pnpm -F @lasercode/ui typecheck   # clean
pnpm -F @lasercode/ui build       # chunks above
pnpm identity:check               # after git add: clean
```

Two of the three full runs finished green end to end; one intermediate run
exited non-zero under load without naming the file in the captured tail, and
nothing in this tree reproduced it across the runs after it (the known
load-flaky files are listed in `STATUS_DETAILED.md`).

Source-control tests alone: 21 files, 91 passed. New: `overlay-chrome.test.tsx`
(6, mount-shaped, pointer and keyboard), `toolbar-fit.test.tsx` (4, the 288px
plan and the header that obeys it), `chrome-tokens.test.ts` (3, no literal
colour, no raw type size, no arbitrary spacing step, no card in a card).
No Playwright, no browser matrix, no `pnpm verify`: the visual review is the
orchestrator's.
