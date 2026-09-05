# The panel contract — how anything renders in piorbit (proposal)

Status: **proposal, not yet decided.** M3 and the rest of the extension work
are blocked on agreeing this. Once decided it becomes a contract as binding
as `packages/ui/DESIGN.md`.

## The thesis

**Pi owns the logic. piorbit owns the experience.**

Pi deliberately ships almost nothing: no MCP, no subagents, no plan mode, no
todos, no background bash. Everything is an extension, and every extension
invents its own presentation. In a terminal that is fine, because the only
surface is lines of text. In a GUI it is a disaster: five extensions doing
structurally similar things — a list of results, a running job, a document —
would each render differently, and the app would look like five apps.

So piorbit does not pass presentation through. Extensions declare **what they
have**; piorbit decides **how it looks and where it goes**. An extension
never ships a component, a colour, or a layout.

## What extensions can say today

The portable surface Pi gives a non-terminal host is tiny:

| Call | What it really is |
| --- | --- |
| `setWidget(key, lines[])` | a block of text, above or below the composer |
| `setStatus(key, text)` | one line of state |
| `notify(message, level)` | a transient message |
| `select` / `confirm` / `input` / `editor` | a blocking question |
| `setTitle`, `setEditorText` | window title, composer text |

Everything richer is `ctx.ui.custom()`, which needs a real terminal and which
we do not emulate (D-2). So today a fleet of subagents, a set of web search
results, and a markdown preview all arrive as *lines of text in a widget*.
That flattening is the problem this standard solves.

## Six panel kinds

Every useful thing an extension produces is one of six. The list is closed on
purpose: a seventh kind is a decision, not a convenience.

| Kind | What it is | Who produces it |
| --- | --- | --- |
| `run` | agent work with a lifecycle, and maybe controls | pi-subagents children, background jobs, scheduled runs, external runs |
| `plan` | intended structure over several steps | workflows, missions, todo lists, agent plans |
| `document` | something you read | markdown preview, a report, a diff, an image |
| `stream` | append-only output | bash output, build logs, provider requests |
| `collection` | a set of found things | web search results, grep hits, file lists, citations |
| `decision` | something blocking on you | approvals, select / input / editor, elicitation forms |

Two things are deliberately **not** panel kinds:

- **Metrics** are not a panel. Context, tokens and cost live in the telemetry
  rail, which already exists. A panel that is just numbers is a rail entry.
- **Embeds** — a live browser pane, an arbitrary iframe — are out of scope for
  v1. Naming the exclusion is the point: we are not building a browser.

## Four surfaces

Where a panel can appear. Also closed.

| Surface | Shape | For |
| --- | --- | --- |
| **Ambient** | one line in the top bar or telemetry rail | state you glance at |
| **Inline** | a card in the transcript, at the point it happened | the result of a tool call you just watched |
| **Dock** | the right side, at most **two** stacked panes | something you want to keep watching while you keep working |
| **Sheet** | overlay, focused, dismissible | something you are doing *instead of* the conversation |

The dock is the Claude Code idea, kept deliberately small: two panes, never
three. A third promotion evicts the least recently used pane, and the evicted
panel stays reachable from the panel bar rather than disappearing.

### Dock geometry

Panes are not fixed boxes. A pane has four states, and the dock always shows
the most useful arrangement of what is open:

| State | What it looks like | How you get there |
| --- | --- | --- |
| **Solo** | one pane, the full height of the dock | it is the only pane open, or you collapsed the other |
| **Split** | two panes stacked, with a draggable divider | a second panel is promoted to `follow` |
| **Collapsed** | header row only, content hidden | you collapse it to keep it without giving it space |
| **Maximized** | the pane takes the whole window; rail, thread and dock are hidden | the maximize control, or double-click its header |

Rules for the geometry:

- **Solo is the default, not a degraded split.** One panel gets the whole
  dock. The split only exists when two things are genuinely being watched.
- **The divider is draggable and remembered per session**, snapping to a
  50/50 midpoint. A pane never shrinks below its header.
- **Maximize is reversible and never destructive.** `Esc` restores, the
  underlying conversation keeps streaming, and the panel returns to exactly
  the pane and scroll position it left.
- **Collapse is how you keep something without paying for it.** A collapsed
  pane still shows its status dot and title, so a collapsed run that starts
  waiting for you still lights up (R5).
- On a phone none of this applies: `follow` is a sheet, and a maximized sheet
  is just a sheet.

## Placement is piorbit's decision, not the extension's

An extension declares a **kind** and an **intent**. piorbit maps that, plus
the viewport, onto a surface. The extension never names a surface.

