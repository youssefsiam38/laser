# STATUS.md — one screen, always current

**Last updated:** 2026-09-18T08:41:12+03:00 · orchestrator-2026-09-18 · HEAD: b703f3bf
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
**In flight:** T70 activity review corrections; T75 remaining Settings service plan (foundation integrated); T78 pristine agent selection plan. T76 final poisoned gate pending. Ownership: `STATUS_DETAILED.md`.
**Next up:** T75 Agents/location-safe edits after remaining services; T79 complete-batch verification and 0.9.2 publication.
**Recently done:** T74 image/text and bounded read recovery (`b703f3bf`, fullUI2436 + final matrix); T77 goal-tool recovery (`a0a698ee`, 54 focused + real engine); T73 packaged spelling (`d0bbc680`); T72 history gate (`015d2ff3`); T71 naming gate (`f7113316`).

**Published:** v0.9.1 (`8183fd04`), `.git/lasercode-release/v0.9.1.json` verified. User authorized autonomous completion, commits, push and next release; no live app restart is authorized by the release itself.
