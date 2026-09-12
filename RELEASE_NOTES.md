## Opening a conversation is fast now

Clicking a session used to mean waiting — longest on the conversations you care about most, the long ones. Two things were wrong, and both are fixed.

**A conversation opens on its most recent messages.** It no longer builds the entire history before showing you anything: the latest messages appear, and older ones load as you scroll up, with your reading position kept. A 2,000-message conversation now holds 40 messages on screen instead of 2,000, and 1,524 page elements instead of 56,512. Everything still reaches the whole conversation — search, jumping to a message, editing, forking, versions — and "Load complete history" is there when you want all of it at once.

**The project is ready before you click.** Starting the process that runs your project used to happen after the click, and it cost more than reading the conversation did. Laser now prepares it when you show intent — selecting the project, opening its group, returning to where you left off — for projects you have already trusted, one at a time, released again within a minute and a half if you do not use it.

Measured on the finished build, ten samples per case, both widths and both themes:

| Conversation | Before | After |
| --- | ---: | ---: |
| Short, project not yet started | 729 ms | **174 ms** |
| 240 messages, project not yet started | — | **224 ms** |
| 2,000 messages, project not yet started | — | **227 ms** |
| 2,000 messages, switching back | 4,133 ms | **152 ms** |

A two-thousand-message conversation now opens in about the same time as a four-message one.

## Also

- The sidebar asks the app for the sessions it shows rather than every session on your machine.
- Forking from an older message hands that message to the new conversation's composer, switching between versions of a prompt keeps its version controls, and versions are numbered in the order they were written.
- A project's environment command no longer risks starting a project with a half-read environment when the machine is busy.
