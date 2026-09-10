# STATUS.md — one screen, always current

Regenerated from `STATUS_DETAILED.md`; detail and history live there.

**Last updated:** 2026-09-10T09:08:00Z · beam-release-033 · HEAD: 299f8e1

**Current focus:** M13-T85 — preparing stable 0.3.3 with the saved-session/internal-project and composer fixes; publication pending verification.

## Milestones

| Milestone | State | Note |
| --- | --- | --- |
| M0 Foundation | done | clean public CI verified |
| M1 Local loop | done | assistant-ui runtime |
| MP Panel system | dropped | removed by D-147; the fleet replaced it |
| M2 Many sessions, many projects | in-progress | broader notification platform proof remains |
| M3 Subagent tabs | in-progress | superseded in substance by M13; M3-T9 upstream patches are moot |
| M4 Settings and logs | done | settings surfaces complete |
| M5 Desktop shell | in-progress | broader platform proof remains |
| M6 Relay and pairing | done | cryptographic foundations complete |
| M7 Mobile PWA | in-progress | remote control visibly Soon |
| M8 Package support | in-progress | real-device spoken-phrase acceptance remains |
| M9 CLI | done | planned tasks complete |
| M10 Distribution | in-progress | in-app updater seam remains |
| M11 Theme system | in-progress | cold-start network trace remains |
| M12 Product experience | done | 0.2.13 dispatched |
| M13 Agents Leap | in-progress | M13-T85 release; latest published version is 0.3.2 |
| MX Cross-cutting | in-progress | pinned engine 0.85.0; identity/seam gates |

## Blockers

- No blocked task. Unrelated scratch files remain outside the release; the exact release tree will be checked in an isolated checkout.

## Next up

1. M13-T85: verify 0.3.3, push source, wait for CI, then publish through the release workflow.
2. M10-T10: prove the in-app updater installation seam.
3. M7-T7: complete QR entry and paired browser transport.

## Recently done

- M13-T84: eager Beam/sidebar reuse, recording lifecycle and readable composer/disclosures; 957 UI and 215 host tests, workspace typechecks, builds and dark/light mouse/touch browser review passed.
- M13-T83: worker cwd, strict saved-session loading and internal-project boundaries; 1,464 host/worker/UI tests, workspace typechecks and affected builds passed.
- M13-T82: stable 0.3.2 published with verified x64/ARM64 assets and native feeds (D-181).
- M13-T81: automatic provider retries are silent; only final failure warns.
- M13-T80: Chat and Code restore their own last viewed conversation.
