# Session opening: where the time goes

## Verdict

**The large-history wall is the renderer, not reading/replaying the local file.** A final rerun after removing all application/backend instrumentation reproduced **2.89 s warm / 4.06 s cold** for 2,000 messages. Its first entries response arrived at **39 / 816 ms** after the click; most waiting remained afterward.

Three distinct costs matter:

1. **Unbounded mounted history, entering and leaving a conversation.** Keeping the full entries response but rendering only 40 rows reduced a 2,000-message open from **1,979 to 252 ms**. Leaving 2,000 mounted rows for an already-loaded four-message conversation took **1,932 ms**; limiting the departing tree to 40 rows reduced that to **153 ms**. These are separate operations, not additive savings.
2. **A second full snapshot immediately after mounting.** In an alternating-order experiment, suppressing the initial `EntriesRefresh` request reduced opening-plus-settlement scripting from **3,596 to 2,322 ms**. First readable content improved only **2,368 → 2,081 ms**: much of this unnecessary work happens *after* the conversation first looks ready.
3. **Cold worker startup gates history.** Approximately **550 ms** is spent getting a new worker ready, before its saved-session open. Prestarting just the worker reduced the browser's load request from roughly **652 to 98 ms**. This is independent of history paging.

**M16-T16 is correctly aimed, but B alone is insufficient for sustained navigation.** B's tail window reduces the expensive rows initially mounted, even though transfer is cheap. B also removes the mount-triggered refresh. C preserves continuity; D must bound mounted rows after older pages accumulate. A does not explain the two-project fixture's transcript delay. Neither B nor E removes the cold-worker gate: B's window route still goes through the authoritative worker, and E deliberately must not start workers speculatively.

No optimization is shipped here. All application/dependency instrumentation and experimental changes were discarded; only this report is committed.

## Scope and method

- Measured source: **`7c8b82011a376a76b47053058daaca24b74fc637`**, isolated branch `agents/session-open-forensics-45906d80`; fresh complete workspace build, not the parent's generated files or an installed daemon.
- Node **24.11.1**, pinned Pi **0.85.0**, Chrome **153.0.8010.36**, Intel i7-14650HX. Desktop **1360 × 900**, light theme, headless Chrome using the shared harness's normal flags. No network or CPU throttling.
- Startup, fixtures, browser, theme, isolated HOME/XDG/state, RPC and teardown all use `scripts/browser-check/`. Probe programs call its importable API and built-in target/fixture adapters; there is no replacement server/provider/browser harness.
- `short`, `long`, `huge` contain exactly **4 / 240 / 2,000 messages**, created by real RPC turns against the existing deterministic local provider. They contain prose, not code fences, images, tools or mathematical expressions. A separate disposable project supplies the initially empty conversation, so the destination is genuinely unopened in each fresh renderer.
- **Warm** means the target worker and its session are already resident, but the renderer has no target view. **Cold** means the target project's idle worker is stopped through the real RPC before clicking its row; backend PID/startup marks prove a fresh process. This is *not* a cold OS page-cache experiment. A separate **worker-warm/session-cold** experiment prestarts the process without loading the target session.
- Each main table cell and each timing comparison has **10 samples per case**. The separate CPU profile is diagnostic, not a ten-sample population estimate. Medians of different phases need not add to the median total; nested timings must not be added at all.
- Initial unpinned runs showed substantial whole-renderer speed variation, including one 240-message warm batch slower than its cold batch. They remain in the artifacts. The final phase-budget rerun restricts only the test process tree to logical CPUs **4–15** (performance cores), without changing machine power settings or other processes. Removal comparisons below use their own explicitly identified, internally comparable unpinned batches; do not subtract those totals from the final budget as if they were paired.

### What the endpoints actually mean

A capture-phase **real pointer click** starts the clock. Coordinates are resolved before the click, not by an expensive accessibility query inside the timed interval. Every sample reloads the empty control view and asserts it is empty; clicks on an already-selected destination are rejected, not treated as fast opens.

Temporary marks cover provider entry, load send/return, entries send/return, hydration dispatch, projection and `Thread` layout effects. A layout effect is a **completed React commit boundary**, not React render CPU time. Its row count distinguishes the immediate empty/loading commit from a transcript-row commit. A MutationObserver records the first actual transcript text.

“First transcript paint opportunity” is two animation frames after the first text mutation. **This is not the navigation-only browser FCP metric or a compositor/pixel proof.** There is no native per-component FCP API. The final readable endpoint additionally requires the expected row count, the last assistant's actual text, and its complete row inside the viewport above the sticky footer, followed by two frames. Text/geometry and screenshots support this bounded definition; it does not mean every historical message fits on screen, or that the main thread has finished all subsequent work.

Backend timestamps use `performance.timeOrigin + performance.now()` and PID correlation. The early Node preload separates process startup from module/worker readiness. Engine markers distinguish the destination worker from the other project's resource-preview driver; mixing those PIDs initially produced misleading near-zero file-load figures, which were corrected before reporting.

