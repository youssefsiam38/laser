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
```

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

Tests: `pnpm test:browser-check` (also in `pnpm verify`).
