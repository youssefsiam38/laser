# Browser check

A small, local browser-acceptance engine for **any web app**. No Docker, framework,
product API or fixture format is built into the engine. Node 24+, Linux and Chrome
are required. All captures, logs and browser state stay outside your checkout.

## Your project first

Point at an existing disposable server (the harness does **not** stop this server):

```sh
node scripts/browser-check/run.mjs --url http://127.0.0.1:3000 --script ./check.mjs
```

For an owned server and a theme matrix, write a target module. Its only contract is
an async `target(runtime)` returning a URL. App-specific theme persistence and
fixtures are explicit adapters, not assumptions about a particular stack:

```js
// target.mjs
export async function target(runtime) {
  const port = await runtime.freePort();
  runtime.spawn('/usr/bin/python3', ['-m', 'http.server', String(port), '--bind', '127.0.0.1'], {
    cwd: '/absolute/path/to/my/site', name: 'app',
  });
  return {
    url: `http://127.0.0.1:${port}`,
    // Adapt this to your app's real preference. Do not patch CSS just for a shot.
    async theme(check, value) {
      await check.page.evaluate(value => localStorage.setItem('appearance', value), value);
      await check.page.reload({ waitUntil: 'domcontentloaded' });
    },
    backgroundSelector: 'body',
  };
}
// Optional: seed through your real application interface and return fixture data.
export async function fixture(target, runtime, name) {
  return { name };
}
```

```js
// check.mjs — also receives page/context for normal Playwright actions
export default async check => {
  await check.waitFor({ selector: 'main' });
  await check.page.getByRole('button', { name: 'Menu' }).click();
  await check.shot('menu');
};
```

```sh
node scripts/browser-check/run.mjs --target ./target.mjs --script ./check.mjs --matrix
# Same four cases with touch enabled (real touchscreen/tap capability):
node scripts/browser-check/run.mjs --target ./target.mjs --script ./check.mjs --matrix --touch
```

Use `runtime.spawn(command, args, {cwd, name, env})` for **every** server/provider
process. It assigns an owned process group, logs stdout/stderr, and includes
children in cleanup. Never detach a child into another process group or daemonize
it. `runtime.env` is an allowlisted isolated environment; `env` overrides must
contain only explicit disposable values. PATH always includes the current Node's
bin directory and `/usr/bin:/bin`. HOME, TMPDIR and XDG roots are private. Inherited
API keys, tokens, PI variables, product paths, shell hooks, proxies and SSH agents
are absent. This is environment isolation, **not a filesystem/network sandbox**.
Your target and script are trusted code; do not point them at personal data.

`target` may also return `ready(check)`, `preparePage(check, fixture)`, `rpc(method,
params)`, and `build` evidence. An exported `checkout` identifies the directory in
which artifacts are forbidden (default: invocation working directory). Existing
URL mode has no stored-preference adapter, so it deliberately refuses `--matrix`.

## Importable API

```js
import { browserCheck } from './scripts/browser-check/index.mjs';
import { target, fixture } from './target.mjs';
await browserCheck({ target, fixture, fixtureName: 'short', matrix: true }, async check => {
  await check.shot('page');
}); // teardown also runs if the callback throws
```

| API | Behavior |
| --- | --- |
| `open(path)` | Resolve against target URL, navigate, await target readiness. |
| `viewport(1360 \| 390 \| {width, height})` | Desktop height 900, phone height 844; preserves page/context. |
| `theme('dark' \| 'light')` | CDP media emulation **and** target's own stored preference; wait for opaque computed background matching brightness (<128 dark, ≥128 light). Override `backgroundSelector` for transparent bodies. |
| `touch(boolean)` | CDP touch capability; context supports Playwright `tap()`. |
| `reducedMotion(boolean)` | CDP `prefers-reduced-motion`, independently of theme. |
| `shot(name)` | Viewport PNG; safe filename only. |
| `snapshot()` | Accessibility snapshot, also saved as YAML. |
| `rpc(method, params)` | Target adapter's real RPC; refused when unavailable. |
| `waitFor('text' \| {selector})` | Visible text or selector, bounded with location in errors. |
| `metrics()` | DOM node count, long-task timings, `window.__renderCounts` when exposed. |
| `page`, `context` | Playwright; 30-second action/navigation defaults. No forced clicks. |
| `cdp`, `browserCdp` | Target and browser CDP sessions for bounded diagnostics; never attach to an existing browser. |
| `fixture`, `root`, `state` | Fixture result, artifact directory, applied device/theme state. |

`--timeout 30000` controls readiness and browser actions; fixture adapters bound
their own settlement waits. Arbitrary script code is responsible for its own
loops/promises. SIGINT/SIGTERM still tear down the owned processes. SIGKILL or a
machine crash cannot run cleanup. Ports are chosen by binding port 0, then released
for startup; another process racing to take one results in a bounded startup error.

## Artifacts and repeatability

Default: `/tmp/browser-check/run-<unique>/`. Use `--artifacts /outside/the/checkout`.
The engine refuses checkout-contained and symlink-aliased output directories.
Screenshots, `contact-sheet.png`, snapshots, `logs/`, `evidence.json`, Chrome profile,
HOME and application data all live there. No browser MCP tool is used; the Playwright
output directory is also set outside the checkout. No `.playwright-mcp/` is created.

`--matrix` runs 1360/390 × dark/light. Shots are `<name>-<width>-<theme>.png`
(`-touch` added for touch runs). Evidence includes computed backgrounds, metrics,
process records, survivors and target build evidence. Cleanup first requests normal
termination, then kills unresponsive groups; the final check prints
`Processes left running: none` or survivor PIDs. Retained artifacts are never deleted
automatically. Remove the printed run directory when review is finished.

Playwright resolution: explicit `--playwright /path/to/playwright/index.mjs`, then
project module resolution, then sorted existing `$npm_config_cache/_npx` (default
`~/.npm/_npx`) installations. No automatic install and no machine-specific home path.
Chrome resolution: `--chrome`, system Chrome/Chromium, then Playwright's bundled
executable. Install/provision dependencies separately if the clear resolution error
appears. Browser profiles never attach to an existing debugging port or browser.

## Built-in example: Laser

The adapter in `targets/app.mjs` starts this checkout's **built foreground CLI
host**, reuses the repository's real-engine stub provider and review-environment
artifact-tree hashing, and seeds sessions through real host RPCs. No engine imports
or product configuration live in the generic core.

```sh
pnpm -r build
node scripts/browser-check/run.mjs --target scripts/browser-check/targets/app.mjs --fixture long --matrix
# Regression proof including exact persisted message count and pointer/keyboard:
node scripts/browser-check/run.mjs --target scripts/browser-check/targets/app.mjs --fixture long --matrix --script scripts/browser-check/test/acceptance.mjs
# Advanced → Resources (RP-3) and the environment-scoped device store (RP-13 B):
node scripts/browser-check/run.mjs --target scripts/browser-check/targets/app.mjs --fixture long --matrix --script scripts/browser-check/test/resource-diagnostics.mjs
node scripts/browser-check/run.mjs --target scripts/browser-check/targets/app.mjs --fixture long --matrix --script scripts/browser-check/test/environment-storage.mjs
```

Two things those last two scripts rely on, so a later script does not rediscover
them: nothing pings the host on a timer, so a network drop is only *found* once
the app sends something (the diagnostics poll, or any surface that requests);
and headless Chrome here has no browser window, so `document.visibilityState`
cannot be driven to `hidden` — the hidden-document poll guard stays a unit test.
Both scripts seed their own hostile state through the page rather than through a
shipped seam, and clean it up before the next matrix case opens the app.

| Fixture | Data |
| --- | --- |
| `empty` | One disposable project, no sessions. |
| `short` | One session, 4 messages. |
| `long` | One session, 240 messages. |
| `huge` | One session, 2,000 messages; real RPC turns, so slower than copying files. |
| `tools` | Reasoning, a real shell tool, a completed goal. |
| `agents` | Parent with a provider-failed child and a child paused on an MCP approval. |
| `projects` | 10 disposable projects × 15 sessions, 4 messages per session. |
| `mcp` | Repository's offline stdio MCP fixture, registered and inspected through the host. |

Every case lands on the fixture's session through the app's own notification
deep link (`#/session/<path>`), consumed after the environment handshake by the
app's own startup path, and the target then waits until the app's recorded
destination names that session. The harness never writes a device-storage key:
unscoped pre-environment keys are purged before anything reads them (RP-13 B).

