# STATUS.md — one screen, always current

Regenerated from `STATUS_DETAILED.md`; detail and history live there.

**Last updated:** 2026-09-11T14:57:48Z · orchestrator · HEAD: cba19f2

**Current focus:** user-requested one-command release automation (T114), then use it to publish0.3.8 (T113). Version-only candidate is ready. T110 remains dropped; one-time script supplied; installed processes untouched.

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
| M13 Agents Leap | in-progress | source green; T110 dropped; T114 automation then T113 publication |
| MX Cross-cutting | in-progress | pinned engine 0.85.0; identity/seam gates |

## Blockers

Publication waits for tested/reviewed release automation and final versioned CI/installer gates.

## Next up

1. Approve and implement T114 release orchestrator/AGENTS guidance.
2. Review combined0.3.8 candidate and verify corrections.
3. Run the new release command; verify both architectures and public provenance.

## Recently done

- M13-T111: `8650d89`; typed destination controller, all routing review fixes, 78 focused tests, combined full verify and CI `34611182930` passed.
- M13-T108: `7a37677`; durable empties, 102 focused tests, full verify and CI `34603076800` passed.
- M13-T112: `af96144`; both collapsed count levels, 390px proof, full verify and CI `34602657563` passed.
- M13-T104: `34da454`; interruption ownership fixes, 204 focused tests, full verify and CI `34595968503` passed.
- M13-T106: `4ef1d11`; model-picker scrolling/short-viewport correction, 31 tests and browser evidence.
