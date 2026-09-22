# STATUS.md — one screen, always current

**Last updated:** M21 integrated on main · code checkpoint: e7442ca2
**Current focus:** Person testing reopened M21-T13 (Build index loses the RPC receiver and crashes) and M21-T6 (all creation forms are the same two-field shell). Index repair is independently reviewing regression-tested `9e7c6cd1`; kind-aware creation and opened detail views are in design planning with a separate owner. Browser acceptance and release remain pending; Goal mode is inactive.

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
| M21 Project lifecycle leap | in-progress (T24 acceptance and T25 release are the person's) |
| M22 Model profiles | done |
| M23 Plain Chat | done |
| M24 Ask Oracle | built, unmerged (awaiting M21 release) |
| M25 External work links | built, unmerged (awaiting M21 release) |
| M26 Tool contract conformance | done |
| MX Cross-cutting | in-progress |

**M21, task by task:** T6 is reopened for purpose-specific creation forms and T13 for the index request-binding defect; other T0–T23 and T26 rows retain their recorded evidence in `STATUS_DETAILED.md`. T24 is half done — the deterministic matrix (8 scenarios across host, worker and UI) is merged; **the browser matrix B1–B12 in `docs/leap/m21-acceptance.md` is the person's and is the one open acceptance item** (D-342). T25 is `todo` and needs the person's release authorization.

**Gate:** **`pnpm verify && pnpm identity:check` pass on `main`** at `e7442ca2` (`t-da68933b`, verify 151.3s, `/tmp/laser-main-verify-1.log`), in a clean graphical environment. The same tree passed on the integration branch (`t-81817021`, 163.1s). Two suite defects were fixed on the way, not re-run away: three desktop real-host-spawn tests inherited the 5s default timeout under workspace concurrency (now declared 30s, like the other real-spawn suites), and one relay-client test counted retries that accrue after the moment it asserts.

**Published:** v0.14.0 Latest (M26), v0.13.0 (M23), v0.12.0 (M22). `docs/leap/m26-release-evidence.json` holds assets, digests and source provenance.

**What the leap shipped since the last release:** durable verification evidence with per-repository native acceptance (D-361/D-363/D-367), canonical metadata quotas (D-365), the verification Command with truthful Stop and settlement (D-364), project identity that survives relocation (D-368), the security/privacy/resource hardening pass with its threat model (D-369), product language reconciled to Command, the Research run as a fleet Command, and the deterministic lifecycle acceptance matrix.

**Needs you:**
1. After the index repair, `pnpm -r build && PORT=41442 pnpm sandbox` (http://127.0.0.1:41442), then work through B1–B12 in `docs/leap/m21-acceptance.md`. Port 41441 is occupied by the installed host with real data, not the sandbox.
2. Authorize the M21 release (T25) when the matrix looks right.

**M24 and M25** are being built on isolated branches while M21 waits for authorization (D-370); neither reaches `main` or a release until M21 is published.

**Other retained blockers:** M19-T7 waits for M19-T6 shared storage ownership. `packages/protocol/src/git-run.ts` registers no owned process (threat model G10), owned by the source-control leap. M17-T11 stays dropped by D-330.
