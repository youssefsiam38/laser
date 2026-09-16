# STATUS.md — one screen, always current

**Last updated:** 2026-09-16T09:51:35+03:00 · orchestrator `01a0a030` · HEAD: fc4e765b
**Current focus:** M18 implements RP-8’s calibrated actor-local pressure policy before the unchanged post-containment baseline.

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
**Next up:** finish/review/integrate RP-8 worker milestone C; implement companion D, host E, renderer F and ceilings G; then run two unchanged full baselines.
**Recently done:** MX-T10 self-contained bundled-runtime verification (`pnpm verify`); M18-T11 immediate paint (`78b22c83`); M18-T18 route authority (`916e30fa`); M18-T16 bounded bodies (`42344a58`); M18-T10 device tail cache (`c7375791`).

Ownership and evidence: `STATUS_DETAILED.md`. Durable recovery reports/WIP backup: `.git/coordination-recovery/`.
