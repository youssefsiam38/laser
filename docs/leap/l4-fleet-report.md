# L4 fleet column — report

Milestone: source-control leap **L4, fleet half** (M18-T4 / §3 Part A). Ready for the orchestrator’s review and the person’s visual UAT. Not claimed as the leap being done.

## What was built

Three-line fleet rows in a 320px column, restyling the adopted **Subagent list** element rather than starting from an empty file.

| Line | Content |
| --- | --- |
| 1 | Name (`subagentName`, or the command’s shortened title) and elapsed time, tabular, right-aligned |
| 2 | The work’s own words — **never the task brief**. Priority: question (`needs_input`) → live `Running <tool>` / activity label → command last output line → terminal reason → result’s first sentence |
| 3 | Developer strip. Agent: agent name · model short name · turns · worktree/branch chip. Command: command · bytes · clock time |

Kind is a shape: agent = rounded tile, initials, per-agent tint; command = square terminal tile, mono title.

Filters: **Going · Asking · Ended** (toggles, counts on the chips) plus **All / Agents / Commands**. Default all on, so existing In-progress / Finished projection and Clear stay. Children still nest one indent with a rail. Session group header shows the top-level session, the project folder as secondary text, and going/asking/ended counts.

`needs_input` rows carry **Open** then **Answer**. Enter on the row expands it; Enter on Answer is swallowed (the approval rule). Clicking Answer opens the child’s chat — it never submits a reply from the column.

Worktree chip: branch with suffix-preserving truncation, or `shared checkout` when `worktree` is `null`. Ready for a later tooltip (one `Hint` wrap); does **not** read an `isolation` field.

## Design decisions for the orchestrator (`D-<n>`)

1. **Line 2 never falls back to the task brief.** Empty is better than a truncated copy of `task`. Record this; it reverses the old `activity ?? terminalReason ?? subtitle` paint.
2. **Filters sit on top of the existing lifecycle projection** (In progress / Finished, context ancestors, Clear). Going/Asking/Ended do not replace D-205’s sections; they cut them. Kind filter keeps an agent as uncounted context when only its command matches.
3. **Answer in the fleet is navigation, not a reply.** Questions stay answered in the transcript (`docs/ux-fleet.md`). Answer opens the child’s session. Enter never activates it.
4. **Worktree chip is branch-or-shared only.** No `isolation` field. Tooltip later is a one-line `Hint`.
5. **Per-agent tint is eight compiled tokens**, hashed from `agentName`, not a hue literal in the component.

## `docs/ux-elements.md` row followed

**Subagent list** — “The fleet.” Restyled `packages/ui/src/components/assistant-ui/elements/subagent-list.tsx`. No new registry install. Row paint lives in `components/fleet/FleetWorkRow.tsx`; filters in `components/fleet/FleetFilters.tsx`; the list still owns grouping, rails, Finished, and strays.

## Tokens added

Mapped in **both** themes via `FLEET_AGENT_SCALE` (dark lightness 0.38 / light 0.90) and `FLEET_AGENT_HUES` in `theme/primitives.ts`, filled in `compile.ts`, exposed as `--color-fleet-agent-*` in `globals.css`. Default `:root` fallback updated to match `compileTheme(DEFAULT_PRESET)`.

| Token | Role |
| --- | --- |
| `--fleet-agent-0` … `--fleet-agent-7` | Agent tile grounds |
| `--on-fleet-agent` | Initials on those grounds (`pickOnColor`) |

Command tiles use existing `--terminal-bg` / `--terminal-ink`. No raw hex/px/duration in the new components.

## Commands and results

```
pnpm install --frozen-lockfile
pnpm -F @lasercode/ui test        # 279 files, 2660 passed, 1 skipped
pnpm -F @lasercode/ui typecheck   # clean
pnpm -F @lasercode/ui build       # Vite green (existing ::highlight warnings only)
pnpm identity:check               # after git add of new files
```

No browser / Playwright / `scripts/browser-check` run.

## Gaps (protocol does not carry these; not invented)

- **Tokens used** (`189k` in the spec drawing). `AgentRun.activity` has turns and tools, not tokens. Strip shows turns only.
- **Output sparkline** while live. No output time series on the run. Not drawn (R6: no fake progress).
- **pid** on a command. `BackgroundTask` has no pid. Strip shows command · bytes · clock.

## What to look at first in visual UAT

1. A live agent whose brief ≠ activity: line 2 must say `Running <tool>`, not the brief.
2. An asking child: Answer and Open on the collapsed row; Enter on the row must not navigate.
3. A nested command: one indent, rail, square mono tile vs rounded agent tile.
4. Filters and their counts at 320px, both themes.
5. Worktree chip: long branch keeps the suffix; `worktree: null` says shared checkout.
6. Group header: session title, project folder, counts.
