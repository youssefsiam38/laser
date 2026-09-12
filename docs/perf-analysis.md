# Desktop performance investigation

## Recommendation

Start with **transcript subscription fan-out and timestamp formatting**, then reduce transcript mount/unmount work. Do not start by changing SQLite, WebSocket compression, or Shiki languages.

The renderer can spend most of a streaming turn executing JavaScript despite very small messages from the host. Settled assistant footers subscribe indirectly to the entire changing session view. Their timestamps are then formatted again. This is a substantially better lead than “Electron is slow.”

### Ranked opportunities

Rank combines felt impact and evidence confidence, not implementation order. **Expected gains are hypotheses/ceilings, not measured fixes; overlapping rows must not be added.** S = localized helper/selector change; M = coordinated component/runtime change; L = lifecycle/scrolling architecture and interaction regression work. Paths below are relative to `packages/`.

| Rank | Finding / confidence | Measured before | Expected gain / next experiment | Effort | Change location |
|---|---|---|---|---|---|
| 1 | Settled footers receive live-session updates — high | **12,325 AssistantFooter executions**, but only **4 AssistantMessage executions**, in the counter run; baseline streaming used **10.89 s scripting / 500 deltas** | Remove history-wide footer updates. Potentially seconds of scripting per long turn; measure again before promising a percentage | M | `ui/src/components/assistant-ui/elements/reasoning-effort.tsx:170,240`; `ui/src/runtime/LaserProvider.tsx:1872`; `ui/src/components/thread/messages.tsx:537` |
| 2 | Repeated locale formatter construction — high | `messageTimeLabel`: **1,066 ms sampled self CPU** during streaming. Browser microprobe: **480 calls, 57 ms**, versus **1.2 ms** using one `Intl.DateTimeFormat` | Reuse formatters and formatted values. About **56 ms saved per 480 calls** in the microprobe; application gain overlaps #1 | S | `ui/src/components/assistant-ui/elements/message-timestamp.tsx:23–45` |
| 3 | All transcript messages remain mounted — high | Original 240-message fixture: **7,088 DOM elements**, 240 timestamps/actions, 495 tooltip triggers. Corrected long→short **241 ms median**; short→long **663 ms** | Bound mounted rows, or first reduce per-row UI/subscriptions. Target materially lower hundreds-of-ms switch cost; exact gain unmeasured | L | `ui/src/components/thread/Thread.tsx:108`; `ui/src/components/thread/messages.tsx:77,127`; runtime switching `ui/src/runtime/LaserProvider.tsx:1425` |
| 4 | Per-message history scans compound across the transcript — high | Assistant-footer prompt selector **303 ms sampled self CPU**; `activePathIds` **132 ms**, across 500 deltas | Precompute ordinal/prompt/entry relationships once per history identity; eliminate repeated scans. These measured regions overlap #1 | M | `ui/src/components/thread/messages.tsx:161–174,542–562`; `ui/src/components/thread/entries.ts:39` |
| 5 | Startup entry includes optional renderers — high for bytes, medium for latency | **2.625 MB JS**, **788 KB gzip**; only this JS resource fetched during first 5 s. Mapped entry includes ~260 KB KaTeX and ~126 KB XYFlow | Move optional math/map/highlighting implementations behind actual use; several hundred KB of initial code is a plausible byte win. CPU gain needs A/B | M | `ui/src/components/assistant-ui/elements/markdown-text.tsx:36–50`; `ui/src/components/agents/map/MapCanvas.tsx`; `ui/vite.config.ts` |
| 6 | Shell work also fans out on streaming — high for aggregate counts | **422 ThreadListItem**, **206 FleetPanel**, **103 TelemetryPanel** executions in the counter window; **zero** executions of measured components during preceding 5 s idle | Narrow view subscriptions and stabilize derived shell models. Aim for no row/panel executions on irrelevant text deltas | M | `ui/src/components/assistant-ui/elements/thread-list.aui.tsx:1101`; `ui/src/components/shell/TelemetryPanel.tsx:67`; `ui/src/components/fleet/FleetPanel.tsx:102` |
| 7 | Agent import validation gates cold desktop readiness — medium | Isolated installed app: initial desktop log→host ready **550 ms**; bundled-agent import **392 ms**; daemon spawn→ready **419 ms** | Separate read-only shell readiness from verified engine readiness, without allowing prompts early. **392 ms is an upper bound**, not additive saved time | M | `desktop/src/host-process.ts:183,289`; `desktop/src/main.ts:624–635` |
| 8 | Projection is still O(history), despite its part cache — high | Node source microbench at 240 blocks: projection **0.025 ms** + sharing **0.116 ms** per delta; at 2,400: **0.367 + 1.467 ms** | Cache completed message groups and goal derivations. More relevant at thousands of messages than at 240; do after #1–4 | M | `ui/src/runtime/projection.ts:497,546,578`; `ui/src/runtime/LaserProvider.tsx:1461` |
| 9 | Full model catalog loaded before opening a picker — medium | Initial `pi/models/catalog` response **447,015 bytes**, even with one configured synthetic model | Share lightweight effective-model capability data; defer the full chooser inventory. Byte reduction measurable; latency gain not established | M | `ui/src/components/assistant-ui/elements/reasoning-effort.tsx:199–204` |
| 10 | Initial history can be fetched again by the settled-thread effect — medium | Direct-switch capture: **13 entries requests / 11 loads**; long entries reply **115,498 bytes** after one added test turn | Deduplicate identical in-flight/fresh snapshots by session and sequence. Saving redundant bytes is real; warm host read is already **0.72 ms median** | S–M | `ui/src/components/thread/Thread.tsx:162–170`; `ui/src/runtime/LaserProvider.tsx` (`openSession`, `refreshEntries`) |

