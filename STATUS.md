# STATUS.md — one screen, always current

**Last updated:** 2026-09-16T05:05:09+03:00 · orchestrator `01a0a030` · HEAD: 916e30fa
**Current focus:** M18 reviews RP-11 immediate paint, then implements RP-8 pressure policy before the unchanged post-containment baseline.

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

**Blockers:** M18-T15 waits for RP-8 pressure policy and RP-3 closeout; RP-4c’s action-versus-unload race is fixed and proved.
**Next up:** complete RP-11 review; implement RP-8 from `/tmp/m18-t8-final-plan.md`; close RP-3; run two unchanged full clean baselines; execute RP-14.
**Recently done:** M18-T18 route authority (`916e30fa`); M18-T16 bounded bodies (`42344a58`); M18-T10 device tail cache (`c7375791`); T17 naming-pin correction (`890e6a86`); T15 harness readiness (`cec6c07a`, `2430622b`).

Ownership and evidence: `STATUS_DETAILED.md`. Durable recovery reports/WIP backup: `.git/coordination-recovery/`.
