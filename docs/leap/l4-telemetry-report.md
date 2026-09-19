# L4 telemetry column — report

Milestone: source-control leap **L4, telemetry half** (M18-T4 / §4 Part B). Ready for the orchestrator’s review and the person’s visual UAT. Not claimed as the leap being done.

Branch: `agents/l4-telemetry-column-6c916e30` (rebased onto `12a3f9e6`, which already carries L1, L2, L3, L5).

## What was built

The monitor column now renders the authority’s `pi/session/telemetry` snapshot, not the loaded page.

| Surface | Content |
| --- | --- |
| Scope bar | `Whole session · N records · M compactions`. No blanket apology. |
| Context | Ring (`ContextDisplayRing`), window size, auto-compact threshold/state. Composition (tools / chat / thinking / system) when `context.composition` is present; otherwise that figure says it is missing. Durable snapshots with no `context` say **Live window only** on that figure. |
| Spend | Per-model API lines (child roll-up is already in the query) plus account allowance when billing is `account` or `mixed`. Mixed shows **both**, not tabs. No API cost is **one line**. |
| Model | Provider, id, thinking, context window; per-turn token sparkline (`Chart` bars). |
| Work | Turns, wall-clock duration, ranked tool bars, named failed calls. Replaces the thread-derived Tools timeline. |
| Files | `pi/project/changes` with `scope: "session"`, grouped by repository, per-file `+/−`, totals. A row calls `openChanges({ scope: { kind: "session" }, repo, path, sessionKey })`. |
| History | Prompts, records, compactions, branches from the authority; held count is `rows.length` of the loaded page (`N of M` on that figure). Checkpoint tree unchanged for fork/jump. |

Every section is collapsible. The header number stays visible while collapsed. Pointer and keyboard both toggle.

Home: `packages/ui/src/components/telemetry/`. `shell/TelemetryPanel.tsx` is the chrome and the two queries.

## Decisions for the orchestrator (`D-<n>`)

1. **Spend mixed shows both, not Account/API tabs.** Settled decision 2 is “both”; hiding one behind a tab was the old monitor.
2. **Token-flow meters (input / output / cache) left Spend.** §4.2 Spend is per-model + allowance. Those five empty meters were the “one line, not five” case.
3. **Work replaces Tools.** The column no longer reads `useThreadToolTimeline`. `shell.toolsOpen` is unused by this panel; leave it for the orchestrator (shell-context is shared).
4. **`historyRows` stays.** It is CheckpointHistory’s loaded-page tree, not a session total (L3). Callers: History section + `test/shell/model.test.ts`.
5. **Files import `openChanges` from `source-control/store.js`, not the barrel.** The barrel re-exports `ChangesOverlayHost` and would pull `@pierre/diffs` into the column graph (D-317).
6. **Context breakdown element not installed.** `docs/ux-elements.md` claims it for a `contextUsage.breakdown` that still does not exist. Composition is drawn in `telemetry/context-section.tsx` with `--live` / `--ok` / `--attention` / `--ink-3`. Installing into `elements/` is outside this ownership.

## `docs/ux-elements.md` rows followed

| Element | Use |
| --- | --- |
| Context display | Ring in Context |
| Cost meter | API spend, per-model lines |
| Chart | Per-turn token sparkline (Model) |
| Checkpoints | History tree |
| Number ticker | not used for settled counts (plain tabular) |
| File tree | **not used** — git groups replace `useSessionFileChanges` |
| Tool timeline | **unmounted** from this column |
| Spec sheet | not mounted; Model is identity + sparkline |
| DiffStat (`code-diff`) | Files `+/−` |
| Hint | Full path on a Files row |

## Tokens added

None. Composition and bars use existing `--live`, `--ok`, `--attention`, `--ink-3`, `--danger`. Both themes already map them.

## Commands and results

