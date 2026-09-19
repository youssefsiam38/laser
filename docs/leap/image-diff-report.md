# Images in the changes modal, and the added file that rendered nothing (M20-T5)

Branch `agents/image-diffs-in-the-overlay-e803de2f`, from
`87e193e019345b7ec72ad40fdfc0f628d2ad6d78`.

Two defects in one area, both found by the person opening files in the
Uncommitted scope:

1. **An added file was listed `+9` in the rail and rendered nothing.** The more
   serious of the two, and the one fixed first.
2. **A picture said "Could not read this file · This file has no textual diff
   to show."** A dead end for a file we read perfectly well.

---

## 1. The added file that rendered nothing

### What it was

The uncommitted scope is deliberately asymmetric (`docs/source-control-leap.md`
§7.2a): `pi/project/changes` reads `git status --porcelain` beside the diff and
renders each new, unignored file as an addition **with its lines counted from
disk** (`untrackedAsAdded` in `packages/worker/src/source-control/changes.ts`).
`pi/project/file_diff` ran `git diff <HEAD> -- :(literal)<path>`, and git has
nothing to say about a path it does not track — exit 0, empty stdout. So the
body got an empty patch and fell through to the text path's dead end, for every
added file in that scope, and only in that scope.

Confirmed in the source and then pinned: with the fix reverted,
`packages/worker/test/source-control-symmetry.test.ts` reports `added.ts`
promised `+4` and drawn `0`, `feature.ts` `+9` and `0`, `link.ts` `+1` and `0`
— and the session, turn, range and agent cases still pass, because those scopes
diff against a `write-tree` snapshot that `add -A` already put the untracked
file into. The asymmetry was uncommitted-only, exactly as measured in the app.

### The fix

**One definition of "added", shared by both paths.** `untrackedPaths(repo)` is
now exported from `changes.ts`: the set of paths `git status --porcelain=v1 -z
--untracked-files=all` reports as `??`. The file list uses it to decide what to
add to the list; `fileDiff` uses the same call to decide whether the patch has
to come from somewhere other than `git diff`. They cannot drift again without
changing one function.

**The patch is git's own.** For such a path `fileDiff` runs

```
git diff --no-index --unified=N --no-color --no-ext-diff --no-textconv -- <devNull> <path>
```

(argument array, no shell; `devNull` from `node:os`; the bare
repository-relative path `assertRepoFile` already contained — `./` would leak
into the patch header). `--no-index` exits 1 when the sides differ, which is
the normal case, so only `> 1` is an error. The result carries git's own `+`
lines, `new file mode`, `\ No newline at end of file`, and — for an untracked
picture — `Binary files /dev/null and b/logo.png differ`, which is what feeds
§2 below.

**One count that was a lie is gone.** `untrackedAsAdded` followed symlinks with
`statSync` and counted the *target's* lines; git records a symlink as one line
(the path it points at). It now uses `lstatSync` and says `+1`.

### The invariant, pinned

`packages/worker/test/source-control-symmetry.test.ts` walks **every scope**
(uncommitted, session, turn, range, agent) over a fixture carrying every change
kind (added, modified, deleted, a re-added path, a binary), and for every row
the list returns asserts:

> if the list says `+N` / `−M`, the patch carries exactly N added and M removed
> lines — and a row with no line count (`added: null`) has a patch that is
> empty or git's own "binary" line, never a promise it cannot keep.

Edge cases in their own case: a file with no trailing newline, a file in a
subdirectory, and a symlink.

---

## 2. Images in the modal

### The protocol shape, and why

**Chosen: a separate read, `pi/project/file_blob`.** Not a base64 payload on
`FileSlice`.

`FileSlice` is a *text* page: its `text` is UTF-8, its offsets fall on
character boundaries, and `truncated` means "this patch continues". It carries
no media type, no pixel size and no ceiling of its own, and every existing
consumer — the patch pager, the hydration sides in `diff-files.ts` — reads it
that way. Adding bytes to it would give `truncated` a second meaning on the
path the brief says must not change, and would still need three new fields that
mean nothing for text. A separate read also puts the ceiling where it belongs:
one method, called only when a person opens a file with no textual diff, that
can refuse by construction.

