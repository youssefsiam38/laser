# STATUS.md — one screen, always current

**Last updated:** Reviewed opened entity authoring merged · code checkpoint: e6fdc981
**Current focus:** Build index receiver crash fixed on main (`c085f82a`), independently reviewed; design123, test types, typecheck, identity and UI build pass. Person retry remains pending. M21-T6 creation/Markdown milestone merged at `de49fab3` with all review corrections; parent391 focused tests, test types/typecheck/identity/UI build pass. Opened entity views are merged at `d06a2c60` plus `e6fdc981`, with immutable draft ownership, explicit highlighted Write/Preview/Save, all independent-review corrections, and person-written validation. Parent434 focused tests and full main `pnpm verify`172.5s plus identity pass at `c2f22e1b`. Visual acceptance remains person-owned. M20-T3 spend repair is reviewed and merged (`23da063c`), with final parent-owned trim/replay corrections, legacy-path removal and cross-worker test. Protocol72/worker12/host49 plus builds/identity pass, including the real restart regression. Full merged gate is next; no further review round. The fix remains in next-release scope. Viewing will render Markdown by default; Preview never saves. Publication is explicitly authorized once the work is finished; review, validation and person-owned acceptance results remain pending. Goal mode is inactive.

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
| M21 Project lifecycle leap | in-progress (UI repairs/acceptance; publication authorized after completion) |
| M22 Model profiles | done |
| M23 Plain Chat | done |
| M24 Ask Oracle | built, unmerged (awaiting M21 release) |
| M25 External work links | built, unmerged (awaiting M21 release) |
| M26 Tool contract conformance | done |
| MX Cross-cutting | in-progress |

**M21, task by task:** T6 purpose-specific creation and opened detail implementation is reviewed, merged and focused-tested; T13 receiver repair is merged and unit-verified; other T0–T23 and T26 rows retain their recorded evidence in `STATUS_DETAILED.md`. T24 is half done — the deterministic matrix (8 scenarios across host, worker and UI) is merged; **the browser matrix B1–B12 in `docs/leap/m21-acceptance.md` is the person's and is the one open acceptance item** (D-342). T25 publication is authorized after the requested UI work is completed and validated; the old prepared candidate must be replaced.

**Gate:** **`pnpm verify && pnpm identity:check` pass on `main`** at `c2f22e1b` (`t-9cf51ec0`, verify172.5s, `/tmp/laser-entity-authoring-full-verify.log`), in a clean graphical environment. Earlier gate at `e7442ca2` remains historical evidence (`t-da68933b`,151.3s). The same tree passed on the integration branch (`t-81817021`, 163.1s). Two suite defects were fixed on the way, not re-run away: three desktop real-host-spawn tests inherited the 5s default timeout under workspace concurrency (now declared 30s, like the other real-spawn suites), and one relay-client test counted retries that accrue after the moment it asserts.

**Published:** v0.14.0 Latest (M26), v0.13.0 (M23), v0.12.0 (M22). `docs/leap/m26-release-evidence.json` holds assets, digests and source provenance.

**What the leap shipped since the last release:** durable verification evidence with per-repository native acceptance (D-361/D-363/D-367), canonical metadata quotas (D-365), the verification Command with truthful Stop and settlement (D-364), project identity that survives relocation (D-368), the security/privacy/resource hardening pass with its threat model (D-369), product language reconciled to Command, the Research run as a fleet Command, and the deterministic lifecycle acceptance matrix.

**Needs you:**
1. After the index repair, `pnpm -r build && PORT=41442 pnpm sandbox` (http://127.0.0.1:41442), then work through B1–B12 in `docs/leap/m21-acceptance.md`. Port 41441 is occupied by the installed host with real data, not the sandbox.
2. Release permission has been granted. Remaining person checks are acceptance evidence, not another generic authorization request.

**M24 and M25** are built and staged on isolated branches under D-370; neither reaches `main` or a release until M21 is published. Publication authorization is already granted.

**Other retained blockers:** M19-T7 waits for M19-T6 shared storage ownership. `packages/protocol/src/git-run.ts` registers no owned process (threat model G10), owned by the source-control leap. M17-T11 stays dropped by D-330.
