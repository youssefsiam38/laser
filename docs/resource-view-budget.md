# The renderer's view budget (RP-5)

Every conversation this window has opened keeps a **light record**: its identity
and environment, its questions, its tray and queue, its title, the durable
revision it was last valid at, and the few words its row is named by. What a
conversation's *transcript* costs — raw entries, derived blocks, the images they
hold and the assistant-ui projection built from them — lives only inside a
bounded cache (`packages/ui/src/runtime/view-cache.ts`). Outside it a view is
dormant: the record stays, the transcript is released, and the next time a
person opens that conversation it is read again from its authoritative host.

This document records the numbers and where they come from. Serialized bytes
are not memory, so the bounds are **calibrated against measured renderer heap**
rather than chosen from the size of a JSON string.

## The bounds

| Bound | Value | Constant |
| --- | ---: | --- |
| Hydrated transcripts kept beside the pinned ones | 6 | `VIEW_CACHE_LIMITS.views` |
| Total hydrated transcript bytes (exact UTF-8) | 4 MiB | `VIEW_CACHE_LIMITS.bytes` |
| One transcript's share | 1.5 MiB | `VIEW_CACHE_LIMITS.viewBytes` |
| Entries a released tail may carry | 40 | `VIEW_TAIL_MAX_ENTRIES` |
| Bytes a released tail may carry | 256 KiB | `VIEW_TAIL_MAX_BYTES` |

The three cache bounds are independent. A transcript over its own share is
released even when the count is under its limit; the count is enforced even
when every transcript is small. Nothing pinned is ever released, and when the
pinned set alone is over budget the counters say `overflow` rather than
releasing a conversation somebody is using.

## What is measured, and how

`view-measure.ts` measures four things separately, so the model below can be
fitted rather than guessed:

- **entries** — exact UTF-8 bytes of each raw entry's JSON, memoized against the
  entry object;
- **blocks** — the derived transcript's own text, reasoning, tool arguments and
  results, memoized against the block;
- **images** — the encoded payload plus the decoded surface it keeps alive
  (`width × height × 4`), where the dimensions come from a validated header read
  from at most a **4 KiB decoded prefix** of the image's own bytes. Nothing is
  decoded into an `Image`, a `Blob` or an `ImageBitmap`;
- **unavailable image sizes** — an SVG or a format with no header we validate is
  counted as *estimated* and charged a declared floor. It is never reported as
  costing nothing.

Measurement is incremental: a streamed token costs the delta, never a walk of
the transcript, and each view object is measured once. A maintenance pass runs
immediately when what is *held* changes — the hydrated set, the selection, a
run or command going terminal, a turn or queue ending, a draft or scope let go
of outside the store — and after content growth with a 250 ms gap between such
passes, so one large tool result reconciles at once while a streamed turn does
not measure itself on every frame.

An image whose decoded size could not be read is counted honestly as estimated
**and makes its view non-retainable**: a few encoded kilobytes can be an
enormous decoded surface, so an unpinned conversation holding one is released
rather than kept on a number nobody measured. A pinned one stays and shows in
the overflow.

## The model

```
heapEquivalent = C_light × lightRecords
               + C_hydrated × hydratedViews
               + k_content × (entriesBytes + blocksBytes)
               + imagesBytes
```

`VIEW_HEAP_MODEL` in `view-cache.ts` carries the fitted constants, and the
counters publish `heapEquivalentBytes` beside every byte number so nobody reads
a serialized size as a memory size.

## Base measurement: the corrected RP-2 full run A

From `docs/resource-soak-finding.md` and the retained report of that run
(`report-partial.json`), on the product **before** this bound existed:

| Phase | renderer JS heap | hydrated views | entries | serialized entry bytes |
| --- | ---: | ---: | ---: | ---: |
| baseline | 11,038,144 | 0 | 0 | 0 |
| visited-10 | 26,395,744 | 10 | 224 | 70,691 |
| visited-50 | 29,501,576 | 50 | 624 | 162,303 |
| distinct-sessions | 55,650,060 | 54 | 648 | 165,823 |
| paged-history | 50,192,064 | 54 | 648 | 165,823 |

Published slopes: **77,645.8 bytes of heap per opened session** and
**257,710.4 bytes per loaded history page**. Per-view serialized entries were
2,290 B for a small session and 14,237 B for each of the four long ones.

Two facts follow, and they are why the bounds are what they are:

1. **Serialized bytes understate retained heap by roughly 28–34×.** 2,290
   serialized bytes per opened session cost 77,646 bytes of heap; a 40-entry
   history page is about 9.2 KB serialized against 257,710 bytes of heap. A
   4 MiB serialized budget is therefore around 112 MiB of heap-equivalent
   content; a 24 MiB one would have been more than half a gigabyte.
2. **The heap snapshot's `state.open` retained figure cannot be the calibration
   source.** It reports 240 bytes for the whole map, because retained size by
   exclusion attributes the shared block and projection graph elsewhere. The
   calibration uses the `jsHeapUsedBytes` deltas at the visit checkpoints, which
   is what the published slopes already use.

First fit from that run: `k_content ≈ 28`, `C_hydrated ≈ 13,000`. `C_light` is
the number this bound exists to make small, and only a run of the fixed product
can measure it.

