# STATUS.md — one screen, always current

**Last updated:** 2026-09-18T11:43:08+03:00 · orchestrator-2026-09-18 · HEAD: 1920e760
**Current focus:** M16 — finish every agreed repair before publishing 0.9.2; 0.9.1 is public and verified.

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

**Blockers:** worker-session resumption is unreliable; explicit checkpoint transfers preserve progress. No external release blocker.
**In flight:** T81 urgent live earlier-history loss investigation (records intact); disjoint T75 Settings corrections/package/browser evidence continue. Agents follows; T76 final poisoned gate pending.
**Next up:** T81 causal regression/fix; T75 Agents/location-safe edits after services; T79 complete-batch verification and 0.9.2 publication.
**Recently done:** T78 pristine agent choice (`107e5ecc`, worker1089 + real route tests); T70 selectable activity (`e7ad7c34`, UI2472 + matrix); T74 image/text recovery (`b703f3bf`, UI2436 + matrix); T77 goal-tool recovery (`a0a698ee`, 54 focused + real engine); T73 packaged spelling (`d0bbc680`).

**Published:** v0.9.1 (`8183fd04`), `.git/lasercode-release/v0.9.1.json` verified. User authorized autonomous completion, commits, push and next release; no live app restart is authorized by the release itself.
