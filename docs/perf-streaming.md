# M16-T32 — streaming touches only the streaming row

What a streamed token costs the renderer, measured in the browser rather than
argued about: which components React re-renders per delta, which surface and
which message row they belong to, **why** each one woke, how long the longest
task was, and what the renderer keeps after repeatedly switching between a long
and a short conversation.

## How to re-run it

```sh
pnpm -r build                                   # the profile runs the built app
node scripts/browser-check/run.mjs \
  --target scripts/browser-check/targets/streaming.mjs --fixture huge \
  --script scripts/browser-check/profile-streaming.mjs \
  --artifacts /tmp/perf-streaming/run
```

`targets/streaming.mjs` is the app target with one difference: its provider
answers `Stream <n> deltas every <ms> ms` with exactly that many SSE content
frames. Everything else — host, worker, fixtures, theme, RPC — is
`targets/app.mjs`.

It asserts the acceptance and fails the run when a surface regresses; see
"What the profile now asserts" at the end.

| Variable | Default | Meaning |
| --- | --- | --- |
| `PROFILE_DELTAS` | 500 | content frames per run |
| `PROFILE_DELAY_MS` | 4 | spacing between frames |
| `PROFILE_RUNS` | 3 | runs; the report takes medians |
| `PROFILE_SWITCHES` | 10 | long↔short session switch pairs for the memory phase (0 skips it) |
| `PROFILE_FULL_WALK` | – | `1` walks untouched subtrees too, to check the pruning |
| `PROFILE_TRACE` | – | a component name; logs its changed value commit by commit |
| `PROFILE_ASSERT` | – | `0` reports without failing |

Component names come from the bundle. Build the UI **unminified**
(`npx vite build --minify false` in `packages/ui`) when you need the named
tables below; the shipped minified build gives the same counts under mangled
names. Long-task numbers should be read from a minified run: the fiber walk
itself runs inside every commit.

## Method, and one correction worth knowing

A React DevTools hook shim is installed before the app loads (no profiling
build, no application code). On every commit it walks the fiber tree and counts
the components that actually ran their body.

**`fiber.alternate` cannot answer "did this render?"** React double-buffers two
fiber objects per component and reuses a bailed-out subtree as it stands, so a
component that rendered once keeps an alternate holding the older hook list for
every later commit — which reads as "rendered again" forever. The first
measurements taken that way over-counted by 2–3× (427,773 component renders per
500 deltas, against 317,177 for the same build measured correctly). The profile
now keeps one record per component instance, shared by both fibers of the pair:
a fresh hook list means the body ran, a hook-less fiber is judged by its props
object, and a subtree whose child pointer did not change is pruned. Every number
below comes from the corrected profile; earlier figures in this task's notes do
not compare.

For each *render root* — a component that re-rendered while its parent did not,
so its own subscription woke it — the profile also reports which hook changed
value and whether the new value is merely a fresh allocation of the old one
(`reasons`, printed as `woke by <surface>/<component>#<hook>`). That is what
turned "the app re-renders a lot" into a list of exact lines to fix.

## What the traces found

