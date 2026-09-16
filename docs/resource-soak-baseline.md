# RP-2 post-containment repeat baseline

Status: **not established**. Both unchanged full runs completed cleanly, but the
predeclared A/B gate failed the post-retirement host PSS slope. This is a
repeatability finding, not a passing baseline.

## Provenance

- Product base: `98d12881a6af74fbc2720c6778da5b7477cbc418`.
- Measurement revision recorded by the reports:
  `f7eb506816205d170b4e78a31b8e16093756a8e3`, plus the measurement-validity
  corrections described below and committed with this document.
- Machine class: 24 logical CPUs; 31 GiB memory; Linux kernel major 7; x64;
  Node 24.20.0; Chromium 153.
- Workload: 5 projects, 50 project sessions, 4 long 240-message transcripts,
  4 workspace sessions, 10 children, 100 foreground and 100 background Bash
  calls, 12 2048-square images, 2 MiB reasoning, 2 MiB Markdown, 8 MiB tool
  output, and the declared quick-scale Electron lifecycle lane.
- The scratch environment used synthetic transcripts and a loopback provider.
  It used no personal sessions or credentials.

Commands, in order:

```sh
pnpm -r build
pnpm test:browser-check
node scripts/browser-check/resource-soak.mjs --full --runs 2 --electron --artifacts <external-artifact-root>
```

Build passed. The pre-soak browser-check gate passed 101/101. After installing
this clean worktree's package-managed Electron binary, the unchanged full A/B
command completed both runs and emitted a failing comparison. An earlier attempt
had completed the browser lane but could not start scenario 7 because that
binary had not yet been downloaded; it is setup failure, not baseline evidence.

## Outcome

| Gate | Verdict | Evidence |
| --- | --- | --- |
| Two clean full runs | **pass** | A and B each passed individually. |
| All nine scenarios in both runs | **pass** | Both reports mark scenarios 1–9 complete. |
| Complete physical-memory coverage | **pass** | Every phase in both reports has complete PSS/private coverage. |
| Fixed safety ceilings | **pass** | No 1,610,612,736-byte process-PSS or 5,368,709,120-byte sampled-scope PSS refusal; sampled `MemAvailable` remained above 2,147,483,648 bytes. |
| Heap-snapshot cap | **pass** | Largest raw capture: A 196,115,776 bytes; B 195,490,991 bytes, each below 268,435,456; no raw capture remained. |
| Zero survivors | **pass** | Browser and Electron teardown reported zero survivors in A and B. |
| Retained-owner repeatability | **pass** | All 11 structural/evidence categories passed their predeclared top-owner, overlap and rank-correlation policy. |
| Post-GC slope repeatability | **fail** | Four renderer slopes passed; host post-retirement PSS changed sign and had 52.4% A/B CV, above 25%. |
| Unsupported metrics explicit | **pass** | Listed below; unavailable evidence is never reported as zero. |

The overall comparison is therefore **failed**. M18-T15 remains blocked; the
numbers below must not be used as a normal-resource baseline.

## Measurement-validity corrections

Review of the prior A/B reports found that renderer slopes used natural pre-GC
phase values even though heap captures forced GC, so they did not satisfy RP-2's
post-GC requirement. The corrected harness:

- takes explicit double-forced-GC renderer checkpoints and fits ordinary least
  squares only to those points;
- samples every existing history-page load and every existing 10-call Bash
  batch, without changing either workload;
- forces host GC before existing retirement points;
- retains slope points, intercept, residual standard deviation, standard error,
  relative standard error and R²;
- gives structurally identical heap owners average tied ranks within the
  declared resolution `max(8 bytes, 1.25%)`; and
- refuses Linux process rows lacking PSS or private-resident memory, while
  rechecking once after 50 ms so an actually exiting process is recorded as an
  exit rather than false incomplete coverage.

