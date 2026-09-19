# Reading long conversations

The transcript has **one** geometric authority, and it is not Laser's: the
mounted range and every scroll adjustment that follows a data or measurement
change belong to `@tanstack/react-virtual` (D-303, `docs/transcript-virtualization.md`).
`TranscriptViewport` owns what is Laser's — which conversation is on screen,
which rows are held open, where a destination is going, how much unloaded
history stands above the loaded rows, and what this surface is standing on —
and writes no scroll position of its own. The scroller carries
`overflow-anchor: none` so the browser's own anchoring never competes.

The assistant-ui viewport is kept out of the same pixels deliberately, and it
takes two things to do it: the thread viewport's automatic scrolling is off
(`autoScroll`, run start, initialize and thread switch, `Thread.tsx`), and
"Jump to latest" prevents the default on its own click. That button is
`ThreadPrimitive.ScrollToBottom`: the primitive decides whether it exists —
it knows when the viewport is pinned to the end and hides itself there — and
without `preventDefault` its own handler would also run, writing `scrollTop`
directly on the scroller and re-writing it on every content resize until the
element reported bottom, which is exactly the measurement storm a jump sets
off. `composeEventHandlers` honours a default-prevented event, so the click
reaches one writer: the engine's `scrollToIndex`.

One browser-owned exception remains, and it is not a scroll position anybody
computes: `.focus()` without `preventScroll` asks the browser to reveal the
element. Every focus move the transcript makes passes `preventScroll: true`;
the two that do not are a zoom dialog and a diagram dialog returning focus to
the in-row control that opened them (`elements/image.tsx`,
`elements/mermaid-diagram.tsx`), where the row is on screen by construction.

## The shape of the list

```
item 0            the head: the notices, the history controls, then the
                  unloaded-history placeholder
item 1 … item n   one per message, in normal chronological order
```

The head is an item, not chrome above the list, for two reasons. The engine
measures it and anchors through it exactly as it does a row, so the history
control appearing or the placeholder shrinking moves nobody. And a list whose
first key never changes lets the engine detect every prepend, trim and
replacement from the item count alone.

**Everything above the conversation lives there**, including the two notices
that appear while a person is reading: the worker-recovery notice and the
load/refresh error. Anything left above the transcript inside the same scroller
is a `scrollMargin` to the engine — the ground the list stands on — and a
*change* in that ground moves every item without moving the scroll position,
which the person feels as the view pushing them down by exactly the height that
appeared. Inside the head the same appearance is an ordinary item resize, which
the engine compensates to the pixel. The rule is therefore flat: nothing above
the transcript in this scroller may change height.

Rows are positioned absolutely from the engine's own measurements (`top`, never
a transform, so nothing inside a row loses its containing block) inside a
container whose height is `getTotalSize()`. Order in the DOM is the order of
the conversation: never `column-reverse`, never an inverted transform, so
native selection, Find and the reading order are the ones the browser expects.

`getItemKey` is the message id, scoped to the conversation. Indices never key a
row, so a prepend does not renumber what is already measured. Every mounted row
is measured through `measureElement`; only rows that have never been mounted
use the estimate, which comes from the active type and spacing scales.

## What the engine does on a prepend

When the edge keys change — a page of older messages, a trim, a branch — the
engine captures the item under the current scroll offset and how far into it
the reader is, invalidates its measurement cache, resolves that key's new
start, and sets the scroll offset **in the same update pass**, so the range
rendered by that pass is already the right one. The DOM write happens in a
layout effect, with an iOS deferral while a touch is in flight. That ordering
is the whole point: the bespoke engine chose the window from a model that
disagreed with the laid-out DOM for at least one commit, and that one frame is
what a person saw as blocks appearing and disappearing.

## When a measurement moves the reader

One rule, supplied to the engine as its `shouldAdjustScrollPositionOnItemSizeChange`:

> Content that ends at or above the reading position moves the reading position
> by exactly what it changed. Content the person can see does not.

An item that merely spans the reading line — the row they are reading, growing
at its bottom as it streams — is excluded, so nothing drags the viewport
downwards. The engine's own default adds a scroll-direction guard on top of
that; Laser removes it, because the placeholder for unloaded history shrinks
precisely while somebody is reading upwards, and a compensation skipped there
is a reader thrown by the page they asked for.

**The row is the unit.** The block-level reading anchor that M16-T85 built
(`reading-anchor.ts`) is gone with the second authority it belonged to. Content
growing *inside* the row the reader is in, above their line — late syntax
highlighting, a formula, a diagram resolving — moves their text by that much.
A row above them growing does not.

That is worse than an ordinary web page, not the same: a plain page has the
browser's own scroll anchoring to hold the reader through exactly this, and
this scroller switches it off (`overflow-anchor: none`) so that one engine owns
the pixels. The trade is deliberate — a second authority over `scrollTop` cost
four person-visible defects — and the way to make the loss smaller is to stop
rows growing, not to anchor finer. The largest instance is gone already: an
image reserves its box from its own header before it decodes
(`elements/image.tsx`, `runtime/view-measure.ts`), so a picture arriving
changes no height at all.

