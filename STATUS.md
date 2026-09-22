# STATUS.md — one screen, always current

**Last updated:** resumed leap integration · code checkpoint: f846a90f
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
- T2/T18/T19: done; final batch `c8d20389` merged (`f10501a0`).
- T22: done, merged (D-369, `docs/leap/m21-threat-model.md`); host415 post-merge.
- T24: deterministic acceptance owner active (`run_261766ac`); browser matrix stays person-owned.
- T2: quota accounting reviewed (`472b1347`) and final batch `ad09bb38` integrated; host 374 tests.
- T20: done, merged `c3c64337` (D-368); host453/protocol768/UI241.
- T23: done, merged; two T20 UI regressions fixed by parent. M17-T11 is absorbed by D-330 (dropped), not reopened.
- T26: reopened for the missing Research fleet row/Stop (`run_253a9729`).
- Forensics fixes integrated from `fix/session-forensics` (v0.14.0 + 4): M16-T100 scroll-up after compaction, M13-T129 message reopens a released child, M18-T20 catalog paging + worker compile cache; parent reproduced focused worker169/host69 green, 7 red without the fixes. Ship in the next release.
- Integrated: T9/T17 mentions, T14 Foundation, T21 interop, image fixture and transcript continuity repairs. Exact ancestry/owners in `STATUS_DETAILED.md`.

**Gate:** integrated verification/quota/forensics source `f846a90f`: **`pnpm verify && pnpm identity:check` pass** (`t-daeb8c05`, verify 171.6s, clean graphical environment, `/tmp/laser-integrated-verify-1.log`). Integration branch, **not final main**; excludes the in-flight T19 review batch and T20. Person-owned browser acceptance remains unclaimed (D-342).
**Published:** v0.14.0 Latest (M26), v0.13.0 (M23), v0.12.0 (M22). Candidate `ac098597`; source CI `35616431166` and release `35616858358` attempt4 pass. Twelve assets/digests/source provenance verified; `docs/leap/m26-release-evidence.json`.
**Next:** land T24 deterministic half and T26 research Command → full gate → T25 release (person browser matrix listed as open) → T22 hardening → T23 reconciliation/T24 acceptance → M21 release. M24/M25 implementation stays release-gated.
**Other retained blocker:** M19-T7 waits for M19-T6 shared storage ownership. Person-owned M20/visual acceptance must not be inferred from unit tests.
