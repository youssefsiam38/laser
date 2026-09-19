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
