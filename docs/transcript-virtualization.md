# The transcript's list, and why it is the list's job (M16-T91)

Status: the contract as built. It supersedes the M16-T87 contract on this
page (D-303), which adopted `@tanstack/react-virtual`; the history of why the
bespoke engine before that failed is kept at the bottom, because the reasons
still bind whatever replaces this.

## What was still wrong after M16-T87

TanStack owns one authority and anchors correctly, and reading upwards through
a long conversation stopped losing rows. One defect survived it, and it was
the one the person kept reporting: **text still moved while they read**.

The cause is in the shape of the fix, not in its execution. TanStack corrects
the scroll offset *after* a measurement changes: it learns a row's new height,
then compensates. The compensation is for the row as a whole, so content
growing *inside* the row the reader is in — above their line, which is where
late markdown work, syntax highlighting and formula layout land — moved their
text by exactly that much. `docs/transcript-reading.md` recorded that as an
accepted trade. It was not acceptable; it was the defect.

## The decision (D-306)

Adopt **`@legendapp/list` 3.3.5** (MIT, exact-pinned, peer `react` only, web
entry `@legendapp/list/react`) as the transcript's list, and hand it the
reader's position rather than correcting the reader's position afterwards.

The reference is `pingdotgg/t3code`, which renders the same surface — a chat
timeline with dynamic rows, prepended history and a live edge — on this list,
and does not have the trade above. Nothing is vendored from it. What is copied
is the design: which props, which values, and which of them are load-bearing.
`docs/transcript-parity.md` §3 is the brief.

Not adopted: Virtuoso's message list (commercial, and it owns the whole
surface rather than sitting under ours).

## What the list owns now

1. **Position across a prepend** — `maintainVisibleContentPosition.data`.
   A page of older messages arriving does not move the rows on screen. The
   list resolves the anchor and the new positions in the same pass, so there
   is no frame in which the wrong rows are mounted.
2. **Position across a row changing size** — `maintainVisibleContentPosition.size`.
   The row whose top is on screen keeps its top. Growth *above* the reading
   line — including growth inside the row the person is reading, which is the
   case D-303 could not hold — leaves their text exactly where it was.
3. **The live edge** — `maintainScrollAtEnd` as an options object,
   `{ animated, on: { dataChange: true, footerLayout: false, itemLayout: true,
   layout: true } }`. `footerLayout: false` is deliberate: the composer's
   inset is the list's own trailing spacer, and a composer growing a line must
   not move a message. `animated: true` only while a turn is streaming and
   `prefers-reduced-motion` is off; instant for session switches and layout
   settles.
4. **Which rows are mounted** — the reading window, plus `alwaysRender.keys`
   for the rows a surface is holding open.
5. **Every scroll position that follows a data or measurement change.** The
   only scroll positions Laser asks for are explicit intents — Jump to latest,
   a search hit, a deep link, Edit/Fork — and they go through the list's own
   `scrollToEnd`/`scrollToIndex`/`scrollToOffset`.

## What Laser still owns

Which rows exist, history paging and its fences, the live-edge *policy*
(whether to follow, not how), the unloaded-history placeholder, pins for
selection/focus/approvals/Find, the keyboard and gesture reading of what the
person meant, `content-visibility`, reduced motion, and every accessibility
guarantee. `docs/transcript-reading.md` is the working description.

## The pinned dependency and its patch

`@legendapp/list` is pinned exactly at `3.3.5` in `packages/ui` and patched
through `pnpm patch` (`patches/@legendapp__list@3.3.5.patch`, registered in
`pnpm-workspace.yaml`'s `pnpm.patchedDependencies`, so
`pnpm install --frozen-lockfile` reproduces it). The patch carries **only** the
`react.js` and `react.mjs` hunks of the reference's patch — its React Native,
`keyboard.*` and `reanimated.*` hunks do not apply, because Laser has no React
Native app. Four corrections, and why each one matters here:

1. **Anchored end space that shrank before it was ready.** When the trailing
   space is not yet resolved and the computed size has *shrunk*, publish the
   smaller size and bound it by the known-size bound, instead of holding a
   stale larger one. A held-open stale end space is trailing blank the person
   scrolls through.
2. **`Element.moveBefore` when reordering.** The list re-sorts its row
   containers into index order; `insertBefore` removes and re-inserts, which
   restarts CSS `@starting-style` transitions and reloads iframes inside a row.
   `moveBefore` moves the subtree with its state; `insertBefore`/`appendChild`
   remain the fallback where it does not exist.
3. **What the fallback move loses, put back.** `moveBefore` is not Baseline —
   Safari and iOS Safari have none, so on a phone the fallback is the only
   path. There, the insert *is* a removal: the browser blurs whatever had focus
   inside the row being moved (focus lands on `<body>`, so a keyboard restarts
   at the top of the document and an assistive-technology cursor leaves the
   conversation) and collapses a selection with an endpoint in it. The fallback
   therefore holds the focused node, its caret if it has one, and the
   selection's two endpoints, and restores them after the move — the same
   nodes, `preventScroll: true`, for the moved subtree only, and never over
   another control something focused while the move happened. The list's pass
   is a re-sort, not a scroll, and this keeps it that way.
4. **Record the padding that was applied, not the padding that was asked
   for.** The scroll-adjust trick writes a temporary end padding and reads it
   back to undo it; recording the requested string instead of the node's own
   value leaves a residue when the browser normalises it.

## The shape of the surface

```
ThreadPrimitive.Root
└── thread-column                      (relative, no scrolling of its own)
    ├── the conversation map's rail    (absolute, zero height)
    ├── LegendList  data-slot="thread-viewport"   ← the scroller
    │   ├── ListHeaderComponent: the notices, the history controls,
    │   │                        the unloaded-history placeholder
    │   ├── one row per message, keyed by message id
    │   └── ListFooterComponent: a spacer the height of the composer
    └── ThreadPrimitive.ViewportFooter (absolute, bottom) — the composer
```

