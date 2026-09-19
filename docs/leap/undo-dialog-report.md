# Undo this turn — the ghost, and what the confirmation now says

Source-control leap, M20-T2 (§7.4). Branch `agents/undo-dialog-depth-and-ghost-8e0ff36d`.

## 1. The ghost: why the dialog never left the screen

### What was seen

Open **Undo this turn**, press Cancel or Escape: the dialog's node stays in the
document with `data-state="closed"`, `display: grid`, `visibility: visible`,
still painted over the transcript, with a live "Cancel" button. Re-opening does
not clear it; only a reload does.

### The real cause

Radix decides whether a closed dialog may be removed from
`@radix-ui/react-presence` (1.1.10, `usePresence`):

```js
} else if (currentAnimationName === "none" || styles?.display === "none") {
  send("UNMOUNT");                       // nothing to wait for
} else {
  const isAnimating = prevAnimationName !== currentAnimationName;
  if (wasPresent && isAnimating) send("ANIMATION_OUT");   // → "unmountSuspended"
```

`unmountSuspended` is only left by an `animationend`/`animationcancel` event on
that exact node. The decision is taken from the **computed `animation-name`**,
not from whether an animation exists.

Our dialog (`components/ui/dialog.tsx`) carries:

```
animate-in fade-in-0 duration-(--motion-instant)
data-[state=closed]:animate-out data-[state=closed]:fade-out-0
```

which compiles (verified in `dist/assets/index-*.css`) to
`animation: exit var(--tw-animation-duration, var(--tw-duration, .15s)) …`,
with `--tw-duration: var(--motion-instant)`.

`--motion-instant` is `0ms` whenever motion is reduced —
`theme/compile.ts:161` (`const off = theme.motion === "reduced"`) and the
`@media (prefers-reduced-motion: reduce)` block in `globals.css:672`.

**Chromium creates no animation at all for `animation-duration: 0s`, while
still computing `animation-name: exit`.** Measured directly (Chromium via
Playwright, `about:blank`, one `@keyframes exit`):

| `animation-duration` | `element.getAnimations()` | events delivered |
| --- | --- | --- |
| `0s` | `[]` | none, ever |
| `0.01ms` | `["exit:running"]` | start + end |
| `75ms` | `["exit:running"]` | start + end |

`getComputedStyle(el).animationName` read `"exit"` in all three cases.

So with Motion set to reduced: `currentAnimationName` is `"exit"` (not
`"none"`), Presence goes to `unmountSuspended`, no animation ever runs, no
`animationend` is ever dispatched, and the node stays in the document for the
life of the page. Both Presences do it — the portal's and the content's — so
the overlay stays too, which is the "half-faded" wash over the transcript.

It is not a `forceMount`, not a state that flips content without the open flag,
and not an exit animation that half-finishes: it is an exit animation that was
promised and never started.

Note the same hole opens for any lost animation event (a frame loop that is not
running, an occluded window). The fix does not depend on the event at all.

### The fix

`packages/ui/src/components/thread/dialog-presence.ts` — `useDialogPresence()`:
the dialog element is rendered only while `mounted`; `open` still drives
Radix's fade; closing sets `open` false and, one exit window later, takes the
element out of the tree whether or not anything ended. The window is read from
the live `--motion-instant` token (`dialogExitMs`), so a full-motion fade plays
to its end and a reduced-motion close is immediate-ish; when the token cannot
be read the fallback is 160 ms.

The shared `components/ui/dialog.tsx` is where this ultimately belongs (one
`Presence` guard for every dialog in the app). That surface is owned by another
worker right now, so the hook lives in the transcript and is applied to every
dialog there that survives its own close.

### The same pattern elsewhere in `components/thread/**`

| Dialog | Kept mounted while closed | Now |
| --- | --- | --- |
| `UndoTurn` | yes — the reported bug | `useDialogPresence` |
| `GoalBar` · Edit goal | yes | `useDialogPresence` |
| `GoalBar` · Clear this goal? | yes | `useDialogPresence` |
| `ProjectLine` · Create a pull request | yes | `useDialogPresence` |
| `BodyOverflow` · full-output viewer | yes | `useDialogPresence` |
| `FileOpener` · `FileViewer` | no (`{opened ? … : null}`) | unchanged |
| `prompt-actions` · `AttachmentBrowser` | no (`{open ? … : null}`) | unchanged |
| `messages.tsx` · `ApiRequestDialog` | no (`{requestOpen && …}`) | unchanged |

Dialogs outside `components/thread/**` were not audited; the same shape almost
certainly exists (shell, settings, fleet), which is the argument for moving the
guard into the shared dialog.

### Pinned

`test/thread/dialog-presence.test.tsx` and
`test/thread/undo-turn-presence.test.tsx` stand in the browser this bug lives
in: computed `animation-name` follows `data-state` and **no** animation event is
ever delivered. Cancel, Escape, a finished restore and re-open must each leave
nothing behind.

Mutation evidence — make the hook always mounted (`return { mounted: true, … }`,
which is the pre-fix structure):

```
× useDialogPresence > takes the dialog out even when no exit animation ever ends
× useDialogPresence > takes it out on Escape too, and opens again cleanly
✓ useDialogPresence > leaves the browser's own exit in charge when it works
× the undo confirmation leaves the document > is gone after Cancel …
× the undo confirmation leaves the document > is gone after Escape
× the undo confirmation leaves the document > is gone after a restore that succeeded
× the undo confirmation leaves the document > re-opens after it was closed …
      Tests  6 failed | 3 passed (9)
```

