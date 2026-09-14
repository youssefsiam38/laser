# Resource containment and instant conversation plan

Status: implementation authorized and active as M18.

Architecture task: MX-T9. Implementation tasks: M18-T1..T15. Decisions: D-255, D-256, D-257.

## Progress

Authoritative detail, evidence and ownership live in `STATUS_DETAILED.md`; `STATUS.md` is the current one-screen view. This table mirrors only the dependency state so this implementation source never reads as finished while runtime work remains.

| Slice | Task | State | Dependency |
| --- | --- | --- | --- |
| RP-1 | M18-T1 | done | `1628349`; build, protocol 153, host 403, desktop 160 |
| RP-2 initial | M18-T2 | done — reviewed harness and sanitized finding integrated through `ad8c188`; full A refuses B at unchanged renderer ceiling with zero survivors | RP-1 |
| RP-2 repeat | M18-T15 | todo — unchanged two-run baseline after containment | RP-4..RP-8 |
| RP-3 | M18-T3 | reviewed UI checkpoint integrated; T4-T7 counters/browser gate pending | RP-1 |
| RP-4 | M18-T4 | todo | RP-2 |
| RP-5 | M18-T5 | todo | RP-2 |
| RP-6 | M18-T6 | todo | RP-2 |
| RP-7 | M18-T7 | todo | RP-2 |
| RP-8 | M18-T8 | todo | RP-4, RP-5 |
| RP-9 | M18-T9 | done — integrated `dd637f3` | protocol integration follows RP-1 |
| RP-10 | M18-T10 | todo | RP-5, RP-9 |
| RP-11 | M18-T11 | todo | RP-10 |
| RP-12 | M18-T12 | done — integrated `e9e3d8d` | RP-9 |
| RP-13 | M18-T13 | in progress — host boundary integrated `00db89f`; client/storage isolation active | RP-12 |
| RP-14 | M18-T14 | todo | RP-1..RP-13, M18-T15 |

## Outcome

Laser remains an API-based, single-engine product with an Electron shell. The work below must:

1. attribute real memory to the process, project, session, agent run or command that owns it;
2. bound dormant state without interrupting live work;
3. make a previously seen conversation paint from a bounded device cache immediately, then reconcile it with its authoritative host;
4. use the same read and action contract for local, self-hosted, cloud and enterprise environments;
5. reconsider the desktop shell only after the retained state outside that shell is measured and contained.

A first-ever uncached conversation cannot load in zero milliseconds. The target is near-zero perceived re-entry and a short, worker-free authoritative cold read.

## Decisions and non-goals

- **Local-first reads, host-first actions.** A cached transcript may paint before a connection is ready. Send, approvals, tools, navigation mutations and process controls wait for the authoritative host.
- **Electron stays.** A Tauri or native-WebView migration is not part of this plan. It has a measurement gate at the end.
- **No external-agent controller.** Do not add provider drivers, discover third-party coding-agent CLIs, import their transcripts or infer Laser agents from their tool output.
- **No direct client JSONL access.** The host or live worker owns every authoritative read.
- **No second transcript authority.** A projection or cache accelerates reads; Pi's session record remains canonical.
- **No relay plaintext.** The relay remains an encrypted byte forwarder and never stores conversation snapshots.
- **No silent work termination.** Memory pressure may evict dormant views, replay suffixes and idle runtimes. It may not cancel a turn, question, agent run or command.
- **No dishonest metric.** Never present summed RSS or virtual address space as physical memory used.

## Evidence baseline

The investigation did not reproduce a 20 GiB resident footprint. On the inspected Linux machine, one window, two projects and one streaming agent measured approximately:

| Owner | PSS |
| --- | ---: |
| Renderer | 781 MiB |
| Main project worker | 399 MiB |
| Host | 165 MiB |
| Second project worker | 165 MiB |
| Electron GPU | 69 MiB |
| Electron main | 54 MiB |
| Utilities, zygotes and three small Beam/Chat workers | 31 MiB |
| **Total** | **1,664 MiB** |

