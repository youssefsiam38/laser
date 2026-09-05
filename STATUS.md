# STATUS.md — one screen, always current

Regenerated at the end of every work session from `STATUS_DETAILED.md`.
Rules in `AGENTS.md` §3.5. No dates or estimates here except "Last updated".

**Last updated:** 2026-09-05 · claude-2026-09-05-c · commit: `958bfb1`

**Current focus:** Wave 1 landed and is green (385 tests): many projects with
an attention model, the full settings and logs surfaces, the `piorbit` CLI
with Pi passthrough and doctor, and the relay + Noise crypto. The panel
contract (D-18) and agent-work model (D-19) are decided. Next: wave 2 — the
panel system (islands), M3 subagent tabs on top of it, M5 desktop, M7 mobile
PWA, M8 package support, and the D-20 polish.

## Milestones

| Milestone | State | Note |
| --- | --- | --- |
| M0 Foundation | in-progress | T1–T7 done; T8 CI blocked on GitHub billing (not code) |
| M1 Local loop | done | assistant-ui rebuild included |
| M2 Many sessions, many projects | in-progress | T1–T4 done; T5 needs M5; T6 (git line) new |
| M3 Subagent tabs | todo | unblocked by D-18/D-19; builds on the panel system |
| M4 Settings and logs | in-progress | T1–T6 done; T7 keybindings/trust views todo |
| M5 Desktop shell | todo | wave 2 |
| M6 Relay and pairing | done | channel id via subprotocol (D-21); rotation deferred (D-22) |
| M7 Mobile PWA | todo | wave 2 |
| M8 Package support | in-progress | M8-T1 capability report; rest in wave 2 |
| M9 CLI | in-progress | T1–T4, T6 done; T5 partial; T7, T8 todo |
| MX Cross-cutting | in-progress | seam green; pin 0.85.0; upstream patches pending |

## Blockers

- M0-T8 CI: GitHub Actions refused to start (account billing). `pnpm verify` locally. Nothing in the repo to change.

## Next up (dependencies satisfied)

1. Wave 2 — panel system (protocol types, companion `panels` module, islands + dock), then M3 on it; M5, M7, M8 and the D-20 polish in parallel.
2. M9-T5/T7/T8 — settings/packages/relay/logs/completions CLI verbs; protocol is ready.
3. M4-T7 — keybindings and trust store views.

## Recently done

- Wave 1 (`7841860`, `958bfb1`) — M2-T1..T4, M4-T1..T6, M6-T1..T7, M9-T1..T4, M9-T6. 39 review findings applied; relay channel id moved into the WebSocket subprotocol; log redaction widened. Evidence: 385 tests.
- D-18..D-22 — panel contract, agent-work model, Claude Code amendments, subprotocol channel id, honest deferrals.
- M1-T10 — UI rebuilt on assistant-ui 0.15.18 + Tailwind v4.
