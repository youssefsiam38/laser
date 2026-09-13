# Open problems — handoff brief

Written 2026-09-13, against `main` at the 0.6.1 release. Repository
`/home/youssef/projects/laser`. Read `AGENTS.md` first: it is binding, and it
decides most of what "done" means here (tokens not literals, both themes, both
widths, evidence for every claim, no AI attribution in commits).

Everything below is stated as: what a person experiences, what is measured, where
the code is, what "fixed" means, and what must not be done. Where a cause is
unproven, it says so — do not present a guess as a root cause.

Common commands:

```sh
export PATH=$HOME/.nvm/versions/node/v24.11.1/bin:$PATH
pnpm -r build && pnpm verify          # full gate (build, typecheck, tests, release + harness tests)
pnpm -F @lasercode/ui test            # one package
node scripts/browser-check/run.mjs --target scripts/browser-check/targets/app.mjs \
  --fixture long --matrix --script scripts/browser-check/test/<name>.mjs
```

The browser harness (`scripts/browser-check/README.md`) runs an isolated host,
worker, stub provider and Chrome with a private HOME. Fixtures: `empty`, `short`,
`long` (240 messages), `huge` (2,000), `tools`, `agents`, `projects`, `mcp`.
Never point a check at personal data or a running daemon.

---

## P1 — The log store grows without bound and nobody can see it

**Severity: highest.** Silent disk consumption, worst for the heaviest users.

### What happens

`~/.local/share/lasercode/state/logs.db` reached **27.7 GB in 8 days** of ordinary
use on the reporter's machine (26 GB for the whole state directory; everything
else in it is under 30 MB). Nothing in the UI shows the size, and nothing had
ever deleted a row.

Measured on that store:

| Fact | Value |
| --- | --- |
| `entries` rows | 139,296 |
| `content` rows (bodies) | 47,198 |
| `provider_request` rows | 25,148, holding **27.2 GB** |
| average request body | ~1.08 MB |
| tool output (`tool_end`) | 0.26 GB |
| provider responses | 22 MB |
| growth | 3.9 / 7.7 / 9.9 / 5.9 GB on four consecutive days |
| `freelist_count` | 0 (nothing was ever deleted) |

Each `provider_request` body is the *entire* conversation prompt for that turn.
A long conversation re-sends its whole history every turn, so the store keeps
one full copy of the conversation per turn.

### Why nothing trimmed it

`packages/host/src/logstore.ts`:

- `:272` `maxRows ?? 200_000`, `:274` `maxAgeDays ?? 14` — the only two limits.
- At 139k rows and 8 days, **both are inside the limit**, so `prune()` (`:589`)
  and `schedulePrune()` (`:558`) had never deleted anything.
- There is **no byte budget at all**, and no separate limit for the `content`
  table where the bodies live.
- No `VACUUM` / `PRAGMA incremental_vacuum` anywhere: SQLite does not return
  space to the file, so even after a prune the 27 GB file stays 27 GB. Schema
  setup is at `:207` (`journal_mode = WAL`, `synchronous = NORMAL`); there is no
  `auto_vacuum`.

### Done when

- A byte budget bounds retained request/response/tool bodies, enforced as rows
  are ingested, not only on a timer. Row and age limits stay.
- Space is actually reclaimed (incremental vacuum or equivalent), proven by the
  file shrinking in a test with a real temporary store, not by a row count.
- `pi/logs/stats` already reports `bytes` (`packages/protocol/src/messages.ts:773`,
  `logstore.ts:536` via `fileBytes()` at `:613`). Settings shows the size and a
  Clear, written for a person, with tokens and no raw `px`.
- A test proves an ingestion burst of large bodies settles at the budget, and
  that pruning never deletes a body an entry still points at (orphan sweep is at
  `:571`).

### Decide first (needs the person's answer; ask, do not assume)

What the API request inspector must still be able to open. The proposal on the
table is: **full bodies for the most recent ~50 requests per session, summary
only (model, message count, size, timing) beyond that**. The inspector is
`packages/ui/src/components/logs/ApiRequestDialog.tsx` and
`packages/ui/src/components/logs/request-model.ts`; `pi/logs/content` serves
bodies (`logstore.ts:493`, capped at 4 MiB per read).

### Do not

- Do not silently drop what the inspector needs for recent turns; the request
  inspector is a real feature (`docs/search-content.md` covers its search rules).
- Do not touch a live `logs.db` from a script while a host may be running.
- Do not VACUUM on the host's request path in a way that blocks it; measure.

