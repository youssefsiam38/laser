# STATUS.md — one screen, always current

Regenerated at the end of every work session from `STATUS_DETAILED.md`.
Rules in `AGENTS.md` §3.5. No dates or estimates here except "Last updated".

**Last updated:** 2026-09-05 · claude-2026-09-05-a · commit: e75d09a

**Current focus:** M0 Foundation — scaffold builds and tests green, companion
extension package in place (D-13); next is finishing the protocol schemas and
making `StableSdkDriver` real.

## Milestones

| Milestone | State | Note |
| --- | --- | --- |
| M0 Foundation | in-progress | T1, T5 done; T2, T3, T7 in-progress; T4, T6, T8 todo |
| M1 Local loop | todo | depends on M0 |
| M2 Many sessions, many projects | todo | depends on M1 |
| M3 Subagent tabs | todo | depends on M2; `subagents` module stub + host file-layer paths exist |
| M4 Settings and logs | todo | depends on M1; `provider-log` module already forwards request/response hooks |
| M5 Desktop shell | todo | depends on M1 |
| M6 Relay and pairing | todo | depends on M1, crypto |
| M7 Mobile PWA | todo | depends on M6 |
| M8 Package support | in-progress | M8-T1 capability report emitted by the extension; UI side todo |
| MX Cross-cutting | in-progress | MX-T1 seam green; pin 0.85.0 |

## Blockers

- None. (Q-2 UI framework defaults to React + Vite unless the user objects before M1-T3.)

## Next up (dependencies satisfied)

1. M0-T4 — `StableSdkDriver.open()` on pinned Pi 0.85.0, loading `createPiorbitExtension` as an inline extension, with a stub-provider test.
2. M0-T2 — zod schemas + per-message round-trip tests in `@piorbit/protocol`.
3. M0-T7 — Proxy over Pi's no-op UI context; editor round-trip; wire into the driver.

## Recently done

- D-13 — `packages/pi-extension` (one extension, modules: provider-log, subagents, transcribe, web-access) replaces subagents-bridge; file layer moved to `packages/host/src/subagents/`. Evidence: `pnpm -r build && pnpm -r test` green (7 tests).
- M0-T5 — ChordDriver stub + seam test. Evidence: `pnpm -F @piorbit/worker test` (3 seam tests pass).
- M0-T1 — workspace scaffold. Evidence: `ELECTRON_SKIP_BINARY_DOWNLOAD=1 pnpm install && pnpm -r build && pnpm -r test` passes.