## Scope, reproducibility, and important limits

This is a **measurement report, not an implementation or release gate**. No source edits, installs, staging, or commits were made. The only repository file authored here is this document. All fixtures, browser profiles, generated bundles and app state are under `/tmp/perf/`. No personal application data or personal engine directory was read. Installed files under `/opt/Laser` were used read-only, with a separate HOME/state/port and Xvfb.

- Starting repository HEAD: `16ccafd60dd384f461e2ab8b55be1f59bff5f43b`, `main`.
- The shared checkout changed independently during the investigation. Later observed HEAD: `07d4222a796dd346cac7e3d4489f32ee8b3de237`. Final observed HEAD: `a9d8064624bc04cea23828d062a169b042b7e07b`. No attempt was made to reset or incorporate other work.
- **Build identity caveat:** existing workspace protocol/worker outputs initially identified as **0.5.0**, although package/source identity was 0.5.1. Baseline UI was freshly built from source against those existing dependencies; host used source through `tsx`, worker used existing built output. Later an external protocol rebuild changed its identity to 0.5.1. The isolated host was restarted to match for the separate counter build. The report does **not** claim a clean all-workspace 0.5.1 benchmark. Baseline source maps retain the measured UI source.
- Packaged startup is separately measured against installed **0.5.1**, bundled Node **24.20.0**. It is not mixed into browser session-switch totals.
- Browser/Node probes: Intel Core i7-14650HX, Node **24.11.1**, Chrome **153.0.8010.36**, 1360×900, default light theme, headless Chrome with no CPU throttling. Electron ran headed only under `xvfb-run -a`.
- Main workload: real host, real pinned engine, synthetic OpenAI-compatible local provider; one actual `bash` tool (`printf` only), then **500 SSE text deltas**, nominally 20 ms apart. No paid provider or credentials.
- Seeded histories: 4 and 240 messages. Baseline mount/profile begins at 240. Corrected switch timings were recorded **after one synthetic turn**, therefore the long transcript has **242 displayed messages**, including the longer generated response. Counter runs occurred after additional synthetic turns. Do not treat these as identical paired workloads.
- Only desktop/light was performance-profiled. Phone, dark theme, touch, hidden-window power, organic image-heavy histories, and populated agent-map performance remain unmeasured. No correctness tests/full workspace verification were run for this read-only report.

### Commands / artifacts

