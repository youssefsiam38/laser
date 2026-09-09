# Agents LEAP — live experience and React Flow direction

**Runtime ownership (D-134):** this LEAP completely replaces `pi-subagents` with our own implementation. Keep the Pi coding-agent engine. Upstream code and scripts are learning references only; no upstream API, storage format, runtime dependency or patch requirement is binding. See the [source study and replacement blueprint](implementation-study/README.md). Existing integration descriptions below are baseline evidence, not the target architecture.

This is the visual implementation specification accompanying the [binding responsibility contract](agents-responsibility-contract.md). The user explicitly requested substantial React Flow use and an impressive real-time agent experience. Build the visual system around actual task state, full conversations and reviewable changes.

**Product boundary:** users create reusable agent definitions. There is one visual agent editor, one configuration model and one execution system. A single agent, a parent with one worker and a detailed arrangement all use the same interface; the number of objects/rules changes, not the mode or implementation. Collaboration frameworks remain examples, not mandatory classifications. Visual coordination authoring and reusable configurations are fully included in this LEAP; the earlier blanket authoring ban is superseded. Render user-authored names faithfully.

**UI terminology:** follow the [product terminology contract](agents-responsibility-contract.md#product-terminology). Label the reusable identity field **Agent name** and its inspector tab **Agent definition**; the other tab is **This assignment**. Use agent terminology throughout navigation, onboarding and help. Assignment roles such as Worker or Validator do not rename or reclassify the reusable agent.

## 1. The intended experience

Opening the live view should feel like opening up the work itself. The user's request anchors the composition. Show the agents actually participating, their owned commands, shared information and known dependencies/messages. A single agent is a complete composition; a many-agent session grows naturally from it. In one possible user-created setup, research branches feed an implementation lane and a waiting reviewer. Do not insert that structure when the user configured something else.

The impressive moment is a real handoff. A researcher finishes; its activity line settles into a concise finding; the result connection briefly emphasizes the delivery; the implementation step becomes ready and starts in its existing place. The camera stays where the user left it. Selecting the implementer reveals its exact conversation and live changes. The user can ask a question immediately, without leaving the work behind or switching into a lesser “subagent” interface.

The surface should feel precise and carefully composed: generous space between work groups, close alignment inside each node, restrained borders, strong titles, quiet metadata and activity that is easy to locate. In the default dark theme, the ground is deep neutral, surfaces separate gently, and active work carries the Laser accent. The light theme uses the same hierarchy with crisp, readable surfaces. All values come from Laser's editable theme system; these descriptions are art direction, not literal color or font overrides.

The graph is a major product surface, not a decorative diagram appended to a list. Make it compelling through useful detail and stable motion: real agents arriving, actual work changing, decisions waiting, and verified handoffs connecting the whole sequence.

## 2. Where React Flow is used

| Surface | Composition and purpose |
| --- | --- |
| Live work map | Root and nested child sessions, independent communicating sessions, owned commands and user intervention; shows actual relationships without requiring a framework |
| Dependency layer in the same map | Known work dependencies, actual checks and execution attempts, including rework history; no separate framework mode |
| Expanded Fleet | The live work map for the selected session/project, with a global overview that groups independent roots without inventing relationships |
| Unified agent editor | Create/select agents, set capabilities and configure directed access, shared inputs, dependencies, checks and outcome rules in one React Flow canvas with a contextual property inspector. A parent → worker connection is already a complete usable configuration. Every definition has **Start chat** |
| Shared information | Actual shared resources linked to their authorized participants and observed reads/writes; selecting a resource opens its content, revision and access history |

Use the current `@xyflow/react` package, not the legacy `reactflow` package. Adopt the existing assistant-ui Flow graph/Agent plan components as the integration point and restyle their copied source; React Flow supplies the graph machinery. Keep assistant-ui's full Thread, Composer, ToolFallback, Code diff, Timeline, Agent handoff, Subagent list and approval elements for their assigned content surfaces. Do not replace the existing chat runtime with a graph library.

D-125 records the user's supersession of D-19's child-navigation/read-only restrictions, no full-screen Fleet rule and the older blanket rejection of a graph canvas. Update the affected UI contracts during implementation. Preserve their underlying honesty requirements: inferred structure stays marked, actual task state remains authoritative, and all content has an accessible non-canvas route.

## 3. Full-screen composition

### One editor, from one connection to detailed coordination

The editor opens around the selected agent, with its identity, instructions and capabilities in the property inspector. **Add agent** selects an existing agent; the resulting connection asks what is permitted, such as delegating work or sending messages. A two-agent configuration should look composed and finished, not like an empty complex dashboard. Saving and starting chat are available without creating any dependency/check nodes.

Use the same canvas, selection model and inspector as the user adds shared resources, assigned tasks, prerequisites, checks or outcome rules. Selecting an edge reveals its meaning and applicable properties in plain language: **May delegate to**, **May send messages to**, **Wait for**, **Share**, **Continue when**. Distinguish permissions from executable dependencies visually and structurally; never guess the edge's authority from its color or direction alone.

Only the selected object's relevant properties are shown. Optional constraints remain unset until added. No Basic/Advanced toggle, separate simple form, coordination wizard or required Workflow page. Richer configurations gain space through grouping and zoom, not a second interface. Keyboard and touch users can select participants and connect them through the same inspector without dragging. The editor always meets the normal phone/theme/token/accessibility contracts.

Authoring is fully interactive: add/reconnect/remove permitted relationships, edit typed conditions and payloads, inspect missing inputs, duplicate configurations, undo/redo draft edits, and save/reload durable revisions. Show invalid connections at the point of interaction and explain why in text; host/runtime validation is authoritative. A read-only preview identifies ready work and missing requirements without executing agents or commands. Editable examples such as “Build and check” open ordinary configurations in this same editor.

Keep configuration and live observation unmistakable: a saved permission edge is not a delivered message, and a planned task is not running. The live map projects the execution of the exact saved configuration with additional actual tasks/messages; its existing chat/state/control inspector remains available. Edit configuration through the same editor, and explicitly review/apply changes to active work with their affected scope. Saving, dragging a node or deleting a draft edge never silently stops an agent or rewrites an active attempt.

The intended visual continuity is literal: start with one agent and one worker, add a shared document and a required check, then see their real work and evidence in the live map. The same identity marks, edge vocabulary and property grammar carry throughout. There is no conversion into a different kind of product when the user adds detail.

### Live observation and control

Keep the far-left rail, including the persistent Genie spark. Across the top of the work area, show the current session/goal title, real counts of active and waiting work, and the existing pause/stop controls with their defined scopes. Do not add a second goal status or conflicting mission objective.

The central map occupies the majority of the space. A lightweight toolbar provides **Graph / List**, search, filters for agents/commands/messages/shared information, fit-to-view and a clearly visible **What is happening?** action. Dependencies are an optional visible relationship layer, not a workflow mode. Provide a quiet minimap for larger graphs; it is unnecessary for a three-node team. Fit-to-view is explicit after first entry. User panning, selection or typing cancels any optional follow mode.

Selection opens a resizable inspector beside the map. Its header reuses the selected node's agent mark, name and status so the two visibly refer to the same object. Offer **Conversation**, **Changes**, **Context** and **Activity** for agents; resource selection uses the shared-information inspector below:

- **Conversation:** the real, complete agent transcript and normal composer, with **Open full session**. Parent/user/peer messages have clear attribution. Every participant, including the root, remains reachable here at every stage.
- **Changes:** changed-file list, real counts, base/current commit context and a readable diff. Show stale/unavailable data explicitly. Switch between file summary and full diff based on space.
- **Context:** effective instructions/capabilities, selected source material and linked shared resources. Clearly distinguish content supplied to the agent, observed reads and available-but-not-read resources. Show the captured revision, not an unsupported claim about the model's current internal knowledge.
- **Activity:** measured tool execution, milestone reports, handoffs, delivery receipts, user interventions and verification results. A selected event points to its source message/tool/diff.

An inspector tab switch or graph selection does not cancel execution. Returning from a full child conversation restores the graph viewport, selection and previous inspector tab. Keep drafts and scroll positions per child.

Use an optional, compact recent-events strip beneath the map to show real milestones such as “Research delivered,” “Tests failed” and “User ended reviewer.” It links to the canonical event. Do not fill it with token ticks or fake log noise. Historical scrubbing is not required unless event snapshots can truthfully reconstruct the selected time.

## 4. A distinctive node system

Custom nodes share one disciplined anatomy: recognizable role mark, strong name, explicit state, one concise current action, then a small set of useful measured values. Avoid packing every field into every card.

| Node | Recognizable content |
| --- | --- |
| Parent/orchestrator | Objective or assigned coordination task, next dependency, active-child count |
| Agent child | Profile name, task title, current tool/milestone, elapsed time, measured change summary and **Chat** action |
| Command | Terminal mark, human-readable action, working-directory context, actual running/exit state and **Output** action; no fabricated chat identity |
| Validation step | Contract/check being evaluated, reviewed commit, reported versus verified outcome |
| Shared resource | User's resource title, source/type, current revision, last actual update and **Open**; links distinguish access, reads and writes |
| Pending decision | Clear question, requesting agent and **Review** action; never answered by clicking/selecting the node |
| Collapsed branch/group | Group title, meaningful counts, highest attention and a preview of the active step; expand restores the branch's stable layout |

At close zoom, an agent may show the latest milestone and the top changed files. At ordinary zoom, show title, state and a concise action. At overview zoom, collapse the detail into meaningful group marks and counts instead of shrinking paragraphs below the legibility floor. Any text the user is expected to read must remain at least the app's 12px floor after zoom transforms; use screen-space labels or switch representations. Selecting an overview node brings its readable inspector into view.

The same agent-node component represents a user-started agent and a delegated instance; relation badges describe how that instance started. Multiple instances of one agent definition show a shared definition identity and distinct task/session context. Task nodes reference execution attempts, while their Chat action opens the canonical session. A later follow-up can therefore be shown as a new attempt without duplicating the child conversation in navigation. A planned task that has not started is marked as planned and has no invented active session.

Commands launched by a child attach to that child. They must not float as unrelated tasks or disappear when the agent finishes while the command is still alive. Keep completed descendants reachable; collapse them intentionally with a count, without reparenting surviving work.

## 5. Connections explain the work

Use relationship layers in one live view: ownership, dependencies, messages and shared information. Selection emphasizes the relevant neighborhood; filters reduce clutter without hiding the fact that other work exists. Independently started peers can exchange messages without a fabricated parent node. Communication cycles are valid; the execution ownership tree remains separate. There is no framework selector.

Use a consistent line style and explicit labels for relationship types. A solid directed connection can represent a declared dependency; ownership uses a distinct labeled route or containment; a message/result delivery receives a short-lived emphasis on an existing relationship. Inferred edges are dashed and say **Inferred**. A dependency line does not imply messages are currently flowing.

Graph structure changes only when the actual structure changes. A tool output update must not rerun the graph layout. Do not invent future scripted branches or causal relationships from timing. For opaque workflows, show observed child lineage and a **Structure unavailable** explanation where necessary.

Arrange workflow stages predictably, with implementation and validation clearly separated. Parallel children occupy aligned lanes. A retry is an explicit new attempt with its predecessor retained in history; the old failed/cancelled node does not silently turn back into the new run.

That staged layout applies only when those real dependencies exist. Use stable grouping for independent peers and user-defined structures. Never force every graph into research → implementation → validation lanes.

## 6. Motion with purpose

- **Spawn:** introduce a newly registered child adjacent to its parent with a short position/opacity transition. Only the affected branch makes room; preserve the selected node's screen position where possible.
- **Running:** a restrained activity treatment belongs to the current row or node. It stops when the executor stops. No simulated text generation or fabricated percentages.
- **Message/handoff:** a brief edge emphasis corresponds to an actual delivered event. Queued delivery remains visibly queued, not animated as delivered.
- **Completion:** the status mark settles; the summary changes in place; the node remains where the user expects it. A workflow group may summarize only after all relevant descendants reach their recorded state.
- **Attention:** emphasize the actual decision node and roll its state up to its group, Fleet and session. Do not yank the camera away from the user's work.
- **Inspect/maximize:** preserve identity and state across the dock, expanded view and full session. Use the existing tokenized panel transition system where possible; do not remount a live conversation just to produce an animation.

No perpetual force simulation, constantly drifting nodes, animated backgrounds, global breathing glow or automatic camera tours. Restrict motion to meaningful events and the user's interactions. All durations, easing, line widths, spacing, radii and opacity treatments use mapped theme tokens. Reduced motion keeps every state change and relationship, with static emphasis and no moving edges/camera.

## 7. Design for actual panel capacity

| Available surface | Intended drawing |
| --- | --- |
| Narrow right Fleet/dock | Persistent **What is happening?**, session/task counts, compact lineage rows and selected-task preview. Use a focused local branch graph where it fits; never scale the whole team into illegibility. **Expand map** opens the main visual surface |
| Wide dock | Focused live branch/dependency graph with concise nodes and a vertically stacked inspector or resizable adjacent inspector when both remain readable |
| Full screen | Spacious live work map with simultaneous conversation/change/shared-information inspector and useful graph controls |
| Phone | Touch-sized task/phase list as the initial overview; **Map** opens a full-screen focused graph with breadcrumbs and explicit zoom controls. Selecting a child opens a full-height conversation sheet with composer safe above the keyboard |
| Pop-out | Same canonical task data and appropriate composition for its measured size; restore selection and viewport independently of the main window |

Use measured container width **and height**, not only window breakpoints. Node detail, inspector position and visible metrics change at capacity thresholds. A 30-agent graph fitted into a narrow panel is not a successful responsive layout. The graph canvas may pan internally; the page itself never develops horizontal overflow.

Full transcripts can be virtualized and lazily loaded, but cannot become inaccessible because their owner is a workflow. Provide keyboard/list navigation to every node/session without requiring precision dragging or visual edge following. Search can reveal a collapsed branch and open its child conversation while preserving the return location.

## 8. Ending an agent is part of the visual story

Every **End agent** control opens the shared reason modal from the responsibility contract. The user sees exactly which agent and work will stop and who will receive the reason. Keep the modal compact, neutral and easy to complete with keyboard or touch.

On confirmation the node shows **Stopping**. After acknowledgement it shows **Ended by you**, keeps its last progress and changes, and gains a user-intervention event in Activity. The parent delivery indicator moves from pending to delivered based on its receipt. The graph's downstream steps display their actual blocked/cancelled state. Opening the node still reveals the whole conversation and retained diff.

The same reason appears in the child's history and the parent's attributed control record. Do not show an optimistic “Parent notified” checkmark merely because the local modal closed.

### The view is also the user's control surface

Keep **Chat**, **Open full session** and **End agent** accessible for every running child. Make pending approvals, queued input and applicable configuration controls reachable in its inspector. A root has its real session/goal controls. Inspecting a node never applies an action; submitting a supported action follows the canonical execution owner and shows the request, receipt and actual outcome. User access to their work does not depend on what other agents are allowed to see.

The user can type into the parent's conversation: “End this child and change direction.” If the parent decides to do so, show the linked message, parent control tool with its reason, child stopping and the final acknowledged state. Attribute it as ended by the parent, with the originating user request linked when applicable. The direct End button still uses the reason modal; parent tool calls follow their applicable approval policy, including Genie confirmations. A failed stop is actionable, not visually disguised as completion.

Selection of a shared-information node opens its actual content, source, owner, latest revision and change history where retained. Show which agents can access it and the exact observed revision each used, with links to the corresponding read/write or context record. Use explicit states such as **Available**, **Provided in context**, **Read revision 3**, **Updated to revision 4** or **Read history unavailable**. A newer resource is not automatically “known by all agents.”

Provide **Open source**, revision comparison, supported editing and **Send to agent** actions through existing content/editor elements. Edits check the displayed revision and resolve conflicts through the resource owner. Preserve the older read snapshot alongside the new version. Notification receipt and model consumption remain distinct. For custom files/tools with incomplete observation, show the limitation instead of drawing invented access events.

Pending/failed actions, shared-state conflicts, terminal-history access and unavailable context all need intentional layouts. Nested branch collapse keeps counts of hidden active work and outstanding decisions. Search and list navigation must still reach every participant/resource without requiring the user to expand dozens of branches manually.

## 9. Concrete acceptance scene

Use a deterministic test/demo scenario with one parent, two research children, one implementer, one independent validator and background commands. It must exercise the real protocol/store/UI path; production must never present fixture activity as live work.

1. Research children arrive in separate lanes; the parent can keep doing unrelated work.
2. Open either researcher from graph and sidebar. Both routes show the same complete conversation; send a user message and see its delivery/response.
3. One research result is delivered while the user is reading the other child. The graph updates without shifting the camera or losing the draft.
4. Implementation starts from a selected commit. The Changes view updates as files change without modifying the Git index.
5. A test command appears beneath its owner, moves to the background once, and retains readable output and its real exit state.
6. Validation fails on the implementation commit; show the failed check, the dependency gate and a separate corrective attempt.
7. End a child with a reason. Show cancellation acknowledgement, retained chat/diff, parent delivery and no automatic replacement of that assignment.
8. Pause the goal as other results arrive; show recorded progress while preventing further goal-owned step transitions. Resume uses retained results.
9. Resize from full screen to dock, then inspect on phone, in both themes and reduced motion. The selected child, draft and disclosure state survive.
10. Reload and reconnect with history present. Restore canonical identities and honest status without duplicate nodes, edges, attempts or parent notices.

Additional flexibility/control scenes are mandatory: a lone non-delegating agent; one definition used directly and as a child; an agent that only delegates; independently started peers exchanging messages; and a user-defined message format. These engineering fixtures prove the same editor/runtime; optional editable examples use ordinary configurations. Also prove:

- Open shared revision 3 read by one agent; another writes revision 4. The inspector shows both facts accurately. Edit revision 4 as the user, handle a racing edit, and send the accepted update to selected agents.
- Ask the parent to stop a child; observe its actual control call, reason, pending/terminal state and retained conversation. Exercise denial/failure as well as success.
- Start two sessions of one saved agent and verify that node selection, messages, changes and permissions never confuse them.
- Create parent → worker, save and delegate. In that same editor add shared inputs, a check and a conditional follow-up, save/reload and run the real arrangement; then remove the extra rules. Prove there is no mode switch, conversion, separate setup or changed meaning of the original permission edge.
- Exercise draft undo/redo, invalid connections, missing inputs, read-only preflight, duplicated configurations and explicit application of a revision to active work. Cover user cancellation during that application.
- Inspect product copy/navigation: no Simple/Advanced editor split, mandatory framework picker or fixed role triad. Full visual authoring is present; user-authored names are preserved.

Review both the normal six-agent scene and a stress fixture containing dozens of concurrent tasks and hundreds of retained attempts. Record measured interaction/frame behavior on the test machine. “Uses React Flow” or “build passes” is not visual/performance evidence.

## 10. Implementation guardrails and supplied skill

The requested [React Flow skill](skills/react-flow/SKILL.md) and its complete reference set are installed locally from `framara/react-flow-skill`, pinned at `a224eeb6844200dc743fcd35a533744c02ab58f7`. Read the skill plus the custom-node/edge, layout, state-management, performance, interactivity and E2E references before implementing. Its example literal values are teaching examples; Laser's token contract takes precedence.

- Use controlled graph data from the canonical product store, with stable node/edge IDs and separately persisted viewport/selection/layout preferences. Editor callbacks produce validated configuration edits; live-map geometry callbacks affect presentation. Neither route directly implements execution scheduling.
- Memoize custom nodes/edges and callbacks; avoid subscribing every node to the entire task graph. Batch telemetry projection and keep graph geometry updates separate from text/output updates. [React Flow performance guidance](https://reactflow.dev/learn/advanced-use/performance).
- Give each canvas a measured, definite size and import the appropriate React Flow base styles. Keep node/edge registries stable. Mark interactive content with the library's drag/pan/wheel opt-out classes.
- Use deterministic layered layout for directed work; evaluate ELK for grouped workflows and cross-group routing. Run expensive layout off the main interaction path, ignore stale results, and preserve stable nodes. React Flow supplies rendering/interaction; layout needs explicit implementation. See the installed layout reference.
- The editor supports intentional connect/reconnect/delete actions with validation and draft undo/redo. In the live map, default deletion/rewiring is disabled; layout dragging changes position only. Explicit configuration changes go through the same editor and execution-owner reconciliation, preserving active execution ownership.
- Keep graph keyboard accessibility enabled and customize labels for task meaning. Provide an equivalent list and actual controls for chat, changes and termination. [React Flow accessibility guidance](https://reactflow.dev/learn/advanced-use/accessibility).
- No full transcript, full diff or unbounded output payload belongs inside every graph node. Nodes carry concise projections and references; the inspector loads the selected content.
- Introduce new component tokens only with complete theme mappings and Settings support. Map React Flow styling onto Laser tokens, including focus/selection, minimap and controls.
- Exact-pin chosen runtime/layout dependencies during implementation, preserve their licenses and verify the packaged build. Installing the skill does not install React Flow into the application; that belongs to the implementation task.

Source: [xyflow repository](https://github.com/xyflow/xyflow). The layouts and interactions above are Laser-specific design direction; they are not promises made by the library.
