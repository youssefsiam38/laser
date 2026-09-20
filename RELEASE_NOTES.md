# Laser 0.11.1 — a long conversation is all there, every time

Two things 0.11.0 still got wrong on a real ten-megabyte conversation, and one thing it should never have shown you.

## You can always scroll to the start

Leaving a long conversation and coming back could leave it stuck partway: scrolling up did nothing, and everything older than a certain row was simply unreachable until you reloaded. The app frees memory when you leave a session and picks the transcript back up from where it was cut; the bookkeeping for that pickup could anchor itself on a record at the very start of the conversation and conclude there was nothing more to load, while thousands of rows were missing. Fixed. Leave, come back, scroll — it keeps loading, back to the first message, every time.

## An oversized message stays where it belongs

A prompt too large to travel inside a page could turn up at the very top of the conversation — above your first message — as an empty bubble with "Show full message". It was a bug in where a page of history was placed when its boundary happened to be one of those oversized messages. It now sits in its own place, and it shows its real time instead of the moment you opened the session.

## Nothing asks for the whole conversation any more

There is no "Load other versions" control, no "Load history and versions" menu item, and no sentence telling you the conversation is too large to load at once. Every one of those asked for the whole conversation in one read, which is refused for exactly the conversations big enough to show them. Other versions of a message are reached from the message itself — the ‹ 1 / 3 › picker beside a prompt now knows every version, including ones on branches you have not scrolled into, and takes you straight there.

## Your own first message stopped appearing twice

On the first turn of a conversation, the message you sent could be left behind a second time at the very bottom of the transcript, dimmed — a copy of your own words that never went away and came back after every refresh. The app keeps what you have sent on screen until the engine has written it down; it recognised the written one by an identifier the two copies never share, so it kept the temporary one for ever. It now recognises the words. Nothing was ever sent twice, and nothing was missing from the conversation.

## Also

- Once you have scrolled up to read, nothing scrolls you back down but you: a new row arriving, a smooth scroll that has not finished, or a row that shrank no longer counts as "back at the end". The Jump to latest pill carries a quiet mark when new rows have arrived below you.
