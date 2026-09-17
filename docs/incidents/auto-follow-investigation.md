# Auto-follow investigation

## Finding

The persistent failure is reproducible. The viewport can be physically at the bottom (`gap = 0`) while `Place.following` is false. A downward wheel gesture that cannot move because the viewport is already at the bottom does this on desktop; a tap does it on touch. The next passive event then grows below the fixed `scrollTop` and is not followed.

Primary source snapshot: `215a8689afd0c61a6641ba9ee3e1bdc45a8cdd2d`. During the investigation the shared checkout advanced to `25edc317942928ddd671d133be9f6c2194aa3250`; `git diff 215a8689..25edc317 --` over `transcript-viewport.tsx`, `Thread.tsx`, `transcript-window.ts`, `anchored-messages.ts`, and `tool-group.aui.tsx` was empty. The main matrix and focused desktop/touch failures used the first snapshot; the grouped-tool check used the later byte-identical viewport sources.

## Reproduction

The reusable scripts are in `/tmp` as required by the investigation boundary:

- `/tmp/auto-follow-browser.mjs` — fresh open, ordinary streaming, reasoning, tool call/result, disclosure growth, child event, coalesced attempts, and deliberate scroll-away; records every mutation/resize/scroll with geometry.
- `/tmp/auto-follow-batched.mjs` — 500 provider deltas delivered as a real same-frame notification batch, both normally and after a no-op bottom gesture.
- `/tmp/auto-follow-provider.mjs` + `/tmp/auto-follow-slow-tool.mjs` — two real shell calls in one expanded activity group; the second result lands after a delay.
- `/tmp/auto-follow-phone-touch.mjs` — the same investigation at 390 px with real touch capability.

Build and baseline matrix:

```bash
pnpm -r build
node scripts/browser-check/run.mjs \
  --target scripts/browser-check/targets/app.mjs \
  --fixture long --matrix \
  --script /tmp/auto-follow-browser.mjs \
  --artifacts /tmp/auto-follow-matrix
```

Focused persistent failure:

```bash
node scripts/browser-check/run.mjs \
  --target scripts/browser-check/targets/app.mjs \
  --fixture long \
  --script /tmp/auto-follow-browser.mjs \
  --artifacts /tmp/auto-follow-dead-input
```

1. Open the long session. Geometry is `scrollTop=5081`, `scrollHeight=5933`, `clientHeight=852`, `gap=0`.
2. Hover the viewport and wheel **down**. The browser cannot move: geometry remains exactly `5081 / 5933 / 852`, `gap=0`.
3. Start a turn from the host RPC, not the local composer. This is important: local Send calls `latest()` and hides the defect.
4. The first new render leaves `scrollTop` near `5087` while content grows. At settlement: `scrollTop=5087`, `scrollHeight=8087`, `clientHeight=852`, `gap=2148`.

Evidence:

- Metrics and ordered DOM trace: `/tmp/auto-follow-dead-input/run-uYRmKB/auto-follow-1360-light.json`
- Failure screenshot: `/tmp/auto-follow-dead-input/run-uYRmKB/auto-follow-dead-input-1360-light.png`
- Harness/build/process record: `/tmp/auto-follow-dead-input/run-uYRmKB/evidence.json` (`survivors: []`)
- Desktop result: physical gap remained `0` after the no-op wheel, then became and remained `2148` px.
- 1360 touch result: `/tmp/auto-follow-touch/run-Sx8lIU/auto-follow-1360-light-touch.json`, final gap `2186` px after a tap at physical bottom.
- 390 touch result: `/tmp/auto-follow-phone-touch/run-rf7kSv/auto-follow-390-light-touch.json`, final gap `2052` px after a tap at physical bottom.

Real same-frame batch:

```bash
node scripts/browser-check/run.mjs \
  --target scripts/browser-check/targets/streaming.mjs \
  --fixture long \
  --script /tmp/auto-follow-batched.mjs \
  --artifacts /tmp/auto-follow-batched
```

`/tmp/auto-follow-batched/run-Ul8uhz/auto-follow-batched.json` records:

