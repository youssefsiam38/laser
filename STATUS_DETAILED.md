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
| M0-T8 | CI | blocked | claude-2026-09-05-b | `.github/workflows/ci.yml` committed and correct | workflow scope granted, file installed, but GitHub refuses to start the job: "recent account payments have failed or your spending limit needs to be increased". Private repos bill Actions minutes. Unblock in GitHub Billing & plans; nothing to change in the repo. Local substitute: `pnpm verify`. |

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
| M2-T1 | Worker pool | done | claude-2026-09-05-c | `pnpm -r build && pnpm -r typecheck && pnpm -r test` (385 tests) at `958bfb1` | pool lifecycle: starting/ready/crashed/retired, backoff, idle retire gated on attachments + live pi-subagents runs; boot-id+start-time pid identity |
| M2-T2 | Attention model + inbox | done | claude-2026-09-05-c | `pnpm -r build && pnpm -r typecheck && pnpm -r test` (385 tests) at `958bfb1` | host attention model, persisted seen watermark, inbox |
| M2-T3 | Fast switching | done | claude-2026-09-05-c | `pnpm -r build && pnpm -r typecheck && pnpm -r test` (385 tests) at `958bfb1` | hydrated-view cache in host; per-path selectors verified |
| M2-T4 | Project management + trust | done | claude-2026-09-05-c | `pnpm -r build && pnpm -r typecheck && pnpm -r test` (385 tests) at `958bfb1` | server-side projects with Pi trust gate passed through as a dialog |
| M2-T5 | Desktop notifications | in-progress | lane-B | `pnpm -r build && pnpm -r typecheck && pnpm -r test` — 591 tests, exit 0 (2026-09-05, wave 2 integration) | tray + edge-gated notifications written (`packages/desktop/src/notifications.ts`); never fired on a real desktop session here |
| M2-T6 | Status line, project line, tool groups | done | lane-F | `pnpm -r build && pnpm -r typecheck && pnpm -r test` — 591 tests, exit 0 (2026-09-05, wave 2 integration); `pnpm -F @piorbit/worker test -- git`, `pnpm -F @piorbit/ui test -- thread` | D-20 §4/§5/§6: consecutive tool calls collapse; one status line above the composer; git branch and `+a −r` since the session opened, with Create PR |

#### M2-T1 notes
- 2026-09-05 claimed: rewrite `worker-pool.ts` with lifecycle states (starting/ready/crashed/retired), backoff restart, idle retire gated on attached clients + live pi-subagents runs, duplicate-cwd refusal.
- 2026-09-05 done. `pi/worker/status` now carries a `WorkerInfo` (pid, restarts, since, retryAt, canRestart, reopened); the pool emits `starting` itself (it never did) and re-emits the worker's own `ready`/`retired` enriched. Crash → exponential backoff (1s doubling, 30s cap, 5 attempts) and the sessions that were open are re-loaded, which the UI adopts through the existing seq-epoch resync. The crash counter resets only after 60s of healthy uptime, so a crash loop still reaches the cap instead of restarting forever. Retirement requires: idle 10 min, no attached client, no running agent, and no live pi-subagents run — the last read from each run's `status.json` + `process.kill(pid, 0)`, never `lastUpdate` (findings.md reaping hazard); an unreadable temp root counts as "work in flight".

#### M2-T2 notes
- 2026-09-05 claimed: derive `SessionAttention` in the host from worker events; persist "seen" so `finished_unread` survives a reload; add `pi/session/attention` and an attention-sorted inbox query.
- 2026-09-05 done. `packages/host/src/attention.ts`. Durable state is a timestamp, not a seq (seqs restart with each worker), so `finished_unread` = the session file changed after the last `pi/session/seen`, which also catches sessions driven from a terminal. A session nobody ever opened here is `idle`, not unread — otherwise first launch marks the whole history unread. The host clears a dialog on a client's `pi/ui/response` itself: the worker's UI bridge deliberately emits no `dialogResolved` when a client answered, so without that the row stayed "waiting for you" forever.

#### M2-T3 notes
- 2026-09-05 claimed: host-side hydrated-view cache (LRU) serving `pi/session/entries` without a worker round trip, validated by (size, mtime).
- 2026-09-05 done. `packages/host/src/views.ts` (last 8 transcripts, validated by the file's own size+mtime so a terminal-driven session invalidates it the same way). Catalog metadata is now populated incrementally: substring-filtered line scan continuing from the last byte offset, so a growing transcript is read once. Measured on the real `~/.pi/agent/sessions`: 42 sessions, 22.7 MB, 78 ms cold, 0.36 ms warm. Per-session UI isolation verified in `packages/ui/test/runtime/isolation.test.ts` (a delta in A leaves B's view referentially identical, which is what the per-thread `useSyncExternalStore` keys on).

