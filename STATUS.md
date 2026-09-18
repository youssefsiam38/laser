# STATUS.md — one screen, always current

**Last updated:** 2026-09-19T03:10:00+03:00 · orchestrator-2026-09-18 · HEAD: f973da9a
**Current focus:** 0.9.1, a repair release: the live edge follows again, goals stop only when the agent decides to, mentions read like paths, the transcript and composer behave natively, action rows carry the agent's own words, and agent names read like sentences.

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
| M17 Coding experience | todo |
| M18 Resource containment | done |
| M19 Runtime recovery/update activation | done |
| MX Cross-cutting | in-progress |

**Blockers:** none. Nine rows merged; clean-env `pnpm verify` green in 101.8 s at `f973da9a`.
**In flight:** publishing 0.9.1 (`RELEASE_NOTES.md`, reviewed source `f973da9a`).
**Next up:** M16-T70 text inside a button is unselectable; humanise tool-label display (deferred out of M13-T128); the two goal-pause paths the forensics left open (repair missing goal tools instead of pausing; retryable restore-mutex contention); M17 and open rows in M2/M3/M5/M7/M8/M10/M11/M13/M16/MX.
**Recently done:** M16-T69 live edge follows (`73eec455`, D-287 after a two-sided debate); M16-T68 goals stop only by decision (`bc5531a2`, D-283); M16-T65 readable mentions (`fa317c92`, D-284); M16-T66 native text and spellcheck (`047176f5`, D-286); M13-T127 labels title every row (`5bf9854a`, D-282); M13-T128 friendly agent names (`406ea2f9`, D-285); M15-T7 fallback for an agent-chosen model (`215a8689`); M16-T71/T72 two gates made honest (`f7113316`, `015d2ff3`); M16-T67 goal-pause forensics (`8c44b20e`).

**Known unproven at release:** installed-Electron spellcheck underlines, OS suggestions and macOS Look Up are covered by configuration and menu-action tests only — nobody has watched a red squiggle in the packaged app.

Ownership and evidence: `STATUS_DETAILED.md`. Durable recovery reports/WIP backup: `.git/coordination-recovery/`.
