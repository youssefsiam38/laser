"use client";
/** Registry conversation map, sampled to the rail's pixel budget. One preview,
 * one keyboard stop; every canonical turn remains addressable, not just ticks. */
import { HoverCard } from "radix-ui";
import { useLayoutEffect, useRef, useState, type ComponentProps } from "react";
import { clamp } from "@/components/assistant-ui/utils/range";
import { cn } from "@/lib/utils";
import { useDirection, useLogicalArrowKeys } from "@/hooks/use-direction";
import { logicalSide } from "@/theme/direction";
import { floating } from "./surfaces.js";

export interface ConversationMapEntry { id: string; title: string; preview?: string }
export interface ConversationMapProps extends Omit<ComponentProps<"nav">, "children" | "onSelect"> {
  entries: readonly ConversationMapEntry[];
  activeId?: string | undefined;
  visibleIds?: readonly string[] | undefined;
  onSelect?: ((id: string) => void) | undefined;
  side?: "left" | "right";
}
export function ConversationMap({ entries, activeId, visibleIds, onSelect, side = "right", className, onKeyDown, ...props }: ConversationMapProps) {
  const direction = useDirection(), logicalKey = useLogicalArrowKeys();
  const rail = useRef<HTMLElement>(null);
  const [capacity, setCapacity] = useState(1);
  const [selected, setSelected] = useState<number | undefined>(undefined);
  const [open, setOpen] = useState(false);
  const active = Math.max(0, entries.findIndex(e => e.id === activeId));
  const index = clamp(selected ?? active, 0, Math.max(0, entries.length - 1));
  const entry = entries[index];
  const visible = new Set(visibleIds);
  useLayoutEffect(() => {
    const node = rail.current;
    if (!node) return;
    const measure = () => {
      const css = getComputedStyle(node);
      const spacing = Number.parseFloat(css.width) / 6 || Number.parseFloat(css.fontSize) / 4;
      setCapacity(Math.max(1, Math.floor(node.clientHeight / spacing)));
    };
    measure(); const observer = new ResizeObserver(measure); observer.observe(node);
    return () => observer.disconnect();
  }, []);
  const count = Math.min(entries.length, capacity);
  const pointerIndex = (y: number) => {
    const rect = rail.current!.getBoundingClientRect();
    return clamp(Math.floor((y - rect.top) / rect.height * entries.length), 0, entries.length - 1);
  };
  if (!entry) return null;
  return <nav ref={rail} data-slot="conversation-map" aria-label="Conversation map" className={cn("group/rail flex h-full w-6 flex-col justify-center [@media(pointer:coarse)]:min-w-11", className)} {...props} onKeyDown={onKeyDown}>
    <HoverCard.Root open={open} onOpenChange={setOpen} openDelay={120} closeDelay={80}>
      <HoverCard.Trigger asChild>
        <button type="button" role="slider" aria-label={`Conversation map: ${entry.title}`} aria-valuemin={1} aria-valuemax={entries.length} aria-valuenow={index + 1} aria-valuetext={`Turn ${index + 1} of ${entries.length}: ${entry.title}`}
          data-slot="conversation-map-control" className="flex h-full w-full flex-col justify-center outline-none focus-visible:outline-solid focus-visible:outline-2 focus-visible:outline-live"
          onFocus={() => setOpen(true)} onBlur={() => { setOpen(false); setSelected(undefined); }}
          onPointerMove={e => { setSelected(pointerIndex(e.clientY)); setOpen(true); }}
          onPointerLeave={() => { setOpen(false); }}
          onClick={e => { const next = e.detail ? pointerIndex(e.clientY) : index; setSelected(next); onSelect?.(entries[next]!.id); }}
          onKeyDown={e => {
            const next = { ArrowUp: index - 1, ArrowDown: index + 1, ArrowLeft: index - 1, ArrowRight: index + 1, Home: 0, End: entries.length - 1 }[logicalKey(e.key)];
            if (next !== undefined) { e.preventDefault(); setSelected(clamp(next, 0, entries.length - 1)); setOpen(true); }
          }}>
          {Array.from({ length: count }, (_, tick) => {
            const start = Math.floor(tick * entries.length / count), end = Math.ceil((tick + 1) * entries.length / count);
            const current = active >= start && active < end;
            const inView = current || entries.slice(start, end).some(e => visible.has(e.id));
            return <span key={tick} data-slot="conversation-map-tick" aria-hidden="true" data-active={current ? "" : undefined} data-in-view={inView ? "" : undefined} className="flex max-h-3.5 min-h-0 flex-1 items-center">
              <span className={cn("w-3 rounded-full transition-[width,background-color] duration-(--motion-fast) motion-reduce:transition-none", current ? "h-0.75 bg-ink group-hover/rail:w-6" : inView ? "h-0.5 bg-ink-3" : "h-0.5 bg-line")} />
            </span>;
          })}
        </button>
      </HoverCard.Trigger>
      <HoverCard.Portal><HoverCard.Content side={logicalSide(side, direction)} dir={direction} sideOffset={10} collisionPadding={8}
        className={cn(floating, "z-50 w-60 rounded-xl p-3 outline-none",
          "animate-in fade-in-0 zoom-in-95 duration-(--motion-fast) data-[state=closed]:animate-out data-[state=closed]:fade-out-0 motion-reduce:animate-none")}>
        <p className="line-clamp-2 text-sm leading-snug font-medium text-ink">{entry.title}</p>
        {entry.preview && <p className="mt-1 line-clamp-3 text-sm text-ink-2">{entry.preview}</p>}
      </HoverCard.Content></HoverCard.Portal>
    </HoverCard.Root>
  </nav>;
}
