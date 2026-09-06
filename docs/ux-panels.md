# The panel contract — how anything renders in laser

Status: **decided 2026-09-05 (D-18).** Binding on every surface, as
`packages/ui/DESIGN.md` is. Every open question below was resolved to its
stated lean; the questions are kept as the record of what was weighed.

## The thesis

**Pi owns the logic. laser owns the experience.**

Pi deliberately ships almost nothing: no MCP, no subagents, no plan mode, no
todos, no background bash. Everything is an extension, and every extension
invents its own presentation. In a terminal that is fine, because the only
surface is lines of text. In a GUI it is a disaster: five extensions doing
structurally similar things — a list of results, a running job, a document —
would each render differently, and the app would look like five apps.

So laser does not pass presentation through. Extensions declare **what they
have**; laser decides **how it looks and where it goes**. An extension
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
| **Ambient** | one line directly above the composer, on every width | state you glance at |
| **Inline** | a card in the transcript, at the point it happened | the result of a tool call you just watched |
| **Dock** | the right side: one canvas, two stacked rows, or a readable 2×2 grid | something you want to keep watching while you keep working |
| **Sheet** | overlay, focused, dismissible | something you are doing *instead of* the conversation |

The dock holds at most two **expanded** islands per column, never three. A
third does not evict anything — it shrinks the least recently watched one to
minimal, where it keeps ticking. Nothing is ever parked in a drawer, because
there is no drawer: minimal is a size, not a storage location.

**The dock grows with the window (D-20, D-65).** It is resizable by dragging
its edge. Occupancy chooses the active grid: one expanded island fills the
whole dock; two split it into full-width top and bottom rows; three or four use
a stable 2×2 grid once the dock is wide enough for two readable columns. A
narrow dock keeps one column rather than violating the legibility floor.

**Every expanded island can pop out (D-20).** Its header carries three
controls in a fixed order: pop out, maximize, close. Pop out opens the panel
in its own window on desktop and its own tab on the web, keeping identity and
state (R6); the island in the dock shrinks to minimal and points at where it
went.

### Panels are islands, not boxes

The mental model is Apple's Dynamic Island rather than a set of window
panes. There is **one element per panel** that grows and shrinks through four
sizes, keeping its identity, position and state the whole way. It is never
destroyed and re-created at a different size, and it never becomes a
different kind of object on the way. **One exception, recorded (D-34):** on a
phone, opening an island into the bottom sheet does re-create it, because the
expanded island's DOM has to live inside the sheet. Everywhere else — every
size change in the dock, including maximize — it is one element for life.

Three consequences, and they are the whole difference from a pane system:

1. **The minimal state is live, not a bookmark.** A collapsed island is not a
   tab waiting to be reopened. It shows its status dot, its elapsed time
   ticking, and a progress arc when there is one. You should be able to leave
   everything collapsed and still know what is happening — that is the point
   of the shape.
2. **The morph is the motion.** This is where an animation earns its place:
   the same element changing size, not a panel fading out and another fading
   in. It is one of the few motions in the app for exactly that reason.
3. **Position is fixed so your eye learns it.** Islands always live at the
   top of the dock, in creation order, and they do not reshuffle when one
   grows. On a phone they live directly above the composer.

Two islands can be compact side by side, the way the Dynamic Island holds a
leading and a trailing activity, which is the same constraint as the
two-pane dock seen from the other end.

### The four sizes

Every island is in exactly one of these, and moves between them by growing:

| State | What it looks like | How you get there |
| --- | --- | --- |
| **Minimal** | a pill: dot, name, one live number | it is not being watched right now |
| **Compact** | a header row with live state, no body | you collapsed it, or two others are expanded |
| **Expanded** | full content, alone or in a split with a draggable divider | you are watching it |
| **Maximized** | the whole window; rail, thread and dock hidden | the maximize control, or double-click the header |

Rules for the geometry:

- **Expanded-alone is the default, not a degraded split.** One island gets the
  whole dock. The split exists only when two things are genuinely being
  watched.
- **Empty cells reserve no space.** Two watched islands are stacked across the
  full width. The third activates the 2×2 grid and leaves one honest empty
  quadrant until the fourth fills it.
- **Minimal still carries information.** Never a bare label. A run shows
  elapsed time, a stream shows bytes, a plan shows steps done. If a kind has
  no live number, it does not belong in the dock at all.
- **The divider is draggable and remembered per session**, snapping to a
  50/50 midpoint. A pane never shrinks below its header.
- **Maximize is reversible and never destructive.** `Esc` restores, the
  underlying conversation keeps streaming, and the panel returns to exactly
  the pane and scroll position it left.
