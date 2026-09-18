# STATUS.md — one screen, always current

**Last updated:** 2026-09-19T00:40:00+03:00 · orchestrator-2026-09-18 · HEAD: dc7a8979
**Current focus:** M16 — 0.9.2 published; image accessibility (T82) in correction for 0.9.3.

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

**Blockers:** none. Terminal worker-session resumption stays unreliable; explicit clean transfers preserve progress.
**In flight:** T82 images — reviewed `9b41858a` (4 blockers: pool residue unreclaimable, permanent `asked` rank, unbudgeted `open()` read, cap bounding total not residue); correction run_d6adcf03.
**Published:** v0.9.2 from `dc7a8979` — CI 35396133026, release 35396492469, 12 assets, Latest, checkpoint `verified`. Two attempts abandoned first on load-only test flakes (host access.e2e timeout, UI image macrotask wait), both now wait for state.
**Next up:** integrate T82 corrections → full verify → 0.9.3. Then M16-T76 final poisoned gate and the pre-existing `auto-follow-live-edge` streaming thumb-drag threshold on an idle machine.
**Recently done:** T81 earlier history (`569940a1`); T83 upward reading + honest scrollbar (`39af2b71`); T84 Markdown bodies + `MarkdownDocument` (`c7ca3f40`, `b586c5d1`); T75 Settings/Agents scope (`62145ee5`); mention Backspace/`@/` (`9c7966d3`, `4ec84dd8`).

**Published:** v0.9.2 (`dc7a8979`). Autonomous completion/commits/push/release authorized; no live restart. Active history outranks soft cache targets (D-295); MCP forms stay modal (D-296); Agents mutations name their location (D-297); project agent files are trust-gated (D-298); Backspace only deletes (D-299); the mention picker browses the machine (D-300); T82 deferred to 0.9.3 (D-301).
