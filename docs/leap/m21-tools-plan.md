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