## The unloaded-history placeholder

Earlier history that has not arrived is drawn as conversation-shaped
placeholder turns inside the head item: no words, no card, nothing sticky. Each
turn is exactly one nominal turn tall whether or not it has been painted, so
scrolling through the region never changes its height. The engine measures the
region like any other content; nothing compensates for it by hand.

How many turns:

- the target is the producer's count of unloaded prompts, bounded to three
  screens (D-302). A producer that says zero or one prompt is saying
  "unknown" — one tool-heavy prompt can be a page of rows — so that case
  counts as two turns, not none;
- an arriving page takes the turns it replaced, from the bottom of the region,
  because that is where the rows belong. How many it replaced is the drop in
  the producer's count, **or one turn, whichever is larger, whenever rows
  really did arrive at the front.** The count is the producer's and the region
  may not depend on it alone: a page that did not move it would leave the
  placeholder never yielding, the reader pinned inside it and continuous paging
  asking for ever. The two agree in the normal case, because a page always
  walks back to a user prompt;
- **except the turns the person is looking at.** While the reading position is
  inside the region, only turns below the fold are given back. A row never
  materialises in front of somebody who has not reached it yet; the rest of the
  region follows as they read past it;
- the region grows back to its bounded size only where growth cannot be felt:
  at the live edge, or with the reader on loaded rows, where the whole region
  is above their reading position and the engine moves them with it to the
  pixel. Never during a gesture, never while a destination is landing, and
  never while the person is inside the region — there, growth would push the
  conversation further away from them one page at a time;
- one turn always remains while the producer still has a cursor, because the
  region is also the only thing on screen that says "this is not the
  beginning". It disappears entirely when the cursor does.

Continuous paging is unchanged and still belongs to the history controls: while
the reading position is inside the region, each accepted page asks for the next
one, up to twelve per gesture. `history-loader.ts` and its fences are
untouched (M16-T81/T85).

## The live edge

`anchorTo: "end"` with `followOnAppend`: the transcript follows an appended
turn only when the reader was already at the end, and a row growing at the end
— a turn streaming — keeps the end pinned. A conversation opens at its newest
turn: the engine cannot know that a list which grew from nothing should start
at its end, so that placement is one explicit intent, made once, in the commit
that has the rows. Sending always reveals the sent message the same way, and
"Jump to latest" is the affordance for everything else.

## Destinations

A deep link, a search hit, the map, a question inside a tool row, Edit/Fork/Jump
and Tab into a row the window had released all go through `ensureVisible`,
which uses the engine's own `scrollToIndex` to land and then its
`scrollToOffset` to place the exact block — a text range, a tool call — a third
of the way down. The destination row is held mounted while it is the target.

A gesture the person makes ends a destination, because the row they were being
taken to is no longer where they are going. A gesture that cannot move
anything is not one: a wheel down at the bottom of the conversation, a tap that
never becomes a drag, Space at the end. Those leave the destination, and the
placement this surface still owes, exactly where they were.

## Held rows

The mounted window is the engine's range plus the rows a surface is holding
open: an edit, an expanded request, the focused row, a destination on its way,
and every row inside a native selection, which stays whole because the browser
owns it and a released row would truncate it. Explicit Select All is still the
documented temporary all-loaded-DOM exception.

The same rows are published for the view cache (RP-5b): the row under the
reading position, the focused row and the pinned ones, so releasing the older
part of a conversation never pulls one out from under a person. Inside the
placeholder, the row under the reading position is the oldest loaded one — the
row they will be back on.

## What the person sees

Nothing. A page replaces placeholder pixels with real rows where they were, so
arriving history is not work the person watches. The only visible sign is a
page that is late: longer than one `--motion-slow` step while the person is
inside the region shows the loader's matrix at the viewport's top edge, without
copy, until it arrives. A screen reader hears one `sr-only` status from the
history controls, and the transcript region is `aria-busy` while a page is in
flight. The refusal state is the one case with text and a button, because the
person has to act.

## When the base is refused

A compaction or a branch can move the conversation past the base a window is
holding. The producer then refuses its earlier pages, and `history.refusal`
carries the sentence for the person. The transcript keeps every row it has;
upward reading stops asking the question that was just refused; and the history
controls replace "Load earlier messages" with that sentence and one action,
"Reload recent messages", which performs the bounded current-tail re-read. The
accepted window carries no refusal, so the ordinary control returns by itself.

## What acceptance measures

`scripts/browser-check/test/scroll-up-repeat.mjs` reads geometry from the DOM,
not from the controller, so it measures the pixels the person sees. Between
settle samples — intervals with no input of their own — the row the reader is
on may not move by more than one pixel, upward reading may not end at the live
edge, and `scrollTop` 0 is only reached when no earlier history is claimed.
Every scroll position the transcript writes still passes through one function,
so `window.__laserScrollTrace` continues to attribute each one; with one
authority, what it records is the engine's anchoring and Laser's explicit
destinations, and nothing else.
