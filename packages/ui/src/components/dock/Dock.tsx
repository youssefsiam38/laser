"use client";
/**
 * The dock (docs/ux-panels.md "Four surfaces", D-20): the right side of the
 * thread, holding this session's islands. Minimal islands in a strip at the
 * top that wraps to a second row then folds into `+N`; at most two expanded
 * per column with a draggable divider; resizable by its left edge; two
 * columns past ~640px of dock or a 1600px window. The islands are absolutely
 * positioned children of one container so each is one element for life.
 */
import { Layers } from "lucide-react";
import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState, type KeyboardEvent, type PointerEvent } from "react";

import { StatusDot } from "@/components/status";
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover";
import { cn } from "@/lib/utils";
import { columnsFor, defaultDockWidth, DOCK_DEFAULT_WIDTH, DOCK_MIN_WIDTH, renderedSize, type DockState } from "@/panels/dock-state";
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

  // Islands that just appeared play the arrival once.
  useEffect(() => {
    const next = new Set<string>();
    for (const e of visible) if (!known.current.has(e.key)) next.add(e.key);
    for (const e of visible) known.current.add(e.key);
    if (next.size > 0) {
      setFresh(next);
      const t = setTimeout(() => setFresh(new Set()), 400);
      return () => clearTimeout(t);
    }
    return;
  }, [visible]);

  // Measure the body; columns follow the dock and the window (D-20).
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

  const onResizeStart = useCallback(
    (e: PointerEvent<HTMLDivElement>) => {
      const startX = e.clientX;
      const startWidth = aside.current?.getBoundingClientRect().width ?? dock.width;
      const max = Math.max(DOCK_MIN_WIDTH, Math.floor(window.innerWidth * 0.6));
      const target = e.currentTarget;
      target.setPointerCapture(e.pointerId);
      const move = (ev: globalThis.PointerEvent) => actions.setWidth(startWidth + (startX - ev.clientX), max);
      const up = () => {
        target.removeEventListener("pointermove", move);
        target.removeEventListener("pointerup", up);
        target.removeEventListener("pointercancel", up);
      };
      target.addEventListener("pointermove", move);
      target.addEventListener("pointerup", up);
      target.addEventListener("pointercancel", up);
    },
    [actions, dock.width],
  );

  const onResizeKey = (e: KeyboardEvent<HTMLDivElement>) => {
    const step = e.shiftKey ? 64 : 16;
    const max = Math.max(DOCK_MIN_WIDTH, Math.floor(window.innerWidth * 0.6));
    if (e.key === "ArrowLeft") actions.setWidth(dock.width + step, max);
    else if (e.key === "ArrowRight") actions.setWidth(dock.width - step, max);
    else return;
    e.preventDefault();
  };

  return (
    <aside
      ref={aside}
      aria-label="Panels"
      style={{ width: dock.width }}
      className={cn("relative flex h-full min-h-0 shrink-0 flex-col bg-bg hairline-l", className)}
    >
      <div
        role="separator"
        aria-orientation="vertical"
        aria-label="Resize the dock"
        aria-valuenow={dock.width}
        aria-valuemin={DOCK_MIN_WIDTH}
        tabIndex={0}
        onPointerDown={onResizeStart}
        onKeyDown={onResizeKey}
        className="absolute inset-y-0 -start-1 z-10 w-2 cursor-col-resize touch-none outline-none hover:bg-live/30 focus-visible:bg-live/40 [@media(pointer:coarse)]:-start-2 [@media(pointer:coarse)]:w-4"
      />
      <div ref={body} className="relative min-h-0 flex-1 overflow-y-auto overflow-x-hidden">
        <div className="relative" style={{ height: Math.max(size.height, layout.contentHeight) }}>
          {size.width > 0 &&
            visible.map((entry) => {
              const rect = layout.rects[entry.key];
              const island = dock.islands[entry.key];
              if (!rect || !island) return null;
              return (
                <Island
                  key={entry.key}
                  entry={entry}
                  size={renderedSize(dock, entry.key)}
                  rect={rect}
                  hidden={rect.hidden}
                  poppedOut={island.poppedOut}
                  frame="dock"
                  fresh={fresh.has(entry.key)}
                />
              );
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
      </div>
    </aside>
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
