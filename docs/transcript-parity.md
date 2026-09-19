# The transcript, copied from a working chat

Laser's transcript failed in a way a person could see: a long conversation with
screenshots in it stopped paging ("Part of this conversation is too large to
show"), and reading upwards moved the text under the reader's eyes. Three
milestones (M16-T89, M16-T90, M16-T91) replace our own answers with the ones a
shipping chat client already proves, in the detail it proves them.

The reference is `pingdotgg/t3code` (read at `/home/youssef/research-virtual/t3code`,
clone only — nothing is vendored from it, and nothing of its code is copied
verbatim; what is copied is the *design*, named here so both producers and the
UI implement the same one).

Three differences explain everything we saw.

## 1 · Bytes never travel inside a message (M16-T89)

The reference normalizes an image **on the way in**: the data URL is parsed, the
bytes are persisted once, and the message keeps `{ type: "image", id, name,
mimeType, sizeBytes }`. A message is therefore always small, and no page can
ever be too large because of a picture.

Laser does not own its session file — Pi writes it, with base64 inline — so the
equivalent rule applies at **our** boundary, the projection that serves the UI:

- Every `image` part, of every role, at every size, is served as a reference:
  identity, `mimeType`, `totalBytes`, `contentDigest`, and the component that
  addresses it through `session/entry_range`. **No threshold, no exception.**
- The reference carries the intrinsic size (`width`/`height`) when the bytes
  declare it, so the UI can reserve the box before the bytes arrive.
- M16-T88's ceiling stays, as a safety net for a record that is large for some
  other reason. It is no longer the thing that keeps images out of a page.

Result: a page's size stops depending on what a person screenshotted.

## 2 · A page is a number of turns, not a number of bytes (M16-T90)

The reference pages by **user-anchored turns**: the first page covers the last
10 turns whose pending message is a user message (assistant, tool and subagent
turns between them ride along), each "load earlier" fetches 20 more, and a
keyset cursor (`beforeCursor`) walks back. A `maxRawTurns` ceiling bounds
pathological fan-out. `hasMore` is answered by asking for one turn beyond the
page.

Laser copies that shape exactly:

- `window: { turns: 10 }` for the first page, `{ before: <cursor>, turns: 20 }`
  for each page after it. The counted unit is a user message on the rendered
  branch; everything between two user messages belongs to the later turn.
- A raw-entry ceiling bounds one page regardless of turns.
- `hasMore` is derived by looking one turn further, not by comparing byte
  budgets.
- The byte ceiling remains a net: it may shrink a page, never refuse one.

## 3 · The list keeps the reader's position; the app does not (M16-T91)

The reference renders the timeline with `@legendapp/list` (MIT), a list written
for chat, and hands it the policy:

- `maintainVisibleContentPosition={{ data: true, size: true, shouldRestorePosition }}`
  — content above the reader does not move when rows are **prepended** (`data`)
  and does not move when a row **grows** (`size`). This is the guarantee D-303
  had to trade away: TanStack corrects after the fact, Legend does not let it
  happen.
- `maintainScrollAtEnd={{ animated, on: { dataChange, footerLayout: false,
  itemLayout, layout } }}` — live follow is the list's, with the composer inset
  explicitly excluded so it cannot move visible messages; `animated: true` only
  while a turn streams and `prefers-reduced-motion` is off.
- `estimatedItemSize`, `keyExtractor`, `getItemType`, `extraData`,
  `initialScrollAtEnd`, `[overflow-anchor:none]`, `overscroll-y-contain`.
- The "load earlier" control is the list's `ListHeaderComponent`, so it lives
  inside the scrolled content and cannot push the reader from above.
- Disclosure toggles suspend end-maintenance and name the row to restore
  (`shouldRestorePosition`), which is how a fold keeps the clicked row still.

Laser pins `@legendapp/list` exactly and carries the reference's three
web-entry corrections as a pnpm patch (anchored end space shrinking before it
is ready, `Element.moveBefore` for reordering so row state and transitions
survive, and reading back the applied padding rather than the requested one).
Its React Native, keyboard and Reanimated hunks do not apply: Laser has no
React Native app.

## What is not copied

- Their storage, their server, their projection database, their Effect runtime.
- Their component source. Laser's rows stay Laser's rows, styled to
  `DESIGN.md`, fed by assistant-ui as `docs/ux-elements.md` requires.
- The visible copy stays ours; "Load earlier turns" is the reference's wording
  and is not automatically the right wording here.
