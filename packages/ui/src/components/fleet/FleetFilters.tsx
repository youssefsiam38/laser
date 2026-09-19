"use client";
/**
 * One row: Going · Asking · Ended, then a hairline, then the kind cut
 * (All / Agents / Commands).
 *
 * One row, and never two. The column's chrome budget (`fleet/chrome.ts`) is
 * 72px from the top of the panel to the session, and the header takes 48 of
 * it; a second row of chips took a third of a 320px column to say what the
 * header already says. So the row does not wrap — it scrolls its own overflow
 * — and it paints 24px on a mouse, growing to a 44px target on a finger.
 *
 * A count is shown only when it is not zero. `Asking 0` is a control that
 * promises nothing and costs the width of a word; the absence of a number is
 * the same information, quieter.
 *
 * Counts come from the unfiltered tree so a chip never zeros itself when
 * pressed. Lifecycle chips toggle (a struck label is a cut that is on); the
 * kind is a single choice with one tab stop and arrow keys.
 */
import { useRef, type KeyboardEvent } from "react";

import { FLEET_FILTERS_HEIGHT, type FleetFilter, type FleetFilterCounts } from "@/fleet";
import { useLogicalArrowKeys } from "@/hooks/use-direction";
import { cn } from "@/lib/utils";

const KIND_OPTIONS = [
  { key: "all" as const, slot: "fleet-filter-kind-all", label: "All" },
  { key: "agent" as const, slot: "fleet-filter-kind-agents", label: "Agents", countKey: "agents" as const },
  { key: "task" as const, slot: "fleet-filter-kind-commands", label: "Commands", countKey: "commands" as const },
];

/** One chip's paint. Shared so the six controls are one row, not two designs. */
const CHIP = cn(
  "inline-flex h-6 shrink-0 items-center gap-1 rounded-md px-1.5 text-xs leading-xs outline-none",
  "transition-colors duration-(--motion-instant) motion-reduce:transition-none",
  "focus-visible:outline-solid focus-visible:outline-2 focus-visible:-outline-offset-2 focus-visible:outline-live",
  "pointer-coarse:h-11",
);

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
    <div
      data-slot="fleet-filters"
      data-fleet-chrome="filters"
      className={cn("flex shrink-0 items-center gap-1 overflow-x-auto overflow-y-hidden scrollbar-none px-3 hairline-b", FLEET_FILTERS_HEIGHT)}
    >
      <div role="group" aria-label="Lifecycle" className="flex shrink-0 items-center gap-0.5">
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
      {/* A hairline, not a gap: two kinds of control on one row need to read
          as two groups without a second row to put them on. */}
      <span aria-hidden="true" className="mx-0.5 h-3 w-px shrink-0 bg-line" />
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
      className="flex shrink-0 items-center gap-0.5"
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
            className={cn(CHIP, selected ? "bg-surface-2 text-ink" : "text-ink-3 hover:bg-surface-2 hover:text-ink-2")}
          >
            <span>{option.label}</span>
            {count ? <span className="tnum text-ink-3">{count}</span> : null}
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
        CHIP,
        // On is the resting state, so it carries no ground: three filled chips
        // would be three pieces of furniture for a list nobody has cut yet.
        // Off is the change, and it is struck through — colour is not the only
        // thing carrying it.
        pressed ? "text-ink hover:bg-surface-2" : "text-ink-3 line-through hover:bg-surface-2 hover:text-ink-2",
      )}
    >
      <span>{label}</span>
      {count ? <span className="tnum text-ink-3">{count}</span> : null}
    </button>
  );
}
