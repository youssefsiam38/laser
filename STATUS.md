# STATUS.md — one screen, always current

**Last updated:** 2026-09-14T00:30:00Z · orchestrator `01a09b3e` · HEAD: b8f5d79
**Current focus:** Releasing 0.6.2: the Electron performance lanes (M16-T30..T33) and the open-problem fixes (M16-T34..T37) are merged, reviewed (D-246) and gated — verify, browser matrix, inspector flicker check and packaged clean-machine all green on the final bytes.

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
**Next up:** publish 0.6.2; then M16-T38 (split logstore/release.mjs), M16-T39 (selector family), MCP5 approval renderer and packaged/arm64 gates (D-240). Q-9 (Electron-served shell; long-hidden renderer disposal) awaits the person.
**Recently done:** M16-T34 log store bounded (`949d617`); M16-T35 inspector flicker (`0010cfd`); M16-T32/T36 streaming isolation + phone re-entry (`4a22d77`, `9b0ee04`); M16-T30 hidden window (`f8b4b7d`); M16-T31/T33 bundle + package (`dec848e`, `932d4f3`); M16-T37 release resume (`de67821`).

Ownership: `STATUS_DETAILED.md`. Durable recovery reports/WIP backup: `.git/coordination-recovery/`. New owner identities, private write scopes and WIP backups recorded in the detailed ledger. No source/settings changes during recovery.
