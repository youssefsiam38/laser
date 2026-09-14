# RP-2 resource soak — measured finding

This is the finding from the controlled RP-2 soak (M18-T2), not a baseline. The
two-run baseline the plan asks for does not exist yet, and this document says
exactly why, what was measured instead, and what has to change before a
repeatable baseline is attempted again.

Harness: `scripts/browser-check/resource-soak.mjs` and `scripts/browser-check/resource/`.
Everything below comes from one corrected full run A on Linux, with the
product's own safety ceilings unchanged.

## What the harness measures, and in what order

- A credential-free scratch host: its own agent, session and state directories,
  a loopback provider serving synthetic transcripts, and no user credentials,
  sessions or settings anywhere in the run.
- One measurement pass per scenario. Each phase reads `/proc` rows (PSS, private
  resident, RSS, peak, CPU) and the renderer's own counters **before** any
  inspector connection, `Runtime.queryObjects` or heap snapshot, because each of
  those collects garbage in the process being measured. Numbers that can only be
  obtained by querying the heap — the extension's bounded tail buffers — are
  taken afterwards and labelled post-GC, as are the post-capture rows.
- Expected processes are `(pid, startToken)` identities, verified every phase. A
  process that exited is recorded as exited; a process that is present but
  cannot be read makes the totals null, the coverage incomplete and the safety
  verdict inconclusive. A partial sum is never presented as a complete total.
- Totals cover one declared scope — the host process tree plus the renderer of
  the measured page — and each phase lists the roles it included (host, host
  descendants, measured renderer) and excluded (browser process and its other
  children, GPU process, desktop and OS processes). They are not an application
  total.
- Runtime discovery is proved, once per process generation, by
  `Runtime.queryObjects` against the real prototype; the instance it finds is
  published on that process's global and every later phase reads the published
  handle, so discovery costs one forced collection per generation instead of one
  per phase.
- Heap targets are resolved while V8 is tracking object moves — the only window
  in which a snapshot object id survives the collection that precedes the
  snapshot — and each raw snapshot is capped at 256 MiB, read once in an
  isolated child process under a declared heap ceiling and an explicit
  typed-array budget, and deleted on every outcome.
- Native allocator ownership comes from one bounded Chrome memory dump taken
  **after** the measured workload, at the least intrusive level of detail that
  still names real owners. Tracing never runs across the workload itself.

## Corrected full run A: coverage and result

| | |
| --- | --- |
| Mode | full (5 projects × 10 sessions, 4 × 240-message transcripts, 2 MiB reasoning, 2 MiB Markdown, 8 MiB tool output, 12 × 2048px images, 10 children, 200 Bash calls) |
| Scenarios complete | 1 baseline · 2 distinct sessions · 3 backward pagination · 6 multiple projects and workspaces |
| Scenario reached and refused | 4 large content and images |
| Phases sampled | 18, every one with complete process coverage and zero unreadable processes |
| Survivors | 0 |
| Raw heap snapshots retained | 0 |
| Run B | never started — gated by run A's refusal |

### Where the memory went

Proportional set size (PSS) of the sampled scope, read before any
instrumentation, with the renderer's own JavaScript heap and DOM node count:

| Phase | total PSS | private resident | renderer JS heap | DOM nodes | processes |
| --- | ---: | ---: | ---: | ---: | ---: |
| baseline | 213,231,616 | 173,367,296 | 11,038,144 | 723 | 2 |
| visited-50 (50 sessions open) | 1,138,265,088 | 1,077,714,944 | 29,501,576 | 986 | 7 |
| distinct-sessions | 1,970,077,696 | 1,896,714,240 | 55,650,060 | 3,614 | 11 |
| paged-history (4 × 240 messages) | 1,082,546,176 | 1,023,209,472 | 50,192,064 | 3,900 | 5 |
| large-reasoning-markdown | 1,179,996,160 | 1,128,628,224 | 449,173,956 | **283,647** | 3 |
| large-tool-output | refused | — | — | — | 3 |

Retained heap, resolved to concrete objects:

| Phase | `HostServer` retained | `WorkerServer` retained | renderer snapshot |
| --- | ---: | ---: | --- |
| baseline | 177,880 | — | 282,499 nodes / 15 MB raw |
| distinct-sessions | 330,360 | 110,104 × 3 workers | 705,711 nodes / 62 MB raw |
| paged-history | 804,384 | 110,104 and 110,288 | 1,117,679 nodes / **106,726,334 bytes raw** |

