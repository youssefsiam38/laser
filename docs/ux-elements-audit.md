# Tool-use elements — the sweep

Status: **research record, read-only on code** (M13-T37). One row per
assistant-ui tool-use element, answering one question: did we hand-roll
something the catalog already provides? The catalog is the `elements` skill's
`references/catalog.md` ("Tool use" section) plus the two runtime-connected
tool elements from `references/aui-elements.md` and the approval card, which
is the third of the three decision elements `DialogBody` chooses between. The
registry's behaviour is taken from `references/standalone-elements.md`; ours
from the header comment of each file under
`packages/ui/src/components/assistant-ui/elements/`, read before any verdict.
Every mount claim below was checked with a grep of `packages/ui/src` on
2026-09-09.

Verdicts are one of four: **use the registry copy** · **ours diverged on
purpose, keep it** · **hand-rolled duplicate, replace** · **not applicable
here**. A "replace" is a proposed task at the end, not an edit.

## The rows

| Element | What the registry version does | What we mount (file) | Verdict |
| --- | --- | --- | --- |
| Tool call (`elements-tool-call`) | One invocation behind a disclosure: `label`/`activeLabel`/`query` strings, a `request`/`result` pair of paragraphs, `running`, `max-w-sm` | `elements/tool-call.tsx`, composed from the `tool-fallback` parts into the row grammar `[icon] verb summary ····· duration ›` with `peek` (collapsed excerpt), `children` (body) and `footer` (approval, interrupt, question — outside the fold). Mounted by `thread/ToolRow.tsx` for every Pi built-in (`read`/`write`/`edit`/`bash`/`grep`/`find`/`ls`), for `start_agent` (`StartAgentRow`: who was started, where it works, Open chat) and for a Namer-named unknown tool | **Ours diverged on purpose, keep it.** The header says why: the registry copy is a specimen with demo strings; ours is the DESIGN.md row grammar with the question kept outside the chevron. Not a duplicate of `tool-fallback`: it *is* those parts with a typed trigger |
| Tool timeline (`elements-tool-timeline`) | A session as verbs, targets and file stats; `visibleSteps` typewriter, a per-step `icon`, `restingLabel`/`activeLabel` | `elements/tool-timeline.tsx`: `toolTimelineFromParts` builds steps from real tool-call parts (verbs from `tool-summary.ts`, churn from `diff.ts`), icons by tool kind, `useThreadToolTimeline` reads the thread. Mounted in the monitor's **Tools** section, `shell/TelemetryPanel.tsx` `ToolsSection` | **Ours diverged on purpose, keep it.** `visibleSteps` and the icon prop are gone because the steps are real. One stale sentence in the file header ("inside an expanded `run` island") predated D-147; the mount is the monitor, and the header says so since M13-T61 (T-B below) |
| Terminal block (`elements-terminal-block`) | Command output streaming line by line (`lines`/`visibleCount`), `paper`/`ink` variants, `done`, a hard-coded `exit 0`, `max-w-md` | `elements/terminal-block.tsx`: dark ground in both themes, real exit code, a failure state distinct from a non-zero exit, head/tail elision with "Show all". Mounted by `thread/ToolRow.tsx` `BashBody` for `bash`. The logs pane uses only the decoder (`elements/ansi-text.tsx`, `logs/LogDetail.tsx`), by the inventory's reasoning: a log payload is a record, not something anyone ran | **Hand-rolled duplicate, replace — in one place.** The transcript mount is the element. But the fleet's task detail (`components/fleet/FleetPanel.tsx` `TaskOutputBody`, ~line 428) draws a second terminal: `bg-terminal` box, mono `text-terminal-ink`, `AnsiText`, its own scroller, "Showing the end of the output." — for a thing that *is* a command with an exit code (both shown as `<dl>` fields above it). That is exactly the element's grammar. The element lacks two things the fleet needs (a follow-to-bottom mode and a "tail from byte N" caption instead of its own `elideText`), which is why the duplicate grew. See proposed task T-A |
| Code diff (`elements-code-diff`) | A flat `{kind, text}` line list with `filename`, `additions`/`deletions`, a `cycle` counter and per-line animation delay | `elements/code-diff.tsx`: renders a `DiffView` from `thread/diff.ts` (pure, tested) with two gutters, hunk headers, a cap and a scroll region; exports `CodeDiffRows`/`DiffStat`; Shiki tokens layered lazily via `tool-code-highlights.tsx`. Mounted by `thread/ToolRow.tsx` `DiffBody` for `edit`/`write`; `DiffStat` reused by `file-tree` and `tool-timeline`. `preview/DiffPreview.tsx` drew through `CodeDiffRows` but had no caller since the panels went (D-147); removed in M13-T61 | **Ours diverged on purpose, keep it.** The header's reason — a diff whose lines wrap cannot be read for alignment — is the legibility floor. No hand-rolled diff anywhere else in `packages/ui/src` |
| Reviewable diff (`elements-reviewable-diff`) | The same diff with per-hunk keep/discard and an Apply | Not installed; the copied file was deleted | **Not applicable here.** Apply needs a `pi/project/apply` method the protocol does not have; an element whose primary control is inert is a dead control (R2). Re-install in the change that adds the method |
| File tree (`elements-file-tree`) | Pre-flattened nodes, `visibleCount`, totals | `elements/file-tree.tsx`: `fileTreeFromChanges` builds nodes from `{path, additions, deletions}` (single-child folder chains collapse; `test/elements/file-tree.test.ts`), `useSessionFileChanges` reads the thread's edit/write calls. Mounted in the monitor's **Files changed** section, `shell/TelemetryPanel.tsx` `FilesSection` | **Ours diverged on purpose, keep it.** Nothing else draws a file list from tool calls |
| Elicitation form (`elements-elicitation-form`) | `server`, `message`, static `fields` with values, `state`, Accept/Decline | `elements/elicitation-form.tsx`: real controls following the payload's `DialogField` (text, textarea with ⌘/Ctrl+Enter, choice buttons, checkbox), values owned by the controller, the caller's words on the action row, no card chrome. Chosen by `dialogs/DialogBody.tsx` for any question with something to type, including the rejection field after "No". Lands inline: `dialogs/InlineDialogs.tsx` (`ThreadDialogCards` above the composer, `ToolRowDialog` in a tool row) and `thread/ToolRow.tsx` `InterruptFooter` (assistant-ui's `interrupt`, answered with `resume`) | **Ours diverged on purpose, keep it.** Header lists the four divergences. `DialogBody` is glue (state, keyboard, timeout, submit), not a second form |
| Server panel (`elements-mcp-server-panel`) | Which MCP servers are connected, their tools, which one awaits authorization | Not installed | **Not applicable here.** The protocol carries no MCP server list (`pi/mcp/*` does not exist); the element would render invented rows. Protocol first, then the panel in Settings → Features |
| Tool failure (`elements-tool-error`) | The error plus `attempt`/`maxAttempts`, `retrying`, Retry and Skip | `elements/tool-error.tsx`: the error in danger ink on a code ground, `compact` = three-line excerpt for a collapsed row, `name`/`target` when the row does not already say. Mounted by `thread/ToolRow.tsx` as `peek` on every failed row and inside `ReadBody`/`DiffBody`/`TextBody` error sections | **Ours diverged on purpose, keep it.** Pi has no per-tool retry; the model decides what to do next, so Retry/Skip would be dead (R2). `tool-fallback.aui`'s `ToolFallbackError` draws the danger hairline on the row; the two are the row and its text, not two error cards |
| Permission grant (`elements-permission-grant`) | `capability`, `requester`, a `reach` list, fixed Deny / This session / Always, a `scope` state after answering | `elements/permission-grant.tsx`: scopes are the payload's own options, `isModeChangingOption` is the one judgement, "This grants" spells out each widening option, the decision closes on answer, no card chrome. Chosen by `dialogs/DialogBody.tsx` for a one-question `choice` with a mode-changing option; Enter never grants (autofocus on decline). Pi's project-trust prompt keeps its own body in `shell/TrustDialog.tsx` — the inventory row and the file header both say why (directory + trust-gated file chips the element's single `message` string cannot carry) | **Ours diverged on purpose, keep it.** `TrustDialog` is a documented exception, not a hidden duplicate |
| Computer use (`elements-computer-use`) | A driven screen with a cursor trail and the current step | Not installed | **Not applicable here.** laser does not drive a computer |
| Code runner (`elements-code-runner`) | A snippet with a Run button and attached output | Not installed | **Not applicable here.** No sandboxed execution surface in v1 |
| Tool fallback (`tool-fallback`, runtime-connected) | `ToolFallback` for any tool without a renderer: Root (Collapsible opening on `requires-action`), Trigger, Content, Args, Result, Error, Approval, `useToolCallElapsed` | `elements/tool-fallback.aui.tsx`: the same parts restyled to the row grammar and tokens; `ToolFallbackApproval` adds `denyFeedback` (Deny opens a reason, delivered as `Denied: …`), Enter never allows. `ToolFallback` itself is the row for an unknown tool (`thread/ToolRow.tsx`, `kind === "other"` without a Namer label); the parts compose every other row (`tool-call.tsx`, `ToolRow` bodies, `thread/GoalRecord.tsx`) | **Ours diverged on purpose, keep it.** Header lists four divergences. The approval is the registry's part with one addition; `ToolRow`'s `RowApproval` only supplies the `denyFeedback` callback |
| Tool group (`tool-group`, runtime-connected; standalone `elements-tool-group`) | Runtime: Root/Trigger/Content around consecutive tool calls, label "N tool calls", `variant` cva. Standalone: an explicit `tools` array with its own summary | `elements/tool-group.aui.tsx`: takes the chronological `group-activity` part from `MessagePrimitive.GroupedParts` (reasoning and tools together, D-89), the family summary from `thread/tool-groups.ts`, the thinking indicator while live, one design and no `variant`; `ActivityReasoning` in the same file is the transcript's reasoning row. Mounted by `thread/messages.tsx`; `TOOL_ICONS` shared with `ToolRow` and `tool-timeline` | **Ours diverged on purpose, keep it.** The standalone `elements-tool-group` is **not applicable**: it is a second design for the same row, and the inventory's rule is one design per surface |
| Approval card (`elements-approval-card`) | `state`, `command`, `title`, `subtitle`, fixed Allow once / Always allow / Deny, a running state after the answer | `elements/approval-card.tsx`: buttons are the payload's options or Yes + the rejection label, "No" opens the rejection field, closes on answer, no card chrome (the row, the composer card and the sheet each supply their own), 48px controls on touch; exports `DecisionHeader`, shared by all three decision elements. Chosen by `dialogs/DialogBody.tsx` for a one-question `confirm` or plain `choice`; lands where the elicitation form does | **Ours diverged on purpose, keep it.** Header lists five divergences, each tied to a rule (R12a, R7, R2) |

## What was checked and cleared

Everything under `packages/ui/src` that renders a tool call, a command, a
diff or a question was read for a hand-rolled version of the rows above:

| Place | What it draws | Finding |
| --- | --- | --- |
| `thread/ToolRow.tsx` | The Pi glue: summary, body choice, row registration | Composes elements only. `PlainSource` (a `<pre>` shown while Shiki loads for `read`) is a Suspense fallback, not a second highlighter. `StartAgentRow`'s where-line and Open chat have no catalog counterpart |
| `thread/ToolRow.tsx` `InterruptFooter`, `dialogs/InlineDialogs.tsx` `ToolRowDialog` / `ThreadDialogCards` | Questions | Both roads end in `DialogBody`, which chooses the three decision elements; no fourth renderer |
| `thread/GoalRecord.tsx` | The goal engine's durable record | `ToolFallbackRoot`/`Trigger`/`Content` + `Timeline`; nothing hand-rolled |
| `logs/LogDetail.tsx` | A log row's payload | `ansi-text` + `json-viewer`; a log row is not a tool call, so no tool element applies (inventory, "Terminal block") |
| `thread/TaskEventNotice.tsx` | A background command ended | Notice grammar on purpose — "a task exiting is bookkeeping, not a reply"; the output is one click away in the fleet |
| `thread/AgentCompletion.tsx` | A child's `complete_agent_run` | Projected out of the tool row deliberately (a run that ends reads like a reply that ends); no catalog element for it |
| `logs/ApiRequestDialog.tsx` | The captured request's tools section | The request inspector (D-97): `spec-sheet`, `json-viewer`, `shiki-highlighter`; its "tools" are definitions in a request, not calls |
| `components/fleet/FleetPanel.tsx` `TaskOutputBody` | A background command's output | **The one duplicate** (Terminal block row, task T-A) — done in M13-T60: `TaskOutputBody` is deleted and `TaskDetail` draws through `terminal-block` with `follow`, `truncatedHead` and `ansi` |

Adjacent, outside the tool-use section but seen on the way: the fleet's
`AgentDetail`/`TaskDetail` `Field` `<dl>` (Command · Elapsed · Ended · Exit
code · Output) is the labelled-rows shape `spec-sheet` exists for, and the
inventory's Spec sheet row once recorded exactly this `<dl>` being replaced in
the old run body. Noted for the fleet's owner; not a tool-use verdict.

## Counts

| Verdict | Count | Rows |
| --- | --- | --- |
| Use the registry copy | 0 | — (every installed copy is restyled to tokens, which alone is a recorded divergence) |
| Ours diverged on purpose, keep it | 10 | Tool call, Tool timeline, Code diff, File tree, Elicitation form, Tool failure, Permission grant, Tool fallback, Tool group, Approval card |
| Hand-rolled duplicate, replace | 1 | Terminal block (the fleet's `TaskOutputBody` only; the transcript mount stands) |
| Not applicable here | 4 | Reviewable diff, Server panel, Computer use, Code runner (plus the standalone `elements-tool-group` variant, inside the Tool group row) |

## Proposed tasks (not edits)

- **T-A · Draw the fleet's task output through `terminal-block`.** Give
  `elements/terminal-block.tsx` two props the fleet needs: `follow` (stick to
  the bottom while the task is live, keep the reader's place once it ends —
  the behaviour `TaskOutputBody` implements today) and `truncatedHead`
  (the host serves the tail from `fromByte`, so the caption "Showing the end
  of the output." replaces the element's own `elideText`, which must not
  elide an already-tailed window twice). Then `TaskDetail` renders
  `<TerminalBlock command={task.command} output={output.text} exitCode={task.exitCode} running={!item.terminal} isError={…} follow truncatedHead={output.fromByte > 0} />`
  and the Command/Exit code `Field`s go, since the block says both. Tests:
  the follow-scroll on a streaming task, a finished task not jumping, the
  tail caption, an empty output ("It printed nothing." stays outside the
  block), reduced motion, both themes, phone width in the sheet. Owner: the
  fleet lane; touches `packages/ui/src/components/fleet/FleetPanel.tsx`,
  `packages/ui/src/components/assistant-ui/elements/terminal-block.tsx`,
  `packages/ui/test/fleet/`.
- **T-B (housekeeping, one line) · Retire the "run island" sentence in
  `tool-timeline.tsx`'s header** to name the monitor's Tools section; the
  mount has been there since D-147. No behaviour change. Done in M13-T61,
  which also removed the unmounted element files the inventory's own standard
  named (`docs/ux-elements.md`, rows marked "file removed (M13-T61)").