- 500 deltas while genuinely following: 92 frame samples, maximum gap `0`.
- The same 500 deltas after a no-op downward wheel at `gap=0`: first visible gap `6433` px; final gap `6433` px.
- Negative control after a real 800 px upward scroll: it remained away, ending `7233` px from the new bottom.

Expanded activity group:

```bash
node scripts/browser-check/run.mjs \
  --target /tmp/auto-follow-provider.mjs \
  --fixture long \
  --script /tmp/auto-follow-slow-tool.mjs \
  --artifacts /tmp/auto-follow-slow-tool
```

`/tmp/auto-follow-slow-tool/run-gH6Dn6/auto-follow-slow-tool.json` shows the real second shell result landing in an already-expanded two-tool group. The final gap returned to `0`, but opening/growing the group exposed a visible transient gap up to `20` px. The baseline matrix saw the same disclosure race up to `45` px at 390/light. This is separate from the persistent no-op-input failure.

## Scenario evidence

`gap` means `scrollHeight - clientHeight - scrollTop`; live-edge acceptance is `<= 2` px. “Pass” below means the final geometry was pinned and no persistent gap appeared. Transient gaps are called out rather than rounded away.

| Scenario | Observed browser behaviour | Mechanism / evidence |
| --- | --- | --- |
| Fresh session open | **Pass**, all 1360/390 × dark/light cases opened at exact `gap=0`. | `configure()` starts with `following:true` and schedules placement (`transcript-viewport.tsx:130-143`); tail window selection is `heights.total - height` (`:178-187`). Matrix JSON files in `/tmp/auto-follow-matrix/run-VdGnh2/`. |
| Streaming assistant text while follow is intact | **Converges**, final `gap=0`; observer trace briefly saw up to 50 px between a DOM mutation and the next correction. The 500-delta same-frame batch stayed at `gap=0` for every sampled frame. | Running scroll events are classified as owned (`:425-435`, `:460-469`); row resize schedules measure/restore (`:447-453`, `:291-323`). Batch evidence: `/tmp/auto-follow-batched/run-Ul8uhz/auto-follow-batched.json`. |
| Tool call appears / result lands | **Pass**, final `gap=0` in matrix. | The message id append is a prefix append, so `followingGrowth=true` at `:149-152`; commit restore runs at `:326-339`. Matrix trace span `tool-before` → `tool-after`. |
| Result lands inside an already-expanded actions group | **Pass at settlement**, but disclosure growth exposed a transient 20 px gap; matrix disclosure reached 45 px. | Existing-row growth is caught only after outer-row `ResizeObserver` (`:447-453`). Separately, `ToolGroupRoot` calls `useScrollLock` before the new open state commits (`tool-group.aui.tsx:99-121`); the installed lock writes the old `scrollTop` back on every scroll until its timer ends (`useScrollLock.js:51-90`). |
| Reasoning appears | **Pass**, final and trace max `gap=0` in all four matrix cases. | It changes an existing row rather than ids, so the prefix branch at `:152` does not apply; the row observer/measure path at `:447-453` and `:291-323` handled this fixture. |
| Child sub-agent event arrives | **Pass** while follow is intact, trace max `gap=0` in all four cases. | It can arrive outside the parent's run, disproving `followRun(running)` as the sole trigger. Row/id commit and resize paths still re-pin while `Place.following` remains true. |
| Several updates in one React batch | **Pass** while follow is intact: 500 zero-delay deltas, maximum sampled gap `0`. **Fails** after the no-op gesture: final gap `6433` px. | Client notifications are coalesced per animation frame (`client.ts:676-705`). The previous prefix guard works only if `Place.following` was already true (`transcript-viewport.tsx:152`). |
| Row grows after first measurement / Markdown reflows | **Converges**, final `gap=0`; ordinary streamed Markdown showed transient observer gaps up to 50 px. | Outer-row height updates `HeightIndex` at `:301-310`, then restore at `:314-323`. Mounted rows force `content-visibility:visible` at `:663-667`. No decoded-image-only fixture was available, but it takes this same outer-row resize boundary; this must remain an explicit acceptance case rather than an inference. |
| Deliberate upward scroll while output arrives | **Pass** negative control: started 800–1000 px away and remained away (`1256`, `1292`, and `7233` px after content growth). | A real upward position change is the correct opt-out. Current code opts out earlier, at raw input (`:489-492`, listeners at `:574-576`), which is the defect. |
| Downward wheel at physical bottom | **Persistent failure**: `gap 0 → 2148`; batched case `0 → 6433`. | `wheel` calls `user()` unconditionally (`:489-492`, `:575`) and no scroll event follows because the browser cannot move. Nothing can recompute `following=true`. |
| Tap at physical bottom | **Persistent failure**: 1360 touch `0 → 2186`; 390 touch `0 → 2052`. | Every `touchstart` calls the same unconditional `user()` (`:575`). A tap is treated as deliberate reading even when no scrolling occurs. |

