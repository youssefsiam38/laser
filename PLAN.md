# PLAN.md — laser

Dependency-ordered plan. No dates, no estimates. A milestone is a set of tasks
with a "done when" that can be checked. Task IDs are permanent. Status lives in
`STATUS.md` (summary) and `STATUS_DETAILED.md` (ledger). Read `AGENTS.md` first.

## What laser is

A visualization and control layer on top of the Pi coding agent:

- Desktop app built on web tech (Electron shell, one web bundle).
- Many sessions across many project directories, with fast navigation.
- pi-subagents children as interactive tab groups, including workflow and
  mission views.
- Settings UI for every Pi setting, package management, providers and models.
- Realtime, copiable, low-level logs (provider requests, tool calls, events).
- A lightweight relay for Railway giving phones and other devices the same UI
  through an end-to-end encrypted channel, with QR pairing and device revocation.
- Mobile-first responsive UI shipped as a PWA (no native shell).
- **Self-contained**: one command installs a native Linux desktop app that
  bundles its own runtime and agent. No Node, no npm, no separate agent
  install, and no terminal after the first line. The person need not know
  which agent runs underneath.
- **Fully themeable**: every visual value is a token the person can change
  from Settings, defaulting to a plain dark preset.
- Built-in support for community packages when present: pi-subagents,
  pi-gpt-transcribe, pi-web-access.

## Fixed decisions (see STATUS_DETAILED.md decisions log for reasoning)

- Build on the stable Pi SDK now; migrate the Pi-facing layer when community
  packages visibly move to pi-server/Chord.
- Modular: everything above the worker speaks the ACP-shaped protocol.
- Pi version pinned inside the worker.
- `SessionDriver` interface with two implementations from day one.
- Portable extension UI surface only; native replacements for TUI-only extensions.
- pi-subagents foreground and background children both supported, including
  sessions started from a terminal.
- Herdr is out; laser tab groups replace project panes.
- Phone client is a PWA only.
- Relay trust: QR carries an ephemeral public key; a desktop root key signs a
  versioned device list; explicit "Link a device" screen.

## Layout

```
packages/protocol         ACP-shaped messages + pi/* extras, JSON-RPC framing, sequence numbers
packages/worker           per-project Pi host: SessionDriver, StableSdkDriver, ChordDriver, UI bridge, settings/package adapters
packages/pi-extension     the one companion Pi extension: a module per supported package (provider-log, subagents, transcribe, web-access, ...)
packages/host             supervisor: worker per project, session catalog, pi-subagents file layer, local WS server, relay client, log store
packages/ui               the one web app (desktop renderer, browser, PWA)
packages/desktop          Electron shell: main process, tray, notifications, keychain, updater, bundled Node
packages/crypto           Noise handshake, pairing, device list (browser + Node)
packages/relay            Railway byte forwarder (no crypto library)
packages/cli              the `laser` command: host lifecycle, session verbs, Pi passthrough, doctor
docs/                     architecture, research findings, upstream log
```

## Milestone map

```
M0 Foundation
 └─ M1 Local loop (one project, one session, dialogs, transcript)
     ├─ MP Panel system (docs/ux-panels.md: how anything renders)
     │    └─ M3 Subagent tabs
     ├─ M2 Many sessions, many projects
     │    └─ M3 Subagent tabs
     ├─ M4 Settings and logs
     ├─ M5 Desktop shell
     ├─ M6 Relay and pairing
     │    └─ M7 Mobile PWA
     ├─ M8 Package support (transcribe, web-access, native replacements)
     ├─ M9 CLI (host lifecycle, session verbs, Pi passthrough, doctor)
     ├─ M10 Self-contained distribution (one-command install, bundled runtime + agent)
     └─ M11 Theme system (every token a variable, chosen in Settings)
MX Cross-cutting (migration readiness, upstream, security) — runs alongside
```

---

## M0 · Foundation

Goal: the repo, the protocol, and the driver seam exist and are exercised by tests.

Done when: `pnpm -r build && pnpm -r test` passes; a worker can open a pinned Pi
session in a temp directory, send one prompt to a fake model, and stream events
as protocol messages to a test client; `ChordDriver` compiles against the same
interface and its seam test proves no Pi type leaks through `@lasercode/protocol`.

Depends on: nothing.

| ID | Task | Done when |
| --- | --- | --- |
| M0-T1 | Workspace scaffold (pnpm, TS strict, ESM, per-package build/test) | `pnpm install && pnpm -r build` passes on a clean clone |
| M0-T2 | `@lasercode/protocol`: message schemas (ACP core + `pi/*` extras), JSON-RPC envelope, sequence numbers, runtime validation | schema tests pass; a message round-trips through encode/validate/decode |
| M0-T3 | `SessionDriver` interface and `DriverEvent` union | interface reviewed against Pi SDK 0.85 events; documented in `docs/architecture.md` |
| M0-T4 | `StableSdkDriver` opens a session via `createAgentSessionRuntime` with pinned Pi, maps events to protocol messages | test: prompt against a stub provider yields `session/update` messages in order |
| M0-T5 | `ChordDriver` stub + seam test | compiles; test asserts the driver module graph does not import Pi types into protocol |
| M0-T6 | Worker process entry: stdio or socket JSON-RPC transport, one worker = one cwd | test client spawns a worker, opens a session, receives events |
| M0-T7 | Extension UI bridge: `ExtensionUIContext` implementation emitting `pi/ui/request` and resolving on `pi/ui/response`; unsupported methods cancel safely | test: `select`, `confirm`, `input`, `editor` round-trip; `custom()` resolves `undefined` without hanging |
| M0-T8 | CI: build + test on push | workflow file exists and passes |

---

## M1 · Local loop

Goal: a person can use laser in a browser tab for one project: see the
transcript stream, send prompts, steer, abort, answer extension dialogs, switch
model and thinking level, and resume a past session.

Done when: with pi-web-access installed, a `ctx.ui.select` raised by an extension
is answered from the UI; a full prompt/tool/response cycle renders with streaming
markdown; reload of the tab reattaches to the running session with no lost output.

Depends on: M0.

