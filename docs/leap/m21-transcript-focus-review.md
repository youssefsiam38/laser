# M21 · independent review of the transcript focus/selection repair (M16-T62)

First and only independent review of
`agents/diagnose-transcript-focus-regression-645832b4` @ `354f0aaa` against
base `9bcdd23a`. Reviewed here as a merge into the isolated worktree
`review-transcript-move-continuity-917e57e1` (merge commit `927d4364`); no
source edits by the reviewer.

**Verdict: accept.** No structural regression, no blockers. The repair is in
the one function the repo already owns, the native path is untouched, the lock
change is exactly the three hash lines, and the test suite discriminates the
real regression the gate caught. Two low-severity findings below are coverage
and precision items, not defects in shipped behaviour.

## Scope of the diff (9bcdd23a..354f0aaa)

| File | Change |
| --- | --- |
| `patches/@legendapp__list@3.3.5.patch` | `moveChildBefore` fallback (both `react.js` and `react.mjs`, identical 117-line hunks) holds focus, caret (with direction) and both selection endpoints across the remove-and-insert, behind one handover gate. |
| `pnpm-lock.yaml` | exactly three `@legendapp/list@3.3.5` hash lines (`52bcddbf…` → `5d147a53e74fd4c5582551fde7e888f103c2bd7848b6afb5df5de8053f68aac4`). No SDK/MCP or other entry touched — verified against the full lock diff. |
| `packages/ui/test/thread/list-dom-order.test.tsx` | new, 13 cases over the mounted transcript (670 lines). |
| `packages/ui/test/thread/list-dom-order.ts` | the debounce constant and the drive-don't-race rule. |
| `packages/ui/test/thread/trim-interaction.test.tsx` | the focus test drives the list's pass at its 500 ms boundary; three added assertions; **every original assertion unchanged, nothing skipped, no timeout changed** (diff-verified). |
| docs | `transcript-virtualization.md` correction 3, `upstream.md` row, `docs/leap/m21-transcript-focus-followup.md`. |

Containment holds: no `src/` change, no planning-file edit, no SDK/MCP patch.

## What was verified, with evidence

Commands run in this worktree after `pnpm install --frozen-lockfile`
(835 ms, lock reproduced, patch applied to both `react.js` and `react.mjs` —
`grep -c moveChildBefore` = 3 in each):

| Check | Result |
| --- | --- |
| `vitest run test/thread/transcript-viewport.test.ts test/thread/list-dom-order.test.tsx test/thread/trim-interaction.test.tsx` | **39 passed** (3 files) |
| `pnpm -F @lasercode/ui run test:types` | clean |
| `pnpm identity:check` | clean |
| Frozen install reproduces patch hash `5d147a53…` | yes |

Mutation probes, applied only to this worktree's private installed copy of
`@legendapp/list` (link count 1 — not store-hardlinked), backed up first and
**restored byte-identical** afterwards (`diff` against backup confirmed):

| Probe | Expected | Observed |
| --- | --- | --- |
| 1 · fallback reverted to a plain `insertBefore`/`appendChild` | the gate's regression and the repair's own cases go red | 7 of 13 `list-dom-order` cases failed (keyboard focus, forward, backward, relocated×2, caret, caret-direction) **and the trim-interaction focus test failed** — the gate's exact failure mode |
| 2 · relocated-point recognition removed (`node === relocated.node && offset === relocated.offset` → `&& false`) | only the relocated cases go red | exactly 2 failed: "restores a selection the DOM relocated to the container" and the mixed endpoint case; the other 11 pass |
| 3 · handover gate removed | combined handover case red, per the followup doc's claim | **13 passed** — see Finding 1 |

Native path: the `moveBefore` branch returns before any capture or restore;
the shipped text is unchanged from the base hunk (diff-verified), and the
native-path test asserts `fallback === 0` with a stub `moveBefore` present.

Repair correctness, checked against the DOM standard by reading:

- The relocated point formula (`patches/@legendapp__list@3.3.5.patch`,
  `relocated = { node: container, offset: reference && index > insertedAt ? index + 1 : index }`)
  reproduces the standard's removing steps (boundary inside the removed subtree
  → (parent, the node's old index)) followed by the insertion steps (offset
  **greater than** the insertion index rises by one, exactly-at stays), for all
  three cases: reference after the element (offset = index), before it
  (index + 1), and append (offset = index; i can never exceed the append point).
  The test helper `withDomRangeMutation` implements the same two steps live
  from the DOM rather than from the repair's formula, and probe 2 shows the two
  relocation cases fail when the repair stops recognising that point.
