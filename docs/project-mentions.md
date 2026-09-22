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

An arrival carries both kinds of mention. The anchored paths are the ones the transcript chips, and a handle is deliberately not one of them (D-284) — so nothing in the characters of `@audit` says it was ever chosen, and only the arrival does. A whitespace-bounded bare word inside a draft that arrived whole is therefore finished as the handle it was chosen as; otherwise a person who picks `@audit`, reloads, and keeps typing is back in the defect. Typing `@aud` still opens the list, and so does a handle that ends where the arrival ends.

The draft a composer *opens* with is the one exception to that last rule: nobody is typing into it yet, so a complete path at the very end of it (`look at @./ser`) is finished rather than popping the list open by itself, while a bare word there stays a query, because `@aud` and `@audit` are the same shape. One Backspace turns the path back into a query whenever the person wants the list again.

Every change to the draft is reduced to one replaced span, and each record is shifted when the change is entirely before it, kept when the change is entirely after it (including deleting the space the picker added), and dropped when the change reaches into it or extends its end. So editing a finished mention makes it ordinary text that can match again, deleting it leaves plain text, and editing an earlier sentence does not disturb later mentions. Records belong to one composer: the composer that owns the draft owns its mention records, and a record never travels to another surface's composer — a project landing, a Chat landing and an open conversation each finish only their own mentions.

A record is only a mention while the text around it still reads as one: the `@` opens a word and the token closes one, the same two boundaries the matcher and the transcript's scanner use. Delete the space in `hi @./server/index.ts`, or between `@./a.ts @./b.ts`, and every character survives while the mention does not — the transcript renders that as prose, so the composer tags none of it. The record itself is kept through the broken state, because typing `Hello: ` in front of a mention passes through exactly that state on its way to a boundary that is whole again.

A finished mention is drawn as a tag in the composer: a tinted, hairline-framed token behind the person's own characters, with a dashed frame for a folder. It is a layer painted behind the textarea, never a rich-text field, so the caret, selection, native undo, dictation and IME are untouched, no character moves, and selecting or copying yields the literal `@./server/index.ts` that is sent. The tag carries no icon for the same reason — an inline icon would need width, and width would move the person's text — so the kind reads from the frame and from the path, which always ends in `/` for a folder. While a query is in flight nothing is tagged: the list is the answer to that question, and the tag is what the answer leaves behind.

The layer mirrors the field it sits behind, and keeps mirroring it once the draft outgrows `maxRows`: it follows the textarea's `scrollTop` on the textarea's own `scroll` event (the field hands the layer its ref, so the listener is attached for a composer that opens empty and gains its first tag much later), and it reserves the width the textarea gives up to its scrollbar, so both wrap at the same word. The field keeps the textarea a flex item, as every composer did before there was a layer, so nothing gains a baseline gap under it.

## Listing contract

The existing method accepts optional strict `explorer: { mode: "explorer", cwd, prefix, offset?, limit? }`. `cwd` is an absolute resolution context, not a sandbox: any absolute path, `~`, `../` chain or `/` lists (D-300); the host answers with names and kinds only. Without explorer options, the existing directory-only, non-hidden, 500-cap response stays byte-identical. Explorer entries require `kind`, validated at the renderer's opt-in response boundary; `nextOffset` is a continuation and `commonPrefix` is computed across the filtered listing before pagination. No second method exists. The unshipped checkpoint's `root` field was replaced with `cwd` to remove its incorrect containment promise.

The host applies case-insensitive name-prefix filtering, then sorts visible directories, visible files, hidden directories, hidden files; each group uses alphabetical/numeric name order. Ignored/generated and dot entries are included, including `node_modules`, `dist` and `.git`. Special files and broken symlinks are not candidates. No git subprocess is involved.

The host returns at most 100 entries (the composer requests 80). The composer replaces rather than accumulates pages. Offset continuation reflects the current filesystem; edits between pages can shift entries, so refiltering starts a fresh first page.

Directory IO is asynchronous. CPU work also cooperates: cached collators sort chunks of at most 512 entries, merge passes yield every 1024 output entries, and scans yield at least every 256 directory entries. One explorer scan/sort runs at a time per host; identical queued/in-flight directory+prefix requests (including pages) share it. Other host RPCs can run between steps. This is bounded work per yield, not a wall-clock guarantee against GC or slow OS calls.

