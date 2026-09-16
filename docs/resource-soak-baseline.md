# RP-2 post-containment repeat baseline

Status: **established**. Both unchanged full runs completed cleanly, every
ranking gate passed, D-267 made the flat host result a reproducible null, and
D-269 applies the original T2 sign/CV gate to the mixed-resolution pagination
pair. Every predeclared gate passes.

## Provenance

- Decision base: `cf9a21aa` (D-267 as amended by D-269).
- Measured implementation: `21a15a2a7336813f98eb841023289fc67ee3b7fa`.
- Machine class: 24 logical CPUs; 31 GiB memory; Linux kernel major 7; x64;
  Node 24.20.0; Chromium 153.
- Workload: 5 projects, 50 project sessions, 4 long 240-message transcripts,
  4 workspace sessions, 10 children, 100 foreground and 100 background Bash
  calls, 12 2048-square images, 2 MiB reasoning, 2 MiB Markdown, 8 MiB tool
  output, and the declared quick-scale Electron lifecycle lane.
- The isolated scratch environment used synthetic transcripts and a loopback
  provider. It used no personal sessions or credentials.

Commands:

```sh
pnpm test:browser-check
node scripts/browser-check/resource-soak.mjs --full --runs 2 --electron --artifacts <external-artifact-root>
node scripts/browser-check/resource-soak.mjs --compare-only --artifacts <external-artifact-root>
```

The pre-soak browser-check gate passed 103/103. The full command ran in the
background from the measured implementation above and both A and B passed.
After D-269, `--compare-only` recomputed the comparison from those two retained
reports without rerunning either workload. The reports predate D-269's explicit
`estimate` field, so the comparison derived both OLS point estimates from their
retained points; new reports retain the estimate directly.

## Gate-by-gate verdict

| Gate | Verdict | Evidence |
| --- | --- | --- |
| Two clean full runs | **pass** | A and B each passed individually. |
| All nine scenarios in both runs | **pass** | Both reports mark scenarios 1–9 complete. |
| Complete physical-memory coverage | **pass** | Every phase in both reports has complete PSS/private coverage. |
| Fixed safety ceilings | **pass** | No 1,610,612,736-byte process-PSS or 5,368,709,120-byte sampled-scope PSS refusal; sampled `MemAvailable` stayed above 2,147,483,648 bytes. |
| Heap-snapshot cap | **pass** | Largest raw capture: A 196,025,576 bytes; B 198,401,584 bytes, each below 268,435,456; no raw capture remained. |
| Zero survivors | **pass** | Browser and Electron teardown reported zero survivors in A and B. |
| Retained-owner repeatability | **pass** | All 11 structural/evidence categories passed their predeclared policy. |
| Post-GC slope repeatability | **pass** | All five metrics pass. Pagination is mixed-resolution but its retained OLS estimates have the same sign and 4.3% CV under D-269. |
| Unsupported metrics explicit | **pass** | Listed below; unavailable evidence is never reported as zero. |

The recomputed overall comparison is **passed**. This document is the
post-containment normal-resource baseline for the declared machine class and
fixture.

## Measurement corrections and D-267

Review of the earlier reports found a harness bug: renderer slopes used natural
pre-GC phase counters even though the accompanying heap captures forced GC.
The corrected harness takes explicit double-forced-GC renderer points, samples
every existing history-page load and every existing 10-call Bash batch, forces
host GC before existing retirement points, and fits ordinary least squares. It
retains points, residual standard deviation, slope standard error, R² and n.
The workload, timing and acceptance thresholds did not change.

Other validity corrections remain in force:

- pagination counts only page loads that actually occurred;
- structurally identical heap owners share average ranks within the declared
  `max(8 bytes, 1.25%)` retained-size resolution;
- a Linux process row lacking PSS or private-resident memory makes coverage
  inconclusive, with one bounded 50 ms recheck to distinguish an actual exit;
- no fixture, scenario, ceiling, top-owner/overlap rule, 0.8 structural-rank
  threshold or 25% CV threshold changed.

D-267 was recorded before these runs. An OLS slope whose absolute value is at
most twice its SE is `unresolved`. It is displayed as “no drift resolved above
±2·SE,” with residual SD, SE, R² and n, never as a rate. Two unresolved runs pass
as an equivalent null only when their residual-SD noise floors agree within the
same 25% CV; two resolved runs retain the unchanged sign and 25% CV gates.

D-269 corrects D-267's over-strict mixed-pair addition: resolution is a label,
not a verdict. A resolved/unresolved pair uses the original T2 gate on both
retained OLS point estimates — same sign and CV at most 25% — while still
showing both resolution labels and uncertainty. New reports retain `estimate`
even when the displayed `value` is null; compare-only derived it from retained
points for these pre-D-269 report files.