---

## P2 — The Logs page flickers while a session streams (cause unconfirmed)

**Reported by the person; not reproduced.** One real defect on that path was
found and fixed (`068be78`); it is *not* proven to be what they see.

### What happens

With the Logs page open while work streams in the same session, the page
flickers. The reporter is unsure of the exact trigger ("maybe with streaming
happening in the same session but not sure"). Their store is the 27 GB one from
P1 — that is the main difference from any synthetic reproduction.

### Already fixed (do not redo)

`packages/ui/src/components/logs/LogsScreen.tsx` built its `filters` identity
from the current session's `cwd` even when "This project only" was off. A
streaming turn changes that value, so `filters` changed identity, `reload()`
re-ran, and the rows were replaced and the view snapped to the bottom with
nothing about the filter changed. Fixed by deriving the identity from the
scoped project only.

### What is already known and measured

- The live tail appends and is correct: `LogsScreen.tsx:125` subscribes to
  `pi/logs/append` and merges with `appendRows` (`components/logs/model.ts:55`),
  capped at `ROW_CAP = 5000` (`:47`).
- `refreshStats()` (`:90`) runs on a 1500 ms debounce while following
  (`STATS_REFRESH_MS`, `:53`). On the 27 GB store the three statements behind
  `pi/logs/stats` (`logstore.ts:518`) measure **4 ms + 13 ms + 22 ms**, and
  `SELECT SUM(bytes) FROM content` is **40 ms** — all synchronous on the host
  loop. This is a candidate, not a proven cause.
- The rows are windowed by a hand-rolled virtual list (`LogsScreen.tsx:534`,
  `translateY(start * ROW_HEIGHT)`); `entries` changing re-slices it, and a
  `useEffect` (`:454`) pins the viewport to the bottom while following.

### Reproduction attempts that came back clean

`scripts/browser-check/test/logs-flicker.mjs` (new, keep it) opens Logs over a
session that is *really* streaming — a long answer sent from the composer,
arriving in ~120 deltas — and counts list replacements, loader appearances,
self-inflicted scroll jumps, row removals, detail-pane removals and
`pi/logs/query` re-queries. Zero of each, on both the old and the fixed build.
The stub provider gained `chunks` / `chunkDelayMs`
(`packages/worker/test/agents/stub-provider.ts`) and the fixture answer
`fixture-stream` (`scripts/browser-check/targets/fixtures.mjs`) for this.

### How to actually pin it

1. **Read the log.** Since 0.6.1 the desktop copies renderer console errors into
   `~/.local/share/lasercode/state/desktop.log`
   (`packages/desktop/src/windows.ts`, the `console-message` handler). Ask the
   person for the minute it last flickered and read that window.
2. Reproduce against a store of the reporter's *shape*: ~140k rows, ~25k
   provider requests with ~1 MB bodies. Build it synthetically (do not copy
   their file) and then open Logs while streaming. If the flicker appears, it is
   P1's store size expressing itself here and the fix belongs with P1.
3. Profile the page with the React profiler in the harness, as
   `docs/perf-streaming.md`-style work does, and name the committing component
   rather than inferring it.

### Done when

The flicker is either reproduced and fixed at its cause, or shown not to exist
on a store of that shape — with evidence either way. `logs-flicker.mjs` must
still pass, extended with whatever the reproduction needed.

### Do not

- Do not "fix" it by throttling renders or adding a transition that hides it.
- Do not claim the `cwd` fix above is the cause without a reproduction.

---

## P3 — Phone, dark theme, huge conversation: typing readiness misses its budget

**Measured, small, well understood.**

Returning to a 2,000-message conversation at 390 px in dark mode, the transcript
is ready to accept typing at **316 ms median / 337 ms p95**. The budget is 300 ms
median / 500 ms p95 (resident median 250 / p95 400 is met everywhere). The same
width, theme, conversation and build with reduced motion measures **159 ms**, so
the cost is the transition animation, measured rather than inferred.

Evidence: `.git/coordination-recovery/C-FIX-timing-summary.json` and
`C-controlled-evidence/`; the harness script is
`scripts/browser-check/test/transcript-window-phone.mjs` (and
`…-phone-reduced.mjs` for the motion-off comparison). Budgets and the policy
behind them: `STATUS_DETAILED.md` M16-T29, decisions D-231 / D-236 / D-238.

**Done when** the dark phone case meets 300 ms median on the same build, the
motion still exists (`prefers-reduced-motion` remains a fallback that loses only
the movement, per `AGENTS.md`), and the 20-paired-sample measurement is redone
on the final bytes. **Do not** relax the budget, and do not remove the animation.

---

## P4 — The release orchestrator cannot resume once remote main moves

**Process defect, not user-facing. It cost a manual verification today.**

`scripts/release/release.mjs` published 0.6.1 correctly (tag, CI, upload,
publication), but its checkpoint
`.git/lasercode-release/v0.6.1.json` stopped at `stage: "tag-pushed"` — the
verification stage never recorded. Re-running the exact authorized command to
resume refuses:

```
release: Reviewed source 3ea2b3d… is not a fast-forward of remote main ed97523…
```

because the release's own candidate commit is now remote main, so the source it
was told to verify is behind. The publication itself was fine — verified by hand
against the API: not a draft, Latest, 12 assets, and all nine installer digests
equal to the published `SHA256SUMS`, provenance present.

**Done when** a resume after the tag exists can complete the verification and
checkpoint stages without being blocked by remote main having advanced to the
candidate it created, and a test covers that ordering. `scripts/release/README.md`
documents the stages; regression tests are `node --test scripts/release/test/*.test.mjs`
(part of `pnpm verify`). **Do not** weaken the fast-forward check for the
*pre-push* stages — it is what stops a release from an unreviewed source; only
the post-tag resume path should tolerate it. D-223 defines what "verified" means
and must keep meaning.

---

## P5 — MCP script runtime has no way to ask the person for permission

**Built, reviewed, deliberately unshipped (D-240).**

The backend for running model-written MCP helper scripts in a bounded QuickJS
interpreter is complete and independently reviewed on the branch
`agents/mcp-cache-fe11b683` (worktree `.worktrees/mcp-cache-fe11b683`, commits
`36c05e2`, `9c26bac`, `5b089fe`, `537a4c9`). It is **not** merged to main and
must not be until:

1. A person can see and answer a gated MCP call in the transcript. The backend
   already sends a typed `mcpApproval` payload on the existing portable select
   request (`pi/ui/request`), carrying the resolved target, the complete
   arguments and the scope options; `UiBridge.askMcpApproval` is the entry point.
   The renderer belongs beside the existing inline tool approvals
   (`packages/ui/src/dialogs/`), per `docs/ux-elements.md`, and the full
   arguments must be reviewable (expandable), with allow-once / allow-for-this-run
   / deny, keyboard and touch, outside any disclosure fold.
2. The packaged gates pass: `node packages/desktop/scripts/clean-machine.mjs` on
   a packaged build, with the QuickJS Wasm asset actually loading and executing
   from `out/*-unpacked` with the bundled Node and an empty `PATH`. Only
   **linux-x64 from source** has been exercised. Laser currently ships Linux
   x64 + arm64 (`.github/workflows/release.yml`); Windows/macOS must stay
   possible but are untested.

Read in this order: `.git/coordination-recovery/MCP5-PLAN.md` (the approved
contract), `MCP5-REPORT.md` (what was built, with its honest gaps),
`MCP5-REVIEW.md` (the review and its four corrected blockers). Decisions
D-230 (the model never manages servers), D-233, D-237, D-239, D-240 are binding.

**Do not** claim a user-facing capability before the renderer exists, do not
change the permissive default permission policy as part of this, and do not
replace the pinned SDK's own output validation (D-239).

---

## Things that are done — do not redo them

- **The black window on scrolling up (0.6.1, `1859e4a`).** Cause: transcript
  rows were `MessagePrimitive.Root`, which dispatches "not hovering" into thread
  state as it unmounts; the bounded transcript unmounts many rows per commit, and
  the cascade exceeded React's nested-update limit — an uncaught throw that
  unmounted the tree. Rows are a plain root now (`messages.tsx`, `MessageRoot`),
  there is an app-root error boundary (`packages/ui/src/AppErrorBoundary.tsx`),
  and renderer errors reach the desktop log. Regression:
  `scripts/browser-check/test/scroll-up-blank.mjs` (takes `SCROLL_SESSION=<a real
  session .jsonl>`; the synthetic fixtures never reproduced it). D-241.
- **The viewport fighting the reader, and earlier pages not loading at the top**
  — same commit: layout may shift the view by what changed above the anchor but
  never re-place it while the person is reading, and wheel/swipe/↑ at the top
  requests the earlier page.
- **Sidebar seven-row rule** (`5e77d08`): seven ordinary rows, only live work
  exceeds them, returns to seven by itself.
