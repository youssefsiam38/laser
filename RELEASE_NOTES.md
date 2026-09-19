# Laser 0.9.5 — long conversations, read properly

This release is about one thing: a long conversation with pictures in it now
works. If you have a chat that would not scroll back, or that stopped showing
older messages entirely, this is the release that fixes it.

## Older messages come back

A conversation that had grown past a certain size stopped serving its older
half. Scrolling up reached a point and stopped there, for ever — the messages
were still on disk, but nothing could read them back.

Two things caused it, and both are gone.

**Pictures no longer travel inside a message.** A screenshot pasted into a chat,
or one a tool returned, was carried inline as part of the message itself. A
single screenshot is often two or three megabytes, which is larger than a whole
page of conversation is allowed to be — so any page containing one could not be
sent, and every page older than it was unreachable. Pictures are now sent as
references and fetched when they are shown, at every size, in every kind of
message. A page of conversation carrying two multi-megabyte screenshots went
from 6.4 MB to under 4 KB.

**A page is now a number of turns, not a number of bytes.** Reading backwards
loads the last ten exchanges, then twenty more each time you continue. One real
27 MB conversation now reaches its very first message in 22 requests, taking
under a second; it previously needed 56 and gave up partway.

## Reading upwards no longer moves the text

While you read back through a conversation, things above you finish loading —
images arrive, reasoning streams in, a tool result expands. Each of those used
to shift the text under your eyes, so the line you were reading moved away from
you.

The transcript is now built on a list that refuses to let content above you
move, rather than correcting the scroll position afterwards. Folding a tool
result open or closed keeps the row you clicked exactly where it was, and the
composer growing taller no longer moves the conversation.

One honest limit: if the row you are *halfway through* grows below your reading
line, the view still moves by that much.

## Every picture stays reachable

A picture that is not in the loaded window is now opened on demand rather than
reported as missing, including pictures inside tool results and inside results
from MCP servers. A picture reserves the right amount of space before its bytes
arrive, so the conversation does not jump when it appears. Pictures whose file
header does not state a size are the exception and still appear without a
reserved box.

## Mentions

Typing a space after `@something` now ends the file suggestion list, as you
would expect. A path with a space in it still works if you quote it —
`@"./my folder/notes.md"` — and the list stays open while the quote is open.

## Upgrading

Nothing to do beyond installing. Existing conversations are read as they are:
nothing is rewritten, migrated, or moved on disk.