## Both retained-owner rankings

The entries below are the top five per category in descending order. Synthetic
transcript aliases are described by role rather than copied as session
identifiers.

| Category | Run A top five | Run B top five | Repeat gate |
| --- | --- | --- | --- |
| Host retained | retired 1,231,216; pre-detach 1,223,024; Bash-complete 1,211,880; paged 940,696; large-stream 849,656 | retired 1,220,120; pre-detach 1,215,112; Bash-complete 1,203,136; paged 915,008; large-stream 824,104 | top same; overlap 5; Spearman 1.000 |
| Host nodes | array 7,320; string 3,320; `HostServer` 824; `PackageService` 272; `ResourceService` 256 | array 7,208; string 3,320; `HostServer` 824; `PackageService` 272; `ResourceService` 256 | top same; overlap 5; Spearman 1.000 |
| Renderer retained | distinct, paged, large-stream, Bash-complete and pre-detach `stateOpen`, each 240 | same five, each 240 | top same; overlap 5; Spearman 1.000 |
| Renderer nodes | native 212; object 28 | native 212; object 28 | top same; overlap 2/2; Spearman 1.000 |
| Renderer state projection | long transcript 31,535; three long transcripts 14,237 each; short transcript 2,293 | same values and order | top same; overlap 5; Spearman 1.000 |
| Worker retained | pre-detach primary 1,812,264; Bash-complete primary 1,812,168; large-stream secondary 111,040; large-stream primary 110,792; distinct tertiary 110,264 | pre-detach primary 1,812,208; Bash-complete primary 1,812,112; large-stream secondary 111,040; large-stream primary 110,832; paged primary 110,176 | top same; overlap 4; Spearman 1.000 |
| Worker nodes | string 16,448; array 10,712; `WorkerServer` 416; `SettingsManager` 272; `ModelRuntime` 264 | same values and order | top same; overlap 5; Spearman 1.000 |
| Renderer native allocators | `malloc` 69,345,280; partitions 69,345,280; allocator 68,726,784; unspecified 68,317,184; allocated objects 67,200,960 | `malloc` 69,918,720; partitions 69,918,720; allocator 69,226,496; unspecified 68,835,184; allocated objects 67,695,397 | top same; overlap 5; Spearman 1.000 |
| Host sampled allocation | sampled 406,803,320; `take` 117,657,288; anonymous 105,322,216; `project` 57,257,688; `walk` 14,068,808 | sampled 406,868,960; `take` 118,569,952; anonymous 108,129,216; `project` 57,291,176; `next` 12,067,640 | top same; overlap 4; Spearman 0.952 |
| Worker sampled allocation | sampled 1,261,287,576; `project` 153,428,840; encoder 153,265,896; `namesOf` 141,361,432; `notify` 118,375,640 | sampled 1,265,734,344; `project` 153,263,280; encoder 153,262,968; `namesOf` 139,853,424; `send` 118,473,224 | top same; overlap 4; Spearman 0.988 |
| Desktop processes | visible worker 218,374,144; visible renderer 142,746,624; restored renderer 128,806,912; hidden renderer 128,730,112; restored main 128,717,824 | visible worker 216,064,000; visible renderer 135,412,736; visible main 129,860,608; restored main 128,733,184; hidden main 127,001,600 | top same; overlap 3; Spearman 0.806 |

Values are retained bytes for heap categories and sampled proportional bytes for
allocation/process categories. They are not disjoint totals.

## Both post-GC slope sets

`± bound` is 2·SE. Residual SD is the observed-value noise floor; SE has the
metric's slope unit.

| Metric | Run | Result | Residual SD | SE | R² | n |
| --- | --- | --- | ---: | ---: | ---: | ---: |
| Renderer heap / distinct session | A | resolved: 4,910.080 bytes/session | 12,548.166 | 396.808 | 0.981 | 5 |
|  | B | resolved: 5,839.400 bytes/session | 18,782.287 | 593.948 | 0.970 | 5 |
| Renderer heap / history page | A | resolved: 188,383.797 bytes/page | 2,504,779.173 | 90,265.976 | 0.186 | 21 |
|  | B | no drift resolved above ±188,144.076 bytes/page; retained estimate 177,217.403 bytes/page | 2,610,393.109 | 94,072.038 | 0.157 | 21 |
| Renderer heap / heavy-payload MiB | A | no drift resolved above ±3,724,116.093 bytes/MiB | 16,090,020.485 | 1,862,058.046 | 0.595 | 3 |
|  | B | no drift resolved above ±3,655,460.568 bytes/MiB | 15,793,394.716 | 1,827,730.284 | 0.615 | 3 |
| Renderer heap / Bash call | A | resolved: 30,195.184 bytes/call | 224,126.542 | 869.125 | 0.985 | 20 |
|  | B | resolved: 29,466.333 bytes/call | 379,055.484 | 1,469.914 | 0.957 | 20 |
| Host post-retirement PSS / minute | A | no drift resolved above ±349,998.004 bytes/minute | 61,006.112 | 174,999.002 | 0.019 | 6 |
|  | B | no drift resolved above ±338,418.948 bytes/minute | 58,987.835 | 169,209.474 | 0.061 | 6 |

