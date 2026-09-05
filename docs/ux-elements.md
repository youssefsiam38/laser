# The element inventory — every assistant-ui element, claimed

Status: **binding.** Every element in the assistant-ui catalog is listed here
with the piorbit surface that owns it, or an explicit reason it does not
apply. Nothing is left unclaimed by accident.

## The rule

**Do not hand-roll a component that exists in the catalog.** Install it
(`npx assistant-ui@latest add <name>`), then style it to
[`packages/ui/DESIGN.md`](../packages/ui/DESIGN.md). Editing the copied
source is expected and is the point of a registry; rebuilding it from scratch
is not.

Two element families behave differently:

- **AUI-connected** (`*.aui.tsx`) read the runtime directly. They drop into
  our thread because we already run an assistant-ui runtime.
- **Standalone** are props-driven specimens with demo props (`visibleCount`,
  `cycle`, fixed `min-h`). De-demo them: strip the demo props, feed them from
  a panel payload, and delete any hardcoded size.

When an element is close but not right, the answer is to copy it and change
it, not to start from an empty file. Record the divergence in the row.

## Reasoning

| Element | piorbit surface |
| --- | --- |
| Loader | Every island and screen loading state: session hydration, settings load, package install, log page fetch |
| Thinking indicator | The assistant's thinking block while a turn streams |
| Streaming text | Assistant text parts during stream; pairs with the streaming caret in DESIGN.md |
| Typing indicator | A detached run that is working but sends no deltas (R4) — the honest substitute for a typewriter |
| Reasoning effort | The composer's thinking-level control, all seven Pi levels including `max` |
| Guardrail notice | Project trust declined, untrusted project, insecure origin on mobile, `disableBuiltins` breaking an agent |

## Messages

| Element | piorbit surface |
| --- | --- |
| Message pair | Transcript user/assistant pairing |
| Message branches | Pi's session tree: sibling branches after a fork (M1-T9) |
| Message actions | Copy, fork from here, jump to this entry, copy path |
| Error state | `extension_error`, a failed turn, a crashed worker |
| Message queue | Steer and follow-up chips above the composer (M1-T5) |
| Edit a sent message | Pi cannot edit history, so this drives **fork-with-edit**: edit re-sends from a fork |
| Feedback dialog | The rejection field a `decision` panel opens when you answer No (R2, M7-T4) |
| Stopped run | An aborted turn, and a run whose `terminalReason` is a stop |
| Timestamps (day separator) | Long transcripts, and day grouping in the sessions panel |
| Speaker identity | Which subagent produced a message inside a child run |
| Regenerate with | Fork and re-run with a different model or thinking level |
| Confidence | **Not applicable.** Pi emits no confidence signal; a faked one violates R3 |

## Tool use

| Element | piorbit surface |
| --- | --- |
| Tool call | The tool row in the transcript |
| Tool timeline | The sequence of tool calls inside a `run` island, expanded |
| Terminal block | `bash` output, and worker stderr in the logs screen |
| Code diff | `edit` and `write` results |
| Reviewable diff | The git line's Create PR flow (M2-T6): reviewing a session's whole change |
| File tree | Files a session touched; project browser |
| Elicitation form | A `decision` panel with more than one field |
| Server panel | MCP servers a project configures, in Settings → Packages |
| Tool failure | A tool row with `isError` |
| Permission grant | Pi's project-trust prompt, and tool approval with scope options |
| Computer use | **Not applicable.** piorbit does not drive a computer |
| Code runner | **Not applicable in v1.** No sandboxed execution surface; revisit if Pi gains one |

## Knowledge

| Element | piorbit surface |
| --- | --- |
| Web search | `pi-web-access` results as a `collection` panel (M8-T4) |
| Inline citation | Citations inside assistant text from web-access |
| Image generation | **Not applicable in v1.** No image model surface |
| Retrieval chunks | **Not applicable in v1.** No RAG in Pi |
| Document reference | `@file` mentions, and a `document` panel's source reference |
| Memory | Context files in play for a turn: `AGENTS.md`, `.pi/` context, Pi memory |
| Research report | The mission ledger view, and a subagent's research brief artifact |
| Map | **Not applicable.** No geographic data |

## Structured output

