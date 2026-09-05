# piorbit

A visualization and control layer on top of the [Pi coding agent](https://github.com/earendil-works/pi):
a web-tech desktop app with multi-project, multi-session navigation, subagent tab
groups (pi-subagents), a full settings surface, realtime low-level logs, and an
end-to-end encrypted relay so phones get the same UI.

Builds on the community's packages; does not replace them.

- Start here: [`AGENTS.md`](AGENTS.md) (how to work in this repo)
- Plan: [`PLAN.md`](PLAN.md) · Status: [`STATUS.md`](STATUS.md) · Ledger: [`STATUS_DETAILED.md`](STATUS_DETAILED.md)
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
```

## Develop

```bash
pnpm install
pnpm -r build
pnpm -r test
```

Node 24, pnpm 10, TypeScript strict, ESM.
