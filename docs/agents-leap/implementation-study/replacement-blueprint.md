# Replacement blueprint for the implementer

**Binding direction:** remove the production dependency on `pi-subagents` and implement its required delegation/coordination responsibilities ourselves. Preserve Pi 0.85.0's coding-agent engine and the existing driver seam. This blueprint proposes internal decomposition; it does not add a second product or implementation mode.

## One model, one editor, one execution system

Keep reusable **agent definitions**, role-bearing **assignments**, independent **sessions**, and concrete **run attempts** distinct. Every agent definition can begin a direct user chat or supply a delegated assignment. No child-only agent type. A simple parent/worker configuration has fewer objects and rules in the same editor used for complex coordination.

Use an internal versioned execution definition for agent references, directed capability/access grants, context/resource bindings, dependencies, checks, result routes and explicit repeat/stop conditions. The React Flow canvas and its structured inspector edit that model. Tools submit the same operations as the UI through the same service. The live canvas is a projection of runtime records, not a second source of truth.

The upstream scripting study demonstrates useful semantics. It does **not** require exposing upstream `runs.*`, preserving its JavaScript syntax, or compiling arbitrary JavaScript back into the canvas. Custom expressions/protocols need defined supported semantics and validation. Extensibility means new registered capabilities and user-authored compositions can participate in the same runtime; a magic string cannot create an implementation.

## Responsibility and component map

| Component | Owns | Must not own |
| --- | --- | --- |
| Neutral protocol/schema | Definition/assignment/session/attempt IDs, revisions, command/event envelopes, result/evidence contracts, validation | Pi imports, renderer placement or filesystem-specific upstream formats |
| Definition resolver | Revisions, supplied context, effective models/tools/features, per-hop agent access, task restrictions, launch snapshot | Mutable ambient `.pi` discovery or role-name privileges |
| Host execution coordinator | Durable launch intents, admissions, dependencies, capacity, reconciliation, routing to worker owners, catalog | Pi model loop, a second autonomous goal mechanism |
| Worker/Pi-specific execution modules | Apply resolved definition to SDK session, enforce actual tool availability, prompt/steer/abort, translate SDK lifecycle | Independent product schema, hidden child conversations or blanket ambient resources |
| Companion adapter | Model-callable delegation/report/message/control operations and engine-neutral events | Private bespoke UI or direct renderer manipulation |
| Conversation/message service | Durable inbox/outbox, exact recipients, correlation, broadcast receipt set, session input serialization | Granting control authority merely because peers can communicate |
| Resource/evidence service | Revisioned shared state, context manifests/read records, artifacts, changes, tested commit/result lineage | Silent last-writer-wins updates or invented evidence |
| Workspace/process supervisor | Committed-base provisioning, process identity, writer leases, stop settlement, retention and explicit integration | Copying dirty source edits, treating UI closure as completion, PID-only kills |
| Goal integration | Existing `/goal` continuation with dependency waits and current-objective completion validation | Mission goal loops, goal budgets or workflow-owned objective continuation |
| UI | One editor, complete live control, child chats, stop reason modal, shared-state inspector and Genie approvals | Deciding outcomes from animation or bypassing effect checks |

Implementation location must respect current import rules: host/protocol/UI remain Pi-free; worker and companion own Pi-facing code. If extracting a new reusable Pi-native workspace package requires changing the present import allowlist, record and test that boundary explicitly rather than silently violating AGENTS.md. Do not import this reference snapshot into the application.

## Commands must survive interruption

Recommended lifecycle ordering:

```text
validate request + resolve definition/input/commit revisions
  → persist intent and required approval state
  → reserve attempt identity, directory ownership and capacity
  → record launch admission and worker assignment
  → create workspace / acquire session writer / start session
  → append events, inputs, checkpoints and resource observations
  → settle execution + retain changes and validation evidence
  → durably publish result + deliver idempotent parent receipt
  → evaluate eligible dependency transitions under current authority
```

UI/model/API requests must converge before effectful operations. A changed revision invalidates a stale approval or requires explicit reconciliation. If the host crashes after an intent is recorded but before launch confirmation, inspect the reserved attempt/owner before deciding whether to start or recover it. Do not promise distributed exactly-once effects; use idempotency keys, durable ownership and explicit uncertain states.

Cancellation records intent first, prevents new dependent work, requests abort from the proven owner, preserves partial output/diffs, and records actual settlement. A timeout waiting for acknowledgement is “unconfirmed,” not “stopped.” Parent and user both see provenance and the same result. A stop barrier cannot be erased by replay or auto-retry.

## Remove/replace integration map

Paths describe the current Laser baseline; inspect their tests before changing them. These are coordinated implementation changes, not work already done by this study.

