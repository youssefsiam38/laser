# Verification stability — the image-accessibility fixture (M16-T82)

Owner: worker "Stabilize image verification fixture", branch
`agents/stabilize-image-verification-fixture-f27605d5`, base `0642e977`.

Scope: one flaky unit fixture, `packages/ui/test/thread/image-accessibility.test.tsx`.
This is **not** a change to the image pool, to M16-T82's behaviour, or to any
product source. `packages/ui/src/runtime/image-blobs.ts` is read-only here and
is unmodified; no assertion was weakened, skipped or deleted.

Binding text re-read before the change: `AGENTS.md` (including D-342 — no
browser acceptance, no `scripts/browser-check/`; the older M16-T82 notes name a
harness that is now prohibited and it was **not** run), `docs/resource-view-budget.md`,
`packages/ui/src/runtime/image-blobs.ts`, `image-queue.ts`.

## The symptom

On `0642e977`, in a full `pnpm verify`, one test failed while builds, typechecks
and the host/worker/protocol suites passed:

```
test/thread/image-accessibility.test.tsx
  an image that genuinely cannot be shown
    > separates bytes that are not this image from a picture it merely has no room for
  expected [ 'blob:1' ] to have a length of 0    (line 428: expect(created).toHaveLength(0))
```

The behaviour the test is about was correct in that run: the load of the
mismatched bytes still resolved `{ state: "failed", reason: "corrupt" }`. Only
the "nothing was published" half of the assertion failed — and the published
URL was not this test's.

## What actually happened

`beforeEach` replaces `globalThis.URL.createObjectURL` with a fresh spy writing
into a fresh `created` array. Nothing retired the pools a test had made, and an
`ImageBlobs` is a live object: a read it has out at the authority lands when it
lands, and a `release()` at the very end of a test body starts another one a
microtask later. `URL.createObjectURL` is resolved at call time, so a read that
finishes after the test boundary allocates into the **next** test's spy and
**next** test's `created` array.

Instrumented run (temporary probe, not committed: each pool's request wrapped to
log the test it was born in and the test it is called in; the URL spy logging the
current test name; an `afterEach` logging `committed.images - held.images` per
pool). On `0642e977`, unmodified fixture:

```
[REQ]      born="opening an image … > is never evicted under the viewer showing it"
           now="opening an image … > is never evicted under the viewer showing it"
[INFLIGHT after "…is never evicted under the viewer showing it"] reserved=1
[CREATE blob:1] during "an image that genuinely cannot be shown > says so, keeps saying so, …"
[CREATE blob:2] during "an image that genuinely cannot be shown > says so, keeps saying so, …"
```

That test (`is never evicted under the viewer showing it`) ends with
`opened.release()`. Unpinning pumps the queue, the displaced `another` picture
becomes admissible, a read starts and is still out at the authority when the
test ends — `reserved=1` at teardown. Its object URL is then created inside the
*following* test. `says so, keeps saying so…` needs exactly one URL of its own
and was observed creating two in **8 of 8** loaded runs: one its own, one
inherited. Under more load the same tail lands one test later, in
`separates bytes that are not this image…`, whose window must contain nothing —
which is the reported failure, `created = ['blob:1']`.

So: a **fixture lifecycle leak**, not a product defect. A pool nobody cleared
continuing its work is the pool behaving as designed; keeping it alive across a
test boundary was the fixture's mistake.

## The fix

Three changes, all inside the test file:

1. **Every pool is tracked.** `new ImageBlobs(...)` is replaced by a local
   `pool(request, environmentKey = "env")` helper that registers what it makes.
   Sixteen call sites, no behavioural change to any test body.
2. **Every pool is retired at the end of the test that made it.** A file-level
   `afterEach` calls `clear()` on each and empties the registry. `clear()` bumps
   the generation, and `ImageBlobs.read()` re-checks the generation *after* the
   last byte arrives and *before* it calls `URL.createObjectURL` (and again at
   the top of every slice loop), so work still out at the authority gives its
   bytes up instead of allocating. This is a fence, not a delay: the only code
   between that check and the allocation is synchronous.
3. **The window's own helpers are restored.** The same `afterEach` puts
   happy-dom's real `createObjectURL`/`revokeObjectURL` back, so nothing running
   between tests writes into any test's arrays.

No test body, timeout, sleep or assertion was changed. The corruption assertion
at the heart of the reported failure (`created` empty, load `corrupt`, open
`corrupt`) is untouched.

## The proof that late work cannot reach the next test

A deterministic pair of tests at a **real** test boundary, using deferred IO
rather than timing luck (`describe("what one test leaves half-read")`):

- the first makes a pool over an authority that has been asked and has not
  answered, waits until the request has genuinely been entered, and asserts the
  read is in flight (`committed.images === 1`, `held.images === 0`, nothing
  created);
- the file's `afterEach` then runs for real;
- the second answers the authority, awaits the reply promise itself and one turn
  of the event loop (everything after the reply is microtask work), and asserts
  its own window is empty: `created === []`, `revoked === []`, the request was
  made once, and the row's own load promise resolved
  `{ state: "waiting", reason: "retired" }`.

Mutation check — the fence removed (`for (…of pools.splice(…)) void blobs;`,
global restore left in place):

```
× what one test leaves half-read > never reaches the next test's window
  AssertionError: expected [ 'blob:1' ] to deeply equal []
  Tests  1 failed | 22 passed (23)
```

That is the reported symptom's exact shape, reproduced deterministically and
without load. With the fence in place the same file is 23/23.

Independent confirmation on the fixed file with the same probe: the test that
previously logged two creations (`blob:1` + an inherited `blob:2`) now logs
exactly one, and `separates bytes that are not this image…` logs none.

## Validation

All commands run in this worktree, on this branch.

| Command | Result |
| --- | --- |
| `pnpm -F @lasercode/ui exec tsc -p tsconfig.test.json --noEmit` | clean |
| `pnpm -F @lasercode/ui exec vitest run test/thread/image-accessibility.test.tsx` ×6 | 23/23 each |
| `pnpm -F @lasercode/ui exec vitest run test/thread/image-reserve.test.tsx test/thread/image-visibility.test.tsx` | 9/9 |
| `pnpm -F @lasercode/ui test` (types + full UI suite) | 352 files, 3295 passed, 1 skipped, 61.0 s |
| `pnpm identity:check` | `product identity: laser — every generated file agrees, no stray literals.` |

Not run, deliberately: the full monorepo `pnpm verify` (the parent owns it and
runs it; running it here concurrently was excluded), and anything browser-based
(D-342).

## Limitations

- The original failure is **load-dependent** and was not reproduced as a red
  `separates bytes…` on this machine; what was reproduced is the mechanism that
  produces it (cross-test allocation, observed in 8/8 loaded runs) and the
  assertion shape it produces (the mutation check above). A file that passes
  repeatedly is not proof on its own, and is not offered as such.
- The fence covers pools made through `pool(...)`. A future test that calls
  `new ImageBlobs(...)` directly is outside it; the helper's doc comment says so.
- Other fixtures in this package that keep asynchronous objects across a test
  boundary were not audited — out of scope for this milestone. `image-reserve`
  and `image-visibility` were run and pass, but were not read for the same
  pattern.
