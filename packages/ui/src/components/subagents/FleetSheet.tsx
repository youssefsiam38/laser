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
 * The list itself is the catalog's subagent-list element
 * (`components/assistant-ui/elements/subagent-list.tsx`); this file is the
 * sheet around it and the data that feeds it.
 */
import { useEffect, useMemo, useState } from "react";

import { SubagentList, type FleetGroup } from "@/components/assistant-ui/elements/subagent-list";
import { Sheet, SheetContent, SheetDescription, SheetTitle } from "@/components/ui/sheet";
import { useIsMobile } from "@/hooks/use-mobile";
import { cn } from "@/lib/utils";
import { openDecisionIds, usePanelsState, entriesForPath, type PanelEntry } from "@/panels";
import { usePiorbitState, usePiorbitView } from "@/runtime";
import type { AppState } from "@/store";

import { closeFleet, useFleetFocus, useFleetOpen } from "./fleet.js";
import { buildRunTree, byAttention, flatten } from "./run-tree.js";

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

  const groups = useMemo<FleetGroup[]>(() => {
    const now = Date.now();
    const paths = [...new Set(panels.order.map((key) => panels.entries[key]?.path).filter((p): p is string => p !== undefined))];
    const out: FleetGroup[] = [];
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
          <SubagentList groups={groups} expandedId={expanded} onToggle={(id) => setExpanded(expanded === id ? undefined : id)} />
        </div>
      </SheetContent>
    </Sheet>
  );
}
