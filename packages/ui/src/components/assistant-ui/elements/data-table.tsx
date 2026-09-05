"use client";
/**
 * Data table — the model catalogue, the package list, and `collection`
 * panels in table layout (docs/ux-elements.md "Structured output").
 * Installed from `elements-data-table` and restyled to DESIGN.md tokens.
 *
 * Divergences from the registry copy:
 *   - Column-driven. The registry file is a three-column demo (`name`,
 *     `context`, `cost`) with a `cycle` prop that replays an entrance
 *     animation; here `columns` describe the header and each cell, `rows`
 *     carry the data, and nothing animates in.
 *   - A real `<table>`: header cells, row headers, a caption for the
 *     accessible name. Wide tables scroll inside their own container, never
 *     the page (DESIGN.md "Legibility floor").
 *   - Cells default to the sans face; `mono` and `align` are per column.
 *   - An optional `emptyMessage`, so a table with no rows says why.
 * The logs list stays on its own windowed list: five thousand rows need a
 * virtualiser, which this element is not.
 */
import type { ComponentProps, ReactNode } from "react";

import { cn } from "@/lib/utils";

export interface DataTableColumn<Row> {
  key: string;
  label: string;
  align?: "start" | "end" | undefined;
  /** Typed face with tabular numerals. */
  mono?: boolean | undefined;
  /** A CSS width; unset columns share the rest. */
  width?: string | undefined;
  /** Hide on narrow screens; the row still says it in its title. */
  optional?: boolean | undefined;
  render: (row: Row) => ReactNode;
}

export interface DataTableProps<Row> extends Omit<ComponentProps<"div">, "children"> {
  columns: readonly DataTableColumn<Row>[];
  rows: readonly Row[];
  rowKey: (row: Row) => string;
  caption: string;
  /** Extra classes for a row, e.g. to dim a disabled one. */
  rowClassName?: ((row: Row) => string | undefined) | undefined;
  emptyMessage?: ReactNode;
  /** Minimum table width before it scrolls sideways inside its container. */
  minWidth?: string | undefined;
}

export function DataTable<Row>({ columns, rows, rowKey, caption, rowClassName, emptyMessage, minWidth, className, ...props }: DataTableProps<Row>) {
  return (
    <div data-slot="data-table" className={cn("w-full overflow-x-auto rounded-lg border border-line", className)} {...props}>
      <table className="w-full border-collapse text-sm" style={minWidth ? { minWidth } : undefined}>
        <caption className="sr-only">{caption}</caption>
        <thead>
          <tr className="bg-surface-2">
            {columns.map((column) => (
              <th
                key={column.key}
                scope="col"
                style={column.width ? { width: column.width } : undefined}
                className={cn("eyebrow px-3 py-2 font-medium whitespace-nowrap", column.align === "end" ? "text-end" : "text-start", column.optional && "hidden md:table-cell")}
              >
                {column.label}
              </th>
            ))}
          </tr>
        </thead>
        <tbody>
          {rows.map((row) => (
            <tr key={rowKey(row)} className={cn("border-t border-line align-top", rowClassName?.(row))}>
              {columns.map((column, i) => {
                const Cell = i === 0 ? "th" : "td";
                return (
                  <Cell
                    key={column.key}
                    {...(i === 0 ? { scope: "row" } : {})}
                    className={cn(
                      "px-3 py-2 text-start font-normal",
                      column.align === "end" && "text-end",
                      column.mono ? "typed text-ink-2" : "text-ink",
                      column.optional && "hidden md:table-cell",
                    )}
                  >
                    {column.render(row)}
                  </Cell>
                );
              })}
            </tr>
          ))}
          {rows.length === 0 && emptyMessage !== undefined && (
            <tr>
              <td colSpan={columns.length} className="px-3 py-6 text-center text-sm text-ink-2">
                {emptyMessage}
              </td>
            </tr>
          )}
        </tbody>
      </table>
    </div>
  );
}
