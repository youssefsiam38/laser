# STATUS.md — one screen, always current

**Last updated:** 2026-09-20T19:45:00+03:00 · orchestrator-2026-09-20-config-root · HEAD: d92c5f6b
**Current focus:** 0.11.1 is published and Latest, with the person's own verification behind it. M19-T6 T6B is the next build work.

| Milestone | State |
| --- | --- |
| M0 Foundation | done |
| M1 Local loop | done |
| MP Panel system | done |
| M2 Many sessions | in-progress |
| M3 Subagent tabs | in-progress |
| M4 Settings and logs | done |
| M5 Desktop shell | in-progress |
| M6 Relay and pairing | done |
| M7 Mobile PWA | in-progress |
| M8 Package support | in-progress |
| M9 CLI | done |
| M10 Distribution | in-progress |
| M11 Theme system | in-progress |
| M12 Product experience | done |
| M13 Agents Leap | in-progress |
| M14 MCP servers | done |
| M15 After MCP release | in-progress |
| M16 Conversation experience | in-progress |
| M17 Coding experience | todo |
| M18 Resource containment | done |
| M19 Runtime recovery/update activation | in-progress |
| M20 Source-control leap | in-progress |
| M21 Project lifecycle leap | in-progress |
| MX Cross-cutting | in-progress |

**Blockers:** M19-T7 source work waits for M19-T6 to release shared `LaserPaths` and migration-storage ownership. M21 remains dependency-gated on the person's M20 sandbox acceptance.
**In flight:** nothing building. M16-T97 and M16-T99 are merged and waiting on the person's browser acceptance (D-342: agents run no browser checks; the person tests the sandbox).
**Published:** v0.10.1 is Latest (`09d68d51` candidate; 12 verified assets).
**Next up:** M19-T6 T6B launcher/daemon/desktop binding; the UI half of M16-T98 once the window's contract is final; M19-T7 staging once the launch spine is released (D-339).
**Recently done:** 0.11.1 — the whole-conversation read is gone and three transcript defects with it (`3eba514b`, `259f390f`); M16-T97 transcript paging and M16-T99 the local landing (`d92c5f6b`); the Changes overlay's diff and nested regions scroll (`a264e1ba`); M19-T6 T6A retained runtime store (`40177a72`); M16-T98 producer `{ versionsOf }` window with the host's live validator (`242c7b94`).