There is no scan ceiling or snapshot cache: every request examines the immediate directory, retaining all matching entries plus a merge buffer (O(matches) memory, O(matches log matches) sort work). Pagination bounds the response, not the scan; later pages re-scan once in-flight work has settled. Queued distinct requests are not cancelled when the UI moves on, so a sustained request flood can grow the queue and delay later explorer replies; it cannot start overlapping scans/sorts. Filesystem edits between pages can still shift results. No matches or tail pages are silently discarded.

UI reads are debounced and keyed by session directory, query, page and retry attempt. Superseded replies cannot publish stale rows. Local path refusals explain how to change the path without a dead retry button or no-match advice; read/transport failures offer retry. Neither disables the composer. The shared tokenized picker retains its phone/touch, focus, reduced-motion and theme behavior.

## Project work in the same picker (M21-T9)

One adapter, not two. `@` still offers this session's child handles and the host's directory listing; project work joins them in the same list, and nothing about the explorer's behaviour changes.

| Typed after `@` | What it finds |
| --- | --- |
| `TASK-44` | that exact key, above everything else in the list |
| `spec:`, `research:`, `design:`, `plan:`, `task:` | that kind only, in every project this device can read |
| `footer` | keys that start with it and titles that contain it |
| `./server/`, `~/x`, a space | nothing from project work; the explorer answers, as before |

The current project's rows come first; every other project is a labelled block under its own name, because a key is unique inside one project and a row that did not say where it came from would be a trap. Each project is read through **its own** `project/work/search` — no store is merged with another — and the rows this window already holds appear without waiting for a round trip. A projectless Chat has no "current" project and simply reads them all.

### What a pick writes, and what the message carries

Picking finishes the query (D-299/D-304) and writes the **human form** into the draft: `@TASK-44 "Rework the picker"`. That is what the person sees, selects and copies, and it is drawn as a tag behind the textarea in the kind's own colour token (`--kind-task` and its four siblings), the same tag layer the paths use.

The identity rides at the foot of the sent message, as a Markdown link-reference definition:

```text
Compare @TASK-44 "Rework the picker" with the spec.

[TASK-44]: laser://work/p_a1/task/e_9/r_3 "sha256-8f1c…"
```

A conversation stores text and images and nothing else, so this is the only durable place an identity can live — and it survives a reload, an edit, a fork and a second device, none of which can carry a side channel. The transcript never draws those lines, the search index and the sidebar's first-message preview never store them (`projectWorkMentionProse`), and the composer's send path never writes a second copy of one it already has. The same key pinned twice at two revisions in one message becomes `@TASK-44` and `@TASK-44#2`, and both survive.

A key somebody simply types (`@SPEC-7`, no picker) is resolved at send time against the project they are writing in, at the revision this window has read. A key nothing can resolve stays ordinary words: a mention nobody can resolve is a sentence, not a broken chip.

### Send time, and what the worker gets

The host — never the client — decides what a mention means. At send time it parses the message's own definitions and, for each one: checks that this connection may read project work at all (the scope a `project/work/get` needs), that the project exists here, that the **exact** revision it names is still stored, and that the digest matches what the store holds. Then it builds a bounded projection per kind — key, title, state, which revision, a few summary fields, one bounded excerpt, and a `[from acme TASK-44@3]` provenance line — and hands *that* to the worker as `session/prompt`'s host-supplied `projectWork`. Whatever a client puts in that field is dropped.

Nothing stops the message. A stale revision is sent as the revision it names, with "not the current revision" in the projection. A digest that disagrees is re-pinned to what the host read, and the sender is told. A project, entity or revision this computer does not have, and a connection that may not read project work, each leave the chip's identity intact and say why — in the projection for the model, and as one sentence for the person.

### Outside the composer

A mention in the transcript is a chip: the key in the kind's colour, the type badge, the title when there is room. It opens the embedded workspace on the exact revision the message pinned, never on whatever is current. A message that *is* a reference — what a `/spec` hand-off and a model tool's answer look like — reads as a compact card instead: key, badge, title, which revision, and the state when this window has read the project. Neither ever shows a body.

A conversation that is an attempt at a Task wears that Task's key in the sessions sidebar, found by the session's own opaque id through the project's execution links (one bounded read per project sequence, shared by every row), never by its title. The global "Search all sessions" dialog answers with project work above the conversations, keys first.
