# STATUS.md — one screen, always current

Regenerated from `STATUS_DETAILED.md`; detail and history live there.

**Last updated:** 2026-09-11T22:36:00Z · mcp-settings-fixes · HEAD: 8f46c5e

**Current focus:** M14 UI live-review fixes ready on `agents/mcp-settings-fixes-6f615649`; orchestrator review/integration pending. T5 packaging merged. T6 combined live acceptance remains; M15 branches stay parked for the MCP release.

## Milestones

| Milestone | State | Note |
| --- | --- | --- |
| M0 Foundation | done | clean public CI verified |
| M1 Local loop | done | assistant-ui runtime |
| MP Panel system | dropped | replaced by the fleet, D-147 |
| M2 Many sessions, many projects | in-progress | broader notification platform proof remains |
| M3 Subagent tabs | in-progress | superseded in substance by M13 |
| M4 Settings and logs | done | settings surfaces complete |
| M5 Desktop shell | in-progress | broader platform proof remains |
| M6 Relay and pairing | done | cryptographic foundations complete |
| M7 Mobile PWA | in-progress | remote control visibly Soon |
| M8 Package support | in-progress | real-device spoken-phrase acceptance remains |
| M9 CLI | done | planned tasks complete |
| M10 Distribution | in-progress | in-app updater seam remains |
| M11 Theme system | in-progress | cold-start network trace remains |
| M12 Product experience | done | 0.2.13 dispatched |
| M13 Agents Leap | in-progress | 0.3.10 public; T117 parked |
| M14 MCP servers | in-progress | T5 merged; six UI findings fixed on branch, T6 remains |
| M15 After the MCP release | in-progress | parked implementations await M14 tag |
| MX Cross-cutting | in-progress | pinned engine 0.85.0; identity/seam gates |

## Blockers

None recorded. UI fixes await review; combined MCP live acceptance is not yet complete.

## Next up

1. Review/integrate M14 UI and engine findings, then finish T6 live acceptance.
2. MCP release through the reviewed release orchestrator (D-222).
3. Merge parked M15 branches after the MCP tag; M13-T117 remains parked.

## Recently done

- M14-T5: `e4303b5`; packaged stdio fixture session/inspect/call, desktop 117 and release 42 tests.
- M14-T4: `2b88158`; transcript MCP rows and image hydration, UI 1191 on main.
- M14-T2: `b6a59e0`; MCP engine/store/inspector/OAuth/import, worker 549 and host 227.
- M14-T1: `9ccbf4f`; MCP vocabulary, methods, catalog and schema tests.
- M13-T121: v0.3.10 public, 12 assets; CI 34631345414 and release 34631650985.
