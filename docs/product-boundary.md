# Product boundary

Laser is the product. Pi is an exact-pinned internal coding engine. A person
uses Laser settings, Laser features, Laser commands and Laser panels; engine
package names, paths and terminal-only controls do not cross the normal UI.
Project settings live at `<project>/.laser/settings.json`. Laser never reads or
writes `<project>/.pi`, adopts Pi trust state, exposes Pi passthrough, or offers
package installation.

## Ownership

| Layer | Owns |
| --- | --- |
| Pi and Pi-native packages | agent loop, models, tools, session persistence and feature logic |
| `packages/pi-goal` | exact upstream goal pin, loader entrypoint and stable state reader |
| `packages/pi-extension` | in-process translation from supported engine capabilities to the Laser protocol |
| Worker | the only Pi imports; feature-to-engine loading and `SessionDriver` mapping |
| Protocol, host and UI | engine-neutral settings, feature policy, session state and presentation |

New backend behavior starts as a reusable Pi-native package, whether local or
exact-pinned upstream. It must work without the Laser UI. Laser then adds a
companion adapter and owns what people see. Presentation logic never moves into
the engine package, and engine types never move above the worker.

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
- Subagents and Goals are bundled and exact-pinned; the user never installs a
  package to obtain them.
- The worker disables automatic extension, skill, prompt, theme and package
  discovery. Only reviewed built-ins are loaded by exact path.
- The host rejects legacy package-management requests with a Features-directed
  product error.
- Disabling Subagents retires its panels without deleting runs or transcripts.
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
engine owns continuation, token/time accounting, pause, block, wait, completion,
compaction and loop-safety semantics. Laser owns the persistent row below the
run tabs, its progress evidence and its pause, resume, edit and clear controls.
