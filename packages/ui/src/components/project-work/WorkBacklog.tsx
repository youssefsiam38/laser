"use client";
/**
 * Work — one backlog of every kind in the project (D-355, "Structure").
 *
 * Filter by type, by text, by "needs you" and by whether anything is linked;
 * sort by updated, key or status; save a filter and it becomes a named view.
 * There is no per-kind screen, because a per-kind screen is a saved filter
 * somebody already made.
 *
 * Two forms of the same list: the adopted `data-table` when the backlog has
 * the room, Laser's own rows when it is a column beside the detail. Nothing
 * shrinks below the 12px floor; the narrow form drops columns instead.
 */
import { Bookmark, Check, Filter, Link2, Plus, Search, Trash2, X } from "lucide-react";
import { useMemo, useState } from "react";
import { PROJECT_WORK_KINDS, type ProjectWorkKind, type ProjectWorkListItem } from "@lasercode/protocol";

import { DataTable, type DataTableColumn } from "@/components/assistant-ui/elements/data-table";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuRadioGroup,
  DropdownMenuRadioItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { Input } from "@/components/ui/input";
import { relativeTime } from "@/format";
import { cn } from "@/lib/utils";
import { openWorkCreate, selectWork, useWorkspaceUi, type ProjectWorkSnapshot, type ProjectWorkStore } from "@/project-work";
import { attentionReasonOf } from "@/project-work/model";
import { KIND_ICON, KIND_LABEL, KIND_TEXT } from "@/project-work/vocabulary";
import {
  applyFilter,
  deleteView,
  EMPTY_FILTER,
  isEmptyFilter,
  sameFilter,
  saveView,
  sortWork,
  useSavedViews,
  type WorkFilter,
  type WorkSort,
} from "@/project-work/views";

import { KeyTag, NeedsYouChip, StatusChip, TypeBadge } from "./KindBadge.js";
import { WorkPlaceholder } from "./states.js";

const SORT_LABEL: Readonly<Record<WorkSort, string>> = {
  updated: "Recently updated",
  key: "By key",
  status: "By status",
};

