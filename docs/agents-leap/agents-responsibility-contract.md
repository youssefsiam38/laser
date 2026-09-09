# Agents LEAP — binding responsibility contract

**Runtime ownership (D-134):** this LEAP completely replaces `pi-subagents` with our own implementation. Keep the Pi coding-agent engine. Upstream code and scripts are learning references only; no upstream API, storage format, runtime dependency or patch requirement is binding. See the [source study and replacement blueprint](implementation-study/README.md). Existing integration descriptions below are baseline evidence, not the target architecture.

This section must be incorporated into the final implementation prompt. It specifies the agreed architecture; it does not claim the current implementation already satisfies it.

## Product terminology

Use **Agent name** and **Agent definition** in the product. “Characters in the game” is an explanatory metaphor for agents’ first-class identity and reusability, not a separate product entity or UI vocabulary.

| Term | Meaning |
| --- | --- |
| Agent name | The name on a reusable agent definition; not its assignment role or session title |
| Agent definition | Reusable name, instructions, model, capabilities and access to other agents |
| Assignment | The agent’s role and task in a particular configuration, including explicit assignment overrides |
| Session | One conversation/execution instance using an agent definition, with its own state and history |

Use **Create agent**, **Agent name**, **Agent definition** and **This assignment** consistently across navigation, forms, inspector tabs, onboarding and help. Do not label those surfaces “Character name” or “Character definition.” Worker, validator, creator, verifier and orchestrator remain assignment roles or execution relationships, never separate agent types. Every saved agent remains available for direct user chat and authorized delegation.

## 1. Product rule

Laser is a configurable coding-agent system with one first-class agent catalog. It supports ordinary conversations, persistent goals and optional, composable collaboration patterns through one agent/session/task foundation.

**An agent has a reusable definition. Root, child, creator, verifier and orchestrator describe an execution's relationship or assigned role; they are not different classes of agent. Every saved agent can start the user's conversation and can be selected for delegation by an authorized agent.**

No definition has a `subagentOnly` classification, requires a duplicate root definition, or becomes less editable/chatable because it has previously been delegated. Chat, Genie and Namer retain their product integrations and required policies, but share this definition model and can also be opened directly. A missing model or required workspace produces an actionable configuration state, not a permanently hidden agent.

The user chooses the agent's instructions, available capabilities and which already-created agents it can access. An agent can work alone, delegate without a workflow, coordinate only through delegation, use creator/verifier arrangements, exchange direct messages, negotiate, broadcast or combine these behaviors. These names describe engineering examples only. The mission guide is an example users must be able to construct, not the architecture every agent must follow.

**One visual editor, one configuration model and one execution system.** Users create an agent and configure its capabilities, access to other existing agents, relationships and any required coordination rules in the same interface. A single agent, a parent connected to one worker, and a larger arrangement use the same components and semantics. Complexity comes from what the user adds, not from choosing a simple or advanced mode.

Instructions are not enough: configured permissions, dependencies, shared inputs, checks and outcomes have explicit schemas, visible effects and runtime enforcement. Instructions guide the agent within those rules. Agents remain first-class agents; no framework taxonomy, mandatory role triad, separate workflow setup or second authoring product is required. Reusable configurations and editable examples are included in this same editor. The former blanket ban on visual authoring is superseded; upstream engine vocabulary stays internal.

Deliver the entire agreed LEAP as one complete waterfall scope, including the unified visual editor and execution semantics, shared-state control, Genie/Namer and acceptance proof. No incremental releases, dated delivery periods, deferred editor, MVP omissions or disabled placeholders. Dependency ordering describes implementation prerequisites, not partial product deliveries.

**`/goal` owns autonomous continuation toward the session objective. Workflows organize execution. Mission records preserve evidence and progress. All parent continuation requests pass through one coordinated execution path.**

These responsibilities apply when those features are used. Ordinary agent chat, delegation and peer messaging require neither a goal, a workflow nor a mission record. One execution owner per session does not mean one mandatory orchestrator agent for the whole team. A peer-delivered input may request an ordinary turn through the recipient's queue; if that session has an active goal, the same coordinator serializes it with goal continuation. Transport acknowledgements and telemetry never create an independent goal loop.

Do not introduce a second goal system, automatically activate a goal from a workflow, or adopt pi-subagents' separate `goal: true` mission mode. Preserve Laser's budget-free Goals, canonical state, existing safety behavior and durable completion history. Ordinary workflow execution and mission records remain usable without that upstream goal mode.

## 2. Responsibility table

