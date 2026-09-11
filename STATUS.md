# STATUS.md — one screen, always current

Regenerated from `STATUS_DETAILED.md`; detail and history live there.

**Last updated:** 2026-09-12T02:40:00Z · orchestrator-2026-09-11-mcp · HEAD: b29843e

**Current focus:** v0.4.0 (MCP servers) is public. M15 is merged on `main` (`b29843e`: file viewer, English dictation, fallback chains, sidebar indicators, slash completion; `pnpm verify` green, 2473 tests); a live browser review runs before its release.

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
| M14 MCP servers | done | v0.4.0 public (T1–T7) |
| M15 After the MCP release | in-progress | T1/T2/T4/T5 done and merged; T3 merged, live pass pending; T6 release next |
| MX Cross-cutting | in-progress | pinned engine 0.85.0; identity/seam gates |

## Blockers

None. (The 0.3.8 stale release lock was recovered and its checkpoint verified.)

## Next up

1. M15-T6: live review verdict → release notes → the routine release orchestrator.
2. M13-T117: land `chat-memory-fallback` (7d121ef) in a later release.
3. Broader platform proof for M2/M5 notifications remains.

## Recently done

- M14-T7: v0.4.0 public, 12 assets, verified through digests, provenance and notes (D-223).
- M15-T3: `b29843e`; model fallback chains end to end; worker 625, protocol 101.
- M15-T1: `2e8a485`; file card and viewer; UI 1255.
- M14-T5: `e4303b5`; packaged build carries the MCP engine; clean-machine gate opens an MCP session on an empty PATH; desktop 117.
- M14-T3: `763dd52` + `0bb1a46`; Settings → MCP servers with the live-review fixes; settings suites 116.
- M13-T120: `6d82130`; removed-worktree children reopen in the checkout; resolver + real-engine driver tests, 40/40 worker agent tests.
- M13-T119: `111bf56`; Chat + opens its new session; fake-host test, full UI 1112 green.
- M13-T118: `13c066d`; `--notes` required, tag body carries notes, API-only publication check; 39/39 release tests.
