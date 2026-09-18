# Laser 0.9.2

A repair release for long conversations and for Settings. Everything here came from using Laser for real work and finding it wanting.

## Reading upwards no longer loops

In a long, tool-heavy conversation, scrolling up used to reach the top of what was loaded, then throw you back to the bottom of the same section — over and over. The older page had actually arrived; the transcript then re-placed you from an estimate that happened to equal the bottom of the loaded window. Sometimes the whole window you had built was replaced by the newest messages instead.

Now an older page arrives above you and you stay exactly where you were reading. Older history occupies real scroll range before it loads, so the scrollbar thumb reflects the size of the conversation, and dragging it deep into the past loads pages in order. There is no loading card: unloaded history is drawn as quiet placeholder rows that become the real messages in place. Paging keeps working while the agent is still writing, through compaction, and after a device trimmed the view under memory pressure; the only time you see text and a button is when a compaction invalidated the page you held and you need to reload the recent messages.

## Full replies and reasoning read as documents

"Full reply", "Full reasoning" and "Full message" now render Markdown the way the transcript does — headings, lists, code with highlighting, tables, links, math — in a reading column, with Find on the rendered text, whole-body Copy and Download unchanged, and a Plain text switch. Very long bodies open as plain text and say so. Tool output and requests keep the plain reader.

## Settings have one scope, and it is yours to choose

Settings, MCP servers, Web Search, Features and Agents now share one explicit scope — Global, Project or Effective — chosen once at the top of Settings. Nothing infers a project from the open conversation any more. Project shows a project's own definitions beside its inherited Global ones, with an explicit Override; Effective is a read-only preview of what applies. Unsaved edits are guarded when you switch scope, follow a link, or close. Deleting an agent removes exactly the definition you are looking at, and a project that ships its own agent definitions asks for trust before Laser reads them, like project settings.

## Images keep their words

A prompt with an image and a caption showed only the image, and "Show full message" opened empty. The caption stays with the image now, and the full message opens.

## Small things that were very annoying

- `@/` in the composer lists the root of your machine; any path browses. Backspace in the mention picker only deletes a character — it no longer rewrites `@../` into `@../../`.
- Spelling suggestions in the packaged app on Linux.
- A conversation started by picking an agent, before typing anything, still lets you change the agent.
- The agent's tool rows remain selectable text.

## Not in this release

Under heavy memory pressure the last of many images in one conversation can still show as unavailable until you reopen it; that repair (M16-T82) follows in 0.9.3.