| Owner | Owns | Boundary |
| --- | --- | --- |
| User | Objective, instructions, explicit decisions, pause/stop/resume and required approvals | An agent cannot approve its own action or silently reverse a user pause |
| Agent definition | Reusable identity, instructions, model, capabilities and directed access to other definitions | The same definition serves direct user chat and delegated work; role is assigned to an attempt |
| Agent configuration relationships and rules | Versioned access, participants/steps, shared inputs, conditions and outcomes configured in the unified editor | One schema/runtime for any configuration size; adding an edge grants only its explicit semantics, saving starts no work and creates no separate goal loop |
| Parent/orchestrator agent, when used | Task decomposition, assignments, evaluation of evidence and requests to complete or revise work | An optional role; requests execution through shared task machinery without bypassing ownership, dependencies or approvals |
| Communicating peer | Authorized messages, replies, proposals and shared evidence | Communication grants neither transcript ownership nor control of another agent's execution |
| `/goal` engine | Current goal ID/objective, autonomous parent continuation, wait/pause/resume and accepted completion | It does not independently schedule workflow steps or treat an unfinished child as a reason to launch its replacement |
| Internal dependency executor, when used | Declared steps, readiness, assignments, validation/rework transitions and execution progress | Upstream workflow implementation stays internal; it cannot independently start a competing parent turn or declare its goal complete |
| Shared state/evidence owner | Versioned requirements, assertions, step links, decisions, artifacts, results and handoffs | Our own revisioned execution/resource storage; persistence has no autonomous loop or mandatory product-level mission entity |
| Session/task coordination | Ownership, active attempts, dependency waits, ordered event delivery, deduplication and reconciliation | This is deterministic coordination, not another autonomous agent; it integrates with the existing goal engine |
| Child agent | Its assigned task in its own session and isolated worktree | It does not inherit an active parent goal or write the parent's transcript; additional delegation follows the same policy |
| Command executor | One command process, output, deadline, lifecycle and supported controls | Returning a background task ID means launched, not succeeded; background promotion never executes the command twice |
| Genie | Read-only investigation, explanations and concrete action proposals | State-changing actions and agent launches require explicit user confirmation in Laser's UI |
| Fleet/UI | Accurate presentation, navigation, requested controls and approval interaction | UI visibility is not execution ownership; opening, hiding or viewing a task does not complete, stop or approve it |

## 3. Package boundary

- **Protocol:** engine-neutral definitions, IDs, state/event schemas, commands and acknowledgement shapes. No Pi imports.
- **Owned Pi-native execution implementation:** replace pi-subagents while retaining the Pi engine; apply definitions, delegation and goal/workflow coordination behind the worker/companion boundary. A new package extraction requires an explicit import-boundary decision and tests.
- **Worker:** hosts the Pi runtime and applies the resolved configuration; one Laser worker per execution cwd. Keeps both session drivers compiling.
- **Companion extension:** translates the execution package's capabilities, events and requests to Laser protocol through modules. Do not create a second bridge package or move orchestration logic into presentation code.
- **Host:** process supervision, durable product state, task/session ownership registry, catalog, routing and recovery. It may enforce neutral execution constraints but must not implement a competing LLM continuation loop or import Pi.
- **UI:** agent editing, session controls, approvals, Genie conversation and capacity-aware panels. It sends intents to the authoritative owner.

Product behavior is not implemented solely as instructions to the model. Ownership, mandatory isolation, async policy, approval enforcement and duplicate-event protection must be enforced by code at their respective boundaries.

### Unified visual configuration

The agent editor is the single authoring interface. It combines a React Flow canvas with an inspector for the selected agent, relationship, rule or shared resource. The inspector is part of that editor, not a second simple form or advanced interface. Keyboard/touch equivalents operate on the same objects and validation.

A user can create an agent, set instructions and tools, connect one existing worker with permission to delegate, save and chat. That is a complete small configuration in the editor. Access alone does not impose a scripted sequence: the parent can decide when to invoke its allowed worker. A non-delegating agent is one node with no outgoing launch grants. Neither case requires naming a workflow, filling irrelevant condition fields or switching pages/modes.

For more structured work, the user adds relationships, shared resources, prerequisites, checks and outcome rules in the same canvas and inspector. Only relevant properties appear for the selected object; there is no Basic/Advanced toggle or separate coordination wizard. Existing identities, positions and settings persist as the configuration grows. Removing optional rules returns to a smaller configuration without a conversion, migration or alternate executor.

| Configurable rule | Required semantics |
| --- | --- |
| Allowed agent access | Directed grant to existing definitions, with separate launch/message/context actions; granting access alone never launches a task |
| Participants and assigned work | Stable step IDs referencing agent definitions, assignment, context policy, expected outputs and permitted session overrides; one definition may appear in several steps without being cloned |
| Start/dependency conditions | Explicit user start or defined task event, all/any prerequisites, typed conditions on real results and required artifacts; success, failure, cancellation and unavailable evidence stay distinct |
| Messages and shared inputs | Authorized recipient/channel edges, correlated request/reply, versioned payload schemas, resource references and read/write policy; no implicit access to all sessions of a definition |
| Validation and outcome routing | Required checks with evidence bound to the actual reviewed revision; configured pass/fail/needs-input routes and visible corrective attempts |
| Parallelism and resource access | Concurrent work where permitted, serial access to named shared resources where required, locks/leases enforced by the resource owner and surfaced in the live view |
| Stop, rework and completion | Explicit stop conditions and retry/rework bounds with human escalation; no automatic restart of user-ended work and no added Goal budgets |

