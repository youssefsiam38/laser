Laser 0.7.0

## Laser stays fast and small, however long you work

This release is about memory. Long conversations, many open sessions, big tool outputs, images, child agents and background commands no longer make the app grow without bound, and the app now explains where memory goes and protects itself before the machine runs out.

### Conversations open instantly and stay light

- A conversation you have seen before paints immediately from a bounded on-device cache, then quietly reconciles with the host. No blank frame, no lost draft, no lost reading place within a visit.
- Returning to a conversation opens at its latest message. A reading place from an earlier visit never pulls you back up.
- Only a window of a long transcript is held in memory. Earlier pages load when you scroll to them, and very large messages, tool outputs and images are shown as bounded excerpts you can expand or open in full.
- Conversations you are not looking at are released in the background. Anything live — a running turn, a question waiting for you, an approval, an agent, a background command, a draft — is never released.

### The app protects itself under memory pressure

- Laser watches its own memory and the machine's free memory. When it tightens, it sheds caches first, then declines only new heavy work ("This is a large conversation…"), and never stops something you are doing.
- Every process runs under a fixed memory ceiling. If a project's agent ever runs out, it restarts from saved state, your agents are marked as ended by the system with a plain reason, and the parent agent is told.
- Reconnecting phones and remote views can no longer pile up unbounded backlog; diagnostics are dropped first and conversation data never silently.

### See where memory goes

- Settings → Advanced → Resources shows current and peak memory for the app, the host and each project's worker, with history, retained caches, sessions and background commands, and the current pressure state.
- A redacted report can be exported for a bug report. It contains numbers and categories, never paths, IDs, transcripts or credentials.

### Read-only access is honest

- On a phone, a read-only pairing or a browser window, controls that cannot apply are gone or explain themselves before you tap. Reading, searching and navigating still work everywhere.

### Startup, safe mode and updates

- Every launch of the host and its workers announces an exact identity before it is treated as ready, so a stale or foreign process is never adopted.
- If a project's agent fails to start twice, Laser stops retrying and offers Try again or Start in safe mode. Safe mode runs with optional Features off against the same data; your Feature choices are never rewritten.
- Updates activate as one immutable, verified generation. When an update is ready, Laser waits for your current work to finish, tells you when it is safe to restart, and reports the outcome even if the window reconnects in between. If files on disk have changed after install, the app says so instead of running a mix.
- Data migrations take a verified snapshot first. If an update is interrupted or fails, the next launch resumes or restores your previous data exactly, and tells you which.

### Also in this release

- Everything from 0.6.5: reopened conversations start at their latest message.
- Fixes to agent naming, session moves and worker retirement races found while measuring the above.
