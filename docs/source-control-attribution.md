# Session changes are the session's own work — guide and plan

This is the brief for the agent that fixes the FILES panel showing another
session's edits. Part A explains the defect and the design so you never have to
rediscover it. Part B is the plan: tasks, files, tests, and the guards that keep
it fixed. Read `AGENTS.md` §1 first and claim tasks in `STATUS_DETAILED.md`
before writing code.

The binding spec is `docs/source-control-leap.md` §E. This document amends §E.2
and adds §E.2b; fold the amendment into the spec as part of the work.

---

## Part A — the guide

### A.1 What was observed

Two top-level sessions opened in the same checkout on the same day:

| Session | Opened (local) | FILES panel |
| --- | --- | --- |
| `…09-56-17…` | 12:56 | 81 files, +5461 −580 |
| `…14-10-03…` | 17:10 | 43 files, +3499 −129 |

The 14:10 session made almost none of those 3499 lines. Both numbers reproduce
exactly from git:

```
git diff --shortstat <14:10 session's turn-0 checkpoint>   # 43 files, +3499 −129
git diff --shortstat <09:56 session's turn-0 checkpoint>   # 81 files, +5461 −580
```

### A.2 Root cause (two defects, one design gap)

**Defect 1 — "This session" is a wall-clock window, not attribution.**
`packages/worker/src/source-control/changes.ts` `resolveScopeRangeInner`,
case `"session"`: `from = first checkpoint`, `to = live working tree`. Every
edit anyone made in that directory after the session opened is counted, whoever
made it. Two sessions sharing a checkout therefore always contaminate each
other. The spec's sentence "the session and turn scopes stay the agent's own
work" (§E.2a) is only true with one session per checkout.

**Defect 2 — there is no end-of-turn snapshot, so a turn cannot be bounded.**
Checkpoints are captured at open (turn 0, `captureBaseline`) and at each Send
(`captureForPrompt`, `server.ts:2668`). `captureAfterTurn` exists in
`service.ts:166` and is exercised by `packages/worker/test/source-control.test.ts`
but **is never called from production**. Verified on a real session:

```
…/0  12:56:17  Turn: 0
…/1  13:01:25  Turn: 1  Entry: ee9c522f     ← Send
…/2  13:03:37  Turn: 2  Entry: 715fd613     ← Send
```

So "turn N" = `Send(N−1) → Send(N)`, which spans the agent's work *and* the idle
gap afterwards, in which another session (or the person) may edit files. The
data to separate the two was never recorded. The tests pass a shape production
does not produce.

**Design gap — a multi-window diff is not a sum of diffs.** Even with correct
windows, adding per-window numstats double-counts a line edited twice. Real
example from the two sessions above: `STATUS.md` was `+9 −9` in one window and
`+5 −5` in the next; the true endpoint diff is `+9 −9`, not `+14 −14`. The fix
must produce **one** two-endpoint diff, never a sum.

### A.3 The design

Three moves. Each is small; together they make the scope honest.

**1. Every turn has a start and an end.**
At Send, capture the start snapshot (exists today). At `agent_settled`, capture
the end snapshot (wire the existing `captureAfterTurn`). The end commit is
written with the start commit as its **parent**, and the turn's single ref is
moved from the start commit to the end commit:

```
refs/laser/checkpoints/<key>/<turn>
   mid-turn:   → start commit (root)              ← same as today
   after settle: → end commit, parent = start     ← new
```

One ref per turn, so `parseCheckpointRef`, retention, `pack-refs`, session
deletion and the cleanup in the host all stay as they are. `git rev-parse
<ref>^` is the start. An extra settle (a child waking the parent) rewrites the
end commit with the same parent — last settle wins, still the same prompt. A
crash mid-turn leaves the start only, which is exactly what the live tail needs.

