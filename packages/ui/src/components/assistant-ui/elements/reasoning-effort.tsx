"use client";
/**
 * Reasoning effort — the composer's thinking-level control
 * (docs/ux-elements.md "Reasoning"). Installed from `elements-reasoning-effort`
 * and restyled to DESIGN.md tokens.
 *
 * Divergences from the registry copy, so a reviewer can diff them:
 *   - The seven Pi levels, `off` through `max`, not a demo trio. The labels
 *     are the levels' own names; the accessible name is the full word.
 *   - A `radiogroup` with roving focus and arrow keys, Home and End, not a
 *     row of `aria-pressed` buttons: one tab stop, every level reachable.
 *   - The "budget spent" progress bar is gone. Pi reports no thinking budget
 *     and no thinking token count per level, and a bar that cannot be filled
 *     is a fake (docs/ux-panels.md R3).
 *   - `ThinkingEffort` is the runtime-bound wrapper behind one compact
 *     popover at every width, so the composer never becomes a settings bar.
 *   - Only the levels the *open session's model* accepts are offered
 *     (`ModelCatalogEntry.thinkingLevels`; Pi maps the rest to null). A
 *     control appears only if it actually works here — and when a model does
 *     not reason at all the control is gone, with the reason in a tooltip
 *     where it would have been (docs/ux-panels.md R2).
 */
import type { ModelCatalogEntry, ThinkingLevel } from "@lasercode/protocol";
import { Brain } from "lucide-react";
import { useEffect, useMemo, useRef, useState, type ComponentProps, type KeyboardEvent } from "react";

import { Button } from "@/components/ui/button";
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";
import { cn } from "@/lib/utils";
import { useLaserStable, useSessionMeta } from "@/runtime";

import { field } from "./surfaces.js";

export interface EffortLevel {
  key: string;
  /** Short enough for a segment; the full name goes in `name`. */
  label: string;
  /** Accessible name; defaults to `label`. */
  name?: string;
}

export interface ReasoningEffortProps
  extends Omit<ComponentProps<"div">, "children" | "onSelect"> {
  levels: readonly EffortLevel[];
  selectedKey: string | undefined;
  onSelect?: ((key: string) => void) | undefined;
  disabled?: boolean | undefined;
  /** The group's accessible name. */
  label?: string | undefined;
}

export function ReasoningEffort({
  levels,
  selectedKey,
  onSelect,
  disabled = false,
  label = "Thinking level",
  className,
  ...props
}: ReasoningEffortProps) {
  const groupRef = useRef<HTMLDivElement>(null);
  const activeIndex = Math.max(
    0,
    levels.findIndex((level) => level.key === selectedKey),
  );

  const choose = (index: number) => {
    const level = levels[Math.max(0, Math.min(levels.length - 1, index))];
    if (!level || disabled) return;
    onSelect?.(level.key);
    groupRef.current
      ?.querySelectorAll<HTMLElement>('[role="radio"]')
      [levels.indexOf(level)]?.focus();
  };

  const onKeyDown = (event: KeyboardEvent<HTMLDivElement>) => {
    const last = levels.length - 1;
    let next: number | undefined;
    if (event.key === "ArrowRight" || event.key === "ArrowUp") next = Math.min(last, activeIndex + 1);
    else if (event.key === "ArrowLeft" || event.key === "ArrowDown") next = Math.max(0, activeIndex - 1);
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
      aria-label={label}
      aria-disabled={disabled || undefined}
      data-slot="reasoning-effort"
      onKeyDown={onKeyDown}
      className={cn(field, "flex h-7 items-center gap-0.5 rounded-full p-0.5", disabled && "opacity-50", className)}
      {...props}
    >
      {levels.map((level, index) => {
        const active = level.key === selectedKey;
        return (
          <button
            key={level.key}
            type="button"
            role="radio"
            aria-checked={active}
            aria-label={level.name ?? level.label}
            title={level.name ?? level.label}
            disabled={disabled}
            tabIndex={index === activeIndex ? 0 : -1}
            onClick={() => choose(index)}
            className={cn(
              "h-6 min-w-6 rounded-full px-2 text-xs leading-none font-medium tnum outline-none",
              "transition-[background-color,color] duration-(--motion-instant)",
              "focus-visible:outline-solid focus-visible:outline-2 focus-visible:outline-live",
              "disabled:cursor-not-allowed",
              active ? "bg-surface text-ink shadow-float-sm" : "text-ink-3 hover:text-ink-2",
            )}
          >
            {level.label}
          </button>
        );
      })}
    </div>
  );
}

// ---------------------------------------------------------------------------
// Pi's seven levels, bound to the open session
// ---------------------------------------------------------------------------

