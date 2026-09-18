# STATUS.md — one screen, always current

**Last updated:** 2026-09-18T07:28:00+03:00 · orchestrator-2026-09-18 · HEAD: e69b296e
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

**Blockers:** none confirmed; release awaits measured interaction evidence and independent review, not configuration assertions.
**In flight:** T76 reviewed/integrated (full gate pending); T73 review corrections + final packaged after-states; T74 image-prompt repair in independent review; T75 explicit scope foundation; T70 selectable, humanised activity text; T77 goal recovery implementation. Ownership and exact write boundaries: `STATUS_DETAILED.md`.
**Next up:** T78 pristine agent selection after model choice (same driver owner after T77); remaining T75 routed services and Agents. T79 release waits for the complete batch.
**Recently done:** T72 history paging gate (`015d2ff3`); T71 deterministic naming gate (`f7113316`); T69 geometric auto-follow (`73eec455`); T68 autonomous goal policy (`bc5531a2`); T65 readable mentions (`fa317c92`).

**Published:** v0.9.1 (`8183fd04`), `.git/lasercode-release/v0.9.1.json` verified. User authorized autonomous completion, commits, push and next release; no live app restart is authorized by the release itself.