| Pair gate | Outcome | Pair statistic | Verdict |
| --- | --- | ---: | --- |
| Distinct sessions | both resolved, same sign | rate CV 12.2% | pass |
| Pagination | D-267 label: A resolved, B unresolved; D-269 verdict uses 188,383.797 vs 177,217.403 bytes/page, same sign | estimate CV 4.3% | pass |
| Heavy payload | equivalent null | residual-SD CV 1.3% | pass |
| Bash calls | both resolved, same sign | rate CV 1.7% | pass |
| Host retirement | equivalent null | residual-SD CV 2.4% | pass |

Under D-267 alone, pagination's mixed labels produced the earlier failure.
D-269 leaves those labels and uncertainty unchanged but removes that invented
failure rule: the original T2 estimate gate passes at 4.3% CV. The retained
workloads were not rerun or reclassified.

## Baseline resource envelope

| Measurement | Run A | Run B |
| --- | ---: | ---: |
| Peak sampled-scope PSS | 2,162,274,304 B | 2,153,728,000 B |
| Peak sampled-scope private resident | 2,139,480,064 B | 2,127,048,704 B |
| Peak renderer JavaScript heap | 203,003,544 B | 221,213,080 B |
| Lowest phase-sampled `MemAvailable` | 13,735,309,312 B | 14,190,174,208 B |
| Provider requests | 1,050 | 1,050 |
| Retained views traversed at retirement | 54 | 54 |
| Browser survivors | 0 | 0 |
| Electron survivors | 0 | 0 |

Both runs fenced the deliberately slow local consumer on its own connection,
observed bounded queue pressure, closed it, and recovered with a fresh consumer.
Both proved zero terminal tail buffers after real tool work. Retirement ended
with zero product connections, transcript attachment refs, attached paths,
running sessions, live runs, tasks, questions, approvals and running tools.
The Electron lane preserved main and host generations through hide/restore,
proved keyboard behavior after restoration, rejected a second instance cleanly,
and left no survivors.

## Comparison with the initial T2 finding

The initial T2 run refused before the large-tool heap capture when the measured
renderer reached 1,977,168,896 bytes PSS, above the unchanged per-process
ceiling. Its preceding large-reasoning checkpoint held a 449,173,956-byte
renderer heap and 283,647 DOM nodes.

These runs completed the unchanged large reasoning, Markdown, 8 MiB tool,
12-image, 10-child, 200-call and slow-consumer workloads. At the comparable
large-reasoning checkpoint, A/B renderer heaps were 203,003,544 / 131,503,912
bytes and DOM counts were 9,176 / 5,482. Large-tool checkpoints remained below
the ceiling, and post-image large-stream renderer heaps settled to 42,679,592 /
44,767,252 bytes after collection. This demonstrates containment relative to
T2; the D-269 comparison now establishes the repeat baseline.

## Unsupported metrics and limitations

- Physical decoded-image bytes per DOM owner are unavailable; only logical RGBA
  and encoded-byte evidence is retained.
- Relay-client memory is not measured; the slow-consumer lane uses a local host
  WebSocket and paused reader.
- Retained size is computed by exclusion and does not model weak edges exactly
  like a DevTools dominator tree.
- Native allocator totals cannot be assigned to one DOM owner.
- PSS, private resident, JavaScript heap, V8 external memory and native allocator
  totals overlap and are not presented as disjoint buckets. RSS is not summed.
- Sampled totals cover the host tree plus the measured renderer, not the whole
  application.
- A resolved/unresolved boundary can remain sensitive when an estimate lies
  near 2·SE. D-269 preserves that uncertainty label and applies the original
  sign/CV gate to the retained point estimates rather than smoothing them.
- Linux collectors were exercised. macOS and Windows collectors remain unproven.
- No raw heap, transcript, session identifier, process identifier, credential,
  inspector endpoint or private scratch path is included here.