Conditions and transitions use validated data rules, not arbitrary code evaluated from a graph label. Free-text instructions guide reasoning; they do not override a configured dependency/check or approve a protected action. Optional user-defined protocols extend payloads through the established contract.

The canvas and its property inspector edit one canonical configuration. Adding more relationships/rules must not change the semantics of existing allowed-agent edges. Distinguish access edges, dependency edges, messages and shared-resource edges in both schema and UI. Validate dangling targets, unsupported tools/models/protocols, missing inputs, contradictory rules, impossible gates and forbidden dependency cycles before activation. Communication cycles are valid; rework uses explicit transitions/attempt identities and configured bounds. Do not accidentally forbid legitimate self-delegation merely because a layout example bans self-edges.

Saving produces a durable configuration revision and starts nothing. Start binds exact configuration/agent/resource references to the execution and performs preflight before effects. A read-only preview explains which work can start and what is missing without launching agents or running commands. Every launch still obeys async isolation, capability and approval rules.

Editing a saved arrangement does not silently rewrite active work. Provide explicit application of a revised configuration to active work: show affected queued/running/completed tasks, reconcile dependencies and changed validation evidence, then apply through the execution owner. Running tasks keep their launch snapshots unless explicitly controlled; completed outcomes remain history. Permission revocation is enforced at subsequent protected operations and queued starts, and never silently changes recipients. User cancellation takes precedence over a pending re-plan.

Users can duplicate an agent or arrangement, reuse their own saved configurations, and start from editable examples described by outcomes such as “Build and check.” These are optional starting material, not a required framework catalog or a separate class of agent. No configuration/graph action requires raw JSON, a terminal or drag-only interaction; detailed structured editors remain available for advanced schemas.

### Configurable capabilities and agent access

- Use stable definition IDs/revisions for saved relationships; names and role labels are display values. Resolve the same definition/configuration contract for a root or a child in every worker process, including nested launch and recovery.
- In the editor, **Agents this agent can access** selects existing definitions. Specify permitted operations on those edges: delegate, message and applicable shared-context access. Direction matters: A → B does not imply B → A, permission to read every B conversation, or authority to stop B. An empty delegation list means no targets; newly created agents do not silently join existing lists. Support explicit self-access with ordinary depth/concurrency safeguards.
- Separate permission to launch agents from permission to message existing sessions, receive/reply, publish/subscribe and read shared artifacts. Turning delegation off blocks every launch route, including workflows and indirect management tools; it need not disable authorized peer communication. Runtime-authored ownership reports and stop receipts remain available regardless of optional peer tools.
- A definition can have no tools, ordinary coding tools, delegation tools only, or any supported combination. Keep **tools this agent may execute itself** separate from **capabilities it is authorized to invoke through allowed agents**. A delegation-only coordinator can call a coding agent with editing tools without gaining those tools itself. User-imposed restrictions on the whole delegated task, including Genie's read-only scope, still propagate.
- Agent access is checked at each hop. If A may delegate to B and B may delegate to C, B → C can be allowed even when A cannot directly call C. Do not flatten each definition's direct list into an inherited whole-tree restriction. Explicit task/subtree capability ceilings remain distinct and may restrict that chain; show which policy denied a launch.
- Distinguish unavailable capabilities from disabled ones. Give extensible capability/protocol IDs and configuration schemas a validated provider/feature integration path through the existing Pi-native package/adapter boundary. Instructions and skills can compose installed capabilities; naming a nonexistent tool or protocol cannot make it executable. Do not hard-code role names to grant tools.
- Enforce permissions against resolved identities at launch/delivery/execution, not only by filtering the editor or tool description. A model cannot grant itself another agent, widen a child override or bypass a disabled operation through a generic command route. Recheck revoked access before queued work starts; preserve history and explain rejected delivery rather than silently changing recipients. A graph edit alone never cancels an already-running child.
- Tool selection is not an OS sandbox. An unrestricted shell/custom extension can perform operations outside a narrow named-tool list; reject incompatible capability claims or constrain those execution routes before promising enforced read-only/no-delegation behavior. Keep existing product approvals and single-writer guarantees across all strategies.

### Communication and user-defined protocols

Use a shared durable transport with composable model-visible operations: discover authorized endpoints, send, request/reply, publish/subscribe, report progress, share evidence, and record proposals/resolutions. These are operation semantics, not prescribed final tool names. A delegation-only setup does not need peer or broadcast tools loaded.

