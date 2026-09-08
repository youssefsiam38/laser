"use client";
/**
 * The row above the map: what it is, how the tree is doing, "Show ended" with
 * its count, and the way to the other hosts — fullscreen, the dock, back.
 * The fullscreen host draws the same header with a way back at the start.
 */
import { ChevronLeft, Maximize2, PanelRightOpen, Waypoints, X } from "lucide-react";
import type { ComponentProps } from "react";

import type { AgentTreeNode } from "@/agents";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Kbd } from "@/components/ui/kbd";
import { Toggle } from "@/components/ui/toggle";
import { TooltipIconButton } from "@/components/ui/tooltip-icon-button";
import { cn } from "@/lib/utils";

import type { MapComposition, VisibleTree } from "./layout.js";
import { useMapHost } from "./map-context.js";
import { mapUi } from "./map-state.js";
import { aggregateTone, nodeStatusLabel, treeSummary } from "./node-model.js";
import { ToneDot } from "./NodeParts.js";

export interface MapHeaderProps extends Omit<ComponentProps<"header">, "children"> {
  rootPath: string;
  nodes: readonly AgentTreeNode[];
  visible: VisibleTree;
  composition: MapComposition | undefined;
  showEnded: boolean;
  /** Narrow fullscreen: a back chevron instead of the close control. */
  phone?: boolean;
  /** `slim` keeps the controls and drops the title: the dock island has its own header. */
  variant?: "full" | "slim";
}

export function MapHeader({ rootPath, nodes, visible, composition, showEnded, phone = false, variant = "full", className, ...props }: MapHeaderProps) {
  const host = useMapHost();
  const tone = aggregateTone(nodes);
  const endedCount = showEnded ? visible.ended : visible.hidden;
  const fullscreen = host.frame === "fullscreen";
  return (
    <header
      data-slot="agent-map-header"
      className={cn(
        // A container query, not a window breakpoint: the same header sits in a
        // 400px column and a 1400px overlay, and the summary yields first.
        "@container flex shrink-0 items-center gap-1.5 bg-bg hairline-b",
        variant === "full" ? "h-11 px-2" : "h-9 px-1.5",
        fullscreen && "h-12 pt-[env(safe-area-inset-top)]",
        className,
      )}
      {...props}
    >
      {fullscreen && phone && (
        <TooltipIconButton tooltip="Back to the session" size="icon" onClick={host.closeFullscreen}>
          <ChevronLeft />
        </TooltipIconButton>
      )}
      {variant === "full" && (
        <div className="flex min-w-0 flex-1 items-center gap-2 ps-1">
          <Waypoints aria-hidden="true" className="size-4 shrink-0 text-ink-3" />
          <h2 className="shrink-0 text-sm leading-sm font-semibold text-ink">Agent map</h2>
          <span className="hidden min-w-0 items-center gap-1.5 truncate text-xs leading-xs text-ink-3 @[560px]:inline-flex" data-slot="agent-map-summary">
            <ToneDot tone={tone} label={nodeStatusLabel(nodes[0]?.status ?? "idle")} />
            {treeSummary(nodes)}
          </span>
        </div>
      )}
      {variant === "slim" && <span className="min-w-0 flex-1 truncate ps-1 text-xs leading-xs text-ink-3">{treeSummary(nodes)}</span>}

      <Toggle
        size="sm"
        pressed={showEnded}
        onPressedChange={(pressed) => mapUi.setShowEnded(rootPath, pressed)}
        disabled={visible.ended === 0 && visible.hidden === 0}
        aria-label={showEnded ? "Hide ended agents" : "Show ended agents"}
        data-slot="agent-map-show-ended"
        className="gap-1.5 text-xs"
      >
        Show ended
        {endedCount > 0 && (
          <Badge variant={showEnded ? "default" : "outline"} className="h-4 px-1.5 tnum" data-slot="agent-map-ended-count">
            {endedCount} ended
          </Badge>
        )}
      </Toggle>

      {!fullscreen && composition === "constrained" && (
        <Button size="sm" variant="outline" onClick={host.openFullscreen} data-slot="agent-map-open">
          <Maximize2 />
          Open map
        </Button>
      )}
      {!fullscreen && host.showInDock && (
        <TooltipIconButton tooltip="Show in dock" onClick={host.showInDock} data-slot="agent-map-dock">
          <PanelRightOpen />
        </TooltipIconButton>
      )}
      {!fullscreen && composition !== "constrained" && (
        <TooltipIconButton tooltip="Open fullscreen" onClick={host.openFullscreen} data-slot="agent-map-open">
          <Maximize2 />
        </TooltipIconButton>
      )}
      {fullscreen && !phone && (
        <span className="flex items-center gap-2">
          <Kbd className="hidden sm:inline-flex">Esc</Kbd>
          <TooltipIconButton tooltip="Back to the session" onClick={host.closeFullscreen} data-slot="agent-map-close">
            <X />
          </TooltipIconButton>
        </span>
      )}
    </header>
  );
}
