# STATUS.md — one screen, always current

**Last updated:** 2026-09-18T15:14:50+03:00 · orchestrator-2026-09-18 · HEAD: fe2f9a80
**Current focus:** M16 — finish active-history acceptance, exact Agents scope and image accessibility before 0.9.2.

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

**Blockers:** terminal worker-session resumption is unreliable; explicit clean transfers preserve progress. No external release blocker.
**In flight:** T81 owner ab179630 preserves prefix/gap fixes and corrects repeated virtualized-root test failures without dropping touch acceptance; single review still pending. T75 Agents owner cab71ab9 implements approved D-297 location/scope/draft contracts, independently of history.
**Accepted integration:** Settings services4293a91e + portable UATfe2f9a80. Postmerge UI2518+1skip, host15, protocol41, worker32, build/types/identity pass. Loaded-content pointer/touch matrices8/8 pass, including actual Effective inspector; six merged predecessor trees removed.
**Next up:** review/integrate T81, then T82 images; finish/review Agents. The 24-image control passes on T81, but image25 stays disabled. Then parent T76 final poisoned gate and T79 publication.
**Recently done:** T78 pristine agent choice (`107e5ecc`); T70 selectable activity (`e7ad7c34`); T74 image/text recovery (`b703f3bf`); T77 goal-tool recovery (`a0a698ee`); T73 packaged spelling (`d0bbc680`). Evidence in detailed ledger.

**Published:** v0.9.1 (`8183fd04`), verified release checkpoint. 0.9.2 not released. Autonomous completion/commits/push/release authorized; no live restart. Active history outranks soft cache targets (D-295); MCP forms stay modal (D-296); Agents mutations identify their location (D-297).
