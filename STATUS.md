# STATUS.md — one screen, always current

Regenerated from `STATUS_DETAILED.md`; detail and history live there.

**Last updated:** 2026-09-06T12:27:11+03:00 · codex-2026-09-06-release-v020 · commit: `a3cc474`

**Current focus:** Stable 0.2.0 is published and verified. Remaining work returns
to upstream subagent patches, the in-app updater seam and accessibility.

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
| M12 0.2.0 product experience | done | stable Latest release published for x64 and ARM64 |
| MX Cross-cutting | in-progress | seam and identity gates green; Pi pin 0.85.0 |

## Blockers

None.

## Next up

1. M3-T9: file the prepared upstream subagent patches.
2. M10-T10: design and prove the in-app updater installation seam.
3. MX-T5: complete the accessibility pass.

## Recently done

- M12-T5: stable 0.2.0 is Latest; both architectures, clean install, provenance and update feeds passed.
- M12-T25: startup restoration uses transparent branding and smoothly absorbed beam arcs.
- M12-T24: provider icons and tags identify the configured billing/API provider.
- M12-T23: Add Project is a native folder-selection action with no path field.
- M12-T22: leading slash completion preserves every later character.