## Instrumented phase budget

The tables below use the strict text/geometry endpoint and the performance-core rerun. Times are milliseconds. `—` means no such operation occurs, not an unmeasured zero.

### Cumulative boundaries, measured from the click

| Boundary | 4 warm | 4 cold | 240 warm | 240 cold | 2,000 warm | 2,000 cold |
| --- | ---: | ---: | ---: | ---: | ---: | ---: |
| Destination identity chosen / provider entered | 1.0 | 1.0 | 1.0 | 1.0 | 1.0 | 1.0 |
| Load sent | 1.1 | 1.1 | 1.1 | 1.1 | 1.1 | 1.1 |
| Load reply observed by renderer | 21.9 | 651.0 | 21.3 | 641.8 | 21.6 | 642.2 |
| Entries request sent | 22.1 | 651.2 | 21.4 | 642.0 | 21.8 | 642.5 |
| Entries returned | 25.2 | 653.9 | 25.0 | 645.7 | 35.4 | 652.1 |
| Store hydration finished | 25.3 | 654.0 | 25.7 | 646.3 | 39.0 | 656.0 |
| First React commit (often still empty) | 7.8 | 7.2 | 7.5 | 7.4 | 7.9 | 7.4 |
| First commit with transcript rows | 61.7 | 686.7 | 213.8 | 830.6 | 1,325.9 | 1,986.7 |
| First transcript text observed in DOM | 69.5 | 695.9 | 289.0 | 915.0 | 2,010.2 | 2,819.4 |
| First transcript paint opportunity | 76.0 | 713.3 | 406.8 | 1,038.9 | 2,063.7 | 3,171.8 |
| Last message readable | 105.1 | 744.1 | 427.8 | 1,064.2 | 2,115.3 | 3,230.2 |

The first empty commit runs in parallel with backend loading. “Identity chosen” is the known row/path resolved before `openSession`; destination **ready** is a later transaction after hydration, not a second lookup taking hundreds of milliseconds.

### Durations and size (not cumulative)

| Phase | 4 warm | 4 cold | 240 warm | 240 cold | 2,000 warm | 2,000 cold |
| --- | ---: | ---: | ---: | ---: | ---: | ---: |
| Browser load round trip | 20.9 | 649.9 | 20.0 | 640.7 | 20.6 | 641.1 |
| Host admission → worker ready | 0.2 | 562.0 | 0.2 | 559.1 | 0.2 | 547.4 |
| Worker ready → worker reply | 0.9 | 88.8 | 0.8 | 86.3 | 1.3 | 94.0 |
| Entries round trip | 2.8 | 2.8 | 3.7 | 3.8 | 13.9 | 9.8 |
| Hydration dispatch | 0.2 | 0.2 | 0.6 | 0.6 | 3.0 | 3.0 |
| Projection CPU, summed through readable | 0.2 | 0.1 | 0.6 | 0.6 | 1.9 | 2.0 |
| Hydration end → readable: runtime/React/scheduling/frames | 79.7 | 87.5 | 401.9 | 427.0 | 2,075.2 | 2,581.4 |
| Entries reply bytes | 2,720 | 2,720 | 106,723 | 106,723 | 884,648 | 884,648 |

Hydration includes synchronous store publication, not just `blocksFromEntries`. Projection timings are nested in the renderer remainder; they are not extra time to add. Entries sizes include the JSON-RPC reply. Goal/pending/command reads overlap; only history gates readiness.

### Inside a cold load

| Nested phase | 4 messages | 240 messages | 2,000 messages |
| --- | ---: | ---: | ---: |
| Worker creation/readiness gate | 561.97 | 559.06 | 547.38 |
| Saved-session handling + worker IPC | 88.76 | 86.33 | 94.03 |
| SessionManager open: read, parse, indexes | 0.47 | 1.04 | 4.47 |
| ↳ synchronous file reads | 0.02 | 0.04 | 0.22 |
| ↳ JSON parsing | 0.03 | 0.42 | 2.87 |
| Explicit active-context build | 0.19 | 0.30 | 0.89 |
| Create services (model/auth/resources) | 67.07 | 65.42 | 65.52 |
| ↳ resource reload | 12.54 | 12.17 | 12.21 |
| ↳ final offline model refresh | 45.51 | 44.26 | 43.78 |
| Create agent from services, including SDK context | 1.83 | 1.85 | 2.41 |
| Bind extensions | 2.01 | 2.12 | 3.20 |

Manager read/parse are nested. Remaining manager time is header handling, decoding/line splitting, migration/index/leaf setup. Remaining worker time covers agent recovery, settings/MCP preparation, runtime wrapper, fallback/state decoration and pipe handling; it is **not attributed more narrowly by this probe**. Services can overlap background model availability work, so its inner medians are not a disjoint accounting. Resident warm sessions do not execute these saved-runtime stages.

