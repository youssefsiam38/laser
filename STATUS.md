# STATUS.md — one screen, always current

Regenerated from `STATUS_DETAILED.md`; detail and history live there.

**Last updated:** 2026-09-11T19:05:00Z · orchestrator-2026-09-11-mcp · HEAD: 9ccbf4f (ledger edits uncommitted on top)

**Current focus:** M14 MCP servers (`docs/mcp.md`, D-221) — engine, Settings page and transcript workers in parallel worktrees; ships alone first (D-222). M15 runs alongside where write sets do not overlap: sidebar/slash fixes, English dictation, fallback-chains design. Parked: T117 on `chat-memory-fallback` (D-219).

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
| M14 MCP servers | in-progress | T1 done; T2/T3/T4 in flight; T5 packaging and T6 live proof next; ships alone (D-222) |
| M15 After the MCP release | in-progress | T2/T4/T5 in worktrees, T3 in design phase; branches wait for the M14 tag; T1 waits for the transcript worker |
| MX Cross-cutting | in-progress | pinned engine 0.85.0; identity/seam gates |

## Blockers

None. (The 0.3.8 stale release lock was recovered and its checkpoint verified.)

## Next up

1. M14-T5: packaged build carries the adapter (after T2 merges).
2. M14-T6: live Playwright proof over stdio and HTTP from the installed app (after T2/T3/T4).
3. M13-T117: land `chat-memory-fallback` (7d121ef) in a later release.

## Recently done

- M14-T1: `9ccbf4f`; MCP vocabulary, twelve `mcp/*` methods, catalog with Playwright first; 28 schema tests.
- M13-T121: v0.3.10 public with 12 assets; CI 34631345414, release 34631650985; notes in the tag body and on the release page; checkpoint verified.
- M13-T120: `6d82130`; removed-worktree children reopen in the checkout; resolver + real-engine driver tests, 40/40 worker agent tests.
- M13-T119: `111bf56`; Chat + opens its new session; fake-host test, full UI 1112 green.
- M13-T118: `13c066d`; `--notes` required, tag body carries notes, API-only publication check; 39/39 release tests.
