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
  content. Attribute newlines, carriage returns and tabs use `&#10;`, `&#13;`
  and `&#9;`. Decode entities once. A closing tag inside a file cannot end it.
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
  literal filesystem paths, not URL decoding.
- A chip reads once per mounted reference, lazily on hover, focus or activation.
  Activating while that read is pending says “Opening…”. Missing/unreadable
  references become their authored text; activation failures also explain the
  problem in a toast. No reference navigates to a guessed web-origin URL.
- Local Markdown images load through `pi/project/read`, whose existing response
  selects base64 for images (there is no request-side encoding flag). Incomplete,
  unreadable, non-image or undecodable results render the alt text. HTTP(S)
  images retain their normal renderer. No raw SVG or HTML is inserted.
- Inline images use a shared-spacing height bound and open the existing viewer.
  The viewer accepts already-read bytes beside the request identity, avoiding
  a duplicate read while retaining its editor/copy-path actions. Closing returns
  focus. A new directory/path cannot inherit an older read result.
- Linked images and inline code never introduce nested interactive controls.
  `write`/`edit` tool cards and their diff bodies are unchanged.