### Variation

| Case | Readable median | Range | Samples |
| --- | ---: | ---: | ---: |
| 4 warm | 105.1 | 98.2–115.5 | 10 |
| 4 cold | 744.1 | 719.1–789.0 | 10 |
| 240 warm | 427.8 | 404.2–555.3 | 10 |
| 240 cold | 1064.2 | 989.9–1214.5 | 10 |
| 2,000 warm | 2115.3 | 1892.4–2641.2 | 10 |
| 2,000 cold | 3230.2 | 2666.0–4107.0 | 10 |

The cold and warm renderer distributions differ too; subtracting their end-to-end medians is **not** an estimate of worker startup. Backend marks and the explicit prewarm removal isolate that gate. The roughly four-second complaint is plausible within the observed ranges, but there is no single four-second file-read operation.

### Unmodified-source confirmation

After restoring the exact main sources, force-regenerating host/worker output and rebuilding the workspace, the same strict browser probe (performance-core affinity, ten each) produced:

| 2,000 messages, cumulative boundary | Warm | Cold |
| --- | ---: | ---: |
| Load sent | 1.35 | 1.25 |
| Load response observed | 31.15 | 809.30 |
| Entries response observed | 39.10 | 816.35 |
| First transcript text observed | 2,657.55 | 3,682.70 |
| First transcript paint opportunity | 2,821.80 | 3,992.80 |
| Last message readable | **2,891.50** | **4,057.45** |
| Entries response → readable, duration | **2,851.65** | **3,202.20** |
| Readable range | 2,340.4–4,699.1 | 3,359.3–5,476.8 |

The browser observer remains, but there are no marks, render substitutions or engine hooks in the application/backend. This batch is slower than the instrumented one, including its load round trip. **Instrumentation has not been demonstrated timing-neutral, and machine/scheduling drift is not disentangled from it.** The earlier detailed budget must not be rescaled or presented as an exact decomposition of this batch's 4.06 seconds. What the clean-source boundary measurement independently proves is that roughly **3.2 seconds remain after entries delivery** on the cold path. The removal comparisons are made within their own builds, not against this later total.

## Why the engine is not replaying for seconds

`WorkerServer.sessionLoad()` has two materially different paths:

- A resident session returns decorated driver state and replay metadata; it does **not** reopen the file, discover resources or construct another agent runtime.
- An absent session recovers its agent record, calls `StableSdkDriver.open()`, opens `SessionManager`, creates services/runtime, binds extensions and restores fallback state.

Pi's `SessionManager.open()` reads a bounded header and then the complete JSONL file. `loadEntriesFromFile()` uses bounded synchronous reads, line splitting and JSON parsing. It builds entry indexes and the active branch. These are O(history), but not expensive at these fixture sizes: an earlier ten-sample cold 2,000-message batch measured **4.37 ms** for manager opening, including **0.19 ms** of synchronous reads and **2.81 ms** of JSON parsing; the explicit context build was **0.83 ms**. It is not a four-second replay.

There is repeated work: Laser builds context to restore the saved model/thinking tuple, then Pi's SDK builds context again when creating the agent. The second build is included in agent creation, not independently timed. Agent-record recovery uses a bounded leading-file scan, not another full history parse. A header read is not a second complete transcript read.

The larger saved-runtime stage is **model/provider services**, not immutable resource discovery. In the detailed cold probes, services took about **66 ms**, resource reload about **12 ms**, and the final offline model refresh commonly about **44–46 ms**. `ModelRuntime.create()` refreshes by default; `createAgentSessionServices()` reloads extensions, applies their provider registrations, then refreshes again with `allowNetwork: false`.

A throwaway loader experiment skipped only that final refresh. Four-message cold worker-side open fell **87.33 → 45.61 ms**, services **65.93 → 23.03 ms**, and end-to-end **714.15 → 677.20 ms** (ten each). This confirms a smaller non-history cost; it does **not** authorize deleting the refresh in production. Providers registered by extensions and mutable authentication/model configuration must be honored. Disabling Goals did not remove this services cost. This corroborates the existing audit's F19 finding rather than reopening its rejected runtime-sharing proposal.

The cold startup gate is separate: Node process launch begins promptly, but importing/evaluating the worker/engine graph and reaching worker readiness occupies most of the roughly half-second before the saved-session open. This includes worker initialization; it is not all OS process-creation overhead. Keeping the worker resident moves that gate off the click path. Keeping the particular session resident removes its service construction too.

Ten-sample performance-core confirmation, four-message destination:

| Preparation before clicking | Cold process | Process prestarted, session not loaded | Session already resident |
| --- | ---: | ---: | ---: |
| Click → strict readable | 744.10 | **174.80** | 105.10 |
| Browser `session/load` | 649.85 | **89.25** | 20.90 |
| Host admission → worker ready | 561.97 | **0.19** | 0.20 |
| Worker ready → reply | 88.76 | 88.20 | 0.86 |

