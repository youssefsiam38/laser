# @piorbit/desktop

The Electron shell. It is not the app — `@piorbit/ui` is the app, and it is the
same bundle in this window, a browser tab and a phone. This package is
everything a web page cannot do for itself: a process to run the agent host in,
a tray that keeps counting while every window is closed, notifications that
deep-link back into a session, the OS keychain, and updates.

```
┌─────────────────────────────────────────────┐
│ Electron main  (this package)               │
│   window · tray · notifications · keychain  │
│   deep links · updater · panel pop-out      │
└──────┬───────────────────────┬──────────────┘
       │ spawn                 │ ws (read-only: sessions, attention)
┌──────▼───────────────────────▼──────────────┐
│ resources/runtime/node   ← stock Node 24.20 │
│   piorbit __daemon  =  @piorbit/host        │
│     one worker per project, each with Pi    │
└─────────────────────────────────────────────┘
       ▲ http
┌──────┴──────────────────────────────────────┐
│ BrowserWindow → the host's own UI bundle    │
│   preload exposes window.piorbit            │
└─────────────────────────────────────────────┘
```

## Why a second Node

The host is a **child process running a stock Node binary we ship**, not code
running inside Electron. Three reasons, all of them load-bearing:

- `process.execPath` inside the host has to be a real `node`. Pi and every MCP
  stdio server are spawned with it, and so is `npx`. A child that inherits an
  Electron `execPath` either fails to start or launches a second copy of the
  app. The `runAsNode` fuse would make Electron pretend, but it also turns the
  shipped app into a general-purpose script runner — a hole we do not need.
- A stock binary means no ABI rebuild for any native module, ever.
- `utilityProcess` is the other tempting shortcut: it has no stdin, and the
  worker pipe needs one.

`app.asar` is an archive, not a filesystem. A kernel cannot exec a path inside
one and a process cannot use one as a working directory, so the Node binary is
an `extraResources` entry and the whole of `node_modules` is `asarUnpack`ed.

The binary is pinned in [`runtime.json`](runtime.json) with the SHA-256 from
`https://nodejs.org/dist/v<version>/SHASUMS256.txt`, **copied into git**:
verifying a download against a checksum fetched from the same server at the same
moment proves nothing.

```bash
pnpm -F @piorbit/desktop runtime                    # every pinned platform
pnpm -F @piorbit/desktop runtime -- --current --verify
```

`--verify` runs the binary and asserts it reports itself as plain Node with its
own path as `process.execPath`. That assertion is M5-T2.

To bump the version: change `version` in `runtime.json`, replace **every** hash
from the new `SHASUMS256.txt`, delete `runtime/`, and re-run the command above.

## Development

```bash
pnpm -F @piorbit/desktop install:electron   # once: fetch the Electron binary
pnpm -F @piorbit/desktop runtime -- --current
pnpm -r build
pnpm -F @piorbit/desktop dev
```

`dev` starts (or attaches to) a host and loads the UI the host serves. The host
is a real one: `piorbit status` sees it, `piorbit down` stops it, and closing
the app stops it only if the app started it.

| Variable | Effect |
| --- | --- |
| `PIORBIT_UI_URL` | Load this instead of the host's bundle — point it at Vite (`http://127.0.0.1:5173`) to hot-reload the UI. |
| `PIORBIT_NODE` | Use this Node for the host instead of the bundled one. |
| `PIORBIT_PORT`, `PIORBIT_AGENT_DIR`, `PIORBIT_STATE_DIR`, `PIORBIT_SESSION_DIR` | Resolved by `@piorbit/cli`, exactly as for the CLI. A GUI takes its configuration from the environment, never from argv. |

Logs: `<state-dir>/desktop.log` (the shell) and `<state-dir>/host.log` (the
host). Two files on purpose — when the app will not start, the only question is
which of the two failed.

**Hot-reloading the UI.** Two terminals:

```bash
pnpm -F @piorbit/ui dev                                                  # Vite on :5173
PIORBIT_UI_URL=http://127.0.0.1:5173 pnpm -F @piorbit/desktop dev        # the shell, pointed at it
```

The host refuses WebSocket upgrades from origins it does not recognise, and
Vite forwards the browser's own `Origin` (`http://127.0.0.1:5173`). Nothing to
do about it by hand: the shell passes `PIORBIT_ALLOWED_ORIGINS=<dev origin>`
to the host it spawns (`src/main.ts`), and the daemon reads it into
`HostServer({ allowedOrigins })` (`@piorbit/cli` `src/daemon.ts`).

To run against the built bundle instead, `pnpm -F @piorbit/ui build` and drop
`PIORBIT_UI_URL`.