`/tmp/perf/clean.py` constructs an allowlisted environment, rather than inheriting credentials: HOME/XDG/TMPDIR under `/tmp/perf`, Node 24 PATH, no inherited `PI_*`, `*_API_KEY`, or `*_AUTH_TOKEN`. No `pnpm install` or workspace build was run; the UI build output was redirected outside the checkout.

```sh
# Run commands below through the allowlisted wrapper where applicable.
python3 /tmp/perf/clean.py node --import /tmp/mcp-explore/spike/node_modules/tsx/dist/loader.mjs /tmp/perf/host.mts
python3 /tmp/perf/clean.py node /tmp/perf/provider.mjs
python3 /tmp/perf/clean.py node /tmp/perf/seed.mjs

# From packages/ui, sanitized HOME/PATH/XDG cache:
node node_modules/vite/bin/vite.js build --configLoader runner \
  --outDir /tmp/perf/ui --sourcemap
# Result: pass, 11.03 s. Later preserved as /tmp/perf/ui-baseline.

python3 /tmp/perf/clean.py node /tmp/perf/measure.mjs
python3 /tmp/perf/clean.py node /tmp/perf/clicks.mjs
python3 /tmp/perf/clean.py node /tmp/perf/rpc.mjs
python3 /tmp/perf/clean.py node --import /tmp/mcp-explore/spike/node_modules/tsx/dist/loader.mjs /tmp/perf/pure.mts
python3 /tmp/perf/clean.py node --import /tmp/mcp-explore/spike/node_modules/tsx/dist/loader.mjs /tmp/perf/log-bench.mts
```

Baseline traces: `startup-{cpu,trace}.json`, `warm-startup-{cpu,trace}.json`, `stream-{cpu,trace}.json`. Corrected switch profiles: `direct-switch-{6,7,8,9}-cpu.json`. Summaries: `stats.json`, `categories.json`, `cpu-summary.json`, `bundle.json`, `rpc.json`, `pure.json`, `component-counts.json`.

For component counts only, `/tmp/perf/instrument.config.mts` adds function-entry counters **in Vite's in-memory transform**, producing a separate scratch production bundle. Repository component files are unchanged. `count.mjs` records a five-second idle baseline and a 16-second window during a configured 500-delta turn. This is distinct from the unmodified-bundle timing run.

An initial role-selector timing harness was rejected: Playwright accessibility lookup itself consumed roughly **160–170 ms** in some long→short samples. `clicks.mjs` instead resolves coordinates before measurement and timestamps the real pointer click in a capture listener. A preliminary React DevTools fiber-flag counter was also rejected as an execution counter; the accepted counts come from direct function-entry instrumentation. Its memory/formatter microprobe is identified separately below.

## 1. Startup

### Installed Electron, isolated cold host

The successful invocation used `LASERCODE_PORT=41673`, `LASERCODE_AGENT_DIR=/tmp/perf/electron-agent`, `LASERCODE_STATE_DIR=/tmp/perf/electron-state`, `LASERCODE_RESOLVE_SHELL_ENV=0`, plus `--remote-debugging-port=9267 --trace-startup --trace-startup-duration=5 --trace-startup-format=json` under Xvfb. An earlier invocation misspelled the environment prefix and was stopped; its default paths were still inside the isolated HOME. It is not startup evidence.

From `/tmp/perf/electron-state/desktop.log` and `electron.json`:

| Stage | Time |
|---|---:|
| First desktop log→identity available | 78 ms |
| First desktop log→daemon spawn | 131 ms |
| Bundled engine import check | 392 ms |
| Spawn→host declared ready | 419 ms |
| First desktop log→host ready | 550 ms |
| Host-page navigation→first contentful paint | 52 ms |
| First desktop log→host-page FCP, aligned using `performance.timeOrigin` | ~607 ms |
| Host-page DOMContentLoaded | 114 ms after navigation |

This is **not OS launch→first visible window**: the first log occurs after some main-process imports, and an initial data-URL screen may paint before the host page. The fresh profile reached onboarding; no restored-session interactive number is claimed for this Electron sample. Shell-environment resolution was intentionally disabled, so user shell startup latency is excluded. No application performance marks were present.

