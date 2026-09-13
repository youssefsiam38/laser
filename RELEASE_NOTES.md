## Lighter, faster, and it stops eating your disk

Nothing you can do changed in this release. What changed is how much Laser costs to run.

### Your disk is yours again

Laser keeps a record of every request it sends to a model so you can open **View API request** on any message. A long conversation re-sends its whole history every turn, and Laser kept a full copy each time: on one machine that record grew to 27 GB in eight days without any sign of it.

It is now bounded. The last fifty requests of every conversation are kept in full; older ones keep a summary — the model, how many messages, how large, how long — and give the bytes back. The whole record stays under 1 GB, and the space is really returned to the disk rather than left inside the file. **Settings → This device** shows how much the record takes and has a Clear button that says what goes and what stays. On first start after this update Laser tidies an existing record in the background, in small steps, so nothing stalls.

### Cheaper while you are not looking

Closing the window keeps Laser running in the tray, but until now the hidden window went on drawing frames and running timers at full speed. It now idles the way any hidden window does: agents keep working, notifications still arrive, and when you come back the window shows the right state immediately — no burst of catching up.

### Faster to open

- The first screen downloads a fifth less code: maths typesetting, the API request inspector, the agent map and the schema library arrive only when a conversation first needs them.
- The desktop app reads your keychain identity and your shell environment at the same time instead of one after the other.
- Hashed assets are cached by the browser between launches.

### Smoother while it streams

A streamed word used to wake almost every part of the window — the sidebar, the top bar, the fleet, the monitor — even though none of them had anything new to show. Now a word wakes the message it belongs to and nothing else: roughly seven times fewer renders per word, and no frame over 50 ms even in a 2,000-message conversation.

### Small things that were wrong

- **View API request** no longer blinks back to its loading state while the conversation streams.
- On a phone, returning to a long conversation is ready to type into sooner: the sheet you dismissed kept catching taps while it faded.
- A duration never reads "1m 60s".

### Smaller installer

The package leaves out 57 MB of files that could never run — workspace source, a Java archive behind a native binary, browser-only builds of Node libraries — while keeping every file the bundled engine can load.
