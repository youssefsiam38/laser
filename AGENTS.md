# AGENTS.md — how to work in this repo

laser is a web-tech desktop app and remote-control relay layered on top of the
Pi coding agent (`@earendil-works/pi-coding-agent`). It visualizes Pi sessions,
agents and subagents (Laser's own harness, `docs/agents.md`), settings, and low-level logs, and exposes the same UI
to phones through an end-to-end encrypted relay. It builds on the community's
packages; it does not replace them.

## The bar: the Apple of coding agents

laser is not a dashboard over Pi. It is meant to be the experience that
makes developers choose an agent because of how it feels to work with, the
way people choose hardware because of how it feels in the hand. Pi owns the
logic; we own the experience, and the experience is the product.

That sets the bar for every screen, every command and every transition:

- **Nothing ships as a placeholder.** Empty states, loading states, error
  states and the first-run moment are designed with the same care as the
  main path. If a state exists, it was drawn on purpose.
- **Motion is a material, not a garnish.** Things morph, they do not pop.
  The same element grows and shrinks; identity, position and scroll survive
  every transition. Sixty frames, no layout shift, and every motion has a
  `prefers-reduced-motion` fallback that loses nothing but the movement.
- **No static visual values, ever.** Every colour, font, size, radius, shadow,
  spacing step and duration comes from a token that the person can change in
  Settings. A hex literal, an `oklch()`, or a raw `px` font size in a
  component is a bug; the only literals live in the primitive scales and the
  preset definitions. See [`docs/ux-theme.md`](docs/ux-theme.md).
- **The person never needs a terminal.** Extensions, models, providers,
  projects and themes are all installed and configured from the UI. The app
  bundles its own runtime and agent, and the visible copy never requires
  knowing which agent runs underneath.
- **Legibility is a floor, not a goal.** No data below 12px, no overflow, no
  clipped text, no horizontal page scroll, ever. A component that cannot fit
  its content shows less content, never smaller text.
- **The details are the design.** Optical alignment of icons to text, a real
  type scale, tabular numerals wherever digits line up, spacing on a grid,
  hover and focus and pressed states on everything interactive, keyboard
  paths for everything the mouse can do.
- **Errors are written for a person.** What went wrong, and what to do next.
  No stack traces in the UI, no apologies, no vagueness.
- **Both themes, both pointers, both widths.** Dark and light with equal
  care; mouse and touch; a phone and a wide desktop. Not one first and the
  rest adapted.

Three documents are the constitution for this, and they are binding on
every UI change: [`packages/ui/DESIGN.md`](packages/ui/DESIGN.md) for the
visual system, [`docs/ux-fleet.md`](docs/ux-fleet.md) for where work in flight
and questions to a person render, and [`docs/ux-agent-work.md`](docs/ux-agent-work.md)
for the model behind agent work, [`docs/ux-elements.md`](docs/ux-elements.md) for which
assistant-ui element owns each surface, and [`docs/ux-theme.md`](docs/ux-theme.md)
for the token system. A UI change that does not fit them is either a bug or a
decision recorded in `STATUS_DETAILED.md` — never a quiet exception.

Before any UI task is marked done, run it in the browser at a desktop width
and a phone width, in both themes, and look at it the way a demanding
designer would. "It builds" is not the bar. "I would show this to someone I
respect" is.

Activity disclosures require interaction tests, not just summary/string tests.
Reasoning is an independently collapsible action, not a static heading inside
the aggregate. Share the activity row tokens across reasoning and tools; never
invent a token name without a theme mapping (`surface-1` is not a token).
Manual toggles override default-open preferences, including waiting tools;
approval footers remain outside the fold. Verify pointer and keyboard toggles
after viewport restoration settles, and check that collapsed bodies really hide.

**Use the `/assistant-ui` skill for every piece of UI work, everywhere.** It
is rich and current, and it covers far more than the thread: elements,
primitives, the runtime and `aui` client, tools and approvals, generative
UI, streaming, thread lists, markdown, observability, mobile. Invoke it with
the `Skill` tool (`assistant-ui`) before touching any component, and read the
relevant sub-skill under `.agents/skills/` in this repo (project-local install via `npx skills add assistant-ui/skills`, tracked by `skills-lock.json`) — `elements` before
building a surface, `primitives` before composing one, `runtime` before
touching the adapter, `tools` before any approval or tool UI, `markdown`
before any renderer, `thread-list` before the sessions panel. Prefer an
assistant-ui element or primitive over hand-rolling; style it to `DESIGN.md`
rather than rebuilding it. Its guidance is secondary only to the installed
`.d.ts` when the two disagree.

**Every element in the catalog is already claimed.** Before writing any
component, check [`docs/ux-elements.md`](docs/ux-elements.md): it maps all
~120 assistant-ui elements onto a laser surface, or states why one does not
apply. If the thing you are about to build has a row there, install that
element (`npx assistant-ui@latest add <name>`) and restyle it. Editing the
copied source is expected; starting from an empty file is not. Standalone
elements ship with demo props — strip them and feed the component from the
real payload the surface already carries. If you build something the inventory claims, a reviewer will
send it back.

This file is the contract for every agent (human or model) working here. Read it
fully before touching anything. The three planning files it governs are:

| File | Role | Size discipline |
| --- | --- | --- |
| `PLAN.md` | What we are building, in what order, and why. Milestones and tasks with stable IDs. Changes rarely. | Edit only to add/split/drop tasks or record a re-plan. |
| `STATUS.md` | The one-screen answer to "where are we right now". | Must fit on one screen. Regenerated at the end of every work session. |
| `STATUS_DETAILED.md` | Per-task ledger: state, evidence, notes, handoffs, decisions log, open questions. | Append and update rows; never delete history. |

Planning is **dependency-ordered, never time-ordered**. There are no dates,
estimates, sprints, or deadlines anywhere in these files. A task is ready when its
dependencies are `done`, and done when its "done when" is met with evidence.

---

## 1. Start-of-session protocol (do this every time, in this order)

1. Read this file.
2. Read `STATUS.md` in full. It tells you the current milestone, blockers, and
   the next tasks.
3. Find your task in `STATUS_DETAILED.md`. Query by ID:
   ```bash
   grep -n "M1-T3" STATUS_DETAILED.md
   ```
   Read its row, its notes block, and any handoff note that names it.
4. Read the matching milestone section in `PLAN.md`:
   ```bash
   grep -n "^## M1" PLAN.md
   ```
5. Read `docs/architecture.md` if your task touches package boundaries, and
   `docs/agents.md` if it touches agents, `docs/agents-leap/references/` if it
   touches the harness contract or what was learned from pi-subagents, and
   `docs/security.md` if it touches the relay or mobile.
6. Claim the task (section 3) **before** writing code.

If `STATUS.md` says it was last updated by a session that never wrote a
finish or handoff note, assume that session died mid-task: read the task's notes,
check `git status` and `git log`, and write a handoff note describing what you
found before continuing.

---

## 2. Query recipes

```bash
# Where are we?
cat STATUS.md

# All tasks currently in progress or blocked
grep -nE "\| (in-progress|blocked) \|" STATUS_DETAILED.md

# Everything about one task (row + notes + handoffs + decisions that cite it)
grep -n "M3-T2" STATUS_DETAILED.md PLAN.md

# Tasks that are ready (deps done) — read the milestone's dependency line in PLAN.md,
# then check each dependency's state:
grep -nE "^\| M0-T[0-9]+ " STATUS_DETAILED.md

# Decisions log (newest at the bottom)
grep -n "^### D-" STATUS_DETAILED.md

# Open questions
sed -n '/^## Open questions/,/^## /p' STATUS_DETAILED.md
```

Task IDs are `M<milestone>-T<n>` and are permanent. Decision IDs are `D-<n>`.
Handoff IDs are `H-<n>`. Never renumber.

---

## 3. Write rules

### 3.1 States

`todo` → `in-progress` → `done`, with `blocked` and `dropped` as side exits.

- `in-progress`: exactly one agent owns it. Put your session label in the Owner
  column (for example `claude-2026-09-05-a`, or a human's name).
- `blocked`: the Notes block must name what unblocks it (a task ID, a decision, an
  external answer).
- `done`: the Evidence column must hold a commit hash, a test command that passes,
  or a file path that exists. "Done" without evidence is not done.
- `dropped`: Notes must cite the decision `D-<n>` that dropped it.

### 3.2 The three moments you must write

1. **Claim** — before the first code change: set the row to `in-progress`, set Owner,
   add a one-line note `claimed: <what you intend to do first>`.
2. **Checkpoint** — whenever you finish a meaningful sub-step, hit a surprise, or
   are about to run something long: add a dated line to the task's Notes block.
   Short is fine. The goal is that a crashed session loses nothing important.
3. **Finish or hand off** — when the task is `done`, fill Evidence and flip the state.
   When you stop for any other reason, write a handoff (section 3.4) and leave the
   state as `in-progress` or `blocked`.

Then, **every session, before you stop**, regenerate `STATUS.md` (section 3.5).
A session that changed code but left `STATUS.md` stale has failed its task.

### 3.3 Task row format in `STATUS_DETAILED.md`

```
| M1-T3 | Answer extension dialogs from the UI | in-progress | claude-2026-09-05-a | — | see notes |
```

Columns: ID, Task, State, Owner, Evidence, Notes pointer. The Notes block for a
task lives directly under its milestone table:

```
#### M1-T3 notes
- 2026-09-05 claimed: wire ui-bridge select() to a dialog message
- 2026-09-05 select/confirm/input work; editor needs a multi-line component
- 2026-09-06 done, evidence: `pnpm -F @lasercode/worker test -- ui-bridge`
```

Dates are ISO `YYYY-MM-DD`. They are for reading history, not for planning.

### 3.4 Handoff format

Append to the `## Handoffs` section:

```
### H-7 · M3-T2 · 2026-09-06 · claude-2026-09-06-b
State of the work: parser done, watcher half-done in packages/host/src/subagents/watch.ts.
Uncommitted: yes (git stash list: none; working tree has 3 modified files).
What is broken: fs.watch fires twice on Linux; dedupe by (path, mtime) not yet written.
Next concrete step: implement dedupe, then run `pnpm -F @lasercode/host test`.
Do not: rewrite the parser, it matches pi-subagents 0.65 status.json exactly.
```

### 3.5 Regenerating `STATUS.md`

`STATUS.md` is derived from `STATUS_DETAILED.md`. Rewrite it completely (do not
patch) using the template already in the file:

- **Last updated**: ISO timestamp, your session label, the HEAD commit hash.
- **Current focus**: the milestone with in-progress tasks (one line of intent).
- **Milestone table**: one row per milestone, state = `todo` if no task started,
  `in-progress` if any task is, `done` if all tasks done or dropped.
- **Blockers**: every `blocked` task, one line each, with what unblocks it.
- **Next up**: the three highest-priority `todo` tasks whose dependencies are done.
- **Recently done**: the last five `done` tasks with evidence.

Keep it to one screen. Detail belongs in `STATUS_DETAILED.md`.

### 3.6 Decisions and open questions

- A decision is any choice that a future agent could reasonably re-litigate.
  Append it as `### D-<n> · <date> · <title>` with `Decision`, `Why`, `Consequences`,
  `Supersedes` (optional). Decisions are append-only. To reverse one, add a new
  decision that says `Supersedes: D-<old>`.
- An open question is a decision that only the user can make. Add it under
  `## Open questions` with the task IDs it blocks. Do not guess; if a task needs
  the answer, mark it `blocked`.

### 3.7 Editing `PLAN.md`

Allowed: adding a task (next free `T<n>` in that milestone), splitting a task
(keep the old ID for the first half), dropping a task (state `dropped` in status,
citing a decision), adding a milestone at the end. Not allowed: reordering IDs,
adding dates or estimates, deleting done-when criteria. Any structural change to
`PLAN.md` gets a `D-<n>` entry.

---

## 4. Architecture invariants (violations are bugs, not style)

1. **Nothing above the worker imports Pi.** Only `packages/worker` and
   `packages/pi-extension` may import `@earendil-works/*`.
   Everything else speaks `@lasercode/protocol`. The session catalog watcher
   lives in the host and parses JSON only, so terminal-started sessions stay
   visible without a worker; agent runs reach the host as `agents/run`
   notifications from the worker and live in its run registry
   (`<state>/agent-runs.json`), never read from engine files.
2. **The protocol is ACP-shaped.** `session/new`, `session/load`, `session/prompt`,
   `session/cancel`, `session/request_permission`, plus `pi/*` namespaced extras.
   New capabilities are added to `packages/protocol` first, then implemented.
3. **Two drivers behind one interface.** `SessionDriver` in
   `packages/worker/src/driver.ts` has `StableSdkDriver` (real) and `ChordDriver`
   (stub proving the seam). Any change to the interface must keep both compiling
   and the seam test green.
4. **Pi is pinned inside the worker.** `packages/worker/package.json` depends on an
   exact `@earendil-works/pi-coding-agent` version. The user's global Pi install is
   never used as the runtime. Bumping the pin is a task with its own row.
5. **One worker process per project directory.** The host never runs two projects
   in one Node process. A worktree of a project runs in that project's worker:
   a child agent's checkout under `<project>/.worktrees/` is part of its
   project, never a second project (D-140).
6. **Extension UI: portable surface only.** `select`, `confirm`, `input`, `editor`,
   `notify`, `setStatus`, `setWidget` (string lines), `setTitle`, `setEditorText`.
   Anything else cancels safely (never hangs). `custom()` is not emulated.
6a. **Pi owns the logic, laser owns the experience.** There is no UI bus and
   no declarative panel contract; an extension never declares a surface, a kind
   or an intent, and never ships presentation (D-147). There are exactly three
   places anything an extension does can appear, and laser owns all three:
   the **tool call** in the transcript that did it, the **fleet** for work that
   outlives a turn (agent runs and background commands, `docs/ux-fleet.md`), and
   **inline in the transcript** for a question the person has to answer, beside
   the tool approvals already there. Anything that fits none of them is a
   decision recorded in `STATUS_DETAILED.md`, not a bespoke view for one
   package. Agent work has a domain model of its own in
   [`docs/ux-agent-work.md`](docs/ux-agent-work.md), read from typed sources —
   the run registry and the background-task surface — never from declared UI.
6b. **Laser is the product; Pi is an internal engine.** No normal Laser surface
   mirrors Pi's settings, package manager, extension vocabulary or branding.
   Laser defines its own settings schema and curated feature manifests. Low-level
   engine values are managed internally or omitted; specialist controls live in
   a permanent Advanced tab. People enable Features, never install packages.
   Logic that needs Pi semantics belongs in a reusable Pi-native workspace
   package (or an exact-pinned upstream package) that uses documented Pi APIs and
   remains useful to native Pi users. `packages/pi-extension` is the adapter: it
   translates that logic into engine-neutral `@lasercode/protocol` data. The UI
   owns placement, language and presentation. Nothing in UI, host or protocol
   may import Pi, a Pi extension, or a community package. Dependencies stay exact
   pinned. Project configuration belongs under `<project>/.laser`; the worker
   disables Pi's automatic `<project>/.pi` discovery and passes only validated
   `.laser` values as in-memory engine overrides. `.pi` is neither a migration
   source nor supported Laser configuration. Package installation and Pi
   passthrough are not product capabilities.
7. **The relay is a byte forwarder.** `packages/relay` links no crypto library and
   never parses payloads beyond the channel id.
8. **Never two writers on one Pi session file.**
9. **Phone output is untrusted data.** Everything rendered from agent output is
   escaped; no raw HTML from the transcript.
10. **An update replaces the running generation, not the protocol.** A native
    package upgrade gracefully reloads only the daemon launched from that exact
    native install after the new files land. Desktop startup also replaces a
    recorded daemon whose CLI version differs before opening the UI. Do not fix
    UI/host version skew by teaching new features old request schemas: that
    hides a broken process lifecycle and makes every future protocol permanent.

Read `docs/architecture.md` for the layer diagram and the driver seam.

### Live activity regression guards

- assistant-ui treats a tool's `result` as terminal, even when the message is
  still running. Keep partial output in its UI-only `artifact` channel and
  reserve `result` for `tool_execution_end`; never trade live status for output.
- The default `GroupedParts` indicator also appears after tool calls. Our
  transcript uses `indicator="empty"`, with neutral waiting copy; actual
  reasoning and running tools own their row beam. Test with partial output,
  not only a resultless tool, and verify both aggregate and child status.
- Batch disclosure changes anchor visible content through the animation.
  Start the animation window after React commits, not at the menu click: a
  large history can take longer to render than the animation itself.

---

## 5. Commands

```bash
pnpm install                      # workspace install
pnpm -r build                     # build all packages
pnpm -r test                      # test all packages
pnpm -F @lasercode/worker test      # one package
pnpm -F @lasercode/worker dev       # run one package in watch mode
```

Conventions: TypeScript strict, ESM everywhere, relative imports use `.js`
specifiers (Pi loads extensions this way and we match it), Node 24, pnpm.

## 5a. Release and packaging failure rules

These rules exist because both failures below escaped a local green check and
reached a pushed release candidate. Treat them as release blockers, not advice.

### A tag is not a downloadable release

Never publish a release page while architecture jobs are running. Push the tag;
optional early notes must remain a draft. Only `scripts/release/publish.sh`
publishes after complete x64/ARM64 installers, checksums and offline provenance
are uploaded and their remote sizes and SHA-256 digests match. Upload failures
remain drafts; published assets must not be overwritten. A no-monitor request
means report "tag pushed; release building", not "published". Record download
readiness only after checking the actual assets. Run the publication regression
tests with `node --test scripts/release/test/*.test.mjs`.

### New files and the identity check

**Problem:** `scripts/identity/check.mjs` intentionally scans tracked files. A
new untracked source file can spell `laser`, an app id, a directory name or a
wire namespace literally and still pass locally; the same check fails in CI
after the commit makes that file tracked. This has happened more than once.

**Fix:** import `PRODUCT_*` from `@lasercode/protocol` in TypeScript, import
`scripts/identity/identity.mjs` in Node scripts, or add a generated template for
shell/YAML. Never silence the scanner for a product-bearing source file.

**Prevention:** before the final identity/build/test gate, stage every intended
new file, confirm no intended file remains under `git status` as `??`, then run
`pnpm identity:check` and `pnpm verify`. A green check run before staging new
files is not release evidence. After pushing, wait for the clean CI run to pass
before creating or moving a release tag.

An alternate `GIT_INDEX_FILE` may isolate release staging from unrelated work,
but never export it into `pnpm verify` or tests: Git fixture repositories inherit
it and read/write the wrong index. Scope it to individual staging/commit commands.

### A running service is not the installed version

**Problem:** replacing package files left a 0.2.0 host running beneath 0.2.4
files. New UI quota refresh reached its old in-memory protocol and returned
`unknown method pi/account-usage/refresh`. Reading package.json on disk cannot
prove the running process has the new code.

**Prevention:** check `host.json`'s recorded `cliVersion` before desktop adoption.
Never silently attach different versions or kill a shared service to upgrade it.
Explain full quit (including tray) after finishing work. Test new public methods
through a real host and built worker, not only worker dispatch. Quota credential
failures must leave loading and remain retryable without leaking auth details.

**Native update regression:** this machine also retained an Electron 0.2.5 main
around a 0.2.9 daemon. Inspect the renderer's `--desktop-env` version as well as
the host record; installed manifests alone prove neither process. Native install
hooks must never signal/restart the host. Publish the atomic completion marker,
let the person choose a full app/host restart, and block spawning or adopting a
different generation. Frontends must handshake their compiled release before
hydration/resume; mismatches block requests and offer a user-chosen view refresh.
Remote refresh must not stop/cancel any host work. Do not promise uninterrupted
agents during a full host restart. Preserve drafts before frontend reload.

### Native reminders must follow session acknowledgement

Retain native notification handles by session and withdraw them when that session
is actually viewed. A host seen acknowledgement is distinct from attention:
viewing an unanswered approval must dismiss its OS reminder, not answer it.
Do not mark hidden, unfocused or Settings-covered transcripts read. Withdraw
before foreground/throttle guards; preserve anti-spam history. Test late native
delivery and replaced-handle close callbacks. On Linux, prove `CloseNotification`
and the server's application-dismissed signal; banner timeout alone is not proof
of removal from notification history or the dock's count.
Reconcile durable `seenAt` after reconnect, and withdraw owned handles on orderly
quit/relaunch. GNOME Dock derives counts from notification-centre objects;
`app.setBadgeCount(0)` is not a substitute. Never guess lost notification IDs or
change global dock preferences. Reminders orphaned by pre-fix processes or forced
termination may need one manual dismissal; the standard API cannot enumerate
their IDs. Test low-urgency finished notifications after their banner times out.

### Subscription allowance: prove the route, not only the parser

**Problem:** the first usage URL returned a 403 HTML security challenge for a
valid credential. The code treated it as an authentication failure and never
reached the working URL; reconnecting could not help. Mocks accepting any URL
ending in `/usage` hid the defect and repeated an incorrect duration field.

**Fix/prevention:** the companion extension owns one verified usage route and
keeps Pi responsible for OAuth. Assert the exact endpoint, test source-shaped
multi-bucket/null-window responses and `windowDurationMins`, and distinguish
security challenges, 401, permissions, throttling and network failures. Preserve
the last good snapshot on refresh failure; never sum separate allowance buckets.
Before claiming integration success, perform an authorized read-only live probe
with current credentials, reporting only status/shape—not tokens, account IDs
or raw bodies. A working undocumented endpoint is not a public API guarantee.

### Executable dependency source in packaged builds

**Problem:** a dependency's `.ts` files are not necessarily development files.
Pi extensions may export TypeScript directly and Pi's resource loader transpiles
it at runtime. A broad electron-builder exclusion removed
`pi-subagents/index.ts` and its `src/**/*.ts`; Electron launched and Pi's
compiled core imported, but every new/opened session failed, leaving the new
chat model picker unavailable. `asarUnpack` cannot restore a file excluded by
`files`.

**Fix:** preserve executable dependency source in `node_modules`. Read the
package's `exports`, `files` and Pi manifest before excluding an extension or
file type. Never classify code as disposable solely from its extension.

**Prevention:** every new or bumped curated feature must be tested from
`packages/desktop/out/*-unpacked` with the bundled Node and an empty `PATH`.
The clean-machine gate must open a real session with all default features and
exercise a capability reached only after session creation (currently the model
list). Checking that files exist, that `require.resolve` succeeds, or that Pi's
compiled top-level module imports is insufficient. The distribution must also
carry the project's legal files; the same packaged gate verifies them.

---

## 6. Upstream contributions

When a task needs a change in an upstream project (pi-subagents,
earendil-works/pi, any community package):

- File the PR or issue from the user's fork. Keep it small and self-contained,
  and justify it on its own merits for that project (extensibility, correctness,
  headless-host support).
- Record the PR URL in the task's notes and in `docs/upstream.md`.
- Until merged, the task depends on a local patch or a pinned fork; say which.

## 6a. One companion extension, many modules

All in-process glue for community packages lives in `packages/pi-extension` as
one Pi extension with one module per package (`src/modules/*`). Adding support
for a new package means adding a module, not a package. Modules never import
each other, detect their package at `session_start`, and fail individually
(reported to the UI, never fatal to the session). Three modules are Laser's own
rather than package glue: `subagents` registers the agent harness tools from
the worker-supplied `AgentHarnessBridge`, `background-work` owns long commands,
and `file-freshness` explains an `edit` aimed at a file that moved under the
agent (`docs/agents.md`, `docs/pi-extension-modules.md`).

### Goal policy and transcript regression checks

- Goals have no budgets and no separate usage accounting. Preserve the exact
  `@narumitw/pi-goal` pnpm policy patch when updating the engine; run
  `packages/pi-goal/test/policy.test.ts` against the installed dependency.
- The goal engine's tools belong in a request only while a goal is in play
  (D-146): the worker switches them on for `/goal` and `session/goal/action`
  before the engine's command dispatches, and the companion takes them away on
  the first turn of a session with no goal. The engine refuses to start a goal
  whose tools are not already active, so never gate them on an existing goal
  alone. `packages/pi-goal` owns the names; `test/policy.test.ts` pins them.
- Keep upstream completion terminating. Render its real summary as a durable
  chat record from canonical goal-state entries plus an accepted completion
  result. A later null clears active controls, not completed history. Never
  fabricate another assistant response or conceal rejected/stale completions.
- Hide only marker-bearing prompts associated with a known persisted goal ID.
  Keep the first objective literal, keep original entry ordinals for message
  actions, and exclude hidden scaffolding from search and catalog titles.
- Message metadata uses `MESSAGE_METADATA_NS`, not the RPC `WIRE_NAMESPACE`.
  Verify the visible goal-setter label, reload, session switching, detail modes
  and keyboard disclosure. `SANDBOX_GOAL=1` exercises a tool-only completion
  with the real engine and an isolated fake provider, without user credentials.

### Agents harness regression checks

The harness is Laser's own (D-140, `docs/agents.md`). These are release
blockers, not advice.

- One `start_agent` tool and four identities only (`agent_name`,
  `subagent_name`, `sessionId`, `runId`). Never a tool per agent, never a
  separate agent id, type or profile name. The parent's verbs are
  `send_agent_message`, `list_agents`, `inspect_agent`, `stop_agent` and
  `remove_agent_worktree`; the child's is `complete_agent_run`.
- Children never block: `start_agent` returns the identities before the child
  has done anything; there is no foreground mode.
- The parent chooses isolation per child: `start_agent`'s `worktree` defaults
  to true, and true means a worktree under `<project>/.worktrees/` on
  `agents/<slug>` or a person-facing refusal (not a repository, no commit, a
  path another agent owns) — and a refusal names both ways forward, git or
  `worktree: false`. `false` runs the child in the parent's checkout with every
  tool and nothing refused: the judgement is the parent's, and the child is told
  in its role block that it is not isolated (D-156). A project with no git
  accepts only `false`. The result always says where the child is working, and
  carries a branch only when there is one.
- A child's worktree belongs to its parent (D-157): reviewing, merging and
  removing it are the parent's, both agents are told so in their prompts, and
  nothing removes one silently. `remove_agent_worktree` refuses to destroy
  unmerged commits or uncommitted files unless told `force`, and then reports
  what it discarded. Deleting a child's session asks what to do with its
  worktree; `pi/session/delete` defaults to **keep** when the field is absent.
  A person can clear a leftover from the fleet without deleting the session.
- No waiting tool (D-158): a child's ending is delivered to its parent as a
  message that wakes its turn, and `start_agent`'s result says so. `inspect_agent`
  reads one child, is read-only, never wakes it, and returns at most ten
  excerpted messages. `needs_input` is a live, attention-toned run status —
  the child is paused on a question — never terminal and never folded into
  finished work; every surface that reads a run status has a test for it.
- Completion only through `complete_agent_run`; its message is stored once,
  as the child's final assistant message. Arbitrary last text is not
  completion; a child that settles without the call is not `completed`.
- User termination carries `initiator: "user"` and the verbatim reason to the
  parent's `lasercode/agent-event`; the parent's own `stop_agent` is
  `initiator: "parent"`; crashes and worker loss are `harness`.
- The catalog in the parent request is compact: `agent_name` and description
  only. Instructions and model load only in the child's request.
- Tools are not part of an agent definition: every agent has every tool
  (D-144). Nothing ends a run for taking too long — no timeout, no default
  limit, no timed-out state — and a project with a live run is never idle, so
  its worker is never retired underneath it.
- Test nesting depth (a child at `maxDepth` gets no `start_agent`), model
  access (a definition naming a model without a credential is refused), worktree
  ownership (an isolated run touches only the worktree it created; an
   uninsulated one shares its parent's checkout by design), a run that outlives
  any clock, settle-without-completion (not `completed`) and reload attribution
  (`lasercode/agent` puts a child under its parent after a host restart).
- Background promotion keeps the output already produced and the exit state;
  a promoted command is the same task, not a new one.
- Nothing is ever blocked over file freshness: the engine's `edit` matches
  `oldText` against the file as it is on disk and refuses a match it cannot find
  or one that is not unique, so the match itself is the proof (D-152, superseding
  the refusal in D-151). An `edit` aimed at a file that changed since the agent
  last read it gets one appended sentence — why the match failed when it failed,
  or a note that the file carries unseen changes when it succeeded. A `write` is
  never annotated but is still recorded, or the agent's own write makes its own
  next edit speak. The module holds file metadata only, never the file's
  contents, says nothing when it has no record, and never throws.
- Edit, Fork and Jump work mid-turn by stopping the turn first, and the
  driver owns that sequence (`stopFirst` on navigate and fork, D-159): a
  failure after the stop leaves the session stopped, unmoved and served, and
  the abandoned turn keeps its stop row. Never let the UI issue the stop and
  the move as two requests.
- The live map never re-layouts on output or status updates; only a change in
  the tree's structure recomputes positions. Test with a streaming child.
- Beam has two ways in and no more (D-143): the spark beside Settings, which is
  the only thing that opens the bubble, and the Beam group in the sessions
  sidebar, whose `+` starts a chat in the window. No Beam control elsewhere, in
  any state, and the agent's name is spelled in one place.
- More than one composer can be on screen (Beam's bubble over the session's
  own). Dictation belongs to the composer that started it: the transcription
  scope is claimed on the way into recording, never on mount, and a finished
  phrase is typed into the composer that owns the microphone, never into the
  first textarea in the document.

---

## 6b. Search regression checks

- Saved-history search belongs in the host and must not open workers. Search
  message text, reasoning and tool bodies, not image blobs or session metadata.
- New protocol methods need a schema round-trip sample and router coverage,
  not just implementation tests; the complete method inventory is a release gate.
- Rank by the best matching source (user, assistant, activity), then recency;
  the excerpt and the destination must agree with that source. Keep older-range
  expansion explicit and reject stale query replies.
- Find must not wrap or replace React-owned text nodes. Use DOM ranges/native
  highlights; force layout for the selected `content-visibility` message before
  measuring it, and account for the sticky composer when scrolling. Verify a
  distant match in a folded tool, not only visible paragraphs.
- Search disclosure is transient. Closing find restores the user's detail
  preference and focus; excerpts remain inside result rows, never overlays.

---

## 6b. Searchable tool content

Search must use the shared display projections in `packages/protocol/src/search-content.ts`,
never serialized tool requests/results. Structural keys such as `command` are not
content. When adding a specialized tool body, update its projection and mark its
visible value regions with `data-search-content`; test key-only misses and actual
value highlights. Generic JSON fallback tools inherit value-only search automatically.
See [`docs/search-content.md`](docs/search-content.md) for the full contract.

The API request inspector is deliberately different: its full-request search
includes every retained JSON key, value and syntax character. Never apply the
conversation value-only selector there. Section search highlights rendered
content once (not its duplicate preview/JSON), and request find owns separate
native highlight names and modal-only scrolling/keyboard handling.

Source disclosure regression checks: keep source menus inside the parent
dialog's portal/scroll-lock boundary and test real wheel scrolling, not just
overflow classes. Pointer details must anchor to the cursor, with keyboard
fallback and no native `title` duplicate. Markdown file links resolve against
their owning session/capture directory and call the native text-editor bridge;
never resolve them against the web origin or use MIME-based file opening for
scripts/HTML. Remote views copy the host path. File opening is explicit, without
shell interpolation, and source controls never duplicate searchable prompt text.

### Instruction provenance regression checks

- Capture sources from Pi's loaded prompt options and observed extension writes,
  never by reopening current files or guessing from prompt headings. Verify the
  pinned assembly adapter against the real engine builder when upgrading Pi.
- Capture after all registered pre-request handlers, including in-place edits.
  Keep observers isolated per runtime; diagnostic code must not alter requests.
- Retain only source ranges/identities and digests beside the log, not a second
  unredacted prompt. Validate retained text before applying ranges. Old captures,
  changed text and unobserved overrides must not inherit invented attribution.
- Source markers cannot change copied text, duplicate request-search hits, or
  split the chat Markdown renderer into independently parsed source fragments.
  Check keyboard and touch source details, long skill lists, and both themes.
  See `docs/prompt-provenance.md`.

## 7. Commits

- Commit only when the task owner asks or when a task reaches `done`.
- Conventional prefix (`feat:`, `fix:`, `docs:`, `chore:`), scope = package name.
- No AI attribution trailers of any kind in commit messages or PR bodies.
- Never commit secrets, `auth.json`, session transcripts, or `.env` files.
- Run `pnpm identity:check` after adding new source files, not only before they
  are staged. The identity guard scans tracked and untracked non-ignored source;
  this prevents CI-only failures from a new file that hard-codes product identity.

---

## 8. Do not

- Do not add dates, estimates, or "ETA" anywhere in `PLAN.md`, `STATUS.md`, or
  `STATUS_DETAILED.md` other than the history dates in notes.
- Do not start a task without claiming it.
- Do not mark `done` without evidence.
- Do not delete rows, notes, handoffs, or decisions.
- Do not import Pi outside the worker and the pi-extension package.
- Do not add a new bridge package for a community package; add a module to
  `packages/pi-extension`.
- Do not use the user's global Pi as the runtime.
- Do not write to `~/.pi/agent/settings.json` while a Pi process may be running
  it, except through `SettingsManager` (it takes the lock).
- Do not run two laser workers against the same project directory.
