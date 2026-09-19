"use client";
/**
 * One row: Going · Asking · Ended, then a hairline, then the kind cut
 * (all / agents / commands).
 *
 * One row, and never two. The column's chrome budget (`fleet/chrome.ts`) is
 * 72px from the top of the panel to the session, and the header takes 48 of
 * it; a second row of chips took a third of a 320px column to say what the
 * header already says.
 *
 * **And one row that fits.** Six chips spelled out need 383px of the 288 this
 * column gives them, so the row used to scroll its own overflow: the person
 * saw `Commands 2` sliced by the panel border, with no affordance saying it
 * could be scrolled, and the sliced chip was the one carrying a number. A
 * component that cannot fit its content shows less content (AGENTS.md), so
 * this row gives things up, in a fixed order, until it fits:
 *
 *   0 · everything: three lifecycle chips with counts, three kind chips with
 *       counts. The sheet on a tablet stays here.
 *   1 · the kind cut collapses into one control that says which kind is on
 *       and opens a menu; the agent and command counts move into that menu,
 *       where they are read rather than glanced at. Worth 131px, and the
 *       kind is the question that is answered once a session, not once a
 *       minute — the 320px column normally lands here.
 *   2 · the chips tighten: 4px of side padding instead of 6, and the hairline
 *       loses its margins. Paint, not content — nothing is lost, and it buys
 *       the three-digit counts of a busy fleet.
 *   3 · the lifecycle counts move into each chip's tooltip and accessible
 *       name. The word is the control's name and the count is also in the
 *       panel header, so the number yields before the word does. Only a
 *       larger text-size setting gets this far at 288px.
 *
 * The step is chosen by measuring, not by guessing a breakpoint: the row
 * renders, compares `scrollWidth` to `clientWidth` in a layout effect, and
 * gives one more thing up until it fits — before the browser paints, so no
 * frame ever shows the overflow. Any cause counts, which is the point: a
 * narrower column, a larger type scale, a three-digit count and a longer word
 * in another language all arrive at the same place. A width change or a count
 * change starts again from step 0, so the row takes back what it can.
 *
 * A count is shown only when it is not zero. `Asking 0` is a control that
 * promises nothing and costs the width of a word; the absence of a number is
 * the same information, quieter.
 *
 * Counts come from the unfiltered tree so a chip never zeros itself when
 * pressed. Lifecycle chips toggle (a struck label is a cut that is on); the
 * kind is a single choice — one tab stop and arrow keys while it is three
 * chips, a menu of radio items once it is one control.
 */
import { Bot, ChevronDown, ListFilter, SquareTerminal } from "lucide-react";
import { useLayoutEffect, useRef, useState, type ComponentType, type KeyboardEvent, type RefObject } from "react";

import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuRadioGroup,
  DropdownMenuRadioItem,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { ControlHint } from "@/components/ui/hint";
import { FLEET_FILTERS_HEIGHT, type FleetFilter, type FleetFilterCounts, type FleetKindFilter } from "@/fleet";
import { useLogicalArrowKeys } from "@/hooks/use-direction";
import { cn } from "@/lib/utils";

interface KindOption {
  key: FleetKindFilter;
  slot: string;
  label: string;
  /** The glyph that stands for this kind once the words are gone. */
  icon: ComponentType<{ className?: string; "aria-hidden"?: boolean }>;
  countKey?: keyof FleetFilterCounts;
}

const KIND_OPTIONS: readonly KindOption[] = [
  // No kind cut is on: the control is a filter that is not filtering, and it
  // says so rather than naming one of the two kinds it is not hiding.
  { key: "all", slot: "fleet-filter-kind-all", label: "All", icon: ListFilter },
  { key: "agent", slot: "fleet-filter-kind-agents", label: "Agents", icon: Bot, countKey: "agents" },
  { key: "task", slot: "fleet-filter-kind-commands", label: "Commands", icon: SquareTerminal, countKey: "commands" },
];

const LIFECYCLE_OPTIONS = [
  { key: "going" as const, slot: "fleet-filter-going", label: "Going" },
  { key: "asking" as const, slot: "fleet-filter-asking", label: "Asking" },
  { key: "ended" as const, slot: "fleet-filter-ended", label: "Ended" },
];

