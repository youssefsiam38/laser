# STATUS.md — one screen, always current

Regenerated from `STATUS_DETAILED.md`; detail and history live there.

**Last updated:** 2026-09-10T09:11:00+03:00 · codex-2026-09-10-prompt-namer · HEAD: aa3c28e

**Current focus:** M13 agent refinements are complete; remaining work is platform and distribution proof.

## Milestones

| Milestone | State | Note |
| --- | --- | --- |
| M0 Foundation | done | clean public CI verified |
| M1 Local loop | done | assistant-ui runtime |
| MP Panel system | dropped | removed by D-147; the fleet replaced it |
| M2 Many sessions, many projects | in-progress | worker recovery fixed; broader notification platform proof remains |
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
| M13 Agents Leap | done | instruction templates, Namer, private workspaces and session navigation verified |
| MX Cross-cutting | in-progress | pinned engine 0.85.0; identity/seam gates |

## Blockers

- None.

## Next up

1. M10-T10: prove the in-app updater installation seam.
2. M7-T7: complete QR entry and paired browser transport.
3. M3-T9: decide whether the superseded upstream patches should be filed or dropped.

## Recently done

- M13-T81: automatic provider retries are silent; only the final blocked request warns.
- M13-T80: Chat and Code restore their own last viewed conversation.
- M13-T79: every Beam and Chat session owns a private persistent workspace.
- M13-T78: maximizing Beam opens its conversation under Code.
- M13-T77: Namer qualifies real candidates and keeps the strongest usable model.
