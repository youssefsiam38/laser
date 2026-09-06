# STATUS.md — one screen, always current

Regenerated from `STATUS_DETAILED.md`; detail and history live there.

**Last updated:** 2026-09-06T13:59:14+03:00 · codex-2026-09-06-activity-summary · commit: `6df542a`

**Current focus:** Stable 0.2.1 is published and verified; the next product work
is upstream subagent patches and the remaining in-app updater seam.

## Milestones

| Milestone | State | Note |
| --- | --- | --- |
| M0 Foundation | done | CI passed on a clean public GitHub runner |
| M1 Local loop | done | assistant-ui rebuild included |
| MP Panel system | done | panel contract implemented |
| M2 Many sessions, many projects | in-progress | remaining notification work |
| M3 Subagent tabs | in-progress | live-bus resume and upstream PRs remain |
| M4 Settings and logs | done | all settings surfaces complete |
| M5 Desktop shell | in-progress | remaining platform proof |
| M6 Relay and pairing | done | cryptographic and relay foundations complete |
| M7 Mobile PWA | in-progress | phone remote control remains visibly Soon |
| M8 Package support | in-progress | dictation is ready; final spoken-phrase acceptance remains |
| M9 CLI | done | all planned CLI tasks complete |
| M10 Distribution | in-progress | 0.1.2 native updates shipped; in-app updater remains |
| M11 Theme system | in-progress | cold-start network trace remains |
| M12 0.2.0 product experience | done | 0.2.1 corrects and supersedes the broken 0.2.0 package |
| MX Cross-cutting | in-progress | seam and identity gates green; Pi pin 0.85.0 |

## Blockers

None.

## Next up

1. M3-T9: file the prepared upstream subagent patches.
2. M10-T10: design and prove the in-app updater installation seam.
3. M8-T2: complete the remaining spoken-phrase acceptance proof.

## Recently done

- M12-T36: the fleet separates active and terminal work without breaking run trees.
- M12-T35: native notifications share the session title visible in Laser.
- M12-T34: Markdown code uses full Shiki grammar coverage and Laser-theme scopes.
- M12-T33: the composer footer moved into the Help and shortcuts reference.
- M12-T32: exact timestamps reveal on message-row hover/focus instead of repeating at rest.