Environment: this worktree's built host, worker and UI; Node 24.11.1; headless
system Chrome; 1360×900, light; no CPU throttling. `--fixture long` is a
240-message conversation, `--fixture huge` is 2,000 messages; both open on a
tail-first window, so about 40 messages are loaded and 1–3 rows are mounted
while a long reply streams. 511 `session/update` notifications arrive per run
(500 content frames plus the turn's own updates), batched by the client into
~130 store publications — roughly one per animation frame.

Per streamed batch, the following re-rendered although nothing they draw had
changed:

| Trace line | What it is | Where |
| --- | --- | --- |
| `ThreadContent#23 array(42) of {id,createdAt,role,content,…}` | the find hook subscribed to `thread.messages` while its bar was closed, so the whole thread column, its footer and the mounted rows re-rendered | `use-conversation-find.tsx` |
| `Shell/StartupShell#4`, `Shell/ShellFrame#13` `{path,state,blocks,lastSeq,running,queue}` | the shell read the whole `SessionView`; that drags the rail, sidebar, top bar, fleet, telemetry and the thread with it | `components/shell/Shell.tsx` |
| the same value in `TopBar`, `CommandPaletteDialog`, `AgentMapFullscreen`, `Workbench`, `ThreadDialogCards`, `WaitingNotice`, `SessionAgentSelector`, `ThinkingEffort`, `DictateButton`, `ComposerQueue` | ten more whole-`SessionView` readers | shell, workbench, dialogs, elements, mobile |
| the same value in `ComposerBody`, `GoalBar`, `SessionPreparationProvider` | three more, in the thread | `Composer.tsx`, `GoalBar.tsx`, `session-preparation.tsx` |
| `ToolsSection#0`, `FilesSection#6` `array(42) of message` | the telemetry column derives from `thread.messages` | `components/shell/TelemetryPanel.tsx` |
| `ThreadList#16 (equal value, new identity) array(2)` | a memo in the sessions list re-allocates an equal array per publication | `elements/thread-list.aui.tsx` |
| window republish rebuilt every mounted row | rows were not memoised | `transcript-viewport.tsx` |

`lastSeq` and `blocks` change with every batch, so reading the view *is* a
subscription to the stream. This is one defect repeated in fifteen places, not
fifteen defects.

## Fixed, part one: the thread column

1. **Find holds no subscription while it is closed.** `useConversationFind`
   selects a constant until the bar opens; open, it reads the live transcript as
   before (`streaming-touch.test.tsx`, and the browser check below).
2. **`ThreadContent` reads what it draws.** The session path and whether history
   is partial, instead of the whole view. The seen watermark — which genuinely
   follows `lastSeq` — moved into `SessionSeenBridge`, which renders nothing.
3. **The composer reads what it draws.** `useNothingToSendTo`,
   `useHandedBackText`, `useAgentCommands`, `useSlashCommands` and
   `useHandleMentions` take narrow slices (`path`, `cwd`, `editorText`,
   `entries`, `leafId`).
4. **The goal bar reads the goal**, and the session-preparation provider reads
   the session's agent plus one boolean ("has canonical history started?").
5. **Rows are memoised.** A window republish (a measured row, a pin, growth)
   rebuilt the whole row list; `WindowRow` now bails out when its id and
   controller are unchanged. assistant-ui already shields the message body
   itself, so this saves the row wrapper, not the transcript.

## Fixed, part two: everything beside it

The same defect stood in fifteen more places, and it is one sentence: **read the
fields you draw, not the session**. `lastSeq` and `blocks` move with every
token, so `useLaserView()` in a surface that draws no transcript is a
subscription to the stream.

1. **The shell frame, the top bar, the command palette, the fullscreen map.**
   The first two take the session through `samePresentationView`
   (`runtime/presentation-state.ts`): the same object, with its identity held
   while the name, the agent, the status, the questions and the conversation's
   first line are unchanged. Only a surface that draws none of the transcript
   may use it — the comparison deliberately ignores blocks, entries and the
   sequence — and the two that do (the palette's `/fork`, the top bar's) read
   entries from the host at the moment they act. The palette reads nothing at
   all while its dialog is closed.
2. **The workbench, the inline question cards, the waiting notice, the
   composer's agent / thinking / microphone / tray controls.** Narrow reads:
   the project directory, the questions, the session's agent, the pending tray,
   and one derived boolean ("has this session started?") in place of
   `isUnstartedSession(view)`.
3. **The monitor's Tools and Files sections.** Both derived from every message
   through `useThreadToolTimeline` / `useSessionFileChanges`. They now subscribe
   to a key describing the tool calls themselves — id, status, incomplete
   reason, error flag and argument length — and read the messages imperatively
   for that same commit. Live tool work still moves them (a call appearing, its
   arguments arriving, its status settling); prose does not.
4. **The sessions panel.** assistant-ui re-allocates `threadIds` and
   `threadItems` on every publication of its store, with the same entries
   inside. `useStableAuiList` keeps the previous array while the entries are the
   same objects, so the list re-renders when the list changes.

## Numbers

Unminified build, `--fixture long`, 511 deltas, one run per column (the values
are stable across runs to ~1 %). "Renders" are component bodies that ran.

| | before | after | after, with the shell finding fixed too¹ |
| --- | ---: | ---: | ---: |
| renders per delta | 625.0 | **518.6** | **222.6** |
| commits per delta | 2.237 | 2.006 | 1.890 |
| settled-row fibers (500 deltas) | 10,176 | 8,219 | 8,219 |
| thread column (`Thread` + `ThreadContent`) | 33,864 | 26,928 | 12,077 |
| composer/footer | 92,515 | 45,859 | 15,201 |
| message rows | 20,145 | 16,863 | 16,887 |
| sessions sidebar | 56,630 | 57,420 | 32,057 |
| telemetry | 36,563 | 37,099 | 6,782 |
| fleet | 7,840 | 7,956 | 648 |
| rail | 33,750 | 34,250 | 1,575 |
| top bar | 24,430 | 24,792 | 25,154 |
| long tasks > 50 ms | 0 | 0 | 0 |

¹ At the time, an experiment: `Shell.tsx`'s two `useLaserView()` reads replaced
by narrow selectors. It is now shipped as part two, together with the other
fourteen sites, and the table below supersedes that column.

### After both parts

Production (minified) build, `--fixture huge` (2,000 messages, tail-first
window), medians of three runs of 511 deltas, compared with the same build
before any of this work:

| | before | part one | **both parts** |
| --- | ---: | ---: | ---: |
| component renders per delta | 625.0² | 515.0 | **82.2** |
| React commits per delta | 2.24² | 2.02 | **1.57** |
| settled-row re-renders per delta (mounts excluded) | — | 9.3 | **4.2** |
| shell-frame wakes (511 deltas) | 267 | 267 | **15** |
| sessions panel wakes | 307 | 307 | **23** |
| telemetry wakes | 302 | 302 | **4** |
| long tasks > 50 ms | 0 | 0 | **0** |
| median gap between commits | — | 2.2–2.5 ms | **1.0–1.5 ms** |

² measured on the `long` fixture; the two fixtures differ by about 2 % on this
metric, and the 2,000-message fixture was measured at 515.0 after part one.

A "wake" is a component that re-rendered while its parent did not — its own
subscription fired. The rail, the top bar, the workbench and the goal bar never
woke on their own even before: the shell frame above them did, and they were
dragged through it. What is left is the turn itself (it starts, it ends, the
status and the catalog change), a handful of times per reply rather than one
per streamed batch.

By surface, component bodies run over 511 deltas (unminified; before on the
`long` fixture, after on `huge` — both a 40-message tail window): sessions panel
57,420 → 4,226; rail 34,250 → 2,750; top bar 24,792 → 1,987; telemetry
37,099 → 2,759; fleet 7,956 → 648; workbench 137 → 11; goal bar 137 → 11;
composer and footer 45,859 → 5,595; shell frame 12,572 → 980.

Production (minified) build, `--fixture huge` (2,000 messages, tail-first
window), medians of three runs of 511 deltas:

| | value |
| --- | ---: |
| renders per delta | 515.0 |
| commits per delta | 2.016 |
| settled-row fibers | 1,362 |
| active-row fibers | 8,643 |
| **long tasks > 50 ms** | **0** (no long task of any length was recorded during the stream) |
| median gap between commits | 2.2–2.5 ms |
| mounted rows during the stream | 1–3 |
| DOM elements | 539 |

### Memory across long↔short switches (after both parts)

Ten long↔short session switch pairs through the real sidebar, with the
renderer's own counters read after a forced collection (CDP
`HeapProfiler.collectGarbage` + `Performance.getMetrics`):

