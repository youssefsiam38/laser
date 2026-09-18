# STATUS.md — one screen, always current

**Last updated:** 2026-09-18T14:06:36+03:00 · orchestrator-2026-09-18 · HEAD: 9d4ada95
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

**Blockers:** terminal worker-session resumption is unreliable; clean checkpoint transfers preserve progress. No external release blocker.
**In flight:** T81 owner ab179630 implements approved prefix/gap recovery and concurrent UAT before single review; parent baseline host940/worker1089 passes. T75 focus candidate3477dff0 passes parent UI2514+1skip, but touch retarget is independently reproduced: strip jumps MCP→Advanced before click. Continuing owner2af46439 repairs navigation and checks disappearing-opener focus; no second full review.
**Next up:** verify/integrate T81 and T75; then T82 image hydration and T75 Agents. Parent24-image control passes onT81;25th remains disabled, while live display improves0→24. Research committed18f0dd70. Then parent T76 final poisoned gate and T79 publication.
**Recently done:** T78 pristine agent choice (`107e5ecc`, worker1089 + real route tests); T70 selectable activity (`e7ad7c34`, UI2472 + matrix); T74 image/text recovery (`b703f3bf`, UI2436 + matrix); T77 goal-tool recovery (`a0a698ee`, 54 focused + real engine); T73 packaged spelling (`d0bbc680`).

**Published:** v0.9.1 (`8183fd04`), verified release checkpoint. 0.9.2 not released. Autonomous completion/commits/push/release authorized; no live restart. Active history outranks ordinary cache shares (D-295). MCP forms remain modal; acceptance follows reachable user paths (D-296).
