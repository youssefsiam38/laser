# STATUS.md — one screen, always current

Regenerated at the end of every work session from `STATUS_DETAILED.md`.
Rules in `AGENTS.md` §3.5. No dates or estimates here except "Last updated".

**Last updated:** 2026-09-05 · claude-2026-09-05-a · commit: see `git log -1`

**Current focus:** M0 is done except CI. A real worker process opens Pi
sessions on pinned 0.85.0, streams prompts as seq-numbered updates over fd 3,
and answers extension dialogs. Next: the host (M1-T1) so a browser can attach.

## Milestones

| Milestone | State | Note |
| --- | --- | --- |
| M0 Foundation | in-progress | T1–T7 done; T8 CI blocked (gh token scope) |
| M1 Local loop | todo | depends on M0; can start now |
| M2 Many sessions, many projects | todo | depends on M1 |
| M3 Subagent tabs | todo | depends on M2; `subagents` module stub + host file-layer paths exist |
| M4 Settings and logs | todo | depends on M1; `provider-log` module already forwards request/response hooks |
| M5 Desktop shell | todo | depends on M1 |
| M6 Relay and pairing | todo | depends on M1, crypto |
| M7 Mobile PWA | todo | depends on M6 |
| M8 Package support | in-progress | M8-T1 capability report emitted by the extension; UI side todo |
| MX Cross-cutting | in-progress | MX-T1 seam green; pin 0.85.0; one upstream packaging bug logged |

## Blockers

- M0-T8 CI: gh token lacks `workflow` scope. Unblock: `gh auth refresh -s workflow`, then move `ci/github-workflow.yml` to `.github/workflows/ci.yml`. Blocks nothing else.

## Next up (dependencies satisfied)

1. M1-T1 — host: spawn one worker per cwd over fd 3, route JSON-RPC, local WebSocket on 127.0.0.1, serve the UI bundle.
2. M1-T2 — session catalog with (path, size, mtime) cache.
3. M1-T3 — UI shell (React + Vite): sidebar, transcript pane, composer.

## Recently done

- M0-T6 — worker JSON-RPC over fd 3 with seq, replay, dialog re-emit. Evidence: `test/server.test.ts`, `test/spawn.test.ts`.
- M0-T2 — protocol zod schemas, every method round-trips. Evidence: `test/schemas.test.ts`.
- M0-T4 — `StableSdkDriver` real. Evidence: `test/stable-sdk.prompt.test.ts` (stub provider).
- M0-T7 — UI bridge typed as `ExtensionUIContext` with Proxy fallback. Evidence: `test/ui-bridge.test.ts`.
- M0-T3 — `SessionDriver` reviewed against Pi 0.85 types.
