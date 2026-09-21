# M21 · transcript focus loss under the list's own DOM-order pass

Investigation only. No production, patch, dependency or planning file was
changed by this report; the two instrumentation files it cites were temporary
and are not in the tree (copies: `/tmp/m21-transcript-focus/`).

- Base: `9bcdd23a` · branch `agents/diagnose-transcript-focus-regression-645832b4`
- Dirty at write time: this file only.
- Area: transcript viewport / windowed list / view cache focus identity.

## The failure this explains

`/tmp/laser-interop-image-merged-verify.log`:

- line 728: `test/thread/trim-interaction.test.tsx (9 tests | 1 failed) 16145ms`
- line 735: `× a trim while somebody is reading > keeps the active logical
  transcript, focus, place, draft and action identity above soft targets` (1252 ms)
- line 736 / 3014: `expected <body>…</body> to be <button …>` — i.e.
  `document.activeElement === document.body` at
  `test/thread/trim-interaction.test.tsx:503`
- lines 5192-5193: UI `1 failed | 3299 passed | 1 skipped`; every other suite green.

Everything else in that test passed: the earlier focus assertion (line 451),
`standingRows(SESSION)?.focusedEntryId`, the row count, the anchor's top, the
blocks/entries identity, the "no empty frame" observer and the byte/overflow
counters. Only the browser's focus was gone.

## Proven cause

**The list's own debounced DOM-order pass moves the row container the focused
action lives in, and where `Element.moveBefore` does not exist the fallback
`insertBefore` is a remove-and-insert, which blurs it.**

The chain, all of it read from the installed pinned sources:

1. `@legendapp/list@3.3.5` `useDOMOrder`
   (`packages/ui/node_modules/@legendapp/list/react.mjs:5733-5765`) subscribes to
   `lastPositionUpdate` and, **500 ms after the last position update**, calls
   `sortDOMElements(parent, indexByElement)` to re-sort the row containers into
   index order. It is a `setTimeout(…, 500)` debounce, rescheduled by every
   position update, cancelled only on unmount.
2. `sortDOMElements` (`react.mjs:5652-5696`) moves every container outside the
   longest increasing subsequence through `moveChildBefore`.
3. `moveChildBefore` is ours — hunk 2 of `patches/@legendapp__list@3.3.5.patch`
   (`react.mjs:5640-5650`): `container.moveBefore(...)` when it exists,
   otherwise `insertBefore` / `appendChild`.
4. `Element.moveBefore` is the state-preserving ("atomic") move: it keeps focus,
   iframe content and animation state. `insertBefore` of a node that is already a
   child is a removal followed by an insertion, so the browser blurs anything
   focused inside the moved subtree. Support: Chrome/Edge ≥ 133, Firefox ≥ 144,
   **Safari and iOS Safari: not supported** (MDN `Element.moveBefore`;
   caniuse `wf-move-before`; web-features `move-before` = Limited availability).
   happy-dom 20.14.0 has no `moveBefore` either — verified:
   `typeof document.body.moveBefore === "undefined"`.

### Instrumented evidence

Probe 1 — capture the pending 500 ms debounce, fire it at its boundary, and log
every move the list makes on the box it positions rows in
(`/tmp/m21-transcript-focus/zz-focus-probe.test.tsx`, diff `probe1.diff`):

```
[probe before trim] debounced-passes=1 moves=9 active=BODY/body action.isConnected=true rowHoldsAction=true standing=e10
[probe before trim]   insertBefore(DIV row=entry:e10 top=1500px) active LOST -> BODY
[probe before trim]   insertBefore(DIV row=entry:e11 top=1596px) active kept
…  (nine containers, entry:e10 … entry:e21)
[probe after trim]  debounced-passes=0 moves=0 active=BODY/body action.isConnected=true rowHoldsAction=true standing=e10
```

Read it exactly: the focused row's own container is the **first** thing moved,
focus goes to `<body>` on that call, the button stays connected, the row keeps
holding it, and Laser's standing `focusedEntryId` is untouched. The trim is
innocent — at the trim point there is no pending pass and no move at all.

Probe 2 — same test, no global patching: fake only `setTimeout`/`clearTimeout`
and advance the list's real debounce once, after the trim
(`/tmp/m21-transcript-focus/zz-focus-probe2.test.tsx`, diff `probe2.diff`):

```
[probe2 before advance]     active=THE ACTION scroll=1944
[probe2 fake-clock 500ms]   active=BODY/body connected=true rowHolds=true scroll=1944->1944 standing=e10
→ AssertionError at zz-focus-probe2.test.tsx:533 (the line 503 assertion)
```

