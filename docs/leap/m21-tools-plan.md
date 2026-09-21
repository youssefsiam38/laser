# M21-T17 · Model tools and execution linking — working plan and checkpoint

Owner: worker "Model tools and execution linking", branch
`agents/model-tools-and-execution-linking-8e648f17`, base `bb9592b2`.
Binding text: [`../project-lifecycle-leap.md`](../project-lifecycle-leap.md)
("Protocol and authority", "Execution and convergence", "Cross-session
mentions and context", "Flexibility"), under
[`../agent-tool-contract.md`](../agent-tool-contract.md) (D-350),
[`../design-phase.md`](../design-phase.md) ("`/design` — three forms",
"Tools") and [`../research-phase.md`](../research-phase.md) ("Tools").
Companion checkpoints: [`m21-spine-plan.md`](m21-spine-plan.md) (the host
authority T1–T4 and the task engine T15),
[`m21-design-index-plan.md`](m21-design-index-plan.md) (deviation 1: the
registration steps), [`m21-research-plan.md`](m21-research-plan.md) ("What the
host owner must enforce", "M21-T17 wiring steps"),
[`m26-plan.md`](m26-plan.md) (the fixture recipe and the preview shape).

Write set: `packages/worker/src/project-work/**`,
`packages/worker/src/{server,driver}.ts` and
`packages/worker/src/drivers/stable-sdk.ts` (agent-option wiring),
`packages/worker/src/tool-eval/**` and the fixtures move,
`packages/pi-extension/src/modules/project-work.ts` + `src/index.ts`,
`packages/protocol/src/project-work-bridge.ts` (new) with the
`RUNTIME_MODULE_NAMES` / `LASER_TOOL_NAMES` additions,
`packages/host/src/project-work/methods.ts`, `src/worker-client.ts`,
`src/worker-pool.ts`, `src/server.ts`, and this file.

## What this task is, in one paragraph

The model's half of the project lifecycle: **one** companion module
(`project-work`) that registers the compact lifecycle surface, the Design
Index tools and the Research tools, all behind one typed bridge from the
worker to the host authority; the context packet the implementation attempt
reads; and the execution link that is written before an attempt's first
prompt. Nothing above the worker imports Pi, nothing here is a second writer
on a project's work, and the host re-checks every rule a tool call could
claim to have obeyed.

## Decisions

- **D-356.a — one bridge method, not sixteen.** The worker→host link carries
  a single request family, `project/work/bridge`
  (`packages/protocol/src/project-work-bridge.ts`), whose params are
  `{ agent, request: { method, params }, research?, attempt? }`. `request` is a
  closed union over the sixteen `project/work/*` / `project/task/*` methods
  and their existing strict param schemas, so a new lifecycle method is
  reachable from a tool the day it exists and nothing about the envelope has
  to change. The envelope, not the fd-3 link, is what carries the calling
  agent's provenance; the **authority** (actor class, project) is the host's
  own and is never read from the params.
- **D-356.b — the link is now bidirectional, and only for this.** The worker
  answered requests and sent notifications; it could not ask the host
  anything. `WorkerServer.hostRequest()` sends a JSON-RPC request with a
  `w<n>` id (a string, so it can never be confused with the host's own
  numeric request ids) and `WorkerClient` answers inbound requests through
  one `onRequest` hook. The hook is not a general road: the host's router
  refuses every method but `project/work/bridge` on it, because a client's
  method surface and a worker's are different authorities.
- **D-356.c — the host resolves the project from the worker it spawned.**
  The bridge never trusts a `projectId` for *authority*: the host maps the
  worker's own `cwd` (a worktree resolving to its parent project) to the
  owning project and requires every mutation to name it. A mutation naming
  another project is refused with the owning project's name and the offer to
  open a session there (leap, "Cross-session mentions and context"); a
  **read** of another project is allowed, which is what makes a cross-project
  mention useful and a projectless Chat able to read at all.
- **D-356.d — a research write crosses as its operation, not its body.** The
  bridge's optional `research` field carries the `ResearchOperation`
  (D-351.a). The host reads the current body, runs `applyResearchOperation()`
  — confidence rule, citation on `answered`, `unanswerable` needing a next
  step, findings never edited, derived status — and stores **the applier's**
  body through `project/work/revise`, ignoring whatever body the params
  carried. A tool that skipped the worker's pre-check therefore changes
  nothing. `attention` and `staleRefs` come back on the bridge result.
  The **excerpt and digest** checks stay in the worker and are not re-run
  host-side: the fetched text lives in the worker's per-project research
  cache and never crosses the link (`m21-research-plan.md`, "Excerpt in
  digest"), and a host that passed `{ digest, text: "" }` as the read record
  would refuse every finding that carries a quote. Stale propagation along
  the artifact graph is the store's own, on the revision the write makes;
  the operation's `staleRefs` are returned for the tool and the UI.
- **D-356.e — the attempt is one bridge call.** `report_project_task` with
  `action: "link_execution"` sends `project/task/link-execution` plus an
  `attempt` envelope (`workspace: worktree | shared`, `checkout`). The host
  writes the execution link and one supporting evidence record naming the
  workspace shape and the checkout, so the attempt's shape survives in the
  store without a new protocol field and without the checkout path ever being
  returned to a model.
- **D-356.f — bodies cross as bounded JSON text.** `write_project_artifact`
  takes `body_json`: the typed body serialised, bounded, validated by the
  host's own `projectWorkBodySchema`. A body schema written out inside a tool
  input would be tens of kilobytes of JSON Schema in every request, would
  duplicate a versioned protocol type in a second place, and would still be
  re-validated host-side. The refusal on a malformed body names the failing
  path and the call that shows the shape.
- **D-356.g — the surface is gated by what the session really has.** A
  session with no project gets `inspect_project_work` alone (cross-project
  reads); a project session gets the four lifecycle tools; the three Design
  Index tools appear only with a design index bridge; the four Research tools
  only with the adapters that are switched on. An absent tool is absent, never
  listed as unavailable.
- **D-356.h — the context packet is refreshed where the role block is.** It
  is appended at `before_agent_start`, the same model-call boundary D-140's
  role/goal context uses, so a packet can never be older than the turn it is
  read in. It is bounded per section and as a whole, and every line that did
  not come from this session carries `[from …]`.

## The request shapes the UI needs (M21-T6, M21-T7)

- **Start a Task in a session.** The UI decides the session (existing
  eligible / new top-level / agent run) and then calls the host's own
  `project/task/link-execution` before the first prompt — the same method the
  bridge forwards. The worker-side helper that builds the packet is
  `contextPacketFor()`; the UI does not build it.
- **`/design implement @Design`.** The `/design` command sends the whole
  input as one prompt, as T6 does for the other forms. The session's
  `project-work` module recognises a first prompt of the exact form
  `/design implement <ref>` (`DESIGN_IMPLEMENT_PATTERN`) and injects the
  hand-off packet for that revision at the next model-call boundary — tree,
  index entries used, strategy, host region, fixtures, unresolved comments
  (`docs/design-phase.md`). The UI sends:

  ```jsonc
  { "method": "session/prompt", "params": { "path": "…", "content": [{ "type": "text", "text": "/design implement DES-4" }] } }
  ```

  Nothing else is required of the UI: the ref may be a key (`DES-4`) or an
  `entityId`, and an `@`-mention chip's human form (`@design:DES-4`) is
  accepted too.

## Checkpoints

- **Claimed.** Read the binding docs, the spine/design/research/M26 plans and
  the code they name; wrote this plan.
- **Protocol.** `project-work-bridge.ts`: the envelope, the closed request
  union, the research and attempt extras, the wrong-project refusal shape, the
  policy row (`project_write`, `native`). `RUNTIME_MODULE_NAMES` gains
  `project-work`; `LASER_TOOL_NAMES` gains the eleven tools.
- **Transport.** Worker `hostRequest`/`hostResponse`; host `WorkerClient`
  `onRequest`, pool `onWorkerRequest`, router in `server.ts`.
- **Host authority.** `ProjectWorkMethods.handleBridge()`: project
  resolution, wrong-project refusal, trust and scope, the research gate, the
  attempt evidence.
- **Worker.** `src/project-work/`: the bridge, the four tools, the context
  packet, the `/design implement` hand-off packet, the session assembly.
- **Extension.** One module, eleven registrations, the packet at
  `before_agent_start`.
- **Tool-eval.** The Design Index and Research fixtures moved into the matrix
  (`test/fixtures/tool-eval/`), four lifecycle fixtures added, the scripted
  project-work world (`src/tool-eval/project-work-world.ts`), and the runner
  now builds all three worlds and resolves the placeholders the replay tests
  already resolved (`{{revision}}`, `{{stale}}`, `{{finding}}`,
  `{{entry:…}}`, and `{{revision:KEY}}` for a lifecycle fixture).
- **Done.** `pnpm tool-eval`: all 42 runs pass, 21 fixtures across 2 profiles.

## What the fixtures had to change, and why

- **Budgets.** The registered surface grew by eleven tools, so every prompt in
  the matrix is bigger. The research and design fixtures' `inputTokens`
  budgets moved to 70 000 against a measured 37–65 k. The budget measure is
  the cost of the surface, so it follows the surface rather than the reverse.
- **`inspect_design_index` and `read_source` truncation.** Both declared the
  truncation measure with a byte ceiling their answers never reached in the
  matrix (they were only ever replayed against the handlers before). Each now
  really narrows: the design fixture lists twenty entries and then asks for
  five, and the read fixture reads 300 bytes of a page and then the rest in a
  256-byte window. A chain of ranged reads has to end on a page that is not
  itself truncated, which is why the second read is a tail read.
- **`body_limit` is a page size.** `PAGE_SIZE_NAMES` in
  `packages/protocol/src/tool-contract.ts` grew by one name, with the tool
  that introduced it, exactly as `docs/agent-tool-contract.md` says a new
  page name is added.

## Not done here, and where it belongs

- **The UI half.** The Start… choice (existing eligible session / new
  top-level session / agent run) and the `/design implement` command are
  M21-T6/T7's; this task publishes the request shapes above and the
  worker-side packet builder they drive.
- **M20 checkpoints, diffs and repository links on an attempt** are M21-T18's
  (`PLAN.md`). What lands here is the attempt's identity, workspace shape,
  checkout and base commit.
- **A Research run's own command and budget line in the fleet** are M21-T13's
  surface; the worker builds one `ProjectResearch` per session over the
  bridge's store, which is what the four tools need to exist at all.

---

# M21-T18 · Checkpoints, changes and delivery evidence

Binding text: [`../project-lifecycle-leap.md`](../project-lifecycle-leap.md)
("Repository provenance", "Execution and convergence"),
[`../source-control-leap.md`](../source-control-leap.md) §E and §G, D-345.
Base: the M21 spine (T1–T4, T15), T17's bridge, M20's checkpoints and git
actions.

## What this task is, in one paragraph

An implementation attempt stops being a claim and becomes a **record read out
of git**: every attempt carries, per repository of its workspace shape, the
commit it started from, the M20 checkpoints it made — resolved to commit object
ids at record time — the change between the first and the last of them, the
paths that change touched and the commits it added. Those paths are the
observed side of T15's scope conflicts. An exact change becomes *the delivery*
only through an explicit acceptance, which stores a bounded canonical capture
before it accepts, so the evidence is still reviewable after retention prunes
the checkpoint ref. Nothing here ever resolves a missing object to `HEAD`.

## Decisions

- **D-357.a — the host reads git itself.** `packages/host/src/source-control/read.ts`
  is a read-only plumbing layer (repositories of a checkout through the one
  shared workspace resolver, object ids, checkpoint refs, `diff --raw`
  fingerprints, one file's bytes at one commit). The authority over what an
  attempt did has to be the same process that stores it: the worker is not
  running when a person accepts a delivery, and a record assembled from a tool
  call is exactly what the leap forbids. `project-work/delivery.ts` turns those
  reads into attempt facts; `project-work/captures.ts` turns a change into the
  durable capture.
- **D-357.b — `ProjectWorkMethods.handle` is async.** Git is a subprocess, and
  three methods now need it before they can answer. The router already awaited
  the value it returned, so nothing above the authority changed; the internal
  callers (`researchWrite`, the attempt-shape note) await it too.
- **D-357.c — `implemented_by` has one door: accepting delivery.** A
  `project/work/link` payload with `relation: "implemented_by"` is refused and
  pointed at `{ type: "delivery", …, confirm: true }`, which is person-only
  (D-332's shape: an agent reports and proposes, a person accepts), names the
  exact `RepositoryChangeRef`, verifies the digest against the diff that is
  actually in the repository, stores the capture, and only then writes one link
  per accepted subject revision. The method inventory stays sixteen: the link
  *payload* union grew, as evidence and decisions already do (spine decision 5).
  A new `PROJECT_TASK_ACTIONS` member was rejected for the reason T15 gives —
  every action there maps to a state, and accepting delivery changes none.
- **D-357.d — `based_on` is written for a write that came from a session with a
  checkout.** That is the bridge: the host resolves the worker's own checkout,
  and records one `based_on` per repository at the exact commit it was on. A
  person editing a Spec in the workspace gets none, because "the project folder's
  current `HEAD`" is a guess, and this record exists to replace guesses. The
  links come back on the write as `basedOn`, and a failure to write them never
  undoes the revision.
- **D-357.e — an attempt that ends is the attempt that started.** Closing an
  attempt (`outcome`/`endedAt`) updates the open link for the same kind and
  target instead of inserting a second row. The row that carries the base commit
  and the checkpoints has to be the row that carries the terminal outcome, or
  "an attempt records base, checkpoints and outcome" is not true of any row.
- **D-357.f — "the checkpoints it made" is decided by turn, not by clock.**
  Each repository record keeps `sinceTurn`, the turn that session's checkpoints
  had already reached when the attempt started; the attempt's own checkpoints
  are `turn > sinceTurn`. A ref's `creatordate` has one-second resolution, and
  two attempts in the same second must not inherit each other's work. The time
  window remains the fallback for an attempt with no recorded start.
- **D-357.g — the diff digest is taken over `git diff --raw`.** Status, path
  and the two blob object ids per file: exact (two contents can never share it),
  bounded by the number of files rather than their size, and unaffected by
  context, colour or whitespace settings, none of which change what was
  delivered.
- **D-357.h — a capture is a bounded manifest plus head-side source.** At most
  500 files listed, 100 captured whole, 128 KB each, 4 MB in total; binary,
  deleted and over-budget files are listed with why their bytes are not there.
  A full durable budget refuses the gate with the recovery action and accepts
  nothing (`ProjectWorkQuotaError`, code -32011).
- **D-357.i — a state link has no capture.** `verified_at` names one commit and
  no difference, and a bounded capture of a whole tree is not a thing this store
  will hold. The rule for it at a gate is therefore: the commit must still exist,
  or the decision is refused naming it.
- **D-357.j — a git action emits a link-ready ref, and the UI decides.**
  `commit`, `push` and `pr/create` answer with `linkRef` on `outcome: "done"`:
  the full commit object id (identity) plus branch, remote name and pull request
  (display context). The worker writes no link; the person accepts a delivery
  with it. A preview, a refusal and an uncertain outcome carry none.

## Known gap, and the one line that closes it

The worker's `executionShape()` lives in `packages/worker/src/server.ts`, which
this task may not edit, so it does not yet set `sessionPath` on the execution
shape. The plumbing is complete on both sides — `ProjectWorkExecutionShape.sessionPath`
→ `attemptEnvelope()` → the bridge envelope's `attempt.sessionPath` → the host's
`checkpointSessionKey` — and the client path (`project/task/link-execution`
params) already carries it. Until that one line is added, a bridge-opened
attempt selects its checkpoints by `sinceTurn` and its own time window across
every session in the checkout rather than by session key, which is exact for one
session per checkout and imprecise for two concurrent ones (the case the
shared-checkout conflict already warns about). Whoever next owns
`packages/worker/src/server.ts` should add
`...(live.path ? { sessionPath: live.path } : {})` to `executionShape`.

## The shapes the Task detail (UI) consumes

| Read or write | Shape |
| --- | --- |
| `project/task/link-execution` | `{ link, entity, seq, attemptEvidence?, conflicts?, attemptRepositories? }`; `link.repositories[]` is `{ repositoryId, name, base, sinceTurn, checkpoints[{turn,ref,commitObjectId,createdAt}], change?, changedPaths[], commits[], unavailable? }` |
| `project/task/link-execution` params | `execution.sessionPath?` — the session whose checkpoints the attempt is reading. Stored as a derived key; never echoed back |
| `project/work/get` | `repositoryLinks[].display?: { branch?, remote?, pullRequest? }` and `repositoryLinks[].executionLinkId?` — the attempt a delivery came out of |
| `project/work/get { include: { repositoryStatus: true } }` | `repositoryStatus: [{ linkId, sourceAvailable, missing[], captureAvailable, captureBlobId?, detail? }]` — opt-in, one git read per repository |
| `project/work/create` / `revise` | `basedOn?: RepositoryLink[]` when the write came from a session with a checkout |
| `project/work/link` (accept delivery) | params `{ type: "delivery", entityId, revisionId, executionLinkId?, repositoryId, change, covers?, display?, supersedesLinkId?, confirm: true }` → `{ link: { type: "delivery", links: RepositoryLink[], capture?: { blobId, bytes, files, sources, truncated? } }, seq }` |
| `project/work/link` (raw `implemented_by`) | refused: "A change becomes the delivery by being accepted as one, not by being linked." |
| `project/work/blob/read { blobId: captureBlobId }` | the `RepositoryCapture` as canonical JSON: `{ version, createdAt, repositoryId, repositoryName?, change, files[], sources[], truncated? }` |
| `pi/project/git/{commit,push}`, `pi/project/pr/create` | `linkRef?: { repo, objectFormat, commitObjectId, branch?, remote?, pullRequest? }` on `done` |

The Task detail's attempt row therefore reads: attempt number, profile, branch,
outcome, and per repository "N files changed across M checkpoints", with
**Accept as delivery** offering `change` straight from the record. A link whose
`repositoryStatus` says `sourceAvailable: false` shows its recorded ids and
"read the capture" — never a fabricated current diff.

## What landed

| File | What it owns |
| --- | --- |
| `packages/protocol/src/project-work.ts` | `AttemptCheckpointRef`, `AttemptRepositoryRecord` (+ schema), `RepositoryLinkContext`, `RepositoryLinkAvailability`, `RepositoryCapture*`, the attempt/capture bounds, `ExecutionLink.repositories`, `RepositoryLink.display`/`executionLinkId` |
| `packages/protocol/src/project-work-methods.ts` | the `delivery` link payload, `execution.sessionPath`, `include.repositoryStatus`, `repositoryStatus` and `basedOn` on results, `attemptRepositories` on a link-execution result |
| `packages/protocol/src/project-work-bridge.ts` | `attempt.sessionPath` on the envelope |
| `packages/protocol/src/git-actions.ts` | `GitActionLinkRef` and `linkRef` on commit/push/PR-create |
| `packages/host/src/source-control/read.ts` | read-only git for the host |
| `packages/host/src/project-work/delivery.ts` | repository identity for a checkout, current states, attempt facts, link availability |
| `packages/host/src/project-work/captures.ts` | building, storing and reading back the bounded canonical capture; the gate refusals |
| `packages/host/src/project-work/methods.ts` | async `handle`, `based_on` on a bridge write, attempt facts on link-execution, delivery acceptance, evidence kept reviewable before approve/`done`, `repositoryStatus` on a read |
| `packages/host/src/project-work/store.ts` | schema v2 columns, attempt facts on the execution link, the `implemented_by` refusal, `acceptDelivery`, `attachCapture`, observed paths from attempts |
| `packages/worker/src/git-actions/{git-ops,service}.ts` | `linkRefFor` and the `linkRef` on commit, push and PR create |
| `packages/worker/src/project-work/{bridge,session,tools}.ts` | `sessionPath` on the execution shape, `attemptEnvelope()`, the attempt's repository rows on `report_project_task` |
| `packages/host/test/project-work/delivery.test.ts` | 14 tests over real git repositories in temp dirs, through the router and the bridge |

## Evidence

`pnpm -F @lasercode/protocol test` (668) · `env -i … pnpm -F @lasercode/host test`
(1172; `project-work/delivery.test.ts` 14) · `pnpm -F @lasercode/worker test`
(1499) · `pnpm -r build` · `pnpm -r typecheck` · `pnpm identity:check` ·
`pnpm verify`.
