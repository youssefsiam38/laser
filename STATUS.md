# STATUS.md — one screen, always current

**Last updated:** 2026-09-21T20:27:16+03:00 · leap integration · HEAD: f8091463
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

**Active owners:** T14 merged/done (UI125/host31); T10/T13 Command checkpoint89dff93b returned; settlement retention/UI owner-resolution corrections assigned before review; T18/T19 Native UI/raw decoder checkpoint `d534a3b4` preserved; v2 source-proof plan approved with zero-change state support and decision-delivery completeness; replacement implementing after resume-runtime failure; T9/T17 corrected318077ae: parent67 real-engine/unit tests pass; single full independent review active. T21 done (`23a3fa45`, merged build/typecheck/host224/UI34; strict UTF-8 interop61). M26 publication completed; capture/index/Legend fix owners plus mention reviewer are active; M16-T82 fixture independently reviewed and integrated. Exact paths/sessions in `STATUS_DETAILED.md`.
**Gate:** full merged build/typecheck and all non-UI suites pass (host1258/worker1643/protocol728). UI3299 pass/1 fail/1 skip: trim-interaction loses exact focused action after cache transaction (`t-d5c98a98`). Legend DOM-order fallback proven to blur focus; focus/selection fix022e3b6c returned; selection handover/offset guards returned to same owner before review. Image lifecycle fix and review merged; focused32 pass. Identity last passed after interop correction; latest full chain stopped before identity. Browser acceptance remains the person’s (D-342).
**Published:** v0.14.0 Latest (M26), v0.13.0 (M23), v0.12.0 (M22). Candidate `ac098597`; exact-source CI `35616431166` and release `35616858358` attempt4 pass. Twelve assets, manifest digests and source-bound provenance verified by release controller; evidence `docs/leap/m26-release-evidence.json`. Parent merged release metadata (`64c701cc`), identity check passes. Final integrated main-branch gates remain required.
**Next dependency-ready work:** finish active corrections/review, close T9/T17 worker mention-context delivery gap (tasks reopened), then T20 continuity → T22 hardening → T23 reconciliation/T24 acceptance → M21 release. M24/M25 implementation stays release-gated.
**Recent implementation checkpoints:** T18 `85ee5ea4` (reopened: durable verification capture missing); T9 `222d86c0`; T17 `133d55cd`; T12 `92cc43c9` + `f15eb7d1`; T8 `98a01428`.
**Other retained blocker:** M19-T7 waits for M19-T6 shared storage ownership. Person-owned M20/visual acceptance must not be inferred from unit tests.