Intents:

- `glance` — I am state, not content
- `inline` — I belong where I happened
- `follow` — I want to be watched while work continues
- `inspect` — I want your attention now

The mapping, which is the opinionated core of this document:

| Kind | glance | inline | follow | inspect |
| --- | --- | --- | --- | --- |
| `run` | ambient pill | inline card | **dock** | sheet |
| `plan` | ambient pill | inline card | **dock** | sheet |
| `document` | — | inline card, collapsed | **dock** | sheet |
| `stream` | ambient line | inline card, tail only | **dock** | sheet |
| `collection` | — | **inline card** | dock | sheet |
| `decision` | — | **inline, in its tool row** | — | sheet, only if it blocks everything |

On a phone the dock does not exist: `follow` becomes a sheet, and the panel
bar becomes a row of chips above the composer. That is the only branch in the
table, and it is why the table exists rather than each panel deciding.

## The contract

Four ways a panel reaches piorbit.

**1. Adapters we write.** Our companion extension already has a module per
supported package. A module translates that package's private world into
panels: pi-subagents children become `run` panels, its workflows become
`plan` panels, pi-web-access results become a `collection`. The community
package stays untouched and unaware.

**2. A declared protocol, for extensions that want to opt in.** Namespaced on
Pi's event bus, so a terminal Pi ignores it and nothing breaks:

```ts
pi.events.emit("piorbit:panel", {
  v: 1,
  id: "web-access:search:42",        // stable; re-emit to update in place
  kind: "collection",
  intent: "inline",
  title: "8 results for \"noise protocol\"",
  data: { items: [{ title, url, snippet }] },   // strict JSON, kind-specific
  actions: [{ id: "open", label: "Open" }],     // piorbit renders the controls
});
```

piorbit answers on `piorbit:panel:action` with `{ id, actionId, value }`.
`piorbit:panel:close` retires a panel. That is the whole API.

The rule that makes it work: **the payload is data, never presentation.** No
HTML, no class names, no colours, no widths. An extension that wants a
different look is asking for a new `kind`, which is a conversation.

**3. A local service adapter.** Not everything in this ecosystem is an
extension. `feynman` bundles Pi and ships its own HTTP server with an SSE
stream; piorbit renders its runs and plans as panels by talking to that API,
loading nothing into Pi at all. Any peer tool with a local API can be adapted
the same way.

**4. Fallback, so nothing regresses.** An extension that knows nothing about
piorbit still works exactly as well as today: its `setWidget` lines render as
a `stream` panel with monospace text, its `setStatus` as an ambient line, its
dialogs as `decision` panels. Adopting the contract is an upgrade, never a
requirement.

## The conformance test

A standard with one implementation is a description of that implementation.
So the test is four independent implementations of "background agent work",
built by people who never coordinated, rendering identically:

| | `pi-subagents` (nicobailon) | `@tintinweb/pi-subagents` | `pi-background-tasks` | `feynman` |
| --- | --- | --- | --- | --- |
| Downloads/month | 362k | 48k | 108k | 297k |
| Architecture | **file-first** | **bus-first, in-process** | in-process registry, write-only file mirror | **standalone app with an HTTP+SSE server** |
| Is it even an extension? | yes | yes | yes | **no** — it bundles Pi and ships its own GUI |
| Control from outside the Pi process | yes, a file control inbox | **none** | none, the bus is in-process | yes, REST |
| Live progress from outside | `events.jsonl`, no text deltas | none | poll the `.json` mirror | SSE |
| Lifecycle states | run + mission + gate verdicts | 7, incl. `steered`/`aborted`/`stopped` | 4, and `killKind` is dropped | **5 enums that disagree with each other** |
| Nesting | surfaced | **hidden by contract** | none, flat | declared, flat in practice |
| Progress percentage | none | none | none | none |
| Cost accounting | full | **two totals that do not derive from each other** | full, agent tasks only | **declared and never populated** |

They agree on more than they disagree, and the agreements are what to build on.

### What all four already do

**One serializable snapshot per unit of work, pushed on change.**
`pi-background-tasks` funnels a single `BgTaskSnapshot` through three
transports — the on-disk `.json`, the event bus, and the message renderer's
`details`. Feynman does the same with a flat state object plus a small delta
union. That is the contract, independently invented twice.

**Nobody has a progress percentage.** Not one of the four. Shell work
genuinely has no notion of "how far along", and every one of them fakes
liveness some other way. So `progress` stays optional, and a panel without it
gets no bar rather than a fake one.