- **Collapse is how you keep something without paying for it.** A collapsed
  pane still shows its status dot and title, so a collapsed run that starts
  waiting for you still lights up (R5).
- On a phone the island sits above the composer: minimal by default, tapping
  it expands to a sheet. Same component, same four sizes, less room — and the
  one place a panel is re-created rather than morphed (D-34).


### The legibility floor

An island shrinks by **dropping content, never by shrinking type**. This is
the constraint that makes the four sizes real rather than decorative, and it
is not negotiable.

**Type never goes below 12px for information.** The 11px size in `DESIGN.md`
is permitted only for an uppercase eyebrow with `0.08em` tracking — a
category label, never a value. No panel, at any size, on any device, renders
data smaller than 12px. If something does not fit at 12px, it does not fit.

**Each size has a fixed content budget.** The budget is the design; fitting
more is not an option that exists.

| Size | What it may contain | Height |
| --- | --- | --- |
| Minimal | status dot · name · **exactly one** live value | 28px |
| Compact | status dot · name · up to **three** values · one action, rest in a menu | 36px |
| Expanded | everything, with its own internal scroll | fills its share |
| Maximized | everything | the window |

**Truncate, never scale.** A long name ends in an ellipsis at a fixed width,
with the full text in the accessible name and the tooltip. Nothing is ever
condensed, letter-spaced tighter, or scaled down to make it fit.

**Nothing overflows its container, ever.** The page body never scrolls
sideways. Wide content inside an expanded island — a table, a code block, a
diagram, a diff — gets its own `overflow-x: auto` container and scrolls
within itself. A minimal island that would exceed its max width truncates its
name; it does not grow, and it does not clip.

**Minimal islands wrap, they do not scroll.** More islands than fit the width
wrap to a second row. Past two rows, and only then, the remainder collapses
into a single `+N` island that opens the full list. A horizontally scrolling
strip of live indicators is a strip you stop reading.

**Touch targets stay 44px** on coarse pointers even when the island is 28px
tall: the hit area extends beyond the visible pill rather than the pill
growing.

## Placement is laser's decision, not the extension's

An extension declares a **kind** and an **intent**. laser maps that, plus
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

Four ways a panel reaches laser.

**1. Adapters we write.** Our companion extension already has a module per
supported package. A module translates that package's private world into
panels: pi-subagents children become `run` panels, its workflows become
`plan` panels. A former pi-web-access collection adapter was retired by D-61
because it duplicated the complete tool disclosure in the transcript. The
community package stays untouched and unaware.

**2. A declared protocol, for extensions that want to opt in.** Namespaced on
Pi's event bus, so a terminal Pi ignores it and nothing breaks:

```ts
pi.events.emit("laser:panel", {
  v: 1,
  id: "package:index:42",            // stable; re-emit to update in place
  kind: "collection",
  intent: "inline",
  title: "8 matching items",
  data: { items: [{ primary, secondary, meta }] }, // strict JSON, kind-specific
  actions: [{ id: "open", label: "Open" }],     // laser renders the controls
});
```

laser answers on `laser:panel:action` with `{ id, actionId, value }`.
`laser:panel:close` retires a panel. That is the whole API.

The rule that makes it work: **the payload is data, never presentation.** No
HTML, no class names, no colours, no widths. An extension that wants a
different look is asking for a new `kind`, which is a conversation.

**3. A local service adapter.** Not everything in this ecosystem is an
extension. `feynman` bundles Pi and ships its own HTTP server with an SSE
stream; laser renders its runs and plans as panels by talking to that API,
loading nothing into Pi at all. Any peer tool with a local API can be adapted
the same way.

**4. Fallback, so nothing regresses.** An extension that knows nothing about
laser still works exactly as well as today: its `setWidget` lines render as
a `stream` panel with monospace text, its `setStatus` as an ambient line, its
dialogs as `decision` panels. Adopting the contract is an upgrade, never a
requirement.

## The multi-implementation lens

A standard with one implementation is a description of that implementation.
So every panel kind is designed against **imagined competing
implementations** — three or four independent ways someone might build the
same thing — and the payload keeps only what survives all of them.

This is a design lens, not a support commitment. laser does not promise to
ship an adapter for every package below. Their value is that they are real,
they disagree, and designing against that disagreement is what keeps an
adapter interface flexible enough to absorb the fifth implementation nobody
has written yet.

The lens was calibrated on `run`, where four real implementations exist and
could be read:

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

