# Searchable conversation content

This contract is for conversations, not low-level diagnostics. The API request
modal's **Full request** scope searches the complete retained, redacted JSON,
including keys, values and syntax. Its section scope searches the rendered
instructions/conversation content without counting duplicate previews. Native
request highlights are isolated from conversation highlights; Ctrl/Cmd+F scopes
to the current section, Ctrl/Cmd+Shift+F scopes to the full request, and Escape
closes find before closing the modal. Searches never fetch or send model calls.
Full-request search scans the payload once, not the concatenated section views.
Instructions also appearing in Full JSON do not create extra matches. Identical
text in two distinct payload locations remains two genuine occurrences.

Session find and saved-history search use `toolSearchContent` in
`packages/protocol/src/search-content.ts`. This is a pure display contract,
not a dump of a tool's schema. The UI and host must not independently stringify
requests or result envelopes for indexing.

| Surface | Search content | Excluded |
| --- | --- | --- |
| Terminal | Command text and output | Argument keys, timeout, exit-status chrome |
| Edit/write | Displayed path and bounded diff lines; error text on failure | Hidden success confirmation, omitted diff lines, gutters |
| Read/grep/find/list | Argument JSON values and displayed output | JSON keys, result-envelope metadata and images |
| Unknown tool | Nested argument/result JSON values, or plain output text | JSON keys and content-envelope metadata/images |
| MCP direct tool (`<server>_<tool>`) | Argument JSON values, then the result's text blocks in order **as the Markdown renderer draws them**, and a resource block's displayed name (its uri when it has none) with its text | JSON keys, the `details` envelope (server, tool, error kind), the registered tool name, a resource's uri when a name is shown, image and audio base64 |
| MCP gateway (`mcp`, `mcp__<server>`) | Argument values, the mode's own list — a search's `server`/`tool` matches, a status row's name, status and tool count — then the visible text; a call shows the called tool's result | Match scores, listen state, byte counts and every other `details` field |
| MCP script (`mcpScript`) | The argument values (the row draws the same disclosure every other row does), the code as the fence shows it, and the result text | The call trace beneath it |
| Agent completion (`complete_agent_run`) | The final message, drawn as the child's last assistant block | The status badge, the clock, the harness's reply |
| Agent event / task exit (custom messages) | The child's message and the person's reason; the task's command | The sentence, labels, clocks and the Output action |

### Markdown bodies

A body drawn by the Markdown renderer is indexed as the renderer draws it, not
as the model wrote it: `mcpDisplayText` drops a fence's ``` line and its
language label (marked `data-search-exclude` in `markdown-text.tsx`, so no
answer matches on `js`), keeps code inside a fence verbatim, replaces a link
with its label, removes an image, and drops heading, quote and list markers
that the layout draws instead of writing out. Assistant message text is indexed
raw for the same renderer; the tolerance below therefore applies to both.

**Tolerance.** Inline emphasis (`**bold**`), inline code backticks, table pipes
and backslash escapes are still in the projected text and not in the DOM. A
query made only of those characters can produce a result row whose highlight is
not found. Anything that moves *words* — links, images, fence labels, block
markers — must be reconciled, and a new Markdown-drawn body adds its case to
`mcpDisplayText` and to the equality test in
`packages/ui/test/thread/mcp-tool-rows.test.tsx`.

For example, `{ "command": "echo hello" }` does **not** match `command`.
`{ "command": "command -v node" }` does. Text inside commands, source code,
and terminal output stays literal: a JSON key printed by a command is actual
output, not request structure, and remains searchable.

Each projection returns separate text fragments. A phrase cannot span unrelated
JSON values or diff rows. JSON strings use exactly the escaped spelling the JSON
viewer displays; terminal strings stay untouched. Nothing decodes user escapes.

## Adding or changing a tool renderer

1. If it uses the generic JSON fallback, no registry entry is necessary. All
   primitive values are searchable recursively, including future nested fields.
   A tool whose *name* cannot be known in advance needs a rule instead of an
   entry: an MCP server's tools are registered as `<server>_<tool>`, so they are
   recognised by the `details.server` their result carries, and the shared
   `mcpContentBlocks` transform is what both the row and the projection walk.
2. If it has a specialized body, add a `TOOL_SEARCH_PROJECTIONS` entry naming
   precisely the fields it displays. Reuse pure display transforms rather than
   reimplementing them for search (`tool-diff.ts` is shared for this reason).
3. Mark each matching DOM text region with `data-search-content`. Within a tool
   row, unmarked text is excluded. Mark values, never their labels or enclosing
   JSON object. Use `data-search-exclude` for nested non-content controls.
4. Preserve field order and text spelling between projection and DOM. Highlights
   may span syntax-coloring nodes inside one region, never different fields.
5. Make hidden matches revealable through transient `useSearchReveal()` state.
   JSON folds and terminal elision restore their previous state when find closes.
   Content permanently omitted by a renderer must not be indexed.
6. Add tests proving a key-only miss, a visible-value hit, nested/partial output,
   and equality between projected occurrences and actual DOM highlight ranges.

Host search pairs saved calls with their results and flushes unfinished calls at
end of file. It flattens a stored result to the joined text of its text blocks
(`toolOutputText`) — no base64, no `details` — which is what the UI indexed for
every tool until the transcript began keeping the stored envelope for a result
that carries `details` or a non-text block (`storedToolResult`, `store.ts`).
The two therefore agree on words and diverge on three things for those results:
the host joins blocks that Find keeps apart (so only in the host can a phrase
span two blocks), and, having no `details`, the host indexes neither a gateway's
matches and status rows nor a diff's lines where the UI now does. Bringing the
host to the same shape is the host owner's change; until then the note in
`packages/host/src/session-search.ts` describing hydration as text-only is
stale, and this paragraph is the contract. Live
session search also consumes partial output; it never indexes provider metadata,
credentials or image data from the tool result envelope. No workers are started
to search saved sessions.
