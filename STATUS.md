# STATUS.md — one screen, always current

Regenerated from `STATUS_DETAILED.md`; detail and history live there.

**Last updated:** 2026-09-11T10:19:49Z · orchestrator · HEAD: 2bc89d6

**Current focus:** v0.3.7 published with T101/T103 only. T102 merged for next release; T104/T105/T106 continue isolated, T108 investigates empty-session recovery.

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
| M13 Agents Leap | in-progress | 0.3.7 published; T102 integrated; T104–T106 active, T108 investigating |
| MX Cross-cutting | in-progress | pinned engine 0.85.0; identity/seam gates |

## Blockers

None in the active batch. T102 fixes verified; T104/T106 unblocked in isolated worktrees.

## Next up

1. M13-T99: fix the keystroke-burst crash in composer draft restore (pre-existing, reproducible with the retained CDP loop).
2. M13-T100: Beam bubble overlap at desktop width and the sticky drawer tooltip.
3. M10-T10: prove the in-app updater installation seam.

## Recently done

- M13-T102: integrated `2bc89d6`; both review findings fixed, postmerge44worker+30UI/build/typecheck pass; next release only.
- M13-T107: v0.3.7 Latest at `8577bef`; source/release CI green,12 public assets/digests and offline attestation verified.
- M13-T101: highlighted instructions and variable inspection (`4acae2e`); review, tests and responsive browser proof.
- M13-T103: full-span activity timing (`3bdacf5`); review,34 focused tests and live responsive proof.
- M13-T94: v0.3.6 at `dc11c4d`; CI/release/assets/feeds verified (D-194).
