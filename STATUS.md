# STATUS.md — one screen, always current

Regenerated at the end of every work session from `STATUS_DETAILED.md`.
Rules in `AGENTS.md` §3.5. No dates or estimates here except "Last updated".

**Last updated:** 2026-09-05 · claude-2026-09-05-a · commit: see `git log -1`

**Current focus:** M1 is complete. From a browser tab: list, open, create,
stream markdown, steer/stop, answer extension dialogs, pick model and thinking,
rename, compact, fork/jump in history, survive reload. Try it:
`pnpm -r build && pnpm sandbox`. Next: M2 (many projects, attention model).

## Milestones

| Milestone | State | Note |
| --- | --- | --- |
| M0 Foundation | in-progress | T1–T7 done; T8 CI blocked (gh token scope) |
| M1 Local loop | done | all tasks done; syntax highlighting deferred (note in M1-T4) |
| M2 Many sessions, many projects | todo | depends on M1; can start now |
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

1. M2-T1 — worker pool lifecycle: idle retire (no attachments, no background subagent runs), crash restart with backoff, duplicate-cwd refusal test.
2. M2-T2 — attention model: per-session state (idle / working / waiting for input / error / finished-unread) and an attention-sorted inbox.
3. M2-T4 — project management: add/remove projects, Pi's trust prompt passed through.

## Recently done

- M1-T7, M1-T9 — rename, compact, fork + history panel. Evidence: `stable-sdk.prompt.test.ts` fork test, `server.test.ts`, browser run.
- M1-T3..T6, T8 — React UI: host client with resume, reducer, streaming markdown, composer, dialogs. Evidence: browser run against `pnpm sandbox`; `store.test.ts`.
- M1-T2 — session catalog with (size, mtime) cache. Evidence: `test/catalog.test.ts`; 42 real sessions in 13 ms.
- M1-T1 — host: worker pool over fd 3, router, local HTTP+WS. Evidence: `test/host.e2e.test.ts`.
- M0-T6 — worker JSON-RPC over fd 3 with seq, replay, dialog re-emit. Evidence: `test/server.test.ts`, `test/spawn.test.ts`.
