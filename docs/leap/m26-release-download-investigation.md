# M26 — v0.14.0 x64 packaging failure: HTTP 504 on GitHub release assets

Investigation only. No source, tag, workflow, release or repository state was
changed by this pass. Every recovery option below needs the release owner's
approval before anyone runs it.

## Verdict

The x64 build job does not fail because of anything in the release candidate.
It fails because **GitHub returned `HTTP 504` to electron-builder's downloads of
release assets from `github.com/.../releases/download/...`**, four times in a
row per download, exhausting app-builder-lib's retry budget. The tag, the
reviewed source, the lockfile, the electron-builder config and the checksum pins
are all consistent and are not implicated: the identical source built and
packaged successfully on arm64 from the same tag, and the exact-source CI run
(`35616431166`) passed.

The log line that makes this look like a *post-download* failure —
`downloaded label=appimage-tools-runtime-20251108.tar.gz progress=100%` — is
emitted by the **504 response itself**, not by a completed download (proof
below). Nothing was downloaded at that point.

| Claim | Confidence |
| --- | --- |
| The failing operation is an `@electron/get` GET of a GitHub release asset, and the error is an upstream `504` | High — stack trace, code path, retry-ladder arithmetic, reproduced log behaviour |
| The `progress=100%` line is a 504 marker, not a completed download | High — reproduced locally against got 11.8.6 |
| The candidate source/tag/config is not a cause | High — same source, same tag, arm64 succeeded; exact-source CI passed |
| Why GitHub returned 504 only to the x64 job | Unknown — no public incident; external infrastructure, not observable from here |

## Evidence

### 1. The failure, in all three x64 attempts

Run `35616858358`, tag `v0.14.0`, head `ac0985979337b5494484c0bc9c91e2d9e8663305`.

| Attempt | x64 job | Failure point | `progress=100%` line at | Error at | Window |
| --- | --- | --- | --- | --- | --- |
| 1 | `106389652507` | AppImage toolset fetch | `15:10:38.9194901Z` | `15:10:50.9681799Z` | **12.0487 s** |
| 2 | `106393958648` | electron artifact fetch | `15:20:50.0816142Z` | `15:21:15.5812920Z` | 25.4997 s |
| 3 | `106395493292` | AppImage toolset fetch | `15:25:48.5540834Z` | `15:26:00.6061597Z` | **12.0521 s** |

Error text, identical in all three (`/tmp/laser-m26-x64-build.log`,
`/tmp/laser-m26-x64-retry.log`, `/tmp/laser-m26-x64-debug.log`):

```
⨯ failed to build AppImage  error=Response code 504 (Gateway Time-out)
⨯ Response code 504 (Gateway Time-out)  failedTask=build stackTrace=HTTPError: Response code 504 (Gateway Time-out)
    at Request._onResponseBase (node_modules/.pnpm/got@11.8.6/.../core/index.js:913:31)
```

The stack is `got@11.8.6` stream internals — the downloader inside
`@electron/get@3.1.0`, which is what `app-builder-lib@26.15.3` uses for every
Electron and toolset download. No laser frame appears anywhere in it.

### 2. Which URL

`packages/desktop/electron-builder.yml` pins `toolsets.appimage: "1.0.3"`, so
`app-builder-lib/out/toolsets/linux.js#getAppImageTools` resolves:

```
https://github.com/electron-userland/electron-builder-binaries/releases/download/appimage@1.0.3/appimage-tools-runtime-20251108.tar.gz
```

and `app-builder-lib/out/util/electronGet.js#downloadBuilderToolset` passes the
compiled-in SHA-256 for that file, so **no second network request exists in that
code path** — `@electron/get` writes a local `SHASUMS256.txt` from the supplied
checksum instead of fetching one (`@electron/get/dist/cjs/index.js#validateArtifact`).
Between `• building target=AppImage` and `• building embedded block map` the only
network call app-builder-lib makes is this one download; the rest
(`copyDir`, `mksquashfs`, `writeRuntimeData`, `appendBlockmap`) is local.
Therefore the 504 in attempts 1 and 3 is this URL.

Attempt 2 failed earlier, inside `downloadElectronArtifactZip` (no
`downloaded electron zip extracted successfully` line follows), so its 504 is one
of the two assets of that step:
`https://github.com/electron/electron/releases/download/v44.2.0/electron-v44.2.0-linux-x64.zip`
or its `SHASUMS256.txt` — the electron artifact is downloaded **without**
supplied checksums, so `@electron/get` also fetches `SHASUMS256.txt` fresh on
every attempt (`cacheMode: Bypass`).

### 3. The 12.05 s window is a retry ladder, not work