| after | JS heap | DOM nodes | listeners | mounted rows |
| --- | ---: | ---: | ---: | ---: |
| baseline (long conversation, just streamed into) | 19.34 MB | 986 | 328 | 3 |
| 1 pair | 18.01 MB | 797 | 321 | 1 |
| 5 pairs | 18.63 MB | 797 | 321 | 1 |
| 10 pairs | 19.06 MB | 797 | 321 | 1 |

DOM nodes and listeners fall to the level of a freshly opened conversation after
the first switch and stay exactly there for the remaining nine: no row,
observer, listener or subscription is retained per switch. The heap ends 0.28 MB
*below* its baseline and 1.05 MB above its own first reading, drifting with the
bounded caches the transcript keeps (measured row heights, search content)
rather than with the number of switches.

## What the profile now asserts

"Zero renders per delta" is a statement about deltas, not about the turn: a
column still wakes when the turn starts and ends and when a status or the
catalog changes. So the run fails when

- any of the sessions panel, rail, top bar, fleet, telemetry, workbench or goal
  bar **wakes** more than `max(8, deltas/20)` times (23 measured for the sessions
  panel, ≤ 10 for the rest, at 511 deltas);
- settled message rows re-render (mounts excluded) more than 20 times per delta
  (4.2 measured);
- the whole app renders more than 150 components per delta (82.2 measured);
- a long task over 50 ms appears (none measured);
- the switch loop retains more than 2,000 DOM nodes (it retains none).

