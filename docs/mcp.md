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
programmatic entry** — `createMcpAdapter({ config, clientIdentity })` — with an in-memory
configuration the worker builds from Laser's own files. The adapter's file
discovery (`.mcp.json`, `~/.config/mcp/mcp.json`, `.pi/mcp.json`, host-config
imports) is never active: `config` mode is an isolated snapshot by upstream's
own contract, and `.pi` is neither a migration source nor supported Laser
configuration (invariant 6b). The adapter's terminal surfaces (`/mcp`,
`/mcp setup`, the panel) are not offered; Laser's Settings is the surface.

Client identity belongs to the product, not the adapter. The exact-version
`pi-mcp-adapter@2.33.0` pnpm patch adds an optional `clientIdentity` seam;
`packages/worker/src/mcp/identity.ts` supplies product-derived name, title,
version and OAuth registration defaults. Session and inspector connections use
`<product>-mcp-<server>` over every transport; endpoint probes and OAuth discovery
use `<product>-mcp`. OAuth registration uses the product display name and
homepage unless the server explicitly supplies `oauth.clientName`/`clientUri`.
No engine environment variable or agent-directory lookup is changed. See
[`upstream.md`](upstream.md) for the patch and its regression coverage.

The adapter is loaded into a session **only when that project has at least one
enabled server**. With no servers the model sees no `mcp` tool and no
`mcpScript` tool, because a tool the model can see must do something.

Adapter settings Laser fixes (never exposed): `toolPrefix: "server"`,
`showStatusIcon: false`, `mcpFooterStatus: "off"`, `notifyOnStartupConnect:
false`, `hostConfigDiscovery: "off"`, `autoAuth: false`, `sampling` and
`elicitation` on (they render through the inline dialog cards), `outputGuard`
default, `scriptMode` on, `freezeDirectTools: true`. Every server uses
progressive discovery unless its saved policy explicitly sets `alwaysLoad`.
Legacy `exposure: direct/search` is not evidence of that choice. The adapter's
registration surface freezes at the first provider request; discovery returns
conversation results, never new provider definitions. Namespace gateways are
not registered. Connections remain available until the session runtime closes.

### Conversation context

`mcp({ search, detail: names|summary|full })` and script discovery share one
ranked projection. Summary is the default; complete schemas are returned only
when requested. Pages include server groups and a catalog revision; a changed
continuation refuses and asks for a fresh search rather than skipping entries.
The adapter retains its weighted keyword ranker and exposes an optional ranking
strategy over the authorized catalog. No embedding service is required.

The automatic discovery target is **2% of the active model's context window**,
shared across servers within a single lookup. Explicit preload does not consume
that soft allowance; it is measured and warned about separately. The byte-based
token bound is deliberately conservative and labelled, not presented as billed usage. Full schemas are
atomic; oversized automatic detail asks for explicit inspection. Small known
windows can therefore return an empty full-schema page; names/summaries and
explicit inspection remain the supported paths. Actionable guidance is capped
separately at 1 KiB and cannot displace the lookup’s items. An explicit
single-tool description may exceed the soft share, not the known window;
unknown windows retain a labelled 16 KiB names/summary lookup allowance without
claiming a context-window share. Full-page requests degrade to summaries.
Provider-sized preload bounds stop the request before send. Smallest useful summary responses may exceed the soft target.

Advanced → **Put every tool in the conversation** is off by default. It applies
to new session runtimes; running ones retain their captured configuration and
definitions. Existing exclusions and approval rules survive. On read, legacy
`exposure` and
`only` are removed from normalized policy; a nonempty `only` forces preload off
rather than silently broadening it. Files are not rewritten at startup.
The inspector separately shows saved policy and explicitly selected
running-conversation evidence. This is not a claim of provider cache hits or
permanent discovery history after reload/compaction. See [the design and
requirements matrix](mcp-client.md).

| Runtime | Contract |
| --- | --- |
| Environment | Desktop startup resolves exported login-shell variables; terminal launches refresh an adopted host too. New commands and newly connected stdio servers inherit them. Existing servers need **Reconnect**; explicit `env` wins and `inheritEnv: false` stays isolated. No host or worker restart. See [Shell environment](shell-environment.md). |

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

