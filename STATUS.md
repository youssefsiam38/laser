# STATUS.md — one screen, always current

**Last updated:** 2026-09-14T01:05:00Z · orchestrator `01a09b3e` · HEAD: a000b2e
**Current focus:** 0.6.2 is public and verified. Next: the deferred structure work from the 0.6.2 review (M16-T38/T39), the release orchestrator abandon path (M16-T40), then MCP5 renderer and packaged/arm64 gates (D-240).

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

**Blockers:** none. MCP5 stays on its branch (D-240).
**Next up:** M16-T40 abandon path; M16-T38 split logstore/release.mjs; M16-T39 selector family. Q-9 (Electron-served shell; long-hidden renderer disposal) awaits the person.
**Recently done:** M16-T41 release 0.6.2 (`a000b2e`); M16-T34 log store bounded (`949d617`); M16-T35 inspector flicker (`0010cfd`); M16-T32/T36 streaming + phone re-entry (`4a22d77`, `9b0ee04`); M16-T30/T31/T33 hidden window, bundle, package (`f8b4b7d`, `dec848e`, `932d4f3`).

Ownership: `STATUS_DETAILED.md`. Durable recovery reports/WIP backup: `.git/coordination-recovery/`. New owner identities, private write scopes and WIP backups recorded in the detailed ledger. No source/settings changes during recovery.