The pagination counter now records only page loads that actually occurred. No
fixture, workload, scenario, ceiling, top-owner/overlap rule, 0.8 structural
rank threshold or 25% slope-CV threshold changed.

## Repeatability

All retained-owner categories passed:

| Category | Policy | Top owner | Top-five overlap | Spearman |
| --- | --- | --- | ---: | ---: |
| Host retained | strict | same | 5 | 0.972 |
| Host nodes | strict | same | 5 | 1.000 |
| Renderer retained | strict | same | 5 | 1.000 |
| Renderer nodes | strict | same | 2/2 available | 1.000 |
| Renderer state projection | strict | same | 5 | 1.000 |
| Worker retained | strict | same | 4 | 1.000 |
| Worker nodes | strict | same | 5 | 1.000 |
| Renderer native allocators | strict | same | 5 | 1.000 |
| Host sampled allocation | evidence | same | 4 | 0.939 |
| Worker sampled allocation | evidence | same | 4 | 0.988 |
| Desktop processes | evidence | same | 4 | 0.782 |

Post-GC ordinary-least-squares slopes:

| Slope | A estimate | B estimate | Samples A/B | A/B relative SE | A/B R² | A/B CV | Gate |
| --- | ---: | ---: | ---: | ---: | ---: | ---: | --- |
| Renderer heap / distinct session | 5,769 B | 7,139 B | 5/5 | 9.0% / 16.9% | 0.976 / 0.921 | 15.0% | pass |
| Renderer heap / history page | 182,161 B | 189,105 B | 21/21 | 49.6% / 47.7% | 0.176 / 0.188 | 2.6% | pass |
| Renderer heap / heavy-payload MiB | 2,065,507 B | 2,176,216 B | 3/3 | 140.5% / 128.1% | 0.336 / 0.379 | 3.7% | pass |
| Renderer heap / Bash call | 30,599 B | 30,257 B | 20/20 | 2.8% / 2.7% | 0.986 / 0.987 | 0.8% | pass |
| Host post-retirement PSS / minute | -55,120 B | 120,071 B | 6/6 | 433.0% / 337.9% | 0.013 / 0.021 | 52.4% | **fail** |

The failing host estimates are each much smaller than their own standard error
(A 238,692; B 405,755 bytes/minute), with near-zero R². The unchanged six-point,
30-second window cannot resolve a host trend at the required 25% precision on
this machine. The harness does not reinterpret those noisy values as zero or
relax the gate after observing them: opposite signs and 52.4% CV remain a
blocking result. Pagination and heavy-payload slopes pass the between-run gate,
but their high within-run uncertainty is retained here and prevents treating
those point estimates as precise cost coefficients.

## Resource envelope observed, not baselined

| Measurement | Run A | Run B |
| --- | ---: | ---: |
| Peak sampled-scope PSS | 2,186,301,440 B | 2,190,387,200 B |
| Peak sampled-scope private resident | 2,163,818,496 B | 2,167,971,840 B |
| Peak renderer JavaScript heap | 212,117,848 B | 206,850,580 B |
| Lowest phase-sampled `MemAvailable` | 12,345,479,168 B | 10,430,603,264 B |
| Provider requests | 1,052 | 1,052 |
| Retained views traversed at retirement | 54 | 54 |
| Browser survivors | 0 | 0 |
| Electron survivors | 0 | 0 |

Both runs fenced the deliberately slow local consumer on its own connection,
observed bounded queue pressure, closed it, and recovered with a fresh consumer.
Both proved zero terminal tail buffers after real tool work. Retirement ended
with zero product connections, transcript attachment refs, attached paths,
running sessions, live runs, tasks, questions, approvals and running tools.
The Electron lane preserved the main and host generations through hide/restore,
proved keyboard behavior after restoration, rejected a second instance cleanly,
and left no survivors.

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
- Linux collectors were exercised. macOS and Windows collectors remain unproven.
- No raw heap, transcript, session identifier, process identifier, credential,
  inspector endpoint or private scratch path is included here.
