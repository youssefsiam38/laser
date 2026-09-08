"use client";
/**
 * One agent on the canvas (docs/agents.md §5). Three drawings of one node:
 *
 *   - concise (the panel composition): mark · name · chat, then dot · status ·
 *     elapsed, with the bubble slot standing in for the status line;
 *   - rich (the full composition): adds the agent's definition, the current
 *     action line (where the bubble lands), the task excerpt and the model;
 *   - compact (any composition under {@link ZOOM_COMPACT}): the mark and the
 *     dot, because text that would render below 12px is text that is dropped,
 *     never shrunk (R13).
 *
 * The box the node fills is the layout's (`NODE_BOX`), so switching between
 * drawings moves nothing. Everything but the path arrives through `MapData`;
 * the node objects React Flow holds carry ids and positions only.
 */
import { Handle, Position, useStore, type Node, type NodeProps } from "@xyflow/react";
import { memo, useEffect, useRef, useState, type CSSProperties, type RefObject } from "react";

import type { AgentTreeNode } from "@/agents";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";
import { cn } from "@/lib/utils";

import { EventBubbles } from "./EventBubbles.js";
import { ZOOM_COMPACT } from "./layout.js";
import { useMapData, useMapNode } from "./map-context.js";
import { AgentMarkBadge, ChatButton, Elapsed, StatusWord, ToneDot } from "./NodeParts.js";
import { nodeAction, nodeAgentLabel, nodeName, nodeStatusLabel, runModelLabel } from "./node-model.js";

export type AgentNodeData = {
  path: string;
  /** Just spawned: the offset to its parent, so it can arrive from there. */
  fresh?: { dx: number; dy: number } | undefined;
};

export type AgentFlowNode = Node<AgentNodeData, "agent">;

const zoomCompact = (s: { transform: [number, number, number] }): boolean => s.transform[2] < ZOOM_COMPACT;

/**
 * React Flow focuses its own wrapper, one element above ours, so the task
 * tooltip listens there for the keyboard path the pointer gets for free.
 */
function useWrapperFocus(ref: RefObject<HTMLDivElement | null>): boolean {
  const [focused, setFocused] = useState(false);
  useEffect(() => {
    const wrapper = ref.current?.parentElement;
    if (!wrapper) return;
    const on = () => setFocused(wrapper.matches(":focus-visible"));
    const off = () => setFocused(false);
    wrapper.addEventListener("focus", on);
    wrapper.addEventListener("blur", off);
    return () => {
      wrapper.removeEventListener("focus", on);
      wrapper.removeEventListener("blur", off);
    };
  }, [ref]);
  return focused;
}

function AgentNodeImpl({ data, sourcePosition, targetPosition }: NodeProps<AgentFlowNode>) {
  const node = useMapNode(data.path);
  const { composition } = useMapData();
  const compact = useStore(zoomCompact);
  const ref = useRef<HTMLDivElement>(null);
  const focused = useWrapperFocus(ref);
  const [hovered, setHovered] = useState(false);
  if (!node) return null;
  const task = node.run?.task?.trim();
  const rich = composition === "full";
  const fresh = data.fresh;
  const style = fresh ? ({ "--map-from-x": `${fresh.dx}px`, "--map-from-y": `${fresh.dy}px` } as CSSProperties) : undefined;

  return (
    <>
      <Handle type="target" position={targetPosition ?? Position.Top} isConnectable={false} />
      <Tooltip open={Boolean(task) && (hovered || focused)} onOpenChange={setHovered}>
        <TooltipTrigger asChild>
          <div
            ref={ref}
            data-map-node
            data-slot="agent-map-node"
            data-depth={node.depth}
            data-status={node.status}
            data-drawing={compact ? "compact" : rich ? "rich" : "concise"}
            data-fresh={fresh ? "" : undefined}
            style={style}
            className={cn(
              "flex h-full w-full flex-col rounded-xl border border-line bg-surface text-ink",
              "transition-[border-color,box-shadow] duration-(--motion-instant) motion-reduce:transition-none",
              compact ? "items-center justify-center gap-1.5" : rich ? "justify-between px-3 py-2.5" : "justify-between px-2.5 py-2",
            )}
          >
            {compact ? (
              <CompactBody node={node} />
            ) : rich ? (
              <RichBody node={node} />
            ) : (
              <ConciseBody node={node} />
            )}
          </div>
        </TooltipTrigger>
        {task && (
          <TooltipContent side="bottom" className="max-w-72 items-start whitespace-pre-wrap">
            {task.length > 240 ? `${task.slice(0, 240)}…` : task}
          </TooltipContent>
        )}
      </Tooltip>
      <Handle type="source" position={sourcePosition ?? Position.Bottom} isConnectable={false} />
    </>
  );
}

/** Under the zoom threshold: the mark and the dot, nothing that would shrink. */
function CompactBody({ node }: { node: AgentTreeNode }) {
  return (
    <span className="relative inline-flex">
      <AgentMarkBadge node={node} size="lg" />
      <ToneDot tone={node.tone} label={nodeStatusLabel(node.status)} size="md" className="absolute -end-1 -bottom-1 ring-2 ring-surface" />
    </span>
  );
}

function ConciseBody({ node }: { node: AgentTreeNode }) {
  return (
    <>
      <div className="flex min-w-0 items-center gap-2">
        <AgentMarkBadge node={node} />
        <span className="min-w-0 flex-1 truncate text-sm leading-sm font-medium text-ink" title={nodeName(node)}>
          {nodeName(node)}
        </span>
        <ChatButton path={node.id} />
      </div>
      <div className="flex min-w-0 items-center gap-2">
        <EventBubbles path={node.id} className="min-w-0 flex-1" fallback={<StatusWord node={node} />} />
        <Elapsed node={node} className="shrink-0" />
      </div>
    </>
  );
}

function RichBody({ node }: { node: AgentTreeNode }) {
  const action = nodeAction(node);
  const model = runModelLabel(node.run);
  const task = node.run?.task?.trim();
  return (
    <>
      <div className="flex min-w-0 items-start gap-2.5">
        <AgentMarkBadge node={node} size="md" className="mt-0.5" />
        <div className="flex min-w-0 flex-1 flex-col">
          <span className="truncate text-sm leading-sm font-semibold text-ink" title={nodeName(node)}>
            {nodeName(node)}
          </span>
          <span className="truncate text-xs leading-xs text-ink-3">{node.depth === 0 ? "This session" : nodeAgentLabel(node)}</span>
        </div>
      </div>
      <div className="flex min-w-0 items-center gap-2">
        <StatusWord node={node} />
        <Elapsed node={node} className="ms-auto shrink-0" />
      </div>
      <EventBubbles
        path={node.id}
        className="h-5"
        fallback={
          <span data-slot="agent-map-action" className={cn("truncate text-xs leading-xs", action ? "text-ink-2" : "text-ink-3")} title={action}>
            {action ?? (node.depth === 0 ? "" : task ? "" : "Waiting for its first step")}
          </span>
        }
      />
      <span data-slot="agent-map-task" className="truncate text-xs leading-xs text-ink-3" title={task}>
        {task ?? (node.depth === 0 ? "The conversation this map belongs to" : "")}
      </span>
      <div className="flex min-w-0 items-center justify-between gap-2">
        <span className="typed min-w-0 truncate text-ink-3" title={model}>
          {model ?? ""}
        </span>
        <ChatButton path={node.id} variant="button" label={node.depth === 0 ? "Back to chat" : "Chat"} />
      </div>
    </>
  );
}

export const AgentNode = memo(AgentNodeImpl);