Only the test's target project is started/stopped. Prestarting retains the saved-runtime work while eliminating process readiness, rather than fabricating a metadata response.

## Renderer attribution and removal experiments

### 1. Rows, not history bytes

These are throwaway render substitutions in the real app, not implementations of paging or virtualization. The slice experiment retains the complete engine load, entries response, store hydration and projection; it slices only the projected **displayed** message list. It deliberately does not implement older-page loading, original-index actions or focus preservation and must not be shipped.

| 2,000-message destination; empty source | Warm readable | Cold readable | Entries bytes |
| --- | ---: | ---: | ---: |
| Full UI, 2,000 rows | 1,978.95 | 2,771.20 | 884,648 |
| Same data, final 40 displayed rows | 252.30 | 909.75 | 884,648 |
| All 2,000 rows, text-only message bodies | 606.00 | 1,198.75 | 884,648 |

Ten per cell; one suite, same instrumented build and fixtures, unpinned. These earlier endpoints use expected rows plus two frames and recorded tail geometry; the final phase budget adds the explicit text/occlusion predicate. They are not silently pooled together.

The full page has approximately **56,514 DOM elements**. `content-visibility:auto` avoids much offscreen layout/paint; it does not avoid React mounting, hooks, runtime subscriptions, tooltips/actions, cleanup or allocations. The slice comparison saves about **1.73 seconds warm without saving one history byte**. That directly demonstrates why tail-first display is useful even when entries transport is cheap.

Text-only rows preserve all 2,000 assistant-ui message runtimes but bypass the rich row tree. They remain much slower than 40 rich rows. This is not solely Markdown parsing. A separate ten-sample Markdown-only bypass, preserving message shells/actions, yielded **1,964 ms warm / 2,976 ms cold**: no convincing overall improvement over the full UI's noisy batches. Do not remove Markdown/highlighting based on this fixture.

### 2. The conversation being left can dominate

Warm, already-loaded four-message destination, ten switches each:

| Departing 2,000-message view | Click → four-message view | Browser load round trip | Host admission → worker reply |
| --- | ---: | ---: | ---: |
| Full mounted UI | **1,932.0** | **1,806.8** | **1.19** |
| Only 40 departing rows mounted | **152.7** | **63.85** | **0.94** |
| All departing rows text-only | **338.4** | **265.5** | **1.09** |

This supplementary switch endpoint is destination-row presence plus two frames, not the final strict phase-budget endpoint. Both directions use actual sidebar clicks. Do not infer the reverse numbers from a new-session or fresh-page benchmark.

The host is not spending 1.8 seconds in `session/load`: the renderer cannot promptly process its reply. The backend column ends at the worker reply, before the small final host bookkeeping/serialization; it is not a server-send timestamp. “Teardown” here includes runtime/context notification, subscription cleanup, React commit/deletion and GC, not just DOM node removal. Preserving the old transcript until the new tail is available prevents a blank interval, but eventually deleting an unbounded old tree can still block the UI. C needs D for that reason.

### 3. The extra snapshot costs more rendering, not just another megabyte

`Thread.EntriesRefresh` runs on initial mount because `path && !running`. The provider has already fetched and hydrated entries to finish `openSession`. The effect then fetches and hydrates the full tree again, replacing entries/blocks and invalidating consumers. Short/long captures show two replies immediately; on huge histories the second often reaches the renderer only after the first readable endpoint.

A dedicated alternating-order baseline/no-refresh experiment retained a two-second post-readable observation window. Ten samples each, no CPU sampling profiler:

| Metric | Baseline | Suppress initial refresh |
| --- | ---: | ---: |
| Click → strict readable endpoint | 2,368.25 ms | 2,080.65 ms |
| Entries replies through settlement | 2 | 1 |
| Total scripting, click through observation | 3,595.97 ms | 2,321.97 ms |
| Scripting after readable metric collection | 1,250.31 ms | 345.61 ms |
| Layout, entire observation | 34.42 ms | 34.30 ms |
| Style recalculation, entire observation | 35.18 ms | 34.63 ms |

The **1,274 ms scripting reduction is not 1,274 ms faster first paint**. It is evidence for the long unsettled period after the transcript appears. The paired order matters: an earlier block-ordered experiment had substantial drift and is retained as exploratory evidence only.

M16-T16 B **already addresses this** in `6cc8572`: its refresh effect requires the *same path* to transition from running to settled, rather than running on every mount. No competing fix is proposed here.

### CPU profile: supporting evidence, not another budget

One warm diagnostic capture, ~3.98 seconds including a one-second post-readable observation, source-mapped to this instrumented build:

| Exclusive sampled region | Sampled ms |
| --- | ---: |
| React render/commit/scheduler | 1,279 |
| assistant-ui runtime/primitives | 596 |
| GC | 345 |
| Radix | 221 |
| Laser message/selectors | 214 |
| Markdown ecosystem | 122 |
| Projection | 7.5 |
| Store | 4.9 |

Other JS/native work accounts for the remainder. CDP recorded **3,705 ms scripting**, only **38 ms layout / 35 ms style recalculation** in that diagnostic. The profile includes later duplicate hydration and profiler overhead; it must not be summed with or presented as medians from the phase table.

One secondary mount multiplier is repeated `systemDirection()` locale resolution (`theme/direction.ts`, **144 ms sampled self time** in that capture). This was not removed in an A/B experiment and is not promoted to a proven end-to-end cause. It is a later local cache candidate, not a reason to postpone bounded mounting.

## Direct answers

| Question | Finding |
| --- | --- |
| Is Pi's own file replay the wall? | **No.** Full 2,000-message manager opening is a few milliseconds. Cold process readiness is a much larger gate; resident load is roughly 1–2 ms on the backend. |
| Entries: bytes, parse or transport? | The response is ~885 KB; browser-observed round trip is around 10–12 ms and a passive decode probe around 1.5 ms. These overlap. The normal host cache already serves unchanged snapshots from memory. The fixed-40 experiment keeps every byte and removes most delay. |
| Is renderer cost projection? | No for these fixtures: full hydration ~3 ms and projection a few ms, versus seconds of row/runtime work. Ordinary empty/opened/full-snapshot projections are distinct; the later redundant full snapshot is avoidable. |
| Mounting, Markdown or highlighting? | Rich rows/runtime subscriptions, commit/cleanup and allocation dominate. Text-only and 40-row removals prove it. Markdown-only removal does not reproduce that gain. No fenced-code grammar/highlighter load occurs in these prose fixtures. |
| Fonts or images? | The measured shell already has loaded fonts before the session click; final probes record font state and resource timing. These histories have no transcript images. This does **not** answer image-heavy or code-heavy organic histories. |
| Same work twice? | One actual browser `session/load` despite multiple deduplicated provider entry calls; two full entries requests/hydrations on initial mounting. Pi also builds context twice and refreshes model services twice, but these smaller engine operations do not explain the seconds of rendering. |
| Synchronous host event-loop work? | Yes: containment/catalog lookups, cache stat checks, response serialization and project bookkeeping. No multi-second host stall appears here. The 1.93-second reverse switch reaches the host's worker-reply boundary in 1.19 ms. Synchronous JSONL reading/parsing discussed above happens in the worker, not the host. Large catalogs/log/image payloads remain different workloads. |
| Can a cold worker be warmed first? | **Yes, experimentally demonstrated through the existing worker-start route.** It is not a recommendation to start every project on hover. Trust, memory, retirement and lifecycle boundaries still apply. |

All 60 final phase samples record loaded fonts, zero transcript images, and no HTTP resource initiated after the click. WebSocket RPC traffic is captured separately; absence of HTTP resource entries does not mean absence of RPCs. The large gap between the first transcript-row commit and first actual text also shows why counting mounted wrappers alone overstates readiness.

The passive WebSocket observer performs an extra JSON decode to measure packet shape/bytes; its decode timing is a probe, not an exclusive measurement of the application's own parser. Similarly, browser round trips include main-thread scheduling: they are not server timings. No claim assigns the remaining few milliseconds of entries transport exclusively to disk, TCP or serialization without corresponding instrumentation.

## Ownership and next changes

The in-flight branch was inspected, not modified: `ae423a5` (A), then **`6cc8572` (B)** and the subsequent working diff. These are not part of the measured main baseline.

| Phase / change | M16-T16 classification | Next action / realistic gain |
| --- | --- | --- |
| Sidebar catalog selection/resolution | **Already addressed by stage A** on its branch | Keep its paging. Roughly 1 ms identity resolution here; not a transcript-wall fix. |
| Full entries payload and initial hydration | **Already addressed by stage B** | Keep anchored tail windows. Data-only saving here is milliseconds; the large gain is displaying fewer rows. |
| Initial second entries snapshot | **Already addressed by stage B** | Preserve its running→settled guard. Paired experiment removes ~1.27 s scripting across opening/settlement. |
| Previous transcript disappearing during resolution | **Planned there as stage C** | Preserve continuity in destination/runtime ownership. Avoid calling continuity alone a teardown optimization. |
| Mount/commit, later invalidation, unmount/GC proportional to loaded rows | **Planned there as stage D**; B bounds the initial case | Prioritize bounded mounted rows in `Thread.tsx` with stable runtime identities. About 1.7–1.8 s removed in the particular forward/reverse experiments; not a universal SLA. |
| Bounded speculative tail reads | **Planned there as stage E** | Can overlap history acquisition; does not eliminate worker readiness under the current contract. |
| Worker spawn/import/readiness before load | **NOT covered by M16-T16 — needs its own work** | `host/src/worker-pool.ts`, `worker-client.ts`, worker entry/import graph, and the project's explicit preparation path. Prewarming can move ~550 ms off a cold click, with resource/lifecycle costs. |
| Pi manager read/parse/context rebuild | **NOT covered by M16-T16** | No urgent rewrite justified: a few milliseconds. Paging the file alone cannot remove the renderer or process-start costs. |
| Model services / final refresh | **NOT covered by M16-T16; existing audit F19** | `worker/src/drivers/stable-sdk.ts` service factory and the pinned engine's services/model runtime. Investigate validated caching/refresh reuse, not blind skipping or shared mutable runtimes. Experimental ceiling tens of ms, not seconds. |
| Repeated locale resolution | **NOT covered directly; D reduces its callers** | `ui/src/theme/direction.ts` and direction consumers; measure a locale-keyed cache separately before promising a gain. |
| Fonts/images/highlighting | **Not established as a bottleneck here** | Do not delete features; test representative media/code histories separately. |