A project with an environment command (`docs/project-environment.md`) gives its
stdio servers that environment instead, unless the server is configured with
`inheritEnv: false`. Explicit `env` values still win, and an already-connected
server keeps what it started with until it is reconnected.

OAuth tokens are stored by the adapter in the operating system credential
store, partitioned by configuration scope and transport target, with a repair
epoch. Display names alone never identify an account. An unowned legacy entry
requires sign-in again and remains until scoped sign-in succeeds. Tokens never
enter the host, protocol or model; the worker's durable authorization registry
contains only identities, generations and timestamps.

Writes use the same discipline as `search-connections.json`: a lock on the
stable path, an atomic replace, and user-only permissions for anything under
the agent directory. The worker owns every read and write; the host routes
`mcp/*` requests to the worker of the project named in `cwd` and never parses
these files itself.

New definitions apply to later conversations. Settings and sign-in mutations
immediately fence old runtimes before cached discovery or another forwarded call,
without rewriting their serialized provider tools or history. They refuse rather
than silently reconnecting with captured credentials. An authorized OAuth refresh
advances only its initiating runtime and rotates its response-cache partition;
peer runtimes remain stale. The token-save transaction covers manual, loopback
and automatic refresh paths; a late refresh cannot undo sign-out.

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
- **Startup** is `on-demand` (default: connect on first use),
  `on-demand-keep`, `at-start` and `always`. Session connections do not idle out
  between turns; legacy idle timing is retained in configuration but not offered
  as a conversation control.
- **Tools** carry one explicit `alwaysLoad` boolean (default false),
  `include`/`exclude` (which tools exist at all, as names or globs) and `approve`
  (call-time approval for all or for matching tools).
- **Status** for a person is one of: `connected`, `ready` (fresh tools in the
  current authorization context, without a live connection), `starting`,
  `needs-auth`, `failed`, `off`, `unknown`. A retained or name-only catalogue
  cannot make a server ready. A connection and fresh tool information are
  separate facts; expired counts read **Last listed**.

Every method is `cwd`-routed to the project's worker. The list is the
contract; the schemas in `schemas.ts` and the round-trip sample in
`test/schemas.test.ts` pin the shapes.

| Method | What it does |
| --- | --- |
| `mcp/list` | every server visible to this project, both scopes, with its effective status and counts; separate conversation context snapshots keyed by session path |
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
(Playwright: where the browser runs, and whether its own window is hidden), what it needs on the
machine, and the exposure it should start with.

## Playwright: which browser

The gallery’s **Where the browser runs** choice has three ways in:

