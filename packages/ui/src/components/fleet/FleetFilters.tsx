"use client";
/**
 * Going · Asking · Ended, plus a kind cut. Counts on the chips come from the
 * unfiltered tree so a chip never zeros itself when pressed.
 */
import type { FleetFilter, FleetFilterCounts, FleetKindFilter } from "@/fleet";
import { cn } from "@/lib/utils";

export function FleetFilters({
  filter,
  counts,
  onChange,
}: {
  filter: FleetFilter;
  counts: FleetFilterCounts;
  onChange(next: FleetFilter): void;
}) {
  const toggleLifecycle = (key: keyof FleetFilter["lifecycle"]) => {
    onChange({ ...filter, lifecycle: { ...filter.lifecycle, [key]: !filter.lifecycle[key] } });
  };
  const setKind = (kind: FleetKindFilter) => onChange({ ...filter, kind });

  return (
    <div data-slot="fleet-filters" className="flex flex-col gap-1.5 px-3 py-2">
      <div role="group" aria-label="Lifecycle" className="flex min-w-0 flex-wrap gap-1">
        <FilterChip
          slot="fleet-filter-going"
          label="Going"
          count={counts.going}
          pressed={filter.lifecycle.going}
          onClick={() => toggleLifecycle("going")}
        />
        <FilterChip
          slot="fleet-filter-asking"
          label="Asking"
          count={counts.asking}
          pressed={filter.lifecycle.asking}
          onClick={() => toggleLifecycle("asking")}
        />
        <FilterChip
          slot="fleet-filter-ended"
          label="Ended"
          count={counts.ended}
          pressed={filter.lifecycle.ended}
          onClick={() => toggleLifecycle("ended")}
        />
      </div>
      <div role="radiogroup" aria-label="Kind" className="flex min-w-0 flex-wrap gap-1">
        <KindChip slot="fleet-filter-kind-all" label="All" selected={filter.kind === "all"} onClick={() => setKind("all")} />
        <KindChip
          slot="fleet-filter-kind-agents"
          label="Agents"
          count={counts.agents}
          selected={filter.kind === "agent"}
          onClick={() => setKind("agent")}
        />
        <KindChip
          slot="fleet-filter-kind-commands"
          label="Commands"
          count={counts.commands}
          selected={filter.kind === "task"}
          onClick={() => setKind("task")}
        />
      </div>
    </div>
  );
}

function FilterChip({
  slot,
  label,
  count,
  pressed,
  onClick,
}: {
  slot: string;
  label: string;
  count: number;
  pressed: boolean;
  onClick(): void;
}) {
  return (
    <button
      type="button"
      data-slot={slot}
      aria-pressed={pressed}
      onClick={onClick}
      className={cn(
        "inline-flex min-h-11 items-center gap-1 rounded-lg px-2 text-xs leading-xs outline-none",
        "transition-colors duration-(--motion-instant) motion-reduce:transition-none",
        "focus-visible:outline-solid focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-live",
        pressed ? "bg-surface-2 text-ink" : "text-ink-3 hover:bg-surface-2 hover:text-ink-2",
      )}
    >
      <span>{label}</span>
      <span className="tnum text-ink-3">{count}</span>
    </button>
  );
}

function KindChip({
  slot,
  label,
  count,
  selected,
  onClick,
}: {
  slot: string;
  label: string;
  count?: number;
  selected: boolean;
  onClick(): void;
}) {
  return (
    <button
      type="button"
      role="radio"
      data-slot={slot}
      aria-checked={selected}
      onClick={onClick}
      className={cn(
        "inline-flex min-h-11 items-center gap-1 rounded-lg px-2 text-xs leading-xs outline-none",
        "transition-colors duration-(--motion-instant) motion-reduce:transition-none",
        "focus-visible:outline-solid focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-live",
        selected ? "bg-surface-2 text-ink" : "text-ink-3 hover:bg-surface-2 hover:text-ink-2",
      )}
    >
      <span>{label}</span>
      {count !== undefined ? <span className="tnum text-ink-3">{count}</span> : null}
    </button>
  );
}
