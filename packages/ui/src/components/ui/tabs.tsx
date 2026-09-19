"use client";
/**
 * The product's one tab idiom, and the one segmented control built from it.
 *
 * **The idiom: quiet ground, one rule.** A selected option keeps the panel's
 * own ground — there is no track behind the row and no filled pill on top of
 * it — and is named by two things only: full-strength `--ink` on its label,
 * and a 2px `--ink` rule riding the strip's hairline underneath it. An
 * unselected option is `--ink-2` on nothing; hovering it changes the ground to
 * `--surface-2` rather than drawing a box. That is DESIGN.md's vocabulary
 * ("hairlines instead of boxes", "no drop shadows on flat panels") applied to
 * a choice: the old grey track with a white `shadow-float-sm` pill was a
 * floating shadow on a flat panel, which the spec forbids outright, and it
 * read as the widget every starter template ships.
 *
 * **Why the rule is ink and not `--live`.** The accent is spoken for: one
 * accent means "live" and one warm hue means "needs you" (DESIGN.md "Status
 * language"), and these very tabs carry a status dot for activity hidden
 * behind them. A steady blue underline beside a blue activity dot would say
 * "something is running here" when it only means "you are here". Ink says
 * where you are; colour stays evidence about the agents.
 *
 * **Everything else is shared.** One tab stop per group (a real roving
 * tabindex), arrows move *and* select, Home/End jump to the ends and the
 * selection wraps — the behaviour of `elements/reasoning-effort.tsx`, the
 * canonical radiogroup (docs/ux-elements.md "Reasoning effort"), with the
 * horizontal axis mapped the way APG and `settings/appearance/controls.tsx`
 * already map it (Right/Down forward, Left/Up back) and through
 * `useLogicalArrowKeys`, so RTL is handled once. Focus paints inside the
 * option (`-outline-offset`) so it is never clipped by a neighbour, the hit
 * area is 44px on coarse pointers whatever the paint is, and a count is a
 * `typed` tabular number at the 12px floor — never smaller than the label.
 *
 * Two roles, one look:
 *   - `Tabs` is navigation: `role="tablist"` / `role="tab"` / `aria-selected`,
 *     for a strip that swaps the panel underneath it.
 *   - `SegmentedControl` is a value: `role="radiogroup"` / `role="radio"` /
 *     `aria-checked`, for a setting or a filter that stays on one screen.
 */
import { useRef, type KeyboardEvent, type ReactNode } from "react";

import { useLogicalArrowKeys } from "@/hooks/use-direction";
import { cn } from "@/lib/utils";

export interface TabOption<T extends string> {
  value: T;
  /** The visible word. Short: this is a strip, not a sentence. */
  label: string;
  /**
   * What is behind this choice, as a tabular number beside the label. `0` is
   * drawn: an honest zero is information, an absent count is not.
   */
  count?: number | undefined;
  /** How the count reads aloud ("2 chats"); appended to the accessible name. */
  countName?: string | undefined;
  /** A leading icon. Sized by the strip, never by the caller. */
  icon?: ReactNode | undefined;
  /**
   * A trailing mark (a status dot). Drawn out of flow at the option's end so
   * it can appear and disappear without moving the label.
   */
  mark?: ReactNode | undefined;
  /** The whole accessible name, when label + count is not the whole story. */
  name?: string | undefined;
  /** `data-slot` on the option, for call sites and tests. */
  slot?: string | undefined;
  /** DOM id — what the panel's `aria-labelledby` points at. */
  id?: string | undefined;
  /** The panel this option controls. */
  controls?: string | undefined;
  disabled?: boolean | undefined;
}

interface StripProps<T extends string> {
  value: T;
  options: readonly TabOption<T>[];
  onChange: (value: T) => void;
  /** The group's accessible name. One of `label` / `labelledBy` is required. */
  label?: string | undefined;
  labelledBy?: string | undefined;
  /** Options share the row equally instead of taking their own width. */
  stretch?: boolean | undefined;
  /** `md` = a navigation strip (13px); `sm` = an inline choice (12px). */
  size?: "sm" | "md" | undefined;
  /** Readable, but neither click nor arrow keys change it. */
  disabled?: boolean | undefined;
  /** Options wrap onto a second row rather than overflowing. */
  wrap?: boolean | undefined;
  busy?: boolean | undefined;
  /** The strip's own hairline, which the selected rule rides. Tabs: on. */
  rail?: boolean | undefined;
  className?: string | undefined;
}

