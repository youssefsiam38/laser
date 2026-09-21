"use client";
/**
 * The board — Tasks only (D-355, "Structure").
 *
 * Columns are the Task states, and a drop performs a **real transition**
 * through `project/task/action`. An illegal move is refused with the missing
 * keys named, before anything is sent when this window can already tell, and
 * with the host's own sentence when only the host can. `done` is never set by
 * a drop out of `running` on its own: the acceptance-evidence rule lives in
 * the engine and its refusal is shown here.
 *
 * Dragging is never the only way: every card carries the same transitions in a
 * menu, so a keyboard and a coarse pointer reach exactly what a mouse does.
 */
import {
  DndContext,
  KeyboardSensor,
  PointerSensor,
  TouchSensor,
  useDraggable,
  useDroppable,
  useSensor,
  useSensors,
  type DragEndEvent,
  type DragStartEvent,
} from "@dnd-kit/core";
import { ClipboardCheck, GripVertical, MoreHorizontal } from "lucide-react";
import { useMemo, useState } from "react";
import type { ProjectTaskState, ProjectWorkListItem } from "@lasercode/protocol";

import { TodoList, type TodoItem } from "@/components/assistant-ui/elements/todo-list";
import { Button } from "@/components/ui/button";
import { DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuLabel, DropdownMenuTrigger } from "@/components/ui/dropdown-menu";
import { relativeTime } from "@/format";
import { useBreakpoint } from "@/hooks";
import { cn } from "@/lib/utils";
import { useLaserStable, useCapability } from "@/runtime";
import { openWorkCreate, selectWork, type ProjectWorkSnapshot, type ProjectWorkStore } from "@/project-work";
import { boardColumns, checkDrop, dropFor } from "@/project-work/board";
import { BOARD_COLUMNS, BOARD_EXTRA_COLUMN, boardColumnLabel, KIND_RULE, stateLabel, taskMark } from "@/project-work/vocabulary";

import { KeyTag, NeedsYouChip } from "./KindBadge.js";
import { TaskCancelDialog } from "./TaskCancel.js";
import { WorkPlaceholder, WorkRefusal } from "./states.js";

