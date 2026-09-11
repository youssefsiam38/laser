# STATUS.md — one screen, always current

Regenerated from `STATUS_DETAILED.md`; detail and history live there.

**Last updated:** 2026-09-11T18:25:00Z · claude-2026-09-11-trust · HEAD: 8ad8dca (ledger commit on top)

**Current focus:** v0.3.10 is public (Chat + navigation, removed-worktree children reopen, release notes required with an API-only publication check; T118–T121). v0.3.9 carried the startup trust fix (T115/T116). Parked: the Chat gone-memory fallback on `chat-memory-fallback` (T117, D-219).

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
| M13 Agents Leap | in-progress | 0.3.10 public (T118–T121); T117 parked |
| MX Cross-cutting | in-progress | pinned engine 0.85.0; identity/seam gates |

## Blockers

None. (The 0.3.8 stale release lock was recovered and its checkpoint verified.)

## Next up

1. M13-T117: land `chat-memory-fallback` (7d121ef) in a later release.
2. T113/T114 0.3.8 final verification: complete (checkpoint verified during the lock recovery); close their rows.
3. Broader platform proof for M2/M5 notifications remains.

## Recently done

- M13-T121: v0.3.10 public with 12 assets; CI 34631345414, release 34631650985; notes in the tag body and on the release page; checkpoint verified.
- M13-T120: `6d82130`; removed-worktree children reopen in the checkout; resolver + real-engine driver tests, 40/40 worker agent tests.
- M13-T119: `111bf56`; Chat + opens its new session; fake-host test, full UI 1112 green.
- M13-T118: `13c066d`; `--notes` required, tag body carries notes, API-only publication check; 39/39 release tests.
- M13-T116: v0.3.9 public with 12 assets; CI 34626252419, release 34626602601, checkpoint verified; installed app restores the last session in ~210 ms (was 120 s).
