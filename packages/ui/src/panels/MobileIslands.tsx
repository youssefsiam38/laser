"use client";
/**
 * The phone's islands (docs/ux-panels.md: "On a phone the island sits above
 * the composer: minimal by default, tapping it expands to a sheet. Same
 * element, same four sizes, less room").
 *
 * Same *component*, not the same instance — the one place in the app where a
 * panel is re-created rather than morphed, and it is a recorded exception
 * (D-34), not an oversight. The strip renders `<Island size="minimal">` and
 * the sheet renders a second `<Island size="expanded">` inside `SheetContent`,
 * because the expanded island's DOM has to live in the sheet and the entries
 * behind "+N more" have no strip node to lift out of. What the phone still
 * gets is the island's budgets, live values, hit areas and truncation rules
 * rather than a look-alike written twice; what it does not get is a morph —
 * the sweep restarts and body scroll is not carried across.
 *
 * The strip wraps and only folds into `+N` past **two rows**, measured — not
 * at a fixed count, which on a 320px screen is two rows of two and on a 430px
 * screen is one row of four.
 */
import { Layers } from "lucide-react";
import { useCallback, useMemo, useRef, useState } from "react";

import { StatusDot } from "@/components/status";
import { Sheet, SheetContent, SheetDescription, SheetTitle } from "@/components/ui/sheet";
import { cn } from "@/lib/utils";
import { useIsMobile } from "@/hooks/use-mobile";
import { useLaserView } from "@/runtime";

import { Island } from "./islands/Island.js";
import { stripBudget } from "./layout.js";
import { useIslandEntries, usePanelActions, usePanelsState } from "./PanelsProvider.js";
import { attentionOfEntry, openDecisionIds, type PanelEntry } from "./store.js";
import { accessibleSummary, liveValues } from "./values.js";

/** The narrowest phone, used until the strip has been measured once. */
const UNMEASURED_WIDTH = 320;

