# STATUS_DETAILED.md — task ledger

Format and rules: `AGENTS.md` §3. States: `todo`, `in-progress`, `blocked`,
`done`, `dropped`. Evidence is a commit hash, a passing test command, or a file
path. Dates in notes are history, not plans. Never delete rows or notes.

---

## M0 · Foundation

| ID | Task | State | Owner | Evidence | Notes |
| --- | --- | --- | --- | --- | --- |
| M0-T1 | Workspace scaffold | done | claude-2026-09-05-a | `ELECTRON_SKIP_BINARY_DOWNLOAD=1 pnpm install && pnpm -r build && pnpm -r test` passes (2026-09-05) | see notes |
| M0-T2 | `@piorbit/protocol` schemas + envelope + seq | in-progress | claude-2026-09-05-a | `packages/protocol/test/jsonrpc.test.ts` passes | TS types + LineDecoder done; zod schemas + validation still todo |
| M0-T3 | `SessionDriver` interface + `DriverEvent` | in-progress | claude-2026-09-05-a | `packages/worker/src/driver.ts` | drafted; needs review against Pi 0.85 event list |
| M0-T4 | `StableSdkDriver` | todo | — | — | skeleton in `packages/worker/src/drivers/stable-sdk.ts`; every method throws DriverUnavailableError |
| M0-T5 | `ChordDriver` stub + seam test | done | claude-2026-09-05-a | `pnpm -F @piorbit/worker test` → `test/seam.test.ts` 3 passed | see notes |
| M0-T6 | Worker process entry + transport | todo | — | — | stdin LineDecoder loop in `packages/worker/src/main.ts`; no dispatch yet |
| M0-T7 | Extension UI bridge | in-progress | claude-2026-09-05-a | `test/ui-bridge.test.ts` 2 passed | see notes |
| M0-T8 | CI | todo | — | — | `.github/workflows/ci.yml` written, never run (no remote yet) |

