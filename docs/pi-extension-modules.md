# Writing a module for the companion extension

Status: **binding for `packages/pi-extension`** (M8-T5). Read
[`AGENTS.md`](../AGENTS.md) §6a and [`docs/ux-fleet.md`](ux-fleet.md) first —
this file is how you obey them in code.

Support for a community package is **a module, never a package**. There is one
Pi extension in this repo, `@lasercode/pi-extension`, and it carries one module
per package it knows about. Adding pi-web-access support meant adding
one module and one line in `src/modules/index.ts`; D-61 later retired that
adapter because its second list duplicated the transcript. That was the whole
ceremony, and it is deliberate: a second extension would mean a second
`session_start`, a second failure domain, and a second thing to install.

Three modules are not package glue at all. `subagents` registers the agent
harness tools (`start_agent`, `send_agent_message`, `list_agents`,
`wait_for_agents`, `stop_agent`; `complete_agent_run` in a child), appends the
child's role to its system prompt and delivers agent events to the parent
model — every call goes to the worker-supplied `AgentHarnessBridge`
(`src/agents-bridge.ts`). `background-work` owns long commands.
`file-freshness` explains an `edit` to a file that moved under the agent
(§8). All three are Laser's own (D-140, [`agents.md`](agents.md)); they follow
every rule below, and their "package" is the worker or the engine itself.

---

## 1. What a module is

```ts
export interface LaserModule {
  name: ModuleName;
  /** True if the package this module bridges is present in this session. */
  detect(ctx: ModuleContext): boolean | Promise<boolean>;
  /** Wire up; return a disposer if anything needs cleanup at session_shutdown. */
  activate(ctx: ModuleContext): void | (() => void) | Promise<void | (() => void)>;
}

export interface ModuleContext {
  pi: ExtensionAPI;                 // the Pi extension API for this session
  send: (message: OutboundMessage) => void;   // → the worker, in-process
  commands?: CommandBus;            // ← the worker (Stop on a task, a usage refresh)
}
```

`name` is a member of `PiExtensionModuleName` in
[`packages/protocol/src/pi-extension.ts`](../packages/protocol/src/pi-extension.ts).
Add yours there first: the protocol is the vocabulary, and it changes before
the implementation does (AGENTS.md invariant 2).

Three rules, and they are not style:

- **Modules never import each other.** If two need the same helper, it goes in
  its own file under `src/`, or — better — each keeps its own copy of the eight
  lines it actually needs. Coupling two modules means one package's absence can
  break another's.
- **A module fails alone.** `createLaserExtension` wraps every `detect` and
  `activate` in a try/catch and reports failures in `laser/capabilities`
  under `failed`. Never let a module throw out of a Pi event handler.
- **Nothing here reads files.** The host owns durable observation — the
  session catalog watcher, and the agent run registry fed by the worker's
  `agents/run` notifications — so that sessions started from a terminal, and
  runs whose worker is gone, stay visible. If your integration is "watch a
  directory", it belongs in the host, not here.

---

## 2. Detection

Detection answers one question: *is the package this module bridges loaded in
**this** session?* It runs inside `session_start`, after Pi has loaded every
other extension, so Pi's own registries are the source of truth.

**Probe capabilities, never versions** (R11). A package's version number tells
you what its author intended; its registered tools tell you what you can
actually call. And a package the user filtered out of this project is
indistinguishable from one that is not installed — which is correct, because
the affordance must be hidden in both cases.

The three probes, in order of preference:

```ts
// 1. A registered tool — the strongest signal, and the one that survives a rename.
// This is the historical pi-web-access adapter's probe; D-61 retired its second list.
pi.getAllTools().some((tool) => fromPackage(tool.sourceInfo, "pi-web-access"));

// 2. A registered command.
pi.getCommands().some((c) => c.name === "transcribe" && fromPackage(c.sourceInfo, "pi-gpt-transcribe"));

// 3. A globalThis registry the package publishes for in-process peers.
REGISTRY_SYMBOLS.some((key) => (globalThis as Record<PropertyKey, unknown>)[Symbol.for(key)] !== undefined);
```