Content is deterministic; runtime IDs/timestamps are real. The adapter gives the
stub a large context window and disables automatic compaction so long/huge message
counts remain exact. Theme follows system through `pi/prefs/set` using the app's
own stored theme state, then computed background is verified. Session/project
selection uses the app's storage keys. No direct writes to live session JSONL.

Deliberate exclusions: no real credentials or paid provider calls, no packaged
Electron/native acceptance, no person's browser/profile/agent directory, no
replacement for Docker's stronger isolation or the packaged clean-machine gate.
Every feature still needs its own interaction assertions; four screenshots alone
do not prove keyboard, cancellation, scrolling or approval behavior.

## Controlled resource soak

`resource-soak.mjs` is the credential-free Linux RP-2 harness. It uses synthetic
transcripts, a loopback provider, scratch agent/session/state roots, owned
inspectors, `/proc` PSS/private-resident counters and bounded heap snapshots.
It never attaches to an existing host/browser. PSS means proportional physical
pages; private resident is separate. RSS rows overlap shared mappings and are
never summed.

```sh
pnpm -r build
node scripts/browser-check/resource-soak.mjs --quick --runs 1 --artifacts /tmp/resource-quick
node scripts/browser-check/resource-soak.mjs --full --runs 2 --electron --artifacts /tmp/resource-full
```

