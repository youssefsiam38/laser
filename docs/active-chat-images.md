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

1. **`requested`** — the person opened this one. A picture holds this rank for
   exactly as long as a viewer is holding it, and nothing evicts it meanwhile.
   The rank is **derived** from that hold, never stored: close the viewer and
   the picture rejoins the ordinary order where its row says it is, so an image
   somebody once looked at can never pin the window into a permanent wait.
2. **`visible`** — really inside the viewport, from an `IntersectionObserver` on
   the tile. A mounted row is not a visible row: the transcript keeps rows
   mounted far outside the viewport.
3. **`nearby`** — within a conservative 600 px lookahead of the viewport, so the
   next row is ready before it arrives. Speculative, and treated as such.
4. **`background`** — everything else the window still has rows for.

Reads run at most `IMAGE_READS_MAX` at a time, chosen in that order — including
the read a person's own click starts, which waits for a slot like every other
and is joined, not repeated, by the next click on the same tile. The decision is
taken one microtask after the asking, so a row that mounts twenty pictures in
one pass is ordered as a batch rather than first-come-first-served.

One tile is a guess: a picture nothing has measured yet is treated as visible,
so a row never waits for an observer before it starts loading. It cannot take
anything from a picture a person can actually see — a `visible` claim only ever
evicts what is off screen — and the first observer callback corrects it.

## Room

- `IMAGE_BLOB_MAX` (24) bounds the pictures kept decoded for rows **nobody is
  looking at**: the count it is measured against is the offscreen residue, not
  the whole pool, so a screenful of pictures never spends the lookahead's
  budget. It is trimmed once per batch, in the same deferred pass that decides
  what to read next.
- `IMAGE_BLOB_ACTIVE_MAX` (256) is the hard stop on pictures decoded at once
  while rows are showing them. What actually bounds that case is memory:
  `IMAGE_BLOB_MAX_BYTES` (128 MiB encoded) and `IMAGE_SURFACE_MAX_BYTES`
  (256 MiB decoded surface), unchanged. This is D-295: active conversation
  content outranks an ordinary cache share, and the safety property is bytes.
- A picture with no room takes it from the picture that has been off screen
  longest, and only ever from one wanted **less** than it is: a row on screen
  takes from what is off screen, the lookahead takes only from the background
  residue, and speculative work never takes a picture a row is showing. The one
  exception is the picture a person explicitly opened: last of all, after every
  offscreen candidate, it may take room from a thumbnail on screen — which says
  it will come back, and does, as soon as the viewer closes. A picture a viewer
  is holding is never taken. If there is still no room, the picture **waits**;
  the queue comes back to it when a row goes, a picture is evicted, a viewer
  closes, or the reading position changes.
- Under memory pressure the window gives the residue back: `releaseIdle()`
  drops every decoded picture nobody is looking at and reports exactly how many
  and how much decoded surface that was. The pool registers itself for the
  renderer's step 1 (RP-8, `runtime/pressure/ephemeral.ts`); what a row is
  showing and what a viewer is holding are never part of it.

## What a row says

| State | Copy | Open action |
| --- | --- | --- |
| `ready` | the picture | enabled |
| `loading` | "Loading image…" | enabled |
| `waiting` (off screen) | "Shown when it scrolls into view" | enabled |
| `waiting` (no room) | "Shown when this window has room" | enabled |
| `failed` (`corrupt`/`moved`/`unavailable`) | what happened, with **Try again** | the retry replaces it |
| `failed` (`too-large`) | "Too large to show here" | disabled — this window cannot rebuild it at all |

A tile whose picture a click is reading reads as busy (`aria-busy`) and says
"Opening…" in place of its waiting copy, so a second click is not an invitation
to read the same image twice.

In a multi-image prompt a tile is 112 px. A tile that failed shows the icon and
**Try again** — the way out — and the sentence that explains it goes in the
problem line under the grid, where there is room for it; its accessible name
carries the whole sentence. Less content, never smaller text, never overflow.

Opening is never gated on the decode pool. A picture the pool holds is handed
over as its own blob (nothing is copied, nothing is charged twice); one it does
not is read back from the conversation's own authority through the same
`BodyRevisionFence`, verified against the same whole-image digest, charged
against the same budgets and then **published into the pool** — so the row
showing that picture gets it too, and the documented decoded ceiling is the
real one. The viewer's hold is given back exactly once, whatever path closes
it.

## What has not changed

Everything M16-T74 put in place: the revision fence with one refresh and no
digestless cross-revision retry, the whole-image digest, the per-slice digest,
the generation fence that stops a read from an environment this device has left,
reservations released exactly once, at most `IMAGE_INFLIGHT_MAX_BYTES` of
decoded bytes in the JavaScript heap per read in flight (so at most
`IMAGE_READS_MAX` × that across the window, where the old pool started every
admitted read at once), and the surface charge corrected from the image's own
header. No protocol method, request or field changed; no image bytes are
persisted anywhere new.

A read whose row has gone stops at its next slice boundary rather than fetching
and hashing bytes nobody is waiting for; its slot goes back to the queue.

## Proving it

- `packages/ui/test/thread/image-accessibility.test.tsx` — order, eviction,
  recovery, the lookahead beside a full screen, releasing the residue, opening
  past the pool, open → close → evictable again, failure and retry, URL
  revocation.
- `packages/ui/test/thread/image-visibility.test.tsx` — the row itself: a
  revision advance around unchanged bytes keeps the picture, measured
  visibility decides what is speculative, observers exist only for rows that
  carry pictures, and an impatient person reads the bytes once.
- `packages/ui/test/thread/large-body.test.tsx` — the unchanged safeguards.
- `scripts/browser-check/test/image-accessibility.mjs` — the real composer, a
  real host and a real reload. `UAT_IMAGES` chooses the size of the prompt: 24
  is the old ceiling, 25 is the reported defect, 40 is well past it.
