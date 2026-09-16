# STATUS.md — one screen, always current

**Last updated:** 2026-09-16T16:47:13+03:00 · heap-ceilings-plan `01a0aa00` · HEAD: 0a5d0b09
**Current focus:** M18 has a G3 packaged/containment candidate; RP-8 verification and closeout unblock the repeat baseline.

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
| M19 Runtime recovery/update activation | todo |
| MX Cross-cutting | in-progress |

**Blockers:** M18-T15 waits for RP-8; M18-T14 waits for T15 and Q-10; M19 waits for M18.
**Next up:** verify/integrate ceilings G3; capability consumption T19b; T3 pressure closeout; then T15 baseline and T14.
**Recently done:** M18-T8 heap ceilings + loss recovery G1/G2 (`4f15add0`); M18-T8 host admission E3 (`49cc12d9`); M18-T8 renderer pressure F (`1b5fbfa7`); M18-T8 host pass E2 (`55350823`); M18-T8 host evidence E1 (`d8ec6cae`).

Ownership and evidence: `STATUS_DETAILED.md`. Durable recovery reports/WIP backup: `.git/coordination-recovery/`.