export const THINKING_LEVELS: readonly ThinkingLevel[] = ["off", "minimal", "low", "medium", "high", "xhigh", "max"];

/**
 * The project's model catalogue, fetched once per directory. Shared across
 * every mount so the composer and the regenerate menu ask the host once.
 */
const catalogCache = new Map<string, Promise<readonly ModelCatalogEntry[]>>();

/**
 * The levels the open session's model accepts, or `undefined` while that is
 * not known yet. Unknown means "offer everything": guessing a model has no
 * reasoning because a fetch is in flight would hide a working control.
 */
export function useSupportedThinkingLevels(): readonly ThinkingLevel[] | undefined {
  const { client } = useLaserStable();
  const { session, model } = useSessionMeta();
  const cwd = session?.cwd;
  const [catalog, setCatalog] = useState<readonly ModelCatalogEntry[]>();

  useEffect(() => {
    if (!cwd) {
      setCatalog(undefined);
      return;
    }
    let live = true;
    let pending = catalogCache.get(cwd);
    if (!pending) {
      pending = client.request("pi/models/catalog", { cwd }).then((r) => r.models);
      // A failed fetch must not poison the cache: the next mount retries.
      void pending.catch(() => catalogCache.delete(cwd));
      catalogCache.set(cwd, pending);
    }
    void pending.then(
      (models) => live && setCatalog(models),
      () => live && setCatalog(undefined),
    );
    return () => {
      live = false;
    };
  }, [client, cwd]);

  return useMemo(() => {
    if (!catalog || !model) return undefined;
    const entry = catalog.find((m) => m.provider === model.provider && m.id === model.id);
    return entry?.thinkingLevels;
  }, [catalog, model]);
}

const THINKING_EFFORTS: readonly EffortLevel[] = [
  { key: "off", label: "off" },
  { key: "minimal", label: "min", name: "minimal" },
  { key: "low", label: "low" },
  { key: "medium", label: "med", name: "medium" },
  { key: "high", label: "high" },
  { key: "xhigh", label: "xhigh", name: "extra high" },
  { key: "max", label: "max" },
];

/**
 * The composer's thinking control: a compact icon opens the full radiogroup.
 */
export function ThinkingEffort({ className }: { className?: string | undefined }) {
  const { actions } = useLaserStable();
  const { thinkingLevel, session, model } = useSessionMeta();
  const supported = useSupportedThinkingLevels();
  const disabled = !session;
  const select = (key: string) => void actions.setThinking(key as ThinkingLevel);
  const efforts = useMemo(
    () => (supported ? THINKING_EFFORTS.filter((e) => supported.includes(e.key as ThinkingLevel)) : THINKING_EFFORTS),
    [supported],
  );

  // The model does not reason: there is no level to pick, so there is no
  // control — only the reason, where the control would have been.
  if (supported && efforts.length <= 1) {
    return (
      <Tooltip>
        <TooltipTrigger asChild>
          <span
            data-slot="thinking-effort"
            tabIndex={0}
            role="note"
            aria-label={`${model?.name ?? model?.id ?? "This model"} does not reason, so there is no thinking level`}
            className={cn(
              "flex items-center rounded-md p-1 text-ink-3 outline-none",
              "focus-visible:outline-solid focus-visible:outline-2 focus-visible:outline-live",
              className,
            )}
          >
            <Brain aria-hidden="true" className="size-3.5" />
          </span>
        </TooltipTrigger>
        <TooltipContent side="top">{model?.name ?? model?.id ?? "This model"} does not reason — no thinking level to set.</TooltipContent>
      </Tooltip>
    );
  }

  return (
    <span data-slot="thinking-effort" className={cn("flex items-center", className)}>
      <Popover>
        <PopoverTrigger asChild>
          <Button
            variant="ghost"
            size="icon-sm"
            disabled={disabled}
            aria-label={`Thinking: ${thinkingLevel ?? "unset"}`}
            title={`Thinking: ${thinkingLevel ?? "unset"}`}
            className="text-ink-2 hover:text-ink"
          >
            <Brain aria-hidden="true" className="size-3.5 text-ink-3" />
          </Button>
        </PopoverTrigger>
        <PopoverContent align="end" side="top" className="w-auto max-w-[calc(100vw-2rem)]">
          <div className="mb-2 flex items-baseline justify-between gap-4">
            <span className="eyebrow">Thinking</span>
            <span className="typed text-ink-3">{thinkingLevel ?? "unset"}</span>
          </div>
          <ReasoningEffort levels={efforts} selectedKey={thinkingLevel} onSelect={select} disabled={disabled} className="max-w-full" />
        </PopoverContent>
      </Popover>
    </span>
  );
}
