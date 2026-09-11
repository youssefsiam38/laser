# STATUS_DETAILED.md — task ledger

Format and rules: `AGENTS.md` §3. States: `todo`, `in-progress`, `blocked`,
`done`, `dropped`. Evidence is a commit hash, a passing test command, or a file
path. Dates in notes are history, not plans. Never delete rows or notes.

---

## M0 · Foundation

| ID | Task | State | Owner | Evidence | Notes |
| --- | --- | --- | --- | --- | --- |
| M0-T1 | Workspace scaffold | done | claude-2026-09-05-a | `ELECTRON_SKIP_BINARY_DOWNLOAD=1 pnpm install && pnpm -r build && pnpm -r test` passes (2026-09-05) | see notes |
| M0-T2 | `@lasercode/protocol` schemas + envelope + seq | done | claude-2026-09-05-a | `pnpm -F @lasercode/protocol test` → `test/schemas.test.ts` (every method round-trips; error codes) + `test/jsonrpc.test.ts` | see notes |
| M0-T3 | `SessionDriver` interface + `DriverEvent` | done | claude-2026-09-05-a | `packages/worker/src/driver.ts`; exercised by `test/stable-sdk.*.test.ts` | see notes |
| M0-T4 | `StableSdkDriver` | done | claude-2026-09-05-a | `pnpm -F @lasercode/worker test` → `test/stable-sdk.prompt.test.ts` (stub provider, ordered updates) + `test/stable-sdk.open.test.ts` + `test/map-event.test.ts` | see notes |
| M0-T5 | `ChordDriver` stub + seam test | done | claude-2026-09-05-a | `pnpm -F @lasercode/worker test` → `test/seam.test.ts` 3 passed | see notes |
| M0-T6 | Worker process entry + transport | done | claude-2026-09-05-a | `test/server.test.ts` (dispatch, seq, replay, dialogs, errors) + `test/spawn.test.ts` (real process over fd 3) | see notes |
| M0-T7 | Extension UI bridge | done | claude-2026-09-05-a | `test/ui-bridge.test.ts` (select/confirm/input/editor round-trip, timeout, custom() resolves, unknown members no-op, dispose settles) | see notes |
| M0-T8 | CI | done | codex-2026-09-06-release | [GitHub Actions run 34006391926](https://github.com/youssefsiam38/laser/actions/runs/34006391926): build, typecheck, tests and installer verification all passed | Making the repository public removed the private-minute billing block. Clean-runner assumptions in the desktop tests and workflow were fixed and proved on GitHub's Ubuntu runner. |

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
- 2026-09-05 implemented on `createAgentSessionRuntime` + `createAgentSessionServices({ resourceLoaderOptions: { extensionFactories: [laser] } })`; `bindExtensions({ mode: "rpc", uiContext })`; event mapping in `mapEvent()`.
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
| M1-T1 | Host: worker supervision + local WS | done | claude-2026-09-05-a | `pnpm -F @lasercode/host test` → `test/host.e2e.test.ts` (WS client → host → spawned worker → Pi → stub provider; resume from seq; one worker per cwd) | see notes |
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
- 2026-09-05 host resolves the worker entry via `createRequire().resolve("@lasercode/worker/main")` — a dependency for path resolution only, no code import, seam intact.
- 2026-09-05 known gaps for later tasks: notifications broadcast to all clients (per-session subscription is M2-T3); no auth on the local socket (loopback; relay auth is M6).

#### M1-T3 notes
- 2026-09-05 React 19 + Vite. `HostClient` (JSON-RPC over WS, reconnect with backoff, per-session seq tracking, `session/load { fromSeq }` on reconnect, `visibilitychange` reconnect). `store.ts` is a pure reducer (tested). Layout: sidebar (projects → sessions, new session by cwd), top bar (model picker, thinking level, context %), transcript, composer, dialogs, toasts. Mobile: sidebar becomes a drawer under 800px; safe-area insets; `--kb` inset variable reserved for M7-T2.
- 2026-09-05 `scripts/sandbox.mjs` (`pnpm sandbox`) gives any agent a demo: temp Pi dirs, fake streaming provider, a dialog-test extension, host with the built UI on 41441. `.claude/launch.json` config `sandbox`.
- 2026-09-05 host resolves the UI bundle via `@lasercode/ui/package.json` (dependency for path resolution only).

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
| M2-T1 | Worker pool | done | codex-2026-09-10-stale-session | host router 22 + worker-pool 10; host typecheck/build | saved sessions reopen before actions; retired unsaved paths are refused without recreation |
| M2-T2 | Attention model + inbox | done | claude-2026-09-05-c | `pnpm -r build && pnpm -r typecheck && pnpm -r test` (385 tests) at `958bfb1` | host attention model, persisted seen watermark, inbox |
| M2-T3 | Fast switching | done | claude-2026-09-05-c | `pnpm -r build && pnpm -r typecheck && pnpm -r test` (385 tests) at `958bfb1` | hydrated-view cache in host; per-path selectors verified |
| M2-T4 | Project management + trust | done | claude-2026-09-05-c | `pnpm -r build && pnpm -r typecheck && pnpm -r test` (385 tests) at `958bfb1` | server-side projects with Pi trust gate passed through as a dialog |
| M2-T5 | Desktop notifications | in-progress | lane-B | `pnpm -r build && pnpm -r typecheck && pnpm -r test` — 591 tests, exit 0 (2026-09-05, wave 2 integration) | tray + edge-gated notifications written (`packages/desktop/src/notifications.ts`); never fired on a real desktop session here |
| M2-T6 | Status line, project line, tool groups | done | lane-F | `pnpm -r build && pnpm -r typecheck && pnpm -r test` — 591 tests, exit 0 (2026-09-05, wave 2 integration); `pnpm -F @lasercode/worker test -- git`, `pnpm -F @lasercode/ui test -- thread` | D-20 §4/§5/§6: consecutive tool calls collapse; one status line above the composer; git branch and `+a −r` since the session opened, with Create PR |

#### M2-T1 notes
- 2026-09-05 claimed: rewrite `worker-pool.ts` with lifecycle states (starting/ready/crashed/retired), backoff restart, idle retire gated on attached clients + live pi-subagents runs, duplicate-cwd refusal.
- 2026-09-05 done. `pi/worker/status` now carries a `WorkerInfo` (pid, restarts, since, retryAt, canRestart, reopened); the pool emits `starting` itself (it never did) and re-emits the worker's own `ready`/`retired` enriched. Crash → exponential backoff (1s doubling, 30s cap, 5 attempts) and the sessions that were open are re-loaded, which the UI adopts through the existing seq-epoch resync. The crash counter resets only after 60s of healthy uptime, so a crash loop still reaches the cap instead of restarting forever. Retirement requires: idle 10 min, no attached client, no running agent, and no live pi-subagents run — the last read from each run's `status.json` + `process.kill(pid, 0)`, never `lastUpdate` (findings.md reaping hazard); an unreadable temp root counts as "work in flight".
- 2026-09-10 claimed: reproduce the reported stale empty session after idle retirement; make host routing load saved transcripts before forwarding actions and refuse an unsaved retired path before the engine can recreate it under the wrong filename.
- 2026-09-10 checkpoint: `openSessions` now reports only a live ready worker, path-routed actions recover a saved transcript before forwarding, and a retired path with no file gets a person-facing SessionNotFound before any worker starts; targeted router and pool regressions added.
- 2026-09-10 done: `packages/host/test/router.test.ts` 22 and `worker-pool.test.ts` 10 pass; host typecheck and build pass. The full host suite's unrelated live-engine case is currently blocked by M13-T76's in-progress instruction template (`One inserted field is incomplete`), while every router and pool test passed in that run.
- 2026-09-10 independent review: agree with the fix. Recovery intent and sessions actually open in the current worker are now separate states; the router restores a saved session before a path action and rejects a stale unsaved path without recreating it. After M13-T76 landed, the complete host suite passes all 208 tests, including the real worker end-to-end cases.

#### M2-T2 notes
- 2026-09-05 claimed: derive `SessionAttention` in the host from worker events; persist "seen" so `finished_unread` survives a reload; add `pi/session/attention` and an attention-sorted inbox query.
- 2026-09-05 done. `packages/host/src/attention.ts`. Durable state is a timestamp, not a seq (seqs restart with each worker), so `finished_unread` = the session file changed after the last `pi/session/seen`, which also catches sessions driven from a terminal. A session nobody ever opened here is `idle`, not unread — otherwise first launch marks the whole history unread. The host clears a dialog on a client's `pi/ui/response` itself: the worker's UI bridge deliberately emits no `dialogResolved` when a client answered, so without that the row stayed "waiting for you" forever.

#### M2-T3 notes
- 2026-09-05 claimed: host-side hydrated-view cache (LRU) serving `pi/session/entries` without a worker round trip, validated by (size, mtime).
- 2026-09-05 done. `packages/host/src/views.ts` (last 8 transcripts, validated by the file's own size+mtime so a terminal-driven session invalidates it the same way). Catalog metadata is now populated incrementally: substring-filtered line scan continuing from the last byte offset, so a growing transcript is read once. Measured on the real `~/.pi/agent/sessions`: 42 sessions, 22.7 MB, 78 ms cold, 0.36 ms warm. Per-session UI isolation verified in `packages/ui/test/runtime/isolation.test.ts` (a delta in A leaves B's view referentially identical, which is what the per-thread `useSyncExternalStore` keys on).

#### M2-T4 notes
- 2026-09-05 claimed: server-side project registry (persisted) + project-trust gate. Found: Pi's `SettingsManager.fromStorageWithPaths` defaults `projectTrusted` to **true**, and the SDK never runs the trust flow (only `main.ts`/`package-manager-cli.ts` call `resolveProjectTrusted`), so laser has been loading project-local settings/extensions/skills with no prompt. The host now resolves trust and passes it to the worker.
- 2026-09-05 done on the host side. `packages/host/src/projects.ts` + `trust.ts`: the list is persisted in `<stateDir>/projects.json` (default `~/.laser`) and the UI migrates its old localStorage list into it once. Trust resolves in the order laser decision → Pi's `trust.json` (nearest ancestor, read-only) → `defaultProjectTrust` → ask the clients, and the worker start is held until an answer (2 min, then declined for that run). Reading Pi's trust store but never writing it keeps `docs/architecture.md`'s "data we read" list true; a remembered answer goes into laser's own store and the dialog says so.
- 2026-09-05 handoff: the flag reaches the worker as `--project-trusted yes|no` but the worker does not consume it yet (that package is another lane's this session). Until the four-line patch in H-1 lands, Pi still runs every project trusted. The host side is inert-but-correct: unknown args are ignored by the worker's arg parser.

---

## M3 · Subagent tabs

| ID | Task | State | Owner | Evidence | Notes |
| --- | --- | --- | --- | --- | --- |
| M3-T1 | `subagents` module (in-process bus) | done | lane-E | `pnpm -r build && pnpm -r typecheck && pnpm -r test` — 591 tests, exit 0 (2026-09-05, wave 2 integration) | `packages/pi-extension/src/modules/subagents.ts`; capability probe with a timeout (R11), emits only through `laser:panel` |
| M3-T2 | Host file layer watcher | done | lane-E | `pnpm -r build && pnpm -r typecheck && pnpm -r test` — 591 tests, exit 0 (2026-09-05, wave 2 integration); 43 tests in `packages/host/test/subagents/` | `packages/host/src/subagents/{status,panels,layer}.ts`; 1 s stat-and-compare poll, not fs.watch (see the file header) |
| M3-T3 | Foreground children via transcripts | done | lane-E | `pnpm -r build && pnpm -r typecheck && pnpm -r test` — 591 tests, exit 0 (2026-09-05, wave 2 integration) | read-only cards, attributed by directory mtime; upstream patch 3 in `docs/upstream.md` fixes attribution at the source |
| M3-T4 | Control: steer/stop/resume | in-progress | lane-E | `pnpm -r build && pnpm -r typecheck && pnpm -r test` — 591 tests, exit 0 (2026-09-05, wave 2 integration); control-inbox bytes verified against the runner's format | steer/stop/interrupt are files and work for terminal-started runs; resume needs the owning session's bus and is only offered while a live module announced it |
| M3-T5 | Tab group UI | done | lane-E | `pnpm -r build && pnpm -r typecheck && pnpm -r test` — 591 tests, exit 0 (2026-09-05, wave 2 integration); 15 run-tree tests | `packages/ui/src/components/subagents/RunTabs.tsx` under the top bar; one level, breadcrumb for depth |
| M3-T6 | Workflow view | done | lane-E | `pnpm -r build && pnpm -r typecheck && pnpm -r test` — 591 tests, exit 0 (2026-09-05, wave 2 integration) | plans render as `plan` panels; phases collapsible, `inferred` marked (R3) |
| M3-T7 | Missions view | done | lane-E | `pnpm -r build && pnpm -r typecheck && pnpm -r test` — 591 tests, exit 0 (2026-09-05, wave 2 integration) | `packages/host/src/subagents/missions.ts` → collection + document panels; `laser missions` |
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
| M4-T7 | Keybindings + trust views | done | lane-E, lane-G | `packages/worker/src/keybindings.ts`, `packages/ui/src/components/settings/KeyboardTab.tsx`, `packages/ui/src/components/settings/TrustTab.tsx`; `pnpm -F @lasercode/worker test -- keybindings` (runs against the pinned agent for real); live: `app.clear` rebound to `ctrl+shift+k`, file became `{"app.clear":"ctrl+shift+k"}`, Reset emptied it | Trust view writes only through the host's registry, never the agent's own trust list. Keyboard now has two halves: the window's own keys, which are fixed in this version and say so, and the agent's actions and editor keys, which are read and written through `pi/keybindings/get\|set`. The "edit it from a terminal" footnote is gone. The adapter loads `KeybindingsManager` by file URL because the pinned agent exports it as a type only — the same class of exception as `piSettingsStorage`, and it must be re-checked on a pin bump (D-38) |
| M4-T8 | "All settings" written for a person, not for settings.json | done | codex-2026-09-06-v020 | `pnpm -r typecheck && pnpm -r test && pnpm -r build`; live browser review | see notes |

---

## M5 · Desktop shell

| ID | Task | State | Owner | Evidence | Notes |
| --- | --- | --- | --- | --- | --- |
| M5-T1 | Electron main | in-progress | codex-2026-09-06-input | `pnpm -r build && pnpm -r typecheck && pnpm -r test` — 591 tests, exit 0 (2026-09-05, wave 2 integration); headless Electron 44.2.0 boot on this machine | reopened: Electron window input is unusable on the maintainer's Linux desktop; see notes |
| M5-T2 | Bundled runtime outside asar | done | lane-B | `/proc/<host pid>/exe` = `runtime/linux-x64/node` (v24.20.0) | Node pinned in `packages/desktop/runtime.json` with official SHA-256s; `scripts/fetch-node.mjs --verify` refuses an Electron runtime |
| M5-T3 | Keychain | done | lane-B | root identity read back from the system keyring across a restart | `@napi-rs/keyring`; reported 0600 fallback (`identity().degraded`) |
| M5-T4 | Notifications + mic permission | in-progress | lane-B | `pnpm -r build && pnpm -r typecheck && pnpm -r test` — 591 tests, exit 0 (2026-09-05, wave 2 integration); 30 desktop tests | gates and copy written; macOS TCC and real banners need the platform |
| M5-T5 | Packaging, signing, updates | in-progress | lane-B | `packages/desktop/electron-builder.yml` + `README.md` | no signing possible here; Azure fields are `CHANGE-ME`; needs per-platform agents |

#### M5-T1 notes
- 2026-09-06 claimed: isolate the Electron-only click-coordinate failure by
  comparing the existing frameless Linux window with a native-framed window.
- 2026-09-06 X11 did not restore input. A native-framed X11 diagnostic build is
  running with the bridge and host healthy; awaiting the maintainer's click test.
- 2026-09-06 native-framed X11 was seamless in the maintainer's manual test;
  frameless X11 with `hasShadow: false` was still broken. The fault follows
  Electron's `frame: false` path, not Wayland or its client-side shadow.
- 2026-09-06 permanent Linux native-frame policy implemented and guarded by
  `test/window-frame.test.ts`; normal native-Wayland build is running for the
  final manual check. Desktop build, typecheck and 61 tests pass.

#### M5-T2 notes
- 2026-09-06 investigated dropping the bundled Node and running the host on the
  app binary with `ELECTRON_RUN_AS_NODE`. Proven to work end to end; rejected on
  ABI (`NODE_MODULE_VERSION` 137 vs 149 at the same `process.version`),
  pi-subagents' interpreter resolution (`process.execPath` → `"node"` on PATH,
  v18 here against a pinned agent needing ≥22.19) and BoringSSL. See D-49.

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
| M7-T5 | Push | in-progress | lane-C, integrator | `pnpm -F @lasercode/host test` → `test/push.test.ts` (RFC 8291 round trip, VAPID verify, 410 eviction); `pi/push/config` answered live with a generated key | `packages/host/src/push.ts`; `HostRelayOptions.publicOrigin` is what makes the links work off this machine, and nothing sets it yet |
| M7-T6 | Mobile mic | in-progress | lane-C, lane-D, integrator | `pnpm -r build && pnpm -r typecheck && pnpm -r test` — 591 tests, exit 0 (2026-09-05, wave 2 integration); `pi/transcribe/status` answers with a reason live | end to end in code (browser → host router → worker `TranscribeService`); no device and no API key here, so no phrase has been transcribed |
| M7-T7 | QR entry + paired browser transport | todo | — | — | Release audit found that the CLI emits `<publicOrigin>/link#…`, but the UI imports neither `PairingInitiator` nor the crypto package and has no `/link` controller. The QR opens a browser URL but cannot currently finish pairing. See D-59 and Q-6 |

---

## M8 · Package support

| ID | Task | State | Owner | Evidence | Notes |
| --- | --- | --- | --- | --- | --- |
| M8-T1 | Capability detection | done | lane-D, integrator | `pnpm -r build && pnpm -r typecheck && pnpm -r test` — 591 tests, exit 0 (2026-09-05, wave 2 integration) | `laser/capabilities` → `SessionView.capabilities`; the microphone is hidden, not disabled, where the package is absent (R2) |
| M8-T2 | `transcribe` module + desktop path | in-progress | lane-D, integrator | `pnpm -r build && pnpm -r typecheck && pnpm -r test` — 591 tests, exit 0 (2026-09-05, wave 2 integration); 21 transcribe tests | worker service, routing and composer are wired; this machine has only OAuth providers, so `status` correctly refuses by name |
| M8-T3 | Native markdown preview + image display | done | lane-D, integrator | `pnpm -r build && pnpm -r typecheck && pnpm -r test` — 591 tests, exit 0 (2026-09-05, wave 2 integration); markdown rendered in a dock island in a browser | `packages/ui/src/components/preview/**` is the one document renderer; the panel body delegates to it |
| M8-T4 | `web-access` module | done | lane-D | `pnpm -r build && pnpm -r typecheck && pnpm -r test` — 591 tests, exit 0 (2026-09-05, wave 2 integration) | search / fetch / source-check → `collection` panels |
| M8-T5 | Module authoring guide | done | lane-D | `docs/pi-extension-modules.md` | — |

---

## M9 · CLI

| ID | Task | State | Owner | Evidence | Notes |
| --- | --- | --- | --- | --- | --- |
| M9-T1 | `packages/cli`, `laser` bin, router, `--json`, help, colors | done | claude-2026-09-05-c | `pnpm -r build && pnpm -r typecheck && pnpm -r test` (385 tests) at `958bfb1` | hand-rolled parser on util.parseArgs; color degrades off-TTY and under NO_COLOR |
| M9-T2 | `up`/`down`/`status`/`restart` host lifecycle | done | claude-2026-09-05-c | `pnpm -r build && pnpm -r typecheck && pnpm -r test` (385 tests) at `958bfb1` | pidfile + port file under the state dir; attaches if already running; boot-id + start-time identity |
| M9-T3 | `laser pi …` passthrough to the pinned Pi | done | claude-2026-09-05-c | `pnpm -r build && pnpm -r typecheck && pnpm -r test` (385 tests) at `958bfb1` | inherits stdio, forwards exit codes and signals, sets PI_CODING_AGENT_DIR / PI_SUBAGENTS_TEMP_ROOT; `--global-pi` opts into the user's install |
| M9-T4 | session verbs over the host protocol | done | claude-2026-09-05-c | `pnpm -r build && pnpm -r typecheck && pnpm -r test` (385 tests) at `958bfb1` | sessions/new/open/send/tail/stop/entries/fork/rename/compact; `tail` streams updates and exits on agent_settled unless --follow |
| M9-T5 | `projects` / `packages` / `settings` verbs | done | claude-2026-09-05-c, lane-E | `pnpm -r build` exit 0 · `pnpm -r typecheck` exit 0 · `pnpm -r --no-bail test` 675/676 (the one failure is M11-T1's globals.css assertion, pre-existing); `laser settings --help`, `laser packages --help` | all three verbs exist with `--json`, `--project` and a scope flag; `settings` refuses an unknown key by name and says when a project write will be ignored for want of trust |
| M9-T6 | `doctor` | done | claude-2026-09-05-c | `pnpm -r build && pnpm -r typecheck && pnpm -r test` (385 tests) at `958bfb1`; run on this machine: 12 PASS, 1 WARN (uid-0 subagents root) | spawns a throwaway worker to prove the stack boots |
| M9-T7 | `relay login\|pair\|devices\|revoke`, `logs --follow` | done | lane-E | `pnpm -r build` exit 0 · `pnpm -r typecheck` exit 0 · `pnpm -r --no-bail test` 675/676 (the one failure is M11-T1's globals.css assertion, pre-existing); end-to-end pairing against a real `@lasercode/relay` on this machine (see notes); `packages/cli/test/qr.test.ts` (6), `packages/cli/test/relay-config.test.ts` (9) | `logs --follow` was already built; `relay` is new, with a from-scratch QR encoder pinned against `qrcode@1.5.4`. The daemon now reads the paired devices and hands them to `HostRelayOptions`, which nothing had been doing |
| M9-T8 | completions + `help <topic>` | done | claude-2026-09-05-c, lane-E | `pnpm -r build` exit 0 · `pnpm -r typecheck` exit 0 · `pnpm -r --no-bail test` 675/676 (the one failure is M11-T1's globals.css assertion, pre-existing); `laser completions bash\|zsh\|fish`, `laser help relay` | generated from the command table, so `relay` completed the moment it existed; a `relay` topic was added |

---

## M11 · Theme system

Lane T built `packages/ui/src/theme/` (T1–T3, T5, T7's guard); lane E built the
Appearance surface on top of it (T4, T6's seam, T7's editor). Rows lane E could
not evidence are left to lane T. The integrator should reconcile this table with
lane T's own if both were written.

| ID | Task | State | Owner | Evidence | Notes |
| --- | --- | --- | --- | --- | --- |
| M11-T1 | Three-layer token architecture | done | lane-T, integrator | `packages/ui/src/theme/{primitives,compile,presets}.ts`; `pnpm -F @lasercode/ui test` 318/318 including `test/theme.test.ts` "globals.css :root is the compiled default preset" | Finished at wave-3 integration. `globals.css`'s `:root` is now the compiled default preset between `@theme-default-start/end` markers, and the stale `.dark` palette is **deleted** rather than kept: a base is a property of the active theme, and that second hand-written palette was what made a fresh install render the pre-theme-system colours (index.html sets `class="dark"`, so `.dark` won over `:root`). `--kb` stays in `:root`, outside the markers, because the runtime owns it. The pinning test could never have passed as written — its `.trim()` ate the first line's indentation and nothing else's; the extraction was fixed, not the block |
| M11-T2 | `Theme` as data + runtime applier | done | lane-T | switching presets in the browser repaints the whole app with no remount and no reload (verified at desktop and 375px) | one style write at `:root[data-theme]`, which outranks `globals.css` |
| M11-T3 | Preset gallery | done | lane-T, lane-E | `packages/ui/src/components/settings/appearance/ThemeGallery.tsx`; seen in the browser, both bases | seven presets, each card compiled with the same `compileVars` that paints the app and scoped to the card, so a card *is* its preset rather than a swatch approximation of one |
| M11-T4 | Settings → Appearance | done | lane-E | `pnpm -r build` exit 0 · `pnpm -r typecheck` exit 0 · `pnpm -r --no-bail test` 675/676; `packages/ui/src/components/settings/appearance/**`, reachable at Settings → Appearance; verified in the browser at desktop and 375px, dark and light | theme, accent hue, a separate attention hue, interface font, code font, text size, density, corners, contrast, motion, follow-the-system, and the token editor. Every change writes through the store, so the app behind the panel is the preview and there is no Apply button. Reset per group and one for everything (two presses) |
| M11-T5 | Font loading on demand | in-progress | lane-T, lane-E | `FontPicker.tsx` fetches an option's family only when its group is expanded | the loader and the curated lists are lane T's and work; the picker renders each option in its own face. Not verified: that no unused family is fetched on a cold start — that needs a network trace |
| M11-T6 | Themes persist where settings live | done | lane-G | `packages/host/src/prefs.ts`, `packages/ui/src/runtime/prefs.ts`, `packages/host/test/prefs.test.ts` (6); live: chose Midnight → `prefs.json` revision 2, cleared `localStorage`, reload came up wearing Midnight | `pi/prefs/get\|set` is host-owned and lands in `<stateDir>/prefs.json`, never in the agent's settings file (D-37). `pi/prefs/updated` fans out through `notify()`, so a paired phone hears a theme change. `localStorage` stays as the pre-paint boot cache only; the host is the source of truth, and a fresh host adopts whatever the browser already had. The Appearance hedge ("copy it to move it to another machine") is deleted |
| M11-T7 | Guard rails | done | lane-T, lane-E | `checkTheme` in `theme/guard.ts`; the editor's per-token readout and the accent/attention interlock, seen firing in the browser | The editor measures the value you typed, not the one high contrast rescues, and flags anything under 4.5:1 by name. Lane E found and worked around a real defect: `separateAttention` returns exactly `MIN_HUE_SEPARATION`, which quantises to 39.x° through hex and is then refused by the guard — so picking an amber accent on Midnight silently did nothing. `safeAttentionHue` in `appearance/Hues.tsx` steps until the *measured* colours clear each other, and the attention row's disabled chips use the same measurement, so a chip that is offered is a chip that applies. A margin inside `separateAttention` would fix it at the source; that is lane T's file |
| M11-T8 | Every element restyled through tokens | done | lane-D, lane-E, integrator | `test/design-system.test.ts` (9 checks) green; repo-wide greps for hex, `oklch(`, `text-[Npx]`, `leading-[Npx]`, `text-2xs` and raw `duration-`/`ease-` in `packages/ui/src` all return 0 | Closed at wave-3 integration, which found the tokens were live in the *files* but not in the *utilities*: `@theme inline` had baked the type scale, both font stacks and the float shadows into every class (`.text-sm{font-size:13px}`, `.font-sans{font-family:Host Grotesk…}`), so Text size, Interface font and Code font moved nothing at all. Those tokens moved to a non-inline `@theme` (utilities now emit `var(--text-sm)`), and the shadows became custom utilities because Tailwind resolves a `--shadow-*` value at build time whatever the block says. Verified in the built CSS, not by reading |

#### M11-T4 notes
- 2026-09-05 lane-E: `SettingsScreen.tsx` returned its "No project selected" empty state *before* the tab strip, so on a machine with no project — every first run — Appearance, Keyboard, Trust and This device were unreachable. The guard is now a state of the body, not of the screen.
- 2026-09-05 lane-E: `--spacing` was not wired to `--space-unit`, so the density control moved nothing. One line added to `globals.css`'s `@theme inline` (`--spacing: var(--space-unit, 4px)`); measured before and after — `p-3` is 12px comfortable, 10.5px compact. Flagged to lane T as a cross-lane edit.
- 2026-09-05 lane-E: `--shadow-float` / `--shadow-float-sm` are compiled by the theme but `@theme inline` still maps the `shadow-float` utility to `globals.css`'s `--float-shadow`. Identical today, so nothing is visibly wrong; a custom shadow token would be ignored. Not editable from Appearance, so left alone and reported.


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

## M12 · 0.2.0 product experience

| ID | Task | State | Owner | Evidence | Notes |
| --- | --- | --- | --- | --- | --- |
| M12-T1 | Product identity and conversation controls | done | codex-2026-09-06-v020 | `pnpm -r typecheck && pnpm -r test && pnpm -r build`; live browser review | see notes |
| M12-T2 | Provider/model experience | done | codex-2026-09-06-release-hotfix | 388 UI tests; packaged session exposes 1,336 models | see notes |
| M12-T3 | Rich diagnostics and focused settings | done | codex-2026-09-06-v020 | `pnpm -r typecheck && pnpm -r test && pnpm -r build` | see notes |
| M12-T4 | Project and archive management | done | codex-2026-09-06-v020 | `pnpm -r typecheck && pnpm -r test && pnpm -r build` | see notes |
| M12-T5 | Integrate, visually verify, package and publish stable 0.2.0 | done | codex-2026-09-06-release-hotfix | [0.2.1 corrective release](https://github.com/youssefsiam38/laser/releases/tag/v0.2.1); [release pipeline](https://github.com/youssefsiam38/laser/actions/runs/34025881484) | see notes |
| M12-T6 | Make curated extension installation self-contained and safe | done | codex-2026-09-06-v020 | worker package tests; host package tests; live `pi-subagents@0.65.1` install | see notes |
| M12-T7 | Brand-aligned fresh-install theme | done | codex-2026-09-06-v020 | `pnpm verify`; theme tests; live dark/light review | see notes |
| M12-T8 | Session-safe web search and extension UI compatibility | done | codex-2026-09-06-v020 | 104 worker tests; user-confirmed live pi-subagents retry | see notes |
| M12-T9 | Predictable project rail and composer trigger menus | done | codex-2026-09-06-v020 | `pnpm verify`; live project/filter/settings/slash review | see notes |
| M12-T10 | Occupancy-aware dock geometry | done | codex-2026-09-06-v020 | `pnpm verify`; 1→4 exact live geometry; dark/light desktop + phone regression | see notes |
| M12-T11 | Rich context inspector and visible thinking indicator | done | codex-2026-09-06-v020 | `pnpm verify`; live context review in four visual combinations | see notes |
| M12-T12 | Visual telemetry instrument panel | done | codex-2026-09-06-v020 | `pnpm verify`; 320px desktop rail and phone sheet reviewed in both themes | see notes |
| M12-T13 | Chronological hierarchical Fleet | done | codex-2026-09-06-v020 | `pnpm verify`; live session `01a0750d` hierarchy; desktop/phone dark/light review | see notes |
| M12-T14 | Deduplicate workflow child identities | done | codex-2026-09-06-v020 | 152 host tests; live session `01a0750d` shows 4 unique runs | see notes |
| M12-T15 | Laser/Pi product boundary and settings taxonomy | done | codex-2026-09-06-product-boundary | `docs/product-boundary.md`; `pnpm identity:check` | see notes |
| M12-T16 | Curated feature registry | done | codex-2026-09-06-product-boundary | 4 feature tests; live Features review | see notes |
| M12-T17 | Bundled Subagents feature | done | codex-2026-09-06-product-boundary | reviewed built-in path tests; 105 worker tests | see notes |
| M12-T18 | Reusable goal engine and protocol | done | codex-2026-09-06-product-boundary | 2 goal-state tests; 27 protocol tests | see notes |
| M12-T19 | Persistent goal row and product language | done | codex-2026-09-06-product-boundary | 375 UI tests; live desktop review | see notes |
| M12-T20 | Clean-break acceptance verification | done | codex-2026-09-06-product-boundary | `pnpm -r build && pnpm -r test` — 842 tests; dark/light desktop and phone review | see notes |
| M12-T21 | Provider-gated core dictation | done | codex-2026-09-06-product-boundary | 35 dictation/capability tests; live microphone-control and readiness review | see notes |
| M12-T22 | Lossless leading slash completion | done | codex-2026-09-06-product-boundary | 3 UI tests; live Tab completion review | see notes |
| M12-T23 | Native-only Add Project flow | done | codex-2026-09-06-native-project-picker | 376 UI tests; 63 desktop tests; live browser fallback review | see notes |
| M12-T24 | Complete provider icon catalog | done | codex-2026-09-06-model-icons | UI typecheck; 379 UI tests; UI build; live provider-route review | see notes |
| M12-T25 | Branded startup restoration transition | done | codex-2026-09-06-startup-beam | UI typecheck; 381 UI tests; UI build; live dark/light desktop and phone review | see notes |
| M12-T26 | Establish the open-core licensing boundary | done | codex-2026-09-06-release-hotfix | canonical hashes match upstream; packaged legal-file proof | see notes |
| M12-T27 | Remove projects whose remaining chats are archived | done | codex-2026-09-06-archive-remove | 392 UI tests; UI typecheck and production build | see notes |
| M12-T28 | Persist project priority across both left sidebars | done | codex-2026-09-06-project-order | `pnpm verify` — 862 tests; host persistence test | see notes |
| M12-T29 | Make dock panels directly reorderable | done | codex-2026-09-06-project-order | `pnpm verify` — 862 tests; 13 dock-state tests | see notes |
| M12-T30 | Widen the shared conversation reading measure | done | codex-2026-09-06-activity-summary | `pnpm verify` — 869 tests | see notes |
| M12-T31 | Aggregate adjacent tool activity under one rich disclosure | done | codex-2026-09-06-activity-summary | `pnpm verify` — 869 tests; 7 group-summary tests | see notes |
| M12-T32 | Reveal timestamps from the message row | done | codex-2026-09-06-activity-summary | `pnpm verify` — 869 tests; timestamp interaction test | see notes |
| M12-T33 | Reclaim the space below the composer | done | codex-2026-09-06-activity-summary | `pnpm verify` — 869 tests | see notes |
| M12-T34 | Expand Markdown syntax-highlighting coverage | done | codex-2026-09-06-activity-summary | `pnpm verify` — 869 tests; 3 highlighter catalog tests | see notes |
| M12-T35 | Align native notification session titles | done | codex-2026-09-06-activity-summary | `pnpm verify` — 875 tests; 66 desktop tests | see notes |
| M12-T36 | Separate active and terminal fleet work | done | codex-2026-09-06-activity-summary | `pnpm verify` — 875 tests; 20 run-tree tests | see notes |
| M12-T37 | Publish stable 0.2.2 | done | codex-2026-09-06-activity-summary | [release workflow](https://github.com/youssefsiam38/laser/actions/runs/34029183501) | see notes |
| M12-T38 | Aggregate reasoning with tool activity | done | codex-2026-09-06-activity-summary | `pnpm verify` — 877 tests; 9 activity-summary tests | see notes |
| M12-T39 | Publish stable 0.2.3 | done | codex-2026-09-06-activity-summary | [release workflow](https://github.com/youssefsiam38/laser/actions/runs/34029935117) | see notes |
| M12-T40 | Adaptive API and account usage telemetry | done | codex-2026-09-06-account-usage | `pnpm verify` — 888 tests; 3 account-parser tests | see notes |
| M12-T41 | Three-level session activity disclosure | done | codex-2026-09-06-account-usage | `pnpm verify` — 888 tests; 2 session-preference tests | see notes |
| M12-T42 | Restore the active model picker choice on open | done | codex-2026-09-06-account-usage | `pnpm verify` — 888 tests; 3 model-selector tests | see notes |
| M12-T43 | Publish stable 0.2.4 | done | codex-2026-09-06-release-024 | [release workflow](https://github.com/youssefsiam38/laser/actions/runs/34034100668) | see notes |
| M12-T44 | Compact the conversation surface | done | codex-2026-09-06-compact-transcript | `pnpm verify` — 891 tests; dark/light desktop/phone visual pass | see notes |
| M12-T45 | Reliable, uniform activity disclosures | done | codex-2026-09-06-activity-rows | 424 UI tests; typecheck; desktop/phone dark/light and pointer/Enter toggles | see notes |
| M12-T46 | Captured API request inspector | done | codex-2026-09-06-request-inspector | `pnpm verify` 918 tests; host E2E prompt attribution; desktop/phone both themes | see notes |
| M12-T47 | Publish stable patch 0.2.5 | done | codex-2026-09-06-request-inspector | `05539dc`; stable v0.2.5; release workflow 34037802194 passed | see notes |
| M12-T48 | Recover subscription quota refresh across updates | done | codex-2026-09-06-request-inspector | `pnpm verify`; quota lifecycle and host route tests; packaged-session probe | see notes |
| M12-T49 | Restore engine commands and skills in slash completion | done | codex-2026-09-06-slash-skills | `pnpm verify` — 925 tests; desktop/phone dark/light browser review | see notes |
| M12-T50 | Refresh daemon on updates and remember the request transcript view | done | codex-2026-09-06-slash-skills | `pnpm verify` — 925 tests; shellcheck; desktop lifecycle tests; four-layout Markdown review | see notes |
| M12-T51 | Publish stable patch 0.2.6 | done | codex-2026-09-07-search | `d75085e`, pushed `v0.2.6`; https://github.com/youssefsiam38/laser/releases/tag/v0.2.6 | dispatch complete; Actions intentionally unmonitored |
| M12-T52 | Make live activity follow the executing action | done | codex-2026-09-06-slash-skills | UI build; workspace typecheck; 448 UI tests; browser measured zero gaps on both edges | see notes |
| M12-T53 | Compact project tree and single-location session attention | done | codex-2026-09-06-slash-skills | 448 UI tests; desktop/phone dark/light review; live spinner, pin persistence and 44px touch targets | see notes |
| M12-T54 | Search full conversations and navigate exact matches | done | codex-2026-09-07-search | workspace build/typecheck; 954 tests; desktop/phone light/dark browser review | see notes |
| M12-T55 | Remove transcript day separators | done | codex-2026-09-07-day-separators | 458 UI tests; UI typecheck/build; desktop/phone light/dark browser review | see notes |
| M12-T56 | Search displayed tool content rather than payload structure | done | codex-2026-09-07-search-content | 959 workspace tests; workspace typecheck; UI/host/protocol build; browser values-only highlights | see notes |
| M12-T57 | Navigate exact matches in captured API requests | done | codex-2026-09-07-request-find | 465 UI tests; UI typecheck/build; four-layout browser review | see notes |
| M12-T58 | Highlight source code in file tools | done | codex-2026-09-07-tool-syntax | 467 UI tests; UI typecheck/build; desktop/phone dark/light browser review | see notes |
| M12-T59 | Repair authenticated subscription allowance retrieval | done | codex-2026-09-07-quota-release | `pnpm verify` (979 tests); rebuilt-module authenticated initial/manual refresh HTTP 200; four-layout quota review | see notes |
| M12-T60 | Release stable 0.2.7 | done | codex-2026-09-07-quota-release | `e1fd1fe`; `v0.2.7`; https://github.com/youssefsiam38/laser/releases/tag/v0.2.7; staged `pnpm verify` (979 tests) | see notes |
| M12-T61 | Explain and group account allowances | done | codex-2026-09-07-quota-ux | 480 UI tests; UI typecheck/build; compact/full desktop/phone dark/light browser review | see notes |
| M12-T62 | Complete the composer suggestion experience | done | codex-2026-09-07-composer-picker | 493 UI tests; 13 focused worker tests; 7 desktop tests including real Electron bridge; UI/worker/desktop build and typecheck; desktop/phone both-theme browser review | see notes |
| M12-T63 | Release stable 0.2.8 | done | codex-2026-09-07-release-028 | `105eba5`; `v0.2.8`; https://github.com/youssefsiam38/laser/releases/tag/v0.2.8; staged `pnpm verify` (1,008 tests) | see notes |
| M12-T64 | Built-in web search and provider consent | done | codex-2026-09-07-web-search | `pnpm verify`; final `pnpm -r test` (1,029 tests); packaged clean-machine gate (12 checks); `docs/web-search.md` | see notes |
| M12-T65 | Withdraw native reminders after viewing a session | done | codex-2026-09-07-notification-seen | 494 UI + 75 desktop + 171 host tests; typechecks; UI/desktop/protocol builds; real GNOME withdrawal | see notes |
| M12-T66 | Release stable 0.2.9 | done | codex-2026-09-07-release-029 | `8d1fb96`; `v0.2.9`; https://github.com/youssefsiam38/laser/releases/tag/v0.2.9; CI/release success; 12 assets | see notes |
| M12-T67 | Persistent goal history without duplicate accounting | done | codex-2026-09-07-goal-history | 1,052 workspace tests; 7 goal policy/state tests; workspace typecheck; live tool-only completion; four-layout browser review | see notes |
| M12-T68 | Repair search selection and provider failures | done | codex-2026-09-07-search-repair | `pnpm verify`: 1,054 tests; identity; 12 packaged checks; live OpenAI API/Codex probes; desktop/phone dark/light review | see notes |

| M12-T69 | Keep native notifications and desktop updates coherent | done | codex-2026-09-07-native-lifecycle | `pnpm verify`: 1,065 tests; fresh packaged clean-machine checks; live GNOME withdrawal; four-layout notices | see notes |
| M12-T70 | Release stable 0.2.10 | done | codex-2026-09-07-native-lifecycle | `d229cac`, `v0.2.10`; source CI 34087083663 success; GitHub release page published | see notes |

| M12-T71 | Preview link destinations and expose provider connection progress | done | codex-2026-09-07-link-progress | UI build/typecheck; 517 UI tests; desktop/phone dark/light browser checks | see notes |

| M12-T72 | Reuse an unstarted session when choosing New session | done | codex-2026-09-07-empty-session | UI build/typecheck; 539 UI tests; real host/browser desktop/phone checks in both themes | see notes |

| M12-T73 | Release stable 0.2.11 | done | codex-2026-09-07-release-0211 | `b1812fd`, `v0.2.11`; clean source CI 34090537860 passed; stable release page published | see notes |

| M12-T74 | Record and display instruction provenance | done | codex-2026-09-07-prompt-sources | workspace build/typecheck; 1,107 tests; real provider capture; four-layout browser review; `docs/prompt-provenance.md` | see notes |

| M12-T75 | Release stable 0.2.12 | done | codex-2026-09-07-release-0212 | `e898598`; clean CI 34114769530; `v0.2.12`; published stable release page | see notes |

| M12-T76 | Publish releases only after downloads are complete | done | codex-2026-09-07-release-assets | `pnpm verify`; 13 publication regressions; 76 installer checks; eight live package links HTTP 200 | see notes |

| M12-T77 | Make instruction sources navigable and file links native | done | codex-2026-09-07-source-navigation | UI/desktop builds and typechecks; 633 tests; four-layout browser checks; real GIO editor launch | see notes |

| M12-T78 | Release stable 0.2.13 | done | codex-2026-09-07-release-0213 | `a701e69`; clean CI 34120775378; pushed `v0.2.13`; release draft and artifact publication dispatched | see notes |

#### M12-T78 notes
- 2026-09-07 done: workspace build/typecheck and 1,116 tests plus 13 publication checks pass (`/tmp/release-0213-verify.log`); 76 installer checks pass (`/tmp/release-0213-install.log`). Source `a701e69568c739001d745efae5a89d17cb96b831` pushed and clean CI 34120775378 succeeded before immutable `v0.2.13` was pushed. Draft release notes created; tag triggered the x64/ARM64 asset-verified publication pipeline. No artifact monitoring, download-readiness claim, manual public promotion, production restart or unrelated staged-file inclusion. Public publication remains the pipeline's responsibility.
- 2026-09-07 claimed: publish the committed source-navigation fixes as stable 0.2.13. Preserve unrelated staged M3 work with an isolated index; verify the versioned source and installer, push source, pass clean CI, then push the immutable tag. Publication remains draft-first and asset-verified; do not monitor the artifact workflow or restart production processes.
- 2026-09-07 checkpoint: versioned source staged separately; identity and 76 installer checks pass. First verification inherited GIT_INDEX_FILE into temporary-repository worker tests, causing an invalid-object test-environment failure. Reinitialized only the isolated staging index and reran without that environment override; never export an alternate index into test suites that create repositories. The user's real index and production processes are unchanged.

#### M12-T77 notes
- 2026-09-07 claimed: reproduce nested source-menu scrolling, implement searchable rich source rows and pointer-adjacent component-only details, and route local Markdown/source paths through the desktop editor bridge. LinkDestination only observes hover/focus; Markdown anchors currently navigate files as browser URLs. Preserve exact text/search and unrelated M3 work. No release requested.
- 2026-09-07 checkpoint: source inventory reuses the installed command element, grouped by source kind with bounded scrolling and file actions. Portals stay inside the Dialog scroll lock. Virtual cursor anchors replace multi-line span anchors; markers have no native title. Exact instruction text and request-search counts remain unchanged. File links use the captured/session directory; browser views copy host paths. Desktop selects the default text editor with XDG/GIO, never a script/HTML MIME handler or shell command.
- 2026-09-07 done: 550 UI tests and 83 desktop tests pass, including a real preload window. UI/desktop builds and typechecks pass. Browser checks at 1440×900 and 390×900 in both themes prove menu wheel scrolling (600px in a 288px viewport), filtering 25 sources to one, empty state, keyboard file activation, pointer-following component-only details and no page overflow. Screenshots: `/tmp/source-navigation-{menu,tip}-{1440,390}-{dark,light}.png`; browser driver: `/tmp/verify-source-navigation.mjs`. Real editor bridge opened `docs/prompt-provenance.md` successfully via the machine's configured text editor. Temporary QA page/server removed/stopped; production app/host untouched. No push or release requested. Regression rules added to AGENTS and provenance documentation.

#### M12-T76 notes
- 2026-09-07 done: draft-first publisher verifies the complete architecture inventory and every remote asset's size/state/SHA-256 before public visibility; includes offline provenance in the same upload, preserves published bytes, and handles draft discovery through the CLI's draft-aware resolver rather than the published-only REST tag route. CI and `pnpm verify` run 13 ordering/failure/retry tests. Workspace builds/typechecks and 1,107 app tests pass (`/tmp/release-assets-verify.log`); 76 installer checks pass. 0.2.12 now has all 12 assets and is Latest; all eight package download URLs return HTTP 200. Its original pipeline succeeded through uploads while this fix was developed; no tag moved or runtime restarted. Future no-monitor delivery reports dispatch, not publication. AGENTS and release guide record the rule; unrelated M3 work remains excluded.
- 2026-09-07 claimed: 0.2.12 builds both succeeded, but the manually published page preceded the pipeline upload. Fix publication to use drafts, verify the complete asset set before visibility, include provenance in that transaction, and document that tag dispatch is not publication. Preserve unrelated M3 work and immutable 0.2.12 tag.

#### M12-T75 notes
- 2026-09-07 done: source `e898598cd02ac7b182d4bed0f356cf203f69cdfc` and immutable `v0.2.12` pushed after source CI 34114769530 succeeded. https://github.com/youssefsiam38/laser/releases/tag/v0.2.12 is published, not draft or prerelease. Latest promotion waits for the existing pipeline's verified artifacts. Artifact jobs were not monitored; download/feed readiness is not claimed. Unrelated M3 staged work and production processes remain untouched.
- 2026-09-07 checkpoint: 0.2.12 passes all workspace builds/typechecks and 1,107 tests (`/tmp/release-0212-verify.log`), identity validation and 76 installer checks (`/tmp/release-0212-install.log`). Feature desktop/phone and both-theme evidence is recorded in M12-T74. Only release-owned files are staged in an isolated index; next push source and satisfy clean CI before tagging.
- 2026-09-07 claimed: release committed instruction provenance as 0.2.12; preserve unrelated staged M3 work with an isolated index, verify source and installer, satisfy source CI before tagging, and publish the stable page without monitoring artifact jobs. Production processes remain untouched.

#### M12-T74 notes
- 2026-09-07 done: the public resource-loader seam observes the exact loaded base inputs and ordered extension prompt/request changes, including in-place mutation. Capture moves after registered pre-request handlers; a real Pi session proves its body equals the local provider's received request. Metadata contains only source identities, ranges and digests; retained-text validation rejects redaction/stale ranges without rereading files. The installed confidence-marker uses source identity, compact scrollable source details and inline focusable annotations, never confidence scores. Markdown remains one intact chat renderer with a source inventory; exact boundaries are shown in Plain. Search counts content once and excludes source chrome. Workspace build/typecheck and 1,107 tests pass (`/tmp/prompt-sources-verify.log`); final UI changes pass 37 targeted tests. Real browser verified desktop 1440×900 and phone 390×900 in both themes, search, source details, keyboard focus, Markdown and reduced motion, no errors/overflow (`/tmp/prompt-sources-{dark,light}-{1440,390}.png`). Temporary test service stopped; production untouched. No version bump, push or release.
- 2026-09-07 checkpoint: verified the pinned builder against complete resource suffixes, custom/default prompts, source paths, skill escaping and disabled skills. UI review caught excessive source chips and inline-button layout gaps; replaced with a bounded source inventory and focusable inline text, preserving exact whitespace and the existing search implementation.
- 2026-09-07 claimed: trace loaded prompt inputs and extension transformations using the pinned engine's resource hooks; persist source ranges with each request and adapt the confidence-marker for provenance, never confidence scores. Preserve unrelated staged M3 work. No version bump, push or release requested.

#### M12-T73 notes
- 2026-09-07 done: source `b1812fd456ebcae42f863bda76315f1fddc5e0f0` and immutable `v0.2.11` pushed after clean source CI 34090537860 succeeded. https://github.com/youssefsiam38/laser/releases/tag/v0.2.11 is published (not draft, not prerelease), with curated notes and `latest=false` until verified artifacts land. Tag dispatches the existing architecture/signing/native-feed workflow. Per user instruction, artifact jobs were not monitored and download/feed readiness is not claimed. Unrelated M3 specification/scratch files remain uncommitted; production processes untouched.
- 2026-09-07 checkpoint: staged 0.2.11 passes `pnpm identity:check`, all builds/typechecks and 1,095 workspace tests (`/tmp/release-0211-verify.log`), plus 76 installer checks (`/tmp/release-0211-install.log`). Existing desktop/phone dark/light evidence remains in M12-T71/T72. Next publish source, satisfy the required clean-source CI gate, then tag and publish the page without waiting for release artifact jobs.
- 2026-09-07 claimed: release the committed M12-T71/T72 changes as stable 0.2.11. Stage only release-owned files, run identity/workspace/installer gates, publish source and immutable tag, then create the release page without monitoring artifact jobs. Preserve the separate M3 specification and scratch work; do not restart the production app/host.

#### M12-T72 notes
- 2026-09-07 done: one shared launcher refreshes the catalog, prefers the current unstarted chat then the newest in the requested project, and coalesces rapid requests. Hydrates unknown candidates before reuse; archived/branched sessions, optimistic sends, pending work, dialogs and goal history are excluded. Reuse only selects the existing assistant-ui identity, preserving composer drafts and model choices. Build/typecheck, 539 UI tests (22 new regressions), identity and diff checks pass (`/tmp/empty-session-{build,typecheck,tests}.log`). Real isolated host/browser proved eight-click bursts, Ctrl+N, new creation during a first streaming response, return from history with draft intact, independent project drafts and fresh-client reuse. Desktop 1440×900 and phone 390×900 reviewed in both themes (`/tmp/empty-session-{dark,light}-{1440,390}.png`), no horizontal overflow or page errors. A pre-existing phone-sheet focus tooltip can cover the new-session button center; keyboard and the unobscured pointer area work. No production restart, backend API change, version bump, push or release.
- 2026-09-07 claimed: put reuse and repeated-click protection in the shared UI session launcher; retain per-project identity, drafts, settings and archives. No release or push requested; preserve unrelated specification edits.

#### M12-T71 notes
- 2026-09-07 done: document-delegated hover/focus previews include nested and portalled links, encoded URLs, credential omission, inert/unsafe-link suppression and stale cleanup; pointer-transparent fixed chrome never shifts layout. Provider sign-in indicates pending answer requests, preserves actual progress events and distinguishes key storage from API testing. Search testing names its provider inside the active disclosure with a sticky loader and collapsed-header spinner, plus an availability-local loader. Inputs are disabled during connection changes; success/failure exits busy state. UI build/typecheck and all 517 tests pass (`/tmp/link-progress-{build,typecheck,tests}.log`). Real app reviewed at 1440×900 and 390×900 in dark/light with deliberately held test responses and long URLs (`/tmp/link-signin-*.png`, `/tmp/provider-progress-*.png`); no paid probe or production credential write. Temporary isolated verification server only; no release/version change or push requested.
- 2026-09-07 claimed: add one application-wide destination preview and use the adopted loading element beside provider controls while their real requests are pending. Preserve unrelated agents specification changes; no release requested.

#### M12-T69 notes
- 2026-09-07 done: staged source passes all builds/typechecks and 1,065 tests (`/tmp/release-0210-final-verify.log`); freshly packaged 0.2.10 passes every clean-machine claim (`/tmp/release-0210-final-clean.log`). Remote refresh and local restart notices reviewed on desktop/phone in both themes, with no automatic restart or overflow. Remote refresh preserves host work and flushes the current draft; local restart explicitly warns that active work stops. Research: freedesktop notification protocol (https://specifications.freedesktop.org/notification/latest/protocol.html), Electron Linux libnotify implementation, and installed Ubuntu Dock notificationsMonitor.js establish that owned native notifications must be withdrawn, not merely hide their banners. Legacy orphaned notifications cannot be enumerated through the standard API: full quit/reopen after installing and one manual clear remain necessary for those old reminders. No production process was restarted.
- 2026-09-07 checkpoint: native hook no longer signals the daemon; atomic installed marker offers a user-chosen full restart. Compiled frontend/host version handshake and envelope guard block mismatched commands and resume. Desktop also compares its own main version and refuses mismatched daemon spawns/adoption. Notification cleanup now covers activation, durable seenAt after reconnect and orderly exit. Live low-urgency GNOME probe removed ID 44 after banner timeout, left 45 present, then removed 45 on dispose; both emitted NotificationClosed reason 3 (`/tmp/native-reminder-dbus.log`). Four-layout browser notice review passed with no horizontal overflow. Production app/workers remain untouched.
- 2026-09-07 claimed: verify Ubuntu's actual notification ownership/counting, fix orderly cleanup and full-desktop native-update activation. Current renderer arguments prove main version 0.2.5 while installed CLI/host is 0.2.9; the previous main-process fix never loaded. Do not interrupt production workers or clear unrelated OS notifications.

#### M12-T70 notes
- 2026-09-07 done: source `d229cac` pushed; clean source CI https://github.com/youssefsiam38/laser/actions/runs/34087083663 passed before immutable tag `v0.2.10` was pushed. Release page https://github.com/youssefsiam38/laser/releases/tag/v0.2.10 published with human-readable notes and `latest=false`; the tag dispatches architecture builds and signed feeds. Per explicit user instruction, release workflow is not monitored: asset/feed completion is not claimed. Local installer fixtures pass 76 checks. Isolated sandbox and verification browser stopped; production remains running untouched. Separate M3 research, ignore-file and scratch changes remain uncommitted.
- 2026-09-07 checkpoint: 0.2.10 is the single workspace version; intended source staged before the complete gate, fresh packaged checks pass. Publish source for clean branch CI before tagging, then dispatch publication without monitoring the release workflow, as requested. Unrelated agents research and scratch files remain outside the release.
- 2026-09-07 claimed: bundle completed M12-T67/T68 with M12-T69 in the next stable patch; preserve unrelated reference/scratch changes.

#### M12-T68 notes
- 2026-09-07 done: provider connect-and-use and every feature enablement perform a real search before persisting; failed tests preserve the previous selection and credentials, and saved alternatives remain inactive. Both OpenAI routes passed live probes, so neither was removed. Safe provider/HTTP-specific errors now replace discarded upstream failures; pinned DuckDuckGo patch distinguishes genuine empty results from challenge/malformed HTML. Existing assistant-ui settings controls retained, with explicit test/charges/single-provider copy. Full `pnpm verify` passes 1,054 tests and all builds/typechecks (`/tmp/search-repair-final-verify.log`), identity and diff checks pass; fresh desktop pack passes all 12 clean-machine claims (`/tmp/search-repair-clean.log`). Real isolated host/worker browser flow verified activation, enablement, failed replacement, successful saved-connection retest and disable-with-credentials-retained at 1280×800 / 390×844 in both themes, without horizontal overflow. No production restart, commit, staging, push or release. Preserve concurrent goal/history/reference changes and both pnpm dependency patches.
- 2026-09-07 user scope: every provider activation and feature enablement must make a real test call; only a successful test replaces the single selected provider, including free providers. Existing credentials may remain saved but inactive. Unsupported Codex sharing should be removed only if the direct route proves unsupported.
- 2026-09-07 live evidence: one bounded search through each explicitly authorized existing connection succeeded: OpenAI API and openai-codex both returned provider=openai, one source and a nonempty answer. No raw body, credential or account identifier printed; no saved selection or feature state changed. Therefore keep both supported routes. Reproduced a formerly failing DuckDuckGo query returning HTTP 200 with ten results now; historical challenge vs no-results cannot be inferred from generic saved failures.
- 2026-09-07 claimed: inspect both supplied sessions and host logs, reproduce upstream failures, make connection selection explicit and atomic, and verify both OpenAI routes. Preserve concurrent goal-history changes; no commit or release.
- 2026-09-07 evidence: both sessions use openai-codex for chat but every successful search identifies DuckDuckGo. Search configuration still selects DuckDuckGo with OpenAI shared permission saved. Search failures are generic at 0.5–1 second, while chat requests continue; the older session's shell fallbacks separately fail on missing python/bs4. The previous search runner discarded upstream error classifications, so historical exact provider response bodies are unavailable. Referenced `docs/research/findings.md` is absent from this checkout.

#### M12-T67 notes
- 2026-09-07 done: goals no longer accept budgets or expose/accumulate separate usage. Exact objective text, the Goal set marker, a durable completion summary with Markdown and lifecycle timeline, raw-entry action mapping, clean catalog titles and searchable visible content are implemented. Completion tool/instructions unchanged; no extra model answer. `pnpm -r test` passes 1,052 tests (`/tmp/laser-goal-final-tests.log`), then the added historical-budget regression brings goal policy/state tests to 7; workspace typecheck and identity pass. Built UI/host/worker/protocol/extension/goal packages verified. Real isolated upstream tool-only completion retained its summary after auto-clear/reload; keyboard, reduced motion and 1440×1000 / 390×844 dark/light reviewed (`/tmp/laser-goal-final-*.png`). Original reported transcript and production processes untouched. Isolated test servers stopped. No commit, tag, push or release in this task; preserve concurrent M12-T68/reference changes and both pnpm patches when bundling.
- 2026-09-07 claimed: remove goal accounting/budgets, preserve objectives and project lifecycle history into one durable chat disclosure. Completion remains terminating; display its actual summary rather than requesting another model answer. Preserve unrelated working-tree changes. HANDOFF.md and docs/research/findings.md are absent.
- 2026-09-07 checkpoint: exact upstream policy patch removes token-budget command/API paths and disables accounting without replacing the continuation loop or completion tool. Pure replay covers complete-then-null persistence, clean first objective, hidden continuations, stale completions and original entry ordinals. The isolated SANDBOX_GOAL provider reproduced a tool-only completion and reload retained its summary. Browser review exposed a pre-existing metadata namespace mismatch and internal-prompt session title; both corrected. Workspace typecheck passes; initial full test attempt stopped at two concurrent M12-T68 web-search UI tests (501 UI tests passed).

#### M12-T66 notes
- 2026-09-07 done: https://github.com/youssefsiam38/laser/actions/runs/34078829525 passed x64 and ARM64 builds, packaged checks, signing, real-artifact installation, provenance, publication and APT/DNF deployment. Stable 0.2.9 is Latest with all 12 expected assets and user-facing notes covering both changes. Source `8d1fb96` includes notification fix `5356f34`; source CI passed before tag creation. Unrelated ignore-file/reference/scratch changes remain uncommitted. No production restart or live paid-provider query performed. Update guidance requests full quit including tray; legacy reminders may need one manual clear.
- 2026-09-07 checkpoint: source `8d1fb96` pushed with notification commit `5356f34`; clean CI https://github.com/youssefsiam38/laser/actions/runs/34078692181 passed before annotated `v0.2.9` creation. Release workflow will build/sign/install-test both architectures and publish native feeds; waiting for artifact evidence before marking done.
- 2026-09-07 checkpoint: 0.2.9 packaged clean-machine gate passes all 12 checks, including a real session and isolated upstream search with bundled Node/empty PATH; installer fixtures pass 76 checks (`/tmp/laser-029-clean.json`, `/tmp/laser-029-installer.log`). No implementation changes during release preparation. Publishing verified source for CI before creating its tag.
- 2026-09-07 checkpoint: intended release source staged; identity and full build/typecheck/1,029 tests pass (`/tmp/laser-029-verify.log`). Version 0.2.9 is consistent across all manifests. Packaged clean-machine and installer checks are running; no paid search requests or production restart.
- 2026-09-07 claimed: include M12-T64 and committed notification fix `5356f34`, bump all manifests to 0.2.9, stage only requested work and run workspace/packaged gates. Wait for source CI before tagging; verify published installers and feeds. Preserve unrelated reference, ignore-file and scratch work.

#### M12-T65 notes
- 2026-09-07 claimed: track native handles per session, forward an explicit seen acknowledgement independently of attention changes, preserve unanswered approvals and test native Linux dismissal. Avoid concurrent web-search files and leave release/version unchanged.
- 2026-09-07 checkpoint: explicit host acknowledgement reaches the independent desktop connection in a real WebSocket test without starting a worker. Transcript acknowledgement moved onto the mounted chat surface: covered Settings/Logs, unfocused windows and hidden tabs do not count; pending approvals do, without answering them or sending per-token acknowledgements. Assistant-ui runtime guidance preserves the existing adapter/action seam.
- 2026-09-07 native proof: built Notifier sent two synthetic critical reminders to GNOME 46. Withdrawing A generated `CloseNotification(34)` and GNOME `NotificationClosed(34, 3)` while B remained until explicitly withdrawn later (`35, 3`). No real session or existing notification was dismissed. Ubuntu Dock's installed notifications monitor recalculates its count on notification destruction; badge repaint itself was not visually measured. Probe and D-Bus monitor stopped. Evidence: `/tmp/notification-seen-dbus.log`.
- 2026-09-07 done: 740 tests pass across UI/desktop/host; UI and host typechecks plus protocol/desktop/UI builds pass. Added guards for late delivery, late replaced-handle callbacks, foreground resolution, throttling, hidden/covered/unfocused views and approval acknowledgement. Tests and native proof are recorded under `/tmp/notification-seen-*`. No visual styling changed. Legacy orphaned reminders from an earlier process may need one manual clear; there is no blanket deletion or speculative notification-ID recovery. No version bump, push, release or installed-app restart.

#### M12-T64 notes
- 2026-09-07 done locally: exact-pinned pi-web-access 0.28.0, all 29 provider IDs, independent global/project feature choice, searchable provider settings with explicit shared-connection grants and write-only search keys. Engine registration lives in the single companion extension's web-access module; the worker owns storage/auth policy and isolated execution. Results remain transcript-only. No commit, stage, release, production restart or live paid-provider search performed.
- 2026-09-07 evidence: `pnpm verify` passes; final `pnpm -r test` passes all 1,029 tests, including registration/disabled-state/failure isolation, consent/revocation, atomic saves, schemas, real host routing/tool exposure, local upstream search and cancellation. `pnpm -F @lasercode/desktop run pack` plus `node packages/desktop/scripts/clean-machine.mjs --json` passes 12 checks with bundled Node/empty PATH and a real search probe. Desktop 1280px and phone 390px reviewed in dark/light; keyboard disclosure, filtering, save/select, enable/disable retaining credentials and no horizontal overflow verified in the browser. Test key removed and sandbox stopped. External provider billing/auth endpoints remain untested live; browser-cookie and ADC auth deliberately excluded, documented in `docs/web-search.md`.
- 2026-09-07 checkpoint: all 29 provider IDs match the upstream registry; literal-key, atomic cross-worker storage, consent/revocation, local SearXNG execution and cancellation tests pass. The real host routes settings and the enabled session exposes `web_search` to the model. Browser review is underway; desktop package built for the clean-machine search probe. An initial dependency-resolution failure was fixed by bundling the complete upstream search module. No user-provider search request has been made.
- 2026-09-07 claimed: restore the search runtime as a reviewed built-in, audit upstream provider authentication, and add explicit search connection settings without reviving duplicate result panels. Preserve unrelated dirty reference work; no commit or release.
- 2026-09-07 investigation: D-61 removed the collection adapter, then curated feature loading omitted the package altogether. pi-web-access 0.28.0 exposes 29 provider implementations but caches process-global configuration. Search execution will isolate each invocation from ambient credentials and configuration; shared credentials resolve from the existing model connection only after explicit consent.

#### M12-T63 notes
- 2026-09-07 claimed: bundle committed M12-T61 and the user's completed M12-T62 picker work, stage only release-owned changes, run the full workspace gate and publish commit/tag/release without monitoring Actions. Preserve unrelated guide/planning and ignore-file edits.
- 2026-09-07 checkpoint: all intended source staged before `pnpm identity:check` and `pnpm verify`; full workspace build/typecheck/1,008 tests pass, including 493 UI tests and the real Electron bridge (`/tmp/laser-028-verify.log`). Version is 0.2.8 in all workspace manifests. Prior M12-T61/T62 responsive-theme evidence retained; no implementation changes made during release preparation. Committing and dispatching the verified source next.
- 2026-09-07 done: commit `105eba5` and annotated `v0.2.8` pushed atomically, including allowance commit `3039e34` and the user's composer picker work. Stable release page created with update guidance. It is not Latest until the workflow publishes verified installers and native feeds. Actions not monitored or waited on, as requested; installer availability is not claimed. Unrelated `.gitignore`, M3-T10 guide/planning and scratch files remain outside this release. No production restart performed.

#### M12-T62 notes
- 2026-09-07 claimed: audit the complete trigger interaction lifecycle; retain the adopted assistant-ui element and strengthen its search, navigation, dismissal and responsive presentation without changing command semantics. Leave all work uncommitted.
- 2026-09-07 checkpoint: unified picker navigation/dismissal and project-wide debounced search implemented; 15 focused UI tests, six desktop source-opening/preload tests and four real worker skill tests pass. Browser review caught scroll anchoring after a phone-height resize; disabled anchoring and re-revealed selection after measured resizing.
- 2026-09-07 scope addition from user: selected/hovered skill and prompt rows expose their existing source Markdown path. Desktop opens only validated Markdown through the OS association; browser/phone copies the path. Pi skill guidance keeps discovery in the existing resource loader; no global-engine config or replacement skill discovery.
- 2026-09-07 done: project-index search is debounced, query/project scoped, refreshed on reopen and retryable; 600-file Git regression proves beyond-first-page search and excludes ignored/deleted files. Exact filenames outrank scattered matches; native separators work. Picker tests cover arrows/wrap/pages, scoped scrolling, outside/focus/Escape dismissal, IME, pointer selection, empty states, draft preservation and the independent source action. Browser review passed at 1280×720 and 390×844 in dark/light, plus 390×430 keyboard-sized space. Temporary review files/server removed. `pnpm identity:check` and `git diff --check` pass. All task changes deliberately remain uncommitted; no release, installation or production restart performed. Actual OS editor launch was not invoked; the real Electron bridge and validated opener are covered separately.

#### M12-T1 notes
- 2026-09-06 claimed: audit the shipped logo assets, theme presets, assistant-ui
  thinking indicator, reasoning panel and reasoning-effort control before edits.
- 2026-09-06 checkpoint: the generated app mark is now the rail home control;
  graphite and paper use the mark's green; thinking moved into the compact
  reasoning-effort popover; context opens one detailed dialog from both entry
  points; reasoning expansion is a persisted per-session menu preference.
- 2026-09-06 done: the rail and package now use the exact approved website
  artwork, and the grouped reasoning disclosure renders every reasoning part.

#### M12-T2 notes
- 2026-09-06 claimed: isolate the provider-loading loop and build one
  provider-first model vocabulary for the composer and settings.
- 2026-09-06 checkpoint: confirmed the endless provider flicker was the inline
  `onConfigured` callback retriggering `ProviderStep`'s effect; stabilized it.
  The assistant-ui model selector now has provider-first filtering, reusable
  single/multi selectors, and explicit OpenRouter source provenance.
- 2026-09-06 done: composer, message re-run and settings expose separate
  searchable Provider and Model fields. Removed the duplicate hidden command
  input that stole focus after the first typed model character; live typing
  remains focused after selecting a provider.
- 2026-09-06 reopened: an installed 0.2.0 user with connected providers can
  browse the chat model picker but cannot select a model. Trace the shared
  picker action and cover configured-provider selection in the release hotfix.
- 2026-09-06 checkpoint: this was two paths. Loading an old session failed at
  the stripped Subagents entry point; before any session existed, the composer
  deliberately disabled its picker. The idle picker now loads the project
  catalogue and atomically writes the provider/model default for the new
  session; 388 UI tests and typecheck pass.
- 2026-09-06 done: a new chat can choose its project-scoped default before its
  first prompt; an open chat still changes only that session. The full 854-test
  workspace gate and packaged-session model-list probe pass.

#### M12-T3 notes
- 2026-09-06 claimed: inventory every JSON payload renderer and the Tools route,
  then replace them through shared components rather than one-off screens.
- 2026-09-06 checkpoint: added one collapsible syntax-coloured JSON viewer for
  logs, tool payloads, stream records, provider errors and settings exploration;
  the contradictory Tools section is excluded from both form and effective views.
- 2026-09-06 done: full workspace typecheck, tests and build pass.

#### M12-T4 notes
- 2026-09-06 claimed: trace Electron IPC and thread-list/project actions end to
  end before exposing native picking or destructive menus.
- 2026-09-06 checkpoint: added the sandboxed Electron folder-picker bridge,
  visible project menus with Archive chats and Remove project, and confirmed
  deletion for archived transcripts through a host-validated protocol method.
- 2026-09-06 done: full workspace typecheck, tests and build pass.

#### M12-T5 notes
- 2026-09-06 claimed: bump the integrated tree to 0.2.0, verify all four visual
  combinations, build and install the native package, publish a stable Latest
  release, and confirm the website follows it.
- 2026-09-06 blocked: local verification and a preliminary x64 package check
  pass, but the user explicitly requires a separate direct approval before any
  0.2.0 publish, tag, push, website deployment or package installation.
- 2026-09-06 resumed: the user explicitly approved publishing 0.2.0. Re-run
  every release gate, commit the integrated tree, push and tag only after the
  local release build and clean-machine installation proof pass.
- 2026-09-06 checkpoint: the pre-change full workspace gate passed with 847
  tests, and the x64 package build plus clean-machine proof held. Per the final
  release instruction, add derived/measured `tok/s` to the existing reply
  timing footer, run focused verification only, then let the tagged CI pipeline
  build the release artifacts.
- 2026-09-06 checkpoint: the first tagged pipeline stopped before compilation
  because the identity scanner only scans tracked files, so eight newly added
  paths/strings were invisible before the release commit and visible in CI.
  Renamed the mark asset and derived or neutralized all eight values. The
  post-stage identity check, UI typecheck and 11 focused UI/host/worker tests
  pass; move the unpublished failed tag to this corrective commit.
- 2026-09-06 checkpoint: before the corrected pipeline published, the user
  added visible timestamps to the release scope. Every user, assistant and
  notice message now shows a compact local clock with a natural full-date label;
  day separators keep the longer transcript chronology.
- 2026-09-06 done: stable 0.2.0 is GitHub's Latest release. The tagged pipeline
  built x64 and ARM64, installed the staged package, attested the artifacts,
  published 12 signed/checksummed assets, and deployed the signed APT/DNF feeds.
  The public website resolves the installer through `releases/latest`; release
  notes cover the complete product experience, friendly timestamps and `tok/s`.
- 2026-09-06 reopened: the published package strips all dependency `*.ts` files,
  but pi-subagents 0.65.1 intentionally exports `index.ts`; opening a session
  therefore throws `Cannot find module .../pi-subagents/index.ts`. Preserve
  executable TypeScript and extend the packaged clean-machine gate to load the
  bundled Subagents feature before publishing a corrective release.
- 2026-09-06 checkpoint: dependency TypeScript is preserved. The strengthened
  packaged acceptance probe opened a real session with Subagents and Goals
  under the bundled Node with an empty PATH and exposed 1,336 models; the x64
  clean-machine package passes every packaging claim.
- 2026-09-06 checkpoint: the first hotfix push exposed one identity guard in
  CI: the new acceptance probe used a literal temporary-directory prefix while
  it was untracked locally. It now derives `PRODUCT_NAME`, preserving the
  single-source identity rule; no product code or package behavior failed.
- 2026-09-06 checkpoint: the two escaped-release patterns are now permanent
  `AGENTS.md` rules: stage new files before identity/verify, wait for clean CI
  before tagging, preserve runtime-loaded dependency source, and require a real
  packaged session/capability probe rather than a top-level import check.
- 2026-09-06 release approved: main CI passed build, typecheck, all tests and
  install verification at `5ad7689`; prepare 0.2.1 and tag only after the exact
  version commit passes the same clean pipeline.
- 2026-09-06 done: stable 0.2.1 is GitHub's Latest release. The tagged pipeline
  built and install-tested x86-64 and ARM64 artifacts, published 12 checksummed
  and attested assets, and deployed signed APT/DNF repositories. Public checks
  resolve `releases/latest` and the website installer to 0.2.1; APT advertises
  0.2.1 and DNF metadata is live. The 0.2.0 notes now warn users to upgrade.

#### M12-T6 notes
- 2026-09-06 claimed: reproduce the packaged extension failure from the live
  host log, preserve npm's lifecycle-script boundary, and approve only reviewed
  version-pinned setup scripts required by the curated pi-subagents release.
- 2026-09-06 checkpoint: the bundled npm and command path are correct; npm 11.19
  refuses pi-subagents because esbuild 0.28.1, @google/genai 1.52.0 and
  protobufjs 7.6.6 have unreviewed lifecycle scripts. The current wrapper hides
  that reason behind its spawned command, which then leaks into the UI.
- 2026-09-06 done: `pi-subagents@0.65.1` installed from the live Extensions
  screen. The isolated extension manifest contains only exact approvals for
  `esbuild@0.28.1`, `@google/genai@1.52.0` and `protobufjs@7.6.6`; worker and
  host package tests pass.

#### M12-T7 notes
- 2026-09-06 claimed: read the approved website SVG palette, introduce a named
  Laser dark/light preset pair, and prove the exact brand colours remain
  accessible in their intended roles.
- 2026-09-06 done: fresh installs follow the Laser dark/light pair derived from
  the approved mark; exact palette and contrast guards pass, and both themes
  were reviewed live.

#### M12-T8 notes
- 2026-09-06 claimed: remove pi-web-access panel emission and legacy UI
  resurfacing while preserving the transcript tool disclosure; reproduce the
  `setToolsExpanded` failure from the supplied session and close that RPC gap.
- 2026-09-06 checkpoint: the second supplied transcript contains two failures
  with the same missing `ctx.ui.setToolsExpanded` method. It was served by the
  Hubtrix worker started at 06:57, before the corrected bundle was built at
  07:24. After its active turn settled, Laser's worker restart route replaced
  it with pid 2625188 at 07:46; all 104 worker tests pass and the live process
  now runs the bundle whose UI bridge owns the no-op compatibility method.
- 2026-09-06 done: the user retried the live pi-subagents flow and confirmed it
  works.

#### M12-T9 notes
- 2026-09-06 claimed: separate project selection from destructive menus and
  bound the slash/mention result surface so long command lists scroll in place.
- 2026-09-06 checkpoint: live browser verification confirms clicking the Laser
  project switches the current worker/filter without opening a menu; the full
  slash catalogue is capped at 18rem with its own visible scrollbar.
- 2026-09-06 checkpoint: “Show all” now clears the rail selection treatment but
  retains the current project for new chats. Project and Effective settings show
  a labelled project-target dropdown with the exact directory before any edit.
- 2026-09-06 done: the full workspace verification passes and live review
  confirms selection-only rail actions, explicit settings targeting, and a
  bounded scrolling slash catalogue.

#### M12-T10 notes
- 2026-09-06 claimed: make expanded-island occupancy, rather than the dock's
  available column count alone, choose the active grid: one full canvas, two
  stacked rows, then a stable 2×2 grid for three or four panels.
- 2026-09-06 done: 364 UI tests cover the occupancy and persisted compact-island
  regression. Live 1920×1080 measurements match the exact full/halves/quadrants
  geometry; dark/light desktop and phone-width regression review pass.

#### M12-T11 notes
- 2026-09-06 claimed: redesign the context-window dialog around icon-led usage
  cards and replace the empty running-reply caret with the installed
  assistant-ui thinking indicator plus elapsed time.
- 2026-09-06 done: the detailed context inspector is legible without overflow
  in dark/light desktop and 390×844 phone layouts. Empty running replies now use
  the installed thinking indicator before text or reasoning begins.

#### M12-T12 notes
- 2026-09-06 claimed: reshape the far-right telemetry rail around icon-led
  instruments and proportional visuals derived only from actual session data.
- 2026-09-06 checkpoint: tool failures remain solely in the detailed timeline;
  the sequence strip shows activity only. Removed Agent process because worker
  lifecycle is project-level implementation state already covered elsewhere.
- 2026-09-06 done: context, cost, token flow, model identity, file churn, tool
  activity and history now share one icon-led instrument vocabulary. Input
  points up to the provider and output down to the device; no emoji, fake metric
  or horizontal overflow. The 320px rail and phone sheet pass both themes.

#### M12-T13 notes
- 2026-09-06 claimed: stop globally attention-sorting a depth-first flattening,
  retain each run's persisted parent id, and render real nested chronological
  subtrees with lineage connectors rather than indentation alone.
- 2026-09-06 done: the stored parentage was correct, but Fleet flattened the
  tree and then globally sorted it by attention, separating the successful
  company lane from its failed siblings. Fleet now renders semantic nested
  subtrees and keeps workflow children in the authoritative plan-step order;
  the live session shows company, consumer and market directly under the plan.

#### M12-T14 notes
- 2026-09-06 claimed: use pi-subagents' persisted child run id and
  `parentWorkflowRunId` to converge the workflow summary and the child's own
  richer status file on one panel identity.
- 2026-09-06 done: pi-subagents persists each lane in the workflow aggregate
  and in the child's detailed status file. Laser previously assigned those two
  records different ids. Both now converge on the launched child run id while
  the detailed record retains metrics and controls; the live count fell from
  seven apparent runs to the correct four (one workflow plus three lanes).

#### M12-T15 notes
- 2026-09-06 claimed: codify Laser as the product and Pi as its pinned internal
  engine, then replace the mirrored settings catalogue with an explicit
  product/Advanced/internal/unsupported taxonomy before changing the UI.
- 2026-09-06 done: the product boundary is binding in `AGENTS.md`, architecture
  and product docs. Project settings live only in `.laser`; normal UI and CLI
  expose Laser concepts while the exact-pinned engine stays internal.

#### M12-T16 notes
- 2026-09-06 claimed: introduce a Laser-owned feature manifest and remove public
  package installation and Pi passthrough without a legacy migration path.
- 2026-09-06 done: manifests own scope, dependencies, capabilities, restart and
  health. Public package operations and Pi passthrough are absent; the live
  branded Features screen cleanly exposes only curated capabilities.

#### M12-T17 notes
- 2026-09-06 claimed: bundle the reviewed Subagents implementation and expose
  only a scoped Laser feature toggle, health and capabilities.
- 2026-09-06 done: Subagents loads only from the reviewed bundled path and is
  controlled through the scoped feature manifest; users never install or see
  its underlying package.

#### M12-T18 notes
- 2026-09-06 claimed: evaluate and pin `@narumitw/pi-goal`, keeping its durable
  logic Pi-native while the companion extension translates it to Laser's
  engine-neutral protocol.
- 2026-09-06 done: the reusable goal state package is repository-local and
  Pi-native; the companion bridge maps it to engine-neutral protocol with
  session-isolated start/edit/pause/resume/clear/complete/block/wait state.

#### M12-T19 notes
- 2026-09-06 claimed: map goal state to the session surface below the panel row
  with Laser-owned presentation and controls.
- 2026-09-06 done: the persistent goal row sits below the panel row, owns its
  progress and controls, survives reloads and session switches without leaking,
  and uses product language throughout.

#### M12-T20 notes
- 2026-09-06 claimed: prove `.laser` isolation, settings/features, session isolation,
  safety limits, product language and all four visual combinations.
- 2026-09-06 done: identity guard, full workspace build and 842 tests pass.
  Desktop and 390px phone layouts were reviewed in both brand themes; the
  rebuilt dark desktop Features page was rechecked after final copy changes.

#### M12-T21 notes
- 2026-09-06 claimed: bundle the exact reviewed `pi-gpt-transcribe` core without
  a feature toggle, explain its API-key dependency beside provider setup and
  preflight readiness before microphone access.
- 2026-09-06 checkpoint: matched the terminal package's real interaction model:
  Web Audio cuts natural phrases, requests run concurrently, results insert in
  spoken order at the current caret, typing stays enabled, and send drains the
  final phrase before submitting.
- 2026-09-06 done: dictation ships as core rather than a feature. Providers and
  models reports the configured OpenAI API key as Ready before microphone
  access; worker and phrase-controller regressions cover ordered pause-based
  transcription, live-caret insertion, failure recovery and final drain.
- 2026-09-06 fix: the startup capability notification could arrive before the
  UI created its session view, so the Ready provider still produced no mic.
  Capabilities now ride in the session snapshot and later notifications update
  them; a fresh live session exposes “Dictate a message” beside Attach.

#### M12-T22 notes
- 2026-09-06 claimed: constrain slash matching to character zero and replace
  only the leading trigger span, preserving all arguments and later lines.
- 2026-09-06 done: command matching uses command identity rather than
  descriptions. Live `/go` + Tab resolves only to `/goal`, including with the
  caret after the trigger and untouched text following it.
- 2026-09-06 QA note: before the matcher fix, the live `/go` probe surfaced and
  invoked `/compact` once in session `01a0750d`; it appended a failed compaction
  attempt. No transcript data was rewritten or deleted.

#### M12-T23 notes
- 2026-09-06 claimed: remove directory text entry and recent-path selection;
  make every desktop Add Project entry point invoke the operating system folder
  chooser, with a non-editable explanation outside the desktop app.
- 2026-09-06 done: Electron now launches its native folder chooser immediately
  from every shared Add Project trigger; cancelling changes nothing. The path
  input, paste path, recent folders and redundant desktop modal are gone. A live
  browser check found zero text inputs and the host-computer explanation.

#### M12-T24 notes
- 2026-09-06 claimed: reconcile Pi's exact 40-provider manifest against maintained
  brand-icon catalogs, then replace every known-provider monogram with a compact
  theme-safe mark and prove the mapping exhaustively.
- 2026-09-06 checkpoint: followed LobeHub's published icon skill and pinned
  `@lobehub/icons@5.18.0`; direct mono-component imports keep every mark at the
  catalog's 24-unit geometry, inherit Laser ink, and exclude the catalog's
  unrelated UI helpers from the renderer bundle.
- 2026-09-06 done: all 40 built-in ids resolve to real SVG marks in an exhaustive
  test. Regional and plan variants share the correct parent brand; Radius uses
  Lobe's Pi mark because it is Pi's own gateway. UI typecheck, 378 tests and the
  production build pass; provider rows were reviewed live in dark and light.
- 2026-09-06 reopened: the mixed all-model list incorrectly repeats each
  routing provider's mark on model rows. Separate routing-provider identity in
  filters/headings from model-family identity on model choices, then visually
  audit the unfiltered catalogue.
- 2026-09-06 correction: the user clarified that provider means the configured
  API and billing route, never the model developer. Every model row now uses
  that provider's mark and a friendly provider tag; DeepSeek through Workers AI
  shows Cloudflare plus Workers AI. Provider model subtables collapse
  independently. UI typecheck, 379 tests and the production build pass.

#### M12-T25 notes
- 2026-09-06 claimed: bind one full-window Laser beam transition to the real
  remembered-session hydration promise, preventing the default project/session
  shell from appearing before restoration completes.
- 2026-09-06 done: the operational shell stays unmounted until the remembered
  session, transcript and goal finish loading, then appears beneath a token-timed
  exit. The adapted Animated Beam composition uses the approved Laser mark,
  live theme colour and real connection/restoration copy. Reduced motion keeps
  the same status without travel. UI typecheck, 381 tests and build pass; dark
  and light desktop plus phone-width geometry were reviewed live.
- 2026-09-06 reopened from visual review: remove the square grid, diamond
  aperture and logo tile; rebuild the motion from the transparent mark's own
  rounded rails, asymmetric terminals and green beam.
- 2026-09-06 done after art review: the startup uses the exact transparent
  website mark with no tile, grid or geometric frame. Six rounded paths arc
  toward the mark, peak before contact and fade through the final curve so the
  centre absorbs rather than clips each beam. UI typecheck, 381 tests and build
  pass; dark/light desktop and phone-width composition were reviewed live.

#### M12-T26 notes
- 2026-09-06 claimed: apply the recommended open-core licensing split without
  weakening third-party terms or silently granting product trademarks.
- 2026-09-06 checkpoint: Laser application code is AGPL-3.0-only and offered
  separately under a negotiated commercial license; `packages/protocol` and
  `packages/pi-goal` are Apache-2.0. Full canonical texts, path-level scope and
  a trademark policy are present; verify they ship in the binary distribution.
- 2026-09-06 done: GNU and Apache license hashes match their authoritative
  texts; every package declares its scope, and the clean-machine build contains
  all four application legal/brand documents plus both Apache package licenses.

#### M12-T27 notes
- 2026-09-06 claimed: reproduce why Remove project uses the host catalog total
  after every visible chat was archived, then make archived-only unpinned
  projects disappear without deleting their transcripts.
- 2026-09-06 done: the archive store now publishes changes to project
  navigation. Pinned, unarchived and open projects remain reachable; an
  unpinned project backed only by archived transcripts disappears. Remove
  project reports the unarchived count, clears a removed inactive selection,
  and retains the open-session explanation where applicable. All 392 UI tests,
  typecheck and the production build pass.

#### M12-T28 notes
- 2026-09-06 claimed: add accessible drag ordering to the project circles and
  persist the same host-owned order consumed by the grouped sessions sidebar.
- 2026-09-06 checkpoint: `pi/project/reorder` now saves canonical priority in
  the host. The rail updates optimistically; project visibility preserves the
  returned order, which `sessionGroups` already consumes directly.
- 2026-09-06 done: pointer, touch and keyboard sorting share one host-owned
  order across the rail and grouped sessions list. Partial/stale client orders
  cannot lose projects; persistence survives registry reload. Full 862-test
  build, typecheck and test gate passes.

#### M12-T29 notes
- 2026-09-06 claimed: add a dedicated accessible drag handle to dock panels,
  use the existing morphing layout for slot changes, and remember each
  session's order. Attention-ranked chats and chronological views stay sorted
  by their semantics rather than gaining conflicting manual order.
- 2026-09-06 checkpoint: dock islands now have a dedicated grip backed by
  pointer, delayed-touch and keyboard sensors. Slot order uses the existing
  morph layout and is stored per session alongside sizes and dividers.
- 2026-09-06 done: every visible dock island can move between canvas slots by
  grip or keyboard without changing panel identity, size or body state. Order
  restores per browser session. Full 862-test build, typecheck and test gate
  passes; the development server remains stopped as requested.

#### M12-T30 notes
- 2026-09-06 claimed: replace the narrow component literals with wider
  semantic thread and prose measure tokens shared by chat, goals and previews.
- 2026-09-06 done: the centered thread and goal row use an 84ch semantic
  measure; transcript and prose previews use 80ch. The values compile through
  every theme and collapse naturally to the available phone width.

#### M12-T31 notes
- 2026-09-06 claimed: make all adjacent tool calls one chronological activity
  group, enrich its collapsed row with counted action categories, and preserve
  the existing full tool rows when expanded.
- 2026-09-06 checkpoint: a running group replaces the settled breakdown with
  the assistant-ui thinking indicator and the exact live action target; the
  counted category summary returns as soon as the run settles.
- 2026-09-06 done: all adjacent calls now share one chronological parent.
  Settled mixed work shows counted, icon-led families in first-seen order;
  active work names the current file, command, pattern or directory; expansion
  preserves every prior detail row. Full workspace gate passes.

#### M12-T32 notes
- 2026-09-06 claimed: apply the transcript's shared hover/focus reveal behavior
  to message timestamps while retaining coarse-pointer and screen-reader access.
- 2026-09-06 done: user, assistant and notice times are quiet at rest, reveal
  from the whole row on mouse hover or keyboard focus, and remain visible on
  coarse pointers. Day separators and turn timing remain unchanged.

#### M12-T33 notes
- 2026-09-06 claimed: remove the desktop-only footer beneath the composer and
  make the existing settings reference explicit as Help and shortcuts.
- 2026-09-06 done: chat no longer reserves a footer for repeated git and key
  hints; Help and shortcuts is the durable home for composer guidance.

#### M12-T34 notes
- 2026-09-06 claimed: preserve the installed assistant-ui Shiki element while
  replacing its restricted regex engine, normalizing model-written fence
  labels, broadening theme scopes and proving the full bundled catalog.
- 2026-09-06 done: settled Markdown fences use Oniguruma and every Shiki
  bundled language or alias, tolerate common model fence-label variants, and
  map a broader set of TextMate scopes into Laser's semantic syntax tokens.
  All 402 UI tests, typecheck, production build and the full 869-test workspace
  gate pass; grammar and engine assets remain lazy chunks.

#### M12-T35 notes
- 2026-09-06 claimed: make the desktop fleet carry the catalog's first-message
  title fallback and remove “Untitled session” from native notification copy.
- 2026-09-06 done: desktop notifications now share the explicit name or first
  user-message title visible in Laser, with neutral session copy when neither
  exists. Fleet and notification regressions pass in the full workspace gate.

#### M12-T36 notes
- 2026-09-06 claimed: partition fleet root subtrees into In progress and
  Finished sections while preserving every parent/child relationship.
- 2026-09-06 done: active work is prominent, terminal work is collapsible, and
  a workflow remains intact until its whole descendant tree has settled. Existing
  status rows preserve the distinctions between done, failed and cancelled.

#### M12-T37 notes
- 2026-09-06 claimed: set the single workspace version to 0.2.2, commit and tag
  the verified experience batch, then observe the complete release and package-
  feed workflow before calling the patch published.
- 2026-09-06 checkpoint: the first tag run stopped before packaging because the
  new notification test hard-coded the product name. The earlier local gate ran
  while that file was untracked, and the identity scanner considered tracked
  files only. The test now derives identity, the scanner includes untracked
  non-ignored source, and AGENTS.md records the prevention rule.
- 2026-09-06 done: corrected workflow 34029183501 built both architectures,
  passed the staged real-install gate, signed and attested the artifacts,
  published the stable GitHub release, and deployed the APT and DNF feeds.

#### M12-T38 notes
- 2026-09-06 claimed: give reasoning and tools one assistant-ui activity group,
  preserve the full expanded timeline, and distinguish its compact summary with
  the transcript's muted surface vocabulary.
- 2026-09-06 done: reasoning and tool calls now share the muted assistant-ui
  disclosure, count thought once, announce live thinking or the exact active
  tool, and restore every reasoning/tool detail in chronological order on open.

#### M12-T39 notes
- 2026-09-06 queued: publish the focused activity refinement as 0.2.3 without
  waiting for the independent 0.2.2 tag workflow.
- 2026-09-06 claimed: set the single workspace version to 0.2.3, run the release
  gate, push main and the stable tag, then verify artifacts and update feeds.
- 2026-09-06 done: workflow 34029935117 built and staged both architectures,
  published the stable GitHub release with signatures and provenance, and
  deployed the native APT and DNF update feeds.

#### M12-T40 notes
- 2026-09-07 research follow-up (codex-2026-09-07-quota-research): reproduced the installed module's exact reconnect error with a valid existing credential. `/backend-api/codex/usage` returns a 403 HTML security challenge; `/backend-api/wham/usage` returns 200 with the same credential and is accepted by the parser. The first 403 prevents the fallback. Additional quota buckets are dropped and the app-server duration fixture uses the wrong field. Official app-server API and direct-repair tradeoffs recorded in `docs/account-usage-research.md`. Diagnosis only: no product code/auth/process changes, push or release; repair awaits authorization.
- 2026-09-06 claimed: expose OpenAI Codex allowance from the existing Pi OAuth
  session, classify persisted turns by billing mode, and make the telemetry
  section adapt between API, account and mixed views.
- 2026-09-06 research: pinned Pi 0.85 marks OpenAI Codex as a subscription but
  only totals tokens and API-equivalent cost; it does not expose account quota
  windows or credits. OpenAI Codex app-server and two MIT Pi integrations prove
  the read-only account endpoint and normalized data model.
- 2026-09-06 checkpoint: include every subagent's own model-attributed usage in
  its parent's billing view, including the mixed subscription-parent/API-child
  case; plan aggregates must not double-count their run children.
- 2026-09-06 done: the Pi-native module keeps OAuth secrets inside the worker,
  the protocol carries only normalized allowance windows, and telemetry adapts
  between account, API and mixed views with an explicit refresh action.

#### M12-T41 notes
- 2026-09-06 claimed: replace the binary reasoning preference with three
  session-scoped disclosure levels and apply them through the existing unified
  reasoning/tool activity parent and established detail renderers.
- 2026-09-06 done: Answers only, Show reasoning and Show everything now control
  the same aggregate parent and established inner rows per session; errors and
  decisions still force visibility.

#### M12-T42 notes
- 2026-09-06 claimed: make the assistant-ui model menu derive its initial
  provider scope and selected row from the active session, resetting only a
  person's temporary filters when the menu closes.
- 2026-09-06 done: provider scope derives from the selected model before the
  menu opens, the active row remains checked, and temporary filters clear on
  close without changing the session selection.

#### M12-T43 notes
- 2026-09-06 claimed: advance the single workspace version to 0.2.4, rerun the
  release gate, push the version commit and stable tag, then verify GitHub
  artifacts, signatures, provenance and APT/DNF publication.
- 2026-09-06 checkpoint: confirmed and regression-tested that a session with no
  saved preference starts in Answers only, with every activity aggregate,
  reasoning block and tool body collapsed.
- 2026-09-06 blocked: the user requested an opinion on a denser transcript
  before implementation and asked that 0.2.4 publish only after that decision.
  Release run 34032180101 was cancelled before publication and the unpublished
  local/remote tag was deleted. Q-7 unblocks the final source and tag.
- 2026-09-06 resumed: the user approved the proposed compact transcript and
  asked to implement and push it; M12-T44 now gates the recreated v0.2.4 tag.
- 2026-09-06 done: stable v0.2.4 published from `3e5b89a`; x64 and ARM64
  builds, staged installation, repository signing, provenance, GitHub assets,
  and APT/DNF deployment all passed in release run 34034100668. GitHub marks
  it as the non-draft, non-prerelease latest release with all 12 assets.

#### M12-T44 notes
- 2026-09-06 claimed: move only transcript prose to the shared 14px body scale,
  tighten message/block/bubble rhythm through existing spacing tokens, and
  preserve every control size, touch target and accessibility floor.
- 2026-09-06 done: assistant and user prose now share the 14px body scale;
  messages use a 20px rhythm and Markdown blocks and prompt bubbles are one
  spacing step tighter. Controls, metadata, composer, 80ch measure and 12px
  floor are unchanged. `pnpm verify` passed 891 tests; the live session was
  inspected at 1600×1000 and 390×844 in dark and light themes.

---

#### M12-T45 notes
- 2026-09-06 claimed: reproduce broken activity toggles, restore independent
  reasoning/action disclosures and share one muted row treatment throughout.
- 2026-09-06 checkpoint: reasoning was a static section; the middle preference
  opened its aggregate contrary to the requested rule; waiting tools OR-ed their
  status over manual collapse; `bg-surface-1` had no token mapping. All are fixed.
  Single actions no longer have redundant parents, and totals count rendered
  reasoning rows. Eight DOM interaction tests pass, including live rerenders and
  approval visibility; real pointer and Enter toggles are being checked.
- 2026-09-06 done: real pointer and Enter open and close parent/child rows;
  desktop and phone in both themes reviewed. Added a shared token-led live beam
  beneath thinking/tool labels, pointer-transparent with a static reduced-motion
  fallback; browser computed animations stop under reduced motion.

#### M12-T46 notes
- 2026-09-06 claimed: reuse host request captures, add exact prompt attribution
  at the Pi hook and a shared large inspector reached from message and log menus.
  Requests remain redacted; historical gaps are shown honestly, never reconstructed.
- 2026-09-06 checkpoint: shared message-menu/log-detail inspector is implemented.
  Real retained 165 kB requests inspected on desktop/phone in both themes. Tests
  cover provider-neutral sections, JSON preservation, exact and legacy linkage,
  database upgrade, large redacted payloads, modal navigation and missing bodies.
  A real host → built worker → stub provider request proves prompt attribution.

#### M12-T47 notes
- 2026-09-06 claimed: version 0.2.5 is synchronized across workspace manifests;
  intended new files are staged, identity check passes, and the full gate runs
  before committing. Wait for clean branch CI before creating the immutable tag.
- 2026-09-06 checkpoint: full build, typecheck and all 918 tests pass; installer
  fixture gate passes 76 checks. Real session probe opens all bundled features,
  lists 1,336 models and accepts quota refresh. Release pipeline will repeat the
  packaged clean-machine and real-install gates independently for x64 and ARM64.
- 2026-09-06 checkpoint: release source `05539dc` is on main. Clean CI
  `34037703812` passed before tag `v0.2.5` was pushed. Release workflow
  `34037802194` is building both architectures; no publication claimed yet.
- 2026-09-06 done: workflow `34037802194` passed both native builds, packaged
  session checks, staged installation, signing, provenance, publication and feed
  deployment. GitHub lists v0.2.5 as Latest, not draft/prerelease, with 12 assets.
  Public APT amd64/arm64 and RPM x86_64/aarch64 metadata all advertise 0.2.5.
  Release page: https://github.com/youssefsiam38/laser/releases/tag/v0.2.5 .
  Published notes explain full quit after updating, quota version mismatch and
  capture limitations. Review servers are stopped; host PID 333618 and the user's
  running sessions remain untouched. Only the user's untracked `fixes.md` remains.

#### M12-T48 notes
- 2026-09-06 claimed: inspect the reported unknown quota method before publishing.
  Confirmed local host PID 333618 records CLI 0.2.0 while installed protocol and
  worker files are 0.2.4 and contain the method. Loaded processes survive package
  replacement; desktop currently attaches to any healthy host without a version
  check. Preserve running work; add a mismatch guard and clear recovery guidance,
  quota refresh/auth-error tests, and a real host-to-worker routing regression.
- 2026-09-06 checkpoint: mismatch adoption guard and actionable refresh error
  implemented; module auth exceptions now leave loading and support retry. Tests
  prove initial quota, manual refresh, no credential leakage, failure recovery,
  public host routing and packaged-session refresh acceptance. No existing app,
  daemon or session was restarted. Review Vite and headless browser are stopped.

#### M12-T49 notes
- 2026-09-06 claimed: trace Pi's own ResourceLoader and slash-command catalogue,
  then restore skills without reimplementing their semantics; keep completion
  bounded, searchable and lossless for the rest of the draft.
- 2026-09-07 checkpoint: the regression had three causes: Laser disabled Pi's
  normal skill roots, hid manual-only skills, and replaced Pi's ordered-character
  command matching. The worker now passes only explicit Laser/Agent Skills roots
  to Pi, including curated bundled features and never `.pi`; a disposable
  project worker supplies the catalogue before a first session exists.
- 2026-09-07 done: new and existing sessions list the complete headless-runnable
  catalogue; `/skbr` finds `/skill:brandkit`, and Tab produces
  `/skill:brandkit keep every word` without touching the suffix. Mouse, keyboard,
  bounded scrolling, desktop/phone and both themes were reviewed.

#### M12-T50 notes
- 2026-09-07 claimed: reproduce the message inspector failure on the user's
  unchanged running host, then correct the update lifecycle and add the requested
  plain/Markdown transcript preference without restarting production work.
- 2026-09-07 checkpoint: `/opt` contains 0.2.5 files while Electron and the host
  have 0.2.0 JavaScript loaded. The old host rejects the new log-query keys;
  the cause is a package upgrade replacing files without reloading the process.
- 2026-09-07 checkpoint: rejected the temporary old-schema UI fallback. Native
  deb/rpm upgrades now send SIGHUP only to the exact packaged daemon after files
  are installed; its existing graceful shutdown lets the desktop supervisor
  restart it from the new bundle. A later app start also replaces any mismatched
  recorded daemon before connecting. No migration or compatibility layer added.
- 2026-09-07 done: the request inspector has no old-host protocol branch.
  Instructions and Conversation default to Plain and switch to the exact chat
  `MarkdownText` renderer; the choice persists in host-owned machine preferences.
  Full build, typecheck and all 925 tests pass; shellcheck reports only the two
  intentional electron-builder placeholders. Production PID 1348853 and daemon
  1348958 were inspected but never signalled or restarted.

#### M12-T51 notes
- 2026-09-07 done: commit `d75085e` and immutable `v0.2.6` pushed atomically to origin. Public stable release page created at https://github.com/youssefsiam38/laser/releases/tag/v0.2.6 with curated notes and `--latest=false`; the artifact workflow promotes it only after installers are uploaded. Per direct user instruction, no Actions status was fetched, no monitoring was started, and artifact/feed success is not claimed. This completes the dispatch handoff H-3. Production was not restarted; only user-owned `fixes.md` remains untracked.
- 2026-09-07 final checkpoint: `pnpm verify` exits 0 with 954 tests on the complete 0.2.6 batch (`/tmp/laser-026-final-verify.log`). Identity and whitespace checks pass; final search browser review covers both themes and widths. Isolated sandbox and browser stopped, production untouched. Dispatch the exact source and tag, create the release page without premature Latest promotion, and do not monitor Actions.
- 2026-09-07 claimed follow-up: preserve the visible transcript anchor when the
  session activity preference expands or collapses content before release.
- 2026-09-07 claimed: synchronize the single workspace version at 0.2.6,
  validate the exact release source, commit and push main, then create the stable
  GitHub release and immutable tag without monitoring the workflow, as directed.
- 2026-09-07 checkpoint: full 0.2.6 build/typecheck/925-test gate passed before
  the late scroll fix. The final UI build/typecheck and 440 UI tests pass (927
  workspace tests in total). Browser review measured zero final pixel drift
  while switching activity detail at desktop and phone widths, dark and light.
  The anchor follows a visible paragraph or row through the disclosure animation
  and yields immediately to scrolling input. A real-browser failure caught a
  slow React commit consuming the animation window; the window now starts at
  the first post-commit frame, with a regression test for that exact delay.

#### M12-T52 notes
- 2026-09-07 claimed follow-up: remove the horizontal gap between an activity
  row's background and live beam; measure aggregate, reasoning and tool edges.
- 2026-09-07 claimed: trace per-part reasoning/tool lifecycle and the shared
  activity beam; stop stale reasoning glow during tool execution, and illuminate
  both the running child and its aggregate with the exact action label.
- 2026-09-07 checkpoint: two concrete causes reproduced. The projection put
  partial output in assistant-ui's terminal `result` field, stopping the beam
  after the first progress chunk. `GroupedParts` defaulted to `no-text`, which
  synthesized another Thinking indicator after tools. Progress now uses the
  native UI-only artifact channel; initial waiting is neutral and reasoning
  owns its actual streaming state. Known and unknown tools share the exact live
  label, a stronger token-colored sweep and a reduced-motion static accent.
- 2026-09-07 checkpoint: the opt-in sandbox activity prompt runs a real worker
  reasoning-to-command-to-answer sequence. Both live rows stayed lit during
  progress, reasoning stayed quiet, animation transforms changed over time,
  and completion removed both beams. Desktop/phone, dark/light and reduced
  motion were inspected without touching the production app.
- 2026-09-07 done: 443 UI tests pass, including native runtime projection through
  partial output, aggregate/child motion, completion and the no-extra-thinking
  transcript contract. The prior full workspace gate plus the final UI suite
  covers 930 tests. All isolated test processes were stopped after review.

#### M12-T53 notes
- 2026-09-07 claimed: restyle the existing assistant-ui thread list as a compact
  folder tree; add persisted session pins without duplicate rows, remove the
  sidebar inbox and aggregate project attention, and verify live row indicators.
- 2026-09-07 done: native-runtime rows have persistent pin order, one canonical
  location, 12px project labels and full-path tooltips. Browser review covered
  both themes and widths, 44px touch rows, live/settled status, reduced motion,
  and pins surviving reload. The duplicate inbox component is deleted; its prior
  implementation remains in Git history.
- 2026-09-07 final verification: 448 UI tests, UI build, workspace typecheck,
  identity and whitespace checks pass. T52's padding moved from the outer row
  to its trigger: reasoning, aggregate and tool beams measured zero left/right
  gaps. Isolated sandbox/browser stopped; production app not restarted.

#### M12-T54 notes
- 2026-09-07 claimed: add read-only full-history search, browser-style current-session find and contained sidebar excerpts. Escape characters remain unchanged at the user's request; no summary feature is being added.
- 2026-09-07 checkpoint: host streaming search paginates saved content without opening workers. Global and sidebar search begin at 30 days and expand through explicit older date ranges. Best-match excerpts and ordering prioritize user messages, assistant replies, then reasoning/tools, with recency only breaking ties. Selection carries the excerpt source into session find.
- 2026-09-07 verification checkpoint: 460 UI tests and typecheck pass; browser testing caught off-screen `content-visibility` preventing precise highlight geometry. Selected messages now opt into layout, search highlights use DOM ranges without editing React-owned markup, and closing find restores disclosure state. Final responsive/theme review and the workspace release gate follow.
- 2026-09-07 done: workspace build and typecheck plus all 954 tests pass (460 UI, 168 host, 29 protocol). Added the missing protocol inventory sample caught by the complete gate. Isolated browser proof covers source ranking despite reversed recency, explicit older expansion, arrow/Enter selection, Enter/Shift+Enter match navigation, Escape/focus restoration, folded tool matches, reduced motion and zero horizontal overflow at 1280×900 and 390×844 in both themes. Evidence: `/tmp/laser-global-desktop-light.png`, `/tmp/laser-global-phone-dark.png`, `/tmp/laser-find-phone-dark-final.png`, `/tmp/laser-026-search-tests.log`. No transcript escape conversion or future summarization was added.

#### M12-T55 notes
- 2026-09-07 claimed: remove the visual and semantic day-divider component from every message path while retaining per-message local timestamps and their full accessible date descriptions.
- 2026-09-07 done: deleted the day-divider component and boundary selector instead of merely hiding them. The remaining `message-timestamp` element is mounted for user, assistant and notice messages and retains its full natural date label. All 458 UI tests, typecheck, build, identity and whitespace checks pass. Browser review at 1280×900 and 390×844 in light/dark found zero separator nodes, two timestamp nodes, and no horizontal overflow; evidence: `/tmp/laser-no-day-desktop-dark.png`, `/tmp/laser-no-day-desktop-light.png`, `/tmp/laser-no-day-phone-dark.png`, `/tmp/laser-no-day-phone-light.png`. Isolated preview processes stopped; production was untouched. No commit, push, version change or release was requested.

#### M12-T56 notes
- 2026-09-07 claimed: replace serialized tool payload indexing with shared content projections and align DOM highlights with searchable values; document the extension point for future renderers.
- 2026-09-07 checkpoint: shared projections now feed host and session find. The existing bounded diff transform moved unchanged into the neutral package so omitted lines cannot become phantom matches. Tool JSON highlights opt into value regions, nested JSON and terminal elision reveal transiently, and live result envelopes display the same content as hydration.
- 2026-09-07 done: all 959 workspace tests and workspace typecheck pass; protocol, host and UI build successfully. Isolated browser fixtures prove the key-only session is absent globally and has no local matches; actual commands/output remain hits; three nested JSON values highlight without their identical keys and next/previous navigation works. Desktop/phone, light/dark checks show no horizontal overflow. Evidence: `/tmp/laser-search-values-tests.log`, `/tmp/laser-search-values-global.png`, `/tmp/laser-search-values-desktop-light.png`, `/tmp/laser-search-values-phone-dark.png`. Contract: `docs/search-content.md` and AGENTS.md. QA processes stopped; production untouched; no push, tag or release.

#### M12-T57 notes
- 2026-09-07 claimed: replace field filtering with scoped in-place find and literal full-request JSON search; reuse the conversation search element while keeping diagnostic key/value search separate from chat semantics.
- 2026-09-07 checkpoint: instruction text and Markdown highlight in place; full search exposes syntax-highlighted retained JSON and matches keys, values and syntax. Native ranges remain independent from session highlights. Keyboard tests caught Radix consuming Escape before the input; the modal now explicitly closes find first. Browser proof on an isolated real captured request locates 18 nested schema-key hits with zero underlying-session scroll movement.
- 2026-09-07 done: 465 UI tests, UI typecheck/build and identity guard pass. Duplicate-count regression proves Instructions and Conversation each count their source occurrence once, while Full request and Full JSON each count the two genuine payload occurrences once, never the combined tab presentations. Desktop/phone and light/dark browser reviews show visible highlights, next/previous navigation and no horizontal overflow. Evidence: `/tmp/laser-request-find-tests.log`, `/tmp/laser-request-find-desktop-dark.png`, `/tmp/laser-request-find-desktop-light.png`, `/tmp/laser-request-find-phone-light.png`, `/tmp/laser-request-find-phone-dark.png`. Isolated QA server/browser stopped; production untouched; no push, tag or release.

#### M12-T58 notes
- 2026-09-07 claimed: infer file language once from the read/write/edit path, reuse the installed standalone Shiki element, and preserve the existing diff/search DOM contract.
- 2026-09-07 checkpoint: read results now use the standalone source highlighter; edit/write tokenize displayed lines lazily and layer the tokens inside the existing two-gutter diff rows. Unknown extensions retain the plain fallback, and file-tool content remains opted into conversation search.
- 2026-09-07 done: all 467 UI tests, UI typecheck, production build and `git diff --check` pass. Isolated browser review at 1280×720 and 390×844 in dark/light shows nine distinct source-token colours, intact add/delete backgrounds and gutters, internal horizontal scrolling, and zero page overflow. No commit, push, version change or release was requested.

#### M12-T59 notes
- 2026-09-07 claimed: replace the confirmed failing first route, distinguish recovery messages, retain quota bucket identity and add source-shaped coverage before an authenticated smoke test.
- 2026-09-07 done: direct verified route, Pi-owned auth, explicit independent bucket parsing, bounded responses and actionable failure states implemented. Full build/typecheck/979 tests pass. Rebuilt-module initial and manual refresh both return HTTP 200 with four windows in three buckets, each with durations/resets; emitted states contain no credential fields. Existing credentials were read only, never rotated or written. Actual quota cards reviewed at 1280×900 and 390×844 in dark/light with no overflow; evidence `/tmp/laser-027-quota-{desktop,phone}-{dark,light}.png`. Temporary QA server/browser removed after review; installed app untouched.

#### M12-T60 notes
- 2026-09-07 claimed: include the user's completed highlighting and accumulated search fixes; run the workspace gate, push the release commit/tag and create the release without monitoring Actions. Unrelated scratch files remain untouched.
- 2026-09-07 checkpoint: all workspace versions are 0.2.7. Initial full gate passed build/typecheck/979 tests; authenticated rebuilt-module verification passed twice and four-layout quota review is complete. Staging release-owned changes before repeating the gate. Independent M3-T10 guide/planning edits and user scratch remain outside this release. User explicitly overrides the usual CI-wait step: dispatch only, no Actions polling.
- 2026-09-07 done: staged full build/typecheck/979-test gate passed again (`/tmp/laser-027-staged-verify.log`); commit `e1fd1fe` and annotated tag `v0.2.7` pushed atomically. Stable release page created at https://github.com/youssefsiam38/laser/releases/tag/v0.2.7 with update guidance, quota fix and user highlighting. The page is deliberately not Latest until the existing release workflow uploads verified installers and updates feeds. Actions were neither waited on nor monitored, as requested; installer availability is not claimed. All temporary QA processes stopped; unrelated guide/planning edits and scratch files remain uncommitted.

#### M12-T61 notes
- 2026-09-07 claimed: reuse the adopted QuotaBanner for linked windows, add reset-display choice and keyboard/touch help, and research provider meanings without guessing undocumented reserve semantics. UI-only change; no new release requested.
- 2026-09-07 revised from user feedback: keep the chat rail compact and exclude undocumented buckets. Add Settings → Usage as the full dynamic view, including reserve, unknown buckets and credits. Both views share grouping, help, reset formatting and the host-persisted display choice; no second data parser.
- 2026-09-07 checkpoint: compact/full allowance components reviewed at desktop and phone widths in both themes; related windows, unknown buckets, exact dates, keyboard radio selection and dismissible source-linked help verified. No horizontal overflow. Preference persistence and full settings wiring have regression coverage. Final UI gate pending.
- 2026-09-07 done: 480 UI tests, UI typecheck and production build pass (`/tmp/laser-quota-ux-final-{tests,build}.log`). Compact and full components reviewed at 1280×900 and 390×844 in dark/light (`/tmp/laser-quota-ux-{chat,settings}-{desktop,phone}-{dark,light}.png`); keyboard radio navigation and Escape/focus restoration pass. Settings wiring, unknown-bucket retention and host-stored preferences have regression tests. Temporary QA files/server/browser removed; installed app untouched. Version remains 0.2.7; no push, tag or release requested.

## M13 · Agents Leap

| ID | Task | State | Owner | Evidence | Notes |
| --- | --- | --- | --- | --- | --- |
| M13-T1 | Protocol: agents vocabulary and methods | done | claude-2026-09-08-agents | `pnpm -F @lasercode/protocol build && pnpm -F @lasercode/protocol test` — 35 tests; `packages/protocol/src/agents.ts` | see notes |
| M13-T2 | Host: agent store, validation, run registry, routing, attribution, workspaces | done | claude-2026-09-08-agents | host 214 tests; wire-level delegation scene (notes) | see notes |
| M13-T3 | Worker harness, worktrees, per-agent sessions, Namer, Beam skill | done | claude-2026-09-08-agents | worker 190 tests + 1 skipped incl. the golden real-engine delegation test | see notes |
| M13-T4 | Companion extension: harness tools and background work | done | claude-2026-09-08-agents | pi-extension 50 tests | see notes |
| M13-T5 | UI: agents store and Agents page | done | claude-2026-09-08-agents | `pnpm -F @lasercode/ui test` — 676 tests (28 for the page); browser review desktop/phone, dark/light | see notes |
| M13-T6 | UI: sub-sessions, tabs, end-agent modal, projections | done | claude-2026-09-08-agents | UI tests 676 incl. sessions-tabs (5), end-agent-dialog (4), agent-projections (7); browser review | see notes |
| M13-T7 | UI: React Flow live map | done | claude-2026-09-08-agents | UI tests 676 incl. `test/agents/map/*` (21); browser review at four compositions | see notes |
| M13-T8 | UI: Beam spark and bubble, Chat area | done | claude-2026-09-08-agents | UI tests 676 incl. `test/beam/*` (21); browser review desktop/phone | see notes |
| M13-T9 | Packaging and runtime integration | done | claude-2026-09-08-agents | packaged clean-machine gate: every claim held (notes) | see notes |
| M13-T10 | Integration verification | done | claude-2026-09-08-agents | full workspace gate + packaged gate + browser review (notes) | see notes |
| M13-T11 | Remove the retired pi-subagents file layer | done | claude-2026-09-09-agents | build + 1,522 tests + identity; `laser doctor` and the sandbox exercised | D-140; see notes |
| M13-T12 | Keep `.laser` overrides through engine resource reloads | done | claude-2026-09-09-agents | `worker/test/settings-overrides.test.ts` (11) | D-155; see notes |
| M13-T13 | Workspaces the host owns, and a Beam chat that survives its folder | done | claude-2026-09-08-agents | full gate green; new host/worker/UI regressions (notes) | reported by the user from the review container |
| M13-T14 | Run setup again starts setup | done | claude-2026-09-08-agents | `packages/ui/test/onboarding/run-setup-again.test.tsx`; full gate; browser review | reported by the user |
| M13-T15 | Two ways into Beam, a maximize that starts a chat, and the microphone in every composer | done | claude-2026-09-08-agents | Beam, sessions-tabs and dictation-scope tests; full gate; desktop and phone browser review | reported by the user |
| M13-T16 | Tools leave the definition; runs have no time limit | done | claude-2026-09-08-agents | full gate; new harness, session-config, worker-pool and runs tests | requested by the user |
| M13-T17 | Model pickers list connected providers only | done | claude-2026-09-08-agents | `connected-models.test.ts`; worker real-engine cases; full gate; browser review | reported by the user |
| M13-T18 | Goal tools only while a goal is in play | done | claude-2026-09-08-agents | worker real-engine `goal-tools.test.ts`; pi-extension gate tests; pinned names; full gate | asked and approved by the user |
| M13-T19 | A blank agent form opens on a state it can save | done | claude-2026-09-08-agents | Agents page and model tests; full gate; browser save | reported by the user |
| M13-T20 | The model picker opens with the caret in its search | done | claude-2026-09-08-agents | `model-picker-focus.test.tsx`; full gate; browser review | requested by the user |
| M13-T21 | Every built-in agent's model is the person's to choose | done | claude-2026-09-09-agents | fa3ebd4, 99fe699; `agents/builtin/set-model`; `packages/ui/test/agents/**` | see notes |
| M13-T22 | Namer actually names, and says what an action is doing | done | claude-2026-09-09-agents | fa3ebd4, 99fe699; `packages/worker/test/agents/session-naming.test.ts` | see notes |
| M13-T23 | A child's transcript opens with the task its parent sent | done | claude-2026-09-09-agents | fa3ebd4, 99fe699; child transcript opens with the task (browser: explorer's chat shows "Task from delegate") | see notes |
| M13-T24 | Sub-sessions fold, and finished ones fold again | done | claude-2026-09-09-agents | 99fe699; `packages/ui/test/shell/session-folds.test.tsx`; sidebar fold with a dimmed finished fold (browser 2026-09-09) | see notes |
| M13-T25 | Open chat on a run island opens the chat | done | claude-2026-09-09-agents | 99fe699; folded into the fleet's Open chat (`FleetPanel.tsx` `DetailActions`), browser 2026-09-09 | see notes |
| M13-T26 | The panels come out; the fleet becomes a column | done | claude-2026-09-09-agents | 99fe699 (D-147); `docs/ux-fleet.md`; no `panels/**` left | see notes; D-147 |
| M13-T27 | Re-opening an open session doubles its transcript | done | claude-2026-09-09-agents | 99fe699; `packages/ui/test/runtime/reopen.test.tsx`-style fake replay test in `runtime` tests; re-opening delegate after its child, and a reload, showed one transcript (browser 2026-09-09) | see notes |
| M13-T28 | A queued message you can steer, drop or leave | done | claude-2026-09-08-agents | `worker/test/pending.test.ts`; `ui/test/thread/message-queue.test.tsx`; browser | see notes; D-149 |
| M13-T29 | A non-zero shell exit stops shouting | done | claude-2026-09-08-agents | `test/thread/quiet-shell-failures.test.tsx`; 168 UI tests | see notes; D-148 |
| M13-T30 | A background command is not an agent | done | claude-2026-09-08-agents | `test/fleet/panel.test.tsx` (9 tests) | see notes |
| M13-T31 | Finished work is dimmed, never green | done | claude-2026-09-09-agents | `ui/test/agents/model.test.ts`; `ui/test/fleet/panel.test.tsx`; browser both themes | see notes; D-154 |
| M13-T32 | One opening screen, not two | done | claude-2026-09-08-agents | `ui/test/startup-screen.test.ts`; `desktop/test/startup-screen.test.ts`; Electron render compare | see notes; D-150 |
| M13-T33 | An edit to a file that moved under you is refused | done | claude-2026-09-08-agents | `pi-extension/test/file-freshness.test.ts` (27 of 83) | see notes; D-151 |
| M13-T34 | The goal-tools test is flaky under load | done | claude-2026-09-08-agents | `goal-tools.test.ts`; 3 isolated + 2 full-suite runs green | see notes |
| M13-T35 | Editing history changes this session, not a copy | done | claude-2026-09-08-agents | `ui/test/thread/edit-in-place.test.tsx`; `ui/test/runtime/edit-in-place.test.tsx`; browser | see notes; D-153 |
| M13-T66 | Release stable 0.3.0 | done | claude-2026-09-09-agents | `7e068e3`; clean CI 34331351877; pushed `v0.3.0`; draft [release](https://github.com/youssefsiam38/laser/releases/tag/v0.3.0) with notes; publication pipeline 34331715953 dispatched | requested by the user; D-167; see notes |
| M13-T67 | Built-in instructions and model are editable | done | codex-2026-09-10-builtins | protocol 30; host 204; worker 314 + 1 skipped; UI 926; typecheck/build; browser desktop/phone, dark/light | requested by the user; D-168; see notes |
| M13-T68 | Telemetry has a recognizable toggle icon | done | codex-2026-09-10-transparency | UI 928; UI build; browser desktop/phone, dark/light | requested by the user; D-169; see notes |
| M13-T69 | Default instructions identify as Laser | done | codex-2026-09-10-transparency | worker 315 + 1 skipped; real-engine prompt test; worker/pi-extension builds; browser | requested by the user; D-169; see notes |
| M13-T70 | Same-definition child agents are explicit | done | codex-2026-09-10-transparency | host 206; worker 315 + 1 skipped; UI 928; browser interaction | requested by the user; D-170; see notes |
| M13-T71 | Custom agents can be renamed safely | done | codex-2026-09-10-transparency | protocol 30; host 206; worker 315 + 1 skipped; UI 928; typecheck/build; browser interaction | requested by the user; D-171; see notes |
| M13-T72 | Default prompt is Laser-owned and engine-neutral | done | codex-2026-09-10-independent | worker 311 + 1 skipped; live-request prompt test; UI build; browser | requested by the user; D-172; see notes |
| M13-T73 | Skills are discovery-only | done | codex-2026-09-10-independent | protocol 31; host 206; worker 311 + 1 skipped; UI 928; builds | requested by the user; D-172; see notes |
| M13-T74 | Beam spark always starts fresh | done | codex-2026-09-10-independent | UI 928; `beam/bubble.test.tsx`; desktop/phone, dark/light | requested by the user; D-173; see notes |
| M13-T75 | Release stable 0.3.1 | done | codex-2026-09-10-release | `d382807`; CI `34435355237`; release `34435577548` | requested by the user; D-174; see notes |
| M13-T76 | Click-insert variables for agent instructions | done | codex-2026-09-10-prompt-namer | `pnpm verify`; protocol 41 + UI 934 tests | D-175; see notes |
| M13-T77 | Reliable Namer model qualification | done | codex-2026-09-10-prompt-namer | `pnpm verify`; worker 313 + host 208 tests | D-176; see notes |
| M13-T78 | Beam maximize selects Code | done | codex-2026-09-10-prompt-namer | UI 934 tests + browser desktop/phone | D-177; see notes |
| M13-T79 | Per-session Beam and Chat workspaces | done | codex-2026-09-10-prompt-namer | `pnpm verify`; browser desktop/phone | D-178; see notes |
| M13-T80 | Tab switch restores its last session | done | codex-2026-09-10-prompt-namer | UI 934 tests + browser pointer navigation | D-177; see notes |
| M13-T81 | Quiet provider retry recovery | done | codex-2026-09-10-prompt-namer | `store` + projection retry regressions; `pnpm verify` | D-180; see notes |
| M13-T82 | Release stable 0.3.2 | done | codex-2026-09-10-release-032 | `f2cf2b6`; CI `34444740409`; release `34444969521` | requested by the user; D-181; see notes |
| M13-T83 | Refuse phantom resumes and internal-storage projects | done | beam-state-project | host/worker/UI builds; `pnpm -r typecheck`; 1,464 host/worker/UI tests | D-182; see notes |
| M13-T84 | Make composer recording and compact disclosures usable | done | beam-composer | 957 UI + 215 host tests; workspace typechecks; UI/host builds; Chromium review | D-183; see notes |
| M13-T85 | Release stable 0.3.3 | done | beam-release-033 | `ff880cd`, `5e7e267`, `v0.3.3`; CI 34459385794; release 34459703018; 12 assets and live signed feeds verified | D-184; see notes |
| M13-T86 | Choose the top-level agent and thinking level before the first turn | done | beam-session-agent-picker | isolated `pnpm identity:check` + `pnpm verify`; 968 UI tests; Chromium draft round-trip | D-185; see notes |
| M13-T87 | Replace session-sidebar status tags with compact visual state | done | beam-session-agent-picker | 17 sidebar interaction tests; isolated `pnpm verify`; Chromium fold/unread review | D-186; see notes |
| M13-T88 | Release stable 0.3.4 | done | beam-release-034 | `v0.3.4` at `62839fe`; source CI 34471150534 and release 34471617236 passed; 12 published assets | D-187; see notes |
| M13-T89 | Make pre-turn agent choice tentative until first send | done | claude-2026-09-11-stabilize | lane `c42524a` merged `f47d96b`; `pnpm -F @lasercode/ui test -- test/runtime/adapter-not-sent.test.tsx test/runtime/first-turn.test.tsx test/thread/first-turn-refusal.test.tsx`; `/tmp/laser-ui-acceptance-repro-first-turn-refusal.mjs` exit 0 on `c344aba` and `46e6e19`; A→B→A away/back pass at 1360 and 390 | refusal keeps draft, attachments and tentative choice in the sending composer; leaving drops only the choice; D-191; see notes |
| M13-T90 | Align composer controls and recording affordance | done | claude-2026-09-11-stabilize | composer `e7a5b89` in candidate `46e6e19`; browser gates 8–9 on `c344aba` (two composers in both send orders, dictation owned by the starting composer, reduced motion at both widths and themes); `pnpm -F @lasercode/ui test -- test/thread/composer-layout.test.tsx` | explicit partials stay recorded: the exact mic-conflict toast is not deterministically reachable (the second mic disables at once; single ownership proven) and the approval-footer real-extension fixture belongs to T95; D-188; see notes |
| M13-T91 | Show the session’s persisted agent in the header after start | done | claude-2026-09-11-stabilize | header `a8715dd` in candidate `46e6e19`; browser gate 5 on `c344aba` (hover/leave, Tab + Escape, touch at 390 and 320, both themes); normal first turn shows the persisted agent and survives reload | D-188; see notes |
| M13-T92 | Replace stale Sending state with the queue state | done | claude-2026-09-11-stabilize | pending `e1c24c7` in candidate `46e6e19`; browser gate 4 on `c344aba` (follow-up queued during a live turn appears once with its reply after leaving and returning, no stale Sending now, reload counts identical); `pnpm -F @lasercode/worker test -- test/pending.test.ts test/server.test.ts` | D-191; see notes |
| M13-T93 | Serialize child completion, engine settle and resume | done | claude-2026-09-11-stabilize | admission `db52a6b` in candidate `46e6e19`; `pnpm -F @lasercode/worker test -- test/extension-admission.test.ts test/extension-admission-runtime.test.ts test/extension-awaitable-patch.test.ts test/agents/extension-goal-admission.test.ts`; independent review and re-review APPROVE (session scratchpad `report-review.md`, `report-rereview.md`); `pnpm verify` on `46e6e19` | A/C settle on every pre-accept failure, causal attribution only; HLC-010 closed; see notes |
| M13-T94 | Release the next stable patch | done | claude-2026-09-11-stabilize | `v0.3.6` at `dc11c4d` (tag `edb7117`); source CI 34571854176 and release 34572122489 passed (build x64, build arm64, publish, deploy package repositories); 12 verified assets, 9 manifest digests agree with the API, installer digest and offline attestation verified, APT/DNF feeds deployed; Latest | D-194; see notes |
| M13-T95 | Manual aggregate activity open/close persists | done | claude-2026-09-11-stabilize | disclosure `131332b` in candidate `46e6e19`; browser gate 6 on `c344aba` (manual close survives 1360→390→1360, Ctrl+F reveals a folded item, Escape restores fold, focus and preference); `pnpm -F @lasercode/ui test -- test/thread/activity-disclosure.test.tsx` | partial stays recorded: approval footer outside a fold is pinned by focused tests only (no real-extension question fixture in the shipped worker); D-189; see notes |
| M13-T96 | Blocked terminal runs are neutral finished work | done | claude-2026-09-11-stabilize | neutral `d694b07`, docs `05bec99`, vocabulary `e165e7c`/`627aaef` in candidate `46e6e19`; browser gates 7 and 10 on `c344aba` and browser-2 gates 1–3 on `46e6e19` (Done muted, Working live, Blocked/Asking fixtures, no finished state while live, sibling order stable through terminal-pending); `pnpm -F @lasercode/worker test -- test/agents/fleet.test.ts` | D-189; see notes |
| M13-T97 | Release the approved subset as stable 0.3.5 | done | stabilization-ci | `v0.3.5` at `7a05c79`; source CI 34527293821, release 34527657277 passed; 12 verified remote assets | D-192/D-193; see notes |
| M13-T98 | Prevent premature completion and unowned queued continuation | done | claude-2026-09-11-stabilize | ownership `82fe0d5`, residuals `055eb8a`, review fixes `f822565`, host `febc5d9`, server `46e6e19`; `pnpm -F @lasercode/worker test -- test/agents/queued-completion.test.ts` (14 real-engine tests) and `test/agents/harness.test.ts`; review + re-review APPROVE; packaged-worker gate 91/91 on `46e6e19` (`report-packaged-2.md`); browser-2 gate 2 | incident contract met on the identified packaged worker; D-195/D-196/D-199/D-200; see notes |
| M13-T99 | Fix the keystroke-burst crash in composer draft restore | todo | — | — | pre-existing on released `aca8591` bundle (`index-CNAHr3_v.js`): React #185 during a fast per-character typing burst, ~1 in 5–10 automated runs; D-197; see notes |
| M13-T100 | Browser-gate observations: Beam bubble overlap and a sticky drawer tooltip | todo | — | — | non-blocking findings of the combined-candidate browser gate; D-198; see notes |
| M13-T101 | Markdown-highlighted instructions and inspectable variables | done | instruction-highlight | `4acae2e` integrates `0ba97dc`/`bad33e9`; review APPROVE; protocol5+UI31 post-merge tests | see notes; D-201 |
| M13-T102 | Selected agent model follows selection | done | agent-model-selection | `2bc89d6` integrates7b5dfe7+7fe28af; both review findings verified; postmerge44worker+30UI, protocol/worker build and UI typecheck pass | see notes; D-202 |
| M13-T103 | Full-span collapsed activity elapsed time | done | activity-span-timing | `3bdacf5`; 34 focused tests + UI typecheck; review APPROVE; live phone32s freeze | see notes; D-202 |
| M13-T104 | Parent-priority hard interrupt and explicit queueing | done | parent-interrupt-control | `34da454`; isolated identity/full verify; 150 worker + 27 companion + 27 protocol tests | see notes; D-203 |
| M13-T105 | Per-item fleet partition with duplicated ancestor context | done | fleet-section-partition | `c6f225a` integrates61988fb+ba1ff25; reviewed finding fixed,64 fleet tests/typecheck/identity pass | see notes; D-205 |
| M13-T106 | Scrollable built-in model picker lists | done | agent-model-selection | `4ef1d11` integratesd3b3a50+a99e23c; shortviewport review finding fixed,31 picker+64 fleet tests/typecheck/identity pass | see notes; D-206 |
| M13-T107 | Release reviewed subset 0.3.7 | done | orchestrator-release-subset | `v0.3.7` at8577bef; sourceCI34587200633/releaseCI34587503564 green;12 public assets/digests and offline attestation verified | see notes; D-207 |
| M13-T108 | Empty New Session reopen after retirement/restart | done | empty-session-lifecycle | 7a37677; combined identity/full verify | see notes; D-209 |
| M13-T109 | Safe future-attribution prevention | done | orchestrator | `350deb6` normal-pushed; JSON/isolated identity pass; all original tag objects unchanged | see notes; D-210 |
| M13-T110 | Explicit legacy-empty draft recovery | dropped | orchestrator | user requests one-time chat script instead | no product implementation; D-216 |
| M13-T111 | Active-tab conversation/send destination isolation | done | tab-destination-isolation | 8650d89; 78 focused tests + combined full verify | see notes; D-212 |
| M13-T112 | Collapsed edit/write diff statistics | done | collapsed-diff-counts | af96144; isolated identity/full verify | see notes; D-214 |
| M13-T113 | Release complete current batch as 0.3.8 | in-progress | orchestrator-release | final source CI34611182930 passed | T110 excluded; D-215/D-216 |
| M13-T114 | Automated release entrypoint and AGENTS instructions | in-progress | release-prep owner | — | user scope addition before0.3.8 publication; D-217 |
| M13-T65 | A fork is a top-level session, never nested under its origin | done | claude-2026-09-09-agents | `pnpm -F @lasercode/host test -- test/catalog.test.ts`; `pnpm -F @lasercode/ui test -- test/shell/session-groups-fork.test.ts` | requested by the user; D-166 |
| M13-T64 | Namer labels every call of a top-level session, none of a child's | done | claude-2026-09-09-agents | `pnpm -F @lasercode/worker test` (`agents/namer.test.ts` "labels every call in a burst at once"; `agents/server-agents.test.ts` "a child agent's tool calls are never labelled") | requested by the user; D-165 |
| M13-T63 | Restoring an unsent draft puts the person in the field | done | claude-2026-09-09-agents | `pnpm -F @lasercode/ui test -- test/thread/draft-restore-focus.test.tsx` | requested by the user; see notes |
| M13-T62 | One `inspect_fleet` tool: the agent sees the fleet the person sees | done | claude-2026-09-09-agents | `pnpm -F @lasercode/worker test` → see notes: `agents/fleet.test.ts` (agreement with `ui/src/fleet/model.ts`), `agents/tasks.test.ts`, harness `inspect_fleet` (312); pi-extension 108; protocol 36; sandbox `fleet` prompt beside the column | requested by the user; D-163; runs after M13-T58 |
| M13-T60 | The fleet's command output body is `terminal-block` by hand | done | claude-2026-09-09-agents | `pnpm -F @lasercode/ui test` (`test/elements/terminal-block.test.tsx` new; `test/fleet/panel.test.tsx` +3; 922); browser at 1440×900 and 390×844, both themes | found by M13-T37: add `follow` and `truncatedHead` to `terminal-block.tsx`, mount it in the fleet's task detail, drop the hand-drawn ground and the Command/Exit-code fields |
| M13-T61 | Delete the element files nothing mounts | done | claude-2026-09-09-agents | `pnpm -F @lasercode/ui build`, `-F @lasercode/desktop build`, `-F @lasercode/ui test`; `docs/ux-elements.md` rows say "not mounted; file removed (M13-T61)" | found by M13-T37: `agent-status`, `todo-list`, `reasoning.aui`, `reasoning-panel`, `onboarding`, `DiffPreview`, the `AgentHandoff` strip export; each row in `docs/ux-elements.md` then says "not mounted, file removed" |
| M13-T59 | The `subagents` log section has no writer | done | claude-2026-09-09-agents | `pnpm -F @lasercode/host test` (`logstore.test.ts` "files a run's status change"; 193) | seen by M13-T38: `messages.ts` / `schemas.ts` / `logs/model.ts` still define it; drop it or give it `lasercode/agent-event` |
| M13-T58 | A Chat session can move to a project | done | claude-2026-09-09-agents | `pnpm -F @lasercode/host test` (`session-move.test.ts`, `router.move.test.ts`; 203), `-F @lasercode/ui test` (`move-session-dialog.test.tsx`, `runtime/move-session.test.tsx`; 908), protocol 35, worker 294; browser at 1440×900 and 390×844, both themes | requested by the user; see notes; D-164 |
| M13-T57 | Drop `task_wait`; a background command's exit wakes the model | done | claude-2026-09-09-agents | `pnpm -F @lasercode/pi-extension test` (`background-work.test.ts` 13); `packages/protocol/test/schemas.test.ts` pins `BACKGROUND_TOOL_NAMES` | requested by the user; D-162; see notes |
| M13-T56 | React #520 on the first prompt of a session (upstream) | done | claude-2026-09-09-agents | `patches/@assistant-ui__core@0.3.17.patch`; browser: plain chat, agents scene, 30 s turn | pinned patch; see notes |
| M13-T38 | Retire the dead `lasercode/subagents/event` message | done | claude-2026-09-09-agents | `pnpm -F @lasercode/protocol test`, `pnpm -F @lasercode/host test`; repo grep clean outside history | found by M13-T11; protocol inventory is a release gate |
| M13-T39 | The engine's variable names leave the person-facing surface | done | claude-2026-09-09-agents | `cli/test/help-vocabulary.test.ts`; `laser help env` | requested by the user |
| M13-T40 | The parent chooses whether a child gets a worktree | done | claude-2026-09-09-agents | `harness.test.ts`, `subagents.test.ts`, golden real-engine test; browser | D-156 |
| M13-T41 | A project without git still gets an isolated child | dropped | — | — | dropped by the user before it started; D-156 |
| M13-T42 | Merging and removing a child's worktree is the parent's | done | claude-2026-09-09-agents | `pnpm -F @lasercode/host test` (router: remove, delete keep/delete; runs: `worktreeRemoved`); `packages/ui/test/shell/delete-session-worktree.test.tsx`, `remove-worktree-dialog.test.tsx`; browser 2026-09-09 | requested by the user; see notes |
| M13-T43 | A session is named when its first turn starts, not ends | done | claude-2026-09-09-agents | `worker/test/agents/session-naming.test.ts`; browser: named at ~3 s into a 30 s turn | requested by the user; see notes |
| M13-T44 | Message actions work on the newest message mid-turn | done | claude-2026-09-09-agents | `ui/test/thread/mid-turn-actions.test.tsx` (4); browser: API request readable mid-turn | requested by the user; see notes |
| M13-T45 | No waiting tool; inspect one child; statuses that say what a child needs | done | claude-2026-09-09-agents | worker 264 incl. golden `needs_input` test; ui 805; browser | D-158; see notes |
| M13-T46 | Edit, Fork and Jump work while a turn is running | done | claude-2026-09-09-agents | `worker/test/stable-sdk.mid-turn.test.ts` (8, real engine); `ui/test/runtime/mid-turn-move.test.tsx` (8); browser | D-159; see notes |
| M13-T47 | Beam's + reuses its empty chat; Beam rows look like any session | done | claude-2026-09-09-agents | `new-session.test.ts`, `router.test.ts`, `attention.test.ts`; browser ×3 → 1 | see notes |
| M13-T48 | A session row stops counting its finished agents | done | claude-2026-09-09-agents | `sessions-tabs.test.tsx`, `session-folds.test.tsx` | requested by the user; see notes |
| M13-T49 | A model hidden by the allow-list says so, and can be let back in | done | claude-2026-09-09-agents | `pnpm -F @lasercode/ui test -- test/settings` (models-tab 20, model +6, picker-refresh 1); `pnpm -F @lasercode/worker test -- model-offer` (9); browser at 1440×900 and 390×844, both themes | requested by the user; D-161; see notes |
| M13-T50 | Two ways back to the chat that always work | done | claude-2026-09-09-agents | `pnpm -F @lasercode/ui test -- test/shell/chat-navigation.test.tsx test/shell/sidebar-shows-chat.test.tsx` (15 tests); browser at 1440×900 and 390×844, both themes | requested by the user; see notes |
| M13-T51 | The fleet is one session's tree, not the project's | done | claude-2026-09-09-agents | `pnpm -F @lasercode/ui test -- test/fleet` (model +5, panel +11); `docs/ux-fleet.md` "One session's tree"; browser at 1440×900 and 375×812, both themes | requested by the user; D-160 supersedes part of D-147; see notes |
| M13-T55 | A settings write does not reach a live session's engine settings | done | claude-2026-09-09-agents | `pnpm -F @lasercode/worker test` (`test/settings-reload.test.ts` 7 with the real engine; `server.test.ts` +4; 293 total) | seen by M13-T49: `pi/settings/set` never reloads an open session's `SettingsManager`; the model lists are read from disk as a workaround |
| M13-T53 | A black screen right after creating a session from the project screen | done | claude-2026-09-09-agents | `pnpm -F @lasercode/ui test -- test/runtime/catalog-arrival.test.tsx` (7); `patches/@assistant-ui__core@0.3.17.patch` second hunk; browser: 10 CLI creates on the project screen, 10 deep links, 2 suggestion presses mid-arrival | seen once by M13-T51: `useClientLookup: key … not found` from the thread list; reload recovers |
| M13-T54 | The CLI prints the app URL with the default port, not the daemon's | done | claude-2026-09-09-agents | `pnpm -F @lasercode/cli test` (`test/app-url.test.ts` 8, `test/session-url.test.ts` 3; 68 total) | seen by M13-T51: `laser new` printed 41441 while `host.json` said 41493 |
| M13-T52 | A jump onto a prompt should put its text in the composer | done | claude-2026-09-09-agents | `pnpm -F @lasercode/ui test -- test/thread/handed-back-text.test.tsx` (3 tests); `test/store.test.ts` | found by M13-T46; pre-existing |
| M13-T36 | The match is the proof, not the clock | done | claude-2026-09-08-agents | `pi-extension/test/file-freshness.test.ts` (33 of 89) | see notes; D-152 |
| M13-T37 | Sweep the tool-use elements for what we hand-rolled | done | claude-2026-09-09-agents | `docs/ux-elements-audit.md`; `docs/ux-elements.md` (26 rows corrected, every mount verified by grep) | research only; see notes |

#### M13-T101 notes
- 2026-09-11 done: one review APPROVE (`/tmp/review-instruction-highlight.md`); merged as `4acae2e`. Parent post-merge protocol5 and UI31 tests plus UI typecheck pass. Both-theme desktop/phone screenshots inspected; worker stopped and merged worktree removed. Run-only variable values remain explicitly unavailable until execution by design.
- 2026-09-11 ready: parser correction `bad33e9` atop `0ba97dc` uses canonical AST ranges; protocol43 and UI31 focused/build/typecheck/identity pass. Single review assigned `01a08fcf-e7f3-7754-a665-f1baf02c709d` against `728a1f9..bad33e9` plus orchestrator inventory-row edit; worker stopped clean.
- 2026-09-11 pre-review correction: inspected `0ba97dc` and both-theme responsive screenshots. Regex misidentifies escaped/comment/malformed tokens and misses whitespace-control forms; owner fixing through canonical Handlebars AST range helper. Additional owned paths only protocol instruction-templates.ts and its tests (independent of T102 messages/schema). Inventory docs edited by orchestrator; include in forthcoming review.
- 2026-09-11 claimed: inspect the shared InstructionTemplateEditor and canonical runtime template values; preserve unrelated deleted discovery docs and untracked user files. Prior stabilization session finished with D-199/D-200; checkout HEAD is `728a1f9`.
- Acceptance: source-preserving Markdown syntax view, distinct inspectable variables, truthful current values with explicit runtime-only states, unchanged save/validation/insertion, keyboard/touch and both-theme responsive evidence.
- Ownership ledger: instruction editor + value inspection · `01a08fa5-a95d-7754-a665-f172e3a7d781` · integrated `4acae2e`, source ownership closed · UI page/helper/tests + protocol instruction-template ranges · base `728a1f9` · all gates/review done · done · included in T107; worktree removed.
- 2026-09-11 M13-T101/T102/T103 environment checkpoint: Node 24/pnpm via local PATH; parent UI baseline 126 files/1033 tests pass. Parent typecheck uses stale protocol dist; protocol build is blocked by identity scanning the unrelated untracked `.laser/settings.json`. Preserve that file; validate isolated workers and use direct protocol tsc only for parent focused checks.
- 2026-09-11 validation plan: T101 source round-trip, Markdown/variable tokens, disclosure current/empty/unavailable values, caret insert, all built-ins and responsive themes. T102 non-default configured model preview + first-request model, explicit later override, null fallback, refusal/retry/leave and composer isolation. T103 wall-clock reasoning/sequential gaps/parallel overlap/final-step gap, next-content and terminal freeze, remount and collapsed/open parity; never invent historical timestamps. Parent protocol direct tsc + UI typecheck now pass after rebuilding stale declarations. Final broad identity/verify gate will use an isolated integrated checkout so unrelated user `.laser/settings.json` is not removed or staged.
- 2026-09-11 T101 plan approved (`/tmp/instruction-highlight-m13-t101-plan.md`): UI-only Shiki source view; variables disclose draft/current known values with provenance or specific run-only reasons. No fabricated runtime resource blocks or new sessions. Owner `01a08fa5-a95d-7754-a665-f172e3a7d781` now implementing in `agents/instruction-highlight-0f5aacfe` (run `run_08325d72`); permitted page-local UI/helpers/tests only. Shared element inventory update remains orchestrator-owned. Pre-created worktree node_modules symlinks may be unlinked (link only), then replaced by isolated installs.

#### M13-T102 notes
- 2026-09-11 DONE after publication: merged reviewed+corrected7b5dfe7/7fe28af as2bc89d6, not into v0.3.7. Parent postmerge validation in isolated former release-prep checkout passes protocol/worker builds,44worker+30UI and UI typecheck. T104/T106 continue on verified7fe28af dependency; model worktree retained for T106. Next release only.
- 2026-09-11 correction ready7fe28af, source clean. Parent inspected both fixes and new real-engine authorization/thinking/reload tests;44worker+30UI and worker/UI typechecks pass. Worker fullverify/UI1041+worker443+host216 pass; both review findings resolved, no second review. Main integration waits frozen release publication only; parent privately integrated7fe28af into T104 worktree to release real dependency and approved T106 on same corrected model branch.
- 2026-09-11 correction plan approved `/tmp/laser-m13-t102-review-correction-plan.md` (a83e3f2a); owner run `run_5f69ab32` implements actual prepared-model validation within rollback guard plus accepted thinking provenance/reset. Required extra null-agent-thinking fallback test guards old transcript thinking inheritance. No shared protocol/driver interface extension needed; next parent verification, then T106 and T104 handoffs.
- 2026-09-11 resumed after user clarification D-208: continuing owner preparing one correction plan for both findings, then implementation/parent verification (no second review). Remains excluded from frozen8577bef. T106 follows sequentially; corrected T102 can hand directly to T104 without entering the release.
- 2026-09-11 review NOT APPROVED (`/tmp/review-agent-model.md`): high—absent model intent validates definition model although driver may preserve a different explicit override; medium—UI agent thinking default can disagree with worker’s preserved explicit thinking. Both accepted as actionable; fix the whole set under the existing owner in next batch, validate effective model once and make displayed/request thinking agree, then parent verify (no second review cycle). Parent29UI+40worker tests passed but omit these repros. Remains excluded from0.3.7; unblock by resolving both findings and passing targeted validation.
- 2026-09-11 ready `7b5dfe7`: worker reports full identity/verify pass and both-theme desktop/phone model-selection browser proof. Parent inspected protocol/UI/driver diff; one review assigned `01a08fd4-95be-7754-a665-f1c091ddae62`. Owner stopped source writes; next same-owner milestone T106 modal picker scrolling is investigation-only until integration. T104 harness still waits shared interface release.
- 2026-09-11 claimed: user reports selecting orchestrator/non-default agent does not change model. Trace composer first-turn choices, model display, and worker preparation without violating tentative selection and rollback.
- Ownership ledger: agent/model selection · `01a08fa8-b865-7754-a665-f1785ddcd05e` · frozen `7b5dfe7` · first-turn UI/protocol/worker/tests · base `728a1f9` · review found effective-model and thinking mismatches · done integrated2bc89d6 for next release · next: continuing owner implements T106; interface handed to T104.
- 2026-09-11 T102 plan checkpoint (`/tmp/laser-m13-t102-agent-model-plan.md`): bounded firstTurn protocol/driver extension justified by real send mismatch, but prior-model-wins precedence rejected. Latest intent wins: choosing another agent resets earlier model overrides to that agent’s configured model (or project default); a model explicitly picked afterward wins until the next agent choice. Existing no-choice picker behavior remains unchanged. Owner revising contract before implementation.
- 2026-09-11 T102 settled contract approved: `firstTurn.model?: ModelRef | null`; null resets stale model to chosen agent/default, object is later explicit choice, absent retains no-model-intent behavior (e.g. thinking-only change). `chooseThinking` must preserve null explicitly. Owner `01a08fa8-b865-7754-a665-f1785ddcd05e` implementing in run `run_89e4445b`; prior queued plan questions were stale and are superseded.

#### M13-T103 notes
- 2026-09-11 done: review APPROVE (`/tmp/review-activity-span.md`,52 tests); merged `3bdacf5`, parent post-merge34 focused tests + UI typecheck pass. Supplemental `/tmp/laser-m13-t103-phone-live-evidence.json` proves dark8.5s/open9.1s/light10s then frozen32s in both themes, body visibility after animation and no overflow; parent inspected screenshot. Worker stopped, ports clear, merged worktree removed.
- 2026-09-11 ready: `3bdacf5` clean; worker reports UI1038, workspace build/typecheck and identity pass (full workspace tests interrupted). Single review assigned to `01a08fc3-fc80-7754-a665-f1a6be8b70a5` against exact commit; evidence-only live-phone follow-up may continue under original owner without source changes. Next: triage once, verify, integrate.
- 2026-09-11 parent checkpoint: inspected commit `3bdacf5` (outer group clock + actual-runtime tests); own worktree rerun `pnpm -F @lasercode/ui exec vitest run test/thread/activity-span-timing.test.tsx test/thread/activity-disclosure.test.tsx test/thread/tool-groups.test.ts` passes 34 tests. Desktop artifact shows full32s span; requested live phone elapsed proof because initial phone artifacts were hydrated and intentionally duration-less. Waiting ready handoff before single independent review.
- 2026-09-11 claimed: user wants aggregate wall-clock span including reasoning, steps and gaps until following content appears (or turn ends), not summed command durations. Existing ToolGroupSummaryRow sums tools without reasoning; local timing freezes on the first settled child and cannot restart.
- Ownership ledger: activity elapsed timing · `01a08fa9-0f9f-7754-a665-f17f2ed4342c` · integrated `3bdacf5`, source ownership closed · UI group/messages/tests · base `728a1f9` · all gates/review done · done · included in T107; worktree removed.
- 2026-09-11 T103 plan approved (`/tmp/laser-m13-t103-plan.md`): keep one stable outer group clock from first single child, terminate on next outside part or message terminal, render existing aggregate at 2+ children. Owner `01a08fa9-0f9f-7754-a665-f17f2ed4342c` implementing UI-only ToolGroup/messages/tests; no projection/store/protocol change.

#### M13-T104 notes
- 2026-09-11 source checkpoint: normal push of `c9c05caa33f54c646d502f587dfcf05038ff4de6`; exact-source CI `34595968503` passed. Integrated worker worktree removed without force. Published tag remains `8577bef`; no release or installed-process change.
- 2026-09-11 done: correction `2bc3c5d` resolves all four findings in the single independent review. One lifecycle-owned control transaction cancels the exact dialog set before abort, retains the preflight execution fence through stop promotion, preserves accepted queues on control failure, and provides explicit answer-mode guidance. Parent inspected the revised lifecycle/harness and reran 150 worker tests (one existing skip), 27 companion and 27 protocol tests. Integrated as `34da454` after isolated `pnpm identity:check && pnpm verify` passed (`/tmp/laser-t104-integrated-verify.log`). Next-release work only; installed host and v0.3.7 unchanged. Ownership: implementation stopped; parent owns integrated outcome/cleanup.
- 2026-09-11 review CHANGES REQUESTED (`/tmp/review-parent-interrupt.md`), four findings accepted: no-signal dialog abort deadlock, swallowed stopqueue takeover failure, removed late-start stop fence during preflight, and unsafe bare answer hint. Existing owner’s /tmp/laser-m13-t104-review-correction-plan.md approved; runrun_3112d89b consolidates lifecycle-owned typed interrupt/stop transitions, shared question cancellation and canonical answer hint. Additional bound: neither accepted-queue waiter settlement nor terminal cancellation before actual control succeeds; abortfailure restoresaccepted work without resurrecting refusedprovisional redirects. No secondreview; parentverify allrepros aftercorrection.
- 2026-09-11 ready7334c3b, owner stopped clean. Parent inspected main mode/control/lifecycle/companion diff and reran130worker+1skip,27companion,26protocol pass. Single review assigned01a0901a-4432-7754-a665-f220488db227; exactbase7fe28af. Review specifically audits queue/abort failure ownership and stop preventing engine continuation, not only happy-pathinterrupt. Worker fullverify passed(worker452+1skip). No driver/server/persistence overlap with T108.
- 2026-09-11 implementation released: parent checked worktree clean and FF-integrated7fe28af (corrected/verified T102), owner runrun_f52bdbca now implements approved four-mode plan. Worker driver/server/SDK remain read-only unless explicit new need. Release tag8577bef unaffected.
- 2026-09-11 plan held: four-mode contract approved; revised `/tmp/laser-m13-t104-parent-interrupt-plan.md` (`425c5a78`) distinguishes control failure, preserves explicit stop over queued resume, fences late abort, and keeps deleted references out of scope. Owner stopped, source clean at `728a1f9`; next prerequisite is reviewed/integrated T102 and exact-base handoff.
- 2026-09-11 investigation checkpoint: `/tmp/laser-m13-t104-parent-interrupt-plan.md` proposes harness/lifecycle-only interruption atop existing abort/clearQueue seam; implementation waits T102 integrated base. Required correction: explicit Answer mode, because Interrupt cannot be diverted into invalid-question-answer refusal. No edits to user-deleted `docs/agents-leap/*`.
- 2026-09-11 claimed: user requests actual parent-controlled interruption, defaulting parent messages to interrupt. Source confirms current true uses the steering queue during normal streaming and aborts only during terminal-pending. Investigate under invocation ownership/queue-preservation contract before code.
- Ownership ledger: parent interrupt lifecycle · `01a08fb4-f3bf-7754-a665-f194086ffca2` · approved plan only · harness/lifecycle/companion modes/protocol agents schemas/tests/docs · base `7fe28af` · corrected T102 privately integrated by parent · implementing approved correction atop7334c3b · next: parentverify fourfindings and integrate, no secondreview.
- 2026-09-11 T104 user clarification: full interrupt is the default among explicit delivery choices. Contract to plan: Interrupt (abort/fence/priority), Steer (next model boundary without cancellation), Queue (after current work). Prefer one clear mode field, not competing booleans; parent-visible descriptions must explain exact landing semantics. D-203’s false queue intent becomes explicit Queue mode in the final API design.

#### M13-T105 notes
- 2026-09-11 integratedUI batch49a6b62 (includingT106) passed isolated identity/fullverify (`/tmp/laser-ui-batch-integrated-verify.log`), normal-pushed, exactsourceCI34592137931 passed (watcht-f1cc43e1). No release/tag change.
- 2026-09-11 DONE: parent inspected role-aware correctionba1ff25a96439aa3b9e6e4c72cafc07673b51db4 and new currenttree/stray lifecycle+Clear/reveal tests;64 focused/UItypecheck pass. Integrated61988fb+ba1ff25 and reviewed parent UX doc hunks as c6f225a. Postmerge64fleet/typecheck/identity pass; merged clean worker worktree removed withoutforce. No secondreview; next release only.
- 2026-09-11 single review NOT APPROVED (`/tmp/review-fleet-partition.md`): actual/context role absent from disclosure identity causes open actual row to stick to old-section context, and cleared context can reopen on a later finish. Finding accepted; continuing owner runrun_30c9017b fixes role-aware reconciliation plus tree/stray lifecycle and Clear/newfinish tests. Parent will verify corrected set without second review.
- 2026-09-11 parent inspected model/panel diff, phone-light/desktop-dark screenshots and browser JSON; reran61 fleet tests pass. Single review assigned01a09002-f77b-7754-a665-f1f859b86f56 against3bdacf5..61988fb plus parent direct ux-elements/ux-agent-work lifecycle edits. Source owner stopped clean.
- 2026-09-11 ready61988fb: owner reports61 fleet tests, full workspace build/test (UI1045), identity/typecheck and desktop/phone both-theme browser proof; clean/stopped. Parent inspecting before one independent review; inventory and ux-agent-work context wording remains parent-owned.
- 2026-09-11 resumed D-208: same owner/run `run_1847efbe` continues preserved dirty checkpoint under approved plan, independent of frozen release8577bef. No discard/rebase or ownership transfer.
- 2026-09-11 plan approved (`/tmp/M13-T105-fleet-section-partition-plan.md`); owner implementing immutable projected item/context wrappers, membership counts/attention, section reveal/expansion, recursive Clear and stray parity. Baseline54 tests pass. Parent reserved/updated ux-elements Subagent-list row and ux-agent-work final rule; include those direct docs in upcoming review.
- 2026-09-11 claimed: user requests ended commands/subagents under Finished immediately, retaining the same agent as an ancestor in both sections while it still works. Existing `partitionItems` moves whole branches and `FleetPanel.putAway` only filters top-level items; both must share recursive section/clear semantics.
- Ownership ledger: fleet lifecycle projection · `01a08fcb-9d95-7754-a665-f1b16ada6357` · ready61988fb under independent review · UI fleet model/index/panel/subagent-list/tests + ux-fleet · base `3bdacf5` · excluded from frozen release only · donec6f225a, source ownership closed · next: none; merged worktree removed; canonical run/task state untouched.

#### M13-T106 notes
- 2026-09-11 DONE: parent inspected a99e23c available-height/flex correction, retained JSON and780×480 screenshot (main y8..261, bothfilters visible, nested withinviewport, wheel/focus pass). Own31 picker tests/typecheck pass; integratedd3b3a50+a99e23c as4ef1d11; postmerge31picker+64fleet/UItypecheck/identity pass, including automatic screen-test merge. Corrected single-review finding verified; clean merged modelworktree removed withoutforce. Next release only.
- 2026-09-11 single review CHANGES REQUESTED (`/tmp/review-modal-picker-scroll.md`): wheel/touch/RTL/lock independently pass, but780×480 supporteddesktop mainpopup395px at y=-134 leaves bothfilters offscreen. Finding accepted; sameowner runrun_fe17d44f adds available-height/flex-remainder constraints and main/nested shortviewport realbrowser regression with retainedJSON. No secondreview; parent will verify.
- 2026-09-11 readyd3b3a50 at preserved7fe28af; parent inspected67-line UI diff, phone-dark/desktop-light screenshots, reran28UI+typecheck pass. Single review assigned01a0900d-2f99-7754-a665-f20603227263; /tmp/laser-m13-t106-review-evidence.md records harness/commands/fullverify and observed wheel/touch/focus values (raw JSON was stdout, not retained separately). Source owner stopped clean; no other surface changes.
- 2026-09-11 implementation released: continuing owner runrun_4eb80cd5 on7fe28af now applies approved opt-in modal portal-container fix, UI-only. T102 first-turn source frozen/verified and privately handed to T104. Real wheel/touch, both-theme responsive evidence required; separate commit and one review.
- 2026-09-11 held: `/tmp/laser-m13-t106-scroll-plan.md` confirms real wheel blocked by portals outside modal lock (main6586/288 and nested1146/288 scrollable geometry, scrollTop unchanged); moving main portal into dialog gives0→650. No source change; ports stopped. Next opt-in dialog container propagation through both popovers after T102 fixes/integration and release; preserve lock.
- 2026-09-11 claimed: user reports Namer provider-filtered model list cannot wheel-scroll. BuiltinModelDialog in agents/page/dialogs.tsx mounts shared ProviderModelPicker; model/provider PopoverContent portals to body while outer Dialog owns scroll lock. Confirm in real browser before choosing a scoped portal fix.
- Ownership ledger: model-picker modal scrolling · `01a08fa8-b865-7754-a665-f1785ddcd05e` · cause confirmed, no source changes · provider/model portal container + builtin dialog/tests · base `7fe28af` · T102 corrected/verified · done4ef1d11, source ownership closed · next: none; merged worktree removed.

#### M13-T109 notes
- 2026-09-11 source CI34588873730 passed for pushed350deb6 (watcht-b45bcfdf exit0); no new release/tag created.
- 2026-09-11 DONE: project `.claude/settings.json` disables automatic commit/PR attribution;350deb6 normal-pushed, remote main verified. No historical message/ID/tag rewrite, amend or force; v0.3.7 remains8577bef and all tag objects equal pre-change snapshot. Historical co-authors remain by explicit no-rewrite constraint. Settings JSON/isolated identity pass; full integrated codeverifyadfffa1 passed before config-only commit. Source CI34588873730 running; watcht-b45bcfdf.
- 2026-09-11 claimed: user requests removing co-author only if history/messages/worktrees/published releases remain undisturbed, then push. Existing trailers are part of hashed messages, so historic removal cannot meet that constraint; parent explicitly told user only future automatic attribution will be disabled. Read-only audit found4 Claude trailers, zero primary Claude authors,195 affected main commits if rewritten, all release tags retain earliest attribution. No history edit permitted.
- Ownership ledger: future Claude attribution · orchestrator direct bounded fix · `.claude/settings.json` only plus owned ledgers · baseadfffa1 · no worker overlap; setting absent · done350deb6 pushed · next: none; historical attribution intentionally retained. No global settings edit, amend, filter-repo, force-push or retag.

#### M13-T112 notes
- 2026-09-11 normal push c99aa9c and exact-source CI34602657563 passed; merged worker worktree removed without force. v0.3.7 remains8577bef.
- 2026-09-11 DONE: integrated 78222c7 + 9da31c9 + af96144 by fast-forward. Both levels work at verified 390 CSS px in both themes, with full counts before preview truncation. Single-review file-tree and long-verb findings fixed; parent inspected correction, reran 14 focused tests and isolated identity/full verify (`/tmp/laser-t112-corrected-integrated-verify.log`). Source ownership closed; next-release work only, no new release or installed-process restart.
- 2026-09-11 single review `/tmp/review-collapsed-diff-counts.md` returned two bounded fixes: file-tree still counts capped hunks, and the verb shrink override affects non-count long tool names. Parent reproduced 8 protocol + 50 UI tests and approved actual 390px screenshots; isolated full verify passed at `9da31c9`. Same T112 owner receives both fixes, with file-tree and its direct tests explicitly added; no second review.
- 2026-09-11 two-level checkpoint `9da31c9` adds collapsed group totals on top of `78222c7`; 8 protocol + 58 UI tests, typechecks/build/identity reported green. Actual-phone viewport correction is now active in same owner run `run_8736bb6c`; source has pending responsive adjustments, so final inspection/review waits for that clean checkpoint.
- 2026-09-11 row checkpoint `78222c7`: full stats, per-tool collapsed counts and shared body/timeline metrics committed; 8 protocol + 33 UI tests, typechecks/build/identity reported green. Not complete: same owner is adding the clarified collapsed-group aggregate in run `run_ab6d6b66`. Parent flagged phone screenshot dimensions inconsistent with a 390-CSS-pixel layout; actual viewport assertions and replacement browser evidence requested before final validation. No review/integration of the incomplete milestone yet.
- 2026-09-11 user clarification: two levels, not just the tool body—fully collapsed activity group shows aggregate line additions/deletions, and an expanded group shows each edit/write count with its individual diff still collapsed. Same T112 owner owns tool-group.aui.tsx, tool-groups.ts and direct group tests in addition to row/count paths; no T111 navigation files needed. Reuse full captured stats, aggregate successful calls, preserve timing/disclosure/Namer and prove both levels in browser evidence.
- 2026-09-11 ownership handoff complete: T111 owner explicitly confirmed unchanged ToolRow.tsx and released it plus dedicated diff-header tests in `/tmp/laser-m13-t111-checkpoint.md`. T112 owner now owns ToolRow wiring and the related tool-timeline stats consumer; T111 resumes all other paths. Parent’s pre-integration inspection caught an undefined aria-label overriding the default label; use a real accessible description instead.
- 2026-09-11 claimed: user requests a quick worker change showing added/removed line counts without expanding Edit/Write. Reuse DiffStat and ToolFallbackTrigger.trailing; the shared diff projection currently truncates hunks at 400 lines, so retain full available counts before bounding rather than presenting clipped totals as exact. Never infer overwritten file removals from current disk.
- Ownership: `01a09061-f2cb-7754-a665-f278758a3ba6`, run `run_1d2ce633`, `.worktrees/collapsed-diff-counts-1d2ce633`; permitted ToolCall/code-diff elements, shared protocol/tool-diff projection and dedicated tests. ToolRow.tsx and dedicated diff-header tests released by T111; T112 owns wiring. T111 retains other routing paths. No runtime/navigation, backend or user-file changes. Base c9c05ca; optional display metadata/slot contracts are backward compatible. Done af96144, ownership closed; next: source CI.

#### M13-T110 notes
- 2026-09-11 one-time script supplied in chat after APPROVE `/tmp/review-one-time-reset-script.md` (SHA25664940ae3e6ff026205fac9831f90683c109a87bcd057bdf5d6511901c6655ec0). Exact reset/cancel/quota simulations passed; no live execution. Disclosed post0.3.8 use, backup verification, all-selection reset, manual text restoration, no transcript/attachment recovery. Product recovery remains dropped; merged UI worktree removed without force.
- 2026-09-11 DROPPED by explicit user instruction: do not implement legacy recovery in code; provide a one-time script in chat and then release. No T110 source work or worker run was started. User retains the already implemented persistent-empty approach, not a new draft-only redesign. Script `/tmp/laser-one-time-session-reset.js` is artifact-only, backs up text/selection pointers and resets navigation without recreating transcripts; confirmation/cancel/quota simulations pass, narrow safety review running.
- 2026-09-11 claimed: same continuing UI owner investigates explicit legacy-empty recovery against integrated T108/T111, then submits `/tmp/laser-m13-t110-plan.md` before code. Boundaries and required proof are in `/tmp/laser-m13-t110-acceptance.md`. No automatic resend, draft transfer, missing-path recreation or broad failure suppression; preserve canonical destination and scoped Beam.
- Ownership ledger: legacy-empty recovery · 01a09036-916c-7754-a665-f2507878889b · one cohesive UI recovery milestone · runtime new-session/controller/draft helpers and existing EmptyState/Composer/Beam surfaces plus direct tests; no ToolRow, backend/protocol/lockfile/ledgers/release writes · base8650d89 plus parent claim ledger, explicit fast-forward handoff · T108/T111 done and combined gates green · dropped before worker assignment by user · next: no product work; one-time script from parent, then T113.

#### M13-T113 notes
- 2026-09-11 candidate0.3.8 and release orchestrator integrated after review corrections; parent now invokes the command directly. Source includes user-authorized maintainer/contact-email changes, excludes T110 product recovery. No tag/publication yet; command owns staged isolated verify, exact source CI, annotated tag, architecture build/publication and downloaded-asset verification.
- 2026-09-11 version-only candidate e87eaf6 is ready on frozen cba19f2: exact12 version files, full verify2199 workspace+13release tests and staged identity reported green. User now requests a reusable release orchestrator/script in AGENTS before publication; no metadata reviewer/tag/push yet. Same release owner receives T114 as next milestone atop immutable e87eaf6, combined candidate reviewed once before execution.
- 2026-09-11 isolated release-prep ownership handed from parent to continuing owner01a08fdb-f2fe-7754-a665-f1c78349c067, run_e3aa492a; clean frozen basecba19f2 in `.worktrees/release-037-prep-53dcadee`. Version-only0.3.8 preparation, identity/full verify and release-note artifact; no tag/push/publication by worker. Parent no longer writes this worktree during preparation.
- 2026-09-11 release scope finalized by user: omit T110 product recovery, provide one-time chat script, then release all completed changes as0.3.8. Frozen sourcef9a5195 has combined full verify and exact CI34611182930 passing; next isolated version preparation under continuing release owner. No installed-process changes.
- 2026-09-11 parent prepared bounded future T110 acceptance `/tmp/laser-m13-t110-acceptance.md`; not assigned until T111 integration. No parallel writer on unsettled destination/draft ownership.
- 2026-09-11 user authorizes finishing the changes and then releasing everything in the current batch. Release scope is T102/T104/T105/T106/T108/T109/T110/T111/T112 atop immutable v0.3.7; no unrelated backlog additions. Prep starts only after T110/T111 integrate and final source is frozen; no installed app/host update or restart.
- Ownership ledger: release0.3.8 · orchestrator-release · pending complete-batch freeze and isolated release preparation · version/generated metadata, release notes and gates; planning parent-only · final sourcef9a5195 plus freeze ledger · T111 done, T110 dropped · version-only prep active with01a08fdb-f2fe-7754-a665-f1c78349c067/run_e3aa492a · next: single metadata review, exact source CI before tag, verified assets before publication.


#### M13-T114 notes
- 2026-09-11 single combined review `/tmp/review-release038-automation.md` requested annotated-tag object enforcement and one remaining unsafe publish.sh hint. Parent fixed both in4c9c121, verified39 release tests and full staged identity/verify; no second review. Integrated automation/version metadata, then explicitly included user contact-email edits as1a69704 (product.json, desktop metadata, COMMERCIAL, TRADEMARKS). Unrelated deletions/local state/images remain unstaged. Next direct command execution at final ledger-inclusive source.
- 2026-09-11 parent direct correction5fd8adf implements the safety fixes and adds regressions:37 release tests, staged identity, full verify2199 workspace+37 release and live read-only dry-run pass; no public mutation. Combined metadata+automation review is active at exactcba19f2..5fd8adf under01a09124-eda4-7754-a665-f301ff495eeb/run_72701554 (`/tmp/review-release038-automation.md`). Parent fixes any findings directly; no worker implementation resumes. Logs `/tmp/laser-release-direct-{tests,verify,dry-run}.log`.
- 2026-09-11 user requests parent finish directly. Worker stopped run_3bb828e8 and explicitly acknowledged handoff in run_ce6faf01: clean committed578afc0 plus uncommitted draft-lookup helper in publish-github.mjs, no running processes. Parent now owns release.mjs/helper/tests/README/AGENTS corrections and execution; no further implementation delegation. Pre-review corrections cover Git environment isolation, semantic metadata checks, explicit absence/draft lookup, command budgets, credential-safe diagnostics and resume/proof binding.
- 2026-09-11 plan `/tmp/laser-release-automation-plan.md` approved with bounded corrections: adopt existing exact-SHA CI for no-op pushes, default frozen install without mandatory offline cache, exclusive validated release lock, truthful partial publication reporting, and remove unsafe tag shortcuts from helper/README. Same owner implementing run_5b838096 atop e87eaf6; parent stays out of its script/AGENTS paths. Current0.3.8 will invoke final parent-integrated source, with no version-only extra commit when already synchronized.
- 2026-09-11 claimed by continuing release owner after clean e87eaf6 checkpoint: add a bounded orchestrator over existing helpers, not a second publisher. Plan required before code. User goal is routine releases through one command, not spawning a release-prep subagent each time; current0.3.8 will exercise it after review.
- Ownership ledger: release automation · 01a08fdb-f2fe-7754-a665-f1c78349c067 · plan then one release-entrypoint milestone · scripts/release entrypoint/direct helpers/tests/README, AGENTS release instructions, optional package command alias; no workflow rewrites, product behavior, version churn or ledgers · basee87eaf6 (version-only0.3.8 candidate) · existing helpers/contracts stable; no other writers · parent direct correction after explicit stopped-writer handoff at578afc0 · next: focused/full gates, single combined review, direct0.3.8 execution.

#### M13-T111 notes
- 2026-09-11 exact source CI34611182930 passed atf9a5195. Routing integration is green locally and remotely.
- 2026-09-11 DONE: parent inspected 52701cc and integrated all T111 commits as8650d89 after 78 own focused tests and isolated identity/full verify passed (UI1104, worker478+1skip, host224, release13; `/tmp/laser-t111-integrated-verify.log`). Single-review findings and extraction regressions corrected. T111 source milestone closed; same continuing owner moves to T110 only after explicit base handoff.
- 2026-09-11 final append 52701cc fixes Chat/child fork classification, pins every known load target before await, and consumes superseded startup hashes. Five maintained regressions added; worker reports destination20, UI1090 and full verify green with refreshed browser matrix. Parent inspected corrected controller diff; combined isolated merge/focused/identity/full verify running as t-0eeaa8d7 (`/tmp/laser-t111-integrated-verify.log`). No second review; source owner stopped clean.
- 2026-09-11 immutable extraction ecb714a reported full UI1085 and full verify passing; parent verified maintained repro tests and controller extraction (provider1892, controller494, draft hook84 lines). Parent inspection found three remaining extraction seams: Chat/child fork classification, exact target pinning before existing-session loads, and startup hashes superseding newer explicit intent. Same owner fixing together in run_a354897a; no second review, no T110 start. Evidence `/tmp/laser-m13-t111-review-correction-evidence.md`.
- 2026-09-11 correction plan `/tmp/laser-m13-t111-review-correction-plan.md` approved with two constraints: ready Code stores one identity (not duplicated selection/code), and quiet launch forwards complete existing agent/options semantics rather than narrowing to default/chat. Same owner implementing run_7ed037e9; preserve known creation identity across hydration failure. No second review.
- 2026-09-11 single review REQUEST CHANGES (`/tmp/review-tab-destination.md`): reproduced pathless Code landing lost after Chat excursion, malformed deep link leaving resolving forever, and scattered/weakly typed destination ownership in a 2297-line provider. All accepted; same owner run_9855f678 submits one controller/landing-draft extraction and bug-fix plan before code. No second review.
- 2026-09-11 correction 4caeea7 fixes both parent findings; parent inspected corrected membership/answer fences. Single independent review now active: 01a0909b-4cc7-7754-a665-f2a791186e01 / run_9cd19b30, exact49a6b62..4caeea7, `/tmp/review-tab-destination.md`. Owner stopped clean; reported corrected full UI1081 and focused61+catalog8 passing.
- 2026-09-11 Ready 2e4f527, clean, full UI 1078 and repository verify plus browser destination evidence reported passing. Parent pre-review inspection found Beam contaminating per-project session memory and main answerDialog bypassing readiness/current-question checks. Same owner receives both corrections in run_9dfce0c8 before the single independent review; immutable original retained. Evidence `/tmp/laser-m13-t111-tab-destination-evidence.md`.
- 2026-09-11 bounded handoff: urgent ownership message queued rather than interrupted, so parent briefly checkpointed this run without changing any files. Same owner acknowledged release of untouched ToolRow.tsx; all 28 uncommitted routing paths preserved in the same worktree. Resume T111 immediately; no source/branch/history discarded. Evidence `/tmp/laser-m13-t111-checkpoint.md`.
- 2026-09-11 plan approved: `/tmp/laser-m13-t111-tab-destination-plan.md`. One canonical main destination, latest-intent navigation, explicit quiet Chat allocation/reuse, runtime settlement and action guards; Code memory and scoped Beam remain separate. Conditional landing-draft handling is bounded and ephemeral, not legacy recovery. Owner `01a09036-916c-7754-a665-f2507878889b`, run `run_08a2f4f3`, worktree `.worktrees/tab-destination-isolation-895378e5`, base `49a6b62`; UI-only implementation active. Baseline 37 focused tests pass. T110 research handoff accepted; T110 remains unassigned until T108/T111 integrate.
- 2026-09-11 claimed: user reports Code→Chat with no remembered Chat can render/use Code conversation; sending hi lands in lastCode project. Parent confirms SessionsPanel.changeTab clears current when no eligible destination, but root LaserProvider threadListAdapter still creates from projectRef/first open cwd with no Chat agent; async selecting open has no tab navigation generation guard. Trace canonical mode/selection/runtime target together, not just visible list.
- Ownership ledger: main UI destination routing · `01a09036-916c-7754-a665-f2507878889b` · approved cohesive UI destination repair · runtime LaserProvider/threadList/new-session/session-tab-memory/store, shell sessions tab/navigation and tests; related entrypoints afterplan only · base49a6b62 · wire session/new and correctedT102 model intent stable; T108 backend-only and T104 harness-only · done8650d89, combined gates green · next: continuing owner receives T110 as a separate milestone on integrated base. T110 legacy recovery is not yet assigned and must follow this owner’s stable UI contract as well as T108.

#### M13-T108 notes
- 2026-09-11 merged backend worktree removed without force; history, proposal and evidence retained. Source ownership closed.
- 2026-09-11 exact source CI34603076800 passed at726911e. Combined durable-empty integration is green locally and remotely.
- 2026-09-11 normal push726911e; exact source CI34603076800 running. User freezes scope to this current batch until release; no unrelated tasks to start.
- 2026-09-11 DONE: integrated as 7a37677 after parent 77 worker + 25 host tests, including real idle retirement/full restart for project/Beam/Chat and missing/corrupt controls. Combined T104/T108/T112 isolated frozen install, identity and full verify passed: worker 478 + 1 skip, host 224, UI 1079, protocol 49, release 13 (`/tmp/laser-t108-t104-integrated-verify.log`). All findings from the single review and follow-ups corrected. Exact-version local Pi patch remains required; generic upstream proposal reviewed but not filed (no Pi fork found). Next: source CI; T110 still waits for reviewed T111.
- 2026-09-11 Final correction 70d9f8f follows e0d391d live ordinary hydration/replay and 323a459 live tray. Coordinator now has discriminated phases, opaque token ownership, cancelled/stale transition rejection and regressions. Owner stopped clean; full verify reported passing (worker 459 + 1 skip, host 224). Parent inspected boundary and starts final focused tests, then combined T104 integration. No second review; `/tmp/laser-m13-t108-correction-evidence.md`.
- 2026-09-11 `323a459` restores live canonical pending-list reads and tests concurrent tray add/remove; full verify reported green. Ordinary preflight hydration, live replay watermarks and coordinator invariant corrections remain queued with the same owner; not ready to integrate.
- 2026-09-11 correction checkpoint `39b9d3e`: transport delivery/helper, hydration and transaction changes committed with full gates reported passing. Same owner now applies queued live-tray clarification (`run_6119fea7`). Parent inspection also returned ordinary no-firstTurn preflight read deadlock, frozen replay-buffer/watermark omission of allowed diagnostics, and incomplete phase/token/cancellation invariants in the extracted coordinator. These remain required before integration; no new review round.
- 2026-09-11 correction plan revision 2 approved with narrower delivery: buffer question requests only, preserve numbered replay order, let closes pass immediately while invalidating buffered ids, and fence asynchronous send/connection teardown. Added ownership covers worker UI bridge/coordinator and host load-delivery helper/server/relay-client plus direct tests; protocol/driver interface/UI/harness remain frozen. Snapshot candidate-mutable state/entries/leaf/goal; pending-list stays live canonical because tray mutations are independent. Same owner implementing in `run_097f7666`; no further review round.
- 2026-09-11 correction-plan checkpoint: parent returned the initial `/tmp/laser-m13-t108-review-correction-plan.md` for a bounded revision before code. A baseline session/load alone leaves entries/goal hydration fenced; the complete committed hydration read set must remain usable. Proposed host dialog caching also needs all answer/cancel paths and relay ordering, not only local WebSocket replay. Evaluate bounded in-flight delivery rather than a lifetime duplicate cache, and prevent synchronous cancel/resolution followed by stale request publication. Same owner revising in `run_2e94b870`; host/server, relay-client and UI-bridge additions are not approved for implementation yet. Frozen source stays `4e72bf0`.
- 2026-09-11 review checkpoint: final private target `4e72bf0` includes metadata-safe atomic replacement; parent reran 60 worker + 8 real-host tests. Single review `/tmp/review-durable-empty-sessions.md` requests reconnect-safe question replay, a missing branchWithSummary transaction guard, and consolidated first-turn attempt state; also identifies partial-flush and genuine idle-retirement coverage gaps. Same owner is preparing one batched correction plan (`run_9abae889`) before code. Review target frozen; future fixes append commits. UI research explicitly handed off without UI source changes.
- 2026-09-11 checkpointed ed31842 includes control-plane event/deferred-state separation and candidate no-signal dialog cleanup;81focusedworker+8realhost lifecycle and fullverify reportedgreen. Permission-preservation correction was queued separately and is now active in sameowner runrun_51f0197e; parent inspected commit and confirmed default-mode atomictemp gap is not yet fixed, so no reviewer started. UIresearchhandoff to T111 remains queued; no UIwrites in T108.
- 2026-09-11 staged implementation checkpoint (13 paths, no commit yet) reports fullverify pass(worker455+1skip,host217,UI1054). Realhost test now covers project/Beam/Chat create→workerrestart→fullhostrestart→sameidentity firstsend and deleted/zero/corrupt controls. Parent pre-review inspection found two obvious gaps, sent directly to continuing owner runrun_29f53376 before reviewer allocation: blanket deferredFirstTurnEvents hides answerable ui_request untilaccept (deadlock), and atomic replacement temp defaultmode can widen0600→0644. Owner adding control-plane ownership/rollback tests and permission-preserving commit/retry tests, then fullgate+immutablecommit. T110 notstarted.
- 2026-09-11 revised plan APPROVED with atomic baseline+suffix commit/fail-closed persistence bounds. Parent verified clean worktree and FF-integrated exact350deb6; continuing owner runrun_30783c0d now implements durable actualempty entries + manager-owned deferred firstturn append transaction, zero-message resume and byte-identical rollback, narrow read/mutator fences and realhost project/Beam/Chat matrix. No UI/protocol/harness/AGENTS edits. Commit-failure semantics must preserve accepted RAM state, original disk bytes and ordered retained suffix; wider API changes require checkpoint. Parent owns later upstream public contribution from generic worker proposal. T110 remains dependent explicit legacy UI only.
- 2026-09-11 investigation confirms project/Beam/Chat zero-message managers have real metadata but no file; retirement/restart loses ownership, UI retains stale paths and New session may reuse them. Plan `/tmp/laser-m13-t108-empty-session-plan.md` not yet approved: eager flush can persist SDK preparatory thinking writes before first-send acceptance. Owner revising transactional persistence design and byte-identical refusal tests against corrected T1027fe28af (now main). Split durability T108 from dependent explicit legacy UI T110, same continuing owner; no auto-retry justified by merely missing catalog/pristine view, which also matches intentionally deleted empty files.
- 2026-09-11 claimed: person reports old empty Beam New Session gives “no longer open and has no saved transcript” plus first-send draft-restoration toast; explicitly check ordinary projects too. Source guard host/router.ts workerFor matches exact text; worker stable-sdk.ts open also rejects missing/empty files. Host unwritten summaries are ephemeral and pool retires idle workers. Investigate canonical lifetime before choosing repair; do not just remove guards.
- Ownership ledger: empty-session lifetime · `01a08fe8-c5eb-7754-a665-f1de2410885f` · approved durable-empty/transaction implementation · pinnedPi patch+lock, Stable/server+directworker tests, host lifecycle tests/comments, docs/upstream · base350deb6 · correctedT102 integrated; T104 harness and T106 picker nonoverlapping · done7a37677, source ownership closed · next: source CI and separate upstream contribution; T110 belongs to T111 owner after its integration. Separate from release0.3.7 scope.

#### M13-T107 notes
- 2026-09-11 DONE: v0.3.7 published Latest https://github.com/youssefsiam38/laser/releases/tag/v0.3.7, exact8577bef; both x64/ARM64 build jobs, publish and package-repository deploy succeeded (34587503564). Parent verified12 uploaded assets/nonzero sizes; all9 checksum-manifest entries agree with GitHub SHA256 digests; downloaded install/checksum/signature/provenance sizes+digests match. `gh attestation verify` against offline provenance, exact release workflow/ref/8577bef succeeds (1 entry). Artifacts `/tmp/laser-release037-{public.json,workflow-result.json,attestation.json}`, `/tmp/laser-release037-public-assets/`. Release notes name only T101/T103; no installed app/host update/restart.
- 2026-09-11 exact8577bef source CI34587200633 passed. Parent verified remote main/hash and absent tag, then created/pushed immutable annotatedv0.3.7 at8577bef. Architecture/publication workflow34587503564 started (watcht-56f70d4a, `/tmp/laser-release037-build-ci.log`). Tag pushed; release building, not yet claimed published/downloadable.
- 2026-09-11 review APPROVE (`/tmp/review-release037.md`); parent reran isolated identity and13 release regressions, fast-forwarded main to exact8577bef and pushed only that commit. Source CI34587200633 is running (watch taskt-2cf338b3, log `/tmp/laser-release037-source-ci.log`). No tag or public0.3.7 release yet; ongoing planning/source work remains excluded. Next tag only after exact sourceCI success.
- 2026-09-11 candidate ready `8577bef`:12 version-only changes, all11 manifests/generated version0.3.7; isolated staged identity+verify pass2090 workspace+13 release tests,1skip. Parent inspected diff/range/log and confirmed T1027b5dfe7 is not an ancestor. Single release metadata/scope review assigned `01a08fe1-f1f2-7754-a665-f1d0d461802e`; sourceCI/tag/publish not started.
- 2026-09-11 claimed: user explicitly authorizes releasing only done/reviewed changes and asks for status table. Frozen source `4acae2e` includes T101 (`0ba97dc`+`bad33e9`, review APPROVE) and T103 (`3bdacf5`, review APPROVE) only. T102 review may finish, but T102/T104/T105/T106 are excluded and their owners asked to checkpoint/hold.
- Ownership ledger: release0.3.7 · prep `01a08fdb-f2fe-7754-a665-f1c78349c067`, integration/publication orchestrator · isolated versioned gates · version/generated metadata only · base `616a2a7` · T101/T103 reviewed/integrated · done v0.3.7 at8577bef, source/releaseCI green and assets verified · next: none; installed host untouched.
- 2026-09-11 environment: gh authenticated; current public latest v0.3.6; origin/main `728a1f9`; v0.3.7 absent. Preserve unrelated user-deleted discovery docs/untracked `.laser/settings.json`, screenshot and todo. Reverted only orchestrator’s uncommitted future fleet-doc wording from release candidate; T105 plan retains required wording for next batch.

#### M13-T1 notes
- 2026-09-08 claimed: write `packages/protocol/src/agents.ts` (definitions, policy, runs, events, `SessionAgentInfo`, methods, notifications), extend `SessionSummary`/`SessionState`/`session/new`, schemas and samples.
- 2026-09-08 done: `agents/*` (14 methods) with strict schemas and round-trip samples; `PiExtensionModuleName` gains `background-work`; `lasercode/namer/label` extension message; Subagents manifest reworded for the Laser harness. Evidence: protocol build + 35 tests.

#### M13-T2 notes
- 2026-09-08 claimed: `AgentStore` (`<stateDir>/agents.json`), scoped-skill stat-and-compare validation, `AgentRunRegistry` (`<stateDir>/agent-runs.json`), router cases, worker priming with `agents/sync`, child-session routing, catalog `lasercode/agent` entry parsing, Beam/Chat workspaces, first-provider prompts.
- 2026-09-08 checkpoint (lane H): `packages/host/src/agents/{store,builtins,validate,skills-check,runs,models}.ts`; router table, `--state-dir` argv, `prime()` = `agents/sync`, workspaces `<dataDir>/{beam,chat}` excluded from projects, catalog attribution from `lasercode/agent` entries, `.worktrees` root mapping. Host 210/213 (3 e2e cases wait for the rebuilt worker without `pi-subagents`).
- 2026-09-08 done: host 213/213 after the worker rebuild. Wire-level scene (`SANDBOX_AGENTS=1`, host + real worker on port 41555): `session/new` → prompt "delegate" → `agents/run` running with `worktree.path=<project>/.worktrees/explorer-<id>` and branch `agents/explorer-<id>` → `completed` with "Counted the files." → parent `session/update` carries the `lasercode/agent-event` custom message → `agents/runs/list` by root → `pi/session/list` shows the child with `agent.kind=child`, `subagentName`, `parentPath`, `runStatus` and cwd mapped to the project root → `session/load` of the child routes to the project worker (one worker) → a user prompt to the idle child creates an `origin: user` run that ends `completed`. `.git/info/exclude` gained `/.worktrees/`; `git worktree list` shows both children on the base commit.

#### M13-T3 notes
- 2026-09-08 claimed: `packages/worker/src/agents/*` harness against `packages/pi-extension/src/agents-bridge.ts`; per-agent driver options; `.worktrees/` manager; Namer; Beam skill; stop loading pi-subagents.
- 2026-09-08 done (lane W): `packages/worker/src/agents/{harness,worktrees,session-config,definitions,namer,beam-skill,engine-instructions,skills}.ts`; `DriverOpenOptions.agent`; `--state-dir`; pi-subagents dependency and loader removed; `check-packaged-session` reports `modules` and `beamSkillPath`. Evidence: `pnpm -F @lasercode/worker build && typecheck && test` — 190 passed, 1 skipped (28 files) including the golden real-engine test (parent `start_agent` → child in `.worktrees/` → `complete_agent_run` → one `lasercode/agent-event` in the parent). Finding for M13-T12: `resourceLoader.reload()` re-reads settings and drops `applyOverrides` values during service creation.

#### M13-T4 notes
- 2026-09-08 claimed: `modules/subagents.ts` becomes the harness tools module; new `modules/background-work.ts`; retire the pi-subagents bus bridge.
- 2026-09-08 done (lane X): `modules/subagents.ts` registers `start_agent`/`send_agent_message`/`list_agents`/`wait_for_agents`/`stop_agent` for delegating sessions and `complete_agent_run` (`terminate: true`) for children; role block via `before_agent_start`; parent delivery `lasercode/agent-event` (steer, triggerTurn). `modules/background-work.ts`: `bash` override with `background` flag and promotion, `task_list/output/wait/stop`, `tasks:<id>` run panels with `file:` output refs, `lasercode/task-event`. pi-subagents bus bridge deleted. Evidence: `pnpm -F @lasercode/pi-extension build && typecheck && test` — 50 tests.

#### M13-T5 notes
- 2026-09-08 claimed: UI store slice (`agents`, runs, events, namer labels), client wiring, Agents workbench page.
- 2026-09-08 checkpoint (lane U0): store slice `state.agents`, `view.namerLabels`, `actions.agents.*`, `@/agents` model/tree/hooks, `newSession(cwd, { agentName })`; 40 new UI tests (590 total). Screens in progress (lane U1).
- 2026-09-08 done (lane U1): `components/agents/page/{AgentsScreen,AgentList,AgentEditor,BuiltinPanel,HarnessPanel,Overview,AgentsButton}.tsx`, `elements/agent-card.tsx` adopted; workbench page `agents` with `AgentsTarget` deep links; rail and sheet-footer entry with warning mark; 28 interaction tests. Browser: desktop 1280 dark/light (create through the real host, engine instructions, Namer states, Beam model picker, keyboard list), phone 390 dark/light. `client.ts` now keeps JSON-RPC `error.data` so refused saves land on their fields.

#### M13-T6 notes
- 2026-09-08 claimed: thread list sub-sessions, Chat | Code tabs, Beam group icon, `EndAgentDialog`, projections.
- 2026-09-08 done (lane U2): `thread-list.aui.tsx` with Chat | Code tabs, Beam group mark, nested children on a lineage rail, parent count chip, child row menu; `components/agents/EndAgentDialog.tsx` + `end-agent.ts`; projections `AGENT_COMPLETION_DATA_PART`/`AGENT_EVENT_DATA_PART`/`TASK_EVENT_DATA_PART` (`complete_agent_run` becomes the child's final message; `lasercode/agent-event` renders through the Handoff element with Open chat; `lasercode/task-event` notice); Namer labels in tool rows and the aggregate; `ParentCrumb` in the top bar; `complete_agent_run` search projection. 16 new tests. Browser: desktop 1280 dark/light and phone 390 dark on the sandbox delegation scene.

#### M13-T7 notes
- 2026-09-08 claimed: `@xyflow/react@12.11.6` (exact) added to `packages/ui` devDependencies; `AgentMap` with measured-size layouts.
- 2026-09-08 done (lane U3): `components/agents/map/*` on `@xyflow/react@12.11.6` — `layoutTree` (deterministic layered, structure-keyed), compositions constrained/panel/full by measured size, `AgentNode`/`AgentEdge`/`EventBubbles`/`Inspector`/`LineageList`, `MapHeader`, `AgentMapView` (top-bar toggle), `AgentMapFullscreen`, `MapDockIsland`; `agent-map.css` maps every `--xy-*` variable onto tokens; 21 tests. Browser: desktop 1440 dark/light (panel and fullscreen, show-ended fold, bubbles, dock island) and phone 390 dark (list → fullscreen → sheet inspector).

#### M13-T8 notes
- 2026-09-08 claimed: rail spark, `BeamBubble` with an independent thread scope, Beam model choice dialog, Chat area.
- 2026-09-08 done (lane U4): `components/beam/{BeamSpark,BeamBubble,BeamEmptyState,BeamModelDialog,BeamSessionMark}.tsx`, `beam-store.ts`; `LaserThreadScope` in `LaserProvider.tsx` (second thread-list runtime over the same store, isolated); spark below Settings in the rail and beside Settings in the phone sheet footer; grep-guard test that no other surface creates Beam sessions; 21 tests. Browser: desktop 1366 dark/light (bubble grows from the spark over the chat and over the Agents page, first message creates the Beam session, Open in full view, Escape returns focus), phone 375 sheet.

#### M13-T9 notes
- 2026-09-08 claimed: remove `pi-subagents` from the worker manifest and loader, update `check-packaged-session.ts` and `clean-machine.mjs`, docs.
- 2026-09-08 checkpoint (lane D): `clean-machine.mjs` checks harness modules and the Beam skill; `electron-builder.yml.tpl` regenerated; `SANDBOX_AGENTS=1` scene with a git-initialised sandbox project; docs: `docs/agents.md` (new), architecture, ux-agent-work, ux-elements, product-boundary, pi-extension-modules, upstream, CLI README, AGENTS.md regression checks. Desktop 83 tests; release tests 13.
- 2026-09-08 done: `pnpm -F @lasercode/desktop run pack` (electron 44.2.0, node 24.20.0 staged) then `node packages/desktop/scripts/clean-machine.mjs` — "Every packaging claim held": 298 packages, 0 symlinks; pi-subagents no longer required; a real session opens with every bundled feature (1336 models); active modules include `subagents` and `background-work`; the packaged worker writes the Beam skill (5.0 KB, measured inside the check's sandbox because that sandbox is removed on exit); the machine's own agent directory is seen and not used. The first run failed only because the gate stat-ed a path the check had already cleaned up; the report now carries `beamSkillBytes`.

#### M13-T10 notes
- 2026-09-08 planned: host e2e with a stub provider that answers a child prompt with `complete_agent_run`; sandbox scene; browser review.
- 2026-09-08 checkpoint: wire-level delegation scene passed (see M13-T2 notes). A user stop over the wire raced the instant fake child and answered the completed record (correct: "finished before you decided"); cancellation with a verbatim reason is proven by `packages/worker/test/agents/harness.test.ts`. Remaining: browser review, packaged gate, full verify.
- 2026-09-08 checkpoint (coordinator, built bundle on the `SANDBOX_AGENTS=1` sandbox, 1440×900 dark): rail shows Agents, Logs, Settings and the green spark last; sidebar nests `explorer` under its parent with a "1 agent" chip; parent transcript shows "Started explorer (default)" with Open chat, the completion card and the follow-up; Map toggle → panel composition with the ended child folded ("1 ended"), Show ended reveals it, fullscreen shows rich nodes, the STARTED edge and the inspector (timeline, task, result, worktree branch); Open chat lands on the child with the "… › explorer" crumb, the `Run ls` row and the Completed final message; the Beam bubble grows from the spark with its empty state, the first message creates a Beam session while the main view stays on the child; the bubble stays available over the Agents page; the theme toggle repaints every new control from tokens. Phone 390×844 (DOM, pane hidden): Agents page list-first; sessions sheet with Chat | Code tabs, nested child marked Done, Beam group and the footer spark. Found and fixed: quick foreground commands were emitting `tasks:*` run panels (dock islands and run tabs) — panels now exist only for explicit or promoted background tasks. Full workspace gate: identity check, `pnpm -r build`, `pnpm -r typecheck`, `pnpm -r test` (protocol 36, pi-goal 7, relay 17, crypto 42, pi-extension 50, ui 676, worker 190+1 skipped, host 214, cli 53, desktop 83), release tests 13 — all green. Note: the automation key `Return` does not send in either composer while `Enter` does; a keyboard artefact of the tool, not the app.
- 2026-09-08 done: host 214, worker 190 (+1 skipped), desktop 83 after the last fixes; identity check green; packaged gate green (M13-T9 notes). Evidence per scenario: schemas (protocol 36), lifecycle transitions and permissions (worker `test/agents/harness.test.ts`, 20), persistence and reload (host store/registry/catalog tests; wire scene reload of the child through the host), worktree isolation and nesting (worker `worktrees.test.ts` real git; harness depth refusal; host `worktrees.test.ts`), goals (role block carries the objective, pi-extension `subagents.test.ts`), skill warnings (host `skills-check.test.ts`; UI deep link test), background promotion (pi-extension `background-work.test.ts`), termination attribution (harness user stop with verbatim reason; UI `end-agent-dialog.test.tsx`), navigation (UI map, sidebar and projection tests; browser review). Desktop/phone, both themes, pointer and keyboard: lane reviews plus the coordinator's integrated pass (notes above).

#### M13-T13 notes
- 2026-09-08 claimed: Beam refused to start a chat in the review container with the engine's "Stored session working directory does not exist: /review/beam".
- 2026-09-08 done: the workspaces moved from `dirname(stateDir)` to `<stateDir>/workspaces` (the host creates and owns its state directory in every layout; `/review` is root-owned in the review image, so `/review/beam` could never be created). `session/new` in a workspace now creates the folder first and refuses the session with the reason when it cannot, instead of letting a session be created against a directory that does not exist. The worker recreates a missing Beam or Chat workspace before building the engine runtime, so chats stored under an older layout still open; a project session keeps the engine's refusal, because a project that vanished is the person's to restore. The sidebar groups Beam and Chat sessions by their record, so a session whose header names an old workspace never becomes a project group or a rail entry. Evidence: `pnpm identity:check`, `pnpm -r build`, `pnpm -r typecheck`, `pnpm -r test` (protocol 36, pi-goal 7, crypto 42, relay 17, pi-extension 50, ui 678, worker 192+1 skipped, host 215, cli 53, desktop 83), release tests 13. New regressions: host `router.test.ts` (workspace created before its worker; refusal names the folder and the reason), worker `session-config.test.ts` (header cwd, recreation for beam/chat only, unwritable refusal) and `stable-sdk.agent.test.ts` (a real Beam session reopens after its folder is deleted; a project session still refuses), UI `session-groups-workspaces.test.ts`.

#### M13-T14 notes
- 2026-09-08 claimed: the user reported "Run setup again" (Settings → This device) not doing what it says.
- 2026-09-08 done: the button made two promises the app did not keep. It cleared the host's flag and toasted that setup would run "the next time" the app opened with no session, but the shell keeps its own copy of the host's answer (`useSetupPending` is per caller) and only re-read it on connect, and a reload restores the remembered session, so "no session open" never came around. It now starts setup immediately: clear the flag, forget the step the flow last stopped on (a fresh run must open on the welcome step, not the finish line `resumeStep` would return), hand the request to the shell through a small store (`components/onboarding/setup-request.ts`, the fleet/end-agent pattern) and close the workbench. The shell honours it with `honourSetupRequest`: read the host again, forget the remembered destinations so a reload mid-setup cannot restore one, and leave the open session — the flow owns the whole window (D-47) and the session keeps its row in the sidebar. Evidence: `packages/ui/test/onboarding/run-setup-again.test.tsx` (the host call, the cleared step, the request, the closed workbench, no stale announcement, a host refusal keeping the person in Settings, the store's notifications, and the shell handling clearing `lasercode-session`); full gate green. Browser (sandbox, 1440x900): with a session open behind Settings, pressing it replaced the window with the welcome step and cleared the remembered session; Skip returned to the shell with the session still listed; a second press worked from the reopened session; the section reads correctly in the light theme and at 390px with no horizontal overflow.

#### M13-T15 notes
- 2026-09-08 claimed: the user asked for a second way into Beam, a maximize that works on an empty bubble, and the microphone inside the bubble.
- 2026-09-08 done (D-143): Beam's group in the sessions sidebar has a `+` again ("New Beam chat") that starts a chat in the window through `startBeamSession`, the one place the agent's name and workspace are spelled; the workspace never becomes the rail's current project. The bubble's maximize is enabled whenever Beam is ready: with a chat on screen it moves that chat into the window, with an empty bubble it starts one there ("Start a chat in full view"), which is the same wish and used to be a dead control. The microphone now works in a second composer: the transcription scope is claimed on the way into recording rather than on mount (a mounted bubble used to take the scope from the session's own composer and clear it on close), and a finished phrase is typed into the composer that owns the microphone rather than the first textarea in the document. Evidence: `packages/ui/test/beam/dictation-scope.test.tsx` (3), the Beam group case in `test/shell/sessions-tabs.test.tsx`, the empty-bubble maximize case in `test/beam/bubble.test.tsx`, and the updated `test/beam/entry-points.test.ts`; full gate green. Browser (sandbox): desktop 1440x900 — the mic appears in the bubble's composer and in the session's own, one each; maximize on an empty bubble opened a new Beam chat in the window with the Beam mark in the top bar; the sidebar's `+` did the same without opening the bubble. Phone 390x844 — the bubble is a sheet, its composer carries the mic inside the input pill at a 36px paint with the touch target beyond it, and the page never scrolls sideways.
- 2026-09-08 also: `test/agents/map/map.test.tsx` was flaky in full-suite runs (twice). The arrival marker lives for one morph and the assertions sat inside that window on a real clock, so a loaded machine spent the window between two awaits. It now runs on fake timers like its sibling; two consecutive full-suite runs pass.

#### M13-T16 notes
- 2026-09-08 claimed: the user asked that tools leave the agent definition (every agent has every tool) and that the run timeout and all its restrictions go, so an agent can work for months.
- 2026-09-08 done (D-144): `tools` and `runTimeoutMinutes` are gone from `AgentDefinition`, its input, the schema, the store file, the validator, the seeds and the editor; `AGENT_TOOL_NAMES`, `AGENT_DEFAULT_TOOLS`, `AGENT_RUN_TIMEOUT_*`, `TIMEOUT_LIMITS`, `describeTools`, `describeTimeout` and the `TimeoutField` are deleted rather than left unused. The driver hands every session every engine tool (`activateEveryTool`, `ENGINE_BUILTIN_TOOLS`) and no longer passes `excludeTools`; web search follows its feature for everyone. The harness has no timer: `armTimeout`, `RunState.timer` and `AgentRun.timeoutAt` are gone. Breaking on purpose, as the user directed: `timed_out` is removed from `AgentRunStatus`, `AgentEventKind` and `AgentModelEvent`, and a stored run carrying it is dropped on load rather than migrated. Chat's instructions no longer claim it has no file tools; it works in its own scratch workspace.
- 2026-09-08 also, found while making sure nothing else could cut a long run short: the idle sweep still asked the retired pi-subagents file layer whether a project was busy, so a project whose only work was a harness child — no client attached, no request in flight — would have had its worker retired after ten minutes and the child killed. It now asks the run registry (`hasLiveRun`), and `sessionIds` is deleted. Checked too: run retention only prunes terminal runs, and `wait_for_agents`'s timeout ends the wait, never the run.
- 2026-09-08 evidence: `pnpm identity:check`, `pnpm -r build`, `pnpm -r typecheck`, `pnpm -r test`, release tests. New or rewritten: worker `harness.test.ts` ("lets a run go on with no limit of any kind" advances 90 days and the run is still running, then ends only when the agent reports), `session-config.test.ts` (every tool, no definition narrows it), `stable-sdk.agent.test.ts` (a custom definition still receives every engine tool), host `worker-pool.test.ts` (a project with a live run survives repeated sweeps), `runs.test.ts` (`hasLiveRun` for a months-old run), UI `screen.test.tsx` (the form offers no tool choices and no run timeout).

#### M13-T17 notes
- 2026-09-08 claimed: the user reported that the provider-first model picker, used all over the app, lists every built-in provider instead of the ones they have connected.
- 2026-09-08 done (D-145): one rule, `narrowToConnected` in `components/assistant-ui/elements/connected-models.ts`, and one place it comes from at the source. The worker's `listModels` (`pi/model/list`) now answers from the engine's own auth state, so a session's picker offers only models it could actually switch to; with no credential at all it falls back to the catalogue rather than showing an empty menu. Every catalogue-fed picker that chooses a model to use applies the same rule: the composer with no session open, the Agents page editor and its Beam model dialog (through `useModelCatalog`), Beam's own model dialog, Settings' default provider, default model and per-model thinking overrides, and the onboarding model step, which had its own copy of the logic and now shares this one. Two surfaces deliberately keep the whole catalogue, with the reason in the code: Settings → Providers and models, where a person connects one, and the enabled-models control, which curates the catalogue and must include providers not yet connected. Evidence: `packages/ui/test/settings/connected-models.test.ts` (5 cases: narrowing, none connected, unreadable providers, a disabled model from a connected provider, keeping the model a surface already holds), the worker's real-engine case in `stable-sdk.agent.test.ts` (the sandbox's own provider is offered and the answer is a small part of a 1,300-model catalogue) and the clarified no-credential fallback in `stable-sdk.open.test.ts`; full gate green. Browser (sandbox, 1440x900): the composer's picker went from about forty providers to the two connected on this machine, showing one provider and one model for the sandbox session; the Agents page editor's model list showed 38 models from the single connected provider instead of the whole catalogue.

#### M13-T18 notes
- 2026-09-08 claimed: the user asked whether the goal tools should be attached only when the goal command is used, and told me to take it on.
- 2026-09-08 done (D-146): `goal_complete`, `goal_blocked` and `goal_wait` are registered by the engine at load, so they sat in every request of every session with Goals on. They now reach a request only while a goal is in play. `packages/pi-goal` owns `GOAL_TOOL_NAMES` and `test/policy.test.ts` pins the list to the installed engine, so a rename fails there instead of silently un-gating. The companion's goal module takes them away on the first turn of a session with no goal (`syncGoalTools`, never throws: a wider tool list is a cost, a dead turn is a fault).
- 2026-09-08 the ordering caveat I flagged before starting turned out to be real, and the real-engine test is what found it: the engine's `assertGoalToolsAvailable` refuses to start or resume a goal whose tools are not already in the active allowlist ("goal_complete and goal_blocked are unavailable; include them in the active tool allowlist"). Gating on an existing goal alone is circular — no goal can ever start. Worse, `input` does not fire for a command, so the companion has no hook early enough. The worker switches them on instead, where the text about to become a command is still in hand: `prompt()` when it sees `/goal`, and `goalAction()` for the product's own path.
- 2026-09-08 evidence: `packages/worker/test/agents/goal-tools.test.ts` against the real engine and a stub provider, reading the tool list of the request the provider actually received — absent from an ordinary turn, all three present on the first goal turn, absent again once the goal is cleared; `packages/pi-extension/test/goal-tools.test.ts` (6 cases: removal, restoration, no write when already right, a session without the goal engine, an engine that refuses the change, and the command forms); `packages/pi-goal/test/policy.test.ts` pins the names. Full gate green: 1,398 tests.

#### M13-T19 notes
- 2026-09-08 claimed: the user reported "This agent does not start other agents, so it cannot list any." blocking every attempt to create an agent.
- 2026-09-08 done: the blank form opened on a state the host refuses. `defaultAgentDefinitionInput` seeded `allowedAgents` with every custom agent while `supportsSubagents` stayed false, and the validator rejects that pair, so Create agent was disabled on a form the person had not misfilled. The seed is now empty, and the editor's delegation toggle owns both halves: turning it on offers every agent it could start (the convenience the seed was for), turning it off empties the list, so a definition can never contradict itself. The host's validator stays as the backstop.
- 2026-09-08 the test that should have caught it did the opposite: the create case turned the toggle on before saving, so the blank path was never exercised, and a unit test pinned the seeded list as correct. Both are replaced: a new agent that starts nothing now saves without the toggle being touched, and the toggle's on/off behaviour is asserted.
- 2026-09-08 evidence: `packages/ui/test/agents/page/screen.test.tsx` (blank save reaches `agents/save` with `supportsSubagents: false, allowedAgents: []`; toggle on fills, toggle off empties), `test/agents/model.test.ts` (the blank input agrees with itself); full gate green, 1,400 tests. Browser (sandbox, 1440x900): a new agent filled with name, description and instructions alone showed no issues, Create agent was enabled, and saving reported "solo-reviewer saved" with the list moving to 2 agents.

#### M13-T20 notes
- 2026-09-08 claimed: the user asked that opening the model picker anywhere in the app put the caret in the model search.
- 2026-09-08 done: `ModelSelectorContent` handles `onOpenAutoFocus` and focuses `[data-slot="model-selector-search"]` inside the panel, so every picker in the app gets it from one place — the composer, the Agents editor, Beam's dialog, Settings' defaults and thinking overrides, and the onboarding step all render through it. Radix would otherwise focus the panel and the first keystroke would go nowhere. The provider filter inside the provider/model menu is its own nested popover with its own input, so the query only ever finds the model search; a menu with no search box keeps Radix's behaviour, which the stock list needs for its hidden keyboard anchor. Any `onOpenAutoFocus` a caller passes runs first and can still prevent the default.
- 2026-09-08 evidence: `packages/ui/test/thread/model-picker-focus.test.tsx` (the model picker and the provider-only picker each focus their search on open); full gate green, 1,402 tests. Browser (sandbox, 1440x900): opening the composer's picker put the caret in "Search stub models" and typing "stub" went straight there; the Agents editor's picker focused its search the same way.

#### M13-T21 notes
- 2026-09-08 claimed: the user found that only Beam offers a model choice; Chat and Namer do not. All three built-ins must let the person pick a model.
- 2026-09-08 checkpoint: the two one-off methods are gone; `agents/builtin/set-model { name, model }` serves all three, `AgentsSnapshot` gains `chat`, and the host store dispatches to the right built-in. Chat's definition carries the choice through to its sessions (`DefinitionsCache.chatModel()`); `null` still means "follow the default model" and the card says so as a resting state. One dialog and one button for all three, rendering through `ModelSelectorContent`, so connected-providers-only (D-145) and caret-in-search (M13-T20) come free. A file written before `chat` existed reads as `{ model: null }` and junk is dropped, never thrown on.
- 2026-09-08 two bugs found while verifying in the browser, both fixed: an agent with no model opened the picker already showing the first model beside a disabled "Use this model" (`ModelSelectorRoot` is uncontrolled when `value` is falsy — a sentinel id no real option can match fixes it locally, without touching the shared element), and the dialog would not close after a save because the open guard swallowed the programmatic close while `busy` was still true.
- 2026-09-09 row flipped to done at integration: the work shipped in fa3ebd4 and 99fe699 and has been under every browser pass since; the state column had not been updated.

#### M13-T22 notes
- 2026-09-08 claimed: the user reports Namer does nothing — no session name after the first prompt, no label on a running action. Qualification only ever runs from a provider sign-in event in the same host run, so an installation whose providers were already connected never qualifies and naming stays off.
- 2026-09-08 checkpoint: the diagnosis held. Qualification now runs from `prime` as well as from a sign-in, once per provider set per host run, one at a time, behind the first request that needed a worker — a fresh host does not spawn a runtime just to benchmark. `namerNeedsQualifying()` is `model === null && (unqualified | unavailable)`, so a model a person picked is never benchmarked over, and `unavailable` stays retryable because it is a verdict about the providers of the moment.
- 2026-09-08 the first prompt of a session with no model yet is held (capped) and named the moment `agents/sync` or qualification lands, so a session opened in the first milliseconds still gets its name. Labels: up to three in flight per session instead of one, deduped by tool call id, and dropped both before and after the completion when the call has already ended — a label nobody will see is not worth paying for. A model the person switched off is never nominated.
- 2026-09-08 hazard recorded: a worker reports a provider configured from an environment credential, so any test that boots a real host now benchmarks Namer against it. The e2e enables only the stub model; every new real-host test must do the same.
- 2026-09-09 row flipped to done at integration: the work shipped in fa3ebd4 and 99fe699 and has been under every browser pass since; the state column had not been updated.

#### M13-T23 notes
- 2026-09-08 claimed: the user reports a child session's transcript does not open with the task its parent sent, so arriving at a child gives no idea what it was asked to do. Reproduce in the sandbox agents scene first.
- 2026-09-08 reproduced: the task text is present in every state — the harness persists the marker and the prompt before the child ever streams — but it rendered as an anonymous user bubble. The complaint was attribution, not absence.
- 2026-09-08 checkpoint: a user block can now carry `sentBy`, armed by the `lasercode/agent-run` `started` marker already in the child's file (hydration) and by the `agents/run` notification the harness publishes before `kick()` (live), consumed by the next user message and nothing after it. It rides on `MESSAGE_METADATA_NS` beside `goalSetter`, so content parts are untouched and search still finds the task text. The row reads "Task from <parent>" with the parent clickable through the same navigation as the header crumb, and is excluded from find so no match is spent on chrome. A message sent to a busy child starts no run and has no marker; it stays unattributed, noted in a comment rather than guessed.
- 2026-09-09 row flipped to done at integration: the work shipped in fa3ebd4 and 99fe699 and has been under every browser pass since; the state column had not been updated.

#### M13-T24 notes
- 2026-09-08 claimed: sub-sessions nest correctly but cannot be folded away, and finished children sit among the live ones. The user asked for a fold on the parent and a second fold for the finished, dimmed children.
- 2026-09-08 checkpoint: two fold layers that never overwrite each other — what the person chose (persisted, capped, every read and write guarded) and what the app pinned open (session-local, only ever opens). A branch is open by default while anything under it is live, and a run *ending* never collapses it, because that would move the list under a hand. A parent's disclosure is a real button in the row's leading gutter, sized to the gutter on coarse pointers so it never overlaps the title.
- 2026-09-08 a branch counts as settled only when its whole subtree is, so a completed child with a working grandchild stays with the live ones; `blocked` is treated as live even though it is a terminal run status, because "needs you" is not finished. Finished children sit in a second fold below, closed, dimmed — except a failed row and the open session, which keep their ink so the one that went wrong is still findable. The parent's chip leads with the most attention-worthy state and carries the full breakdown in its tooltip. Selecting a session opens every ancestor fold, including the finished one it may be inside.
- 2026-09-08 fixed in passing: a pinned parent rendered its children nowhere at all — the pinned section did not render a branch. Search is deliberately untouched: the needle flattens the tree, so no match can hide behind a fold.
- 2026-09-08 not verifiable in the browser: the sandbox child reaches the session catalog only after its run has completed, so a live child row and a failed child row are covered by interaction tests rather than by eye.
- 2026-09-09 row flipped to done at integration: the work shipped in fa3ebd4 and 99fe699 and has been under every browser pass since; the state column had not been updated.

#### M13-T25 notes
- 2026-09-08 claimed: the user found that Open chat in the fleet does nothing. Reproduced on a sandbox: the click round-trips to the worker, whose `handlePanelAction` answers `open` with "delivered" and deliberately does nothing because the navigation belongs to the UI — and no UI surface ever performed it. Dead in the dock, inline and in run tabs too, not only in the fleet.
- 2026-09-08 fixed in the one funnel every panel action passes through (`PanelsProvider.act`): an `open` on an `agents:run:<runId>` panel resolves the child's session path from the run registry, falling back to the session catalog so a run from an earlier host process still opens, and navigates without a round trip. The fleet sheet steps aside when the open session changes, so it no longer covers the chat it was asked to show.
- 2026-09-09 row flipped to done at integration: the work shipped in fa3ebd4 and 99fe699 and has been under every browser pass since; the state column had not been updated.

#### M13-T26 notes
- 2026-09-08 claimed (D-147): the user decided the panel system goes and the fleet takes its place as a permanent column beside the monitor. Confirmed with them before opening the lane: monitor outermost right, fleet immediately left of it, both permanent and independently collapsible, sheets below desktop width. The sticky run tabs, the dock, the ambient pill and the popped-out panel page all go with it.
- 2026-09-08 the three questions the deletion could not answer on its own, answered by the user: extension `select`/`input`/`editor` dialogs render inline in the transcript beside the tool approvals that already live there; background command output and log streams become work items in the fleet; web-search results are already in the chat, so that panel is deleted with nothing to rehome.
- 2026-09-09 row flipped to done at integration: the work shipped in fa3ebd4 and 99fe699 and has been under every browser pass since; the state column had not been updated.

#### M13-T27 notes
- 2026-09-08 found while attributing a child's task (M13-T23), in code that change did not touch. Open a child, then the header's "Parent session" crumb: the parent's transcript renders every message twice, and the same going back. The duplicates carry no attribution, which fingerprints them as replayed live updates landing on top of hydrated blocks. `openSession` (`packages/ui/src/runtime/LaserProvider.tsx:569`) calls `client.track(path, view.lastSeq)` when re-opening a hydrated view; a child that ran while nothing was attached still has `lastSeq` 0, so the worker replays its whole buffer over blocks that already hold it. A reload clears it.
- 2026-09-08 claimed: `lastSeq === 0` is doing two incompatible jobs — "I hold nothing" and "I hold everything the file had, and no live update has landed since". A child that ran while nothing was attached is always in the second state, so the re-open asks for `fromSeq: 0`, the worker replays its whole buffer (`replay(live, 0)` re-sends every `seq > 0`), and `replayFloor` answers 0, which matches, so `needsResync` never fires. The fix is to stop inferring the sequence from silence: `session/load` reports the session's current seq and hydration stamps it, so a re-open asks a truthful question. Deduping blocks downstream would hide the lying `fromSeq`, not fix it.
- 2026-09-08 checkpoint: `session/load` now answers with `seq`, the worker's watermark for that session at the moment it replied, and hydration stamps it on the view. A re-open then asks a truthful `fromSeq` and the worker replays only what is genuinely missing. `client.track` was recording the same stale watermark, so the reconnect resume replayed whole buffers for the same reason; one fix covers both.
- 2026-09-08 correction to the claim above: the child direction is exactly as diagnosed, but the parent does not double merely because you came back to it. A parent whose turn you watched has a truthful `lastSeq` already. It doubles under the same root cause only when its view was hydrated with no live update ever landing — after a reload, when the turn was driven from another client, or when it was opened after the turn finished. The fix addresses the shared condition rather than either direction.
- 2026-09-08 the regression test is a `HostClient` fake that models the worker's replay buffer for real, driven through the actual provider: single transcript on re-open, live updates after hydration still applied, a scoped open, two concurrent opens hydrating once, a worker-restart epoch resyncing, and a replay-buffer hole re-reading the file. Four of the six fail without the fix, with doubled transcripts.
- 2026-09-08 open at integration: the browser repro could not run (the panels lane had the UI build red mid-flight), and the `lastSeq` stamp lives in the `hydrate` reducer, which is a file the panels lane owns. Re-run both after M13-T26 lands.
- 2026-09-09 row flipped to done at integration: the work shipped in fa3ebd4 and 99fe699 and has been under every browser pass since; the state column had not been updated.

#### M13-T28 notes
- 2026-09-08 requested by the user with a reference screenshot: one row above the composer holding the queued message, a Steer action, a delete and an overflow. Leaving the message alone means it waits for the agent to finish; Steer interrupts explicitly. Steering must leave no trace in the transcript — no "You stopped it", which is what appears today because the only way to force a queued message through is to press Stop.
- 2026-09-08 blocked on M13-T26: the panel removal rewrites `Composer.tsx`, `messages.tsx`, `adapter.ts`, `store.ts` and the worker server, which is most of this task's surface.
- 2026-09-08 checked the pinned engine before writing the brief: `AgentSession` (0.85) offers `steer`, `followUp` and `clearQueue` only — `clearQueue` empties both lanes and `_steeringMessages` is private, so there is no per-item removal, edit or reorder to build on. The `message-queue` element's own comment already records this as the reason it has no per-item remove. The recommended route is a tray the worker owns, with Pi's `steer()` called only when a person explicitly steers one item, so nothing ever sits in both queues; an upstream per-item operation is worth proposing but must not block the task.
- 2026-09-08 the premise turned out to be half wrong, and checking it removed work rather than adding it. The engine's `steer()` **never aborts** — it pushes onto the steering queue and the engine delivers at the next turn boundary — so steering has never produced an `aborted` stop reason and needs no marker in the data to tell it apart from a stop. "You stopped it" appeared only because pressing **Stop** was the way to force a queued message through. Take away the need to press Stop and the notice goes with it; a real Stop still draws it.
- 2026-09-08 done, route 1: the waiting list is Laser's own, in the worker, with per-item verbs (`session/pending/{list,add,edit,remove,steer,clear}`). A steered message leaves that list for the engine's queue in the same call, so nothing is ever in both and the two can never disagree. Delivery is head-first on `agent_settled`, each message its own turn, in order; a refused delivery falls back to a steer; a failure keeps the message and its reason and retries at the next settle.
- 2026-09-08 the keys swapped, which is the behaviour change worth remembering: Enter while running now puts the message in the tray, and Cmd/Ctrl+Enter steers — one keyboard path, no chord to reach the ordinary case. A steered row carries no controls, because the engine has no verb behind a message it already holds; that is capability honesty, not an omission.
- 2026-09-08 evidence: 18 worker tests including "no `aborted` update follows a steer", 13 UI tests over the real provider and thread runtime — pointer and keyboard on all three controls, the overflow menu, Clear hitting both queues, and a reload leaving the row in place — plus a projection test that a steered conversation draws no incomplete status while a real stop still draws one. Browser at both widths and themes: two waiting rows during a 30 s command, delivered in order at the end, with no stop notice anywhere in the transcript.

#### M13-T29 notes
- 2026-09-08 requested by the user: a shell command exiting non-zero turns the whole aggregate red — a danger rail down the group, a red alert icon, an "N failed" count, and the group forced open. A `grep` that found nothing is not an emergency, and the transcript should not make it feel like one. The whole treatment is to be the failed command's own text in red, gently, and nothing else.
- 2026-09-08 claimed. The line that matters is between "ran fine, exited non-zero" and "could not run at all": the first goes quiet, the second keeps the treatment it has, because a turn that went wrong with nothing to show is worse than one that says why. The lane has to establish whether the data distinguishes them today and report honestly if it does not. Quiet is not hidden: the accessible name and the exit code stay truthful.
- 2026-09-08 the user, with a second screenshot, widened it: the **left border rail** of the aggregate block must go too — "this gives indication of error that should not be given" — and so must the rails on the individual rows inside it. Their example is a failed *file read* (`ENOENT`), not a shell command, which settles a question the first brief left open: the structural red — rail, border, icon, failure count — goes for **every** failed action, not only for a non-zero shell exit. Only the failing line's own text is red. The narrower shell/broken-tool distinction survives only where it is about something other than colour, such as whether a group forces itself open.
- 2026-09-08 this session cannot message a running lane, so the widening is applied on top of the lane's work at integration rather than folded into its brief.
- 2026-09-08 the distinction turned out to be real and readable, not an approximation. Pi's shell tool throws on a non-zero exit with a trailing `Command exited with code N`; every other way it fails — spawn error, abort, timeout, denial, tool not found — throws without that trailer, and the trailer survives into the stored session file, so a reloaded transcript reads the same. One named predicate, `isNonZeroExit` (`tool-summary.ts`), with the provenance written above it.
- 2026-09-08 the quiet red is two derived tokens, not a literal: `--color-danger-quiet` for the page ground and `--color-terminal-danger` for the terminal ground, both mixed toward the muted ink. Measured 6.2–8.2:1 dark and 5.0–6.1:1 light; terminal red 8.2:1 on the terminal ground.
- 2026-09-08 done, after the user's widening: the structural red is gone for **every** failure, not only a non-zero exit — no rail on the group, no rail on the row, no alert icon, no failure count. `attention` keeps its rail, because a question waiting on a person is not a result. A group that broke still opens itself, so the failure is in front of the person rather than behind a fold, and the trigger's accessible name says "Something in it failed" — quiet is not hidden. The monitor's step chips read from the same predicate, so the two surfaces cannot disagree.
- 2026-09-08 evidence: `packages/ui/test/thread/quiet-shell-failures.test.tsx` rewritten around the widened rule, including a row that is waiting on a person keeping its rail; 168 tests across thread, elements and settings green; typecheck clean.

#### M13-T30 notes
- 2026-09-08 the user, on the new fleet: the fleet does not distinguish a background command from an agent. `DetailActions` (`packages/ui/src/components/fleet/FleetPanel.tsx:130`) renders "Open chat" for both kinds, but a command has no chat of its own — `FleetItem.sessionPath` is its owner's session. The split already exists two lines below, where a task says "Stop" and an agent says "End agent…"; it was simply not carried into this control.
- 2026-09-08 what it should be: an agent item keeps "Open chat", because a child agent does have its own chat. A task keeps a control to reach the conversation that started it, named for what it actually does, and ideally lands on the tool call that launched the command rather than the bottom of the session — the thread's existing scroll-to-message machinery, not a second one. The whole new fleet surface needs the same sweep: copy, icons, tooltips and accessible names that imply a task has a session of its own. An orphaned task whose owning session is gone must not leave a dead button, which is exactly the M13-T25 bug.
- 2026-09-08 blocked on M13-T26: the file is being written by that lane right now, and this session cannot message a running lane. Do it at integration, with a test that a task item and an agent item render different actions so the two cannot silently converge again.
- 2026-09-08 done: an agent item keeps "Open chat"; a task gets "Open its session", its own icon and a title naming the destination, because a command has no conversation of its own — only the session whose agent ran it. The comment on `FleetItem.sessionPath` now says which kind means what, so the next reader does not have to infer it.
- 2026-09-08 the control is drawn only when its destination is reachable: a session deleted underneath a still-listed run would leave a button that navigates nowhere, which is the defect this column inherited from the panels (M13-T25). An empty catalog is not evidence of absence, so the check only hides the control once there is a catalog to be missing from. Stop is unaffected — it does not need the session.
- 2026-09-08 evidence: two new cases in `packages/ui/test/fleet/panel.test.tsx` — the two kinds render different actions and cannot silently converge again, and a task whose session is gone offers Stop but no way in. Nine tests green.

#### M13-T31 notes
- 2026-09-08 the user, with a reference screenshot, asked for this last — after everything else is done. Green in this app means *running*, so green on finished work reads as "look at me" for something that needs no looking at. A finished thing is history: dimmed, counted, and openable if the person wants it.
- 2026-09-08 the root is one mapping. `RUN_STATUS_TONE` (`packages/ui/src/agents/model.ts:97`) puts `completed: "ok"`, and its own header says it is the single mapping so a run's dot, pill and sentence agree wherever they are drawn. Changing `completed` to a muted tone fixes the sidebar, the fleet and the live map at once; `running` stays `live`, `failed` stays `danger`, `blocked` stays `attention`. Check every reader of that mapping before assuming one edit is enough.
- 2026-09-08 the finished fold: no check icon at all — the chevron, a dimmed count, and a Clear. `FinishedFold` (`thread-list.aui.tsx:866`) already renders `text-ink-3`, so the icon is the part to drop, not the colour. In the fleet, Clear dismisses finished work items. In the sessions sidebar, sub-sessions are real sessions, so there is nothing safe to "clear" — the ask there is only that a finished sub-session reads dimmed rather than green. Do not invent a destructive control to make the two surfaces match.
- 2026-09-09 done, and it was in four places rather than the two the request named. `RUN_STATUS_TONE.completed` and the fleet's own state mapping both said `ok`, which is why a finished child was green in the sidebar, in the fleet and on the live map; `agentEventTone("agent.completed")` said `ok` too, which is why the transcript's own agent-event card had a green dot. All four are muted now, and a test asserts that **no** run status and no agent event reaches for `ok` at all, so it cannot come back one component at a time.
- 2026-09-09 the tick is gone from both finished folds — the sidebar's `CheckCheck` and the fleet's green `CheckCheck` — leaving a chevron, a dimmed word and a count. The fleet's fold gained **Clear**. Nothing is deleted by it: runs and tasks are the host's records and their sessions stay in the sidebar, so it writes a per-viewer "I have read these" mark and hides only branches that were already finished when it was pressed.
- 2026-09-09 a bug in the first cut of that filter, caught in the browser rather than by a test: an item with no `endedAt` was hidden for ever once anything had been cleared. Not knowing when something ended is not a reason to put it away, so the rule now keeps a branch when anything in it is live, when anything in it ended after the mark, or when its end is simply unknown.
- 2026-09-09 the map's legend lost its `Done` row, which had become unreachable, and its muted row reads "Done or ended" — one colour, and each node still says which it was in its own word. A dead `tone === "ok"` style on the map's dot went with it, along with an unreachable "timed out" sentence left over from D-144.
- 2026-09-09 verified in the browser on the built app, both themes, 1440x900 and 390x844: every finished indicator is `--ink-3`, the only greens left are the Beam spark, the Send button, the fleet's "going" icon, a running task's dot and three unrelated telemetry marks; no horizontal scroll at phone width.

#### M13-T32 notes
- 2026-09-08 the user: opening the app shows two loading screens one after another — a loader, then the mark with the beams. They want one, and it is the beam screen that stays. They then narrowed it: the beam screen's colours are already right and are not to be redesigned; the whole task is one screen instead of two.
- 2026-09-08 located both. The first is the Electron "starting" screen (`packages/desktop/src/error-page.ts`, shown from `main.ts:347`): a card with a sliding progress bar, served as a `data:` URL, painted in **hand-written hex that is the pre-theme-system palette** — `#F5F7FA`/`#0B0F14` grounds and a blue `#1F6FEB` accent, against a product whose default preset is a black ground and a green `--live`. So the colour complaint was about this screen, not the one they thought they were describing, and removing it settles it. The second is `StartupRestorationScreen` (`loading-state.tsx`), already `bg-bg` and `var(--live)` — the keeper.
- 2026-09-08 the constraint that makes this real work: the first screen paints before there is an app — no bundle, no React, no theme CSS — and a `data:` URL has an opaque origin, so it cannot read the stored theme the way `index.html`'s boot script does. Two routes given to the lane: render the same mark and beams as standalone HTML generated from one source (never hand-copied), or let the desktop load the UI locally and wait for the host over the socket, so the React screen is the only screen there ever is. The handover must be invisible and a fast start must not gain a splash it does not show today.
- 2026-09-08 route (b) — letting the app be the only screen — was investigated and refused with reasons, not waved off: loading the renderer locally changes its origin, and every person's theme, preferences and drafts live in `localStorage` under the host origin, so it silently loses all of them including the theme this task reads; the client derives its socket, fonts, icons and manifest from `location.origin`; a service worker cannot register on a custom scheme; the host's allowed-origin gate and the desktop's navigation gates are written around exactly one origin; and `@lasercode/desktop` does not depend on `@lasercode/ui`, so reaching `ui/dist` means guessing a path inside `app.asar.unpacked` — the class of assumption AGENTS.md §5a says has broken two releases. That is a milestone across four packages, not a lane.
- 2026-09-08 done by route (a), and it closed a third gap nobody had named: the app's own first frame was bare ground until the bundle booted, so `index.html` now paints the same scene too. One composition lives in `@lasercode/protocol/startup-screen` (a subpath, never the index, so host, relay and worker never load it); React maps the tree to elements, the desktop serialises it to HTML, the Vite plugin serialises it into `#root`, and `globals.css` carries a copy pinned by a test that prints the text to paste when it drifts — the same device the theme block already uses.
- 2026-09-08 the colours come from the app, never a literal: the renderer hands the shell the declarations the screen reads whenever it applies a theme, main validates and records them, and nothing recorded falls back to the compiled default presets switched by `prefers-color-scheme`. The window frame stopped being `#0B0F14`/`#F5F7FA` — a different product's palette — and reads the same record. A fast start still shows nothing extra.
- 2026-09-08 what could not be proven: the window handover itself, for want of a display (`xvfb` is not on this machine), and a packaged build. Both documents were rendered in a real offscreen Electron renderer and compared instead — mark position, size, wordmark, label baseline and signal track match, the light half and the reduced-motion still both render, and with JavaScript disabled the app's first frame **is** the opening screen.
- 2026-09-08 remainder, deliberately left: the shell's page cannot fetch the product typeface (opaque origin, and the font ships in a package the desktop cannot resolve), so its two lines render in the declared stack with the face unresolved — the state the app's own first frame is in for a moment regardless. And the "cannot start" screen still carries the pre-theme palette; the user waved colour work off, so it stands, recorded here rather than fixed.

#### M13-T33 notes
- 2026-09-08 the user: an agent should be refused when it edits a file that has changed since it last read it. Narrowed twice in the same breath — the guard applies to `edit` only, not `write` (a write replaces a file whole and makes no claim about what was there), and it must not hold the file's contents in memory.
- 2026-09-08 checked the pinned engine before writing the brief: `read`, `write` and `edit` have no freshness guard of any kind (no `mtime`, no "modified since", nothing). The `tool_call` hook fires before a tool executes and can block with a reason (`ToolCallEventResult { block, reason }`), and `tool_result` reports what actually happened — so the whole mechanism is two hooks and a per-session map, with no need to override the engine's tools and inherit their maintenance on every bump.
- 2026-09-08 the details that decide whether this is right: an agent's own `write` must re-record or it blocks its own next `edit`; no record means no claim, so a never-read file is never refused; a stat failure lets the tool through rather than inventing an error; records are per session, so a child agent in its own worktree keeps its own; the store is bounded, and an evicted record means the guard falls silent for that file rather than blocking wrongly. A `bash` command that rewrites a file needs no special case — it moves the mtime, so the ordinary rule catches it.
- 2026-09-08 deliberately out of scope: requiring a read before editing a never-read file. Stricter than what was asked for.
- 2026-09-08 the user, on the message itself: it must state the refusal and its reason, name the file, and then instruct the agent to read it again and edit what is there now — an instruction to act on, not a complaint, and with no mention of the mechanism. It is the whole interface of this feature; an agent reads it and nothing else. Verify the final wording at integration.
- 2026-09-08 done as `packages/pi-extension/src/modules/file-freshness.ts`: two engine hooks, no tool override, so an engine bump carries no maintenance here. `tool_call` blocks an `edit`; `tool_result` records after a successful `read`, `write` or `edit`. A record is `{ mtimeMs, size }` and nothing else, in a per-session map capped at 2048 with the oldest evicted — an evicted record means no claim, so the edit goes through, which is the correct direction to fail in. Both hooks are wrapped, because the engine does not catch a handler's throw and a guard that takes the turn down would be worse than the problem.
- 2026-09-08 paths are cwd-resolved, `~`-expanded and `realpath`-ed, matching how the engine keys its own file-mutation queue, so a symlinked directory cannot produce two independent records. mtime granularity is written down rather than papered over: sub-millisecond on ext4 and APFS, whole seconds on HFS+ and some network mounts, and two changes in one tick that also preserve the byte count slip through — accepted, because closing it means hashing, which is the memory the user ruled out.
- 2026-09-08 the message, which is the whole interface: "Refusing this edit: <path> changed on disk after you last read it, so the edit would be applied to a file you have not seen. Nothing was written. Read <path> again, then redo the change against what is actually there. Re-reading is the whole fix, whether the change came from you, a command you ran, or someone else." The engine passes the reason through verbatim as an error tool result and, without `terminate`, the turn continues — so the agent can re-read and retry in the same turn rather than losing it.
- 2026-09-08 folded in afterwards: the module joins `REQUIRED_MODULES` in the packaged clean-machine gate, so a build that drops it fails there rather than in front of a person, and `AGENTS.md` gains the rule as a regression check.
- 2026-09-08 argued, not built: requiring a read before editing a never-read file. The lane thinks it belongs eventually — the never-read case is where a blind `edit` does the most damage and the guard is silent exactly there — but it is a strictly larger rule with real friction, and it is not what was asked for.

#### M13-T34 notes
- 2026-09-08 found by the steer lane, in code it never touched: `packages/worker/test/agents/goal-tools.test.ts` fails in roughly three of seven full-suite runs and passes alone and on rerun. It reads `stub.requests[length - 1]` against the real engine, which races when a previous turn's request lands late. Adding an 18-test file changed the load profile enough to expose it; the goal lane saw the same flake earlier and read it as unrelated load. It is a test that asserts on a shared mutable array without pinning which turn it means.
- 2026-09-08 done. The cause was not the shared array as such but which request the last step meant: after `clear()` returns, the goal's own turn can still be running and the engine's automatic continuation lands another goal-bearing request, so `requests[length - 1]` was sometimes a goal turn rather than the prompt under test. It now waits for the session to go idle, then asserts on the request that actually carries the words it sent, found by content. Three isolated runs and two full worker suites green.

#### M13-T35 notes
- 2026-09-08 the user: editing a message they sent, or regenerating a reply, should change the open session by default, with a fork as an explicit second option. Today both actions fork, which is the only thing offered.
- 2026-09-08 they believed the engine does not support it. It does, and checking that turned a feature into a rewiring. A Pi session file is an append-only **tree** with a leaf pointer: `SessionManager.branch(id)` moves the leaf so the next append becomes a child of that entry, `resetLeaf()` exists in its own words "when navigating to re-edit the first user message", and nothing is ever modified or deleted. `AgentSession.navigateTree` is the public door — its own comment says "Unlike fork() which creates a new session file, this stays in the same file" — and it returns the message's text so the composer does not have to re-derive it.
- 2026-09-08 and Laser already carries all of it: `pi/session/navigate`, `StableSdkDriver.navigateTree`, the worker case, an `actions.jump` that navigates and re-hydrates, and the `MessageBranches` picker already mounted in the transcript. The only defect is which call the buttons make — edit and regenerate both call `actions.fork`.
- 2026-09-08 the two things that decide whether this lands well: an edit branches from the edited entry's **parent**, not the entry, so `parentId` has to be read off the persisted entries rather than inferred from render order; and the previous version must stay reachable through the branch picker after every operation, because an edit that silently hides the old answer would be worse than the fork it replaces.
- 2026-09-08 done. Editing a message you sent and running a reply again both change the open session; a fork is the second choice on both, named as a new session. The first message works through the engine's `resetLeaf` path. Verified in the browser at both widths and themes: a middle message replaced in place with the picker reading 2/2 and the old branch — including its later messages — still whole and reachable; the first message likewise, with the entire old conversation living under version 1; Try again reaching 3/3 and 4/4; and a reload mid-tree not doubling the transcript, so M13-T27 holds.
- 2026-09-08 two bugs came out of the failures rather than the feature. The fixture was short a host client, so the assistant footer's thinking-level control asked an undefined client for the model catalogue and every render aggregated into a React error — fixed in the fixture, not the component, because the real provider always supplies a client and making the hook tolerate its absence would hide a broken provider. The second was real product code: `aui.composer` inside a message resolves to *that message's* edit composer, which throws whenever nothing is being edited, so clearing the composer after a send never worked in the app either. It now uses the thread's composer, runs only on the fork path (the in-place move never hands text back), and clears only when the box still holds exactly what was just sent, so it cannot eat a draft.
- 2026-09-08 and a pre-existing crash on the fork path, proven not to be this change by rebuilding with the new code disabled: `LaserProvider.fork` dispatched `forked` and only then awaited the entries, so for one frame the fork was the open session with an empty transcript and the thread runtime rebuilt mid-render (React #520). Entries are read first now, then both dispatched. The empty frame is not observable under `act` batching, so the test asserts the ordering — entries read before the fork's first prompt — and the crash-gone evidence is the browser run.
- 2026-09-08 decisions inside the task: editing while a reply streams is refused with a reason rather than silently stopping the turn, and `summarize` on navigate stays off — it costs a model call to describe a branch that is one click away intact.

#### M13-T36 notes
- 2026-09-08 the user asked for research into how Claude Code implements this, and the answer changed the design. Its reference documents a **content-based** rule, not a clock-based one: a file that changed after the last read can still be edited when `old_string` matches the current content exactly and unambiguously — "matching against the file's current content keeps this safe" — and the result *notes* that the file carries other changes. Only a stale or ambiguous match sends the agent back to re-read.
- 2026-09-08 and the clock-based approach we had just shipped is the one with a public failure record: anthropics/claude-code #3513, #7443, #10437, #11463 and #48390 all report `File has been modified since read, either by the user or by a linter` firing on files nobody else touched, because the agent's own previous edit advanced the mtime past the cache. We guard that case deliberately; the volume of reports says the mechanism is fragile even when you try.
- 2026-09-08 the insight that makes the rework small: Pi's `edit` already does the exact-string match against the current file and already fails when it does not match. So the match is already the safety, and this module should stop blocking altogether — it becomes an explainer. A failed edit on a file that moved gets told why and what to do; a successful edit on a file that moved gets a note that it carries changes the agent has not seen; everything else is silent. Records stay, but they now decide only whether to say something, never whether to stop something, so a wrong record can no longer cost a turn.
- 2026-09-08 the user also decided, explicitly, **not** to add a read-before-edit requirement, having seen that Claude Code enforces it for older models and relaxes it for newer ones.
- 2026-09-08 done. The module keeps no `tool_call` handler at all, so it is structurally incapable of refusing a call — a test asserts that, rather than trusting the absence. `tool_execution_start` is where "did this file change *before* the edit?" can still be asked, because by the time `tool_result` fires a successful edit has moved the mtime itself.
- 2026-09-08 the two messages, pinned verbatim in tests. Failed match: "<path> changed on disk after you last read it, so the text you asked to replace is no longer what the file holds. Read <path> again, then redo this edit against what is there now." Applied: "This edit matched the file's current text and was applied. <path> changed on disk after you last read it, so it carries changes you have not seen. Read <path> again before any further edit that depends on the surrounding lines." Both are appended to the engine's own result, never replacing it.
- 2026-09-08 the ambiguity question, answered against the real engine rather than the comment: Pi refuses it. `applyEditsToNormalizedContent` counts occurrences after finding a match and throws above one, and there is no `replace_all` parameter in Pi's `edit` at all — `oldText` is documented as having to be unique. Executed: two occurrences leave the file byte-identical. So there is no hole to close.
- 2026-09-08 two things found that nobody asked about and that a future reader would trip on. Occurrences are counted in **fuzzy-normalised** space (NFKC, per-line trailing whitespace stripped, smart quotes and dashes folded), so a text occurring once literally can still be refused as two — stricter than exact matching, therefore safe. And the match itself is fuzzy, not strictly exact: an `oldText` with ASCII quotes matches a file with smart quotes. The freshness proof is "unique modulo Unicode normalisation and trailing whitespace", a shade weaker than the reference's "exactly", still entirely content-based.
- 2026-09-08 every `edit` failure mode is a distinct engine message from its own factory, flattened to a text block, so matching on text is what there is. Five freshness causes are annotated (text gone singular and indexed, ambiguous singular and indexed, already applied); five others are deliberately not (empty `oldText`, overlapping edits, unreadable path, invalid input, abort). Two tests provoke all ten through the real `createEditToolDefinition`, so an engine bump that rewords one fails a test instead of annotating everything or nothing.
- 2026-09-08 evidence: 33 tests including five consecutive real edits producing no note at all — the failure the five upstream issues describe — driven through the real engine tool. `pi-extension` 89 tests, `worker` 220 passed and 1 skipped, build and `identity:check` clean.

#### M13-T37 notes
- 2026-09-08 the user asked for a research pass over assistant-ui's tool-use elements, one after another, on the suspicion that we have hand-rolled things the catalog already provides. Read-only: the deliverable is a per-element verdict, not a refactor.
- 2026-09-08 the timing is right for a different reason than the one asked about: `docs/ux-elements.md` is the inventory `AGENTS.md` makes binding, and it has drifted badly this session — the panel system was deleted (D-147), the fleet became a column, dialogs moved inline, `agent-plan` and `flow-graph` were removed, and several rows now point at elements with no mount. So the sweep doubles as a correctness check on the document a reviewer is meant to send work back against.
- 2026-09-08 the lane must not edit `docs/ux-elements.md` — M13-T35 owns it — and must read our element files' header comments before calling anything a duplicate, since several document deliberate divergences from the registry copy. "Ours diverged on purpose, keep it" is a correct verdict.
- 2026-09-09 the user asked for it fixed regardless of it not being ours, so it is a pinned pnpm patch (`patchedDependencies`, beside the two the repo already carries) rather than a wait on upstream. `_setRunning` still assigns the flag synchronously, so `__internal_isThreadRunning` reads back immediately; only the subscriber notification moves to a microtask, and repeated flips inside one task collapse into a single notification because subscribers read current state.
- 2026-09-09 the identity guard caught the patch on the first attempt — the comment inside it spelled the product's name, and `patches/**` is scanned like any other source. Exactly the CI-only failure AGENTS.md §5a describes, caught locally because the check runs in `protocol`'s build. Reworded and reinstalled.
- 2026-09-09 evidence: the error is gone from a plain chat's first prompt and from the agents scene's first delegation, both on clean state directories and a clean origin. The behaviour the patch touches was exercised deliberately on a 30 s turn: the Stop control appears while running, Enter puts a message in the tray as "Waits · After this turn", Steer delivers it, and no stop notice is written to the transcript. Full gate green — build, 1,510 tests, identity.
- 2026-09-09 still worth filing upstream; `docs/upstream.md` carries the diagnosis and the proposed fix. Until then the patch is the dependency, and a version bump of `@assistant-ui/core` must re-apply or retire it.
- 2026-09-09 re-claimed to finish: the audit document per tool-use element, and `docs/ux-elements.md` corrected to what is mounted today (M13-T35, which owned it, is done).
- 2026-09-09 done: fifteen rows audited. Ten are ours by design, each citing the header that says why; four do not apply (no `pi/project/apply`, no `pi/mcp/*`, no computer use, no code runner); none should go back to the registry copy, because every installed copy is restyled to tokens. One hand-rolled duplicate: the fleet's command output body draws a terminal ground, ANSI text and its own scroller for a thing that is a command with an exit code — `terminal-block` with `follow` and `truncatedHead` props is the replacement (M13-T60). The inventory's 26 corrections: six rows claimed a mount that no longer exists (agent status, todo list, `reasoning.aui`, `reasoning-panel`, onboarding, the handoff strip), six named the wrong file, three described removed surfaces (server panel, the flow canvas, the island loader), and the rest now say where things really are (the steer tray, the inline dialog cards, the fleet sheet). The unmounted files are deletion candidates by the inventory's own standard (M13-T61).

#### M13-T62 notes
- 2026-09-09 done: `inspect_fleet` is a harness tool; the worker keeps a `TaskIndex` fed from the task updates it already forwards, and `buildFleetTree` joins runs and commands into the column's tree — a child never sees a sibling; the root sees everything under it; child agents first, then that session's commands; at most 50 rows, cut deepest-first and counted in `omitted`. Each row carries the UI's `FleetState` and the column's label word verbatim (`FLEET_STATE_LABEL`), elapsed, and the one-line ending; a command's "you stopped it" becomes "the person stopped it". The agreement is pinned by feeding one fixture to both the worker's builder and the UI's `buildFleet`/`scopeFleet`. `inspect_agent` and `task_output` now accept any row in the caller's subtree (a grandchild's output is read through the worker's log tail) and refuse a row outside it; the acting verbs (`send_agent_message`, `stop_agent`, `remove_agent_worktree`, `task_stop`) stay direct-child or own-session. `list_agents` and `task_list` are gone from every string the model reads. The result ends with guidance: endings are sent as messages, so the tool is never for waiting.
- 2026-09-09 sandbox: `delegate` → `background` → `fleet` showed the tool result beside the column with the same names and words. The sandbox's two seeded demo tasks are host-registered fakes that never pass a worker, so they are in the column and not in the tool; real commands are in both.

#### M13-T60 notes
- 2026-09-09 claimed: give terminal-block `follow` and `truncatedHead`, mount it in the fleet's task detail, drop the hand-drawn terminal.
- 2026-09-09 done: `terminal-block` gained three opt-ins, all off by default so the transcript's `bash` body is unchanged — `follow` keeps a live command's end in view without yanking back a reader who scrolled up and never moves a finished one; `truncatedHead` is the one-line "Showing the end of the output." for the tail the host serves from byte N, in place of the block's own elision; `ansi` decodes colour through the shared decoder (a third prop the audit did not list, without which dev-server colour would have regressed in the fleet). The fleet's task detail draws through it and its Command and Exit-code fields went, since the block's header says both; the fleet's own empty-output sentences went with them, the block having its own. Left for the fleet's owner: the Ended field still says "exit code 1" above a header saying `exit 1` when the reason is the exit.

#### M13-T61 notes
- 2026-09-09 claimed: prove each of the seven files unmounted, delete them with their tests and barrels, mark the inventory rows.
- 2026-09-09 done: each of the seven proved unmounted by a grep of the module path and every exported symbol across the UI's source and tests, the desktop package, the barrels, the CSS slot selectors and the two directory-enumerating tests — a comment or the inventory was the only mention in every case. Deleted: `agent-status`, `todo-list`, `reasoning.aui`, `reasoning-panel`, `onboarding`, `preview/DiffPreview` (and its barrel line; the barrel itself has no importer); the `AgentHandoff` strip export removed from `agent-handoff.tsx` with `AgentEventCard` and its tests untouched. No dead helper left behind. Seven inventory rows now say "not mounted; file removed (M13-T61)" and keep the owning surface and the registry name to re-install. T-B from the audit done on the way: `tool-timeline.tsx`'s header names the monitor's Tools section.

#### M13-T66 notes
- 2026-09-09 claimed: the user asked to merge `feat/agents` into `main` and release 0.3.0. Same procedure as M12-T78: `set-version.sh 0.3.0`, `pnpm verify` (build, typecheck, every test, the 13 publication checks) and `verify-install.sh` on the versioned tree, source pushed to main by fast-forward, a clean CI run, then the immutable tag; a draft carries the notes; publication and Latest are the pipeline's, never promoted by hand.
- 2026-09-09 checkpoint: version set across the workspace; `pnpm verify` green (protocol 36, pi-goal 8, relay 17, crypto 42, pi-extension 108, ui 924, worker 313, host 203, cli 68, desktop 101, plus the publication checks); installer 76 passed, 0 failed.
- 2026-09-09 done: `feat/agents` fast-forwarded onto `main` at `7e068e3` (37 commits); CI run 34331351877 succeeded on that commit before the immutable `v0.3.0` was pushed. A draft carrying the 0.3.0 notes was created with `--verify-tag --latest=false`; the tag triggered the x64/ARM64 asset-verified publication pipeline (run 34331715953). Nothing promoted by hand; download readiness is claimed only once the pipeline has published and the assets are checked, and until then the state is "tag pushed; release building".
- 2026-09-09 published by the pipeline (run 34331715953, success): `v0.3.0` is public and Latest, published 09:04:43Z, twelve assets — both AppImages, both tarballs, both DEBs, both RPMs, `install.sh`, `SHA256SUMS`, `SHA256SUMS.sig`, `provenance.jsonl`. Download readiness checked against the actual asset list, not the tag.

#### M13-T67 notes
- 2026-09-10 claimed: persist per-built-in instruction overrides, expose edit/restore beside the existing model choice, and prove Beam/Chat sessions plus Namer calls consume the effective prompt.
- 2026-09-10 checkpoint: `agents/builtin/set-instructions` persists an optional override for Beam, Chat and Namer; old stores follow the shipped prompt, restore writes null, and Namer layers the effective prompt above its fixed per-request output contract. New Beam and Chat sessions already consume the rebuilt definitions through the existing sync seam.
- 2026-09-10 done: protocol 30, host 204, worker 314 + 1 skipped and UI 926 tests pass; protocol/host/worker/UI typechecks and production builds pass. Save, reload persistence and restore were exercised in the sandbox; the complete Agents detail was reviewed at desktop and 390px in dark and light with no horizontal overflow. The repo-wide identity gate remains blocked only by the user's unrelated untracked `.tmp-pi-command-demo.py`, which contains a literal product name and was left untouched.

#### M13-T68 notes
- 2026-09-10 claimed: replace the top-bar and command-palette panel glyph with Telemetry's own activity mark, preserving panel-edge close controls as collapse affordances.
- 2026-09-10 done: the top bar and command palette use Telemetry's activity waveform; the panel header keeps its edge-collapse control. UI 928 tests and production build pass; desktop dark/light and a 390×844 phone viewport were reviewed with no clipping or horizontal overflow.

#### M13-T69 notes
- 2026-09-10 claimed: productize the pinned engine prompt at the display and request seams so the default agent says it operates inside Laser while retaining the engine's current tools, guidance, context and skills.
- 2026-09-10 done: the exact pinned-engine identity prefix is rewritten to Laser after prompt construction, both for the readable default and each live request; drift leaves the upstream text untouched instead of corrupting it. The real-engine provider test proves the request says Laser and not Pi. Pi-extension 108 and worker 315 + 1 skipped tests pass; both builds pass; the sandbox displayed the Laser identity.

#### M13-T70 notes
- 2026-09-10 claimed: keep the current definition in the allowed-agent choices, label it as another instance of this agent, and prove deselect/reselect plus recursive execution instead of rendering it as a missing definition.
- 2026-09-10 done: every saved custom definition remains in its own startable catalog and is labelled “Same agent”; removing and restoring the checked default was exercised by pointer in the sandbox. Existing host/worker recursion and depth-limit coverage remains green; host 206, worker 315 + 1 skipped and UI 928 tests pass.

#### M13-T71 notes
- 2026-09-10 claimed: make the name field editable for custom agents; carry the original name through validation/save; atomically move default and delegation references; retain a durable alias so sessions already attributed to the old name still resolve the renamed definition.
- 2026-09-10 done: rename is one host-store commit that moves the definition, default pointer, self/peer delegation references and warning attribution; durable flattened aliases preserve old-session lookup and remain reserved until the renamed definition is deleted. Protocol 30, host 206, worker 315 + 1 skipped and UI 928 tests pass; protocol/host/worker/UI typechecks and production builds pass. The sandbox renamed the default to `worker`, retained its default/self-child state, selected the new row, and refused built-in name `beam` inline. The repo-wide identity gate remains blocked only by the user's unrelated untracked `.tmp-pi-command-demo.py`, left untouched.

#### M13-T72 notes
- 2026-09-10 claimed: replace the branded upstream default-prompt import/transform with a Laser-owned base prompt built from the tools the session actually exposes; keep project context, working directory and user-discovered skills on the runtime's normal append path.
- 2026-09-10 done: the default prompt is authored by Laser, names Laser and the seven tools actually exposed, and contains no engine brand, documentation suggestion, package path or copied upstream prose. A real session request proves the product-owned section stays neutral before the runtime appends project context and user-authored skills. Worker 311 + 1 skipped tests and affected builds pass; the Agents page displayed the same prompt in the browser.

#### M13-T73 notes
- 2026-09-10 claimed: remove the worker-written Beam skill and every bundled-skill exception; preserve discovery of skills from user and project folders, and move Beam's essential product guidance into its built-in instructions.
- 2026-09-10 done: the generated Beam skill and its packaged-build assertions are gone; skill scope is only global or project, Beam is unscoped, and its Laser navigation guidance is now part of its editable built-in instructions. Laser discovers user folders but writes, installs and bundles no skill. Protocol 31, host 206, worker 311 + 1 skipped and UI 928 tests pass; protocol/host/worker/UI typechecks and production builds pass.

#### M13-T74 notes
- 2026-09-10 claimed: make the spark a fresh-chat launcher rather than a remembered-session toggle; clear the bubble's current path on every press while leaving the previous session in the catalog and sidebar.
- 2026-09-10 done: every spark press clears the bubble's active path and keeps it open; the next message lazily creates a new Beam session. The previous session remains in Beam's sidebar group and is neither stopped nor deleted. UI 928 tests pass, including repeated presses while open and after close/reopen; pointer behavior and layout were inspected at desktop and phone widths in dark and light themes.

#### M13-T75 notes
- 2026-09-10 claimed: stage only the tracked agent/Beam refinements, bump every workspace manifest to 0.3.1, run the release and identity gates against that exact index, push source, wait for clean CI, then tag and monitor the release workflow through verified publication.
- 2026-09-10 checkpoint: the complete staged gate passed at 0.3.1 — product identity, workspace build/typecheck/tests, the real desktop bridge under Xvfb, 13 publication regressions, and 76 install/upgrade/uninstall checks. The two unrelated local `.tmp-pi-command-demo.*` files were excluded during identity inspection and restored afterward; no untracked user files are staged.
- 2026-09-10 done: pushed source commit `d382807`, waited for clean CI run `34435355237`, then pushed annotated tag `v0.3.1`. Release workflow `34435577548` built and uploaded x64/ARM64 packages, installed the staged artifacts, attested the build, verified remote sizes and SHA-256 digests, published the stable [release](https://github.com/youssefsiam38/laser/releases/tag/v0.3.1), and deployed the signed APT/DNF repositories. Independent inspection found 12 uploaded assets: AppImage, DEB, RPM and tarball for both architectures, `install.sh`, `SHA256SUMS`, its signature, and offline provenance; the release is public, not a prerelease, and GitHub reports it as Latest.

#### M13-T76 notes
- 2026-09-10 claimed: inventory the runtime-built prompt inputs, choose a safe standard template renderer, and build a caret-aware field picker into every agent instruction editor.
- 2026-09-10 done: Handlebars renders a restricted, validated field catalogue for custom, Default, Beam, Chat and Namer instructions. The searchable picker exposes only human labels and descriptions, inserts at the caret, restores editor focus, and browser review confirmed live insertion with no syntax error.

#### M13-T77 notes
- 2026-09-10 claimed: trace nomination, trial prompts and validation end to end, then replace all-or-nothing qualification with deterministic eligible candidates, tolerant validation and measured fallback.
- 2026-09-10 done: Namer tests every connected candidate against both real naming jobs in parallel, normalizes harmless wrappers and truncation, ranks valid results by fidelity then speed and price, preserves a previous valid choice on a failed recheck, and retries qualification after a transient all-failed run. Browser qualification selected a valid nano model and showed each measured result.

#### M13-T78 notes
- 2026-09-10 claimed: make the bubble's full-view transition select Code at the same time it opens or creates the Beam session.
- 2026-09-10 done: both empty and existing Beam maximize paths select Code before opening the main conversation; interaction tests and browser review confirm the selected tab and restored Beam row.

#### M13-T79 notes
- 2026-09-10 claimed: replace Beam and Chat's shared working directories with one durable opaque workspace per session and keep Chat's move-to-project working from those paths.
- 2026-09-10 done: every Beam and Chat creation allocates a persistent private directory beneath its workspace container. Descendants are excluded from projects and normalized to friendly Beam/Chat grouping even before agent metadata arrives; the transcript says only “Private workspace”, and Chat exposes a direct Move to a project action. Browser review confirmed distinct friendly surfaces at desktop and phone widths.

#### M13-T80 notes
- 2026-09-10 claimed: connect the Chat/Code tab control to the existing per-directory session memory so each tab restores its own most recently viewed conversation.
- 2026-09-10 done: each tab remembers its last surviving path, falls back to the newest session of that kind, and clears to an honest empty state when none exists. Pointer switching in the browser restored Chat and Beam independently; keyboard behavior shares the tested tab handler.

#### M13-T81 notes
- 2026-09-10 claimed: keep retryable provider attempts out of the transcript, preserve the run as working through backoff, and show one gentle actionable warning only when recovery is exhausted or impossible.
- 2026-09-10 done: retryable `agent_end` events keep the run working, `auto_retry_start` removes the failed attempt without adding a notice, and history projection hides every superseded provider failure. A recovered turn has no visible error; an exhausted turn keeps only its last failure as one attention-toned actionable warning. The engine's existing bounded exponential backoff remains unchanged.
- 2026-09-10 verification: staged `pnpm verify` passed build, typecheck, 1,840 package tests (one intentional worker skip) and all 13 release-publication regressions. Desktop and 390×844 browser review passed in dark and light themes.

#### M13-T82 notes
- 2026-09-10 claimed: release the completed instruction-template, Namer, private-workspace, session-navigation and quiet-retry refinements as the next patch, with no tag until clean source CI and no publication until every architecture and remote asset verifies.
- 2026-09-10 checkpoint: the exact 0.3.2 tree passed `pnpm verify` locally; one pre-existing randomized harness assertion transiently failed on the first run, then its full worker suite and the complete gate both passed cleanly. The gate covered product identity, every workspace build and typecheck, 1,840 active tests, one intentional skip, and 13 publication regressions. Unrelated untracked files remained outside the commit.
- 2026-09-10 done: pushed feature commit `d798b9d` and release commit `f2cf2b6`, waited for clean source CI run `34444740409`, then pushed annotated tag `v0.3.2`. Release workflow `34444969521` built x64/ARM64 packages, installed the staged release, signed checksums and native repositories, attached offline provenance, verified remote sizes and SHA-256 digests, published the stable [release](https://github.com/youssefsiam38/laser/releases/tag/v0.3.2), and deployed the APT/DNF repositories. Independent remote inspection found 12 uploaded non-empty assets: AppImage, DEB, RPM and tarball for both architectures, `install.sh`, `SHA256SUMS`, its signature, and provenance.

#### M13-T85 notes
- 2026-09-10 claimed: the person requested commit, push and release. Publish M13-T83/T84 as patch 0.3.3 after an isolated exact-source/version gate, then clean source CI, then the existing two-architecture release workflow. Preserve all unrelated untracked scratch/study files, including the identity-check offender. No personal credentials, app-state changes, installed-app restart or local installation.
- 2026-09-10 checkpoint: implementation committed as `ff880cd`, exact 0.3.3 version tree as `5e7e267`. `/tmp/laser-release-0.3.3` is a detached, clean worktree; offline frozen-lockfile dependencies came entirely from cache. Identity check, complete `pnpm verify` (1,873 workspace tests passed, one intentional skip; 13 publication regressions), installer fixture gate and diff check passed. Unrelated scratch/study files remain unchanged in the original checkout. Pushing the verified source, then waiting for its CI before tagging.
- 2026-09-10 checkpoint: source CI [34459385794](https://github.com/youssefsiam38/laser/actions/runs/34459385794) passed for `5e7e267`; only then created and pushed annotated `v0.3.3` at that exact commit. Architecture builds and publisher verification are pending. A tag is not yet a downloadable release.
- 2026-09-10 done: [release run 34459703018](https://github.com/youssefsiam38/laser/actions/runs/34459703018) passed native x64 and ARM64 builds/clean-machine gates, real-artifact installer verification, signed repository generation, provenance, verified publication and Pages deployment. [v0.3.3](https://github.com/youssefsiam38/laser/releases/tag/v0.3.3) became public Latest at 09:26:08Z. Its 12 uploaded nonempty assets include both architectures' four formats, installer, checksum manifest/signature and offline provenance. Independent audit matched every manifest digest to GitHub metadata, verified the downloaded manifest's offline provenance against the workflow/tag/exact source commit, and checked live signed APT/DNF metadata for both architectures against release package versions, sizes and digests. Supplemental audit assumptions about artifact and RPM name casing were corrected in `/tmp` only; no release source/assets were changed. Evidence: `/tmp/laser-release-033-{verify,installer,ci,publish,audit}.log`, `/tmp/laser-release-033-assets`, and the workflow links. Release notes describe the changes and synthetic-audio verification limit. Installed app, personal state, conversations, credentials and unrelated scratch/study work remain untouched.

#### M13-T88 notes
- 2026-09-10 done: source CI 34471150534 and release 34471617236 passed. `v0.3.4` at `62839fe` is public, stable and Latest: https://github.com/youssefsiam38/laser/releases/tag/v0.3.4. Both architecture builds and the verified publisher completed; all 12 assets are uploaded, nonempty and carry SHA-256 digests: eight Linux packages, installer, checksum manifest/signature and offline provenance. Native-feed publication ran in the successful release workflow. Installed app and unrelated working files remain untouched. H-4 is resolved.
- 2026-09-10 checkpoint: immutable `v0.3.4` pushed at `62839fe`; draft notes created. Release workflow 34471617236 is building x64/ARM64 and owns publication after asset verification. Monitor `t-8dccdb96` observes only; cancelling that local monitor cannot stop the GitHub release now underway.
- 2026-09-10 resumed: the person approved continuing H-4. Source CI 34471150534 passed for exact commit `62839fe3ab65c1e460f89a23507bd7b85927265b`; push its immutable `v0.3.4` tag and draft notes, then use the existing verified publisher.
- 2026-09-10 checkpoint: source CI 34470754954 caught an unrelated worker-pool test waiting for process readiness rather than completed session recovery. Changed its wait predicate to confirmed open-session state, leaving production recovery unchanged. No tag was pushed on the failed run.
- 2026-09-10 checkpoint: source commits `b11fd3d`, `15276ee` and same-millisecond regression fix `0c91969` pushed to main. Exact versioned isolated identity/build/typecheck/test gate passed (1,886 workspace tests; one intentional skip; 13 publication regressions), plus 76 installer checks. Source CI 34470754954 is the prerequisite to tagging; an automated release command waits for its success, pushes `v0.3.4`, creates only a draft with release notes, and observes the existing two-architecture publisher. Logs: `/tmp/laser-034-{verify,installer,ci,release}.log`.
- 2026-09-10 checkpoint: versioned gate exposed a pre-existing same-millisecond run-selection failure in `test/agents/harness.test.ts:807`. Fix the comparator in worker and UI together: a live follow-up outranks its terminal predecessor when start times tie; retain update-time and ID tie-breaks. Add deterministic regression coverage before retrying the release gate.
- 2026-09-10 claimed: commit and push the verified M13-T86/T87 fixes, prepare 0.3.4, and let the existing release pipeline build and publish after clean source CI. Work directly without subagents; leave unrelated files and the installed app untouched.

#### M13-T89 notes
- 2026-09-11 combined-candidate browser gate on `c344aba` (session scratchpad `report-browser.md`, evidence under `browser/`): Chrome 153 CDP against sandboxes on 41630–41633 with temporary state, both widths and themes. First-turn refusal repro exits 0 (draft retained, zero messages; attempts 1–2 hit the pre-existing M13-T99 typing-burst crash, then 20/20 in loops); A→B→A away/back passes at 1360 with the mouse and 390 through the sessions drawer by touch; a normal first turn keeps session counts unchanged, drops the picker, shows the agent in the header and survives reload. Partial: thinking level on the stub model (picker only in the validator sandbox with `reasoning: true`).
- 2026-09-11 checkpoint: first-turn lane commit `c42524a` merged into `stabilize/hlc010`. U1: `createThreadAdapter.send` captures the sending thread's composer at send time, and when nothing reached the worker restores text and completed attachments into it only if it is still empty, then rethrows `MessageNotSentError` (assistant-ui's own contract, which only `onNew` honours; queue lanes are fire-and-forget) so every lane behaves alike and the toast says what to do next; the tentative choice needs no restoring because a send never clears `runConfig`. U2: `useDiscardFirstTurnOnLeave(runtime.thread.composer, isMain)` in the per-thread runtime hook drops only `runConfig.custom.firstTurn` of the composer that was left (assistant-ui keeps every loaded thread's runtime alive across a switch, which is why A→B→A retained it). 25 new real-runtime tests (`test/runtime/adapter-not-sent.test.tsx`, `test/runtime/first-turn.test.tsx`, `test/thread/first-turn-refusal.test.tsx`), UI 1029 pass, typecheck and identity clean. Browser on a 41610 sandbox with Chrome 153 CDP: `/tmp/laser-ui-acceptance-repro-first-turn-refusal.mjs` exit 0 on the first attempt (draft retained, 0 messages); A→B→A away/back passes (picker back to Default, draft preserved); 1360/390 × light/dark screenshots without clipping. Evidence under the session scratchpad (`first-turn-*.json/png`, `first-turn-away-back.mjs`, `first-turn-refusal-shots.mjs`). Not provable: the sandbox stub model has no reasoning so the thinking level is browser-noted only (vitest covers it). Combined-candidate reruns still required.
- 2026-09-11 claimed by claude-2026-09-11-stabilize: U1 (recoverable first-send refusal must restore text/attachments/tentative choice into the originating composer across queue.enqueue/steer/onNew) and U2 (leaving a pristine session discards only `runConfig.custom.firstTurn`, composer-local, never another composer) implemented together in the first-turn lane with real external-store runtime tests and CDP browser proof (`/tmp/laser-ui-acceptance-repro-first-turn-refusal.mjs` must exit 0, plus an away/back script).
- 2026-09-10 second browser blocker at frozen `91a7759`: true single-page A→B→A retains tentative reviewer/high while canonical state/header says Default/medium (`/tmp/laser-ui-acceptance-away-back.json`, `...-away-back-back.png`). Orchestrator inspected SessionPreparationProvider: it only clears firstTurn when canonical history starts, not when leaving. Queue both findings to the same owner after backend handoff: refusal retains originating draft/choice while staying; navigation discards only tentative choice, never text/attachments or unrelated runConfig, and cannot clear the newly selected/other composer. Required interleaving tests include refusal while navigating and Main/Beam isolation. Runnable refusal regression and combined-candidate procedure retained at `/tmp/laser-ui-acceptance-repro-first-turn-refusal.mjs` and `/tmp/laser-ui-acceptance-final-candidate-reruns.md`.
- 2026-09-10 independent browser review rejects preserved `91a7759`: deleting the selected temporary custom agent before sending caused a recoverable first-turn refusal, zero committed messages, and an empty composer instead of the unsent draft. Evidence `/tmp/laser-ui-acceptance-report.md` and `...-browser-a.json`; UI/protocol types/build and 11 focused files/163 tests passed but missed this real-runtime data loss. Orchestrator confirms production queue enqueue/steer fire-and-forget paths as well as onNew need the supported failure/retry contract. Same lifecycle owner has queued the UI correction AFTER freezing active backend corrections; no UI writes authorized yet. Acceptance: exact text/attachments and tentative choice remain recoverable in the originating composer, correct-and-retry sends once, no newer-draft/other-composer overwrite or accepted-send restoration; real external-runtime/host and browser proof required.
- 2026-09-10 end-session checkpoint: coupled development commit `aba12f7b1912144d1d041f057aa643acf143aecd` is clean and frozen in `harness-lifecycle-1df0cfd1`; it includes all approved dependencies plus unreviewed backend work. FB01’s cross-composer global map was resolved in `c6a29fbdfc2a452a8c73e55d0354610dfbf50f63`; UI/protocol checkpoint `7959876094ecbbddad552f1a58a96ffd2b4f1480` is approved with 71 tests and UI/protocol typechecks. The coupled batch remains unmerged and combined approval is withheld by HLC010.
- 2026-09-10 ownership transfer: first-prompt-binding froze source commit `a0264674753cfa1999d00f89294492da5fd62e3e` on `e1c24c7` and explicitly relinquished all lifecycle/server source and test writing. Its only remaining unstaged files are the four frozen planning/docs files with unchanged hashes; it has no continuing source or bookkeeping ownership. The checkpoint is unapproved. Evidence reported: worker 354 plus one skip, UI 978 before the last change, focused UI 49, protocol 41, router 24, types and identity passed. UI build is blocked locally by a missing oxide native binding, full host dependencies are unbuilt, and there is no real-browser proof.
- 2026-09-10 continuing claim by harness-lifecycle: preserve `a0264674` intact while integrating it into the coupled lifecycle batch; do not assume completion from isolated unit evidence. Repair the reproducible local install, then prove real caller and browser behavior.
- 2026-09-10 stabilization: main `e1c24c7ae9c98da5630b2518fb6a802fcb579c0f` includes pending acknowledgement `67bf567`; pending-delivery released shared driver/server files and first-prompt-binding now owns them exclusively until an explicit safe checkpoint. Its source work continues with three new files; it froze the four planning/docs files at 13:13:04Z and will not write or source-commit them.
- 2026-09-10 checkpoint: protocol/host/UI first-turn contract is implemented and focused tests pass. Agent/thinking choices now stay in composer scope, preserve drafts/attachments and create no session; every assistant-ui send path captures `{ agentName, thinkingLevel? }` before landing initialization and sends it on `session/prompt` for the same path. Added pristine-admission/serialization helpers and saved-empty record recovery tests; shared server/driver integration still waits for the reviewed M13-T92 and harness `promptUser` commits.
- 2026-09-10 takeover by first-prompt-binding: implement the typed `session/prompt` first-turn contract through protocol, host and UI now; isolate the worker rebind helper/tests until M13-T92 releases reserved server/driver files. Preserve the existing path/session manager, reject any non-pristine root custom session, and roll back failed runtime preparation without a second writer.
- 2026-09-10 claimed: replace agent-bound empty-session switching with one transient composer choice consumed atomically by the first prompt. Preserve text, attachments, model/thinking behavior, explicit New and eager Beam/Chat reuse; never delete sessions or persist the tentative identity.
- 2026-09-10 blocker: the first UI-only proposal deferred `newSession({ agentName })` until Send, but an already-open default empty session still remained beside the new chosen-agent session. Reverted that implementation completely. Correct contract needs the worker to bind the chosen agent to the same unstarted identity before its first prompt (atomically with first-turn preparation), or explicit ownership expansion for protocol/host/worker. No session deletion, repurposing after start or second identity is acceptable.
- 2026-09-10 architecture proposal: preferred minimal wire contract extends `session/prompt` with optional first-turn `{ agentName, thinkingLevel }` preparation rather than adding a second request/race. Under one per-session lock the worker validates `messageCount === 0`, no pending/live/history/dialog/goal state, rebinds definition, role, record, bridge, skills/model and extension options on the same identity, applies thinking, then invokes the prompt. Landing initialization receives the chosen `agentName` in `createSession` before assistant-ui adopts the path, so it never creates chosen then initializes default. An already-open empty path uses the atomic prompt preparation; any refusal keeps the draft choice for retry. All queue lanes share `createThreadAdapter.send`, so focused tests must cover them rather than only `onNew`. Worker `driver.ts`, `drivers/stable-sdk.ts` and `server.ts` are reserved by M13-T92; T89 will make no worker edit until that owner finishes and gives a serialized handoff/ownership expansion. A lazy Code New surface alone cannot safely repair an already-open 0.3.4 empty identity. No host/server files were edited.

#### M13-T90 notes
- 2026-09-11 combined-candidate browser gate on `c344aba` (session scratchpad `report-browser.md`, evidence under `browser/`): Chrome 153 CDP against sandboxes on 41630–41633 with temporary state, both widths and themes. Two composers: both send orders stay in their own transcript; dictation lands only in the Beam composer that started it, the other mic is disabled, a forced race yields one owner. Reduced motion: no running animations, Beam `animation-name: none`, no overflow. Partials unchanged: approval footer with a real extension question (no fixture in the frozen worker) and the exact mic-conflict toast. Observation for M13-T100: at 1360 the Beam bubble covers the session composer's Attach/Dictate controls.
- 2026-09-10 initial acceptance continuation finished at exact `91a7759`: real opposite Main/Beam send orders, manual-close across 1360→390→1360, Find transient reveal/Escape fold+focus+preference restoration, and reduced motion both themes/widths passed. Artifacts `/tmp/laser-ui-acceptance-{two-composers,detail-find,reduced-motion}.json`; source clean and ports 41536/9252 stopped. Partials remain explicit: frozen product excludes loose extension fixture for real approval-footer browser proof; second mic disables immediately so exact conflict toast is not deterministically reachable (single mic/transcription ownership passed). Final candidate reruns still required; no task marked done from preliminary evidence.
- 2026-09-10 browser checkpoint: `/tmp/laser-ui-acceptance-report.md` records exact `91a7759` evidence and incomplete gates, not blanket acceptance. Same read-only reviewer continues initial acceptance as `run_e2806604`: remaining single-page navigation/detail override/Find restoration/approval footer/two-composer/reduced-motion checks; final-backend reruns await frozen candidate. Draft-loss blocker belongs to T89; no source changes or personal state touched, original ports stopped.
- 2026-09-10 acceptance claim: independent read-only reviewer stabilization-ui-acceptance (`01a08d2f-269a-70c8-b0d6-ec85497c2d18`, `run_478d0b32`) validates the stable preserved frontend in its own checkout/build at `91a7759`, with fresh temporary sandbox/browser state. Both widths/themes and realistic pointer/touch/keyboard evidence; no source writes or lifecycle implementation ownership. Report `/tmp/laser-ui-acceptance-report.md`; final HLC-dependent integration scenarios must be rerun on the eventual combined candidate.
- 2026-09-10 end-session checkpoint: frozen composer `e7a5b89` is handed off and included in accepted staging `adcbd66`; only `Composer.tsx` run-config send handlers transferred to harness-lifecycle for FB01. Layout and dictation remain preserved under composer-layout ownership; no extra feature writer is active.
- 2026-09-10 stabilization checkpoint: `e7a5b8955ebc4cb459e1e08d4d1ff9423c21598c` is clean, implemented and frozen from base `16232cd`; CQL001–003 re-review is active. Its isolated full verification reported 971 UI tests passing, not yet a combined-candidate gate.
- 2026-09-10 claimed by composer-layout: align the composer controls and recording affordance without changing the shared first-turn preparation contract; return focused interaction and responsive browser evidence for integration.

#### M13-T91 notes
- 2026-09-11 combined-candidate browser gate on `c344aba` (session scratchpad `report-browser.md`, evidence under `browser/`): Chrome 153 CDP against sandboxes on 41630–41633 with temporary state, both widths and themes. Header agent label: hover/leave, real Tab + Escape, touch at 390 and 320, both themes pass.
- 2026-09-10 browser checkpoint: `/tmp/laser-ui-acceptance-report.md` records exact `91a7759` evidence and incomplete gates, not blanket acceptance. Same read-only reviewer continues initial acceptance as `run_e2806604`: remaining single-page navigation/detail override/Find restoration/approval footer/two-composer/reduced-motion checks; final-backend reruns await frozen candidate. Draft-loss blocker belongs to T89; no source changes or personal state touched, original ports stopped.
- 2026-09-10 acceptance claim: independent read-only reviewer stabilization-ui-acceptance (`01a08d2f-269a-70c8-b0d6-ec85497c2d18`, `run_478d0b32`) validates the stable preserved frontend in its own checkout/build at `91a7759`, with fresh temporary sandbox/browser state. Both widths/themes and realistic pointer/touch/keyboard evidence; no source writes or lifecycle implementation ownership. Report `/tmp/laser-ui-acceptance-report.md`; final HLC-dependent integration scenarios must be rerun on the eventual combined candidate.
- 2026-09-10 end-session checkpoint: header commit `a8715dd` is code-approved with five focused tests, types and identity. HDR002’s code race is resolved; only final browser proof remains. The post-final Escape/dark browser gate and full UI suite after the last line were not run. Prior partial browser evidence remains: 390px first-open/second-close/outside interaction and 320px light.
- 2026-09-10 review checkpoint: HDR001 and HDR003 are resolved. HDR002 remains a genuine pointer focus/click race; the owner is assigned to fix it and provide real CDP touch proof.
- 2026-09-10 review checkpoint: `f174a7485d7466a9a094078b30fae79327bfdb72` has a proper frozen-dependency handoff; HDR001–003 re-review remains active and the change is not integrated.
- 2026-09-10 stabilization checkpoint: header implementation is committed at `f174a7485d7466a9a094078b30fae79327bfdb72` from base `28dc4d3`, awaiting final handoff and HDR001–003 re-review; it is not yet integrated.
- 2026-09-10 claimed by header-agent: once the first turn starts, show the actual persisted session agent beside the model in the top bar across session switches and reloads. The label is read-only: never switch a started agent, present tentative composer state as persisted identity, or substitute today’s default when a historical session has no attribution.

#### M13-T92 notes
- 2026-09-11 combined-candidate browser gate on `c344aba` (session scratchpad `report-browser.md`, evidence under `browser/`): Chrome 153 CDP against sandboxes on 41630–41633 with temporary state, both widths and themes. Hidden pending delivery: the follow-up queued with Enter during a live turn appears once with its reply after navigating away and back, no stale Sending now/Waiting to send row, reload counts identical.
- 2026-09-10 end-session checkpoint: main `ccd48bbe77d72c307f8df91bf700ec983f6f124a` contains approved pending `e1c24c7` plus ledger-only changes. The remaining coupled implementation is frozen in unmerged `aba12f7b`; do not infer task completion from staging or focused evidence.
- 2026-09-10 ownership transfer: first-prompt-binding’s frozen `a0264674753cfa1999d00f89294492da5fd62e3e` includes pending-hydration and first-binding integration work. It relinquished all lifecycle/server source and test writing to harness-lifecycle; no other writer continues these files.
- 2026-09-10 continuing claim by harness-lifecycle: fence every prompt, steer, follow-up and pending-tray caller path across runtime preparation, preserving the accepted backend acknowledgement and proving hidden-session delivery, failure and retry truthfully.
- 2026-09-10 UI checkpoint: `openSession` captures the pending-array reference before awaiting `session/pending/list`; the reducer ignores a delayed snapshot after any newer `pending_update`, including `[]`, while unrelated view updates preserve the reference and allow hydration. Focused store/provider queue coverage passes (30 tests before combined first-turn additions; queue suite now 15).
- 2026-09-10 reassigned to first-prompt-binding after pending-delivery completed backend commit `67bf567`: guard delayed `session/pending/list` hydration by the captured pending-array reference, proving newer empty updates win while unrelated view updates preserve hydration eligibility.
- 2026-09-10 backend checkpoint: pending-delivery commit `67bf567` is integrated in main `e1c24c7ae9c98da5630b2518fb6a802fcb579c0f`; PD01–03 review is resolved. Main focused 36 tests and worker typecheck passed independently. T92 is not done until UI hydration review/integration completes.
- 2026-09-10 claimed by pending-delivery: replace stale Sending presentation with truthful queue state across delivery, failure and retry, including a queued/steered message delivered while its session is hidden and observed after returning. Ownership: `packages/worker/src/pending.ts`, reserved `packages/worker/src/server.ts`, `packages/worker/src/driver.ts`, `packages/worker/src/drivers/stable-sdk.ts`, focused preflight/pending/server tests, and UI queue component/tests only if needed; no M13-T89 runtime ownership. The pinned engine’s `PromptOptions.preflightResult: true` is the canonical per-invocation acknowledgement before the full prompt settles.

#### M13-T100 notes
- 2026-09-11 recorded from the combined-candidate browser gate (`report-browser.md`): at 1360 the Beam bubble covers the session composer's Attach/Dictate controls; a tooltip stays open after a touch in the phone sessions drawer; once, in a shared Chrome profile, a reload restored a different session than the deep-linked one (not reproducible in fresh contexts, `browser/diag-reload2.json`); the activity scene's tool title reads "smaple" in the sandbox script only. None regressed by the candidate; none in the authorized patch scope.

#### M13-T99 notes
- 2026-09-11 found by the first-turn lane's browser gate, not caused by it: about one in five to ten CDP per-character typing bursts unmounts the React root before Send with a throwing update in `useComposerDraft` (`elements/draft-restore.tsx:126-139`, `setSaved(undefined)`); reproduced on the base `aca8591` production bundle (run 3 of 24) and on a build without the lane's logic; never in React's dev build (12 runs, no `getSnapshot`/nested-update warning), so a timing race, not a logic loop. Reproduce with `N=24 node <scratchpad>/repro-loop.mjs` against a production bundle (scripts retained in the session scratchpad: `repro-loop.mjs`, `probe-timeline.mjs`). Not in the authorized stabilization scope; recorded so it is not lost.

#### M13-T98 notes
- 2026-09-11 re-review of the fix diff on `46e6e19` (session scratchpad `report-rereview.md`): APPROVE. Each of F1–F5 fixed at the mechanism the first review named; every regression test fails at the expected assertion with its hunk reverted and passes in place; the archived probes that encoded the bugs now fail on the fixed tree; root first-turn lease, nudge path, twin matching beside foreign custom texts and the fleet mirror were additionally probed; the host and server commits verified. Whole-tree gates green (worker 441 + 1 skip, host 216, UI 1033, `pnpm -r typecheck`, identity). Follow-ups recorded, not blockers: O1 — D-199's silent ending is origin-agnostic, so an agent-origin run whose parent's message is exactly a slash command never hears the ending (contrived; consider `wakeParent: origin !== "user"` with a real-engine test); O3 — the root `clear_queue` wire trim has no test.
- 2026-09-11 packaged-worker gate rerun on the final candidate `46e6e19` (session scratchpad `report-packaged-2.md`, evidence `packaged-2/`): 91 of 91 assertions through the packaged host and worker. Package `harness.js` `0feb2115…`, `stable-extension-admission.js` `c1350962…` and `host/dist/agents/runs.js` `813786fb…` byte-identical to the candidate's dist (deterministic re-emit); clean-machine 13/13; daemon and worker `/proc/<pid>/exe` at the package's bundled Node, empty PATH, isolated HOME/state, `host.json` `cliVersion` = candidate; the incident scenario reproduced end to end (no terminal status before the invocation ended, one successor, F1/F2/correction/interrupt consumed once in order, interrupt aborted the blocked bash, one completion event per run, both `complete_agent_run` accepted) and `pi/session/list` now agrees with the worker's session state and the run list at every held point; clean `down` in 217 ms with no package survivor. Unchanged limits: late-event injection is not reachable over the wire; the fix-lane findings are covered by their own worker tests, not by this scenario.
- 2026-09-11 fix lane merged as `38a825d` (lane commits `5459e3f` F1, `e3043a7` F2, `2bc122e` F5, `92ac24b` F3, `f822565` F4; report relayed to the session scratchpad `report-fix.md`). F1: `promptUser` releases the admission lease the moment it parks a person's message (a parked message holds no preflight), proven on the real engine with the probe-A sequence inverted (reverted: 60 s deadlock, dispose hangs). F2: `settled()` and `kickMessage` endings go through `finalizePendingEnd`, so a successor reserved in the settled-unfenced window is taken (fake driver, reverted: `expected 'queued' to be 'running'`). F5: `clearQueue()` reads agent-core's queues before clearing and reports custom texts, transferred as foreign text with a `warn` (real engine, reverted: `preserved=0 custom=0`); a person's clear on a child parks them for the fence (D-200). F3: siblings keyed on the earliest run start on both fleet builders, mirror-pinned. F4: a run a handled slash command created without a model turn ends `cancelled`, harness initiator, without waking the parent (D-199; real engine, reverted: still `running`). Orchestrator applied the lane's root `clear_queue` wire trim. Worker 441 pass + 1 skip, UI 1033, pi-extension 108. Re-review of the fix diff and the packaged gate rerun on the final SHA follow.
- 2026-09-11 packaged-worker gate on `c344aba` (session scratchpad `report-packaged.md`, `packaged/evidence-run4/`): the desktop package built from the exact candidate carries `harness.js` and `stable-extension-admission.js` byte-identical to the candidate's worker dist (SHA-256 recorded, deterministic re-emit); clean-machine 13/13 with an empty PATH; a packaged daemon started on 41620 with isolated HOME/agent/session/state showed `/proc/<pid>/exe` at the package's bundled Node (not deleted) for both daemon and worker, `host.json` `cliVersion` = the candidate version; the incident scenario reproduced through the real packaged host and worker (two follow-ups queued, mixed `[complete_agent_run, bash]` batch, correction and interrupt across the window, exactly-once consumption `[task, F1, F2, correction, interrupt]`, old `completed` published only after the bash ended and with the successor live, successor completes, registry consistent) — 79 of 80 assertions; clean `down` in 213 ms, no package process survived. The one failure is a host projection: `pi/session/list` stood the child on the queued successor during the window (`packages/host/src/agents/runs.ts` `newestFirst` by start only); fixed by the orchestrator with a liveness-first standing run and a host test. The user's live Laser processes changed underneath (the pids recorded at session start are gone; 41441 is now served by a newer `/opt/Laser` process) — nothing of ours signalled them. The gate must be repeated on the final SHA after the review fixes.
- 2026-09-11 independent review of candidate `c344aba` (session scratchpad `report-review.md`): APPROVE WITH REQUIRED FIXES. Ownership design confirmed (one lifecycle boundary, declaration separated from publication, exactly-once transfer for what the engine can report, truthful acknowledgements, epoch fencing); putting `endRun` back inside `completeRun` fails 9 of 11 incident tests, first at `queued-completion.test.ts:557` (`expected 'completed' to be 'running'`). Findings: F1 BLOCKING — `promptWithFence` holds the first-turn lease through a deferred child prompt while the extension start wrapper waits for it: reachable through the pending tray's drain at `agent_settled` (proven on the real engine), wedges `session/cancel` and dispose; F2 HIGH — `settled()`/`kickMessage` end the owner through `endRun` and bypass `finalizePendingEnd`, orphaning a successor reserved in the settled-unfenced window; F3 LOW — siblings reorder during terminal-pending because both fleet builders read the liveness-first list's first run; F4 LOW — a handled slash command typed into an idle child's chat leaves a phantom `running` run with an idle phase; F5 MEDIUM — non-causal custom triggers Pi queues through `agent.steer()` are invisible to `clearQueue()` and silently dropped at a terminal declaration (contract 2; shipped producers: background exit wake from an earlier turn, grandchild events). All five go to a fix lane on the same owner branch before any tag; re-review of the fix diff and a packaged-gate rerun on the final SHA follow.
- 2026-09-11 checkpoint: ownership-2 lane merged as `069d168` (lane commits `937f70f` UI comparator, `055eb8a` worker). A: a person's `pi/session/steer`/`follow_up` into a child go through `harness.promptUser` (answering at engine acceptance) and `clear_queue` drops the harness's engine-owned twins; B: the UI's `compareRunsNewestFirst` ranks a run that can still act above a queued/terminal one, mirrored fixture pinned on both sides; C: `PromptOptions.origin` carried from the run record through the driver stamp, harness override removed (reverting the stamp fails the real-engine origin test); D: `ui_request`/`ui_event` stamped with the raising invocation's epoch and fenced in the harness, an unroutable run-stamped question is cancelled (reverting the fence hangs the real-engine test 60 s); E: no `module:subagents` diagnostic line contains a fixture text. Worker 432 pass + 1 skip. Orchestrator applied the lane's two proposals in `packages/worker/src/server.ts` (pending-tray Steer on a child through the fence; never forward a dialog the harness already cancelled) with two server tests, and the docs sentence. Open observations for review: `promptWithFence` holds the first-turn lease until acceptance, which can deadlock a person's deferred `session/prompt` behind an extension send in the same successor inbox (pre-existing); both fleet builders order children by the least-live run's start rather than the session's first run (mirror agrees, so hidden).
- 2026-09-11 checkpoint: ownership lane merged as `343eda2` (lane commit `82fe0d5`). Engine facts verified from the installed 0.85.0 dist: `terminate: true` stops model calls only when every tool of the batch terminated and both queues are empty at the post-batch polls; later tools of the same batch still execute; queued messages continue the loop before and after `agent_end`; `abort()` never touches the queues. Source: engine-queue transfer inside the terminating tool (per lane, in order, identical texts once), the same transfer before the abort on stop/extension-error, interrupt during terminal-pending aborts the owning invocation (declared result stands), `delivery: "delivered"` only on preflight acceptance with new `"refused"` + `error`, close fails a queued successor with a readable error and answers every waiter, fleet/`sessionInfo` stand on the run that can still act, credential-free `module:subagents` lifecycle diagnostics. Real-engine regression `packages/worker/test/agents/queued-completion.test.ts` (8 tests, barriers only) maps every incident assertion, including a mixed `[complete_agent_run, bash]` batch so the old invocation is still executing when the correction and interrupt arrive; variants for extension send, goal continuation, background wake, person's stop, cancel of the successor, session close. Worker 413 pass + 1 skip; pi-extension 108. Pre-fix evidence by citation of `7a05c79` lines (that harness no longer compiles against today's server). Residuals handed to a follow-up lane (ownership-2): person-side `pi/session/steer|follow_up|clear_queue` into a child bypass the fence; UI fleet comparator still stands a session on the queued successor during the window; `ui_request` not epoch-fenced; run origin stamped as a literal in the driver. Engine limitation recorded: custom messages Pi queues via `agent.steer()` are not enumerable by `clearQueue()`. Report: session scratchpad `report-ownership.md`.
- 2026-09-11 claimed by claude-2026-09-11-stabilize: previous writer confirmed stopped (child transcript last write 22:34:02Z on 2026-09-10; parent session idle after producing the report; no source writes in the development checkout since). Lane worktrees `.worktrees/lane-admission`, `lane-ownership`, `lane-first-turn` branched from `aca8591`. Ownership lane owns harness/session-lifecycle and writes the exact real-Pi two-queued-message completion/correction/interrupt regression (`packages/worker/test/agents/queued-completion.test.ts`); development source at `aca8591` already uses terminal-pending + successor instead of the released `endRun`-in-`completeRun`, so the lane proves and completes that design rather than rewriting it. Independent review, combined verify and the identified packaged-worker restart gate follow integration.
- 2026-09-11 requested by the person: retain the full high-severity incident as mandatory remaining work, not a generic busy-session note. Canonical report: [`docs/incidents/queued-completion-ownership.md`](docs/incidents/queued-completion-ownership.md). It records the complete UTC timeline, run/session/commit identities, reported transcript/source evidence and paths, inspected one-shot-abort/queue-continuation mechanism, seven-point fix contract, exact multi-queued-message regression and all assertions, adjacent cancellation/close/extension/goal/background cases, separate still-unfixed development defects, and `(deleted)` executable/build-identity uncertainty. Evidence is attributed to the supplied incident report; this planning task did not reread private transcripts or inspect/restart live processes.
- 2026-09-11 acceptance and ownership: no implementation owner claimed in this update. Continue within the same canonical lifecycle area as M13-T93/HLC-010 after safe handoff from frozen `aca8591`, never add a parallel owner for admission/settlement. Required before M13-T94: no unowned execution, premature completion, false delivered acknowledgement, overlapping invocation, duplicate successor or dropped/duplicated accepted message; interrupt reaches terminal-pending execution; valid successor completion and stale-callback fences hold. Real pinned Pi and identified fixed packaged-worker tests are mandatory; mocks/status-label changes/manifest-only checks are insufficient. Structured diagnostics must exclude credentials/raw private content. Live restart is not authorized by adding this task; use isolated packaged acceptance or separately coordinate any live restart.
- 2026-09-11 planning handoff: outgoing orchestrator owns only PLAN/STATUS/STATUS_DETAILED and the incident document for this update; preserved earlier status edits. Added M13-T98 and D-195, release dependency and continuation-handoff cross-reference. Recording a task is not implementation or independent approval; all existing backend and UI blockers remain open.

#### M13-T93 notes
- 2026-09-11 independent review of the admission seam on `c344aba`: A/C settle on every pre-accept failure, acceptance monotonic, no promise cycle, no error-text attribution, `invalidate()` leaves nothing consumable; the pinned Pi patch matches the approved plan exactly and the goal/web patches are byte-unchanged. Residual noted (pre-existing): a late dialog from an older generation after a child fork falls back to run-scoped attribution.
- 2026-09-11 checkpoint: admission lane merged fast-forward as `db52a6b` (`fix(worker): settle extension admission on every pre-accept failure`). A is an explicit monotonic gate; every pre-accept failure refuses A and C once; the error-message FIFO is gone and `onError` stamps only from the calling async context (proven on the real installed `_bindExtensionCore`); corrected `(text, options)` fake hung 4 s on the old helper. Worker 408 pass + 1 skip; new real-boundary `test/extension-admission-runtime.test.ts` proves lease/ownership release after an engine refusal. Not provable on real Pi 0.85.0: false-preflight-then-resolve and a custom trigger refused before acceptance (engine never produces them; helper-level fakes only). Report: session scratchpad `report-admission.md`.
- 2026-09-11 claimed by claude-2026-09-11-stabilize: B1 (false-preflight / streaming-custom A never settles; misleading `(options)` fake) and B2 (error-message FIFO attribution) go to the admission lane (`stable-extension-admission.ts`, `stable-sdk.ts` onError, `extension-admission*.test.ts`), disjoint from the ownership lane's harness files; both merge back into `stabilize/hlc010` for independent review.
- 2026-09-11 handoff correction: later owner messages at 22:33:57Z/22:34:02Z on September 10 acknowledged re-freeze at `aca859180f664d01f10d7a5d8e2a3c56033c9c09`; handoff Git inspection confirms committed source and only centralized status edits before this planning addition. Historical busy refusals remain real; they do not prove current source is still being edited. Latest source still has unsettled-refusal and error-message-FIFO defects; no independent HLC-010 approval. M13-T98 now records the person’s full queued-completion incident and mandatory reproduction. Resume only after deliberate stopped-writer/ownership confirmation; preserve all checkpoints and do not infer failed requests were handled.
- 2026-09-10 runtime safety blocker: owner reports corrected frozen `2178d1266a9f11cc5bd856e045e1a34ec81df3ac`, report `/tmp/laser-hlc010-report.md`, full verify green (397 worker +1 inverse skip). Orchestrator inspected and reran seven helper tests, finding false-preflight A never rejects and the fake accidentally receives text instead of options; streaming custom rejection can likewise leave A pending. Error-message FIFO attribution also leaks/misattribututes across late accepted failures. Correction resumption `run_238c9586` refused busy; owner source changed after reported freeze; safety interrupt `run_674a3acd` also refused busy. No truthful writing-stopped acknowledgement. Preserve all source/docs changes, no competing writer or integration. Unblocks on genuine owner checkpoint plus explicit freeze; exact findings and queued UI brief retained in `/tmp/laser-hlc010-pre-review-followup.md`.
- 2026-09-10 implementation handoff: owner committed `e1ddc2dbe1860953418e920bae00cab8414f70d0`, source/dependencies frozen and index empty; orchestrator docs remained unstaged. Owner reports full `pnpm verify` pass (`/tmp/laser-hlc010-verify.log`, worker 386+1 skip), frozen install, unchanged goal/web policy patches and new exact Pi patch. Orchestrator pre-review inspection requests corrections before independent review: Stable attaches every extension completion to parent descendants even when harness queues it to a terminal successor (possible parent-drain/successor-admission cycle); new invocation event metadata is not consumed by harness event attribution; real-Pi tests do not yet prove the claimed terminal-pending/custom-trigger/preflight edge matrix. Preserve checkpoint and fix with the same owner; do not call the milestone done from its handoff claim.
- 2026-09-10 implementation approval: refined plan `/tmp/laser-hlc010-plan.md` (SHA-256 `b20612bd76668212498925e80cb9bdea18be58175e44710dfd838852e7e4bd0c`) approved after pinned-source verification. Separate extension-visible admission A from harness-owned completion C, establish ownership before native preflight, retain causally registered continuation through invocation epochs, and make nested leases reentrant without outer-promise cycles. Exact Pi0.85.0 patch returns observed original promises; worker adapter controls A/C semantics. Scope includes `first-turn.ts` lease helper and a cohesive worker-only admission helper if needed; goal/web policy patches and version remain unchanged. Require explicit real-Pi accepted-but-consumed/no-agent-start coverage with no phantom live owner, besides the complete HLC-010 matrix. Same owner implements, then freezes exact revision for independent review; no release authorization.
- 2026-09-10 plan checkpoint: owner submitted `/tmp/laser-hlc010-plan.md` (initial SHA-256 `84d5304fd5420bf6f33b2c662f7efced4f2dab6bae33ce8baf195c5fc0a81df9`) without code changes. Orchestrator approves the bounded exact-version Pi0.85.0 patch/`pnpm-workspace.yaml`/lockfile write-scope expansion, not implementation yet: plan revision must resolve transitive continuation vs successor ownership, nested preflight/outer-lease promise cycles, cancel/close ordering, exact refusal vs accepted-late-failure semantics, and invocation-scoped origin. Current new-owner run `run_6d1f6452` is plan-only. Existing pins/policy patches remain unchanged; upstream contribution tracking remains an integration obligation.
- 2026-09-10 claimed by new sole implementation owner hlc010-admission-owner (`01a08d0a-9a10-70c8-b0d6-ec794e6de23d`, initial run `run_42a0a442`): investigate the installed pinned extension-send boundary and submit `/tmp/laser-hlc010-plan.md` for orchestrator approval before code. Ownership is isolated `hlc010-development` worker lifecycle/driver/server/Chord and directly related tests; planning files remain orchestrator-only. Base `120bf303255426b99d1c7fad25576354a3a604f8` preserves both checkpoint histories; fresh worker-dependency build and seven focused files/124 tests pass (`/tmp/laser-hlc010-base-focused.log`). No old agent was contacted or resumed.
- 2026-09-10 continuation checkpoint: separate `stabilize/hlc010` checkout `hlc010-development` starts from frozen `aba12f7b` and merges reviewed release repair `7a05c79`, preserving both histories. Only source merge conflict is the fleet test title/status assertion; resolved to the reviewed literal Blocked expectation and removed its now-unused constant import. Production lifecycle, first-turn binding and composer-local intent remain unchanged. This development merge is not approved for main; its exact diff joins the HLC-010 review target. New implementation scope authorized by Q-8/D-193; a written pinned-boundary plan must precede code.
- 2026-09-10 end-session blocker: coupled development commit `aba12f7b1912144d1d041f057aa643acf143aecd` is clean and frozen. An independent backend reviewer confirmed exact `aba12f7b` resolves HLC008 explicit provenance/default-model and HLC009 actual-state rollback; HLC001/002/003/004/006/007 remain resolved. The whole batch remains `changes_requested` solely for HLC010; HLC005 is nonblocking and deferred. Static evidence from previous runs is 121 focused worker tests plus typecheck, identity and diff check, not a fresh full gate.
- 2026-09-10 HLC010: `ExtensionAPI.sendUserMessage` returns void and the bound callback drops the nested prompt promise; a real goal action returned before `agent_start`, and goal continuations also occur outside the owned invocation. No unsafe partial goal fix is retained and no child goals are disabled. Correctness requires a dedicated reviewed awaitable extension-generated prompt-admission seam—worker-owned interception/rebinding or an upstream hook—not another `agent_settled` wait. Further implementation requires the person’s answer to Q-8. HLC005’s structural rewrite is deferred.
- 2026-09-10 claimed by stabilization-ledger: record the frozen end-session state, HLC010 blocker, skipped gates and retained-worktree inventory; update only `STATUS.md`, `STATUS_DETAILED.md` and `docs/ux-agent-work.md`, with no source or release action.
- 2026-09-10 ownership transfer: harness-lifecycle froze focused fix `d79c2869efffc054e2d919b99bc2fe7b43b587ea` with 55 focused harness tests and the full worker suite at 343 plus one skip; it has no source changes left uncommitted. The checkpoint is unapproved. Both source checkpoints and the transfer acknowledgement are recorded in H-5.
- 2026-09-10 continuing coupled-lifecycle claim by harness-lifecycle: sole ownership now covers first-binding protocol/UI runtime/worker driver/server/integration tests plus the existing harness. Preserve `a0264674` and `d79c2869` into one coherent development batch; fence all prompt/steer/follow-up/tray caller paths across runtime preparation, integrate harness `promptUser`, and prove the real SDK/server model, thinking, rollback, settled-gap, origin and acceptance paths. No other writer continues those files.
- 2026-09-10 corrections checkpoint: `7d99f55487fe2b2371705bdeec87f782ebe8b9b2` is changes-requested for HLC001 caller adoption, HLC006 settled-gap handling and HLC007 origin semantics. Corrections are active on `8e727681f`, whose parent includes only approved pending main `e1c24c7`; shared server ownership remains first-prompt-binding until its explicit source checkpoint.
- 2026-09-10 stabilization checkpoint: implementation `7d99f55487fe2b2371705bdeec87f782ebe8b9b2` from `e8db6b5` is frozen and clean; HLC001–005 module re-review is active. Server `promptUser` adoption is still missing, so it is not integrated and has no done evidence.
- 2026-09-10 historical checkpoint: the first-binding snapshot’s initial broad claim follows verbatim.
- 2026-09-10 claimed by harness-lifecycle: harden start/end/failure/cancellation/recovery transitions against the binding harness contract and return focused worker/host evidence.
- 2026-09-10 historical checkpoint: the original ledger’s later serialized-boundary claim follows verbatim.
- 2026-09-10 claimed by harness-lifecycle: serialize child completion, actual engine/session settle and ended-agent resume so the run registry and live session cannot disagree. Completion is stored once; wait for the real session turn to settle before resuming, with no extra completion/follow-up loop. Ownership is `packages/worker/src/agents/harness.ts` and focused harness tests only; pending-delivery retains driver/server files.

#### M13-T94 notes
- 2026-09-11 housekeeping with the person's permission: the five session lane worktrees (`lane-admission`, `lane-ownership`, `lane-first-turn`, `lane-review`, `lane-packaged`) were removed after confirming each branch merged into main and each tree clean, and their `lane/*` branches deleted. The older retained worktrees (`activity-disclosure-f164a638`, `ci-035-repair`, `composer-layout-cabf1254`, `draft-agent-selection-a82608ba`, `first-prompt-binding-8329d10a`, `harness-lifecycle-1df0cfd1`, `header-agent-c7c7881a`, `hlc010-development`, `main-reconciliation`, `neutral-finished-runs-18dc6dd3`, `pending-delivery-a1356f50`, `ui-acceptance`) and the external `laser-agents` checkout are untouched; they were never part of this offer.
- 2026-09-11 done: release workflow 34572122489 completed successfully at exact `dc11c4d` (all four jobs green). GitHub `v0.3.6` is public, stable and Latest, published 2026-09-11T07:06:42Z with 12 uploaded assets (x64/ARM64 AppImage, tarball, deb, rpm, install.sh, SHA256SUMS, SHA256SUMS.sig, provenance.jsonl); all nine manifest digests match the API, the downloaded x86_64 AppImage matches the manifest and `gh attestation verify` passes with the offline bundle; human release notes applied afterwards with asset ids, sizes and digests unchanged. Evidence: session scratchpad `publication-proof-0.3.6/` (release JSON before/after notes, SHA256SUMS, signature, install.sh, provenance, attestation log, actions result), `verify-release-0.3.6.log`, `release-gate-0.3.6.log`; release https://github.com/youssefsiam38/laser/releases/tag/v0.3.6. Installed app and personal state untouched; the user's live 0.3.5-era desktop needs a full quit (including the tray) and reopen to adopt 0.3.6.
- 2026-09-11 tag pushed; release building — not published. Release gate passed in the clean checkout at `dc11c4d` (identity check, `pnpm verify`), source CI run 34571854176 concluded success for that exact commit, `origin/main` = `dc11c4d`, annotated tag `v0.3.6` (`edb7117`) pushed and peels to `dc11c4d`; release workflow run 34572122489 started from the tag. Publication is reported only after the assets, manifest digests, signature, offline provenance and every workflow job are verified (session scratchpad `verify-release-0.3.6.sh`).
- 2026-09-11 integration: `stabilize/hlc010` (`6746016`, source `46e6e19`) merged into local main as `d7dd76c` with a tree identical to the branch and the user's working-tree deletions and untracked files untouched; `scripts/release/set-version.sh 0.3.6` committed as `dc11c4d` (11 manifests plus `product.generated.ts`). Main pushed; the exact-SHA release gate runs in a clean checkout at `dc11c4d` (identity check, full verify, wait for the `ci.yml` push run on that commit, confirm `origin/main`, annotated tag `v0.3.6`, tag push; session scratchpad `release-gate.sh`, log `release-gate-0.3.6.log`). Publication belongs to the release workflow; report "tag pushed; release building" until the assets are verified.
- 2026-09-11 final candidate verify: `pnpm verify` passed on `46e6e19` (protocol 41, pi-goal 8, relay 17, crypto 42, pi-extension 108, UI 1033, worker 441 + 1 designed skip, host 216, CLI 68, desktop 101, release 13; session scratchpad `verify-46e6e19.log`). Re-review of the fix diff, the packaged-worker rerun and a fleet browser re-check run on that exact SHA.
- 2026-09-11 final combined verify: `pnpm verify` passed on candidate `c344aba` (protocol 41, pi-goal 8, relay 17, crypto 42, pi-extension 108, UI 1032, worker 434 + 1 designed skip, host 215, CLI 68, desktop 101, release 13; log in the session scratchpad `verify-c344aba.log`). Independent review, browser reruns and the packaged-worker restart gate run on that exact SHA in isolated worktrees; remote `origin/main` is still `7a05c79` (0.3.5), local main `5a8fe4f` is its reviewed reconciliation.
- 2026-09-11 gate slip and repair: full `pnpm verify` on `e9308c6` failed one UI test (`test/shell/session-folds.test.tsx` "returns a resumed session to the live fold…"): the ownership-2 lane ran only `test/agents` and `test/fleet` for the UI, so the comparator change was not run against the sidebar suite. Cause was the fixture, not the product: it left the session's original run `running` while dispatching a newer failed and a newer completed run, a registry state the harness never produces; with liveness-first ordering that phantom run stood for the session. Fixture now ends the original run and resumes with a new one (test-only commit); UI 1032 pass. Full verify rerun on the new candidate required before any gate result counts.
- 2026-09-11 interim gate: full `pnpm verify` passed on the combined candidate `f47d96b` (admission `db52a6b`, ownership `82fe0d5`, first-turn `c42524a`, docs/vocabulary commits): protocol 41, pi-goal 8, crypto 42, relay 17, pi-extension 108, UI 1029, worker 425 + 1 designed skip, host 215, CLI 68, desktop 101, release 13 (log: session scratchpad `verify-f47d96b.log`). Not the final candidate: the ownership-2 residual lane, independent review, browser reruns and the packaged-worker restart gate remain.
- 2026-09-11 dependency addition (D-195): the person requires the complete runtime incident to be added to remaining work. M13-T98 is a release blocker alongside all original criteria: exact real-Pi multi-queued-message completion/correction/interrupt reproduction, independent review, truthful fleet/diagnostics, and fixed packaged-worker validation after controlled isolated restart with actual build identity. No live restart, source implementation, commit/push/tag or release was performed in this planning update. D-194 publication authorization remains valid after all gates.
- 2026-09-10 release authorization/claim: the person explicitly instructs committing, pushing and releasing the next stable version after finishing the originally requested stabilization, without asking again. Orchestrator owns integration/publication; M13-T89/T92/T93/HLC-010 and remaining T90/T91/T95/T96 acceptance must pass independent review, staged exact-candidate identity/verify, browser and native packaged gates first. No gate bypass, premature version bump, user-state change or optional enhancement. Current next patch is expected 0.3.6, to be rechecked against actual remote release state before versioning. Original T94 criteria remain unchanged.
- 2026-09-10 end-session checkpoint: accepted staging `stabilize/0.3.5` is clean at `adcbd66f68eab9cfcd131d3eed763d11517695d6` in `pending-delivery-a1356f50`, containing approved pending `e1c24c7`, composer `e7a5b89`, disclosure `131332b`, header `a8715dd`, neutral-fleet `d694b07` and ledger `b046478`. It is not a final release candidate. Preliminary full verification passed at `6b69f5e` before header, neutral-fleet and lifecycle changes. Exact `adcbd66` focused checks passed: 58 UI tests across top-bar identity, composer layout, activity disclosure, fleet model and session folds; 11 worker fleet tests; identity and diff check. Full current verify, browser and package gates were skipped at the user’s request, so release readiness is not established.
- 2026-09-10 release stop: manifests remain 0.3.4. No tag, push, publish, version, install or restart is authorized; ask before publishing. Optional Markdown instruction highlighting/variable inspection and image preview are deferred outside this patch.
- 2026-09-10 candidate checkpoint: `stabilize/0.3.5` exists at `6b69f5ee33b0f1b451af866a8d78298ff7a84f4b` in the old pending worktree and contains only approved pending `e1c24c7`, composer `e7a5b89` and activity `131332b` via clean merges. Exact-candidate `pnpm identity:check && pnpm verify` passed: UI 980, worker 331 plus one skip, host 215, desktop 101 and release 13. This is not a final release candidate; the version remains 0.3.4.
- 2026-09-10 stabilization: release preparation only. No version change, push, tag or publication until the combined source candidate passes required gates and the user gives explicit permission. Optional Markdown-variable and image-preview enhancements are outside this patch.
- 2026-09-10 dependency update: M13-T95 and M13-T96 are release correctness fixes and join M13-T89 through M13-T93; the pending Markdown variable-editor/image-preview enhancements are not dependencies without the user’s release-scope answer.
- 2026-09-10 added as the next patch release after M13-T89 through M13-T93 are done and independently reviewed; no source/tag/publication work starts before those dependencies pass.

#### M13-T95 notes
- 2026-09-11 combined-candidate browser gate on `c344aba` (session scratchpad `report-browser.md`, evidence under `browser/`): Chrome 153 CDP against sandboxes on 41630–41633 with temporary state, both widths and themes. Activity disclosure: a manual aggregate close survives 1360→390→1360; Ctrl+F reveals the folded `progress`; Escape restores the fold, textarea focus and Show everything.
- 2026-09-10 initial acceptance continuation finished at exact `91a7759`: real opposite Main/Beam send orders, manual-close across 1360→390→1360, Find transient reveal/Escape fold+focus+preference restoration, and reduced motion both themes/widths passed. Artifacts `/tmp/laser-ui-acceptance-{two-composers,detail-find,reduced-motion}.json`; source clean and ports 41536/9252 stopped. Partials remain explicit: frozen product excludes loose extension fixture for real approval-footer browser proof; second mic disables immediately so exact conflict toast is not deterministically reachable (single mic/transcription ownership passed). Final candidate reruns still required; no task marked done from preliminary evidence.
- 2026-09-10 browser checkpoint: `/tmp/laser-ui-acceptance-report.md` records exact `91a7759` evidence and incomplete gates, not blanket acceptance. Same read-only reviewer continues initial acceptance as `run_e2806604`: remaining single-page navigation/detail override/Find restoration/approval footer/two-composer/reduced-motion checks; final-backend reruns await frozen candidate. Draft-loss blocker belongs to T89; no source changes or personal state touched, original ports stopped.
- 2026-09-10 acceptance claim: independent read-only reviewer stabilization-ui-acceptance (`01a08d2f-269a-70c8-b0d6-ec85497c2d18`, `run_478d0b32`) validates the stable preserved frontend in its own checkout/build at `91a7759`, with fresh temporary sandbox/browser state. Both widths/themes and realistic pointer/touch/keyboard evidence; no source writes or lifecycle implementation ownership. Report `/tmp/laser-ui-acceptance-report.md`; final HLC-dependent integration scenarios must be rerun on the eventual combined candidate.
- 2026-09-10 end-session checkpoint: approved disclosure `131332b` is included in accepted staging `adcbd66`; keep the task in progress because its actual done criteria and current full/browser gates have not all been established.
- 2026-09-10 candidate checkpoint: approved activity commit `131332b` is clean-merged into preparation candidate `6b69f5e`; its evidence is candidate-only, not final combined acceptance.
- 2026-09-10 implementation checkpoint: eight files were uncommitted, including `ToolRow` and `sessionPreferences`, while real-browser review ran.
- 2026-09-10 claimed by activity-disclosure: manual aggregate open/close remains authoritative, and Answers-only never auto-opens errors or streaming activity. Ownership includes `packages/ui/src/runtime/sessionPreferences.ts`, dedicated preference tests, `tool-group.aui.tsx`, `tool-fallback.tsx` and `reasoning.tsx`; no overlap with `reasoning-effort.tsx` or other runtime files.

#### M13-T96 notes
- 2026-09-11 fleet browser re-check on `46e6e19` (session scratchpad `report-browser-2.md`): neutral fleet script unchanged passes; `completed` reaches the wire 1 ms after the last `tool_execution_end` and the row never reads finished while live; new sibling-order gate through the host's own registry shows alpha before bravo in all three terminal-pending states with byte-identical react-flow node transforms (no re-layout); the shipped first-turn repro exits 0 on the candidate's own bundle (`index-aL4osDqZ.js`). Partials unchanged (strays dot from fixtures only; the sibling gate is registry-driven). Observation for M13-T100: a More tooltip stays painted after its menu closes.
- 2026-09-11 combined-candidate browser gate on `c344aba` (session scratchpad `report-browser.md`, evidence under `browser/`): Chrome 153 CDP against sandboxes on 41630–41633 with temporary state, both widths and themes. Neutral fleet: `explorer · Done` muted after the child completes; Working on a 4 s child; Blocked (ink-3) and Asking (attention) from run fixtures; no overflow at 390. Queued-completion projection: `completed` reached the fleet 1 ms after the last `tool_execution_end` (the `complete_agent_run` itself) and the row never read finished while live. Partials: terminal `blocked` and the strays dot only from fixtures (the stub scene cannot provoke them).
- 2026-09-11 checkpoint: docs and vocabulary aligned with D-189 — `05bec99` (docs/agents.md neutral Blocked, docs/upstream.md Pi awaitable-send entry), `e165e7c` (map legend and strays dot say Asking), plus the companion's `inspect_fleet` description/comment/test now list Blocked instead of Needs you. Browser reruns on the combined candidate still required.
- 2026-09-10 browser checkpoint: `/tmp/laser-ui-acceptance-report.md` records exact `91a7759` evidence and incomplete gates, not blanket acceptance. Same read-only reviewer continues initial acceptance as `run_e2806604`: remaining single-page navigation/detail override/Find restoration/approval footer/two-composer/reduced-motion checks; final-backend reruns await frozen candidate. Draft-loss blocker belongs to T89; no source changes or personal state touched, original ports stopped.
- 2026-09-10 acceptance claim: independent read-only reviewer stabilization-ui-acceptance (`01a08d2f-269a-70c8-b0d6-ec85497c2d18`, `run_478d0b32`) validates the stable preserved frontend in its own checkout/build at `91a7759`, with fresh temporary sandbox/browser state. Both widths/themes and realistic pointer/touch/keyboard evidence; no source writes or lifecycle implementation ownership. Report `/tmp/laser-ui-acceptance-report.md`; final HLC-dependent integration scenarios must be rerun on the eventual combined candidate.
- 2026-09-10 deferred documentation correction identified by independent CI reviewer: `docs/agents.md:146,223–224,268–271` still describes terminal blocked as Needs you/attention. D-189 and source/tests supersede it; reconcile in the stabilization acceptance follow-up, not in the bounded release-test repair.
- 2026-09-10 end-session checkpoint: approved neutral-fleet `d694b07` is included in accepted staging `adcbd66`; keep the task in progress because current full/browser gates have not all been established.
- 2026-09-10 review checkpoint: bounded approved commit `d694b07` awaits D-189 ledger context and the combined needs-you 2→1 harness test; it is not integrated. Its prior candidate held 17 uncommitted files including worker fleet changes while browser review ran.
- 2026-09-10 claimed by neutral-finished-runs: render terminal `blocked` as neutral finished work, include it in finished folds, and make newer active work supersede historic failures across fleet, sidebar and inspect words. Preserve live warm `needs_input` as Asking and preserve live descendants.

#### M13-T97 notes
- 2026-09-10 release-note correction requested by the person: published page initially contained only GitHub’s generated Full Changelog link. Added product-facing 0.3.5 notes with the actual approved subset, verified Linux downloads, full-quit upgrade guidance and explicit exclusion of unfinished first-turn binding/hydration/lifecycle work. `gh release edit v0.3.5 --notes-file /tmp/laser-035-release-notes.md`; read-back body matched exactly. Release/tag identity and all 12 asset IDs, sizes and digests unchanged (`/tmp/laser-035-release-{before,after}-notes.json`). Future publication handoffs must verify the release body as well as assets.
- 2026-09-10 local reconciliation finished: independent reviewer approved exact merge `5a8fe4f0b20e2902623b9d85298e0bf5b1af12c7` (`/tmp/laser-main-reconciliation-review.md`). Parents are original local main `2171a0b` and reviewed release `7a05c79`; full tree `1b488ae1716ca8dcbca0c1ab02274e1fb16f1852` equals the verified release tree. Local main fast-forwarded to `5a8fe4f`, with all 41 user deletions and three untracked paths identical before/after and index clean. Remote main/tag remain `7a05c79`; no reconciliation push. Development owner remains isolated; no lifecycle change was integrated. Current ledger is this development branch and will accompany the eventual reviewed combined integration.
- 2026-09-10 local reconciliation claimed by stabilization-ci: after release completion, prepare the requested non-destructive local-main merge in isolated `main-reconciliation` from local `2171a0b` plus reviewed/released `7a05c79`. Only STATUS/STATUS_DETAILED conflict; resolve to already-reviewed release versions and prove the complete resulting tree equals `7a05c79`, then obtain independent review before fast-forwarding local main. No remote push, reset, or user-dirt modification; current ledger remains this development checkout.
- 2026-09-10 done: release `34527657277` completed successfully at exact `7a05c79f5526beb22d1defe1b232283044956e5b` (native x64, native ARM64, publish, APT/DNF deployment all green). GitHub `v0.3.5` is public, stable and Latest, with 12 uploaded nonzero-size assets. Native clean-machine logs prove packaged real sessions with all bundled features and 1,336 models, empty PATH, executable dependency graph and legal files on both architectures; actual-release installer validation passed 46 checks. Independently compared all nine manifest-listed remote asset SHA-256 digests against downloaded SHA256SUMS; downloaded installer, checksums, signature and offline provenance have matching remote bytes/digests, and `gh attestation verify` on installer with that offline bundle passed. Evidence: `/tmp/laser-release-035-actions-result.json`, `/tmp/laser-release-035-actions-full.log`, `/tmp/laser-release-035-api.json`, `/tmp/laser-035-publication-proof/`; release https://github.com/youssefsiam38/laser/releases/tag/v0.3.5. This approves only the D-192 subset; HLC-010/first-turn binding are NOT in this release and other UI tasks retain incomplete browser criteria. Installed app and personal state untouched.
- 2026-09-10 release gate checkpoint: repaired source CI `34527293821` succeeded for exact `7a05c79f5526beb22d1defe1b232283044956e5b`, including build, typecheck, workspace tests, installer fixtures and release-script checks. Approved launcher `t-5cbd7e60` exited 0 after its own fresh identity/verify and exact-SHA guards, pushing annotated `v0.3.5` (tag object `4fae32df8d64649d1c16ce7dc00405f67d77c4dc`, peeled commit `7a05c79`). Release workflow `34527657277` is building; GitHub release page is absent. This establishes tag pushed, NOT publication or downloadable readiness.
- 2026-09-10 repair checkpoint: exact `7a05c79f5526beb22d1defe1b232283044956e5b` approved by independent reviewer `run_0705ff2a` with no blockers (`/tmp/laser-ci-035-independent-review.md`); 57 focused harness/fleet/seam, worker typecheck, identity/diff passed. Full `xvfb-run -a pnpm verify` passed 1,923 workspace tests plus 1 skip and 13 publication regressions; synthetic installer gate passed 76 checks. Evidence `/tmp/laser-ci-035-verify.log`, `/tmp/laser-ci-035-verify-install.log`. Reviewed repair pushed directly as fast-forward to origin/main. The unchanged approved launcher was restarted once after confirmed exit of the failed original, with the repaired isolated checkout and exact SHA (`t-5cbd7e60`, `/tmp/laser-release-035-repair-run.log`). No tag/publication outcome claimed yet; do not advance origin/main or edit its guarded checkout.
- 2026-09-10 claimed by stabilization-ci: repair the source-CI regression on isolated branch `stabilize/ci-035-repair`, based on `ebcdcb90ba41d4e628e0f0dc54525173564835e3`. CI 34525850169 passed build/typechecks but failed `test/agents/harness.test.ts:725`: old needsYou=2 and blocked="Needs you" expectations conflict with D-189. The approved launcher (actual SHA-256 `ee2ed894626006669bfb473fbb752f061dd696e67cfff82f09cc17f3b3101311`) stopped in local verify on the same failure; no launcher process, local/remote v0.3.5 tag or GitHub release exists. Preserve its checkout and log. Acceptance: change only stale test expectations/title, preserve live Asking and terminal outcomes, pass focused harness/fleet/seam and exact-candidate identity/verify, obtain independent review before integration. No lifecycle source belongs in this repair.
- 2026-09-10 preparation checkpoint: all workspace manifests and generated product metadata are 0.3.5. Remote Latest remains `v0.3.4` and remote `v0.3.5` is absent. Staged identity/diff checks and 13 publication regressions pass. Frozen launcher `/tmp/laser-release-035-gated.sh` (`sha256:8677a79dbd9e21fdfaef7d84ef7daea961fc2e58bfd98d273049213cf0ec9bfa`) accepts only an isolated checkout plus exact candidate SHA; it runs staged `pnpm verify`, requires successful `ci.yml` for that SHA, rechecks clean HEAD and `origin/main`, and pushes only the immutable tag. It has not been run; no ref or release was created.
- 2026-09-10 claimed by release-preparation: version the independently approved subset as 0.3.5 and prepare a fail-closed asynchronous gate launcher. Included source is pending `e1c24c7`, composer `e7a5b89`, disclosure `131332b`, header `a8715dd` and neutral finished runs `d694b07`; unapproved coupled first-turn/harness batch `aba12f7b` and HLC010 stay out. The person authorized release of this subset without waiting in the current turn, but staged verification, exact-SHA source CI, both architectures and verified publication remain mandatory before any published claim.

#### M13-T86 notes
- 2026-09-10 claimed: add a searchable custom-agent choice to every unstarted project session, bind the choice before the first prompt while keeping Beam/Chat/Namer in their own channels, and make thinking selectable as a per-session override before any session exists. Preserve empty-session reuse, drafts and unrelated untracked work.
- 2026-09-10 checkpoint: the searchable pre-turn agent selector is immediately before model at both widths, defaults from the snapshot, filters all built-ins and disappears for started/built-in sessions. Switching agents moves plain draft text into the selected empty session; attached drafts are refused with explicit guidance rather than stranded. Pre-session thinking derives the default agent/model capabilities and creates/reuses the default-agent session before applying the existing session override. UI typecheck and focused agent/thinking tests pass.
- 2026-09-10 review checkpoint: closed every independent review finding: workspace cwd hides unattributed built-ins, empty Chat cannot expose project controls, session preparation locks input/Send against first-prompt races, draft moves clear source runtime/storage without round-trip multiplication, thinking follows adjacent project-model changes and `defaultThinkingLevel`, and live-branch failures outrank working descendants.
- 2026-09-10 browser checkpoint: isolated `pnpm sandbox` at 127.0.0.1:41452, fake provider and temp project/state only. Inspected 1360×900 and 390×844 in dark/light: agent precedes model without overflow, the searchable picker autofocuses and fits the phone, thinking reflects the effective model, and the agent control disappears after the first prompt. Screenshots: `/tmp/laser-project-{desktop,desktop-dark,phone-light,phone-dark}.png`, `/tmp/laser-agent-picker-phone.png`, `/tmp/laser-after-send-phone.png`.

- 2026-09-10 done: exact intended source staged and verified in an isolated checkout because unrelated `.laser/settings.json` and `.tmp-pi-command-demo.py` fail the main checkout's identity scanner. `pnpm identity:check` and complete `pnpm verify` passed: 1,884 workspace tests, one intentional skip, and 13 publication regressions; UI alone has 968 passing tests. Final source matched the verification tree byte-for-byte. Log: `/tmp/laser-m13-t86-87-verify-final.log`. Final browser check proved a real Default→reviewer→Default draft move, preserved text and unlocked sending; `/tmp/laser-final-{desktop,phone}-{dark,light}.png`. Narrow desktop review exposed a grid overlap, fixed with shrinking flex controls and inspected at `/tmp/laser-final-desktop-light-fixed.png`. Navigation during a deferred thinking RPC releases the composer without pasting into the wrong session and keeps the landing draft recoverable on the intended target. No personal state or unrelated files changed.

#### M13-T87 notes
- 2026-09-10 claimed: remove redundant trailing status words/count chips from session rows only after the parent activity mark, child run dot and folded-branch disclosure carry the same working, waiting, needs-you and failure meanings accessibly. Preserve fold behavior and give the recovered width to session names.
- 2026-09-10 checkpoint: removed child run words and parent descendant chips. The zero-width fold gutter now rolls up needs-you, error, working and waiting in protocol attention order, with full counts on the fold aria-label/title and row tooltip. Terminal children retain independent session error/unread marks, finished-fold counts remain visible, motion has reduced-motion fallbacks, and 17 focused sidebar tests pass.
- 2026-09-10 browser checkpoint: sandbox delegation produced a real child session. Pointer-opened the parent and finished folds at 1360×900 and confirmed the child title gets the reclaimed width, its leading terminal dot remains, its independent unread outline remains, no run-state word appears, and the retained “1 finished” label controls the finished fold. Screenshot: `/tmp/laser-sidebar-child.png`. Phone/desktop and dark/light shell checks showed no overflow; keyboard fold behavior and genuinely hidden bodies remain covered by interaction tests.

- 2026-09-10 done: all descendant failures now count independently of lifecycle partitioning, so a failed parent with a working grandchild still marks its collapsed ancestors in danger. Root activity, active/terminal child marks, independent unread outlines, full accessible branch summaries, pointer/keyboard folds and genuinely hidden bodies remain covered; complete isolated verification above passed. Fleet status words and finished-fold counts were not changed.

#### M13-T84 notes
- 2026-09-10 claimed: implement the six approved composer/activity fixes, preserving the prior internal-project fix and unrelated work. Confirmed the phrase adapter has a 90-second stop timer and the empty Beam composer hides dictation for lack of a session view. Inspect cancellation races, layout constraints and browser fixtures before verification.
- 2026-09-10 checkpoint: the person changed the Beam creation policy to eager, with empty-session reuse shared with the sidebar +. Fixed root-only candidate matching and separate quiet/selecting allocation races in the shared launcher. No pre-session microphone workaround remains.
- 2026-09-10 checkpoint: 90-second timers removed; cancellation covers permission/capture/upload/provider races and prevents pending send continuation. Host keeps upload routing alive during transcription so Discard can abort it. Added interruption feedback and owner-specific teardown. Reasoning labels, bounded skill previews/full details and two-level activity summaries are implemented. Initial full UI suite (956) and host suite (215) plus all workspace typechecks passed; final review and documentation in progress.
- 2026-09-10 done: final UI suite 957 passed, host suite 215 passed; `pnpm -r typecheck`, UI/host builds and `git diff --check` passed. Regression coverage includes three simulated hours of listening, continuous speech chunking, discard/startup/late-result races, pending-send cancellation, host abort routing, eager bubble creation/refusal/retry, private-workspace reuse and concurrent sidebar/bubble allocation, visible reasoning, skill details and mixed-action disclosure.
- 2026-09-10 browser evidence: isolated sandbox at 127.0.0.1:41449 with fake provider, synthetic microphone and intercepted transcription/model/history payloads (no personal credentials or transcripts). `/tmp/beam-composer-review.mjs` passed at 1360×900, 390×844 and 320×700 in dark/light, with both mouse and coarse-touch contexts; verified actual microphone controls, draft preservation, skill-preview geometry, wheel-scrolling full descriptions, pointer/Enter/Space disclosures and no page errors. Inspected screenshots under `/tmp/beam-composer-review` and `/tmp/beam-composer-review‑touch`. This is not live OpenAI or real-device microphone acceptance.
- 2026-09-10 delivery: source remains uncommitted and uninstalled; the running app was not restarted, real app state/history was not edited, and earlier/unrelated work was preserved. `pnpm identity:check` still fails only on pre-existing untracked `.tmp-pi-command-demo.py:12`. Documentation updated; temporary review server stopped after verification.

#### M13-T83 notes
- 2026-09-10 claimed: replace this session's partial state-folder workaround with a root-cause fix. WorkerClient passes `--cwd` but inherits the host process cwd; Pi opens a missing transcript by creating a new identity at that inherited cwd. Automatic worker recovery bypasses the router's missing-session guard. Reproduced with the pinned SessionManager without writing a transcript.
- 2026-09-10 scope: spawn workers in their intended directories, refuse missing/empty persisted sessions before invoking the permissive engine loader, reject internal project paths, and filter invalid internal-storage sessions rather than guessing they are Chat. Preserve all real transcripts and unrelated untracked work; no installation, restart or release requested.
- 2026-09-10 done: WorkerClient now sets the actual process cwd. StableSdkDriver validates saved transcripts and constructs the saved runtime directly, eliminating the throwaway new-session runtime and permissive switch. Shared host path containment governs project add, new session, move, load, list/search and worker startup, including existing filesystem aliases. Beam/Chat and the projectless Settings service retain their intentional internal workers; Settings cannot create sessions or projects in its service directory. Removed the partial Chat reclassification and extra protocol fields.
- 2026-09-10 verification: Node 24; host/worker/UI builds and every workspace typecheck passed. Complete host suite: 214 tests, including real worker restart and direct missing-session reload, internal add/create/load refusal, and Settings before any project exists. Complete worker suite: 316 passed, one pre-existing intentional skip. Complete UI suite: 934 passed. `git diff --check` passed. No visual styling changes or manual browser review; navigation coverage is automated.
- 2026-09-10 release limitation: `pnpm identity:check` still fails on the pre-existing untracked `.tmp-pi-command-demo.py:12` product literal; left it and all other unrelated untracked work untouched. No claim of a green full release gate, no commit, installation, or running-app restart.

#### M13-T65 notes
- 2026-09-09 the user forked a session and saw the fork nested under its origin like an agent's child. Cause: the catalog turned the engine's `parentSession` header — a fork's lineage — into the summary's `parentPath`, the same field the agent record fills for a child, and every consumer of `parentPath` (the sidebar's fold, the agents map's attribution, the move's "a child moves with its tree" refusal) read it as "an agent started this one". Fixed at the source: the header becomes `forkedFrom` (lineage only, new on `SessionSummary`); `parentPath` now comes only from an agent record. A fork is listed beside its origin in the project group.

#### M13-T64 notes
- 2026-09-09 done: the user asked how Namer runs under concurrency and, told of the three-per-session cap, decided against it. The cap is gone — every tool call in a burst is asked about at once; a call already asked about or already ended is still skipped — and a child agent's session is never labelled at all (`labelTool` returns before asking when the session's agent record says `kind: "child"`). Session naming was already unbounded and is unchanged.

#### M13-T63 notes
- 2026-09-09 done: after Restore, the composer's own textarea is focused with the caret at the end of the restored text, found from the offer's composer root and never the first textarea in the document (more than one composer can be on screen). The test mounts a stray textarea first and proves it is not the one focused, and that the offer is spent.

#### M13-T59 notes
- 2026-09-09 done: a Logs section with no writer is a placeholder, which the bar forbids. The section keeps its wire id (`subagents`, no protocol change) and is labelled **Agents**: every run status transition the host sees — from a worker's `agents/run` report when the status moved, and from the registry's own changes (worker lost, session deleted) — is one row, filed under the parent's session when there is one so the delegating session's log shows what became of its children, with who (`explorer (default)`), the new status, and the error, the ending reason or the completion message. Failed is an error row; needs input and blocked are warnings.

#### M13-T58 notes
- 2026-09-09 claimed: the user wants a Chat-tab row's More menu to offer moving the session to a project — an existing one, or a new one chosen or created through the native directory picker. Designed protocol-first as `pi/session/move { path, cwd }`: the host closes the session in its worker, rewrites the header cwd and the agent record into the project's session directory atomically, registers the project if new, and the UI selects it under the project in Code.
- 2026-09-09 done: `pi/session/move { path, cwd } → { path }` is the host's. It refuses, in a person's words, a chat still answering, a session with a live agent run, a child (it moves with its parent's tree), a target that is missing, a file, Chat's own workspace, or an agent's worktree, and the same project. If the session is open it first asks the worker to let go of it with `pi/session/close` (D-164: host → worker only, refused from clients, SessionBusy while streaming), then rewrites the file into the project's session directory by Pi's own slug rule (flat layout honoured) with the header's `cwd` set and the first `lasercode/agent` record replaced in place by the default root agent, temp file and rename, old file unlinked; catalog, views and unwritten caches invalidated for both paths; `seenAt` carried across; the project registered and touched if new.
- 2026-09-09 the surface: the Chat tab's row menu gains **Move to a project…** (not for children or archived rows). The dialog lists projects current-first, then by last use, then rail order, each with its path, and ends with **New project…** — the desktop's one folder picker, reused from Add project, or a typed path in a browser. Copy: "Its history and name come with it. It leaves Chat and appears under <project> in Code." The button reads Move → Move to <name> → Moving… → Try again; a refusal stays inline with the host's reason; success lands on the Code tab with the session selected, same transcript, and a toast saying where it went.
- 2026-09-09 verified with three moves in the sandbox: a typed-path new project (dark), a keyboard pick from the list (light), and from the phone sheet (dark); files re-headered on disk. Noted, not asked for: a session whose children have all finished moves and leaves those children in Chat as detached rows.

#### M13-T57 notes
- 2026-09-09 claimed: the user saw `task_wait` still registered and asked why the D-158 principle stopped at agents; recommended and accepted — remove the waiting tool, wake the model on every background exit, `notify: false` as the fire-and-forget exception.
- 2026-09-09 done: `task_wait` is gone from the module, `BACKGROUND_TOOL_NAMES`, the docs and every model-facing string (a test rejects `wait`, `poll` and `block until` in any tool text). One exit path: `activate` sends the ending with `triggerTurn: task.notify`, so an explicit background task wakes the model exactly as a promoted one did, with status, exit code and the tail of output. `bash` gained `notify` (default true, meaningful only with `background`), and the start result says either "Do not wait for task … when it exits, its status, exit code and the last lines of its output will be sent to you as a message" or, with `notify: false`, that its ending is recorded and shown with the next turn. The wording mirrors `start_agent`'s `startedGuidance`. `task_list` shows `notify`.
- 2026-09-09 verified in the browser on 41497 with a new sandbox scene (`background` makes the stub call `bash` with `background: true`): the transcript shows the run row, "Started the command in the background. Carrying on with other work.", the exit row "Background task … exited with code 0", and then the woken model's own reply reading the output — three turns, the fleet's Finished fold holding the command. A first attempt looped because the stub recognised its own exit message as a new "background" request; that is a stub ordering fixed in `scripts/sandbox.mjs`, and a reminder that the wake message names the task, so a real model reads it as a report, not a request. `SANDBOX_TRACE=1` now logs what the stub receives.

#### M13-T56 notes
- 2026-09-09 found while verifying the agents work in the browser: an uncaught React #520, "Cannot update a resource while rendering a different resource", on the **first prompt of a fresh session**. Reproduced on a clean state directory and a clean browser origin; the app keeps working and the turn completes, but the error reaches the console.
- 2026-09-09 it is **not an agents bug and not ours**. It reproduces on a plain sandbox with no agents scene and the prompt "hello there", and the captured cause chain is entirely inside the library: `RemoteThreadListHookInstanceManager._setRunning` → `_notifySubscribers` → a React `dispatch`. `_setRunning` is called synchronously from `_trackRunning`, which `_publishThreadRuntime` calls, which is the `publish` callback of a `useResources` resource — so the running flag is set, and its subscribers notified, during a render. React 19 refuses that. `@assistant-ui/core` 0.3.17 under `@assistant-ui/react` 0.15.18.
- 2026-09-09 recorded in `docs/upstream.md` rather than worked around: the fix belongs in the library (defer the `_setRunning` notification out of the render phase), and reaching into a dependency's internals to silence a console error would be the worse trade. Blocked on an upstream fix or a pinned patch.
- 2026-09-09 this task was first recorded under M13-T37, an id the tool-use research pass already held (claimed 2026-09-08); renumbered to M13-T56 here. The pinned patch's comment still says M13-T37 because the lockfile hashes the patch text; it is corrected at the next patch change.

#### M13-T11 notes
- 2026-09-09 claimed. The panel removal already took the biggest pieces — `packages/host/src/subagents/**` and the `plan`/`missions` commands — but the plumbing that fed them is still here, and it is wider than the row suggested: a `--subagents-temp-root` flag, a `LASERCODE_SUBAGENTS_TEMP_ROOT` env generated from `scripts/identity/identity.mjs`, a `PI_SUBAGENTS_TEMP_ROOT` handed to the worker, a `<state>/subagents` directory, a `doctor` check that scans `/tmp/pi-subagents-uid-N`, the desktop's agent-home env list, the sandbox's wiring, and a `pi-subagents` row still offered in the features catalogue. 31 references to `subagentsTempRoot` alone.
- 2026-09-09 the point is not tidiness: `doctor` currently inspects a file layer nothing writes to, so anyone debugging a delegation problem is sent to look at the wrong mechanism.
- 2026-09-09 done. Gone: the `--subagents-temp-root` flag, `LASERCODE_SUBAGENTS_TEMP_ROOT` (dropped from `scripts/identity/identity.mjs` and regenerated, never hand-edited), `PI_SUBAGENTS_TEMP_ROOT`, `LaserPaths.subagentsTempRoot`, the `HostRecord` field, the worker spawn arg and driver option, the desktop's env-strip entry, the sandbox wiring, `doctor`'s `checkSubagentRoots` and its JSON `paths` field, and the `pi-subagents` row in the features catalogue (D-140: our harness owns delegation, and offering it would put a second contradictory model in front of a person). An old `host.json` still carrying the field parses fine — it is simply ignored.
- 2026-09-09 kept on purpose, each checked: the architecture invariant and the seam tests that name pi-subagents (they are about the boundary, not the package); comments citing it as prior art for techniques we kept; the test asserting it is *not* bundled; and the ledger and `docs/agents-leap/**`, which are history. `REVIEWED_INSTALL_SCRIPTS` is now empty but the mechanism stays — it is general npm-script policy, not this package's plumbing.
- 2026-09-09 left as a follow-up rather than done quietly: `lasercode/subagents/event` is dead — nothing emits it — but the type is in `packages/protocol/src/pi-extension.ts`, it is handled in the log store, and it has a log section in the UI. A protocol message is a release-gated inventory, so removing it is its own task (M13-T38).

#### M13-T12 notes
- 2026-09-09 claimed. The finding, from lane W during M13-T3: `resourceLoader.reload()` re-reads settings and drops `applyOverrides` values during service creation. If that holds, a project's `.laser` configuration applies when the session opens and then silently reverts partway through — a setting that works and then stops is worse than one that never worked.
- 2026-09-09 the task is to prove it either way against the real engine before changing anything, and to fix it only if the overrides genuinely do not survive.
- 2026-09-09 done, and the suspicion understated it: the overrides were not lost partway through a session, they **never took effect for any session**. `applyOverrides` merges onto the currently computed settings and keeps no record; `createAgentSessionServices()` calls `resourceLoader.reload()`, which calls `settingsManager.reload()`, which recomputes from the two files — so the override was gone before the session existed. Proved against the pinned engine before anything was changed: `defaultThinkingLevel=high` before service creation, `undefined` after, on the same manager instance.
- 2026-09-09 the louder half: the same block carries `packages: []`, which is how engine package discovery is switched off. With the override dropped, a probe with a package named in the global settings made the engine run a real `npm install` during service creation and crash the process on failure — in a product whose boundary says package installation is not a capability (6b). This was the real cost of the bug, not the settings values.
- 2026-09-09 the `.pi` question, asked because a reload re-enabling discovery would have been worse: no second bug. `reload()` preserves `projectTrusted`, the manager is created with `projectTrusted: false` and no `resolveProjectTrust`, and a probe with a `.pi/settings.json` present leaves trust false and project settings empty after service creation. Pinned by a test.
- 2026-09-09 the fix is `packages/worker/src/settings-overrides.ts`: the engine offers no re-apply hook and `SettingsManager` has a private constructor, so the overrides are made durable by recording them on the instance we own and wrapping the two methods that drop them. Nothing is written to disk and no engine file is touched. Both callers use it — the driver and `SettingsAdapter`, whose manager is handed to the package adapter where a reload would otherwise have dropped the switches.
- 2026-09-09 the tests pin the engine's behaviour as well as ours, so an engine bump that fixes this upstream turns them red and the wrapper can be retired rather than rotting. 11 cases; 6 fail with the wrapper stubbed out. Consequence for people: a `.laser/settings.json` now actually reaches the engine, so values that were silently inert start taking effect.

#### M13-T38 notes
- 2026-09-09 found while removing the pi-subagents plumbing: nothing emits `lasercode/subagents/event` any more, but the type still exists in `packages/protocol/src/pi-extension.ts`, the host's log store still handles it, and the logs UI still offers a `subagents` section for it. Removing a protocol message means the schema sample and the method inventory, which are release gates, so it is its own task rather than a quiet deletion inside another one.
- 2026-09-09 claimed: remove the union member, the logstore case and the doc sentence; make the inventory tests agree.
- 2026-09-09 done: the union member, the logstore case and its `describeSubagentEvent` helper are gone; `docs/pi-extension-modules.md` keeps one historical sentence. No test named the message and `PiExtensionMessage` has no zod schema, so there was no inventory to reconcile. Seen on the way: the `subagents` log section has no writer left in the host (M13-T59).

#### M13-T39 notes
- 2026-09-09 the user's rule: a person configuring this product should never meet another product's name. Their question was whether the engine's `PI_CODING_AGENT_DIR` / `PI_CODING_AGENT_SESSION_DIR` were in the resolution order.
- 2026-09-09 **they were not, and I had said they were.** `resolvePaths` reads the flags and this product's own `LASERCODE_*` names only; `config.ts` already documented that they are deliberately not read. What existed was a false claim in `--help` — two rows advertising them as fallbacks "used when `LASERCODE_AGENT_DIR` is unset" — and the same invented step in `packages/cli/README.md`'s resolution table. So the defect was documentation promising behaviour the code does not have, which is worse than the behaviour itself would have been.
- 2026-09-09 done: both help rows and the "set internally" block are gone from `--help`, the README tables now match the code, and the root README describes `laser pi` without naming the engine's variables. `piEnv()` still *writes* them when spawning the engine — that is the engine's own input contract and removing it would break the guarantee that a terminal session shows up in the app.
- 2026-09-09 a test now walks every help topic and fails if either name appears, and asserts that paths resolve away from them however they are set in the environment — so neither the claim nor a real fallback can be introduced later. `laser help env` now lists four `LASERCODE_*` names and `NO_COLOR` and nothing else.

#### M13-T40 notes
- 2026-09-09 the user: a read-only child — a reviewer, a search, an explanation — has no use for a worktree, so the parent should be able to say so on `start_agent`. Their words: "sometimes the subagent just has a read-only task, so it doesn't make any sense to create a worktree for a review subagent".
- 2026-09-09 asked before building, because it changes what the flag *means*: should a child without a worktree be stopped from writing, or trusted not to? They chose **trust the parent** — every tool, nothing refused, the judgement is the parent's. And `worktree`, defaulting to `true`, so an agent that says nothing keeps today's behaviour. Recorded because the alternative (taking away `write` and `edit`) would have been a tool restriction, and D-144 removed those on purpose.
- 2026-09-09 the one thing the child is owed under "trust the parent" is knowing: its role block says it is working in its parent's checkout and is not isolated, only when that is true. A judgement it was never told to make is not a judgement.
- 2026-09-09 the user added: the tool's result must say where the child is working. Always present, both ways — the worktree's path when isolated, the parent's checkout when not — plus the branch when there is one, so a person can find the work afterwards. A fact about the work, not a fifth identity.
- 2026-09-09 folded in after M13-T41 was dropped: in a project with no git, the harness accepts only `worktree: false`. A request for isolation is refused with a message that names **both** ways forward — initialise git, or start the child without a worktree — so the parent can act on it instead of giving up. Today's message (`worktrees.ts:88`, and `:94` for a repository with no commits) names only the first.
- 2026-09-09 done. `worktree` absent means true, so nothing existing changed; `false` skips creation, uses the parent's cwd, records no worktree and reports `worktree: null`. `recoverAgent` derives isolation from the record, so a reloaded child keeps the right role block. The result carries `cwd` always and `branch` only when there is one — a parent that had to guess which field to read would have learned nothing.
- 2026-09-09 the child is told, and only when it is true: "You are working in <cwd>, your parent's own checkout, not a worktree of your own: you are not isolated from it. Your parent and any other agent in that checkout see every change you make there at once, so change only what your task actually asks for, and say in your final message anything you left behind."
- 2026-09-09 a real-engine golden test proves the uninsulated path end to end: no `.worktrees/` created, `git status --porcelain` empty, the child's session header at the project directory, no worktree in the record, and `working_directory` with no branch in the parent's transcript.
- 2026-09-09 folded in by the coordinator afterwards: both worktree refusals now name **both** ways forward — initialise git, or start the child with `worktree: false` — instead of only the first; `AGENTS.md`'s invariant rewritten; and the false claims the lane listed corrected in `features.ts`, `product-boundary.md`, `ux-fleet.md` and `pi-extension-modules.md`. The lane had cited this decision as D-152 in `docs/agents.md`; corrected to D-156.
- 2026-09-09 `AgentRun.cwd` is optional on purpose: a run persisted before this change has no recorded directory, and every reader shows nothing rather than guessing.

#### M13-T41 notes
- 2026-09-09 the user: a branch whenever the project has git; when it does not, still a directory under `.worktrees/` following the same naming, without a branch. Today that case is refused outright, so a project that is not a git repository cannot start an isolated child at all.
- 2026-09-09 asked what is in the directory, because an empty one would fail differently rather than work: they chose **a copy of the project**. So isolation without git is a copy the parent can diff afterwards, and the absence of a branch is the signal that it cannot be merged with git.
- 2026-09-09 blocked behind M13-T40, which is editing the same files. The risks are written into the brief: never copy `.worktrees` into itself, do not follow symlinks, honour `.gitignore` when there is one, bound the copy with a refusal that names a way out, preserve modes, and delete only through `assertSafeWorktreePath`.
- 2026-09-09 **dropped by the user before any work started.** Their words: "I think this is overcomplicating things." A copy would have brought a size limit, an exclusion list, symlink handling, mode preservation and a merge story with no `git merge` in it — a lot of machinery for a case that has a one-word fix.
- 2026-09-09 what replaces it: in a project with no git, `start_agent` accepts only `worktree: false`. `worktree: true` — including the default, since the default is true — is refused with an error saying git is not initialised, and the parent decides from there. That keeps the refusal that exists today and makes it actionable rather than terminal, which is all the case needed.
- 2026-09-09 the only code change left is the message: today's refusal says "Initialise git in the project first", which is now one of two ways out. It must also name starting the child with `worktree: false`. Folded into M13-T40 rather than kept as a task of its own.

#### M13-T42 notes
- 2026-09-09 the user: merging a child's worktree into the main tree, and deleting it, is the parent's responsibility — and **both** agents must be told so, "to avoid any of them misbehave".
- 2026-09-09 checked before scoping, and the mechanism is already most of the way there: a worktree is not removed when a run ends. It is removed only on a failed start (a rollback of something never handed over — keep) and when a person deletes the child session (a person's explicit act — keep). So this is mostly about giving the parent a verb and telling both agents whose job it is.
- 2026-09-09 no merge tool: the parent has `bash` and merging is `git merge`, and a tool would have to invent conflict semantics where a person's judgement belongs. What the parent needs is the branch and the path, which `start_agent` already returns after M13-T40.
- 2026-09-09 the cost of the decision, which the request does not cover and which the brief makes someone answer: if only the parent can clean up, a parent that crashes or is cancelled leaks the directory for ever and `.worktrees/` grows without bound. A person must be able to clear a leftover without deleting the session, and no removal may drop unmerged commits without saying so.
- 2026-09-09 the user added: deleting a child session must ask what to do with its worktree — preserved or deleted — rather than deciding for them. Today it is silent and destructive: `pi/session/delete` removes the worktree unconditionally, so a person loses the child's work without being told it existed. The existing "Delete “{title}”?" dialog is extended rather than a second one built, it names the branch and path and says how many commits are unmerged, and `pi/session/delete` gains an explicit keep-or-delete whose **default is keep** — reversing today's behaviour, because losing work because a field was omitted is the failure this task exists to prevent.
- 2026-09-09 checkpoint (the lane was stopped before it could report; verified from the tree, all tests green): `remove_agent_worktree` exists, addressed by `sessionId`/`runId` — no fifth identity. It refuses while the run is going, when there is no worktree, when the path is not one the harness made, and — the one that matters — when the branch still holds unmerged commits or uncommitted files, naming exactly what and how to merge it (`git merge <branch>` from the parent's checkout after reviewing it in the worktree). `force: true` overrides and the result then says what was discarded. After removal every run of that session and the session's record carry `removedAt`, so the registry never holds a path that no longer exists.
- 2026-09-09 both prompts tell whose job it is: the parent, in `start_agent`'s description, its result and its guidelines ("a worktree start_agent created is yours afterwards: review the branch, merge it yourself with git, then call remove_agent_worktree"); the child, in its role block. A child started with `worktree: false` is told it has neither a branch nor a worktree because its changes are already in its parent's files.
- 2026-09-09 the escape hatch: `RemoveWorktreeDialog` in the fleet clears a leftover directory and branch without deleting the session, reading what it holds from the host every time it opens because a stale count is worse than none. Deleting a child session now asks: `pi/session/delete { worktree }` with **`keep` as the default** — the router reads the decision before the transcript is unlinked, and a missing field keeps the work.
- 2026-09-09 open at integration: the lane's browser check and its `docs/agents.md` section never happened (the docs are folded into M13-T45, which owns that file now); the ledger flips to done after the full gate and a browser pass over the fleet's remove and the delete dialog.
- 2026-09-09 browser pass on 41495: Archived → row menu → Delete permanently on the child opened the dialog naming its branch and path, "Nothing in it is unmerged, so deleting it loses no work", Keep the worktree pre-chosen, Delete it too as the other choice; the fleet's expanded row offered Remove worktree… and its dialog read the same facts; confirming removed the directory and the branch (`git worktree list` shows only main).
- 2026-09-09 bug found by that pass and fixed: the host's `agents/worktree/remove` and the delete-with-`worktree: delete` path took the directory away but never stamped `removedAt` on the runs that owned it, so the fleet kept showing the path and offering Remove a second time. `AgentRunRegistry.worktreeRemoved(path)` now stamps every owning run once, persists and publishes `agents/run`; both router paths call it. Tests: `runs.test.ts` (stamps once, tells the server), `router.test.ts` (remove and delete both stamp).
- 2026-09-09 done.

#### M13-T43 notes
- 2026-09-09 the user: the session is not named until the first message is answered, and a first turn can take minutes. Cause traced: `server.ts:197` starts naming after `await driver.prompt()`, and the engine's `AgentSession.prompt()` ends with `await this._runAgentPrompt(messages)` — it awaits the entire turn, not acceptance. Naming needs only the prompt text, which is in hand before the call; the fix is to start it there and judge acceptance up front from `isStreaming`, the same condition the driver uses.
- 2026-09-09 done. The cause held exactly: `driver.prompt()` awaits the engine's whole turn, and naming was chained after it. Now `promptLive` reads the driver's own not-streaming guard, starts `nameSession` (`server.ts:917`), and only then calls `prompt` (`:918`). A first prompt that arrives before a Namer model exists is held (`unnamed`, capped) and named the moment `agents/sync` or qualification lands. Browser, `SANDBOX_ACTIVITY=1` 30 s turn: the sidebar shows the name at ~3 s while the command is at 0.3–0.6 s, at 1440×900 and 390×844 in both themes.

#### M13-T44 notes
- 2026-09-09 the user: "View API request" on a message is empty until the message is answered. Cause traced: `Thread.tsx:156` refreshes entries only when the turn is **not** running, so mid-turn `entryId` is undefined for the newest message. With no `entryId` the dialog skips the exact `promptEntryId` query and falls to a time window that filters out every entry carrying a `promptEntryId` — precisely the one it wants. The request itself is captured and sent at `before_provider_request`, so the data was there all along.
- 2026-09-09 wider than reported: the same missing `entryId` disables fork, jump, edit and the version picker on the newest message for the whole turn.
- 2026-09-09 the obvious fix — return the entry id from `session/prompt` — cannot work, because `prompt()` does not resolve until the turn ends. The lane is to find an exact early signal the worker already sees and forward it in the update stream, falling back to a refresh at turn start only if none exists. The dialog's fallback filter is not to be loosened: it is correct, and making it lie would trade one wrong answer for another.
- 2026-09-09 done, by a better route than the one recommended: rather than returning the entry id from `session/prompt`, the user `message_start` update now carries `entry: { id, parentId }` the moment the engine writes it — before the provider request goes out — so it also covers steered and queued prompts, and `messages.tsx` prefers that `persistedEntryId` over the tree lookup. The API request dialog therefore takes its exact `promptEntryId` path mid-turn instead of the time-window fallback that filtered out the very entry it wanted.
- 2026-09-09 scope, stated plainly: "View API request" now works the instant the prompt is taken. Edit, Fork and Jump are *offered and wired* mid-turn but stay `disabled={busy}` by pre-existing design — the engine refuses to move the leaf while streaming — and act the moment the turn ends without a re-read. `data-optimistic` moved from the bubble to the message root, which is the contract find and the tests key off. On the phone, Enter in the composer is a newline and the Send button sends; that is the touch convention, left as is.

#### M13-T45 notes
- 2026-09-09 the user: drop `wait_for_agents`; tell the parent in `start_agent`'s result not to wait because the child's ending is delivered; add `inspect_agent` for one child in more depth than `list_agents`. Then: the response statuses must cover what a child actually needs — a child waiting on its parent's input, and the like.
- 2026-09-09 verified before scoping: a child's ending already reaches the parent as a steer that triggers a turn, so the waiting tool is redundant rather than merely unwanted. `AgentRunStatus` has no value for a child that is still running but cannot proceed without someone — `blocked` is an *ending*. That gap is the substance of the status work; the brief makes the lane find every way a child can stall on a person or a parent and give each an honest, live, attention-toned status with every reader tested.
- 2026-09-09 launched alongside the M13-T43/T44 continuation; disjoint files, `schemas.ts` shared under targeted edits.
- 2026-09-09 done. `wait_for_agents` and the harness's `waiters` are gone; nothing references them. `start_agent`'s result carries `guidance`: "Do not wait for <name>. Carry on with your own work; when it ends, its result will be sent to you as a message. Use inspect_agent with runId <runId> to check on it meanwhile — a status of needs_input means it is paused on a question you can answer with send_agent_message."
- 2026-09-09 `inspect_agent` — one child by `runId`/`sessionId`, read-only, never wakes it: the whole task, where it works and whether the worktree still exists, activity, the last N assistant messages excerpted (default 1, cap 10), the open question if any, and its own children. A live child is read through the driver, an ended one from its file (`worker/src/agents/inspect.ts`).
- 2026-09-09 the user's addition, `needs_input`: a new **top-level** run status — the child raised a question through the portable UI surface (`select`/`confirm`/`input`/`editor`, including a tool that asks) and its loop is paused. Live and attention-toned, never terminal; the question rides on `AgentRun.question`. The parent is woken with an `agent.needs_input` event and answers through `send_agent_message`, typed per question kind and refused on a mismatch; a person can still answer inline in the child's chat; first answer wins. Argued as a top-level status rather than a sub-state because every reader switches on `status`, `blocked` already occupies that tier for the ended shape, and the parent must tell "working" from "stuck" from one field.
- 2026-09-09 every reader learned the value: sidebar chip and folds ("Asking", counted as needs-you), fleet ("Asking · <question>"), map node and inspector ("Waiting on an answer", with the choices), agent-event card ("is asking a question"), `laser runs` (`asking`, yellow); tests on each.
- 2026-09-09 evidence: a real-engine golden test — a `select` raised through the child's real UI bridge inside a running `bash`; the parent is woken, calls `inspect_agent`, answers via `send_agent_message`, and the dialog resolves. Worker 264, pi-extension 102, protocol 34, host 189, cli 57, ui 805; build and identity green; browser at both widths and themes.
- 2026-09-09 honest gap: no shipped feature raises a UI question today, so the sandbox cannot reach `needs_input` on its own; the browser pass used a scratchpad-only preload that raises a real `select`. Worth a sandbox scene (recorded as a follow-up in the notes, not a task, until a feature needs it). `docs/ux-fleet.md` still does not describe T42/T45 — folded into integration.

#### M13-T46 notes
- 2026-09-09 the user, after M13-T44 surfaced that Edit/Fork/Jump are offered but disabled during a turn: enable them. All three move the session's leaf and the engine refuses that while streaming, so "enabled" means the action stops the running turn first and then proceeds — the same stop the Stop button gives, done for the person because they asked for something that cannot happen otherwise. No confirmation; nothing is lost, the abandoned turn stays on its branch. The stop is recorded honestly on that branch, not suppressed.
- 2026-09-09 the brief makes the lane establish against the real engine what `navigateTree` and `fork` do mid-stream before designing, because `fork` replaces the driver's runtime and a fork must never leave a turn streaming into a session nothing is attached to.
- 2026-09-09 established against the real engine before designing: `navigateTree` while streaming **throws** ("Wait for the current response to finish") — it never waits and never returns `cancelled`; `abort()` settles the turn with exactly the record the Stop button leaves; `runtime.fork()` aborts the original itself before replacing the runtime, so no stream is orphaned — but it validates first, and a session whose *first* reply is still streaming has no file yet (the engine writes it on the first assistant message), so a plain fork is refused while `abort()` then `fork()` works because the aborted reply is what creates the file.
- 2026-09-09 done: `stopFirst` on `pi/session/navigate` and `pi/session/fork`, owned by the driver — one request is stop-then-move, and a failure after the stop leaves the session stopped, unmoved and still served. The UI passes `{ stopFirst: busy }` from Edit, Fork and Jump; "Try again" still waits, since re-running a prompt over its own streaming reply is meaningless. The stopped turn is recorded on the abandoned branch identically to a Stop, checked side by side in the browser.
- 2026-09-09 a race it exposed and fixed: the transcript re-reads the tree on every settle, and a stop inside a move settles mid-request — after a fork it asked the worker for a path it no longer served (a real toast). A `moving` set makes `refreshEntries` skip a session with a move in flight; the move hydrates itself.
- 2026-09-09 evidence: worker 273 (mid-turn suite run three times), ui 836, protocol 34, build and identity green; browser on a 30 s turn at 1440×900 both themes and 390×844 light — 390×844 dark verified structurally only, the shared browser pane was hidden by another lane.
- 2026-09-09 pre-existing, seen while verifying, not touched: after a *jump* onto a prompt the engine's `editorText` does not reach the composer (M13-T52), and a stop during a running tool renders as the engine's own "operation was aborted" error — identical for the Stop button.

#### M13-T47 notes
- 2026-09-09 the user: pressing Beam's + repeatedly made a new empty session each time, where a project's + returns to the one empty session; and every Beam row carried the spark, which belongs to the group alone.
- 2026-09-09 reproduced on a sandbox: three presses, 1 → 2 → 4 sessions. Cause, not a race: Pi writes a session file only on the first message, so an empty chat is an *unwritten* row the host synthesises — and `noteUnwritten` built it without `agent`. `mergeSessions` then kept the catalog row over the open view, so the attribution the worker already knew never reached the launcher, which resolved "no agent" to the default agent and never matched Beam. A project's + wants the default agent, so the same bug was invisible there by accident.
- 2026-09-09 fixed at both ends: the unwritten row carries `state.agent`, and `mergeSessions` lets the open view fill an attribution the catalog lacks. The spark left the rows (`beam-row-mark` gone; the group's `beam-mark` stays, pinned to exactly one). Regression tests in `new-session.test.ts` (three Beam launches, one session, no create) and `router.test.ts` (an unwritten row carries its agent); `sessions-tabs.test.tsx` updated to the new truth.
- 2026-09-09 the attribution fix alone was not enough — the browser still made four. Second cause, also at the source: the attention tracker stamped every empty session `finished_unread` (its row changed because it was created), and the launcher refuses anything that is not `idle`. A session nobody has prompted has nothing that finished and nothing to read, so `decorate` now downgrades that stamp to `idle` for a session with no messages; live states (a dialog, an error, a running turn) are untouched. The launcher also stops letting a stale mark exclude an unstarted row — the hydrated `isUnstartedSession` check is the proof, not the catalog's mood — and only steps aside for a session that genuinely wants a person (`error`, `waiting_for_input`).
- 2026-09-09 verified on a rebuilt sandbox: Beam's + pressed three times → one session; a project's + twice → one; zero `beam-row-mark`s, one `beam-mark` on the group. Attention test added for the empty-vs-written split.
- 2026-09-09 the user asked whether the fix reached the chat's own `+` or only Beam. It is global: every New session button, shortcut and the thread-list adapter share one launcher (`runtime/new-session.ts`), and both causes were fixed at their source — the host no longer stamps an unprompted session `finished_unread` (`attention.ts`) and the launcher ignores that stamp anyway; the lost `agent` attribution was the Beam-only half. Pinned for the plain chat too: `new-session.test.ts` "reuses an empty project chat the catalog stamps unread" (24 tests). Re-checked in the browser in the M13-T50/T51 pass.

#### M13-T48 notes
- 2026-09-09 the user: the "N finished" count on a session row steals the room the name needs. It also repeats the fold directly beneath, which already says "N finished". `branchChip` now returns nothing when nothing under the row is live; a row still says "needs you", "failed", "running" or "waiting", because those are the states nothing else shows at row level. Two assertions updated to the new truth, with the fold asserted in their place.

#### M13-T49 notes
- 2026-09-09 found with the user: a model listed under a connected provider in Settings was in no picker. Every picker filters `model.enabled` before the provider check, and `enabled` comes from `enabledModels` — a glob allow-list that replaces rather than extends, so a list written before a model existed hides every newer one, and the Settings row for a hidden model looks identical to an enabled one. The filtering is by design (D-145); the silence is the defect.
- 2026-09-09 claimed: the row says it is hidden by the list and offers one click to let that model in without unsetting the list; the allow-list editor says how many models it is hiding; a model whose provider is not connected says that instead.
- 2026-09-09 the user widened it: not a text-only glob filter — a switch on every model row, enable/disable-all per provider, and an All · Enabled · Hidden view dropdown; the glob editor moves under Advanced for the people who want it. The hard part is that `enabledModels` is a pure allow-list, so "turn one model off" cannot be written as a glob without enumerating everything else, which hides every model added later — the very bug being fixed. The brief makes the lane check the engine for negation and, failing that, add a Laser-owned disable list applied in the worker (Laser owns its settings schema, 6b). Appended as an addendum to the running lane; if its report does not cover it, it becomes a continuation.
- 2026-09-09 first half done: `modelOfferState` names three row states — offered, provider not signed in, hidden by Enabled models — with the provider check first so the list is never blamed for a missing key; a hidden row offers one click that **appends** `provider/id` to the list at the scope the list lives in and never unsets it; the editor shows how many models the list hides. Proved end to end: a picker search for "4.1" returned nothing, one click in Settings, and the picker listed GPT-4.1. 9 tab tests, 835 UI tests, browser at both widths and themes.
- 2026-09-09 the addendum — switches, per-provider enable-all, the view dropdown, and the negation question — was not reached; relaunched as a continuation with what landed spelled out. Also carried into it: the multi-picker and "Offer every model" still write `global` regardless of scope.
- 2026-09-09 addendum done. The negation question, proved against the pinned engine's own matcher (`model-offer.test.ts`, three cases): `enabledModels` has no usable negation — a `!` pattern without a glob goes down the exact-reference path and matches nothing, and a glob `!` is honoured by minimatch but the matcher only ever adds, so `["*", "!openai/gpt-5"]` returns everything. Hence a Laser-owned `disabledModels` list (D-161): exact refs, global or project `.laser`, applied in the worker where the catalogue's `enabled` is computed and in a session's own model list, read fresh from the files. It never reaches the engine as an override (`engineSettingsOnly`). Pinned: a model added to the catalogue after a person switched a different one off stays on.
- 2026-09-09 the tab: a switch on every row (off writes only the disable list, never an enumerated allow-list; on removes from the disable list and appends to the allow-list only when a pattern hid it), per-provider Enable all / Disable all with "N of M on", a View menu All · Enabled · Hidden with counts replacing the checkbox, the glob editor under Advanced · Allow-list patterns. The multi-picker and "Offer every model" now write at the scope the list lives in. The session's model picker forgets its list on close so a switch shows on the next open without a reload.
- 2026-09-09 seen and not fixed, worth a row: `pi/settings/set` does not reload a live session's `SettingsManager`; the worker reads the two lists from the files in `listModels()` instead (M13-T55).

#### M13-T50 notes
- 2026-09-09 the user: the map is a toggle whose only way back is the same top-right icon. Selecting a session in the sidebar must show that session's chat (closing the map), and the logo must always return to the last opened session from anywhere — map, fullscreen, Settings, Logs, the Agents page. Today the logo only calls `workbench.close`.
- 2026-09-09 done: `useChatNavigation` (`components/shell/chat-navigation.tsx`) gives the shell two verbs. `showChat` closes whatever covers the transcript — the map, the fullscreen map, the fleet sheet, the compact sheets, the workbench (Settings, Logs). `returnToChat` is `showChat` and then: the current session stays; with none, the session remembered for the project (the runtime's own `SESSION_STORAGE_KEY`, only if still in the catalog) is opened; else the new-session state. It never creates a session. The logo in the rail is `returnToChat` ("Back to your chat"); every row in the sessions sidebar, the list's `+`, the header `+`, Cmd+N and search selection go through `showChat`, so choosing a session always lands on its chat. `WorkbenchProvider` moved up to `Shell()` so the frame's verbs can close it. The sidebar's `onOpen` is one ref-backed callback because `thread-list.aui.tsx` caches the row component by callback presence.
- 2026-09-09 verified in the browser: map → another session → its chat; map, fullscreen map and Settings → logo → chat; phone sheet → pick a session with the map open → map and sheet close. Phones have no rail, so the sidebar is their way back. Keyboard activation was proved as a focusable native button (the browser tool's synthetic Enter does not activate any native button, including untouched ones).
- 2026-09-09 coordinator's browser check on 41495, light and dark at 1440×900: map → logo → chat, Settings → logo → chat, both with the session kept. Chat's own `+` pressed four times on an empty session: still one session (M13-T47 is global).

#### M13-T51 notes
- 2026-09-09 the user: the fleet is per project today (one group per top-level session with work, the current first) and should be per session — the open session's children, their children, and their background commands. Another session's tree is reached by navigating there. This supersedes D-147's "everything at once" rationale; the header counts and the top-bar badge become the open session's, and the deleted-root orphan case has to be decided rather than dropped.
- 2026-09-09 done: `scopeFleet(groups, root)` in `fleet/model.ts` splits all work into the tree under one root and everything `elsewhere`; `useFleet` (`fleet/hooks.ts`) resolves the root of the session being read — `state.agent.rootPath`, else the ancestry index — so the fleet column and sheet render one tree. Reading a child shows the root's tree with the child's row marked "reading" and no Open chat for it ("This is the chat you are reading"). Two designed empty states: no session open, and nothing running here (with the line that another session's work is in that session's fleet). The top bar badge and its tooltip follow the tree. The clock ticks only while something shown is live.
- 2026-09-09 the orphan question, decided in the lane and recorded as D-160: a root deleted from a *loaded* catalog is a named line at the bottom of every fleet (`SubagentStrays`: "N pieces of work from a deleted session", whether it is still costing, collapsible into the same rows, Stop and Open chat offered, its own Clear). Named by the session's name, then its first user line, then "Unnamed session" — never a file name. `FleetGroup.orphaned` ("session closed") is still computed but no longer rendered. Also fixed on the way: the In-progress header icon used `text-accent`, which resolves to a surface token and was invisible — now `text-live`.
- 2026-09-09 verified in the browser with two sessions delegating: only the open session's tree; switching switches it; the child opened from the fleet shows the root's tree with the child marked; deleting one root's file on disk produced the bottom line with Stop offered; phone sheet wraps the strays line (`line-clamp-2`, no tooltip on touch). Seen once and not chased: a black screen `useClientLookup: key … not found` right after creating a session from the project screen, recovered by reload — logged under M13-T53. The CLI's printed app URL says 41441 regardless of the port in `host.json` — M13-T54.
- 2026-09-09 coordinator's browser check on 41495: after `delegate`, the fleet column showed the session's tree only; opening the finished child from the sidebar fold kept the parent's tree with the child's row marked READING and no Open chat for it. Phone sheet at 390×844: the same tree, no horizontal overflow, description "The agents and background commands of the session you are reading."

#### M13-T52 notes
- 2026-09-09 found while verifying M13-T46: `navigateTree` returns `editorText` when its target is a user message — the engine's own answer to "what was in that message" — but after a jump in the sandbox nothing appeared in the composer. Same path as before that task; the hand-back is either dropped by the worker's `pi/session/navigate` result or ignored by the UI's `jump`. Not yet diagnosed.
- 2026-09-09 diagnosed: neither. The worker returned it and `jump` dispatched `pi/ui/event setEditorText`; the store parked it as `view.editorText` (`store.ts`) — and no component ever read that field. The consumer had never been written.
- 2026-09-09 done: `useHandedBackText` in `Composer.tsx` — an effect on `view.editorText` that sets the composer's text when the composer is empty, then dispatches `editorTextTaken` so the view forgets it (taken once; a reload or re-render cannot apply it twice, and it never overwrites something the person has since typed). Exposed as `actions.takeEditorText`. Test `test/thread/handed-back-text.test.tsx` over the real provider with the fake host publishing the event.
- 2026-09-09 coordinator's browser check on 41495: More → "Jump to this entry" on the first prompt left the transcript at the new-session state and the composer holding `delegate`.

#### M13-T55 notes
- 2026-09-09 claimed: reload a live session's engine settings after a settings write, through the durable-override seam
- 2026-09-09 proved with the real engine: a global write of `compaction.enabled=false` landed in the file and the snapshot, while the open session's own `SettingsManager` and `state().autoCompactionEnabled` still said true — each session's manager is a separate instance nobody reloaded.
- 2026-09-09 done: `SessionDriver.reloadSettings?()` (optional, so `ChordDriver` and the fakes compile untouched). The stable driver re-reads `.laser` into the durable set (replaces, never stacks), calls the manager's own `reload()` under `applyDurableOverrides` so the overrides survive, syncs steering and follow-up modes the way `AgentSession.reload()` does, and pushes a `state` update so the UI refreshes. Not `AgentSession.reload()`: that fires `session_shutdown`/`session_start` through every extension and runs the companion's disposers. Mid-turn the reload is owed, not run — a turn finishes under the settings it started with, and the reload lands at the next `agent_settled` or `compaction_end`. `pi/settings/set` reloads every open session for a global write and only sessions in the worker's cwd for a project write (a worktree child reads its own `.laser`); a throwing reload is logged and never fails the write.
- 2026-09-09 the `listModels()` file read stays: `disabledModels` is a product key `engineSettingsOnly` strips before the engine sees it, so the session's manager can never answer it, and the read also covers a hand edit. Known gap left alone: an engine write that bypasses the adapter (a session's own `setModel` persisting `defaultModel`) still does not reload sibling sessions.

#### M13-T54 notes
- 2026-09-09 claimed: print and open the app URL from the host record, not the configured default
- 2026-09-09 done: `hostUrl` formats the *configured* port, but every command connects through the host record in `<state-dir>/host.json`; `new` and `open` were the two sites that printed and opened a URL from the configured port after connecting through the record. `appAddress` / `appUrl` beside `hostUrl` now answer "the running app's address": a live record (process alive, identity not contradicted) wins, else the configured port; read-only, never clears a stale record. `status` and `connect()` build their socket URL with `wsUrl(record)`. Help and README state the rule: `--port` is where a host starts and where to look with no record; a running host's record is the address every command reaches and prints — which is what `status` already did, so a live record beats `--port` for printing too.
- 2026-09-09 two stale strings the lane noticed, fixed at integration: `rpc.ts` pointed at `<agent-dir>/<product>/host.log` for the host log (it is `<state-dir>/host.log`); the host help topic's state-directory sentence is checked against `config.ts`'s documented resolution.

#### M13-T53 notes
- 2026-09-09 claimed: reproduce the thread-list key loss when a session arrives from outside while the app sits on the project screen, then fix it in the adapter
- 2026-09-09 reproduced deterministically: with the app on the project screen, `laser new` files an unwritten session; the person presses a suggestion card; `initialize()` reuses that unstarted session (the launcher's rule) and selects it mid-initialize; the runtime moves its main thread onto the listed row; then the initialize result arrives and assistant-ui adopts the path into its "new" thread and deletes the listed row as an orphan while the main thread still points at it — every render throws `useClientLookup: key … not found`. A row merely arriving, or a deep link alone, never crashes; a sidebar click or deep link landing during a send does.
- 2026-09-09 fixed in two layers. Ours: `initialize` never selects from inside itself (`createSession` is quiet), the bracket closes on the next macrotask so it is strictly after the runtime applied the result, and the controlled `threadId` is held while initializing (`useHeldWhile`), in the main runtime and Beam's scoped one. The library's: its `initialize().then` deleted the orphan without re-pointing `_mainThreadId` (its own `_replaceWithThreads` does), which a switch the runtime makes on its own still hit — a second hunk in the pinned patch ("Vendor patch (M13-T53)") re-points it and stops the orphan's runtime. The lockfile's patch hash moved with it; `docs/upstream.md` carries both hunks.
- 2026-09-09 `test/runtime/catalog-arrival.test.tsx` runs seven sequences over the real provider and React's own scheduler with an error boundary and `console.error` assertions: three of them failed with the exact message before the fix.

## MX · Cross-cutting

| ID | Task | State | Owner | Evidence | Notes |
| --- | --- | --- | --- | --- | --- |
| MX-T1 | Migration readiness | in-progress | claude-2026-09-05-a | `packages/worker/src/drivers/chord.ts`; seam test green (M0-T5) | ongoing: log each Pi release in `docs/pi-releases.md` |
| MX-T2 | Pi pin bumps | todo | — | — | current pin 0.85.0 |
| MX-T3 | Upstream log | todo | — | — | `docs/upstream.md` created empty |
| MX-T4 | Security review | todo | — | — | before M6 ships |
| MX-T5 | Accessibility pass | todo | — | — | — |
| MX-T6 | Element inventory reconciliation | done | five lanes + integrator | `pnpm -r build` / `-r typecheck` / `-r test` all exit 0, 686 tests; every row of `docs/ux-elements.md` names either the file that implements it or the reason it does not apply; no element file in `packages/ui/src/components/assistant-ui/elements/` is unimported | Five lanes adopted the catalog; integration wired the twelve elements they had adopted but left unmounted, and deleted eight whose data does not exist rather than leave unmountable files standing in the tree. See the wave-3 notes below |
| MX-T7 | One module defines the product's identity | done | claude-2026-09-05-identity | `product.json` at the repository root; `pnpm identity:generate` rewrites 14 files; `pnpm identity:check` runs inside `pnpm -r build` and `pnpm -r test`; renaming to `wavelet` and back proved end to end — see notes | The rename is one edit plus one command. A frozen `wireNamespace` is the deliberate exception (D-48) |

#### M4-T8 notes
- 2026-09-06 done: regular and advanced settings now use product-language
  controls; provider/model values are rich selectors with independent Provider
  and Model search. The live catalogue preserves provider sub-tables and shows
  proxy provenance as source provider plus delivering provider.
- 2026-09-06 claimed: replace free-text provider/model values with the shared
  provider-first searchable selector, render effective defaults as selected
  values, and keep both standard and advanced views written for a person.
- 2026-09-06 checkpoint: provider/model fields use shared searchable controls,
  model overrides no longer take free-text keys, effective/default values render
  inside the controls, raw paths are no longer repeated under regular labels,
  and the Tools section is gone.
- 2026-09-06 raised by a product review of a real install. Appearance,
  Extensions, This device and Trust read as product screens; "All settings"
  reads as Pi's `settings.json` with labels: raw key names under every label,
  categories called "Shell and npm" and "Terminal display", free-text
  "Default provider" / "Default model" boxes (placeholder
  `claude-sonnet-4-20250514`) beside pickers that already exist elsewhere, and
  "Enabled models: one glob per line". AGENTS.md says the visible copy never
  requires knowing which agent runs underneath; this tab does.
- 2026-09-06 deliberately not fixed in the review-fix wave: this is a screen to
  redesign, not a string to change, and doing it badly under time pressure is
  worse than the honest row. M4-T2's "no setting missing" still holds; this is
  about how they read.

#### M4-T7 notes
- 2026-09-05 lane-E: two screens, and the boundary between them is the point. **Trust** (`TrustTab.tsx`) lists every project with what in it is trust-gated and a Trust/Decline control; it writes through `actions.answerTrust` → `pi/project/trust` → laser's own project registry. It does **not** write Pi's `trust.json`: `packages/host/src/trust.ts` reads that file and says in its own header why it never writes it (Pi's lock protocol, invariant 8). The screen says so rather than implying otherwise.
- 2026-09-05 lane-E: **Keyboard** (`KeyboardTab.tsx`) is a reference for the app's own bindings, generated off the same `modKey()` the palette uses, and states plainly that they are fixed in this version — a rebind control that did nothing would be worse than none (R2). Pi's `keybindings.json` is a different file for a different program (Pi's terminal UI, which this app never runs); surfacing it needs `pi/keybindings/get|set` in the protocol and a worker adapter over Pi's `KeybindingsManager`. That diff is in the lane-E report under REQUESTS; until it lands, M4-T7 stays in-progress.

#### M9-T7 notes
- 2026-09-05 lane-E: `laser relay status|login|pair|devices|revoke`. State is three files in the state directory: `relay.json` (URL, origin, signed device list), `identity.key` (Ed25519 root seed, 0600) and `relay-static.key` (X25519 transport scalar, 0600). `status` and `devices` are strictly read-only — they create no key, so `laser relay` on a machine that has never paired leaves the disk untouched.
- 2026-09-05 lane-E: proven end to end on this machine — `@lasercode/relay` on :8080, `laser relay pair` in a pty, a scripted phone running `PairingInitiator` against the printed link. Both sides derived the same six emoji (🍋🍋🦉🌵🐯🐵), the phone verified the signed device list and its own entry in it, and `relay devices` then listed it. `revoke` re-signs at version+1 and the phone's rollback guard refuses the older list.
- 2026-09-05 lane-E: pairing has no `--yes` and refuses `--json` and a non-TTY. The grant discloses the desktop's static key, its root key and every linked device's name, and `PairingResponder.grant()` will not produce it without `sasConfirmed` — a flag that asserts a person compared the emoji, without a person, is the attack the emoji exist to stop.
- 2026-09-05 lane-E: the QR encoder is in `packages/cli/src/qr.ts`, byte mode, ISO/IEC 18004. During development it was compared module-for-module against `qrcode@1.5.4` at every length from 1 to 2400 bytes at all four EC levels — two table errors were found that way (an extra entry in the L error-correction row, a missing one in the H block row) and neither would have been visible by looking at the output. `test/qr.test.ts` pins a whole 41×41 matrix for a real pairing link.
- 2026-09-05 lane-E: `runDaemon` now builds `HostRelayOptions` from the device list, which closes the gap where `HostServer` accepted a `relay` option that nothing ever supplied. Revocation takes effect on the device's next reconnect within a running host, and immediately after `laser restart`; the command says which.

#### MX-T7 notes
- 2026-09-05 claimed: one file names the product; everything else derives.
- 2026-09-05 **`product.json` at the repository root is the source of truth**, readable by TypeScript, by Node build scripts, by the vite build and by POSIX sh. It carries the name, the display name, the app id, the URL scheme, the env-var prefix, the config/state directory name, the browser-storage prefix, the `Symbol.for` prefix, the binary name, the repository slug, a `formerNames` list, the product copy, the licences, the categories, the keywords and the branding colours. Every value that can be *derived* from those is derived in exactly one place, `scripts/identity/identity.mjs` — the homepage, the issues URL, the AppStream developer id, `<binary>-bin`, `<binary>.desktop`, `<appId>.metainfo.xml`, `<binary>-setup.sh`, the full name of every environment variable, and the shell word list of every data directory the product has ever owned.
- 2026-09-05 **The typed module is `@lasercode/protocol`'s `identity.ts`**, over a generated `product.generated.ts`. Emitted rather than imported so `tsc`, `vite`, `vitest`, Node and the browser all see the same values with no JSON-module resolution and no bundler plugin. `ENV` is emitted as literal types, so `ENV.agentDir` *is* `"LASER_AGENT_DIR"` and a typo is a compile error. `crypto` and `relay` reach it through a new `@lasercode/protocol/identity` subpath, which imports nothing — the relay still links no schema, no validator and no crypto, and `test/purity.test.ts` now asserts that as well as the dependency list.
- 2026-09-05 **Generated, not hand-written**: `install.sh` (from `install.sh.tpl`), `packages/desktop/electron-builder.yml` (from `.yml.tpl`), `.github/workflows/release.yml` (from `.yml.tpl`), `packages/ui/public/manifest.webmanifest` (from `.tpl`), `packages/protocol/src/product.generated.ts`, `scripts/identity/identity.sh` (sourced by every script under `scripts/`), the identity fields of four `package.json` files (`name`, `bin`, `homepage`, `desktopName` — rewritten textually so key order and formatting survive), and four Linux assets into `build/linux/generated/`: the AppStream metainfo, the `.desktop` entry, the tarball's `<binary>-setup.sh` and the launcher `after-pack.cjs` installs. `index.html` is substituted at build time by a new vite plugin, because its boot script must know the theme storage key before any module loads.
- 2026-09-05 **The check is the part that makes it stick.** `scripts/identity/check.mjs` re-renders every generated file and compares it byte for byte, then scans every tracked file for the name in a *value* — string literals in TypeScript, everything but comments in shell and YAML. Comments, Markdown, identifiers (`LaserProvider`, `laserDataDir`), the npm scope `@lasercode/*` and relative import specifiers are exempt and the file says why: they are prose and private symbols with no user-visible effect. It runs as `@lasercode/protocol`'s prebuild (so `pnpm -r build` fails on drift) and inside `packages/protocol/test/identity.test.ts` (so `pnpm -r test` does too). Proven both ways: hand-editing `appId` in the generated YAML fails the build naming the template to edit instead; adding one `"<name>-panels"` literal to a component fails it with the file and line.
- 2026-09-05 **`wireNamespace` is frozen on purpose** (D-48). The relay's WebSocket subprotocol, the Pi event-bus event names, the `<ns>/…` session-message types and the HKDF labels that derive a paired device's channel keys are a wire contract, not a name a person sees. Deriving them from `name` would make two already-paired peers derive different keys and simply fail to connect, and would break every third-party extension that emits a panel. So it is a separate field, `WIRE_NAMESPACE` in TypeScript, and a rename leaves it alone.
- 2026-09-05 **The migration is the part that protects people.** `packages/host/src/identity-migration.ts` runs before any path is resolved in all three entry points (the host, the CLI daemon, the desktop shell): for each directory the product owns — `~/.local/share/<name>` and the platform equivalents, `~/.config/<name>`, the legacy `~/.<name>` — a former name's directory is moved onto the current one and the move is reported once. It never merges (both present → the current one wins and the old one is untouched), never deletes, and falls back to copy-then-remove across filesystems so an interrupted move loses nothing. `packages/ui/src/identity/storage-migration.ts` does the same for `localStorage` on boot and drops app-shell caches from a former name; it never throws, because `localStorage` can throw on *access* in a private window. `packages/desktop/src/keychain.ts` adopts a keychain entry from a former service name before deciding a device has no identity — without it a rename would orphan every paired phone.
- 2026-09-05 **Proved by renaming.** `product.json` edited to `wavelet` / `Wavelet` / `com.kwentra.wavelet` / `wavelet://` / `WAVELET_` / `~/.local/share/wavelet`, with `formerNames: ["piorbit"]`, then `pnpm identity:generate` and a full build. Every one of these followed with no second edit: `appId`, `productName`, `copyright`, the protocol block, `shortcutName`, `executableName`, the deb and rpm `artifactName`s and their fpm metainfo paths, the `.desktop` entry's `Name`/`Exec`/`Icon`/`StartupWMClass`/`MimeType`, the metainfo's filename and `<id>` and `<developer id>`, the web manifest, `index.html`'s title and theme storage key, the service worker's cache prefix, `install.sh`'s `PRODUCT`/`APP_ID`/`URL_SCHEME`/`REPO_DEFAULT` and its `--purge` directory list (which gained the old directories), the release workflow's environment variables and secret name, `scripts/identity/identity.sh`, the CLI's help, usage, examples, error text and shell completions, the host's data directory, and every `WAVELET_*` variable. `pnpm -r build`, `-r typecheck`, `-r test` (781) and `verify-install.sh` (63) all passed under the new name; the directory migration moved a fake install's `~/.local/share/piorbit` and `~/.config/piorbit` across with its settings intact. Then changed back, and the same four commands passed again.
- 2026-09-05 **Found by the proof, not by review**: eight tests asserted the old name in a regular expression or an object key (`/Reinstall laser/`, `LASER_NPM_CLI:` as a key, `laser://session/abc`, `source: "laser"`), the CLI leaked a literal `${PRODUCT_NAME}` into `--help` because a nested double-quoted string inside a template had been rewritten, and `electron-builder.yml`'s comment claiming "the app id never changes" was still there. All fixed; the app-id comment now says it may change exactly once, before anyone installs a build, and why.
- 2026-09-05 done, evidence: `pnpm -r build && pnpm -r typecheck && pnpm -r test` exit 0 with **781 tests**; `bash scripts/release/verify-install.sh` 63 assertions; `pnpm identity:check` clean; `appstreamcli validate` and `desktop-file-validate` pass on the generated assets; the generated `laser-setup.sh` installs and uninstalls a fake tarball end to end.
- 2026-09-06 **A review found the check could not see its own change, and could not see a rename.** Three defects, all reproduced before being fixed (D-50). (1) `packages/protocol/test/identity.test.ts` asserted the schema rejects a non-reverse-DNS app id by passing the literal `"piorbit"` — invisible today because all 22 new files are untracked and the scan reads `git ls-files`, and a build-and-test breaker for everyone the moment they were committed. Proved with a scratch index (`GIT_INDEX_FILE=/tmp/idx git add -A`), fixed by asserting the shape (`"no-dots"`) rather than the word. (2) Every pattern was built over the *current* name only, so a rename to `wavelet` left `copyright: Copyright © piorbit contributors` in the generated YAML and the check said "no stray literals"; it now builds over `[name, ...formerNames]`, and `vendor` is a `{displayName}` template rather than a written name. (3) `.tsx` went through a string-literal-only scan and JSX children are not quoted, so seventeen sentences the app shows — the first-run flow, the sign-in sheet, the trust dialog, the update banner, "piorbit runs one agent per directory" — were blanked before the scan; `.json` was skipped entirely, hiding two `bin` names and three package descriptions. 24 real strays fixed in total. The wire exemption was also anchored: `~/.piorbit/state` used to read as the wire path `piorbit/state` and be stripped, which is the single worst thing a rename can leave behind.
- 2026-09-06 **The migration could be disarmed by one `mkdir`.** `identity-migration.ts` refused to move when the destination *existed*, and `laser doctor` creates `~/.local/share/<name>/state` to check it is writable. One `doctor` run before the app's first start therefore orphaned everything permanently, with a log line about two installs the person does not have. An empty destination is now treated as no destination. Two more: the cross-filesystem fallback copies into `<to>.incoming-<pid>` and renames it into place, so a crash mid-copy leaves nothing the next start would mistake for a finished migration and nothing this process did not create is ever removed; and `packages/cli/src/main.ts` migrates before `run()`, because `doctor` is the fourth entry point and the one a worried person reaches for first.
- 2026-09-06 evidence: `pnpm -r build && pnpm -r typecheck && pnpm -r test` exit 0 with **790 tests**; `bash scripts/release/verify-install.sh` **74** assertions; the rename round trip re-run at `wavelet` with `formerNames: ["piorbit"]` — clean, and three of four planted probes caught (the fourth is the frozen HKDF label shape, see D-50).

#### MX-T6 notes
- 2026-09-05 wave-3 integration (claude-2026-09-05-integrator). `pnpm -r build` / `-r typecheck` / `-r test` all exit 0; 686 tests.
  - **Wired what the lanes adopted but never mounted** (12 of them, none of the cross-lane requests had been applied): `TypingIndicator` and `SpecSheet` into `RunBody`, `NumberTicker` into `AgentStatusValue` for `ticking` values, `WebSearch` into `CollectionBody` (chosen by `panel.source === "pi-web-access"`, the id the extension module sets — never guessed from the payload's shape), `FileTree` and `ToolTimeline` into the telemetry rail (`toolsOpen` added to the shell context beside `historyOpen`).
  - **Deleted eight adopted-but-homeless element files** rather than leave placeholders: `feedback-dialog` (a `decision`'s rejection is one declared field, never a list of canned reasons), `comparison-card` (no shortlist exists; its information went into a new **Cost / M** column on `ModelsTab`'s data table instead), `document-reference` (`@file` mentions need `pi/project/files`; the island owns document chrome), `memory-chips` and `reviewable-diff` (need protocol that does not exist), `research-report` (a second renderer for the `plan` kind, which `agent-plan` already owns), and `voice` + `voice.aui` (a WebGL orb with no measurement behind it; nothing imported either). Each has its reason written into its row of `docs/ux-elements.md`.
  - **Kept ours, with the reason recorded**: `components/ui/skeleton.tsx` is *not* superseded by `GenerationLoader` — a skeleton holds the shape of content whose layout is known, a loader is for a wait with no shape. `TrustDialog` keeps its own body rather than `PermissionGrant`, which autofocuses its *first option* (the granting one) and takes a single-string `message`. `CanvasSplit`/`CanvasSplitThread` are not exported: the shell's split row holds four things, not two.
  - **Three defects found by looking rather than by a failing test.** (1) `.text-sm`, `.font-sans` and `.font-mono` were compiled as literals by `@theme inline`, so Text size, Interface font and Code font were inert — see M11-T8. (2) `globals.css` declared `@font-face` only for Host Grotesk and Martian Mono, so **Inter and JetBrains Mono — the documented defaults, whose `.woff2` files were already in `public/fonts` — never loaded at all**; faces added, and every `font-weight` range corrected to the file's real `fvar` wght axis (read out of the woff2, not guessed: Inter 100–900, JetBrains Mono 400–800, Host Grotesk 300–800, Martian Mono 100–800). (3) `packages/ui/src/components/thread/messages.tsx` contained a **raw NUL byte**: the selector joined `ordinal` and prompt text with a *space* while the parser split on `"\0"`, so `indexOf` returned −1, `promptOrdinal` was `NaN`, and regenerate and fork-with-edit silently did nothing on every assistant message. Both sides now use `\u0000`. Two more files carried raw control bytes (`runtime/threadList.ts`, `panels/store.ts`); those were self-consistent, so only the escaping changed — but all three were invisible to `grep`, which is how the first one survived review.
  - **CLI: an unexplained hang, fixed** (found in the sanity run). `laser settings list` from any directory the host has no trust answer for blocked for two minutes and then returned — the host holds the worker start behind `pi/project/trust_request` and waits for a client to answer, and a terminal cannot: there is no modal, and answering from a flag would be a security decision made by a flag. `connectForProject` (`packages/cli/src/commands/host.ts`) turns that question into an error naming the directory, what in it is trust-gated, and the exact `laser projects trust <dir>` line that answers it; `HostRpc.failPending` rejects what is in flight. `settings` and `packages` use it. Verified end to end against a fresh trust-gated project: error → `projects trust` → the same command succeeds.
  - **Housekeeping**: `@base-ui/react`, `tw-shimmer` and `zustand` removed from `packages/ui/package.json` (all three were referenced only by comments saying they were deliberately unused); `src/lib/range.ts` deleted as a byte-identical copy of `components/assistant-ui/utils/range.ts`; `AnsiText` de-duplicated out of `StreamBody` into `elements/ansi-text.tsx`, which is also what let the logs pane render captured stderr with its escapes decoded instead of as `ESC[31m` noise. `StatusRing` now drops its numeral rather than drawing it under the 12px floor, reading the floor from `--text-floor` through a new `textFloorPx()`.
  - **Not done, and why.** `StoppedRun` and `SpeakerIdentity` are mounted and correct but can never render: no session update carries a stop reason or a child-run speaker, so both need protocol first (`packages/protocol`, schema + round-trip sample, then worker, then the projection). `MessageTiming` does work, on its wall-clock fallback. No screen was seen in a browser this session — the sandbox has no provider credentials, so no transcript, tool row, panel or dock was exercised live; everything visual here is verified by the built CSS and by build/typecheck/test only.
- 2026-09-05 lane C (agent surfaces) checkpoint: adopted `surfaces`, `range`, `agent-status` (island header), `agent-plan` + `todo-list` + `flow-graph` (replaces `PlanBody.tsx`, deleted), `job-progress` + `timeline` + `artifact-card` + `agent-handoff` (inside `RunBody`), `approval-card` + `permission-grant` + `elicitation-form` (`DecisionBody` is now the controller), `background-inbox` (replaces `shell/InboxPanel.tsx`, deleted), `checkpoint-history` (replaces `shell/HistoryTree.tsx`, deleted), `subagent-list` (the fleet list), `canvas-split` (the dock frame). Not installed, reason in each row of `docs/ux-elements.md`: `agent-card`, `score-breakdown` (no protocol data), `activity-graph`/`heat-graph` (no lane-C surface), `flow`/`flow-canvas`/`flow-expand` (404 in the registry). `packages/ui/components.json` added so `npx assistant-ui@latest add` resolves the Radix flavour.

---

#### Wave 2 integration notes (2026-09-05, claude-2026-09-05-integrator)
- Six lanes (panels, desktop, mobile, packages, transcript polish, subagents) were merged into one protocol and one shell. Every REQUEST in the six lane reports was applied, except where two lanes had solved the same thing twice — see D-23, D-24, D-25, D-26 for what was kept and why.
- One protocol vocabulary: `pi/panel/*` (lane P), `pi/push/*` and `pi/transcribe/*` (lanes C and D, reconciled onto the worker-owned dictation service), `pi/project/git` (lane F). Every method has a zod schema and a sample, which the completeness test enforces.
- The push payload moved from `packages/ui/src/pwa/push-payload.ts` into `packages/protocol/src/push.ts`, so the host that sends it and the page that reads it share one definition. The service worker restates the shape because `/sw.js` is emitted as one standalone file; the build refuses to emit a worker whose `DECLARATIVE_WEB_PUSH_VERSION` disagrees with the protocol's.
- Bespoke rendering removed: `HostUiCards.tsx` and `DialogBody.tsx` (dialogs are decision panels everywhere, including inside a tool row), the telemetry rail's extension section (widgets are dock islands, statuses are status-line entries), and `panels/islands/Markdown.tsx` (the preview package is the one document renderer, so `react-markdown` left the dependency list).
- Legibility floor enforced mechanically: `text-2xs` (11px) and `text-[11px]` are gone from every component, `--text-2xs` is now consumed only by the `eyebrow` utility, and the ANSI palette moved into `globals.css` as `--ansi-0…15`. `test/design-system.test.ts` fails the build if either rule is broken again — checked by breaking it on purpose and watching both guards fire.
- Two real defects found in the browser and fixed: the two-column dock rule (D-25) and a run island whose state line ran under its elapsed time in a narrow dock. A third, "the first session click after a reload does nothing", turned out to be a coordinate-scaling artefact of the test harness — but it exposed that `SessionsPanel` swallowed `openSession` failures entirely, so that click now reports, and `HostClient.whenConnected` keeps a click made during the socket's first second from being dropped.
- The sandbox (`scripts/sandbox.mjs`) now records itself the way `laser up` does, so the CLI can be pointed at it, and seeds one panel of every kind. Pre-existing limitation found while doing that: Pi 0.85 builds a session's extension set from its package manager, so the sandbox's demo extension in `<agentDir>/extensions/` was never loaded by any lane — the demo panels are seeded through the host's own hub instead, and say `source: "sandbox"` so nobody mistakes them for an extension that ran.

---

## M10 · Self-contained distribution

| ID | Task | State | Owner | Evidence | Notes |
| --- | --- | --- | --- | --- | --- |
| M10-T1 | One-command `install.sh` | done | codex-2026-09-06-release | public `/releases/latest/download/install.sh` dry-run selected `laser_0.1.0_amd64.deb`; [CI run 34006391926](https://github.com/youssefsiam38/laser/actions/runs/34006391926) passed the end-to-end installer suite | Public, unauthenticated HTTPS download retains checksum, mandatory provenance and pinned maintainer-signature verification. See M10-T1 notes |
| M10-T2 | The command in the README, and `--uninstall` | done | codex-2026-09-06-release | [laser.hubtrix.com](https://laser.hubtrix.com) serves `/releases/latest/download/install.sh`; website commit `762ae79`; installer suite covers upgrade and uninstall | The public website follows GitHub's latest stable release; explicit historical installs remain version-pinnable. |
| M10-T3 | Bundled runtime and agent, nothing from the machine | done | lane-R, integrator | `node packages/desktop/scripts/clean-machine.mjs` → all ten packaging claims hold with `PATH` emptied and a decoy `~/.pi/agent` left byte-identical; `packages/worker/src/resolve-pi.ts`, `packages/worker/test/resolve-pi.test.ts` | Two silent bugs found and fixed: `@earendil-works/pi-server` was resolved by `packageExtensions` and therefore never packaged (the packaged app could not open a single session), and `files:`'s unanchored `doc` exclusion deleted `yaml/dist/doc/`. A third, found at integration: `@napi-rs/keyring`'s native binding was missing too, so the app died at startup with `Cannot find native binding`. All three are now declared and `build/before-pack.cjs` fails the build for anything of the same shape. See M10-T3 notes |
| M10-T4 | Every Linux package format | done | codex-2026-09-06-sandbox | [release run 34007810725](https://github.com/youssefsiam38/laser/actions/runs/34007810725); live `/opt/Laser` 0.1.2 renderer runs with `--enable-sandbox`, helper `root:root 4755` | Ubuntu's AppArmor-restricted userns mode now selects the native package's root-owned setuid sandbox fallback. The exact public `.deb` was installed and launched on Ubuntu 24.04. |
| M10-T5 | Extensions from Settings | done | lane-S, integrator | `packages/host/src/packages.ts`, `packages/host/test/packages.test.ts` (22); live: `pi-simplify` installed from the UI in ~3 s → `settings.json: "packages": ["npm:pi-simplify@0.2.3"]`, lock with sha512 + resolved URL, manifest 0.2.3 on disk | The host resolves "newest"/a range/a tag to **one exact release** and writes `npm:<name>@<exact>` into settings, records the registry-declared integrity in `<stateDir>/packages.lock.json`, and verifies the installed manifest is that version (D-39). The package manager ships inside the app: `scripts/fetch-node.mjs` lifts the npm out of the *same* pinned Node archive, so it is covered by the hash already in git, and the host finds it beside the runtime binary whether the shell or a terminal `laser up` started it, never from `PATH` in a packaged build, always with `--strict-allow-scripts` (D-44). An integrity hash is stored only once it has been checked against what npm installed (D-45) |
| M10-T6 | First run inside the window | done | lane-S | `packages/ui/src/components/onboarding/**`, `packages/ui/test/onboarding/setup-model.test.ts` (5); driven live at 1280 and 390, dark and light. The flow now owns the whole window and is re-runnable from Settings → This device (D-47) | Five steps: welcome, provider sign-in (OAuth and API key, only the methods the provider actually has), default model, project folder, done. Completion is host state (`pi/setup/state`), so it resumes on any device at the first thing that is actually missing. No config file, no environment variable, no terminal |
| M10-T7 | Release pipeline, versions pinned end to end | done | codex-2026-09-06-sandbox | [0.1.2 release run 34007810725](https://github.com/youssefsiam38/laser/actions/runs/34007810725) passed x64, ARM64, staged install, provenance, publication and Pages | The real-release installer gate derives the version from the tagged workspace instead of hard-coding the first release. Plain SemVer is stable/Latest; suffixed SemVer is prerelease. |
| M10-T8 | Product language | done | lane-L | 59 user-visible strings across 29 source files; `packages/ui/test/shell/model.test.ts` updated for the one it asserts | The agent is named in exactly two places, which is where it is the truth: the `laser pi` escape hatch (its command, help topic and passthrough errors) and diagnostics (`laser doctor`, `laser logs`, the Logs screen's provider-ceiling note). Nothing renamed — no identifiers, types, protocol fields, RPC methods or env vars. Two reverse failures fixed on the way: a `Something went wrong` with no content, and a parse error that blamed the agent for a file laser itself refuses to overwrite |
| M10-T9 | OS-native update channel | done | codex-2026-09-06-sandbox | live 0.1.2 `/etc/apt/sources.list.d/laser.list`; isolated `apt-get update` accepted signed feed; candidate and installed version both 0.1.2 | Native packages register the exact case-sensitive repository slug from `product.json`; signed APT and RPM feeds are public and current. |
| M10-T10 | Turn the in-app updater on | todo | — | — | The public repository removes the feed-access blocker, but the default installer extracts the AppImage (D-43), while electron-updater requires the original AppImage path. Keep `publish: null` until that install/update seam is designed and proved with a second version |

#### M10-T1 notes
- 2026-09-06 done: the public Latest installer downloaded without authentication, resolved stable v0.1.0 and selected the native amd64 package in a no-write dry run. Clean GitHub CI passed the full installer verification suite in run 34006391926.
- 2026-09-06 claimed: replace the authenticated private-repository transport with public HTTPS downloads, pin the maintainer signing key, retain mandatory provenance, and verify the 0.1.0 install end to end.
- 2026-09-06 checkpoint: permanent Ed25519 public key pinned; private key stored mode 600 outside git and as the `LASERCODE_RELEASE_KEY` Actions secret. Public fetch uses curl/wget; `gh attestation verify --bundle` was proved with an empty GitHub CLI config against a current public attested artifact. Local installer suite: 74 passed, 0 failed.
- 2026-09-06 checkpoint: native-package default added without weakening the explicit AppImage path; installer suite now 76 passed, 0 failed. A fresh x64 build produced AppImage, deb, rpm and tar.gz, and its clean-machine gate proved Node 24.20.0 and pinned Pi 0.85.0 came from inside the package with an empty PATH.
- 2026-09-05 lane-I: the asset is chosen by **listing** the release and matching extension + architecture tokens, insisting on exactly one match, never by reconstructing a filename. electron-builder names each format the way that format's ecosystem does (`.deb`→amd64, `.rpm`→x86_64, AppImage→x86_64, arm64 vs aarch64), and a reconstructed name is a 404 on a stranger's machine.
- 2026-09-05 lane-I: `RELEASE_PUBKEY` is deliberately empty rather than a placeholder. A fake key turns "not configured" into "passed"; `scripts/release/sign.sh --keygen` prints the exact line to paste.
- 2026-09-05 integrator: the tarball's own installer was also called `install.sh`, which made two files with one name in one product. Renamed `laser-setup.sh` and told to say it is the offline path; the root installer handles `--format tar` and is tested both ways.
- 2026-09-05 integrator: `~/.local/bin/laser` is the launcher, and a person typing `laser doctor` means the command. `build/linux/launcher.sh` now dispatches — an ordinary first word (or `--help`/`-h`/`--version`/`-v`) runs the bundled CLI on the bundled Node; a `laser://` link or anything else starting with `-` opens the window, because those are Chromium's flags and Electron passes them to itself on relaunch. `packages/desktop/test/launcher.test.ts` holds the table.

#### M10-T3 notes
- 2026-09-05 lane-R: "am I the entry point" in `resolve-pi.ts` must compare **realpaths**. `import.meta.url` is resolved through symlinks and `process.argv[1]` is not, so the naive check printed nothing under pnpm and worked perfectly in the packaged flat tree.
- 2026-09-05 integrator: the belief that "electron-builder cannot read pnpm's isolated store" was wrong, and believing it hid the three real bugs above. It resolves the store into real files fine (177 packages, zero symlinks); what it does not do is follow a dependency no manifest declares. The release build now uses a plain `pnpm install --frozen-lockfile` — the same tree the tests ran against — and `NPM_CONFIG_NODE_LINKER=hoisted` is gone from the workflow and from `build-linux.sh`.
- 2026-09-05 integrator: `laserDataDir()` moved into `@lasercode/host` and the CLI's default agent directory now points at it, so `laser sessions` in a terminal and the app's window resolve the same directory. Before this they disagreed and each showed sessions the other could not see.

#### M10-T4 notes
- 2026-09-06 done: public 0.1.2 installed over 0.1.0 on Ubuntu 24.04. `/opt/Laser/chrome-sandbox` is `root:root 4755`; the restarted 0.1.2 renderer has `--enable-sandbox`; the bundled host is healthy on 41441. Release run 34007810725 passed both architectures and the staged real-artifact install gate.
- 2026-09-06 claimed: repair the native-package sandbox path exposed by installing public 0.1.0 on Ubuntu 24.04. The package loaded Laser's AppArmor profile but left the root-owned helper at 0755; the launcher's `/usr/bin/unshare` probe ran under a different AppArmor profile and was denied, so it falsely reported that neither sandbox route existed.
- 2026-09-06 checkpoint: `after-install.sh` now enables the root-owned 4755 helper whenever Ubuntu's `apparmor_restrict_unprivileged_userns` switch is on. A regression test holds the package hook. The installed helper on this machine was repaired to `root:root 4755`, and the exact `/opt/Laser` build launched with `--enable-sandbox`, its bundled Node 24.20.0 and pinned agent 0.85.0.

#### M10-T7 notes
- 2026-09-06 done: the generalized future-version gate accepted 0.1.2, and release run 34007810725 completed x64, ARM64, signing, real staged install, provenance, stable publication and GitHub Pages deployment. Main CI run 34007758082 also passed.
- 2026-09-06 claimed: patch release 0.1.1 exposed that `verify-install.sh --release` passed `--version v0.1.0` and expected 0.1.0 even when validating a different tag. Both architecture builds passed and publication correctly stopped before creating a Release. The real-release path now derives its tag and assertions from the workspace version; the 76-case synthetic suite passes.
- 2026-09-06 done: release run 34005922135 succeeded end to end after the GitHub Pages environment was allowed to deploy release tags. v0.1.0 is a non-draft, non-prerelease Release and GitHub's Latest route resolves to it. The follow-up clean CI run 34006391926 passed every build, typecheck, test and installer gate.
- 2026-09-06 release checkpoint: with a virtual display, the real preload test passed and the five remaining launcher assertions revealed one final host dependency: GitHub blocks unprivileged user namespaces. The launcher dispatch fixture now supplies a successful `unshare` probe, explicitly modeling the normal sandbox-capable machine; packaged-app checks remain responsible for the real sandbox paths.
- 2026-09-06 release checkpoint: the next clean CI run reduced desktop failures from 12 to 6 and showed their common remaining cause: GitHub's runner has no graphical session. The real hidden Electron preload probe and the launcher's window branch both require a display even when no window is shown. CI now runs the suite under the runner's Xvfb display; the command and non-window test paths remain unchanged.
- 2026-09-06 release checkpoint: after pnpm setup was repaired, clean CI exposed two local-state assumptions in desktop tests: launcher tests read an ignored generated file without generating it, and the preload smoke test expected Electron's downloaded setuid sandbox to be root-owned on a hosted runner. Desktop tests now generate their Linux assets in `pretest`; the isolated hidden preload probe explicitly disables only its throwaway Chromium sandbox. Neither change affects the application launch path.
- 2026-09-06 release checkpoint: the ordinary `ci` workflow had independently retained the same duplicate `pnpm 10` input and floating Node-20 action tags that broke the first release run. It now consumes only `packageManager: pnpm@10.34.5` and uses the same immutable Node-24 action revisions as the release workflow.
- 2026-09-06 release checkpoint: release channels are now derived from SemVer: `-alpha`, `-beta`, `-rc`, or any other pre-release suffix creates a GitHub prerelease that cannot become Latest; a plain version is explicitly stable and Latest. The public website installs through GitHub's `/releases/latest/download/install.sh`, so it follows stable releases without pinning a version. Every workflow action was also advanced to an immutable Node 24-based release to remove the runner deprecation warnings.
- 2026-09-06 release checkpoint: the corrected public tag built all four ARM64 artifacts, then its clean-machine gate looked only for x64's `out/linux-unpacked` instead of electron-builder's ARM64 `out/linux-arm64-unpacked`. The gate now selects the current architecture's directory first and retains the x64 fallback; no artifact from the failed run was published.
- 2026-09-06 release checkpoint: the first public tag run stopped before any build or publication because pnpm/action-setup now rejects a workflow version alongside package.json's exact `packageManager` pin. Removed the duplicate workflow input; the repository pin is the single source of truth.
- 2026-09-06 release checkpoint: both the application and website repositories passed a redacted full-history Gitleaks scan with zero findings (44 and 6 commits respectively).
- 2026-09-06 release checkpoint: `pnpm verify` passes across the workspace. The release workflow now publishes its signed Sigstore bundle as `provenance.jsonl` after the attested release assets, enabling offline verification without authentication.

#### M10-T9 notes
- 2026-09-06 done: after installing public 0.1.2, the actual source file names lowercase `https://youssefsiam38.github.io/laser/apt`; an isolated APT refresh accepted its signed `InRelease`, and `apt-cache policy` reports installed/candidate 0.1.2 from that feed. The package hook also keeps the RPM base URL on the same generated repository slug.
- 2026-09-06 reopened: installing through the public command proved `/etc/apt/sources.list.d/laser.list` pointed to `https://youssefsiam38.github.io/Laser/apt`; GitHub Pages serves the repository at lowercase `/laser/apt`, so `apt update` returned 404 even though the feed and signatures themselves were valid. The hook now embeds owner and case-sensitive repository name from `product.json`, and identity generation/check plus a regression test hold both values. This fix is 0.1.2 because 0.1.1 was already published before the live updater check exposed it.
- 2026-09-06 done: the public GitHub Pages APT feed advertises Laser 0.1.0 and its `InRelease` signature verifies; the x86_64 RPM `repomd.xml` signature also verifies. Both are signed by the packaged repository key `6E593349C0A1BE57F024CF97AFC91CDE867E302B`.
- 2026-09-06 claimed: add signed public APT and DNF feeds to 0.1.0, including package hooks that register the feed and keys; verify package metadata locally before tagging.
- 2026-09-06 checkpoint: RSA repository key `6E593349C0A1BE57F024CF97AFC91CDE867E302B` is stored as the Actions secret and its public half is packaged. The real `.deb` contains the APT key/source hook and all seven icon sizes; the real `.rpm` contains the DNF key/repo hook and verifies `digests signatures OK`. An isolated APT client accepted signed `InRelease` and selected Laser 0.1.0; `gpgv` accepted the signed DNF `repomd.xml`. `actionlint` and identity generation/check pass.
- 2026-09-05 integrator: **the install path was walked end to end on this machine**, and it found four things no test had. (1) `@napi-rs/keyring`'s native binding was not packaged, so the app died at startup — the packaged tree had `keyring` and no binding. (2) `dist:linux` silently ignored `--x64` and built *both* architectures, which the new cross-arch guard then caught an hour in; unknown options are now refused by name. (3) `install.sh --from` reported the version as `local` in the last line a person reads, though every artifact carries it in its own filename. (4) On an installed copy the launcher was reached through the AppDir's `AppRun`, which *prepends* `--no-sandbox` when `unshare` fails — the strip keyed on `$APPIMAGE`, which the extracted case does not set, so the injected flag survived and laser ran unsandboxed without saying so. `packages/desktop/test/launcher.test.ts` covers the last one and the window-or-command split.
- 2026-09-05 integrator: evidence of the walk, in order — `scripts/release/build-linux.sh --arch x64` built AppImage 185.9 MB, deb 151.9 MB, rpm 135.7 MB, tar.gz 192.9 MB plus `SHA256SUMS`, with the clean-machine gate passing; `install.sh --from release --dry-run` printed every action and took none, including this machine's AppArmor note; the real install wrote `~/.local/{lib,bin,share}` and the `.desktop` entry with `MimeType=x-scheme-handler/laser;`, `TryExec` and seven icon sizes; `laser --version` → `0.1.0` and `laser doctor` → 10 passed with the bundled runtime, the bundled agent and a real worker session, all with nothing else on `PATH`; the app launched, took its identity from the system keyring, logged `packages: installer <bundled node> <bundled npm-cli.js>`, and said out loud that the machine's own agent at `~/.nvm/.../bin/pi` is not used.

#### M10-T6 notes
- 2026-09-05 integrator: walked on the installed app against a fresh `$XDG_DATA_HOME`. Welcome → provider (OpenAI, already signed in through the environment, said so) → default model (grouped, searchable, context sizes, vision marks; wrote `openai/gpt-4.1`) → project (folder browser, `~` expansion, "No folders inside. Use this one, or go up.") → the three tips. The project appeared in the rail and the sessions panel immediately.
- 2026-09-05 integrator: one real defect on the screen a person lands on the moment they finish. The composer's model chip read **"No model"** — right after the step whose only job was choosing one. It was not wrong about the *session* (there is none yet) and badly wrong about the person's situation. `SessionModelSelector` now falls back to the project's default when no session is open, disabled and titled "What a new session starts with". A second pass on the same defect: the catalogue takes seconds on a cold worker, and "No model" during those seconds is the same false claim one state earlier — the wait is now its own state and says nothing at all.

#### M10-T8 notes
- 2026-09-05 integrator: lane L's sweep missed the largest single surface — `packages/worker/src/settings.ts`, the catalogue every Settings form is generated from. Thirty user-visible strings named the agent, including a whole sidebar section titled "Managed by Pi" and a hint reading "Same format as Pi's --models flag". All rewritten, plus four error messages the person can actually hit. Two test assertions moved with them.
- 2026-09-05 integrator: `laser doctor`'s two most likely failures on a clean machine both told the person to open a terminal — "Run `laser pi` and use its /login command" and "Set one in Pi's settings (`laser pi` → /model)". Both now lead with the window, which is where M10-T6 put the answer; the terminal path stays as the second sentence, because doctor is diagnostics.

#### M10 review notes (wave 4)
- 2026-09-05 reviewer+fixer: **the clean-machine claim was false at the entry point.** `install.sh` preferred `AppRun` over the launcher when both were present, and an AppImage AppDir always has both. electron-builder's AppRun assigns `APPDIR` without exporting it, so the launcher's `--no-sandbox` strip (recorded as fixed in the M10-T7 notes above) could never fire on an *installed* copy: the flag survived, laser ran unsandboxed and said nothing, and `laser doctor` opened a window. It also required `bash` and rewrote `PATH`, `LD_LIBRARY_PATH` and `XDG_DATA_DIRS` for the host and every process the agent spawns. `install_appdir` now prefers `$PRODUCT` and falls back to `AppRun`; `verify-install.sh`'s fixture grew the launcher electron-builder actually ships, so the assertions test the real shape. Proved on the real 0.1.0 AppImage: `bin/laser` and `Exec=`/`TryExec=` all name `app/laser`, and `laser doctor` prints a diagnosis.
- 2026-09-05 reviewer+fixer: the launcher's AppRun detection keyed on two variables an extracted AppDir never sets. It now also recognises the *shape* of the injection — an `AppRun` sibling plus `--no-sandbox` as the first argument, which is exactly what AppRun's `exec "$BIN" --no-sandbox "$@"` produces. `packages/desktop/test/launcher.test.ts` had encoded the false premise in a comment and in a test that set `APPDIR` itself; both replaced, and the extracted case is now covered.
- 2026-09-05 reviewer+fixer: the launcher's "turn user namespaces back on" advice named Debian's `unprivileged_userns_clone` on a machine where Ubuntu's `apparmor_restrict_unprivileged_userns` is what is shut. It now reads the three sysctls and names the ones that are actually off. `install.sh` checks the same knob **before** downloading 200 MB and offers `--format deb`, which ships the AppArmor profile and the setuid helper that fix it properly.
- 2026-09-05 reviewer+fixer: an interrupted upgrade destroyed the working install. `$SCRATCH` is under `/tmp`, so `mv` into `~/.local` is a cross-device copy of ~400 MB; ENOSPC or a Ctrl-C left `app.old` beside a missing `app`, a dangling launcher and a hidden menu entry. `ROLLBACK_APP` + the EXIT trap put the old version back. The receipt is also written as soon as the tree and the symlink land, so a failure while installing icons no longer produces an app that `--uninstall` cannot see.
- 2026-09-05 reviewer+fixer: `--yes` deleted settings, the device identity and every pairing without asking — including in `verify-install.sh`'s own `--uninstall --yes`. `ask()` under `--yes` is now "do not stop to ask me"; deleting data is `--purge`, on its own, and with no terminal the answer is "keep" rather than a `die` half-way through a removal that had already deleted the receipt.
- 2026-09-05 reviewer+fixer: `cp "$0"` copied `/bin/sh` when the script was fed on stdin, with `|| true` hiding it, and recorded that as the uninstaller. It now checks `$0` is this file and otherwise says how to fetch the script again.
- 2026-09-05 reviewer+fixer: `laser-setup.sh --uninstall` deleted `~/.local/bin/laser`, the menu entry and all seven icons without checking they belonged to the unpacked copy — the paths are byte-identical to `install.sh`'s. It now compares the symlink target and the entry's `Exec=`, keeps anything that is not ours, and warns before *registering* over another copy. `after-remove.sh` likewise only removes `/usr/bin/laser` when it points into the package's own `$APP_DIR`.

#### M10-T5 notes
- 2026-09-05 lane-S: third-party extensions cannot have git-resident hashes the way the runtime and the agent do. The honest boundary: the host pins the exact release into settings (that is what reproduces), records the registry-declared `sha512` in the lock (that is what detects drift), verifies the installed manifest version, and never runs anything the package manager has not verified.
- 2026-09-05 lane-S: `pi/packages/check_updates` reports a pinned npm source as never-updatable, which is correct for the agent and useless for a person. The host compares the on-disk version to the registry and reports `latestVersion`; "Update" installs a **new pin** rather than re-resolving `latest`.

---

## Handoffs

### Current stabilization ownership

| Area | Owner | Milestone / permitted paths | Base | Prerequisites / status / next handoff |
| --- | --- | --- | --- | --- |
| CI repair / release | stabilization-ci (orchestrator) | frozen `ci-035-repair`; unchanged guarded launcher only; no checkout edits | `7a05c79` | independently approved and full verify passed; pushed main; done: CI `34527293821` and release `34527657277` passed; v0.3.5 public/Latest with 12 verified assets |
| Coupled lifecycle | hlc010-admission-owner / `01a08d0a-9a10-70c8-b0d6-ec794e6de23d` | HLC-010 seam; worker lifecycle/driver/server/Chord and related tests only; planning excluded | later acknowledged frozen `aca8591` | prior owner frozen; safe next claim/transfer required. T93 backend gaps and T98 incident reproduction remain open under one continuing owner; T89 UI scope queued |
| Independent frontend acceptance | stabilization-ui-acceptance / `01a08d2f-269a-70c8-b0d6-ec85497c2d18` | read-only source at isolated `ui-acceptance`; own installs/builds/temp browser scripts/artifacts | fixed `91a7759` frontend | initial cycle completed `run_e2806604`, rejects T89 draft-loss and leave/discard defects; report/scripts retained, no source writes; final combined browser proof waits for candidate |
| Local-main reconciliation | stabilization-ci (orchestrator) | isolated `main-reconciliation`, merge Git + STATUS/STATUS_DETAILED resolution only | `2171a0b` + `7a05c79` | done: reviewed `5a8fe4f`, local main fast-forwarded with unchanged user dirt; full tree equals released `7a05c79`; no push |
| Current planning ledger | stabilization-ci (orchestrator) | PLAN/STATUS/STATUS_DETAILED and `docs/incidents/queued-completion-ownership.md` in `hlc010-development`; external handoff cross-reference only | `aca8591` | documentation-only T98/D-195 addition; preserve prior status dirt; no source writer/restart/release activated; next agent receives full incident |


### H-7 · M13-T93/M13-T94/M13-T98 · 2026-09-11 · stabilization-ci
State of the work: current source is `aca859180f664d01f10d7a5d8e2a3c56033c9c09`, later re-frozen by its owner. The person supplied the detailed premature-completion/unowned-continuation incident and requested it be added in full. M13-T98 is now a mandatory release dependency under D-195; canonical evidence and acceptance are in `docs/incidents/queued-completion-ownership.md`.
Uncommitted: prior STATUS/STATUS_DETAILED edits preserved, plus this documentation-only PLAN/status/report update; no source implementation, session-state edits or restart. Full continuation handoff is `/tmp/laser-stabilization-handoff-2026-09-11.md`, updated with the new requirement.
What remains broken: backend refusal/attribution and UI retry/discard gaps, unproven exact queued-completion incident regression, independent review and final combined/package gates. The historical loaded build remains unverified despite the installed manifest; do not attribute its defect to the newer development source without reproducing it.
Next concrete step: establish a single continuing lifecycle owner safely, reproduce the exact two-queued-message completion/correction/interrupt sequence on pinned Pi, fix/verify preserved development, and prove the final packaged worker's actual build after isolated controlled restart. Do not reset history, modify personal sessions, silently restart live work, or claim the incident is fixed from a green mock suite.

### H-6 · M13-T89/M13-T92/M13-T93/M13-T94 · 2026-09-10 · stabilization-ledger
State of the work: main `ccd48bbe77d72c307f8df91bf700ec983f6f124a` contains approved pending `e1c24c7` plus ledger-only work. Accepted staging `stabilize/0.3.5` is clean at `adcbd66f68eab9cfcd131d3eed763d11517695d6` with the approved pending/composer/disclosure/header/neutral/ledger set, but is not a final RC. Coupled development is clean and frozen at `aba12f7b1912144d1d041f057aa643acf143aecd`; approval is withheld because HLC010 needs the person’s answer to Q-8. No further implementation is authorized.
Evidence: preliminary full verify passed at `6b69f5e` before header/neutral/lifecycle. Exact `adcbd66` focused checks passed: 58 UI, 11 worker fleet, identity and diff check. Header `a8715dd` passed five focused tests, types and identity. An independent backend reviewer confirmed exact `aba12f7b` resolves HLC008/HLC009, while HLC001/002/003/004/006/007 remain resolved; the whole batch is `changes_requested` solely for HLC010, with HLC005 nonblocking and deferred. The 121 worker and 71 UI results are static evidence from previous runs, not a fresh full gate. Full current verify, browser and package gates were skipped at the person’s request, so release readiness is not established.
Uncommitted/retained: this ledger worktree retains only the pre-existing untracked `node_modules` symlink. Parent main’s user-owned `docs/agents-leap` deletions and `.laser`/todo/screenshot dirt are untouched. Activity `131332b`, composer `e7a5b89`, header `a8715dd`, harness `aba12f7b` and staging `adcbd66` are clean; neutral `d694b07` retains its untracked `node_modules`; first-prompt `a0264674` retains frozen unstaged `PLAN.md`, `STATUS.md`, `STATUS_DETAILED.md` and `docs/agents.md`; staging retains local dependencies. External `/home/youssef/projects/laser-agents` branch `feat/agents` at `c7a84a0` is untouched. Preserve `/tmp/laser-pending-delivery-e1c24c7-node_modules.BBUjj1/node_modules` and all browser/tmp artifacts. No registry/transcript edits or restart occurred. The busy-refusal run `run_a249dd0e` did not prove true idle; ongoing edits were preserved, and the actual frozen acknowledgement came from the owning session before its last resume.
Next concrete step: the person chooses whether to authorize a dedicated reviewed awaitable extension-generated prompt-admission boundary or stop at the preserved checkpoint. If authorized, begin as separately scoped HLC010 work; do not treat a settled wait as sufficient and do not disable child goals. HLC005’s structural rewrite remains deferred.
Do not: merge source branches, run omitted gates without instruction, clean retained artifacts/worktrees, change optional Markdown/image work, alter version 0.3.4, push, tag, publish, install or restart.

### H-5 · M13-T89/M13-T92/M13-T93 · 2026-09-10 · first-prompt-binding → harness-lifecycle
State of the work: first-binding source is frozen at `a0264674753cfa1999d00f89294492da5fd62e3e` on `e1c24c7`; harness focused fixes are frozen at `d79c2869efffc054e2d919b99bc2fe7b43b587ea`. Both checkpoints and the transfer acknowledgement are exact and unapproved. First-prompt-binding explicitly relinquished all lifecycle/server source and test writing; harness-lifecycle accepted sole continuing ownership of the coupled source/test boundary.
Uncommitted: first-prompt-binding retains only four unstaged frozen planning/docs files with unchanged hashes and no continuing source/bookkeeping ownership; the harness checkpoint has no uncommitted source. In this ledger worktree, only the separately reported `node_modules` artifact remains untracked.
What remains: preserve both source commits in a coherent development batch; fence prompt, steer, follow-up and pending-tray callers across runtime preparation; adopt harness `promptUser`; prove real SDK/server model and thinking selection, rollback, settled-gap, origin and pending acceptance. Repair the reproducible local install first: the first-binding checkpoint reports a missing oxide native binding, unbuilt full host dependencies and no real-browser proof despite passing unit/type/identity evidence.
Next concrete step: harness-lifecycle begins the bounded integration milestone under D-191, with no concurrent writer in protocol first-binding, UI runtime, worker driver/server, lifecycle or their integration tests.
Do not: rewrite either frozen checkpoint, assume isolated tests prove completion, touch composer/header/activity/fleet ownership, alter optional features/version/release state, or change accepted preparation branch `6b69f5e` before review.

### H-4 · M13-T88 · 2026-09-10 · beam-release-034
State of the work: source `62839fe` pushed; source CI 34471150534 still running. The person stopped local automation `t-c1cf502d` before tagging. No remote `v0.3.4` tag and no release workflow were started.
Uncommitted: STATUS.md publication handoff and this ledger update; unrelated files remain untouched.
What is broken: automatic publication is no longer queued; stopping the local command did not cancel GitHub CI.
Next concrete step: after approval to resume and successful source CI, tag exactly `62839fe`, push the tag and let the existing publisher finish. Release notes are `/tmp/laser-034-release-notes.md`.
Do not: restart the cancelled command without approval, tag a failed CI commit, publish while architecture builds run, or touch the installed app.

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

### H-2 · M12-T43 · 2026-09-06 · codex-2026-09-06-release-024
State of the work: version 0.2.4 is committed on main at 972ce10, but it is not
published and no v0.2.4 tag exists locally or remotely.
Uncommitted: no product changes; user-owned `fixes.md` remains untracked.
What is blocked: the user asked for an opinion before deciding whether the
transcript density adjustment belongs in this release.
Next concrete step: if approved, add and claim the compact-density task, make
the token-led transcript-only changes, visually verify both widths/themes,
then recreate v0.2.4 at the final commit and restart the release workflow.
Do not: publish or recreate v0.2.4 from 972ce10; release run 34032180101 was
cancelled before publication specifically so the tag can name the final UI.

---

### H-3 · M12-T51 · 2026-09-07 · codex-2026-09-06-slash-skills
State: 0.2.6 verified but not committed, tagged, pushed or released. User interrupted
dispatch to ask about literal escape characters in the activity summary.
Finding: bash summaries use oneLine(command); whitespace is flattened, but valid
shell escapes such as printf's backslash-n remain literal. Recommend a readable
summary with untouched expanded/copyable source, not blind global unescaping.
No escape-rendering change implemented yet.
Next: resolve this added UX request, update notes, then commit/push/tag/create
release without waiting for Actions, as authorized. All 0.2.6 changes remain
uncommitted; user-owned fixes.md stays untouched. 448 UI tests and workspace
typecheck pass; the earlier full gate had 925 tests before ten added UI tests.
Notes: /tmp/laser-v0.2.6-notes.md. Create with --latest=false; the workflow promotes
Latest after uploading installers. Do not create a draft: publish.sh does not
undraft an existing release. No CI monitoring. QA processes were stopped.

### H-4 · M13-T102/T104/T105/T106 · 2026-09-11 · orchestrator-release-subset
Release cutoff D-207 excludes all four tasks. Preserve continuing sessions/worktrees; none may be discarded to make a release tree clean.
- T102: `agents/agent-model-selection-086dd13c`, clean commit `7b5dfe7`; one review NOT APPROVED (`/tmp/review-agent-model.md`): resolve actual-model validation and UI/request thinking disagreement together; no integration for0.3.7.
- T104: `agents/parent-interrupt-control-6e79761b`, clean base `728a1f9`, four-mode plan `/tmp/laser-m13-t104-parent-interrupt-plan.md`; no implementation. Needs reviewed T102 base before schema ownership release.
- T105: `agents/fleet-section-partition-f4a7fcde`, base `3bdacf5`, uncommitted partial edits in fleet/model.ts, fleet/index.ts, elements/subagent-list.tsx and FleetPanel.tsx. FleetPanel JSX still references removed variables/old props: intentionally not compile-ready. Baseline54 tests only; diff-check passes. Next finish projection integration, compile, tests/docs/browser and review. Plan `/tmp/M13-T105-fleet-section-partition-plan.md` holds parent-owned future inventory/ux-agent-work wording (not committed in0.3.7).
- T106: same continuing model owner/worktree; no edits. `/tmp/laser-m13-t106-scroll-plan.md` confirms body-portalled model/provider menus outside Dialog scroll lock: real wheel0→0, moved portal into dialog control0→650. Next opt-in container propagation and wheel/touch regression; retain modal lock.
At this checkpoint all owners had stopped source work and temporary ports; no installed/live host was restarted. D-208 subsequently resumes isolated work under the same owners/bases while the release remains frozen.

## Decisions log (append-only)

> **The product was renamed to Laser on 2026-09-06 (D-36, MX-T7).** Everything
> below predates that and says `laser`, which is left exactly as written: a
> ledger that gets edited to match the present is no longer evidence of what was
> decided at the time. Read `piorbit` here as the working name for this product.
> The one place the old name is still live rather than historical is
> `wireNamespace`, which is frozen on purpose — see D-36 and `product.json`.


### D-1 · 2026-09-05 · Build from scratch, not a fork
Decision: laser is a new codebase. Borrow patterns and small pieces from
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
Decision: laser tab groups replace pi-subagents' Herdr project panes and
inspector panes. No Herdr dependency.
Consequences: `project.open` and Herdr FleetView actions are dead surfaces in
laser.

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
Decision: `@lasercode/ui` is React 19 + Vite. Matches the streaming-markdown
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
Decision: `@lasercode/ui` is rebuilt on `@assistant-ui/react` 0.15.18 using the
ExternalStore + RemoteThreadList runtime over laser's existing HostClient,
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
Decision: `docs/ux-panels.md` is binding. Pi owns the logic, laser owns the
experience. Six closed kinds (run, plan, document, stream, collection,
decision); metrics live in the telemetry rail and embeds are out of scope.
Four surfaces (ambient, inline, dock, sheet) with a placement table laser
owns; the extension declares kind + intent only. Panels are islands that
morph through minimal / compact / expanded / maximized with continuous
identity; at most two expanded; a third shrinks the least recently watched
to minimal — nothing is parked. No auto-open except a decision that blocks
the turn. The declared `laser:panel` protocol ships in v1 and is used for
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
Scheduled runs deferred. The CLI uses the same nouns (`laser runs`,
`laser plan`, `laser missions`). Foreground children ship read-only and
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
Decision: the channel id is sent as `Sec-WebSocket-Protocol: laser.channel.<id>` and the path is a constant `/ws`, instead of the id in the request line.
Why: request lines land in proxy and edge access logs; subprotocols do not, and a subprotocol is also the only channel a browser client can set. The relay still treats the value as an opaque route (invariant 7).
Consequences: epoch rotation and squatter eviction for a disclosed id are design work, deferred and stated as such in docs/security.md.

### D-22 · 2026-09-05 · Wave-1 deferrals recorded honestly
- Notifications over ~61 kB are dropped with a counter rather than chunked; a relayed phone misses large tool outputs but never the session. Chunking is a follow-up task.
- The host WebSocket has an Origin allowlist but no token; any local process can drive the agent. Token in host.json is a follow-up task.
- No wave-1 UI was seen rendered by its authors; the orchestrator's browser pass is the only visual check so far.

### D-23 · 2026-09-05 · laser reimplements dictation rather than driving pi-gpt-transcribe
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
Decision: `packages/worker/src/transcribe.ts` reads the dictation config through `pi-gpt-transcribe/core`, pinned to the tag `v0.4.0`. `WidgetState` is the package's `DictationState`. The transport stays ours: the injectable fetch and the `no_key` / `oauth_key` / `audio_rejected` taxonomy are laser's, not a copy of anything.
Why: D-23 kept the package as the configuration source but re-derived the parser here, and a second parser for someone else's file format drifts without failing. A key added on that side still parses here, it just stops meaning anything.
Consequences: the package gained a terminal-free entry point to make this possible (0.3.0), made its native audio bindings optional (0.3.1), and stopped hardcoding the WAV container so the browser's Opus can be sent as it is (0.4.0). The desktop build excludes `decibri`, which nothing on this side can reach. Pinned by git tag because the package is not on npm.

### D-35 · 2026-09-05 · Updating ships in stages: in-app first, the system's updater later
Decision: M10-T9 (a signed APT repository and a dnf `.repo`) and M10-T10 (turning the in-app updater back on) are separate tasks, and neither blocks the first install. The app ships able to be installed and run; it learns to update itself when the repo can serve a feed an installed app may read, which the user expects to happen by making the repo public.
Why: the user's call, asked directly. The in-app path is already written and only wants a readable feed; the system path wants a signing key and a host, which is infrastructure rather than code. Shipping the install first and the update channels after keeps a private repo from blocking the thing people actually asked for.
Consequences: until M10-T10, an installed app reports updates as `unsupported` with a reason rather than retrying a feed it cannot reach (D-31 stands). The AppStream metainfo makes laser appear in GNOME Software and KDE Discover, but appearing is not updating, and the copy must not imply otherwise. `publish: null` stays until then.

### D-36 · 2026-09-05 · "piorbit" is a working name, and nothing may assume it is permanent
Decision: the product may be renamed and moved to another repository. No decision, file format, identifier or piece of on-disk state may treat the current name as fixed. MX-T7 makes it derive from one module so a rename is one edit plus a migration.
Why: the user's instruction, given directly. It also corrects something already in the tree: `electron-builder.yml` states "The app id never changes", which is true of an app id in general and false of this one in particular — the reasoning was sound, the premise was not.
Consequences: the rename is nearly free today and stops being free the moment anyone installs a build. `appId` keys macOS TCC permission grants, the Windows notification centre and the update feed's identity, so renaming after distribution makes it a different app: microphone permission is lost and the installed copy is orphaned rather than upgraded. The same is true of `~/.config/<name>`, `~/.local/share/<name>`, the `<name>://` scheme and every browser storage key. So MX-T7 comes before the first build anyone else installs, and D-35's staging helps: no update feed exists yet to be tied to a name.

### D-51 · 2026-09-06 · Machine-wide namespaces take `lasercode`; what a person types takes `laser`
Decision: `name`, `binary` and the display name stay `laser` / `Laser`. Every namespace shared with the rest of the machine takes `lasercode`: the data directories (`~/.config/lasercode`, `~/.local/share/lasercode`), the URL scheme, the environment prefix, the `Symbol.for` prefix, the browser storage prefix and the wire namespace. `appId` stays `com.hubtrix.laser`, which is already collision-proof through a domain we own.
Why: `laser` is a claimed word — taken on npm, taken on PyPI, and Debian already ships `laserboy`. A directory under `~/.config`, a URL scheme, an environment variable prefix and a `Symbol.for` key are all global registries with no registrar, so a collision there is silent and the failure mode is two programs quietly sharing state. The binary keeps the short name because it is typed daily and lives in the person's own `~/.local/bin`, where a clash is immediate and obvious rather than silent.
Consequences: the HKDF salts, the signing contexts and the relay subprotocol now derive from `WIRE_NAMESPACE` instead of being spelled out, so a future rename cannot leave two peers salting differently. `formerNames` is empty: see D-52.

### D-52 · 2026-09-06 · The wire namespace was renamed, and the migration removed, because nothing had shipped
Decision: `wireNamespace` moved from `piorbit` to `lasercode`, and `formerNames` was emptied, so no former-name migration ships.
Why: D-36 froze the wire namespace on the reasoning that renaming it strands paired devices and third-party extensions. That reasoning is right from the first release onwards and was wrong before one. Checked rather than assumed: no release exists, `publish` is null, no device is paired, no session file had been stored, and the only machine holding data was the maintainer's — which the migration had already moved and which was then verified to contain no old path. Keeping a former name that can never match anything is dead code that reads like a live guarantee.
Consequences: from the first build anyone else installs, `wireNamespace` is frozen for real and a rename means a version suffix, not a new spelling. The migration code in `packages/host/src/identity-migration.ts` stays and is still tested; it simply has an empty list to work from until there is a genuine former name.

### D-53 · 2026-09-06 · On NVIDIA without explicit sync, the desktop composites in software
Decision: on Linux the desktop decides its display backend in `packages/desktop/src/linux-display.ts`: native Wayland on a Wayland session, `WaylandLinuxDrmSyncobj` on, and — only when the session's GPU is NVIDIA and the compositor does not advertise `wp_linux_drm_syncobj_manager_v1` — `disable-gpu-compositing`. The compositor is asked directly (`wayland-globals.ts`, a forty-line registry client run synchronously before Chromium starts) and the GPU is read from sysfs. Anyone passing their own `--ozone-platform`, feature list or GPU switch is left alone. Supersedes the Vulkan switch from commit 35a1b10, which addressed a warning that is known to be harmless.
Why: the "Set up button only clickable on its left part, cursor never a pointer" report was not CSS and not hit-testing: the page was fine in a plain browser at every point across every button. It was a stale frame. The NVIDIA driver does no implicit sync, so without the explicit-sync protocol the window shows a frame from before the last relayout while input goes to the current one (NVIDIA/open-gpu-kernel-modules#187, closed only when Mutter 46.1 shipped explicit sync). Three things must line up: driver ≥ 555, a compositor that offers the protocol, and the app enabling Chromium's `WaylandLinuxDrmSyncobj` — which Electron leaves off (electron/electron#50455; the Hyprland NVIDIA guide tells every Electron app to add it). This machine has the driver (580) and Mutter 46.2, but Ubuntu 24.04 ships that Mutter with the protocol deliberately disabled (Phoronix, "GNOME Mutter 46.2 Rolls Out To Ubuntu 24.04 Users"), and its Xwayland 23.2 has none either, so neither backend can sync on an LTS desktop. Software compositing sends frames as shared memory, which needs no sync; it is the workaround people report working, and it is applied only where the bug would show.
Consequences: on this machine the log reads `display: native Wayland, NVIDIA, compositor no explicit sync; compositing in software` and `gpu: compositing disabled_software`. Machines with explicit sync (GNOME 47+, Plasma 6.1+, Ubuntu 24.10+) keep the GPU and get the syncobj feature, which is the real fix. Not yet proven: that the probe runs from inside `app.asar` in a packaged build (`ELECTRON_RUN_AS_NODE` on a file in the archive) — the next `dist:linux` must check the `display:` line in the installed app's log.

### D-54 · 2026-09-06 · The bridge is generated into the preload, because a sandboxed preload cannot import one
Decision: the Electron IPC channel table is written *into* `packages/desktop/src/preload.cts` by `pnpm identity:generate`, between `// <generated: IPC CHANNELS>` markers, instead of being required from `./ipc.generated.cjs`. `scripts/identity/artifacts.mjs` gained `inlineBlock()` for this (the region equivalent of `manifestFields`). Two tests hold the line: the preload may name no runtime specifier but `electron` — `./` is no longer an exception — and `test/bridge-smoke.test.ts` launches the real Electron binary with the built preload and asserts the bridge is on `window` with no preload error. Supersedes the diagnosis in D-53.
Why: this is what actually made the buttons dead. MX-T7 moved the channel names into a generated module and the preload required it; a sandboxed preload's `require` resolves `electron` and a few Node builtins and nothing else, so it failed with "module not found: ./ipc.generated.cjs". Electron's response is to log to a console nobody had open and load the page anyway — so the window drew perfectly and had no `window.desktop` at all, and every control that asks the desktop for something did nothing. Type-checking passed, the build passed, all 790 tests passed, and the file it could not find was sitting in `dist/` next to it. Three source-reading tests covered this preload and none could see it, because the failure only exists at load time in a sandbox.
Consequences: the preload has no imports left to break, and the smoke test fails loudly if one is added — verified by reintroducing the bad require and watching it fail. The general lesson is in the test's comment: a preload is the one file where reading the source proves nothing.

### D-55 · 2026-09-06 · No software compositing, and the GPU log line waits for Chromium to decide
Decision: `linux-display.ts` keeps `ozone-platform-hint=auto` and Chromium's `WaylandLinuxDrmSyncobj` feature, and no longer composites in software anywhere. It still reads the GPU from sysfs and asks the compositor for its protocols, but only to log one line naming both. The `gpu:` line is logged on `gpu-info-update`, not at ready. Supersedes the fallback in D-53.
Why: the fallback in D-53 was reasoning, not evidence — a stale-frame theory for a symptom that turned out to be D-54, and it cost every NVIDIA user hardware compositing. Explicit sync stays worth enabling on its own merits (NVIDIA does no implicit sync; Chromium leaves the feature off; Electron does not turn it on — electron/electron#50455), and it costs nothing where the compositor lacks the protocol. Separately, `app.getGPUFeatureStatus()` at `whenReady` returns `disabled_software` for everything because Chromium has not finished asking; the log therefore claimed the GPU was off while it was on. Measured: `immediately-after-ready` reports `disabled_software`, `on-gpu-info-update` reports `enabled`.
Consequences: this machine now logs `display: native Wayland, NVIDIA, compositor no explicit sync` and `gpu: compositing enabled, rasterization enabled, webgl enabled`. If a genuine stale-frame report appears later, the facts to act on are already in the log.

### D-56 · 2026-09-06 · Linux keeps its native window frame
Decision: Linux `BrowserWindow`s use `frame: true`. macOS keeps `hiddenInset`
and Windows keeps its title-bar overlay. Linux reports system-owned chrome with
no renderer inset.
Why: the maintainer reproduced unusable pointer input in Electron 44.2.0 with
`frame: false` under both native Wayland and X11; the same page worked in a
browser. X11 plus `hasShadow: false` also failed, ruling out both Wayland and
the client-side shadow alone. Changing only `frame` to `true` made the whole app
seamless. Upstream replaced Linux's `OpaqueFrameView` with Chromium-based
`ElectronFrameViewLinux` in electron/electron#51161; that code owns frame
geometry, hit-testing and input regions and has already caused confirmed 43/44
Linux regressions (electron/electron#52452, #52456, #52866). No upstream issue
currently documents this exact full-window pointer-coordinate failure, so the
specific upstream defect is an evidence-backed inference, not a claimed bisect.
Consequences: Linux gets reliable native controls and titlebar instead of custom
chrome. `test/window-frame.test.ts` prevents an aesthetic refactor from silently
putting Linux back on the broken path. D-54's preload failure remains a real,
separately tested bug; it was not the cause of the surviving input symptom.
Supersedes: the symptom diagnoses in D-53, D-54 and D-55; their implementation
decisions and tests otherwise stand.

### D-57 · 2026-09-06 · Public releases need no GitHub account
Decision: the repository and release assets are public. The versioned install
command downloads `install.sh` from the matching git tag over HTTPS and runs the
saved file. The installer downloads release assets with curl or wget and verifies
the published Sigstore bundle offline with `gh`; `gh auth login` is never needed.
The release manifest is also signed by the maintainer key pinned in `install.sh`.
Why: the authenticated Contents API was correct for a private repository but the
website displayed a different, non-working command. Making the source public
removes the access boundary and lets the visible command, copied command, README,
and release all use one reproducible versioned path without weakening D-42.
Consequences: curl or wget and GitHub CLI 2.49+ are fetch-time prerequisites;
Node, npm, the agent, root access, and a GitHub account are not. The provenance
bundle is uploaded beside, but not included in, `SHA256SUMS` because a bundle
cannot attest itself. Supersedes the private-repository transport in M10-T1/T2;
D-42 remains in force.

### D-58 · 2026-09-06 · Linux updates belong to the operating system
Decision: on Debian/Ubuntu-family systems the one-line installer selects the
`.deb`; on Fedora/RHEL/openSUSE-family systems it selects the `.rpm`. Those
packages install Laser's public repository key and register signed APT or DNF
feeds published by the release workflow on GitHub Pages. AppImage remains the
explicit `--format appimage` no-root option.
Why: the user wants future Laser releases to appear in Ubuntu Software Updater
and the equivalent native operating-system surfaces. An extracted AppImage is
invisible to those services; a native package plus a signed repository is their
normal update contract.
Consequences: the default native install asks for the normal administrator
password once. Its package manager owns later discovery, notification, upgrade
and removal. AppImage users re-run the installer and do not get native updater
prompts. The separate in-app updater stays off until M10-T10 proves its path on
platforms that need it. Supersedes D-57's statement that root access is not a
prerequisite for the default path; its public-download and trust decisions stand.

### D-59 · 2026-09-06 · 0.1.0 is local desktop; phone remote control is Soon
Decision: release 0.1.0 as the local desktop product. Every public phone/relay
claim carries a visible `Soon` flag, and package metadata describes the desktop
experience only. M7-T7 owns the missing browser `/link` pairing controller and
encrypted paired-device transport.
Why: the release audit proved that `laser relay pair` generates a sound
single-use URL, but the current UI imports neither `PairingInitiator` nor the
crypto package and has no `/link` entry route. A scan opens the configured web
origin but cannot complete pairing. The user chose to ship now and mark the
feature Soon rather than hold 0.1.0.
Consequences: the repository may contain and test relay/crypto foundations, but
the website and 0.1.0 metadata do not present phone remote control as available.
The feature may be promoted only after a real-phone QR scan completes the six-
symbol comparison and reconnects to the desktop through the relay.

### D-60 · 2026-09-06 · 0.2.0 is the product-experience release
Decision: group the identity, provider/model, reasoning, JSON diagnostics and
project-management work in M12 and release it together as stable 0.2.0.
Why: these requests cross M1, M2, M4, M5 and M11, but they form one visible
promise: the installed app should feel coherent rather than like separately
finished subsystems. A dedicated milestone preserves ownership and makes the
package/release gate explicit without reopening completed implementation rows.
Consequences: M4-T8 remains the settings foundation; M12 owns the shared UI and
desktop integration; M12-T5 cannot start until T1–T4 and M4-T8 are done.

### D-61 · 2026-09-06 · Web search belongs only in the transcript
Decision: stop adapting pi-web-access results into collection panels and hide
any legacy pi-web-access panel a running or older host replays. The existing
tool disclosure in the message remains the only web-search presentation.
Why: the panel repeats the same result data, and panels are currently scoped to
the project worker rather than a conversation branch, so the duplicate can
follow a person from an old session into a new one.
Consequences: `pi-web-access` remains installable and fully usable; only the
redundant pinned/inline island is removed. M8-T4 remains historical evidence of
the adapter that shipped, while M12-T8 records its deliberate retirement.

### D-62 · 2026-09-06 · The fresh-install theme is the Laser brand pair
Decision: add named Laser dark and light presets, derived from the approved
website mark's black, `#E9E8E6` and `#03CC7B`, and make them the fresh-install
system-following pair. Keep Graphite and Paper as optional presets.
Why: choosing a generic green hue is not the same as giving the product a
recognisable default identity. The logo is the source of truth.
Consequences: the dark preset may use the exact beam green as its interactive
accent; the light preset uses an accessible darker tone of the same hue where
green carries text, while retaining the exact logo colours in the palette.

### D-63 · 2026-09-06 · The project rail is selection-only
Decision: project initials in the permanent rail only select and filter their
project. Project removal and chat archival remain in the explicit overflow menu
in the sessions list. The strong rail highlight represents the optional session
filter, not the retained current-project scope. Composer trigger results use a
bounded scrolling surface.
Why: making the project button itself a dropdown trigger caused an ordinary
selection click to open a destructive menu, while an unbounded command list
could grow beyond the viewport.
Consequences: switching projects is a single predictable click, destructive
actions stay visibly separate, “Show all” clears the strong highlight without
discarding the project used by new chats/settings, and slash/mention suggestions
never consume the full application height.

### D-64 · 2026-09-06 · Project-scoped settings name their target
Decision: when Project or Effective scope is open, show a dedicated project
target control beside the scope tabs. Changing it changes the retained current
project without turning on a sessions filter.
Why: “Show all” intentionally clears the rail filter while a current project
still exists for new chats and settings. A hidden retained value is not enough
context for a settings write.
Consequences: every project override names both the project and exact directory
on the same surface, and stale settings from the previous target disappear
while the new snapshot loads.

### D-65 · 2026-09-06 · Dock occupancy chooses the active grid
Decision: one expanded panel fills the dock; two expanded panels use full-width
top and bottom rows; three or four expanded panels use stable quadrants in a
2×2 grid whenever the dock is wide enough to preserve the legibility floor.
The island elements keep their identity while their rectangles morph.
Why: choosing two columns from dock width before considering occupancy stranded
the first panel in the left half and made the canvas look pre-divided even when
nothing occupied the other regions.
Consequences: dock width still determines whether two readable columns are
available (D-25), but empty columns no longer reserve space. The third panel is
the first reason to activate the 2×2 grid; the fourth fills its remaining cell.
Supersedes: the occupancy implications of D-20; D-25's readability threshold
still stands.

### D-66 · 2026-09-06 · Thinking is a state, not a caret
Decision: an assistant turn that is running but has not produced a visible part
uses the installed assistant-ui thinking indicator with a live elapsed value.
The context inspector remains the installed context-display composition, but
its detailed dialog uses icon-led cards and an explicit window-health summary.
Why: a blinking caret does not name the state or show that time is passing, and
four undifferentiated number boxes make context data harder to scan than the
information deserves.
Consequences: the reasoning disclosure continues using the same indicator once
reasoning arrives, so the status has one visual vocabulary before and during a
reasoning stream. This adds M12-T11 without changing the 0.2.0 release gate.

### D-67 · 2026-09-06 · Telemetry is an instrument panel
Decision: the far-right rail presents context health, token composition, model
identity, file churn, tool activity and worker state through icon-led cards,
meters and compact visual summaries derived from the current session.
Why: a column of labels and numbers makes the person read every row before they
can understand the session, even though the same facts have strong visual forms.
Consequences: the rail remains truthful and read-only, uses no decorative fake
metrics or emoji, and retains exact text values alongside every visual. This
adds M12-T12 without changing the 0.2.0 release gate.

### D-68 · 2026-09-06 · Session telemetry does not expose worker plumbing
Decision: remove the Agent process section from the telemetry rail, and let the
project/session status and error surfaces own worker startup or crash failures.
Tool failure counts likewise have one owner: the detailed tool timeline; the
activity strip reports only call sequence and whether work is live or settled.
Why: the process card exposed an implementation detail without giving the
person an action, while repeated failure summaries made the rail noisier rather
than clearer.
Consequences: telemetry is shorter, session-focused and non-duplicative.
Supersedes: D-67 only where it included worker state in the rail.

### D-69 · 2026-09-06 · Fleet order never breaks lineage
Decision: the Fleet renders the run tree recursively. Roots and each parent's
children follow creation time; attention rolls into the ancestor's status but
never reorders a child outside its subtree.
Why: globally sorting a flattened tree by attention preserved each row's depth
number but destroyed adjacency, allowing a child to sit below an unrelated run
and visually inherit the wrong parent.
Consequences: parentage is represented structurally in the DOM and by a
continuous lineage rail, not inferred from indentation. This adds M12-T13
without changing the 0.2.0 release gate.

### D-70 · 2026-09-06 · A workflow child has one panel identity
Decision: when pi-subagents persists a workflow step's launched `runId`, Laser
uses that run id for both the aggregate workflow child and the child's own
status file. The child status retains its workflow key and parent workflow id.
Why: session `01a0750d` proves that pi-subagents writes both records for each
lane. Giving them different panel ids rendered three real workers as six rows
and duplicated their failure states.
Consequences: either record can refresh the same child in place; the Fleet
shows one workflow plus its three real children and keeps the detailed child
record's metrics and controls when it arrives. This adds M12-T14 without
changing the 0.2.0 release gate.

### D-71 · 2026-09-06 · Laser is the product; Pi is the internal engine
Decision: Laser owns the public concepts, settings schema, feature catalogue,
protocol and presentation. Pi remains an exact-pinned execution engine. Logic
that must understand Pi lives in a reusable Pi-native package in this
repository or an exact-pinned upstream package; the companion extension adapts
that logic to engine-neutral protocol, and Laser chooses every visible surface.
People enable curated Features, never install or configure packages through the
normal product UI. Low-level engine settings are internally managed or omitted;
specialist settings live in a permanent Advanced tab, while the existing
catalogue-density switch is renamed Full configuration.
Why: mirroring an engine's configuration and package manager makes Laser feel
like a wrapper and commits its public experience to implementation details that
should be replaceable. The reusable logic boundary respects Pi's APIs and lets
native Pi users adopt the capability without importing Laser's UI.
Consequences: add M12-T15 through M12-T20; migrate supported installed packages
to feature state without deleting unknown configuration; keep temporary package
plumbing internal; add Goals as a bundled feature backed by the exact-pinned
`@narumitw/pi-goal` implementation unless verification proves it unsuitable.
M12-T5 remains blocked until these tasks finish and the user separately
authorizes any release, tag, push, deployment or installation.

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
| Q-6 | Must 0.1.0 wait for the missing mobile `/link` pairing flow, or ship as an explicitly local-desktop preview? | — | answered by D-59: ship local desktop; visible Soon flag on phone remote control |
| Q-7 | Adopt the proposed transcript-only compact density for 0.2.4: 14px/21px prose, tighter block rhythm and 20px message gaps while preserving control sizes and the 12px data floor? | — | answered by D-95: yes |
| Q-8 | Resolved for implementation scope: person authorized a dedicated reviewed extension-generated model-admission seam; preserve goals, Pi pin and policy, no later-release authorization (D-193). | M13-T89, M13-T92, M13-T93, M13-T94 | person; implementation owner queued |

---

### D-33 · 2026-09-05 · `DESIGN.md` is the shape; `docs/ux-theme.md` is the values
Decision: `packages/ui/DESIGN.md` stops naming shipped colour, typeface and radius values. Its palette tables and family names are relabelled the **reference preset** — the roles, proportions and contrast floors every preset must satisfy — and the shipped defaults are whatever `theme/presets.ts` says (today: *graphite* dark / *paper* light, Inter and JetBrains Mono). Its `.dark`-class section is corrected to the `data-theme` attribute the theme store actually writes. Its "Motion" section is rewritten from three moments to the nine the app actually has (sweep, caret, morph, island arrival, sheets, collapsibles, digit rolls, the first screen's stagger, shimmer/attention), each token-driven with a reduced-motion fallback. "Do not use Inter" becomes "do not name a typeface, colour, size, radius or duration in a component".
Why: M11 made every visual value a token the person can change (D-27, `docs/ux-theme.md`), and lane D shipped the morph, the arrival, the digit roll and the empty-state stagger. `DESIGN.md` still forbade the shipped font and a motion budget the app exceeded, with nothing superseding it — which is a quiet exception, the one thing AGENTS.md says a UI change may never be.
Consequences: two documents with two jobs. A reviewer checks *shape* against `DESIGN.md` (which token carries which meaning, the legibility floor, the status language, the key contract, what may move) and *values* against `docs/ux-theme.md` and the presets. A new motion needs an entry in the budget list, not just a token.
Supersedes: the palette, type and motion sections of `DESIGN.md` as previously written.

### D-34 · 2026-09-05 · On a phone an island is two instances, and the strip says so
Decision: `packages/ui/src/panels/MobileIslands.tsx` keeps rendering the strip's `<Island size="minimal">` and the sheet's `<Island size="expanded">` as two React instances. The claim that "same element is literal" is removed from that file and `docs/ux-panels.md` gains the exception: on a phone a panel *is* re-created when it opens into the sheet, and only there.
Why: the desktop dock keys islands by `entry.key` and one `<section>` lives for the life of the panel, which is what makes `minimal` → `maximized` a morph. The phone cannot do that with a Radix sheet: the expanded island's DOM has to live inside `SheetContent`, and the entries reachable from "+N more" have no strip node to portal out of at all. Keeping one instance means either rendering every island in a hidden strip and portalling, or replacing the sheet — both are real work, neither is a bug fix, and this wave had no browser to verify a phone in.
Consequences: on a phone the `StatusDot` sweep restarts when the sheet opens, and body scroll position is not carried between the strip and the sheet (`useScrollMemory` lives in the sheet instance and does survive collapse *within* it). The transition is the sheet's slide, not a morph. A task to make the phone one instance belongs in the panels lane; until it exists this is the recorded exception, not an oversight.

### D-37 · 2026-09-05 · `pi/prefs/*` is host-owned, not an agent setting
Decision: laser's own preferences — the theme first — travel over `pi/prefs/get|set`, are answered by the host, and are persisted to `<stateDir>/prefs.json` beside `projects.json` and `attention.json`. They never go through `pi/settings/set`, and the worker refuses the method with a sentence saying why.
Why: `pi/settings/set` refuses any key the pinned agent does not define, which is correct — that file is the agent's, and a laser key in it is drift that the agent would reject or silently drop on a version bump. But a theme has to reach a paired phone, and `localStorage` cannot. A host-owned channel is the only place a laser preference can live and still be one thing across every device.
Consequences: `localStorage` survives as the pre-paint boot cache only; the host is the source of truth, and a fresh host with no `prefs.json` adopts whatever the browser already had (revision 1) rather than resetting the person's theme. `pi/prefs/updated` fans out through `notify()`, so WebSocket clients and relay listeners both hear it. The namespace is flat (`^[a-z][a-z0-9-]*$`) on purpose: a drawer, not a path, so nothing stored there can look like a filesystem or a prototype chain. Values are capped at `PREFS_MAX_BYTES` and re-parsed on write.

### D-38 · 2026-09-05 · The keybindings adapter reaches into the pinned agent by file URL
Decision: `packages/worker/src/keybindings.ts` loads the agent's `KeybindingsManager` by file URL, because the pinned agent exports it as a **type** and its `exports` map has no subpath for it. This is the same class of exception as `piSettingsStorage` in `settings.ts`, with the same rule: if a later agent moves it, say so in a sentence and change nothing.
Why: the alternative is a table of default bindings copied into this repository, and the agent's defaults are platform-dependent (`ctrl+z` for undo on Windows, `ctrl+-` elsewhere) — so a copied table would be wrong on some machines and nobody would find out until a person's Reset put the wrong key back.
Consequences: `packages/worker/test/keybindings.test.ts` runs against the pinned agent **for real**, so a pin bump that moves the manager, renames an action or changes a default fails there rather than in a person's Settings screen. Add it to the MX-T2 checklist. Writes take an exclusive `wx` lock with stale takeover plus an in-process queue and an atomic tmp+rename: the agent never writes this file, so the only racer is laser against itself (keys are global, workers are per project).

### D-39 · 2026-09-05 · npm packages are pinned by the host, not by the agent
Decision: every npm install requested from the UI or the CLI is resolved by the **host** to one exact release and written into settings as `npm:<name>@<exact>`. The registry-declared integrity and resolved URL go into `<stateDir>/packages.lock.json`. Git and local sources pass through unchanged.
Why: the settings file is what the agent reproduces an installation from, and a range in it is drift — the same settings file gives two different machines two different extensions, and nothing on screen says so.
Consequences: "Update" installs a **new pin**; it is never a `latest` re-resolution by the agent. `laser packages install` gets pinning for free, because it goes through the same router. The lock is drift *detection*, not a second source of truth: the pin is what reproduces.

### D-40 · 2026-09-05 · The package manager comes out of the Node archive already pinned
Decision: laser ships npm, taken from the same `node-v<version>-<target>` archive whose SHA-256 is committed in `packages/desktop/runtime.json`, staged beside the runtime binary and named to the host through `LASER_NPM_CLI`.
Why: Settings installs extensions, which needs a package manager, and a person who installed a desktop app has no npm on PATH and must never be told to go and get one (AGENTS.md: the person never needs a terminal). Downloading npm separately would mean a second artifact, a second hash to keep in git, and a second thing to bump. Taking it out of the archive already being verified means one download, one check, and no version to keep in step.
Consequences: ~19 MB per platform in the package. `before-pack` refuses to build if it is missing. In a development build that has never staged a runtime there is none, and the Extensions screen says installs are unavailable and why rather than falling back to the machine's own npm — which would make a developer's machine pass a check a person's machine fails.

### D-41 · 2026-09-05 · One version across the whole workspace
Decision: every `package.json` in the repository carries the same version, set by `scripts/release/set-version.sh`, and `scripts/release/publish.sh` refuses a tag that disagrees with any of them. The pinned Node (`runtime.json`) and the pinned agent (`packages/worker/package.json`) are deliberately **not** touched by it.
Why: `laser --version` reads the CLI's manifest, the AppStream `<release>` entry reads the desktop's, and the tag names the release. Three answers to one question is how a bug report becomes unreproducible.
Consequences: the workspace is at `0.1.0`, which is the first release. A package that genuinely needs its own version needs a decision that supersedes this one, not a quiet exception.

### D-42 · 2026-09-05 · Build provenance is required, not reported
Decision: `install.sh` **refuses** a release with no GitHub build provenance. `--allow-unattested` is the opt-out for a release assembled by hand; a provenance check that *fails* stays fatal with no flag at all. The verify call now passes `--signer-workflow <repo>/.github/workflows/release.yml`, and "no attestation" is matched on gh's exact wording rather than on `not found`/`404`. An old `gh` with no `attestation` command is a refusal, not a pass.
Why: the previous default rested the whole chain on `SHA256SUMS`, which is downloaded from the same release as the artifact — so it proves the two files were served together and nothing more. Anyone who could replace one could replace both. And `--repo` alone accepts *any* workflow in the repository, so anyone who can push a workflow file could mint provenance for bytes of their own choosing.
Consequences: a hand-staged release is installed with one extra flag, and `publish.sh` says so when it stages one unsigned. `--require-attestation` is kept as an accepted no-op so an older documented command still works.
Supersedes: the "reports it honestly" half of M10-T1's original trust note.

### D-43 · 2026-09-05 · laser's launcher is the entry point in every format
Decision: `install.sh` points the `bin/` symlink and the `.desktop` entry at the AppDir's `laser` launcher, and only falls back to `AppRun` if a build has no launcher at all.
Why: electron-builder's AppRun is written for a mounted AppImage. It assigns `APPDIR`/`APPIMAGE` without exporting them, silently prepends `--no-sandbox` when its `unshare` probe fails (or when `unshare` is simply absent), needs `bash`, and rewrites `PATH`, `LD_LIBRARY_PATH` and `XDG_DATA_DIRS` for laser and for every process the agent goes on to spawn. Our launcher makes the same three decisions deliberately and says what it decided.
Consequences: the AppImage format and the tarball land on one code path, which was the stated intent all along. The AppDir still contains `AppRun` — a double-clicked, unextracted AppImage goes through it, and the launcher recognises and undoes its injection.

### D-44 · 2026-09-05 · The bundled npm is found beside the runtime, never taken from PATH, and never runs an unreviewed install script
Decision: `detectInstallRuntime` probes `<node>/../npm/bin/npm-cli.js` (the packaged layout) before the stock-Node layout, skips the `PATH` search entirely in a packaged install, and always passes `--strict-allow-scripts`.
Why: three separate holes. (1) `LASER_NPM_CLI` is set only by the Electron shell, so a host started by `laser up` in a terminal — which the window then *adopts* — found no installer and Settings said "the installer it ships with is missing. Reinstall laser", which is false and which reinstalling cannot fix. (2) On a developer's machine it fell through to `/usr/bin/npm`, so a build whose whole claim is that it resolves nothing from `PATH` was resolving its package manager from `PATH`. (3) npm 11 runs an unreviewed `postinstall` with a notice on a stream this UI never renders, and the Extensions gallery is a live `registry.npmjs.org` search filtered only by a keyword any publisher can set — one click from a stranger's code running against the person's home directory, with no dialog, while *removing* an extension has one.
Consequences: an extension that needs an install script now fails the install by name instead of running it, which is a conversation laser can have with the person; today none of the curated set needs one. A development checkout that has never staged a runtime still falls back to `PATH`, because there is nothing else there.

### D-45 · 2026-09-05 · An integrity hash is stored only once it has been checked
Decision: after an install, the host compares the registry-declared `integrity` against the one npm recorded in the install prefix's own `package-lock.json`. They differ → the install is refused and nothing is kept. Nothing to compare → **no hash is recorded at all**.
Why: the host resolves a version against the registry, and npm then does its *own* metadata fetch and installs whatever tarball its answer names. The version string matching proves nothing about the bytes, and a mirror, a proxy or an `.npmrc` with a `registry=` line can differ. Settings printed the recorded `sha512` beside the source and the path, which reads as a verification receipt for a check that never ran.
Consequences: `packages.lock.json` gains meaning — a hash in it was checked against disk. Some installs record no hash, which is the honest answer. Amends D-39, which is otherwise unchanged.

### D-46 · 2026-09-05 · The CLI does not read the agent's own directory variables
Decision: `resolvePaths` no longer reads `PI_CODING_AGENT_DIR`, `PI_CODING_AGENT_SESSION_DIR` or `PI_SUBAGENTS_TEMP_ROOT`. `piEnv()` still *writes* all three for anything laser spawns.
Why: `packages/desktop/src/agent-home.ts` deletes those variables from the environment on purpose — in a desktop session they mean "the agent I use in my shell", the one installation laser must never adopt. The CLI honouring them meant that for exactly the person that file exists to protect, `laser settings set` wrote their global `settings.json` and `laser sessions` listed their sessions while the window showed none.
Consequences: a person who genuinely wants both to share a directory sets `LASER_AGENT_DIR`, which is the documented lever and the one the app respects too.

### D-47 · 2026-09-05 · First run owns the whole window
Decision: while `pi/setup/state` says setup is pending and no session is open, the shell renders the flow alone — no rail, no sessions panel, no top bar, no dock, no telemetry. Skipping asks first and names the way back (Settings → This device → Run setup again), which now exists. The step counter counts the three steps a person takes, not the five screens.
Why: mounted inside the shell, the first screen argued with itself in four vocabularies at once, two of which bypassed the flow; "Skip setup" was a ghost button that permanently retired the onboarding; and the eyebrow said "1 of 5" beside a sentence that said "three short steps".
Consequences: `HostConnectionState` is the one thing kept, because the flow cannot continue without a host. Settings routes its two global tabs (Extensions, Providers and models) through the host's setup directory, so they are reachable before a project exists.

### D-48 · 2026-09-05 · The wire namespace is frozen, and does not follow a rename

Decision: `product.json` carries `wireNamespace` beside `name`, and a rename changes `name` and leaves `wireNamespace` alone. It spells the relay's WebSocket subprotocol (`<ns>.channel.<id>`), the Pi event-bus events the companion extension listens on (`<ns>:panel`), the `<ns>/…` session-message types, the marker written into pi-subagents' control files, and the HKDF labels that derive a paired device's channel keys. TypeScript reads it as `WIRE_NAMESPACE`, typed as the literal so it can sit in a discriminated union.

Why: those strings are a contract with other processes and with bytes already on disk, not a name a person reads. Renaming the HKDF labels would make two already-paired peers derive different keys and fail to connect with nothing on screen to explain it; renaming the bus events would break every third-party extension that emits a panel; renaming the message types would make sessions already recorded unreadable. A rename that quietly did all three would be the most expensive kind of correct-looking change.

Consequences: `scripts/identity/check.mjs` strips wire-shaped occurrences before it scans for the product's name, so they are not reported as places that failed to derive. The pattern is anchored: not preceded by `.`, `/` or a word character, and each alternative is whole segments (`<ns>:…`, `<ns>/…`, `<ns>.channel.`, `<ns>.<word>.v<n>`, `<ns>-…-v<n>`). The anchor is load-bearing rather than cosmetic — the first version matched `<ns>/[a-z/:]+` open-ended, which read `~/.piorbit/state` as the wire path `piorbit/state` and swallowed a hardcoded data directory, the single thing a rename most needs to catch (proved with four probes; see D-50). The day a protocol break is actually wanted, the namespace gets a version suffix rather than a new spelling. Amends D-36, which is otherwise unchanged.

### D-49 · 2026-09-06 · The desktop keeps its own Node, and does not run the host on the app binary

Decision: `packages/desktop` continues to ship a stock Node 24.20.0 next to Electron and spawn the host with it. Running the host on the app binary under `ELECTRON_RUN_AS_NODE` — which works end to end and would take ~121 MB off an unpacked install — is rejected.

Why: three reasons, each measured on the packaged build rather than argued.
(a) **pi-subagents resolves its own interpreter from `process.execPath`.** `pi-subagents@0.65.1` `src/shared/node-executable.ts:18` returns `process.execPath` when it looks like Node and the string `"node"` otherwise, and `async-execution.ts:593` spawns that with no shell. Under the bundled Node it resolves to the bundled Node; under the app binary it resolves to whatever `node` is on the machine's PATH — here `/usr/bin/node` v18.19.1, against a pinned agent that declares `engines.node ">=22.19.0"`. M3 is pi-subagents support and the package is installed from Settings, so this is a shipping feature breaking, not a hypothetical; it is not in the app bundle today, which only means the break waits for the first person who installs it.
(b) **The two interpreters disagree about ABI.** Same `process.version` (`v24.20.0`), different `NODE_MODULE_VERSION`: 137 for the bundled Node, 149 for the app binary. node-gyp keys its headers off `process.version`, so a native module built by an extension install would target 137 and the app binary would refuse to load it.
(d) **Electron links BoringSSL.** `process.versions.openssl` is `0.0.0` and `crypto.getCiphers()` has no `chacha20-poly1305`; the bundled Node has both.
Also confirmed and not load-bearing: an `ELECTRON_RUN_AS_NODE=1` binary with no script exits 0 and silently, and `dist/utils/shell.js:123` spreads `process.env` into every spawn, so a leaked `ELECTRON_RUN_AS_NODE` would be inherited by children.

Consequences: no cheap size win was found to move to. `app.asar.unpacked` is 81 MB apparent (107 MB on disk) and its largest entries are live: `@esbuild/` stages only `linux-x64` (11 MB, a runtime dependency of `@earendil-works/chord`), and `@aws-sdk` is `client-bedrock-runtime` (2.7 MB apparent with `@smithy`) — the Bedrock provider. The app is ~498 MB unpacked because Electron is 218 MB and a second interpreter is 121 MB, and both are load-bearing. The existing defences stay and are the point: `resolveNodeRuntime` hard-rejects an Electron answer (`runtime.ts:126`), and `electronFreeEnv` deletes every `ELECTRON_*` and `NODE_OPTIONS` before spawning the host (`host-process.ts:374`).

### D-50 · 2026-09-06 · The identity check scans former names, JSX text and JSON values

Decision: `scripts/identity/check.mjs` builds every pattern over `[name, ...formerNames]` rather than the current name alone; `scripts/identity/scannable.mjs` keeps JSX text children for `.tsx`, and scans `.json` values; and `product.json`'s `vendor` is a template (`{displayName} contributors`) rather than a written name. Two internal `bin` names (`<binary>-host`, `<binary>-worker`) became generated artifacts.

Why: the check could only ever see the name it was told to look for, so it reported success on a half-finished rename — proved by renaming to `wavelet`, regenerating, and watching it pass with `copyright: Copyright © laser contributors` still in `electron-builder.yml`. Separately, `.tsx` went through a string-literal-only scan, and JSX children are not quoted: seventeen sentences the app actually shows — the first-run flow, the sign-in sheet, the trust dialog, the update banner — were blanked before the scan and would have shipped the old name on the screens a new person sees first. `.json` was skipped entirely, which hid two `bin` names, three package descriptions and the desktop runtime's own comment.

Consequences: 24 real strays were found and fixed, including a session-specific agent scratchpad path baked into a test as a default. The scan still exempts comments, identifiers and the npm scope on purpose; what changed is that "value" now includes what a person reads on screen. `identity:check` runs inside `pnpm -r build` and `pnpm -r test`, so this is enforced, not documented.

One hole is left open knowingly: `<name>-<word>-v<n>` is exactly the shape of the frozen HKDF labels (`piorbit-pairing-channel-v1`, `piorbit-device-list-v1`, `piorbit-sas-v1`), so a hand-typed value of that shape — a service-worker cache prefix, say — is still stripped. Narrowing it further would mean either listing the three crypto files by path or reporting real wire labels as failures on every run. The proof was a real rename: with `name: wavelet` and `formerNames: ["piorbit"]`, three of four planted probes were caught (`".piorbit/state"`, `"Welcome to piorbit"`, `probe_dir="$HOME/.piorbit/state"`) and `"piorbit-shell-v1"` was not.

### D-72 · 2026-09-06 · The product boundary is a clean break

Decision: Laser has no legacy-user migration. Project settings live only in
`<project>/.laser/settings.json`; `<project>/.pi`, Pi trust, automatic engine
resource discovery, public package installation and public Pi passthrough are
unsupported. The worker applies validated Laser settings as in-memory overrides
and loads reviewed built-ins by exact path.

Why: the user confirmed there are no existing users and explicitly authorized
the breaking change. Carrying compatibility would preserve exactly the public
engine coupling this iteration removes.

Consequences: supersedes D-71's migration and temporary-plumbing consequences,
and changes M12-T16/M12-T20 from migration work to clean-break verification.
Internal wire names may remain until separately versioned, but the host rejects
package operations and no product UI or CLI exposes them.

### D-73 · 2026-09-06 · Dictation is core, with provider readiness at setup

Decision: dictation is built into Laser and never appears in Features. The exact
reviewed `pi-gpt-transcribe` core is pinned inside the worker. Settings →
Providers and models owns the persistent note because it is where the missing
dependency is resolved; the microphone action repeats the actionable failure by
checking readiness before it asks for microphone permission.

Why: availability is not a user choice. The only conditional is whether an
OpenAI platform API key can authorize the transcription endpoint; ChatGPT
account sign-in alone cannot. Showing this on a feature card would teach the
wrong model and make a provider problem look like an installation problem.

Consequences: add M12-T21. The upstream OAuth success logo stays unchanged for
now: the pinned dependency hardcodes the page and offers no branding seam, so a
Laser override would require a fork or runtime patch and violate the user's
"only if easy and pattern-safe" condition.

### D-74 · 2026-09-06 · Voice and keyboard share the live composer

Decision: Laser dictation follows the upstream terminal interaction: audio is
cut at natural pauses, phrases transcribe concurrently, results are delivered
in spoken order and each lands at the person's current caret while keyboard
editing remains enabled. Sending first drains the open phrase and pending
transcriptions. The UI owns Web Audio capture and its token-driven waveform;
the worker keeps the exact-pinned transcription request and credentials.

Why: the user identified this as the existing package's defining experience.
The official OpenAI model docs also distinguish low-latency Realtime transcript
deltas from completed/committed phrase transcription; switching APIs would add
different cost and semantics without being needed to match upstream.

Consequences: extend M12-T21. Phrase insertion briefly lights the composer edge,
pending phrases stay visible beside the sound-reactive waveform, and reduced
motion still presents the same state without decorative movement.

### D-75 · 2026-09-06 · Slash completion owns only the first token

Decision: slash command detection only runs when `/` is the first character.
Selecting a command replaces only the typed leading token and preserves the
remaining draft byte-for-byte.

Why: completion previously replaced the whole composer after assistant-ui had
already removed the trigger span, permanently deleting arguments and later
text. Commands are only unambiguous at the beginning of a prompt.

Consequences: add M12-T22 and regression tests for keyboard/pointer-equivalent
selection, suffix preservation and rejection of mid-draft slashes.

### D-76 · 2026-09-06 · Adding a project means choosing a folder

Decision: Add Project is a native desktop folder-selection action. Laser does
not expose a directory path field, paste target or recent-path shortcut as an
alternative. A non-desktop client explains that projects are added from the
computer running Laser rather than pretending it can browse that filesystem.

Why: a path field makes people reason about host paths, allows typing errors and
does not behave like a desktop project picker. The Electron bridge already owns
the correct operating-system chooser.

Consequences: add M12-T23. Every Add Project trigger uses the same shell action;
opening it in Electron launches `chooseDirectory()` immediately and cancellation
is a clean no-op.

### D-77 · 2026-09-06 · Provider marks come from one AI-native catalog

Decision: use the maintained Lobe Icons package as Laser's source of truth for
built-in provider artwork. Normalize marks through one 24-unit frame and Laser
theme ink. Region, billing-plan and gateway variants reuse their parent brand;
only genuinely custom provider ids may use the generated fallback.

Why: Simple Icons is the broad company-logo catalog, but Lobe Icons applies the
same maintained approach specifically to AI models, providers and applications
and covers the niche provider set Laser actually exposes. A package dependency
keeps provenance and future updates reviewable instead of accumulating copied
SVG paths from unrelated sources.

Consequences: add M12-T24. The exact pinned Pi provider manifest is an exhaustive
test fixture: all 40 ids must resolve to a catalog mark, while caller sizing and
theme tokens remain authoritative.

### D-78 · 2026-09-06 · Startup restoration is an atomic visual transition

Decision: Laser does not mount the operational shell until the remembered
project and session have either restored completely or definitively failed.
During that boundary it renders one branded, token-driven beam transition tied
to the actual restore state; it does not add an artificial minimum delay.

Why: briefly showing the first project and an empty session is not harmless
loading chrome. It communicates the wrong active process, then moves the person
without input. A real restoration boundary prevents the false state and gives
slow starts an intentional identity while fast starts remain fast.

Consequences: add M12-T25. Deep links and ordinary remembered-session startup
share the gate; first-run remains its own full-window flow after restoration;
reduced motion keeps the same status without traveling beams.

### D-79 · 2026-09-06 · Open core with a commercial path

Decision: license the Laser application under AGPL-3.0-only and offer the same
AGPL-covered code under a separate commercial agreement. License the reusable,
engine-neutral protocol and Pi-native goal package under Apache-2.0. Software
licenses do not grant the Laser name or logo.

Why: the AGPL preserves source availability when modified Laser deployments are
offered over a network, while a separately negotiated commercial license makes
proprietary embedding and hosted products possible. Apache-2.0 keeps adoption
friction low at the public integration seams and includes an express patent
grant. Trademark separation lets compatible forks exist without appearing to
be official Laser builds.

Consequences: add M12-T26, canonical license texts and path-level metadata;
ship the legal files inside binary distributions. Commercial terms remain a
separate written agreement, not a blanket public grant.

### D-80 · 2026-09-06 · Archived transcripts do not pin project navigation

Decision: an unpinned project discovered only from archived transcripts is
absent from the project rail. A pinned project or a project with an open or
unarchived session remains visible. The transcripts stay on disk and remain in
Archived.

Why: the host catalog intentionally counts every transcript on disk, while
archiving is a client-visible organization choice. Treating that disk count as
the rail count makes Remove project falsely claim that archived chats are still
active work.

Consequences: add M12-T27. Project visibility observes archive changes; removal
copy reports unarchived sessions and preserves the existing open-session guard.

### D-81 · 2026-09-06 · Project priority is one host-owned order

Decision: project priority is the order returned and persisted by the host.
The project rail edits it through accessible drag-and-drop, and every project-
grouped navigation surface consumes the same ordered list.

Why: two client-local orders could drift between the rail, session groups,
devices and restarts. The host already owns project identity and persistence.

Consequences: add M12-T28 and a protocol reorder operation. New or previously
unordered projects follow the ordered projects with a deterministic name sort.

### D-82 · 2026-09-06 · Manual ordering only where position communicates intent

Decision: drag ordering belongs on the project rail and dock panel canvas.
It does not apply to attention-ranked chats, chronological fleet/timeline
views, settings rows or provider/model search results.

Why: project and panel placement express a person's priority and workspace
arrangement. The other surfaces encode urgency, time, hierarchy or filtered
data; manual ordering would make those signals ambiguous.

Consequences: add M12-T29. Panel order is remembered per session and exposed
through pointer, touch and keyboard controls with a visible drag handle.

### D-83 · 2026-09-06 · Tool aggregation is chronological, detail remains canonical

Decision: one uninterrupted run of tool calls is represented by one collapsed
activity row, even when it mixes reads, edits, commands and searches. The row
counts and names each action family in first-seen order; opening it renders the
existing individual rows unchanged. While active, the same row uses the
assistant-ui thinking indicator to name the precise call in flight. Conversation
and prose widths are shared semantic theme measures rather than component-local
literals.

Why: grouping by tool family split ordinary work into one-item groups that
could not collapse, while a generic total hid what happened. A counted parent
reduces transcript noise without weakening audit detail. A modestly wider
measure uses the available canvas without letting related surfaces drift.

Consequences: add M12-T30 and M12-T31. Reasoning, prose and other message parts
remain chronological boundaries; errors and pending decisions still open the
group automatically.

### D-84 · 2026-09-06 · Exact timestamps are interaction detail

Decision: message timestamps are visually hidden at rest on fine-pointer
devices and reveal with the message row's existing hover/focus behavior. They
remain visible on coarse pointers and announced to assistive technology. Day
separators and elapsed/token metrics keep their current visibility.

Why: a clock on every block adds repeated visual noise without helping the
normal reading path, while hover/focus preserves exact timing when requested.

Consequences: add M12-T32 and apply one shared reveal rule to user, assistant
and notice timestamps.

### D-85 · 2026-09-06 · Composer guidance is reference material; code grammar is complete

Decision: chat does not reserve a permanent row beneath the composer for git
status or keyboard hints. Composer guidance lives in Settings under Help and
shortcuts. Markdown keeps the assistant-ui Shiki renderer, but uses its full
TextMate-compatible engine and bundled language catalog rather than the
restricted JavaScript-regex engine; Laser's semantic syntax tokens still own
all colours.

Why: repeated instructions consume scarce vertical space after they are
learned. Shiki is already the stronger renderer and includes the required
catalog; the observed gaps come from its constrained engine, incomplete scope
theme and literal fence variants, not from needing a second highlighting stack.

Consequences: add M12-T33 and M12-T34. Streaming fences remain plain until
settled to avoid re-tokenizing partial code, and unknown languages remain safe
plain text.

### D-86 · 2026-09-06 · Native notifications share the visible session title

Decision: the desktop fleet resolves a session label from its explicit name,
then its catalogued first user message, matching the normal chat-list fallback.
If neither exists, notification prose refers generically to “the session” and
never invents an “Untitled session” name.

Why: the fleet discarded `firstMessage`, so Ubuntu banners called a session
untitled while Laser visibly named that same session from its first prompt.

Consequences: add M12-T35. The desktop remains independent of the UI package;
the small fleet model carries only the resolved plain-text label it needs.

### D-87 · 2026-09-06 · Fleet lifecycle sections preserve whole run trees

Decision: the fleet has a prominent In progress section and a collapsible
Finished section. Classification happens at the root subtree: if any node in a
workflow is still queued, running, paused, pending or blocked, the whole tree
stays active; it moves as one unit only when every node is terminal.

Why: terminal and active work need separate scanning zones, but extracting a
finished child from a live workflow would recreate the false-parentage bug the
tree model was designed to prevent.

Consequences: add M12-T36. Done, failed, skipped and cancelled remain visibly
distinct on their own rows inside Finished. Background terminals are outside
this task.

### D-88 · 2026-09-06 · Ship the accumulated experience batch as stable 0.2.2

Decision: 0.2.2 is the next stable patch and contains the wider transcript,
aggregate live tool activity, interaction-only timestamps, compact composer,
full Shiki highlighting, truthful notification titles and lifecycle-separated
fleet. The cache-write diagnosis changes no accounting in this release.

Why: the user explicitly approved a new stable patch after the full 875-test
workspace gate passed.

Consequences: add M12-T37. The version is changed through the repository's
single workspace-version script, and the release is complete only after both
architectures, staged installation, provenance and native package feeds pass.

### D-89 · 2026-09-06 · Reasoning is part of one transcript activity disclosure

Decision: adjacent reasoning and tool parts share one aggregate disclosure.
Its settled row uses a deliberately muted surface and lists “Reasoned” beside
counted tool families; its live row uses the assistant-ui thinking indicator
for either active thought or the exact tool action. Expansion preserves full
reasoning Markdown and every existing tool row in their original order.

Why: thought and action are one stretch of agent work. Rendering reasoning as a
separate full block defeats the scan-friendly parent level and makes the muted
action summary look unrelated to the work that produced it.

Consequences: add M12-T38 and M12-T39. The per-session expanded-thinking
preference opens a group containing reasoning; failures and decisions still
force it open. Stable 0.2.3 may build concurrently with the tagged 0.2.2 run.

### D-90 · 2026-09-06 · Account allowance and API spend never share a measure

Decision: classify every persisted assistant turn by billing mode. API-only
sessions keep the existing spend and token instruments. OpenAI Codex account-
only sessions replace them with authoritative allowance windows, reset times
and purchased-credit balance. Mixed sessions get Account and API tabs; values
from the two billing systems are never added, compared or plotted together.

Why: subscription quota is server-owned account state, not a token price. A
single total would be mathematically false and could imply a bill that does not
exist. The transcript still determines which views belong to this session.

Consequences: add M12-T40. The Pi companion reads the account endpoint with
Pi's existing OAuth credential and sends only normalized, non-secret values.
The protocol stays provider-neutral so another subscription provider can add a
reader later without changing the UI contract.

### D-91 · 2026-09-06 · One activity parent, three session-scoped detail levels

Decision: every uninterrupted reasoning/tool sequence, including a single
tool, keeps one aggregate activity parent. Its per-session default has three
levels: Answers only keeps the parent closed; Show reasoning opens parents that
contain reasoning while individual action bodies stay folded; Show everything
opens the parent and every action body. A person's click overrides the default
for that row, while errors and decisions still force visibility.

Why: separate presentation rules for lone reasoning, one call and many calls
make the transcript change grammar as work grows. The three levels adjust
density without changing what an expansion contains or inventing a second
renderer.

Consequences: add M12-T41. The existing assistant-ui Tool group remains the
only parent, and its children remain the same ReasoningText and tool rows used
elsewhere. The old binary expanded-reasoning preference is removed.

### D-92 · 2026-09-06 · Model menus open in session context

Decision: the chat model menu derives its provider filter from the selected
session model whenever it is closed, so opening it starts inside that routing
provider with the existing model marked. Search and provider changes remain
temporary exploration and reset on close.

Why: the picker is an editor for the session's current choice. Opening at an
unrelated all-provider catalogue makes a correct saved selection appear lost
and forces repeated navigation.

Consequences: add M12-T42. The shared assistant-ui selector context exposes its
open state, while the settings pickers inherit the same sensible initial state
without persisting transient filters.

### D-93 · 2026-09-06 · Adaptive session controls ship as stable 0.2.4

Decision: publish the verified post-0.2.3 account/API telemetry, activity-detail
levels and context-preserving model picker together as the stable 0.2.4 patch.

Why: these changes are compatible refinements to the installed 0.2 line and
the user explicitly requested a new release after the final picker adjustment.

Consequences: add M12-T43. The version-only commit and v0.2.4 tag must point to
the same source, and the release is complete only after both architectures and
native update feeds pass.

### D-94 · 2026-09-06 · New sessions start with activity collapsed

Decision: Answers only is the default activity-detail level for any session
without a saved preference. Reasoning, aggregate actions and inner tool details
all start collapsed; attention states may still force visibility.

Why: the transcript should begin as a readable answer-first surface, and people
who want a more verbose default can opt into it per session.

Consequences: the 0.2.4 release gate includes a regression test for the absent-
preference path as well as the three expansion helpers.

### D-95 · 2026-09-06 · Compact density belongs to the transcript, not the shell

Decision: reduce assistant and user transcript prose from the 15px reading
scale to the existing 14px body scale, reduce message-stack gaps from seven to
five spacing steps, and tighten prose blocks and user-bubble padding by one
spacing step. Keep controls, the composer, metadata, touch targets, the 80ch
prose measure and the 12px data floor unchanged.

Why: the screenshot shows excess density in the conversation itself, while the
surrounding navigation and controls already use the compact 12–14px hierarchy.
A global scale reduction would damage targets and metadata without addressing
the 28px message rhythm that makes the thread feel especially loose.

Consequences: add M12-T44 and make it a prerequisite for the recreated stable
v0.2.4 tag. The compactness remains token-led and isolated to assistant-ui's
message, Markdown and thread elements.

### D-96 · 2026-09-06 · One activity-row grammar

Decision: add M12-T45; every action, including reasoning, has the same quiet
summary-row anatomy and its own reversible disclosure inside the aggregate.
Why: the user needs one recognizable activity treatment while scanning answers.
Consequences: reuse the adopted assistant-ui disclosure parts; retain full bodies
and prove interaction rather than relying only on summary or style-source tests.

### D-97 · 2026-09-06 · Inspect recorded requests, not a reconstructed prompt

Decision: add M12-T46 and release task M12-T47. A shared inspector groups common
provider payload fields while retaining full JSON and unknown fields. New
captures carry the nearest user entry on the engine's active branch; older
captures, missing logs, retries and continuation calls are explicitly labelled.
Why: a developer needs the captured request behind a particular prompt, including
system instructions and tool schemas, without leaking credentials or confusing
a reconstructed prompt with recorded data.
Consequences: extend the existing neutral log protocol/store and companion hook;
no provider SDK import in the UI or host. Publish stable 0.2.5 and its release page
after verification, as requested.

### D-98 · 2026-09-06 · Do not attach a new desktop to an old service

Decision: add M12-T48 as a release prerequisite. Compare the running service's
recorded version to the bundled CLI before desktop adoption. On mismatch, explain
how to finish work and fully restart; never silently kill a shared daemon.
Why: installing new files does not update JavaScript already loaded in memory.
Consequences: unknown quota-method errors become actionable restart guidance;
fresh-host quota routing and credential failures are release regression tests.

### D-99 · 2026-09-07 · Explicit headless resources and version-tolerant inspection

Decision: add M12-T49 and M12-T50. Laser asks Pi to load skills and prompts only
from explicit product, Agent Skills and curated-feature roots; it never restores
implicit `.pi` discovery. The composer advertises only commands that can run in
the headless engine and follows Pi's command-identity matching. Captured-request
inspection prefers exact links but retries the earlier read-only log-query schema
when an operating-system update has replaced files beneath a still-running host.
Its optional Markdown presentation is the chat renderer and a machine preference.
Why: hiding Pi resources broke skills, while advertising terminal-only commands
would create inert UI. Separately, package installation does not replace code
already loaded by a daemon, so a new frontend can temporarily speak to an older
schema even though both versions are correct in isolation.
Consequences: skills work before and after a session exists without treating Pi
configuration as product configuration; request inspection remains useful during
safe update skew, labels timestamp attribution as legacy, defaults to plain text,
and never reconstructs or mutates a provider request.

### D-100 · 2026-09-07 · Updates refresh the daemon instead of widening the UI protocol

Decision: supersede D-98 and the request-compatibility part of D-99. A native
deb/rpm upgrade sends the existing packaged daemon a graceful SIGHUP after the
new files are installed; its desktop supervisor starts the new generation. On
any later launch, a version mismatch is also stopped safely and replaced before
the UI connects. Remove the inspector's old-host query fallback.
Why: the API-request failure was process lifecycle skew, not a request-inspector
compatibility problem. With no legacy user base, maintaining parallel schemas
would preserve the wrong boundary and add code to every future feature.
Consequences: one daemon and UI generation run together. Active state closes
through the existing graceful host shutdown, and a command-started daemon stays
down until the next app launch or `laser up` rather than being relaunched as root.
Supersedes: D-98 and the version-tolerant inspection clause of D-99.

### D-101 · 2026-09-07 · Ship the command and lifecycle fixes as stable 0.2.6

Decision: add M12-T51 and publish the verified change set as stable patch 0.2.6.
Create the release and push its immutable tag after main; do not wait for or
monitor the tag-triggered GitHub Actions workflow.
Why: the user explicitly approved immediate publication and prefers reporting
any CI failure later rather than holding this session open.
Consequences: the release page may exist briefly before its architecture assets,
attestation and native updater feeds arrive. Publication is complete only when
the workflow later succeeds, but this session records dispatch rather than
claiming unobserved artifacts.

### D-102 · 2026-09-07 · Live activity belongs to the executing row

Decision: add M12-T52 to the unreleased 0.2.6 patch. The aggregate and its active
child share the activity beam; thinking is a reasoning phase, never a generic
indicator for tool execution.
Why: the user reported missing row motion and stale thinking during commands.
Consequences: verify the reasoning-to-tool-to-answer transition before release.

### D-103 · 2026-09-07 · One canonical session row in compact navigation

Decision: add M12-T53 before 0.2.6. Reuse the assistant-ui thread-list primitives
with quiet folder headers, rounded single-line rows and client-local pin order.
Pins move their session out of its project group into Pinned, respect the project
filter, and show a small project label. Activity appears only on the session row;
remove the separate sidebar inbox, project badges and project activity rings.
Why: the user requested filesystem-like scanning and identified triplicated
attention for the same chat. Pins need project context without a second row.
Consequences: newest-first project rows no longer reorder by attention priority;
full title, project path, preview and time remain available in the row tooltip.
The Superdesign approval-round workflow conflicts with the user's direct-delivery
instruction; implement the supplied references directly and review the real app.
Supersedes: the sidebar row anatomy and aggregate attention portions of D-20.

### D-104 · 2026-09-07 · Full-history find without mutating conversations

Decision: add M12-T54 before the pending release. A host-owned read-only search
scans saved message content without opening workers. Current-session find uses
the hydrated/live transcript, with reversible disclosure and exact match excerpts.
Sidebar excerpts occupy normal document flow, never hover over other rows.
Why: title/preview matching misses conversation history; browser find misses
closed tool and reasoning bodies. Search must not edit drafts or engine state.
Consequences: bounded result pages explicitly offer more results and older date
ranges (30 days, then 90 days, then one year, then earlier history). Across the
searched range, user content outranks assistant replies, which outrank reasoning
and tools; newest sessions break ties. Excerpts identify their source. Stale
replies cannot replace a newer query. Command escape characters remain untouched,
as requested.

### D-105 · 2026-09-07 · Per-message timestamps replace day dividers

Decision: remove transcript day separator rendering and the separator component.
Keep the timestamp on every user, assistant and notice message, including its
natural full date description for hover and assistive technology.
Why: repeated horizontal date dividers consume space and duplicate information
already available on each message.
Consequences: calendar transitions no longer add layout or a semantic separator;
the timestamp remains the single source for when a message was created.

### D-106 · 2026-09-07 · Tool search is a content contract

Decision: add M12-T56. History and session find share engine-neutral tool content selectors; structural JSON keys are never search content. Renderer authors must maintain the selector and highlightable content together.
Why: indexing serialized requests creates matches that cannot be meaningfully located in the conversation.
Consequences: document the contract and test both indexing and rendered value highlights. No provider or engine imports enter the shared implementation.

### D-108 · 2026-09-07 · Diagnostics search includes the complete retained payload

Decision: add M12-T57. Request search offers current-section content and full retained request JSON, including keys, values and syntax. It does not inherit conversation tool-value exclusions.
Why: request inspection is a low-level diagnostic surface; filtering whole cards does not locate an instruction or explain what matched.
Consequences: highlight and navigate actual rendered text, reveal folded content transiently, preserve Markdown preferences and credential redaction, and never imply an oversized truncated capture is complete.

### D-110 · 2026-09-07 · File tools share the transcript syntax grammar

Decision: add M12-T58. Read, write and edit tool bodies infer language from their
target path and reuse the established Shiki grammar, theme tokens and lazy load.
Why: file tools currently preserve line-level changes but flatten source syntax,
making code materially harder to scan than the same source in a Markdown fence.
Consequences: highlighting remains presentational; tool payloads, diff semantics,
searchable value regions and unknown/plain-text files retain their existing behavior.

### D-111 · 2026-09-07 · Repair the verified quota route and release 0.2.7

Decision: add M12-T59 and M12-T60. Keep Pi-owned authentication and query the verified account usage endpoint directly. Preserve named buckets as independent windows in the neutral protocol; never sum their percentages. Include user highlighting in stable 0.2.7 and dispatch without waiting for Actions.
Why: authenticated probes reproduce a false reconnect error before the working endpoint is reached; a second CLI dependency is unnecessary for this fix.
Consequences: endpoint-specific tests and authenticated smoke checks supplement mocked parser tests. Security challenges are not authentication failures. The endpoint remains an isolated maintenance boundary, not a claimed public REST contract.

### D-112 · 2026-09-07 · Explain account buckets without inventing provider semantics

Decision: add M12-T61. Group normalized windows by stable bucket identity, retaining every window and separate percentages; use names only when no identity exists. Add a shared reset-time display choice and source-linked help. Unknown provider buckets remain visible with qualified copy, not a guessed model or credit balance.
Why: window duration is a view of one allowance, not a different model; OpenAI documents Spark and general usage, but no public definition of `gpt-reserve` was found.
Consequences: Settings → Usage retains every dynamic window and purchased credits. The compact chat view shows only documented buckets, with a link to the full settings view. Exact reset times include the local date and timezone; the machine-persisted display preference is shared between views. Elapsed timestamps prompt refresh rather than claiming a renewed allowance.

### D-113 · 2026-09-07 · One complete composer suggestion interaction

Decision: add M12-T62. Upgrade the adopted composer trigger element on its existing assistant-ui state/selection primitives, rather than introducing a second command-menu keyboard owner. Preserve command identity matching and insertion semantics; add scoped scrolling, dismissal, focus retention and explicit result states for both triggers. The user's follow-up includes project-wide file search and opening skill/prompt source Markdown through the desktop OS association, with a copy-path fallback on browser/phone.
Why: the installed primitive supplies selection and ARIA but no outside dismissal or selected-row scrolling; replacing it with a competing input component would risk draft, caret and send behavior. The filesystem service already supports full-index queries; local first-page filtering hid that capability.
Consequences: interaction regressions cover the integrated primitive, not only matching strings. Only existing Markdown files may reach the desktop opener; no executable command strings or editor-specific URL schemes. No new dependency or engine command behavior.

### D-114 · 2026-09-07 · Bundle allowance and composer improvements in 0.2.8

Decision: add M12-T63 and publish the two requested changes as one stable patch, 0.2.8.
Why: the user explicitly requested bundling their composer picker improvement with the completed allowance UX.
Consequences: run verification after staging all intended source, push the commit/tag, and create the stable release page. Do not wait for Actions; installers and native feeds remain the release workflow's responsibility. Unrelated reference material stays outside the release.

### D-116 · 2026-09-07 · Session acknowledgement withdraws its native reminders

Decision: add M12-T65. The host publishes a seen acknowledgement independently of attention transitions. Desktop owns notification handles and withdraws only reminders for that session; viewing a question is not answering it.
Why: native reminders otherwise remain in GNOME notification history and keep Ubuntu Dock's counter visible after the user returns.
Consequences: preserve notification throttling, replace superseded reminders, and ignore late close callbacks from replaced handles. No blanket clearing of other sessions or operating-system notification history.

### D-115 · 2026-09-07 · Built-in search with explicit connection policy

Decision: add M12-T64; bundle exact-pinned pi-web-access search APIs, expose a Web search destination under Providers and models, and keep enablement independent of saved connections. Select one provider per request with no implicit fallback or broadcast. Retain D-61's transcript-only presentation.
Why: the curated runtime currently offers no search capability; upstream's automatic credential discovery and terminal/browser configuration are not a suitable product permission boundary.
Consequences: isolate search invocations, retain the engine's provider implementations, resolve shared authentication on demand, and keep search-only secrets out of preferences and responses. Browser-cookie extraction and automatic account discovery are not enabled by selecting an API provider.

### D-117 · 2026-09-07 · Release web search and notification dismissal together

Decision: add M12-T66 and publish the two requested features as stable 0.2.9.
Why: the user explicitly authorized including both changes in one new release.
Consequences: retain unrelated work locally; require staged verification, clean source CI and successful artifact/feed publication before declaring release complete.

### D-118 · 2026-09-07 · Goals record outcomes without duplicate accounting

Decision: add M12-T67. Remove goal budgets and usage tracking; preserve literal objectives; project the first engine prompt as a labelled goal setter and accepted completion as one durable chat disclosure with objective, summary and lifecycle history.
Why: session telemetry already owns consumption. The user explicitly chose presentation of the tool's real result instead of changing the engine to produce another assistant answer.
Consequences: exact-version pnpm policy patch, no replacement goal loop, no altered completion instructions or termination. Neutral legacy accounting fields satisfy upstream validation but never collect usage or cross the product protocol. Automatic-response/no-progress safety remains. Search and catalog titles exclude hidden scaffold; canonical transcript entries are untouched. No release authorized in this task.

### D-119 · 2026-09-07 · Search setup must select the intended route explicitly

Decision: add M12-T68. Offer a clearly labelled atomic connect-and-use action while preserving separate feature enablement and explicit switching; retain provider-specific safe failures instead of generic connection advice.
Why: saved permission looked like selection, leaving both reported sessions on the keyless default. Suppressed upstream errors prevented diagnosis.
Consequences: no implicit provider fallback or credential migration; cover actual upstream response shapes and both OpenAI authentication routes. No commit or release requested.

### D-120 · 2026-09-07 · Native package updates must activate the desktop too

Decision: add M12-T69/T70. Observe an atomic end-of-install version marker and offer an explicit full-desktop restart. Withdraw owned reminders on orderly exit; keep per-session acknowledgement. Bundle with goal history and web-search fixes in 0.2.10.
Why: this machine runs an old Electron main supervising a newly installed daemon; refreshing only the host cannot load desktop notification fixes. Ubuntu Dock counts GNOME notification objects, so changing an app badge alone does not solve it.
Consequences: no global dock preference changes, guessed notification IDs or automatic interruption of agents. Legacy orphaned reminders require one manual clear; the standard freedesktop API cannot enumerate another process's lost handles. Crashes/forced kills cannot run orderly cleanup.

### D-122 · 2026-09-07 · The person chooses update activation; versions stay coupled

Decision: extend M12-T69. Remove native post-install SIGHUP entirely. Publish installed-version readiness, offer a full app/host restart with explicit active-work warning, and require the frontend's compiled version to match the running host before any session resume or request. An older remote view asks for a frontend-only refresh with explicit session/agent continuity.
Why: user explicitly requires user-chosen restart timing and no mixed-release operation. A host-only restart both interrupts work and leaves old native fixes unloaded.
Consequences: compiled PRODUCT_VERSION derives from the root workspace version through identity generation. Public read-only handshake works over the existing RPC/relay path; versioned requests are refused by the host on mismatch. Existing native installations need one full quit/reopen to load this lifecycle. This supersedes the daemon-only activation policy, not the pinned architecture.

### D-126 · 2026-09-07 · Make destinations and connection waits visible

Decision: add M12-T71. One application-wide, pointer-transparent URL preview serves links including portalled dialogs; provider progress stays beside the active controls using the adopted loader.
Why: link destinations should be inspectable before navigation and a disabled button alone does not explain a pending connection.
Consequences: no preview fetches or invented progress percentages. Saving a model key is not described as testing it; search-provider tests name the provider actually being tested. No version bump or release in this task.

### D-127 · 2026-09-07 · New session returns to unfinished composition

Decision: add M12-T72. New session reuses an unarchived, unstarted session in the requested project; prefer the current empty chat, then the most recent. Coalesce simultaneous requests in this UI.
Why: an unused composition surface is already the new session the person wants. Other projects, archived history, goals and active work must not be mistaken for it.
Consequences: reuse preserves the existing assistant-ui thread identity, draft and model settings. Existing duplicate sessions are not deleted, and explicit backend session creation/fork semantics are unchanged.

### D-130 · 2026-09-07 · Publish the session and connection UX patch

Decision: add M12-T73 and release 0.2.11 with M12-T71/T72. Keep 0.2.10 Latest until the existing pipeline uploads verified artifacts and promotes the new release.
Why: user explicitly authorized publishing these changes; an assetless release page must not become the install target.
Consequences: source/version/tag are coherent; release page is stable, not prerelease. Artifact and native feed publication remains pipeline-owned and is not monitored, per user preference.

## Status edits log

- 2026-09-07 · codex-2026-09-06-slash-skills · M12-T49/T50 done: Pi-backed
  command, prompt and skill discovery is restored with lossless completion;
  native updates refresh the daemon at the lifecycle boundary, and the request
  inspector remembers the exact-chat Markdown view. Full gate: 925 tests.
- 2026-09-06 · codex-2026-09-06-account-usage · M12-T39..T42 done: stable 0.2.3 is published; adaptive account/API telemetry counts subagent attempts, activity disclosure has three session levels, and model menus reopen at the active provider/model; full 888-test gate passes.
- 2026-09-06 · codex-2026-09-06-activity-summary · M12-T35/M12-T36 done: native notifications use Laser's visible session title, and fleet work is divided into active and terminal lifecycle sections without breaking trees; full 875-test gate passes.
- 2026-09-06 · codex-2026-09-06-activity-summary · M12-T33/M12-T34 done: the composer footer moved to Help and shortcuts, and Markdown code uses Shiki's full Oniguruma grammar coverage with Laser-theme scopes; full 869-test gate passes.
- 2026-09-06 · codex-2026-09-06-activity-summary · M12-T30/M12-T31/M12-T32 done: the transcript is wider, mixed tool activity has one counted/live assistant-ui disclosure, and exact timestamps reveal on row interaction; full 866-test gate passes.
- 2026-09-06 · codex-2026-09-06-project-order · M12-T28/M12-T29 done: project priority persists across both left sidebars and dock panels gain accessible, session-persistent slot ordering; full 862-test gate passes.
- 2026-09-06 · codex-2026-09-06-archive-remove · M12-T27 done: archived transcript totals no longer keep an unpinned project in navigation or produce the false saved-sessions warning; 392 UI tests, typecheck and build pass.
- 2026-09-06 · codex-2026-09-06-release-hotfix · M12-T5/M12 done: stable 0.2.1 is Latest; both architectures, staged install, provenance, 12 assets, signed APT/DNF feeds and the public latest-stable path are verified.
- 2026-09-06 · codex-2026-09-06-release-hotfix · M12-T2/M12-T26 done and M12-T5 hotfix-ready: new-chat model selection, packaged TypeScript feature loading, AGPL/commercial dual licensing and Apache reusable-package scope pass the full 854-test gate and clean-machine package proof.
- 2026-09-06 · codex-2026-09-06-startup-beam · M12-T25 final art pass: transparent website mark, six eased inbound arcs and gradient beam absorption replace the rigid geometric rails; 381 UI tests, typecheck and build pass.
- 2026-09-06 · codex-2026-09-06-startup-beam · M12-T25 done: startup restoration is atomic behind a branded Laser beam transition; 381 UI tests and build pass, responsive dark/light review is complete, and the app remains running.
- 2026-09-06 · codex-2026-09-06-provider-icons · M12-T24 done: all 40 built-in providers use pinned Lobe Icons mono marks; exhaustive tests and live dark/light review pass, and the rebuilt app is running.
- 2026-09-06 · codex-2026-09-06-native-project-picker · M12-T23 done: Add Project is a native folder-selection action with no path-entry alternative; 376 UI and 63 desktop tests pass, and the rebuilt app is running.
- 2026-09-06 · codex-2026-09-06-product-boundary · M12-T15..T22 complete locally; clean Laser/Pi boundary, curated Features, bundled Subagents, durable Goals, core dictation and lossless slash completion verified. Startup capability race fixed after live mic control was missing. Full build and 842 tests green; 0.2.0 remains unreleased pending direct approval.
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
- 2026-09-05 · claude-2026-09-05-d · wave 3 fixer pass: 28 review findings applied (2 rejected). Real defects fixed in the seq/resume layer (`replayFloor` could not see a restarted worker's epoch; `onResume` compared its watermark against already-flushed state), R2 filtering of thinking levels by model, `inert` on overflowed islands, Enter no longer grants on any approval surface, OS reduced motion now reaches the motion tokens, the status line's live region no longer reads the clock. D-33, D-34.
- 2026-09-05 · claude-2026-09-05-e · M10-T9 (OS-native update channel) and M10-T10 (turn the in-app updater on) added on the user's call; D-35. `rpm` installed on this machine so the .rpm target can be built and proven rather than assumed.
- 2026-09-05 · claude-2026-09-05-e · D-36: the name is a working name. MX-T7 added — one module defines the product identity and every manifest is generated from it.
- 2026-09-05 · claude-2026-09-05-f · six lanes integrated into one story. M10-T1..T8 done and walked end to end on a real artifact; M4-T7 and M11-T6 closed; workspace set to 0.1.0 (D-41); D-37..D-41 recorded. Seven defects found and fixed at integration that no lane's own tests could see — four of them only visible by building the app and installing it. 751 tests, exit 0.
- 2026-09-05 · claude-2026-09-05-review4 · three reviews of the distribution work applied: install entry point, provenance default, bundled-npm discovery and install-script policy, integrity actually checked, upgrade rollback, `--purge`, CLI/desktop agent-directory agreement, first-run frame. D-42..D-47. `pnpm -r build`/`typecheck`/`test` clean, 760 tests.
- 2026-09-05 · claude-2026-09-05-identity · MX-T7 done. `product.json` is the one place the product is named; 14 files are generated from it, `pnpm identity:check` fails the build and the tests on drift, and renaming to `wavelet` and back proved it end to end. D-48 recorded: the wire namespace is frozen and does not follow a rename. 781 tests green.
- 2026-09-06 · claude-2026-09-06-review5 · three reviews applied (rename lane, runtime lane, product lane). Identity check widened to former names, JSX text and JSON values and 24 real strays fixed, including one that would have broken the first commit (D-50); the rename migration no longer treats a `doctor`-created empty directory as an install, and the CLI migrates too. D-49 records the rejection of `ELECTRON_RUN_AS_NODE` for the host. Product fixes: the Add-project dialog can no longer be pushed open, a failed turn survives a reload, provider errors are sentences with the right next step, sessions are named by their first line, a reload comes back to the session, projects can be removed from the UI and say honestly why one stays, `--yes` no longer escalates a home install into a sudo one. M4-T8 added for "All settings". 790 tests green, `verify-install.sh` 74/0.
- 2026-09-06 · claude-2026-09-06-a · renamed to Laser: `laser` for the repo, binary, directories, scheme and env prefix; `@lasercode/*` for the npm scope (npm `laser` is taken); appId `com.hubtrix.laser` under a domain we own; `wireNamespace` frozen at `piorbit` and `formerNames` carrying it so existing installs migrate. One edit to product.json regenerated 16 files. Forward-facing docs renamed; this ledger deliberately not. New repo `youssefsiam38/laser`, full history pushed, remote repointed. 790 tests green.
- 2026-09-06 · claude-2026-09-06-a · rename finished: zero occurrences of the old name outside this ledger. Wire namespace moved to `lasercode` and `formerNames` emptied (D-52); machine-wide namespaces separated from what a person types (D-51). Crypto salts, the relay subprotocol and the Electron IPC table now derive rather than spell. 790 tests green.
- 2026-09-06 · codex-2026-09-06-release-024 · M12-T43..T44 done: compact transcript density passed 891 tests and dark/light desktop/phone inspection; stable v0.2.4 published from `3e5b89a` with both architectures, staged installation, provenance, 12 GitHub assets and APT/DNF feeds green in release run 34034100668.

### D-135 · 2026-09-07 · Instruction provenance, not confidence

Decision: add M12-T74. Record sources from the engine's loaded prompt inputs and observed extension transformations, alongside each captured request. Adapt the assistant-ui confidence-marker to source identity; it must not imply factual confidence. Old captures remain explicitly unrecorded.
Why: a request inspector must explain how its actual instructions were composed, not match them against today's files.
Consequences: provenance is diagnostic metadata only; it never changes the provider payload or rereads source files. Preserve the exact chat Markdown renderer and deduplicated request search. Unknown transformations must not inherit an earlier source label.

### D-136 · 2026-09-07 · Release instruction provenance

Decision: add M12-T75 and publish instruction provenance as stable 0.2.12.
Why: the user requested a new release after accepting the completed feature.
Consequences: include only the committed feature and release metadata; preserve unrelated M3 work. Source CI gates the tag; artifact readiness is delegated to the existing release pipeline and is not claimed at dispatch.

### D-137 · 2026-09-07 · Downloads gate public releases

Decision: add M12-T76. Only the artifact publisher may make a release public, after both architectures and all installer verification assets are uploaded and verified. Early notes may exist only in drafts.
Why: publishing a page before its downloads created a user-visible empty release despite healthy builds.
Consequences: no-monitor requests mean dispatch the tag and report it as dispatched, not published. Failures remain drafts; previously published artifacts are not overwritten.
Supersedes: D-136 and earlier release-page-before-artifacts practice.

### D-138 · 2026-09-07 · Source navigation and native file links

Decision: add M12-T77. Keep source disclosure within the active modal, anchor hover details to the pointer, and route local files through the desktop editor bridge. Browser/remote views offer a path-copy fallback rather than opening host paths on another machine.
Why: long sources were difficult to inspect and ordinary Markdown anchors resolved project files against the web origin.
Consequences: use the captured request directory for inspector-relative links; never execute a file or URL as a command. Native tooltip titles are absent from source markers; component disclosure retains keyboard and touch access.

### D-139 · 2026-09-07 · Release source navigation as 0.2.13
Decision: add M12-T78 and dispatch stable patch 0.2.13 after the source gate.
Why: the user explicitly requested commit, push and release of the completed fixes.
Consequences: unrelated work remains excluded. Only the verified-asset publisher makes the release public; tag dispatch is not a claim that downloads are ready.

### D-140 · 2026-09-08 · Laser owns the subagent harness; children are sessions
Decision: Laser implements its own agent harness (M13) inside the worker and the companion extension: one `start_agent` tool over a compact catalog, `complete_agent_run` as the only successful ending, every child an in-process engine session in a mandatory `.worktrees/` worktree of its project, run state pushed as `agents/run` and persisted by the host. `pi-subagents` is no longer loaded or bundled. Child sessions appear in the sessions sidebar under their parent, and a Laser-owned React Flow map is a first-class surface per top-level session.
Why: the binding references (`docs/agents-leap/references/*`) require one generic tool, four identities, background-only children with mandatory isolation, persistent addressable sub-sessions and a live map. The pi-subagents design (one mega-tool, optional worktrees, foreground children, its own `.pi` discovery) contradicts each of those; copying its run-directory discipline, control semantics and prompt hygiene is cheaper than bending it.
Consequences: supersedes D-19 decisions 1 and 3 (children now appear in the session list; a full-screen map exists) and M12-T17's bundling of `pi-subagents`. The host file layer under `packages/host/src/subagents` and the CLI `runs`/`plan`/`missions` commands observe a temp root nothing writes to any more; M13-T11 removes them. A worktree of a project runs in that project's worker: invariant 5 ("one worker per project directory") reads a `.worktrees/` child as part of its project, never as a second project.
Supersedes: D-19 (items 1 and 3), the bundling half of M12-T17.
### D-141 · 2026-09-08 · A workspace belongs to the state directory, and a built-in chat outlives its folder
Decision: the Beam and Chat workspaces are `<stateDir>/workspaces/beam` and `.../chat`, not `dirname(stateDir)/beam`. `session/new` in a workspace creates the directory before a worker is started and refuses the session, naming the directory and the reason, when it cannot. Opening a stored Beam or Chat session recreates its recorded working directory if it is gone; a project session keeps the engine's refusal. The sidebar and the rail place these sessions by their agent record, never by the directory in their header.
Why: the host creates and owns its state directory in every layout, while the directory above it may belong to someone else — in the review container `/review` is root-owned, so the old location could never be created. The engine records the working directory in the session header and refuses to build a runtime whose directory is missing, so an uncreatable workspace produced Beam sessions that could be started and then never opened.
Consequences: a person who used the old layout keeps their chats: the folder is recreated on open and the sidebar still groups them under Beam. `HostServerOptions.dataDir` is replaced by `workspacesDir`. A project directory that vanished is still the person's to restore; nothing recreates it.

### D-142 · 2026-09-08 · Run setup again runs setup
Decision: "Run setup again" starts the first-run flow immediately. It clears the host's completion flag, forgets the remembered setup step so the flow opens at the beginning, closes the workbench, and asks the shell — through a small module store — to read the host again, forget the remembered session destinations and leave the open session so the flow can own the window. It no longer announces a run that would happen later.
Why: the button changed one flag on the host and said setup would start "the next time" the app opened with no session. Neither half held: every caller of `useSetupPending` keeps its own copy of the host's answer and the shell re-read it only when the connection opened, and the app restores the last session on load, so a window with no session open never came around. A person pressing a button labelled "Run setup again" is asking for setup now.
Consequences: the open session is left, not closed - its row stays in the sidebar and one click returns to it. The remembered destinations are cleared, so a reload in the middle of setup does not restore a session and hide the flow. `DeviceTab` is exported for its test.

### D-143 · 2026-09-08 · Beam has two ways in, and dictation belongs to its composer
Decision: Beam is reached from the spark, which is still the only thing that opens the bubble, and from the `+` on Beam's group in the sessions sidebar, which starts a chat in the window. The bubble's maximize control is live whenever Beam is ready: it moves the chat it is showing into the window, or starts one there when the bubble is empty. The agent's name and workspace stay spelled in one place (`startBeamSession`), and the guard test now asserts the two ways rather than one. Separately: when more than one composer is mounted, dictation belongs to the composer that started it — the transcription scope is claimed on the way into recording, and a finished phrase is typed into the composer that owns the microphone.
Why: the person asked for both. The single door was a rule about not scattering Beam through the app, not a reason to make the list's own group inert or to leave maximize dead on an empty bubble. The dictation change is the cost of a second composer: a mount-time global scope let the bubble speak for the session behind it and clear the scope when it closed, and a document-wide query for a textarea always found the first one.
Consequences: supersedes the "exactly one entry point" half of the Beam contract in `AGENTS.md` and `docs/agents.md`; the rest of that contract stands, including no palette command and no empty-state link. `readDictationScope` is exported for the test.

### D-144 · 2026-09-08 · Every agent has every tool, and no clock ends a run
Decision: tools are not part of an agent definition. Every agent gets every engine tool, and `web_search` follows the Web search feature for all of them at once. Runs have no time limit: no per-agent timeout, no default, and no timed-out state. A run ends when the agent reports through `complete_agent_run`, when a person or its parent ends it, or when it fails. A project with a run still going is never idle, so its worker is never retired underneath it.
Why: the user asked for both. A per-agent tool list was a second, weaker answer to the question the instructions already answer, and one more thing to keep in step with the engine's own set; a run limit made the harness end work it had no way to judge. Real work can take months.
Consequences: deliberately breaking, on the user's instruction — this is beta and nothing is migrated. `tools` and `runTimeoutMinutes` leave `AgentDefinition` and the persisted store; `timed_out` leaves `AgentRunStatus`, `AgentEventKind` and `AgentModelEvent`, and a stored run carrying it is dropped on load. The idle sweep asks the run registry instead of the retired file layer, which is what makes an unattended months-long run survive.

### D-145 · 2026-09-08 · A model picker offers what can answer
Decision: every control that chooses a model to use offers only models whose provider is connected. The worker's session model list answers from the engine's auth state, and the catalogue-fed pickers share one rule, `narrowToConnected`. Two surfaces keep the whole catalogue on purpose: Settings → Providers and models, which is where a person connects one, and the enabled-models control, which curates the catalogue and must reach providers not yet connected. When the providers cannot be read the enabled catalogue stands, because the narrowing is what is unavailable, not the models; when they can be read and none is connected the picker is empty and says to connect one.
Why: the engine knows over a thousand models across forty-odd providers, and a person typically connects one or two. Offering the rest is offering a choice that cannot be made: `pi/model/set` refuses it and a run against it fails.
Consequences: three copies of this rule (onboarding, Beam's dialog, and none at all elsewhere) become one. `pi/model/list` is narrower than the engine's full catalogue, which is what its callers wanted; nothing else reads it.

### D-146 · 2026-09-08 · The goal engine's tools travel with the goal
Decision: `goal_complete`, `goal_blocked` and `goal_wait` reach a provider request only while a goal is in play. The worker switches them on when it is handed `/goal` or a `session/goal/action`, before the engine's command dispatches; the companion extension takes them away on the first turn of a session that has no goal. `packages/pi-goal` owns the names and pins them to the installed engine.
Why: the engine registers them at load, so every session with Goals on carried three tools nobody could use, and their descriptions spend a paragraph each arguing that their own presence does not mean a goal exists — prompt paid on every request to undo a structural decision. Absence is the stronger guard and costs nothing to read. `goal_complete` also terminates a turn, so a stray call costs a turn.
Consequences: the gate cannot key on an existing goal alone. The engine's `assertGoalToolsAvailable` refuses to start or resume a goal whose tools are not already active, and `input` does not fire for a command, so the only place early enough is the worker, which knows the text about to become a command. That is one piece of goal knowledge in the driver, beside the goal handling already there. A goal that starts while the tools are somehow absent is paused by the engine rather than broken, and the gate never throws.

### D-147 · 2026-09-08 · The panels come out; the fleet is the column
Decision: the declarative panel system is removed — `packages/ui/src/panels/**`, the dock column, the sticky run tabs, the ambient pill above the composer, the popped-out panel page, the `pi/panel/*` protocol surface and the companion's panels module. The fleet becomes a permanent right-hand column: monitor outermost right, fleet immediately to its left, both independently collapsible, both falling back to sheets below desktop width. The fleet reads typed data rather than declared panels — agent runs from the run registry, background commands from a narrow typed task surface — and every question the app asks a person is answered inline in the transcript, where tool approvals and `confirm` already are.
Why: the user's call, and the reasons hold. Panels were a generic UI bus with six kinds and four surfaces; in practice the only thing anyone wanted from them was a structured view of work in flight, which the fleet does better and with a real domain model behind it. The bus cost a protocol surface, a second placement system, a second navigation model (run tabs), a whole browser page per panel, and a split where approvals rendered in the conversation while other dialogs rendered in a column. Deleting it removes about 6,200 lines of UI and one of two ways to render everything.
Consequences: `docs/ux-panels.md` was one of the three constitutional documents named in `AGENTS.md`; it is replaced by the document that describes what exists after this, and invariant 6a is rewritten — an extension no longer declares a kind and an intent, because there is no bus to declare onto. Anything an extension wants to show is either a tool result in the transcript or a typed work item. Background work needs a real transport to replace `pi/panel/read`, so the protocol gains a small typed task surface; that is a domain model, not a second bus, and it is a release-gated method inventory like every other. `select`, `input` and `editor` must be answerable inline and must still cancel safely rather than hang (invariant 6). Web-search results already render in chat and need no new home.
Supersedes: the panel contract established in MP.

### D-148 · 2026-09-08 · A failed action is not a broken app
Decision: nothing about an activity block goes red when something in it fails — no rail down the group, no rail down the row, no alert icon, no "N failed" count. What went wrong is written, in red text, on the row it happened to, and a group containing a failure still opens itself so that row is in front of the person. `attention` keeps its rail: a question waiting on a person is not a result. A shell command that ran and exited non-zero goes further and is not treated as a failure at all — it does not force a group open and it is not counted anywhere.
Why: the user's, twice. A `grep` that found nothing, a file the agent probed for and did not find, a test run that failed on purpose — these are the ordinary texture of an agent working, and painting the frame red for each one teaches a person to read "the app is broken" where the truth is "it looked and it wasn't there". Their second example was a `Read` returning `ENOENT`, which is why this covers every failure and not only a non-zero exit.
Consequences: `--danger` is now reserved for text that says what went wrong, and for surfaces that genuinely cannot proceed. The signal that something failed is carried by the failure's own words, by the group opening itself, and by the accessible name — never by the frame. A non-zero shell exit is told apart from a tool that could not run by the trailer Pi's shell tool appends (`isNonZeroExit`); if a future engine stops appending it, that predicate goes quiet and everything falls back to the ordinary treatment rather than to a wrong one. The monitor's step chips read the same predicate so the two surfaces cannot drift.

### D-149 · 2026-09-08 · A message waits by default; steering is a verb you press
Decision: a message written while the agent is running goes into a waiting list Laser owns in the worker, not into the engine's queue. Each waiting message can be steered, edited, copied or dropped on its own; leaving it alone means it is delivered, in order, when the turn ends. Enter puts a message in the tray and Cmd/Ctrl+Enter steers — the inverse of what the keys did before. A steered message leaves the tray for the engine's queue in the same call, so nothing is ever in both.
Why: the user's, from a reference screenshot. The engine offers `steer`, `followUp` and `clearQueue` and nothing else — `clearQueue` empties both lanes and `_steeringMessages` is private — so per-item delete and edit cannot be built on it at all; the message-queue element's own comment had already recorded that as the reason it had no per-item remove. Owning the list is what makes the verbs possible, and it also makes them survive a reload and reach a second client, which a browser-side tray would not.
Consequences: the engine's queue holds only messages a person deliberately steered, which is why a steered row carries no controls — there is no verb behind it, and drawing one would be a control that cannot work. "You stopped it" disappears from the ordinary path without any change to how stops are recorded: steering never aborted a turn, and pressing Stop was only ever the workaround for not having this. `clearQueue` now has to empty both lists. The keys changed, so the composer's contract in `packages/ui/DESIGN.md` and the keyboard settings tab changed with them.

### D-150 · 2026-09-08 · The opening screen is one composition, owned by the protocol package
Decision: the mark, the beams and their CSS live in `@lasercode/protocol/startup-screen`, on a subpath export that the index never pulls in. Three surfaces render that one source — the React screen maps the tree to elements, the desktop shell serialises it to standalone HTML, and the Vite plugin serialises it into `#root` for the app's first frame — and `packages/ui/src/globals.css` carries a copy pinned by a test that prints the replacement when it drifts. The colours reach the shell as validated declarations the app records when it applies a theme; nothing recorded falls back to the compiled default presets.
Why: the app showed two opening screens in a row, and the first was a card with a progress bar painted in a palette from before the theme system — a light ground and a blue accent in a product whose default is a black ground and a green one. Removing it settles both complaints at once. The composition had to be shared rather than copied: two hand-maintained copies of a converging-beam animation would drift the first time anyone touched either, and the drift would only ever be visible in the half-second nobody tests.
Consequences: presentation data now lives in the protocol package, which is new and deliberately fenced — the subpath means host, relay and worker never load it. The desktop learns a little about theme colours (a validated declaration list, no CSS it did not name), which is why its window frame stopped carrying its own hard-coded palette. The shell's page has an opaque origin and cannot fetch the product typeface, so its two lines render with the face unresolved; embedding it needs a font path in a packaged app that could not be tested here. Route (b) — one origin, the app as the only screen — remains the better end state and is written up in M13-T32's notes with what it would cost.

### D-151 · 2026-09-08 · An edit assumes a file it has seen; a write does not
Decision: `edit` is refused when the target file changed since the agent last read it, with the path and an instruction to read it again. `write` is never refused, but a successful `write` — like a successful `read` or `edit` — records the file's state, or the agent's own write would block its own next edit. The guard lives in `packages/pi-extension/src/modules/file-freshness.ts` on the engine's `tool_call` and `tool_result` hooks, holds file metadata and never file contents, is bounded per session, never throws, and never blocks a file it has no record of.
Why: the user's. An agent reads a file, thinks for three tool calls, then edits it; if the person, another agent, or a formatter it ran itself changed the file in between, the edit lands on a file it has never seen. `edit`'s exact-string match catches some of that by accident but not the dangerous case — a fragment that still matches, applied in a file whose surroundings moved. The line between the two tools is the user's and it is the right one: a write replaces the file whole and makes no claim about what was there, so it has nothing to be stale about.
Consequences: the friction case is real and intended — read, run a formatter through `bash`, edit, refused. `bash` needs no special case, because it moves the mtime and the ordinary rule catches it. The guard's blind spots are deliberate and written down: no record means no claim (a never-read file is never refused), an evicted record means no claim, a failed stat means no claim, and two changes inside one clock tick that preserve the byte count are not detected — closing that would mean hashing file contents, which is the memory this was told not to spend. The engine's tools are not overridden, so a Pi bump carries no maintenance here.

### D-152 · 2026-09-08 · The match is the freshness proof, so nothing is blocked
Decision: `file-freshness` blocks nothing. It has no `tool_call` handler and cannot refuse a tool call. Pi's `edit` matches `oldText` against the file as it is on disk, refuses a match it cannot find and refuses one that is not unique — that match is the proof that the edit fits the file in front of it, however old the agent's reading is. The module only explains: an `edit` whose match failed on a file that moved since the read gets one appended sentence saying why and what to do; an `edit` that succeeded on such a file gets a note that the file carries changes the agent has not seen. A `write` is never annotated but is still recorded.
Why: the user asked how Claude Code does this, and its reference documents a content rule, not a clock rule — a file that changed after the last read can still be edited when the old text matches the current content exactly and unambiguously, and the result *notes* that the file carries other changes. The clock rule we shipped first has a public failure record instead (anthropics/claude-code #3513, #7443, #10437, #11463, #48390), all reporting a refusal on files nobody else touched, because the agent's own previous edit advances the mtime past the cache. A guard that spends a turn on a re-read that changes nothing is worse than the problem it prevents.
Consequences: a wrong record can no longer cost a turn; the worst it can do is add a sentence that was not needed. Records are still kept, still metadata-only, still bounded, but they decide only whether to speak. The bet moves from the filesystem clock to the engine's failure wording, so the five annotated causes and the five ignored ones are provoked through the real tool in tests, and an engine bump that rewords one fails a test rather than silently annotating everything or nothing. The engine's match is fuzzy — Unicode-normalised, trailing whitespace stripped — so the proof is "unique modulo normalisation", a shade weaker than exact, and written down where the next reader will find it. The user also decided against a read-before-edit requirement, so an `edit` to a never-read file stays allowed.
Supersedes: D-151 (the refusal half; its metadata-only, never-throws and no-claim-without-a-record rules stand).

### D-153 · 2026-09-08 · Editing history moves the leaf; forking is the second choice
Decision: editing a message you sent and running a reply again both change the open session by default, by moving the session's leaf and appending a sibling branch. A fork into a new session stays available on both, named as such, in the secondary position. The previous version is never destroyed and is reachable through the branch picker.
Why: the user's. Forking was the only thing offered, so every correction cost a new session and split the history. The engine turned out to support the in-place move already — a Pi session file is an append-only tree with a leaf pointer, `navigateTree` explicitly "stays in the same file" and hands back the message's text, and `resetLeaf` exists for re-editing the first message. Laser already carried the protocol method, the driver call and the branch picker; only the buttons were wired to `fork`.
Consequences: an edit branches from the edited entry's parent rather than the entry itself, which means reading `parentId` off the persisted entries and not inferring it from render order. Nothing is deleted, so the branch picker is load-bearing rather than decorative: an edit that hid the previous answer would be worse than the fork it replaced. Editing while a reply streams is refused with a reason instead of silently stopping work. `summarize` on navigate is left off — it costs a model call per switch to describe a branch that is one click away intact.

### D-154 · 2026-09-09 · Green means happening now, so finished work is dimmed
Decision: no run status and no agent event may use the success tone. `completed` is muted, exactly like `cancelled`; `running` keeps `live`, `blocked` keeps `attention`, `failed` keeps `danger`. Finished work is history: dimmed, counted, folded away, and one click from being read. The finished folds carry a chevron, a dimmed word and a count, with no tick, and the fleet's fold carries a Clear that hides what was already finished without deleting anything.
Why: the user's, and the table already agreed with them everywhere except one row. Green in this app means work in flight — the live dot, the running badge, the fleet's "going" mark — so green on something finished reads as "look at me" for the one thing that needs no looking at. A green double-check on a Finished header says "done, well done" about a list whose whole purpose is to be ignorable.
Consequences: `--ok` stays in the token set and in the tone vocabulary for genuinely positive confirmations that are not run status — a connection resumed, auto-compact on — but a test now asserts that no run status and no agent event kind reaches for it, so this cannot regress one component at a time. The live map's legend loses its `Done` row and its muted row reads "Done or ended", because two lifecycles now share a colour while each node keeps its own word. Clear is a per-viewer mark, not a delete: the sessions behind the work stay in the sidebar and on disk, and work that finishes after the mark appears normally.

### D-155 · 2026-09-09 · `.laser` overrides are made durable on the instance we own
Decision: the worker applies a project's `.laser` values through `applyDurableOverrides`, which records them on the `SettingsManager` instance and re-applies them after the two methods that recompute settings (`reload`, `setProjectTrusted`). Nothing is written to disk, no engine file is patched, and the wrapper lives on instances the worker creates.
Why: the engine's `applyOverrides` merges onto the currently computed settings and keeps no record of what it merged, and `createAgentSessionServices()` reloads the resource loader, which reloads settings — so an override applied before service creation was gone before any session existed. That was not a degraded setting; it was the mechanism by which `.laser` reaches the engine at all, and by which engine package, extension, skill, prompt and theme discovery is switched off. With it dropped, a package named in global settings made the engine run `npm install` during service creation, in a product that does not offer package installation (invariant 6b).
Consequences: `.laser/settings.json` now genuinely takes effect, so values that were inert start applying for anyone who already has that file. The tests pin the engine's own behaviour beside ours, so an upstream fix turns them red and the wrapper is retired rather than left rotting. The upstream ask — retain applied overrides and re-merge after the recomputes, or expose the recompute as a hook — is recorded in `docs/upstream.md`. Reading `<cwd>/.pi` was checked at the same time and is not affected: trust stays false through a reload.

### D-156 · 2026-09-09 · The parent chooses whether a child is isolated
Decision: `start_agent` takes `worktree`, defaulting to true. True is what the harness always did — a worktree under `<project>/.worktrees/` on `agents/<slug>`, or a refusal. False starts the child in the parent's own checkout with every tool, nothing refused and no directory created; the child is told in its role block that it is not isolated. A project with no git accepts only false, and both worktree refusals name that as a way forward rather than only "initialise git". The tool's result always says where the child is working, and carries a branch only when one exists.
Why: the user's. A child whose task is to read — a review, a search, an explanation — has no use for a worktree, and paying for one is a cost with no return. Asked whether an uninsulated child should be stopped from writing, they chose to trust the parent: taking `write` and `edit` away would have been a tool restriction, and D-144 removed those on purpose. The one thing the child is owed is knowing, because a judgement it was never told to make is not a judgement.
Consequences: supersedes D-140's mandatory isolation and the "never a child in the parent's checkout" half of the invariant at `AGENTS.md`. An uninsulated child can change its parent's files while the parent is working in them — that is the accepted cost of the choice, stated to the model rather than guarded against. `AgentRun.worktree` is null and `AgentRun.cwd` optional, so every reader must render a child with no worktree without a hole. A copy-based worktree for non-git projects was specified and then dropped by the user as overcomplicated (M13-T41): the refusal that names `worktree: false` is the whole answer for that case.
Supersedes: D-140 (mandatory `.worktrees/` isolation).

### D-157 · 2026-09-09 · A child's worktree belongs to its parent, and nothing removes it silently
Decision: reviewing, merging and removing a child's worktree are the parent's. The harness removes a worktree in exactly two cases that are not the parent's business — a failed start (a rollback of something never handed over) and a person deleting the child's session — and the second now asks: `pi/session/delete` takes a keep-or-delete disposition whose default is keep, and the dialog names the branch, the path and how many commits are unmerged before the person chooses. The parent gets `remove_agent_worktree`, which refuses to destroy unmerged work unless told `force`, and then reports what it discarded. Both agents are told whose job this is, in their prompts. A person can clear a leftover from the fleet without deleting the session.
Why: the user's — "the responsibility of merging the worktree to the main tree and the deletion of this worktree is the responsibility of the parent, and both should be informed, to avoid any of them misbehaving." Before this, deleting a child session removed its worktree unconditionally and silently: a person lost a child's commits without being told they existed. And an uninstructed child will "helpfully" merge its own work while an uninstructed parent leaves directories for ever.
Consequences: no merge tool — merging is `git merge` in the parent's checkout and the parent has `bash`; a tool would have to invent conflict semantics where a person's judgement belongs. The cost of parent ownership is a parent that crashes or is cancelled leaking its child's directory, which is why the fleet's remove exists and why `.worktrees/` is a place a person can see. The registry stamps `removedAt` rather than forgetting, so a run's history still says where its work was. Callers of `pi/session/delete` that omit the disposition keep the worktree — losing work to a missing field is the failure this exists to prevent.

### D-158 · 2026-09-09 · A child that is stuck on a question is its own status, and the parent is told, not made to wait
Decision: `wait_for_agents` is removed. `start_agent`'s result tells the parent not to wait — the child's ending is delivered as a message that wakes its turn — and to use `inspect_agent` meanwhile. `inspect_agent` reads one child in depth, is read-only, and is bounded. `AgentRunStatus` gains `needs_input`, a live, attention-toned, non-terminal status meaning the child's loop is paused on a question raised through the portable UI surface; the question is carried on the run, the parent is woken with an `agent.needs_input` event, and it answers through `send_agent_message`, typed per question kind. A person can still answer inline in the child's chat; the first answer wins.
Why: the user's. Waiting was redundant — the harness already wakes the parent when a child ends — and a tool whose only effect is to block a turn teaches the model the wrong habit. The status came from their observation that "running" hid the one state a parent most needs to know: the child cannot proceed without someone. Before this, a child paused on a `select` showed as working in every surface, and its parent had no idea a question existed.
Consequences: a wire vocabulary change with readers everywhere — sidebar, fleet, map, agent-event card, CLI — each now tested for the new value; `AGENT_RUN_TERMINAL` is unchanged, so `needs_input` never folds into finished work (D-154). `blocked` keeps its meaning as an *ending* the child chose. `inspect_agent` returns excerpts, never a transcript, because a parent that pulls a child's whole conversation into its context defeats delegation. No shipped feature raises a UI question yet, so reaching `needs_input` in the sandbox needs a scene; the golden test reaches it through the real engine.
Supersedes: the waiting half of D-140's tool set.

### D-159 · 2026-09-09 · Editing history while a turn runs stops the turn first, and the driver owns the sequence
Decision: Edit, Fork and Jump are enabled while a turn is streaming. Each stops the running turn and then moves, as one request: `pi/session/navigate` and `pi/session/fork` take `stopFirst`, and `StableSdkDriver` performs the abort before anything else, so a failure between the stop and the move leaves the session stopped, unmoved and still served. No confirmation dialog. The stopped turn is recorded on its abandoned branch exactly as the Stop button records one; it is never suppressed. "Try again" keeps waiting for the turn.
Why: the user's. Once M13-T44 made the newest message's entry known mid-turn, the three actions were offered but disabled, because the engine refuses to move the leaf while streaming — it throws rather than waiting. A person clicking Edit on a message has already decided the running reply is not what they want; asking them to press Stop first is a step the app can take for them. Nothing is lost: the abandoned turn stays on its branch and the version picker reaches it (D-153).
Consequences: the worker, not the UI, owns stop-then-move, because two requests from the UI could leave a session half-moved. `fork` on a first turn only works after an abort — the engine writes a session's file on the first assistant message, and the aborted reply is that message — which the driver's ordering now guarantees. The transcript's re-read on settle had to learn to skip a session with a move in flight, or it raced the move and asked the worker for a path it no longer served. The stopped row on the abandoned branch is deliberate: this *was* a stop.

### D-160 · 2026-09-09 · The fleet is one session's tree; a deleted session's work is a named line, never a ghost
**Decision.** The fleet column and sheet show the work under the top-level session being read: its agent runs and background commands, and theirs, as one tree. Reading a child shows its root's tree with the child marked. Another session's work is in that session's fleet; the way to it is the sessions sidebar. Work whose root session is gone from a loaded catalog is not dropped and not adopted: it is one named line at the bottom of every fleet, collapsible into the same rows, with Stop, Open chat and its own Clear.
**Why.** Everything at once (D-147) made the fleet a project console: the person had to find their own tree in a list, and a quiet session showed another session's noise. One tree matches how the map and the sidebar are already scoped, and keeps the column readable at a phone width. A deleted session can still be costing money, so its work cannot vanish; putting it under the current session would lie about what started it.
**Consequences.** `scopeFleet` is the one seam: everything else reads `tree` or `elsewhere`. The top bar badge counts the tree, and lights for the deleted line only when that is all there is. "Deleted" means absent from a loaded catalog — before the catalog loads nothing is called deleted. `FleetGroup.orphaned` is no longer rendered.
**Supersedes.** The "everything at once" half of D-147; the rest of D-147 (no panels, three surfaces) stands.

### D-161 · 2026-09-09 · Switching a model off is a Laser-owned disable list, never an enumerated allow-list
**Decision.** "Off" for one model is an exact reference in `disabledModels`, a Laser setting (global or project `.laser`) that the worker applies where it computes what is offered — the catalogue's `enabled` and a session's own model list — and never passes to the engine. "On" removes the reference, and touches `enabledModels` only when one of its patterns is what hides the model, by appending. Laser never writes an enumerated allow-list to say "everything except this one".
**Why.** The engine's `enabledModels` is a pure allow-list with no usable negation (proved against the pinned matcher in `model-offer.test.ts`). Expressing "off" by enumerating everything else silently hides every model added later — the very bug M13-T49 set out to fix.
**Consequences.** Two lists, two meanings: patterns say what is offered, the disable list says what a person switched off. A model that arrives later is on. `LASER_SETTINGS_KEYS` names the product keys that ride in Pi's settings file without becoming engine overrides; `engineSettingsOnly` strips them. A settings write does not reload a live session (M13-T55), so the worker reads both lists fresh from the files when a session asks.

### D-162 · 2026-09-09 · A background command is followed like a child agent: no waiting tool, its exit wakes the model
**Decision.** `task_wait` is removed. Every background command's exit — one started with `background: true` and one promoted from the foreground alike — reaches the model as a message that wakes its turn, carrying status, exit code and the tail of the output, and the start result says so. The only exception is explicit: `bash` with `background: true, notify: false` records the exit and shows it in the next turn without starting one, for a server or a watcher the model said it does not need to hear from.
**Why.** D-158 removed `wait_for_agents` because a model told to wait either blocks a turn or polls; the same model was still told to `task_wait` on a command. The asymmetry cost the very thing D-158 bought — the model idle while its work runs — for a test run or a build. Fire-and-forget stays available, but as a choice the model makes in words, not the default.
**Consequences.** `BACKGROUND_TOOL_NAMES` is `task_list`, `task_output`, `task_stop`. One exit path in `background-work`, tested for explicit, promoted and `notify: false`. Every exit that wakes the model costs a turn; that is the price of not polling, and `notify: false` is how a model declines to pay it.

### D-163 · 2026-09-09 · The agent reads the fleet through one tool, and it is the person's fleet
**Decision.** `inspect_fleet` replaces `list_agents` and `task_list`. It returns the tree the fleet column renders, scoped to the caller: the agent runs and background commands under the caller's session, its children's, and theirs — one row per item, `agent` or `command`, in the fleet's own status words, with elapsed time, the one-line ending (exit code, completion message, or the question a child is stuck on) and the id to follow it with. `inspect_agent` and `task_output` stay as the per-row detail and accept any row in the caller's subtree, read-only. Endings still arrive as messages that wake the turn (D-158, D-162).
**Why.** The person had one fleet and the agent had two lists in two vocabularies, neither showing what a grandchild or a child's command was doing. When a person and the model they are steering look at different pictures of the same work, their conversation about it goes wrong. The same tree, the same words, the same scope rule as D-160 — your fleet is the tree under you.
**Consequences.** Companion modules still never import each other: the worker is where runs and tasks meet, so it keeps a task index fed from the task updates it already forwards, and the harness joins the two. The worker's tree and the UI's `fleet/model.ts` must say the same thing, pinned by a shared fixture. The tool is capped at about fifty rows, deepest first left out, and says so.

### D-164 · 2026-09-09 · A session leaves its worker through one host-only verb before the host touches its file
**Decision.** `pi/session/close { path }` makes a worker let go of one open session — dispose its driver, forget its caches — so that the file has no writer. Only the host may send it; the router refuses it from clients. A worker refuses it with SessionBusy while the session is streaming. The host uses it before `pi/session/move` rewrites a session file, and may use it for any future operation that needs the file unowned.
**Why.** Invariant 8, never two writers on one session file, and invariant 5, one worker per project directory: a Chat session moving to a project changes which worker owns it, and the only prior way to release a session was to retire the whole Chat worker, which would have dropped every other chat's tray and queue. A person-facing verb would invite a second, unowned way to end a session from the UI; the UI already has its own.
**Consequences.** `WorkerPool.forgetSession` drops the path from the pool's open, running and cwd maps. A move of a streaming session is refused with "This chat is still answering", never forced. Any new host operation on a session file goes through this verb first.

### D-165 · 2026-09-09 · Namer labels every tool call of a top-level session and none of a child's
**Decision.** Tool labels have no in-flight cap: every call that starts in a top-level session is asked about at once, per call id, and only a call already asked about or already ended is skipped. A child agent's session gets no tool labels. Session naming is unchanged: unbounded, per session.
**Why.** The cap of three per session unlabelled exactly the row the person was looking at, which is the one place a label is worth paying for. A child's rows are read by its parent through `inspect_fleet` and `inspect_agent`, and only rarely by a person who opened its chat, so a label per call across a fleet of children was spend with no reader.
**Consequences.** Spend is bounded by the naming model being the cheapest allowed, by one request per call id, and by the top-level rule; there is no worker-wide ceiling, and a busy root session with many concurrent calls pays for each. If that ever needs a ceiling, it drops rather than queues, for the reason D-158 gives.

### D-166 · 2026-09-09 · Only an agent record nests a session; a fork's origin is lineage
**Decision.** `SessionSummary.parentPath` means one thing: the session of the agent that started this one, read from the agent record. The engine's `parentSession` header, which a fork carries, is exposed as `forkedFrom` and nests nothing: a fork is a top-level session beside its origin, in the same project group, with its own name and its own fleet.
**Why.** A fork is a person's decision to take a conversation in a second direction; it is not work done on the first one's behalf. Filing it under its origin hid it in the agent fold, made the map draw it as a child, and made the move dialog refuse it as "an agent started this session under another one". Two meanings on one field cost three surfaces.
**Consequences.** Every reader of `parentPath` is now about agents only. `forkedFrom` is available for a "forked from" line if a surface ever wants one; none shows it today. A fork of a child session is still a fork: top-level, not a second child.

### D-167 · 2026-09-09 · Ship the Agents Leap as 0.3.0
**Decision.** `feat/agents` is fast-forwarded onto `main` and released as stable 0.3.0 — a minor version, not a patch, because the product gained its own agent harness and everything around it (D-140 through D-166). The release follows the procedure M12-T78 set: version set across the workspace, verify and installer checks on the versioned tree, source on main with a clean CI run before the immutable tag, a draft with notes, publication by the pipeline.
**Why.** Thirty-seven commits of agents work on one branch is one product change, and a person reading `laser --version` should be able to tell the world before the harness from the world after it. Fast-forward keeps every commit's evidence where the ledger points.
**Consequences.** The tag is `v0.3.0`; the next patch is 0.3.1. Nothing is published by hand: if the pipeline stops, the release stays a draft and the ledger says "tag pushed; release building".

### D-168 · 2026-09-10 · Built-in prompts belong to the person
**Decision.** Add M13-T67. Beam, Chat and Namer keep their product-owned identity and capabilities, but their effective system instructions and model are durable user choices. A null instruction override restores the shipped prompt, so product updates can improve defaults without overwriting an explicit customization.
**Why.** A built-in agent is still an agent; locking its prompt makes its most important behavior impossible to adapt while its model is already editable.
**Consequences.** Built-ins remain undeletable and unavailable as child definitions. The Agents page edits only instructions and model. Namer keeps its per-operation output contract and layers the person's effective instructions into every naming request.

### D-169 · 2026-09-10 · Product meaning wins over shell geometry and engine identity
**Decision.** Add M13-T68 and M13-T69. Telemetry's global entry points use its activity mark; panel-edge glyphs mean collapse only. The engine-backed default prompt keeps the pinned engine's live content but rewrites its opening identity from the internal engine to Laser at both the readable-instructions and live-request seams.
**Why.** A repeated panel glyph says where a surface sits, not what it contains, and made three different sidebar actions visually indistinguishable. The internal engine's product name in the default agent's first sentence contradicts Laser's product boundary.
**Consequences.** Telemetry is recognizable before reading its tooltip. Engine updates still flow into the default prompt; the adapter changes only the exact identity sentence and fails safely if upstream wording changes.

### D-170 · 2026-09-10 · An agent may start another instance of its own definition
**Decision.** Add M13-T70. A custom agent may include its own definition in `allowedAgents`; the editor presents that choice as “Same agent” rather than hiding it. The existing depth limit, worktree choice and child lifecycle apply unchanged.
**Why.** The host and harness already support recursive definitions, and the shipped default already selects itself. Hiding the current definition made that valid value look missing; removing it then left no visible way to put it back.
**Consequences.** Self-delegation is a normal reusable-agent choice, not a default-agent exception. It creates a new child session, never recursion inside one running session, and remains bounded by `maxDepth`.

### D-171 · 2026-09-10 · Agent names are editable identities with durable aliases
**Decision.** Add M13-T71. `agents/validate` and `agents/save` carry the original name (null for creation). A rename moves the definition, default pointer and every `allowedAgents` reference in one store commit; the old name becomes a durable alias used by workers reopening existing sessions.
**Why.** Names are model-facing identifiers and appear in persisted session records. Treating a rename as delete-plus-create would either overwrite a duplicate or make earlier sessions silently run the default definition.
**Consequences.** Current custom names, built-in names and historical aliases are unavailable as rename targets. Session files remain immutable and keep their historical name; resolution follows the alias to the current definition. Deleting the renamed definition retires aliases that target it.

### D-172 · 2026-09-10 · Laser owns its prompt and writes no skills
**Decision.** Add M13-T72 and M13-T73. The default agent's base prompt is Laser-owned and engine-neutral. It names the actual tools available, then lets the runtime append the working directory, project instructions and skills discovered from user or project folders. Laser does not generate, install or bundle a skill; Beam's app-specific operating guidance is part of Beam's built-in instructions.
**Why.** An implementation engine's documentation and branding have no place in an independent product prompt. A generated Beam skill also makes Laser a participant in the same skill namespace it claims only to discover for the person.
**Consequences.** Engine changes no longer silently rewrite Laser's default behavior. Tool definitions remain runtime facts, not product branding. The Beam skill file, packaged probe and special filtering exception are removed; existing user-authored skills remain discoverable through the same roots and scoping controls.

### D-173 · 2026-09-10 · The Beam spark is a fresh-chat launcher
**Decision.** Add M13-T74. Every spark press clears the bubble's current session and opens the empty Beam composer. Pressing the spark while the bubble is already open also starts fresh; Close and Escape remain the ways to dismiss it.
**Why.** The spark expresses “ask Beam now”, not “return to the last Beam conversation”. Returning to earlier conversations already has a clear home: the Beam group in the sessions sidebar.
**Consequences.** A previous Beam session is detached from the bubble but never deleted or stopped, and remains in the catalog. The first message still creates the fresh session lazily, avoiding empty history rows for bubbles the person opened and dismissed.

### D-174 · 2026-09-10 · Release the agent refinements as 0.3.1
**Decision.** Add M13-T75 and publish the completed agent customization, identity, skill-discovery and Beam-launcher refinements as stable 0.3.1.
**Why.** The changes form one user-visible refinement release and the person explicitly requested that version.
**Consequences.** Every workspace manifest must agree on 0.3.1. Source CI must pass before the immutable tag is pushed, and the release remains unpublished until both architecture artifacts, checksums and provenance verify in the release pipeline.

### D-175 · 2026-09-10 · Dynamic instructions are visible template fields, never remembered syntax
**Decision.** Add M13-T76. Agent instruction overrides use Mustache-compatible variables. Every supported runtime value appears in a labelled picker beside the editor and inserts at the current caret; the stored template remains portable text and the worker renders it for each request.
**Why.** Editing the prompt should not freeze values that change with tools, project context, skills, session role or working directory, and a person should never need to learn or type a variable name.
**Consequences.** Laser owns the field catalogue and its safe render context. Unknown or malformed fields are refused before save rather than silently disappearing. Product defaults use the same public fields, so the editor shows exactly how live dynamic content enters the prompt.

### D-176 · 2026-09-10 · Namer qualification measures candidates and degrades to a usable choice
**Decision.** Add M13-T77. Qualification builds its candidates deterministically from connected text models, asks shortlisted candidates to perform the real naming job, normalizes common valid response shapes, and ranks successful trials by correctness before latency and price. A malformed nomination can no longer make the run unavailable.
**Why.** The nomination model was a second language-model dependency whose formatting failure could eliminate every otherwise usable candidate. Qualification exists to prove a model can name, so the proof itself should select the model.
**Consequences.** External provider failure can still be reported per candidate, but the run keeps the strongest usable result and a previous valid Namer selection is never erased by a failed requalification.

### D-177 · 2026-09-10 · Session-kind tabs navigate, and Beam belongs to Code
**Decision.** Add M13-T78 and M13-T80. Chat and Code remember their own last viewed session and selecting a tab navigates to that session. Maximizing Beam selects Code before moving its conversation into the main view.
**Why.** A selected tab that disagrees with the conversation in the main view makes the sidebar look like a filter over unrelated content. Beam is a coding agent and already lives with projects in Code.
**Consequences.** Pointer and keyboard tab changes have the same navigation behavior. A missing or archived remembered session falls back to the newest surviving session in that tab, then to the tab's empty state without creating anything.

### D-178 · 2026-09-10 · Every Beam and Chat conversation owns a private workspace
**Decision.** Add M13-T79. The Beam and Chat workspaces become containers; each new built-in conversation gets an opaque durable child directory used as its working directory. A Chat keeps that directory until its conversation moves into a project.
**Why.** Sharing one writable directory lets unrelated conversations see and inherit each other's generated files and dirty state. A conversation that becomes long-lived needs its own clean place without asking the person to manage another project.
**Consequences.** Beam and Chat grouping follows the agent record rather than exact cwd equality. Private paths are not presented as projects. Move-to-project accepts any top-level Chat session; its private working files remain intact unless the person deliberately moves them.

### D-179 · 2026-09-10 · Unreleased instruction templates need no legacy prompt emulation
**Decision.** Supersede D-175's compatibility clause. Product-owned default and built-in prompts use the new live fields directly; the worker does not auto-append missing fields to older templates.
**Why.** This editor has never shipped to a user, so preserving an unreleased intermediate prompt shape adds duplication and hides what the visible template actually controls.
**Consequences.** Shipped defaults are replaced by the field-based versions. Explicit custom instructions render exactly as saved; live information enters only where the person inserts it.

### D-180 · 2026-09-10 · Recoverable provider failures are invisible
**Decision.** Add M13-T81. A provider attempt that the engine will retry is transient control state, not a conversation record: Laser keeps the run working, removes that failed attempt from presentation, and renders no retry counter. If recovery succeeds, nothing about the failure remains visible. Only an exhausted or non-retryable provider request becomes one attention-toned, actionable warning.
**Why.** Short-lived rate limits, overloads and dropped sockets are normal transport noise. Showing a red stopped row beside an active retry contradicts the actual run state and makes successful self-recovery feel broken.
**Consequences.** Raw provider failures remain in low-level logs and persisted engine history for diagnosis, while normal transcript hydration suppresses recovered attempts. The existing bounded exponential-backoff policy remains the source of retry timing and count.

### D-181 · 2026-09-10 · Ship the completed agent and session refinements as 0.3.2
**Decision.** Add M13-T82 and publish the completed instruction-template, Namer, private-workspace, session-navigation and provider-retry refinements as stable 0.3.2.
**Why.** These changes form one coherent user-visible patch and the person explicitly requested a new patch release after accepting the implementation and runtime-fix review.
**Consequences.** Every workspace manifest agrees on 0.3.2. Source CI passed before the annotated tag was pushed; publication occurred only after both architecture builds, installation, checksums, signatures, provenance and remote assets verified.

### D-182 · 2026-09-10 · A resume never creates a replacement conversation
**Decision.** Add M13-T83. A persisted-session load must find a nonempty transcript; only explicit session creation may create a new identity. Worker processes start in their assigned directory. Internal storage cannot be selected, discovered or used as a project; the designated Settings worker is a service, not a project or conversation.
**Why.** The permissive engine loader can create a new identity under a missing file's old name using the host's inherited state cwd. Session discovery then turns internal storage into a recurring project. The person requested prevention rather than backward-compatible guessing.
**Consequences.** Invalid internal-storage sessions are omitted from normal session/search navigation and refused on direct load; their files remain untouched. No automatic reclassification as Chat, migration, or compatibility path. Genuine Beam/Chat workspace sessions remain available.

### D-183 · 2026-09-10 · Explicit recording lifecycle and readable disclosures
**Decision.** Add M13-T84. Recording has no app-imposed duration limit; short transcription chunks remain. Discard cancels captured/pending audio without sending or replacing editable draft text. Opening Beam immediately creates or reuses an unstarted session, quietly; the sidebar + reuses and selects that same session. The launcher coalesces quiet and selecting requests and recognizes attributed private Beam/Chat workspaces. The current reasoning level stays visible; mixed activity uses two complete family labels and a count of other types; skill results use short previews and an explicit scrollable description view.
**Why.** The person approved six fixes, then explicitly preferred eager session creation over recording without a session.
**Consequences.** A used session is never repurposed or deleted; draft text and session settings survive empty-session reuse. Discard also prevents a pending send from proceeding. Provider-request timeouts and per-chunk size limits remain; device/browser interruptions are surfaced, not presented as guaranteed endless hardware capture. No installation or running-app restart is part of this task.

### D-184 · 2026-09-10 · Publish the session and composer fixes as 0.3.3
**Decision.** Add M13-T85. Commit and push M13-T83/T84 and release stable 0.3.3, as requested. All workspace versions must agree; verify from an isolated checkout so unrelated untracked files are neither shipped nor modified.
**Why.** The person accepted the implementation and explicitly requested publication. The only known local identity-check failure is an unrelated scratch script, not release source.
**Consequences.** Clean source CI precedes the immutable tag. The release workflow owns complete x64/ARM64 builds, clean-machine and installer checks, signed manifest and offline provenance, verified asset publication and native-feed deployment. Report published only after those succeed; do not restart or install the running app.

### D-185 · 2026-09-10 · A top-level agent is chosen before the conversation starts
**Decision.** Add M13-T86. A new project session visibly selects the default custom agent and may switch to any custom agent before its first prompt. Beam, Chat and Namer remain available only through their dedicated product channels. The selector disappears once the first prompt is sent. Thinking may likewise be overridden before the first prompt for this session only; durable per-model defaults remain a Settings concern.
**Why.** The person wants to choose who receives a new conversation without exposing built-in agents in the general session picker, and to override reasoning for one conversation without changing the model’s default across the app.
**Consequences.** Empty-session reuse becomes agent-aware at the visible composer boundary. Started sessions are never repurposed. Agent search must remain usable with a large definition list, and thinking choices remain filtered to what the effective model accepts.

### D-186 · 2026-09-10 · Session-row state is a mark, not a tag
**Decision.** Add M13-T87. Remove trailing run-state words and descendant-count status chips from session rows. A root session keeps its own activity mark, each child keeps its status dot, and a parent’s fold disclosure inherits the most important descendant state so collapsed work still communicates working, waiting, needs-you and failure. Accessible names and full row tooltips retain the words.
**Why.** The tags repeat the existing visual state and steal the scarce width session names need.
**Consequences.** State remains distinguishable without motion through semantic colour and accessible text. Reduced motion removes only animation. Finished counts stay on the finished-work fold, where they describe the content it controls rather than competing with the session title.

### D-187 · 2026-09-10 · Publish the pre-turn controls and sidebar refinements as 0.3.4
**Decision.** Add M13-T88. Commit and push M13-T86/T87, align workspace versions at 0.3.4, and publish through the existing release workflow as requested.
**Why.** The person explicitly approved committing, pushing and releasing the completed fixes.
**Consequences.** Source CI passes before the immutable tag. The publisher verifies both architectures and provenance before publication; unrelated working files and the installed app remain untouched.

### D-188 · 2026-09-10 · Pre-turn choices are transient composer state
**Decision.** Add M13-T89 through M13-T94 with non-overlapping scopes. M13-T89 owns tentative composer choice and atomic first-turn identity binding; choosing creates no session, writes no setting, and leaving discards it. The first prompt binds the choice to the same unstarted identity; creating a second chosen-agent session at Send is forbidden. M13-T90 owns composer alignment/recording. M13-T91 owns only the read-only actual persisted agent label after start, never tentative state. M13-T92 owns stale Sending now cleanup after queued/steered delivery, including its reserved worker preflight/pending files; it does not own first-turn identity. M13-T93 owns serialized child completion, actual engine settle and ended-agent resume, without extra completion/follow-up loops. Explicit New controls and eager Beam/Chat creation retain their existing behavior. M13-T94 waits for all five fixes.
**Why.** Agent-aware empty-session reuse keyed by identity created a second session when the selected agent differed from the default, and moving drafts between those identities could not preserve attachments or make navigation side-effect free.
**Consequences.** Existing started session identities never change and no user session is deleted to hide duplication. After start, the top bar shows a read-only label beside the model only when canonical session attribution identifies the agent; a tentative choice and today’s default never fill an unknown historical identity. A transcript-delivered queued/steered message cannot remain in the tray as Sending now. First-send concurrency and retry behavior require provider/runtime integration tests across every queue lane. Worker driver/server files stay serialized under M13-T92 until its handoff; M13-T89 cannot edit them concurrently. Composer layout may change independently only while preserving this preparation contract.

### D-189 · 2026-09-10 · Manual disclosure wins; terminal blocking is finished
**Decision.** Add M13-T95 and M13-T96 as release dependencies. Manual aggregate activity open/close is authoritative, and Answers-only never auto-opens activity for streaming or errors. A terminal `blocked` run is neutral finished work and belongs in the finished fold; a newer active run supersedes historic failures in fleet, sidebar and inspect wording. Live `needs_input` remains warm **Asking**, and a live descendant keeps its branch visible.
**Why.** Automatic reopening contradicts the person’s explicit disclosure choice, while treating a terminal blocked outcome as live attention leaves ended work visually urgent and can let old failures conceal what is happening now.
**Consequences.** Disclosure state must survive rerenders and mode changes without error/stream exceptions. Terminal blocked rows lose warm attention and join other ended history, but no live question or live descendant is folded away. The pending Markdown variable-editor and image-preview enhancements remain outside release dependencies until the user answers their release-scope question.
**Supersedes.** D-154 only where it assigned terminal `blocked` the attention tone, plus the prior implicit auto-open-on-error/stream policy; D-154’s muted completed/cancelled policy remains.

### D-190 · 2026-09-10 · Stabilize the coupled session lifecycle before release
**Decision.** Pending-delivery acceptance, harness settlement, first-prompt binding and caller integration form one coupled session-lifecycle candidate. Existing non-overlapping owners finish stable checkpoints. Pending-delivery handed shared driver/server ownership to first-prompt-binding, which holds it exclusively until an explicit source checkpoint. After first-prompt-binding relinquishes source ownership, harness-lifecycle is the proposed continuing integration owner; ownership has not transferred. Composer, header, disclosure and neutral-fleet work remain bounded independent lanes. Optional Markdown-variable and image-preview enhancements are excluded from this patch.
**Why.** Individually correct changes can still disagree at the session boundary: delivery acknowledgement precedes full settle, harness completion must wait for actual settle, and first-turn binding must reach the same caller path. Serial ownership preserves reviewed work without overlapping edits.
**Consequences.** Preparation candidate `6b69f5ee33b0f1b451af866a8d78298ff7a84f4b` contains only approved pending, composer and activity merges and passed its exact-candidate identity/verify gate, but it is not the final release candidate. Harness corrections, first-binding, pending UI hydration, header and neutral-fleet integration remain outstanding. The version stays 0.3.4. No version change, push, tag or publication occurs until the final combined source candidate passes its gates and the user gives explicit permission. Frozen owner commits and uncommitted review candidates remain preserved; no task is marked done from partial or isolated evidence.
**Supersedes.** D-188 only for current shared-file ownership after M13-T92’s recorded handoff; D-188’s product and non-overlap contract is unchanged. D-189 only for its then-open optional-enhancement release-scope question: those enhancements are now excluded; its disclosure and terminal-run decisions are unchanged.

### D-191 · 2026-09-10 · Transfer the coupled lifecycle boundary to one continuing owner
**Decision.** After acknowledged frozen checkpoints `a0264674753cfa1999d00f89294492da5fd62e3e` and `d79c2869efffc054e2d919b99bc2fe7b43b587ea`, harness-lifecycle becomes the sole continuing owner of M13-T89, M13-T92 and M13-T93 across first-binding protocol/UI runtime/worker driver/server/integration tests and the existing harness. First-prompt-binding has relinquished all source, test and bookkeeping continuation. Composer, header, activity-disclosure and neutral-finished-run ownership does not change.
**Why.** First binding, pending acceptance, real session settlement and caller adoption share one runtime boundary. Serializing their final integration prevents reviewed checkpoint drift and concurrent edits while allowing every prompt lane to be proven together.
**Consequences.** The continuing owner preserves both unapproved source checkpoints into a coherent development batch, fences prompt/steer/follow-up/pending-tray callers across runtime preparation, integrates harness `promptUser`, and proves real SDK/server model and thinking selection, rollback, settled-gap, origin and acceptance. It must repair the reproducible local install and obtain real caller/browser evidence rather than treating isolated unit results as completion. Accepted preparation branch `6b69f5ee33b0f1b451af866a8d78298ff7a84f4b` remains unchanged and preliminary only. No unreviewed source enters main or that branch; no optional feature, version or release action is authorized.
**Supersedes.** D-190 only where ownership transfer was proposed but not yet complete. D-188/D-189 behavior, historical ownership and release constraints remain unchanged.

### D-192 · 2026-09-10 · Release the approved subset as stable 0.3.5
**Decision.** Add M13-T97 and release only the independently approved pending `e1c24c7`, composer `e7a5b89`, disclosure `131332b`, header `a8715dd` and neutral-finished-run `d694b07` subset as 0.3.5. Version preparation is authorized now. After review and clean integration, an isolated asynchronous gate must run `pnpm verify`, require successful source CI for the exact candidate SHA, create the immutable tag only while `origin/main` still equals that SHA, and leave both architecture builds plus verified asset publication to the unchanged release workflow.
**Why.** The person explicitly prioritized shipping the reviewed fixes without waiting in this turn for long local or GitHub gates, while withholding unapproved lifecycle work.
**Consequences.** Unapproved coupled batch `aba12f7b`, first-turn binding, harness lifecycle and HLC010 remain outside 0.3.5. M13-T89/T92 stay in progress, M13-T93 stays blocked on Q-8, and M13-T90/T91/T95/T96 keep their original full acceptance criteria; release inclusion does not mark them done. M13-T94 remains unchanged as the future complete-fix patch. Authorization does not bypass gates or establish readiness: until the asynchronous launcher and release workflow succeed, report only preparation or “tag pushed; release building,” never publication.
**Supersedes.** D-190/D-191 only where they prevented a bounded approved-subset release before the coupled lifecycle work; their source ownership, behavioral requirements and preserved checkpoint decisions remain unchanged. D-188/D-189 task acceptance criteria remain unchanged.

### D-193 · 2026-09-10 · Resume stabilization from the failed source gate
**Decision.** Diagnose and repair the failed 0.3.5 source gate first on a separate branch, without bypassing exact-candidate verification or publication safeguards. Q-8 is resolved for implementation: the person authorized one dedicated HLC-010 admission seam, with one new continuing lifecycle owner and independent review, preserving the frozen `aba12f7b` implementation and all resolved findings. Previous agents must not be resumed.
**Why.** CI and the local launcher both found a stale harness expectation after D-189; neither is publication evidence. The larger extension-send ownership defect remains independently blocking.
**Consequences.** The bounded repair excludes lifecycle source. After repair, carefully merge reviewed release changes into a separate development branch preserving `aba12f7b` history. No goal removal, Pi upgrade, product-policy change, HLC-005 rewrite or optional enhancement is authorized. M13-T94 retains all original criteria and needs separate later-publication permission. Original worktrees, user deletions and live state remain untouched.
**Supersedes.** H-6/D-192 only where HLC-010 implementation awaited Q-8; no release or behavioral gate is waived.

### D-194 · 2026-09-10 · Authorize the complete stabilization release after its gates
**Decision.** The person authorizes the orchestrator to commit, push and publish the next stable patch after completing the stabilization and validation requested in the initial continuation brief, without returning for another release approval.
**Why.** Release permission was previously bounded to T97/0.3.5; the person now explicitly extends it to the finished complete-fix scope under T94.
**Consequences.** Finish HLC-010 and preserve all resolved findings, complete the applicable first-turn/pending/UI/browser matrix, independently review the exact combined candidate, stage intended files before identity/verify, and require clean exact-SHA source CI plus native architecture, packaging, installer, checksum and provenance gates before verified publication. Failed gates remain blockers, never exceptions. Versioning occurs only after readiness; no optional Markdown/image enhancement, backlog redesign, user-data alteration, cleanup or install/restart is authorized by this release instruction. Keep all retained worktrees unless separate cleanup permission exists.
**Supersedes.** D-190/D-191/D-193 and Q-8 only where later complete-fix publication still required separate permission. Their preservation, correctness, scope and review requirements remain binding; D-192 remains the history of the already-published subset.


### D-195 · 2026-09-11 · Make the queued-completion runtime incident an explicit release gate

**Decision.** Add M13-T98 as a high-severity mandatory dependency of M13-T94, with the full supplied report in `docs/incidents/queued-completion-ownership.md`. Preserve M13-T93/HLC-010 and use its single continuing owner for the same admission/settlement boundary. Require the exact real-Pi reproduction with at least two queued messages, terminal declaration, next-turn abort/continuation, ordinary correction and interrupt; require all ownership/delivery/successor/callback invariants, truthful fleet and credential-free lifecycle diagnostics, independent review, and an identified fixed packaged-worker test after controlled isolated restart.

**Why.** The supplied transcript evidence reports completion before queued work stopped, failed busy successors including interrupt, continued edits/commit, and a later rejected completion. Installed manifests do not identify a running `(deleted)` executable's loaded code; a new checkout's tests alone do not prove this incident class fixed.

**Consequences.** The incident remains distinct from the repaired CI failure and from separate unresolved development admission/attribution defects. Recording it does not authorize a live restart or claim historical in-memory build attribution. Preserve every original release criterion, D-194 publication authorization, user state and source history. No extra implementation writer, policy rewrite, queue deletion to hide the problem, or “never again” guarantee from a label change.

### D-196 · 2026-09-11 · A parent's follow-up to a streaming child rides the engine's follow-up lane

**Decision.** `send_agent_message` without `interrupt` to a child whose engine is streaming enters the engine's own follow-up queue (steering with `interrupt: true`), tracked by the harness as engine-owned and transferred to the one successor run inside `complete_agent_run`; this reverses the harness-local follow-up of `e8db6b5`. Owned-but-not-streaming stays local and is delivered at the fence.

**Why.** The incident's mechanism only exists for engine-queued messages, so the mandatory M13-T98 reproduction must exercise that path; the person sees the parent's message in the child's own queue; and Pi's follow-up semantics ("when the model would stop") are what the tool description promises, without a settle-and-re-prompt round trip.

**Consequences.** The harness owns the transfer: `transferEngineQueue` runs inside the terminating tool and before any abort on stop or extension error, matching per lane in order (identical texts once, consumed texts dropped, texts the harness never sent kept). Texts Pi expanded (templates, skills) are kept but lose their local identity. Custom messages Pi queues straight into `agent.steer()` are not enumerable by `clearQueue()` (engine limitation, recorded for upstream). Reverting to harness-local is one line (`const engine = interrupt && driver.state().isStreaming`) but would need the mandatory scenario's engine-queue assertions restated through a person's explicit follow-up.

### D-197 · 2026-09-11 · Record the keystroke-burst draft-restore crash as its own task

**Decision.** Add M13-T99 for the pre-existing intermittent React #185 crash during fast per-character typing bursts in the composer's draft restore, found by the M13-T89 browser gate on the released bundle. It is not a dependency of M13-T94.

**Why.** The crash predates the stabilization work (reproduced on the 0.3.5-era bundle and on a build without the first-turn changes) and only reproduces under automated keystroke bursts; hiding it in a note would lose it, folding it into the authorized patch would widen scope without permission.

**Consequences.** M13-T94's gates are unchanged. The repro tooling in the session scratchpad is the starting point; the fix belongs in `packages/ui/src/components/assistant-ui/elements/draft-restore.tsx` and needs a real-browser regression, not only vitest.

### D-198 · 2026-09-11 · Record the browser gate's non-blocking observations as one task

**Decision.** Add M13-T100 for the design and interaction observations the combined-candidate browser gate made (Beam bubble overlapping the session composer's controls at desktop width, a sticky tooltip after touch in the phone sessions drawer, one unreproducible shared-profile reload restoration, a sandbox-only title typo). None is a dependency of M13-T94.

**Why.** They are real product observations that predate the candidate and would be lost in a note; they are outside the authorized stabilization scope and must not widen the patch.

**Consequences.** M13-T94's gates are unchanged; the evidence paths are in the task's notes.

### D-199 · 2026-09-11 · A message the engine handled without a model turn ends its run quietly

**Decision.** A run the harness created for a person's message that the engine accepted and ran no model turn on (a handled slash command such as `/goal pause` typed into a child's chat) ends `cancelled` with `endedBy: { initiator: "harness", reason: "Handled without a model turn." }`, the fleet's neutral *Ended*, and its parent is not woken. The rule fires only when the driver stamped the invocation and the run's turn count did not grow; drivers without epochs are unaffected.

**Why.** Before, such a run stayed `running` with an idle lifecycle phase (review finding F4): a phantom Working row that only a later message healed. `completed` belongs to the tool alone, `failed` would brand a person's command as a failure, and the parent never learned the run began, so a wake would start a parent turn for nothing.

**Consequences.** Every surface that reads run status already treats `cancelled` as ended work; `endRun` gains a `wakeParent` option used only here. Pinned by `queued-completion.test.ts` "ends the run a handled slash command created without a model turn…".

### D-200 · 2026-09-11 · Custom messages the engine queued out of sight are carried as text, not parked

**Decision.** An extension's triggering custom message that Pi queues straight into agent-core's steering or follow-up queue keeps its engine timing (delivered before the next model call). At a terminal declaration, a stop or an extension error the driver's `clearQueue()` reads agent-core's queues before emptying them and reports the custom texts; the harness transfers them to the successor as foreign text messages with a `warn` diagnostic. A person's clear on a child returns only the composer's two lanes and parks the custom texts for the fence.

**Why.** Review finding F5: such messages were invisible to `clearQueue()` and silently dropped (contract 2). Parking them locally instead would delay every background exit wake and grandchild event to after the child's whole agent loop, regressing the AGENTS.md wake guarantee.

**Consequences.** A carried custom message loses its custom type, display and details (text survives; images are not carried; no shipped producer sends them); the intra-lane order between custom and user texts is not preserved. Re-delivering it as a custom message would need a driver verb — a future task if a producer needs it. The engine limitation is recorded for upstream in the M13-T98 notes.


### D-201 · 2026-09-11 · Inspect instruction template variables alongside Markdown source
**Decision.** Add M13-T101 extending the existing shared template editor with a syntax-highlighted source view and explicit variable-value disclosure.
**Why.** The person requested Markdown highlighting and a way to open each variable’s current value.
**Consequences.** Preserve stored templates and runtime rendering; never fabricate live session values in the definition editor.

### D-202 · 2026-09-11 · Include two separately owned user-reported corrections
**Decision.** Add M13-T102 agent-model selection and M13-T103 full-span activity timing to this batch as independent cohesive owners.
**Why.** The person additionally reported both issues while M13-T101 was being investigated.
**Consequences.** No release/version change; retain first-send atomicity and disclosure behavior, and review each milestone independently.

### D-203 · 2026-09-11 · Parent messages interrupt by default, with explicit queue opt-out
**Decision.** M13-T104 changes omitted/true `interrupt` into actual cancellation-and-redirection of the child’s current invocation; false keeps queue semantics. Preserve accepted queued work and deliver parent priority at a fenced admission boundary.
**Why.** The person explicitly requested full parent control and priority rather than steering at the next model call.
**Consequences.** Foreground cancellation is cooperative until its execution settles; completed side effects cannot be undone and detached background tasks are not implicitly stopped. No protocol/runtime overlap is permitted with the active first-turn model owner. Question answers retain their existing supported response path.

### D-204 · 2026-09-11 · Explicit parent-message delivery modes
**Decision.** Replace the interrupt boolean with one mode selector: Interrupt (default), Steer, Queue, and Answer for an open typed question. An Interrupt must cancel and redirect even while a child waits on a question; Answer uses the existing response validation.
**Why.** The person requested full interrupt as the default among explicit delivery choices. A question-first exception would quietly defeat that control.
**Consequences.** No boolean alias or ambiguous competing controls; update tool descriptions, schemas and source callers together. Queue/Steer do not implicitly answer questions. Supersedes D-203’s provisional boolean API, retaining its cancellation/priority intent.

### D-205 · 2026-09-11 · Split fleet items by lifecycle and repeat ancestor context
**Decision.** Replace ux-fleet R2 whole-branch partitioning with per-item sections. Active and Finished trees each retain the ancestry needed for their own work; a parent can appear in both as structural context without being counted twice or falsely marked finished.
**Why.** The person explicitly wants ended commands and subagents to move to Finished while their owner remains active.
**Consequences.** Preserve canonical identities/state and creation order. Section counts, recursive Clear, reveal/expansion keys and controls must distinguish context rows from actual section members. Supersedes the whole-branch rendering rule, not session scoping or canonical fleet/run state.

### D-206 · 2026-09-11 · Repair model-list scrolling within built-in dialogs
**Decision.** Add M13-T106 under the continuing model-picker owner, after T102’s reviewed source handoff. Fix the scroll/portal boundary, not the model-selection transaction.
**Why.** The person reported that Namer’s provider-specific model list cannot scroll.
**Consequences.** Prove actual wheel/touch movement in Namer and shared Beam/Chat dialogs, nested provider filtering, keyboard focus and outer dialog scroll locking; no global modal-lock disable.

### D-207 · 2026-09-11 · Freeze release0.3.7 to reviewed instructions and activity timing
**Decision.** User-authorized release contains T101/T103 only, frozen at integrated `4acae2e`, plus release metadata/ledger. T102/T104/T105/T106 remain preserved and excluded even if additional review arrives while packaging.
**Why.** The person explicitly asked to release what is already done and reviewed, then provide a done/next table.
**Consequences.** Pause unfinished implementation at safe checkpoints; build/test isolated candidate, clean source CI before tag, pipeline-owned verified x64/ARM64 publication before claiming shipped. No installed host restart or interruption of live sessions.

### D-208 · 2026-09-11 · Continue isolated work alongside the frozen release
**Decision.** Resume unfinished owners in their own worktrees while release0.3.7 remains fixed to candidate `8577bef` (T101/T103 only).
**Why.** The person correctly clarified that isolated ongoing work need not stop to publish selected reviewed commits. The orchestrator’s broad pause was unnecessary.
**Consequences.** Supersedes only D-207’s pause instruction, not its release scope. T105 resumes its preserved dirty checkpoint; T102 addresses its one review’s findings, then the same owner continues T106. T104 still waits on corrected/verified T102 interfaces, a real dependency; it can receive that branch directly without changing the release candidate. No unreviewed work enters main/tag/candidate.

### D-209 · 2026-09-11 · Investigate empty-session lifecycle across Beam and projects separately
**Decision.** Treat the new screenshot as a canonical session lifecycle bug, checking Beam and ordinary projects across worker retirement and host restart; protect missing-transcript recovery guards until a truthful fix is planned.
**Why.** The exact host error is reached when an unwritten session outlives its worker. Removing the guard risks silently making an unrelated session under a stale path.
**Consequences.** Bounded read-only investigation can run alongside T102/T105 and frozen8577bef release; implementation ownership must be settled with the active first-turn owner if SDK creation/persistence is implicated. No expansion of the release candidate without explicit release-scope approval. Preserve live state, old paths and drafts.

### D-210 · 2026-09-11 · Preserve history; disable only future Claude attribution
**Decision.** Add project Claude Code `attribution.commit` and `attribution.pr` empty strings using its documented settings; retain all existing co-author trailers and original commit/tag objects.
**Why.** The person explicitly forbids changing historical messages or disrupting worktrees/releases. Existing co-author trailers are part of the commit message and cannot be removed without changing commit IDs and descendants.
**Consequences.** Normal new commit/push only; future automatic attribution suppressed alongside existing AGENTS prohibition. Historical cleanup is not performed or claimed.

### D-211 · 2026-09-11 · Separate durable-empty persistence from explicit legacy recovery
**Decision.** Split original T108 acceptance into durable-new-empty lifecycle/first-send transaction safety (T108) and dependent person-chosen legacy draft recovery (T110), with one continuing owner sequentially.
**Why.** Marking Pi’s manager flushed changes persistence during T102 preparation; byte-identical refusal needs an explicit design. Legacy absent-catalog/pristine UI alone cannot distinguish unsaved old empties from intentionally deleted durable empties, so it cannot authorize automatic resend.
**Consequences.** Plan revision before source edits; no host sidecar/guard removal/arbitrary path recreation. T110 preserves original draft/duplicate-error/stale-picker acceptance, but uses an explicit new-session recovery rather than silent identity substitution.

### D-212 · 2026-09-11 · One main-UI destination owner for tab routing and later legacy recovery
**Decision.** Prioritize the newly reported wrong-conversation send as T111 under a dedicated UI destination owner. T108 continues backend durability without UI writes; unassigned T110 waits for both T108 and T111 and will continue under the UI destination owner after explicit research handoff.
**Why.** Chat’s visible tab and the root runtime’s Code fallback disagree, risking real messages in the wrong conversation. Fixing only the tab label/selection is insufficient; the lazy creation/send and asynchronous navigation paths share this state.
**Consequences.** Supersedes D-211’s prospective same-worker allocation for T110, not its behavior or dependency on durability. No active UI writer is displaced: T108’s approved scope explicitly forbids UI edits. Existing backend first-turn wire contract is stable, so bounded UI investigation can run independently. No release scope expansion or Git-history rewrite.

### H-8 · M13-T108/T110/T111 · 2026-09-11 · orchestrator
State: T108 owner explicitly confirmed backend-only clean `4e72bf0`, no UI writes, and released prospective T110 research to the continuing T111 UI destination owner.
Artifacts: `/tmp/laser-m13-t108-ui-evidence.json`, `ui-host.mjs`, `real-host.json`, and `empty-session-plan.md` (same filename prefix).
Next: T111 finishes routing; T108 completes its single review correction. Only then assign explicit legacy-empty recovery to the UI owner. Do not resurrect missing/corrupt paths, silently transfer drafts, resend, or weaken guards.

### D-214 · 2026-09-11 · Collapsed edit/write diff counts
**Decision.** Add M13-T112 as a bounded display change using the existing diff-stat element and captured shared projection. Preserve full available counts before preview truncation; no filesystem reads or fabricated removal counts.
**Why.** The person should not need to expand an action to see its change size.
**Consequences.** Separate owner for the small change; ToolRow ownership must be explicitly released by T111 before wiring it. Routing and durable-empty work continue independently.

### D-213 · 2026-09-11 · Reconnect-safe admission reads and bounded question delivery
**Decision.** Pre-acceptance hydration serves genuine committed state/entries/leaf/goal while pending-list remains live canonical. Existing numbered replay ordering is unchanged. Only question requests wait behind their requesting connection’s load response; authoritative closes pass immediately and invalidate buffered requests.
**Why.** A question must not hold the lease that blocks opening the view needed to answer it. Lifetime host dialog caches duplicate ownership and miss direct/remote answers; buffering ordinary replay changes established sequence semantics.
**Consequences.** Worker UI bridge reports every actual settlement. A bounded host delivery helper serves local and encrypted transports without new protocol fields, persistent state, UI changes or crypto changes.

### D-215 · 2026-09-11 · Release the complete current batch after remaining safety gates
**Decision.** Add T113 for 0.3.8 containing the entire current batch, including routing and explicit legacy recovery; finish this batch before unrelated work.
**Why.** The person explicitly authorizes completing these changes and then creating a release that includes everything.
**Consequences.** T110 and T111 remain release dependencies. Freeze the final reviewed source, validate exact-source CI and both packaged architectures, then publish verified assets. Do not change v0.3.7, rewrite history, or update/restart installed processes.

### D-216 · 2026-09-11 · Drop product legacy recovery; release completed persistent-session batch
**Decision.** Retain implemented persistence for genuine empty sessions. Do not implement T110 or redesign Plus as draft-only. Give the sole user a one-time browser script in chat, then release0.3.8 with the completed batch.
**Why.** The person explicitly declines additional product recovery work and requests script-only handling for existing leftovers.
**Consequences.** T110 is dropped before implementation. The script backs up available text and resets remembered selections; it cannot recreate unsaved transcripts or recover missing attachments and will not claim otherwise. T113 no longer depends on T110; all other release gates and no-live-restart constraints remain.

### D-217 · 2026-09-11 · A deterministic command owns routine release orchestration
**Decision.** Add T114 and document its use in AGENTS. Reuse existing architecture-build, installer and publication guards; routine releases run the command directly rather than delegating version preparation and monitoring to a subagent.
**Why.** The person explicitly requests release automation before this publication.
**Consequences.** Keep prepared e87eaf6 immutable and add automation atop it; review the combined candidate before using the new entrypoint for0.3.8. No tag/publication until exact-source CI; no forced refs, user-work cleanup, installed-process changes, or alternate publisher.
