# STATUS.md — one screen, always current

Regenerated from `STATUS_DETAILED.md`; detail and history live there.

**Last updated:** 2026-09-10T14:47:27Z · stabilization-ledger · HEAD: b046478

**Current focus:** M13 — essential stabilization is frozen, not release-ready. Coupled T89/T92 work remains unmerged at `aba12f7b`; T93 awaits the person’s HLC010 boundary decision. No further implementation, release action or omitted gate is authorized.

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
| M13 Agents Leap | in-progress | accepted staging `adcbd66` is preliminary; T93 blocked on Q-8; full/browser/package gates skipped |
| MX Cross-cutting | in-progress | pinned engine 0.85.0; identity/seam gates |

## Blockers

- M13-T93: HLC010 needs person approval for a dedicated reviewed awaitable extension-generated prompt-admission seam (Q-8); do not disable child goals.
- M13-T94 remains not ready: dependencies are incomplete, current full/browser/package gates were skipped, and release permission is absent.

## Next up

1. M10-T10: prove the in-app updater installation seam.
2. M7-T7: complete QR entry and paired browser transport.
3. MX-T5: accessibility pass.

## Recently done

- M13-T88: 0.3.4 Latest; source CI 34471150534 and release 34471617236 passed; 12 verified assets and native feeds (D-187).
- M13-T87: compact sidebar state; interaction tests and Chromium review (`b11fd3d`, D-186).
- M13-T86: pre-turn agent/thinking choices; draft-safe transitions and 968 UI tests (`b11fd3d`, D-185).
- M13-T85: 0.3.3 published with verified assets/provenance/signed feeds (D-184).
- M13-T84: eager Beam reuse, recording lifecycle and readable disclosures; 957 UI + 215 host tests (D-183).
