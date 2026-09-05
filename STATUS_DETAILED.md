# STATUS_DETAILED.md — task ledger

Format and rules: `AGENTS.md` §3. States: `todo`, `in-progress`, `blocked`,
`done`, `dropped`. Evidence is a commit hash, a passing test command, or a file
path. Dates in notes are history, not plans. Never delete rows or notes.

---

## M0 · Foundation

| ID | Task | State | Owner | Evidence | Notes |
| --- | --- | --- | --- | --- | --- |
| M0-T1 | Workspace scaffold | done | claude-2026-09-05-a | `ELECTRON_SKIP_BINARY_DOWNLOAD=1 pnpm install && pnpm -r build && pnpm -r test` passes (2026-09-05) | see notes |
| M0-T2 | `@piorbit/protocol` schemas + envelope + seq | done | claude-2026-09-05-a | `pnpm -F @piorbit/protocol test` → `test/schemas.test.ts` (every method round-trips; error codes) + `test/jsonrpc.test.ts` | see notes |
| M0-T3 | `SessionDriver` interface + `DriverEvent` | done | claude-2026-09-05-a | `packages/worker/src/driver.ts`; exercised by `test/stable-sdk.*.test.ts` | see notes |
| M0-T4 | `StableSdkDriver` | done | claude-2026-09-05-a | `pnpm -F @piorbit/worker test` → `test/stable-sdk.prompt.test.ts` (stub provider, ordered updates) + `test/stable-sdk.open.test.ts` + `test/map-event.test.ts` | see notes |
| M0-T5 | `ChordDriver` stub + seam test | done | claude-2026-09-05-a | `pnpm -F @piorbit/worker test` → `test/seam.test.ts` 3 passed | see notes |
| M0-T6 | Worker process entry + transport | done | claude-2026-09-05-a | `test/server.test.ts` (dispatch, seq, replay, dialogs, errors) + `test/spawn.test.ts` (real process over fd 3) | see notes |
| M0-T7 | Extension UI bridge | done | claude-2026-09-05-a | `test/ui-bridge.test.ts` (select/confirm/input/editor round-trip, timeout, custom() resolves, unknown members no-op, dispose settles) | see notes |
| M0-T8 | CI | done | claude-2026-09-05-b | `.github/workflows/ci.yml` (build + typecheck + test on Node 24 / pnpm 10) | user granted the `workflow` scope 2026-09-05; Electron binary download skipped in CI |

