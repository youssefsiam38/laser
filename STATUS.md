# STATUS.md — one screen, always current

**Last updated:** 2026-09-14T10:39:41Z · orchestrator `01a09ea5` · HEAD: 51442d6
**Current focus:** 0.6.4 fixes are complete; final review blockers are corrected and M16-T54 remains open only for the authorized public release.

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
| MX Cross-cutting | in-progress |

**Blockers:** none. The invalid inherited `GITHUB_TOKEN` is bypassed with the valid keyring account; local `pnpm verify` has only the known machine-specific `runtime-env.test.ts:76` npm-layout failure.
**Next up:** publish 0.6.4 from the reviewed source; then M17-T1; M16-T52/T53 remain review follow-ups. Q-9 awaits the person.
**Recently done:** M16-T55 stream follows explicit Send; M16-T56 Projects Bash setup; M16-T57 terminal compaction state; M16-T58 owned agent endings and transient recovery; M16-T54 scroll fix committed (`51442d6`).

Ownership: `STATUS_DETAILED.md`. Durable recovery reports/WIP backup: `.git/coordination-recovery/`.