`CheckpointInfo` gains `endCommit?: string`. **`commit` keeps meaning the Send
snapshot** — every consumer today (undo, restore, `checkpointForRepo`,
`verifyRestoreSource`) expects that and must keep working unchanged. The reader
(`refs.ts` `listSessionCheckpoints`) adds `%(parent)` to `LIST_FORMAT`: if the
ref's object has a parent, `commit = parent`, `endCommit = objectname`;
otherwise `commit = objectname`. Legacy refs are root commits and need no
migration.

Trailers: add `Stage: start|end` to the commit message for humans reading
`git log`; the parent link is the source of truth, not the trailer.

**2. "This session" is a synthetic tree, diffed once.**
Build, in an isolated index (`GIT_INDEX_FILE`, same discipline as `capture.ts`;
its own file `<gitdir>/laser-scope-index`, its own lock), the tree that the
checkout would hold if *only this session's turns* had happened:

```
tree := start(oldest kept turn)                      # read-tree
for each kept turn T in order:
    end := endCommit(T) ?? live isolated tree if T is the running turn ?? skip
    replay delta(start(T) → end) onto tree
to := write-tree
from := start(oldest kept turn)
```

`repoChanges`, `fileDiff`, context expansion, paging — all unchanged: they get
an ordinary `{from, to}`. This is what kills the non-additivity: one endpoint
diff.

*Replay* is `git diff --binary --no-renames start end | git apply --cached
--index-info…` against the isolated index. When a hunk for a path does not
apply (another session changed the same region in a gap), fall back **for that
path only** to overlaying the blob from `end` (`update-index --cacheinfo
<mode>,<blob>,<path>`; `D` → `--force-remove`), and record the path in
`ProjectChanges.attribution.wholeFile[]` so the UI can say "this file was also
edited outside this conversation; its whole content is shown". Never fail the
scope because one file conflicted.

Turns with no `endCommit` and not running (legacy sessions, crashed turns)
cannot be replayed. For them use the old window `start(T) → start(T+1)` and set
`ProjectChanges.attribution.approximateTurns = [T…]` with the copy: "Some of
these turns were recorded before per-turn attribution; their range may include
changes made outside this conversation." Honest, and it degrades to today's
behaviour for old sessions rather than showing nothing.

Cache the synthetic tree per `(repo, sessionKey, [ref oids…], liveTreeOid)`; a
new checkpoint or a changed live tree invalidates it. It must never be reused
across sessions.

**3. "This turn" is `start(T) → end(T)`.**
Or `→ live` when T is the running turn. Not `Send(T−1) → Send(T)`. `UndoTurn.tsx:204`
passes `changesTurnForUndo(turn) = turn + 1`; audit it against the new meaning —
after the change, the number for a prompt's own work is the ref whose `entryId`
matches that prompt (M20-T7 already keys undo by entry id; the changes query
should accept `entryId` too and resolve it, keeping `turn` for compatibility).

**Residual, and how it is made visible.** Another session editing the same
checkout *during* this session's active turn is inside the window by
construction; no snapshot scheme can separate it without authorship. The worker
already knows (one worker per project): the service tracks turns in flight per
workdir; at settle, if any other session's turn overlapped `[start, end]`, add
trailer `Overlap: 1`. The reader surfaces `overlap?: true` on the checkpoint and
`ProjectChanges.attribution.overlappedTurns[]`; the Files header and the overlay
show one line: "Another conversation was editing this folder at the same time."
That is the whole point of "never again": the case we cannot fix must say so
on screen instead of showing a wrong number with confidence.

### A.4 What does not change

- The Uncommitted scope (`HEAD → working tree`, porcelain). It is deliberately
  the complete list (§E.2a).
- Commit range and This agent scopes.
- Checkpoint 0 (open baseline). It stays as the "nothing happened yet" anchor
  and the legacy fallback; it is not a turn.
- Restore/undo semantics: they restore the Send snapshot, as M20-T7 decided.
- Ref namespace, retention values, deletion, packing.

---

## Part B — the plan

