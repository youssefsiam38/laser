# STATUS.md — one screen, always current

Regenerated at the end of every work session from `STATUS_DETAILED.md`.
Rules in `AGENTS.md` §3.5. No dates or estimates here except "Last updated".

**Last updated:** 2026-09-05 · claude-2026-09-05-integrator · commit: `239d93f` (working tree)

**Current focus:** Wave 2 landed and is integrated (591 tests, exit 0). The
panel contract is now the app: one island system carries subagent runs, plans,
missions, extension widgets, document previews, the host's own log sections and
every dialog. The desktop shell, the mobile PWA, dictation and push are wired
end to end. Next: fill the honest gaps — push and dictation have no device to
prove them, the desktop has no signing, and no screen has been seen at a real
phone width.

## Milestones

| Milestone | State | Note |
| --- | --- | --- |
| M0 Foundation | in-progress | T1–T7 done; T8 CI blocked on GitHub billing (not code) |
| M1 Local loop | done | assistant-ui rebuild included |
| MP Panel system | done | T1–T7; the contract in `docs/ux-panels.md` is implemented and everything else draws through it |
| M2 Many sessions, many projects | in-progress | T1–T4, T6 done; T5 needs a real desktop session to fire a notification |
| M3 Subagent tabs | in-progress | T1–T3, T5–T8 done; T4 resume needs a live bus; T9 upstream PRs unfiled |
| M4 Settings and logs | in-progress | T1–T6 done (logs sections are stream panels now); T7 keybindings/trust views todo |
| M5 Desktop shell | in-progress | T1–T3 done and proven on this machine; T4/T5 need macOS, Windows and credentials |
| M6 Relay and pairing | done | channel id via subprotocol (D-21); rotation deferred (D-22) |
| M7 Mobile PWA | in-progress | T1–T4 done; T5 push and T6 mic are complete in code, unproven without a phone |
| M8 Package support | in-progress | T1, T3–T5 done; T2 dictation wired but this machine has only OAuth providers |
| M9 CLI | in-progress | T1–T4, T6 done, plus `runs`/`plan`/`missions`; T5 partial; T7, T8 todo |
| MX Cross-cutting | in-progress | seam green; pin 0.85.0; upstream patches written, none filed |

## Blockers

- M0-T8 CI: GitHub Actions refused to start (account billing). `pnpm verify` locally. Nothing in the repo to change.
- M7-T5 push: needs `HostRelayOptions.publicOrigin`; nothing sets it, so a notification's link points at loopback.
- M8-T2 dictation: needs a platform OpenAI API key. Every provider signed in here is OAuth-backed, which `/v1/audio/transcriptions` rejects — the status message says so by name.

## Next up (dependencies satisfied)

1. A real phone and a real desktop session: push delivery, dictation end to end, tray and notification banners, and every screen at 390px.
2. M9-T5/T7/T8 — settings/packages/relay/logs/completions CLI verbs; protocol is ready.
3. MX-T6 — `docs/ux-elements.md` became binding after wave 2's components were written; walk it row by row and install the catalog element wherever hand-rolled code is standing in for one.
4. M3-T4 resume and M3-T9 upstream PRs; M4-T7 keybindings and trust views.

## Recently done

- Wave 2 integration — the panel system (MP-T1…T7), M3 subagent tabs, M5 desktop shell, M7 mobile PWA, M8 package support and the D-20 polish, reconciled into one protocol and one shell. Evidence: 591 tests, exit 0.
- D-23…D-27 — dictation is ours, one decision surface, dock columns follow the dock, log sections are stream panels, and the panel system becomes milestone MP.
- Wave 1 (`7841860`, `958bfb1`) — M2-T1..T4, M4-T1..T6, M6-T1..T7, M9-T1..T4, M9-T6. Evidence: 385 tests.
