"use client";
/**
 * Agent status — "one pill that always answers: what is it doing, and for how
 * long" (docs/ux-elements.md "Agents"). Installed from `elements-agent-status`
 * and rebuilt as the island header's leading control, for every kind and every
 * size: the pill a minimal island *is*, and the dot-title-values row the
 * compact and expanded headers carry. One element, so the dot's sweep and the
 * title node survive a size change (docs/ux-panels.md "one element per panel").
 *
 * Divergences from the registry copy:
 *   - `state` is the five-word status vocabulary (R1), drawn by `StatusDot`,
 *     not a three-state blue/grey/green dot.
 *   - `elapsed` became `values`: the size budget's live readings (minimal one,
 *     compact three), already sliced by the caller (R13).
 *   - The decorative pause/restart glyph is gone. A control appears only when
 *     it works here (R2), and the header draws declared actions itself.
 *   - Renders a `<button>`: the pill is the way into the island.
 */
import { ExternalLink } from "lucide-react";
import type { ComponentProps } from "react";

import { StatusDot, type Status } from "@/components/status";
import { Badge } from "@/components/ui/badge";
import { cn } from "@/lib/utils";
import type { LiveValue } from "@/panels/values";

import { NumberTicker } from "./number-ticker.js";
import { mono } from "./surfaces.js";

/** The pressed state `Button` uses, so a pill and a button feel the same under a finger. */
const pressed = "active:bg-[color-mix(in_oklab,var(--surface-2)_80%,var(--ink))]";

export type AgentStatusSize = "minimal" | "compact" | "expanded";

const VALUE_TONE: Record<NonNullable<LiveValue["tone"]>, string> = {
  attention: "text-attention",
  danger: "text-danger",
  muted: "text-ink-3",
};

export function AgentStatusValue({ value, className }: { value: LiveValue; className?: string | undefined }) {
  const shell = cn(mono, "shrink-0 text-ink-2 tnum", value.tone && VALUE_TONE[value.tone], className);
  // A ticking value is the one number on an island that changes while you
  // watch it (elapsed time, a growing token count). Rolling its digits is
  // what makes a minimal island read as alive rather than stale; a value that
  // only ever changes when new data lands just swaps, because a roll there
  // would be motion with nothing behind it. `NumberTicker` holds still under
  // reduced motion, so this is one component in both modes.
  if (value.ticking) return <NumberTicker value={value.text} label={value.label} className={shell} data-slot="agent-status-value" />;
  return (
    <span
      data-slot="agent-status-value"
      className={shell}
      title={`${value.label}: ${value.text}`}
      aria-label={`${value.label} ${value.text}`}
    >
      {value.text}
    </span>
  );
}

export function AgentStatus({
  state,
  label,
  values,
  size,
  source,
  poppedOut = false,
  dimmed = false,
  className,
  ...props
}: Omit<ComponentProps<"button">, "children"> & {
  state: Status;
  label: string;
  /** Live readings within this size's budget; the element shows what it is given. */
  values: readonly LiveValue[];
  size: AgentStatusSize;
  /** Shown as a badge when expanded and there is room. */
  source?: string | undefined;
  /** Minimal only: the panel lives in another tab; the pill points there. */
  poppedOut?: boolean;
  dimmed?: boolean;
}) {
  const expanded = size === "expanded";
  return (
    <button
      type="button"
      data-slot="agent-status"
      data-state={state}
      className={cn(
        "relative flex h-full min-w-0 flex-1 items-center gap-2 text-start outline-none",
        "focus-visible:outline-solid focus-visible:outline-2 focus-visible:-outline-offset-2 focus-visible:outline-live",
        "transition-colors duration-(--motion-instant)",
        size === "minimal" && cn("rounded-full px-2.5 hover:bg-surface-2", pressed),
        size === "compact" && cn("rounded-md", pressed),
        // Expanded, the title is not a control: the header behind it is what
        // double-click-to-maximize lands on.
        expanded && "pointer-events-none cursor-default",
        dimmed && "opacity-70",
        // 44px of hit area on a coarse pointer, without the pill growing (R13).
        "[@media(pointer:coarse)]:after:absolute [@media(pointer:coarse)]:after:-inset-y-2 [@media(pointer:coarse)]:after:inset-x-0 [@media(pointer:coarse)]:after:content-['']",
        className,
      )}
      {...props}
    >
      <StatusDot status={state} size={expanded ? "md" : "sm"} />
      {expanded && source && (
        <Badge variant="mono" className="hidden shrink-0 @[360px]:inline-flex" title={`From ${source}`}>
          {source}
        </Badge>
      )}
      <span
        className={cn(
          "min-w-0 truncate text-ink",
          size === "minimal" && "flex-1 text-xs leading-xs font-medium",
          size === "compact" && "text-sm leading-sm font-medium",
          expanded && "flex-1 text-sm leading-sm font-semibold",
        )}
      >
        {label}
      </span>
      {size === "minimal" && poppedOut ? (
        <ExternalLink className="size-3 shrink-0 text-ink-3" aria-label="Open in another tab" />
      ) : (
        <span className="flex min-w-0 shrink items-center gap-2 overflow-hidden">
          {values.map((v, i) => (
            <AgentStatusValue key={`${v.label}-${i}`} value={v} className={cn(v.ticking && "min-w-[3.5ch] text-end", size === "compact" && "truncate")} />
          ))}
        </span>
      )}
    </button>
  );
}