`electronGet.js#downloadArtifactToFile` wraps the download in
`builder-util-runtime`'s `retry({ retries: 3, interval: 2000, backoff: 2000 })`,
whose delay is `interval + backoff * attempt` → **2 s + 4 s + 6 s = 12 s** of
sleeping across four attempts. `got.stream` does not retry on its own.

Attempts 1 and 3 failed **12.0487 s** and **12.0521 s** after the first marker —
a 3.4 ms spread between two independent runs. That is four near-instant 504s
separated by the fixed ladder. The alternative explanation — that the tarball
arrived and the failure came later — would mean copying the whole AppDir and
running `mksquashfs` (the arm64 job spent 14.8 s there, for a 188.5 MB AppImage)
landed within 3.4 ms of the same total twice, and would still leave the 504 with
no network call to come from.

### 4. `progress=100%` is printed by a 504 — reproduced

`electronGet.js`'s progress callback skips a download only when the size is
known *and* small: `if (info.total && info.total < 1000000) return;`. Probing
got 11.8.6 (the workspace copy) against a local server:

```
504 chunked          last events: [{"percent":1,"total":0,"transferred":0}, HTTPError 504]
504 content-length   last events: [{"percent":1,"total":0,"transferred":0}, HTTPError 504]
200 small (6740 B)   last event:  [1, 6740, 6740]      → skipped, nothing logged
200 large (2 MB)     last event:  [1, 2000000, 2000000] → logged, genuine
```

On a 504, got's final `downloadProgress` carries `total: 0`, so the skip does not
apply, `percentCompleted` computes to `100`, and app-builder-lib logs
`• downloaded label=<file> progress=100%`. The three retries print nothing
because `lastLoggedMilestone` is already 100.

**Consequence for reading these logs:** in electron-builder 26.15.3 a
`downloaded … progress=100%` line means either "finished" or "server error";
it is not evidence that a file arrived. (Upstream logging bug; not fixed here.)

### 5. The arm64 "asymmetry" is one sample, not three

`/actions/runs/35616858358/attempts/{1,2,3}/jobs` shows the arm64 job with the
same `started_at`/`completed_at` (`15:08:08Z` → `15:16:54Z`) in every attempt:
GitHub re-ran only the failed job, so **arm64 executed once**, at the same time
as x64 attempt 1, and its result was carried forward. x64 executed three times
(15:08, 15:19, 15:23 UTC) and hit a 504 every time.

The arm64 log shows the same assets fetched successfully
(`/tmp/laser-m26-arm64-attempt3.log`, downloaded here read-only via the API):

```
15:10:35.7356203Z • downloaded label=appimage-tools-runtime-20251108.tar.gz progress=100%
15:10:50.5503159Z • building embedded block map
```

Note that this only proves arm64 *finished*; because of finding 4, an arm64
attempt that hit a 504 and recovered inside the 4-attempt budget would look the
same in the log. So "x64-only" is not established; "x64 exhausted the budget
three times inside a 17-minute window" is.

### 6. External state now

Checked read-only at 15:35–15:39 UTC, ~13–29 minutes after the last failure:

| Asset | Result |
| --- | --- |
| `…/electron-builder-binaries/releases/download/appimage@1.0.3/appimage-tools-runtime-20251108.tar.gz` | `302` → `206`, 11 979 282 B |
| `…/electron/electron/releases/download/v44.2.0/SHASUMS256.txt` | `302` → `206`, 6 740 B |
| `…/electron/electron/releases/download/v44.2.0/electron-v44.2.0-linux-x64.zip` | `302` → `206`, 122 996 717 B |

(Range request for one byte each; nothing downloaded in full, nothing cached.)

`githubstatus.com/api/v2/incidents.json`: no incident covering 2026-09-21
15:00–15:30 UTC (most recent prior entry 2026-09-20 22:13 UTC, Pull Requests).
So: no publicly declared outage, and the assets are healthy from this network.
Neither fact proves the runners' edge is healthy now.

### 7. Release state (unchanged, read-only)

- Tag `v0.14.0` → tag object `d63485e1ed350fde73f2ce6011a415b7c8d9b306`, candidate commit `ac0985979337b5494484c0bc9c91e2d9e8663305`.
- `GET /releases/tags/v0.14.0` → **404**: no release, not even a draft. Nothing public was created.
- Run artifacts: `linux-arm64`, 695 831 217 B, created `15:16:46Z`, `expired=false` (7-day retention). `linux-x64` does not exist.
- Checkpoint `.git/lasercode-release/v0.14.0.json`: `stage: "tag-pushed"`, `lastError: ".github/workflows/release.yml run 35616858358 attempt 3 finished failure."`, no live lock directory. The orchestrator exited cleanly; a resume is available.

### 8. Exposure, for context

