# Transcript scrolling, rebuilt on a proven virtualizer (M16-T87)

Status: design contract for the rebuild. Written after three rounds of repairs
to the bespoke windowing failed in front of the person: rows appearing and
disappearing while reading, a row arriving before the reader reached it, rows
above the reading position never arriving, and the view pushing back.

## Why the bespoke engine keeps failing

`transcript-viewport.tsx` computes which rows to mount from a model of heights
(`HeightIndex` + an estimate for unmeasured rows) while the browser lays out the
measured DOM. The two disagree for at least one commit after anything changes —
a page arriving, a row measuring, an image decoding, the estimate shrinking —
and the controller both *renders the window* and *writes `scrollTop`* from the
stale side. Every repair so far moved the error rather than removing it.

## What the proven implementations do

Read and cloned locally for study: TanStack Virtual (`virtual-core`, MIT) and
Virtuoso's message list (commercial, read for its contract only).

TanStack's chat mode (`packages/virtual-core/src/index.ts`, the
`anchorTo: 'end'` branch) is the algorithm we need, and the ordering is the
point:

1. When the edge keys change — a prepend, a trim, a reorder — it captures an
   anchor from the item under the current scroll offset: `[key, scrollOffset −
   item.start]`.
2. It invalidates the measurement cache, because a stable `getItemKey` with an
   unchanged count would otherwise return the old layout.
3. It resolves the anchor key's new `start` and sets `scrollOffset` **eagerly,
   during the same update pass**, so the range rendered in this pass is already
   the right one. The comment in the source is explicit: without it "the
   virtualizer would render the wrong items for one frame … producing a visible
   jump on prepend with dynamic sizes". That single frame is what the person
   sees as blocks appearing and disappearing.
4. The DOM `scrollTop` write happens in a layout effect, with an iOS deferral
   while a touch is in flight, and follow-on-append only when the reader was
   already at the end.

Other invariants both libraries share: normal chronological DOM order (never
`column-reverse` or inverted transforms), stable ids as keys (never indices),
`measureElement` on every mounted row, a conservative size estimate, and one
system owning the adjustment (so `overflow-anchor: none` on the scroller).

## The decision

Adopt `@tanstack/react-virtual` (MIT, exact-pinned) as the windowing and
anchoring engine for the transcript, and delete Laser's window/anchor
arithmetic. Laser keeps everything that is Laser's: which rows exist, history
paging and its fences, the live-edge policy, pins for selection/focus/approvals
/Find, `content-visibility`, the placeholder for unloaded history, reduced
motion, and every accessibility guarantee.

Not adopted: Virtuoso's message list (commercial licence, and it owns the whole
surface rather than sitting under ours).

## Contract for the rebuild

1. **One authority.** The virtualizer owns the mounted range and every
   scroll-position adjustment that follows a data or measurement change. No
   other code writes `scrollTop` except explicit person/destination intent
   (Jump to latest, a search hit, a deep link), and those go through the
   virtualizer's own `scrollToIndex`/`scrollToOffset`.
2. **Stable identity.** `getItemKey` is the message id. Indices never key a row.
3. **Measured, not estimated.** Every mounted row is measured with
   `measureElement`; the estimate is conservative and used only for rows that
   have never been measured.
4. **Reading upwards.** A page of older messages is a prepend: the reader's row
   keeps its screen position to within a pixel, the window for that pass is
   already correct (no flash of other rows), and nothing appears below the
   reader that was not there before.
5. **The live edge.** Follow only when the reader was at the end; a local send
   always reveals itself; otherwise the existing "Jump to latest" affordance.
6. **Unloaded history.** The placeholder region and continuous paging stay a
   Laser policy on top, expressed as items the virtualizer measures — not as a
   spacer the controller compensates for by hand.
7. **Rows that grow.** Image decode, highlighting, disclosure, streaming text:
   the virtualizer re-measures and re-anchors; Laser adds nothing.
8. **What must not regress.** Find (DOM ranges over mounted rows, forced layout
   for a `content-visibility` hit), native selection across rows and Select All,
   focus and keyboard traversal through approvals and controls, agent/tool rows,
   reduced motion, both themes, both widths, touch.

## Acceptance (the person runs the browser pass)

- Reading up through a long real conversation: no row appears or disappears
  under the eye, no row arrives before the reader reaches it, every older page
  arrives above and stays reachable, and the reading position never moves back.
- The same with an image decoding, a disclosure opening, and a turn streaming
  at the bottom.
- The scrollbar grows as history loads without the text moving.
- Deep link, search hit, Jump to latest, Edit/Fork still land exactly.
