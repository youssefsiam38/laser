# RP-2 post-containment repeat baseline

Status: **not established**. Full run A was not clean, so run B did not start and
M18-T15's repeatability gate is blocked. This is the post-containment result,
not a passing baseline.

## Provenance

- Source: `350d17beb481b819ce47007c423c62f1bd5df114`
- Machine class: 24 logical CPUs; 31 GiB total memory; Linux kernel major 7.
- Harness: the unchanged full RP-2 fixture, including the fixed
  1,610,612,736-byte per-process PSS ceiling, 5,368,709,120-byte sampled-scope
  PSS ceiling, 2,147,483,648-byte `MemAvailable` floor and 268,435,456-byte raw
  heap-snapshot cap.
- The scratch environment used synthetic transcripts and a loopback provider.
  It used no personal sessions or credentials.

Commands, in order:

```sh
pnpm -r build
pnpm test:browser-check
node scripts/browser-check/resource-soak.mjs --full --runs 2 --electron --artifacts <external-artifact-root>
```

The build passed. The pre-soak browser-check gate passed 97/97. The soak exited
non-zero in run A; its partial report is the source of every number below.

## Outcome

| Gate | Verdict | Evidence |
| --- | --- | --- |
| Two clean full runs | **fail** | A failed; B was not started. |
| All nine scenarios in A and B | **fail** | A completed 1, 2, 3, 4, 5, 6 and 8; scenario 9 timed out; scenario 7 runs only after the browser lane and was not reached. |
| Complete physical-memory coverage | **fail** | `paged-history` had null PSS/private totals and `completePssCoverage: false`; the old coverage flag incorrectly remained `true`. |
| Fixed PSS ceilings | **inconclusive** | No recorded complete sample triggered a ceiling, but one scenario-3 sample lacked PSS and therefore cannot certify the run. |
| Heap-snapshot cap | **pass for A captures** | Largest raw snapshot was 195,373,893 bytes, below 268,435,456; no raw snapshot remained. |
| Zero survivors | **pass for failed A** | Teardown reported 0 survivors. |
| Retained-owner repeatability | **not run** | B has no rankings. |
| Slope sign and ≤25% CV repeatability | **not run** | B has no slopes. |
| Peak-range repeatability | **not run** | B has no peak range. |
| Unsupported metrics explicit | **pass** | Listed below; unavailable values are not zero. |

The terminal failure was the scenario-9 lifecycle assertion: after all 54
retained views had been traversed, the product connection still held two
transcript paths. The current view permits at most one default hold here, so at
least one dormant hold remained. The count stayed at two through the bounded
wait. Teardown still removed every owned process.

A second, earlier failure was hidden by the harness: one scenario-3 process row
had neither PSS nor private-resident memory, yet `ProcessCensus` counted the row
as readable because its process identity was readable. That produced null totals
beside `coverage.complete: true` and allowed safety evaluation to continue with
`completePssCoverage: false`. The accompanying harness correction now treats a
Linux row missing either required physical metric as unreadable, making totals
null, coverage incomplete and the safety verdict a refusal. This tightens the
existing gate; it changes no fixture, workload, ceiling, scenario, threshold or
assertion.

## Run measurements

The table reports the evidence the sanitized partial report actually retains.
“Scope” is the host tree plus the measured renderer. Private memory is retained
only as a scope total, not as per-role rows. Heap columns are role-specific:
renderer JavaScript heap, host V8 heap and the sum of readable worker V8 heaps.
“Post” is available only for phases that took a post-capture sample. Worker
post-GC heap is not retained by the report and is therefore unavailable.
Run B values are unavailable because B did not start.

| Scenarios / checkpoint | A peak scope PSS | A peak scope private | A post PSS | A post private | A renderer heap peak / post | A host heap peak / post | A worker heap peak / post | B |
| --- | ---: | ---: | ---: | ---: | ---: | ---: | ---: | --- |
| 1 · baseline | 206,960,640 | 196,747,264 | 215,718,912 | 205,185,024 | 12,500,652 / 10,088,760 | 33,228,144 / 18,984,136 | 0 / unavailable | unavailable |
| 2 + 6 · 50 sessions, projects and workspaces | 2,150,305,792 | 2,122,412,032 | 2,152,225,792 | 2,124,652,544 | 69,547,464 / 28,505,368 | 34,884,216 / 21,485,576 | 620,790,272 / unavailable | unavailable |
| 3 · backward pagination | 2,291,453,952 | 2,260,967,424 | 760,212,480 | 744,771,584 | 66,155,076 / 41,235,756 | 36,090,048 / 22,646,376 | 601,032,472 / unavailable | unavailable |
| 4 · large content and 12 images | 1,387,985,920 | 1,365,368,832 | 1,375,985,664 | 1,357,987,840 | 247,890,836 / 41,358,752 | 32,379,144 / 21,627,880 | 151,971,232 / unavailable | unavailable |
| 5 · 10 children and 200 Bash calls | 2,056,463,360 | 2,032,410,624 | 1,554,247,680 | 1,535,803,392 | 107,445,312 / 48,605,620 | 37,286,808 / 23,184,848 | 426,255,424 / unavailable | unavailable |
| 7 · desktop hide/restore | unavailable | unavailable | unavailable | unavailable | unavailable | unavailable | unavailable | unavailable |
| 8 · slow consumer | 2,044,357,632 | 2,023,501,824 | unavailable | unavailable | 132,043,524 / unavailable | 33,563,448 / unavailable | 189,047,864 / unavailable | unavailable |
| 9 · detach/retire, pre-failure | 1,998,535,680 | 1,976,983,552 | 1,556,124,672 | 1,538,256,896 | 190,471,400 / 67,710,960 | 33,817,832 / 22,820,376 | 185,899,272 / unavailable | unavailable |

