# STATUS.md — one screen, always current

**Last updated:** 2026-09-21T07:24:17+03:00 · claude-2026-09-21-leap · HEAD: c6fa9277
**Current focus:** M22 Model profiles is implemented, reviewed and fixed (`f14a152f`, `pnpm verify` green); M22-T11 is releasing 0.12.0. Next in the leap order: M23 Plain Chat.

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
| M22 Model profiles | in-progress |
| M23 Plain Chat | in-progress |
| M24 Ask Oracle | in-progress |
| M25 External work links | in-progress |
| M26 Tool contract conformance | in-progress |
| MX Cross-cutting | in-progress |

**Blockers:** M19-T7 source work waits for M19-T6 to release shared `LaserPaths` and migration-storage ownership. M21 remains dependency-gated on the person's M20 sandbox acceptance; the leap goal (`docs/goal-project-lifecycle-leap.md`) proceeds M22 → M23 → M26 → M21 → M24 → M25.
**In flight:** M22-T11 release of 0.12.0 (migration notes in `RELEASE_NOTES.md`). Browser acceptance of the profiles tab, onboarding profile step and the two-line composer control is the person's (D-342).
**Published:** v0.11.1 is Latest (`e5a69d80` candidate; 12 verified assets).
**Next up:** M23-T1 protocol removal and `sessionKind` (after 0.12.0 is Latest); M26-T1 `toolContract()` lint; M19-T6 T6B launcher/daemon/desktop binding.
**Recently done:** M22-T1–T10 Model profiles: protocol (`e692e4b9`), worker settings/migration/seeds (`717c7c33`), runtime on profiles (`ad23a25e`), agents and naming (`c4d4ec48`), host authority (`e9ba67c9`), settings tab (`14318ffa`), onboarding (`69f7bf9c`), composer/fleet/logs (`60671df9`), agents page + CLI (`1e2c031c`), docs/guard/reconciliation (`1a1efdcd`, `05fbb7aa`), review fixes (`8095f43f`); migration preview on the person's settings (`docs/leap/m22-real-migration-preview.json`, D-356).
