# STATUS.md — one screen, always current

Regenerated from `STATUS_DETAILED.md`; detail and history live there.

**Last updated:** 2026-09-09T09:10:00+03:00 · claude-2026-09-09-agents · HEAD: 5ebe979

**Current focus:** M13 Agents Leap is in. This session's round of the user's UX changes landed: the fleet is one session's tree and a deleted session's work is a named line, never a ghost (D-160); the logo and every sidebar row return to the chat from anywhere; a model has a switch, a provider has Enable all / Disable all, and "off" is a Laser-owned disable list because the engine's allow-list has no negation (D-161); a jump hands its prompt's text to the composer; a person's worktree removal stamps the run so the fleet stops offering it twice. Remaining M13 rows are a dead protocol message, three findings from this pass, and a research sweep.

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
| M13 Agents Leap | in-progress | T1–T52 and T56 done; T38, T53, T54, T55 todo; T37 (research sweep) in progress |
| MX Cross-cutting | in-progress | pinned engine 0.85.0; identity/seam gates |

## Blockers

- None.

## Next up

1. M13-T55: a settings write does not reach a live session's engine settings; the model lists are read from disk as a workaround.
2. M13-T38: retire the dead `lasercode/subagents/event` message (protocol inventory is a release gate).
3. M13-T53 / M13-T54: the one-off black screen after creating a session from the project screen, and the CLI printing the default port in its app URL.

## Recently done

- M13-T52: text handed back by a jump reaches the composer; the store had parked it and nothing read it (`handed-back-text.test.tsx`).
- M13-T51: the fleet is one session's tree, a child shows its root's tree with its row marked, a deleted session's work is a named line (D-160; fleet model +5, panel +11).
- M13-T50: the logo and every sidebar row return to the chat from the map, Settings, Logs and the sheets; the logo never creates a session (15 tests).
- M13-T49: a hidden model says why and can be let back in; a switch on every row, provider-wide Enable/Disable all, a View menu, and a Laser-owned disable list (D-161; models-tab 20, model-offer 9).
- M13-T42: a person's worktree removal, from the fleet or a delete, stamps the runs that owned it; both dialogs verified in the browser.
