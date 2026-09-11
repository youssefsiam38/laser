# STATUS.md — one screen, always current

Regenerated from `STATUS_DETAILED.md`; detail and history live there.

**Last updated:** 2026-09-11T10:40:00Z · claude-2026-09-11-stabilize · HEAD: 46e6e19

**Current focus:** M13 — the stabilization is complete and gated on candidate `46e6e19` (verify, independent review and re-review, packaged-worker restart, browser matrix); M13-T94 integrates it into main, versions 0.3.6, and publishes only after clean exact-SHA CI, the tag and the verified release workflow (D-194).

## Milestones

| Milestone | State | Note |
| --- | --- | --- |
| M0 Foundation | done | clean public CI verified |
| M1 Local loop | done | assistant-ui runtime |
| MP Panel system | dropped | removed by D-147; the fleet replaced it |
| M2 Many sessions, many projects | in-progress | broader notification platform proof remains |
| M3 Subagent tabs | in-progress | superseded in substance by M13; upstream patches moot |
| M4 Settings and logs | done | settings surfaces complete |
| M5 Desktop shell | in-progress | broader platform proof remains |
| M6 Relay and pairing | done | cryptographic foundations complete |
| M7 Mobile PWA | in-progress | remote control visibly Soon |
| M8 Package support | in-progress | real-device spoken-phrase acceptance remains |
| M9 CLI | done | planned tasks complete |
| M10 Distribution | in-progress | in-app updater seam remains |
| M11 Theme system | in-progress | cold-start network trace remains |
| M12 Product experience | done | 0.2.13 dispatched |
| M13 Agents Leap | in-progress | T89–T93, T95, T96, T98 done on `46e6e19`; T94 releasing 0.3.6; T99/T100 recorded follow-ups |
| MX Cross-cutting | in-progress | pinned engine 0.85.0; identity/seam gates |

## Blockers

- None. M13-T94 is in progress: integration, exact-SHA CI, tag and verified publication.

## Next up

1. M13-T94 (in progress): merge `stabilize/hlc010` into main, version 0.3.6, push, wait for clean CI on the exact SHA, tag, verify the published assets.
2. M13-T99: fix the keystroke-burst crash in composer draft restore (pre-existing).
3. M10-T10: prove the in-app updater installation seam.

## Recently done

- M13-T98: queued-completion ownership on the real engine and the identified packaged worker (`82fe0d5`…`46e6e19`, 14 real-engine tests, packaged 91/91, review + re-review APPROVE).
- M13-T93: extension admission A/C and causal attribution (`db52a6b`, review APPROVE).
- M13-T89: refused first send keeps the draft and choice; leaving drops only the choice (`c42524a`, browser repro exit 0).
- M13-T96: terminal blocked is neutral finished work across fleet, sidebar, docs and `inspect_fleet` (`d694b07`, `05bec99`, `e165e7c`, `627aaef`).
- M13-T92: truthful pending delivery with hidden-return hydration (`e1c24c7`, browser gate 4).