The 5-second native trace exists at `/tmp/perf/electron-startup-trace.json`. The import check finishes at exactly the host-ready log; `HostProcess` explicitly awaits it after health succeeds. That is evidence of a readiness gate, not proof that all 392 ms can be removed. Keep engine verification and version handshakes intact.

### Browser shell, real host already running

Fresh-browser first contentful paint: **44 ms** in the first trace, **36 ms** in the warm-worker trace. Warm-worker animation-frame observations: sessions row present **165 ms**; transcript DOM plus enabled composer **315 ms**. These are presence milestones, not an input-latency guarantee: the same five-second capture contains **four long tasks totaling 713 ms**, maximum **342 ms**, including later mounting/settling.

The entry script arrived in **8.4 / 19.3 ms** in the two samples. First paint includes the HTML startup surface and must not be called “the full app is ready.”

Prior evidence, not re-measured here: `/tmp/session-open-report.md` recorded one cold worker open at **638 ms total / 627 ms session/load**, and warm loopback history opening around 20 ms. Its historical revision and operation definitions differ from this report.

## 2. Session switching

Corrected pointer click→expected message DOM followed by another animation frame, five samples each:

| Direction | Median | Range |
|---|---:|---:|
| Long→4-message session | **240.8 ms** | 113.9–256.8 ms |
| Short→long session | **662.8 ms** | 616.5–712.9 ms |

The long session here is the initial 240-message fixture plus one tool/500-delta turn. The first six samples have no CPU profiler; the last four have sampling enabled. Results are not a paired claim against the earlier maintainer report.

### Attribution, without inventing a React commit breakdown

CPU samples were mapped through the production source map at 1 ms sampling. Categories below are **exclusive sampled self time** across each capture, including post-paint settling. They are **not** nested React Profiler durations and must not be summed into click-to-paint time.

- Long→short capture 6, **1.967 s capture**: React render/scheduling **56 ms**, assistant-ui **34 ms**, timestamp code **24 ms**, Markdown/highlight packages **21 ms**, React commit/deletion **17 ms**, GC **12 ms**, Radix **9 ms**, other **64 ms**; much of the remaining capture is idle/native `(program)` time.
- Short→long capture 7, **1.990 s capture**: React render/scheduling **224 ms**, assistant-ui **120 ms**, timestamp code **98 ms**, React commit/deletion **51 ms**, Radix **43 ms**, message/entry selectors **36 ms**, Markdown/highlight **29 ms**, GC **62 ms**, other **134 ms**, plus idle/native samples.
- The corresponding next pair reproduces the shape: timestamp **20 / 96 ms**, assistant-ui **33 / 121 ms**, React render/scheduling **49 / 211 ms**.

**It is not simply a 300 ms transcript deletion.** Deletion/commit exists, but runtime notifications, re-rendering, new row mounting, locale formatting and selector scans also contribute. No evidence identifies Shiki as the dominant switch cost; the seed has no code fences.

`content-visibility:auto` on message roots saves offscreen layout/paint, **not mounting, hooks, subscriptions, or teardown**. The 240-message DOM has 240 message footers/actions and 495 tooltip triggers even though only its tail is visible. Virtualization/windowing must preserve message identity, scroll restoration, find/jump, editing, attachments, approvals and keyboard focus; it is not a one-line replacement.

## 3. Streaming: main thread, projection, memory

### End-to-end baseline

One real tool call, two partial tool updates, then 500 text deltas. The trace captures ~**12.1 s**, including prompt startup and settlement. Browser receive timestamps span **8.68 s** between first and last text deltas despite the provider's nominal 20 ms cadence: a busy renderer receives queued messages in bursts. That interval is not a provider-throughput measurement.

- CDP scripting increase: **10.89 s**, or **21.8 ms per delta amortized** over the whole run.
- Task duration increase: **11.76 s**; layout **114 ms**, style recalculation **63 ms**.
- **96 long tasks**, totaling **10.67 s**; median **107 ms**, p95 **138 ms**, max **222 ms**.
- rAF: **137 observed intervals**, median **100 ms**, p95 **150 ms**, max **250 ms**; **94** intervals exceed 33.4 ms. Roughly **592 missed 60 Hz opportunities** from interval arithmetic, not an authoritative compositor dropped-frame count.