## Mechanism at file:line

### Proven root cause

1. `Place.following` is the hand-rolled authority used both for selecting the tail window (`transcript-viewport.tsx:178-187`) and for deciding whether commits/resizes restore the bottom (`:232-253`, `:314-323`, `:326-339`).
2. `user()` sets it false immediately (`:489-492`). `wheel` and `touchstart` call `user()` before the browser has changed `scrollTop` (`:574-576`); navigation keys do the same (`:520-525`).
3. At the physical bottom, a downward wheel, a tap, ArrowDown, PageDown, End, or Space can produce no scroll event. The only code that can geometrically set `following=true` is the scroll handler at `:460-487`, so the state remains false while geometry remains at exact `gap=0`.
4. Passive run start respects the stale false value (`followRun`, `:425-435`). Appends cannot set `followingGrowth` because its guard also requires stale `following=true` (`:149-152`). Commits then preserve the old location rather than bottom.
5. Windowing amplifies the miss: once `following=false`, `ranges()` no longer chooses `heights.total - height` (`:185-187`). In the 500-delta reproduction, the physical `scrollTop` stayed `11514` while virtual total height became `18799`, yielding a stable `6433` px gap. `HeightIndex` did not initiate the failure: the identical batch with `following=true` stayed at exact zero.

`setAtLiveEdge` is not a control loop. It only publishes `Place.following` to the trim/cache side channel (`anchored-messages.ts:70-80`; called by `publishAnchors` at `transcript-viewport.tsx:72-89`). It cannot repair stale viewport state.

### Candidates proved or disproved

- **`<= 2` and fractional pixels — not the reproduced cause.** The gesture reproduction is at exact `gap=0` before and after input. It fails because no scroll event reaches the `<=2` computation at `:486`. Fresh-open and successful runs also measured exact zero. Fractional tolerance still needs a zoom matrix, but changing `2` cannot fix this failure.
- **`followingGrowth` only for prefix appends — a real coverage hole, not this trigger.** Line `:152` excludes existing-row changes. The ResizeObserver fallback at `:447-453` handled the observed reasoning, child, Markdown, and result cases while following remained true. It is timing-dependent and observes outer-row size, not every content mutation; the library path below is stronger.
- **ResizeObserver after state loss — possible race, not seen as the initiating event here.** In the failure, state was already false before content changed; therefore `:451` also refuses to set `followingGrowth`. In successful traces, simple row growth did not emit an earlier user-like scroll and the observer restored bottom.
- **Windowing / `HeightIndex` — amplifier, not root.** Normal 500-delta batch: max gap zero. Same virtual growth after stale false: 6433 px. Spacer/measurement changes make the missed follow large, but do not make the decision false.
- **`followRun(running)` — insufficient but not independently causal.** It only re-pins on `false→true` run activity when `following` is already true (`:425-435`). Child events and late blocks outside a parent run followed successfully while the bit was true; nothing outside a run can recover the stale false bit.
- **`arriving`, `reading`, ownership timers — not involved in the focused failure.** There was no destination change, locate, upward movement, or active anchor. `reading` was created by the no-op input itself (`:456-459`, `:489-492`) and reinforces the wrong classification; it did not detect movement.
- **`content-visibility` — not the cause in observed mounted rows.** `WindowRow` forces mounted message roots visible (`:663-667`), and the trace contains actual outer-row resize records. Unmounted history is represented by spacers; it amplified the stale mode as above.
- **React commit ordering — the previous fix covered the wrong precondition.** `2ba50530`/M16-T62 added prefix `followingGrowth` and row resize ownership. Both require `Place.following` to still be true. They cannot help after a no-op input silently clears it.

