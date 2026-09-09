# STATUS.md — one screen, always current

Regenerated from `STATUS_DETAILED.md`; detail and history live there.

**Last updated:** 2026-09-09T10:05:00+03:00 · claude-2026-09-09-agents · HEAD: c579c0f

**Current focus:** M13 Agents Leap is in. This session's round of the user's UX changes landed: the fleet is one session's tree and a deleted session's work is a named line, never a ghost (D-160); the logo and every sidebar row return to the chat from anywhere; a model has a switch, a provider has Enable all / Disable all, and "off" is a Laser-owned disable list because the engine's allow-list has no negation (D-161); a jump hands its prompt's text to the composer; a person's worktree removal stamps the run so the fleet stops offering it twice. The three findings from that pass are fixed too: the black screen after a session arrives from outside (a second hunk in the pinned assistant-ui patch), the CLI's app URL, and Settings writes reaching live sessions. Remaining M13 rows are a dead protocol message and a research sweep.

## Milestones

| Milestone | State | Note |
| --- | --- | --- |
| M0 Foundation | done | clean public CI verified |
| M1 Local loop | done | assistant-ui runtime |
| MP Panel system | dropped | removed by D-147; the fleet replaced it |
| M2 Many sessions, many projects | in-progress | broader notification platform proof remains |
| M3 Subagent tabs | in-progress | superseded in substance by M13 (D-140); M3-T9 upstream patches are moot |
| M4 Settings and logs | done | settings surfaces complete |
| M5 Desktop shell | in-progress | broader platform proof remains |
| M6 Relay and pairing | done | cryptographic foundations complete |
| M7 Mobile PWA | in-progress | remote control visibly Soon |
| M8 Package support | in-progress | spoken-phrase acceptance remains |
| M9 CLI | done | planned tasks complete |
| M10 Distribution | in-progress | native feeds ship; in-app updater seam remains |
| M11 Theme system | in-progress | cold-start network trace remains |
| M12 Product experience | done | 0.2.13 dispatched |
| M13 Agents Leap | in-progress | T1–T56 done except T38 (todo) and T37 (research sweep, in progress) |
| MX Cross-cutting | in-progress | pinned engine 0.85.0; identity/seam gates |

## Blockers

- None.

## Next up

1. M13-T38: retire the dead `lasercode/subagents/event` message (protocol inventory is a release gate).
2. M13-T37: the tool-use elements research sweep (read-only).
3. M10-T10: prove the in-app updater installation seam.

## Recently done

- M13-T55: a Settings write now reloads every open session's engine settings through the durable-override seam; a reload owed mid-turn lands at the next settle (real-engine tests, 7 + 4).
- M13-T54: the CLI prints and opens the running host's address, not the configured default (11 tests).
- M13-T53: no more black screen when a session created outside the app is reused on the first send; adapter fix plus a second hunk in the pinned assistant-ui patch (7 sequences pinned).
- M13-T52: text handed back by a jump reaches the composer (3 tests).
- M13-T51: the fleet is one session's tree; a deleted session's work is a named line (D-160; fleet model +5, panel +11).
