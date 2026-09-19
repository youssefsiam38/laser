# The changes overlay's diff: typography, expansion, controls (M20-T5)

Branch `agents/overlay-diff-typography-and-expansion-5bc5646c`, from
`f2a88086e60dc07941311e5d8525c51ba2b58532`.

The renderer stays. `@pierre/diffs` draws split view, word-level intra-line
diffs, the gutter, hunk structure and virtualization better than anything we
would write, and that is why it was adopted (D-313). What was wrong was our
half of it: the type it painted with, the controls around it, and a row that
promised something nothing could deliver.

---

## 1. How our typography reaches the shadow root

**What was wrong.** Measured in the running app, inside the overlay's
`diffs-container` shadow root: `[data-line]` reported **`SF Mono` 13px/20px**
and the host reported **`system-ui`**. Neither exists on this machine, so the
browser fell back to whatever it had — the "pixelated" diff. Our *colours*
already reached it (the Shiki theme is Laser's own, emitting
`style="color:var(--syntax-*)"`), our *type* never did, because the library
reads it from its own variables and its own fallbacks:

```css
:host  { font-family: var(--diffs-header-font-family, system-ui, …);
         font-size:   var(--diffs-font-size, 13px);
         line-height: var(--diffs-line-height, 20px); }
pre, code { font-family: var(--diffs-font-family, "SF Mono", Monaco, …); }
```

**The documented option, taken.** Those `var(--diffs-*, fallback)` hooks *are*
the library's supported way in — there is no `font` prop in the installed
`.d.ts` (`BaseCodeOptions` / `BaseDiffOptions` carry no typography at all), and
`unsafeCSS` is the escape hatch the spike told us not to use. Custom properties
inherit through a shadow boundary, so they are set in two places, on purpose:

| Where | File | Why both |
| --- | --- | --- |
| The light-DOM wrapper, as inline custom properties | `DIFF_HOST_VARS` / `DIFF_HOST_STYLE`, `src/source-control/diff-typography.ts` | The **first painted frame** is already our face. No observer, no effect, no flash of `SF Mono`. |
| One constructed stylesheet appended into every `diffs-container` root | `DIFF_TYPOGRAPHY_CSS` / `adoptDiffTypography`, same file | Carries what a variable cannot say: tabular figures on `[data-column-number]`, the separator's sans label at the 12px floor, and the expander's box, radius, hover and focus. |

The mapping:

| Pierre variable | Laser token |
| --- | --- |
| `--diffs-font-family` | `var(--font-mono)` |
| `--diffs-header-font-family` | `var(--font-sans)` |
| `--diffs-font-size` | `var(--text-code)` |
| `--diffs-line-height` | `var(--text-code--line-height)` |
| `--diffs-font-features` | `"tnum" 1, "calt" 0` (what `globals.css` does to every `code`/`pre`) |
| `--diffs-fg-number-override` | `var(--ink-3)` |
| `--diffs-gap-inline` / `--diffs-gap-block` | `calc(var(--space-unit) * 2)` |

The sheet is **unlayered**. Pierre's core CSS lives in `@layer base`, and an
unlayered declaration beats a layered one whatever the specificity, so none of
our rules has to out-specify theirs.

**The trap, respected.** `adoptDiffTypography` *appends*:
`root.adoptedStyleSheets = [...root.adoptedStyleSheets, sheet]`. Their
constructor assigns `adoptedStyleSheets = [coreSheet]`; replacing the array
takes their core CSS away and the diff stops painting entirely
(`docs/source-control-spike-evidence.md` §4). `useDiffShadowChrome` re-runs the
pass when a root is rebuilt, and observes **each shadow root in its own right**,
because an expansion mutates the tree *inside* the root where a light-DOM
observer never sees it.

There is no px and no colour literal in that stylesheet: sizes are
`calc(var(--space-unit) * 8)` (what `h-8` compiles to) and `* 11` (`min-h-11`),
and the only non-token length is the focus ring's 2px, which is the app's own
`outline-2`.

