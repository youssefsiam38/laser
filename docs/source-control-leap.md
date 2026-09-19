# The source-control leap — specification

Status: **agreed, not started.** Owner: orchestrator. Written 2026-09-19.

This is the binding spec for one leap covering five things that turned out to
be the same thing:

1. the **fleet** column tells a developer almost nothing per row;
2. the **telemetry** column tells a developer numbers that are **wrong**,
   because it counts only the messages this client happens to have loaded;
3. **changed files** are guessed from the agent's tool calls, so they miss what
   a command changed, miss deletions, and keep claiming a file after a revert;
4. there is no way to **read** a change, and no way to **undo** a turn;
5. the **harness** assumes every project is one git repository, so starting an
   agent in a workspace of many repositories fails and costs a turn.

All five need one thing Laser does not have: a truthful, git-backed model of
what a session changed, and a resolver that knows what shape a workspace is.

It supersedes parts of M17: **T5** (fleet row), **T6/T7** (snapshot, restore,
reviewable diff — replaced by checkpoints and the overlay), **T8** (commit and
push), **T16** (the monitor's repeated qualification). Those rows stay in
`PLAN.md` and are marked as absorbed by this leap's tasks, never deleted.

The reference read for the git model is `pingdotgg/t3code` (clone at
`/home/youssef/research-virtual/t3code`, read-only, nothing vendored), the same
source as `docs/transcript-parity.md` and D-305.

---

## 0 · Settled decisions

| # | Decision |
| --- | --- |
| 1 | The fleet groups by **session**, never by project. |
| 2 | Telemetry shows **both** API spend per model and account allowance. |
| 3 | Files open in a **full-screen overlay** over the conversation, read-only. |
| 4 | **Checkpoints are allowed to write hidden git refs** into the person's repositories. |
| 5 | **Undo this turn** ships in this leap, not later. |
| 6 | **All git actions** are in scope: commit, push, branch, pull request create / review / merge. |
| 7 | Hosts: **GitHub and Bitbucket**, through the **CLI already installed and signed in** on the machine, autodiscovered per repository. |
| 8 | A multi-repository workspace shows **one merged list, grouped by repository**. |
| 9 | **Tracked changes only.** Untracked and ignored files are not shown. |
| 10 | Commit messages, PR titles and descriptions are written by **the session's current model**, never the Namer. |
| 11 | Git actions live in the **overlay's toolbar only** this leap. |
| 12 | A fleet row opening its **agent worktree's** diff is documented and deferred. |

---

## 1 · Evidence

**Fleet.** `packages/ui/src/fleet/model.ts` already carries everything a row
needs — `activity`, `terminalReason`, `elapsedMs`, `model`, `outputBytes`,
`run`, `task`, `depth`, `children` — and `FleetPanel.tsx` (488 lines) shows
almost none of it. Measured over the 600 runs in
`<state>/agent-runs.json`: `subagentName` is 8–38 characters (median 22),
`agentName` 6–8, `task` is capped at 500 and is a brief, not a status,
`activity` is `{ turns, tools, lastAt }`, and `model` is an object carrying
`contextWindow`. Today's row shows a truncated copy of the task brief, which is
the least useful field in the record.

**Telemetry.** `packages/ui/src/components/shell/model.ts` computes every total
from `entries` the client has loaded (`usageFromEntries`, `usageByModel`,
`historyRows`). Since M16-T90 a client loads the last ten turns, so the panel's
own copy — "These totals cover the messages loaded so far" — is an apology for
a number that is simply wrong. A 27 MB session shows the spend of its last ten
turns.

**Files.** `useSessionFileChanges` collects churn from the thread's `edit` and
`write` calls. A formatter, a codemod, `pnpm build` or a `git checkout` are
invisible to it.

**Harness.** `packages/worker/src/agents/worktrees.ts:116` runs
`git rev-parse --show-toplevel` in the project directory and throws a
`HarnessError` when it fails. In `~/projects/kwentra` (41 repositories one
level down, no repository at the root) every `start_agent` with the default
`worktree: true` fails, and the model spends a turn discovering it must pass
`worktree: false`.

---

## 2 · What the reference does, and what we take

| t3code | Laser takes it? |
| --- | --- |
| A checkpoint per turn, stored at a hidden ref (`refs/t3/checkpoints/<thread>/<turn>`), captured through an **isolated temporary git index** so the person's index and working tree are untouched | **Yes**, as `refs/laser/checkpoints/<session>/<turn>` |
| Turn diff = checkpoint(N−1) → checkpoint(N); thread diff = checkpoint(0) → now | **Yes** |
| Two output shapes: full **patch** when a file is opened, **numstat** (NUL-delimited paths) for the file list | **Yes** — this is why their file list is instant |
| Restore workspace **and staging** to a checkpoint | **Yes** (undo this turn) |
| Worktree-aware: checkpoint `worktreePath ?? workspaceRoot` | **Yes**, and it is how a child agent's work is reachable |
| Git actions from the UI: commit with a generated message, push, create PR, clone, publish | **Yes**, except clone and publish (deferred) |
| PR review surface: comments, reviewers, checkout, merge, auto-merge | **Yes**, reduced: read, comment, checkout, merge |
| "Mark file as viewed", synced with GitHub's own viewed marks | **Yes** for GitHub; Bitbucket keeps ours locally |
| Six hosts through their CLIs | **Two**: GitHub (`gh`) and Bitbucket |
| Linked pull requests, GitHub stacks, auto-settle | **No** (deferred) |

---

## 3 · Part A — The fleet column

### A.1 Row anatomy

Three lines, in a 320px column, each answering a different question.

```
┌──┬─────────────────────────────────────────────┐
│wk│ Serve images as references          18m 08s │  line 1: who, and how long
│  │ ● Running vitest · protocol suite            │  line 2: what is happening now
│  │ worker · opus-5 · 251t · 189k · ⑂…6a5fb144 ▁▃▂│ line 3: the developer strip
└──┴─────────────────────────────────────────────┘
```

**Line 1** — the name (`subagentName`, or a command's own shortened form) and
the elapsed time, tabular, right-aligned. Nothing else competes for this width.

**Line 2 — the work's own words, never the brief.** In priority order:
the question when `needs_input`; the live activity (`Running <tool>`); a
command's last output line; the terminal reason (`exit 1`, "you ended it"); the
result's first sentence for a finished run. A truncated copy of the task brief
is forbidden — it is what today's rows show and why they read as noise.

**Line 3 — the developer strip.** Agent: agent name · model short name ·
turns · tokens · worktree/branch chip, plus an output sparkline while live.
Command: `command` · bytes written · pid · clock time. Tabular numerals so the
column reads vertically.

### A.2 Kind is a shape

An agent is a **rounded tile** carrying its agent's initials, tinted per agent
(`worker`, `reviewer`, …); its title is proportional. A command is a **square
terminal tile** in mono; its title is mono. A person distinguishes the two
without reading a word, which is requirement one.

### A.3 The rest

- **Grouping stays by session** (D-settled). The group header is the top-level
  session with its project as secondary text and its own counts.
- **Children nest one indent under their parent with a rail**, so a command an
  agent started reads as belonging to it.
- **Filters**: Going · Asking · Ended, plus a kind filter (all / agents /
  commands). Counts on the chips.
- **`needs_input` is a state with controls** — Answer and Open live in the row.
  Enter never answers (the approval rule).
- **Truncation order** (M17-T19 generalised): the verb never truncates; paths
  middle-truncate keeping the tail; branch and worktree names keep the suffix;
  the full text is in the tooltip and the accessible name.
- Every colour, size and duration is a token; no literal values (AGENTS.md).

---

## 4 · Part B — The telemetry column

### B.1 The scope bar replaces the apology

The first row of the panel states what the numbers cover:
`Whole session · 2 795 records · 6 compactions`. When a figure genuinely cannot
cover the whole session it says so **on that figure**, not as a blanket
disclaimer (this is M17-T16, absorbed).

### B.2 Sections

| Section | Contents |
| --- | --- |
| **Context** | Ring plus **composition**: tools / chat / thinking / system, in tokens; the window size; auto-compact threshold and state |
| **Spend** | Per model, **rolled up to include child runs**, plus the **account allowance** (both, per settled decision 2); a session with no API cost shows one line, not five |
| **Model** | Provider, model, thinking level, context window; per-turn token sparkline |
| **Work** | Turns, wall-clock duration, tool calls ranked by count with bars, failed calls named |
| **Files** | Repository groups, per-file `+/−`, totals, each row opening the overlay |
| **History** | Prompts, records, compactions, branches, how many records this client currently holds |

Every section header carries its number, so a collapsed section still informs.

---

## 5 · Part C — The telemetry query

### C.1 The rule

**The UI asks for exactly what it renders, and the authority computes it over
the whole session.** No client-side aggregation over loaded entries, ever
again. The functions in `components/shell/model.ts` that aggregate
(`usageFromEntries`, `usageByModel`, `spendSeries`, `historyRows`) are deleted
or reduced to formatting.

### C.2 Method

```
pi/session/telemetry
  params: { path, scope?: "session" | "turn", turnId?, include?: TelemetrySection[] }
  result: SessionTelemetry
```

`SessionTelemetry` mirrors the sections in §4.2 one-to-one: context
composition, usage by model with a child roll-up, model identity, turn and tool
counts, a ranked tool histogram, the changed-file summary (from Part E, not
from tool calls), and history counts. Numbers only — no entries, no bodies, no
text. A section the caller did not ask for is absent, not empty.

### C.3 How it is computed

- **Authority**: the worker when the session is live (it already has the
  engine's state), the host when it is not. Both answer identically, proved by
  a test, exactly as the history window contract requires.
- **Incremental**: a telemetry snapshot is cached against the session's
  `revision`. A revision the cache knows is answered from memory; a newer one
  folds only the records appended since. Opening a 27 MB session must not
  re-read 27 MB, and a streaming turn must not recompute from zero per delta.
- **Delivery**: the current snapshot on request, then deltas through the
  existing session update channel while a turn streams. The panel never polls.
- **Fenced**: the reply carries the revision and environment key it was
  computed at, and a stale reply is refused, like every other read.
- **Bounded**: the tool histogram is the top N with an "other" bucket; the
  file summary is `numstat`, never patches.

### C.4 Where the numbers come from

Token and cost figures come from the engine's own per-turn `usage` records
(`protocol/messages.ts`: "`usage` is that one turn's token counts — not a
running total"), summed by the authority over every record in the session,
including compacted ranges. Child-run costs are summed from the runs registry
by root session. Context composition is computed from the live request the
engine assembled, not guessed from the transcript.

---

## 6 · Part D — Workspace shapes and the harness

### D.1 One resolver, three consumers

`workspaceShape(cwd)` lives in the worker (harness) and the host (viewer), or
in one shared pure module with two callers. It answers:

| Shape | Detection | Harness | Viewer |
| --- | --- | --- | --- |
| **repo** | `rev-parse --show-toplevel` succeeds | worktree under `<toplevel>/.worktrees/`, as today | one repository |
| **workspace of repos** | root is not a repository, children are | runs in the shared checkout, and says why | merged list grouped by repository |
| **no git** | nothing found | runs in the shared checkout, and says why | "no repository here" empty state |
| **nested repo** | a repository inside a repository (`kwentrakit/temp`) | belongs to its own repository, never the outer one | its own group |
| **bare / submodule** | `--git-common-dir` disagrees; `.gitmodules` present | worktree from the real common dir | documented, unsupported this leap |

A monorepo with one `.git` is the **repo** shape. That is why
`~/projects/kwentra/connecting` already works and needs no special case.

Discovery of child repositories is bounded: depth-limited, `node_modules` and
other ignored directories skipped, results cached per project and invalidated
on a filesystem change or an explicit rescan.

### D.2 What changes in the harness

1. **`start_agent` never fails because of workspace shape.** It returns the
   identities, and the result says where the child is working and why:
   "No repository here, so this agent shares your checkout", or "This workspace
   holds 41 repositories, so an agent cannot be isolated from all of them;
   sharing your checkout." The wasted turn disappears.
2. **`worktree` gains a third value.** `true` means *isolate if this workspace
   can be isolated* (the new default behaviour), `false` is unchanged, and
   `"strict"` demands isolation and refuses without it. Only `"strict"` produces
   the refusal wording D-156 requires, and that wording keeps naming both ways
   forward.
3. **A project default** in Settings, per project: *Isolate agents · Share my
   checkout · Decide per agent*.
4. **Worktrees resolve against the real common dir**, so a worktree of a
   worktree lands beside its siblings rather than nested inside one.
5. Every existing worktree guarantee stands: ownership by `runId`, the path
   fence (`assertSafeWorktreePath`), refusal to hand over a worktree that is not
   at the parent's commit, and the parent owning review, merge and removal
   (D-157).

---

## 7 · Part E — Checkpoints, scopes and undo

### E.1 The checkpoint

After every turn, for every repository the session's working directory belongs
to, the worker captures a checkpoint:

- a commit object written with an **isolated temporary git index**
  (`GIT_INDEX_FILE` scoped to the capture, never exported into anything else —
  AGENTS.md §5a already carries this rule for releases and it applies here);
- stored at `refs/laser/checkpoints/<sessionId>/<turnCount>`;
- **invisible** to `git log`, `git status`, branches and the reflog of the
  person's own work; nothing is staged, stashed, reset or cleaned, ever;
- tracked files only (settled decision 9);
- captured for `worktreePath ?? projectRoot`, so a child agent's worktree
  checkpoints itself.

Retention: a stated cap per session with the oldest checkpoints pruned, a
per-project off switch, and `Delete session` removing that session's refs.

### E.2 Scopes

| Scope | Range | Default for |
| --- | --- | --- |
| **This session** | first checkpoint → now | the telemetry Files section |
| **This turn** | checkpoint(N−1) → checkpoint(N) | a turn's own control in the transcript |
| **Uncommitted** | HEAD → working tree | the overlay's "what would I commit" |
| **Commit range** | any two refs the person picks | the overlay's picker |

### E.3 Methods

```
project/workspace          → the resolved shape and its repositories
project/changes            → { scope, repos: [{ repo, branch, files: [{ path, status, added, removed }] }] }   (numstat)
project/file_diff          → one file's patch for a scope, with context expansion
project/file_source        → one file's bytes at a ref (for the overlay's plain view)
project/checkpoint/list    → the session's checkpoints
project/restore            → files, conversation, or both, for a turn
```

All are protocol-first with round-trip samples and router coverage (AGENTS.md
§4.2, §6b). Diffs are read through the same byte-range discipline the transcript
uses: a large patch is paged, never sent whole.

### E.4 Undo this turn

Restoring a turn puts the checkpoint's files **and staging state** back, and is
offered together with the conversation move Laser already has
(`pi/session/navigate`). One explicit confirmation names exactly what will be
restored, in which repositories, and what is currently uncommitted that would
be lost. An option that would do nothing is hidden, not disabled. Restore is
refused, with a sentence, while a turn is running.

---

## 8 · Part F — The overlay

### F.1 What it is

A full-screen surface over the conversation, read-only, opened from a file row
in telemetry (and later from other places). The conversation keeps its scroll
position and its draft; Escape returns to exactly where the person was.

```
┌────────────────────────────────────────────────────────────────┐
│ Changes · This session ▾   laser ▾   +1 204 −318      Commit… ✕ │  toolbar
├───────────────┬────────────────────────────────────────────────┤
│ ▸ laser       │ body-range.ts │ transcript-viewport.tsx │ +    │  tabs
│   body-rang…  ├────────────────────────────────────────────────┤
│   transcri…   │  221 ┊ +  const bytes = utf8ByteLength(…)      │  diff
│ ▸ connecting  │  222 ┊ +  recordBytes.set(entry, bytes);        │
└───────────────┴────────────────────────────────────────────────┘
```

### F.2 Regions

- **Toolbar**: scope picker (§7.2), repository filter when the workspace has
  more than one, totals, git actions (§9), close.
- **Tab strip**: one tab per opened file, mono, with its status mark; middle
  click closes; the set survives closing and reopening the overlay within a
  session.
- **Left rail**: the changed-file tree, **grouped by repository** with per-group
  branch and totals, per-file `+/−`, and a **viewed tick** per file with a
  running count.
- **Body**: the diff, split by default with a unified toggle, our own Shiki
  tokens and theme, line numbers, expandable context, and virtualization
  through `@legendapp/list` (already a dependency since M16-T91).

### F.3 Rendering

**Decision (proposed): no diff-UI dependency.** We take a patch **parser**
only, and render with the elements we already own — `code-diff.tsx`,
`file-tree.tsx`, `artifact-card.tsx` — and the Shiki pipeline that draws the
transcript's fences.

Candidates considered, with verified facts:

| Library | Licence · version | Highlighter | Why not |
| --- | --- | --- | --- |
| `@pierre/diffs` | Apache-2.0 · 1.4.3 | Shiki `^3 \|\| ^4` (compatible) | Ships `@pierre/theme` + `@pierre/theming`; a second design system to defeat. **The fallback if we want speed.** |
| `@git-diff-view/react` | MIT · 0.1.7 | Bundles `highlight.js` + `lowlight`; its Shiki add-on wants `shiki ^3.23` while we pin 4.4.3 | Two highlighters and possibly two Shiki copies (grammars are megabytes) |
| `react-diff-view` | MIT · 3.3.3 | None; you feed tokens | Closest to our needs; its parser (`gitdiff-parser`, MIT) is what we actually want |
| `@codemirror/merge` | MIT · 6.12.2 | Lezer | An editor, not a review surface; only worth it if files become editable |

The deciding reason is not the code: a diff in the overlay must look identical
to a diff in the transcript, and `docs/ux-elements.md` already claims both
surfaces. **Open item: confirm this choice before Part F starts.**

### F.4 The bar

Every state is designed: no changes, one file, a huge file, a binary file, a
deleted file, a renamed file, a repository that failed to read. Both themes,
both pointers, phone width (the overlay becomes a single column with the tree
as a sheet). Keyboard: open, close, next/previous file, next/previous hunk,
toggle viewed, switch tabs. Find inside the overlay uses the shared find
machinery, not a second one.

---

## 9 · Part G — Git actions

### G.1 Scope

Commit (staged set chosen in the overlay), push, create branch, create pull
request, read a pull request with its comments and checks, check out its
branch, merge it. In the overlay's toolbar only (settled decision 11).

### G.2 Hosts and discovery

GitHub through `gh`, Bitbucket through the Atlassian API token arrangement, in
both cases **using the login already on the machine** (settled decision 7).
Per repository, the host is discovered from its remotes, so a workspace of many
repositories can carry several hosts at once. A repository whose host is not
supported, or whose CLI is missing or signed out, says so in a sentence with
the one command that fixes it — and every other repository keeps working.

### G.3 The prose is written by the session's model

Commit messages, PR titles and PR descriptions are generated by **the session's
current model**, never the Namer (settled decision 10). The Namer is a small
model for session titles; it has not seen the code. The session's model already
holds the conversation that produced the change, which is what makes the message
good. Repository conventions (recent commit subjects, the project's
instructions) are part of the prompt. Every generated text is editable before it
is used, and nothing is ever committed or pushed without an explicit
confirmation naming the branch, the remote and the files.

### G.4 Safety

No shell interpolation of user text, ever. No force push, no history rewrite, no
stash, no clean, no reset of the person's working tree, no tag moves. An action
with an uncertain outcome is reported as uncertain and never retried
automatically. Remote and phone views fall back to copyable commands where the
action needs a credential that lives on another machine.

---

## 10 · Milestones

| # | Title | Done when |
| --- | --- | --- |
| **L1** | Workspace shapes and the harness | `workspaceShape` resolves all five shapes with tests over real layouts (a repo, a monorepo, a 41-repo workspace, a nested repo, no git); `start_agent` never fails over shape; `worktree: "strict"` keeps D-156's refusal; the project default exists in Settings; no wasted turn in `~/projects/kwentra` |
| **L2** | Checkpoints, scopes, restore | Checkpoints captured per turn per repository through an isolated index; the person's index, working tree, branches and reflog provably untouched; `project/changes` returns numstat for all four scopes; live and durable authorities agree; undo-this-turn restores files and staging behind one confirmation; retention cap and off switch |
| **L3** | Telemetry query | `pi/session/telemetry` computes over the whole session, incrementally, fenced by revision; both authorities identical; opening a 27 MB session performs no full re-read; every client-side aggregation deleted; the panel's apology gone |
| **L4** | The two columns | Fleet rows as §3, telemetry sections as §4, at 320px, both themes, both pointers, with interaction tests for the asking state, nesting, filters and truncation order |
| **L5** | The overlay | Files open full-screen, tabs, tree grouped by repository, split and unified, Shiki tokens, viewed ticks, all designed states, keyboard path, phone layout |
| **L6** | Git actions | Commit, push, branch, PR create / read / checkout / merge for GitHub and Bitbucket through installed CLIs, per-repository discovery, session-model prose, explicit confirmations, no interpolation |

L1 and L3 are independent of each other; L2 depends on L1; L4 depends on L3;
L5 depends on L2 and L4; L6 depends on L5. Each milestone gets one independent
review and one correction batch, and the person performs browser acceptance on
a parent-built sandbox before any release (the working agreement since 0.9.2).

---

## 11 · Decisions to record

| ID | Decision |
| --- | --- |
| D-307 | A workspace has a shape, and the harness adapts to it instead of refusing; `worktree: true` means "isolate if possible", `"strict"` means "isolate or refuse" |
| D-308 | Laser writes hidden checkpoint refs (`refs/laser/checkpoints/…`) through an isolated index; the person's index, tree, branches and history are never touched |
| D-309 | Telemetry is computed by the authority over the whole session and delivered as exactly the fields the UI renders; the client aggregates nothing |
| D-310 | Changed files come from git, never from the agent's tool calls |
| D-311 | Files open in a read-only full-screen overlay; git actions live in its toolbar and nowhere else this leap |
| D-312 | Commit messages and pull-request prose are written by the session's current model, never the Namer |
| D-313 | The overlay renders diffs with Laser's own elements and Shiki; a patch parser is the only dependency taken *(pending confirmation, §8.3)* |

---

## 12 · Not in this leap

- Editing files in the overlay.
- Opening an agent worktree's diff from its fleet row (documented here, deferred).
- A commit control in the transcript or beside the composer.
- Cloning and publishing repositories.
- Linked pull requests, stacks, auto-merge, auto-settle.
- GitLab, Gitea, Forgejo, Azure DevOps.
- Untracked and ignored files; submodules; bare repositories.
- Any Pi-side change: this leap touches the worker, host, protocol and UI only,
  and imports no engine API beyond what the worker already uses.

---

## 13 · Open questions

1. §8.3 — confirm "our own rendering plus a parser" rather than `@pierre/diffs`.
2. Split or unified as the overlay's default view.
3. Checkpoint retention: how many turns per session before pruning, and does a
   deleted session take its refs with it silently or ask?
4. Whether `project/changes` should include a repository the session never
   touched but which sits in the same workspace (my proposal: no, unless the
   person asks for it in the repository filter).
