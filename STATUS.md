# STATUS.md — one screen, always current

**Last updated:** 2026-09-13T11:23:38Z · orchestrator · HEAD: 5eb3430
**Current focus:** Environment restored after user-chosen restart; zero stale private-worktree processes. Two recovery owners admitted: MCP registry-integrity regression and bounded transcript acceptance. Existing code/WIP preserved and backed up; release remains authorized after acceptance.

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

**Blockers:** M16-T25 MCP5 requires provider authorization/access restriction resolved through its supported process; clean private checkpointc2ca190, plan preserved, no bypass/retry. Release gates remain: MCP historical failures unexplained after bounded green reproductions; MCP integrity merged a0dc6c4 and full verify passed; MCP5 blocked by provider access restriction; no runtime source changes. Transcript owner continues; transcript actions pass; recent-tail owner-window integration active (D-236/238), preserving independent same-session main/Beam views; final acceptance/review pending; MCP code-mode safety outstanding.
**Next up:** Active MCP integrity and C acceptance milestones first. Queued: M13-T99 keystroke/draft regression; M13-T100 Beam/touch; M13-T117 remembered-Chat recovery.
**Recently done:** M16-T28 global explorer (`5193fc9`); M16-T27 catalog-arrival (`961aeb8`); M16-T16 tail-first/actions (`d6e5ebd`, `402de75`); M16-T26 readiness (`f8b0d34`); M16-T24 forensics (`d9b7b7a`, `7942fb5`).

Ownership: `STATUS_DETAILED.md`. Durable recovery reports/WIP backup: `.git/coordination-recovery/`. New owner identities, private write scopes and WIP backups recorded in the detailed ledger. No source/settings changes during recovery.