Messages target exact session/attempt or authorized channel IDs, not merely an agent's name: one agent definition can have several simultaneous sessions. Creating another instance is a distinct launch and follows launch/isolation/approval policy. Routing through the host is transport, not a requirement that a parent model relay peer messages.

The runtime supplies a versioned envelope: message ID, authenticated sender definition/session/attempt, recipients or channel, conversation/correlation/reply IDs, message kind, protocol ID/version, schema-validated payload and artifact references, timestamps, delivery policy and receipts. The model cannot forge sender identity or a user approval. Request/reply has an explicit wait/timeout outcome; a mutual wait remains visible and cannot deadlock cancellation or user input.

Users may define reusable message payload schemas and interaction instructions for their own protocols, including creator/verifier result formats and proposal/counterproposal/acceptance exchanges. Known protocol versions must agree; malformed, unsupported or incompatible messages yield an explicit failure. Custom payloads remain data, not executable extensions or new permission grants. New external wire transports need an actual integration, not a renamed JSON payload.

Sending messages to one or multiple authorized recipients is an optional capability, including between user-started root sessions. Validate each recipient and subscription; a broadcast records its recipient set and per-recipient pending/delivered/rejected outcomes. Delivery receipt means accepted by the recipient's owner, not proof the model has read, understood or obeyed it. Replies are correlated and follow an explicit reply grant; permission to send is not unrestricted reverse access. Persist useful messages for the user and authorized participants without copying every private transcript into a global log. Product controls describe the actual capability rather than presenting a named collaboration framework.

Negotiation is a user-defined interaction protocol with proposals, counterproposals and an explicit recorded resolution. Messages alone cannot acquire a resource lock, mutate a shared contract or approve an action: the authorized owner performs that transition atomically. Peer communication graphs may contain cycles; cancellation ownership remains a separate acyclic tree/forest. Workflow dependency graphs and retry attempts retain their own validation rules.

## 4. Identity and ownership

Each session records its agent definition/revision and effective configuration. Each workflow and task has a stable ID, an owning session, and an execution-attempt identity. Goal-linked work also records the goal ID and objective revision. Record dependencies explicitly by task/step IDs. Several sessions may use the same definition concurrently with separate state, instructions for the assignment and histories; saving one agent definition never makes its session a singleton.

Separate relationships from ownership: a fork, a delegated child and a Genie assistance session are different relationships. Merely referencing a session does not make Genie part of that session's cancellation tree. Only explicitly owned execution descendants participate in cascading cancellation.

A live session has exactly one transcript writer. Opening it from the sidebar, Fleet or Genie attaches to its owner. Resume or takeover requires verified ownership transfer before another runtime writes. Viewing a child cannot open a second independent driver for its transcript.

Resolve every child worktree's selected Git ref to a commit at launch and record that commit. Use a distinct path under the canonical repository's `.worktrees/`. Do not copy, stash or commit parent edits implicitly. A validator reviewing implementation must start from the implementation's committed result, not automatically from the original base. Non-Git handling remains a separate product choice; it cannot silently bypass the mandatory isolation policy.

Every delegated agent starts asynchronously, including nested and workflow launches. Neither a model parameter nor a saved profile can override that invariant. Asynchronous launch does not remove dependency barriers.

## 5. Continuation and dependency contract

1. Persist/register a launch's ownership and identity before acknowledging it. A retried request must not create another execution of the same logical launch.
2. The parent may continue independent work while children or commands run.
3. When the parent's next required work depends on active tasks, record the wait set and coordinate it with the existing goal wait mechanism. Do not repeatedly prompt the model to check whether the tasks have finished.
4. Task events update authoritative state first. They then make eligible workflow steps or the waiting parent runnable. The workflow executor does not separately inject an autonomous turn into a goal-controlled parent.
5. Serialize dispatch per session and deduplicate event handling. A goal continuation, a child completion and a user message arriving together must not create competing parent runs or duplicate child launches. Preserve the existing user-message queue semantics.
6. Handle completion-before-wait registration, multiple simultaneous completions, repeated notifications, reconnect/replay and interrupted dispatch. Delivery may repeat; its state-changing effect must not.
7. A task failure or request for user input is an outcome requiring handling, never a successful dependency. Only eligible steps proceed.
8. Events for a paused, cancelled, completed, replaced or older-revision goal remain inspectable but cannot silently reactivate it or satisfy unrelated current requirements.
9. On restart, reconcile durable state with verified process/session ownership before resuming. Unknown execution outcome is not permission to repeat a potentially effectful command.

A workflow started without `/goal` executes its explicitly arranged work under one owner. It must not activate an indefinite goal loop on its own. If a goal is explicitly activated while a workflow already exists, link or hand over continuation ownership atomically instead of running two parent controllers.

## 6. User controls and completion