| Element | piorbit surface |
| --- | --- |
| Data table | The logs list, the model catalog, the package list, `collection` panels in table layout |
| Number ticker | Live token and cost counters on islands — exactly the one live value a minimal island shows |
| Chart | Usage and spend over time in the telemetry rail |
| Web preview | **Deferred.** Embeds are out of scope for v1 (D-18); the element is claimed for when that changes |
| Diagram | Mermaid fences in the transcript |
| Flow graph | A workflow's declared graph, when pi-subagents persisted one |
| Activity graph | Per-project session activity; pairs with Heat graph |
| Math | Math in markdown |
| Spec sheet | Run and session metadata: model, thinking, cwd, ids |
| Comparison | Comparing models in the picker (context, reasoning, vision, cost) |
| Timeline | The run timeline, and checkpoint history |
| Job progress | A `run` panel's `progress`, when it has one |
| Score breakdown | pi-subagents acceptance-gate results |

## Agents

| Element | piorbit surface |
| --- | --- |
| Agent plan | **The `plan` panel.** Phases, steps, done/total |
| Subagent list | **The fleet sheet.** Every run across projects |
| Agent status | The `run` island header |
| Approval card | A `decision` panel with an approval, rendered in its tool row |
| Recommendation card | **Not applicable.** piorbit does not recommend actions |
| Artifact card | Mission artifacts, and a `document` panel shown as a card |
| Todo list | A `plan` whose steps are a checklist rather than phases |
| Agent card | An agent definition from `.pi/agents/*.md`, in Settings |
| Handoff | A parent spawning a child, shown inline in the transcript |
| Background runs | **The attention inbox** (M2-T2) — this is exactly the background-inbox element |
| Checkpoints | Pi's session tree as checkpoint history (M1-T9) |
| Schedule | pi-subagents scheduled runs. Deferred by D-19 Q4; claimed for when it lands |

## Observability

| Element | piorbit surface |
| --- | --- |
| Trace waterfall | Provider request timing in the logs screen — request, TTFT, stream, tools |
| Cost meter | Cost in the telemetry rail and on every `run` and `plan` panel (R8) |
| Quota banner | Provider rate limits and usage-limit errors, including the `FreeUsageLimitError` case |

## Composer

| Element | piorbit surface |
| --- | --- |
| Composer | The composer |
| Slash commands | Pi's slash commands, extension commands and `/skill:` commands |
| Mentions | `@file` mentions, and `@handle` addressing where a subagent package provides it |
| Attachments | Image paste and attach |
| Models | The model picker |
| Dictation | `pi-gpt-transcribe` (M8-T2) and the mobile mic (M7-T6) |
| Context | What is attached to this turn: files, context files, quoted text |
| Draft restore | An unsent composer draft, per session, across reloads |
| Context breakdown | What is filling the context window; pairs with the context ring |
| Prompt library | Pi prompt templates from `~/.pi/agent/prompts/*.md` — the user's `orchestrator.md` lives there |
| Command palette | `Cmd+K` |

## Voice

| Element | piorbit surface |
| --- | --- |
| Voice conversation | **Not applicable in v1.** Dictation is input-only |
| Read aloud | **Deferred.** Plausible for a phone; not v1 |

## Thread

| Element | piorbit surface |
| --- | --- |
| Chat panel | The thread column |
| Empty state | The session empty state |
| Scroll anchor | Transcript scroll-to-bottom |
| Canvas (canvas-split) | **The dock.** Thread beside panels is exactly this split |
| Connection state | The reconnecting banner |
| Shared conversation | **Not applicable in v1.** No sharing; revisit with the relay |
| Search in conversation | Search within a transcript |
| Thread search | Search sessions across every project |
| Launcher | **Not applicable.** piorbit is not an embedded widget |
| Settings | **The settings screen** (M4-T2) |
| Onboarding | First run: no projects, no auth, no model |
| Mobile composer | **The phone composer** (M7-T2), including its keyboard handling |

## AUI-connected

| Element | piorbit surface |
| --- | --- |
| Thread | The thread |
| Assistant modal | **Not applicable.** piorbit is the app, not a modal in one |
| Assistant sidebar | **Not applicable.** Same reason |
| Thread list | The sessions panel |
| Thread list sidebar | The sessions panel's sidebar form, with project groups (D-20) |
| Orb | The fleet pill's working state, and the ambient line's activity indicator |
| Reasoning | Thinking blocks |
| Message timing | Per-turn elapsed and token counts |
| Conversation map | Navigating a long transcript; pairs with the history tree |
| Context display | The context ring |
| MCP config dialog | MCP server configuration, where a project uses one |
| Attachment | Attachment chips |
| Follow-up suggestions | Suggestions in the empty state and after a turn settles |
| Tool fallback | An unknown tool's row |
| Tool group | **Collapsed consecutive tool calls** (D-20 item 4) — this element is that feature |
| Quote | Quote selected transcript text into the composer |
| Sources | web-access sources under an answer |
| Image | Image message parts |
| File | File message parts |
| Model selector | The model picker |
| Composer trigger popover | The slash-command and mention popovers |
| Directive text | System and directive messages, and extension notices |

