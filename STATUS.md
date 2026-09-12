# STATUS.md — one screen, always current

Regenerated from `STATUS_DETAILED.md`; detail and history live there.

**Last updated:** 2026-09-12T03:40:00Z · orchestrator-2026-09-11-mcp · HEAD: cb8c84c

**Current focus:** v0.4.0 (MCP servers) and v0.5.0 (fallback chains, file viewer, English dictation, sidebar indicators, slash completion) are public. No work in flight. Next candidates: M13-T117 on `chat-memory-fallback`, the platform proofs that remain open in M2/M5/M7/M8, and the M14 follow-ups noted in `docs/mcp.md` (server logs, other-platform packaged proof).

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
| M15 After the MCP release | done | v0.5.0 public (T1–T6) |
| MX Cross-cutting | in-progress | pinned engine 0.85.0; identity/seam gates |

## Blockers

None. (The 0.3.8 stale release lock was recovered and its checkpoint verified.)

## Next up

1. M13-T117: land `chat-memory-fallback` (7d121ef) in a later release.
2. Broader platform proof for M2/M5 notifications remains.
3. M14 follow-ups from `docs/mcp.md`: per-server stderr logs (upstream listener PR), arm64/macOS/Windows packaged proof on release runners.

## Recently done

- M15-T6: v0.5.0 public, 12 assets, verified (D-223); https://github.com/youssefsiam38/laser/releases/tag/v0.5.0
- M14-T7: v0.4.0 public, 12 assets, verified through digests, provenance and notes (D-223).
- M15-T3: `b29843e`; model fallback chains end to end; worker 625, protocol 101.
- M15-T1: `2e8a485`; file card and viewer; UI 1255.
- M14-T3: `763dd52` + `0bb1a46`; Settings → MCP servers with the live-review fixes; settings suites 116.
- M13-T120: `6d82130`; removed-worktree children reopen in the checkout; resolver + real-engine driver tests, 40/40 worker agent tests.
- M13-T119: `111bf56`; Chat + opens its new session; fake-host test, full UI 1112 green.
- M13-T118: `13c066d`; `--notes` required, tag body carries notes, API-only publication check; 39/39 release tests.
