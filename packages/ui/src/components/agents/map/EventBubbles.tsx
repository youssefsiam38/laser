"use client";
/**
 * The gentle info bubble inside a node (docs/agents.md §5): the newest
 * transient inter-agent moment of that session — started, a message sent or
 * received, completed — for {@link EVENT_TTL_MS}, then gone. The store keeps
 * the event alive for exactly that long (`useAgentEvents`); this component
 * only draws the arrival and, one `--motion-slow` before the end, the leave,
 * so the fade finishes as the store lets go. Under reduced motion both are
 * instant and nothing moves.
 */
import type { AgentEvent } from "@lasercode/protocol";
import { useEffect, useState, type ComponentProps, type CSSProperties, type ReactNode } from "react";

import { useAgentEvents } from "@/agents";
import { cn } from "@/lib/utils";
import { motionMs } from "@/motion";

import { eventLook, TONE_VAR } from "./node-model.js";

/** How long a bubble shows. Data, not motion: the same number in every host. */
export const EVENT_TTL_MS = 6000;

const eventAge = (event: AgentEvent): number => {
  const at = Date.parse(event.at);
  return Number.isNaN(at) ? 0 : Math.max(0, Date.now() - at);
};

export function EventBubble({ event, className, ...props }: Omit<ComponentProps<"span">, "children"> & { event: AgentEvent }) {
  const [leaving, setLeaving] = useState(false);
  useEffect(() => {
    const remaining = EVENT_TTL_MS - eventAge(event) - motionMs("--motion-slow");
    if (remaining <= 0) {
      setLeaving(true);
      return;
    }
    const timer = setTimeout(() => setLeaving(true), remaining);
    return () => clearTimeout(timer);
  }, [event]);
  const { icon: Icon, tone } = eventLook(event.kind);
  return (
    <span
      data-slot="agent-map-bubble"
      data-kind={event.kind}
      data-leaving={leaving || undefined}
      title={event.counterpart ? `${event.summary} · ${event.counterpart.label}` : event.summary}
      className={cn(
        "agent-map-bubble inline-flex h-5 min-w-0 max-w-full items-center gap-1 rounded-full px-1.5 text-xs leading-xs font-medium",
        "bg-[color-mix(in_oklab,var(--bubble)_12%,transparent)] text-(--bubble)",
        className,
      )}
      style={{ "--bubble": TONE_VAR[tone] } as CSSProperties}
      {...props}
    >
      <Icon aria-hidden="true" className="size-3 shrink-0" />
      <span className="min-w-0 truncate">{event.summary}</span>
    </span>
  );
}

/**
 * The bubble slot of one node: shows the newest live event, or `fallback`
 * (the current action line, the status word) when there is none. One slot,
 * so a node never grows when an event lands.
 */
export function EventBubbles({ path, fallback, className }: { path: string; fallback?: ReactNode; className?: string | undefined }) {
  const events = useAgentEvents(path, EVENT_TTL_MS);
  const latest = events.at(-1);
  return (
    <span data-slot="agent-map-bubbles" role="status" className={cn("flex min-w-0 items-center", className)}>
      {latest ? <EventBubble key={latest.id} event={latest} /> : fallback}
    </span>
  );
}