Exclusive CPU samples for the 12.10-second profile:

| Region | Sampled ms |
|---|---:|
| React render/scheduling | 3,099 |
| assistant-ui runtime/store | 2,105 |
| Timestamp component/formatting | 1,129 |
| Message/entry selectors | 717 |
| GC | 666 |
| React commit/deletion | 583 |
| Radix | 473 |
| Markdown/highlight packages | 259 |
| Projection/sharing | 28 |
| Store reducer | 2 |
| Telemetry component itself, excluding descendants | 3 |
| Other JS/native/program/idle | remainder |

The sample distribution points away from reducer arithmetic and toward subscription/React work. It cannot assign a precise duration to each individual delta or each component commit.

### Why old footers execute

`AssistantFooter` calls `useSupportedThinkingLevels()`. That reaches `useThinkingDefaults()` → `useSessionMeta()` → `useLaserView()`, which subscribes to the **whole session view**. Every accepted text delta replaces that view. A stable thinking-level result does not prevent the component calling the hook from executing. `AssistantFooter` also performs history scans and renders `MessageTimestamp`.

Direct function-entry counters, separate build/window:

| Component | Executions during 16-second turn window |
|---|---:|
| AssistantFooter | **12,325** |
| MessageTimestamp | **12,980** |
| UserMessage | 1,359 |
| Thread | 310 |
| ThreadMessage | 3 |
| AssistantMessage | 4 |

That distinction matters: **not all old Markdown bodies re-render on every token**. Much of the churn is footer/supporting UI even when the message body remains stable. Narrowing the hook is preferable to indiscriminately wrapping everything in `memo`.

`MessageTimestamp` calls `messageTimeLabel` twice per execution (description and clock). A browser-only, 480-date microprobe measured **57 ms** with `toLocaleTimeString(options)` and **1.2 ms** with one `Intl.DateTimeFormat`. Reuse the formatted string within the component too. Preserve locale/timezone changes and Today/Yesterday behavior; a cache must not freeze the day label forever.

### Pure source microbench: cache helps, but is not O(tail)

`pure.mts` imports real `applyUpdate`, `projectSessionView`, `shareProjectedMessages`; 100 warm-up iterations then 500 measured deltas. Synthetic blocks have empty persisted-entry arrays; no React, DOM or goal-rich history. Means in milliseconds:

| Blocks | applyUpdate | projection | sharing/deep equality | Prior message objects reused |
|---:|---:|---:|---:|---:|
| 4 | 0.0004 | 0.0039 | 0.0032 | 3 |
| 240 | 0.0018 | 0.0246 | 0.1160 | 239 |
| 2,400 | 0.0084 | 0.3667 | 1.4673 | 2,399 |

The WeakMap caches avoid rebuilding settled parts and re-stringifying settled tool arguments. However `projectMessages` still walks the complete block list, constructs message/group metadata, and `shareProjectedMessages` walks/deep-compares the complete projected list. `goalRecords` is also called from `projectSessionView`. The comment claiming O(tail) describes only part construction, not end-to-end projection.

`blocksFromEntries` is not called on ordinary text deltas: the update path appends to the active assistant text and copies the block array. Search/entry mappings and per-message selectors deserve separate caching; do not replace the value-only search contract with serialized JSON to make it “faster.”

### Memory

Baseline trace: JS heap increased **23.1 MB** across the run, with **666 ms sampled GC**. A separate diagnostic with explicit GC measured **66.4 MB before**, **211.7 MB before final GC**, **71.9 MB after final GC**: retained growth ~**5.5 MB**. This second diagnostic included a React hook observer and another generated turn, so its timings are not used as baseline performance. The gap suggests substantial allocation churn, not proof of a leak. No repeated-session soak or heap-retainer analysis was completed.

## 4. Sidebar, fleet, telemetry

The separate counter build recorded **422 sidebar row executions across two rows**, **206 FleetPanel**, and **103 TelemetryPanel** executions during its turn window. It does not split sidebar counts by row identity. Before sending, a five-second idle window recorded **zero executions** of every instrumented component.

