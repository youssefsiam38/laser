# STATUS.md — one screen, always current

Regenerated from `STATUS_DETAILED.md`; detail and history live there.

**Last updated:** 2026-09-11T13:27:15Z · orchestrator · HEAD: 726911e

**Current focus:** finish this batch and release 0.3.8 (authorized). T111 review corrections → T110 legacy recovery → T113 final release gates. v0.3.7 and installed processes remain unchanged.

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
| M13 Agents Leap | in-progress | T108/T112 green; T111 correcting; T110 then authorized T113 release |
| MX Cross-cutting | in-progress | pinned engine 0.85.0; identity/seam gates |

## Blockers

T110 legacy draft recovery waits for reviewed/integrated T111 destination ownership; T108 is done.

## Next up

1. Approve T111 controller correction plan, verify fixes and integrate.
2. Implement T110 against integrated T108/T111.
3. T113: freeze the batch, run final CI/installer gates, publish verified 0.3.8.

## Recently done

- M13-T108: `7a37677`; genuine durable empties, transactional rollback and reconnect-safe questions; 102 focused tests, combined full verify and CI `34603076800` passed.
- M13-T112: `af96144`; both collapsed count levels, 390px proof, full verify and source CI `34602657563` passed.
- M13-T104: `34da454`; interruption ownership fixes, 204 focused tests, full verify and CI `34595968503` passed.
- M13-T106: `4ef1d11`; modal picker scrolling/short-viewport correction, 31 tests and responsive evidence.
- M13-T105: `c6f225a`; per-item Finished partition/disclosure correction, 64 tests and browser evidence.
