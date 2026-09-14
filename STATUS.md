# STATUS.md — one screen, always current

**Last updated:** 2026-09-14T20:33:08Z · orchestrator `01a0a030` · HEAD: 00db89f
**Current focus:** M18 is correcting the full-scale resource measurement harness while completing environment-scoped client storage.

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

**Blockers:** none. RP-2 full A found perturbing memory instrumentation/heap-parser limits and correctly gated B; bounded harness corrections are active. RP-13A is integrated; client/storage milestone B is planning.
**Next up:** finish M18-T2 full A/B evidence; implement/review RP-13B; then start M18-T4/T5/T6/T7 from measurements and complete M18-T3’s counters/browser matrix.
**Recently done:** M18-T13A host authorization (`00db89f`; protocol 184, host 507, CLI 74); M18-T12 worker-free reads (`e9e3d8d`); M18-T9 durable revisions (`dd637f3`); M18-T3 reviewed UI checkpoint (`8b5a269`); M18-T1 process inventory (`1628349`).

Ownership and evidence: `STATUS_DETAILED.md`. Durable recovery reports/WIP backup: `.git/coordination-recovery/`.