| Action | Required effect |
| --- | --- |
| Pause goal | Apply existing goal pause behavior and suspend further goal-owned workflow step transitions. Already-running children and commands may finish their current work; show this explicitly |
| Completion arrives while paused | Record its result and update Fleet; do not launch the next workflow step or resume the parent automatically |
| Resume goal | Re-evaluate recorded dependencies and consume available results before launching anything new |
| Stop goal and its tasks | Stop parent continuation and cancel explicitly owned running/queued execution descendants. Retain transcripts, results and worktrees; do not stop unrelated work |
| End a child | Open the reason modal described below; after user confirmation, cancel the selected execution and report the reason to its parent |
| Stop one command | Cancel that command; record the dependency as cancelled so its owner can handle it |
| Edit goal | Advance the objective revision and reconcile linked requirements, waits and steps before further dispatch; stale results are not automatically valid evidence for the changed objective |
| Clear goal | End and remove active goal controls according to current engine behavior. Do not imply that this deletes history, stops detached work or discards worktrees; expose the separate stop-all control |
| Complete goal | Accept only after required task outcomes and validation evidence satisfy the current objective; preserve upstream's terminal completion behavior and actual completion record |
| Archive shared work/evidence | Change record lifecycle only; never manufacture goal completion or silently cancel running tasks; no separate mission-management product is implied |

Cancellation is a request until the execution owner acknowledges termination. Show stopping or failed-to-stop states honestly. An explicit stop must not be undone by an automatic retry. Commands and children cannot be meaningfully “paused” unless the executor implements that capability; do not present cancellation as resumable process suspension.

Optional long-lived services are not automatically completion blockers. Their retention or termination must be explicit. Required work cannot be relabeled optional merely to pass the completion gate. Goals gain no budgets or separate usage accounting; session/task telemetry must not double-count shared work.

## 7. Genie confirmation contract

Genie can read sessions/logs and answer questions freely. Before any state-changing action or agent launch:

1. Present a concrete proposal identifying the operation, target and relevant changes.
2. Wait for an explicit UI confirmation. Textual intent, opening the proposal, silence and model-generated “approval” are not confirmation.
3. Bind the approval to that action and target. A material change requires another confirmation; reject a stale proposal whose target state invalidates it.
4. Execute through the authoritative owner and report the actual result or failure. Cancellation executes nothing.

Enforce the rule for direct file edits/writes, effectful Bash commands, bundled Laser commands and delegation. Read-only classification must cover the actual operation, not a model-supplied label. A delegated agent must not become a route around Genie's confirmation requirement; read-only investigation children remain read-only, and additional actions need their own approved scope.

An approved launch may create the explicitly described child session/worktree as part of that operation. It does not grant blanket authority to change settings or perform unrelated actions. Explaining an existing approval never answers that approval on the user's behalf.

## 8. Every child is a full conversation

The user can inspect and chat with **every** Laser-managed child: standalone, workflow step, nested child, reviewer and Genie child. Workflow membership must never downgrade a child to a summary card or a steer-only form. This is a release requirement, not a best-effort capability.

- Register a canonical child session when launch is accepted. Link it from the sidebar, Fleet, workflow node and parent tool disclosure. Each link opens that same conversation.
- Expose the complete retained user-visible transcript, including available reasoning, tool requests/results, artifacts, changes and user/parent messages. Load history incrementally without replacing older content with a summary. Do not invent provider reasoning that was never supplied; normal transcript disclosure and retention policies still apply.
- Provide the normal composer, streaming replies, queued input, attachments and applicable session overrides/approvals. Show whether a message was sent by the user, parent or another authorized agent. A full chat is not a second input stream outside the existing owner's queue.
- A workflow child remains approachable while running, waiting, failed, completed or user-ended. A later user message can explicitly start a new attempt in that session; it does not rewrite the terminal result of the original workflow attempt or automatically reopen its completed workflow step.
- Preserve read position, draft, selection and disclosures when moving between graph, dock and main conversation. Closing an inspector never stops the child.
- Persist user redirections and configuration overrides. Report material changes to the parent so it does not continue relying on the original assignment after the user changed it. Treat an authorized user correction as an instruction; do not let an older queued parent instruction silently undo it.
- Keep ownership transfer, context restoration and model/feature configuration working after the original parent exits. A dead parent must not permanently strand a retained child as an unchatable card.

Our replacement must supply these capabilities on every managed launch path through its owned execution implementation and adapter. Hiding the composer for workflow children does not meet this contract. Previously discovered external/legacy records with unavailable transcripts must state what is missing; new Laser-managed launches cannot use that legacy limitation as their product behavior.

## 9. Parent/child tool and reporting contract

The following are required operation semantics. Map them onto supported package APIs where possible and add neutral protocol schemas for missing behavior; the table is not a claim that all operations already exist in Laser.

