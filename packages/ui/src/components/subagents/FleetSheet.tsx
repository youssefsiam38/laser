"use client";
/**
 * The fleet sheet (D-19 §2, §3): every run in every project, as run islands.
 *
 * Two things live here that live nowhere else:
 *
 *   - **Orphaned runs.** A background child whose parent session you closed is
 *     still working. It is not in the session list (children never are) and it
 *     is not in the dock (that follows the open session), so without this sheet
 *     it would be invisible while spending money. It appears under its project
 *     with a note saying its session is closed.
 *   - **Everything at once.** The dock holds two expanded islands per column
 *     on purpose. When you want the whole picture rather than the two you are
 *     watching, this is where it is — and it is a sheet, not a board, because
 *     you are doing this *instead of* the conversation for a moment (D-18 §3).
 *
 * Rows are the same `Island` element the dock uses, at compact size, expanding
 * in place. Same element, same four sizes, less room — that is the shape of
 * the whole panel system and there is no second implementation of it here.
 */
import { useEffect, useMemo, useRef, useState } from "react";

import { Sheet, SheetContent, SheetDescription, SheetTitle } from "@/components/ui/sheet";
import { useIsMobile } from "@/hooks/use-mobile";
import { shortCwd } from "@/format";
import { cn } from "@/lib/utils";
import { Island, openDecisionIds, usePanelsState, entriesForPath, type PanelEntry } from "@/panels";
import { usePiorbitState, usePiorbitView } from "@/runtime";
import type { AppState } from "@/store";

import { closeFleet, useFleetFocus, useFleetOpen } from "./fleet.js";
import { buildRunTree, byAttention, flatten, type RunNode } from "./run-tree.js";

/** How tall an expanded row may grow in this window, kept between its bounds. */
function useExpandedHeight(): number {
  const [height, setHeight] = useState(EXPANDED_MIN_H);
  useEffect(() => {
    const measure = () => {
      const sheet = (globalThis.innerHeight ?? 0) * 0.85;
      setHeight(Math.round(Math.min(EXPANDED_MAX_H, Math.max(EXPANDED_MIN_H, sheet - RESERVED_H))));
    };
    measure();
    window.addEventListener("resize", measure);
    return () => window.removeEventListener("resize", measure);
  }, []);
  return height;
}

interface Group {
  path: string;
  cwd: string;
  title: string;
  /** The session is not open in this client: its runs kept going without it. */
  orphaned: boolean;
  nodes: RunNode[];
  running: number;
}

const COLLAPSED_H = 44;
/**
 * How tall an expanded row grows: as much of the sheet as it can have, bounded
 * by what a run's body needs to lay out (the usage row, the output tail and its
 * encoding tabs) and by leaving the list itself visible above and below.
 *
 * A constant would be wrong at both ends — 440px inside an 85dvh sheet on a
 * 667px phone leaves about 130px for the header and every other row, and on a
 * 1200px monitor it wastes the rest of the sheet.
 */
const EXPANDED_MIN_H = 260;
const EXPANDED_MAX_H = 520;
/** Room kept for the sheet header and at least a couple of collapsed rows. */
const RESERVED_H = 180;