Headless smoke test on Linux (no X server needed):

```bash
env -u DISPLAY -u WAYLAND_DISPLAY PIORBIT_STATE_DIR=/tmp/piorbit-smoke \
  ./node_modules/electron/dist/electron --ozone-platform=headless --disable-gpu dist/main.js
```

## What the renderer gets

The preload exposes one frozen object, `window.piorbit`, typed by
[`src/api.ts`](src/api.ts) (`@piorbit/desktop/api`). It is **absent in the web
build**, so every caller has to check — which is what keeps the browser, the
phone and this window on one code path.

| | |
| --- | --- |
| `version`, `platform`, `chrome` | Version, OS, and the titlebar geometry the UI must respect: `chrome.height` of draggable strip, `chrome.insetLeft` clear of the macOS traffic lights, `chrome.insetRight` clear of the Windows controls, and `chrome.controls === "custom"` when the UI must draw minimise/maximise/close itself (Linux). |
| `panel` | The `PanelDescriptor` when this window *is* a popped-out panel; `null` in the app window. Available before first paint. |
| `host()`, `onHost()`, `retryHost()` | The host's state, url and ws url. |
| `popOutPanel(descriptor)`, `closePanelWindow()` | docs/ux-panels.md D-20. Asking twice for one panel id focuses the window that exists rather than opening a second copy. On the web, the UI opens a tab instead. |
| `onDeepLink()`, `pendingDeepLinks()` | `piorbit://session/<path>`, `piorbit://project/<cwd>`, `piorbit://open`. Call `pendingDeepLinks()` once on mount: it drains links that arrived before the UI was listening (a cold start from a notification) **and** is how the shell learns the UI is ready. |
| `window.*` | minimise / toggle maximise / close, and the maximised-fullscreen-focused state, for the custom titlebar. |
| `setTheme("light" \| "dark")` | Keeps the native frame in step; call it whenever the UI's theme changes. |
| `microphone.*` | `status()`, `request()` (prompts once), `openSettings()` (the only way back after a refusal). |
| `identity()` | Device id and where the key is stored. Carries a `degraded` message when there was no keychain — the UI must show it. |
| `updates.*` | State, check, install. |

The window's top bar is drawn by the UI; the shell only says where it may not
draw. Give the strip `-webkit-app-region: drag` and every control inside it
`-webkit-app-region: no-drag`.

## Packaging

```bash
pnpm -F @piorbit/desktop pack     # unpacked app in out/, no installer
pnpm -F @piorbit/desktop dist     # installers for the current platform
```

`beforePack` ([`build/before-pack.cjs`](build/before-pack.cjs)) resolves the
target's Node from `runtime/<platform>-<arch>/` into `build/runtime/`,
downloading it if needed, so a clean build agent works.

Two hard prerequisites:

1. **Build each platform on that platform.** `@napi-rs/keyring` installs a
   prebuilt binary for the host platform only, and signing needs the platform's
   own toolchain anyway. There is deliberately no macOS universal target: a
   universal app would need a `lipo`-merged Node, and the update feed expects
   per-architecture artifacts.
2. **pnpm's isolated `node_modules` and electron-builder disagree.** Package
   from a hoisted tree — `node-linker=hoisted` in `.npmrc` on the build agent,
   or `pnpm deploy` into a staging directory — otherwise the symlinked store
   produces an app whose dependencies do not resolve.

`appId` is `dev.piorbit.desktop` and **must never change**: it keys the macOS
TCC grants (including the microphone), the Windows notification centre, and the
update feed. A new id is a new app that has to ask for permissions again and
cannot update the old one.

### macOS: signing and notarization

Needs a paid Apple Developer account and a *Developer ID Application*
certificate in the login keychain.

```bash
export CSC_LINK=/path/to/DeveloperID.p12       # or leave it in the keychain
export CSC_KEY_PASSWORD='…'
# notarytool, either an App Store Connect API key (preferred):
export APPLE_API_KEY=/path/to/AuthKey_XXXXXXXX.p8
export APPLE_API_KEY_ID=XXXXXXXX
export APPLE_API_ISSUER=00000000-0000-0000-0000-000000000000
# …or an Apple ID with an app-specific password:
export APPLE_ID='you@example.com'
export APPLE_APP_SPECIFIC_PASSWORD='abcd-efgh-ijkl-mnop'
export APPLE_TEAM_ID=XXXXXXXXXX

pnpm -F @piorbit/desktop dist -- --mac --arm64
pnpm -F @piorbit/desktop dist -- --mac --x64
```

