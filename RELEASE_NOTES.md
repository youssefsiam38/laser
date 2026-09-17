Laser 0.9.0

## The agent tells you what it is doing

### New in 0.9.0

- Every running action now carries a short line written by the agent itself — "Reading build config", "Running unit tests" — instead of a label guessed afterwards by another model. It appears the moment the action starts, on the action's own row and on the folded group above it.
- It costs no extra model call, and it works for tools from MCP servers too. A server that already uses that field keeps its own; nothing of yours is overwritten.
- Naming now does one job: giving new conversations their title.

## Chat opens instantly

- The Chat tab no longer says "Preparing Chat…". It opens on an empty composer you can type into straight away; your first message starts the conversation.
- Each time you launch the app, Chat starts fresh. Earlier chats stay in the list, one click away.
- While you are in Code, a quiet dot on the Chat tab tells you a reply arrived there — and the other way round.

## Fixes

- A long conversation whose older messages were set aside can always be read back. The dead end that said "Open this conversation again to read them" is gone; scrolling up reaches the first message.
- A message sent to an agent from its parent now appears in that agent's conversation as it arrives, instead of only after reopening it.
- The view keeps following the conversation when several things arrive at once, and stops following only when you scroll away yourself.
- The `@` picker selects folders, not just files, and understands the paths you are used to: `~`, `~/project`, `./`, `../`, absolute paths, and Windows spellings with drive letters or backslashes.
- "Load more" in the conversation list now loads on the first click, every time, and says how many it will load: "Load 7 more".
