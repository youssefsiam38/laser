# STATUS.md — one screen, always current

**Last updated:** 2026-09-21T21:24:44+03:00 · leap integration · HEAD: ce851259
**Current focus:** M21 integration and acceptance gaps. T14 integrated/done; T10/T13 Fleet ownership correction and T19 evidence correction remain. T21 reviewed corrections integrated/done. M26 v0.14.0 is published and verified; M21 remains the next release gate.

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

**Active owners:** T9/T17 integrated/done (`a0cfcaf0` via d5018060, review2fdefb60); merged frozen install/build/worker71/host25/extension14/typecheck/identity pass; three source/review trees removed. T10/T13 ownership review accepted (`e92e6392`); final canonical session-rekey/pin correction required and assigned; Legend continuity review accepted (`f298473d`, focused39); final low-finding guard/test corrections transferred after resume failure. T18/T19 capture checkpoint34c1790c returned; parent found scope/proof/supersession/timeout gaps, approved correction plan78c078d3 + D-363 immutable capture history now implementing after both approval delivery modes failed. T14/T21 and image fixture repairs remain integrated. Exact paths/sessions in `STATUS_DETAILED.md`.
**Gate:** full merged build/typecheck and all non-UI suites pass (host1258/worker1643/protocol728). UI3299 pass/1 fail/1 skip: trim-interaction loses exact focused action after cache transaction (`t-d5c98a98`). Legend DOM-order fallback proven to blur focus; focus/selection fix354f0aaa independently accepted; final guard corrections pending. Image lifecycle fix and review merged; focused32 pass. Identity passes after merged mention correction; last full verify remains red on the pending transcript fix. Browser acceptance remains the person’s (D-342).
**Published:** v0.14.0 Latest (M26), v0.13.0 (M23), v0.12.0 (M22). Candidate `ac098597`; exact-source CI `35616431166` and release `35616858358` attempt4 pass. Twelve assets, manifest digests and source-bound provenance verified by release controller; evidence `docs/leap/m26-release-evidence.json`. Parent merged release metadata (`64c701cc`), identity check passes. Final integrated main-branch gates remain required.
**Next dependency-ready work:** finish capture corrections and Command/transcript reviews, then T20 continuity → T22 hardening → T23 reconciliation/T24 acceptance → M21 release. M24/M25 implementation stays release-gated.
**Recent implementation checkpoints:** T18 `85ee5ea4` (reopened: durable verification capture missing); T9 `222d86c0`; T17 `133d55cd`; T12 `92cc43c9` + `f15eb7d1`; T8 `98a01428`.
**Other retained blocker:** M19-T7 waits for M19-T6 shared storage ownership. Person-owned M20/visual acceptance must not be inferred from unit tests.