```
pnpm install --frozen-lockfile
  # failed: ERR_PNPM_MISSING_TARBALL_INTEGRITY on
  # @modelcontextprotocol/client@https://pkg.pr.new/... (no integrity in lockfile)
  # Pre-existing on this main; not introduced here.
pnpm -F @lasercode/protocol build     # after identity fix in tests
pnpm -F @lasercode/ui test:types      # clean
pnpm -F @lasercode/ui exec vitest run # 287 files, 2698 passed, 1 skipped
pnpm -F @lasercode/ui typecheck       # clean
pnpm -F @lasercode/ui build           # Vite green (existing ::highlight warnings only)
pnpm identity:check                   # after git add of new files
```

`pnpm -F @lasercode/ui test` is `test:types && vitest run`; both halves green when run as above. `view-cache.test.ts` passed in this run (40 tests). No browser / Playwright / `scripts/browser-check`.

`@pierre/diffs` was not in this worktree’s `node_modules` because the frozen install failed. Typecheck/build of `source-control/diff-body.tsx` needed a local extract of `@pierre/diffs@1.4.3` into `node_modules/@pierre` (not committed). A full install on a machine whose lockfile/pnpm accepts the MCP tarball will supply it.

## Gaps (not invented)

| Gap | Exact field / wiring |
| --- | --- |
| Context composition | `TelemetryContext.composition` (`tools`, `chat`, `thinking`, `system`). Absent until the engine exposes a live-request breakdown (L3). UI degrades on that figure. |
| Overlay host | `ChangesOverlayHost` is **not** mounted. Files rows call `openChanges`; nothing paints until the orchestrator mounts the host (L5 report, call site 1). |
| Overlay data | Overlay still defaults to the mock adapter. This column’s Files **list** is `pi/project/changes`. Opening a row will show mock diffs until `setChangesAdapter` is wired to `pi/project/file_diff` / `file_source`. |
| `toolsOpen` | Still on `ShellContext`; this column no longer reads it. |

## What to look at first in visual UAT

1. Scope bar on a long session: `Whole session · … records · … compactions`. No “loaded so far”.
2. History collapsed: header shows `N of M` when the client holds a page; expand for counts + tree.
3. A session with no API cost: Spend is one line, not empty meters.
4. Mixed billing: API per-model **and** allowance on screen together.
5. Context without composition: the missing-breakdown sentence on that figure only.
6. Files: repo groups, `+/−`, a row should try to open the overlay (blank until the host is mounted).
7. 320px, both themes, mouse and touch: section headers 44px on coarse pointers; nothing smaller than 12px; no horizontal page scroll.

## Corrections (independent review batch)

Branch: `agents/telemetry-column-corrections-25ffe591`. One correction batch for B1–B3, S1–S9 and the listed nits. Composition and auto-compact already come from the engine (L3); this batch does not reopen that.

### Blockers

| ID | Fix |
| --- | --- |
| **B1** | Context section mounts `ContextRingButton size={64} stroke={3} showLabel side="left"` (same `contextUsage` as the composer/top bar). Clicking opens the window-health inspector. Fallback ring only when `contextUsage` is absent. Test: `opens the window-health inspector from the context ring`. |
| **B2** | `filesHeader(totals, status)`: `—` while idle/loading, `Failed` on error, counts only when ready. Covered beside the pruned case. |
| **B3** | Files errors go through `personFacingChangesError` with `Could not read the changes. Try again.` A telemetry read failure `console.warn`s the engine string and is `error`, never rendered. |

### Should-fix