**Everybody loses the reason.** `pi-background-tasks` tracks
`killKind: 'user' | 'timeout' | 'output_cap' | 'shutdown'` internally and
drops it from the snapshot, so every stop renders as `killed`. Feynman widens
a nine-state Fusion machine to plain `string` at its boundary. tintinweb keeps
`steered`, `aborted` and `stopped` distinct in the record and lumps them as
`isError` on the wire. Losing *why* is the most common failure of all four.

### What the evidence changed in this contract

**Lifecycle and attention are different axes.** I had collapsed them.
tintinweb distinguishes `steered`, `aborted` and `stopped` from `error`, and
the five-colour vocabulary has nowhere to put them. The payload now carries a
`lifecycle`; the five states stay as the *derived* attention signal that
drives the dot. The vocabulary stops pretending to be the data model.

**Usage is raw, never a total.** tintinweb carries two token views that
explicitly do not derive from each other — a display total excluding cache
reads, and a billing total including them. One `tokens` number is a lie in one
of the two. And `pi-background-tasks` has the best idea of the four:
`telemetryUnavailableReason`, which distinguishes *not measured* from *zero*.
Absent accounting is `null` with a reason, never `0`.

**Output is a stream, not a path.** `outputPath` is a path; everything good
about a live log — a bounded tail, follow and pause, scrollback — has to be
rebuilt by the host. The panel carries a read reference plus
`outputBytes`, which for a non-agent task is the *only* liveness signal there
is.

**The host keeps a short history per panel.** `pi-background-tasks` shows
`+12 KB ↑` throughput, computed in its view layer from successive
`bytesWritten` samples. A host that renders one snapshot in isolation shows
nothing. So the panel store retains a small ring of recent snapshots and
derives velocity itself.

**Phase is not progress.** Fusion has nine ordered states, workflows have
phases, plans have steps. That is a stepper, not a bar, and it needs its own
optional field.

**Delivery is at-least-once, so dedupe by id.** `pi-background-tasks`
documents this explicitly for its terminal event.

**Probe capabilities, never versions.** nicobailon's `ping` returns its method
list. tintinweb's `PROTOCOL_VERSION = 2` is documented by its own author as
nearly meaningless, because stop's ownership check, model resolution and the
entire `consume` channel all shipped without a bump. Adapters ask what works,
not what version it is. And a session that filtered an extension out is
indistinguishable from that extension not being installed, so discovery always
has a timeout.

### The fourth way a panel arrives

Feynman is not a plugin — it is a peer application with a local HTTP API. So
alongside our adapters, the declared protocol and the fallback, there is a
**local service adapter**: piorbit renders another tool's runs and plans as
panels by talking to its API. That is how piorbit stays a citizen of an
ecosystem where not everything is an extension.

### The `run` payload

The shape all four fit through, revised against them:

```ts
type RunPanel = {
  kind: "run";
  id: string;                      // stable; re-emit to update in place
  source: string;                  // extension or service id — always a badge
  title: string;                   // "worker#2", "pnpm test"
  handle?: string;                 // human address, e.g. "@auth-audit"

  lifecycle: "queued" | "running" | "paused" | "done" | "failed" | "cancelled";
  terminalReason?: string;         // "timeout", "output cap", "you stopped it"
  attention?: Attention;           // derived by the adapter; the dot reads this

  activity?: string;               // one line, the agent's own words
  phase?: { label: string; index?: number; total?: number };
  progress?: { done: number; total: number } | "indeterminate";

  origin?: string;                 // who started it
  parent?: { id: string; relation: "spawned-by" | "step-of" };
  requested?: { model?: string; thinking?: string };   // vs. what it got
  model?: string;

  startedAt?: string;
  endedAt?: string;

  usage?: {
    input?: number; output?: number; cacheRead?: number; cacheWrite?: number;
    costUsd?: number | null;
    unavailableReason?: string;    // why there are no numbers
  } | null;

  output?: { ref: string; bytes?: number };            // read through the host
  artifacts?: Array<{ label: string; ref: string }>;

  actions?: Array<{ id: string; label: string; confirm?: string; destructive?: boolean }>;
  error?: string;
};
```

Omitted fields render as nothing. `null` usage renders as "not measured",
which is a different thing from zero.

### Three things that will not unify

Honesty about the limits of the test:

1. **Child visibility.** tintinweb hides nested and workflow-owned children by
   contract — they emit no events and appear on no surface. nicobailon
   surfaces them. Rendering both identically means deciding whether hidden
   means absent or collapsed, and the answer differs per package.
2. **Progress granularity.** None of the four gives streaming text out of
   process. A detached run is message-granular at best.
