# STATUS.md — one screen, always current

**Last updated:** 2026-09-18T12:45:31+03:00 · orchestrator-2026-09-18 · HEAD: d44226f5
**Current focus:** M16 — independent user acceptance and active-chat continuity first; finish agreed repairs before 0.9.2.

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
| M18 Resource containment | done |
| M19 Runtime recovery/update activation | done |
| MX Cross-cutting | in-progress |

**Blockers:** terminal worker-session resumption is unreliable; explicit checkpoint transfers preserve progress. No external release blocker.
**In flight:** T81 owner4e5b5b3c implements active retention/bounded paging. T82 parent UAT: one-image passes;25-image fails even after settlement/reload. Online hydration research recorded. T75 candidate5a009840 passed parent316 focused tests; independent user journeys db51b319 run before integration; Agents still pending.
**Next up:** T81 causal repair/UAT; T82 recoverable image hydration and permitted disk-cache plan; T75 Agents after service integration. Then T76 final poisoned gate and T79 publication.
**Recently done:** T78 pristine agent choice (`107e5ecc`, worker1089 + real route tests); T70 selectable activity (`e7ad7c34`, UI2472 + matrix); T74 image/text recovery (`b703f3bf`, UI2436 + matrix); T77 goal-tool recovery (`a0a698ee`, 54 focused + real engine); T73 packaged spelling (`d0bbc680`).

**Published:** v0.9.1 (`8183fd04`), verified release checkpoint. 0.9.2 not released. Autonomous completion/commits/push/release authorized; no live restart. Active logical history outranks ordinary cache shares (D-295); safety, identity and privacy remain mandatory.
