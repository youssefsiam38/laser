"use client";
/**
 * The shared controls Settings → Appearance is built from (M11-T4).
 *
 * Three pieces, and nothing else: a `Group` (a titled section with its own
 * Reset), a `Segmented` radio row for the five knobs, and `Swatch` for a
 * colour chip. They exist here rather than in each panel so every group in
 * Appearance has the same header, the same reset affordance and the same
 * keyboard behaviour.
 *
 * `Segmented` is a real `role="radiogroup"`: arrow keys move the selection,
 * Home/End jump to the ends, and only the checked option is in the tab order
 * (the roving-tabindex pattern browsers give native radios for free and
 * `<button>`s do not). Every visual value is a token; nothing here spells a
 * colour, a size or a duration.
 */
import { useCallback, useId, useRef, type CSSProperties, type ReactNode } from "react";
import { ChevronRight, RotateCcw } from "lucide-react";

import { Button } from "@/components/ui/button";
import { Collapsible, CollapsibleContent, CollapsibleTrigger } from "@/components/ui/collapsible";
import { cn } from "@/lib/utils";
import { useLogicalArrowKeys } from "@/hooks/use-direction";

export interface GroupProps {
  title: string;
  /** One line saying what the group changes. Always drawn: a group with no explanation is a guess. */
  detail: string;
  /** Omit to draw no reset (a group with nothing of its own to restore). */
  onReset?: (() => void) | undefined;
  /** Reset is drawn but disabled when the group already matches its origin. */
  resetDisabled?: boolean | undefined;
  /** What the reset restores, for the button's accessible name and tooltip. */
  resetLabel?: string | undefined;
  children: ReactNode;
}

export function Group({ title, detail, onReset, resetDisabled, resetLabel, children }: GroupProps) {
  const headingId = useId();
  return (
    <section aria-labelledby={headingId} className="flex flex-col gap-3">
      <header className="flex items-start gap-3">
        <div className="min-w-0 flex-1">
          <h3 id={headingId} className="text-sm font-semibold text-ink">
            {title}
          </h3>
          <p className="mt-0.5 text-xs leading-4 text-ink-3">{detail}</p>
        </div>
        {onReset && (
          <Button
            variant="ghost"
            size="sm"
            onClick={onReset}
            disabled={resetDisabled === true}
            title={resetDisabled === true ? "Already at its default" : (resetLabel ?? `Reset ${title.toLowerCase()}`)}
          >
            <RotateCcw aria-hidden="true" />
            Reset
          </Button>
        )}
      </header>
      {children}
    </section>
  );
}

export interface SegmentedOption<T extends string> {
  value: T;
  label: string;
  /** Shown under the row once this option is selected — what the choice actually does. */
  detail?: string | undefined;
}

export interface SegmentedProps<T extends string> {
  label: string;
  value: T;
  options: readonly SegmentedOption<T>[];
  onChange: (value: T) => void;
  /** Extra content between the label and the row (a live specimen, a warning). */
  children?: ReactNode;
}

