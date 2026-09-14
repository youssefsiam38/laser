# UX audit — Laser against the field of coding agents

Status: **audit, not a decision.** Nothing here is binding until a task from
§4 is added to `PLAN.md` and a decision is recorded in `STATUS_DETAILED.md`.
The standard applied is AGENTS.md "The bar: the Apple of coding agents"; the
constitution applied is [`packages/ui/DESIGN.md`](../packages/ui/DESIGN.md),
[`docs/ux-fleet.md`](ux-fleet.md), [`docs/ux-agent-work.md`](ux-agent-work.md),
[`docs/ux-elements.md`](ux-elements.md) and [`docs/ux-theme.md`](ux-theme.md).

Base: `2f4e31f` (main), built with `pnpm -r build`.

## 0. Method, and what counts as evidence here

**Part 1 — the field.** Eight agents were cloned read-only into
`/tmp/ux-audit/repos/` (shallow, `--filter=blob:none`) and read for their UX
surfaces: `sst/opencode` (TUI + Electron desktop), `Aider-AI/aider`,
`cline/cline`, `RooCodeInc/Roo-Code`, `block/goose`, `google-gemini/gemini-cli`,
`openai/codex`, `continuedev/continue`. For the two that cannot be cloned —
Claude Code and Cursor's agent — public docs, changelogs and community
threads were used, cited inline. Where a product's whole interaction
vocabulary was available as one artifact (OpenCode's
`packages/app/src/i18n/en.ts`, 1,150 lines; Roo Code's
`webview-ui/src/i18n/locales/en/chat.json`) that file was read in full, because
a localisation file is the most honest inventory of what a product actually
says to a person.

**Part 2 — Laser.** Run in the shared browser harness against a real built
host, seeded through real host RPCs:

```sh
node scripts/browser-check/run.mjs --target scripts/browser-check/targets/app.mjs \
  --fixture <empty|tools|agents|long|projects|mcp> [--matrix] --script <script> \
  --artifacts /tmp/ux-audit/shots/<name>
```

Seven runs (one of them a four-case `--matrix`), 62 screenshots, an
accessibility snapshot, DOM geometry measurements and `evidence.json` per run. Drive scripts are under
`/tmp/ux-audit/scripts/`; screenshots under `/tmp/ux-audit/shots/` (not
committed — they contain absolute paths from the harness's disposable home).
Surfaces the harness cannot reach — tray, native notifications, native update
— were read in `packages/desktop/src/`.

**Fact vs opinion.** Every row in §3 marked **measured** has a screenshot, a
DOM measurement, a log line or a `file:line` behind it. Rows marked
**judgement** are a designer's reading of that evidence and are argued, not
asserted. Timings from the harness are *stub-provider* timings and say nothing
about real model latency; they are only used where they measure the app's own
work (commit-to-paint, scroll).

---

## 1. Executive summary — the ten things that would most raise a developer's satisfaction

Ranked by how much a working developer would feel the change, weighted by how
far the current state sits from the stated bar.

| # | Finding | Severity | Why it is first |
| --- | --- | --- | --- |
| 1 | **On a 1360px window the conversation gets 318px — narrower than the phone's 348px.** All four columns default open at ≥1280px, so rail 56 + sessions 288 + fleet 320 + monitor 320 = 984px of chrome around 376px of thread. `--measure-thread: 84ch` is unreachable until the window is roughly 1700px wide. | blocks satisfaction | The reading column is the product. A 1366×768 laptop is the single most common developer screen, and on it Laser shows the agent's answer in ~40 characters per line while two columns say "Nothing is running here" and "No tools in the loaded history". |
| 2 | **A child agent's question and a child agent's failure reach the person as text written for a model.** The parent's transcript renders, verbatim: *"Answer it with `send_agent_message` with its `sessionId` and mode `"answer"` … `inspect_agent` with runId `run_bacdf524` shows whether it is still open"*, and for a failure `400: {"message":"Deterministic fixture failure","type":"invalid_request_error"}`. | blocks satisfaction | This is the exact thing AGENTS.md forbids twice over — a raw provider payload in the UI and harness tool vocabulary in a person's sentence — on the surface the fleet exists to make calm. |
| 3 | **"1 needs you" and there is nothing to press.** A child paused on a question shows in the fleet header count, the fleet row, the sidebar and the parent's transcript, and none of those four places can answer it. The only control is "Open chat". | blocks satisfaction | Every competitor answers an approval where it surfaces. Counting an obligation you cannot discharge is worse than not counting it. |
| 4 | **No diff review, no revert, no checkpoint.** There is no `project/apply`, `project/revert` or snapshot in the protocol; "Create a pull request" hands the person a `$`-prefixed script to copy and run in a terminal (`thread/ProjectLine.tsx:162`). | blocks satisfaction | Cline, Roo, Gemini CLI, Claude Code, Cursor and OpenCode all ship snapshot-and-restore, and developers say it is *what makes delegation feel safe*. Laser is the only one of the ten with no way back, and its own bar says "The person never needs a terminal." |
| 5 | **Settings → Help and shortcuts ships the engine's whole terminal keymap as editable rows** — `tui.altScreen.halfPageUp`, `tui.editor.yankPop`, `tui.select.pageDown`, ~50 of them, each with a **Change** button, ending in the agent's `keybindings.json` path. | blocks satisfaction | These keys do nothing in Laser: there is no alt screen and no terminal editor. It is invariant 6b drift on the *Help* tab, and it teaches the person that Laser is a front-end for something else. |
| 6 | **Approval granularity is one question at a time, forever.** No auto-approve policy, no per-tool rule, no allow/deny list, no "always allow this command", no read-only mode. `permission-grant` renders whatever scopes the payload declares and nothing more. | friction | Goose has four modes, Cline has an eight-row permission matrix, Roo lets you add a command to an allow list from inside the tool row, Claude Code cycles modes with one key. A developer who approves the same `npm test` forty times stops trusting the product. |
| 7 | **Nothing lets you steer *before* the agent acts.** No plan/act, no read-only mode, no "propose first". `session/set_mode` exists in the protocol and the worker refuses it (`worker/src/server.ts:277`). | friction | Plan mode is the single most-praised interaction in Claude Code, Cline, Gemini CLI, Roo and Continue. It is also the cheapest safety net that does not need a snapshot store. |
| 8 | **Ten projects render as nine identical `P0` rings**, and the sessions column opens every project group at once (10 × 7 rows + "Load more"). | friction | Project identity is the top-level navigation of a multi-project app and it is currently unreadable. OpenCode lets a person pick a project's icon and colour; Laser derives two characters from a directory name. |
| 9 | **The fleet has a keyboard shortcut nobody can find.** `\` is bound (`shell/Shell.tsx:278`) but appears in neither Settings → Help and shortcuts nor the command palette, which lists only `[` and `]` — and lists `]` twice, for two different actions. | friction | The fleet is one of the three constitutional surfaces. Its only keyboard path is undocumented. |
| 10 | **Tool rows truncate their verb before their argument.** At 318px the row renders `R… printf 'fixture tool outp… ›` — the one word that says *what happened* is the first thing dropped. | friction | Symptom of #1, but it is its own bug: the row grammar should shrink the argument, never the verb. |