Summed RSS was about 2.1 GiB, 26% higher because shared mappings were counted repeatedly. Virtual address reservations were much larger and are not evidence of resident RAM.

During a 90-second streaming sample without forced collection, renderer PSS moved from about 828 to 886 MiB and host PSS from about 174 to 204 MiB. The slope needs a controlled reproduction.

Existing conversation measurements:

- warm `session/load`: roughly 1–20 ms;
- opening a 2,000-message Pi file: roughly 4.5 ms;
- cold worker startup: roughly 543–562 ms;
- a 2,000-message transcript with a recent 40-row window: roughly 193 ms to usable UI in the measured build.

The strongest code-level retainers are:

- worker `sessions` entries survive client detach and retain a full runtime/transcript;
- renderer `state.open` retains every hydrated session visited;
- completed background-task records have no deletion path;
- complete provider requests cross a single-line decoder on every model call;
- transcript delivery's loaded-path set does not shrink;
- Beam/Chat workspace identity can multiply workers;
- replay is bounded per session but not globally per worker;
- host, workers and renderer have no explicit memory-pressure policy.

Relevant evidence:

- `packages/worker/src/server.ts`
- `packages/ui/src/store.ts`
- `packages/ui/src/runtime/LaserProvider.tsx`
- `packages/pi-extension/src/modules/background-work.ts`
- `packages/pi-extension/src/modules/provider-log.ts`
- `packages/protocol/src/jsonrpc.ts`
- `packages/host/src/transcript-delivery.ts`
- `packages/host/src/worker-pool.ts`
- `docs/session-open-forensics.md`
- `docs/perf-chat-loading.md`
- `docs/performance-wide-audit.md`

## Dependency order

```text
RP-1 process identity and accounting
  ├─ RP-2 controlled reproduction
  │    ├─ RP-4 worker session lifetime
  │    ├─ RP-5 renderer view lifetime
  │    ├─ RP-6 task and delivery lifetime
  │    └─ RP-7 provider-log and backpressure
  └─ RP-3 Advanced resource diagnostics

RP-4 + RP-5
  └─ RP-8 memory-pressure policy and safety ceilings

RP-4..RP-8
  └─ RP-2 post-containment repeat baseline (M18-T15)

RP-5 + RP-9 durable session revision
  └─ RP-10 bounded device tail cache
       └─ RP-11 immediate paint and reconciliation

RP-9
  └─ RP-12 worker-free authoritative reads
       └─ RP-13 deployment and enterprise policy

RP-1..RP-13 + RP-2 repeat baseline
  └─ RP-14 Electron/Tauri decision gate
```

## RP-1 · Process identity and correct accounting

### Build

Add a host-owned process inventory whose stable identity is `(pid, startTime)`, never PID alone. Derive roles structurally from known roots and spawn records:

- desktop main, renderer, GPU and utility;
- host;
- project worker and project root;
- agent run and session;
- background command;
- MCP or internal helper;
- unknown descendant.

Record platform-appropriate measurements:

- Linux: PSS from `smaps_rollup`, RSS and high-water mark;
- macOS: physical footprint/private resident memory;
- Windows: private working set and commit;
- all platforms: CPU, elapsed time and available I/O counters.

Do not persist argv, environment variables, provider payloads or unredacted paths. A display label may use already-known project/session/run metadata and a sanitized executable basename.

Collection is demand-driven. Retained history has independent limits for age, snapshot count, process-row count and bytes. Initial bounds should follow the proven T3 Code shape: 60 minutes, 3,600 snapshots, 20,000 process rows and 64 MiB, with field-length bounds.

### Done when

- PID reuse cannot attach measurements or controls to a new process.
- Linux totals reconcile with `smaps_rollup`; Electron rows cross-check against `app.getAppMetrics()`.
- Unsupported metrics are labelled unavailable, never reported as zero.
- Collector failure does not affect the host or active work.
- A fixture with hostile command arguments proves no secret-bearing argv reaches storage or UI.