| Operation | Required request/context | Required acknowledgement/result |
| --- | --- | --- |
| Launch child | Parent session, selected agent/revision, task, expected outcome/checks, context policy, selected base commit, optional workflow step and goal/revision, launch request ID | Accepted/failed, task ID, child session ID, attempt ID, actual model/config, worktree/base commit, control and output references; returns immediately after registration |
| Send message/request/reply | Message ID, runtime source identity, exact authorized recipient session/attempt or channel, protocol/version, correlation, payload/attachments, delivery mode | Durable delivery receipt: queued, delivered, rejected or failed, with a reason; no false “sent” when the inbox closed; replies remain correlated |
| Report progress | Task/attempt, sequence, timestamp, milestone/activity summary, completed/remaining work, blocker or requested input, evidence references | Persisted acknowledgement; the same report is available to the parent and user |
| Read state/output/changes | Stable task/attempt, cursor or revision and bounded requested range | Authoritative lifecycle, latest progress, changed-file summary, diff/output references, availability/freshness and next cursor |
| End child | Operation ID, target attempt, authenticated user or authorized owning agent, required reason, cancellation scope, originating user-message reference when applicable; UI confirmation for direct user controls and where the applicable policy requires it | Request receipt followed by terminal acknowledgement, actual stop outcome, parent delivery status and preserved partial-artifact references |
| Complete child | Assigned outcome, completed/remaining work, tests/checks, artifacts, change summary, known issues | Runtime-verified terminal outcome and durable handoff; workflow dependency resolution refers to this exact attempt |

**Separate model reports from measured state.** A child can report “implementation complete; validation pending.” It cannot make a process terminal or claim verified test success simply by choosing a status string. Tool activity, exit codes, Git state, acknowledgements and lifecycle come from their authoritative executors. Store report provenance so the parent and UI can distinguish claims from evidence.

Reporting has two channels:

1. **Execution telemetry:** tool starts/ends, current activity, output, process state and observed file changes, supplied by the runtime without extra model calls.
2. **Semantic checkpoints:** meaningful milestones, blockers, decisions and handoffs produced by the child. Supply our own model-visible reporting operation with durable progress/artifact receipts; describe its schema and purpose in the child's tool/instruction contract.

Send compact, deduplicated milestone/control/outcome messages into the parent's context at safe boundaries. Do not inject a new parent turn for each token, tool tick or diff refresh. Full output remains retrievable by reference; milestone reports are persisted even while the parent is busy or paused. The continuation rules above decide whether an event can wake the parent.

**Launch acknowledgement, progress and completion are distinct.** An async launch tool may finish with an explicit “accepted/running” receipt while the child task continues. A completed launch invocation must not make the child node appear complete. During a genuinely running tool invocation, partial rendering uses assistant-ui's artifact channel; do not mutate an already-final tool result into a fake live stream. Subsequent child events use their own durable identities and render as attributed child activity.

### Changes and final handoff

- Identify the worktree, selected base commit, current commit and observation revision. Report changed paths with status, additions/deletions where meaningful, and a diff reference. Distinguish staged, unstaged, committed-since-base and untracked changes without double-counting them.
- Live diff collection is read-only. It must not stage, commit, clean, remove synthetic files or otherwise change the worktree merely to display progress. Capture meaningful snapshots after mutations or at a bounded cadence; retain last-good data with a stale/error indication.
- Handle renames, binary files, untracked files, large/truncated output and paths with spaces. “Unavailable” is different from “no changes.” Summaries can be bounded; the complete retained patch or file artifact must be accessible on demand.
- Bind validation results to the actual reviewed commit/diff revision. A newer mutation invalidates an older clean review for the changed scope.
- Final handoff includes outcome, task delta, exact change/diff references, verification commands and exit codes, constraints, remaining work, user intervention and artifact locations. Cancellation still produces a runtime-authored partial handoff if the child cannot respond. Label it as captured state; never fabricate the child's final words.

### Installed pi-subagents reference evidence for the replacement

Inspected `pi-subagents@0.65.1` through `packages/worker/node_modules/pi-subagents`:

- `src/shared/types.ts:918` — `AgentProgress`: activity, current/recent tools, recent output, timing, model and usage. These are useful telemetry fields; this alone is not a delivered parent progress-report protocol.
- `src/shared/types.ts:399` — `ParallelHandoffPatch` and child handoffs: diff statistics, patch/output/session paths, workflow key and run identity.
- `src/shared/types.ts:1215` — `SingleResult`: progress, transcript/session reference, artifacts, structured output, acceptance and terminal flags.
- `src/workflows/workflow-receipt.ts` — persisted receipts join stable workflow keys to run attempts and retain resumability/outcome references.
- `src/runs/background/control-channel.ts:54` — upstream `StopRequest` already supports `reason`. Laser's `packages/host/src/subagents/control.ts` currently omits that field from `StopInput` and its written stop request. The replacement must carry the reason end to end and verify its persistence/delivery rather than inheriting this gap.
- `src/extension/control-notices.ts` — attributed control notices and deduplication exist; async notices can trigger a turn, so they must participate in the agreed goal coordination.
- `src/runs/shared/worktree.ts:1001` — final patch capture currently removes synthetic paths and performs `git add -A`. **Do not call this finalization routine to refresh the live Changes view.** Define our own artifact contract and read-only observer for live diffs; upstream formats are not a compatibility requirement.

