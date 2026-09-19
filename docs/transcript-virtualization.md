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
   virtualizer's own `scrollToIndex`/`scrollToOffset`. That includes
   assistant-ui's own thread viewport: its automatic scrolling is switched off
   and "Jump to latest" prevents the default on its click, so
   `ThreadPrimitive.ScrollToBottom` decides whether the button exists and the
   engine decides where the transcript goes. The remaining browser-owned move
   is a `.focus()` without `preventScroll`, which asks the browser to reveal an
   element rather than setting a position; the transcript itself always passes
   `preventScroll: true`.
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

## As built (M16-T87)

`@tanstack/react-virtual` 3.14.13 is pinned exactly in `packages/ui`
(`@tanstack/virtual-core` 3.17.11 comes with it; nothing else was added).
The transcript is one list: a head item — the history controls and the
unloaded-history placeholder — then one item per message, keyed by message id,
in chronological DOM order, positioned absolutely from the engine's own
measurements. `docs/transcript-reading.md` is the working description.

What was deleted with the second authority: `transcript-window.ts`
(`HeightIndex`, `windowRanges`), `reading-anchor.ts`, the reserve's pixel model
and its arrival/refinement exchange, the earlier-page transaction and its
fallback, clamp debt, `layoutStale`, the disclosure hold, the mutation/theme
/font observers that existed to re-run that arithmetic, and every `scrollTop`
write Laser computed for itself.

The head item carries **everything above the conversation**: the worker
recovery notice, the load/refresh error, the history controls, then the
unloaded-history placeholder. Anything left above the transcript inside the
same scroller reaches the engine as `scrollMargin`, and a change in that margin
is neither an edge-key change nor an item resize — the engine keeps the scroll
offset and moves every item, so the reader is pushed by exactly the height that
appeared. Inside the head it is an ordinary item resize, compensated to the
pixel. Nothing above the transcript in this scroller may change height.

Three deliberate adaptations, each supplied through an option the engine
already has, and each recorded here because a reviewer will ask:

1. **`shouldAdjustScrollPositionOnItemSizeChange`** — Laser's rule from
   M16-T85 (content ending at or above the reading position moves it by
   exactly what it changed; content in view does not) replaces the engine's
   default, which skips a re-measurement while the reader travels upwards.
   That guard would skip the placeholder shrinking, which happens only while
   somebody reads upwards.
2. **`measureElement`** — reads the border box directly and rounds both the
   synchronous and the `ResizeObserver` path the same way, so a row measured in
   the commit that mounted it and the same row measured by the observer never
   differ by a sub-pixel.
3. **`observeElementRect`** — a scroller reporting no height at all (not laid
   out yet, a hidden tab) reads as the window's height, so the transcript still
   mounts a reading window for Find, a deep link or a screen reader.

One guarantee was given up on purpose: the block-level reading anchor. The row
is the unit of identity a virtualizer can express, so content growing *inside*
the row the reader is in, above their line, moves their text by that much.
This is strictly worse than an ordinary page, where the browser's own scroll
anchoring holds the reader through exactly that; this scroller turns that
fallback off (`overflow-anchor: none`) so one engine owns the pixels. The way
to shrink the loss is to stop rows growing rather than to anchor finer, and the
largest instance is already gone: an image reserves its box from its own header
before it decodes (`elements/image.tsx` with `runtime/view-measure.ts`'s
`dataUriImageDimensions`), so a picture arriving changes no height at all. What
remains is late markdown work in a tall row — highlighting, formulae, diagrams
— above the reading line.

## Acceptance (the person runs the browser pass)

- Reading up through a long real conversation: no row appears or disappears
  under the eye, no row arrives before the reader reaches it, every older page
  arrives above and stays reachable, and the reading position never moves back.
- The same with an image decoding, a disclosure opening, and a turn streaming
  at the bottom.
- The scrollbar grows as history loads without the text moving.
- Deep link, search hit, Jump to latest, Edit/Fork still land exactly.