`electron-builder.yml` already sets `hardenedRuntime`, `notarize: true`, the
entitlements file, and `mac.binaries` so the bundled `node` is signed too — an
unsigned Mach-O anywhere inside a hardened bundle fails notarization.

**The microphone trap.** `NSMicrophoneUsageDescription` in `Info.plist` is not
a prompt string, it is the permission itself: without it macOS *kills* the
process the moment it touches the microphone. And an **ad-hoc-signed build
silently loses microphone and camera access** — electron-builder 26.15.3 is
pinned partly for the fix in 26.0.13. Never test dictation on an unsigned local
build and conclude the code is broken.

Verify a finished build:

```bash
codesign -dv --verbose=4 out/mac-arm64/piorbit.app
codesign --verify --deep --strict out/mac-arm64/piorbit.app
spctl -a -vvv -t install out/mac-arm64/piorbit.app     # expect "accepted … Notarized Developer ID"
xcrun stapler validate out/mac-arm64/piorbit.app
codesign -dv out/mac-arm64/piorbit.app/Contents/Resources/runtime/node
```

### Windows: Azure Trusted Signing

Set up once in Azure: a Trusted Signing account, a certificate profile, and an
app registration granted the **Trusted Signing Certificate Profile Signer** role
on the account. Then export four values; `build/before-pack.cjs` writes
`azureSignOptions` from them at pack time, and says so in the build log.

Nothing is committed, because electron-builder 26 reads the *presence* of
`azureSignOptions` as "sign this build" and fails when the endpoint does not
resolve — a placeholder in the file would turn a missing credential into a
broken `--win` target instead of an unsigned installer. With none of these set,
`--win` produces an honest unsigned installer and logs that it did.

| Variable | Where it comes from |
| --- | --- |
| `PIORBIT_AZURE_PUBLISHER_NAME` | The subject name on the certificate profile — must match exactly. |
| `PIORBIT_AZURE_ENDPOINT` | `https://<region>.codesigning.azure.net`, from the account overview. |
| `PIORBIT_AZURE_ACCOUNT` | The Trusted Signing account name. |
| `PIORBIT_AZURE_PROFILE` | The profile inside that account. |

The credentials electron-builder reads itself come from the environment too,
and never from a file:

```powershell
$env:AZURE_TENANT_ID="…"
$env:AZURE_CLIENT_ID="…"
$env:AZURE_CLIENT_SECRET="…"
pnpm -F @piorbit/desktop dist -- --win --x64
pnpm -F @piorbit/desktop dist -- --win --arm64
```

Verify with `signtool verify /pa /v out\piorbit-…-setup.exe`.

### Linux: AppImage

```bash
pnpm -F @piorbit/desktop dist -- --linux --x64
```

No signing. `piorbit://` links come from the `.desktop` entry's
`MimeType=x-scheme-handler/piorbit;`, which the AppImage registers when it is
integrated with the desktop (AppImageLauncher, or a manual `.desktop` file). A
`chmod +x` AppImage run straight from `~/Downloads` will not have deep links
until it is integrated — that is the format, not a bug in piorbit.

### Updates

`electron-updater` against GitHub Releases (`publish:` in
`electron-builder.yml`). Publishing needs `GH_TOKEN` with `repo` scope:

```bash
GH_TOKEN=… pnpm -F @piorbit/desktop dist -- --publish always
```

Both `dmg` **and** `zip` are built for macOS: the updater needs the zip, people
download the dmg. The app checks 20 s after launch and every six hours,
downloads quietly, and **never restarts by itself** — an agent may be mid-turn.
The tray offers "Restart to update", and `autoInstallOnAppQuit` picks it up on
the next ordinary quit.

**Updates are off until a public feed exists.** `publish` is `null` in
`electron-builder.yml`, so no `app-update.yml` ships and the app reports
`unsupported` — "this build has no update feed" — rather than an error it
cannot recover from. The feed it used to name is this private repository, and
electron-updater fetches `latest.yml` unauthenticated: every installed copy
would 404 forever. `electron-builder.yml` carries the two supported ways to
turn it on (a public releases repository, or a generic feed URL).

Once one is set, verify an update end to end: publish version A as a release,
install it, publish version B, then reopen the app and wait for the tray item
to change.

## What is not verified here

The main process, the bundled-Node host spawn, the keychain and graceful
shutdown were all exercised headlessly on Linux. Everything below needs the
platform in question and is untested:

- the macOS traffic-light inset and the Windows `titleBarOverlay` colours;
- macOS notarization, the microphone TCC prompt, and Windows Azure signing;
- deep links delivered by the OS (they are exercised only through the parser's
  unit tests);
- the tray's appearance in a real menu bar, notification banners, and updating
  from version A to version B.