| ID | Task | Done when |
| --- | --- | --- |
| M1-T1 | `@lasercode/host`: spawn and supervise one worker, route JSON-RPC, expose local WebSocket on 127.0.0.1 | UI connects and lists sessions |
| M1-T2 | Session catalog: scan `SessionManager.listAll()` with a cache keyed by (path, size, mtime) | list of past sessions across projects renders in under a second on the user's machine |
| M1-T3 | UI shell: sidebar (projects, sessions), main pane (transcript), composer | keyboard-only navigation works |
| M1-T4 | Transcript renderer: streaming markdown by blocks, tool call cards, thinking blocks, diffs | no flicker on streamed text; code fences highlight after close |
| M1-T5 | Composer: prompt, steer vs follow-up, abort, queue chips, image paste | queued messages editable before delivery |
| M1-T6 | Extension dialogs in the UI: select, confirm, input, editor, notify, status, widget lines, title | pi-web-access `select` answered from UI |
| M1-T7 | Model and thinking controls, session name, compaction trigger | state reflected from `pi/state` messages |
| M1-T8 | Resume and reattach: sequence numbers on every update; client resumes from last seq on reconnect | tab reload loses nothing |
| M1-T9 | Session tree: fork, navigate, labels (from Pi's tree entries) | `/tree` equivalent works in UI |
| M1-T10 | Visual design pass: token system, self-hosted typefaces, icon rail, session cards with status, context ring, tool rows with timing, per-turn usage, highlighted code blocks with copy, floating composer, empty state, motion | the app reads as a finished product in both themes; user signs off on the look |

---

## M2 · Many sessions, many projects

Goal: multiple projects open at once, each in its own worker; quick navigation;
attention model so the user knows which session needs them.

Done when: three projects open with running agents; sidebar shows per-session
state (idle, working, waiting for input, error); switching is instant; a worker
crash affects only its project and is reported.

Depends on: M1.

| ID | Task | Done when |
| --- | --- | --- |
| M2-T1 | Worker pool: one worker per cwd, lifecycle (start, idle retire, crash restart), never two per cwd | test covers restart and duplicate-cwd refusal |
| M2-T2 | Attention model: per-session state machine and an "needs you" inbox sorted by attention, not recency | unread/waiting/error states visible in sidebar and inbox |
| M2-T3 | Fast switching: keep last N transcripts hydrated; others lazy from catalog | switch under 100 ms perceived |
| M2-T4 | Project management: add, remove, trust prompt passthrough, per-project settings awareness | untrusted project shows Pi's trust question in UI |
| M2-T5 | Notifications (desktop) for waiting/finished sessions | notification deep-links to the session |
| M2-T6 | Project git line under the composer: branch, `+added −removed` since session start, "Create PR" when ahead; worker runs git per project, hidden when not a repo | numbers update after each turn that edits files |

---

## M3 · Subagent tabs

Goal: pi-subagents children shown as tab groups under their parent session,
interactive (steer, stop, resume where allowed), with workflow, mission, and
acceptance views. Works for sessions laser started and for sessions started
from a terminal.

Done when: a background run from the user's orchestrator prompt appears as a tab
group with live tool calls; steer and stop work; a mission renders its ledger;
a terminal-started session's children appear via the file layer.

Depends on: M2.

| ID | Task | Done when |
| --- | --- | --- |
| M3-T1 | `subagents` module of the companion extension: consumes `background-work` and `external-runs` registries, bridges `subagents:rpc:v1` and `PI_SUBAGENT_ASYNC_JSON` to `pi/subagents/*` messages | in-process children enumerate and stream |
| M3-T2 | Host file layer: watch `PI_SUBAGENTS_TEMP_ROOT` (pinned) `.active-runs`, `status.json`, `events.jsonl`; parse per pi-subagents 0.65 schemas; handle multiple uid roots | terminal-started background run appears in UI |
| M3-T3 | Host file layer: foreground children via `subagent-artifacts/*_transcript.jsonl`; tail new files | foreground child visible while running |
| M3-T4 | Control: steer and stop via control inbox (file) and via bus (in-process); resume via bus only | buttons enabled exactly when the capability exists |
| M3-T5 | Tab group UI: parent + children, breadcrumb back-stack for nesting, "N running" pill with overview sheet | nested fanout navigable |
| M3-T6 | Workflow view: from `workflowGraph` when present, else from `workflow.trace` + `preflight` lanes with inferred edges marked as inferred | scripted workflow renders with honest uncertainty |
| M3-T7 | Missions view: `~/.pi/agent/missions` ledger, runs, workflow children, decisions, artifacts | user's existing 63 missions render |
| M3-T8 | Acceptance and watchdog status per child | ledger status chips per step |
| M3-T9 | Upstream: PRs for `workflowGraph` in scripted workflows, exported steer/interrupt, foreground index, `custom()` guards | PR URLs recorded in `docs/upstream.md` |

---

## M4 · Settings and logs

Goal: every Pi setting editable from the UI at global and project scope; packages
installable; providers and models manageable; a realtime low-level logs page.

Done when: changing a setting in the UI is visible to a running session after
reload; installing a package works with progress; the logs page shows each
provider round-trip with full request payload, status, headers, latency, cost,
and is searchable across sessions.

Depends on: M1.

| ID | Task | Done when |
| --- | --- | --- |
| M4-T1 | Settings adapter over `SettingsManager`: read merged, write scoped, reload live session | round-trip test on every top-level key of the pinned Pi (51 on 0.85.0; the count is pinned by a test so a bump fails loudly) |
| M4-T2 | Settings UI: schema-driven forms for every key, global vs project tabs, diff view of effective settings | no setting missing versus `docs/settings.md` of the pinned Pi |
| M4-T3 | Package manager UI over `DefaultPackageManager`: install, remove, update, progress, update check | pi-web-access install from UI succeeds |
| M4-T4 | Providers and models: auth status, login flows Pi supports headlessly, enabled models, thinking levels per model | model picker matches Pi's |
| M4-T5 | Log store: SQLite in host; capture `before_provider_request`, `after_provider_response`, assembled assistant message, tool events, session events | round-trips persist with cost |
| M4-T6 | Logs page: tabs per section (provider, tools, session, subagents, host); paged views with byte budgets; copy buttons; search | copy of a full request payload works |
| M4-T7 | Keybindings and trust store views (read, edit where Pi allows) | files edited through Pi's own managers only |
| M4-T8 | "All settings" written for a person, not for `settings.json`: no raw Pi key names on screen, categories named for what they do, free-text provider/model fields replaced by the pickers that already exist, and the tab hidden behind an "Advanced" disclosure | a reader who has never seen Pi can tell what each row changes without leaving the screen; no key name appears as a label |

---

## M5 · Desktop shell

Goal: an installable Electron app that bundles the host, the UI, and a pinned
Node runtime, with tray, notifications, keychain, and updates.

Done when: a signed build installs on macOS and Linux, runs the host with a
bundled Node outside asar, opens the UI, and updates itself.

Depends on: M1.

| ID | Task | Done when |
| --- | --- | --- |
| M5-T1 | Electron main: window, single instance, tray, deep links | app opens the UI from the local host |
| M5-T2 | Bundled runtime: stock Node (or Pi's Bun binary) unpacked outside asar; host spawned from it; `process.execPath` stays a real node for children | MCP stdio child process spawns from a session |
| M5-T3 | Keychain via `@napi-rs/keyring` for root identity key and relay tokens | key survives restart, never on disk in plain text |
| M5-T4 | Native notifications and mic permission flow (macOS TCC) | permission prompt once |
| M5-T5 | Packaging and signing (macOS notarization, Windows Azure Artifact Signing, Linux AppImage) and auto-update | update from version A to B verified |

---

## M6 · Relay and pairing

Goal: a phone reaches the desktop through a Railway-hosted relay that cannot read
the traffic; pairing by QR; device list with revocation.

Done when: a browser on another network pairs by QR, shows the same UI, answers a
dialog, and is revoked from the desktop; the relay process links no crypto
library; a tampered frame is rejected.

Depends on: M1, `@lasercode/crypto`.

| ID | Task | Done when |
| --- | --- | --- |
| M6-T1 | `@lasercode/crypto`: Noise IK and KK over `25519_AESGCM_SHA256` using WebCrypto (non-extractable keys) with `@noble` fallback; prologue = channel id; AAD = channel ‖ direction ‖ seq; rekey | test vectors pass in Node and browser |
| M6-T2 | Pairing: ephemeral key in QR URL fragment, explicit "Link a device" screen, SAS display, channel id = HKDF(shared, "relay_token") | photographed QR after use is useless (test) |
| M6-T3 | Device list: desktop root key signs versioned list; revoke = re-sign; phone verifies | revoked device cannot reconnect |
| M6-T4 | `@lasercode/relay`: WebSocket byte forwarder, exactly two sockets per channel, per-IP creation limits, cookies under load, padded buckets, no deflate, 20 s ping | Railway deploy config; load test |
| M6-T5 | Host relay client: outbound only, reconnect, resume from seq | desktop sleep/wake recovers |
| M6-T6 | Keystroke timing defense: 20 ms send grid plus chaff tail on the phone client | traffic capture shows fixed cadence |
| M6-T7 | Threat model document and residual-metadata list | `docs/security.md` |

---

## M7 · Mobile PWA

Goal: the same bundle feels native on a phone: install to home screen, safe areas,
keyboard handling, reconnect on wake, push where the platform allows.

Done when: on iOS and Android, an installed PWA survives lock/unlock with no lost
output, the composer stays above the keyboard, approvals are answerable with one
hand, and (Android) a push opens the pending approval.

Depends on: M6.

| ID | Task | Done when |
| --- | --- | --- |
| M7-T1 | Manifest, icons, service worker (app shell only), secure-context served through relay | installable on both platforms |
| M7-T2 | Layout: safe areas, `visualViewport`-driven keyboard inset (`max()`, not `+`), fixed composer, no body scroll | iOS 26 installed-PWA keyboard bugs worked around |
| M7-T3 | Reconnect on `visibilitychange`, do not trust `onclose`, resume from seq | lock/unlock test |
| M7-T4 | Approval UI: non-modal footer on the tool card, "No" always opens feedback, broad-allow is mode-changing | one-hand test |
| M7-T5 | Push: Declarative Web Push payload; Android action buttons; iOS single tap-to-open | both platforms verified |
| M7-T6 | Mobile mic for transcription: `getUserMedia` + MediaRecorder to the host | phrase inserted at cursor |
| M7-T7 | QR entry route and encrypted paired-device transport in the browser | scanning a fresh QR on a real phone opens `/link`, completes the six-symbol check, and reconnects to the desktop through the relay |

---

## M8 · Package support

Goal: the community packages the user relies on work inside laser.

Done when: pi-web-access dialogs and widgets render; pi-gpt-transcribe dictates
into the composer on desktop with a native waveform; markdown preview and image
display have native equivalents; the app degrades gracefully when a package is
absent.

Depends on: M1 (M3 for subagents).

| ID | Task | Done when |
| --- | --- | --- |
| M8-T1 | Capability detection: the companion extension reports active modules per session (`laser/capabilities`); UI feature flags follow it | absent package hides its UI |
| M8-T2 | `transcribe` module + desktop path for pi-gpt-transcribe: `WidgetState` as contract, native waveform, hotkey routing, awaitable pre-send transform, non-tui entry point (upstream PR) | dictation works in desktop composer |
| M8-T3 | Native markdown preview and image display replacing TUI-only packages | preview pane for any markdown file |
| M8-T4 | `web-access` module: detection and native rendering of pi-web-access widgets | search results widget renders |
| M8-T5 | Module authoring guide for future packages (`docs/pi-extension-modules.md`) | a new module can be added from the guide alone |

---

## M9 · CLI

Goal: `laser` is the way a developer starts, inspects, and drives the product
from a terminal, and the way they reach Pi without leaving laser's world.

Done when: `laser` with no arguments starts the host and opens the app;
`laser pi --help` reaches the pinned Pi; `laser sessions` and
`laser send` work against a running host; `laser doctor` explains a broken
setup; every command has `--json`.

Depends on: M1 (host), M2 (projects), M4 (settings) for the richer subcommands.

| ID | Task | Done when |
| --- | --- | --- |
| M9-T1 | `packages/cli` package, `laser` bin, subcommand router, `--json` everywhere, `--help` per command, colored output that degrades when not a TTY | `laser --help` lists every command |
| M9-T2 | `laser` / `laser up`: start the host (or attach to a running one), print the URL, open the browser unless `--no-open`; `--port`, `--agent-dir`, `--session-dir`; `laser down`, `laser status` | starting twice attaches instead of failing |
| M9-T3 | `laser pi [...]`: pass through to the PINNED Pi with laser's env (`PI_CODING_AGENT_DIR`, `PI_SUBAGENTS_TEMP_ROOT`), inheriting stdio and the exit code; `laser pi update --extensions` and other Pi verbs work unchanged; `--global-pi` opts into the user's own install | `laser pi --help` prints Pi's help; exit codes propagate |
| M9-T4 | Session commands against a running host over the protocol: `sessions [--project P]`, `open <id>`, `new [cwd]`, `send <text> [--session S] [--steer\|--follow-up]`, `tail <id>` (stream updates), `stop <id>`, `fork <id> <entry>`, `rename`, `compact` | `laser tail` streams a live run |
| M9-T5 | `laser projects` add/remove/list; `laser packages` list/install/remove/update through the worker's package manager; `laser settings get\|set\|list` (global and project scope) | installing a package from the CLI shows up in the app |
| M9-T6 | `laser doctor`: Node version, pinned Pi resolvable, agent dir, auth per provider, model resolvable, worker spawn smoke test, port availability, pi-subagents temp roots, disk for sessions. Exit non-zero on a real problem | a broken setup prints the fix |
| M9-T7 | `laser relay login\|pair\|devices\|revoke` (M6) and `laser logs [--follow] [--section provider\|tools\|session]` (M4) | pairing from the CLI produces a QR |
| M9-T8 | Shell completions (`laser completions bash\|zsh\|fish`) and a man-style `laser help <topic>` | completions install cleanly |

---

## MP · Panel system

The rendering system every other milestone draws through
([`docs/ux-panels.md`](docs/ux-panels.md), D-18). Added after M0–M9 were
written, because the contract that replaced per-package views is a milestone
of its own and M3, M4's logs page and M8's previews all land on it (D-27).

| ID | Task | Done when |
| --- | --- | --- |
| MP-T1 | Payload types, the bus protocol and the `pi/panel/*` wire in `@lasercode/protocol`, with schemas that refuse presentation keys anywhere in `data` | a panel with a `className` is rejected by name |
| MP-T2 | Companion `panels` module: validate, dedupe identical re-emits, forward, replay actions | an extension that emits `laser:panel` reaches the dock unchanged |
| MP-T3 | Host panel hub: memory per session, ref grants, ranged reads, attention from a blocking decision | a ref no panel carried is refused |
| MP-T4 | The island: one element, four sizes, the morph between them, a body per kind | third expansion shrinks the least recently watched to minimal |
| MP-T5 | The dock: columns, dividers, maximize, pop out, dismiss, the `+N` overflow | a wide monitor gets four expanded panels, none of them narrow |
| MP-T6 | Placement table, ambient line, phone islands, decision surfaces | the table is the test |
| MP-T7 | Fallback so nothing regresses: `setWidget` → stream, `setStatus` → ambient, dialogs → decision | an unaware extension looks first-class |
| MP-T8 | The two surfaces the placement table names but nothing rendered: `inline` panels as cards at the transcript tail, and `inspect` as a sheet on any width | every cell of the placement table draws something |

---

## M10 · Self-contained distribution

Goal: a person installs laser with one command and never touches a terminal
again. They do not install Node, or Pi, or anything else, and they need not
know Pi exists.

Done when: on a clean Linux machine with curl or wget and `gh` present, one command
installs a native desktop app that appears in the application menu, launches,
runs an agent, and installs extensions from Settings — with no Node, no npm,
no Pi and no manual step anywhere.

Updating is deliberately staged. T1–T8 ship an app that installs and runs;
T10 turns the in-app updater on once the repo can serve a feed an installed
app may read, and T9 adds the system's own updater after that. Until T10 the
app says updates are unavailable and why, which is true (D-31).

**T1–T8 are done.** One more thing has to land before a build is put in front
of anyone else, and it is not in this milestone: **MX-T7**. D-36 records that
the product may be renamed, and `appId`, the `laser://` scheme, the data
directory and every storage key are free to change today and stop being free
the moment someone installs a build. Tag and publish after MX-T7, not before.

Depends on: M5 (desktop shell), M9 (CLI). Blocks nothing; blocked for
*distribution* by MX-T7.

| ID | Task | Done when |
| --- | --- | --- |
| M10-T1 | `install.sh` at the repo root, fetched from the public repository and run from disk. Detects arch, verifies a checksum **and offline GitHub build provenance**, downloads the release asset, installs per-user under `~/.local`, registers a `.desktop` entry and icons, and prints one line saying what to do next. Idempotent; re-running upgrades, and an interrupted upgrade leaves the version that was working | the public versioned command on a clean box ends with a launchable app without GitHub sign-in |
| M10-T2 | One public, versioned command in the README, copy-pasteable and identical to the website. An `--uninstall` flag that removes everything it created, and a separate `--purge` for the data it did not | the command works without repository access or a GitHub account |
| M10-T3 | The app bundles its own runtime and agent: stock Node unpacked outside asar, the pinned Pi and its dependency tree vendored into the package. Nothing resolves from the user's machine, and the user's own global Pi (if any) is never touched | `doctor` inside the packaged app reports the bundled Node and the bundled pinned Pi, on a machine with neither installed |
| M10-T4 | Package for every Linux distribution: AppImage (universal), `.deb`, `.rpm`, and a plain tarball. Desktop entry, MIME handler for `laser://`, icons at every size, and a post-install that does not require root for the AppImage path | each artifact installs and launches on its target |
| M10-T5 | Extension and package management entirely from Settings: browse, install, update, remove, with progress and a readable failure. Installs go into laser's own agent directory, never the user's global one, run on the npm the app ships rather than the machine's, and refuse to run an unreviewed install script | a package is installed from the UI on a machine with no npm on `PATH` |
| M10-T6 | First-run experience inside the app: pick a provider, sign in, pick a model, add a project — all in the UI. No config file, no environment variable, no terminal | a new user reaches a working session without leaving the window |
| M10-T7 | Release pipeline: a tagged build produces every artifact plus a checksum manifest, and the app's updater points at it. Versions pinned end to end — Node, Pi, every workspace package | a release is reproducible from a tag |
| M10-T8 | Product language: the UI never requires knowing Pi exists. "Agent", "model", "extension", "session" — Pi is named only in advanced settings and diagnostics, where it is the truth | a reader of every visible string could not tell which agent runs underneath |
| M10-T9 | The OS-native update channel: a signed APT repository and a dnf `.repo`, dropped by the `.deb` and `.rpm` postinst, so `apt upgrade`, GNOME Software and KDE Discover all offer the update. Needs a signing key and a host | a `.deb` installed from the one-line install is upgraded by the system's own updater, with no terminal |
| M10-T10 | Turn the in-app updater on. It is built and deliberately disabled (D-31) because a private repo cannot serve a feed an installed app can read. When the repo goes public, set `publish` back to the GitHub provider, point the updater at it, and prove an AppImage self-updates in place | a packaged build finds a newer release, downloads it, and restarts into it |

---

## M11 · Theme system

Goal: nothing visual is a constant. Every colour, font, size, radius, shadow
and duration is a token, and the person using the app chooses them.

Done when: `docs/ux-theme.md` is satisfied — no component holds a literal
visual value, Settings → Appearance changes theme, accent, fonts, text size,
density, corners, contrast and motion with a live preview, and the default is
a dark preset good enough that most people never open the panel.

Depends on: M4 (settings surface).

| ID | Task | Done when |
| --- | --- | --- |
| M11-T1 | Three-layer token architecture: primitive scales, semantic tokens, component tokens with fallbacks. Every semantic token defined for both bases | a grep for hex, `oklch(`, `rgb(` and raw `px` font sizes in `packages/ui/src` returns only the primitive scales |
| M11-T2 | `Theme` as data and a runtime applier that writes custom properties on the root. Switching is one style write, no reload, no flash | switching presets is instant and nothing remounts |
| M11-T3 | Preset gallery: several dark and several light, each a live swatch card. Default is a plain dark preset with Inter and JetBrains Mono | presets render as themselves in the picker |
| M11-T4 | Settings → Appearance: theme, accent hue, attention hue, interface font, code font, text size, density, corners, contrast, motion, follow-the-system, and a custom token editor with a contrast readout | every control previews live on the app behind it |
| M11-T5 | Font loading on demand by family, with real fallback stacks and no reflow on swap; the curated interface and code lists from `docs/ux-theme.md`, plus a no-webfont system option | choosing a font loads only that family |
| M11-T6 | Themes persist in settings so they follow the person to the phone through the relay; a fresh install starts on the default | the phone shows the same theme after pairing |
| M11-T7 | Guard rails: the legibility floor holds at every text size, high contrast raises text until it clears its ground, a failing custom token is flagged, and the attention hue can never equal the accent hue | the checks fire in the editor rather than shipping a broken theme |
| M11-T8 | Every adopted assistant-ui element restyled through our tokens, starting with `surfaces` | no element renders on its own defaults |

---

## M12 · 0.2.0 product experience

Goal: Laser's installed desktop experience carries its identity everywhere,
makes provider/model choices unmistakable, and presents a Laser-owned product
surface over a pinned Pi engine: settings are product concepts, community
packages become curated features, and durable session goals have a first-class
Laser experience backed by reusable Pi-native logic.

Done when: the logo and green default accent ship in the app; provider/model
controls are one reusable provider-first searchable component; provider loading
does not flicker; reasoning is readable and its effort control is compact;
JSON is collapsible and highlighted; project and archive actions work; the
desktop add-project flow opens the operating system folder picker; settings and
feature copy do not expose Pi or package-management plumbing; Subagents and
Goals are bundled feature capabilities; a goal survives reload and session
switches without leaking between sessions; and a packaged 0.2.0 build passes
the full verification suite and a manual desktop, phone-width, light and dark
review.

Depends on: M1, M2-T4, M4, M5-T1, M11.

| ID | Task | Done when |
| --- | --- | --- |
| M12-T1 | Product identity and conversation controls: app logo, logo-green default accent, compact reasoning-effort popover, thinking indicator, complete reasoning body | the installed shell is visibly Laser and the composer has no wide effort selector |
| M12-T2 | Provider/model experience: stop provider-loading flicker; provider-first searchable picker shared by the composer and settings; grouped model catalogue with explicit proxy provenance | OpenRouter models read as models sourced through OpenRouter, never as a direct-provider model |
| M12-T3 | Rich diagnostics and focused settings: collapsible syntax-highlighted JSON wherever payloads render; remove the contradictory Tools settings page | large nested payloads can be navigated without leaving the JSON representation |
| M12-T4 | Project and archive management: native desktop folder picker; project overflow actions for remove and archive chats; permanent delete in Archived | every destructive action names its scope and requires deliberate confirmation |
| M12-T5 | Integrate, visually verify, package and publish stable 0.2.0 | full build, typecheck and tests pass; all four visual combinations pass; installed 0.2.0 launches with the correct icon; stable release is Latest |
| M12-T6 | Make curated extension installation self-contained and safe | `pi-subagents@0.65.1` installs from the packaged app with only Laser-reviewed, version-pinned lifecycle scripts allowed; unreviewed scripts produce a useful error instead of an installer command |
| M12-T7 | Add a new Laser brand preset and make its dark/light pair the fresh-install default | the default pair is visibly derived from the logo's `#03CC7B`, `#E9E8E6` and black palette and passes every contrast guard |
| M12-T8 | Remove duplicate web-search panels and complete the RPC UI compatibility surface used by curated extensions | web results render only in their transcript tool disclosure, never migrate between sessions, and pi-subagents can call `setToolsExpanded` without failing |
| M12-T9 | Keep project selection and composer trigger menus predictable | a project rail icon only selects its worker/project, while slash and mention results stay inside a bounded scrollable popover |
| M12-T10 | Make dock geometry follow the number of watched panels | one panel fills the dock, two split into full-width rows, and three or four occupy a stable 2×2 grid without remounting islands |
| M12-T11 | Give context and live thinking states a first-class visual treatment | the context inspector uses meaningful icon-led cards and a clear usage hierarchy, while an empty running reply renders the assistant-ui thinking indicator instead of a bare caret |
| M12-T12 | Turn the telemetry rail into a visual instrument panel | context health, token composition, model identity, file activity and tool activity can be understood at a glance from real session data without duplicate, decorative or invented metrics |
| M12-T13 | Make the Fleet a chronological hierarchy instead of an indented flat sort | every child is rendered inside its actual parent's subtree and siblings retain creation order, so a child can never appear to belong to an adjacent run |
| M12-T14 | Give workflow children one identity across aggregate and child status files | a workflow with three launched children renders as one workflow plus three children, never seven apparent runs with duplicated failures |
| M12-T15 | Define the Laser/Pi product boundary and classify the settings surface | `AGENTS.md` and architecture docs make Pi an internal engine; every engine setting is classified as product, Advanced, internally managed or unsupported |
| M12-T16 | Replace package management with a curated, engine-neutral feature registry | people enable scoped Laser features from manifests with dependencies, capabilities, restart and health; package installation and Pi passthrough are absent from the product |
| M12-T17 | Ship Subagents as a bundled Laser feature | Subagents can be enabled or disabled without installing or seeing a package, while the bridge preserves the upstream lifecycle and persisted run model |
| M12-T18 | Integrate a pinned, reusable Pi-native goal engine behind an engine-neutral goal protocol | `/goal` and UI actions share one session-isolated persisted goal state with start, edit, pause, resume, clear, complete, block and wait semantics |
| M12-T19 | Build the persistent goal row and product language | the current session's goal appears below the panel row with status, progress evidence and controls; no Pi, extension or package terminology reaches the normal product UI |
| M12-T20 | Verify the clean break and all goal/feature states | protocol, `.laser` isolation, loop-safety, reload/switch isolation and product-language tests pass; desktop and phone widths pass in dark and light themes |
| M12-T21 | Make dictation a provider-gated core capability | dictation is bundled and absent from Features; provider readiness is explained in Providers and models and checked before microphone access; natural pauses land as ordered phrases at the live caret while typing remains enabled |
| M12-T22 | Preserve drafts when completing leading slash commands | Tab or pointer selection replaces only a slash token at character zero and keeps every argument or later line unchanged |
| M12-T23 | Make Add Project a native folder-selection action | desktop entry points open the operating system folder chooser directly; no product surface accepts or pastes a directory path |
| M12-T24 | Give every built-in provider a researched, theme-safe brand mark | all 40 built-in provider ids resolve through one maintained icon catalog; regional and plan variants retain their parent brand; known providers never fall back to generated initials |
| M12-T25 | Replace the false empty startup with a branded restoration transition | the shell remains hidden while the remembered project/session, transcript and goal restore; a token-driven Laser beam screen communicates that work in both themes and all widths without delaying a fast launch |
| M12-T26 | Establish the open-core licensing boundary | Laser is AGPL-3.0-only with a commercial license available by agreement; the reusable protocol and Pi-native goal packages are Apache-2.0; trademark scope is explicit |
| M12-T27 | Remove projects whose remaining chats are archived | after every chat in an unpinned project is archived, Remove project hides it immediately and reports the visible state rather than the on-disk transcript count |
| M12-T28 | Persist one drag-reorderable project priority across navigation | project circles support pointer, touch and keyboard reordering; the chosen order survives restart and is identical in the project rail and grouped sessions sidebar |
| M12-T29 | Make dock panel placement directly reorderable | open panel islands can be dragged by a dedicated handle or reordered by keyboard; their slots morph to the chosen order and that order survives a reload of the browser session |
| M12-T30 | Give the conversation a wider, shared reading measure | chat prose, its thread frame, the goal row and prose previews use wider semantic measure tokens without losing the centered responsive layout |
| M12-T31 | Collapse mixed tool activity into one useful parent summary | every adjacent run of tool actions has one compact expandable row with counted action categories, status and duration; while live it uses the thinking indicator to name the exact current action; expansion preserves every existing detailed tool row |
| M12-T32 | Reveal message timestamps on interaction instead of by default | exact message times stay visually quiet until their message row is hovered or keyboard-focused, while coarse-pointer users and assistive technology retain access |
| M12-T33 | Reclaim the space below the composer | the persistent git/key-hint footer is absent from chat and its interaction guidance remains discoverable under a clearly named Help and shortcuts settings tab |
| M12-T34 | Highlight every Shiki-bundled Markdown fence accurately | settled chat code uses Shiki's full TextMate-compatible grammar engine, recognizes official and common model fence labels, and maps broad language scopes to Laser theme tokens |
| M12-T35 | Give native notifications the same session title as the app | desktop banners use an explicit session name or its first user message, never the misleading “Untitled session” placeholder |
| M12-T36 | Separate active and terminal work in the fleet | queued, running, paused or blocked run trees stay in a prominent In progress section; fully settled trees move to a collapsible Finished section without breaking parent-child lineage |
| M12-T37 | Publish the accumulated experience fixes as stable 0.2.2 | every workspace manifest and tag agrees on 0.2.2; CI builds, installs, signs, attests and publishes both Linux architectures; the native package feeds deploy successfully |
| M12-T38 | Fold reasoning into the aggregate activity disclosure | adjacent reasoning and tool work share one muted, live summary row; its collapsed state counts thought and action families, and its expanded state preserves the complete reasoning and tool detail |
| M12-T39 | Publish the activity-disclosure refinement as stable 0.2.3 | every workspace manifest and tag agrees on 0.2.3 and the independent release pipeline publishes both Linux architectures, provenance and updater feeds |
| M12-T40 | Separate API spend from account allowance in session telemetry | API-only sessions retain token/cost charts; account-only sessions show authoritative allowance windows, resets and credit balance; mixed sessions expose both through a compact two-tab control without combining their units |
| M12-T41 | Give each session one three-level activity disclosure preference | the chat menu offers text-only, reasoning, and full-detail modes; every reasoning/tool sequence keeps one aggregate parent while the selected level controls which established inner renderers start open |
| M12-T42 | Open the chat model picker at the session's active choice | opening the picker immediately scopes its provider field to the current routing provider and marks the current model, while closing clears temporary search and filter overrides for the next session |
| M12-T43 | Publish the adaptive-session controls as stable 0.2.4 | every workspace manifest and tag agrees on 0.2.4; CI builds, stages, installs, signs and attests both Linux architectures; GitHub and native package update channels publish successfully |
| M12-T44 | Make the transcript compact without shrinking the app | assistant and user prose use the 14px body scale; message, block and bubble spacing becomes denser; controls, metadata, reading measure, touch targets and the 12px data floor remain unchanged across desktop/phone and dark/light themes |
| M12-T45 | Make activity disclosures reliable and visually uniform | aggregate, reasoning and tool rows toggle independently with consistent muted styling; interaction tests cover manual collapse and live updates; desktop/phone and both themes are inspected |
| M12-T46 | Inspect captured provider requests from messages and logs | a shared large inspector exposes instructions, messages, tools, parameters and full redacted JSON; prompt links are exact for new captures and legacy/unavailable cases are explicit; retries and tool-loop requests are selectable |
| M12-T47 | Publish stable patch 0.2.5 | the verified source is committed and tagged; both architecture installers and signed native update feeds publish with a release page |
| M12-T48 | Prevent stale services from breaking subscription quota refresh | desktop refuses a mismatched background-service version without killing work; quota errors explain recovery; refresh and auth-failure paths are tested through the engine bridge |
| M12-T49 | Restore the complete engine command and skill catalogue | the composer discovers every headless-runnable registered command, prompt template and skill through Pi's loader; Pi-style ordered-character search finds command identity; keyboard or pointer completion changes only the leading slash token and preserves the draft |
| M12-T50 | Refresh the daemon on updates and remember the request transcript view | native package upgrades gracefully reload the packaged daemon and desktop startup replaces any mismatched generation before the UI connects; Instructions and Conversation default to plain text, offer the exact chat Markdown renderer, and persist that machine-wide choice in Laser preferences |
| M12-T51 | Publish stable patch 0.2.6 | every workspace manifest and tag agrees on 0.2.6; the stable release is created with user-facing notes and its tag starts the independent x64/ARM64 artifact, provenance and native-feed workflow |
| M12-T52 | Make live activity follow the executing action | only actively streaming reasoning glows; executing tools illuminate their own row and aggregate with an exact live label; settled and waiting rows stop animating; dark/light, phone/desktop and reduced-motion paths verified |
| M12-T53 | Compact project tree and single-location session attention | rounded single-line session rows nested under quiet folders; persistent chat pins have one canonical row; working sessions have a visible spinner; no duplicated inbox or project attention highlights; responsive themes and keyboard paths verified |
| M12-T54 | Search full conversations and navigate exact matches | Ctrl/Cmd+F opens session find with live count and previous/next; Ctrl/Cmd+Shift+F and the sidebar magnifier search saved history with highlighted in-flow excerpts; older date ranges expand on demand; user messages rank above replies, then reasoning/tools; keyboard, stale responses and responsive themes are verified |
| M12-T55 | Remove transcript day separators | no Today/Yesterday/date divider is rendered between messages; every message keeps its exact timestamp and the transcript spacing remains compact |
| M12-T56 | Search displayed tool content rather than payload structure | session and history search share a documented searchable-content contract; tool field names and hidden metadata do not produce hits; visible values can be revealed and highlighted |
| M12-T57 | Navigate exact matches in captured API requests | inspector section search highlights content in place; full-request search includes all retained JSON keys and values; counts, next/previous and keyboard navigation stay inside the modal |
| M12-T58 | Highlight source code in file tools | read, write and edit bodies infer a supported language from the file path and use the existing token-driven Shiki renderer without losing diff semantics, search targets or plain-text fallback |
| M12-T59 | Repair authenticated subscription allowance retrieval | the verified route succeeds with existing credentials; failures explain correct recovery; quota buckets retain identities, durations and resets; endpoint-specific tests and an authenticated smoke check pass |
| M12-T60 | Release stable 0.2.7 | verified quota repair, accumulated search improvements and user-supplied highlighting are committed; version/tag agree; tag and release dispatched without waiting for Actions |
| M12-T61 | Explain and group account allowances | compact documented allowances in chat; Settings → Usage retains every dynamic window and credits; related windows share a heading; saved reset display switches between time remaining and exact local date/time; accessible help uses documented meanings and honest unknown-bucket fallback |
| M12-T62 | Complete the composer suggestion experience | commands and mentions have ranked project-wide search, readable results, visible keyboard selection, pointer/touch selection, outside/focus/Escape dismissal, accessible states and viewport-safe layout; skill/prompt source files open separately through the desktop OS association with a browser copy-path fallback; completion preserves drafts and sending behavior; interaction tests and desktop/phone both-theme review pass |
| M12-T63 | Release stable 0.2.8 | allowance presentation and user-supplied composer picker changes pass the staged workspace gate; matching source commit and version tag are pushed and stable release page created without waiting for Actions |
| M12-T64 | Built-in web search and provider consent | exact-pinned search engine exposes all supported search providers through Settings, independent feature enablement and explicit shared-credential permission; isolated execution, protocol/router tests, and responsive UI verification pass |
| M12-T65 | Withdraw native reminders after viewing a session | viewed sessions dismiss only their own OS notifications; pending approvals remain pending; desktop lifecycle and real Linux withdrawal are verified |
| M12-T66 | Release stable 0.2.9 | built-in web search and session notification dismissal pass staged verification and packaged checks; clean source CI precedes the tag; both architecture installers and signed native feeds publish |
| M12-T67 | Persistent goal history without duplicate accounting | goals have no budget or usage accounting; exact objectives and lifecycle outcomes render as durable collapsible chat records without internal prompts; completion keeps its existing engine semantics; replay, live updates and responsive disclosure tests pass |
| M12-T68 | Repair search selection and provider failures | configuring and choosing search connections is unambiguous; DuckDuckGo empty/challenge responses are distinguished; OpenAI API and Codex routes have regression coverage and bounded live verification; errors identify the selected provider without exposing credentials |
| M12-T69 | Keep native notifications and desktop updates coherent | session reminders are withdrawn on acknowledgement and orderly exit; native package updates offer a full desktop restart, not just a daemon refresh; Linux protocol and lifecycle regressions are verified |
| M12-T70 | Release stable 0.2.10 | goal history, search repairs and native lifecycle fixes pass staged verification and package checks; source, version tag and release are published |
| M12-T71 | Preview link destinations and expose provider connection progress | hovered and keyboard-focused links show a non-interactive bottom-left destination; sign-in and search tests expose truthful local busy states through completion/failure; desktop/phone and both themes verified |
| M12-T72 | Reuse an unstarted session when choosing New session | all UI entry points reuse an unarchived empty session in the same project, preserve its draft and settings, coalesce repeated clicks, and create a fresh session after work starts |
| M12-T73 | Release stable 0.2.11 | empty-session reuse, destination previews and provider progress pass staged release checks; source, tag and release page are published without monitoring release artifact jobs |
| M12-T74 | Record and display instruction provenance | request captures retain the loaded instruction sources and observed extension changes; the request inspector highlights their exact retained ranges with the adapted confidence-marker element, preserves Markdown and search, and explicitly identifies captures without recorded sources |
| M12-T75 | Release stable 0.2.12 | instruction provenance passes release verification; matching source and tag are pushed and the stable release page is created without monitoring artifact jobs |
| M12-T76 | Publish releases only after downloads are complete | releases remain drafts through upload and asset verification; failures cannot expose an empty or partial release; regression tests guard publication order |
| M12-T77 | Make instruction sources navigable and file links native | searchable source inventory scrolls inside the request dialog; source details follow the pointer without native tooltip duplication; source paths and Markdown file links open safely in the OS editor rather than browser routes |
| M12-T78 | Release stable 0.2.13 | verified source navigation fixes and matching workspace version are committed and pushed; clean source CI precedes the immutable release tag; artifact publication is dispatched without monitoring |

---

## M13 · Agents Leap

Goal: agents are first-class in Laser. A person creates reusable agent
definitions on an Agents page; any session can start other agents through one
`start_agent` tool; every child is an isolated-worktree sub-session the person
can chat with; a live React Flow map shows each top-level session's agent tree
in real time; long commands run as background tasks; Beam, Chat and Namer are
built-in agents with their own product integrations. Binding references:
`docs/agents-leap/references/original-request.md` and
`docs/agents-leap/references/agent-harness-architecture.md`.

Done when: an agent created in the Agents page is startable from a session
through `start_agent`; the child runs in `.worktrees/`, appears under its parent
in the sessions sidebar, accepts user messages, ends through
`complete_agent_run` and its parent is told; the live map shows the tree with
status and transient events at every width; a person can end a child with a
reason that reaches the parent; Beam opens from the one spark button; the Chat
tab holds projectless chats; Namer names sessions and running tools; the
packaged build passes the clean-machine gate with the harness bundled.

Depends on: M12.

| ID | Task | Done when |
| --- | --- | --- |
| M13-T1 | Protocol: agent definitions, policy, runs, events, session agent attribution, `agents/*` methods and notifications, Namer and Beam state | every method has a schema, a round-trip sample and a router owner |
| M13-T2 | Host: durable agent store with validation and periodic scoped-skill checks, run registry, child-session routing to the project worker, catalog attribution of agent sessions, built-in workspaces, first-provider Beam/Namer prompts | agents survive a host restart; a child session routes to its project's worker; warnings name the agent and field |
| M13-T3 | Worker harness: per-agent session configuration, `start_agent` lifecycle (start, message/interrupt, list, wait, stop, completion, failure, cancellation, timeout), mandatory `.worktrees/` isolation and ownership, nesting and model-access enforcement, goal and role context, Namer service, Beam skill | a stub-provider child completes through `complete_agent_run` and its parent receives one structured event |
| M13-T4 | Companion extension: `subagents` harness tools with the compact catalog, child role injection, parent delivery at a safe boundary; `background-work` bash override with explicit background execution and timeout promotion, task tools and run panels; retire the pi-subagents bridge | tools register per role; a promoted command keeps its output and exit state |
| M13-T5 | UI: agents store and client; Agents page with create, edit, select, validate, delete, default toggle, built-in cards, policy, warning deep links | every form state, warning and error is designed; keyboard complete |
| M13-T6 | UI: sub-sessions in the sidebar, Chat and Code tabs, Beam group mark, end-agent modal with optional reason, transcript projections for final messages, agent events and Namer labels | a child is reachable from the sidebar and the parent's card; ending it records the reason |
| M13-T7 | UI: React Flow live map per top-level session with ancestry, status, ended-agent toggle, transient event bubbles, chat navigation; purpose-built layouts for constrained panel, full sidebar, fullscreen, desktop and phone | read-only map at every width in both themes with reduced-motion parity |
| M13-T8 | UI: Beam spark and bubble with the normal chat, empty-state hint, first-message session creation, Beam model choice dialog; projectless Chat area | one entry point, one bubble, both widths |
| M13-T9 | Packaging and runtime: remove pi-subagents bundling, packaged session check exercises the harness, clean-machine gate, docs and element inventory | `clean-machine.mjs` passes with the harness tools and Beam skill present |
| M13-T10 | Integration verification: host and worker end-to-end delegation with a stub provider, sandbox scene, desktop and phone review in both themes with pointer and keyboard, full verify gate | evidence recorded per scenario in the ledger |
| M13-T11 | Remove the retired pi-subagents file layer, its CLI commands and documents once nothing reads them | no `packages/host/src/subagents` observation code remains |
| M13-T12 | Keep `.laser` project overrides through engine resource reloads: `resourceLoader.reload()` re-reads settings and drops `applyOverrides` values during service creation, so project settings and the blanked resource lists may not reach the engine | a real-engine test proves a `.laser/settings.json` value is in effect after session open and after a resource reload |
| M13-T13 | Put the Beam and Chat workspaces under the state directory the host owns, create one before starting its worker, and recreate a missing workspace when a stored Beam or Chat session is opened | a Beam chat opens after its workspace folder is deleted, and a workspace that cannot be created refuses the session with the reason |
| M13-T14 | Make Settings > This device > Run setup again start setup immediately instead of promising a later run the app never reached | pressing it replaces the window with the first step, leaves the open session in the sidebar, and works again on a second press |
| M13-T15 | Add the sidebar way into Beam, make maximize start a chat when the bubble is empty, and give every mounted composer a working microphone | the Beam group starts a chat in the window, maximize is never dead, and dictation lands in the composer it was spoken into |
| M13-T16 | Take tools out of the agent definition so every agent has every tool, and remove the run timeout so an agent may work without limit | no definition carries tools or a timeout, a run advanced 90 days is still running, and a project with a live run keeps its worker |
| M13-T17 | Offer only connected providers wherever a model is chosen to use, from one shared rule, while the catalogue surfaces keep the full list | the composer, Agents, Beam, Settings defaults and onboarding all list connected providers only |
| M13-T18 | Attach the goal engine's tools only while a goal is in play, instead of to every session with Goals on | a request carries them on a goal turn and not otherwise, proven against the real engine |
| M13-T19 | Stop the blank agent form opening on a contradictory state that the host refuses | a new agent that starts nothing saves without the delegation toggle being touched |
| M13-T20 | Put the caret in the model search whenever a model picker opens, everywhere in the app | opening a picker focuses its search and the first keystroke filters |

---
| M13-T66 | Release stable 0.3.0 | the Agents Leap — Laser's own harness, the fleet, Beam and Chat, the map, worktrees per child, one `inspect_fleet`, a Chat session that moves to a project — passes the staged workspace gate, the publication checks and the installer checks; source is on main, clean CI precedes the immutable tag; publication and Latest promotion are the pipeline's |
| M13-T67 | Let people edit every built-in agent's system instructions and model | Beam, Chat and Namer expose durable instruction and model controls on the Agents page; restoring instructions returns to the shipped prompt; the effective instructions reach sessions and Namer requests |
| M13-T68 | Give Telemetry its own recognizable toggle icon | the top bar and command palette use the same activity mark as the Telemetry surface, while panel-edge icons remain reserved for collapsing sidebars |
| M13-T69 | Make the engine-backed default agent identify as Laser | the default instructions shown in Agents and used on every request identify the assistant as operating inside Laser, without copying or freezing the pinned engine's prompt |
| M13-T70 | Make same-definition child agents explicit in the editor | every reusable agent can visibly allow another instance of itself; unchecking it leaves the option present; the existing recursive harness behavior remains covered |
| M13-T71 | Let people rename custom agents without breaking references | an existing custom agent's name is editable; duplicate, built-in and historical-alias names are refused inline; default selection, delegation references and existing session lookup follow the rename atomically |
| M13-T72 | Give the default agent a Laser-owned neutral system prompt | the displayed and live default instructions contain Laser's identity, actual tool descriptions and generic operating guidance, with no engine brand, documentation or bundled implementation paths |
| M13-T73 | Make skills discovery-only | Laser writes and bundles no skill; user and project skill folders remain discoverable and selectable, while Beam's product guidance lives in its built-in agent instructions |
| M13-T74 | Make the Beam spark start fresh every time | every press of the Beam spark opens the bubble on a new empty Beam conversation; any previous Beam session keeps running if needed and remains normally reachable in the Beam sidebar group |
| M13-T75 | Release stable 0.3.1 | the agent customization, Laser-owned prompt, discovery-only skills and fresh Beam launcher pass the staged release gate; source and matching tag are pushed only after clean CI; the release pipeline publishes verified x64/ARM64 assets, provenance and updater feeds |

## MX · Cross-cutting (runs alongside every milestone)

| ID | Task | Done when |
| --- | --- | --- |
| MX-T1 | Migration readiness: `ChordDriver` seam test stays green; watch pi releases for `pi-server` becoming real; record each Pi release's breaking changes in `docs/pi-releases.md` | entry per Pi release |
| MX-T2 | Pi pin bumps: each bump is a task with a driver diff and test run | pin matches a tested release |
| MX-T3 | Upstream log: every PR/issue with URL and status | `docs/upstream.md` current |
| MX-T4 | Security review before M6 ships: relay, pairing, output escaping | findings closed |
| MX-T5 | Accessibility pass: keyboard, focus, reduced motion, contrast in both themes | checklist in `docs/a11y.md` |
| MX-T6 | Element inventory reconciliation: walk `docs/ux-elements.md` row by row against what wave 2 built, install the catalog element where one exists and hand-rolled code is standing in its place, and record every deliberate divergence in the row | every claimed row names a file, or says why it was written instead |
| MX-T7 | **One place defines the product's identity.** `PRODUCT_NAME`, `APP_ID`, the URL scheme, the env-var prefix, the config and state directory names, the storage-key prefix and the cross-package `Symbol.for` keys all derive from a single module; `electron-builder.yml`, the desktop entry, the AppStream id, the web manifest and the installer are generated from it, never hand-written. Renaming the product is one edit plus a data migration, not a sweep | changing the one value renames the product end to end, and a build proves it: the app launches, deep links resolve, and an existing install's settings and sessions are found under the old directory and moved |
