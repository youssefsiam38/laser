"use client";
/**
 * The constrained composition (docs/agents.md §5): a box too small for a
 * canvas — a dock island, a phone, a narrow column — gets a vertical lineage
 * list rather than a shrunken graph. Compact cards in the tree's own order,
 * nested lists with a continuous rail so parentage is structural (the same
 * shape the fleet list uses), the same status and chat affordances as the
 * canvas, and the selected card opening its details in place.
 */
import { ChevronDown } from "lucide-react";
import { type ComponentProps } from "react";

import type { AgentTreeNode } from "@/agents";
import { cn } from "@/lib/utils";

import { EventBubbles } from "./EventBubbles.js";
import { InspectorBody } from "./Inspector.js";
import type { VisibleTree } from "./layout.js";
import { emptyCaption } from "./MapCanvas.js";
import { mapUi, useMapRootState } from "./map-state.js";
import { AgentMarkBadge, ChatButton, Elapsed, StatusWord } from "./NodeParts.js";
import { nodeAgentLabel, nodeAriaLabel, nodeName } from "./node-model.js";

export interface LineageListProps extends Omit<ComponentProps<"div">, "children"> {
  rootPath: string;
  visible: VisibleTree;
}

export function LineageList({ rootPath, visible, className, ...props }: LineageListProps) {
  const { selected } = useMapRootState(rootPath);
  const toggle = (path: string) => mapUi.select(rootPath, selected === path ? undefined : path);
  return (
    <div data-slot="agent-map-list" className={cn("@container flex min-h-0 flex-col overflow-y-auto overscroll-contain px-3 py-2", className)} {...props}>
      <ul role="tree" aria-label="Agents, by lineage" className="flex flex-col gap-1.5">
        <LineageBranch node={visible.root} visible={visible} selected={selected} onToggle={toggle} />
      </ul>
      {visible.nodes.length === 1 && (
        <p data-slot="agent-map-empty" className="px-1 py-3 text-sm leading-sm text-ink-3">
          {emptyCaption(visible.hidden)}
        </p>
      )}
    </div>
  );
}

function LineageBranch({ node, visible, selected, onToggle, nested = false }: { node: AgentTreeNode; visible: VisibleTree; selected: string | undefined; onToggle(path: string): void; nested?: boolean }) {
  const children = visible.children.get(node.id) ?? [];
  const open = selected === node.id;
  return (
    <li
      role="treeitem"
      aria-expanded={open}
      aria-selected={open}
      data-slot="agent-map-branch"
      className={cn("relative min-w-0", nested && "before:absolute before:-start-3 before:top-5 before:h-px before:w-3 before:bg-line before:content-['']")}
    >
      <LineageCard node={node} open={open} onToggle={() => onToggle(node.id)} />
      {children.length > 0 && (
        <ul role="group" aria-label={`Agents ${nodeName(node)} started`} className="relative ms-4 mt-1.5 flex flex-col gap-1.5 border-s border-line ps-3">
          {children.map((id) => {
            const child = visible.byPath.get(id);
            return child ? <LineageBranch key={id} node={child} visible={visible} selected={selected} onToggle={onToggle} nested /> : null;
          })}
        </ul>
      )}
    </li>
  );
}

function LineageCard({ node, open, onToggle }: { node: AgentTreeNode; open: boolean; onToggle(): void }) {
  const now = Date.now();
  return (
    <div
      data-slot="agent-map-card"
      data-path={node.id}
      data-status={node.status}
      data-selected={open || undefined}
      className={cn(
        "flex min-w-0 flex-col rounded-xl border border-line bg-surface text-ink transition-[border-color,box-shadow] duration-(--motion-instant) motion-reduce:transition-none",
        open && "border-live shadow-[0_0_0_1px_var(--live)]",
      )}
    >
      <div className="flex min-h-11 min-w-0 items-center gap-1 pe-1.5 ps-1">
        <button
          type="button"
          aria-label={nodeAriaLabel(node, now)}
          aria-expanded={open}
          onClick={onToggle}
          className={cn(
            "flex min-h-11 min-w-0 flex-1 items-center gap-2.5 rounded-lg px-1.5 text-start outline-none",
            "transition-colors duration-(--motion-instant) hover:bg-surface-2 active:bg-[color-mix(in_oklab,var(--surface-2)_80%,var(--ink))]",
            "focus-visible:outline-solid focus-visible:outline-2 focus-visible:-outline-offset-2 focus-visible:outline-live",
          )}
        >
          <AgentMarkBadge node={node} />
          <span className="flex min-w-0 flex-1 flex-col">
            <span className="flex min-w-0 items-baseline gap-2">
              <span className="min-w-0 truncate text-sm leading-sm font-medium text-ink">{nodeName(node)}</span>
              {node.depth > 0 && <span className="hidden truncate text-xs leading-xs text-ink-3 @[360px]:inline">{nodeAgentLabel(node)}</span>}
            </span>
            <span className="flex min-w-0 items-center gap-2">
              <EventBubbles path={node.id} className="min-w-0 flex-1" fallback={<StatusWord node={node} />} />
              <Elapsed node={node} className="shrink-0" />
            </span>
          </span>
          <ChevronDown aria-hidden="true" className={cn("size-4 shrink-0 text-ink-3 transition-transform duration-(--motion-fast) motion-reduce:transition-none", open && "rotate-180")} />
        </button>
        <ChatButton path={node.id} />
      </div>
      {open && <InspectorBody node={node} header={false} className="px-3 pt-3 pb-3 hairline-t" />}
    </div>
  );
}