with the fix in place: `Tests 9 passed (9)`.

## 2. What the confirmation shows now

One dialog, sections inside it — no card inside a card. Top to bottom:

1. **Title and the restore sentence** (unchanged).
2. **One summary line**: `7 files in 2 repositories · +42 −7 · turn 3, 14:05`.
   The repository count appears only when there is more than one; the `+/−`
   only when something lent numbers; the turn is counted from one and carries
   the prompt's own time.
3. **The target radios** (unchanged; an option that would do nothing is still
   hidden, not disabled).
4. **The lists**, grouped by repository, in their own scroll container:
   - repository leaf name · branch · per-repository total (`3 files · +42 −7`),
   - eyebrow **Restored files**, then one row per path,
   - eyebrow **Uncommitted work that would be lost** in the danger token, then
     its rows.
   Each row: path (mono, 12 px, truncating, full path in the accessible name),
   its status (`added` / `modified` / `deleted` / `binary`) and its
   `+added −removed`, tabular and right-aligned. A binary file says `binary`
   instead of numbers. A path nothing knows numbers for shows bare.
5. **The destructive sentence**, outside the scroller so it cannot be scrolled
   away, with a danger rule: *"4 files with uncommitted changes are overwritten
   by the checkpoint's version."*
6. The staging sentence (D-321) and any engine refusal, unchanged.
7. Cancel / Undo this turn.

The two truths are deliberately not symmetrical: what is put back is quiet
(neutral eyebrow, inside the scroller), what is destroyed is named, counted and
carried in the danger token outside it.

**Every file row opens the diff**: click, Enter or Space calls
`openChanges({ scope: { kind: "turn", turnId }, repo, path, sessionKey })` from
`@/source-control/store.js` (the store, never the barrel — D-317). The
confirmation closes as it does so: a modal dialog traps focus and hides the
rest of the document from assistive technology, so the overlay cannot usefully
open behind it. Enter on a row is never the confirmation.

## 3. Where the numbers come from

Opening the dialog fires three requests in parallel:

| Request | For |
| --- | --- |
| `pi/project/restore` (no `confirm`) | which paths move, per repository — the truth about the restore |
| `pi/project/changes` `scope: "turn"`, `turn: N+1` | numbers for the work being taken back |
| `pi/project/changes` `scope: "uncommitted"` | numbers for the work being destroyed |

The preview owns the paths; the change lists only lend numbers, joined by exact
repository path + file path. Nothing is invented: an unmatched path renders
without numbers, and a repository total counts only the rows it actually has
(`4 files` rather than `4 files · +0 −0`). Both change requests are
best-effort — a refusal or a pruned range costs the numbers, never the paths or
the dialog.

**The off-by-one is real and deliberate.** Checkpoint `turn` is the snapshot
standing *before* prompt ordinal `turn`'s work (turn 0 is the open-time
baseline), while `pi/project/changes` numbers turn *N* as the range between
checkpoint *N−1* and checkpoint *N*. So the work this undo takes back is scope
`turn: turn + 1` — which is also why the engine's refusal for scope `turn: 0`
("the open-time baseline is not a conversation turn") is never hit from here.
`changesTurnForUndo` is that single conversion, and the overlay is opened on the
same turn id, so the dialog and the diff always show the same range.

What the engine cannot give us today, and what we therefore do not show:

- **Renames.** `ChangedFile.status` in `packages/protocol/src/source-control.ts`
  is `added | modified | deleted` only; the overlay's local contract has
  `renamed`, the protocol does not. A rename appears as its two sides.
- **Numbers for later turns.** Restoring checkpoint *N* also reverts turns
  *N+1…*; only turn *N+1*'s range is fetched, so paths that moved in a later
  turn and are not also uncommitted show bare. Fetching a `range` scope
  (`fromRef` = checkpoint *N*, `toRef` = worktree) would cover it exactly, but
  the UI does not have those refs without a new protocol field.

## 4. How the list is bounded

- Six rows per section per repository (`UNDO_ROWS_SHOWN`), then an explicit
  `and 23 more` button that expands that section in place.
- The lists live in one `max-h-64` scroll container with `overscroll-contain`;
  the summary, the destructive sentence, the staging sentence and both actions
  are outside it, so the actions stay visible.
- A 900-file turn therefore renders 6 rows and a count per repository, and a
  dialog no taller than its own cap — never 900 rows, never taller than the
  viewport.

## 5. What to try first

1. Settings → Appearance → **Motion: reduced** (this is the state the bug lived
   in). Open a finished turn's Undo, press Escape. Nothing must remain; the
   transcript must be clickable. Repeat with Cancel, and with a real restore.
2. A turn that touched several files: check a row's numbers against the changes
   overlay for the same turn, and that the repository total is their sum.
3. Click a file row: the changes overlay opens on that file, on the same turn,
   and the confirmation is gone.
4. A turn with uncommitted work on top: the danger sentence names the exact
   count, and a binary file says `binary` rather than `+0 −0`.
5. Tab from Cancel backwards into the list, move through the rows, press Enter:
   the diff opens, nothing is restored.
6. Both themes, 320 px wide and desktop: no horizontal scroll, no clipped path,
   actions visible.
