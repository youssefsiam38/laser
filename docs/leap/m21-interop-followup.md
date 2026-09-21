# M21-T21 follow-up · the interop filesystem boundary and exact publication

Two acceptance gaps found in the merged M21-T21 code (base `408366ae`), and
the smallest change that closes them. Scope is
`packages/host/src/project-work/{import,export,publish}/**` and the host
interop tests; no protocol, store, methods, router, UI or planning-file change
is needed (the wire schemas already carry everything the fix needs).

## The two gaps

**G1 · Containment is lexical only.** `export/paths.ts#insideProject` resolves a
project-relative path and compares it to the project root with
`path.relative`, which is a string comparison. Every filesystem call under it
follows links: `kindOf` uses `statSync`, `readTextFile` uses `statSync` +
`readFileSync`, `writeFileAtomic` uses `mkdirSync(..., { recursive: true })`
and `writeFileSync`. So a link **anywhere on the path** — the export root
itself, or any ancestor directory of it — takes an import read, an export
write or a stale-file delete outside the chosen project, while the module's
own doc comment promises it "refuses anything that still lands outside it,
including through a symlink that points away". The walk (`walkFiles`) is the
only part that already refuses links, and only for entries it enumerates.
Nothing refuses an export root inside the project's own state directories
either: `project/work/export/apply` will happily write this project's
documents over `<project>/<state dir>/settings.json`, `mcp.json`,
`source-control.json`, `design/…` or anything under `.git`.

**G2 · A checkpoint id is an unproven bypass.** `publish/index.ts#apply`
verifies each exported file's git blob at the named commit, collects the ones
the commit does not carry, and then:

```ts
if (missing.length > 0 && params.checkpointId === undefined) throw …
```

