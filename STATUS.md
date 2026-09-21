# STATUS.md — one screen, always current

**Last updated:** 2026-09-21T18:02:00+03:00 · leap integration · HEAD: bc3e16df
**Current focus:** M21 integration and acceptance gaps. T13/T14/T21 checkpoints merged, not yet accepted; T19 active. M26 implementation reviewed, publication still outstanding.

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
| M15 After MCP release | in-progress |
| M16 Conversation experience | in-progress |
| M17 Coding experience | todo |
| M18 Resource containment | done |
| M19 Runtime recovery/update activation | in-progress |
| M20 Source-control leap | in-progress |
| M21 Project lifecycle leap | in-progress |
| M22 Model profiles | done |
| M23 Plain Chat | done |
| M24 Ask Oracle | in-progress (contract only) |
| M25 External work links | in-progress (contract only) |
| M26 Tool contract conformance | in-progress (publication pending) |
| MX Cross-cutting | in-progress |

**Active owners:** T14 foundation wiring/shared editor; T21 filesystem/publication corrections; T19 verification; independent T18 delivery review. Orchestrator: M26-T5 release transaction from reviewed tool-only source `08ebe228` (resume task `t-22636077`), not yet published. Exact paths/sessions in `STATUS_DETAILED.md`.
**Gate:** merged build/typecheck, host lifecycle 179/179 and UI design 97/97 pass. Full verify failed CLI timeout (focused 2/2 pass); M26 release preparation failed MCP status test (focused 11/11 pass), now resumed without bypass. Browser acceptance remains the person's (D-342).
**Published:** v0.13.0 Latest (M23), v0.12.0 (M22), confirmed through GitHub. Prior claim that M26 was published was incorrect. M26 release and final main-branch gates remain required.
**Next dependency-ready work:** finish active corrections/review, publish reviewed M26 checkpoint, close T9/T17 worker mention-context delivery gap (tasks reopened), then T20 continuity → T22 hardening → T23 reconciliation/T24 acceptance → M21 release. M24/M25 implementation stays release-gated.
**Recent implementation checkpoints:** T18 `85ee5ea4` (review pending); T9 `222d86c0`; T17 `133d55cd`; T12 `92cc43c9` + `f15eb7d1`; T8 `98a01428`.
**Other retained blocker:** M19-T7 waits for M19-T6 shared storage ownership. Person-owned M20/visual acceptance must not be inferred from unit tests.