**Order:** finish B's integration, then C/D together with their existing owner; separately address cold-worker readiness if sub-second cold opens are required. E can improve predictability but is not a replacement for D. Treat model-service reuse and locale caching as secondary measured follow-ups, not a reason to broaden the paging task.

Laser can show a **cached or explicitly provisional read-only tail** before engine readiness, or prewarm an authorized project worker. Neither means Pi no longer needs to load its authoritative branch, settings, extensions, pending state and replay watermark before accepting work. A raw file tail cannot safely replace the live engine's in-memory leaf or race a running session. The current B route intentionally preserves that authority. Changing that admission boundary would require separate lifecycle/protocol work; no such design is implemented here.

## Evidence, validation and limits

Validation after discarding the experiment patches:

- `pnpm -F @lasercode/worker exec tsc -b --force` and the equivalent host command: pass; force regeneration prevents incremental TypeScript output retaining a generated-file probe.
- `pnpm -r build`: pass, `/tmp/session-open-forensics/final-build.log`.
- `pnpm identity:check` after staging the report: pass, `final-identity.log`.
- `pnpm test:browser-check`: **9 passed**, `browser-check-tests.log`; no harness source was changed.
- Final unmodified-source browser check: **20/20** strict readable/text/geometry samples, loaded fonts and zero transcript images; `hp/run-RP6Y8i/samples.json`.
- Full `pnpm verify` and packaged/native/mobile/theme acceptance were not run: no application change is being shipped, and this is not release certification.

Raw artifacts and throwaway probes are under **`/tmp/session-open-forensics/`**. `README.md` there maps accepted batches, exploratory/rejected runs, exact commands, source snapshots and cleanup. The handoff is `/tmp/session-open-forensics-report.md`.

The throwaway source patch, final instrumented generated build and source maps are retained outside the checkout; each run records build hashes. Earlier intermediate bundles were not all retained. No dependency package was edited: engine hooks transform modules only inside disposable worker processes. No credentials, personal sessions, installed service, native preferences or another worktree were changed. The app's ledger belongs to the coordinator and is untouched.

Limits: one hardware/OS/browser, one desktop theme/width, synthetic prose and warmed OS file caches; no packaged Electron, remote relay, first-install fonts, organic images/code, or input-latency certification. CPU sampling and paint opportunities are explicitly distinguished from phase medians and physical presentation. The test host/provider/browser are isolated, not filesystem/network sandboxed. Timing variation and rejected setup attempts are preserved, not relabeled as product behavior.

## Independent review of this investigation

`/tmp/review-forensics.md` — verdict **sound with caveats**. Every headline number
reproduces from the raw samples; "the engine is not the wall" is established. Three
corrections belong next to the findings:

1. **Findings 1 and 2 measured code that no longer exists.** The base is `7c8b8201`,
   before M16-T16 stage B. B already defaults to a 40-message tail and already fires
   the entries refresh once per settled turn, so finding 1 is B's design and finding 2
   is B's fix, both measured by hand beforehand. The post-B re-baseline on this machine:
   warm 2,000-message switch **176–206 ms at 40 mounted rows, 1,524 elements, no history
   reads**, and switching away from that conversation **94–117 ms** — against 1,979 ms
   forward and 1,932 ms reverse here. "Stages C and D remain essential" is extrapolation,
   not measurement: neither is justified by any number yet.
2. **Finding 2's readable-time claim is an overclaim.** The scripting delta holds
   (9 of 10 paired deltas positive); the readable delta flips sign in 5 of 10 pairs,
   so 2,368 → 2,081 ms is noise, not a result.
3. **The machine was under concurrent load**, undisclosed here: other lanes were
   building and benchmarking during these runs, and one finding-1 suite was
   block-ordered and unpinned with a negative sub-result (`norefresh` slower than
   baseline) that went unmentioned. The absolute 2.89 s / 4.06 s figures are upper
   bounds, not clean measurements.

