# STATUS.md — one screen, always current

Regenerated from `STATUS_DETAILED.md`; detail and history live there.

**Last updated:** 2026-09-09T04:15:00+03:00 · claude-2026-09-09-agents · HEAD: pending

**Current focus:** M13 Agents Leap is essentially in. The panel system is gone and the fleet is a permanent column beside the monitor (D-147); a failed action no longer paints the block red (D-148); a queued message waits by default and steering is a verb you press (D-149); the opening screen is one screen (D-150); an `edit` aimed at a file that moved is explained rather than refused (D-151, D-152); editing history moves the leaf instead of forking (D-153); finished work is dimmed, never green (D-154). Remaining M13 rows are the retired pi-subagents file layer, the `.laser` override reload finding, and an upstream React #520.

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
| M13 Agents Leap | in-progress | T1–T37 done; T38 (a dead protocol message) remains |
| MX Cross-cutting | in-progress | pinned engine 0.85.0; identity/seam gates |

## Blockers

- None.

## Next up

1. M13-T38: retire the dead `lasercode/subagents/event` message (protocol inventory is a release gate).
2. M10-T10: prove the in-app updater installation seam.
3. M2/M5/M7: the broader platform proofs those milestones still owe.

## Recently done

- M13-T12: `.laser` overrides never reached any session at all; made durable, and the engine's own behaviour is pinned beside ours (D-155).
- M13-T11: the pi-subagents flag, env, path, host-record field, doctor check and catalogue row are gone; the boundary mentions stay.
- M13-T37: the React #520 on a session's first prompt is gone, through a pinned patch that notifies outside the render phase; verified on a plain chat, the agents scene and a 30 s turn.
- M13-T31: finished work is dimmed in all four places it was green, both folds lost the tick, the fleet gained Clear; 1,510 tests.
- M13-T36: the match is the freshness proof, so an `edit` is explained and never blocked (D-152).
- M13-T35: editing a message or running a reply again changes this session; forking is the second choice (D-153).
- M13-T34: the goal-tools test asserts on the request it sent rather than the last one to arrive.
- M13-T33/T32/T30/T29/T28: the file-freshness module, one opening screen, a task is not an agent, quiet failures, and the steer tray.
