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
not measure the remaining height well. While a cursor remains, that case uses a
bounded page estimate: one protocol page of estimated rows, refined by a
bounded multiple of the last arrived page.

The thumb is therefore an honest estimate, not a random-access map. It can be
larger or smaller than the final measured conversation in a tool-heavy turn.
It never claims the root while a cursor remains, and dragging into the reserve
loads pages sequentially until the producer removes the cursor. Real-session
acceptance permits a wider initial/final range ratio for this reason and still
requires a nonzero reserve, visible loading state, continuous anchors and zero
reserve at the true root.
