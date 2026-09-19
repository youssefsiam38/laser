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
the viewport by exactly that amount, once, in the same frame — and "exactly"
is measured from the browser, never computed from the model.**

The reader's position is recorded as one or more mounted rows' tops in the
scroller's own content coordinates (`rect.top - viewport.top + scrollTop`),
while the layout is settled. When a layout lands — a React commit, a
`ResizeObserver` delivery, a measured frame — the same rows are read again and
`scrollTop` moves by the difference. Content coordinates are scroll-invariant,
so the person's own scrolling between the two readings cancels out, and a write
this controller makes never looks like content moving.

Model arithmetic cannot answer this question. Above a reader are measured rows,
rows whose height is still a guess, an estimated range that changes in the same
commit and the history controls, and `globalOffset` mixes all four; writing its
difference to `scrollTop` moves the person by whatever the guess got wrong,
which is what pushed a reader back page after page in a long real session
(M16-T85). The estimated index survives as one explicit fallback, named in the
code: the reader is on loaded rows and not one is mounted — a destination jump,
or a window that has not caught up with a long wheel.

Three consequences follow, and acceptance measures them.

- **Nothing on screen, nothing to hold.** When no loaded row is on screen the
  person is looking at the placeholder for history that has not arrived. The
  rows that arrive belong exactly there, so no `scrollTop` is written at all.
  Holding a row below the fold still would push them down for their own reading.
- **One page, one answer.** While an arrived page is still being reconciled —
  its rows mounted but not yet measured, its height not yet exchanged with the
  estimate — the recorded rows are not re-chosen, only re-positioned after each
  compensation. Re-choosing mid-exchange spends half of it and keeps the other.
- **One authority.** An away reader's pixels belong to the measured anchor;
  `restore()` keeps the live edge, a settled destination and the disclosure
  hold, and does not place them a second time.

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
- Compensation that a clamp cannot spend stays owed, with its sign, until the
  geometry allows it. Neither end absorbs everything: above the content there
  is nowhere to go, and a window whose rows have not mounted yet is not as tall
  as it is about to be. Without the debt the truncated part is simply lost and
  the reader keeps the shift's error.
- Measuring a mounted row never moves the layout — the row is already that tall
  on screen and the spacers cover unmounted rows only — so it never writes
  `scrollTop`. It runs in the commit that mounted the row, not a frame later,
  because a window chosen from a model the browser has already contradicted
  unmounts rows above the reader and collapses the page that just arrived.
- A page whose boundary row is not among the rendered entries — an oversized
  record held as a stub — is inserted at the front rather than refused, so a
  long conversation cannot ask the producer the same question for ever (D-302).
- There is no second authority: an absolute "hold" that re-places a surviving
  row for a run of frames was tried and removed, because it fought the
  structural shift and the reserve exchange for the same pixels, clamped at 0,
  and kept the reading place from being re-taken after a merged head.

## What the person sees

Nothing. The unloaded range is drawn as conversation-shaped placeholder rows
in normal flow — no words, no card, no border, nothing sticky — and a page
replaces those pixels with real rows where they were, so arriving history is
not work the person watches. The only visible sign is a page that is late:
longer than one `--motion-slow` step while the person is inside the range shows
the loader's matrix at the viewport's top edge, without copy, until it arrives.
A screen reader hears one `sr-only` status from the history controls, and the
transcript region is `aria-busy` while a page is in flight. The refusal state
is the one case with text and a button, because the person has to act; it is
inline, styled like the history controls. The explicit "Load earlier messages"
control remains for keyboard and assistive access.

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
by their unabsorbed height. What that does to the person is decided by the
measured anchor and nothing else: a loaded row on screen keeps its place, so
the range's growth is absorbed by `scrollTop`; a reader inside the placeholder
keeps their pixels, so the range grows under content they had not read yet.
Real-session
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
