# M21-T21 · independent review of the milestone and every follow-up fix

Reviewed tree: `/home/youssef/projects/laser/.worktrees/correct-publication-boundaries-d56447a6`
at `1a157c44` (clean). Reviewed as one behaviour: the original `e102fa34`
(29 files, +6203), the parent integration merge `217500df`, and the three
follow-up commits `fda60db4` → `2952644c` → `1a157c44` on `408366ae`. Source
and tests read in full; no changes were made to the target checkout.

**Verdict: approvable.** No structural regression, no blocker. The parent's
three follow-up fixes are real fixes, correctly implemented and honestly
documented; the acceptance list holds on the combined state. All findings
below are non-blocking, with concrete remedies. One of them (F1) is the
strongest and should be triaged rather than dropped.

## The follow-up fixes, verified

- **Containment (fda60db4, 1a157c44).** `export/paths.ts` now decides
  containment against the filesystem: the project root is resolved once
  (`projectDirectory`, fails closed), the deepest existing ancestor of every
  target is `realpath`-ed and re-checked lexically and against the forbidden
  areas (`realTarget` + the two `refuseOutside`/`refuseForbidden` calls in
  `insideProjectAt`, paths.ts:113‑131), the final component is refused when it
  is itself a link (`isLink`, paths.ts:133), reads open with `O_NOFOLLOW`
  (paths.ts:309), writes create an exclusive `wx` temp and rename
  (paths.ts:353‑366) with the directory re-resolved immediately before
  (paths.ts:368‑383), and `removeFile` unlinks regular files only
  (paths.ts:386‑394). `.git` and the settings directory apart from
  `<state>/work[-<n>]` are refused on both the written and the resolved path
  (`refuseForbidden`, paths.ts:154‑178). The nested resolutions that previously
  passed a resolved absolute root as the "project" all go through
  `insideProjectAt(projectRoot, base, …)` now (export/index.ts:144,146,264,275,293,304;
  publish/index.ts readAll:363; import/adapters.ts:673,689). Consistent with the
  handoff after the wording fix: ancestor links that resolve inside are
  followed, a path whose own last name is a link is refused unconditionally.
  The residual non-atomicity (no `openat`/`mkdirat` in Node) is named in the
  module comment, the spine plan and the follow-up doc, and is not claimed
  solved anywhere — correct posture.
