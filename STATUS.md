# STATUS.md — one screen, always current

Regenerated from `STATUS_DETAILED.md`; detail and history live there.

**Last updated:** 2026-09-11T09:45:08Z · orchestrator-release-subset · HEAD: 4acae2e (+ release ledger)

**Current focus:** M13-T107 — release0.3.7 with reviewed T101 instruction highlighting and T103 full-span timing only; other changes preserved for the next batch.

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
| M13 Agents Leap | in-progress | T107 release gates; T101/T103 included; other work excluded; 0.3.6 published; T99/T100 follow-ups recorded |
| MX Cross-cutting | in-progress | pinned engine 0.85.0; identity/seam gates |

## Blockers

- M13-T104: implementation waits for M13-T102’s reviewed/integrated transaction interface.

## Next up

1. M13-T99: fix the keystroke-burst crash in composer draft restore (pre-existing, reproducible with the retained CDP loop).
2. M13-T100: Beam bubble overlap at desktop width and the sticky drawer tooltip.
3. M10-T10: prove the in-app updater installation seam.

## Recently done

- M13-T101: highlighted instructions and parser-correct variable inspection (`4acae2e`); review APPROVE, protocol/UI checks and browser proof.
- M13-T103: full-span activity timing (`3bdacf5`), review APPROVE; 34 post-merge tests and live phone/desktop proof.
- M13-T94: 0.3.6 Latest at `dc11c4d`; CI 34571854176 and release 34572122489 passed; 12 verified assets, attestation and feeds (D-194).
- M13-T98: queued-completion ownership on the real engine and the identified packaged worker (`82fe0d5`…`46e6e19`, 14 real-engine tests, packaged 91/91, review + re-review APPROVE).
- M13-T93: extension admission A/C and causal attribution (`db52a6b`, review APPROVE).