They agree on more than they disagree, and the agreements are what to build
on. Every other kind below gets the same treatment, from imagined
implementations rather than read ones.

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
**local service adapter**: laser renders another tool's runs and plans as
panels by talking to its API. That is how laser stays a citizen of an
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
  phase?: { label: string; index?: number; total?: number };   // index is 1-based
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


## The other five kinds, under the same lens

Each payload below is designed against three or four ways someone might
implement that kind. The recurring answer is the same every time: **adapters
carry references and generic shapes, never domain values.** The moment a
payload names something from one producer's world, the second producer does
not fit.

### `document` — something you read

Imagined implementations: a markdown preview, a research report with
versions and provenance, a unified diff from an edit tool, a rendered image,
a PDF, a chart.

What varies, and therefore what the payload must not assume:

- **Where the content is.** Inline for a small markdown string, a file path
  for a preview, a generated blob for a chart. So content is a `ref` the host
  reads, with inline as an optimisation for small text — never the only form.
- **Who renders it.** We render markdown, diffs and images. We cannot render
  a protein structure or a genome track, and pretending otherwise produces
  garbage. So `renderable` is explicit and unknown types degrade to "open
  externally" rather than to a broken viewer.
- **Whether it changes.** Static, updated in place, or versioned with
  lineage. `version` is optional, and its absence means "not versioned",
  not "version 1".

```ts
type DocumentPanel = {
  kind: "document";
  id: string; source: string; title: string;
  mediaType: string;                       // "text/markdown", "text/x-diff", "image/png"
  content?: { ref: string } | { inline: string };
  renderable: boolean;                     // false → offer to open, do not guess
  version?: { label: string; previousRef?: string };
  path?: string;                           // where it lives, if it lives somewhere
  actions?: Action[];
};
```

### `stream` — append-only output

Imagined implementations: shell stdout, a build log, the provider request
log, a tail of a detached agent's transcript.

- **Framing differs**: raw text, ANSI-coloured text, or JSONL records. A host
  that assumes one mangles the others, so `encoding` is required. ANSI is the
  sharp one — `pi-background-tasks` pre-renders colour into its status string,
  so a host must either interpret the escapes or strip them, and silently
  passing them through is the wrong third option.
- **Reads are bounded, always.** A stream can be gigabytes. The host reads
  ranges, and the panel says how big it is so far.
- **Truncation is stated, not implied.** Rotated, capped, or head-only, the
  panel says which.

```ts
type StreamPanel = {
  kind: "stream";
  id: string; source: string; title: string;
  encoding: "text" | "ansi" | "jsonl";
  ref: string;                             // host reads ranges from this
  bytes?: number;                          // also the liveness signal
  truncated?: "head" | "tail" | "rotated";
  follow?: boolean;                        // is it still being written
  actions?: Action[];
};
```

### `collection` — a set of found things

Imagined implementations: web search results, grep hits, a file list, model
or package lists, citations.

Their item shapes have nothing in common — `{title, url, snippet}` versus
`{path, line, text}` versus `{name, version, downloads}`. So the payload
carries a **generic row**, and the producer decides what goes in each slot:

```ts
type CollectionPanel = {
  kind: "collection";
  id: string; source: string; title: string;
  layout?: "list" | "table";
  items: Array<{
    id: string;
    primary: string;                       // the line you read first
    secondary?: string;                    // context under it
    meta?: Array<{ label: string; value: string }>;   // columns, when tabular
    ref?: string;                          // opens a document panel
    actions?: Action[];
  }>;
  total?: number; cursor?: string;         // paginated, if it is
};
```

A per-domain schema here would have been the easiest mistake to make and the
hardest to undo.

### `decision` — something blocking on you

Imagined implementations: Pi's four dialogs, a tool approval with scope
options, a plan awaiting approval, a permission grant, a multi-field
elicitation form.

- **Cardinality varies.** One question or a whole form. So `fields[]`, and a
  single question is a form with one field rather than a special case.
- **Blocking scope varies**, and it decides placement: a tool approval blocks
  one tool row, a plan approval blocks a turn, a credential prompt blocks
  everything. Only the last earns a sheet.
- **Rejection needs somewhere to go.** Our rule is that "No" is never a dead
  end, so the payload carries the field that opens when you decline.

```ts
type DecisionPanel = {
  kind: "decision";
  id: string; source: string; title: string; message?: string;
  blocking: "tool" | "turn" | "session";
  toolCallId?: string;                     // renders inside that tool row
  fields: Array<{
    id: string; label: string;
    type: "choice" | "text" | "longtext" | "confirm";
    options?: string[]; default?: string; required?: boolean;
  }>;
  rejection?: { label: string; field: string };   // "No" opens this
  timeoutMs?: number;
};
```