| Choice | What happens | Arguments |
| --- | --- | --- |
| **A window of its own** (default) | Laser opens its own browser window. Several conversations can browse at once; logins do not carry over. **Hide the browser window** is available only here. | `--isolated`, optionally `--headless` |
| **Your Chrome, through the Playwright extension** (recommended for your own Chrome) | Uses the Chrome you are signed into. Install the [Playwright Extension from the Chrome Web Store](https://chromewebstore.google.com/detail/playwright-extension/mmlmfjhmonkocbjadbfplnigmagldckm). The first connection asks you to pick a tab unless `PLAYWRIGHT_MCP_EXTENSION_TOKEN` is in your environment. Only tabs in the Playwright tab group are visible to the model. | `--extension` |
| **Your Chrome, through remote debugging** | Uses the Chrome you are signed into, without an extension, but is slower. Once, in Chrome, open `chrome://inspect/#remote-debugging` and turn on **Allow remote debugging for this browser instance**. | `--cdp-endpoint=chrome` |

**The extension is the recommended own-Chrome way and works with the token.**
If pages open in Chrome but the model reports a closed page, another extension
is taking the tab’s debugger — screen recorders, downloaders and other AI browser
agents are the usual ones. Disable it and **Reconnect**. This is an extension
conflict, not a general limitation of Playwright’s extension. Remote debugging is
the slower alternative when you cannot disable the conflicting extension.

**Test checks browsing, not just connection.** For a Playwright gallery definition,
Test opens `about:blank` in the selected browser/tab and then lists tabs on the
same inspector connection. The two calls share a 20-second limit; failure says
“Connected, but the browser could not open a page” with the browser’s one-line
reason and the next step for that mode. A successful handshake alone is not
success. The draft connection closes afterward. Opening the inspector for an
already saved server does not navigate; neither do tests of other catalog entries.

Catalog options are a backwards-compatible union: a toggle (`kind?: "toggle"`,
`arg`, boolean `default`) or a choice (`kind: "choice"`, `choices` with IDs,
labels, descriptions and argument arrays, string `default`). A toggle may require
one choice; otherwise its reason replaces the control and its argument is omitted.
These options only compose new definitions in Add. Saved servers keep their exact
arguments; Edit continues to show the saved command.

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
descriptions, and saves it with tools found when needed. No tool-count cutoff
changes that default. The page explains the choice and points to Advanced for
the explicit preload override.

**Tool freshness.** The inspector revalidates through the SDK on access and before
Run. Missing, invalid or zero lifetime means no reusable catalogue; the page says
that lists without a lifetime refresh for each use. Positive expiry is preserved
from receipt, including the earliest expiry of a complete paginated result. A
local repaint marks expiry without polling a server. Notifications immediately
invalidate old offered tools; failed refresh never declares an empty catalogue
current. Historical counts remain labelled rather than being execution authority.
The protocol carries only observation/expiry times and an opaque runtime attribution
revision, never credential accounts or generation records.

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
  **Ask first** (approval). Bulk: all on, all off. Each change is one
  `mcp/save`; no per-tool control silently changes preload policy. A separate
  conversation selector shows the model window, per-lookup 2% allowance, conservative MCP
  definition cost, included tool names, and tools found/inspected with their
  revision. Inspector connections are never reported as model discoveries.
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

The unpacked build carries the adapter's executable TypeScript, compiled
exports, `app-bridge.bundle.js`, `mcp-keyring-helper.cjs`,
`mcp-script-worker.mjs`, and `skills/` (including Markdown instructions), plus
jiti, TOML, both integrity-pinned MCP SDK tarballs, the adapter's keyring 1.3.0
platform binding (separate from the desktop's 2.0.0), and
`fs-native-extensions/prebuilds`. The worker directly pins all six desktop
keyring 1.3.0 platform bindings as optional dependencies, and the pre-pack guard
checks the build target against the adapter's own resolved keyring. jiti caches
transpilation under `<agentDir>/cache/jiti` across worker restarts, falling back
to memory if that directory cannot be created or written; installed resources
need no write access. The adapter's published
`files` excludes `conformance/`, `examples/`, `__tests__/` and `*.test.ts`;
only root Markdown documentation is disposable, not its skills. After
`pnpm -F @lasercode/desktop run pack`,
`node packages/desktop/scripts/clean-machine.mjs` validates those assets and
loads both native bindings with bundled Node. With an empty incoming `PATH`
and fake `HOME`, it configures the small, inert acceptance fixture shipped at
`resources/checks/mcp-server.mjs` using the
literal command `node`, opens a real session with MCP enabled, observes
`packaged_runtime` in an actual local provider request, checks the companion's
active MCP module, and inspects/calls the fixture through the worker's MCP
service. The call reports the bundled Node's exact executable path, proving
`runtime-env.ts` supplied the runtime rather than a system installation; no
credentials or network download is needed for the gate.
When the bundled runtime has no `npm`/`npx` executables, the worker creates launchers in `<agentDir>/bin` that run its bundled Node and package-manager entry points, never adds npm's internal `bin` directory to PATH, and the offline gate also checks `npx --version`.

## Verification

Protocol schema samples and host routing tests cover every `mcp/*` method.
Worker tests drive the real engine with the real adapter against the Playwright
MCP server over stdio and over Streamable HTTP, through the stub provider, and
assert the registered tool names, the result shapes and the status snapshots.
UI interaction tests cover the list, the add doors, the inspector's tool
controls, run, import and sign-in states against a fake host. The packaged
gate proves the stdio path with the bundled runtime.

Source: https://github.com/nicobailon/pi-mcp-adapter · https://github.com/microsoft/playwright-mcp