#### M0-T1 notes
- 2026-09-05 claimed: create pnpm workspace with packages protocol, worker, subagents-bridge, host, ui, desktop, crypto, relay.
- 2026-09-05 installed and built. pnpm ignored build scripts for esbuild (a transitive dep via Pi's chord) and protobufjs; nothing needed them yet. If a future task needs esbuild's binary, run `pnpm approve-builds`.
- 2026-09-05 Electron binary download skipped with `ELECTRON_SKIP_BINARY_DOWNLOAD=1`; M5 will need it.
- 2026-09-05 done, evidence recorded in the row.

#### M0-T2 notes
- 2026-09-05 TypeScript types for the ACP core, `pi/*` extras, `SessionUpdate`, UI dialogs, and the JSON-RPC envelope are in `messages.ts` / `jsonrpc.ts`. `LineDecoder` tested.
- 2026-09-05 done: `schemas.ts` with zod per client method (`clientParamsSchemas satisfies Record<ClientMethod, …>` so a new method without a schema fails to compile), `parseClientRequest` → `ProtocolError` with JSON-RPC codes, `parseJsonLine`. Hand-written types remain the TS source of truth; schemas guard the process boundary. `pi/ui/request` moved to a notification (Pi RPC shape) so dialogs survive reconnects; `pi/extension/message` notification added.

#### M0-T6 notes
- 2026-09-05 done: `WorkerServer` (transport-agnostic dispatch, per-session `seq`, bounded replay buffer, `session/load { fromSeq }` replay, pending-dialog re-emit, error mapping) + `main.ts` (protocol on fd 3 so Pi/extension stdout cannot corrupt the stream; stdio fallback redirects console to stderr).
- 2026-09-05 bug found and fixed: server must subscribe to the driver *before* `open()`; the companion extension reports capabilities during `session_start`, inside open. Events are queued until the session path is known.
- 2026-09-05 `session/set_mode`, `pi/session/fork`, `pi/session/list` return `Unsupported` for now (fork → M1-T9, list → host catalog M1-T2).

#### M0-T3 notes
- 2026-09-05 drafted the interface with open/prompt/steer/followUp/abort/setModel/setThinkingLevel/compact/navigateTree/dispose and an event stream. Event names mirror Pi SDK 0.85 `AgentSessionEvent` plus `pi/ui/request`.
- 2026-09-05 reviewed against the real 0.85 types while implementing M0-T4. Added `sessionDir` to `DriverOpenOptions` (tests must never touch `~/.pi/agent`) and an `extension` DriverEvent for companion-extension messages. Done.

#### M0-T4 notes
- 2026-09-05 implemented on `createAgentSessionRuntime` + `createAgentSessionServices({ resourceLoaderOptions: { extensionFactories: [piorbit] } })`; `bindExtensions({ mode: "rpc", uiContext })`; event mapping in `mapEvent()`.
- 2026-09-05 found Pi 0.85.0 packaging bug: `dist/main.js` imports `@earendil-works/pi-server` which is undeclared; only resolves under npm hoisting. Fixed locally with `packageExtensions` in `pnpm-workspace.yaml`. Logged in `docs/upstream.md`.
- 2026-09-05 verified by test: `entry_appended` fires only for extension `pi.appendEntry`, not message persistence; user message_start/end precede the assistant stream; `isStreaming` flips after `prompt()` yields, so busy is caught from Pi's error. All recorded in the driver header comment and `docs/research/findings.md`.
- 2026-09-05 done: stub OpenAI-compatible SSE provider via sandboxed `models.json`; prompt yields agent_start → turn_start → text_delta… → message_end → agent_end → agent_settled; deltas reassemble; session file persisted with user+assistant entries.

#### M0-T5 notes
- 2026-09-05 seam test checks real import statements only (comments may mention Pi). Asserts protocol has no Pi imports, `driver.ts` has no Pi imports, and `ChordDriver` fails closed with `DriverUnavailableError`.

#### M0-T7 notes
- 2026-09-05 portable surface implemented in `ui-bridge.ts`: select/confirm/input/editor with timeouts, fire-and-forget events, `custom()` → undefined. Tests: select round-trip, confirm cancel → false, timeout → safe default.
- 2026-09-05 done: context is typed as Pi's `ExtensionUIContext` with a Proxy fallback (unknown members return a no-op function, never undefined); wired into `StableSdkDriver.applySession()`; input/editor round-trip, pending() for reattach, dispose settles all dialogs. Pi's internal noOp context is not exported, so we implement every member explicitly rather than proxying over it.

---

## M1 · Local loop

| ID | Task | State | Owner | Evidence | Notes |
| --- | --- | --- | --- | --- | --- |
| M1-T1 | Host: worker supervision + local WS | done | claude-2026-09-05-a | `pnpm -F @piorbit/host test` → `test/host.e2e.test.ts` (WS client → host → spawned worker → Pi → stub provider; resume from seq; one worker per cwd) | see notes |
| M1-T2 | Session catalog with cache | done | claude-2026-09-05-a | `test/catalog.test.ts`; real dir (read-only): 42 sessions / 3 projects, 13.1 ms cold, 0.2 ms warm | see notes |
| M1-T3 | UI shell | done | claude-2026-09-05-a | `packages/ui/src/{App,client,store}.ts*`, `components/*`; verified in the browser via `pnpm sandbox` | see notes |
| M1-T4 | Transcript renderer | done | claude-2026-09-05-a | `markdown.tsx` (block-split, index keys, DOMPurify, open-fence guard); browser: list + code fence streamed from the sandbox provider | thinking blocks and tool cards render; syntax highlighting deferred (see notes) |
| M1-T5 | Composer | done | claude-2026-09-05-a | `components/Composer.tsx`; browser: send, steer/follow-up/stop while running, queue chips, image paste | — |
| M1-T6 | Extension dialogs in UI | done | claude-2026-09-05-a | browser: sandbox extension `/ask` → `ctx.ui.select` rendered, answered, `notify` toast + `setStatus` pill arrived; `test/store.test.ts` | see notes |
| M1-T7 | Model/thinking/name/compaction controls | done | claude-2026-09-05-a | `TopBar.tsx`: model picker, thinking select, context % pill that compacts on click, double-click title to rename (`pi/session/rename`) | browser-verified model/thinking; rename/compact wired to tested worker methods |
| M1-T8 | Resume and reattach with seq | done | claude-2026-09-05-a | `client.ts` (track/resume on reconnect + visibilitychange); host e2e resume test; browser: reload → session listed → transcript hydrated via `pi/session/entries` | — |
| M1-T10 | Visual design pass (now: assistant-ui adoption, D-17) | done | claude-2026-09-05-b | `pnpm -r build && pnpm -r typecheck && pnpm -r test` (172 tests); browser: streaming, highlighted code, dark+light, mobile+desktop layouts | user feedback 2026-09-05: "looks very basic, should be impressive"; rebuilt on assistant-ui per `packages/ui/DESIGN.md`; browser sign-off pending |
| M1-T9 | Session tree | done | claude-2026-09-05-a | driver `fork()` via `AgentSessionRuntime.fork` (test: `stable-sdk.prompt.test.ts` forks at a user entry into a new file and keeps serving); worker re-keys the session (`server.test.ts`); `History.tsx` panel with fork/jump, branch depth by indentation; browser-verified | see notes |

#### M1-T1 notes
- 2026-09-05 done: `WorkerClient` (spawn over fd 3, id correlation, ready/exit), `WorkerPool` (one per cwd, shared in-flight spawn, crash → `pi/worker/status crashed`), `Router` (session/new by cwd; path-bearing methods by pool memory then catalog header; `pi/session/list` from catalog; `pi/ui/response` fanned to all workers), `HostServer` (HTTP static UI with SPA fallback + `/healthz`, WS `/ws`, broadcast notifications to every client). Loopback only.
- 2026-09-05 host resolves the worker entry via `createRequire().resolve("@piorbit/worker/main")` — a dependency for path resolution only, no code import, seam intact.
- 2026-09-05 known gaps for later tasks: notifications broadcast to all clients (per-session subscription is M2-T3); no auth on the local socket (loopback; relay auth is M6).

#### M1-T3 notes
- 2026-09-05 React 19 + Vite. `HostClient` (JSON-RPC over WS, reconnect with backoff, per-session seq tracking, `session/load { fromSeq }` on reconnect, `visibilitychange` reconnect). `store.ts` is a pure reducer (tested). Layout: sidebar (projects → sessions, new session by cwd), top bar (model picker, thinking level, context %), transcript, composer, dialogs, toasts. Mobile: sidebar becomes a drawer under 800px; safe-area insets; `--kb` inset variable reserved for M7-T2.
- 2026-09-05 `scripts/sandbox.mjs` (`pnpm sandbox`) gives any agent a demo: temp Pi dirs, fake streaming provider, a dialog-test extension, host with the built UI on 41441. `.claude/launch.json` config `sandbox`.
- 2026-09-05 host resolves the UI bundle via `@piorbit/ui/package.json` (dependency for path resolution only).

#### M1-T4 notes
- 2026-09-05 marked + DOMPurify; blocks keyed by index; last block during streaming with an unclosed fence renders as plain `<pre>` until it closes. Syntax highlighting is deferred: shiki is 1.2 MB gzip; plan is `@shikijs/stream` or a lezer-based highlighter behind a lazy import when M4/M7 budgets are known. Not blocking.

#### M1-T6 notes
- 2026-09-05 verified with a real Pi extension inside the sandbox worker. Found and fixed: the store never removed an answered dialog (`dialogAnswered` action). Extension commands keep `session/prompt` pending until their dialog resolves, so the composer now clears optimistically and restores on failure.

#### M1-T9 notes
- 2026-09-05 fork replaces `runtime.session` and changes the session file path. The driver re-binds extensions and re-subscribes (`applySession`), the worker re-keys its session map and emits a `state` update under the new path, the host router binds the new path to the same cwd, and the UI moves the view (`forked` action) and re-hydrates. Jump uses `pi/session/navigate` then re-hydrates. A proper tree visualisation (not just indentation) can come with M2-T3 when transcripts get virtualised.

#### M1-T2 notes
- 2026-09-05 catalog reads only the first line (header) + stat per file, cached by (size, mtime). Handles Pi's slug-subdir layout (default dir) and the flat layout Pi uses for an explicit `--session-dir` (found by the e2e test). `messageCount` is not computed yet (would need a full read; defer to a background pass or Pi's own `SessionInfo` cache format).
- 2026-09-05 done: measured against `~/.pi/agent/sessions` read-only: 42 sessions, 3 projects, 13.1 ms cold scan, 0.2 ms warm. Well under the one-second done-when.

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