export function MobileIslands({ className }: { className?: string | undefined }) {
  const mobile = useIsMobile();
  const view = useLaserView();
  const entries = useIslandEntries(view?.path, "mobile");
  const actions = usePanelActions();
  const [openKey, setOpenKey] = useState<string | undefined>(undefined);
  const [listOpen, setListOpen] = useState(false);
  const decisions = usePanelsState((r) => openDecisionIds(r.panels), (a, b) => a.size === b.size && [...a].every((x) => b.has(x)));
  const open = useMemo(() => entries.find((e) => e.key === openKey), [entries, openKey]);
  const { strip, budget, pillWidth } = useRowBudget();

  const openIsland = useCallback(
    (entry: PanelEntry) => {
      setListOpen(false);
      setOpenKey(entry.key);
      actions.markSeen(entry.key);
    },
    [actions],
  );

  if (!mobile || !view || entries.length === 0) return null;

  const overflow = entries.length > budget;
  const shown = overflow ? entries.slice(0, Math.max(1, budget - 1)) : entries;
  const rest = overflow ? entries.slice(Math.max(1, budget - 1)) : [];

  return (
    <>
      <ul ref={strip} role="list" aria-label="Panels" className={cn("flex flex-wrap gap-1.5 px-1", className)}>
        {shown.map((entry) => (
          <li key={entry.key} data-island-pill style={{ width: pillWidth }} className="min-w-0 max-w-full">
            {/* The island itself, at its smallest size. Growing it means a
                sheet here rather than a dock pane, so the strip says so. */}
            <Island entry={entry} size="minimal" frame="sheet" onExpand={() => openIsland(entry)} />
          </li>
        ))}
        {overflow && (
          <li data-island-pill>
            <button
              type="button"
              onClick={() => setListOpen(true)}
              aria-label={`${rest.length} more panels`}
              className="relative flex h-7 items-center gap-1.5 rounded-full border border-line bg-surface px-2.5 text-xs font-medium text-ink outline-none transition-colors duration-(--motion-instant) hover:bg-surface-2 active:bg-[color-mix(in_oklab,var(--surface-2)_80%,var(--ink))] focus-visible:outline-solid focus-visible:outline-2 focus-visible:outline-live after:absolute after:-inset-y-2 after:inset-x-0 after:content-['']"
            >
              <Layers className="size-3.5 text-ink-3" aria-hidden="true" />+{rest.length} more
            </button>
          </li>
        )}
      </ul>

      <Sheet open={open !== undefined} onOpenChange={(o) => !o && setOpenKey(undefined)}>
        <SheetContent side="bottom" className="h-[85dvh] max-h-[85dvh] p-0" showCloseButton={false}>
          <SheetTitle className="sr-only">{open?.panel.title ?? "Panel"}</SheetTitle>
          <SheetDescription className="sr-only">A panel from {open?.panel.source ?? "an extension"}.</SheetDescription>
          {open && (
            <div className="flex min-h-0 flex-1 flex-col pt-1">
              {/* The same component, one size up (a second instance — D-34),
                  with the way out in its own header: a bottom sheet has no
                  swipe-to-dismiss, and the 15% of overlay above it is not a
                  control. */}
              <Island entry={open} size="expanded" frame="sheet" onClose={() => setOpenKey(undefined)} />
            </div>
          )}
        </SheetContent>
      </Sheet>

      <Sheet open={listOpen} onOpenChange={setListOpen}>
        <SheetContent side="bottom" className="max-h-[70dvh]">
          <SheetTitle>All panels</SheetTitle>
          <SheetDescription>{entries.length} in this session</SheetDescription>
          <ul role="list" className="mt-3 flex flex-col overflow-y-auto">
            {entries.map((entry) => {
              const values = liveValues(entry, Date.now());
              return (
                <li key={entry.key}>
                  <button
                    type="button"
                    onClick={() => openIsland(entry)}
                    aria-label={accessibleSummary(entry.panel.title, values)}
                    className="flex h-11 w-full items-center gap-3 rounded-md px-2 text-start outline-none transition-colors duration-(--motion-instant) hover:bg-surface-2 active:bg-[color-mix(in_oklab,var(--surface-2)_80%,var(--ink))] focus-visible:outline-solid focus-visible:outline-2 focus-visible:-outline-offset-2 focus-visible:outline-live"
                  >
                    <StatusDot status={attentionOfEntry(entry, decisions)} size="sm" />
                    <span className="min-w-0 flex-1 truncate text-sm text-ink">{entry.panel.title}</span>
                    {values[0] && <span className="typed shrink-0 text-ink-2">{values[0].text}</span>}
                  </button>
                </li>
              );
            })}
          </ul>
        </SheetContent>
      </Sheet>
    </>
  );
}

/**
 * How many pills fit two rows at this width, from the dock's own strip math.
 *
 * Pills are a fixed width that truncates (R13), so the fold is arithmetic
 * rather than a guess: the same `stripBudget` the dock lays out with, applied
 * to the strip's measured width. A fixed count would be two rows on a 320px
 * screen and one on a 430px one, which is the thing the contract's "past two
 * rows, and only then" rule exists to prevent.
 */
function useRowBudget(): { strip: (node: HTMLUListElement | null) => void; budget: number; pillWidth: number } {
  const [width, setWidth] = useState(0);
  const observer = useRef<ResizeObserver | undefined>(undefined);

  // A callback ref, not `useRef` plus an effect: the strip is not in the tree
  // until the first island arrives, so an effect with a stable dependency list
  // would measure `null` once and never look again — which left a 375px phone
  // folding three pills into "+2 more".
  const strip = useCallback((node: HTMLUListElement | null) => {
    observer.current?.disconnect();
    observer.current = undefined;
    if (!node) return;
    const measure = () => setWidth((w) => (Math.abs(w - node.clientWidth) < 1 ? w : node.clientWidth));
    measure();
    if (typeof ResizeObserver === "undefined") return;
    observer.current = new ResizeObserver(measure);
    observer.current.observe(node);
  }, []);

  // Before the first measurement the strip has no width, and `stripBudget`
  // would answer "one per row". A phone is at least this wide.
  const { budget, pillWidth } = stripBudget(width > 0 ? width : UNMEASURED_WIDTH);
  return { strip, budget, pillWidth };
}
