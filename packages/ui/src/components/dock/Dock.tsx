"use client";
/**
 * The dock (docs/ux-panels.md "Four surfaces", D-20): the right side of the
 * thread, holding this session's islands. Minimal islands in a strip at the
 * top that wraps to a second row then folds into `+N`; one expanded panel
 * fills it, two form full-width rows, and three or four form a 2×2 grid when
 * the dock is wide enough. The dock is resizable by its left edge. Islands
 * are absolutely positioned children of one container so each remains one
 * element for life while its rectangle morphs.
 *
 * The frame — the pane and its resize divider — is the catalog's canvas-split
 * element (`components/assistant-ui/elements/canvas-split.tsx`); this file is
 * the layout engine inside it.
 */
import {
  DndContext,
  KeyboardSensor,
  PointerSensor,
  TouchSensor,
  closestCenter,
  useSensor,
  useSensors,
  type DragEndEvent,
} from "@dnd-kit/core";
import { SortableContext, rectSortingStrategy, sortableKeyboardCoordinates, useSortable } from "@dnd-kit/sortable";
import { CSS } from "@dnd-kit/utilities";
import { Layers } from "lucide-react";
import {
  useCallback,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  type ComponentProps,
  type CSSProperties,
  type KeyboardEvent,
  type PointerEvent,
} from "react";

import { CanvasSplitDivider, CanvasSplitPane } from "@/components/assistant-ui/elements/canvas-split";
import { StatusDot } from "@/components/status";
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover";
import { cn } from "@/lib/utils";
import { motionMs } from "@/motion";
import { columnsFor, DOCK_MIN_WIDTH, renderedSize, type DockState } from "@/panels/dock-state";
import { Island } from "@/panels/islands/Island";
import { dividerRatio, layoutDock, type DockLayout } from "@/panels/layout";
import { useDock, useIslandEntries, usePanelActions, usePanelsState } from "@/panels/PanelsProvider";
import { attentionOfEntry, openDecisionIds, type PanelEntry } from "@/panels/store";
import { accessibleSummary, liveValues } from "@/panels/values";
import { useTick } from "@/components/thread/timing";

export interface DockProps {
  /** Session whose islands the dock shows. */
  path: string | undefined;
  className?: string | undefined;
}

/** Nothing to show → nothing rendered. There is no empty dock. */
export function useDockHasIslands(path: string | undefined): boolean {
  const entries = useIslandEntries(path, "desktop");
  const dock = useDock(path);
  return entries.some((e) => !dock.dismissed.includes(e.key));
}

export function Dock({ path, className }: DockProps) {
  const dock = useDock(path);
  const entries = useIslandEntries(path, "desktop");
  const visible = useMemo(() => entries.filter((e) => !dock.dismissed.includes(e.key)), [entries, dock.dismissed]);
  // Nothing to show → nothing rendered. The frame below mounts with its
  // measurements when the first island arrives.
  if (!path || visible.length === 0 || dock.hidden) return null;
  return <DockFrame path={path} dock={dock} visible={visible} className={className} />;
}