| ID | Fix |
| --- | --- |
| **S1** | Deleted `elements/tool-timeline.tsx` and `shell.toolsOpen`. File tree **kept**: `fileTreeFromChanges` is the overlay rail's tree helper (`source-control/rail.tsx`). Stripped the unused thread-derived `useSessionFileChanges` / `fileChangesFromParts`. Catalog rows updated (below). |
| **S2** | Did **not** install Context breakdown. The catalog element is window occupancy (prompt/tools/files/conversation/remaining). What we have is four live-request **estimates** (tools/chat/thinking/system, chars/4). Feeding them into that element would present estimates as occupancy. Composition stays in `telemetry/context-section.tsx`. Catalog row amended with that reason. |
| **S3** | Composition fills are `--live`, a 55% live mix, `--ink-2`, `--ink-3`. No `--ok` / `--attention` as category colour. |
| **S4** | Removed hand-rolled Enter/Space on native `<button>`s (`section.tsx`, Files rows). Tests assert `click()` plus focusability; they no longer dispatch a synthetic keydown (jsdom does not click a button on Enter). |
| **S5** | Files paths use `suffixTruncate(path, PATH_BUDGET)` so the filename survives. |
| **S6** | Scope bar: `Reading session…` while loading, `Could not read this session's totals.` on error, `Session totals unavailable` if ready with no history. `Whole session · …` only when history arrived. |
| **S7** | `useSessionChanges` keys on path/cwd plus a `refreshKey`, not `telemetry.revision`. Key bumps on settle (`running`/`compacting` falling) and an explicit Files refresh. |
| **S8** | Authority already downsamples the **whole session** to `TELEMETRY_SERIES_MAX` (64), even sampling — not a last-N window. The column also caps at 64; if a payload is longer the figure says `Tokens per turn · last 64`. |
| **S9** | `idle` is its own branch: `No working directory to read yet.` |

### Nits

- Work count: `min-w-8` without fixed `w-8`, so four-digit counts do not overflow the name.
- `other` is appended after max is taken from named ranks **and** the other count; React key is `__other__` so a tool named `other` does not collide.
- `hasApiCost` is a type guard; `work!` / `changes!` / `spend.api!` replaced by narrowing.
- Repo labels use the last two path segments (`a/app` vs `b/app`), full path still the title.
- `HistorySection` re-export dropped; tests import `@/components/telemetry/history-section.js`.
- Composition bar is `aria-hidden`; the labelled counts are the accessible content (no four `role="meter"` spans).
- `workDurationText`: `durationMs <= 0` → `No timestamps`.
- Queries live in `telemetry/queries.ts`.

### `docs/ux-elements.md` rows changed

| Element | Why |
| --- | --- |
| Tool timeline | Unmounted; file removed. Work histogram replaced it. |
| File tree | Overlay rail uses `fileTreeFromChanges`; telemetry Files is git groups. |
| Number ticker | Not on the monitor; StatusLine and the agents map only. |
| Chart | Model `tokenSeries` from `pi/session/telemetry`, capped at 64. |
| Cost meter | `telemetry.spend.api`, not `usageByModel()`. |
| Context breakdown | Not installed; estimates ≠ occupancy (S2). |
| Context display | Telemetry Context section mounts `ContextRingButton` 64/3/label/left. |
| Code diff | `DiffStat` reuse no longer names tool-timeline. |

### Validation

```
pnpm install --frozen-lockfile     # ok
pnpm -F @lasercode/ui typecheck    # clean
pnpm -F @lasercode/ui build        # Vite green (existing ::highlight warnings only)
pnpm identity:check                # after staging new files
```

Focused: `vitest run` on telemetry-panel/format/query/history, file-tree, streaming-touch, tool-diff-summary, beam/spark+bubble, chat-navigation, denied-command-palette — all green (82 tests in that slice; telemetry-panel 17).

`pnpm -F @lasercode/ui test` (`test:types && vitest run`): `test:types` fails on **pre-existing** duplicate keys in `test/runtime/environment-capabilities.test.ts` (git/PR methods listed twice on this main). Not this batch.

Full `vitest run`: 2709 passed, 1 skipped, 32 failed. Failures are the known load-flaky set (`request-dialog`, `request-dialog-live`, `output-fold`, `trim-interaction`) plus `logs/released-body.test.tsx`, which passes focused. Not this batch. No browser / Playwright / `scripts/browser-check` / `pnpm verify`.
