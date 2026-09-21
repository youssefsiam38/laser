# Reading long conversations

The transcript has **one** geometric authority, and it is not Laser's: which
rows are mounted, where each one sits, and every scroll adjustment that
follows a prepend, a trim or a row changing size belong to `@legendapp/list`
(D-306, `docs/transcript-virtualization.md`). The list does not correct the
reader's position after content moves; it refuses to let content above the
reader move at all (`maintainVisibleContentPosition`).

`TranscriptViewport` owns what is Laser's — which conversation is on screen,
which rows are held open, where a destination is going, how much unloaded
history stands above the loaded rows, and whether the person is reading
history or riding the live edge — and writes no scroll position of its own.
The scroller carries `overflow-anchor: none` so the browser's own anchoring
never competes.

## The shape of the surface

```
thread-column                       no scrolling of its own
├── the conversation map's rail     absolute, zero height
├── the list                        data-slot="thread-viewport", the scroller
│   ├── header   the worker-recovery notice, the load/refresh error,
│   │            the history controls, then the unloaded-history placeholder
│   ├── rows     one per message, in normal chronological order, keyed by id
│   └── footer   a spacer exactly as tall as the composer
└── the composer                    absolute, over the bottom of the list
```

**The list is the thread's viewport.** A scrolling box around a scrolling list
is two authorities over the same pixels, so `ThreadPrimitive.Viewport` is not
part of this thread. The transcript publishes the list's own element as the
thread viewport's element and reports its height, so the conversation map, the
question notice and Find all reach the real scroller; and it reports whether
the newest turn is on screen, which is the one thing
`ThreadPrimitive.ScrollToBottom` reads to decide whether "Jump to latest"
exists. That button's own click is still `preventDefault`ed, so the only thing
that moves the transcript is the transcript.

**Everything above the conversation is the list's header**, including the two
notices that appear while a person is reading. Anything left above the list
pushes the reader down by exactly its own height, because it is not content
the list measures. Inside the header the same appearance is an ordinary size
change, and the list restores the reading position through it. The rule is
flat: nothing that can change height renders above the list.

Rows are positioned by the list, in the order of the conversation: never
`column-reverse`, never an inverted transform, so native selection, Find and
the reading order are the ones the browser expects. `keyExtractor` is the
message id, so a prepend never renumbers a row that has already been measured.
The conversation column — `max-w-(--measure-thread)` — lives inside each row,
the header and the footer, so the scrollbar rides the window's edge.

## What happens on a prepend

A page of older messages is a data change. The list captures the rows in view
and their positions, rebuilds the layout, and resolves the same rows' new
positions in the same pass, so the range rendered by that pass is already the
right one and the scroll position is already right for it. The reader's row
keeps its screen position to the pixel. Nothing of Laser's participates.

## When a measurement moves the reader

The list restores the row whose top is on screen. Three consequences:

- content **above** the reading line — a page still measuring, an image
  decoding, late syntax highlighting, a formula, a diagram, including all of
  those *inside the row the person is reading* — leaves their text exactly
  where it was. This is what D-303 could not do and what this milestone is
  for;
- content the person can see, in a row below their line, moves the content
  below it and nothing else;
- content growing **below the reading line inside the row they are halfway
  through** moves the view by that much. That is the one position this list
  does not hold, and `docs/transcript-virtualization.md` records why it is the
  better half of the trade. The two largest instances are gone: an image
  reserves its box before it decodes, and a fold is a person's own action,
  which is held.

## A fold the person toggles

The row that must not move when a disclosure opens or closes is the one they
clicked, not whichever row happens to be under the reading position. For as
long as the fold takes to measure, the transcript names that row through
`shouldRestorePosition`, turns size anchoring off so nothing below the fold
pulls the view, and suspends live follow.

It learns that a fold moved from `aria-expanded` on the control itself, which
is the one thing every disclosure in the transcript already has — its own
rows', a tool's, a reasoning block's. A keyboard activation of a button raises
the same click a pointer does, so both arrive by the same path and no
disclosure has to be taught to report itself.

## The live edge

Live follow is the list's (`maintainScrollAtEnd`), with the composer's inset
excluded on purpose: the spacer at the end of the list is exactly as tall as
the composer that floats over it, and a composer growing a line must not move
a message. The follow is animated only while a turn is streaming and
`prefers-reduced-motion` is off; a session switch and a layout settle are
instant, so nothing visibly travels.

