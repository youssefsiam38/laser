"use client";
/**
 * Context display — the context ring (docs/ux-elements.md "AUI-connected" →
 * Context display; "Composer" → Context). Installed from
 * `elements-context-display`, the props-driven core, and restyled to DESIGN.md
 * tokens.
 *
 * Why not `context-display.aui`: that file reads AI SDK usage through
 * `@assistant-ui/ai-sdk`, which this app does not use. Pi reports context as
 * `tokens / contextWindow` on the session state, and the props-driven core
 * takes exactly that.
 *
 * Divergences from the registry copy:
 *   - The severity thresholds are DESIGN.md's (`toneForPercent`: calm under
 *     70, `--attention` under 90, `--danger` at 90+), so the ring, the rail
 *     and the status dots speak one vocabulary.
 *   - The per-kind token breakdown (input, cached, output, reasoning) is
 *     gone: Pi hands a host one total, and a breakdown that cannot be filled
 *     is a fake (docs/ux-panels.md R3).
 *   - One `Tooltip`, no nested `TooltipProvider`; the app mounts one.
 *   - `ContextRingButton` binds the ring to the open session and makes it the
 *     compact control when the session is idle, as the composer had.
 */
import { createContext, useContext, useMemo, type ComponentProps, type ReactNode } from "react";

import { toneForPercent, type RingTone } from "@/components/status";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";
import { percent as formatPercent, tokens as formatTokens } from "@/format";
import { cn } from "@/lib/utils";
import { usePiorbitStable, useSessionMeta } from "@/runtime";

type ContextDisplayContextValue = {
  /** Tokens in the window, or null right after compaction (unknown until the next response). */
  tokens: number | null;
  percent: number | null;
  window: number;
};

const ContextDisplayContext = createContext<ContextDisplayContextValue | null>(null);

function useContextDisplay(): ContextDisplayContextValue {
  const ctx = useContext(ContextDisplayContext);
  if (!ctx) throw new Error("ContextDisplay.* must be used within ContextDisplay.Root");
  return ctx;
}

const TONE_STROKE: Record<RingTone, string> = { live: "stroke-live", attention: "stroke-attention", danger: "stroke-danger", ok: "stroke-ok", neutral: "stroke-ink-3" };
const TONE_BAR: Record<RingTone, string> = { live: "bg-live", attention: "bg-attention", danger: "bg-danger", ok: "bg-ok", neutral: "bg-ink-3" };
const TONE_TEXT: Record<RingTone, string> = { live: "text-ink-2", attention: "text-attention", danger: "text-danger", ok: "text-ok", neutral: "text-ink-3" };

export interface ContextDisplayRootProps {
  /** The model's context window, in tokens. */
  window: number;
  /** Tokens used; `null` when unknown (right after compaction). */
  tokens: number | null;
  /** Percent used; `null` when unknown. */
  percent: number | null;
  children: ReactNode;
}

function ContextDisplayRoot({ window, tokens, percent, children }: ContextDisplayRootProps) {
  const value = useMemo(() => ({ tokens, percent, window }), [tokens, percent, window]);
  return (
    <ContextDisplayContext.Provider value={value}>
      <Tooltip>{children}</Tooltip>
    </ContextDisplayContext.Provider>
  );
}

function ContextDisplayTrigger({ className, children, ...props }: ComponentProps<"button">) {
  return (
    <TooltipTrigger asChild>
      <button
        type="button"
        data-slot="context-display-trigger"
        className={cn(
          "inline-flex items-center gap-1.5 rounded-md outline-none transition-colors duration-(--motion-instant)",
          "focus-visible:outline-solid focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-live",
          className,
        )}
        {...props}
      >
        {children}
      </button>
    </TooltipTrigger>
  );
}

function ContextDisplayContent({ side = "top", hint }: { side?: "top" | "bottom" | "left" | "right" | undefined; hint?: string | undefined }) {
  const { tokens, percent, window } = useContextDisplay();
  const tone = toneForPercent(percent ?? 0);
  return (
    <TooltipContent side={side} sideOffset={8} data-slot="context-display-popover" className="block w-56 p-3 text-start">
      <div className="flex items-baseline justify-between gap-6 whitespace-nowrap text-xs">
        <span className={cn("font-medium", percent === null ? "text-bg/80" : undefined)}>
          {percent === null ? "Fresh after compaction" : `${formatPercent(percent)} of context`}
        </span>
        <span className="font-mono tnum">
          {tokens === null ? "—" : formatTokens(tokens)} / {formatTokens(window)}
        </span>
      </div>
      <div className="mt-2.5 h-1 overflow-hidden rounded-full bg-bg/20">
        <div
          className={cn("h-full rounded-full transition-[width] duration-(--motion-slow) motion-reduce:transition-none", TONE_BAR[tone])}
          style={{ width: `${percent ?? 0}%` }}
        />
      </div>
      {hint && <p className="mt-2 text-xs opacity-80">{hint}</p>}
    </TooltipContent>
  );
}

const RING_SIZE = 20;
const RING_STROKE = 2;