## M16-T36 — a phone stopped waiting for the sheet to finish leaving

`docs/handoff-open-problems.md` P3: returning to a 2,000-message conversation at
390 px in dark mode was typable at **316 ms median / 337 ms p95** against a
budget of 300 / 500, while the same case with `prefers-reduced-motion` measured
**159 ms**. The animation was the cost — but not because it was slow.

### What the trace said

A per-frame recording of one return (tap → first frame the composer accepts a
tap), at 390 px dark with motion on, on the built app:

| frame | state |
| ---: | --- |
| ~25 ms | the sessions sheet is dismissed (`data-state=closed`), the transcript is mounting |
| **~60 ms** | the destination conversation is **drawn and readable** |
| 60–233 ms | a hit test at the centre of the composer returns `div[data-slot=sheet-overlay]` |
| **~233–266 ms** | the overlay unmounts; only now is the composer typable |

The sheet's exit animation is composited and cheap. What cost 180 ms was that
**a dismissed overlay keeps hit-testing until its fade ends**: the conversation
was on screen and a tap on its composer landed on the leaving overlay. Radix
sets `pointer-events: auto` inline on the overlay, so a class alone could not
take it back.

### The fix

One rule in `components/ui/sheet.tsx`: `data-[state=closed]:pointer-events-none!`
on the overlay. A sheet that is leaving has already been dismissed — it keeps
fading, and it stops taking taps. The movement is untouched (both the overlay's
fade and the panel's slide still run; `prefers-reduced-motion` remains the
fallback that loses only the movement), and no duration, token or literal
changed.

### Numbers

Same recording after the fix: drawn at ~60 ms, **typable at 53–78 ms**, with the
overlay still fading. A real key press issued the moment the composer is typable
puts the character on screen **3–18 ms later, with motion on and off alike**
(no long task; longest frame 17–35 ms).

The harness measurement, 2,000-message conversation, 390 px dark, **20 pairs =
40 samples per lane** (`scripts/browser-check/test/transcript-window-phone-motion.mjs`
and `…-phone-reduced.mjs`, `TRANSCRIPT_PAIRS=20`), long↔long lane:

| | resident median / p95 | typable median / p95 | typed median / p95 |
| --- | ---: | ---: | ---: |
| before (P3, 6 samples, earlier build) | 105.1 | 267.8 / 299.1 | 316.2 / 337.7 |
| **after, motion on** | 67.2 / 75.4 | **70.9 / 75.4** | **282.7 / 283.6** |
| after, reduced motion (same build) | 76.7 / 81.6 | 76.8 / 81.6 | 100.2 / 116.5 |

Budget: 300 ms median / 500 ms p95 for typing readiness, 250 / 400 resident. Both
are met with motion on, and the p95 falls from 337.7 to 283.6. The short↔long
lane measures 56.6 / 65.6 / 266.2.

The "typed" column is the harness's deliberately conservative endpoint: it
includes its own automation round trips (`inputValue`, an `evaluate`, then
`fill`), which queue behind the renderer's remaining work. That is why it still
reads higher with motion on (283 ms) than with motion off (100 ms) although a
real key press lands within 18 ms of readiness in both. The budget is stated on
that conservative endpoint and is met on it.

`transcript-window.mjs` now asserts the shape of the defect rather than the
number: typing readiness may not trail the drawn conversation by more than
150 ms in either lane. Before the fix that gap was ~200 ms; it is now 4–10 ms.

## Still open

- **Settled rows.** About four component bodies per delta still run inside rows
  that are not the streaming one, in Radix tooltip/popper wrappers whose ref
  callbacks re-register when their row re-renders. Rows entering the window as
  the reply grows (counted separately as mounts) are the window working, not
  waste.
- **`components/mobile/Notices.tsx`** still reads the view for a dialog count;
  it is a phone-only surface and was not part of this measurement.
- **The conversation map** re-renders per batch by design (it reads the message
  list) but does not re-layout; that guard is tested elsewhere.
- Phone width and dark theme were screenshotted, not profiled (the streaming
  profile is 1360/light; the phone re-entry above is a separate measurement);
  tool-heavy and reasoning-heavy turns were not streamed into; Beam's second
  scope and the Electron shell were not profiled.
- `components/ui/dialog.tsx` has the same closing-overlay behaviour as the sheet
  had. No measurement asked for it, so it was left alone; a modal dialog that is
  fading out still swallows a click for the length of its fade.
