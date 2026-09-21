# STATUS.md — one screen, always current

**Last updated:** 2026-09-21T10:09:00+03:00 · claude-2026-09-21-leap · HEAD: eadefb1c
**Current focus:** M23 Plain Chat is implemented, reviewed and fixed (`pnpm verify` green); M23-T6 is releasing 0.13.0. M26-T1/T2 tool-contract lint runs in parallel; M21 follows.

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
| M23 Plain Chat | in-progress |
| M24 Ask Oracle | in-progress |
| M25 External work links | in-progress |
| M26 Tool contract conformance | in-progress |
| MX Cross-cutting | in-progress |

**Blockers:** M19-T7 source work waits for M19-T6 to release shared `LaserPaths` and migration-storage ownership. M21 remains dependency-gated on the person's M20 sandbox acceptance; the leap goal (`docs/goal-project-lifecycle-leap.md`) proceeds M22 → M23 → M26 → M21 → M24 → M25.
**In flight:** M23-T6 release of 0.13.0; M26-T1/T2 (worker). Browser acceptance of the Chat entry points, the Agents empty state and the profile surfaces is the person's (D-342).
**Published:** v0.12.0 is Latest (`19cdd565` candidate; 12 verified assets).
**Next up:** M26-T3 evaluation harness and M26-T4 UI error/preview rendering; M21-T1 protocol domain for the lifecycle; M24-T1 after M26-T1.
**Recently done:** M23-T1–T5 Plain Chat: protocol (`5aebaee4`), worker chat prompt + one-shot naming (`0051d591`), host without built-ins (`79404b7c`), UI without Beam (`72f0a3a1`), docs/guard (`c91eec1b`, `70d8f4ad`), review fixes (`3a27fe38`), naming kept on the person's choice (`40eabcee`); M22 released as v0.12.0 (`19cdd565`).