`sourceInfo` is Pi's own provenance record: `source` is the settings entry
(`npm:pi-web-access`, `git:github.com/you/pi-gpt-transcribe`) and `path` is the
resolved file. Match **both**, because the same package installed from npm,
from git and from a local checkout writes three different `source` strings and
only the path is common to all three:

```ts
function fromPackage(info: SourceInfo | undefined, id: string): boolean {
  if (!info) return false;
  return info.source.includes(id) || info.path.includes(id);
}
```

Do not match on tool *names*. pi-web-access lets its user rename every one of
its four tools in `config.json`; a name match would silently stop working.

**Never guess "yes".** Wrap the probe in a try/catch that returns `false`.
Detection is an offer of an affordance: a wrong "no" costs a feature that was
not there anyway, a wrong "yes" costs a button that fails when it is pressed.

The harness modules detect nothing on the engine: `subagents` is present when
the worker passed `ctx.agents` (the Subagents feature is on for this
session) and `background-work` when it passed `ctx.backgroundWork`. Their
tools are registered in `register()`, while the engine is still collecting
extension definitions, because a tool added at `session_start` is too late for
the first turn.

### How detection reaches the UI

`createLaserExtension` sends one message at `session_start`:

```ts
{ type: "laser/capabilities", active: ModuleName[], failed: [{ module, error }] }
```

It travels to the client as `pi/extension/message` and is the flag the UI gates
features on (M8-T1). A session where `transcribe` is not in `active` shows no
microphone at all; it does not show a disabled one (R2 — hide the control, put
the reason in the tooltip where it would have been).

**A capability is per session, not per app.** Two projects open at once can
have different packages installed, and the capability report is the only thing
that knows which is which.

---

## 3. Activation

`activate` wires up Pi event handlers and returns a disposer. Pi has no `off`
for `pi.on`, so handlers live as long as the session; the disposer is for
things you own — bus subscriptions from `pi.events.on` (which *does* return an
unsubscribe), timers, caches.

What activation is allowed to do:

| Do | Do not |
| --- | --- |
| Subscribe to `pi.on(...)` events | Block one — every handler is awaited |
| Read `ctx.sessionManager` (read-only) | Write to the session file |
| Emit on `pi.events` | Import another module |
| `send(...)` messages to the worker | Assume a client is attached |
| Report a problem as `laser/module/log` | Throw |

`laser/module/log` at `error` level surfaces as a toast; `info` and `warn` go
to the host's log store. Use `error` only for something a person can act on.

### Awaiting a Pi event on purpose

Pi awaits its `input` handlers before the prompt is delivered, which makes that
hook the one place a module can hold a prompt open. `modules/transcribe.ts`
uses it to make sure a phrase still being transcribed when Enter is pressed
ends up in *that* prompt rather than the next one. If you do this:

- bound the wait (dictation's ceiling is 30 s, and what has not landed by then
  is returned to the composer, not dropped);
- return `{ action: "continue" }` on every failure path, so a broken module
  cannot swallow someone's prompt.

---

## 4. Showing something, and asking something

**There is no general-purpose display bus.** There used to be — six panel
kinds and four surfaces (`docs/ux-panels.md`, retired by M13-T26) — and it was
a second app inside the app. A module now has exactly two roads, and both are
narrow on purpose.

### Showing: the tool call that produced it

