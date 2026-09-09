"use client";
/**
 * The small parts every node drawing shares — the canvas node at each size,
 * the lineage list row and the inspector — so an agent looks the same wherever
 * the map draws it: one mark, one dot, one elapsed clock, one chat control.
 */
import { MessageSquare, MessagesSquare } from "lucide-react";
import type { ComponentProps, CSSProperties, MouseEvent } from "react";

import type { AgentStatusTone, AgentTreeNode } from "@/agents";
import { NumberTicker } from "@/components/assistant-ui/elements/number-ticker";
import { StatusDot } from "@/components/status";
import { Button } from "@/components/ui/button";
import { TooltipIconButton } from "@/components/ui/tooltip-icon-button";
import { useTick } from "@/components/thread/timing";
import { cn } from "@/lib/utils";
import { formatElapsed } from "@/format";

import { useMapHost } from "./map-context.js";
import { agentMark, nodeElapsed, nodeIsActive, nodeStatusLabel, toneStatus } from "./node-model.js";

/** The agent's mark: two letters of its name in a rounded square; the root carries the conversation glyph. */
export function AgentMarkBadge({ node, size = "sm", className }: { node: AgentTreeNode; size?: "sm" | "md" | "lg"; className?: string | undefined }) {
  const root = node.depth === 0;
  return (
    <span
      aria-hidden="true"
      data-slot="agent-mark"
      className={cn(
        "inline-flex shrink-0 items-center justify-center rounded-md bg-surface-2 font-mono font-medium tracking-typed text-ink-2 select-none",
        size === "sm" && "size-6 text-xs",
        size === "md" && "size-7 text-xs",
        size === "lg" && "size-9 text-sm",
        root && "bg-[color-mix(in_oklab,var(--live)_12%,transparent)] text-live",
        className,
      )}
    >
      {root ? <MessagesSquare className={cn(size === "lg" ? "size-4.5" : "size-3.5")} /> : agentMark(node.agentName)}
    </span>
  );
}

/**
 * The status dot in the five-word vocabulary. A finished run is muted like an
 * ended one (D-154): green is reserved for work that is happening now, so the
 * dot no longer paints success, and the node's own word says which it was.
 */
export function ToneDot({ tone, label, size = "sm", className }: { tone: AgentStatusTone; label: string; size?: "sm" | "md"; className?: string | undefined }) {
  return (
    <StatusDot
      status={toneStatus(tone)}
      size={size}
      label={label}
      data-tone={tone}
      className={className}
    />
  );
}

/** Status word beside its dot. */
export function StatusWord({ node, className }: { node: AgentTreeNode; className?: string | undefined }) {
  const label = nodeStatusLabel(node.status);
  return (
    <span data-slot="agent-map-status" data-status={node.status} className={cn("inline-flex min-w-0 items-center gap-1.5", className)}>
      <ToneDot tone={node.tone} label={label} />
      <span className="truncate text-xs leading-xs text-ink-2">{label}</span>
    </span>
  );
}

/**
 * Elapsed time for the node's newest run: rolls every second while it runs,
 * stands still once it ended. Nothing at all for a session with no run.
 */
export function Elapsed({ node, className }: { node: AgentTreeNode; className?: string | undefined }) {
  const active = nodeIsActive(node) && node.run !== undefined;
  useTick(active, 1000);
  const ms = nodeElapsed(node, Date.now());
  if (ms === undefined) return null;
  return <NumberTicker value={formatElapsed(ms)} label="Elapsed" data-slot="agent-map-elapsed" className={cn("typed text-ink-3", className)} />;
}

/**
 * The way into the session: an icon at concise sizes, a labelled button where
 * there is room. Inside a canvas node it must not start a pan or a drag.
 */
export function ChatButton({
  path,
  variant = "icon",
  label,
  className,
  ...props
}: Omit<ComponentProps<"button">, "children" | "ref"> & { path: string; variant?: "icon" | "button"; label?: string | undefined }) {
  const host = useMapHost();
  const text = label ?? "Chat";
  const onClick = (e: MouseEvent<HTMLButtonElement>) => {
    e.stopPropagation();
    host.openChat(path);
  };
  if (variant === "icon") {
    return (
      <TooltipIconButton
        tooltip={text}
        size="icon-xs"
        data-slot="agent-map-chat"
        onClick={onClick}
        className={cn(
          "nodrag nopan relative shrink-0 text-ink-3",
          "[@media(pointer:coarse)]:after:absolute [@media(pointer:coarse)]:after:-inset-2.5 [@media(pointer:coarse)]:after:content-['']",
          className,
        )}
        {...props}
      >
        <MessageSquare />
      </TooltipIconButton>
    );
  }
  return (
    <Button size="xs" variant="outline" data-slot="agent-map-chat" onClick={onClick} className={cn("nodrag nopan shrink-0", className)} {...props}>
      <MessageSquare />
      {text}
    </Button>
  );
}