Two things are worth saying because they are *already at the bar* and should
not be traded away while fixing the above:

- **Settings → MCP servers** is the best plain-language MCP surface in the
  field. "What it offers", "What it says about itself", "tells us when its
  tools change", capability chips, five verbs, and a real inspector with
  Tools/Run/Resources/Prompts. Nothing in OpenCode, Cline or Goose reads as
  well. (`/tmp/ux-audit/shots/mcp/*/mcp-inspector.png`)
- **Reduced motion is genuinely clean.** With `prefers-reduced-motion: reduce`
  the harness found *zero* elements still running an animation or a non-zero
  transition (`/tmp/ux-audit/out-mcp.log`, `MOVING UNDER REDUCED MOTION` block
  is empty). Most of the field does not test this at all.

---

## 2. The field

### 2.1 What each one does, dimension by dimension

`OC` OpenCode · `AI` Aider · `CL` Cline · `RC` Roo Code · `GO` Goose ·
`GC` Gemini CLI · `CX` Codex CLI · `CN` Continue · `CC` Claude Code (docs) ·
`CU` Cursor agent (docs)

| Dimension | OpenCode | Aider | Cline / Roo Code | Goose | Gemini CLI | Codex CLI | Continue | Claude Code | Cursor |
| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |
| **(a) First run / onboarding** | Home screen with recent projects, recently closed, project add, provider tip; `dialog-connect-provider` groups providers as *popular* vs *other* with per-provider notes, three connect methods (browser OAuth, pasted code, API key) and a custom-provider form | `onboarding.py`: pick a model, offer to set a key, analytics consent | Welcome view → provider/API key → first task; Roo's welcome carries two "tips" cards that argue the product's value | `onboarding/` = provider selector, config form, local-model picker, privacy modal, success screen, telemetry consent | Theme + auth on first launch; trusted-folders dialog on first entry into a directory | Login flow, then `Ask Codex to do anything`; `keymap_setup` offers a keymap | `OnboardingCard` with model setup | Terminal login; `/init` writes `CLAUDE.md` | Editor-native, no separate onboarding |
| **(b) Composer** | `/` slash popover with **badges per source** (`custom` / `mcp` / `skill`), `@` mentions incl. app connectors, paste + drag-drop images/files with a dropzone overlay, prompt **history** (up/down), a **shell mode** (the composer becomes a terminal line), queue-vs-steer as a **setting**, per-toast failure reasons | `/`-commands (44 of them), `/paste` image, `/voice`, `/multiline-mode`, `/editor` opens `$EDITOR` | `@`-context (files, folders, problems, terminal, git), images, `/`-commands, **Enhance prompt** button, queued messages, drag files with Shift | Chat input card, mention popover with a resource limit, message queue with stale-edit handling, dictation | `@` file mentions with completion, `/` commands, image paste, shell passthrough with `!` | `@` unified mention popup (files + connectors), image attach with **renumbering after deletion**, draft queue hint in the footer, reasoning-effort keys, paste-burst detection so a fast paste is not read as Enter | TipTap editor, `@`-mention dropdown, mode select, context "Lump" above the input | `@`, `/`, images, queued messages, `Esc` to interrupt | `@`, images, `/`-commands |
| **(c) Showing agent work** | Per-tool-type default expansion (`editToolPartsExpanded`, `shellToolPartsExpanded` as settings), a **steps** toggle, todo list with progress, reasoning summaries toggle, a `debugBar` with fps/CLS/INP/jank | Streamed markdown, coloured diffs inline, repo-map summary | Roo: a distinct sentence per tool *and per location* — "Roo wants to read this file **outside of the workspace**", "…a **protected** configuration file"; command rows show PID, exit status, expand/collapse output | `ToolCallWithResponse` with a status indicator, `ThinkingContent`, `ProgressiveMessageList` | Tool call groups, `/stats` | `exec_cell` and `diff_render` in-terminal, `inline_visualization` | `StepContainer` + `ConversationSummary` + `ThinkingIndicator` | Collapsed tool calls, `Ctrl+O` verbose | Session-level aggregate |
| **(d) Approvals / permissions** | `command.permissions.autoaccept.enable/disable`; per-category notification settings | `--yes-always`, `/ok` | Cline: **8-row matrix** (read project / read all / edit project / edit all / safe commands / all commands / browser / MCP) with workspace-vs-outside as an explicit axis; model marks each command `requires_approval`. Roo: same plus **inline** "Add to allowed list" / "Add to denied list" on the command row, batch **Approve All / Deny All**, an auto-approve trigger label that counts (`3 auto-approved`, `BRRR` for all), and an auto-approved-request **limit warning** | Four modes: *Autonomous* / *Ask before* / *Smart approval by risk* / *Chat only*, plus a per-tool permission modal (always / ask / never) and `GOOSE_MAX_TURNS` | Approval modes incl. **Plan**; trusted folders | `approval_overlay` with per-decision scopes: session-scoped, command-prefix-scoped, network-host-scoped, "don't ask again" | Auto-approve toggles per tool | Permission modes cycled with `Shift+Tab` (terminal) / `Cmd+Shift+M` (desktop) | Auto-Run toggle, Plan Mode |
| **(e) Diff review / apply / revert** | A **Review tab** per session: files changed, diffs, "no uncommitted changes", and a *create a git repo* CTA when there is no VCS; a **revert dock** with restore; `session.undo` / `session.redo` commands | `/diff`, `/undo` (undoes the last aider commit), auto-commit per change with generated messages | Cline: shadow-git **checkpoint after every tool use**, with Compare / Restore and three restore modes (files / task / both). Roo adds "View Changes Since This Checkpoint", "Scroll to previous checkpoint", and a `FileChangesPanel` counting "{{n}} file(s) changed in this conversation" | — | `/rewind` (also `Esc Esc`): pick an interaction, see how many files changed at it, then choose *rewind conversation and revert code* / *rewind conversation* / *revert code*; options that would do nothing are hidden | `get_git_diff`, `diff_model`, apply-patch approval with a destination line | `AcceptRejectDiffButtons` inline in the editor | `/rewind`, `Esc Esc`; checkpoints per prompt, explicitly *not* a Git replacement | Selective accept/reject; checkpoints outside Git |
| **(f) Multi-session / multi-agent / background** | Sessions as **drag-sortable titlebar tabs**, including **terminal tabs**; `session.next.unseen` / `previous.unseen`; worktree choice at session creation (`main`, `main with branch`, `create worktree`); per-project worktree startup command | One session, git branches | Cline subagents; Roo subtasks with "Complete subtask and keep going" and "View task", worktree selector | Recipes, schedules (`schedule/`), session list view | Subagents, git worktrees doc | `cloud-tasks`, `agent-graph-store`, `worktree` crate, `branch_summary` | `BackgroundMode` + `AgentsList` | Parallel/background agents, desktop redesign aimed at parallel work | `/multitask`, background agents on branches |
| **(g) Context visibility** | A **context breakdown** by role — system / user / assistant / tool / other — in tokens, chars and percent, plus raw-message and system-prompt inspectors and per-session stats (cache tokens, reasoning tokens, cost, limit) | `/tokens` prints a per-file token table; `/context`; repo-map size control | Roo's context bar has **three** segments: used / reserved-for-response / available; context **condensation** and **truncation** appear as transcript events with "{{n}} messages removed" | Alert box with a compact button and an adjustable threshold | `/stats`, token caching doc | `footer_context_tokens_used` in the status line | `ContextStatus` | `/context` | Usage view |
| **(h) Errors and recovery** | A structured error **chain**: `causedBy`, `checkConfig`, `configDirectoryTypo`, `didYouMean`, `modelNotFound`, `providerAuthFailed`, `retryable`, `status`, `responseBody`; a dedicated error page with Restart / Export logs / Check updates / Report | Retries with backoff, prints the provider message | Roo maps **HTTP status to a human sentence plus an action**: 402 → "You seem to have run out of funds/credits… Go to your provider and add more", with `Docs` and `Settings` links; also "Model Response Incomplete" with a written explanation of *why* a model returning no tool calls is a failure | Alerts with an action and optional progress; credits-exhausted notification | Structured tool errors | `feedback_view`, `auto_review_denials` | `InlineErrorMessage` | Retry, `/doctor` | Restore checkpoint (reported as flaky) |
| **(i) Speed feel** | Streaming, virtual scrolling (`virtual-scroll-element`), `ProgressiveMessageList`-style paging, a perf HUD with frame/jank/INP | Live markdown stream (`mdstream.py`) | Streaming + a spinner per tool | `ProgressiveMessageList` | Streaming | Ratatui custom terminal, `ascii_animation`, `frames.rs` | Streaming | Streaming; default reasoning effort lowered high→medium in Mar 2026 specifically because high made it look frozen | Streaming |
| **(j) Settings / models / providers** | 60+ locales; theme, colour scheme, UI font, terminal font, pinch zoom, Wayland, WSL, per-project icon and colour; models dialog with per-provider toggles; a servers dialog for remote hosts; release-notes dialog | YAML/env config, `/model`, `/settings` | Full settings webview, provider profiles, mode↔profile locking | `settings/` with providers, models, extensions, dictation, permissions, security, response styles | `/settings` searchable | `config.md`, `experimental_features_view`, `memories_settings_view` | Config UI + `config.yaml` | `/config`, `/model` | Settings pane |
| **(k) Keyboard-first / a11y** | ~50 named commands, **all remappable** in `settings-keybinds`, each with a description; command palette grouped by 18 categories; an explicit `debugBar.direction` LTR/RTL toggle | Terminal-native; prompt-toolkit bindings | VS Code keybindings | Electron menus | Terminal-native | `keymap/` + `keymap_setup`, "customize shortcuts with …" in the footer, chord tokens | VS Code keybindings | `Esc`, `Esc Esc`, `Shift+Tab`, `Ctrl+O`, `Ctrl+R` | Editor keybindings |
| **(l) Mobile / remote** | `mobileTitlebarBottom` setting, pinch-zoom setting, a web build, remote server picker with username/password | — | — | — | — | `cloud-tasks` | — | Web + mobile surfaces | Web/mobile agent, called "clumsy" by users |