What survives without qualification is finding 3: **worker readiness costs 562 ms**
(admission → ready 561.97 ms, history-independent at 562/559/547 ms, 75 % of a cold
short open), untouched by any stage of M16-T16. That is M16-T26.

## Implemented — worker readiness

M16-T26, branch `agents/session-readiness-9c8dce6f`, based on
`7942fb5bfd1451af175f92180fcd3a11936f18ca`. **With the readiness hint completed
before the click (signal → ready: 726.9 ms median), the cold short-session open
is 729 → 176 ms; worker admission on that click is 543 → 0.43 ms.** The process
still takes about 537 ms to prepare; that work now precedes the click.

### Admission and lifecycle

- Signals: actual remembered project at startup; explicit project selection;
  explicit sidebar group expansion, filter or jump. Each requires a known
  project with an unarchived session. A 150-ms trailing debounce coalesces
  rapid navigation. Default-expanded groups, catalog arrival and automatic
  first-project fallback do not count. **No hover warming**: a sidebar sweep
  is too weak an intent to justify a roughly 207-MiB process.
- **Trust is nonprompting.** Unknown/declined projects never warm. The host
  checks catalog/registry membership, directory presence and current trust
  immediately before spawn; it never calls the prompting resolver for a hint.
  `not_required` is allowed because there are no trust-gated local resources.
  Adoption rechecks trust; revoked speculation is stopped before ordinary
  click-backed admission. Archive visibility is client-local and checked by
  the frontend, not invented as host state.
- **One unused warm worker per host**, beyond workers already in use. New
  intent evicts the sole least-recently-wanted unused worker, awaiting its
  actual exit before another spawn. Hints during any spawn are dropped, not
  queued for later speculative bursts. Protected work prevents eviction.
- An unused warm process expires after **60 seconds since its last intent**,
  checked by the existing 30-second sweep: normally **60–90 seconds**, not
  the ordinary ten-minute idle period. Attachments, running sessions and live
  agent runs retain their retirement guards. Ordinary idle retirement still
  governs a worker once used.
- `get()` joins the same readiness **and priming** promise, rather than merely
  returning a live PID. Failed speculation is silent; a concurrent or later
  real open retries through normal admission after the failed process exits.
  No speculative session, fleet item, lifecycle notification, worker-list row,
  stderr log or model qualification is published. Namer qualification is
  deferred until actual adoption, not lost.

The method is `pi/worker/prepare`; it returns no user-facing state. There is
no guarantee of a fully warm worker when a click immediately follows the
signal: the click joins whatever readiness remains. Unknown trust and a busy
spawn lane deliberately retain the normal cold path.

### Reproduction and measurements

Shared `scripts/browser-check` target, built host and real worker, short
(4-message) and long (240-message) fixtures. **10 samples per cell**, medians;
80 accepted opens. Cold/warm order alternates within each run. Warm controls
have only the worker prestarted, not a loaded session. Prepared-cold samples
start with the destination worker stopped, expand its real sidebar group,
await that hint's completion, then click the real row. Each reload starts in
a different, empty source conversation; persisted selection cannot turn the
measurement into repeated clicks on an already-open row.

| Fixture / worker state at initial signal | Main before: admission → ready | Prepared branch: admission → ready at click | Main before: click → readable | Prepared branch: click → readable |
| --- | ---: | ---: | ---: | ---: |
| Short, cold | 543.01 ms | **0.43 ms** | 728.95 ms | **176.00 ms** |
| Long, cold | 543.47 ms | **0.42 ms** | 1,083.10 ms | **545.65 ms** |
| Short, already warm control | 0.03 ms | 0.03 ms | 174.85 ms | 173.65 ms |
| Long, already warm control | 0.03 ms | 0.04 ms | 505.05 ms | 482.80 ms |

**These end-to-end figures include the pre-B full-entries read/render.** B
independently removes that history cost. The two wins are additive but are
measured separately; this is not a post-B measurement or a combined estimate.
The admission result is history-independent, as the investigation predicted.

Preparing has a real cost, measured over the same 10 cold samples per fixture:

| Preparation cost | Short | Long |
| --- | ---: | ---: |
| Host prepare admission → primed process | 537.40 ms | 533.09 ms |
| Child CPU consumed at readiness | 720 ms | 710 ms |
| Whole-host CPU during the prepare window | 2.11 ms | 2.13 ms |
| Child RSS / kernel peak RSS at readiness | 207.08 MiB | 205.15 MiB |

Child CPU is Linux `/proc` user+system ticks (10-ms resolution); RSS is a
process snapshot, not an allocation profile. Host CPU includes any other
host activity during that window. The cost motivates **one**, not two, spare
processes and the shorter deadline. All four timing runs also registered a
never-opened project and verified **zero spawns** for it.

