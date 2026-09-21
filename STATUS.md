# STATUS.md — one screen, always current

**Last updated:** 2026-09-22 · claude-2026-09-22-forensics · HEAD: see `git log -1 fix/session-forensics` (branch from `v0.14.0`, not merged)
**Current focus:** `fix/session-forensics` — three defects diagnosed from the person's own sessions, fixed and proven on a tag-based branch (D-360): M16-T100 scroll-up after a compaction, M13-T129 `send_agent_message` to a released child, M18-T20 catalog paging and worker compile cache. The integration line (`work/fallback-update`, M21) is untouched by this session.

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
| M15 After MCP release | in-progress |
| M16 Conversation experience | in-progress |
| M17 Coding experience | todo |
| M18 Resource containment | done |
| M19 Runtime recovery/update activation | in-progress |
| M20 Source-control leap | in-progress |
| M21 Project lifecycle leap | in-progress |
| M22 Model profiles | done |
| M23 Plain Chat | done |
| M24 Ask Oracle | in-progress |
| M25 External work links | in-progress |
| M26 Tool contract conformance | done |
| MX Cross-cutting | in-progress |

**Blockers:** M19-T7 source work waits for M19-T6 (T6B unstarted) — this is also the "An update was installed. Restart…" gate the person hit. Not on this branch.
**In flight:** nothing on this branch. Person-owned acceptance (D-342): open a compacted long session, scroll to its start; let a child agent finish, wait >2 min, `send_agent_message` it; watch a 500+ session sidebar refresh stay a page.
**Published:** v0.14.0 is Latest (`ac098597`); this branch is v0.14.0 + 4 commits.
**Next up:** merge or point-release `fix/session-forensics` (person's call); from the same forensics, still open: worker bundling / prewarm / view-before-attach / per-session stream subscription (M18-T20 notes).
**Recently done:** M16-T100 `408894a6`; M13-T129 `d2e2346a`; M18-T20 `0e572bf4`. Gate on this branch: `pnpm -r build` clean; worker 1284/1284, host 1031/1031, protocol 548/548, pi-extension 228/228, UI 3006/3006 (+1 skipped); `pnpm identity:check` clean. Note: the host suite spawns real workers and must run with `LASERCODE_*` stripped from a shell started inside Laser, else 64 tests fail on generation mismatch.
