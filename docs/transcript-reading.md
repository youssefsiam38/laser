# Reading long conversations

The transcript has **one** geometric authority, and it is not Laser's: the
mounted range and every scroll adjustment that follows a data or measurement
change belong to `@tanstack/react-virtual` (D-303, `docs/transcript-virtualization.md`).
`TranscriptViewport` owns what is Laser's — which conversation is on screen,
which rows are held open, where a destination is going, how much unloaded
history stands above the loaded rows, and what this surface is standing on —
and writes no scroll position of its own. The assistant-ui viewport does not
reposition the conversation either, and the scroller carries
`overflow-anchor: none` so the browser's own anchoring never competes.

## The shape of the list

```
item 0            the head: history controls, then the unloaded-history placeholder
item 1 … item n   one per message, in normal chronological order
```

The head is an item, not chrome above the list, for two reasons. The engine
measures it and anchors through it exactly as it does a row, so the history
control appearing or the placeholder shrinking moves nobody. And a list whose
first key never changes lets the engine detect every prepend, trim and
replacement from the item count alone.

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
growing *inside* the row the reader is in, above their line — an image
decoding, a disclosure opening on its own — moves their text by that much, as
it would on any page. A row above them growing does not.

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
  because that is where the rows belong;
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
Nothing else writes a scroll position.

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