export function FleetSheet() {
  const open = useFleetOpen();
  const focus = useFleetFocus();
  const mobile = useIsMobile();
  const view = usePiorbitView();
  const sessions = usePiorbitState((s: AppState) => s.sessions);
  const openViews = usePiorbitState((s: AppState) => s.open);
  const panels = usePanelsState((r) => r.panels);
  const decisions = usePanelsState((r) => openDecisionIds(r.panels), (a, b) => a.size === b.size && [...a].every((x) => b.has(x)));
  const [expanded, setExpanded] = useState<string | undefined>(undefined);

  const groups = useMemo<Group[]>(() => {
    const now = Date.now();
    const paths = [...new Set(panels.order.map((key) => panels.entries[key]?.path).filter((p): p is string => p !== undefined))];
    const out: Group[] = [];
    for (const path of paths) {
      const entries: PanelEntry[] = entriesForPath(panels, path);
      const tree = buildRunTree(entries, decisions, now);
      const nodes = byAttention(flatten(tree));
      if (nodes.length === 0) continue;
      const summary = sessions.find((s) => s.path === path);
      out.push({
        path,
        cwd: summary?.cwd ?? "",
        title: summary?.name ?? summary?.firstMessage ?? path.split("/").at(-1) ?? path,
        orphaned: openViews[path] === undefined && path !== view?.path,
        nodes,
        running: tree.running,
      });
    }
    return out.sort((a, b) => b.running - a.running || a.title.localeCompare(b.title));
  }, [panels, decisions, sessions, openViews, view?.path]);

  // Opened from a tab: that run is the one you meant, so it is the one open.
  useEffect(() => {
    if (open && focus) setExpanded(focus);
  }, [open, focus]);

  const expandedHeight = useExpandedHeight();
  const total = groups.reduce((n, group) => n + group.nodes.length, 0);
  const running = groups.reduce((n, group) => n + group.running, 0);

  return (
    <Sheet open={open} onOpenChange={(next) => !next && closeFleet()}>
      <SheetContent side={mobile ? "bottom" : "right"} className={cn("flex flex-col gap-0 p-0", mobile ? "h-[85dvh]" : "w-[min(92vw,480px)]")}>
        <div className="shrink-0 px-4 pt-4 pb-3 hairline-b">
          <SheetTitle className="text-sm font-medium text-ink">The fleet</SheetTitle>
          <SheetDescription className="mt-0.5 text-xs text-ink-2">
            {total === 0
              ? "Nothing is running anywhere. Runs you start will appear here."
              : `${total} ${total === 1 ? "run" : "runs"} across ${groups.length} ${groups.length === 1 ? "session" : "sessions"}${running > 0 ? ` · ${running} still going` : ""}`}
          </SheetDescription>
        </div>

        <div className="min-h-0 flex-1 overflow-y-auto overscroll-contain pb-[env(safe-area-inset-bottom)]">
          {groups.map((group) => (
            <section key={group.path} aria-label={group.title}>
              {/* Opaque: DESIGN.md keeps glass out of the system, and a
                  blurred header over a scrolling list is exactly the
                  decoration it names. */}
              <header className="sticky top-0 z-10 flex items-baseline gap-2 bg-bg px-4 py-1.5 hairline-b">
                <h3 className="min-w-0 truncate text-xs font-medium text-ink">{group.title}</h3>
                {group.cwd && <span className="eyebrow shrink-0">{shortCwd(group.cwd)}</span>}
                {group.orphaned && (
                  <span className="shrink-0 text-xs text-ink-3" title="This session is closed here; its runs kept going.">
                    session closed
                  </span>
                )}
              </header>
              <ul role="list" className="flex flex-col gap-1.5 px-2 py-2">
                {group.nodes.map((node) => (
                  <Row
                    key={node.key}
                    node={node}
                    expanded={expanded === node.id}
                    expandedHeight={expandedHeight}
                    onToggle={() => setExpanded(expanded === node.id ? undefined : node.id)}
                  />
                ))}
              </ul>
            </section>
          ))}
        </div>
      </SheetContent>
    </Sheet>
  );
}

/**
 * One run. The island keeps its identity across the size change, so the dot
 * keeps ticking and the body keeps its scroll when you collapse it again.
 * Indentation carries depth, because in this list the tree is flattened and
 * the strip's one-level rule does not apply.
 */
function Row({ node, expanded, onToggle, expandedHeight }: { node: RunNode; expanded: boolean; onToggle(): void; expandedHeight: number }) {
  const ref = useRef<HTMLLIElement>(null);
  useEffect(() => {
    if (expanded) ref.current?.scrollIntoView({ block: "nearest", behavior: "smooth" });
  }, [expanded]);
  return (
    <li
      ref={ref}
      style={{ marginInlineStart: Math.min(node.depth, 3) * 12, height: expanded ? expandedHeight : COLLAPSED_H }}
      className="rounded-xl border border-line transition-[height] duration-(--motion-morph) ease-morph motion-reduce:transition-none"
      onClickCapture={(event) => {
        // The island's own header button toggles size inside the dock; in a
        // list the row owns that, so a click on the island's toggle — and on
        // the inert header behind it — collapses or expands here instead.
        //
        // Every *other* control has to survive: a compact island's primary
        // action is a Button with a `title` and no `aria-label`, so an
        // exclusion written in terms of `aria-label` swallowed Stop and toggled
        // the row instead. The test is the island's own toggle, by its marker.
        const target = event.target as HTMLElement;
        if (!target.closest("[data-island-header]")) return;
        const isToggle = target.closest("[data-island-toggle]") !== null;
        const isControl = target.closest("button, a, input, textarea, select, [role='menuitem']") !== null;
        if (!isToggle && isControl) return;
        event.stopPropagation();
        onToggle();
      }}
    >
      <Island entry={node.entry} size={expanded ? "expanded" : "compact"} frame="sheet" />
    </li>
  );
}