### D-14 · 2026-09-05 · Q-1 closed for now
Decision: do not wait on Earendil's plans for the experimental server. D-6
(stable SDK now, migrate later) already answers what to build; the question
only informs MX-T1 monitoring. Reopen only if a Pi release ships a usable
`pi-server` with extensions and cwd.

### D-15 · 2026-09-05 · UI framework is React + Vite
Decision: `@piorbit/ui` is React 19 + Vite. Matches the streaming-markdown
prior art (Streamdown, AI SDK), pi-gui, and pi-web-ui.

### D-16 · 2026-09-05 · Full autonomy on non-breaking decisions
Decision: agents make routine and architectural-but-reversible decisions
without asking, record them here, and only stop for the user when genuinely
blocked or when a decision would be hard to reverse.

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

### D-17 · 2026-09-05 · UI rebuilt on assistant-ui + Tailwind v4; react-pi evaluated and rejected
Decision: `@piorbit/ui` is rebuilt on `@assistant-ui/react` 0.15.18 using the
ExternalStore + RemoteThreadList runtime over piorbit's existing HostClient,
reducer, and protocol (adapter in `packages/ui/src/runtime/`). Styling is
Tailwind v4 with registry components copied from the MIT clone (Radix flavor)
and the visual contract in `packages/ui/DESIGN.md` ("Ground Station").
`@assistant-ui/react-pi` was read in full and NOT adopted: its `PiClient`
contract needs full-message `message_update`s (we stream deltas), drops live
events after a seq restart, uses index-based message ids (we need Pi entry ids
for fork/jump), lacks `max` thinking, fork, navigate, and refetches the whole
thread on unknown events. Its patterns are borrowed: tool-associated dialog
classification (worker stamps `toolCallId` when exactly one tool runs),
assistant+tool turns merged into one message with steps, free-standing
dialogs as a side channel.
Why: the user asked to learn assistant-ui and use it, and to push the UI
further than the plain-CSS M1 UI. assistant-ui gives primitives, branching,
queue, tool/approval seams, markdown/highlighting, and a registry of
coding-agent elements; keeping our runtime layer preserves invariants 1, 2, 8.
Consequences: protocol gained `UiDialogRequest.toolCallId?` and
`UiFireAndForget dialogResolved`; M1-T10 is redefined as this adoption; old
components, marked, and dompurify are removed; `@assistant-ui/ui`, tw-shimmer,
tw-glass are registry-only (not on npm) and are copied as source when needed.

