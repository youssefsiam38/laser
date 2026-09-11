# MCP servers

Status: **binding design for M14** (`PLAN.md` "M14 · MCP servers"). Read
[`AGENTS.md`](../AGENTS.md) §4 invariant 6b and [`web-search.md`](web-search.md)
first: MCP follows the same shape — an exact-pinned upstream engine, a Laser-owned
configuration and a Laser-owned experience — and this file is what makes that
shape concrete for MCP.

The Model Context Protocol is the industry standard for giving an agent tools
from outside programs: a browser (Playwright), a database, an issue tracker, a
documentation index. A person who has used any other coding agent expects to
paste a command or a URL and have the tools appear. Laser goes further: every
server is inspectable, every tool is individually controllable, and nothing
about it needs a terminal.

## The engine

The worker pins `pi-mcp-adapter` at an exact version. It is the reviewed
upstream MCP client for the Pi engine: all three transports, OAuth 2.1 with
dynamic client registration, bearer tokens, lazy lifecycles, a metadata cache
that keeps tool definitions available without live connections, direct and
proxied tool exposure, per-call approvals, elicitation through the four stock
dialogs, sampling, and an output guard. Laser drives it **only through its
programmatic entry** — `createMcpAdapter({ config })` — with an in-memory
configuration the worker builds from Laser's own files. The adapter's file
discovery (`.mcp.json`, `~/.config/mcp/mcp.json`, `.pi/mcp.json`, host-config
imports) is never active: `config` mode is an isolated snapshot by upstream's
own contract, and `.pi` is neither a migration source nor supported Laser
configuration (invariant 6b). The adapter's terminal surfaces (`/mcp`,
`/mcp setup`, the panel) are not offered; Laser's Settings is the surface.

The adapter is loaded into a session **only when that project has at least one
enabled server**. With no servers the model sees no `mcp` tool and no
`mcpScript` tool, because a tool the model can see must do something.

Adapter settings Laser fixes (never exposed): `toolPrefix: "server"`,
`showStatusIcon: false`, `mcpFooterStatus: "off"`, `notifyOnStartupConnect:
false`, `hostConfigDiscovery: "off"`, `autoAuth: false`, `sampling` and
`elicitation` on (they render through the inline dialog cards), `outputGuard`
default, `scriptMode` on. Direct tools are registered from the cache, so a
server that has connected once has its tools in the model's list from the
first turn of the next session.

## Where configuration lives

| Scope | File | Shared with a team |
| --- | --- | --- |
| Every project | `<agentDir>/<data dir>/mcp.json` | no |
| This project | `<project>/.laser/mcp.json` | yes — commit it |
| Secrets, both scopes | `<agentDir>/<data dir>/mcp-secrets.json`, mode 0600 | never |

The effective set for a project is the global list with the project list laid
over it by `name`: a project entry replaces a global entry of the same name,
and a project entry may be just `{ "name": "…", "disabled": true }` to switch a
global server off for that project (the only entry without a transport; the
list reports it as the global definition with `disabled: true` and
`overridesGlobal`). Secrets — a bearer token, an OAuth client
secret, an `env` or header value the person marks as secret — are written to
the secrets file keyed by scope, project, server and field, and the config file
holds `{ "secret": true }` where the value would be. A teammate who checks out
`.laser/mcp.json` sees the field marked secret and empty, and is asked for a
value; the value itself never enters git. `${VAR}` and `$env:VAR` references
still work for people who prefer them, with the honest caveat that a desktop
app's environment is not a shell's.

OAuth tokens are stored by the adapter in the operating system credential
store, keyed by server name and bound to the server URL; Laser never sees or
stores them.

Writes use the same discipline as `search-connections.json`: a lock on the
stable path, an atomic replace, and user-only permissions for anything under
the agent directory. The worker owns every read and write; the host routes
`mcp/*` requests to the worker of the project named in `cwd` and never parses
these files itself.

Changing configuration applies to sessions started afterwards. A running
session keeps the servers it started with — its tool list is part of the
conversation the model is having — and the Settings page says so, with the
project restart the host already offers for people who want it now.