export function WorkBacklog({
  store,
  work,
  className,
  table = false,
}: {
  store: ProjectWorkStore | undefined;
  work: ProjectWorkSnapshot;
  className?: string;
  table?: boolean;
}) {
  const ui = useWorkspaceUi();
  const [filter, setFilter] = useState<WorkFilter>(EMPTY_FILTER);
  const [sort, setSort] = useState<WorkSort>("updated");
  const [naming, setNaming] = useState(false);
  const [name, setName] = useState("");
  const views = useSavedViews(work.projectId);

  const rows = useMemo(() => sortWork(applyFilter(work.items, filter), sort, filter.text), [filter, sort, work.items]);
  const activeView = views.find((view) => sameFilter(view.filter, filter) && view.sort === sort);

  const toggleKind = (kind: ProjectWorkKind): void =>
    setFilter((current) => ({
      ...current,
      kinds: current.kinds.includes(kind) ? current.kinds.filter((value) => value !== kind) : [...current.kinds, kind],
    }));

  const open = (row: ProjectWorkListItem): void => selectWork({ entityId: row.ref.entityId, kind: row.kind });

  return (
    <div data-slot="work-backlog" className={cn("flex min-h-0 flex-col", className)}>
      <div className="flex flex-col gap-2 border-b border-line p-2">
        <div className="flex items-center gap-1.5">
          <label className="relative flex min-w-0 flex-1 items-center">
            <Search aria-hidden="true" className="pointer-events-none absolute ms-2 size-3.5 text-ink-3" />
            <span className="sr-only">Filter this project's work</span>
            <Input
              value={filter.text}
              onChange={(event) => setFilter((current) => ({ ...current, text: event.target.value }))}
              placeholder="Filter by key or title"
              className="h-8 ps-7 text-sm"
            />
            {filter.text ? (
              <button
                type="button"
                onClick={() => setFilter((current) => ({ ...current, text: "" }))}
                aria-label="Clear the filter text"
                className="absolute end-1 flex size-6 items-center justify-center rounded text-ink-3 outline-none hover:text-ink focus-visible:outline-solid focus-visible:outline-2 focus-visible:outline-live"
              >
                <X aria-hidden="true" className="size-3.5" />
              </button>
            ) : null}
          </label>
          <DropdownMenu>
            <DropdownMenuTrigger asChild>
              <Button size="icon-sm" variant="outline" aria-label="Sort and saved views">
                <Filter />
              </Button>
            </DropdownMenuTrigger>
            <DropdownMenuContent align="end" className="min-w-56">
              <DropdownMenuLabel>Sort</DropdownMenuLabel>
              <DropdownMenuRadioGroup value={sort} onValueChange={(value) => setSort(value as WorkSort)}>
                {(Object.keys(SORT_LABEL) as WorkSort[]).map((value) => (
                  <DropdownMenuRadioItem key={value} value={value}>
                    {SORT_LABEL[value]}
                  </DropdownMenuRadioItem>
                ))}
              </DropdownMenuRadioGroup>
              <DropdownMenuSeparator />
              <DropdownMenuLabel>Saved views</DropdownMenuLabel>
              {views.length === 0 ? (
                <p className="px-2 py-1.5 text-xs leading-xs text-ink-3">A filter you save shows up here, by the name you give it.</p>
              ) : (
                views.map((view) => (
                  <DropdownMenuItem
                    key={view.id}
                    onSelect={() => {
                      setFilter(view.filter);
                      setSort(view.sort);
                    }}
                    className="justify-between gap-2"
                  >
                    <span className="flex min-w-0 items-center gap-2">
                      {activeView?.id === view.id ? <Check className="size-3.5" /> : <Bookmark className="size-3.5" />}
                      <span className="min-w-0 truncate">{view.name}</span>
                    </span>
                    <button
                      type="button"
                      aria-label={`Delete the view ${view.name}`}
                      onClick={(event) => {
                        event.preventDefault();
                        event.stopPropagation();
                        if (work.projectId) deleteView(work.projectId, view.id);
                      }}
                      className="flex size-6 items-center justify-center rounded text-ink-3 outline-none hover:text-danger focus-visible:outline-solid focus-visible:outline-2 focus-visible:outline-live"
                    >
                      <Trash2 aria-hidden="true" className="size-3.5" />
                    </button>
                  </DropdownMenuItem>
                ))
              )}
              <DropdownMenuSeparator />
              <DropdownMenuItem disabled={isEmptyFilter(filter) || !work.projectId} onSelect={() => setNaming(true)}>
                <Plus />
                Save this filter as a view…
              </DropdownMenuItem>
            </DropdownMenuContent>
          </DropdownMenu>
        </div>

        <div className="flex flex-wrap items-center gap-1">
          {PROJECT_WORK_KINDS.map((kind) => {
            const Icon = KIND_ICON[kind];
            const on = filter.kinds.includes(kind);
            return (
              <button
                key={kind}
                type="button"
                aria-pressed={on}
                onClick={() => toggleKind(kind)}
                className={cn(
                  "flex h-6 items-center gap-1 rounded-full border px-2 text-xs leading-xs outline-none",
                  "transition-colors duration-(--motion-instant) motion-reduce:transition-none",
                  "focus-visible:outline-solid focus-visible:outline-2 focus-visible:outline-live pointer-coarse:min-h-11",
                  on ? "border-transparent bg-surface-2 text-ink" : "border-line text-ink-2 hover:bg-surface-2",
                )}
              >
                <Icon aria-hidden="true" className={cn("size-3", KIND_TEXT[kind])} />
                {KIND_LABEL[kind]}
                <span className="typed tnum text-ink-3">{work.counts.byKind[kind]}</span>
              </button>
            );
          })}
          <FilterToggle
            on={filter.needsYou}
            onToggle={() => setFilter((current) => ({ ...current, needsYou: !current.needsYou }))}
            label="Needs you"
            count={work.counts.needsAttention}
          />
          <FilterToggle
            on={filter.hasLink}
            onToggle={() => setFilter((current) => ({ ...current, hasLink: !current.hasLink }))}
            label="Linked"
            icon={<Link2 aria-hidden="true" className="size-3" />}
          />
          <FilterToggle
            on={filter.includeArchived}
            onToggle={() => setFilter((current) => ({ ...current, includeArchived: !current.includeArchived }))}
            label="With archived"
          />
          {!isEmptyFilter(filter) ? (
            <Button size="xs" variant="ghost" onClick={() => setFilter(EMPTY_FILTER)}>
              Clear
            </Button>
          ) : null}
        </div>

        {naming ? (
          <form
            className="flex items-center gap-1.5"
            onSubmit={(event) => {
              event.preventDefault();
              if (!work.projectId || name.trim() === "") return;
              saveView(work.projectId, { name, filter, sort });
              setName("");
              setNaming(false);
            }}
          >
            <Input autoFocus value={name} onChange={(event) => setName(event.target.value)} placeholder="Name this view" className="h-8 text-sm" />
            <Button size="sm" type="submit" disabled={name.trim() === ""}>
              Save
            </Button>
            <Button size="sm" type="button" variant="ghost" onClick={() => setNaming(false)}>
              Cancel
            </Button>
          </form>
        ) : null}
      </div>

      {rows.length === 0 ? (
        work.items.length === 0 ? (
          <WorkPlaceholder
            title="No project work yet"
            detail={
              <>
                Specs, research, designs, plans and tasks live here and belong to the project, not to a conversation. Create one, or type{" "}
                <span className="typed">/spec</span>, <span className="typed">/research</span>, <span className="typed">/design</span> or{" "}
                <span className="typed">/plan</span> in any chat.
              </>
            }
            action={
              <Button size="sm" onClick={() => openWorkCreate("spec")}>
                <Plus />
                Create the first one
              </Button>
            }
          />
        ) : (
          <WorkPlaceholder
            title="Nothing matches this filter"
            detail="Every item is still here; the filter is hiding them."
            action={
              <Button size="sm" variant="outline" onClick={() => setFilter(EMPTY_FILTER)}>
                Clear the filter
              </Button>
            }
          />
        )
      ) : table ? (
        <div className="min-h-0 flex-1 overflow-y-auto p-2">
          <BacklogTable rows={rows} onOpen={open} />
        </div>
      ) : (
        <ul role="list" className="min-h-0 flex-1 overflow-y-auto p-1">
          {rows.map((row) => (
            <li key={row.ref.entityId}>
              <BacklogRow row={row} selected={ui.selection?.entityId === row.ref.entityId} onOpen={() => open(row)} />
            </li>
          ))}
        </ul>
      )}

      <p className="border-t border-line px-3 py-1.5 text-xs leading-xs text-ink-3">
        {rows.length === work.items.length ? `${rows.length} item${rows.length === 1 ? "" : "s"}` : `${rows.length} of ${work.items.length}`}
        {work.more ? " · more than this window read; filter to narrow it" : ""}
      </p>
    </div>
  );
}

