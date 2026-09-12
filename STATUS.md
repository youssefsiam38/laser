# STATUS.md — one screen, always current

Regenerated from `STATUS_DETAILED.md`; detail and history live there.

**Last updated:** 2026-09-12T13:27:35Z · linux-relaunch · HEAD: 669c64f

**Current focus:** M5-T6 finished: Linux update restart preserves command privileges; full verification and isolated Electron regression pass. Not deployed; an already-restricted app needs one full quit/reopen. M16 sidebar/loading work remains with its recorded owners. v0.5.4 is public.

## Milestones

| Milestone | State | Note |
| --- | --- | --- |
| M0 Foundation | done | CI verified |
| M1 Local loop | done | runtime complete |
| MP Panel system | dropped | fleet replaces it, D-147 |
| M2 Many sessions | in-progress | platform proof |
| M3 Subagent tabs | in-progress | superseded by M13 |
| M4 Settings and logs | done | settings complete |
| M5 Desktop shell | in-progress | restart fix done; platform proof remains |
| M6 Relay and pairing | done | cryptographic foundations |
| M7 Mobile PWA | in-progress | pairing transport remains |
| M8 Package support | in-progress | device dictation proof |
| M9 CLI | done | planned tasks complete |
| M10 Distribution | in-progress | in-app updater seam |
| M11 Theme system | in-progress | cold-start network trace |
| M12 Product experience | done | shipped |
| M13 Agents Leap | in-progress | remaining lifecycle/UI work |
| M14 MCP servers | done | shell environment and identity included |
| M15 After MCP release | done | v0.5.0 public |
| M16 Refinements | in-progress | sidebar/loading; environment discovery handed off |
| MX Cross-cutting | in-progress | engine pin, identity/seam gates |

## Blockers

None recorded.

## Next up

1. M16-T17: per-project environment command; discovery `/tmp/workenv/REPORT.md`.
2. M13-T117: remembered Chat fallback; branch `chat-memory-fallback` (`7d121ef`).
3. M13-T99: keystroke-burst composer draft-restore crash.

## Recently done

- M5-T6: Linux restart privileges; `pnpm verify`, desktop 135 tests, real Electron smoke.
- M16-T18: v0.5.4 public; source `d5dec9c`.
- M16-T14: stack-neutral worktrees; `29faafc`.
- M16-T13: bidirectional layout; `267f315`, 28 RTL screenshots.
- M16-T8: prompt-source attribution; `94c017f`.
