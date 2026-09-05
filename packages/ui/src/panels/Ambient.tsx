"use client";
/**
 * The ambient surface's panel half (docs/ux-panels.md "Four surfaces",
 * DESIGN.md "Composer", D-20 §5). The status line above the composer is
 * owned by the thread (StatusLine.tsx: state words, turn elapsed, tokens);
 * this fills its trailing slot with what panels contribute: the fleet pill
 * ("3 running · 1 needs you", absent when nothing runs), `glance` panels
 * (a run or plan as name + one number, a stream as its size) and extension
 * `setStatus` lines. State, not content: 12px, one line, truncates.
 *
 * Mounted by the shell as `<Thread statusSlot={<PanelAmbient />} />`.
 */
import { useMemo } from "react";

import { cn } from "@/lib/utils";
// The leaf module, not the `@/components/subagents` barrel: that barrel also
// exports RunTabs and FleetSheet, which import `@/panels`, and importing it
// from inside `@/panels` closes the loop. `fleet.ts` imports nothing.
import { openFleet } from "@/components/subagents/fleet.js";
import { useTick } from "@/components/thread/timing";
import { useLaserView } from "@/runtime";

import { ambientStatuses } from "./fallback.js";
import { placementOf } from "./placement.js";
import { usePanelEntries, usePanelsState } from "./PanelsProvider.js";
import { fleetSummary, type PanelEntry } from "./store.js";
import { liveValues } from "./values.js";

export interface PanelAmbientProps {
  className?: string | undefined;
}

export function PanelAmbient({ className }: PanelAmbientProps) {
  const view = useLaserView();
  const fleet = usePanelsState((r) => fleetSummary(r.panels), (a, b) => a.running === b.running && a.needsYou === b.needsYou);
  const entries = usePanelEntries(view?.path);
  const glance = useMemo(() => entries.filter((e) => !e.closed && placementOf(e.panel, "desktop").surface === "ambient"), [entries]);
  const statuses = useMemo(() => ambientStatuses(view), [view]);
  const live = glance.some((e) => (e.panel.kind === "run" && (e.panel.lifecycle === "running" || e.panel.lifecycle === "queued")) || (e.panel.kind === "stream" && e.panel.follow === true));
  useTick(live, 1000);

  const showFleet = fleet.running > 0 || fleet.needsYou > 0;
  if (!showFleet && glance.length === 0 && statuses.length === 0) return null;

  return (
    <span data-slot="ambient" className={cn("flex min-w-0 items-center gap-3 overflow-hidden text-xs leading-4 text-ink-2", className)}>
      {statuses.map((s) => (
        <span key={s.key} className="typed min-w-0 truncate text-ink-3" title={`${s.key}: ${s.text}`}>
          {s.text}
        </span>
      ))}
      {glance.map((entry) => (
        <GlanceItem key={entry.key} entry={entry} />
      ))}
      {showFleet && (
        <button
          type="button"
          onClick={() => openFleet()}
          className={cn(
            "relative inline-flex h-4 shrink-0 items-center gap-1 rounded-full px-1.5 text-xs font-medium leading-none outline-none",
            // The app's own hover and pressed vocabulary, not a filter: a
            // `brightness()` over a `color-mix` ground drifts the pill's hue
            // toward the accent under some themes. Hover deepens the tint it
            // already has, and there is a pressed state like everywhere else.
            "transition-[background-color,transform] duration-(--motion-instant) active:translate-y-px motion-reduce:transition-none",
            "focus-visible:outline-solid focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-live",
            // 44px hit area on a 16px pill: the hit area grows, not the paint.
            "after:absolute after:-inset-x-2 after:-inset-y-3.5 after:content-['']",
            fleet.needsYou > 0
              ? "bg-[color-mix(in_oklab,var(--attention)_14%,transparent)] text-attention hover:bg-[color-mix(in_oklab,var(--attention)_24%,transparent)]"
              : "bg-[color-mix(in_oklab,var(--live)_12%,transparent)] text-live hover:bg-[color-mix(in_oklab,var(--live)_22%,transparent)]",
          )}
          title="Every run, in every project"
        >
          {fleet.running > 0 && <span className="tnum">{fleet.running} running</span>}
          {fleet.running > 0 && fleet.needsYou > 0 && <span aria-hidden="true">·</span>}
          {fleet.needsYou > 0 && (
            <span className="tnum">
              {fleet.needsYou} {fleet.needsYou === 1 ? "needs" : "need"} you
            </span>
          )}
        </button>
      )}
    </span>
  );
}

/** A run or plan with `glance`: name and one number. A glance stream: its size. */
function GlanceItem({ entry }: { entry: PanelEntry }) {
  const value = liveValues(entry, Date.now())[0];
  return (
    <span className="flex min-w-0 max-w-56 shrink items-center gap-1.5" title={`${entry.panel.source} · ${entry.panel.title}`}>
      <span className="min-w-0 truncate text-ink-2">{entry.panel.title}</span>
      {value && <span className="typed shrink-0 text-ink-3">{value.text}</span>}
    </span>
  );
}
