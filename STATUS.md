# STATUS.md — one screen, always current

Regenerated from `STATUS_DETAILED.md`; detail and history live there.

**Last updated:** 2026-09-11T16:40:00Z · claude-2026-09-11-trust · HEAD: 6355b78 (T115 fix committed on top)

**Current focus:** 0.3.8 froze on "Returning to your last session" for 120 s whenever the restored session's project had no trust decision: the trust dialog lived inside the shell the startup gate does not mount. Fixed (M13-T115); releasing as 0.3.9 (M13-T116) through the routine orchestrator.

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
| M13 Agents Leap | in-progress | T115 startup trust fix done; T116 release 0.3.9 in progress |
| MX Cross-cutting | in-progress | pinned engine 0.85.0; identity/seam gates |

## Blockers

T113/T114 final local verification of 0.3.8: monitor stopped; authorization required to resume the preserved checkpoint.

## Next up

1. M13-T116: run the 0.3.9 release orchestrator from the reviewed T115 source; record public asset verification.
2. Resume the 0.3.8 final local verification once authorized (T113/T114).
3. Verify downloaded 0.3.9 assets and provenance against the tag object.

## Recently done

- M13-T115: trust dialog rides the startup gate above the opening screen; 25 focused UI tests + 18 desktop startup tests; full UI suite 1109 green.
- M13-T111: `8650d89`; typed destination controller, all routing review fixes, 78 focused tests, combined full verify and CI `34611182930` passed.
- M13-T108: `7a37677`; durable empties, 102 focused tests, full verify and CI `34603076800` passed.
- M13-T112: `af96144`; both collapsed count levels, 390px proof, full verify and CI `34602657563` passed.
- M13-T104: `34da454`; interruption ownership fixes, 204 focused tests, full verify and CI `34595968503` passed.