3. **Workflow interiors.** tintinweb's phase log is rich and in-memory only;
   nicobailon persists no graph at all. Rendering both identically means
   rendering the poorer of the two, or writing two adapters and accepting they
   differ in depth.

## The rules

**R1 · One status vocabulary.** The five states in `DESIGN.md` — working,
waiting for you, error, finished-unread, idle — apply to panels, runs,
sessions and projects identically. A container's status is the
highest-attention status it contains. No new colours, ever.

**R2 · Capability honesty.** A control appears only if it actually works
here. A background subagent can be steered by writing its control inbox; a
foreground child cannot be touched at all; a nested child takes only
interrupt and resume. Hide the control, do not disable it, and put the reason
in a tooltip where it would have been.

**R3 · Provenance honesty.** Anything inferred is marked. Workflow edges
reconstructed from trace timestamps are dashed and labelled `inferred`, because
scripted workflows persist no graph. Never present a guess as a fact.

**R4 · Fidelity honesty.** Detached runs emit no text deltas, so they show
whole messages with an `updates in bursts` note rather than faking a
typewriter.

**R5 · Attention flows up.** A `decision` panel deep in a child lights its
run, its tab, its session row, its project ring and the fleet pill. You find
what needs you by walking down the attention.

**R6 · One panel, one identity.** A panel has a stable id and updates in
place. Re-emitting must never stack duplicates, and moving between surfaces
must never lose scroll position or state.

**R7 · Nothing vanishes silently.** Evicted from the dock, pruned by
retention, closed by its extension — the panel bar says which. Never an empty
space where something was.

**R8 · Cost is visible wherever work is spawned.** Fan-out is how surprise
bills happen. Every `run` and `plan` panel carries tokens and cost.

**R9 · Deduplicate by id; delivery is at-least-once.** `pi-background-tasks`
documents this for its terminal event, and any file watcher will re-read a
snapshot it already has. A panel arriving twice is normal, not an error.

**R10 · Replace by index, never append.** Workflow progress logs are
append-only streams collapsed by a stable index. A host that appends rows
instead of replacing them double-counts tokens — tintinweb's code warns about
exactly this.

**R11 · Probe capabilities, never versions.** Ask what works. tintinweb's own
docs call its protocol version nearly meaningless because four behaviours
shipped without a bump. And a session that filtered an extension out looks
exactly like that extension being absent, so discovery always has a timeout.

**R12 · Consume results promptly.** An extension may hold a completion open
waiting for someone to take the result. tintinweb's window is 200 ms, after
which the parent is charged a whole turn. Rendering a result and consuming it
later is a bug that costs the user money.

## What this buys, and what it costs

Buys: every extension looks like piorbit. A new community package gets a
designed surface for free, and a package that opts into the contract gets a
native one. We can redesign the whole app without touching a single
extension.

Costs: six kinds will not fit everything, and the pressure to add a seventh
will be constant. We render less than some extensions could express. And we
carry adapters for packages that do not know we exist.

## Open questions — these need your call

1. **Are six kinds the right six?** The candidates I dropped were `metric`
   (folded into the telemetry rail) and `embed` (a browser pane, out of scope).
   *Lean: six, and treat a seventh as a real decision.*
2. **Two dock panes, or three?** Claude Code uses two. *Lean: two, with LRU
   eviction and the panel bar as the overflow.*
3. **Does the dock auto-open?** A long bash could promote itself to `follow`
   without asking. *Lean: no auto-open on the first one; a panel asks by
   pulsing in the panel bar, and you promote it. Auto-open only for a
   `decision` that blocks the turn.*
4. **Do we ship the declared protocol in v1**, or only our own adapters?
   *Lean: ship it, document it, and use it ourselves for pi-subagents so it
   is proven by our own code rather than by a hypothetical.*
5. **Is the fallback good enough** that an unaware extension feels
   first-class, or does that undersell the contract? *Lean: good enough, and
   the gap is the incentive to adopt.*
6. **Where does the panel bar live** on desktop — a strip at the dock's top,
   or docked to the right edge like a rail? *Lean: a strip at the top of the
   dock, so it disappears entirely when nothing is open.*
7. **Does maximize hide the thread entirely, or split with it?** Full takeover
   is simpler and matches "I am doing this instead of the conversation".
   *Lean: full takeover, with `Esc` to return, because a half-maximized pane is
   just the split again.*

## Related

- [`docs/ux-agent-work.md`](ux-agent-work.md) — runs, plans and ledgers: the
  domain model behind the `run` and `plan` kinds.
- [`packages/ui/DESIGN.md`](../packages/ui/DESIGN.md) — the visual system these
  panels are drawn in.
