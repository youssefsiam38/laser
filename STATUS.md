# STATUS.md — one screen, always current

**Last updated:** 2026-09-17T12:00:00+03:00 · claude-2026-09-17-a · HEAD: b5b427dd
**Current focus:** 0.7.1 is published: it fixes 0.7.0 refusing every launch (M19-T4). CI now runs as parallel jobs (~2.5 min).

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
| M15 After MCP release | done |
| M16 Conversation experience | in-progress |
| M17 Coding experience | todo |
| M18 Resource containment | done |
| M19 Runtime recovery/update activation | done |
| MX Cross-cutting | in-progress |

**Blockers:** none.
**Next up:** M17 and the open rows in M2/M3/M5/M7/M8/M10/M11/M13/M16/MX; flaky worker MCP cache-contract epoch test.
**Recently done:** M19-T4 Electron preflight hotfix, v0.7.1 (`78b3760d`, release run 35200780236); M18-T8 release-CI correction (host 899 + strict E2E 3×12); M19 audit gaps (`419403dd`); M19-T3 migration recovery (`2b9962db`); M19-T2 generation activation (`d59f74e8`).

Ownership and evidence: `STATUS_DETAILED.md`. Durable recovery reports/WIP backup: `.git/coordination-recovery/`.