export function Board({ store, work }: { store: ProjectWorkStore | undefined; work: ProjectWorkSnapshot }) {
  const [dragging, setDragging] = useState<string | undefined>(undefined);
  const [refusal, setRefusal] = useState<string | undefined>(undefined);
  const [busy, setBusy] = useState<string | undefined>(undefined);
  const [cancelling, setCancelling] = useState<{ row: ProjectWorkListItem; error?: string } | undefined>(undefined);
  const { actions } = useLaserStable();
  const canAct = useCapability("project/task/action", { presentation: "explained" });
  // On a phone the columns keep their identity and their transitions, and the
  // cards become the adopted `todo-list`'s rows: the same facts in one line
  // each, never the same card at a smaller size (D-355, "Widths and inputs").
  const compact = useBreakpoint() === "mobile";

  const sensors = useSensors(
    useSensor(PointerSensor, { activationConstraint: { distance: 6 } }),
    useSensor(TouchSensor, { activationConstraint: { delay: 180, tolerance: 8 } }),
    useSensor(KeyboardSensor),
  );

  const tasks = useMemo(() => work.items.filter((item) => item.kind === "task" && !item.archived), [work.items]);
  const cancelled = tasks.some((task) => task.state === "cancelled");
  const columns = useMemo(
    () => boardColumns(work.items, cancelled || dragging ? [...BOARD_COLUMNS, BOARD_EXTRA_COLUMN] : BOARD_COLUMNS),
    [cancelled, dragging, work.items],
  );

  const move = async (row: ProjectWorkListItem, to: ProjectTaskState, note?: string): Promise<void> => {
    const check = checkDrop(row, to);
    if (!check.allowed) {
      setRefusal(check.reason);
      return;
    }
    if (!store) return;
    // A cancellation has to say why, durably (M21-T15), so it is asked for
    // here rather than sent and refused.
    if (check.action === "cancel" && !note) {
      setRefusal(undefined);
      setCancelling({ row });
      return;
    }
    setRefusal(undefined);
    setBusy(row.ref.entityId);
    const outcome = await store.taskAction(
      { entityId: row.ref.entityId, expectedRevisionId: row.ref.revisionId },
      check.action,
      note ? { note } : {},
    );
    setBusy(undefined);
    if (!outcome.ok) {
      // The engine refuses what this window could not know: acceptance
      // evidence, blocking comments, a stale plan. Its sentence is the answer.
      if (cancelling) setCancelling({ ...cancelling, error: outcome.failure.message });
      else setRefusal(outcome.failure.message);
      return;
    }
    setCancelling(undefined);
    // A dependency reaching `done` moves what was waiting on it. Those moves
    // are the graph's, not the person's, so they are said out loud (M21-T15).
    const cascaded = outcome.value.cascaded ?? [];
    actions.toast(
      "info",
      cascaded.length === 0
        ? `${row.key} · ${boardColumnLabel(to).toLocaleLowerCase()}`
        : `${row.key} · ${boardColumnLabel(to).toLocaleLowerCase()} — ${cascaded
            .map((moved) => `${moved.key} is now ${boardColumnLabel(moved.to).toLocaleLowerCase()}`)
            .join(", ")}`,
    );
  };

  const onDragEnd = ({ active, over }: DragEndEvent): void => {
    setDragging(undefined);
    const drop = dropFor(tasks, String(active.id), over ? String(over.id) : undefined);
    if (drop) void move(drop.row, drop.to);
  };

  if (tasks.length === 0) {
    return (
      <WorkPlaceholder
        icon={ClipboardCheck}
        title="No tasks yet"
        detail="Tasks are the bounded units of work in this project. A plan produces them, and you can also create one on its own."
        action={
          <Button size="sm" onClick={() => openWorkCreate("task")}>
            Create a task
          </Button>
        }
      />
    );
  }

  return (
    <div className="flex min-h-0 flex-1 flex-col">
      {refusal ? (
        <div className="p-2">
          <WorkRefusal message={refusal} recovery="Nothing moved." />
        </div>
      ) : null}
      {canAct.state === "explained" ? (
        <p className="px-3 py-1.5 text-xs leading-xs text-ink-3">{canAct.explanation}</p>
      ) : null}
      <DndContext sensors={sensors} onDragStart={(event: DragStartEvent) => setDragging(String(event.active.id))} onDragEnd={onDragEnd} onDragCancel={() => setDragging(undefined)}>
        {/* The board scrolls by column; the page never scrolls sideways. */}
        <div className="flex min-h-0 flex-1 snap-x snap-mandatory gap-2 overflow-x-auto p-2">
          {columns.map((column) => (
            <Column
              key={column.state}
              state={column.state}
              rows={column.rows}
              busy={busy}
              compact={compact}
              disabled={canAct.state !== "available"}
              onMove={(row, to) => void move(row, to)}
            />
          ))}
        </div>
      </DndContext>
      <TaskCancelDialog
        workKey={cancelling?.row.key}
        title={cancelling?.row.title}
        open={cancelling !== undefined}
        busy={busy !== undefined}
        error={cancelling?.error}
        onOpenChange={(open) => {
          if (!open) setCancelling(undefined);
        }}
        onCancelTask={(note) => {
          if (cancelling) void move(cancelling.row, "cancelled", note);
        }}
      />
    </div>
  );
}

function Column({
  state,
  rows,
  busy,
  compact,
  disabled,
  onMove,
}: {
  state: ProjectTaskState;
  rows: readonly ProjectWorkListItem[];
  busy: string | undefined;
  compact: boolean;
  disabled: boolean;
  onMove: (row: ProjectWorkListItem, to: ProjectTaskState) => void;
}) {
  const { setNodeRef, isOver } = useDroppable({ id: state });
  return (
    <section
      ref={setNodeRef}
      aria-label={boardColumnLabel(state)}
      className={cn(
        "flex w-[min(84vw,18rem)] shrink-0 snap-start flex-col rounded-lg border border-line bg-surface",
        "transition-colors duration-(--motion-instant) motion-reduce:transition-none",
        isOver && "border-live bg-surface-2",
      )}
    >
      <header className="flex items-center justify-between gap-2 border-b border-line px-2.5 py-1.5">
        <span className="text-sm leading-5 font-medium text-ink">{boardColumnLabel(state)}</span>
        <span className="typed tnum text-ink-3">{rows.length}</span>
      </header>
      {compact ? (
        <div className="min-h-0 flex-1 overflow-y-auto p-1.5">
          <TodoList
            header={false}
            items={rows.map((row) => compactRow(row, busy === row.ref.entityId, disabled, onMove))}
            empty="Nothing here."
          />
        </div>
      ) : (
        <ul role="list" className="flex min-h-0 flex-1 flex-col gap-1.5 overflow-y-auto p-1.5">
          {rows.length === 0 ? (
            <li className="px-1.5 py-2 text-xs leading-xs text-ink-3">Nothing here.</li>
          ) : (
            rows.map((row) => (
              <li key={row.ref.entityId}>
                <Card row={row} busy={busy === row.ref.entityId} disabled={disabled} onMove={onMove} />
              </li>
            ))
          )}
        </ul>
      )}
    </section>
  );
}

