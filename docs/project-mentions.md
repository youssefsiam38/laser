# Machine file mentions

`@` opens the existing composer trigger picker: a global host file/folder explorer, not a git search. Child handles still come first for a bare name, using the existing fuzzy command ranker; file names remain prefix-matched. Listings come from the host's opt-in `pi/project/browse`, never a worker or a downloaded search tool.

## Path policy (M16-T28)

| Typed path | Directory / filter |
| --- | --- |
| `@`, `@./` | Session directory, all immediate entries |
| `@/` | Filesystem root, all immediate entries |
| `@node`, `@./node` | Session directory, names beginning with `node`, including `node_modules` |
| `@server/` | `./server`, all immediate entries |
| `@server/ind` | `./server`, names beginning with `ind` |
| `@a/b/c` | `./a/b`, names beginning with `c` |
| `@a/../server/` | `./server` |
| `@..`, `@../` | Parent directory, including outside the project |
| `/absolute/path/prefix` after `@` | Absolute host directory and name prefix |
| `@~`, `@~/…` | Explicitly unsupported; type an absolute path instead. The renderer never guesses host home |
| Hand-typed backslash | A path separator, on every platform; absolute drive paths retain their drive |
| Trailing whitespace | Ends the picker without changing the draft; not silently trimmed |

The current directory is the session directory (including its worktree), falling back to the selected project before a session exists. It is a resolution context, not a filesystem boundary. OS-account authority and the existing file viewer's security rules apply ([security.md](security.md#machine-file-previews-m16-t19)): normal permissions, no privilege escalation, and no special-file reads. Symlinks to outside files/directories are allowed. The default onboarding browser's behavior is unchanged.

A picker choice inserts one readable token plus one trailing space. Paths inside the session directory use an explicit relative anchor (`@./server/`, `@./server/index.ts`); paths outside it retain an absolute anchor (`@/outside/`, `@C:/outside/file.ts`). Agent handles remain `@audit`, but render as plain transcript text rather than chips because a stateless renderer cannot distinguish a handle from ordinary prose. Only anchored path tokens (`./`, `../`, `/`, `~/`, or a Windows drive) render as file or directory chips, so package names such as `@lasercode/protocol` remain unchanged text.

UI/DOM keys are separately typed and cannot collide with filenames or pagination actions. A path that cannot round-trip bare (such as a path containing whitespace, `]`, a quote, a control character, or trailing sentence punctuation) keeps the same anchor inside a reversible JSON-quoted token, for example `@"./my folder/"` or `@"/abs/my folder/"`. Quoted anchored paths render as the same working preview chip as bare anchored paths. Outside files retain their absolute identity; an in-session chip resolves its relative identity against the session directory. The existing viewer resolves symlink targets, displays outside targets as absolute paths, and opens files only on explicit activation. Browsing reads immediate directory-entry metadata only: no file contents, recursion, or ignore-file parsing.

`/` chooses a highlighted folder when a name is being completed, but remains a literal separator after `.` or `..`. Backspace always deletes one character; nothing in the picker reinterprets it (D-299). Tab writes the common prefix across **all** matching entries, not just the displayed page; it never selects or sends. A later Enter is the explicit choice. Escape closes without removing the text. Arrow keys and page keys use the existing primitive.

## A chosen mention is finished (M16-T86)

Choosing ends the question. The picker does not reopen for a mention the person has already chosen, whatever they type after it: `@./server/index.ts and then some words` is one tag and a sentence, not a query for `./server/index.ts and then some words`.

Text alone cannot decide this. `@./my fo` (a folder whose name has a space, still being typed) and `@./server/index.ts and then` (a choice followed by prose) have the same shape, so neither the old "a query cannot end in whitespace" rule nor a matcher reading the parsed segments can serve both. The composer therefore keeps a small record beside its draft (`finished-mentions.ts`): a mention is finished because it *arrived whole*, from the picker's own insertion or from a draft that arrived in one piece — a paste, a restored draft, a prompt handed back by Edit or Fork. A path the person is typing, a Tab completion and a `/` descent are all still queries, and a pasted fragment that ends where the caret is stays a query too, so pasting `@./node` still opens the list.

Every change to the draft is reduced to one replaced span, and each record is shifted when the change is entirely before it, kept when the change is entirely after it (including deleting the space the picker added), and dropped when the change reaches into it or extends its end. So editing a finished mention makes it ordinary text that can match again, deleting it leaves plain text, and editing an earlier sentence does not disturb later mentions. Records belong to one composer; Beam's bubble and the session's composer never finish each other's mentions.

A finished mention is drawn as a tag in the composer: a tinted, hairline-framed token behind the person's own characters, with a dashed frame for a folder. It is a layer painted behind the textarea, never a rich-text field, so the caret, selection, native undo, dictation and IME are untouched, no character moves, and selecting or copying yields the literal `@./server/index.ts` that is sent. The tag carries no icon for the same reason — an inline icon would need width, and width would move the person's text — so the kind reads from the frame and from the path, which always ends in `/` for a folder. While a query is in flight nothing is tagged: the list is the answer to that question, and the tag is what the answer leaves behind.

## Listing contract

The existing method accepts optional strict `explorer: { mode: "explorer", cwd, prefix, offset?, limit? }`. `cwd` is an absolute resolution context, not a sandbox: any absolute path, `~`, `../` chain or `/` lists (D-300); the host answers with names and kinds only. Without explorer options, the existing directory-only, non-hidden, 500-cap response stays byte-identical. Explorer entries require `kind`, validated at the renderer's opt-in response boundary; `nextOffset` is a continuation and `commonPrefix` is computed across the filtered listing before pagination. No second method exists. The unshipped checkpoint's `root` field was replaced with `cwd` to remove its incorrect containment promise.

The host applies case-insensitive name-prefix filtering, then sorts visible directories, visible files, hidden directories, hidden files; each group uses alphabetical/numeric name order. Ignored/generated and dot entries are included, including `node_modules`, `dist` and `.git`. Special files and broken symlinks are not candidates. No git subprocess is involved.

The host returns at most 100 entries (the composer requests 80). The composer replaces rather than accumulates pages. Offset continuation reflects the current filesystem; edits between pages can shift entries, so refiltering starts a fresh first page.

Directory IO is asynchronous. CPU work also cooperates: cached collators sort chunks of at most 512 entries, merge passes yield every 1024 output entries, and scans yield at least every 256 directory entries. One explorer scan/sort runs at a time per host; identical queued/in-flight directory+prefix requests (including pages) share it. Other host RPCs can run between steps. This is bounded work per yield, not a wall-clock guarantee against GC or slow OS calls.

There is no scan ceiling or snapshot cache: every request examines the immediate directory, retaining all matching entries plus a merge buffer (O(matches) memory, O(matches log matches) sort work). Pagination bounds the response, not the scan; later pages re-scan once in-flight work has settled. Queued distinct requests are not cancelled when the UI moves on, so a sustained request flood can grow the queue and delay later explorer replies; it cannot start overlapping scans/sorts. Filesystem edits between pages can still shift results. No matches or tail pages are silently discarded.

UI reads are debounced and keyed by session directory, query, page and retry attempt. Superseded replies cannot publish stale rows. Local path refusals explain how to change the path without a dead retry button or no-match advice; read/transport failures offer retry. Neither disables the composer. The shared tokenized picker retains its phone/touch, focus, reduced-motion and theme behavior.
