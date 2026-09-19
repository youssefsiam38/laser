"use client";
/**
 * Going · Asking · Ended, plus a kind cut. Counts on the chips come from the
 * unfiltered tree so a chip never zeros itself when pressed.
 */
import { useRef, type KeyboardEvent } from "react";

import type { FleetFilter, FleetFilterCounts } from "@/fleet";
import { useLogicalArrowKeys } from "@/hooks/use-direction";
import { cn } from "@/lib/utils";

const KIND_OPTIONS = [
  { key: "all" as const, slot: "fleet-filter-kind-all", label: "All" },
  { key: "agent" as const, slot: "fleet-filter-kind-agents", label: "Agents", countKey: "agents" as const },
  { key: "task" as const, slot: "fleet-filter-kind-commands", label: "Commands", countKey: "commands" as const },
];

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
      <KindGroup filter={filter} counts={counts} onChange={onChange} />
    </div>
  );
}

function KindGroup({
  filter,
  counts,
  onChange,
}: {
  filter: FleetFilter;
  counts: FleetFilterCounts;
  onChange(next: FleetFilter): void;
}) {
  const logicalKey = useLogicalArrowKeys();
  const groupRef = useRef<HTMLDivElement>(null);
  const activeIndex = Math.max(0, KIND_OPTIONS.findIndex((option) => option.key === filter.kind));

  const choose = (index: number) => {
    const option = KIND_OPTIONS[Math.max(0, Math.min(KIND_OPTIONS.length - 1, index))];
    if (!option) return;
    onChange({ ...filter, kind: option.key });
    groupRef.current?.querySelectorAll<HTMLElement>('[role="radio"]')[KIND_OPTIONS.indexOf(option)]?.focus();
  };

  const onKeyDown = (event: KeyboardEvent<HTMLDivElement>) => {
    const last = KIND_OPTIONS.length - 1;
    let next: number | undefined;
    const key = logicalKey(event.key);
    if (key === "ArrowRight" || key === "ArrowUp") next = Math.min(last, activeIndex + 1);
    else if (key === "ArrowLeft" || key === "ArrowDown") next = Math.max(0, activeIndex - 1);
    else if (event.key === "Home") next = 0;
    else if (event.key === "End") next = last;
    if (next === undefined) return;
    event.preventDefault();
    choose(next);
  };

  return (
    <div
      ref={groupRef}
      role="radiogroup"
      aria-label="Kind"
      onKeyDown={onKeyDown}
      className="flex min-w-0 flex-wrap gap-1"
    >
      {KIND_OPTIONS.map((option, index) => {
        const selected = filter.kind === option.key;
        const count = option.countKey ? counts[option.countKey] : undefined;
        return (
          <button
            key={option.key}
            type="button"
            role="radio"
            data-slot={option.slot}
            aria-checked={selected}
            tabIndex={index === activeIndex ? 0 : -1}
            onClick={() => choose(index)}
            className={cn(
              "inline-flex min-h-11 items-center gap-1 rounded-lg px-2 text-xs leading-xs outline-none",
              "transition-colors duration-(--motion-instant) motion-reduce:transition-none",
              "focus-visible:outline-solid focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-live",
              "active:bg-surface-2 active:text-ink",
              selected ? "bg-surface-2 text-ink" : "text-ink-3 hover:bg-surface-2 hover:text-ink-2",
            )}
          >
            <span>{option.label}</span>
            {count !== undefined ? <span className="tnum text-ink-3">{count}</span> : null}
          </button>
        );
      })}
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
        "active:bg-surface-2 active:text-ink",
        pressed ? "bg-surface-2 text-ink" : "text-ink-3 hover:bg-surface-2 hover:text-ink-2",
      )}
    >
      <span>{label}</span>
      <span className="tnum text-ink-3">{count}</span>
    </button>
  );
}