`release.yml` caches the pnpm store only. There is no cache of
`~/.cache/electron-builder`, so **every** build attempt re-fetches from GitHub:
the Electron zip (123 MB), its `SHASUMS256.txt`, the AppImage toolset (12 MB),
`fpm` and `7zip`. Five release-asset requests per architecture per attempt, each
with a 4-attempt/12-second budget, all of them a hard failure of the release.

## Recovery options (all need approval; none executed)

### R1 — re-run the failed job of the existing run (recommended)

```bash
gh run rerun 35616858358 --failed        # attempt 4: build x64, then publish
# then, only after the run leaves "completed/failure":
node scripts/release/release.mjs 0.14.0 --publish --resume \
  --source 08ebe228b6d3e396b56494f17cf9d78a4ee8b9b5
```

Why this is the smallest safe path:

- Same run id, `event=push`, `head_branch=v0.14.0`, `head_sha=ac098597…`, so
  `release.mjs#selectWorkflowRun` (which matches on exactly those, and takes the
  highest `run_attempt`) still adopts it. Every existing gate stays in force.
- No new tag, no source change, no manual upload, no change to the signer
  workflow path that `install.sh` pins.
- arm64 is not rebuilt; its attempt-1 artifact is reused.

Ordering matters: `waitForWorkflow` throws the moment it sees the run
`completed` with a non-success conclusion, so the re-run must be triggered
**before** the resume, and the resume started once the run is queued/in progress.

Residual risks to accept knowingly:

1. If the 504s are still happening on that runner pool, attempt 4 fails the same
   way in ~3.5 minutes. That is the whole cost. It is not a blind retry: §6 shows
   the assets serve normally now, and §3–§4 show the failure is an upstream HTTP
   status with no local cause — but the runner's own egress cannot be probed
   from here without dispatching a workflow, which is out of scope for this pass.
2. `publish` must find the `linux-arm64` artifact uploaded in attempt 1.
   Artifacts are run-scoped and the API lists it for this run, unexpired — but if
   `actions/download-artifact@v8` resolves artifacts per *attempt* rather than
   per run, the publish job fails with "artifact not found". That failure is
   harmless (publish creates nothing until every asset verifies) and is the
   trigger for R2.

### R2 — re-run all jobs (fallback for risk 2 only)

`gh run rerun 35616858358` rebuilds both architectures from the same tag.
Caveat to check before running it: `actions/upload-artifact@v7` refuses a name
that already exists on the run, so the attempt-1 `linux-arm64` artifact may make
the arm64 upload fail with a conflict. Deleting that artifact first is an
external state write and needs its own approval.

### R3 — `workflow_dispatch` with a hardened workflow on `main` (not recommended now)

A dispatch builds `inputs.tag` with the workflow file from `main`, so a CI-only
mitigation (cache `~/.cache/electron-builder`, widen the retry ladder, or set
`ELECTRON_BUILDER_BINARIES_MIRROR`) could be applied without re-tagging. But
`release.mjs` only adopts runs with `event === "push"`, so the orchestrator could
neither verify nor resume from it, and `publish.sh`/provenance would be produced
by a run the release transaction does not recognise. That makes it an
orchestrator change under review, not a recovery. Keep it for a later hardening
task.

### R4 — abandon the candidate and re-cut

Not warranted: the source, tag and checkpoint are sound, and nothing public
exists to clean up. Re-cutting would discard a passing exact-source CI run and a
good arm64 build for an external HTTP error.

### Explicitly rejected

Building x64 locally and uploading it, disabling checksums, pointing the toolset
download at a non-GitHub mirror for this release, or publishing a release page
before both architectures exist. Each breaks a provenance or ordering gate that
`install.sh` and `publish.sh` enforce.

## Hardening candidates for a later task (not part of this recovery)

1. Cache `~/.cache/electron-builder` (and the `downloads/` subtree) in
   `release.yml`, keyed by the Electron version and the toolset pins, so a
   transient GitHub 504 cannot fail a release whose bytes were already fetched.
2. Widen the 4-attempt/12-second ladder for release builds, where a slow retry is
   always cheaper than a failed release.
3. Report the misleading `progress=100%`-on-error line upstream
   (`app-builder-lib/out/util/electronGet.js`, progress callback): a non-2xx
   response is logged as a completed download and hides which request failed.

## Reproduction notes for whoever reads this next

- Full x64 logs used: `/tmp/laser-m26-x64-build.log` (attempt 1),
  `/tmp/laser-m26-x64-retry.log` (attempt 2), `/tmp/laser-m26-x64-debug.log`
  (attempt 3, runner debug on).
- arm64 log fetched read-only with
  `gh api --allow-escape-sequences /repos/youssefsiam38/laser/actions/jobs/106395496089/logs`.
- got behaviour on 504 was reproduced against the workspace's own
  `got@11.8.6` with a local throwaway HTTP server; nothing external was touched.
