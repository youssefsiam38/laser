# STATUS.md — one screen, always current

Regenerated at the end of every work session from `STATUS_DETAILED.md`.
Rules in `AGENTS.md` §3.5. No dates or estimates here except "Last updated".

**Last updated:** 2026-09-05 · claude-2026-09-05-a · commit: see `git log -1` (updated after each push)

**Current focus:** M0 Foundation — the real driver opens a session on pinned
Pi 0.85.0 and streams a stub-provider prompt as ordered updates (tested). Next:
protocol schemas and the worker's JSON-RPC transport, then M1.

## Milestones

| Milestone | State | Note |
| --- | --- | --- |
| M0 Foundation | in-progress | T1, T3, T4, T5, T7 done; T2 in-progress; T6 todo; T8 blocked (gh token scope) |
| M1 Local loop | todo | depends on M0 |
| M2 Many sessions, many projects | todo | depends on M1 |
| M3 Subagent tabs | todo | depends on M2; `subagents` module stub + host file-layer paths exist |
| M4 Settings and logs | todo | depends on M1; `provider-log` module already forwards request/response hooks |
| M5 Desktop shell | todo | depends on M1 |
| M6 Relay and pairing | todo | depends on M1, crypto |
| M7 Mobile PWA | todo | depends on M6 |
| M8 Package support | in-progress | M8-T1 capability report emitted by the extension; UI side todo |
| MX Cross-cutting | in-progress | MX-T1 seam green; pin 0.85.0; one upstream packaging bug logged |

## Blockers

- M0-T8 CI: gh token lacks `workflow` scope. Unblock: `gh auth refresh -s workflow`, then move `ci/github-workflow.yml` to `.github/workflows/ci.yml`. Not blocking any other task.

## Next up (dependencies satisfied)

1. M0-T2 — zod schemas + per-message round-trip tests in `@piorbit/protocol`.
2. M0-T6 — worker JSON-RPC dispatch over stdio: `session/*` and `pi/*` methods → `SessionDriver`; `session/update` with per-session `seq`.
3. M1-T1 — host: spawn one worker, route JSON-RPC, local WebSocket on 127.0.0.1.

## Recently done

- M0-T4 — `StableSdkDriver` real. Evidence: `pnpm -F @piorbit/worker test` (stub provider prompt cycle, open/dispose sandboxed, event mapping).
- M0-T7 — UI bridge typed as `ExtensionUIContext` with Proxy fallback; wired into the driver. Evidence: `test/ui-bridge.test.ts`.
- M0-T3 — `SessionDriver` reviewed against Pi 0.85 types. Evidence: driver tests compile and pass.
- D-13 — one companion extension with modules. Evidence: `pnpm -r build && pnpm -r test` green.
- M0-T5 — ChordDriver stub + seam test. Evidence: `test/seam.test.ts`.
