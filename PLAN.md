# PLAN.md — piorbit

Dependency-ordered plan. No dates, no estimates. A milestone is a set of tasks
with a "done when" that can be checked. Task IDs are permanent. Status lives in
`STATUS.md` (summary) and `STATUS_DETAILED.md` (ledger). Read `AGENTS.md` first.

## What piorbit is

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
- Herdr is out; piorbit tab groups replace project panes.
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
docs/                     architecture, research findings, upstream log
```

## Milestone map

```
M0 Foundation
 └─ M1 Local loop (one project, one session, dialogs, transcript)
     ├─ M2 Many sessions, many projects
     │    └─ M3 Subagent tabs
     ├─ M4 Settings and logs
     ├─ M5 Desktop shell
     ├─ M6 Relay and pairing
     │    └─ M7 Mobile PWA
     └─ M8 Package support (transcribe, web-access, native replacements)
MX Cross-cutting (migration readiness, upstream, security) — runs alongside
```

---

## M0 · Foundation

Goal: the repo, the protocol, and the driver seam exist and are exercised by tests.

Done when: `pnpm -r build && pnpm -r test` passes; a worker can open a pinned Pi
session in a temp directory, send one prompt to a fake model, and stream events
as protocol messages to a test client; `ChordDriver` compiles against the same
interface and its seam test proves no Pi type leaks through `@piorbit/protocol`.

Depends on: nothing.

| ID | Task | Done when |
| --- | --- | --- |
| M0-T1 | Workspace scaffold (pnpm, TS strict, ESM, per-package build/test) | `pnpm install && pnpm -r build` passes on a clean clone |
| M0-T2 | `@piorbit/protocol`: message schemas (ACP core + `pi/*` extras), JSON-RPC envelope, sequence numbers, runtime validation | schema tests pass; a message round-trips through encode/validate/decode |
| M0-T3 | `SessionDriver` interface and `DriverEvent` union | interface reviewed against Pi SDK 0.85 events; documented in `docs/architecture.md` |
| M0-T4 | `StableSdkDriver` opens a session via `createAgentSessionRuntime` with pinned Pi, maps events to protocol messages | test: prompt against a stub provider yields `session/update` messages in order |
| M0-T5 | `ChordDriver` stub + seam test | compiles; test asserts the driver module graph does not import Pi types into protocol |
| M0-T6 | Worker process entry: stdio or socket JSON-RPC transport, one worker = one cwd | test client spawns a worker, opens a session, receives events |
| M0-T7 | Extension UI bridge: `ExtensionUIContext` implementation emitting `pi/ui/request` and resolving on `pi/ui/response`; unsupported methods cancel safely | test: `select`, `confirm`, `input`, `editor` round-trip; `custom()` resolves `undefined` without hanging |
| M0-T8 | CI: build + test on push | workflow file exists and passes |

---

## M1 · Local loop

Goal: a person can use piorbit in a browser tab for one project: see the
transcript stream, send prompts, steer, abort, answer extension dialogs, switch
model and thinking level, and resume a past session.

Done when: with pi-web-access installed, a `ctx.ui.select` raised by an extension
is answered from the UI; a full prompt/tool/response cycle renders with streaming
markdown; reload of the tab reattaches to the running session with no lost output.

Depends on: M0.

| ID | Task | Done when |
| --- | --- | --- |
| M1-T1 | `@piorbit/host`: spawn and supervise one worker, route JSON-RPC, expose local WebSocket on 127.0.0.1 | UI connects and lists sessions |
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

---

## M3 · Subagent tabs

Goal: pi-subagents children shown as tab groups under their parent session,
interactive (steer, stop, resume where allowed), with workflow, mission, and
acceptance views. Works for sessions piorbit started and for sessions started
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
| M4-T1 | Settings adapter over `SettingsManager`: read merged, write scoped, reload live session | round-trip test on all 52 top-level keys |
| M4-T2 | Settings UI: schema-driven forms for every key, global vs project tabs, diff view of effective settings | no setting missing versus `docs/settings.md` of the pinned Pi |
| M4-T3 | Package manager UI over `DefaultPackageManager`: install, remove, update, progress, update check | pi-web-access install from UI succeeds |
| M4-T4 | Providers and models: auth status, login flows Pi supports headlessly, enabled models, thinking levels per model | model picker matches Pi's |
| M4-T5 | Log store: SQLite in host; capture `before_provider_request`, `after_provider_response`, assembled assistant message, tool events, session events | round-trips persist with cost |
| M4-T6 | Logs page: tabs per section (provider, tools, session, subagents, host); paged views with byte budgets; copy buttons; search | copy of a full request payload works |
| M4-T7 | Keybindings and trust store views (read, edit where Pi allows) | files edited through Pi's own managers only |

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

Depends on: M1, `@piorbit/crypto`.

| ID | Task | Done when |
| --- | --- | --- |
| M6-T1 | `@piorbit/crypto`: Noise IK and KK over `25519_AESGCM_SHA256` using WebCrypto (non-extractable keys) with `@noble` fallback; prologue = channel id; AAD = channel ‖ direction ‖ seq; rekey | test vectors pass in Node and browser |
| M6-T2 | Pairing: ephemeral key in QR URL fragment, explicit "Link a device" screen, SAS display, channel id = HKDF(shared, "relay_token") | photographed QR after use is useless (test) |
| M6-T3 | Device list: desktop root key signs versioned list; revoke = re-sign; phone verifies | revoked device cannot reconnect |
| M6-T4 | `@piorbit/relay`: WebSocket byte forwarder, exactly two sockets per channel, per-IP creation limits, cookies under load, padded buckets, no deflate, 20 s ping | Railway deploy config; load test |
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

---

## M8 · Package support

Goal: the community packages the user relies on work inside piorbit.

Done when: pi-web-access dialogs and widgets render; pi-gpt-transcribe dictates
into the composer on desktop with a native waveform; markdown preview and image
display have native equivalents; the app degrades gracefully when a package is
absent.

Depends on: M1 (M3 for subagents).

| ID | Task | Done when |
| --- | --- | --- |
| M8-T1 | Capability detection: the companion extension reports active modules per session (`piorbit/capabilities`); UI feature flags follow it | absent package hides its UI |
| M8-T2 | `transcribe` module + desktop path for pi-gpt-transcribe: `WidgetState` as contract, native waveform, hotkey routing, awaitable pre-send transform, non-tui entry point (upstream PR) | dictation works in desktop composer |
| M8-T3 | Native markdown preview and image display replacing TUI-only packages | preview pane for any markdown file |
| M8-T4 | `web-access` module: detection and native rendering of pi-web-access widgets | search results widget renders |
| M8-T5 | Module authoring guide for future packages (`docs/pi-extension-modules.md`) | a new module can be added from the guide alone |

---

## MX · Cross-cutting (runs alongside every milestone)

| ID | Task | Done when |
| --- | --- | --- |
| MX-T1 | Migration readiness: `ChordDriver` seam test stays green; watch pi releases for `pi-server` becoming real; record each Pi release's breaking changes in `docs/pi-releases.md` | entry per Pi release |
| MX-T2 | Pi pin bumps: each bump is a task with a driver diff and test run | pin matches a tested release |
| MX-T3 | Upstream log: every PR/issue with URL and status | `docs/upstream.md` current |
| MX-T4 | Security review before M6 ships: relay, pairing, output escaping | findings closed |
| MX-T5 | Accessibility pass: keyboard, focus, reduced motion, contrast in both themes | checklist in `docs/a11y.md` |