## Why the existing tests gave false confidence

- `packages/ui/test/thread/transcript-viewport.test.ts:359-393` manually starts with `following=true`, mutates synthetic totals, dispatches a synthetic scroll, then calls `committed()`. It proves the prefix append patch, not the browser's input/default-scroll ordering.
- The same unit suite's wheel cases always pair wheel with an explicit scroll/top change (`:314-356`). It has no “wheel/tap/key at bottom, no scroll event, then passive output” case.
- `scripts/browser-check/test/stream-start-follow.mjs:24-38` clicks the local **Send** button. The local composer calls `latest()`, which forces `following=true` (`transcript-viewport.tsx:436-443`), so it bypasses the reported passive-live-edge state.
- M16-T62's evidence “batched appends and `running:false`” was controller-state evidence. The real 500-delta browser run confirms batched appends are fine only while the prerequisite bit is correct.

## Verdict on the design

The virtualizer is still needed for bounded DOM, old-history anchoring, selection, focus, and explicit destinations. Its bottom-follow subsystem should not remain hand-rolled.

The installed assistant-ui `0.15.18` contract says `ThreadPrimitive.Viewport autoScroll` follows new content unless the reader scrolls up, and its implementation is materially safer:

- It owns `followBottomRef` and scrolls to `scrollHeight` (`useThreadViewportAutoScroll.js:25-35`).
- It opts out only when `scrollTop` actually decreased **and** `scrollHeight` stayed unchanged (`:54-75`; package-resolved `@assistant-ui/store/dist/utils/viewport-scroll.js:15`). A no-op wheel/tap cannot opt out, and content growth cannot masquerade as user scroll-up.
- It observes the viewport's box plus subtree mutations/attributes/character data (`useOnResizeContent.js:6-37`) and re-pins with instant behaviour while follow is active (`useThreadViewportAutoScroll.js:77-88`). This covers ordinary text, row, tool, reasoning, and disclosure DOM updates without enumerating event types. It does **not** observe descendant boxes, so the existing per-row ResizeObserver is still needed for an image decode or other size change that causes no mutation.
- It exposes `isAtBottom`, `scrollToBottom`, viewport elements, and footer inset through `ThreadViewportState` (`context/stores/ThreadViewport.d.ts`). It does not publicly expose `followBottomRef`; integration should use `isAtBottom` for virtual-range choice and let the primitive retain sticky intent internally.

Laser explicitly disables all of that in `Thread.tsx:123` (`autoScroll={false}` plus all three event flags false), then calls only the primitive's imperative tail action from its own controller (`transcript-viewport.tsx:628-633`). Virtualisation explains why Laser needed custom range/anchor work; it does not require replacing assistant-ui's live-edge policy. The library does not virtualise messages for us, but its resize/mutation loop works against the real scroll container and the virtualizer's total-height spacers.

## Recommended design

**Keep `TranscriptViewport` as a virtual window and reading-anchor controller; remove it as the live-edge authority. Let `ThreadPrimitive.Viewport` own auto-follow.**

