# The fleet column, redrawn — and stopped flickering

Branch `agents/fleet-column-redesign-481531e3`, from `e2ebfcb7`.

What changed, in one line each: the column spends **72px** on itself instead of
198; a row is a row, not a card in a card in a card; the third line says
something a developer cannot read anywhere else; and the rows stopped being
removed and re-added every time a command wrote output.

**Look at this first.** Open a session with one child agent and one background
command, at 320px, in both themes: the column now starts with one 48px header
and one 24px filter row, and the first thing under them is the session, not a
third band of counts. Then watch a `pnpm vite dev` row for ten seconds — the
rows no longer blink.

---

## 0 · The flicker (the defect, ahead of the paint)

**Reported:** with one context-only *Explorer* row and one live command, the
fleet removes and re-adds rows, alternating, about every 1.2s — the rate at
which the command's `outputBytes` change — with new DOM nodes each time.

### What I found, with evidence

I reproduced three defects at the unit level (`buildFleet` / `selectFleet`
called twice with inputs differing only in a task record). All three are now
pinned in `packages/ui/test/fleet/stability.test.tsx`.

**1 · Attribution followed the snapshot, not the work.** A command hung off its
session only when the *tree* had a node for that session, and the tree is built
from the runs and catalog rows the client happens to hold at that moment.

```
with run + catalog row   /p/root.jsonl: agent:/p/child.jsonl[task:t1]
no run, no row           /p/child.jsonl (deleted): task:t1
broken chain (before)    /p/child.jsonl (deleted): agent:/p/grand.jsonl[task:t1]
broken chain (after)     /p/root.jsonl: task:t1
```

Line 3 is the one that matters: `/p/grand.jsonl`'s catalog row *declares*
`rootPath: /p/root.jsonl`, but the chain walk broke at the unknown middle
session and the declared root was thrown away. The command left its session's
tree and formed a group of its own; that group, having no catalog row, is drawn
as **"work from a deleted session"** at the bottom of the column — a different
`<ul>` with identical markup. And because the ended *Explorer* row exists in
"In progress" only to carry its running child, it left with the command and
came back with it. That is precisely the reported pair: one row removed from a
`ul`, the other added to a `ul`, alternating, `reused node: false`.

*Fix* (`packages/ui/src/fleet/model.ts`): a record that names its own root is
believed before a chain that has to be walked (`rootOfSession`), and inside a
group a command hangs off the deepest ancestor the tree actually has, falling
back to the group root (`hostOf`). A missing link now costs one indent, never a
change of list, and a command assigned to a group can no longer be dropped from
it (R7).

**2 · Order fell back to map order.** Two commands with the same `startedAt`
were ordered by `Object.values(tasks)`, and the `tasks/loaded` reducer rewrites
that insertion order for every session it lists — so a reconnect could swap two
rows with nothing about either having changed.

```
map order { a, b }   task:a task:b
map order { b, a }   task:b task:a      ← before
map order { b, a }   task:a task:b      ← after
```

*Fix:* tasks sort by `(startedAt, id)`; groups sort by
`(current, needsYou, running, title, path)`; a group's `cwd` picks a sorted
candidate rather than the first run the map yields.

**3 · Every object was rebuilt on every tick.** One changed task record
replaced every `FleetItem` and every `FleetGroup` in the column, so every row
re-rendered on every output tick of every command.

*Fix:* `createFleetSelector` now reconciles the new build against the previous
one (`sameFleetItem` / `sameFleetGroup`, bottom-up) and keeps the old objects
wherever the new build says the same thing. An untouched sibling subtree is the
same object across an output update, so React does not even re-render it.

### What is pinned

`packages/ui/test/fleet/stability.test.tsx` (12 tests):

- the same keys in the same order across five output ticks;
- the context parent present for every one of them, never counted as work;
- untouched sibling item *and* its child are the same objects; the changed
  command is a new object under the same key;
- keys are exactly `agent:<sessionPath>` / `task:<id>`, whatever changes;
- map-order independence for commands and for same-titled sessions;
- a command stays under its agent when the run leaves the snapshot, when the
  catalog row has not arrived, and when the chain has a hole;
- a command is drawn exactly once across every group;
- **through the component:** ten `tasks/update` cycles, asserting every row is
  the *same DOM node* in the same position, the context row never blinks, and
  no deleted-session line appears; plus a rewritten task map that does not
  reshuffle two rows.