### 2.2 What developers actually praise and complain about

Praised, with sources:

- **Reversible agency** is the single most-cited reason people trust an agent:
  plan first, interrupt instantly (`Esc`), queue the next instruction, rewind
  a bad turn. Claude Code's checkpointing, `/rewind` and `Esc Esc` are
  repeatedly named; the documented caveat is that Bash-made edits are not
  covered, so it is not a Git replacement.
  ([Claude Code — Checkpointing](https://code.claude.com/docs/en/checkpointing),
  [Interactive mode](https://code.claude.com/docs/en/interactive-mode))
- **Plan mode**, praised because it makes a risky refactor reviewable before
  anything is written; `Shift+Tab` cycles permission modes.
  ([Claude Code — Permission modes](https://code.claude.com/docs/en/permission-modes),
  [Gemini CLI — Plan mode](https://github.com/google-gemini/gemini-cli/blob/main/docs/cli/plan-mode.md))
- **Queued messages** — typing the next instruction while the agent works,
  "manager-style" — is core enough that Anthropic's changelog keeps iterating
  on queue editing, duplication and interruption edge cases.
  ([Changelog](https://code.claude.com/docs/en/changelog))
- **Visual diffs and multi-session layouts** are the stated reason developers
  move from a terminal agent to a desktop one; Anthropic's April 2026 desktop
  redesign was explicitly aimed at parallel agents.
  ([Redesigning Claude Code on desktop](https://claude.com/blog/claude-code-desktop-redesign))

Complained about, with sources:

- **Review after the fact instead of approving the proposal.** Cursor's move to
  session-level aggregate review drew a long thread titled *"Bring back
  per-change Apply + inline diff review — you're throwing away your best UX
  advantage"*; users report changes landing on disk before they consciously
  approved them.
  ([Cursor forum](https://forum.cursor.com/t/bring-back-per-change-apply-inline-diff-review-you-re-throwing-away-your-best-ux-advantage/160856))
- **Worktrees that feel like a regression**: 30–60s setup, repeated shell
  approvals, and *no UI indicator of which window is a worktree*.
  ([Cursor forum](https://forum.cursor.com/t/worktree-ux-regression/158769))
- **Checkpoint restore that disappears**, reported across many versions, which
  is worse than not having it, because people stopped keeping their own
  safety net.
  ([Cursor forum](https://forum.cursor.com/t/revert-restore-checkpoint-button-missing/165791))
- **"Frozen" perception from high reasoning effort** — Anthropic changed the
  default from high to medium to reduce it.
  ([Anthropic engineering](https://www.anthropic.com/engineering/april-23-postmortem))
- **Terminal friction and rendering/keybinding failures** are among the most
  common observable issue categories in a 2026 study of 3,800+ public bug
  reports across Claude Code, Codex and Gemini CLI.
  ([arXiv 2603.20847](https://arxiv.org/abs/2603.20847))
- **Electron sluggishness** remains a live complaint about desktop agents even
  after redesigns.
  ([Daring Fireball](https://daringfireball.net/2026/07/claudes_criminally_bad_mac_app_is_an_inside_job))

**What the field has that Laser has deliberately refused, and should keep
refusing.** Session sharing/publishing (OpenCode, Roo), cloud agents (Roo,
Cursor), a fake progress percentage (nobody has one that is honest —
`ux-fleet.md` R6 is right and OpenCode's todo progress is the closest anyone
comes to being honest about it), and a general display bus. Roo's product is
also being archived, which is a reminder that feature count is not the metric.

**What the field has that Laser has refused for a reason that has expired.**
Nothing in §1 requires a UI bus, a per-extension view, Pi vocabulary, or a
declared panel contract. Plan mode is a worker capability behind an existing
protocol method. Diff review is a protocol method plus an element that is
already claimed and already written (`elements-reviewable-diff`). Auto-approve
is a settings row and a worker policy. Every proposal in §4 stays inside
D-147, D-140 and invariant 6b.

---

## 3. Laser findings

Severity: **B** blocks satisfaction · **F** friction · **P** polish.

### 3.1 Layout and legibility

| # | What a developer experiences | Where | Best in class | Sev | Proposal |
| --- | --- | --- | --- | --- | --- |
| L1 | **measured** — at 1360×900 the transcript's message width is **318px** and the composer 318px, while two 320px asides show "Nothing is running here" and "No tools in the loaded history". At 390px the same message is **348px** wide. The desktop reading column is 30px *narrower than the phone's*. `--measure-thread: 84ch` (`globals.css:217`) is ≈655px at the 14px base, so it does not bind until the window is ≈1700px (984px of chrome + padding). | `components/shell/Shell.tsx:180` (`prefs.fleet ?? true`, `prefs.telemetry ?? isWide`), evidence `/tmp/ux-audit/out-long.log` GEOM lines; shots `long-1360-{dark,light}.png` vs `long-390-dark.png` | OpenCode keeps one resident sidebar and puts review/context/files behind **tabs on the session**, so the conversation owns the remaining width; Claude Code desktop's parallel-agent layout does the same | **B** | Make the two right columns *earn* their width. Default the fleet and the monitor **closed** below ~1600px and open them on demand (they are already collapsible and already have a sheet form below 1280). Better: keep the fleet resident but let it and the monitor **share one column** with a segmented control, as `canvas-split`/Canvas is already claimed for in `ux-elements.md` ("exactly what a resizable side column will want"). Add a measured floor: the thread never goes below `--measure-prose` without a column closing itself first. |
| L2 | **measured** — the tool row renders `R… printf 'fixture tool outp… ›`. The verb is truncated to one letter before the argument loses a character. | `thread/ToolRow.tsx` / `elements/tool-call.tsx` row grammar; shots `tools-transcript.png`, `conversation-map.png` | Roo writes the whole sentence ("Roo wants to read this file") and truncates the *path*; Codex's `line_truncation.rs` is a module | **F** | Row grammar shrinks right-to-left: duration → argument → summary → verb. The verb never truncates; if the row cannot fit the verb, the row is broken and the column is too narrow (see L1). |
| L3 | **measured** — the conversation-map rail's hover preview card opens **over** the transcript and covers the message under it, because at 318px there is nowhere else for it to go. The rail's dashes also sit on the right edge of user bubbles. | `elements/conversation-map.aui.tsx`; shot `conversation-map.png` | — | **F** | Gate the map rail on available *thread* width, not on the `lg` breakpoint; it is a navigation aid and must never occlude the thing it navigates. |
| L4 | **measured** — ten projects render as **nine identical `P0` rings** plus one `P1`, because the mark is the first two characters of `project-01…project-10`. | `components/shell/` project rail; shot `sidebar.png` (10-project fixture) | OpenCode's `dialog-edit-project` lets a person choose a project **icon** and **colour**, with a "recommended" hint | **F** | Derive the mark from the *distinguishing* part of the path, not the first two characters, and let a person override the mark and its hue in the project's Actions menu. Both are token-driven (`--project-hue-*`), so nothing static enters a component. |
| L5 | **measured** — with 10 projects × 15 sessions, every project group is expanded, so the list is 10 × (7 rows + "Load more") before project-10; and every one of the 150 rows wears the unread ring, so the marker carries no signal. | `elements/thread-list.aui.tsx`; shot `sidebar.png` | OpenCode's home groups **across** projects by Today / Yesterday / Older and adds a scoped search placeholder | **F** | Collapse a project group by default once there is more than one project with history; keep the current project open. Consider a **Recent** section above the groups (across projects, newest first) — it is the same rows, not a second list, so D-103 holds. |
| L6 | **measured** — the smallest rendered text at 1360px is 11px, and it is the column header **"FLEET"**, which DESIGN.md permits as an uppercase eyebrow; at 390px the smallest is 12px. Recorded because the check was run, not as a defect. | `out-long.log` `smallestFont` | — | — | No action. The legibility floor holds at both widths in both themes; the harness also found **no unintended clipping** (every element whose content exceeded its box was a deliberate `overflow:hidden`/ellipsis truncation) and **no horizontal page overflow** in any of the four matrix cases. |

### 3.2 Agent work, questions and errors

| # | What a developer experiences | Where | Best in class | Sev | Proposal |
| --- | --- | --- | --- | --- | --- |
| A1 | **measured** — the parent's transcript shows, as prose to the person: *"fixture-asking is paused on a question and cannot continue until it is answered (raised by its `fixture_echo` tool). … Answer it with `send_agent_message` with its `sessionId` and mode `"answer"` and one of the choices, exactly, as the message. Or leave it: the person can answer it in fixture-asking's own chat. `inspect_agent` with runId `run_bacdf524` shows whether it is still open."* | `worker/src/agents/harness.ts:2789` `questionMessage()` builds the **model-facing** text; `thread/AgentEventMessage.tsx:52` renders `event.message` verbatim through `MarkdownPreview` | Roo/Cline render a written sentence per event and never expose the tool that produced it | **B** | Split the two audiences. `lasercode/agent-event` already carries typed fields (`subagentName`, `agentName`, `run`, `endedBy`); add the question as typed data (it already exists as `AgentRunQuestion` on the run) and let `AgentEventCard` draw it with `DialogBody` — the same **Approval card / Permission grant / Elicitation form** trio every other question uses (`ux-elements.md`). The model keeps `questionMessage()`; the person never sees it. |
| A2 | **measured** — a failed child renders `400: {"message":"Deterministic fixture failure","type":"invalid_request_error"}` as the body of the event card. | `harness.ts` `modelMessage()` `case "failed": body = run.error` → same card | Roo maps status → sentence + action: 400 → *"The provider couldn't process the request as made. Stop the task and try a different approach."*, with `Docs` and `Settings` buttons | **B** | Classify the failure in the worker into `{ kind, humanTitle, humanDetail, action }` and carry that on the run, keeping the raw string for the Logs screen and the API inspector where it belongs. Draw it with the adopted **Error state** / **Stopped run** elements, which already exist and already take an action. |
| A3 | **measured** — the fleet header says "1 going · 1 needs you"; the fleet row says "fixture-asking · Asking · MCP: fixture wants to run echo Arg…"; the sidebar shows the pulse; the parent's transcript shows the card. **None of the four can answer.** The only control is "Open chat". (`ux-fleet.md` confirms by design: the expanded detail offers Open chat / Stop / Remove worktree.) | `components/fleet/FleetPanel.tsx`, `elements/subagent-list.tsx`; shots `agents-transcript.png`, `fleet-expanded.png` | Every competitor answers where it surfaces; Goose's `ElicitationRequest`, Roo's approval row, Codex's `approval_overlay` | **B** | A child's question is still "a question the person has to answer", so it is allowed inline in the transcript by D-147 — **answer it in the parent's event card**, through the same `DialogBody`. It goes back as `send_agent_message` mode `answer` from the *UI*, not from the model. The fleet row keeps Open chat and gains nothing: the fleet is where you see it, the conversation is where you answer it, which is the existing rule. |
| A4 | **measured** — the fleet row's activity line is raw JSON: `MCP: fixture wants to run echo Arguments: { "text": "Please approve this fixture call." }`. `ux-fleet.md` says the line is "what it is doing in its own words" and "this is a row, not a record". | `elements/subagent-list.tsx` line derivation from `AgentRunQuestion` | — | **F** | Use the question's `title` only for the row line, and put its arguments in the expanded detail (where the docs already put them). |
| A5 | **judgement** — Beam's bubble is ~400px wide and the thread column at 1360px is 376px, so opening Beam covers the conversation and puts two composers, both reading "Message the agent…", side by side. | `components/beam/`; shot `fleet-expanded.png` | — | **P** | Anchor the bubble to the spark and size it against the *available* width, not a fixed one. Follows from L1; if the thread is wide, this is a non-issue. |
| A6 | **judgement** — one thing has four names in the product: **Agents** (page, sidebar), **Subagents** (Features card title, with chips "Delegation / Sub Sessions / Worktrees"), **Harness** (Agents page section heading, "Limits · Depth 3 · commands 120s") and **fleet** (column). | shots `settings-features.png`, `agents-page.png` | OpenCode calls one thing one thing across 60 locales | **P** | One noun. "Agents" everywhere a person reads; "fleet" only for the column of *work*. "Harness" and "Sub Sessions" are internal words. "commands 120s" needs a sentence. |

### 3.3 Trust, review and the way back

| # | What a developer experiences | Where | Best in class | Sev | Proposal |
| --- | --- | --- | --- | --- | --- |
| T1 | **measured** — there is no protocol method for applying, reverting or snapshotting project changes. The full method inventory contains `pi/project/{add,browse,files,git,read,remove,reorder,trust,...}` and nothing that writes. `elements-reviewable-diff` is deleted with the note that it needs "a `pi/project/apply` method the protocol does not have". | `packages/protocol/src/`; `ux-elements.md` "Reviewable diff" | Cline/Roo shadow-git checkpoints with three restore modes; Gemini CLI `/rewind` with per-interaction file counts and options hidden when they would do nothing; OpenCode's revert dock + `session.undo`/`redo` | **B** | Protocol first, as invariant 2 requires: a `project/snapshot` taken by the worker before each write tool, and `project/restore { files? , conversation? }`. It maps cleanly onto Pi's session tree for the conversation half (`pi/session/navigate` already exists — Jump is *already* "rewind conversation"), so only the file half is new. Then re-install `elements-reviewable-diff` in the same change, as its row instructs. |
| T2 | **measured** — "Create a pull request" renders a `$`-prefixed script for the person to copy and run elsewhere, and its footnote says the second line needs the GitHub CLI. | `thread/ProjectLine.tsx:162–200`; the file's own comment explains why | OpenCode's Review tab offers *"create a git repo"* as a button when there is no VCS | **B** | The stated reason (a push must not happen behind your back, and `gh` opens a browser on the wrong machine from a phone) argues for **confirmation**, not for a terminal. Commit and push through the host with an explicit confirm dialog that names the branch and the remote; keep the copyable commands as the *secondary* path for the phone case, where `ux-fleet.md` R4 says to put the reason where the control would have been. |
| T3 | **measured** — there is no approval policy of any kind: no auto-approve, no per-tool rule, no command allow/deny list, no session-scoped grant beyond whatever scopes a payload happens to declare. `mcp.json` has an `approve?: boolean \| string[]` per server, and that is the whole story. | `elements/permission-grant.tsx`, `protocol/src/mcp.ts:90` | Cline's 8-row matrix with an explicit workspace/outside axis; Roo's inline "Add to allowed list" on the command row and batch Approve All; Goose's four modes; Codex's per-decision scopes (session, command prefix, network host) | **B/F** | A **Permissions** section in Settings (General, not Advanced — this is a product capability, not engine plumbing) with the categories Laser actually has: read, write, run commands, MCP tools, network. Per category: *ask · allow in this project · never*. Then put **"Always allow `npm test …`"** into the tool-approval footer itself, which `permission-grant` already supports ("Scopes are the payload's options") — it just needs the worker to offer those options. Enter must still never grant (the existing rule). |
| T4 | **measured** — `session/set_mode` is in the protocol and the worker refuses it: `throw new ProtocolError(ErrorCodes.Unsupported, "session/set_mode is not supported by this worker yet")` (`worker/src/server.ts:277`). There is no plan/read-only mode in the product. | `worker/src/server.ts:276` | Plan mode in Claude Code, Cline, Gemini CLI, Roo, Continue, Cursor — the most-praised single interaction in the field | **F** | Implement `session/set_mode` with two modes, `build` (today) and `plan` (read and search tools only, no write, no command execution). Surface it as a segmented control in the composer toolbar beside the agent selector, and in the status line's words ("planning" / "working"). No new noun: a mode is a session property, like the model and the thinking level. |

### 3.4 Keyboard, discoverability and settings

| # | What a developer experiences | Where | Best in class | Sev | Proposal |
| --- | --- | --- | --- | --- | --- |
| K1 | **measured** — Settings → Help and shortcuts lists ~50 rows of the *engine's terminal* keymap with **Change** buttons: `tui.altScreen.halfPageUp`, `tui.altScreen.nextPrompt`, `tui.editor.cursorWordLeft`, `tui.editor.yankPop`, `tui.select.pageDown` …, then "The agent reads them from one file, shared by every project on this machine: `…/agent/keybindings.json`". None of these keys does anything in Laser. | `components/settings/KeyboardTab.tsx` (the file's header states the intent); shot `settings-help-and-shortcuts.png`, dump in `/tmp/ux-audit/out-surfaces.log` | The `/` popover already excludes the engine's builtin terminal commands for exactly this reason ("open pickers in a terminal UI this app never runs") | **B** | Apply the same rule to keys. Remove the engine keymap from Help and shortcuts. If any of it must remain reachable, it belongs in the permanent **Advanced** tab, described as what it is. Then spend the reclaimed page on the keys Laser *does* answer to — and on making them changeable, which is what the field expects. |
| K2 | **measured** — `\` toggles the fleet (`shell/Shell.tsx:278`) and appears in **neither** Settings → Help and shortcuts **nor** the command palette. The palette's App group is: New session, Add a project, Hide sessions `[`, Hide telemetry `]`, Settings, Agents, Logs, Dark theme — no fleet. And `]` is shown on two different rows ("Open history" and "Hide telemetry"). | `settings/KeyboardTab.tsx:50–75`, `shell/CommandPalette.tsx:100–114`; shot `command-palette.png` | — | **F** | Add the fleet to both, and disambiguate `]`: one key, one row, with the narrow-window behaviour as the row's detail (the way `]`'s telemetry row already does it). |
| K3 | **judgement** — the app answers to eight global keys, seven of them documented. There is no key for: next/previous session, next/previous project, stop the current turn, open the agents page, change the activity detail level, or approve/deny the question in front of you. `Esc` closes sheets and dialogs but does not stop a turn. | `shell/Shell.tsx` keydown handler | Claude Code's `Esc` to interrupt is named in every review as one of its best interactions; OpenCode ships ~50 named, remappable commands; Codex's footer advertises "customize shortcuts with …" | **F** | Two additions carry most of the value: **`Esc` stops the turn** when the thread is focused and nothing is open above it (the existing `stopFirst` sequence already owns "stop, then do the thing"), and **`Ctrl/Cmd+↑/↓`** moves between sessions in the sidebar's order. Both go into Help and the palette in the same change. |
| K4 | **measured** — tabbing through the composer lands on a `role="note"` `<span tabIndex={0}>` reading "Stub One does not reason, so there is no thinking level". It is deliberate (`reasoning-effort.tsx:308–329`) so the tooltip is reachable, but it is a dead stop in the keyboard path. | `elements/reasoning-effort.tsx:314`; `/tmp/ux-audit/out-empty.log` TAB ORDER | — | **P** | Keep it reachable but move it out of the sequential path: the reason belongs on the *disabled control's* accessible description, or the row should be skipped with the explanation available from the control it replaced. |
| K5 | **judgement** — the Features cards each end with the identical line "Laser default · Changing this restarts the affected project", four times on one screen. | shot `settings-features.png` | — | **P** | Say it once, above the grid. A card's footer is for what is different about *that* card. |

### 3.5 Telemetry, logs and honesty

| # | What a developer experiences | Where | Best in class | Sev | Proposal |
| --- | --- | --- | --- | --- | --- |
| M1 | **measured** — the monitor shows `$0 session`, `$0 last turn`, `$0` per model line, `Per turn $0`, `Spend over turns $0 +$0 last` — five zeros in one 320px column. `ux-elements.md` Cost meter says: *"'not measured' instead of `$0`"*. | `shell/TelemetryPanel.tsx` + `elements/cost-meter.tsx`; shots `tools-transcript.png`, `sidebar.png` | Roo shows tokens/cache/cost in one compact task header line and hides what is zero | **P** | Collapse the cost block to one line while it is zero, and honour the element's own rule: an unmeasured value says so, a genuinely-zero one says `$0` once. |
| M2 | **measured** — the monitor says "These totals cover the messages loaded so far. Scroll up in the conversation to load more of it." as a banner, then "Totals cover the messages loaded so far." again inside USAGE, ~200px lower. | `shell/TelemetryPanel.tsx`; shot `long-1360-light.png` | — | **P** | One sentence, attached to the number it qualifies. |
| M3 | **measured** — the Logs screen's default view is dominated by one internal message: of the visible rows, ~60% are `module:subagents  lifecycle late-callback-dropped kind=… invocation=1:2 phase=idle at=2026-…`. Engine-shaped vocabulary (`invocation`, `phase`, `late-callback-dropped`) is the first thing a person reads on that screen. 3,920 rows / 9.7 MB in a fixture session with seven turns. | `logs/LogsScreen.tsx`; shot `logs.png` | OpenCode has an explicit `command.logs.export` and an error page that offers *Export logs* as an action rather than a browsing surface | **F** | Two things, separately: (1) make `debug` off by default in the level filter, so the screen opens on what a person can act on; (2) look at whether `late-callback-dropped` firing a dozen times per turn is a log-level mistake or a real defect — either way it should not be the shape of the product's log screen. |
| M4 | **judgement** — the global search dialog is a fixed ~660px tall panel; one result leaves ~400px of empty space, and a session with "4 hits" shows one excerpt with no way to step through the other three from the dialog. | `elements/thread-search.tsx`; shot `global-search-1360-dark.png` | Roo/OpenCode scope search to a session and step matches in place | **P** | Size the panel to its results (with a max), and make the hit count a control: pressing it opens the session with find already primed on that query, which the app can already do. |

### 3.6 What is already at the bar

Recorded so that a later change does not quietly cost it.

| Surface | Evidence |
| --- | --- |
| Settings → MCP servers and its inspector — plain language end to end, five verbs, capability chips, Tools/Run/Resources/Prompts | `mcp-inspector.png`, `mcp-tools.png`, `mcp-run.png` |
| Reduced motion — **zero** residual animations or transitions under `prefers-reduced-motion: reduce` | `out-mcp.log`, empty `MOVING UNDER REDUCED MOTION` block |
| Both themes, both widths — **no horizontal page overflow, no unintended clipping, nothing below 12px except the uppercase eyebrow** in all four matrix cases | `out-long.log` GEOM lines ×4 |
| The empty states — session landing with three real suggestions, the fleet's "No session is open" that says *whose* tree it would show, the Agents page's three numbered steps, Beam's three suggestion chips | `empty-landing.png`, `agents-page.png`, `fleet-expanded.png` |
| Help and shortcuts explains *why* the composer has no footer row, and the three-key composer contract is written down and matches the code | `settings-help-and-shortcuts.png`, `KeyboardTab.tsx:50` |
| Global search — project label, source label ("Your message"), highlighted excerpt, an explicit "Searched the last 30 days" with an explicit older range | `global-search-1360-dark.png` |
| Native notification copy — three kinds, each a sentence with what to do next | `desktop/src/notifications.ts:47–51` |
| The phone at 390px reads better than most desktop agents do at any width | `long-390-dark.png` |

---

## 4. Proposed tasks

PLAN.md row format. **`PLAN.md` is not edited by this audit** — these are
proposals for whoever owns the next re-plan, and each structural addition
needs its own `D-<n>`.

| ID | Title | Acceptance |
| --- | --- | --- |
| M17-T1 | The conversation owns the window | At 1360×900 the transcript's rendered message width is ≥ 560px in the default layout, at 1280 ≥ 520px, and no default layout makes the desktop reading column narrower than the 390px phone's. Fleet and monitor default closed below the width at which the thread would fall under `--measure-prose`; both remain one key and one top-bar control away, and a person's saved preference still wins. Harness evidence at 1280/1360/1680/1920 × both themes. |
| M17-T2 | One column for the fleet and the monitor | Below the width where two right columns fit, the fleet and the monitor share one column through a segmented control, morphing rather than unmounting (`--motion-morph`, identity and scroll survive). Re-install `elements-canvas-split` for the divider rather than hand-rolling one; 44px grab on a coarse pointer. Both sheets below 1280 unchanged. |
| M17-T3 | A child's question is answered where it is shown | `lasercode/agent-event` carries the child's question as typed `AgentRunQuestion` data, not prose. `AgentEventCard` draws it with `DialogBody`, so it renders as Approval card / Permission grant / Elicitation form like every other question; answering sends `send_agent_message` mode `answer` from the UI. Enter never grants. Nothing a person reads contains `send_agent_message`, `sessionId`, `runId` or `inspect_agent`. Interaction test for pointer and keyboard, plus a test that the parent model's own message is unchanged. |
| M17-T4 | A failed run says what went wrong, for a person | The worker classifies a terminal failure into `{ kind, title, detail, action }` on `AgentRun`; the raw provider string stays in the Logs screen and the API inspector only. The event card and the fleet row draw the classified form through the adopted Error state / Stopped run elements, with one corrective action. Covers provider 4xx/5xx, auth, quota, network and worker loss; a classification it does not recognise says so without pasting JSON. |
| M17-T5 | The fleet row is a row, not a record | A `needs_input` row's second line is the question's title only; arguments, choices and the tool that raised it live in the expanded detail. Truncation is by ellipsis with the full text in the tooltip and the accessible name. Test at 320px column width in both themes. |
| M17-T6 | Snapshot and restore (protocol) | `project/snapshot` and `project/restore` in `@lasercode/protocol` with a schema round-trip sample and router coverage; the worker takes a snapshot before each write tool and can restore files, the conversation (through the existing `pi/session/navigate`), or both. Restore options that would do nothing are hidden, not disabled (R4). Bounded storage with a stated cap and a way to turn it off. |
| M17-T7 | Review the changes before they are yours | Re-install `elements-reviewable-diff` in the same change as M17-T6's apply/restore method, per its inventory row. A session's changed files are reviewable as a set, with per-file and per-hunk restore, from the monitor's existing "Files changed" section. Works at both widths and in both themes; the diff scrolls in its own container and the page never scrolls sideways. |
| M17-T8 | Commit and push without a terminal | The Create-a-pull-request dialog commits and pushes through the host behind one explicit confirmation that names the branch, the remote and the commit, and reports what happened. The copyable commands remain as the secondary path, with the reason where the primary control would have been on a remote/phone view. No shell interpolation of user text. |
| M17-T9 | Permissions a person can set once | A Permissions section in Settings → General with Laser's own categories (read, write, run commands, MCP tools, network) and, per category, *ask · allow in this project · never*, persisted per project and per machine as the settings taxonomy already distinguishes. Nothing in the UI names a Pi setting. A tool approval whose worker offers wider scopes shows them through the existing `permission-grant` options; Enter still never grants. |
| M17-T10 | Always allow this command | The tool-approval footer offers a scope for the command's own prefix where the worker can honour it, and the granted rule is visible and removable from M17-T9's section. A granted rule is never silent: the row that used it says so. |
| M17-T11 | Plan mode | `session/set_mode` implemented for `build` and `plan`; in `plan` the session has read and search tools and no write or command execution, and the refusal is a person-facing sentence. A segmented control in the composer toolbar and the mode in the status line's words. Switching mid-session keeps the conversation. Both widths, both themes, keyboard path. |
| M17-T12 | The engine's keymap leaves the Help tab | Settings → Help and shortcuts contains only keys Laser answers to. Anything from the engine's own keybindings file that must stay reachable moves to the permanent Advanced tab and is described as what it is. No Laser surface names `tui.*` or the agent's keybindings path outside Advanced. |
| M17-T13 | Every key is findable | `\` (fleet) appears in Settings → Help and shortcuts and in the command palette; `]` appears on exactly one palette row with its narrow-window behaviour as the row's detail; `Esc` stops the current turn when the thread is focused and nothing is open above it, through the driver's existing stop sequence; `Ctrl/Cmd+↑/↓` moves between sessions. All four are in Help, the palette and a keyboard interaction test. |
| M17-T14 | Projects you can tell apart | A project's mark is derived from the distinguishing part of its path, and a person can choose its mark and hue from the project's Actions menu, persisted with the machine's appearance preferences. Ten similarly-named projects produce ten distinguishable rings. Hues come from tokens; no literal colour in a component. |
| M17-T15 | A sidebar that scales past one project | With more than one project carrying history, groups other than the current project start collapsed; the open session, live work, attention anywhere in a branch and search matches stay reachable regardless. Measured: reaching the tenth project's newest session takes no more scrolling than reaching the first project's. |
| M17-T16 | The monitor stops repeating itself | The "totals cover the messages loaded so far" qualification appears once, attached to the number it qualifies; a zero-cost session shows one line, not five; an unmeasured value says "not measured" as the Cost meter row requires. |
| M17-T17 | Logs open on what you can act on | The Logs screen opens with `debug` off, and the count of what is hidden is visible and one press from being shown. Separately: `module:subagents late-callback-dropped` is either demoted below `debug` or fixed, with a note saying which and why. |
| M17-T18 | One noun for an agent | "Agents" is the word on every surface a person reads; "fleet" names only the column of work. "Harness", "Sub Sessions" and "Subagents" leave the person-facing copy; the Agents page's limits row is written as a sentence. `pnpm verify` includes a copy check for the retired words. |
| M17-T19 | Rows shrink their arguments, never their verbs | The activity row's truncation order is duration, then argument, then summary; the verb never truncates. A row that cannot fit its verb is a test failure, at 280px and 320px, in both themes and both directions. |
| M17-T20 | The map never covers the conversation | The conversation-map rail and its preview card are gated on the thread's available width, not on a viewport breakpoint, and the preview never overlaps transcript text at any width. Verified at 1280, 1360 and 1920 with the fleet and monitor both open and both closed. |

---

## 5. Appendix — where the evidence lives

| Artifact | Path |
| --- | --- |
| Cloned field repositories (read-only, shallow) | `/tmp/ux-audit/repos/` |
| Harness drive scripts | `/tmp/ux-audit/scripts/{tour-empty,tour-tools,tour-agents,matrix-long,tour-surfaces,tour-mcp,tour-flow}.mjs` |
| Run logs (text dumps, geometry, tab order, timings) | `/tmp/ux-audit/out-{empty,tools,agents,long,surfaces,mcp,flow}.log` |
| Screenshots and `evidence.json` | `/tmp/ux-audit/shots/{empty,tools,agents,long,surfaces,mcp,flow}/run-*/` |
| Matrix contact sheet (1360/390 × dark/light) | `/tmp/ux-audit/shots/long/run-*/contact-sheet.png` |

These are outside the checkout on purpose (the harness refuses
checkout-contained artifact directories) and are not committed: they carry
absolute paths from the harness's disposable home. Re-run any of them with the
command in §0; content is deterministic, only ids and timestamps are not.
