# STATUS.md — one screen, always current

Regenerated at the end of every work session from `STATUS_DETAILED.md`.
Rules in `AGENTS.md` §3.5. No dates or estimates here except "Last updated".

**Last updated:** 2026-09-05 · claude-2026-09-05-a · commit: see `git log -1`

**Current focus:** M1 Local loop, nearly done. A browser tab can list
sessions, open or create one, stream a reply as markdown, steer/stop, answer
extension dialogs, pick a model, and survive a reload. Try it: `pnpm -r build
&& pnpm sandbox`. Remaining in M1: rename + compaction controls (T7), session
tree (T9).

## Milestones

| Milestone | State | Note |
| --- | --- | --- |
| M0 Foundation | in-progress | T1–T7 done; T8 CI blocked (gh token scope) |
| M1 Local loop | in-progress | T1–T6, T8 done; T7 in-progress; T9 todo |
| M2 Many sessions, many projects | todo | depends on M1 |
| M3 Subagent tabs | todo | depends on M2; `subagents` module stub + host file-layer paths exist |
| M4 Settings and logs | todo | depends on M1; `provider-log` module already forwards request/response hooks |
| M5 Desktop shell | todo | depends on M1 |
| M6 Relay and pairing | todo | depends on M1, crypto |
| M7 Mobile PWA | todo | depends on M6; layout already responsive with safe areas |
| M8 Package support | in-progress | M8-T1 capability report emitted by the extension; UI side todo |
| MX Cross-cutting | in-progress | MX-T1 seam green; pin 0.85.0; one upstream packaging bug logged |

## Blockers

- M0-T8 CI: gh token lacks `workflow` scope. Unblock: `gh auth refresh -s workflow`, then move `ci/github-workflow.yml` to `.github/workflows/ci.yml`. Blocks nothing else.

## Next up (dependencies satisfied)

1. M1-T7 — rename and compaction controls in the top bar.
2. M1-T9 — session tree: `pi/session/fork` in the worker (via `AgentSessionRuntime.fork`), tree view from entries, navigate.
3. M2-T1 — worker pool lifecycle: idle retire, crash restart with backoff.

## Recently done

- M1-T3..T6, T8 — React UI: host client with resume, reducer, streaming markdown, composer, dialogs. Evidence: browser run against `pnpm sandbox`; `packages/ui/test/store.test.ts`.
- M1-T2 — session catalog with (size, mtime) cache; both Pi layouts. Evidence: `test/catalog.test.ts`; 42 real sessions in 13 ms.
- M1-T1 — host: worker pool over fd 3, router, local HTTP+WS. Evidence: `test/host.e2e.test.ts`.
- M0-T6 — worker JSON-RPC over fd 3 with seq, replay, dialog re-emit. Evidence: `test/server.test.ts`, `test/spawn.test.ts`.
- M0-T2 — protocol zod schemas, every method round-trips. Evidence: `test/schemas.test.ts`.
