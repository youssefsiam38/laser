# First-class agents LEAP — discovery and decisions

**Runtime ownership (D-134):** this LEAP completely replaces `pi-subagents` with our own implementation. Keep the Pi coding-agent engine. Upstream code and scripts are learning references only; no upstream API, storage format, runtime dependency or patch requirement is binding. See the [source study and replacement blueprint](implementation-study/README.md). Existing integration descriptions below are baseline evidence, not the target architecture.

Status: one universal agent catalog, one visual editor/configuration model and one execution system support configurations of any size, with enforceable coordination rules and transparent live control. The complete scope ships as one waterfall LEAP. Remaining unspecified details can be labeled proposed defaults when the final prompt is requested; no further user action is required to prepare it. This is a specification and source audit, not an implemented rewrite.

**Binding implementation requirements:** incorporate [Agents responsibility contract](agents-responsibility-contract.md) and [Agents live experience](agents-live-experience.md) into the final prompt. They define authoritative owners, package boundaries, full child conversations, progress/state/diff reporting, reasoned termination, Genie approvals, the substantial React Flow experience and required proof. They govern the explanatory recommendations below.

## Confirmed follow-up decisions

- **Product terminology:** use **Agent name** and **Agent definition**, with **Assignment** for a configuration-specific role/task and **Session** for a conversation instance. “Character” is an explanatory metaphor only, not a UI label or separate entity. See the [terminology contract](agents-responsibility-contract.md#product-terminology).

- **One kind of agent:** every saved definition can start the user's conversation or be invoked by another authorized agent. Root, child, creator, verifier and orchestrator are relationships/assignments of an execution, never fixed agent classes. This includes built-ins with their required product policies intact.
- **User-selected capabilities and access:** while defining an agent, select its tools/features/instructions and which already-created agents it can access. Distinguish permission to delegate, message and access shared information. Empty access grants nothing; direction matters; several sessions may use the same agent definition. Disabling delegation does not prevent direct user chat or independently permitted messaging.
- **One unified visual editor:** a lone agent, parent → worker delegation and a detailed arrangement use the same canvas, property inspector, configuration schema and runtime. No separate simple/advanced interfaces, workflow-setup requirement or alternate execution system. Optional rules are added to the same configuration; users with one relationship do not fill unrelated fields.
- **Instructions plus enforceable controls:** users configure allowed-agent access, messages, shared inputs, dependencies, checks, outcome conditions, resource constraints and stop/rework rules visually. Instructions guide reasoning within those rules. Full authoring, reusable configurations, editable examples and live inspection/control are included; the previous blanket ban on coordination editors is superseded. Framework names remain examples, not mandatory roles or choices.
- **One complete delivery:** implement the entire LEAP as a waterfall scope with one completion gate. No incremental releases, time-period plan, deferred editor, MVP split or placeholders. Dependency ordering expresses prerequisites only. Runtime events, timing evidence and bounded rework are execution semantics, not a delivery schedule.
- **Transparent live control:** show every participant's real work, conversations, changes, messages, shared content and observed read/write revisions. The user can interact directly, edit supported shared state through its owner, or direct the parent to act, including ending an owned child. Attribute who actually requested the stop and why; distinguish a direct user reason modal from an agent control tool under its applicable approval policy.
- Child worktrees start from **only the selected committed Git state**. Resolve the selected ref to a commit at launch and record it. Do not copy the parent's uncommitted edits, stash them, or commit them implicitly. Our replacement must support that committed snapshot without changing a dirty source checkout; do not inherit upstream’s clean-checkout restriction.
- Genie may use the bundled Laser command interface through ordinary Bash, but **actions require explicit confirmation in the Laser UI**. A natural-language request or the model calling a command is not the required UI confirmation. Show the concrete proposed action and target, and execute only after the user confirms. Enforce this at the execution boundary for every effectful route, including direct file tools and Bash, so Genie cannot bypass it by avoiding the command interface. Agent launches must be covered. Confirmed: Genie may read sessions/logs and answer freely; state-changing actions and agent launches require confirmation.
- The shared agent/session/task foundation keeps `/goal` as the autonomous continuation mechanism. Internal dependency execution may organize work and shared records retain evidence; neither is a named collaboration-framework product or another goal loop. The binding responsibility contract governs all communication patterns.
- Every child is a full, inspectable conversation with normal chat controls, including workflow, standalone, nested and completed children. All entry points open the same canonical session; continuing a conversation creates a later attempt without rewriting its original workflow result.
- Every user control that ends a child requires a reason modal. Persist the reason, cancel through the actual owner, retain the conversation/changes and deliver an attributed outcome to the parent, including after reconnect. No automatic replacement of a user-ended assignment.
- Parent/child tools need explicit launch, messaging, progress, state, changes and completion semantics. Runtime telemetry and child milestone reports are distinct; the parent receives compact durable reports and retrievable diff/artifact references. Live diff observation must not stage files; the pinned package's final patch-capture routine does stage files and cannot be reused as a live observer.
- React Flow must substantially power both the unified visual editor and live work/control map, with full agent chat, changes, shared information and controls. The supplied skill is grouped under `docs/agents-leap/skills/react-flow`, with its original entry point retained. Universal definitions, shared-state control and the sole goal continuation owner remain binding; the later unified-editor decision supersedes D-128's blanket authoring restriction.

## Explaining `/goal`, workflows and missions

The following workflow/mission terms explain source mechanisms and historical conflict analysis. The product expresses useful coordination directly in the unified agent editor: relationships, work, dependencies, checks and shared information. Users need no framework taxonomy or separate setup. Existing Goals remain as agreed; visual configuration does not create a competing goal loop.

| Concept | Responsibility | Example |
| --- | --- | --- |
| Agent | Who performs work and with which instructions/capabilities? | Implementer, reviewer, researcher |
| `/goal` | Why should the session continue working automatically? | Keep working until sign-in is fixed and verified |
| Workflow | How is work arranged? | Investigate → implement → independently test → repair if needed |
| Mission record | What must remain known across many steps or sessions? | Requirements, validation contract, dependencies, results and handoffs |
| Fleet | What is running or needs attention? | Worker session, test command, reviewer session |

**Agreed architecture:** preserve `/goal` as the existing automatic-continuation mechanism. Make multi-agent workflows a way that the goal's agent can perform the work, with mission data serving as its durable plan and record. Do not expose pi-subagents' separate `goal: true` mission mode as a second Laser goal system, or introduce its goal budgets. Ordinary missions and delegated execution do not require adopting that separate mode.

Ordinary conversation, direct delegation and authorized peer messages run on the same agent/session/task foundation without requiring a goal or a named framework. A user-configured sequence can execute once without `/goal`; its explicit steps still have one execution owner. Multiple ways to organize work must not create competing controllers for the same session or impose a global orchestrator on independent peers.

The current conflict is behavioral, not a duplicate command name. Installed pi-goal listens for the parent finishing and settling, then can dispatch another turn. An asynchronous child returns its run ID before finishing. Without explicit dependency coordination, the parent may continue when it should wait, potentially duplicating a delegation. Pausing the parent goal also does not stop detached children. Goal completion and mission closure currently have separate state. These are verified independent mechanisms; duplicate work is a risk, not a claim that it occurs on every run.

The existing reference's discussion of **Laser Goal budgets is stale** relative to the installed workspace policy patch. `packages/pi-goal/README.md` and the current code establish that Laser Goals have no budgets or separate usage accounting. pi-subagents' goal-mission mode still requires its own budget. That is another reason not to copy that mode into Laser's product model.

Required integration behavior, governed by the binding responsibility contract:

1. Link each delegated task and workflow to its owner and, where applicable, the exact current goal ID. Keep one authoritative objective; a workflow contains subordinate task instructions, not a competing top-level objective.
2. If independent work remains, the parent may continue. If all next steps depend on active tasks, record those dependencies and make the goal wait. A registered completion/attention event wakes it; periodic model polling is unnecessary.
3. Serialize and deduplicate completion events and scheduled continuations. Handle completion arriving before the wait is recorded, multiple completions together, goal edits and late events for an old goal.
4. Route dependent workflow transitions through one owner. A workflow executor may advance its declared steps, but must not independently re-prompt a parent already controlled by `/goal`.
5. Do not copy the active parent goal into worker or validator sessions. A child gets its assigned task; independently activating a goal in a child is a separate explicit action with a separate identity.
6. Distinguish pause from cancellation: “Pause goal” prevents further autonomous parent work; current children remain visible and may finish. “Stop goal and its tasks” cancels owned work. Completion events received while paused update state without restarting autonomous work. These controls must follow the binding responsibility contract.
7. Validate completion against the agreed workflow checks and unresolved required tasks before accepting `goal_complete`; do not change upstream's terminal completion behavior or manufacture completion messages. Long-lived optional services need an explicit disposition rather than treating every background process as a completion blocker.

Example: `/goal Fix sign-in and verify it` launches a researcher, consumes its findings, launches an implementer in a committed-base worktree, and validates the implementation's resulting commit in a separate reviewer worktree. Failed validation feeds corrective work; passed validation allows final integration and verification according to the chosen merge policy. Each stage runs in the background, while dependency ordering keeps it coherent. A reviewer must use the implementation commit as its selected base, not the original pre-fix commit.

The scope question is answered: build the unified visual agent editor with full coordination authoring and runtime enforcement, alongside transparent execution/control. Users compose a small or large configuration in that same interface. No separate simple implementation or complex workflow product is needed. Dependency visibility, validation evidence when configured, recovery and reliable `/goal` coordination apply to the same underlying work.

## Scope and evidence

Read the complete supplied proposal and `docs/agents-leap/references/multi-agent-arch.md`; inspected the relevant protocol, session driver, session router/catalog, companion module, subagent controls, installed agent configuration and execution code, Fleet, rail, panel bodies, settings persistence and Goals integration. Baseline: HEAD `b48a91a`, with substantial pre-existing uncommitted work. Engine versions inspected: Pi 0.85.0 and pi-subagents 0.65.1.

`docs/research/findings.md`, referenced by several contracts, is missing. Used installed source and `docs/agents-leap/references/pi-subagents-reference.md` instead; older architectural prose is not evidence of current upstream behavior. This was a source audit, not a runtime acceptance test. No application code or dependencies were changed, and no provider benchmark was run.

## Requirements already stated by the user

- Agents become reusable, first-class definitions, with a dedicated creation/management page.
- Four protected, editable definitions: `default`, Chat, Genie and Namer. The last three are presented as supporting built-ins, below the primary user-managed agents.
- `default` initially reproduces the current coding agent's effective behavior. Selecting another default changes which agent starts a new session; explain that next to the toggle.
- Agent definitions include instructions, model, delegation capability and further supported configuration. A session may override its selected agent's parameters.
- Every delegated agent is a real, fully controllable child session, visible in left navigation and chatable from its live map; workflow membership never makes it read-only.
- Ending a child requires a reason modal and durable parent notification; progress, state and diffs have an explicit parent/child reporting contract.
- Every subagent starts in the background. The parent cannot choose blocking execution.
- Every subagent gets a separate worktree under `.worktrees/`; edge cases require decisions below.
- Fleet represents **all background tasks, including commands and agents**, not just subagents.
- Genie uses the same agent machinery, retains broad Laser access even when given a session ID, and has an exclusive skill describing Laser operation and state.
- Genie is reachable from a persistent green spark in the far-left rail, including Settings and Logs; from “What is happening” in Fleet; and from a session's menu.
- Genie opens a bottom-left conversation bubble. The supplied sentence describing the first-message transition is incomplete.
- Global Genie conversations persist under a special navigation group with its own icon. Session-specific Genie conversations are marked child sessions.
- Fleet's Genie entry supports an optional question and session-specific conversation. Genie can delegate inspection to read agents.
- First provider connection offers an explained Genie model choice with a fast, capable default.
- Chat is a projectless conversation area, with Chat before Code in navigation, initially using the Chat definition. Any saved agent is selectable for the user's first interaction; choosing a definition with workspace-dependent capabilities must resolve the workspace requirement rather than exclude the agent.
- Namer selects a fast, inexpensive model through a benchmark of eligible cheap models after first provider connection.
- Namer labels tool calls when invoked, action aggregates while running, new sessions using short context, and child worktrees. Session titles stay within the requested 25–30-character range.
- Panel contents must adapt to their actual space, including distinct narrow and maximized compositions.
- React Flow is central to the live work/control experience, with substantial custom graph presentation, stable real-time layout and direct access to all agent conversations, changes and shared information. Framework names are not navigation or modes.
- Preserve the Pi/Laser responsibility boundary, `/goal`, and existing modules.
- The editor and feature set must support constructing the patterns in `docs/agents-leap/references/multi-agent-arch.md`.

## What Claude Code actually does

There are three documented paths: the model supplies `run_in_background: true`; the user moves an active command with Ctrl+B; or an eligible command reaches its timeout and is moved into the background. It does not universally background every long command. Current documentation excludes commands beginning with `sleep`, commands containing `git`, and compound commands it cannot fully parse from automatic promotion. [Claude Code tools reference](https://code.claude.com/docs/en/tools-reference#background-commands).

Background execution returns a task ID and keeps output in a readable file. Tasks have explicit stop and exit cleanup behavior. [Interactive mode](https://code.claude.com/docs/en/interactive-mode#background-bash-commands).

**Recommended Laser behavior, not a claim about Claude internals:** support an explicit background request, automatic promotion after a configurable foreground wait, and a user “Run in background” action. Separate that wait from a hard execution deadline. Moving a task must retain the same process, task ID, owner, output and transcript linkage; never restart the command. A deadline can still terminate it. Specify promotion exceptions as a deliberate product policy.

Detection can be programmatic: “still running when the foreground wait expires” requires no LLM prediction. Model intent can background known servers immediately. Command-text heuristics alone cannot reliably establish runtime or safety. Do not copy an undocumented guessed threshold such as “15 seconds.”

Each command needs its command/cwd, owning session and tool call, lifecycle, timestamps, output reference, process identity, exit code/signal and supported controls. Parent notification must distinguish “launched” from “completed”; completion delivery must be deduplicated. Waiting for a dependency is still necessary even though its execution is asynchronous.

## Current implementation gaps

| Area | Source finding | Consequence for the prompt |
| --- | --- | --- |
| Root agent configuration | `packages/worker/src/driver.ts` has no agent definition or resolved agent configuration in `DriverOpenOptions`; `stable-sdk.ts` loads the current engine defaults | Add a neutral profile contract and resolve it consistently for root and child sessions |
| Session identity | `packages/protocol/src/messages.ts` has `parentPath`, but no agent revision, session kind or relationship type | Distinguish delegation, ordinary forks and Genie assistance; do not assume every parent link means subagent |
| Creation | `session/new` requires `cwd`; `packages/host/src/router.ts` touches the project registry for every new session | Chat/Genie need a logical workspace kind and a managed execution directory that does not appear as a fake user project |
| Existing profiles | Installed `pi-subagents/src/agents/agents.ts` already supports instructions, append/replace mode, model/fallbacks, thinking, skills, context inheritance, tools, nested delegation, memory and more | Implement our own definition resolver using the retained Pi SDK; upstream profile fields are reference evidence, not a dependency or product schema |
| Async policy | Installed `runs/background/top-level-async.ts` forces only depth-zero launches and exempts `foregroundOnly` | `forceTopLevelAsync` alone does not meet “all subagents, no exceptions”; enforce at every applicable launch route and nesting depth |
| Worktrees | Installed `runs/shared/worktree.ts:250` rejects a dirty source checkout and defaults to a committed base | Define parent-edit snapshots, non-Git behavior, initial empty repositories, nested roots and merge/cleanup before making worktrees mandatory |
| Child control | `packages/host/src/subagents/control.ts` supports steer/stop/interrupt through files; resume goes through the owning session's bus | Current controls are not equivalent to a normal chat session with model overrides, approvals, queues and continuation |
| Single writer | `packages/worker/src/server.ts:494` attaches unknown session paths by opening a driver; the installed subagent runner has a separate session-lease system | Clicking a live child must route to its existing owner or transfer ownership explicitly, never open a second writer |
| Fleet | `packages/ui/src/components/subagents/FleetSheet.tsx` derives its contents from run panels; `docs/ux-agent-work.md` explicitly defers terminal processes | Introduce a common task lifecycle; command tasks must be first-class Fleet rows with their own appropriate body/controls |
| Bash | Installed Pi `dist/core/tools/bash.js` exposes `command` and a timeout in seconds; it waits for exit and kills the process tree on timeout | A background execution implementation is required; CSS or a new tool flag without runtime support is insufficient |
| Live app state | `packages/host/src/panels/store.ts` is memory-only; `prefs.ts` updates memory, broadcasts changes and persists asynchronously; logs use SQLite | “Everything is saved in realtime and file edits are sufficient” is false in the current implementation |
| Namer | Inspected naming paths implement explicit rename and first-message fallbacks; no shared Namer service was found | Add a bounded asynchronous naming pipeline; do not block tool execution or session/worktree creation on naming |
| Panel sizing | `packages/ui/src/panels/islands/Island.tsx:511` gives `RunBody` no size; `RunBodyProps` has none. `AgentPlan` does receive `maximized` | Pass actual presentation capacity to bodies and design what each size shows |
| Goals | `packages/pi-extension/src/modules/goal.ts` projects canonical goal state, without a shared child-task wait coordinator | Prove dependent-task waiting, completion races, cancellation and goal isolation instead of assuming compatibility |

The existing navigation decision D-19 excludes children from the session list, keeps some children read-only and prohibits a full-screen Fleet. D-125 records the user's superseding requirements: full child conversations, sidebar access and substantial live graphs including expanded Fleet. Update the affected UI contracts during implementation while preserving honest topology and the existing package boundaries. The panel contract already calls for size-specific content, so much of that complaint is an implementation gap rather than a new design direction.

## Recommended conceptual model

Keep these separate:

1. **Agent definition:** reusable instructions and capabilities, stable ID and revision.
2. **Session:** durable conversation, selected agent, effective configuration, workspace and optional relationship to a parent.
3. **Execution attempt:** one stretch of work within a session, with a result and lifecycle; a session can continue after an attempt ends.
4. **Background task:** trackable work owned by a session, either an agent execution or a command. A command does not need a fabricated conversation.
5. **Shared execution data:** requirements, dependencies, assigned roles, contracts and shared resources coordinating attempts. Our own execution/resource services supply these records; upstream workflow/mission storage is not a runtime dependency.

This avoids treating “child finished” as “child conversation can never continue,” and keeps later user messages from retroactively changing the result of the original delegation.

The agent catalog is shared by direct-session selection and delegation. Do not build separate root/child registries. Definition access, instance ownership and communication are different graphs; permission edges do not automatically create sessions. A role named “reviewer” or a supporting built-in still starts a normal user conversation through the same resolver.

Recommended configuration precedence: built-in baseline → saved agent definition → permitted project defaults → explicit session overrides → enforced product invariants. Document exactly which project defaults participate. An override cannot make a child run synchronously or bypass mandatory isolation merely because the editor says “any parameter.”

Recommended initial editor groups:

| Group | Fields |
| --- | --- |
| Identity | Name, description, icon, user/project scope, default-for-new-session toggle |
| Instructions | Editable instructions, engine baseline append/replace choice, effective-prompt preview |
| Model | Provider/model, supported reasoning level, explicit fallback policy |
| Capabilities | Tools executed by this agent, selected skills/features, permitted mutation, delegation on/off, message/shared-information operations |
| Agents this agent can access | Select existing definition IDs; per-target permitted operations, directed access and effective task restrictions. These are the same agents available for direct user chat |
| Context | Fresh or inherited conversation, selected source material, project/global instruction inheritance, skill inheritance |
| Relationships and rules | Same editor canvas/inspector: allowed-agent edges, assigned work, dependencies, shared inputs, checks, typed outcome conditions, concurrency/resource constraints, notification/wait and stop/rework behavior |
| Outputs and communication | Expected result/handoff format, artifact destinations, user-defined message payload schemas/instructions and compatible protocol versions; no framework picker |
| Advanced | Supported memory and execution limits, with capability-aware controls |

Keep unsupported parameters out of the editor. In particular, do not invent generic temperature controls for models that do not support them. Show the origin of effective values and allow reset to the built-in baseline. The current Pi system prompt is assembled from tools, skills, context and cwd; copying one rendered prompt permanently into `default` would freeze transient context and become stale.

Definitions need durable revisions and explicit behavior for deletion, built-in reset, provider disconnect and running sessions. “Non-deletable” need not mean “all identity metadata editable.”

All editor groups above are properties of selected objects in one interface. Do not implement them as separate simple and advanced editors. A user connects a worker, grants delegation, saves and chats without creating a named workflow or a predefined sequence. Adding a required check or shared resource uses the same objects and persisted configuration. Full editor behavior includes validation, draft undo/redo, duplication, save/reload, read-only preflight and explicit application of revisions to active work; details are binding in the responsibility and visual specifications.

### Feasibility recheck: universal definitions and communication

Re-read all three LEAP specifications, the supplied architecture example and Laser's architecture, then checked the installed source and relevant neutral reference sections. The design is achievable through the existing SDK/extension boundaries with additional implementation; this is source-level feasibility evidence, not a claim that current Laser already meets it.

| Requirement | Verified evidence | Required work |
| --- | --- | --- |
| One definition for direct chat and delegation | Pi 0.85.0 `dist/core/sdk.d.ts:11` accepts models, explicit tools/noTools, custom tools and a resource loader. pi-subagents `src/agents/agents.ts` supplies reusable profile configuration | Add a shared neutral resolver/registry; Laser `DriverOpenOptions` currently lacks an agent definition, and `stable-sdk.ts` session creation does not yet apply one |
| Per-agent tools and delegation switch | `src/runs/shared/child-tool-plan.ts:295` resolves tool lists, excludes and `allowNestedSubagents` | Apply equivalent effective policy to roots and children and enforce at every launch route. A delegation-only agent may invoke an authorized editing agent without inheriting editing tools itself |
| Access to selected existing agents | `src/runs/shared/capability-ceiling.ts` and `docs/extension-api.md` support `allowedAgents`, explicit empty lists and pre-spawn rejection | Map stable Laser IDs to engine identities. Upstream ceiling lists inherit monotonically: a definition's direct A → B access must not become a whole-tree ceiling that incorrectly blocks B → C. Keep per-hop access and explicit subtree ceilings separate |
| Definition availability across processes | `docs/extension-api.md:65` runtime registration is process-local and does not register profiles in children | Resolve/register the required catalog consistently in every owner process and recover the pinned definition revision; never assume the root registration propagated |
| Child-to-parent progress and questions | `src/intercom/native-supervisor-channel.ts` implements `contact_supervisor` progress/decision/interview requests with parent replies | Implement our own durable neutral reporting/receipt channel, learning from the native channel’s correlation and ownership checks |
| General peer messages and multi-recipient updates | Native supervisor `send`/`ask` explicitly reject at `native-supervisor-channel.ts:608`; upstream `docs/workflows.md:413` requires an explicit external provider for generic intercom. `pi.events` is process-local | Implement our own durable recipient/channel router and Pi-native tools/adapter. Existing parent RPC/supervisor plumbing is not proof of peer messaging/broadcast |
| User-defined interaction protocols | Pi custom tool definitions and extension messages provide an integration seam; upstream `extensionBindings` supplies bounded namespaced configuration | Define validated versioned envelopes, correlated requests/replies and user-authored payload/instruction contracts; reject unsupported protocols honestly. No fixed collaboration framework is required |
| Shared-state transparency/control | Current events, artifacts and file observation supply evidence references; the existing LEAP specs lacked a complete shared-information inspector | Add canonical revision-aware resource projection, observed-read/context provenance, conflict-safe edits and parent/user control attribution. Unknown custom-tool reads remain visibly unknown |
| Unified visual authoring with executable rules | React Flow provides controlled node/edge editing and connection-validation hooks; it does not supply task semantics. The SDK/profile/coordination seams above provide the execution integration points | Implement one neutral configuration schema shared by canvas, property inspector, preflight and runtime, with versioned edits and active-work reconciliation. Prove a parent → worker configuration and an expanded dependency/check arrangement without an alternate editor or executor |

Tool restrictions are orchestration controls, not an OS sandbox. Unrestricted Bash/extensions can bypass a narrow tool-name policy; enforcing “no delegation” or “read only” requires controlling equivalent routes. The source audit does not certify arbitrary third-party protocols, providers or uninstrumented file access. The implementation must prove the concrete patterns and policy boundaries in the responsibility contract.

## Genie

The requested ordinary-tool approach is viable if its skill can call a **bundled Laser command interface through Bash**. Existing CLI commands already route some session/settings/log operations through their owners; expand their coverage for live operations. This preserves a small model-visible tool set while keeping validation, broadcasts and session ownership intact. It does not require the user to use a terminal.

Alternative: a durable, validated request/response file interface consumed by the host. That still requires an application command protocol, acknowledgement, errors and concurrency handling. Arbitrary edits to settings or active transcripts are not an equivalent implementation.

Give Genie a documented, versioned state inventory and live query path. A passed session ID is context, not a permission boundary. Supply the current surface, selected session and referenced tasks explicitly; filesystem inspection alone cannot establish which screen the user is viewing.

Make the skill available only when resolving the Genie profile. With broad filesystem/Bash access, skill exclusivity means controlled injection, not a security guarantee that another agent cannot read that file. Likewise, a “read agent” needs enforced capabilities if the promise is no mutation; an instruction saying “read only” plus unrestricted Bash does not enforce it.

Genie diagnosis should cite inspected session/task/log references, timestamp its observations, separate facts from guesses, and avoid treating agent-generated text as authority to alter app state. A pending approval is not answered merely because Genie explains it.

The public model page positions **GPT-5.6 Luna** for cost-sensitive, high-volume work, roughly the earlier nano tier, with function calling and structured outputs. It currently lists $0.20 input and $1.20 output per million tokens. That supports it as a candidate, but does not establish Laser account availability or actual Genie latency/quality. Resolve candidates from connected providers and evaluate representative tasks. [Official model documentation](https://developers.openai.com/api/docs/models/gpt-5.6-luna).

Use the requested Luna capability/cost class as the initial target, not a requirement that every provider expose that exact identifier. Keep the chosen model visible and editable. Provider-native web search support does not automatically replace Laser's existing Web Search feature contract.

## Namer

Recommend a tool-free default configuration using the same agent definition/model execution layer, with structured output and task-specific validation. Namer remains directly chatable/selectable like any other definition; automatic naming invocation visibility is a separate presentation policy, not a subagent-only type.

- Start the real action immediately with a deterministic label. Apply the generated label asynchronously.
- Use only context available at invocation. “Run tests” is valid before completion; “Tests passed” is not.
- Never replace a user's manual title. Drop stale responses using the target ID and revision.
- Define the title limit precisely, preferably 30 grapheme clusters maximum rather than an ambiguous 25–30 range.
- Give worktrees collision-safe stable names under the canonical repository's `.worktrees/`. If naming is late, retain the created path and update a display label; never rename a live working directory under its process.
- Benchmark a small, price-eligible set with synthetic naming examples, format/length checks, task-relevance checks, latency and estimated cost. A single fastest response does not prove the best model.
- Cache results by model/provider and benchmark version. Define a spending ceiling, cancellation/failure behavior and a deterministic fallback. Unknown prices are not proof that a model is cheap; subscription access is not an API-price guarantee.
- Batch/coalesce aggregate updates, prevent naming calls from naming themselves, and attribute their usage once.

## Engineering examples the flexible agent definition must support

The supplied missions guide appears twice in the file. Its named frameworks/roles are engineering examples, not mandatory product modes. Users must be able to produce these behaviors through the unified visual editor's agents, instructions, capabilities and enforceable relationships/rules. Editable examples can demonstrate useful arrangements in that same editor. The guide's performance percentages and duration claims have no cited evidence; do not turn them into acceptance thresholds or delivery periods. Independent validators need fresh context without the worker's reasoning; technical review still needs access to the implementation being reviewed. A different model provider does not prove statistical independence or correctness.

| Guide capability | Editor/feature support needed | Proof scenario |
| --- | --- | --- |
| Orchestrator/worker/validator roles | Per-role profiles, models, tools and delegation permissions | Orchestrator launches configured worker and separate validator |
| Fresh workers | Explicit context policy and selected task/contract inputs | Child receives the spec and repo state without parent's conversation baggage |
| Independent validation | Separate review context and immutable implementation reference | Validator checks the completed commit without worker reasoning |
| Validation contract | Versioned assertions and feature-to-assertion mapping, approval/amendment rules | Incomplete mapping is detected before execution |
| Serial mutation, parallel research | Workflow scheduling constraints, resource ownership and read-role capabilities | A mission never overlaps writers, while independent research overlaps |
| Structured handoffs | Typed completed/remaining work, command results, constraints and adherence report | Next worker recovers using persisted handoff, not hidden memory |
| Shared state | Canonical versioned resources, atomic updates, scoped notifications and a user-readable/editable inspector | User sees actual content and which revision each agent was given/read; conflict-safe changes and delivery survive reconnect |
| Delegation, peer messages, broadcast | Routed, persisted, attributed messages with delivery status | A stopped/offline recipient has an honest pending/failed delivery state |
| Negotiation | Decision proposals and recorded resolution, linked to blocked dependencies | Conflicting endpoint assumptions resolve before dependent work starts |
| Validation and repair loops | Explicit dependencies and transitions for pass/fail/rework | Failure schedules bounded corrective work and revalidation |
| Browser user testing | A real browser/computer-use capability available to the validation profile | Agent opens the actual app and exercises a user flow |
| Long-lived work | Durable checkpoints, process reconciliation, continuation and recovery policy | Restart distinguishes a live task from an interrupted attempt without repeating side effects |

Asynchronous execution and serial workflows are compatible: children always launch in the background; dependency gates decide when the next child may start. The guide's serial-write policy should be configurable per workflow unless the user wants it globally enforced.

Browser testing is not supplied by instructions alone. Include a working selectable browser/computer-use capability with the appropriate provider integration and permissions so user-defined agents can exercise the actual app. Verify a real interaction through the packaged runtime; listing a nonexistent capability is not completion evidence.

Preserve budget-free Laser Goals and their canonical completed history. A workflow/task registry must provide reliable dependency waits and wakeups without duplicate parent continuation. Fresh child contexts should not accidentally inherit an active parent goal. Test forked contexts explicitly; existing reference material flags that as a risk, not a proven fixed behavior.

## Product decisions to answer

The first six have been asked in the conversation:

1. **Architecture/product scope answered:** one universal agent catalog, unified visual editor/schema/runtime, enforceable relationships/rules and transparent control, with sole `/goal` continuation ownership. All authoring and execution capabilities are in the same complete LEAP delivery; configuration size never selects another interface or execution path.
2. **Isolation edge cases:** literal worktrees for every child, including read-only/Genie/projectless children, or coding children only? If literal, choose behavior when no Git repository exists.
3. **Genie transition:** after first message, save and remain in the bubble, or open the new session in the main workspace?
4. **Answered — dirty parent:** use only the selected committed Git state; preserve uncommitted parent edits untouched.
5. **Answered — Genie live operations:** bundled Laser command interface through Bash, with explicit UI confirmation before actions. Read-only inspection is allowed without confirmation; actions and agent launches require confirmation.
6. **Definition edits:** existing sessions keep snapshots, or adopt updated definitions on their next turn?

Further choices, with recommended starting points:

| Decision | Recommended starting point |
| --- | --- |
| Child navigation — decided | Every child has full chat controls and sidebar/map access; keep one canonical session identity across all entry points |
| Chat agent selection — decided | Any saved definition can start the user's conversation; tools/delegation follow its effective capabilities. Workspace-dependent operations still need an explicit valid workspace |
| Worktree integration | Parent/orchestrator may review and integrate a completed child; expose conflicts and retain work until merge/discard is explicit |
| User control of a child — decided | One ordered session queue, full chat at every stage, later attempts separate from the original result, and reasoned termination reported to the parent |
| Genie button behavior | Default diagnosis of the selected session with optional text; global Fleet diagnosis when explicitly selected; decide reuse versus new child per request |
| Genie mutations — decided | Read freely; require explicit UI confirmation before actions and agent launches, even when the user requested them in text |
| Namer benchmark ceiling | Small fixed cheap-candidate shortlist with an explicit maximum cost; decide maximum and whether users can skip the automatic benchmark |
| Namer visibility | Supporting activity/usage record, not a new sidebar conversation for every title |
| Background lifetime | Continue through navigation/window closure while the host lives; explicitly define full quit, worker crash and machine restart behavior |
| Foreground wait | Configurable promotion threshold independent of a hard kill deadline; decide the default and exception policy |
| Built-in agents — selection decided | Protect IDs/deletion, permit configuration/reset and direct chat/default selection like other agents; preserve integration-specific policies such as Genie confirmation |
| Browser capability — included | Supply a working selectable browser/computer-use integration for user-defined agents; enforce its permissions and verify actual interactions, not instructions alone |

## Dependency order for the eventual prompt

This is prerequisite order within one complete waterfall delivery. It is not an iteration plan, phased release or timeline; every listed capability and its acceptance proof is required before the LEAP is complete.

1. Resolve product choices; update conflicting architecture/navigation contracts with recorded decisions.
2. Define engine-neutral agent/session/task schemas, identities, revisions and protocol methods.
3. Implement profile resolution and single-owner child sessions, then mandatory isolation and integration lifecycle.
4. Implement command execution/promotion, task tracking and deduplicated completion/wait semantics.
5. Add the unified visual agent editor, per-session overrides, Chat and child navigation on that shared runtime, with one configuration model from a lone agent to rich coordinated work.
6. Add Genie and Namer, onboarding, model selection and live app-control access.
7. Wire visually configured relationships, dependencies, shared inputs, checks, outcome routing and permissions to authorized messaging, custom payloads and execution, reusing supported Pi-native behavior internally. Include revision-safe live application, browser capability and varied user-authored configurations.
8. Finish container-aware panel/Fleet compositions and run end-to-end acceptance gates.

D-134 settles the architecture: completely replace pi-subagents with our own delegation/coordination implementation while retaining the Pi coding-agent engine. Pi-facing code remains behind the worker/companion boundary; `packages/pi-extension` translates to neutral protocol data. Host owns supervision, persistence, catalog and routing; UI owns presentation. Do not build a second model loop in the UI or host. The [implementation study](implementation-study/README.md) supplies source walkthroughs, workflow recipes, replacement integration map and acceptance cases. No upstream runtime/API/storage compatibility or upstream patch is a prerequisite. Any new Pi-native package extraction must explicitly preserve or amend/test the repository import boundary.

## Acceptance requirements to carry into the final prompt

- Root and child resolve the same profile consistently; overrides, reset, reload and provider removal behave predictably.
- The same visual editor/schema/runtime creates, validates, saves, reloads and executes a lone agent, parent → worker, and a richer arrangement with shared inputs, checks and outcomes. Growth/simplification requires no mode switch, workflow page, conversion or alternate executor. Preflight, draft undo/redo, duplication and revision application to active work are tested.
- Every saved agent is directly chatable and reusable as a child. Per-hop allowed-agent access, independent execution/delegation capabilities, multiple simultaneous instances and inherited task restrictions are tested distinctly.
- Every launch path and nesting depth obeys background/isolation policy, including attempts to request foreground execution.
- Live child interaction, parent messages and resume never create two writers; parent/child switching preserves state and approvals.
- Workflow and standalone children retain full chat/history across every lifecycle state. User-ended work preserves its reason, partial changes and parent delivery receipt; no silent replacement is launched.
- Progress reports distinguish child claims from measured state. Live diff collection leaves files and the Git index unchanged; final handoffs identify exact changes and verification evidence.
- Worktree snapshot, nested allocation, dirty/untracked files, dependency setup, integration conflicts and cleanup have real tests.
- Explicit/manual/automatic backgrounding runs the command once; completion, failure, stop, output bounds and orphan recovery are accurately shown.
- Commands and agents coexist in Fleet, including commands launched by children; original tool disclosure links to the same task.
- Goals wait for required children/commands without duplicate launches or duplicate completion turns; success/failure/cancellation/late delivery are covered.
- Genie works from chat, Settings and Logs, with persistent global and session-linked history and no narrowing caused merely by context selection.
- Namer never delays real work, invents outcomes, overwrites manual names or applies stale results; benchmark stays within its approved policy.
- Solo, delegation-only, creator/verifier, peer messaging, negotiation, multi-recipient updates and custom message-schema patterns run as engineering fixtures composed in the same editor from ordinary agent definitions; no mandatory framework taxonomy or second interface is inserted.
- The live view exposes shared content, observed read/context revisions, conflict-safe user updates and parent-mediated stopping with honest source/reason/outcome attribution. Direct child chat and termination remain available throughout.
- Narrow dock, wide dock, maximized, pop-out and phone have intentional content compositions; inspect desktop/phone in light/dark, keyboard/touch and reduced motion. Verify focus, scrolling, disclosures and approvals through transitions.
- Run the concrete React Flow acceptance scene in `docs/agents-leap/agents-live-experience.md`, including real handoffs, chat/diff inspection, user termination, goal pause, reconnect and a larger graph stress fixture.
- New public methods have protocol schema samples, router coverage and real host/built-worker tests. Preserve identity checks, driver seam and packaged clean-machine verification for new executable dependencies.

The final implementation prompt should contain the answered policies, source map, dependency-ordered work and concrete acceptance scenarios. Unanswered choices must remain visibly unresolved rather than becoming silent implementation assumptions.
