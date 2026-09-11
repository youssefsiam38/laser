# STATUS.md — one screen, always current

Regenerated from `STATUS_DETAILED.md`; detail and history live there.

**Last updated:** 2026-09-11T10:59:45Z · orchestrator · HEAD: 4ef1d11

**Current focus:** v0.3.7 published (T101/T103). T102/T105/T106 merged for next release; T104 in review, T108 implements durable empty sessions; T110 legacy recovery follows.

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
| M13 Agents Leap | in-progress | 0.3.7 published; T102/T105/T106 integrated; T104 review, T108 active |
| MX Cross-cutting | in-progress | pinned engine 0.85.0; identity/seam gates |

## Blockers

T110 waits for T108’s durable-empty transaction contract.

## Next up

1. M13-T99: fix the keystroke-burst crash in composer draft restore (pre-existing, reproducible with the retained CDP loop).
2. M13-T100: Beam bubble overlap at desktop width and the sticky drawer tooltip.
3. M10-T10: prove the in-app updater installation seam.

## Recently done

- M13-T106: `4ef1d11`; modal scrolling/shortviewport correction verified,31 picker tests + responsive evidence; next release.
- M13-T105: `c6f225a`; per-item fleet/context disclosure correction verified,64 tests + browser evidence; next release.
- M13-T109: `350deb6` pushed, sourceCI green; future Claude attribution disabled, historical commits/tags unchanged.
- M13-T102: `2bc89d6`; both review findings fixed, postmerge44worker+30UI/build/typecheck pass; next release.
- M13-T107: v0.3.7 at `8577bef`; source/releaseCI,12 public assets/digests and offline attestation verified.