| Current surface | Replacement action |
| --- | --- |
| [worker manifest](../../../packages/worker/package.json), root lockfile | Remove exact upstream dependency when the owned runtime is wired; regenerate lockfile and packaged dependency evidence |
| [stable SDK driver](../../../packages/worker/src/drivers/stable-sdk.ts) | Replace upstream extension/skills/prompts loading with owned capabilities; apply the same agent definition to root and child sessions; retain `.laser` overrides and disabled `.pi` discovery |
| [driver interface](../../../packages/worker/src/driver.ts) and both drivers | Extend neutral session open/control contracts without breaking Chord or the seam test |
| [companion subagents module](../../../packages/pi-extension/src/modules/subagents.ts) | Replace upstream RPC topics, symbol registries and completion observers with owned operations/events; preserve panel projection identity and truthful receipts |
| [companion entry](../../../packages/pi-extension/src/index.ts) | Review upstream child-env registration guard; our child sessions still need their explicitly permitted owned capabilities |
| [host subagents layer](../../../packages/host/src/subagents/layer.ts), [file discovery](../../../packages/host/src/subagents/file-layer.ts), [status parser](../../../packages/host/src/subagents/status.ts) | Replace runtime truth based on upstream directories/indexes/status shapes with owned persistence and discovery |
| [host controls](../../../packages/host/src/subagents/control.ts) | Replace file-inbox transport assumptions; carry mandatory user reason, command ID, actor, target revision and actual delivery/settlement receipts |
| [host missions](../../../packages/host/src/subagents/missions.ts), [panels](../../../packages/host/src/subagents/panels.ts) | Use our execution/resource records; do not infer graph dependencies from upstream traces or retain a separate mission-goal driver |
| [worker pool](../../../packages/host/src/worker-pool.ts), [server](../../../packages/host/src/server.ts), [router](../../../packages/host/src/router.ts) | Retire/adopt workers using owned liveness and active work; maintain one worker per directory and one writer per session |
| [extension protocol](../../../packages/protocol/src/pi-extension.ts), [host log store](../../../packages/host/src/logstore.ts) | Define neutral event schemas and update routing/search projections; keep IDs stable across live/file/catalog views |
| [worker packages](../../../packages/worker/src/packages.ts), [host packages](../../../packages/host/src/packages.ts) | Remove obsolete upstream install-script approvals/curation entries as appropriate; do not expose package management as the new product |
| [desktop clean-machine gate](../../../packages/desktop/scripts/clean-machine.mjs), [builder template](../../../packages/desktop/electron-builder.yml.tpl) | Prove owned runtime code/resources ship and a real packaged session can launch/control a child; retain general executable-source preservation rules for remaining dependencies |
| Existing Fleet/panel/session/settings UI | Connect to new contracts; full child conversation/control and one agent editor are required, not merely recolored upstream statuses |
| [goal policy package](../../../packages/pi-goal/README.md) | Preserve patched budget-free goal behavior and its regression tests; integrate dependency waits without a competing driver |
| [AGENTS](../../../AGENTS.md), [architecture](../../architecture.md), [agent-work UX](../../ux-agent-work.md), research/upstream notes | At implementation, revise current-tense “does not replace packages” and file-layer assumptions; keep historical findings explicitly historical |

Do a repository-wide reference search at integration completion. References in history, legal notices and this study may remain; runtime imports, symbol lookups, config envs, package feature loading and tests expecting a live upstream runtime must be removed or replaced. Do not delete unrelated packages or general transport/panel infrastructure merely because comments mention upstream.

## Historical data and cutover

No upstream API/storage compatibility is required for new execution. Preserve existing user conversations and worktrees. An optional read-only historical reader may display old records without becoming a runtime dependency; if omitted, make archival/export treatment explicit. Never auto-resume an upstream attempt through the new engine using an unverified session file. Existing live upstream work needs a user-visible completion/stop/retention disposition before its runtime owner is retired. Waterfall delivery does not authorize destroying ongoing work.

The documentation snapshot must not ship as executable runtime resources. Keep MIT notices for any source actually adapted. Do not treat prepared upstream patches (M3-T9) as prerequisites for D-134's replacement.

## Dependency order for the complete delivery

1. Define contracts and persisted state transitions, including origin/authority, goal ownership, revisions and failure outcomes.
2. Implement shared definition resolution and session ownership behind the existing driver seam.
3. Implement durable admission/launch/control/result transport, committed workspaces and evidence capture.
4. Implement dependencies, conditions, joins, repeated attempts, communication and shared-resource semantics using those same operations.
5. Bind `/goal`, user input and Genie effect approvals to those operations; prove race/recovery behavior.
6. Connect the unified editor/live control/conversations/inspectors and all LEAP supporting capabilities to real data.
7. Complete cutover, source/dependency removal, packaged runtime validation and the full acceptance matrix.

These are implementation dependencies within one complete delivery, not releases, iterations, dates or deferred feature tiers. The source study does not narrow the rest of the LEAP's visual experience, browser capability, agent creation, onboarding or model evaluation requirements.