```ts
FileBlob {
  repo; path;
  ref;              // the end these bytes came from: a revision, or "worktree"
  mediaType;        // from the path's extension (see below)
  totalBytes;       // always true, even when no bytes are sent
  offset; bytes; next?; truncated;
  data?;            // base64 of exactly `bytes` bytes from `offset`
  width?; height?;  // the header's own declaration, first page only
  refused?;         // "not-an-image" | "too-large" | "empty"
}
```

- **Media type is from the path's extension**, not sniffed:
  `imageMediaTypeForPath` in `packages/protocol/src/source-control.ts`, over a
  deliberately narrow table of what a browser actually paints — PNG, JPEG, GIF,
  WebP, AVIF, BMP, ICO. Not a general MIME table (the worker's `files.ts` owns
  that one, and still does); not TIFF or HEIC, which a browser will not draw;
  not SVG, which is text and already has a textual diff.
- **Dimensions come from the image's own header**, through the existing shared
  `imageHeaderSize` (`packages/protocol/src/image-header.ts`, M16-T89): a
  bounded 4 KiB probe, no decode, and a size its own byte count could not carry
  is dropped rather than believed. They ride on the first page only. When a
  format declares nothing, the UI simply has no dimension line and the browser
  is the one that knows.
- **The engine serves bytes only for an image media type.** An archive, a font
  or a `.wasm` is answered with its size and `refused: "not-an-image"` — which
  is exactly what the modal shows for it — so this cannot become a general file
  download.

Protocol wiring: hand-written types + `ProjectFileBlobParams` in
`source-control.ts`, the method in `messages.ts`, a strict zod schema in
`schemas.ts`, `{ scope: "read", reach: "any" }` in `method-policy.ts`, a params
sample in `test/schemas.test.ts` and a result round-trip in
`test/source-control.test.ts`; host routing in `router.ts` (`CWD_ROUTED`) with
a case in `packages/host/test/router.test.ts`; the UI capability inventory row
in `test/runtime/environment-capabilities.test.ts`.

### The cap

```ts
FILE_BLOB_MAX_BYTES      = 4 * 1024 * 1024   // 4 MiB, one side
FILE_BLOB_PAGE_MAX_BYTES = 512 * 1024        // 512 KiB raw ≈ 700 KB of JSON
```

Above 4 MiB the engine sends **no bytes at all** and the modal states the size:
*"This image is 6.2 MB, over the 4.0 MB this window draws, so its size is shown
instead of the picture."* For a git ref the size is read with `cat-file -s`
first, so an oversized blob is never even loaded; for the working tree it is a
`stat`. At most eight pages per side, and the UI refuses anything that claims
to be larger than the pages it received.

Nothing is fetched until the person opens that file: the body only mounts for
the active file, and it asks only for the sides that exist.

### The sides

