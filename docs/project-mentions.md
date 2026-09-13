# Project file mentions

`@` opens the existing composer trigger picker. Child handles still come first for a bare name. Files and folders come from the host's `pi/project/browse`, never a worker or a downloaded search tool.

## Path policy (M16-T28)

| Typed path | Directory / filter |
| --- | --- |
| `@`, `@/`, `@./` | Project root, all immediate entries |
| `@node`, `@./node` | Project root, names beginning with `node` |
| `@server/` | `server`, all immediate entries |
| `@server/ind` | `server`, names beginning with `ind` |
| `@a/b/c` | `a/b`, names beginning with `c` |
| `@a/../server/` | `server` |
| `@..`, `@../`, `@~` | Refused: this picker stays inside the project |
| Absolute path | Accepted only inside the project; `/` alone is the project-root shortcut |
| Hand-typed backslash | A path separator, on every platform |
| Trailing whitespace | Ends the picker without changing the draft; not silently trimmed |

The current directory is the session's project directory (including its worktree), falling back to the selected project before a session exists. The host validates both lexical and resolved containment; symlinks can be followed only within that root. The default onboarding browser's behavior is unchanged.

Enter or a pointer choice continues a folder with `/`; files and handles use the existing directive formatter and render as chips. `/` chooses a highlighted folder when a name is being completed. Backspace immediately after a separator removes that directory component. Tab writes the common prefix across **all** matching entries, not just the displayed page; it never selects or sends. A later Enter is the explicit choice. Escape closes without removing the text. Arrow keys and page keys use the existing primitive.

## Listing contract

The existing method accepts optional strict `explorer: { mode: "explorer", root, prefix, offset?, limit? }`. Without it, the existing directory-only, non-hidden, 500-cap response stays byte-identical. Explorer entries add `kind`; `nextOffset` is a continuation and `commonPrefix` is computed across the filtered listing before pagination. No second method exists.

The host applies case-insensitive name-prefix filtering, then sorts visible directories, visible files, hidden directories, hidden files; each group uses alphabetical/numeric name order. It returns at most 100 entries (the composer requests 80). The composer replaces rather than accumulates pages. Offset continuation reflects the current filesystem; edits between pages can change the list, so reopening/refiltering starts a fresh first page.

Git's `check-ignore` owns `.gitignore`, global exclusions, and tracked-file exceptions. Without git/a repository, the same generated/dependency-directory exclusions as the existing file index apply. `.git` metadata is never a mention candidate. Other hidden entries are included after visible ones. Special files and broken/escaping symlinks are not candidates.

Directory IO is asynchronous; UI reads are debounced and keyed by project, query, page and retry attempt. Superseded replies cannot publish stale rows. Loading and read failures do not disable the composer. The shared tokenized picker retains its phone/touch, focus, reduced-motion and theme behavior.
