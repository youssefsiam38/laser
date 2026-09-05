# piorbit

A visualization and control layer on top of the [Pi coding agent](https://github.com/earendil-works/pi):
a web-tech desktop app with multi-project, multi-session navigation, subagent tab
groups (pi-subagents), a full settings surface, realtime low-level logs, and an
end-to-end encrypted relay so phones get the same UI.

Builds on the community's packages; does not replace them.

## Pi owns the logic, piorbit owns the experience

Pi ships almost nothing on purpose: no MCP, no subagents, no plan mode, no
todos, no background bash. Everything is an extension, and in a terminal every
extension invents its own presentation, because the only surface is lines of
text. In a GUI that would produce five apps in one window.

So piorbit does not pass presentation through. An extension declares **what it
has** — one of six panel kinds — and piorbit decides **how it looks and where
it goes**. Extensions never ship a component, a colour, or a layout. A package
that knows nothing about piorbit still renders correctly; one that opts into
the contract renders natively. That contract is
[`docs/ux-panels.md`](docs/ux-panels.md), and it is binding on every surface.

- Start here: [`AGENTS.md`](AGENTS.md) (how to work in this repo)
- Plan: [`PLAN.md`](PLAN.md) · Status: [`STATUS.md`](STATUS.md) · Ledger: [`STATUS_DETAILED.md`](STATUS_DETAILED.md)
- Panel contract: [`docs/ux-panels.md`](docs/ux-panels.md) · Agent work: [`docs/ux-agent-work.md`](docs/ux-agent-work.md) · Element inventory: [`docs/ux-elements.md`](docs/ux-elements.md) · Visual system: [`packages/ui/DESIGN.md`](packages/ui/DESIGN.md)
- Architecture: [`docs/architecture.md`](docs/architecture.md)
- Research: [`docs/research/findings.md`](docs/research/findings.md)

## Layout

```
packages/protocol          ACP-shaped messages + pi/* extras
packages/worker            per-project Pi host (pinned Pi), SessionDriver + two drivers, UI bridge
packages/pi-extension      the one companion Pi extension, a module per supported package
packages/host              supervisor, session catalog, pi-subagents file layer, local WebSocket, relay client, log store
packages/ui                the one web app (desktop renderer, browser, PWA)
packages/desktop           Electron shell with bundled Node
packages/crypto            Noise handshake, pairing, device list
packages/relay             Railway byte forwarder (no crypto library)
packages/cli               the `piorbit` command: host lifecycle, session verbs, pinned-Pi passthrough, doctor
```

## The `piorbit` command

```bash
pnpm install && pnpm -r build

piorbit                 # start the host and open the app (attaches if one is already up)
piorbit doctor          # check Node, the pinned Pi, credentials, ports, subagent roots — with fixes
piorbit sessions        # every session, newest first
piorbit send "run the tests"     # prompt the newest session here and stream the answer
piorbit tail --follow            # watch it work
piorbit pi --help                # Pi's own help, from the copy piorbit pins
```

`piorbit pi` runs the **pinned** Pi — the same copy the app runs — with
piorbit's `PI_CODING_AGENT_DIR` and `PI_SUBAGENTS_TEMP_ROOT`, so a session or a
background subagent run started from a terminal shows up in the app. Every
command takes `--json`; data goes to stdout and everything else to stderr.

Full command table, examples and the environment it reads:
[`packages/cli/README.md`](packages/cli/README.md).

## Develop

```bash
pnpm install
pnpm -r build
pnpm -r test
```

`pnpm install` links the `piorbit` bin into `node_modules/.bin`, so
`pnpm exec piorbit …` works from the repo root after a build.

Node 24, pnpm 10, TypeScript strict, ESM.