/**
 * One task as a `todo-list` row: the mark, the key, the title, the state in
 * words — and the same "Move to" menu the card has, so a phone reaches every
 * transition a mouse does without a drag.
 */
function compactRow(
  row: ProjectWorkListItem,
  busy: boolean,
  disabled: boolean,
  onMove: (row: ProjectWorkListItem, to: ProjectTaskState) => void,
): TodoItem {
  const state = row.state as ProjectTaskState;
  return {
    id: row.ref.entityId,
    text: row.title,
    status: stateLabel("task", row.state),
    mark: taskMark(state),
    done: state === "done",
    tag: row.key,
    ...(row.unmetDependencies && row.unmetDependencies.length > 0
      ? { detail: `waiting on ${row.unmetDependencies.join(", ")}` }
      : {}),
    onOpen: () => selectWork({ entityId: row.ref.entityId, kind: row.kind }),
    action: <MoveMenu row={row} from={state} disabled={disabled || busy} onMove={onMove} />,
  };
}

function MoveMenu({
  row,
  from,
  disabled,
  className,
  onMove,
}: {
  row: ProjectWorkListItem;
  from: ProjectTaskState;
  disabled: boolean;
  className?: string;
  onMove: (row: ProjectWorkListItem, to: ProjectTaskState) => void;
}) {
  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <Button size="icon-xs" variant="ghost" aria-label={`Move ${row.key}`} disabled={disabled} className={className}>
          <MoreHorizontal />
        </Button>
      </DropdownMenuTrigger>
      <DropdownMenuContent align="end">
        <DropdownMenuLabel>Move to</DropdownMenuLabel>
        {[...BOARD_COLUMNS, BOARD_EXTRA_COLUMN]
          .filter((to) => to !== from)
          .map((to) => (
            <DropdownMenuItem key={to} disabled={disabled} onSelect={() => onMove(row, to)}>
              {boardColumnLabel(to)}
            </DropdownMenuItem>
          ))}
      </DropdownMenuContent>
    </DropdownMenu>
  );
}

function Card({
  row,
  busy,
  disabled,
  onMove,
}: {
  row: ProjectWorkListItem;
  busy: boolean;
  disabled: boolean;
  onMove: (row: ProjectWorkListItem, to: ProjectTaskState) => void;
}) {
  const { attributes, listeners, setNodeRef, isDragging } = useDraggable({ id: row.ref.entityId, disabled });
  const from = row.state as ProjectTaskState;

  return (
    <div
      ref={setNodeRef}
      data-slot="board-card"
      className={cn(
        "relative flex min-w-0 flex-col gap-1.5 overflow-hidden rounded-md border border-line bg-bg p-2 ps-2.5",
        "transition-shadow duration-(--motion-instant) motion-reduce:transition-none",
        isDragging && "opacity-80 shadow-float",
        busy && "opacity-70",
      )}
    >
      <span aria-hidden="true" className={cn("absolute inset-y-0 start-0 w-0.5", KIND_RULE.task)} />
      <span className="flex min-w-0 items-center gap-1.5">
        <button
          type="button"
          {...attributes}
          {...listeners}
          aria-label={`Drag ${row.key}`}
          disabled={disabled}
          className={cn(
            "flex size-5 shrink-0 cursor-grab items-center justify-center rounded text-ink-3 outline-none",
            "hover:text-ink focus-visible:outline-solid focus-visible:outline-2 focus-visible:outline-live",
            "disabled:cursor-default pointer-coarse:size-8",
          )}
        >
          <GripVertical aria-hidden="true" className="size-3.5" />
        </button>
        <KeyTag workKey={row.key} />
        {row.needsAttention ? <NeedsYouChip reason={undefined} className="ms-auto" /> : null}
        <MoveMenu row={row} from={from} disabled={disabled} className={cn(!row.needsAttention && "ms-auto")} onMove={onMove} />
      </span>
      <button
        type="button"
        onClick={() => selectWork({ entityId: row.ref.entityId, kind: row.kind })}
        className="min-w-0 text-start text-sm leading-5 text-ink outline-none hover:underline focus-visible:outline-solid focus-visible:outline-2 focus-visible:outline-live"
      >
        {row.title}
      </button>
      {row.unmetDependencies && row.unmetDependencies.length > 0 ? (
        <span className="flex flex-wrap items-center gap-1 text-xs leading-xs text-attention">
          waiting on
          {row.unmetDependencies.slice(0, 4).map((key) => (
            <KeyTag key={key} workKey={key} className="text-attention" />
          ))}
          {row.unmetDependencies.length > 4 ? <span>+{row.unmetDependencies.length - 4}</span> : null}
        </span>
      ) : null}
      <span className="text-xs leading-xs text-ink-3">{relativeTime(row.updatedAt)}</span>
    </div>
  );
}
