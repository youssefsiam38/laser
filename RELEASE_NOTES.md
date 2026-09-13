## Long conversations stay fast, however long you use them

A conversation opens on its most recent messages, and older ones arrive as you scroll up — there is no button to press. Come back to a conversation later and it opens on its recent messages again, so a morning spent reading far back never makes the afternoon slow. Scrolling up still reaches everything, and search, jumping to a message, editing, forking and versions all still reach the whole conversation.

Switching between conversations is now the same speed whether a conversation holds forty messages or two thousand: on this machine, a 2,000-message conversation comes back in about 128 ms, and is ready to type in about 158 ms. On a phone, in dark mode, the largest conversations take about 316 ms to accept typing — slower than we want, and it is the transition animation; turning on reduced motion in your system settings brings it to about 159 ms.

Your place in a conversation, your unsent draft, an open question waiting for your answer, what you had expanded and what you had selected all survive the move.

## Archiving takes the whole tree

Archiving a conversation now takes everything under it, including agents that start after you archive, so nothing you filed away comes back on its own. Unarchiving restores the branch.

## The sidebar stays short, without hiding live work

Each project shows its seven most recent sessions. Anything still running, or waiting for your answer — including an agent working under a quiet conversation — stays visible past that, and the list returns to seven by itself when the work finishes. Nothing you need to answer is ever behind "Load more".

## `@` is a file explorer

Typing `@` in the composer opens a path-aware picker over your files, not a guess from the project's index.

- `@/` starts at the root of your filesystem; absolute paths and `..` work.
- `@name` filters the current directory, `@server/` lists that directory, and `@a/b/c` walks as you type.
- Folders continue the path; files complete the mention.
- Generated and ignored folders are there too — if you can read it, you can attach it.

Everything works from the keyboard, at both window widths and in both themes.

## MCP servers: only the tools a conversation needs

A server with a hundred tools no longer spends your context on all hundred. Laser gives the model short summaries and lets it ask for the full schema of the tools it actually uses, with a per-server override when you want a server always loaded in full. The complete tool list stays byte-identical for the whole conversation, so your provider's prompt cache keeps working.

Tool information is now cached with an honest expiry: a server that announces a change invalidates it immediately, and nothing is served from a cache whose freshness cannot be established. Signing in and out is safer too — a saved sign-in is matched to the exact server and project it belongs to, a sign-out takes effect in every window at once, and a call is refused rather than retried with credentials that have changed. As before, the model can discover and call tools on servers you have enabled; enabling, configuring and signing into servers remains yours.

## Also

- The sessions sidebar's History section no longer slows down as a conversation grows.
- A conversation with a question still waiting answers it correctly after you leave and return.
- Agent work opened in the Beam bubble and in the main window now keeps its own place in the same conversation.
