# STATUS.md — one screen, always current

**Last updated:** 2026-09-15T02:18:57Z · orchestrator `01a0a030` · HEAD: a256efe
**Current focus:** M18 is rebasing worker, renderer and transport containment onto the completed task/delivery lifetime contracts.

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

**Blockers:** none. RP-2’s unchanged full A safely refuses B on unbounded renderer state; D-257 assigns the clean repeat to M18-T15 after containment.
**Next up:** rebase and implement M18-T4, T5 and T7 on RP-6; wire their typed counters into T3; implement T8.
**Recently done:** M18-T6 task/delivery lifetime (`a256efe`; build/typecheck, pi-extension 168, host 530, browser-check 69); M18-T13 environment policy/browser gate (`a0111f9`); M18-T2 finding (`ad8c188`); M18-T13A authorization (`00db89f`); M18-T12 worker-free reads (`e9e3d8d`).

Ownership and evidence: `STATUS_DETAILED.md`. Durable recovery reports/WIP backup: `.git/coordination-recovery/`.
