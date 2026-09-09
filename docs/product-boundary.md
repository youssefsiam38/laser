# Product boundary

Laser is the product. Pi is an exact-pinned internal coding engine. A person
uses Laser settings, Laser features, Laser commands and Laser surfaces; engine
package names, paths and terminal-only controls do not cross the normal UI.
Project settings live at `<project>/.laser/settings.json`. Laser never reads or
writes `<project>/.pi`, adopts Pi trust state, exposes Pi passthrough, or offers
package installation.

## Ownership

| Layer | Owns |
| --- | --- |
| Pi and Pi-native packages | agent loop, models, tools, session persistence and feature logic |
| `packages/pi-goal` | exact upstream goal pin, loader entrypoint and stable state reader |
| `packages/pi-extension` | in-process translation from supported engine capabilities to the Laser protocol; the model-facing agent harness tools (`start_agent` and siblings, `complete_agent_run`), the child's role block and parent event delivery, from the worker's bridge; long commands as background tasks |
| Worker | the only Pi imports; feature-to-engine loading and `SessionDriver` mapping; agent execution — per-agent session configuration, child sessions, `.worktrees/` isolation when the parent asks for it, parent events, the Beam skill, Namer qualification |
| Protocol, host and UI | engine-neutral settings, feature policy, session state and presentation; agent definitions and policy (`agents.json`), the Agents page, the run registry (`agent-runs.json`), sub-sessions in the sidebar, the live map, and the built-in agents' product integrations (Beam's spark and bubble, the Chat tab, Namer's names and labels) |

New backend behavior starts as a reusable Pi-native package, whether local or
exact-pinned upstream. It must work without the Laser UI. Laser then adds a
companion adapter and owns what people see. Presentation logic never moves into
the engine package, and engine types never move above the worker. The agent
harness is the deliberate exception (D-140, [`agents.md`](agents.md)): its
semantics — one `start_agent` tool over a compact catalog, worktree isolation
by default with the parent able to waive it (D-156), background-only children
that are persistent sub-sessions — are
Laser's own, implemented in the worker and the companion extension against
documented engine APIs; the definitions, runs and every surface are owned
above the worker.

## Settings taxonomy

The classification is exhaustive for the pinned engine schema. Only General
and Advanced entries are returned as settings fields.

| Disposition | Keys |
| --- | --- |
| General | `defaultProvider`, `defaultModel`, `defaultThinkingLevel`, `modelThinkingLevels`, `steeringMode`, `followUpMode`, `compaction`, `hideThinkingBlock`, `images`, `enabledModels` |
| Advanced | `transport`, `retry`, `showCacheMissNotices`, `shellPath`, `shellCommandPrefix`, `thinkingBudgets`, `warnings`, `httpProxy`, `httpIdleTimeoutMs`, `websocketConnectTimeoutMs` |
| Internally managed | `lastChangelogVersion`, `theme`, `defaultProjectTrust`, `npmCommand`, `enableInstallTelemetry`, `enableAnalytics`, `trackingId`, `packages`, `extensions`, `skills`, `prompts`, `themes`, `enableSkillCommands`, `defaultTools`, `sessionDir` |
| Unsupported in Laser | `branchSummary`, `externalEditor`, `quietStartup`, `collapseChangelog`, `terminal`, `doubleEscapeAction`, `treeFilterMode`, `editorPaddingX`, `outputPad`, `autocompleteMaxVisible`, `showHardwareCursor`, `markdown`, `tuiMode`, `fullscreenExitOutput`, `fullscreenScrollbar`, `fullscreenCopyOnSelect` |

Advanced is a permanent destination for specialist product controls. “Full
configuration” only expands secondary fields inside General or Advanced; it
does not reveal internally managed or unsupported engine settings.

## Features

- A feature manifest has a stable id, product name, description, default,
  supported scopes, dependencies, capabilities, restart policy and health.
- Feature choices live in Laser preferences at global or project scope.
- A project override can be cleared to follow the global choice again.
- Goals is bundled and exact-pinned. Subagents is Laser's own harness
  (D-140, D-156): the worker runs child agents as sub-sessions, in their own
  worktree unless the parent asked otherwise, and
  the companion extension registers the tools. The user never installs a
  package to obtain either.
- The worker disables automatic extension, skill, prompt, theme and package
  discovery. Only reviewed built-ins are loaded by exact path.
- The host rejects legacy package-management requests with a Features-directed
  product error.
- Disabling Subagents withholds the harness tools, background tasks and the
  live map from new sessions without deleting runs, worktrees or transcripts;
  the Agents page and its definitions stay.
- Web search is bundled and opt-in. Its independent provider selection and
  shared-connection consent live under Providers and models → Web search.
  See [`web-search.md`](web-search.md) for credential and execution boundaries.

Dictation is a core capability, not a feature toggle. Laser bundles the exact
reviewed transcription core and shows provider readiness in Settings → Providers
and models. It requires an OpenAI platform API key; ChatGPT account sign-in alone
cannot authorize the transcription endpoint. The microphone action runs this
preflight before asking for access or recording audio. Its interaction contract
matches the terminal extension: natural pauses cut independent phrases, phrase
requests may run concurrently but land in spoken order, and each completed phrase
is inserted at the person's current caret without locking keyboard edits. Sending
while a final phrase is in flight drains that phrase before the message leaves.

## Goals

The reusable behavior is `@narumitw/pi-goal@0.54.4`, loaded through Pi's own
extension loader. Laser does not fork its goal loop. The local integration
package reads the canonical `goal-state` session entries and maps them to
`SessionGoal`; the public protocol exposes `session/goal/get` and
`session/goal/action` without engine vocabulary.

One goal belongs to one session and follows the active session branch. The
engine owns continuation, pause, block, wait, completion, compaction and
loop-safety semantics. A small exact-version pnpm patch removes goal budgets and
disables goal accounting (session telemetry owns usage), and preserves literal
objective punctuation/whitespace. It does not replace the loop or alter the
terminating completion tool. Laser owns the persistent row below the run tabs,
pause/resume/edit/clear controls and the durable completion disclosure in chat.

The engine's three tools (`goal_complete`, `goal_blocked`, `goal_wait`) reach a
request only while a goal is in play (D-146). They are registered at load, so
without this they sit in every request of every session and their descriptions
have to argue that their own presence does not mean a goal exists. The engine
refuses to start or resume a goal whose tools are not already active, and its
command dispatches before any extension hook can see it, so the worker switches
them on when it is handed `/goal` or a `session/goal/action`; the companion
takes them away again on the first turn of a session that has no goal.
`packages/pi-goal` owns the tool names and `test/policy.test.ts` pins them to
the installed engine, so a version that renames one fails there rather than
quietly leaving a tool attached everywhere.
