# STATUS.md — one screen, always current

Regenerated at the end of every work session from `STATUS_DETAILED.md`.
Rules in `AGENTS.md` §3.5. No dates or estimates here except "Last updated".

**Last updated:** 2026-09-05 · claude-2026-09-05-b · commit: see `git log -1`

**Current focus:** M1 is complete and the UI is rebuilt on assistant-ui
(D-17). From a browser tab: pick a project, list and open sessions, stream
markdown with highlighted code, steer/stop, answer extension dialogs, read
context and spend in the telemetry rail, fork/jump in history, in light and
dark, desktop and mobile. Try it: `pnpm -r build && pnpm sandbox`.
Next: M2 (many projects, attention model).

## Milestones

| Milestone | State | Note |
| --- | --- | --- |
| M0 Foundation | in-progress | T1–T7 done; T8 CI blocked (gh token scope) |
| M1 Local loop | done | T1–T10 done, including the assistant-ui rebuild |
| M2 Many sessions, many projects | in-progress | T1–T4 done (worker lifecycle, attention + inbox, fast switching, projects + trust); T5 needs M5 |
| M3 Subagent tabs | todo | depends on M2; `subagents` module stub + host file-layer paths exist |
| M4 Settings and logs | todo | depends on M1; `provider-log` module already forwards request/response hooks |
| M5 Desktop shell | todo | depends on M1 |
| M6 Relay and pairing | todo | depends on M1, crypto |
| M7 Mobile PWA | todo | depends on M6; layout, safe areas and the keyboard inset already in place |
| M8 Package support | in-progress | M8-T1 capability report emitted by the extension; UI side todo |
| MX Cross-cutting | in-progress | MX-T1 seam green; pin 0.85.0; one upstream packaging bug logged |

## Blockers

- M0-T8 CI: gh token lacks `workflow` scope. Unblock: `gh auth refresh -s workflow`, then move `ci/github-workflow.yml` to `.github/workflows/ci.yml`. Blocks nothing else.

## Next up (dependencies satisfied)

1. Worker patch for M2-T4 (handoff H-1): four edits so the worker honours the host's `--project-trusted`. Until it lands, Pi runs every project trusted.
2. M3-T1/T2 — subagent tabs: the host already reads `status.json` and the runner pid for the retirement guard, so the file layer has a foothold.
3. M2-T5 — desktop notifications for waiting/finished sessions; needs M5's Electron shell to be real.

## Recently done

- M2-T1..T4 — worker lifecycle (starting/ready/crashed/retired, backoff restart, idle retire gated on attachments and live pi-subagents runs), host attention model with persisted "seen" and an inbox, hydrated-view cache, server-side projects with Pi's trust gate. Evidence: `pnpm -F @piorbit/host test` (55 tests) and `pnpm -F @piorbit/ui test` (135 tests).
- M1-T10 — UI rebuilt on assistant-ui 0.15.18 + Tailwind v4 per `packages/ui/DESIGN.md`. Evidence: 172 tests; browser run (streaming, tokenized code, both themes, both layouts). Three defects found in browser verification and fixed: a blank screen on the first send, code blocks that never tokenized, and a touch media query that disagreed with the composer primitive.
- M1-T7, M1-T9 — rename, compact, fork + history panel.
- M1-T3..T6, T8 — the local loop end to end, with resume after reload.
- M1-T1, M1-T2 — host worker pool over fd 3, router, local HTTP+WS, session catalog.