function DockFrame({ path, dock, visible, className }: { path: string; dock: DockState; visible: PanelEntry[]; className?: string | undefined }) {
  const actions = usePanelActions();
  const body = useRef<HTMLDivElement>(null);
  const aside = useRef<HTMLElement>(null);
  const [size, setSize] = useState({ width: 0, height: 0 });
  const [fresh, setFresh] = useState<ReadonlySet<string>>(() => new Set());
  const known = useRef(new Set<string>());
  const sensors = useSensors(
    useSensor(PointerSensor, { activationConstraint: { distance: 6 } }),
    useSensor(TouchSensor, { activationConstraint: { delay: 180, tolerance: 8 } }),
    useSensor(KeyboardSensor, { coordinateGetter: sortableKeyboardCoordinates }),
  );

  // Islands that just appeared play the arrival once.
  useEffect(() => {
    const next = new Set<string>();
    for (const e of visible) if (!known.current.has(e.key)) next.add(e.key);
    for (const e of visible) known.current.add(e.key);
    if (next.size > 0) {
      setFresh(next);
      // The arrival is one morph plus a beat, read from the tokens rather
      // than a constant, so it stays in step with the Motion setting (T1).
      const t = setTimeout(() => setFresh(new Set()), motionMs("--motion-morph") + motionMs("--motion-slow"));
      return () => clearTimeout(t);
    }
    return;
  }, [visible]);

  // Measure the body; readable column capacity follows the dock width. The
  // layout engine activates the second column only when occupancy needs it.
  useLayoutEffect(() => {
    const el = body.current;
    if (!el) return;
    const measure = () => {
      const r = el.getBoundingClientRect();
      setSize((s) => (s.width === r.width && s.height === r.height ? s : { width: r.width, height: r.height }));
      actions.setColumns(path, columnsFor(r.width));
    };
    measure();
    const ro = new ResizeObserver(measure);
    ro.observe(el);
    window.addEventListener("resize", measure);
    return () => {
      ro.disconnect();
      window.removeEventListener("resize", measure);
    };
  }, [actions, path]);

  const layout: DockLayout = useMemo(() => layoutDock(dock, size.width, size.height), [dock, size.width, size.height]);
  const sortableKeys = useMemo(
    () => visible.map((entry) => entry.key).filter((key) => layout.rects[key] && !layout.rects[key]!.hidden),
    [layout.rects, visible],
  );
  const reorder = useCallback(
    ({ active, over }: DragEndEvent) => {
      if (!over || active.id === over.id) return;
      actions.reorder(path, String(active.id), String(over.id));
    },
    [actions, path],
  );

  // Esc restores a maximized island wherever focus is.
  useEffect(() => {
    if (!dock.maximized) return;
    const onKey = (e: globalThis.KeyboardEvent) => {
      if (e.key !== "Escape" || e.defaultPrevented) return;
      e.preventDefault();
      actions.restore(path);
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [actions, dock.maximized, path]);

  const maxWidth = () => Math.max(DOCK_MIN_WIDTH, Math.floor(window.innerWidth * 0.6));

  return (
    <CanvasSplitPane ref={aside} aria-label="Panels" width={dock.width} className={className}>
      <CanvasSplitDivider
        width={dock.width}
        min={DOCK_MIN_WIDTH}
        max={maxWidth()}
        measure={() => aside.current?.getBoundingClientRect().width ?? dock.width}
        onChange={(width) => actions.setWidth(width, maxWidth())}
      />
      <div ref={body} className="relative min-h-0 flex-1 overflow-y-auto overflow-x-hidden">
        <DndContext sensors={sensors} collisionDetection={closestCenter} onDragEnd={reorder}>
          <SortableContext items={sortableKeys} strategy={rectSortingStrategy}>
            <div className="relative" style={{ height: Math.max(size.height, layout.contentHeight) }}>
              {size.width > 0 &&
                visible.map((entry) => {
                  const rect = layout.rects[entry.key];
                  const island = dock.islands[entry.key];
                  if (!rect || !island) return null;
                  const props = {
                    entry,
                    size: renderedSize(dock, entry.key),
                    rect,
                    hidden: rect.hidden,
                    poppedOut: island.poppedOut,
                    frame: "dock" as const,
                    fresh: fresh.has(entry.key),
                  };
                  return rect.hidden ? <Island key={entry.key} {...props} /> : <SortableDockIsland key={entry.key} {...props} />;
                })}
              {size.width > 0 && layout.overflowRect && layout.overflow.length > 0 && (
                <OverflowIsland rect={layout.overflowRect} keys={layout.overflow} entries={visible} path={path} />
              )}
              {layout.dividers.map((d) => (
                <Divider
                  key={`${d.column}-${d.keys.join("|")}`}
                  column={d.column}
                  rect={d.rect}
                  path={path}
                  ratio={dock.dividers[d.column] ?? 0.5}
                  regionTop={layout.rects[d.keys[0]]?.top ?? d.rect.top}
                  regionHeight={(layout.rects[d.keys[1]]?.top ?? 0) + (layout.rects[d.keys[1]]?.height ?? 0) - (layout.rects[d.keys[0]]?.top ?? 0)}
                />
              ))}
            </div>
          </SortableContext>
        </DndContext>
      </div>
    </CanvasSplitPane>
  );
}

function SortableDockIsland(props: ComponentProps<typeof Island>) {
  const { attributes, listeners, setNodeRef, transform, isDragging } = useSortable({ id: props.entry.key });
  const dragStyle: CSSProperties | undefined = transform
    ? { transform: CSS.Transform.toString(transform) }
    : undefined;
  return (
    <Island
      {...props}
      dragNodeRef={setNodeRef}
      dragHandleProps={{ ...attributes, ...listeners }}
      dragStyle={dragStyle}
      dragging={isDragging}
    />
  );
}

// ---------------------------------------------------------------------------
// Pieces
// ---------------------------------------------------------------------------

/** The split handle. 44px of grab area on a coarse pointer around an 8px bar (R13). */
function Divider({ column, rect, path, ratio, regionTop, regionHeight }: { column: 0 | 1; rect: DockLayout["dividers"][number]["rect"]; path: string; ratio: number; regionTop: number; regionHeight: number }) {
  const actions = usePanelActions();
  const onPointerDown = (e: PointerEvent<HTMLDivElement>) => {
    const target = e.currentTarget;
    const container = target.parentElement;
    if (!container) return;
    target.setPointerCapture(e.pointerId);
    const move = (ev: globalThis.PointerEvent) => {
      const top = container.getBoundingClientRect().top;
      actions.setDivider(path, column, dividerRatio(ev.clientY - top, regionTop, regionHeight));
    };
    const up = () => {
      target.removeEventListener("pointermove", move);
      target.removeEventListener("pointerup", up);
      target.removeEventListener("pointercancel", up);
    };
    target.addEventListener("pointermove", move);
    target.addEventListener("pointerup", up);
    target.addEventListener("pointercancel", up);
  };
  const onKeyDown = (e: KeyboardEvent<HTMLDivElement>) => {
    const step = e.shiftKey ? 0.1 : 0.03;
    if (e.key === "ArrowUp") actions.setDivider(path, column, ratio - step);
    else if (e.key === "ArrowDown") actions.setDivider(path, column, ratio + step);
    else if (e.key === "Home") actions.setDivider(path, column, 0.5);
    else return;
    e.preventDefault();
  };
  return (
    <div
      role="separator"
      aria-orientation="horizontal"
      aria-label="Resize the split"
      aria-valuenow={Math.round(ratio * 100)}
      aria-valuemin={15}
      aria-valuemax={85}
      tabIndex={0}
      onPointerDown={onPointerDown}
      onKeyDown={onKeyDown}
      onDoubleClick={() => actions.setDivider(path, column, 0.5)}
      style={{ top: rect.top, left: rect.left, width: rect.width, height: rect.height }}
      className="group/divider absolute z-10 flex cursor-row-resize touch-none items-center justify-center outline-none [@media(pointer:coarse)]:before:absolute [@media(pointer:coarse)]:before:-inset-y-5 [@media(pointer:coarse)]:before:inset-x-0 [@media(pointer:coarse)]:before:content-['']"
    >
      <span aria-hidden="true" className="h-1 w-8 rounded-full bg-line transition-colors duration-(--motion-instant) group-hover/divider:bg-ink-3 group-focus-visible/divider:bg-live" />
    </div>
  );
}

/** The `+N` island: opens the full list; each row is a live minimal reading. */
function OverflowIsland({ rect, keys, entries, path }: { rect: DockLayout["overflowRect"] & object; keys: readonly string[]; entries: readonly PanelEntry[]; path: string }) {
  const actions = usePanelActions();
  const [open, setOpen] = useState(false);
  const decisions = usePanelsState((r) => openDecisionIds(r.panels), (a, b) => a.size === b.size && [...a].every((x) => b.has(x)));
  const hidden = keys.map((k) => entries.find((e) => e.key === k)).filter((e): e is PanelEntry => e !== undefined);
  const worst = hidden.map((e) => attentionOfEntry(e, decisions)).sort((a, b) => rank(a) - rank(b))[0] ?? "idle";
  useTick(open, 1000);
  const now = Date.now();
  return (
    <Popover open={open} onOpenChange={setOpen}>
      <PopoverTrigger asChild>
        <button
          type="button"
          style={{ top: rect.top, left: rect.left, width: rect.width, height: rect.height }}
          aria-label={`${hidden.length} more panels`}
          className="absolute flex items-center gap-2 rounded-full border border-line bg-surface px-2.5 text-start outline-none transition-colors duration-(--motion-instant) hover:bg-surface-2 active:bg-[color-mix(in_oklab,var(--surface-2)_80%,var(--ink))] focus-visible:outline-solid focus-visible:outline-2 focus-visible:-outline-offset-2 focus-visible:outline-live [@media(pointer:coarse)]:after:absolute [@media(pointer:coarse)]:after:-inset-y-2 [@media(pointer:coarse)]:after:inset-x-0 [@media(pointer:coarse)]:after:content-['']"
        >
          <Layers className="size-3.5 shrink-0 text-ink-3" aria-hidden="true" />
          <span className="min-w-0 flex-1 truncate text-xs font-medium text-ink">+{hidden.length} more</span>
          <StatusDot status={worst} size="sm" />
        </button>
      </PopoverTrigger>
      <PopoverContent align="start" className="w-80 gap-1 p-1.5">
        <ul role="list" className="flex flex-col">
          {hidden.map((entry) => {
            const values = liveValues(entry, now);
            const value = values[0];
            return (
              <li key={entry.key}>
                <button
                  type="button"
                  onClick={() => {
                    setOpen(false);
                    actions.setSize(path, entry.key, "expanded");
                  }}
                  aria-label={accessibleSummary(entry.panel.title, values)}
                  className="flex h-9 w-full items-center gap-2 rounded-md px-2 text-start outline-none transition-colors duration-(--motion-instant) hover:bg-surface-2 active:bg-[color-mix(in_oklab,var(--surface-2)_80%,var(--ink))] focus-visible:outline-solid focus-visible:outline-2 focus-visible:-outline-offset-2 focus-visible:outline-live"
                >
                  <StatusDot status={attentionOfEntry(entry, decisions)} size="sm" />
                  <span className="min-w-0 flex-1 truncate text-sm text-ink">{entry.panel.title}</span>
                  {value && <span className="typed shrink-0 text-ink-2">{value.text}</span>}
                </button>
              </li>
            );
          })}
        </ul>
      </PopoverContent>
    </Popover>
  );
}

const RANK = { waiting_for_input: 0, error: 1, finished_unread: 2, working: 3, idle: 4 } as const;
const rank = (a: keyof typeof RANK): number => RANK[a];
