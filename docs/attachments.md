# Conversation attachments

## M16-T1 · Canonical prompt representation (D-227)

The engine accepts text and images. Image parts retain their `mimeType` and
base64 `data` on each user block: optimistic send, live `message_end`, and
hydration use the same shape. A count is always `images.length`. Retained entry
lookup is only a fallback for older UI projections, never the primary source.

Text-file attachments use one reserved wrapper, emitted by
`packages/ui/src/runtime/attachments.ts`:

```text
<attached-file name="notes.md" type="text/markdown" size="1234">
…escaped UTF-8 content…
</attached-file>
```

- The wrapper is its own text section, separated from the person's words and
  other wrappers by two newlines. `size` is the original UTF-8 byte count.
- `&`, `<`, `>`, and `"` are escaped as XML entities in names, MIME types and
  content. Decode entities once. A closing tag inside a file cannot end it.
- Only complete canonical wrappers with a matching byte count, at most 256 KiB,
  and no NUL are recognised. Malformed or partial syntax stays visible text.
  This is a display convention, not trusted provenance or an instruction boundary.
- The store keeps the original text. Projection splits it into visible prose
  and file metadata; neither wrappers nor file bodies enter bubble prose/find.
  The model still receives the wrapper and full content. The original transcript
  stays untouched, including host-owned saved-history search.
- File attachments have no filesystem identity. The viewer receives their
  retained content and offers no editor/path action. Names are labels and format
  hints, never host paths.
- Supported text MIME types and filename fallbacks live in `preview/media.ts`.
  PDFs and other binary formats are refused; text must be valid UTF-8 and is
  bounded before reading. Images keep the existing image adapter behavior.
- Failed sends restore completed files into the originating empty composer.
  Handed-back wrapper text becomes prose plus composer file tiles. Existing
  drafts are never overwritten. Editing a sent prompt retains its attachments.

## Presentation

`message-attachment` is the adopted surface: single images preserve aspect ratio
within the shared spacing-scale bounds, multiple images use wrapping cover tiles,
and files use icon/name/format/size chips. Media is inside the bubble above the
words. Clicking or keyboard activation opens the existing `FileViewer`; Escape
returns focus to the initiating control. All controls share theme tokens and
coarse-pointer targets. Mobile and desktop composers both show removable tiles.

`@file` directives use an inline form of the same chip. Opening is an explicit
`pi/project/read` scoped to the owning `FileLinkDirectory`, never a web-origin
URL. It opens the current project file, not a historical snapshot. The viewer's
editor and copy-path controls remain the second door.