---

## Open questions

| ID | Question | Blocks | Asked of |
| --- | --- | --- | --- |
| Q-1 | What will Pi's experimental server become? | — | answered by D-14: not blocking, monitor via MX-T1 |
| Q-2 | UI framework? | — | answered by D-15: React + Vite |
| Q-3 | Which Pi release to pin next, and cadence of MX-T2 bumps. | MX-T2 | agent decides per release (D-16); default: bump when a release fixes something we hit or adds an SDK capability we need |

---

## Status edits log

- 2026-09-05 · claude-2026-09-05-a · created ledger, M0-T1 done, M0-T3 in-progress, D-1..D-12 recorded.
- 2026-09-05 · claude-2026-09-05-a · install/build/test verified; M0-T1 evidence, M0-T5 done, M0-T2 and M0-T7 in-progress with tests.
- 2026-09-05 · claude-2026-09-05-a · D-13: subagents-bridge replaced by pi-extension with modules; file layer moved to host; M3/M8 rows updated; M8-T5 added.
- 2026-09-05 · claude-2026-09-05-a · M0-T3, M0-T4, M0-T7 done with tests; M0-T8 blocked on gh `workflow` scope; D-14..D-16; Q-1/Q-2 answered; upstream packaging bug logged; repo on GitHub (private), branch `main`.
- 2026-09-05 · claude-2026-09-05-a · M0-T2 and M0-T6 done; M0 complete except CI. 26 tests green.
- 2026-09-05 · claude-2026-09-05-a · M1-T1 and M1-T2 done (host e2e through a real worker and stub provider; catalog timed on the real dir). 31 tests green.
- 2026-09-05 · claude-2026-09-05-a · M1-T3/T4/T5/T6/T8 done, T7 in-progress; UI verified in the browser against the sandbox (streaming markdown, hydration after reload, extension select dialog round trip). `pnpm sandbox` added.
- 2026-09-05 · claude-2026-09-05-a · M1-T7 and M1-T9 done (fork on the real SDK, history panel, rename, compact). M1 complete. 39 tests green.
- 2026-09-05 · claude-2026-09-05-b · D-17 recorded (assistant-ui adoption, react-pi rejected); protocol gained toolCallId + dialogResolved; UI rebuild in progress (workflow).
- 2026-09-05 · claude-2026-09-05-b · M1-T10 done. UI rebuilt on assistant-ui 0.15.18 + Tailwind v4 (D-17): runtime adapter (`src/runtime/`), thread (`src/components/thread/`), shell (`src/components/shell/`), design system (`src/components/ui`, `src/components/status`, `globals.css`). Old plain-CSS components, `markdown.tsx`, marked and dompurify removed. Worker now stamps `toolCallId` on dialogs raised under single-tool causality and emits `dialogResolved`. 172 tests green.