### `plan` — intended structure over several steps

Imagined implementations: workflow phases, a mission with an objective, a
todo list, an agent plan with approval, a scripted run whose shape we
inferred.

- **Structure varies from flat to phased to a graph.** The payload is
  phase-ordered steps, because that is the shape all of them can express;
  declared dependencies are optional edges on top.
- **Steps may or may not be runs.** When a step is a real run, it links to
  that panel rather than duplicating its state.
- **The plan itself may need approval**, which is a `decision`, not a new
  concept.

```ts
type PlanPanel = {
  kind: "plan";
  id: string; source: string; title: string; objective?: string;
  inferred?: boolean;                      // rebuilt from traces, drawn dashed
  steps: Array<{
    id: string; label: string; phase?: string;
    state: "pending" | "running" | "done" | "failed" | "skipped" | "blocked";
    runId?: string;                        // link, never a copy
    dependsOn?: string[];                  // only when declared
  }>;
  approval?: { decisionId: string };
  usage?: Usage | null;
};
```

### The shared vocabulary

Three types appear in every kind, and defining them once is most of what
makes the adapters flexible:

```ts
type Action = { id: string; label: string; confirm?: string; destructive?: boolean };
type Usage  = { input?: number; output?: number; cacheRead?: number; cacheWrite?: number;
                costUsd?: number | null; unavailableReason?: string };
type Ref    = string;   // opaque; the host reads it, ranges and all
```

`Action` is why a fifth implementation with a verb we have never seen still
renders. `Usage` is why "not measured" and "zero" stay different. `Ref` is why
no payload ever carries a megabyte.

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

**R7 · Nothing vanishes silently, and nothing is parked.** An island shrinks
to minimal, it is never filed away. When one genuinely ends — pruned by
retention, closed by its extension — it says which as it goes. Never an empty
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

**R13 · Shrink by dropping content, never by shrinking type.** No data below
12px anywhere, at any size, on any device. Each size has a fixed content
budget; a long value truncates with the full text in the tooltip. Nothing
overflows its container and the body never scrolls sideways.

**R12a · Adapters carry references and generic shapes, never domain values.**
The moment a payload names something from one producer's world — a URL field
on a search result, a line number on a hit — the second producer does not fit.
Rows have `primary` and `secondary`; content has a `ref`; verbs have an `id`
and a `label`. This is the rule the other eleven exist to serve.

**R12 · Consume results promptly.** An extension may hold a completion open
waiting for someone to take the result. tintinweb's window is 200 ms, after
which the parent is charged a whole turn. Rendering a result and consuming it
later is a bug that costs the user money.

## What this buys, and what it costs

Buys: every extension looks like laser. A new community package gets a
designed surface for free, and a package that opts into the contract gets a
native one. We can redesign the whole app without touching a single
extension.

Costs: six kinds will not fit everything, and the pressure to add a seventh
will be constant. We render less than some extensions could express. And we
carry adapters for packages that do not know we exist.

## Decisions (each resolved to its lean, D-18)

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
6. **Do minimal islands stack vertically or run as a horizontal strip** at the
   top of the dock? *Lean: horizontal while there are few, wrapping to a
   second row before ever scrolling, so position stays learnable.*
7. **Does maximize hide the thread entirely, or split with it?** Full takeover
   is simpler and matches "I am doing this instead of the conversation".
   *Lean: full takeover, with `Esc` to return, because a half-maximized pane is
   just the split again.*

## Related

- [`docs/ux-agent-work.md`](ux-agent-work.md) — runs, plans and ledgers: the
  domain model behind the `run` and `plan` kinds.
- [`packages/ui/DESIGN.md`](../packages/ui/DESIGN.md) — the visual system these
  panels are drawn in.

## Implementation map

Where the contract lives in code (lane P, wave 2). Paths are relative to the repo root.