The previously reported whole-`destination` row subscription is **already fixed**: current `thread-list.aui.tsx:1112–1116` selects active/opening booleans. Do not file the old review finding again. There is still parent/runtime/derived-model fan-out to investigate; the aggregate counts alone do not prove which subscription invalidates each row.

Telemetry subscribes to the whole view in several sections. There is **no polling interval in TelemetryPanel itself**. Its History refresh is on disclosure, and `EntriesRefresh` follows session settlement. Separately, `LaserProvider.tsx:624` polls the session catalog every **20 seconds**, and `SessionsPanel.tsx:37` ticks relative labels every **30 seconds**. The streaming wire capture contains three session-list requests and one entries refresh; this is not “SQLite queried for each token.”

The agent map's layout memo is keyed by `structureKey(visible)`, node box and direction (`components/agents/map/MapCanvas.tsx:80–88`). Preserve that invariant. This run had an empty fleet, so a streaming-child layout/re-render count is outstanding; do not generalize empty-fleet measurements to a large tree.

## 5. IPC, host reads, and logging

### Wire

Baseline: **500 separate `session/update` text notifications**, **146,186 bytes total**, median/p95 **293 bytes**. No application-level text-delta batching was observed; queued browser delivery is not batching. Tool progress is separate and retains the same execution identity. Only **two `pi/logs/append` notifications** arrived during this run.

Batching adjacent text deltas may later reduce subscription work, but first remove unnecessary consumers. Never coalesce away sequence/replay boundaries, tool starts/ends, pending questions, cancellation, or terminal settlement. A result must remain terminal; partial output stays in the artifact channel.

### Real host RPC without a busy browser

`rpc.mjs` performs ten sequential alternating session opens and entries reads over a separate Node WebSocket. Warm long-session medians: `session/load` **1.17 ms**; entries **0.72 ms**. Short medians: load **1.31 ms**; entries **0.17 ms**. Long payload ~**115.5 KB** after the first generated turn; response has `entries` and `leafId`, with **246 persisted entries** at that point, and no image content in this fixture.

The browser-observed RPC round trips can be hundreds of milliseconds while switching. That includes delayed JavaScript delivery/handling; it is not evidence of equally slow disk or host execution. The independent Node probe supports the original report's diagnosis.

The entries API carries the retained entry tree rather than a lightweight paged transcript. This fixture does not establish image-heavy cost; omission of image bytes, paging or snapshot-first rendering needs a synthetic image-bearing wire probe and protocol/replay tests before changing the contract.

### SQLite

`LogStore` uses synchronous `node:sqlite`, **WAL**, **synchronous=NORMAL** (`host/src/logstore.ts:208–209`). But `observeSessionUpdate` does **not** record text deltas or partial tool-output updates.

New scratch-database microprobe:

- 500 real `observeSessionUpdate(text_delta)` calls: **0.40 ms total**, **zero record calls**.
- 500 representative small tool records: **28.50 ms total**, **0.027 ms median**, **0.048 ms p95**.

These are local synthetic records, not large provider payloads or a full old log database. Large request redaction/hash/storage may still matter, but a per-token synchronous SQLite write is **not** the explanation here. Retention is scheduled off the hot path; retain the existing bounded content-reference design.

## 6. Bundle and initial loading

Production UI build: **319 JS chunks**, **14.49 MB total uncompressed**, excluding source maps. This total is not startup transfer.

| Chunk | Raw | gzip |
|---|---:|---:|
| Entry `index-1qP8XZTZ.js` | 2,624,738 B | 787,792 B |
| Mermaid renderer | 1,546,949 B | 471,435 B |
| Emacs Lisp grammar | 790,055 B | 198,872 B |
| C++ grammar | 785,531 B | 53,235 B |
| WASM chunk | 622,378 B | 230,334 B |
| Settings screen | 197,811 B | 53,910 B |

Only the entry JS was a page resource during the first five seconds of the plain-text startup. Thus **Mermaid and the large language grammars are already deferred**; deleting them does not save their full file sizes from this startup.

Generated source-map span attribution identifies approximately **260 KB KaTeX**, **81 KB XYFlow React + 45 KB XYFlow system**, **43 KB TextMate**, and **24 KB Shiki full-language loader inventory** inside the entry. These are mapped generated character spans, not independently compressed module sizes. Markdown plugins, UI icons and core runtime are also eager. No measured icon-specific bottleneck was found.

