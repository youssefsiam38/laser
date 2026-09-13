# Machine file mentions

`@` opens the existing composer trigger picker: a global host file/folder explorer, not a git search. Child handles still come first for a bare name. Listings come from the host's opt-in `pi/project/browse`, never a worker or a downloaded search tool.

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

Enter or a pointer choice continues a folder with `/`; files and handles use the existing directive formatter and render as chips. Outside files retain their absolute identity; in-session files may use relative identities. The existing viewer resolves symlink targets, displays outside targets as absolute paths, and opens files only on explicit activation. Browsing reads immediate directory-entry metadata only: no file contents, recursion, or ignore-file parsing.

`/` chooses a highlighted folder when a name is being completed, but remains a literal separator after `.` or `..`. Backspace immediately after a separator goes to the parent directory and stops at the filesystem root. Tab writes the common prefix across **all** matching entries, not just the displayed page; it never selects or sends. A later Enter is the explicit choice. Escape closes without removing the text. Arrow keys and page keys use the existing primitive.

## Listing contract

The existing method accepts optional strict `explorer: { mode: "explorer", cwd, prefix, offset?, limit? }`. `cwd` is an absolute resolution context, not a sandbox. Without explorer options, the existing directory-only, non-hidden, 500-cap response stays byte-identical. Explorer entries add `kind`; `nextOffset` is a continuation and `commonPrefix` is computed across the filtered listing before pagination. No second method exists. The unshipped checkpoint's `root` field was replaced with `cwd` to remove its incorrect containment promise.

The host applies case-insensitive name-prefix filtering, then sorts visible directories, visible files, hidden directories, hidden files; each group uses alphabetical/numeric name order. Ignored/generated and dot entries are included, including `node_modules`, `dist` and `.git`. Special files and broken symlinks are not candidates. No git subprocess is involved.

The host returns at most 100 entries (the composer requests 80). The composer replaces rather than accumulates pages. Offset continuation reflects the current filesystem; edits between pages can shift entries, so refiltering starts a fresh first page.

Directory IO is asynchronous; UI reads are debounced and keyed by session directory, query, page and retry attempt. Superseded replies cannot publish stale rows. Loading and read failures do not disable the composer. The shared tokenized picker retains its phone/touch, focus, reduced-motion and theme behavior.