## RP-2 · Controlled reproduction and heap attribution

### Build

Extend the existing browser profiler and add a scratch-host soak. Use synthetic transcripts and credentials-free providers only.

Scenarios:

1. clean start and idle baseline;
2. open 50 distinct sessions, not repeated switching between two;
3. page backwards through several long transcripts;
4. stream large reasoning, Markdown, tool output and images;
5. start 10 children and execute 200 foreground/background Bash calls;
6. keep multiple projects and Beam/Chat conversations active;
7. hide and restore the desktop window;
8. leave a slow browser or paired-device consumer connected;
9. detach every dormant session and wait through worker retirement.

Capture:

- process PSS/private memory, RSS, peak and CPU;
- renderer JS heap, DOM count and decoded-image ownership;
- count and retained size under `state.open`;
- worker session count, transcript entries and replay bytes;
- task-record count and retained tails;
- host delivery queue and loaded-path counts;
- allocation rate while provider requests are recorded.

Take renderer and Node heap snapshots only against the scratch environment. Inspector ports and snapshots can contain conversation data and must never be enabled on the person's live host.

### Done when

- the report separates retained heap, native/external memory, shared pages and temporary allocation peaks;
- each scenario records pre-GC peak and post-GC slope;
- the top retainers have concrete owner paths;
- a repeat run produces the same ranking;
- no claim relies on extrapolating virtual address space or summed RSS.

## RP-3 · Advanced resource diagnostics

### Build

Add a permanent Advanced diagnostics surface backed by RP-1. This is process truth, not another fleet.

Show:

- total current and peak private memory;
- a tree grouped by Laser role and work owner;
- current CPU and elapsed time;
- worker/session/replay/task/cache counts and bytes;
- collection health, last sample and unavailable metrics;
- bounded history with a clear retention explanation;
- redacted diagnostic export.

Known work must link to its existing session, run or background-task surface. Stop actions route through `stop_agent`, `task_stop` or the owning lifecycle API. A raw signal is reserved for a proven orphan/diagnostic child, re-sampled immediately before acting, with a refusal when identity or ownership changed.

### Done when

- users can explain the application's memory total without opening a terminal;
- renderer, host and worker totals are visibly distinct;
- controls cannot signal Electron, the host, an unrelated PID or active work through a bypass;
- desktop and phone show useful summaries, while detailed process control remains local-only;
- UI implementation follows the assistant-ui element inventory and browser matrix requirements.

## RP-4 · Bound worker session lifetime

### Build

Teach the host and worker the difference between client detach and safe runtime unload. Do not overload session move/delete semantics.

Maintain explicit attachment ownership. An LRU policy may dispose a worker session only when all are true:

- no client or Beam scope holds it;
- it is not streaming or compacting;
- no question or approval is pending;
- no agent run owns it;
- no foreground or background task owns it;
- no queued steering/follow-up work exists;
- its canonical session data is durably closed.

Add a global replay budget per worker in addition to the existing per-session count/byte limits. Evicting a replay suffix must advance an epoch or floor so reconnecting clients request a snapshot instead of silently missing updates.

Prefer unloading idle sessions before retiring an entire worker. Beam/Chat workers may receive a shorter idle-retirement policy; pooling their workspaces requires a separate correctness decision.

### Done when

- opening and leaving many sessions reaches a stable worker heap after collection;
- active work, questions and queued messages prevent unload;
- reopening an unloaded session restores the same branch, state and pending durable records;
- replay eviction causes an explicit snapshot resync;
- a live child keeps only the runtimes it needs, not every child opened earlier.

## RP-5 · Bound renderer session lifetime

### Build

Split durable/light session UI state from hydrated transcript state. Keep for dormant sessions:

- identity and environment;
- draft and attachments;
- scroll anchor or latest-following intent;
- last validated revision/sequence;
- pending attention summary;
- user disclosure preferences.