#### M1-T10 notes
- 2026-09-05 built by a 10-agent workflow (design system + thread + shell on Fable, runtime/worker/integration/review/fix on Opus), then verified in the browser against `pnpm sandbox`.
- 2026-09-05 three defects found in browser verification that the agents' own reviews missed, all fixed here:
  1. **Blank screen on the first send in any project.** `threadList.initialize()` refreshed the catalog, which changed the thread-list signature and fired `runtime.threads.reload()` while assistant-ui was still adopting the thread it had just initialized; every later render threw `useClientLookup: key "<path>" not found`. Fixed with a `beginInitialize`/`endInitialize` bracket that gates the reload, and the refresh inside `initialize` dropped. Regression tests cover both the call order and the bracket closing on failure.
  2. **Code blocks never tokenized.** `react-syntax-highlighter`'s `light-async` registers a language from a dynamic import but highlights on the same render, so the first paint runs through an unregistered language and nothing re-renders afterwards; the highlighter, hljs core and the `typescript` chunk all fetched 200 and the `<code>` still had zero spans. Switched to the sync `light` build with 28 languages registered at module load. Also collapsed 195 language chunks into one 132 kB lazy chunk.
  3. **`useIsTouch()` disagreed with assistant-ui.** Ours was `(pointer: coarse)`, the primitive's is `(pointer: coarse) and (not (any-pointer: fine))`. On a tablet with a trackpad our composer handler would bow out and the primitive would submit with no run config, losing the steer / follow-up choice. Aligned.
- 2026-09-05 not defects, ruled out during verification: the repeated `WebSocket … failed` console lines are stale reconnect attempts from page loads before the host was listening (a 12 s probe recorded zero new sockets); Enter not submitting is an artifact of the automation harness's synthetic Return, confirmed working in real Chrome by the user.
- 2026-09-05 known gaps, not blocking: main bundle is 1.0 MB / 303 kB gzip (no manual chunking yet); `SPEND` reads "No spend recorded" until Pi persists usage; worker status shows "No status yet" because the pool never emits `starting`.
