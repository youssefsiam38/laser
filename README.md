# laser

A visualization and control layer on top of the [Pi coding agent](https://github.com/earendil-works/pi):
a web-tech desktop app with multi-project, multi-session navigation, its own
agent harness with live child sessions, a full settings surface, and realtime
low-level logs.
Phone remote control through the encrypted relay is coming soon.

Builds on the community's packages; does not replace them.

## Pi owns the logic, laser owns the experience

Pi ships almost nothing on purpose: no MCP, no subagents, no plan mode, no
todos, no background bash. Everything is an extension, and in a terminal every
extension invents its own presentation, because the only surface is lines of
text. In a GUI that would produce five apps in one window.

So laser does not pass presentation through. An extension declares **what it
has** — one of six panel kinds — and laser decides **how it looks and where
it goes**. Extensions never ship a component, a colour, or a layout. A package
that knows nothing about laser still renders correctly; one that opts into
the contract renders natively. That contract is
[`docs/ux-fleet.md`](docs/ux-fleet.md), and it is binding on every surface.

- Start here: [`AGENTS.md`](AGENTS.md) (how to work in this repo)
- Plan: [`PLAN.md`](PLAN.md) · Status: [`STATUS.md`](STATUS.md) · Ledger: [`STATUS_DETAILED.md`](STATUS_DETAILED.md)
- The fleet: [`docs/ux-fleet.md`](docs/ux-fleet.md) · Agent work: [`docs/ux-agent-work.md`](docs/ux-agent-work.md)
- Element inventory: [`docs/ux-elements.md`](docs/ux-elements.md) · Theme system: [`docs/ux-theme.md`](docs/ux-theme.md) · Default preset: [`packages/ui/DESIGN.md`](packages/ui/DESIGN.md)
- Architecture: [`docs/architecture.md`](docs/architecture.md)
- Research: [`docs/research/findings.md`](docs/research/findings.md)

## Install

One public, versioned command. It needs `curl` and
[`gh`](https://cli.github.com) 2.49 or newer for offline provenance verification,
but no GitHub account or sign-in — and no Node, npm, package manager, or agent.
The app carries its own runtime.

```bash
curl -fsSLo laser-install.sh https://github.com/youssefsiam38/laser/releases/latest/download/install.sh \
  && sh laser-install.sh
```

That downloads the release for your architecture, checks it against the
checksums published with it **and** against GitHub's build provenance — the
Sigstore signature binding those bytes to laser's release workflow, this
repository and the commit it was built from, verified from the release's
offline bundle — then chooses the native package for the operating system.
Ubuntu and Debian get the `.deb`; Fedora, RHEL and openSUSE get the `.rpm`.
That asks for the normal administrator password once, puts laser in the
application menu with its icon, and registers Laser's signed package feed so
Ubuntu Software Updater, GNOME Software, Discover or dnf can announce and
install later releases normally.

For a no-root home-directory install, choose `--format appimage`. That path
unpacks under `~/.local` and rolls an interrupted upgrade back, but it is not
owned by the operating system's updater; re-run the install command to upgrade
it.

Provenance is required, not advisory. A build with none is refused, and a build
whose provenance does not verify is refused with no flag to override it. Only a
release assembled by hand has no provenance, and installing one is a sentence
you type on purpose: `--allow-unattested`.

The script is downloaded and then read from disk rather than piped into a
shell, so you can look at it first. That is the point of the two halves of the
command, and `sh laser-install.sh --dry-run` prints every action it would take
without taking any of them.

```bash
sh laser-install.sh --help                     # --version, --format, --prefix, --dry-run
sh laser-install.sh --version v0.1.0 --format appimage  # no-root, per-user install
sh ~/.local/lib/laser/install.sh --uninstall   # removes exactly what it installed
sh ~/.local/lib/laser/install.sh --uninstall --purge   # …and deletes your settings too
```

## License

Laser is open source under `AGPL-3.0-only`, with a commercial license available
for proprietary products and hosted modifications. The reusable protocol and
Pi-native goal packages are `Apache-2.0`. See [`LICENSING.md`](LICENSING.md) for
the exact path-level scope and [`TRADEMARKS.md`](TRADEMARKS.md) for the name and
logo policy.

`laser` on your PATH is both things: on its own it opens the window, and with
a word after it — `laser doctor`, `laser sessions` — it is the command
below, running on the same bundled runtime as the app, against the same
directory. Nothing about the app requires it.

Uninstalling asks before it deletes your settings and paired devices, and
leaves them alone if you say no — or if there is nobody to ask. `--yes` means
"do not stop to ask me", never "delete my data"; deleting it is `--purge`, on
its own, because a device identity and every pairing do not come back.

Everything after that is inside the window: providers, models, projects,
extensions and themes are all installed and configured from Settings. See
[`scripts/release/README.md`](scripts/release/README.md) for how a release is
built and what it contains.

## Layout

```
packages/protocol          ACP-shaped messages + pi/* extras
packages/worker            per-project Pi host (pinned Pi), SessionDriver + two drivers, UI bridge
packages/pi-extension      the one companion Pi extension, a module per supported package
packages/host              supervisor, session catalog, agent-run registry, local WebSocket, relay client, log store
packages/ui                the one web app (desktop renderer, browser, PWA)
packages/desktop           Electron shell with bundled Node
packages/crypto            Noise handshake, pairing, device list
packages/relay             Railway byte forwarder (no crypto library)
packages/cli               the `laser` command: host lifecycle, session verbs, pinned-Pi passthrough, doctor
```

## The `laser` command

```bash
pnpm install && pnpm -r build

laser                 # start the host and open the app (attaches if one is already up)
laser doctor          # check Node, the pinned Pi, credentials and ports — with fixes
laser sessions        # every session, newest first
laser send "run the tests"     # prompt the newest session here and stream the answer
laser tail --follow            # watch it work
laser pi --help                # Pi's own help, from the copy laser pins
```

`laser pi` runs the **pinned** Pi — the same copy the app runs — with
laser's `PI_CODING_AGENT_DIR` and `PI_CODING_AGENT_SESSION_DIR`, so a session
started from a terminal shows up in the app. Every command takes `--json`; data
goes to stdout and everything else to stderr.

Full command table, examples and the environment it reads:
[`packages/cli/README.md`](packages/cli/README.md).

## Develop

```bash
pnpm install
pnpm -r build
pnpm -r test
```

`pnpm install` links the `laser` bin into `node_modules/.bin`, so
`pnpm exec laser …` works from the repo root after a build.

Node 24, pnpm 10, TypeScript strict, ESM.
