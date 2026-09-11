# STATUS.md — one screen, always current

Regenerated from `STATUS_DETAILED.md`; detail and history live there.

**Last updated:** 2026-09-11T07:30:00Z · claude-2026-09-11-stabilize · HEAD: f47d96b

**Current focus:** M13 — admission (B1/B2) and the M13-T98 queued-completion ownership fix are merged and green on `stabilize/hlc010`; a follow-up lane closes the residual ownership gaps while the first-turn UI lane finishes; then independent review, combined verify, browser and packaged-worker gates before the authorized next patch.

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
| M13 Agents Leap | in-progress | 0.3.5 verified; T89/T93/T98 lanes merged at `f47d96b` (worker 425, UI 1029); ownership-2 lane running; review, verify, browser and packaged gates next; T94 gated |
| MX Cross-cutting | in-progress | pinned engine 0.85.0; identity/seam gates |

## Blockers

- M13-T94: waits on M13-T89/T93/T98 done with independent review, combined `pnpm verify`, browser reruns and the identified packaged-worker restart gate; publication authorized after that (D-194/D-195).
- M13-T90/T91/T95/T96: preserved implementations need their final combined-candidate browser reruns (approval-footer fixture and mic-conflict toast remain explicit partials).

## Next up

1. M13-T93 / M13-T98 / M13-T89 (in progress): land the ownership-2 residuals and the first-turn UI lane, then independent review of the exact combined candidate.
2. M10-T10: prove the in-app updater installation seam.
3. M7-T7: complete QR entry and paired browser transport.

## Recently done

- M13-T97: 0.3.5 Latest at `7a05c79`; CI 34527293821, release 34527657277; native checks and 12 verified assets.
- M13-T88: 0.3.4 Latest with native artifacts and feeds (D-187).
- M13-T87: compact sidebar state and Chromium review (`b11fd3d`, D-186).
- M13-T86: pre-turn choices; draft-safe transitions and 968 UI tests (`b11fd3d`, D-185).
- M13-T85: 0.3.3 verified publication (D-184).