The bytes come from the same ends the patch spans — `scopeSourceEnds` in
`host-adapter.ts`, the table in `docs/leap/overlay-diff-report.md` §8.1, reused
rather than reinvented. `getFileBytes` refuses when it cannot name an end
rather than letting a missing ref mean the working tree. (The doc comment on
`ProjectFileSourceParams.ref` that §8.1 flagged as wrong — "Default is the
scope's right-hand side" — is corrected here, in the same file.)

### What each change kind shows

| Kind | Body |
| --- | --- |
| **Added** | One pane, labelled **Added**, alt `src/logo.png, after`, with `79 B` and `16 × 16`. Header line: *"src/logo.png was added in this scope, at 79 B."* The old side is never requested. |
| **Deleted** | One pane, labelled **Deleted**, alt `src/logo.png, before`, its size and pixel size. *"…was deleted in this scope, at 79 B."* |
| **Modified** | Both ends: **Before** and **After**, each with its own size and pixel size, and the delta (`+14 B`) on the after side. Header: *"…went from 79 B to 93 B (+14 B)."* |
| **Renamed, bytes unchanged** | Shown **once**, labelled **Moved**: *"…moved from src/old.png, still 79 B, and its bytes did not change."* Said only when git said it — `similarity index 100%` in the patch — never inferred from equal sizes. |
| **Over the cap** | Sizes and one sentence, no picture. |
| **Not an image** | The written state: *"vendor/body.woff2 went from 47 KB to 49 KB (+2.0 KB). A WOFF2 file has no lines to compare, so its size is the whole of what this view can show. Open it where it is meant to be read to see the rest."* Titled by what happened (Added / Changed / Deleted / Renamed) — never "Could not read this file", which is what a file we read perfectly well used to be told. |
| **A side that failed** | *"These bytes could not be read just now. Try opening the file again."* — inside that pane, with the rest of the modal intact. |

Split lays the two ends side by side and unified stacks them, from the **same**
`effectiveStyle` the text body gets (`splitColumnsFit` / the person's
preference), so the two bodies never disagree about which layout the window is
in. Stacked, the scroll box is a focusable, named region, because a scroll box
nothing can focus is one a keyboard cannot move.

### The element

`docs/ux-elements.md` → **Image** (`elements/image.tsx`). The picture is that
element's standalone `ImagePreview` part, which already owns the loading frame,
the "could not be loaded" state and `object-contain`; it is fed the blob URL,
the alt text and the header's `width`/`height` so the box is reserved before the
decode. Nothing under `components/assistant-ui/` was edited. What this task adds
around it is the overlay's half only: where the bytes come from, the captions,
the layout decision and the written state. The image never overflows its pane
(`max-h-full max-w-full w-auto h-auto object-contain` inside an
`overflow-hidden` box) and its natural size is stated in text.

### Memory

Pages are decoded, concatenated into one `Blob` and handed to the DOM as an
object URL, revoked when the file changes or the modal closes — never a data
URL, which would keep a copy of the picture alive in a string for as long as
anything held the state. Tested: one `createObjectURL` per side, and every URL
created is revoked on unmount.

---

## 3. Tests

| Suite | What it covers |
| --- | --- |
| `packages/protocol/test/source-control.test.ts` | the media-type table (what is and is not drawn), both constants, the params schema's page bound and strictness, a `FileBlob` round-trip with bytes and one with a refusal that still states the size |
| `packages/worker/test/source-control-blob.test.ts` | real PNGs in a real repository: added (worktree side, `HEAD` refused), modified (both ends, each its own size and header size), deleted (`HEAD` side present, worktree gone), paging a 786 KB image and rebuilding it byte for byte, a non-image answered with size only, an SVG refused as text, the 4 MiB cap, an empty image, a path outside the repository and two hostile refs |
| `packages/worker/test/source-control-symmetry.test.ts` | §1's invariant across every scope and change kind |
| `packages/host/test/router.test.ts` | `pi/project/file_blob` forwarded to the project's worker |
| `packages/ui/test/source-control/image-diff.test.tsx` | classification, alt text, labels, delta, format word; the four change kinds rendered; split vs unified; the cap refusal; paging into one blob; revocation; a failed side; the non-image written state |
| `packages/ui/test/source-control/image-overlay.test.tsx` | the whole modal: opening `src/logo.png` draws both pictures, says neither "Could not read this file" nor "no textual diff", and never mounts the text renderer — while a text file still goes through it unchanged |
| `packages/ui/test/source-control/host-adapter.test.ts` | the change kind survives a binary row; the bytes are asked for at the scope's own two ends, one bounded page at a time |

Deliberately updated: `overlay.test.tsx` and `overlay-chrome.test.tsx` asserted
the old "Binary file" notice for `src/logo.png`. A picture is now drawn, so the
first asserts the image body and its sizes, and the second reads the written
binary state through `src/bundle.wasm`, which the mock gained for it.

## 4. What did not change

The text path: the patch pager, hydration, expansion, the typography pass, the
error boundary, and the lazy renderer chunk (`diff-body-guard` still green —
the image body imports no `@pierre/diffs` and the renderer is not even mounted
for a picture). No Playwright, no browser check: the running sandbox is the
person's own pass.
