# Review — image-accessibility fixture lifecycle (M16-T82 follow-up)

Independent reviewer: session `review-image-fixture-lifecycle-f144960a`.
Target: `4e37a51a` on `agents/stabilize-image-verification-fixture-f27605d5`,
diff base `0642e977`. Scope: `packages/ui/test/thread/image-accessibility.test.tsx`
and `docs/leap/m21-verification-stability.md` only. No implementation changes
were made; the review tree was restored clean after validation.

## Verdict

**Approve for this scope.** The fixture lifecycle fix is correct, minimal, and
its mutation evidence reproduces exactly. No assertion was weakened, no sleep,
skip or timeout inflation was added, no production file changed. The findings
below are non-blocking; one doc nuance and one coupling property are worth
recording.

## What was checked, with evidence

Read at the target revision: the full test file, the full diff against base,
`packages/ui/src/runtime/image-blobs.ts` (read-only), and
`packages/ui/vitest.config.ts`.

- **Single choke point.** All sixteen base `new ImageBlobs(...)` sites are
  converted to the `pool(...)` helper (verified: base file has 16
  `new ImageBlobs`; the only remaining one is inside the helper, line 75).
  The 17th pool comes from the new deferred pair. No test body, assertion,
  timeout or skip changed; the only removed lines in the diff are the
  `new ImageBlobs` call swaps.
- **The generation fence is real, not timing.** In `image-blobs.ts`, `read()`
  checks `generation !== this.generation` at the top of every slice loop and
  again after `flush()` and **before** `URL.createObjectURL(blob)`; `charge()`
  also rejects a retired reservation via `!this.live.has(reservation)`;
  `finish()` and `openRead()` revoke or no-op on a retired outcome. A read
  outstanding across `clear()` therefore cannot allocate into the next test's
  spy by any path found.
- **Determinism of the deferred pair.** `answer()` awaits the request mock's
  own returned promise, which includes both `crypto.subtle.digest` awaits, so
  everything left after it (fence checks, `finish()`, waiter settlement) is
  microtask work; one `settled()` macrotask drains it. `left.state` was
  already settled by `clear()` in the `afterEach` (waiter resolved
  `{ state: "waiting", reason: "retired" }`), so awaiting it in the second
  test is immediate. No wall-clock dependence.
- **Hook order is safe.** Vitest runs `afterEach` hooks innermost-first, so
  the React describe's `root.unmount()` lands before the file-level
  `afterEach` clears pools and restores the native URL helpers — the clear
  happens while the test's own spies are still installed. In this file the
  React tests do not create pools, so the order is harmless here and correct
  in general.
- **No weakened corruption assertion.** `separates bytes that are not this
  image…` is byte-identical to base apart from the `pool()` swap: load
  resolves `{ state: "failed", reason: "corrupt" }`, `created` empty, open
  returns `{ failed: "corrupt" }`.

## Validation run in the isolated review tree

| Check | Result |
| --- | --- |
| `git show 0642e977:… \| grep -c "new ImageBlobs"` | 16 (all converted) |
| `pnpm -F @lasercode/ui exec vitest run test/thread/image-accessibility.test.tsx` | 23/23 (~1 s) |
| `pnpm -F @lasercode/ui exec vitest run test/thread/image-reserve.test.tsx test/thread/image-visibility.test.tsx` | 9/9 |
| `pnpm -F @lasercode/ui exec tsc -p tsconfig.test.json --noEmit` | clean |
| Mutation: fence removed (`for (…of pools.splice(…)) void blobs;`, restore kept) | × `what one test leaves half-read > never reaches the next test's window` — `AssertionError: expected [ 'blob:1' ] to deeply equal []`, 1 failed \| 22 passed — exactly the shape `m21-verification-stability.md` reports |
| Re-run after revert | 23/23 |

Mutation was applied to the review tree only and reverted; the reviewed branch
was never modified.

## Findings (non-blocking)

1. **The ordered pair fails loudly under a single-test filter.** Running only
   the second test (`-t "never reaches the next test's window"`) fails with
   `the previous test must leave a read in flight` (verified). Running the
   first alone passes. The comment states the coupling ("only mean anything
   in this order") and the guard makes the failure explicit rather than
   silent, so this is acceptable — but anyone bisecting the suite should
   know the pair is atomic.
2. **`inFlight` is module-scope shared state.** A future test inserted between
   the pair would leave the demonstration intact (the same deferred
   authority is answered later), but the boundary demonstrated would then be
   two boundaries, not one. The `if (!left) throw` guard covers the silent
   breakage case. Fine as written; worth remembering when editing the file.
3. **Type boundary nits in the helpers.** `pool(request: unknown, …)` plus
   `new ImageBlobs(request as never, …)` erases the request contract — the
   pre-existing `as never` pattern, now centralized to one cast instead of
   seventeen, which is a net improvement; a typed mock-parameter signature
   would be marginally cleaner. Likewise `deferredAuthority().answer` casts
   `request.mock.results[0]?.value as Promise<unknown> | undefined` and
   assumes exactly one call — sound here because `answer` is only reachable
   after `asked`, and `expect(left.request).toHaveBeenCalledTimes(1)` guards
   it. Neither blocks.
4. **Doc nuance.** "Sixteen call sites" in `m21-verification-stability.md`
   counts the base sites converted; the file now makes 17 pools (the new pair
   adds one). Not wrong in context, just worth not misreading later. The
   doc's Limitations section is honest: the original load-dependent failure
   was not reproduced red on the worker's machine, and it says so; the
   mechanism (cross-test allocation, 8/8 instrumented runs) and the exact
   assertion shape (the mutation above) are what it offers as evidence, and
   both were independently reproduced here.
5. **Untracked pattern elsewhere (out of scope).** The doc itself flags that
   other fixtures keeping async objects across a test boundary were not
   audited (`image-reserve`, `image-visibility` ran green but were not read
   for the same pattern). Legitimately out of scope for this fix; noting it
   so it does not get lost.

## Limitations

- The review validated the focused suite, its two neighbour suites, and the
  mutation in an isolated checkout; no browser runs (D-342) and no full
  monorepo `pnpm verify` (owned by the parent).
- The full-UI 3295+1skip figure was taken from the worker's report, not
  re-run here.