Whether to follow at all is Laser's, and it is a mode rather than a
measurement: a person enters it by reaching the newest turn and leaves it by
scrolling away from it. Content arriving underneath a follower briefly makes
the distance to the end non-zero, and that must never read as the person
having walked away. A conversation opens at its newest turn, which is one
explicit placement owed until the layout actually lands there — the header is
still growing while the placeholder sizes itself from a viewport that did not
exist in the first commit. A gesture or a destination cancels that debt.

Maintenance is off while the reader is reading history, while a destination is
landing, and while a disclosure settles.

## The unloaded-history placeholder

Earlier history that has not arrived is drawn as conversation-shaped
placeholder turns inside the list's header: no words, no card, nothing sticky.
Each turn is exactly one nominal turn tall whether or not it has been painted,
so scrolling through the region never changes its height. The list measures
the region like any other content and restores the reading position through
it; nothing compensates for it by hand.

How many turns:

- the target is the producer's count of unloaded prompts, bounded to three
  screens (D-302). A producer that says zero or one prompt is saying
  "unknown" — one tool-heavy prompt can be a page of rows — so that case
  counts as two turns, not none;
- an arriving page takes the turns it replaced, from the bottom of the region,
  because that is where the rows belong. How many it replaced is the drop in
  the producer's count, **or one turn, whichever is larger, whenever rows
  really did arrive at the front.** The count is the producer's and the region
  may not depend on it alone: a page that did not move it would leave the
  placeholder never yielding and continuous paging asking for ever;
- **except the turns the person is looking at.** While the reading position is
  in the region, only turns below the fold are given back;
- the region grows back to its bounded size only where growth cannot be felt:
  at the live edge, or with the whole region at least a screen above the
  reading position. A screen, not a pixel: a page arriving resizes the region
  and moves the scroll in the same commit, and for part of that commit the
  region's own box is somewhere neither it nor the person will be when the
  commit ends. Growth is permanent; a transient may not ask for it;
- one turn always remains while the producer still has a cursor, because the
  region is also the only thing on screen that says "this is not the
  beginning". It disappears entirely when the cursor does.

What the person sees while a page arrives: the rows they already had do not
move, and the history they are scrolling towards arrives in the grey they are
looking at. A page cannot appear *between* them and a row they were already
reading. Continuous paging belongs to the history controls and does not wait
for a gesture: on landing, and whenever the unloaded reserve is within two
screens of the reading position, each accepted page asks for the next one until
two screens of real rows stand above the reader, the transcript reaches its
root, or the budget for this reading position is spent. That budget — sixteen
pages or four megabytes — is cumulative across every burst chained from one
place, not a per-burst yield: spent, the transcript stops, and it re-arms only
when the person actually moves (a wheel, a swipe, a key, a scrollbar drag, a
resize, or the explicit control). A page that returns only a couple of rows is
a normal split turn and does not stop the chain; a chain of them cannot walk a
whole conversation from the landing. Pages are awaited in sequence, never in
parallel. `history-loader.ts` asks for turn windows (`HISTORY_FIRST_PAGE_TURNS`
on the first page, `HISTORY_EARLIER_PAGE_TURNS` earlier).

## Destinations

A deep link, a search hit, the map, a question inside a tool row, Edit/Fork/Jump
and Tab into a row the window had released all go through `ensureVisible`,
which uses the list's own `scrollToIndex` to land and then its `scrollToOffset`
to place the exact block — a text range, a tool call — a third of the way down.
The destination row is held mounted while it is the target.

A gesture the person makes ends a destination, because the row they were being
taken to is no longer where they are going. A gesture that cannot move
anything is not one: a wheel down at the bottom of the conversation, a tap that
never becomes a drag, Space at the end.

## Held rows

The mounted window is the list's reading window plus the rows a surface is
holding open, handed to it as `alwaysRender.keys`: an edit, an expanded
request, the focused row, a destination on its way, and every row inside a
native selection, which stays whole because the browser owns it and a released
row would truncate it. Explicit Select All is still the documented temporary
all-loaded-DOM exception.

A pin is not a scroll, so nothing about it would make the list look at its data
again; `dataVersion` carries the pinned set for exactly that reason. Releasing
a pin ends the hold, not the row's mounting: the list owns a bounded pool of
rows and gives that one back when it needs the container.