The browser received the entry uncompressed from the local host (~2.625 MB transferred). Compression could reduce wire bytes, particularly remotely, but the local fetch took only 8–19 ms; defer execution/mounting work before chasing that number. Avoid loading an optional map/math/highlighter merely because its launcher is mounted.

## 7. Electron settings and startup policy

- `windows.ts:220–232`: `show:false`, token-derived background, then `ready-to-show` → `show()`. Keep this; showing an unpainted window is not a meaningful speedup.
- `windows.ts:328–340`: sandbox/context isolation enabled, Node integration/webview disabled, spellcheck enabled, **backgroundThrottling:false**. Do not weaken isolation for performance.
- Disabling throttling may waste CPU while hidden. Hidden/minimized power was not measured; changing it requires reconnect, seen/notification and running-work checks. It is not a proven cause of foreground slowness.
- Xvfb log reports software compositing/rasterization and WebGL off. This is a property of the isolated display, **not proof that the person's installed window lacks GPU acceleration**. The app has a conditional Linux display policy; do not globally force GPU flags from this result.
- Existing workspace preload artifact: **5,859 bytes**. It is not a compelling bundle-size target.
- Tray setup is synchronous before window creation; identity and shell environment precede host startup. In the accepted isolated startup, identity was available in 78 ms and engine validation dominated the later gate. Notification code was not individually timed; no evidence supports removing it from startup.

## What is already good

1. Settled projected message objects are reused: **239/240** survive a text delta in the source microbench.
2. Ordinary text updates do not rebuild the persisted tree or stringify every settled tool argument.
3. Old assistant message bodies largely stay stable; the measured fan-out is disproportionately in footers and shell consumers.
4. Warm local host reads are fast. Optional goal/pending reads are concurrent and isolated from transcript failure.
5. SQLite does not write each token; WAL/NORMAL, bounded pages and content references are already in place.
6. Heavy Mermaid/language chunks are not fetched by the measured plain-text startup.
7. Agent-map positions depend on structure, not streaming output.
8. Secure preload/window settings and partial-output/terminal-result semantics should remain untouched.

## Proposed order: three batches

### Batch 1 — localized, high-confidence wins

Cache locale formatters/formatted clocks; narrow the thinking-capability/session-meta subscription used by every footer; precompute prompt ordinals/entry lookups. Re-run 500 deltas with function-entry counters and an uninstrumented timing build. Acceptance: settled footers do not execute for irrelevant text deltas, timestamps remain correct across locale/day changes, model/approval/cancellation controls still update promptly. These changes overlap; benchmark the batch, not summed estimates.

### Batch 2 — transcript and shell scalability

After measuring batch 1, reduce mounted transcript work, stabilize sidebar/fleet/telemetry subscriptions and message-group projection. Deduplicate fresh entries reads. Cover short↔240 and thousands-of-message histories, streaming tools, edits/forks, find in folded content, scroll restoration, keyboard focus, phone and both themes. Keep the map's structural layout key and approval footers outside collapsed bodies.

### Batch 3 — startup and background efficiency

Defer optional math/map/highlighter code; examine lightweight model capability data; separate shell readiness from engine readiness only with explicit product semantics. Then measure real compositor behavior and hidden-window power, and image-heavy entries over relay. Preserve generation handshakes and never start a prompt against an unverified engine.

### Cleanup and document validation

`/tmp/perf/cleanup.json` records zero remaining processes with the isolated HOME after cleanup, including the test host/worker/provider, Electron and Xvfb. Scratch artifacts remain for inspection; no test service is intentionally left running. `git diff --no-index --check /dev/null docs/perf-analysis.md` passed. The report is untracked/uncommitted; other checkout changes belong to other work. Replaying scripts requires aligning their recorded client version with a newly built isolated host, not bypassing the handshake.

**Next maintainer action:** reproduce batch-1 baseline in an isolated, fully built checkout at one frozen SHA. The measured hotspots are actionable, but this shared checkout's changing build identity prevents treating the investigation as an exact-current-release performance certification.
