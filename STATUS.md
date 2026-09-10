# STATUS.md — one screen, always current

Regenerated from `STATUS_DETAILED.md`; detail and history live there.

**Last updated:** 2026-09-10T20:30:22Z · stabilization-ci · HEAD: ebcdcb9

**Current focus:** M13 — repair the failed 0.3.5 source test on an isolated branch, review, then validate. No tag/release exists. HLC-010 implementation is authorized next, separately from the release repair.

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
| M13 Agents Leap | in-progress | T97 source CI/local verify failed; bounded test repair active |
| MX Cross-cutting | in-progress | pinned engine 0.85.0; identity/seam gates |

## Blockers

- M13-T93: HLC-010 still blocks integration; Q-8 scope authorized, sole implementation owner queued after CI repair.
- M13-T97: CI 34525850169 and launcher failed the stale fleet harness assertion; review and fresh gates required.
- M13-T94: its original complete-fix dependencies and full acceptance gates remain incomplete; T97 does not replace them.

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
