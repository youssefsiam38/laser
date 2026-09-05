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

Two ways a panel reaches piorbit.

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

**3. Fallback, so nothing regresses.** An extension that knows nothing about
piorbit still works exactly as well as today: its `setWidget` lines render as
a `stream` panel with monospace text, its `setStatus` as an ambient line, its
dialogs as `decision` panels. Adopting the contract is an upgrade, never a
requirement.

## The conformance test

A standard with one implementation is a description of that implementation.
The test is therefore:

> Install every Pi extension that does agent work — `pi-background-tasks`,
> `feynman`, `@tintinweb/pi-subagents`, `pi-subagents` — at the same time.
> All of them must render as `run` panels with the same shape, the same
> status vocabulary, the same controls in the same place, and the same
> keyboard path. Nothing about piorbit's chrome should reveal which extension
> produced which panel — except one deliberate badge saying which did.

Four independent implementations of "background agent work", built by people
who never coordinated, is the hardest input this contract will get. If the
`run` kind survives it, it will survive the fifth.

### What the test forces on the design

**Actions are data, not an enum.** One extension has stop and resume, another
has pause, another has steer and interrupt and consume. A fixed action enum
would be obsolete the moment a fifth extension appears. So `actions` is an
open list of `{ id, label, confirm?, destructive? }` and piorbit renders them
in a consistent place with consistent styling. piorbit knows *how a control
looks*; it does not need to know what the control means.

**Every adapter declares a state mapping.** Each extension has its own state
names — `queued`, `paused`, `blocked`, `awaiting-approval`, `settled`. The
adapter is responsible for mapping them into the five states in `DESIGN.md`,
and that mapping is part of the adapter, reviewed like code. Where a state
genuinely has no home, that is a finding about the vocabulary, not a licence
to invent a sixth colour.

**Progress is optional and typed.** Some extensions report `3 of 7 steps`,
some report a spinner, some report nothing. The schema carries
`progress?: { done, total } | "indeterminate"`, and a panel with no progress
simply has none — it does not get a fake bar.

**Cost is optional but never faked.** Only some track tokens and spend.
Absent means absent; the card shows no cost row rather than a zero.

**Provenance is always visible.** Same shape does not mean anonymous. Every
run panel carries a `source` badge naming the extension that produced it,
because "stop this task" must never stop the wrong thing, and because when
one extension misbehaves you need to know which to remove.

### The `run` payload

The shape all four must fit through:

```ts
type RunPanel = {
  kind: "run";
  id: string;                       // stable; re-emit to update in place
  source: string;                   // extension id — always shown as a badge
  title: string;                    // "worker#2", "build docs"
  status: "working" | "waiting_for_input" | "error" | "finished_unread" | "idle";
  activity?: string;                // one line, the agent's own words
  origin?: string;                  // who started it
  parentId?: string;                // nesting; the tab strip reads this
  startedAt?: string;
  endedAt?: string;
  progress?: { done: number; total: number } | "indeterminate";
  cost?: { tokens?: number; usd?: number };
  actions?: Array<{ id: string; label: string; confirm?: string; destructive?: boolean }>;
  error?: string;
};
```

Everything an extension cannot fill is omitted, and an omitted field renders
as nothing rather than as an empty state.

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
