# Settings → MCP servers — what to look at in the browser

These tests run against a fake host (`vi.mock` of `@/runtime`), so they prove
behaviour, not pixels. The browser review still has to happen once the worker's
`mcp/*` methods are integrated. This is the shortest path through every state
the page has, at a desktop width and a phone width, in both themes.

Open **Settings → MCP servers** with a project selected. (With no project the
tab shows the same "Open a project first" state as the other project tabs.)

## 1 · Empty

A project with no servers: the curated gallery (Playwright first, eight cards),
and the import banner above it when anything was detected on the machine. No
blank page, no spinner left behind.

## 2 · The list, with every status

The list should show project rows first, then every-project rows, each with the
transport summary, the status word, the tool count with the direct share and the
scope tag. To see all seven status words, have (or fake) servers that are
`connected`, `ready`, `starting`, `needs-auth`, `failed`, `off` and one never
connected (`Not seen yet`). Check:

- a row whose command is very long truncates and keeps the full command in the
  title, and the page never scrolls sideways;
- `shadowed` and `overridesGlobal` rows carry their sentence;
- the scope filter (All · Every project · This project);
- keyboard: Tab reaches every row, Enter opens the inspector, focus ring is the
  2px `--live` outline.

## 3 · Adding, both doors

- **Gallery**: click *Add Playwright*. The two options are switches with their
  descriptions (fresh browser on, hidden window off). *Test* connects — watch the
  "Connecting to the server" loader — then shows the server name, version,
  latency, the tool list with descriptions and shapes, and the exposure choice
  with the sentence that says why it was chosen. *Add* saves.
- **Custom**: *Add a server* → the transport picker. Check each transport shows
  only its own fields (Command / URL / Socket), that pasting
  `npx -y @playwright/mcp@latest` into Command works, that the sign-in section
  appears for URL only, and that env/header rows have a per-row **Secret**
  toggle. A secret field says "Saved" or "Needs a value" and never shows a value.
- A failing test shows the server's own message and the tail of its stderr.
- A server that needs sign-in offers **Add and sign in**.

## 4 · Inspector

Open a row: a full-height sheet on a wide screen, the whole screen on a phone.

- *Overview*: status, latency, server name/version, protocol version,
  capabilities, the server's instructions in a scrolling block, transport and
  auth with secrets masked, scope, and the actions (Ping, Reconnect, Sign in /
  Sign out for OAuth, Turn off / Turn on, Edit, Remove).
- *Tools*: search, the per-tool On / Direct / Ask first switches, the bulk
  buttons, and the sentence a tool the model cannot see carries. Switch the
  server to on-demand and check Direct is disabled with its reason.
- *Run*: pick a tool, fill the generated form, run it. A screenshot tool proves
  the image path; check `structuredContent` in the JSON viewer and the duration.
- *Resources* and *Prompts*: lists with descriptions and required markers.
- Closing a **command** server disconnects it (the tooltip says so). Watch that
  no process is left behind.

## 5 · Import

The banner says what was found and where. The dialog lists sources with their
path, conflicts marked, unsupported entries disabled with the reason, the scope
choice, and the replace switch that appears only when a conflicting server is
selected.

## 6 · Sign-in

*Sign in* on an OAuth row: the authorization link (opens in the browser), the
copy button, "Waiting for the browser to finish" when a callback is listening,
and the paste field for the callback address or code when it is not. Completion
arrives as `mcp/changed` and the row turns connected. *Sign out* asks first.

## 7 · Everything, twice

Both themes, both widths, mouse and touch, and with `prefers-reduced-motion:
reduce` — the sheet and the collapsibles lose their movement and nothing else.
No text under 12px, no clipped value, no horizontal page scroll.