## The vocabulary (`packages/protocol/src/mcp.ts`)

Laser's schema is its own and engine-neutral. The worker maps it onto the
adapter's `ServerEntry`; nothing above the worker knows the adapter's field
names.

- **Transport** is a discriminated union, one member per way of connecting:
  `stdio` (a command with arguments, environment, working directory and
  whether the app environment is inherited), `http` (a URL, headers, an
  optional CA file, and whether to negotiate Streamable HTTP with SSE
  fallback or force one), and `socket` (an explicit Unix-domain socket path,
  for servers shared through `rmcp-mux`).
- **Auth** is `none`, `bearer` (a secret token) or `oauth` (optional
  pre-registered client id and secret, scope, redirect URI, metadata URL,
  grant type). HTTP only; the schema refuses it elsewhere.
- **Startup** is `on-demand` (default: connect on first use, disconnect when
  idle), `on-demand-keep`, `at-start` and `always`.
- **Tools** carry `exposure` — `direct` (each tool is its own tool in the
  model's list), `on-demand` (through the one search-and-call tool) or
  `search` (registered inactive, activated by a search) — plus `only`
  (direct exposure restricted to named tools), `include`/`exclude`
  (which tools exist at all, as names or globs) and `approve` (call-time
  approval for all or for matching tools).
- **Status** for a person is one of: `connected`, `ready` (tools known from
  the cache, not connected right now), `starting`, `needs-auth`, `failed`,
  `off`, `unknown`. The adapter's `cached`/`not-connected` collapse into
  `ready` and `unknown` — a person wants to know whether the tools are
  usable, not which internal state produced that answer.

Every method is `cwd`-routed to the project's worker. The list is the
contract; the schemas in `schemas.ts` and the round-trip sample in
`test/schemas.test.ts` pin the shapes.

| Method | What it does |
| --- | --- |
| `mcp/list` | every server visible to this project, both scopes, with its effective status and counts |
| `mcp/save` | create or replace one server in one scope; validates; stores secrets; never connects |
| `mcp/remove` | delete one server from one scope, and its secrets |
| `mcp/inspect` | connect to one server outside any session and return what it is: server name and version, protocol version, capabilities, instructions, every tool with its description and input schema, resources and templates, prompts with arguments; the connection latency |
| `mcp/ping` | one MCP `ping` round trip on the inspector connection, with latency; connects first when needed |
| `mcp/call` | run one tool on the inspector connection with the given arguments and return its raw result and duration |
| `mcp/disconnect` | close the inspector connection for a server |
| `mcp/auth/start` | begin OAuth: returns the authorization URL and whether a loopback callback is listening |
| `mcp/auth/complete` | finish OAuth from a pasted callback URL or code (remote and headless) |
| `mcp/auth/logout` | forget stored OAuth credentials for a server |
| `mcp/import/detect` | find configurations other tools left on this machine — the project's `.mcp.json`, `~/.config/mcp/mcp.json`, Claude Code, Cursor, VS Code, Windsurf, Codex, OpenCode — and list their servers with conflicts against what Laser already has |
| `mcp/import/apply` | copy chosen servers from one detected source into one Laser scope; secrets found inline are moved to the secrets store |

Notification `mcp/changed { cwd }` follows every configuration write and every
status change the companion reports; the UI reloads on it. The companion's
snapshot itself travels as `lasercode/mcp/status` on `pi/extension/message`
and the worker keeps the last one per session to answer `mcp/list`.

A curated catalog, `MCP_KNOWN_SERVERS`, ships in the protocol: Playwright
first, then Chrome DevTools, Context7, DeepWiki, GitHub, Notion, Linear, Sentry
— each with a verified definition, the options a person is likely to want
(Playwright: headless, keep logins between conversations), what it needs on the
machine, and the exposure it should start with.

## The experience — Settings → MCP servers

Put yourself in the seat of a developer adding Playwright. They want to know,
without guessing: is it running, what can it do, exactly which of those things
the model will see, and what happens when a tool is called. The page answers
all four.

**The list.** One row per server, both scopes, project rows first. Each row:
name, a transport summary (`npx @playwright/mcp` · command; `mcp.context7.com`
· HTTP; a socket path), the status pill in plain words, the tool count with
how many are direct, and the scope. Rows are the `mcp-server-panel` element
restyled to `DESIGN.md`. Empty state: the curated gallery, with Playwright
first, and the import banner when something was detected on the machine.

**Adding.** Two doors. *From the gallery*: one click, the options it offers,
Add. *Custom*: a transport picker — Command, URL, Socket — and only the fields
that transport has. The URL door detects the need for sign-in on test and
offers OAuth; the Command door checks that the executable resolves and says
which PATH it looked in when it does not. Both doors end in **Test**, which is
`mcp/inspect`: the person sees the server's name and version, its tools with
descriptions, and chooses how the tools reach the model before saving. The
default exposure is `direct` when the server has forty tools or fewer and
`on-demand` above that, and the page says which it chose and why.

**Inspecting.** Selecting a row opens the inspector, a full-height sheet on a
wide screen and a page on a phone:

- *Overview*: status, latency of the last ping, server name and version,
  protocol version, capabilities, the instructions the server publishes, the
  transport and auth in full (secrets masked), scope. Actions: **Ping**,
  **Reconnect**, **Sign in** / **Sign out** for OAuth, **Turn off** / **Turn
  on**, **Edit**, **Remove**. A failure shows the server's own message and the
  tail of its stderr, written for a person.
- *Tools*: every tool the server advertises, searchable, with description and
  input schema rendered as a compact shape. Per tool: **On/Off** (exclude),
  **Direct** (the `only` list when exposure is direct), **Ask first**
  (approval). Bulk: all on, all off, all direct. Each change is one
  `mcp/save`. A tool that the model cannot see says why (excluded, or
  on-demand only).
- *Run*: pick a tool, fill its arguments (a form from the schema; JSON for
  the rest), run it on the inspector connection, see the result — text,
  images, structured content — and how long it took. This is the
  developer's proof that the server does what they think, before the model
  ever calls it.
- *Resources* and *Prompts*: what the server offers besides tools, listed
  with descriptions and arguments.

**Importing.** When `.mcp.json`, the shared global file, or another tool's
configuration is found, a banner says what was found and where. The import
dialog lists servers per source, marks conflicts with existing names, shows
each server's transport in full, and asks for a scope. Nothing is read from
those files without the person choosing to; nothing is ever written to them.

**Sign-in.** OAuth opens the browser; the page watches for completion and
turns the row `connected`. When the browser cannot reach the app (remote,
phone), the page shows the URL to open elsewhere and a field for the callback
URL.

**In the transcript.** A direct tool call renders as *Playwright · navigate*
with its arguments; the proxy tool's modes (search, describe, call, connect,
status) each get a readable summary. Image content in a result — a Playwright
screenshot — renders as an image, never as a base64 blob. Search projections
cover the value regions.

Both themes, both widths, keyboard for everything, `prefers-reduced-motion`
respected, no data below 12px. A running conversation's tool approval for an
MCP tool renders inline in the tool row like every other question.

## Packaged builds

Executable dependency source must survive packaging (AGENTS.md §5a): the
adapter ships TypeScript the engine transpiles at runtime, `app-bridge.bundle.js`,
and a CommonJS keyring helper, and its native modules (`@napi-rs/keyring` and
`fs-native-extensions`) need their platform bindings on disk. The packaged
gate opens a session with a stdio server from the unpacked build with an empty
`PATH`: the worker prepends the bundled runtime's `bin` directory so `node`,
`npm` and `npx` resolve without a system Node.

## Verification

Protocol schema samples and host routing tests cover every `mcp/*` method.
Worker tests drive the real engine with the real adapter against the Playwright
MCP server over stdio and over Streamable HTTP, through the stub provider, and
assert the registered tool names, the result shapes and the status snapshots.
UI interaction tests cover the list, the add doors, the inspector's tool
controls, run, import and sign-in states against a fake host. The packaged
gate proves the stdio path with the bundled runtime.

Source: https://github.com/nicobailon/pi-mcp-adapter · https://github.com/microsoft/playwright-mcp