| Piece | File | Notes |
| --- | --- | --- |
| Payload types (`RunPanel`, `PlanPanel`, `DocumentPanel`, `StreamPanel`, `CollectionPanel`, `DecisionPanel`, `Action`, `PanelUsage`, `Ref`, `PanelIntent`, `Attention`) | `packages/protocol/src/panels.ts` | `Usage` is exported as `PanelUsage` (messages.ts already owns a `Usage`). `attentionOf` / `highestAttention` are R1; `refsOf` is what the host grants reads for. |
| Bus protocol constants and event shapes (`laser:panel`, `laser:panel:close`, `laser:panel:action`) | `packages/protocol/src/panels.ts` | `DEFAULT_INTENT` fills a missing `intent` per kind. |
| Wire: `pi/panel/upsert`, `pi/panel/close` (host → client), `pi/panel/action`, `pi/panel/read`, `pi/panel/list` (client → host) | `packages/protocol/src/panels.ts` (module augmentation of `ClientRequests` / `HostNotifications`), schemas in `packages/protocol/src/schemas.ts` | `panelSchema` is strict at every level; `validatePanelEvent` refuses presentation keys (`PRESENTATION_KEYS`) anywhere in `data` and names the field. |
| Companion module (declared protocol on Pi's bus) | `packages/pi-extension/src/modules/panels.ts` | Validates, dedupes identical re-emits (R9), forwards as `laser/panel/upsert` / `laser/panel/close`; replays `pi/panel/action` on `laser:panel:action` through the module `CommandBus` (`modules/index.ts`). |
| Host: panel memory, ref grants, ranged reads, attention | `packages/host/src/panels/{store,refs,hub}.ts` | `PanelHub.observeExtensionMessage` turns extension messages into broadcasts; `list` and `read` answer the router; a blocking `decision` raises attention like a dialog (R5). Only refs a panel carried are readable. |
| Fallback (`setWidget` → `stream`, `setStatus` → ambient, dialogs → `decision`) | `packages/ui/src/panels/fallback.ts` | Derived client-side from the `pi/ui/*` stream; ids are `ui:*` and answer through `pi/ui/response`. |
| Panel store (entries, liveness ring, velocity, seen, closed notices, reconcile) | `packages/ui/src/panels/store.ts` | Pure. Tested in `packages/ui/test/panels/store.test.ts`. |
| Placement table (kind × intent × viewport → surface) | `packages/ui/src/panels/placement.ts` | Pure; the table is the test in `test/panels/placement.test.ts`. A placement carries `via`, so `inspect` and a phone's `follow` — which both read `sheet` — are told apart. |
| The inline surface, and the sheet `inspect` opens | `packages/ui/src/panels/InlinePanels.tsx` | `PanelInlineCards` sits at the tail of the transcript; `PanelInspectSheet` opens once per panel. Both draw the island's own bodies (`PanelBody`). |
| A `decision` in its tool row | `packages/ui/src/panels/DecisionSurfaces.tsx` (`PanelToolDecision`), rows register in `packages/ui/src/panels/tool-rows.ts` | The tool-row column is only chosen while that row is on screen; otherwise the question falls back to the card. |
| Dock geometry (four sizes, occupancy-aware 1/2/3/4 grid, LRU shrink, dividers, maximize, pop out, dismiss) | `packages/ui/src/panels/dock-state.ts`, layout in `packages/ui/src/panels/layout.ts` | Pure; tested in `test/panels/dock-state.test.ts`. Width sets readable column capacity; occupancy activates it. `stripBudget` is shared with the phone's strip so both fold into `+N` at the same place. |
| ANSI interpreter | `packages/ui/src/panels/ansi.ts` | SGR → spans, everything else stripped; tested. |
| The island (one element, four sizes, morph, bodies per kind) | `packages/ui/src/panels/islands/Island.tsx`, `islands/bodies/*.tsx`, `islands/ActionButtons.tsx` | One header for all four sizes, so the dot, the title and the controls keep their identity through a morph. Document and diff rendering lives in `components/preview/*`. Live values per size budget in `panels/values.ts`; ranged reads in `panels/read.ts`. |
| The dock | `packages/ui/src/components/dock/Dock.tsx` | Mounted by `Shell.tsx` right of the thread on tablet and desktop. |
| Ambient (fleet pill, glance panels, statuses) | `packages/ui/src/panels/Ambient.tsx` | Fills the status line's trailing slot: `<Thread statusSlot={<PanelAmbient />} />`. |
| Decision surfaces (cards above the composer, session-blocking sheet) | `packages/ui/src/panels/DecisionSurfaces.tsx` | `PanelDecisionCards` goes in the thread footer; `PanelDecisionSheet` in the shell. |
| Phone islands (pills above the composer, sheet on tap) | `packages/ui/src/panels/MobileIslands.tsx` | Goes in the thread footer, above the composer. |
| Popped-out panel page | `packages/ui/src/panels/PoppedOut.tsx` | `#/panel/<path>/<id>`, routed by `Shell.tsx`; announces itself on the `laser-panels` BroadcastChannel. |
| Provider and hooks | `packages/ui/src/panels/PanelsProvider.tsx` | `PanelsProvider`, `usePanelsState`, `usePanelActions`, `usePanelEntries`, `useIslandEntries`, `useDock`. |
