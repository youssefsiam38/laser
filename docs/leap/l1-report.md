# L1 — Workspace shapes and the harness

Milestone M18-T1 / source-control leap §6 and §10 L1.

## What was built

A workspace has a shape. The harness adapts to it instead of refusing.

### Resolver

- Types and pure logic: `packages/protocol/src/workspace.ts`.
- Injected `WorkspaceIO` (`run(args, cwd)` plus directory listing). Protocol never spawns git.
- Node adapters: `packages/host/src/workspace.ts` and `packages/worker/src/workspace.ts`.
- Cache per resolved cwd, dropped only on `rescan: true`.
- Discovery bounds: depth 3 (`WORKSPACE_SCAN_MAX_DEPTH`), 64 repos (`WORKSPACE_SCAN_MAX_REPOS`), skip `node_modules`, `.git`, other dot-directories, and obvious build output.

Shapes, from real fixture layouts:

| Shape | Detection |
| --- | --- |
| `repo` | `rev-parse --show-toplevel` succeeds; no nested extra `.git`; not submodule/bare |
| `workspace-of-repos` | cwd is not a repo; children are |
| `no-git` | nothing found |
| `nested-repo` | a repository inside another (parent walk or child `.git` with a different toplevel) |
| `bare-or-submodule` | `.gitmodules`, `--show-superproject-working-tree`, or `--is-bare-repository` |

A monorepo with one `.git` is `repo`. A linked worktree is still `repo`; worktrees resolve against `--git-common-dir` so they land beside siblings.

### Protocol

- `pi/project/workspace` `{ cwd, rescan? }` → `WorkspaceShape`. **Host answers** from git alone; no worker is started. Worker throws “answered by the host”.
- `pi/project/isolation/set` `{ cwd, isolation }` → `{ project }`. Settings scope.
- `AgentRun.isolation?: { mode, shape, reason }` optional for old persisted runs.
- `ProjectInfo.agentIsolation?: "decide" | "isolate" | "share"`.

### Harness

- `start_agent` never fails because of workspace shape.
- `worktree`: `true` (default) = isolate if possible; `false` = share; `"strict"` = demand isolation or refuse with D-156 wording (git, or `worktree: false`).
- Isolation is on `start_agent`’s result, the `AgentRun` record, and `inspect_agent`.
- Worktrees use `--git-common-dir` so a worktree of a worktree lands under the main checkout’s `.worktrees/`.

### Settings

Per-project control in Settings → Projects, using the existing `Segmented` control and tokens only:

Isolate agents · Share my checkout · Decide per agent (default).

Stored on `ProjectRegistry` (`projects.json`), same drawer as trust. Live workers are updated through `pi/project/isolation/set`.

## Decisions for the orchestrator (`D-n`)

**Workspace method authority is the host.** `pi/project/workspace` is git parsing only. The viewer needs it for projects with no live worker, the same reason the host answers `pi/session/list`. The worker still resolves shape internally for `start_agent`.

**Isolation default lives on the project registry, not prefs.** Closest existing pattern is project trust: a small per-project enum in `projects.json`, mutated by one protocol method, returned on `ProjectInfo`. Prefs is a namespace drawer for UI chrome; project env is a separate store because values are sensitive. Isolation is neither.

**Isolation precedence (pinned in `decideIsolation` and tests).**

1. `worktree: false` always shares. The project default cannot override an explicit share (D-156).
2. `worktree: "strict"` always demands isolation and refuses without it. The project default cannot override that.
3. `worktree: true` / absent follows the project default: `"isolate"` behaves as `"strict"`; `"share"` shares; `"decide"` (default) isolates if `workspaceCanIsolate`, else shares and says why.

**A repo that lists submodules is `bare-or-submodule` but still isolatable.** `.gitmodules` marks the shape as unsupported for the viewer this leap. The harness still isolates when `show-toplevel` succeeds. A bare repository with no working tree cannot isolate.

**`core-instructions.md` was not changed.** It is the ADHD writing guide prepended to custom agents and does not describe `worktree`. The model-facing truth is the `start_agent` JSON schema, its prompt guidelines, the role block in `packages/pi-extension/src/modules/subagents.ts`, and `docs/agents.md`.

**`packages/pi-extension` was updated as a required caller.** The tool schema and `StartAgentInput.worktree` live there. The type change (`boolean | "strict"`) updates every caller in the same change set.

## Commands and results

| Command | Result |
| --- | --- |
| `pnpm install --frozen-lockfile` | Already up to date |
| `pnpm -F @lasercode/protocol test` | 423 passed |
| `pnpm -F @lasercode/protocol build` | identity check clean; tsc ok |
| `pnpm -F @lasercode/pi-extension test` | 203 passed |
| `pnpm -F @lasercode/worker test` | 1102 passed, 4 skipped |
| `pnpm -F @lasercode/ui test` | 2632 passed, 1 skipped |
| `pnpm -F @lasercode/host test` | L1 tests passed (`router.test.ts` 43, `projects.test.ts` 11). Worker-spawn tests that use a fake worker fail in this session because inherited `LASERCODE_RUNTIME_*` pins from the running app reject temp worker mains. Real-worker e2e (`host.e2e.test.ts` 12) passed after the worker was built. Not an L1 regression. |
| `pnpm -r typecheck` | all 10 packages ok |
| `pnpm identity:check` | after staging new files |

No browser acceptance, Playwright, or `scripts/browser-check` was run.

## Left out

- Fleet-row rendering of isolation (another worker owns `packages/ui/src/fleet/**`).
- Filesystem watchers to invalidate the shape cache (not in this leap; rescan is explicit).
- Viewer empty states for the five shapes (L5 overlay / telemetry).
- Changing `core-instructions.md` (see decisions).
