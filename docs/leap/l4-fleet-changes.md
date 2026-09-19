# L4 fleet — Changes entry and isolation hint

Ready for the orchestrator’s review and the person’s visual UAT. Not the leap being done.

## What was wired

A fleet **agent** row carries **Changes**, the same size and placement as Open / Answer. It calls `openChanges({ scope: { kind: "agent", runId }, sessionKey })` from `@/source-control/store.js` (not the package barrel). A command row never gets it. The control is never omitted for a missing worktree.

The developer-strip chip now carries `run.isolation.reason` as a `Hint` when that sentence is present. The Hint sits on the chip, **outside** the expand button (F6: no extra tab stop inside a button). Absence is silent: no empty tooltip.

## States

| Row | Changes | Chip hint |
| --- | --- | --- |
| Agent with a worktree | Opens `{ kind: "agent", runId }` | Isolation sentence if the run has one |
| Agent with `worktree: null` (shared checkout) | Same call — never dead | Isolation sentence if present; otherwise just “shared checkout” |
| Asking agent | Changes · Open · Answer on one strip | as above |
| Command | hidden | n/a |
| Run recorded before `isolation` | Changes still there | nothing extra |

Keyboard: Changes is a real button with the Button focus ring. **Enter on the row expands it and does not open the overlay. Enter on Changes is swallowed** (the approval rule, same as Answer). Space and click open it.

## Overlay coverage of §8.5 (read, not edited)

The overlay already implements the four cases. Fleet only opens the `agent` scope.

| §8.5 case | Overlay |
| --- | --- |
| Worktree run | “This agent · worktree at …” |
| Shared checkout | “This agent · shared checkout” |
| Removed worktree, branch still there | “This worktree was removed. Showing branch …, which still exists.” |
| Branch gone | “This agent's branch is gone” / nothing to show |
| Merge | not offered — `data-slot="changes-git-actions"` is empty |

**Gap for the overlay owner:** `mapAgentRunContext` in `packages/ui/src/source-control/host-adapter.ts` never sets `branchGone`. The mock does, and the overlay paints `AgentGoneState` from that flag. Against a real host, a gone branch may not get the designed empty state.

## What to try first in visual UAT

1. An isolated child: Changes on the collapsed row, overlay titled This agent, worktree copy visible, no merge.
2. A `worktree: false` (or workspace-of-repos) child: Changes still there; overlay says shared checkout.
3. Hover and Tab onto the chip of a shared agent that has `isolation.reason` — the sentence appears. An old run without the field has no tooltip.
4. Enter on the row expands; Enter on Changes does nothing; Space / click opens the overlay.
5. A command row has no Changes. 320px and both themes: the strip still wraps, the chip keeps its suffix.
