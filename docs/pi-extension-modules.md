# Writing a module for the companion extension

Status: **binding for `packages/pi-extension`** (M8-T5). Read
[`AGENTS.md`](../AGENTS.md) §6a and [`docs/ux-panels.md`](ux-panels.md) first —
this file is how you obey them in code.

Support for a community package is **a module, never a package**. There is one
Pi extension in this repo, `@lasercode/pi-extension`, and it carries one module
per package it knows about. Adding pi-web-access support meant adding
`src/modules/web-access.ts` and one line in `src/modules/index.ts`. That is the
whole ceremony, and it is deliberate: a second extension would mean a second
`session_start`, a second failure domain, and a second thing to install.

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
  commands?: CommandBus;            // ← the worker (panel actions today)
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
- **Nothing here reads files.** File watchers live in `@lasercode/host` so that
  sessions started from a terminal — which have no worker and no extension —
  stay visible. If your integration is "watch a directory", it belongs in the
  host, not here.

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

## 4. Showing something: the panel contract

**An extension declares a kind and an intent. laser decides how it looks and
where it goes.** Read [`docs/ux-panels.md`](ux-panels.md) — six kinds
(`run`, `plan`, `document`, `stream`, `collection`, `decision`), four surfaces,
and a placement table that laser owns. A module never ships a component, a
colour or a width.

Emit on Pi's event bus, exactly as a third-party extension that opted into the
contract would:

```ts
import { PANEL_EVENT, type PanelEvent } from "@lasercode/protocol";

const panel: PanelEvent = {
  v: 1,
  id: `web-access:${searchId}`,          // stable; re-emit to update in place (R6)
  kind: "collection",
  intent: "inline",
  source: "pi-web-access",               // the badge on the panel
  title: `8 results for “noise protocol”`,
  data: { layout: "list", items },       // kind-specific, strict JSON
};
pi.events.emit(PANEL_EVENT, panel);
```

`modules/panels.ts` validates it, drops an identical re-emit, and forwards it to
the worker. `PANEL_CLOSE_EVENT` retires a panel; actions a person presses come
back on `PANEL_ACTION_EVENT`.

Going through the public bus rather than a private `send(...)` is on purpose:
our own adapters are the contract's first users, so a gap in it is our problem
before it is anyone else's. A terminal Pi has nobody listening and the emit
costs nothing.

Four rules the validator enforces, and one it cannot:

1. **No presentation, at any depth.** `html`, `className`, `style`, `color`,
   `width`, `icon`, `component`, `surface` and their friends are refused by
   name. If you want a different look, you want a new kind, which is a decision
   in `STATUS_DETAILED.md`.
2. **Generic shapes, never domain values (R12a).** A collection row has
   `primary`, `secondary` and `meta: [{ label, value }]`. The moment a payload
   grows a `url` field for a search hit, the next producer — grep hits, package
   lists, citations — does not fit. Put the URL in a `meta` row; the label is
   yours, the shape is everyone's.
3. **References, never bytes.** Content is a `ref` the host reads in ranges. No
   payload carries a megabyte.
4. **Say when you inferred it (R3).** The validator cannot check this. If you
   rebuilt structure from timestamps, mark it `inferred` so it draws dashed.

Sizes the schema enforces, so you clamp before you emit: a collection item's
`primary` ≤ 1000 characters, `secondary` ≤ 4000, each `meta` value ≤ 400, at
most 20 meta rows and 2000 items. A payload that fails validation is dropped
whole and logged — clamp a long URL rather than lose the panel.

### Where to get the data

Prefer the package's own persisted record over the tool result. pi-web-access
writes every search, fetch and source-check as a custom session entry with
`pi.appendEntry("web-search-results", …)`; that entry exists on every code path,
while `details.curatedQueries` exists only on the curated one. Bracket the tool
call and read what it appended:

```ts
pi.on("tool_execution_start", (event, ctx) => marks.set(event.toolCallId, entriesOf(ctx).length));
pi.on("tool_execution_end", (event, ctx) => {
  const from = marks.get(event.toolCallId);
  for (const entry of entriesOf(ctx).slice(from ?? 0)) { /* … */ }
});
```

No ids to guess, and it keeps working when the tool is renamed.

---

## 5. When the package cannot be driven at all

Some packages are terminal programs. pi-gpt-transcribe opens the microphone
from the Pi process, draws a TUI component and writes into Pi's own editor;
pi-markdown-preview and `@xynogen/pix-display` are `ctx.ui.custom()` from top to
bottom. `custom()` is not emulated (D-2) and never will be.

For those, the module does **not** bridge. It does two things:

1. **Detects**, so the native affordance appears exactly where the package is.
2. **Keeps the package's contract**, so the native implementation and the
   terminal one stay the same product.

pi-gpt-transcribe is the worked example. laser reimplements dictation —
microphone and meter in the browser, key and network call in
`packages/worker/src/transcribe.ts` — and keeps three things from the package:
its `config.json` (one edit serves both), its `WidgetState`
(`{ level, pending, inserted, error, startedAt }`) as the waveform's contract,
and its pre-send behaviour. Copying a contract is cheap; forking a product is
not.

The rendering rules travel with the contract. A level meter must map RMS to
decibels between −60 and −8 dBFS with a fast attack and a slow release
(`levelToUnit` / `followEnvelope` in the worker's transcribe module): speech
sits around −30 dBFS, which is the bottom tenth of a linear bar, and a linear
meter looks dead while someone is talking.

Native replacements live in the UI, not here:
`packages/ui/src/components/preview/` renders markdown, unified diffs, images
and source text as `document` panel bodies, and says plainly that it will not
draw a PDF rather than showing a broken viewer.

---

## 6. Talking to the worker in the same process

Both `@lasercode/pi-extension` and the module code run **inside the worker
process**, but the dependency only points one way: the worker depends on this
package, so this package can never import the worker.

When something in the worker has to be reachable from a Pi event handler, the
worker publishes a small handle on a well-known symbol and the module looks it
up — the same shape pi-subagents uses for its own in-process registries:

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
5. Write `activate`. Emit panels on the bus; report problems with
   `laser/module/log`; return a disposer if you subscribed to anything.
6. If the UI must change behaviour, gate it on the module name appearing in
   `laser/capabilities`, never on a version or a setting.
7. Test only what is subtle — a payload mapping, a parser, a state machine.
   Detection against a live Pi is not a unit test; the mapping from the
   package's shape to a panel is.
8. Note the package, its version and what you verified in
   `docs/research/findings.md` if you read its source to write the module.

### The modules today

| Module | Bridges | Detection | What it produces |
| --- | --- | --- | --- |
| `provider-log` | Pi's own provider hooks | always | `laser/provider/*` for the logs page |
| `panels` | the declared panel protocol | always | validates `laser:panel` → `laser/panel/upsert` |
| `subagents` | pi-subagents registries and its rpc bus | `globalThis` symbols | `laser/subagents/event` |
| `transcribe` | pi-gpt-transcribe | the `/transcribe` command | detection + the pre-send transform |
| `web-access` | pi-web-access | its registered tools | `collection` panels for searches, fetches and source checks |

---

## Related

- [`docs/ux-panels.md`](ux-panels.md) — the panel contract these modules emit into.
- [`docs/architecture.md`](architecture.md) — why file watching is in the host.
- [`docs/research/findings.md`](research/findings.md) — what was verified about
  each package, including which are terminal-only.
- [`docs/upstream.md`](upstream.md) — patches we would like upstream, with diffs.