function FilterToggle({
  on,
  onToggle,
  label,
  count,
  icon,
}: {
  on: boolean;
  onToggle: () => void;
  label: string;
  count?: number;
  icon?: React.ReactNode;
}) {
  return (
    <button
      type="button"
      aria-pressed={on}
      onClick={onToggle}
      className={cn(
        "flex h-6 items-center gap-1 rounded-full border px-2 text-xs leading-xs outline-none",
        "transition-colors duration-(--motion-instant) motion-reduce:transition-none",
        "focus-visible:outline-solid focus-visible:outline-2 focus-visible:outline-live pointer-coarse:min-h-11",
        on ? "border-transparent bg-surface-2 text-ink" : "border-line text-ink-2 hover:bg-surface-2",
      )}
    >
      {icon}
      {label}
      {count !== undefined && count > 0 ? <span className="typed tnum text-ink-3">{count}</span> : null}
    </button>
  );
}

function BacklogRow({ row, selected, onOpen }: { row: ProjectWorkListItem; selected: boolean; onOpen: () => void }) {
  return (
    <button
      type="button"
      onClick={onOpen}
      aria-current={selected ? "true" : undefined}
      className={cn(
        "flex w-full min-w-0 flex-col gap-1 rounded-md px-2 py-1.5 text-start outline-none",
        "transition-colors duration-(--motion-instant) motion-reduce:transition-none",
        "hover:bg-surface-2 focus-visible:outline-solid focus-visible:outline-2 focus-visible:-outline-offset-2 focus-visible:outline-live",
        "pointer-coarse:min-h-11",
        selected && "bg-surface-2",
        row.archived && "opacity-70",
      )}
    >
      <span className="flex min-w-0 items-center gap-2">
        <TypeBadge kind={row.kind} />
        <KeyTag workKey={row.key} />
        <span className="min-w-0 flex-1 truncate text-sm leading-5 text-ink" title={row.title}>
          {row.title}
        </span>
        {row.needsAttention ? <NeedsYouChip reason={attentionReasonOf(row)} /> : null}
      </span>
      <span className="flex min-w-0 items-center gap-2 ps-[calc(var(--spacing)*5)]">
        <StatusChip kind={row.kind} state={row.state} staleBecauseKey={row.staleBecauseKey} />
        {row.archived ? <Badge variant="outline">Archived</Badge> : null}
        <span className="min-w-0 truncate text-xs leading-xs text-ink-3">{relativeTime(row.updatedAt)}</span>
      </span>
    </button>
  );
}

