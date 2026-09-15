# STATUS.md — one screen, always current

**Last updated:** 2026-09-15T14:15:41+03:00 · orchestrator `01a0a030` · HEAD: 5a2fe5a9
**Current focus:** M18 RP-10 is implementing its independent-review correction batch; RP-5b, pressure policy, immediate reconciliation, the unchanged full baseline and shell gate follow in dependency order.

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

**Blockers:** none. RP-2’s pre-containment full A safely refused B at the fixed renderer ceiling; the reviewed unchanged quick now passes all nine scenarios with zero survivors.
**Next up:** integrate T10; implement RP-5b and T8; implement T11; close T3; run unchanged full A/B; execute RP-14.
**Recently done:** M18-T17 naming-pin correction (`890e6a86`; worker 45 + host E2E 4 + host 636); T15 harness readiness (`cec6c07a`, `2430622b`; browser-check 96 + nine-scenario quick); M18-T7 transport pressure (`0542a58e`); T3 counter checkpoint (`4ba58bd4`); M18-T5 renderer lifetime (`4f34a614`).

Ownership and evidence: `STATUS_DETAILED.md`. Durable recovery reports/WIP backup: `.git/coordination-recovery/`.
