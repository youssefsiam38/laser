# STATUS.md — one screen, always current

**Last updated:** 2026-09-15T07:09:48Z · orchestrator `01a0a030` · HEAD: 477d7b8e
**Current focus:** M18 has bounded worker and renderer session lifetimes; transport pressure is closing its final verified producer/count/storage/footprint batch before T3, T8 and T10 consume the settled seams.

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

**Blockers:** none. RP-2’s unchanged full A safely refuses B on the pre-containment renderer ceiling; D-257 assigns the clean repeat to M18-T15 after RP-7/RP-8.
**Next up:** integrate corrected M18-T7; start approved T8 and T10 on that base; wire T4/T5/T7/T8 typed diagnostics into T3; implement T11.
**Recently done:** M18-T5 renderer lifetime (`4f34a614`; reviewed focused/full/UI/browser/calibration gates); M18-T4 worker lifetime (`eb18e147`); M18-T6 task/delivery lifetime (`a256efe`); M18-T13 browser gate (`a0111f9`); M18-T2 finding (`ad8c188`).

Ownership and evidence: `STATUS_DETAILED.md`. Durable recovery reports/WIP backup: `.git/coordination-recovery/`.
