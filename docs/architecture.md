# Architecture

## Layers

```
┌─ packages/ui ──────────────────────────────────────────────┐
│  One web bundle: Electron renderer, browser tab, PWA.      │
│  Speaks @lasercode/protocol over WebSocket (local or relay). │
└───────────────▲────────────────────────────────────────────┘
                │ protocol (JSON-RPC, seq-numbered updates)
┌───────────────┴────────────────────────────────────────────┐
│  packages/host — supervisor (imports no Pi)                 │
│  worker pool (1 per cwd) · session catalog · local WS      │
│  pi-subagents file layer (any session, incl. terminal)     │
│  relay client (outbound only) · log store (SQLite)         │
└───────────────▲────────────────────────────────────────────┘
                │ protocol over stdio/socket, one worker per project
┌───────────────┴────────────────────────────────────────────┐
│  packages/worker — imports Pi (with pi-extension)           │
│  SessionDriver ──┬── StableSdkDriver (pinned Pi SDK)        │
│                  └── ChordDriver (stub, seam test)          │
│  ui-bridge (ExtensionUIContext → pi/ui/*)                   │
│  settings + package adapters                                │
│  loads packages/pi-extension into the session:              │
│    one extension, modules/{provider-log,subagents,          │
│    transcribe,web-access,...} activated by detection        │
└─────────────────────────────────────────────────────────────┘

packages/relay  ← dumb byte forwarder on Railway, 2 sockets per channel
packages/crypto ← Noise IK/KK, pairing, device list (Node + browser)
packages/desktop ← Electron main: tray, keychain, updater, bundled Node
```

## The driver seam

`SessionDriver` (`packages/worker/src/driver.ts`) is the migration boundary.
Everything above it sees only `@lasercode/protocol` types. The seam test (M0-T5)
asserts that the protocol package's module graph contains no `@earendil-works/*`
import and that both drivers satisfy the interface.

Mapping to Pi's stable SDK (0.85):

| Driver method | Pi SDK |
| --- | --- |
| `open({ cwd, sessionPath? })` | `createAgentSessionRuntime(factory, { cwd, agentDir, sessionManager })` |
| `prompt(text, images?)` | `session.prompt()` |
| `steer` / `followUp` | `session.steer()` / `session.followUp()` |
| `abort` | `session.abort()` |
| `setModel`, `setThinkingLevel` | same names |
| `compact` | `session.compact()` |
| `navigateTree` | `session.navigateTree()` |
| `fork`, `newSession`, `switchSession` | on `AgentSessionRuntime` |
| `events()` | `session.subscribe()` → `AgentSessionEvent`. Transcript state comes from `message_*`/`tool_execution_*`; `entry_appended` fires only for extension custom entries (verified 0.85.0) |
| dialogs | `session.bindExtensions({ mode: "rpc", uiContext })` |

Mapping to the experimental Chord services, for when `ChordDriver` becomes real:
`pi.agent-controller` (prompt, requestAbort, steer, followUp, compact, navigate),
`pi.transcript` replicated state, `pi.session-management` (create, attach,
detach), `pi.models`. Dialogs would move to keyed dialog services.

## The companion extension

`packages/pi-extension` is one Pi extension, passed by the worker as an inline
extension factory (`createPiorbitExtension({ send })`). At `session_start` it
runs each module's `detect()` and activates the ones whose package is present,
then reports `piorbit/capabilities` to the worker. Modules:

| Module | Bridges | Detection |
| --- | --- | --- |
| `provider-log` | Pi's `before_provider_request` / `after_provider_response` hooks | always |
| `subagents` | pi-subagents in-process registries and `subagents:rpc:v1` bus | `globalThis[Symbol.for("pi-subagents.*")]` |
| `transcribe` | pi-gpt-transcribe desktop dictation | todo |
| `web-access` | pi-web-access widgets | todo |

Adding support for a package = adding a module. Modules never import each other
and fail individually. File-based observation is not here; it is in the host.

## Protocol shape

ACP-inspired JSON-RPC:

- Requests (client → host): `session/new`, `session/load`, `session/prompt`,
  `session/cancel`, `session/set_mode`, plus `pi/*` extras such as
  `pi/session/steer`, `pi/session/follow_up`, `pi/session/fork`,
  `pi/model/set`, `pi/thinking/set`, `pi/compact`, `pi/settings/*`,
  `pi/packages/*`, `pi/subagents/*`, `pi/logs/*`.
- Notifications (host → client): `session/update` with a monotonically
  increasing `seq` per session; clients resume with `session/load { fromSeq }`.
- Requests (host → client): `session/request_permission` and `pi/ui/request`
  (select, confirm, input, editor). Fire-and-forget: `pi/ui/notify`,
  `pi/ui/status`, `pi/ui/widget`, `pi/ui/title`, `pi/ui/editor_text`.

## Process model

- Host: one long-lived process (inside Electron main in the desktop build, or
  standalone).
- Worker: one process per project directory, spawned from a bundled stock Node
  binary, with a pinned Pi. Retired when idle and no presentation is attached and
  no background subagent run references the session.
- Never two workers for one cwd. Never two writers on one Pi session file.

## Data on disk we read (never write directly)

- `~/.pi/agent/sessions/**/*.jsonl` — Pi session files (append-only, no lock).
- `~/.pi/agent/settings.json`, `<project>/.pi/settings.json` — via `SettingsManager` only.
- `~/.pi/agent/missions/**` — pi-subagents missions ledger.
- `$PI_SUBAGENTS_TEMP_ROOT/async-subagent-runs/<runId>/{status.json,events.jsonl,control/}` — pi-subagents background runs. We pin `PI_SUBAGENTS_TEMP_ROOT` for workers we start and also scan the default uid-scoped roots.
- `~/.pi/agent/sessions/<slug>/subagent-artifacts/*_transcript.jsonl` — foreground children.

## Data we own

- Host SQLite: provider round-trips, tool events, session index cache, attention
  state, device list, relay channel state.
- Keychain: root identity key, relay credentials.
