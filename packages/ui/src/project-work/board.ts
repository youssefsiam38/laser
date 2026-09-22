/**
 * The Tasks board's rules (D-355, "Structure").
 *
 * A drop performs a **real transition**. Two things decide whether it happens,
 * and they are not the same thing:
 *
 * - what this window can already prove is illegal, from the row it is holding:
 *   the state machine's own edges, and the dependency keys the row says are
 *   unmet. That refusal names the missing keys and is shown *before* anything
 *   is sent, because sending a request whose answer is already known is how a
 *   board feels slow;
 * - everything else — acceptance evidence, blocking comments, a stale plan or
 *   design — which only the host knows. That refusal comes back from
 *   `project/task/action` (M21-T15) and is rendered with the same banner.
 *
 * The client's check is a courtesy. The authority is the host, always.
 */
import {
  taskTransition,
  type ProjectTaskAction,
  type ProjectTaskState,
  type ProjectWorkListItem,
} from "@lasercode/protocol";

import { STATE_ACTION } from "./vocabulary.js";

/**
 * Which action asks for this move.
 *
 * Three actions target `in_progress` and they are not interchangeable: work
 * that comes back from review had changes requested, work that comes back from
 * done is reopened, and everything else is started.
 */
export function actionForDrop(from: ProjectTaskState, to: ProjectTaskState): ProjectTaskAction {
  if (to === "in_progress") {
    if (from === "needs_review") return "request_changes";
    if (from === "done") return "reopen";
    return "start";
  }
  return STATE_ACTION[to];
}

export type DropCheck = { allowed: true; action: ProjectTaskAction } | { allowed: false; reason: string };

/**
 * Can this window refuse the move on its own?
 *
 * `hasAcceptanceEvidence` is passed as true deliberately: a list row does not
 * carry evidence, and refusing a completion this window cannot see the
 * evidence for would be inventing a fact. The host checks it and refuses with
 * the sentence a person should read.
 */
export function checkDrop(row: ProjectWorkListItem, to: ProjectTaskState): DropCheck {
  const from = row.state as ProjectTaskState;
  if (from === to) return { allowed: false, reason: `${row.key} is already there.` };
  const outcome = taskTransition({
    from,
    to,
    trigger: "person",
    unmetDependencies: row.unmetDependencies ?? [],
    hasAcceptanceEvidence: true,
  });
  if (!outcome.ok) return { allowed: false, reason: outcome.reason };
  return { allowed: true, action: actionForDrop(from, to) };
}

/**
 * What a drop *is*, before anything is decided about it: which row was
 * dragged, and which column it landed on.
 *
 * It lives here rather than inside the drag handler so the mapping from
 * "dropped on that column" to "that Task, that state" is a fact a test can
 * hold on its own — a pointer gesture is the hardest thing to prove and the
 * least interesting part of the rule.
 */
export function dropFor(
  tasks: readonly ProjectWorkListItem[],
  activeId: string,
  overId: string | undefined,
): { row: ProjectWorkListItem; to: ProjectTaskState } | undefined {
  if (!overId) return undefined;
  const row = tasks.find((task) => task.ref.entityId === activeId);
  if (!row) return undefined;
  const to = overId as ProjectTaskState;
  if (row.state === to) return undefined;
  return { row, to };
}

/** The tasks in each column, newest first, from the whole backlog. */
export function boardColumns(
  items: readonly ProjectWorkListItem[],
  columns: readonly ProjectTaskState[],
): Array<{ state: ProjectTaskState; rows: ProjectWorkListItem[] }> {
  const tasks = items.filter((item) => item.kind === "task" && !item.archived);
  return columns.map((state) => ({ state, rows: tasks.filter((task) => task.state === state) }));
}