Pinned by `test/source-control/diff-typography.test.ts` (7 tests) and
`test/source-control/diff-body.test.tsx` ("carries our type into the light-DOM
host").

---

## 2. How context expansion works, and what it costs

**Root cause.** The dead row is Pierre's, and it has exactly one cause:
`DiffHunksRenderer` writes `"More unchanged context may be available"` when
`collapsedLines` is unknown, which happens only for
`isFinalHunkRow && canHydrateCollapsedContext(fileDiff, loadDiffFiles != null)`
— that is, a **patch-parsed (`isPartial`) diff handed over together with a
`loadDiffFiles` loader**. The old `DiffBody` did exactly that. The renderer
knew more text existed somewhere but not how much, so it wrote a sentence about
a promise, and the expanders it drew depended on an async fetch nobody could
see fail.

**What it does now.** The overlay fetches both sides itself (the adapter
already owns `pi/project/file_source`) and hands the renderer a **hydrated,
non-partial** diff, built with `hydratePartialDiff("clone", …)` — a documented
export. `loadDiffFiles` is never passed. So:

- `isPartial === false` ⇒ `isExpandableDiff` is true ⇒ every separator gets
  `data-expand-index` and its expander controls;
- every gap has a real size, so the row reads "26 unmodified lines", not a
  promise;
- `"More unchanged context may be available"` is **unreachable by
  construction**: partial input never gets a loader, hydrated input is never
  partial.

Proved against the real library, without a browser, in
`test/source-control/diff-expansion-render.test.ts` — it renders the same
patch through `@pierre/diffs/ssr`'s `preloadFileDiff` three ways:

| Input | dead row | gap sizes | `data-expand-index` |
| --- | --- | --- | --- |
| patch + `loadDiffFiles` (the old path) | **present** | trailing gap unnamed | yes |
| hydrated, no loader (the new path) | absent | `26 unmodified lines`, `27 unmodified lines` | yes |
| patch alone (no sides available) | absent | `26 unmodified lines` | **no** — nothing to press |

**The control.** Pierre draws its expanders as `div[role="button"]` with no tab
stop, no accessible name and no keyboard path (spike criterion 4: *"hunk
expanders are not keyboard-operable"*). `diff-expand.ts` equips them in place,
without wrapping, re-parenting or re-texting anything the renderer owns:

- `tabindex="0"` — a real tab stop, one per direction;
- `aria-label` that says what the press reveals, clamped to the gap:
  `Show 24 unchanged lines above`, `Show 5 unchanged lines above`,
  `Show 1 unchanged line above`;
- `Enter` and `Space` activate it (a listener on the light-DOM wrapper, reaching
  in through `composedPath()`), because a `div[role=button]` gets neither for
  free and Space would otherwise scroll the diff;
- the box: 32px on a fine pointer, 44px on a coarse one, `--radius-md`,
  `--ink-3` going to `--ink` on a `--surface-2` hover, and the product's one
  focus ring. Pierre's own multi-button layout stacks up and down in a single
  34px column at 50% height each — a 17px control — and our sheet lays them
  side by side at full height instead.

Every write is compared before it is made, because the pass runs *from* a
`MutationObserver` and an unconditional `setAttribute` would observe itself
forever. Labels refresh as the gap shrinks (tested by mutating the shadow tree
and waiting for the observer, not by calling the function again).

**When it cannot be done, we say so.** `expandableSides` (in `diff-files.ts`)
classifies the file, and `expansionNotice` writes the sentence:

| State | What it means | What the person sees |
| --- | --- | --- |
| `unsupported` | added, deleted or pure rename — there was never a second side | nothing; expansion is not a thing here |
| `loading` | the two sides are in flight | nothing; the hunks are already painted |
| `ready` | hydrated | the expanders |
| `unavailable` | no `getFileSource`, a rejected request, or a null side | "The unchanged lines around these changes could not be read, so this file opens at its hunks only." |
| `too-large` | the authority could only send part of a side | "This file is too large to read whole, so only the lines around each change are shown." |

`too-large` is not a nicety. Hydration rewrites every hunk's line index against
the arrays it is given, so a **prefix** of a file is worse than no file: the
diff would render at plausible but wrong line numbers. `FileSource` gained a
`truncated` flag (set from `FileSlice.truncated` in `host-adapter.ts`) and a
truncated side is refused outright.

**What it costs.**

- Two extra `pi/project/file_source` requests per file opened, issued *after*
  the patch has painted. The hunks — the thing a person came for — are never
  behind them.
- Both sides of the file in memory for the open file, bounded by
  `FILE_DIFF_MAX_BYTES` at the protocol (anything over comes back `truncated`
  and is refused).
- Bounded expansion is unchanged and now explicit: `expandUnchanged: false`,
  `expansionLineCount: 24` (one press opens a screenful, never a file), the
  `Virtualizer` still wraps `FileDiff`, and a file over
  `LARGE_DIFF_LINE_LIMIT` (2000 changed lines) still opens collapsed behind
  `LargeFileState` before any of this runs.
- Build cost: see §5.

**Nothing is missing from the engine.** `pi/project/file_source` already
returns what hydration needs, including `truncated`, and
`pi/project/file_diff`'s `context` parameter was not needed — expansion is
per-hunk inside the renderer rather than a re-request of the whole file.

---

## 3. The control sizes, and why

Measured before: toolbar buttons **28px tall with 12px labels** (`Button
size="sm"`), tab and rail rows 32px.

| Control | Before | Now | Why |
| --- | --- | --- | --- |
| Scope picker, repository picker, Files, Commit, Git | `size="sm"` — 28px, 12px label | `size="default"` — **32px, 13px label** | A surface that takes the whole window does not put its primary actions at the floor. `default` is the project's own `h-8` + `text-sm`. |
| Close, split/unified, Files (icon form) | `icon-sm` — 28px | `icon` — **32px**, plus `pointer-coarse:size-11` | "Icon-only buttons keep a 32px hit box"; coarse pointers keep 44px, which `TooltipIconButton` did not carry before. |
| Range From/To fields | `h-7`, 12px labels | `h-8`, 13px labels, `pointer-coarse:min-h-11` | Same row, same idiom. |
| Hunk expanders (inside the shadow root) | 34×17px, no focus state | **32px** fine / **44px** coarse, hover + focus | §2. |
| Rail header, "viewed" counts, notices | `text-xs` | `text-sm leading-sm` | The 12px floor is for *values*, not for prose. |
| Rail repository name | mono 12px | 13px sans, medium | A repository is a name. The branch beside it stays typed — it is a git ref. |
| File names, marks, totals, branch | `typed` (mono, 12px, tabular) | unchanged | Mono at the code size, so a file name in the rail, in a tab and in the diff are the same size. |
| Tab close | `size-6` (24px) | `size-7` (28px) inside a 32px row | A secondary affordance inside a row, not a primary action. |

**The toolbar plan was re-proved, not hoped.** `OVERLAY_TOOLBAR_COST` is
arithmetic over the *actual* control sizes, so raising them changes what fits.
Re-measured from the `default` button (`h-8`, `px-3`/`px-2.5`, 13px) the
compact tier (480–639px) no longer affords the word "Files" — 484px of content
in a 480px row. It now uses the icon, like the tight tier: the icon opens the
same sheet, and the totals are information where the label is chrome.
`test/source-control/toolbar-fit.test.tsx` proves every tier's row and second
row fit their width at 288 / 320 / 360 / 480 / 640 / 768 / 1024 / 1440, and a
new test forbids the `sm` / `xs` / `icon-sm` / `icon-xs` steps in this toolbar
and requires a coarse-pointer target on every button.

**The git host sentence moved.** "Add a GitHub or Bitbucket remote, then try
again." sat permanently under the toolbar in attention colour, as the second
thing a person read on a screen they opened to read a diff. `GitHostStatusLine`
is deleted; the same sentence was already inside the Git menu
(`data-slot="git-menu-status"`), beside the actions it explains, and the test
now asserts both halves: absent from the row, present in the menu with the
"Other repositories still work." tail.

**On "the only bordered pill in a flat toolbar":** in the source as it stands
both pickers are `variant="ghost"` with a chevron and no border, so there was
no pill to remove. What I did instead was make them one idiom in every
respect — same variant, same size, same 13px label, same coarse target — and
give the scope picker a `data-slot`. The one genuinely bordered thing in that
header is the range `Input` pair, which is a field and should be bordered; it
was raised to the same 32/44px geometry.

---

## 4. What I took from the assistant-ui idiom

Not a design, and not any colour: ours are fine and unchanged. What I borrowed
is *proportion and behaviour*, from `surfaces.tsx`, the shared vocabulary the
adopted elements already build on:

- `activityDisclosure` — `size-8 pointer-coarse:size-11`, `rounded-md`,
  `text-ink-3` → `hover:bg-surface-2 hover:text-ink`, focus
  `outline-2 -outline-offset-2 outline-live`. That is exactly the expander's
  box, radius, ink, hover and focus inside the shadow root, expressed in plain
  CSS because Tailwind classes cannot cross the boundary.
- `activityRowLayout` — `min-h-8 pointer-coarse:min-h-11 … text-sm`: a row is
  32/44px with a 13px label. That is the rail row, the tab and the toolbar
  control.
- The catalog's own rule that a value is mono at the floor and prose is not:
  `surfaces.tsx` notes it deliberately raised the registry's 11px `mono` to our
  12px floor. File names, refs and counts stay `typed`; sentences went to 13px.

I did not import, copy or edit anything under
`components/assistant-ui/elements/` — that surface is someone else's.

---

## 5. The five mitigations (`docs/source-control-leap.md` §8.3a)

| Mitigation | State | Evidence |
| --- | --- | --- |
| Renderer stays a lazy chunk | held | `dist/assets/diff-body-D666pM9_.js` 316.84 kB / 82.65 kB gzip carries every `@pierre/diffs` byte (3 occurrences of `diffs-container`); the startup chunk `index-CUV8LCoj.js` 2,432.09 kB / 734.73 kB gzip contains **zero** occurrences of `diffs-container` and the only match for `pierre` is our own identifier `pierreType`. `test/source-control/diff-body-guard.test.ts` still pins the split. |
| Our own empty states | untouched | `classifyDiffPage` / `EmptyBodyState` still run before the renderer mounts, now from the same parsed metadata. |
| Our own unified fallback below the two-column width | untouched | `splitColumnsFit` / `setUnifiedFallback` in `overlay.tsx`. |
| Mandatory virtualization, bounded expansion | strengthened | `Virtualizer` still wraps `FileDiff` (asserted in `diff-body.test.tsx`); `expandUnchanged: false`; `expansionLineCount: 24`; a truncated file side is refused rather than hydrated. |
| Worker pool off | untouched | `disableWorkerPool` still passed; nothing references the worker URL. |

Delta against the previous measurement (`docs/leap/l5-report.md`: startup
2,428.44 kB / 733.27 kB gzip, renderer 310.16 kB / 80.31 kB gzip):
**+3.65 kB raw / +1.46 kB gzip** in the startup chunk (the expansion policy and
the larger toolbar plan) and **+6.68 kB raw / +2.34 kB gzip** in the renderer
chunk (the stylesheet, the shadow pass and the hydration call). The DOM-touching
half of expansion lives in `diff-expand.ts` / `diff-shadow.ts`, imported only
from the lazy chunk; the pure policy half lives in `diff-files.ts`, which the
overlay shell imports eagerly.

---

## 6. What the transcript would need to adopt this renderer

The person's direction is that the transcript's `code-diff.tsx` should
eventually rise to Pierre, not the other way round. It is not done here and
nothing in `components/assistant-ui/elements/` was touched. What it would take:

**The input is the gap.** `CodeDiff` takes a `view` — already-parsed hunks,
a path, stats and a `truncated` flag — derived from an `edit`/`write` tool
call's arguments. Pierre takes either a unified **patch string**
(`parsePatchFiles`) or two `FileContents`. So the transcript needs one of:

1. the tool call's `oldText`/`newText` fed straight to `parseDiffFromFile(old,
   new)`, which yields a **non-partial** diff — the best case, because
   expansion works with no fetch at all and no adapter; or
2. a synthesised unified patch from the existing `view`, which gives a partial
   diff, hunks only, and no expansion — acceptable for a two-line `edit`.

**The props, concretely.** `<FileDiff fileDiff={…} options={…}
disableWorkerPool />` wrapped in `<Virtualizer>`, with the overlay's option set
minus what an inline diff does not want: `diffStyle: "unified"` always (a
message column has no room for two), `disableFileHeader: true` (the tool row
already names the file), `hunkSeparators: "line-info"`, `lineDiffType: "word"`,
`theme: LASER_SHIKI_THEME.name`, `themeType` from `useThemeBase()`.
`registerCustomTheme` must have run once — it is idempotent, but the name must
equal `theme.name` or the diff never paints.

**The lazy boundary has to move.** `diff-body.tsx` is behind `React.lazy` from
`overlay.tsx`, which is why 316 kB of renderer never reaches startup. A
transcript diff is on the **first paint of a conversation**, so it must be
lazy too, per tool row, with a real fallback — the existing `CodeDiffRows`
output is the natural one, so the row does not jump. Otherwise the whole
315 kB lands in the startup chunk and every mitigation in §5 is undone.

**Three things would have to change for an inline diff.**

- *Height.* The overlay gives the renderer a flex-`1` box in a full-screen
  column. A transcript diff is inside a scrolling message list, so it needs an
  intrinsic height with a cap (today `max-h-96`), and `Virtualizer` needs a
  scroll parent it can measure — this is the one thing I would prototype first.
- *Typography and chrome.* `DIFF_HOST_STYLE` and `adoptDiffTypography` are not
  overlay-specific; they would be lifted to a shared module and applied the
  same way. The expander equipping (`useDiffShadowChrome`) is likewise reusable,
  but an inline diff probably wants `expansionLineCount` smaller than 24.
- *Find and copy.* The transcript's find walks `[data-search-content]`
  (`docs/search-content.md`); Pierre's DOM has no such attribute and uses
  `[data-line]` as the value region, which is why the overlay carries
  `DIFF_LINE_FIND_POLICY`. Adopting Pierre in the transcript means either
  teaching the transcript's find about `[data-line]` inside open shadow roots
  (the `collectOpenShadowRoots` machinery already exists) or losing find inside
  tool diffs. Copy is already clean — the gutter is `user-select: none`.

**The adapter.** Expansion in the transcript would need file contents the tool
call does not carry. `pi/project/file_source` is session-scoped and the
transcript has the session, so it is reachable — but that is a second caller of
`ChangesDataAdapter` from outside the overlay, and the adapter is currently a
module-level singleton bound by the overlay host. Either the transcript stays
at option (1) above and needs no adapter at all, or the adapter becomes
context-provided. Option (1) is much the better path.

---

## 7. What I could not fix

- **The visible words on the expander row are Pierre's**, not ours: it writes
  `"26 unmodified lines"` (the size of the gap). The brief asked for
  `Show 24 unchanged lines` as the visible label. The text node belongs to the
  renderer and is rebuilt on every expansion, so rewriting it would mean
  fighting the renderer on every frame and breaking find's ranges. Instead the
  *control's accessible name* states the reveal exactly
  (`Show 24 unchanged lines above`), and the visible number stays the honest
  gap size. Changing the visible copy needs an upstream option — a
  `renderSeparatorContent` callback alongside the existing
  `renderHeaderMetadata`; `hunkSeparators` as a function exists but is marked
  deprecated in the installed `.d.ts`, so it is not the right seam to build on.
- **I did not open a browser.** The brief forbids Playwright and
  `scripts/browser-check` and reserves visual verification for the person. The
  computed font family inside the shadow root, the expander's behaviour under a
  real pointer, and the control heights are for that pass. What is proved here
  is the stylesheet's content and adoption, the rendered HTML of the expansion
  path against the real library, the keyboard path against a real open shadow
  root, and the toolbar's arithmetic.
- **Split-view expanders.** Pierre hides the expander in the additions column
  and draws it only in the deletions gutter (its own CSS). That is its layout
  decision and I left it alone; it means the control sits on the left of a
  split diff.
