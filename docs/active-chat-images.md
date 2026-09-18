# Images in an active conversation

How a window decides which pictures it decodes, what it says about the ones it
has not, and why nothing a person asks for is ever unreachable (M16-T82, D-295;
the research behind it is `docs/active-chat-hydration-research.md`).

## The rule

> The budgets bound what is decoded **at once**. They never bound what a
> conversation can show.

A prompt carrying twenty-five pictures is not twenty-five pictures the window
must hold forever. It is twenty-five references the window can rebuild, any of
which becomes a picture the moment a person can see it or asks for it. An
admission limit is a scheduling answer — "not yet" — never "never".

## Who decides

| Piece | File | Owns |
| --- | --- | --- |
| Priority and ordering | `packages/ui/src/runtime/image-queue.ts` | The four ranks, the two orders (most wanted first, longest off screen first), the cancellable queue. |
| The pool | `packages/ui/src/runtime/image-blobs.ts` | Reading, verifying, budgets, eviction, retry, opening. |
| The row | `packages/ui/src/components/thread/use-image-bodies.ts` | Where each picture actually is, its holds, its state, its retry, its open. |
| The tile | `packages/ui/src/components/assistant-ui/elements/message-attachment.tsx` | What a person sees and can do in each state. |

## The four ranks

1. **`requested`** — the person clicked this one. It keeps this rank while they
   have it open, and nothing evicts it.
2. **`visible`** — really inside the viewport, from an `IntersectionObserver` on
   the tile. A mounted row is not a visible row: the transcript keeps rows
   mounted far outside the viewport.
3. **`nearby`** — within a conservative 600 px lookahead of the viewport, so the
   next row is ready before it arrives. Speculative, and treated as such.
4. **`background`** — everything else the window still has rows for.

Reads run at most `IMAGE_READS_MAX` at a time, chosen in that order. The
decision is taken one microtask after the asking, so a row that mounts twenty
pictures in one pass is ordered as a batch rather than first-come-first-served.

## Room

- `IMAGE_BLOB_MAX` (24) bounds the pictures kept decoded for rows **nobody is
  looking at**. It is the speculative residue, and it is trimmed the moment a
  picture stops being visible.
- `IMAGE_BLOB_ACTIVE_MAX` (256) is the hard stop on pictures decoded at once
  while rows are showing them. What actually bounds that case is memory:
  `IMAGE_BLOB_MAX_BYTES` (128 MiB encoded) and `IMAGE_SURFACE_MAX_BYTES`
  (256 MiB decoded surface), unchanged. This is D-295: active conversation
  content outranks an ordinary cache share, and the safety property is bytes.
- A visible or requested picture with no room takes it from the picture that has
  been off screen longest, never from one on screen and never from one a viewer
  is showing. If there is still no room, it **waits**; the queue comes back to
  it when a row goes, a picture is evicted, or the reading position changes.

## What a row says

| State | Copy | Open action |
| --- | --- | --- |
| `ready` | the picture | enabled |
| `loading` | "Loading image…" | enabled |
| `waiting` (off screen) | "Shown when it scrolls into view" | enabled |
| `waiting` (no room) | "Shown when this window has room" | enabled |
| `failed` (`corrupt`/`moved`/`unavailable`) | what happened, with **Try again** | the retry replaces it |
| `failed` (`too-large`) | "Too large to show here" | disabled — this window cannot rebuild it at all |

Opening is never gated on the decode pool. A picture the pool holds is handed
over as its own blob (nothing is copied, nothing is charged twice); one it does
not is read back from the conversation's own authority through the same
`BodyRevisionFence` and verified against the same whole-image digest, and the
viewer's copy is revoked when it closes.

## What has not changed

Everything M16-T74 put in place: the revision fence with one refresh and no
digestless cross-revision retry, the whole-image digest, the per-slice digest,
the generation fence that stops a read from an environment this device has left,
reservations released exactly once, at most `IMAGE_INFLIGHT_MAX_BYTES` of
decoded bytes in the JavaScript heap at a time, and the surface charge corrected
from the image's own header. No protocol method, request or field changed; no
image bytes are persisted anywhere new.

## Proving it

- `packages/ui/test/thread/image-accessibility.test.tsx` — order, eviction,
  recovery, opening past the pool, failure and retry, URL revocation.
- `packages/ui/test/thread/large-body.test.tsx` — the unchanged safeguards.
- `scripts/browser-check/test/image-accessibility.mjs` — the real composer, a
  real host and a real reload. `UAT_IMAGES` chooses the size of the prompt: 24
  is the old ceiling, 25 is the reported defect, 40 is well past it.
