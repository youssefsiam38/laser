"use client";
/**
 * The run tree, as a strip under the top bar (docs/ux-agent-work.md
 * "Navigating runs").
 *
 * Desktop: a horizontal tab strip showing **exactly one level** — the children
 * of whatever is focused — up to five, then a `+N` chip. Each tab is a status
 * dot, the agent's name and its elapsed time. A tab with children of its own
 * carries a drill-in chevron; the tab body reveals the run in the dock, the
 * chevron makes it the trunk. Depth never lives in the strip: it lives in the
 * breadcrumb to the left of it, which is the whole reason this is not a tree
 * with expand arrows (R5).
 *
 * Phone: two axes do not fit, so the strip becomes the breadcrumb alone plus
 * one chip that says how many runs this level holds; tapping either opens that
 * level as a sheet. Same data model, one axis.
 *
 * The strip renders nothing at all when the session has no runs — no empty
 * bar, no placeholder row.
 */
import { ChevronRight, ChevronLeft, Layers } from "lucide-react";
import { useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";

import { StatusDot } from "@/components/status";
import { Sheet, SheetContent, SheetDescription, SheetTitle } from "@/components/ui/sheet";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { useIsMobile } from "@/hooks/use-mobile";
import { cn } from "@/lib/utils";
import { formatElapsed, openDecisionIds, usePanelActions, usePanelEntries, usePanelsState } from "@/panels";
import { useTick } from "@/components/thread/timing";
import { usePiorbitView } from "@/runtime";

import { openFleet } from "./fleet.js";
import {
  MAX_TABS,
  buildRunTree,
  overflowAttention,
  reconcileFocus,
  tabsFor,
  type RunNode,
  type RunTree,
} from "./run-tree.js";

/**
 * The narrowest a tab may be and still say something: a dot, about a dozen
 * characters of name, and an elapsed clock. Below that the strip shows *fewer*
 * tabs rather than narrower ones — shrink by dropping content, never by
 * shrinking type (R13). The dock takes 360px out of the thread column, so this
 * is the common case, not the edge case.
 */
const TAB_MIN_PX = 176;
/** Room the `+N` chip needs once there is anything to overflow. */
const OVERFLOW_PX = 52;

/** How many tabs fit right now. Measured, because the thread column moves. */
function useVisibleTabs(ref: React.RefObject<HTMLDivElement | null>, total: number): number {
  const [width, setWidth] = useState(0);
  useLayoutEffect(() => {
    const element = ref.current;
    if (!element || typeof ResizeObserver === "undefined") return;
    setWidth(element.clientWidth);
    const observer = new ResizeObserver(([entry]) => setWidth(entry?.contentRect.width ?? 0));
    observer.observe(element);
    return () => observer.disconnect();
  }, [ref]);
  if (width === 0) return Math.min(total, MAX_TABS);
  const room = total > MAX_TABS ? width - OVERFLOW_PX : width;
  const fits = Math.floor(room / TAB_MIN_PX);
  // Always at least one: a strip with a single legible tab and a +N chip is
  // more use than a row of two-letter stubs.
  return Math.max(1, Math.min(MAX_TABS, fits));
}

/**
 * Reveal a run: expand its island in the dock on a pointer-sized screen, open
 * the fleet sheet at that run on a phone. One verb, two rooms.
 */
function useReveal(mobile: boolean): (node: RunNode) => void {
  const actions = usePanelActions();
  return (node: RunNode) => {
    actions.markSeen(node.key);
    if (mobile) {
      openFleet(node.id);
      return;
    }
    actions.setSize(node.entry.path, node.key, "expanded");
    actions.watched(node.entry.path, node.key);
  };
}

export function RunTabs() {
  const view = usePiorbitView();
  const mobile = useIsMobile();
  const entries = usePanelEntries(view?.path);
  const decisions = usePanelsState((r) => openDecisionIds(r.panels), (a, b) => a.size === b.size && [...a].every((x) => b.has(x)));
  const [focusedId, setFocusedId] = useState<string | undefined>(undefined);
  const trailRef = useRef<string[]>([]);

  const anyRunning = entries.some((e) => !e.closed && e.panel.kind === "run" && (e.panel.lifecycle === "running" || e.panel.lifecycle === "queued"));
  useTick(anyRunning, 1000);

  const tree = useMemo(() => buildRunTree(entries, decisions, Date.now()), [entries, decisions]);
  const row = useMemo(() => tabsFor(tree, focusedId), [tree, focusedId]);
  const reveal = useReveal(mobile);

  // A focused run that gets pruned hands focus to its nearest surviving
  // ancestor, never sideways to a sibling: jumping sideways loses your place.
  useEffect(() => {
    const next = reconcileFocus(tree, focusedId, trailRef.current);
    if (next !== focusedId) setFocusedId(next);
    trailRef.current = [...row.trail.map((n) => n.id), ...(row.focused ? [row.focused.id] : [])];
  }, [tree, focusedId, row.trail, row.focused]);

  if (!view || tree.roots.length === 0) return null;

  return mobile ? (
    <MobileStrip tree={tree} row={row} onFocus={setFocusedId} />
  ) : (
    <DesktopStrip tree={tree} row={row} onFocus={setFocusedId} onReveal={reveal} />
  );
}

interface StripProps {
  tree: RunTree;
  row: ReturnType<typeof tabsFor>;
  onFocus(id: string | undefined): void;
}

// ---------------------------------------------------------------------------
// Desktop
// ---------------------------------------------------------------------------

function DesktopStrip({ tree, row: full, onFocus, onReveal }: StripProps & { onReveal(node: RunNode): void }) {
  const listRef = useRef<HTMLDivElement>(null);
  const level = [...full.tabs, ...full.overflow];
  const visible = useVisibleTabs(listRef, level.length);
  const row = { ...full, tabs: level.slice(0, visible), overflow: level.slice(visible) };

  // Roving focus: the strip is one tab stop, arrows move within it.
  const onKeyDown = (event: React.KeyboardEvent<HTMLDivElement>): void => {
    if (event.key !== "ArrowRight" && event.key !== "ArrowLeft") return;
    const buttons = [...(listRef.current?.querySelectorAll<HTMLButtonElement>('[data-run-tab="true"]') ?? [])];
    const index = buttons.findIndex((button) => button === document.activeElement);
    if (index === -1) return;
    event.preventDefault();
    const next = buttons[(index + (event.key === "ArrowRight" ? 1 : buttons.length - 1)) % buttons.length];
    next?.focus();
  };

  return (
    <nav
      aria-label="Runs in this session"
      className="flex h-9 shrink-0 items-center gap-1 bg-bg px-2 hairline-b"
    >
      {row.trail.length > 0 || row.focused ? (
        <ol role="list" className="flex min-w-0 shrink items-center gap-0.5 pe-1">
          <Crumb label="Session" onClick={() => onFocus(undefined)} />
          {[...row.trail, ...(row.focused ? [row.focused] : [])].map((node, i, all) => (
            <Crumb
              key={node.id}
              label={node.title}
              attention={node.attention}
              current={i === all.length - 1}
              onClick={() => onFocus(node.id)}
            />
          ))}
        </ol>
      ) : null}

      {/* A list of runs, not a tab list: nothing here is "selected" — pressing
          one reveals it in the dock and the strip keeps showing all of them.
          A `tablist` whose every tab is `aria-selected={false}` is announced as
          a broken tab list, so this is a list with roving focus instead. */}
      <div ref={listRef} aria-label="Child runs" className="flex min-w-0 flex-1 items-center gap-1" onKeyDown={onKeyDown}>
        {row.tabs.length === 0 ? (
          <p className="truncate text-xs text-ink-3">
            {row.focused ? "This run started nothing of its own." : "No agent work in this session yet."}
          </p>
        ) : (
          row.tabs.map((node, i) => (
            <Tab key={node.id} node={node} first={i === 0} onFocus={() => onFocus(node.id)} onReveal={() => onReveal(node)} />
          ))
        )}
        {row.overflow.length > 0 && (
          // The strip is one tab stop; when there are no run buttons the
          // overflow is that stop, or it would be reachable by mouse only.
          <Overflow nodes={row.overflow} first={row.tabs.length === 0} onFocus={onFocus} onReveal={onReveal} />
        )}
      </div>

      <FleetChip running={tree.running} />
    </nav>
  );
}

function Crumb({
  label,
  attention,
  current = false,
  onClick,
}: {
  label: string;
  attention?: string;
  current?: boolean;
  onClick(): void;
}) {
  return (
    <li className="flex min-w-0 items-center">
      <button
        type="button"
        onClick={onClick}
        aria-current={current ? "page" : undefined}
        title={label}
        className={cn(
          "max-w-40 truncate rounded px-1 text-xs outline-none transition-colors duration-(--motion-instant) hover:text-ink active:bg-[color-mix(in_oklab,var(--surface-2)_80%,var(--ink))] focus-visible:outline-solid focus-visible:outline-2 focus-visible:outline-live",
          current ? "font-medium text-ink" : "text-ink-2",
        )}
      >
        {label}
      </button>
      {!current && <ChevronRight className="size-3 shrink-0 text-ink-3" aria-hidden="true" />}
    </li>
  );
}

function Tab({ node, first, onFocus, onReveal }: { node: RunNode; first: boolean; onFocus(): void; onReveal(): void }) {
  const hasChildren = node.children.length > 0;
  return (
    <span
      className={cn(
        "group flex h-7 min-w-0 items-center rounded-md border border-line bg-surface ps-2 pe-0.5",
        "transition-colors duration-(--motion-instant) hover:bg-surface-2 has-[button:active]:bg-[color-mix(in_oklab,var(--surface-2)_80%,var(--ink))]",
        node.attention === "waiting_for_input" && "border-attention/50",
        node.attention === "error" && "border-danger/50",
      )}
    >
      <button
        type="button"
        data-run-tab="true"
        tabIndex={first ? 0 : -1}
        onClick={onReveal}
        onDoubleClick={hasChildren ? onFocus : undefined}
        title={`${node.title}${node.kind === "plan" ? " (plan)" : ""}`}
        className="flex min-w-0 items-center gap-1.5 rounded-s-md pe-1 text-xs text-ink outline-none focus-visible:outline-solid focus-visible:outline-2 focus-visible:outline-live"
      >
        <StatusDot status={node.attention} size="sm" />
        <span className="max-w-40 truncate">{node.title}</span>
        {node.elapsedMs !== undefined && (
          <span className="typed shrink-0 text-ink-3 tabular-nums">{formatElapsed(node.elapsedMs)}</span>
        )}
      </button>
      {hasChildren && (
        <button
          type="button"
          data-run-tab="true"
          onClick={onFocus}
          aria-label={`Open ${node.children.length} children of ${node.title}`}
          title={`${node.children.length} children`}
          className="relative flex h-6 w-5 items-center justify-center rounded-e-md text-ink-3 outline-none transition-colors duration-(--motion-instant) hover:bg-surface-2 hover:text-ink active:bg-[color-mix(in_oklab,var(--surface-2)_80%,var(--ink))] focus-visible:outline-solid focus-visible:outline-2 focus-visible:outline-live after:absolute after:-inset-y-2.5 after:inset-x-0 after:content-['']"
        >
          <ChevronRight className="size-3.5" aria-hidden="true" />
        </button>
      )}
    </span>
  );
}

function Overflow({ nodes, first = false, onFocus, onReveal }: { nodes: readonly RunNode[]; first?: boolean; onFocus(id: string): void; onReveal(node: RunNode): void }) {
  const attention = overflowAttention(nodes);
  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <button
          type="button"
          data-run-tab="true"
          tabIndex={first ? 0 : -1}
          aria-label={`${nodes.length} more runs`}
          className="flex h-7 shrink-0 items-center gap-1.5 rounded-md border border-line bg-surface px-2 text-xs text-ink outline-none transition-colors duration-(--motion-instant) hover:bg-surface-2 active:bg-[color-mix(in_oklab,var(--surface-2)_80%,var(--ink))] focus-visible:outline-solid focus-visible:outline-2 focus-visible:outline-live"
        >
          <StatusDot status={attention} size="sm" />
          <span className="tabular-nums">+{nodes.length}</span>
        </button>
      </DropdownMenuTrigger>
      <DropdownMenuContent align="start" className="max-h-80 w-64 overflow-y-auto">
        {nodes.map((node) => (
          <DropdownMenuItem key={node.id} onSelect={() => (node.children.length > 0 ? onFocus(node.id) : onReveal(node))}>
            <StatusDot status={node.attention} size="sm" />
            <span className="min-w-0 flex-1 truncate" title={node.title}>
              {node.title}
            </span>
            {node.elapsedMs !== undefined && <span className="typed text-ink-3 tabular-nums">{formatElapsed(node.elapsedMs)}</span>}
          </DropdownMenuItem>
        ))}
      </DropdownMenuContent>
    </DropdownMenu>
  );
}