The same rows are published for the view cache (RP-5b): the row under the
reading position, the focused row and the pinned ones, so releasing the older
part of a conversation never pulls one out from under a person.

## What the person sees

Nothing. A page replaces placeholder pixels with real rows where they were, so
arriving history is not work the person watches. The only visible sign is a
page that is late: longer than one `--motion-slow` step while the person is
inside the region shows the loader's matrix at the viewport's top edge, without
copy, until it arrives. A screen reader hears one `sr-only` status from the
history controls, and the transcript region is `aria-busy` while a page is in
flight. The refusal state is the one case with text and a button, because the
person has to act.

## When the base is refused

A compaction or a branch can move the conversation past the base a window is
holding. The producer then refuses its earlier pages, and `history.refusal`
carries the sentence for the person. A background refresh — the re-read at the
end of a turn — is never that case: nobody asked for a page, so when the
producer cannot prove a suffix against the base this window holds, the refresh
installs nothing and refuses nothing. The held window, its cursor and the row
under the eye stay exactly as they were; live updates keep arriving through the
stream; and the first page the person then asks for that the stale base cannot
serve is answered with the refusal below, at the moment they ask. The
transcript keeps every row it has;
upward reading stops asking the question that was just refused; and the history
controls replace "Load earlier messages" with that sentence and one action,
"Reload recent messages", which performs the bounded current-tail re-read. The
accepted window carries no refusal, so the ordinary control returns by itself.

## What acceptance measures

`packages/ui/test/thread/transcript-virtualization.test.tsx` and
`transcript-position.test.tsx` mount the real transcript over a rig that is the
browser's half of the contract (`virtual-rig.tsx`): a real scroller with a real
`scrollTop`, boxes walked from the DOM the list produced, row heights from the
fixture whatever the list guessed, and `ResizeObserver` deliveries in one place
the test drives. They measure the pixels a person would see, never the
controller's opinion of them.

`scripts/browser-check/test/scroll-up-repeat.mjs` reads geometry from the DOM
in a real browser: between settle samples the row the reader is on may not move
by more than one pixel, upward reading may not end at the live edge, and
`scrollTop` 0 is only reached when no earlier history is claimed. It no longer
attributes scroll writes to their caller — with the list owning every
adjustment that follows a data or measurement change, there is no Laser writer
left to attribute.

One thing a headless DOM cannot give this surface: the list mounts rows only
once its scroller has been laid out, because a scroller with no box is a
surface nobody can read. `packages/ui/test/list-layout.ts` gives that one
element a window-sized box for the suites that render the real thread, and
nothing else in the document a geometry it did not ask for.

## Live activity and disclosure

Nothing in this surface depends on what kind of conversation it is showing: a
plain Chat (`sessionKind: "chat"`, no definition, no project) and a project
session are the same transcript, with the same geometry, the same rows and the
same reading rules. The one difference is outside the list: a Chat's
`SessionAgentInfo` has no `agentName`, so the chrome around the transcript has
no agent label to draw.

- assistant-ui treats a tool's `result` as terminal, even when the message is
  still running. Keep partial output in its UI-only `artifact` channel and
  reserve `result` for `tool_execution_end`; never trade live status for output.
- The default `GroupedParts` indicator also appears after tool calls. Our
  transcript uses `indicator="empty"`, with neutral waiting copy; actual
  reasoning and running tools own their row's travelling light (`ActivityBeam`
  in `thinking-indicator.tsx`, `.activity-beam` in `globals.css`: a drawing,
  not an assistant). Test with partial output, not only a resultless tool, and
  verify both aggregate and child status.
- Batch disclosure changes anchor visible content through the animation.
  Start the animation window after React commits, not at the menu click: a
  large history can take longer to render than the animation itself.
- Activity disclosures require interaction tests, not just summary/string tests.
  Reasoning is an independently collapsible action, not a static heading inside
  the aggregate. Share the activity row tokens across reasoning and tools; never
  invent a token name without a theme mapping (`surface-1` is not a token).
  Manual toggles override default-open preferences, including waiting tools;
  approval footers remain outside the fold. Verify pointer and keyboard toggles
  after viewport restoration settles, and check that collapsed bodies really hide.
