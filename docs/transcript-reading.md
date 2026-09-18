# Reading long conversations

The transcript has one geometric authority: `TranscriptViewport`. It owns the
live edge, reading anchors, virtual rows and the unloaded-history range. The
assistant-ui viewport does not independently reposition the conversation.

## Earlier-page transaction

An earlier-page request temporarily forbids estimate-based anchor restoration.
Measured row deltas and the height inserted above the current anchor remain
allowed. The geometric live-edge branch also remains allowed, so a person at
the newest message stays there while history arrives above it.

The request promise owns the transaction. It releases on refusal, rejection,
cancellation, path change or unmount. For an accepted request it releases on
the first React commit after the history cursor changes, even if projection
merges the page into the oldest turn, replaces ids or produces no new message.
A one-frame fallback prevents a broken producer contract from wedging the
viewport; acceptance tests require that fallback count to remain zero.

## The reader never moves on their own

One rule covers every arrival: **anything that changes above the reader moves
the viewport by exactly that amount, once, in the same frame.** Its corollaries
are what acceptance measures.

- A page is attributed to unloaded history whenever it changes the head of the
  id list while a cursor still points before it. It is not gated on the page
  transaction: an accepted page commits over several React commits, and the
  later ones land after the transaction has released. Growth *inside* an
  existing row is not a head change and never counts.
- A page that folds the anchored row into an older group leaves the reader
  where they are. The row's id is gone, but the conversation is the same, so
  the place is re-taken from what is on screen. Only a genuine window
  *replacement* — a reloaded recent tail, a branch that dropped the message —
  still falls back to the newest turn, and only when the surface is already
  arriving there.
- The producer's "there is nothing before this" can commit before the rows that
  prove it. Removing the estimate then would take pixels from above the reader
  while their replacement is still arriving, so the estimate is held until that
  page's own commit, and removed with its compensation in one frame.
- Compensation that the clamp at `scrollTop` 0 cannot spend stays owed, with
  its sign, until content above the reader exists again. Without that, a reader
  at the top of the window loses the movement and stays pinned there.
- A measured frame takes the anchor's offset once, before anything in the
  frame can move it — relayout, a held root estimate going, the reserve
  refining, rows measuring — and shifts by the one difference at the end.
  There is no second authority: an absolute "hold" that re-places a surviving
  row for a run of frames was tried and removed, because it fought the
  structural shift and the reserve exchange for the same pixels, clamped at 0,
  and kept the reading place from being re-taken after a merged head.

## What the scrollbar means

A virtual reserve above the loaded rows represents history that still has a
`before` cursor. Loading a page exchanges that reserve only for the height of
rows inserted above the prior head. Streaming text, disclosure changes, image
decode, font loading and width changes do not alter the reserve. The reserve is
removed only when `before` is absent, which is the producer's proof that the
branch root is loaded.

Before reading starts, the estimate uses the producer's earlier-user-prompt
count and the measured average loaded turn height. Once reading starts, the
estimate is fixed and only accepted earlier pages consume it. This keeps the
thumb and the reader's anchor stable while rows are measured.

## Known estimate limit

`userOffset` counts user prompts, not transcript entries. One prompt can contain
hundreds of assistant and tool rows, so `userOffset` values of zero or one do
not measure the remaining height well. While a cursor remains, that case uses
the measured loaded projection as one conservative page estimate. It does not
multiply the protocol entry limit because many entries may fold into one turn.

The thumb is therefore an honest estimate, not a random-access map. It can be
larger or smaller than the final measured conversation in a tool-heavy turn.
It retains one geometric unit while a cursor remains, so it never claims the
root. Once that conservative range is exchanged, arrived pages grow the range
and push the viewport by exactly their unabsorbed height. Real-session
acceptance permits a wider initial/final range ratio for this reason and still
requires a nonzero reserve, visible loading state, continuous anchors and zero
reserve at the true root.

## What acceptance measures

`scripts/browser-check/test/scroll-up-repeat.mjs` reads geometry from the DOM,
not from the controller, so it measures the pixels the person sees. Between
settle samples — intervals with no input of their own — the row the reader is
on may not move by more than one pixel, upward reading may not end at the live
edge, and `scrollTop` 0 is only reached when no earlier history is claimed. A
late notch of the person's own wheel is recognised by its signature (the row
moves by exactly the scroll, with no change of range or reserve) and is not
counted against the app.

## When the base is refused

A compaction or a branch can move the conversation past the base a window is
holding. The producer then refuses its earlier pages, and `history.refusal`
carries the sentence for the person. The transcript keeps every row it has;
upward reading stops asking the question that was just refused; and the history
controls replace "Load earlier messages" with that sentence and one action,
"Reload recent messages", which performs the bounded current-tail re-read. The
accepted window carries no refusal, so the ordinary control returns by itself.