Evict raw entries, derived blocks, decoded images, search ranges and assistant-ui message projections for views outside a byte- and count-bounded LRU. Current, visible Beam, waiting and actively running sessions are pinned. Serialized-byte estimates must be calibrated against retained heap; serialized size alone is not the budget.

Re-entry uses RP-10's local tail and then reconciles. Eviction must not delete canonical history or drafts.

### Done when

- 50 distinct session visits converge to a bounded post-GC renderer heap;
- inactive image conversations release decoded image memory;
- current/Beam/waiting views are never evicted;
- drafts, focus intent, scroll restoration and approvals survive dehydrate/rehydrate;
- conversation find loads older pages explicitly rather than pinning every visited transcript.

## RP-6 · Bound task and transcript-delivery lifetime

### Build

For completed commands, retain compact durable metadata while releasing in-memory process handles and tail buffers after terminal delivery. `task_output` continues to read the durable bounded log for retained tasks. Apply independent count, age and byte limits; live tasks are exempt.

Make host transcript delivery membership reference-counted by connection and scope. `pi/session/detach` removes a path when its last owner leaves. Reopening adds it again and reconciles from sequence/revision.

### Done when

- 200 completed Bash calls do not leave 200 full tail buffers resident;
- recent `task_output` remains available from durable storage;
- live tasks are never compacted;
- a client receives updates only for paths it currently owns;
- detach/reopen races cannot lose a terminal update or question.

## RP-7 · Bound provider logging and transport pressure

### Build

Replace quadratic `buffer += chunk` decoding with a chunked, cursor-based decoder and enforce maximum frame sizes before concatenation.

Keep request transparency without retaining repeated complete payloads in long-lived heaps:

- small captures may use the normal structured path;
- large captures use a bounded chunked ingestion path;
- redaction happens before durable user-visible storage;
- the latest retained full bodies obey the existing log-store budget;
- released or truncated bodies are labelled with original size, digest and reason;
- no UI or transport subscriber receives a full body unless it explicitly requests it.

Add byte-accounted high-water marks to host/client/relay/background-output queues. At the boundary, pause the producer where supported or drop only a documented replayable diagnostic stream. Never drop protocol state, questions or terminal events.

### Done when

- a 16 MiB synthetic request has linear decoder behavior and bounded peak memory;
- streaming large contexts no longer grows the host heap continuously after GC;
- retained recent request evidence remains inspectable and correctly redacted;
- slow consumers cannot build unbounded queues;
- every dropped/released diagnostic body is visible as such.

## RP-8 · Memory-pressure policy and safety ceilings

### Build

After RP-2 and the lifetime fixes establish normal peaks, define warning and critical pressure thresholds per process role.

Pressure response order:

1. clear ephemeral calculation and decoded-image caches;
2. evict dormant renderer views;
3. release old replay suffixes;
4. compact completed task records;
5. unload safe idle worker sessions;
6. retire safe idle workers;
7. refuse additional heavy hydration with an actionable message.

Only then add conservative V8 heap ceilings to host and worker spawns. A ceiling is a final blast-radius guard, not a memory fix: exceeding it can terminate a process. Worker-loss recovery and person-facing attribution must therefore be proven first.

### Done when

- pressure never cancels active work;
- the user sees what was released and why when an operation is refused;
- synthetic runaway allocation cannot consume all machine memory;
- normal largest-history and multi-agent fixtures stay below warning thresholds;
- a worker failure remains attributed to the harness, never to the person.

## RP-9 · Durable session revision contract

### Build

Add an opaque host-authoritative revision for the renderable session view. It must:

- be bound to environment and session identity;
- change when visible canonical history, active branch/leaf or required display metadata changes;
- remain equal across host/worker restart when canonical content is unchanged;
- never let an earlier branch validate a later cached view;
- support `baseRevision` validation for deltas;
- be available without opening a worker when no live worker owns newer state.

