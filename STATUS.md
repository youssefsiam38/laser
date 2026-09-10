# STATUS.md — one screen, always current

Regenerated from `STATUS_DETAILED.md`; detail and history live there.

**Last updated:** 2026-09-10T07:13:20+03:00 · codex-2026-09-10-release · HEAD: d382807

**Current focus:** M10-T10 proves the in-app updater installation seam now that stable 0.3.1 and its signed native feeds are published.

## Milestones

| Milestone | State | Note |
| --- | --- | --- |
| M0 Foundation | done | clean public CI verified |
| M1 Local loop | done | assistant-ui runtime |
| MP Panel system | dropped | removed by D-147; the fleet replaced it |
| M2 Many sessions, many projects | in-progress | broader notification platform proof remains |
| M3 Subagent tabs | in-progress | superseded in substance by M13 (D-140); M3-T9 upstream patches are moot |
| M4 Settings and logs | done | settings surfaces complete |
| M5 Desktop shell | in-progress | broader platform proof remains |
| M6 Relay and pairing | done | cryptographic foundations complete |
| M7 Mobile PWA | in-progress | remote control visibly Soon |
| M8 Package support | in-progress | spoken-phrase acceptance remains |
| M9 CLI | done | planned tasks complete |
| M10 Distribution | in-progress | native feeds ship; in-app updater seam remains |
| M11 Theme system | in-progress | cold-start network trace remains |
| M12 Product experience | done | 0.2.13 dispatched |
| M13 Agents Leap | done | stable 0.3.1 published with verified x64/ARM64 assets |
| MX Cross-cutting | in-progress | pinned engine 0.85.0; identity/seam gates |

## Blockers

- None.

## Next up

1. M10-T10: prove the in-app updater installation seam.
2. M2/M5/M7: the broader platform proofs those milestones still owe.
3. M11: complete the cold-start network trace.

## Recently done

- M13-T75: stable 0.3.1 published with verified x64/ARM64 assets, signed checksums, provenance and native feeds (D-174).
- M13-T74: every Beam spark press starts a fresh bubble chat and preserves prior sessions (D-173).
- M13-T73: Laser writes or bundles no skills; it only discovers user and project skills (D-172).
- M13-T72: the default system prompt is Laser-owned and engine-neutral (D-172).
- M13-T71: custom-agent rename preserves defaults, delegation references and existing-session lookup; duplicate names are refused inline (D-171).
