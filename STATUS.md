# STATUS.md — one screen, always current

**Last updated:** resumed leap integration · code checkpoint: d408e8ea
**Current focus:** M21 integration and acceptance gaps. T10/T13 and T14 integrated/done; T18/T19 evidence/lifetime remain, and T2 canonical metadata quota coverage is reopened. T21 reviewed corrections integrated/done. M26 v0.14.0 is published and verified; M21 remains the next release gate.

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
| M26 Tool contract conformance | done |
| MX Cross-cutting | in-progress |

**Active owners:**
- T10/T13: done; reviewed source merged `b4ed1003` + correction `d408e8ea`. Parent450 focused tests and merged full verify/identity pass.
- T18/T19: backend/protocol checkpoint `36e163ed` settled; UI source-text reading/fencing corrections continue (`run_8d80dad8`). D-364 verification runtime implementation runs independently (`run_801faae2`). First full T19 review remains pending.
- T2: canonical metadata/history was not charged to quotas; read-only accounting/migration plan underway (`run_e545e799`).
- Integrated: T9/T17 mentions, T14 Foundation, T21 interop, image fixture and transcript continuity repairs. Exact ancestry/owners in `STATUS_DETAILED.md`.

**Gate:** integrated Command/mention/transcript **`pnpm verify && pnpm identity:check` pass** (`t-37896cd3`, 141.7s, source `d408e8ea`; clean graphical environment). Current integration branch, **not final main**; excludes pending capture/verification work. Person-owned browser acceptance remains unclaimed (D-342).
**Published:** v0.14.0 Latest (M26), v0.13.0 (M23), v0.12.0 (M22). Candidate `ac098597`; source CI `35616431166` and release `35616858358` attempt4 pass. Twelve assets/digests/source provenance verified; `docs/leap/m26-release-evidence.json`.
**Next:** close canonical quota gap, finish capture/verification corrections and reviews → T20 continuity → T22 hardening → T23 reconciliation/T24 acceptance → M21 release. M24/M25 implementation stays release-gated.
**Other retained blocker:** M19-T7 waits for M19-T6 shared storage ownership. Person-owned M20/visual acceptance must not be inferred from unit tests.