/** The steps this row can stand on, widest content first. */
const FLEET_FILTER_FIT_STEPS = 4;
const LAST_STEP = FLEET_FILTER_FIT_STEPS - 1;
/** Step ≥ this: the kind cut is one control with a menu. */
const STEP_KIND_MENU = 1;
/** Step ≥ this: chips tighten their padding. Paint, never content. */
const STEP_TIGHT = 2;
/** Step ≥ this: a lifecycle count lives in the tooltip and the name. */
const STEP_NO_COUNTS = 3;

/** One chip's paint. Shared so the controls are one row, not two designs. */
const chip = (tight: boolean): string =>
  cn(
    "inline-flex h-6 shrink-0 items-center gap-1 rounded-md text-xs leading-xs outline-none",
    tight ? "px-1" : "px-1.5",
    "transition-colors duration-(--motion-instant) motion-reduce:transition-none",
    "focus-visible:outline-solid focus-visible:outline-2 focus-visible:-outline-offset-2 focus-visible:outline-live",
    "pointer-coarse:h-11",
  );

/**
 * Give one more thing up until the row fits, and take it back when it can.
 *
 * `useLayoutEffect` with no dependency list runs after every commit and before
 * paint, so a step that still overflows takes the next one in the same frame.
 * `signature` is everything that can change the natural width from inside the
 * component (the counts) or outside it (the box), and a change to it restarts
 * at 0 rather than leaving the row permanently small.
 */
function useFitStep(row: RefObject<HTMLElement | null>, signature: string): number {
  const [step, setStep] = useState(0);
  const last = useRef(signature);
  useLayoutEffect(() => {
    const element = row.current;
    if (!element) return;
    if (last.current !== signature) {
      last.current = signature;
      if (step !== 0) {
        setStep(0);
        return;
      }
    }
    if (step < LAST_STEP && element.scrollWidth > element.clientWidth) setStep(step + 1);
  });
  return step;
}

export function FleetFilters({
  filter,
  counts,
  onChange,
}: {
  filter: FleetFilter;
  counts: FleetFilterCounts;
  onChange(next: FleetFilter): void;
}) {
  const row = useRef<HTMLDivElement>(null);
  const [width, setWidth] = useState(0);
  useLayoutEffect(() => {
    const element = row.current;
    if (!element || typeof ResizeObserver === "undefined") return;
    const observer = new ResizeObserver((entries) => {
      const entry = entries[0];
      if (entry) setWidth(Math.round(entry.contentRect.width));
    });
    observer.observe(element);
    return () => observer.disconnect();
  }, []);
  const step = useFitStep(
    row,
    `${width}:${counts.going}/${counts.asking}/${counts.ended}/${counts.agents}/${counts.commands}`,
  );
  const tight = step >= STEP_TIGHT;

  const toggleLifecycle = (key: keyof FleetFilter["lifecycle"]) => {
    onChange({ ...filter, lifecycle: { ...filter.lifecycle, [key]: !filter.lifecycle[key] } });
  };

  return (
    <div
      ref={row}
      data-slot="fleet-filters"
      data-fleet-chrome="filters"
      data-fit={step}
      className={cn(
        // No scroller: this row does not hide a control behind a gesture
        // nothing announces. It sheds content until it fits; `overflow-hidden`
        // is the backstop for a column narrower than any step, never the
        // mechanism.
        "flex w-full min-w-0 shrink-0 items-center gap-1 overflow-hidden px-3 hairline-b",
        FLEET_FILTERS_HEIGHT,
      )}
    >
      <div role="group" aria-label="Lifecycle" className={cn("flex shrink-0 items-center", tight ? "gap-px" : "gap-0.5")}>
        {LIFECYCLE_OPTIONS.map((option) => (
          <FilterChip
            key={option.key}
            slot={option.slot}
            label={option.label}
            count={counts[option.key]}
            showCount={step < STEP_NO_COUNTS}
            tight={tight}
            pressed={filter.lifecycle[option.key]}
            onClick={() => toggleLifecycle(option.key)}
          />
        ))}
      </div>
      {/* A hairline, not a gap: two kinds of control on one row need to read
          as two groups without a second row to put them on. */}
      <span aria-hidden="true" className={cn("h-3 w-px shrink-0 bg-line", !tight && "mx-0.5")} />
      {step >= STEP_KIND_MENU ? (
        <KindMenu filter={filter} counts={counts} onChange={onChange} tight={tight} />
      ) : (
        <KindGroup filter={filter} counts={counts} onChange={onChange} />
      )}
    </div>
  );
}