### What I could not reproduce

With the shipped code I could not make the pure model *or* the rendered column
alternate from a task update alone — the trigger has to be an attribution input
that is momentarily incomplete (defect 1), and the 1.2s period is simply the
rate at which the column was rebuilt at all (defect 3). Both are fixed; if a
flicker survives, the next evidence to capture is `agents.runs` and `sessions`
at the two frames, because those are now the only inputs that can move a row
between lists.

---

## 1 · Chrome budget

| | before | after |
| --- | --- | --- |
| panel header | 48 | 48 |
| filter chips | 110 (two rows) | 24 (one row) |
| "In progress" band | 40 | 0 |
| **chrome total** | **198** | **72** |
| group header (content) | 28 (one line) | 46 (two lines) |
| top of column → first work row | 234 | 118 |

Measured in `test/fleet/chrome.test.tsx`, off the rendered DOM: every band
carries `data-fleet-chrome` and a fixed `h-*` utility, and the test resolves
those utilities against the 4px spacing unit (`h-12` → 48) and sums them. It
also asserts the bands are exactly `["header", "filters"]` and that the element
immediately before the first session group is the filter row — so a third band
cannot creep back in unmeasured.

The header stays 48px because the sessions and telemetry columns are 48px: the
three columns start on one line across the window. The filter row paints 24px
and grows to a 44px target on a coarse pointer (`pointer-coarse:h-11`), asserted
for the row and for all six controls.

The group header is **content**, not chrome, and is excluded from the 72: the
brief itself requires it to be two lines (session title, then project and
counts). It is 46px.

---

## 2 · The six problems

**1 · Two rows of filter chips ate 92px.** One row now
(`components/fleet/FleetFilters.tsx`): three lifecycle toggles, a hairline, and
the kind choice, all `shrink-0` in an `overflow-x-auto scrollbar-none` row that
scrolls rather than wraps. A count is drawn only when it is not zero, so
`Asking 0` is just `Asking`. "On" is the resting state and carries no ground;
"off" is dimmed *and* struck through, so the cut is not colour alone. Pinned:
one filters element, six controls, all in it, no `flex-wrap`, no `0` anywhere.

**2 · The group header was cryptic.** `PROJECT 1 · 2` is gone. Line 1 is the
session title, middle-truncated (`GROUP_TITLE_BUDGET`, 40) so the end of a long
prompt survives; line 2 is the project name in mono at the 12px floor and the
counts **in words** with zeroes omitted — `2 going · 1 asking · 1 ended`. No
filled band: the header sits on the column's own `bg-surface` and is separated
by a hairline, sticky and opaque.

**3 · Card inside card inside card.** The per-row card is gone: no border, no
radius, no shadow, no second ground (asserted on every row element). Siblings
are separated by one hairline (`divide-y divide-line` on the list). Hover and
selection are grounds from the token set; the open row keeps the ground and
adds a 2px `--live` rule on its inline start. The nesting rail is one hairline
(`border-s`) with no elbow and no box.

**4 · The developer strip repeated line 1 and truncated a number.** A command's
line 3 is now **exit state · bytes · start time** — `exit 0 · 185 KB · 10:51 PM`
— with each field `shrink-0` and never `truncate`: a truncated number is not a
number. A non-zero exit turns the status word `--danger-quiet` (the token the
transcript already uses for "came back non-zero"), and a command that could not
run says `failed` rather than inventing a code. The command string belongs to
line 1, which middle-truncates it (`COMMAND_BUDGET`, 24) so `--port 5173`
survives; the whole command is the accessible name and the app's tooltip.

**5 · The two kinds did not read as one family.** Both rows now have the same
anatomy, the same paddings and the same 20px tile, differing only in the shape
the leap asks for: the agent's is rounded and tinted per agent, the command's
is a square terminal tile. Both take their letters from the `eyebrow` utility
(mono, 11px, tracked, uppercase — the one sub-12px exception, and never a
value), and both are optically aligned to line 1's cap height (`-mt-0.5`), not
its line box. The status dot rides the tile's corner instead of taking a column
of its own, which gives 16px of a 288px column back to the name.

**6 · A context ancestor was the tallest row.** It is now one dimmed line: no
subtitle sentence, no line 2, no line 3, no elapsed, and a tile no larger than
the rows it contextualizes (`data-quiet`). "Parent of work shown here." is in
the row's accessible name, where it costs no height.

