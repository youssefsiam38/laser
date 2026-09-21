"use client";
/**
 * Adopted `elements-todo-list`, reinstated for the project lifecycle leap
 * (D-355: "`todo-list` for the compact form").
 *
 * De-demoed and retoned: the registry copy carries four statuses, its own
 * red/blue literals, a `max-w-sm` and a fixed animation duration. A Project
 * Task has seven states, laser has one status vocabulary for all of them, and
 * every value here is a token — the dot is the app's own `StatusDot`, so a row
 * in this list says the same thing as the same row on the board.
 *
 * It takes rows, not entities: the Plan detail passes its tasks, and any later
 * surface with a short checklist of real work can pass its own.
 */
import type { ComponentProps, ReactNode } from "react";

import { StatusDot, type Status } from "@/components/status";
import { cn } from "@/lib/utils";

import { mono } from "./surfaces.js";

export interface TodoItem {
  id: string;
  /** What it is. Truncated, never shrunk. */
  text: string;
  /** The row's state in its own vocabulary — already a person-facing word. */
  status: string;
  /** Which status mark it draws: the app's five, and nothing new. */
  mark: Status;
  /** True when this row counts towards "done". */
  done?: boolean;
  /** A key, a count, anything typed. Rendered in the mono face. */
  tag?: string;
  detail?: string | undefined;
  onOpen?: (() => void) | undefined;
  /**
   * One control that belongs to the row rather than to the list — the board's
   * compact form puts its "Move to" menu here (M21-T16). It is rendered
   * *beside* the opening button, never inside it: a control inside a button is
   * not reachable by keyboard or by a screen reader.
   */
  action?: ReactNode;
}

export function TodoList({
  items,
  title = "Tasks",
  header = true,
  empty,
  className,
  ...props
}: Omit<ComponentProps<"div">, "children" | "title"> & {
  items: readonly TodoItem[];
  title?: string;
  /** Off when the surface already has a heading of its own (a plan phase). */
  header?: boolean;
  empty?: ReactNode;
}) {
  const done = items.filter((item) => item.done).length;
  return (
    <div data-slot="todo-list" className={cn("flex w-full min-w-0 flex-col gap-2", className)} {...props}>
      {header ? (
        <div className="flex items-baseline justify-between gap-2">
          <span className="eyebrow">{title}</span>
          {items.length > 0 ? (
            <span className={cn(mono, "tnum text-ink-3")}>
              {done}/{items.length}
            </span>
          ) : null}
        </div>
      ) : null}
      {items.length === 0 ? (
        <p className="text-sm leading-5 text-ink-3">{empty ?? "Nothing here yet."}</p>
      ) : (
        <ul role="list" className="flex flex-col">
          {items.map((item) => {
            const row = (
              <>
                <StatusDot status={item.mark} size="sm" label={item.status} className="mt-1.5 shrink-0" />
                <span className="flex min-w-0 flex-1 flex-col">
                  <span className="flex min-w-0 items-center gap-2">
                    {item.tag ? <span className={cn(mono, "shrink-0 text-ink-3")}>{item.tag}</span> : null}
                    <span className={cn("min-w-0 truncate text-sm leading-5", item.done ? "text-ink-3" : "text-ink-2")} title={item.text}>
                      {item.text}
                    </span>
                  </span>
                  {item.detail ? <span className="text-xs leading-xs text-ink-3">{item.detail}</span> : null}
                </span>
                <span className="shrink-0 text-xs leading-xs text-ink-3">{item.status}</span>
              </>
            );
            return (
              <li key={item.id} className="flex min-w-0 items-start gap-1">
                {item.onOpen ? (
                  <button
                    type="button"
                    onClick={item.onOpen}
                    className={cn(
                      "flex w-full min-w-0 flex-1 items-start gap-2 rounded-md px-1.5 py-1 text-start outline-none",
                      "transition-colors duration-(--motion-instant) motion-reduce:transition-none",
                      "hover:bg-surface-2 focus-visible:outline-solid focus-visible:outline-2 focus-visible:-outline-offset-2 focus-visible:outline-live",
                      "pointer-coarse:min-h-11",
                    )}
                  >
                    {row}
                  </button>
                ) : (
                  <span className="flex w-full min-w-0 flex-1 items-start gap-2 px-1.5 py-1">{row}</span>
                )}
                {item.action ? <span className="shrink-0 pt-0.5">{item.action}</span> : null}
              </li>
            );
          })}
        </ul>
      )}
    </div>
  );
}
