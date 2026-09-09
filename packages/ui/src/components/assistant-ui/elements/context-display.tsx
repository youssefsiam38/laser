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
 *     is a fake (docs/ux-fleet.md R5, provenance honesty).
 *   - One `Tooltip`, no nested `TooltipProvider`; the app mounts one.
 *   - `ContextRingButton` binds the ring to the open session and makes it the
 *     compact control when the session is idle, as the composer had.
 */
import { createContext, useContext, useMemo, useState, type ComponentProps, type ReactNode } from "react";
import { BatteryMedium, BrainCircuit, Cpu, Database, Gauge, Sparkles, TriangleAlert, type LucideIcon } from "lucide-react";

import { toneForPercent, type RingTone } from "@/components/status";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";
import { Button } from "@/components/ui/button";
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { percent as formatPercent, tokens as formatTokens } from "@/format";
import { cn } from "@/lib/utils";
import { useLaserStable, useSessionMeta } from "@/runtime";

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
 * The open session's context ring. Clicking opens the same detailed inspector
 * from the top bar and composer; compaction is an explicit action inside it.
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
  const { actions } = useLaserStable();
  const { contextUsage, running, compacting, model } = useSessionMeta();
  const [open, setOpen] = useState(false);
  if (!contextUsage) return null;
  const idle = !running && !compacting && contextUsage.percent !== null;
  const remaining = contextUsage.tokens === null ? null : Math.max(0, contextUsage.contextWindow - contextUsage.tokens);
  return (
    <>
      <ContextDisplayRing
        window={contextUsage.contextWindow}
        tokens={contextUsage.tokens}
        percent={contextUsage.percent}
        showLabel={showLabel}
        side={side}
        {...(size !== undefined ? { size } : {})}
        {...(stroke !== undefined ? { stroke } : {})}
        hint="Open context details"
        onClick={() => setOpen(true)}
        className={cn("cursor-pointer", compacting && "motion-safe:animate-attention", className)}
      />
      <Dialog open={open} onOpenChange={setOpen}>
        <DialogContent className="sm:max-w-xl">
          <DialogHeader className="gap-3">
            <div className="flex items-center gap-3">
              <span className="grid size-10 shrink-0 place-items-center rounded-xl bg-live/10 text-live">
                <BrainCircuit aria-hidden="true" className="size-5" />
              </span>
              <div className="min-w-0">
                <DialogTitle>Context window</DialogTitle>
                <DialogDescription className="mt-1">The working memory available to this session’s current model.</DialogDescription>
              </div>
            </div>
          </DialogHeader>
          <div className="overflow-hidden rounded-xl border border-line bg-surface">
            <div className="flex items-center justify-between gap-4 p-4">
              <div className="min-w-0">
                <p className="eyebrow">Window health</p>
                <p className="mt-1 text-lg font-semibold text-ink">
                  {contextUsage.percent === null ? "Measuring usage" : `${formatPercent(contextUsage.percent)} filled`}
                </p>
                <p className="mt-1 text-sm text-ink-2">
                  {contextUsage.tokens === null
                    ? `Capacity ${formatTokens(contextUsage.contextWindow)}`
                    : `${formatTokens(contextUsage.tokens)} of ${formatTokens(contextUsage.contextWindow)} tokens in use`}
                </p>
              </div>
              <span className={cn("grid size-10 shrink-0 place-items-center rounded-xl bg-surface-2", TONE_TEXT[toneForPercent(contextUsage.percent ?? 0)])}>
                <Gauge aria-hidden="true" className="size-5" />
              </span>
            </div>
            <div className="h-2 overflow-hidden bg-line">
              <div className={cn("h-full transition-[width] duration-(--motion-slow) motion-reduce:transition-none", TONE_BAR[toneForPercent(contextUsage.percent ?? 0)])} style={{ width: `${contextUsage.percent ?? 0}%` }} />
            </div>
          </div>
          <div className="grid grid-cols-2 gap-2">
            <ContextStat icon={BrainCircuit} label="Used" value={contextUsage.tokens === null ? "Unknown" : formatTokens(contextUsage.tokens)} detail="Conversation and tool output" />
            <ContextStat icon={BatteryMedium} label="Remaining" value={remaining === null ? "Unknown" : formatTokens(remaining)} detail="Room before the limit" />
            <ContextStat icon={Database} label="Capacity" value={formatTokens(contextUsage.contextWindow)} detail="Model context window" />
            <ContextStat icon={Gauge} label="Filled" value={contextUsage.percent === null ? "Unknown" : formatPercent(contextUsage.percent)} detail="Current window pressure" />
          </div>
          <ContextGuidance percent={contextUsage.percent} />
          {model && (
            <div className="flex items-center gap-3 rounded-xl border border-line bg-surface px-3 py-2.5">
              <span className="grid size-8 shrink-0 place-items-center rounded-lg bg-surface-2 text-ink-2">
                <Cpu aria-hidden="true" className="size-4" />
              </span>
              <div className="min-w-0">
                <p className="eyebrow">Current model</p>
                <p className="mt-0.5 truncate typed text-ink">{model.provider}/{model.id}</p>
              </div>
            </div>
          )}
          <DialogFooter>
            <Button variant="ghost" onClick={() => setOpen(false)}>Close</Button>
            <Button disabled={!idle} onClick={() => { void actions.compact(); setOpen(false); }}>
              {compacting ? "Compacting…" : running ? "Available after this turn" : "Compact context"}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </>
  );
}

function ContextStat({ icon: Icon, label, value, detail }: { icon: LucideIcon; label: string; value: string; detail: string }) {
  return (
    <div className="rounded-xl border border-line bg-surface p-3">
      <div className="flex items-start gap-2.5">
        <span className="grid size-8 shrink-0 place-items-center rounded-lg bg-surface-2 text-live">
          <Icon aria-hidden="true" className="size-4" />
        </span>
        <div className="min-w-0">
          <p className="eyebrow">{label}</p>
          <p className="mt-1 typed text-ink">{value}</p>
        </div>
      </div>
      <p className="mt-2 text-xs leading-4 text-ink-3">{detail}</p>
    </div>
  );
}

function ContextGuidance({ percent }: { percent: number | null }) {
  const critical = percent !== null && percent >= 90;
  const warm = percent !== null && percent >= 70;
  const Icon = critical || warm ? TriangleAlert : Sparkles;
  const title = percent === null ? "Usage is being measured" : critical ? "Compaction recommended" : warm ? "Plan to compact soon" : "Plenty of working room";
  const description = percent === null
    ? "The next model response will report how much context is in use."
    : critical
      ? "Compact before useful earlier detail is pushed out of the model’s window."
      : warm
        ? "Compaction will summarize earlier work and recover room when you need it."
        : "The session has comfortable room for more conversation and tool output.";
  return (
    <div className={cn("flex items-start gap-3 rounded-xl border p-3", critical ? "border-danger/40 bg-danger/5" : warm ? "border-attention/40 bg-attention/5" : "border-line bg-surface-2")}>
      <span className={cn("grid size-8 shrink-0 place-items-center rounded-lg bg-surface", critical ? "text-danger" : warm ? "text-attention" : "text-live")}>
        <Icon aria-hidden="true" className="size-4" />
      </span>
      <div className="min-w-0">
        <p className="text-sm font-medium text-ink">{title}</p>
        <p className="mt-1 text-sm leading-5 text-ink-2">{description}</p>
      </div>
    </div>
  );
}

export { ContextDisplay, ContextDisplayRoot, ContextDisplayTrigger, ContextDisplayContent, ContextDisplayRing, ContextRingButton };