---

## 3 · Tokens

**None added.** Everything here is an existing token: `--surface`,
`--surface-2`, `--line`, `--ink`/`--ink-2`/`--ink-3`, `--live`, `--terminal-bg`,
`--fleet-agent-*`, `--on-fleet-agent`, the `eyebrow` and `typed` utilities, the
spacing unit and the radius scale. The one colour that is new *to this surface*
is `--color-danger-quiet`, already defined in `globals.css` as a `color-mix` of
per-theme `--danger` and `--ink-3`, so it resolves in both themes with no new
mapping. `test/design-system.test.ts` passes, including the rule that 11px may
only arrive through `eyebrow`.

## 4 · Files

| file | what |
| --- | --- |
| `src/fleet/model.ts` | declared-root attribution, nearest-ancestor hosting, total ordering, identity-preserving rebuild |
| `src/fleet/chrome.ts` | the 72px budget and the two band heights (new) |
| `src/fleet/row.ts` | a command's strip: exit state, bytes, clock — no command echo |
| `src/fleet/truncate.ts` | `COMMAND_BUDGET`, `GROUP_TITLE_BUDGET` |
| `src/components/fleet/FleetFilters.tsx` | one scrolling filter row |
| `src/components/fleet/FleetWorkRow.tsx` | the row: no card, 20px tile, three honest lines |
| `src/components/fleet/FleetPanel.tsx` | header marked as chrome, aligned insets |
| `src/components/assistant-ui/elements/subagent-list.tsx` | group header, hairline lists, no "In progress" band in the tree |
| `test/fleet/stability.test.tsx` | the flicker, pinned (new) |
| `test/fleet/chrome.test.tsx` | the measurable visual claims (new) |

## 5 · Validation

```
pnpm -F @lasercode/ui test        306 files, 2825 passed, 1 skipped
pnpm -F @lasercode/ui typecheck   clean
pnpm -F @lasercode/ui build       clean
node scripts/check-direction.mjs  no physical layout utilities
pnpm identity:check               clean
```

No Playwright and no `scripts/browser-check`, as instructed; the visual review
is yours.

---

## 6 · The remount (the flicker that survived §0)

**Reported, measured in the running app after §0 shipped:** one *ended* child
agent drawn as a context row, carrying one *live* command whose `outputBytes`
move about every 1.2 s. Row membership is stable across a 5 s window, and yet
8 `<li>` removals and 8 additions land in 8 s, alternating the parent row and
the nested row, while the `<section>` and the `<ul>` around them survive.

A stable list whose child is replaced can only mean one thing: within that
`ul`, the child's **key or element type changed**, or the list's **items
changed**. Those are the only three, and the third is the one that happened.

### 6.1 · What the section in the key can and cannot do

The leading hypothesis was `key={`${section}:${item.item.key}`}` in
`subagent-list.tsx` — a row that flips between `active` and `finished` would
get a new key and remount. **Refuted, twice over:**

- *Structurally.* `FleetGroups` is rendered once per (section, group) and is
  given the section as a literal; every row inside that one `<ul>` therefore
  carries the same constant prefix. The prefix cannot change while the `<ul>`
  survives — and the measurement says it survived. A row that really does
  change section changes `<ul>` as well, and React replaces the node whatever
  the key says.
- *Empirically.* For this exact shape the projection's `section + key + nesting`
  is constant across ten output ticks —
  `test/fleet/stability.test.tsx` → "gives every row the same section and the
  same key across ten output ticks". It was green before this change.

The other named candidates are refuted the same way: `FleetBranch`,
`FleetGroups` and `FleetWorkRow` are module-level (no component is created
during a render, so no element type changes), the one conditional in
`SubagentList` swaps the whole list — which would replace the `<ul>` — and
there is no `Fragment`/`Suspense` boundary in the path. A rendered harness over
the **real store** (`createStateStore` + `LaserStoreProvider`, real
`useLaserState`, real `selectFleet`) kept every `li` node across: output-only
`tasks/update` ticks, whole-map rewrites in the `tasks/loaded` shape, the
column's 1 s elapsed clock, the child's run leaving and rejoining the registry,
and the child's catalog row leaving and rejoining.

### 6.2 · The confirmed cause: the command's host follows the snapshot

