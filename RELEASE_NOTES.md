## Two things 0.6.2 got wrong, and fifty things nobody had noticed yet

### Fixed from 0.6.2

- **The window stopped drawing.** After one message with a formula in it, the next ordinary message could bring up "Something went wrong drawing this window". The maths renderer was being handed to React as a function to *call* rather than a value to *keep*. Fixed, with a test taken from the conversation where it happened.
- **Scrolling up showed the same section again.** When an earlier page arrived above what you were reading, the view stayed at the top of the new page instead of moving with your place, so every wheel notch showed you page tops and you met the same messages twice on the way back down. The view now moves by exactly the height of what was inserted above you, before the frame is drawn.
- **Changing the thinking level locked every composer.** On a conversation that has already started, a thinking or model change now applies at once — it steers the next turn, it does not wait for the current one — and a change still waiting on one conversation never disables another's composer.

### An independent review, fifty findings, all handled

We had every package read by reviewers with no stake in the code. Fifty findings came back; all fifty were investigated with a failing test first, forty-eight were real and are fixed, two were proven not to be bugs and now carry a test that says so. Among the ones you could have met:

- The worker could exit — taking every conversation in that project with it — if a session was renamed at the wrong moment or a stop arrived during a runtime swap. It cannot now, and a guard keeps it alive through anything similar.
- Forking a conversation mid-run left its background commands and agent runs filed under the old name, so the fleet lost them and a stop could not reach the run. Everything moves with the fork now.
- Turning a Feature on or off restarted every project's worker, even one with an agent waiting on your answer. A worker with live work is never restarted underneath it.
- Closing a conversation, or opening another one, killed its detached background commands. Only quitting does that now; the command keeps running and the next session can still read it.
- Opening Laser in a subdirectory of a repository made it forget that its agents' worktrees were its own, so deleting a session leaked the worktree and its branch.
- On a phone, the public relay could be made to buffer without limit by a client that never reads. It now pauses the sender.
- A `.laser/settings.json` with a typo read as empty settings, silently; it now tells you what is wrong. A project-level write no longer deletes keys you added by hand.
- A file called `dist`, `build` or `out` was hidden from the `@` picker.
- Escape while typing in Settings or Logs closed the whole panel.
- Folding a tool while a search revealed it saved that as your preference; a search reveal is transient again.
- Tooltips that were only reachable with a mouse now open on focus and on touch.
- On macOS and Windows, "open in editor" failed with a message about a missing text editor; it now opens the default text editor, or the button is not shown where that is not possible.
- A landing-page draft survives a reload for an update; the pairing invite expires when it says it does; the request log releases what a finished turn left open; and thirty-odd smaller things listed in the repository's ledger.

### Also

- The API request inspector says when an older request's body has been released, and shows its summary.
- A pairing code that expires while you are confirming it gets a proper message, not a stack trace.
