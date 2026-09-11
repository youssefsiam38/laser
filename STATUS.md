# STATUS.md — one screen, always current

Regenerated from `STATUS_DETAILED.md`; detail and history live there.

**Last updated:** 2026-09-12T00:40:00Z · orchestrator-2026-09-11-mcp · HEAD: 0122859

**Current focus:** M14 MCP servers is on `main` (T1–T4 merged: `b6a59e0`, `2b88158`, `763dd52`; whole workspace green). In flight: T5 packaging (worktree) and T6 live Playwright + browser proof; then the MCP release (D-222). M15 alongside on parked branches: T2 dictation, T4/T5 sidebar+slash (fixed and re-fixed to the person's rule), T3 fallback chains (driver step now unblocked), T1 file viewer (started). 0.3.10 post-release review fixes landed (`3347628`, D-223/D-224); child agents no longer raise desktop/phone notifications (`4193ad0`, D-225).

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
| M14 MCP servers | in-progress | T1–T4 merged; T5 packaging and T6 live proof running; ships alone (D-222) |
| M15 After the MCP release | in-progress | T2, T4, T5 fixed on branches; T3 implementing the driver; T1 started; all wait for the M14 tag |
| MX Cross-cutting | in-progress | pinned engine 0.85.0; identity/seam gates |

## Blockers

None. (The 0.3.8 stale release lock was recovered and its checkpoint verified.)

## Next up

1. M14-T5/T6 land → MCP release notes → the routine release orchestrator (D-222).
2. Merge the parked M15 branches in dependency order after the tag; M15 release.
3. M13-T117: land `chat-memory-fallback` (7d121ef) in a later release.

## Recently done

- M14-T4: `2b88158`; MCP rows in the transcript with images, hydration keeps results whole; UI 1191.
- M14-T2: `b6a59e0`; MCP engine, store, inspector, OAuth, import; worker 549, host 227.
- M14-T1: `9ccbf4f`; MCP vocabulary, twelve `mcp/*` methods, catalog with Playwright first; 28 schema tests.
- M13-T121: v0.3.10 public with 12 assets; CI 34631345414, release 34631650985; notes in the tag body and on the release page; checkpoint verified.
- M13-T120: `6d82130`; removed-worktree children reopen in the checkout; resolver + real-engine driver tests, 40/40 worker agent tests.
- M13-T119: `111bf56`; Chat + opens its new session; fake-host test, full UI 1112 green.
- M13-T118: `13c066d`; `--notes` required, tag body carries notes, API-only publication check; 39/39 release tests.