Two consequences are load-bearing:

- **Nothing that can change height renders above the list.** That was blocker
  B2 of the M16-T87 review and it stays fixed: everything above the
  conversation is the list's header, which the list measures and restores the
  reading position through. Chrome above the list would push the reader by its
  own height.
- **The list is the thread's viewport.** `ThreadPrimitive.Viewport` is gone
  from this thread: a scrolling box around a scrolling list is two authorities
  over the same pixels. The transcript registers the list's own element as the
  thread viewport's element, reports its height, and reports whether the
  newest turn is on screen — which is the one thing
  `ThreadPrimitive.ScrollToBottom` reads to decide whether "Jump to latest"
  exists. The conversation map, the question notice and Find all ask the
  thread for its viewport and get the real scroller.

## The props, and which ones are policy

| Prop | Value | Why |
| --- | --- | --- |
| `data` / `keyExtractor` | the message ids, keyed by id | a prepend never renumbers a measured row |
| `getItemType` | the row's role once it has rendered one | per-kind size averages; unknown until a row renders is the honest answer |
| `estimatedItemSize` | six lines and five spacing steps of the active scales | read from the browser, never a literal |
| `extraData` | `path` + row count | the identity of what is on screen |
| `dataVersion` | `path` + the pinned rows | a pin is not a scroll: this is what asks the list to look at the data again |
| `alwaysRender.keys` | pins, focus, destination, the whole native selection | a released row would truncate a selection |
| `initialScrollAtEnd` | true | a conversation opens at its newest turn |
| `maintainScrollAtEndThreshold` | 1 | one screen, as the reference has it |
| `recycleItems` | false | a row is a conversation turn, not a cell |
| `onScroll` / `onItemSizeChanged` | re-read where the reader is | never a scroll of our own |
| class list | `h-full min-h-0 overflow-x-hidden overscroll-y-contain px-4 [overflow-anchor:none] md:px-6` | the browser's own scroll anchoring must not compete |

## The two places Laser overrides the list's default

1. **A fold the person toggled.** The list restores the row whose top is on
   screen; when somebody opens a disclosure, the row that must not move is the
   one they clicked. For as long as that fold takes to measure, the transcript
   names it through `shouldRestorePosition`, switches `size` anchoring off
   (so nothing below the fold pulls the view), and suspends live follow. The
   transcript learns that a fold moved from `aria-expanded` on the control
   itself, so a pointer and a keyboard arrive by the same path and no
   disclosure has to be taught to tell it.
2. **Whether to follow the live edge at all.** The live edge is a mode, not a
   measurement: a person enters it by reaching the newest turn and leaves it
   by scrolling away. Content arriving underneath a follower briefly makes the
   distance to the end non-zero, and that must not read as the person having
   walked away.

## The one position this list does not hold

Content growing **below the reading line, inside the row the person is already
halfway through**, moves the boundary below it, and the view follows by that
much. The list restores the row whose top is on screen, and a row that starts
above the fold is not that row.

This is the mirror of D-303's trade, and it is the better half of it:

- D-303 moved the reader for growth *above* their line, which is what happens
  continuously while somebody reads upwards through history that is still
  measuring, highlighting and laying out.
- This one needs late work to land *below* their line inside the one row they
  are in. The two largest instances are already gone: an image reserves its
  box before it decodes (`elements/image.tsx`, `runtime/view-measure.ts`), and
  a fold is a person's own action, which is held (above).

`transcript-virtualization.test.tsx > rows that grow` pins both halves,
including this one, so it is a recorded behaviour rather than an implied one.

## What acceptance measures

- Reading up through a long real conversation: no row appears or disappears
  under the eye, no row arrives before the reader reaches it, every older page
  arrives above and stays reachable, and the reading position never moves.
- The same with an image decoding, a disclosure opening, and a turn streaming
  at the bottom.
- The scrollbar grows as history loads without the text moving.
- Deep link, search hit, Jump to latest, Edit/Fork still land exactly.
- A composer growing a line moves no message.

## What was deleted with the second authority

With M16-T87: `transcript-window.ts` (`HeightIndex`, `windowRanges`),
`reading-anchor.ts`, the reserve's pixel model and its arrival/refinement
exchange, the earlier-page transaction and its fallback, clamp debt,
`layoutStale`, the disclosure hold, and the observers that existed to re-run
that arithmetic.

With this milestone: the head item and its index arithmetic (the header is the
list's), `measureRow` and the engine's `measureElement` (the list measures),
`observeElementRect` (the list observes), the `scrollMargin` model and
`readLayout`'s margin (nothing stands above the list), `rangeExtractor` and the
mounted-window arithmetic (`alwaysRender` is the list's own), the
`shouldAdjustScrollPositionOnItemSizeChange` rule (the list's
`maintainVisibleContentPosition` is the rule), the `writeScroll` trace wrapper
and `window.__laserScrollTrace` (no Laser code writes a scroll position for a
data or measurement change any more, so there is nothing of ours to attribute),
and `@tanstack/react-virtual` itself.

## Why the bespoke engine failed, kept

`transcript-viewport.tsx` used to compute which rows to mount from a model of
heights while the browser laid out the measured DOM. The two disagreed for at
least one commit after anything changed — a page arriving, a row measuring, an
image decoding — and the controller both rendered the window and wrote
`scrollTop` from the stale side. Every repair moved the error rather than
removing it. That is the reason a library owns this, and the reason the rule
"one authority over the pixels" is not negotiable in whatever comes next.