interface CoreProps<T extends string> extends StripProps<T> {
  kind: "tablist" | "radiogroup";
}

/**
 * The idiom's one painted element, on its own, for a strip that must keep its
 * own markup — a Radix `RadioGroup.Item` that a tooltip has to wrap, say.
 * Put it inside a `relative` option; everything else about that option (ink,
 * hover ground, focus, touch height) is ordinary token styling.
 */
export function OptionRule({ selected }: { selected: boolean }) {
  return (
    <span
      aria-hidden="true"
      data-slot="tab-rule"
      className={cn(
        "pointer-events-none absolute inset-x-1 -bottom-px h-0.5 origin-center rounded-full bg-ink",
        "transition-[opacity,scale] duration-(--motion-fast) motion-reduce:transition-none",
        selected ? "scale-x-100 opacity-100" : "scale-x-50 opacity-0",
      )}
    />
  );
}

/** `999+`: a count is a fact, but a strip is not a place to read six digits. */
function countText(count: number): string {
  return count > 999 ? "999+" : String(count);
}

function accessibleName<T extends string>(option: TabOption<T>): string | undefined {
  if (option.name !== undefined) return option.name;
  if (option.countName !== undefined) return `${option.label}, ${option.countName}`;
  return option.count === undefined ? undefined : `${option.label}, ${countText(option.count)}`;
}

