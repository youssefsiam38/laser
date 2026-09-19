# STATUS.md — one screen, always current

**Last updated:** 2026-09-20T01:45:51+03:00 · orchestrator-2026-09-19-leap · HEAD: 82969dcf
**Current focus:** M20 — the source-control leap, built end to end and gated; the person's acceptance is the only step left (`docs/leap/uat.md`).

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
| M20 Source-control leap | in-progress |
| MX Cross-cutting | in-progress |

**Blockers:** none. Nothing is released until the person accepts the sandbox (spec §13.5).
**In flight:** M20 awaiting the person's acceptance. M16-T92 (the client still reads `image.data`) remains open behind it.
**Published:** v0.9.2 from `dc7a8979` — CI 35396133026, release 35396492469, 12 assets, Latest, checkpoint `verified`. Two attempts abandoned first on load-only test flakes (host access.e2e timeout, UI image macrotask wait), both now wait for state.
**Next up:** the person's UAT on the seeded sandbox (four workspace shapes, a session with real turns), then the decisions it produces, then a release only with explicit authorization.
**Recently done:** M20-T1 workspace shapes and the harness (`acc1b4a6`+`009a49a2`); M20-T2 checkpoints, restore and undo-this-turn (`d7c6d62c`+`85a74e4a`+`90e191f4`, baseline no longer races the first turn); M20-T3 telemetry over the whole session (`69a3fbea`+`6662afd2`); M20-T4 both columns redrawn and the filter row fitted (`82969dcf`); M20-T5 the changes modal on `@pierre/diffs`, crash-free, in our own type (`b3ced7f5`); M20-T6 git actions engine and toolbar (`bc00695b`, `bb786d1c`).

**Published:** v0.9.4 (`6d50a050`) is Latest. Autonomous completion/commits/push authorized; the person performs browser acceptance on a parent-built sandbox before any release. Active history outranks soft cache targets (D-295); MCP forms stay modal (D-296); Agents mutations name their location (D-297); project agent files are trust-gated (D-298); Backspace only deletes (D-299); the mention picker browses the machine (D-300); T82 deferred to 0.9.3 (D-301); the transcript copies a shipping chat client (D-305, superseding D-303).
