## Reading back through a long conversation works again

In 0.6.0, scrolling up through a long conversation could turn the whole window black, and only quitting the app brought it back. That is fixed.

Three things were wrong, and all three are fixed:

- **The black window.** As you scrolled, rows leaving the screen each told the app "the pointer is not over me any more". In a large conversation that was hundreds of notices at once, more than the app could take in one go, and it gave up entirely. A row that leaves the screen now just leaves.
- **The view pushed back.** While you were scrolling up, the app kept trying to put you back where it thought you were, so the conversation jumped under your wheel. It now moves the view only by exactly as much as the page above you changed, and never against you while you are reading.
- **Earlier messages stopped loading.** At the very top there is nowhere further to scroll, so the app never noticed you asking for more. Scrolling up, swiping down or pressing ↑ at the top now loads what came before.

And should anything like this ever happen again, the window no longer goes black: it tells you what happened and offers a reload, with the host and every conversation still running underneath. The desktop log now records the error too, so it can be found.