#### M0-T1 notes
- 2026-09-05 claimed: create pnpm workspace with packages protocol, worker, subagents-bridge, host, ui, desktop, crypto, relay.
- 2026-09-05 installed and built. pnpm ignored build scripts for esbuild (a transitive dep via Pi's chord) and protobufjs; nothing needed them yet. If a future task needs esbuild's binary, run `pnpm approve-builds`.
- 2026-09-05 Electron binary download skipped with `ELECTRON_SKIP_BINARY_DOWNLOAD=1`; M5 will need it.
- 2026-09-05 done, evidence recorded in the row.

#### M0-T2 notes
- 2026-09-05 TypeScript types for the ACP core, `pi/*` extras, `SessionUpdate`, UI dialogs, and the JSON-RPC envelope are in `messages.ts` / `jsonrpc.ts`. `LineDecoder` tested. Still needed: zod schemas for runtime validation at the host boundary, and a round-trip test per message.

#### M0-T3 notes
- 2026-09-05 drafted the interface with open/prompt/steer/followUp/abort/setModel/setThinkingLevel/compact/navigateTree/dispose and an event stream. Event names mirror Pi SDK 0.85 `AgentSessionEvent` plus `pi/ui/request`. Review pending.

#### M0-T5 notes
- 2026-09-05 seam test checks real import statements only (comments may mention Pi). Asserts protocol has no Pi imports, `driver.ts` has no Pi imports, and `ChordDriver` fails closed with `DriverUnavailableError`.

#### M0-T7 notes
- 2026-09-05 portable surface implemented in `ui-bridge.ts`: select/confirm/input/editor with timeouts, fire-and-forget events, `custom()` → undefined. Tests: select round-trip, confirm cancel → false, timeout → safe default.
- 2026-09-05 still todo: wrap Pi's own no-op UI context in a Proxy (pi-web pattern) so anything not overridden degrades exactly like RPC mode; editor round-trip test; wire into `StableSdkDriver.open()` via `bindExtensions({ mode: "rpc", uiContext })`.

---

## M1 · Local loop

| ID | Task | State | Owner | Evidence | Notes |
| --- | --- | --- | --- | --- | --- |
| M1-T1 | Host: worker supervision + local WS | todo | — | — | — |
| M1-T2 | Session catalog with cache | todo | — | — | — |
| M1-T3 | UI shell | todo | — | — | — |
| M1-T4 | Transcript renderer | todo | — | — | — |
| M1-T5 | Composer | todo | — | — | — |
| M1-T6 | Extension dialogs in UI | todo | — | — | — |
| M1-T7 | Model/thinking/name/compaction controls | todo | — | — | — |
| M1-T8 | Resume and reattach with seq | todo | — | — | — |
| M1-T9 | Session tree | todo | — | — | — |

---

## M2 · Many sessions, many projects

| ID | Task | State | Owner | Evidence | Notes |
| --- | --- | --- | --- | --- | --- |
| M2-T1 | Worker pool | todo | — | — | — |
| M2-T2 | Attention model + inbox | todo | — | — | — |
| M2-T3 | Fast switching | todo | — | — | — |
| M2-T4 | Project management + trust | todo | — | — | — |
| M2-T5 | Desktop notifications | todo | — | — | — |

---

## M3 · Subagent tabs

| ID | Task | State | Owner | Evidence | Notes |
| --- | --- | --- | --- | --- | --- |
| M3-T1 | `subagents` module (in-process bus) | todo | — | — | stub in `packages/pi-extension/src/modules/subagents.ts` with registry-symbol detection |
| M3-T2 | Host file layer watcher | todo | — | — | paths in `packages/host/src/subagents/file-layer.ts` |
| M3-T3 | Foreground children via transcripts | todo | — | — | — |
| M3-T4 | Control: steer/stop/resume | todo | — | — | — |
| M3-T5 | Tab group UI | todo | — | — | — |
| M3-T6 | Workflow view | todo | — | — | — |
| M3-T7 | Missions view | todo | — | — | — |
| M3-T8 | Acceptance + watchdog chips | todo | — | — | — |
| M3-T9 | Upstream PRs | todo | — | — | list in `docs/upstream.md` |

---

## M4 · Settings and logs

| ID | Task | State | Owner | Evidence | Notes |
| --- | --- | --- | --- | --- | --- |
| M4-T1 | Settings adapter | todo | — | — | — |
| M4-T2 | Settings UI | todo | — | — | — |
| M4-T3 | Package manager UI | todo | — | — | — |
| M4-T4 | Providers and models | todo | — | — | — |
| M4-T5 | Log store | todo | — | — | — |
| M4-T6 | Logs page | todo | — | — | — |
| M4-T7 | Keybindings + trust views | todo | — | — | — |

---

## M5 · Desktop shell

| ID | Task | State | Owner | Evidence | Notes |
| --- | --- | --- | --- | --- | --- |
| M5-T1 | Electron main | todo | — | — | — |
| M5-T2 | Bundled runtime outside asar | todo | — | — | — |
| M5-T3 | Keychain | todo | — | — | — |
| M5-T4 | Notifications + mic permission | todo | — | — | — |
| M5-T5 | Packaging, signing, updates | todo | — | — | — |

---

## M6 · Relay and pairing

| ID | Task | State | Owner | Evidence | Notes |
| --- | --- | --- | --- | --- | --- |
| M6-T1 | Noise IK/KK crypto | todo | — | — | — |
| M6-T2 | Pairing flow | todo | — | — | — |
| M6-T3 | Device list + revocation | todo | — | — | — |
| M6-T4 | Relay server | todo | — | — | — |
| M6-T5 | Host relay client | todo | — | — | — |
| M6-T6 | Keystroke timing defense | todo | — | — | — |
| M6-T7 | Threat model doc | todo | — | — | — |

---

## M7 · Mobile PWA

| ID | Task | State | Owner | Evidence | Notes |
| --- | --- | --- | --- | --- | --- |
| M7-T1 | Manifest, SW, secure context | todo | — | — | — |
| M7-T2 | Layout + keyboard inset | todo | — | — | — |
| M7-T3 | Reconnect + resume | todo | — | — | — |
| M7-T4 | Approval UI | todo | — | — | — |
| M7-T5 | Push | todo | — | — | — |
| M7-T6 | Mobile mic | todo | — | — | — |

---

## M8 · Package support

| ID | Task | State | Owner | Evidence | Notes |
| --- | --- | --- | --- | --- | --- |
| M8-T1 | Capability detection | in-progress | claude-2026-09-05-a | `packages/pi-extension/src/index.ts` | extension emits `piorbit/capabilities` at session_start; UI side todo |
| M8-T2 | `transcribe` module + desktop path | todo | — | — | module stub; detect returns false |
| M8-T3 | Native markdown preview + image display | todo | — | — | — |
| M8-T4 | `web-access` module | todo | — | — | module stub; detect returns false |
| M8-T5 | Module authoring guide | todo | — | — | — |

---

## MX · Cross-cutting

| ID | Task | State | Owner | Evidence | Notes |
| --- | --- | --- | --- | --- | --- |
| MX-T1 | Migration readiness | in-progress | claude-2026-09-05-a | `packages/worker/src/drivers/chord.ts`; seam test green (M0-T5) | ongoing: log each Pi release in `docs/pi-releases.md` |
| MX-T2 | Pi pin bumps | todo | — | — | current pin 0.85.0 |
| MX-T3 | Upstream log | todo | — | — | `docs/upstream.md` created empty |
| MX-T4 | Security review | todo | — | — | before M6 ships |
| MX-T5 | Accessibility pass | todo | — | — | — |

---

## Handoffs

(none yet)

---

## Decisions log (append-only)

### D-1 · 2026-09-05 · Build from scratch, not a fork
Decision: piorbit is a new codebase. Borrow patterns and small pieces from
pi-web (Proxy-over-default UI context, pending dialog store), pi-web-ui
(uiContext bridge), remote-pi (wire vocabulary, pairing, abandoned Noise XX
code), pi-workflows (paged views with byte budgets), Paseo (security doc).
Why: Paseo is generic multi-agent; pi-gui has no remote; both would make
subagent, settings, and logs depth a contribution fight.
Consequences: we own the whole stack and the migration risk (see D-6).

### D-2 · 2026-09-05 · Portable extension UI surface only
Decision: host `select`, `confirm`, `input`, `editor`, `notify`, `setStatus`,
`setWidget` (string lines), `setTitle`, `setEditorText`. Everything else
cancels safely. No headless pi-tui / xterm.js emulation of `custom()`.
Why: `custom()` needs a real terminal and pi-tui component trees; emulation is a
project of its own with no precedent. pi-markdown-preview and pix-display are
TUI-only and get native replacements (M8-T3).
Consequences: some community extensions will not fully work; document which.

### D-3 · 2026-09-05 · Foreground children supported everywhere
Decision: show pi-subagents foreground children, including for sessions started
from a terminal, by watching `subagent-artifacts/*_transcript.jsonl`; propose an
upstream live index.
Why: user wants full observability, not a scope cut.
Consequences: M3-T3 is fragile until upstream lands an index (M3-T9).

### D-4 · 2026-09-05 · Herdr out
Decision: piorbit tab groups replace pi-subagents' Herdr project panes and
inspector panes. No Herdr dependency.
Consequences: `project.open` and Herdr FleetView actions are dead surfaces in
piorbit.

### D-5 · 2026-09-05 · Protocol mirrors ACP
Decision: internal protocol is ACP-shaped (`session/new`, `session/load`,
`session/prompt`, `session/cancel`, `session/request_permission`) over JSON-RPC,
with `pi/*` namespaced extras. An ACP server can be exposed later.
Why: free future clients (Zed, JetBrains, Neovim); clean seam for D-6.

### D-6 · 2026-09-05 · Stable SDK now, migration expected
Decision: build on `createAgentSessionRuntime` from the stable Pi SDK. Do not
build on the experimental pi-server/Chord stack. No spikes; go straight to the
app. Rewrite the Pi-facing layer when community packages visibly migrate.
Why: the experimental stack has 3 tools, no extensions, no cwd in create, a
separate session store, and no compatibility promise; `RemoteSession` was already
deleted once. The stable SDK carries the whole ecosystem.
Consequences: keep the Pi-facing layer small (worker + subagents bridge, roughly a
tenth of the code) and behind `SessionDriver`.

### D-7 · 2026-09-05 · Pin Pi inside the worker
Decision: `packages/worker` depends on an exact `@earendil-works/pi-coding-agent`
version (0.85.0 now). The user's global Pi is never the runtime.
Why: upstream releases every 1–2 weeks with breaking SDK changes (0.84 deltas-only
`message_update`, header types). Churn happens on our schedule.
Consequences: users' extensions load against our pinned version; track upstream
within a few releases (MX-T2).

### D-8 · 2026-09-05 · Two drivers from day one
Decision: `SessionDriver` has `StableSdkDriver` (real) and `ChordDriver` (stub
that compiles and has a seam test).
Why: proves nothing above the worker depends on Pi types; makes D-6's migration a
driver swap.

### D-9 · 2026-09-05 · Phone is a PWA only
Decision: no Capacitor or native shell, ever.
Consequences: iOS mic permission re-prompts per launch; push requires
Add to Home Screen and is a single tap-to-open; no lock-screen action buttons;
work around installed-PWA keyboard/viewport bugs in CSS/JS (M7-T2).

### D-10 · 2026-09-05 · Relay trust model
Decision: QR carries an ephemeral public key in the URL fragment; the paired
side encrypts real key material to it. The desktop root identity key signs a
versioned device list; revocation is re-signing. Explicit "Link a device" screen.
Optional SAS. Channel id derived as HKDF(shared, "relay_token").
Why: a photographed QR must be useless after use; Paseo and Happy lack revocation.

### D-11 · 2026-09-05 · Upstream contributions stand on their own
Decision: PRs and issues to upstream projects are small, self-contained, and
justified on their merits for that project (extensibility, correctness,
headless-host support).
Consequences: see `AGENTS.md` §6.

### D-12 · 2026-09-05 · Planning is dependency-ordered, never time-ordered
Decision: no dates, estimates, or deadlines in PLAN/STATUS files.
Why: coding agents do not work on human timelines; dates rot and mislead.

### D-13 · 2026-09-05 · One companion extension with a module per package
Decision: all in-process glue for community packages lives in one Pi extension,
`packages/pi-extension`, with one module per package under `src/modules/`.
Modules detect their package at `session_start`, never import each other, and
fail individually. File-based observation (pi-subagents runs, missions, session
catalog) lives in the host, not the extension.
Why: Pi loads extensions in-process with one factory each; one extension means
one guard, one channel to the worker, one thing to keep in sync with the pinned
Pi. Absent packages become dormant modules, which is exactly the "no harm if
missing" requirement. The host keeps the file layer so terminal-started sessions
(no worker, no extension) stay visible.
Consequences: `packages/subagents-bridge` removed; M3-T1, M8-T1, M8-T2, M8-T4
reworded; M8-T5 added (module authoring guide).

---

## Open questions

| ID | Question | Blocks | Asked of |
| --- | --- | --- | --- |
| Q-1 | What will Pi's experimental server and Radius relay become, and will today's `ExtensionAPI` extensions run under the future web presentation? | nothing now; informs MX-T1 | Earendil (not yet asked) |
| Q-2 | UI framework: React + Vite is the default assumption (matches streaming-markdown prior art). Confirm or change before M1-T3. | M1-T3 | user |
| Q-3 | Which Pi release to pin next, and cadence of MX-T2 bumps. | MX-T2 | user |

---

## Status edits log

- 2026-09-05 · claude-2026-09-05-a · created ledger, M0-T1 done, M0-T3 in-progress, D-1..D-12 recorded.
- 2026-09-05 · claude-2026-09-05-a · install/build/test verified; M0-T1 evidence, M0-T5 done, M0-T2 and M0-T7 in-progress with tests.
- 2026-09-05 · claude-2026-09-05-a · D-13: subagents-bridge replaced by pi-extension with modules; file layer moved to host; M3/M8 rows updated; M8-T5 added.
