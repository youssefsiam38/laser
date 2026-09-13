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

## Fixed here (the thread column)

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

¹ An experiment, not shipped: `Shell.tsx`'s two `useLaserView()` reads replaced
by narrow selectors (session `cwd`, "is a session open", the tab title as a
string). Measured on the pre-merge build of the same branch. It is recorded here
because it is the largest single cause and it is not this task's file to change.
While the shell re-renders the whole app per batch, the columns cannot reach
zero and the thread's own savings are partly masked.

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

### Memory across long↔short switches

Ten long↔short session switch pairs through the real sidebar, with the
renderer's own counters read after a forced collection (CDP
`HeapProfiler.collectGarbage` + `Performance.getMetrics`):

| after | JS heap | DOM nodes | listeners |
| --- | ---: | ---: | ---: |
| baseline (long conversation) | 19.13 MB | 801 | 316 |
| 1 pair | 18.84 MB | 797 | 320 |
| 5 pairs | 19.83 MB | 797 | 320 |
| 10 pairs | 20.33 MB | 797 | 320 |

DOM nodes and listeners return to their starting level and stay there: no row,
observer or listener is retained per switch. The heap ends 1.2 MB (6 %) above
its baseline, consistent with the bounded caches the transcript keeps (measured
row heights, search content); it is not proportional to the number of switches
and no growth per pair is visible in the node or listener counts.

## Still open (outside this task's files)

The fifteen-place defect above is the remaining cost, and the profile's own
assertions still fail on it (`PROFILE_ASSERT=0` to report without failing):
the sessions sidebar, rail, top bar, fleet, telemetry and workbench re-render
once per streamed batch. Every one is the same one-line change — read the field,
not the view — and the shell experiment above says what it is worth.