- Handover gate: one check gates focus and selection together; a synchronous
  handler that moved focus on leaves both alone (case 9 passes).
- Stale/disconnected endpoints: restore requires `isConnected` on the focused
  node and both endpoints; the edited-text case drops offsets past the node's
  current length instead of throwing, and the sort completes.
- Caret direction: restored when start, end **or** direction changed; the
  direction-only case is red against the revert (probe 1).
- No scroll: every case pins `scrollTop` across the pass; no geometry engine
  added; the repair sits in a `try`/`catch` so it can never stop the sort.
- `doc` null-safety: the post-move code is unreachable when
  `ownerDocument` is null because the `!focused && !held` early return fires.
- Browser-support claims in the followup doc (Chrome/Edge ≥ 133, Firefox ≥ 144,
  Safari and iOS Safari without `moveBefore`, not Baseline) match caniuse
  (`wf-move-before`) and MDN as of this review; no unsupported claims found.

## Findings

### 1 · Low · the handover gate has no discriminating test of its own

`docs/leap/m21-transcript-focus-followup.md` ("Evidence" table, revert row 5)
credits the combined blur-handover case as the red case for the gate: "the
combined case, which fails against the ungated first shape". That is true of
the *first shape*, but against the shipped code the gate is not what makes the
case pass. Probe 3 removed the handover gate (`activeAfter … return`) and all
13 cases still pass: the endpoint-ownership check alone refuses the handler's
foreign selection (`prose` is outside the moved subtree, so `ours` is false),
and the focus-restore condition (`!activeAfter || activeAfter === doc.body`)
already prevents refocusing over the handover.

The gate still buys something the tests never exercise: a handover that moves
focus into another editable **inside the moved subtree**, whose own selection
is then "ours" by the `element.contains(node)` clause — without the gate, the
held selection would be put back over it. Remedy: one case where the
synchronous handler focuses a sibling editable inside the moved row with its
own selection/caret inside the subtree, and asserts both survive; that case is
red without the gate. Until then the doc's claim should name the endpoint
check, not the gate, as the property the combined case proves.

### 2 · Low · `ours` accepts a mid-move selection inside the moved subtree

`fromTheMove`'s middle clause — `element.contains(node)` — accepts any endpoint
still inside the moved subtree as the move's own. A synchronous handler during
the move that sets a selection with an endpoint inside the subtree *without
changing focus* (so the handover gate does not fire) would have its selection
overwritten by `setBaseAndExtent` with the held one. Narrow — it needs a
scripted handler making an in-subtree selection mid-move — and the shipped
combination (gate + ownership check) covers the with-focus variant. Remedy:
either tighten the clause to unchanged-or-relocated positions, or record the
accepted residue in the patch comment so the next reader does not read the
comment's "a selection somebody made … stays" as absolute.

### 3 · Info · revert-failure count differs from the doc (stronger, not weaker)

The followup doc claims the fallback revert turns 4 `list-dom-order` cases red;
the full plain-fallback revert here turned 7 red (the extra three are the two
relocated cases and the caret-direction case, which the doc's narrower revert
presumably still passed). No action needed; recorded so the numbers are not
later read as a contradiction.

## Approval

The review standard's bar is met: no structural regression, no spaghetti growth
(all new logic sits in the function the repo already owns, with the upstream
row filed so it can leave the patch), no file-size concern (the patch is a
pinned dependency's, its growth documented as a risk with a mitigation), no
wrapper/cast churn, no canonical-helper duplication, no boundary leak. The
person-acceptance items (real iPhone focus/selection/caret across the pass,
handover between two fields) are correctly scoped as not unit-provable and are
spelled out step by step; no browser run was made and none is claimed.

Person-acceptance steps (from the followup doc, unchanged): on iOS Safari,
focus a message action in a long conversation, cause a scroll or history
change, wait half a second without touching the screen, then press Tab (or
move the VoiceOver cursor) and check focus is still on that action; repeat with
text selected across two messages, with a caret in a message edit field, and
with focus moving between two fields as the list re-sorts.
