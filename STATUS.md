# STATUS.md — one screen, always current

Regenerated from `STATUS_DETAILED.md`; detail and history live there.

**Last updated:** 2026-09-08T17:30:00+03:00 · claude-2026-09-08-agents · HEAD: `f3fa5ed`

**Current focus:** M13 Agents Leap is in. The last four changes came from the user: workspaces under the state directory the host owns (D-141), Run setup again actually starting setup (D-142), a second way into Beam with the microphone in every composer (D-143), and every agent having every tool with no limit on how long a run may take (D-144). Remaining M13 rows are the retired pi-subagents file layer and the `.laser` override reload finding.

## Milestones

| Milestone | State | Note |
| --- | --- | --- |
| M0 Foundation | done | clean public CI verified |
| M1 Local loop | done | assistant-ui runtime |
| MP Panel system | done | panel contract implemented |
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
| M12 Product experience | done | 0.2.13 dispatched; pipeline owns verified-download publication |
| M13 Agents Leap | in-progress | T1–T10 and T13–T16 done; T11 (retire file layer) and T12 (`.laser` overrides through reloads) remain |
| MX Cross-cutting | in-progress | pinned engine 0.85.0; identity/seam gates |

## Blockers

- None.

## Next up

1. M13-T11: remove the retired pi-subagents file layer, its CLI commands and documents.
2. M13-T12: prove `.laser` project overrides survive the engine's resource reload.
3. M10-T10: prove the in-app updater installation seam.

## Recently done

- M13-T16: `f3fa5ed`; tools left the agent definition and every agent has them all; runs have no timeout and a project with a live run keeps its worker; 1,384 tests.
- M13-T15: `6eb1479`; Beam starts from its sidebar group as well as the spark, maximize works on an empty bubble, and dictation belongs to the composer it was spoken into; 687 UI tests.
- M13-T14: `98349ce`; Run setup again starts the flow now, leaves the open session in the sidebar and survives a reload; 682 UI tests.
- M13-T13: `f3ae096`; workspaces under `<state>/workspaces`, a workspace created before its worker, a missing built-in workspace recreated on open; full gate and packaged gate green.
- M13-T10: full workspace gate (identity, build, typecheck, 1,373 tests, release tests), packaged clean-machine gate, wire-level delegation scene, desktop/phone browser review.
- M13-T9: packaged build opens a real session with `subagents` and `background-work` active and writes the Beam skill; pi-subagents unbundled.
- M13-T7/T8: React Flow live map at four measured compositions; Beam spark and bubble over an isolated thread scope.
- M13-T1..T6: protocol `agents/*`, worker harness with worktrees, host store and run registry, UI store, Agents page, sidebar sub-sessions and projections.