Any non-empty string in `checkpointId` therefore turns "this commit does not
carry these bytes" into a recorded `published_as`, whose `commitObjectId` is a
commit that provably does *not* hold the published file, plus a `checkpointId`
that was never resolved against anything. That is exactly the provenance the
leap forbids ("`published_as` only after the exact committed or checkpoint
state is known"; "no fabricated state"). The existing test
`records an uncommitted publication only when a checkpoint names the state`
pins the wrong behaviour with the literal `"ckpt_17"`.

## The changes

### `packages/host/src/project-work/export/paths.ts`

1. `projectDirectory` returns the project root's **real path**
   (`realpathSync`). A project folder that cannot be resolved **fails closed**
   with its own sentence: there is no lexical fallback, because without a
   resolved root there is no containment to decide and no IO may happen.
2. `insideProject(projectRoot, path)` keeps its lexical refusal and adds the
   **filesystem truth**, in the shape the host already uses for a background
   command's log file (`tasks/register.ts#isInsideRoot`): the deepest existing
   part of the target is resolved with `realpath`, and the result must still be
   inside the project. An **ancestor** link that leads out is refused; an
   ancestor link that stays inside is the person's own folder layout and is
   allowed. The **final component** is a stricter rule: a path whose own last
   name is a link is refused *unconditionally*, wherever it points, inside the
   project included. So an export root, an import root or a file that is itself
   a link is never used — only a link *above* one is followed, and only when it
   resolves back inside the project.
3. New `insideProjectAt(projectRoot, base, path)` for the nested resolutions
   that today pass an already-resolved absolute root as the "project"
   (`export/index.ts`, `publish/index.ts`, `import/adapters.ts`): contained
   under `base`, link-checked, and forbidden-area-checked against
   `projectRoot`.
4. New forbidden-area rule, applied inside both: a path whose segments include
   `.git`, or the project state directory (`PROJECT_DIR_NAME`) anywhere except
   its export area (`<state dir>/work`, `<state dir>/work-<n>`), is refused
   with its own sentence. Import reads and export writes/deletes both obey it.
5. `kindOf` uses `lstatSync` and gains a `"link"` answer, so a link is never
   mistaken for a free name (`nextRevisionRoot`) or a file to delete
   (`staleFiles`).
6. `readTextFile` opens with `O_NOFOLLOW`, `fstat`s the **descriptor** for the
   regular-file check, and then enforces the ceiling **on the read**: at most
   `maxBytes + 1` bytes are ever pulled in, and the extra byte arriving is the
   refusal. A file that grows between the `fstat` and the read cannot exceed
   the bound the method promises.
7. `writeFileAtomic(path, contents, { within })` creates the directory and then
   re-resolves it through `realpath`, refusing without writing anything if it
   does not resolve inside the project or lands in a forbidden area; the
   temporary file is created with `wx` (exclusive, `0o600`) so a name someone
   else holds is never written to, and `rename` replaces the target name rather
   than writing through a link at it.
8. `removeFile` unlinks only a regular file.
9. `SKIPPED_DIRECTORIES` gains the project state directory, so an import from
   the project root never walks the app's own configuration.

### `packages/host/src/project-work/publish/{git,index}.ts`

10. `git.ts` gains `checkpointCommit(cwd, checkpointId)`: the id must parse as
    an M20 checkpoint ref (`parseCheckpointRef`, i.e. the worker's
    `CHECKPOINT_REF_NAMESPACE/<sessionKey>/<turn>` namespace and nothing else),
    the ref must still exist in this repository (`for-each-ref`), and its
    object must resolve to a commit. Read-only, argv, bounded, as the rest of
    the module.
11. `index.ts#apply` publishes **one exact state**: the checkpoint's commit
    when a `checkpointId` is given, otherwise the named commit. Every exported
    file's blob is proved against that commit's tree in both cases; the
    `missing.length > 0 && checkpointId === undefined` bypass is deleted. A
    checkpoint that does not resolve, and a state that does not carry every
    exported file, are refusals naming what to do next.
12. Because the bytes are proved, `blobObjectId` is recorded in every case and
    is never invented; `checkpointId` is recorded as the resolved ref, and the
    result's `commitObjectId` is the commit that actually holds the published
    bytes. This corrects plan decision 5 ("with one, the state records … *no*
    blob id"), which assumed a checkpoint is not a commit object; the leap says
    it is.
13. The preview's refusal sentence is sharpened to say the checkpoint must be
    one whose commit carries these files.

Preview digests, idempotency keys, supersession, the commit hand-off, the
deterministic export and the round trip are untouched.

## The tests

`packages/host/test/project-work/interop.test.ts` (existing file, router
harness, real temporary git repositories):

- **updated** `records an uncommitted publication only when a checkpoint names
  the state` → a real checkpoint is written in the fixture with plumbing
  (`GIT_INDEX_FILE` + `add -A` + `write-tree` + `commit-tree` +
  `update-ref refs/…/checkpoints/<key>/<turn>`), the export is published
  against it, and the link's `commitObjectId` is the checkpoint commit, its
  `checkpointId` the ref, its `blobObjectId` the blob git really holds there.
- **new** an arbitrary `checkpointId` (`"ckpt_17"`) is refused and records
  nothing.
- **new** a real checkpoint ref made *before* the export is refused by name,
  and records nothing.
- **new** an export into `.git`, `.git/hooks`, the settings directory, its
  `design/` folder or its `settings.json` is refused; the settings and design
  files are byte-identical afterwards and the ordinary export still works.
- **new** an import from `.git` or from the settings directory is refused.

No link or traversal case is exercised against a real outside directory. Those
live in `packages/host/test/project-work/interop-paths.test.ts` (new) over a
**mocked `node:fs`**: the test states a link, a forbidden area or a ceiling and
asserts the refusal *and* that nothing was opened, read, created, written,
renamed or unlinked. There is no runnable traversal and no path on the machine
these tests could reach if the boundary were broken.

`packages/host/test/project-work/interop-git.test.ts` (new) does the same for
the checkpoint resolver, with `git` itself mocked: every invocation is
recorded, and `checkpointCommit` is proved to refuse an id outside the
checkpoint namespace **without running git at all**, to refuse a `for-each-ref`
answer naming a *descendant* ref rather than the exact one asked for (the
pattern matches whole path components, so `…/checkpoints/<key>` would otherwise
answer for every turn under it), to refuse several matches, an absent ref, a
malformed object id, and a ref that does not resolve to a commit. No
repository is created or touched.

## Residual limitation, stated precisely

This is containment, not atomicity. Node exposes no `openat`/`mkdirat`, so a
path is resolved and then used in a separate syscall. A process that already
has write access to the person's project folder could replace an ancestor
directory between the two. What the implementation guarantees is: no link is
ever *followed* out of the project on the checked path, the directory a write
uses is re-resolved immediately before the write, the write itself only ever
lands in a file this call exclusively created, and every failure is a refusal
rather than a fallback. What it does not guarantee, and what nothing in the
code or the tests claims, is atomic containment against an adversary racing an
ancestor replacement inside a folder the person trusted.

## Evidence

Commands run in this worktree (`env -i PATH="$PATH" HOME="$HOME"` throughout).
The first pass is commit `fda60db4`; the revised checkpoint after the three
contract fixes below is the current one.

| Command | Result (revised checkpoint) |
| --- | --- |
| `vitest run test/project-work/interop-paths.test.ts` (host) | 15 passed |
| `vitest run test/project-work/interop-git.test.ts` (host) | 7 passed |
| `vitest run test/project-work/` (host) | 14 files, 199 passed |
| `pnpm -F @lasercode/protocol test` | 46 files, 727 passed, no type errors |
| `pnpm -F @lasercode/host test` | 114 files, 1235 passed |
| `pnpm -r build` | all packages built |
| `pnpm -r typecheck` | clean |
| `pnpm identity:check` | "every generated file agrees, no stray literals" |

On the first pass the host suite had one failure,
`test/session-index.test.ts > hard bounds > keeps cold 20k/50k scans linear and
cooperative` — a wall-clock ratio assertion (`repeat20Ms < cold20Ms / 2`) in an
unrelated module, under a loaded machine. It passes on its own and it passes in
the full run at the revised checkpoint; nothing here touches the session index.

No browser was used.

## Follow-up fixes after parent inspection

Three contract holes in the new helpers, fixed as one batch:

1. **`checkpointCommit` trusted a pattern match.** `for-each-ref <ref>` treats
   its argument as a pattern over whole path components, so a checkpoint id
   that does not exist could still be answered by a ref *below* it. The format
   now carries `%(refname)` beside `%(objectname)` and the name must be equal
   to the id that was asked for; a descendant, several matches, or a different
   name is no checkpoint. Covered by `interop-git.test.ts` with `git` mocked.
2. **`readTextFile` bounded the `fstat`, not the read.** A file that grew after
   it was measured could hand back more than `maxBytes`. The read is now
   bounded at `maxBytes + 1` bytes and the extra byte arriving is the refusal,
   so the ceiling the method promises holds whatever the file does. The
   regular-file check on the descriptor is kept.
3. **The handoff wording was broader than the code.** `insideProjectAt` refuses
   a link at the final component unconditionally, so "exporting into a folder
   that is a link inside your own project is allowed" was not true of the root
   itself. The module comment, this document and the spine plan now state the
   exact rule — ancestor links that resolve inside are followed, a path whose
   own last name is a link is refused — rather than widening the policy to
   match the sentence.

## The independent review's corrections (batch two)

`docs/leap/m21-interop-review.md` reviewed the whole of M21-T21 at `1a157c44`
and found five non-blocking items. Four of them are fixed here as one batch
(F1, F2, F4, F5); the fifth (F3, the checkpoint publication having no person-
facing surface) is a contract change with a written plan below, waiting on the
owner's approval before any of it is coded.

### F1 · a `replace` may delete only what it can prove it wrote

The previous behaviour: `staleFiles` read the manifest already in the export
folder, `JSON.parse`d it **without validating it**, and offered every
`entity.document` / `entity.body` it named as a deletion candidate after only a
containment, forbidden-area and regular-file check. Containment did bound it to
the export root — `insideProjectAt` refuses a path that leaves the base, so a
`..` path in a manifest was already refused — but inside that folder a manifest
anyone could write decided what got unlinked, and the UI showed the removals as
a **count** rather than as paths.

Now, in `export/index.ts`:

1. **The manifest is validated** against the canonical
   `projectWorkManifestSchema` (`previousManifest`). Absent, unreadable or
   invalid: nothing in that folder is deleted, and the preview carries
   `removeRefusal` — a sentence saying the export's own files are written over,
   everything else is kept, and what to do if they want a folder the app keeps
   alone. Failing closed here means keeping a person's files, so it is also the
   safe direction.
2. **The layout must be this product's own for that identity.** A candidate is
   only ever `<KEY>.md` and `bodies/<KEY>.json` for the key the manifest row
   itself carries. A row naming any other path inside the export does not
   authorise deleting it.
3. **The bytes must still be the bytes that export wrote** (`bodyStillIs`): the
   body file is canonicalised and compared against the `digest` and `bodyBytes`
   the manifest declared for that revision. A body that was edited, replaced,
   missing or over the read ceiling is a **conflict**: it and its document are
   kept, and the preview reports them as `preserved` with the reason
   (`changed`, `not_this_export`).
4. The preview digest binds `removes`, `preserved` and `removeRefusal`, so a
   file that turned from a leftover into someone's own work between the preview
   and the press is a refusal rather than a deletion.
5. The export dialog lists **the exact paths** a replace would remove, in a
   bounded scrolling list, with the whole count in the sentence above it; the
   files list shares the height so the dialog still fits a short window. What is
   kept instead is one line naming the first file, its reason, and an honest
   "and N more".

**Both halves are proved, including the document.** The first pass of this batch
fenced only the body, which left a hand-edited `<KEY>.md` deletable — the
original data-loss finding, not a limitation to accept. The manifest now carries
a `documentDigest` per entity (one **additive optional** field; no version bump,
no migration machinery), written by the exporter from the document's own rendered
bytes, and a deletion requires **both** halves to match their declared proof:

- body: canonical digest + `bodyBytes`, as before;
- document: sha256 of its bytes against `documentDigest`;
- a manifest row with no `documentDigest` — an export written before this field
  existed — proves nothing, so that item is **kept** with the explicit reason
  `unproven`. It is never assumed owned.

Because the proof is part of the preview digest, editing either half between the
preview and the press moves the pair from `removes` to `preserved` and the apply
refuses. A body or document that is only **reformatted** (same canonical JSON,
or byte-identical document) still proves the pair, which is correct: it is the
same content. The documents are rendered before the manifest is built so their
digests can go into it; the export stays deterministic and the round trip stays
byte-identical (pinned by the existing round-trip test).

### F2 · the import fence binds the revision it would land on

`previewDigest` in `import/index.ts` recorded `match.entityId` and nothing about
which revision it matched, so a matched item that gained a revision between the
preview and the apply was still revised — appending a child revision onto
content the person never read. The digest now also binds the matched
`expectedRevisionId` and that revision's digest, which is the fence the export
and publish applies already had, and the refusal sentence says the files *or the
work here they would update* changed. A fresh preview applies against what is
there now.

### F4 · the read ceiling no longer allocates the ceiling

`readTextFile` allocated `maxBytes + 1` whatever the file's size — one 64 MiB
transient buffer per file while checking an existing export. It now allocates
`min(stat.size, maxBytes) + 1` and **grows** (doubling, capped at `maxBytes + 1`)
only if the file outgrows its own measurement, so the ceiling is still enforced
on the read: a file that grows mid-read still trips the refusal at one byte over.

### F5 · the two straightforward cleanups

- `export/index.ts` · `params.mode ?? (existing ? "replace" : "replace")` →
  `params.mode ?? "replace"`.
- `publish/index.ts` · `currentExportAt` resolved the project directory and the
  export root inside its two-iteration loop; both are hoisted.
- The review's third item (one shared `ProjectWorkExport` instead of one in
  `ProjectWorkPublish` and one in `ProjectWorkMethods`) is **not done**:
  `methods.ts` belongs to another task's owner right now, and a constructor
  dependency there is not this batch's to change. Both instances are stateless
  beyond the store, so this is tidiness, not behaviour.

### The method byte-limit tables

`PROJECT_WORK_INTEROP_METHOD_LIMITS` is still declared and not consumed, exactly
as the spine's table is. The review noted it; enforcement is M21-T22's
("method-policy coverage"), and this batch deliberately does not expand into it.
Requests stay bounded by the length-bounded schemas.

### Evidence for batch two

| Command (`env -i PATH HOME`) | Result |
| --- | --- |
| `vitest run test/project-work/` (host) | 14 files, 205 passed |
| `vitest run test/project-work/interop*.test.ts` (host) | 3 files, 51 passed |
| `pnpm -F @lasercode/protocol test` | 46 files, 727 passed, no type errors |
| `pnpm -F @lasercode/ui exec vitest run test/project-work` | 22 files, 175 passed |
| `pnpm -F @lasercode/host test` | see the commit message for the run at this revision |
| `pnpm -r build`, `pnpm -r typecheck`, `pnpm identity:check` | see the commit message |

New tests, all fixture- or mock-based, with no traversal and no external target:

- `interop.test.ts` · a `replace` after two items left the project removes only
  the pair whose body still matches its declared digest, and keeps the edited
  body and its document byte-for-byte; a manifest this app did not write leaves
  every file in the folder alone and says so; a schema-valid manifest edited to
  name another file inside the export keeps that file instead of deleting it.
- `interop.test.ts` · an import apply is refused when the matched item gained a
  revision after the preview, nothing is written, and a fresh preview applies.
- `interop-paths.test.ts` · the read asks for the file's own size plus one byte
  rather than the ceiling, and still returns a file whole when it grew past its
  measurement while staying under the ceiling.
- `import-export.test.tsx` (ui) · the replace preview names every removed path
  (proxy: the list's `aria-label` and its text) with the honest total in the
  sentence, names what is kept and why, and says plainly when nothing in the
  folder can be removed.

## F3 · the checkpoint publication surface, as built

Approved from the plan below and implemented in this batch, with the three
additions the owner asked for (conflicting identities refused, confirmation bound
to the preview's own resolved source, latest-request fencing in the dialog).

**protocol** · `WORK_PUBLISH_SOURCE_KINDS`, `WORK_PUBLISH_SOURCES_MAX = 20`,
`WorkPublishSource` (kind, resolved `commitObjectId`, `checkpointId?`, `label`,
`carriesExport`, bounded `missing[]`) and `WorkPublishSourceSelection`. The
preview params gain an optional `source` (omitted = the current commit, exactly
what publication always did); the result gains `selected` and `sources`. Apply
params are unchanged.

**host** · `publish/git.ts#listCheckpoints(cwd, max)`: one read-only
`for-each-ref --count=<max> --sort=-creatordate --format=%(refname)%00%(objectname)`
over the worker's own namespace, every row parsed with the shared
`parseCheckpointRef` and proved to point at a commit. No worker, no new method,
no change to the T18/T19 source-control code; a checkpoint a caller *names* is
still proved by `checkpointCommit`, untouched. `publish/index.ts`:

- `resolveSource` resolves the selection — current commit, a named commit, or a
  checkpoint ref — and refuses anything that does not resolve, with a sentence.
- `plan()` measures the export against **that** state's tree (the same
  `treeAt` + `blobObjectId` proof), keeps the tree, and the apply proves every
  blob against it.
- `publishDigest` binds the resolved source (kind, commit object id, checkpoint
  ref), so a confirmation of the commit preview cannot be spent on the
  checkpoint one, or the other way round.
- the preview offers `sources`: the current commit and up to 20 checkpoints,
  each **measured** (`carriesExport`, `missing`) rather than merely listed.
- `apply` refuses **conflicting identities**: `checkpointId` with `commit:
  "HEAD"` is refused ("a checkpoint is published at its own commit"), and a
  `commit` that resolves to anything but that checkpoint's commit is refused
  ("two different states"). The host never prefers one of two identities.

**UI** · `PublishDialog` shows a chooser of the host's states (labels the host
resolved, a tick when that state carries the export, "does not have this export"
otherwise) and **no free-text field**. Choosing one re-previews with that
selection; `Check again` keeps the chosen state. The confirmation sends the
preview's own `selected.commitObjectId` (+ `checkpointId`), never `"HEAD"`, and
is disabled until that preview is ready. Every check takes a number
(`asked.current`) and an answer for anything but the newest is dropped, so a late
answer can neither overwrite the preview on screen nor enable a confirmation for
a state nobody chose — pinned by a deferred-response race test.

New tests for F3: host · the offered states include the checkpoint that carries
the export while the current commit does not; selecting it makes the preview
ready and its digest differs; the ambiguous and conflicting applies are refused
and record nothing; a stale preview digest is refused; a checkpoint that does not
carry the export previews as `carriesExport: false` with the missing file named;
an unresolvable checkpoint refuses in the preview too. `interop-git.test.ts` ·
`listCheckpoints` bounded (`--count`), namespace-only, non-commit and malformed
rows dropped, git mocked throughout. UI · the chooser lists the states, sends the
selected identity, has no text input, records the checkpoint's own commit and
ref, and drops the late answer.

## F3 · the plan as approved

What exists: the host and the protocol fully support publishing against an M20
checkpoint, proved against that checkpoint's commit; `PublishDialog` always
sends `commit: "HEAD"` and gates the button on `preview.ready`, so the path is
reachable over the wire and not by the person the product is for. `plan()`
always measures the export against `HEAD`, so a text field for a checkpoint id
would be a way to bypass the ready gate, not a surface — the preview itself has
to validate the selected source.

The shape proposed, all additive:

- **protocol** (`project-work-interop.ts`): `WorkPublishSource`
  (`kind: "commit" | "checkpoint"`, resolved `commitObjectId`, `checkpointId?`,
  a display `label`, `carriesExport`, bounded `missing[]`); preview params gain
  an optional `source` selection (omitted = the current commit, today's
  behaviour); the preview result gains `selected: WorkPublishSource` and
  `sources: WorkPublishSource[]`, bounded at a new
  `WORK_PUBLISH_SOURCES_MAX = 20`. Apply params are unchanged — `commit` and
  `checkpointId` already carry the selection, and no old-schema machinery is
  added.
- **host** (`publish/git.ts`, `publish/index.ts` only): `listCheckpoints(cwd,
  max)` — one bounded read-only `for-each-ref --count=<max>
  --sort=-creatordate --format=%(refname)%00%(objectname)
  <CHECKPOINT_REF_NAMESPACE>`, every row parsed with the shared
  `parseCheckpointRef` and proved to be a commit through the existing
  `resolveCommit`. No worker, no new route, no change to the T18/T19
  source-control evidence code. `plan()` measures the export against the
  **selected** source's tree (the existing `treeAt` + `blobObjectId` proof),
  `publishDigest` binds that source's kind, resolved commit id and ref in place
  of `head`, and `apply` resolves the same selection (`checkpointCommit`
  unchanged for the exact-ref proof), recomputes and refuses a source that moved.
- **UI** (`ImportExportDialogs.tsx`, `project-work/store.ts`): a source chooser
  — "Current commit" plus one row per discovered checkpoint, in the existing
  `aria-pressed` button style, **no free-text id field**. Choosing one
  re-previews, so the digest always fences the state on screen; each row says
  whether that state carries the export; the confirm button stays gated on the
  selected source's `ready`.
- **tests**: host — a real checkpoint selected in the preview is shown as the
  resolved source and applies against its commit; a selected checkpoint that
  does not carry the export is not ready and names the missing files; a moved
  source refuses at apply; `listCheckpoints` bounded and namespace-only with git
  mocked. UI — the chooser lists candidates, sends the selected identity, has no
  text input, and stays disabled while the selection does not carry the export.

Rough size: ~40 lines protocol, ~120 host, ~60 UI, five tests. Nothing here
fabricates an id, relaxes a proof, or switches the default away from the current
commit.

## Earlier checkpoint boundaries (before F3)

- The three interop previews and their typed confirmations are unchanged, and
  so are the preview digests, the idempotency keys, the supersession chain, the
  `pi/project/git/commit` hand-off and the deterministic export — proved by the
  existing tests in `interop.test.ts`, which were not rewritten apart from the
  checkpoint one named above.
- Behaviour a person should still check by hand: exporting into a folder whose
  *ancestor* is a link inside their own project (allowed — it writes through to
  the real folder), naming a link *itself* as the export or import root
  (refused, by design, even when it points at another folder in the same
  project), and publishing an export from a linked worktree checkout.
- `packages/host/src/project-work/{methods,store}.ts` and `router.ts` were not
  touched (M21-T19 is active in them); no protocol change was needed —
  `checkpointId` is already an opaque bounded string on the wire and its
  meaning is enforced in the host.


## Parent integration: exact UTF-8 boundary

Merged at `23a3fa45`. Integrated recursive build/typecheck, host project-work
plus design-router224, UI foundation/import-export34 and identity passed
(`/tmp/laser-interop-merged-check.log`). The final byte-proof audit found that
`readTextFile` still substituted malformed UTF-8. Its decoder now refuses
invalid input and preserves valid BOM/U+FFFD bytes. Low-level mocked-reader
regression reproduced red before the correction; interop61, host typecheck
and identity pass after it (`/tmp/laser-interop-text-green.log`).
