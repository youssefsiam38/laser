"use client";
/**
 * The dock host: the map held beside the thread as a Laser-owned island
 * (docs/ux-panels.md "Four surfaces": follow). Client-only — no panel entry
 * exists for it — so `Dock.tsx` gives it a fixed first slot rather than a
 * place in the panel store. Same header language as every island: the status
 * pill leads, maximize opens the fullscreen host, close puts it away.
 */
import { Maximize2, X } from "lucide-react";

import { useAgentTree } from "@/agents";
import { AgentStatus } from "@/components/assistant-ui/elements/agent-status";
import { TooltipIconButton } from "@/components/ui/tooltip-icon-button";
import { cn } from "@/lib/utils";

import { AgentMapConnected, useMapRoot } from "./AgentMapView.js";
import { mapUi, useMapDocked } from "./map-state.js";
import { aggregateTone, toneStatus, treeSummary } from "./node-model.js";

/** The island never shrinks below a readable list. */
export const MAP_ISLAND_MIN_HEIGHT = 240;

/** The root whose map is docked for the session at `path`, or nothing. */
export function useMapDockRoot(path: string | undefined): string | undefined {
  const root = useMapRoot(path);
  const docked = useMapDocked(root);
  return docked ? root : undefined;
}

export function MapDockIsland({ rootPath, height, className }: { rootPath: string; height: number; className?: string | undefined }) {
  const tree = useAgentTree(rootPath);
  const nodes = tree?.nodes ?? [];
  return (
    <section
      data-island
      data-kind="agent-map"
      data-size="expanded"
      data-slot="agent-map-island"
      aria-label="Agent map"
      style={{ height }}
      className={cn("mb-2 flex shrink-0 flex-col overflow-hidden rounded-xl border border-line bg-surface text-ink", className)}
    >
      <div data-island-header className="flex h-10 w-full shrink-0 items-center gap-2 pe-1.5 ps-3">
        <AgentStatus
          tabIndex={-1}
          state={toneStatus(aggregateTone(nodes))}
          label="Agent map"
          values={[{ label: "Agents", text: treeSummary(nodes) }]}
          size="expanded"
        />
        <TooltipIconButton tooltip="Maximize" onClick={() => mapUi.setFullscreen(true)} data-slot="agent-map-island-maximize">
          <Maximize2 />
        </TooltipIconButton>
        <TooltipIconButton tooltip="Close" onClick={() => mapUi.setDocked(rootPath, false)} data-slot="agent-map-island-close">
          <X />
        </TooltipIconButton>
      </div>
      <div className="min-h-0 flex-1 hairline-t">
        <AgentMapConnected rootPath={rootPath} frame="dock" chrome={false} />
      </div>
    </section>
  );
}
