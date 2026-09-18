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

## Listing contract

The existing method accepts optional strict `explorer: { mode: "explorer", cwd, prefix, offset?, limit? }`. `cwd` is an absolute resolution context, not a sandbox. Without explorer options, the existing directory-only, non-hidden, 500-cap response stays byte-identical. Explorer entries require `kind`, validated at the renderer's opt-in response boundary; `nextOffset` is a continuation and `commonPrefix` is computed across the filtered listing before pagination. No second method exists. The unshipped checkpoint's `root` field was replaced with `cwd` to remove its incorrect containment promise.

The host applies case-insensitive name-prefix filtering, then sorts visible directories, visible files, hidden directories, hidden files; each group uses alphabetical/numeric name order. Ignored/generated and dot entries are included, including `node_modules`, `dist` and `.git`. Special files and broken symlinks are not candidates. No git subprocess is involved.

The host returns at most 100 entries (the composer requests 80). The composer replaces rather than accumulates pages. Offset continuation reflects the current filesystem; edits between pages can shift entries, so refiltering starts a fresh first page.

Directory IO is asynchronous. CPU work also cooperates: cached collators sort chunks of at most 512 entries, merge passes yield every 1024 output entries, and scans yield at least every 256 directory entries. One explorer scan/sort runs at a time per host; identical queued/in-flight directory+prefix requests (including pages) share it. Other host RPCs can run between steps. This is bounded work per yield, not a wall-clock guarantee against GC or slow OS calls.

There is no scan ceiling or snapshot cache: every request examines the immediate directory, retaining all matching entries plus a merge buffer (O(matches) memory, O(matches log matches) sort work). Pagination bounds the response, not the scan; later pages re-scan once in-flight work has settled. Queued distinct requests are not cancelled when the UI moves on, so a sustained request flood can grow the queue and delay later explorer replies; it cannot start overlapping scans/sorts. Filesystem edits between pages can still shift results. No matches or tail pages are silently discarded.

UI reads are debounced and keyed by session directory, query, page and retry attempt. Superseded replies cannot publish stale rows. Local path refusals explain how to change the path without a dead retry button or no-match advice; read/transport failures offer retry. Neither disables the composer. The shared tokenized picker retains its phone/touch, focus, reduced-motion and theme behavior.