#### M2-T4 notes
- 2026-09-05 claimed: server-side project registry (persisted) + project-trust gate. Found: Pi's `SettingsManager.fromStorageWithPaths` defaults `projectTrusted` to **true**, and the SDK never runs the trust flow (only `main.ts`/`package-manager-cli.ts` call `resolveProjectTrusted`), so piorbit has been loading project-local settings/extensions/skills with no prompt. The host now resolves trust and passes it to the worker.
- 2026-09-05 done on the host side. `packages/host/src/projects.ts` + `trust.ts`: the list is persisted in `<stateDir>/projects.json` (default `~/.piorbit`) and the UI migrates its old localStorage list into it once. Trust resolves in the order piorbit decision → Pi's `trust.json` (nearest ancestor, read-only) → `defaultProjectTrust` → ask the clients, and the worker start is held until an answer (2 min, then declined for that run). Reading Pi's trust store but never writing it keeps `docs/architecture.md`'s "data we read" list true; a remembered answer goes into piorbit's own store and the dialog says so.
- 2026-09-05 handoff: the flag reaches the worker as `--project-trusted yes|no` but the worker does not consume it yet (that package is another lane's this session). Until the four-line patch in H-1 lands, Pi still runs every project trusted. The host side is inert-but-correct: unknown args are ignored by the worker's arg parser.

---

## M3 · Subagent tabs

| ID | Task | State | Owner | Evidence | Notes |
| --- | --- | --- | --- | --- | --- |
| M3-T1 | `subagents` module (in-process bus) | done | lane-E | `pnpm -r build && pnpm -r typecheck && pnpm -r test` — 591 tests, exit 0 (2026-09-05, wave 2 integration) | `packages/pi-extension/src/modules/subagents.ts`; capability probe with a timeout (R11), emits only through `piorbit:panel` |
| M3-T2 | Host file layer watcher | done | lane-E | `pnpm -r build && pnpm -r typecheck && pnpm -r test` — 591 tests, exit 0 (2026-09-05, wave 2 integration); 43 tests in `packages/host/test/subagents/` | `packages/host/src/subagents/{status,panels,layer}.ts`; 1 s stat-and-compare poll, not fs.watch (see the file header) |
| M3-T3 | Foreground children via transcripts | done | lane-E | `pnpm -r build && pnpm -r typecheck && pnpm -r test` — 591 tests, exit 0 (2026-09-05, wave 2 integration) | read-only cards, attributed by directory mtime; upstream patch 3 in `docs/upstream.md` fixes attribution at the source |
| M3-T4 | Control: steer/stop/resume | in-progress | lane-E | `pnpm -r build && pnpm -r typecheck && pnpm -r test` — 591 tests, exit 0 (2026-09-05, wave 2 integration); control-inbox bytes verified against the runner's format | steer/stop/interrupt are files and work for terminal-started runs; resume needs the owning session's bus and is only offered while a live module announced it |
| M3-T5 | Tab group UI | done | lane-E | `pnpm -r build && pnpm -r typecheck && pnpm -r test` — 591 tests, exit 0 (2026-09-05, wave 2 integration); 15 run-tree tests | `packages/ui/src/components/subagents/RunTabs.tsx` under the top bar; one level, breadcrumb for depth |
| M3-T6 | Workflow view | done | lane-E | `pnpm -r build && pnpm -r typecheck && pnpm -r test` — 591 tests, exit 0 (2026-09-05, wave 2 integration) | plans render as `plan` panels; phases collapsible, `inferred` marked (R3) |
| M3-T7 | Missions view | done | lane-E | `pnpm -r build && pnpm -r typecheck && pnpm -r test` — 591 tests, exit 0 (2026-09-05, wave 2 integration) | `packages/host/src/subagents/missions.ts` → collection + document panels; `piorbit missions` |
| M3-T8 | Acceptance + watchdog chips | done | lane-E | `pnpm -r build && pnpm -r typecheck && pnpm -r test` — 591 tests, exit 0 (2026-09-05, wave 2 integration) | acceptance and watchdog become `collection` panels (`checksPanel`) |
| M3-T9 | Upstream PRs | todo | — | — | four patches written out in `docs/upstream.md`; none filed |

---

## M4 · Settings and logs

| ID | Task | State | Owner | Evidence | Notes |
| --- | --- | --- | --- | --- | --- |
| M4-T1 | Settings adapter | done | claude-2026-09-05-c | `pnpm -r build && pnpm -r typecheck && pnpm -r test` (385 tests) at `958bfb1` | worker SettingsAdapter over SettingsManager; all 51 top-level keys; writes under Pi lock then reload |
| M4-T2 | Settings UI | done | claude-2026-09-05-c | `pnpm -r build && pnpm -r typecheck && pnpm -r test` (385 tests) at `958bfb1` | schema-driven settings screen: global/project/effective, search, JSON escape hatch |
| M4-T3 | Package manager UI | done | claude-2026-09-05-c | `pnpm -r build && pnpm -r typecheck && pnpm -r test` (385 tests) at `958bfb1` | PackagesAdapter over DefaultPackageManager with progress notifications |
| M4-T4 | Providers and models | done | claude-2026-09-05-c | `pnpm -r build && pnpm -r typecheck && pnpm -r test` (385 tests) at `958bfb1` | ModelsAdapter: provider auth, catalog, thinking levels |
| M4-T5 | Log store | done | claude-2026-09-05-c | `pnpm -r build && pnpm -r typecheck && pnpm -r test` (385 tests) at `958bfb1` | SQLite log store (node:sqlite): content-addressed payloads, byte-budgeted paging, retention; Authorization/API-key headers redacted incl. vendor prefixes |
| M4-T6 | Logs page | done | claude-2026-09-05-c, integrator | `pnpm -r build && pnpm -r typecheck && pnpm -r test` (385 tests) at `958bfb1`; `pnpm -r build && pnpm -r typecheck && pnpm -r test` — 591 tests, exit 0 (2026-09-05, wave 2 integration); 6 tests in `packages/ui/test/panels/logs.test.ts` | logs screen: section tabs, search, follow, virtualized list, detail with copy; provider-response ceiling stated. Wave 2: "Watch" sends a section to the dock as a `stream` island (`src/panels/logs.ts`), so live host output is the same island an extension gets |
| M4-T7 | Keybindings + trust views | todo | — | — | keybindings/trust views not built in wave 1 |

---

## M5 · Desktop shell

| ID | Task | State | Owner | Evidence | Notes |
| --- | --- | --- | --- | --- | --- |
| M5-T1 | Electron main | done | lane-B | `pnpm -r build && pnpm -r typecheck && pnpm -r test` — 591 tests, exit 0 (2026-09-05, wave 2 integration); headless Electron 44.2.0 boot on this machine | `packages/desktop/src/main.ts`; single-instance lock, deep links, tray, window state |
| M5-T2 | Bundled runtime outside asar | done | lane-B | `/proc/<host pid>/exe` = `runtime/linux-x64/node` (v24.20.0) | Node pinned in `packages/desktop/runtime.json` with official SHA-256s; `scripts/fetch-node.mjs --verify` refuses an Electron runtime |
| M5-T3 | Keychain | done | lane-B | root identity read back from the system keyring across a restart | `@napi-rs/keyring`; reported 0600 fallback (`identity().degraded`) |
| M5-T4 | Notifications + mic permission | in-progress | lane-B | `pnpm -r build && pnpm -r typecheck && pnpm -r test` — 591 tests, exit 0 (2026-09-05, wave 2 integration); 30 desktop tests | gates and copy written; macOS TCC and real banners need the platform |
| M5-T5 | Packaging, signing, updates | in-progress | lane-B | `packages/desktop/electron-builder.yml` + `README.md` | no signing possible here; Azure fields are `CHANGE-ME`; needs per-platform agents |

---

## M6 · Relay and pairing

| ID | Task | State | Owner | Evidence | Notes |
| --- | --- | --- | --- | --- | --- |
| M6-T1 | Noise IK/KK crypto | done | claude-2026-09-05-c | `pnpm -r build && pnpm -r typecheck && pnpm -r test` (385 tests) at `958bfb1` | Noise IK/KK 25519_AESGCM_SHA256, prologue + AAD binding, rekey; 42 crypto tests incl. KATs |
| M6-T2 | Pairing flow | done | claude-2026-09-05-c | `pnpm -r build && pnpm -r typecheck && pnpm -r test` (385 tests) at `958bfb1` | QR with ephemeral key in fragment; HKDF channel id; SAS gate before grant |
| M6-T3 | Device list + revocation | done | claude-2026-09-05-c | `pnpm -r build && pnpm -r typecheck && pnpm -r test` (385 tests) at `958bfb1` | root Ed25519 signs versioned device list; downgrade refused |
| M6-T4 | Relay server | done | claude-2026-09-05-c | `pnpm -r build && pnpm -r typecheck && pnpm -r test` (385 tests) at `958bfb1` | relay byte forwarder, no crypto lib (purity test), channel id via Sec-WebSocket-Protocol not the path, 2 sockets/channel, cookies, padded buckets, no deflate |
| M6-T5 | Host relay client | done | claude-2026-09-05-c | `pnpm -r build && pnpm -r typecheck && pnpm -r test` (385 tests) at `958bfb1` | host RelayClient: outbound, reconnect, resume from seq |
| M6-T6 | Keystroke timing defense | done | claude-2026-09-05-c | `pnpm -r build && pnpm -r typecheck && pnpm -r test` (385 tests) at `958bfb1` | 20 ms send grid + chaff tail in crypto/timing |
| M6-T7 | Threat model doc | done | claude-2026-09-05-c | `pnpm -r build && pnpm -r typecheck && pnpm -r test` (385 tests) at `958bfb1` | docs/security.md with threat model and residual metadata |

---

## M7 · Mobile PWA

| ID | Task | State | Owner | Evidence | Notes |
| --- | --- | --- | --- | --- | --- |
| M7-T1 | Manifest, SW, secure context | done | lane-C | `pnpm -r build && pnpm -r typecheck && pnpm -r test` — 591 tests, exit 0 (2026-09-05, wave 2 integration); `/sw.js` and `/manifest.webmanifest` served by the sandbox host | `packages/ui/public/` + `src/pwa/{sw,vite-plugin}.ts`; the worker imports nothing and the plugin refuses to emit one that does |
| M7-T2 | Layout + keyboard inset | done | lane-C | `pnpm -r build && pnpm -r typecheck && pnpm -r test` — 591 tests, exit 0 (2026-09-05, wave 2 integration) | `--kb` from visualViewport, re-measured on pageshow/visibilitychange; sheets bounded by `--vvh` |
| M7-T3 | Reconnect + resume | done | lane-C, integrator | `pnpm -r build && pnpm -r typecheck && pnpm -r test` — 591 tests, exit 0 (2026-09-05, wave 2 integration) | `HostClient.reconnect(reason)` detaches the dead socket before closing, so its late `close` cannot reject the new socket's requests |
| M7-T4 | Approval UI | done | lane-C, integrator | `pnpm -r build && pnpm -r typecheck && pnpm -r test` — 591 tests, exit 0 (2026-09-05, wave 2 integration); answered in a browser against the sandbox | one decision surface on every width (`PanelDecisionCards`), touch-sized on a coarse pointer, mode-changing options marked |
| M7-T5 | Push | in-progress | lane-C, integrator | `pnpm -F @piorbit/host test` → `test/push.test.ts` (RFC 8291 round trip, VAPID verify, 410 eviction); `pi/push/config` answered live with a generated key | `packages/host/src/push.ts`; `HostRelayOptions.publicOrigin` is what makes the links work off this machine, and nothing sets it yet |
| M7-T6 | Mobile mic | in-progress | lane-C, lane-D, integrator | `pnpm -r build && pnpm -r typecheck && pnpm -r test` — 591 tests, exit 0 (2026-09-05, wave 2 integration); `pi/transcribe/status` answers with a reason live | end to end in code (browser → host router → worker `TranscribeService`); no device and no API key here, so no phrase has been transcribed |

---

## M8 · Package support

| ID | Task | State | Owner | Evidence | Notes |
| --- | --- | --- | --- | --- | --- |
| M8-T1 | Capability detection | done | lane-D, integrator | `pnpm -r build && pnpm -r typecheck && pnpm -r test` — 591 tests, exit 0 (2026-09-05, wave 2 integration) | `piorbit/capabilities` → `SessionView.capabilities`; the microphone is hidden, not disabled, where the package is absent (R2) |
| M8-T2 | `transcribe` module + desktop path | in-progress | lane-D, integrator | `pnpm -r build && pnpm -r typecheck && pnpm -r test` — 591 tests, exit 0 (2026-09-05, wave 2 integration); 21 transcribe tests | worker service, routing and composer are wired; this machine has only OAuth providers, so `status` correctly refuses by name |
| M8-T3 | Native markdown preview + image display | done | lane-D, integrator | `pnpm -r build && pnpm -r typecheck && pnpm -r test` — 591 tests, exit 0 (2026-09-05, wave 2 integration); markdown rendered in a dock island in a browser | `packages/ui/src/components/preview/**` is the one document renderer; the panel body delegates to it |
| M8-T4 | `web-access` module | done | lane-D | `pnpm -r build && pnpm -r typecheck && pnpm -r test` — 591 tests, exit 0 (2026-09-05, wave 2 integration) | search / fetch / source-check → `collection` panels |
| M8-T5 | Module authoring guide | done | lane-D | `docs/pi-extension-modules.md` | — |

---

## M9 · CLI

| ID | Task | State | Owner | Evidence | Notes |
| --- | --- | --- | --- | --- | --- |
| M9-T1 | `packages/cli`, `piorbit` bin, router, `--json`, help, colors | done | claude-2026-09-05-c | `pnpm -r build && pnpm -r typecheck && pnpm -r test` (385 tests) at `958bfb1` | hand-rolled parser on util.parseArgs; color degrades off-TTY and under NO_COLOR |
| M9-T2 | `up`/`down`/`status`/`restart` host lifecycle | done | claude-2026-09-05-c | `pnpm -r build && pnpm -r typecheck && pnpm -r test` (385 tests) at `958bfb1` | pidfile + port file under the state dir; attaches if already running; boot-id + start-time identity |
| M9-T3 | `piorbit pi …` passthrough to the pinned Pi | done | claude-2026-09-05-c | `pnpm -r build && pnpm -r typecheck && pnpm -r test` (385 tests) at `958bfb1` | inherits stdio, forwards exit codes and signals, sets PI_CODING_AGENT_DIR / PI_SUBAGENTS_TEMP_ROOT; `--global-pi` opts into the user's install |
| M9-T4 | session verbs over the host protocol | done | claude-2026-09-05-c | `pnpm -r build && pnpm -r typecheck && pnpm -r test` (385 tests) at `958bfb1` | sessions/new/open/send/tail/stop/entries/fork/rename/compact; `tail` streams updates and exits on agent_settled unless --follow |
| M9-T5 | `projects` / `packages` / `settings` verbs | in-progress | claude-2026-09-05-c | protocol methods exist (`pi/settings/*`, `pi/packages/*`); `projects` built | settings and packages CLI verbs not yet wired |
| M9-T6 | `doctor` | done | claude-2026-09-05-c | `pnpm -r build && pnpm -r typecheck && pnpm -r test` (385 tests) at `958bfb1`; run on this machine: 12 PASS, 1 WARN (uid-0 subagents root) | spawns a throwaway worker to prove the stack boots |
| M9-T7 | `relay login\|pair\|devices\|revoke`, `logs --follow` | todo | — | — | protocol ready (`pi/logs/query` with afterId; crypto pairing API) |
| M9-T8 | completions + `help <topic>` | todo | — | — | — |

---

## MP · Panel system

| ID | Task | State | Owner | Evidence | Notes |
| --- | --- | --- | --- | --- | --- |
| MP-T1 | Protocol: payloads, bus events, `pi/panel/*` | done | lane-P | `pnpm -r build && pnpm -r typecheck && pnpm -r test` — 591 tests, exit 0 (2026-09-05, wave 2 integration); 9 tests in `packages/protocol/test/panels.test.ts` | `packages/protocol/src/panels.ts`; `validatePanelEvent` names the presentation key it refused |
| MP-T2 | Companion `panels` module | done | lane-P, integrator | `pnpm -r build && pnpm -r typecheck && pnpm -r test` — 591 tests, exit 0 (2026-09-05, wave 2 integration) | dedupes identical re-emits (R9); a module claims an id namespace (`PanelClaims`) so an action for a panel the *host* discovered still reaches it |
| MP-T3 | Host panel hub | done | lane-P, integrator | `pnpm -r build && pnpm -r typecheck && pnpm -r test` — 591 tests, exit 0 (2026-09-05, wave 2 integration); live: five kinds through `pi/panel/list`, a blocking decision raised `waiting_for_input`, `pi/panel/read` refused `file:/etc/passwd` | `packages/host/src/panels/{store,refs,hub}.ts`, wired in `server.ts` and `router.ts` |
| MP-T4 | The island | done | lane-P, integrator | `pnpm -r build && pnpm -r typecheck && pnpm -r test` — 591 tests, exit 0 (2026-09-05, wave 2 integration); browser: three expansions, LRU shrink, morph, both themes | `packages/ui/src/panels/islands/**`; narrow islands drop pop-out and maximize into the menu rather than the title (R13) |
| MP-T5 | The dock | done | lane-P, integrator | `pnpm -r build && pnpm -r typecheck && pnpm -r test` — 591 tests, exit 0 (2026-09-05, wave 2 integration); 11 dock tests; browser at 1860px: two columns, four panels, none narrow | D-25 fixed the two-column rule; `packages/ui/src/components/dock/Dock.tsx` |
| MP-T6 | Placement, ambient, phone islands, decision surfaces | done | lane-P, integrator | `pnpm -r build && pnpm -r typecheck && pnpm -r test` — 591 tests, exit 0 (2026-09-05, wave 2 integration); 4 placement tests | one decision surface on every width (D-24); the fleet pill opens the fleet sheet |
| MP-T7 | Fallback | done | lane-P | `pnpm -r build && pnpm -r typecheck && pnpm -r test` — 591 tests, exit 0 (2026-09-05, wave 2 integration); 3 fallback tests | `packages/ui/src/panels/fallback.ts`; the telemetry rail's extension section is gone, and widgets are islands |

---

## MX · Cross-cutting

| ID | Task | State | Owner | Evidence | Notes |
| --- | --- | --- | --- | --- | --- |
| MX-T1 | Migration readiness | in-progress | claude-2026-09-05-a | `packages/worker/src/drivers/chord.ts`; seam test green (M0-T5) | ongoing: log each Pi release in `docs/pi-releases.md` |
| MX-T2 | Pi pin bumps | todo | — | — | current pin 0.85.0 |
| MX-T3 | Upstream log | todo | — | — | `docs/upstream.md` created empty |
| MX-T4 | Security review | todo | — | — | before M6 ships |
| MX-T5 | Accessibility pass | todo | — | — | — |
| MX-T6 | Element inventory reconciliation | todo | — | — | `docs/ux-elements.md` became binding (`b888960`, `239d93f`) after the wave-2 lanes had written their components, so most panel bodies, the dock and the run tabs were hand-rolled against a rule that did not exist yet. Nothing was rebuilt at integration time: swapping a working, verified surface for a registry element is a design pass, not a merge. Walk the inventory row by row. |

---

#### Wave 2 integration notes (2026-09-05, claude-2026-09-05-integrator)
- Six lanes (panels, desktop, mobile, packages, transcript polish, subagents) were merged into one protocol and one shell. Every REQUEST in the six lane reports was applied, except where two lanes had solved the same thing twice — see D-23, D-24, D-25, D-26 for what was kept and why.
- One protocol vocabulary: `pi/panel/*` (lane P), `pi/push/*` and `pi/transcribe/*` (lanes C and D, reconciled onto the worker-owned dictation service), `pi/project/git` (lane F). Every method has a zod schema and a sample, which the completeness test enforces.
- The push payload moved from `packages/ui/src/pwa/push-payload.ts` into `packages/protocol/src/push.ts`, so the host that sends it and the page that reads it share one definition. The service worker restates the shape because `/sw.js` is emitted as one standalone file; the build refuses to emit a worker whose `DECLARATIVE_WEB_PUSH_VERSION` disagrees with the protocol's.
- Bespoke rendering removed: `HostUiCards.tsx` and `DialogBody.tsx` (dialogs are decision panels everywhere, including inside a tool row), the telemetry rail's extension section (widgets are dock islands, statuses are status-line entries), and `panels/islands/Markdown.tsx` (the preview package is the one document renderer, so `react-markdown` left the dependency list).
- Legibility floor enforced mechanically: `text-2xs` (11px) and `text-[11px]` are gone from every component, `--text-2xs` is now consumed only by the `eyebrow` utility, and the ANSI palette moved into `globals.css` as `--ansi-0…15`. `test/design-system.test.ts` fails the build if either rule is broken again — checked by breaking it on purpose and watching both guards fire.
- Two real defects found in the browser and fixed: the two-column dock rule (D-25) and a run island whose state line ran under its elapsed time in a narrow dock. A third, "the first session click after a reload does nothing", turned out to be a coordinate-scaling artefact of the test harness — but it exposed that `SessionsPanel` swallowed `openSession` failures entirely, so that click now reports, and `HostClient.whenConnected` keeps a click made during the socket's first second from being dropped.
- The sandbox (`scripts/sandbox.mjs`) now records itself the way `piorbit up` does, so the CLI can be pointed at it, and seeds one panel of every kind. Pre-existing limitation found while doing that: Pi 0.85 builds a session's extension set from its package manager, so the sandbox's demo extension in `<agentDir>/extensions/` was never loaded by any lane — the demo panels are seeded through the host's own hub instead, and say `source: "sandbox"` so nobody mistakes them for an extension that ran.

---

## Handoffs

### H-1 · M2-T4 · 2026-09-05 · claude-2026-09-05-laneA
State of the work: the host resolves project trust and passes it to the worker as
`--project-trusted yes|no` (`packages/host/src/worker-client.ts`). The worker
ignores the flag, so Pi still runs with `projectTrusted: true` (its default).
Uncommitted: yes (host, protocol, ui).
What is missing: four edits in `packages/worker` (owned by another lane this
session), listed in the lane report:
1. `src/driver.ts` — `projectTrusted?: boolean` on `DriverOpenOptions`.
2. `src/main.ts` — parse `--project-trusted`, pass it to `WorkerServer`.
3. `src/server.ts` — carry it through `commonOpen()`.
4. `src/drivers/stable-sdk.ts` — build `SettingsManager.create(cwd, agentDir,
   { projectTrusted })` and hand it to `createAgentSessionServices`; a cwd other
   than the one the host decided about is untrusted.
Do not: write `~/.pi/agent/trust.json` from the host. It has Pi's own lock
protocol (`withTrustFileLock`) and the host must not become a second writer.
Mirroring a remembered decision into it belongs in the worker (which may import
Pi) as a follow-up task.

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

### D-18 · 2026-09-05 · The panel contract is decided, all leans accepted
Decision: `docs/ux-panels.md` is binding. Pi owns the logic, piorbit owns the
experience. Six closed kinds (run, plan, document, stream, collection,
decision); metrics live in the telemetry rail and embeds are out of scope.
Four surfaces (ambient, inline, dock, sheet) with a placement table piorbit
owns; the extension declares kind + intent only. Panels are islands that
morph through minimal / compact / expanded / maximized with continuous
identity; at most two expanded; a third shrinks the least recently watched
to minimal — nothing is parked. No auto-open except a decision that blocks
the turn. The declared `piorbit:panel` protocol ships in v1 and is used for
our own pi-subagents adapter. The fallback (widget lines → stream, status →
ambient, dialogs → decision) is the floor. Minimal islands wrap horizontally
before ever scrolling. Maximize is full takeover with Esc to return.
Legibility floor: no data below 12px, fixed content budget per size,
truncate never scale, nothing overflows, 44px touch targets.
Why: stress-tested against pi-subagents (nicobailon and tintinweb),
pi-background-tasks and feynman; the four disagree exactly where a
single-implementation design would have been wrong. Adapters carry
references and generic shapes, never domain values (R12a).
Consequences: the panel system is a prerequisite for M3, for M4's logs page
(stream), M8's previews (document) and every extension dialog (decision).
Supersedes: the chip-bar / eviction model in the first draft.

### D-19 · 2026-09-05 · Runs, plans and ledgers decided, all leans accepted
Decision: `docs/ux-agent-work.md` is binding. Background children appear
only inside their parent and in the fleet sheet, never in the session list.
An orphaned background run lives in the fleet sheet with its project ring
lit; opening it reopens the parent read-only. No full-screen fleet board.
Scheduled runs deferred. The CLI uses the same nouns (`piorbit runs`,
`piorbit plan`, `piorbit missions`). Foreground children ship read-only and
the upstream index patch is written to `docs/upstream.md`.
Consequences: unblocks M3.

### D-20 · 2026-09-05 · Seven amendments from Claude Code's desktop UI
Decision: the user shared Claude Code's desktop as inspiration; judged against
our decisions, it does seven things better and each is adopted.
1. The dock grows with the window: resizable, and two columns of two expanded
   islands past ~640px dock width or a 1600px window. The rule stays "two
   per column".
2. Every expanded island can pop out to its own window (desktop) or tab (web);
   header controls in a fixed order: pop out, maximize, close.
3. Plans render by island size: in the dock, vertical collapsible phases with
   done/total and a row of step squares, expanding to a table of name, model,
   tokens, time, check; columns only when maximized.
4. Consecutive tool calls collapse into one summary row ("Ran 2 commands")
   that expands to the individual rows.
5. The ambient surface moves from the top bar to a status line directly above
   the composer, on every width, so it is in the same place on phone and
   desktop and next to where you type.
6. The sessions panel lists every project as collapsible, attention-sorted
   groups in one scrolling list; the rail jumps to and filters a group rather
   than replacing the list. Quick navigation across projects never requires
   switching first.
7. A project line under the composer: git branch, +added −removed since the
   session started, Create PR when ahead. New task M2-T6.
Not adopted: an embedded browser pane (embeds are out of scope, D-18) and a
four-pane dock on a laptop-width window (theirs was 1860px wide).

### D-21 · 2026-09-05 · Relay channel id travels in the WebSocket subprotocol
Decision: the channel id is sent as `Sec-WebSocket-Protocol: piorbit.channel.<id>` and the path is a constant `/ws`, instead of the id in the request line.
Why: request lines land in proxy and edge access logs; subprotocols do not, and a subprotocol is also the only channel a browser client can set. The relay still treats the value as an opaque route (invariant 7).
Consequences: epoch rotation and squatter eviction for a disclosed id are design work, deferred and stated as such in docs/security.md.

### D-22 · 2026-09-05 · Wave-1 deferrals recorded honestly
- Notifications over ~61 kB are dropped with a counter rather than chunked; a relayed phone misses large tool outputs but never the session. Chunking is a follow-up task.
- The host WebSocket has an Origin allowlist but no token; any local process can drive the agent. Token in host.json is a follow-up task.
- No wave-1 UI was seen rendered by its authors; the orchestrator's browser pass is the only visual check so far.

### D-23 · 2026-09-05 · piorbit reimplements dictation rather than driving pi-gpt-transcribe
Decision: `packages/worker/src/transcribe.ts` owns dictation. pi-gpt-transcribe's `config.json`, its `WidgetState` and its pre-send behaviour are kept as contracts; the implementation is ours.
Why: the package is a terminal program — it opens the microphone inside the Pi process, ships a TUI component and calls `pasteToEditor`. None of that reaches a browser, and the microphone that matters is the one in the phone.
Consequences: the non-tui patch in `docs/upstream.md` is a courtesy, not a dependency. The browser records, the host routes by upload id, the worker transcribes, and Pi's `input` hook folds in a phrase still in flight.

### D-24 · 2026-09-05 · One decision surface, on every width
Decision: a question that blocks the turn renders as a card above the composer on every width (`panels/DecisionSurfaces.tsx` → `DecisionBody`), with larger controls on a coarse pointer. The phone-only pill-and-sheet island built in wave 2 was dropped, and its one-hand ergonomics moved into that one body.
Why: two lanes built a decision surface. The placement table already answers where a decision goes — tool row, card, or sheet when it blocks everything — and a second phone-only surface meant two components, two mappings from Pi's dialogs, and two places for "No" to stop being a dead end.
Consequences: `components/mobile/DecisionIsland.tsx` and `pwa/decision.ts`'s duplicate mapping are gone; `isModeChangingOption` survives in `panels/decision.ts`. The notification deep link (`?decision=…&answer=allow|deny`) now drives the card.
Supersedes: nothing; it resolves an overlap between two wave-2 lanes.

### D-25 · 2026-09-05 · Two dock columns follow the dock's width, never the window's
Decision: `columnsFor` splits the dock into two columns at 640px **of dock**. A window of 1600px and up makes the dock *open* wider (`defaultDockWidth`), which is what D-20 meant by "the dock grows with the window".
Why: the original rule split on either, so a 1860px window with a 384px dock produced two 180px columns — narrower than one column at any width, with island titles truncated to a single character. That is R13 inverted.
Consequences: a person who drags the dock narrow keeps one column; a wide monitor still gets four expanded panels without any of them getting narrow. Seen working at 1860px.

### D-27 · 2026-09-05 · The panel system is its own milestone, MP
Decision: `PLAN.md` gains `MP · Panel system` (MP-T1…MP-T7), placed before M3 in the milestone map.
Why: D-18 said the panel system becomes "a prerequisite lane in wave 2" but left it with no ID, so seven tasks' worth of work had nowhere to be recorded and M3, M4-T6 and M8-T3 all depend on it. AGENTS.md §3.7 allows adding a milestone at the end with a decision; this is that decision.
Consequences: no existing ID moved. The map shows MP between M1 and M3.

### D-28 · 2026-09-05 · A plan's phase index is 1-based, and the schema enforces it
Decision: `RunPanel.phase.index` counts from 1. `docs/ux-panels.md`, `packages/protocol/src/panels.ts` and the zod schema all say so, and the schema rejects `0`.
Why: the host emitted 1-based and both UI consumers added another 1, so a three-phase run displayed "4/3". A stepper that can read past its own total is a contract that never said which end it counted from.
Consequences: breaking for any producer that sent 0-based. Nothing outside this repo produces panels yet.

### D-29 · 2026-09-05 · Close shrinks a live island; only its producer can remove it
Decision: Close on a running panel collapses it to a minimal pill. A panel leaves the dock only when the thing that made it closes it.
Why: R7. Dismissing a run from the dock does not stop the run, so removing the island hides work that is still happening, and the person has no way back to it.
Consequences: the dock cannot be emptied of live work by hand. The pill is the floor, and it stays legible.

### D-30 · 2026-09-05 · The in-process bus stands down for multi-child completions
Decision: when pi-subagents' `subagent:async-complete` covers more than one child, the companion module emits nothing and lets the file layer own those panels.
Why: that event fires per run and carries no child identity, so synthesising a child id from the array position mints a panel the file layer will never match. A phantom island costs more than the second of latency the bus was buying.
Consequences: multi-child runs surface a beat later, through the file layer. If pi-subagents ever puts a `childId` on `results[]`, the fast path returns.

### D-31 · 2026-09-05 · No update feed until there is a public one
Decision: `publish: null` in electron-builder, stated explicitly rather than inferred, and the updater reports `unsupported` with a reason.
Why: the repo is private, so a GitHub release feed cannot be read by an installed app. An updater that retries a feed it can never reach reports a permanent error for a condition that is not an error.
Consequences: M10-T7 must choose a real feed. Until then the app says updates are unavailable and why, which is true.

### D-32 · 2026-09-05 · The worker imports pi-gpt-transcribe's config parser rather than owning a second one
Decision: `packages/worker/src/transcribe.ts` reads the dictation config through `pi-gpt-transcribe/core`, pinned to the tag `v0.4.0`. `WidgetState` is the package's `DictationState`. The transport stays ours: the injectable fetch and the `no_key` / `oauth_key` / `audio_rejected` taxonomy are piorbit's, not a copy of anything.
Why: D-23 kept the package as the configuration source but re-derived the parser here, and a second parser for someone else's file format drifts without failing. A key added on that side still parses here, it just stops meaning anything.
Consequences: the package gained a terminal-free entry point to make this possible (0.3.0), made its native audio bindings optional (0.3.1), and stopped hardcoding the WAV container so the browser's Opus can be sent as it is (0.4.0). The desktop build excludes `decibri`, which nothing on this side can reach. Pinned by git tag because the package is not on npm.

### D-26 · 2026-09-05 · The host's log sections are `stream` panels too
Decision: the logs page keeps search and paging; "Watch" sends one section to the dock as a client-local `stream` island fed from `pi/logs/append` (`packages/ui/src/panels/logs.ts`).
Why: the contract's reach is the point — the provider log and a package's `setWidget` output should be the same island. Rebuilding the logs page out of panels would have thrown away virtualization, search and paging for nothing.
Consequences: the buffer is bounded (2000 lines per section) and client-local; it is a tail to watch, not a second logs page.

---

## Open questions

| ID | Question | Blocks | Asked of |
| --- | --- | --- | --- |
| Q-1 | What will Pi's experimental server become? | — | answered by D-14: not blocking, monitor via MX-T1 |
| Q-2 | UI framework? | — | answered by D-15: React + Vite |
| Q-3 | Which Pi release to pin next, and cadence of MX-T2 bumps. | MX-T2 | agent decides per release (D-16); default: bump when a release fixes something we hit or adds an SDK capability we need |
| Q-4 | Panel contract (7 questions in docs/ux-panels.md) | M3, M4-T6, M8 | answered by D-18: all leans |
| Q-5 | Agent-work model (6 questions in docs/ux-agent-work.md) | M3 | answered by D-19: all leans |

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
- 2026-09-05 · claude-2026-09-05-b · M0-T8: `workflow` scope granted and `.github/workflows/ci.yml` installed, but the first run was refused by GitHub billing (private repos bill Actions minutes). Added `pnpm verify` as the local equivalent. Blocked on the user's GitHub billing, not on code.
- 2026-09-05 · claude-2026-09-05-b · D-18 and D-19: panel contract and agent-work model decided (all leans). M3 unblocked; the panel system becomes a prerequisite lane in wave 2.
- 2026-09-05 · claude-2026-09-05-b · D-20: seven amendments adopted from Claude Code's desktop UI; M2-T6 added; docs updated.
- 2026-09-05 · claude-2026-09-05-c · wave 1 landed (`7841860`, `958bfb1`): M2-T1..T4, M4-T1..T6, M6-T1..T7, M9-T1..T4, M9-T6 done; 39 review findings applied (37 already in HEAD, 2 real fixes + protocol sample); D-21, D-22. 385 tests green.
- 2026-09-05 · claude-2026-09-05-c · wave 2 landed: MP (panel system) complete, M5 desktop shell, M7 mobile PWA, M8 packages, M3 subagent tabs, D-20 transcript polish. 40 review findings applied across three lenses (panel contract, platform, design), 1 deferred. D-28..D-31. 599 tests green across 69 files.
- 2026-09-05 · claude-2026-09-05-c · M10 (self-contained distribution) and M11 (theme system) added to PLAN.md; `docs/ux-theme.md` written and binding; AGENTS.md gains the no-static-visual-values rule and the never-needs-a-terminal rule.
- 2026-09-05 · claude-2026-09-05-c · pi-gpt-transcribe 0.3.0/0.3.1/0.4.0 released (the user maintains it); worker pinned to v0.4.0 and now imports the config parser instead of duplicating it. D-32. 599 tests green.
