# STATUS.md — one screen, always current

Regenerated from `STATUS_DETAILED.md`; detail and history live there.

**Last updated:** 2026-09-10T12:19:21Z · draft-agent-selection · HEAD: 05a40f0

**Current focus:** M13 — correct 0.3.4 regressions in tentative agent binding, composer/header state, pending delivery and harness lifecycle before the next patch.

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
| M13 Agents Leap | in-progress | M13-T89 blocked; T90–T93 owned; T94 waits for all fixes |
| MX Cross-cutting | in-progress | pinned engine 0.85.0; identity/seam gates |

## Blockers

- M13-T89: needs serialized handoff after M13-T92 releases reserved worker driver/server files, then ownership expansion to bind a tentative agent to the same unstarted session inside its first prompt.

## Next up

1. M13-T90: align composer controls and recording affordance.
2. M13-T91: show only persisted agent attribution beside the model after start.
3. M13-T92: clear stale Sending now after hidden-session queue delivery.

## Recently done

- M13-T88: 0.3.4 Latest; source CI 34471150534 and release 34471617236 passed; 12 verified assets and native feeds (D-187).
- M13-T87: compact sidebar state; interaction tests and Chromium review (`b11fd3d`, D-186).
- M13-T86: pre-turn agent/thinking choices; draft-safe transitions and 968 UI tests (`b11fd3d`, D-185).
- M13-T85: 0.3.3 published with verified assets/provenance/signed feeds (D-184).
- M13-T84: eager Beam reuse, recording lifecycle and readable disclosures; 957 UI + 215 host tests (D-183).