1. Enable bottom-anchor `autoScroll` and initialize/thread-switch-to-bottom behaviour on the real `ThreadPrimitive.Viewport`. Passive follow uses `instant`, never smooth motion.
2. Treat assistant-ui viewport state as the one live-edge authority. `isAtBottom` publishes `setAtLiveEdge`; the library's internal follow intent decides whether content growth re-pins. The virtualizer reads that state to choose the tail range, but does not maintain a second `Place.following` policy.
3. Keep explicit destinations and old-history anchors separate. A real upward user scroll is detected from geometry (decreased `scrollTop` with unchanged `scrollHeight`), after which `TranscriptViewport` captures the reading anchor and windowing preserves it. Raw `wheel`, `touchstart`, pointer, or key events may cancel a locate, but must not by themselves leave live-edge mode.
4. After every React commit, `useLayoutEffect` updates virtual ranges/heights before paint. Assistant-ui handles DOM mutations; keep the existing per-row ResizeObserver for descendant-only size changes such as image decode. While `isAtBottom` was true before that measured growth, the row observer requests `scrollToBottom({behavior:"instant"})`; while reading away, it applies only measured deltas above the saved anchor. This keeps virtualization corrections and live-edge corrections mutually exclusive.
5. Gate disclosure scroll locking by live-edge state. At live edge, do not run `useScrollLock`; auto-follow wins throughout the animation. Away from the edge, start the anchor window in a layout effect after the disclosure commit, not at `handleOpenChange` (`tool-group.aui.tsx:109-121`), satisfying the existing regression guard. Touch momentum opts out only after actual upward movement; a tap/no-op swipe does nothing. Passive following is instant under both motion preferences, so reduced motion loses no behaviour.

Implementation acceptance should delete or demote `followingGrowth`, `running`, and the input-driven `user()` live-edge transitions. `Place` can retain anchor/revision state for reading and destinations; it should not duplicate assistant-ui's follow state. This integration was not enabled during the read-only investigation; compatibility with the virtual spacers is a source-supported proposal that must pass the browser matrix below before adoption.

## Rejected alternatives

- **Keep the controller and patch no-op wheel/touch.** Detecting whether each input eventually causes movement adds another timer/state machine for wheel phases, touch momentum, keyboard default actions, scrollbar drags, programmatic corrections, and layout races. That is the class of patch M16-T62 already demonstrated does not hold.
- **Write `scrollTop` only after every React commit.** It misses delayed image decode, fonts/code highlighting, collapsible animation frames, and other post-commit row growth. A ResizeObserver and mutation observer are still required; assistant-ui already composes those with user-scroll detection.
- **Browser-native `overflow-anchor`.** It preserves a browser-chosen visible anchor; it does not express “follow the bottom until the reader scrolls up.” Virtual spacer replacement makes its chosen anchor unstable. Keep `overflowAnchor:"none"` on the virtual content (`transcript-viewport.tsx:645`) and make following explicit.
- **Increase the 2 px tolerance.** The reproduced state is wrong at exact zero before any growth. A larger threshold only hides small aftermath; it cannot recreate the missing scroll event.

## Required real-browser regression strategy

Use the real host, worker, runtime projection, assistant-ui viewport, virtual spacers, and natural pointer/touch events. Controller-unit assertions remain useful for `HeightIndex` and anchor math, but are not release evidence for follow.

1. Run 1360/390 × dark/light and a separate touch matrix. On every case, assert fresh open is at latest; run passive output from RPC so local Send cannot call `latest()`.
2. At live edge, exercise: normal streaming; 500 same-frame deltas; reasoning; tool call; delayed tool result in an already-expanded multi-action group; child event outside the parent turn; async image decode; closed code fence becoming highlighted; Markdown reflow; disclosure animation. Sample `gap` every animation frame and after settlement.
3. Before repeating every content class, perform no-op downward wheel, tap/no-drag touch, ArrowDown, PageDown, End, and Space at physical bottom. Geometry must remain at edge and subsequent passive output must follow.
4. Negative controls: real wheel/touch/keyboard movement upward during both idle and streaming must preserve the reading location through all the same updates. Scrolling back to physical bottom must re-arm follow without requiring Send.
5. Run motion on and `prefers-reduced-motion`, plus CSS zoom/device-scale cases. Require no horizontal page scroll, no focus theft, and no transient disclosure gap beyond the browser's fractional bottom tolerance.

The focused scripts above already fail the missing no-op-input case and prove the deliberate-scroll negative control. Before release, move the durable version into `scripts/browser-check/test/` and make the matrix command a required gate; a summary/string test or a mocked `TranscriptViewport` is not sufficient.
