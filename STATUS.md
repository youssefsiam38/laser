# STATUS.md — one screen, always current

Regenerated from `STATUS_DETAILED.md`; detail and history live there.

**Last updated:** 2026-09-06T15:06:53+03:00 · codex-2026-09-06-release-024 · commit: `1a83b3e`

**Current focus:** The verified adaptive-session controls are being published as
stable 0.2.4; Answers only is explicitly regression-tested as the default.

## Milestones

| Milestone | State | Note |
| --- | --- | --- |
| M0 Foundation | done | CI passed on a clean public GitHub runner |
| M1 Local loop | done | assistant-ui rebuild included |
| MP Panel system | done | panel contract implemented |
| M2 Many sessions, many projects | in-progress | remaining platform notification proof |
| M3 Subagent tabs | in-progress | live-bus resume and upstream PRs remain |
| M4 Settings and logs | done | all settings surfaces complete |
| M5 Desktop shell | in-progress | remaining platform proof |
| M6 Relay and pairing | done | cryptographic and relay foundations complete |
| M7 Mobile PWA | in-progress | phone remote control remains visibly Soon |
| M8 Package support | in-progress | dictation is ready; final spoken-phrase acceptance remains |
| M9 CLI | done | all planned CLI tasks complete |
| M10 Distribution | in-progress | native feeds ship; in-app updater seam remains |
| M11 Theme system | in-progress | cold-start network trace remains |
| M12 Product experience | in-progress | stable 0.2.4 source verified; release pipeline next |
| MX Cross-cutting | in-progress | seam and identity gates green; Pi pin 0.85.0 |

## Blockers

None.

## Next up

1. M12-T43: publish and verify stable 0.2.4.
2. M3-T9: file the prepared upstream subagent patches.
3. M10-T10: design and prove the in-app updater installation seam.

## Recently done

- M12-T42: model pickers reopen at the session's active provider and model.
- M12-T41: each session has three consistent activity-detail levels.
- M12-T40: usage adapts across API, account and mixed billing, including subagents.
- M12-T39: stable 0.2.3 published with both architectures and native update feeds.
- M12-T38: reasoning and tools share one live, muted activity disclosure.