Whatever a module found, it found inside a tool call, and the tool call is
already a row in the transcript with its request, its result and a disclosure.
Put the finding there. Web search is the worked example: its results render in
its own tool row, and the second list the panel system drew beside them was
showing one thing twice ([`docs/ux-elements.md`](ux-elements.md), "Web
search"). If the row needs a specialised body, that is a body in
`packages/ui/src/components/thread/`, a search projection in
`packages/protocol/src/search-content.ts`, and a row in
[`docs/search-content.md`](search-content.md).

### Long work: the fleet

Work that outlives its tool call — a command left running, an agent started —
is *fleet* work, and the fleet has a typed domain model rather than a bus
([`docs/ux-fleet.md`](ux-fleet.md)). `background-work` is the worked example:
it publishes `laser/task/update` with a `BackgroundTaskUpdate`, the worker
stamps the session path, the host keeps the register and the column draws it.

Adding a third kind of fleet work means adding a type to
`packages/protocol/src/tasks.ts` and a decision in `STATUS_DETAILED.md`. That
friction is the feature: a general bus had none, and grew six kinds and four
surfaces before anyone noticed.

### Asking: the four dialogs

`select`, `confirm`, `input` and `editor` through Pi's own `ctx.ui`. They reach
the worker's UI bridge as `pi/ui/request` and are answered **inline in the
transcript** — inside the tool row that raised them when that row is on screen,
otherwise as a card above the composer. A module needs no code for this beyond
calling `ctx.ui`; `ctx.ui.custom()` is not emulated (AGENTS.md invariant 6),
and anything laser cannot draw is cancelled rather than left hanging.

### Where to get the data

Prefer the package's own persisted record over the tool result. If a package
writes a custom session entry on every code path while the tool details exist
only on one path, bracket the tool call and read what it appended:

```ts
pi.on("tool_execution_start", (event, ctx) => marks.set(event.toolCallId, entriesOf(ctx).length));
pi.on("tool_execution_end", (event, ctx) => {
  const from = marks.get(event.toolCallId);
  for (const entry of entriesOf(ctx).slice(from ?? 0)) { /* … */ }
});
```

No ids to guess, and it keeps working when the tool is renamed.

---

## 5. When a capability needs a native Laser surface

Some engine capabilities began as terminal programs. pi-gpt-transcribe opens the microphone
from the Pi process, draws a TUI component and writes into Pi's own editor;
pi-markdown-preview and `@xynogen/pix-display` are `ctx.ui.custom()` from top to
bottom. `custom()` is not emulated (D-2) and never will be.

For those, the module does **not** bridge presentation. It does two things:

1. **Declares availability**, so the native affordance is part of Laser itself.
2. **Keeps the capability contract**, so the native implementation and the
   terminal one stay the same product.

pi-gpt-transcribe is the worked example. Laser bundles its exact reviewed core
and implements dictation —
microphone and meter in the browser, key and network call in
`packages/worker/src/transcribe.ts` — while keeping three things from upstream:
its `config.json` (one edit serves both), its `WidgetState`
(`{ level, pending, inserted, error, startedAt }`) as the waveform's contract,
and its phrase-at-a-time pre-send behaviour. Natural pauses cut phrases; requests
can transcribe concurrently, but finished text is delivered in spoken order at
the live composer caret so voice and keyboard edits can coexist. Sending waits
for the last in-flight phrase rather than dropping it. Copying a contract is cheap; forking a product is
not. Dictation is always present and never appears in the Features page. Settings
→ Providers and models explains that it needs an OpenAI platform API key, and
the microphone preflight reports the same requirement before recording starts.

The rendering rules travel with the contract. A level meter must map RMS to
decibels between −60 and −8 dBFS with a fast attack and a slow release
(`levelToUnit` / `followEnvelope` in the worker's transcribe module): speech
sits around −30 dBFS, which is the bottom tenth of a linear bar, and a linear
meter looks dead while someone is talking.

Native replacements live in the UI, not here:
`packages/ui/src/components/preview/` renders markdown, unified diffs, images
and source text wherever bytes turn up, and says plainly that it will not draw
a PDF rather than showing a broken viewer.

---

## 6. Talking to the worker in the same process

Both `@lasercode/pi-extension` and the module code run **inside the worker
process**, but the dependency only points one way: the worker depends on this
package, so this package can never import the worker.

When something in the worker has to be reachable from a Pi event handler, the
worker either passes it explicitly — the agent harness arrives as
`createLaserExtension({ agents, backgroundWork })` and modules read
`ctx.agents` / `ctx.backgroundWork`, with the interface declared on both sides
in `src/agents-bridge.ts` and `packages/worker/src/agents/bridge.ts` — or, for
a handle that must be found from code that has no context, publishes it on a
well-known symbol and the module looks it up (the shape the retired
pi-subagents module used for that package's registries):

```ts
const BRIDGE = Symbol.for("laser.transcribe.v1");   // declared on both sides, imported by neither
```

Rules for a bridge:

- **Both sides declare the interface; neither imports the other.** Two
  ten-line interfaces beat a dependency cycle.
- **Version by renaming the symbol.** A session that finds a symbol it does not
  understand is indistinguishable from one that finds nothing, and both must
  degrade to "the feature is off" rather than to a hang.
- **Absence is normal.** Check the shape (`typeof handle.drain === "function"`)
  before calling; an older worker simply has no bridge.

---

## 7. Adding a module: the checklist

1. Add the name to `PiExtensionModuleName` in
   `packages/protocol/src/pi-extension.ts`.
2. Create `packages/pi-extension/src/modules/<name>.ts` exporting a
   `LaserModule`.
3. Register it in `packages/pi-extension/src/modules/index.ts` — import and add
   to the `modules` array. Order is for log readability only.
4. Write `detect` against Pi's registries, returning `false` on any throw.
5. Write `activate`. Report problems with `laser/module/log`; return a
   disposer if you subscribed to anything.
6. If the UI must change behaviour, gate it on the module name appearing in
   `laser/capabilities`, never on a version or a setting.
7. Test only what is subtle — a payload mapping, a parser, a state machine.
   Detection against a live Pi is not a unit test; the mapping from the
   package's shape to a typed payload is.
8. Note the package, its version and what you verified in
   [`docs/upstream.md`](upstream.md) if you read its source to write the
   module. What was learned from pi-subagents before D-140 is in
   [`docs/agents-leap/references/pi-subagents-reference.md`](agents-leap/references/pi-subagents-reference.md).

### The modules today

| Module | Bridges | Detection | What it produces |
| --- | --- | --- | --- |
| `provider-log` | Pi's own provider hooks | always | `laser/provider/*` for the logs page |
| `account-usage` | the subscription allowance route | an account-authenticated provider | `laser/account-usage/state` |
| `goal` | `@narumitw/pi-goal` state entries | Goals feature enabled | `laser/goal/state` |
| `subagents` | the worker's agent harness (`AgentHarnessBridge`) | `ctx.agents` present | the harness tools, the child's role block, `laser/agent-event` custom messages in the parent |
| `background-work` | the worker's shell (`BackgroundWorkOptions`) | `ctx.backgroundWork` present | `bash` with a background flag and timeout promotion, `task_*` tools, `laser/task/update` for the fleet, `laser/task-event` |
| `file-freshness` | the engine's own `read`/`write`/`edit` tools | always | one appended sentence on an `edit` to a file that changed since the agent last saw it (§8) |
| `transcribe` | pi-gpt-transcribe | the `/transcribe` command | detection + the pre-send transform |
| `web-access` | pi-web-access | retired by D-61 | the module is a stub; the transcript tool disclosure is the single presentation |

Historical: before D-140 `subagents` probed pi-subagents' `globalThis`
registries and its `subagents:rpc:v1` bus and emitted `laser/subagents/event`.
That module is gone with the package.

---

## 8. Guarding the engine's own tools

`file-freshness` is the worked example of a module that adds a rule to a tool
the engine already owns, rather than bridging a package (M13-T33).

**The rule is content-based, not clock-based** (M13-T36, replacing the refusal
recorded as D-151). Pi's `edit` replaces exact text: it matches every
`edits[].oldText` against the file *as it is on disk right now*, refuses a match
it cannot find, and refuses a match that occurs more than once — verified
against `core/tools/edit-diff.js` in pinned Pi 0.85 and against the real tool in
`test/file-freshness.test.ts`. That match **is** the freshness proof. An edit
whose old text still matches, uniquely, in the current file is safe to apply no
matter how old the agent's reading of the file is.

**So the module blocks nothing.** There is no `tool_call` handler; the hook it
uses to look before a tool runs — `tool_execution_start` — has no result type at
all, so it is structurally incapable of stopping a call. A wrong record can no
longer cost the agent a turn.

**Hooks, not an override.** `tool_execution_start` fires before a tool executes,
which is the only moment "did this file change *before* the edit?" can be asked:
by `tool_result` a successful `edit` has already moved the mtime itself.
`tool_result` fires after, with `isError`, so what is recorded is what actually
happened, and it may replace the result's `content`. Re-registering
`read`/`write`/`edit` would inherit a maintenance burden on every engine bump for
no extra power. `background-work` overrides `bash` only because it genuinely
replaces execution; if you are only adding a rule, use the two hooks.

**What it says.** A successful `read`, `write` **or** `edit` records the file's
`mtimeMs` and `size` against its resolved path. On an `edit` to a path whose
record no longer matched disk when the call started, one sentence is *appended*
to the engine's own result — never replacing it — and there are exactly two:

- the edit **failed to match**: the engine has said the text was not found; ours
  says why (the file moved under you) and that the recovery is one re-read;
- the edit **succeeded**: it matched the current text and was applied, and the
  file still carries changes the agent has not seen, so it should re-read before
  any further edit that depends on the surrounding lines.

Everything else is silent. Those two strings are the whole user interface of the
feature: an agent reads them and nothing else, and `test/file-freshness.test.ts`
pins both verbatim.

- **Only a match failure is explained.** `MATCH_FAILURE_PATTERNS` is pinned to
  the engine's own wording for "could not find", "found N occurrences" and
  "produced identical content". An unreadable path, an empty `oldText`,
  overlapping edits or an abort have nothing to do with freshness and get no
  sentence; a test provokes each one through the real engine tool, so an engine
  bump that rewords an error fails a test rather than quietly annotating
  everything or nothing.
- **`write` is untouched**, as is every other tool. A write replaces the file
  whole, so it makes no claim about what was there. It still records, or the
  agent's own write would trip its own next edit — that is the single most
  important detail in the module, and the reason the old refusal produced false
  alarms on the agent's own work (anthropics/claude-code #3513, #7443, #10437,
  #11463, #48390). A test drives five consecutive edits to one file through the
  real engine tool and asserts silence on all five.
- The module **never throws**, and **says nothing when it has no claim**: no
  record, a missing file, or a failed stat are all silence. The tool reports its
  own errors; this module must not invent one, and a failure to annotate leaves
  the engine's result exactly as it was.
- **Metadata only.** No content, no snapshot, no digest: a session that reads a
  thousand files costs a thousand small structs. The record store is bounded
  (2048 entries, least-recently-touched evicted) because the map is memory too,
  and an evicted record simply means nothing to say.
- **Per session, not per process.** Records live in a `WeakMap` keyed by the
  module context, like `background-work`'s task state, and are dropped by the
  disposer at `session_shutdown`. A child agent working in its own worktree must never
  see its parent's records.
- A file changed by a `bash` command needs no special case: its mtime moved,
  so the ordinary rule catches it.

Deliberately **not** implemented: requiring a read before editing a file that
was never read. That is a stricter rule, and it is not this one.

---

## Related

- [`docs/ux-fleet.md`](ux-fleet.md) — where long work and questions render.
- [`docs/architecture.md`](architecture.md) — why durable observation is in the host.
- [`docs/agents.md`](agents.md) — the agent harness the `subagents` and
  `background-work` modules are the model-facing half of.
- [`docs/agents-leap/references/pi-subagents-reference.md`](agents-leap/references/pi-subagents-reference.md)
  — what was verified about pi-subagents before it was replaced.
- [`docs/upstream.md`](upstream.md) — patches we would like upstream, with diffs.