Across A's finite natural samples, sampled-scope PSS ranged from 139,754,496 to
2,291,453,952 bytes, private resident memory ranged from 129,863,680 to
2,260,967,424 bytes, and renderer JavaScript heap ranged from 12,411,288 to
247,890,836 bytes. Phase samples reported 12,579,848,192 to 14,335,889,408
bytes available to the machine. The independent one-minute observation reached
a low of 11,415,028 KiB, also above the floor.

## A-only retained-owner evidence

These rankings cannot receive a repeat verdict without B. Values are retained
bytes or sampled bytes exactly as labelled by the report.

- Host retained: `pre-detach/HostServer` 1,246,208; `bash-complete/HostServer`
  1,232,784; `paged-history/HostServer` 965,432; `large-stream/HostServer`
  862,080; `distinct-sessions/HostServer` 467,016; `baseline/HostServer` 292,104.
- Renderer retained: `stateOpen` was 240 at each post-baseline heap checkpoint
  and 28 at baseline. The largest renderer state projection was
  `renderer/state.open/R1-S1/entries` at 31,535.
- Worker retained: `pre-detach/worker-1/WorkerServer` 1,812,624;
  `bash-complete/worker-1/WorkerServer` 1,812,528; the next retained worker
  target was 112,624.
- Native allocators: `malloc` 68,501,504; `malloc/partitions` 68,501,504;
  `malloc/partitions/allocator` 67,878,912; `malloc/allocated_objects`
  65,958,523; `v8` 47,180,464.
- Sampled host allocation: `sampled-allocation` 393,857,424; `take`
  118,365,832; anonymous 105,176,208; `project` 57,225,312.
- Sampled worker allocation: `sampled-allocation` 1,195,051,472;
  `FallbackEncoder` 153,265,856; `project` 153,229,088; `namesOf` 128,540,912;
  `send` 118,863,784; `notify` 117,646,712; `structuredClone` 113,615,976.

A-only slopes:

| Slope | A value | Samples | A range | Repeat verdict |
| --- | ---: | ---: | ---: | --- |
| Renderer heap per distinct session | 146,353.8 bytes/session | 5 | 26,037,044–39,520,264 | unavailable |
| Renderer heap per history page | -541,631.6 bytes/page | 5 | 50,221,588–69,547,464 | unavailable |
| Renderer heap per heavy-payload MiB | 9,734,224 bytes/MiB | 3 | 69,547,464–247,890,836 | unavailable |
| Renderer heap per Bash call | 96,978.48 bytes/call | 4 | 90,452,388–107,445,312 | unavailable |

## Containment change from the initial finding

The initial T2 run refused before the large-tool heap capture at renderer PSS
1,977,168,896 bytes against the same 1,610,612,736-byte ceiling. This run
completed the unchanged large reasoning, Markdown, 8 MiB tool, 12-image,
10-child, 200-call and slow-consumer workloads without a recorded ceiling
refusal. It then failed the detach/retirement requirement.

At the comparable large-reasoning checkpoint:

- renderer heap fell from 449,173,956 to 247,890,836 bytes: 201,283,120 bytes
  lower (44.8%);
- DOM nodes fell from 283,647 to 11,880: 271,767 fewer (95.8%).

At the post-image `large-stream` checkpoint the renderer heap was 46,583,680
bytes and the DOM held 1,669 nodes. Finished-command containment also held:
zero extension tail buffers and zero retained tail bytes after all commands;
100 worker and 100 host background-task metadata rows remained as expected.
The slow consumer was fenced on its own connection, observed peak queued bytes
were 16,161,916, closure code 1013 was observed, and a fresh consumer recovered.

These improvements do not establish repeatability. The scenario-3 coverage hole
and scenario-9 dormant transcript hold both block a clean A, and therefore B.

## Unsupported metrics and limitations

- Per-role private resident memory is unavailable in the retained report; only
  complete sampled-scope private totals and by-role proportional physical
  inventory are retained. It is not reconstructed from overlapping metrics.
- Worker post-GC heap is unavailable; worker checkpoint heap is reported above
  without inventing a settled value.
- Physical decoded-image bytes per DOM owner are unavailable. The report carries
  only logical RGBA and encoded-byte evidence.
- Relay-client memory is not measured; scenario 8 uses a local host WebSocket
  with a paused reader.
- Retained size is computed by exclusion and does not model weak edges like a
  DevTools dominator tree.
- Native allocator totals cannot be assigned to one DOM owner.
- PSS, private resident, JavaScript heap, V8 external memory and native allocator
  totals overlap and are not presented as disjoint buckets. RSS is not summed.
- Totals cover the declared sampled scope, not the whole application.
- Linux collectors were exercised. macOS and Windows collectors remain unproven
  on this machine.
- No raw heap, transcript, session identifier, process identifier, credential,
  inspector endpoint or private scratch path is included here.
