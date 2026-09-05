import type { ThinkingLevel } from "@piorbit/protocol";
import { Brain } from "lucide-react";
import { useRef, type KeyboardEvent } from "react";

import { Button } from "@/components/ui/button";
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";
import { cn } from "@/lib/utils";
import { usePiorbitStable, useSessionMeta } from "@/runtime";

export const THINKING_LEVELS: readonly ThinkingLevel[] = ["off", "minimal", "low", "medium", "high", "xhigh", "max"];

/** Tick heights on the 4px grid: 4 → 16px. */
const HEIGHTS = [4, 6, 8, 10, 12, 14, 16] as const;

/**
 * Seven-level thinking picker as a compact bar graph: a `radiogroup` whose
 * ticks grow with the level, the active one in `--live`. Arrow keys, Home and
 * End move the selection; each tick names itself in a tooltip; the current
 * level reads out in typed text beside it.
 */
export function ThinkingSlider({ className }: { className?: string | undefined }) {
  const { actions } = usePiorbitStable();
  const { thinkingLevel, session } = useSessionMeta();
  const groupRef = useRef<HTMLDivElement>(null);
  const activeIndex = thinkingLevel ? THINKING_LEVELS.indexOf(thinkingLevel) : -1;
  const disabled = !session;

  const choose = (index: number) => {
    const level = THINKING_LEVELS[Math.max(0, Math.min(THINKING_LEVELS.length - 1, index))];
    if (!level || disabled) return;
    void actions.setThinking(level);
    groupRef.current?.querySelectorAll<HTMLElement>('[role="radio"]')[THINKING_LEVELS.indexOf(level)]?.focus();
  };

  const onKeyDown = (e: KeyboardEvent<HTMLDivElement>) => {
    const last = THINKING_LEVELS.length - 1;
    let next: number | undefined;
    if (e.key === "ArrowRight" || e.key === "ArrowUp") next = Math.min(last, activeIndex + 1);
    else if (e.key === "ArrowLeft" || e.key === "ArrowDown") next = Math.max(0, activeIndex - 1);
    else if (e.key === "Home") next = 0;
    else if (e.key === "End") next = last;
    if (next === undefined) return;
    e.preventDefault();
    choose(next);
  };

  return (
    <div className={cn("flex items-center gap-2", disabled && "opacity-50", className)}>
      <div
        ref={groupRef}
        role="radiogroup"
        aria-label="Thinking level"
        aria-disabled={disabled || undefined}
        onKeyDown={onKeyDown}
        className="flex h-7 items-end gap-px px-1"
      >
        {THINKING_LEVELS.map((level, i) => {
          const active = i === activeIndex;
          const filled = i <= activeIndex;
          return (
            <Tooltip key={level} disableHoverableContent>
              <TooltipTrigger asChild>
                <button
                  type="button"
                  role="radio"
                  aria-checked={active}
                  aria-label={level}
                  disabled={disabled}
                  tabIndex={i === Math.max(activeIndex, 0) ? 0 : -1}
                  onClick={() => choose(i)}
                  className="group/tick flex h-7 w-2.5 items-end justify-center rounded-sm outline-none focus-visible:outline-solid focus-visible:outline-2 focus-visible:outline-offset-1 focus-visible:outline-live disabled:cursor-not-allowed"
                >
                  <span
                    aria-hidden="true"
                    style={{ height: HEIGHTS[i] }}
                    className={cn(
                      "w-0.5 rounded-full transition-[background-color] duration-75",
                      active ? "bg-live" : filled ? "bg-ink-2" : "bg-line group-hover/tick:bg-ink-3",
                    )}
                  />
                </button>
              </TooltipTrigger>
              <TooltipContent side="top" sideOffset={4}>
                Thinking: {level}
              </TooltipContent>
            </Tooltip>
          );
        })}
      </div>
      <span className="typed w-12 text-ink-2" aria-hidden="true">
        {thinkingLevel ?? "—"}
      </span>
    </div>
  );
}

/**
 * Phone-sized fallback: the seven ticks do not fit next to the model selector,
 * so the same radiogroup lives in a popover behind a Brain trigger. Without
 * this the thinking level is unreachable below `sm` (DESIGN.md "Composer").
 */
export function ThinkingButton({ className }: { className?: string | undefined }) {
  const { thinkingLevel, session } = useSessionMeta();
  return (
    <Popover>
      <PopoverTrigger asChild>
        <Button
          variant="ghost"
          size="sm"
          disabled={!session}
          aria-label={`Thinking: ${thinkingLevel ?? "unset"}`}
          className={cn("typed gap-1.5 text-ink-2 hover:text-ink", className)}
        >
          <Brain aria-hidden="true" className="size-3.5 text-ink-3" />
          <span>{thinkingLevel ?? "—"}</span>
        </Button>
      </PopoverTrigger>
      <PopoverContent align="end" side="top" className="w-auto">
        <span className="eyebrow">Thinking</span>
        <ThinkingSlider />
      </PopoverContent>
    </Popover>
  );
}