/**
 * `size`/`stroke` exist so the telemetry rail can draw the *same* ring large
 * (64px) instead of a second one. Geometry only — colour, thresholds and the
 * transition stay here, so there is exactly one drawing of context usage in
 * the app.
 */
function RingVisual({ className, size = RING_SIZE, stroke = RING_STROKE }: { className?: string | undefined; size?: number | undefined; stroke?: number | undefined }) {
  const { percent } = useContextDisplay();
  const tone = toneForPercent(percent ?? 0);
  const used = Math.max(0, Math.min(100, percent ?? 0));
  const radius = (size - stroke) / 2;
  const circumference = 2 * Math.PI * radius;
  return (
    <svg aria-hidden="true" width={size} height={size} viewBox={`0 0 ${size} ${size}`} className={cn("-rotate-90 shrink-0", className)}>
      <circle cx={size / 2} cy={size / 2} r={radius} fill="none" strokeWidth={stroke} className="stroke-line" />
      <circle
        cx={size / 2}
        cy={size / 2}
        r={radius}
        fill="none"
        strokeWidth={stroke}
        strokeLinecap="round"
        strokeDasharray={circumference}
        strokeDashoffset={circumference - (used / 100) * circumference}
        className={cn("transition-[stroke-dashoffset,stroke] duration-(--motion-slow) motion-reduce:transition-none", TONE_STROKE[tone])}
      />
    </svg>
  );
}

function RingPercentLabel({ className }: { className?: string | undefined }) {
  const { percent } = useContextDisplay();
  const tone = toneForPercent(percent ?? 0);
  return <span className={cn("typed", TONE_TEXT[tone], className)}>{percent === null ? "—" : formatPercent(percent)}</span>;
}

export interface ContextDisplayRingProps extends Omit<ComponentProps<"button">, "children"> {
  window: number;
  tokens: number | null;
  percent: number | null;
  /** Show the percentage beside the ring — or inside it at `size` >= 40. */
  showLabel?: boolean | undefined;
  side?: "top" | "bottom" | "left" | "right" | undefined;
  /** One more line in the tooltip: what a click does. */
  hint?: string | undefined;
  /** Ring diameter in px; the label moves inside the ring from 40 up. */
  size?: number | undefined;
  stroke?: number | undefined;
}

/** The ring preset: ring, optional percent, tooltip with the numbers. */
function ContextDisplayRing({ window, tokens, percent, showLabel = false, side, hint, size = RING_SIZE, stroke = RING_STROKE, className, ...props }: ContextDisplayRingProps) {
  const inside = size >= 40;
  return (
    <ContextDisplayRoot window={window} tokens={tokens} percent={percent}>
      <ContextDisplayTrigger
        aria-label={`Context ${percent === null ? "unknown" : formatPercent(percent)} used`}
        className={cn("p-1", inside && "relative justify-center", className)}
        {...props}
      >
        <RingVisual size={size} stroke={stroke} />
        {showLabel &&
          (inside ? (
            <span aria-hidden="true" className="absolute inset-0 grid place-items-center">
              <RingPercentLabel className="text-sm" />
            </span>
          ) : (
            <RingPercentLabel />
          ))}
      </ContextDisplayTrigger>
      <ContextDisplayContent side={side} hint={hint} />
    </ContextDisplayRoot>
  );
}

const ContextDisplay = {
  Root: ContextDisplayRoot,
  Trigger: ContextDisplayTrigger,
  Content: ContextDisplayContent,
  Ring: ContextDisplayRing,
  RingVisual,
  RingPercentLabel,
};

/**
 * The open session's context ring. Idle: click compacts (`pi/session/compact`);
 * while a turn runs or a compaction is in flight it only informs. Renders
 * nothing before the first response reports usage.
 */
function ContextRingButton({
  className,
  showLabel = false,
  side = "top",
  size,
  stroke,
}: {
  className?: string | undefined;
  showLabel?: boolean | undefined;
  side?: "top" | "bottom" | "left" | "right" | undefined;
  size?: number | undefined;
  stroke?: number | undefined;
}) {
  const { actions } = usePiorbitStable();
  const { contextUsage, running, compacting } = useSessionMeta();
  if (!contextUsage) return null;
  const idle = !running && !compacting && contextUsage.percent !== null;
  return (
    <ContextDisplayRing
      window={contextUsage.contextWindow}
      tokens={contextUsage.tokens}
      percent={contextUsage.percent}
      showLabel={showLabel}
      side={side}
      {...(size !== undefined ? { size } : {})}
      {...(stroke !== undefined ? { stroke } : {})}
      hint={compacting ? "Compacting…" : idle ? "Click to compact the context now." : undefined}
      disabled={!idle}
      onClick={() => void actions.compact()}
      className={cn("disabled:cursor-default", compacting && "motion-safe:animate-attention", className)}
    />
  );
}

export { ContextDisplay, ContextDisplayRoot, ContextDisplayTrigger, ContextDisplayContent, ContextDisplayRing, ContextRingButton };
