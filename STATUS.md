# STATUS.md — one screen, always current

**Last updated:** 2026-09-16T16:47:13+03:00 · orchestrator `01a0a030` · HEAD: merge-m19-t1
**Current focus:** M18 closes RP-3 diagnostics on the finished RP-8 stack, finishes RP-13 capability consumption, then closes the RP-2 repeat baseline (RP-14 dropped, D-268).

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

**Blockers:** M18-T15 — two complete full runs pass all ceilings with zero survivors; repeatability comparison fails on noise-dominated worker ties and 3–5-sample renderer slopes; measurement-validity investigation in flight (no threshold changes).
**Next up:** T15 repeatability + baseline doc; M19-T1 copy fix and integration; then M19-T2/T3.
**Recently done:** M18-T19 capability consumption (`76f475fa`); M18-T3 diagnostics closeout; M18-T8 RP-8 complete (`ce455b99`); G1/G2 (`4f15add0`); host admission E3 (`49cc12d9`).

Ownership and evidence: `STATUS_DETAILED.md`. Durable recovery reports/WIP backup: `.git/coordination-recovery/`.