## 10. User-ended children and reason delivery

Every UI path that ends a child execution—sidebar menu, graph node, Fleet, child conversation and keyboard command—opens the same accessible modal. Closing or archiving a conversation is a separate operation and must not impersonate ending its work.

Modal content:

- Title: **End this agent?** Show the agent, current task and owning parent.
- Ask **Why are you ending it?** Require a non-empty reason. Offer quick reasons such as “No longer needed,” “Wrong direction” and “I'll take over,” plus editable text. Preserve the person's selected/written reason.
- Explain that the reason will be shared with the parent, current work will stop, and the conversation and changes will be kept. Show any owned descendants affected by the cancellation.
- Actions: **Keep running** and **End agent**. Escape/cancel executes nothing. The child may continue while the modal is open; show if it finishes before confirmation and do not claim it was terminated afterward.

For a user-requested stop of multiple children, one modal can collect one reason and show the exact affected set. Persist that reason on each affected cancellation; do not open a chain of modal prompts.

After confirmation, persist the control intent and reason before issuing cancellation. Show **Stopping**, then the actual acknowledged outcome. A delivery failure remains actionable and retryable without losing the reason. The UI must not depend on the child voluntarily writing a final response to terminate it.

The parent receives a durable, attributed control event containing the operation/task/session/attempt IDs, `initiator=user`, verbatim reason, requested/acknowledged times, actual outcome, last progress, retained diff and artifact references, and affected workflow steps. Parent input must distinguish a user-ended attempt from a crash, timeout or successful completion. A duplicate stop request must not duplicate cancellation or parent messages.

If the parent is offline or paused, retain the event for replay without violating the pause rule. Show pending versus delivered notification honestly. Block automatic replacement of the user-ended assignment; the parent may explain the consequences, continue unaffected work, or ask about a new approach, but must not silently restart the cancelled task. A later explicit user instruction can authorize a new attempt.

### User direction through the parent

The user can also message the parent with a correction or request such as “Stop the research and focus on the implementation.” The parent can decide to end its owned child through its permitted control tool. Require an agent-supplied reason and retain the initiating agent/session, original user-message reference when relevant, exact target/scope, request and acknowledgement. Do not attribute the parent's inferred reasoning to the user verbatim.

The direct user **End agent** button still opens the reason modal. An ordinary authorized parent tool call does not automatically require another human modal; it follows its configured approval policy. Genie's explicit-confirmation requirement continues to apply. User-directed stops retain the no-silent-replacement rule; for an agent's own cancellation, any later attempt follows the configured task policy and is visible as a new attempt. Ending a peer requires separate control authority; a messaging edge is insufficient.

Expose both routes in the same live view: user message → parent decision/tool → child stopping → acknowledged outcome. If the parent declines or the stop fails, show the actual result; never turn an instruction into a fabricated successful control event.

### Transparent context, shared state and control

The user must be able to inspect and control all Laser-managed participants and their owned work from the live view. Agent-to-agent access restrictions do not hide the user's own children, messages or shared work from the user. Expose root and nested conversations, current actions, pending input/approvals, state, tool/output records, changed files and actual controls; retain completed and ended attempts.

Shared information has an inspectable source: stable resource ID/path, owner, revision/content hash, current content, change history where retained, permissions and the agents authorized to use it. Link observed reads and writes to their source tool/message and the exact revision or snapshot captured. Distinguish **can access**, **provided in context**, **read at revision** and **current latest**. Do not claim a model has read or understood a newer revision merely because it could access it.

Route structured shared-state updates through their owner with revision checks and durable events. For user-authored shared files, observe real read/write activity and retain relevant snapshots/references without making a second competing state store. If a custom tool reads outside instrumented paths, state that provenance is unavailable; instrument supported routes rather than claiming universal observation. Keep normal credential redaction and unavailable provider reasoning boundaries explicit—transparency is about actual retained work, not invented hidden thoughts.

The user can read shared state, open its source, edit supported resources through the owner, and send the change to selected agents. Show a concrete editable revision; detect conflicting edits, retain the resulting history and notify affected participants without implying the new state was already consumed. An unsupported inline format opens the existing appropriate editor; it must not become an inaccessible node.

The control surface routes messages, queued input, settings/allowed-agent changes, approvals, termination and supported retries through canonical owners, showing pending/succeeded/failed effects. Do not display unsupported pause/resume/rewind actions as if they work. Changing state, viewing it and asking an agent to act on it are separate events. A user can redirect any child directly or direct its parent while preserving one writer and the actual affected execution scope.

