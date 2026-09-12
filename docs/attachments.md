# Conversation attachments

## M16-T1 · Canonical prompt representation (D-227)

The engine accepts text and images. Image parts retain their `mimeType` and
base64 `data` on each user block: optimistic send, live `message_end`, and
hydration use the same shape. Only `image/` MIME types are retained. A count is
always `images.length`; there is no parallel entry-lookup fallback.

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
  content. Attribute newlines, carriage returns and tabs use `&#10;`, `&#13;`
  and `&#9;`. Decode entities once. A closing tag inside a file cannot end it.
- Only complete canonical wrappers with a matching byte count, at most 256 KiB,
  and no NUL are recognised. Malformed or partial syntax stays visible text.
  This is a display convention, not trusted provenance or an instruction boundary.
- Store boundaries split user content once into prose-only `text` and retained
  `files`, alongside retained `images`. Streaming projections forward those
  references without parsing, encoding or comparing the file bodies again.
  Titles, sidebar subtitles, fleet names and the pending tray read clean prose.
  Catalog previews are already flattened/truncated, so their wrapper suffix is
  removed on arrival; a hydrated first user block takes precedence.
  The model and original session entries still keep the full canonical content.
- File attachments have no filesystem identity. The viewer receives their
  retained content and offers no editor/path action. Names are labels and format
  hints, never host paths.
- Supported text MIME types, filename fallbacks and the browser attachment
  adapter live together in `runtime/attachments.ts`.
  PDFs and other binary formats are refused; text must be valid UTF-8 and is
  bounded before reading. Images keep the existing image adapter behavior.
- Failed sends restore completed files into the originating empty composer.
  Handed-back wrapper text becomes prose plus composer file tiles. Existing
  drafts are never overwritten. Queue editing and clearing (including the slash
  command) restore original content as prose, file tiles and images rather than
  restoring the display excerpt. Editing a sent prompt retains its attachments.
  A forked edit or retry clears only the exact restored text-and-file draft,
  never a newer attachment added by the person.

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

## M16-T2 · Assistant references

- Assistant prose and reasoning opt into `MarkdownText.nativeFiles`. The shared
  renderer's diagnostic/capture and document-preview callers retain their
  existing source-editor links, avoiding a change to request-inspector behavior.
- Explicit Markdown file links inside the owning cwd become inline file chips.
  Path-shaped inline code spans are eligible only for a conservative suffix
  allowlist. Ordinary prose is never tokenised into guessed links. Authored link
  labels remain intact so copying and conversation-find keep the same words.
  Only those authored chip labels opt into native search ranges; generated
  loading copy and ordinary button labels remain excluded.
- `fileLinkPath` resolves URL escapes and optional line suffixes; a separate
  project-containment check rejects parent escapes and sibling path prefixes.
  The host still owns filesystem/symlink access checks. `@file` directives use
  literal filesystem paths, not URL decoding, with the same containment check.
- Chips read lazily on hover, focus or activation. A failed reference stays
  mounted and focusable without changing its geometry; only activation reports
  a toast, and another activation retries. Opening status is screen-reader-only
  so the label never reflows under the pointer. No reference navigates to a
  guessed web-origin URL.
- Local Markdown images load only when intersecting the viewport, through
  `pi/project/read`, whose existing response selects base64 for images. Leaving
  the viewport releases component-held bytes and retains measured geometry.
  Images and chips share a per-thread, cwd/path-keyed LRU: at most eight entries,
  16 × 1024² retained content characters, and 30-second freshness. Failed reads
  are not cached; simultaneous reads are deduplicated. Incomplete,
  unreadable, non-image or undecodable results render the alt text. HTTP(S)
  images retain their normal renderer. No raw SVG or HTML is inserted.
- Inline images use a shared-spacing height bound and open the existing viewer.
  The viewer accepts already-read bytes beside the request identity, avoiding
  a duplicate read while retaining its editor/copy-path actions. Closing returns
  focus. A new directory/path cannot inherit an older read result.
- One thread-owned `FileOpenerProvider` mounts the viewer for user attachments,
  assistant references and `write`/`edit` cards. Primitive components consume
  only its context contract, never the thread viewer. Direct card opens still
  fetch current contents; diff bodies are unchanged.
- Linked images and inline code never introduce nested interactive controls.