/** The way into the fleet from the strip. The status line above the composer has the other one. */
function FleetChip({ running }: { running: number }) {
  return (
    <button
      type="button"
      onClick={() => openFleet()}
      className="flex h-7 shrink-0 items-center gap-1.5 rounded-md px-2 text-xs text-ink-2 outline-none hover:bg-surface-2 hover:text-ink focus-visible:outline-solid focus-visible:outline-2 focus-visible:outline-live"
      title="Every run, in every project"
    >
      <Layers className="size-3.5" aria-hidden="true" />
      <span className="hidden sm:inline">Fleet</span>
      {running > 0 && <span className="typed tabular-nums text-live">{running}</span>}
    </button>
  );
}

// ---------------------------------------------------------------------------
// Phone
// ---------------------------------------------------------------------------

/**
 * Two axes do not fit on a phone, so depth is the only one: a back chevron,
 * where you are, and how many runs are here. Tapping the count opens the level
 * as a sheet — which is the same list the tab strip is, stacked.
 */
function MobileStrip({ tree, row, onFocus }: StripProps) {
  const [levelOpen, setLevelOpen] = useState(false);
  const reveal = useReveal(true);
  const here = row.focused;
  const level = here ? here.children : tree.roots;
  const parent = row.trail.at(-1);

  return (
    <>
      <nav aria-label="Runs in this session" className="flex h-9 shrink-0 items-center gap-1 bg-bg px-2 hairline-b">
        {here && (
          <button
            type="button"
            onClick={() => onFocus(parent?.id)}
            aria-label={parent ? `Back to ${parent.title}` : "Back to the session"}
            className="relative flex size-7 shrink-0 items-center justify-center rounded-md text-ink-2 outline-none focus-visible:outline-solid focus-visible:outline-2 focus-visible:outline-live after:absolute after:-inset-2 after:content-['']"
          >
            <ChevronLeft className="size-4" aria-hidden="true" />
          </button>
        )}
        <span className="flex min-w-0 flex-1 items-center gap-1.5">
          {here && <StatusDot status={here.attention} size="sm" />}
          <span className="min-w-0 truncate text-xs text-ink" title={here ? here.title : "Agent work"}>
            {here ? here.title : "Agent work"}
          </span>
        </span>
        <button
          type="button"
          onClick={() => setLevelOpen(true)}
          disabled={level.length === 0}
          className="relative flex h-7 shrink-0 items-center gap-1.5 rounded-md border border-line bg-surface px-2 text-xs text-ink outline-none disabled:opacity-50 focus-visible:outline-solid focus-visible:outline-2 focus-visible:outline-live after:absolute after:-inset-y-2 after:inset-x-0 after:content-['']"
        >
          <StatusDot status={tree.attention} size="sm" />
          <span className="tabular-nums">{level.length}</span>
          <span>{level.length === 1 ? "run" : "runs"}</span>
        </button>
      </nav>

      <Sheet open={levelOpen} onOpenChange={setLevelOpen}>
        <SheetContent side="bottom" className="max-h-[80dvh] p-0">
          <SheetTitle className="px-4 pt-4 text-sm">{here ? here.title : "Agent work"}</SheetTitle>
          <SheetDescription className="px-4 pb-2 text-xs text-ink-2">
            {level.length === 0 ? "Nothing started here." : "Tap a run to open it; tap the chevron to go deeper."}
          </SheetDescription>
          <ul role="list" className="min-h-0 overflow-y-auto pb-[env(safe-area-inset-bottom)]">
            {level.map((node) => (
              <li key={node.id} className="flex items-center hairline-t">
                <button
                  type="button"
                  onClick={() => {
                    setLevelOpen(false);
                    reveal(node);
                  }}
                  className="flex min-h-11 min-w-0 flex-1 items-center gap-2 px-4 text-start outline-none focus-visible:outline-solid focus-visible:outline-2 -outline-offset-2 focus-visible:outline-live"
                >
                  <StatusDot status={node.attention} size="sm" />
                  <span className="min-w-0 flex-1 truncate text-sm text-ink" title={node.title}>
                    {node.title}
                  </span>
                  {node.elapsedMs !== undefined && (
                    <span className="typed shrink-0 text-ink-3 tabular-nums">{formatElapsed(node.elapsedMs)}</span>
                  )}
                </button>
                {node.children.length > 0 && (
                  <button
                    type="button"
                    onClick={() => {
                      setLevelOpen(false);
                      onFocus(node.id);
                    }}
                    aria-label={`Open ${node.children.length} children of ${node.title}`}
                    className="flex min-h-11 w-11 items-center justify-center text-ink-3 outline-none focus-visible:outline-solid focus-visible:outline-2 -outline-offset-2 focus-visible:outline-live"
                  >
                    <ChevronRight className="size-4" aria-hidden="true" />
                  </button>
                )}
              </li>
            ))}
          </ul>
        </SheetContent>
      </Sheet>
    </>
  );
}