## Renderers

| Element | piorbit surface |
| --- | --- |
| Markdown text | The transcript renderer |
| Syntax highlighter | Code blocks (we register languages synchronously; see `highlighter.tsx`) |
| Shiki highlighter | **Evaluate against ours.** Shiki is streaming-aware and skips tokenizing while a part streams, which is what we hand-rolled. If it is better, switch and delete ours |
| Mermaid diagram | Mermaid fences |
| Generative UI | The pattern behind our declared panel protocol; evaluate `JSONGenerativeUI` as the transport for `piorbit:panel` payloads rather than a bespoke union |

## Primitives

| Element | piorbit surface |
| --- | --- |
| Tooltip icon button | Every icon button in the app (already adopted) |
| Model logos | Provider logos in the model picker and the telemetry rail |
| Heat graph | Session activity per project; pairs with Activity graph |

## Generative demos

The `generative-*` set (stays, booking, flights, weather, receipts, charts)
are **domain demos, not applicable**. Their value to us is the pattern, not
the components: they show a model composing UI from a fixed vocabulary, which
is exactly what `docs/ux-panels.md` specifies for extensions. Read them before
finalising the declared protocol's payload shapes.


## Beyond the published catalog

The published elements page lists ~121 items. The registry source has **125
element files**, and twelve of them are not on that page. They were found by
listing
`packages/ui/src/components/react/assistant-ui/elements/` in the assistant-ui
checkout, which is the authoritative list. Each is claimed here too.

| Element | Exports | piorbit surface |
| --- | --- | --- |
| `surfaces` | `paper`, `floating`, `field`, `fieldInteractive` | **The shared style vocabulary every other element builds on.** Adopt this FIRST and map its tokens onto DESIGN.md, or each adopted element brings its own surface treatment and the app looks assembled rather than designed |
| `shimmer-labels` | shimmer helpers | The label that shimmers while a run streams; replaces the shimmer CSS we hand-wrote for the reasoning header |
| `reasoning-panel` | `ReasoningPanel` | The expanded reasoning body, distinct from the `reasoning` collapsible header |
| `suggestions` | `Suggestions` | Empty-state and post-turn suggestions, the props-driven sibling of `follow-up-suggestions` |
| `quote-reply` | `QuoteReply` | The quoted block shown on the message you are replying to, paired with `quote` in the composer |
| `message-attachment` | `MessageAttachments` | Attachments on a sent message, distinct from `attachment` in the composer |
| `model-picker` | `ModelPicker` | The props-driven picker; compare against the runtime-bound `model-selector` and keep whichever fits our host-supplied model list |
| `threadlist-sidebar` | `ThreadListSidebar` | The real filename behind "Thread list sidebar" — the sessions panel |
| `voice` | `VoiceOrb`, `VoiceControl`, `VoiceStatusDot`, `deriveVoiceOrbState` | `VoiceStatusDot` and `deriveVoiceOrbState` are reusable beyond voice: the dictation button state for `pi-gpt-transcribe` (M8-T2) and the mobile mic (M7-T6) |
| `flow` | `Flow`, `FlowLLM` | A declared workflow graph; `FlowLLM` renders an LLM step |
| `flow-canvas` | `FlowCanvas` | The pan/zoom surface a maximized plan island uses when a workflow graph is declared |
| `flow-expand` | `FlowExpand` | Expanding a node in that graph |

Eight names on the published page have no file of their own because they are
**sub-features composed inside another element**, not separate installs:
`composer-slash-commands`, `composer-mentions`, `composer-attachments`,
`composer-model-picker`, `composer-voice` and `composer-context` all live
inside `composer`; `orb` lives inside `voice`; `thread-list-sidebar` is
`threadlist-sidebar`. Install the parent and configure the feature.

## How this interacts with the panel contract

The panel contract says *where* something renders and *who decides*. This
inventory says *what draws it*. A `run` panel expanded in the dock is the
Agent status element in an island; a `plan` is Agent plan; the fleet sheet is
Subagent list; the inbox is Background runs. The contract is the frame, the
elements are the picture.
