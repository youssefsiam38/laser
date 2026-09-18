# STATUS.md — one screen, always current

**Last updated:** 2026-09-18T13:27:05+03:00 · orchestrator-2026-09-18 · HEAD: 1148d7cb
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
**In flight:** T81 correction ownerab179630 closes newer-revision/reachability/concurrent-UAT gaps at8f003578 before single review. Parent clean baseline host940/worker1089 passes. T75 ownerca6637f5 verifies/fixes focus and finishes touch at5a009840; modal scope boundary retained.
**Next up:** verify/integrate T81 and T75; then T82 image hydration and T75 Agents. Parent24-image control passes onT81;25th remains disabled, while live display improves0→24. Hydration research committed18f0dd70. Then T76 final poisoned gate and T79 publication.
**Recently done:** T78 pristine agent choice (`107e5ecc`, worker1089 + real route tests); T70 selectable activity (`e7ad7c34`, UI2472 + matrix); T74 image/text recovery (`b703f3bf`, UI2436 + matrix); T77 goal-tool recovery (`a0a698ee`, 54 focused + real engine); T73 packaged spelling (`d0bbc680`).

**Published:** v0.9.1 (`8183fd04`), verified release checkpoint. 0.9.2 not released. Autonomous completion/commits/push/release authorized; no live restart. Active history outranks ordinary cache shares (D-295). MCP forms remain modal; acceptance follows reachable user paths (D-296).