Its nine scenarios live one to a file under `resource/scenarios/`, behind one
contract: a scenario returns the phase sample that evidences it, and the runner
marks it complete only when that sample is in the report, so "complete" always
means measured. Every quick/full constant — workload, pacing, sampling depth,
polling interval, desktop lane scale — is declared in `resource/config.mjs`;
scenario code never compares the mode's name.

Each phase reads `/proc` rows and renderer counters *before* any inspector,
query or heap work, because those collect garbage in the process being
measured; anything that can only be obtained by querying the heap is taken
afterwards and labelled post-GC. Expected processes are `(pid, startToken)`
identities checked every phase: a process that exited is recorded as exited, a
process that cannot be read makes the totals null, the coverage incomplete and
the safety verdict inconclusive. Totals cover the host tree and the measured
renderer only, and say so. One product RPC is one WebSocket torn down per call,
so polling loops use the mode's declared `pollIntervalMs`.

Repeatability is gated by a predeclared, category-specific policy: retained-heap
owners, the renderer state projection and native allocator names are strict
(same top owner, rank correlation); sampled allocation profiles and desktop
process rows are evidence, gated more loosely so one noisy sampled symbol cannot
fail a run, but never dropped. A structural category with one owner repeats when
that owner is the same in both runs; with two or more, rank correlation applies.
Slopes must keep their sign and stay inside the declared 25% coefficient of
variation — both are pass conditions, not annotations.

Quick mode exercises the mechanisms but is not baseline evidence. Full mode
requires two fresh runs. Run B is refused when run A crosses a safety ceiling or
leaves a survivor. Raw heaps are capped at 256 MiB, read one at a time in a
separate process under a declared heap ceiling, and deleted on every path. That
reader streams `nodes` and `edges` into typed arrays and fetches only the names
it prints, so a full-scale snapshot is measured rather than refused. Heap targets
are resolved while V8 is tracking object moves, which is the only window in which
a snapshot object id survives the collection that precedes the snapshot, and the
live instance is re-acquired through `Runtime.queryObjects` immediately before
its own capture. Final reports exclude scratch paths, inspector URLs, session
IDs, commands and payloads.

Native allocator ownership comes from one bounded Chrome memory dump taken after
the measured workload, at the least intrusive level of detail that still names
real allocator owners. Tracing never runs across the workload itself. To compare
instrumentation against the same image payload the soak uses:

```sh
node scripts/browser-check/resource-image-diagnostic.mjs --artifacts /tmp/resource-image-diagnostic
```

Tests: `pnpm test:browser-check` (also in `pnpm verify`).