- **Checkpoint bypass (fda60db4).** The `missing.length > 0 &&
  checkpointId === undefined` branch is gone. `publish/index.ts#apply`
  resolves the checkpoint first (`checkpointCommit`, git.ts:100‑116), proves
  every exported file's blob against *that* commit's tree in both the commit
  and checkpoint cases (publish/index.ts:154‑176), and records
  `commitObjectId` = the commit that actually holds the bytes, the resolved
  ref as `checkpointId`, and the proved `blobObjectId` (publish/index.ts:190‑204).
  A checkpoint from before the export, and an invented id, are both refusals
  that record nothing (interop.test.ts "refuses a checkpoint id that is not a
  checkpoint this repository has", "refuses a real checkpoint whose commit
  does not carry the export").
- **`for-each-ref` prefix match (1a157c44).** The format now carries
  `%(refname)` and the refname must equal the id asked for (git.ts:107‑112);
  a descendant ref answering for a missing one, several matches, an absent
  ref, a malformed object id and a non-commit object are all refusals, each
  pinned in `interop-git.test.ts` with `git` mocked and every invocation
  recorded. I re-derived the pattern semantics myself: the equality check
  makes the glob behaviour safe even for hostile ids, because only a refname
  exactly equal to the id can pass.
- **Growing-file read ceiling (1a157c44).** `readTextFile` bounds the read,
  not the `fstat`: at most `maxBytes + 1` bytes are pulled and the extra byte
  is the refusal (paths.ts:319‑334); `interop-paths.test.ts` proves both the
  refusal and that no more than `maxBytes + 1` was ever requested when a file
  measured at 10 bytes is 50 bytes by read time.

## Acceptance, checked against the code

Deterministic previewed adapters (sorted walks, no clocks; pin tests);
explicit conflicts with typed choices and an undecided-apply refusal; digest
fencing on all three applies (preview recomputed at apply, mismatch refuses);
licence/source provenance as `source_location` evidence + revision note, or
"not declared by the source" as a fact; `watches: false` with a worker pool
that throws in the harness (`workerAttempts() === 0` pinned per flow); no
watcher anywhere in the host interop code; manifests carry exact revisionIds,
relations, repository links and attachment refs with no timestamps
(byte-identical round trip pinned, and the round-trip test diffs two projects'
manifests modulo minted ids); explicit `replace`/`new_revision` with no
default (refused with both named); publication proved against the exact
committed or checkpoint state with every blob verified; append-only
supersession (previous link kept, `supersedesLinkId` set, two links after a
re-publish); host worker-free project IO confined with config protected; bounds
on walk depth/count, file sizes, proposals, export bytes; audits carry keys,
paths, digests and counts only — the export audit test asserts the title is
absent. UI: all three dialogs end in a host preview whose digest is sent back,
the acting button is never focused at open, Enter is swallowed in the path
fields, and the confirm buttons are disabled until the preview exists and
every decision/mode is made (unit-pinned in `import-export.test.tsx`).

## Findings

### F1 · `replace` deletes per an unvalidated previous manifest, and the UI shows the removals only as a count — non-blocking, triage

`export/index.ts:293` parses the previous manifest on disk with
`JSON.parse(manifestText) as ProjectWorkManifest` — no schema check — and
`staleFiles` (export/index.ts:286‑313) offers `entity.document` /
`entity.body` as deletion candidates after only containment, forbidden-area
and regular-file checks. A person-edited manifest may therefore name any
regular file anywhere inside the project (`../notes/plan.md` relative to the
export root resolves fine through `insideProjectAt`), and a confirmed
`replace` unlinks it. The module's own invariant — "a file a person put in
that folder themselves is not this export's to delete" — holds only while the
manifest is the one this product wrote, which nothing enforces on this path.
Two things soften it and both are real: the removal list is inside the
preview digest, so exactly what was previewed is what is deleted, and
deletion requires a typed `replace` decision. But the UI renders the removals
as a count (`{preview.removes.length} files … would be removed`,
ImportExportDialogs.tsx:507‑510), not as paths, so the confirmation the
digest fences never showed the person what would go.

Remedy (minimal): validate the previous manifest with the canonical
`projectWorkManifestSchema` — or at least run its `exportRelativePath` over
`document`/`body` — before using it as a deletion list; a real export always
passes it, and a `..`-carrying path then skips by name like any other
unreadable leftover, exactly as the follow-up already does for paths that
leave the project. And render the removed paths in the export dialog's
preview, not only their count.

### F2 · The import conflict fence does not pin the matched revision — non-blocking

`previewDigest` (import/index.ts:325‑348) records `match.entityId` but not the
matched revision; `apply` re-runs `read()` and revises against the *fresh*
`row.match.expectedRevisionId` (import/index.ts:118‑124). A matched entity
that gains a revision between preview and apply is revised anyway: never an
overwrite (a child revision is appended, the store's own concurrency keeps it
safe), but the person confirmed a preview whose `match.digest` described the
older revision, and the new revision lands on content they did not see. The
export and publish fences pin everything the preview showed; this one pins the
id only. Remedy: fold `match.digest` (or the matched `revisionId`) into the
preview digest so changed matched work forces a re-preview, the same rule the
other two applies follow.

### F3 · The checkpoint publication path has no UI surface — non-blocking, decide and record it

`PublishDialog.run` always sends `commit: "HEAD"` and the confirm button is
gated on `preview.ready` (ImportExportDialogs.tsx:493, 578); the uncommitted
panel tells the person to commit in Source control and says nothing about
checkpoints. The protocol, host and tests fully support
`checkpointId` (proven above), so an uncommitted-but-checkpointed export can
be published over the wire but not by the person the product is for. Either
add the field to the dialog (one input beside the commit hand-off copy) or
record the deferral explicitly in `STATUS_DETAILED.md`/the spine plan so it is
not assumed shipped; today it is neither surface nor decision.

### F4 · `readTextFile` allocates the ceiling, not the file — non-blocking, perf

`Buffer.allocUnsafe(maxBytes + 1)` (paths.ts:323) allocates the full ceiling
regardless of the size `fstat` just reported. `existingAt` reads every
computed file with `WORK_EXPORT_MAX_BYTES` (64 MiB) and `publish.readAll` with
16 MiB, so the unchanged-check of an existing export does one 64 MiB transient
allocation per file. The read-bound guarantee survives the obvious fix:
allocate `Math.min(stat.size, maxBytes) + 1`; a file that grows past its
measured size still fills the buffer and still trips the `read > maxBytes`
refusal, because the bound is enforced on the read either way.

### F5 · Small dead code and duplicated wiring — cosmetic

- `export/index.ts:82`: `params.mode ?? (existing ? "replace" : "replace")` —
  both branches are `"replace"`; write `params.mode ?? "replace"`.
- `publish/index.ts` `currentExportAt` re-resolves `projectDirectory` and
  `insideProject` inside a two-iteration loop; hoist them.
- `ProjectWorkPublish` news up its own `ProjectWorkExport` while
  `ProjectWorkMethods` holds another (methods.ts lazy accessors); both are
  stateless beyond the store, so one shared instance would read cleaner.

### Observation · the method byte-limit tables are declared, not enforced — pre-existing convention, not this task

`PROJECT_WORK_INTEROP_METHOD_LIMITS` (project-work-interop.ts:680) is consumed
nowhere outside its own test, exactly like the spine's
`PROJECT_WORK_METHOD_LIMITS`. Requests are still bounded, because every param
the schemas carry is length-bounded, and the six methods' limits match the
spine's convention; presumably M21-T22 (hardening, "method-policy coverage")
is where enforcement lands. Noted so nobody assumes it exists today.

## Structure and file health

No file crosses 1000 lines; the largest new files (adapters.ts 752,
project-work-interop.ts 747, interop.test.ts 877) are cohesive: one per
concern, clear seams, no conditionals bolted into shared paths. The six
methods live in their own protocol table and their own host modules, the
spine's inventory test stays untouched, the only edits outside the family are
registration (messages/schemas/method-policy/index), six delegating cases in
methods.ts, six `case` lines in router.ts, and the menu mount — the right
shape. The shared door keeps its gates: every one of the six goes through the
same `originFor`/`requireWritable`/audit as the spine's writes, and the
untrusted-folder test pins all three previews. No abstraction in the new code
is a wrapper without a job; `paths.ts` is a real boundary with one reason to
exist, and the follow-up correctly reused the host's existing
`isInsideRoot` shape rather than inventing a second containment policy.

## Checks run (target tree, `1a157c44`, `env -i PATH HOME`)

| Check | Result |
| --- | --- |
| `vitest run` (host, full suite) | 114 files, 1235 passed |
| `vitest run test/project-work/interop*.test.ts` (host) | 3 files, 45 passed |
| `vitest run` (protocol) | 46 files, 727 passed, no type errors |
| `vitest run` import-export + environment-capabilities (ui) | 2 files, 11 passed |
| `pnpm -r typecheck` | clean |
| `pnpm identity:check` | clean |

## Limits

No browser was used and no functional or acceptance testing was performed in
one, per D-342. No exploit or vulnerability reproduction was attempted; the
containment findings are from reading the code and the mocked-filesystem
tests, which deliberately exercise no real traversal. `pnpm -r build` was not
re-run (typecheck and the full host + protocol suites cover the compiled
surface). The relay, the verification/evidence pipeline and design review are
other owners' scope and were not reviewed. UI behaviour beyond the
happy-dom unit tests (layout, focus rings at real widths) remains the
person's browser check.
