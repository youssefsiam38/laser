# STATUS.md — one screen, always current

Regenerated from `STATUS_DETAILED.md`; detail and history live there.

**Last updated:** 2026-09-11T11:20:00Z · claude-2026-09-11-stabilize · HEAD: dc11c4d (+ this ledger commit)

**Current focus:** M13 — the stabilization patch 0.3.6 is published and verified (D-194); next are the recorded follow-ups M13-T99 (typing-burst crash) and M13-T100 (browser-gate observations), then the remaining milestone proofs.

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
| M13 Agents Leap | in-progress | 0.3.6 published and verified at `dc11c4d`; T99/T100 follow-ups recorded |
| MX Cross-cutting | in-progress | pinned engine 0.85.0; identity/seam gates |

## Blockers

- None.

## Next up

1. M13-T99: fix the keystroke-burst crash in composer draft restore (pre-existing, reproducible with the retained CDP loop).
2. M13-T100: Beam bubble overlap at desktop width and the sticky drawer tooltip.
3. M10-T10: prove the in-app updater installation seam.

## Recently done

- M13-T94: 0.3.6 Latest at `dc11c4d`; CI 34571854176 and release 34572122489 passed; 12 verified assets, attestation and feeds (D-194).
- M13-T98: queued-completion ownership on the real engine and the identified packaged worker (`82fe0d5`…`46e6e19`, 14 real-engine tests, packaged 91/91, review + re-review APPROVE).
- M13-T93: extension admission A/C and causal attribution (`db52a6b`, review APPROVE).
- M13-T89: refused first send keeps the draft and choice; leaving drops only the choice (`c42524a`, browser repro exit 0).
- M13-T96: terminal blocked is neutral finished work across fleet, sidebar, docs and `inspect_fleet` (`d694b07`, `05bec99`, `e165e7c`, `627aaef`).