Only one input change reproduces the measured signature. A command hangs off
its session while `buildAgentTree` has a **node** for that session, and a node
exists only if the client holds either a run for it or an *attributed* catalog
row. Both of those thin out on their own schedule — `agents/runs` replaces the
registry wholesale, `pi/session/list` returns a bounded page (`size: 7` per
project plus probes) — under a command that is still writing. When they do:

```
snapshot knows the child   active /p/root.jsonl agent:/p/child.jsonl (context)
                           active /p/root.jsonl ·task:t1
                           finished /p/root.jsonl agent:/p/child.jsonl
snapshot forgets it        active /p/root.jsonl task:t1
```

The command leaves its agent's nested `ul` for the group's own: **the parent
`li` (which carries the nested command row) is removed and a top-level command
`li` is added**, then back on the next update. That is the reported mutation
pair, in that order, with the same two pieces of work present throughout — so
membership, counts and the `Finished` fold (collapsed) all look unchanged.
§0's R7 rule accepted this: "a node that comes and goes moves the command one
indent rather than into another list". One indent *is* another list.

Rendered, on `bf450d5a`, the failing assertion is exactly the measurement:

```
tick 1: expected [ 'task' ] to deeply equal [ 'agent', 'task' ]
tick 1: expected [ 'active /p/root.jsonl task:t1' ]
        to deeply equal [ 'active … agent:/p/child.jsonl (context)',
                          'active … ·task:t1',
                          'finished … agent:/p/child.jsonl' ]
```

I could not attach to the person's running app to name *which* of the two
sources went quiet there; both produce this exact drawing, and the fix closes
both.

### 6.3 · The fix

Both halves of the brief, because they answer different questions.

**Identity is the work's, not the list's** (`subagent-list.tsx`): rows are
keyed `agent:<sessionPath>` / `task:<id>`; the section and the context/actual
role travel as props on `target`. Inert for the measured remount (§6.1), and
it removes the hazard class permanently.

**Live work never changes parents because the snapshot got thinner**
(`fleet/model.ts`, `keepLiveCommandsHosted`): the fleet remembers the row a
running command was drawn under. If the next build has no row for the session
that started it, the previous build's row is held open — the same row object,
with this build's children — and the command stays inside it. The rule is
narrow on purpose:

- only a **command that is still going** (a terminal one is the build's again);
- only the row of the **session that started it** (`agent:<sessionPath>`), never
  an ancestor it merely fell back to — that is still R7's answer to a chain
  with a hole in it;
- only while that row is **drawn nowhere** in the new build (a command that
  genuinely moved moves);
- only inside the **same group** (which root a piece of work belongs to is
  §0's declared-root rule, unchanged).

The memory is the previous drawing and nothing else. The selector now keeps it
beside the per-runs cache rather than inside it, because the runs object is
replaced by the very change that loses a run — which also means item identity
now survives any run-registry change instead of handing React a fresh object
for every row.

### 6.4 · Tests

| test | claim |
| --- | --- |
| `stability.test.tsx` → "gives every row the same section and the same key across ten output ticks" | the unit-level constancy the hypothesis needed; green before and after |
| `stability.test.tsx` → "keeps a running command under its agent when the snapshot forgets that session" | **red before**: `[active … task:t1]` instead of the three rows |
| `stability.test.tsx` → "keeps every row node when the snapshot forgets the session under a running command" | **red before**: rendered rows `['task']` instead of `['agent','task']`; asserts the `ul` survives and both `li` nodes are the same objects for ten ticks |
| `stability.test.tsx` → "holds a row open for the session that started the command, and for nothing else" | a command that changed session is never re-hosted |
| `stability.test.tsx` → "lets go the moment the command ends" | the memory is not a ghost row |

### 6.5 · Validation

```
pnpm install --frozen-lockfile   clean
pnpm -F @lasercode/ui test       310 files, 2865 passed, 1 skipped
pnpm -F @lasercode/ui typecheck  clean
pnpm -F @lasercode/ui build      clean
pnpm identity:check              clean
```

Fleet suite alone: 7 files, 144 passed (139 before this change). Two heavy
log-dialog files time out at 5 s when the machine is under load (load average
> 45 from other work); they pass on this branch in isolation and fail the same
way on `bf450d5a`. No Playwright and no `scripts/browser-check`, as instructed.