## After measurement: the same fixture, stopped after the paged history

The calibration run is the **unchanged full fixture** — five projects of ten
sessions, four 240-message transcripts, the same ceilings, the same safety
verdict — executed once and stopped after scenario 3:

```bash
pnpm -r build
node scripts/browser-check/resource-soak.mjs --full --until 3-backward-pagination --artifacts /tmp/resource-soak-t5
```

`--until` changes no fixture, workload, ceiling or gate. It is one run, it is
refused in combination with the two-run comparison, and its report carries
`pass: false`, `purpose: "calibration"`, `partial: true` and the list of
scenarios it never ran, so it can never be read as a baseline. The two-run
repeatability baseline remains M18-T15's, with its command unchanged.

### Result

One run on Linux, artifacts `/tmp/resource-soak-t5`, four scenarios complete
(`1-baseline`, `2-distinct-sessions`, `6-multiple-projects-and-workspaces`,
`3-backward-pagination`), five listed as not run, zero survivors,
`pass: false` by construction.

| Phase | renderer JS heap | open (light) | hydrated | entries | serialized entry bytes |
| --- | ---: | ---: | ---: | ---: | ---: |
| baseline | 11,308,500 | 0 | 0 | 0 | 0 |
| visited-10 | 35,101,080 | 10 | 6 | 60 | 13,751 |
| visited-20 | 49,276,276 | 20 | 6 | 60 | 13,771 |
| visited-30 | 33,816,800 | 30 | 6 | 60 | 13,791 |
| visited-40 | 41,759,760 | 40 | 6 | 60 | 13,811 |
| visited-50 | 26,150,748 | 50 | 6 | 60 | 13,831 |
| distinct-sessions | 81,727,780 | 54 | 6 | 44 | 8,199 |
| paged-history | 39,366,536 | 54 | 6 | 106 | 32,090 |

Against the same fixture before the bound existed:

| | before | after |
| --- | ---: | ---: |
| Sessions whose identity the window keeps after 50 visits | 50 | 50 |
| Transcripts retained at that moment | 50 | **6** |
| Retained entries | 624 | **60** |
| Serialized entry bytes | 162,303 | **13,831** |
| Renderer JS heap at visited-50 | 29,501,576 | 26,150,748 |
| Heap per opened session (published slope) | **+77,645.8** | **−223,758.3** |
| Heap per loaded history page (published slope) | **+257,710.4** | **−14,270.9** |

The two slopes are the criterion "fifty distinct session visits converge to a
bounded post-GC renderer heap": both were positive and are now negative, and the
heap at fifty visits is below the heap at ten. What is left is collection noise
around a flat line, not growth — the retained transcript state stopped scaling
with the number of conversations visited, which is what the bound is for.

### The fitted constants

- `k_content = 28` and `C_hydrated = 13,000` are kept from the base fit: this
  run holds six transcripts throughout, so it re-measures the *absence* of the
  old growth rather than the cost of one transcript.
- `C_light = 2,500` is a **declared conservative figure, not a measurement**:
  fifty light records are 125 KB under this model, which is an order of
  magnitude below the ±10 MB collection noise between these phases, so this
  fixture cannot resolve it. It is published as part of the model
  (`VIEW_HEAP_MODEL`) and labelled here for what it is.
- The bounds of the first table are unchanged by this run: 6 transcripts and
  4 MiB of content hold the renderer's retained view state at roughly 112 MiB of
  heap-equivalent content in the worst case, and the measured workload sits far
  below both (six transcripts, 13.8 KB) because the fixture's conversations are
  small. A single large conversation is what the per-view share is for.


## Limitations

- Physical decoded-image bytes per DOM owner remain unavailable; the decoded
  half of an image is a logical RGBA estimate, as the RP-2 finding says.
- `heapEquivalentBytes` is a model, not a measurement. It is published as such.
- Heap deltas between phases include everything the renderer did in that phase,
  not only view state; the slopes are comparisons between runs of the same
  shape, exactly as the finding treats them.

## The seam the device cache installs into (RP-10)

`view-tail.ts` owns one process-wide installer:

```ts
const previous = installViewTailSink(cache);   // install; keep what it replaced
installViewTailSink(previous);                 // restore when the cache goes
```

The DTO carries the session's own durable id from the authoritative
`SessionState.id` — never a path and never a value read out of an entry —
bounded at 128 characters. A record that cannot carry one, or cannot carry a
revision, is emitted empty and `omitted` (`"no-session-id"`, `"no-revision"`)
so a cache refuses it rather than adapting it.

The default is a sink that does nothing. The cache reads the installed sink
**at delivery time** — after the frame that shows the release, through a frame
callback plus a task, with a bounded 250 ms fallback for a page that never
paints, running exactly once and cancelled by a reset or a disposal — so a
device cache installed a moment later still receives that tail, and one that has
been removed never does. Records waiting for that frame sit in one coalesced queue — the newest record
per session, at most 32 of them and at most 2 MiB (eight full tails), oldest
shed first and counted in `tailsDropped` — with one scheduler for the whole
queue. A hydrate/evict loop faster than the page paints therefore costs a
bounded amount of memory, which is the right trade for data no one is waiting
for. Persistence, expiry, reading a tail back and deleting one belong to RP-10;
nothing here writes anything durable.
