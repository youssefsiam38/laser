"use client";
/**
 * An ancestry edge, parent → child (docs/agents.md §5: "edges are ancestry,
 * from `AgentRun.parent`"; nothing is inferred). Smoothstep, labelled
 * "started" in the full composition, and briefly emphasised while a message
 * crosses it — either end has a young `message_sent` / `message_received`
 * event whose counterpart is the other end.
 */
import { BaseEdge, EdgeLabelRenderer, getSmoothStepPath, type Edge, type EdgeProps } from "@xyflow/react";
import { memo } from "react";

import { useAgentEvents } from "@/agents";
import { cn } from "@/lib/utils";

import { useMapData } from "./map-context.js";

export type AgentEdgeData = Record<string, never>;
export type AgentFlowEdge = Edge<AgentEdgeData, "agent">;

/** How long a crossing message keeps the edge lit. */
export const EDGE_EMPHASIS_MS = 3000;

function crossing(events: readonly { kind: string; counterpart?: { sessionPath: string } | undefined }[], other: string): boolean {
  return events.some((event) => (event.kind === "message_sent" || event.kind === "message_received") && event.counterpart?.sessionPath === other);
}

function AgentEdgeImpl({ id, source, target, sourceX, sourceY, targetX, targetY, sourcePosition, targetPosition, markerEnd }: EdgeProps<AgentFlowEdge>) {
  const { composition } = useMapData();
  const fromSource = useAgentEvents(source, EDGE_EMPHASIS_MS);
  const fromTarget = useAgentEvents(target, EDGE_EMPHASIS_MS);
  const active = crossing(fromSource, target) || crossing(fromTarget, source);
  const [path, labelX, labelY] = getSmoothStepPath({ sourceX, sourceY, targetX, targetY, sourcePosition, targetPosition, borderRadius: 12 });
  return (
    <>
      <BaseEdge id={id} path={path} {...(markerEnd !== undefined ? { markerEnd } : {})} className={cn("agent-map-edge", active && "agent-map-edge-active")} />
      {composition === "full" && (
        <EdgeLabelRenderer>
          <span
            data-slot="agent-map-edge-label"
            data-active={active || undefined}
            className={cn(
              "eyebrow pointer-events-none absolute rounded-sm bg-bg px-1 transition-colors duration-(--motion-fast) motion-reduce:transition-none",
              active && "text-live",
            )}
            style={{ transform: `translate(-50%, -50%) translate(${labelX}px, ${labelY}px)` }}
          >
            started
          </span>
        </EdgeLabelRenderer>
      )}
    </>
  );
}

export const AgentEdge = memo(AgentEdgeImpl);