For the before measurements, sources were restored to exact main HEAD bytes
in this isolated worktree, built and measured, then only this worker's saved implementation
was restored and rebuilt. Both sides use the same disposable pool-promise
observer; generated outputs were not patched. Node 24.11.1, Linux Chrome,
CPU affinity 4–15, warmed OS file cache, synthetic prose. Other application
sessions may be active; no builds/tests from this worker ran concurrently
with timing. Readability requires expected text/row count, last-message
geometry above the composer, and two animation frames—paint opportunity,
not physical presentation. No packaged/native/remote performance claim.

Primary artifacts under `/tmp/sr/`:

- `sb/run-Hwl8rz`, `lb/run-b6UNDX`: unchanged-main short/long baseline.
- `sa/run-v9fO6U`, `la/run-wWecIP`: final implementation short/long.
- `summary.json`, `README.md`: aggregation, exact method, superseded runs and
  build/process evidence index. Every accepted run reports no owned survivors.
- `/tmp/session-readiness-bench.mjs`, `/tmp/session-readiness-observe.mjs`:
  reproducible shared-harness driver and passive host observer. Commands:
  `taskset -c 4-15 node /tmp/session-readiness-bench.mjs short before 10`
  (baseline build), then `short after 10`, and each with `long`.

### Validation and worker startup boundary

`pnpm -F @lasercode/host test`: **268 passed**; real-PID tests cover joining,
priming, failure/retry, eviction, expiry and live-run/attachment protection.
A real host/socket/worker test proves nonprompting trust admission, no unused
worker-list/status/session/model-call output, and PID reuse on actual open.
Router coverage and a protocol schema inventory sample pin the new method.
`pnpm -F @lasercode/ui test`: **1,412 passed, 1 existing skipped**; real-provider
tests cover remembered/selected projects, expansion, catalog-only negatives
and disposal. Pure tests cover archive/trust gates and intent coalescing.
`pnpm -F @lasercode/protocol test`: **126 passed**. Staged
`pnpm identity:check` and `pnpm -r build`: **passed**.

The worker's static `StableSdkDriver`/server import graph must load before it
can actually serve a session. Announcing `ready` before that import would
only hide the wait and put it back on the first request. This milestone moves
the entire existing import/validation sequence before the click, without
weakening the pinned-agent check or changing worker source. A separate desktop
shell-readiness milestone could revisit perf-analysis finding 7's **392-ms
bundled import / 419-ms daemon spawn→ready** gate; those are supplied earlier
measurements, not extra savings reproduced or claimed here. Worker tests,
full `pnpm verify` and packaged tests were not run: worker source is unchanged,
and this is not a release gate.

Final browser acceptance: `accept/run-6yFG3O` (pointer/keyboard) and
`accept/run-xL0R2W` (touch), through `/tmp/session-readiness-acceptance.mjs`:
1360/390 × dark/light, real group expansion and row opening, hidden unused
worker, readable 240-message destination, no horizontal page overflow, and
reduced-motion captures. Both matrices pass and have no owned survivors.
Screenshots were visually inspected; no presentation changes were introduced.

`unused/run-jqmEqB` adds the stronger negative and lifetime proof: a registered
project **with saved history** was left unclicked in the default-expanded
sidebar. Ten pointer hover/rest cycles produced **zero spawns**. Explicit
expansion then prepared exactly one worker, which was never opened and exited
at **83.99 seconds** under the production 30-second sweep. Its first three
idle seconds consumed 30 ms additional child CPU (one sample, not a median).
`unused-proof.json` and the complete spawn trace retain that evidence; the
shared-harness script is `/tmp/session-readiness-unused.mjs`. Cleanup reports
no owned survivors.

### Review corrections

Speculative admission now refuses session-owned, attached, retrying or crashed
entries, including a recheck after asynchronous eviction. The regression
crashes an attached real worker, issues a readiness hint, and proves the
original retry still reloads its saved session and publishes recovery.
`cwds()` excludes speculation; a global feature change silently retires unused
prepared processes rather than promoting them or retaining stale startup
configuration. Live-run and attachment guards also protect that invalidation.
The provider's readiness effect and refs now live in `useWorkerReadiness`;
archive/catalog visibility stays in the UI, while the host alone owns trust
admission. N2/N3 were deliberately left unchanged.

Revised validation: host **270 passed**; UI **1,412 passed, 1 existing skipped**;
workspace build and identity check passed. The timing table remains the
measurement of `00da6ba`, independently reproduced during review; it was not
re-benchmarked for these recovery/inventory fixes. Its headline now carries
the measured **726.9-ms signal-to-ready** condition explicitly. Keyboard/pointer
and touch browser matrices also pass on the revised build at
`accept/run-G3f2CI` and `accept/run-o60mcD` (both widths/themes, reduced motion,
no owned process survivors).
