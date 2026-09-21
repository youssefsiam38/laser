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
   inside the project. A link **above** the target that leads out is refused; a
   link that stays inside is the person's own folder layout and is allowed. The
   final component is never followed: an existing leaf link is refused outright.
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
6. `readTextFile` opens with `O_NOFOLLOW`, `fstat`s the **descriptor** and
   refuses anything that is not a regular file within the ceiling — the bound
   is kept and the bytes read are the bytes of the file that was measured.
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

Commands run in this worktree (`env -i PATH="$PATH" HOME="$HOME"` throughout),
at commit `fda60db4`:

| Command | Result |
| --- | --- |
| `vitest run test/project-work/interop-paths.test.ts` (host) | 14 passed |
| `vitest run test/project-work/` (host) | 13 files, 191 passed |
| `pnpm -F @lasercode/protocol test` | 46 files, 727 passed, no type errors |
| `pnpm -F @lasercode/host test` | 113 files, 1227 tests: 1226 passed, 1 failed |
| `pnpm -r build` | all packages built |
| `pnpm -r typecheck` | clean |
| `pnpm identity:check` | "every generated file agrees, no stray literals" |

The one host failure is `test/session-index.test.ts > hard bounds > keeps cold
20k/50k scans linear and cooperative` — a wall-clock ratio assertion
(`repeat20Ms < cold20Ms / 2`) in an unrelated module, under a loaded machine.
Re-run on its own it passes (18 passed); nothing in this change touches the
session index.

No browser was used.

## What is not covered

- The three interop previews and their typed confirmations are unchanged, and
  so are the preview digests, the idempotency keys, the supersession chain, the
  `pi/project/git/commit` hand-off and the deterministic export — proved by the
  existing tests in `interop.test.ts`, which were not rewritten apart from the
  checkpoint one named above.
- Behaviour a person should still check by hand: exporting into a folder that
  is a link inside their own project (allowed, writes through to the real
  folder), and publishing an export from a linked worktree checkout.
- `packages/host/src/project-work/{methods,store}.ts` and `router.ts` were not
  touched (M21-T19 is active in them); no protocol change was needed —
  `checkpointId` is already an opaque bounded string on the wire and its
  meaning is enforced in the host.