function OptionStrip<T extends string>({
  kind,
  rail = false,
  value,
  options,
  onChange,
  label,
  labelledBy,
  stretch = false,
  size = "md",
  disabled = false,
  wrap = false,
  busy,
  className,
}: CoreProps<T>) {
  const logicalKey = useLogicalArrowKeys();
  const group = useRef<HTMLDivElement>(null);
  const tab = kind === "tablist";
  const selectedIndex = options.findIndex((option) => option.value === value);
  const firstEnabled = options.findIndex((option) => option.disabled !== true);
  // The one tab stop: the selected option, or the first one that works when
  // nothing is selected yet. Everything else is reachable by arrow only.
  const activeIndex = selectedIndex >= 0 ? selectedIndex : Math.max(0, firstEnabled);

  const buttons = (): HTMLButtonElement[] =>
    [...(group.current?.querySelectorAll<HTMLButtonElement>("[data-option]") ?? [])];

  const choose = (index: number): void => {
    const option = options[index];
    if (disabled || !option || option.disabled === true) return;
    // Focus first: the change may be asynchronous (the sessions tabs open a
    // conversation), and focus must not wait for it or arrive after a
    // re-render has moved the tab stop.
    buttons()[index]?.focus();
    if (option.value !== value) onChange(option.value);
  };

  /** The next option that is not disabled, wrapping — APG's radio behaviour. */
  const step = (from: number, direction: 1 | -1): number => {
    for (let n = 1; n <= options.length; n++) {
      const next = (((from + direction * n) % options.length) + options.length) % options.length;
      if (options[next]?.disabled !== true) return next;
    }
    return from;
  };
  const edge = (direction: 1 | -1): number => {
    const indexes = options.map((_, index) => index).filter((index) => options[index]?.disabled !== true);
    return (direction === 1 ? indexes[0] : indexes.at(-1)) ?? activeIndex;
  };

  const onKeyDown = (event: KeyboardEvent<HTMLDivElement>): void => {
    if (disabled) return;
    const key = logicalKey(event.key);
    // Where the person is, not where the value is: a strip whose change is
    // still in flight still moves one step per key press.
    const focused = buttons().indexOf(document.activeElement as HTMLButtonElement);
    const from = focused >= 0 ? focused : activeIndex;
    let next: number | undefined;
    if (key === "ArrowRight" || key === "ArrowDown") next = step(from, 1);
    else if (key === "ArrowLeft" || key === "ArrowUp") next = step(from, -1);
    else if (event.key === "Home") next = edge(1);
    else if (event.key === "End") next = edge(-1);
    if (next === undefined) return;
    event.preventDefault();
    choose(next);
  };

  return (
    <div
      ref={group}
      role={kind}
      aria-label={label}
      aria-labelledby={labelledBy}
      aria-disabled={disabled || undefined}
      aria-busy={busy || undefined}
      data-slot={tab ? "tabs" : "segmented"}
      data-size={size}
      onKeyDown={onKeyDown}
      className={cn(
        "flex min-w-0 items-stretch",
        size === "md" ? "gap-1" : "gap-0.5",
        wrap === true && "flex-wrap",
        rail && "hairline-b",
        disabled && "opacity-60",
        className,
      )}
    >
      {options.map((option, index) => {
        const selected = option.value === value;
        const name = accessibleName(option);
        return (
          <button
            key={option.value}
            type="button"
            role={tab ? "tab" : "radio"}
            {...(tab ? { "aria-selected": selected } : { "aria-checked": selected })}
            {...(option.id === undefined ? {} : { id: option.id })}
            {...(option.controls === undefined ? {} : { "aria-controls": option.controls })}
            {...(name === undefined ? {} : { "aria-label": name })}
            data-option={option.value}
            data-slot={option.slot ?? (tab ? "tab" : "segment")}
            data-state={selected ? "selected" : "unselected"}
            disabled={disabled || option.disabled === true}
            tabIndex={index === activeIndex && !disabled ? 0 : -1}
            onClick={() => choose(index)}
            className={cn(
              "relative flex min-w-0 shrink-0 items-center justify-center gap-1.5 rounded-md select-none",
              "outline-none transition-[background-color,color] duration-(--motion-instant) motion-reduce:transition-none",
              "focus-visible:outline-solid focus-visible:outline-2 focus-visible:-outline-offset-2 focus-visible:outline-live",
              "disabled:pointer-events-none disabled:opacity-45",
              "pointer-coarse:min-h-11",
              size === "md" ? "h-8 px-2 text-sm leading-sm" : "h-7 px-2 text-xs leading-xs",
              selected ? "text-ink" : "text-ink-2 hover:bg-surface-2 hover:text-ink active:bg-surface-2 active:text-ink",
              stretch && "min-w-0 flex-1 basis-0",
            )}
          >
            {option.icon === undefined ? null : (
              <span aria-hidden="true" className="flex shrink-0 items-center [&_svg]:size-3.5 [&_svg]:shrink-0">
                {option.icon}
              </span>
            )}
            {/* The label and its count are one block: whatever follows them —
                a status mark that comes and goes — is added at the option's
                end, so the word a person is reading never moves. */}
            <span data-slot="tab-label" className="flex min-w-0 items-baseline gap-1.5">
              <span className="min-w-0 truncate font-medium">{option.label}</span>
              {option.count === undefined ? null : (
                <span
                  data-slot="tab-count"
                  className={cn("typed shrink-0", selected ? "text-ink-2" : "text-ink-3")}
                >
                  {countText(option.count)}
                </span>
              )}
            </span>
            {option.mark === undefined ? null : (
              <span data-slot="tab-mark" className="flex shrink-0 items-center">
                {option.mark}
              </span>
            )}
            {/* The idiom, one element: a rule that grows into place on the
                strip's hairline, and is the only thing a selection paints. */}
            <OptionRule selected={selected} />
          </button>
        );
      })}
    </div>
  );
}

/**
 * A navigation strip: the selected tab names what the panel below is showing.
 * Give each option `controls` (and `id`, for the panel's `aria-labelledby`).
 */
export function Tabs<T extends string>(props: StripProps<T>) {
  return <OptionStrip {...props} kind="tablist" rail={props.rail ?? true} />;
}

/**
 * A value in a row: a setting, a filter, a cut of a list. Same idiom, same
 * keyboard; `role="radiogroup"`, and no hairline of its own, because it sits
 * inside a form row rather than over a panel.
 */
export function SegmentedControl<T extends string>(props: StripProps<T>) {
  return <OptionStrip {...props} kind="radiogroup" rail={props.rail ?? false} size={props.size ?? "sm"} />;
}