Do not expose file paths, mtimes or JSONL implementation details as the public contract.

### Done when

- unchanged content validates across reconnect and restart;
- append, edit/fork/jump, compaction and deletion invalidate the prior revision;
- stale deltas are refused rather than merged;
- schema round-trip and router inventory tests cover the new fields/methods.

## RP-10 · Bounded device tail cache

### Build

Persist only the recent renderable tail and lightweight UI state needed for immediate paint. Key it by environment, session, revision and branch identity. Bound it globally and per session by count, bytes and age.

Storage policy:

- desktop: encrypt transcript snapshots through an OS-backed desktop bridge where available; report degraded storage honestly;
- browser/PWA: use origin storage only with explicit retention policy and clear controls; never claim browser storage is independently encrypted;
- remote enterprise environments: host policy can disable content caching, set retention/size limits or require managed-device storage;
- relay: no cache and no plaintext.

Cache writes are atomic. Corrupt, partial, incompatible or oversized entries are discarded safely. Attachments use bounded references/thumbnails rather than duplicating full base64 bodies across every snapshot.

### Done when

- a previously seen conversation can paint before the socket connects;
- cache corruption cannot block authoritative loading;
- clearing a session/environment removes its cached content;
- global eviction preserves current drafts and follows an explicit LRU;
- no cache key permits content from one environment/account to appear in another.

## RP-11 · Immediate paint and authoritative reconciliation

### Build

Navigation sequence:

1. acknowledge the selected row immediately;
2. synchronously select the best valid cached tail;
3. paint it as provisional, without a misleading loading state;
4. connect to the authoritative host and send revision/base sequence;
5. apply a delta when the base matches;
6. atomically replace when it does not;
7. enable actions only after the host confirms authority.

A cached view must not look like a confirmed live connection. Use a subtle existing connection/restoration state, not a warning banner. Draft input remains editable while actions are fenced.

### Done when

- cached re-entry paints within one animation frame in the profiling fixture;
- no cached state can send, approve, stop or mutate before host validation;
- mismatch replacement preserves draft, focus and reading intent;
- slow/offline hosts leave a truthful readable snapshot with clear retry;
- no empty-new-session frame appears during session navigation.

## RP-12 · Worker-free authoritative reads

### Build

Add one host read path that returns the same bounded snapshot shape regardless of environment:

- if a live worker owns newer state, route to it;
- otherwise read through a host parser/projection without spawning a worker;
- serve recent tail first and older pages by opaque cursor;
- validate every result against RP-9's revision;
- preserve the one-writer invariant.

A host projection may index session location, revision, branch metadata and bounded display rows. It is not a second writable transcript or event source.

### Done when

- opening an inactive cold session performs no worker spawn before the first authoritative screenful;
- a live worker always wins over a stale disk projection;
- local, self-hosted and cloud hosts return the same protocol shape;
- paging and search destinations agree with the canonical entry identity;
- reading never mutates a session file.

## RP-13 · Remote, cloud and enterprise policy

### Build

Use one environment descriptor to declare:

- protocol and snapshot capabilities;
- revision/delta support;
- cache policy and retention limits;
- allowed RPC scopes;
- local-only operations;
- diagnostics availability.

Adopt a per-method authorization table at the host boundary. Pairing may narrow but never widen grants. Enterprise policy is enforced by the authoritative environment and repeated to clients; a client preference cannot override it.

Deployment rules:

- local desktop/browser: host owns canonical sessions and actions;
- self-hosted: identical host contract over the E2EE connection;
- Laser Cloud Agents: each hosted environment owns its workspace, credentials and sessions;
- enterprise-managed host: organization policy owns grants, audit and cache eligibility;
- relay: sees channel identifiers and encrypted bytes only.

### Done when

- a downgraded environment invalidates unsupported cached capabilities;
- unauthorized methods fail before worker creation or side effects;
- a device cache disabled by policy cannot retain new transcript content;
- environment switching cannot leak snapshots, drafts or diagnostics;
- an audit record names the authenticated actor and method without conversation content.

