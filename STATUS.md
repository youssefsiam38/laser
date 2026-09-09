# STATUS.md — one screen, always current

Regenerated from `STATUS_DETAILED.md`; detail and history live there.

**Last updated:** 2026-09-09T11:40:00+03:00 · claude-2026-09-09-agents · HEAD: 4f5081b

**Current focus:** M13 Agents Leap is in and every requested change since has landed: a Chat session moves to a project (D-164), the agent reads the fleet the person sees through one `inspect_fleet` (D-163), a background command's exit wakes the model (D-162), Namer labels every top-level call and no child's (D-165), the elements inventory is true again, and the empty Logs section has a writer. Two follow-ups from the audit remain: the fleet's command output should be the `terminal-block` element, and seven unmounted element files should go.

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
| M13 Agents Leap | in-progress | T1–T64 done except T60 and T61 (audit follow-ups, todo) |
| MX Cross-cutting | in-progress | pinned engine 0.85.0; identity/seam gates |

## Blockers

- None.

## Next up

1. M13-T60: the fleet's command output body becomes the `terminal-block` element with `follow` and `truncatedHead`.
2. M13-T61: delete the seven element files nothing mounts and mark their inventory rows.
3. M10-T10: prove the in-app updater installation seam.

## Recently done

- M13-T64: Namer labels every tool call of a top-level session at once and none of a child's (D-165; worker 313).
- M13-T62: one `inspect_fleet` returns the fleet column's tree in its own words, pinned against the UI's builder (D-163; worker 313, pi-extension 108).
- M13-T58: "Move to a project…" on a Chat row, with the host-only `pi/session/close` before the atomic rewrite (D-164; host 203, ui 909, browser both widths and themes).
- M13-T37/T38/T59/T63: the elements audit and a true inventory, the dead message retired, the Agents log section, focus after Restore.
- M13-T57: `task_wait` is gone; every background command's exit wakes the model (D-162).