## 11. Visual projection contract

Use `@xyflow/react` substantially for the live agent/task maps described in [Agents live experience](agents-live-experience.md). This is an inspectable control surface, not just status visualization. React Flow owns canvas interaction and graph presentation; it is not the task scheduler, session store or chat runtime. assistant-ui continues to own conversation and adopted content elements.

Graph nodes, session rows, tool disclosures, diff views and Fleet rows are projections of the same canonical IDs. Clicking any agent can open its full conversation. Report actual observed topology: distinguish allowed-definition access, execution ownership, workflow dependencies and actual messages. An allowed edge does not mean work is running or a message was sent. Label inferred information. Layout or node dragging cannot mutate a running workflow's execution dependencies.

## 12. Required proof

The implementation is incomplete until meaningful host/worker integration and UI interaction tests demonstrate:

- The same saved agent starts a direct user session and runs as a delegated child with the same definition revision/capability semantics; no clone or root-only/child-only type is required. Built-in definitions remain directly selectable with their integration policies intact.
- One agent runs with no delegation; another delegates without workflows; a delegation-only coordinator calls an editing worker without receiving editing tools itself.
- A → B → C succeeds when the per-hop lists allow it; A → C fails when absent; an explicit inherited task ceiling still constrains C. Empty, renamed, removed, revoked, self and cyclic definition references have defined tested behavior.
- Creator/verifier, direct peer exchange between independent roots, scoped broadcast, negotiation and a user-defined schema/version protocol run through the same machinery. No mandatory triad, workflow, mission or goal is inserted.
- Disabled launch/message routes reject direct, workflow, generic-command and nested bypass attempts; session overrides cannot widen a user-imposed ceiling. Peer messaging does not steal ownership or confer stop/transcript access.
- Multiple sessions of one definition route messages unambiguously; reconnect, duplicates, unsupported protocol versions, partial broadcast failure, revocation and mutual waits preserve delivery truth and user control.
- In the unified editor, a user creates a parent with access to one worker and delegates from chat without a separate workflow page, mode or required execution plan; zero-delegation configurations work normally.
- That same editor authors, validates, saves, reloads and executes richer dependencies, messages, shared inputs, checks and outcome routing. Growing or simplifying a configuration requires no mode switch, conversion or second execution system; the whole editor is included in the completed LEAP.
- Graph and form edits remain consistent; configuration revisions, preflight failures, explicit application to active work, user cancellation races and retained result history are covered.
- Plain language and editable examples guide use of the single editor without a mandatory framework taxonomy or role triad. User-authored names remain intact; contextual controls expose relevant rules without overwhelming a small configuration.
- Shared information can be inspected and edited through its owner; latest content, supplied context and observed read revisions are distinguished. Conflicting updates and uninstrumented reads are reported honestly, and inspection does not mutate the source.
- A user can direct the parent to end an owned child; the tool reason, user-message link, actual stop outcome and retained work appear alongside direct user termination. Genie approvals still apply, and failed control never renders as successful.
- A goal launches a child, waits and continues from its result without duplicate launch or continuation.
- An independent parent action can continue while unrelated child work runs.
- Completion before wait, simultaneous completions and replay produce correct single effects.
- Paused goals retain arriving results without dispatching more work; resume consumes those results.
- Stop-all cancels the owned tree, preserves unrelated work and is not reversed by late events/retries.
- Worker and validator sessions do not inherit the active parent goal, including fork-context cases.
- Failed validation prevents dependent completion; a passing review checks the actual implementation commit.
- Opening/resuming a child never creates a second transcript writer.
- Explicit, manual and automatic command backgrounding retain the original process and task identity.
- Goal edits/clear/replacement, mission closure and app restart cannot revive stale work or report false completion.
- Genie reads without prompts, but mutation and agent-launch attempts cannot execute through any tool route without the required UI confirmation; denial and stale approvals have no effect.
- Running, waiting, completed, failed and user-ended children remain fully inspectable/chatable, both inside and outside workflows and after reload; later chat does not rewrite the original attempt outcome.
- User and parent messages retain attribution and honest delivery receipts when racing with completion, inbox closure, overrides or reconnect.
- Every child-ending UI path requires a reason; cancel does nothing; reason and partial changes reach the parent once even if it is paused/offline or the child cannot produce a final response.
- Live diff observation leaves the Git index and working files unchanged, correctly covers committed/uncommitted/untracked/binary changes, and identifies the revision a validator checked.
- The React Flow experience passes the visual, keyboard, touch, performance and resize acceptance scenarios in its companion specification.

These are observable runtime guarantees. A clear prompt, an agent's promise to behave, or a rendered Fleet row is not sufficient evidence.