function BacklogTable({ rows, onOpen }: { rows: readonly ProjectWorkListItem[]; onOpen: (row: ProjectWorkListItem) => void }) {
  const columns: DataTableColumn<ProjectWorkListItem>[] = [
    {
      key: "key",
      label: "Key",
      width: "10rem",
      render: (row) => (
        <span className="flex items-center gap-2">
          <TypeBadge kind={row.kind} />
          <KeyTag workKey={row.key} />
        </span>
      ),
    },
    {
      key: "title",
      label: "Title",
      render: (row) => (
        <button
          type="button"
          onClick={() => onOpen(row)}
          className="min-w-0 max-w-full truncate text-start text-sm leading-5 text-ink outline-none hover:underline focus-visible:outline-solid focus-visible:outline-2 focus-visible:outline-live"
          title={row.title}
        >
          {row.title}
        </button>
      ),
    },
    {
      key: "status",
      label: "Status",
      width: "12rem",
      render: (row) => (
        <span className="flex items-center gap-1.5">
          <StatusChip kind={row.kind} state={row.state} staleBecauseKey={row.staleBecauseKey} />
          {row.needsAttention ? <NeedsYouChip reason={attentionReasonOf(row)} /> : null}
        </span>
      ),
    },
    {
      key: "links",
      label: "Links",
      width: "6rem",
      mono: true,
      optional: true,
      render: (row) => {
        const total = row.linkCounts.edges + row.linkCounts.repository + row.linkCounts.execution;
        return total === 0 ? <span className="text-ink-3">—</span> : <span className="tnum">{total}</span>;
      },
    },
    {
      key: "revisions",
      label: "Revisions",
      width: "7rem",
      mono: true,
      optional: true,
      render: (row) => <span className="tnum">{row.revisionCount}</span>,
    },
    {
      key: "updated",
      label: "Updated",
      width: "10rem",
      optional: true,
      render: (row) => <span className="text-ink-2">{relativeTime(row.updatedAt)}</span>,
    },
  ];
  return (
    <DataTable
      columns={columns}
      rows={rows}
      rowKey={(row) => row.ref.entityId}
      caption="Every piece of work in this project"
      rowClassName={(row) => (row.archived ? "opacity-70" : undefined)}
      minWidth="48rem"
    />
  );
}