Milestone: **M20**. Add the rows below to `PLAN.md` (M20 table, after T7) and
`STATUS_DETAILED.md` (M20 table + notes blocks). Record the design as a
decision `D-<next>` "Session and turn scopes are the session's own turns,
replayed into one tree" with `Supersedes: —` and cite §E.2 of the spec.
Dependency order is top to bottom; T8 and T9 are independent of each other.

| Task | Title | Done when |
| --- | --- | --- |
| M20-T8 | End-of-turn checkpoint with start as parent | `agent_settled` captures an end commit whose parent is the Send commit and moves the turn ref; extra settles rewrite the end, never mint a new turn; mid-turn the ref is the start; `CheckpointInfo.commit` still means the Send snapshot everywhere; `endCommit` populated; legacy root refs read unchanged; `captureAfterTurn` is no longer dead code and a test proves production wiring (`server.ts`, not only the service) |
| M20-T9 | Turn overlap recording | The service tracks in-flight turns per workdir; a turn that overlapped another session's turn in the same workdir carries `Overlap: 1`; reader exposes `overlap`; test with two sessions in one fixture repo, interleaved and overlapped |
| M20-T10 | Session scope replays the session's own turns | `resolveScopeRange("session")` returns `{from: start(oldest kept), to: synthetic tree}`; replay with per-path blob fallback and `attribution.wholeFile`; approximate legacy turns reported; cache keyed as in A.3; the two-session test in B.2 passes with exact numbers |
| M20-T11 | Turn scope is start→end; entry-id addressing | `"turn"` resolves `start(T) → end(T) ∨ live`; `pi/project/changes` and `pi/project/file_diff` accept `entryId`; `UndoTurn.tsx` uses it; `changesTurnForUndo` deleted or proven correct by a test that fails if the mapping drifts |
| M20-T12 | The UI says what it cannot know | Files header and overlay show the overlap line and the whole-file/approximate notes from `attribution`; copy written for a person; both themes, 320px and desktop, screenshots in the task notes; empty states unchanged |
| M20-T13 | Spec, AGENTS and regression guards | §E.2 table rewritten, §E.2b added, `AGENTS.md` gains the "Source-control regression checks" block in B.3; the M20-T2 "no rows" test in `source-control.test.ts` also proves the person's index/branches/reflog untouched by the synthetic-tree build |

### B.1 Files you will touch

| File | Change |
| --- | --- |
| `packages/protocol/src/source-control.ts` | `CheckpointInfo.endCommit?`, `overlap?`; `ProjectChanges.attribution?: { wholeFile: string[]; approximateTurns: number[]; overlappedTurns: number[] }`; `entryId?` on changes/file_diff params; schema round-trip samples (AGENTS §6b: new fields need a schema sample and router coverage) |
| `packages/worker/src/source-control/capture.ts` | `captureCheckpoint` takes `parent?: string` and `stage`; `commit-tree -p`; `checkpointCommitMessage` adds `Stage:` and `Overlap:` trailers |
| `packages/worker/src/source-control/refs.ts` | `%(parent)` in `LIST_FORMAT`; derive `commit`/`endCommit`; read `Overlap` trailer |
| `packages/worker/src/source-control/service.ts` | wire `captureAfterTurn` to find the running turn's ref (by `entryId` of the last Send) and write the end commit with that parent; in-flight turn registry per workdir for overlap; scope cache |
| `packages/worker/src/server.ts` | call `captureAfterTurn` on `agent_settled` (beside line 2661), with the prompt's entry id |
| `packages/worker/src/source-control/changes.ts` | `"session"` and `"turn"` cases; new `synthetic.ts` module for read-tree/replay/write-tree under an isolated index |
| `packages/worker/src/source-control/restore.ts` | audit only: everything must keep using `commit` (Send). Add an assertion test |
| `packages/ui/src/components/telemetry/queries.ts`, `packages/ui/src/source-control/*`, `packages/ui/src/components/thread/UndoTurn.tsx` | attribution copy; `entryId` addressing |
| `docs/source-control-leap.md` | §E.2 / §E.2b |
| `AGENTS.md` | regression block (B.3) |