Probe 2 with the proposed repair applied at the same seam (`PROBE_REPAIR=1`
wraps the container's fallback move exactly as the patch hunk below would):

```
[probe2 fake-clock 500ms]   active=BUTTON/THE ACTION connected=true rowHolds=true scroll=1944->1944 standing=e10
→ 1 passed (every existing assertion in the test, unchanged)
```

Commands (this worktree, base `9bcdd23a`):

```
pnpm -F @lasercode/ui exec vitest run test/thread/trim-interaction.test.tsx        # 9 passed (2.6 s) — isolation hides it
pnpm -F @lasercode/ui exec vitest run test/thread/zz-focus-probe.test.tsx  -t "keeps the active logical"   # 1 failed, logs above
pnpm -F @lasercode/ui exec vitest run test/thread/zz-focus-probe2.test.tsx -t "keeps the active logical"   # 1 failed
PROBE_REPAIR=1 pnpm -F @lasercode/ui exec vitest run test/thread/zz-focus-probe2.test.tsx -t "keeps the active logical"  # 1 passed
```

### Why the gate saw it and isolation does not

The failing assertion is behind a wall clock. In isolation the whole test body
runs in ≈310-350 ms (probe runs above), so the 500 ms debounce never fires
before the assertion; in the integrated gate the same test took **1252 ms**
(log line 735), the pass fired inside one of the `await act(...)` boundaries and
focus was gone by line 503. Nothing about it is a harmless flake: the test is
timing-dependent by construction (it neither drives nor fences the list's own
pass), and the behaviour it caught is real on an engine without `moveBefore`.

## Fixture scheduling vs product focus loss — both, and they are separable

| | verdict |
| --- | --- |
| Fixture scheduling | **Defective.** The test lets the list's 500 ms pass land wherever the machine's load puts it. It must drive that pass deterministically and assert focus *after* it. |
| Product focus loss | **Real, engine-conditional.** On Electron 44 (Chromium ≥ 133, `moveBefore` present) the desktop app is unaffected. On **iOS Safari / Safari** — the M7 phone surface — and on Firefox < 144, every DOM-order pass that moves the row holding focus blurs it to `<body>`: the focus ring disappears, `Tab` restarts from the top of the document and an assistive-technology cursor is thrown out of the conversation. Laser's own bookkeeping survives (the `focusout` handler ignores a null `relatedTarget`, `transcript-viewport.tsx:816-822`, so the row stays pinned), so nothing but the browser's focus is lost. |
| View cache / trim | **Not implicated.** `cache.observeTransaction` + `cache.maintain` produced no DOM move and no pending pass (probe 1, "after trim"). |
| Geometry stub | **Not implicated.** `sortDOMElements` reads the list's own `containerItemIndex*` state, never a rectangle. |

Unproven, deliberately: how often a real conversation's DOM order drifts from
index order on a phone (the mechanism is library-internal; the *frequency* in
the product is not measured here), and whether a native text selection inside a
moved row survives the fallback — it almost certainly does not, and that is a
separate finding, not this fix.

## Canonical owner and seam

`moveChildBefore` in `patches/@legendapp__list@3.3.5.patch` — hunk 2, the
function this repository already added, in both `react.js` and `react.mjs`.
That is the one place that knows a state-preserving move was wanted and did not
happen. The patch belongs to M16-T91 (`STATUS_DETAILED.md:2472`), which owns the
list and its three web hunks; this is a fourth correction to the same function,
not a new authority.

Rejected alternatives, with reasons:

- **A Laser-side focus keeper** (restore focus when the transcript's focus drops
  to `<body>`): it cannot tell the library's DOM move from a person deliberately
  clicking dead space, so it would steal focus back from the person. It also
  puts a second authority over focus beside the list. No.
- **Laser monkey-patching the container's `insertBefore`**: the same fix, applied
  from outside the library, at a seam we do not own. Worse than the patch.
- **Bumping or replacing the list**: the invariant is an exact pin (architecture
  invariant 4 in spirit, `docs/transcript-virtualization.md`); `moveBefore` is not
  Baseline, so no upstream version removes the fallback.

## Proposed correction (smallest complete)

### 1 · Patch hunk, `moveChildBefore`, both `react.js` and `react.mjs`

Keep the focused node inside the moved subtree when the fallback path runs, and
never scroll doing it:

```js
function moveChildBefore(container, element, reference) {
  if (typeof container.moveBefore === "function") {
    container.moveBefore(element, reference);
    return;
  }
  // Without the state-preserving move (Safari, and test DOMs), an insert is a
  // removal and an insertion: the browser blurs whatever had focus inside the
  // subtree being moved. Put it back on the same node, without scrolling.
  const doc = container.ownerDocument;
  const active = doc ? doc.activeElement : null;
  const focused = active && active !== doc.body && typeof active.focus === "function"
    && element.contains(active) ? active : null;
  if (reference) container.insertBefore(element, reference);
  else container.appendChild(element);
  if (focused && doc.activeElement !== focused && focused.isConnected) focused.focus({ preventScroll: true });
}
```

Four small hunks total (two files × the function), exactly the pinned `3.3.5`,
no other hunk touched, no version change, no lock regeneration. Probe 2 validated the
equivalent shape (`activeElement instanceof HTMLElement` rather than the duck
check above) as the behaviour that turns the failing test green with every
assertion intact and `scrollTop` unchanged.

Known limits to state in the patch comment, not to fix here: `contains` does not
cross a shadow boundary (Laser's rows have none), and refocusing an `iframe`
element restores outer focus only (the `moveBefore` path is the one that keeps
inner state).

### 2 · Lock and patch metadata — needs the parent's merge

`pnpm patch-commit` changes `pnpm-lock.yaml` in exactly three places (all the
`@legendapp/list@3.3.5` hash: `patchedDependencies` line 17 and two
`patch_hash=` references) plus nothing else, and leaves
`pnpm-workspace.yaml:24` alone. **The mention/SDK owner is editing a different
patch hash in the same file**, so `pnpm-lock.yaml` is a shared interface here:
I will produce only those three lines and the parent merges, or the parent
applies the hash itself after merging the patch. No `pnpm install` without
`--frozen-lockfile` beyond `patch-commit`, no unrelated lock churn.

### 3 · Tests (fail before, pass after, at the real integration boundary)

- `packages/ui/test/thread/trim-interaction.test.tsx`, the focus test: fake only
  `setTimeout`/`clearTimeout` for this test and advance the list's own debounce
  (500 ms, named and commented as `useDOMOrder`'s boundary) after the trim, then
  keep **every** existing assertion — exact focus node, `isConnected`, standing
  `focusedEntryId`, anchor top within one line, draft, prompt ordinal, row set,
  no empty frame. Add two: `viewport.scrollTop` unchanged across the pass (the
  repair must not scroll), and the row still holds the focused node. This is the
  regression test: it fails on `9bcdd23a` (probe 2) and passes with the hunk.
  No timeout is changed, no sleep is added, no assertion is weakened or skipped.
- One new focused case in the same file (or `transcript-viewport.test.ts`'s
  neighbour, whichever keeps the mounted fixture single): the same pass with a
  `moveBefore` present on the container — the repair must not run and focus must
  still be on the same node, so Chromium's path stays untouched.
- Optionally one keyboard-shaped case: focus moved by `Tab` rather than
  `.focus()`, to prove the repair is about the node and not the call.

### 4 · Docs

- `docs/transcript-virtualization.md`, "The pinned dependency and its patch":
  the fallback's correction becomes number 4 — why a remove-and-insert blurs the
  row and what the repair does (same node, `preventScroll`).
- `docs/upstream.md`: a row for `@legendapp/list` — the reordering fallback
  silently loses what `moveBefore` preserves (focus first, selection next);
  proposal: preserve focus in the fallback. Status "not filed" until filed.
- No `PLAN.md` / `STATUS*.md` edits from me; the parent owns the task row and
  the ledger. Suggested shape: a fix task under M16 beside T91, titled after the
  behaviour ("focus survives the list's own DOM-order pass"), evidence = the
  commit plus the focused UI command below.

## What the plan does *not* do

- No new Laser anchoring or geometry engine: the list keeps owning position,
  index order and its own pass. The repair touches focus only, after the move
  the list decided to make, inside the list's own function.
- No scroll: the repair is `focus({ preventScroll: true })` and the test pins
  `scrollTop` across the pass. A programmatic scroll repair is not needed and is
  not proposed.
- Reduced motion is unaffected: nothing animates, no transition is started or
  cancelled by the repair (and the existing `moveBefore` preference is exactly
  what keeps `@starting-style` transitions from restarting).
- No browser run: D-342 stands. The iOS/Safari half of this finding is an
  engine-support fact plus a unit proof through the fallback path that happy-dom
  takes anyway; **only the person can confirm on a real phone** — steps for them:
  focus a message action in a long conversation on iOS Safari, cause any scroll
  or history change, wait half a second without touching the screen, then press
  Tab (or move the VoiceOver cursor) and check that focus is still on that
  action.

## Validation planned for the fix

```
pnpm -F @lasercode/ui exec vitest run test/thread/trim-interaction.test.tsx
pnpm -F @lasercode/ui exec vitest run test/thread/transcript-viewport.test.ts
pnpm identity:check
```

Full `pnpm verify` stays the parent's: this change is UI-test plus one pinned
patch, and the gate it must re-green is the parent's integrated run.

## Risks

| Risk | Mitigation |
| --- | --- |
| The refocus fires an extra `focus`/`focusin` pair | Same row, same node; `transcript-viewport.tsx`'s handler recomputes the same id and `setStandingRows` dedupes on equality (`anchored-messages.ts:52`). Synchronous inside the same task, so nothing paints between. |
| A patch that grows with each finding | Four hunks in one function already ours; the upstream row is filed with the proposal so it can leave the patch. |
| `pnpm-lock.yaml` contention with the SDK-patch owner | Three lines, named above, parent merges. |
| Fake timers destabilising the fixture | Already validated: probe 2 faked only `setTimeout`/`clearTimeout` around the real mount and the fixture behaved identically (same rows, same anchor, same counters). |