Slopes from this run: renderer JS heap **+77,646 bytes per opened session**
(15 samples over 50 sessions) and **+257,710 bytes per loaded history page**.

## The refusal, and why B stayed gated

Run A refused at the start of the `large-tool-output` phase, before that phase's
heap capture, against the unchanged 1.5 GiB per-process ceiling:

- offender: renderer of the measured page, **PSS 1,977,168,896 bytes**, private
  resident 1,940,013,056 bytes;
- sampled scope total: 2,711,066,624 bytes over 3 processes, coverage 3/3,
  complete;
- last renderer heap snapshot 46,627 ms earlier, so the crossing is not an
  artifact of a snapshot in flight.

The two-run wrapper refuses to start run B when run A did not complete, so B did
not run and no comparison exists. Teardown left zero survivors and zero raw heap
files, and the partial report is atomic and redaction-gated.

### This is the product's memory, not the harness's

Three independent measurements say so:

1. The same crossing reproduced under three different instrumentation
   configurations: the original one (tracing the whole workload at the detailed
   level of detail, no object-move tracking) at renderer PSS 4,254,587,904; the
   corrected one (no tracing across the workload, tracking only inside a
   capture) at 4,461,069,312; and this run, whose phase rows are read before any
   instrumentation at all, at 1,977,168,896 at an earlier phase. Instrumentation
   changed the number by a few percent and the phase at which it was seen, not
   the outcome.
2. A same-image diagnostic (`scripts/browser-check/resource-image-diagnostic.mjs`)
   renders the fixture's identical twelve 2048px images with no product
   involved: largest process 307,587,072 bytes without tracing, 258,142,208 with
   the corrected bounded dump, 259,392,512 with the old detailed tracing. None
   crossed the ceiling. The images alone are not the cause.
3. The phase that precedes the refusal shows where it comes from: one pair of
   large messages — 2 MiB of reasoning and 2 MiB of Markdown — expands into
   **283,647 DOM nodes** and a 449 MB JavaScript heap in a renderer that is also
   holding 54 open sessions and four 240-message transcripts. The 8 MiB tool
   output that follows is what takes the process past the ceiling.

**The finding: a Laser renderer's retained view state has no bound.** Open
sessions, paged-in history and large single messages each add permanently to a
renderer that never releases any of them, and a realistic heavy session crosses
1.5 GiB before the image workload is even reached. That is RP-5 (bounded
renderer session lifetime) and RP-8 (memory-pressure policy), measured.

## Limitations

- Physical decoded-image bytes per DOM owner are unavailable; image ownership is
  reported as a logical RGBA estimate plus encoded bytes.
- Relay-client memory is not measured; the slow-consumer lane is a local host
  WebSocket with a paused reader.
- Retained size is computed by exclusion ("reachable from this object and from
  nothing else") and does not model weak edges the way DevTools dominator trees
  do; it is used for comparison between runs of the same shape.
- Native allocator totals are aggregate per allocator and cannot be assigned to
  one DOM owner.
- PSS, private resident, JS heap, V8 external memory and native allocator totals
  overlap; they are never presented as disjoint buckets, and RSS is never summed.
- Totals are the sampled scope only, listed per phase.
- This document reports one run. Repeatability is defined but unproven: the
  two-run comparison never executed.

## Handoff: the repeat baseline after containment

The harness is ready; the workload is not survivable by the product yet. When
RP-5 and RP-8 bound retained renderer state:

1. Re-run `node scripts/browser-check/resource-soak.mjs --full --electron --runs 2`
   unchanged. No fixture, workload or ceiling edit is part of that work; if the
   run still crosses the ceiling, that is again a product result.
2. Run B starts only if A completes below every ceiling with zero survivors, and
   the comparison is gated by the predeclared, category-specific policy in
   `resource/report.mjs`: retained-heap owners, the renderer state projection and
   native allocator names must keep the same top owner and rank order; sampled
   allocation profiles and desktop process rows are gated more loosely so one
   noisy sampled symbol cannot fail a run.
3. The baseline document that replaces this one needs both runs' owner rankings,
   both slope sets, the comparison verdict and the same limitations section.