Do not touch: `cleanup.ts` in the host, retention values, the ref namespace,
`GIT_EMPTY_TREE` handling, the Uncommitted scope.

### B.2 Tests that must exist (names are the contract)

All in `packages/worker/test/source-control.test.ts` unless noted. Use the
existing fixture helpers; drive turns through the service (`captureForPrompt`
then `captureAfterTurn`) **and** one test through the server's `agent_settled`
path so dead wiring cannot recur.

1. `session scope excludes edits made between this session's turns` — A: Send,
   edit `a.txt`, settle. Direct fs write to `gap.txt` (nobody's turn). A: Send,
   edit `a.txt`, settle. Session scope lists `a.txt` only, with the endpoint
   numstat of `a.txt` (not the sum of two windows).
2. `two sessions in one checkout see only their own turns` — interleave A and B
   turns on disjoint files; assert each session's file list and totals
   exactly; assert neither carries `attribution.overlappedTurns`.
3. `a file rewritten in two turns counts once` — the `STATUS.md` case: window
   numstats `+9−9` and `+5−5`, session scope reports the endpoint `+9−9`.
4. `overlapping turns are marked` — A's turn open while B's turn runs on the
   same workdir; A's checkpoint carries `Overlap`, `attribution.overlappedTurns`
   names it, the UI test renders the line.
5. `a conflicting hunk falls back to the whole file and says so` — B edits the
   same region of `shared.txt` in A's idle gap; A's replay fails for that path;
   scope still answers; `attribution.wholeFile` contains `shared.txt`.
6. `legacy root-commit checkpoints degrade to the old window and say so` —
   refs without parents; `approximateTurns` populated; numbers equal today's.
7. `the end commit's parent is the Send commit and restore still uses the Send
   commit` — after settle, `commit === parent`, `endCommit === ref`;
   `restorePreview` and `checkpointForRepo` return the Send tree.
8. `an extra settle rewrites the end, not a new turn` — two settles, one ref,
   second end tree wins, same parent.
9. `the synthetic tree build leaves the person's index, branches and reflog
   untouched` — same byte-compare technique as M20-T2.
10. `agent_settled captures the end of the turn` — through
    `packages/worker/test/…server` harness, not the service alone.
11. UI: `packages/ui/test/…` — the Files header shows the overlap line and the
    whole-file note; the overlay too; both hidden when `attribution` is empty.

Evidence for `done` is the test command for each, per `AGENTS.md` §3.1.

### B.3 The "never again" block for `AGENTS.md`

Add under §6b, heading **Source-control regression checks**:

```
- Session and turn scopes are the session's own turns, replayed into one tree
  (D-<n>): a scope is never "first checkpoint → now". A turn is bounded by its
  Send snapshot and its settle snapshot (the settle commit's parent), and the
  session scope is one endpoint diff over the replayed tree, never a sum of
  per-turn numstats. Test with two sessions interleaved in one checkout and
  with an edit made between turns by nobody.
- What the scope cannot know, it says: overlapping turns, whole-file fallbacks
  and pre-attribution turns reach the UI through `attribution`; a wrong number
  with no caveat is a bug. `captureAfterTurn` is production-wired from
  `agent_settled`; a test drives it through the server, never only the service.
- `CheckpointInfo.commit` is the Send snapshot, always. Restore and undo never
  read `endCommit`.
```

### B.4 Acceptance, in the person's words

Open two chats in the same project. Ask each to change a different file. The
FILES panel of each chat lists its own file and nothing else, with the exact
numbers `git diff` gives for that file. Edit a third file by hand between
turns; neither chat shows it. Ask both chats to edit the *same* file at the
*same* time; both panels carry the line "Another conversation was editing this
folder at the same time." Reopen a session from before this change; its panel
still works and carries the "recorded before per-turn attribution" note.

Run in the browser at desktop and phone width, both themes, before marking
M20-T12 done. Then regenerate `STATUS.md`.
