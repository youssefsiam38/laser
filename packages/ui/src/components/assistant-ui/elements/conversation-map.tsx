"use client";
/**
 * Conversation map (`conversation-map`, props-driven): a rail of ticks, one
 * per turn, that shows where you are in a long transcript and jumps on click.
 * Hovering or focusing a tick shows the turn's title and a preview.
 *
 * Divergences from the registry copy: the preview card is Radix `HoverCard`
 * (the registry's Base UI `PreviewCard` would add a dependency for one
 * popover), tick colours are `--ink` / `--ink-3` / `--line`, and every
 * transition reads a motion token.
 */
import { HoverCard } from "radix-ui";
import { useCallback, useRef, useState, type ComponentProps, type KeyboardEvent } from "react";

import { clamp } from "@/components/assistant-ui/utils/range";
import { cn } from "@/lib/utils";
import { useDirection, useLogicalArrowKeys } from "@/hooks/use-direction";
import { logicalSide } from "@/theme/direction";

import { floating } from "./surfaces.js";

export interface ConversationMapEntry {
  id: string;
  title: string;
  preview?: string;
}

const TICK = '[data-slot="conversation-map-tick"]';

export interface ConversationMapProps extends Omit<ComponentProps<"nav">, "children" | "onSelect"> {
  entries: readonly ConversationMapEntry[];
  activeId?: string | undefined;
  visibleIds?: readonly string[] | undefined;
  onSelect?: ((id: string) => void) | undefined;
  /** Which side the preview card opens on. */
  side?: "left" | "right";
}

export function ConversationMap({ entries, activeId, visibleIds, onSelect, side = "right", className, onKeyDown, ...props }: ConversationMapProps) {
  const direction = useDirection();
  const logicalKey = useLogicalArrowKeys();
  const railRef = useRef<HTMLElement>(null);
  const [focusedIndex, setFocusedIndex] = useState<number | null>(null);

  const inView = new Set(visibleIds);
  const activeIndex = entries.findIndex((entry) => entry.id === activeId);
  const tabbableIndex = clamp(focusedIndex ?? Math.max(0, activeIndex), 0, Math.max(0, entries.length - 1));

  const handleKeyDown = useCallback(
    (event: KeyboardEvent<HTMLElement>) => {
      onKeyDown?.(event);
      if (event.defaultPrevented) return;
      const ticks = railRef.current?.querySelectorAll<HTMLElement>(TICK);
      if (!ticks?.length) return;
      const current = Array.prototype.indexOf.call(ticks, event.target);
      if (current === -1) return;
      const next = { ArrowUp: current - 1, ArrowDown: current + 1, ArrowLeft: current - 1, ArrowRight: current + 1, Home: 0, End: ticks.length - 1 }[logicalKey(event.key)];
      if (next === undefined) return;
      event.preventDefault();
      ticks[clamp(next, 0, ticks.length - 1)]?.focus();
    },
    [onKeyDown, logicalKey],
  );

  return (
    <nav
      data-slot="conversation-map"
      ref={railRef}
      aria-label="Conversation map"
      onKeyDown={handleKeyDown}
      className={cn("group/rail flex h-full w-6 flex-col justify-center", className)}
      {...props}
    >
      {entries.map((entry, index) => {
        const current = index === activeIndex;
        const onScreen = current || inView.has(entry.id);
        return (
          <HoverCard.Root key={entry.id} openDelay={120} closeDelay={80}>
            <HoverCard.Trigger asChild>
              <button
                type="button"
                data-slot="conversation-map-tick"
                data-active={current ? "" : undefined}
                data-in-view={onScreen ? "" : undefined}
                aria-label={entry.title}
                aria-current={current ? "true" : undefined}
                tabIndex={index === tabbableIndex ? 0 : -1}
                onFocus={() => setFocusedIndex(index)}
                onClick={() => onSelect?.(entry.id)}
                // The cap keeps a short thread packed instead of spread over the
                // whole gutter; a long one outgrows it and the share decides.
                className="group flex max-h-3.5 min-h-0 flex-1 items-center outline-none"
              >
                <span
                  className={cn(
                    "w-3 rounded-full transition-[width,height,background-color] duration-(--motion-fast) ease-morph motion-reduce:transition-none",
                    current
                      ? "h-0.75 bg-ink group-focus-within/rail:w-6 group-hover/rail:w-6"
                      : cn(
                          "h-0.5 group-hover:bg-ink-2 group-focus-visible:bg-ink-2 group-hover:w-6! group-focus-visible:w-6!",
                          onScreen ? "bg-ink-3 group-focus-within/rail:w-4.5 group-hover/rail:w-4.5" : "bg-line",
                        ),
                  )}
                />
              </button>
            </HoverCard.Trigger>
            <HoverCard.Portal>
              <HoverCard.Content
                side={logicalSide(side, direction)}
                dir={direction}
                sideOffset={10}
                collisionPadding={8}
                className={cn(
                  floating,
                  "z-50 w-60 origin-(--radix-hover-card-content-transform-origin) rounded-xl p-3 outline-none",
                  "animate-in fade-in-0 zoom-in-95 duration-(--motion-fast) data-[state=closed]:animate-out data-[state=closed]:fade-out-0 motion-reduce:animate-none",
                )}
              >
                <p className="line-clamp-2 text-sm leading-snug font-medium text-ink">{entry.title}</p>
                {entry.preview ? <p className="mt-1 line-clamp-3 text-sm text-ink-2">{entry.preview}</p> : null}
              </HoverCard.Content>
            </HoverCard.Portal>
          </HoverCard.Root>
        );
      })}
    </nav>
  );
}
