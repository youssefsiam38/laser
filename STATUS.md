# STATUS.md — one screen, always current

Regenerated from `STATUS_DETAILED.md`; detail and history live there.

**Last updated:** 2026-09-09T12:30:00+03:00 · claude-2026-09-09-agents · HEAD: bc242aa

**Current focus:** M13 Agents Leap is in, and every change the user asked for since has landed, the last three being a fork listed as its own session rather than under its origin (D-166), the fleet's command output drawn through the terminal element, and the seven unmounted element files removed. No M13 row is open.

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
| M13 Agents Leap | done | T1–T65 done or dropped; the leap is in |
| MX Cross-cutting | in-progress | pinned engine 0.85.0; identity/seam gates |

## Blockers

- None.

## Next up

1. M10-T10: prove the in-app updater installation seam.
2. M2/M5/M7: the broader platform proofs those milestones still owe.
3. M11-T5: the cold-start network trace for font loading.

## Recently done

- M13-T65: a fork is a top-level session beside its origin; `forkedFrom` is lineage, `parentPath` is agents only (D-166; host 203, ui 924).
- M13-T60: the fleet's task detail is the `terminal-block` element with `follow`, `truncatedHead` and `ansi` (ui 924, browser both widths and themes).
- M13-T61: seven unmounted element files deleted after proof; inventory rows marked.
- M13-T64: Namer labels every top-level call at once and no child's (D-165).
- M13-T62: one `inspect_fleet` returns the fleet column's tree in its own words (D-163).
