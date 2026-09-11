# STATUS.md — one screen, always current

Regenerated from `STATUS_DETAILED.md`; detail and history live there.

**Last updated:** 2026-09-12T01:30:00Z · orchestrator-2026-09-11-mcp · HEAD: 0bb1a46

**Current focus:** M14 MCP servers is complete on `main` except the live re-acceptance: T1–T5 merged, the nine live-proof defects fixed and merged (`c139445`, `0bb1a46`), packaged gate re-proven with `npx` from the bundled runtime. Next: one live re-check of the fixed flows (default gallery add, dialogs, Tools switches) and the OAuth browser flow, then the MCP release (D-222). M15 parked on branches: T2 dictation, T4/T5 sidebar+slash, T1 file viewer (review pending), T3 fallback chains (blocker batch in flight).

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
| M14 MCP servers | in-progress | T1–T5 merged; T6 defects fixed; live re-check + OAuth proof, then release (D-222) |
| M15 After the MCP release | in-progress | T1/T2/T4/T5 done on branches (T1 review pending); T3 fixing review blockers; all wait for the M14 tag |
| MX Cross-cutting | in-progress | pinned engine 0.85.0; identity/seam gates |

## Blockers

None. (The 0.3.8 stale release lock was recovered and its checkpoint verified.)

## Next up

1. M14-T6 live re-check of the fixed flows + OAuth browser proof → MCP release notes → the routine release orchestrator (D-222).
2. Merge the parked M15 branches in dependency order after the tag; M15 release.
3. M13-T117: land `chat-memory-fallback` (7d121ef) in a later release.

## Recently done

- M14-T5: `e4303b5`; packaged build carries the MCP engine; clean-machine gate opens an MCP session on an empty PATH; desktop 117.
- M14-T3: `763dd52` + `0bb1a46`; Settings → MCP servers with the live-review fixes; settings suites 116.
- M14-T4: `2b88158`; MCP rows in the transcript with images, hydration keeps results whole; UI 1191.
- M14-T2: `b6a59e0`; MCP engine, store, inspector, OAuth, import; worker 549, host 227.
- M14-T1: `9ccbf4f`; MCP vocabulary, twelve `mcp/*` methods, catalog with Playwright first; 28 schema tests.
- M13-T120: `6d82130`; removed-worktree children reopen in the checkout; resolver + real-engine driver tests, 40/40 worker agent tests.
- M13-T119: `111bf56`; Chat + opens its new session; fake-host test, full UI 1112 green.
- M13-T118: `13c066d`; `--notes` required, tag body carries notes, API-only publication check; 39/39 release tests.