/**
 * The kind cut as three chips: one tab stop, arrow keys, counts in place.
 * What the row shows when it has the width for it.
 */
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
            className={cn(chip(false), selected ? "bg-surface-2 text-ink" : "text-ink-3 hover:bg-surface-2 hover:text-ink-2")}
          >
            <span>{option.label}</span>
            {count ? <span className="tnum text-ink-3">{count}</span> : null}
          </button>
        );
      })}
    </div>
  );
}

/**
 * The kind cut as one control: the current kind's glyph and a chevron, and a
 * menu of the three with their counts. 36px instead of 167, and the thing it
 * gives up — reading both counts without opening anything — is the thing the
 * panel header and the rows themselves say anyway.
 */
function KindMenu({
  filter,
  counts,
  onChange,
  tight,
}: {
  filter: FleetFilter;
  counts: FleetFilterCounts;
  onChange(next: FleetFilter): void;
  tight: boolean;
}) {
  const current = KIND_OPTIONS.find((option) => option.key === filter.kind) ?? KIND_OPTIONS[0]!;
  const Glyph = current.icon;
  const cutting = filter.kind !== "all";
  const hint = [
    counts.agents ? `${counts.agents} ${counts.agents === 1 ? "agent" : "agents"}` : undefined,
    counts.commands ? `${counts.commands} ${counts.commands === 1 ? "command" : "commands"}` : undefined,
  ]
    .filter((part): part is string => Boolean(part))
    .join(" · ");
  return (
    <DropdownMenu>
      <ControlHint hint={hint || undefined}>
        <DropdownMenuTrigger
          data-slot="fleet-filter-kind"
          data-kind={filter.kind}
          aria-label={`Kind: ${current.label}`}
          className={cn(
            chip(tight),
            "gap-0.5",
            cutting ? "bg-surface-2 text-ink" : "text-ink-3 hover:bg-surface-2 hover:text-ink-2",
          )}
        >
          <Glyph className="size-3.5" aria-hidden={true} />
          <ChevronDown className="size-3" aria-hidden={true} />
        </DropdownMenuTrigger>
      </ControlHint>
      <DropdownMenuContent align="end" data-slot="fleet-filter-kind-menu">
        <DropdownMenuRadioGroup
          value={filter.kind}
          onValueChange={(value) => onChange({ ...filter, kind: value as FleetKindFilter })}
        >
          {KIND_OPTIONS.map((option) => {
            const count = option.countKey ? counts[option.countKey] : undefined;
            return (
              <DropdownMenuRadioItem key={option.key} value={option.key} data-slot={`${option.slot}-item`}>
                <option.icon className="size-3.5 text-ink-3" aria-hidden={true} />
                <span className="flex-1">{option.label}</span>
                {count ? <span className="tnum text-ink-3">{count}</span> : null}
              </DropdownMenuRadioItem>
            );
          })}
        </DropdownMenuRadioGroup>
      </DropdownMenuContent>
    </DropdownMenu>
  );
}

function FilterChip({
  slot,
  label,
  count,
  showCount,
  tight,
  pressed,
  onClick,
}: {
  slot: string;
  label: string;
  count: number;
  showCount: boolean;
  tight: boolean;
  pressed: boolean;
  onClick(): void;
}) {
  const carried = count > 0 && !showCount;
  const button = (
    <button
      type="button"
      data-slot={slot}
      aria-pressed={pressed}
      // The count is never dropped, only moved: when the row has no width for
      // it, the number is in the name a screen reader reads and in the hint a
      // pointer or a keyboard opens.
      aria-label={carried ? `${label}, ${count}` : undefined}
      onClick={onClick}
      className={cn(
        chip(tight),
        // On is the resting state, so it carries no ground: three filled chips
        // would be three pieces of furniture for a list nobody has cut yet.
        // Off is the change, and it is struck through — colour is not the only
        // thing carrying it.
        pressed ? "text-ink hover:bg-surface-2" : "text-ink-3 line-through hover:bg-surface-2 hover:text-ink-2",
      )}
    >
      <span>{label}</span>
      {count && showCount ? <span className="tnum text-ink-3">{count}</span> : null}
    </button>
  );
  return carried ? <ControlHint hint={`${count} ${label.toLowerCase()}`}>{button}</ControlHint> : button;
}
