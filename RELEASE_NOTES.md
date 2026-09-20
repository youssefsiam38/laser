# Laser 0.11.0 — long conversations open, new chats are instant, diffs scroll

This release is about the three places the app made you wait, guess, or give up.

## A long conversation opens on what you were doing

Opening a big session used to show you almost nothing: the last forty entries, which on a real 8 MB conversation is thirty-six rows and not a single one of your own prompts. Getting back to your work meant scrolling up, a page at a time, past estimated empty space.

Now the transcript fills its own screen and keeps about two screens loaded above the one you are reading, without a gesture. Pages are counted in turns, so a page is whole prompts and their answers rather than a fixed number of rows.

It stops when it should: two screens above you, the start of the conversation, or a budget for where you are sitting — whichever comes first. It picks up again when you move.

**Scrolling up during a live turn no longer loses your place.** When the turn finished, the app used to quietly replace what you were reading with the newest ten turns, taking the row under your eye with it. A background refresh now leaves your window exactly as it is.

**"Load all messages" in Find works.** It never did: it asked for the whole conversation in one read, which is refused for anything large — that is, for every conversation big enough to show the button — and the failure went into a notification while the button sat there. It now pages the conversation you are looking at back to its beginning.

## A new chat is local

Pressing New gives you the finished screen on the next frame: the name, the prompt, the suggestions, the composer, and the microphone. Nothing on it waits for an answer from the backend, and — this is the part that was wrong in 0.10.1 — nothing on it changes when that answer arrives. The conversation no longer reloads under you, the wording no longer swaps, and the header no longer redraws itself a second time.

The microphone is there and pressable before the session exists. It checks the provider and asks for permission when you press it, and tells you in plain words if something is actually missing, instead of being invisible until a check comes back.

You can type, dictate, pick a suggestion, and send before anything has settled. Send joins the session already being prepared.

## The Changes overlay scrolls

A diff longer than the window could not be scrolled at all — the content simply ran past the bottom and was clipped. It scrolls now, with the wheel, with a finger, and with the keyboard: Tab into the diff, then Page Down, End and the arrow keys. `j` and `k` still move between files, and a line too long to wrap can be reached sideways. The file list beside it scrolls on its own without dragging the page with it.

## When a model is busy and the conversation is long

Falling back to another model used to give up twice over: "Claude is being rate-limited. Fallback could not help: the conversation is longer than this model can hold." A conversation that does not fit the model taking over is now compacted once, and the turn you asked for continues on that model instead of failing.

## Also in this release

- The agents' shared preamble is shorter, so custom agents inherit less style and keep more of their own.
- Groundwork for updates that land while the app is running: the generation you are running is retained and kept whole, so a future update cannot leave a half-replaced app behind. The rest of that work continues in the next release.