## Supporting recovery and update work

These are transferable lessons from T3 Code and DSH Desktop, but remain separate implementation tasks after resource containment:

- a spawned host/worker announces a per-launch identity; an open port is not readiness;
- immutable feature/runtime generations are staged and atomically selected;
- a failed launch never rewrites the person's desired feature configuration;
- first-party safe mode starts a minimal feature set against the same intact data;
- child/module failures report structured ownership before heuristic log parsing;
- repeated repair has a bounded ledger and then asks the person;
- update readiness means migrations complete and long-running roots are parked at an activation gate;
- update results carry an ID across reconnect and cannot be inferred from reconnection alone;
- state migrations have an explicit snapshot/restore boundary and interrupted-restore marker.

Laser's existing reviewed-SHA, digest, provenance and public-release verification remains authoritative. These additions strengthen runtime activation; they do not replace release verification.

## RP-14 · Electron/Tauri decision gate

Do not begin a migration as part of the memory work.

After RP-1 through RP-13:

1. compare the packaged Electron app with the existing headless host plus PWA to isolate shell cost without rewriting anything;
2. if the shell still dominates remaining idle/private memory, build a disposable Tauri spike that launches the unchanged stock-Node host;
3. run the same UI bundle and fixtures on Electron, WebView2, WKWebView and WebKitGTK;
4. compare private memory, startup, idle CPU/battery, streaming, long-history navigation, hidden-window behavior and package size;
5. verify tray, notifications, keychain, updater, deep links, dictation, file opening, accessibility, Wayland and reduced motion;
6. set the required memory/footprint benefit before reviewing results.

Migration is accepted only if the predeclared benefit is met on supported platforms with no regression in security, visual consistency, accessibility, browser acceptance or host/worker lifecycle. The host and worker remain Node sidecars; porting the engine runtime to Rust is explicitly out of scope.

## Cross-cutting acceptance gates

Every implementation slice must include:

- focused unit tests and protocol inventory coverage where applicable;
- scratch-host integration tests for lifecycle and race behavior;
- before/after PSS or private-footprint evidence;
- heap evidence for a retention claim;
- bounded failure and corrupted-cache cases;
- no credentials, personal transcripts or live-host inspectors in artifacts;
- desktop and phone browser review in both themes for UI changes;
- pointer, keyboard, touch and reduced-motion checks for interaction changes;
- a `prefers-reduced-motion` equivalent for every transition;
- no active agent, question, approval or command terminated by eviction;
- current release identity and process-generation handshake preserved.

## Reference-project lessons

### Adopt from T3 Code

- demand-driven, multi-dimensional process telemetry;
- `(pid, startTime)` identity and re-sampling before control;
- count-plus-byte stream and history budgets;
- authenticated per-method RPC scopes;
- capability negotiation through environment descriptors;
- trial/commit/rollback updates with correlated outcomes;
- native helpers isolated behind versioned line protocols.

### Adopt from DSH Desktop

- announced launch identity rather than port-only readiness;
- immutable generations and atomic desired-state pointers;
- non-destructive first-party safe mode;
- structured failure provenance with bounded repair escalation;
- consent-per-report diagnostics;
- user-controlled downgrade and failed-migration recovery.

### Reject from both directions

- universal provider-driver orchestration;
- third-party CLI/session discovery;
- preload DOM injection as the product surface;
- package-market installation as a normal feature flow;
- presentation or fleet structure inferred from external tool calls;
- replacing Laser's blind relay with a trusted plaintext broker.

Reference analyses were performed against:

- `pingdotgg/t3code` at `6f00d3881a197dd33c2cb43c6a11a9e759e56089`;
- `dataelement/dsh-desktop` at `4115a96acc8eb3818fd3a75fa67fe53e4484c90a`;
- Laser primarily at `bc78bd79f32a704e75d1671e681bf6783832056f`.
