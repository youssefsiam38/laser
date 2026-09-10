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
│  agent store + run registry (agents.json, agent-runs.json) │
│  relay client (outbound only) · log store (SQLite)         │
└───────────────▲────────────────────────────────────────────┘
                │ protocol over stdio/socket, one worker per project
┌───────────────┴────────────────────────────────────────────┐
│  packages/worker — imports Pi (with pi-extension)           │
│  SessionDriver ──┬── StableSdkDriver (pinned Pi SDK)        │
│                  └── ChordDriver (stub, seam test)          │
│  ui-bridge (ExtensionUIContext → pi/ui/*)                   │
│  engine adapter + Laser-owned feature loader                 │
│  agent harness: child sessions, .worktrees/, timeouts,     │
│  parent events; Beam; Namer (docs/agents.md)               │
│  loads packages/pi-extension into the session:             │
│    one extension, modules/{provider-log,subagents,         │
│    background-work,transcribe,goal,...} activated          │
│    by detection or by a worker-supplied bridge             │
└─────────────────────────────────────────────────────────────┘

packages/relay  ← dumb byte forwarder on Railway, 2 sockets per channel
packages/crypto ← Noise IK/KK, pairing, device list (Node + browser)
packages/desktop ← Electron main: tray, keychain, updater, bundled Node
```

The binding product/engine boundary and exhaustive settings classification are
in [`product-boundary.md`](product-boundary.md). Laser is the product; Pi and
Pi-native packages are exact-pinned implementation details confined to the
worker and companion extension.

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
extension factory (`createLaserExtension({ send })`). At `session_start` it
runs each module's `detect()` and activates the ones whose package is present,
then reports `laser/capabilities` to the worker. Modules:

| Module | Bridges | Detection |
| --- | --- | --- |
| `provider-log` | Pi's `before_provider_request` / `after_provider_response` hooks | always |
| `subagents` | the agent harness tools — `start_agent`, `send_agent_message`, `inspect_fleet`, `inspect_agent`, `stop_agent`, `remove_agent_worktree` for a session that may delegate, `complete_agent_run` for a child; no waiting tool, and no list — `inspect_fleet` is the fleet column's tree, scoped to the caller (D-163) — the child's role block in its system prompt, and agent events delivered to the parent model as `lasercode/agent-event`; all from the worker-supplied `AgentHarnessBridge` (`src/agents-bridge.ts`, [`agents.md`](agents.md)) | the worker passed a bridge (Subagents feature enabled) |
| `background-work` | long commands: `bash` with an explicit background flag, promotion to a background task after the foreground timeout, `task_output`/`task_stop` (no waiting tool: every exit wakes the model, D-162; no list: the harness's `inspect_fleet` shows every command in the tree, and `task_output` reads a child's through the worker, D-163), `lasercode/task/update` for the fleet and `lasercode/task-event` | the worker passed `BackgroundWorkOptions` |
| `goal` | canonical durable goal state | Goals feature enabled |
| `transcribe` | pi-gpt-transcribe desktop dictation | matching command registered |
| `web-access` | registers the transcript-only search tool; the worker supplies its credential/policy-aware executor (M12-T64). The duplicate result list remains retired (D-61) | Web search feature enabled |

Adding support for engine behavior means a reusable Pi-native package plus one
module that translates it to the product protocol. The agent harness is the
deliberate exception (D-140): `subagents` and `background-work` are Laser's
own, fed by the worker, because no community package provides the semantics
the binding references require. Modules never import each other and fail
individually. Nothing here reads files; the host keeps the durable run
registry from `agents/run` notifications and the session catalog from its own
watcher.

## Protocol shape

ACP-inspired JSON-RPC:

- Product requests (client → host): `session/new`, `session/load`, `session/prompt`,
  `session/cancel`, `session/set_mode`, plus `pi/*` extras such as
  `pi/session/steer`, `pi/session/follow_up`, `pi/session/fork`,
  `pi/model/set`, `pi/thinking/set`, `pi/compact`, `pi/settings/*`,
  `pi/logs/*`. Legacy `pi/packages/*` requests are rejected;
  package installation is not a Laser capability.
- New product capabilities use engine-neutral methods: `feature/list`,
  `feature/set`, `session/goal/get`, `session/goal/action`, and the `agents/*`
  family (definitions, policy, runs, Beam and Namer; `session/new` takes an
  `agentName`) with the `agents/updated`, `agents/run`, `agents/event` and
  `agents/beam/choose-model` notifications — see [`agents.md`](agents.md).
  Remaining `pi/*` methods are internal wire compatibility and are not
  product vocabulary.
- Notifications (host → client): `session/update` with a monotonically
  increasing `seq` per session; clients resume with `session/load { fromSeq }`.
- Requests (host → client): `session/request_permission` and `pi/ui/request`
  (select, confirm, input, editor). Fire-and-forget: `pi/ui/notify`,
  `pi/ui/status`, `pi/ui/widget`, `pi/ui/title`, `pi/ui/editor_text`.

## Process model

- Host: one long-lived process (inside Electron main in the desktop build, or
  standalone).
- Worker: one process per project directory, spawned from a bundled stock Node
  binary, with a pinned Pi. Retired when idle, no presentation is attached and
  no agent run of its project is still going. Child agent sessions run inside
  the same worker as their project: a checkout under `<project>/.worktrees/`
  is part of that project, never a second project (D-140).
- Never two workers for one cwd. Never two writers on one Pi session file.
- A deb/rpm upgrade sends the exact `/opt/Laser` daemon a graceful SIGHUP only
  after the new files are installed. Its Electron supervisor restarts it from
  the new bundle; a standalone command-started host stays down until the next
  app launch or `laser up`. Desktop startup independently replaces any recorded
  host whose CLI version does not equal the bundled version before UI connect.
  The renderer does not carry old-protocol fallbacks for update skew.

## Internal engine data on disk

- `<Laser data>/agent/sessions/**/*.jsonl` — session files (append-only, no lock).
- `<Laser data>/agent/settings.json` — private engine state, written only through
  `SettingsManager`.
- Session custom entries `lasercode/agent` (which agent a session runs as, and
  for a child its parent, run and worktree), `lasercode/agent-run` (run
  moments in the child) and the parent's `lasercode/agent-event` messages —
  written by the worker, read by the host's catalog to attribute sessions.
- User skills are read from the documented global roots. Trusted project skills
  are read from `<project>/.laser/skills` and `<project>/.agents/skills`.
  Laser does not write, install or bundle skills.
- `<project>/.worktrees/<slug>` — a child agent's checkout on branch
  `agents/<slug>`, hidden through `<gitdir>/info/exclude`.

Laser does not discover `<project>/.pi`. Project configuration is owned at
`<project>/.laser/settings.json`, validated by the worker and applied as
in-memory engine overrides.

## Data we own

- Host SQLite: provider round-trips, tool events, session index cache, attention
  state, device list, relay channel state.
- `<Laser data>/state/agents.json`: agent definitions, the default agent,
  durable rename aliases, the policy and each built-in agent's instruction/model choices. `<Laser data>/state/agent-runs.json`:
  every agent run the host has heard of, fed by worker `agents/run`
  notifications ([`agents.md`](agents.md) §8).
- `<Laser data>/state/workspaces/beam` and `.../chat`: containers whose opaque,
  persistent child directories give every Beam and Chat session its own workspace
  of the projectless built-in agents; not projects. They live under the state
  directory the host creates and owns, so a sandboxed or relocated state
  directory keeps its workspaces with it, and a Beam or Chat session whose
  folder is gone has it recreated instead of becoming unopenable.
- Keychain: root identity key, relay credentials.
- `<project>/.laser/settings.json`: project-scoped product settings.
