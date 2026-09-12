## A faster app, measured

A cross-package audit found the app doing large amounts of work nobody could see. This release removes it.

- **Opening a project with many sessions.** Reading the session catalog copied the same bytes over and over: a project holding one very large conversation took about a second of frozen work; it is now about fifty milliseconds. Classifying project directories asked the filesystem forty thousand times for a five-thousand-session list; it now asks eight.
- **While the model streams.** Settled messages no longer re-render on every token, the sidebar, fleet and telemetry no longer react to text they do not show, and the conversation map no longer measures the whole transcript as you scroll.
- **What crosses the wire.** A captured provider request — sometimes megabytes — was broadcast to every open view that had no use for it; the inspector now fetches it when you open it. Transcript traffic for conversations nobody is looking at is no longer sent.
- **Searching, Git and logs.** A search you have replaced is cancelled instead of finishing; Git reads no longer load a huge file before deciding to skip it and run their independent reads together; large provider captures no longer block the host.
- **Memory.** Session and replay caches are now bounded by bytes rather than by a count, so one enormous conversation cannot crowd out the rest.

Installing the app on your phone no longer downloads every optional part of the interface up front.

## Files and sessions

- **Laser opens any file on the machine.** The viewer is no longer limited to the project: a file the model refers to anywhere on your computer opens, with its absolute path shown so you always know what you are looking at. When a file cannot be opened, the reason is the real one — a folder, a missing file, no permission — not "check that it still exists in the project".
- **No more "Detached" group.** A child agent's session whose parent is not listed now sits in its project like any other session.