export function Segmented<T extends string>({ label, value, options, onChange, children }: SegmentedProps<T>) {
  const logicalKey = useLogicalArrowKeys();
  const labelId = useId();
  const container = useRef<HTMLDivElement>(null);

  const move = useCallback(
    (delta: number | "first" | "last") => {
      const index = options.findIndex((option) => option.value === value);
      const next =
        delta === "first"
          ? 0
          : delta === "last"
            ? options.length - 1
            : (index + delta + options.length) % options.length;
      const option = options[next];
      if (!option) return;
      onChange(option.value);
      // Selection follows focus in a radio group, so the newly checked control
      // must take the focus with it or the next arrow key goes nowhere.
      requestAnimationFrame(() => {
        container.current?.querySelector<HTMLButtonElement>('[role="radio"][aria-checked="true"]')?.focus();
      });
    },
    [onChange, options, value],
  );

  const selected = options.find((option) => option.value === value);

  return (
    <div className="flex flex-col gap-1.5">
      <span id={labelId} className="text-xs font-medium text-ink-2">
        {label}
      </span>
      {children}
      <div
        ref={container}
        role="radiogroup"
        aria-labelledby={labelId}
        className="flex w-fit max-w-full flex-wrap items-center gap-0.5 rounded-lg bg-surface-2 p-0.5"
        onKeyDown={(event) => {
          const key = logicalKey(event.key);
          if (key === "ArrowRight" || key === "ArrowDown") {
            event.preventDefault();
            move(1);
          } else if (key === "ArrowLeft" || key === "ArrowUp") {
            event.preventDefault();
            move(-1);
          } else if (key === "Home") {
            event.preventDefault();
            move("first");
          } else if (key === "End") {
            event.preventDefault();
            move("last");
          }
        }}
      >
        {options.map((option) => {
          const checked = option.value === value;
          return (
            <button
              key={option.value}
              type="button"
              role="radio"
              aria-checked={checked}
              tabIndex={checked ? 0 : -1}
              onClick={() => onChange(option.value)}
              className={cn(
                "h-7 rounded-md px-2.5 text-xs font-medium outline-none",
                "transition-[background-color,color] duration-(--motion-instant) motion-reduce:transition-none",
                "focus-visible:outline-solid focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-live",
                checked ? "bg-surface text-ink shadow-float-sm" : "text-ink-2 hover:text-ink",
              )}
            >
              {option.label}
            </button>
          );
        })}
      </div>
      {selected?.detail && <p className="text-xs leading-4 text-ink-3">{selected.detail}</p>}
    </div>
  );
}

export interface DisclosureProps {
  label: string;
  /** The current choice, shown on the closed trigger so the group need not be opened to read it. */
  value: string;
  /** Rendered in `style` on the value, so a font row can show its own face. */
  valueStyle?: CSSProperties | undefined;
  open: boolean;
  onOpenChange: (open: boolean) => void;
  children: ReactNode;
}

/**
 * A labelled row that expands. Used where the choices are heavy to draw (the
 * font grids) so opening the group is what costs a webfont, not opening
 * Appearance.
 */
export function Disclosure({ label, value, valueStyle, open, onOpenChange, children }: DisclosureProps) {
  return (
    <Collapsible open={open} onOpenChange={onOpenChange}>
      <CollapsibleTrigger
        className={cn(
          "flex w-full items-center gap-2 rounded-lg border border-line px-2.5 py-2 text-start outline-none",
          "transition-[background-color,border-color] duration-(--motion-instant) motion-reduce:transition-none",
          "hover:bg-surface-2 focus-visible:outline-solid focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-live",
        )}
      >
        <ChevronRight
          aria-hidden="true"
          className={cn("rtl:-scale-x-100",
            "size-3.5 shrink-0 text-ink-3 transition-transform duration-(--motion-fast) motion-reduce:transition-none",
            open && "rotate-90 rtl:-rotate-90",
          )}
        />
        <span className="shrink-0 text-xs font-medium text-ink-2">{label}</span>
        <span style={valueStyle} className="ms-auto min-w-0 truncate text-sm text-ink">
          {value}
        </span>
      </CollapsibleTrigger>
      <CollapsibleContent>
        <div className="pt-2">{children}</div>
      </CollapsibleContent>
    </Collapsible>
  );
}

/** A colour chip. `title` is the accessible name; the ring shows selection. */
export function Swatch({
  color,
  selected,
  className,
}: {
  color: string;
  selected?: boolean | undefined;
  className?: string | undefined;
}) {
  return (
    <span
      aria-hidden="true"
      style={{ background: color }}
      className={cn(
        "block size-5 rounded-full",
        "transition-[box-shadow] duration-(--motion-instant) motion-reduce:transition-none",
        selected === true
          ? "ring-2 ring-live ring-offset-2 ring-offset-[var(--surface)]"
          : "ring-1 ring-[color-mix(in_oklab,var(--ink)_18%,transparent)]",
        className,
      )}
    />
  );
}
