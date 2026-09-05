"use client";
/**
 * Flow graph — "work as a graph rather than a list" (docs/ux-elements.md
 * "Structured output": a workflow's DECLARED graph only). Installed from
 * `elements-flow-graph`; `AgentPlan` draws it when a plan is maximized and
 * its steps carry declared `dependsOn` edges. An inferred plan never reaches
 * this file — R3: never present a guess as a graph.
 *
 * Divergences from the registry copy:
 *   - `visibleCount` is gone (the demo's reveal); every node is drawn.
 *   - Node state is the plan step vocabulary, drawn with the status tokens.
 *   - Nodes are wide enough for a step name at 12px and truncate with the full
 *     name in the tooltip (R13); the registry's 78px nodes held five letters.
 *   - `layoutFlow` is exported: columns are the longest dependency path, rows
 *     the order within a column, so the caller passes steps, not coordinates.
 *   - A node linked to a run is a button that opens it.
 */
import type { PlanStep, PlanStepState } from "@lasercode/protocol";
import type { ComponentProps } from "react";

import { cn } from "@/lib/utils";

import { mono } from "./surfaces.js";

export interface FlowNode {
  id: string;
  label: string;
  column: number;
  row: number;
  state: PlanStepState;
  onOpen?: (() => void) | undefined;
}

export interface FlowEdge {
  from: string;
  to: string;
}

/* Layout geometry in px. Like the dock's `layout.ts`, these are positions the
 * graph is drawn at, not type or colour; the text inside follows the type scale. */
const NODE_W = 168;
const NODE_H = 36;
const COL_GAP = 40;
const ROW_GAP = 12;
const COL_W = NODE_W + COL_GAP;
const ROW_H = NODE_H + ROW_GAP;

/**
 * Columns by the longest declared path to a step, rows by order within the
 * column. An edge to a step that does not exist is dropped rather than drawn
 * to nowhere; a cycle is broken at the step that closes it.
 */
export function layoutFlow(steps: readonly PlanStep[], onOpen?: (runId: string) => void): { nodes: FlowNode[]; edges: FlowEdge[] } {
  const byId = new Map(steps.map((s) => [s.id, s]));
  const depth = new Map<string, number>();
  const visiting = new Set<string>();
  const depthOf = (id: string): number => {
    const known = depth.get(id);
    if (known !== undefined) return known;
    if (visiting.has(id)) return 0;
    visiting.add(id);
    const step = byId.get(id);
    const parents = (step?.dependsOn ?? []).filter((d) => byId.has(d));
    const d = parents.length === 0 ? 0 : 1 + Math.max(...parents.map(depthOf));
    visiting.delete(id);
    depth.set(id, d);
    return d;
  };
  const rows = new Map<number, number>();
  const nodes: FlowNode[] = steps.map((step) => {
    const column = depthOf(step.id);
    const row = rows.get(column) ?? 0;
    rows.set(column, row + 1);
    return {
      id: step.id,
      label: step.label,
      column,
      row,
      state: step.state,
      onOpen: step.runId && onOpen ? () => onOpen(step.runId!) : undefined,
    };
  });
  const edges: FlowEdge[] = [];
  for (const step of steps) for (const from of step.dependsOn ?? []) if (byId.has(from)) edges.push({ from, to: step.id });
  return { nodes, edges };
}

const NODE_STYLE: Record<PlanStepState, string> = {
  pending: "border-dashed border-line text-ink-2",
  running: "border-live/50 bg-[color-mix(in_oklab,var(--live)_10%,transparent)] text-ink",
  done: "border-line bg-surface-2 text-ink-2",
  failed: "border-danger/50 bg-[color-mix(in_oklab,var(--danger)_8%,transparent)] text-danger",
  skipped: "border-dashed border-line text-ink-3 line-through",
  blocked: "border-attention/50 bg-[color-mix(in_oklab,var(--attention)_10%,transparent)] text-ink",
};

export function FlowGraph({ nodes, edges, className, ...props }: Omit<ComponentProps<"div">, "children"> & { nodes: readonly FlowNode[]; edges: readonly FlowEdge[] }) {
  if (nodes.length === 0) return null;
  const columns = Math.max(...nodes.map((n) => n.column)) + 1;
  const rows = Math.max(...nodes.map((n) => n.row)) + 1;
  const width = (columns - 1) * COL_W + NODE_W;
  const height = (rows - 1) * ROW_H + NODE_H;
  const byId = new Map(nodes.map((n) => [n.id, n]));
  const center = (node: FlowNode) => ({ x: node.column * COL_W + NODE_W / 2, y: node.row * ROW_H + NODE_H / 2 });

  return (
    <div data-slot="flow-graph" className={cn("overflow-x-auto pb-2", className)} role="img" aria-label={`Declared graph: ${nodes.length} steps, ${edges.length} edges`} {...props}>
      <div className="relative" style={{ width, height, minWidth: width }}>
        <svg aria-hidden="true" className="absolute inset-0 overflow-visible" width={width} height={height}>
          {edges.map((edge) => {
            const from = byId.get(edge.from);
            const to = byId.get(edge.to);
            if (!from || !to) return null;
            const a = center(from);
            const b = center(to);
            const midX = (a.x + b.x) / 2;
            const active = to.state === "running" || to.state === "blocked";
            return (
              <path
                key={`${edge.from}-${edge.to}`}
                d={`M ${a.x + NODE_W / 2} ${a.y} C ${midX} ${a.y}, ${midX} ${b.y}, ${b.x - NODE_W / 2} ${b.y}`}
                fill="none"
                strokeWidth="1.5"
                className={cn("transition-colors duration-(--motion-slow) motion-reduce:transition-none", active ? "stroke-live" : "stroke-line")}
              />
            );
          })}
        </svg>

        {nodes.map((node) => {
          const Node = node.onOpen ? "button" : "div";
          return (
            <Node
              key={node.id}
              {...(node.onOpen ? { type: "button" as const, onClick: node.onOpen } : {})}
              title={`${node.label} · ${node.state}`}
              data-state={node.state}
              className={cn(
                "absolute flex items-center rounded-lg border px-2.5 text-start",
                NODE_STYLE[node.state],
                node.onOpen && "outline-none transition-colors duration-(--motion-instant) hover:border-live focus-visible:outline-solid focus-visible:outline-2 focus-visible:outline-live",
              )}
              style={{ left: node.column * COL_W, top: node.row * ROW_H, width: NODE_W, height: NODE_H }}
            >
              <span className={cn(mono, "min-w-0 truncate")}>{node.label}</span>
            </Node>
          );
        })}
      </div>
    </div>
  );
}
