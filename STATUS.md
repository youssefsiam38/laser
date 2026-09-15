# STATUS.md — one screen, always current

**Last updated:** 2026-09-15T23:35:42+03:00 · orchestrator `01a0a030` · HEAD: 52e9d715
**Current focus:** M18 RP-5b is closing its remaining large-body interaction gaps; the RP-4 route-authority correction follows before pressure policy and the unchanged baseline.

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
| M18 Resource containment | in-progress |
| MX Cross-cutting | in-progress |

**Blockers:** M18-T15 waits for RP-5b, RP-8 and M18-T18; two unchanged full runs exposed T18’s action-versus-safe-unload race without weakening the fixture.
**Next up:** finish RP-5b; implement M18-T18 route authority; implement RP-8; implement RP-11; close RP-3; run unchanged full A/B.
**Recently done:** M18-T10 device tail cache (`c7375791`); T17 naming-pin correction (`890e6a86`); T15 harness readiness (`cec6c07a`, `2430622b`); T7 transport pressure (`0542a58e`); T3 counter checkpoint (`4ba58bd4`).

Ownership and evidence: `STATUS_DETAILED.md`. Durable recovery reports/WIP backup: `.git/coordination-recovery/`.
