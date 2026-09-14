# STATUS.md — one screen, always current

**Last updated:** 2026-09-14T22:42:40Z · orchestrator `01a0a030` · HEAD: 1e4eeba
**Current focus:** M18 is implementing bounded task/delivery lifetime while worker, renderer and transport owners prepare the measured containment slices.

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
**Next up:** implement/review M18-T6; approve T5/T7 plans; rebase and implement T4 after T6; run the shared T3/T13 browser acceptance matrix.
**Recently done:** RP-13B client/storage isolation (`1e4eeba`; UI 1,782, protocol 184, CLI 74, desktop 160); M18-T2 finding (`ad8c188`; browser-check 67); M18-T13A authorization (`00db89f`); M18-T12 worker-free reads (`e9e3d8d`); M18-T9 revisions (`dd637f3`).

Ownership and evidence: `STATUS_DETAILED.md`. Durable recovery reports/WIP backup: `.git/coordination-recovery/`.
